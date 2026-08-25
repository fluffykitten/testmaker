// ─── Deterministic Fast-Grading Service ─────────────────────────────────────────
// Evaluates exact chemical formulas, numerical calculations, units, single keywords,
// and tick-box classifications without requiring external AI API calls.

import { expandFormulaSearch } from '../lib/formulaSearch';
import type { Question } from '../types/database';

export interface DeterministicGradeResult {
  isHandled: boolean;          // true if evaluation was confidently performed deterministically
  earnedMarks: number;
  maxMarks: number;
  isCorrect: boolean;
  matchType?: 'formula' | 'numeric' | 'keyword' | 'matrix' | 'mcq' | 'unhandled';
  feedback: string;
  matchedCriteria?: string[];
  acceptedAnswers?: string[];
}

// ─── 1. Chemical Formula Normalization & Equivalence ──────────────────────────

const UNICODE_SUBSCRIPT_MAP: Record<string, string> = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
  '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  '⁺': '+', '⁻': '-',
};

/**
 * Normalizes chemical formulas by removing LaTeX formatting, whitespace, state symbols, and converting unicode subscripts
 */
export function normalizeChemicalFormula(input: string): string {
  if (!input) return '';
  let str = input.trim();

  // Remove LaTeX wrappers: \text{...}, \mathrm{...}, \ce{...}, $, \mathbf{...}
  str = str.replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1');
  str = str.replace(/[\$\{\}\\_]/g, '');

  // Convert unicode subscripts
  str = str.split('').map((char) => UNICODE_SUBSCRIPT_MAP[char] || char).join('');

  // Remove standard state symbols at the end or in brackets: (s), (l), (g), (aq), (SOLID), etc.
  str = str.replace(/\((s|l|g|aq|solid|liquid|gas|aqueous)\)/gi, '');

  // Strip spaces and normalize capitalization for formula tokens
  str = str.replace(/\s+/g, '');

  return str;
}

/**
 * Normalizes chemical names for comparison (stripping roman numeral spaces, punctuation)
 */
export function normalizeChemicalName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/iii/g, '3')
    .replace(/ii/g, '2')
    .replace(/iv/g, '4')
    .replace(/vi/g, '6')
    .replace(/v/g, '5')
    .replace(/i/g, '1');
}

/**
 * Checks if a student's answer is chemically equivalent to a target formula or chemical name
 */
export function isChemicalEquivalent(studentAnswer: string, targetAnswer: string): boolean {
  if (!studentAnswer || !targetAnswer) return false;

  const cleanStudent = studentAnswer.trim();
  const cleanTarget = targetAnswer.trim();

  // Direct exact or case-insensitive match
  if (cleanStudent.toLowerCase() === cleanTarget.toLowerCase()) return true;

  // Normalized formula match (e.g. \text{Fe}_2\text{O}_3 vs Fe2O3)
  const normStudentFormula = normalizeChemicalFormula(cleanStudent);
  const normTargetFormula = normalizeChemicalFormula(cleanTarget);
  if (normStudentFormula && normTargetFormula && normStudentFormula.toLowerCase() === normTargetFormula.toLowerCase()) {
    return true;
  }

  // Normalized name match (e.g. Iron(III) oxide vs iron 3 oxide)
  const normStudentName = normalizeChemicalName(cleanStudent);
  const normTargetName = normalizeChemicalName(cleanTarget);
  if (normStudentName && normTargetName && normStudentName === normTargetName) {
    return true;
  }

  // Dictionary synonym lookup via expandFormulaSearch
  const targetExpanded = expandFormulaSearch(cleanTarget);
  const studentExpanded = expandFormulaSearch(cleanStudent);

  const studentNormTokens = studentExpanded.expandedTokens.map((t) => normalizeChemicalFormula(t).toLowerCase());
  const targetNormTokens = targetExpanded.expandedTokens.map((t) => normalizeChemicalFormula(t).toLowerCase());

  if (targetNormTokens.some((t) => studentNormTokens.includes(t) && t.length > 0)) {
    return true;
  }

  return false;
}

// ─── 2. Numerical & Unit Calculation Evaluation ───────────────────────────────

interface ParsedNumeric {
  value: number;
  unit: string;
  hasExponent: boolean;
}

