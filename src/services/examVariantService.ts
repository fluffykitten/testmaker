// ─── Exam Variant Service ──────────────────────────────────────────────────
// Orchestrates batch generation of parallel twin exams (e.g. Set B)
// with concurrency control, API key rotation, exponential backoff,
// photo asset reuse, and Supabase persistence.

import type { Question, CustomTest } from '../types/database';
import type { ExamHeaderConfig } from './testBuilderService';
import { saveCustomTest } from './testBuilderService';
import { createQuestion } from './questionBankService';
import {
  generateQuestionVariant,
  stripDuplicateSubQuestionsFromStem,
  stripDuplicateOptionsFromStem,
  extractSvgFromDiagramUrl,
  getApiKeyForChunk,
} from '../lib/gemini';
import { generateExamDiagram } from './imageGenerationService';
import { getSavedSettings } from '../lib/settings';
import {
  buildSharedPassageRefSet,
  classifyQuestionForVariant,
  pruneQuestionOverridesForVariantSet,
} from '../utils/variantClassification';

export type VariantGenerationStatus = 'pending' | 'generating' | 'done' | 'failed' | 'skipped';

export interface VariantGenerationItem {
  originalQuestion: Question;
  index: number;
  status: VariantGenerationStatus;
  variantQuestion: Question | null;
  errorMessage?: string;
  skipReason?: string;
  isPhotoReused?: boolean;
  isAiDiagramGenerated?: boolean;
  useOriginal?: boolean; // When true, the teacher chose to use the original question unchanged
}

export interface VariantBatchOptions {
  title: string;
  globalDirective?: string;
  generateAiDiagrams?: boolean;
  concurrency?: number;
  onProgress?: (items: VariantGenerationItem[]) => void;
  signal?: AbortSignal;
}

export interface VariantBatchResult {
  items: VariantGenerationItem[];
  completedCount: number;
  failedCount: number;
  skippedCount: number;
}

/**
 * Strips 'V', ' (Variant)', or temp prefixes to give clean sequential numbers for Set B.
 */
export function cleanQuestionNumber(rawNumber: string | undefined | null, fallbackIndex: number): string {
  if (!rawNumber || typeof rawNumber !== 'string') {
    return String(fallbackIndex + 1);
  }
  const cleaned = rawNumber
    .replace(/\s*\((?:Variant|Parallel|Set\s*[B-Z])\)/gi, '')
    .replace(/V$/i, '')
    .trim();
  return cleaned || String(fallbackIndex + 1);
}

/**
 * Classifies a question for parallel generation.
 * - Audio tracks: Skipped (cannot auto-generate matching audio recordings).
 * - Shared multi-question passages: Skipped (avoid desynchronizing shared texts).
 * - Photographs: Generatable with Visual Asset Reuse (same photo, new question & mark scheme).
 * - Standard/Diagram questions: Generatable with AI twin values & SVGs.
 */
export function classifyQuestion(
  q: Question,
  allQuestions?: Question[],
  sharedRefs?: Set<string>
): {
  action: 'generate' | 'skip';
  reason?: string;
  isPhotoReused?: boolean;
} {
  return classifyQuestionForVariant(q, allQuestions, sharedRefs);
}

/**
 * Normalizes a raw AI-generated variant partial into a complete, valid Question object.
 */
