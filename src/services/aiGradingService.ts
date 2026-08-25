// ─── Gemini AI Mark-Scheme Grading Service ────────────────────────────────────
// Evaluates multi-mark structured and descriptive exam responses against the official
// Cambridge International Mark Scheme, providing point-by-point criteria breakdowns.

import type { Question, MarkScheme } from '../types/database';
import { parseRobustJson } from '../lib/gemini';

export interface AICriteriaPoint {
  point: string;
  achieved: boolean;
  examinerNote?: string;
}

export interface AIEvaluationResult {
  earnedMarks: number;
  maxMarks: number;
  isCorrect: boolean;
  criteriaResults: AICriteriaPoint[];
  strengths: string[];
  missingKeyPoints: string[];
  feedback: string;
  evaluatedBy: 'gemini' | 'rule_fallback';
}

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;

// Cache evaluation results to eliminate redundant API calls
const evaluationCache = new Map<string, AIEvaluationResult>();

/**
 * Builds the examiner prompt for evaluating student descriptive answers
 */
function buildExaminerPrompt(
  questionText: string,
  maxMarks: number,
  markScheme: MarkScheme | null | undefined,
  subMarkScheme: string | undefined,
  studentAnswer: string
): string {
  const markingPoints = [
    ...(markScheme?.marking_points || []),
    ...(subMarkScheme ? [subMarkScheme] : []),
    ...(markScheme?.acceptable_answers || []),
  ];

  const guidance = markScheme?.guidance || [];
  const misconceptions = markScheme?.common_misconceptions || [];

  return `You are an expert Cambridge International Examinations (CIE) Senior Examiner for Chemistry & Sciences.
Your task is to accurately assess a student's answer against the official mark scheme criteria.

QUESTION CONTEXT:
"${questionText}"

MAXIMUM MARKS AVAILABLE: ${maxMarks}

OFFICIAL MARK SCHEME CRITERIA:
${markingPoints.map((p, idx) => `Point ${idx + 1}: ${p}`).join('\n') || 'Evaluate based on standard scientific accuracy for the question.'}

${guidance.length > 0 ? `EXAMINER GUIDANCE & ACCEPTABLE ALTERNATIVES:\n${guidance.join('\n')}\n` : ''}
${misconceptions.length > 0 ? `COMMON MISCONCEPTIONS TO WATCH FOR:\n${misconceptions.join('\n')}\n` : ''}

STUDENT'S SUBMITTED RESPONSE:
"""
${studentAnswer}
"""

MARKING INSTRUCTIONS:
1. Award marks (0 to ${maxMarks}) strictly based on how many mark scheme criteria points are satisfied or scientifically equivalent concepts are articulated.
2. Allow equivalent chemical and scientific phrasing (as standard in Cambridge mark schemes).
3. Check for specific criteria achieved and criteria missed.
4. If the student makes a common misconception or invalid scientific claim, explain why gently.

Return ONLY a JSON object with this EXACT structure (no markdown fences, no conversational filler):
{
  "earnedMarks": <number between 0 and ${maxMarks}>,
  "criteriaResults": [
    {
      "point": "<Criterion description from mark scheme>",
      "achieved": <true or false>,
      "examinerNote": "<Brief explanation of why this mark was or was not awarded>"
    }
  ],
  "strengths": ["<What the student answered correctly>"],
  "missingKeyPoints": ["<Key concepts or steps omitted>"],
  "feedback": "<Constructive 1-2 sentence examiner advice on how to improve or achieve full marks>"
}`;
}

/**
 * Fallback rule-based evaluator when offline or Gemini API is not available
 */
function fallbackRuleBasedEvaluation(
  _questionText: string,
  maxMarks: number,
  markScheme: MarkScheme | null | undefined,
  subMarkScheme: string | undefined,
  studentAnswer: string
): AIEvaluationResult {
  const cleanAnswer = studentAnswer.toLowerCase();
  const criteriaList = [
    ...(markScheme?.marking_points || []),
    ...(subMarkScheme ? [subMarkScheme] : []),
    ...(markScheme?.acceptable_answers || []),
  ];

  if (criteriaList.length === 0) {
    const isNonEmpty = cleanAnswer.trim().length >= 10;
    const earned = isNonEmpty ? Math.ceil(maxMarks / 2) : 0;
    return {
      earnedMarks: earned,
      maxMarks,
      isCorrect: earned === maxMarks,
      criteriaResults: [{ point: 'Scientific response submitted', achieved: isNonEmpty }],
      strengths: isNonEmpty ? ['Provided relevant written explanation'] : [],
      missingKeyPoints: isNonEmpty ? [] : ['Answer missing'],
      feedback: isNonEmpty ? 'Response recorded. Refer to the model solution for marking breakdown.' : 'No answer provided.',
      evaluatedBy: 'rule_fallback',
    };
  }

  let earnedMarks = 0;
  const criteriaResults: AICriteriaPoint[] = [];
  const strengths: string[] = [];
  const missingKeyPoints: string[] = [];

  for (const criterion of criteriaList) {
    // Extract key words (> 3 chars)
    const keywords = criterion
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !['than', 'with', 'from', 'this', 'that', 'they', 'will', 'have', 'more', 'less'].includes(w));

    const matchedCount = keywords.filter((kw) => cleanAnswer.includes(kw)).length;
    const isAchieved = keywords.length > 0 ? matchedCount >= Math.ceil(keywords.length * 0.4) : cleanAnswer.length > 10;

    criteriaResults.push({
      point: criterion,
      achieved: isAchieved,
      examinerNote: isAchieved ? 'Key scientific concept identified' : 'Key concept not sufficiently explained',
    });

    if (isAchieved) {
      strengths.push(criterion);
      if (earnedMarks < maxMarks) earnedMarks++;
    } else {
      missingKeyPoints.push(criterion);
    }
  }

  return {
    earnedMarks: Math.min(earnedMarks, maxMarks),
    maxMarks,
    isCorrect: earnedMarks === maxMarks,
    criteriaResults,
    strengths,
    missingKeyPoints,
    feedback: earnedMarks === maxMarks
      ? 'Excellent answer addressing all core marking criteria!'
      : `Awarded ${earnedMarks}/${maxMarks} marks. Review missing marking points above.`,
    evaluatedBy: 'rule_fallback',
  };
}

