// ═══════════════════════════════════════════════════════════════════════════════
// ARABIC EXAM COMPLETE LIFECYCLE SIMULATION HARNESS
// ═══════════════════════════════════════════════════════════════════════════════
// Simulates Arabic assessment support from start to finish:
// 1. Upload & Structured Question Extraction Schema
// 2. Question Bank Ingestion, Topic Inference & Unicode Search
// 3. Candidate Exam Runner Simulation (3 Virtual Arabic Candidates)
// 4. Deterministic & AI Assessment Grading Engine (MCQ, Gap, Short Ans, Math)
// 5. Psychometric Scoring & Final Performance Report
// ═══════════════════════════════════════════════════════════════════════════════

import type { Question } from '../src/types/database';
import {
  gradeDeterministicAnswer,
  isArabicText,
  normalizeArabicText,
  resolveMcqCorrectOptionIndex,
  isKeywordMatch,
  areValuesEquivalent,
  parseNumericWithUnit,
  ARABIC_OPTION_LETTERS,
  ARABIC_OPTION_TO_INDEX,
} from '../src/services/deterministicGradingService';
import { cleanMcqOptionContent } from '../src/services/quizSubmissionService';
import { inferTopicFromContent } from '../src/services/questionBankService';

console.log('══════════════════════════════════════════════════════════════════');
console.log('   SIMULATING ARABIC EXAM SUPPORT - FULL LIFECYCLE TEST HARNESS   ');
console.log('══════════════════════════════════════════════════════════════════\n');

// ─── STAGE 1: Upload & Question Bank Schema Ingestion ─────────────────────────
console.log('▶ [STAGE 1] Creating Authentic Arabic Exam Questions across Diverse Styles...');

