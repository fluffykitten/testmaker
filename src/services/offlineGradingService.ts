// ─── Offline Exam Grading & Auto-Evaluation Service ──────────────────────────────
// Generates Excel templates, parses filled sheets, auto-grades student responses
// using deterministic and AI rules, and saves results to the central gradebook.

import * as XLSX from 'xlsx';
import { exportFileUniversal } from './fileExportBridge';
import type { Question, SubQuestion } from '../types/database';
import type { ExamHeaderConfig } from './testBuilderService';
import {
  gradeDeterministicAnswer,
  extractAcceptableAnswers,
  resolveMcqCorrectOptionIndex,
  extractMultiSelectTargetLetters,
} from './deterministicGradingService';
import { evaluateAnswerWithGemini } from './aiGradingService';
import {
  saveBatchQuizSubmissionsCloud,
  type StudentSubmission,
  type QuestionSubmissionResult,
} from './quizSubmissionService';
import {
  savePublishedQuiz,
  type PublishedQuiz,
} from './quizManagerService';

export interface OfflineGradingColumn {
  id: string;                    // unique key: "q_0" or "q_0_sub_0"
  columnKey: string;             // short label: "Q1" or "Q1(a)"
  headerLabel: string;           // formatted header: "Q1 [1m] (MCQ)"
  questionIndex: number;
  subIndex?: number;
  question: Question;
  subQuestion?: SubQuestion;
  maxMarks: number;
  questionStyle: string;
  referenceAnswer: string;
  acceptableAnswers: string[];
  questionStem: string;
  topic: string;
}

export interface RawOfflineStudentRow {
  rowNumber: number;
  studentName: string;
  studentClass: string;
  candidateNumber: string;
  answers: Record<string, string | number>; // columnId -> response
}

export interface OfflineGradeSessionResult {
  quizTitle: string;
  subject: string;
  totalMarks: number;
  columns: OfflineGradingColumn[];
  students: StudentSubmission[];
  unhandledQuestionsCount: number;
}

// ─── 1. Helper: Extract Reference Correct Answer & MCQ Letters ───────────────────

/**
 * Normalizes candidate MCQ inputs (e.g. "D", "Option D", "d.", "(D)", "4", or full option text) into a single uppercase letter (A, B, C, D).
 */
export function extractStudentMcqLetter(
  studentInput: string,
  options?: any[] | null
): string | null {
  if (!studentInput) return null;
  const trimmed = studentInput.trim();

  // 1. Direct single letter: "A", "b", "(C)", "[d]", "D."
  const singleMatch = trimmed.match(/^[[(]?\s*([A-Da-d])\s*[\]).:]?$/);
  if (singleMatch) return singleMatch[1].toUpperCase();

  // 2. "Option D", "Choice D", "D - Limewater", "D: Limewater"
  const optionMatch = trimmed.match(/^(?:Option|Choice)?\s*[:\-]?\s*([A-Da-d])\b/i);
  if (optionMatch) return optionMatch[1].toUpperCase();

  // 3. Numerical index (e.g. 1 -> A, 2 -> B, 3 -> C, 4 -> D)
  const num = Number(trimmed);
  if (!isNaN(num) && Number.isInteger(num)) {
    if (num >= 1 && num <= 4) {
      return String.fromCharCode(64 + num);
    }
  }

  // 4. Match option text against options array
  if (options && Array.isArray(options) && options.length > 0) {
    const lowerInput = trimmed.toLowerCase();
    for (let oIdx = 0; oIdx < options.length; oIdx++) {
      const opt = options[oIdx];
      const optStr = typeof opt === 'string' ? opt : (opt?.text || '');
      const cleanOptText = optStr.replace(/^[[(]?([A-Da-d])[\]).:\s-]+/, '').trim().toLowerCase();
      if (cleanOptText && (lowerInput === cleanOptText || cleanOptText.includes(lowerInput) || lowerInput.includes(cleanOptText))) {
        return String.fromCharCode(65 + oIdx);
      }
    }
  }

  return trimmed.replace(/[^A-Za-z]/g, '').charAt(0).toUpperCase() || null;
}

