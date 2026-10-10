// Facturation : Stripe Checkout (API REST via fetch, sans SDK) ou mode simulé quand STRIPE_SECRET_KEY est absent.
// Les webhooks sont vérifiés (signature HMAC, tolérance 5 min), traités une seule fois (table stripe_events) et
// l’utilisateur est retrouvé par ses identifiants Stripe (client / abonnement) plutôt que par les métadonnées ;
// les événements d’un ancien abonnement du même client (réabonnement après résiliation) sont ignorés, de même que ceux
// qui sont plus anciens que la dernière information appliquée au compte (webhook livré en retard).
import crypto from 'node:crypto';
import { q, now, logEvent, tx, ensureColumn } from './db.js';
import { HttpError } from './util.js';

// Formule unique, mensuelle et sans engagement (centimes TTC). L'offre annuelle n'est plus proposée ; les comptes
// encore marqués « annual » (anciens abonnés) sont acceptés partout en lecture.
export const PLANS = {
  individuel: { name: 'Individuel', members: 1, monthly: 500 },
  famille: { name: 'Famille', members: 5, monthly: 999 },
};
export const BILLING_PERIODS = ['monthly'];
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
// Adresse de l'API (STRIPE_API_BASE) : l'API réelle par défaut, un faux serveur Stripe dans scripts/billing.test.mjs.
// La clé secrète part dans chaque requête : https obligatoire en production.
const STRIPE_API = ((process.env.STRIPE_API_BASE || '').trim() || 'https://api.stripe.com/v1').replace(/\/+$/, '');
const TOLERANCE_S = 300;
export const billingMode = STRIPE_KEY ? 'stripe' : 'simulated';
if (!STRIPE_KEY && process.env.NODE_ENV === 'production') console.warn('[billing] STRIPE_SECRET_KEY absent : abonnements simulés, activés sans paiement.');
if (STRIPE_KEY && !WEBHOOK_SECRET) console.warn('[billing] STRIPE_WEBHOOK_SECRET absent : les webhooks Stripe seront rejetés.');
if (STRIPE_KEY && process.env.NODE_ENV === 'production' && !/^https:\/\//i.test(STRIPE_API)) {
  console.error('[billing] STRIPE_API_BASE doit commencer par https:// en production (la clé secrète part dans chaque requête). Arrêt.');
  process.exit(1);
}
// Date Stripe (secondes Unix) de la dernière information appliquée au compte : event.created du dernier webhook
// appliqué, ou en-tête Date de la réponse de l'API après une action de l'abonné (reprise, résiliation). Un webhook plus
// ancien, quel que soit son identifiant, est ignoré : livré en retard, il défaisait un état plus récent.
ensureColumn('users', 'stripe_event_created', 'INTEGER');

// Paramètres form-urlencoded : dans l'adresse pour un GET (sans corps), dans le corps sinon. Une erreur porte le statut
// HTTP de Stripe (stripeStatus) : 404 = objet inconnu de Stripe.
async function stripe(method, path, params, idempotencyKey) {
  const headers = { Authorization: `Bearer ${STRIPE_KEY}` };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const form = params ? new URLSearchParams(flatten(params)).toString() : '';
  const query = method === 'GET' && form ? `?${form}` : '';
  if (form && !query) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const r = await fetch(`${STRIPE_API}${path}${query}`, { method, headers, body: form && !query ? form : undefined, signal: AbortSignal.timeout(20000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error?.message || `Stripe ${r.status}`), { stripeStatus: r.status });
  const at = Math.floor(Date.parse(r.headers.get('date') || '') / 1000);
  if (Number.isSafeInteger(at) && at > 0 && data && typeof data === 'object') answeredAt.set(data, at);
  return data;
}
// Réponse de l'API → sa date selon Stripe (en-tête Date), même horloge que event.created des webhooks.
const answeredAt = new WeakMap();
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object') flatten(v, key, out); else if (v !== undefined) out[key] = String(v);
  }
  return out;
}
const sid = (v) => (typeof v === 'string' ? v : (v && typeof v === 'object' && typeof v.id === 'string' ? v.id : null));
const iso = (s) => (Number.isFinite(Number(s)) && Number(s) > 0 ? new Date(Number(s) * 1000).toISOString() : null);
const label = (plan, billing) => `${PLANS[plan]?.name || plan} (${billing === 'annual' ? 'annuel' : 'mensuel'})`;
const NB = '\u00a0';
const longDate = (s) => new Date(s).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