const arabicExamQuestions: Question[] = [
  {
    id: 'ar-q1-mcq',
    syllabus_id: 'arabic-lang-01',
    year: 2026,
    series: 'نهاية الفصل الدراسي الأول',
    paper_number: 1,
    question_number: '1',
    parent_question_id: null,
    question_text: 'اختر الإعراب الصحيح للكلمة التي بين قوسين في الجملة الآتية: "حَضَرَ (المُعَلِّمُ) إِلَى المَدْرَسَةِ مُبَكِّرًا".',
    question_style: 'Multiple Choice',
    topic: 'النحو والصرف',
    sub_topic: 'الفاعل وأحكامه',
    difficulty: 'Easy',
    marks: 1,
    diagram_url: null,
    options: [
      'أ. فاعل مرفوع وعلامة رفعه الضمة الظاهرة على آخره',
      'ب. مفعول به منصوب وعلامة نصبه الفتحة الظاهرة',
      'ج. مبتدأ مؤخر مرفوع بالضمة',
      'د. مضاف إليه مجرور وعلامة جره الكسرة',
    ],
    sub_questions: [],
    mark_scheme: {
      marking_points: ['الخيار أ [1]'],
      acceptable_answers: ['أ', 'الخيار أ', 'فاعل مرفوع وعلامة رفعه الضمة الظاهرة على آخره'],
      guidance: ['المعلم اسم مرفوع دل على من قام بالفعل (حضر) فهو فاعل.'],
      common_misconceptions: ['الخلط بين الفاعل والمفعول به بسبب وجود حرف الجر بعده.'],
    },
    created_at: new Date().toISOString(),
  },
  {
    id: 'ar-q2-short',
    syllabus_id: 'islamic-studies-01',
    year: 2026,
    series: 'اختبار تجريبي',
    paper_number: 1,
    question_number: '2',
    parent_question_id: null,
    question_text: 'ما هي أول عاصمة للدولة الإسلامية التي هاجر إليها النبي محمد صلى الله عليه وسلم وأسس فيها المسجد النبوي الشريف؟',
    question_style: 'Short Answer',
    topic: 'السيرة والتاريخ الإسلامي',
    sub_topic: 'الهجرة النبوية',
    difficulty: 'Medium',
    marks: 1,
    diagram_url: null,
    options: null,
    sub_questions: [],
    mark_scheme: {
      marking_points: ['المدينة المنورة [1]'],
      acceptable_answers: ['المدينة المنورة', 'يثرب', 'طيبة', 'المدينه المنوره'],
      guidance: ['تُقبل يثرب كاسم قديم للمدينة المنورة قبل الهجرة.'],
      common_misconceptions: ['كتابة مكة المكرمة بدلاً من المدينة المنورة.'],
    },
    created_at: new Date().toISOString(),
  },
  {
    id: 'ar-q3-gap',
    syllabus_id: 'general-science-01',
    year: 2026,
    series: 'امتحانات الثانوية',
    paper_number: 2,
    question_number: '3',
    parent_question_id: null,
    question_text: 'أكمل الجملة الآتية: يتكون جزيء الماء ($H_2O$) كيميائيًا من ذرتين من [1] مرتبطة بذرة واحدة من [2].',
    question_style: 'Fill in the Blank',
    topic: 'العلوم العامة والكيمياء',
    sub_topic: 'المركبات الكيميائية',
    difficulty: 'Easy',
    marks: 2,
    diagram_url: null,
    options: null,
    sub_questions: [],
    mark_scheme: {
      marking_points: [
        '[1] الهيدروجين [1]',
        '[2] الأكسجين [1]',
      ],
      acceptable_answers: [
        '[1] الهيدروجين / هيدروجين',
        '[2] الأكسجين / أكسجين / الاكسجين',
      ],
    },
    created_at: new Date().toISOString(),
  },
  {
    id: 'ar-q4-calc',
    syllabus_id: 'math-01',
    year: 2026,
    series: 'امتحانات الرياضيات',
    paper_number: 1,
    question_number: '4',
    parent_question_id: null,
    question_text: 'احسب الناتج الرياضي التالي بالرموز والأرقام: $٢٥ \\times ٤ = ?$',
    question_style: 'Calculation',
    topic: 'الحساب والرياضيات',
    sub_topic: 'العمليات الحسابية',
    difficulty: 'Easy',
    marks: 1,
    diagram_url: null,
    options: null,
    sub_questions: [],
    mark_scheme: {
      marking_points: ['١٠٠ أو 100 [1]'],
      acceptable_answers: ['١٠٠', '100'],
    },
    created_at: new Date().toISOString(),
  },
  {
    id: 'ar-q5-structured',
    syllabus_id: 'chemistry-01',
    year: 2026,
    series: 'الكيمياء التجريبية',
    paper_number: 4,
    question_number: '5',
    parent_question_id: 'Q5',
    question_text: 'أُجريت تجربة لمعادلة حمض الهيدروكلوريك ($HCl$) مع محلول هيدروكسيد الصوديوم ($NaOH$).',
    question_style: 'Structured',
    topic: 'الأحماض والقواعد',
    sub_topic: 'تفاعلات التعادل',
    difficulty: 'Hard',
    marks: 2,
    diagram_url: null,
    options: null,
    sub_questions: [
      {
        sub_id: '(أ)',
        question_text: 'اكتب اسم الملح الناتج عن هذا التفاعل الكيميائي.',
        marks: 1,
        mark_scheme: 'كلوريد الصوديوم / ملح الطعام [1]',
      },
      {
        sub_id: '(ب)',
        question_text: 'حدد قيمة الرقم الهيدروجيني ($pH$) للمحلول الناتج عند نقطة التعادل التام عند درجة حرارة $25^\\circ\\text{C}$.',
        marks: 1,
        mark_scheme: '٧ / 7 / متعادل [1]',
      },
    ],
    mark_scheme: {
      marking_points: [
        '(أ) كلوريد الصوديوم [1]',
        '(ب) 7 أو متعادل [1]',
      ],
    },
    created_at: new Date().toISOString(),
  },
];

console.log(`✓ Created ${arabicExamQuestions.length} complete Arabic questions.`);
arabicExamQuestions.forEach((q) => {
  console.log(`  - Question ${q.question_number}: ${q.question_style} (${q.marks} Mark${q.marks > 1 ? 's' : ''}) | Topic: ${q.topic}`);
});

// ─── STAGE 2: Question Bank Ingestion, Topic Inference & Search Tests ─────────
console.log('\n▶ [STAGE 2] Testing Question Bank Search, Topic Inference & Option Cleaning...');

