// ─── PDF / Print Export Service ─────────────────────────────────────────────
// Opens high-resolution, print-optimized document windows for saving as PDF
// with support for authentic Cambridge, Modern Worksheet, Answer Booklet, and Mark Scheme layouts.

import type { Question } from '../types/database';
import type { ExamHeaderConfig } from './testBuilderService';
import type { ExportLayoutOptions } from '../types/exportTemplates';
import { getCambridgeCoverDetails, renderCambridgeCoverPageHtml, renderMcqAnswerSheetHtml } from './cambridgeCoverService';
import { parseMcqOption } from '../utils/mcqUtils';
import { renderPeriodicTableHtml } from './periodicTableService';
import { DEFAULT_SCHOOL_LOGO, DEFAULT_CAMBRIDGE_LOGO } from '../assets/logoConstants';
import { autoFormatChemistryAndMath, protectCurrencySymbols, restoreCurrencySymbols } from '../components/ExamMathText';
import { isInsertResource, resolveQuestionResources } from '../utils/questionResourceHelper';

/**
 * Formats LaTeX math formulas, Greek symbols, and sub/superscripts to clean HTML
 */
export function formatLatexForHtml(text: string): string {
  if (!text) return '';
  // 1. Unescape literal '\n' sequences from database/JSON strings
  const unescaped = text.replace(/\\n/g, '\n');
  const protectedText = protectCurrencySymbols(unescaped);
  const chemFormatted = autoFormatChemistryAndMath(protectedText);
  const formatted = chemFormatted
    // Markdown bold: **text** or __text__ -> <strong>text</strong>
    .replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+?)__/g, '<strong>$1</strong>')
    // Markdown italic: *text* -> <em>text</em>
    .replace(/(^|[^*])\*([^*]+?)\*(?!\*)/g, '$1<em>$2</em>')
    // Replace arrows & special math symbols
    .replace(/\\xrightarrow\[(.*?)\]\{(.*?)\}/g, ' ──[$1]($2)──> ')
    .replace(/\\xrightarrow\{(.*?)\}/g, ' ──($1)──> ')
    .replace(/\\rightarrow/g, ' → ')
    .replace(/\\leftarrow/g, ' ← ')
    .replace(/\\rightleftharpoons/g, ' ⇌ ')
    .replace(/\\times/g, ' × ')
    .replace(/\\cdot/g, ' · ')
    .replace(/\\div/g, ' ÷ ')
    .replace(/\\pm/g, ' ± ')
    .replace(/\\mp/g, ' ∓ ')
    .replace(/\\approx/g, ' ≈ ')
    .replace(/\\neq/g, ' ≠ ')
    .replace(/\\le(q)?/g, ' ≤ ')
    .replace(/\\ge(q)?/g, ' ≥ ')
    .replace(/\\infty/g, ' ∞ ')
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
    .replace(/\^\{\\circ\s*\\mathrm\{\s*C\s*\}\}/gi, '°C')
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
    // Greek letters
    .replace(/\\Delta/g, 'Δ')
    .replace(/\\delta/g, 'δ')
    .replace(/\\alpha/g, 'α')
    .replace(/\\beta/g, 'β')
    .replace(/\\gamma/g, 'γ')
    .replace(/\\theta/g, 'θ')
    .replace(/\\pi/g, 'π')
    .replace(/\\mu/g, 'μ')
    .replace(/\\sigma/g, 'σ')
    .replace(/\\omega/g, 'ω')
    .replace(/\\Omega/g, 'Ω')
    .replace(/\\lambda/g, 'λ')
    .replace(/\\phi/g, 'ϕ')
    // Fractions: \frac{a}{b} -> (a / b)
    .replace(/\\frac\{(.*?)\}\{(.*?)\}/g, '($1 / $2)')
    // Font wrappers inside LaTeX
    .replace(/\\text\{(.*?)\}/g, '$1')
    .replace(/\\mathrm\{(.*?)\}/g, '$1')
    .replace(/\\mathbf\{(.*?)\}/g, '$1')
    .replace(/\\mathit\{(.*?)\}/g, '$1')
    .replace(/\\ce\{([^{}]+)\}/g, '$1')
    .replace(/\\quad/g, '   ')
    .replace(/\\qquad/g, '      ')
    // Remove outer LaTeX math delimiters while keeping content
    .replace(/\$\$(.*?)\$\$/g, '$1')
    .replace(/\$(.*?)\$/g, '$1')
    .replace(/\\\[(.*?)\\\]/g, '$1')
    .replace(/\\\((.*?)\\\)/g, '$1')
    // 1. Nuclide / Isotope notation: {}^{40}_{20}W or _{20}^{40}W or \prescript{40}{20}W -> vertically stacked
    .replace(/(?:\{\}\s*)?(?:_\^|\^)\{([^{}]+)\}\s*_\{([^{}]+)\}/g, '<span class="nuclide-stack" style="display:inline-flex; flex-direction:column; vertical-align:middle; line-height:0.92; font-size:0.72em; text-align:right; margin-right:1.5px; font-family:inherit;"><span>$1</span><span>$2</span></span>')
    .replace(/(?:\{\}\s*)?_\{([^{}]+)\}\s*\^\{([^{}]+)\}/g, '<span class="nuclide-stack" style="display:inline-flex; flex-direction:column; vertical-align:middle; line-height:0.92; font-size:0.72em; text-align:right; margin-right:1.5px; font-family:inherit;"><span>$2</span><span>$1</span></span>')
    .replace(/(?:\{\}\s*)?(?:_\^|\^)([0-9a-zA-Z]+)\s*_([0-9a-zA-Z]+)/g, '<span class="nuclide-stack" style="display:inline-flex; flex-direction:column; vertical-align:middle; line-height:0.92; font-size:0.72em; text-align:right; margin-right:1.5px; font-family:inherit;"><span>$1</span><span>$2</span></span>')
    .replace(/(?:\{\}\s*)?_([0-9a-zA-Z]+)\s*\^([0-9a-zA-Z]+)/g, '<span class="nuclide-stack" style="display:inline-flex; flex-direction:column; vertical-align:middle; line-height:0.92; font-size:0.72em; text-align:right; margin-right:1.5px; font-family:inherit;"><span>$2</span><span>$1</span></span>')
    .replace(/\\prescript\{([^{}]+)\}\{([^{}]+)\}/g, '<span class="nuclide-stack" style="display:inline-flex; flex-direction:column; vertical-align:middle; line-height:0.92; font-size:0.72em; text-align:right; margin-right:1.5px; font-family:inherit;"><span>$1</span><span>$2</span></span>')
    // 2. Remove any remaining orphan empty braces {}
    .replace(/\{\}/g, '')
    // Clean percentage escaping
    .replace(/\\%/g, '%')
    // Subscripts & Superscripts to HTML tags
    .replace(/_{([^{}]*)}/g, '<sub>$1</sub>')
    .replace(/\^{([^{}]*)}/g, '<sup>$1</sup>')
    .replace(/([a-zA-Z0-9)\]])_([0-9a-zA-Z+\-*]+)/g, '$1<sub>$2</sub>')
    .replace(/\^([0-9a-zA-Z+\-*]+)/g, '<sup>$1</sup>')
    // Convert newlines to HTML line breaks so multi-line text and numbered statements render cleanly
    .replace(/\r\n/g, '\n')
    .replace(/\n\s*\n/g, '<br /><br />')
    .replace(/\n/g, '<br />');

  return restoreCurrencySymbols(formatted);
}

