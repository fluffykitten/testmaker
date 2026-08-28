import type { Question } from '../types/database';
import type { ExamHeaderConfig } from './testBuilderService';
import { DEFAULT_SCHOOL_LOGO, DEFAULT_CAMBRIDGE_LOGO } from '../assets/logoConstants';

export interface CambridgeCoverDetails {
  isMcqOnly: boolean;
  isTheoryOnly: boolean;
  isCombined: boolean;
  subjectName: string;
  syllabusCode: string;
  paperCodeDisplay: string;
  paperName: string; // 'Multiple Choice' | 'Theory' | 'Multiple Choice & Theory'
  seriesYear: string;
  durationText: string;
  totalMarks: number;
  questionCount: number;
  questionCountWords: string;
  estimatedPages: number;
  isScience: boolean;
  instructions: string[];
  information: string[];
  additionalMaterials: string[];
  mandatoryNotices: string[];
  schoolLogoUrl?: string;
  cambridgeLogoUrl?: string;
  layoutTemplate?: 'cambridge' | 'standard';
  schoolName?: string;
  title?: string;
}

/**
 * Standard Cambridge IGCSE Subject Code Mapping
 */
const SUBJECT_CODE_MAP: Record<string, string> = {
  chemistry: '0620',
  physics: '0625',
  biology: '0610',
  math: '0580',
  mathematics: '0580',
  'combined science': '0653',
  'co-ordinated sciences': '0654',
  'computer science': '0478',
  economics: '0455',
  'business studies': '0450',
  geography: '0460',
  history: '0470',
  english: '0500',
  'first language english': '0500',
};

/**
 * Converts small numbers to English words (e.g. 40 -> "forty", 20 -> "twenty")
 */
export function numberToEnglishWords(num: number): string {
  const words: Record<number, string> = {
    1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five',
    6: 'six', 7: 'seven', 8: 'eight', 9: 'nine', 10: 'ten',
    11: 'eleven', 12: 'twelve', 13: 'thirteen', 14: 'fourteen', 15: 'fifteen',
    16: 'sixteen', 17: 'seventeen', 18: 'eighteen', 19: 'nineteen', 20: 'twenty',
    25: 'twenty-five', 30: 'thirty', 35: 'thirty-five', 40: 'forty',
    45: 'forty-five', 50: 'fifty', 60: 'sixty', 70: 'seventy', 80: 'eighty',
  };
  return words[num] || String(num);
}

/**
 * Formats duration in minutes to Cambridge format (e.g. 75 -> "1 hour 15 minutes", 45 -> "45 minutes")
 */
export function formatCambridgeDuration(durationMinutes: number): string {
  const mins = durationMinutes || 45;
  if (mins < 60) return `${mins} minutes`;
  const hours = Math.floor(mins / 60);
  const remainingMins = mins % 60;
  if (remainingMins === 0) {
    return hours === 1 ? '1 hour' : `${hours} hours`;
  }
  return `${hours} hour${hours > 1 ? 's' : ''} ${remainingMins} minutes`;
}

/**
 * Resolves standard 4-digit syllabus code from subject name or explicit code
 */
export function resolveSyllabusCode(subjectName: string, explicitCode?: string): string {
  if (explicitCode && explicitCode.trim()) {
    const cleaned = explicitCode.trim().split('/')[0].trim();
    if (/^\d{4}$/.test(cleaned)) return cleaned;
    return cleaned;
  }

  const normalized = (subjectName || '').toLowerCase().trim();
  for (const [key, code] of Object.entries(SUBJECT_CODE_MAP)) {
    if (normalized.includes(key)) return code;
  }
  return '0620';
}

/**
 * Extracts and prepares all details needed for Cambridge cover page
 */
