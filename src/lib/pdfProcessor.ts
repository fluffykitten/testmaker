// ─── PDF Processing Pipeline ───────────────────────────────────────────────────
// Orchestrates the full extraction flow:
//   Upload PDF → Gemini extraction → Local Diagram Cropping (Zero Storage) → Review
//   Confirm Save → Upload PDF & Diagrams to Storage → Supabase DB insertion

import { supabase } from './supabase';
import {
  extractQuestionsFromPdf,
  fileToBase64,
  getGeminiApiKeys,
  getApiKeyForChunk,
  type SubjectDomain,
} from './gemini';
import { splitPdfForParallelExtraction, detectAndSplitInDocumentAnswerKey } from './pdfChunker';
import {
  cropDiagramsLocally,
  uploadDiagramsToStorage,
  revokeLocalDiagramUrls,
  type DiagramCropItem,
} from './diagramCropper';
import type { ExtractionResult, ExtractedQuestion, SubQuestion } from '../types/database';

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

export interface ExtractionPipelineOptions {
  includeGuidance?: boolean;
  domain?: SubjectDomain;
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
  _insertFile?: File | null,
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
    diagram_source: q.diagram_source || null,
    resource_ref: q.resource_ref || null,
    insert_page_number: q.insert_page_number || null,
    options: q.options || null,
    sub_questions: (q.sub_questions || []).map((sub, sIdx) => ({
      ...sub,
      diagram_source: sub.diagram_source || null,
      resource_ref: sub.resource_ref || null,
      insert_page_number: sub.insert_page_number || null,
      diagram_url:
        permanentDiagramUrls.get(`${q.question_number}_sub_${sIdx}`) ||
        sub.diagram_url ||
        null,
    })),
    mark_scheme: q.mark_scheme || null,
  }));

  let { data, error } = await supabase
    .from('questions')
    .insert(records as any)
    .select('id') as { data: { id: string }[] | null; error: any };

  // If columns don't exist in user's Supabase questions table, retry with standard core schema
  if (
    error &&
    error.message &&
    (error.message.includes('diagram_source') ||
      error.message.includes('resource_ref') ||
      error.message.includes('insert_page_number') ||
      error.message.includes('audio_url') ||
      error.message.includes('audio_metadata'))
  ) {
    console.warn('Extended columns not found in database, falling back to core schema:', error.message);
    const fallbackRecords = (records as any[]).map(({ diagram_source, resource_ref, insert_page_number, audio_url, audio_metadata, mark_scheme, ...rest }: any) => {
      const ms = typeof mark_scheme === 'object' && mark_scheme !== null ? { ...mark_scheme } : { raw: mark_scheme };
      if (audio_url) (ms as any)._audio_url = audio_url;
      if (audio_metadata) (ms as any)._audio_metadata = audio_metadata;
      if (diagram_source) (ms as any)._diagram_source = diagram_source;
      if (resource_ref) (ms as any)._resource_ref = resource_ref;
      if (insert_page_number) (ms as any)._insert_page_number = insert_page_number;
      return {
        ...rest,
        mark_scheme: ms,
      };
    });

    const retryRes = (await supabase
      .from('questions')
      .insert(fallbackRecords as any)
      .select('id')) as { data: { id: string }[] | null; error: any };

    data = retryRes.data;
    error = retryRes.error;
  }

  if (error) {
    throw new Error(`Database insertion failed: ${error.message}`);
  }

  // 5. Clean up temporary local Object URLs
  revokeLocalDiagramUrls(diagramData);

  const insertedCount = data?.length ?? 0;
  onProgress?.(`Successfully saved ${insertedCount} questions.`);
  return insertedCount;
}

/**
 * Ensures every question that refers to a reading passage contains the full passage text.
 * If Question 1 has "### Text 1: [Body]\n\n1. [Prompt]", and Question 2 only has "2. [Prompt]",
 * this automatically prepends "### Text 1: [Body]\n\n" to Question 2, 3, 4 until the next "### Text 2:".
 */