export function deriveColumnReferenceAnswer(q: Question, sq?: SubQuestion): string {
  const targetOptions = sq?.options || q.options;
  const isMcq =
    (targetOptions && targetOptions.length >= 2) ||
    q.question_style === 'Multiple Choice';

  const candidates: string[] = [];
  if (sq && sq.mark_scheme) {
    const sqMs: any = sq.mark_scheme;
    if (typeof sqMs === 'string') candidates.push(sqMs);
    else if (typeof sqMs === 'object') {
      if (Array.isArray(sqMs.acceptable_answers)) candidates.push(...sqMs.acceptable_answers);
      if (Array.isArray(sqMs.marking_points)) candidates.push(...sqMs.marking_points);
    }
  }
  if (q.mark_scheme) {
    const qMs: any = q.mark_scheme;
    if (typeof qMs === 'string') candidates.push(qMs);
    else if (typeof qMs === 'object') {
      if (Array.isArray(qMs.acceptable_answers)) candidates.push(...qMs.acceptable_answers);
      if (Array.isArray(qMs.marking_points)) candidates.push(...qMs.marking_points);
    }
  }

  // Check multi-select first
  const multiLetters = extractMultiSelectTargetLetters(candidates);
  if (multiLetters.length >= 2) {
    return multiLetters.join(', ');
  }

  if (isMcq) {
    const sIdx = sq && q.sub_questions ? q.sub_questions.indexOf(sq) : undefined;
    const correctIdx = resolveMcqCorrectOptionIndex(q, sIdx !== undefined && sIdx >= 0 ? sIdx : undefined);
    return String.fromCharCode(65 + correctIdx);
  }

  if (sq && sq.mark_scheme) {
    const sqMs: any = sq.mark_scheme;
    if (typeof sqMs === 'string') {
      const clean = sqMs.replace(/\[\d+\]/g, '').trim();
      if (clean) return clean;
    } else if (typeof sqMs === 'object') {
      const first = sqMs.marking_points?.[0] || sqMs.acceptable_answers?.[0] || '';
      const clean = String(first).replace(/\[\d+\]/g, '').trim();
      if (clean) return clean;
    }
  }

  if (q.mark_scheme) {
    const qMs: any = q.mark_scheme;
    if (typeof qMs === 'string') {
      const clean = qMs.replace(/\[\d+\]/g, '').trim();
      if (clean) return clean;
    } else if (typeof qMs === 'object') {
      if (Array.isArray(qMs.acceptable_answers) && qMs.acceptable_answers.length > 0) {
        return String(qMs.acceptable_answers[0]).trim();
      }
      if (Array.isArray(qMs.marking_points) && qMs.marking_points.length > 0) {
        return String(qMs.marking_points[0]).replace(/\[\d+\]/g, '').trim();
      }
    }
  }

  return 'See mark scheme';
}

// ─── 2. Build Flattened Columns from Test Questions ────────────────────────────

