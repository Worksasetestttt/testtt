// Sites ajoutés par les abonnés (« coller une URL ») : rattachement au registre si le site y figure, sinon courtier
// personnalisé (hors registre : il ne reçoit des demandes que des profils qui l'ont ajouté), demande créée pour le
// profil, adresse de la fiche citée dans le courrier, recherche du contact sur le site en arrière-plan.
import crypto from 'node:crypto';
import { q, now, logEvent, tx, newToken } from './db.js';
import { normalizeSite, excludedReason, discoverContact, registrableDomain } from './sitediscovery.js';
import { tick, isEligible } from './scheduler.js';
import { HttpError } from './util.js';
import { mailMode } from './mailer.js';

export const MAX_SITES_PER_PROFILE = 20;
const off = (v) => /^(0|off|false|no)$/i.test(String(v || ''));
export const DISCOVERY = !off(process.env.SITE_DISCOVERY);

// Juridiction et base légale déduites du domaine : un site générique (.com, .io…) reçoit une lettre RGPD + CCPA.
const EU_CC = new Set(['de', 'es', 'it', 'nl', 'pt', 'ie', 'at', 'dk', 'se', 'fi', 'pl', 'cz', 'sk', 'si', 'hr', 'hu', 'ro', 'bg', 'gr', 'cy', 'mt', 'ee', 'lv', 'lt', 'eu', 'no', 'is', 'li']);
function lawFor(host) {
  const tld = host.split('.').pop();
  if (['fr', 'be', 'lu', 'mc', 're', 'gp', 'mq', 'nc', 'pf'].includes(tld)) return { jurisdiction: 'FR', legal_basis: 'rgpd' };
  if (tld === 'uk') return { jurisdiction: 'UK', legal_basis: 'rgpd' };
  if (tld === 'ch') return { jurisdiction: 'CH', legal_basis: 'rgpd' };
  if (tld === 'ca') return { jurisdiction: 'CA', legal_basis: 'rgpd' };
  if (tld === 'us') return { jurisdiction: 'US', legal_basis: 'both' };
  if (EU_CC.has(tld)) return { jurisdiction: 'EU', legal_basis: 'rgpd' };
  return { jurisdiction: 'EU', legal_basis: 'both' };
}
const slugFor = (host) => `site-${host.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`.slice(0, 60).replace(/-+$/, '');

// Courtier du registre dont le domaine couvre ce site (le plus précis l'emporte).
export function registryBrokerFor(host) {
  return q.all('SELECT * FROM brokers WHERE custom = 0').filter((b) => host === b.domain || host.endsWith(`.${b.domain}`)).sort((a, b) => b.domain.length - a.domain.length)[0] || null;
}
// Courtier personnalisé : partagé seulement entre abonnés qui ont ajouté exactement le même nom d'hôte. Le slug ne suffit
// pas : « fiches-annuaire.fr » et « fiches.annuaire.fr » (ou deux noms longs tronqués) donnent le même, et la demande d'un
// abonné partait alors, avec son identité, au contact du site enregistré en premier par un autre.
function customBrokerFor(site, userId) {
  const existing = q.get('SELECT * FROM brokers WHERE custom = 1 AND domain = ? ORDER BY id LIMIT 1', site.host);
  if (existing) return { broker: existing, created: false };
  const base = slugFor(site.host);
  let slug = base;
  for (let i = 2; q.get('SELECT 1 FROM brokers WHERE slug = ?', slug); i += 1) slug = `${base.slice(0, 54).replace(/-+$/, '')}-${i}`;
  const law = lawFor(site.host);
  q.run(`INSERT INTO brokers (slug, name, domain, category, jurisdiction, legal_basis, contact_email, contact_verified, sensitivity, recheck_days, active, custom, contact_source, discovery_status, added_by, created_at)
    VALUES (?, ?, ?, 'Site ajouté', ?, ?, ?, 0, 2, 90, 1, 1, 'guess', ?, ?, ?)`, slug, site.host, site.host, law.jurisdiction, law.legal_basis, `privacy@${site.domain}`, DISCOVERY ? 'pending' : 'skipped', userId, now());
  return { broker: q.get('SELECT * FROM brokers WHERE slug = ?', slug), created: true };
}
const insertRequest = (user, profile, broker, cycle, url) => {
  const id = crypto.randomUUID();
  q.run(`INSERT INTO requests (id, user_id, profile_id, broker_id, cycle, status, token, created_at, source_url) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`, id, user.id, profile.id, broker.id, cycle, newToken(), now(), url);
  return q.get('SELECT * FROM requests WHERE id = ?', id);
};

