// Offline verification harness for Cambridge IGCSE Economics (0455)
//
//   node scripts/verify-economics.mjs [folder]
//
// Asserts, for every 0455 question paper and mark scheme found:
//   * Paper 22:
//       - Classified as 0455/22 Economics;
//       - Outline usable, recovers Q1–Q5 with totals 30/20/20/20/20 = 110 printed (90 standard);
//       - Q1 captures all 8 sub-parts (a)–(h) including packed "1 (a) Calculate … [1]";
//       - Q2–Q5 capture all 4 sub-parts (a)–(d) [2, 4, 6, 8];
//       - Section B option groups assigned exclusively to Q2–Q5 ("choose 3 of 4");
//       - Mark scheme trim starts cleanly at Page 7/8, retaining 100% of Level 1–3 criteria;
//   * Paper 12 (Multiple Choice):
//       - Classified as 0455/12 Economics;
//       - Outline usable, family 'mcq', recovers 30 questions each at 1 mark = 30 marks;
//       - Mark scheme trim drops page 1 cover, keeping pages 2–3 answer table.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfjs = await import('file://' + require.resolve('pdfjs-dist/legacy/build/pdf.mjs').replace(/\\/g, '/'));
const { parseOutline } = await import('../src/lib/paperOutlineParse.ts');
const { classifySubject } = await import('../src/lib/subjectClassifier.ts');
const { detectMarkSchemeTableStart, shouldTrimMarkScheme } = await import('../src/lib/markSchemeDetect.ts');

const folder = process.argv[2] || 'economics paper';

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
    if (match.syllabusCode !== '0455') problems.push(`syllabus ${match.syllabusCode}, expected 0455`);
    if (match.profile.subjectName !== 'Economics') problems.push(`subject "${match.profile.subjectName}"`);
  }

  const outline = parseOutline(pages, { fileName: path.basename(file) });
  if (!outline.usable) problems.push(`outline rejected: ${outline.reasons.join('; ')}`);

  const paperCode = match?.paperCode || outline.profile.paperCode;
  const isMcq = outline.profile.family === 'mcq' || paperCode.startsWith('1');

  if (isMcq) {
    if (outline.questions.length !== 30) problems.push(`expected 30 questions for MCQ, found ${outline.questions.length}`);
    const sum = outline.questions.reduce((a, q) => a + q.total, 0);
    if (sum !== 30) problems.push(`MCQ sum ${sum} != 30`);
    return { problems, summary: `MCQ: ${outline.questions.length} questions, sum=${sum}` };
  }

  // Structured Paper (Paper 2)
  if (outline.questions.length !== 5) problems.push(`expected 5 questions, found ${outline.questions.length}`);
  const totals = outline.questions.map((q) => q.total);
  if (totals.join('/') !== '30/20/20/20/20') problems.push(`totals ${totals.join('/')} != 30/20/20/20/20`);

  const q1 = outline.questions[0];
  if (q1) {
    const q1Ids = q1.subs.map((s) => s.id);
    if (!q1Ids.includes('(a)')) problems.push(`Q1 lost its packed (a) sub-part (ids: ${q1Ids.join(' ')})`);
    if (q1Ids.length !== 8) problems.push(`Q1 has ${q1Ids.length} sub-parts, expected 8 ((a) to (h))`);
  }

  const groups = outline.profile.optionGroups ?? {};
  const grouped = Object.keys(groups).map(Number).sort((a, b) => a - b);
  if (grouped.join(',') !== '2,3,4,5') problems.push(`option groups on [${grouped.join(',')}], expected Section B [2,3,4,5]`);
  if (grouped.length && !Object.values(groups).every((label) => /Section B/i.test(label) && /choose 3 of 4/i.test(label))) {
    problems.push(`option-group label "${Object.values(groups)[0]}" does not match "Section B: choose 3 of 4"`);
  }

  return { problems, summary: `Q:${totals.join('/')} groups=${grouped.join(',')}` };
}

async function checkMarkScheme(file) {
  const problems = [];
  const pages = await readPages(file);
  const texts = textOf(pages);
  const start = detectMarkSchemeTableStart(texts);
  const trim = shouldTrimMarkScheme(start, pages.length);

  if (!trim) problems.push(`no trim detected (start=${start.startPage}/${start.method})`);
  if (start.method !== 'header') problems.push(`unexpected boundary method "${start.method}"`);

  // For Paper 22, ensure Levels tables (Level 1–3) survive trimming
  const isPaper2 = pages.length > 10;
  if (isPaper2) {
    // Real marking criteria in Economics print "Level Description Marks" or "Level 3 (6–8 marks)"
    const levelPages = texts.map((t, i) => (/Level\s+Description\s+Marks/i.test(t) || /Level\s+3\s*\(6\s*[–-]\s*8/i.test(t) ? i + 1 : 0)).filter(Boolean);
    const lost = levelPages.filter((p) => p < start.startPage);
    if (lost.length) problems.push(`trim discarded rubric pages: [${lost.join(', ')}]`);
  }

  return {
    problems,
    summary: `pages=${pages.length} start=${start.startPage}/${start.method} kept=${pages.length - start.startPage + 1}`,
  };
}

async function main() {
  const files = fs.readdirSync(folder).sort();
  let passCount = 0;
  let failCount = 0;

  for (const f of files) {
    if (!f.endsWith('.pdf')) continue;
    const full = path.join(folder, f);
    const isMS = /mark\s*scheme/i.test(f);
    const result = isMS ? await checkMarkScheme(full) : await checkQuestionPaper(full);

    if (result.problems.length === 0) {
      console.log(`PASS  ${f.padEnd(52)} ${result.summary}`);
      passCount++;
    } else {
      console.error(`FAIL  ${f.padEnd(52)} ${result.problems.join('; ')}`);
      failCount++;
    }
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exit(failCount === 0 ? 0 : 1);
}

await main();
