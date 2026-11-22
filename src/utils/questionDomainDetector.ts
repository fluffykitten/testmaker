import type { Question, SubQuestion } from '../types/database';

export type QuestionDomain = 'math' | 'chemistry' | 'science' | 'language' | 'general';

export interface ExamDomainContext {
  subject?: string | null;
  subjectCode?: string | null;
  additionalMaterials?: string | null;
  title?: string | null;
}

export interface QuestionDomainResult {
  domain: QuestionDomain;
  isLanguage: boolean;
  isChemistry: boolean;
  isMath: boolean;
  isStemOrMath: boolean;
}

export interface QuickSymbolItem {
  label: string;
  insert: string;
  title: string;
  cursorOffset?: number;
  wrapSelection?: boolean;
}

export const MATH_QUICK_SYMBOLS: QuickSymbolItem[] = [
  { label: 'xₙ', insert: '_{}', title: 'Subscript (e.g. x_{1} or a_{n})', cursorOffset: 2, wrapSelection: true },
  { label: 'xⁿ', insert: '^{}', title: 'Superscript / Power (e.g. x^{2})', cursorOffset: 2, wrapSelection: true },
  { label: 'a/b', insert: '\\frac{}{}', title: 'Fraction: \\frac{numerator}{denominator}', cursorOffset: 6, wrapSelection: true },
  { label: '√', insert: '\\sqrt{}', title: 'Square Root: \\sqrt{x}', cursorOffset: 6, wrapSelection: true },
  { label: 'π', insert: 'π', title: 'Pi (π)' },
  { label: 'θ', insert: 'θ', title: 'Theta (θ)' },
  { label: 'Δ', insert: 'Δ', title: 'Delta (Δ)' },
  { label: '±', insert: '±', title: 'Plus-minus (±)' },
  { label: '×', insert: '×', title: 'Multiply (×)' },
  { label: '÷', insert: '÷', title: 'Divide (÷)' },
  { label: '≤', insert: '≤', title: 'Less than or equal (≤)' },
  { label: '≥', insert: '≥', title: 'Greater than or equal (≥)' },
  { label: '≠', insert: '≠', title: 'Not equal (≠)' },
  { label: '≈', insert: '≈', title: 'Approximately equal (≈)' },
  { label: '°', insert: '°', title: 'Degree (°)' },
  { label: '∞', insert: '∞', title: 'Infinity (∞)' },
];

export const CHEM_QUICK_SYMBOLS: QuickSymbolItem[] = [
  { label: 'xₙ', insert: '_{}', title: 'Subscript (e.g. H_{2}O)', cursorOffset: 2, wrapSelection: true },
  { label: 'xⁿ', insert: '^{}', title: 'Superscript / Charge (e.g. Fe^{2+})', cursorOffset: 2, wrapSelection: true },
  { label: '→', insert: '→', title: 'Reaction arrow (→)' },
  { label: '⇌', insert: '⇌', title: 'Equilibrium arrow (⇌)' },
  { label: 'Δ', insert: 'Δ', title: 'Delta (Δ)' },
  { label: '°C', insert: '°C', title: 'Degrees Celsius (°C)' },
  { label: 'mol/dm³', insert: 'mol/dm³', title: 'mol/dm³' },
  { label: 'g/cm³', insert: 'g/cm³', title: 'g/cm³' },
  { label: 'kJ/mol', insert: 'kJ/mol', title: 'kJ/mol' },
  { label: '(s)', insert: '(s)', title: 'Solid state (s)' },
  { label: '(l)', insert: '(l)', title: 'Liquid state (l)' },
  { label: '(g)', insert: '(g)', title: 'Gas state (g)' },
  { label: '(aq)', insert: '(aq)', title: 'Aqueous state (aq)' },
  { label: '⁺', insert: '⁺', title: 'Positive charge superscript' },
  { label: '⁻', insert: '⁻', title: 'Negative charge superscript' },
  { label: '²', insert: '²', title: 'Squared (²)' },
  { label: '³', insert: '³', title: 'Cubed (³)' },
  { label: '⁴', insert: '⁴', title: 'Power 4 (⁴)' },
];

