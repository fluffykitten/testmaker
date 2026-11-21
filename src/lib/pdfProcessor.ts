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
  stripDuplicateSubIdPrefix,
  cleanQuotesAndTemperatures,
  type SubjectDomain,
} from './gemini';
import {
  splitPdfForParallelExtraction,
  detectAndSplitInDocumentAnswerKey,
  isSaveMyExamsDocument,
  splitSaveMyExamsPdfBySections,
  readPdfPageTexts,
  detectArabicPagesInPdf,
  renderPdfPagesToImages,
  uint8ArrayToBase64,
  type SaveMyExamsMeta,
  type PdfChunk,
} from './pdfChunker';
import { trimMarkSchemePreamble } from './markSchemeTrim';
import { chooseBetterMarkScheme, chooseBetterSubMarkScheme } from './markSchemeAudit';
import { parseOfficialMcqAnswerKey, reconcileQuestionsWithOfficialMcqKey } from './mcqMarkSchemeExtractor';
import { tryBuildPaperOutline } from './paperOutline';
import { subjectForSyllabus, NEUTRAL_HUMANITIES_PROFILE } from './subjectClassifier';
import type { PaperOutline } from './paperOutlineParse';
import { separatePracticalQuestions, enforceTableOwnership } from './practicalPostProcess';
import {
  cropDiagramsLocally,
  uploadDiagramsToStorage,
  revokeLocalDiagramUrls,
  renderPdfPageToCanvas,
  type DiagramCropItem,
} from './diagramCropper';
import { buildQualitativeNotesResources, renderNotePagesToDataUrls } from './practicalResources';
import type { ExtractionResult, ExtractedQuestion, SubQuestion } from '../types/database';
import { compareQuestionNumbers } from '../services/questionBankService';
import {
  extractTextFromPdfPages,
  verifyAndRepairPassages,
  stitchPassagesToQuestions,
} from './passageExtractor';
import { mergeChunkPassagesAndQuestions, parseQuestionRange } from './passageMerge';
import {
  PASSAGE_OPEN_TAG,
  PASSAGE_CLOSE_TAG,
  hasExplicitPassageMarkers,
  hasNoPassageDirective,
  stripPassageControlTags,
} from './readingPassageUtils';
import { addTagsToQuestions } from '../services/questionTagService';
import { uploadPastPaperPdf, uploadInsertBookletPdf } from '../services/storageService';

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
  isSaveMyExams?: boolean;
  isIeltsCefr?: boolean;
  tags?: string;
  cambridgeHubUrl?: string;
  cambridgeMsHubUrl?: string;
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
    .maybeSingle() as { data: { id: string } | null };

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

export function filterActiveDiagramDataForSave(
  questions: ExtractedQuestion[],
  diagramData: Map<string, DiagramCropItem>
): Map<string, DiagramCropItem> {
  const filtered = new Map<string, DiagramCropItem>();
  if (!diagramData || diagramData.size === 0) return filtered;

  const activeKeys = new Set<string>();
  const removedKeys = new Set<string>();

  for (const q of questions) {
    if (q.has_diagram === false) {
      removedKeys.add(q.question_number);
    } else {
      activeKeys.add(q.question_number);
      if (q.parent_question_id) activeKeys.add(q.parent_question_id);
    }

    (q.sub_questions || []).forEach((sub, sIdx) => {
      const subKey = `${q.question_number}_sub_${sIdx}`;
      if (sub.has_diagram === false) {
        removedKeys.add(subKey);
      } else {
        activeKeys.add(subKey);
      }
    });
  }

  for (const [key, item] of diagramData.entries()) {
    if (removedKeys.has(key)) continue;
    if (activeKeys.has(key)) {
      filtered.set(key, item);
    }
  }

  return filtered;
}

