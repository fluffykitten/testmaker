// ─── High-Resolution Exam Table Image Renderer ────────────────────────────────
// Converts Markdown tables and structured ExamDataTable objects into publication-grade
// PNG images via HTML5 Canvas for Google Forms, Docs, and LMS exports.
// Replaces broken/warped ASCII/Unicode box-drawing characters with crisp, authentic exam figures.

import type { ExamDataTable, ExamDataTableCell } from '../types/database';

export interface ParsedTableData {
  title?: string;
  headers: string[];
  rows: string[][];
}

export interface ExtractedTableResult {
  preText: string;
  table: ParsedTableData | null;
  postText: string;
  rawTableText: string;
}

// ─── Unicode Superscript & Subscript Maps ────────────────────────────────────

export const TABLE_SUPERSCRIPT_MAP: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
  '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾',
  'n': 'ⁿ', 'i': 'ⁱ', 'x': 'ˣ', 'a': 'ᵃ', 'b': 'ᵇ',
  'c': 'ᶜ', 'd': 'ᵈ', 'e': 'ᵉ', 'm': 'ᵐ', 'p': 'ᵖ',
  'r': 'ʳ', 's': 'ˢ', 't': 'ᵗ', 'y': 'ʸ',
};

export const TABLE_SUBSCRIPT_MAP: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉',
  '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎',
  'a': 'ₐ', 'e': 'ₑ', 'o': 'ₒ', 'x': 'ₓ', 'h': 'ₕ',
  'k': 'ₖ', 'l': 'ₗ', 'm': 'ₘ', 'n': 'ₙ', 'p': 'ₚ',
  's': 'ₛ', 't': 'ₜ', 'r': 'ᵣ', 'i': 'ᵢ', 'j': 'ⱼ',
  'u': 'ᵤ', 'v': 'ᵥ',
};

export function toTableUnicodeSuperscript(str: string): string {
  if (!str) return '';
  let converted = '';
  for (const char of str) {
    if (TABLE_SUPERSCRIPT_MAP[char]) {
      converted += TABLE_SUPERSCRIPT_MAP[char];
    } else {
      return `^(${str})`;
    }
  }
  return converted;
}

export function toTableUnicodeSubscript(str: string): string {
  if (!str) return '';
  let converted = '';
  for (const char of str) {
    if (TABLE_SUBSCRIPT_MAP[char]) {
      converted += TABLE_SUBSCRIPT_MAP[char];
    } else {
      return `_(${str})`;
    }
  }
  return converted;
}

/**
 * Sanitizes table cells by resolving LaTeX font wrappers, superscripts, subscripts,
 * chemistry state symbols, fractions, and math operators into clean Unicode text.
 */
