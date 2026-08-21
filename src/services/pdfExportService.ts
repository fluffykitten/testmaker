// ─── PDF / Print Export Service ─────────────────────────────────────────────
// Opens high-resolution, print-optimized document windows for saving as PDF.

import type { Question } from '../types/database';
import type { ExamHeaderConfig } from './testBuilderService';

/**
 * Formats LaTeX math formulas, Greek symbols, and sub/superscripts to clean HTML
 */
export function formatLatexForHtml(text: string): string {
  if (!text) return '';
  return text
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
    .replace(/\\degree/g, '°')
    .replace(/\\circ/g, '°')
    .replace(/\^\{\\circ\}/g, '°')
    .replace(/\^\\circ/g, '°')
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
    .replace(/\\quad/g, '   ')
    .replace(/\\qquad/g, '      ')
    // Remove outer LaTeX math delimiters while keeping content
    .replace(/\$\$(.*?)\$\$/g, '$1')
    .replace(/\$(.*?)\$/g, '$1')
    .replace(/\\\[(.*?)\\\]/g, '$1')
    .replace(/\\\((.*?)\\\)/g, '$1')
    // Subscripts & Superscripts to HTML tags
    .replace(/_{([^{}]*)}/g, '<sub>$1</sub>')
    .replace(/\^{([^{}]*)}/g, '<sup>$1</sup>')
    .replace(/([a-zA-Z0-9\)\]])_([0-9a-zA-Z\+\-\*])/g, '$1<sub>$2</sub>')
    .replace(/\^([0-9a-zA-Z\+\-\*])/g, '<sup>$1</sup>');
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
              `<th style="border: 1px solid #4b5563; padding: 6px 12px; background: #f3f4f6; text-align: center; font-weight: bold;">${formatLatexForHtml(h)}</th>`
          )
          .join('') +
        '</tr></thead>';
      tableHtml +=
        '<tbody>' +
        body
          .map(
            (row) =>
              '<tr>' +
              row
                .map(
                  (c) =>
                    `<td style="border: 1px solid #4b5563; padding: 6px 12px; text-align: center;">${formatLatexForHtml(c)}</td>`
                )
                .join('') +
              '</tr>'
          )
          .join('') +
        '</tbody>';
      tableHtml += '</table></div>';
      result.push(tableHtml);
    }
    tableLines = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
      if (!inTable) inTable = true;
      tableLines.push(line);
    } else {
      if (inTable) {
        flushTable();
        inTable = false;
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
  questions: Question[],
  options: { includeAnswerLines?: boolean; linesPerMark?: number } = {}
) {
  const { includeAnswerLines = true, linesPerMark = 2 } = options;
  const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0);

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Please allow popups to open the print-ready PDF window.');
    return;
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${headerConfig.title || 'Exam Paper'} — Student Assessment</title>
  <style>
    @page { size: A4; margin: 20mm 15mm 20mm 15mm; }
    body { font-family: "Times New Roman", Times, Georgia, serif; color: #111; line-height: 1.5; margin: 0; padding: 10px; }
    .header-box { border: 1.5px solid #111; padding: 12px 16px; margin-bottom: 20px; }
    .cand-row { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; font-family: Arial, sans-serif; font-size: 13px; font-weight: bold; }
    .line { border-bottom: 1px dotted #555; flex: 1; height: 1px; display: inline-block; }
    .title-block { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 16px; }
    .title { font-size: 20px; font-weight: bold; margin: 0 0 4px; }
    .subtitle { font-size: 14px; color: #333; font-weight: bold; }
    .inst-box { border: 1px solid #777; padding: 10px 14px; font-family: Arial, sans-serif; font-size: 12px; margin-bottom: 24px; background: #fafafa; text-align: justify; }
    .q-block { margin-bottom: 28px; page-break-inside: avoid; }
    .q-header { display: flex; align-items: baseline; gap: 12px; font-size: 15px; }
    .q-num { font-weight: bold; font-size: 16px; min-width: 22px; }
    .q-text { flex: 1; line-height: 1.6; text-align: justify; }
    .mcq-choice { margin: 6px 0 6px 34px; font-size: 14px; }
    .sub-block { margin: 12px 0 12px 28px; }
    .sub-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 14px; }
    .sub-id { font-weight: bold; min-width: 26px; }
    .sub-text { flex: 1; text-align: justify; }
    .marks { font-weight: bold; font-size: 13px; white-space: nowrap; }
    .ans-lines { margin: 8px 0 8px 30px; display: flex; flex-direction: column; gap: 12px; }
    .ans-line { border-bottom: 1px dotted #888; height: 1px; width: 100%; }
    .total-row { text-align: right; font-weight: bold; font-size: 14px; margin-top: 4px; }
    .no-print { text-align: center; padding: 10px; background: #e0e7ff; font-family: Arial, sans-serif; font-size: 13px; margin-bottom: 20px; }
    @media print { .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="no-print">
    <strong>Print Ready Preview</strong> — Press <code>Ctrl + P</code> (or Cmd + P) to Save as PDF or Print.
  </div>

  <div class="header-box">
    <div class="cand-row">
      <span style="min-width: 50px;">NAME:</span> <span class="line" style="margin-right: 20px;"></span>
      <span style="min-width: 55px;">CLASS:</span> <span class="line" style="max-width: 140px; margin-right: 20px;"></span>
      <span style="min-width: 48px;">DATE:</span> <span class="line" style="max-width: 140px;"></span>
    </div>
  </div>

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
          <div style="font-weight: bold; margin-bottom: 4px;">INSTRUCTIONS:</div>
          <div>• ${headerConfig.instructions}</div>
          ${headerConfig.additionalMaterials ? `<div>• Additional materials: ${headerConfig.additionalMaterials}</div>` : ''}
          <div>• The number of marks is shown in brackets [ ] at the end of each question or part question.</div>
        </div>`
      : ''
  }

  ${questions
    .map((q, idx) => {
      const qNum = idx + 1;
      const stem = convertMarkdownTablesToHtml(q.question_text);

      let content = `
        <div class="q-block">
          <div class="q-header">
            <span class="q-num">${qNum}</span>
            <div class="q-text">${stem}</div>
          </div>
      `;

      if (q.options && q.options.length > 0) {
        q.options.forEach((opt) => {
          content += `<div class="mcq-choice">${formatLatexForHtml(opt)}</div>`;
        });
      }

      if (q.sub_questions && q.sub_questions.length > 0) {
        q.sub_questions.forEach((sub) => {
          content += `
            <div class="sub-block">
              <div class="sub-row">
                <span class="sub-id">${sub.sub_id}</span>
                <span class="sub-text">${convertMarkdownTablesToHtml(sub.question_text)}</span>
                <span class="marks">[${sub.marks}]</span>
              </div>
          `;

          if (includeAnswerLines) {
            const lineCount = Math.min(6, Math.max(2, (sub.marks || 1) * linesPerMark));
            content += `<div class="ans-lines">`;
            for (let li = 0; li < lineCount; li++) {
              content += `<div class="ans-line"></div>`;
            }
            content += `</div>`;
          }

          content += `</div>`;
        });
      } else if (includeAnswerLines && (!q.options || q.options.length === 0)) {
        const lineCount = Math.min(6, Math.max(2, (q.marks || 1) * linesPerMark));
        content += `<div class="ans-lines">`;
        for (let li = 0; li < lineCount; li++) {
          content += `<div class="ans-line"></div>`;
        }
        content += `</div>`;
      }

      content += `
          <div class="total-row">[Total: ${q.marks}]</div>
        </div>
      `;

      return content;
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

/**
 * Opens a clean printable window formatted for Teacher Mark Scheme & Answer Key PDF export
 */
export function openTeacherMarkSchemePrintWindow(
  headerConfig: ExamHeaderConfig,
  questions: Question[]
) {
  const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0);

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Please allow popups to open the print-ready PDF window.');
    return;
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Teacher Mark Scheme: ${headerConfig.title || 'Assessment'}</title>
  <style>
    @page { size: A4; margin: 20mm 15mm 20mm 15mm; }
    body { font-family: Arial, Helvetica, sans-serif; color: #111; line-height: 1.4; margin: 0; padding: 10px; font-size: 13px; }
    .header { border-bottom: 2px solid #1e3a8a; padding-bottom: 10px; margin-bottom: 20px; display: flex; justify-content: space-between; align-items: baseline; }
    .title { font-size: 20px; font-weight: bold; color: #1e3a8a; margin: 0 0 4px; }
    .sub { font-size: 13px; color: #4b5563; font-weight: bold; }
    table { width: 100%; border-collapse: collapse; margin-top: 16px; }
    th { background: #1e3a8a; color: white; text-align: left; padding: 8px 10px; font-size: 12px; text-transform: uppercase; }
    td { border-bottom: 1px solid #e5e7eb; padding: 10px 10px; vertical-align: top; }
    tr:nth-child(even) td { background: #f9fafb; }
    .q-col { font-weight: bold; width: 12%; color: #1e3a8a; }
    .ans-col { width: 62%; line-height: 1.6; }
    .acc-col { width: 16%; color: #4b5563; font-style: italic; }
    .mark-col { width: 10%; font-weight: bold; text-align: right; }
    .no-print { text-align: center; padding: 10px; background: #e0e7ff; font-size: 13px; margin-bottom: 20px; font-weight: bold; }
    @media print { .no-print { display: none; } }
  </style>
</head>
<body>
  <div class="no-print">
    <strong>Teacher Mark Scheme & Solutions</strong> — Press <code>Ctrl + P</code> to Save as PDF or Print.
  </div>

  <div class="header">
    <div>
      <h1 class="title">TEACHER MARK SCHEME</h1>
      <div class="sub">${headerConfig.title || 'Custom Exam Assessment'} • ${headerConfig.subject || 'Exam'} (${headerConfig.subjectCode || 'General'})</div>
    </div>
    <div style="text-align: right; font-weight: bold; font-size: 14px; color: #1e3a8a;">
      Maximum Mark: ${totalMarks}
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th class="q-col">Question</th>
        <th class="ans-col">Answer / Marking Criteria</th>
        <th class="acc-col">Acceptable Answers</th>
        <th class="mark-col">Marks</th>
      </tr>
    </thead>
    <tbody>
      ${questions
        .map((q, idx) => {
          const qNum = idx + 1;
          if (q.sub_questions && q.sub_questions.length > 0) {
            return q.sub_questions
              .map((sub) => {
                const msText =
                  typeof sub.mark_scheme === 'string'
                    ? sub.mark_scheme
                    : Array.isArray(sub.mark_scheme)
                      ? (sub.mark_scheme as string[]).join('; ')
                      : 'See marking scheme points';

                return `
                  <tr>
                    <td class="q-col">${qNum} ${sub.sub_id}</td>
                    <td class="ans-col">${formatLatexForHtml(msText)}</td>
                    <td class="acc-col">—</td>
                    <td class="mark-col">[${sub.marks}]</td>
                  </tr>
                `;
              })
              .join('');
          } else {
            const msPoints = q.mark_scheme?.marking_points?.join('<br />• ') || 'Award mark according to standard criteria.';
            const acceptable = q.mark_scheme?.acceptable_answers?.join(', ') || '—';

            return `
              <tr>
                <td class="q-col">${qNum}</td>
                <td class="ans-col">• ${formatLatexForHtml(msPoints)}</td>
                <td class="acc-col">${formatLatexForHtml(acceptable)}</td>
                <td class="mark-col">[${q.marks}]</td>
              </tr>
            `;
          }
        })
        .join('')}
    </tbody>
  </table>

  <script>
    setTimeout(() => { window.print(); }, 500);
  </script>
</body>
</html>`;

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}
