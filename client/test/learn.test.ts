import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { segmentDigits, learn, classifyBand, emptyModel, modelReady, bitsToBase64, base64ToBits, GW, GH } from '../src/ocr/learn.ts';

/** Minimalni čitač 8-bitnog sivog PNG-a (testna slika seg.png generirana u skripti). */
function readGrayPng(path: string): { w: number; h: number; gray: Uint8ClampedArray } {
  const d = readFileSync(path);
  let pos = 8, w = 0, h = 0; const idat: Buffer[] = [];
  while (pos < d.length) {
    const len = d.readUInt32BE(pos); const type = d.toString('ascii', pos + 4, pos + 8); const body = d.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = body.readUInt32BE(0); h = body.readUInt32BE(4); }
    if (type === 'IDAT') idat.push(body);
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const gray = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) gray[y * w + x] = raw[y * (w + 1) + 1 + x];
  return { w, h, gray };
}

const png = new URL('./fixtures/seg.png', import.meta.url).pathname;

function band(img: { w: number; h: number; gray: Uint8ClampedArray }, from: number, to: number) {
  const y0 = Math.round(img.h * from), y1 = Math.round(img.h * to);
  const ink = new Uint8Array(img.w * (y1 - y0));
  for (let y = y0; y < y1; y++) for (let x = 0; x < img.w; x++) ink[(y - y0) * img.w + x] = img.gray[y * img.w + x] < 128 ? 1 : 0;
  return { ink, w: img.w, h: y1 - y0 };
}

test('segmentacija: 3, 2 i 2 znamenke po zonama', () => {
  const img = readGrayPng(png);
  const b0 = band(img, 0, 0.34), b1 = band(img, 0.34, 0.67), b2 = band(img, 0.67, 1);
  assert.equal(segmentDigits(b0.ink, b0.w, b0.h).length, 3);
  assert.equal(segmentDigits(b1.ink, b1.w, b1.h).length, 2);
  assert.equal(segmentDigits(b2.ink, b2.w, b2.h).length, 2);
});

test('učenje i klasifikacija: nakon potvrde iste znamenke se prepoznaju sa 100 %', () => {
  const img = readGrayPng(png);
  const bands = [[0, 0.34, '128'], [0.34, 0.67, '82'], [0.67, 1, '66']] as const;
  let m = emptyModel();
  for (const [a, b, v] of bands) { const bb = band(img, a, b); m = learn(m, segmentDigits(bb.ink, bb.w, bb.h), v); }
  assert.ok(modelReady(m));
  // jedna fotografija: znamenka '1' ima samo jedan uzorak → niska pouzdanost
  const one = band(img, 0, 0.34);
  assert.ok(classifyBand(segmentDigits(one.ink, one.w, one.h), m, [50, 260]).confidence < 70);
  // druga potvrđena fotografija istog uređaja
  for (const [a, b, v] of bands) { const bb = band(img, a, b); m = learn(m, segmentDigits(bb.ink, bb.w, bb.h), v); }
  const bb = band(img, 0, 0.34);
  const r = classifyBand(segmentDigits(bb.ink, bb.w, bb.h), m, [50, 260]);
  assert.equal(r.value, 128);
  assert.ok(r.confidence >= 90, `pouzdanost ${r.confidence}`);
  const b2 = band(img, 0.67, 1);
  assert.equal(classifyBand(segmentDigits(b2.ink, b2.w, b2.h), m, [25, 220]).value, 66);
  // krivi broj znamenki → ne uči
  assert.equal(learn(m, [], '12'), m);
});

test('bitmapa: base64 kodiranje je reverzibilno', () => {
  const bits = new Uint8Array(GW * GH).map((_, i) => (i % 3 === 0 ? 1 : 0));
  assert.deepEqual([...base64ToBits(bitsToBase64(bits))], [...bits]);
});
