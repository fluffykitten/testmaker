/**
 * Topic Mastery Tiers & Diagnostic Calculation Utilities
 * Pure types, defaults, validation, normalization, and per-submission topic breakdown aggregation.
 */

export type MasteryTierColor = 'emerald' | 'blue' | 'amber' | 'crimson';

export interface TopicMasteryTier {
  id: string;
  minPercentage: number;
  label: string;
  color: MasteryTierColor;
  recommendation?: string;
}

export interface TopicMasteryQuestionInput {
  questionNumber?: number;
  topic?: string;
  maxMarks: number;
  earnedMarks: number;
  isCorrect?: boolean;
  subQuestionResults?: Array<{
    earnedMarks: number;
    maxMarks: number;
  }>;
}

export interface TopicMasterySubmissionInput {
  questionResults?: TopicMasteryQuestionInput[];
  topicBreakdown?: Record<string, { totalMarks: number; earnedMarks: number; percentage: number }>;
}

export interface TopicMasteryEntry {
  topic: string;
  earnedMarks: number;
  totalMarks: number;
  percentage: number;
  questionCount: number;
  correctCount: number;
  questionNumbers: string[];
  tier: TopicMasteryTier;
}

export const DEFAULT_TOPIC_MASTERY_TIERS: TopicMasteryTier[] = [
  {
    id: 'mastery_mastered',
    minPercentage: 75,
    label: 'Mastered',
    color: 'emerald',
    recommendation: 'Strong command demonstrated. Ready for extension and synthesis tasks.',
  },
  {
    id: 'mastery_developing',
    minPercentage: 50,
    label: 'Developing',
    color: 'blue',
    recommendation: 'Partial grasp of core concepts. Target structured practice on missed items.',
  },
  {
    id: 'mastery_needs_support',
    minPercentage: 0,
    label: 'Needs Support',
    color: 'crimson',
    recommendation: 'Priority intervention required. Revisit foundational principles and worked examples.',
  },
];

const VALID_COLORS = new Set<MasteryTierColor>(['emerald', 'blue', 'amber', 'crimson']);

function cloneDefaultTiers(): TopicMasteryTier[] {
  return DEFAULT_TOPIC_MASTERY_TIERS.map((tier) => ({ ...tier }));
}

function clampPercentage(raw: unknown, fallback = 0): number {
  const num = Number(raw);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(100, Math.round(num * 10) / 10));
}

/**
 * Normalizes raw topic mastery tiers config (JSON string or array), sorts descending
 * by minPercentage, deduplicates thresholds, and ensures a 0% baseline tier exists.
 */
export function normalizeTopicMasteryTiers(raw: unknown): TopicMasteryTier[] {
  let list: unknown[] = [];

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = [];
    }
  } else if (Array.isArray(raw)) {
    list = raw;
  }

  if (list.length === 0) {
    return cloneDefaultTiers();
  }

  const sanitized: TopicMasteryTier[] = [];
  const seenPercentages = new Set<number>();

  for (let i = 0; i < list.length; i++) {
    const item = list[i] as Partial<TopicMasteryTier> | null | undefined;
    if (!item || typeof item !== 'object') continue;

    const minPct = clampPercentage(item.minPercentage, 0);
    if (seenPercentages.has(minPct)) continue;
    seenPercentages.add(minPct);

    const label = typeof item.label === 'string' && item.label.trim()
      ? item.label.trim()
      : `Tier ${i + 1}`;
    const color: MasteryTierColor = VALID_COLORS.has(item.color as MasteryTierColor)
      ? (item.color as MasteryTierColor)
      : minPct >= 75
        ? 'emerald'
        : minPct >= 50
          ? 'blue'
          : 'crimson';

    sanitized.push({
      id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `mastery_${i + 1}`,
      minPercentage: minPct,
      label,
      color,
      recommendation: typeof item.recommendation === 'string' ? item.recommendation.trim() : undefined,
    });
  }

  if (sanitized.length === 0) {
    return cloneDefaultTiers();
  }

  sanitized.sort((a, b) => b.minPercentage - a.minPercentage);

  // Guarantee a 0% catch-all baseline tier exists
  const lowest = sanitized[sanitized.length - 1];
  if (lowest.minPercentage > 0) {
    lowest.minPercentage = 0;
  }

  return sanitized;
}

/**
 * Validates editable topic mastery tier list in Admin Settings UI before saving.
 */