const UNIT_NORMALIZATION_MAP: Record<string, string> = {
  // Volume
  'cm3': 'cm3', 'cm^3': 'cm3', 'cm^{3}': 'cm3', 'ml': 'cm3', 'millilitres': 'cm3', 'milliliters': 'cm3',
  'dm3': 'dm3', 'dm^3': 'dm3', 'dm^{3}': 'dm3', 'l': 'dm3', 'litres': 'dm3', 'liters': 'dm3',
  // Concentration
  'mol/dm3': 'mol/dm3', 'mol/dm^3': 'mol/dm3', 'mol dm^-3': 'mol/dm3', 'mol*dm^-3': 'mol/dm3', 'moldm-3': 'mol/dm3', 'm': 'mol/dm3', 'molar': 'mol/dm3',
  'g/dm3': 'g/dm3', 'g dm^-3': 'g/dm3', 'g/l': 'g/dm3',
  // Mass
  'g': 'g', 'grams': 'g', 'gram': 'g',
  'kg': 'kg', 'kilograms': 'kg', 'kilogram': 'kg',
  'mg': 'mg', 'milligrams': 'mg',
  // Energy
  'kj/mol': 'kj/mol', 'kj mol^-1': 'kj/mol', 'kj/mole': 'kj/mol',
  'j/mol': 'j/mol', 'j mol^-1': 'j/mol',
  'kj': 'kj', 'kilojoules': 'kj',
  'j': 'j', 'joules': 'j',
  // Temperature & Time
  'c': 'c', '°c': 'c', 'degrees c': 'c', 'degrees celsius': 'c',
  'k': 'k', 'kelvin': 'k',
  's': 's', 'sec': 's', 'seconds': 's',
  'min': 'min', 'mins': 'min', 'minutes': 'min',
  // Percentage
  '%': '%', 'percent': '%', 'percentage': '%',
};

export function parseNumericWithUnit(raw: string): ParsedNumeric | null {
  if (!raw) return null;
  let str = raw.trim().replace(/,/g, ''); // strip thousands commas

  // Match: optional sign (+/-), number (integer/float/scientific notation like 2.5e-3 or 2.5 x 10^-3), optional unit
  const match = str.match(/^([+-]?\d*(?:\.\d+)?(?:[eE][+-]?\d+)?)\s*(?:x\s*10\^?\{?([+-]?\d+)\}?)?\s*(.*)$/);
  if (!match) return null;

  let baseNum = parseFloat(match[1]);
  if (isNaN(baseNum)) return null;

  // Handle explicit x 10^N notation
  if (match[2]) {
    const exp = parseInt(match[2], 10);
    if (!isNaN(exp)) {
      baseNum = baseNum * Math.pow(10, exp);
    }
  }

  let rawUnit = (match[3] || '').trim().toLowerCase();
  // Strip LaTeX wrapping in units
  rawUnit = rawUnit.replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1').replace(/[\$\{\}]/g, '').trim();

  const normUnit = UNIT_NORMALIZATION_MAP[rawUnit] || rawUnit;

  return {
    value: baseNum,
    unit: normUnit,
    hasExponent: !!match[2] || /[eE]/.test(match[1]),
  };
}

/**
 * Compares two numbers with a tolerance percentage (default ±1.5% for experimental/rounding tolerance)
 */
export function isNumericEquivalent(
  studentAnswer: string,
  targetAnswer: string,
  tolerancePercent = 1.5
): { isMatch: boolean; details: string } {
  const student = parseNumericWithUnit(studentAnswer);
  const target = parseNumericWithUnit(targetAnswer);

  if (!student || !target) {
    return { isMatch: false, details: 'Non-numeric format' };
  }

  // Unit compatibility check
  if (target.unit && student.unit && target.unit !== student.unit) {
    // Check possible metric prefix unit conversion (e.g. 0.025 dm3 vs 25 cm3, 1000 J vs 1 kJ)
    if (target.unit === 'dm3' && student.unit === 'cm3' && Math.abs(student.value / 1000 - target.value) <= Math.abs(target.value * 0.02)) {
      return { isMatch: true, details: 'Correct value with converted volume units' };
    }
    if (target.unit === 'kj' && student.unit === 'j' && Math.abs(student.value / 1000 - target.value) <= Math.abs(target.value * 0.02)) {
      return { isMatch: true, details: 'Correct value with converted energy units' };
    }
    return { isMatch: false, details: `Unit mismatch: expected ${target.unit}, got ${student.unit}` };
  }

  // Range / Tolerance check
  const diff = Math.abs(student.value - target.value);
  const maxAllowedDiff = Math.max(Math.abs(target.value) * (tolerancePercent / 100), 0.0001);

  if (diff <= maxAllowedDiff) {
    return { isMatch: true, details: 'Numeric match within tolerance' };
  }

  return { isMatch: false, details: `Value ${student.value} is outside tolerance range of ${target.value}` };
}

