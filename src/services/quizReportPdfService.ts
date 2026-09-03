// ─── Quiz Report PDF Service ──────────────────────────────────────────────────
// Generates publication-quality, print-optimized PDF reports for formal exams:
// 1. Overall Class Cohort Performance & Diagnostic Analysis Report
// 2. Individual Candidate Performance, Sub-Question Script, & AI Marking Report

import type { StudentSubmission } from './quizSubmissionService';
import { formatProctorTimestamp, formatCandidateAnswer, formatSubmissionDateTime } from './quizSubmissionService';
import { formatLatexForHtml } from './pdfExportService';
import { generateStudentImprovementPlan, type StudentImprovementPlan } from './aiGradingService';

/**
 * Derives Cambridge letter grade from percentage with tier list rarity color styling
 */
export function deriveGrade(percentage: number): {
  grade: string;
  color: string;
  gradient: string;
  borderColor: string;
  textColor: string;
  tierName: string;
} {
  if (percentage >= 90) {
    return {
      grade: 'A*',
      color: '#d97706',
      gradient: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)',
      borderColor: '#fbbf24',
      textColor: '#ffffff',
      tierName: 'Legendary Gold',
    };
  }
  if (percentage >= 80) {
    return {
      grade: 'A',
      color: '#059669',
      gradient: 'linear-gradient(135deg, #10b981 0%, #047857 100%)',
      borderColor: '#34d399',
      textColor: '#ffffff',
      tierName: 'Epic Emerald',
    };
  }
  if (percentage >= 70) {
    return {
      grade: 'B',
      color: '#2563eb',
      gradient: 'linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%)',
      borderColor: '#60a5fa',
      textColor: '#ffffff',
      tierName: 'Rare Sapphire',
    };
  }
  if (percentage >= 60) {
    return {
      grade: 'C',
      color: '#7c3aed',
      gradient: 'linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%)',
      borderColor: '#a78bfa',
      textColor: '#ffffff',
      tierName: 'Uncommon Amethyst',
    };
  }
  if (percentage >= 50) {
    return {
      grade: 'D',
      color: '#ea580c',
      gradient: 'linear-gradient(135deg, #f97316 0%, #c2410c 100%)',
      borderColor: '#fb923c',
      textColor: '#ffffff',
      tierName: 'Bronze',
    };
  }
  if (percentage >= 40) {
    return {
      grade: 'E',
      color: '#dc2626',
      gradient: 'linear-gradient(135deg, #ef4444 0%, #b91c1c 100%)',
      borderColor: '#f87171',
      textColor: '#ffffff',
      tierName: 'Ruby Coral',
    };
  }
  return {
    grade: 'U',
    color: '#475569',
    gradient: 'linear-gradient(135deg, #64748b 0%, #334155 100%)',
    borderColor: '#94a3b8',
    textColor: '#ffffff',
    tierName: 'Shadow Slate',
  };
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

  const isOffline =
    !quiz.quizCode ||
    quiz.quizCode.toUpperCase().startsWith('OFFLINE') ||
    submissions.every((s) => s.durationSeconds === 0) ||
    submissions[0]?.teacherNotes?.toLowerCase().includes('offline');

  // Filter by selected class if specified
  const classFiltered = selectedClass === 'all'
    ? submissions
    : submissions.filter((s) => (s.studentClass || 'General').toLowerCase() === selectedClass.toLowerCase());

  if (classFiltered.length === 0) {
    alert(`No student submissions found for class "${selectedClass}".`);
    return;
  }

  // Deduplicate candidate submissions (prioritize graded/published attempts over provisional, then latest)
  const candidateMap = new Map<string, StudentSubmission>();
  classFiltered.forEach((sub) => {
    const key = (sub.candidateNumber ? `${sub.studentName.toLowerCase()}_${sub.candidateNumber.toLowerCase()}` : sub.studentName.toLowerCase()) || sub.id;
    const existing = candidateMap.get(key);
    if (!existing) {
      candidateMap.set(key, sub);
    } else {
      const isSubGraded = sub.status === 'graded' || sub.status === 'published';
      const isExistingGraded = existing.status === 'graded' || existing.status === 'published';
      if (isSubGraded && !isExistingGraded) {
        candidateMap.set(key, sub);
      } else if (!isSubGraded && isExistingGraded) {
        // keep existing graded
      } else {
        const subTime = new Date(sub.updatedAt || sub.submittedAt || 0).getTime();
        const existingTime = new Date(existing.updatedAt || existing.submittedAt || 0).getTime();
        if (subTime >= existingTime) {
          candidateMap.set(key, sub);
        }
      }
    }
  });

  const filteredSubmissions = Array.from(candidateMap.values());

  const count = filteredSubmissions.length;
  const totalMarks = quiz.totalMarks || 1;
  const totalScore = filteredSubmissions.reduce((s, sub) => s + sub.score, 0);
  const avgScore = totalScore / count;
  const avgPct = (avgScore / totalMarks) * 100;
  const highestScore = Math.max(...filteredSubmissions.map((s) => s.score));
  const lowestScore = Math.min(...filteredSubmissions.map((s) => s.score));
  const passCount = filteredSubmissions.filter((s) => s.percentage >= 50).length;
  const passRate = Math.round((passCount / count) * 100);
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

  // Sort submissions by rank (score desc)
  const rankedSubmissions = [...filteredSubmissions].sort((a, b) => b.score - a.score || a.durationSeconds - b.durationSeconds);

  // HTML Document Assembly
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Class Performance Report - ${quiz.title} (${quiz.quizCode})</title>
  <style>
    @page { size: A4 portrait; margin: 14mm; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: #0f172a;
      background: #ffffff;
      margin: 0;
      padding: 0;
      font-size: 9pt;
      line-height: 1.4;
    }
    .report-header {
      border-bottom: 2px solid #0f172a;
      padding-bottom: 12px;
      margin-bottom: 16px;
      display: flex;
      justify-content: space-between;
      align-items: flex-end;
    }
    .report-title-box h1 { font-size: 16pt; font-weight: 800; color: #0f172a; margin: 0 0 4px 0; letter-spacing: -0.5px; }
    .report-subtitle { font-size: 9pt; color: #475569; font-weight: 600; }
    .report-badge-box { text-align: right; }
    .report-code-badge { font-family: monospace; font-size: 11pt; font-weight: 800; background: #0f172a; color: #ffffff; padding: 4px 10px; border-radius: 4px; display: inline-block; margin-bottom: 4px; }
    .report-date { font-size: 7.5pt; color: #64748b; }
    .kpi-grid { display: grid; grid-template-columns: repeat(${isOffline ? 4 : 5}, 1fr); gap: 10px; margin-bottom: 16px; }
    .kpi-card { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 12px; text-align: center; }
    .kpi-card-val { font-size: 14pt; font-weight: 800; color: #0f172a; display: block; line-height: 1.2; }
    .kpi-card-lbl { font-size: 7.5pt; color: #64748b; text-transform: uppercase; font-weight: 700; margin-top: 2px; display: block; }
    .section-title { font-size: 10pt; font-weight: 800; color: #1e293b; margin: 16px 0 8px 0; text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 6px; }
    table { width: 100%; border-collapse: collapse; font-size: 8pt; margin-bottom: 16px; }
    th, td { border: 1px solid #cbd5e1; padding: 5px 8px; text-align: left; }
    th { background: #f1f5f9; font-weight: 700; color: #1e293b; }
    .grade-badge { font-weight: 800; padding: 2px 6px; border-radius: 4px; color: #ffffff; display: inline-block; font-size: 7.5pt; }
    .pct-bar-bg { background: #e2e8f0; border-radius: 4px; height: 6px; width: 100%; overflow: hidden; display: flex; margin-top: 4px; }
    .pct-bar-fill { height: 100%; background: #3b82f6; }
    .footer-note { font-size: 7.5pt; color: #94a3b8; text-align: center; margin-top: 24px; }
    @media print { .no-print { display: none !important; } }
  </style>
</head>
<body>
  <div class="report-header">
    <div class="report-title-box">
      <h1>📊 Class Assessment Summary Report</h1>
      <div class="report-subtitle">${quiz.title} • ${quiz.subject || 'General'} ${selectedClass !== 'all' ? `• Class Section: ${selectedClass}` : ''}</div>
    </div>
    <div class="report-badge-box">
      <div class="report-code-badge">CODE: ${quiz.quizCode}</div>
      <div class="report-date">Generated on ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
    </div>
  </div>

  <div class="kpi-grid">
    <div class="kpi-card"><span class="kpi-card-val">${count}</span><span class="kpi-card-lbl">Total Students</span></div>
    <div class="kpi-card"><span class="kpi-card-val">${avgScore.toFixed(1)} / ${totalMarks}</span><span class="kpi-card-lbl">Class Average (${Math.round(avgPct)}%)</span></div>
    <div class="kpi-card"><span class="kpi-card-val">${highestScore} / ${totalMarks}</span><span class="kpi-card-lbl">Highest Score</span></div>
    <div class="kpi-card"><span class="kpi-card-val">${lowestScore} / ${totalMarks}</span><span class="kpi-card-lbl">Lowest Score</span></div>
    ${isOffline ? `
    <div class="kpi-card">
      <span class="kpi-card-val" style="color: ${passRate >= 70 ? '#16a34a' : '#ea580c'}">${passRate}%</span>
      <span class="kpi-card-lbl">Pass Rate (≥50%)</span>
    </div>
    ` : `
    <div class="kpi-card">
      <span class="kpi-card-val" style="color: ${integrityRate >= 90 ? '#16a34a' : '#ea580c'}">${integrityRate}%</span>
      <span class="kpi-card-lbl">Integrity (${cleanCount} Clean)</span>
    </div>
    `}
  </div>

  <div class="section-title">📈 Grade Band Distribution</div>
  <table>
    <thead>
      <tr>
        <th style="width: 14%;">Grade</th>
        <th style="width: 14%;">A* (≥90%)</th>
        <th style="width: 14%;">A (80–89%)</th>
        <th style="width: 14%;">B (70–79%)</th>
        <th style="width: 14%;">C (60–69%)</th>
        <th style="width: 14%;">D (50–59%)</th>
        <th style="width: 16%;">E / U (&lt;50%)</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="font-weight: 700;">Students</td>
        <td style="font-weight: 700; color: #d97706;">${gradeCounts['A*']} (${Math.round((gradeCounts['A*'] / count) * 100)}%)</td>
        <td style="font-weight: 700; color: #059669;">${gradeCounts['A']} (${Math.round((gradeCounts['A'] / count) * 100)}%)</td>
        <td style="font-weight: 700; color: #2563eb;">${gradeCounts['B']} (${Math.round((gradeCounts['B'] / count) * 100)}%)</td>
        <td style="font-weight: 700; color: #7c3aed;">${gradeCounts['C']} (${Math.round((gradeCounts['C'] / count) * 100)}%)</td>
        <td style="font-weight: 700; color: #ea580c;">${gradeCounts['D']} (${Math.round((gradeCounts['D'] / count) * 100)}%)</td>
        <td style="font-weight: 700; color: #dc2626;">${gradeCounts['E'] + gradeCounts['U']} (${Math.round(((gradeCounts['E'] + gradeCounts['U']) / count) * 100)}%)</td>
      </tr>
    </tbody>
  </table>

  ${Object.keys(topicStats).length > 0 ? `
  <div class="section-title">🎯 Syllabus Topic Performance</div>
  <table>
    <thead><tr><th>Topic</th><th style="width: 25%;">Avg Mastery (%)</th><th style="width: 20%; text-align: center;">Marks Earned / Total</th></tr></thead>
    <tbody>
      ${Object.entries(topicStats).map(([topic, stat]) => {
        const pct = Math.round((stat.totalEarned / stat.totalAvailable) * 100);
        return `<tr><td><strong>${topic}</strong></td><td><div style="display: flex; align-items: center; gap: 8px;"><span style="font-weight: 700; width: 35px;">${pct}%</span><div class="pct-bar-bg" style="flex: 1;"><div class="pct-bar-fill" style="width: ${pct}%; background: ${pct >= 75 ? '#16a34a' : pct >= 50 ? '#3b82f6' : '#dc2626'};"></div></div></div></td><td style="text-align: center; color: #64748b;">${stat.totalEarned} / ${stat.totalAvailable}</td></tr>`;
      }).join('')}
    </tbody>
  </table>
  ` : ''}

  <div class="section-title">📋 Student Roster & Gradebook (${rankedSubmissions.length} Candidates)</div>
  <table>
    <thead>
      <tr>
        <th style="width: 6%; text-align: center;">Rank</th>
        <th style="width: 32%;">Candidate / Student Name</th>
        <th style="width: 18%;">Class / Section</th>
        <th style="width: 14%; text-align: center;">Cand #</th>
        <th style="width: 14%; text-align: center;">Score</th>
        <th style="width: 10%; text-align: center;">%</th>
        <th style="width: 10%; text-align: center;">Grade</th>
        ${!isOffline ? `<th style="width: 12%; text-align: center;">Time</th><th style="width: 10%; text-align: center;">Integrity</th>` : ''}
      </tr>
    </thead>
    <tbody>
      ${rankedSubmissions.map((sub, rIdx) => {
        const { grade, color } = deriveGrade(sub.percentage);
        const mins = Math.floor(sub.durationSeconds / 60);
        const secs = sub.durationSeconds % 60;
        const isClean = sub.violationsCount === 0;
        return `<tr><td style="text-align: center; font-weight: 800; color: #64748b;">#${rIdx + 1}</td><td><strong>${sub.studentName}</strong></td><td>${sub.studentClass || 'General'}</td><td style="text-align: center; font-family: monospace;">${sub.candidateNumber || '-'}</td><td style="text-align: center; font-weight: 700;">${sub.score} / ${sub.totalMarks}</td><td style="text-align: center; font-weight: 800;">${Math.round(sub.percentage)}%</td><td style="text-align: center;"><span class="grade-badge" style="background: ${color};">${grade}</span></td>${!isOffline ? `<td style="text-align: center; font-size: 8pt; color: #64748b;">${mins}m ${secs}s</td><td style="text-align: center; font-size: 7.5pt; font-weight: 700; color: ${isClean ? '#16a34a' : '#ea580c'};">${isClean ? 'Clean (0)' : `⚠️ ${sub.violationsCount}`}</td>` : ''}</tr>`;
      }).join('')}
    </tbody>
  </table>
  <div class="footer-note">Assessment Code: ${quiz.quizCode} | Generated by fluffykitten's testmaker</div>
  <script>window.addEventListener('load', () => setTimeout(window.print, 300));</script>
</body>
</html>`;

  const printWindow = window.open('', '_blank');
  if (printWindow) {
    printWindow.document.write(htmlContent);
    printWindow.document.close();
  }
}

export interface ReportCardOptions {
  showMarkScheme?: boolean;
}

/**
 * Helper to return shared CSS styles for 1-page student performance and improvement reports.
 */
function getReportCardStyles(): string {
  return `<style>
    @page {
      size: A4 portrait;
      margin: 7mm 8mm 7mm 8mm;
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
      font-size: 7.8pt;
      line-height: 1.32;
    }
    .student-page {
      page-break-after: always;
      break-after: page;
      page-break-inside: avoid;
      break-inside: avoid;
      box-sizing: border-box;
    }
    .student-page:last-child {
      page-break-after: avoid;
      break-after: avoid;
    }
    .header-card {
      border: 1.5px solid #0f172a;
      border-radius: 6px;
      padding: 6px 12px;
      margin-bottom: 6px;
      background: #f8fafc;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .header-title-box h1 {
      font-size: 11.5pt;
      font-weight: 800;
      color: #0f172a;
      margin: 0 0 2px 0;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }
    .header-sub {
      font-size: 7.8pt;
      color: #475569;
      font-weight: 600;
    }
    .score-grade-wrap {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .score-box {
      text-align: right;
    }
    .score-val {
      font-size: 14pt;
      font-weight: 800;
      color: #0f172a;
      line-height: 1;
    }
    .score-lbl {
      font-size: 6.8pt;
      color: #64748b;
      font-weight: 700;
      text-transform: uppercase;
      margin-top: 2px;
    }
    .grade-badge {
      color: #ffffff;
      font-size: 15pt;
      font-weight: 800;
      padding: 4px 12px;
      border-radius: 6px;
      line-height: 1;
    }
    .meta-bar {
      display: grid;
      grid-template-columns: 2fr 1fr 1fr 1.3fr 1fr;
      gap: 6px;
      background: #f1f5f9;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      padding: 4px 8px;
      margin-bottom: 6px;
      font-size: 7.2pt;
    }
    .meta-item strong {
      display: block;
      color: #0f172a;
      font-size: 7.8pt;
    }
    .meta-item span {
      color: #64748b;
    }
    .main-grid {
      display: grid;
      grid-template-columns: 1.12fr 0.88fr;
      gap: 6px;
    }
    .panel {
      border: 1px solid #cbd5e1;
      border-radius: 5px;
      padding: 5px 7px;
      background: #ffffff;
    }
    .panel-heading {
      font-size: 7.8pt;
      font-weight: 800;
      color: #1e293b;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      margin: 0 0 4px 0;
      padding-bottom: 3px;
      border-bottom: 1px solid #e2e8f0;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .table-compact {
      width: 100%;
      border-collapse: collapse;
      font-size: 7pt;
    }
    .table-compact th {
      background: #f8fafc;
      border: 1px solid #cbd5e1;
      padding: 2px 3px;
      text-align: left;
      font-weight: 700;
      color: #334155;
    }
    .table-compact td {
      border: 1px solid #e2e8f0;
      padding: 1.8px 3px;
    }
    .status-correct {
      color: #16a34a;
      font-weight: 800;
    }
    .status-incorrect {
      color: #dc2626;
      font-weight: 800;
    }
    .topic-pill {
      display: inline-flex;
      align-items: center;
      background: #f1f5f9;
      border: 1px solid #e2e8f0;
      border-radius: 4px;
      padding: 1px 4px;
      margin: 1px 2px 1px 0;
      font-size: 6.8pt;
    }
    .plan-card {
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      padding: 4px 6px;
      margin-bottom: 4px;
    }
    .plan-card--strengths {
      border-left: 3px solid #16a34a;
    }
    .plan-card--weaknesses {
      border-left: 3px solid #dc2626;
    }
    .plan-card--action {
      border-left: 3px solid #2563eb;
    }
    .plan-card-title {
      font-size: 7.2pt;
      font-weight: 800;
      text-transform: uppercase;
      margin: 0 0 2px 0;
      display: flex;
      align-items: center;
      gap: 3px;
    }
    .plan-list {
      margin: 0;
      padding-left: 12px;
      font-size: 6.9pt;
      line-height: 1.28;
    }
    .plan-list li {
      margin-bottom: 1px;
    }
    .encouragement-box {
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-left: 3px solid #7c3aed;
      border-radius: 4px;
      padding: 4px 6px;
      font-size: 7pt;
      color: #1e293b;
      line-height: 1.28;
      margin-bottom: 4px;
    }
    .encouragement-title {
      font-weight: 800;
      font-size: 7.2pt;
      color: #701a75;
      text-transform: uppercase;
      margin-bottom: 2px;
      display: flex;
      align-items: center;
      gap: 3px;
    }
    .mentor-note {
      font-size: 6.8pt;
      color: #475569;
      font-style: italic;
      margin-top: 2px;
      padding-top: 2px;
      border-top: 1px dashed #cbd5e1;
    }
    .sign-bar {
      display: flex;
      justify-content: space-between;
      margin-top: 4px;
      padding-top: 3px;
      border-top: 1px solid #cbd5e1;
      font-size: 6.8pt;
      color: #64748b;
    }
    /* Dynamic Mark Scheme Visibility */
    body.hide-mark-scheme .col-ms,
    .student-page.hide-mark-scheme .col-ms {
      display: none !important;
    }
    body.hide-mark-scheme .table-compact th.col-qnum,
    body.hide-mark-scheme .table-compact td.col-qnum,
    .student-page.hide-mark-scheme .table-compact th.col-qnum,
    .student-page.hide-mark-scheme .table-compact td.col-qnum {
      width: 10% !important;
    }
    body.hide-mark-scheme .table-compact th.col-topic,
    body.hide-mark-scheme .table-compact td.col-topic,
    .student-page.hide-mark-scheme .table-compact th.col-topic,
    .student-page.hide-mark-scheme .table-compact td.col-topic {
      width: 44% !important;
    }
    body.hide-mark-scheme .table-compact th.col-answer,
    body.hide-mark-scheme .table-compact td.col-answer,
    .student-page.hide-mark-scheme .table-compact th.col-answer,
    .student-page.hide-mark-scheme .table-compact td.col-answer {
      width: 32% !important;
    }
    body.hide-mark-scheme .table-compact th.col-result,
    body.hide-mark-scheme .table-compact td.col-result,
    .student-page.hide-mark-scheme .table-compact th.col-result,
    .student-page.hide-mark-scheme .table-compact td.col-result {
      width: 14% !important;
    }
    body.hide-mark-scheme .ms-heading-with-key,
    .student-page.hide-mark-scheme .ms-heading-with-key {
      display: none !important;
    }
    body.hide-mark-scheme .ms-heading-no-key,
    .student-page.hide-mark-scheme .ms-heading-no-key {
      display: inline !important;
    }
    body:not(.hide-mark-scheme) .student-page:not(.hide-mark-scheme) .ms-heading-no-key {
      display: none !important;
    }
    body:not(.hide-mark-scheme) .student-page:not(.hide-mark-scheme) .ms-heading-with-key {
      display: inline !important;
    }
    @media screen {
      body {
        background: #f1f5f9;
        padding: 16px;
      }
      .student-page {
        background: #ffffff;
        max-width: 210mm;
        margin: 0 auto 20px auto;
        padding: 8mm;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12);
        border-radius: 6px;
      }
    }
    @media print {
      .no-print {
        display: none !important;
      }
      body {
        background: #ffffff;
        padding: 0;
        margin: 0;
      }
      .student-page {
        box-shadow: none;
        border-radius: 0;
        padding: 0;
        margin: 0;
        height: 100vh;
        max-height: 100vh;
        overflow: hidden;
      }
    }
  </style>`;
}

/**
 * Renders the HTML markup for a single candidate's 1-page feedback report card.
 */
export function renderSingleStudentFeedbackReportHtml(
  submission: StudentSubmission,
  plan: StudentImprovementPlan,
  options?: ReportCardOptions
): string {
  const showMarkScheme = options?.showMarkScheme !== false;
  const { grade, color } = deriveGrade(submission.percentage);

  const topicMastery: Array<{ topic: string; earned: number; total: number; pct: number }> = [];
  if (submission.topicBreakdown) {
    Object.entries(submission.topicBreakdown).forEach(([topic, d]) => {
      topicMastery.push({ topic, earned: d.earnedMarks, total: d.totalMarks, pct: Math.round(d.percentage) });
    });
  }

  const results = submission.questionResults || [];

  return `
  <div class="student-page ${showMarkScheme ? '' : 'hide-mark-scheme'}">
    <!-- Header Card -->
    <div class="header-card">
      <div class="header-title-box">
        <h1>🎓 Student Performance & Improvement Report</h1>
        <div class="header-sub">
          ${submission.quizTitle} • ${submission.subject || 'General Assessment'}
        </div>
      </div>
      <div class="score-grade-wrap">
        <div class="score-box">
          <div class="score-val">${submission.score} / ${submission.totalMarks}</div>
          <div class="score-lbl">Total Score (${Math.round(submission.percentage)}%)</div>
        </div>
        <div class="grade-badge" style="background: ${color};">${grade}</div>
      </div>
    </div>

    <!-- Candidate Metadata -->
    <div class="meta-bar">
      <div class="meta-item">
        <span>Candidate Name:</span>
        <strong>${submission.studentName}</strong>
      </div>
      <div class="meta-item">
        <span>Class / Section:</span>
        <strong>${submission.studentClass || 'General'}</strong>
      </div>
      <div class="meta-item">
        <span>Candidate ID:</span>
        <strong style="font-family: monospace;">${submission.candidateNumber || '-'}</strong>
      </div>
      <div class="meta-item">
        <span>Total Marks:</span>
        <strong>${submission.score} / ${submission.totalMarks} (${Math.round(submission.percentage)}%)</strong>
      </div>
      <div class="meta-item">
        <span>Date:</span>
        <strong>${formatSubmissionDateTime(submission.submittedAt).split(',')[0]}</strong>
      </div>
    </div>

    <!-- 2-Column Split: Left = Answer Matrix & Topics, Right = Improvement Plan & Encouragement -->
    <div class="main-grid">
      <!-- Left Column: Student Answers & Topic Breakdown -->
      <div>
        <!-- Topic Mastery Strip -->
        ${topicMastery.length > 0 ? `
        <div class="panel" style="margin-bottom: 5px;">
          <div class="panel-heading">🎯 Topic Mastery Summary</div>
          <div>
            ${topicMastery.map((tm) => `
              <div class="topic-pill">
                <span>${tm.topic}:</span>
                <strong style="margin-left: 3px; color: ${tm.pct >= 75 ? '#16a34a' : tm.pct >= 50 ? '#2563eb' : '#dc2626'};">${tm.earned}/${tm.total} (${tm.pct}%)</strong>
              </div>
            `).join('')}
          </div>
        </div>
        ` : ''}

        <!-- Detailed Question Matrix -->
        <div class="panel">
          <div class="panel-heading">
            <span class="ms-heading-with-key">📝 Student Responses & Mark Scheme Key</span>
            <span class="ms-heading-no-key" style="display: ${showMarkScheme ? 'none' : 'inline'};">📝 Student Responses Summary</span>
          </div>
          <table class="table-compact">
            <thead>
              <tr>
                <th class="col-qnum" style="width: 8%; text-align: center;">Q#</th>
                <th class="col-topic" style="width: 30%;">Topic</th>
                <th class="col-answer" style="width: 26%; text-align: center;">Your Answer</th>
                <th class="col-ms" style="width: 24%; text-align: center;">Mark Scheme</th>
                <th class="col-result" style="width: 12%; text-align: center;">Result</th>
              </tr>
            </thead>
            <tbody>
              ${results.map((qr, idx) => {
                const qNum = qr.questionNumber || idx + 1;
                const isCorrect = qr.isCorrect;
                const sAns = formatCandidateAnswer(qr.studentAnswer, qr.options, qr.gradingMethod, true);
                const cAns = formatCandidateAnswer(
                  qr.correctAnswer || (isCorrect ? qr.studentAnswer : undefined),
                  qr.options,
                  qr.gradingMethod,
                  true
                );

                return `
                  <tr>
                    <td class="col-qnum" style="text-align: center; font-weight: 700;">Q${qNum}</td>
                    <td class="col-topic">${qr.topic || 'General'}</td>
                    <td class="col-answer" style="text-align: center;"><span style="font-weight: 600; color: ${isCorrect ? '#16a34a' : '#dc2626'};">${sAns}</span></td>
                    <td class="col-ms" style="text-align: center; color: #475569;">${cAns}</td>
                    <td class="col-result" style="text-align: center;">
                      <span class="${isCorrect ? 'status-correct' : 'status-incorrect'}">${isCorrect ? '✓' : '✗'}</span>
                      <span style="font-size: 6.2pt; color: #64748b;">(${qr.earnedMarks}/${qr.maxMarks})</span>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Right Column: Personalized Diagnostics & Action Plan + Encouragement -->
      <div>
        <div class="panel">
          <div class="panel-heading">📋 Personalized Diagnostic & Improvement Plan</div>

          <!-- Encouraging Words Box -->
          <div class="encouragement-box">
            <div class="encouragement-title">💖 Words of Encouragement</div>
            <div>${plan.encouragingWords || 'Great effort on this assessment! Keep practicing and believing in your potential.'}</div>
            ${plan.teacherSummary ? `<div class="mentor-note"><strong>Examiner Guidance:</strong> ${plan.teacherSummary}</div>` : ''}
          </div>

          <!-- Strengths -->
          <div class="plan-card plan-card--strengths">
            <div class="plan-card-title" style="color: #166534;">🌟 What Went Well</div>
            <ul class="plan-list" style="color: #14532d;">
              ${plan.strengths.map((s) => `<li>${s}</li>`).join('')}
            </ul>
          </div>

          <!-- Areas for Focus -->
          ${plan.weaknesses.length > 0 ? `
          <div class="plan-card plan-card--weaknesses">
            <div class="plan-card-title" style="color: #991b1b;">⚠️ Priority Focus Areas</div>
            <ul class="plan-list" style="color: #7f1d1d;">
              ${plan.weaknesses.map((w) => `<li>${w}</li>`).join('')}
            </ul>
          </div>
          ` : ''}

          <!-- Targeted Next Steps -->
          <div class="plan-card plan-card--action">
            <div class="plan-card-title" style="color: #1e40af;">🎯 Targeted Next Steps</div>
            <ul class="plan-list" style="color: #1e3a8a;">
              ${plan.improvementSteps.map((step) => `<li>${step}</li>`).join('')}
            </ul>
          </div>

          <!-- Signatures for Subject Teacher and Parents under Improvement Plan -->
          <div style="margin-top: 6px; padding: 6px 8px; border: 1.5px solid #cbd5e1; border-radius: 5px; background: #ffffff;">
            <div style="font-weight: 800; font-size: 7.2pt; text-transform: uppercase; margin-bottom: 5px; color: #0f172a; display: flex; align-items: center; gap: 4px;">
              ✍️ Review Signatures & Acknowledgment
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; font-size: 6.8pt; color: #334155;">
              <div style="border: 1px dashed #94a3b8; border-radius: 4px; padding: 4px 6px; min-height: 46px; display: flex; flex-direction: column; justify-content: space-between;">
                <span style="font-weight: 700; color: #0f172a;">Subject Teacher Signature:</span>
                <div style="border-bottom: 1px solid #475569; margin-top: 18px;"></div>
              </div>
              <div style="border: 1px dashed #94a3b8; border-radius: 4px; padding: 4px 6px; min-height: 46px; display: flex; flex-direction: column; justify-content: space-between;">
                <span style="font-weight: 700; color: #0f172a;">Parent / Guardian Signature:</span>
                <div style="border-bottom: 1px solid #475569; margin-top: 18px;"></div>
              </div>
            </div>
            <div style="display: flex; justify-content: space-between; margin-top: 4px; font-size: 6.6pt; color: #64748b;">
              <div><strong>Date:</strong> ____________________</div>
              <div><strong>Student Acknowledgment:</strong> ____________________</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 2. INDIVIDUAL 1-PAGE CANDIDATE FEEDBACK & IMPROVEMENT REPORT (STUDENT COPY)
 * ═══════════════════════════════════════════════════════════════════════════════
 */
export async function exportStudentFeedbackReportPdf(
  submission: StudentSubmission,
  customPlan?: StudentImprovementPlan,
  options?: ReportCardOptions
): Promise<void> {
  if (!submission) return;

  const showMarkScheme = options?.showMarkScheme !== false;
  const plan = customPlan || (await generateStudentImprovementPlan(submission));
  const studentPageHtml = renderSingleStudentFeedbackReportHtml(submission, plan, options);

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Student Performance & Feedback Report - ${submission.studentName}</title>
  ${getReportCardStyles()}
</head>
<body class="${showMarkScheme ? '' : 'hide-mark-scheme'}">

  <!-- Non-Printing Control Bar -->
  <div class="no-print" style="position: sticky; top: 0; z-index: 1000; background: #0f172a; color: #ffffff; padding: 8px 16px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 4px 12px rgba(0,0,0,0.25); margin-bottom: 16px; gap: 12px; flex-wrap: wrap;">
    <div style="font-weight: 800; font-size: 12px; display: flex; align-items: center; gap: 6px;">
      <span>📄</span> 1-Page Student Report Card: <strong>${submission.studentName}</strong> (${submission.studentClass || 'General'})
    </div>
    <div style="display: flex; align-items: center; gap: 10px;">
      <label style="display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; cursor: pointer; user-select: none; background: rgba(255,255,255,0.12); padding: 5px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.2);">
        <input type="checkbox" id="toggleMarkScheme" ${showMarkScheme ? 'checked' : ''} onchange="toggleMarkScheme(this.checked)" style="cursor: pointer; accent-color: #3b82f6; width: 14px; height: 14px;" />
        <span>Show Mark Scheme</span>
      </label>
      <button onclick="window.print()" style="background: #2563eb; color: #ffffff; border: none; padding: 6px 14px; border-radius: 6px; font-weight: 800; font-size: 11px; cursor: pointer; display: flex; align-items: center; gap: 5px;">
        🖨️ Print Student Copy (1 Page)
      </button>
      <button onclick="window.close()" style="background: rgba(255,255,255,0.1); color: #ffffff; border: 1px solid rgba(255,255,255,0.2); padding: 6px 12px; border-radius: 6px; font-weight: 600; font-size: 11px; cursor: pointer;">
        ✕ Close
      </button>
    </div>
  </div>

  <!-- Candidate Report Page -->
  ${studentPageHtml}

  <script>
    function toggleMarkScheme(show) {
      if (show) {
        document.body.classList.remove('hide-mark-scheme');
        document.querySelectorAll('.student-page').forEach(function(el) {
          el.classList.remove('hide-mark-scheme');
        });
      } else {
        document.body.classList.add('hide-mark-scheme');
        document.querySelectorAll('.student-page').forEach(function(el) {
          el.classList.add('hide-mark-scheme');
        });
      }
    }

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
    alert('Please allow popups to open the report window.');
    return;
  }
  printWindow.document.open();
  printWindow.document.write(htmlContent);
  printWindow.document.close();
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 2B. BATCH 1-PAGE CANDIDATE FEEDBACK & IMPROVEMENT REPORTS (ENTIRE CLASS IN 1 PDF)
 * ═══════════════════════════════════════════════════════════════════════════════
 */
export async function exportBatchStudentFeedbackReportPdf(
  submissions: StudentSubmission[],
  quizTitle?: string,
  selectedClass: string = 'all',
  options?: ReportCardOptions
): Promise<void> {
  if (!submissions || submissions.length === 0) {
    alert('No student submissions available to generate report cards.');
    return;
  }

  const showMarkScheme = options?.showMarkScheme !== false;

  // Filter by selected class if specified
  const filteredSubmissions = selectedClass === 'all'
    ? submissions
    : submissions.filter((s) => (s.studentClass || 'General').toLowerCase() === selectedClass.toLowerCase());

  if (filteredSubmissions.length === 0) {
    alert(`No student submissions found for class "${selectedClass}".`);
    return;
  }

  // Generate improvement plans for all candidates concurrently
  const plans = await Promise.all(
    filteredSubmissions.map(async (sub) => {
      try {
        return await generateStudentImprovementPlan(sub);
      } catch {
        return undefined;
      }
    })
  );

  const studentPagesHtml = filteredSubmissions.map((sub, idx) => {
    return renderSingleStudentFeedbackReportHtml(sub, plans[idx] || ({} as any), options);
  }).join('\n');

  const titleText = quizTitle || filteredSubmissions[0]?.quizTitle || 'Class Assessment';
  const classLabel = selectedClass === 'all' ? 'All Candidates' : `Class ${selectedClass}`;

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Batch Student Report Cards - ${titleText} (${classLabel})</title>
  ${getReportCardStyles()}
</head>
<body class="${showMarkScheme ? '' : 'hide-mark-scheme'}">

  <!-- Non-Printing Control Bar -->
  <div class="no-print" style="position: sticky; top: 0; z-index: 1000; background: #0f172a; color: #ffffff; padding: 10px 18px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 4px 12px rgba(0,0,0,0.25); margin-bottom: 16px; gap: 12px; flex-wrap: wrap;">
    <div style="display: flex; align-items: center; gap: 10px;">
      <span style="font-size: 16px;">🎓</span>
      <div>
        <div style="font-weight: 800; font-size: 13px;">
          Batch Student Report Cards (${filteredSubmissions.length} Candidates — 1 Page Each)
        </div>
        <div style="font-size: 10px; color: #94a3b8;">
          ${titleText} • ${classLabel}
        </div>
      </div>
    </div>
    <div style="display: flex; align-items: center; gap: 10px;">
      <label style="display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; cursor: pointer; user-select: none; background: rgba(255,255,255,0.12); padding: 5px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.2);">
        <input type="checkbox" id="toggleMarkScheme" ${showMarkScheme ? 'checked' : ''} onchange="toggleMarkScheme(this.checked)" style="cursor: pointer; accent-color: #3b82f6; width: 14px; height: 14px;" />
        <span>Show Mark Scheme</span>
      </label>
      <button onclick="window.print()" style="background: linear-gradient(135deg, #2563eb, #1d4ed8); color: #ffffff; border: none; padding: 7px 16px; border-radius: 6px; font-weight: 800; font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 6px; box-shadow: 0 2px 8px rgba(37,99,235,0.4);">
        🖨️ Print / Save as PDF (${filteredSubmissions.length} Pages)
      </button>
      <button onclick="window.close()" style="background: rgba(255,255,255,0.1); color: #ffffff; border: 1px solid rgba(255,255,255,0.2); padding: 7px 12px; border-radius: 6px; font-weight: 600; font-size: 11px; cursor: pointer;">
        ✕ Close
      </button>
    </div>
  </div>

  ${studentPagesHtml}

  <script>
    function toggleMarkScheme(show) {
      if (show) {
        document.body.classList.remove('hide-mark-scheme');
        document.querySelectorAll('.student-page').forEach(function(el) {
          el.classList.remove('hide-mark-scheme');
        });
      } else {
        document.body.classList.add('hide-mark-scheme');
        document.querySelectorAll('.student-page').forEach(function(el) {
          el.classList.add('hide-mark-scheme');
        });
      }
    }

    window.addEventListener('load', () => {
      setTimeout(() => {
        window.print();
      }, 400);
    });
  </script>
</body>
</html>`;

  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Please allow popups to open the batch PDF report window.');
    return;
  }
  printWindow.document.open();
  printWindow.document.write(htmlContent);
  printWindow.document.close();
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 3. INDIVIDUAL DETAILED SCRIPT REPORT (FULL MULTI-PAGE SCRIPT BREAKDOWN)
 * ═══════════════════════════════════════════════════════════════════════════════
 */
export function exportIndividualStudentReportPdf(
  submission: StudentSubmission,
  options?: ReportCardOptions
): void {
  if (!submission) return;

  const showMarkScheme = options?.showMarkScheme !== false;
  const isOffline =
    !submission.quizCode ||
    submission.quizCode.toUpperCase().startsWith('OFFLINE') ||
    submission.durationSeconds === 0 ||
    submission.teacherNotes?.toLowerCase().includes('offline');

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
    @page { size: A4 portrait; margin: 12mm; }
    body { font-family: sans-serif; color: #0f172a; font-size: 9pt; line-height: 1.45; margin: 0; padding: 0; }
    .cand-header-card { border: 1.5px solid #cbd5e1; border-radius: 8px; padding: 12px; margin-bottom: 14px; background: #f8fafc; display: flex; justify-content: space-between; }
    .cand-grade-tag { background: ${color}; color: #ffffff; font-weight: 800; font-size: 18pt; padding: 6px 14px; border-radius: 6px; }
    .meta-bar { display: grid; grid-template-columns: repeat(${isOffline ? 3 : 5}, 1fr); gap: 8px; background: #f1f5f9; border-radius: 6px; padding: 8px; margin-bottom: 14px; font-size: 8pt; }
    .meta-item strong { display: block; }
    .section-title { font-size: 10.5pt; font-weight: 800; border-bottom: 1.5px solid #e2e8f0; margin: 14px 0 8px; }
    .q-script-card { border: 1px solid #cbd5e1; border-radius: 8px; padding: 10px; margin-bottom: 12px; }
    .score-full { background: rgba(34, 197, 94, 0.15); color: #16a34a; }
    .score-partial { background: rgba(234, 179, 8, 0.15); color: #ca8a04; }
    .score-zero { background: rgba(239, 68, 68, 0.15); color: #dc2626; }
    .model-ans-box { background: #f0fdf4; border: 1px solid #bbf7d0; padding: 6px; margin-top: 6px; font-size: 8pt; }
    body.hide-mark-scheme .model-ans-box,
    body.hide-mark-scheme .criteria-box {
      display: none !important;
    }
    @media print {
      .no-print {
        display: none !important;
      }
    }
  </style>
</head>
<body class="${showMarkScheme ? '' : 'hide-mark-scheme'}">
  <!-- Non-Printing Control Bar -->
  <div class="no-print" style="position: sticky; top: 0; z-index: 1000; background: #0f172a; color: #ffffff; padding: 8px 16px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 4px 12px rgba(0,0,0,0.25); margin-bottom: 16px; gap: 12px; flex-wrap: wrap;">
    <div style="font-weight: 800; font-size: 12px;">
      📄 Candidate Diagnostic Script: ${submission.studentName} (${submission.quizCode || 'General'})
    </div>
    <div style="display: flex; align-items: center; gap: 10px;">
      <label style="display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; cursor: pointer; user-select: none; background: rgba(255,255,255,0.12); padding: 5px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.2);">
        <input type="checkbox" id="toggleMarkScheme" ${showMarkScheme ? 'checked' : ''} onchange="document.body.classList.toggle('hide-mark-scheme', !this.checked)" style="cursor: pointer; accent-color: #3b82f6; width: 14px; height: 14px;" />
        <span>Show Mark Scheme</span>
      </label>
      <button onclick="window.print()" style="background: #2563eb; color: #ffffff; border: none; padding: 6px 14px; border-radius: 6px; font-weight: 800; font-size: 11px; cursor: pointer;">
        🖨️ Print Script
      </button>
      <button onclick="window.close()" style="background: rgba(255,255,255,0.1); color: #ffffff; border: 1px solid rgba(255,255,255,0.2); padding: 6px 12px; border-radius: 6px; font-weight: 600; font-size: 11px; cursor: pointer;">
        ✕ Close
      </button>
    </div>
  </div>

  <div class="cand-header-card">
    <div>
      <h1 style="font-size: 15pt; font-weight: 800; margin: 0 0 2px 0;">👤 ${submission.studentName}</h1>
      <div style="font-size: 8.5pt; color: #475569; font-weight: 600;">
        ${submission.quizTitle} • ${submission.subject || 'General'} • <strong>Class: ${submission.studentClass || 'General'}</strong>${submission.candidateNumber ? ` • <strong>Cand #: ${submission.candidateNumber}</strong>` : ''}
      </div>
    </div>
    <div style="display: flex; align-items: center; gap: 12px;">
      <div style="text-align: right;">
        <div style="font-size: 16pt; font-weight: 800;">${submission.score} / ${submission.totalMarks}</div>
        <div style="font-size: 7.5pt; color: #64748b; font-weight: 700; text-transform: uppercase;">Score (${Math.round(submission.percentage)}%)</div>
      </div>
      <div class="cand-grade-tag">${grade}</div>
    </div>
  </div>

  <div class="meta-bar">
    <div class="meta-item">
      <span>Class / Section:</span>
      <strong>${submission.studentClass || 'General'}</strong>
    </div>
    <div class="meta-item">
      <span>Candidate ID:</span>
      <strong style="font-family: monospace;">${submission.candidateNumber || 'N/A'}</strong>
    </div>
    <div class="meta-item">
      <span>Assessment:</span>
      <strong>${isOffline ? 'Offline Paper Exam' : submission.quizCode}</strong>
    </div>
    ${!isOffline ? `
    <div class="meta-item">
      <span>Time Taken:</span>
      <strong>${mins}m ${secs}s</strong>
    </div>
    <div class="meta-item">
      <span>Exam Integrity:</span>
      <strong style="color: ${isClean ? '#16a34a' : '#ea580c'}">${isClean ? '🟢 0 Strikes (Clean)' : `⚠️ ${submission.violationsCount} Strikes`}</strong>
    </div>
    ` : ''}
  </div>

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
