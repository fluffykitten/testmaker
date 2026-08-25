// ─── Game Question Adapter ──────────────────────────────────────────────────
// Flattens MCQ, standalone structured, and multi-part sub-questions into unified
// interactive game rounds for Quizizz mode with deterministic fast-grading.

import type { Question, SubQuestion } from '../types/database';
import { gradeDeterministicAnswer } from './deterministicGradingService';

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
 * Extracts correct MCQ index from mark schemes or options
 */
function deriveCorrectOptionIndex(q: Question, sq?: SubQuestion): number {
  const options = sq?.options || q.options || [];
  if (options.length === 0) return 0;

  const ms = sq?.mark_scheme || q.mark_scheme;
  if (!ms) return 0;

  if (typeof ms === 'string') {
    const match = ms.trim().match(/^[\[\(]?([A-Da-d])[\]\)]?$/);
    if (match) {
      const idx = match[1].toUpperCase().charCodeAt(0) - 65;
      if (idx >= 0 && idx < options.length) return idx;
    }
  } else if (typeof ms === 'object' && ms !== null) {
    const pts = ms.marking_points || [];
    for (const pt of pts) {
      const match = pt.trim().match(/^[\[\(]?([A-Da-d])[\]\)]?$/);
      if (match) {
        const idx = match[1].toUpperCase().charCodeAt(0) - 65;
        if (idx >= 0 && idx < options.length) return idx;
      }
    }
  }

  return 0;
}

/**
 * Derives a human-readable model answer string
 */
function deriveCorrectAnswerText(q: Question, sq?: SubQuestion): string {
  if (sq) {
    if (sq.mark_scheme) return sq.mark_scheme;
    if (sq.options && sq.options.length > 0) return sq.options[0];
  }

  if (typeof q.mark_scheme === 'string') return q.mark_scheme;
  if (typeof q.mark_scheme === 'object' && q.mark_scheme !== null) {
    if (q.mark_scheme.acceptable_answers && q.mark_scheme.acceptable_answers.length > 0) {
      return q.mark_scheme.acceptable_answers[0];
    }
    if (q.mark_scheme.marking_points && q.mark_scheme.marking_points.length > 0) {
      return q.mark_scheme.marking_points.join('; ');
    }
  }
  if (q.options && q.options.length > 0) return q.options[0];
  return 'Credit scientifically accurate answer';
}

import { shuffleArray } from './gameScoreEngine';

/**
 * Flattens any mixture of MCQ, structured, and multi-part sub-questions into a linear list of playable game rounds.
 * Structured questions and sub-questions always maintain strict sequential order so that dependent parts stay grouped.
 */
export function flattenQuizQuestionsForGame(
  questions: Question[],
  options?: { shuffleQuestions?: boolean }
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
        const correctOpt = isSqMcq ? deriveCorrectOptionIndex(q, sq) : undefined;
        const answerText = deriveCorrectAnswerText(q, sq);

        items.push({
          id: `${q.id}_sub_${sq.sub_id || sIdx}`,
          parentQuestionId: q.id,
          roundNumber: roundCount++,
          title: `Question ${qNum}(${sq.sub_id || String.fromCharCode(97 + sIdx)})`,
          contextStem: q.question_text?.trim() ? q.question_text : undefined,
          questionText: sq.question_text || `Part (${sq.sub_id})`,
          diagramUrl: q.diagram_url || undefined,
          type: isSqMcq ? 'mcq' : 'structured',
          options: (isSqMcq && sq.options) ? sq.options : undefined,
          correctOptionIndex: correctOpt,
          correctAnswerText: answerText,
          acceptableAnswers: [answerText],
          marks: sq.marks || 1,
          rawQuestion: q,
          subQuestionIndex: sIdx,
        });
      }
    }
    // Case 2: Standard MCQ Question
    else if (q.options && q.options.length >= 2) {
      const correctOpt = deriveCorrectOptionIndex(q);
      const answerText = q.options[correctOpt] || q.options[0];

      items.push({
        id: q.id,
        parentQuestionId: q.id,
        roundNumber: roundCount++,
        title: `Question ${qNum}`,
        questionText: q.question_text || 'Select the correct option:',
        diagramUrl: q.diagram_url || undefined,
        type: 'mcq',
        options: q.options,
        correctOptionIndex: correctOpt,
        correctAnswerText: answerText,
        acceptableAnswers: [answerText],
        marks: q.marks || 1,
        rawQuestion: q,
      });
    }
    // Case 3: Standalone Structured / Short Answer Question
    else {
      const answerText = deriveCorrectAnswerText(q);

      items.push({
        id: q.id,
        parentQuestionId: q.id,
        roundNumber: roundCount++,
        title: `Question ${qNum}`,
        questionText: q.question_text || 'Enter your chemical formula or calculation:',
        diagramUrl: q.diagram_url || undefined,
        type: 'structured',
        correctAnswerText: answerText,
        acceptableAnswers: [answerText],
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

  // Fallback direct case-insensitive or partial keyword check
  const isMatch = rawStr.toLowerCase() === item.correctAnswerText.toLowerCase() ||
    (rawStr.length >= 3 && item.correctAnswerText.toLowerCase().includes(rawStr.toLowerCase()));

  return {
    isCorrect: isMatch,
    correctDisplay: item.correctAnswerText,
    feedbackText: isMatch ? '✓ Correct!' : `Expected: ${item.correctAnswerText}`,
  };
}