// Ajoute un site pour un profil. Renvoie { status: created | relaunched | already, broker, request, registry }.
export function addSite(user, profile, input) {
  const site = normalizeSite(input);
  if (site.error) throw new HttpError(400, site.error);
  const excluded = excludedReason(site.host);
  if (excluded) throw new HttpError(400, excluded);
  if (!profile.first_name || !profile.last_name) throw new HttpError(400, 'Complétez d’abord le prénom et le nom de ce profil.');
  if (!isEligible(user)) throw new HttpError(400, 'Le mandat doit être signé et l’abonnement actif pour envoyer une demande.');
  const registry = registryBrokerFor(site.host);
  const result = tx(() => {
    let broker = registry, created = false;
    if (!broker) {
      const counted = q.get('SELECT COUNT(DISTINCT r.broker_id) AS c FROM requests r JOIN brokers b ON b.id = r.broker_id WHERE r.profile_id = ? AND b.custom = 1', profile.id).c;
      const known = q.get('SELECT 1 FROM requests r JOIN brokers b ON b.id = r.broker_id WHERE r.profile_id = ? AND b.custom = 1 AND b.domain = ?', profile.id, site.host);
      if (!known && counted >= MAX_SITES_PER_PROFILE) throw new HttpError(400, `Limite atteinte : ${MAX_SITES_PER_PROFILE} sites ajoutés pour ce profil.`);
      ({ broker, created } = customBrokerFor(site, user.id));
    }
    if (!broker.active) throw new HttpError(400, 'Ce site a été retiré du service par notre équipe : aucune demande ne peut lui être adressée.');
    const latest = q.get('SELECT * FROM requests WHERE profile_id = ? AND broker_id = ? ORDER BY cycle DESC, created_at DESC LIMIT 1', profile.id, broker.id);
    if (latest && ['queued', 'sent', 'in_progress', 'action_required', 'error'].includes(latest.status)) {
      if (!latest.source_url) q.run('UPDATE requests SET source_url = ? WHERE id = ?', site.url, latest.id);
      return { status: 'already', broker, request: q.get('SELECT * FROM requests WHERE id = ?', latest.id), created };
    }
    if (latest) q.run('UPDATE requests SET next_check_at = NULL WHERE id = ?', latest.id);   // la nouvelle demande remplace la revérification
    const request = insertRequest(user, profile, broker, latest ? latest.cycle + 1 : 1, site.url);
    return { status: latest ? 'relaunched' : 'created', broker, request, created };
  });
  const who = `${profile.first_name} ${profile.last_name}`;
  if (result.status === 'already') logEvent(user.id, 'site', `Adresse ajoutée à la demande en cours chez ${result.broker.name} : ${site.url}`, { profile_id: profile.id, request_id: result.request.id });
  else if (result.status === 'relaunched') logEvent(user.id, 'site', `Fiche signalée chez ${result.broker.name} : nouvelle demande d’effacement pour ${who}.`, { profile_id: profile.id, request_id: result.request.id });
  else logEvent(user.id, 'site', registry ? `${result.broker.name} ajouté au dossier de ${who} : demande d’effacement préparée.` : `Site ajouté : ${site.host}. Nous cherchons son contact ; la demande part dès qu’il est connu.`, { profile_id: profile.id, request_id: result.request.id });
  if (result.created) runDiscovery(result.broker.id);
  else if (result.status !== 'already') setTimeout(() => tick(), 10);
  return { ...result, registry: !!registry, site };
}

// « Mes données sont réapparues » : nouvelle demande immédiate (nouveau cycle) pour une demande effacée ou refusée, sans
// attendre la revérification. L'adresse de la fiche, facultative, doit appartenir au courtier ; elle est citée dans le courrier.
export function relaunchRequest(user, r, input) {
  if (!['done', 'refused'].includes(r.status)) throw new HttpError(400, 'Seule une demande effacée ou refusée peut être relancée : celle-ci est encore en cours.');
  const broker = q.get('SELECT * FROM brokers WHERE id = ?', r.broker_id);
  if (!broker || !broker.active) throw new HttpError(400, 'Ce courtier a été retiré du service : aucune demande ne peut lui être adressée.');
  if (!isEligible(user)) throw new HttpError(400, 'Le mandat doit être signé et l’abonnement actif pour envoyer une demande.');
  let url = r.source_url || null;
  if (input) {
    const site = normalizeSite(input);
    if (site.error) throw new HttpError(400, site.error);
    if (site.host !== broker.domain && !site.host.endsWith(`.${broker.domain}`)) throw new HttpError(400, `Cette adresse n’appartient pas à ${broker.name} (${broker.domain}).`);
    url = site.url;
  }
  const profile = q.get('SELECT * FROM profiles WHERE id = ? AND user_id = ?', r.profile_id, user.id);
  if (!profile) throw new HttpError(404, 'Profil introuvable.');
  const request = tx(() => {
    const latest = q.get('SELECT id FROM requests WHERE profile_id = ? AND broker_id = ? ORDER BY cycle DESC, created_at DESC LIMIT 1', r.profile_id, r.broker_id);
    if (latest.id !== r.id) throw new HttpError(409, 'Une demande plus récente existe déjà pour ce courtier.');
    q.run('UPDATE requests SET next_check_at = NULL WHERE id = ?', r.id);
    return insertRequest(user, profile, broker, r.cycle + 1, url);
  });
  logEvent(user.id, 'recheck', `Données signalées de nouveau chez ${broker.name} : nouvelle demande d’effacement (cycle ${request.cycle}).`, { profile_id: r.profile_id, request_id: request.id });
  setTimeout(() => tick(), 10);
  return { request_id: request.id, cycle: request.cycle, url };
}

