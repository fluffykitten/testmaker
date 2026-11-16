/**
 * IELTS Band (0.0–9.0) and CEFR (A1–C2) proficiency scoring utilities (pure).
 *
 * Implements the conversion rubrics matching the ICM CEFR / Mini-IELTS assessment spec:
 * - Listening raw -> IELTS Band (4.0–9.0 table + proportional scaling for mini-tests)
 * - Reading raw -> IELTS Band (4.0–9.0 table + proportional scaling for mini-tests)
 * - Writing score (4 equal criteria: Task Achievement, Coherence & Cohesion, Lexical Resource, Grammatical Range)
 * - Half-band rounding (0.25 -> 0.5, 0.75 -> next whole band)
 * - CEFR mapping (C2 8.5–9.0, C1 7.0–8.0, B2 5.5–6.5, B1 4.0–5.0, A2 3.0–3.5, A1 1.0–2.5)
 */

export type CefrCode = 'C2' | 'C1' | 'B2' | 'B1' | 'A2' | 'A1' | 'Pre-A1';

export interface CefrDescriptor {
  code: CefrCode;
  label: string;
  indonesianLabel: string;
  bandRange: string;
  color: string;
}

export interface SkillBandScore {
  skill: 'Listening' | 'Reading' | 'Writing' | 'Speaking';
  earnedMarks: number;
  maxMarks: number;
  scaledOutOf40?: number;
  band: number;
}

export interface IeltsCefrProfile {
  skills: SkillBandScore[];
  unroundedAverage: number;
  overallBand: number;
  cefr: CefrDescriptor;
  isPartialAssessment: boolean;
}

const LISTENING_BAND_TABLE: Array<[number, number]> = [
  [39, 9.0],
  [37, 8.5],
  [35, 8.0],
  [32, 7.5],
  [30, 7.0],
  [27, 6.5],
  [23, 6.0],
  [18, 5.5],
  [16, 5.0],
  [13, 4.5],
  [10, 4.0],
  [8, 3.5],
  [6, 3.0],
  [4, 2.5],
  [2, 2.0],
  [1, 1.0],
];

const READING_BAND_TABLE: Array<[number, number]> = [
  [39, 9.0],
  [37, 8.5],
  [35, 8.0],
  [33, 7.5],
  [30, 7.0],
  [27, 6.5],
  [23, 6.0],
  [19, 5.5],
  [15, 5.0],
  [13, 4.5],
  [10, 4.0],
  [8, 3.5],
  [6, 3.0],
  [4, 2.5],
  [2, 2.0],
  [1, 1.0],
];

export function roundIeltsBand(score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  return Math.min(9, Math.max(0, Math.round(score * 2) / 2));
}

function lookupBandFrom40(scaledScore: number, table: Array<[number, number]>): number {
  const clamped = Math.max(0, Math.min(40, Math.round(scaledScore)));
  for (const [minRaw, band] of table) {
    if (clamped >= minRaw) return band;
  }
  return 0;
}

export function listeningMarksToBand(earnedMarks: number, maxMarks: number): { scaledOutOf40: number; band: number } {
  if (maxMarks <= 0 || earnedMarks <= 0) return { scaledOutOf40: 0, band: 0 };
  const scaledOutOf40 = maxMarks === 40 ? Math.round(earnedMarks) : Math.round((earnedMarks / maxMarks) * 40);
  return {
    scaledOutOf40,
    band: lookupBandFrom40(scaledOutOf40, LISTENING_BAND_TABLE),
  };
}

export function readingMarksToBand(earnedMarks: number, maxMarks: number): { scaledOutOf40: number; band: number } {
  if (maxMarks <= 0 || earnedMarks <= 0) return { scaledOutOf40: 0, band: 0 };
  const scaledOutOf40 = maxMarks === 40 ? Math.round(earnedMarks) : Math.round((earnedMarks / maxMarks) * 40);
  return {
    scaledOutOf40,
    band: lookupBandFrom40(scaledOutOf40, READING_BAND_TABLE),
  };
}

export function productiveMarksToBand(earnedMarks: number, maxMarks: number): number {
  if (maxMarks <= 0 || earnedMarks <= 0) return 0;
  const rawBand = (Math.min(earnedMarks, maxMarks) / maxMarks) * 9;
  const rounded = roundIeltsBand(rawBand);
  return earnedMarks > 0 && rounded < 1 ? 1.0 : rounded;
}

