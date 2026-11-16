// ─── ICM Excel Export Service (exceljs) ──────────────────────────────────────
// Institutional presentation-grade Excel reporting engine for Sekolah Insan Cendekia Madani (ICM).
// Features official ICM colors, executive KPI ribbons, psychometric Item Analysis,
// and a student-by-question response heatmap matrix.

import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { deriveGradeFromPercentage, type GradeThresholds } from '../utils/gradeThresholdUtils';
import { DEFAULT_SCHOOL_LOGO, DEFAULT_CAMBRIDGE_LOGO } from '../assets/logoConstants';
import {
  computeSubmissionTopicMastery,
  resolveMasteryTier,
  type MasteryTierColor,
  type TopicMasteryTier,
} from '../lib/topicMastery';
import { getTopicMasteryTiers } from '../lib/settings';
import { exportFileUniversal } from './fileExportBridge';
import type {
  StudentSubmission,
  AnswerChangeLogEntry,
  QuestionTimeAnalytics,
} from './quizSubmissionService';
import type { ProctorLogEvent } from './examProctorRealtimeService';
import { formatProctorTimestamp, formatSubmissionDateTime, formatCandidateAnswer } from './quizSubmissionService';

// ─── Official ICM Institutional Branding Tokens ──────────────────────────────
export const ICM_BRAND = {
  schoolName: 'SEKOLAH INSAN CENDEKIA MADANI',
  schoolSub: 'Cambridge International School ID395',
  colors: {
    // Primary Institutional Blues
    blue: 'FF24448C',       // Official ICM Deep Blue
    blueDark: 'FF1B3570',   // High-contrast Navy Accent
    blueLight: 'FFF1F5FA',  // Light Blue Tint for KPI Cards
    blueBorder: 'FFCCD7EC', // Soft Blue Border
    
    // Accent Greens
    green: 'FF8ABF44',      // Official ICM Fresh Green
    greenDark: 'FF537A1F',  // Forest Green Text
    greenLight: 'FFF5F9ED', // Light Green Tint
    greenBorder: 'FFDBEABA',// Soft Green Border

    // Neutral Surfaces & Text
    white: 'FFFFFFFF',
    slateHeader: 'FF0F172A',
    slateText: 'FF1E293B',
    mutedText: 'FF64748B',
    zebraRow: 'FFF8FAFC',
    gridBorder: 'FFE2E8F0',

    // Diagnostic & Grade Alerts
    amber: 'FFD97706',
    amberLight: 'FFFEF3C7',
    amberText: 'FF92400E',
    crimson: 'FFDC2626',
    crimsonLight: 'FFFEE2E2',
    crimsonText: 'FF991B1B',
    emerald: 'FF059669',
    emeraldLight: 'FFE8F5D8',
    emeraldText: 'FF14532D',
  },
};

/**
 * Prevents spreadsheet formula/DDE injection (=, +, -, @, tab, CR) on untrusted text cells.
 */
export function sanitizeSpreadsheetCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (!str || str === '-') return str;
  if (/^\s*[=+\-@\t\r]/.test(str)) {
    return `'${str}`;
  }
  return str;
}

const BORDER_THIN: Partial<ExcelJS.Borders> = {
  top: { style: 'thin', color: { argb: ICM_BRAND.colors.gridBorder } },
  left: { style: 'thin', color: { argb: ICM_BRAND.colors.gridBorder } },
  bottom: { style: 'thin', color: { argb: ICM_BRAND.colors.gridBorder } },
  right: { style: 'thin', color: { argb: ICM_BRAND.colors.gridBorder } },
};

const workbookLogoCache = new WeakMap<ExcelJS.Workbook, { icmId: number; cambridgeId: number }>();

const ICM_LOGO_EXT = { width: Math.round(46 * (222 / 71)), height: 46 }; // 144x46 (ratio 3.127 preserved)
const CAMBRIDGE_LOGO_EXT = { width: Math.round(40 * (215 / 64)), height: 40 }; // 134x40 (ratio 3.359 preserved)

function stripDataUriPrefix(dataUri: string): string {
  const idx = dataUri.indexOf('base64,');
  return idx >= 0 ? dataUri.slice(idx + 7) : dataUri;
}

function getOrRegisterWorkbookLogos(wb: ExcelJS.Workbook): { icmId: number; cambridgeId: number } {
  const cached = workbookLogoCache.get(wb);
  if (cached) return cached;

  const icmId = wb.addImage({
    base64: stripDataUriPrefix(DEFAULT_SCHOOL_LOGO),
    extension: 'png',
  });
  const cambridgeId = wb.addImage({
    base64: stripDataUriPrefix(DEFAULT_CAMBRIDGE_LOGO),
    extension: 'png',
  });

  const ids = { icmId, cambridgeId };
  workbookLogoCache.set(wb, ids);
  return ids;
}

function colLetterToNumber(colLetter: string): number {
  let num = 0;
  const clean = colLetter.toUpperCase().replace(/[^A-Z]/g, '');
  for (let i = 0; i < clean.length; i++) {
    num = num * 26 + (clean.charCodeAt(i) - 64);
  }
  return Math.max(1, num);
}

/**
 * Estimates a 0-based horizontal column anchor near the right edge of `1..endColNum`
 * so a fixed-pixel-width logo sits flush inside the right edge without overflowing.
 */
function computeRightLogoAnchorCol(ws: ExcelJS.Worksheet, endColNum: number, logoWidthPx: number): number {
  const TARGET_MARGIN_PX = 10;
  let remainingPx = logoWidthPx + TARGET_MARGIN_PX;

  for (let colIdx = endColNum; colIdx >= 1; colIdx--) {
    const charWidth = ws.getColumn(colIdx).width || 14;
    const colPx = Math.max(48, charWidth * 7.5);
    if (remainingPx <= colPx) {
      return Math.max(0.5, colIdx - 1 + (colPx - remainingPx) / colPx);
    }
    remainingPx -= colPx;
  }

  return Math.max(1, endColNum - 1.5);
}

function getMasteryToneStyle(color: MasteryTierColor): { fill: string; text: string } {
  switch (color) {
    case 'emerald':
      return { fill: ICM_BRAND.colors.emeraldLight, text: ICM_BRAND.colors.emeraldText };
    case 'blue':
      return { fill: ICM_BRAND.colors.blueLight, text: ICM_BRAND.colors.blueDark };
    case 'amber':
      return { fill: ICM_BRAND.colors.amberLight, text: ICM_BRAND.colors.amberText };
    case 'crimson':
    default:
      return { fill: ICM_BRAND.colors.crimsonLight, text: ICM_BRAND.colors.crimsonText };
  }
}

/**
 * Helper to build clean institutional ICM + Cambridge dual-logo masthead on any worksheet.
 * Bounded strictly within columns A..endColLetter so narrower sheets never overflow.
 */
function renderIcmBanner(
  ws: ExcelJS.Worksheet,
  title: string,
  endColLetter: string,
  metaInfo: {
    assessmentTitle: string;
    subject?: string;
    quizCode: string;
    targetClass?: string;
    schoolName?: string;
  }
): void {
  const endColNum = colLetterToNumber(endColLetter);

  // Top blue institutional rule + Crisp White Masthead (Rows 1-2)
  ws.mergeCells(`A1:${endColLetter}1`);
  const r1 = ws.getCell('A1');
  r1.value = sanitizeSpreadsheetCell(
    metaInfo.schoolName ? metaInfo.schoolName.toUpperCase() : ICM_BRAND.schoolName
  );
  r1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.white } };
  r1.font = { name: 'Segoe UI', size: 13.5, bold: true, color: { argb: ICM_BRAND.colors.blue } };
  r1.alignment = { horizontal: 'center', vertical: 'bottom' };
  r1.border = { top: { style: 'thick', color: { argb: ICM_BRAND.colors.blue } } };
  ws.getRow(1).height = 30;

  ws.mergeCells(`A2:${endColLetter}2`);
  const r2 = ws.getCell('A2');
  r2.value = sanitizeSpreadsheetCell(`${ICM_BRAND.schoolSub}  •  ${title.toUpperCase()}`);
  r2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.white } };
  r2.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: ICM_BRAND.colors.mutedText } };
  r2.alignment = { horizontal: 'center', vertical: 'top' };
  ws.getRow(2).height = 20;

  // Dual Institutional Logos anchored with fixed pixel aspect ratio (never stretched)
  if (ws.workbook) {
    const { icmId, cambridgeId } = getOrRegisterWorkbookLogos(ws.workbook);
    ws.addImage(icmId, {
      tl: { col: 0.12, row: 0.22 },
      ext: ICM_LOGO_EXT,
      editAs: 'oneCell',
    });

    if (endColNum >= 4) {
      const rightCol = computeRightLogoAnchorCol(ws, endColNum, CAMBRIDGE_LOGO_EXT.width);
      ws.addImage(cambridgeId, {
        tl: { col: rightCol, row: 0.28 },
        ext: CAMBRIDGE_LOGO_EXT,
        editAs: 'oneCell',
      });
    }
  }

  // Row 3: ICM Green Accent Divider
  ws.mergeCells(`A3:${endColLetter}3`);
  const r3 = ws.getCell('A3');
  r3.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.green } };
  ws.getRow(3).height = 4;

  // Row 4: Metadata Strip strictly bounded inside A4:${endColLetter}4
  ws.getRow(4).height = 23;
  const exportDateStr = new Date().toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  const seg1 = `Assessment: ${metaInfo.assessmentTitle}   |   Subject: ${metaInfo.subject || 'General'}`;
  const seg2 = `Code: ${metaInfo.quizCode || '-'}   |   Cohort: ${metaInfo.targetClass || 'All Candidates'}`;
  const seg3 = `Exported: ${exportDateStr}`;

  const segments: Array<{ startCol: number; endCol: number; text: string; align: 'left' | 'center' | 'right' }> =
    endColNum >= 6
      ? (() => {
          const split1 = Math.max(2, Math.floor(endColNum * 0.45));
          const split2 = Math.max(split1 + 2, Math.floor(endColNum * 0.8));
          const clampedSplit2 = Math.min(endColNum - 1, split2);
          return [
            { startCol: 1, endCol: split1, text: seg1, align: 'left' },
            { startCol: split1 + 1, endCol: clampedSplit2, text: seg2, align: 'center' },
            { startCol: clampedSplit2 + 1, endCol: endColNum, text: seg3, align: 'right' },
          ];
        })()
      : [
          {
            startCol: 1,
            endCol: endColNum,
            text: `${seg1}   |   ${seg2}   |   ${seg3}`,
            align: 'center',
          },
        ];

  segments.forEach((seg) => {
    const startLet = ExcelJS_colLetter(seg.startCol);
    const endLet = ExcelJS_colLetter(seg.endCol);
    if (seg.endCol > seg.startCol) {
      ws.mergeCells(`${startLet}4:${endLet}4`);
    }
    const cell = ws.getCell(`${startLet}4`);
    cell.value = sanitizeSpreadsheetCell(seg.text);
    cell.font = { name: 'Segoe UI', size: 8.5, bold: true, color: { argb: ICM_BRAND.colors.blueDark } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blueLight } };
    cell.alignment = { horizontal: seg.align, vertical: 'middle', indent: seg.align === 'left' ? 1 : 0 };
    cell.border = {
      top: { style: 'thin', color: { argb: ICM_BRAND.colors.blueBorder } },
      bottom: { style: 'thin', color: { argb: ICM_BRAND.colors.blueBorder } },
    };
  });

  // Row 5: Clean breathing spacer before KPIs / Table Headers
  ws.getRow(5).height = 8;
}

