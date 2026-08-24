// ─── Export Templates Type Definitions ───────────────────────────────────────
// Configuration types and presets for Word (.docx) and PDF/Print exam layouts.

export type ExamLayoutTemplate =
  | 'cambridge_official'
  | 'school_worksheet'
  | 'separate_answer_booklet'
  | 'mark_scheme_pro';

export interface CandidateBoxFields {
  name: boolean;
  centreNumber: boolean;
  candidateNumber: boolean;
  date: boolean;
  classSection: boolean;
  scoreBox: boolean;
}

export interface ExportLayoutOptions {
  template: ExamLayoutTemplate;
  columns: 1 | 2;
  includeAnswerLines: boolean;
  linesPerMark: number;
  answerLineStyle: 'dotted' | 'solid';
  includeCandidateBox: boolean;
  candidateBoxFields: CandidateBoxFields;
  schoolName: string;
  schoolLogoUrl?: string;
  customInstructions?: string;
  showPageNumbers: boolean;
  showTurnOverNotice: boolean;
  includeMcqAnswerSheet?: boolean;
  includePeriodicTable?: boolean;
  includeInsertBooklet?: boolean;
}

export interface LayoutTemplateMeta {
  id: ExamLayoutTemplate;
  name: string;
  badge: string;
  icon: string;
  description: string;
  defaultColumns: 1 | 2;
  defaultAnswerLineStyle: 'dotted' | 'solid';
  recommendedFor: string;
}

export const EXAM_LAYOUT_TEMPLATES: LayoutTemplateMeta[] = [
  {
    id: 'cambridge_official',
    name: 'Cambridge / IGCSE Official',
    badge: 'Formal Exam',
    icon: '🏛️',
    description:
      'Authentic Cambridge Assessment International Education cover page that automatically adapts for Paper 1 & 2 (MCQ answer sheet instructions) and Paper 3 & 4 (Theory candidate boxes, written instructions, and mark rubrics).',
    defaultColumns: 1,
    defaultAnswerLineStyle: 'dotted',
    recommendedFor: 'Mock exams, end-of-term assessments, and board exam practice.',
  },
  {
    id: 'school_worksheet',
    name: 'Modern School Worksheet',
    badge: 'Classwork & Homework',
    icon: '🏫',
    description:
      'Clean header with School Name, Class/Section, score grid, and optional 2-Column layout to save paper when printing.',
    defaultColumns: 1,
    defaultAnswerLineStyle: 'solid',
    recommendedFor: 'Daily homework, quick quizzes, and printed revision packs.',
  },
  {
    id: 'separate_answer_booklet',
    name: 'Question Paper + Answer Booklet',
    badge: 'Paper Saving',
    icon: '📝',
    description:
      'Compact questions-only paper (no answer space) paired with a dedicated lined Answer Booklet for student responses.',
    defaultColumns: 1,
    defaultAnswerLineStyle: 'dotted',
    recommendedFor: 'High-volume printing, multi-page tests, and national exam simulations.',
  },
  {
    id: 'mark_scheme_pro',
    name: 'Comprehensive Mark Scheme',
    badge: 'Teacher Only',
    icon: '🔑',
    description:
      'Full teacher solution guide with step-by-step marking points, allowable alternatives, examiner tips, and common student errors.',
    defaultColumns: 1,
    defaultAnswerLineStyle: 'solid',
    recommendedFor: 'Grading, standardization, moderation, and model solution handouts.',
  },
];

export const DEFAULT_EXPORT_OPTIONS: ExportLayoutOptions = {
  template: 'cambridge_official',
  columns: 1,
  includeAnswerLines: true,
  linesPerMark: 2,
  answerLineStyle: 'dotted',
  includeCandidateBox: true,
  candidateBoxFields: {
    name: true,
    centreNumber: true,
    candidateNumber: true,
    date: true,
    classSection: true,
    scoreBox: true,
  },
  schoolName: '',
  customInstructions: '',
  showPageNumbers: true,
  showTurnOverNotice: true,
  includeMcqAnswerSheet: false,
};