export function getCambridgeCoverDetails(
  headerConfig: ExamHeaderConfig,
  questions: Question[]
): CambridgeCoverDetails {
  const hasMcq = questions.some(
    (q) => q.question_style === 'Multiple Choice' || (Array.isArray(q.options) && q.options.length > 0)
  );
  const hasTheory = questions.some(
    (q) => q.question_style !== 'Multiple Choice' && (!q.options || q.options.length === 0)
  );

  const isMcqOnly = hasMcq && !hasTheory;
  const isTheoryOnly = !hasMcq && hasTheory;
  const isCombined = (hasMcq && hasTheory) || (!hasMcq && !hasTheory);

  const totalMarks = questions.reduce((sum, q) => sum + (q.marks || (isMcqOnly ? 1 : 0)), 0) || (isMcqOnly ? questions.length : 80);
  const questionCount = questions.length;
  const questionCountWords = numberToEnglishWords(questionCount);

  // Subject and code resolution
  const subjectName = (headerConfig.subject || 'CHEMISTRY').toUpperCase();
  const syllabusCode = resolveSyllabusCode(subjectName, headerConfig.subjectCode);

  let paperCodeDisplay = syllabusCode;
  if (headerConfig.subjectCode && headerConfig.subjectCode.includes('/')) {
    paperCodeDisplay = headerConfig.subjectCode.trim();
  } else if (isMcqOnly) {
    paperCodeDisplay = `${syllabusCode}/11`;
  } else if (isTheoryOnly) {
    paperCodeDisplay = `${syllabusCode}/31`;
  } else {
    paperCodeDisplay = `${syllabusCode}`;
  }

  // 5. Paper name: just write out "Multiple Choice" or "Theory" or "Multiple Choice & Theory"
  let paperName = 'Theory';
  if (isMcqOnly) {
    paperName = 'Multiple Choice';
  } else if (isCombined) {
    paperName = 'Multiple Choice & Theory';
  } else {
    paperName = 'Theory';
  }

  // 1. Year the test is generated (e.g. 2026)
  const currentYear = new Date().getFullYear();
  const seriesYear = headerConfig.examDate ? String(headerConfig.examDate) : String(currentYear);

  const durationText = formatCambridgeDuration(headerConfig.durationMinutes || (isMcqOnly ? 45 : 75));
  const isScience = /chem|phys|bio|sci/i.test(subjectName);
  const isChemistrySubject =
    /chem|0620|0971/i.test(subjectName) ||
    /chem|0620|0971/i.test(headerConfig.subject || '') ||
    headerConfig.subjectCode === '0620';
  const isSocialSubject =
    /geograph|history|sociolog|econom|business|social|humanit|global/i.test(subjectName) ||
    /geograph|history|sociolog|econom|business|social|humanit|global/i.test(headerConfig.subject || '') ||
    headerConfig.subjectCode === '0460';
  const hasInsert =
    isSocialSubject ||
    questions.some(
      (q) =>
        q.diagram_source === 'insert' ||
        Boolean(q.resource_ref) ||
        (q.sub_questions && q.sub_questions.some((sq) => sq.diagram_source === 'insert' || Boolean(sq.resource_ref)))
    );

  // Instructions & Information
  let instructions: string[] = [];
  let information: string[] = [];
  let mandatoryNotices: string[] = [];
  let additionalMaterials: string[] = [];

  const defaultMaterials = headerConfig.additionalMaterials
    ? headerConfig.additionalMaterials
    : hasInsert
    ? 'An Insert (enclosed)'
    : isChemistrySubject
    ? 'Periodic Table (enclosed)'
    : '';

  if (isMcqOnly) {
    mandatoryNotices = ['You must answer on the multiple choice answer sheet.'];
    additionalMaterials = [
      'Multiple choice answer sheet',
      'Soft clean eraser',
      'Soft pencil (type B or HB is recommended)',
    ];
    if (defaultMaterials) {
      additionalMaterials.push(defaultMaterials);
    }
    instructions = [
      `There are ${questionCountWords} questions on this paper. Answer all questions.`,
      'For each question there are four possible answers A, B, C and D. Choose the one you consider correct and record your choice in soft pencil on the multiple choice answer sheet.',
      'Follow the instructions on the multiple choice answer sheet.',
      'Write in soft pencil.',
      'Write your name, centre number and candidate number on the multiple choice answer sheet in the spaces provided unless this has been done for you.',
      'Do not use correction fluid.',
      'You may use a calculator.',
    ];
    information = [
      `The total mark for this paper is ${totalMarks}.`,
      'Each correct answer will score one mark.',
      'Any rough working should be done on this question paper.',
    ];
    if (isChemistrySubject) {
      information.push('The Periodic Table is printed in the question paper.');
    }
    if (hasInsert) {
      information.push('The Insert contains additional resources for some questions.');
    }
  } else if (isCombined) {
    // Both Multiple Choice and Theory
    mandatoryNotices = [
      'You must answer on the question paper.',
      defaultMaterials
        ? `Additional materials: ${defaultMaterials}`
        : 'No additional materials are needed.',
    ];
    instructions = [
      'Answer all questions.',
      'Use a black or dark blue pen. You may use an HB pencil for any diagrams, graphs, or multiple choice selections.',
      'Write your name, centre number and candidate number in the boxes at the top of the page.',
      'Write your answer to each question in the space provided.',
      'Do not use an erasable pen or correction fluid.',
      'You may use a calculator.',
      'You should show all your working and use appropriate units.',
    ];
    information = [
      `The total mark for this paper is ${totalMarks}.`,
      'The number of marks for each question or part question is shown in brackets [ ].',
    ];
    if (isChemistrySubject) {
      information.push('The Periodic Table is printed in the question paper.');
    }
    if (hasInsert) {
      information.push('The Insert contains additional resources for some questions.');
    }
  } else {
    // Theory only
    mandatoryNotices = [
      'You must answer on the question paper.',
      defaultMaterials
        ? `Additional materials: ${defaultMaterials}`
        : 'No additional materials are needed.',
    ];
    instructions = [
      'Answer all questions.',
      'Use a black or dark blue pen. You may use an HB pencil for any diagrams or graphs.',
      'Write your name, centre number and candidate number in the boxes at the top of the page.',
      'Write your answer to each question in the space provided.',
      'Do not use an erasable pen or correction fluid.',
      'You may use a calculator.',
      'You should show all your working and use appropriate units.',
    ];
    information = [
      `The total mark for this paper is ${totalMarks}.`,
      'The number of marks for each question or part question is shown in brackets [ ].',
    ];
    if (isChemistrySubject) {
      information.push('The Periodic Table is printed in the question paper.');
    }
    if (hasInsert) {
      information.push('The Insert contains additional resources for some questions.');
    }
  }

  // Estimate total pages including cover (Cover = 1 page)
  let pagesForQuestions = 1;
  if (isMcqOnly) {
    pagesForQuestions = Math.max(1, Math.ceil(questionCount / 5));
  } else if (isCombined) {
    pagesForQuestions = Math.max(1, Math.ceil(questionCount / 3));
  } else {
    // Theory: ~2 questions per page
    pagesForQuestions = Math.max(1, Math.ceil(questionCount / 2));
  }
  const estimatedPages = 1 + pagesForQuestions;

  return {
    isMcqOnly,
    isTheoryOnly,
    isCombined,
    subjectName,
    syllabusCode,
    paperCodeDisplay,
    paperName,
    seriesYear,
    durationText,
    totalMarks,
    questionCount,
    questionCountWords,
    estimatedPages,
    isScience,
    instructions,
    information,
    additionalMaterials,
    mandatoryNotices,
    layoutTemplate: headerConfig.layoutTemplate || 'cambridge',
    schoolName: headerConfig.schoolName,
    title: headerConfig.title,
  };
}

