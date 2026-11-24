import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { Packer } from 'docx';

// Minimal browser globals for importing client services in Node
const memStorage = new Map();
if (!globalThis.localStorage) {
  globalThis.localStorage = {
    getItem: (k) => (memStorage.has(k) ? memStorage.get(k) : null),
    setItem: (k, v) => memStorage.set(k, String(v)),
    removeItem: (k) => memStorage.delete(k),
    clear: () => memStorage.clear(),
  };
}
if (!globalThis.window) {
  globalThis.window = {
    localStorage: globalThis.localStorage,
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { origin: 'http://localhost', href: 'http://localhost/' },
  };
}

const {
  fitImageDimensions,
  getImageDimensionsFromBytes,
  prepareDocxImageBytes,
} = await import('../src/utils/docxImageUtils.ts');

const {
  buildStudentPaperDocxDocument,
  sanitizeExamTextForDocx,
  stripDuplicateSubQuestionPrefix,
} = await import('../src/services/docxExportService.ts');

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`PASS: ${label}`);
    passed++;
  } else {
    console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

/**
 * Builds a minimal valid uncompressed PNG binary buffer with the requested IHDR width/height.
 */
function makeMinimalPngBuffer(width, height) {
  // Valid 8-byte PNG signature + IHDR chunk (25 bytes) + empty IDAT + IEND
  const buf = Buffer.alloc(67);
  // PNG signature
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  // IHDR length = 13
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8; // bit depth
  buf[25] = 6; // RGBA
  buf[26] = 0;
  buf[27] = 0;
  buf[28] = 0;
  buf.writeUInt32BE(0, 29); // placeholder CRC (dimension parser only reads IHDR width/height)
  // minimal IDAT
  buf.writeUInt32BE(12, 33);
  buf.write('IDAT', 37, 'ascii');
  buf.writeUInt32BE(0, 49);
  // IEND
  buf.writeUInt32BE(0, 53);
  buf.write('IEND', 57, 'ascii');
  buf.writeUInt32BE(0xae426082, 61);
  return new Uint8Array(buf);
}

/**
 * Builds a minimal JPEG SOF0 buffer with requested pixel dimensions.
 */
function makeMinimalJpegBuffer(width, height) {
  const bytes = Uint8Array.from([
    0xff, 0xd8, // SOI
    0xff, 0xc0, // SOF0
    0x00, 0x0b, // segment length = 11
    0x08, // precision = 8
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01, 0x01, 0x11, 0x00, // 1 component
    0xff, 0xd9, // EOI
  ]);
  return bytes;
}

/**
 * Builds a minimal VP8L lossless WebP buffer with requested dimensions.
 */
function makeMinimalWebpVp8lBuffer(width, height) {
  const buf = Buffer.alloc(25);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(17, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8L', 12, 'ascii');
  buf.writeUInt32LE(5, 16);
  buf[20] = 0x2f; // VP8L signature byte
  const wMinus1 = (width - 1) & 0x3fff;
  const hMinus1 = (height - 1) & 0x3fff;
  const packed = (wMinus1) | (hMinus1 << 14);
  buf.writeUInt32LE(packed >>> 0, 21);
  return new Uint8Array(buf);
}

function toDataUri(mime, bytes) {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

// ── 1. Image Dimension, Type Safety & Proportional Fitting Tests ─────────────

const smallPortraitPng = makeMinimalPngBuffer(37, 78);
const wideLandscapeJpeg = makeMinimalJpegBuffer(1034, 404);
const webpDiagramBytes = makeMinimalWebpVp8lBuffer(512, 256);

const pngDims = getImageDimensionsFromBytes(smallPortraitPng);
check('IMG-1: Reads PNG IHDR dimensions accurately (37x78)', pngDims.format === 'png' && pngDims.width === 37 && pngDims.height === 78);

const jpgDims = getImageDimensionsFromBytes(wideLandscapeJpeg);
check('IMG-2: Reads JPEG SOF0 dimensions accurately (1034x404)', jpgDims.format === 'jpg' && jpgDims.width === 1034 && jpgDims.height === 404);

const webpDims = getImageDimensionsFromBytes(webpDiagramBytes);
check('IMG-3: Reads WebP VP8L dimensions accurately (512x256)', webpDims.format === 'webp' && webpDims.width === 512 && webpDims.height === 256);

const noUpscaleFit = fitImageDimensions(37, 78, 420, 260, false);
check('IMG-4: Does not upscale small 37x78 image', noUpscaleFit.width === 37 && noUpscaleFit.height === 78, JSON.stringify(noUpscaleFit));

const proportionalFit = fitImageDimensions(1034, 404, 420, 260, false);
const expectedRatio = 1034 / 404;
const actualRatio = proportionalFit.width / proportionalFit.height;
check(
  'IMG-5: Preserves 1034x404 aspect ratio within 420x260 box',
  proportionalFit.width <= 420 && proportionalFit.height <= 260 && Math.abs(actualRatio - expectedRatio) < 0.03,
  JSON.stringify(proportionalFit)
);

const webpRejectedWithoutCanvas = await prepareDocxImageBytes(webpDiagramBytes);
check('IMG-6: Rejects raw WebP bytes when DOM canvas transcoding is unavailable (never masquerades as PNG)', webpRejectedWithoutCanvas === null);

// ── 2. Text Sanitizer & Sub-Question Prefix Tests ────────────────────────────

check(
  'TXT-1: Strips duplicated (b)(i) prefixes on line 1, line 2, and mismatched Roman numerals',
  stripDuplicateSubQuestionPrefix('(b) (i) A sample of copper(II) sulfate...', '(b)(i)') === 'A sample of copper(II) sulfate...' &&
    stripDuplicateSubQuestionPrefix('Isotopes are different atoms.\n(i) Explain why.', '(b)(i)') === 'Isotopes are different atoms.\nExplain why.' &&
    stripDuplicateSubQuestionPrefix('(iv) kills microbes in water', '(a)(i)') === 'kills microbes in water'
);
check(
  'TXT-2: Strips leaked [Figure X.Y: ...] placeholders, fixes Table 7.1to spacing, and drops duplicate standalone Table captions',
  sanitizeExamTextForDocx('Study Table 7.1to compare. [Figure 3.1: apparatus diagram] Table 1.2. Table 2.1 shows values.', { isStudentPaper: true }) ===
    'Study Table 7.1 to compare. Table 2.1 shows values.' &&
    sanitizeExamTextForDocx('Complete Table 8.1 to describe bonding.\nTable 2.1', { isStudentPaper: true }) ===
      'Complete Table 8.1 to describe bonding.'
);

// ── 3. End-to-End Student Paper DOCX Generation & OOXML XML Inspection ───────

const syntheticQuestions = [
  {
    id: 'q1',
    question_number: 1,
    question_style: 'Structured',
    marks: 5,
    diagram_url: toDataUri('image/png', smallPortraitPng),
    question_text:
      'Use the information to solve $\\frac{3}{4} + \\sqrt{x^2 + 1}$.\n\nComplete the bullet steps below:\n- Balance $\\ce{CuSO4.5H2O}$ hydration\n- Costs \\$15 per sample [Figure 1.1: glassware setup]',
    sub_questions: [
      {
        sub_id: '(a)(i)',
        question_text: '(i) Identify nuclides $^{37}_{17}\\text{Cl}$ and ion $^{63}_{29}\\text{Cu}^{+}$ by completing the table:\nTable 2.1\n\n| Particle | Proton number | Nucleon number | Electron count |\n| :--- | :---: | :---: | :---: |\n| Cl atom | 17 | ☐ | [ ] and e- |\n| Cu+ ion | 29 | 63 | [ ] and [ ] |\n\nComplete missing values.',
        marks: 2,
      },
      {
        sub_id: '(b)(i)',
        question_text: '(b) Explain why Table 7.1to results differ in reversible reaction $A \\rightleftharpoons B$.',
        marks: 3,
      },
    ],
  },
  {
    id: 'q2',
    question_number: 2,
    question_style: 'Structured',
    marks: 4,
    diagram_url: toDataUri('image/jpeg', wideLandscapeJpeg),
    question_text: 'Analyse the chromatogram and velocity equation $v = \\frac{d}{t} \\times 10^{-2}$.',
  },
];

const doc = await buildStudentPaperDocxDocument(
  {
    title: 'Grade 10 Chemistry Mock Paper',
    subject: 'Chemistry',
    subjectCode: '0620',
    durationMinutes: 60,
    instructions: 'Answer all questions.\nShow working.',
  },
  syntheticQuestions,
  {
    template: 'cambridge_official',
    includeAnswerLines: true,
    linesPerMark: 2,
    answerLineStyle: 'dotted',
    schoolLogoUrl: toDataUri('image/png', makeMinimalPngBuffer(200, 50)),
  }
);

const docxBuffer = await Packer.toBuffer(doc);
const zip = await JSZip.loadAsync(docxBuffer);
const docXml = await zip.file('word/document.xml')?.async('string');
assert.ok(docXml && docXml.length > 0, 'word/document.xml must exist');

// Extract plain text nodes & math nodes
const allText = [...docXml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]).join('');
const mathText = [...docXml.matchAll(/<m:t[^>]*>([\s\S]*?)<\/m:t>/g)].map((m) => m[1]).join('');
const combinedText = `${allText} ${mathText}`;

// Image media byte verification (skip directory entries like "word/media/")
const mediaFiles = Object.keys(zip.files).filter((f) => f.startsWith('word/media/') && !zip.files[f].dir);
let badMediaBytes = 0;
for (const mf of mediaFiles) {
  const bytes = await zip.file(mf).async('uint8array');
  const head = Buffer.from(bytes.slice(0, 12)).toString('ascii');
  if (head.startsWith('RIFF') || head.includes('<svg')) {
    badMediaBytes++;
  }
}
check('DOCX-1: Zero corrupt RIFF/WebP or SVG bytes inside word/media/', badMediaBytes === 0 && mediaFiles.length >= 2, `media=${mediaFiles.join(',')}`);

// Native EMU dimensions check (37x78 portrait must stay 37x78 px = 352425 x 742950 EMUs, not 380x220!)
const smallPortraitEmuCx = String(37 * 9525);
const smallPortraitEmuCy = String(78 * 9525);
const landscapeEmuCx = String(proportionalFit.width * 9525);
const landscapeEmuCy = String(proportionalFit.height * 9525);
check(
  'DOCX-2: Embedded images use true proportional EMU dimensions (no upscaling or stretching)',
  docXml.includes(`cx="${smallPortraitEmuCx}" cy="${smallPortraitEmuCy}"`) &&
    docXml.includes(`cx="${landscapeEmuCx}" cy="${landscapeEmuCy}"`),
  `expected ${smallPortraitEmuCx}x${smallPortraitEmuCy} & ${landscapeEmuCx}x${landscapeEmuCy}`
);

// Fixed DXA Table Grids (zero gridCol w:w="100")
const gridColWidths = [...docXml.matchAll(/<w:gridCol\s+w:w="(\d+)"/g)].map((m) => Number(m[1]));
check(
  'DOCX-3: All OOXML tables have valid DXA gridCol widths >= 400 twips and fixed layout',
  gridColWidths.length > 5 && gridColWidths.every((w) => w >= 400) && docXml.includes('<w:tblLayout w:type="fixed"/>'),
  `minGridCol=${Math.min(...gridColWidths)}`
);

// Sub-question Markdown table rendered natively & no ☐ leaked
check(
  'DOCX-4: Sub-question Markdown table rendered natively with zero pipe syntax or ☐ placeholders',
  !combinedText.includes('| Particle |') && !combinedText.includes('☐') && combinedText.includes('Proton number'),
  combinedText.slice(0, 200)
);

// Smart answer-line suppression: 1 Candidate Name line (cover) + Q1(b)(i) (3*2=6 lines) + Q2 (4*2=8 lines) = 15 dotted lines; Q1(a)(i) table (2*2=4 lines) suppressed!
const dotTabMatches = docXml.match(/<w:tab\b[^>]*w:leader="dot"/g) || [];
const paragraphXmls = docXml.match(/<w:p\b[\s\S]*?<\/w:p>/g) || [];
const hasBulletParagraphs =
  paragraphXmls.some((p) => p.includes('Balance') && !p.includes('Costs')) &&
  paragraphXmls.some((p) => p.includes('Costs') && !p.includes('Balance'));
check(
  'DOCX-5: Suppresses redundant dotted answer lines under pure completion table, keeps essay lines & separate bullets',
  dotTabMatches.length === 15 && hasBulletParagraphs,
  `dotTabCount=${dotTabMatches.length}, hasBulletParagraphs=${hasBulletParagraphs}`
);

// Native OMML Math elements rendered cleanly, zero leaked raw LaTeX
check(
  'DOCX-6: Renders native OMML <m:f>, <m:rad>, <m:sPre> for fractions/roots/isotopes without leaking raw LaTeX',
  docXml.includes('<m:oMath>') &&
    docXml.includes('<m:f>') &&
    docXml.includes('<m:rad>') &&
    docXml.includes('<m:sPre>') &&
    !combinedText.includes('\\frac') &&
    !combinedText.includes('\\sqrt') &&
    !combinedText.includes('\\ce{') &&
    !combinedText.includes('\\text{') &&
    combinedText.includes('$15') &&
    combinedText.includes('⇌'),
  combinedText
);

// Student paper hygiene: stripped duplicate prefixes, placeholders, fused Table labels, native NUMPAGES
check(
  'DOCX-7: Strips duplicate sub-question prefixes, leaked placeholders, fused table text, and uses NUMPAGES',
  !combinedText.includes('(a)(i) (i)') &&
    !combinedText.includes('(b)(i) (b)') &&
    !combinedText.includes('[Figure 1.1:') &&
    !combinedText.includes('Table 7.1to') &&
    combinedText.includes('Table 7.1 to') &&
    docXml.includes('NUMPAGES'),
  ''
);

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
