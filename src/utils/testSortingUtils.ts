import { normalizeQuestionStyle, type Question, type QuestionDifficulty } from '../types/database';

export type TestSortPreset =
  | 'topic_asc'
  | 'difficulty_asc'
  | 'difficulty_desc'
  | 'topic_difficulty'
  | 'shuffle';

export interface TestSortPresetOption {
  id: TestSortPreset;
  label: string;
  shortLabel: string;
  icon: string;
  description: string;
}

export const TEST_SORT_PRESETS: TestSortPresetOption[] = [
  {
    id: 'topic_asc',
    label: 'Topic (A → Z)',
    shortLabel: 'Topic (A → Z)',
    icon: '📚',
    description: 'Group by Topic & Sub-Topic alphabetically (MCQs first, then Theory)',
  },
  {
    id: 'difficulty_asc',
    label: 'Difficulty (Easy → Hard)',
    shortLabel: 'Difficulty (Easy → Hard)',
    icon: '⚡',
    description: 'Warm-up to challenging within each section (MCQs first, then Theory)',
  },
  {
    id: 'difficulty_desc',
    label: 'Difficulty (Hard → Easy)',
    shortLabel: 'Difficulty (Hard → Easy)',
    icon: '🔥',
    description: 'Challenging to easier within each section (MCQs first, then Theory)',
  },
  {
    id: 'topic_difficulty',
    label: 'Topic + Difficulty',
    shortLabel: 'Topic + Difficulty (Easy → Hard)',
    icon: '🎯',
    description: 'Group by Topic (A → Z), then progress Easy → Hard within each topic',
  },
  {
    id: 'shuffle',
    label: 'Shuffle / Randomize',
    shortLabel: 'Randomized Order',
    icon: '🎲',
    description: 'Randomize question sequence within MCQ and Theory sections',
  },
];

const DIFFICULTY_ASC_WEIGHT: Record<QuestionDifficulty, number> = {
  Easy: 1,
  Medium: 2,
  Hard: 3,
};

const DIFFICULTY_DESC_WEIGHT: Record<QuestionDifficulty, number> = {
  Hard: 1,
  Medium: 2,
  Easy: 3,
};

/**
 * Determines whether a question belongs to Section A (Multiple Choice / Objective)
 * or Section B (Theory / Structured / Essay / Calculation / Short Answer).
 */
export function isMcqQuestion(q: Question): boolean {
  const normalized = normalizeQuestionStyle(q.question_style, q.options);
  return normalized === 'Multiple Choice' || normalized === 'Multiple Select';
}

/**
 * Returns 0 for MCQs (Section A) and 1 for Theory/Structured/Essay questions (Section B),
 * ensuring MCQs always stay at the front of mixed papers and never intermingle with essays.
 */
export function getQuestionSectionRank(q: Question): number {
  return isMcqQuestion(q) ? 0 : 1;
}

export function getDifficultyWeightAsc(difficulty?: QuestionDifficulty | string | null): number {
  if (!difficulty) return 4;
  return DIFFICULTY_ASC_WEIGHT[difficulty as QuestionDifficulty] ?? 4;
}

export function getDifficultyWeightDesc(difficulty?: QuestionDifficulty | string | null): number {
  if (!difficulty) return 4;
  return DIFFICULTY_DESC_WEIGHT[difficulty as QuestionDifficulty] ?? 4;
}

function compareTopics(a: Question, b: Question): number {
  const topicA = (a.topic || '').trim();
  const topicB = (b.topic || '').trim();
  if (!topicA && !topicB) return 0;
  if (!topicA) return 1;
  if (!topicB) return -1;
  return topicA.localeCompare(topicB, undefined, { numeric: true, sensitivity: 'base' });
}

function compareSubTopics(a: Question, b: Question): number {
  const subA = (a.sub_topic || '').trim();
  const subB = (b.sub_topic || '').trim();
  if (!subA && !subB) return 0;
  if (!subA) return 1;
  if (!subB) return -1;
  return subA.localeCompare(subB, undefined, { numeric: true, sensitivity: 'base' });
}

