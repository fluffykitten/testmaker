// ─── Game Question Adapter ──────────────────────────────────────────────────
// Flattens MCQ, standalone structured, and multi-part sub-questions into unified
// interactive game rounds for Quizizz mode with deterministic fast-grading.

import type { Question, SubQuestion } from '../types/database';
import {
  gradeDeterministicAnswer,
  resolveMcqCorrectOptionIndex,
  extractAcceptableAnswers,
} from './deterministicGradingService';

export interface GamePlayableItem {
  id: string;
  parentQuestionId: string;
  roundNumber: number;
  title: string;                 // e.g. "Question 1(a)" or "Question 3"
  contextStem?: string;          // shared scenario / apparatus context
  questionText: string;          // prompt for this round
  diagramUrl?: string;
  type: 'mcq' | 'structured';    // 'mcq' (choices) or 'structured' (typed answer)
  options?: string[];
  correctOptionIndex?: number;
  correctAnswerText: string;
  acceptableAnswers?: string[];
  marks: number;
  rawQuestion: Question;
  subQuestionIndex?: number;
}

/**
 * Extracts correct MCQ index from mark schemes or options using robust parser
 */
export function deriveCorrectOptionIndex(q: Question, _sq?: SubQuestion, sIdx?: number): number {
  return resolveMcqCorrectOptionIndex(q, sIdx);
}

/**
 * Derives a human-readable model answer string
 */
function deriveCorrectAnswerText(q: Question, sq?: SubQuestion, sIdx?: number): string {
  // If this sub-question has multiple choice options
  if (sq && sq.options && sq.options.length >= 2) {
    const cIdx = resolveMcqCorrectOptionIndex(q, sIdx);
    return sq.options[cIdx] || sq.options[0];
  }

  // If this sub-question has a dedicated mark scheme
  if (sq) {
    if (typeof sq.mark_scheme === 'string' && sq.mark_scheme.trim()) {
      return sq.mark_scheme.trim();
    }
    if (typeof (sq as any).mark_scheme === 'object' && sq.mark_scheme !== null) {
      const msObj: any = sq.mark_scheme;
      if (Array.isArray(msObj.marking_points) && msObj.marking_points.length > 0) {
        return msObj.marking_points.join('; ');
      }
      if (Array.isArray(msObj.acceptable_answers) && msObj.acceptable_answers.length > 0) {
        return msObj.acceptable_answers.join('; ');
      }
    }
    if (sq.options && sq.options.length > 0) return sq.options[0];
  }

  // If the parent question is MCQ
  if (q.options && q.options.length >= 2) {
    const cIdx = resolveMcqCorrectOptionIndex(q);
    return q.options[cIdx] || q.options[0];
  }

  // If the parent question has a mark scheme
  const qMs: any = q.mark_scheme;
  if (typeof qMs === 'string' && qMs.trim()) {
    return qMs.trim();
  }
  if (typeof qMs === 'object' && qMs !== null) {
    const pts = (qMs.marking_points || []).filter(
      (p: string) => !/see sub-question breakdown/i.test(p)
    );
    const acc = qMs.acceptable_answers || [];
    if (acc.length > 0) return acc.join('; ');
    if (pts.length > 0) return pts.join('; ');
  }

  // Try extracting acceptable answers from question bank
  const acceptable = extractAcceptableAnswers(q, sIdx);
  if (acceptable.length > 0) {
    return acceptable[0];
  }

  if (q.options && q.options.length > 0) return q.options[0];
  return 'Credit scientifically accurate answer';
}

import { cleanMcqOptionContent } from './quizSubmissionService';
import { shuffleArray } from './gameScoreEngine';

/**
 * Helper to shuffle MCQ options while recalculating the correct option index
 * and preserving or updating clean option letters (Option A, Option B, etc.)
 */