export async function startCheckout(user, plan, billing) {
  const p = Object.hasOwn(PLANS, plan) ? PLANS[plan] : null;
  if (!p || !BILLING_PERIODS.includes(billing)) throw new Error('Offre inconnue.');
  if (!user || user.deleted_at) throw new Error('Compte introuvable.');
  // Offre trop petite pour le dossier : les proches en trop resteraient protégés sans être couverts par l'abonnement.
  const n = q.get('SELECT COUNT(*) AS c FROM profiles WHERE user_id = ?', user.id).c;
  if (n > p.members) throw new HttpError(409, `Votre dossier protège ${n} personnes : l’offre ${p.name} en couvre ${p.members === 1 ? 'une seule' : p.members}. Retirez d’abord ${n - p.members === 1 ? 'un proche' : `${n - p.members} proches`} depuis la page Dossier.`);
  if (!STRIPE_KEY) {
    q.run(`UPDATE users SET plan = ?, billing = ?, subscription_status = 'active', billing_mode = 'simulated', subscription_ends_at = NULL WHERE id = ?`, plan, billing, user.id);
    logEvent(user.id, 'billing', `Abonnement ${label(plan, billing)} activé en mode simulé.`);
    return { mode: 'simulated', url: `${APP_URL}/app/#dashboard` };
  }
  if (user.subscription_status === 'active' && user.billing_mode === 'stripe' && user.stripe_subscription_id) throw new HttpError(409, 'Un abonnement est déjà actif sur ce compte : résiliez-le avant d’en souscrire un autre.');
  // Abonnement Stripe rattaché au compte (résilié en fin de période, impayé, relayé par une clé) : repris s'il court
  // encore, jamais doublé d'un second abonnement qui ferait payer deux fois la même période.
  if (user.stripe_subscription_id) {
    const resumed = await resumeSubscription(user, plan);
    if (resumed) return resumed;
  }
  const session = await stripe('POST', '/checkout/sessions', {
    mode: 'subscription',
    client_reference_id: user.id,
    ...(user.stripe_customer_id ? { customer: user.stripe_customer_id } : { customer_email: user.email }),
    success_url: `${APP_URL}/app/#billing-success`,
    cancel_url: `${APP_URL}/app/#billing`,
    locale: 'fr',
    metadata: { user_id: user.id, plan, billing },
    subscription_data: { metadata: { user_id: user.id, plan, billing } },
    line_items: { 0: { quantity: 1, price_data: {
      currency: 'eur', unit_amount: p.monthly,
      recurring: { interval: 'month' },
      product_data: { name: `Oubli ${p.name}` },
    } } },
  }, crypto.randomUUID());
  // Offre retenue avant le paiement seulement pour un compte sans aucun accès. Pendant un abonnement en cours (clé,
  // équipe) ou une période déjà payée après résiliation, l'abonné garderait sinon l'offre choisie (Famille, 5 profils)
  // en abandonnant le paiement. Le webhook pose l'offre payée (métadonnées).
  const access = user.subscription_status === 'active' || (user.subscription_status === 'canceled' && !!user.subscription_ends_at && user.subscription_ends_at > now());
  if (!access) q.run('UPDATE users SET plan = ?, billing = ? WHERE id = ?', plan, billing, user.id);
  return { mode: 'stripe', url: session.url };
}

