// ─── Quiz Report PDF Service ──────────────────────────────────────────────────
// Generates publication-quality, print-optimized PDF reports for formal exams:
// 1. Overall Class Cohort Performance & Diagnostic Analysis Report
// 2. Individual Candidate Performance, Sub-Question Script, & AI Marking Report

import type { StudentSubmission } from './quizSubmissionService';
import { formatProctorTimestamp, formatCandidateAnswer } from './quizSubmissionService';
import { formatLatexForHtml } from './pdfExportService';

/**
 * Derives Cambridge letter grade from percentage
 */
function deriveGrade(percentage: number): { grade: string; color: string } {
  if (percentage >= 90) return { grade: 'A*', color: '#16a34a' };
  if (percentage >= 80) return { grade: 'A', color: '#22c55e' };
  if (percentage >= 70) return { grade: 'B', color: '#3b82f6' };
  if (percentage >= 60) return { grade: 'C', color: '#eab308' };
  if (percentage >= 50) return { grade: 'D', color: '#f97316' };
  if (percentage >= 40) return { grade: 'E', color: '#ef4444' };
  return { grade: 'U', color: '#991b1b' };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 1. CLASS-WIDE COHORT PDF REPORT
 * ═══════════════════════════════════════════════════════════════════════════════
 */
export function exportClassQuizReportPdf(
  quiz: { title: string; quizCode: string; subject?: string; totalMarks: number },
  submissions: StudentSubmission[],
  selectedClass: string = 'all'
): void {
  if (!submissions || submissions.length === 0) {
    alert('No student submissions available to generate a class report.');
    return;
  }

  // Filter by selected class if specified
  const filteredSubmissions = selectedClass === 'all'
    ? submissions
    : submissions.filter((s) => (s.studentClass || 'General').toLowerCase() === selectedClass.toLowerCase());

  if (filteredSubmissions.length === 0) {
    alert(`No student submissions found for class "${selectedClass}".`);
    return;
  }

  const count = filteredSubmissions.length;
  const totalMarks = quiz.totalMarks || 1;
  const totalScore = filteredSubmissions.reduce((s, sub) => s + sub.score, 0);
  const avgScore = totalScore / count;
  const avgPct = (avgScore / totalMarks) * 100;
  const highestScore = Math.max(...filteredSubmissions.map((s) => s.score));
  const lowestScore = Math.min(...filteredSubmissions.map((s) => s.score));
  const cleanCount = filteredSubmissions.filter((s) => s.violationsCount === 0).length;
  const integrityRate = Math.round((cleanCount / count) * 100);

  // Grade Distribution Counts
  const gradeCounts: Record<string, number> = { 'A*': 0, 'A': 0, 'B': 0, 'C': 0, 'D': 0, 'E': 0, 'U': 0 };
  filteredSubmissions.forEach((s) => {
    const { grade } = deriveGrade(s.percentage);
    gradeCounts[grade] = (gradeCounts[grade] || 0) + 1;
  });

  // Topic Aggregations
  const topicStats: Record<string, { totalAvailable: number; totalEarned: number; count: number }> = {};
  filteredSubmissions.forEach((s) => {
    if (s.topicBreakdown) {
      Object.entries(s.topicBreakdown).forEach(([top, data]) => {
        if (!topicStats[top]) {
          topicStats[top] = { totalAvailable: 0, totalEarned: 0, count: 0 };
        }
        topicStats[top].totalAvailable += data.totalMarks;
        topicStats[top].totalEarned += data.earnedMarks;
        topicStats[top].count += 1;
      });
    }
  });

  // Class Breakdown Stats if multiple classes exist
  const classBreakdown: Record<string, { count: number; totalScore: number; avgPct: number }> = {};
  submissions.forEach((s) => {
    const cName = s.studentClass || 'General';
    if (!classBreakdown[cName]) classBreakdown[cName] = { count: 0, totalScore: 0, avgPct: 0 };
    classBreakdown[cName].count++;
    classBreakdown[cName].totalScore += s.score;
  });
  Object.values(classBreakdown).forEach((item) => {
    item.avgPct = Math.round(((item.totalScore / (item.count * totalMarks)) * 100));
  });

  // Sort submissions by rank (score desc)
  const rankedSubmissions = [...filteredSubmissions].sort((a, b) => b.score - a.score || a.durationSeconds - b.durationSeconds);

  // HTML Document Assembly
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Class Performance Report - ${quiz.title} (${quiz.quizCode})</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 14mm 14mm 14mm 14mm;
    }
    *, *::before, *::after {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #0f172a;
      background: #ffffff;
      margin: 0;
      padding: 0;
      font-size: 9.5pt;
      line-height: 1.45;
    }
    .report-header {
      border-bottom: 2.5px solid #1e293b;
      padding-bottom: 12px;
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }
    .report-title-box h1 {
      font-size: 16pt;
      font-weight: 800;
      color: #0f172a;
      margin: 0 0 4px 0;
      letter-spacing: -0.02em;
    }
    .report-subtitle {
      font-size: 9pt;
      color: #475569;
      font-weight: 600;
    }
    .report-badge-box {
      text-align: right;
    }
    .report-code-badge {
      display: inline-block;
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      padding: 4px 10px;
      font-weight: 800;
      font-family: monospace;
      font-size: 11pt;
      color: #0f172a;
    }
    .report-date {
      font-size: 8pt;
      color: #64748b;
      margin-top: 4px;
    }
    /* KPI Ribbon */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 10px;
      margin-bottom: 18px;
    }
    .kpi-card {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 10px;
      text-align: center;
    }
    .kpi-card-val {
      font-size: 14pt;
      font-weight: 800;
      color: #0f172a;
      display: block;
    }
    .kpi-card-lbl {
      font-size: 7.5pt;
      font-weight: 700;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-top: 2px;
    }
    /* Section Headings */
    .section-title {
      font-size: 11pt;
      font-weight: 800;
      color: #1e293b;
      margin: 16px 0 8px 0;
      padding-bottom: 4px;
      border-bottom: 1px solid #e2e8f0;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    /* Tables */
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 16px;
      font-size: 8.5pt;
    }
    th {
      background: #f1f5f9;
      color: #334155;
      font-weight: 800;
      text-align: left;
      padding: 6px 10px;
      border: 1px solid #cbd5e1;
      font-size: 8pt;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    td {
      padding: 6px 10px;
      border: 1px solid #e2e8f0;
      vertical-align: middle;
    }
    tr:nth-child(even) td {
      background: #f8fafc;
    }
    /* Grade Distribution Badges */
    .grade-badge {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 4px;
      font-weight: 800;
      font-size: 8pt;
      color: #ffffff;
      text-align: center;
    }
    /* Progress Bars */
    .pct-bar-wrap {
      background: #e2e8f0;
      border-radius: 4px;
      height: 8px;
      overflow: hidden;
      display: flex;
      margin-top: 4px;
    }
    .pct-bar-fill {
      height: 100%;
      background: #3b82f6;
    }
    .page-break {
      page-break-before: always;
    }
    .footer-note {
      font-size: 7.5pt;
      color: #94a3b8;
      text-align: center;
      margin-top: 24px;
      padding-top: 8px;
      border-top: 1px solid #e2e8f0;
    }
  </style>
</head>
<body>

  <!-- Report Header -->
  <div class="report-header">
    <div class="report-title-box">
      <h1>📊 Class Assessment Summary Report</h1>
      <div class="report-subtitle">
        ${quiz.title} • ${quiz.subject || 'Chemistry / Science'}
      </div>
    </div>
    <div class="report-badge-box">
      <div class="report-code-badge">CODE: ${quiz.quizCode}</div>
      <div class="report-date">Generated on ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
    </div>
  </div>

  <!-- KPI Analytics Ribbon -->
  <div class="kpi-grid">
    <div class="kpi-card">
      <span class="kpi-card-val">${count}</span>
      <span class="kpi-card-lbl">Total Students</span>
    </div>
    <div class="kpi-card">
      <span class="kpi-card-val">${avgScore.toFixed(1)} / ${totalMarks}</span>
      <span class="kpi-card-lbl">Class Average (${Math.round(avgPct)}%)</span>
    </div>
    <div class="kpi-card">
      <span class="kpi-card-val">${highestScore} / ${totalMarks}</span>
      <span class="kpi-card-lbl">Highest Score</span>
    </div>
    <div class="kpi-card">
      <span class="kpi-card-val">${lowestScore} / ${totalMarks}</span>
      <span class="kpi-card-lbl">Lowest Score</span>
    </div>
    <div class="kpi-card">
      <span class="kpi-card-val" style="color: ${integrityRate >= 90 ? '#16a34a' : '#ea580c'}">${integrityRate}%</span>
      <span class="kpi-card-lbl">Integrity (${cleanCount} Clean)</span>
    </div>
  </div>

  <!-- Grade Distribution Breakdown -->
  <div class="section-title">📈 Grade Band Distribution</div>
  <table>
    <thead>
      <tr>
        <th style="text-align: center; width: 14%;">A* (90%+)</th>
        <th style="text-align: center; width: 14%;">A (80–89%)</th>
        <th style="text-align: center; width: 14%;">B (70–79%)</th>
        <th style="text-align: center; width: 14%;">C (60–69%)</th>
        <th style="text-align: center; width: 14%;">D (50–59%)</th>
        <th style="text-align: center; width: 14%;">E (40–49%)</th>
        <th style="text-align: center; width: 16%;">U / Ungraded</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="text-align: center; font-weight: 800; font-size: 11pt; color: #16a34a;">${gradeCounts['A*']}</td>
        <td style="text-align: center; font-weight: 800; font-size: 11pt; color: #22c55e;">${gradeCounts['A']}</td>
        <td style="text-align: center; font-weight: 800; font-size: 11pt; color: #3b82f6;">${gradeCounts['B']}</td>
        <td style="text-align: center; font-weight: 800; font-size: 11pt; color: #ca8a04;">${gradeCounts['C']}</td>
        <td style="text-align: center; font-weight: 800; font-size: 11pt; color: #ea580c;">${gradeCounts['D']}</td>
        <td style="text-align: center; font-weight: 800; font-size: 11pt; color: #dc2626;">${gradeCounts['E']}</td>
        <td style="text-align: center; font-weight: 800; font-size: 11pt; color: #991b1b;">${gradeCounts['U']}</td>
      </tr>
    </tbody>
  </table>

  <!-- Topic-by-Topic Mastery Table -->
  ${Object.keys(topicStats).length > 0 ? `
    <div class="section-title">🎯 Syllabus Topic Mastery & Cohort Diagnostic</div>
    <table>
      <thead>
        <tr>
          <th>Topic Name</th>
          <th style="width: 25%;">Cohort Mastery</th>
          <th style="width: 15%; text-align: center;">Class Accuracy</th>
          <th style="width: 20%; text-align: center;">Performance Status</th>
        </tr>
      </thead>
      <tbody>
        ${Object.entries(topicStats).map(([topic, stat]) => {
          const pct = stat.totalAvailable > 0 ? Math.round((stat.totalEarned / stat.totalAvailable) * 100) : 0;
          const statusColor = pct >= 75 ? '#16a34a' : pct >= 50 ? '#ca8a04' : '#dc2626';
          const statusText = pct >= 75 ? 'Strong Mastery' : pct >= 50 ? 'Review Recommended' : 'Critical Focus Area';
          return `
            <tr>
              <td><strong>${topic}</strong></td>
              <td>
                <div style="display: flex; justify-content: space-between; font-size: 7.5pt; color: #64748b;">
                  <span>${stat.totalEarned} / ${stat.totalAvailable} marks</span>
                  <span>${pct}%</span>
                </div>
                <div class="pct-bar-wrap">
                  <div class="pct-bar-fill" style="width: ${pct}%; background: ${statusColor};"></div>
                </div>
              </td>
              <td style="text-align: center; font-weight: 700; color: ${statusColor};">${pct}%</td>
              <td style="text-align: center; font-weight: 800; font-size: 7.5pt; color: ${statusColor};">${statusText}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  ` : ''}

  <!-- Complete Student Roster Table -->
  <div class="section-title">📋 Student Roster & Gradebook (${rankedSubmissions.length} Candidates)</div>
  <table>
    <thead>
      <tr>
        <th style="width: 5%; text-align: center;">Rank</th>
        <th style="width: 25%;">Candidate / Student Name</th>
        <th style="width: 14%;">Class / Section</th>
        <th style="width: 10%; text-align: center;">Cand #</th>
        <th style="width: 12%; text-align: center;">Score</th>
        <th style="width: 10%; text-align: center;">%</th>
        <th style="width: 8%; text-align: center;">Grade</th>
        <th style="width: 12%; text-align: center;">Time</th>
        <th style="width: 10%; text-align: center;">Integrity</th>
      </tr>
    </thead>
    <tbody>
      ${rankedSubmissions.map((sub, rIdx) => {
        const { grade, color } = deriveGrade(sub.percentage);
        const mins = Math.floor(sub.durationSeconds / 60);
        const secs = sub.durationSeconds % 60;
        const isClean = sub.violationsCount === 0;
        return `
          <tr>
            <td style="text-align: center; font-weight: 800; color: #64748b;">#${rIdx + 1}</td>
            <td><strong>${sub.studentName}</strong></td>
            <td><span style="background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-weight: 600;">${sub.studentClass || 'General'}</span></td>
            <td style="text-align: center; font-family: monospace; color: #64748b;">${sub.candidateNumber || '-'}</td>
            <td style="text-align: center; font-weight: 700;">${sub.score} / ${sub.totalMarks}</td>
            <td style="text-align: center; font-weight: 800;">${Math.round(sub.percentage)}%</td>
            <td style="text-align: center;">
              <span class="grade-badge" style="background: ${color};">${grade}</span>
            </td>
            <td style="text-align: center; font-size: 8pt; color: #64748b;">${mins}m ${secs}s</td>
            <td style="text-align: center; font-size: 7.5pt; font-weight: 700; color: ${isClean ? '#16a34a' : '#ea580c'};">
              ${isClean ? 'Clean (0)' : `⚠️ ${sub.violationsCount}`}
            </td>
          </tr>
        `;
      }).join('')}
    </tbody>
  </table>

  <div class="footer-note">
    Document generated by fluffykitten's testmaker • Assessment Code: ${quiz.quizCode}
  </div>

  <script>
    window.addEventListener('load', () => {
      setTimeout(() => {
        window.print();
      }, 300);
    });
  </script>
</body>
</html>`;

  // Open print preview window
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Please allow popups to open the PDF report window.');
    return;
  }
  printWindow.document.open();
  printWindow.document.write(htmlContent);
  printWindow.document.close();
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 2. INDIVIDUAL CANDIDATE PDF REPORT (WITH SUB-QUESTIONS & AI MARKING)
 * ═══════════════════════════════════════════════════════════════════════════════
 */
export function exportIndividualStudentReportPdf(submission: StudentSubmission): void {
  if (!submission) return;

  const { grade, color } = deriveGrade(submission.percentage);
  const mins = Math.floor(submission.durationSeconds / 60);
  const secs = submission.durationSeconds % 60;
  const isClean = submission.violationsCount === 0;

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Candidate Diagnostic Report - ${submission.studentName}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 12mm 14mm 12mm 14mm;
    }
    *, *::before, *::after {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #0f172a;
      background: #ffffff;
      margin: 0;
      padding: 0;
      font-size: 9pt;
      line-height: 1.45;
    }
    /* Candidate Header Card */
    .cand-header-card {
      border: 1.5px solid #cbd5e1;
      border-radius: 8px;
      padding: 12px 16px;
      margin-bottom: 14px;
      background: #f8fafc;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .cand-name-title h1 {
      font-size: 15pt;
      font-weight: 800;
      color: #0f172a;
      margin: 0 0 2px 0;
    }
    .cand-sub {
      font-size: 8.5pt;
      color: #475569;
      font-weight: 600;
    }
    .cand-score-pill {
      text-align: right;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .cand-score-box {
      text-align: right;
    }
    .cand-score-big {
      font-size: 16pt;
      font-weight: 800;
      color: #0f172a;
    }
    .cand-score-lbl {
      font-size: 7.5pt;
      color: #64748b;
      text-transform: uppercase;
      font-weight: 700;
    }
    .cand-grade-tag {
      background: ${color};
      color: #ffffff;
      font-weight: 800;
      font-size: 18pt;
      padding: 6px 14px;
      border-radius: 6px;
    }
    /* Metadata Grid */
    .meta-bar {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
      margin-bottom: 14px;
      background: #f1f5f9;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 8px 12px;
      font-size: 8pt;
    }
    .meta-item strong {
      display: block;
      color: #0f172a;
      font-size: 8.5pt;
    }
    .meta-item span {
      color: #64748b;
    }
    /* Section Title */
    .section-title {
      font-size: 10.5pt;
      font-weight: 800;
      color: #1e293b;
      margin: 14px 0 8px 0;
      padding-bottom: 4px;
      border-bottom: 1.5px solid #e2e8f0;
    }
    /* Question Script Card */
    .q-script-card {
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      padding: 10px 14px;
      margin-bottom: 12px;
      page-break-inside: avoid;
      background: #ffffff;
    }
    .q-script-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 6px;
      border-bottom: 1px solid #f1f5f9;
      padding-bottom: 4px;
    }
    .q-script-title {
      font-weight: 800;
      font-size: 9.5pt;
      color: #0f172a;
    }
    .q-topic-tag {
      font-size: 7.5pt;
      background: #f1f5f9;
      color: #475569;
      padding: 2px 6px;
      border-radius: 4px;
      margin-left: 6px;
      font-weight: 600;
    }
    .q-score-badge {
      font-weight: 800;
      font-size: 8pt;
      padding: 2px 8px;
      border-radius: 4px;
    }
    .score-full { background: rgba(34, 197, 94, 0.15); color: #16a34a; }
    .score-partial { background: rgba(234, 179, 8, 0.15); color: #ca8a04; }
    .score-zero { background: rgba(239, 68, 68, 0.15); color: #dc2626; }

    .q-stem {
      font-size: 8.5pt;
      color: #334155;
      margin-bottom: 8px;
    }

    /* Sub Questions Stack */
    .sub-q-box {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 6px;
      padding: 8px 12px;
      margin-bottom: 6px;
    }
    .sub-q-head {
      display: flex;
      justify-content: space-between;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .sub-ans-row {
      font-size: 8pt;
      margin-bottom: 3px;
    }
    .sub-feedback {
      font-size: 7.5pt;
      color: #64748b;
      margin-top: 2px;
      font-style: italic;
    }
    /* Model Answer Box */
    .model-ans-box {
      background: #f0fdf4;
      border: 1px solid #bbf7d0;
      border-radius: 6px;
      padding: 6px 10px;
      margin-top: 6px;
      font-size: 8pt;
      color: #166534;
    }
    .model-ans-box strong {
      color: #14532d;
    }
    /* Criteria List */
    .criteria-box {
      margin: 6px 0;
      font-size: 7.5pt;
    }
    .crit-item {
      display: flex;
      gap: 6px;
      margin-bottom: 2px;
    }
    .footer-note {
      font-size: 7.5pt;
      color: #94a3b8;
      text-align: center;
      margin-top: 20px;
      padding-top: 8px;
      border-top: 1px solid #e2e8f0;
    }
  </style>
</head>
<body>

  <!-- Candidate Header Card -->
  <div class="cand-header-card">
    <div class="cand-name-title">
      <h1>👤 ${submission.studentName}</h1>
      <div class="cand-sub">
        ${submission.quizTitle} • ${submission.subject || 'Chemistry'} • <strong>Class: ${submission.studentClass || 'General'}</strong>${submission.candidateNumber ? ` • <strong>Cand #: ${submission.candidateNumber}</strong>` : ''}
      </div>
    </div>
    <div class="cand-score-pill">
      <div class="cand-score-box">
        <div class="cand-score-big">${submission.score} / ${submission.totalMarks}</div>
        <div class="cand-score-lbl">Score (${Math.round(submission.percentage)}%)</div>
      </div>
      <div class="cand-grade-tag">${grade}</div>
    </div>
  </div>

  <!-- Assessment Metadata Grid -->
  <div class="meta-bar" style="grid-template-columns: repeat(5, 1fr);">
    <div class="meta-item">
      <span>Class / Section:</span>
      <strong>${submission.studentClass || 'General'}</strong>
    </div>
    <div class="meta-item">
      <span>Candidate ID:</span>
      <strong style="font-family: monospace;">${submission.candidateNumber || 'N/A'}</strong>
    </div>
    <div class="meta-item">
      <span>Access Code:</span>
      <strong>${submission.quizCode}</strong>
    </div>
    <div class="meta-item">
      <span>Time Taken:</span>
      <strong>${mins}m ${secs}s</strong>
    </div>
    <div class="meta-item">
      <span>Exam Integrity:</span>
      <strong style="color: ${isClean ? '#16a34a' : '#ea580c'}">${isClean ? '🟢 0 Strikes (Clean)' : `⚠️ ${submission.violationsCount} Strikes`}</strong>
    </div>
  </div>

  <!-- Detailed Question Script & Marking Breakdown -->
  <div class="section-title">📝 Question-by-Question Script & Examiner Review</div>

  ${submission.questionResults.map((q, idx) => {
    const isFull = q.earnedMarks === q.maxMarks;
    const isPartial = q.earnedMarks > 0 && !isFull;
    const badgeClass = isFull ? 'score-full' : isPartial ? 'score-partial' : 'score-zero';

    return `
      <div class="q-script-card">
        <div class="q-script-header">
          <div>
            <span class="q-script-title">Question ${idx + 1}</span>
            <span class="q-topic-tag">${q.topic}</span>
          </div>
          <span class="q-score-badge ${badgeClass}">
            ${q.earnedMarks} / ${q.maxMarks} Mark${q.maxMarks !== 1 ? 's' : ''}
          </span>
        </div>

        <!-- Question Prompt / Stem if available -->
        ${q.questionText ? `
          <div style="margin: 8px 0 10px 0; color: #1e293b; font-size: 9pt; line-height: 1.45; font-weight: 500; background: #f8fafc; border-left: 3px solid #6366f1; padding: 6px 10px; border-radius: 0 6px 6px 0;">
            ${formatLatexForHtml(q.questionText)}
          </div>
        ` : ''}

        <!-- Sub Questions Breakdown if available -->
        ${q.subQuestionResults && q.subQuestionResults.length > 0 ? `
          <div style="margin: 6px 0;">
            ${q.subQuestionResults.map((sub) => {
              const subCorrect = sub.isCorrect;
              return `
                <div class="sub-q-box">
                  <div class="sub-q-head">
                    <span>Part (${sub.subId})</span>
                    <span style="color: ${subCorrect ? '#16a34a' : '#dc2626'}; font-size: 8pt;">
                      ${sub.earnedMarks} / ${sub.maxMarks} mark${sub.maxMarks !== 1 ? 's' : ''}
                    </span>
                  </div>
                  ${sub.questionText ? `
                    <div style="font-size: 8.5pt; color: #334155; margin-bottom: 4px;">
                      ${formatLatexForHtml(sub.questionText)}
                    </div>
                  ` : ''}
                  <div class="sub-ans-row">
                    <span style="color: #64748b;">Candidate Answer:</span>
                    <strong style="color: #0f172a;">${formatLatexForHtml(formatCandidateAnswer(sub.studentAnswer))}</strong>
                  </div>
                  ${sub.feedback ? `
                    <div class="sub-feedback">
                      💡 ${formatLatexForHtml(sub.feedback)}
                    </div>
                  ` : ''}
                </div>
              `;
            }).join('')}
          </div>
        ` : `
          <!-- Standalone Question Answer -->
          <div style="margin: 6px 0; font-size: 8.5pt;">
            <span style="color: #64748b;">Candidate Answer:</span>
            <strong style="color: #0f172a;">${formatLatexForHtml(formatCandidateAnswer(q.studentAnswer, q.options, q.gradingMethod))}</strong>
          </div>
        `}

        <!-- Point-by-Point Criteria Breakdown -->
        ${q.criteriaBreakdown && q.criteriaBreakdown.length > 0 ? `
          <div class="criteria-box">
            <strong style="color: #475569; display: block; margin-bottom: 3px;">Mark Scheme Criteria:</strong>
            ${q.criteriaBreakdown.map((crit) => `
              <div class="crit-item" style="color: ${crit.achieved ? '#16a34a' : '#64748b'};">
                <span>${crit.achieved ? '✓' : '✗'}</span>
                <div>
                  <span>${formatLatexForHtml(crit.point)}</span>
                  ${crit.examinerNote ? `<span style="font-style: italic; color: #94a3b8; display: block;">Note: ${formatLatexForHtml(crit.examinerNote)}</span>` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        ` : ''}

        <!-- AI Examiner Feedback -->
        ${q.aiFeedback ? `
          <div style="background: #fdf4ff; border: 1px solid #f5d0fe; border-radius: 6px; padding: 6px 10px; margin-top: 6px; font-size: 8pt; color: #86198f;">
            <strong>💡 Examiner Advice:</strong> ${formatLatexForHtml(q.aiFeedback)}
          </div>
        ` : ''}

        <!-- Official Model Answer -->
        ${q.correctAnswer ? `
          <div class="model-ans-box">
            <strong>Official Mark Scheme:</strong> ${formatLatexForHtml(formatCandidateAnswer(q.correctAnswer, q.options, q.gradingMethod))}
          </div>
        ` : ''}
      </div>
    `;
  }).join('')}

  <!-- Proctoring Violations Log if any -->
  ${submission.proctoringLogs && submission.proctoringLogs.length > 0 ? `
    <div class="section-title">⚠️ Security & Proctoring Audit Trail</div>
    <table>
      <thead>
        <tr>
          <th style="width: 15%;">Time</th>
          <th style="width: 15%; text-align: center;">Strike #</th>
          <th>Security Event Detail</th>
        </tr>
      </thead>
      <tbody>
        ${submission.proctoringLogs.map((p) => `
          <tr>
            <td style="color: #64748b;">${formatProctorTimestamp(p.timestamp)}</td>
            <td style="text-align: center; font-weight: 800; color: #ea580c;">Strike ${p.strike}</td>
            <td>${p.event}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  ` : ''}

  <div class="footer-note">
    fluffykitten's testmaker Assessment Diagnostic Report • Candidate: ${submission.studentName} (${submission.quizCode})
  </div>

  <script>
    window.addEventListener('load', () => {
      setTimeout(() => {
        window.print();
      }, 300);
    });
  </script>
</body>
</html>`;

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Please allow popups to open the PDF report window.');
    return;
  }
  printWindow.document.open();
  printWindow.document.write(htmlContent);
  printWindow.document.close();
}
