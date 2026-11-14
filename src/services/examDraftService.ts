// ─── Exam Draft & Cloud Auto-Save Service ────────────────────────────────────
// Manages lightweight in-progress exam snapshots (~5 KB) to allow students to
// recover from crashes or transfer to another computer without consuming Supabase storage.

import { supabase, supabaseUrl, supabaseAnonKey, isSupabaseConfigured } from '../lib/supabase';
import { normalizeIdentityPart } from '../lib/examSubmissionGuards';
import type { SecurityViolationTier, SecurityTierEvent } from '../lib/securityTiers';

export interface ExamDraftPayload {
  quizCode: string;
  quizId: string;
  studentName: string;
  candidateNumber?: string;
  candidateClass?: string;
  studentPin?: string;
  answers: Record<string | number, string | number>;
  currentIndex: number;
  timeLeftSeconds: number;
  startTime: number;
  targetEndTime?: number | null;
  flaggedIndices?: number[];
  audioProgress?: Record<string, { currentTime: number; playedCount: number }>;
  violations?: any[];
  isLockedByProctor?: boolean;
  lockReason?: string;
  lockTime?: string;
  securityTiersSnapshot?: SecurityViolationTier[];
  strikeCount?: number;
  lastStrikeAt?: number | null;
  totalPenaltySeconds?: number;
  tierHistory?: SecurityTierEvent[];
  autoSubmittedBySecurity?: boolean;
  lastSavedAt: string;
  status: 'in_progress' | 'submitted';
}

function getDraftKey(quizCode: string, studentIdentifier: string): string {
  const cleanCode = (quizCode || 'EXAM').trim().toUpperCase();
  const cleanId = (studentIdentifier || 'anonymous')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_');
  return `draft_${cleanCode}_${cleanId}`;
}

const LOCAL_DRAFT_PREFIX = 'fluffykitten_exam_draft_';
const LOCAL_DRAFT_SECRET_PREFIX = 'fluffykitten_draft_secret_';
const inMemoryDraftSecrets = new Map<string, string>();

function resolveDraftOwnerToken(
  quizCode: string,
  draftKey: string,
  studentPin?: string,
  studentIdentifier?: string
): string {
  const cleanCode = (quizCode || 'EXAM').trim().toUpperCase();
  const explicitPin = (studentPin || '').trim();
  if (explicitPin) {
    return `pin:${cleanCode}:${explicitPin}`;
  }
  const ident = (studentIdentifier || '').trim();
  if (/^\d{3,8}$/.test(ident)) {
    return `pin:${cleanCode}:${ident}`;
  }

  const secretStorageKey = `${LOCAL_DRAFT_SECRET_PREFIX}${draftKey}`;
  try {
    const existing = localStorage.getItem(secretStorageKey);
    if (existing) return existing;
    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `dev:${crypto.randomUUID()}`
        : `dev:${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
    localStorage.setItem(secretStorageKey, generated);
    return generated;
  } catch {
    let existingMem = inMemoryDraftSecrets.get(draftKey);
    if (!existingMem) {
      existingMem = `dev:${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
      inMemoryDraftSecrets.set(draftKey, existingMem);
    }
    return existingMem;
  }
}

/**
 * Saves or updates an in-progress exam draft in localStorage and Supabase.
 * In Supabase, uses UPSERT on a single key in app_config to consume negligible storage (~5 KB).
 */
