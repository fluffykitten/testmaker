import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfjs = await import('file://' + require.resolve('pdfjs-dist/legacy/build/pdf.mjs').replace(/\\/g, '/'));
const { PDFDocument } = await import('file://' + require.resolve('pdf-lib').replace(/\\/g, '/'));
const { parseOutline } = await import('../src/lib/paperOutlineParse.ts');
const { classifySubject } = await import('../src/lib/subjectClassifier.ts');
const { detectMarkSchemeTableStart, shouldTrimMarkScheme } = await import('../src/lib/markSchemeDetect.ts');
const { getHumanitiesExtractionPrompt } = await import('../src/lib/humanitiesPrompt.ts');

// 1. Read API credentials from .env.local
const envContent = fs.readFileSync('.env.local', 'utf8');
const apiKey = envContent.match(/^VITE_GEMINI_API_KEY=(.*)/m)?.[1]?.trim();
const modelArg = process.argv.find((a) => a.startsWith('--model='));
const model = modelArg ? modelArg.split('=')[1] : (process.env.MODEL || envContent.match(/^VITE_GEMINI_MODEL=(.*)/m)?.[1]?.trim() || 'gemini-3.8-flash');

if (!apiKey) {
  console.error('FATAL: VITE_GEMINI_API_KEY not found in .env.local');
  process.exit(1);
}

console.log(`[SIMULATION] Initializing IGCSE Geography (0460) extraction with model: ${model}`);

const nonFlagArgs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const qpFile = nonFlagArgs[0] || 'igcse geography paper/Paper 1-Questions-0460_11-May_June-2023.pdf';
const msFile = nonFlagArgs[1] || 'igcse geography paper/Paper 1-Mark Scheme-0460-May_June-2023.pdf';
const insertFile = nonFlagArgs[2] || (fs.existsSync('igcse geography paper/Paper 1-Insert-0460-11-May_June2023-pdf.pdf') ? 'igcse geography paper/Paper 1-Insert-0460-11-May_June2023-pdf.pdf' : null);

console.log(`[SIMULATION] Question Paper: ${qpFile}`);
console.log(`[SIMULATION] Mark Scheme:    ${msFile}`);
console.log(`[SIMULATION] Insert Booklet: ${insertFile ?? 'None'}`);

// Helper to read PDF layout
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
        .filter((i) => i.s.trim() !== ''),
    });
  }
  if (typeof doc.destroy === 'function') await doc.destroy();
  return pages;
}

// 2. Pre-processing: Subject Classification
console.log('\n--- STAGE 1: PRE-FLIGHT DETERMINISTIC CLASSIFICATION ---');
const qpPages = await readPages(qpFile);
const qpTexts = qpPages.map((p) => p.items.map((i) => i.s).join(' '));
const match = classifySubject(qpTexts, { fileName: path.basename(qpFile) });

console.log('Subject Classification:', match ? {
  syllabusCode: match.syllabusCode,
  subjectName: match.profile.subjectName,
  domain: match.profile.domain,
  paperCode: match.paperCode,
  hasInsertByDefault: match.profile.hasInsertByDefault,
  isOptionalChoicePaper: match.profile.isOptionalChoicePaper,
  standardTotalMarks: match.profile.standardTotalMarks,
} : 'UNRECOGNIZED');

// 3. Pre-processing: Outline Parsing
console.log('\n--- STAGE 2: DETERMINISTIC PAPER OUTLINE ---');
const outline = parseOutline(qpPages, { fileName: path.basename(qpFile) });
console.log('Outline Usable:', outline.usable);
console.log('Profile:', JSON.stringify(outline.profile));
console.log('Option Groups:', JSON.stringify(outline.profile.optionGroups));
console.log('Reasons:', outline.reasons);
console.log(`Questions found: ${outline.questions.length}`);
for (const q of outline.questions) {
  console.log(`  Q${q.number} (Section ${q.section || 'None'}): ${q.subs.length} sub-parts, declared total: ${q.declaredTotal}, sum: ${q.total}`);
  console.log(`    Sub-IDs: ${q.subs.map((s) => s.id + (s.marks != null ? `[${s.marks}]` : '')).join(', ')}`);
}

// 4. Pre-processing: Mark Scheme Preamble Trimming
console.log('\n--- STAGE 3: MARK SCHEME PREAMBLE TRIMMING ---');
const msPages = await readPages(msFile);
const msTexts = msPages.map((p) => p.items.map((i) => i.s).join(' '));
const start = detectMarkSchemeTableStart(msTexts);
console.log(`Original MS Pages: ${msPages.length}`);
console.log(`Trim Boundary Detected: startPage=${start.startPage}, method=${start.method}, rubricPage=${start.rubricPage ?? 'none'}`);

let trimmedMsBytes;
const rawMsBytes = new Uint8Array(fs.readFileSync(msFile));
if (shouldTrimMarkScheme(start, msPages.length)) {
  const source = await PDFDocument.load(rawMsBytes);
  const target = await PDFDocument.create();
  const indices = Array.from({ length: msPages.length - start.startPage + 1 }, (_, i) => start.startPage - 1 + i);
  const copied = await target.copyPages(source, indices);
  copied.forEach((page) => target.addPage(page));
  trimmedMsBytes = await target.save();
  console.log(`Trimmed ${start.startPage - 1} preamble pages. Sending pages ${start.startPage}–${msPages.length} to Gemini.`);
} else {
  trimmedMsBytes = rawMsBytes;
  console.log(`No trimming applied. Sending all ${msPages.length} pages.`);
}

