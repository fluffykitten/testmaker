// ─── DOCX Balanced LaTeX, mhchem & Native OMML Math Utilities ────────────────
// Converts Markdown, HTML tags, balanced LaTeX ($...$, \frac, \sqrt, \ce{...}),
// and atomic isotopes (^{37}_{17}Cl) into crisp docx TextRun and native OMML Math nodes.

import {
  TextRun,
  UnderlineType,
  Math as DocxMath,
  MathRun,
  MathFraction,
  MathRadical,
  MathSuperScript,
  MathSubScript,
  MathSubSuperScript,
  MathPreSubSuperScript,
  type MathComponent,
} from 'docx';
import { protectCurrencySymbols, restoreCurrencySymbols } from '../components/ExamMathText';
import { stripPassageControlTags } from '../lib/readingPassageUtils';

export interface DocxRunStyleOpts {
  size?: number;
  bold?: boolean;
  color?: string;
  italics?: boolean;
  underline?: boolean;
  font?: string;
}

export type DocxInlineChild = TextRun | DocxMath;

const UNICODE_SUB_MAP: Record<string, string> = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4',
  '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')',
  'ₐ': 'a', 'ₑ': 'e', 'ₕ': 'h', 'ᵢ': 'i', 'ⱼ': 'j',
  'ₖ': 'k', 'ₗ': 'l', 'ₘ': 'm', 'ₙ': 'n', 'ₒ': 'o',
  'ₚ': 'p', 'ᵣ': 'r', 'ₛ': 's', 'ₜ': 't', 'ᵤ': 'u', 'ᵥ': 'v', 'ₓ': 'x',
};

const UNICODE_SUPER_MAP: Record<string, string> = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4',
  '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')',
  'ⁿ': 'n', 'ⁱ': 'i',
};

const GREEK_AND_SYMBOL_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\\rightleftharpoons/g, ' ⇌ '],
  [/\\leftrightarrows/g, ' ⇌ '],
  [/\\longrightarrow/g, ' → '],
  [/\\longleftarrow/g, ' ← '],
  [/\\rightarrow/g, ' → '],
  [/\\leftarrow/g, ' ← '],
  [/\\leftrightarrow/g, ' ↔ '],
  [/\\Rightarrow/g, ' ⇒ '],
  [/\\times/g, ' × '],
  [/\\cdot/g, ' · '],
  [/\\div/g, ' ÷ '],
  [/\\pm/g, ' ± '],
  [/\\mp/g, ' ∓ '],
  [/\\approx/g, ' ≈ '],
  [/\\equiv/g, ' ≡ '],
  [/\\neq/g, ' ≠ '],
  [/\\le(q)?\b/g, ' ≤ '],
  [/\\ge(q)?\b/g, ' ≥ '],
  [/\\propto/g, ' ∝ '],
  [/\\infty/g, ' ∞ '],
  [/\\rightarrow/g, ' → '],
  [/\\Delta\b/g, 'Δ'],
  [/\\delta\b/g, 'δ'],
  [/\\alpha\b/g, 'α'],
  [/\\beta\b/g, 'β'],
  [/\\gamma\b/g, 'γ'],
  [/\\theta\b/g, 'θ'],
  [/\\pi\b/g, 'π'],
  [/\\mu\b/g, 'μ'],
  [/\\micro\b/g, 'μ'],
  [/\\sigma\b/g, 'σ'],
  [/\\omega\b/g, 'ω'],
  [/\\Omega\b|\\ohm\b/g, 'Ω'],
  [/\\lambda\b/g, 'λ'],
  [/\\phi\b/g, 'ϕ'],
  [/\\rho\b/g, 'ρ'],
  [/\\eta\b/g, 'η'],
  [/\\varepsilon\b|\\epsilon\b/g, 'ε'],
  [/\\angstrom\b/g, 'Å'],
];

/**
 * Reads a balanced `{ ... }` group starting at `openBraceIdx` (respecting escaped `\{` / `\}`).
 * Returns `{ content, nextIndex }` where `nextIndex` is the index immediately after `}`,
 * or `null` if braces are unbalanced.
 */
