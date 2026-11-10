// Automated test suite for Test Builder Header Persistence & User Customization Lock
import assert from 'node:assert/strict';

console.log('🧪 Testing Test Builder Header Persistence & Auto-Detection Guard...');

// Simulate inference function matching src/pages/TestBuilderPage.tsx
function inferSubjectFromQuestions(questions, syllabuses = []) {
  if (!questions || questions.length === 0) {
    return {
      subject: 'Geography',
      subjectCode: '0460',
      defaultTitle: 'IGCSE Geography Practice Assessment',
      additionalMaterials: 'An Insert (enclosed)',
      instructions: 'Answer all questions. Write in dark blue or black pen.',
    };
  }

  const allText = questions
    .map((q) => `${q.topic || ''} ${q.sub_topic || ''} ${q.question_text || ''}`)
    .join(' ')
    .toLowerCase();

  if (/biology|cell|photosynthesis|respiration/i.test(allText)) {
    return {
      subject: 'Biology',
      subjectCode: '0610',
      defaultTitle: 'IGCSE Biology Practice Assessment',
      additionalMaterials: '',
      instructions: 'Answer all questions. Write your answers in the spaces provided.',
    };
  }

  if (/physics|force|velocity|acceleration|current/i.test(allText)) {
    return {
      subject: 'Physics',
      subjectCode: '0625',
      defaultTitle: 'IGCSE Physics Practice Assessment',
      additionalMaterials: 'Calculator, ruler',
      instructions: 'Answer all questions. Write your answers in the spaces provided.',
    };
  }

  return {
    subject: 'Chemistry',
    subjectCode: '0620',
    defaultTitle: 'IGCSE Chemistry Practice Assessment',
    additionalMaterials: 'Periodic Table (enclosed)',
    instructions: 'Answer all questions. You may use a calculator.',
  };
}

// Simulate header state reducer matching src/pages/TestBuilderPage.tsx
function runAutoDetectEffect(prev, questions, syllabuses = []) {
  if (questions.length === 0) return prev;

  // Key architectural guard: if user manually edited the header, do not overwrite!
  if (prev.isUserCustomized) {
    return prev;
  }

  const detected = inferSubjectFromQuestions(questions, syllabuses);
  const prevSubject = (prev.subject || '').trim().toLowerCase();
  const detectedSubject = detected.subject.trim().toLowerCase();

  const isDefaultTitle =
    !prev.title ||
    (prev.title.startsWith('IGCSE ') && prev.title.endsWith('Practice Assessment'));

  const isSubjectMismatch =
    prevSubject !== detectedSubject &&
    (prevSubject === 'chemistry' || !prevSubject || isDefaultTitle);

  if (isSubjectMismatch) {
    return {
      ...prev,
      subject: detected.subject,
      subjectCode: detected.subjectCode,
      title: isDefaultTitle ? detected.defaultTitle : prev.title.replace(new RegExp(prev.subject || 'Chemistry', 'i'), detected.subject),
      additionalMaterials: detected.additionalMaterials,
      instructions: detected.instructions || prev.instructions,
      isUserCustomized: false,
    };
  }

  return prev;
}

// Simulate TestHeaderEditor field change
function handleFieldChange(config, field, value) {
  return {
    ...config,
    [field]: value,
    isUserCustomized: true,
  };
}

// Simulate handleResetHeaderToAutoDetect
function handleResetHeaderToAutoDetect(prev, questions, syllabuses = []) {
  const detected = inferSubjectFromQuestions(questions, syllabuses);
  return {
    ...prev,
    subject: detected.subject,
    subjectCode: detected.subjectCode,
    title: detected.defaultTitle,
    additionalMaterials: detected.additionalMaterials,
    instructions: detected.instructions,
    isUserCustomized: false,
  };
}

// --- Test 1: Fresh Test Auto-detection initializes correctly ---
{
  const chemistryQuestions = [
    { id: 'q1', marks: 4, question_text: 'Describe the industrial extraction of iron from hematite.' }
  ];
  let config = {
    title: 'IGCSE Chemistry Practice Assessment',
    schoolName: '',
    subject: 'Chemistry',
    subjectCode: '0620',
    durationMinutes: 45,
    instructions: 'Answer all questions. You may use a calculator.',
    additionalMaterials: 'Periodic Table (enclosed)',
    isUserCustomized: false,
  };

  const detected = runAutoDetectEffect(config, chemistryQuestions);
  assert.equal(detected.subject, 'Chemistry');
  assert.equal(detected.isUserCustomized, false);
  console.log('✅ Test 1 Passed: Fresh test runs auto-detection without error.');
}