// ─── 3. Keyword Fuzzy & Typo Matching ─────────────────────────────────────────

export function getLevenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

export function isKeywordMatch(studentAnswer: string, acceptableKeywords: string[]): boolean {
  if (!studentAnswer || !acceptableKeywords || acceptableKeywords.length === 0) return false;

  const cleanStudent = studentAnswer
    .toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '')
    .trim();

  for (const keyword of acceptableKeywords) {
    const cleanKey = keyword
      .toLowerCase()
      .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '')
      .trim();

    // Exact match
    if (cleanStudent === cleanKey) return true;

    // Contains key phrase
    if (cleanStudent.includes(cleanKey) || cleanKey.includes(cleanStudent)) {
      if (cleanStudent.length >= 3 && cleanKey.length >= 3) return true;
    }

    // Levenshtein typo tolerance for words >= 5 characters
    if (cleanKey.length >= 5 && cleanStudent.length >= 5) {
      const dist = getLevenshteinDistance(cleanStudent, cleanKey);
      if (dist <= 1) return true;
    }
  }

  return false;
}

// ─── 4. Multi-Point Mark Scheme Clause Extractor & Evaluator ──────────────────

interface MarkSchemeTargetPoint {
  originalClause: string;
  label?: string;
  synonyms: string[];
}

/**
 * Strips mark allocations (e.g. [1], [M1], (1 mark)) and extracts the target value after any label
 */
export function cleanMarkSchemeClause(clause: string): { label?: string; target: string } {
  let str = clause
    .replace(/\[[A-Za-z0-9\s]+\]/g, '')
    .replace(/\([0-9]+\s*(?:marks?)?\)/gi, '')
    .trim();

  // If there's a label with a colon (e.g. "state at t1: liquid" or "T1: liquid")
  const colonIdx = str.lastIndexOf(':');
  if (colonIdx !== -1) {
    const label = str.substring(0, colonIdx).trim();
    const target = str.substring(colonIdx + 1).trim();
    if (target.length > 0) {
      return { label, target };
    }
  }

  return { target: str };
}

/**
 * Parses a raw mark scheme string into a list of required target points with synonyms
 */
export function parseMarkSchemeTargetPoints(msText: string): MarkSchemeTargetPoint[] {
  if (!msText) return [];

  // Split on semicolons, newlines, or bullets
  const rawClauses = msText
    .split(/;|\n|•/)
    .map((c) => c.trim())
    .filter(Boolean);

  const points: MarkSchemeTargetPoint[] = [];

  for (const clause of rawClauses) {
    const { label, target } = cleanMarkSchemeClause(clause);
    if (!target) continue;

    // Split target into synonyms / alternatives (e.g. "liquid / molten" or "CO2 OR carbon dioxide")
    const rawSyns = target.split(/\s+OR\s+|\/|\|/i).map((s) => s.trim()).filter(Boolean);
    const synonyms: string[] = [];

    for (const syn of rawSyns) {
      synonyms.push(syn);
      // Also expand chemical formulas if applicable
      const exp = expandFormulaSearch(syn);
      for (const t of exp.expandedTokens) {
        if (t && !synonyms.includes(t)) synonyms.push(t);
      }
    }

    if (synonyms.length > 0) {
      points.push({
        originalClause: clause,
        label,
        synonyms,
      });
    }
  }

  return points;
}

/**
 * Checks if a student's response satisfies a multi-point mark scheme (e.g. "liquid and solid")
 */
