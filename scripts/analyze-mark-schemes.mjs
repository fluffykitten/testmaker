// Phase 4 analysis: can the mark-scheme preamble boundary be found from the text layer?
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfjs = await import('file://' + require.resolve('pdfjs-dist/legacy/build/pdf.mjs').replace(/\\/g, '/'));

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => /Mark ?Scheme/i.test(f) && /\.pdf$/i.test(f)).sort();

async function pagesOf(file) {
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const text = tc.items.map((i) => i.str).join(' ');
    out.push(text);
  }
  if (typeof doc.destroy === 'function') await doc.destroy();
  return out;
}

const count = (text, re) => (text.match(re) ?? []).length;

for (const file of files.slice(0, 6)) {
  const pages = await pagesOf(path.join(dir, file));
  console.log(`\n=== ${file} (${pages.length} pages)`);
  pages.forEach((text, i) => {
    const stats = {
      page: i + 1,
      chars: text.length,
      question: count(text, /Question/gi),
      answer: count(text, /Answer/gi),
      marks: count(text, /Marks?/gi),
      partLabels: count(text, /\([a-h]\)/g),
      generic: count(text, /Generic|GENERIC|Marking Principle/gi),
      pageOf: /Page \d+ of \d+/i.test(text) ? 'y' : 'n',
    };
    console.log(
      `  p${String(stats.page).padStart(2)} chars=${String(stats.chars).padStart(5)} Q=${String(stats.question).padStart(2)} A=${String(stats.answer).padStart(2)} M=${String(stats.marks).padStart(2)} parts=${String(stats.partLabels).padStart(2)} generic=${stats.generic} pageOf=${stats.pageOf}`,
    );
  });
}
