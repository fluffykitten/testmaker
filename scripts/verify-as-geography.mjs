// Phase 4 harness for Plan/geography.md — Cambridge AS & A Level Geography (9696), offline.
//
//   node scripts/verify-as-geography.mjs [folder]
//
// Asserts, for every 9696 question paper / mark scheme / insert found:
//   * the cover identifies Geography (AS/A Level) 9696, not IGCSE 0460;
//   * the outline recovers Q1–Q6 at 10/10/10/30/30/30, including the packed
//     "4 (a) (i) … [4]" first sub-part on the question line;
//   * only Section B questions carry an option group;
//   * the mark-scheme trim keeps every page that prints Level 1–4 criteria;
//   * the insert booklet contains Fig. 1.1, Fig. 2.1 and Fig. 3.1.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfjs = await import('file://' + require.resolve('pdfjs-dist/legacy/build/pdf.mjs').replace(/\\/g, '/'));
const { parseOutline } = await import('../src/lib/paperOutlineParse.ts');
const { classifySubject } = await import('../src/lib/subjectClassifier.ts');
const { detectMarkSchemeTableStart, shouldTrimMarkScheme } = await import('../src/lib/markSchemeDetect.ts');

const folder = process.argv[2] || 'geography paper';
const EXPECTED_TOTALS = [10, 10, 10, 30, 30, 30];
// Real marking criteria print a band with marks, e.g. "Level 3 (6 – 8)". The annotation
// legend on the preamble pages also says "Level 4", which is not rubric content.
const LEVEL_RE = /Level\s+[1-4]\s*\(\s*\d/i;

async function readPages(file) {
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data: data.slice(), useSystemFonts: true }).promise;
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
        .map((it) => ({ s: it.str, x: Math.round(it.transform[4]), y: Math.round(it.transform[5]), w: Math.round(it.width), h: Math.round(it.height) }))
        .filter((it) => it.s.trim() !== ''),
    });
  }
  if (typeof doc.destroy === 'function') await doc.destroy();
  return pages;
}

const textOf = (pages) => pages.map((p) => p.items.map((i) => i.s).join(' ').replace(/\s+/g, ' '));

async function checkQuestionPaper(file) {
  const problems = [];
  const pages = await readPages(file);
  const texts = textOf(pages);

  const match = classifySubject(texts, { fileName: path.basename(file) });
  if (!match) problems.push('subject not detected');
  else {
    if (match.syllabusCode !== '9696') problems.push(`syllabus ${match.syllabusCode}, expected 9696 (IGCSE 0460 fallback?)`);
    if (!/Geography \(AS\/A Level\)/i.test(match.profile.subjectName)) problems.push(`subject "${match.profile.subjectName}"`);
    if (match.profile.domain !== 'humanities') problems.push(`domain ${match.profile.domain}`);
  }

  const outline = parseOutline(pages, { fileName: path.basename(file) });
  if (!outline.usable) problems.push(`outline rejected: ${outline.reasons.join('; ')}`);
  if (outline.profile.family !== 'structured') problems.push(`family ${outline.profile.family}`);
  if (outline.questions.length !== 6) problems.push(`${outline.questions.length} questions, expected 6`);

  const totals = outline.questions.map((q) => q.total);
  if (totals.join(',') !== EXPECTED_TOTALS.join(',')) problems.push(`totals ${totals.join('/')} != ${EXPECTED_TOTALS.join('/')}`);

  for (const q of outline.questions) {
    if (q.number >= 4) {
      const ids = q.subs.map((s) => s.id);
      if (!ids.includes('(a)(i)')) problems.push(`Q${q.number} lost its packed (a)(i) sub-part (ids: ${ids.join(' ')})`);
    }
  }

  const groups = outline.profile.optionGroups ?? {};
  const grouped = Object.keys(groups).map(Number).sort((a, b) => a - b);
  if (grouped.join(',') !== '4,5,6') problems.push(`option groups on [${grouped.join(',')}], expected Section B only [4,5,6]`);
  if (grouped.length && !Object.values(groups).every((label) => /Section B/i.test(label))) {
    problems.push('option-group label does not name Section B');
  }

  return { problems, summary: `Q:${totals.join('/')} groups=${grouped.join(',') || '-'}` };
}

async function checkMarkScheme(file) {
  const problems = [];
  const pages = await readPages(file);
  const texts = textOf(pages);
  const start = detectMarkSchemeTableStart(texts);
  const trim = shouldTrimMarkScheme(start, pages.length);

  if (!trim) problems.push(`no trim detected (start=${start.startPage}/${start.method})`);
  if (start.method !== 'header' && start.method !== 'rubric') problems.push(`unexpected boundary method "${start.method}"`);

  const levelPages = texts.map((t, i) => (LEVEL_RE.test(t) ? i + 1 : 0)).filter(Boolean);
  const lost = levelPages.filter((p) => p < start.startPage);
  if (lost.length) problems.push(`Level 1–4 content on page(s) ${lost.join(', ')} would be trimmed away`);
  if (!levelPages.length) problems.push('no Level 1–4 rubric pages found');

  return {
    problems,
    summary: `pages=${pages.length} start=${start.startPage}/${start.method} kept=${trim ? pages.length - start.startPage + 1 : pages.length} levels=${levelPages.join(',')}`,
  };
}

async function checkInsert(file) {
  const problems = [];
  const pages = await readPages(file);
  const text = textOf(pages).join(' ');
  for (const fig of ['Fig. 1.1', 'Fig. 2.1', 'Fig. 3.1']) {
    if (!new RegExp(fig.replace('.', '\\.'), 'i').test(text)) problems.push(`insert is missing ${fig}`);
  }
  if (pages.length < 4) problems.push(`${pages.length} pages, expected at least 4`);
  return { problems, summary: `pages=${pages.length}` };
}

const files = fs.readdirSync(folder).filter((f) => /\.pdf$/i.test(f)).sort();
if (!files.length) {
  console.error(`no PDFs in ${folder}`);
  process.exit(2);
}

let pass = 0;
let fail = 0;
for (const file of files) {
  const full = path.join(folder, file);
  const lower = file.toLowerCase();
  const check = lower.includes('mark scheme') ? checkMarkScheme : lower.includes('insert') ? checkInsert : checkQuestionPaper;
  const { problems, summary } = await check(full);
  const ok = problems.length === 0;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${file.padEnd(40)} ${summary}`);
  for (const problem of problems) console.log(`      - ${problem}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