// 2.1 Topic inference test
const sampleText1 = 'حكم إعراب الفاعل والمبتدأ والخبر في الجملة الاسمية';
const inferred1 = inferTopicFromContent(sampleText1);
console.log(`  - Inferred Topic for Grammar: "${inferred1}" (Expected: النحو والصرف (Arabic Grammar))`);
if (!inferred1.includes('النحو')) {
  console.error('  ✗ Topic inference failed for Arabic Grammar!');
} else {
  console.log('  ✓ Topic inference verified.');
}

// 2.2 Arabic Option prefix cleaning
const rawOption = 'أ. فاعل مرفوع وعلامة رفعه الضمة';
const cleanedOption = cleanMcqOptionContent(rawOption, 0);
console.log(`  - Option Cleaning: "${rawOption}" -> "${cleanedOption}"`);
if (cleanedOption.startsWith('أ.')) {
  console.error('  ✗ Option cleaning failed to strip Arabic letter prefix!');
} else {
  console.log('  ✓ Option cleaning verified.');
}

// 2.3 Unicode Arabic & Diacritic normalization
const rawWithTashkeel = 'المَدِينَةُ المُنَوَّرَةُ';
const normalized = normalizeArabicText(rawWithTashkeel);
console.log(`  - Tashkeel Normalization: "${rawWithTashkeel}" -> "${normalized}"`);
if (normalized !== 'المدينه المنوره') {
  console.error(`  ✗ Expected "المدينه المنوره", got "${normalized}"`);
} else {
  console.log('  ✓ Tashkeel and Taa Marbuta normalization verified.');
}

// 2.4 Eastern Arabic Numerals conversion
const easternDigits = '٢٥';
const numParsed = parseNumericWithUnit(easternDigits);
console.log(`  - Eastern Numerals Parsing: "${easternDigits}" -> ${numParsed?.value}`);
if (numParsed?.value !== 25) {
  console.error('  ✗ Eastern numeral parsing failed!');
} else {
  console.log('  ✓ Eastern numeral parsing verified (٢٥ = 25).');
}

// 2.5 Resolve MCQ Correct Option Index with Arabic letter
const correctIdx = resolveMcqCorrectOptionIndex(arabicExamQuestions[0]);
console.log(`  - MCQ Correct Option Index for Q1: ${correctIdx} (Mapped to Option: ${ARABIC_OPTION_LETTERS[correctIdx]} / A)`);
if (correctIdx !== 0) {
  console.error(`  ✗ Expected correct index 0, got ${correctIdx}`);
} else {
  console.log('  ✓ Arabic MCQ index resolution verified.');
}

// ─── STAGE 3 & 4: Formal Exam Simulation & Grading ─────────────────────────────
console.log('\n▶ [STAGE 3 & 4] Simulating 3 Virtual Candidates across the Entire Exam...\n');

interface VirtualCandidate {
  name: string;
  expectedMarks: number;
  answers: Record<string | number, any>;
}

const candidates: VirtualCandidate[] = [
  {
    name: 'فاطمة الزهراء (Top Performing Candidate)',
    expectedMarks: 7, // 100%
    answers: {
      0: 0, // Q1: Selected Option 0 (أ)
      1: 'المَدِينَةُ المُنَوَّرَةُ', // Q2: Correct with full diacritics
      2: JSON.stringify({ 1: 'الهيدروجين', 2: 'الأكسجين' }), // Q3: Exact blanks
      3: '١٠٠', // Q4: Eastern Arabic digits 100
      '4_0': 'كلوريد الصوديوم', // Q5(أ): Sodium chloride
      '4_1': '٧', // Q5(ب): pH 7
    },
  },
  {
    name: 'عمر خالد (Strong Candidate with Spelling Variants)',
    expectedMarks: 5, // 71.4%
    answers: {
      0: 'أ', // Q1: Submitted raw Arabic letter 'أ'
      1: 'المدينه المنوره', // Q2: Valid variant (Taa marbuta as haa)
      2: JSON.stringify({ 1: 'هيدروجين', 2: 'النيتروجين' }), // Q3: Gap 1 correct, Gap 2 wrong (1/2 marks)
      3: '100', // Q4: Latin numeral 100
      '4_0': 'ملح الطعام', // Q5(أ): Acceptable alternative synonym
      '4_1': '8', // Q5(ب): Wrong pH (0/1 marks)
    },
  },
  {
    name: 'يوسف أحمد (Candidate Requiring Remediation)',
    expectedMarks: 0, // 0%
    answers: {
      0: 1, // Q1: Selected Option 1 (ب) - Wrong
      1: 'مكة المكرمة', // Q2: Wrong city
      2: JSON.stringify({ 1: 'أكسجين', 2: 'هيدروجين' }), // Q3: Inverted gaps (0/2)
      3: '٥٠', // Q4: 50 instead of 100
      '4_0': 'كربونات الكالسيوم', // Q5(أ): Wrong salt
      '4_1': 'حمضي', // Q5(ب): Wrong response
    },
  },
];