export function cleanTableCellText(text: string): string {
  if (!text || typeof text !== 'string') return '';

  let cleaned = text
    // Replace HTML break tags with newline
    .replace(/<br\s*\/?>/gi, '\n')
    // LLM corrupted control characters (e.g. \text eaten into \t)
    .replace(/\t+ext(?=\{|\s*[A-Za-z0-9])/g, '\\text')
    .replace(/\t+imes\b/g, '\\times')
    .replace(/\r+ightarrow\b/g, '\\rightarrow')

    // Chemistry arrows & reactions
    .replace(/\\xrightarrow\{(.*?)\}/g, ' ──($1)──> ')
    .replace(/\\rightleftharpoons/g, ' ⇌ ')
    .replace(/\\leftrightarrow/g, ' ↔ ')
    .replace(/\\rightarrow/g, ' → ')
    .replace(/\\leftarrow/g, ' ← ')
    .replace(/\\Rightarrow/g, ' ⇒ ')
    .replace(/\\Leftarrow/g, ' ⇐ ')
    .replace(/\\uparrow\b/g, '↑')
    .replace(/\\downarrow\b/g, '↓')

    // State symbols in chemistry: _{aq}, _{(aq)}, _{(s)}, etc.
    .replace(/_\{(s|l|g|aq)\}/gi, '($1)')
    .replace(/_\((s|l|g|aq)\)/gi, '($1)')
    .replace(/_\{(\([a-z]+\))\}/gi, '$1')

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

    // Spacing
    .replace(/\\,/g, ' ')
    .replace(/\\:/g, ' ')
    .replace(/\\;/g, ' ')
    .replace(/\\!/g, '')
    .replace(/\\ /g, ' ')
    .replace(/~/g, ' ')
    .replace(/\\quad/g, '   ')
    .replace(/\\qquad/g, '      ')

    // Temperature & Degree notations
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
    .replace(/\^\{\\circ\}/g, '°')
    .replace(/\^\\circ/g, '°')
    .replace(/\\degree\b/g, '°')
    .replace(/\\circ\b/g, '°')

    // Greek letters
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

    // Units
    .replace(/\\ohm\b/g, 'Ω')
    .replace(/\\angstrom\b/g, 'Å')

    // Roots
    .replace(/\\sqrt\[(.*?)\]\{([^{}]+)\}/g, (_m, n, rad) => `${toTableUnicodeSuperscript(n)}√(${rad})`)
    .replace(/\\sqrt\{([^{}]+)\}/g, '√($1)')

    // Isotopes / nuclides: {}^{40}_{20}Ca -> ⁴⁰₂₀Ca
    .replace(/(?:\{\}\s*)?(?:_\^|\^)\{([^{}]+)\}\s*_\{([^{}]+)\}/g, (_m, sup, sub) => `${toTableUnicodeSuperscript(sup)}${toTableUnicodeSubscript(sub)}`)
    .replace(/(?:\{\}\s*)?_\{([^{}]+)\}\s*\^\{([^{}]+)\}/g, (_m, sub, sup) => `${toTableUnicodeSuperscript(sup)}${toTableUnicodeSubscript(sub)}`);

  // Font wrappers: resolve nested font wrappers (e.g. \text{\textbf{x}}, \ce{\text{...}})
  let prevFont = '';
  while (cleaned !== prevFont) {
    prevFont = cleaned;
    cleaned = cleaned.replace(/\\(text|mathrm|mathbf|mathit|ce|pu|unit|boldsymbol|textnormal|textit|textbf|underline)\{([^{}]+)\}/g, '$2');
  }

  // Fractions
  let prevCleaned = '';
  while (cleaned !== prevCleaned) {
    prevCleaned = cleaned;
    cleaned = cleaned.replace(/\\(?:d)?frac\{([^{}]+)\}\{([^{}]+)\}/g, '$1/$2');
  }

  // Superscripts (e.g. ^{2+}, ^{3-}, ^2, ^+, ^-)
  cleaned = cleaned
    .replace(/\^{([^{}]*)}/g, (_m, p1) => toTableUnicodeSuperscript(p1))
    .replace(/([a-zA-Z0-9)\]])\^(\d*[+-]|[+-]\d+)(?=[\s;,.)\]-]|$)/g, (_m, base, exp) => `${base}${toTableUnicodeSuperscript(exp)}`)
    .replace(/([a-zA-Z0-9)\]])\^([0-9nix])(?![a-zA-Z0-9])/g, (_m, base, exp) => `${base}${toTableUnicodeSuperscript(exp)}`);

  // Subscripts (e.g. _{2}, _{3}, _2, _3, M_r)
  cleaned = cleaned
    .replace(/_{([^{}]*)}/g, (_m, p1) => toTableUnicodeSubscript(p1))
    .replace(/([a-zA-Z0-9)\]])_(\d+)/g, (_m, base, sub) => `${base}${toTableUnicodeSubscript(sub)}`)
    .replace(/([a-zA-Z0-9)\]])_([aeoxhklmnpstrijuv])(?![a-zA-Z0-9])/g, (_m, base, sub) => `${base}${toTableUnicodeSubscript(sub)}`);

  // Strip Markdown & LaTeX math delimiters
  cleaned = cleaned
    .replace(/<[^>]*>/g, ' ')
    .replace(/\$\$(.*?)\$\$/g, '$1')
    .replace(/\$(.*?)\$/g, '$1')
    .replace(/\\\(|\\\)/g, '')
    .replace(/\\\[|\\\]/g, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\\%/g, '%')
    .replace(/\\_/g, '_')
    .replace(/\\&/g, '&')
    .replace(/\\#/g, '#')
    .replace(/\\([{}])/g, '$1')
    .replace(/\{\}/g, '')
    .replace(/[^\S\r\n]+/g, ' ')
    .trim();

  return cleaned;
}

