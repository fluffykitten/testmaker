/**
 * Multi-Tier Exam Security Violation & Penalty System
 * Pure types, defaults, validation, normalization, and penalty calculations.
 */

export type SecurityTierAction = 'warning' | 'time_penalty' | 'auto_submit';

export interface SecurityViolationTier {
  id: string;
  strikeCount: number;
  name: string;
  action: SecurityTierAction;
  penaltyMinutes?: number;
  studentNotice?: string;
}

export interface SecurityTierEvent {
  strike: number;
  tierId: string;
  tierName: string;
  action: SecurityTierAction;
  penaltyMinutes: number;
  deductedSeconds: number;
  timestamp: string;
  violationDetail: string;
}

export const STRIKE_COALESCE_MS = 2000;
export const PENALTY_GRACE_SECONDS = 30;

export const DEFAULT_SECURITY_TIERS: SecurityViolationTier[] = [
  {
    id: 'tier_1',
    strikeCount: 1,
    name: 'Early Warning',
    action: 'warning',
    penaltyMinutes: 0,
    studentNotice: 'First strike. Please remain focused on your exam.',
  },
  {
    id: 'tier_2',
    strikeCount: 2,
    name: 'Warning with Penalty',
    action: 'time_penalty',
    penaltyMinutes: 5,
    studentNotice: 'Second strike. 5 minutes have been deducted from your exam time.',
  },
  {
    id: 'tier_3',
    strikeCount: 3,
    name: 'Severe Warning with Penalty',
    action: 'time_penalty',
    penaltyMinutes: 10,
    studentNotice: 'Third strike. An additional 10 minutes have been deducted.',
  },
  {
    id: 'tier_4',
    strikeCount: 4,
    name: 'Final Warning (Auto Submit)',
    action: 'auto_submit',
    penaltyMinutes: 0,
    studentNotice: 'Maximum strikes reached. Your exam has been locked and automatically submitted.',
  },
];

/**
 * Normalizes any raw tiers configuration, ensuring valid structure,
 * sorting ascending by strikeCount, and guaranteeing final tier is auto_submit.
 */
export function normalizeSecurityTiers(raw: unknown): SecurityViolationTier[] {
  let list: any[] = [];

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
    return JSON.parse(JSON.stringify(DEFAULT_SECURITY_TIERS));
  }

  const normalized: SecurityViolationTier[] = list.map((item, idx) => {
    const rawAction = String(item?.action || '').trim().toLowerCase();
    const action: SecurityTierAction =
      rawAction === 'time_penalty' || rawAction === 'auto_submit' ? rawAction : 'warning';

    const strikeCount = Math.max(1, Math.round(Number(item?.strikeCount) || idx + 1));
    const penaltyMinutes =
      action === 'time_penalty' ? Math.max(1, Math.min(120, Math.round(Number(item?.penaltyMinutes) || 5))) : 0;

    return {
      id: String(item?.id || `tier_${idx + 1}`),
      strikeCount,
      name: String(item?.name || `Tier ${idx + 1}`).trim() || `Tier ${idx + 1}`,
      action,
      penaltyMinutes,
      studentNotice: typeof item?.studentNotice === 'string' ? item.studentNotice.trim() : undefined,
    };
  });

  // Sort ascending by strike count
  normalized.sort((a, b) => a.strikeCount - b.strikeCount);

  // Guarantee final tier is auto_submit
  const lastIndex = normalized.length - 1;
  if (normalized[lastIndex].action !== 'auto_submit') {
    normalized[lastIndex].action = 'auto_submit';
    normalized[lastIndex].penaltyMinutes = 0;
    if (!normalized[lastIndex].name || normalized[lastIndex].name.toLowerCase().includes('warning')) {
      normalized[lastIndex].name = 'Final Warning (Auto Submit)';
    }
  }

  return normalized;
}

/**
 * Validates a candidate tiers array against business rules.
 */