export function evaluateMultiPointAnswer(
  studentAnswer: string,
  targetPoints: MarkSchemeTargetPoint[]
): { matchedCount: number; totalPoints: number; isAllMatched: boolean; matchedPoints: string[]; feedbackSummary: string } {
  if (!studentAnswer || targetPoints.length === 0) {
    return { matchedCount: 0, totalPoints: targetPoints.length, isAllMatched: false, matchedPoints: [], feedbackSummary: '' };
  }

  const cleanStudent = studentAnswer
    .toLowerCase()
    .replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, ' ')
    .trim();
  const studentWords = cleanStudent.split(/\s+/).filter(Boolean);

  let matchedCount = 0;
  const matchedPoints: string[] = [];

  for (const point of targetPoints) {
    let pointMatched = false;

    for (const syn of point.synonyms) {
      // 1. Direct or substring match
      const cleanSyn = syn.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, ' ').trim();
      if (!cleanSyn) continue;

      if (cleanStudent.includes(cleanSyn)) {
        pointMatched = true;
        break;
      }

      // 2. Chemical equivalence match
      for (const sWord of studentWords) {
        if (isChemicalEquivalent(sWord, syn)) {
          pointMatched = true;
          break;
        }
      }
      if (pointMatched) break;

      // 3. Word-set match (e.g. all words of "carbon dioxide" in student's answer)
      const synWords = cleanSyn.split(/\s+/).filter(Boolean);
      if (synWords.length > 0 && synWords.every((w) => studentWords.includes(w))) {
        pointMatched = true;
        break;
      }

      // 4. Typo / Levenshtein fuzzy match
      if (syn.length >= 5) {
        for (const sWord of studentWords) {
          if (sWord.length >= 4 && getLevenshteinDistance(sWord, cleanSyn) <= 1) {
            pointMatched = true;
            break;
          }
        }
        if (pointMatched) break;
      }
    }

    if (pointMatched) {
      matchedCount++;
      matchedPoints.push(point.label ? `${point.label}: ${point.synonyms[0]}` : point.synonyms[0]);
    }
  }

  const isAllMatched = matchedCount === targetPoints.length;
  const feedbackSummary = targetPoints
    .map((p) => p.label ? `${p.label}: ${p.synonyms[0]}` : p.synonyms[0])
    .join('; ');

  return {
    matchedCount,
    totalPoints: targetPoints.length,
    isAllMatched,
    matchedPoints,
    feedbackSummary,
  };
}

// ─── 5. Main Deterministic Evaluation Dispatcher ──────────────────────────────

/**
 * Extracts list of acceptable answers from question mark schemes, guidance, or sub-questions
 */
export function extractAcceptableAnswers(question: Question, subIndex?: number): string[] {
  const result: string[] = [];

  // Check sub-question mark scheme first
  if (subIndex !== undefined && question.sub_questions && question.sub_questions[subIndex]) {
    const sq = question.sub_questions[subIndex];
    if (sq.mark_scheme) result.push(sq.mark_scheme);
    if (sq.options && sq.options.length > 0) result.push(sq.options[0]);
  }

  // Check parent question mark_scheme
  if (question.mark_scheme) {
    if (question.mark_scheme.acceptable_answers) {
      result.push(...question.mark_scheme.acceptable_answers);
    }
    if (question.mark_scheme.marking_points) {
      result.push(...question.mark_scheme.marking_points);
    }
  }

  // Check simple options (for MCQ / Single choice)
  if (question.options && question.options.length > 0) {
    result.push(question.options[0]);
  }

  return Array.from(new Set(result.map((s) => s.trim()).filter(Boolean)));
}

/**
 * Evaluates a student response deterministically. Returns isHandled: true if evaluation succeeded without AI.
 */