function processMcqOptions(
  rawOptions: string[],
  origCorrectIdx: number,
  shouldShuffle: boolean
): { options: string[]; correctOptionIndex: number } {
  if (!shouldShuffle || rawOptions.length < 2) {
    return { options: rawOptions, correctOptionIndex: origCorrectIdx };
  }

  // Detect if options have letter prefixes like "A:", "A.", "(A)", "Option A"
  const hasLetterPrefix = rawOptions.every((opt) =>
    /^[([]?[A-Da-d][)\]\.:\s-]/i.test(opt.trim())
  );

  // Pair each option with its original index
  const indexed = rawOptions.map((opt, idx) => ({
    originalIdx: idx,
    cleanedText: cleanMcqOptionContent(opt, idx),
    rawText: opt,
  }));

  const shuffled = shuffleArray(indexed);
  let newCorrectIdx = shuffled.findIndex((item) => item.originalIdx === origCorrectIdx);
  if (newCorrectIdx === -1) newCorrectIdx = 0;

  const newOptions = shuffled.map((item, newIdx) => {
    if (hasLetterPrefix) {
      return `Option ${String.fromCharCode(65 + newIdx)}: ${item.cleanedText}`;
    }
    return item.cleanedText || item.rawText;
  });

  return { options: newOptions, correctOptionIndex: newCorrectIdx };
}

/**
 * Flattens any mixture of MCQ, structured, and multi-part sub-questions into a linear list of playable game rounds.
 * Structured questions and sub-questions always maintain strict sequential order so that dependent parts stay grouped.
 */
export function flattenQuizQuestionsForGame(
  questions: Question[],
  options?: { shuffleQuestions?: boolean; shuffleOptions?: boolean }
): GamePlayableItem[] {
  let parentList = [...questions];

  // Check if this quiz contains structured questions or multi-part sub-questions
  const hasStructured = parentList.some(
    (q) => !q.options || q.options.length < 2 || (q.sub_questions && q.sub_questions.length > 0)
  );

  // Only randomize top-level standalone questions if it's a pure MCQ set
  // Structured questions are never randomized to keep related sub-questions and narrative calculation steps in order
  if (options?.shuffleQuestions && !hasStructured) {
    parentList = shuffleArray(parentList);
  }

  const items: GamePlayableItem[] = [];
  let roundCount = 1;

  for (let qIdx = 0; qIdx < parentList.length; qIdx++) {
    const q = parentList[qIdx];
    const qNum = q.question_number || String(qIdx + 1);

    // Case 1: Multi-Part Structured Question (sub-questions always strictly sequential)
    if (q.sub_questions && q.sub_questions.length > 0) {
      for (let sIdx = 0; sIdx < q.sub_questions.length; sIdx++) {
        const sq = q.sub_questions[sIdx];
        const isSqMcq = !!(sq.options && sq.options.length >= 2);
        let sqOptions = (isSqMcq && sq.options) ? sq.options : undefined;
        let correctOpt: number | undefined = undefined;

        if (isSqMcq && sq.options) {
          const origCorrectIdx = resolveMcqCorrectOptionIndex(q, sIdx);
          const processed = processMcqOptions(sq.options, origCorrectIdx, !!options?.shuffleOptions);
          sqOptions = processed.options;
          correctOpt = processed.correctOptionIndex;
        }

        const answerText = isSqMcq && sqOptions && correctOpt !== undefined
          ? sqOptions[correctOpt]
          : deriveCorrectAnswerText(q, sq, sIdx);
        const acceptableAnswers = extractAcceptableAnswers(q, sIdx);
        if (!acceptableAnswers.includes(answerText)) acceptableAnswers.unshift(answerText);
        if (isSqMcq && correctOpt !== undefined) {
          const optLetter = String.fromCharCode(65 + correctOpt);
          if (!acceptableAnswers.includes(optLetter)) acceptableAnswers.push(optLetter);
        }

        items.push({
          id: `${q.id}_sub_${sq.sub_id || sIdx}`,
          parentQuestionId: q.id,
          roundNumber: roundCount++,
          title: `Question ${qNum}(${sq.sub_id || String.fromCharCode(97 + sIdx)})`,
          contextStem: q.question_text?.trim() ? q.question_text : undefined,
          questionText: sq.question_text || `Part (${sq.sub_id})`,
          diagramUrl: sq.diagram_url || q.diagram_url || undefined,
          type: isSqMcq ? 'mcq' : 'structured',
          options: sqOptions,
          correctOptionIndex: correctOpt,
          correctAnswerText: answerText,
          acceptableAnswers,
          marks: sq.marks || 1,
          rawQuestion: q,
          subQuestionIndex: sIdx,
        });
      }
    }
    // Case 2: Standard MCQ Question
    else if (q.options && q.options.length >= 2) {
      const origCorrectIdx = resolveMcqCorrectOptionIndex(q);
      const processed = processMcqOptions(q.options, origCorrectIdx, !!options?.shuffleOptions);
      const finalOptions = processed.options;
      const finalCorrectOpt = processed.correctOptionIndex;
      const answerText = finalOptions[finalCorrectOpt] || finalOptions[0];
      const acceptableAnswers = extractAcceptableAnswers(q);
      if (!acceptableAnswers.includes(answerText)) acceptableAnswers.unshift(answerText);
      const optLetter = String.fromCharCode(65 + finalCorrectOpt);
      if (!acceptableAnswers.includes(optLetter)) acceptableAnswers.push(optLetter);

      items.push({
        id: q.id,
        parentQuestionId: q.id,
        roundNumber: roundCount++,
        title: `Question ${qNum}`,
        questionText: q.question_text || 'Select the correct option:',
        diagramUrl: q.diagram_url || undefined,
        type: 'mcq',
        options: finalOptions,
        correctOptionIndex: finalCorrectOpt,
        correctAnswerText: answerText,
        acceptableAnswers,
        marks: q.marks || 1,
        rawQuestion: q,
      });
    }
    // Case 3: Standalone Structured / Short Answer Question
    else {
      const answerText = deriveCorrectAnswerText(q);
      const acceptableAnswers = extractAcceptableAnswers(q);
      if (!acceptableAnswers.includes(answerText)) acceptableAnswers.unshift(answerText);

      items.push({
        id: q.id,
        parentQuestionId: q.id,
        roundNumber: roundCount++,
        title: `Question ${qNum}`,
        questionText: q.question_text || 'Enter your chemical formula or calculation:',
        diagramUrl: q.diagram_url || undefined,
        type: 'structured',
        correctAnswerText: answerText,
        acceptableAnswers,
        marks: q.marks || 1,
        rawQuestion: q,
      });
    }
  }

  return items;
}