export function validateTopicMasteryTiers(tiers: TopicMasteryTier[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!Array.isArray(tiers) || tiers.length === 0) {
    return { ok: false, errors: ['At least one topic mastery tier is required.'] };
  }

  const seenMin = new Set<number>();
  let hasZeroFloor = false;

  tiers.forEach((tier, idx) => {
    if (!tier.label || !tier.label.trim()) {
      errors.push(`Tier #${idx + 1} must have a non-empty label.`);
    }
    if (!Number.isFinite(tier.minPercentage) || tier.minPercentage < 0 || tier.minPercentage > 100) {
      errors.push(`Tier "${tier.label || `#${idx + 1}`}" minimum percentage must be between 0 and 100.`);
    }
    const rounded = Math.round(Number(tier.minPercentage) * 10) / 10;
    if (seenMin.has(rounded)) {
      errors.push(`Duplicate threshold ${rounded}% detected. Each tier requires a unique minimum percentage.`);
    }
    seenMin.add(rounded);
    if (rounded === 0) hasZeroFloor = true;
  });

  if (!hasZeroFloor) {
    errors.push('One baseline tier must start at 0% so every score falls into a valid mastery band.');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Resolves the matching Mastery Tier for a percentage value using descending threshold matching.
 */
export function resolveMasteryTier(
  tiers: TopicMasteryTier[] | undefined,
  percentage: number
): TopicMasteryTier {
  const activeTiers = normalizeTopicMasteryTiers(tiers);
  const pct = Number.isFinite(percentage) ? percentage : 0;

  for (const tier of activeTiers) {
    if (pct >= tier.minPercentage) {
      return tier;
    }
  }
  return activeTiers[activeTiers.length - 1];
}

/**
 * Normalizes topic names across question items and legacy summaries.
 */
export function normalizeTopicLabel(rawTopic?: string): string {
  const cleaned = (rawTopic || '').replace(/\s+/g, ' ').trim();
  return cleaned || 'General';
}

function roundMarks(val: number): number {
  return Math.round((Number.isFinite(val) ? val : 0) * 100) / 100;
}

/**
 * Computes normalized per-topic mastery diagnostics for an individual student submission.
 * Derives directly from questionResults (tracking Question #s and merging case-variants)
 * and falls back to submission.topicBreakdown when questionResults is unavailable.
 */
export function computeSubmissionTopicMastery(
  submission: TopicMasterySubmissionInput,
  tiers?: TopicMasteryTier[]
): TopicMasteryEntry[] {
  const activeTiers = normalizeTopicMasteryTiers(tiers);
  const grouped = new Map<
    string,
    {
      topic: string;
      earnedMarks: number;
      totalMarks: number;
      questionCount: number;
      correctCount: number;
      questionNumbers: string[];
    }
  >();

  const qResults = Array.isArray(submission.questionResults) ? submission.questionResults : [];

  if (qResults.length > 0) {
    qResults.forEach((qr, idx) => {
      const displayTopic = normalizeTopicLabel(qr.topic);
      const key = displayTopic.toLowerCase();
      const qLabel = `Q${qr.questionNumber || idx + 1}`;

      let earned = Number(qr.earnedMarks) || 0;
      let max = Number(qr.maxMarks) || 0;
      if (Array.isArray(qr.subQuestionResults) && qr.subQuestionResults.length > 0 && max <= 0) {
        earned = qr.subQuestionResults.reduce((acc, s) => acc + (Number(s.earnedMarks) || 0), 0);
        max = qr.subQuestionResults.reduce((acc, s) => acc + (Number(s.maxMarks) || 0), 0);
      }

      const existing = grouped.get(key) || {
        topic: displayTopic,
        earnedMarks: 0,
        totalMarks: 0,
        questionCount: 0,
        correctCount: 0,
        questionNumbers: [],
      };

      existing.earnedMarks += earned;
      existing.totalMarks += max;
      existing.questionCount += 1;
      if (qr.isCorrect || (max > 0 && earned >= max)) {
        existing.correctCount += 1;
      }
      if (!existing.questionNumbers.includes(qLabel)) {
        existing.questionNumbers.push(qLabel);
      }
      grouped.set(key, existing);
    });
  } else if (submission.topicBreakdown && typeof submission.topicBreakdown === 'object') {
    Object.entries(submission.topicBreakdown).forEach(([rawTopic, stats]) => {
      if (!stats || typeof stats !== 'object') return;
      const displayTopic = normalizeTopicLabel(rawTopic);
      const key = displayTopic.toLowerCase();
      const existing = grouped.get(key) || {
        topic: displayTopic,
        earnedMarks: 0,
        totalMarks: 0,
        questionCount: 0,
        correctCount: 0,
        questionNumbers: [],
      };
      existing.earnedMarks += Number(stats.earnedMarks) || 0;
      existing.totalMarks += Number(stats.totalMarks) || 0;
      grouped.set(key, existing);
    });
  }

  return Array.from(grouped.values())
    .map((item) => {
      const earnedMarks = roundMarks(item.earnedMarks);
      const totalMarks = roundMarks(item.totalMarks);
      const percentage = totalMarks > 0
        ? Math.round((earnedMarks / totalMarks) * 1000) / 10
        : 0;
      return {
        topic: item.topic,
        earnedMarks,
        totalMarks,
        percentage,
        questionCount: item.questionCount,
        correctCount: item.correctCount,
        questionNumbers: item.questionNumbers,
        tier: resolveMasteryTier(activeTiers, percentage),
      };
    })
    .sort((a, b) => {
      if (b.percentage !== a.percentage) return b.percentage - a.percentage;
      return a.topic.localeCompare(b.topic);
    });
}