/**
 * Converts text and embedded markdown tables into styled HTML
 */
function convertMarkdownTablesToHtml(text: string): string {
  if (!text) return '';
  const lines = text.replace(/\\n/g, '\n').split('\n');
  const result: string[] = [];
  let inTable = false;
  let tableLines: string[] = [];

  const flushTable = () => {
    if (tableLines.length === 0) return;
    const rawRows = tableLines
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !/^\|[-:\s|]+\|$/.test(l));

    if (rawRows.length > 0) {
      const headers = rawRows[0]
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      const body = rawRows.slice(1).map((r) =>
        r
          .slice(1, -1)
          .split('|')
          .map((c) => c.trim())
      );

      let tableHtml =
        '<div style="margin: 12px 0; overflow-x: auto;"><table style="width: 100%; border-collapse: collapse; border: 1.5px solid #374151; font-size: 13px; background: white;">';
      tableHtml +=
        '<thead><tr>' +
        headers
          .map(
            (h) =>
              `<th style="border: 1px solid #4b5563; padding: 6px 10px; background: #f3f4f6; font-weight: bold; text-align: center;">${formatLatexForHtml(h)}</th>`
          )
          .join('') +
        '</tr></thead><tbody>';

      body.forEach((row) => {
        tableHtml +=
          '<tr>' +
          row
            .map(
              (cell) =>
                `<td style="border: 1px solid #6b7280; padding: 6px 10px; text-align: center;">${formatLatexForHtml(cell)}</td>`
            )
            .join('') +
          '</tr>';
      });

      tableHtml += '</tbody></table></div>';
      result.push(tableHtml);
    }
    tableLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const isTableRow = trimmed.startsWith('|') && trimmed.endsWith('|');
    if (isTableRow) {
      inTable = true;
      tableLines.push(line);
    } else {
      if (inTable) {
        flushTable();
        inTable = false;
      }

      // Check for Flowchart / Process sequence
      const boxMatches = trimmed.match(/\[\s*[^\]]+?\s*\]/g);
      const hasArrows = /(?:→|->|\\rightarrow)/.test(trimmed);
      if (boxMatches && boxMatches.length >= 2 && hasArrows) {
        const stages = trimmed.split(/\s*(?:→|->|\\rightarrow)\s*/).map((part) => {
          const clean = part.replace(/^\[\s*/, '').replace(/\s*\]$/, '').trim();
          return clean;
        });

        let flowHtml =
          '<div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:10px; margin:14px 0; padding:12px; background:#f9fafb; border:1px solid #e5e7eb; border-radius:6px;">';
        stages.forEach((stage, sIdx) => {
          flowHtml += `<div style="display:inline-flex; align-items:center; justify-content:center; min-width:95px; min-height:48px; padding:6px 14px; border:1.5px solid #1f2937; background:white; font-weight:500; text-align:center;">${formatLatexForHtml(stage)}</div>`;
          if (sIdx < stages.length - 1) {
            flowHtml += '<span style="font-weight:bold; font-size:16px; color:#4b5563;">→</span>';
          }
        });
        flowHtml += '</div>';
        result.push(flowHtml);
        continue;
      }

      // Check for Tick Box lines
      const leadingTick = trimmed.match(/^(?:[-*]\s*)?\[\s*([✓xXvV]?)\s*\]\s+(.+)$/);
      if (leadingTick) {
        const checked = !!leadingTick[1].trim();
        result.push(
          `<div style="display:flex; align-items:center; max-width:360px; margin:4px 0;"><span style="display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; border:1.5px solid #111; background:white; margin-right:10px; font-weight:bold; font-size:12px;">${checked ? '✓' : ''}</span><span>${formatLatexForHtml(leadingTick[2].trim())}</span></div>`
        );
        continue;
      }

      const trailingTick = trimmed.match(/^(.+?)\s+\[\s*([✓xXvV]?)\s*\]$/);
      if (trailingTick) {
        const checked = !!trailingTick[2].trim();
        result.push(
          `<div style="display:flex; justify-content:space-between; align-items:center; max-width:360px; margin:4px 0;"><span>${formatLatexForHtml(trailingTick[1].trim())}</span><span style="display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; border:1.5px solid #111; background:white; margin-left:14px; font-weight:bold; font-size:12px;">${checked ? '✓' : ''}</span></div>`
        );
        continue;
      }

      result.push(formatLatexForHtml(line));
    }
  }
  if (inTable) flushTable();

  return result.join('<br />');
}

