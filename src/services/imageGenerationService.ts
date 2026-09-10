// ─── Cloudflare Workers AI Diagram Generation Service ────────────────────────
// Integrates with @cf/black-forest-labs/flux-1-schnell via Cloudflare Edge Worker
// Automatically manages subject styles (STEM, Geography, History), R2 storage, and daily quota.

import type { Question } from '../types/database';
import { callGeminiWithProxyFallback } from '../lib/gemini';
import { getR2UploadSecret } from './storageService';

const WORKER_ENDPOINT =
  import.meta.env.VITE_CLOUDFLARE_WORKER_URL ||
  import.meta.env.VITE_R2_MEDIA_ENDPOINT ||
  'https://testmaker-media.icmadani.workers.dev';

export type StylePreset = 'stem' | 'geography' | 'history';

export interface DiagramResult {
  success: boolean;
  url?: string;
  key?: string;
  prompt?: string;
  stylePreset?: StylePreset;
  error?: string;
  isQuotaExceeded?: boolean;
}

export interface DiagramGenerationOptions {
  stylePreset?: StylePreset | string;
  topic?: string;
  targetKey?: string;
}

export interface DailyUsageInfo {
  used: number;
  maxDaily: number;
  remaining: number;
  dateKey: string;
}

const STORAGE_KEY = 'testmaker_ai_neuron_usage';
const ESTIMATED_MAX_DAILY_GENERATIONS = 150; // Cloudflare Workers AI free tier gives 10,000 neurons/day (~100-150 Flux-1 generations)

/**
 * Determines the style preset based on question topic / subject name.
 */
export function resolveStylePreset(topicOrSubject?: string): StylePreset {
  if (!topicOrSubject) return 'stem';
  const lower = topicOrSubject.toLowerCase();

  if (
    lower.includes('geograph') ||
    lower.includes('earth') ||
    lower.includes('map') ||
    lower.includes('environmental') ||
    lower.includes('topograph')
  ) {
    return 'geography';
  }

  if (
    lower.includes('hist') ||
    lower.includes('socio') ||
    lower.includes('eng') ||
    lower.includes('lit') ||
    lower.includes('cartoon') ||
    lower.includes('politics') ||
    lower.includes('humanit')
  ) {
    return 'history';
  }

  // Default for STEM: Science, Physics, Chemistry, Biology, Math, Economics/Business graphs, Computer Science
  return 'stem';
}

/**
 * Reads the daily diagram generation count from localStorage.
 */
export function getDailyNeuronUsage(): DailyUsageInfo {
  const todayKey = new Date().toISOString().split('T')[0];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.dateKey === todayKey && typeof parsed.used === 'number') {
        return {
          used: parsed.used,
          maxDaily: ESTIMATED_MAX_DAILY_GENERATIONS,
          remaining: Math.max(0, ESTIMATED_MAX_DAILY_GENERATIONS - parsed.used),
          dateKey: todayKey,
        };
      }
    }
  } catch (e) {
    console.warn('[imageGenerationService] Failed to read quota storage:', e);
  }

  return {
    used: 0,
    maxDaily: ESTIMATED_MAX_DAILY_GENERATIONS,
    remaining: ESTIMATED_MAX_DAILY_GENERATIONS,
    dateKey: todayKey,
  };
}

/**
 * Increments the daily diagram generation counter.
 */
export function recordNeuronUsage(): void {
  const current = getDailyNeuronUsage();
  const nextUsed = current.used + 1;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        dateKey: current.dateKey,
        used: nextUsed,
      })
    );
  } catch (e) {
    console.warn('[imageGenerationService] Failed to save quota storage:', e);
  }
}

/**
 * Generates an exam-ready technical line art diagram via Cloudflare Workers AI (Flux-1-Schnell).
 */
export async function generateExamDiagram(
  prompt: string,
  options?: DiagramGenerationOptions
): Promise<DiagramResult> {
  const cleanPrompt = prompt?.trim();
  if (!cleanPrompt) {
    return { success: false, error: 'Prompt cannot be empty.' };
  }

  const preset: StylePreset =
    (options?.stylePreset as StylePreset) ||
    resolveStylePreset(options?.topic);

  const endpoint = `${WORKER_ENDPOINT.replace(/\/+$/, '')}/api/generate-diagram`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': getR2UploadSecret(),
      },
      body: JSON.stringify({
        prompt: cleanPrompt,
        stylePreset: preset,
        targetKey: options?.targetKey,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (response.ok && data.success) {
      recordNeuronUsage();
      return {
        success: true,
        url: data.url,
        key: data.key,
        prompt: data.prompt,
        stylePreset: data.stylePreset || preset,
      };
    }

    // Workers AI Quota exceeded or error
    return {
      success: false,
      error: data.error || `Server responded with status ${response.status}`,
      isQuotaExceeded: data.isQuotaExceeded || response.status === 429,
    };
  } catch (err: any) {
    console.warn('[imageGenerationService] Workers AI diagram generation failed:', err);
    return {
      success: false,
      error: err.message || 'Failed to connect to Cloudflare Workers AI endpoint.',
    };
  }
}

/**
 * Uses Gemini AI to automatically formulate an optimal diagram prompt from a question.
 * Enforces strict anti-hallucination rules so numbers and text remain exclusively in the question text.
 */
export async function suggestDiagramPrompt(question: Partial<Question>): Promise<string> {
  const topic = question.topic || 'General Science';
  const subTopic = question.sub_topic ? `(${question.sub_topic})` : '';
  const stem = question.question_text || '';
  const subs = question.sub_questions?.map((s) => `${s.sub_id}: ${s.question_text}`).join('; ') || '';

  const prompt = `You are an expert Cambridge/IB exam visual illustrator.
Based on the following exam question context, write a concise, precise visual prompt (under 35 words) describing the apparatus, experimental layout, geological landform, or historical scenario to be drawn as a clean black-and-white exam textbook figure.

CRITICAL ANTI-HALLUCINATION RULES (MANDATORY):
- NEVER request numbers, numerical values, concentrations, temperatures, units, or measurements in the visual prompt (e.g. NEVER write '25.0 cm³', '0.1 M', or '50°C'). Keep all numerical values strictly in the question text.
- Focus strictly on physical objects, connections, spatial geometry, and layout (e.g. 'Conical flask with delivery tube leading to an inverted measuring cylinder over water in a trough').
- If components require labels for student identification, use ONLY single uppercase letters (e.g. 'Flask A', 'Tube B').
- Do NOT include preamble, quotes, or markdown code blocks. Only return the prompt description.

Question Context:
Topic: ${topic} ${subTopic}
Stem: ${stem}
Sub-parts: ${subs}

Description:`;

  try {
    const suggested = await callGeminiWithProxyFallback({
      prompt,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 120,
      },
    });

    return suggested.trim().replace(/^["']|["']$/g, '');
  } catch (err: any) {
    console.warn('[imageGenerationService] Suggest diagram prompt error:', err);
    return `${topic} apparatus setup with labels`;
  }
}
