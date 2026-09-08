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
  let endPipe = normalized.lastIndexOf('|');
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
      .map((c) => c.trim().replace(/\s+/g, ' '));
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

  const headers = first.headers.map((h) => String(h || '').trim());
  const rows: string[][] = [];

  if (first.rows && Array.isArray(first.rows)) {
    for (const r of first.rows) {
      if (Array.isArray(r)) {
        rows.push(
          r.map((cell) => {
            if (typeof cell === 'string') return cell.trim();
            const c = cell as ExamDataTableCell;
            return c.is_blank ? '[   ]' : String(c.value || '').trim();
          })
        );
      }
    }
  }

  return {
    title: first.title || first.id || undefined,
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
 */
export function renderTableToPngDataUrl(
  tableData: ParsedTableData,
  options?: TableCanvasOptions
): string | null {
  if (typeof document === 'undefined') return null;

  const { headers, rows, title: tableTitle } = tableData;
  if (!headers || headers.length === 0) return null;

  const displayTitle = options?.title || tableTitle;
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

  // Measure column widths
  ctx.font = headerFont;
  headers.forEach((h, i) => {
    const w = ctx.measureText(h).width / scale;
    if (w > colWidths[i]) colWidths[i] = w;
  });

  ctx.font = bodyFont;
  rows.forEach((r) => {
    r.forEach((cell, i) => {
      const w = ctx.measureText(cell).width / scale;
      if (w > colWidths[i]) colWidths[i] = w;
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

  const rowHeight = paddingY * 2 + lineHeight;
  const headerHeight = rowHeight + 2;
  const totalTableHeight = titleBarHeight + headerHeight + rows.length * rowHeight;

  // Add outer margin around the card for visual balance
  const margin = 8;
  const canvasWidth = (tableWidth + margin * 2) * scale;
  const canvasHeight = (totalTableHeight + margin * 2) * scale;

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
  ctx.fillRect(startX, currentY, tableWidth * scale, headerHeight * scale);

  ctx.font = headerFont;
  ctx.fillStyle = '#0f172a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  let curX = startX;
  for (let c = 0; c < numCols; c++) {
    const colW = colWidths[c] * scale;
    const headerText = headers[c] || '';
    ctx.fillText(headerText, curX + colW / 2, currentY + (headerHeight / 2) * scale);
    curX += colW;
  }

  currentY += headerHeight * scale;

  // 3. Draw Body Rows with Alternating Striping
  ctx.font = bodyFont;

  rows.forEach((row, rIdx) => {
    // Alternating zebra row fill
    if (rIdx % 2 === 1) {
      ctx.fillStyle = '#f8fafc';
      ctx.fillRect(startX, currentY, tableWidth * scale, rowHeight * scale);
    }

    curX = startX;
    for (let c = 0; c < numCols; c++) {
      const colW = colWidths[c] * scale;
      const cellText = row[c] || '';
      ctx.fillStyle = '#334155';

      // Use left alignment for longer sentences (>25 chars), center alignment for data values
      if (cellText.length > 25) {
        ctx.textAlign = 'left';
        ctx.fillText(cellText, curX + paddingX * scale, currentY + (rowHeight / 2) * scale);
      } else {
        ctx.textAlign = 'center';
        ctx.fillText(cellText, curX + colW / 2, currentY + (rowHeight / 2) * scale);
      }
      curX += colW;
    }

    currentY += rowHeight * scale;
  });

  // 4. Draw Grid Lines and Borders
  ctx.strokeStyle = '#cbd5e1';
  ctx.lineWidth = 1 * scale;

  const tableTopY = displayTitle ? margin * scale + titleBarHeight * scale : margin * scale;
  const tableBottomY = currentY;

  // Outer border around the table
  ctx.strokeRect(startX, margin * scale, tableWidth * scale, totalTableHeight * scale);

  // Horizontal divider below header (bold 1.5px)
  ctx.lineWidth = 1.5 * scale;
  ctx.beginPath();
  ctx.moveTo(startX, tableTopY + headerHeight * scale);
  ctx.lineTo(startX + tableWidth * scale, tableTopY + headerHeight * scale);
  ctx.stroke();

  // Horizontal row dividers
  ctx.lineWidth = 1 * scale;
  ctx.strokeStyle = '#e2e8f0';
  for (let r = 1; r < rows.length; r++) {
    const y = tableTopY + headerHeight * scale + r * rowHeight * scale;
    ctx.beginPath();
    ctx.moveTo(startX, y);
    ctx.lineTo(startX + tableWidth * scale, y);
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
  const { headers, rows, title } = tableData;
  if (!rows || rows.length === 0) return '';

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