// Reprise d'un abonnement Stripe qui court encore : même offre → la résiliation est annulée (cancel_at_period_end=false),
// sans nouveau paiement ; autre offre → l'abonnement change de prix au prorata (supplément ou avoir sur la prochaine
// facture). Retourne null si l'abonnement est terminé ou inconnu de Stripe : une nouvelle session est alors créée. Toute
// autre erreur est propagée (502) : sans réponse de Stripe, impossible de savoir si l'ancien abonnement court encore.
async function resumeSubscription(user, plan) {
  const path = `/subscriptions/${encodeURIComponent(user.stripe_subscription_id)}`;
  let sub;
  try { sub = await stripe('GET', path); } catch (e) { if (e.stripeStatus === 404) return null; throw e; }
  if (['canceled', 'incomplete_expired'].includes(sub.status)) return null;
  if (!['active', 'trialing'].includes(sub.status)) throw new HttpError(409, `Un paiement de votre abonnement est en attente de régularisation${NB}: Stripe retente le prélèvement automatiquement. Pour changer de carte ou d’offre en attendant, écrivez au support.`);
  const item = sub.items?.data?.[0];
  const periodEnd = iso(sub.current_period_end || item?.current_period_end) || user.subscription_ends_at;
  // Ancienne formule annuelle : plus vendue, elle n'est ni renouvelée ni convertie en cours de période.
  if ((item?.price?.recurring?.interval || sub.plan?.interval) === 'year') throw new HttpError(409, `Votre ancienne formule annuelle reste payée${periodEnd ? ` jusqu’au ${longDate(periodEnd)}` : ''}${NB}: elle n’est plus proposée et ne peut pas être reprise. L’abonnement mensuel pourra être souscrit à cette date.`);
  const current = Object.hasOwn(PLANS, sub.metadata?.plan ?? '') ? sub.metadata.plan : user.plan;
  const switched = current !== plan;
  if (switched && !item?.id) throw new Error('Abonnement Stripe sans ligne : changement d’offre impossible.');
  const params = { cancel_at_period_end: false };
  if (switched) Object.assign(params, { proration_behavior: 'create_prorations', items: { 0: { id: item.id, price: await planPrice(plan) } }, metadata: { user_id: user.id, plan, billing: 'monthly' } });
  const updated = await stripe('POST', path, params, crypto.randomUUID());
  applySnapshot(updated);
  if (switched) logEvent(user.id, 'billing', `Offre ${PLANS[plan].name} choisie${NB}: la différence au prorata figurera sur la prochaine facture.`);
  const next = iso(updated.current_period_end || updated.items?.data?.[0]?.current_period_end) || periodEnd;
  const lead = sub.cancel_at_period_end || sub.cancel_at ? 'Résiliation annulée' : 'Abonnement repris';
  return {
    mode: 'resumed', plan, switched,
    message: switched
      ? `${lead}, offre ${PLANS[plan].name} active dès maintenant${NB}: la différence au prorata (supplément ou avoir) figurera sur votre prochaine facture${next ? `, le ${longDate(next)}` : ''}.`
      : `${lead}${NB}: votre abonnement ${PLANS[plan].name} continue, sans nouveau paiement.${next ? ` Prochain prélèvement le ${longDate(next)}.` : ''}`,
  };
}
// Prix mensuel d'une offre chez Stripe, nécessaire pour changer l'offre d'un abonnement (l'API des abonnements, à la
// différence de Checkout, n'accepte pas de produit décrit en ligne) : retrouvé par sa clé de recherche (offre et montant),
// créé au besoin, puis gardé en mémoire.
const planPrices = new Map();
async function planPrice(plan) {
  const p = PLANS[plan], key = `oubli_${plan}_${p.monthly}_eur_month`;
  if (planPrices.has(key)) return planPrices.get(key);
  const found = await stripe('GET', '/prices', { active: true, limit: 1, lookup_keys: [key] });
  const id = sid(found.data?.[0]) || sid(await stripe('POST', '/prices', {
    currency: 'eur', unit_amount: p.monthly, recurring: { interval: 'month' }, lookup_key: key, transfer_lookup_key: true,
    product_data: { name: `Oubli ${p.name}` }, metadata: { plan },
  }, crypto.randomUUID()));
  if (!id) throw new Error('Prix Stripe introuvable.');
  planPrices.set(key, id);
  return id;
}
// Abonnement relu dans une réponse de l'API après une action de l'abonné : même traduction qu'un webhook
// customer.subscription.updated (statut, fin d'accès, offre des métadonnées), daté de la réponse.
function applySnapshot(sub) {
  tx(() => apply({ type: 'customer.subscription.updated', created: answeredAt.get(sub) ?? null, data: { object: sub } }));
}

// En-tête Stripe-Signature : t=<horodatage>,v1=<hmac>[,v1=<hmac>…]. Comparaison en temps constant, tolérance 5 minutes.
export function verifyStripeSignature(rawBody, header, secret = WEBHOOK_SECRET, nowMs = Date.now()) {
  if (!secret || rawBody === undefined || rawBody === null) return false;
  const parts = String(header || '').split(',').map((kv) => { const i = kv.indexOf('='); return i > 0 ? [kv.slice(0, i).trim(), kv.slice(i + 1).trim()] : null; }).filter(Boolean);
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!/^\d{1,12}$/.test(t || '') || !sigs.length) return false;
  if (Math.abs(nowMs / 1000 - Number(t)) > TOLERANCE_S) return false;
  const h = crypto.createHmac('sha256', secret); h.update(`${t}.`); h.update(rawBody);
  const expected = Buffer.from(h.digest('hex'));
  return sigs.some((s) => { const b = Buffer.from(s); return b.length === expected.length && crypto.timingSafeEqual(b, expected); });
}

