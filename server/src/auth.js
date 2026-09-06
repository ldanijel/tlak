import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const TOKEN_TTL_DAYS = 180;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${Buffer.from(key).toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [algo, n, saltB64, keyB64] = stored.split('$');
    if (algo !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scrypt(password.normalize('NFKC'), salt, expected.length, { ...SCRYPT, N: Number(n) });
    return timingSafeEqual(Buffer.from(key), expected);
  } catch {
    return false;
  }
}

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(db, userId, deviceName) {
  const token = newToken();
  const now = new Date();
  const expires = new Date(now.getTime() + TOKEN_TTL_DAYS * 86400e3);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, device_name, created_at, last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, hashToken(token), (deviceName || '').slice(0, 120), now.toISOString(), now.toISOString(), expires.toISOString());
  return { token, sessionId: id, expiresAt: expires.toISOString() };
}

/** Express middleware: postavlja req.user i req.session ili vraća 401. */
export function requireAuth(db) {
  const find = db.prepare(
    `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, u.id AS user_id, u.email, u.rev
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  );
  const touch = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?');
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) return res.status(401).json({ error: 'unauthorized' });
    const row = find.get(hashToken(token));
    if (!row || row.expires_at < new Date().toISOString()) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const now = new Date().toISOString();
    if (row.last_seen_at.slice(0, 13) !== now.slice(0, 13)) touch.run(now, row.session_id);
    req.user = { id: row.user_id, email: row.email, rev: row.rev };
    req.session = { id: row.session_id };
    next();
  };
}

/** Jednostavno ograničenje broja pokušaja (u memoriji, po ključu). */
export function rateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.reset < now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    }
    return entry.count <= max;
  };
}