export function getOfflineGradingColumns(questions: Question[]): OfflineGradingColumn[] {
  const columns: OfflineGradingColumn[] = [];

  questions.forEach((q, qIdx) => {
    // Custom tests ALWAYS number sequentially starting from Q1, Q2, Q3 regardless of past paper origin
    const qNum = `Q${qIdx + 1}`;
    const topic = q.topic || 'General';

    // If question has nested sub-parts
    if (q.sub_questions && q.sub_questions.length > 0) {
      q.sub_questions.forEach((sq, sIdx) => {
        const rawSubId = sq.sub_id || String.fromCharCode(97 + sIdx);
        const cleanSubId = rawSubId.replace(/[()]/g, '').replace(/^\d+/, '').trim() || String.fromCharCode(97 + sIdx);
        const colKey = `${qNum}(${cleanSubId})`;
        const marks = sq.marks || 1;
        const isMcq = !!(sq.options && sq.options.length >= 2);
        const style = isMcq ? 'Multiple Choice' : 'Structured';
        const refAnswer = deriveColumnReferenceAnswer(q, sq);
        const acceptable = extractAcceptableAnswers(q, sIdx);

        columns.push({
          id: `${q.id}_sub_${sIdx}`,
          columnKey: colKey,
          headerLabel: `${colKey} [${marks}m] (${isMcq ? 'MCQ' : 'Part'})`,
          questionIndex: qIdx,
          subIndex: sIdx,
          question: q,
          subQuestion: sq,
          maxMarks: marks,
          questionStyle: style,
          referenceAnswer: refAnswer,
          acceptableAnswers: acceptable,
          questionStem: sq.question_text || q.question_text,
          topic,
        });
      });
    } else {
      // Standalone question
      const marks = q.marks || 1;
      const isMcq = !!(q.options && q.options.length >= 2) || q.question_style === 'Multiple Choice';
      const style = q.question_style || (isMcq ? 'Multiple Choice' : 'Structured');
      const refAnswer = deriveColumnReferenceAnswer(q);
      const acceptable = extractAcceptableAnswers(q);

      columns.push({
        id: q.id,
        columnKey: qNum,
        headerLabel: `${qNum} [${marks}m] (${isMcq ? 'MCQ' : style})`,
        questionIndex: qIdx,
        question: q,
        maxMarks: marks,
        questionStyle: style,
        referenceAnswer: refAnswer,
        acceptableAnswers: acceptable,
        questionStem: q.question_text,
        topic,
      });
    }
  });

  return columns;
}

// ─── 3. Generate Styled Excel Grading Template ─────────────────────────────────