/**
 * Opens a clean printable window formatted for Student Exam Paper PDF export
 */
export function openStudentPaperPrintWindow(
  headerConfig: ExamHeaderConfig,
  rawQuestions: Question[],
  options: Partial<ExportLayoutOptions> = {}
) {
  const questions = resolveQuestionResources(rawQuestions, {
    autoRenumberFigures: options.autoRenumberFigures ?? true,
  });
  const {
    template = 'cambridge_official',
    columns = 1,
    includeAnswerLines = true,
    linesPerMark = 2,
    answerLineStyle = 'dotted',
    schoolName = '',
    showTurnOverNotice = true,
  } = options;

  const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0);

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Please allow popups to open the print-ready PDF window.');
    return;
  }

  const isCambridge = template === 'cambridge_official';
  const isWorksheet = template === 'school_worksheet';
  const isSeparate = template === 'separate_answer_booklet';

  const answerLineBorder = answerLineStyle === 'dotted' ? '1.5px dotted #64748b' : '1.2px solid #94a3b8';

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${headerConfig.title || 'Exam Paper'} — Student Assessment</title>
  <style>
    @page {
      size: A4;
      margin: 15mm 15mm 20mm 15mm;
      @top-center {
        content: counter(page);
        font-weight: bold;
        font-family: Arial, sans-serif;
        font-size: 12pt;
      }
    }
    @page:first {
      @top-center {
        content: none;
      }
    }
    body {
      font-family: ${isCambridge ? '"Times New Roman", Times, Georgia, serif' : 'Arial, sans-serif'};
      color: #111;
      line-height: 1.5;
      margin: 0;
      padding: 10px;
      background: white;
    }
    .no-print {
      text-align: center;
      padding: 12px;
      background: #e0e7ff;
      color: #3730a3;
      font-family: Arial, sans-serif;
      font-size: 13px;
      margin-bottom: 20px;
      border-radius: 6px;
      border: 1px solid #c7d2fe;
    }
    @media print {
      .no-print { display: none; }
    }

    /* Cambridge Candidate Box */
    .cambridge-cand-box {
      border: 1.5px solid #111;
      padding: 10px 14px;
      margin-bottom: 18px;
    }
    .cambridge-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      font-family: Arial, sans-serif;
      font-size: 13px;
      font-weight: bold;
    }
    .box-grid {
      display: inline-flex;
      gap: 4px;
      margin-left: 6px;
    }
    .grid-square {
      width: 18px;
      height: 18px;
      border: 1.5px solid #111;
      display: inline-block;
    }

    /* Worksheet Header Box */
    .worksheet-header-box {
      border: 1.5px solid #cbd5e1;
      background: #f8fafc;
      padding: 12px 16px;
      margin-bottom: 18px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-radius: 6px;
    }
    .worksheet-school-title {
      font-size: 18px;
      font-weight: bold;
      color: #1e40af;
      margin-bottom: 4px;
    }
    .worksheet-cand-details {
      font-size: 13px;
      color: #334155;
    }
    .worksheet-score-box {
      border: 2px solid #1e293b;
      background: white;
      padding: 8px 16px;
      text-align: center;
      min-width: 100px;
      border-radius: 4px;
    }
    .score-label {
      font-size: 11px;
      font-weight: bold;
      color: #64748b;
      text-transform: uppercase;
    }
    .score-val {
      font-size: 20px;
      font-weight: bold;
      color: #0f172a;
    }

    /* Title Block */
    .title-block {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      border-bottom: 2px solid #111;
      padding-bottom: 8px;
      margin-bottom: 16px;
    }
    .title {
      font-size: 20px;
      font-weight: bold;
      margin: 0 0 4px;
    }
    .subtitle {
      font-size: 14px;
      color: #333;
      font-weight: bold;
    }

    /* Instructions Box */
    .inst-box {
      border: 1px solid #777;
      padding: 10px 14px;
      font-family: Arial, sans-serif;
      font-size: 12px;
      margin-bottom: 24px;
      background: #fafafa;
      text-align: justify;
    }

    /* Question Stream Container (1 or 2 columns) */
    .questions-container {
      ${columns === 2 ? 'column-count: 2; column-gap: 24px; column-rule: 1px solid #e2e8f0;' : ''}
    }

    .q-block {
      margin-bottom: 28px;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .q-header {
      display: flex;
      align-items: baseline;
      gap: 10px;
      font-size: 15px;
    }
    .q-num {
      font-weight: bold;
      font-size: 16px;
      min-width: 22px;
    }
    .q-text {
      flex: 1;
      line-height: 1.6;
      text-align: justify;
    }
    .mcq-choice {
      margin: 6px 0 6px 32px;
      font-size: 14px;
    }
    .sub-block {
      margin: 12px 0 12px 24px;
    }
    .sub-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 8px;
      font-size: 14px;
    }
    .sub-id {
      font-weight: bold;
      min-width: 26px;
    }
    .sub-text {
      flex: 1;
      text-align: justify;
    }
    .marks {
      font-weight: bold;
      font-size: 13px;
      white-space: nowrap;
    }
    .ans-lines {
      margin: 14px 0 16px 26px;
      display: flex;
      flex-direction: column;
      gap: 34px;
    }
    .ans-line {
      border-bottom: ${answerLineBorder};
      height: 1px;
      width: 100%;
    }
    .total-row {
      text-align: right;
      font-weight: bold;
      font-size: 14px;
      margin-top: 6px;
    }
    .turn-over {
      text-align: right;
      font-style: italic;
      font-size: 12px;
      color: #64748b;
      margin-top: 16px;
    }
  </style>