/**
 * Parses markdown table syntax from question text.
 * Handles both multiline and single-line/collapsed pipe formatting.
 */
export function extractMarkdownTable(text: string): ExtractedTableResult {
  if (!text) {
    return { preText: '', table: null, postText: '', rawTableText: '' };
  }

  const normalized = text.replace(/\\n/g, '\n').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Check for presence of markdown table divider (e.g. |---|---| or |:---:|)
  const divMatch = normalized.match(/\|[-:\s|]{3,}\|/);
  if (!divMatch || divMatch.index === undefined) {
    return { preText: text, table: null, postText: '', rawTableText: '' };
  }

  const divIdx = divMatch.index;

  // Find start of table: scan back to previous newline or start of string
  let startLineIdx = normalized.lastIndexOf('\n', divIdx);
  if (startLineIdx === -1) startLineIdx = 0;
  let firstPipe = normalized.indexOf('|', startLineIdx);
  if (firstPipe === -1 || firstPipe > divIdx) {
    firstPipe = normalized.indexOf('|');
  }

  // Find end of table: scan forward to the last contiguous pipe
  const endPipe = normalized.lastIndexOf('|');
  if (endPipe <= firstPipe) {
    return { preText: text, table: null, postText: '', rawTableText: '' };
  }

  const preText = normalized.substring(0, firstPipe).trim();
  const rawTablePart = normalized.substring(firstPipe, endPipe + 1).trim();
  const postText = normalized.substring(endPipe + 1).trim();

  // Normalize single-line collapsed tables (e.g. "... | | col | ...")
  const multiline = rawTablePart.replace(/([^\s|])\s*\|\s*\|/g, '$1 |\n|');
  const lines = multiline
    .split('\n')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);

  const parsedRows: string[][] = [];

  for (const line of lines) {
    if (/^\|[-:\s|]+\|$/.test(line)) {
      continue;
    }
    const cells = line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => cleanTableCellText(c));
    if (cells.length > 0 && cells.some((c) => c.length > 0)) {
      parsedRows.push(cells);
    }
  }

  if (parsedRows.length === 0) {
    return { preText: text, table: null, postText: '', rawTableText: '' };
  }

  const headers = parsedRows[0];
  const rows = parsedRows.slice(1);

  return {
    preText,
    table: {
      headers,
      rows: rows.length > 0 ? rows : [headers],
    },
    postText,
    rawTableText: rawTablePart,
  };
}

/**
 * Extracts table data from structured ExamDataTable objects.
 */
export function extractStructuredTable(dataTables?: ExamDataTable[]): ParsedTableData | null {
  if (!dataTables || dataTables.length === 0) return null;
  const first = dataTables[0];
  if (!first || !Array.isArray(first.headers) || first.headers.length === 0) return null;

  const headers = first.headers.map((h) => cleanTableCellText(String(h || '')));
  const rows: string[][] = [];

  if (first.rows && Array.isArray(first.rows)) {
    for (const r of first.rows) {
      if (Array.isArray(r)) {
        rows.push(
          r.map((cell) => {
            if (typeof cell === 'string') return cleanTableCellText(cell);
            const c = cell as ExamDataTableCell;
            return c.is_blank ? '[   ]' : cleanTableCellText(String(c.value || ''));
          })
        );
      }
    }
  }

  return {
    title: first.title ? cleanTableCellText(first.title) : (first.id ? cleanTableCellText(first.id) : undefined),
    headers,
    rows,
  };
}

export interface TableCanvasOptions {
  title?: string;
  scale?: number; // Scaling factor for Retina/high-DPI sharpness (default 2)
  caption?: string;
}