// 5. Pre-processing: Insert Booklet Inspection (if present)
const hasInsert = Boolean(insertFile && fs.existsSync(insertFile));
if (hasInsert) {
  console.log('\n--- STAGE 4: INSERT BOOKLET INSPECTION ---');
  const insertPages = await readPages(insertFile);
  console.log(`Insert Pages: ${insertPages.length}`);
  for (const p of insertPages) {
    const t = p.items.map((i) => i.s).join(' ').replace(/\s+/g, ' ');
    const figMatch = t.match(/Fig\.\s*\d+\.\d+/gi);
    console.log(`  Page ${p.page} (${t.length} chars): ${figMatch ? `Contains ${figMatch.join(', ')}` : 'Cover / no fig'}`);
  }
}

// 6. Build Extraction Prompt
console.log('\n--- STAGE 5: PROMPT GENERATION ---');
const promptText = getHumanitiesExtractionPrompt(
  hasInsert,
  true,  // includeGuidance
  hasInsert, // extractResourceCatalog
  true,  // isIgcse
  match?.profile
);
console.log(`Prompt character length: ${promptText.length}`);

// 7. Call Gemini Multimodal API
console.log('\n--- STAGE 6: CALLING GEMINI MULTIMODAL API ---');
const qpBase64 = Buffer.from(fs.readFileSync(qpFile)).toString('base64');
const msBase64 = Buffer.from(trimmedMsBytes).toString('base64');

const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
const parts = [
  { text: promptText },
  { inlineData: { mimeType: 'application/pdf', data: qpBase64 } },
];

if (hasInsert) {
  const insertBase64 = Buffer.from(fs.readFileSync(insertFile)).toString('base64');
  parts.push({ inlineData: { mimeType: 'application/pdf', data: insertBase64 } });
}

parts.push({ inlineData: { mimeType: 'application/pdf', data: msBase64 } });

const requestBody = {
  contents: [{ parts }],
  generationConfig: {
    responseMimeType: 'application/json',
    temperature: 0.1,
    maxOutputTokens: 32768,
  },
};

console.log(`Payload parts:`);
console.log(`  1. QP PDF:     ${(qpBase64.length / 1024 / 1024).toFixed(2)} MB base64`);
if (hasInsert) {
  const insertBase64Len = Buffer.from(fs.readFileSync(insertFile)).length;
  console.log(`  2. Insert PDF: ${(insertBase64Len / 1024 / 1024).toFixed(2)} MB raw`);
}
console.log(`  3. Trimmed MS: ${(msBase64.length / 1024 / 1024).toFixed(2)} MB base64`);

const startTime = Date.now();
console.log(`[HTTP POST] Sending multimodal request to Gemini API (${model})...`);

try {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[HTTP ${res.status}] Response received in ${elapsed}s`);

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Gemini API Error:`, errText);
    process.exit(1);
  }

  const json = await res.json();
  const candidate = json.candidates?.[0];
  const usage = json.usageMetadata;

  console.log('\n--- STAGE 7: TOKEN USAGE & FINISH REASON ---');
  console.log(`Finish Reason: ${candidate?.finishReason}`);
  console.log(`Prompt Tokens:     ${usage?.promptTokenCount}`);
  console.log(`Candidates Tokens: ${usage?.candidatesTokenCount}`);
  console.log(`Total Tokens:      ${usage?.totalTokenCount}`);

  const rawText = candidate?.content?.parts?.[0]?.text;
  if (!rawText) {
    console.error('FATAL: No text returned in candidate parts');
    process.exit(1);
  }

  const parsed = JSON.parse(rawText);
  const outPath = `scripts/extraction-igcse-geography-${model}.json`;
  fs.writeFileSync(outPath, JSON.stringify(parsed, null, 2));
  console.log(`\nSuccessfully wrote full parsed JSON to ${outPath}`);

  console.log('\n--- STAGE 8: EXTRACTION VALIDATION ---');
  console.log('Paper Metadata:', parsed.paper_metadata);
  if (parsed.insert_resources) {
    console.log(`Insert Resources: ${parsed.insert_resources.length} items extracted`);
    for (const r of parsed.insert_resources) {
      console.log(`  [${r.id}] "${r.title}" (p.${r.page_number}) -> ${r.target_questions?.join(', ')}`);
    }
  }

  const extractedQuestions = parsed.questions || [];
  console.log(`\nExtracted ${extractedQuestions.length} parent questions:`);
  let totalMarksSum = 0;
  for (const q of extractedQuestions) {
    const subCount = q.sub_questions?.length ?? 0;
    const qMarks = q.total_marks ?? q.sub_questions?.reduce((acc, sq) => acc + (sq.marks || 0), 0) ?? 0;
    totalMarksSum += qMarks;
    console.log(`  Question ${q.question_number}: ${subCount} sub-parts, ${qMarks} marks, Diagram: ${q.has_diagram ? `[${q.diagram_source}] ${q.resource_ref || 'fig'}` : 'none'}`);
    for (const sq of q.sub_questions || []) {
      const diagStr = sq.has_diagram ? ` [${sq.diagram_source || 'qp'}: ${sq.resource_ref || 'fig'}]` : '';
      console.log(`    - ${sq.sub_id} (${sq.marks}m)${diagStr}: ${(sq.question_text || '').slice(0, 70)}...`);
    }
  }
  console.log(`\nTotal Printed Marks Sum: ${totalMarksSum}`);
  console.log('--- SIMULATION COMPLETE ---');

} catch (err) {
  console.error('Fatal Simulation Error:', err);
  process.exit(1);
}

