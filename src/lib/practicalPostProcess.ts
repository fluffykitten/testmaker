/**
 * Practical-paper post-processing (pure — no browser dependencies).
 *
 * Cambridge 0620/5x papers are three questions, but a vision-only extraction
 * sometimes returns Q1 and Q2 fused (the qualitative section absorbed into Q1),
 * or Q3 fused into Q2. These helpers repair the question boundaries without ever
 * mutating their input, and without assuming a particular solid/solution letter.
 */

import type { ExtractedQuestion, SubQuestion } from '../types/database';

const QUALITATIVE_RE =
  /tests on solid|tests on solution|tests on the substances|portion of solution [A-Z]|solution [A-Z] in a (?:test[- ]tube|boiling tube)|solid [A-Z]\b/i;
const PROCEDURAL_RE =
  /magnesium|temperature|thermometer|burette|conical flask|gas syringe|stop-watch|stopwatch|balance|graph|plot/i;
const PLANNING_RE =
  /\bplan an? (?:investigation|experiment)\b|\bdescribe how you (?:could|would)\b|\byour plan (?:must|should) include\b|\bsuggest a method\b|\bdesign an? (?:experiment|investigation)\b|\boutline a procedure\b/i;

const sumMarks = (subs: SubQuestion[]): number => subs.reduce((sum, s) => sum + (Number(s.marks) || 0), 0);
const normaliseId = (id: string | undefined): string => (id ?? '').replace(/[().\s]/g, '').toLowerCase();

/** Does this sub-question open the qualitative-analysis section? */
export function isQualitativeStart(text: string): boolean {
  if (!text) return false;
  if (!QUALITATIVE_RE.test(text)) return false;
  return !PROCEDURAL_RE.test(text);
}

export function isPlanningPrompt(text: string): boolean {
  return PLANNING_RE.test(text || '');
}

/**
 * "solid E", "solids F and G", "solution A", "solids M and N" — derived from the
 * sub-question text so no paper-specific letter is ever hardcoded.
 */
export function inferSubstanceLabel(texts: string[]): string {
  const joined = texts.join(' ');
  const solids = new Set<string>();
  const solutions = new Set<string>();

  for (const match of joined.matchAll(/\bsolids?\s+([A-Z])(?:\s+and\s+([A-Z]))?/g)) {
    solids.add(match[1]);
    if (match[2]) solids.add(match[2]);
  }
  for (const match of joined.matchAll(/\bsolutions?\s+([A-Z])(?:\s+and\s+([A-Z]))?/g)) {
    solutions.add(match[1]);
    if (match[2]) solutions.add(match[2]);
  }
  // "solid A" and "solution A" name the same sample; count it once.
  for (const solid of solids) solutions.delete(solid);

  const parts: string[] = [];
  if (solids.size) {
    const list = [...solids].sort().join(' and ');
    parts.push(`${solids.size > 1 ? 'solids' : 'solid'} ${list}`);
  }
  if (solutions.size) {
    const list = [...solutions].sort().join(' and ');
    parts.push(`${solutions.size > 1 ? 'solutions' : 'solution'} ${list}`);
  }
  return parts.join(' and ');
}

function dedupeSubs(subs: SubQuestion[]): SubQuestion[] {
  const seen = new Set<string>();
  const out: SubQuestion[] = [];
  for (const sub of subs) {
    const key = normaliseId(sub.sub_id);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(sub);
  }
  return out;
}

function makeQualitativeQuestion(source: ExtractedQuestion, subs: SubQuestion[]): ExtractedQuestion {
  const label = inferSubstanceLabel(subs.map((s) => s.question_text || ''));
  return {
    ...source,
    question_number: '2',
    parent_question_id: 'Q2',
    question_text: label
      ? `You are provided with ${label}. Do the following tests, recording all of your observations at each stage.`
      : 'Do the following tests, recording all of your observations at each stage.',
    sub_questions: dedupeSubs(subs),
    total_marks: sumMarks(subs) || source.total_marks,
    topic: 'Qualitative Analysis',
    sub_topic: 'Identification of ions and gases',
    has_diagram: false,
    diagram_url: null,
    diagram_type: null,
    resource_ref: null,
    bounding_box: null,
    options: null,
    data_tables: undefined,
  };
}

/** Split a fused Q3 planning question out of Q2 when it was swallowed. */
function splitPlanningQuestion(questions: ExtractedQuestion[]): ExtractedQuestion[] {
  if (questions.some((q) => String(q.question_number).trim() === '3')) return questions;

  const q2Index = questions.findIndex((q) => String(q.question_number).trim() === '2');
  if (q2Index < 0) return questions;

  const q2 = questions[q2Index];
  const subs = q2.sub_questions ?? [];
  const last = subs[subs.length - 1];
  if (!last || subs.length < 3) return questions;
  if (Number(last.marks) !== 6 || !isPlanningPrompt(last.question_text ?? '')) return questions;

  const head: ExtractedQuestion = {
    ...q2,
    sub_questions: subs.slice(0, -1),
    total_marks: sumMarks(subs.slice(0, -1)),
  };
  const tail: ExtractedQuestion = {
    ...q2,
    question_number: '3',
    parent_question_id: 'Q3',
    question_text: last.question_text,
    sub_questions: [],
    total_marks: 6,
    topic: 'Practical Planning',
    sub_topic: 'Experimental design and evaluation',
    has_diagram: false,
    diagram_url: null,
    diagram_type: null,
    resource_ref: null,
    bounding_box: null,
    options: null,
    data_tables: undefined,
  };

  const next = [...questions];
  next.splice(q2Index, 1, head, tail);
  return next;
}

/**
 * Repairs question boundaries for Cambridge practical papers.
 * Pure: the input array and its question objects are never modified.
 */
export function separatePracticalQuestions(questions: ExtractedQuestion[]): ExtractedQuestion[] {
  const q1Index = questions.findIndex(
    (q) => String(q.question_number).trim() === '1' && (q.sub_questions?.length ?? 0) > 2,
  );
  if (q1Index < 0) return splitPlanningQuestion([...questions]);

  const q1 = questions[q1Index];
  const subs = q1.sub_questions ?? [];
  const splitIndex = subs.findIndex((sq, i) => i > 0 && isQualitativeStart(sq.question_text ?? ''));
  if (splitIndex <= 0) return splitPlanningQuestion([...questions]);

  const q1Subs = subs.slice(0, splitIndex);
  const q2Subs = subs.slice(splitIndex);
  const existingQ2Index = questions.findIndex(
    (q, i) => i !== q1Index && String(q.question_number).trim() === '2',
  );

  const out: ExtractedQuestion[] = [];
  for (let i = 0; i < questions.length; i++) {
    if (i === q1Index) {
      out.push({ ...q1, sub_questions: q1Subs, total_marks: sumMarks(q1Subs) || q1.total_marks });
      if (existingQ2Index < 0) out.push(makeQualitativeQuestion(q1, q2Subs));
      continue;
    }
    if (i === existingQ2Index) {
      const merged = dedupeSubs([...q2Subs, ...(questions[i].sub_questions ?? [])]);
      out.push({ ...questions[i], sub_questions: merged, total_marks: sumMarks(merged) || questions[i].total_marks });
      continue;
    }
    out.push(questions[i]);
  }

  return splitPlanningQuestion(out);
}