/**
 * Renders tabular data onto an HTML5 Canvas and returns a high-resolution PNG Data URL.
 * Styled following the official Cambridge International & Edexcel exam paper aesthetic:
 * - Slate-100 header (#f1f5f9) with Slate-900 bold text
 * - Slate-300 borders (#cbd5e1)
 * - Alternating Slate-50 zebra row striping (#f8fafc)
 * - Crisp centered data values
 * - Full Unicode math & chemistry formatting (resolves \text{Ar}, \text{Ca}^{2+}, etc.)
 */
export function renderTableToPngDataUrl(
  tableData: ParsedTableData,
  options?: TableCanvasOptions
): string | null {
  if (typeof document === 'undefined') return null;

  const rawHeaders = tableData.headers || [];
  const rawRows = tableData.rows || [];
  if (rawHeaders.length === 0 && rawRows.length === 0) return null;

  // Defensive clean: ensure all headers and cells are free of raw LaTeX/Markdown
  const headers = rawHeaders.map((h) => cleanTableCellText(h));
  const rows = rawRows.map((r) => r.map((cell) => cleanTableCellText(cell)));
  const displayTitle = options?.title
    ? cleanTableCellText(options.title)
    : (tableData.title ? cleanTableCellText(tableData.title) : undefined);

  const scale = options?.scale || 2; // 2x for razor-sharp Retina display

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Typography & Layout metrics (in CSS pixels, scaled by scale factor)
  const headerFontSize = 14;
  const bodyFontSize = 13.5;
  const titleFontSize = 13;
  const paddingX = 18;
  const paddingY = 11;
  const lineHeight = 20;

  const titleFont = `600 ${titleFontSize * scale}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  const headerFont = `600 ${headerFontSize * scale}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  const bodyFont = `400 ${bodyFontSize * scale}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;

  const numCols = Math.max(headers.length, ...rows.map((r) => r.length));
  const colWidths: number[] = new Array(numCols).fill(0);

  // Measure column widths with multiline support
  ctx.font = headerFont;
  headers.forEach((h, i) => {
    const lines = (h || '').split('\n');
    lines.forEach((line) => {
      const w = ctx.measureText(line).width / scale;
      if (w > colWidths[i]) colWidths[i] = w;
    });
  });

  ctx.font = bodyFont;
  rows.forEach((r) => {
    r.forEach((cell, i) => {
      const lines = (cell || '').split('\n');
      lines.forEach((line) => {
        const w = ctx.measureText(line).width / scale;
        if (w > colWidths[i]) colWidths[i] = w;
      });
    });
  });

  // Apply padding and minimum column width
  for (let i = 0; i < numCols; i++) {
    colWidths[i] = Math.max(colWidths[i] + paddingX * 2, 75);
  }

  let tableWidth = colWidths.reduce((a, b) => a + b, 0);

  // If title exists, ensure table is wide enough for the caption
  const titleBarHeight = displayTitle ? 34 : 0;
  if (displayTitle) {
    ctx.font = titleFont;
    const titleW = ctx.measureText(displayTitle).width / scale + 40;
    if (titleW > tableWidth) {
      const extraPerCol = (titleW - tableWidth) / numCols;
      for (let i = 0; i < numCols; i++) {
        colWidths[i] += extraPerCol;
      }
      tableWidth = titleW;
    }
  }

  // Dynamic row heights based on number of text lines
  const headerLinesCount = Math.max(1, ...headers.map((h) => (h ? h.split('\n').length : 1)));
  const headerHeight = (paddingY * 2 + lineHeight * headerLinesCount + 2) * scale;

  const rowHeights = rows.map((r) => {
    const maxLines = Math.max(1, ...r.map((c) => (c ? c.split('\n').length : 1)));
    return (paddingY * 2 + lineHeight * maxLines) * scale;
  });

  const totalBodyHeight = rowHeights.reduce((a, b) => a + b, 0);
  const totalTableHeight = titleBarHeight * scale + headerHeight + totalBodyHeight;

  // Add outer margin around the card for visual balance
  const margin = 8;
  const canvasWidth = (tableWidth + margin * 2) * scale;
  const canvasHeight = totalTableHeight + margin * 2 * scale;

  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  // White clean background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  const startX = margin * scale;
  let currentY = margin * scale;

  // 1. Draw Title / Caption Bar (if provided)
  if (displayTitle) {
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(startX, currentY, tableWidth * scale, titleBarHeight * scale);

    ctx.font = titleFont;
    ctx.fillStyle = '#334155';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(displayTitle, startX + 14 * scale, currentY + (titleBarHeight / 2) * scale);

    // Divider below title
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1 * scale;
    ctx.beginPath();
    ctx.moveTo(startX, currentY + titleBarHeight * scale);
    ctx.lineTo(startX + tableWidth * scale, currentY + titleBarHeight * scale);
    ctx.stroke();

    currentY += titleBarHeight * scale;
  }

  // 2. Draw Table Header
  ctx.fillStyle = '#f1f5f9';
  ctx.fillRect(startX, currentY, tableWidth * scale, headerHeight);

  ctx.font = headerFont;
  ctx.fillStyle = '#0f172a';
  ctx.textBaseline = 'middle';

  let curX = startX;
  for (let c = 0; c < numCols; c++) {
    const colW = colWidths[c] * scale;
    const headerText = headers[c] || '';
    const hLines = headerText.split('\n');
    const blockH = hLines.length * lineHeight * scale;
    const topTextY = currentY + (headerHeight - blockH) / 2 + (lineHeight / 2) * scale;

    hLines.forEach((l, lIdx) => {
      ctx.textAlign = 'center';
      ctx.fillText(l, curX + colW / 2, topTextY + lIdx * lineHeight * scale);
    });

    curX += colW;
  }

  currentY += headerHeight;

  // 3. Draw Body Rows with Alternating Striping
  ctx.font = bodyFont;

  rows.forEach((row, rIdx) => {
    const thisRowH = rowHeights[rIdx];

    // Alternating zebra row fill
    if (rIdx % 2 === 1) {
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(startX, currentY, tableWidth * scale, thisRowH);
    }

    curX = startX;
    for (let c = 0; c < numCols; c++) {
      const colW = colWidths[c] * scale;
      const cellText = row[c] || '';
      ctx.fillStyle = '#334155';

      const cellLines = cellText.split('\n');
      const blockH = cellLines.length * lineHeight * scale;
      const topTextY = currentY + (thisRowH - blockH) / 2 + (lineHeight / 2) * scale;

      cellLines.forEach((l, lIdx) => {
        const lineY = topTextY + lIdx * lineHeight * scale;
        // Left align longer sentences, center-align standard data/formulas
        if (cellText.length > 25 && cellLines.length === 1) {
          ctx.textAlign = 'left';
          ctx.fillText(l, curX + paddingX * scale, lineY);
        } else {
          ctx.textAlign = 'center';
          ctx.fillText(l, curX + colW / 2, lineY);
        }
      });

      curX += colW;
    }

    currentY += thisRowH;
  });

  // 4. Draw Grid Lines and Borders
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1 * scale;

  const tableTopY = displayTitle ? margin * scale + titleBarHeight * scale : margin * scale;
  const tableBottomY = currentY;

  // Outer border around the table
  ctx.strokeRect(startX, margin * scale, tableWidth * scale, totalTableHeight);

  // Horizontal divider below header (bold 1.5px)
  let dividerY = tableTopY + headerHeight;
  ctx.lineWidth = 1.5 * scale;
  ctx.beginPath();
  ctx.moveTo(startX, dividerY);
  ctx.lineTo(startX + tableWidth * scale, dividerY);
  ctx.stroke();

  // Horizontal row dividers
  ctx.lineWidth = 1 * scale;
  ctx.strokeStyle = '#e2e8f0';
  for (let r = 0; r < rows.length - 1; r++) {
    dividerY += rowHeights[r];
    ctx.beginPath();
    ctx.moveTo(startX, dividerY);
    ctx.lineTo(startX + tableWidth * scale, dividerY);
    ctx.stroke();
  }

  // Vertical column dividers
  ctx.strokeStyle = '#cbd5e1';
  curX = startX;
  for (let c = 0; c < numCols - 1; c++) {
    curX += colWidths[c] * scale;
    ctx.beginPath();
    ctx.moveTo(curX, tableTopY);
    ctx.lineTo(curX, tableBottomY);
    ctx.stroke();
  }

  return canvas.toDataURL('image/png');
}

/**
 * Composites a rendered table image and an existing diagram image into a single vertically stacked PNG.
 * Places the table on top and the diagram below, centered with a clean margin.
 */
export async function compositeTableAndDiagram(
  tableDataUrl: string,
  diagramUrl: string
): Promise<string> {
  if (typeof document === 'undefined') return tableDataUrl;

  return new Promise((resolve) => {
    try {
      const tableImg = new Image();
      tableImg.crossOrigin = 'anonymous';

      tableImg.onload = () => {
        const diagImg = new Image();
        diagImg.crossOrigin = 'anonymous';

        diagImg.onload = () => {
          const gap = 24;
          const maxWidth = Math.max(tableImg.naturalWidth, diagImg.naturalWidth);
          const totalHeight = tableImg.naturalHeight + gap + diagImg.naturalHeight;

          const canvas = document.createElement('canvas');
          canvas.width = maxWidth;
          canvas.height = totalHeight;
          const ctx = canvas.getContext('2d');
          if (!ctx) return resolve(tableDataUrl);

          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, maxWidth, totalHeight);

          // Center table at top
          const tableX = Math.round((maxWidth - tableImg.naturalWidth) / 2);
          ctx.drawImage(tableImg, tableX, 0);

          // Center diagram underneath
          const diagX = Math.round((maxWidth - diagImg.naturalWidth) / 2);
          ctx.drawImage(diagImg, diagX, tableImg.naturalHeight + gap);

          resolve(canvas.toDataURL('image/png'));
        };

        diagImg.onerror = () => resolve(tableDataUrl);
        diagImg.src = diagramUrl;
      };

      tableImg.onerror = () => resolve(tableDataUrl);
      tableImg.src = tableDataUrl;
    } catch {
      resolve(tableDataUrl);
    }
  });
}

/**
 * Converts a base64 Data URL to a Blob for uploading to Cloudflare R2 / storage.
 */
export function dataUrlToBlob(dataUrl: string): Blob | null {
  try {
    const parts = dataUrl.split(',');
    if (parts.length < 2) return null;
    const mimeMatch = parts[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    const binary = atob(parts[1]);
    const array = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      array[i] = binary.charCodeAt(i);
    }
    return new Blob([array], { type: mime });
  } catch {
    return null;
  }
}

/**
 * Fallback Text Formatter:
 * Converts tabular data into clean, mobile-friendly bulleted cards.
 * Never uses broken box-drawing characters (┌, ─, ┬, │, └).
 */
export function formatTableToCleanText(tableData: ParsedTableData): string {
  const rawHeaders = tableData.headers || [];
  const rawRows = tableData.rows || [];
  if (rawRows.length === 0) return '';

  const headers = rawHeaders.map((h) => cleanTableCellText(h));
  const rows = rawRows.map((r) => r.map((c) => cleanTableCellText(c)));
  const title = tableData.title ? cleanTableCellText(tableData.title) : undefined;

  const lines: string[] = [];
  if (title) {
    lines.push(`[ ${title} ]`);
  }

  // If table has 2 or 3 columns, format as clean key-value bullets:
  // e.g. "• W: Nucleon number = 35 | Number of neutrons = 18"
  if (headers.length >= 2 && headers.length <= 4) {
    rows.forEach((row) => {
      const primaryKey = row[0] || '';
      const otherCols = row.slice(1);
      const details = otherCols
        .map((val, idx) => {
          const headerName = headers[idx + 1] || `Col ${idx + 2}`;
          return `${headerName}: ${val}`;
        })
        .join(' | ');

      lines.push(`• ${primaryKey}${details ? ` (${details})` : ''}`);
    });
  } else {
    // For wide tables, format with clean dot-delimiters
    lines.push(headers.join('  •  '));
    lines.push('─'.repeat(Math.min(45, headers.join('  •  ').length)));
    rows.forEach((row) => {
      lines.push(row.join('  •  '));
    });
  }

  return lines.join('\n');
}
