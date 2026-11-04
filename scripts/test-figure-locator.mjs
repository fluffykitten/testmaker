// Test the deterministic figure locator against a real page.
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pdfjs = await import('file://' + require.resolve('pdfjs-dist/legacy/build/pdf.mjs').replace(/\\/g, '/'));
const { locateFigureBox } = await import('../src/lib/figureLocator.ts');

const file = process.argv[2];
const pageNum = Number(process.argv[3] ?? 7);
const data = new Uint8Array(fs.readFileSync(file));
const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
const page = await doc.getPage(pageNum);
const vp = page.getViewport({ scale: 1 });
const ops = await page.getOperatorList();
const tc = await page.getTextContent();

const pathBoxes = [];
for (let i = 0; i < ops.fnArray.length; i++) {
  if (ops.fnArray[i] !== pdfjs.OPS.constructPath) continue;
  const mm = ops.argsArray[i]?.[2];
  if (!mm) continue;
  const box = [Number(mm[0]), Number(mm[1]), Number(mm[2]), Number(mm[3])];
  if (box.every(Number.isFinite)) pathBoxes.push(box);
}

const boxOf = (item, maxWidth = 120) => {
  const [, , , , e, f] = item.transform;
  const w = Math.min(item.width ?? 0, maxWidth);
  const h = item.height ?? 9;
  return [e, f, e + w, f + h];
};

let captionBox = null;
const labelBoxes = [];
for (const item of tc.items) {
  const s = (item.str ?? '').trim();
  if (!s) continue;
  if (/^Fig\.?\s*\d\.\d$/i.test(s)) captionBox = boxOf(item);
  else if (/^(spirit burner|liquid alcohol|water|boiling tube)$/i.test(s)) labelBoxes.push(boxOf(item));
}

console.log('page', pageNum, `${Math.round(vp.width)}x${Math.round(vp.height)}`, 'paths', pathBoxes.length, 'caption', JSON.stringify(captionBox), 'labels', labelBoxes.length);
const W = vp.width, H = vp.height;
const kept = pathBoxes.map(([x0, y0, x1, y1]) => [
  Math.max(0, Math.min(x0, x1)), Math.max(0, Math.min(y0, y1)),
  Math.min(W, Math.max(x0, x1)), Math.min(H, Math.max(y0, y1)),
]).filter(([x0, y0, x1, y1]) => (x1 - x0) >= 4 && (y1 - y0) >= 4 && (x1 - x0) < W * 0.85 && (y1 - y0) < H * 0.6 && !(x0 <= 2 || y0 <= 2 || x1 >= W - 2 || y1 >= H - 2));
console.log('kept paths:', kept.length, JSON.stringify(kept.slice(0, 8)));
if (kept.length) {
  console.log('kept union x', Math.min(...kept.map((b) => b[0])).toFixed(0), '..', Math.max(...kept.map((b) => b[2])).toFixed(0),
    ' y', Math.min(...kept.map((b) => b[1])).toFixed(0), '..', Math.max(...kept.map((b) => b[3])).toFixed(0));
}
console.log('labels:', JSON.stringify(labelBoxes));
const box = locateFigureBox({ pathBoxes, captionBox, labelBoxes, pageWidth: vp.width, pageHeight: vp.height });
console.log('located box [ymin,xmin,ymax,xmax] =', JSON.stringify(box));
if (box) {
  const [ymin, xmin, ymax, xmax] = box;
  console.log(`  covers ${((ymax - ymin) / 10).toFixed(0)}% of page height, ${((xmax - xmin) / 10).toFixed(0)}% of page width`);
  // expected figure region in normalised coords (from the path/label dump)
  const expected = [120, 340, 390, 660];
  const overlapX = Math.max(0, Math.min(xmax, expected[3]) - Math.max(xmin, expected[1]));
  const overlapY = Math.max(0, Math.min(ymax, expected[2]) - Math.max(ymin, expected[0]));
  console.log(`  overlap with expected figure region: ${((overlapX * overlapY) / ((xmax - xmin) * (ymax - ymin)) * 100).toFixed(0)}% of box`);
}
if (typeof doc.destroy === 'function') await doc.destroy();