/**
 * Evaluates a student's descriptive explanation using Gemini AI with fallback
 */
export async function evaluateAnswerWithGemini(
  question: Question,
  subQuestionIndex: number | undefined,
  studentAnswer: string
): Promise<AIEvaluationResult> {
  const maxMarks = (subQuestionIndex !== undefined && question.sub_questions?.[subQuestionIndex])
    ? question.sub_questions[subQuestionIndex].marks || 1
    : question.marks || 1;

  const questionText = (subQuestionIndex !== undefined && question.sub_questions?.[subQuestionIndex])
    ? `${question.question_text}\nPart (${question.sub_questions[subQuestionIndex].sub_id}): ${question.sub_questions[subQuestionIndex].question_text}`
    : question.question_text;

  const subMarkScheme = subQuestionIndex !== undefined ? question.sub_questions?.[subQuestionIndex]?.mark_scheme : undefined;

  // Check cache
  const cacheKey = `${question.id}_${subQuestionIndex ?? 'main'}_${studentAnswer.trim()}`;
  if (evaluationCache.has(cacheKey)) {
    return evaluationCache.get(cacheKey)!;
  }

  // If student answer is empty
  if (!studentAnswer || studentAnswer.trim() === '') {
    const emptyResult: AIEvaluationResult = {
      earnedMarks: 0,
      maxMarks,
      isCorrect: false,
      criteriaResults: [],
      strengths: [],
      missingKeyPoints: ['No answer provided'],
      feedback: 'No response submitted for this question.',
      evaluatedBy: 'rule_fallback',
    };
    evaluationCache.set(cacheKey, emptyResult);
    return emptyResult;
  }

  // If no Gemini API key, use rule-based fallback
  if (!GEMINI_API_KEY) {
    const fallback = fallbackRuleBasedEvaluation(questionText, maxMarks, question.mark_scheme, subMarkScheme, studentAnswer);
    evaluationCache.set(cacheKey, fallback);
    return fallback;
  }

  const prompt = buildExaminerPrompt(questionText, maxMarks, question.mark_scheme, subMarkScheme, studentAnswer);

  const candidateModels = [
    'gemini-1.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash-latest',
    'gemini-1.5-pro',
  ];

  for (const model of candidateModels) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [{ text: prompt }],
              },
            ],
            generationConfig: {
              temperature: 0.1,
              responseMimeType: 'application/json',
            },
          }),
        }
      );

      if (response.ok) {
        const data = await response.json();
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (rawText) {
          const parsed = parseRobustJson<any>(rawText);
          const earned = Math.min(Math.max(0, Math.round(Number(parsed.earnedMarks) || 0)), maxMarks);

          const result: AIEvaluationResult = {
            earnedMarks: earned,
            maxMarks,
            isCorrect: earned === maxMarks,
            criteriaResults: Array.isArray(parsed.criteriaResults) ? parsed.criteriaResults : [],
            strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
            missingKeyPoints: Array.isArray(parsed.missingKeyPoints) ? parsed.missingKeyPoints : [],
            feedback: parsed.feedback || (earned === maxMarks ? 'Full marks awarded!' : 'Review the mark scheme for full credit.'),
            evaluatedBy: 'gemini',
          };

          evaluationCache.set(cacheKey, result);
          return result;
        }
      }
    } catch (err) {
      console.warn(`Model ${model} grading error:`, err);
    }
  }

  // If all Gemini calls failed, use rule-based fallback
  const fallback = fallbackRuleBasedEvaluation(questionText, maxMarks, question.mark_scheme, subMarkScheme, studentAnswer);
  evaluationCache.set(cacheKey, fallback);
  return fallback;
}
