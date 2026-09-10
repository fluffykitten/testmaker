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
export function classifyQuestion(q: Question): {
  action: 'generate' | 'skip';
  reason?: string;
  isPhotoReused?: boolean;
} {
  // Audio questions cannot be auto-synthesized cleanly
  if (q.audio_url || (q.audio_metadata && q.audio_metadata.duration)) {
    return {
      action: 'skip',
      reason: 'Audio/listening track cannot be automatically synthesized',
    };
  }

  // Multi-question passage dependency
  const rawQ = q as any;
  if (rawQ.passage_ref && rawQ.is_shared_passage) {
    return {
      action: 'skip',
      reason: 'Shared multi-question reading passage',
    };
  }

  // Photograph-dependent questions: reuse existing image asset with newly generated questions
  const hasPhotoMention =
    /photo/i.test(q.resource_ref || '') ||
    /(?:photograph|micrograph|photo\b|specimen)/i.test(q.question_text || '') ||
    q.sub_questions?.some(
      (s) =>
        s.diagram_type === 'photo' ||
        /photo/i.test(s.resource_ref || '') ||
        /(?:photograph|micrograph|photo\b|specimen)/i.test(s.question_text || '')
    );

  const isPhoto =
    q.diagram_type === 'photo' ||
    hasPhotoMention ||
    (Boolean(q.diagram_url) &&
      !q.svg_content &&
      !extractSvgFromDiagramUrl(q.diagram_url) &&
      /(\.png|\.jpe?g|\.webp|photo|micrograph)/i.test(q.diagram_url || ''));

  if (isPhoto) {
    return {
      action: 'generate',
      isPhotoReused: true,
    };
  }

  return {
    action: 'generate',
  };
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
    marks: generated.marks !== undefined ? generated.marks : original.marks,
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

/**
 * Generates a full parallel twin exam batch with concurrency control and progress tracking.
 */
export async function generateExamVariantBatch(
  questions: Question[],
  options: VariantBatchOptions
): Promise<VariantBatchResult> {
  const items: VariantGenerationItem[] = questions.map((q, idx) => {
    const classification = classifyQuestion(q);
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
          const selectedApiKey = getApiKeyForChunk(item.index);

          // Build directive
          const isImageGenActive = options.generateAiDiagrams ?? getSavedSettings().enableVariantImageGeneration ?? false;
          let combinedInstruction = options.globalDirective?.trim() || '';
          if (item.isPhotoReused && isImageGenActive) {
            const photoNote = `CRITICAL MANDATORY VISUAL ASSET REUSE: This question references an existing photograph/micrograph/specimen (${item.originalQuestion.resource_ref || 'Photograph/Figure'}). Maintain this exact reference. Do NOT generate SVG. Formulate a NEW, DIFFERENT question and mark scheme that tests a different structure, calculation (e.g. magnification/scale/actual size), observation, or scientific concept based on this same visual resource.`;
            combinedInstruction = combinedInstruction ? `${combinedInstruction}\n\n${photoNote}` : photoNote;
          }

          const generated = await generateQuestionVariant(item.originalQuestion, {
            mode: 'parallel',
            customInstruction: combinedInstruction || undefined,
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

          // AI Diagram Generation for altered apparatus/schematics when SVG is absent and not a photo reuse
          if (
            options.generateAiDiagrams &&
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
                item.isAiDiagramGenerated = true;
              }
            } catch (diagErr) {
              console.warn(`[examVariantService] Diagram generation skipped for Q${item.index + 1}:`, diagErr);
            }
          }

          item.variantQuestion = normalized;
          item.status = 'done';
          item.errorMessage = undefined;
          success = true;
          notifyProgress();
        } catch (err: any) {
          const errMsg = err?.message || String(err);
          const isRateLimit = errMsg.includes('429') || errMsg.toLowerCase().includes('quota') || errMsg.toLowerCase().includes('rate limit');

          if (isRateLimit && attempts < maxAttempts) {
            const delayMs = Math.pow(2, attempts) * 1000 + Math.random() * 500;
            console.warn(`[examVariantService] Rate limit encountered for Q${item.index + 1}, retrying in ${Math.round(delayMs)}ms...`);
            await new Promise((res) => setTimeout(res, delayMs));
          } else if (attempts >= maxAttempts) {
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
  const selectedApiKey = getApiKeyForChunk(item.index);

  let combinedInstruction = [options?.globalDirective, options?.tweakDirective]
    .filter(Boolean)
    .map((s) => s!.trim())
    .join('\n\n');

  const isImageGenActive = options?.generateAiDiagrams ?? getSavedSettings().enableVariantImageGeneration ?? false;
  if (item.isPhotoReused && isImageGenActive) {
    const photoNote = `CRITICAL MANDATORY VISUAL ASSET REUSE: This question references an existing photograph/specimen (${item.originalQuestion.resource_ref || 'Photograph/Figure'}). Maintain this exact reference. Do NOT generate SVG. Formulate a NEW, DIFFERENT question and mark scheme testing a different structure, calculation (e.g. magnification/scale), observation, or scientific concept based on this same visual resource.`;
    combinedInstruction = combinedInstruction ? `${combinedInstruction}\n\n${photoNote}` : photoNote;
  }

  const generated = await generateQuestionVariant(item.originalQuestion, {
    mode: 'parallel',
    customInstruction: combinedInstruction || undefined,
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
    options?.generateAiDiagrams &&
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

  return {
    ...item,
    status: 'done',
    variantQuestion: normalized,
    errorMessage: undefined,
    useOriginal: false,
    isAiDiagramGenerated: isAiDiagramGenerated || item.isAiDiagramGenerated,
  };
}

/**
 * Persists the generated variant questions to Supabase, then creates the CustomTest record.
 */
export async function persistVariantExam(
  items: VariantGenerationItem[],
  originalHeaderConfig: ExamHeaderConfig,
  newTitle: string
): Promise<CustomTest> {
  const resolvedQuestionIds: string[] = [];
  let totalMarks = 0;

  for (const item of items) {
    // If the teacher elected to use original, or generation failed/skipped, keep original UUID
    if (item.useOriginal || item.status === 'skipped' || item.status === 'failed' || !item.variantQuestion) {
      resolvedQuestionIds.push(item.originalQuestion.id);
      totalMarks += Number(item.originalQuestion.marks) || 1;
      continue;
    }

    // Persist new variant question to Supabase
    const saved = await createQuestion(item.variantQuestion);
    if (saved && saved.id) {
      resolvedQuestionIds.push(saved.id);
      totalMarks += Number(saved.marks) || Number(item.variantQuestion.marks) || 1;
    } else {
      // Fallback to original question ID if saving fails
      console.warn(`[examVariantService] createQuestion fallback to original for Q${item.index + 1}`);
      resolvedQuestionIds.push(item.originalQuestion.id);
      totalMarks += Number(item.originalQuestion.marks) || 1;
    }
  }

  // Update header config for Set B
  const updatedHeaderConfig: ExamHeaderConfig = {
    ...originalHeaderConfig,
    title: newTitle,
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

  return savedTest;
}
