import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pdfjs = await import('file://' + require.resolve('pdfjs-dist/legacy/build/pdf.mjs').replace(/\\/g, '/'));

const file = process.argv[2];
const data = new Uint8Array(fs.readFileSync(file));
const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
for (let p = 1; p <= Math.min(doc.numPages, Number(process.argv[3] ?? 6)); p++) {
  const page = await doc.getPage(p);
  const tc = await page.getTextContent();
  const text = tc.items.map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
  console.log(`\n--- p${p} (${text.length} chars)`);
  console.log(text.slice(0, Number(process.argv[4] ?? 340)));
}
if (typeof doc.destroy === 'function') await doc.destroy();
