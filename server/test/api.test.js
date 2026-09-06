import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';

async function start() {
  const db = openDb(':memory:');
  const app = createApp(db, { allowRegistration: true });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, close: () => server.close() };
}

test('registracija, prijava i sinkronizacija između dva uređaja', async () => {
  const { call, close } = await start();
  try {
    const reg = await call('POST', '/api/auth/register', { email: 'Ana@Example.com', password: 'lozinka123', deviceName: 'iPhone' });
    assert.equal(reg.status, 201);
    const tokenA = reg.body.token;

    const dup = await call('POST', '/api/auth/register', { email: 'ana@example.com', password: 'lozinka123' });
    assert.equal(dup.status, 409);

    const bad = await call('POST', '/api/auth/login', { email: 'ana@example.com', password: 'kriva' });
    assert.equal(bad.status, 401);

    const login = await call('POST', '/api/auth/login', { email: 'ana@example.com', password: 'lozinka123', deviceName: 'Mac' });
    assert.equal(login.status, 200);
    const tokenB = login.body.token;

    const push = await call('POST', '/api/sync', {
      since: 0,
      changes: [{ collection: 'measurements', id: 'm1', data: { systolic: 120, diastolic: 80, pulse: 70 }, updatedAt: '2026-09-06T10:00:00.000Z' }],
    }, tokenA);
    assert.equal(push.status, 200);
    assert.equal(push.body.applied.length, 1);
    assert.equal(push.body.rev, 1);

    const pullB = await call('POST', '/api/sync', { since: 0, changes: [] }, tokenB);
    assert.equal(pullB.body.changes.length, 1);
    assert.equal(pullB.body.changes[0].data.systolic, 120);

    // Stara izmjena s uređaja B ne smije pregaziti noviju.
    const stale = await call('POST', '/api/sync', {
      since: 1,
      changes: [{ collection: 'measurements', id: 'm1', data: { systolic: 999 }, updatedAt: '2026-09-06T09:00:00.000Z' }],
    }, tokenB);
    assert.equal(stale.body.rejected[0].reason, 'stale');

    // Brisanje s uređaja B stiže na A.
    const del = await call('POST', '/api/sync', {
      since: 1,
      changes: [{ collection: 'measurements', id: 'm1', deleted: true, updatedAt: '2026-09-06T11:00:00.000Z' }],
    }, tokenB);
    assert.equal(del.body.applied.length, 1);
    const pullA = await call('POST', '/api/sync', { since: 1, changes: [] }, tokenA);
    assert.equal(pullA.body.changes[0].deleted, true);

    const bogus = await call('POST', '/api/sync', { since: 0, changes: [{ collection: 'x', id: '1', data: {}, updatedAt: '2026-01-01T00:00:00Z' }] }, tokenA);
    assert.equal(bogus.body.rejected[0].reason, 'invalid');

    const me = await call('GET', '/api/auth/me', null, tokenA);
    assert.equal(me.body.sessions.length, 2);

    const noauth = await call('GET', '/api/auth/me');
    assert.equal(noauth.status, 401);

    const pw = await call('POST', '/api/auth/password', { currentPassword: 'lozinka123', newPassword: 'novalozinka1' }, tokenA);
    assert.equal(pw.status, 200);
    const afterPw = await call('GET', '/api/auth/me', null, tokenB);
    assert.equal(afterPw.status, 401, 'promjena lozinke odjavljuje ostale uređaje');

    const delAcc = await call('DELETE', '/api/auth/account', { password: 'novalozinka1' }, tokenA);
    assert.equal(delAcc.status, 200);
    assert.equal((await call('GET', '/api/auth/me', null, tokenA)).status, 401);
  } finally {
    close();
  }
});