// Retrouve l’abonné par ses identifiants Stripe ; les métadonnées (posées par nous à la création de la session) ne
// servent qu’en secours, et seulement si elles ne contredisent pas les identifiants déjà rattachés au compte.
function userByIds(customer, subscription) {
  const c = sid(customer), s = sid(subscription);
  if (s) { const u = q.get('SELECT * FROM users WHERE stripe_subscription_id = ? AND deleted_at IS NULL', s); if (u) return u; }
  if (c) { const u = q.get('SELECT * FROM users WHERE stripe_customer_id = ? AND deleted_at IS NULL', c); if (u) return u; }
  return null;
}
function userByMetadata(uid, customer) {
  if (typeof uid !== 'string' || !uid) return null;
  const u = q.get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', uid);
  if (!u) return null;
  const c = sid(customer);
  if (u.stripe_customer_id && c && u.stripe_customer_id !== c) return null;
  return u;
}

// Abonnement offert par clé en cours (keys.js) : un événement tardif sur un ancien abonnement payé (résiliation, impayé)
// ne l’écrase pas. Seul un abonnement payé redevenu actif le remplace (l’abonné a choisi de payer).
const keyRunning = (u) => u.billing_mode === 'key' && u.subscription_status === 'active' && !!u.subscription_ends_at && u.subscription_ends_at > now();
// Événement d'un autre abonnement que celui du compte (réabonnement après résiliation : même client Stripe, ancien
// abonnement encore en fin de période) : ignoré, sinon la fin de l'ancien abonnement résilierait le nouveau.
const staleSub = (u, subscription) => { const s = sid(subscription); return !!(s && u.stripe_subscription_id && u.stripe_subscription_id !== s); };
// Abonnement d'une facture : champ subscription, ou parent.subscription_details.subscription (format récent de l'API).
const invoiceSub = (o) => o.subscription || o.parent?.subscription_details?.subscription || null;

// Date de l'événement (event.created, secondes) ; null si absente : l'événement s'applique alors sans comparaison.
const eventTime = (e) => (Number.isSafeInteger(e?.created) && e.created > 0 ? e.created : null);
// La date de la dernière information appliquée ne recule jamais.
function touch(userId, at) {
  if (at) q.run('UPDATE users SET stripe_event_created = ? WHERE id = ? AND (stripe_event_created IS NULL OR stripe_event_created < ?)', at, userId, at);
}
// Un événement pris en compte (même sans effet, ou écarté par la garde de la clé) fait avancer la date du compte : ce
// qu'il annonce est plus récent que tout événement plus ancien qui arriverait ensuite.
function setStatus(u, status, ends, message, extra = {}) {
  touch(u.id, extra.at);
  if (status !== 'active' && keyRunning(u)) return;
  const changed = status !== u.subscription_status || (ends || null) !== (u.subscription_ends_at || null);
  q.run(`UPDATE users SET subscription_status = ?, subscription_ends_at = ?, billing_mode = 'stripe', stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = COALESCE(?, stripe_subscription_id), plan = COALESCE(?, plan), billing = COALESCE(?, billing) WHERE id = ?`,
    status, ends || null, extra.customer || null, extra.subscription || null, extra.plan || null, extra.billing || null, u.id);
  if (changed && message) logEvent(u.id, 'billing', message);
}

