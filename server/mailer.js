// Envoi d'e-mails : SMTP (nodemailer) si SMTP_URL est défini, sinon « boîte d'envoi » locale (data/outbox).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { q, now } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTBOX = process.env.OUTBOX_DIR || path.join(__dirname, '..', 'data', 'outbox');
export const FROM = process.env.MAIL_FROM || 'Oubli <demandes@oubli.example>';
export const REPLY_TO = process.env.MAIL_REPLY_TO || process.env.MAIL_FROM || 'demandes@oubli.example';

let transport = null;
export const mailMode = process.env.SMTP_URL ? 'smtp' : 'outbox';
if (process.env.SMTP_URL) {
  const nodemailer = await import('nodemailer');
  transport = nodemailer.default.createTransport(process.env.SMTP_URL);
}

export async function sendMail({ to, subject, text, html, headers = {}, request_id = null, user_id = null }) {
  let messageId;
  if (transport) {
    const info = await transport.sendMail({ from: FROM, to, replyTo: REPLY_TO, subject, text, html, headers });
    messageId = info.messageId;
  } else {
    fs.mkdirSync(OUTBOX, { recursive: true });
    messageId = `<${crypto.randomUUID()}@oubli.local>`;
    const stamp = now().replace(/[:.]/g, '-');
    const file = path.join(OUTBOX, `${stamp}-${(to || 'x').replace(/[^a-z0-9@.]/gi, '_')}.eml`);
    const head = [`From: ${FROM}`, `To: ${to}`, `Reply-To: ${REPLY_TO}`, `Subject: ${subject}`, `Message-ID: ${messageId}`, `Date: ${new Date().toUTCString()}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)].join('\n');
    fs.writeFileSync(file, `${head}\n\n${text}\n`);
  }
  q.run('INSERT INTO mails (request_id, user_id, to_addr, subject, body, mode, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', request_id, user_id, to, subject, text, mailMode, messageId, now());
  return { messageId, mode: mailMode };
}
