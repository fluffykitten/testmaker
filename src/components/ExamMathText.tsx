import React from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import './ExamMathText.css';

interface ExamMathTextProps {
  content: string | string[] | any;
  className?: string;
}

const KATEX_OPTIONS = {
  throwOnError: false,
  trust: true,
  strict: false,
  macros: {
    '\\degree': '^\\circ',
    '\\degreeC': '^\\circ\\text{C}',
    '\\celsius': '^\\circ\\text{C}',
    '\\ce': '#1',
  },
};

const SUB_MAP: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  'a': 'ₐ', 'e': 'ₑ', 'h': 'ₕ', 'i': 'ᵢ', 'j': 'ⱼ', 'k': 'ₖ', 'l': 'ₗ', 'm': 'ₘ', 'n': 'ₙ', 'o': 'ₒ', 'p': 'ₚ', 'r': 'ᵣ', 's': 'ₛ', 't': 'ₜ', 'u': 'ᵤ', 'v': 'ᵥ', 'x': 'ₓ'
};

const SUP_MAP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  'n': 'ⁿ'
};

export function toUnicodeSubscripts(str: string): string {
  return str.split('').map((c) => SUB_MAP[c] || c).join('');
}

export function toUnicodeSuperscripts(str: string): string {
  return str.split('').map((c) => SUP_MAP[c] || c).join('');
}