</head>
<body>
  <div class="no-print">
    <strong>Print Ready Preview (${isCambridge ? 'Cambridge Official' : isWorksheet ? 'Modern Worksheet' : 'Question Paper'})</strong> — Press <code>Ctrl + P</code> (or Cmd + P) to Save as PDF or Print.
  </div>

  ${
    isCambridge
      ? renderCambridgeCoverPageHtml(getCambridgeCoverDetails(headerConfig, questions))
      : `
    ${
      isWorksheet
        ? `
      <div class="worksheet-header-box">
        <div>
          ${schoolName || headerConfig.schoolName ? `<div class="worksheet-school-title">${schoolName || headerConfig.schoolName}</div>` : ''}
          <div class="worksheet-cand-details">
            <strong>Student Name:</strong> ___________________________ &nbsp;&nbsp;
            <strong>Class:</strong> _______ &nbsp;&nbsp;
            <strong>Date:</strong> _______
          </div>
        </div>
        <div class="worksheet-score-box">
          <div class="score-label">Score / Grade</div>
          <div class="score-val">___ / ${totalMarks}</div>
        </div>
      </div>
      `
        : `
      <div style="border: 1px solid #111; padding: 8px 12px; margin-bottom: 16px; font-size: 13px; font-weight: bold;">
        NAME: _____________________________________ &nbsp;&nbsp;&nbsp;&nbsp; DATE: ____________
      </div>
      `
    }

    <div class="title-block">
      <div>
        <h1 class="title">${headerConfig.title || 'Examination Assessment'}</h1>
        <div class="subtitle">${headerConfig.subject || ''} ${headerConfig.subjectCode ? `(${headerConfig.subjectCode})` : ''}</div>
      </div>
      <div style="text-align: right;">
        <div style="font-weight: bold; font-size: 14px;">${headerConfig.durationMinutes || 45} minutes</div>
        <div style="font-weight: bold; font-size: 13px; border: 1px solid #111; padding: 2px 8px; margin-top: 4px; display: inline-block;">Total Marks: ${totalMarks}</div>
      </div>
    </div>

    ${
      headerConfig.instructions
        ? `<div class="inst-box">
            <div style="font-weight: bold; margin-bottom: 4px;">INSTRUCTIONS TO CANDIDATES:</div>
            <div>• ${headerConfig.instructions}</div>
            ${headerConfig.additionalMaterials ? `<div>• Additional Materials: ${headerConfig.additionalMaterials}</div>` : ''}
            <div>• The number of marks is given in brackets [ ] at the end of each question or part question.</div>
          </div>`
        : ''
    }
    `
  }

  <div class="questions-container">
    ${questions
      .map((q, idx) => {
        const qNum = idx + 1;
        const stem = convertMarkdownTablesToHtml(q.question_text);

        let content = `
          <div class="q-block">
            <div class="q-header">
              <span class="q-num">${qNum}.</span>
              <div class="q-text">${stem}</div>
            </div>
        `;

        const diagramUrl = q.diagram_url || (q as any).image_url || (q as any).diagram_base64;
        const isInsert = isInsertResource(q);
        // Only show diagram on the question paper if an insert booklet is NOT attached, or if it is a QP diagram
        if (diagramUrl && (!options.includeInsertBooklet || !isInsert)) {
          content += `
            <div class="q-diagram-container" style="text-align: center; margin: 12px 0;">
              <img src="${diagramUrl}" alt="Question ${qNum} Diagram" style="max-width: 85%; max-height: 280px; object-fit: contain; border-radius: 4px;" />
              <div style="font-weight: bold; font-size: 13px; margin-top: 6px; text-align: center; font-family: 'Times New Roman', serif;">${q.resource_ref || `Fig. ${qNum}.1`}</div>
            </div>
          `;
        }

        if (q.options && q.options.length > 0) {
          q.options.forEach((opt, optIdx) => {
            const { letter, text } = parseMcqOption(opt, optIdx);
            content += `
              <div class="mcq-choice" style="display: flex; align-items: baseline; margin: 6px 0 6px 32px; font-size: 14px;">
                <span style="font-weight: bold; min-width: 28px; margin-right: 14px; font-size: 15px;">${letter}</span>
                <div style="flex: 1; text-align: justify;">${formatLatexForHtml(text)}</div>
              </div>
            `;
          });
        }

        if (q.sub_questions && q.sub_questions.length > 0) {
          q.sub_questions.forEach((sub) => {
            content += `
              <div class="sub-block">
                <div class="sub-row">
                  <div class="sub-id">${sub.sub_id}</div>
                  <div class="sub-text">${convertMarkdownTablesToHtml(sub.question_text)}</div>
                  <div class="marks">[${sub.marks}]</div>
                </div>
            `;

            const subDiagramUrl = (sub as any).diagram_url || (sub as any).image_url || (sub as any).diagram_base64;
            const isSubInsert = isInsertResource(sub);
            // Only show sub-diagram on question paper if booklet is NOT attached, or if it is a QP diagram
            if (subDiagramUrl && (!options.includeInsertBooklet || !isSubInsert)) {
              content += `
                <div class="q-diagram-container" style="text-align: center; margin: 8px 0;">
                  <img src="${subDiagramUrl}" alt="Sub-question Diagram" style="max-width: 80%; max-height: 220px; object-fit: contain; border-radius: 4px;" />
                  <div style="font-weight: bold; font-size: 13px; margin-top: 6px; text-align: center; font-family: 'Times New Roman', serif;">${sub.resource_ref || `Fig. ${qNum}.2`}</div>
                </div>
              `;
            }

            if (includeAnswerLines && !isSeparate) {
              const lineCount = Math.max(2, (sub.marks || 1) * linesPerMark);
              content += `<div class="ans-lines">`;
              for (let li = 0; li < lineCount; li++) {
                content += `<div class="ans-line"></div>`;
              }
              content += `</div>`;
            }

            content += `</div>`;
          });
        } else if (includeAnswerLines && !isSeparate && (!q.options || q.options.length === 0)) {
          const lineCount = Math.max(2, (q.marks || 1) * linesPerMark);
          content += `<div class="ans-lines">`;
          for (let li = 0; li < lineCount; li++) {
            content += `<div class="ans-line"></div>`;
          }
          content += `</div>`;
        }

        content += `
            <div class="total-row">[Total: ${q.marks || 1}]</div>
          </div>
        `;

        return content;
      })
      .join('')}
  </div>

  ${showTurnOverNotice ? `<div class="turn-over">[Turn over</div>` : ''}

  ${
    options.includeMcqAnswerSheet
      ? `
    <!-- Attached Multiple Choice Answer Sheet -->
    <div style="page-break-before: always; break-before: page; margin-top: 30px;">
      ${renderMcqAnswerSheetHtml(headerConfig, questions, options)}
    </div>
    `
      : ''
  }

  ${
    options.includePeriodicTable
      ? `
    <!-- Attached Cambridge IGCSE Periodic Table of Elements -->
    ${renderPeriodicTableHtml({ rotated: true })}
    `
      : ''
  }

  ${
    options.includeInsertBooklet
      ? `
    <!-- Attached Cambridge IGCSE Insert / Resource Booklet -->
    ${renderInsertBookletSectionHtml(headerConfig, questions, options)}
    `
      : ''
  }

  <script>
    window.addEventListener('DOMContentLoaded', () => {
      // Calculate realistic A4 page height (approx 1020px printable area per page)
      const printablePageHeight = 1020;
      const questionsContainer = document.querySelector('.questions-container');
      const countEl = document.getElementById('cambridge-page-count');
      
      if (questionsContainer && countEl) {
        const contentHeight = questionsContainer.scrollHeight;
        const questionPages = Math.max(1, Math.ceil(contentHeight / printablePageHeight));
        const totalCalculatedPages = 1 + questionPages + ${options.includeMcqAnswerSheet ? 1 : 0} + ${options.includePeriodicTable ? 1 : 0} + ${options.includeInsertBooklet ? 1 : 0}; // Cover + Questions + Extras
        countEl.textContent = String(totalCalculatedPages);
      }
      
      setTimeout(() => { window.print(); }, 400);
    });
  </script>
