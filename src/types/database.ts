// ─── Database Type Definitions ─────────────────────────────────────────────────
// Mirrors the Supabase PostgreSQL schema for full type safety across the app.

// ─── Enums & Union Types ───────────────────────────────────────────────────────

export type QuestionDifficulty = 'Easy' | 'Medium' | 'Hard';

export type QuestionStyle =
  | 'Structured'
  | 'Multiple Choice'
  | 'Multiple Select'
  | 'Calculation'
  | 'Short Answer'
  | 'Fill in the Blank';

// ─── JSONB Sub-Structures ──────────────────────────────────────────────────────

export interface MarkScheme {
  marking_points: string[];
  acceptable_answers?: string[];
  guidance?: string[];               // Teacher / Examiner tips & alternate allowable methods
  common_misconceptions?: string[];   // Common student errors & conceptual traps
}

export interface AudioMetadata {
  title?: string;              // e.g. "Track 1: Airport Conversation"
  transcript?: string;         // Full text transcript
  duration?: number;           // In seconds
  play_limit?: number | null;  // Max play count in formal exam (e.g. 2, or null for unlimited)
  voice?: string;              // TTS voice used if synthesized
  original_size?: number;      // Original file size in bytes
  compressed_size?: number;    // Final compressed size in bytes
}

export interface InsertResourceItem {
  id: string;               // e.g. "Fig. 1.1", "Photograph A", "Table 2.1"
  title: string;            // e.g. "Settlement map of Area X" or "Synoptic weather chart"
  page_number: number;
  diagram_url?: string | null;
  text_content?: string | null;
  target_questions?: string[]; // e.g. ["1(a)", "1(b)"]
}

export interface SubQuestion {
  sub_id: string;           // e.g. "(a)", "(b)(i)"
  question_text: string;    // LaTeX-enriched text
  marks: number;
  has_diagram?: boolean;    // Sub-question has diagram/figure
  diagram_url?: string | null; // Optional sub-question diagram image URL
  diagram_source?: 'qp' | 'insert' | null; // Indicates whether the visual is from QP or Insert Booklet
  resource_ref?: string | null; // e.g. "Fig. 1.2", "Figs. 2.2, 2.3 and 2.4", "Photograph A"
  page_number?: number | null;  // QP page number if diagram is from Question Paper
  insert_page_number?: number | null; // Insert booklet page number if from Insert Booklet
  bounding_box?: [number, number, number, number] | any | null; // [ymin, xmin, ymax, xmax] 0-1000
  options?: string[] | null;// Optional choices for tick box / multiple-choice sub-questions
  mark_scheme?: string;     // Simplified single-line scheme for sub-parts
  guidance?: string;        // Sub-question specific teacher guidance/examiner tip
  common_misconceptions?: string[]; // Sub-question specific common student errors
  audio_url?: string | null; // Optional audio URL for this sub-part
  audio_metadata?: AudioMetadata | null; // Audio configuration & transcript
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
  paper_number: string | number | null;
  question_number: string;  // e.g. "1(a)", "3(b)(ii)"
  question_number_numeric?: number | null; // Generated numeric value for natural sorting
  parent_question_id: string | null; // e.g. "Q1" to group sub-parts
  question_text: string;    // LaTeX-enriched text
  question_style: QuestionStyle | null;
  topic: string;
  sub_topic: string | null;
  difficulty: QuestionDifficulty | null;
  marks: number;
  diagram_url: string | null;       // Supabase Storage public URL
  diagram_source?: 'qp' | 'insert' | null; // Source document for diagram
  resource_ref?: string | null;     // Reference to Insert figure/photo (e.g. "Fig. 1.1")
  insert_page_number?: number | null;
  audio_url?: string | null;        // Supabase Storage audio public URL
  audio_metadata?: AudioMetadata | null; // Audio play limits, transcript, duration
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
  paper_number: string | number;
  has_insert_booklet?: boolean;
}

export interface ExtractedQuestion {
  question_number: string;
  parent_question_id: string | null;
  page_number?: number;
  year?: number;
  series?: string;
  paper_number?: string | number;
  question_text: string;
  question_style: QuestionStyle;
  total_marks: number;
  estimated_difficulty: QuestionDifficulty;
  topic: string;
  sub_topic: string | null;
  has_diagram: boolean;
  diagram_source?: 'qp' | 'insert' | null;
  resource_ref?: string | null;
  insert_page_number?: number | null;
  bounding_box: [number, number, number, number] | any | null; // [ymin, xmin, ymax, xmax] 0-1000
  options: string[] | null;
  audio_url?: string | null;
  audio_metadata?: AudioMetadata | null;
  sub_questions?: SubQuestion[];
  mark_scheme: MarkScheme | null;
}

export interface ExtractionResult {
  paper_metadata: PaperMetadata;
  questions: ExtractedQuestion[];
  insert_resources?: InsertResourceItem[];
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