function apply(event) {
  const o = event.data?.object || {};
  const at = eventTime(event);
  // Plus ancien que la dernière information appliquée au compte (même seconde : appliqué).
  const late = (u) => at !== null && u.stripe_event_created != null && at < u.stripe_event_created;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      if (o.mode && o.mode !== 'subscription') return;
      if (o.payment_status && !['paid', 'no_payment_required'].includes(o.payment_status)) return; // paiement différé : on attend async_payment_succeeded
      const u = userByIds(o.customer, o.subscription) || userByMetadata(o.client_reference_id || o.metadata?.user_id, o.customer);
      if (!u || late(u)) return;
      const plan = Object.hasOwn(PLANS, o.metadata?.plan ?? '') ? o.metadata.plan : null;
      const billing = ['monthly', 'annual'].includes(o.metadata?.billing) ? o.metadata.billing : null;
      setStatus(u, 'active', null, 'Paiement confirmé par Stripe : abonnement actif.', { customer: sid(o.customer), subscription: sid(o.subscription), plan, billing, at });
      return;
    }
    case 'checkout.session.async_payment_failed': {
      const u = userByIds(o.customer, o.subscription) || userByMetadata(o.client_reference_id || o.metadata?.user_id, o.customer);
      if (u) logEvent(u.id, 'billing', 'Paiement refusé par la banque : l’abonnement n’a pas été activé.');
      return;
    }
    case 'invoice.payment_failed': {
      const u = userByIds(o.customer, invoiceSub(o));
      if (u && !staleSub(u, invoiceSub(o)) && !late(u) && u.subscription_status !== 'canceled') setStatus(u, 'past_due', u.subscription_ends_at, 'Échec de paiement : abonnement en attente de régularisation.', { at });
      return;
    }
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const u = userByIds(o.customer, invoiceSub(o));
      if (u && !staleSub(u, invoiceSub(o)) && !late(u) && u.subscription_status === 'past_due') setStatus(u, 'active', null, 'Paiement régularisé : abonnement de nouveau actif.', { at });
      return;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const u = userByIds(o.customer, o.id) || userByMetadata(o.metadata?.user_id, o.customer);
      if (!u || staleSub(u, o.id) || late(u)) return;
      const periodEnd = o.current_period_end || o.items?.data?.[0]?.current_period_end || null;
      const interval = o.items?.data?.[0]?.price?.recurring?.interval || o.plan?.interval || null;
      const extra = { customer: sid(o.customer), subscription: sid(o.id), plan: Object.hasOwn(PLANS, o.metadata?.plan ?? '') ? o.metadata.plan : null, billing: interval === 'year' ? 'annual' : interval === 'month' ? 'monthly' : null, at };
      switch (o.status) {
        case 'active': case 'trialing':
          if (o.cancel_at_period_end) setStatus(u, 'canceled', iso(o.cancel_at) || iso(periodEnd), 'Résiliation enregistrée ; accès maintenu jusqu’à la fin de la période payée.', extra);
          else setStatus(u, 'active', null, u.subscription_status === 'canceled' ? 'Résiliation annulée : abonnement de nouveau actif.' : 'Abonnement actif.', extra);
          return;
        case 'past_due': case 'unpaid':
          setStatus(u, 'past_due', u.subscription_ends_at, 'Échec de paiement : abonnement en attente de régularisation.', extra);
          return;
        case 'canceled': case 'incomplete_expired':
          setStatus(u, 'canceled', iso(o.ended_at) || iso(o.canceled_at) || now(), 'Abonnement résilié.', extra);
          return;
        default: return; // incomplete, paused : rien à changer
      }
    }
    case 'customer.subscription.deleted': {
      const u = userByIds(o.customer, o.id);
      if (u && !staleSub(u, o.id) && !late(u)) setStatus(u, 'canceled', iso(o.ended_at) || now(), 'Abonnement résilié.', { at });
      return;
    }
    default: return;
  }
}

// Traite un événement Stripe une seule fois : un identifiant déjà vu (webhook rejoué) est ignoré.
export function handleStripeEvent(event) {
  if (!event || typeof event !== 'object' || typeof event.type !== 'string') throw new Error('Événement invalide.');
  if (typeof event.id !== 'string' || !/^evt_[A-Za-z0-9_]{1,200}$/.test(event.id)) throw new Error('Identifiant d’événement manquant.');
  return tx(() => {
    const ins = q.run('INSERT OR IGNORE INTO stripe_events (id, type, created_at) VALUES (?, ?, ?)', event.id, event.type, now());
    if (!ins.changes) return { duplicate: true, type: event.type };
    apply(event);
    return { duplicate: false, type: event.type };
  });
}

export async function cancelSubscription(user) {
  if (user.subscription_status === 'none') return { ends_at: null };
  if (user.billing_mode === 'stripe' && user.stripe_subscription_id && STRIPE_KEY) {
    const sub = await stripe('POST', `/subscriptions/${user.stripe_subscription_id}`, { cancel_at_period_end: true });
    const ends = iso(sub.cancel_at) || iso(sub.current_period_end) || iso(sub.items?.data?.[0]?.current_period_end) || user.subscription_ends_at || null;
    q.run(`UPDATE users SET subscription_status = 'canceled', subscription_ends_at = ? WHERE id = ?`, ends, user.id);
    touch(user.id, answeredAt.get(sub));   // un webhook antérieur à la résiliation, livré ensuite, ne la défait pas
    if (user.subscription_status !== 'canceled') logEvent(user.id, 'billing', 'Résiliation enregistrée ; accès maintenu jusqu’à la fin de la période payée.');
    return { ends_at: ends };
  }
  const ends = user.subscription_status === 'canceled' && user.subscription_ends_at ? user.subscription_ends_at : now();
  q.run(`UPDATE users SET subscription_status = 'canceled', subscription_ends_at = ? WHERE id = ?`, ends, user.id);
  if (user.subscription_status !== 'canceled') logEvent(user.id, 'billing', 'Abonnement résilié.');
  return { ends_at: ends };
}