export function propagateReadingPassages(questions: ExtractedQuestion[]): ExtractedQuestion[] {
  let activePassage = '';

  return questions.map((q) => {
    const text = q.question_text || '';

    // Check if this question defines a new reading passage (e.g. "### Text 1:", "### Passage 1:", "Text 1: ...")
    const passageMatch = text.match(/(###\s*(?:Text|Passage|Reading|Stimulus|Wacana|Bacaan)\s*\d+[\s\S]*?)(?=(?:\n\s*\d+\.|\n\s*\*\*Question|\n\s*Question\s*\d+|$))/i);

    if (passageMatch && passageMatch[1]) {
      // New active passage found
      activePassage = passageMatch[1].trim();
      return q;
    }

    // If there's an active passage and current question does NOT already include it
    if (activePassage) {
      const firstLine = activePassage.split('\n')[0].trim();
      if (!text.includes(firstLine)) {
        return {
          ...q,
          question_text: `${activePassage}\n\n${text}`,
        };
      }
    }

    return q;
  });
}

/**
 * Normalizes question styles for Multiple Select / Complex Multiple Choice questions
 */
export function normalizeQuestionStyles(questions: ExtractedQuestion[]): ExtractedQuestion[] {
  return questions.map((q) => {
    const text = q.question_text || '';
    const accAnswers = q.mark_scheme?.acceptable_answers || [];
    const hasMultiLetters = accAnswers.some((a) => (String(a).match(/[A-Za-z]/g) || []).length > 1);

    const isMulti =
      /\[Multiple\s*Select\]|pilihan\s*ganda\s*kompleks|more\s*than\s*one\s*(?:correct\s*)?answer|tick\s*(?:\(✓\)\s*)?on\s*every/i.test(
        text
      ) || hasMultiLetters;

    if (isMulti && q.options && q.options.length > 0) {
      return {
        ...q,
        question_style: 'Multiple Select',
      };
    }
    return q;
  });
}

// ─── Full Pipeline Orchestrator (Zero Storage Uploads during Preview) ─────────

/**
 * Runs the extraction pipeline purely in memory:
 * 1. Prepares Question Paper PDF, Mark Scheme PDF, and optional Insert Booklet PDF in memory
 * 2. Sends to Gemini AI with specialized STEM vs Humanities prompts for structured extraction
 * 3. Crops diagrams locally from QP or Insert Booklet to Object URLs (zero cloud storage)
 * 4. Returns data for user review
 */
export async function runExtractionPipeline(
  file: File,
  markSchemeFile: File | null,
  insertFile: File | null = null,
  onStateChange: (state: PipelineState) => void,
  options: ExtractionPipelineOptions = { includeGuidance: true, domain: 'stem' }
): Promise<{
  result: ExtractionResult;
  diagramData: Map<string, DiagramCropItem>;
  previewUrls: Map<string, string>;
}> {
  try {
    // Stage 1: Parallel / Multi-Chunk AI Extraction
    onStateChange({
      stage: 'extracting',
      message: 'Preparing PDF and optimizing pages…',
      progress: 20,
      result: null,
      error: null,
    });

    let msBase64 = markSchemeFile ? await fileToBase64(markSchemeFile) : undefined;
    const insertBase64 = insertFile ? await fileToBase64(insertFile) : undefined;
    let bytesToChunk: File | Uint8Array = file;

    // If no separate mark scheme was provided, check if the PDF contains an embedded answer key at the back
    if (!markSchemeFile) {
      const splitInfo = await detectAndSplitInDocumentAnswerKey(file);
      if (splitInfo.hasAnswerKey && splitInfo.msBase64) {
        bytesToChunk = splitInfo.qpDocBytes;
        msBase64 = splitInfo.msBase64;
        onStateChange({
          stage: 'extracting',
          message: `Detected embedded Answer Key (Pages ${splitInfo.msStartPage}–${splitInfo.msEndPage}) — matching with Question Paper (Pages 1–${splitInfo.qpEndPage})…`,
          progress: 25,
          result: null,
          error: null,
        });
      }
    }

    const chunks = await splitPdfForParallelExtraction(bytesToChunk, 8);

    let result: ExtractionResult;

    if (chunks.length > 1) {
      const apiKeys = getGeminiApiKeys();
      const isMultiKey = apiKeys.length >= 2;

      onStateChange({
        stage: 'extracting',
        message: isMultiKey
          ? `⚡ Dual-Key Turbo Extraction (${apiKeys.length} API keys running parallel across ${chunks.length} chunks)…`
          : `Analyzing exam paper in ${chunks.length} parallel threads (Pages 1–${chunks[chunks.length - 1].endPage})…`,
        progress: 35,
        result: null,
        error: null,
      });

      const chunkResults = await Promise.all(
        chunks.map((chunk, idx) => {
          const assignedKey = getApiKeyForChunk(idx);
          const keyLabel = isMultiKey ? `Key ${(idx % apiKeys.length) + 1}` : `Part ${idx + 1}/${chunks.length}`;

          return extractQuestionsFromPdf(
            chunk.pdfBase64,
            msBase64,
            insertBase64,
            (status) => {
              onStateChange({
                stage: 'extracting',
                message: `[${keyLabel} • Pages ${chunk.startPage}–${chunk.endPage}]: ${status}`,
                progress: 35 + Math.round(((idx + 1) / chunks.length) * 35),
                result: null,
                error: null,
              });
            },
            {
              includeGuidance: options.includeGuidance !== false,
              domain: options.domain || 'stem',
              hasInsertBooklet: Boolean(insertFile),
              apiKey: assignedKey,
            }
          );
        })
      );

      // Merge questions from all parallel chunks with boundary stitching & deep merging
      const questionMap = new Map<string, ExtractedQuestion>();
      const normalizeQNum = (num: string | number) =>
        String(num)
          .replace(/^(?:Question|Q|Soal|No\.?)\s*/i, '')
          .replace(/[.:]$/, '')
          .trim();

      chunkResults.forEach((cr, cIdx) => {
        const chunkOffset = chunks[cIdx].startPage - 1;
        cr.questions.forEach((q) => {
          const qNumClean = normalizeQNum(q.question_number) || String(q.question_number).trim();
          const adjustedQ: ExtractedQuestion = {
            ...q,
            page_number: (q.page_number || 1) + chunkOffset,
            sub_questions: (q.sub_questions || []).map((sq) => ({
              ...sq,
              page_number: sq.page_number ? sq.page_number + chunkOffset : (q.page_number || 1) + chunkOffset,
            })),
          };

          if (!questionMap.has(qNumClean)) {
            questionMap.set(qNumClean, adjustedQ);
          } else {
            // Straddling Question Boundary Stitching:
            // If the same question was extracted by both chunks on the boundary page,
            // merge their sub-questions and keep the most complete content!
            const existing = questionMap.get(qNumClean)!;

            // Merge sub-questions by sub_id
            const mergedSubMap = new Map<string, SubQuestion>();
            (existing.sub_questions || []).forEach((sq) => mergedSubMap.set(sq.sub_id, sq));
            (adjustedQ.sub_questions || []).forEach((sq) => {
              if (
                !mergedSubMap.has(sq.sub_id) ||
                (sq.question_text && sq.question_text.length > (mergedSubMap.get(sq.sub_id)?.question_text?.length || 0))
              ) {
                mergedSubMap.set(sq.sub_id, sq);
              }
            });

            const mergedSubs = Array.from(mergedSubMap.values());
            const totalSubMarks = mergedSubs.reduce((sum, s) => sum + (Number(s.marks) || 0), 0);

            questionMap.set(qNumClean, {
              ...existing,
              // Use the longer / richer question stem text
              question_text:
                adjustedQ.question_text && adjustedQ.question_text.length > existing.question_text.length
                  ? adjustedQ.question_text
                  : existing.question_text,
              total_marks: Math.max(existing.total_marks || 0, adjustedQ.total_marks || 0, totalSubMarks),
              sub_questions: mergedSubs.length > 0 ? mergedSubs : existing.sub_questions,
              has_diagram: existing.has_diagram || adjustedQ.has_diagram,
              diagram_source: existing.diagram_source || adjustedQ.diagram_source,
              resource_ref: existing.resource_ref || adjustedQ.resource_ref,
              bounding_box: existing.bounding_box || adjustedQ.bounding_box,
            });
          }
        });
      });

      const allQuestions = Array.from(questionMap.values());

      // Sort naturally by question number (1, 2, 3 ... 40)
      allQuestions.sort((a, b) => {
        const numA = parseInt(String(a.question_number).replace(/\D/g, ''), 10) || 0;
        const numB = parseInt(String(b.question_number).replace(/\D/g, ''), 10) || 0;
        return numA - numB;
      });

      // Propagate reading passages across all questions in each text group
      const propagated = propagateReadingPassages(allQuestions);
      const finalizedQuestions = normalizeQuestionStyles(propagated);

      // Merge insert_resources across chunks
      const mergedInsertResources = chunkResults.flatMap((cr) => cr.insert_resources || []);
      const seenResourceIds = new Set<string>();
      const uniqueInsertResources = mergedInsertResources.filter((res) => {
        if (!res.id || seenResourceIds.has(res.id)) return false;
        seenResourceIds.add(res.id);
        return true;
      });

      result = {
        paper_metadata: chunkResults[0]?.paper_metadata || {
          subject:
            options.domain === 'languages'
              ? 'English'
              : options.domain === 'humanities'
              ? 'Geography'
              : 'Chemistry',
          subject_code:
            options.domain === 'languages'
              ? 'ENG'
              : options.domain === 'humanities'
              ? '0460'
              : '0620',
          year: new Date().getFullYear(),
          series: 'Exam',
          paper_number: 1,
          has_insert_booklet: Boolean(insertFile),
        },
        questions: finalizedQuestions,
        insert_resources: uniqueInsertResources.length > 0 ? uniqueInsertResources : undefined,
      };
    } else {
      // Single chunk for short documents
      result = await extractQuestionsFromPdf(
        chunks[0].pdfBase64,
        msBase64,
        insertBase64,
        (status) => {
          onStateChange({
            stage: 'extracting',
            message: status,
            progress: 50,
            result: null,
            error: null,
          });
        },
        {
          includeGuidance: options.includeGuidance !== false,
          domain: options.domain || 'stem',
          hasInsertBooklet: Boolean(insertFile),
        }
      );
      result.questions = normalizeQuestionStyles(propagateReadingPassages(result.questions));
    }

    // Stage 2: Local In-Memory Diagram Cropping (Zero Storage Uploads)
    onStateChange({
      stage: 'cropping-diagrams',
      message: insertFile ? 'Cropping diagrams from Question Paper & Insert Booklet…' : 'Processing diagrams locally…',
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
      },
      insertFile
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
