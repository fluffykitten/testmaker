// Phase 5 harness: boundary repair must be pure, letter-agnostic, and a no-op on
// results that are already correct.
//
//   node scripts/verify-phase5.mjs
import fs from 'node:fs';
import path from 'node:path';
const { separatePracticalQuestions, inferSubstanceLabel, isPlanningPrompt } = await import(
  '../src/lib/practicalPostProcess.ts'
);

let failures = 0;
const check = (name, condition, detail = '') => {
  if (!condition) { failures++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
  else console.log(`  ok   ${name}`);
};

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
};

const q = (number, subs, total = 0) => ({
  question_number: String(number),
  parent_question_id: null,
  question_text: `Q${number} stem`,
  question_style: 'Structured',
  total_marks: total || subs.reduce((a, s) => a + s.marks, 0),
  estimated_difficulty: 'Medium',
  topic: 'x',
  sub_topic: null,
  has_diagram: false,
  bounding_box: null,
  options: null,
  mark_scheme: null,
  sub_questions: subs,
});
const sub = (id, text, marks) => ({ sub_id: id, question_text: text, marks });

console.log('\n## inferSubstanceLabel');
check('single solid', inferSubstanceLabel(['Tests on solid E. Add water.']) === 'solid E', inferSubstanceLabel(['Tests on solid E. Add water.']));
check('two solids', inferSubstanceLabel(['solids F and G']) === 'solids F and G', inferSubstanceLabel(['solids F and G']));
check('solution + solid', inferSubstanceLabel(['Tests on solution F', 'solid G is heated']) === 'solid G and solution F', inferSubstanceLabel(['Tests on solution F', 'solid G is heated']));
check('unknown fallback', inferSubstanceLabel(['Add acid to the tube.']) === '', inferSubstanceLabel(['Add acid to the tube.']));

console.log('\n## isPlanningPrompt');
check('plan an experiment', isPlanningPrompt('Plan an experiment to find the percentage by mass of silicon(IV) oxide.'));
check('plan an investigation', isPlanningPrompt('Plan an investigation to find the percentage by mass of aluminium.'));
check('describe how you could', isPlanningPrompt('Describe how you could obtain a sample of bismuth metal.'));
check('not a plan', !isPlanningPrompt('Record your observations in the table.'));

console.log('\n## fused Q1 + Q2 → split');
const fused = [q(1, [
  sub('(a)', 'Experiment 1. Fill a burette with solution A and record the initial reading.', 4),
  sub('(b)', 'Explain why a white tile is used during the titration.', 1),
  sub('(c)', 'Tests on solid E. Gently heat the first portion of solid E.', 2),
  sub('(d)', 'To the second portion of solution E, add sodium hydroxide.', 3),
], 10)];
const fusedCopy = JSON.parse(JSON.stringify(fused));
deepFreeze(fused);
let fusedOut;
try { fusedOut = separatePracticalQuestions(fused); } catch (error) { fusedOut = null; failures++; console.log('  FAIL threw on frozen input —', String(error).slice(0, 80)); }
check('frozen input does not throw', fusedOut !== null);
check('produces 2 questions', fusedOut?.length === 2, `got ${fusedOut?.length}`);
check('Q1 keeps only the quantitative parts', fusedOut?.[0]?.sub_questions?.length === 2, `got ${fusedOut?.[0]?.sub_questions?.length}`);
check('Q2 holds the qualitative parts', fusedOut?.[1]?.sub_questions?.length === 2, `got ${fusedOut?.[1]?.sub_questions?.length}`);
check('Q2 stem names solid E, not "solid A"', /solid E/.test(fusedOut?.[1]?.question_text ?? '') && !/solid A/.test(fusedOut?.[1]?.question_text ?? ''), fusedOut?.[1]?.question_text);
check('input untouched', JSON.stringify(fused) === JSON.stringify(fusedCopy));

console.log('\n## fused Q3 absorbed into Q2 → split');
const withPlan = [q(1, [sub('(a)', 'Record the temperature.', 5)]), q(2, [
  sub('(a)', 'Record your observations.', 2),
  sub('(b)', 'Identify the ions in solid G.', 2),
  sub('(c)', 'Plan an experiment to find the percentage by mass of silicon(IV) oxide in the mixture.', 6),
], 10)];
const planOut = separatePracticalQuestions(deepFreeze(JSON.parse(JSON.stringify(withPlan))));
check('produces 3 questions', planOut.length === 3, `got ${planOut.length}`);
check('Q3 has no sub-questions', (planOut[2]?.sub_questions ?? []).length === 0);
check('Q3 carries 6 marks', planOut[2]?.total_marks === 6, String(planOut[2]?.total_marks));
check('Q2 keeps its own parts', planOut[1]?.sub_questions?.length === 2, `got ${planOut[1]?.sub_questions?.length}`);

console.log('\n## real extractions (must be a no-op)');
const dir = 'scratch';
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^extract-0620.*\.json$/.test(f)) : [];
let checked = 0;
for (const file of files) {
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const input = parsed.questions ?? [];
  if (input.length !== 3) continue;
  const before = JSON.stringify(input);
  const out = separatePracticalQuestions(input);
  const problems = [];
  if (out.length !== 3) problems.push(`length ${out.length}`);
  if (!out.some((x) => String(x.question_number) === '3' && (x.sub_questions ?? []).length === 0)) problems.push('Q3 not empty');
  if (JSON.stringify(input) !== before) problems.push('input mutated');
  if (problems.length) { failures++; console.log(`  FAIL ${file}: ${problems.join(', ')}`); }
  checked++;
}
console.log(`  ${checked} real extraction(s) checked`);

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
