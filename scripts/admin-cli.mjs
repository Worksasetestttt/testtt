// Outil d'exploitation en ligne de commande, pour qui a accès au serveur : donner le rôle administrateur à un compte
// (sans attendre le lien de confirmation, par exemple sans serveur d'envoi configuré), désactiver la double
// authentification d'un compte qui a perdu son téléphone et ses codes de secours, ou créer des clés d'activation sans
// passer par le panel. Utilise la base du serveur (DATABASE_PATH, lu dans .env par « npm run admin »).
// Les clés ne sont affichées qu'ici, une seule fois : la base n'en garde que l'empreinte et les 4 derniers caractères.
import { q, now, ensureColumn, logEvent } from '../server/db.js';
import { parseKeyBatch, createKeys } from '../server/keys.js';

const USAGE = `Outil d'administration d'Oubli (à lancer sur la machine du serveur) :

  npm run admin -- promote <adresse>     Donne le rôle administrateur à un compte existant.
  npm run admin -- 2fa-off <adresse>     Désactive la double authentification d'un compte (téléphone et codes de
                                         secours perdus) ; le titulaire la réactive ensuite dans ses paramètres.
  npm run admin -- keys [options]        Crée des clés d'activation (affichées une seule fois).
      --plan individuel|famille          offre offerte (défaut : individuel)
      --days N                           durée offerte, de 1 à 730 jours (défaut : 30)
      --count N                          nombre de clés, de 1 à 100 (défaut : 1)
      --uses N                           utilisations par clé, de 1 à 1000 (défaut : 1)
      --expires AAAA-MM-JJ               date limite d'activation (facultative)
      --note "texte"                     note visible par l'équipe (facultative)

Exemple : npm run admin -- keys --plan famille --days 90 --count 3 --note "Amis"`;

const [cmd, ...rest] = process.argv.slice(2);
const APP_URL = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
// --cle valeur ou --cle=valeur. Une option inconnue arrête tout : une faute de frappe ne doit pas créer de clés.
const KEY_OPTIONS = ['plan', 'days', 'count', 'uses', 'expires', 'note'];
function options(args) {
  const o = {};
  for (let i = 0; i < args.length; i += 1) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(args[i]);
    if (!m || !KEY_OPTIONS.includes(m[1])) throw new Error(`Option inconnue : « ${args[i]} » (options : ${KEY_OPTIONS.map((k) => `--${k}`).join(', ')}).`);
    o[m[1]] = m[2] !== undefined ? m[2] : args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[(i += 1)] : 'true';
  }
  return o;
}
// Journal d'audit de l'administration (créé au premier démarrage du serveur) : action attribuée à « cli ».
function audit(action, target, details) {
  try { q.run('INSERT INTO admin_audit (admin_id, action, target, details, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)', 'cli', action, target, JSON.stringify({ ...details, via: 'ligne de commande' }), '', now()); }
  catch { /* serveur jamais démarré sur cette base : pas encore de journal d'audit */ }
}

function promote(address) {
  const email = String(address || '').trim().toLowerCase();
  if (!email) throw new Error('Indiquez l’adresse du compte : npm run admin -- promote moi@exemple.fr');
  ensureColumn('users', 'email_verified_at', 'TEXT');
  const u = q.get('SELECT id, role FROM users WHERE email = ? AND deleted_at IS NULL', email);
  if (!u) throw new Error(`Aucun compte pour ${email} : inscrivez-vous d’abord (/app/#signup), puis relancez la commande.`);
  if (u.role === 'admin') return console.log(`✔ ${email} est déjà administrateur.`);
  // Qui lance cette commande a la main sur le serveur : l'adresse est tenue pour confirmée.
  q.run(`UPDATE users SET role = 'admin', email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?`, now(), u.id);
  logEvent(u.id, 'account', 'Accès administrateur accordé depuis le serveur (ligne de commande).');
  audit('user.role', u.id, { role: 'admin' });
  console.log(`✔ ${email} est maintenant administrateur : rechargez l’application, puis ouvrez ${APP_URL}/app/#admin`);
}

// Dernier recours quand le titulaire a perdu son téléphone et ses codes de secours (la réinitialisation du mot de passe
// ne contourne pas la double authentification) : à lancer après avoir vérifié son identité par un autre moyen.
function twoFactorOff(address) {
  const email = String(address || '').trim().toLowerCase();
  if (!email) throw new Error('Indiquez l’adresse du compte : npm run admin -- 2fa-off moi@exemple.fr');
  const u = q.get('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL', email);
  if (!u) throw new Error(`Aucun compte pour ${email}.`);
  let removed = 0;
  try {
    removed = Number(q.run('DELETE FROM user_totp WHERE user_id = ? AND enabled_at IS NOT NULL', u.id).changes || 0);
    if (removed) { q.run('DELETE FROM totp_recovery_codes WHERE user_id = ?', u.id); q.run('DELETE FROM login_challenges WHERE user_id = ?', u.id); }
  } catch { /* serveur jamais démarré sur cette base : pas encore de double authentification */ }
  if (!removed) return console.log(`✔ La double authentification n’est pas active pour ${email} : rien à faire.`);
  logEvent(u.id, 'account', 'Double authentification désactivée par l’équipe Oubli (ligne de commande du serveur).');
  audit('user.2fa_off', u.id, {});
  console.log(`✔ Double authentification désactivée pour ${email} : le mot de passe suffit pour se connecter. Invitez le titulaire à la réactiver dans ses paramètres.`);
}

function keys(args) {
  const o = options(args);
  const r = createKeys(parseKeyBatch({ count: o.count ?? '1', plan: o.plan ?? 'individuel', days: o.days ?? '30', max_uses: o.uses ?? '1', expires_at: o.expires, note: o.note }), null);
  audit('key.create', r.batch, { count: r.keys.length, plan: r.plan, days: r.days, max_uses: r.max_uses, expires_at: r.expires_at || undefined, note: r.note || undefined });
  console.log(`✔ ${r.keys.length} clé${r.keys.length > 1 ? 's' : ''} ${r.plan === 'famille' ? 'Famille' : 'Individuel'}, ${r.days} jours${r.max_uses > 1 ? `, ${r.max_uses} utilisations chacune` : ''} (lot ${r.batch}).`);
  console.log('Copiez-les maintenant : elles ne seront plus jamais affichées. Chaque lien ouvre l’inscription avec la clé déjà remplie.\n');
  for (const k of r.keys) console.log(`${k.key}   ${APP_URL}/app/#signup?key=${k.key}`);
}

try {
  if (cmd === 'promote') promote(rest[0]);
  else if (cmd === '2fa-off') twoFactorOff(rest[0]);
  else if (cmd === 'keys') keys(rest);
  else { console.log(USAGE); if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1; }
} catch (e) {
  console.error(`✘ ${e.message}`);
  process.exitCode = 1;
}
// Les modules du serveur programment des minuteries (nettoyage, planificateur) : on sort explicitement.
process.exit(process.exitCode ?? 0);