export function exportOfflineGradingTemplateExcel(
  headerConfig: ExamHeaderConfig,
  questions: Question[]
): void {
  const columns = getOfflineGradingColumns(questions);
  const totalMarks = columns.reduce((s, c) => s + c.maxMarks, 0);
  const testTitle = headerConfig.title || 'Offline Exam Assessment';
  const subject = headerConfig.subject || 'Chemistry';

  const wb = XLSX.utils.book_new();

  // ── Sheet 1: Student Responses (Data Entry) ──────────────────────────────────
  const responseSheetData: any[][] = [];

  // Row 1: Header / Test info banner
  responseSheetData.push([
    `TESTMAKER OFFLINE EXAM: ${testTitle.toUpperCase()}`,
    `Subject: ${subject}`,
    `Total Marks: ${totalMarks}`,
    `Total Questions/Parts: ${columns.length}`,
    `Date: ${new Date().toLocaleDateString()}`,
  ]);

  // Row 2: Helpful instruction row
  responseSheetData.push([
    'INSTRUCTIONS: Fill candidate details and their answers (e.g. A, B, 24.5 cm3, Fe2O3) or enter numerical marks (0-max) directly.',
    '',
    '',
    ...columns.map((c) => `Max: ${c.maxMarks}m | Type: ${c.questionStyle}`),
  ]);

  // Row 3: Table Column Headers
  const tableHeaders = [
    'Candidate Name',
    'Class / Section',
    'Candidate #',
    ...columns.map((c) => c.headerLabel),
  ];
  responseSheetData.push(tableHeaders);

  // Row 4: Frozen / Reference Key Row
  const referenceRow = [
    '[OFFICIAL ANSWER KEY]',
    'ALL CLASSES',
    'KEY-001',
    ...columns.map((c) => c.referenceAnswer),
  ];
  responseSheetData.push(referenceRow);

  // Rows 5-7: Sample demonstration rows
  responseSheetData.push([
    'Alexander Wright (Sample)',
    'Grade 10-A',
    '0101',
    ...columns.map((c) => (c.questionStyle === 'Multiple Choice' ? c.referenceAnswer : c.referenceAnswer)),
  ]);
  responseSheetData.push([
    'Beatrice Vance (Sample)',
    'Grade 10-A',
    '0102',
    ...columns.map((c) => (c.questionStyle === 'Multiple Choice' ? (c.referenceAnswer === 'A' ? 'B' : 'A') : '')),
  ]);

  // Add 15 blank starter rows ready for teacher entry
  for (let i = 1; i <= 15; i++) {
    responseSheetData.push(['', '', '', ...columns.map(() => '')]);
  }

  const wsResponses = XLSX.utils.aoa_to_sheet(responseSheetData);

  // Column width formatting
  const colWidths = [
    { wch: 28 }, // Candidate Name
    { wch: 18 }, // Class / Section
    { wch: 15 }, // Candidate #
    ...columns.map((c) => ({ wch: Math.max(c.headerLabel.length + 4, 16) })),
  ];
  wsResponses['!cols'] = colWidths;

  XLSX.utils.book_append_sheet(wb, wsResponses, 'Student Responses');

  // ── Sheet 2: Mark Scheme & Solutions ─────────────────────────────────────────
  const markSchemeRows = columns.map((col) => {
    let acceptableStr = col.acceptableAnswers.join(' | ');
    if (!acceptableStr && col.question.mark_scheme?.marking_points) {
      acceptableStr = col.question.mark_scheme.marking_points.join('; ');
    }

    const guidance = col.subQuestion?.guidance || col.question.mark_scheme?.guidance?.join('; ') || '-';

    return {
      'Item Code': col.columnKey,
      'Type': col.questionStyle,
      'Max Marks': col.maxMarks,
      'Topic': col.topic,
      'Model Answer': col.referenceAnswer,
      'Acceptable Answers & Criteria': acceptableStr || 'Exact / equivalent chemical term',
      'Examiner Guidance & Tips': guidance,
      'Question Stem': col.questionStem.substring(0, 150) + (col.questionStem.length > 150 ? '…' : ''),
    };
  });

  const wsMarkScheme = XLSX.utils.json_to_sheet(markSchemeRows);
  wsMarkScheme['!cols'] = [
    { wch: 12 }, // Item Code
    { wch: 16 }, // Type
    { wch: 12 }, // Max Marks
    { wch: 20 }, // Topic
    { wch: 22 }, // Model Answer
    { wch: 35 }, // Acceptable Criteria
    { wch: 30 }, // Guidance
    { wch: 45 }, // Question Stem
  ];
  XLSX.utils.book_append_sheet(wb, wsMarkScheme, 'Mark Scheme & Key');

  // ── Sheet 3: Data Entry Guide ────────────────────────────────────────────────
  const guideData = [
    ['TESTMAKER OFFLINE GRADING - USER GUIDE & INSTRUCTIONS'],
    [''],
    ['1. How to Enter Student Answers:'],
    [' • Multiple Choice (MCQ):', 'Enter single letters A, B, C, or D (case-insensitive).'],
    [' • Chemical Formulas:', 'Enter normal chemical formulas like H2O, Fe2O3, Ca(OH)2. The engine automatically handles subscripts and names.'],
    [' • Calculations & Numbers:', 'Enter numerical values with or without units (e.g. 24.5, 24.5 cm3, 0.025 mol/dm3). ±1.5% tolerance is allowed.'],
    [' • Short Answers & Keywords:', 'Enter keywords (e.g. exothermic, filtration, electrolysis). Minor typos are handled automatically.'],
    [''],
    ['2. Pre-Marked Physical Papers (Direct Marks Entry):'],
    [' • If you have already marked physical papers by hand with a red pen, you can directly enter the numerical mark (e.g. 0, 1, 2) in the question cell!'],
    [' • The auto-grader recognizes numerical marks within [0, Max Marks] and tallies class totals, percentages, and grade boundaries.'],
    [''],
    ['3. Copy-Pasting School Rosters:'],
    [' • You can copy candidate names, classes, and IDs directly from Google Classroom, Schoology, ManageBac, or Excel rosters and paste them into Sheet 1.'],
    [''],
    ['4. Auto-Grading & Reports:'],
    [' • After filling, save this file and upload it into Testmaker via "Grade Offline".'],
    [' • Testmaker auto-grades all answers, generates individual Cambridge-style PDF report cards, and adds the exam to your Gradebook.'],
  ];

  const wsGuide = XLSX.utils.aoa_to_sheet(guideData);
  wsGuide['!cols'] = [{ wch: 30 }, { wch: 70 }];
  XLSX.utils.book_append_sheet(wb, wsGuide, 'Instructions');

  // Write and trigger download
  const cleanTitle = (testTitle || 'Exam').replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `${cleanTitle}_Offline_Grading_Template.xlsx`;
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  exportFileUniversal(new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileName, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

// ─── 4. Parse Uploaded Excel File ──────────────────────────────────────────────

export async function parseOfflineGradingExcel(
  file: File,
  questions: Question[]
): Promise<{ rows: RawOfflineStudentRow[]; columns: OfflineGradingColumn[] }> {
  const columns = getOfflineGradingColumns(questions);
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: 'array' });

  // Locate the student responses worksheet
  const sheetNames = workbook.SheetNames;
  const targetSheetName =
    sheetNames.find((s) => /response|student|entry|answer/i.test(s)) || sheetNames[0];
  const sheet = workbook.Sheets[targetSheetName];

  if (!sheet) {
    throw new Error(`Could not find a valid response sheet in ${file.name}`);
  }

  // Convert to raw array of rows
  const rawRows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: '' });
  if (!rawRows || rawRows.length === 0) {
    throw new Error('The uploaded Excel sheet appears to be empty.');
  }

  // Locate the header row containing "Candidate Name" or "Name"
  let headerRowIndex = -1;
  for (let r = 0; r < Math.min(rawRows.length, 10); r++) {
    const row = rawRows[r];
    if (row && row.some((cell) => typeof cell === 'string' && /candidate\s*name|student\s*name|student/i.test(cell))) {
      headerRowIndex = r;
      break;
    }
  }

  if (headerRowIndex === -1) {
    // Fallback: look for a row with at least 3 columns where col 0 has letters
    headerRowIndex = 2; // typical index
  }

  const headerRow = rawRows[headerRowIndex] || [];

  // Map header row columns to our OfflineGradingColumn items
  // Columns 0, 1, 2 are usually Name, Class, Candidate #
  let nameColIdx = 0;
  let classColIdx = 1;
  let candNumColIdx = 2;

  headerRow.forEach((cell, idx) => {
    const str = String(cell).toLowerCase().trim();
    if (/candidate\s*name|student\s*name|name/i.test(str)) nameColIdx = idx;
    else if (/class|section|group|grade/i.test(str)) classColIdx = idx;
    else if (/candidate\s*#|id|number|seat/i.test(str)) candNumColIdx = idx;
  });

  // Helper: Safely match Excel column header to a question item code (e.g. Q1, Q1(a), Q10)
  const matchHeaderToColumn = (headerStr: any, colKey: string): boolean => {
    if (!headerStr || !colKey) return false;
    const cleanHeader = String(headerStr).trim();
    const cleanColKey = String(colKey).trim();

    const colMatch = cleanColKey.match(/^Q?(\d+)(?:\(([^)]+)\))?$/i);
    if (colMatch) {
      const qNum = colMatch[1];
      const subId = colMatch[2] ? colMatch[2].toLowerCase() : null;

      if (subId) {
        const regex = new RegExp(`^\\s*(?:Q|Question)?\\s*${qNum}\\s*\\(?${subId}\\)?(?:\\b|[\\s\\[\\:]|$)`, 'i');
        return regex.test(cleanHeader);
      } else {
        const regex = new RegExp(`^\\s*(?:Q|Question)?\\s*${qNum}(?:\\s*\\[|\\s*\\:|\\s*\\-|$|\\s+(?![a-zA-Z]\\b))`, 'i');
        if (regex.test(cleanHeader)) {
          if (!/^\s*(?:Q|Question)?\s*\d+\s*\([a-zA-Z0-9]{1,2}\)/i.test(cleanHeader)) {
            return true;
          }
        }
        return false;
      }
    }

    return cleanHeader.toLowerCase() === cleanColKey.toLowerCase();
  };

  // Map each question column by matching header or sequential order
  const colIndexMap: Map<number, OfflineGradingColumn> = new Map();
  const claimedHeaders = new Set<number>([nameColIdx, classColIdx, candNumColIdx]);

  columns.forEach((col, cIdx) => {
    let matchedHeaderIdx = -1;

    // Pass 1: Match against unclaimed header cells using exact pattern boundary
    for (let idx = 0; idx < headerRow.length; idx++) {
      if (claimedHeaders.has(idx)) continue;
      if (matchHeaderToColumn(headerRow[idx], col.columnKey)) {
        matchedHeaderIdx = idx;
        break;
      }
    }

    // Pass 2: Sequential fallback if column header wasn't uniquely identified
    if (matchedHeaderIdx === -1) {
      const fallbackIdx = 3 + cIdx;
      if (!claimedHeaders.has(fallbackIdx) && (fallbackIdx < headerRow.length || rawRows.some((r) => r[fallbackIdx] !== undefined))) {
        matchedHeaderIdx = fallbackIdx;
      }
    }

    if (matchedHeaderIdx !== -1) {
      claimedHeaders.add(matchedHeaderIdx);
      colIndexMap.set(matchedHeaderIdx, col);
    }
  });

  // Extract student data rows
  const parsedRows: RawOfflineStudentRow[] = [];

  for (let r = headerRowIndex + 1; r < rawRows.length; r++) {
    const row = rawRows[r];
    if (!row || row.length === 0) continue;

    const studentName = String(row[nameColIdx] || '').trim();
    const studentClass = String(row[classColIdx] || '').trim();
    const candidateNumber = String(row[candNumColIdx] || '').trim();

    // Skip reference key row or empty rows
    if (
      !studentName ||
      /\[official|key|reference|max|instructions/i.test(studentName) ||
      (studentName.length < 2 && !row.slice(3).some((c) => String(c).trim().length > 0))
    ) {
      continue;
    }

    const answers: Record<string, string | number> = {};

    colIndexMap.forEach((col, cellIdx) => {
      const val = row[cellIdx];
      answers[col.id] = val !== undefined && val !== null ? String(val).trim() : '';
    });

    parsedRows.push({
      rowNumber: r + 1,
      studentName,
      studentClass: studentClass || 'General',
      candidateNumber: candidateNumber || '-',
      answers,
    });
  }

  return {
    rows: parsedRows,
    columns,
  };
}

