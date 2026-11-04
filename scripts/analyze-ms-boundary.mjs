// Detect the "Question Answer Marks" table start across every mark scheme in the folder.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pdfjs = await import('file://' + require.resolve('pdfjs-dist/legacy/build/pdf.mjs').replace(/\\/g, '/'));

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => /Mark ?Scheme/i.test(f) && /\.pdf$/i.test(f)).sort();
const HEADER = /Question\s+Answer\s+Marks/i;
const PART_LABEL = /\b\d\s*\(\s*[a-h]\s*\)/;

let ok = 0;
for (const file of files) {
  const data = new Uint8Array(fs.readFileSync(path.join(dir, file)));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const texts = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    texts.push(tc.items.map((i) => i.str).join(' ').replace(/\s+/g, ' '));
  }
  if (typeof doc.destroy === 'function') await doc.destroy();

  const start = texts.findIndex((t) => HEADER.test(t)) + 1; // 1-based, 0 = not found
  const firstContent = texts.findIndex((t) => PART_LABEL.test(t)) + 1;
  const preambleParts = texts.slice(0, Math.max(0, start - 1)).filter((t) => PART_LABEL.test(t)).length;
  const good = start > 1 && start <= firstContent + 1 && preambleParts === 0;
  if (good) ok++;
  console.log(
    `${(file.replace(/^0620 Chemistry /, '')).padEnd(42)} pages=${String(texts.length).padStart(2)} tableStarts=p${start} firstPartLabel=p${firstContent} answerPagesInPreamble=${preambleParts} ${good ? 'ok' : 'CHECK'}`,
  );
}
console.log(`\n${ok}/${files.length} mark schemes detected cleanly`);