/**
 * Renders a clean, modern Standard School Assessment Cover Page HTML (Non-Cambridge)
 */
export function renderStandardCoverPageHtml(details: CambridgeCoverDetails): string {
  const schoolLogoSrc = details.schoolLogoUrl || DEFAULT_SCHOOL_LOGO;
  const schoolTitle = details.schoolName ? details.schoolName.toUpperCase() : 'ACADEMIC ASSESSMENT';
  const examTitle = details.title || `${details.subjectName} EXAMINATION`;

  return `
  <div class="cambridge-cover-page standard-school-cover" style="font-family: Arial, sans-serif;">
    <!-- School Header -->
    <div style="text-align: center; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 2px solid #0f172a;">
      <div style="display: flex; justify-content: center; align-items: center; gap: 16px; margin-bottom: 10px;">
        <img src="${schoolLogoSrc}" alt="School Logo" style="height: 54px; max-width: 220px; object-fit: contain; display: block;" />
      </div>
      <h1 style="font-size: 22px; font-weight: 800; color: #0f172a; margin: 0 0 6px; letter-spacing: 0.5px; text-transform: uppercase;">
        ${schoolTitle}
      </h1>
      <h2 style="font-size: 17px; font-weight: 700; color: #334155; margin: 0;">
        ${examTitle}
      </h2>
    </div>

    <!-- Student Details Box -->
    <div style="border: 1.5px solid #0f172a; border-radius: 6px; padding: 14px 18px; margin-bottom: 24px; background: #f8fafc;">
      <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 14px; margin-bottom: 12px;">
        <div style="display: flex; align-items: baseline;">
          <span style="font-size: 13px; font-weight: 700; color: #0f172a; min-width: 110px;">STUDENT NAME:</span>
          <div style="flex: 1; border-bottom: 1.5px solid #0f172a; height: 20px;"></div>
        </div>
        <div style="display: flex; align-items: baseline;">
          <span style="font-size: 13px; font-weight: 700; color: #0f172a; min-width: 80px;">CLASS / SEC:</span>
          <div style="flex: 1; border-bottom: 1.5px solid #0f172a; height: 20px;"></div>
        </div>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 14px;">
        <div style="display: flex; align-items: baseline;">
          <span style="font-size: 13px; font-weight: 700; color: #0f172a; min-width: 50px;">DATE:</span>
          <div style="flex: 1; border-bottom: 1.5px solid #0f172a; height: 20px;"></div>
        </div>
        <div style="display: flex; align-items: baseline;">
          <span style="font-size: 13px; font-weight: 700; color: #0f172a; min-width: 65px;">ROLL NO:</span>
          <div style="flex: 1; border-bottom: 1.5px solid #0f172a; height: 20px;"></div>
        </div>
        <div style="display: flex; align-items: baseline;">
          <span style="font-size: 13px; font-weight: 700; color: #0f172a; min-width: 70px;">TEACHER:</span>
          <div style="flex: 1; border-bottom: 1.5px solid #0f172a; height: 20px;"></div>
        </div>
      </div>
    </div>

    <!-- Exam Info Summary Bar -->
    <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; background: #0f172a; color: #fff; border-radius: 4px; margin-bottom: 24px; font-size: 13px; font-weight: 600;">
      <span><strong>Subject:</strong> ${details.subjectName}</span>
      <span><strong>Time Allowed:</strong> ${details.durationText}</span>
      <span><strong>Maximum Marks:</strong> ${details.totalMarks}</span>
      <span><strong>Total Questions:</strong> ${details.questionCount}</span>
    </div>

    <!-- Instructions to Candidates -->
    <div style="margin-bottom: 24px;">
      <h3 style="font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; color: #0f172a; margin: 0 0 10px; border-bottom: 1px solid #cbd5e1; padding-bottom: 4px;">
        General Instructions
      </h3>
      <ul style="margin: 0; padding-left: 20px; font-size: 13px; line-height: 1.6; color: #1e293b;">
        <li>Write your name, class, and date clearly in the spaces provided at the top of this page.</li>
        <li>Answer <strong>all</strong> questions carefully.</li>
        <li>Write your answers neatly in black or dark blue ink. Soft pencil may be used for diagrams or graphs only.</li>
        ${details.isMcqOnly ? '<li>For multiple-choice questions, choose the ONE best answer and mark your response clearly.</li>' : ''}
        <li>Read each question thoroughly before answering.</li>
        <li>Do not open this assessment booklet until instructed to do so by the examiner.</li>
      </ul>
    </div>

    <!-- Score Grid Box (For Teacher / Grader) -->
    <div style="margin-top: 40px; padding: 14px; border: 1.5px dashed #94a3b8; border-radius: 6px; background: #fafafa; display: flex; justify-content: space-between; align-items: center;">
      <div>
        <span style="font-size: 12px; font-weight: 700; color: #475569; text-transform: uppercase;">FOR EXAMINER / TEACHER USE ONLY:</span>
        <div style="font-size: 11px; color: #64748b; margin-top: 2px;">Marks checked and verified against answer key</div>
      </div>
      <div style="display: flex; gap: 20px;">
        <div style="text-align: center; border: 1.5px solid #0f172a; border-radius: 4px; padding: 6px 16px; background: #fff; min-width: 90px;">
          <div style="font-size: 10px; font-weight: 700; color: #475569;">SCORE</div>
          <div style="font-size: 18px; font-weight: 800; color: #0f172a; margin-top: 2px;">&nbsp;&nbsp;&nbsp;&nbsp; / ${details.totalMarks}</div>
        </div>
        <div style="text-align: center; border: 1.5px solid #0f172a; border-radius: 4px; padding: 6px 16px; background: #fff; min-width: 90px;">
          <div style="font-size: 10px; font-weight: 700; color: #475569;">PERCENTAGE</div>
          <div style="font-size: 18px; font-weight: 800; color: #0f172a; margin-top: 2px;">&nbsp;&nbsp;&nbsp;&nbsp; %</div>
        </div>
      </div>
    </div>

    <!-- Page Break -->
    <div style="page-break-after: always; break-after: page;"></div>
  </div>
  `;
}