function fisherYatesShuffle<T>(items: T[], rng: () => number = Math.random): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const temp = copy[i];
    copy[i] = copy[j];
    copy[j] = temp;
  }
  return copy;
}

/**
 * Sorts an array of Test Builder questions according to the selected preset while:
 * 1. Always preserving MCQ First (Section A) vs. Theory/Essay Second (Section B) boundaries.
 * 2. Applying natural tie-breakers and preserving original relative order on exact ties.
 */
export function sortTestBuilderQuestions(
  questions: Question[],
  preset: TestSortPreset,
  rng: () => number = Math.random
): Question[] {
  if (!Array.isArray(questions) || questions.length <= 1) {
    return Array.isArray(questions) ? [...questions] : [];
  }

  if (preset === 'shuffle') {
    const mcqs = questions.filter((q) => getQuestionSectionRank(q) === 0);
    const essays = questions.filter((q) => getQuestionSectionRank(q) === 1);
    return [...fisherYatesShuffle(mcqs, rng), ...fisherYatesShuffle(essays, rng)];
  }

  // Decorate with original index to guarantee deterministic stable tie-breaking
  const indexed = questions.map((q, originalIndex) => ({ q, originalIndex }));

  indexed.sort((itemA, itemB) => {
    const a = itemA.q;
    const b = itemB.q;

    // 1. Always respect MCQ (0) vs Theory/Essay (1) section boundary
    const sectionDiff = getQuestionSectionRank(a) - getQuestionSectionRank(b);
    if (sectionDiff !== 0) return sectionDiff;

    if (preset === 'topic_asc') {
      // Topic (A → Z) -> Sub-Topic (A → Z) -> Difficulty (Easy → Hard) -> Original Order
      const topicDiff = compareTopics(a, b);
      if (topicDiff !== 0) return topicDiff;

      const subTopicDiff = compareSubTopics(a, b);
      if (subTopicDiff !== 0) return subTopicDiff;

      const diffWeight = getDifficultyWeightAsc(a.difficulty) - getDifficultyWeightAsc(b.difficulty);
      if (diffWeight !== 0) return diffWeight;

      return itemA.originalIndex - itemB.originalIndex;
    }

    if (preset === 'difficulty_asc') {
      // Difficulty (Easy → Hard) -> Original Order
      const diffWeight = getDifficultyWeightAsc(a.difficulty) - getDifficultyWeightAsc(b.difficulty);
      if (diffWeight !== 0) return diffWeight;

      return itemA.originalIndex - itemB.originalIndex;
    }

    if (preset === 'difficulty_desc') {
      // Difficulty (Hard → Easy) -> Original Order
      const diffWeight = getDifficultyWeightDesc(a.difficulty) - getDifficultyWeightDesc(b.difficulty);
      if (diffWeight !== 0) return diffWeight;

      return itemA.originalIndex - itemB.originalIndex;
    }

    if (preset === 'topic_difficulty') {
      // Topic (A → Z) -> Difficulty (Easy → Hard) -> Sub-Topic (A → Z) -> Original Order
      const topicDiff = compareTopics(a, b);
      if (topicDiff !== 0) return topicDiff;

      const diffWeight = getDifficultyWeightAsc(a.difficulty) - getDifficultyWeightAsc(b.difficulty);
      if (diffWeight !== 0) return diffWeight;

      const subTopicDiff = compareSubTopics(a, b);
      if (subTopicDiff !== 0) return subTopicDiff;

      return itemA.originalIndex - itemB.originalIndex;
    }

    return itemA.originalIndex - itemB.originalIndex;
  });

  return indexed.map((item) => item.q);
}

export function getSortPresetMeta(preset: TestSortPreset): TestSortPresetOption {
  return (
    TEST_SORT_PRESETS.find((p) => p.id === preset) || {
      id: preset,
      label: preset,
      shortLabel: preset,
      icon: '⇅',
      description: '',
    }
  );
}

