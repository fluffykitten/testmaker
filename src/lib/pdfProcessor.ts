// ─── PDF Processing Pipeline ───────────────────────────────────────────────────
// Orchestrates the full extraction flow:
//   Upload PDF → Gemini extraction → Local Diagram Cropping (Zero Storage) → Review
//   Confirm Save → Upload PDF & Diagrams to Storage → Supabase DB insertion

import { supabase } from './supabase';
import { extractQuestionsFromPdf, fileToBase64 } from './gemini';
import {
  cropDiagramsLocally,
  uploadDiagramsToStorage,
  revokeLocalDiagramUrls,
  type DiagramCropItem,
} from './diagramCropper';
import type { ExtractionResult, ExtractedQuestion } from '../types/database';

// ─── Pipeline State ────────────────────────────────────────────────────────────

export type PipelineStage =
  | 'idle'
  | 'uploading'
  | 'extracting'
  | 'cropping-diagrams'
  | 'reviewing'
  | 'saving'
  | 'complete'
  | 'error';

export interface PipelineState {
  stage: PipelineStage;
  message: string;
  progress: number; // 0-100
  result: ExtractionResult | null;
  error: string | null;
}



// ─── Step 2: Resolve or create syllabus ────────────────────────────────────────

async function resolveSyllabus(
  subjectName: string,
  subjectCode: string
): Promise<string> {
  // Check if syllabus already exists
  const { data: existing } = await supabase
    .from('syllabuses')
    .select('id')
    .eq('subject_code', subjectCode)
    .limit(1)
    .single() as { data: { id: string } | null };

  if (existing) return existing.id;

  // Create new syllabus
  const { data: created, error } = await supabase
    .from('syllabuses')
    .insert({ subject_name: subjectName, subject_code: subjectCode } as any)
    .select('id')
    .single() as { data: { id: string } | null; error: any };

  if (error || !created) {
    throw new Error(`Failed to create syllabus: ${error?.message}`);
  }

  return created.id;
}

// ─── Step 3: Save questions to database (Uploads storage files on confirm) ─────

export async function saveExtractedQuestions(
  result: ExtractionResult,
  diagramData: Map<string, DiagramCropItem>,
  _qpFile?: File | null,
  _msFile?: File | null,
  onProgress?: (status: string) => void
): Promise<number> {
  const { paper_metadata, questions } = result;

  // 1. Upload cropped diagram blobs to Supabase Storage (WebP compressed)
  let permanentDiagramUrls = new Map<string, string>();
  if (diagramData.size > 0) {
    permanentDiagramUrls = await uploadDiagramsToStorage(
      diagramData,
      {
        subject_code: paper_metadata.subject_code,
        year: paper_metadata.year,
        paper_number: paper_metadata.paper_number,
      },
      onProgress
    );
  }

  // 3. Resolve syllabus
  onProgress?.('Resolving syllabus…');
  const syllabusId = await resolveSyllabus(
    paper_metadata.subject,
    paper_metadata.subject_code
  );

  // 4. Insert questions with permanent Supabase public URLs
  onProgress?.(`Inserting ${questions.length} questions into database…`);

  const records = questions.map((q: ExtractedQuestion) => ({
    syllabus_id: syllabusId,
    year: q.year || paper_metadata.year,
    series: q.series || paper_metadata.series,
    paper_number: q.paper_number || paper_metadata.paper_number,
    question_number: q.question_number,
    parent_question_id: q.parent_question_id || null,
    question_text: q.question_text,
    question_style: q.question_style,
    topic: q.topic,
    sub_topic: q.sub_topic || null,
    difficulty: q.estimated_difficulty,
    marks: q.total_marks,
    diagram_url: permanentDiagramUrls.get(q.question_number) || null,
    options: q.options || null,
    sub_questions: q.sub_questions || [],
    mark_scheme: q.mark_scheme || null,
  }));

  const { data, error } = await supabase
    .from('questions')
    .insert(records as any)
    .select('id') as { data: { id: string }[] | null; error: any };

  if (error) {
    throw new Error(`Database insertion failed: ${error.message}`);
  }

  // 5. Clean up temporary local Object URLs
  revokeLocalDiagramUrls(diagramData);

  const insertedCount = data?.length ?? 0;
  onProgress?.(`Successfully saved ${insertedCount} questions.`);
  return insertedCount;
}

// ─── Full Pipeline Orchestrator (Zero Storage Uploads during Preview) ─────────

/**
 * Runs the extraction pipeline purely in memory:
 * 1. Prepares PDF in memory
 * 2. Sends to Gemini AI for structured extraction
 * 3. Crops diagrams locally to Object URLs (zero cloud storage)
 * 4. Returns data for user review
 */
export async function runExtractionPipeline(
  file: File,
  markSchemeFile: File | null,
  onStateChange: (state: PipelineState) => void,
  options: { includeGuidance?: boolean } = { includeGuidance: true }
): Promise<{
  result: ExtractionResult;
  diagramData: Map<string, DiagramCropItem>;
  previewUrls: Map<string, string>;
}> {
  try {
    // Stage 1: AI Extraction
    onStateChange({
      stage: 'extracting',
      message: markSchemeFile
        ? 'AI is matching questions to official mark scheme…'
        : 'AI is analyzing and solving the paper…',
      progress: 30,
      result: null,
      error: null,
    });

    const base64 = await fileToBase64(file);
    const msBase64 = markSchemeFile ? await fileToBase64(markSchemeFile) : undefined;

    const result = await extractQuestionsFromPdf(
      base64,
      msBase64,
      (status) => {
        onStateChange({
          stage: 'extracting',
          message: status,
          progress: 50,
          result: null,
          error: null,
        });
      },
      { includeGuidance: options.includeGuidance !== false }
    );

    // Stage 2: Local In-Memory Diagram Cropping (Zero Storage Uploads)
    onStateChange({
      stage: 'cropping-diagrams',
      message: 'Processing diagrams locally…',
      progress: 75,
      result,
      error: null,
    });

    const diagramData = await cropDiagramsLocally(
      file,
      result.questions,
      (status) => {
        onStateChange({
          stage: 'cropping-diagrams',
          message: status,
          progress: 85,
          result,
          error: null,
        });
      }
    );

    // Build preview URL map for UI components
    const previewUrls = new Map<string, string>();
    for (const [qNum, item] of diagramData.entries()) {
      previewUrls.set(qNum, item.localUrl);
    }

    // Stage 3: Ready for review
    onStateChange({
      stage: 'reviewing',
      message: `Extracted ${result.questions.length} questions. Review and confirm.`,
      progress: 90,
      result,
      error: null,
    });

    return { result, diagramData, previewUrls };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown pipeline error';
    onStateChange({
      stage: 'error',
      message: errorMsg,
      progress: 0,
      result: null,
      error: errorMsg,
    });
    throw err;
  }
}
