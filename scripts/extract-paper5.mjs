// Phase 3 + 6 harness: outline-constrained extraction against a real paper, scored
// against the deterministic outline, with a targeted re-ask when the model drifts.
//
//   $env:GEMINI_API_KEY = "..."
//   node scripts/extract-paper5.mjs "<paper.pdf>" [--model=gemini-3.5-flash-lite] [--attempts=3]
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfjs = await import('file://' + require.resolve('pdfjs-dist/legacy/build/pdf.mjs').replace(/\\/g, '/'));
const { parseOutline, expectedSubIds } = await import('../src/lib/paperOutlineParse.ts');
const { getCambridgePracticalExtractionPrompt } = await import('../src/lib/practicalPrompt.ts');

const args = process.argv.slice(2);
const pdfPath = args.find((a) => !a.startsWith('--'));
const opt = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};
const apiKey = process.env.GEMINI_API_KEY || opt('key', '');
const model = opt('model', 'gemini-3.5-flash-lite');
const maxAttempts = Number(opt('attempts', '3'));

if (!pdfPath || !apiKey) {
  console.error('usage: GEMINI_API_KEY=... node scripts/extract-paper5.mjs "<paper.pdf>"');
  process.exit(2);
}

async function readLayout(file) {
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data: data.slice(), useSystemFonts: true }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    pages.push({
      page: p, width: Math.round(vp.width), height: Math.round(vp.height),
      items: tc.items.map((it) => ({
        s: it.str, x: Math.round(it.transform[4]), y: Math.round(it.transform[5]),
        w: Math.round(it.width), h: Math.round(it.height),
      })).filter((i) => i.s.trim() !== ''),
    });
  }
  if (typeof doc.destroy === 'function') await doc.destroy();
  return pages;
}

function extractJson(text) {
  let t = text.trim();
  if (t.startsWith('```')) t = t.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

async function callGemini(pdfBase64, prompt, msBase64) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const parts = [{ text: prompt }, { inlineData: { mimeType: 'application/pdf', data: pdfBase64 } }];
  if (msBase64) parts.push({ inlineData: { mimeType: 'application/pdf', data: msBase64 } });
  const body = {
    contents: [{ parts }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 32768 },
  };
  for (let attempt = 1; attempt <= 4; attempt++) {
    // Without a timeout a stalled connection hangs the whole sweep forever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 180_000);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (attempt === 4) throw error;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    clearTimeout(timer);
    if (res.ok) return res.json();
    const text = await res.text();
    if ((res.status === 429 || res.status === 503) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1200 * attempt));
      continue;
    }
    throw new Error(`Gemini ${res.status}: ${text.slice(0, 300)}`);
  }
}

/** Everything wrong with an extraction, phrased as instructions for the re-ask. */
function findProblems(parsed, outline, expected) {
  const problems = [];
  const questions = Array.isArray(parsed?.questions) ? parsed.questions : null;
  if (!questions) return ['The response had no "questions" array.'];

  for (const q of outline.questions) {
    const got = questions.find((x) => String(x.question_number).trim() === String(q.number));
    const want = expected[q.number];
    if (!got) { problems.push(`Question ${q.number} is missing entirely.`); continue; }

    const gotSubs = (got.sub_questions ?? []).map((s) => String(s.sub_id));
    const missing = want.filter((id) => !gotSubs.includes(id));
    const extra = gotSubs.filter((id) => !want.includes(id));
    if (missing.length) {
      problems.push(
        `Question ${q.number} is missing sub-question(s) ${missing.join(', ')}. ` +
          `Its sub-questions must be exactly: ${want.join(' ')} (in this order).`,
      );
    }
    if (extra.length) {
      problems.push(
        `Question ${q.number} contains sub-question(s) that must not exist: ${extra.join(', ')}. ` +
          `Remove them; the allowed ids are: ${want.join(' ')}.`,
      );
    }
    if (!missing.length && !extra.length && !want.every((id, i) => gotSubs[i] === id)) {
      problems.push(`Question ${q.number} sub-questions are out of printed order. Required order: ${want.join(' ')}.`);
    }
    const wantMarks = new Map(q.subs.filter((s) => !s.isStem).map((s) => [s.id, s.marks]));
    for (const s of got.sub_questions ?? []) {
      const id = String(s.sub_id);
      if (wantMarks.has(id) && Number(s.marks) !== wantMarks.get(id)) {
        problems.push(`Question ${q.number} sub-question ${id} must carry ${wantMarks.get(id)} mark(s), not ${s.marks}.`);
      }
    }
    const subSum = (got.sub_questions ?? []).reduce((a, s) => a + (Number(s.marks) || 0), 0);
    if (want.length === 0 ? Number(got.total_marks) !== q.total : subSum !== q.total) {
      problems.push(
        want.length === 0
          ? `Question ${q.number} total_marks must be ${q.total}.`
          : `Question ${q.number} marks total ${subSum}, must total ${q.total}.`,
      );
    }
  }

  if (questions.some((q) => /Notes for use in qualitative analysis|Tests for anions|BLANK PAGE/i.test(q.question_text ?? ''))) {
    problems.push('Remove all reference-page content (qualitative analysis notes, blank pages) from question_text.');
  }
  return problems;
}

