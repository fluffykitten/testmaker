if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

import fs from 'node:fs';
import path from 'node:path';
import { sanitizeQuestionsForStudent } from '../src/lib/examSubmissionGuards.ts';
import { resolveStudentQuiz } from '../src/services/quizCodeService.ts';
import { PILOT_QUIZ_CODE } from '../src/data/pilotExam170Data.ts';

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    console.log(`PASS  ${name}`);
    passed += 1;
  } else {
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failed += 1;
  }
}

console.log('🧪 Testing Phase 1 Security Hardening Regressions...\n');

// 1-2. sanitizeQuestionsForStudent strips mark schemes AND source_pdf_url
const sampleQuestions = [
  {
    id: 'q1',
    syllabus_id: 's1',
    paper_number: '1',
    year: 2025,
    series: 'm',
    question_number: '1',
    question_text: 'Sample stem',
    marks: 2,
    topic: 'Energetics',
    question_style: 'Structured',
    source_pdf_url: 'https://testmaker-media.icmadani.workers.dev/papers/chem_2025_mj_qp_21.pdf',
    mark_scheme: { answer: 'Exothermic', points: ['Heat released'], guidance: ['Accept -ve delta H'] },
    metadata: { secretNote: 'internal' },
    sub_questions: [
      {
        id: 'a',
        question_text: 'Part (a)',
        marks: 1,
        mark_scheme: { answer: 'Negative' },
        acceptable_answers: ['negative', '-'],
      },
    ],
  },
];

const strippedExam = sanitizeQuestionsForStudent(sampleQuestions, true);
check(
  '1. sanitizeQuestionsForStudent(..., true) strips mark_scheme, source_pdf_url, metadata, sub-question keys',
  strippedExam[0].mark_scheme === null &&
    !('source_pdf_url' in strippedExam[0]) &&
    !('metadata' in strippedExam[0]) &&
    !('mark_scheme' in (strippedExam[0].sub_questions?.[0] || {})) &&
    !('acceptable_answers' in (strippedExam[0].sub_questions?.[0] || {}))
);

const strippedPractice = sanitizeQuestionsForStudent(sampleQuestions, false);
check(
  '2. sanitizeQuestionsForStudent(..., false) still strips source_pdf_url and metadata',
  !('source_pdf_url' in strippedPractice[0]) && !('metadata' in strippedPractice[0])
);

// 3. resolveStudentQuiz does not cache published quizzes into localStorage & defaults allowStudentScriptDownload false
globalThis.localStorage.clear();
const exam = await resolveStudentQuiz(PILOT_QUIZ_CODE);
check(
  '3. resolveStudentQuiz does not write fluffykitten_published_quizzes to localStorage',
  globalThis.localStorage.getItem('fluffykitten_published_quizzes') === null
);
check(
  '4. resolveStudentQuiz defaults allowStudentScriptDownload to false',
  exam?.allowStudentScriptDownload === false
);

// 5. Public pilot package JSON contains no plaintext teacherPin
const pilotJson = fs.readFileSync(path.resolve('public/pilot_exam_170_package.json'), 'utf8');
check(
  '5. public/pilot_exam_170_package.json does not expose teacherPin',
  !pilotJson.includes('"teacherPin"')
);

// 6. Portal / App / PinGate hardening checks
const appTsx = fs.readFileSync(path.resolve('src/App.tsx'), 'utf8');
const portalTsx = fs.readFileSync(path.resolve('src/pages/PortalLandingPage.tsx'), 'utf8');
const pinGateTsx = fs.readFileSync(path.resolve('src/components/PinGate.tsx'), 'utf8');
const pinGateEffectBlock = appTsx.match(/useEffect\(\(\)\s*=>\s*\{\s*applySettings[\s\S]*?\},\s*\[\]\);/)?.[0] || '';

check(
  '6. App.tsx initial mount effect no longer prewarms QuestionBankPage / prewarmQuestionBankData',
  !pinGateEffectBlock.includes('prewarmQuestionBankData') && !pinGateEffectBlock.includes('QuestionBankPage')
);
check(
  '7. PortalLandingPage.tsx no longer imports or calls prefetchAccessPin',
  !portalTsx.includes('prefetchAccessPin')
);
check(
  '8. PinGate.tsx uses verify_teacher_access_pin RPC and contains no prefetchAccessPin / fail-open bypass',
  pinGateTsx.includes(".rpc('verify_teacher_access_pin'") &&
    !pinGateTsx.includes('export function prefetchAccessPin') &&
    !pinGateTsx.includes('Fail-open fallback') &&
    !pinGateTsx.includes('verifyPinAgainstHashOrPlain')
);

// 7. Migration 020 exists
const migrationSql = fs.readFileSync(
  path.resolve('supabase/migrations/020_verify_teacher_access_pin_rpc.sql'),
  'utf8'
);
check(
  '9. Migration 020 defines SECURITY DEFINER verify_teacher_access_pin RPC',
  migrationSql.includes('CREATE OR REPLACE FUNCTION public.verify_teacher_access_pin') &&
    migrationSql.includes('SECURITY DEFINER')
);

// 8. ExamAttachmentModal no longer uses <iframe> for PDF attachments and uses pdfjs-dist canvas
const attModalTsx = fs.readFileSync(path.resolve('src/components/ExamAttachmentModal.tsx'), 'utf8');
check(
  '10. ExamAttachmentModal.tsx renders PDFs via pdfjs-dist canvas with zero <iframe> tags',
  attModalTsx.includes('pdfjsLib.getDocument') && !attModalTsx.includes('<iframe')
);

// 9. @media print suppression exists in runner, result modal, and attachment modal CSS
const runnerCss = fs.readFileSync(path.resolve('src/pages/StudentQuizRunner.css'), 'utf8');
const resultCss = fs.readFileSync(path.resolve('src/components/StudentResultModal.css'), 'utf8');
const attCss = fs.readFileSync(path.resolve('src/components/ExamAttachmentModal.css'), 'utf8');
check(
  '11. @media print suppression exists across runner, result modal, and attachment CSS',
  runnerCss.includes('@media print') &&
    runnerCss.includes('.student-runner-root') &&
    resultCss.includes('@media print') &&
    resultCss.includes('.srm-overlay') &&
    attCss.includes('@media print') &&
    attCss.includes('.exam-att-backdrop')
);

// 10. StudentResultModal and StudentQuizRunner gate Full Script PDF behind allowStudentScriptDownload / allowScriptDownload
const runnerTsx = fs.readFileSync(path.resolve('src/pages/StudentQuizRunner.tsx'), 'utf8');
const resultTsx = fs.readFileSync(path.resolve('src/components/StudentResultModal.tsx'), 'utf8');
check(
  '12. Full Script PDF button is gated behind allowStudentScriptDownload / allowScriptDownload',
  runnerTsx.includes('{allowStudentScriptDownload &&') &&
    resultTsx.includes('{allowScriptDownload &&')
);

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);

