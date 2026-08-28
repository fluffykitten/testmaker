// ─── Gemini AI Mark-Scheme Grading Service ────────────────────────────────────
// Evaluates multi-mark structured and descriptive exam responses against the official
// Cambridge International Mark Scheme, providing point-by-point criteria breakdowns.

import type { Question, MarkScheme } from '../types/database';
import { parseRobustJson, getApiKeyForChunk } from '../lib/gemini';

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
  subGuidance: string | undefined,
  subMisconceptions: string[] | undefined,
  studentAnswer: string
): string {
  // If this is a sub-question, focus strictly on the sub-question's specific rubric
  const markingPoints = subMarkScheme
    ? subMarkScheme.split(/(?:;|\n)+/).map((p) => p.trim()).filter(Boolean)
    : [
        ...(markScheme?.marking_points || []),
        ...(markScheme?.acceptable_answers || []),
      ];

  const guidance = subGuidance
    ? [subGuidance, ...(markScheme?.guidance || [])]
    : markScheme?.guidance || [];

  const misconceptions = [
    ...(subMisconceptions || []),
    ...(markScheme?.common_misconceptions || []),
  ];

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
  const criteriaList = subMarkScheme
    ? subMarkScheme.split(/(?:;|\n)+/).map((p) => p.trim()).filter(Boolean)
    : [
        ...(markScheme?.marking_points || []),
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
  const sq = subQuestionIndex !== undefined && question.sub_questions?.[subQuestionIndex]
    ? question.sub_questions[subQuestionIndex]
    : undefined;

  const maxMarks = sq ? sq.marks || 1 : question.marks || 1;

  const questionText = sq
    ? `${question.question_text}\nPart (${sq.sub_id}): ${sq.question_text}`
    : question.question_text;

  const subMarkScheme = sq?.mark_scheme;
  const subGuidance = sq?.guidance;
  const subMisconceptions = sq?.common_misconceptions;

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

  // Dynamically resolve active Gemini API key from key pool
  const activeKey = getApiKeyForChunk(0) || import.meta.env.VITE_GEMINI_API_KEY || '';

  // If no Gemini API key, use rule-based fallback
  if (!activeKey) {
    const fallback = fallbackRuleBasedEvaluation(questionText, maxMarks, question.mark_scheme, subMarkScheme, studentAnswer);
    evaluationCache.set(cacheKey, fallback);
    return fallback;
  }

  const prompt = buildExaminerPrompt(
    questionText,
    maxMarks,
    question.mark_scheme,
    subMarkScheme,
    subGuidance,
    subMisconceptions,
    studentAnswer
  );

  const candidateModels = [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
  ];

  for (const model of candidateModels) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${activeKey}`,
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

// ─── 3. Personalized 1-Page Student Improvement Plan Generator ──────────────────

export interface StudentImprovementPlan {
  strengths: string[];
  weaknesses: string[];
  improvementSteps: string[];
  teacherSummary: string;
  encouragingWords: string;
}

/**
 * Generates personalized, actionable improvement feedback based on test performance
 * with an intelligent rule-based fallback and encouraging teacher words.
 */
export async function generateStudentImprovementPlan(
  submission: any
): Promise<StudentImprovementPlan> {
  const percentage = submission.percentage ?? 0;
  const grade =
    percentage >= 90
      ? 'A*'
      : percentage >= 80
      ? 'A'
      : percentage >= 70
      ? 'B'
      : percentage >= 60
      ? 'C'
      : percentage >= 50
      ? 'D'
      : percentage >= 40
      ? 'E'
      : 'U';

  // Topic breakdown lines
  const topicLines: string[] = [];
  if (submission.topicBreakdown) {
    Object.entries(submission.topicBreakdown).forEach(([topic, data]: [string, any]) => {
      const p = data.percentage !== undefined ? Math.round(data.percentage) : 0;
      topicLines.push(`- ${topic}: ${data.earnedMarks}/${data.totalMarks} marks (${p}%)`);
    });
  }

  // Missed questions list
  const missedList: string[] = [];
  if (Array.isArray(submission.questionResults)) {
    submission.questionResults.forEach((qr: any, idx: number) => {
      if (!qr.isCorrect) {
        const qNum = qr.questionNumber || idx + 1;
        missedList.push(
          `- Q${qNum} (${qr.topic || 'General'}): ${qr.earnedMarks}/${qr.maxMarks} marks. Student gave: "${qr.studentAnswer || 'No response'}", Expected: "${qr.correctAnswer || 'See mark scheme'}"`
        );
      }
    });
  }

  const isPerfect = submission.score === submission.totalMarks && submission.totalMarks > 0;

  // Encouraging Words based on score
  const getEncouragingWords = (): string => {
    if (isPerfect) {
      return '🌟 Flawless achievement! Your exceptional precision and mastery are truly inspiring. Keep striving for the highest horizons!';
    }
    if (percentage >= 80) {
      return '🌟 Outstanding dedication and stellar subject mastery! Keep sharpening your analytical thinking and precision—you are well on track for top-tier academic excellence. Believe in your limitless potential!';
    }
    if (percentage >= 60) {
      return '🚀 Great effort and strong foundational understanding! With targeted revision on the key focus areas above, you have every tool needed to reach the highest grade boundary. Keep up this wonderful momentum!';
    }
    if (percentage >= 40) {
      return '💡 Solid effort and positive engagement! Every challenge on this paper is a stepping stone for growth. Consistent practice of the key concepts and worked examples will unlock remarkable progress. You can do it!';
    }
    return '🌱 Every journey of mastery begins with understanding where to focus next. With dedicated review of core definitions and step-by-step guidance, you will make steady, confident strides. Believe in your growth!';
  };

  // 1. Intelligent Heuristic Rule-Based Fallback
  const generateFallbackPlan = (): StudentImprovementPlan => {
    const strengths: string[] = [];
    const weaknesses: string[] = [];
    const improvementSteps: string[] = [];

    if (submission.topicBreakdown) {
      Object.entries(submission.topicBreakdown).forEach(([topic, data]: [string, any]) => {
        if (data.percentage >= 75) {
          strengths.push(`Strong mastery in ${topic} (${Math.round(data.percentage)}% score).`);
        } else if (data.percentage < 60) {
          weaknesses.push(`Encountered difficulty in ${topic} (${data.earnedMarks}/${data.totalMarks} marks).`);
          improvementSteps.push(`Review core definitions, formulas, and diagrams for ${topic}.`);
        }
      });
    }

    if (strengths.length === 0) {
      if (submission.score > 0) {
        strengths.push(`Demonstrated solid effort across multiple question categories.`);
      } else {
        strengths.push(`Attempted questions and engaged with the examination.`);
      }
    }

    if (weaknesses.length === 0 && !isPerfect) {
      weaknesses.push(`Minor precision or calculation inaccuracies on isolated questions.`);
      improvementSteps.push(`Double-check calculations and re-read questions carefully before submitting.`);
    }

    if (isPerfect) {
      return {
        strengths: [
          `Outstanding mastery across all syllabus topics tested.`,
          `Flawless precision in both question analysis and technical execution.`,
        ],
        weaknesses: [`No significant weaknesses identified on this assessment.`],
        improvementSteps: [
          `Continue solving challenging past paper variants to maintain top-tier exam technique.`,
          `Explore extension and synoptic multi-topic exam problems.`,
        ],
        teacherSummary: `Superb performance! Full marks (${submission.score}/${submission.totalMarks}) achieved with exceptional understanding and accuracy.`,
        encouragingWords: getEncouragingWords(),
      };
    }

    if (improvementSteps.length === 0) {
      improvementSteps.push(`Practice 5-10 past paper questions focusing on missed question types.`);
      improvementSteps.push(`Review the official mark scheme criteria and examiners' tips.`);
    }

    improvementSteps.push(`Create summary flashcards for key terms and practice active recall.`);

    const teacherSummary =
      percentage >= 70
        ? `Strong foundation demonstrated (${submission.score}/${submission.totalMarks}). Focusing on the ${weaknesses.length} key areas above will easily push your grade to an A*.`
        : percentage >= 50
        ? `Good working knowledge shown (${submission.score}/${submission.totalMarks}). Targeted revision on the identified topics above will bring a significant score increase.`
        : `Consistent revision of core topic concepts and solving worked examples will help build confidence and secure higher marks.`;

    return {
      strengths: strengths.slice(0, 3),
      weaknesses: weaknesses.slice(0, 3),
      improvementSteps: improvementSteps.slice(0, 4),
      teacherSummary,
      encouragingWords: getEncouragingWords(),
    };
  };

  // 2. Attempt Gemini Enrichment if API key is active
  const activeKey = getApiKeyForChunk(0) || (import.meta.env as any)?.VITE_GEMINI_API_KEY || '';
  if (!activeKey) {
    return generateFallbackPlan();
  }

  const prompt = `You are an expert Cambridge International examiner and personal academic mentor.
Analyze this student's exam performance and generate a concise, personalized, highly actionable improvement plan with encouraging words for their 1-page feedback report card.

STUDENT: ${submission.studentName}
SUBJECT: ${submission.subject || 'General'}
EXAM: ${submission.quizTitle}
SCORE: ${submission.score} / ${submission.totalMarks} (${Math.round(percentage)}% - Grade ${grade})

TOPIC BREAKDOWN:
${topicLines.length > 0 ? topicLines.join('\n') : '- Overall assessment score'}

MISSED QUESTIONS:
${missedList.length > 0 ? missedList.slice(0, 8).join('\n') : '- None (Full marks scored)'}

Return ONLY valid JSON matching this exact schema:
{
  "strengths": ["1-2 concise bullet points highlighting concepts/topics the student mastered well"],
  "weaknesses": ["1-2 concise bullet points identifying specific concept gaps or question types where marks were lost"],
  "improvementSteps": [
    "Step 1: Specific topic or notes to review (e.g. 'Review notes on [Topic]...')",
    "Step 2: Concrete practice task (e.g. 'Practice 5 past-paper calculation/definition questions on...')",
    "Step 3: Exam technique tip (e.g. 'Check options carefully...')"
  ],
  "teacherSummary": "1-2 encouraging sentences from examiner summarizing their path to the next grade.",
  "encouragingWords": "1 warm, uplifting, motivational paragraph encouraging the student to believe in their academic growth."
}`;

  const candidateModels = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

  for (const model of candidateModels) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${activeKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0.2,
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
          if (parsed && Array.isArray(parsed.strengths) && Array.isArray(parsed.improvementSteps)) {
            return {
              strengths: parsed.strengths.filter(Boolean).slice(0, 3),
              weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses.filter(Boolean).slice(0, 3) : [],
              improvementSteps: parsed.improvementSteps.filter(Boolean).slice(0, 4),
              teacherSummary: parsed.teacherSummary || generateFallbackPlan().teacherSummary,
              encouragingWords: parsed.encouragingWords || getEncouragingWords(),
            };
          }
        }
      }
    } catch (err) {
      console.warn(`Model ${model} student improvement plan error:`, err);
    }
  }

  return generateFallbackPlan();
}
