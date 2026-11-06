/**
 * Pure proctoring guards (no DOM, no Supabase, no React).
 *
 * These encode the trust rules the live invigilator depends on:
 *  - a teacher command is only applied when its type is known and its numbers are sane;
 *  - dashboard telemetry is clamped, and strikes never move backwards without a pardon;
 *  - one student's noisy client cannot flood the global event log.
 *
 * Kept pure so scripts/test-proctor-p1-p2-p3.mjs can exercise them in Node.
 */

export type ProctorCommandTypeName = 'unlock' | 'add_time' | 'force_submit' | 'announcement' | 'pardon';

const ALLOWED_COMMANDS: ReadonlySet<string> = new Set<ProctorCommandTypeName>([
  'unlock',
  'add_time',
  'force_submit',
  'announcement',
  'pardon',
]);

/** Max characters accepted in an invigilator announcement. */
export const MAX_ANNOUNCEMENT_CHARS = 500;
/** Bounds for an add_time grant, in whole minutes. */
export const MIN_ADD_TIME_MINUTES = 1;
export const MAX_ADD_TIME_MINUTES = 120;

export function isAllowedProctorCommand(type: unknown): type is ProctorCommandTypeName {
  return typeof type === 'string' && ALLOWED_COMMANDS.has(type);
}

/** Clamps an invigilator's add_time request: finite, integer, 1–120 minutes (default 5). */
export function clampAddTimeMinutes(value: unknown, fallback = 5): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(MIN_ADD_TIME_MINUTES, Math.min(MAX_ADD_TIME_MINUTES, Math.round(parsed)));
}

export function sanitizeAnnouncement(message: unknown): string {
  return String(message ?? '').slice(0, MAX_ANNOUNCEMENT_CHARS);
}

export interface TelemetryBounds {
  answeredCount: number;
  totalQuestions: number;
  timeLeftSeconds: number;
  violationsCount: number;
  currentIndex: number;
}

const clampInt = (value: unknown, min: number, max: number, fallback = 0): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.round(parsed)));
};

/**
 * Clamps student-reported telemetry into a plausible range.
 * `totalQuestions` drives the answeredCount ceiling; `maxTimeSeconds` bounds the clock.
 */
export function clampTelemetry(
  incoming: Partial<TelemetryBounds>,
  totalQuestions: number,
  maxTimeSeconds = 86_400
): TelemetryBounds {
  const total = Math.max(1, Math.round(Number(totalQuestions) || 1));
  return {
    answeredCount: clampInt(incoming.answeredCount, 0, total),
    totalQuestions: total,
    timeLeftSeconds: clampInt(incoming.timeLeftSeconds, 0, maxTimeSeconds),
    violationsCount: clampInt(incoming.violationsCount, 0, 10_000),
    currentIndex: clampInt(incoming.currentIndex, 0, total),
  };
}

/**
 * Strike counts must never fall on the invigilator's screen without a pardon, otherwise a
 * reloaded or tampered student client can erase its own record.
 */
export function highWaterViolations(previous: number | undefined, incoming: number | undefined, pardoned: boolean): number {
  const prev = Number.isFinite(previous as number) ? Math.max(0, Math.round(previous as number)) : 0;
  const next = Number.isFinite(incoming as number) ? Math.max(0, Math.round(incoming as number)) : 0;
  if (pardoned) return next;
  return Math.max(prev, next);
}

export interface RateLimitDecision {
  allowed: boolean;
  /** True only on the first rejection of a window, so callers emit one notice, not one per drop. */
  warn: boolean;
}

/**
 * Sliding-window counter per key. Pure: the caller owns the state map.
 * Old windows (older than windowMs) reset automatically.
 */
export function checkRateLimit(
  state: Map<string, { windowStart: number; count: number; warned: boolean }>,
  key: string,
  now: number,
  maxPerWindow: number,
  windowMs: number
): RateLimitDecision {
  const entry = state.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    state.set(key, { windowStart: now, count: 1, warned: false });
    return { allowed: true, warn: false };
  }
  if (entry.count < maxPerWindow) {
    entry.count += 1;
    return { allowed: true, warn: false };
  }
  const warn = !entry.warned;
  entry.warned = true;
  return { allowed: false, warn };
}

/** Heartbeats from the same student closer than this are ignored (state changes bypass it). */
export const HEARTBEAT_MIN_INTERVAL_MS = 1000;
/** Log events accepted per student per window. */
export const LOG_EVENTS_PER_WINDOW = 5;
/** Log-event rate-limit window. */
export const LOG_EVENT_WINDOW_MS = 10_000;

/** Keeps the last N violations so a long exam does not inflate every heartbeat payload. */
export function recentViolationsSlice<T>(violations: T[], includeFullHistory: boolean, max = 5): T[] {
  if (includeFullHistory) return violations;
  return violations.slice(-max);
}

/**
 * Stamps a heartbeat with the receiver's clock. The sender's `lastHeartbeat` is kept only as
 * `clientTimestamp` for drift diagnostics — presence must never depend on the student's clock.
 */
export function stampHeartbeatReceipt<T extends { lastHeartbeat: number }>(
  state: T,
  receivedAt: number
): T & { clientTimestamp: number } {
  return { ...state, clientTimestamp: state.lastHeartbeat, lastHeartbeat: receivedAt };
}

/** Claims a command id; false when it is missing or was already applied. */
export function claimCommandId(executed: Set<string>, id: string | undefined): boolean {
  if (!id || executed.has(id)) return false;
  executed.add(id);
  return true;
}

/** Merges remote and local audit events by id, newest first, capped. */
export function mergeAuditEvents<T extends { id: string; createdAt: string }>(
  remote: T[],
  local: T[],
  limit = 250
): T[] {
  const byId = new Map<string, T>();
  [...remote, ...local].forEach((event) => {
    if (!byId.has(event.id)) byId.set(event.id, event);
  });
  return [...byId.values()]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

/**
 * Retries a broadcast up to `maxAttempts`, treating anything other than 'ok' as failure.
 * `send` is injected so the retry policy is testable without a Supabase channel.
 */
export async function retryBroadcast(
  send: () => Promise<'ok' | 'timed out' | 'error'>,
  maxAttempts = 3,
  wait: (attempt: number) => Promise<void> = (attempt) => new Promise((r) => setTimeout(r, 400 * attempt))
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if ((await send()) === 'ok') return true;
    } catch {
      // treat as a failed attempt
    }
    if (attempt < maxAttempts) await wait(attempt);
  }
  return false;
}
