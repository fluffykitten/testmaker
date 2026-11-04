// What is on each page: raster images (with placement rects) and their text context.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfjs = await import('file://' + require.resolve('pdfjs-dist/legacy/build/pdf.mjs').replace(/\\/g, '/'));

const file = process.argv[2];
const from = Number(process.argv[3] ?? 1);
const to = Number(process.argv[4] ?? 99);
const data = new Uint8Array(fs.readFileSync(file));
const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;

for (let p = from; p <= Math.min(to, doc.numPages); p++) {
  const page = await doc.getPage(p);
  const vp = page.getViewport({ scale: 1 });
  const ops = await page.getOperatorList();
  const images = [];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    // OPS.paintImageXObject = 85, paintInlineImageXObject = 86, paintJpegXObject = 87
    if (fn === 85 || fn === 86 || fn === 87) {
      const args = ops.argsArray[i];
      const transform = args?.find?.((a) => Array.isArray(a) && a.length === 6);
      images.push({ op: fn, transform });
    }
  }
  const tc = await page.getTextContent();
  const text = tc.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
  console.log(`\n=== p${p} (view ${Math.round(vp.width)}x${Math.round(vp.height)}) images=${images.length}`);
  for (const img of images) {
    if (!img.transform) { console.log('   image (no transform)'); continue; }
    const [a, b, c, d, e, f] = img.transform;
    // user-space rect -> normalised 0..1000 with origin bottom-left
    const xs = [e, e + a, e + c, e + a + c];
    const ys = [f, f + b, f + d, f + b + d];
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    const toNorm = (v, size) => Math.round((v / size) * 1000);
    console.log(
      `   raster x ${Math.round(x0)}..${Math.round(x1)} y ${Math.round(y0)}..${Math.round(y1)} → box [${toNorm(vp.height - y1, vp.height)}, ${toNorm(x0, vp.width)}, ${toNorm(vp.height - y0, vp.height)}, ${toNorm(x1, vp.width)}]`,
    );
  }
  console.log('   text: ' + text.slice(0, 220));
}
if (typeof doc.destroy === 'function') await doc.destroy();
