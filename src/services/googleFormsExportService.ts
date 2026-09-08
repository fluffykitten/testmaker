// ─── Google Forms Export Service ─────────────────────────────────────────────
// Generates native Google Forms Quizzes via Google Forms API v1 & Google Apps Script.

import type { Question, SubQuestion, ExamDataTable } from '../types/database';
import type { ExamHeaderConfig } from './testBuilderService';
import { resolveMcqCorrectOptionIndex } from './deterministicGradingService';
import { loadGsiScript } from './googleDriveService';
import { stripDuplicateOptionsFromStem, stripDuplicateSubQuestionsFromStem } from '../lib/gemini';
import { compareQuestionNumbers } from './questionBankService';
import { extractMarkdownTable, extractStructuredTable, renderTableToPngDataUrl, formatTableToCleanText } from '../lib/tableImageRenderer';

export const FORMS_BODY_SCOPE = 'https://www.googleapis.com/auth/forms.body';
export const FORMS_API_CONSOLE_URL = 'https://console.cloud.google.com/apis/library/forms.googleapis.com';

export interface FormFlattenedItem {
  id: string;
  title: string;
  description?: string;
  pointValue: number;
  type: 'RADIO' | 'CHECKBOX' | 'PARAGRAPH';
  options?: string[];
  correctOptionIndices?: number[];
  correctAnswers?: string[];
  feedbackRight?: string;
  feedbackWrong?: string;
  imageUrl?: string | null;
  imageBase64?: string | null;
  altText?: string;
}

export interface GoogleFormResult {
  formId: string;
  editUrl: string;
  responderUrl: string;
  title: string;
  totalQuestions: number;
  totalMarks: number;
  mcqCount: number;
}

export interface GoogleFormsProgress {
  stage: 'auth' | 'creating' | 'populating' | 'done' | 'error';
  currentChunk?: number;
  totalChunks?: number;
  completedItems?: number;
  totalItems?: number;
  message: string;
}

// ─── Unicode Superscript & Subscript Maps ────────────────────────────────────

const SUPERSCRIPT_MAP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  'n': 'ⁿ', 'i': 'ⁱ', 'x': 'ˣ',
};

const SUBSCRIPT_MAP: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  'a': 'ₐ', 'e': 'ₑ', 'o': 'ₒ', 'x': 'ₓ', 'h': 'ₕ',
  'k': 'ₖ', 'l': 'ₗ', 'm': 'ₘ', 'n': 'ₙ', 'p': 'ₚ',
  's': 'ₛ', 't': 'ₜ', 'r': 'ᵣ', 'i': 'ᵢ', 'j': 'ⱼ',
  'u': 'ᵤ', 'v': 'ᵥ',
};

function toUnicodeSuperscript(str: string): string {
  if (!str) return '';
  let converted = '';
  for (const char of str) {
    if (SUPERSCRIPT_MAP[char]) {
      converted += SUPERSCRIPT_MAP[char];
    } else {
      return `^(${str})`; // Fallback for complex math
    }
  }
  return converted;
}

function toUnicodeSubscript(str: string): string {
  if (!str) return '';
  let converted = '';
  for (const char of str) {
    if (SUBSCRIPT_MAP[char]) {
      converted += SUBSCRIPT_MAP[char];
    } else {
      return `_(${str})`; // Fallback for complex math
    }
  }
  return converted;
}

/**
 * Converts complex LaTeX, Markdown, HTML, and math expressions into clean Unicode plain text.
 * Sanitizes newlines and whitespace to guarantee Google Forms API v1 payload compatibility.
 */