</body>
</html>`;

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}

/**
 * Opens a dedicated Cambridge IGCSE Periodic Table in a printable window
 */
export function openPeriodicTablePrintWindow(headerConfig: ExamHeaderConfig) {
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Please allow popups to open the Periodic Table.');
    return;
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${headerConfig.subject || 'Chemistry'} — The Periodic Table of Elements</title>
  <style>
    @page { size: A4 landscape; margin: 10mm; }
    body { margin: 0; padding: 0; font-family: Arial, sans-serif; background: white; }
    .no-print { text-align: center; padding: 10px; background: #e0e7ff; color: #3730a3; font-size: 13px; margin-bottom: 12px; }
    @media print { .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="no-print">
    <strong>Cambridge IGCSE Chemistry Periodic Table</strong> — Press <code>Ctrl + P</code> to Save as PDF or Print (Landscape).
  </div>
  ${renderPeriodicTableHtml({ rotated: false })}
  <script>
    setTimeout(() => { window.print(); }, 400);
  </script>
</body>
</html>`;

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}

/**
 * Renders the HTML for the Cambridge Insert / Resource Booklet (Maps, Photos, Figures, Tables)
 */
export function renderInsertBookletSectionHtml(
  headerConfig: Partial<ExamHeaderConfig> = {},
  rawQuestions: Question[] = [],
  options: Partial<ExportLayoutOptions> = {}
): string {
  const questions = resolveQuestionResources(rawQuestions, {
    autoRenumberFigures: options.autoRenumberFigures ?? true,
  });
  const schoolLogo = options.schoolLogoUrl || DEFAULT_SCHOOL_LOGO;
  const cambridgeLogo = DEFAULT_CAMBRIDGE_LOGO;

  interface InsertItem {
    header: string;
    topic?: string;
    diagramUrl?: string | null;
    tableText?: string;
  }

  const items: InsertItem[] = [];

  questions.forEach((q, idx) => {
    const qDiagram = q.diagram_url || (q as any).image_url || (q as any).diagram_base64;
    const qRef = q.resource_ref;
    const isInsert = isInsertResource(q) || Boolean(options.includeAllFiguresInBooklet);

    // Parent visual: ONLY push if an actual diagram exists
    if (qDiagram && isInsert) {
      let topic = q.topic || undefined;
      const titleMatch =
        (q.question_text || '').match(/Study\s+Figs?\.?\s*[0-9.]+\s*(?:\(Insert\))?,?\s*([^.\n]+)/i) ||
        (q.sub_questions?.[0]?.question_text || '').match(
          /Study\s+Figs?\.?\s*[0-9.]+\s*(?:\(Insert\))?,?\s*([^.\n]+)/i
        );
      if (titleMatch) {
        topic = titleMatch[1].trim();
      }

      const headerLabel = qRef
        ? (/^figs?/i.test(qRef)
            ? `${qRef} for Question ${q.question_number || idx + 1}`
            : `${qRef} — Resource for Question ${q.question_number || idx + 1}`)
        : `Resource for Question ${q.question_number || idx + 1}`;

      items.push({
        header: headerLabel,
        topic,
        diagramUrl: qDiagram,
      });
    }

    // Check sub-questions: ONLY push if an actual diagram exists
    (q.sub_questions || []).forEach((sq) => {
      const sqDiagram = sq.diagram_url || (sq as any).image_url || (sq as any).diagram_base64;
      const sqRef = sq.resource_ref;
      const isSubInsert = isInsertResource(sq) || Boolean(options.includeAllFiguresInBooklet);

      if (sqDiagram && isSubInsert) {
        let sqTopic = q.topic || undefined;
        const subTitleMatch = (sq.question_text || '').match(
          /Study\s+Figs?\.?\s*[0-9.]+\s*(?:\(Insert\))?,?\s*([^.\n]+)/i
        );
        if (subTitleMatch) {
          sqTopic = subTitleMatch[1].trim();
        }

        const sqHeaderLabel = sqRef
          ? (/^figs?/i.test(sqRef)
              ? `${sqRef} for Question ${q.question_number || idx + 1}`
              : `${sqRef} — Resource for Question ${q.question_number || idx + 1} ${sq.sub_id}`)
          : `Resource for Question ${q.question_number || idx + 1} ${sq.sub_id}`;

        items.push({
          header: sqHeaderLabel,
          topic: sqTopic,
          diagramUrl: sqDiagram,
        });
      }
    });
  });

  return `
  <div class="insert-booklet-section" style="page-break-before: always; break-before: page; margin-top: 24px;">
    <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #111; padding-bottom: 10px; margin-bottom: 16px;">
      <img src="${schoolLogo}" alt="School Logo" style="height: 48px; max-width: 160px; object-fit: contain;" />
      <img src="${cambridgeLogo}" alt="Cambridge Logo" style="height: 48px; max-width: 180px; object-fit: contain;" />
    </div>

    <div style="text-align: center; margin-bottom: 18px;">
      <h1 style="font-size: 22px; font-weight: bold; margin: 0 0 6px;">${(headerConfig.subject || 'GEOGRAPHY').toUpperCase()} — INSERT / RESOURCE BOOKLET</h1>
      <div style="font-size: 14px; font-weight: bold; color: #4b5563;">${headerConfig.title || 'Assessment Resources'} &nbsp;•&nbsp; ${headerConfig.subjectCode || '0460'}</div>
    </div>

    <div style="border: 1.5px solid #111; padding: 12px 16px; background: #fdfdfd; margin-bottom: 24px; font-family: Arial, sans-serif;">
      <div style="font-weight: bold; margin-bottom: 6px; font-size: 13px;">INFORMATION & INSTRUCTIONS:</div>
      <div style="font-size: 12px; line-height: 1.6;">
        • This insert contains all the resources, figures, maps, tables, case studies, and source extracts referred to in the question paper.<br />
        • You may make any necessary annotations or highlights directly on the insert.<br />
        • This Insert is not assessed. Write your answers only in the question paper / answer booklet.
      </div>
    </div>

    <div class="resources-container">
      ${items.length > 0 ? items.map((it) => `
        <div style="border: 1px solid #cbd5e1; border-radius: 6px; padding: 16px; margin-bottom: 24px; page-break-inside: avoid; background: white;">
          <div style="font-weight: bold; font-size: 16px; color: #1e3a8a; border-bottom: 1px solid #e2e8f0; padding-bottom: 6px; margin-bottom: 12px;">
            ${it.header} ${it.topic ? `(${it.topic})` : ''}
          </div>
          ${it.diagramUrl ? `<div style="text-align: center; margin: 12px 0;"><img src="${it.diagramUrl}" alt="${it.header}" style="max-width: 95%; max-height: 480px; object-fit: contain;" /></div>` : ''}
          ${it.tableText ? `<div style="margin-top: 10px;">${convertMarkdownTablesToHtml(it.tableText)}</div>` : ''}
        </div>
      `).join('') : `
        <div style="text-align: center; padding: 30px; color: #64748b; font-style: italic;">
          No figures or maps were attached to the questions in this paper.
        </div>
      `}
    </div>
  </div>
  `;
}

