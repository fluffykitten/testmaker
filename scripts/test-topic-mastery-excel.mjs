import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';

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
  DEFAULT_TOPIC_MASTERY_TIERS,
  normalizeTopicMasteryTiers,
  validateTopicMasteryTiers,
  computeSubmissionTopicMastery,
} = await import('../src/lib/topicMastery.ts');

const {
  buildSingleSubmissionWorkbookICM,
  buildBatchSingleSubmissionsZipBlobICM,
} = await import('../src/services/icmExcelExportService.ts');

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

// ── 1. Topic Mastery Normalization, Validation & Calculation ──────────────────

const badValidation = validateTopicMasteryTiers([
  { id: 't1', minPercentage: 80, label: 'High', color: 'emerald' },
  { id: 't2', minPercentage: 80, label: '', color: 'blue' },
]);
check(
  'TM-1: Rejects missing 0% floor, empty label, and duplicate percentages',
  !badValidation.ok && badValidation.errors.length >= 3,
  JSON.stringify(badValidation.errors)
);

const customTiers = normalizeTopicMasteryTiers([
  { id: 'd', minPercentage: 85, label: '+Distinction', color: 'emerald', recommendation: 'Extension work' },
  { id: 'c', minPercentage: 65, label: 'Competent', color: 'blue', recommendation: 'Targeted review' },
  { id: 'r', minPercentage: 0, label: 'Remedial', color: 'crimson', recommendation: 'Foundational drill' },
]);

check(
  'TM-2: Normalizes and sorts custom tiers descending with 0% baseline',
  customTiers.length === 3 &&
    customTiers[0].minPercentage === 85 &&
    customTiers[1].minPercentage === 65 &&
    customTiers[2].minPercentage === 0
);

const sampleSubmission = {
  id: 'sub-1',
  quizId: 'quiz-1',
  quizCode: 'BIO12',
  quizTitle: 'A-Level Biology Mock',
  subject: 'Biology',
  studentName: 'Aisyah Putri',
  studentClass: '12-A',
  candidateNumber: '0104',
  submittedAt: '2026-11-16T10:15:00.000Z',
  durationSeconds: 1840,
  score: 15,
  totalMarks: 22,
  percentage: 68.2,
  violationsCount: 0,
  proctoringLogs: [],
  topicBreakdown: {
    'Cell Biology': { totalMarks: 10, earnedMarks: 9, percentage: 90 },
  },
  questionResults: [
    {
      questionId: 'q1',
      questionNumber: 1,
      topic: 'Cell Biology',
      maxMarks: 4,
      earnedMarks: 4,
      isCorrect: true,
      studentAnswer: 'Mitosis',
      correctAnswer: 'Mitosis',
    },
    {
      questionId: 'q2',
      questionNumber: 2,
      topic: 'cell biology',
      maxMarks: 6,
      earnedMarks: 5,
      isCorrect: false,
      studentAnswer: 'Osmosis',
      correctAnswer: 'Active transport',
    },
    {
      questionId: 'q3',
      questionNumber: 3,
      topic: 'Genetics',
      maxMarks: 6,
      earnedMarks: 4,
      isCorrect: false,
      studentAnswer: 'Aa',
      correctAnswer: 'AaBb',
    },
    {
      questionId: 'q4',
      questionNumber: 4,
      topic: '=cmd|"/C calc"!A0',
      maxMarks: 6,
      earnedMarks: 2,
      isCorrect: false,
      studentAnswer: '0',
      correctAnswer: '4',
    },
  ],
};

const defaultEntries = computeSubmissionTopicMastery(sampleSubmission, DEFAULT_TOPIC_MASTERY_TIERS);
check(
  'TM-3: Merges case-variant topics from questionResults & sorts by percentage',
  defaultEntries.length === 3 &&
    defaultEntries[0].topic === 'Cell Biology' &&
    defaultEntries[0].earnedMarks === 9 &&
    defaultEntries[0].totalMarks === 10 &&
    defaultEntries[0].percentage === 90 &&
    defaultEntries[0].questionNumbers.join(', ') === 'Q1, Q2' &&
    defaultEntries[0].tier.label === 'Mastered' &&
    defaultEntries[1].tier.label === 'Developing' &&
    defaultEntries[2].tier.label === 'Needs Support'
);

const fallbackSubmission = {
  ...sampleSubmission,
  id: 'sub-fallback',
  studentName: 'Budi Santoso',
  candidateNumber: '0105',
  questionResults: [],
  topicBreakdown: {
    Enzymes: { totalMarks: 10, earnedMarks: 7, percentage: 70 },
    Ecology: { totalMarks: 10, earnedMarks: 4, percentage: 40 },
  },
};

const fallbackEntries = computeSubmissionTopicMastery(fallbackSubmission, customTiers);
check(
  'TM-4: Falls back to submission.topicBreakdown when questionResults is empty & applies custom Admin tiers',
  fallbackEntries.length === 2 &&
    fallbackEntries[0].topic === 'Enzymes' &&
    fallbackEntries[0].tier.label === 'Competent' &&
    fallbackEntries[1].topic === 'Ecology' &&
    fallbackEntries[1].tier.label === 'Remedial'
);

// ── 2. Excel Workbook Dual-Logo Banner & Topic Mastery Sheets Verification ────

const { wb } = buildSingleSubmissionWorkbookICM(sampleSubmission, { masteryTiers: customTiers });
const buffer = await wb.xlsx.writeBuffer();
const parsedWb = new ExcelJS.Workbook();
await parsedWb.xlsx.load(buffer);