const LANGUAGE_TOPIC_RE =
  /\b(english|bahasa|literature|reading|listening|writing|speaking|grammar|vocabulary|comprehension|ielts|cefr|tka|directed\s+writing|summary|essay|language|linguistics)\b/i;

const LANGUAGE_PROMPT_RE =
  /(?:###\s*(?:Text|Passage|Reading|Stimulus|Wacana|Bacaan)\b|(?:write|minimum(?:\s+of)?)\s+(?:at\s+least\s+)?\d{2,4}\s+words\b|\b(?:grammar|synonym|antonym|passage|author's\s+tone|main\s+idea|reading\s+comprehension|rewrite\s+the\s+sentence|correct\s+the\s+mistake|word\s+in\s+(?:the\s+)?brackets?|fill\s+in\s+the\s+blanks?)\b)/i;

const MATH_TOPIC_RE =
  /\b(math(?:ematics|s)?|algebra|geometry|calculus|trigonometry|trig|probability|statistics|arithmetic|mensuration|vector(?:s)?|matric(?:es|x)|coordinate(?:s)?|logarithm(?:s)?|exponential(?:s)?|quadratic(?:s)?|polynomial(?:s)?|inequalit(?:y|ies)|differentiation|integration|binomial|permutation|combination|numeracy|quantitative|pythagoras|ratios?|proportions?|percentages?|sequences?\s+and\s+series|functions?|graphs?)\b/i;

const MATH_LATEX_RE =
  /(?:\\(?:frac|sqrt|sum|int|lim|sin|cos|tan|log|ln|pi|theta|alpha|beta|le|ge|neq|pm|times|div|approx|cdot)\b|\$[^$\n]*(?:[\\^_=+\-*/<>]|\\frac|\\sqrt)[^$\n]*\$|[a-zA-Z0-9)\]]\s*(?:\^\{?[0-9a-zA-Z+\-]+\}?|_\{?[0-9a-zA-Z]+\}?))/;

const MATH_PROMPT_RE =
  /\b(solve\s+(?:for|the\s+(?:equation|inequality|system))|simplify|factori[sz]e|differentiate|integrate|evaluate|find\s+the\s+value\s+of|express\s+.{1,30}\s+in\s+terms\s+of|gradient\s+of|equation\s+of\s+the\s+(?:line|curve|circle)|area\s+of|volume\s+of|circumference|perimeter|quadratic|polynomial|inequality|simultaneous\s+equations?|trigonometr(?:y|ic)|logarithm|vector|matrix)\b/i;

const CHEM_TOPIC_RE =
  /\b(chem(?:istry)?|stoichiometry|titration|enthalpy|electrolysis|periodic\s+table|organic\s+chemistry|redox|acid(?:s)?\s+and\s+base(?:s)?|ionic\s+bonding|covalent\s+bonding)\b/i;

const CHEM_PROMPT_RE =
  /(?:⇌|\b(?:mol\/dm|g\/cm|kJ\/mol|enthalpy|moles?|molarity|titration|anode|cathode|electrolyte|isotope|alkane|alkene|ester|polymer|oxidation\s+state|half[- ]equation|ionic\s+equation|chemical\s+(?:equation|formula)|pH\s+of)\b|\(aq\))/i;

const SCIENCE_TOPIC_RE =
  /\b(phys(?:ics)?|bio(?:logy)?|science|kinematics|dynamics|electricity|magnetism|optics|thermodynamics|genetics|ecology|anatomy|physiology|economics|accounting)\b/i;

const SCIENCE_PROMPT_RE =
  /\b(velocity|acceleration|momentum|kinetic\s+energy|potential\s+energy|circuit|resistance|voltage|current|ohm|wavelength|frequency|refraction|osmosis|photosynthesis|mitosis|enzyme|chromosome)\b/i;

