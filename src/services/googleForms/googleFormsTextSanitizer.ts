// ─── Google Forms Text & Table Sanitizer ──────────────────────────────────────
// Converts complex LaTeX, Markdown, HTML, and math expressions into clean Unicode plain text.
// Sanitizes newlines, fractions, subscripts, and symbols for Google Forms API & Apps Script compatibility.

import type { ExamDataTable } from '../../types/database';
import type { ExamHeaderConfig } from '../testBuilderService';
import { extractMarkdownTable, formatTableToCleanText } from '../../lib/tableImageRenderer';

// ─── Unicode Superscript & Subscript Maps ────────────────────────────────────

export const SUPERSCRIPT_MAP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  'n': 'ⁿ', 'i': 'ⁱ', 'x': 'ˣ',
};

export const SUBSCRIPT_MAP: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  'a': 'ₐ', 'e': 'ₑ', 'o': 'ₒ', 'x': 'ₓ', 'h': 'ₕ',
  'k': 'ₖ', 'l': 'ₗ', 'm': 'ₘ', 'n': 'ₙ', 'p': 'ₚ',
  's': 'ₛ', 't': 'ₜ', 'r': 'ᵣ', 'i': 'ᵢ', 'j': 'ⱼ',
  'u': 'ᵤ', 'v': 'ᵥ',
};

export function toUnicodeSuperscript(str: string): string {
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

export function toUnicodeSubscript(str: string): string {
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
    .replace(/\\([#&{}])/g, '$1'); // Unescape escaped special characters

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

// ─── Shared Form Metadata Preparation (Issue #7 & #20) ───────────────────────

export function formatFormMetadata(headerConfig: ExamHeaderConfig): { title: string; description: string } {
  const cleanTitle = cleanTextForGoogleForms(
    headerConfig.title || 'TestMaker Assessment Quiz',
    { preserveNewlines: false }
  ) || 'Assessment Quiz';

  const parts: string[] = [];

  if (headerConfig.schoolName) {
    parts.push(headerConfig.schoolName);
  }
  if (headerConfig.subject) {
    parts.push(`Subject: ${headerConfig.subject}`);
  }
  if (headerConfig.durationMinutes) {
    parts.push(`⏱ Duration: ${headerConfig.durationMinutes} Minutes`);
  }
  if (headerConfig.instructions) {
    parts.push(headerConfig.instructions);
  }

  const cleanInstructions = cleanTextForGoogleForms(
    parts.filter(Boolean).join('\n\n'),
    { preserveNewlines: true }
  );

  return {
    title: cleanTitle,
    description: cleanInstructions,
  };
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
