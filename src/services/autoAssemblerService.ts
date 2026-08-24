import type { Question } from '../types/database';
import { fetchQuestions } from './questionBankService';

export interface DifficultyBalance {
  easy: number; // percentage (e.g. 30)
  medium: number; // percentage (e.g. 50)
  hard: number; // percentage (e.g. 20)
}

export type QuestionStyleFilter = 'all' | 'structured' | 'mcq';
export type DiagramPreference = 'any' | 'require_diagram' | 'no_diagram';
export type AssemblySortOrder = 'progressive' | 'topic' | 'natural';

export interface TestAssemblyCriteria {
  targetMarks: number;
  durationMinutes?: number;
  syllabusId?: string | null;
  selectedTopics: string[]; // empty array means all topics
  topicProportions?: Record<string, number>; // optional topic % weights e.g. { "Topic A": 40, "Topic B": 60 }
  difficultyBalance: DifficultyBalance;
  questionStyle: QuestionStyleFilter;
  diagramPreference: DiagramPreference;
  sortOrder: AssemblySortOrder;
}

export interface AssemblyResult {
  questions: Question[];
  totalMarks: number;
  targetMarks: number;
  markDifference: number;
  estimatedDuration: number;
  difficultyStats: {
    easyMarks: number;
    mediumMarks: number;
    hardMarks: number;
    easyPercent: number;
    mediumPercent: number;
    hardPercent: number;
  };
  topicStats: {
    topic: string;
    marks: number;
    questionCount: number;
    percent: number;
  }[];
  isExactMatch: boolean;
  deficitMarks: number;
}

export const DIFFICULTY_PRESETS: {
  id: string;
  name: string;
  desc: string;
  balance: DifficultyBalance;
}[] = [
  {
    id: 'cambridge_standard',
    name: 'Cambridge Standard',
    desc: 'Balanced standard assessment (30% Foundation, 50% Core, 20% Stretch)',
    balance: { easy: 30, medium: 50, hard: 20 },
  },
  {
    id: 'foundation_booster',
    name: 'Foundation Booster',
    desc: 'Scaffolded support & confidence building (60% Easy, 30% Medium, 10% Hard)',
    balance: { easy: 60, medium: 30, hard: 10 },
  },
  {
    id: 'higher_challenge',
    name: 'Higher Tier Challenge',
    desc: 'Rigorous exam preparation & discrimination (10% Easy, 40% Medium, 50% Hard)',
    balance: { easy: 10, medium: 40, hard: 50 },
  },
  {
    id: 'equal_spread',
    name: 'Equal Spread',
    desc: 'Uniform difficulty across all sections (33% Easy, 34% Medium, 33% Hard)',
    balance: { easy: 33, medium: 34, hard: 33 },
  },
];

/**
 * Main Constraint-Satisfaction Solver
 * Assembles an exam paper matching target marks, topic weights/proportions, and difficulty balance.
 */