/**
 * Opens a dedicated Insert / Resource Booklet for Social Sciences & Humanities (Geography, History, Sociology, Economics, etc.)
 */
export function openInsertBookletPrintWindow(
  headerConfig: Partial<ExamHeaderConfig> = {},
  questions: Question[] = [],
  options: Partial<ExportLayoutOptions> = {}
) {
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Please allow popups to open the Insert Booklet.');
    return;
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${headerConfig.title || 'Exam'} — Insert / Resource Booklet</title>
  <style>
    @page { size: A4; margin: 15mm; }
    body { font-family: "Times New Roman", Times, serif; color: #111; line-height: 1.5; margin: 0; padding: 10px; }
    .no-print { text-align: center; padding: 10px; background: #e0e7ff; color: #3730a3; font-size: 13px; margin-bottom: 16px; border-radius: 6px; font-family: Arial, sans-serif; }
    @media print { .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="no-print">
    <strong>Cambridge IGCSE Insert / Resource Booklet</strong> — Press <code>Ctrl + P</code> to Save as PDF or Print.
  </div>

  ${renderInsertBookletSectionHtml(headerConfig, questions, options)}

  <script>
    setTimeout(() => { window.print(); }, 400);
  </script>
</body>
</html>`;

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}

/**
 * Opens a dedicated Multiple Choice Bubble Answer Sheet in a printable PDF window
 */
export function openMcqAnswerSheetPrintWindow(
  headerConfig: ExamHeaderConfig,
  questions: Question[],
  options: Partial<ExportLayoutOptions> = {}
) {
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Please allow popups to open the MCQ Answer Sheet.');
    return;
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${headerConfig.title || 'Exam'} — Multiple Choice Answer Sheet</title>
  <style>
    @page {
      size: A4;
      margin: 10mm 12mm 10mm 12mm;
    }
    body {
      font-family: Arial, sans-serif;
      color: #111;
      line-height: 1.4;
      margin: 0;
      padding: 10px;
      background: white;
    }
    .no-print {
      text-align: center;
      padding: 12px;
      background: #e0e7ff;
      color: #3730a3;
      font-family: Arial, sans-serif;
      font-size: 13px;
      margin-bottom: 20px;
      border-radius: 6px;
      border: 1px solid #c7d2fe;
    }
    @media print {
      .no-print { display: none; }
    }
  </style>
</head>
<body>
  <div class="no-print">
    <strong>Multiple Choice Bubble Answer Sheet Preview</strong> — Press <code>Ctrl + P</code> (or Cmd + P) to Save as PDF or Print.
  </div>

  ${renderMcqAnswerSheetHtml(headerConfig, questions, options)}

  <script>
    setTimeout(() => { window.print(); }, 400);
  </script>
</body>
</html>`;

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}

/**
 * Opens a dedicated student Answer Booklet in a printable PDF window
 */
export function openAnswerBookletPrintWindow(
  headerConfig: ExamHeaderConfig,
  questions: Question[],
  options: Partial<ExportLayoutOptions> = {}
) {
  const { linesPerMark = 3, answerLineStyle = 'dotted', showTurnOverNotice = true } = options;
  const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0);

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Please allow popups to open the Answer Booklet.');
    return;
  }

  const answerLineBorder = answerLineStyle === 'dotted' ? '1.5px dotted #64748b' : '1.2px solid #94a3b8';

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${headerConfig.title || 'Exam'} — Candidate Answer Booklet</title>
  <style>
    @page { size: A4; margin: 15mm; }
    body { font-family: "Times New Roman", Times, serif; color: #111; line-height: 1.5; margin: 0; padding: 10px; }
    .no-print { text-align: center; padding: 12px; background: #e0e7ff; color: #3730a3; font-family: Arial, sans-serif; font-size: 13px; margin-bottom: 20px; border-radius: 6px; }
    @media print { .no-print { display: none; } }
    .cand-box { border: 1.5px solid #111; padding: 10px 14px; margin-bottom: 16px; }
    .cand-row { display: flex; justify-content: space-between; align-items: baseline; font-family: Arial, sans-serif; font-size: 13px; font-weight: bold; }
    .box-grid { display: inline-flex; gap: 4px; margin-left: 6px; }
    .grid-square { width: 18px; height: 18px; border: 1.5px solid #111; display: inline-block; }
    .title-block { border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 16px; }
    .q-booklet-item { margin-bottom: 24px; page-break-inside: avoid; }
    .q-booklet-title { font-weight: bold; font-size: 16px; color: #1e40af; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; margin-bottom: 10px; }
    .sub-booklet-id { font-weight: bold; font-size: 14px; margin-bottom: 6px; }
    .ans-lines { display: flex; flex-direction: column; gap: 34px; margin-bottom: 18px; }
    .ans-line { border-bottom: ${answerLineBorder}; height: 1px; width: 100%; }
    .turn-over { text-align: right; font-style: italic; font-size: 12px; color: #64748b; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="no-print">
    <strong>Candidate Answer Booklet Preview</strong> — Press <code>Ctrl + P</code> (or Cmd + P) to Save as PDF or Print.
  </div>

  <div class="cand-box">
    <div class="cand-row" style="margin-bottom: 8px;">
      <span style="min-width: 120px;">CANDIDATE NAME:</span>
      <span style="flex: 1; border-bottom: 1px dotted #888; height: 1px; display: inline-block; margin-right: 16px;"></span>
    </div>
    <div class="cand-row">
      <span>CENTRE NUMBER:</span>
      <div class="box-grid">
        <span class="grid-square"></span>
        <span class="grid-square"></span>
        <span class="grid-square"></span>
        <span class="grid-square"></span>
      </div>
      <span style="margin-left: 20px;">CANDIDATE NUMBER:</span>
      <div class="box-grid">
        <span class="grid-square"></span>
        <span class="grid-square"></span>
        <span class="grid-square"></span>
        <span class="grid-square"></span>
      </div>
    </div>
  </div>

  <div class="title-block">
    <h1 style="font-size: 20px; font-weight: bold; margin: 0 0 4px;">${headerConfig.title || 'Examination Assessment'} — CANDIDATE ANSWER BOOKLET</h1>
    <div style="font-size: 14px; color: #4b5563;">Subject: ${headerConfig.subject || ''} &nbsp;•&nbsp; Total Marks: ${totalMarks}</div>
  </div>

  ${questions
    .map((q, idx) => {
      const qNum = idx + 1;
      let res = `
        <div class="q-booklet-item">
          <div class="q-booklet-title">Question ${qNum} <span style="font-size: 13px; color: #4b5563; font-weight: normal;">[${q.marks || 1} mark${q.marks !== 1 ? 's' : ''}]</span></div>
      `;

      if (q.sub_questions && q.sub_questions.length > 0) {
        q.sub_questions.forEach((sub) => {
          const subLines = Math.max(2, (sub.marks || 1) * linesPerMark);
          res += `
            <div class="sub-booklet-id">${sub.sub_id} <span style="font-size: 12px; color: #64748b; font-weight: normal;">[${sub.marks || 1}]</span></div>
            <div class="ans-lines">
          `;
          for (let li = 0; li < subLines; li++) {
            res += `<div class="ans-line"></div>`;
          }
          res += `</div>`;
        });
      } else {
        const lineCount = Math.max(2, (q.marks || 1) * linesPerMark);
        res += `<div class="ans-lines">`;
        for (let li = 0; li < lineCount; li++) {
          res += `<div class="ans-line"></div>`;
        }
        res += `</div>`;
      }

      res += `</div>`;
      return res;
    })
    .join('')}

  ${showTurnOverNotice ? `<div class="turn-over">[Turn over</div>` : ''}

  <script>
    setTimeout(() => { window.print(); }, 500);
  </script>
</body>
</html>`;

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}

/**
/**
 * Opens a clean printable window formatted for Comprehensive Teacher Mark Scheme PDF export
 */
export function openTeacherMarkSchemePrintWindow(
  headerConfig: ExamHeaderConfig,
  questions: Question[],
  _options: Partial<ExportLayoutOptions> = {}
) {
  const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0);

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Please allow popups to open the print-ready Mark Scheme.');
    return;
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${headerConfig.title || 'Assessment'} — Comprehensive Teacher Solutions</title>
  <style>
    @page { size: A4; margin: 15mm; }
    body { font-family: Arial, sans-serif; color: #111827; line-height: 1.4; margin: 0; padding: 10px; }
    .no-print { text-align: center; padding: 10px; background: #fee2e2; color: #991b1b; font-size: 13px; margin-bottom: 20px; border-radius: 6px; }
    @media print { .no-print { display: none; } }
    .title-block { border-bottom: 2px solid #1e3a8a; padding-bottom: 8px; margin-bottom: 16px; }
    .title { font-size: 20px; font-weight: bold; color: #1e3a8a; margin: 0 0 4px; }
    .subtitle { font-size: 13px; color: #4b5563; font-weight: bold; }
    .q-section { margin-bottom: 24px; page-break-inside: avoid; border: 1px solid #e5e7eb; border-radius: 6px; overflow: hidden; }
    .q-banner { background: #f8fafc; padding: 8px 12px; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; }
    .q-banner-title { font-weight: bold; font-size: 14px; color: #1e3a8a; }
    .q-banner-meta { font-size: 12px; color: #64748b; }
    .q-stem-box { padding: 10px 12px; font-size: 13px; color: #374151; background: #ffffff; border-bottom: 1px solid #f1f5f9; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    th { background: #1e3a8a; color: white; border: 1px solid #1e3a8a; padding: 6px 10px; text-align: left; }
    td { border: 1px solid #e5e7eb; padding: 6px 10px; vertical-align: top; }
    tr:nth-child(even) { background: #fafafa; }
    .guidance-box { margin-top: 4px; font-size: 11px; color: #2563eb; font-style: italic; background: #eff6ff; padding: 4px 6px; border-radius: 4px; }
    .trap-box { margin-top: 4px; font-size: 11px; color: #d97706; font-style: italic; background: #fffbeb; padding: 4px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="no-print">
    <strong>Comprehensive Teacher Mark Scheme & Solutions Preview</strong> — Press <code>Ctrl + P</code> to Save as PDF or Print.
  </div>

  <div class="title-block">
    <h1 class="title">COMPREHENSIVE TEACHER MARK SCHEME & SOLUTIONS</h1>
    <div class="subtitle">${headerConfig.title || 'Assessment'} &nbsp;•&nbsp; Subject: ${headerConfig.subject || 'General'} (${headerConfig.subjectCode || ''}) &nbsp;•&nbsp; Maximum Mark: ${totalMarks}</div>
  </div>

  ${questions
    .map((q, idx) => {
      const qNum = idx + 1;
      const stem = convertMarkdownTablesToHtml(q.question_text || '');

      let subRowsHtml = '';
      if (q.sub_questions && q.sub_questions.length > 0) {
        subRowsHtml = q.sub_questions
          .map((sub) => {
            const msText =
              typeof sub.mark_scheme === 'string'
                ? sub.mark_scheme
                : Array.isArray(sub.mark_scheme)
                ? (sub.mark_scheme as string[]).join('<br />• ')
                : 'Credit scientifically accurate answer with appropriate working.';

            return `
            <tr>
              <td style="width: 12%;"><strong>${sub.sub_id}</strong></td>
              <td style="width: 58%;">
                ${sub.question_text ? `<div style="color: #64748b; font-size: 11px; margin-bottom: 3px;"><em>${formatLatexForHtml(sub.question_text)}</em></div>` : ''}
                • ${formatLatexForHtml(msText)}
                ${sub.guidance ? `<div class="guidance-box">💡 <strong>Examiner Guidance:</strong> ${formatLatexForHtml(sub.guidance)}</div>` : ''}
                ${sub.common_misconceptions && sub.common_misconceptions.length > 0 ? `<div class="trap-box">⚠️ <strong>Common Trap:</strong> ${sub.common_misconceptions.map(formatLatexForHtml).join('; ')}</div>` : ''}
              </td>
              <td style="width: 18%; font-size: 11px; color: #4b5563;">Allow ECF from earlier parts</td>
              <td style="width: 12%; text-align: center; font-weight: bold;">[${sub.marks || 1}]</td>
            </tr>
          `;
          })
          .join('');
      } else {
        const ms = q.mark_scheme;
        const points = ms?.marking_points ? ms.marking_points.map(formatLatexForHtml).join('<br />• ') : 'Credit scientifically accurate answer with appropriate working.';
        const acceptable = ms?.acceptable_answers ? ms.acceptable_answers.map(formatLatexForHtml).join(', ') : 'Synonyms & valid alternatives accepted';
        const guidance = ms?.guidance ? ms.guidance.map(formatLatexForHtml).join('; ') : '';
        const traps = ms?.common_misconceptions ? ms.common_misconceptions.map(formatLatexForHtml).join('; ') : '';

        subRowsHtml = `
          <tr>
            <td style="width: 12%;"><strong>Q${qNum}</strong></td>
            <td style="width: 58%;">
              • ${points}
              ${guidance ? `<div class="guidance-box">💡 <strong>Examiner Guidance:</strong> ${guidance}</div>` : ''}
              ${traps ? `<div class="trap-box">⚠️ <strong>Common Trap:</strong> ${traps}</div>` : ''}
            </td>
            <td style="width: 18%; font-size: 11px; color: #4b5563;">${acceptable}</td>
            <td style="width: 12%; text-align: center; font-weight: bold;">[${q.marks || 1}]</td>
          </tr>
        `;
      }

      const diagramUrl = q.diagram_url || (q as any).image_url || (q as any).diagram_base64;

      return `
        <div class="q-section">
          <div class="q-banner">
            <span class="q-banner-title">Question ${qNum} [${q.marks || 1} mark${q.marks !== 1 ? 's' : ''}]</span>
            <span class="q-banner-meta">${q.topic ? `${q.topic}${q.sub_topic ? ` › ${q.sub_topic}` : ''}` : ''}</span>
          </div>
          <div class="q-stem-box">
            ${stem}
            ${diagramUrl ? `<div style="text-align: center; margin: 8px 0;"><img src="${diagramUrl}" alt="Diagram" style="max-width: 75%; max-height: 200px; object-fit: contain;" /></div>` : ''}
          </div>
          <table>
            <thead>
              <tr>
                <th style="width: 12%;">Part</th>
                <th style="width: 58%;">Marking Criteria & Model Answer</th>
                <th style="width: 18%;">Acceptable / ECF</th>
                <th style="width: 12%; text-align: center;">Marks</th>
              </tr>
            </thead>
            <tbody>
              ${subRowsHtml}
            </tbody>
          </table>
        </div>
      `;
    })
    .join('')}

  <script>
    setTimeout(() => { window.print(); }, 500);
  </script>
</body>
</html>`;

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}
