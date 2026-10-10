// TOTP (RFC 6238, sur HOTP de la RFC 4226) : HMAC-SHA1, 6 chiffres, pas de 30 s, tolérance de ±1 pas. Module pur
// (node:crypto seulement, ni base ni état) : la double authentification (twofactor.js) l'utilise, les tests le
// vérifient sur les vecteurs de référence des RFC.
import crypto from 'node:crypto';

export const STEP_SECONDS = 30;
export const DIGITS = 6;
export const DRIFT_STEPS = 1;   // un pas d'avance ou de retard toléré (horloge du téléphone, temps de saisie)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Base32 de la RFC 4648, sans remplissage (format attendu par les applications d'authentification).
export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return bits ? out + B32[(value << (5 - bits)) & 31] : out;
}

export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP_SECONDS);

// HOTP : HMAC-SHA1 du compteur sur 8 octets, troncature dynamique, 6 chiffres.
export function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const bin = h.readUInt32BE(h[h.length - 1] & 0x0f) & 0x7fffffff;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}
export const totpAt = (key, ms = Date.now()) => hotp(key, stepAt(ms));

// Saisie d'un code : 6 chiffres, espaces et tirets ignorés (« 123 456 »). Retourne null si ce n'en est pas un.
export function normalizeTotp(input) {
  if (typeof input !== 'string' || input.length > 20) return null;
  const s = input.replace(/[\s\-  ]/g, '');
  return /^\d{6}$/.test(s) ? s : null;
}

// Pas du code saisi dans la fenêtre [maintenant - 1, maintenant + 1], s'il est plus récent que `lastStep` (dernier pas
// accepté pour ce compte) : un code déjà utilisé, ou plus ancien que le dernier utilisé, est refusé (anti-rejeu).
// Les trois comparaisons sont faites, à temps constant, quel que soit le résultat. Retourne le pas, ou null.
export function matchTotp(key, input, lastStep = 0, ms = Date.now()) {
  const code = normalizeTotp(input);
  if (!code) return null;
  const given = Buffer.from(code), now = stepAt(ms);
  let found = null;
  for (let s = now - DRIFT_STEPS; s <= now + DRIFT_STEPS; s += 1) {
    const same = crypto.timingSafeEqual(given, Buffer.from(hotp(key, s)));
    if (same && s > lastStep && found === null) found = s;
  }
  return found;
}
