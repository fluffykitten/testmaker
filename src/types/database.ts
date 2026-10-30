// ─── Database Type Definitions ─────────────────────────────────────────────────
// Mirrors the Supabase PostgreSQL schema for full type safety across the app.

// ─── Enums & Union Types ───────────────────────────────────────────────────────

export type QuestionDifficulty = 'Easy' | 'Medium' | 'Hard';

export type CognitiveLevel = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6';

export interface CognitiveLevelMeta {
  level: CognitiveLevel;
  category: string;
  actionVerbs: string[];
  description: string;
}

export const COGNITIVE_LEVEL_META: Record<CognitiveLevel, CognitiveLevelMeta> = {
  C1: {
    level: 'C1',
    category: 'Remembering',
    actionVerbs: ['State', 'Define', 'Name', 'List', 'Identify', 'Recall'],
    description: 'Recall facts and basic concepts',
  },
  C2: {
    level: 'C2',
    category: 'Understanding',
    actionVerbs: ['Describe', 'Explain', 'Classify', 'Summarize', 'Outline'],
    description: 'Explain ideas, trends, or concepts',
  },
  C3: {
    level: 'C3',
    category: 'Applying',
    actionVerbs: ['Calculate', 'Determine', 'Construct', 'Solve', 'Use', 'Demonstrate'],
    description: 'Use information in concrete situations or calculations',
  },
  C4: {
    level: 'C4',
    category: 'Analyzing',
    actionVerbs: ['Deduce', 'Compare', 'Contrast', 'Distinguish', 'Examine', 'Interpret'],
    description: 'Draw connections among ideas, data, or experimental curves',
  },
  C5: {
    level: 'C5',
    category: 'Evaluating',
    actionVerbs: ['Evaluate', 'Justify', 'Assess', 'Criticize', 'Argue', 'Appraise'],
    description: 'Justify a stance, evaluate errors, or assess methods',
  },
  C6: {
    level: 'C6',
    category: 'Creating',
    actionVerbs: ['Design', 'Plan', 'Formulate', 'Devise', 'Propose', 'Synthesize'],
    description: 'Produce new or original work, plan investigations, or design apparatus',
  },
};

export type QuestionStyle =
  | 'Structured'
  | 'Multiple Choice'
  | 'Multiple Select'
  | 'Calculation'
  | 'Short Answer'
  | 'Fill in the Blank';

/**
 * Normalizes any question style string to a canonical QuestionStyle enum value.
 * Handles snake_case ('multiple_choice'), lowercase ('multiple choice'), abbreviations ('mcq'),
 * and infers 'Multiple Choice' if 2 or more options are provided even if style was unassigned or 'Structured'.
 */
export function normalizeQuestionStyle(
  style?: string | null,
  options?: unknown[] | null
): QuestionStyle {
  const s = (style || '').trim().toLowerCase().replace(/[_\-\s]+/g, ' ');

  if (s === 'multiple select' || s === 'multi select' || s === 'multiselect') {
    return 'Multiple Select';
  }
  if (s === 'multiple choice' || s === 'mcq' || s === 'choice' || s === 'multiplechoice') {
    return 'Multiple Choice';
  }
  if (s === 'calculation' || s === 'calc') {
    return 'Calculation';
  }
  if (s === 'short answer' || s === 'shortanswer') {
    return 'Short Answer';
  }
  if (s === 'fill in the blank' || s === 'fill in blank' || s === 'cloze') {
    return 'Fill in the Blank';
  }

  // If options array has at least 2 valid items and style wasn't an explicit non-MCQ type (calc/short answer/fill in blank),
  // then it is an MCQ.
  if (Array.isArray(options) && options.filter(Boolean).length >= 2) {
    return 'Multiple Choice';
  }

  if (s === 'structured') {
    return 'Structured';
  }

  return 'Structured';
}

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

export interface ExtractedPassage {
  id: string;                  // e.g. "Text 1", "Passage A", "Teks 2"
  heading?: string;            // e.g. "Text 1: Exploring Komodo National Park"
  body: string;               // Full text of the reading passage
  page_number?: number;
  target_questions?: string[]; // e.g. ["1", "2", "3", "4"]
}

