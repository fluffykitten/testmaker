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

const counts = new Map();
for (const fn of ops.fnArray) counts.set(fn, (counts.get(fn) ?? 0) + 1);
const names = Object.fromEntries(Object.entries(pdfjs.OPS).map(([k, v]) => [v, k]));
console.log('page', pageNum, 'viewport', Math.round(vp.width), 'x', Math.round(vp.height));
console.log([...counts.entries()].sort((a, b) => b[1] - a[1]).map(([fn, n]) => `${names[fn] ?? fn}:${n}`).join(' '));

// print form xobject boundaries with their transforms
for (let i = 0; i < ops.fnArray.length; i++) {
  const fn = ops.fnArray[i];
  if (names[fn] === 'paintFormXObjectBegin' || names[fn] === 'paintFormXObjectEnd') {
    console.log(i, names[fn], JSON.stringify(ops.argsArray[i]));
  }
}
if (typeof doc.destroy === 'function') await doc.destroy();