const label = pdfPath.split(/[\\/]/).pop();
console.log(`\n=== ${label}`);
const pages = await readLayout(pdfPath);
const outline = parseOutline(pages, { fileName: label });
if (!outline.usable) {
  console.log('  outline NOT usable:', outline.reasons.join('; '));
  process.exit(1);
}
const expected = expectedSubIds(outline);
console.log(`  outline: ${outline.questions.map((q) => `Q${q.number}:${q.total}`).join(' ')} | columns ${JSON.stringify(outline.columns)}`);

// Optional mark scheme: trimmed exactly as the app does (Phase 4) before sending.
let msBase64 = null;
let msInfo = '';
const msPath = opt('ms', '');
if (msPath && fs.existsSync(msPath)) {
  const msBytes = new Uint8Array(fs.readFileSync(msPath));
  const { detectMarkSchemeTableStart, shouldTrimMarkScheme } = await import('../src/lib/markSchemeDetect.ts');
  const { PDFDocument } = await import('file://' + require.resolve('pdf-lib').replace(/\\/g, '/'));
  const doc = await pdfjs.getDocument({ data: msBytes.slice(), useSystemFonts: true }).promise;
  const msTexts = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    msTexts.push(content.items.map((i) => i.str).join(' '));
  }
  const msPages = doc.numPages;
  if (typeof doc.destroy === 'function') await doc.destroy();
  const start = detectMarkSchemeTableStart(msTexts);
  if (shouldTrimMarkScheme(start, msPages)) {
    const source = await PDFDocument.load(msBytes);
    const target = await PDFDocument.create();
    const indices = Array.from({ length: msPages - start.startPage + 1 }, (_, i) => start.startPage - 1 + i);
    (await target.copyPages(source, indices)).forEach((p) => target.addPage(p));
    msBase64 = Buffer.from(await target.save()).toString('base64');
    msInfo = `${msPages}→${target.getPageCount()} pages (skipped ${start.startPage - 1})`;
  } else {
    msBase64 = Buffer.from(msBytes).toString('base64');
    msInfo = `${msPages} pages (no trim)`;
  }
  console.log(`  mark scheme: ${msInfo}`);
}

const basePrompt = getCambridgePracticalExtractionPrompt(outline, {
  includeGuidance: true,
  hasMarkScheme: Boolean(msBase64),
});
const pdfBase64 = fs.readFileSync(pdfPath).toString('base64');

let parsed = null;
let problems = [];
let attempts = 0;
let usage = {};
const started = Date.now();

while (attempts < maxAttempts) {
  attempts++;
  const prompt = problems.length
    ? `${basePrompt}\n\n## CORRECTION REQUIRED (attempt ${attempts})\nYour previous reply was rejected for these reasons:\n${problems.map((p) => `- ${p}`).join('\n')}\nReturn the complete JSON object again, fixing exactly those points and keeping everything else identical.`
    : basePrompt;
  const raw = await callGemini(pdfBase64, prompt, msBase64);
  usage = raw.usageMetadata ?? usage;
  const text = raw.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  try {
    parsed = extractJson(text);
  } catch (error) {
    problems = [`Your previous reply was not valid JSON (${String(error).slice(0, 120)}). Return strict JSON only, with every string quoted and no stray characters.`];
    if (attempts === maxAttempts) fs.writeFileSync('scratch/extract-raw-failure.json', text);
    continue;
  }
  problems = findProblems(parsed, outline, expected);
  if (!problems.length) break;
}

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`  model: ${model} · ${elapsed}s · ${attempts} attempt(s) · in ${usage.promptTokenCount ?? '?'} / out ${usage.candidatesTokenCount ?? '?'} tokens`);

if (!parsed) {
  console.log('  RESULT: FAIL (no valid JSON after retries)');
  process.exit(1);
}

const questions = parsed.questions ?? [];
for (const q of outline.questions) {
  const got = questions.find((x) => String(x.question_number).trim() === String(q.number));
  const want = expected[q.number];
  const gotSubs = (got?.sub_questions ?? []).map((s) => s.sub_id);
  const sum = (got?.sub_questions ?? []).reduce((a, s) => a + (Number(s.marks) || 0), 0);
  const ok = !problems.some((p) => p.includes(`Question ${q.number}`));
  console.log(
    `  Q${q.number}: ${ok ? 'OK ' : 'DIFF'} ids ${gotSubs.length}/${want.length} ` +
      `Σ${want.length === 0 ? got?.total_marks : sum}/${q.total} textlen=${(got?.question_text ?? '').length}`,
  );
  if (got?.has_diagram) {
    const box = got.bounding_box;
    console.log(
      `      figure: ${got.resource_ref ?? '?'} on p${got.page_number ?? '?'} type=${got.diagram_type ?? '?'} ` +
        `box=${Array.isArray(box) ? '[' + box.join(',') + ']' : 'MISSING'}`,
    );
  }
}
const tables = questions.reduce((a, q) => a + (q.data_tables?.length ?? 0), 0);
console.log(`  leak=${problems.some((p) => p.includes('reference-page')) ? 'YES' : 'no'} · data_tables=${tables}`);
console.log(`  RESULT: ${problems.length === 0 ? 'PASS' : 'FAIL — ' + problems[0]}`);

fs.writeFileSync(`scratch/extract-${label.replace(/[^a-zA-Z0-9]+/g, '-')}.json`, JSON.stringify(parsed, null, 1));
process.exit(problems.length === 0 ? 0 : 1);