export async function saveExamDraft(
  draft: ExamDraftPayload,
  options?: { keepalive?: boolean }
): Promise<boolean> {
  if (!draft.quizCode || !draft.studentName) return false;

  const identifier = draft.studentPin || draft.studentName;
  const draftKey = getDraftKey(draft.quizCode, identifier);
  const ownerToken = resolveDraftOwnerToken(draft.quizCode, draftKey, draft.studentPin, identifier);
  const payloadWithTimestamp: ExamDraftPayload = {
    ...draft,
    lastSavedAt: new Date().toISOString(),
  };
  const serialized = JSON.stringify(payloadWithTimestamp);

  // 1. Save to local storage immediately for zero-latency recovery on tab close / power loss
  try {
    localStorage.setItem(`${LOCAL_DRAFT_PREFIX}${draftKey}`, serialized);
  } catch (err) {
    console.warn('Could not cache exam draft to localStorage:', err);
  }

  // 2. Push to Supabase via keepalive fetch on pagehide/beforeunload (up to 64 KB Chromium cap)
  const rpcBody = JSON.stringify({
    p_key: draftKey,
    p_value: serialized,
    p_owner_token: ownerToken,
  });
  if (
    options?.keepalive &&
    typeof fetch === 'function' &&
    isSupabaseConfigured() &&
    rpcBody.length < 60000
  ) {
    try {
      const res = await fetch(`${supabaseUrl}/rest/v1/rpc/save_student_exam_draft`, {
        method: 'POST',
        keepalive: true,
        headers: {
          apikey: supabaseAnonKey,
          Authorization: `Bearer ${supabaseAnonKey}`,
          'Content-Type': 'application/json',
        },
        body: rpcBody,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // 2. Push to Supabase via SECURITY DEFINER RPC first (falls back to legacy 2-arg signature or app_config)
  try {
    let rpcRes = await (supabase as any).rpc('save_student_exam_draft', {
      p_key: draftKey,
      p_value: serialized,
      p_owner_token: ownerToken,
    });
    if (rpcRes?.error && /42883|function.*does not exist/i.test(String(rpcRes.error.message || rpcRes.error.code || ''))) {
      rpcRes = await (supabase as any).rpc('save_student_exam_draft', {
        p_key: draftKey,
        p_value: serialized,
      });
    }
    if (!rpcRes?.error && rpcRes?.data === true) {
      return true;
    }
    if (rpcRes?.error) {
      const { error } = await (supabase.from('app_config' as any) as any).upsert({
        key: draftKey,
        value: serialized,
      });

      if (error) {
        console.warn('Cloud draft sync notice:', error.message);
        return false;
      }
      return true;
    }
    return false;
  } catch (err) {
    console.warn('Cloud draft network error:', err);
    return false;
  }
}

function parseAndCacheCloudDraft(
  rawValue: string,
  quizId: string,
  draftKey: string
): ExamDraftPayload | null {
  const parsed: ExamDraftPayload = JSON.parse(rawValue);
  if (parsed && parsed.status === 'in_progress') {
    if (parsed.quizId !== quizId) {
      console.warn(`Draft bleed prevented via cloud: old draft belongs to ${parsed.quizId}, current exam is ${quizId}`);
      return null;
    }
    const ageHours = (Date.now() - new Date(parsed.lastSavedAt).getTime()) / (1000 * 60 * 60);
    if (ageHours < 24) {
      try {
        localStorage.setItem(`${LOCAL_DRAFT_PREFIX}${draftKey}`, rawValue);
      } catch {}
      return parsed;
    }
  }
  return null;
}

/**
 * Fetches an existing in-progress exam draft from localStorage or Supabase.
 */
export async function fetchExamDraft(
  quizCode: string,
  quizId: string,
  studentIdentifier: string
): Promise<ExamDraftPayload | null> {
  if (!quizCode || !quizId || !studentIdentifier) return null;

  const draftKey = getDraftKey(quizCode, studentIdentifier);

  // 1. Try local storage first
  try {
    const local = localStorage.getItem(`${LOCAL_DRAFT_PREFIX}${draftKey}`);
    if (local) {
      const parsed: ExamDraftPayload = JSON.parse(local);
      if (parsed && parsed.status === 'in_progress') {
        if (parsed.quizId !== quizId) {
          // The local copy was written before the published id resolved (or belongs
          // to an older sitting). Do not trust it, but keep looking in the cloud.
          console.warn(
            `Local draft quiz id mismatch (${parsed.quizId} != ${quizId}); checking cloud copy instead.`
          );
        } else {
          // Verify not stale (> 24 hours)
          const ageHours = (Date.now() - new Date(parsed.lastSavedAt).getTime()) / (1000 * 60 * 60);
          if (ageHours < 24) {
            return parsed;
          }
        }
      }
    }
  } catch (err) {
    console.warn('Local draft read error:', err);
  }

  // 2. Fetch from Supabase cloud via SECURITY DEFINER RPC first (fallback to 1-arg or app_config pre-migration)
  try {
    const ownerToken = resolveDraftOwnerToken(quizCode, draftKey, undefined, studentIdentifier);
    let rpcRes = (await (supabase as any).rpc('get_student_exam_draft', {
      p_key: draftKey,
      p_owner_token: ownerToken,
    })) as { data: string | null; error: any };

    if (rpcRes?.error && /42883|function.*does not exist/i.test(String(rpcRes.error.message || rpcRes.error.code || ''))) {
      rpcRes = (await (supabase as any).rpc('get_student_exam_draft', {
        p_key: draftKey,
      })) as { data: string | null; error: any };
    }

    if (!rpcRes.error) {
      if (rpcRes.data) {
        return parseAndCacheCloudDraft(rpcRes.data, quizId, draftKey);
      }
      return null;
    }

    const { data, error } = (await (supabase.from('app_config' as any) as any)
      .select('value')
      .eq('key', draftKey)
      .maybeSingle()) as { data: { value: string } | null; error: any };

    if (!error && data?.value) {
      return parseAndCacheCloudDraft(data.value, quizId, draftKey);
    }
  } catch (err) {
    console.warn('Could not fetch cloud draft:', err);
  }

  return null;
}

/**
 * Clears or finalizes an exam draft when submitted.
 */
export async function clearExamDraft(
  quizCode: string,
  quizId: string,
  studentIdentifier: string
): Promise<void> {
  if (!quizCode || !quizId || !studentIdentifier) return;

  const draftKey = getDraftKey(quizCode, studentIdentifier);
  const ownerToken = resolveDraftOwnerToken(quizCode, draftKey, undefined, studentIdentifier);

  try {
    localStorage.removeItem(`${LOCAL_DRAFT_PREFIX}${draftKey}`);
    localStorage.removeItem(`${LOCAL_DRAFT_SECRET_PREFIX}${draftKey}`);
  } catch {}
  inMemoryDraftSecrets.delete(draftKey);

  try {
    let rpcRes = await (supabase as any).rpc('delete_student_exam_draft', {
      p_key: draftKey,
      p_owner_token: ownerToken,
    });
    if (rpcRes?.error && /42883|function.*does not exist/i.test(String(rpcRes.error.message || rpcRes.error.code || ''))) {
      rpcRes = await (supabase as any).rpc('delete_student_exam_draft', {
        p_key: draftKey,
      });
    }
    if (rpcRes?.error) {
      await (supabase.from('app_config' as any) as any)
        .delete()
        .eq('key', draftKey);
    }
  } catch (err) {
    console.warn('Could not remove cloud draft:', err);
  }
}

/**
 * Checks if this student has already submitted a final attempt for this quiz code.
 * Used to enforce the 1-attempt limit in formal exams.
 */
export async function checkStudentAttemptSubmitted(
  quizCode: string,
  candidateName: string,
  candidateClass?: string,
  _studentPin?: string,
  candidateNumber?: string
): Promise<{ submitted: boolean; submittedAt?: string; submissionId?: string }> {
  const cleanCode = (quizCode || '').trim().toUpperCase();
  const cleanName = normalizeIdentityPart(candidateName);
  const cleanClass = normalizeIdentityPart(candidateClass);
  const cleanNumber = normalizeIdentityPart(candidateNumber);

  // 1. Prefer the exact, server-side RPC (no 100-row truncation, no client-side scan).
  try {
    const { data, error } = await (supabase as any).rpc('check_student_attempt_submitted', {
      p_quiz_code: cleanCode,
      p_student_name: candidateName,
      p_student_class: candidateClass || null,
      p_student_number: candidateNumber || null,
    });
    if (!error && data && typeof data === 'object') {
      return {
        submitted: data.submitted === true,
        submittedAt: data.submittedAt || undefined,
        submissionId: data.submissionId || undefined,
      };
    }
  } catch (err) {
    console.warn('Attempt RPC unavailable, falling back to table query:', err);
  }

  // 2. Legacy fallback: query the table and normalise in JS.
  try {
    const { data, error } = await (supabase.from('quiz_submissions' as any) as any)
      .select('id, student_name, student_class, candidate_number, submitted_at')
      .eq('quiz_code', cleanCode)
      .limit(1000);

    if (!error && Array.isArray(data)) {
      for (const row of data) {
        const rowName = normalizeIdentityPart(row.student_name);
        const rowClass = normalizeIdentityPart(row.student_class || row.candidate_class);
        const rowNumber = normalizeIdentityPart(row.candidate_number);

        const matchesName = Boolean(cleanName) && rowName === cleanName;
        const matchesClass = !cleanClass || !rowClass || cleanClass === rowClass;
        const matchesNumber = !cleanNumber || !rowNumber || cleanNumber === rowNumber;

        if (matchesName && matchesClass && matchesNumber) {
          return {
            submitted: true,
            submittedAt: row.submitted_at,
            submissionId: row.id,
          };
        }
      }
    }
  } catch (err) {
    console.warn('Could not check submission attempt in cloud:', err);
  }

  // 3. Check local device receipts as the offline fallback.
  try {
    const receiptsRaw = localStorage.getItem('fluffykitten_device_exam_receipts');
    if (receiptsRaw) {
      const receipts = JSON.parse(receiptsRaw);
      if (Array.isArray(receipts)) {
        const found = receipts.find((r: any) => {
          const rCode = String(r.quizCode || '').trim().toUpperCase();
          const rName = normalizeIdentityPart(r.studentName);
          const rNumber = normalizeIdentityPart(r.candidateNumber);
          return (
            rCode === cleanCode &&
            rName === cleanName &&
            (!cleanNumber || !rNumber || cleanNumber === rNumber)
          );
        });
        if (found) {
          return {
            submitted: true,
            submittedAt: found.submittedAt,
          };
        }
      }
    }
  } catch {}

  return { submitted: false };
}
