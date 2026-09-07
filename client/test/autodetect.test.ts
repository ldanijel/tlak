import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { autoDetect } from '../src/ocr/autodetect.ts';

const require = createRequire(import.meta.url);
const jpeg = require('jpeg-js') as { decode: (b: Buffer, o: { useTArray: boolean; formatAsRGBA: boolean }) => { width: number; height: number; data: Uint8Array } };
const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real');

// Stvarne fotografije tlakomjera Beurer BM38 (umanjene na 800 px), naziv = SYS-DIA-PULS. Auto-detekcija mora
// pronaći sva tri reda i pročitati točne vrijednosti bez ručnog izreza.
for (const file of readdirSync(dir).filter((f) => /^\d+-\d+-\d+\.jpe?g$/i.test(f)).sort()) {
  test(`auto-detekcija: ${file}`, () => {
    const [sys, dia, pulse] = file.replace(/\.jpe?g$/i, '').split('-').map(Number);
    const img = jpeg.decode(readFileSync(join(dir, file)), { useTArray: true, formatAsRGBA: true });
    const gray = new Uint8ClampedArray(img.width * img.height);
    for (let i = 0, j = 0; j < gray.length; i += 4, j++) gray[j] = (img.data[i] * 299 + img.data[i + 1] * 587 + img.data[i + 2] * 114) / 1000;
    const r = autoDetect(gray, img.width, img.height);
    assert.ok(r, 'zaslon nije pronađen');
    assert.equal(r.rows, 3, `nađeno redova: ${r.rows}`);
    assert.deepEqual(r.values, { systolic: sys, diastolic: dia, pulse });
  });
}
