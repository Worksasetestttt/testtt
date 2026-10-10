// Pages et ressources statiques : landing (/), application (/app, routage côté client) et /assets.
// · Fichiers texte (html, css, js, svg, json…) gardés en mémoire avec leurs variantes brotli et gzip, précompressées
//   une fois au niveau maximal, et rechargés dès que le fichier change (date de modification, taille, inode) :
//   le développement reste juste sans redémarrage.
// · Pages HTML réécrites à la volée : chaque référence locale (/assets/…, /app/app.css, /app/app.js, ou relative)
//   reçoit ?v=<empreinte courte du contenu>. Le contenu des scripts en ligne n'est jamais touché : leur empreinte
//   SHA-256 figure dans la CSP (index.js).
// · Cache : une ressource demandée avec l'empreinte courante est « immutable » pour un an ; sans empreinte, avec une
//   empreinte périmée, et pour tout HTML : no-cache, ETag fort et réponses 304.
// Les autres fichiers (images…) et les fichiers de plus de 2 Mo sont laissés à express.static (next()).
import fs from 'node:fs';
import path from 'node:path';
import { COMPRESS_MIN, negotiate, encode, contentHash, etagVariant, etagMatches } from './compress.js';

export const PUBLIC_DIRS = ['assets', 'app'];   // dossiers servis tels quels (aucune sauvegarde ne doit s'y trouver)
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
};
const MAX_FILE = 2 * 1024 * 1024;
const V_LEN = 12;                                        // longueur de l'empreinte ?v=
const IMMUTABLE = 'public, max-age=31536000, immutable';
const SPA_PAGE = 'app/index.html';
const TAG = /<script\b[^>]*>[\s\S]*?<\/script\s*>|<(?:link|img|source)\b[^>]*>/gi;
const ATTR = /(\s(?:src|href)\s*=\s*)(["'])([^"']*)\2/gi;

const typeOf = (rel) => TYPES[path.extname(rel).toLowerCase()];
const pageBase = (rel) => { const d = path.posix.dirname(rel.split(path.sep).join('/')); return d === '.' ? '/' : `/${d}/`; };
// Segments d'URL décodés et sûrs (ni fichier caché, ni « .. », ni séparateur encodé) ; null sinon.
function segments(p) {
  let parts;
  try { parts = p.split('/').map(decodeURIComponent); } catch { return null; }
  return parts.some((s) => s.startsWith('.') || /[\\/\0]/.test(s)) ? null : parts;
}
// Référence locale d'une page (src/href) → chemin relatif à la racine d'un fichier versionnable, sinon null.
function localRef(url, base) {
  if (!url || /[?#]/.test(url) || url.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  let p;
  try { p = new URL(url, `http://localhost${base}`).pathname; } catch { return null; }
  const m = /^\/(assets|app)\/(.+)$/.exec(p);
  const parts = m && segments(m[2]);
  if (!parts || parts.some((s) => !s)) return null;
  const rel = path.join(m[1], ...parts);
  return typeOf(rel) && path.extname(rel).toLowerCase() !== '.html' ? rel : null;
}
// Applique `fn(rel)` à chaque référence locale des balises link, script (externes), img et source.
function mapRefs(html, base, fn) {
  const attr = (all, pre, quote, url) => { const rel = localRef(url, base); const out = rel ? fn(rel, url) : null; return out ? `${pre}${quote}${out}${quote}` : all; };
  return html.replace(TAG, (tag) => {
    if (!/^<script/i.test(tag)) return tag.replace(ATTR, attr);
    const open = tag.slice(0, tag.indexOf('>') + 1);
    return /\ssrc\s*=/i.test(open) ? open.replace(ATTR, attr) + tag.slice(open.length) : tag;   // script en ligne : intact
  });
}

export function createStatic(root) {
  const files = new Map();   // chemin relatif → { mtimeMs, size, ino, ready: Promise<entrée> }
  const pages = new Map();   // page HTML → { key, ready: Promise<entrée réécrite> }
  const stat = (rel) => fs.promises.stat(path.join(root, rel)).then((s) => (s.isFile() ? s : null), () => null);

  async function build(body, type, compress = true) {
    const hash = contentHash(body);
    const e = { body, type, hash, v: hash.slice(0, V_LEN), etag: `"${hash}"`, br: null, gzip: null };
    if (compress && body.length >= COMPRESS_MIN) {
      const [br, gz] = await Promise.all([encode('br', body, true), encode('gzip', body, true)]);
      if (br.length < body.length) e.br = br;
      if (gz.length < body.length) e.gzip = gz;
    }
    return e;
  }
  // Entrée en mémoire d'un fichier texte, rechargée si le fichier a changé depuis la dernière lecture.
  function file(rel, st, compress = true) {
    const cur = files.get(rel);
    if (cur && cur.mtimeMs === st.mtimeMs && cur.size === st.size && cur.ino === st.ino) return cur.ready;
    const ready = fs.promises.readFile(path.join(root, rel)).then((body) => build(body, typeOf(rel), compress));
    const entry = { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, ready };
    files.set(rel, entry);
    ready.catch(() => { if (files.get(rel) === entry) files.delete(rel); });
    return ready;
  }
  // Page HTML réécrite : reconstruite quand la page ou l'une des ressources qu'elle référence change.
  async function page(rel, st) {
    const src = await file(rel, st, false);
    const base = pageBase(rel);
    if (!src.refs) { const refs = new Set(); mapRefs(src.body.toString('utf8'), base, (r) => { refs.add(r); return null; }); src.refs = [...refs]; }
    const versions = new Map();
    await Promise.all(src.refs.map(async (r) => { const s = await stat(r); if (s && s.size <= MAX_FILE) versions.set(r, (await file(r, s)).v); }));
    const key = [src.hash, ...[...versions].map(([r, v]) => `${r}=${v}`)].join('|');
    let p = pages.get(rel);
    if (!p || p.key !== key) {
      const html = mapRefs(src.body.toString('utf8'), base, (r, url) => (versions.has(r) ? `${url}?v=${versions.get(r)}` : null));
      p = { key, ready: build(Buffer.from(html, 'utf8'), TYPES['.html']) };
      pages.set(rel, p);
      p.ready.catch(() => { if (pages.get(rel) === p) pages.delete(rel); });
    }
    return p.ready;
  }

  function send(req, res, e, immutable) {
    const available = [e.br && 'br', e.gzip && 'gzip'].filter(Boolean);
    const enc = available.length ? negotiate(req.headers['accept-encoding'], available) : null;
    if (available.length) res.vary('Accept-Encoding');
    res.setHeader('Cache-Control', immutable ? IMMUTABLE : 'no-cache');
    res.setHeader('ETag', etagVariant(e.etag, enc));
    if (etagMatches(req.headers['if-none-match'], e.etag)) { res.statusCode = 304; return res.end(); }
    const body = enc === 'br' ? e.br : enc === 'gzip' ? e.gzip : e.body;
    res.setHeader('Content-Type', e.type);
    if (enc) res.setHeader('Content-Encoding', enc);
    res.setHeader('Content-Length', body.length);
    res.statusCode = 200;
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  // Cible d'une URL : fichier relatif à la racine, et repli sur la page de l'application pour /app/….
  function target(urlPath) {
    if (urlPath === '/') return { rel: 'index.html' };
    if (urlPath === '/app') return { rel: SPA_PAGE };
    const m = /^\/(assets|app)\/(.*)$/.exec(urlPath);
    const parts = m && segments(m[2]);
    if (!parts) return null;
    const names = parts.filter(Boolean);
    if (parts[parts.length - 1] === '') names.push('index.html');   // dossier : sa page d'index
    return { rel: path.join(m[1], ...names), spa: m[1] === 'app' };
  }
  async function handle({ rel, spa }, req, res) {
    let st = await stat(rel);
    if (!st) {
      if (!spa) return false;
      rel = SPA_PAGE; st = await stat(rel);   // route de l'application (#dashboard…) : sa page
      if (!st) return false;
    }
    if (!typeOf(rel) || st.size > MAX_FILE) return false;
    if (path.extname(rel).toLowerCase() === '.html') { send(req, res, await page(rel, st), false); return true; }
    const e = await file(rel, st);
    send(req, res, e, req.query.v === e.v);
    return true;
  }

  const middleware = (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const t = target(req.path);
    if (!t) return next();
    handle(t, req, res).then((done) => { if (!done) next(); }, next);
  };
  // Préchargement au démarrage (pool de threads) : la première visite ne paie pas la compression.
  middleware.warm = () => Promise.all(['index.html', SPA_PAGE, 'app/admin.js', 'app/admin.css'].map(async (rel) => {
    const st = await stat(rel);
    if (st) await (rel.endsWith('.html') ? page(rel, st) : file(rel, st));
  })).catch((e) => console.error('[static] préchargement :', e.message));
  return middleware;
}
