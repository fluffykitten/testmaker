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
 */
export function recordProctorAuditEvent(event: ProctorAuditEvent): void {
  try {
    const existing = readLocal();
    if (!existing.some((item) => item.id === event.id)) {
      writeLocal([event, ...existing]);
    }
  } catch {
    // ignore local mirror failures
  }

  try {
    void (supabase as any)
      .from('proctor_audit_events')
      .insert({
        id: event.id,
        quiz_code: event.quizCode,
        student_id: event.studentId,
        student_name: event.studentName,
        candidate_number: event.candidateNumber ?? null,
        candidate_class: event.candidateClass ?? null,
        event_type: event.eventType,
        severity: event.severity,
        detail: event.detail,
        actor: event.actor,
        created_at: event.createdAt,
      })
      .then(({ error }: { error?: { message?: string } | null }) => {
        // 42P01 = table missing (migration not applied) — local mirror already holds it.
        if (error) console.debug('[proctor-audit] insert skipped:', error.message);
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