function extractMarkSchemeText(question?: Partial<Question> | null, subQuestion?: Partial<SubQuestion> | null): string {
  const parts: string[] = [];
  if (typeof subQuestion?.mark_scheme === 'string') parts.push(subQuestion.mark_scheme);
  if (typeof subQuestion?.guidance === 'string') parts.push(subQuestion.guidance);
  const ms = question?.mark_scheme as Record<string, unknown> | null | undefined;
  if (ms && typeof ms === 'object') {
    if (typeof ms.model_answer === 'string') parts.push(ms.model_answer);
    if (typeof ms.guidance === 'string') parts.push(ms.guidance);
    if (Array.isArray(ms.marking_points)) {
      ms.marking_points.forEach((pt) => {
        if (typeof pt === 'string') parts.push(pt);
        else if (pt && typeof pt === 'object' && 'point' in pt && typeof (pt as { point?: unknown }).point === 'string') {
          parts.push((pt as { point: string }).point);
        }
      });
    }
  }
  return parts.join(' ');
}

function buildResult(domain: QuestionDomain): QuestionDomainResult {
  return {
    domain,
    isLanguage: domain === 'language',
    isChemistry: domain === 'chemistry',
    isMath: domain === 'math',
    isStemOrMath: domain === 'math' || domain === 'chemistry' || domain === 'science',
  };
}

/**
 * Classifies exam-level fallback domain from headerConfig/title.
 * Neutral or explicitly multi-domain titles (e.g. "Admission Test", "English & Math")
 * resolve to 'general' so individual questions decide their own helpers.
 */
export function classifyExamFallbackDomain(examContext?: ExamDomainContext | null): QuestionDomain {
  if (!examContext) return 'general';
  const subj = (examContext.subject || '').toLowerCase();
  const code = (examContext.subjectCode || '').toLowerCase();
  const mats = (examContext.additionalMaterials || '').toLowerCase();
  const title = (examContext.title || '').toLowerCase();
  const combined = `${subj} ${code} ${title}`.trim();

  const hasLang =
    /\b(english|bahasa|literature|reading|ielts|cefr|tka)\b/.test(combined) ||
    ['0500', '0510', '0511', '1123', '9093'].some((c) => code.includes(c));
  const hasChem =
    /\bchem(?:istry)?\b/.test(combined) ||
    ['0620', '0971', '5070'].some((c) => code === c || code.includes(c)) ||
    mats.includes('periodic');
  const hasMath =
    /\bmath(?:ematics|s)?\b/.test(combined) ||
    code.includes('0580') ||
    code.includes('0606') ||
    code.includes('9709') ||
    mats.includes('calc');
  const hasScience =
    /\b(phys(?:ics)?|fisika|bio(?:logy|logi)?|sci(?:ence)?|ipa|econ(?:omics)?|account(?:ing)?)\b/.test(combined) ||
    code === 'fis' ||
    code.includes('0625') ||
    code.includes('0610');

  // Mixed-domain exam (e.g. "English & Math Admission Test") -> do not lock exam-wide
  if (hasLang && (hasMath || hasChem || hasScience)) {
    return 'general';
  }
  if (hasChem) return 'chemistry';
  if (hasMath) return 'math';
  if (hasScience) return 'science';
  if (hasLang) return 'language';
  return 'general';
}

/**
 * Classifies a single question (or active sub-part) into a subject domain
 * using its own topic/sub_topic/prompt/mark-scheme signals first, falling back
 * to examContext only when the question carries no domain signal.
 */
