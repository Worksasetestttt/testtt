// Routeur d'administration, monté sur /api/admin derrière requireAuth + requireAdmin (voir routes.js).
import express from 'express';
import { q } from './db.js';
import { applyOutcome, tick } from './scheduler.js';
import { clean, wrap } from './util.js';

export const admin = express.Router();

admin.get('/stats', (_req, res) => res.json({
  users: q.get('SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL').c,
  active: q.get(`SELECT COUNT(*) AS c FROM users WHERE subscription_status = 'active'`).c,
  requests: q.all('SELECT status, COUNT(*) AS n FROM requests GROUP BY status'),
  mails: q.get('SELECT COUNT(*) AS c FROM mails').c,
  action_required: q.all(`SELECT r.id, r.token, b.name AS broker, u.email FROM requests r JOIN brokers b ON b.id = r.broker_id JOIN users u ON u.id = r.user_id WHERE r.status = 'action_required' ORDER BY r.created_at LIMIT 100`),
}));
admin.post('/requests/:id/outcome', wrap(async (req, res) => {
  const r = q.get('SELECT * FROM requests WHERE id = ? OR token = ?', req.params.id, req.params.id);
  if (!r) return res.status(404).json({ error: 'Demande introuvable.' });
  if (!['done', 'in_progress', 'action_required', 'refused'].includes(req.body.outcome)) return res.status(400).json({ error: 'Résultat inconnu.' });
  await applyOutcome(r, req.body.outcome, clean(req.body.note, 300));
  res.json({ ok: true });
}));
admin.put('/brokers/:id', (req, res) => {
  const b = q.get('SELECT * FROM brokers WHERE id = ?', req.params.id);
  if (!b) return res.status(404).json({ error: 'Courtier introuvable.' });
  q.run('UPDATE brokers SET contact_email = ?, contact_verified = ?, active = ? WHERE id = ?', clean(req.body.contact_email ?? b.contact_email, 160), req.body.contact_verified ? 1 : 0, req.body.active === false ? 0 : 1, b.id);
  res.json({ broker: q.get('SELECT * FROM brokers WHERE id = ?', b.id) });
});
admin.post('/tick', wrap(async (_req, res) => { await tick(); res.json({ ok: true }); }));