export async function assembleTestFromCriteria(
  criteria: TestAssemblyCriteria,
  customPool?: Question[]
): Promise<AssemblyResult> {
  // 1. Fetch Question Pool
  let pool: Question[] = [];
  if (customPool && customPool.length > 0) {
    pool = [...customPool];
  } else {
    const fetched = await fetchQuestions({
      syllabusId: criteria.syllabusId || undefined,
      pageSize: 500, // Load large pool for assembly
    });
    pool = fetched.questions;
  }

  // 2. Filter pool based on basic hard constraints
  let candidates = pool.filter((q) => {
    // Topic filter
    if (criteria.selectedTopics.length > 0) {
      if (!criteria.selectedTopics.includes(q.topic)) {
        return false;
      }
    }

    // Question style filter
    const isMcq = q.question_style === 'Multiple Choice' || (q.question_style as string) === 'MCQ';
    if (criteria.questionStyle === 'structured') {
      if (isMcq) {
        return false;
      }
    } else if (criteria.questionStyle === 'mcq') {
      if (!isMcq) {
        return false;
      }
    }

    // Diagram preference filter
    if (criteria.diagramPreference === 'require_diagram' && !q.diagram_url) {
      return false;
    }
    if (criteria.diagramPreference === 'no_diagram' && q.diagram_url) {
      return false;
    }

    return true;
  });

  // If candidate list is empty, return empty assembly
  if (candidates.length === 0) {
    return buildEmptyResult(criteria.targetMarks);
  }

  // Shuffle candidates to allow varied combinations on each re-roll
  candidates = shuffleArray(candidates);

  const selected: Question[] = [];
  const usedIds = new Set<string>();

  // 3. Check if custom topic proportions/weights are provided
  const hasTopicProportions =
    criteria.topicProportions &&
    Object.keys(criteria.topicProportions).length > 0 &&
    Object.values(criteria.topicProportions).some((v) => v > 0);

  if (hasTopicProportions && criteria.topicProportions) {
    // Proportional Topic Allocation Mode
    const totalWeight = Object.values(criteria.topicProportions).reduce((sum, w) => sum + w, 0) || 100;
    const topicTargetMarksMap: Record<string, number> = {};

    Object.entries(criteria.topicProportions).forEach(([topic, weight]) => {
      topicTargetMarksMap[topic] = Math.round((criteria.targetMarks * weight) / totalWeight);
    });

    // Helper: Select from a specific topic pool honoring difficulty balance
    for (const [topic, targetTopicMarks] of Object.entries(topicTargetMarksMap)) {
      if (targetTopicMarks <= 0) continue;

      const topicPool = candidates.filter((q) => q.topic === topic && !usedIds.has(q.id));
      if (topicPool.length === 0) continue;

      const targetEasy = Math.round((targetTopicMarks * criteria.difficultyBalance.easy) / 100);
      const targetMed = Math.round((targetTopicMarks * criteria.difficultyBalance.medium) / 100);
      const targetHard = Math.max(0, targetTopicMarks - targetEasy - targetMed);

      let topicCurrentMarks = 0;

      const fillTopicDifficulty = (diffName: string, subTarget: number) => {
        let subMarks = 0;
        const bucket = topicPool.filter(
          (q) => !usedIds.has(q.id) && (diffName === 'Medium' ? (!q.difficulty || q.difficulty === 'Medium') : q.difficulty === diffName)
        );
        for (const q of bucket) {
          const qMarks = q.marks || 1;
          if (topicCurrentMarks + qMarks <= targetTopicMarks + 2 || topicCurrentMarks === 0) {
            selected.push(q);
            usedIds.add(q.id);
            subMarks += qMarks;
            topicCurrentMarks += qMarks;
            if (subMarks >= subTarget || topicCurrentMarks >= targetTopicMarks) break;
          }
        }
      };

      fillTopicDifficulty('Easy', targetEasy);
      fillTopicDifficulty('Medium', targetMed);
      fillTopicDifficulty('Hard', targetHard);

      // If topic still has deficit, take any remaining question from this topic
      if (topicCurrentMarks < targetTopicMarks) {
        const remainingInTopic = topicPool.filter((q) => !usedIds.has(q.id));
        for (const q of remainingInTopic) {
          const qMarks = q.marks || 1;
          if (topicCurrentMarks + qMarks <= targetTopicMarks + 2) {
            selected.push(q);
            usedIds.add(q.id);
            topicCurrentMarks += qMarks;
            if (topicCurrentMarks >= targetTopicMarks) break;
          }
        }
      }
    }
  } else {
    // Standard Global Difficulty Distribution Mode
    // 3. Partition pool into difficulty buckets
    const easyPool = candidates.filter((q) => q.difficulty === 'Easy');
    const mediumPool = candidates.filter((q) => !q.difficulty || q.difficulty === 'Medium');
    const hardPool = candidates.filter((q) => q.difficulty === 'Hard');

    // Calculate target marks for each difficulty bucket
    const targetEasyMarks = Math.round((criteria.targetMarks * criteria.difficultyBalance.easy) / 100);
    const targetMediumMarks = Math.round((criteria.targetMarks * criteria.difficultyBalance.medium) / 100);
    const targetHardMarks = Math.max(0, criteria.targetMarks - targetEasyMarks - targetMediumMarks);

    function selectFromBucket(bucket: Question[], targetSubMarks: number) {
      let currentMarks = 0;
      // Sort bucket by prioritizing under-represented topics
      const sorted = [...bucket].sort((a, b) => {
        const aCount = selected.filter((s) => s.topic === a.topic).length;
        const bCount = selected.filter((s) => s.topic === b.topic).length;
        return aCount - bCount;
      });

      for (const q of sorted) {
        if (usedIds.has(q.id)) continue;
        const qMarks = q.marks || 1;
        // Allow slight overshoot (up to 2 marks) if it gets closer to target
        if (currentMarks + qMarks <= targetSubMarks + 2 || currentMarks === 0) {
          selected.push(q);
          usedIds.add(q.id);
          currentMarks += qMarks;
          if (currentMarks >= targetSubMarks) break;
        }
      }
    }

    selectFromBucket(easyPool, targetEasyMarks);
    selectFromBucket(mediumPool, targetMediumMarks);
    selectFromBucket(hardPool, targetHardMarks);
  }

  // 5. If we have remaining mark deficit, fill from any remaining candidates
  let currentTotalMarks = selected.reduce((sum, q) => sum + (q.marks || 1), 0);
  if (currentTotalMarks < criteria.targetMarks) {
    const remaining = candidates.filter((q) => !usedIds.has(q.id));
    for (const q of remaining) {
      const qMarks = q.marks || 1;
      if (currentTotalMarks + qMarks <= criteria.targetMarks + 2) {
        selected.push(q);
        usedIds.add(q.id);
        currentTotalMarks += qMarks;
        if (currentTotalMarks >= criteria.targetMarks) break;
      }
    }
  }

  // 6. Sort selected questions based on requested layout order
  const sortedQuestions = sortAssembledQuestions(selected, criteria.sortOrder);

  // 7. Calculate comprehensive breakdown statistics
  return calculateAssemblyResult(sortedQuestions, criteria.targetMarks, criteria.durationMinutes);
}