let allPassed = true;

for (const candidate of candidates) {
  console.log(`──────────────────────────────────────────────────────────────────`);
  console.log(`📋 Candidate: ${candidate.name}`);
  console.log(`──────────────────────────────────────────────────────────────────`);

  let totalEarned = 0;
  let totalMax = 0;

  for (let qIdx = 0; qIdx < arabicExamQuestions.length; qIdx++) {
    const q = arabicExamQuestions[qIdx];

    if (q.sub_questions && q.sub_questions.length > 0) {
      // Structured Question
      console.log(`  [Question ${q.question_number}] ${q.question_text.slice(0, 60)}...`);
      for (let sIdx = 0; sIdx < q.sub_questions.length; sIdx++) {
        const sq = q.sub_questions[sIdx];
        const subKey = `${qIdx}_${sIdx}`;
        const studentAns = candidate.answers[subKey];
        const gradeRes = gradeDeterministicAnswer(studentAns, q, sIdx);

        totalEarned += gradeRes.earnedMarks;
        totalMax += gradeRes.maxMarks;

        console.log(`    Part ${sq.sub_id}: Student Answer = "${studentAns || '(blank)'}"`);
        console.log(`      Score: ${gradeRes.earnedMarks}/${gradeRes.maxMarks} Marks | ${gradeRes.feedback}`);
      }
    } else {
      // Single Question
      const studentAns = candidate.answers[qIdx];
      const gradeRes = gradeDeterministicAnswer(studentAns, q);

      totalEarned += gradeRes.earnedMarks;
      totalMax += gradeRes.maxMarks;

      console.log(`  [Question ${q.question_number} - ${q.question_style}]`);
      console.log(`    Student Answer = "${studentAns}"`);
      console.log(`    Score: ${gradeRes.earnedMarks}/${gradeRes.maxMarks} Marks | Result: ${gradeRes.isCorrect ? '✓ CORRECT' : '✗ INCORRECT'}`);
      console.log(`    Feedback: ${gradeRes.feedback}`);
    }
  }

  const percentage = Math.round((totalEarned / totalMax) * 100);
  console.log(`\n  >> Final Score: ${totalEarned}/${totalMax} (${percentage}%) | Expected: ${candidate.expectedMarks}/${totalMax}`);

  if (totalEarned !== candidate.expectedMarks) {
    console.error(`  ✗ Score discrepancy! Expected ${candidate.expectedMarks}, but got ${totalEarned}`);
    allPassed = false;
  } else {
    console.log(`  ✓ Exact score match! Verification passed.`);
  }
  console.log('');
}

// ─── STAGE 5: Synthesis & Summary Report ────────────────────────────────────────
console.log('══════════════════════════════════════════════════════════════════');
console.log('                 FINAL SIMULATION RESULTS                        ');
console.log('══════════════════════════════════════════════════════════════════');
if (allPassed) {
  console.log('🎉 SUCCESS: All Arabic examination questions were simulated and');
  console.log('   graded with 100% precision from upload schema to final score!');
} else {
  console.error('❌ FAILURE: Some simulation stages encountered unexpected discrepancies.');
  process.exit(1);
}
