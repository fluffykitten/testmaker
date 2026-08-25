// ─── Database Type Definitions ─────────────────────────────────────────────────
// Mirrors the Supabase PostgreSQL schema for full type safety across the app.

// ─── Enums & Union Types ───────────────────────────────────────────────────────

export type QuestionDifficulty = 'Easy' | 'Medium' | 'Hard';

export type QuestionStyle =
  | 'Structured'
  | 'Multiple Choice'
  | 'Calculation'
  | 'Short Answer';

// ─── JSONB Sub-Structures ──────────────────────────────────────────────────────

export interface MarkScheme {
  marking_points: string[];
  acceptable_answers?: string[];
  guidance?: string[];               // Teacher / Examiner tips & alternate allowable methods
  common_misconceptions?: string[];   // Common student errors & conceptual traps
}

export interface SubQuestion {
  sub_id: string;           // e.g. "(a)", "(b)(i)"
  question_text: string;    // LaTeX-enriched text
  marks: number;
  options?: string[] | null;// Optional choices for tick box / multiple-choice sub-questions
  mark_scheme?: string;     // Simplified single-line scheme for sub-parts
  guidance?: string;        // Sub-question specific teacher guidance/examiner tip
  common_misconceptions?: string[]; // Sub-question specific common student errors
}

// ─── Table Interfaces ──────────────────────────────────────────────────────────

export interface Syllabus {
  id: string;               // UUID
  subject_name: string;
  subject_code: string;
  created_at: string;       // ISO 8601 timestamp
}

export interface Question {
  id: string;               // UUID
  syllabus_id: string;      // FK → syllabuses.id
  year: number;
  series: string | null;    // e.g. "May/June", "Oct/Nov"
  paper_number: number | null;
  question_number: string;  // e.g. "1(a)", "3(b)(ii)"
  parent_question_id: string | null; // e.g. "Q1" to group sub-parts
  question_text: string;    // LaTeX-enriched text
  question_style: QuestionStyle | null;
  topic: string;
  sub_topic: string | null;
  difficulty: QuestionDifficulty | null;
  marks: number;
  diagram_url: string | null;       // Supabase Storage public URL
  options?: string[] | null;        // Multiple choice options [A, B, C, D]
  sub_questions: SubQuestion[];     // JSONB array of nested parts
  mark_scheme: MarkScheme | null;   // JSONB marking structure
  created_at: string;
}

export interface CustomTest {
  id: string;               // UUID
  user_id?: string | null;  // FK → auth.users (null when auth is deferred)
  title: string;
  total_marks: number;
  question_ids: string[];   // UUID[]
  created_at: string;
  updated_at?: string;
  header_config?: any;
}

export interface AppConfig {
  key: string;              // Primary key (e.g. 'access_pin')
  value: string;
}

// ─── Extraction Pipeline Types ─────────────────────────────────────────────────

export interface PaperMetadata {
  subject: string;
  subject_code: string;
  year: number;
  series: string;
  paper_number: number;
}

export interface ExtractedQuestion {
  question_number: string;
  parent_question_id: string | null;
  page_number?: number;
  year?: number;
  series?: string;
  paper_number?: number;
  question_text: string;
  question_style: QuestionStyle;
  total_marks: number;
  estimated_difficulty: QuestionDifficulty;
  topic: string;
  sub_topic: string | null;
  has_diagram: boolean;
  bounding_box: [number, number, number, number] | any | null; // [ymin, xmin, ymax, xmax] 0-1000
  options: string[] | null;
  sub_questions?: SubQuestion[];
  mark_scheme: MarkScheme | null;
}

export interface ExtractionResult {
  paper_metadata: PaperMetadata;
  questions: ExtractedQuestion[];
}

// ─── Supabase Typed Client Helper ──────────────────────────────────────────────
// Use this with createClient<Database>() for end-to-end type inference.

export interface Database {
  public: {
    Tables: {
      syllabuses: {
        Row: Syllabus;
        Insert: Omit<Syllabus, 'id' | 'created_at'>;
        Update: Partial<Omit<Syllabus, 'id' | 'created_at'>>;
      };
      questions: {
        Row: Question;
        Insert: Omit<Question, 'id' | 'created_at'>;
        Update: Partial<Omit<Question, 'id' | 'created_at'>>;
      };
      custom_tests: {
        Row: CustomTest;
        Insert: Omit<CustomTest, 'id' | 'created_at'>;
        Update: Partial<Omit<CustomTest, 'id' | 'created_at'>>;
      };
      app_config: {
        Row: AppConfig;
        Insert: AppConfig;
        Update: Partial<AppConfig>;
      };
    };
  };
}