export function cleanTextForGoogleForms(text: string, options?: { preserveNewlines?: boolean }): string {
  if (!text) return '';

  let cleaned = text
    // Chemistry arrows & reactions
    .replace(/\\xrightarrow\{(.*?)\}/g, ' ──($1)──> ')
    .replace(/\\rightleftharpoons/g, ' ⇌ ')
    .replace(/\\leftrightarrow/g, ' ↔ ')
    .replace(/\\rightarrow/g, ' → ')
    .replace(/\\leftarrow/g, ' ← ')
    .replace(/\\Rightarrow/g, ' ⇒ ')
    .replace(/\\Leftarrow/g, ' ⇐ ')
    .replace(/\\Leftrightarrow/g, ' ⇔ ')
    .replace(/\\uparrow\b/g, '↑')
    .replace(/\\downarrow\b/g, '↓')

    // Math & Comparison Operators
    .replace(/\\times/g, ' × ')
    .replace(/\\cdot/g, ' · ')
    .replace(/\\div/g, ' ÷ ')
    .replace(/\\pm/g, ' ± ')
    .replace(/\\mp/g, ' ∓ ')
    .replace(/\\approx/g, ' ≈ ')
    .replace(/\\neq/g, ' ≠ ')
    .replace(/\\le(q)?\b/g, ' ≤ ')
    .replace(/\\ge(q)?\b/g, ' ≥ ')
    .replace(/\\infty/g, ' ∞ ')
    .replace(/\\equiv/g, ' ≡ ')
    .replace(/\\propto/g, ' ∝ ')
    .replace(/\\sim/g, ' ∼ ')

    // Geometry, Logic & Proof symbols
    .replace(/\\angle\b/g, '∠ ')
    .replace(/\\triangle\b/g, '△ ')
    .replace(/\\parallel\b/g, ' ∥ ')
    .replace(/\\perp\b/g, ' ⊥ ')
    .replace(/\\cong\b/g, ' ≅ ')
    .replace(/\\therefore\b/g, ' ∴ ')
    .replace(/\\because\b/g, ' ∵ ')
    .replace(/\\bullet\b/g, ' • ')

    // Calculus & Set Theory symbols
    .replace(/\\sum\b/g, '∑ ')
    .replace(/\\prod\b/g, '∏ ')
    .replace(/\\int\b/g, '∫ ')
    .replace(/\\partial\b/g, '∂')
    .replace(/\\nabla\b/g, '∇')
    .replace(/\\in\b/g, ' ∈ ')
    .replace(/\\notin\b/g, ' ∉ ')
    .replace(/\\subset\b/g, ' ⊂ ')
    .replace(/\\subseteq\b/g, ' ⊆ ')
    .replace(/\\cup\b/g, ' ∪ ')
    .replace(/\\cap\b/g, ' ∩ ')

    // Vectors & Accents
    .replace(/\\vec\{([a-zA-Z0-9]+)\}/g, '$1⃗')
    .replace(/\\bar\{([a-zA-Z0-9]+)\}/g, '$1̄')
    .replace(/\\hat\{([a-zA-Z0-9]+)\}/g, '$1̂')

    // LaTeX spacing commands: \, \: \; \! \ ~ \quad \qquad
    .replace(/\\,/g, ' ')
    .replace(/\\:/g, ' ')
    .replace(/\\;/g, ' ')
    .replace(/\\!/g, '')
    .replace(/\\ /g, ' ')
    .replace(/~/g, ' ')
    .replace(/\\quad/g, '   ')
    .replace(/\\qquad/g, '      ')

    // Temperature notations: 25^\circ C, 25^{\circ}\text{C}, 25\degree C, 25\celsius, 45\,°C
    .replace(/\\(degreeC|celsius)\b/g, '°C')
    .replace(/\\degree\s*\\text\{\s*C\s*\}/gi, '°C')
    .replace(/\\degree\s*\\mathrm\{\s*C\s*\}/gi, '°C')
    .replace(/\\degree\s*C\b/gi, '°C')
    .replace(/\^\{\\circ\s*\\text\{\s*C\s*\}\}/gi, '°C')
    .replace(/\^\{\\circ\s*\\mathrm\{\s*C\s*\}/gi, '°C')
    .replace(/\^\{\\circ\s*C\}/gi, '°C')
    .replace(/(\^\{?\\circ\}?)\s*\\text\{\s*C\s*\}/gi, '°C')
    .replace(/(\^\{?\\circ\}?)\s*\\mathrm\{\s*C\s*\}/gi, '°C')
    .replace(/(\^\{?\\circ\}?)\s*C\b/gi, '°C')
    .replace(/(\^\{?\\circ\}?)\s*\\text\{\s*F\s*\}/gi, '°F')
    .replace(/(\^\{?\\circ\}?)\s*F\b/gi, '°F')
    .replace(/\^\{\\circ\}/g, '°')
    .replace(/\^\\circ/g, '°')
    .replace(/\\degree\b/g, '°')
    .replace(/\\circ\b/g, '°')

    // Greek letters (with LaTeX command whitespace consumption for variables like \Delta H -> ΔH)
    .replace(/\\Delta\s*([A-Za-z])/g, 'Δ$1')
    .replace(/\\Delta\b/g, 'Δ')
    .replace(/\\delta\s*([A-Za-z])/g, 'δ$1')
    .replace(/\\delta\b/g, 'δ')
    .replace(/\\Alpha/g, 'Α')
    .replace(/\\alpha/g, 'α')
    .replace(/\\Beta/g, 'Β')
    .replace(/\\beta/g, 'β')
    .replace(/\\Gamma/g, 'Γ')
    .replace(/\\gamma/g, 'γ')
    .replace(/\\Theta/g, 'Θ')
    .replace(/\\theta/g, 'θ')
    .replace(/\\Pi/g, 'Π')
    .replace(/\\pi/g, 'π')
    .replace(/\\mu/g, 'μ')
    .replace(/\\Sigma/g, 'Σ')
    .replace(/\\sigma/g, 'σ')
    .replace(/\\Omega/g, 'Ω')
    .replace(/\\omega/g, 'ω')
    .replace(/\\Lambda/g, 'Λ')
    .replace(/\\lambda/g, 'λ')
    .replace(/\\Phi/g, 'Φ')
    .replace(/\\phi/g, 'ϕ')
    .replace(/\\tau/g, 'τ')
    .replace(/\\eta/g, 'η')
    .replace(/\\rho/g, 'ρ')
    .replace(/\\epsilon/g, 'ε')

    // Roots: \sqrt[3]{x} -> ³√(x), \sqrt{x} -> √(x)
    .replace(/\\sqrt\[(.*?)\]\{([^{}]+)\}/g, (_m, n, rad) => `${toUnicodeSuperscript(n)}√(${rad})`)
    .replace(/\\sqrt\{([^{}]+)\}/g, '√($1)')

    // Nuclide / Isotope notation: {}^{40}_{20}W or _{20}^{40}W -> ⁴⁰₂₀W
    .replace(/(?:\{\}\s*)?(?:_\^|\^)\{([^{}]+)\}\s*_\{([^{}]+)\}/g, (_m, sup, sub) => `${toUnicodeSuperscript(sup)}${toUnicodeSubscript(sub)}`)
    .replace(/(?:\{\}\s*)?_\{([^{}]+)\}\s*\^\{([^{}]+)\}/g, (_m, sub, sup) => `${toUnicodeSuperscript(sup)}${toUnicodeSubscript(sub)}`)
    .replace(/(?:\{\}\s*)?(?:_\^|\^)([0-9a-zA-Z]+)\s*_([0-9a-zA-Z]+)/g, (_m, sup, sub) => `${toUnicodeSuperscript(sup)}${toUnicodeSubscript(sub)}`)
    .replace(/(?:\{\}\s*)?_([0-9a-zA-Z]+)\s*\^([0-9a-zA-Z]+)/g, (_m, sub, sup) => `${toUnicodeSuperscript(sup)}${toUnicodeSubscript(sub)}`)
    .replace(/\\prescript\{([^{}]+)\}\{([^{}]+)\}/g, (_m, sup, sub) => `${toUnicodeSuperscript(sup)}${toUnicodeSubscript(sub)}`);

  // Font wrappers: resolve nested font wrappers (e.g. \text{\textbf{x}})
  let prevFont = '';
  while (cleaned !== prevFont) {
    prevFont = cleaned;
    cleaned = cleaned.replace(/\\(text|mathrm|mathbf|mathit|ce|boldsymbol|textnormal)\{([^{}]+)\}/g, '$2');
  }

  // Fractions: resolve nested fractions if any
  let prevCleaned = '';
  while (cleaned !== prevCleaned) {
    prevCleaned = cleaned;
    cleaned = cleaned.replace(/\\(?:d)?frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1 / $2)');
  }

  // Superscripts to Unicode
  cleaned = cleaned
    // 1. Braced superscripts: ^{...}
    .replace(/\^{([^{}]*)}/g, (_m, p1) => toUnicodeSuperscript(p1))
    // 2. Unbraced charge superscripts: Fe^2+, SO_4^2-, Ba^2+, Cl^-, Na^+
    .replace(/([a-zA-Z0-9)\]])\^(\d*[+-]|[+-]\d+)(?=[\s;,.)\]-]|$)/g, (_m, base, exp) => `${base}${toUnicodeSuperscript(exp)}`)
    // 3. Unbraced digit/variable superscripts: x^2, 10^5, x^n
    .replace(/([a-zA-Z0-9)\]])\^([0-9nix])(?![a-zA-Z0-9])/g, (_m, base, exp) => `${base}${toUnicodeSuperscript(exp)}`);

  // Subscripts to Unicode (including M_r, A_r, v_i, x_n)
  cleaned = cleaned
    // 1. Braced subscripts: _{...}
    .replace(/_{([^{}]*)}/g, (_m, p1) => toUnicodeSubscript(p1))
    // 2. Unbraced digit subscripts: H_2, SO_4, x_1, v_10
    .replace(/([a-zA-Z0-9)\]])_(\d+)/g, (_m, base, sub) => `${base}${toUnicodeSubscript(sub)}`)
    // 3. Unbraced letter subscripts: M_r, A_r, v_i, v_x, a_n
    .replace(/([a-zA-Z0-9)\]])_([aeoxhklmnpstrijuv])(?![a-zA-Z0-9])/g, (_m, base, sub) => `${base}${toUnicodeSubscript(sub)}`);

  // Strip Markdown & HTML formatting
  cleaned = cleaned
    .replace(/<[^>]*>/g, ' ') // Strip HTML tags
    .replace(/\$\$(.*?)\$\$/g, '$1') // Strip display math delimiters
    .replace(/\$(.*?)\$/g, '$1') // Strip inline math delimiters
    .replace(/\\\(|\\\)/g, '')
    .replace(/\\\[|\\\]/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1') // Strip bold
    .replace(/\*([^*]+)\*/g, '$1') // Strip italics
    .replace(/`([^`]+)`/g, '$1') // Strip code ticks
    .replace(/\\%/g, '%')
    .replace(/\{\}/g, '')
    .replace(/\\([#&{}])/g, '$1'); // Unescape escaped special characters (keep underscore for fill-in blanks!)

  // Newline sanitization: preserve structured line breaks for descriptions/tables, collapse for choices/titles
  if (options?.preserveNewlines) {
    cleaned = cleaned
      .replace(/\\n/g, '\n')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .map((l) => l.replace(/[^\S\r\n]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } else {
    cleaned = cleaned
      .replace(/\\n/g, ' ')
      .replace(/[\r\n\t]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  return cleaned;
}

/**
 * Resolves all correct option indices for an MCQ or Multiple Select question.
 */
export function resolveAllMcqCorrectIndices(question: Question, subIndex?: number): number[] {
  const options = (subIndex !== undefined && question.sub_questions?.[subIndex]?.options)
    ? question.sub_questions[subIndex].options
    : question.options;

  if (!options || options.length === 0) return [];

  const foundIndices = new Set<number>();

  // 1. Direct array properties (e.g. correct_options: [0, 2])
  const directArr = (question as any).correct_options || (question as any).correctOptions || (question as any).correct_answers || (question as any).correctAnswers;
  if (Array.isArray(directArr)) {
    for (const item of directArr) {
      if (typeof item === 'number' && item >= 0 && item < options.length) {
        foundIndices.add(item);
      } else if (typeof item === 'string') {
        const clean = item.trim().toUpperCase();
        if (clean.length === 1 && clean >= 'A' && clean <= 'Z') {
          const idx = clean.charCodeAt(0) - 65;
          if (idx < options.length) foundIndices.add(idx);
        }
      }
    }
    if (foundIndices.size > 0) return Array.from(foundIndices).sort((a, b) => a - b);
  }

  // 2. Mark scheme acceptable_answers array (especially for Multiple Select)
  const sq = subIndex !== undefined ? question.sub_questions?.[subIndex] : undefined;
  const ms = sq?.mark_scheme || question.mark_scheme;
  if (ms && typeof ms === 'object' && Array.isArray((ms as any).acceptable_answers)) {
    for (const ans of (ms as any).acceptable_answers) {
      if (typeof ans === 'string') {
        const clean = ans.trim().toUpperCase();
        if (clean.length === 1 && clean >= 'A' && clean <= 'Z') {
          const idx = clean.charCodeAt(0) - 65;
          if (idx < options.length) foundIndices.add(idx);
        } else {
          // Compare against option text
          const cleanAns = cleanTextForGoogleForms(ans);
          options.forEach((opt, optIdx) => {
            if (cleanTextForGoogleForms(opt).toLowerCase() === cleanAns.toLowerCase()) {
              foundIndices.add(optIdx);
            }
          });
        }
      }
    }
    if (foundIndices.size > 0) return Array.from(foundIndices).sort((a, b) => a - b);
  }

  // 3. Fallback to standard resolver
  const singleIdx = resolveMcqCorrectOptionIndex(question, subIndex);
  if (singleIdx >= 0 && singleIdx < options.length) {
    return [singleIdx];
  }

  return [];
}

// ─── Plaintext & Table Formatter for Google Forms ─────────────────────────────

export function renderUnicodeTable(rows: string[][]): string {
  if (!rows || rows.length === 0) return '';
  const headers = rows[0] || [];
  const bodyRows = rows.slice(1);
  return formatTableToCleanText({
    headers,
    rows: bodyRows.length > 0 ? bodyRows : [headers],
  });
}

export function renderDataTablesToUnicode(tables?: ExamDataTable[]): string {
  if (!tables || tables.length === 0) return '';
  const result: string[] = [];
  for (const table of tables) {
    const rows: string[][] = [];
    if (table.headers && table.headers.length > 0) {
      rows.push(
        table.headers.map((h) => cleanTextForGoogleForms(String(h || ''), { preserveNewlines: false }))
      );
    }
    if (table.rows && table.rows.length > 0) {
      for (const row of table.rows) {
        rows.push(
          row.map((cell) =>
            typeof cell === 'string'
              ? cleanTextForGoogleForms(cell, { preserveNewlines: false })
              : cleanTextForGoogleForms(cell.is_blank ? '[   ]' : (cell.value || ''), { preserveNewlines: false })
          )
        );
      }
    }
    const rendered = renderUnicodeTable(rows);
    if (rendered) {
      const title = table.title ? `[ ${cleanTextForGoogleForms(table.title, { preserveNewlines: false })} ]\n` : '';
      result.push(title + rendered);
    }
  }
  return result.join('\n\n');
}

export function formatMarkdownTablesForPlaintext(
  rawText: string,
  dataTables?: ExamDataTable[],
  options?: { hasImageTable?: boolean }
): string {
  if (!rawText) {
    if (options?.hasImageTable) return '';
    return renderDataTablesToUnicode(dataTables);
  }

  let text = rawText.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  if (/\|[-:\s|]{3,}\|/.test(text)) {
    const extracted = extractMarkdownTable(text);
    if (extracted.table) {
      if (options?.hasImageTable) {
        // Table is visually rendered as an image figure! Strip the raw markdown table from question stem
        const parts = [extracted.preText, extracted.postText].filter(Boolean);
        text = parts.join('\n\n');
      } else {
        // Clean text fallback: structured card bullets without jagged box lines
        const rendered = formatTableToCleanText(extracted.table);
        const parts = [extracted.preText, rendered, extracted.postText].filter(Boolean);
        text = parts.join('\n\n');
      }
    }
  } else if (dataTables && dataTables.length > 0 && !options?.hasImageTable) {
    const rendered = renderDataTablesToUnicode(dataTables);
    if (rendered) {
      text = text ? `${text}\n\n${rendered}` : rendered;
    }
  }

  return text;
}

export function splitQuestionPromptAndDetails(
  fullQNum: string,
  formattedText: string
): { title: string; description?: string } {
  const clean = formattedText.trim();
  const paragraphs = clean.split('\n\n').map((p) => p.trim()).filter(Boolean);

  if (paragraphs.length > 1) {
    return {
      title: cleanTextForGoogleForms(`${fullQNum} ${paragraphs[0]}`, { preserveNewlines: false }),
      description: cleanTextForGoogleForms(paragraphs.slice(1).join('\n\n'), { preserveNewlines: true }),
    };
  }

  return {
    title: cleanTextForGoogleForms(`${fullQNum} ${clean}`, { preserveNewlines: false }),
    description: undefined,
  };
}

/**
 * Naturally sorts questions if question numbers are muddled alphabetically.
 */
export function getOrderedQuestions(questions: Question[]): Question[] {
  const ordered = [...questions];
  const isAlphabeticallyMuddled = ordered.some((q, idx) => {
    if (idx > 0 && q.question_number && ordered[idx - 1].question_number) {
      const prevNum = parseInt(String(ordered[idx - 1].question_number), 10);
      const currNum = parseInt(String(q.question_number), 10);
      return prevNum === 1 && currNum === 10;
    }
    return false;
  });

  if (isAlphabeticallyMuddled) {
    ordered.sort((a, b) => compareQuestionNumbers(a.question_number, b.question_number));
  }
  return ordered;
}

export function getQuestionKey(q: Question, qIndex: number): string {
  return q.id || `${qIndex}`;
}

export function getSubQuestionKey(q: Question, parentIndex: number, subIndex: number): string {
  const pKey = q.id || `${parentIndex}`;
  return `${pKey}_sub_${subIndex}`;
}

/**
 * Flattens test questions and nested Cambridge sub-questions into a linear list of Google Forms items.
 * Guarantees natural question ordering, sequential numbering, deduplication, and table formatting.
 */
export function flattenQuestionsForForms(
  questions: Question[],
  imageBase64Map?: Record<string, string>,
  imageUrlMap?: Record<string, string>
): FormFlattenedItem[] {
  const items: FormFlattenedItem[] = [];
  const orderedQuestions = getOrderedQuestions(questions);

  orderedQuestions.forEach((q, qIndex) => {
    const testQNum = qIndex + 1;
    const fullQNum = `Q${testQNum}`;

    if (q.sub_questions && q.sub_questions.length > 0) {
      // Cambridge Structured / Multi-part Question
      const parentQKey = getQuestionKey(q, qIndex);
      const parentExtractedTable = extractMarkdownTable(q.question_text || '').table || extractStructuredTable(q.data_tables);
      const parentHasImage = Boolean(
        parentExtractedTable ||
        imageUrlMap?.[parentQKey] ||
        imageBase64Map?.[parentQKey]
      );

      let rawParentStem = stripDuplicateOptionsFromStem(q.question_text || '', q.options);
      rawParentStem = stripDuplicateSubQuestionsFromStem(rawParentStem, q.sub_questions);
      rawParentStem = rawParentStem.replace(/^\s*(?:Question\s*|Q\s*)?\d+[\.\)\:\-]\s*/i, '').trim();

      const formattedParentStem = formatMarkdownTablesForPlaintext(rawParentStem, q.data_tables, { hasImageTable: parentHasImage });
      const stemContext = cleanTextForGoogleForms(formattedParentStem, { preserveNewlines: true });
      const isInformativeStem = stemContext.length > 0 && !/^question\s*\d+$/i.test(stemContext);

      q.sub_questions.forEach((sq: SubQuestion, subIdx: number) => {
        const rawSubId = (sq.sub_id || '').trim();
        const subIdStr = rawSubId
          ? (rawSubId.startsWith('(') ? rawSubId : `(${rawSubId})`)
          : `(${String.fromCharCode(97 + subIdx)})`;

        const fullSubQNum = `${fullQNum}${subIdStr}`;
        const qSubKey = getSubQuestionKey(q, qIndex, subIdx);

        // Ensure table image is detected or generated on-the-fly
        const subExtractedTable = extractMarkdownTable(sq.question_text || '').table || extractStructuredTable((sq as any).data_tables);
        let subFallbackTablePng: string | null = null;
        if (subExtractedTable && !imageUrlMap?.[qSubKey] && !imageBase64Map?.[qSubKey]) {
          try {
            subFallbackTablePng = renderTableToPngDataUrl(subExtractedTable);
          } catch {}
        }

        const subHasImage = Boolean(
          subExtractedTable ||
          imageUrlMap?.[qSubKey] ||
          imageBase64Map?.[qSubKey] ||
          subFallbackTablePng ||
          (subIdx === 0 && parentHasImage)
        );

        let rawSubText = stripDuplicateOptionsFromStem(sq.question_text || '', (sq as any).options || q.options);
        rawSubText = rawSubText.replace(/^\s*(?:Question\s*|Q\s*)?(?:\d+[\.\)\:\-]?\s*)?(?:\([a-z0-9]+\)|[a-z0-9]+[\.\)])\s*/i, '').trim();

        const formattedSubText = formatMarkdownTablesForPlaintext(rawSubText, (sq as any).data_tables, { hasImageTable: subHasImage });
        const { title: itemTitle, description: subDesc } = splitQuestionPromptAndDetails(fullSubQNum, formattedSubText);

        const pointValue = Math.max(1, Math.round(Number(sq.marks) || 1));
        const hasOptions = Array.isArray(sq.options) && sq.options.length > 0;
        const isMultipleSelect = q.question_style === 'Multiple Select';
        const itemType = hasOptions ? (isMultipleSelect ? 'CHECKBOX' : 'RADIO') : 'PARAGRAPH';

        let cleanedOptions: string[] | undefined;
        let correctOptionIndices: number[] | undefined;
        let correctAnswers: string[] | undefined;

        if (hasOptions && sq.options) {
          cleanedOptions = sq.options.map((opt) => cleanTextForGoogleForms(opt, { preserveNewlines: false }));
          const resolvedIndices = resolveAllMcqCorrectIndices(q, subIdx);
          if (resolvedIndices.length > 0) {
            correctOptionIndices = resolvedIndices;
            correctAnswers = resolvedIndices.map((idx) => cleanedOptions![idx]).filter(Boolean);
          }
        }

        // Feedback / Mark Scheme
        const feedback = sq.mark_scheme ? cleanTextForGoogleForms(sq.mark_scheme, { preserveNewlines: true }) : undefined;

        // Image resolving
        const rawDiagram = (sq as any).diagram_url || (sq as any).image_url || (sq as any).diagram_base64 ||
          (subIdx === 0 ? (q.diagram_url || (q as any).image_url || (q as any).diagram_base64) : null);

        const base64FromMap = imageBase64Map
          ? (imageBase64Map[qSubKey] || (subIdx === 0 ? imageBase64Map[parentQKey] : null) || (rawDiagram ? imageBase64Map[rawDiagram] : null))
          : null;
        const isDirectBase64 = typeof rawDiagram === 'string' && rawDiagram.startsWith('data:image/');
        const imageBase64 = base64FromMap || subFallbackTablePng || (isDirectBase64 ? rawDiagram : null);

        const urlFromMap = imageUrlMap
          ? (imageUrlMap[qSubKey] || (subIdx === 0 ? imageUrlMap[parentQKey] : null) || (rawDiagram ? imageUrlMap[rawDiagram] : null))
          : null;
        const imageUrl = urlFromMap || ((!isDirectBase64 && typeof rawDiagram === 'string' && rawDiagram.startsWith('http')) ? rawDiagram : null);

        const combinedDescription = [
          isInformativeStem ? `Context: ${stemContext}` : '',
          subDesc,
        ].filter(Boolean).join('\n\n') || undefined;

        items.push({
          id: qSubKey,
          title: itemTitle,
          description: combinedDescription,
          pointValue,
          type: itemType,
          options: cleanedOptions,
          correctOptionIndices,
          correctAnswers,
          feedbackRight: 'Correct!',
          feedbackWrong: feedback ? `Mark Scheme: ${feedback}` : undefined,
          imageUrl,
          imageBase64,
          altText: `Diagram for ${fullSubQNum}`,
        });
      });
    } else {
      // Standalone Question
      const qKey = getQuestionKey(q, qIndex);
      const rawDiagram = q.diagram_url || (q as any).image_url || (q as any).diagram_base64;

      // Ensure table image is detected or generated on-the-fly
      const extractedTable = extractMarkdownTable(q.question_text || '').table || extractStructuredTable(q.data_tables);
      let fallbackTablePng: string | null = null;
      if (extractedTable && !imageUrlMap?.[qKey] && !imageBase64Map?.[qKey]) {
        try {
          fallbackTablePng = renderTableToPngDataUrl(extractedTable);
        } catch {}
      }

      const hasTable = Boolean(extractedTable);
      const hasImageTable = Boolean(
        hasTable ||
        imageUrlMap?.[qKey] ||
        imageBase64Map?.[qKey] ||
        fallbackTablePng ||
        (rawDiagram && (imageUrlMap?.[rawDiagram] || imageBase64Map?.[rawDiagram]))
      );

      let rawStem = stripDuplicateOptionsFromStem(q.question_text || '', q.options);
      rawStem = stripDuplicateSubQuestionsFromStem(rawStem, q.sub_questions);
      rawStem = rawStem.replace(/^\s*(?:Question\s*|Q\s*)?\d+[\.\)\:\-]\s*/i, '').trim();

      const formattedStem = formatMarkdownTablesForPlaintext(rawStem, q.data_tables, { hasImageTable });
      const { title: itemTitle, description: itemDescription } = splitQuestionPromptAndDetails(fullQNum, formattedStem);

      const pointValue = Math.max(1, Math.round(Number(q.marks) || 1));
      const hasOptions = Array.isArray(q.options) && q.options.length > 0;
      const isMultipleSelect = q.question_style === 'Multiple Select';
      const itemType = hasOptions ? (isMultipleSelect ? 'CHECKBOX' : 'RADIO') : 'PARAGRAPH';

      let cleanedOptions: string[] | undefined;
      let correctOptionIndices: number[] | undefined;
      let correctAnswers: string[] | undefined;

      if (hasOptions && q.options) {
        cleanedOptions = q.options.map((opt) => cleanTextForGoogleForms(opt, { preserveNewlines: false }));
        const resolvedIndices = resolveAllMcqCorrectIndices(q);
        if (resolvedIndices.length > 0) {
          correctOptionIndices = resolvedIndices;
          correctAnswers = resolvedIndices.map((idx) => cleanedOptions![idx]).filter(Boolean);
        }
      }

      // Feedback / Mark Scheme
      let feedback = '';
      if (q.mark_scheme) {
        if (q.mark_scheme.marking_points && q.mark_scheme.marking_points.length > 0) {
          feedback = q.mark_scheme.marking_points.map((p) => cleanTextForGoogleForms(p, { preserveNewlines: true })).join('; ');
        } else if (q.mark_scheme.acceptable_answers && q.mark_scheme.acceptable_answers.length > 0) {
          feedback = q.mark_scheme.acceptable_answers.map((a) => cleanTextForGoogleForms(a, { preserveNewlines: true })).join('; ');
        }
      }

      const base64FromMap = imageBase64Map ? (imageBase64Map[qKey] || (rawDiagram ? imageBase64Map[rawDiagram] : null)) : null;
      const isDirectBase64 = typeof rawDiagram === 'string' && rawDiagram.startsWith('data:image/');
      const imageBase64 = base64FromMap || fallbackTablePng || (isDirectBase64 ? rawDiagram : null);

      const urlFromMap = imageUrlMap ? (imageUrlMap[qKey] || (rawDiagram ? imageUrlMap[rawDiagram] : null)) : null;
      const imageUrl = urlFromMap || ((!isDirectBase64 && typeof rawDiagram === 'string' && rawDiagram.startsWith('http')) ? rawDiagram : null);

      items.push({
        id: qKey,
        title: itemTitle,
        description: itemDescription,
        pointValue,
        type: itemType,
        options: cleanedOptions,
        correctOptionIndices,
        correctAnswers,
        feedbackRight: 'Correct!',
        feedbackWrong: feedback ? `Mark Scheme: ${feedback}` : undefined,
        imageUrl,
        imageBase64,
        altText: `Diagram for ${fullQNum}`,
      });
    }
  });

  return items;
}

/**
 * Robust fetch wrapper with exponential backoff for handling rate limits (429) and transient errors (503).
 */
async function fetchWithRetry(url: string, options: RequestInit, retries = 2, delayMs = 800): Promise<Response> {
  let lastError: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if ((res.status === 429 || res.status === 503) && attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
      }
    }
  }
  throw lastError || new Error(`Network request failed: ${url}`);
}

/**
 * Requests a Google OAuth access token specifically with scope https://www.googleapis.com/auth/forms.body.
 */
export async function requestGoogleFormsToken(clientId: string): Promise<string> {
  await loadGsiScript();

  if (!(window as any).google?.accounts?.oauth2) {
    throw new Error('Google Identity Services SDK is not available. Please check your internet connection.');
  }

  return new Promise((resolve, reject) => {
    try {
      const tokenClient = (window as any).google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: FORMS_BODY_SCOPE,
        callback: (resp: any) => {
          if (resp.access_token) {
            resolve(resp.access_token);
          } else {
            const errMsg = typeof resp.error === 'string'
              ? resp.error
              : (resp.error?.message || resp.error_description || 'Google Forms authorization was cancelled or denied.');
            reject(new Error(errMsg));
          }
        },
        error_callback: (err: any) => {
          const errMsg = typeof err === 'string'
            ? err
            : (err?.message || 'Google Forms authentication popup was closed or encountered an error.');
          reject(new Error(errMsg));
        },
      });

      tokenClient.requestAccessToken({ prompt: 'consent' });
    } catch (err: any) {
      reject(new Error(err?.message || 'Failed to initialize Google login popup.'));
    }
  });
}

/**
 * Creates an auto-graded Google Forms Quiz via Google Forms REST API v1.
 * Supports chunked batchUpdate requests for large tests to avoid quota limits.
 */
export async function createGoogleFormQuiz(
  headerConfig: ExamHeaderConfig,
  questions: Question[],
  clientId: string,
  onProgress?: (progress: GoogleFormsProgress) => void,
  imageBase64Map?: Record<string, string>,
  imageUrlMap?: Record<string, string>
): Promise<GoogleFormResult> {
  // 1. Authorize
  onProgress?.({
    stage: 'auth',
    message: 'Authenticating with Google...',
  });

  const accessToken = await requestGoogleFormsToken(clientId);

  // 2. Prepare Form Metadata
  const cleanTitle = cleanTextForGoogleForms(headerConfig.title || 'TestMaker Assessment Quiz', { preserveNewlines: false }) || 'Assessment Quiz';
  const cleanInstructions = cleanTextForGoogleForms(
    [
      headerConfig.schoolName,
      headerConfig.subject ? `Subject: ${headerConfig.subject}` : '',
      headerConfig.durationMinutes ? `Duration: ${headerConfig.durationMinutes} Minutes` : '',
      headerConfig.instructions,
    ]
      .filter(Boolean)
      .join(' | '),
    { preserveNewlines: true }
  );

  onProgress?.({
    stage: 'creating',
    message: 'Creating Google Form in Google Drive...',
  });

  // 3. POST /v1/forms to create blank form
  const createRes = await fetchWithRetry('https://forms.googleapis.com/v1/forms', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      info: {
        title: cleanTitle,
        documentTitle: cleanTitle,
      },
    }),
  });

  if (!createRes.ok) {
    const errJson = await createRes.json().catch(() => ({}));
    const errMsg = errJson.error?.message || `HTTP ${createRes.status} ${createRes.statusText}`;

    if (createRes.status === 403 && (errMsg.includes('forms.googleapis.com') || errMsg.includes('disabled') || errMsg.includes('has not been used'))) {
      throw new Error(`Google Forms API is not enabled on your Google Cloud Project. Please enable it at: ${FORMS_API_CONSOLE_URL}`);
    }
    if (errMsg.includes('insufficient') || errMsg.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
      throw new Error(`Google OAuth scope permission denied. Please ensure your OAuth Client ID allows 'https://www.googleapis.com/auth/forms.body'.`);
    }
    throw new Error(`Failed to create Google Form: ${errMsg}`);
  }

  const formJson = await createRes.json();
  const formId: string = formJson.formId;
  const responderUrl: string = formJson.responderUri || `https://docs.google.com/forms/d/e/${formId}/viewform`;
  const editUrl = `https://docs.google.com/forms/d/${formId}/edit`;

  // 4. Flatten items
  const flattenedItems = flattenQuestionsForForms(questions, imageBase64Map, imageUrlMap);
  const totalItems = flattenedItems.length;

  // 5. Build batchUpdate requests
  const createRequests: any[] = flattenedItems.map((item, idx) => {
    const questionItem: any = {
      question: {
        required: false,
        grading: {
          pointValue: item.pointValue,
        },
      },
    };

    if (item.imageUrl) {
      let finalUri = item.imageUrl;
      // Google Forms API strictly requires JPEG, PNG, or GIF.
      // If the image is hosted on our media worker and ends with .webp,
      // rewrite to .png so Cloudflare Worker transcodes it on-the-fly to PNG.
      if (finalUri.includes('testmaker-media.icmadani.workers.dev') && finalUri.endsWith('.webp')) {
        finalUri = finalUri.replace(/\.webp$/i, '.png');
      }
      questionItem.image = {
        sourceUri: encodeURI(finalUri),
        altText: item.altText || 'Diagram',
      };
    }

    if (item.type === 'RADIO' || item.type === 'CHECKBOX') {
      questionItem.question.choiceQuestion = {
        type: item.type,
        options: (item.options || []).map((opt) => ({ value: opt })),
      };

      if (item.correctAnswers && item.correctAnswers.length > 0) {
        questionItem.question.grading.correctAnswers = {
          answers: item.correctAnswers.map((ans) => ({ value: ans })),
        };
      }

      if (item.feedbackRight) {
        questionItem.question.grading.whenRight = { text: item.feedbackRight };
      }
      if (item.feedbackWrong) {
        questionItem.question.grading.whenWrong = { text: item.feedbackWrong };
      }
    } else {
      // Paragraph question: use generalFeedback instead of whenWrong
      questionItem.question.textQuestion = {
        paragraph: true,
      };
      if (item.feedbackWrong) {
        questionItem.question.grading.generalFeedback = { text: item.feedbackWrong };
      }
    }

    return {
      createItem: {
        item: {
          title: item.title,
          description: item.description || undefined,
          questionItem,
        },
        location: {
          index: idx,
        },
      },
    };
  });

  // Setup requests: enable Quiz mode and update description
  const initialSettingsRequests: any[] = [
    {
      updateSettings: {
        settings: {
          quizSettings: {
            isQuiz: true,
          },
        },
        updateMask: 'quizSettings.isQuiz',
      },
    },
  ];

  if (cleanInstructions) {
    initialSettingsRequests.push({
      updateFormInfo: {
        info: {
          description: cleanInstructions,
        },
        updateMask: 'description',
      },
    });
  }

  // 6. Send in batches of 20 items to respect rate and payload limits
  const CHUNK_SIZE = 20;
  const chunks: any[][] = [];

  // First chunk includes settings + first batch of questions
  const firstBatchQuestions = createRequests.slice(0, CHUNK_SIZE);
  chunks.push([...initialSettingsRequests, ...firstBatchQuestions]);

  for (let i = CHUNK_SIZE; i < createRequests.length; i += CHUNK_SIZE) {
    chunks.push(createRequests.slice(i, i + CHUNK_SIZE));
  }

  const totalChunks = chunks.length;
  let completedItems = 0;

  for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
    onProgress?.({
      stage: 'populating',
      currentChunk: chunkIdx + 1,
      totalChunks,
      completedItems,
      totalItems,
      message: `Adding questions (${completedItems}/${totalItems})...`,
    });

    let currentRequests = chunks[chunkIdx];
    let batchRes = await fetchWithRetry(`https://forms.googleapis.com/v1/forms/${formId}:batchUpdate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        requests: currentRequests,
      }),
    });

    if (!batchRes.ok) {
      const errJson = await batchRes.json().catch(() => ({}));
      const errMsg = errJson.error?.message || `HTTP ${batchRes.status} ${batchRes.statusText}`;

      // Resilient fallback: If an image fails to fetch from sourceUri,
      // convert failing image items to formatted diagram link notes so quiz creation still succeeds
      if (errMsg.includes('Failed to fetch image from source_uri')) {
        console.warn(
          `[GoogleFormsExport] Batch ${chunkIdx + 1} image fetch failed (${errMsg}). Retrying without embedding raw image...`
        );
        const fallbackRequests = currentRequests.map((req: any) => {
          if (req.createItem?.item?.questionItem?.image) {
            const failedImg = req.createItem.item.questionItem.image;
            const updatedReq = JSON.parse(JSON.stringify(req));
            delete updatedReq.createItem.item.questionItem.image;
            const linkNotice = `\n\n[Diagram: ${failedImg.sourceUri}]`;
            updatedReq.createItem.item.description = (updatedReq.createItem.item.description || '') + linkNotice;
            return updatedReq;
          }
          return req;
        });

        const retryRes = await fetchWithRetry(`https://forms.googleapis.com/v1/forms/${formId}:batchUpdate`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            requests: fallbackRequests,
          }),
        });

        if (!retryRes.ok) {
          const retryErrJson = await retryRes.json().catch(() => ({}));
          const retryErrMsg = retryErrJson.error?.message || `HTTP ${retryRes.status} ${retryRes.statusText}`;
          throw new Error(`Failed adding questions to Google Form (batch ${chunkIdx + 1}): ${retryErrMsg}`);
        }
        batchRes = retryRes;
      } else {
        throw new Error(`Failed adding questions to Google Form (batch ${chunkIdx + 1}): ${errMsg}`);
      }
    }

    const itemsInThisChunk = chunkIdx === 0 ? firstBatchQuestions.length : chunks[chunkIdx].length;
    completedItems += itemsInThisChunk;

    // Polite delay between chunks for rate-limit protection
    if (chunkIdx < totalChunks - 1) {
      await new Promise((r) => setTimeout(r, 350));
    }
  }

  const totalMarks = flattenedItems.reduce((acc, it) => acc + it.pointValue, 0);
  const mcqCount = flattenedItems.filter((it) => it.type === 'RADIO' || it.type === 'CHECKBOX').length;

  onProgress?.({
    stage: 'done',
    completedItems: totalItems,
    totalItems,
    message: 'Quiz created successfully!',
  });

  return {
    formId,
    editUrl,
    responderUrl,
    title: cleanTitle,
    totalQuestions: totalItems,
    totalMarks,
    mcqCount,
  };
}