export function validateSecurityTiers(tiers: SecurityViolationTier[]): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!Array.isArray(tiers) || tiers.length === 0) {
    errors.push('At least one security escalation tier is required.');
    return { ok: false, errors };
  }

  if (tiers.length > 10) {
    errors.push('A maximum of 10 security escalation tiers is allowed.');
  }

  let prevStrike = 0;
  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i];
    const rowNum = i + 1;

    if (!tier.name || !tier.name.trim()) {
      errors.push(`Tier ${rowNum}: Name is required.`);
    }

    if (!Number.isInteger(tier.strikeCount) || tier.strikeCount < 1) {
      errors.push(`Tier ${rowNum}: Strike count must be an integer greater than or equal to 1.`);
    } else if (tier.strikeCount <= prevStrike) {
      errors.push(`Tier ${rowNum}: Strike count (${tier.strikeCount}) must be strictly greater than Tier ${rowNum - 1} (${prevStrike}).`);
    }
    prevStrike = tier.strikeCount;

    if (tier.action === 'time_penalty') {
      const p = tier.penaltyMinutes ?? 0;
      if (!Number.isInteger(p) || p < 1 || p > 120) {
        errors.push(`Tier ${rowNum}: Time penalty must be an integer between 1 and 120 minutes.`);
      }
    }
  }

  const lastTier = tiers[tiers.length - 1];
  if (lastTier && lastTier.action !== 'auto_submit') {
    errors.push(`The final escalation tier (Strike ${lastTier.strikeCount}) must have action "Final Warning (Auto Submit)".`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Resolves the appropriate tier for a given strike count.
 * Uses highest matching tier <= strikeCount, clamping to the final tier for counts above.
 * Returns null if strikeCount is below the first tier threshold.
 */
export function resolveTierForStrike(
  tiers: SecurityViolationTier[],
  strikeCount: number
): SecurityViolationTier | null {
  if (!tiers || tiers.length === 0 || strikeCount <= 0) return null;

  const sorted = [...tiers].sort((a, b) => a.strikeCount - b.strikeCount);

  if (strikeCount < sorted[0].strikeCount) {
    return null;
  }

  let matched: SecurityViolationTier = sorted[0];
  for (const tier of sorted) {
    if (strikeCount >= tier.strikeCount) {
      matched = tier;
    } else {
      break;
    }
  }

  return matched;
}

/**
 * Determines whether a violation event should count as a new strike:
 * - Rule R1: Never count strikes while the exam is already locked.
 * - Rule R2: Coalesce rapid violation bursts within coalesceMs (default 2s).
 */
export function shouldCountAsStrike(args: {
  isLocked: boolean;
  nowMs: number;
  lastStrikeAtMs: number | null;
  coalesceMs?: number;
}): boolean {
  if (args.isLocked) {
    return false;
  }

  const coalesce = args.coalesceMs ?? STRIKE_COALESCE_MS;
  if (args.lastStrikeAtMs !== null && args.nowMs - args.lastStrikeAtMs < coalesce) {
    return false;
  }

  return true;
}

/**
 * Immediately deducts penalty minutes from targetEndTime, clamping at nowMs.
 */
export function applyTimePenalty(args: {
  targetEndTime: number;
  nowMs: number;
  penaltyMinutes: number;
}): {
  targetEndTime: number;
  remainingSeconds: number;
  deductedSeconds: number;
  exhausted: boolean;
} {
  const penaltyMs = Math.max(0, args.penaltyMinutes) * 60 * 1000;
  const oldRemainingMs = Math.max(0, args.targetEndTime - args.nowMs);
  const newTargetEndTime = Math.max(args.nowMs, args.targetEndTime - penaltyMs);
  const newRemainingMs = Math.max(0, newTargetEndTime - args.nowMs);
  const deductedMs = oldRemainingMs - newRemainingMs;

  return {
    targetEndTime: newTargetEndTime,
    remainingSeconds: Math.round(newRemainingMs / 1000),
    deductedSeconds: Math.round(deductedMs / 1000),
    exhausted: newRemainingMs <= 0,
  };
}

/**
 * Resolves remaining time when teacher unlocks the exam:
 * If the penalty completely exhausted candidate time (<= 0), grants a 30s grace period.
 */
export function resolveUnlockClock(args: {
  targetEndTime: number;
  nowMs: number;
  graceSeconds?: number;
}): {
  targetEndTime: number;
  remainingSeconds: number;
  graceApplied: boolean;
} {
  const grace = args.graceSeconds ?? PENALTY_GRACE_SECONDS;

  if (args.targetEndTime <= args.nowMs) {
    const newTarget = args.nowMs + grace * 1000;
    return {
      targetEndTime: newTarget,
      remainingSeconds: grace,
      graceApplied: true,
    };
  }

  const remaining = Math.max(1, Math.round((args.targetEndTime - args.nowMs) / 1000));
  return {
    targetEndTime: args.targetEndTime,
    remainingSeconds: remaining,
    graceApplied: false,
  };
}

export interface LockScreenStepItem {
  strike: number;
  shortLabel: string;
  status: 'completed' | 'active' | 'upcoming';
  action: SecurityTierAction;
}

export interface LockScreenPresentation {
  variant: 'warning' | 'time_penalty' | 'final';
  icon: '⚠️' | '🚨' | '🛑';
  title: string;
  cleanViolationEvent: string;
  steps: LockScreenStepItem[];
  strikesRemaining: number;
  finalStrikeCount: number;
}

/**
 * Cleans the raw violation/lock reason to a concise 1-line event summary,
 * stripping leading [Tier Name] tags and trailing PIN/submission boilerplate.
 */
export function cleanViolationEventText(raw: string | undefined): string {
  if (!raw) return 'Exam window lost focus / Alt+Tab';
  let cleaned = raw.trim();

  // Strip leading bracketed prefix like "[Early Warning]", "[Warning with Penalty]", "🚨 [Tier 2]"
  cleaned = cleaned.replace(/^(?:🚨\s*)?\[[^\]]+\]\s*/u, '');

  // Strip trailing instructions like ". Invigilator PIN required..." or ". Penalty: -5 min..."
  cleaned = cleaned.replace(/\.?\s*(?:Invigilator PIN required.*|Penalty:.*|Assessment automatically locked.*)$/i, '');

  // Clean trailing period
  cleaned = cleaned.trim().replace(/\.$/, '');

  return cleaned || 'Exam window lost focus / Alt+Tab';
}

/**
 * Derives presentation metadata for the tiered exam lock screen:
 * variant, icon, title, bounded stepper items, and remaining strikes.
 */
export function resolveLockScreenPresentation(args: {
  tiers?: SecurityViolationTier[];
  strikeCount: number;
  activeTier?: SecurityViolationTier | null;
  isFinalLock: boolean;
  rawLockReason?: string;
}): LockScreenPresentation {
  const normalized = normalizeSecurityTiers(args.tiers);
  const currentStrike = Math.max(1, args.strikeCount);
  const lastTier = normalized[normalized.length - 1];
  const finalStrikeCount = lastTier ? lastTier.strikeCount : 4;
  const isFinal = args.isFinalLock || args.activeTier?.action === 'auto_submit' || currentStrike >= finalStrikeCount;

  let variant: 'warning' | 'time_penalty' | 'final' = 'warning';
  let icon: '⚠️' | '🚨' | '🛑' = '⚠️';
  let title = 'EXAMINATION PAUSED (FIRST WARNING)';

  if (isFinal) {
    variant = 'final';
    icon = '🛑';
    title = 'EXAMINATION TERMINATED (STRIKE LIMIT REACHED)';
  } else if (args.activeTier?.action === 'time_penalty') {
    variant = 'time_penalty';
    icon = '🚨';
    title = 'EXAMINATION LOCKED (TIME PENALTY)';
  }

  const steps: LockScreenStepItem[] = normalized.map((tier) => {
    let status: 'completed' | 'active' | 'upcoming' = 'upcoming';

    if (tier.strikeCount < currentStrike) {
      status = 'completed';
    } else if (tier.strikeCount === currentStrike || (isFinal && tier.action === 'auto_submit')) {
      status = 'active';
    } else {
      status = 'upcoming';
    }

    let shortLabel = 'Warning';
    if (tier.action === 'time_penalty') {
      shortLabel = `-${tier.penaltyMinutes || 5}m`;
    } else if (tier.action === 'auto_submit') {
      shortLabel = 'Auto-Submit';
    }

    return {
      strike: tier.strikeCount,
      shortLabel,
      status,
      action: tier.action,
    };
  });

  const strikesRemaining = isFinal ? 0 : Math.max(0, finalStrikeCount - currentStrike);

  return {
    variant,
    icon,
    title,
    cleanViolationEvent: cleanViolationEventText(args.rawLockReason),
    steps,
    strikesRemaining,
    finalStrikeCount,
  };
}