export interface ExamDataTableCell {
  value: string;
  is_blank?: boolean;        // True if this cell represents an empty answer box to be completed
  expected_answer?: string;  // Correct answer for automated grading / verification
}

export interface ExamDataTable {
  id?: string;               // e.g. "Table 1.1", "Table 2"
  title?: string;            // e.g. "Physical properties of elements at r.t.p."
  headers: string[];         // Column headers
  rows: (string | ExamDataTableCell)[][]; // Rows with text or interactive blank cells
}

export interface SubQuestion {
  sub_id: string;           // e.g. "(a)", "(b)(i)"
  question_text: string;    // LaTeX-enriched text
  marks: number;
  has_diagram?: boolean;    // Sub-question has diagram/figure
  diagram_url?: string | null; // Optional sub-question diagram image URL
  svg_content?: string | null; // AI-generated parametric SVG vector graphic
  ai_diagram_prompt?: string | null; // Prompt for AI diagram generation
  diagram_type?: 'apparatus' | 'graph' | 'choice_grid' | 'circuit' | 'photo' | null; // Classification of diagram
  has_embedded_values?: boolean; // True if visual displays numbers/labels that depend on problem variables
  depends_on_sub_ids?: string[]; // IDs of preceding sub-questions this part relies upon (e.g. ["(a)", "(b)(i)"])
  diagram_source?: 'qp' | 'insert' | null; // Indicates whether the visual is from QP or Insert Booklet
  resource_ref?: string | null; // e.g. "Fig. 1.2", "Figs. 2.2, 2.3 and 2.4", "Photograph A"
  page_number?: number | null;  // QP page number if diagram is from Question Paper
  insert_page_number?: number | null; // Insert booklet page number if from Insert Booklet
  bounding_box?: [number, number, number, number] | any | null; // [ymin, xmin, ymax, xmax] 0-1000
  options?: string[] | null;// Optional choices for tick box / multiple-choice sub-questions
  cognitive_level?: CognitiveLevel | null; // Bloom's Taxonomy cognitive level (C1-C6)
  mark_scheme?: string;     // Simplified single-line scheme for sub-parts
  guidance?: string;        // Sub-question specific teacher guidance/examiner tip
  common_misconceptions?: string[]; // Sub-question specific common student errors
  audio_url?: string | null; // Optional audio URL for this sub-part
  audio_metadata?: AudioMetadata | null; // Audio configuration & transcript
  data_tables?: ExamDataTable[]; // Structured tabular data for this sub-question
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
  cognitive_level?: CognitiveLevel | null; // Bloom's Taxonomy cognitive level (C1-C6)
  source_pdf_url?: string | null;          // Permanent public URL of the source Question Paper PDF
  page_number?: number | null;             // 1-indexed page in the QP PDF where this question appears
  marks: number;
  diagram_url: string | null;       // Supabase Storage public URL
  svg_content?: string | null;      // AI-generated parametric SVG vector graphic
  ai_diagram_prompt?: string | null;// Prompt for AI diagram generation (Workers AI)
  diagram_type?: 'apparatus' | 'graph' | 'choice_grid' | 'circuit' | 'photo' | null;
  has_embedded_values?: boolean;
  diagram_source?: 'qp' | 'insert' | null; // Source document for diagram
  resource_ref?: string | null;     // Reference to Insert figure/photo (e.g. "Fig. 1.1")
  insert_page_number?: number | null;
  audio_url?: string | null;        // Supabase Storage audio public URL
  audio_metadata?: AudioMetadata | null; // Audio play limits, transcript, duration
  options?: string[] | null;        // Multiple choice options [A, B, C, D]
  sub_questions: SubQuestion[];     // JSONB array of nested parts
  mark_scheme: MarkScheme | null;   // JSONB marking structure
  data_tables?: ExamDataTable[];    // Structured tabular data
  scratchpad?: any;                 // AI mathematical & scientific derivation scratchpad
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

export interface TeacherPreferences {
  autoEnablePeriodicTable?: boolean;          // Auto-enable Cambridge Periodic Table drawer for exams
  defaultCalculator?: 'scientific' | 'basic'; // Default student calculator
  showOtherSubjects?: boolean;                // Toggle to show other subjects in test/question lists
  defaultExamDurationMinutes?: number;       // Default exam timer
}

export interface TeacherProfile {
  id: string;                                 // UUID
  name: string;                               // e.g. "Dr. Budi Santoso"
  title?: string | null;                      // e.g. "Dr.", "Mr.", "Ibu"
  subject: string;                            // e.g. "Chemistry"
  subject_code: string;                       // e.g. "0620"
  pin_hash?: string | null;                   // SHA-256 hashed 4-digit PIN (null if PIN-free)
  default_classes: string[];                  // e.g. ["10-A", "11-A"]
  preferences: TeacherPreferences;
  created_at: string;                         // ISO timestamp
  updated_at?: string;                        // ISO timestamp
}

// ─── Student Creative Mode Types ───────────────────────────────────────────────

export interface GameAvatarConfig {
  skin: string;
  eyes: 'normal' | 'curious' | 'focused' | 'starry' | 'winking' | 'goggles';
  hair: 'curly_brunette' | 'short_fade' | 'long_braids' | 'messy_scientist' | 'hijab_navy' | 'slick_back' | 'bald';
  outfit: 'lab_coat' | 'school_blazer' | 'hazmat_suit' | 'hoodie_emerald' | 'tweed_vest' | 'alchemist_robe';
  prop: 'erlenmeyer_flask' | 'test_tube_rack' | 'bunsen_burner' | 'molecule_ball' | 'periodic_chart' | 'gold_trophy';
  aura: 'none' | 'chem_bubbles' | 'sparkles' | 'electric_plasma' | 'flame_glow' | 'quantum_orbit';
}

export interface TopicMasteryRecord {
  correct: number;
  total: number;
  masteryPct: number;
  lastPracticed: string;
}

export interface GameMatchHistoryItem {
  matchId: string;
  quizTitle: string;
  subject: string;
  timestamp: number;
  score: number;
  accuracy: number;
  mode: 'classic' | 'team_battle' | 'raid_boss' | 'speed_blitz';
  missedTopics?: string[];
}

export interface GameProfile {
  id: string;
  student_id?: string | null;
  handle: string;
  real_name?: string | null;
  class: string;
  pin_hash: string;
  avatar: GameAvatarConfig;
  coins: number;
  xp: number;
  level: number;
  unlocked_items: string[];
  topic_mastery: Record<string, Record<string, TopicMasteryRecord>>; // subject -> topic -> record
  match_history: GameMatchHistoryItem[];
  created_at: string;
  updated_at?: string;
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
  cognitive_level?: CognitiveLevel | null;
  source_pdf_url?: string | null;
  topic: string;
  sub_topic: string | null;
  has_diagram: boolean;
  diagram_url?: string | null;
  svg_content?: string | null;
  diagram_type?: 'apparatus' | 'graph' | 'choice_grid' | 'circuit' | 'photo' | null;
  has_embedded_values?: boolean;
  diagram_source?: 'qp' | 'insert' | null;
  resource_ref?: string | null;
  insert_page_number?: number | null;
  bounding_box: [number, number, number, number] | any | null; // [ymin, xmin, ymax, xmax] 0-1000
  options: string[] | null;
  audio_url?: string | null;
  audio_metadata?: AudioMetadata | null;
  passage_ref?: string | null;
  sub_questions?: SubQuestion[];
  mark_scheme: MarkScheme | null;
  data_tables?: ExamDataTable[];
  scratchpad?: any;
}

export interface ExtractionResult {
  paper_metadata: PaperMetadata;
  questions: ExtractedQuestion[];
  insert_resources?: InsertResourceItem[];
  passages?: ExtractedPassage[];
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
