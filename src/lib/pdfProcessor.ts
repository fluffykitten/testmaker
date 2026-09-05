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
  normalizePaper4SubQuestions,
  stripDuplicateOptionsFromStem,
  stripDuplicateSubQuestionsFromStem,
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
import { compareQuestionNumbers } from '../services/questionBankService';
import {
  extractTextFromPdfPages,
  verifyAndRepairPassages,
  stitchPassagesToQuestions,
} from './passageExtractor';

export { stitchPassagesToQuestions } from './passageExtractor';

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
  isIgcse?: boolean;
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
  const { paper_metadata, questions, insert_resources, passages } = result;

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

  // Ensure reading passages are completely stitched and propagated across all questions in the paper
  const finalizedQuestions = propagateReadingPassages(
    stitchPassagesToQuestions(questions, passages)
  );

  const records = finalizedQuestions.map((q: ExtractedQuestion) => {
    // Preserve full insert_resources and passages catalogs inside question mark_scheme JSONB metadata
    const ms = typeof q.mark_scheme === 'object' && q.mark_scheme !== null ? { ...q.mark_scheme } : { raw: q.mark_scheme };
    if (insert_resources && insert_resources.length > 0) {
      (ms as any)._insert_resources = insert_resources;
    }
    if (passages && passages.length > 0) {
      (ms as any)._passages = passages;
    }

    return {
      syllabus_id: syllabusId,
      year: q.year || paper_metadata.year,
      series: q.series || paper_metadata.series,
      paper_number: q.paper_number || paper_metadata.paper_number,
      question_number: q.question_number,
      parent_question_id: q.parent_question_id || null,
      question_text: stripDuplicateOptionsFromStem(q.question_text, q.options),
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
        question_text: stripDuplicateOptionsFromStem(sub.question_text, sub.options || q.options),
        diagram_source: sub.diagram_source || null,
        resource_ref: sub.resource_ref || null,
        insert_page_number: sub.insert_page_number || null,
        diagram_url:
          permanentDiagramUrls.get(`${q.question_number}_sub_${sIdx}`) ||
          sub.diagram_url ||
          null,
      })),
      mark_scheme: ms,
    };
  });

  let { data, error } = await supabase
    .from('questions')
    .insert(records as any)
    .select('id') as { data: { id: string }[] | null; error: any };

  // If columns don't exist in user's Supabase questions table or type mismatch, retry with standard core schema
  if (
    error &&
    error.message &&
    (error.message.includes('diagram_source') ||
      error.message.includes('resource_ref') ||
      error.message.includes('insert_page_number') ||
      error.message.includes('audio_url') ||
      error.message.includes('audio_metadata') ||
      error.message.includes('paper_number') ||
      error.message.includes('invalid input syntax for type integer'))
  ) {
    console.warn('Extended columns or type mismatch in database, falling back to core schema:', error.message);
    const fallbackRecords = (records as any[]).map(({ diagram_source, resource_ref, insert_page_number, audio_url, audio_metadata, mark_scheme, paper_number, ...rest }: any) => {
      const ms = typeof mark_scheme === 'object' && mark_scheme !== null ? { ...mark_scheme } : { raw: mark_scheme };
      if (audio_url) (ms as any)._audio_url = audio_url;
      if (audio_metadata) (ms as any)._audio_metadata = audio_metadata;
      if (diagram_source) (ms as any)._diagram_source = diagram_source;
      if (resource_ref) (ms as any)._resource_ref = resource_ref;
      if (insert_page_number) (ms as any)._insert_page_number = insert_page_number;

      let safePaperNum: any = paper_number;
      if (isNaN(Number(paper_number))) {
        (ms as any)._custom_paper_number = paper_number;
        safePaperNum = 1;
      } else {
        safePaperNum = Number(paper_number);
      }

      return {
        ...rest,
        paper_number: safePaperNum,
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

  // 6. Attempt to persist insert_resources to dedicated table if available
  if (insert_resources && insert_resources.length > 0) {
    try {
      await supabase.from('insert_resources').insert(
        insert_resources.map((res) => ({
          syllabus_id: syllabusId,
          resource_id: res.id,
          title: res.title,
          page_number: res.page_number,
          target_questions: res.target_questions || [],
          diagram_url: res.diagram_url || null,
          text_content: res.text_content || null,
        })) as any
      );
    } catch {
      // Safely ignored if insert_resources table does not exist in DB; catalog is already saved in questions JSONB
    }
  }

  const insertedCount = data?.length ?? 0;
  onProgress?.(`Successfully saved ${insertedCount} questions.`);
  return insertedCount;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extracts declared question ranges from passage headings/intros.
 * Examples:
 * - "questions 1 to 5" -> { start: 1, end: 5 }
 * - "questions 1–5", "soal no 6-10" -> { start: 6, end: 10 }
 * - "(Descriptive Text, 5 Questions)" with qNum 1 -> { start: 1, end: 5 }
 */
function parseQuestionRange(text: string, currentQNum?: string | number): { start: number; end: number } | null {
  if (!text) return null;

  // Pattern 1: Explicit question range ("questions 1 to 5", "questions 1–5", "no 6-10", "soal no 1 s.d. 5")
  const rangeMatch = text.match(/(?:questions?|soal|no\.?)\s*(\d+)\s*(?:to|–|-|s\.?d\.?)\s*(\d+)/i);
  if (rangeMatch) {
    return {
      start: parseInt(rangeMatch[1], 10),
      end: parseInt(rangeMatch[2], 10),
    };
  }

  // Pattern 2: Question count in parentheses ("(Descriptive Text, 5 Questions)", "(4 Questions)")
  const countMatch = text.match(/(\d+)\s+questions?/i);
  if (countMatch && currentQNum) {
    const count = parseInt(countMatch[1], 10);
    const start = parseInt(String(currentQNum).replace(/\D/g, ''), 10) || 1;
    return {
      start,
      end: start + count - 1,
    };
  }

  return null;
}

/**
 * Robust passage detector that distinguishes:
 * 1. A question that INCLUDES a full reading passage body (Header + Body Prose + Prompt) -> returns full passage (Header + Body)
 * 2. A question that only REFERENCES a passage (Header + Prompt, or just Prompt) -> returns null (allowing body propagation)
 */
function detectPassageContent(text: string): string | null {
  if (!text || text.trim().length < 150) return null;

  const trimmed = text.trim();

  // 1. Identify where the final question prompt begins
  const promptSplitRegex = /(?:\n\s*(?:No\.?\s*)?\d+[\s.:)]+|\n\s*(?:\*{1,2}|#{1,4}\s*)?Question\s*\d*[\s.:*]+|\n\s*\[(?:Matching|Multiple|Table|Fill|Pilihan|Menjodohkan)[^\]]*\]|\n\s*(?:Which|What|How|Why|Where|When|Who|Whom|Whose|Explain|Identify|According to|Based on|In the text|The text|The word|The passage|The author|From the (?:text|passage))\b)/i;

  const match = trimmed.match(promptSplitRegex);

  let passageCandidate = '';

  if (match && match.index !== undefined && match.index > 0) {
    passageCandidate = trimmed.slice(0, match.index).trim();
  } else {
    // If no explicit split keyword, check if split by multi-paragraphs
    const paragraphs = trimmed.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (paragraphs.length >= 2) {
      const lastP = paragraphs[paragraphs.length - 1];
      if (lastP.includes('?') || /^(?:Which|What|How|Why|Where|When|Who|Explain|According to|Based on)/i.test(lastP)) {
        passageCandidate = paragraphs.slice(0, -1).join('\n\n');
      }
    }
  }

  // Also support natural prompt intro formats: "The following text is for questions 1 to 5...", "Read the following text..."
  if (!passageCandidate) {
    const promptIntroMatch = trimmed.match(
      /^((?:The following text is for questions|Read the following (?:text|passage|dialogue|article)|Questions \d+[–-]\d+ are based on the following|Based on the text below)[\s\S]*?)(?=(?:\n\s*\d+\.|\n\s*\*\*Question|\n\s*Question\s*\d+|\n\s*\[(?:Matching|Multiple)|\n\s*[A-F]\.|$))/i
    );
    if (promptIntroMatch && promptIntroMatch[1] && promptIntroMatch[1].trim().length > 150) {
      passageCandidate = promptIntroMatch[1].trim();
    }
  }

  if (!passageCandidate) {
    return null;
  }

  // Check if passageCandidate actually has substantive prose body (excluding header lines)
  const lines = passageCandidate.split('\n').map((l) => l.trim()).filter(Boolean);
  const headerOnlyRegex = /^(?:#{1,4}\s*|\*{1,2})?(?:Text|Passage|Reading|Stimulus|Wacana|Bacaan|Section|Part|Teks)\s*[A-Za-z0-9.:\-_ (≈±)]*$/i;

  const nonHeaderLines = lines.filter(
    (l) => !headerOnlyRegex.test(l) && !l.startsWith('#') && !/^\([^)]+\)$/.test(l) && l.length > 20
  );
  const bodyTextLength = nonHeaderLines.join(' ').length;

  if (bodyTextLength < 100) {
    // It has no substantive prose body! It's just a header line or title reference!
    return null;
  }

  return passageCandidate;
}

/**
 * Ensures every question that refers to a reading passage contains the full passage text.
 * Detects all passage formats (### Text 1, ### Passage A, "Text 1: ...", "Read the following text...", multi-paragraph stimulus)
 * and automatically attaches the complete passage to subsequent questions in that group.
 */
export function propagateReadingPassages(questions: ExtractedQuestion[]): ExtractedQuestion[] {
  let activePassageBody = '';
  let activePassageHeading = '';
  let activePassageHeadingClean = '';
  let activePassageSample = '';
  let activePassageRange: { start: number; end: number } | null = null;

  return questions.map((q) => {
    const text = q.question_text || '';
    const detected = detectPassageContent(text);
    const qNum = parseInt(String(q.question_number).replace(/\D/g, ''), 10);

    if (detected) {
      activePassageBody = detected;
      const firstLine = detected
        .split('\n')[0]
        .replace(/^#{1,4}\s*/, '')
        .replace(/^\*{1,2}|\*{1,2}$/g, '')
        .trim();
      activePassageHeading = firstLine;

      // Extract core label like "Text 1", "Teks 1", "Passage A", "Text 3", etc.
      const labelMatch = firstLine.match(/^(?:Text|Passage|Reading|Stimulus|Wacana|Bacaan|Section|Part|Teks)\s*([A-Za-z0-9]+)/i);
      activePassageHeadingClean = labelMatch ? labelMatch[0].trim() : firstLine.replace(/[:(≈±].*$/, '').trim();

      // Detect question range if stated (e.g. questions 1 to 5, 5 Questions)
      activePassageRange = parseQuestionRange(detected, q.question_number);

      // Sample the actual body text (excluding the header line) to accurately detect body presence
      const lines = detected.split('\n').map((l) => l.trim()).filter((l) => l.length > 20 && !l.startsWith('#'));
      activePassageSample = lines.length > 0 ? lines[0].slice(0, 50) : '';
      return q;
    }

    // Check if there is an active passage to propagate to linked questions
    if (activePassageBody) {
      // 1. Check if current question text already contains the passage body text
      const alreadyHasPassageBody = Boolean(
        (activePassageSample && text.includes(activePassageSample)) ||
        (text.length > 300 && text.includes(activePassageBody.slice(0, 80)))
      );

      // 2. Check if current question is within the declared passage question range
      const inRange = Boolean(
        activePassageRange && !isNaN(qNum) && qNum >= activePassageRange.start && qNum <= activePassageRange.end
      );

      // 3. Check if current question refers to this active passage (supports ###, **, or plain text reference)
      const hasHeadingRef = Boolean(
        (activePassageHeading && text.includes(activePassageHeading)) ||
        (activePassageHeadingClean &&
          new RegExp(`(?:#{1,4}\\s*|\\*{1,2})?${escapeRegex(activePassageHeadingClean)}\\b`, 'i').test(text))
      );

      const hasTextRef =
        inRange ||
        hasHeadingRef ||
        /\b(?:Based on the (?:text|passage)|According to the (?:text|passage)|In the (?:text|passage)|From the (?:text|passage)|The (?:text|passage) primarily|Paragraph (?:one|two|three|four|\d+))\b/i.test(
          text
        );

      if (!alreadyHasPassageBody && hasTextRef) {
        // Strip duplicate heading line from question prompt if present so heading isn't duplicated
        const cleanPrompt = text
          .replace(
            /^(?:(?:#{1,4}\s*|\*{1,2})?(?:Text|Passage|Teks|Reading|Stimulus|Wacana|Bacaan)\b[^\n]*\n*|\([^\n]+\)\n*)+/i,
            ''
          )
          .trim();

        return {
          ...q,
          question_text: `${activePassageBody}\n\n${cleanPrompt}`,
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
              extractResourceCatalog: idx === 0,
              isIgcse: options.isIgcse !== false,
            }
          );
        })
      );

      // Merge questions from all parallel chunks with boundary stitching & deep merging
      const questionMap = new Map<string, ExtractedQuestion>();
      const normalizeQNum = (num: string | number) => {
        const raw = String(num)
          .replace(/^(?:Question|Q|Soal|No\.?)\s*/i, '')
          .replace(/[.:]$/, '')
          .trim();
        // If question number is followed by a sub-id (e.g. "4(d)", "4 d", "4.d"), extract parent number "4"
        const parentMatch = raw.match(/^(\d+)\s*(?:\([a-zA-Z0-9]+\)|[a-zA-Z])$/);
        if (parentMatch) {
          return parentMatch[1];
        }
        return raw;
      };

      const normSubKey = (id: string) => (id || '').replace(/[().\s]/g, '').toLowerCase();

      chunkResults.forEach((cr, cIdx) => {
        const chunkOffset = chunks[cIdx].startPage - 1;
        cr.questions.forEach((q) => {
          const qNumClean = normalizeQNum(q.question_number) || String(q.question_number).trim();
          const adjustedQ: ExtractedQuestion = {
            ...q,
            question_number: qNumClean,
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
            // If the same question was extracted across chunk boundaries,
            // deep-merge sub-questions (union of all parts a, b, c, d) and keep the opening scenario setup!
            const existing = questionMap.get(qNumClean)!;

            // Deep-merge sub-questions by normalized sub_id key
            const mergedSubMap = new Map<string, SubQuestion>();
            (existing.sub_questions || []).forEach((sq) => {
              const k = normSubKey(sq.sub_id) || sq.sub_id;
              mergedSubMap.set(k, sq);
            });

            (adjustedQ.sub_questions || []).forEach((sq) => {
              const k = normSubKey(sq.sub_id) || sq.sub_id;
              const prev = mergedSubMap.get(k);
              if (!prev) {
                // If existing question already has a diagram and this continuation sub-question has its own diagram,
                // attach the diagram specifically to this sub-question!
                mergedSubMap.set(k, {
                  ...sq,
                  has_diagram: sq.has_diagram || (adjustedQ.has_diagram && !existing.has_diagram ? true : false),
                  diagram_source: sq.diagram_source || (adjustedQ.diagram_source && !existing.diagram_source ? adjustedQ.diagram_source : null),
                  bounding_box: sq.bounding_box || (adjustedQ.bounding_box && !existing.bounding_box ? adjustedQ.bounding_box : null),
                });
              } else {
                // Keep the more complete version of the sub-question text
                mergedSubMap.set(k, {
                  ...prev,
                  question_text:
                    sq.question_text && sq.question_text.length > (prev.question_text?.length || 0)
                      ? sq.question_text
                      : prev.question_text,
                  marks: sq.marks || prev.marks,
                  mark_scheme: sq.mark_scheme || prev.mark_scheme,
                  options: sq.options && sq.options.length > 0 ? sq.options : prev.options,
                  has_diagram: prev.has_diagram || sq.has_diagram,
                  diagram_source: prev.diagram_source || sq.diagram_source,
                  bounding_box: prev.bounding_box || sq.bounding_box,
                });
              }
            });

            // Naturally sort merged sub-questions: (a), (b), (c), (d), (a)(i), etc.
            const mergedSubs = Array.from(mergedSubMap.values()).sort((a, b) => {
              const ka = normSubKey(a.sub_id);
              const kb = normSubKey(b.sub_id);
              return ka.localeCompare(kb, undefined, { numeric: true });
            });

            const totalSubMarks = mergedSubs.reduce((sum, s) => sum + (Number(s.marks) || 0), 0);

            // Determine parent question text:
            // Do NOT let a continuation chunk's partial caption overwrite the opening scenario setup!
            const isAdjustedContinuation =
              (adjustedQ.sub_questions && adjustedQ.sub_questions.length > 0) &&
              !adjustedQ.sub_questions.some((s) => normSubKey(s.sub_id) === 'a' || normSubKey(s.sub_id).startsWith('a'));

            const chosenQuestionText =
              isAdjustedContinuation && existing.question_text
                ? existing.question_text
                : existing.question_text && existing.question_text.length >= (adjustedQ.question_text?.length || 0)
                ? existing.question_text
                : (adjustedQ.question_text || existing.question_text);

            questionMap.set(qNumClean, {
              ...existing,
              question_text: chosenQuestionText,
              options:
                adjustedQ.options && adjustedQ.options.length > (existing.options?.length || 0)
                  ? adjustedQ.options
                  : existing.options,
              mark_scheme:
                adjustedQ.mark_scheme && Object.keys(adjustedQ.mark_scheme).length > 0
                  ? adjustedQ.mark_scheme
                  : existing.mark_scheme,
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
      allQuestions.sort((a, b) => compareQuestionNumbers(a.question_number, b.question_number));

      // Merge passages across chunks
      const mergedPassages = chunkResults.flatMap((cr) => cr.passages || []);
      const seenPassageIds = new Set<string>();
      const uniquePassages = mergedPassages.filter((p) => {
        const idKey = (p.id || '').toLowerCase().trim();
        if (!idKey || seenPassageIds.has(idKey)) return false;
        seenPassageIds.add(idKey);
        return true;
      });

      // Verify / repair passages from source PDF if in Language domain
      let verifiedPassages = uniquePassages;
      if (options.domain === 'languages') {
        try {
          const pageTexts = await extractTextFromPdfPages(bytesToChunk);
          verifiedPassages = verifyAndRepairPassages(uniquePassages, pageTexts);
        } catch (err) {
          console.warn('PDF passage verification skipped:', err);
        }
      }

      // Stitch reading passages directly into questions referencing them
      const stitchedQuestions = stitchPassagesToQuestions(allQuestions, verifiedPassages);

      // Propagate reading passages across all questions in each text group
      const propagated = propagateReadingPassages(stitchedQuestions);
      const normalized = normalizePaper4SubQuestions(normalizeQuestionStyles(propagated));
      const finalizedQuestions = normalized.map((q) => ({
        ...q,
        question_text: stripDuplicateSubQuestionsFromStem(
          stripDuplicateOptionsFromStem(q.question_text, q.options),
          q.sub_questions
        ),
        sub_questions: (q.sub_questions || []).map((sq) => ({
          ...sq,
          question_text: stripDuplicateOptionsFromStem(sq.question_text, sq.options || q.options),
        })),
      }));

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
              ? (options.isIgcse !== false ? '0460' : 'GEO')
              : (options.isIgcse !== false ? '0620' : 'CHEM'),
          year: new Date().getFullYear(),
          series: options.isIgcse !== false ? 'Exam' : 'General',
          paper_number: 1,
          has_insert_booklet: Boolean(insertFile),
        },
        questions: finalizedQuestions,
        insert_resources: uniqueInsertResources.length > 0 ? uniqueInsertResources : undefined,
        passages: verifiedPassages.length > 0 ? verifiedPassages : undefined,
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
          isIgcse: options.isIgcse !== false,
        }
      );
      let verifiedPassages = result.passages || [];
      if (options.domain === 'languages') {
        try {
          const pageTexts = await extractTextFromPdfPages(bytesToChunk);
          verifiedPassages = verifyAndRepairPassages(verifiedPassages, pageTexts);
        } catch (err) {
          console.warn('PDF passage verification skipped:', err);
        }
      }

      const stitched = stitchPassagesToQuestions(result.questions, verifiedPassages);
      result.questions = normalizePaper4SubQuestions(
        normalizeQuestionStyles(propagateReadingPassages(stitched))
      ).map((q) => ({
        ...q,
        question_text: stripDuplicateSubQuestionsFromStem(
          stripDuplicateOptionsFromStem(q.question_text, q.options),
          q.sub_questions
        ),
        sub_questions: (q.sub_questions || []).map((sq) => ({
          ...sq,
          question_text: stripDuplicateOptionsFromStem(sq.question_text, sq.options || q.options),
        })),
      }));
      result.passages = verifiedPassages.length > 0 ? verifiedPassages : undefined;
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
