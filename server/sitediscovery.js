// Découverte du contact « données personnelles » d'un site à partir d'une adresse collée par un abonné.
// Module sans base de données (testable seul) : normalisation de l'URL, sites exclus, garde anti-SSRF, lecture des pages
// du site lui-même (mentions légales, confidentialité, contact) et extraction des adresses e-mail publiées.
//
// Garde anti-SSRF : jamais d'adresse IP ni de nom local dans l'URL ; chaque connexion (redirections comprises) passe par
// une résolution DNS dont toutes les adresses doivent être publiques, et la connexion se fait sur l'adresse vérifiée
// (pas de seconde résolution exploitable) ; ports 80 et 443 seulement ; durée, taille et redirections plafonnées.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

const SECOND_LEVEL = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'com.br', 'com.mx', 'co.za', 'com.tr', 'gouv.fr', 'asso.fr', 'nom.fr', 'com.fr', 'co.in', 'com.cn', 'com.sg', 'com.ar', 'co.kr']);
const LOCAL_TLDS = new Set(['local', 'localhost', 'internal', 'intranet', 'lan', 'home', 'corp', 'private', 'test', 'example', 'invalid', 'onion', 'arpa', 'localdomain']);
const SOCIAL = ['facebook.com', 'fb.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com', 'tiktok.com', 'snapchat.com', 'youtube.com', 'pinterest.com', 'reddit.com', 'threads.net', 'whatsapp.com', 'telegram.org', 't.me', 'discord.com', 'twitch.tv', 'tumblr.com', 'bsky.app', 'mastodon.social', 'vk.com'];
const GOV_SUFFIXES = ['.gouv.fr', '.gov', '.gov.uk', '.europa.eu', '.admin.ch', '.gc.ca', '.gob.es', '.bund.de', '.gv.at', '.belgium.be', '.public.lu', '.mil'];
const GOV_HOSTS = ['service-public.fr', 'ameli.fr', 'caf.fr', 'francetravail.fr', 'pole-emploi.fr', 'legifrance.gouv.fr', 'impots.gouv.fr', 'ants.gouv.fr'];

export const UA = 'OubliBot/1.0 (+demandes RGPD au nom de nos abonnés)';