/**
 * Calculates psychometric stats for an item: P-value (difficulty), D-index (discrimination), distractor distributions.
 */
interface PsychometricItemStats {
  qNum: number;
  questionId: string;
  topic: string;
  questionText: string;
  maxMarks: number;
  totalAttempts: number;
  correctCount: number;
  totalEarnedMarks: number;
  avgEarned: number;
  accuracyPct: number;
  pValue: number;
  difficultyRating: 'Very Easy (Mastered)' | 'Easy / Sound' | 'Optimal Differentiator' | 'Challenging' | 'Hard / Deficit';
  dIndex: number;
  discriminationRating: 'High (Excellent)' | 'Moderate (Good)' | 'Low (Weak)' | 'Defective / Inverted';
  optionCounts: Record<string, number>;
  optionPcts: Record<string, number>;
  correctOptionKey: string;
  nonFunctioningDistractors: string[];
  trapDistractor?: string;
  pedagogicalAdvice: string;
}

function calculateCohortPsychometrics(submissions: StudentSubmission[]): PsychometricItemStats[] {
  if (!submissions || submissions.length === 0) return [];

  // Group question results across cohort
  const questionMap = new Map<string, {
    qNum: number;
    questionId: string;
    topic: string;
    questionText: string;
    maxMarks: number;
    options: string[] | null;
    correctAnswer: string;
    attempts: Array<{ subScore: number; earned: number; isCorrect: boolean; rawAnswer: string | number }>;
  }>();

  submissions.forEach((sub) => {
    sub.questionResults?.forEach((qr, idx) => {
      const qKey = qr.questionId || `q_${qr.questionNumber || idx + 1}`;
      let item = questionMap.get(qKey);
      if (!item) {
        item = {
          qNum: qr.questionNumber || idx + 1,
          questionId: qKey,
          topic: qr.topic || 'General',
          questionText: qr.questionText || `Question ${qr.questionNumber || idx + 1}`,
          maxMarks: qr.maxMarks || 1,
          options: qr.options || null,
          correctAnswer: qr.correctAnswer || '',
          attempts: [],
        };
        questionMap.set(qKey, item);
      }
      item.attempts.push({
        subScore: sub.score,
        earned: qr.earnedMarks || 0,
        isCorrect: qr.isCorrect || (qr.earnedMarks >= qr.maxMarks),
        rawAnswer: qr.studentAnswer,
      });
    });
  });

  const sortedQuestions = Array.from(questionMap.values()).sort((a, b) => a.qNum - b.qNum);

  // Split cohort for 27% Upper vs 27% Lower discrimination index
  const sortedSubs = [...submissions].sort((a, b) => b.score - a.score);
  const cutoff = Math.max(1, Math.round(sortedSubs.length * 0.27));
  const upperSubIds = new Set(sortedSubs.slice(0, cutoff).map((s) => s.id));
  const lowerSubIds = new Set(sortedSubs.slice(-cutoff).map((s) => s.id));

  return sortedQuestions.map((q) => {
    const totalAttempts = q.attempts.length || 1;
    const correctCount = q.attempts.filter((a) => a.isCorrect).length;
    const totalEarned = q.attempts.reduce((sum, a) => sum + a.earned, 0);
    const avgEarned = Number((totalEarned / totalAttempts).toFixed(2));
    const accuracyPct = Math.round((correctCount / totalAttempts) * 100);

    // Difficulty Index P = Total Marks Earned / Total Maximum Marks Available
    const maxPossible = totalAttempts * q.maxMarks;
    const pValue = Number((totalEarned / (maxPossible || 1)).toFixed(2));

    let difficultyRating: PsychometricItemStats['difficultyRating'] = 'Optimal Differentiator';
    if (pValue >= 0.85) difficultyRating = 'Very Easy (Mastered)';
    else if (pValue >= 0.65) difficultyRating = 'Easy / Sound';
    else if (pValue >= 0.40) difficultyRating = 'Optimal Differentiator';
    else if (pValue >= 0.20) difficultyRating = 'Challenging';
    else difficultyRating = 'Hard / Deficit';

    // Discrimination Index D = P_upper - P_lower
    let upperCorrect = 0;
    let upperTotal = 0;
    let lowerCorrect = 0;
    let lowerTotal = 0;

    submissions.forEach((sub) => {
      const qr = sub.questionResults?.find((r) => (r.questionId || `q_${r.questionNumber}`) === q.questionId);
      if (qr) {
        if (upperSubIds.has(sub.id)) {
          upperTotal++;
          if (qr.isCorrect) upperCorrect++;
        }
        if (lowerSubIds.has(sub.id)) {
          lowerTotal++;
          if (qr.isCorrect) lowerCorrect++;
        }
      }
    });

    const pUpper = upperTotal > 0 ? upperCorrect / upperTotal : pValue;
    const pLower = lowerTotal > 0 ? lowerCorrect / lowerTotal : pValue;
    const dIndex = Number((pUpper - pLower).toFixed(2));

    let discriminationRating: PsychometricItemStats['discriminationRating'] = 'Moderate (Good)';
    if (dIndex >= 0.40) discriminationRating = 'High (Excellent)';
    else if (dIndex >= 0.20) discriminationRating = 'Moderate (Good)';
    else if (dIndex >= 0.00) discriminationRating = 'Low (Weak)';
    else discriminationRating = 'Defective / Inverted';

    // MCQ Distractor Analysis
    const optionCounts: Record<string, number> = {};
    const optionPcts: Record<string, number> = {};
    const nonFunctioningDistractors: string[] = [];
    let trapDistractor: string | undefined;

    if (q.options && q.options.length > 0) {
      q.options.forEach((_, optIdx) => {
        const letter = String.fromCharCode(65 + optIdx);
        optionCounts[letter] = 0;
      });

      q.attempts.forEach((att) => {
        const ansStr = String(att.rawAnswer).trim().toLowerCase();
        let letter = '';
        if (/^[0-9]+$/.test(ansStr)) {
          const num = parseInt(ansStr, 10);
          if (num >= 0 && num < 26) letter = String.fromCharCode(65 + num);
        } else if (ansStr.length === 1 && ansStr >= 'a' && ansStr <= 'z') {
          letter = ansStr.toUpperCase();
        } else if (ansStr.startsWith('option ')) {
          letter = ansStr.charAt(7).toUpperCase();
        }

        if (letter && optionCounts[letter] !== undefined) {
          optionCounts[letter]++;
        }
      });

      // Normalize percentages
      Object.keys(optionCounts).forEach((key) => {
        const pct = Math.round((optionCounts[key] / totalAttempts) * 100);
        optionPcts[key] = pct;
      });

      // Find correct key letter
      let keyLetter = 'A';
      const cleanCorrect = String(q.correctAnswer).trim().toLowerCase();
      if (/^[0-9]+$/.test(cleanCorrect)) {
        keyLetter = String.fromCharCode(65 + parseInt(cleanCorrect, 10));
      } else if (cleanCorrect.length === 1 && cleanCorrect >= 'a' && cleanCorrect <= 'z') {
        keyLetter = cleanCorrect.toUpperCase();
      }

      Object.entries(optionPcts).forEach(([optKey, pct]) => {
        if (optKey !== keyLetter) {
          if (pct < 5) nonFunctioningDistractors.push(optKey);
          if (pct >= 25) trapDistractor = `Option ${optKey} (${pct}% selected)`;
        }
      });
    }

    // Automated Pedagogical Advice
    let pedagogicalAdvice = 'Well-calibrated item: Sound balance of challenge and curriculum differentiation.';
    if (dIndex < 0) {
      pedagogicalAdvice = 'Defective / Inverted: Lower scorers outperformed top scorers. Check for ambiguous wording or incorrect answer key.';
    } else if (trapDistractor) {
      pedagogicalAdvice = `Misconception Trap: High distraction rate on ${trapDistractor}. Review related underlying misconception in next class.`;
    } else if (pValue >= 0.85) {
      pedagogicalAdvice = 'Concept Mastered: High cohort accuracy. Suitable as foundational scaffold or warm-up item.';
    } else if (pValue < 0.35) {
      pedagogicalAdvice = `Concept Deficit: Low class accuracy (${accuracyPct}%). Recommend concept re-teaching and targeted formative review.`;
    } else if (dIndex < 0.20) {
      pedagogicalAdvice = 'Low Discrimination: High and low scorers achieved similar accuracy. Does not clearly separate student ability.';
    }

    return {
      qNum: q.qNum,
      questionId: q.questionId,
      topic: q.topic,
      questionText: q.questionText,
      maxMarks: q.maxMarks,
      totalAttempts,
      correctCount,
      totalEarnedMarks: totalEarned,
      avgEarned,
      accuracyPct,
      pValue,
      difficultyRating,
      dIndex,
      discriminationRating,
      optionCounts,
      optionPcts,
      correctOptionKey: q.correctAnswer,
      nonFunctioningDistractors,
      trapDistractor,
      pedagogicalAdvice,
    };
  });
}

/**
 * Primary Exporter: Generates the comprehensive 4-tab institutional ICM Excel report.
 */