export function readBalancedGroup(input: string, openBraceIdx: number): { content: string; nextIndex: number } | null {
  if (input[openBraceIdx] !== '{') return null;
  let depth = 1;
  let i = openBraceIdx + 1;
  while (i < input.length && depth > 0) {
    if (input[i] === '\\' && i + 1 < input.length) {
      i += 2;
      continue;
    }
    if (input[i] === '{') depth++;
    else if (input[i] === '}') depth--;
    i++;
  }
  if (depth !== 0) return null;
  return {
    content: input.slice(openBraceIdx + 1, i - 1),
    nextIndex: i,
  };
}

/**
 * Replaces every balanced occurrence of `\cmdName{inner}` using `mapper(inner)`.
 */
function replaceCommandSingleArg(input: string, cmdNames: string[], mapper: (inner: string) => string): string {
  const re = new RegExp(`\\\\(?:${cmdNames.join('|')})\\s*\\{`, 'g');
  let out = '';
  let cursor = 0;

  while (cursor < input.length) {
    re.lastIndex = cursor;
    const match = re.exec(input);
    if (!match) {
      out += input.slice(cursor);
      break;
    }
    const openBrace = match.index + match[0].length - 1;
    const grp = readBalancedGroup(input, openBrace);
    if (!grp) {
      out += input.slice(cursor);
      break;
    }
    out += input.slice(cursor, match.index) + mapper(grp.content);
    cursor = grp.nextIndex;
  }

  return out;
}

/**
 * Converts a `\ce{...}` / `\pu{...}` mhchem expression into balanced sub/superscript notation.
 */
export function convertMhchemToFormattedText(rawInner: string): string {
  let s = rawInner.trim();
  // Reaction arrows
  s = s
    .replace(/<=>|<->/g, ' ⇌ ')
    .replace(/->/g, ' → ')
    .replace(/<-/g, ' ← ')
    .replace(/\\uparrow/g, '↑')
    .replace(/\\downarrow/g, '↓');

  // Preserve leading nuclide like {}^{37}_{17}Cl or ^{37}_{17}Cl
  s = s.replace(/\^\{\s*([^}]+)\s*\}\s*_\{\s*([^}]+)\s*\}/g, '^{$1}_{$2}');

  // Hydrate crystal dot separator e.g. CuSO4.5H2O -> CuSO4·5H2O
  s = s.replace(/([A-Za-z0-9)\]])\*([0-9])/g, '$1·$2').replace(/([A-Za-z0-9)\]])\.(\d+[A-Z])/g, '$1·$2');

  // Ionic charges after caret: ^2+, ^3-, ^+, ^- (when not already braced)
  s = s
    .replace(/\^\{([^{}]+)\}/g, '^{$1}')
    .replace(/\^(\d*[+-])/g, '^{$1}');

  // Trailing single-ion charge without caret at end of species: Fe3+ -> Fe^{3+}, SO4^2- already handled, NO3- -> NO3^{-}
  s = s
    .replace(/([A-Za-z)\]}])(\d+)([+-])(?=[\s,;.)\]→⇌]|$)/g, (_full, base, d, sign) => {
      // Ambiguous like Cu2+: treat trailing 2+ as charge ^{2+} if single charge sign at boundary
      return `${base}^{${d}${sign}}`;
    })
    .replace(/([A-Za-z)\]}])([+-])(?=[\s,;.)\]→⇌]|$)/g, '$1^{$2}');

  // Stoichiometric digits attached to element symbol or closing paren/bracket: H2O -> H_{2}O, Ca(OH)2 -> Ca(OH)_{2}
  // Never subscript digits inside ^{...} or leading stoichiometric coefficients after space
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '^' && s[i + 1] === '{') {
      const grp = readBalancedGroup(s, i + 1);
      if (grp) {
        out += `^{${grp.content}}`;
        i = grp.nextIndex - 1;
        continue;
      }
    }
    if (s[i] === '_' && s[i + 1] === '{') {
      const grp = readBalancedGroup(s, i + 1);
      if (grp) {
        out += `_{${grp.content}}`;
        i = grp.nextIndex - 1;
        continue;
      }
    }
    if (/[A-Za-z)\]]/.test(s[i]) && /\d/.test(s[i + 1] || '')) {
      out += s[i];
      let j = i + 1;
      while (j < s.length && /\d/.test(s[j])) j++;
      out += `_{${s.slice(i + 1, j)}}`;
      i = j - 1;
      continue;
    }
    out += s[i];
  }

  return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Normalizes spacing, degree notations, LaTeX text wrappers, \ce{...}, and Unicode scripts
 * while leaving structural math expressions ($...$, $$...$$, \frac, \sqrt, stacked nuclides) intact for OMML conversion.
 */
