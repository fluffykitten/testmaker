// Phase 4 harness: mark-scheme preamble detection + trim, over every MS in a folder.
//
//   node scripts/verify-phase4.mjs "H:\...\Practical Paper Deepseek"
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfjs = await import('file://' + require.resolve('pdfjs-dist/legacy/build/pdf.mjs').replace(/\\/g, '/'));
const { PDFDocument } = await import('file://' + require.resolve('pdf-lib').replace(/\\/g, '/'));
const { detectMarkSchemeTableStart, shouldTrimMarkScheme } = await import('../src/lib/markSchemeDetect.ts');

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) {
  console.error('usage: node scripts/verify-phase4.mjs <folder-with-mark-schemes>');
  process.exit(2);
}

const files = fs.readdirSync(dir).filter((f) => /Mark ?Scheme/i.test(f) && /\.pdf$/i.test(f)).sort();
const HEADER = /Question\s+Answer\s+Marks/i;
const PART = /\b\d\s*\(\s*[a-h]\s*\)/;

let failures = 0;
const rows = [];

for (const file of files) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(dir, file)));
  const doc = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true }).promise;
  const texts = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    texts.push(content.items.map((i) => i.str).join(' ').replace(/\s+/g, ' '));
  }
  const totalPages = doc.numPages;
  if (typeof doc.destroy === 'function') await doc.destroy();

  const start = detectMarkSchemeTableStart(texts);
  const trim = shouldTrimMarkScheme(start, totalPages);
  const preamble = texts.slice(0, start.startPage - 1);
  const preambleHasAnswers = preamble.some((t) => PART.test(t));
  const startPageHasHeader = HEADER.test(texts[start.startPage - 1] ?? '');

  // Simulate the actual trim with pdf-lib and re-read the first trimmed page.
  let trimmedPages = totalPages;
  let trimmedFirstHasHeader = false;
  if (trim) {
    const source = await PDFDocument.load(bytes);
    const target = await PDFDocument.create();
    const indices = Array.from({ length: totalPages - start.startPage + 1 }, (_, i) => start.startPage - 1 + i);
    const copied = await target.copyPages(source, indices);
    copied.forEach((p) => target.addPage(p));
    const out = await target.save();
    trimmedPages = target.getPageCount();
    const tdoc = await pdfjs.getDocument({ data: new Uint8Array(out), useSystemFonts: true }).promise;
    const tpage = await tdoc.getPage(1);
    const tcontent = await tpage.getTextContent();
    trimmedFirstHasHeader = HEADER.test(tcontent.items.map((i) => i.str).join(' ').replace(/\s+/g, ' '));
    if (typeof tdoc.destroy === 'function') await tdoc.destroy();
  }

  const problems = [];
  if (!trim) problems.push('no trim detected');
  if (preambleHasAnswers) problems.push('answer content in preamble');
  if (!startPageHasHeader) problems.push('first kept page has no table header');
  if (trim && !trimmedFirstHasHeader) problems.push('trimmed page 1 lost the header');
  if (trim && trimmedPages !== totalPages - start.startPage + 1) problems.push('page count mismatch');
  if (problems.length) failures++;

  rows.push({
    file: file.replace(/^0620 Chemistry /, ''),
    pages: `${trimmedPages}/${totalPages}`,
    start: start.startPage,
    saved: totalPages - trimmedPages,
    method: start.method,
    status: problems.length ? 'FAIL: ' + problems.join(', ') : 'ok',
  });
}

const pad = (v, n) => String(v).padEnd(n);
console.log(pad('mark scheme', 42) + pad('kept/all', 10) + pad('start', 7) + pad('saved', 7) + pad('method', 8) + 'status');
for (const r of rows) console.log(pad(r.file, 42) + pad(r.pages, 10) + pad(r.start, 7) + pad(r.saved, 7) + pad(r.method, 8) + r.status);

const savedTotal = rows.reduce((a, r) => a + r.saved, 0);
const avg = (savedTotal / rows.length).toFixed(1);
console.log(`\n${rows.length - failures}/${rows.length} mark schemes verified · ${savedTotal} preamble pages skipped (avg ${avg} per paper)`);
process.exit(failures === 0 ? 0 : 1);
