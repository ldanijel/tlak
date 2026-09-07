import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createApp } from './app.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || resolve(here, '../../data/tlak.db');
const STATIC_DIR = process.env.STATIC_DIR || resolve(here, '../../client/dist');
const ALLOW_REGISTRATION = (process.env.ALLOW_REGISTRATION ?? 'true') !== 'false';
const TRUST_PROXY = process.env.TRUST_PROXY ? (process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY) : false;
const INVITE_CODE = (process.env.INVITE_CODE || '').trim();

const db = openDb(DB_PATH);
const app = createApp(db, { allowRegistration: ALLOW_REGISTRATION, staticDir: STATIC_DIR, trustProxy: TRUST_PROXY, inviteCode: INVITE_CODE });

app.listen(PORT, HOST, () => {
  console.log(`Tlak poslužitelj: http://${HOST}:${PORT}  (baza: ${DB_PATH}, registracija: ${ALLOW_REGISTRATION ? (INVITE_CODE ? 'uz pozivni kod' : 'otvorena') : 'zatvorena'})`);
});
