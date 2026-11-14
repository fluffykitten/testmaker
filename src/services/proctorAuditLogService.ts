/**
 * Durable invigilation audit trail.
 *
 * Live heartbeats are fire-and-forget broadcasts; discrete violations and teacher
 * interventions are written here so a dashboard reload (or a different invigilator's
 * machine) can rebuild the log. Writes are best-effort: the local mirror always succeeds,
 * and the Supabase insert is skipped cleanly when migration 018 has not been applied yet.
 *
 * See Plan/proctor_p1_p2_p3_fixes.md §P1-C.
 */

import { supabase } from '../lib/supabase';
import { mergeAuditEvents } from '../lib/proctorGuards';

export type ProctorAuditActor = 'student' | 'invigilator';
export type ProctorAuditSeverity = 'info' | 'warning' | 'critical';

export interface ProctorAuditEvent {
  id: string;
  quizCode: string;
  studentId: string;
  studentName: string;
  candidateNumber?: string;
  candidateClass?: string;
  eventType: string;
  severity: ProctorAuditSeverity;
  detail: string;
  actor: ProctorAuditActor;
  createdAt: string;
}

const STORAGE_KEY = 'testmaker_proctor_audit_log';
const MAX_LOCAL_EVENTS = 500;
const MAX_DETAIL_UTF8_BYTES = 960;

type AuditAuthErrorListener = (detail: string) => void;
const authErrorListeners = new Set<AuditAuthErrorListener>();

/** Subscribe to RLS/auth rejection notices (`42501`) emitted by invigilator audit inserts. */
export function onProctorAuditAuthError(listener: AuditAuthErrorListener): () => void {
  authErrorListeners.add(listener);
  return () => {
    authErrorListeners.delete(listener);
  };
}

/** Clamps a string to `maxBytes` UTF-8 bytes without splitting Unicode code points. */
export function clampUtf8Bytes(value: string, maxBytes = MAX_DETAIL_UTF8_BYTES): string {
  const input = String(value ?? '');
  if (maxBytes <= 0) return '';
  const encoder = new TextEncoder();
  if (encoder.encode(input).length <= maxBytes) return input;

  let out = '';
  let usedBytes = 0;
  for (const ch of input) {
    const len = encoder.encode(ch).length;
    if (usedBytes + len > maxBytes) break;
    out += ch;
    usedBytes += len;
  }
  return out;
}

function sanitizeAuditEvent(event: ProctorAuditEvent): ProctorAuditEvent {
  const rawType = String(event.eventType || 'warning').trim().slice(0, 64);
  return {
    ...event,
    quizCode: String(event.quizCode || '').trim().toUpperCase().slice(0, 32),
    studentId: (String(event.studentId || 'unknown').trim() || 'unknown').slice(0, 120),
    studentName: (String(event.studentName || 'Candidate').trim() || 'Candidate').slice(0, 120),
    eventType: rawType.length >= 2 ? rawType : 'warning',
    detail: clampUtf8Bytes(event.detail || '', MAX_DETAIL_UTF8_BYTES),
  };
}

function readLocal(): ProctorAuditEvent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ProctorAuditEvent[]) : [];
  } catch {
    return [];
  }
}

function writeLocal(events: ProctorAuditEvent[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events.slice(0, MAX_LOCAL_EVENTS)));
  } catch {
    // Storage full or blocked (private mode) — the DB copy is still attempted.
  }
}

/**
 * Records one audit event. Never throws and never blocks the caller.
 * Uses plain INSERT (never UPSERT) because student clients have insert-only RLS under 021.
 */
export function recordProctorAuditEvent(event: ProctorAuditEvent): void {
  const clean = sanitizeAuditEvent(event);

  try {
    const existing = readLocal();
    if (!existing.some((item) => item.id === clean.id)) {
      writeLocal([clean, ...existing]);
    }
  } catch {
    // ignore local mirror failures
  }

  try {
    void (supabase as any)
      .from('proctor_audit_events')
      .insert({
        id: clean.id,
        quiz_code: clean.quizCode,
        student_id: clean.studentId,
        student_name: clean.studentName,
        candidate_number: clean.candidateNumber ?? null,
        candidate_class: clean.candidateClass ?? null,
        event_type: clean.eventType,
        severity: clean.severity,
        detail: clean.detail,
        actor: clean.actor,
        created_at: clean.createdAt,
      })
      .then(({ error }: { error?: { code?: string; message?: string } | null }) => {
        if (!error) return;
        // 23505 = duplicate primary key (expected when student + dashboard both record the same event id).
        if (error.code === '23505') return;
        if (error.code === '42501' && clean.actor === 'invigilator') {
          authErrorListeners.forEach((cb) => cb(error.message || 'Invigilator session expired'));
        }
        // 42P01 = table missing (migration not applied) — local mirror already holds it.
        console.debug('[proctor-audit] insert skipped:', error.message);
      });
  } catch (error) {
    console.debug('[proctor-audit] insert failed:', error);
  }
}

/** Rebuilds the audit log for the given quiz codes, newest first, de-duplicated by id. */
export async function loadProctorAuditEvents(quizCodes: string[], limit = 250): Promise<ProctorAuditEvent[]> {
  const codes = quizCodes.map((code) => code.trim().toUpperCase()).filter(Boolean);
  const local = readLocal().filter((event) => !codes.length || codes.includes(event.quizCode.toUpperCase()));

  let remote: ProctorAuditEvent[] = [];
  try {
    if (codes.length) {
      const { data, error } = await supabase
        .from('proctor_audit_events')
        .select('*')
        .in('quiz_code', codes)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (!error && Array.isArray(data)) {
        remote = data.map((row: any) => ({
          id: String(row.id),
          quizCode: String(row.quiz_code || '').toUpperCase(),
          studentId: String(row.student_id || ''),
          studentName: String(row.student_name || 'Candidate'),
          candidateNumber: row.candidate_number ?? undefined,
          candidateClass: row.candidate_class ?? undefined,
          eventType: String(row.event_type || 'warning'),
          severity: (row.severity as ProctorAuditSeverity) || 'warning',
          detail: String(row.detail || ''),
          actor: (row.actor as ProctorAuditActor) || 'student',
          createdAt: String(row.created_at || new Date().toISOString()),
        }));
      }
    }
  } catch {
    // Offline or table absent — local mirror is the fallback.
  }

  return mergeAuditEvents(remote, local, limit);
}

/** Clears the local mirror (DB rows are intentionally left in place). */
export function clearLocalProctorAuditLog(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