export function normalizeCommonLatexForDocx(rawText: string): string {
  if (!rawText) return '';
  let text = stripPassageControlTags(rawText);
  if (!text) return '';

  text = protectCurrencySymbols(text);

  // Clean HTML super/subscript tags and break tags first
  text = text
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<sub>([\s\S]*?)<\/sub>/gi, '_{$1}')
    .replace(/<sup>([\s\S]*?)<\/sup>/gi, '^{$1}');

  // Replace \ce{...} and \pu{...} recursively (innermost first if nested)
  for (let pass = 0; pass < 3 && /\\(?:ce|pu)\s*\{/.test(text); pass++) {
    text = replaceCommandSingleArg(text, ['ce', 'pu'], (inner) => convertMhchemToFormattedText(inner));
  }

  // Unwrap styling font wrappers cleanly
  for (let pass = 0; pass < 3 && /\\(?:text|textrm|mathrm|mathbf|mathit|textbf|textit)\s*\{/.test(text); pass++) {
    text = replaceCommandSingleArg(text, ['text', 'textrm', 'mathrm', 'mathbf', 'mathit', 'textbf', 'textit'], (inner) => inner);
  }

  // Strip \left and \right sizing prefixes (keep delimiter e.g. \left( -> ()
  text = text.replace(/\\(?:left|right)\s*([()\[\]|.])/g, (_, delim) => (delim === '.' ? '' : delim));

  // Normalize \xrightarrow
  text = text
    .replace(/\\xrightarrow\[(.*?)\]\{(.*?)\}/g, ' ──[$1]($2)──> ')
    .replace(/\\xrightarrow\{(.*?)\}/g, ' ──($1)──> ');

  // Symbols & Greek letters
  for (const [rx, rep] of GREEK_AND_SYMBOL_REPLACEMENTS) {
    text = text.replace(rx, rep);
  }

  // Checkboxes / Tickboxes (outside table stripping handled separately)
  text = text
    .replace(/(?:^|\s)[-*]\s+\[\s*\]/g, ' ☐ ')
    .replace(/\[\s*\]/g, '☐ ')
    .replace(/(?:[-*]\s*)?\[\s*[✓xXvV]\s*\]/g, ' ☑ ');

  // LaTeX spacing & percent escapes
  text = text
    .replace(/\\,|\\:|\\;|\\!/g, ' ')
    .replace(/\\ /g, ' ')
    .replace(/\\quad\b|\\qquad\b/g, '   ')
    .replace(/~/g, ' ')
    .replace(/\\%/g, '%');

  // Temperature & degree macros
  text = text
    .replace(/\\(degreeC|celsius)\b/g, '°C')
    .replace(/\\degree\s*C\b/gi, '°C')
    .replace(/\^\{\s*\\circ\s*C\s*\}/gi, '°C')
    .replace(/(\^\{?\\circ\}?)\s*C\b/gi, '°C')
    .replace(/(\^\{?\\circ\}?)\s*F\b/gi, '°F')
    .replace(/\^\{\\circ\}|\^\\circ|\\degree\b|\\circ\b/g, '°');

  // Normalize isotopes/nuclides into canonical ^{mass}_{atomic} order:
  // e.g. _^{40}_{20}W, {}^{40}_{20}W, _{20}^{40}W -> ^{40}_{20}W
  text = text
    .replace(/(?:\{\}\s*)?(?:_\^|\^)\{([^{}]+)\}\s*_\{([^{}]+)\}/g, '^{$1}_{$2}')
    .replace(/(?:\{\}\s*)?_\{([^{}]+)\}\s*\^\{([^{}]+)\}/g, '^{$2}_{$1}')
    .replace(/(?:\{\}\s*)?(?:_\^|\^)([0-9a-zA-Z]+)\s*_([0-9a-zA-Z]+)/g, '^{$1}_{$2}')
    .replace(/(?:\{\}\s*)?_([0-9a-zA-Z]+)\s*\^([0-9a-zA-Z]+)/g, '^{$2}_{$1}')
    .replace(/\\prescript\{([^{}]+)\}\{([^{}]+)\}/g, '^{$1}_{$2}')
    .replace(/(?:\{\}\s*)_\^\{([^{}]+)\}/g, '^{$1}')
    .replace(/\{\}/g, '');

  text = restoreCurrencySymbols(text);

  // Convert unicode subscript/superscript chars to canonical _{...} / ^{...}
  for (const [uni, asc] of Object.entries(UNICODE_SUB_MAP)) {
    if (text.includes(uni)) text = text.replaceAll(uni, `_{${asc}}`);
  }
  for (const [uni, asc] of Object.entries(UNICODE_SUPER_MAP)) {
    if (text.includes(uni)) text = text.replaceAll(uni, `^{${asc}}`);
  }

  // Convert unbraced simple sub/superscripts: H_2 -> H_{2}, Fe^2+ -> Fe^{2+}
  text = text
    .replace(/([a-zA-Z0-9)\]])_(\d+)/g, '$1_{$2}')
    .replace(/([a-zA-Z0-9)\]])_([a-zA-Z+-])(?![a-zA-Z0-9])/g, '$1_{$2}')
    .replace(/([a-zA-Z0-9)\]])\^(\d*[+-]|[+-]\d+)(?=[\s;,.)\]→⇌-]|$)/g, '$1^{$2}')
    .replace(/([a-zA-Z0-9)\]])\^(\d+)/g, '$1^{$2}')
    .replace(/([a-zA-Z0-9)\]])\^([a-zA-Z])(?![a-zA-Z0-9])/g, '$1^{$2}');

  return text;
}

