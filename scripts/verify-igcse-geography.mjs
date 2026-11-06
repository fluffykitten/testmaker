// Verification harness for Cambridge IGCSE Geography (0460), offline.
//
//   node scripts/verify-igcse-geography.mjs [folder]
//
// Asserts, for every 0460 question paper / mark scheme / insert found:
//   * the cover identifies Geography 0460;
//   * Paper 1 outline recovers Q1–Q6 at 25/25/25/25/25/25 (150 printed marks, 75 paper total);
//   * Paper 1 groups Q1-Q2 in Section A, Q3-Q4 in Section B, Q5-Q6 in Section C;
//   * Paper 2 outline recovers Q1–Q6 at 20/8/8/8/8/8 (60 marks), all compulsory;
//   * mark schemes detect table start cleanly and retain all rubric tables;
//   * insert booklet contains required resource figures.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfjs = await import('file://' + require.resolve('pdfjs-dist/legacy/build/pdf.mjs').replace(/\\/g, '/'));
const { parseOutline } = await import('../src/lib/paperOutlineParse.ts');
const { classifySubject } = await import('../src/lib/subjectClassifier.ts');
const { detectMarkSchemeTableStart, shouldTrimMarkScheme } = await import('../src/lib/markSchemeDetect.ts');

const folder = process.argv[2] || 'igcse geography paper';

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
    if (match.syllabusCode !== '0460') problems.push(`syllabus ${match.syllabusCode}, expected 0460`);
    if (!/Geography/i.test(match.profile.subjectName)) problems.push(`subject "${match.profile.subjectName}"`);
    if (match.profile.domain !== 'humanities') problems.push(`domain ${match.profile.domain}`);
  }

  const outline = parseOutline(pages, { fileName: path.basename(file) });
  if (!outline.usable) problems.push(`outline rejected: ${outline.reasons.join('; ')}`);
  if (outline.profile.family !== 'structured') problems.push(`family ${outline.profile.family}`);
  if (outline.questions.length !== 6) problems.push(`${outline.questions.length} questions, expected 6`);

  const totals = outline.questions.map((q) => q.total);
  const isPaper1 = /Paper\s*1|0460_1/i.test(path.basename(file));

  if (isPaper1) {
    if (totals.join(',') !== '25,25,25,25,25,25') {
      problems.push(`totals ${totals.join('/')} != 25/25/25/25/25/25`);
    }
    const groups = outline.profile.optionGroups ?? {};
    if (!groups['1'] || !groups['2'] || !/Section A/i.test(groups['1'])) {
      problems.push('Q1/Q2 missing Section A option group');
    }
    if (!groups['3'] || !groups['4'] || !/Section B/i.test(groups['3'])) {
      problems.push('Q3/Q4 missing Section B option group');
    }
    if (!groups['5'] || !groups['6'] || !/Section C/i.test(groups['5'])) {
      problems.push('Q5/Q6 missing Section C option group');
    }
  } else {
    // Paper 2
    if (totals.join(',') !== '20,8,8,8,8,8') {
      problems.push(`totals ${totals.join('/')} != 20/8/8/8/8/8`);
    }
    if (outline.profile.optionalChoice) {
      problems.push('Paper 2 flagged as optional choice, expected compulsory');
    }
  }

  return { problems, summary: `Q:${totals.join('/')}` };
}

async function checkMarkScheme(file) {
  const problems = [];
  const pages = await readPages(file);
  const texts = textOf(pages);
  const start = detectMarkSchemeTableStart(texts);
  const trim = shouldTrimMarkScheme(start, pages.length);

  if (!trim) problems.push(`no trim detected (start=${start.startPage}/${start.method})`);
  if (start.method !== 'header') problems.push(`unexpected boundary method "${start.method}"`);

  return {
    problems,
    summary: `pages=${pages.length} start=${start.startPage}/${start.method} kept=${pages.length - start.startPage + 1}`,
  };
}

async function checkInsert(file) {
  const problems = [];
  const pages = await readPages(file);
  const texts = textOf(pages);
  const allText = texts.join(' ');

  if (!/Fig\.\s*2\.1/i.test(allText)) problems.push('missing Fig. 2.1');
  if (!/Fig\.\s*3\.1/i.test(allText)) problems.push('missing Fig. 3.1');
  if (!/Fig\.\s*4\.1/i.test(allText)) problems.push('missing Fig. 4.1');

  return { problems, summary: `pages=${pages.length}` };
}

if (!fs.existsSync(folder)) {
  console.error(`Folder "${folder}" not found.`);
  process.exit(2);
}

const entries = fs.readdirSync(folder).filter((f) => f.endsWith('.pdf')).sort();
let failed = 0;

for (const entry of entries) {
  const file = path.join(folder, entry);
  let res;
  if (/Questions/i.test(entry)) {
    res = await checkQuestionPaper(file);
  } else if (/Mark\s*Scheme/i.test(entry)) {
    res = await checkMarkScheme(file);
  } else if (/Insert/i.test(entry)) {
    res = await checkInsert(file);
  } else {
    continue;
  }

  const tag = entry.padEnd(52);
  if (res.problems.length === 0) {
    console.log(`PASS  ${tag} ${res.summary}`);
  } else {
    console.log(`FAIL  ${tag} ${res.summary}`);
    for (const p of res.problems) console.log(`      * ${p}`);
    failed++;
  }
}

console.log(`\n${entries.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

