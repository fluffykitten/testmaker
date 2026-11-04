import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pdfjs = await import('file://' + require.resolve('pdfjs-dist/legacy/build/pdf.mjs').replace(/\\/g, '/'));
const { parseOutline } = await import('../src/lib/paperOutlineParse.ts');
const file = process.argv[2];
const data = new Uint8Array(fs.readFileSync(file));
const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
const pages = [];
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  pages.push({ page: p, width: Math.round(vp.width), height: Math.round(vp.height), items: tc.items.map((it) => ({ s: it.str, x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), w: Math.round(it.width), h: Math.round(it.height) })).filter((i) => i.s.trim() !== '') });
}
const o = parseOutline(pages, { fileName: file });
console.log('profile', JSON.stringify(o.profile), 'usable', o.usable, 'reasons', JSON.stringify(o.reasons));
for (const q of o.questions) {
  console.log('Q' + q.number, q.subs.map((s) => s.id + (s.marks === null ? '(stem)' : '[' + s.marks + ']')).join(' '), '=>', q.total);
}
const stems = o.questions.flatMap((q) => q.subs.filter((s) => s.isStem).map((s) => 'Q' + q.number + s.id));
console.log('stems:', stems.join(' ') || 'none');
