// Facturation : Stripe Checkout (API REST via fetch, sans SDK) ou mode simulé sans clé.
import crypto from 'node:crypto';
import { q, now, logEvent } from './db.js';

export const PLANS = {
  individuel: { name: 'Individuel', members: 1, monthly: 1299, annual: 8388 },   // centimes TTC ; annuel = 6,99 €/mois
  famille: { name: 'Famille', members: 5, monthly: 2499, annual: 16788 },      // annuel = 13,99 €/mois
};
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
export const billingMode = STRIPE_KEY ? 'stripe' : 'simulated';

async function stripe(method, path, params) {
  const body = params ? new URLSearchParams(flatten(params)).toString() : undefined;
  const r = await fetch(`https://api.stripe.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error?.message || `Stripe ${r.status}`);
  return data;
}
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object') flatten(v, key, out); else out[key] = String(v);
  }
  return out;
}

export async function startCheckout(user, plan, billing) {
  const p = PLANS[plan];
  if (!p || !['monthly', 'annual'].includes(billing)) throw new Error('Offre inconnue.');
  if (!STRIPE_KEY) {
    q.run(`UPDATE users SET plan = ?, billing = ?, subscription_status = 'active', billing_mode = 'simulated', subscription_ends_at = NULL WHERE id = ?`, plan, billing, user.id);
    logEvent(user.id, 'billing', `Abonnement ${p.name} (${billing === 'annual' ? 'annuel' : 'mensuel'}) activé en mode simulé.`);
    return { mode: 'simulated', url: `${APP_URL}/app/#dashboard` };
  }
  const session = await stripe('POST', '/checkout/sessions', {
    mode: 'subscription',
    client_reference_id: user.id,
    customer_email: user.email,
    success_url: `${APP_URL}/app/#billing-success`,
    cancel_url: `${APP_URL}/app/#billing`,
    locale: 'fr',
    metadata: { user_id: user.id, plan, billing },
    subscription_data: { metadata: { user_id: user.id, plan, billing } },
    line_items: { 0: { quantity: 1, price_data: {
      currency: 'eur', unit_amount: billing === 'annual' ? p.annual : p.monthly,
      recurring: { interval: billing === 'annual' ? 'year' : 'month' },
      product_data: { name: `Oubli ${p.name} — ${billing === 'annual' ? 'annuel' : 'mensuel'}` },
    } } },
  });
  q.run('UPDATE users SET plan = ?, billing = ? WHERE id = ?', plan, billing, user.id);
  return { mode: 'stripe', url: session.url };
}

export function verifyStripeSignature(rawBody, header) {
  if (!WEBHOOK_SECRET) return false;
  const parts = Object.fromEntries(String(header || '').split(',').map((kv) => kv.split('=')));
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${parts.t}.${rawBody}`).digest('hex');
  return expected.length === parts.v1.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

export function handleStripeEvent(event) {
  const o = event.data?.object || {};
  switch (event.type) {
    case 'checkout.session.completed': {
      const uid = o.client_reference_id || o.metadata?.user_id;
      if (!uid) return;
      q.run(`UPDATE users SET subscription_status = 'active', billing_mode = 'stripe', stripe_customer_id = ?, stripe_subscription_id = ?, plan = COALESCE(?, plan), billing = COALESCE(?, billing), subscription_ends_at = NULL WHERE id = ?`,
        o.customer || null, o.subscription || null, o.metadata?.plan || null, o.metadata?.billing || null, uid);
      logEvent(uid, 'billing', 'Paiement confirmé par Stripe : abonnement actif.');
      break;
    }
    case 'invoice.payment_failed': {
      const u = q.get('SELECT id FROM users WHERE stripe_customer_id = ?', o.customer);
      if (u) { q.run(`UPDATE users SET subscription_status = 'past_due' WHERE id = ?`, u.id); logEvent(u.id, 'billing', 'Échec de paiement : abonnement en attente de régularisation.'); }
      break;
    }
    case 'customer.subscription.deleted': {
      const u = q.get('SELECT id FROM users WHERE stripe_subscription_id = ? OR stripe_customer_id = ?', o.id, o.customer);
      if (u) { q.run(`UPDATE users SET subscription_status = 'canceled', subscription_ends_at = ? WHERE id = ?`, now(), u.id); logEvent(u.id, 'billing', 'Abonnement résilié.'); }
      break;
    }
    default: break;
  }
}

export async function cancelSubscription(user) {
  if (user.billing_mode === 'stripe' && user.stripe_subscription_id && STRIPE_KEY) {
    const sub = await stripe('POST', `/subscriptions/${user.stripe_subscription_id}`, { cancel_at_period_end: true });
    const ends = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
    q.run(`UPDATE users SET subscription_status = 'canceled', subscription_ends_at = ? WHERE id = ?`, ends, user.id);
    logEvent(user.id, 'billing', `Résiliation enregistrée ; accès maintenu jusqu'à la fin de la période payée.`);
    return { ends_at: ends };
  }
  q.run(`UPDATE users SET subscription_status = 'canceled', subscription_ends_at = ? WHERE id = ?`, now(), user.id);
  logEvent(user.id, 'billing', 'Abonnement résilié.');
  return { ends_at: now() };
}