/* ---------- Recherche du contact (arrière-plan) ---------- */
const running = new Set();
// discover est injectable (tests) : par défaut, lecture du site lui-même (sitediscovery.js).
export function runDiscovery(brokerId, { force = false, discover = discoverContact } = {}) {
  const b = q.get('SELECT * FROM brokers WHERE id = ? AND custom = 1', brokerId);
  if (!b || running.has(b.id)) return Promise.resolve(null);
  if (!DISCOVERY) { q.run(`UPDATE brokers SET discovery_status = 'skipped' WHERE id = ? AND discovery_status = 'pending'`, b.id); setTimeout(() => tick(), 10); return Promise.resolve(null); }
  if (!force && b.contact_source === 'admin') {                                             // contact saisi par l'équipe : on n'y touche plus
    // Recherche forcée interrompue par un redémarrage : l'état « en recherche » bloquerait l'envoi pour toujours.
    if (b.discovery_status === 'pending') { q.run(`UPDATE brokers SET discovery_status = 'found' WHERE id = ? AND discovery_status = 'pending'`, b.id); setTimeout(() => tick(), 10); }
    return Promise.resolve(null);
  }
  running.add(b.id);
  q.run(`UPDATE brokers SET discovery_status = 'pending' WHERE id = ?`, b.id);
  // Le contact a pu être saisi par l'équipe pendant la recherche (PUT /api/admin/brokers/:id) : la fin de la recherche ne
  // l'écrase pas, ne le déclare pas « introuvable » et ne prévient personne. Chaque écriture n'a donc lieu que si le
  // contact est encore celui du départ, vérifié dans la même instruction (aucune saisie ne se glisse entre les deux).
  const unchanged = (sql, ...params) => q.run(`${sql} WHERE id = ? AND contact_email = ? AND contact_source IS ?`, ...params, b.id, b.contact_email, b.contact_source).changes > 0;
  return discover(b.domain)
    .then((r) => {
      const fresh = q.get('SELECT * FROM brokers WHERE id = ?', b.id);
      if (!fresh) return r;
      if (r.email) {
        if (unchanged(`UPDATE brokers SET contact_email = ?, contact_source = 'site', contact_page = ?, contact_verified = 0, discovery_status = 'found', discovered_at = ?`, r.email, r.page, now())) notify(b.id, `Contact trouvé sur ${fresh.name} (${r.email}) : la demande d’effacement part.`);
      } else if (unchanged(`UPDATE brokers SET discovery_status = 'not_found', discovered_at = ?`, now())) {
        notify(b.id, mailMode === 'smtp' ? `Aucune adresse publiée sur ${fresh.name} : notre équipe vérifie le contact avant l’envoi.` : `Aucune adresse publiée sur ${fresh.name} : la demande part vers l’adresse présumée ${fresh.contact_email}.`);
      }
      return r;
    })
    .catch((e) => {
      unchanged(`UPDATE brokers SET discovery_status = 'failed', discovered_at = ?`, now());
      console.error(`[sites] recherche du contact de ${b.domain} :`, e.message);
      return null;
    })
    .finally(() => { running.delete(b.id); setTimeout(() => tick(), 10); });
}
function notify(brokerId, message) {
  for (const r of q.all(`SELECT DISTINCT user_id, profile_id, id FROM requests WHERE broker_id = ? AND status = 'queued'`, brokerId)) logEvent(r.user_id, 'site', message, { profile_id: r.profile_id, request_id: r.id });
}
// Au démarrage : une recherche interrompue (redémarrage du serveur) est relancée.
export function resumeDiscoveries() {
  for (const b of q.all(`SELECT id FROM brokers WHERE custom = 1 AND discovery_status = 'pending'`)) runDiscovery(b.id);
}
export { registrableDomain };
