// Compression HTTP (brotli ou gzip selon Accept-Encoding, node:zlib) et validateurs (ETag fort, 304).
// API : compression à la volée des réponses texte et JSON de 1 Ko à 2 Mo ; jamais pour les téléchargements
// (Content-Disposition), les réponses sans corps (HEAD, 204, 304), ni les routes à jeton (filtre `skip`).
// Fichiers statiques : variantes précompressées en mémoire (static.js), même négociation, mêmes ETag.
// ETag : empreinte SHA-256 du contenu non compressé, en hexadécimal. Une variante compressée porte un suffixe
// (« -br », « -gz ») pour qu'un validateur fort désigne une seule suite d'octets (RFC 9110) ; la comparaison
// d'If-None-Match (comparaison faible, comme l'exige la RFC) ignore ces suffixes.
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const Z = zlib.constants;
export const COMPRESS_MIN = 1024;               // en dessous, le gain ne paie pas l'en-tête
export const COMPRESS_MAX = 2 * 1024 * 1024;    // au-delà, la réponse part non compressée (temps de calcul borné)
const SYNC_MAX = 64 * 1024;                     // jusque-là, compression synchrone (environ 1 ms) ; au-delà, pool de threads
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|javascript|xml|manifest\+json|[\w.-]+\+(?:json|xml))|image\/svg\+xml)/i;
const SUFFIX = { br: '-br', gzip: '-gz' };

export const isCompressible = (type) => COMPRESSIBLE.test(String(type || ''));

// Encodage retenu parmi `available` (dans l'ordre de préférence) selon les poids q d'Accept-Encoding :
// q=0 refuse un encodage, « * » couvre ceux qui ne sont pas nommés. null : réponse non compressée.
export function negotiate(header, available = ['br', 'gzip']) {
  if (!header) return null;
  const weights = new Map();
  for (const part of String(header).toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map((s) => s.trim());
    if (!name) continue;
    let q = 1;
    for (const p of params) { const m = /^q\s*=\s*([0-9.]{1,5})$/.exec(p); if (m) q = Math.min(1, Number(m[1]) || 0); }
    weights.set(name, q);
  }
  const weight = (c) => (weights.has(c) ? weights.get(c) : weights.get('*') ?? 0);
  let best = null, bestQ = 0;
  for (const c of available) { const q = weight(c); if (q > bestQ) { best = c; bestQ = q; } }
  return best;
}

const brotliOptions = (size, quality) => ({ params: { [Z.BROTLI_PARAM_QUALITY]: quality, [Z.BROTLI_PARAM_MODE]: Z.BROTLI_MODE_TEXT, [Z.BROTLI_PARAM_SIZE_HINT]: size } });
// Réglages : à la volée, brotli 5 et gzip 6 (rapides) ; précompression des fichiers statiques, niveaux maximaux.
const options = (enc, size, best) => (enc === 'br' ? brotliOptions(size, best ? Z.BROTLI_MAX_QUALITY : 5) : { level: best ? 9 : 6 });
export const encodeSync = (enc, buf) => (enc === 'br' ? zlib.brotliCompressSync(buf, options('br', buf.length)) : zlib.gzipSync(buf, options('gzip', buf.length)));
export const encode = (enc, buf, best = false) => new Promise((resolve, reject) => {
  const done = (err, out) => (err ? reject(err) : resolve(out));
  if (enc === 'br') zlib.brotliCompress(buf, options('br', buf.length, best), done);
  else zlib.gzip(buf, options('gzip', buf.length, best), done);
});

/* ---------- Validateurs ---------- */
export const contentHash = (data) => crypto.createHash('sha256').update(data).digest('hex').slice(0, 32);
export const strongEtag = (data) => `"${contentHash(data)}"`;
export const etagVariant = (etag, enc) => (typeof etag === 'string' && SUFFIX[enc] && /^"[0-9a-f]+"$/.test(etag) ? `${etag.slice(0, -1)}${SUFFIX[enc]}"` : etag);
const etagBase = (tag) => tag.replace(/-(?:br|gz)$/, '');
// If-None-Match correspond-il à l'ETag courant ? « * », liste, préfixe W/ et suffixes d'encodage acceptés.
export function etagMatches(header, etag) {
  if (!header || typeof etag !== 'string') return false;
  if (String(header).trim() === '*') return true;
  const current = etagBase(etag.replace(/^W\//, '').replace(/"/g, ''));
  for (const m of String(header).matchAll(/(?:W\/)?"([^"]*)"/g)) if (etagBase(m[1]) === current) return true;
  return false;
}

/* ---------- Compression à la volée (API) ---------- */
function eligible(res) {
  const status = res.statusCode;
  if (status < 200 || status === 204 || status === 206 || status === 304) return false;
  if (res.getHeader('Content-Encoding') || res.getHeader('Content-Disposition') || res.getHeader('Content-Range')) return false;
  if (/\bno-transform\b/i.test(String(res.getHeader('Cache-Control') || ''))) return false;
  return isCompressible(res.getHeader('Content-Type'));
}

// Intercepte res.end (Express envoie le corps entier en une fois : res.json, res.send). Une réponse écrite par morceaux
// (res.write) passe telle quelle. Le corps compressé n'est envoyé que s'il est plus petit que l'original.
export function compressApi({ min = COMPRESS_MIN, max = COMPRESS_MAX, skip = () => false } = {}) {
  return (req, res, next) => {
    if (req.method === 'HEAD' || skip(req)) return next();
    const enc = negotiate(req.headers['accept-encoding']);
    const { write, end } = res;
    let streamed = false;
    res.write = function (...args) { streamed = true; return write.apply(this, args); };
    res.end = function (chunk, encoding, cb) {
      res.write = write; res.end = end;
      if (typeof chunk === 'function') { cb = chunk; chunk = undefined; encoding = undefined; }
      else if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
      if (streamed || chunk == null || res.headersSent || !eligible(res)) return end.call(this, chunk, encoding, cb);
      res.vary('Accept-Encoding');
      const body = typeof chunk === 'string' ? Buffer.from(chunk, encoding || 'utf8') : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (!enc || body.length < min || body.length > max) return end.call(this, body, cb);
      const finish = (out) => {
        if (!out || out.length >= body.length) return end.call(this, body, cb);
        res.setHeader('Content-Encoding', enc);
        res.setHeader('Content-Length', out.length);
        const tag = res.getHeader('ETag');
        if (typeof tag === 'string') res.setHeader('ETag', etagVariant(tag, enc));
        return end.call(this, out, cb);
      };
      if (body.length <= SYNC_MAX) {
        let out = null;
        try { out = encodeSync(enc, body); } catch (e) { console.error('[compression]', e.message); }
        return finish(out);
      }
      encode(enc, body).then(finish, (e) => { console.error('[compression]', e.message); finish(null); });
      return this;
    };
    next();
  };
}
