import assert from 'node:assert/strict';
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix {};
}
const { normalizeQuestionStyle } = await import('../src/types/database.ts');
const {
  parseTableChoiceFromQuestion,
  serializeTableChoiceToQuestion,
} = await import('../src/lib/tableChoiceUtils.ts');
const { normalizeQuestionStyles } = await import('../src/lib/pdfProcessor.ts');
const { gradeSubmissionDeterministically } = await import('../src/services/deterministicGradingService.ts');

let passed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    process.exit(1);
  }
}

// 1. Style normalization precedence
check(
  'TC-1: normalizeQuestionStyle maps table_choice / Table Choice before MCQ options fallback',
  normalizeQuestionStyle('table_choice', ['A. Tepat, Tepat, Tidak Tepat', 'B. Salah']) === 'Table Choice' &&
    normalizeQuestionStyle('Table Choice', null) === 'Table Choice' &&
    normalizeQuestionStyle('statement matrix', null) === 'Table Choice'
);

// 2. Parse & serialize round-trip (including Indonesian "Upaya" + "Tepat / Tidak Tepat" screenshot case)
const sampleQuestionText = [
  'Gelombang resesi ekonomi global menyebabkan permintaan ekspor menurun tajam.',
  '',
  'Tentukan Tepat atau Tidak Tepat untuk setiap pernyataan berikut:',
  '',
  '| No. | Upaya | Tepat | Tidak Tepat |',
  '|---|---|---|---|',
  '| 1 | Mengembangkan program padat karya untuk menciptakan kesempatan kerja bagi pekerja terdampak PHK. | [ ] | [ ] |',
  '| 2 | Memperluas program Kredit Usaha Rakyat (KUR) untuk mendukung pertumbuhan usaha produktif masyarakat. | [ ] | [ ] |',
  '| 3 | Menyelenggarakan pelatihan keterampilan yang sesuai dengan kebutuhan pekerjaan di industri garmen. | [ ] | [ ] |',
].join('\n');

const sampleMarkScheme = {
  marking_points: [
    '1. Mengembangkan program padat karya untuk menciptakan kesempatan kerja bagi pekerja terdampak PHK.: Tepat',
    '2. Memperluas program Kredit Usaha Rakyat (KUR) untuk mendukung pertumbuhan usaha produktif masyarakat.: Tepat',
    '3. Menyelenggarakan pelatihan keterampilan yang sesuai dengan kebutuhan pekerjaan di industri garmen.: Tidak Tepat',
  ],
};

const parsed = parseTableChoiceFromQuestion(sampleQuestionText, sampleMarkScheme);
check(
  'TC-2: parseTableChoiceFromQuestion extracts Upaya header, Tepat/Tidak Tepat columns, 3 rows, and per-row keys',
  parsed.itemHeader === 'Upaya' &&
    parsed.columns.length === 2 &&
    parsed.columns[0] === 'Tepat' &&
    parsed.columns[1] === 'Tidak Tepat' &&
    parsed.rows.length === 3 &&
    parsed.rows[0].correctColumn === 'Tepat' &&
    parsed.rows[1].correctColumn === 'Tepat' &&
    parsed.rows[2].correctColumn === 'Tidak Tepat',
  JSON.stringify(parsed)
);

const serialized = serializeTableChoiceToQuestion(parsed);
const reparsed = parseTableChoiceFromQuestion(serialized.questionText, {
  marking_points: serialized.markingPoints,
});
check(
  'TC-3: serializeTableChoiceToQuestion round-trips cleanly back through parseTableChoiceFromQuestion',
  reparsed.itemHeader === 'Upaya' &&
    reparsed.rows.length === 3 &&
    reparsed.rows[2].correctColumn === 'Tidak Tepat'
);

// 3. PDF normalization fixes misclassified Tepat/Tidak Tepat + A. Tepat... options
const [normalizedPdfQ] = normalizeQuestionStyles([
  {
    question_number: '12',
    question_text: sampleQuestionText,
    question_style: 'Multiple Choice',
    topic: 'Economics',
    difficulty: 'Medium',
    marks: 3,
    options: ['A. Tepat, Tepat, Tidak Tepat', 'B. Tepat, Tidak Tepat, Tepat'],
    mark_scheme: sampleMarkScheme,
  },
]);
check(
  'TC-4: pdfProcessor.normalizeQuestionStyles converts Tepat/Tidak Tepat matrix to Table Choice & clears stale options',
  normalizedPdfQ.question_style === 'Table Choice' && normalizedPdfQ.options === null,
  `style=${normalizedPdfQ.question_style}, options=${JSON.stringify(normalizedPdfQ.options)}`
);

// 4. Deterministic grading: full credit (3/3), partial credit (2/3), zero credit (0/3)
const tableQuestion = {
  id: 'q-tc-1',
  syllabus_id: 'syl-1',
  year: 2026,
  series: 'Nov',
  paper_number: 1,
  question_number: '1',
  question_text: serialized.questionText,
  question_style: 'Table Choice',
  topic: 'Economics',
  difficulty: 'Medium',
  marks: 3,
  options: null,
  mark_scheme: { marking_points: serialized.markingPoints },
  created_at: '2026-11-21T00:00:00.000Z',
};

const buildAnswerString = (choices) =>
  parsed.rows.map((r, i) => `${i + 1}. ${r.label}: ${choices[i]}`).join('; ');

const gradedFull = gradeSubmissionDeterministically(
  {
    id: 'sub-tc-full',
    quizId: 'quiz-tc',
    quizCode: 'TC01',
    quizTitle: 'Table Choice Test',
    subject: 'Economics',
    studentName: 'Test Student',
    studentClass: '10A',
    candidateNumber: '01',
    submittedAt: '2026-11-21T00:00:00.000Z',
    durationSeconds: 30,
    score: 0,
    totalMarks: 3,
    percentage: 0,
    violationsCount: 0,
    proctoringLogs: [],
    rawAnswers: { '0': buildAnswerString(['Tepat', 'Tepat', 'Tidak Tepat']) },
    questionResults: [],
    topicBreakdown: {},
  },
  [tableQuestion]
);
check(
  'TC-5: deterministicGradingService awards 3/3 for all correct Table Choice rows',
  gradedFull.updatedSub.score === 3 && gradedFull.updatedSub.totalMarks === 3,
  `score=${gradedFull.updatedSub.score}/${gradedFull.updatedSub.totalMarks}`
);

const gradedPartial = gradeSubmissionDeterministically(
  {
    id: 'sub-tc-partial',
    quizId: 'quiz-tc',
    quizCode: 'TC01',
    quizTitle: 'Table Choice Test',
    subject: 'Economics',
    studentName: 'Test Student',
    studentClass: '10A',
    candidateNumber: '01',
    submittedAt: '2026-11-21T00:00:00.000Z',
    durationSeconds: 30,
    score: 0,
    totalMarks: 3,
    percentage: 0,
    violationsCount: 0,
    proctoringLogs: [],
    rawAnswers: { '0': buildAnswerString(['Tepat', 'Tidak Tepat', 'Tidak Tepat']) },
    questionResults: [],
    topicBreakdown: {},
  },
  [tableQuestion]
);
check(
  'TC-6: deterministicGradingService awards partial credit (2/3) when 2 of 3 rows match',
  gradedPartial.updatedSub.score === 2 && gradedPartial.updatedSub.totalMarks === 3,
  `score=${gradedPartial.updatedSub.score}/${gradedPartial.updatedSub.totalMarks}`
);

assert.equal(passed, 6);
console.log(`\n🎉 All ${passed} Table Choice tests passed!`);