export function autoFormatChemistryAndMath(text: string): string {
  if (!text || typeof text !== 'string') return text || '';

  // 0. Clean corrupted LLM prefixes (e.g. extCH4, extCO2, extH2O, extCaCO3, extHCl, extNaCl) and control char tabs
  let res = text
    .replace(/\t+ext(?=\{|\s*[A-Za-z0-9])/g, '\\text')
    .replace(/\t+imes\b/g, '\\times')
    .replace(/\t+heta\b/g, '\\theta')
    .replace(/\r+ightarrow\b/g, '\\rightarrow')
    .replace(/\r+ightleftharpoons\b/g, '\\rightleftharpoons')
    .replace(/\f+rac\b/g, '\\frac')
    .replace(/[\b]+eta\b/g, '\\beta')
    .replace(/\bext([A-Z][a-z]?\d*(?:[A-Z][a-z]?\d*)*)\b/g, '$1')
    .replace(/\bext\{([^{}]+)\}/g, '$1')
    .replace(/\bext\s+([A-Z][a-z]?\d*)/g, '$1');

  // 1. Normalize reaction arrows
  res = res
    .replace(/\s*(?:-->|->|\\rightarrow)\s*/g, ' → ')
    .replace(/\s*(?:<->|<=>|\\rightleftharpoons)\s*/g, ' ⇌ ')
    .replace(/\s*(?:<-|\\leftarrow)\s*/g, ' ← ');

  // 2. Format ions like Cu2+, Fe3+, Al3+, Cl-, e-, Na+, H+, OH-, SO4^2-, NO3-
  res = res.replace(/(?:^|[\s+=(;,])(\d*\s*)((?:[A-Z][a-z]?|\([A-Za-z0-9]+\)|e))(\d*)([+-])(?=[\s+=(;.,\]\-]|$)/g, (match, coef, elem, num, charge) => {
    if (!elem) return match;
    const prefix = match.slice(0, match.indexOf(coef + elem));
    const supCharge = toUnicodeSuperscripts(num + charge);
    return prefix + (coef || '') + elem + supCharge;
  });

  // 3. Format neutral chemical formulas with subscripts:
  // e.g. 2H2O, 3CO2, 2Al(OH)3, 3Na2SO4, Fe2O3, H2SO4, C10H18O
  res = res.replace(/(?:^|[\s+=(;,])(\d*\s*)((?:[A-Z][a-z]?(?:\d+|[a-z])?|\([A-Za-z0-9]+\)\d*)+)(?=[\s+=(;.,\]\-]|$)/g, (match, coef, formula) => {
    // Exclude English words
    if (/^(State|Solid|Liquid|Gas|Steam|Option|Acid|Base|Salt|Heat|Mass|Moles?|Time|Temp|Rate|Name|Graph|Table|Test|Figure|Part|Note|Mark|Answer|True|False|Yes|No|May|Can|Will|For|With|From|And|All|Correct)$/i.test(formula)) {
      return match;
    }

    // Must have at least a digit or parentheses with uppercase letter
    if (!/\d|\(/.test(formula)) {
      return match;
    }

    const prefix = match.slice(0, match.indexOf(coef + formula));
    const subFormula = formula.replace(/([A-Za-z\)])(\d+)/g, (_: string, char: string, num: string) => {
      return char + toUnicodeSubscripts(num);
    });

    return prefix + (coef || '') + subFormula;
  });

  return res;
}

export function ensureInlineMathDelimiters(text: string): string {
  if (!text || typeof text !== 'string') return text || '';

  // 1. Auto-format chemistry formulas & reaction arrows in raw text
  let normalized = autoFormatChemistryAndMath(text);

  // 2. Normalize common temperature/degree symbols and isotopes
  normalized = normalized
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
    // Normalize isotope notation: _^{40}_{20}W or _{20}^{40}W -> {}^{40}_{20}W
    .replace(/(?:\{\})?_?\^\{([^{}]+)\}_\{([^{}]+)\}/g, '{}^{$1}_{$2}')
    .replace(/(?:\{\})?_\{([^{}]+)\}\^\{([^{}]+)\}/g, '{}^{$2}_{$1}')
    .replace(/(?:\{\})?_?\^([0-9a-zA-Z]+)_([0-9a-zA-Z]+)/g, '{}^{$1}_{$2}')
    .replace(/(?:\{\})?_([0-9a-zA-Z]+)\^([0-9a-zA-Z]+)/g, '{}^{$2}_{$1}')
    .replace(/(?:\{\})?_\^\{([^{}]+)\}/g, '{}^{$1}')
    .replace(/(?:\{\})?_\^([0-9a-zA-Z]+)/g, '{}^{$1}');

  // Split by existing block math ($$...$$) and inline math ($...$)
  const parts = normalized.split(/(\$\$[\s\S]*?\$\$|\$(?!\$)[^$\n]+?\$)/g);

  // Single-pass combined formula/LaTeX pattern
  const formulaRegex =
    /(?:((?:\{\}\s*)?(?:\^\{[^{}]+\}\s*_\{[^{}]+\}|_\{[^{}]+\}\s*\^\{[^{}]+\})\s*(?:\\(?:text|mathrm|mathbf)\{[^{}]+\}|[A-Z][a-z]?))|(\\frac\{[^{}]*\}\{[^{}]*\}|\\sqrt(?:\[[^{}]*\])?\{[^{}]*\})|((?:(?:\d+\s*)?(?:\\(?:text|mathrm|mathbf|ce)\{[A-Za-z0-9+-/]+\}|[A-Z][a-z]?)(?:_\{[^{}]+\}|_\d+|\^\{[^{}]+\}|\^\d+|\^[+-]+|_[a-zA-Z])*(?:\s*(?:\\cdot|\\times|\+|\-|\u2192|\\rightarrow|\\leftarrow|\\rightleftharpoons|=|\\approx)\s*(?:\d+\s*)?(?:\\(?:text|mathrm|mathbf|ce)\{[A-Za-z0-9+-/]+\}|[A-Z][a-z]?)(?:_\{[^{}]+\}|_\d+|\^\{[^{}]+\}|\^\d+|\^[+-]+|_[a-zA-Z])*)*)+)|(\\Delta\s*[A-Z]?(?:\^\circ)?(?:\s*=\s*[-+]?[0-9.]+(?:\\text\{[^{}]+\}|[a-zA-Z/]+)?)?|\\(?:delta|alpha|beta|gamma|theta|pi|mu|sigma|omega|Omega|lambda|phi)\b(?:\s*[=<>+\-*/]\s*[-+]?[0-9.]+(?:\\text\{[^{}]+\}|[a-zA-Z/]+)?)?)|(\d+(?:\.\d+)?\s*(?:\\times|×)\s*10\^\{?[0-9+-]+\}?(?:\\text\{[^{}]+\})?)|([A-Z][a-z]?(?:_\d+|_\{\w+\}|\^\d+|\^\{[0-9a-zA-Z+-]+\})(?:[A-Z][a-z]?(?:_\d+|_\{\w+\}|\^\d+|\^\{[0-9a-zA-Z+-]+\})*)*))/g;

  const transformedParts = parts.map((part) => {
    if (
      (part.startsWith('$$') && part.endsWith('$$') && part.length >= 4) ||
      (part.startsWith('$') && part.endsWith('$') && part.length >= 2)
    ) {
      return part;
    }

    return part.replace(formulaRegex, (match) => {
      // If it contains LaTeX syntax or subscript/superscript, wrap it in $...$
      if (
        /\\(text|mathrm|mathbf|ce|frac|sqrt|Delta|delta|alpha|beta|gamma|theta|pi|mu|sigma|omega|Omega|lambda|phi|cdot|rightarrow|leftarrow|rightleftharpoons|times|approx)\b|_{|\^{|_\d|\^\d/.test(
          match
        )
      ) {
        const trimmed = match.trim();
        if (trimmed.length > 0) {
          return `$${trimmed}$`;
        }
      }
      return match;
    });
  });

  return transformedParts.join('');
}

export function normalizeLatexString(raw: string): string {
  if (!raw) return '';
  return raw
    // LaTeX spacing commands: \, \: \; \! \ ~
    .replace(/\\,/g, ' ')
    .replace(/\\:/g, ' ')
    .replace(/\\;/g, ' ')
    .replace(/\\!/g, '')
    .replace(/\\ /g, ' ')
    .replace(/~/g, ' ')
    // Comprehensive Temperature formats: 25^\circ C, 25^{\circ}\text{C}, 25\degree C, 25\celsius, 45\,°C
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
    // Clean ext artifacts inside LaTeX strings
    .replace(/\bext([A-Z][a-z]?\d*(?:[A-Z][a-z]?\d*)*)\b/g, '$1')
    .replace(/\bext\{([^{}]+)\}/g, '$1')
    .replace(/\\text\{([A-Z][a-z]?(?:\d+|[a-z])?(?:[A-Z][a-z]?(?:\d+|[a-z])?)*)\}/g, '$1')
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

function renderTextWithSubSuper(text: string): React.ReactNode {
  if (!text) return null;
  const clean = text.replace(/\\%/g, '%');

  // Check for subscript/superscript patterns like Fe_3O_4 or H_2SO_4 or 10^5
  if (!/([a-zA-Z0-9)\]])(_\{[^{}]+\}|_\d+|_[a-zA-Z]|\^\{[^{}]+\}|\^\d+|\^[a-zA-Z+-])/.test(clean)) {
    return clean;
  }

  const parts = clean.split(/(_\{[^{}]+\}|_\d+|_[a-zA-Z]|\^\{[^{}]+\}|\^\d+|\^[a-zA-Z+-])/g);
  return parts.map((part, pIdx) => {
    if (part.startsWith('_')) {
      const val = part.startsWith('_{') && part.endsWith('}') ? part.slice(2, -1) : part.slice(1);
      return <sub key={pIdx}>{val}</sub>;
    }
    if (part.startsWith('^')) {
      const val = part.startsWith('^{') && part.endsWith('}') ? part.slice(2, -1) : part.slice(1);
      return <sup key={pIdx}>{val}</sup>;
    }
    return part;
  });
}

function renderMathSnippet(snippet: any): React.ReactNode {
  if (!snippet) return null;
  let str = typeof snippet === 'string' ? snippet : String(snippet);

  // Normalize string and ensure only embedded formulas/LaTeX are wrapped in $...$
  str = ensureInlineMathDelimiters(str);

  // Split by block math $$...$$ and inline math $...$
  const tokens = str.split(/(\$\$[\s\S]*?\$\$|\$(?!\$)[^$\n]+?\$)/g);

  return tokens.map((token, idx) => {
    if (!token) return null;

    // Block Math: $$ ... $$
    if (token.startsWith('$$') && token.endsWith('$$') && token.length >= 4) {
      const rawMath = token.slice(2, -2).trim();
      // In LaTeX/KaTeX math mode, % is a comment character unless escaped as \%
      const math = normalizeLatexString(rawMath).replace(/(?<!\\)%/g, '\\%');
      try {
        const html = katex.renderToString(math, {
          ...KATEX_OPTIONS,
          displayMode: true,
        });
        return (
          <span
            key={idx}
            className="exam-math-block"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      } catch {
        return (
          <span key={idx} className="exam-math-block exam-math-fallback">
            {token}
          </span>
        );
      }
    }

    // Inline Math: $ ... $
    if (token.startsWith('$') && token.endsWith('$') && token.length >= 2) {
      const rawMath = token.slice(1, -1).trim();
      // In LaTeX/KaTeX math mode, % is a comment character unless escaped as \%
      const math = normalizeLatexString(rawMath).replace(/(?<!\\)%/g, '\\%');
      try {
        const html = katex.renderToString(math, {
          ...KATEX_OPTIONS,
          displayMode: false,
        });
        return (
          <span
            key={idx}
            className="exam-math-inline"
            dangerouslySetInnerHTML={{ __html: html }}
          />
        );
      } catch {
        return (
          <span key={idx} className="exam-math-inline exam-math-fallback">
            {token}
          </span>
        );
      }
    }

    // Parse Markdown Bold (**text**) in text snippets
    if (token.includes('**')) {
      const boldParts = token.split(/(\*\*.*?\*\*)/g);
      return (
        <React.Fragment key={idx}>
          {boldParts.map((bp, bpi) => {
            if (bp.startsWith('**') && bp.endsWith('**') && bp.length >= 4) {
              return <strong key={bpi}>{renderTextWithSubSuper(bp.slice(2, -2))}</strong>;
            }
            return renderTextWithSubSuper(bp);
          })}
        </React.Fragment>
      );
    }

    return <React.Fragment key={idx}>{renderTextWithSubSuper(token)}</React.Fragment>;
  });
}

function isFlowchartLine(line: string): boolean {
  const trimmed = line.trim();
  const boxMatches = trimmed.match(/\[\s*[^\]]+?\s*\]/g);
  const hasArrows = /(?:→|->|\\rightarrow)/.test(trimmed);
  return !!(boxMatches && boxMatches.length >= 2 && hasArrows);
}

function parseFlowchartStages(line: string): { text: string; isBlank: boolean }[] {
  const trimmed = line.trim();
  const parts = trimmed.split(/\s*(?:→|->|\\rightarrow)\s*/);
  return parts.map((part) => {
    const clean = part.replace(/^\[\s*/, '').replace(/\s*\]$/, '').trim();
    const isBlank = /^\.{3,}|_{3,}|^\s*$/.test(clean);
    return { text: clean, isBlank };
  });
}

function parseTickBoxLine(line: string): { text: string; checked: boolean; position: 'leading' | 'trailing' } | null {
  const trimmed = line.trim();
  // Leading tickbox: - [ ] Option or [ ] Option or - [x] Option or - [✓] Option
  const leadingMatch = trimmed.match(/^(?:[-*]\s*)?\[\s*([✓xXvV]?)\s*\]\s+(.+)$/);
  if (leadingMatch) {
    return {
      text: leadingMatch[2].trim(),
      checked: !!leadingMatch[1].trim(),
      position: 'leading',
    };
  }

  // Trailing tickbox: Option [ ] or Option [✓]
  const trailingMatch = trimmed.match(/^(.+?)\s+\[\s*([✓xXvV]?)\s*\]$/);
  if (trailingMatch) {
    return {
      text: trailingMatch[1].trim(),
      checked: !!trailingMatch[2].trim(),
      position: 'trailing',
    };
  }

  return null;
}

/**
 * Parses markdown table blocks and mixed text/KaTeX
 */
export const ExamMathText: React.FC<ExamMathTextProps> = ({ content, className = '' }) => {
  if (content === null || content === undefined) return null;

  let strContent = '';
  if (typeof content === 'string') {
    strContent = content;
  } else if (Array.isArray(content)) {
    strContent = content
      .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
      .join('\n');
  } else if (typeof content === 'object') {
    strContent = JSON.stringify(content);
  } else {
    strContent = String(content);
  }

  if (!strContent.trim()) return null;

  // Normalize string: convert literal '\n' string to actual newline
  const normalized = strContent.replace(/\\n/g, '\n');

  // Split by markdown table patterns
  const lines = normalized.split('\n');
  const blocks: { type: 'text' | 'table'; lines: string[] }[] = [];
  let currentBlock: { type: 'text' | 'table'; lines: string[] } | null = null;

  const isTableLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    // Standard markdown table row starting with pipe
    if (trimmed.startsWith('|')) return true;
    // Line with at least two pipe delimiters or separator syntax
    const pipeCount = (trimmed.match(/\|/g) || []).length;
    const isSep = /^[-:\s|]{3,}$/.test(trimmed) && pipeCount >= 1;
    return pipeCount >= 2 || isSep;
  };

  const isSeparatorRow = (line: string): boolean => {
    const clean = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    const cells = clean.split('|').map((c) => c.trim());
    return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c) || /^[-:\s]+$/.test(c));
  };

  const parseTableRowCells = (rowStr: string): string[] => {
    let clean = rowStr.trim();
    if (clean.startsWith('|')) clean = clean.slice(1);
    if (clean.endsWith('|')) clean = clean.slice(0, -1);
    return clean.split('|').map((c) => c.trim());
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isTableLine(line)) {
      if (!currentBlock || currentBlock.type !== 'table') {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = { type: 'table', lines: [line] };
      } else {
        currentBlock.lines.push(line);
      }
    } else {
      if (!currentBlock || currentBlock.type !== 'text') {
        if (currentBlock) blocks.push(currentBlock);
        currentBlock = { type: 'text', lines: [line] };
      } else {
        currentBlock.lines.push(line);
      }
    }
  }
  if (currentBlock) blocks.push(currentBlock);

  return (
    <div className={`exam-math-wrapper ${className}`}>
      {blocks.map((block, bIdx) => {
        if (block.type === 'table') {
          // Parse Markdown Table
          const rawRows = block.lines
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !isSeparatorRow(l));

          if (rawRows.length === 0) return null;

          const headerCells = parseTableRowCells(rawRows[0]);
          const bodyRows = rawRows.slice(1).map(parseTableRowCells);

          return (
            <div key={bIdx} className="exam-table-container">
              <table className="exam-markdown-table">
                <thead>
                  <tr>
                    {headerCells.map((h, hi) => (
                      <th key={hi}>{renderMathSnippet(h)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {bodyRows.map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => (
                        <td key={ci}>{renderMathSnippet(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        // Text Block with linebreaks, flowcharts, tickboxes, and math
        return (
          <div key={bIdx} className="exam-text-block">
            {block.lines.map((line, li) => {
              // 1. Process Flowcharts & Sequence Boxes
              if (isFlowchartLine(line)) {
                const stages = parseFlowchartStages(line);
                return (
                  <div key={li} className="exam-flowchart-container">
                    {stages.map((stage, sIdx) => (
                      <React.Fragment key={sIdx}>
                        <div className={`exam-stage-box ${stage.isBlank ? 'exam-stage-box--blank' : ''}`}>
                          {renderMathSnippet(stage.text)}
                        </div>
                        {sIdx < stages.length - 1 && <span className="exam-stage-arrow">→</span>}
                      </React.Fragment>
                    ))}
                  </div>
                );
              }

              // 2. Tick Box Lines
              const tickBox = parseTickBoxLine(line);
              if (tickBox) {
                return (
                  <div key={li} className="exam-tickbox-row">
                    <span className="exam-tickbox-label">{renderMathSnippet(tickBox.text)}</span>
                    <span className={`exam-tickbox ${tickBox.checked ? 'checked' : ''}`}>
                      {tickBox.checked ? '✓' : ''}
                    </span>
                  </div>
                );
              }

              // 3. Regular Text & Math
              return (
                <React.Fragment key={li}>
                  {renderMathSnippet(line)}
                  {li < block.lines.length - 1 && <br />}
                </React.Fragment>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};