/**
 * Evaluates a player's answer (MCQ option index or typed string) deterministically in Game Mode.
 */
export function evaluateGameAnswer(
  item: GamePlayableItem,
  playerAnswer: number | string | undefined | null
): { isCorrect: boolean; correctDisplay: string; feedbackText?: string } {
  if (playerAnswer === undefined || playerAnswer === null || String(playerAnswer).trim() === '') {
    return {
      isCorrect: false,
      correctDisplay: item.correctAnswerText,
      feedbackText: 'No answer submitted.',
    };
  }

  // 1. MCQ Evaluation
  if (item.type === 'mcq') {
    const selectedIdx = Number(playerAnswer);
    const isMatch = selectedIdx === item.correctOptionIndex;
    return {
      isCorrect: isMatch,
      correctDisplay: item.options?.[item.correctOptionIndex || 0] || item.correctAnswerText,
      feedbackText: isMatch ? '✓ Correct Choice!' : 'Incorrect option selected',
    };
  }

  // 2. Structured / Chemical / Numerical Evaluation
  const rawStr = String(playerAnswer).trim();
  const detResult = gradeDeterministicAnswer(rawStr, item.rawQuestion, item.subQuestionIndex);

  if (detResult.isHandled) {
    return {
      isCorrect: detResult.isCorrect,
      correctDisplay: item.correctAnswerText,
      feedbackText: detResult.feedback,
    };
  }

  // Fallback check against all acceptable answers from Question Bank
  const cleanInput = rawStr.toLowerCase().replace(/\s+/g, '');
  const isMatch = (item.acceptableAnswers || [item.correctAnswerText]).some((ans) => {
    const cleanAns = ans.toLowerCase().replace(/\s+/g, '').replace(/\[\d+\]/g, '');
    return (
      cleanInput === cleanAns ||
      (cleanInput.length >= 3 && cleanAns.includes(cleanInput)) ||
      (cleanAns.length >= 3 && cleanInput.includes(cleanAns))
    );
  });

  return {
    isCorrect: isMatch,
    correctDisplay: item.correctAnswerText,
    feedbackText: isMatch ? '✓ Correct!' : `Expected: ${item.correctAnswerText}`,
  };
}