export function classifyQuestionDomain(
  question?: Partial<Question> | null,
  subQuestion?: Partial<SubQuestion> | null,
  examContext?: ExamDomainContext | null
): QuestionDomainResult {
  if (!question && !subQuestion) {
    return buildResult(classifyExamFallbackDomain(examContext));
  }

  const topicText = `${question?.topic || ''} ${question?.sub_topic || ''}`.trim();
  const subText = subQuestion?.question_text || '';
  const stemText = question?.question_text || '';
  const msText = extractMarkSchemeText(question, subQuestion);
  const promptAndMs = `${subText} ${stemText} ${msText}`.trim();

  const scores: Record<'math' | 'chemistry' | 'science' | 'language', number> = {
    math: 0,
    chemistry: 0,
    science: 0,
    language: 0,
  };

  // 1. Topic / Sub-topic signals (strongest per-question indicator)
  if (MATH_TOPIC_RE.test(topicText)) scores.math += 5;
  if (CHEM_TOPIC_RE.test(topicText)) scores.chemistry += 5;
  if (SCIENCE_TOPIC_RE.test(topicText)) scores.science += 4;
  if (LANGUAGE_TOPIC_RE.test(topicText)) scores.language += 5;

  // 2. Sub-question stem (if evaluating a specific sub-part, inspect it first)
  if (subText) {
    if (MATH_LATEX_RE.test(subText) || MATH_PROMPT_RE.test(subText)) scores.math += 4;
    if (CHEM_PROMPT_RE.test(subText)) scores.chemistry += 4;
    if (SCIENCE_PROMPT_RE.test(subText)) scores.science += 3;
    if (LANGUAGE_PROMPT_RE.test(subText)) scores.language += 4;
  }

  // 3. Parent stem + mark scheme signals
  if (MATH_LATEX_RE.test(promptAndMs)) scores.math += 3;
  if (MATH_PROMPT_RE.test(promptAndMs)) scores.math += 2;
  if (CHEM_PROMPT_RE.test(promptAndMs)) scores.chemistry += 3;
  if (SCIENCE_PROMPT_RE.test(promptAndMs)) scores.science += 2;
  if (LANGUAGE_PROMPT_RE.test(promptAndMs)) scores.language += 3;

  // Sub-question numbers or word-target writing task strongly indicate language prose
  if (/(?:write|minimum(?:\s+of)?)\s+(?:at\s+least\s+)?\d{2,4}\s+words\b/i.test(`${subText}\n${stemText}`)) {
    scores.language += 4;
  }

  const ranked = (Object.entries(scores) as Array<['math' | 'chemistry' | 'science' | 'language', number]>)
    .sort((a, b) => b[1] - a[1]);
  const [topDomain, topScore] = ranked[0];

  if (topScore > 0) {
    // If math LaTeX notation explicitly appears alongside weak language cues (tie), prefer math tools
    if (scores.math > 0 && scores.math === scores.language && MATH_LATEX_RE.test(subText || stemText)) {
      return buildResult('math');
    }
    return buildResult(topDomain);
  }

  return buildResult(classifyExamFallbackDomain(examContext));
}

export function getQuickSymbolsForDomain(domain: QuestionDomain): QuickSymbolItem[] {
  if (domain === 'chemistry' || domain === 'science') {
    return CHEM_QUICK_SYMBOLS;
  }
  return MATH_QUICK_SYMBOLS;
}

/**
 * Inserts a QuickSymbolItem at the active textarea cursor/selection range.
 * Wraps highlighted text for braces templates (`_{}`, `^{}`, `\sqrt{}`, `\frac{}{}`)
 * and positions the caret inside braces when empty.
 */
export function applySymbolInsertion(
  currentValue: string,
  selectionStart: number | null | undefined,
  selectionEnd: number | null | undefined,
  item: Pick<QuickSymbolItem, 'insert' | 'cursorOffset' | 'wrapSelection'>
): { nextValue: string; nextCursorPos: number } {
  const len = currentValue.length;
  const start = typeof selectionStart === 'number' && selectionStart >= 0 ? Math.min(selectionStart, len) : len;
  const end = typeof selectionEnd === 'number' && selectionEnd >= start ? Math.min(selectionEnd, len) : start;
  const selected = currentValue.slice(start, end);
  const before = currentValue.slice(0, start);
  const after = currentValue.slice(end);

  if (item.wrapSelection && selected.length > 0) {
    if (item.insert === '_{}') {
      const text = `_{${selected}}`;
      return { nextValue: before + text + after, nextCursorPos: start + text.length };
    }
    if (item.insert === '^{}') {
      const text = `^{${selected}}`;
      return { nextValue: before + text + after, nextCursorPos: start + text.length };
    }
    if (item.insert === '\\sqrt{}') {
      const text = `\\sqrt{${selected}}`;
      return { nextValue: before + text + after, nextCursorPos: start + text.length };
    }
    if (item.insert === '\\frac{}{}') {
      const numPart = `\\frac{${selected}}{`;
      const text = `${numPart}}`;
      return { nextValue: before + text + after, nextCursorPos: start + numPart.length };
    }
  }

  const nextValue = before + item.insert + after;
  const offset = typeof item.cursorOffset === 'number' ? item.cursorOffset : item.insert.length;
  return {
    nextValue,
    nextCursorPos: start + offset,
  };
}