/* ---------- Adresse du site ---------- */
// Domaine « enregistrable » approximatif : deux derniers libellés, trois pour les suffixes de second niveau connus.
export function registrableDomain(host) {
  const parts = String(host || '').toLowerCase().split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  return SECOND_LEVEL.has(last2) ? parts.slice(-3).join('.') : last2;
}
// Normalise ce que l'abonné a collé : « exemple.fr/fiche/123 », « https://www.exemple.fr/… ». Renvoie { url, host, domain } ou { error }.
export function normalizeSite(input) {
  let raw = String(input ?? '').trim();
  if (!raw) return { error: 'Collez l’adresse d’un site ou d’une page.' };
  if (raw.length > 2048) return { error: 'Adresse trop longue.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw.replace(/^\/+/, '')}`;
  let u;
  try { u = new URL(raw); } catch { return { error: 'Adresse invalide : vérifiez ce que vous avez collé.' }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { error: 'Seules les adresses web (http ou https) sont acceptées.' };
  if (u.username || u.password) return { error: 'Adresse invalide.' };
  if (u.port && !['80', '443'].includes(u.port)) return { error: 'Adresse invalide : port non pris en charge.' };
  const hostname = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || net.isIP(hostname.replace(/^\[|\]$/g, ''))) return { error: 'Indiquez le nom du site (exemple.fr), pas une adresse IP.' };
  const labels = hostname.split('.');
  if (labels.length < 2 || labels.some((l) => !l || l.length > 63 || !/^[a-z0-9-]+$/.test(l) || l.startsWith('-') || l.endsWith('-'))) return { error: 'Nom de site invalide.' };
  const tld = labels[labels.length - 1];
  if (LOCAL_TLDS.has(tld) || /^\d+$/.test(tld) || tld.length < 2) return { error: 'Ce nom de site n’est pas public.' };
  const host = hostname.replace(/^www\d?\./, '');
  const url = `${u.protocol}//${hostname}${u.pathname}${u.search}`.slice(0, 500);
  return { url, host, domain: registrableDomain(host) };
}
// Sites hors du champ du service : réseaux sociaux (suppression depuis le compte) et administrations (obligations légales).
export function excludedReason(host) {
  const h = String(host || '').toLowerCase();
  const is = (d) => h === d || h.endsWith(`.${d}`);
  if (SOCIAL.some(is)) return 'Réseau social : supprimez vos données depuis les paramètres de votre compte sur ce site, une demande par e-mail n’est pas la bonne voie.';
  if (GOV_SUFFIXES.some((s) => h.endsWith(s)) || GOV_HOSTS.some(is)) return 'Site d’une administration : les données publiques ou légales qu’il détient ne relèvent pas d’une demande d’effacement.';
  return null;
}

/* ---------- Garde réseau ---------- */
const v4 = (ip) => ip.split('.').map(Number);
function isPublicV4(ip) {
  const [a, b, c] = v4(ip);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;                  // 0/8, 10/8, loopback, multicast, réservé
  if (a === 100 && b >= 64 && b <= 127) return false;                                // 100.64/10 (CGNAT)
  if (a === 169 && b === 254) return false;                                          // lien local
  if (a === 172 && b >= 16 && b <= 31) return false;                                 // 172.16/12
  if (a === 192 && b === 168) return false;                                          // 192.168/16
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;                    // 192.0.0/24, 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return false;                             // 198.18/15
  if (a === 198 && b === 51 && c === 100) return false;                              // 198.51.100/24
  if (a === 203 && b === 0 && c === 113) return false;                               // 203.0.113/24
  return true;
}
export function isPublicIp(ip) {
  const kind = net.isIP(String(ip || ''));
  if (kind === 4) return isPublicV4(ip);
  if (kind !== 6) return false;
  const s = ip.toLowerCase();
  const mapped = s.match(/^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);        // IPv4 encapsulée
  if (mapped) return isPublicV4(mapped[1]);
  if (s === '::' || s === '::1') return false;
  const head = parseInt(s.split(':')[0] || '0', 16);
  if ((head & 0xfe00) === 0xfc00) return false;                                      // fc00::/7 (adresses uniques locales)
  if ((head & 0xffc0) === 0xfe80) return false;                                      // fe80::/10 (lien local)
  if ((head & 0xff00) === 0xff00) return false;                                      // ff00::/8 (multicast)
  if (s.startsWith('2001:db8:') || s.startsWith('2001:0db8:')) return false;         // documentation
  return true;
}
// Résolution vérifiée, compatible avec l'option « all » de net.connect (sélection automatique de famille).
function guardedLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  dns.lookup(hostname, { all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = (addresses || []).filter((a) => a && a.address);
    if (!list.length || list.some((a) => !isPublicIp(a.address))) return callback(Object.assign(new Error('Adresse réseau non publique refusée.'), { code: 'EPRIVATE' }));
    if (options && options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}
// Lecture d'une page HTML : ports 80/443, redirections revérifiées, durée et taille plafonnées.
export function safeFetch(url, { timeoutMs = 6000, maxBytes = 600000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error('URL invalide.')); }
    const check = normalizeSite(u.href);
    if (check.error) return reject(new Error(check.error));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: 'GET', lookup: guardedLookup, headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'Accept-Language': 'fr,en;q=0.8' }, timeout: timeoutMs }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('Trop de redirections.'));
        let next;
        try { next = new URL(res.headers.location, u).href; } catch { return reject(new Error('Redirection invalide.')); }
        return safeFetch(next, { timeoutMs, maxBytes, redirects: redirects - 1 }).then(resolve, reject);
      }
      const type = String(res.headers['content-type'] || '');
      if (status >= 400 || (type && !/text\/html|application\/xhtml/i.test(type))) { res.resume(); return resolve({ status, url: u.href, html: '' }); }
      let size = 0; const chunks = [];
      res.on('data', (c) => { size += c.length; if (size > maxBytes) { req.destroy(); resolve({ status, url: u.href, html: Buffer.concat(chunks).toString('utf8') }); return; } chunks.push(c); });
      res.on('end', () => resolve({ status, url: u.href, html: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Délai dépassé.')));
    req.on('error', reject);
    req.end();
  });
}