export async function exportAllSubmissionsExcelICM(
  quizTitle: string,
  quizCode: string,
  totalMarks: number,
  submissions: StudentSubmission[],
  options?: {
    subject?: string;
    targetClass?: string;
    schoolName?: string;
    gradeThresholds?: GradeThresholds;
  }
): Promise<void> {
  if (!submissions || submissions.length === 0) {
    alert('No student submissions available to export.');
    return;
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sekolah Insan Cendekia Madani (ICM)';
  wb.created = new Date();

  const isOffline =
    !quizCode ||
    quizCode.toUpperCase().startsWith('OFFLINE') ||
    submissions.every((s) => s.durationSeconds === 0) ||
    submissions[0]?.teacherNotes?.toLowerCase().includes('offline');

  const metaInfo = {
    assessmentTitle: quizTitle,
    subject: options?.subject || submissions[0]?.subject || 'General',
    quizCode: quizCode || 'EXAM-CODE',
    targetClass: options?.targetClass || submissions[0]?.studentClass || 'Class Cohort',
    schoolName: options?.schoolName || ICM_BRAND.schoolName,
  };

  // ═════════════════════════════════════════════════════════════════════════════
  // SHEET 1: EXECUTIVE GRADEBOOK & COHORT OVERVIEW
  // ═════════════════════════════════════════════════════════════════════════════
  const wsGradebook = wb.addWorksheet('Executive Gradebook', {
    views: [{ state: 'frozen', ySplit: 12 }],
    properties: { tabColor: { argb: ICM_BRAND.colors.blue } },
  });

  renderIcmBanner(wsGradebook, 'Executive Assessment Gradebook', 'L', metaInfo);

  // Executive KPI Summary Ribbon (Rows 6-7)
  const cohortScores = submissions.map((s) => s.score);
  const cohortPcts = submissions.map((s) => s.percentage);
  const avgScore = Number((cohortScores.reduce((a, b) => a + b, 0) / cohortScores.length).toFixed(1));
  const avgPct = Number((cohortPcts.reduce((a, b) => a + b, 0) / cohortPcts.length).toFixed(1));
  const maxScore = Math.max(...cohortScores);
  const minScore = Math.min(...cohortScores);
  const passCount = submissions.filter((s) => s.percentage >= 50).length;
  const passRate = Math.round((passCount / submissions.length) * 100);
  const masteryCount = submissions.filter((s) => s.percentage >= 80).length;
  const masteryRate = Math.round((masteryCount / submissions.length) * 100);

  const sortedPctList = [...cohortPcts].sort((a, b) => a - b);
  const medianPct = sortedPctList.length % 2 === 0
    ? Number(((sortedPctList[sortedPctList.length / 2 - 1] + sortedPctList[sortedPctList.length / 2]) / 2).toFixed(1))
    : Number(sortedPctList[Math.floor(sortedPctList.length / 2)].toFixed(1));

  // Render KPI Blocks
  const kpiBlocks = [
    { colStart: 'A', colEnd: 'B', lbl: 'TOTAL COHORT', val: `${submissions.length} Students`, sub: '100% Attempted', color: ICM_BRAND.colors.blue },
    { colStart: 'C', colEnd: 'D', lbl: 'CLASS AVERAGE', val: `${avgPct}%`, sub: `${avgScore} / ${totalMarks} marks`, color: ICM_BRAND.colors.blue },
    { colStart: 'E', colEnd: 'F', lbl: 'COHORT MEDIAN', val: `${medianPct}%`, sub: 'Middle Candidate', color: ICM_BRAND.colors.blueDark },
    { colStart: 'G', colEnd: 'H', lbl: 'PASS RATE (≥50%)', val: `${passRate}%`, sub: `${passCount} of ${submissions.length} Passed`, color: passRate >= 75 ? ICM_BRAND.colors.green : ICM_BRAND.colors.amber },
    { colStart: 'I', colEnd: 'J', lbl: 'MASTERY RATE (≥80%)', val: `${masteryRate}%`, sub: `${masteryCount} High Achievers`, color: ICM_BRAND.colors.greenDark },
    { colStart: 'K', colEnd: 'L', lbl: 'SCORE RANGE', val: `${maxScore} / ${minScore}`, sub: `High: ${maxScore} • Low: ${minScore}`, color: ICM_BRAND.colors.slateHeader },
  ];

  kpiBlocks.forEach((k) => {
    wsGradebook.mergeCells(`${k.colStart}6:${k.colEnd}6`);
    const cVal = wsGradebook.getCell(`${k.colStart}6`);
    cVal.value = k.val;
    cVal.font = { name: 'Segoe UI', size: 13, bold: true, color: { argb: k.color } };
    cVal.alignment = { horizontal: 'center', vertical: 'middle' };
    cVal.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blueLight } };

    wsGradebook.mergeCells(`${k.colStart}7:${k.colEnd}7`);
    const cLbl = wsGradebook.getCell(`${k.colStart}7`);
    cLbl.value = `${k.lbl} • ${k.sub}`;
    cLbl.font = { name: 'Segoe UI', size: 7.5, bold: true, color: { argb: ICM_BRAND.colors.mutedText } };
    cLbl.alignment = { horizontal: 'center', vertical: 'middle' };
    cLbl.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blueLight } };
  });

  // Grade Distribution Bar (Rows 9-10)
  const gradeDistribution: Record<string, number> = { 'A*': 0, 'A': 0, 'B': 0, 'C': 0, 'D': 0, 'E': 0, 'U': 0 };
  submissions.forEach((s) => {
    const g = deriveGradeFromPercentage(s.percentage, options?.gradeThresholds).grade;
    gradeDistribution[g]++;
  });

  wsGradebook.mergeCells('A9:B9');
  wsGradebook.getCell('A9').value = 'GRADE PROFILE:';
  wsGradebook.getCell('A9').font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: ICM_BRAND.colors.blueDark } };
  wsGradebook.getCell('A9').alignment = { horizontal: 'right', vertical: 'middle' };

  const gradeKeys = ['A*', 'A', 'B', 'C', 'D', 'E', 'U'];
  gradeKeys.forEach((g, idx) => {
    const colLet = String.fromCharCode(67 + idx); // C, D, E...
    const count = gradeDistribution[g];
    const pct = Math.round((count / submissions.length) * 100);
    const cell = wsGradebook.getCell(`${colLet}9`);
    cell.value = `${g}: ${count} (${pct}%)`;
    cell.font = { name: 'Segoe UI', size: 8.5, bold: true, color: { argb: g === 'A*' || g === 'A' ? ICM_BRAND.colors.greenDark : g === 'U' ? ICM_BRAND.colors.crimson : ICM_BRAND.colors.slateText } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: g === 'A*' || g === 'A' ? ICM_BRAND.colors.greenLight : g === 'U' ? ICM_BRAND.colors.crimsonLight : ICM_BRAND.colors.white } };
    cell.border = BORDER_THIN;
  });

  // Table Headers (Row 12)
  const gbHeaders = [
    { title: 'Rank', width: 8, align: 'center' },
    { title: 'Candidate Name', width: 28, align: 'left' },
    { title: 'Class / Section', width: 16, align: 'center' },
    { title: 'Candidate #', width: 14, align: 'center' },
    { title: 'Score Earned', width: 14, align: 'right' },
    { title: 'Total Marks', width: 12, align: 'right' },
    { title: 'Percentage', width: 14, align: 'right' },
    { title: 'Grade', width: 10, align: 'center' },
    { title: 'Time Taken', width: 15, align: 'center' },
    { title: 'Strikes', width: 10, align: 'center' },
    { title: 'Proctoring Status', width: 22, align: 'center' },
    { title: 'Submission Date', width: 20, align: 'center' },
  ];

  const headerRow = wsGradebook.getRow(12);
  headerRow.height = 28;
  gbHeaders.forEach((h, idx) => {
    const cell = headerRow.getCell(idx + 1);
    cell.value = h.title;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blue } };
    cell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: ICM_BRAND.colors.white } };
    cell.alignment = { horizontal: h.align as ExcelJS.Alignment['horizontal'], vertical: 'middle' };
    cell.border = { bottom: { style: 'medium', color: { argb: ICM_BRAND.colors.green } } };
    wsGradebook.getColumn(idx + 1).width = h.width;
  });

  // Data Rows (Sorted by rank)
  submissions.forEach((s, idx) => {
    const rowNum = 13 + idx;
    const row = wsGradebook.getRow(rowNum);
    row.height = 20;

    const p = s.percentage;
    const grade = deriveGradeFromPercentage(p, options?.gradeThresholds).grade;
    const durationFmt = isOffline ? '-' : `${Math.floor(s.durationSeconds / 60)}m ${s.durationSeconds % 60}s`;
    const strikesCount = s.forensics?.finalStrikeCount ?? s.violationsCount;
    const strikesFmt = isOffline ? '-' : strikesCount;
    const penaltyMins = s.forensics?.totalPenaltySeconds ? Math.round(s.forensics.totalPenaltySeconds / 60) : 0;
    const penaltySuffix = penaltyMins > 0 ? ` (-${penaltyMins}m)` : '';
    const isExceeded = Boolean(s.forensics?.autoSubmittedBySecurity || s.forensics?.exceededMaxViolations || s.violationsCount >= 3);
    const statusFmt = isOffline
      ? 'Offline Paper Exam'
      : s.forensics?.autoSubmittedBySecurity
        ? `Auto-Submitted (${strikesCount} Strikes${penaltySuffix})`
        : strikesCount === 0
          ? 'Clean (0 Strikes)'
          : isExceeded
            ? `Flagged (${strikesCount} Strikes${penaltySuffix})`
            : `Suspicious (${strikesCount}${penaltySuffix})`;

    const rowData = [
      idx + 1,
      sanitizeSpreadsheetCell(s.studentName),
      sanitizeSpreadsheetCell(s.studentClass || 'General'),
      sanitizeSpreadsheetCell(s.candidateNumber || '-'),
      s.score,
      s.totalMarks || totalMarks,
      p / 100, // Stored as decimal for native Excel percentage formatting
      grade,
      durationFmt,
      strikesFmt,
      statusFmt,
      formatSubmissionDateTime(s.submittedAt),
    ];

    const isZebra = idx % 2 === 1;

    rowData.forEach((val, cIdx) => {
      const cell = row.getCell(cIdx + 1);
      cell.value = val;
      cell.font = { name: 'Segoe UI', size: 9.5, color: { argb: ICM_BRAND.colors.slateText } };
      cell.border = BORDER_THIN;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isZebra ? ICM_BRAND.colors.zebraRow : ICM_BRAND.colors.white } };

      const align = gbHeaders[cIdx].align as ExcelJS.Alignment['horizontal'];
      cell.alignment = { horizontal: align, vertical: 'middle' };

      // Native Percentage Formatting
      if (cIdx === 6) {
        cell.numFmt = '0.0%';
        cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: ICM_BRAND.colors.slateText } };
      }

      // Grade color-coded badge fill
      if (cIdx === 7) {
        cell.font = { name: 'Segoe UI', size: 10, bold: true };
        if (grade === 'A*' || grade === 'A') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.emeraldLight } };
          cell.font.color = { argb: ICM_BRAND.colors.emeraldText };
        } else if (grade === 'B' || grade === 'C') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blueLight } };
          cell.font.color = { argb: ICM_BRAND.colors.blueDark };
        } else if (grade === 'D' || grade === 'E') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.amberLight } };
          cell.font.color = { argb: ICM_BRAND.colors.amberText };
        } else {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.crimsonLight } };
          cell.font.color = { argb: ICM_BRAND.colors.crimsonText };
        }
      }

      // Proctoring alert status
      if (cIdx === 10 && !isOffline && isExceeded) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.crimsonLight } };
        cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: ICM_BRAND.colors.crimsonText } };
      }
    });
  });

  wsGradebook.autoFilter = `A12:L${12 + submissions.length}`;

  // ═════════════════════════════════════════════════════════════════════════════
  // SHEET 2: PEDAGOGICAL & PSYCHOMETRIC ITEM ANALYSIS
  // ═════════════════════════════════════════════════════════════════════════════
  const psychometrics = calculateCohortPsychometrics(submissions);
  if (psychometrics.length > 0) {
    const wsItem = wb.addWorksheet('Item Analysis', {
      views: [{ state: 'frozen', ySplit: 6 }],
      properties: { tabColor: { argb: ICM_BRAND.colors.green } },
    });

    renderIcmBanner(wsItem, 'Pedagogical Item Analysis & Diagnostics', 'M', metaInfo);

    const itemHeaders = [
      { title: 'Question #', width: 12, align: 'center' },
      { title: 'Curriculum Topic', width: 22, align: 'left' },
      { title: 'Question Prompt Preview', width: 34, align: 'left' },
      { title: 'Max Marks', width: 11, align: 'center' },
      { title: 'Class Avg', width: 11, align: 'right' },
      { title: 'Accuracy (%)', width: 14, align: 'right' },
      { title: 'Difficulty (P)', width: 13, align: 'right' },
      { title: 'Difficulty Rating', width: 20, align: 'center' },
      { title: 'Discr. (D-Idx)', width: 13, align: 'right' },
      { title: 'Discrimination Quality', width: 20, align: 'center' },
      { title: 'MCQ Option Breakdown', width: 26, align: 'left' },
      { title: 'Distractor Trap / Alert', width: 24, align: 'left' },
      { title: 'Teacher Pedagogical Recommendation', width: 44, align: 'left' },
    ];

    const itemHeaderRow = wsItem.getRow(6);
    itemHeaderRow.height = 28;
    itemHeaders.forEach((h, idx) => {
      const cell = itemHeaderRow.getCell(idx + 1);
      cell.value = h.title;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blue } };
      cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: ICM_BRAND.colors.white } };
      cell.alignment = { horizontal: h.align as ExcelJS.Alignment['horizontal'], vertical: 'middle' };
      cell.border = { bottom: { style: 'medium', color: { argb: ICM_BRAND.colors.green } } };
      wsItem.getColumn(idx + 1).width = h.width;
    });

    psychometrics.forEach((item, idx) => {
      const rowNum = 7 + idx;
      const row = wsItem.getRow(rowNum);
      row.height = 22;
      const isZebra = idx % 2 === 1;

      // Format Option distribution string
      const optStr = Object.entries(item.optionPcts).length > 0
        ? Object.entries(item.optionPcts).map(([k, pct]) => `${k}:${pct}%`).join(' • ')
        : '-';

      const alertStr = item.trapDistractor
        ? `⚠️ Trap: ${item.trapDistractor}`
        : item.nonFunctioningDistractors.length > 0
        ? `ℹ️ Ineffective: ${item.nonFunctioningDistractors.join(', ')} (<5%)`
        : '✓ Distractors Healthy';

      const rowVals = [
        `Q${item.qNum}`,
        sanitizeSpreadsheetCell(item.topic),
        sanitizeSpreadsheetCell(item.questionText.length > 50 ? `${item.questionText.substring(0, 48)}…` : item.questionText),
        item.maxMarks,
        item.avgEarned,
        item.accuracyPct / 100, // Decimal for native percentage
        item.pValue,
        item.difficultyRating,
        item.dIndex,
        item.discriminationRating,
        optStr,
        alertStr,
        item.pedagogicalAdvice,
      ];

      rowVals.forEach((val, cIdx) => {
        const cell = row.getCell(cIdx + 1);
        cell.value = val;
        cell.font = { name: 'Segoe UI', size: 9, color: { argb: ICM_BRAND.colors.slateText } };
        cell.border = BORDER_THIN;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isZebra ? ICM_BRAND.colors.zebraRow : ICM_BRAND.colors.white } };
        cell.alignment = { horizontal: itemHeaders[cIdx].align as ExcelJS.Alignment['horizontal'], vertical: 'middle' };

        // Accuracy Percentage Formatting
        if (cIdx === 5) {
          cell.numFmt = '0.0%';
          cell.font = { name: 'Segoe UI', size: 9, bold: true };
        }

        // Difficulty Color Badging
        if (cIdx === 7) {
          cell.font = { name: 'Segoe UI', size: 9, bold: true };
          if (item.difficultyRating === 'Very Easy (Mastered)') {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.emeraldLight } };
            cell.font.color = { argb: ICM_BRAND.colors.emeraldText };
          } else if (item.difficultyRating === 'Optimal Differentiator' || item.difficultyRating === 'Easy / Sound') {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blueLight } };
            cell.font.color = { argb: ICM_BRAND.colors.blueDark };
          } else if (item.difficultyRating === 'Challenging') {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.amberLight } };
            cell.font.color = { argb: ICM_BRAND.colors.amberText };
          } else {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.crimsonLight } };
            cell.font.color = { argb: ICM_BRAND.colors.crimsonText };
          }
        }

        // Discrimination Color Badging
        if (cIdx === 9) {
          cell.font = { name: 'Segoe UI', size: 9, bold: true };
          if (item.discriminationRating === 'High (Excellent)') {
            cell.font.color = { argb: ICM_BRAND.colors.emeraldText };
          } else if (item.discriminationRating === 'Defective / Inverted') {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.crimsonLight } };
            cell.font.color = { argb: ICM_BRAND.colors.crimsonText };
          }
        }

        // Distractor trap highlight
        if (cIdx === 11 && item.trapDistractor) {
          cell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: ICM_BRAND.colors.amberText } };
        }
      });
    });

    wsItem.autoFilter = `A6:M${6 + psychometrics.length}`;
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // SHEET 3: STUDENT RESPONSE HEATMAP MATRIX
  // ═════════════════════════════════════════════════════════════════════════════
  if (psychometrics.length > 0) {
    const wsMatrix = wb.addWorksheet('Response Matrix', {
      views: [{ state: 'frozen', xSplit: 3, ySplit: 6 }],
      properties: { tabColor: { argb: ICM_BRAND.colors.blueDark } },
    });

    // Determine end column letter
    const totalMatrixCols = 3 + psychometrics.length + 2; // Rank, Name, Class + Questions + Total, %
    const lastColLetter = ExcelJS_colLetter(totalMatrixCols);

    renderIcmBanner(wsMatrix, 'Student-by-Question Response Matrix (Heatmap)', lastColLetter, metaInfo);

    // Header Row 6
    const mHeaderRow = wsMatrix.getRow(6);
    mHeaderRow.height = 28;

    mHeaderRow.getCell(1).value = 'Rank';
    wsMatrix.getColumn(1).width = 7;
    mHeaderRow.getCell(2).value = 'Candidate Name';
    wsMatrix.getColumn(2).width = 25;
    mHeaderRow.getCell(3).value = 'Class';
    wsMatrix.getColumn(3).width = 12;

    [1, 2, 3].forEach((c) => {
      const cell = mHeaderRow.getCell(c);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blue } };
      cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: ICM_BRAND.colors.white } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });

    // Question Columns Q1 .. QN
    psychometrics.forEach((q, idx) => {
      const colNum = 4 + idx;
      const cell = mHeaderRow.getCell(colNum);
      cell.value = `Q${q.qNum}`;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blueDark } };
      cell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: ICM_BRAND.colors.white } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      wsMatrix.getColumn(colNum).width = 8;
    });

    // Score & Percentage Columns
    const totScoreCol = 4 + psychometrics.length;
    const totPctCol = 5 + psychometrics.length;

    const cTot = mHeaderRow.getCell(totScoreCol);
    cTot.value = 'Total Score';
    cTot.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blue } };
    cTot.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: ICM_BRAND.colors.white } };
    cTot.alignment = { horizontal: 'right', vertical: 'middle' };
    wsMatrix.getColumn(totScoreCol).width = 13;

    const cPct = mHeaderRow.getCell(totPctCol);
    cPct.value = 'Percentage';
    cPct.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blue } };
    cPct.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: ICM_BRAND.colors.white } };
    cPct.alignment = { horizontal: 'right', vertical: 'middle' };
    wsMatrix.getColumn(totPctCol).width = 13;

    // Populate Student Rows
    submissions.forEach((sub, sIdx) => {
      const rowNum = 7 + sIdx;
      const row = wsMatrix.getRow(rowNum);
      row.height = 19;

      row.getCell(1).value = sIdx + 1;
      row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
      row.getCell(2).value = sanitizeSpreadsheetCell(sub.studentName);
      row.getCell(2).alignment = { horizontal: 'left', vertical: 'middle' };
      row.getCell(3).value = sanitizeSpreadsheetCell(sub.studentClass || 'General');
      row.getCell(3).alignment = { horizontal: 'center', vertical: 'middle' };

      [1, 2, 3].forEach((c) => {
        row.getCell(c).border = BORDER_THIN;
        row.getCell(c).font = { name: 'Segoe UI', size: 9 };
      });

      // Question Cells with Soft Heatmap Highlighting
      psychometrics.forEach((q, qIdx) => {
        const colNum = 4 + qIdx;
        const cell = row.getCell(colNum);
        const qr = sub.questionResults?.find((r) => (r.questionId || `q_${r.questionNumber}`) === q.questionId);

        const earned = qr ? qr.earnedMarks : 0;
        const isCorrect = qr ? qr.isCorrect || (qr.earnedMarks >= qr.maxMarks) : false;

        cell.value = earned;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.border = BORDER_THIN;
        cell.font = { name: 'Segoe UI', size: 9, bold: true };

        if (isCorrect) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.emeraldLight } };
          cell.font.color = { argb: ICM_BRAND.colors.emeraldText };
        } else if (earned > 0) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.amberLight } };
          cell.font.color = { argb: ICM_BRAND.colors.amberText };
        } else {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.crimsonLight } };
          cell.font.color = { argb: ICM_BRAND.colors.crimsonText };
        }
      });

      // Score and %
      const cellScore = row.getCell(totScoreCol);
      cellScore.value = sub.score;
      cellScore.alignment = { horizontal: 'right', vertical: 'middle' };
      cellScore.font = { name: 'Segoe UI', size: 9.5, bold: true };
      cellScore.border = BORDER_THIN;

      const cellPct = row.getCell(totPctCol);
      cellPct.value = sub.percentage / 100;
      cellPct.numFmt = '0.0%';
      cellPct.alignment = { horizontal: 'right', vertical: 'middle' };
      cellPct.font = { name: 'Segoe UI', size: 9.5, bold: true };
      cellPct.border = BORDER_THIN;
    });

    // Bottom Summary Row: Class Accuracy per Question (Diagnostic Scan)
    const summaryRowNum = 7 + submissions.length;
    const sRow = wsMatrix.getRow(summaryRowNum);
    sRow.height = 24;

    wsMatrix.mergeCells(`A${summaryRowNum}:C${summaryRowNum}`);
    const lblSummary = sRow.getCell(1);
    lblSummary.value = 'CLASS ACCURACY (%):';
    lblSummary.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: ICM_BRAND.colors.white } };
    lblSummary.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blue } };
    lblSummary.alignment = { horizontal: 'right', vertical: 'middle' };

    psychometrics.forEach((q, qIdx) => {
      const colNum = 4 + qIdx;
      const cell = sRow.getCell(colNum);
      cell.value = q.accuracyPct / 100;
      cell.numFmt = '0%';
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.font = { name: 'Segoe UI', size: 9, bold: true };
      cell.border = BORDER_THIN;

      // Color code bottom row to spot problem columns at a glance
      if (q.accuracyPct >= 80) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.emeraldLight } };
        cell.font.color = { argb: ICM_BRAND.colors.emeraldText };
      } else if (q.accuracyPct < 40) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.crimsonLight } };
        cell.font.color = { argb: ICM_BRAND.colors.crimsonText };
      } else {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blueLight } };
        cell.font.color = { argb: ICM_BRAND.colors.blueDark };
      }
    });

    sRow.getCell(totScoreCol).value = avgScore;
    sRow.getCell(totScoreCol).alignment = { horizontal: 'right', vertical: 'middle' };
    sRow.getCell(totScoreCol).font = { name: 'Segoe UI', size: 9.5, bold: true };
    sRow.getCell(totScoreCol).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blueLight } };

    sRow.getCell(totPctCol).value = avgPct / 100;
    sRow.getCell(totPctCol).numFmt = '0.0%';
    sRow.getCell(totPctCol).alignment = { horizontal: 'right', vertical: 'middle' };
    sRow.getCell(totPctCol).font = { name: 'Segoe UI', size: 9.5, bold: true };
    sRow.getCell(totPctCol).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blueLight } };
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // SHEET 4: PROCTORING & SECURITY AUDIT TRAIL
  // ═════════════════════════════════════════════════════════════════════════════
  if (!isOffline) {
    const proctorLogs: any[] = [];
    submissions.forEach((sub) => {
      if (sub.proctoringLogs && sub.proctoringLogs.length > 0) {
        sub.proctoringLogs.forEach((log) => {
          const elapsed =
            log.elapsedExamSeconds !== undefined && log.elapsedExamSeconds >= 0
              ? `+${Math.floor(log.elapsedExamSeconds / 60)}m ${log.elapsedExamSeconds % 60}s`
              : '-';
          proctorLogs.push({
            name: sanitizeSpreadsheetCell(sub.studentName),
            class: sanitizeSpreadsheetCell(sub.studentClass || 'General'),
            candNum: sanitizeSpreadsheetCell(sub.candidateNumber || '-'),
            strike: `Strike ${log.strike}`,
            elapsed,
            timestamp: formatProctorTimestamp(log.timestamp),
            violationType: sanitizeSpreadsheetCell(log.type || 'security_event'),
            event: sanitizeSpreadsheetCell(log.event),
            severity: log.severity.toUpperCase(),
            limitExceeded: (sub.forensics?.autoSubmittedBySecurity || sub.forensics?.exceededMaxViolations || sub.violationsCount >= 3) ? 'YES 🚨' : 'No',
          });
        });
      }
    });

    if (proctorLogs.length > 0) {
      const wsProctor = wb.addWorksheet('Proctoring Log', {
        views: [{ state: 'frozen', ySplit: 6 }],
        properties: { tabColor: { argb: ICM_BRAND.colors.amber } },
      });

      renderIcmBanner(wsProctor, 'Exam Security & Proctoring Audit Trail', 'I', metaInfo);

      const pHeaders = [
        { title: 'Candidate Name', width: 26, align: 'left' },
        { title: 'Class / Section', width: 16, align: 'center' },
        { title: 'Candidate #', width: 14, align: 'center' },
        { title: 'Strike #', width: 12, align: 'center' },
        { title: 'Elapsed Time', width: 15, align: 'center' },
        { title: 'Timestamp', width: 16, align: 'center' },
        { title: 'Security Violation Event', width: 44, align: 'left' },
        { title: 'Severity', width: 14, align: 'center' },
        { title: 'Limit Exceeded', width: 16, align: 'center' },
      ];

      const pHeaderRow = wsProctor.getRow(6);
      pHeaderRow.height = 28;
      pHeaders.forEach((h, idx) => {
        const cell = pHeaderRow.getCell(idx + 1);
        cell.value = h.title;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blue } };
        cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: ICM_BRAND.colors.white } };
        cell.alignment = { horizontal: h.align as ExcelJS.Alignment['horizontal'], vertical: 'middle' };
        cell.border = { bottom: { style: 'medium', color: { argb: ICM_BRAND.colors.green } } };
        wsProctor.getColumn(idx + 1).width = h.width;
      });

      proctorLogs.forEach((log, idx) => {
        const rowNum = 7 + idx;
        const row = wsProctor.getRow(rowNum);
        row.height = 20;
        const isZebra = idx % 2 === 1;

        const rowData = [
          log.name,
          log.class,
          log.candNum,
          log.strike,
          log.elapsed,
          log.timestamp,
          log.event,
          log.severity,
          log.limitExceeded,
        ];

        rowData.forEach((val, cIdx) => {
          const cell = row.getCell(cIdx + 1);
          cell.value = val;
          cell.font = { name: 'Segoe UI', size: 9, color: { argb: ICM_BRAND.colors.slateText } };
          cell.border = BORDER_THIN;
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isZebra ? ICM_BRAND.colors.zebraRow : ICM_BRAND.colors.white } };
          cell.alignment = { horizontal: pHeaders[cIdx].align as ExcelJS.Alignment['horizontal'], vertical: 'middle' };

          if (cIdx === 7 && log.severity === 'CRITICAL') {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.crimsonLight } };
            cell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: ICM_BRAND.colors.crimsonText } };
          }
          if (cIdx === 8 && log.limitExceeded.includes('YES')) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.crimsonLight } };
            cell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: ICM_BRAND.colors.crimsonText } };
          }
        });
      });

      wsProctor.autoFilter = `A6:I${6 + proctorLogs.length}`;
    }
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // WRITE AND EXPORT VIA NATIVE/UNIVERSAL BRIDGE
  // ═════════════════════════════════════════════════════════════════════════════
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const filename = `${quizTitle.toLowerCase().replace(/[^a-z0-9_-]/g, '_')}_${quizCode}_icm_report.xlsx`;
  await exportFileUniversal(blob, filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

/**
 * Exports an individual student's detailed response report in matching ICM branding.
 */
export interface SingleSubmissionExcelOptions {
  gradeThresholds?: GradeThresholds;
  masteryTiers?: TopicMasteryTier[];
}

export interface BatchSubmissionExcelZipOptions extends SingleSubmissionExcelOptions {
  quizTitle?: string;
  selectedClass?: string;
  onProgress?: (completed: number, total: number) => void;
}

function buildSafeFileSlug(raw: string, fallback = 'candidate'): string {
  const cleaned = (raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned || fallback;
}

/**
 * Builds the formatted multi-sheet ExcelJS Workbook for an individual candidate submission.
 * Shared by both single-student downloads and batch class ZIP exports.
 */
export function buildSingleSubmissionWorkbookICM(
  submission: StudentSubmission,
  options?: SingleSubmissionExcelOptions
): { wb: ExcelJS.Workbook; filename: string } {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sekolah Insan Cendekia Madani (ICM)';
  wb.created = new Date();

  const masteryTiers = options?.masteryTiers ?? getTopicMasteryTiers();
  const topicEntries = computeSubmissionTopicMastery(submission, masteryTiers);

  const isOffline =
    !submission.quizCode ||
    submission.quizCode.toUpperCase().startsWith('OFFLINE') ||
    submission.durationSeconds === 0 ||
    submission.teacherNotes?.toLowerCase().includes('offline');

  const metaInfo = {
    assessmentTitle: submission.quizTitle,
    subject: submission.subject || 'General',
    quizCode: submission.quizCode,
    targetClass: submission.studentClass || 'Candidate Assessment',
    schoolName: ICM_BRAND.schoolName,
  };

  // Sheet 1: Candidate Overview + Compact Topic Mastery Summary
  const wsOverview = wb.addWorksheet('Candidate Overview', {
    views: [{ state: 'frozen', ySplit: 5 }],
    properties: { tabColor: { argb: ICM_BRAND.colors.blue } },
  });

  const overviewColWidths = [25, 22, 16, 22, 16, 20];
  overviewColWidths.forEach((w, i) => {
    wsOverview.getColumn(i + 1).width = w;
  });

  renderIcmBanner(wsOverview, 'Individual Student Diagnostic Report', 'F', metaInfo);

  const calcGrade = deriveGradeFromPercentage(submission.percentage, options?.gradeThresholds).grade;
  const timeTakenStr = isOffline
    ? '-'
    : `${Math.floor(submission.durationSeconds / 60)}m ${submission.durationSeconds % 60}s`;
  const strikesStr = isOffline
    ? '-'
    : `${submission.forensics?.finalStrikeCount ?? submission.violationsCount}${
        submission.forensics?.totalPenaltySeconds
          ? ` (-${Math.round(submission.forensics.totalPenaltySeconds / 60)}m Penalty)`
          : ''
      }`;
  const integrityStr = isOffline
    ? 'Offline Paper'
    : submission.forensics?.autoSubmittedBySecurity
      ? 'Auto-Submitted (Security Threshold)'
      : submission.violationsCount === 0
        ? 'Clean (0 Strikes)'
        : 'Flagged';

  const profilePairs: Array<{
    leftLabel: string;
    leftVal: string;
    rightLabel: string;
    rightVal: string;
  }> = [
    {
      leftLabel: 'Candidate Name',
      leftVal: sanitizeSpreadsheetCell(submission.studentName),
      rightLabel: 'Score Earned',
      rightVal: `${submission.score} / ${submission.totalMarks}`,
    },
    {
      leftLabel: 'Candidate # / Seat',
      leftVal: sanitizeSpreadsheetCell(submission.candidateNumber || '-'),
      rightLabel: 'Percentage Achieved',
      rightVal: `${submission.percentage.toFixed(1)}%`,
    },
    {
      leftLabel: 'Class / Cohort',
      leftVal: sanitizeSpreadsheetCell(submission.studentClass || 'General'),
      rightLabel: 'Calculated Grade',
      rightVal: sanitizeSpreadsheetCell(calcGrade),
    },
    {
      leftLabel: 'Assessment Title',
      leftVal: sanitizeSpreadsheetCell(submission.quizTitle),
      rightLabel: 'Assessment Mode',
      rightVal: isOffline ? 'Offline Paper Exam' : 'Computer-Based (Online)',
    },
    {
      leftLabel: 'Subject / Syllabus',
      leftVal: sanitizeSpreadsheetCell(submission.subject || 'General'),
      rightLabel: 'Time Taken',
      rightVal: timeTakenStr,
    },
    {
      leftLabel: 'Assessment Access Code',
      leftVal: sanitizeSpreadsheetCell(submission.quizCode),
      rightLabel: 'Violation Strikes',
      rightVal: strikesStr,
    },
    {
      leftLabel: 'Date Submitted',
      leftVal: formatSubmissionDateTime(submission.submittedAt),
      rightLabel: 'Integrity Status',
      rightVal: integrityStr,
    },
  ];

  wsOverview.getRow(6).height = 24;
  wsOverview.mergeCells('A6:F6');
  wsOverview.getCell('A6').value = 'CANDIDATE PERFORMANCE PROFILE';
  wsOverview.getCell('A6').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blue } };
  wsOverview.getCell('A6').font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: ICM_BRAND.colors.white } };
  wsOverview.getCell('A6').alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };

  profilePairs.forEach((pair, idx) => {
    const rNum = 7 + idx;
    const r = wsOverview.getRow(rNum);
    r.height = 20;

    wsOverview.mergeCells(`B${rNum}:C${rNum}`);
    wsOverview.mergeCells(`E${rNum}:F${rNum}`);

    const lbl1 = r.getCell(1);
    lbl1.value = pair.leftLabel;
    lbl1.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: ICM_BRAND.colors.blueDark } };
    lbl1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blueLight } };
    lbl1.border = BORDER_THIN;
    lbl1.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };

    const val1 = r.getCell(2);
    val1.value = pair.leftVal;
    val1.font = { name: 'Segoe UI', size: 9.5, bold: idx === 0, color: { argb: ICM_BRAND.colors.slateText } };
    val1.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.white } };
    val1.border = BORDER_THIN;
    r.getCell(3).border = BORDER_THIN;
    val1.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };

    const lbl2 = r.getCell(4);
    lbl2.value = pair.rightLabel;
    lbl2.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: ICM_BRAND.colors.blueDark } };
    lbl2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blueLight } };
    lbl2.border = BORDER_THIN;
    lbl2.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };

    const val2 = r.getCell(5);
    val2.value = pair.rightVal;
    val2.font = { name: 'Segoe UI', size: 9.5, bold: idx <= 2, color: { argb: ICM_BRAND.colors.slateText } };
    val2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.white } };
    val2.border = BORDER_THIN;
    r.getCell(6).border = BORDER_THIN;
    val2.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
  });

  // Compact Topic Mastery Summary Block on Candidate Overview (Row 15+)
  const summaryBannerRow = 15;
  wsOverview.getRow(14).height = 10;
  wsOverview.getRow(summaryBannerRow).height = 24;
  wsOverview.mergeCells(`A${summaryBannerRow}:F${summaryBannerRow}`);
  const summaryTitleCell = wsOverview.getCell(`A${summaryBannerRow}`);
  summaryTitleCell.value = 'TOPIC MASTERY SUMMARY';
  summaryTitleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blue } };
  summaryTitleCell.font = { name: 'Segoe UI', size: 10, bold: true, color: { argb: ICM_BRAND.colors.white } };
  summaryTitleCell.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };

  const summaryHeaderRow = summaryBannerRow + 1;
  const summaryHeaders: Array<{ title: string; align: 'left' | 'center' | 'right' }> = [
    { title: 'Curriculum Topic', align: 'left' },
    { title: 'Questions', align: 'left' },
    { title: 'Marks Earned', align: 'center' },
    { title: 'Total Marks', align: 'center' },
    { title: 'Mastery %', align: 'center' },
    { title: 'Mastery Status', align: 'center' },
  ];

  const shRow = wsOverview.getRow(summaryHeaderRow);
  shRow.height = 22;
  summaryHeaders.forEach((h, i) => {
    const c = shRow.getCell(i + 1);
    c.value = h.title;
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blueDark } };
    c.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: ICM_BRAND.colors.white } };
    c.alignment = { horizontal: h.align, vertical: 'middle', indent: h.align === 'left' ? 1 : 0 };
    c.border = { bottom: { style: 'medium', color: { argb: ICM_BRAND.colors.green } } };
  });

  if (topicEntries.length === 0) {
    const emptyRowNum = summaryHeaderRow + 1;
    wsOverview.mergeCells(`A${emptyRowNum}:F${emptyRowNum}`);
    const emptyRow = wsOverview.getRow(emptyRowNum);
    emptyRow.height = 22;
    const ec = emptyRow.getCell(1);
    ec.value = 'No topic metadata recorded for this assessment.';
    ec.font = { name: 'Segoe UI', size: 9, italic: true, color: { argb: ICM_BRAND.colors.mutedText } };
    ec.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.zebraRow } };
    ec.alignment = { horizontal: 'center', vertical: 'middle' };
    ec.border = BORDER_THIN;
  } else {
    topicEntries.forEach((entry, idx) => {
      const rNum = summaryHeaderRow + 1 + idx;
      const row = wsOverview.getRow(rNum);
      row.height = 20;
      const isZebra = idx % 2 === 1;
      const baseFill = isZebra ? ICM_BRAND.colors.zebraRow : ICM_BRAND.colors.white;
      const tone = getMasteryToneStyle(entry.tier.color);

      const vals: Array<string | number> = [
        sanitizeSpreadsheetCell(entry.topic),
        sanitizeSpreadsheetCell(entry.questionNumbers.length > 0 ? entry.questionNumbers.join(', ') : '-'),
        entry.earnedMarks,
        entry.totalMarks,
        entry.totalMarks > 0 ? entry.percentage / 100 : 0,
        sanitizeSpreadsheetCell(entry.tier.label),
      ];

      vals.forEach((val, cIdx) => {
        const cell = row.getCell(cIdx + 1);
        cell.value = val;
        cell.font = { name: 'Segoe UI', size: 9, bold: cIdx === 0, color: { argb: ICM_BRAND.colors.slateText } };
        cell.border = BORDER_THIN;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: baseFill } };
        cell.alignment = {
          horizontal: summaryHeaders[cIdx].align,
          vertical: 'middle',
          indent: summaryHeaders[cIdx].align === 'left' ? 1 : 0,
        };
        if (cIdx === 4) {
          cell.numFmt = '0.0%';
        }
        if (cIdx === 5) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: tone.fill } };
          cell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: tone.text } };
        }
      });
    });
  }

  // Sheet 2: Dedicated Topic Mastery Diagnostics
  const wsTopic = wb.addWorksheet('Topic Mastery', {
    views: [{ state: 'frozen', ySplit: 6 }],
    properties: { tabColor: { argb: ICM_BRAND.colors.emerald } },
  });

  const topicHeaders: Array<{ title: string; width: number; align: 'left' | 'center' | 'right' }> = [
    { title: 'Curriculum Topic', width: 28, align: 'left' },
    { title: 'Questions', width: 22, align: 'left' },
    { title: 'Items', width: 10, align: 'center' },
    { title: 'Marks Earned', width: 14, align: 'center' },
    { title: 'Total Marks', width: 14, align: 'center' },
    { title: 'Mastery %', width: 14, align: 'center' },
    { title: 'Mastery Status', width: 18, align: 'center' },
    { title: 'Focus / Examiner Guidance', width: 44, align: 'left' },
  ];

  topicHeaders.forEach((h, i) => {
    wsTopic.getColumn(i + 1).width = h.width;
  });

  renderIcmBanner(wsTopic, `Topic Mastery Report • ${submission.studentName}`, 'H', metaInfo);

  const tmHeaderRow = wsTopic.getRow(6);
  tmHeaderRow.height = 28;
  topicHeaders.forEach((h, idx) => {
    const cell = tmHeaderRow.getCell(idx + 1);
    cell.value = h.title;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blue } };
    cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: ICM_BRAND.colors.white } };
    cell.alignment = { horizontal: h.align, vertical: 'middle', indent: h.align === 'left' ? 1 : 0 };
    cell.border = { bottom: { style: 'medium', color: { argb: ICM_BRAND.colors.green } } };
  });

  if (topicEntries.length === 0) {
    wsTopic.mergeCells('A7:H7');
    const emptyRow = wsTopic.getRow(7);
    emptyRow.height = 24;
    const ec = emptyRow.getCell(1);
    ec.value = 'No topic metadata recorded for this assessment.';
    ec.font = { name: 'Segoe UI', size: 9.5, italic: true, color: { argb: ICM_BRAND.colors.mutedText } };
    ec.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.zebraRow } };
    ec.alignment = { horizontal: 'center', vertical: 'middle' };
    ec.border = BORDER_THIN;
  } else {
    let totalItems = 0;
    let totalEarnedSum = 0;
    let totalMaxSum = 0;

    topicEntries.forEach((entry, idx) => {
      const rNum = 7 + idx;
      const row = wsTopic.getRow(rNum);
      row.height = 24;
      const isZebra = idx % 2 === 1;
      const baseFill = isZebra ? ICM_BRAND.colors.zebraRow : ICM_BRAND.colors.white;
      const tone = getMasteryToneStyle(entry.tier.color);

      totalItems += entry.questionCount;
      totalEarnedSum += entry.earnedMarks;
      totalMaxSum += entry.totalMarks;

      const guidance = entry.tier.recommendation || '-';
      const vals: Array<string | number> = [
        sanitizeSpreadsheetCell(entry.topic),
        sanitizeSpreadsheetCell(entry.questionNumbers.length > 0 ? entry.questionNumbers.join(', ') : '-'),
        entry.questionCount > 0 ? entry.questionCount : '-',
        entry.earnedMarks,
        entry.totalMarks,
        entry.totalMarks > 0 ? entry.percentage / 100 : 0,
        sanitizeSpreadsheetCell(entry.tier.label),
        sanitizeSpreadsheetCell(guidance),
      ];

      vals.forEach((v, cIdx) => {
        const cell = row.getCell(cIdx + 1);
        cell.value = v;
        cell.font = {
          name: 'Segoe UI',
          size: 9,
          bold: cIdx === 0 || cIdx === 5,
          color: { argb: ICM_BRAND.colors.slateText },
        };
        cell.border = BORDER_THIN;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: baseFill } };
        cell.alignment = {
          horizontal: topicHeaders[cIdx].align,
          vertical: 'middle',
          indent: topicHeaders[cIdx].align === 'left' ? 1 : 0,
          wrapText: cIdx === 1 || cIdx === 7,
        };

        if (cIdx === 5) {
          cell.numFmt = '0.0%';
        }
        if (cIdx === 6) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: tone.fill } };
          cell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: tone.text } };
        }
      });
    });

    const overallRowNum = 7 + topicEntries.length;
    const overallRow = wsTopic.getRow(overallRowNum);
    overallRow.height = 24;
    const overallPct = totalMaxSum > 0 ? (totalEarnedSum / totalMaxSum) * 100 : 0;
    const overallTier = resolveMasteryTier(masteryTiers, overallPct);
    const overallTone = getMasteryToneStyle(overallTier.color);

    const overallVals: Array<string | number> = [
      'OVERALL ASSESSMENT TOTAL',
      `${topicEntries.length} Topics`,
      totalItems > 0 ? totalItems : '-',
      Math.round(totalEarnedSum * 100) / 100,
      Math.round(totalMaxSum * 100) / 100,
      totalMaxSum > 0 ? overallPct / 100 : 0,
      sanitizeSpreadsheetCell(overallTier.label),
      sanitizeSpreadsheetCell(overallTier.recommendation || '-'),
    ];

    overallVals.forEach((v, cIdx) => {
      const cell = overallRow.getCell(cIdx + 1);
      cell.value = v;
      cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: ICM_BRAND.colors.blueDark } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blueLight } };
      cell.border = {
        top: { style: 'medium', color: { argb: ICM_BRAND.colors.blue } },
        bottom: { style: 'medium', color: { argb: ICM_BRAND.colors.blue } },
        left: BORDER_THIN.left,
        right: BORDER_THIN.right,
      };
      cell.alignment = {
        horizontal: topicHeaders[cIdx].align,
        vertical: 'middle',
        indent: topicHeaders[cIdx].align === 'left' ? 1 : 0,
      };
      if (cIdx === 5) cell.numFmt = '0.0%';
      if (cIdx === 6) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: overallTone.fill } };
        cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: overallTone.text } };
      }
    });

    wsTopic.autoFilter = `A6:H${6 + topicEntries.length}`;
  }

  // Sheet 3: Responses & Model Solutions
  if (submission.questionResults && submission.questionResults.length > 0) {
    const wsResp = wb.addWorksheet('Responses & Solutions', {
      views: [{ state: 'frozen', ySplit: 6 }],
      properties: { tabColor: { argb: ICM_BRAND.colors.green } },
    });

    const respHeaders = [
      { title: 'Question #', width: 12, align: 'center' },
      { title: 'Topic', width: 24, align: 'left' },
      { title: 'Marks Earned', width: 14, align: 'center' },
      { title: 'Result', width: 14, align: 'center' },
      { title: 'Candidate Answer', width: 32, align: 'left' },
      { title: 'Model Solution / Key', width: 38, align: 'left' },
      { title: 'Examiner Misconception Note', width: 36, align: 'left' },
    ];
    respHeaders.forEach((h, idx) => {
      wsResp.getColumn(idx + 1).width = h.width;
    });

    renderIcmBanner(wsResp, `Candidate Responses • ${submission.studentName}`, 'G', metaInfo);

    const rHeaderRow = wsResp.getRow(6);
    rHeaderRow.height = 28;
    respHeaders.forEach((h, idx) => {
      const cell = rHeaderRow.getCell(idx + 1);
      cell.value = h.title;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blue } };
      cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: ICM_BRAND.colors.white } };
      cell.alignment = { horizontal: h.align as ExcelJS.Alignment['horizontal'], vertical: 'middle' };
      cell.border = { bottom: { style: 'medium', color: { argb: ICM_BRAND.colors.green } } };
    });

    submission.questionResults.forEach((qr, idx) => {
      const rowNum = 7 + idx;
      const row = wsResp.getRow(rowNum);
      row.height = 22;
      const isZebra = idx % 2 === 1;

      const candAns = formatCandidateAnswer(qr.studentAnswer, qr.options, qr.gradingMethod, false);
      const modelSol = formatCandidateAnswer(qr.correctAnswer, qr.options, qr.gradingMethod, false) || qr.correctAnswer || '-';
      const miscon = qr.misconceptions?.join('; ') || '-';

      const vals = [
        `Q${qr.questionNumber || idx + 1}`,
        sanitizeSpreadsheetCell(qr.topic || 'General'),
        `${qr.earnedMarks} / ${qr.maxMarks}`,
        qr.isCorrect ? 'Correct ✓' : 'Incorrect ✗',
        sanitizeSpreadsheetCell(candAns),
        sanitizeSpreadsheetCell(modelSol),
        sanitizeSpreadsheetCell(miscon),
      ];

      vals.forEach((v, cIdx) => {
        const cell = row.getCell(cIdx + 1);
        cell.value = v;
        cell.font = { name: 'Segoe UI', size: 9, color: { argb: ICM_BRAND.colors.slateText } };
        cell.border = BORDER_THIN;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isZebra ? ICM_BRAND.colors.zebraRow : ICM_BRAND.colors.white } };
        cell.alignment = { horizontal: respHeaders[cIdx].align as ExcelJS.Alignment['horizontal'], vertical: 'middle' };

        // Result Color Tag
        if (cIdx === 3) {
          cell.font = { name: 'Segoe UI', size: 9, bold: true };
          if (qr.isCorrect) {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.emeraldLight } };
            cell.font.color = { argb: ICM_BRAND.colors.emeraldText };
          } else {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.crimsonLight } };
            cell.font.color = { argb: ICM_BRAND.colors.crimsonText };
          }
        }
      });
    });

    wsResp.autoFilter = `A6:G${6 + submission.questionResults.length}`;
  }

  // Sheet 4: Proctoring Audit Log (if any)
  if (submission.proctoringLogs && submission.proctoringLogs.length > 0) {
    const wsProctor = wb.addWorksheet('Proctoring Log', {
      views: [{ state: 'frozen', ySplit: 6 }],
      properties: { tabColor: { argb: ICM_BRAND.colors.crimson } },
    });

    const pHeaders = [
      { title: 'Strike #', width: 12, align: 'center' },
      { title: 'Elapsed Time', width: 16, align: 'center' },
      { title: 'Timestamp', width: 18, align: 'center' },
      { title: 'Violation Type', width: 22, align: 'left' },
      { title: 'Security Event Description', width: 44, align: 'left' },
      { title: 'Severity', width: 14, align: 'center' },
    ];
    pHeaders.forEach((h, idx) => {
      wsProctor.getColumn(idx + 1).width = h.width;
    });

    renderIcmBanner(wsProctor, `Proctoring Audit Log • ${submission.studentName}`, 'F', metaInfo);

    const rPHeader = wsProctor.getRow(6);
    rPHeader.height = 28;
    pHeaders.forEach((h, idx) => {
      const cell = rPHeader.getCell(idx + 1);
      cell.value = h.title;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blue } };
      cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: ICM_BRAND.colors.white } };
      cell.alignment = { horizontal: h.align as ExcelJS.Alignment['horizontal'], vertical: 'middle' };
      cell.border = { bottom: { style: 'medium', color: { argb: ICM_BRAND.colors.crimson } } };
    });

    submission.proctoringLogs.forEach((log, idx) => {
      const rowNum = 7 + idx;
      const row = wsProctor.getRow(rowNum);
      row.height = 22;
      const isZebra = idx % 2 === 1;

      const elapsed =
        log.elapsedExamSeconds !== undefined && log.elapsedExamSeconds >= 0
          ? `+${Math.floor(log.elapsedExamSeconds / 60)}m ${log.elapsedExamSeconds % 60}s`
          : '-';

      const vals = [
        `Strike ${log.strike}`,
        elapsed,
        formatProctorTimestamp(log.timestamp),
        sanitizeSpreadsheetCell(log.type || 'security_event'),
        sanitizeSpreadsheetCell(log.event),
        log.severity.toUpperCase(),
      ];

      vals.forEach((v, cIdx) => {
        const cell = row.getCell(cIdx + 1);
        cell.value = v;
        cell.font = { name: 'Segoe UI', size: 9, color: { argb: ICM_BRAND.colors.slateText } };
        cell.border = BORDER_THIN;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isZebra ? ICM_BRAND.colors.zebraRow : ICM_BRAND.colors.white } };
        cell.alignment = { horizontal: pHeaders[cIdx].align as ExcelJS.Alignment['horizontal'], vertical: 'middle' };

        if (cIdx === 5 && log.severity === 'critical') {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.crimsonLight } };
          cell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: ICM_BRAND.colors.crimsonText } };
        }
      });
    });

    wsProctor.autoFilter = `A6:F${6 + submission.proctoringLogs.length}`;
  }

  // Sheet 5: Forensic Telemetry & Time Analytics (if any)
  if (
    submission.forensics &&
    (submission.forensics.questionTimeAnalytics?.length || submission.forensics.answerChangeLogs?.length)
  ) {
    const wsTelemetry = wb.addWorksheet('Forensic Telemetry', {
      views: [{ state: 'frozen', ySplit: 6 }],
      properties: { tabColor: { argb: ICM_BRAND.colors.blueDark } },
    });

    const tHeaders = [
      { title: 'Question #', width: 12, align: 'center' },
      { title: 'Topic', width: 26, align: 'left' },
      { title: 'Total Dwell Time', width: 18, align: 'center' },
      { title: 'Dwell (Seconds)', width: 16, align: 'right' },
      { title: 'Visits Count', width: 14, align: 'right' },
      { title: 'Revisions Count', width: 16, align: 'right' },
      { title: 'Revision Sequence', width: 42, align: 'left' },
      { title: 'Rapid Guessing Alert', width: 22, align: 'center' },
    ];
    tHeaders.forEach((h, idx) => {
      wsTelemetry.getColumn(idx + 1).width = h.width;
    });

    renderIcmBanner(wsTelemetry, `Dwell Time & Revision Telemetry • ${submission.studentName}`, 'H', metaInfo);

    const qtaMap = new Map<number, QuestionTimeAnalytics>();
    submission.forensics.questionTimeAnalytics?.forEach((qta) => {
      qtaMap.set(qta.questionIndex, qta);
    });

    const revMap = new Map<number, AnswerChangeLogEntry[]>();
    submission.forensics.answerChangeLogs?.forEach((rev) => {
      const list = revMap.get(rev.questionIndex) || [];
      list.push(rev);
      revMap.set(rev.questionIndex, list);
    });

    const rTHeader = wsTelemetry.getRow(6);
    rTHeader.height = 28;
    tHeaders.forEach((h, idx) => {
      const cell = rTHeader.getCell(idx + 1);
      cell.value = h.title;
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blue } };
      cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: ICM_BRAND.colors.white } };
      cell.alignment = { horizontal: h.align as ExcelJS.Alignment['horizontal'], vertical: 'middle' };
      cell.border = { bottom: { style: 'medium', color: { argb: ICM_BRAND.colors.blueDark } } };
    });

    (submission.questionResults || []).forEach((qr, idx) => {
      const rowNum = 7 + idx;
      const row = wsTelemetry.getRow(rowNum);
      row.height = 22;
      const isZebra = idx % 2 === 1;

      const qta = qtaMap.get(idx);
      const revs = revMap.get(idx) || [];
      const dwellSec = qta?.totalDwellSeconds ?? 0;
      const dwellFormatted = dwellSec > 0 ? `${Math.floor(dwellSec / 60)}m ${dwellSec % 60}s` : '-';

      const revTrail =
        revs.length > 0
          ? revs.map((r) => formatCandidateAnswer(r.newAnswer, qr.options, qr.gradingMethod, true)).join(' ➔ ')
          : 'Initial choice only (0 revisions)';

      const isRapid = dwellSec > 0 && dwellSec < 5 && qr.maxMarks > 1;

      const vals = [
        `Q${qr.questionNumber || idx + 1}`,
        sanitizeSpreadsheetCell(qr.topic || 'General'),
        dwellFormatted,
        dwellSec,
        qta?.visitCount || (dwellSec > 0 ? 1 : 0),
        revs.length,
        sanitizeSpreadsheetCell(revTrail),
        isRapid ? 'RAPID (<5s) ⚠️' : 'Normal',
      ];

      vals.forEach((v, cIdx) => {
        const cell = row.getCell(cIdx + 1);
        cell.value = v;
        cell.font = { name: 'Segoe UI', size: 9, color: { argb: ICM_BRAND.colors.slateText } };
        cell.border = BORDER_THIN;
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: isZebra ? ICM_BRAND.colors.zebraRow : ICM_BRAND.colors.white } };
        cell.alignment = { horizontal: tHeaders[cIdx].align as ExcelJS.Alignment['horizontal'], vertical: 'middle' };

        if (cIdx === 7 && isRapid) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.amberLight } };
          cell.font = { name: 'Segoe UI', size: 9, bold: true, color: { argb: ICM_BRAND.colors.amberText } };
        }
      });
    });

    wsTelemetry.autoFilter = `A6:H${6 + (submission.questionResults || []).length}`;
  }

  const safeName = buildSafeFileSlug(submission.studentName, 'candidate');
  const safeCode = buildSafeFileSlug(submission.quizCode || 'exam', 'exam');
  const filename = `${safeName}_${safeCode}_icm_report.xlsx`;
  return { wb, filename };
}

