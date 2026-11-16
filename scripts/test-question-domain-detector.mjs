import assert from 'node:assert/strict';
import {
  applySymbolInsertion,
  classifyExamFallbackDomain,
  classifyQuestionDomain,
  getQuickSymbolsForDomain,
  MATH_QUICK_SYMBOLS,
  CHEM_QUICK_SYMBOLS,
} from '../src/utils/questionDomainDetector.ts';

function runDomainClassificationTests() {
  const admissionCtx = {
    subject: 'Admission Test',
    subjectCode: '',
    title: 'Grade 10 Entrance Admission Assessment',
  };
  const bilingualTitleCtx = {
    subject: 'English & Math',
    subjectCode: '',
    title: 'Admission Test (English and Mathematics)',
  };

  assert.equal(classifyExamFallbackDomain(admissionCtx), 'general');
  assert.equal(classifyExamFallbackDomain(bilingualTitleCtx), 'general');
  assert.equal(
    classifyExamFallbackDomain({ subject: 'Chemistry', subjectCode: '0620', title: 'Paper 4' }),
    'chemistry'
  );
  assert.equal(
    classifyExamFallbackDomain({ subject: 'English', subjectCode: '0510', title: 'Reading & Writing' }),
    'language'
  );

  // Q1: English Reading inside mixed Admission Test
  const qReading = {
    topic: 'Reading Comprehension',
    question_text: '### Passage 1\nRead the passage carefully and answer the following question in your own words.',
  };
  const rReading = classifyQuestionDomain(qReading, undefined, bilingualTitleCtx);
  assert.equal(rReading.domain, 'language');
  assert.equal(rReading.isLanguage, true);
  assert.equal(rReading.isStemOrMath, false);

  // Q2: English Writing essay inside mixed Admission Test
  const qWriting = {
    topic: 'Writing',
    question_text: 'Write an opinion essay of at least 150 words about school uniforms.',
  };
  const rWriting = classifyQuestionDomain(qWriting, undefined, admissionCtx);
  assert.equal(rWriting.domain, 'language');
  assert.equal(rWriting.isStemOrMath, false);

  // Q3: Math question inside an English+Math Admission Test where Q1 was English!
  const qMathTopic = {
    topic: 'Algebra',
    question_text: 'Solve for $x$: $2x^2 - 5x - 3 = 0$.',
  };
  const rMathTopic = classifyQuestionDomain(qMathTopic, undefined, bilingualTitleCtx);
  assert.equal(rMathTopic.domain, 'math');
  assert.equal(rMathTopic.isMath, true);
  assert.equal(rMathTopic.isStemOrMath, true);
  assert.equal(rMathTopic.isLanguage, false);
  assert.equal(getQuickSymbolsForDomain(rMathTopic.domain), MATH_QUICK_SYMBOLS);

  // Q4: Generic topic "Section B" with LaTeX/math stem still detects math
  const qMathStemOnly = {
    topic: 'Section B',
    question_text: 'Simplify \\frac{x^{2}-1}{x-1} and find the value of x_1 + x_2.',
  };
  const rMathStem = classifyQuestionDomain(qMathStemOnly, undefined, admissionCtx);
  assert.equal(rMathStem.domain, 'math');
  assert.equal(rMathStem.isStemOrMath, true);

  // Q5: Chemistry question gets chemistry toolbar (including subscript & reaction symbols)
  const qChem = {
    topic: 'Stoichiometry',
    question_text: 'Calculate the concentration in mol/dm³ for H_2SO_4.',
  };
  const rChem = classifyQuestionDomain(qChem, undefined, admissionCtx);
  assert.equal(rChem.domain, 'chemistry');
  assert.equal(rChem.isChemistry, true);
  assert.equal(getQuickSymbolsForDomain(rChem.domain), CHEM_QUICK_SYMBOLS);

  // Q6: Mixed sub-questions under one parent question
  const qMixedParent = {
    topic: 'General Structured',
    question_text: 'Answer both parts.',
  };
  const subMath = { sub_id: 'a', question_text: 'Find the gradient of the line $y = 3x + 2$ and evaluate $x_1$.' };
  const subLang = { sub_id: 'b', question_text: 'Summarize the main idea of the passage in your own words.' };
  assert.equal(classifyQuestionDomain(qMixedParent, subMath, admissionCtx).domain, 'math');
  assert.equal(classifyQuestionDomain(qMixedParent, subLang, admissionCtx).domain, 'language');

  console.log('PASS Step 1: Per-question domain classification tests');
}

function runSymbolInsertionAndPreviewTests() {
  const subscriptItem = MATH_QUICK_SYMBOLS.find((s) => s.label === 'xₙ');
  const superscriptItem = MATH_QUICK_SYMBOLS.find((s) => s.label === 'xⁿ');
  const fractionItem = MATH_QUICK_SYMBOLS.find((s) => s.label === 'a/b');
  const sqrtItem = MATH_QUICK_SYMBOLS.find((s) => s.label === '√');
  const piItem = MATH_QUICK_SYMBOLS.find((s) => s.label === 'π');

  assert.ok(subscriptItem && superscriptItem && fractionItem && sqrtItem && piItem);

  // Insert subscript inside existing text at cursor position 1 ('x| + y')
  const insSub = applySymbolInsertion('x + y', 1, 1, subscriptItem);
  assert.equal(insSub.nextValue, 'x_{} + y');
  assert.equal(insSub.nextCursorPos, 3);

  // Wrap highlighted selection ('2' in 'x2') as subscript -> 'x_{2}'
  const wrapSub = applySymbolInsertion('x2', 1, 2, subscriptItem);
  assert.equal(wrapSub.nextValue, 'x_{2}');
  assert.equal(wrapSub.nextCursorPos, 5);

  // Insert superscript template at cursor
  const insSup = applySymbolInsertion('y', 1, 1, superscriptItem);
  assert.equal(insSup.nextValue, 'y^{}');
  assert.equal(insSup.nextCursorPos, 3);

  // Wrap selected numerator ('x+1') into fraction -> '\frac{x+1}{}' with cursor inside denominator braces
  const wrapFrac = applySymbolInsertion('x+1', 0, 3, fractionItem);
  assert.equal(wrapFrac.nextValue, '\\frac{x+1}{}');
  assert.equal(wrapFrac.nextCursorPos, 11);

  // Wrap selected 'x' into sqrt -> '\sqrt{x}'
  const wrapSqrt = applySymbolInsertion('x', 0, 1, sqrtItem);
  assert.equal(wrapSqrt.nextValue, '\\sqrt{x}');
  assert.equal(wrapSqrt.nextCursorPos, 8);

  // Insert constant symbol at cursor
  const insPi = applySymbolInsertion('2r', 1, 1, piItem);
  assert.equal(insPi.nextValue, '2πr');
  assert.equal(insPi.nextCursorPos, 2);

  // Append symbol cleanly when cursor indexes are null/undefined
  const appendSub = applySymbolInsertion('a', null, null, subscriptItem);
  assert.equal(appendSub.nextValue, 'a_{}');
  assert.equal(appendSub.nextCursorPos, 3);

  console.log('PASS Step 2 & 3: Cursor-aware math insertion tests');
}

runDomainClassificationTests();
runSymbolInsertionAndPreviewTests();
