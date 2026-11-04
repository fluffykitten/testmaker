// Phase 6 harness: run the deterministic outline parser over a folder of QPs and
// assert the Phase 0 invariants. Offline, no API key, no browser.
//
//   node scripts/verify-paper5.mjs "H:\...\Practical Paper Deepseek"
//
// Requires Node >= 22.18 (type stripping) to import the TypeScript parser directly.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfjsPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs');
const pdfjs = await import('file://' + pdfjsPath.replace(/\\/g, '/'));
const { parseOutline, outlineToPromptText } = await import('../src/lib/paperOutlineParse.ts');
const { buildQualitativeNotesResources } = await import('../src/lib/practicalResources.ts');

const dir = process.argv[2];
if (!dir || !fs.existsSync(dir)) {
  console.error('usage: node scripts/verify-paper5.mjs <folder-with-question-papers>');
  process.exit(2);
}

async function readLayout(file) {
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    pages.push({
      page: p,
      width: Math.round(viewport.width),
      height: Math.round(viewport.height),
      items: content.items
        .map((it) => ({
          s: it.str,
          x: Math.round(it.transform[4]),
          y: Math.round(it.transform[5]),
          w: Math.round(it.width),
          h: Math.round(it.height),
        }))
        .filter((it) => it.s.trim() !== ''),
    });
  }
  if (typeof doc.destroy === 'function') await doc.destroy();
  else if (typeof doc.cleanup === 'function') await doc.cleanup();
  return pages;
}

const files = fs
  .readdirSync(dir)
  .filter((f) => /Question ?[Pp]aper/i.test(f) && /\.pdf$/i.test(f))
  .sort();

let failed = 0;
const rows = [];
for (const file of files) {
  const pages = await readLayout(path.join(dir, file));
  const outline = parseOutline(pages, { fileName: file });
  const label = file.replace(/^0620 Chemistry /, '').replace(/\.pdf$/i, '');

  const notes = outline.pages.filter((p) => p.kind === 'notes').map((p) => p.index);
  const blanks = outline.pages.filter((p) => p.kind === 'blank').map((p) => p.index);
  const noteResources = buildQualitativeNotesResources(outline);
  const checks = [
    ['usable', outline.usable],
    ['3 questions', outline.questions.length === 3],
    ['sum 40', outline.totalMarks === 40 && outline.questions.reduce((a, q) => a + q.total, 0) === 40],
    ['q1 16-20', outline.questions[0]?.total >= 16 && outline.questions[0]?.total <= 20],
    ['q2 14-18', outline.questions[1]?.total >= 14 && outline.questions[1]?.total <= 18],
    ['q3 = 6, no subs', outline.questions[2]?.total === 6 && outline.questions[2]?.subs.length === 0],
    ['notes 11-12', notes.includes(11) && notes.includes(12)],
    [
      'notes resources',
      noteResources.length >= 2 &&
        noteResources.every((r) => r.target_questions?.includes('2') && Number(r.page_number) >= 11),
    ],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (bad.length) failed++;

  rows.push({
    label,
    marks: outline.questions.map((q) => q.total).join('+'),
    leaves: outline.questions.reduce((a, q) => a + q.subs.length, 0),
    notes: notes.join('/'),
    blank: blanks.join('/') || '-',
    status: bad.length ? 'FAIL: ' + bad.join(', ') : 'ok',
  });
}

const pad = (v, n) => String(v).padEnd(n);
console.log(pad('paper', 36) + pad('marks', 12) + pad('leaves', 8) + pad('notes', 9) + pad('blank', 7) + 'status');
for (const r of rows) {
  console.log(pad(r.label, 36) + pad(r.marks, 12) + pad(r.leaves, 8) + pad(r.notes, 9) + pad(r.blank, 7) + r.status);
}

const totalLeaves = rows.reduce((a, r) => a + r.leaves, 0);
console.log(`\n${files.length - failed}/${files.length} papers passed · ${totalLeaves} sub-question leaves`);

if (process.argv[3] === '--show') {
  const first = rows[0];
  const pages = await readLayout(path.join(dir, files[0]));
  const outline = parseOutline(pages, { fileName: files[0] });
  console.log(`\n${first.label} → columns ${JSON.stringify(outline.columns)}\n${outlineToPromptText(outline)}`);
}

process.exit(failed === 0 ? 0 : 1);