// ─── OMML Math AST Builder for \frac, \sqrt, stacked nuclides & complex math ─

function buildOmmlComponentsFromLatex(expr: string): MathComponent[] {
  const components: MathComponent[] = [];
  let textBuf = '';
  const flushBuf = () => {
    if (textBuf) {
      components.push(new MathRun(textBuf));
      textBuf = '';
    }
  };

  let i = 0;
  while (i < expr.length) {
    // 1. \frac{num}{den} / \dfrac{num}{den} / \tfrac{num}{den}
    const fracMatch = expr.slice(i).match(/^\\(?:d|t)?frac\s*\{/);
    if (fracMatch) {
      const open1 = i + fracMatch[0].length - 1;
      const g1 = readBalancedGroup(expr, open1);
      if (g1) {
        let j = g1.nextIndex;
        while (j < expr.length && /\s/.test(expr[j])) j++;
        const g2 = expr[j] === '{' ? readBalancedGroup(expr, j) : null;
        if (g2) {
          flushBuf();
          components.push(
            new MathFraction({
              numerator: buildOmmlComponentsFromLatex(g1.content),
              denominator: buildOmmlComponentsFromLatex(g2.content),
            })
          );
          i = g2.nextIndex;
          continue;
        }
      }
    }

    // 2. \sqrt[n]{x} or \sqrt{x}
    const sqrtMatch = expr.slice(i).match(/^\\sqrt(?:\s*\[([^\]]+)\])?\s*\{/);
    if (sqrtMatch) {
      const open = i + sqrtMatch[0].length - 1;
      const g = readBalancedGroup(expr, open);
      if (g) {
        flushBuf();
        components.push(
          new MathRadical({
            children: buildOmmlComponentsFromLatex(g.content),
            ...(sqrtMatch[1] ? { degree: buildOmmlComponentsFromLatex(sqrtMatch[1]) } : {}),
          })
        );
        i = g.nextIndex;
        continue;
      }
    }

    // 3. Stacked Pre-SubSuperScript nuclide: ^{A}_{Z}Symbol (e.g. ^{37}_{17}Cl)
    const nuclideMatch = expr.slice(i).match(/^\^\{([^{}]+)\}_\{([^{}]+)\}([A-Z][a-z]?|\S)/);
    if (nuclideMatch) {
      flushBuf();
      const baseSymbol = nuclideMatch[3];
      let nextIdx = i + nuclideMatch[0].length;
      // Optional trailing charge e.g. ^{+} after ^{63}_{29}Cu
      const chargeMatch = expr.slice(nextIdx).match(/^\^\{([^{}]+)\}/);
      if (chargeMatch) {
        const symWithCharge = new MathSuperScript({
          children: [new MathRun(baseSymbol)],
          superScript: buildOmmlComponentsFromLatex(chargeMatch[1]),
        });
        components.push(
          new MathPreSubSuperScript({
            children: [symWithCharge],
            superScript: buildOmmlComponentsFromLatex(nuclideMatch[1]),
            subScript: buildOmmlComponentsFromLatex(nuclideMatch[2]),
          })
        );
        nextIdx += chargeMatch[0].length;
      } else {
        components.push(
          new MathPreSubSuperScript({
            children: [new MathRun(baseSymbol)],
            superScript: buildOmmlComponentsFromLatex(nuclideMatch[1]),
            subScript: buildOmmlComponentsFromLatex(nuclideMatch[2]),
          })
        );
      }
      i = nextIdx;
      continue;
    }

    // 4. Base followed by _{sub}^{sup} or ^{sup} or _{sub}
    if (expr[i] === '^' || expr[i] === '_') {
      const firstType = expr[i];
      let g1: { content: string; nextIndex: number } | null = null;
      if (expr[i + 1] === '{') {
        g1 = readBalancedGroup(expr, i + 1);
      } else if (i + 1 < expr.length) {
        g1 = { content: expr[i + 1], nextIndex: i + 2 };
      }

      if (g1) {
        // Check if preceding component or last char in textBuf is the base
        let baseComponents: MathComponent[];
        if (textBuf.length > 0) {
          const baseChar = textBuf[textBuf.length - 1];
          textBuf = textBuf.slice(0, -1);
          flushBuf();
          baseComponents = [new MathRun(baseChar)];
        } else if (components.length > 0) {
          baseComponents = [components.pop()!];
        } else {
          baseComponents = [new MathRun('')];
        }

        const nextIdx = g1.nextIndex;
        const secondType = expr[nextIdx] === '^' || expr[nextIdx] === '_' ? expr[nextIdx] : null;
        let g2: { content: string; nextIndex: number } | null = null;
        if (secondType && secondType !== firstType) {
          if (expr[nextIdx + 1] === '{') g2 = readBalancedGroup(expr, nextIdx + 1);
          else if (nextIdx + 1 < expr.length) g2 = { content: expr[nextIdx + 1], nextIndex: nextIdx + 2 };
        }

        if (g2) {
          const subExpr = firstType === '_' ? g1.content : g2.content;
          const supExpr = firstType === '^' ? g1.content : g2.content;
          components.push(
            new MathSubSuperScript({
              children: baseComponents,
              subScript: buildOmmlComponentsFromLatex(subExpr),
              superScript: buildOmmlComponentsFromLatex(supExpr),
            })
          );
          i = g2.nextIndex;
          continue;
        }

        if (firstType === '^') {
          components.push(
            new MathSuperScript({
              children: baseComponents,
              superScript: buildOmmlComponentsFromLatex(g1.content),
            })
          );
        } else {
          components.push(
            new MathSubScript({
              children: baseComponents,
              subScript: buildOmmlComponentsFromLatex(g1.content),
            })
          );
        }
        i = g1.nextIndex;
        continue;
      }
    }

    textBuf += expr[i];
    i++;
  }

  flushBuf();
  return components.length > 0 ? components : [new MathRun(expr)];
}

/**
 * Checks whether an expression requires native Word OMML (`Math`) because it contains
 * fractions, roots, or stacked isotope/nuclide notation.
 */
function needsOmmlElement(expr: string): boolean {
  return (
    /\\(?:d|t)?frac\s*\{|\\sqrt(?:\s*\[[^\]]+\])?\s*\{/.test(expr) ||
    /\^\{[^{}]+\}_\{[^{}]+\}\S/.test(expr)
  );
}

/**
 * Splits normalized text into TextRun + native OMML DocxMath children.
 */
export function parseFormattedTextToDocxChildren(
  rawText: string,
  baseOpts: DocxRunStyleOpts = {}
): DocxInlineChild[] {
  if (!rawText) return [];
  const normalized = normalizeCommonLatexForDocx(rawText);
  if (!normalized) return [];

  const underlineStyle = baseOpts.underline ? { type: UnderlineType.SINGLE } : undefined;
  const makeTextRun = (txt: string, overrides: DocxRunStyleOpts & { subScript?: boolean; superScript?: boolean } = {}) =>
    new TextRun({
      text: txt,
      size: overrides.size ?? baseOpts.size,
      bold: overrides.bold ?? baseOpts.bold,
      color: overrides.color ?? baseOpts.color,
      italics: overrides.italics ?? baseOpts.italics,
      underline: underlineStyle,
      font: overrides.font ?? baseOpts.font,
      subScript: overrides.subScript,
      superScript: overrides.superScript,
    });

  // Extract complex OMML tokens: $$...$$, $...$ (when containing \frac/\sqrt/nuclide), bare \frac/\sqrt, or bare nuclides ^{A}_{Z}X^{chg}
  const children: DocxInlineChild[] = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    // Find next potential math delimiter or complex LaTeX construct
    const sub = normalized.slice(cursor);
    const nextMatch = sub.match(
      /(\$\$[\s\S]+?\$\$|\$(?!\$)[^$\n]+?\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\\(?:d|t)?frac\s*\{|\\sqrt(?:\s*\[[^\]]+\])?\s*\{|\^\{[^{}]+\}_\{[^{}]+\}(?:[A-Z][a-z]?|\S)(?:\^\{[^{}]+\})?)/
    );

    if (!nextMatch || nextMatch.index === undefined) {
      children.push(...tokenizeStyledTextToRuns(sub, baseOpts, makeTextRun));
      break;
    }

    if (nextMatch.index > 0) {
      children.push(...tokenizeStyledTextToRuns(sub.slice(0, nextMatch.index), baseOpts, makeTextRun));
    }

    const tokenStart = cursor + nextMatch.index;
    const token = nextMatch[0];

    // If matched \frac{...}{...} or \sqrt{...}, expand using balanced brace scanning
    if (/^\\(?:d|t)?frac\s*\{/.test(token)) {
      const open1 = tokenStart + token.length - 1;
      const g1 = readBalancedGroup(normalized, open1);
      if (g1) {
        let j = g1.nextIndex;
        while (j < normalized.length && /\s/.test(normalized[j])) j++;
        const g2 = normalized[j] === '{' ? readBalancedGroup(normalized, j) : null;
        if (g2) {
          const expr = normalized.slice(tokenStart, g2.nextIndex);
          children.push(new DocxMath({ children: buildOmmlComponentsFromLatex(expr) }));
          cursor = g2.nextIndex;
          continue;
        }
      }
    }

    if (/^\\sqrt/.test(token)) {
      const open = tokenStart + token.length - 1;
      const g = readBalancedGroup(normalized, open);
      if (g) {
        const expr = normalized.slice(tokenStart, g.nextIndex);
        children.push(new DocxMath({ children: buildOmmlComponentsFromLatex(expr) }));
        cursor = g.nextIndex;
        continue;
      }
    }

    // Stacked nuclide outside math delimiters
    if (/^\^\{[^{}]+\}_\{[^{}]+\}/.test(token)) {
      children.push(new DocxMath({ children: buildOmmlComponentsFromLatex(token) }));
      cursor = tokenStart + token.length;
      continue;
    }

    // Explicit $...$, $$...$$, \(...\), \[...\]
    let innerMath = token;
    if (token.startsWith('$$') && token.endsWith('$$')) innerMath = token.slice(2, -2).trim();
    else if (token.startsWith('$') && token.endsWith('$')) innerMath = token.slice(1, -1).trim();
    else if ((token.startsWith('\\(') && token.endsWith('\\)')) || (token.startsWith('\\[') && token.endsWith('\\]'))) {
      innerMath = token.slice(2, -2).trim();
    }

    if (needsOmmlElement(innerMath)) {
      children.push(new DocxMath({ children: buildOmmlComponentsFromLatex(innerMath) }));
    } else {
      // Keep clean inline chemical/simple math formulas as crisp TextRuns with native sub/superscripts
      children.push(...tokenizeStyledTextToRuns(innerMath, baseOpts, makeTextRun));
    }

    cursor = tokenStart + token.length;
  }

  return children.length > 0 ? children : [makeTextRun(rawText)];
}

/**
 * Tokenizes inline markdown styles (**bold**, *italic*, ***both***, [u]...[/u]) and _{sub}/^{sup} into TextRuns.
 */
function tokenizeStyledTextToRuns(
  processed: string,
  baseOpts: DocxRunStyleOpts,
  makeTextRun: (txt: string, overrides?: DocxRunStyleOpts & { subScript?: boolean; superScript?: boolean }) => TextRun
): TextRun[] {
  if (!processed) return [];
  // Strip any leftover unmatched outer $...$ inside chunk
  const clean = processed.replace(/\$\$(.*?)\$\$/g, '$1').replace(/\$(?!\d)([^$\n]+?)\$/g, '$1');

  const runs: TextRun[] = [];
  const tokenRegex = /(_\{[^{}]*\}|\^\{[^{}]*\}|\[u\][\s\S]*?\[\/u\]|\*\*\*[^\s*][\s\S]*?\*\*\*|\*\*[^*]+\*\*|\*(?!\s)(?:[^*\n]*?\S)?\*)/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(clean)) !== null) {
    if (match.index > lastIndex) {
      const plainText = clean.substring(lastIndex, match.index);
      if (plainText) runs.push(makeTextRun(plainText));
    }

    const matchedStr = match[0];
    if (matchedStr.startsWith('_{') && matchedStr.endsWith('}')) {
      const subContent = matchedStr.slice(2, -1);
      if (subContent) runs.push(makeTextRun(subContent, { subScript: true }));
    } else if (matchedStr.startsWith('^{') && matchedStr.endsWith('}')) {
      const superContent = matchedStr.slice(2, -1);
      if (superContent) runs.push(makeTextRun(superContent, { superScript: true }));
    } else if (/^\[u\]/i.test(matchedStr) && /\[\/u\]$/i.test(matchedStr)) {
      const inner = matchedStr.slice(3, -4);
      if (inner) runs.push(...tokenizeStyledTextToRuns(inner, { ...baseOpts, underline: true }, makeTextRun));
    } else if (matchedStr.startsWith('***') && matchedStr.endsWith('***') && matchedStr.length > 6) {
      const inner = matchedStr.slice(3, -3);
      if (inner) runs.push(...tokenizeStyledTextToRuns(inner, { ...baseOpts, bold: true, italics: true }, makeTextRun));
    } else if (matchedStr.startsWith('**') && matchedStr.endsWith('**')) {
      const inner = matchedStr.slice(2, -2);
      if (inner) runs.push(...tokenizeStyledTextToRuns(inner, { ...baseOpts, bold: true }, makeTextRun));
    } else if (matchedStr.startsWith('*') && matchedStr.endsWith('*') && matchedStr.length > 2) {
      const inner = matchedStr.slice(1, -1);
      if (inner) runs.push(...tokenizeStyledTextToRuns(inner, { ...baseOpts, italics: true }, makeTextRun));
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < clean.length) {
    const trailing = clean.substring(lastIndex);
    if (trailing) runs.push(makeTextRun(trailing));
  }

  return runs;
}
