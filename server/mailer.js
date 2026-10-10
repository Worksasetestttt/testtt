// Envoi d’e-mails : SMTP (nodemailer) si SMTP_URL est défini, sinon « boîte d’envoi » locale (data/outbox).
// Chaque tentative est journalisée dans la table mails (colonne error renseignée en cas d’échec). sendMail est
// asynchrone et ne lève jamais d’exception synchrone : un échec se traduit par une promesse rejetée.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { q, now } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTBOX = path.resolve(process.env.OUTBOX_DIR || path.join(__dirname, '..', 'data', 'outbox'));
export const SEND_TIMEOUT_MS = Math.max(1000, Number(process.env.MAIL_TIMEOUT_MS) || 30000);
// Adresse nue (pas de nom affiché, pas de caractères spéciaux d’en-tête).
const ADDRESS = /^[^\s@<>,;:"'()[\]\\]+@[^\s@<>,;:"'()[\]\\]+\.[a-z0-9-]{2,}$/i;

// Un en-tête ne contient jamais de retour à la ligne : neutralise toute injection d’en-têtes.
const header = (v) => String(v ?? '').replace(/[\r\n\t\0]+/g, ' ').trim();
export const FROM = header(process.env.MAIL_FROM || 'Oubli <demandes@oubli.example>');
export const REPLY_TO = header(process.env.MAIL_REPLY_TO || process.env.MAIL_FROM || 'demandes@oubli.example');

export const mailMode = process.env.SMTP_URL ? 'smtp' : 'outbox';
let transport = null;
if (process.env.SMTP_URL) {
  const nodemailer = await import('nodemailer');
  // nodemailer ignore les autres options quand on lui passe une URL : on la décompose pour ajouter délais et pool.
  transport = nodemailer.default.createTransport({ ...smtpOptions(process.env.SMTP_URL), pool: true, maxConnections: 2, maxMessages: 100, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: SEND_TIMEOUT_MS });
}
export function smtpOptions(url) {
  const u = new URL(url);
  if (!/^smtps?:$/.test(u.protocol)) throw new Error('SMTP_URL doit commencer par smtp:// ou smtps://');
  const secure = u.protocol === 'smtps:';
  const o = { host: u.hostname, port: Number(u.port) || (secure ? 465 : 587), secure };
  if (u.username) o.auth = { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) };
  for (const [k, v] of u.searchParams) if (/^[a-zA-Z]+$/.test(k)) o[k] = /^(true|false)$/i.test(v) ? v.toLowerCase() === 'true' : v; // ex. ?requireTLS=true
  return o;
}

const withTimeout = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`Délai d’envoi dépassé (${Math.round(ms / 1000)} s).`)), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

let seq = 0;
// redact : secrets (jeton d’un lien de réinitialisation…) envoyés au destinataire mais jamais conservés en clair dans la
// table mails, que lisent l’administration et l’export RGPD. Le message réellement envoyé n’est pas modifié.
export async function sendMail({ to, subject, text, html, headers = {}, request_id = null, user_id = null, redact = [] }) {
  const addr = header(to), subj = header(subject), body = String(text ?? '');
  const stored = (Array.isArray(redact) ? redact : []).filter((s) => typeof s === 'string' && s.length >= 8).reduce((b, s) => b.split(s).join('[masqué]'), body);
  const extra = Object.fromEntries(Object.entries(headers || {}).filter(([k]) => /^[a-z0-9-]+$/i.test(k)).map(([k, v]) => [k, header(v)]));
  const record = (message_id, error) => q.run('INSERT INTO mails (request_id, user_id, to_addr, subject, body, mode, message_id, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', request_id, user_id, addr, subj, stored, mailMode, message_id, error, now());
  try {
    if (!ADDRESS.test(addr) || addr.length > 254) throw new Error(`Adresse destinataire invalide : « ${addr || '—'} »`);
    if (!subj) throw new Error('Objet du message manquant.');
    let messageId;
    if (transport) {
      const info = await withTimeout(transport.sendMail({ from: FROM, to: addr, replyTo: REPLY_TO, subject: subj, text: body, html, headers: extra }), SEND_TIMEOUT_MS);
      messageId = info.messageId;
    } else {
      fs.mkdirSync(OUTBOX, { recursive: true });
      messageId = `<${crypto.randomUUID()}@oubli.local>`;
      // Nom de fichier sûr : horodatage + compteur (deux envois dans la même milliseconde ne s’écrasent pas) + adresse filtrée.
      seq = (seq + 1) % 100000;
      const name = `${now().replace(/[:.]/g, '-')}-${String(seq).padStart(5, '0')}-${addr.replace(/[^a-z0-9@._-]/gi, '_').slice(0, 80)}.eml`;
      const head = [`From: ${FROM}`, `To: ${addr}`, `Reply-To: ${REPLY_TO}`, `Subject: ${subj}`, `Message-ID: ${messageId}`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`)].join('\n');
      fs.writeFileSync(path.join(OUTBOX, path.basename(name)), `${head}\n\n${body}\n`);
    }
    record(messageId, null);
    return { messageId, mode: mailMode };
  } catch (e) {
    const message = String(e?.message || e).slice(0, 300);
    try { record(null, message); } catch {}
    throw Object.assign(new Error(message), { cause: e, recorded: true });
  }
}
