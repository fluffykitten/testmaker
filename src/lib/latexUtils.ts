const TEXT_MODE_CMD_RE = /\\(?:text|textbf|textit|textrm|textsf|texttt|textnormal|mbox)\s*\{/g;

/**
 * Inside KaTeX text-mode commands (\text{...}, \mbox{...}, etc.), math superscripts like ^\circ
 * cause KaTeX to fail ("Expected 'EOF', got '^'"). Keep literal ° / °C / °F in text mode and
 * heal any math-mode degree macros that ended up inside \text{...}.
 */
function normalizeTextModeSegment(inner: string): string {
  return inner
    .replace(/\\(degreeC|celsius)\b/g, '°C')
    .replace(/\\degree\s*\\(?:text|mathrm)\{\s*C\s*\}/gi, '°C')
    .replace(/\\degree\s*C\b/gi, '°C')
    .replace(/\^\{\s*\\circ\s*\\(?:text|mathrm)\{\s*C\s*\}\s*\}/gi, '°C')
    .replace(/\^\{\s*\\circ\s*C\s*\}/gi, '°C')
    .replace(/\^\{?\\circ\}?\s*\\(?:text|mathrm)\{\s*C\s*\}/gi, '°C')
    .replace(/\^\{?\\circ\}?\s*C\b/gi, '°C')
    .replace(/\^\{?\\circ\}?\s*\\(?:text|mathrm)\{\s*F\s*\}/gi, '°F')
    .replace(/\^\{?\\circ\}?\s*F\b/gi, '°F')
    .replace(/\^\{\\circ\}/g, '°')
    .replace(/\^\\circ/g, '°')
    .replace(/\\degree\b/g, '°');
}

function normalizeMathModeSegment(segment: string): string {
  return segment
    // LaTeX spacing commands: \, \: \; \! \ ~
    .replace(/\\,/g, ' ')
    .replace(/\\:/g, ' ')
    .replace(/\\;/g, ' ')
    .replace(/\\!/g, '')
    .replace(/\\ /g, ' ')
    .replace(/~/g, ' ')
    // Comprehensive Temperature formats for KaTeX math mode: ensure KaTeX-compatible ^\circ rather than literal °
    .replace(/\\(degreeC|celsius)\b/g, '^\\circ\\text{C}')
    .replace(/\\degree\s*\\text\{\s*C\s*\}/gi, '^\\circ\\text{C}')
    .replace(/\\degree\s*\\mathrm\{\s*C\s*\}/gi, '^\\circ\\text{C}')
    .replace(/\\degree\s*C\b/gi, '^\\circ\\text{C}')
    .replace(/\^\{\\circ\s*C\}/gi, '^\\circ\\text{C}')
    .replace(/(\^\{?\\circ\}?)\s*C\b/gi, '^\\circ\\text{C}')
    .replace(/(\^\{?\\circ\}?)\s*F\b/gi, '^\\circ\\text{F}')
    .replace(/\\degree\b/g, '^\\circ')
    .replace(/°\s*C\b|°C/g, '^\\circ\\text{C}')
    .replace(/°\s*F\b|°F/g, '^\\circ\\text{F}')
    .replace(/°/g, '^\\circ')
    // Clean ext artifacts inside LaTeX strings
    .replace(/\bext([A-Z][a-z]?\d*(?:[A-Z][a-z]?\d*)*)\b/g, '$1')
    .replace(/\bext\{([^{}]+)\}/g, '$1')
    // Normalize malformed isotope notation like _^{40}_{20}W or _^{40} or _{20}^{40}W -> {}^{40}_{20}W
    .replace(/_?\^\{([^{}]+)\}_\{([^{}]+)\}/g, '{}^{$1}_{$2}')
    .replace(/_\{([^{}]+)\}\^\{([^{}]+)\}/g, '{}^{$2}_{$1}')
    .replace(/_?\^([0-9a-zA-Z]+)_([0-9a-zA-Z]+)/g, '{}^{$1}_{$2}')
    .replace(/_([0-9a-zA-Z]+)\^([0-9a-zA-Z]+)/g, '{}^{$2}_{$1}')
    .replace(/_\^\{([^{}]+)\}/g, '{}^{$1}')
    .replace(/_\^([0-9a-zA-Z]+)/g, '{}^{$1}')
    .replace(/\\quad/g, ' \\quad ')
    .replace(/\\qquad/g, ' \\qquad ');
}

/**
 * Normalizes a LaTeX math expression for KaTeX rendering while keeping text-mode arguments
 * (\text{...}, \mbox{...}, etc.) safe from math-mode ^\circ superscript injection.
 */
export function normalizeLatexString(raw: string): string {
  if (!raw) return '';
  let result = '';
  let cursor = 0;
  TEXT_MODE_CMD_RE.lastIndex = 0;

  while (cursor < raw.length) {
    TEXT_MODE_CMD_RE.lastIndex = cursor;
    const match = TEXT_MODE_CMD_RE.exec(raw);
    if (!match) {
      result += normalizeMathModeSegment(raw.slice(cursor));
      break;
    }

    const braceStart = match.index + match[0].length - 1;
    let depth = 1;
    let i = braceStart + 1;
    while (i < raw.length && depth > 0) {
      if (raw[i] === '\\') {
        i += 2;
        continue;
      }
      if (raw[i] === '{') depth++;
      else if (raw[i] === '}') depth--;
      i++;
    }

    if (depth !== 0) {
      result += normalizeMathModeSegment(raw.slice(cursor));
      break;
    }

    const braceEnd = i - 1;
    result += normalizeMathModeSegment(raw.slice(cursor, match.index));
    result += match[0];
    result += normalizeTextModeSegment(raw.slice(braceStart + 1, braceEnd));
    result += '}';
    cursor = braceEnd + 1;
  }

  return result;
}
