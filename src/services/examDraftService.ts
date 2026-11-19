// ─── Exam Draft & Cloud Auto-Save Service ────────────────────────────────────
// Manages lightweight in-progress exam snapshots (~5 KB) to allow students to
// recover from crashes or transfer to another computer without consuming Supabase storage.

import { supabase, supabaseUrl, supabaseAnonKey, isSupabaseConfigured } from '../lib/supabase';
import {
  normalizeIdentityPart,
  normalizeClassIdentityPart,
  isMissingRpcError,
} from '../lib/examSubmissionGuards';
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

export function buildStudentDraftIdentifier(
  studentName?: string,
  studentPin?: string,
  studentClass?: string
): string {
  const cleanName = normalizeIdentityPart(studentName)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const cleanPin = String(studentPin || '').trim();
  const cleanClass = normalizeClassIdentityPart(studentClass)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (cleanName && cleanPin) return `${cleanName}__${cleanPin}`;
  if (cleanName && cleanClass) return `${cleanName}__cls_${cleanClass}`;
  return cleanPin || cleanName || String(studentName || '').trim();
}

export function getDraftKey(quizCode: string, studentIdentifier: string): string {
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
const draftCloudBackoffByKey = new Map<string, { failures: number; nextAllowedAt: number }>();

/** Clears the per-key cloud autosave circuit breaker state (for automated tests). */
export function resetDraftCloudBackoffForTests(): void {
  draftCloudBackoffByKey.clear();
}

function recordDraftCloudFailure(draftKey: string): void {
  const prev = draftCloudBackoffByKey.get(draftKey);
  const failures = (prev?.failures || 0) + 1;
  const delayMs = Math.min(120_000, 15_000 * Math.pow(2, failures - 1));
  draftCloudBackoffByKey.set(draftKey, {
    failures,
    nextAllowedAt: Date.now() + delayMs,
  });
}

function clearDraftCloudFailure(draftKey: string): void {
  draftCloudBackoffByKey.delete(draftKey);
}

export function resolveDraftOwnerToken(
  quizCode: string,
  draftKey: string,
  studentPin?: string,
  studentIdentifier?: string
): string {
  const cleanCode = (quizCode || 'EXAM').trim().toUpperCase();
  const explicitPin = (studentPin || '').trim();
  const ident = (studentIdentifier || '').trim();
  if (explicitPin) {
    return `pin:${cleanCode}:${ident || explicitPin}`;
  }
  if (/^\d{3,8}$/.test(ident) || /__\d{3,8}$/.test(ident)) {
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

export function getDraftLockCredentials(
  quizCode: string,
  studentName: string,
  studentPin?: string,
  studentClass?: string
): { draftKey: string; ownerToken: string } {
  const cleanCode = (quizCode || 'EXAM').trim().toUpperCase();
  const identifier = buildStudentDraftIdentifier(studentName, studentPin, studentClass);
  const draftKey = getDraftKey(cleanCode, identifier);
  const ownerToken = resolveDraftOwnerToken(cleanCode, draftKey, studentPin, identifier);
  return { draftKey, ownerToken };
}

async function sha256HexString(input: string): Promise<string> {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
    const data = new TextEncoder().encode(input);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `fnv_${(h >>> 0).toString(16)}`;
}

/** Computes the per-session anti-spoofing proctor heartbeat proof (`VULN-P3-10`). */
export async function computeStudentHeartbeatKey(
  quizCode: string,
  draftKey: string,
  ownerToken: string
): Promise<string> {
  const cleanCode = (quizCode || 'EXAM').trim().toUpperCase();
  const raw = `${cleanCode}::${draftKey}::${String(ownerToken || '').slice(0, 16)}`;
  return sha256HexString(raw);
}

export async function getActiveStudentHeartbeatProof(
  quizCode: string,
  studentName: string,
  studentPin?: string,
  studentClass?: string
): Promise<{ draftKey: string; heartbeatKey: string }> {
  const { draftKey, ownerToken } = getDraftLockCredentials(quizCode, studentName, studentPin, studentClass);
  const heartbeatKey = await computeStudentHeartbeatKey(quizCode, draftKey, ownerToken);
  return { draftKey, heartbeatKey };
}

/**
 * Saves or updates an in-progress exam draft in localStorage and Supabase.
 * In Supabase, uses UPSERT on a single key in app_config to consume negligible storage (~5 KB).
 */
export async function saveExamDraft(
  draft: ExamDraftPayload,
  options?: { keepalive?: boolean; force?: boolean }
): Promise<boolean> {
  if (!draft.quizCode || !draft.studentName) return false;

  const identifier = buildStudentDraftIdentifier(
    draft.studentName,
    draft.studentPin,
    draft.candidateClass
  );
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

  // Engage per-key exponential backoff after transient cloud failures so 170 tabs don't amplify 544 storms
  if (!options?.keepalive && !options?.force) {
    const backoff = draftCloudBackoffByKey.get(draftKey);
    if (backoff && Date.now() < backoff.nextAllowedAt) {
      return false;
    }
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
      if (res.ok) {
        clearDraftCloudFailure(draftKey);
        return true;
      }
      recordDraftCloudFailure(draftKey);
      return false;
    } catch {
      recordDraftCloudFailure(draftKey);
      return false;
    }
  }

  // 2. Push to Supabase via SECURITY DEFINER RPC first (only fall back to legacy signature / app_config on 42883)
  try {
    let rpcRes = await (supabase as any).rpc('save_student_exam_draft', {
      p_key: draftKey,
      p_value: serialized,
      p_owner_token: ownerToken,
    });
    if (rpcRes?.error && isMissingRpcError(rpcRes.error)) {
      rpcRes = await (supabase as any).rpc('save_student_exam_draft', {
        p_key: draftKey,
        p_value: serialized,
      });
    }
    if (!rpcRes?.error && rpcRes?.data === true) {
      clearDraftCloudFailure(draftKey);
      return true;
    }
    if (rpcRes?.error) {
      const errCode = String(rpcRes.error.code || '');
      const errMsg = String(rpcRes.error.message || '');
      if (errCode === '42501' || /belongs to another device/i.test(errMsg)) {
        return false;
      }
      if (!isMissingRpcError(rpcRes.error)) {
        recordDraftCloudFailure(draftKey);
        console.warn('Cloud draft RPC transient failure (backoff engaged):', errMsg || errCode);
        return false;
      }

      const { error } = await (supabase.from('app_config' as any) as any).upsert({
        key: draftKey,
        value: serialized,
      });

      if (error) {
        recordDraftCloudFailure(draftKey);
        console.warn('Cloud draft sync notice:', error.message);
        return false;
      }
      clearDraftCloudFailure(draftKey);
      return true;
    }
    return false;
  } catch (err) {
    recordDraftCloudFailure(draftKey);
    console.warn('Cloud draft network error:', err);
    return false;
  }
}

function parseAndCacheCloudDraft(
  rawValue: string,
  quizId: string,
  draftKey: string,
  expectedStudentName?: string,
  expectedStudentClass?: string
): ExamDraftPayload | null {
  const parsed: ExamDraftPayload = JSON.parse(rawValue);
  if (parsed && parsed.status === 'in_progress') {
    if (parsed.quizId !== quizId) {
      console.warn(`Draft bleed prevented via cloud: old draft belongs to ${parsed.quizId}, current exam is ${quizId}`);
      return null;
    }
    if (
      expectedStudentName &&
      normalizeIdentityPart(parsed.studentName) !== normalizeIdentityPart(expectedStudentName)
    ) {
      console.warn('Draft identity mismatch prevented via cloud.');
      return null;
    }
    const expectedClassNorm = normalizeClassIdentityPart(expectedStudentClass);
    const parsedClassNorm = normalizeClassIdentityPart(parsed.candidateClass);
    if (expectedClassNorm && parsedClassNorm && parsedClassNorm !== expectedClassNorm) {
      console.warn('Draft class mismatch prevented via cloud.');
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
  studentIdentifier: string,
  options?: { studentPin?: string; expectedStudentName?: string; expectedStudentClass?: string }
): Promise<ExamDraftPayload | null> {
  if (!quizCode || !quizId || !studentIdentifier) return null;

  const draftKey = getDraftKey(quizCode, studentIdentifier);
  const expectedNameNorm = options?.expectedStudentName
    ? normalizeIdentityPart(options.expectedStudentName)
    : '';
  const expectedClassNorm = normalizeClassIdentityPart(options?.expectedStudentClass);

  // 1. Try local storage first
  try {
    const local = localStorage.getItem(`${LOCAL_DRAFT_PREFIX}${draftKey}`);
    if (local) {
      const parsed: ExamDraftPayload = JSON.parse(local);
      if (parsed && parsed.status === 'in_progress') {
        const parsedClassNorm = normalizeClassIdentityPart(parsed.candidateClass);
        if (parsed.quizId !== quizId) {
          console.warn(
            `Local draft quiz id mismatch (${parsed.quizId} != ${quizId}); checking cloud copy instead.`
          );
        } else if (expectedNameNorm && normalizeIdentityPart(parsed.studentName) !== expectedNameNorm) {
          console.warn('Local draft student identity mismatch ignored.');
        } else if (expectedClassNorm && parsedClassNorm && parsedClassNorm !== expectedClassNorm) {
          console.warn('Local draft student class mismatch ignored.');
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

  // 2. Fetch from Supabase cloud via SECURITY DEFINER RPC first (fallback to 1-arg or app_config only on 42883)
  try {
    const ownerToken = resolveDraftOwnerToken(quizCode, draftKey, options?.studentPin, studentIdentifier);
    let rpcRes = (await (supabase as any).rpc('get_student_exam_draft', {
      p_key: draftKey,
      p_owner_token: ownerToken,
    })) as { data: string | null; error: any };

    if (rpcRes?.error && isMissingRpcError(rpcRes.error)) {
      rpcRes = (await (supabase as any).rpc('get_student_exam_draft', {
        p_key: draftKey,
      })) as { data: string | null; error: any };
    }

    if (!rpcRes.error) {
      if (rpcRes.data) {
        return parseAndCacheCloudDraft(
          rpcRes.data,
          quizId,
          draftKey,
          options?.expectedStudentName,
          options?.expectedStudentClass
        );
      }
      return null;
    }

    if (!isMissingRpcError(rpcRes.error)) {
      return null;
    }

    const { data, error } = (await (supabase.from('app_config' as any) as any)
      .select('value')
      .eq('key', draftKey)
      .maybeSingle()) as { data: { value: string } | null; error: any };

    if (!error && data?.value) {
      return parseAndCacheCloudDraft(
        data.value,
        quizId,
        draftKey,
        options?.expectedStudentName,
        options?.expectedStudentClass
      );
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
  studentIdentifier: string,
  studentPin?: string
): Promise<void> {
  if (!quizCode || !quizId || !studentIdentifier) return;

  const draftKey = getDraftKey(quizCode, studentIdentifier);
  const ownerToken = resolveDraftOwnerToken(quizCode, draftKey, studentPin, studentIdentifier);

  try {
    localStorage.removeItem(`${LOCAL_DRAFT_PREFIX}${draftKey}`);
    localStorage.removeItem(`${LOCAL_DRAFT_SECRET_PREFIX}${draftKey}`);
  } catch {}
  inMemoryDraftSecrets.delete(draftKey);
  clearDraftCloudFailure(draftKey);

  try {
    let rpcRes = await (supabase as any).rpc('delete_student_exam_draft', {
      p_key: draftKey,
      p_owner_token: ownerToken,
    });
    if (rpcRes?.error && isMissingRpcError(rpcRes.error)) {
      rpcRes = await (supabase as any).rpc('delete_student_exam_draft', {
        p_key: draftKey,
      });
    }
    if (rpcRes?.error && isMissingRpcError(rpcRes.error)) {
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
  const cleanClass = normalizeClassIdentityPart(candidateClass);
  const cleanNumber = normalizeIdentityPart(candidateNumber);

  let shouldRunLegacyTableFallback = false;

  // 1. Prefer the exact, server-side RPC (bounded timeout so slow connections don't stall exam entry).
  try {
    const rpcPromise = (supabase as any).rpc('check_student_attempt_submitted', {
      p_quiz_code: cleanCode,
      p_student_name: candidateName,
      p_student_class: candidateClass || null,
      p_student_number: candidateNumber || null,
    });
    const timeoutPromise = new Promise<{ data: null; error: { message: string } }>((resolve) =>
      setTimeout(() => resolve({ data: null, error: { message: 'timeout' } }), 4000)
    );
    const { data, error } = (await Promise.race([rpcPromise, timeoutPromise])) as {
      data: any;
      error: any;
    };
    if (!error && data && typeof data === 'object') {
      return {
        submitted: data.submitted === true,
        submittedAt: data.submittedAt || undefined,
        submissionId: data.submissionId || undefined,
      };
    }
    if (error && isMissingRpcError(error)) {
      shouldRunLegacyTableFallback = true;
    }
  } catch (err) {
    if (isMissingRpcError(err)) {
      shouldRunLegacyTableFallback = true;
    } else {
      console.warn('Attempt RPC unavailable:', err);
    }
  }

  // 2. Legacy fallback only when RPC is missing (pre-019 DB); Phase 2 RLS blocks anon table reads.
  if (shouldRunLegacyTableFallback) {
    try {
      const { data, error } = await (supabase.from('quiz_submissions' as any) as any)
        .select('id, student_name, student_class, candidate_number, submitted_at')
        .eq('quiz_code', cleanCode)
        .limit(1000);

      if (!error && Array.isArray(data)) {
        for (const row of data) {
          const rowName = normalizeIdentityPart(row.student_name);
          const rowClass = normalizeClassIdentityPart(row.student_class || row.candidate_class);
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
          const rClass = normalizeClassIdentityPart(r.studentClass || r.candidateClass);
          const rNumber = normalizeIdentityPart(r.candidateNumber);
          return (
            rCode === cleanCode &&
            rName === cleanName &&
            (!cleanClass || !rClass || cleanClass === rClass) &&
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