/**
 * Generates ready-to-run Google Apps Script code for zero-setup quiz creation.
 * Bypasses school IT restrictions and OAuth token setup.
 */
export function generateGoogleAppsScript(
  headerConfig: ExamHeaderConfig,
  questions: Question[],
  imageBase64Map?: Record<string, string>,
  imageUrlMap?: Record<string, string>
): string {
  const flattened = flattenQuestionsForForms(questions, imageBase64Map, imageUrlMap);
  const cleanTitle = cleanTextForGoogleForms(headerConfig.title || 'TestMaker Assessment Quiz', { preserveNewlines: false }) || 'Assessment Quiz';
  const cleanInstructions = cleanTextForGoogleForms(
    [
      headerConfig.schoolName,
      headerConfig.subject ? `Subject: ${headerConfig.subject}` : '',
      headerConfig.durationMinutes ? `Duration: ${headerConfig.durationMinutes} Minutes` : '',
      headerConfig.instructions,
    ]
      .filter(Boolean)
      .join(' | '),
    { preserveNewlines: true }
  );

  const lines: string[] = [
    '/**',
    ' * =========================================================================',
    ' * TestMaker — Google Forms Quiz Generator (Google Apps Script)',
    ' * =========================================================================',
    ' * INSTRUCTIONS:',
    ' * 1. Open https://script.new in your browser.',
    ' * 2. Delete any boilerplate code, paste this entire script, and click "Run" (▶).',
    ' * 3. Authorize Google permissions when prompted.',
    ' * 4. Check the Execution Log below for your Google Form Edit & Student Quiz URLs!',
    ' * =========================================================================',
    ' */',
    '',
    'function createTestMakerQuiz() {',
    `  var formTitle = ${JSON.stringify(cleanTitle)};`,
    `  var formDescription = ${JSON.stringify(cleanInstructions)};`,
    '',
    '  Logger.log("Creating Google Form: " + formTitle);',
    '  var form = FormApp.create(formTitle);',
    '  form.setIsQuiz(true);',
    '  if (formDescription) {',
    '    form.setDescription(formDescription);',
    '  }',
    '',
  ];

  flattened.forEach((item, idx) => {
    const varName = `q${idx + 1}`;
    lines.push(`  // Item ${idx + 1}: ${item.title.slice(0, 40)}...`);

    // Add image if present (diagram or table figure)
    if (item.imageUrl || item.imageBase64) {
      lines.push('  try {');
      if (item.imageUrl) {
        // Preferred: Clean, CDN-streamed PNG from Cloudflare R2 / media worker
        // Avoids giant base64 strings in Google Apps Script editor which exceed V8 limits
        lines.push(`    var imgBlob_${idx + 1} = getSafeDiagramBlob(${JSON.stringify(item.imageUrl)});`);
      } else if (item.imageBase64) {
        // Fallback: Embed base64 image data directly (chunked into 32KB parts to prevent V8 string literal limits)
        const rawB64 = item.imageBase64.includes(',') ? item.imageBase64.split(',')[1] : item.imageBase64;
        const CHUNK_SIZE = 32768;
        if (rawB64.length > CHUNK_SIZE) {
          const chunks: string[] = [];
          for (let i = 0; i < rawB64.length; i += CHUNK_SIZE) {
            chunks.push(JSON.stringify(rawB64.slice(i, i + CHUNK_SIZE)));
          }
          lines.push(`    var b64_${idx + 1} = [${chunks.join(', ')}].join('');`);
          lines.push(`    var imgBlob_${idx + 1} = Utilities.newBlob(Utilities.base64Decode(b64_${idx + 1}), "image/png", ${JSON.stringify(`diagram_${idx + 1}.png`)});`);
        } else {
          lines.push(`    var imgBlob_${idx + 1} = Utilities.newBlob(Utilities.base64Decode(${JSON.stringify(rawB64)}), "image/png", ${JSON.stringify(`diagram_${idx + 1}.png`)});`);
        }
      }
      lines.push(`    if (imgBlob_${idx + 1}) {`);
      lines.push(`      var imgItem_${idx + 1} = form.addImageItem();`);
      lines.push('      try {');
      lines.push(`        imgItem_${idx + 1}.setImage(imgBlob_${idx + 1});`);
      lines.push(`        imgItem_${idx + 1}.setTitle(${JSON.stringify(`Diagram for ${item.title.slice(0, 35)}`)});`);
      lines.push('      } catch (setErr) {');
      lines.push(`        form.deleteItem(imgItem_${idx + 1}); // Prevent empty phantom item`);
      lines.push(`        Logger.log("Could not set diagram for Item ${idx + 1}: " + setErr.message);`);
      lines.push('      }');
      lines.push('    }');
      lines.push('  } catch (imgErr) {');
      lines.push(`    Logger.log("Could not attach diagram for Item ${idx + 1}: " + imgErr.message);`);
      lines.push('  }');
    }

    if (item.type === 'RADIO' && item.options && item.options.length > 0) {
      lines.push(`  var ${varName} = form.addMultipleChoiceItem();`);
      lines.push(`  ${varName}.setTitle(${JSON.stringify(item.title)});`);
      if (item.description) {
        lines.push(`  ${varName}.setHelpText(${JSON.stringify(item.description)});`);
      }
      lines.push(`  ${varName}.setPoints(${item.pointValue});`);

      const choicesCode = item.options.map((opt, optIdx) => {
        const isCorrect = item.correctOptionIndices?.includes(optIdx) || false;
        return `    ${varName}.createChoice(${JSON.stringify(opt)}, ${isCorrect ? 'true' : 'false'})`;
      }).join(',\n');

      lines.push(`  ${varName}.setChoices([\n${choicesCode}\n  ]);`);

      if (item.feedbackWrong) {
        lines.push(`  ${varName}.setFeedbackForIncorrect(FormApp.createFeedback().setText(${JSON.stringify(item.feedbackWrong)}).build());`);
      }
      lines.push(`  ${varName}.setFeedbackForCorrect(FormApp.createFeedback().setText("Correct!").build());`);
    } else if (item.type === 'CHECKBOX' && item.options && item.options.length > 0) {
      lines.push(`  var ${varName} = form.addCheckboxItem();`);
      lines.push(`  ${varName}.setTitle(${JSON.stringify(item.title)});`);
      if (item.description) {
        lines.push(`  ${varName}.setHelpText(${JSON.stringify(item.description)});`);
      }
      lines.push(`  ${varName}.setPoints(${item.pointValue});`);

      const choicesCode = item.options.map((opt, optIdx) => {
        const isCorrect = item.correctOptionIndices?.includes(optIdx) || false;
        return `    ${varName}.createChoice(${JSON.stringify(opt)}, ${isCorrect ? 'true' : 'false'})`;
      }).join(',\n');

      lines.push(`  ${varName}.setChoices([\n${choicesCode}\n  ]);`);
    } else {
      // Paragraph / Open-Ended
      lines.push(`  var ${varName} = form.addParagraphTextItem();`);
      lines.push(`  ${varName}.setTitle(${JSON.stringify(item.title)});`);
      const helpText = [
        item.description,
        item.feedbackWrong ? `Mark Scheme: ${item.feedbackWrong}` : '',
      ].filter(Boolean).join('\n\n');

      if (helpText) {
        lines.push(`  ${varName}.setHelpText(${JSON.stringify(helpText)});`);
      }
      lines.push(`  ${varName}.setPoints(${item.pointValue});`);
    }

    lines.push('');
  });

  lines.push('  var editUrl = form.getEditUrl();');
  lines.push('  var publishedUrl = form.getPublishedUrl();');
  lines.push('');
  lines.push('  Logger.log("=================================================");');
  lines.push('  Logger.log("🎉 GOOGLE FORM CREATED SUCCESSFULLY!");');
  lines.push('  Logger.log("✏️ Teacher Edit URL: " + editUrl);');
  lines.push('  Logger.log("📋 Student Quiz URL: " + publishedUrl);');
  lines.push('  Logger.log("=================================================");');
  lines.push('}');
  lines.push('');
  lines.push('/**');
  lines.push(' * Fetches diagram safely with WebP to PNG conversion via Google Drive');
  lines.push(' */');
  lines.push('function getSafeDiagramBlob(url) {');
  lines.push('  if (!url) return null;');
  lines.push('  try {');
  lines.push('    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });');
  lines.push('    if (res.getResponseCode() !== 200) return null;');
  lines.push('    var blob = res.getBlob();');
  lines.push('    var ct = (blob.getContentType() || "").toLowerCase();');
  lines.push('    if (ct.indexOf("png") !== -1 || ct.indexOf("jpeg") !== -1 || ct.indexOf("jpg") !== -1 || ct.indexOf("gif") !== -1) {');
  lines.push('      return blob;');
  lines.push('    }');
  lines.push('    // WebP or other format: attempt Drive thumbnail conversion');
  lines.push('    try {');
  lines.push('      var tempFile = DriveApp.createFile(blob);');
  lines.push('      var fileId = tempFile.getId();');
  lines.push('      var thumbUrl = "https://drive.google.com/thumbnail?id=" + fileId + "&sz=w1200";');
  lines.push('      var conv = UrlFetchApp.fetch(thumbUrl, {');
  lines.push('        headers: { authorization: "Bearer " + ScriptApp.getOAuthToken() },');
  lines.push('        muteHttpExceptions: true');
  lines.push('      });');
  lines.push('      tempFile.setTrashed(true);');
  lines.push('      if (conv.getResponseCode() === 200) {');
  lines.push('        var pngBlob = conv.getBlob();');
  lines.push('        pngBlob.setContentType("image/png");');
  lines.push('        return pngBlob;');
  lines.push('      }');
  lines.push('    } catch (driveErr) {');
  lines.push('      Logger.log("Drive conversion note: " + driveErr.message);');
  lines.push('    }');
  lines.push('    return blob;');
  lines.push('  } catch (err) {');
  lines.push('    Logger.log("UrlFetchApp fetch error: " + err.message);');
  lines.push('    return null;');
  lines.push('  }');
  lines.push('}');

  return lines.join('\n');
}