export function mapBandToCefr(band: number): CefrDescriptor {
  if (band >= 8.5) {
    return { code: 'C2', label: 'Proficiency', indonesianLabel: 'Mahir', bandRange: '8.5 – 9.0', color: '#059669' };
  }
  if (band >= 7.0) {
    return { code: 'C1', label: 'Advanced', indonesianLabel: 'Lanjutan', bandRange: '7.0 – 8.0', color: '#2563eb' };
  }
  if (band >= 5.5) {
    return { code: 'B2', label: 'Upper Intermediate', indonesianLabel: 'Menengah Atas', bandRange: '5.5 – 6.5', color: '#7c3aed' };
  }
  if (band >= 4.0) {
    return { code: 'B1', label: 'Intermediate', indonesianLabel: 'Menengah', bandRange: '4.0 – 5.0', color: '#d97706' };
  }
  if (band >= 3.0) {
    return { code: 'A2', label: 'Elementary', indonesianLabel: 'Dasar', bandRange: '3.0 – 3.5', color: '#ea580c' };
  }
  if (band >= 1.0) {
    return { code: 'A1', label: 'Beginner', indonesianLabel: 'Pemula', bandRange: '1.0 – 2.5', color: '#dc2626' };
  }
  return { code: 'Pre-A1', label: 'Pre-A1', indonesianLabel: 'Belum Terukur', bandRange: '0.0', color: '#64748b' };
}

export interface MinimalSkillQuestionResult {
  topic?: string;
  earnedMarks?: number;
  maxMarks?: number;
}

export function detectSkillFromTopic(topic?: string): 'Listening' | 'Reading' | 'Writing' | 'Speaking' | null {
  const t = (topic || '').toLowerCase();
  if (!t) return null;
  if (/\blistening\b/.test(t)) return 'Listening';
  if (/\breading\b/.test(t)) return 'Reading';
  if (/\bwriting\b/.test(t)) return 'Writing';
  if (/\bspeaking\b/.test(t)) return 'Speaking';
  return null;
}

/**
 * Aggregates question results by IELTS skill (Listening / Reading / Writing / Speaking),
 * computes skill bands, overall rounded band, and CEFR tier.
 * Returns null unless at least 2 distinct IELTS skill buckets are present.
 */
export function computeIeltsCefrProfile(questionResults?: MinimalSkillQuestionResult[]): IeltsCefrProfile | null {
  if (!Array.isArray(questionResults) || questionResults.length === 0) return null;

  const totals = new Map<'Listening' | 'Reading' | 'Writing' | 'Speaking', { earned: number; max: number }>();

  for (const r of questionResults) {
    const skill = detectSkillFromTopic(r.topic);
    if (!skill) continue;
    const prev = totals.get(skill) || { earned: 0, max: 0 };
    totals.set(skill, {
      earned: prev.earned + (Number(r.earnedMarks) || 0),
      max: prev.max + (Number(r.maxMarks) || 0),
    });
  }

  if (totals.size < 2) return null;

  const order: Array<'Listening' | 'Reading' | 'Writing' | 'Speaking'> = ['Listening', 'Reading', 'Writing', 'Speaking'];
  const skills: SkillBandScore[] = [];

  for (const skill of order) {
    const agg = totals.get(skill);
    if (!agg || agg.max <= 0) continue;
    if (skill === 'Listening') {
      const { scaledOutOf40, band } = listeningMarksToBand(agg.earned, agg.max);
      skills.push({ skill, earnedMarks: agg.earned, maxMarks: agg.max, scaledOutOf40, band });
    } else if (skill === 'Reading') {
      const { scaledOutOf40, band } = readingMarksToBand(agg.earned, agg.max);
      skills.push({ skill, earnedMarks: agg.earned, maxMarks: agg.max, scaledOutOf40, band });
    } else {
      const band = productiveMarksToBand(agg.earned, agg.max);
      skills.push({ skill, earnedMarks: agg.earned, maxMarks: agg.max, band });
    }
  }

  if (skills.length < 2) return null;

  const unroundedAverage = skills.reduce((sum, s) => sum + s.band, 0) / skills.length;
  const overallBand = roundIeltsBand(unroundedAverage);
  const cefr = mapBandToCefr(overallBand);

  return {
    skills,
    unroundedAverage,
    overallBand,
    cefr,
    isPartialAssessment: !totals.has('Speaking') || skills.length < 4,
  };
}
