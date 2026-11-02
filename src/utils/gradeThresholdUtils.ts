export interface GradeThresholds {
  aStar: number;
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
}

export type GradeLetter = 'A*' | 'A' | 'B' | 'C' | 'D' | 'E' | 'U';

export interface GradeTierDetail {
  grade: GradeLetter;
  color: string;
  gradient: string;
  borderColor: string;
  textColor: string;
  tierName: string;
}

export interface GradePreset {
  id: string;
  name: string;
  description: string;
  thresholds: GradeThresholds;
}

export const DEFAULT_GRADE_THRESHOLDS: Readonly<GradeThresholds> = Object.freeze({
  aStar: 90,
  a: 80,
  b: 70,
  c: 60,
  d: 50,
  e: 40,
});

export const GRADE_PRESETS: GradePreset[] = [
  {
    id: 'cambridge-standard',
    name: 'Cambridge Standard',
    description: 'Traditional standard boundary curve (90/80/70/60/50/40)',
    thresholds: { aStar: 90, a: 80, b: 70, c: 60, d: 50, e: 40 },
  },
  {
    id: 'lenient-curve',
    name: 'Lenient Curve',
    description: 'Curved boundaries for high-difficulty assessments (80/70/60/50/40/30)',
    thresholds: { aStar: 80, a: 70, b: 60, c: 50, d: 40, e: 30 },
  },
  {
    id: 'challenging-paper',
    name: 'Challenging Paper',
    description: 'Strict Cambridge component curve (70/60/50/40/30/20)',
    thresholds: { aStar: 70, a: 60, b: 50, c: 40, d: 30, e: 20 },
  },
];

export const GRADE_VISUALS: Record<GradeLetter, Omit<GradeTierDetail, 'grade'>> = {
  'A*': {
    color: '#d97706',
    gradient: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
    borderColor: '#fbbf24',
    textColor: '#ffffff',
    tierName: 'Legendary Gold',
  },
  'A': {
    color: '#059669',
    gradient: 'linear-gradient(135deg, #10b981 0%, #047857 100%)',
    borderColor: '#34d399',
    textColor: '#ffffff',
    tierName: 'Epic Emerald',
  },
  'B': {
    color: '#2563eb',
    gradient: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
    borderColor: '#60a5fa',
    textColor: '#ffffff',
    tierName: 'Rare Sapphire',
  },
  'C': {
    color: '#7c3aed',
    gradient: 'linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%)',
    borderColor: '#a78bfa',
    textColor: '#ffffff',
    tierName: 'Uncommon Amethyst',
  },
  'D': {
    color: '#ea580c',
    gradient: 'linear-gradient(135deg, #f97316 0%, #c2410c 100%)',
    borderColor: '#fb923c',
    textColor: '#ffffff',
    tierName: 'Bronze',
  },
  'E': {
    color: '#dc2626',
    gradient: 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)',
    borderColor: '#f87171',
    textColor: '#ffffff',
    tierName: 'Ruby Coral',
  },
  'U': {
    color: '#475569',
    gradient: 'linear-gradient(135deg, #64748b 0%, #475569 100%)',
    borderColor: '#94a3b8',
    textColor: '#ffffff',
    tierName: 'Shadow Slate',
  },
};

/**
 * Validates that grade thresholds descend strictly: 100 >= A* > A > B > C > D > E > 0.
 */
export function validateGradeThresholds(thresholds?: Partial<GradeThresholds> | null): {
  isValid: boolean;
  error?: string;
} {
  if (!thresholds) {
    return { isValid: true };
  }

  const { aStar, a, b, c, d, e } = thresholds;

  const values = [
    { label: 'A*', val: aStar },
    { label: 'A', val: a },
    { label: 'B', val: b },
    { label: 'C', val: c },
    { label: 'D', val: d },
    { label: 'E', val: e },
  ];

  for (const item of values) {
    if (typeof item.val !== 'number' || Number.isNaN(item.val)) {
      return { isValid: false, error: `${item.label} threshold must be a valid number.` };
    }
    if (item.val <= 0 || item.val > 100) {
      return { isValid: false, error: `${item.label} threshold must be between 1% and 100%.` };
    }
  }

  const nums = values.map((v) => v.val as number);
  for (let i = 0; i < nums.length - 1; i++) {
    if (nums[i] <= nums[i + 1]) {
      return {
        isValid: false,
        error: `${values[i].label} (${nums[i]}%) must be strictly greater than ${values[i + 1].label} (${nums[i + 1]}%).`,
      };
    }
  }

  return { isValid: true };
}

/**
 * Ensures threshold values are properly formed, falling back to defaults for any missing key.
 */
export function sanitizeGradeThresholds(thresholds?: Partial<GradeThresholds> | null): GradeThresholds {
  if (!thresholds) return { ...DEFAULT_GRADE_THRESHOLDS };

  const sanitized: GradeThresholds = {
    aStar: typeof thresholds.aStar === 'number' && !Number.isNaN(thresholds.aStar) ? thresholds.aStar : DEFAULT_GRADE_THRESHOLDS.aStar,
    a: typeof thresholds.a === 'number' && !Number.isNaN(thresholds.a) ? thresholds.a : DEFAULT_GRADE_THRESHOLDS.a,
    b: typeof thresholds.b === 'number' && !Number.isNaN(thresholds.b) ? thresholds.b : DEFAULT_GRADE_THRESHOLDS.b,
    c: typeof thresholds.c === 'number' && !Number.isNaN(thresholds.c) ? thresholds.c : DEFAULT_GRADE_THRESHOLDS.c,
    d: typeof thresholds.d === 'number' && !Number.isNaN(thresholds.d) ? thresholds.d : DEFAULT_GRADE_THRESHOLDS.d,
    e: typeof thresholds.e === 'number' && !Number.isNaN(thresholds.e) ? thresholds.e : DEFAULT_GRADE_THRESHOLDS.e,
  };

  const validation = validateGradeThresholds(sanitized);
  return validation.isValid ? sanitized : { ...DEFAULT_GRADE_THRESHOLDS };
}

/**
 * Derives grade letter and styling for a given percentage based on provided or default thresholds.
 */
export function deriveGradeFromPercentage(
  percentage: number,
  thresholds?: Partial<GradeThresholds> | null
): GradeTierDetail {
  const t = sanitizeGradeThresholds(thresholds);
  const rounded = Math.round(percentage * 10) / 10;

  let grade: GradeLetter = 'U';
  if (rounded >= t.aStar) {
    grade = 'A*';
  } else if (rounded >= t.a) {
    grade = 'A';
  } else if (rounded >= t.b) {
    grade = 'B';
  } else if (rounded >= t.c) {
    grade = 'C';
  } else if (rounded >= t.d) {
    grade = 'D';
  } else if (rounded >= t.e) {
    grade = 'E';
  }

  return {
    grade,
    ...GRADE_VISUALS[grade],
  };
}

/**
 * Computes the minimum raw marks required to reach a percentage threshold.
 */
export function calculateRawMarkCutoff(percentage: number, totalMarks: number): number {
  if (!totalMarks || totalMarks <= 0) return 0;
  return Math.round((percentage / 100) * totalMarks);
}