/**
 * Exports a single candidate's complete Excel diagnostic report (.xlsx).
 */
export async function exportSingleSubmissionExcelICM(
  submission: StudentSubmission,
  options?: SingleSubmissionExcelOptions
): Promise<void> {
  const { wb, filename } = buildSingleSubmissionWorkbookICM(submission, options);
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  await exportFileUniversal(blob, filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

/**
 * Generates a ZIP archive blob containing one individual .xlsx workbook per student.
 * Respects `options.selectedClass` filtering and guarantees unique filenames per candidate.
 */
export async function buildBatchSingleSubmissionsZipBlobICM(
  submissions: StudentSubmission[],
  options?: BatchSubmissionExcelZipOptions
): Promise<{ blob: Blob; zipFilename: string; count: number; entries: string[] }> {
  const selectedClass = options?.selectedClass || 'all';
  const filtered =
    selectedClass === 'all'
      ? submissions
      : submissions.filter(
          (s) => (s.studentClass || 'General').toLowerCase() === selectedClass.toLowerCase()
        );

  if (filtered.length === 0) {
    throw new Error(
      selectedClass === 'all'
        ? 'No student submissions available to export.'
        : `No student submissions found for class "${selectedClass}".`
    );
  }

  const masteryTiers = options?.masteryTiers ?? getTopicMasteryTiers();
  const zip = new JSZip();
  const usedFilenames = new Map<string, number>();
  const entries: string[] = [];

  for (let i = 0; i < filtered.length; i++) {
    const sub = filtered[i];
    const { wb, filename } = buildSingleSubmissionWorkbookICM(sub, {
      gradeThresholds: options?.gradeThresholds,
      masteryTiers,
    });

    // Ensure unique filenames inside archive when two students sanitize identically
    let finalName = filename;
    if (usedFilenames.has(finalName)) {
      const seatSlug = sub.candidateNumber ? `_${buildSafeFileSlug(sub.candidateNumber, '')}` : '';
      const candidateBase = filename.replace(/\.xlsx$/i, '');
      const nextCount = (usedFilenames.get(finalName) || 1) + 1;
      usedFilenames.set(finalName, nextCount);
      finalName = seatSlug && !usedFilenames.has(`${candidateBase}${seatSlug}.xlsx`)
        ? `${candidateBase}${seatSlug}.xlsx`
        : `${candidateBase}_${nextCount}.xlsx`;
    }
    usedFilenames.set(finalName, usedFilenames.get(finalName) || 1);

    const buffer = await wb.xlsx.writeBuffer();
    zip.file(finalName, buffer);
    entries.push(finalName);

    if (options?.onProgress) {
      options.onProgress(i + 1, filtered.length);
    }

    if (i % 5 === 4) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const quizSlug = buildSafeFileSlug(
    options?.quizTitle || filtered[0]?.quizCode || 'assessment',
    'assessment'
  );
  const classSlug = selectedClass === 'all' ? 'all_classes' : buildSafeFileSlug(selectedClass, 'class');
  const zipFilename = `${quizSlug}_${classSlug}_individual_reports.zip`;

  return { blob, zipFilename, count: filtered.length, entries };
}

/**
 * Builds and downloads a ZIP archive of individual student Excel diagnostic workbooks.
 */
export async function exportBatchSingleSubmissionsExcelZipICM(
  submissions: StudentSubmission[],
  options?: BatchSubmissionExcelZipOptions
): Promise<{ count: number; zipFilename: string }> {
  const { blob, zipFilename, count } = await buildBatchSingleSubmissionsZipBlobICM(submissions, options);
  await exportFileUniversal(blob, zipFilename, 'application/zip');
  return { count, zipFilename };
}

export interface ProctorAuditExcelExportOptions {
  reportTitle: string;
  quizCode?: string;
  targetClass?: string;
  subject?: string;
  schoolName?: string;
  filenameSlug?: string;
}

/**
 * Builds an ICM-branded Proctoring & Invigilation Audit Log workbook (.xlsx)
 * for an individual candidate, a class cohort, or the entire school sitting.
 */
export function buildProctorAuditLogWorkbookICM(
  events: ProctorLogEvent[],
  options: ProctorAuditExcelExportOptions
): { wb: ExcelJS.Workbook; filename: string } {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Sekolah Insan Cendekia Madani (ICM)';
  wb.created = new Date();

  const ws = wb.addWorksheet('Proctoring Audit Log', {
    views: [{ state: 'frozen', ySplit: 6 }],
    properties: { tabColor: { argb: ICM_BRAND.colors.crimson } },
  });

  const headers: Array<{ title: string; width: number; align: 'left' | 'center' | 'right' }> = [
    { title: 'Timestamp', width: 22, align: 'center' },
    { title: 'Exam Code', width: 14, align: 'center' },
    { title: 'Class / Cohort', width: 16, align: 'center' },
    { title: 'Candidate Name', width: 26, align: 'left' },
    { title: 'Seat #', width: 12, align: 'center' },
    { title: 'Event Type', width: 18, align: 'center' },
    { title: 'Severity', width: 13, align: 'center' },
    { title: 'Security / Invigilator Event Detail', width: 48, align: 'left' },
  ];

  headers.forEach((h, i) => {
    ws.getColumn(i + 1).width = h.width;
  });

  renderIcmBanner(ws, options.reportTitle, 'H', {
    assessmentTitle: options.reportTitle,
    subject: options.subject || 'Exam Invigilation',
    quizCode: options.quizCode || 'ALL EXAMS',
    targetClass: options.targetClass || 'All Classes',
    schoolName: options.schoolName || ICM_BRAND.schoolName,
  });

  const headerRow = ws.getRow(6);
  headerRow.height = 28;
  headers.forEach((h, idx) => {
    const cell = headerRow.getCell(idx + 1);
    cell.value = h.title;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blue } };
    cell.font = { name: 'Segoe UI', size: 9.5, bold: true, color: { argb: ICM_BRAND.colors.white } };
    cell.alignment = { horizontal: h.align, vertical: 'middle', indent: h.align === 'left' ? 1 : 0 };
    cell.border = { bottom: { style: 'medium', color: { argb: ICM_BRAND.colors.crimson } } };
  });

  if (events.length === 0) {
    ws.mergeCells('A7:H7');
    const emptyRow = ws.getRow(7);
    emptyRow.height = 24;
    const ec = emptyRow.getCell(1);
    ec.value = 'No proctoring or violation events recorded for this scope.';
    ec.font = { name: 'Segoe UI', size: 9.5, italic: true, color: { argb: ICM_BRAND.colors.mutedText } };
    ec.alignment = { horizontal: 'center', vertical: 'middle' };
    ec.border = BORDER_THIN;
  } else {
    events.forEach((evt, idx) => {
      const row = ws.getRow(7 + idx);
      row.height = 22;
      const isZebra = idx % 2 === 1;
      const sevUpper = (evt.severity || 'info').toUpperCase();

      const vals = [
        formatProctorTimestamp(evt.timestamp),
        sanitizeSpreadsheetCell(evt.quizCode || '-'),
        sanitizeSpreadsheetCell(evt.candidateClass || 'Unassigned'),
        sanitizeSpreadsheetCell(evt.studentName),
        sanitizeSpreadsheetCell(evt.candidateNumber || '-'),
        sanitizeSpreadsheetCell(String(evt.type || 'event').replace(/_/g, ' ').toUpperCase()),
        sevUpper,
        sanitizeSpreadsheetCell(evt.detail),
      ];

      vals.forEach((v, cIdx) => {
        const cell = row.getCell(cIdx + 1);
        cell.value = v;
        cell.font = { name: 'Segoe UI', size: 9, color: { argb: ICM_BRAND.colors.slateText } };
        cell.border = BORDER_THIN;
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: isZebra ? ICM_BRAND.colors.zebraRow : ICM_BRAND.colors.white },
        };
        cell.alignment = {
          horizontal: headers[cIdx].align,
          vertical: 'middle',
          indent: headers[cIdx].align === 'left' ? 1 : 0,
          wrapText: cIdx === 7,
        };

        if (cIdx === 6) {
          cell.font = { name: 'Segoe UI', size: 9, bold: true };
          if (evt.severity === 'critical') {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.crimsonLight } };
            cell.font.color = { argb: ICM_BRAND.colors.crimsonText };
          } else if (evt.severity === 'warning') {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.amberLight } };
            cell.font.color = { argb: ICM_BRAND.colors.amberText };
          } else {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ICM_BRAND.colors.blueLight } };
            cell.font.color = { argb: ICM_BRAND.colors.blueDark };
          }
        }
      });
    });

    ws.autoFilter = `A6:H${6 + events.length}`;
  }

  const slug = buildSafeFileSlug(options.filenameSlug || options.targetClass || options.quizCode || 'proctor', 'proctor');
  const filename = `${slug}_proctor_audit_log.xlsx`;
  return { wb, filename };
}

/**
 * Exports a proctoring audit log workbook (.xlsx) for a candidate, class, or school scope.
 */
export async function exportProctorAuditLogExcelICM(
  events: ProctorLogEvent[],
  options: ProctorAuditExcelExportOptions
): Promise<void> {
  const { wb, filename } = buildProctorAuditLogWorkbookICM(events, options);
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  await exportFileUniversal(blob, filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

/**
 * Helper to convert 1-based column number to Excel column letters (1 -> A, 27 -> AA)
 */
function ExcelJS_colLetter(colNumber: number): string {
  let temp: number;
  let letter = '';
  while (colNumber > 0) {
    temp = (colNumber - 1) % 26;
    letter = String.fromCharCode(temp + 65) + letter;
    colNumber = (colNumber - temp - 1) / 26;
  }
  return letter;
}
