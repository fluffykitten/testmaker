// Phase 1 harness for Plan/humanities.md — Sociology 0495, offline (no API key).
//
//   node scripts/verify-sociology.mjs [folder]
//
// Asserts, for every 0495 paper found:
//   * the cover identifies Sociology 0495 and the paper code;
//   * the outline parser accepts the paper (family structured, optional-choice marks);
//   * sub-parts are labelled (a)(i), (a)(ii), … never orphaned "(i)";
//   * the mark-scheme trimmer keeps the Levels of Response pages (Tables A–D).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfjs = await import('file://' + require.resolve('pdfjs-dist/legacy/build/pdf.mjs').replace(/\\/g, '/'));
const { parseOutline } = await import('../src/lib/paperOutlineParse.ts');
const { classifySubject } = await import('../src/lib/subjectClassifier.ts');
const { detectMarkSchemeTableStart } = await import('../src/lib/markSchemeDetect.ts');

const folder = process.argv[2] || 'sociology';
const ORPHAN_ROMAN = /^\((?:i|ii|iii|iv|v|vi)\)$/;
const TABLE_RE = /\bTable\s+[A-D]\b/gi;

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

const textOf = (pages) => pages.map((p) => p.items.map((i) => i.s).join(' '));

async function checkQuestionPaper(file) {
  const problems = [];
  const pages = await readPages(file);
  const texts = textOf(pages);

  const match = classifySubject(texts, { fileName: path.basename(file) });
  if (!match) problems.push('subject not detected');
  else {
    if (match.syllabusCode !== '0495') problems.push(`syllabus ${match.syllabusCode}, expected 0495`);
    if (match.profile.subjectName !== 'Sociology') problems.push(`subject ${match.profile.subjectName}, expected Sociology`);
    if (match.profile.domain !== 'humanities') problems.push(`domain ${match.profile.domain}, expected humanities`);
    if (!match.paperCode) problems.push('paper code not detected');
  }

  const outline = parseOutline(pages, { fileName: path.basename(file) });
  if (!outline.usable) problems.push(`outline rejected: ${outline.reasons.join('; ')}`);
  if (outline.profile.family !== 'structured') problems.push(`family ${outline.profile.family}, expected structured`);
  if (!outline.profile.optionalChoice) problems.push('optional-choice cover instruction not detected');
  if (outline.questions.length !== 3) problems.push(`${outline.questions.length} questions, expected 3`);

  const summary = [];
  for (const q of outline.questions) {
    const ids = q.subs.map((s) => s.id);
    const orphan = ids.filter((id) => ORPHAN_ROMAN.test(id));
    if (orphan.length) problems.push(`Q${q.number} has orphan roman ids ${orphan.join(', ')}`);
    if (!ids.length || !ids[0].startsWith('(a)')) problems.push(`Q${q.number} starts at ${ids[0] ?? 'no sub-parts'}, expected (a)…`);
    if (q.total !== 40) problems.push(`Q${q.number} totals ${q.total}, expected 40`);
    summary.push(`Q${q.number}:${ids.length}`);
  }
  return { problems, summary: summary.join(' ') };
}

async function checkMarkScheme(file) {
  const problems = [];
  const pages = await readPages(file);
  const texts = textOf(pages);
  const start = detectMarkSchemeTableStart(texts);

  if (start.method !== 'rubric') problems.push(`trim boundary via "${start.method}", expected "rubric"`);
  if (!start.rubricPage) problems.push('no Levels of Response page detected');

  // Every page that prints a Table A–D must survive the trim.
  const tablePages = texts
    .map((text, i) => (new RegExp(TABLE_RE.source, 'i').test(text) ? i + 1 : 0))
    .filter(Boolean);
  const lost = tablePages.filter((p) => p < start.startPage);
  if (lost.length) problems.push(`Tables A–D on page(s) ${lost.join(', ')} would be trimmed away`);
  if (!tablePages.length) problems.push('no Table A–D pages found at all');

  const headerPages = texts.map((t, i) => (/Question\s+Answer\s+Marks/i.test(t) ? i + 1 : 0)).filter(Boolean);
  const headerPage = headerPages[0] ?? null;

  return {
    problems,
    summary: `pages=${texts.length} start=${start.startPage}/${start.method} rubric=${start.rubricPage} header=${headerPage ?? '-'} tablesOn=${tablePages.join(',')}`,
  };
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
  const isMs = /_ms_/i.test(file);
  const { problems, summary } = await (isMs ? checkMarkScheme(full) : checkQuestionPaper(full));
  const ok = problems.length === 0;
  ok ? pass++ : fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${file.padEnd(22)} ${summary}`);
  for (const problem of problems) console.log(`      - ${problem}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