export function constructNormalizedVariant(
  original: Question,
  generated: Partial<Question>,
  cleanNumber: string,
  isPhotoReused?: boolean,
  isImageGenEnabled: boolean = Boolean(getSavedSettings().enableVariantImageGeneration)
): Question {
  const finalSubs = generated.sub_questions || [];
  const cleanStem = stripDuplicateSubQuestionsFromStem(
    stripDuplicateOptionsFromStem(generated.question_text || '', generated.options),
    finalSubs
  );

  let resolvedSvg: string | null = null;
  let resolvedDiagramUrl: string | null = null;
  let resolvedDiagramType = generated.diagram_type || original.diagram_type || null;

  if (isPhotoReused || !isImageGenEnabled) {
    // For photo questions or when image generation is disabled, always retain original diagram and SVG
    resolvedSvg = original.svg_content || extractSvgFromDiagramUrl(original.diagram_url) || null;
    resolvedDiagramUrl = original.diagram_url || (resolvedSvg ? `data:image/svg+xml;utf8,${encodeURIComponent(resolvedSvg)}` : null);
    resolvedDiagramType = isPhotoReused ? 'photo' : (original.diagram_type || null);
  } else {
    resolvedSvg =
      generated.svg_content ||
      extractSvgFromDiagramUrl(generated.diagram_url) ||
      extractSvgFromDiagramUrl(original.diagram_url) ||
      null;

    resolvedDiagramUrl =
      generated.diagram_url ||
      (resolvedSvg ? `data:image/svg+xml;utf8,${encodeURIComponent(resolvedSvg)}` : (original.diagram_url || null));
  }

  const normalizedSubs = finalSubs.map((sub, idx) => {
    const origSub = original.sub_questions?.find((os) => os.sub_id === sub.sub_id) || original.sub_questions?.[idx];
    if (!isImageGenEnabled) {
      return {
        ...sub,
        svg_content: origSub?.svg_content || (origSub?.diagram_url ? extractSvgFromDiagramUrl(origSub.diagram_url) : null),
        diagram_url: origSub?.diagram_url || null,
        ai_diagram_prompt: null,
      };
    }
    return sub;
  });

  return {
    ...original,
    id: `variant-temp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    question_number: cleanNumber,
    question_text: cleanStem || original.question_text,
    question_style: generated.question_style || original.question_style || 'Structured',
    difficulty: generated.difficulty || original.difficulty || 'Medium',
    marks: Number(original.marks) > 0 ? original.marks : (generated.marks ?? 1),
    options: Array.isArray(generated.options) ? generated.options : (generated.question_style === 'Multiple Choice' ? original.options : null),
    sub_questions: normalizedSubs,
    mark_scheme: (generated.mark_scheme as any) || original.mark_scheme,
    data_tables: generated.data_tables || original.data_tables,
    scratchpad: generated.scratchpad,
    svg_content: resolvedSvg,
    diagram_url: resolvedDiagramUrl,
    diagram_type: resolvedDiagramType,
    ai_diagram_prompt: isImageGenEnabled ? (generated.ai_diagram_prompt || null) : null,
    diagram_source: original.diagram_source || null,
    resource_ref: original.resource_ref || null,
    insert_page_number: original.insert_page_number || null,
    audio_url: original.audio_url || null,
    audio_metadata: original.audio_metadata || null,
    created_at: new Date().toISOString(),
  };
}

function buildVariantDirective(
  item: VariantGenerationItem,
  directives: Array<string | undefined>,
  isImageGenActive: boolean
): string | undefined {
  const parts = directives.filter(Boolean).map((s) => s!.trim()).filter(Boolean);
  const hasAnyVisual = Boolean(
    item.originalQuestion.diagram_url ||
      item.originalQuestion.svg_content ||
      item.originalQuestion.sub_questions?.some((s) => s.diagram_url || s.svg_content)
  );

  if (item.isPhotoReused) {
    parts.push(
      `CRITICAL MANDATORY VISUAL ASSET REUSE: This question references an existing photograph/micrograph/specimen (${item.originalQuestion.resource_ref || 'Photograph/Figure'}). Maintain this exact visual unchanged and do NOT generate SVG or invent unseen labels/features. Ground every label, reading, and concept strictly in what is visibly shown in the attached image.`
    );
  } else if (hasAnyVisual && !isImageGenActive) {
    parts.push(
      `VISUAL GROUNDING: Retain the original diagram (${item.originalQuestion.resource_ref || 'attached visual'}) unchanged. Do NOT invent labels, scale numbers, or components that contradict what is shown in the attached image.`
    );
  }

  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

async function generateNormalizedVariantForItem(
  item: VariantGenerationItem,
  options: {
    directives: Array<string | undefined>;
    generateAiDiagrams?: boolean;
  }
): Promise<{ normalized: Question; isAiDiagramGenerated: boolean }> {
  const selectedApiKey = getApiKeyForChunk(item.index);
  const isImageGenActive = options.generateAiDiagrams ?? getSavedSettings().enableVariantImageGeneration ?? false;
  const combinedInstruction = buildVariantDirective(item, options.directives, isImageGenActive);

  const generated = await generateQuestionVariant(item.originalQuestion, {
    mode: 'parallel',
    customInstruction: combinedInstruction,
    apiKey: selectedApiKey || undefined,
    enableImageGeneration: isImageGenActive,
  });

  const cleanNum = cleanQuestionNumber(item.originalQuestion.question_number, item.index);
  const normalized = constructNormalizedVariant(
    item.originalQuestion,
    generated,
    cleanNum,
    item.isPhotoReused,
    isImageGenActive
  );

  let isAiDiagramGenerated = false;
  if (
    isImageGenActive &&
    generated.ai_diagram_prompt &&
    !normalized.svg_content &&
    !item.isPhotoReused
  ) {
    try {
      const diagRes = await generateExamDiagram(generated.ai_diagram_prompt, {
        topic: item.originalQuestion.topic,
      });
      if (diagRes.success && diagRes.url) {
        normalized.diagram_url = diagRes.url;
        normalized.svg_content = null;
        normalized.diagram_type = 'apparatus';
        normalized.ai_diagram_prompt = generated.ai_diagram_prompt;
        isAiDiagramGenerated = true;
      }
    } catch (diagErr) {
      console.warn(`[examVariantService] Diagram generation skipped for Q${item.index + 1}:`, diagErr);
    }
  }

  return { normalized, isAiDiagramGenerated };
}

/**
 * Generates a full parallel twin exam batch with concurrency control and progress tracking.
 */
export async function generateExamVariantBatch(
  questions: Question[],
  options: VariantBatchOptions
): Promise<VariantBatchResult> {
  const sharedRefs = buildSharedPassageRefSet(questions);
  const items: VariantGenerationItem[] = questions.map((q, idx) => {
    const classification = classifyQuestion(q, questions, sharedRefs);
    const cleanNum = cleanQuestionNumber(q.question_number, idx);

    if (classification.action === 'skip') {
      return {
        originalQuestion: q,
        index: idx,
        status: 'skipped',
        variantQuestion: {
          ...q,
          question_number: cleanNum,
        },
        skipReason: classification.reason,
      };
    }

    return {
      originalQuestion: q,
      index: idx,
      status: 'pending',
      variantQuestion: null,
      isPhotoReused: classification.isPhotoReused,
    };
  });

  const notifyProgress = () => {
    if (options.onProgress) {
      options.onProgress([...items]);
    }
  };

  notifyProgress();

  const concurrency = Math.max(1, Math.min(options.concurrency || 2, 4));
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      if (options.signal?.aborted) break;

      const currentIdx = cursor++;
      const item = items[currentIdx];

      if (!item || item.status !== 'pending') continue;

      item.status = 'generating';
      notifyProgress();

      let attempts = 0;
      const maxAttempts = 3;
      let success = false;

      while (attempts < maxAttempts && !success) {
        if (options.signal?.aborted) {
          item.status = 'pending';
          notifyProgress();
          return;
        }

        attempts++;
        try {
          const { normalized, isAiDiagramGenerated } = await generateNormalizedVariantForItem(item, {
            directives: [options.globalDirective],
            generateAiDiagrams: options.generateAiDiagrams,
          });

          item.variantQuestion = normalized;
          item.isAiDiagramGenerated = isAiDiagramGenerated;
          item.status = 'done';
          item.errorMessage = undefined;
          success = true;
          notifyProgress();
        } catch (err: any) {
          const errMsg = err?.message || String(err);
          const isRateLimit = errMsg.includes('429') || errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('rate limit');

          if (attempts < maxAttempts) {
            const delayMs = isRateLimit
              ? Math.pow(2, attempts) * 1000 + Math.random() * 500
              : 600 * attempts;
            console.warn(
              `[examVariantService] Attempt ${attempts} failed for Q${item.index + 1} (${isRateLimit ? 'rate limit' : 'transient'}), retrying in ${Math.round(delayMs)}ms...`
            );
            await new Promise((res) => setTimeout(res, delayMs));
          } else {
            console.error(`[examVariantService] Failed to generate variant for Q${item.index + 1}:`, errMsg);
            item.status = 'failed';
            item.errorMessage = errMsg;
            notifyProgress();
          }
        }
      }
    }
  }

  const workerPromises: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) {
    workerPromises.push(worker());
  }

  await Promise.all(workerPromises);

  return {
    items,
    completedCount: items.filter((it) => it.status === 'done').length,
    failedCount: items.filter((it) => it.status === 'failed').length,
    skippedCount: items.filter((it) => it.status === 'skipped').length,
  };
}

/**
 * Regenerates a single question variant (e.g. from the review UI).
 */
export async function regenerateSingleVariant(
  item: VariantGenerationItem,
  options?: {
    globalDirective?: string;
    tweakDirective?: string;
    generateAiDiagrams?: boolean;
  }
): Promise<VariantGenerationItem> {
  const { normalized, isAiDiagramGenerated } = await generateNormalizedVariantForItem(item, {
    directives: [options?.globalDirective, options?.tweakDirective],
    generateAiDiagrams: options?.generateAiDiagrams,
  });

  return {
    ...item,
    status: 'done',
    variantQuestion: normalized,
    errorMessage: undefined,
    useOriginal: false,
    isAiDiagramGenerated: isAiDiagramGenerated || item.isAiDiagramGenerated,
  };
}

export interface PersistVariantExamResult {
  savedTest: CustomTest;
  savedQuestions: Question[];
  updatedHeaderConfig: ExamHeaderConfig;
}

/**
 * Persists the generated variant questions to Supabase, then creates the CustomTest record.
 * Returns both savedTest and the persisted Question[] (with real database UUIDs).
 */
export async function persistVariantExam(
  items: VariantGenerationItem[],
  originalHeaderConfig: ExamHeaderConfig,
  newTitle: string
): Promise<PersistVariantExamResult> {
  const resolvedQuestionIds: string[] = [];
  const savedQuestions: Question[] = [];
  const keptOriginalIds = new Set<string>();
  let totalMarks = 0;

  for (const item of items) {
    // If the teacher elected to use original, or generation failed/skipped, keep original UUID
    if (item.useOriginal || item.status === 'skipped' || item.status === 'failed' || !item.variantQuestion) {
      resolvedQuestionIds.push(item.originalQuestion.id);
      savedQuestions.push(item.originalQuestion);
      keptOriginalIds.add(item.originalQuestion.id);
      totalMarks += Number(item.originalQuestion.marks) || 1;
      continue;
    }

    // Persist new variant question to Supabase
    const saved = await createQuestion(item.variantQuestion);
    if (saved && saved.id) {
      resolvedQuestionIds.push(saved.id);
      savedQuestions.push(saved);
      totalMarks += Number(saved.marks) || Number(item.variantQuestion.marks) || 1;
    } else {
      // Fallback to original question ID if saving fails
      console.warn(`[examVariantService] createQuestion fallback to original for Q${item.index + 1}`);
      resolvedQuestionIds.push(item.originalQuestion.id);
      savedQuestions.push(item.originalQuestion);
      keptOriginalIds.add(item.originalQuestion.id);
      totalMarks += Number(item.originalQuestion.marks) || 1;
    }
  }

  // Update header config for Set B and prune orphaned Set A questionOverrides
  const updatedHeaderConfig: ExamHeaderConfig = {
    ...originalHeaderConfig,
    title: newTitle,
    questionOverrides: pruneQuestionOverridesForVariantSet(
      originalHeaderConfig.questionOverrides,
      keptOriginalIds
    ),
  };

  const savedTest = await saveCustomTest({
    title: newTitle,
    totalMarks,
    questionIds: resolvedQuestionIds,
    headerConfig: updatedHeaderConfig,
  });

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('tests_updated'));
  }

  return { savedTest, savedQuestions, updatedHeaderConfig };
}