/* ---------- Extraction ---------- */
const ENTITIES = { '&#64;': '@', '&#x40;': '@', '&commat;': '@', '&#46;': '.', '&#x2e;': '.', '&period;': '.', '&amp;': '&', '&nbsp;': ' ' };
function deobfuscate(html) {
  return String(html || '')
    .replace(/&#(?:64|x40);|&commat;|&#(?:46|x2e);|&period;|&amp;|&nbsp;/gi, (m) => ENTITIES[m.toLowerCase()] || m)
    .replace(/\s*[[(]\s*(?:at|arobase)\s*[\])]\s*/gi, '@')
    .replace(/\s*[[(]\s*(?:dot|point)\s*[\])]\s*/gi, '.');
}
const PREFERRED = [/^(dpo|rgpd|gdpr|privacy|privacidad|privacidade|datenschutz|dataprotection|data-protection|data\.protection|protection-?donnees|donnees(-?personnelles)?|cnil|vie-?privee|confidentialite)\b/, /^(legal|juridique|compliance|conformite)\b/, /^(contact|support|service-?client|serviceclient|hello|bonjour|info|infos|help|aide)\b/];
const IGNORE = /^(no-?reply|ne-?pas-?repondre|donotreply|mailer-daemon|postmaster|abuse|webmaster|example|exemple|nom|name|prenom|votre|your|email|e-mail|test|john\.doe|jean\.dupont)\b/;
// Adresses publiées sur le domaine du site (ou un sous-domaine), classées : DPO/confidentialité, juridique, contact général.
export function extractContacts(html, domain) {
  const text = deobfuscate(html);
  const found = new Map();
  const re = /(?:mailto:)?([a-z0-9][a-z0-9._%+-]{0,63}@([a-z0-9-]+(?:\.[a-z0-9-]+)+))/gi;
  let m;
  while ((m = re.exec(text))) {
    const email = m[1].toLowerCase().replace(/\.+$/, ''), host = email.split('@')[1];
    const local = email.split('@')[0];
    if (!(host === domain || host.endsWith(`.${domain}`))) continue;                   // seulement le domaine du site
    if (IGNORE.test(local) || /\.(png|jpe?g|gif|svg|webp|css|js)$/.test(email)) continue;
    const rank = PREFERRED.findIndex((p) => p.test(local));
    const score = (rank < 0 ? 3 : rank) * 10 + (/mailto:/i.test(m[0]) ? 0 : 1);
    if (!found.has(email) || found.get(email) > score) found.set(email, score);
  }
  return [...found.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([e, score]) => ({ email: e, score }));
}
// Liens internes qui mènent aux pages utiles (mentions légales, confidentialité, contact).
export function legalLinks(html, base) {
  const out = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || ''))) && out.length < 12) {
    const label = `${m[1]} ${m[2].replace(/<[^>]+>/g, ' ')}`.toLowerCase();
    if (!/(confidentialit|privacy|mentions|l[ée]gal|rgpd|gdpr|donn[ée]es|cookies|contact|dpo)/.test(label)) continue;
    try {
      const u = new URL(m[1], base);
      if (u.hostname.replace(/^www\d?\./, '') === new URL(base).hostname.replace(/^www\d?\./, '') && !out.includes(u.href)) out.push(u.href);
    } catch { /* lien ignoré */ }
  }
  return out;
}
export const LEGAL_PATHS = ['/mentions-legales', '/politique-de-confidentialite', '/confidentialite', '/donnees-personnelles', '/rgpd', '/privacy', '/privacy-policy', '/legal', '/contact'];

// Parcourt la page d'accueil, ses liens légaux puis les chemins usuels, dans un budget de temps. fetchPage est injectable (tests).
export async function discoverContact(host, { fetchPage = safeFetch, budgetMs = 15000, maxPages = 8 } = {}) {
  const domain = registrableDomain(host), deadline = Date.now() + budgetMs, seen = new Set();
  const queue = [`https://${host}/`];
  let best = null, pages = 0, title = null, expanded = false;
  while (queue.length && pages < maxPages && Date.now() < deadline) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url); pages += 1;
    let page;
    try { page = await fetchPage(url, { timeoutMs: Math.max(1000, Math.min(6000, deadline - Date.now())) }); } catch { if (pages === 1) queue.push(`http://${host}/`); continue; }
    if (!page) continue;
    const html = page.html || '';
    let at = url; try { at = new URL(page.url || url).href; } catch { /* adresse finale invalide : celle demandée */ }
    if (html && title === null) { const t = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i); title = t ? t[1].replace(/\s+/g, ' ').trim().slice(0, 80) : ''; }
    const c = html ? extractContacts(html, domain)[0] : null;
    if (c && (!best || c.score < best.score)) best = { ...c, page: at };
    if (best && best.score < 10) break;                                                // adresse DPO / confidentialité : inutile d'aller plus loin
    // Première page obtenue (accueil en https, ou en http après un échec ; même vide : 403, page non HTML) : liens légaux
    // trouvés, puis chemins usuels sur la même origine.
    if (!expanded) {
      expanded = true;
      for (const l of legalLinks(html, at)) queue.push(l);
      for (const p of LEGAL_PATHS) queue.push(new URL(at).origin + p);
    }
  }
  return { email: best ? best.email : null, page: best ? best.page : null, pages, title: title || null };
}