/**
 * Returns authentic SVG for Cambridge Assessment International Education shield crest & wordmark
 */
export function getCambridgeLogoSvg(): string {
  return `
<svg width="290" height="42" viewBox="0 0 290 42" fill="none" xmlns="http://www.w3.org/2000/svg" style="display: block;">
  <!-- Shield Icon -->
  <g transform="translate(0, 0)">
    <path d="M4 2H34V22C34 32 19 39 19 39C19 39 4 32 4 22V2Z" fill="#0f172a" stroke="#0f172a" stroke-width="1.5" stroke-linejoin="round"/>
    <!-- Quarter Cross -->
    <path d="M4 16H34M19 2V39" stroke="#ffffff" stroke-width="2"/>
    <!-- Four Quadrant Details -->
    <rect x="7" y="5" width="8" height="8" rx="1" fill="#ffffff" opacity="0.9"/>
    <rect x="22" y="5" width="8" height="8" rx="1" fill="#ffffff" opacity="0.9"/>
    <rect x="7" y="19" width="8" height="8" rx="1" fill="#ffffff" opacity="0.9"/>
    <rect x="22" y="19" width="8" height="8" rx="1" fill="#ffffff" opacity="0.9"/>
    <!-- Lion/Book Details -->
    <circle cx="11" cy="9" r="2" fill="#0f172a"/>
    <circle cx="26" cy="9" r="2" fill="#0f172a"/>
    <path d="M9 22H13V25H9Z" fill="#0f172a"/>
    <path d="M24 22H28V25H24Z" fill="#0f172a"/>
  </g>
  <!-- Text Wordmark -->
  <g fill="#0f172a" transform="translate(42, 6)">
    <text font-family="'Times New Roman', Georgia, serif" font-weight="bold" font-size="15" letter-spacing="0.2px" x="0" y="12">Cambridge Assessment</text>
    <text font-family="'Arial', 'Helvetica', sans-serif" font-weight="600" font-size="13.5" letter-spacing="-0.1px" x="0" y="27">International Education</text>
  </g>
</svg>
`;
}

