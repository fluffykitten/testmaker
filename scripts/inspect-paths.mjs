import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pdfjs = await import('file://' + require.resolve('pdfjs-dist/legacy/build/pdf.mjs').replace(/\\/g, '/'));

const file = process.argv[2];
const pageNum = Number(process.argv[3] ?? 7);
const data = new Uint8Array(fs.readFileSync(file));
const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
const page = await doc.getPage(pageNum);
const vp = page.getViewport({ scale: 1 });
const ops = await page.getOperatorList();

const boxes = [];
for (let i = 0; i < ops.fnArray.length; i++) {
  if (ops.fnArray[i] !== pdfjs.OPS.constructPath) continue;
  const mm = ops.argsArray[i]?.[2];
  if (!mm) continue;
  const [x0, y0, x1, y1] = [mm[0], mm[1], mm[2], mm[3]].map(Number);
  if (![x0, y0, x1, y1].every(Number.isFinite)) continue;
  boxes.push([Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]);
}

const W = vp.width, H = vp.height;
const norm = (b) => [
  Math.round(((H - b[3]) / H) * 1000),
  Math.round((b[0] / W) * 1000),
  Math.round(((H - b[1]) / H) * 1000),
  Math.round((b[2] / W) * 1000),
];

console.log('page', pageNum, 'paths', boxes.length);
// drop full-width rules and hairlines
const candidates = boxes.filter(([x0, y0, x1, y1]) => (x1 - x0) > 3 && (y1 - y0) > 3 && (x1 - x0) < W * 0.8);
console.log('candidates', candidates.length);
candidates.sort((a, b) => b[1] - a[1]);
for (const b of candidates.slice(0, 40)) console.log('  user', b.map((n) => n.toFixed(0)).join(','), ' norm', norm(b).join(','));
if (candidates.length) {
  const u = [
    Math.min(...candidates.map((b) => b[0])),
    Math.min(...candidates.map((b) => b[1])),
    Math.max(...candidates.map((b) => b[2])),
    Math.max(...candidates.map((b) => b[3])),
  ];
  console.log('union user', u.map((n) => n.toFixed(0)).join(','), ' norm', norm(u).join(','));
}

const tc = await page.getTextContent();
const labels = tc.items
  .filter((i) => /spirit|burner|alcohol|water|boiling|Fig\.?\s*3\.1/i.test(i.str))
  .map((i) => ({ s: i.str, x: Math.round(i.transform[4]), y: Math.round(i.transform[5]) }));
console.log('label positions:', JSON.stringify(labels));
if (typeof doc.destroy === 'function') await doc.destroy();