// ─── 5. Auto-Grade Student Submissions ──────────────────────────────────────────

export async function gradeOfflineSubmissions(
  parsedRows: RawOfflineStudentRow[],
  columns: OfflineGradingColumn[],
  quizTitle: string,
  subject: string,
  options?: {
    useAiForDescriptive?: boolean;
    onProgress?: (current: number, total: number) => void;
  }
): Promise<StudentSubmission[]> {
  const totalTestMarks = columns.reduce((s, c) => s + c.maxMarks, 0);
  const submissions: StudentSubmission[] = [];

  for (let idx = 0; idx < parsedRows.length; idx++) {
    const row = parsedRows[idx];
    if (options?.onProgress) {
      options.onProgress(idx + 1, parsedRows.length);
    }

    let earnedTotal = 0;
    const questionResults: QuestionSubmissionResult[] = [];
    const topicBreakdown: Record<string, { totalMarks: number; earnedMarks: number; percentage: number }> = {};

    // Evaluate each column item
    for (let cIdx = 0; cIdx < columns.length; cIdx++) {
      const col = columns[cIdx];
      const rawAns = row.answers[col.id] ?? '';
      const ansStr = String(rawAns).trim();
      const topic = col.topic || 'General';

      if (!topicBreakdown[topic]) {
        topicBreakdown[topic] = { totalMarks: 0, earnedMarks: 0, percentage: 0 };
      }
      topicBreakdown[topic].totalMarks += col.maxMarks;

      let earnedMarks = 0;
      let isCorrect = false;
      let feedback = '';
      let gradingMethod: 'mcq' | 'deterministic' | 'ai_gemini' | 'rule_fallback' = 'deterministic';

      // ── Scenario A: Direct Marks Entry (Teacher entered numerical marks directly) ──
      const isPureNumber = ansStr !== '' && !isNaN(Number(ansStr)) && Number(ansStr) >= 0;
      const isNumberWithinMarks = isPureNumber && Number(ansStr) <= col.maxMarks;

      // If user typed a single number within marks range and NOT an MCQ choice
      const isExplicitMarkInput =
        isNumberWithinMarks &&
        col.questionStyle !== 'Multiple Choice' &&
        ansStr !== col.referenceAnswer &&
        !col.acceptableAnswers.includes(ansStr);

      const isMcqQuestion =
        col.questionStyle === 'Multiple Choice' ||
        (col.question.options && col.question.options.length >= 2) ||
        (col.subQuestion?.options && col.subQuestion.options.length >= 2) ||
        /^[A-Da-d]$/.test(col.referenceAnswer.trim());

      if (isExplicitMarkInput) {
        earnedMarks = Number(ansStr);
        isCorrect = earnedMarks === col.maxMarks;
        feedback = `Manual mark credited: ${earnedMarks}/${col.maxMarks}`;
      } else if (!ansStr) {
        // Empty response
        earnedMarks = 0;
        isCorrect = false;
        feedback = 'No answer provided.';
      } else if (isMcqQuestion) {
        // ── Scenario B: Multiple Choice Matching ──
        gradingMethod = 'mcq';
        const cleanStudentChoice = extractStudentMcqLetter(
          ansStr,
          col.question?.options || col.subQuestion?.options
        );
        const refChoice =
          col.referenceAnswer.toUpperCase().replace(/[^A-D]/g, '').charAt(0) ||
          col.referenceAnswer.toUpperCase();

        const isDirectAcceptable = col.acceptableAnswers.some(
          (acc) => acc.trim().toLowerCase() === ansStr.trim().toLowerCase()
        );

        if (
          (cleanStudentChoice && refChoice && cleanStudentChoice === refChoice) ||
          isDirectAcceptable
        ) {
          earnedMarks = col.maxMarks;
          isCorrect = true;
          feedback = `✓ Correct (${cleanStudentChoice || ansStr})`;
        } else {
          earnedMarks = 0;
          isCorrect = false;
          feedback = `Incorrect. Selected ${cleanStudentChoice || ansStr}, expected ${refChoice || col.referenceAnswer}`;
        }
      } else {
        // ── Scenario C: Deterministic Fast-Grading Engine (Formulas, Math, Keywords) ──
        const detResult = gradeDeterministicAnswer(ansStr, col.question, col.subIndex);

        if (detResult.isHandled) {
          earnedMarks = detResult.earnedMarks;
          isCorrect = detResult.isCorrect;
          feedback = detResult.feedback;
          gradingMethod = 'deterministic';
        } else if (options?.useAiForDescriptive) {
          // ── Scenario D: Optional Gemini AI Grading for Multi-Mark Explanations ──
          try {
            const aiResult = await evaluateAnswerWithGemini(col.question, col.subIndex, ansStr);
            earnedMarks = aiResult.earnedMarks;
            isCorrect = aiResult.isCorrect;
            feedback = aiResult.feedback;
            gradingMethod = aiResult.evaluatedBy === 'gemini' ? 'ai_gemini' : 'rule_fallback';
          } catch (err) {
            console.warn('AI evaluation error in offline grading, defaulting to partial review:', err);
            earnedMarks = 0;
            isCorrect = false;
            feedback = 'Requires teacher review (Descriptive answer)';
            gradingMethod = 'rule_fallback';
          }
        } else {
          // Unhandled descriptive answer without AI: prompt teacher review
          earnedMarks = 0;
          isCorrect = false;
          feedback = `Descriptive response recorded: "${ansStr}". Click to verify or score.`;
          gradingMethod = 'rule_fallback';
        }
      }

      earnedTotal += earnedMarks;
      topicBreakdown[topic].earnedMarks += earnedMarks;

      questionResults.push({
        questionId: col.id,
        questionNumber: cIdx + 1,
        topic,
        maxMarks: col.maxMarks,
        earnedMarks,
        isCorrect,
        studentAnswer: ansStr,
        correctAnswer: col.referenceAnswer,
        aiFeedback: feedback,
        gradingMethod,
      });
    }

    // Compute Topic Percentages
    Object.keys(topicBreakdown).forEach((t) => {
      const top = topicBreakdown[t];
      top.percentage = top.totalMarks > 0 ? Math.round((top.earnedMarks / top.totalMarks) * 100) : 0;
    });

    const percentage = totalTestMarks > 0 ? (earnedTotal / totalTestMarks) * 100 : 0;

    submissions.push({
      id: `sub_offline_${Date.now()}_${idx}_${Math.random().toString(36).substring(2, 6)}`,
      quizId: '', // assigned when published
      quizCode: '',
      quizTitle,
      subject,
      studentName: row.studentName,
      studentClass: row.studentClass,
      candidateNumber: row.candidateNumber,
      submittedAt: new Date().toISOString(),
      durationSeconds: 0, // offline test
      score: earnedTotal,
      totalMarks: totalTestMarks,
      percentage: Math.round(percentage * 10) / 10,
      violationsCount: 0,
      proctoringLogs: [],
      questionResults,
      topicBreakdown,
      teacherNotes: 'Offline paper exam auto-graded via Excel import',
    });
  }

  return submissions;
}