export function gradeDeterministicAnswer(
  studentAnswer: string | number,
  question: Question,
  subIndex?: number
): DeterministicGradeResult {
  const maxMarks = (subIndex !== undefined && question.sub_questions?.[subIndex])
    ? question.sub_questions[subIndex].marks || 1
    : question.marks || 1;

  if (studentAnswer === undefined || studentAnswer === null || String(studentAnswer).trim() === '') {
    return {
      isHandled: true,
      earnedMarks: 0,
      maxMarks,
      isCorrect: false,
      matchType: 'unhandled',
      feedback: 'No answer provided.',
    };
  }

  const rawAnswerStr = String(studentAnswer).trim();
  const acceptableList = extractAcceptableAnswers(question, subIndex);

  if (acceptableList.length === 0) {
    return {
      isHandled: false,
      earnedMarks: 0,
      maxMarks,
      isCorrect: false,
      matchType: 'unhandled',
      feedback: 'No reference mark scheme available for deterministic evaluation.',
    };
  }

  // A. Check Chemical Formula / Synonym Equivalence on Cleaned Targets
  for (const target of acceptableList) {
    const { target: cleanedTarget } = cleanMarkSchemeClause(target);
    if (isChemicalEquivalent(rawAnswerStr, target) || (cleanedTarget && isChemicalEquivalent(rawAnswerStr, cleanedTarget))) {
      return {
        isHandled: true,
        earnedMarks: maxMarks,
        maxMarks,
        isCorrect: true,
        matchType: 'formula',
        feedback: `✓ Correct chemical formula / substance name (${cleanedTarget || target})`,
        matchedCriteria: [cleanedTarget || target],
        acceptedAnswers: acceptableList,
      };
    }
  }

  // B. Check Numerical Calculation Match
  const isStudentNumeric = parseNumericWithUnit(rawAnswerStr) !== null;
  if (isStudentNumeric) {
    for (const target of acceptableList) {
      const { target: cleanedTarget } = cleanMarkSchemeClause(target);
      const numResult = isNumericEquivalent(rawAnswerStr, target) || (cleanedTarget ? isNumericEquivalent(rawAnswerStr, cleanedTarget) : { isMatch: false, details: '' });
      if (numResult.isMatch) {
        return {
          isHandled: true,
          earnedMarks: maxMarks,
          maxMarks,
          isCorrect: true,
          matchType: 'numeric',
          feedback: `✓ Correct numerical calculation: ${rawAnswerStr} (${numResult.details})`,
          matchedCriteria: [cleanedTarget || target],
          acceptedAnswers: acceptableList,
        };
      }
    }
  }

  // C. Multi-Point / Multi-Clause Matching (e.g. "state at t1: liquid [1]; state at T2: solid [1]")
  for (const targetStr of acceptableList) {
    const targetPoints = parseMarkSchemeTargetPoints(targetStr);
    if (targetPoints.length >= 2) {
      const multiRes = evaluateMultiPointAnswer(rawAnswerStr, targetPoints);
      if (multiRes.matchedCount > 0) {
        const earned = Math.round((multiRes.matchedCount / multiRes.totalPoints) * maxMarks);
        return {
          isHandled: true,
          earnedMarks: earned,
          maxMarks,
          isCorrect: multiRes.isAllMatched,
          matchType: 'keyword',
          feedback: multiRes.isAllMatched
            ? `✓ All ${multiRes.totalPoints} criteria met: ${multiRes.feedbackSummary}`
            : `Partial match (${multiRes.matchedCount}/${multiRes.totalPoints}): Expected: ${multiRes.feedbackSummary}`,
          matchedCriteria: multiRes.matchedPoints,
          acceptedAnswers: [multiRes.feedbackSummary],
        };
      }
    }
  }

  // D. Check Short Keyword / Term Match
  const isShortAnswer = acceptableList.some((a) => a.split(/\s+/).length <= 6);
  if (isShortAnswer && rawAnswerStr.split(/\s+/).length <= 8) {
    const cleanedTargets = acceptableList.map((a) => cleanMarkSchemeClause(a).target).filter(Boolean);
    if (isKeywordMatch(rawAnswerStr, acceptableList) || isKeywordMatch(rawAnswerStr, cleanedTargets)) {
      return {
        isHandled: true,
        earnedMarks: maxMarks,
        maxMarks,
        isCorrect: true,
        matchType: 'keyword',
        feedback: `✓ Correct answer: ${cleanedTargets[0] || acceptableList[0]}`,
        matchedCriteria: cleanedTargets.length > 0 ? cleanedTargets : acceptableList,
        acceptedAnswers: acceptableList,
      };
    }
  }

  // E. If maxMarks == 1 and student gave a short response that didn't match any accepted criteria
  if (maxMarks === 1 && rawAnswerStr.split(/\s+/).length <= 4) {
    const cleaned = cleanMarkSchemeClause(acceptableList[0]).target || acceptableList[0];
    return {
      isHandled: true,
      earnedMarks: 0,
      maxMarks: 1,
      isCorrect: false,
      matchType: 'keyword',
      feedback: `Incorrect. Expected: ${cleaned}`,
      acceptedAnswers: acceptableList,
    };
  }

  // F. For multi-mark complex descriptive explanations (2-6 marks), pass to AI grader
  return {
    isHandled: false,
    earnedMarks: 0,
    maxMarks,
    isCorrect: false,
    matchType: 'unhandled',
    feedback: 'Complex descriptive question: requires mark scheme criteria evaluation.',
    acceptedAnswers: acceptableList,
  };
}
