import express from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { COLLECTIONS } from './db.js';
import { hashPassword, verifyPassword, createSession, requireAuth, rateLimiter } from './auth.js';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const MAX_RECORD_BYTES = 64 * 1024;
const PULL_LIMIT = 500;

export function createApp(db, options = {}) {
  const { allowRegistration = true, staticDir = null, trustProxy = false, inviteCode = '' } = options;
  const inviteOk = (given) => {
    if (!inviteCode) return true;
    const a = Buffer.from(String(given || '').trim().normalize('NFKC'));
    const b = Buffer.from(inviteCode.normalize('NFKC'));
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', trustProxy);
  app.use(express.json({ limit: '8mb' }));

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'DENY');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });

  const ipLimit = rateLimiter({ windowMs: 15 * 60e3, max: 30 });
  const emailLimit = rateLimiter({ windowMs: 15 * 60e3, max: 10 });
  const limited = (req, res, email) => {
    if (!ipLimit(req.ip) || (email && !emailLimit(email))) {
      res.status(429).json({ error: 'too_many_attempts' });
      return true;
    }
    return false;
  };

  const auth = requireAuth(db);
  const q = {
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    insertUser: db.prepare('INSERT INTO users (id, email, password_hash, rev, created_at) VALUES (?, ?, ?, 0, ?)'),
    updatePassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    deleteUser: db.prepare('DELETE FROM users WHERE id = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?'),
    deleteOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?'),
    listSessions: db.prepare('SELECT id, device_name, created_at, last_seen_at FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC'),
    getRecord: db.prepare('SELECT updated_at, rev FROM records WHERE user_id = ? AND collection = ? AND id = ?'),
    upsertRecord: db.prepare(
      `INSERT INTO records (user_id, collection, id, data, updated_at, deleted, rev) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at,
       deleted = excluded.deleted, rev = excluded.rev`,
    ),
    bumpRev: db.prepare('UPDATE users SET rev = rev + 1 WHERE id = ? RETURNING rev'),
    pull: db.prepare(
      `SELECT collection, id, data, updated_at, deleted, rev FROM records
        WHERE user_id = ? AND rev > ? ORDER BY rev LIMIT ?`,
    ),
    countRecords: db.prepare('SELECT collection, COUNT(*) AS n FROM records WHERE user_id = ? AND deleted = 0 GROUP BY collection'),
  };

  const normEmail = (e) => String(e || '').trim().toLowerCase();
  const validCredentials = (email, password) =>
    EMAIL_RE.test(email) && typeof password === 'string' && password.length >= 8 && password.length <= 200;

  app.get('/api/health', (req, res) => res.json({ ok: true, registration: allowRegistration, inviteRequired: !!inviteCode }));

  app.post('/api/auth/register', async (req, res) => {
    if (!allowRegistration) return res.status(403).json({ error: 'registration_disabled' });
    const email = normEmail(req.body?.email);
    const { password, deviceName, inviteCode: given } = req.body || {};
    if (limited(req, res, email)) return;
    if (!inviteOk(given)) return res.status(403).json({ error: 'bad_invite_code' });
    if (!validCredentials(email, password)) return res.status(400).json({ error: 'invalid_credentials_format' });
    if (q.userByEmail.get(email)) return res.status(409).json({ error: 'email_taken' });
    const id = randomUUID();
    q.insertUser.run(id, email, await hashPassword(password), new Date().toISOString());
    const session = createSession(db, id, deviceName);
    res.status(201).json({ token: session.token, sessionId: session.sessionId, user: { id, email } });
  });

  app.post('/api/auth/login', async (req, res) => {
    const email = normEmail(req.body?.email);
    const { password, deviceName } = req.body || {};
    if (limited(req, res, email)) return;
    const user = q.userByEmail.get(email);
    const ok = user && typeof password === 'string' && (await verifyPassword(password, user.password_hash));
    if (!ok) return res.status(401).json({ error: 'bad_credentials' });
    const session = createSession(db, user.id, deviceName);
    res.json({ token: session.token, sessionId: session.sessionId, user: { id: user.id, email: user.email } });
  });

  app.post('/api/auth/logout', auth, (req, res) => {
    q.deleteSession.run(req.session.id, req.user.id);
    res.json({ ok: true });
  });

  app.get('/api/auth/me', auth, (req, res) => {
    const counts = Object.fromEntries(q.countRecords.all(req.user.id).map((r) => [r.collection, r.n]));
    res.json({
      user: { id: req.user.id, email: req.user.email },
      rev: req.user.rev,
      sessionId: req.session.id,
      sessions: q.listSessions.all(req.user.id).map((s) => ({
        id: s.id, deviceName: s.device_name, createdAt: s.created_at, lastSeenAt: s.last_seen_at, current: s.id === req.session.id,
      })),
      counts,
    });
  });

  app.delete('/api/auth/sessions/:id', auth, (req, res) => {
    q.deleteSession.run(req.params.id, req.user.id);
    res.json({ ok: true });
  });

  app.post('/api/auth/password', auth, async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    const user = q.userById.get(req.user.id);
    if (!(await verifyPassword(String(currentPassword || ''), user.password_hash))) {
      return res.status(401).json({ error: 'bad_credentials' });
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 200) {
      return res.status(400).json({ error: 'invalid_credentials_format' });
    }
    q.updatePassword.run(await hashPassword(newPassword), user.id);
    q.deleteOtherSessions.run(user.id, req.session.id);
    res.json({ ok: true });
  });

  app.delete('/api/auth/account', auth, async (req, res) => {
    const user = q.userById.get(req.user.id);
    if (!(await verifyPassword(String(req.body?.password || ''), user.password_hash))) {
      return res.status(401).json({ error: 'bad_credentials' });
    }
    q.deleteUser.run(user.id);
    res.json({ ok: true });
  });

  /**
   * Sinkronizacija: klijent šalje lokalne promjene i zadnji poznati rev.
   * Sukobi se rješavaju po pravilu "zadnja izmjena pobjeđuje" (updatedAt, ISO UTC).
   */
  app.post('/api/sync', auth, (req, res) => {
    const since = Number.isInteger(req.body?.since) && req.body.since >= 0 ? req.body.since : 0;
    const changes = Array.isArray(req.body?.changes) ? req.body.changes : [];
    if (changes.length > 2000) return res.status(413).json({ error: 'too_many_changes' });

    const applied = [];
    const rejected = [];
    // node:sqlite nema helper za transakcije; koristimo BEGIN/COMMIT ručno.
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const c of changes) {
        if (!COLLECTIONS.includes(c?.collection) || typeof c?.id !== 'string' || c.id.length > 64) {
          rejected.push({ collection: c?.collection, id: c?.id, reason: 'invalid' });
          continue;
        }
        const updatedAt = typeof c.updatedAt === 'string' && !Number.isNaN(Date.parse(c.updatedAt)) ? c.updatedAt : null;
        if (!updatedAt) { rejected.push({ collection: c.collection, id: c.id, reason: 'invalid_updatedAt' }); continue; }
        const data = JSON.stringify(c.data ?? {});
        if (data.length > MAX_RECORD_BYTES) { rejected.push({ collection: c.collection, id: c.id, reason: 'too_large' }); continue; }
        const existing = q.getRecord.get(req.user.id, c.collection, c.id);
        if (existing && existing.updated_at >= updatedAt) {
          rejected.push({ collection: c.collection, id: c.id, reason: 'stale' });
          continue;
        }
        const { rev } = q.bumpRev.get(req.user.id);
        q.upsertRecord.run(req.user.id, c.collection, c.id, data, updatedAt, c.deleted ? 1 : 0, rev);
        applied.push({ collection: c.collection, id: c.id, rev });
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    const rows = q.pull.all(req.user.id, since, PULL_LIMIT + 1);
    const more = rows.length > PULL_LIMIT;
    const page = more ? rows.slice(0, PULL_LIMIT) : rows;
    const currentRev = q.userById.get(req.user.id).rev;
    res.json({
      rev: more ? page[page.length - 1].rev : currentRev,
      more,
      applied,
      rejected,
      changes: page.map((r) => ({
        collection: r.collection, id: r.id, data: JSON.parse(r.data), updatedAt: r.updated_at, deleted: !!r.deleted, rev: r.rev,
      })),
    });
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));

  if (staticDir && existsSync(staticDir)) {
    app.use(
      express.static(staticDir, {
        index: false,
        setHeaders(res, path) {
          if (/[\\/]assets[\\/]/.test(path)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
          else res.set('Cache-Control', 'no-cache');
        },
      }),
    );
    app.get('/{*splat}', (req, res) => res.sendFile(join(staticDir, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } }));
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
      return res.status(400).json({ error: 'bad_request' });
    }
    console.error(err);
    res.status(500).json({ error: 'server_error' });
  });

  return app;
}
