// ─── Google Forms Export Types & Interfaces ───────────────────────────────────

export const FORMS_BODY_SCOPE = 'https://www.googleapis.com/auth/forms.body';
export const FORMS_API_CONSOLE_URL = 'https://console.cloud.google.com/apis/library/forms.googleapis.com';

export type FormItemType = 'RADIO' | 'CHECKBOX' | 'PARAGRAPH' | 'SHORT_ANSWER' | 'GRID';

export interface FormFlattenedItem {
  id: string;
  title: string;
  description?: string;
  pointValue: number;
  type: FormItemType;
  options?: string[];
  correctOptionIndices?: number[];
  correctAnswers?: string[];
  feedbackRight?: string;
  feedbackWrong?: string;
  imageUrl?: string | null;
  imageBase64?: string | null;
  altText?: string;
  /** Topic or section grouping key if available */
  topic?: string;
  /** Indicates if this item is a Cambridge subquestion */
  isSubQuestion?: boolean;
  /** Rows for Multiple Choice Grid items */
  gridRows?: string[];
  /** Column headers/options for Multiple Choice Grid items */
  gridColumns?: string[];
  /** Map of row title -> correct column header */
  gridRowCorrectAnswers?: Record<string, string>;
}

export interface GoogleFormResult {
  formId: string;
  editUrl: string;
  responderUrl: string;
  title: string;
  totalQuestions: number;
  totalMarks: number;
  mcqCount: number;
}

export interface GoogleFormsProgress {
  stage: 'auth' | 'creating' | 'populating' | 'done' | 'error';
  currentChunk?: number;
  totalChunks?: number;
  completedItems?: number;
  totalItems?: number;
  message: string;
}

export type SectionBreakMode = 'none' | 'by_question' | 'by_style' | 'chunk_10';

export interface GoogleFormsExportOptions {
  sectionBreakMode?: SectionBreakMode;
  shuffleOptions?: boolean;
  shuffleQuestions?: boolean;
  isRequired?: boolean;
  diagramMode?: 'cdn' | 'base64';
  signal?: AbortSignal;
}