/**
 * Sorts assembled questions according to teacher preference.
 */
function sortAssembledQuestions(
  questions: Question[],
  sortOrder: AssemblySortOrder
): Question[] {
  const result = [...questions];

  if (sortOrder === 'progressive') {
    // Easy -> Medium -> Hard, then ascending marks
    const diffRank = (d: string | null) => (d === 'Easy' ? 1 : d === 'Hard' ? 3 : 2);
    result.sort((a, b) => {
      const diffDiff = diffRank(a.difficulty) - diffRank(b.difficulty);
      if (diffDiff !== 0) return diffDiff;
      return (a.marks || 1) - (b.marks || 1);
    });
  } else if (sortOrder === 'topic') {
    // Grouped by Topic, then by difficulty
    result.sort((a, b) => {
      const topicDiff = (a.topic || '').localeCompare(b.topic || '');
      if (topicDiff !== 0) return topicDiff;
      return (a.marks || 1) - (b.marks || 1);
    });
  } else {
    // 'natural' - MCQ first, then short structured, then long structured
    result.sort((a, b) => {
      const aIsMcq = (a.question_style as string) === 'MCQ' || a.question_style === 'Multiple Choice' ? 0 : 1;
      const bIsMcq = (b.question_style as string) === 'MCQ' || b.question_style === 'Multiple Choice' ? 0 : 1;
      if (aIsMcq !== bIsMcq) return aIsMcq - bIsMcq;
      return (a.marks || 1) - (b.marks || 1);
    });
  }

  return result;
}

/**
 * Calculates analytics and statistics for the assembled test paper.
 */
function calculateAssemblyResult(
  questions: Question[],
  targetMarks: number,
  durationMinutes?: number
): AssemblyResult {
  const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 1), 0);
  const estimatedDuration = durationMinutes || Math.round(totalMarks * 1.25);

  let easyMarks = 0;
  let mediumMarks = 0;
  let hardMarks = 0;

  const topicMap: Record<string, { marks: number; count: number }> = {};

  for (const q of questions) {
    const m = q.marks || 1;
    if (q.difficulty === 'Easy') easyMarks += m;
    else if (q.difficulty === 'Hard') hardMarks += m;
    else mediumMarks += m;

    const tName = q.topic || 'General';
    if (!topicMap[tName]) {
      topicMap[tName] = { marks: 0, count: 0 };
    }
    topicMap[tName].marks += m;
    topicMap[tName].count += 1;
  }

  const safeTotal = totalMarks > 0 ? totalMarks : 1;

  const topicStats = Object.entries(topicMap).map(([topic, data]) => ({
    topic,
    marks: data.marks,
    questionCount: data.count,
    percent: Math.round((data.marks / safeTotal) * 100),
  })).sort((a, b) => b.marks - a.marks);

  return {
    questions,
    totalMarks,
    targetMarks,
    markDifference: totalMarks - targetMarks,
    estimatedDuration,
    difficultyStats: {
      easyMarks,
      mediumMarks,
      hardMarks,
      easyPercent: Math.round((easyMarks / safeTotal) * 100),
      mediumPercent: Math.round((mediumMarks / safeTotal) * 100),
      hardPercent: Math.round((hardMarks / safeTotal) * 100),
    },
    topicStats,
    isExactMatch: totalMarks === targetMarks,
    deficitMarks: Math.max(0, targetMarks - totalMarks),
  };
}

function buildEmptyResult(targetMarks: number): AssemblyResult {
  return {
    questions: [],
    totalMarks: 0,
    targetMarks,
    markDifference: -targetMarks,
    estimatedDuration: 0,
    difficultyStats: {
      easyMarks: 0,
      mediumMarks: 0,
      hardMarks: 0,
      easyPercent: 0,
      mediumPercent: 0,
      hardPercent: 0,
    },
    topicStats: [],
    isExactMatch: false,
    deficitMarks: targetMarks,
  };
}

function shuffleArray<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
