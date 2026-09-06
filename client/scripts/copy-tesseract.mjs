// Kopira Tesseract.js worker i WASM jezgru u public/tesseract kako bi se OCR
// isporučivao zajedno s aplikacijom (bez učitavanja s CDN-a treće strane).
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'public', 'tesseract');
const coreOut = join(out, 'core');
mkdirSync(coreOut, { recursive: true });

const workerSrc = require.resolve('tesseract.js/dist/worker.min.js');
cpSync(workerSrc, join(out, 'worker.min.js'));

const coreDir = dirname(require.resolve('tesseract.js-core/package.json'));
for (const f of readdirSync(coreDir)) {
  // Worker učitava samo samostalne *.wasm.js datoteke (WASM ugrađen); LSTM-only varijante nisu potrebne
  // jer oba OCR modela koriste punu jezgru (legacyCore).
  if (/^tesseract-core(-simd|-relaxedsimd)?\.wasm\.js$/.test(f)) cpSync(join(coreDir, f), join(coreOut, f));
}
if (!existsSync(join(coreOut, 'tesseract-core-simd.wasm.js'))) {
  throw new Error('Tesseract core nije kopiran.');
}
console.log('Tesseract assets copied to', out);