// ─── 6. Save Offline Exam to Central Gradebook ──────────────────────────────────

export async function saveOfflineExamToGradebook(
  quizTitle: string,
  subject: string,
  questions: Question[],
  submissions: StudentSubmission[],
  existingQuizCode?: string
): Promise<{ publishedQuiz: PublishedQuiz; submissions: StudentSubmission[] }> {
  const columns = getOfflineGradingColumns(questions);
  const totalMarks = columns.reduce((s, c) => s + c.maxMarks, 0);
  const code = existingQuizCode || `OFFLINE-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
  const quizId = `quiz_offline_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

  const publishedQuiz: PublishedQuiz = {
    id: quizId,
    testId: questions[0]?.id || `test_${Date.now()}`,
    title: quizTitle || `${subject || 'Chemistry'} Offline Paper Exam`,
    quizCode: code,
    subject: subject || 'Chemistry',
    totalMarks,
    questionCount: columns.length,
    questionIds: questions.map((q) => q.id),
    durationMinutes: Math.round(totalMarks * 1.25),
    isExamMode: true,
    securityEnabled: false,
    maxViolations: 0,
    showInstantSolutions: true,
    isActive: false, // completed offline exam
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    quizMode: 'exam',
  };

  // 1. Save the published quiz record locally and sync to cloud
  await savePublishedQuiz(publishedQuiz);

  // 2. Link submissions to this quiz
  const finalizedSubmissions = submissions.map((sub) => ({
    ...sub,
    quizId,
    quizCode: code,
    quizTitle: publishedQuiz.title,
    subject: publishedQuiz.subject || subject || 'Chemistry',
  }));

  // 3. Batch save submissions both locally and to Supabase cloud
  await saveBatchQuizSubmissionsCloud(finalizedSubmissions);

  return {
    publishedQuiz,
    submissions: finalizedSubmissions,
  };
}