export async function saveExtractedQuestions(
  result: ExtractionResult,
  diagramData: Map<string, DiagramCropItem>,
  _qpFile?: File | null,
  _msFile?: File | null,
  _insertFile?: File | null,
  onProgress?: (status: string) => void,
  tags?: string
): Promise<{ count: number; insertedIds: string[] }> {
  const { paper_metadata, questions, insert_resources, passages } = result;

  // 1. Upload only active (non-deleted, selected) cropped diagram blobs to Supabase Storage
  const activeDiagramData = filterActiveDiagramDataForSave(questions, diagramData);
  let permanentDiagramUrls = new Map<string, string>();
  if (activeDiagramData.size > 0) {
    permanentDiagramUrls = await uploadDiagramsToStorage(
      activeDiagramData,
      {
        subject_code: paper_metadata.subject_code,
        year: paper_metadata.year,
        paper_number: paper_metadata.paper_number,
      },
      onProgress
    );
  }

  // 2b. Upload source Question Paper PDF to R2 / Supabase Storage for persistent citations
  let sourcePdfUrl: string | null = null;
  if (_qpFile) {
    onProgress?.('Uploading source Question Paper PDF for citations…');
    try {
      sourcePdfUrl = await uploadPastPaperPdf(_qpFile, {
        subject_code: paper_metadata.subject_code,
        year: paper_metadata.year,
        series: paper_metadata.series,
        paper_number: paper_metadata.paper_number,
      });
    } catch (pdfErr) {
      console.warn('Failed to upload past paper PDF for citations:', pdfErr);
    }
  }

  // 2c. Upload source Insert / Resource Booklet PDF to R2 / Supabase Storage for persistent citations
  let insertPdfUrl: string | null = null;
  if (_insertFile) {
    onProgress?.('Uploading Insert / Resource Booklet PDF for citations…');
    try {
      insertPdfUrl = await uploadInsertBookletPdf(_insertFile, {
        subject_code: paper_metadata.subject_code,
        year: paper_metadata.year,
        series: paper_metadata.series,
        paper_number: paper_metadata.paper_number,
      });
    } catch (insertErr) {
      console.warn('Failed to upload insert booklet PDF for citations:', insertErr);
    }
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
    if (q.has_diagram === false) {
      delete (ms as any)._svg_content;
      delete (ms as any)._ai_diagram_prompt;
    } else {
      if (q.svg_content) (ms as any)._svg_content = q.svg_content;
      if (q.ai_diagram_prompt) (ms as any)._ai_diagram_prompt = q.ai_diagram_prompt;
    }

    const effectivePdfUrl = q.source_pdf_url || sourcePdfUrl || null;
    const effectiveHubUrl =
      q.cambridge_hub_url ||
      paper_metadata.cambridge_hub_url ||
      (q.mark_scheme as any)?._cambridge_hub_url ||
      null;
    const effectiveMsHubUrl =
      q.cambridge_ms_hub_url ||
      paper_metadata.cambridge_ms_hub_url ||
      (q.mark_scheme as any)?._cambridge_ms_hub_url ||
      null;
    const effectiveInsertPdfUrl = q.insert_pdf_url || insertPdfUrl || null;
    const effectiveCognitiveLevel = q.cognitive_level || null;
    const effectivePageNumber = q.page_number || null;

    if (effectivePdfUrl) (ms as any)._source_pdf_url = effectivePdfUrl;
    if (effectiveHubUrl) (ms as any)._cambridge_hub_url = effectiveHubUrl;
    if (effectiveMsHubUrl) (ms as any)._cambridge_ms_hub_url = effectiveMsHubUrl;
    if (effectiveInsertPdfUrl) (ms as any)._insert_pdf_url = effectiveInsertPdfUrl;
    if (effectiveCognitiveLevel) (ms as any)._cognitive_level = effectiveCognitiveLevel;
    if (effectivePageNumber) (ms as any)._page_number = effectivePageNumber;

    const fallbackParentDiagramUrl =
      q.diagram_url && !q.diagram_url.startsWith('blob:') ? q.diagram_url : null;

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
      cognitive_level: effectiveCognitiveLevel,
      source_pdf_url: effectivePdfUrl,
      page_number: effectivePageNumber,
      marks: q.total_marks,
      diagram_url:
        q.has_diagram === false
          ? null
          : permanentDiagramUrls.get(q.question_number) || fallbackParentDiagramUrl,
      diagram_source: q.has_diagram === false ? null : q.diagram_source || null,
      resource_ref: q.has_diagram === false ? null : q.resource_ref || null,
      insert_page_number: q.has_diagram === false ? null : q.insert_page_number || null,
      options: (q.options || null)?.map((opt) => cleanQuotesAndTemperatures(opt)) || null,
      sub_questions: (q.sub_questions || []).map((sub, sIdx) => ({
        ...sub,
        cognitive_level: sub.cognitive_level || null,
        question_text: stripDuplicateOptionsFromStem(sub.question_text, sub.options || q.options),
        options: (sub.options || null)?.map((opt) => cleanQuotesAndTemperatures(opt)) || null,
        diagram_source: sub.has_diagram === false ? null : sub.diagram_source || null,
        resource_ref: sub.has_diagram === false ? null : sub.resource_ref || null,
        insert_page_number: sub.has_diagram === false ? null : sub.insert_page_number || null,
        diagram_url:
          sub.has_diagram === false
            ? null
            : permanentDiagramUrls.get(`${q.question_number}_sub_${sIdx}`) ||
              (sub.diagram_url && !sub.diagram_url.startsWith('blob:') ? sub.diagram_url : null),
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
      error.message.includes('cognitive_level') ||
      error.message.includes('source_pdf_url') ||
      error.message.includes('page_number') ||
      error.message.includes('schema cache') ||
      error.message.includes('Could not find') ||
      error.message.includes('invalid input syntax for type integer'))
  ) {
    console.warn('Extended columns or type mismatch in database, falling back to core schema:', error.message);
    const fallbackRecords = (records as any[]).map(({ diagram_source, resource_ref, insert_page_number, audio_url, audio_metadata, cognitive_level, source_pdf_url, page_number, mark_scheme, paper_number, ...rest }: any) => {
      const ms = typeof mark_scheme === 'object' && mark_scheme !== null ? { ...mark_scheme } : { raw: mark_scheme };
      if (audio_url) (ms as any)._audio_url = audio_url;
      if (audio_metadata) (ms as any)._audio_metadata = audio_metadata;
      if (diagram_source) (ms as any)._diagram_source = diagram_source;
      if (resource_ref) (ms as any)._resource_ref = resource_ref;
      if (insert_page_number) (ms as any)._insert_page_number = insert_page_number;
      if (cognitive_level) (ms as any)._cognitive_level = cognitive_level;
      if (source_pdf_url) (ms as any)._source_pdf_url = source_pdf_url;
      if (page_number) (ms as any)._page_number = page_number;

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
  // Note: insert_resources catalog is already persisted inside questions.mark_scheme._insert_resources JSONB.

  const insertedCount = data?.length ?? 0;
  const insertedIds = data?.map((d) => d.id) || [];

  if (tags && insertedIds.length > 0) {
    onProgress?.('Applying question tags…');
    addTagsToQuestions(insertedIds, tags);
  }

  onProgress?.(`Successfully saved ${insertedCount} questions.`);
  return { count: insertedCount, insertedIds };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Robust passage detector that distinguishes:
 * 1. A question that INCLUDES a full reading passage body (Header + Body Prose + Prompt) -> returns full passage (Header + Body)
 * 2. A question that only REFERENCES a passage (Header + Prompt, or just Prompt) -> returns null (allowing body propagation)
 */
function detectPassageContent(text: string): string | null {
  if (!text || hasNoPassageDirective(text)) return null;

  const explicitBlock = text.match(/\[passage\]([\s\S]*?)\[\/passage\]/i);
  if (explicitBlock && explicitBlock[1] && explicitBlock[1].trim().length > 0) {
    return explicitBlock[0].trim();
  }

  if (text.trim().length < 150) return null;

  const trimmed = text.trim();

  // 1. Identify where the final question prompt begins
  const promptSplitRegex =
    /(?:\n\s*(?:No\.?\s*)?\d+[\s.:)]+|\n\s*(?:\*{1,2}|#{1,4}\s*)?Question\s*\d*[\s.:*]+|\n\s*\[(?:Matching|Multiple|Table|Fill|Pilihan|Menjodohkan)[^\]]*\]|\n\s*(?:Which|What|How|Why|Where|When|Who|Whom|Whose|Explain|Identify|According to|Based on|In the text|The text|The word|The passage|The author|From the (?:text|passage)|Berdasarkan|Manakah|Interpretasi|Makna tersirat|Peribahasa|Perbaikan|Topik|Pesan tersirat|Pendapat|Masalah utama|Ulasan|Hubungan|Jika ditinjau|Tentukan)\b)/i;

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
    if (hasNoPassageDirective(text)) {
      return q;
    }
    const detected = detectPassageContent(text);
    const qNum = parseInt(String(q.question_number).replace(/\D/g, ''), 10);

    if (detected) {
      activePassageBody = hasExplicitPassageMarkers(detected)
        ? detected
        : `${PASSAGE_OPEN_TAG}${detected}${PASSAGE_CLOSE_TAG}`;
      const detectedClean = stripPassageControlTags(detected);
      const firstLine = detectedClean
        .split('\n')[0]
        .replace(/^#{1,4}\s*/, '')
        .replace(/^\*{1,2}|\*{1,2}$/g, '')
        .trim();
      activePassageHeading = firstLine;

      // Extract core label like "Text 1", "Teks 1", "Passage A", "Text 3", etc.
      const labelMatch = firstLine.match(/^(?:Text|Passage|Reading|Stimulus|Wacana|Bacaan|Section|Part|Teks)\s*([A-Za-z0-9]+)/i);
      activePassageHeadingClean = labelMatch ? labelMatch[0].trim() : firstLine.replace(/[:(≈±].*$/, '').trim();

      // Detect question range if stated (e.g. questions 1 to 5, 5 Questions)
      activePassageRange = parseQuestionRange(detectedClean, q.question_number);

      // Sample the actual body text (excluding the header line) to accurately detect body presence
      const lines = detectedClean.split('\n').map((l) => l.trim()).filter((l) => l.length > 20 && !l.startsWith('#'));
      activePassageSample = lines.length > 0 ? lines[0].slice(0, 50) : '';
      return q;
    }

    // Check if there is an active passage to propagate to linked questions
    if (activePassageBody) {
      const cleanText = stripPassageControlTags(text);
      const activeCleanBody = stripPassageControlTags(activePassageBody);
      // 1. Check if current question text already contains the passage body text
      const alreadyHasPassageBody = Boolean(
        hasExplicitPassageMarkers(text) ||
        (activePassageSample && cleanText.includes(activePassageSample)) ||
        (cleanText.length > 300 && cleanText.includes(activeCleanBody.slice(0, 80)))
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

      const outOfDeclaredRange = Boolean(
        activePassageRange && !isNaN(qNum) && (qNum < activePassageRange.start || qNum > activePassageRange.end)
      );

      const hasTextRef =
        inRange ||
        hasHeadingRef ||
        (!outOfDeclaredRange &&
          /\b(?:Based on the (?:text|passage)|According to the (?:text|passage)|In the (?:text|passage)|From the (?:text|passage)|The (?:text|passage) primarily|Paragraph (?:one|two|three|four|\d+)|Berdasarkan\s+(?:teks|bacaan|kutipan|isi\s+teks)|teks\s+tersebut|paragraf\s+(?:pertama|kedua|ketiga|keempat|\d+))\b/i.test(
            text
          ));

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

    // Safeguard for Classification / Matching / True-False matrix tables: ensure options are null and style is Table Choice
    const isMatrixOrMatchingTable =
      /\|\s*(?:Pernyataan|Statement|Aspek|Kategori|Nomor|No\.?|Item|Upaya|Kebijakan|Masalah|Kegiatan|Tindakan)\s*\|.*\|\s*(?:Benar|Salah|True|False|Sesuai|Tidak\s*Sesuai|Setuju|Tidak\s*Setuju|Tepat|Tidak\s*Tepat|Fakta|Opini|Ya|Tidak|Yes|No|B|S|T|F)\s*\|/i.test(
        text
      ) ||
      /\|\s*(?:Benar\s*\|\s*Salah|True\s*\|\s*False|Sesuai\s*\|\s*Tidak\s*Sesuai|Setuju\s*\|\s*Tidak\s*Setuju|Tepat\s*\|\s*Tidak\s*Tepat|Fakta\s*\|\s*Opini|Ya\s*\|\s*Tidak|Yes\s*\|\s*No)\s*\|/i.test(
        text
      ) ||
      /tabel\s+(?:benar\s*[\/\-]?\s*salah|sesuai\s*[\/\-]?\s*tidak\s*sesuai|tepat\s*[\/\-]?\s*tidak\s*tepat|jawaban|menjodohkan)/i.test(
        text
      ) ||
      /(?:\[matching|\[menjodohkan|menjodohkan|tabel\s+benar\s*\/\s*salah)/i.test(text);

    // Also check if options are merely binary column names (e.g. ['Benar', 'Salah'], ['Tepat', 'Tidak Tepat'])
    // or comma-separated matrix tuple options (e.g. ['A. Tepat, Tepat, Tidak Tepat', ...]) when a pipe table is present
    const optionsAreBinaryHeaders = Boolean(
      q.options &&
      q.options.length >= 1 &&
      q.options.length <= 5 &&
      q.options.every((opt) => {
        const clean = opt.trim().replace(/^[A-E][.:\)\s]+/i, '').trim();
        const parts = clean.split(',').map((p) => p.trim()).filter(Boolean);
        return (
          parts.length > 0 &&
          parts.every((part) =>
            /^(?:benar|salah|true|false|sesuai|tidak\s*sesuai|setuju|tidak\s*setuju|tepat|tidak\s*tepat|fakta|opini|ya|tidak|yes|no|b|s|t|f)$/i.test(
              part
            )
          )
        );
      })
    );

    if (isMatrixOrMatchingTable || (text.includes('|') && optionsAreBinaryHeaders)) {
      return {
        ...q,
        options: null,
        sub_questions:
          q.sub_questions && q.sub_questions.length > 0 && text.includes('|') && /\|[-:\s|]{3,}\|/.test(text)
            ? []
            : q.sub_questions,
        question_style: 'Table Choice',
      };
    }

    // Check if options are combination bundles (e.g. "A. 1 dan 2", "B. 1, 2, dan 3", "C. I and II")
    const isCombinationMcq = Boolean(
      q.options &&
      q.options.length > 0 &&
      q.options.every((opt) => /^[A-Ea-e][.:\s]+(?:\d+|[I|V|X]+)\s*(?:dan|and|,)/i.test(opt.trim()))
    );

    if (isCombinationMcq) {
      return {
        ...q,
        question_style: 'Multiple Choice',
      };
    }

    const isMultiPhrase =
      /\[Multiple\s*Select\]|pilihan\s*ganda\s*kompleks|more\s*than\s*one\s*(?:correct\s*)?answer|tick\s*(?:\(✓\)\s*)?on\s*every|pilih(?:lah)?\s+semua\s+(?:kesimpulan|pernyataan|jawaban|opsi)?/i.test(
        text
      );

    const isMulti = isMultiPhrase || hasMultiLetters || q.question_style === 'Multiple Select';

    if (isMulti && q.options && q.options.length > 0) {
      return {
        ...q,
        question_style: 'Multiple Select',
      };
    }

    // Ensure questions with markdown table and no options default to 'Structured'
    if ((!q.options || q.options.length === 0) && text.includes('|') && text.includes('\n|') && !q.question_style) {
      return {
        ...q,
        question_style: 'Structured',
      };
    }

    return q;
  });
}

const EASTERN_ARABIC_DIGITS_MAP: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
  '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
};

export function normalizeChunkQuestionNumber(num: string | number): string {
  const ascii = String(num ?? '').replace(/[٠-٩]/g, (d) => EASTERN_ARABIC_DIGITS_MAP[d] || d);
  let raw = ascii
    .replace(/^(?:Question|Q|Soal|No\.?)\s*/i, '')
    .replace(/[.:]+$/, '')
    .trim();
  const parenWrapped = /^\(([^()]+)\)$/.exec(raw);
  if (parenWrapped) raw = parenWrapped[1].trim();
  const parentMatch = raw.match(/^0*(\d+)\s*(?:\([a-zA-Z0-9]+\)|[a-zA-Z])$/);
  if (parentMatch) {
    return parentMatch[1];
  }
  return raw.replace(/^0+(?=\d)/, '');
}

function isPhantomEmptyQuestion(q: ExtractedQuestion): boolean {
  const stem = (q.question_text || '').trim();
  const hasOpts = Array.isArray(q.options) && q.options.length > 0;
  const hasSubs = Array.isArray(q.sub_questions) && q.sub_questions.length > 0;
  if (!stem && !hasOpts && !hasSubs && !q.has_diagram) return true;
  if (!hasOpts && !hasSubs && !q.has_diagram && /^(?:\[?\s*turn\s+over\s*\]?|blank\s+page)$/i.test(stem)) {
    return true;
  }
  return false;
}

export function mergeChunkQuestions(
  chunkQuestions: ExtractedQuestion[][],
  chunksMeta: Array<{ startPage: number; targetSection?: string }>,
  options: { isIeltsFlow?: boolean; isSaveMyExams?: boolean } = {}
): ExtractedQuestion[] {
  const questionMap = new Map<string, ExtractedQuestion>();
  const normSubKey = (id: string) => (id || '').replace(/[().\s]/g, '').toLowerCase();
  const isIeltsFlow = Boolean(options.isIeltsFlow);
  const isSaveMyExams = Boolean(options.isSaveMyExams);

  const inferIeltsSkillPrefix = (qNum: string, topic?: string | null): 'L' | 'R' | 'W' | '' => {
    const m = qNum.match(/^([LRW])\s*\d/i);
    if (m) return m[1].toUpperCase() as 'L' | 'R' | 'W';
    const t = (topic || '').toLowerCase();
    if (t.includes('listening')) return 'L';
    if (t.includes('reading')) return 'R';
    if (t.includes('writing')) return 'W';
    return '';
  };

  chunkQuestions.forEach((questionsInChunk, cIdx) => {
    const chunkOffset = (chunksMeta[cIdx]?.startPage || 1) - 1;
    questionsInChunk.forEach((q) => {
      if (isPhantomEmptyQuestion(q)) return;

      let qNumClean = normalizeChunkQuestionNumber(q.question_number) || String(q.question_number || '').trim();
      const skillPrefix = isIeltsFlow ? inferIeltsSkillPrefix(qNumClean, q.topic) : '';
      if (isIeltsFlow && skillPrefix && !/^[LRW]\s*\d/i.test(qNumClean)) {
        qNumClean = `${skillPrefix}${qNumClean}`;
      }
      if (isSaveMyExams) {
        const sec = chunksMeta[cIdx]?.targetSection || q.estimated_difficulty || 'Easy';
        if (!/^(?:easy|medium|hard)\s*[-:]/i.test(qNumClean)) {
          qNumClean = `${sec} - ${qNumClean}`;
        }
      }
      const mergeKey = isIeltsFlow ? `${skillPrefix || 'Q'}::${qNumClean}` : qNumClean;
      const adjustedQ: ExtractedQuestion = {
        ...q,
        question_number: qNumClean,
        page_number: (q.page_number || 1) + chunkOffset,
        sub_questions: (q.sub_questions || []).map((sq) => ({
          ...sq,
          page_number: sq.page_number ? sq.page_number + chunkOffset : (q.page_number || 1) + chunkOffset,
        })),
      };

      if (!questionMap.has(mergeKey)) {
        questionMap.set(mergeKey, adjustedQ);
      } else {
        const existing = questionMap.get(mergeKey)!;
        const mergedSubMap = new Map<string, SubQuestion>();
        (existing.sub_questions || []).forEach((sq) => {
          const k = normSubKey(sq.sub_id) || sq.sub_id;
          mergedSubMap.set(k, sq);
        });

        const anyAdjustedSubHasDiagram = (adjustedQ.sub_questions || []).some(
          (s) => s.has_diagram || (Array.isArray(s.bounding_box) && s.bounding_box.length >= 4)
        );
        let assignedContinuationDiagram = false;

        (adjustedQ.sub_questions || []).forEach((sq) => {
          const k = normSubKey(sq.sub_id) || sq.sub_id;
          const prev = mergedSubMap.get(k);
          if (!prev) {
            const promoteContinuationDiagram =
              !assignedContinuationDiagram &&
              !anyAdjustedSubHasDiagram &&
              Boolean(adjustedQ.has_diagram && adjustedQ.bounding_box) &&
              (adjustedQ.page_number || 1) > (existing.page_number || 1);

            if (promoteContinuationDiagram) {
              assignedContinuationDiagram = true;
            }

            mergedSubMap.set(k, {
              ...sq,
              page_number: sq.page_number || adjustedQ.page_number,
              has_diagram: Boolean(sq.has_diagram || promoteContinuationDiagram),
              diagram_source: sq.diagram_source || (promoteContinuationDiagram ? adjustedQ.diagram_source || 'qp' : null),
              resource_ref: sq.resource_ref || (promoteContinuationDiagram ? adjustedQ.resource_ref : null),
              bounding_box: sq.bounding_box || (promoteContinuationDiagram ? adjustedQ.bounding_box : null),
            });
          } else {
            const sqHasNewDiagram = !prev.has_diagram && Boolean(sq.has_diagram);
            mergedSubMap.set(k, {
              ...prev,
              page_number: sqHasNewDiagram ? (sq.page_number || prev.page_number) : (prev.page_number || sq.page_number),
              question_text:
                sq.question_text && sq.question_text.length > (prev.question_text?.length || 0)
                  ? sq.question_text
                  : prev.question_text,
              marks: sq.marks || prev.marks,
              mark_scheme: chooseBetterSubMarkScheme(
                prev.mark_scheme,
                sq.mark_scheme,
                sq.marks || prev.marks
              ),
              options: sq.options && sq.options.length > 0 ? sq.options : prev.options,
              data_tables: prev.data_tables && prev.data_tables.length > 0 ? prev.data_tables : sq.data_tables,
              has_diagram: prev.has_diagram || sq.has_diagram,
              diagram_source: prev.diagram_source || sq.diagram_source,
              resource_ref: prev.resource_ref || sq.resource_ref,
              diagram_type: prev.diagram_type || sq.diagram_type,
              bounding_box: prev.bounding_box || sq.bounding_box,
            });
          }
        });

        const mergedSubs = Array.from(mergedSubMap.values()).sort((a, b) => {
          const ka = normSubKey(a.sub_id);
          const kb = normSubKey(b.sub_id);
          return ka.localeCompare(kb, undefined, { numeric: true });
        });

        const totalSubMarks = mergedSubs.reduce((sum, s) => sum + (Number(s.marks) || 0), 0);
        const isAdjustedContinuation =
          (adjustedQ.sub_questions && adjustedQ.sub_questions.length > 0) &&
          !adjustedQ.sub_questions.some((s) => normSubKey(s.sub_id) === 'a' || normSubKey(s.sub_id).startsWith('a'));

        const existingLen = (existing.question_text || '').trim().length;
        const adjustedLen = (adjustedQ.question_text || '').trim().length;

        let chosenQuestionText = existing.question_text || '';
        if (adjustedLen > existingLen) {
          if (
            !isAdjustedContinuation ||
            adjustedQ.question_text?.toLowerCase().includes('experiment') ||
            adjustedLen > existingLen + 150
          ) {
            chosenQuestionText = adjustedQ.question_text || existing.question_text || '';
          }
        } else if (!chosenQuestionText && adjustedQ.question_text) {
          chosenQuestionText = adjustedQ.question_text;
        }

        const combinedTables = [...(existing.data_tables || []), ...(adjustedQ.data_tables || [])];
        const uniqueTablesMap = new Map<string, any>();
        combinedTables.forEach((t, idx) => {
          const key = (t?.id || t?.title || `tbl_${idx}`).toLowerCase().trim();
          if (!uniqueTablesMap.has(key)) uniqueTablesMap.set(key, t);
        });
        const mergedDataTables = uniqueTablesMap.size > 0 ? Array.from(uniqueTablesMap.values()) : undefined;

        const adoptAdjustedParentDiagram =
          !existing.has_diagram &&
          Boolean(adjustedQ.has_diagram) &&
          !assignedContinuationDiagram &&
          !anyAdjustedSubHasDiagram &&
          (adjustedQ.page_number === existing.page_number || !existing.page_number);

        questionMap.set(mergeKey, {
          ...existing,
          passage_ref: existing.passage_ref || adjustedQ.passage_ref || null,
          page_number: adoptAdjustedParentDiagram ? (adjustedQ.page_number || existing.page_number) : existing.page_number,
          question_text: chosenQuestionText,
          options:
            adjustedQ.options && adjustedQ.options.length > (existing.options?.length || 0)
              ? adjustedQ.options
              : existing.options,
          data_tables: mergedDataTables,
          mark_scheme:
            chooseBetterMarkScheme(
              existing.mark_scheme,
              adjustedQ.mark_scheme,
              totalSubMarks > 0
                ? totalSubMarks
                : Math.max(existing.total_marks || 0, adjustedQ.total_marks || 0)
            ) ?? null,
          total_marks: totalSubMarks > 0 ? totalSubMarks : Math.max(existing.total_marks || 0, adjustedQ.total_marks || 0),
          sub_questions: mergedSubs.length > 0 ? mergedSubs : existing.sub_questions,
          has_diagram: existing.has_diagram || adoptAdjustedParentDiagram,
          diagram_source: existing.diagram_source || (adoptAdjustedParentDiagram ? adjustedQ.diagram_source : null),
          resource_ref: existing.resource_ref || (adoptAdjustedParentDiagram ? adjustedQ.resource_ref : null),
          bounding_box: existing.bounding_box || (adoptAdjustedParentDiagram ? adjustedQ.bounding_box : null),
        });
      }
    });
  });

  const allQuestions = Array.from(questionMap.values());
  allQuestions.sort((a, b) => compareQuestionNumbers(a.question_number, b.question_number));
  return allQuestions;
}

/**
 * Ensures Practical Exam Questions (Cambridge Paper 5 & 6) do not have Question 2
 * (Qualitative Analysis) mistakenly grouped into Question 1 (Calorimetry /
 * Thermochemistry). Implemented as a pure function in practicalPostProcess.ts —
 * the caller's array is never mutated — and re-exported here for existing callers.
 */
export { separatePracticalQuestions };

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
  hasMarkScheme: boolean;
  msBase64?: string;
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
    let msBytesForVisualScan: Uint8Array | undefined;

    // Cambridge mark schemes open with 4–6 pages of generic marking principles that are
    // identical across papers; send only the answer-table pages (Phase 4).
    if (markSchemeFile) {
      try {
        const msBytes = new Uint8Array(await markSchemeFile.arrayBuffer());
        msBytesForVisualScan = msBytes;
        const trimmedMs = await trimMarkSchemePreamble(msBytes, { domain: options.domain });
        if (trimmedMs.trimmed) {
          msBytesForVisualScan = trimmedMs.bytes;
          msBase64 = uint8ArrayToBase64(trimmedMs.bytes);
          onStateChange({
            stage: 'extracting',
            message: `Mark scheme: skipped ${trimmedMs.startPage - 1} preamble page(s) of ${trimmedMs.totalPages} — sending only the answer tables…`,
            progress: 18,
            result: null,
            error: null,
          });
        }
      } catch (error) {
        console.warn('[pdfProcessor] mark scheme trim failed, sending the full mark scheme:', error);
      }
    }

    const insertBase64 = insertFile ? await fileToBase64(insertFile) : undefined;
    let bytesToChunk: File | Uint8Array = file;

    // If no separate mark scheme was provided, check if the PDF contains an embedded answer key at the back
    if (!markSchemeFile) {
      const splitInfo = await detectAndSplitInDocumentAnswerKey(file);
      if (splitInfo.hasAnswerKey && splitInfo.msBase64) {
        bytesToChunk = splitInfo.qpDocBytes;
        msBase64 = splitInfo.msBase64;
        try {
          const bin = atob(splitInfo.msBase64);
          const decoded = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) decoded[i] = bin.charCodeAt(i);
          msBytesForVisualScan = decoded;
        } catch {
          // Non-fatal: fall back to raw msBase64
        }
        onStateChange({
          stage: 'extracting',
          message: `Detected embedded Answer Key (Pages ${splitInfo.msStartPage}–${splitInfo.msEndPage}) — matching with Question Paper (Pages 1–${splitInfo.qpEndPage})…`,
          progress: 25,
          result: null,
          error: null,
        });
      }
    }

    // Scan Question Paper (and compact Mark Scheme) for Arabic script so affected chunks bypass
    // corrupted PDF ToUnicode text streams via lossless 2.8x PNG page images.
    const arabicPages = await detectArabicPagesInPdf(bytesToChunk);
    const msPageTexts = msBytesForVisualScan
      ? await readPdfPageTexts(msBytesForVisualScan)
      : [];
    const msArabicPages = msBytesForVisualScan
      ? await detectArabicPagesInPdf(msBytesForVisualScan, msPageTexts)
      : new Set<number>();
    const officialMcqKey = msPageTexts.length > 0 ? parseOfficialMcqAnswerKey(msPageTexts) : new Map<string, string>();
    const msMaxArabicPage = msArabicPages.size > 0 ? Math.max(...Array.from(msArabicPages)) : 0;
    const msPageImages =
      msBytesForVisualScan && msMaxArabicPage > 0 && msMaxArabicPage <= 8
        ? await renderPdfPagesToImages(msBytesForVisualScan, 1, msMaxArabicPage)
        : undefined;

    const isSaveMyExams =
      Boolean(options.isSaveMyExams) ||
      (options.domain === 'stem' && (await isSaveMyExamsDocument(bytesToChunk)));

    let chunks: PdfChunk[];
    let smeMeta: SaveMyExamsMeta | undefined;

    if (isSaveMyExams) {
      const smeSplit = await splitSaveMyExamsPdfBySections(bytesToChunk);
      chunks = smeSplit.chunks;
      smeMeta = smeSplit.meta;
      onStateChange({
        stage: 'extracting',
        message: `Detected Save My Exams ${smeMeta.packType === 'theory' ? 'Theory / Structured' : 'MCQ'} assessment pack (${smeMeta.topic || 'STEM'} • ${smeMeta.sections.length} difficulty tiers: ${smeMeta.sections.map((s: any) => s.name).join(', ')} • ${smeMeta.totalExpected ? `${smeMeta.totalExpected} questions` : ''}${smeMeta.totalMarks ? ` / ${smeMeta.totalMarks} marks` : ''})…`,
        progress: 25,
        result: null,
        error: null,
      });
    } else {
      // Dense Language / Reading Comprehension and Arabic-script papers use compact chunks.
      // Arabic visual-PNG papers keep strict 3-page + 1-page overlap chunks (<= 4 PNGs per call).
      const isArabicPdf = arabicPages.size > 0;
      const maxPagesPerChunk = isArabicPdf ? 3 : options.domain === 'languages' ? 4 : 8;
      chunks = await splitPdfForParallelExtraction(
        bytesToChunk,
        maxPagesPerChunk,
        isArabicPdf ? { allowCompactChunks: true, overlapPages: 1 } : undefined
      );
    }

    let result: ExtractionResult;

    // Deterministic outline: build once. It is a *constraint* only for single-chunk runs
    // (a chunked extraction sees a page subset), but the cover metadata it recovers —
    // syllabus, paper code, optional-choice structure — is valid for the whole paper.
    let paperOutline: PaperOutline | null = null;
    if (!isSaveMyExams) {
      try {
        const qpBytes: Uint8Array =
          bytesToChunk instanceof Uint8Array
            ? bytesToChunk
            : new Uint8Array(await bytesToChunk.arrayBuffer());
        paperOutline = await tryBuildPaperOutline(qpBytes);
        if (paperOutline?.usable) {
          const subCount = paperOutline.questions.reduce((a, q) => a + q.subs.filter((s) => !s.isStem).length, 0);
          const constrained = paperOutline.profile.family === 'practical-5x';
          onStateChange({
            stage: 'extracting',
            message: `Outline verified (${paperOutline.profile.key}): ${paperOutline.questions.length} questions · ${subCount} sub-parts · Σ${paperOutline.totalMarks ?? '?'} marks${constrained ? ' — constraining extraction to the printed structure…' : '…'
              }`,
            progress: 40,
            result: null,
            error: null,
          });
        } else if (paperOutline) {
          console.info('[pdfProcessor] outline rejected, using vision-only extraction:', paperOutline.reasons);
        }
      } catch (error) {
        console.warn('[pdfProcessor] outline build failed, using vision-only extraction:', error);
        paperOutline = null;
      }
    }

    // Which syllabus is this? The outline already read the cover, so prefer what the
    // paper printed; otherwise stay neutral instead of assuming Geography 0460.
    const domainChoice = options.domain || 'stem';
    const outlineSubject = subjectForSyllabus(paperOutline?.profile.syllabus);
    const detectedSubject =
      outlineSubject && outlineSubject.domain === domainChoice
        ? outlineSubject
        : domainChoice === 'humanities'
          ? NEUTRAL_HUMANITIES_PROFILE
          : null;
    if (detectedSubject && domainChoice === 'humanities') {
      onStateChange({
        stage: 'extracting',
        message: `Subject detected: ${detectedSubject.subjectName}${/^\d{4}$/.test(detectedSubject.syllabusCode) ? ` (${detectedSubject.syllabusCode})` : ''}`,
        progress: 41,
        result: null,
        error: null,
      });
    }

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
        chunks.map(async (chunk, idx) => {
          const assignedKey = getApiKeyForChunk(idx);
          const keyLabel = isMultiKey ? `Key ${(idx % apiKeys.length) + 1}` : `Part ${idx + 1}/${chunks.length}`;
          const sectionLabel = chunk.targetSection ? `[${chunk.targetSection} Questions • Pages ${chunk.startPage}–${chunk.endPage}]` : `[Pages ${chunk.startPage}–${chunk.endPage}]`;

          const chunkHasArabic =
            detectedSubject?.syllabusCode === 'PAI' ||
            detectedSubject?.syllabusCode === 'BAR' ||
            detectedSubject?.syllabusCode === 'ARA' ||
            Array.from(arabicPages).some((p) => p >= chunk.startPage && p <= chunk.endPage);
          const chunkPageImages = chunkHasArabic
            ? await renderPdfPagesToImages(bytesToChunk, chunk.startPage, chunk.endPage, 2.8, arabicPages)
            : undefined;

          return extractQuestionsFromPdf(
            chunk.pdfBase64,
            msBase64,
            insertBase64,
            (status) => {
              onStateChange({
                stage: 'extracting',
                message: `[${keyLabel} • ${sectionLabel}]: ${status}`,
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
              isSaveMyExams,
              isIeltsCefr: options.domain === 'languages' && Boolean(options.isIeltsCefr),
              saveMyExamsPackType: chunk.packType || smeMeta?.packType || 'theory',
              targetSection: chunk.targetSection,
              topicHint: chunk.topicHint || smeMeta?.topic,
              subjectProfile: detectedSubject ?? undefined,
              pageImages: chunkPageImages && chunkPageImages.length > 0 ? chunkPageImages : undefined,
              msPageImages: msPageImages && msPageImages.length > 0 ? msPageImages : undefined,
            }
          );
        })
      );

      const isIeltsFlow = options.domain === 'languages' && Boolean(options.isIeltsCefr);

      // Disambiguate overlapping/reused per-chunk passage IDs ("Text 1" in Chunk 0 vs Chunk 1)
      // BEFORE merging questions so passage_ref never points at a different chunk's reading text.
      const { passages: uniquePassages, chunkQuestions } = mergeChunkPassagesAndQuestions(chunkResults);
      const allQuestions = mergeChunkQuestions(chunkQuestions, chunks, {
        isIeltsFlow,
        isSaveMyExams,
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
      const separated = enforceTableOwnership(separatePracticalQuestions(propagated));
      const normalized = normalizePaper4SubQuestions(normalizeQuestionStyles(separated));
      const finalizedQuestions = normalized.map((q) => ({
        ...q,
        question_text: stripDuplicateSubQuestionsFromStem(
          stripDuplicateOptionsFromStem(q.question_text, q.options),
          q.sub_questions
        ),
        sub_questions: (q.sub_questions || []).map((sq) => ({
          ...sq,
          question_text: stripDuplicateSubIdPrefix(
            sq.sub_id,
            stripDuplicateOptionsFromStem(sq.question_text, sq.options || q.options)
          ),
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

      const baseMeta = chunkResults[0]?.paper_metadata || {
        subject:
          detectedSubject?.subjectName ??
          (options.domain === 'languages'
            ? 'English'
            : options.domain === 'humanities'
              ? 'Humanities'
              : 'Chemistry'),
        subject_code:
          detectedSubject?.syllabusCode ??
          (options.domain === 'languages'
            ? 'ENG'
            : options.domain === 'humanities'
              ? 'HUM'
              : options.isIgcse !== false
                ? '0620'
                : 'CHEM'),
        year: new Date().getFullYear(),
        series: isSaveMyExams ? 'Save My Exams' : options.isIgcse !== false ? 'Exam' : 'General',
        paper_number: isSaveMyExams
          ? smeMeta?.packType === 'theory'
            ? 'Theory'
            : 'MCQ'
          : Number(paperOutline?.profile.paperCode) || 1,
        has_insert_booklet: Boolean(insertFile),
      };

      result = {
        paper_metadata: {
          ...baseMeta,
          cambridge_hub_url: options.cambridgeHubUrl || baseMeta.cambridge_hub_url || null,
          cambridge_ms_hub_url: options.cambridgeMsHubUrl || baseMeta.cambridge_ms_hub_url || null,
        },
        questions: finalizedQuestions,
        insert_resources: uniqueInsertResources.length > 0 ? uniqueInsertResources : undefined,
        passages: verifiedPassages.length > 0 ? verifiedPassages : undefined,
      };
    } else {
      // Single chunk for short documents
      const singleChunkHasArabic =
        detectedSubject?.syllabusCode === 'PAI' ||
        detectedSubject?.syllabusCode === 'BAR' ||
        detectedSubject?.syllabusCode === 'ARA' ||
        arabicPages.size > 0;
      const singlePageImages = singleChunkHasArabic
        ? await renderPdfPagesToImages(bytesToChunk, chunks[0].startPage, chunks[0].endPage, 2.8, arabicPages)
        : undefined;

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
          isSaveMyExams,
          isIeltsCefr: options.domain === 'languages' && Boolean(options.isIeltsCefr),
          saveMyExamsPackType: chunks[0]?.packType || smeMeta?.packType || 'theory',
          targetSection: chunks[0]?.targetSection,
          topicHint: chunks[0]?.topicHint || smeMeta?.topic,
          paperOutline: chunks.length === 1 ? paperOutline ?? undefined : undefined,
          subjectProfile: detectedSubject ?? undefined,
          pageImages: singlePageImages && singlePageImages.length > 0 ? singlePageImages : undefined,
          msPageImages: msPageImages && msPageImages.length > 0 ? msPageImages : undefined,
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
      const separated = enforceTableOwnership(separatePracticalQuestions(stitched));
      result.questions = normalizePaper4SubQuestions(
        normalizeQuestionStyles(propagateReadingPassages(separated))
      ).map((q) => ({
        ...q,
        question_text: stripDuplicateSubQuestionsFromStem(
          stripDuplicateOptionsFromStem(q.question_text, q.options),
          q.sub_questions
        ),
        sub_questions: (q.sub_questions || []).map((sq) => ({
          ...sq,
          question_text: stripDuplicateSubIdPrefix(
            sq.sub_id,
            stripDuplicateOptionsFromStem(sq.question_text, sq.options || q.options)
          ),
        })),
      }));
      result.passages = verifiedPassages.length > 0 ? verifiedPassages : undefined;
    }

    // Reconcile extracted MCQs with deterministic Official MCQ Mark Scheme key when present
    // so valid MCQs are never mis-flagged [NOT IN MARK SCHEME — AI SOLVED] across script labels.
    if (officialMcqKey.size > 0) {
      result.questions = reconcileQuestionsWithOfficialMcqKey(result.questions, officialMcqKey);
    }

    // Optional-choice papers: record which questions are alternatives, so the test
    // builder and exports understand that Q2/Q3 are not both required.
    const optionGroups = paperOutline?.profile.optionGroups;
    if (optionGroups) {
      result.questions = result.questions.map((q) => {
        const number = Number(String(q.question_number).replace(/\D/g, ''));
        const label = optionGroups[number];
        if (!label) return q;
        const existing = (typeof q.mark_scheme === 'object' && q.mark_scheme !== null ? q.mark_scheme : {}) as Record<string, unknown>;
        return {
          ...q,
          mark_scheme: { ...existing, _option_group: label } as unknown as typeof q.mark_scheme,
        };
      });
      onStateChange({
        stage: 'extracting',
        message: `Optional-choice paper: ${Object.values(optionGroups)[0] ?? 'alternative questions'} — all questions kept in the bank.`,
        progress: 66,
        result: null,
        error: null,
      });
    }

    // Practical papers: attach the qualitative-analysis notes pages (11–12) as
    // Resource Booklet items, so Question 2 can open them during the exam.
    if (paperOutline?.usable && paperOutline.profile.family === 'practical-5x') {
      const noteCatalog = buildQualitativeNotesResources(paperOutline);
      if (noteCatalog.length) {
        try {
          const qpBytes: Uint8Array =
            bytesToChunk instanceof Uint8Array
              ? bytesToChunk
              : new Uint8Array(await bytesToChunk.arrayBuffer());
          const rendered = await renderNotePagesToDataUrls(qpBytes, noteCatalog, (bytes, pageNumber) =>
            renderPdfPageToCanvas(
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
              pageNumber,
              2,
            ),
          );
          const byId = new Map([...(result.insert_resources ?? []), ...rendered].map((item) => [item.id, item]));
          result.insert_resources = Array.from(byId.values());
          console.info(`[pdfProcessor] attached ${rendered.length} qualitative-notes page(s) as resources`);
        } catch (error) {
          console.warn('[pdfProcessor] qualitative notes rendering failed:', error);
          result.insert_resources = [...(result.insert_resources ?? []), ...noteCatalog];
        }
      }
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

    return {
      result,
      diagramData,
      previewUrls,
      hasMarkScheme: Boolean(msBase64),
      msBase64,
    };
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