/**
 * Renders the clean, authentic Cambridge IGCSE Cover Page HTML
 */
export function renderCambridgeCoverPageHtml(details: CambridgeCoverDetails): string {
  if (details.layoutTemplate === 'standard') {
    return renderStandardCoverPageHtml(details);
  }

  const showCandidateBox = !details.isMcqOnly;
  const schoolLogoSrc = details.schoolLogoUrl || DEFAULT_SCHOOL_LOGO;
  const cambridgeLogoSrc = details.cambridgeLogoUrl || DEFAULT_CAMBRIDGE_LOGO;

  return `
  <div class="cambridge-cover-page">
    <!-- Top Header Row: School Logo (Left) & Cambridge Assessment Logo (Right) -->
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; padding-bottom: 12px; border-bottom: 1.5px solid #111;">
      <!-- Left: School Logo (ICM) -->
      <div style="display: flex; align-items: center;">
        <img src="${schoolLogoSrc}" alt="School Logo" style="height: 48px; max-width: 220px; object-fit: contain; display: block;" />
      </div>

      <!-- Right: Cambridge Logo -->
      <div style="display: flex; align-items: center; justify-content: flex-end;">
        <img src="${cambridgeLogoSrc}" alt="Cambridge International School" style="height: 46px; max-width: 260px; object-fit: contain; display: block;" />
      </div>
    </div>

    <!-- Series Main Title -->
    <div style="margin-bottom: 22px; padding-left: 2px;">
      <h1 style="font-family: 'Arial', sans-serif; font-size: 26px; font-weight: 800; margin: 0; color: #000; letter-spacing: -0.5px;">
        Cambridge IGCSE<sup style="font-size: 14px; font-weight: normal;">™</sup>
      </h1>
    </div>

    <!-- Candidate Boxes (Theory or Combined) -->
    ${
      showCandidateBox
        ? `
      <div style="margin-bottom: 26px;">
        <!-- Candidate Name Row -->
        <div style="display: flex; align-items: center; margin-bottom: 12px;">
          <span style="font-family: 'Arial', sans-serif; font-size: 13px; font-weight: bold; width: 140px; color: #111; line-height: 1.2;">
            CANDIDATE<br />NAME
          </span>
          <div style="flex: 1; height: 32px; border: 1.5px solid #111; background: #fff;"></div>
        </div>

        <!-- Centre Number & Candidate Number Row -->
        <div style="display: flex; align-items: center;">
          <span style="font-family: 'Arial', sans-serif; font-size: 13px; font-weight: bold; width: 140px; color: #111; line-height: 1.2;">
            CENTRE<br />NUMBER
          </span>
          <div style="display: inline-flex; border: 1.5px solid #111; height: 32px; margin-right: 32px;">
            <span style="width: 28px; border-right: 1.5px solid #111; display: inline-block;"></span>
            <span style="width: 28px; border-right: 1.5px solid #111; display: inline-block;"></span>
            <span style="width: 28px; border-right: 1.5px solid #111; display: inline-block;"></span>
            <span style="width: 28px; border-right: 1.5px solid #111; display: inline-block;"></span>
            <span style="width: 28px; display: inline-block;"></span>
          </div>

          <span style="font-family: 'Arial', sans-serif; font-size: 13px; font-weight: bold; width: 120px; color: #111; line-height: 1.2;">
            CANDIDATE<br />NUMBER
          </span>
          <div style="display: inline-flex; border: 1.5px solid #111; height: 32px;">
            <span style="width: 28px; border-right: 1.5px solid #111; display: inline-block;"></span>
            <span style="width: 28px; border-right: 1.5px solid #111; display: inline-block;"></span>
            <span style="width: 28px; border-right: 1.5px solid #111; display: inline-block;"></span>
            <span style="width: 28px; display: inline-block;"></span>
          </div>
        </div>
      </div>
      `
        : ''
    }

    <!-- Subject & Syllabus Details Block -->
    <div style="margin-bottom: 20px; font-family: 'Arial', sans-serif;">
      <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px;">
        <span style="font-size: 16px; font-weight: 800; color: #000; letter-spacing: 0.2px;">${details.subjectName}</span>
        <span style="font-size: 16px; font-weight: 800; color: #000;">${details.paperCodeDisplay}</span>
      </div>

      <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px;">
        <span style="font-size: 14px; font-weight: normal; color: #111;">${details.paperName}</span>
        <span style="font-size: 14px; font-weight: bold; color: #111;">${details.seriesYear}</span>
      </div>

      <div style="display: flex; justify-content: flex-end; margin-top: 2px;">
        <span style="font-size: 14px; font-weight: bold; color: #000;">${details.durationText}</span>
      </div>
    </div>

    <!-- Mandatory Answering Notice -->
    <div style="font-family: 'Arial', sans-serif; font-size: 13px; color: #111; margin-bottom: 14px; line-height: 1.5;">
      ${details.mandatoryNotices.map((n) => `<div>${n}</div>`).join('')}
      ${
        details.isMcqOnly && details.additionalMaterials.length > 0
          ? `
        <div style="display: flex; margin-top: 8px;">
          <span style="min-width: 100px;">You will need:</span>
          <div>
            ${details.additionalMaterials.map((m) => `<div>${m}</div>`).join('')}
          </div>
        </div>
        `
          : ''
      }
    </div>

    <!-- Divider Line -->
    <hr style="border: none; border-top: 1.5px solid #111; margin: 16px 0 14px 0;" />

    <!-- INSTRUCTIONS Section -->
    <div style="font-family: 'Arial', sans-serif; margin-bottom: 18px;">
      <div style="font-size: 13.5px; font-weight: 800; color: #000; margin-bottom: 8px; letter-spacing: 0.2px;">
        INSTRUCTIONS
      </div>
      <ul style="margin: 0; padding-left: 20px; font-size: 12.5px; line-height: 1.65; color: #111;">
        ${details.instructions.map((inst) => `<li style="margin-bottom: 3px;">${inst}</li>`).join('')}
      </ul>
    </div>

    <!-- INFORMATION Section -->
    <div style="font-family: 'Arial', sans-serif; margin-bottom: 24px;">
      <div style="font-size: 13.5px; font-weight: 800; color: #000; margin-bottom: 8px; letter-spacing: 0.2px;">
        INFORMATION
      </div>
      <ul style="margin: 0; padding-left: 20px; font-size: 12.5px; line-height: 1.65; color: #111;">
        ${details.information.map((info) => `<li style="margin-bottom: 3px;">${info}</li>`).join('')}
      </ul>
    </div>

    <!-- Bottom Page Count Notice -->
    <div style="margin-top: auto; padding-top: 20px;">
      <hr style="border: none; border-top: 1.5px solid #111; margin-bottom: 8px;" />
      <div style="text-align: center; font-family: 'Arial', sans-serif; font-size: 12px; color: #111; margin-bottom: 12px;">
        This document has <strong id="cambridge-page-count">${details.estimatedPages}</strong> pages. Any blank pages are indicated.
      </div>

      <!-- Bottom Turn Over -->
      <div style="display: flex; justify-content: flex-end; align-items: baseline; font-family: 'Arial', sans-serif; font-size: 13px; font-weight: bold; color: #111;">
        <div>[Turn over</div>
      </div>
    </div>

    <!-- Bottom L-Shaped Alignment Marks -->
    <div style="position: absolute; bottom: 8px; left: 0; width: 24px; height: 24px; border-left: 3px solid #000; border-bottom: 3px solid #000;"></div>
    <div style="position: absolute; bottom: 8px; right: 0; width: 24px; height: 24px; border-right: 3px solid #000; border-bottom: 3px solid #000;"></div>
  </div>

  <!-- Page Break to start Question 1 on Page 2 -->
  <div style="page-break-after: always; break-after: page;"></div>
  `;
}