const wsOverview = parsedWb.getWorksheet('Candidate Overview');
const wsTopic = parsedWb.getWorksheet('Topic Mastery');
const wsResp = parsedWb.getWorksheet('Responses & Solutions');

check('TM-5: Workbook includes Candidate Overview, Topic Mastery, and Responses & Solutions tabs', Boolean(wsOverview && wsTopic && wsResp));

const overviewImages = wsOverview.getImages();
check(
  'TM-6: Candidate Overview embeds 2 logos anchored as oneCell preserving exact natural aspect ratios',
  overviewImages.length === 2 &&
    overviewImages.every((img) => img.range?.editAs === 'oneCell') &&
    Math.abs((overviewImages[0].range?.ext?.width || 0) / (overviewImages[0].range?.ext?.height || 1) - 222 / 71) < 0.05 &&
    Math.abs((overviewImages[1].range?.ext?.width || 0) / (overviewImages[1].range?.ext?.height || 1) - 215 / 64) < 0.05,
  JSON.stringify(
    overviewImages.map((i) => ({
      editAs: i.range?.editAs,
      ext: i.range?.ext,
      tlCol: i.range?.tl?.col,
    }))
  )
);

// Verify Row 4 metadata stays bounded strictly inside F (col 6) on Candidate Overview (no spillover into col G..J)
let row4Overflow = false;
for (let c = 7; c <= 12; c++) {
  const val = wsOverview.getRow(4).getCell(c).value;
  if (val !== null && val !== undefined && val !== '') {
    row4Overflow = true;
  }
}
check('TM-7: Metadata banner on Candidate Overview does not overflow past column F', !row4Overflow);

check(
  'TM-8: Candidate Overview renders compact Topic Mastery Summary + escapes formula payloads',
  wsOverview.getCell('A15').value === 'TOPIC MASTERY SUMMARY' &&
    wsOverview.getCell('A17').value === 'Cell Biology' &&
    wsOverview.getCell('F17').value === "'+Distinction" &&
    String(wsOverview.getCell('A19').value).startsWith("'=cmd")
);

const topicImages = wsTopic.getImages();
check(
  'TM-9: Dedicated Topic Mastery tab embeds both dual logos cleanly & contains Overall footer row',
  topicImages.length === 2 &&
    wsTopic.getCell('A7').value === 'Cell Biology' &&
    wsTopic.getCell('B7').value === 'Q1, Q2' &&
    wsTopic.getCell('C7').value === 2 &&
    wsTopic.getCell('D7').value === 9 &&
    wsTopic.getCell('E7').value === 10 &&
    wsTopic.getCell('A10').value === 'OVERALL ASSESSMENT TOTAL'
);

// Legacy submission with no topic data anywhere
const noTopicSubmission = {
  ...sampleSubmission,
  id: 'sub-notopic',
  questionResults: [],
  topicBreakdown: {},
};
const { wb: noTopicWb } = buildSingleSubmissionWorkbookICM(noTopicSubmission);
const noTopicWs = noTopicWb.getWorksheet('Topic Mastery');
check(
  'TM-10: Empty topic metadata renders graceful informational row instead of broken table',
  String(noTopicWs.getCell('A7').value).includes('No topic metadata')
);

// ── 3. Batch Individual Excel ZIP Export Verification ─────────────────────────

const batchSubs = [
  sampleSubmission,
  {
    ...sampleSubmission,
    id: 'sub-2',
    studentName: 'Aisyah Putri', // Intentional identical name to test collision handling!
    candidateNumber: '0109',
    studentClass: '12-A',
  },
  {
    ...fallbackSubmission,
    studentClass: '12-B',
  },
];

const progressEvents = [];
const zipFiltered = await buildBatchSingleSubmissionsZipBlobICM(batchSubs, {
  quizTitle: 'Biology Mock 2026',
  selectedClass: '12-A',
  masteryTiers: customTiers,
  onProgress: (done, total) => progressEvents.push(`${done}/${total}`),
});

check(
  'TM-11: Batch ZIP respects selectedClass filter and deduplicates identical student filenames',
  zipFiltered.count === 2 &&
    zipFiltered.entries.length === 2 &&
    new Set(zipFiltered.entries).size === 2 &&
    zipFiltered.zipFilename === 'biology_mock_2026_12-a_individual_reports.zip' &&
    progressEvents.join(',') === '1/2,2/2',
  JSON.stringify(zipFiltered.entries)
);

const zipArrayBuf = await zipFiltered.blob.arrayBuffer();
const loadedZip = await JSZip.loadAsync(zipArrayBuf);
const zipFileNames = Object.keys(loadedZip.files);
let allValidWorkbooks = zipFileNames.length === 2;
for (const fname of zipFileNames) {
  const fileBuf = await loadedZip.files[fname].async('arraybuffer');
  const wbCheck = new ExcelJS.Workbook();
  await wbCheck.xlsx.load(fileBuf);
  if (!wbCheck.getWorksheet('Topic Mastery') || !wbCheck.getWorksheet('Candidate Overview')) {
    allValidWorkbooks = false;
  }
}
check('TM-12: Every .xlsx file inside the downloaded .zip opens validly and contains Topic Mastery', allValidWorkbooks);

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
assert.equal(failed, 0, `${failed} assertion(s) failed`);
