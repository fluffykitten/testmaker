// ─── Exam Draft & Cloud Auto-Save Service ────────────────────────────────────
// Manages lightweight in-progress exam snapshots (~5 KB) to allow students to
// recover from crashes or transfer to another computer without consuming Supabase storage.

import { supabase } from '../lib/supabase';

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

/**
 * Saves or updates an in-progress exam draft in localStorage and Supabase.
 * In Supabase, uses UPSERT on a single key in app_config to consume negligible storage (~5 KB).
 */
export async function saveExamDraft(draft: ExamDraftPayload): Promise<boolean> {
  if (!draft.quizCode || !draft.studentName) return false;

  const identifier = draft.studentPin || draft.studentName;
  const draftKey = getDraftKey(draft.quizCode, identifier);
  const payloadWithTimestamp: ExamDraftPayload = {
    ...draft,
    lastSavedAt: new Date().toISOString(),
  };
  const serialized = JSON.stringify(payloadWithTimestamp);

  // 1. Save to local storage for instant zero-latency recovery on tab reload
  try {
    localStorage.setItem(`${LOCAL_DRAFT_PREFIX}${draftKey}`, serialized);
  } catch (err) {
    console.warn('Could not cache exam draft to localStorage:', err);
  }

  // 2. Push to Supabase app_config (UPSERT in-place, zero new rows)
  try {
    const { error } = await (supabase.from('app_config' as any) as any).upsert({
      key: draftKey,
      value: serialized,
    });

    if (error) {
      console.warn('Cloud draft sync notice:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Cloud draft network error:', err);
    return false;
  }
}

/**
 * Fetches an existing in-progress exam draft from localStorage or Supabase.
 */
export async function fetchExamDraft(
  quizCode: string,
  studentIdentifier: string
): Promise<ExamDraftPayload | null> {
  if (!quizCode || !studentIdentifier) return null;

  const draftKey = getDraftKey(quizCode, studentIdentifier);

  // 1. Try local storage first
  try {
    const local = localStorage.getItem(`${LOCAL_DRAFT_PREFIX}${draftKey}`);
    if (local) {
      const parsed: ExamDraftPayload = JSON.parse(local);
      if (parsed && parsed.status === 'in_progress') {
        // Verify not stale (> 24 hours)
        const ageHours = (Date.now() - new Date(parsed.lastSavedAt).getTime()) / (1000 * 60 * 60);
        if (ageHours < 24) {
          return parsed;
        }
      }
    }
  } catch (err) {
    console.warn('Local draft read error:', err);
  }

  // 2. Fetch from Supabase cloud (e.g. student switched laptops)
  try {
    const { data, error } = (await (supabase.from('app_config' as any) as any)
      .select('value')
      .eq('key', draftKey)
      .maybeSingle()) as { data: { value: string } | null; error: any };

    if (!error && data?.value) {
      const parsed: ExamDraftPayload = JSON.parse(data.value);
      if (parsed && parsed.status === 'in_progress') {
        const ageHours = (Date.now() - new Date(parsed.lastSavedAt).getTime()) / (1000 * 60 * 60);
        if (ageHours < 24) {
          // Cache to local for this device
          try {
            localStorage.setItem(`${LOCAL_DRAFT_PREFIX}${draftKey}`, data.value);
          } catch {}
          return parsed;
        }
      }
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
  studentIdentifier: string
): Promise<void> {
  if (!quizCode || !studentIdentifier) return;

  const draftKey = getDraftKey(quizCode, studentIdentifier);

  try {
    localStorage.removeItem(`${LOCAL_DRAFT_PREFIX}${draftKey}`);
  } catch {}

  try {
    await (supabase.from('app_config' as any) as any)
      .delete()
      .eq('key', draftKey);
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
  _studentPin?: string
): Promise<{ submitted: boolean; submittedAt?: string; submissionId?: string }> {
  const cleanCode = (quizCode || '').trim().toUpperCase();
  const cleanName = (candidateName || '').trim().toLowerCase();
  const cleanClass = (candidateClass || '').trim().toLowerCase();

  try {
    // 1. Query Supabase quiz_submissions
    // Use student_class column matching migration 007
    const { data, error } = await (supabase.from('quiz_submissions' as any) as any)
      .select('id, student_name, student_class, candidate_number, submitted_at')
      .eq('quiz_code', cleanCode)
      .limit(100);

    if (!error && Array.isArray(data)) {
      for (const row of data) {
        const rowName = String(row.student_name || '').trim().toLowerCase();
        // Fallback to candidate_class just in case, but actual column is student_class
        const rowClass = String(row.student_class || row.candidate_class || '').trim().toLowerCase();

        // Match exact Name and matching Class (if class was provided)
        const matchesName = cleanName && rowName === cleanName;
        const matchesClass = !cleanClass || !rowClass || cleanClass === rowClass;

        if (matchesName && matchesClass) {
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

  // 2. Check local outbox / device receipts as fallback
  try {
    const receiptsRaw = localStorage.getItem('fluffykitten_device_receipts');
    if (receiptsRaw) {
      const receipts = JSON.parse(receiptsRaw);
      if (Array.isArray(receipts)) {
        const found = receipts.find((r: any) => {
          const rCode = String(r.quizCode || '').trim().toUpperCase();
          const rName = String(r.studentName || '').trim().toLowerCase();
          return rCode === cleanCode && rName === cleanName;
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