/**
 * Renders an authentic Cambridge / Standard Multiple Choice Bubble Answer Sheet HTML
 */
export function renderMcqAnswerSheetHtml(
  headerConfig: ExamHeaderConfig,
  questions: Question[],
  options: { schoolLogoUrl?: string; cambridgeLogoUrl?: string } = {}
): string {
  const details = getCambridgeCoverDetails(headerConfig, questions);
  const schoolLogoSrc = options.schoolLogoUrl || details.schoolLogoUrl || DEFAULT_SCHOOL_LOGO;
  const cambridgeLogoSrc = options.cambridgeLogoUrl || details.cambridgeLogoUrl || DEFAULT_CAMBRIDGE_LOGO;

  const totalQuestions = questions.length || 40;
  const numColumns = totalQuestions > 30 ? 4 : totalQuestions > 15 ? 3 : 2;
  const questionsPerColumn = Math.ceil(totalQuestions / numColumns);

  // Build column arrays
  const columns: number[][] = [];
  for (let c = 0; c < numColumns; c++) {
    const col: number[] = [];
    for (let r = 0; r < questionsPerColumn; r++) {
      const qNum = c * questionsPerColumn + r + 1;
      if (qNum <= totalQuestions) {
        col.push(qNum);
      }
    }
    if (col.length > 0) columns.push(col);
  }

  return `
  <div class="mcq-answer-sheet-page" style="page-break-inside: avoid; break-inside: avoid; font-family: 'Arial', sans-serif; color: #111; max-width: 800px; margin: 0 auto; padding: 10px;">
    <!-- Top 2-Logo Header -->
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1.5px solid #111;">
      <img src="${schoolLogoSrc}" alt="School Logo" style="height: 42px; max-width: 180px; object-fit: contain;" />
      <div style="text-align: center;">
        <h2 style="margin: 0; font-size: 16px; font-weight: 800; letter-spacing: 0.5px; text-transform: uppercase;">Multiple Choice Answer Sheet</h2>
        <div style="font-size: 12px; color: #333; margin-top: 2px;">${details.subjectName} • ${details.paperCodeDisplay} • ${details.seriesYear}</div>
      </div>
      <img src="${cambridgeLogoSrc}" alt="Cambridge Logo" style="height: 40px; max-width: 200px; object-fit: contain;" />
    </div>

    <!-- Candidate Identification Grid -->
    <div style="border: 1.5px solid #111; padding: 8px 12px; margin-bottom: 14px; font-size: 12px; background: #fafafa;">
      <div style="display: flex; align-items: center; margin-bottom: 8px;">
        <span style="font-weight: bold; width: 130px;">CANDIDATE NAME:</span>
        <div style="flex: 1; border-bottom: 1px solid #333; height: 18px;"></div>
      </div>

      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
        <div style="display: flex; align-items: center;">
          <span style="font-weight: bold; margin-right: 6px;">CENTRE NO:</span>
          <div style="display: inline-flex; border: 1.5px solid #111; height: 24px;">
            <span style="width: 22px; border-right: 1.5px solid #111; display: inline-block;"></span>
            <span style="width: 22px; border-right: 1.5px solid #111; display: inline-block;"></span>
            <span style="width: 22px; border-right: 1.5px solid #111; display: inline-block;"></span>
            <span style="width: 22px; border-right: 1.5px solid #111; display: inline-block;"></span>
            <span style="width: 22px; display: inline-block;"></span>
          </div>
        </div>

        <div style="display: flex; align-items: center;">
          <span style="font-weight: bold; margin-right: 6px;">CANDIDATE NO:</span>
          <div style="display: inline-flex; border: 1.5px solid #111; height: 24px;">
            <span style="width: 22px; border-right: 1.5px solid #111; display: inline-block;"></span>
            <span style="width: 22px; border-right: 1.5px solid #111; display: inline-block;"></span>
            <span style="width: 22px; border-right: 1.5px solid #111; display: inline-block;"></span>
            <span style="width: 22px; display: inline-block;"></span>
          </div>
        </div>

        <div style="display: flex; align-items: center;">
          <span style="font-weight: bold; margin-right: 6px;">CLASS / DATE:</span>
          <div style="border-bottom: 1px solid #333; width: 110px; height: 18px;"></div>
        </div>
      </div>
    </div>

    <!-- Shading Instructions Box -->
    <div style="border: 1px solid #cbd5e1; background: #f8fafc; padding: 6px 12px; margin-bottom: 16px; font-size: 11px; display: flex; justify-content: space-between; align-items: center; border-radius: 4px;">
      <div>
        <strong>INSTRUCTIONS:</strong> Use a soft pencil (B or HB). Shade <strong>ONE</strong> letter clearly for each question. Rub out any answer you wish to change.
      </div>
      <div style="display: flex; align-items: center; gap: 4px; font-weight: bold; font-size: 11px; margin-left: 12px;">
        <span>Example:</span>
        <span style="border: 1px solid #333; border-radius: 50%; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; font-size: 9px;">A</span>
        <span style="border: 1px solid #333; border-radius: 50%; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; font-size: 9px;">B</span>
        <span style="background: #111; color: #fff; border-radius: 50%; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; font-size: 9px;">C</span>
        <span style="border: 1px solid #333; border-radius: 50%; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; font-size: 9px;">D</span>
      </div>
    </div>

    <!-- Multiple Choice Grid Table -->
    <div style="display: flex; gap: 16px; justify-content: space-between; margin-bottom: 18px;">
      ${columns
        .map(
          (col) => `
        <div style="flex: 1; border: 1.5px solid #334155; border-radius: 4px; overflow: hidden; background: #fff;">
          <div style="background: #e2e8f0; font-size: 11px; font-weight: bold; padding: 4px 6px; text-align: center; border-bottom: 1px solid #cbd5e1;">
            Q &nbsp;&nbsp;&nbsp;&nbsp; A &nbsp;&nbsp; B &nbsp;&nbsp; C &nbsp;&nbsp; D
          </div>
          <div style="padding: 4px 6px;">
            ${col
              .map(
                (qNum) => `
              <div style="display: flex; align-items: center; justify-content: space-between; padding: 3px 0; border-bottom: 1px dotted #e2e8f0; font-size: 12px;">
                <span style="font-weight: bold; width: 22px; text-align: right; margin-right: 8px;">${qNum < 10 ? '0' + qNum : qNum}</span>
                <div style="display: flex; gap: 6px;">
                  <span style="width: 18px; height: 18px; border: 1.2px solid #1e293b; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: bold;">A</span>
                  <span style="width: 18px; height: 18px; border: 1.2px solid #1e293b; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: bold;">B</span>
                  <span style="width: 18px; height: 18px; border: 1.2px solid #1e293b; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: bold;">C</span>
                  <span style="width: 18px; height: 18px; border: 1.2px solid #1e293b; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: bold;">D</span>
                </div>
              </div>
            `
              )
              .join('')}
          </div>
        </div>
      `
        )
        .join('')}
    </div>

    <!-- Examiner Scoring Grid -->
    <div style="display: flex; justify-content: space-between; align-items: center; border: 1.5px solid #111; background: #f8fafc; padding: 8px 14px; font-size: 12px;">
      <div>
        <strong>FOR EXAMINER USE ONLY</strong>
      </div>
      <div style="display: flex; gap: 20px;">
        <div>Raw Score: <strong>______ / ${details.totalMarks}</strong></div>
        <div>Percentage: <strong>______ %</strong></div>
        <div>Grade: <strong>[ &nbsp;&nbsp;&nbsp;&nbsp; ]</strong></div>
      </div>
    </div>
  </div>
  `;
}