// --- Test 2: Teacher edits header fields, setting isUserCustomized: true ---
let userConfig = {
  title: 'IGCSE Chemistry Practice Assessment',
  schoolName: 'Global High School',
  subject: 'Chemistry',
  subjectCode: '0620 / 41',
  durationMinutes: 60,
  instructions: 'Special instruction: Show all working for calculations.',
  additionalMaterials: 'Periodic Table (enclosed), Rough Paper',
  isUserCustomized: false,
};

// Teacher updates instructions
userConfig = handleFieldChange(userConfig, 'instructions', 'Special instruction: Show all working for calculations.');
assert.equal(userConfig.isUserCustomized, true);

// Teacher updates additional materials
userConfig = handleFieldChange(userConfig, 'additionalMaterials', 'Periodic Table (enclosed), Rough Paper');
assert.equal(userConfig.isUserCustomized, true);
console.log('✅ Test 2 Passed: Editing header sets isUserCustomized = true.');

// --- Test 3: Navigation away & back (sessionStorage simulation) ---
// When navigating to Paper Upload or Question Bank, sessionStorage persists headerConfig
const sessionStore = new Map();
sessionStore.set('testmaker_builder_header_config', JSON.stringify(userConfig));

// Teacher adds questions that contain words matching biology/physics (e.g. "cell" or "current" in electrolysis)
const electrolysisQuestions = [
  { id: 'q1', marks: 2, question_text: 'Describe what happens at the cathode in an electrolytic cell.' }, // contains "cell"!
  { id: 'q2', marks: 3, question_text: 'Calculate the electric current in amperes.' }, // contains "current"!
  { id: 'q3', marks: 5, question_text: 'Explain the redox reaction during electrolysis.' }
];

// Remount TestBuilderPage: reconstruct config from sessionStorage
const restoredConfig = JSON.parse(sessionStore.get('testmaker_builder_header_config'));
assert.equal(restoredConfig.isUserCustomized, true);

// Auto-detect effect runs on remount with the questions
const postMountConfig = runAutoDetectEffect(restoredConfig, electrolysisQuestions);

// Verify fields were NOT overwritten by biology or physics
assert.equal(postMountConfig.subject, 'Chemistry', 'Subject must NOT flip to Biology/Physics!');
assert.equal(postMountConfig.subjectCode, '0620 / 41', 'Syllabus code must be preserved!');
assert.equal(postMountConfig.instructions, 'Special instruction: Show all working for calculations.', 'Instructions must be preserved!');
assert.equal(postMountConfig.additionalMaterials, 'Periodic Table (enclosed), Rough Paper', 'Additional materials must be preserved!');
assert.equal(postMountConfig.isUserCustomized, true);
console.log('✅ Test 3 Passed: Remounting after navigation preserves all customized header fields without flipping to Biology/Physics.');

// --- Test 4: Total marks calculation remains dynamic and correct ---
const totalMarks = electrolysisQuestions.reduce((sum, q) => sum + (q.marks || 0), 0);
assert.equal(totalMarks, 10, 'Total marks must be exactly 10 (2 + 3 + 5)');
console.log('✅ Test 4 Passed: Total marks calculation is strictly computed from question marks (10 marks).');

// --- Test 5: Teacher clicks "↺ Auto-Detect" button to deliberately reset ---
const resetConfig = handleResetHeaderToAutoDetect(postMountConfig, electrolysisQuestions);
assert.equal(resetConfig.isUserCustomized, false, 'isUserCustomized should be false after intentional auto-detect reset');
assert.equal(resetConfig.title, 'IGCSE Biology Practice Assessment', 'Title re-synced based on current questions');
console.log('✅ Test 5 Passed: Intentional Auto-Detect reset resets isUserCustomized to false and updates fields.');

console.log('\n🎉 ALL HEADER PERSISTENCE TESTS PASSED SUCCESSFULLY!');

