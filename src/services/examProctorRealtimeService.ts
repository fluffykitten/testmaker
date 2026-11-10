// ─── Exam Proctor Realtime Service ───────────────────────────────────────────
// Real-time bidirectional invigilation communication via Supabase Realtime Broadcast.
// Heartbeats stay off the database; only durable audit events are persisted elsewhere.
//
// Reliability rules enforced here (see Plan/proctor_p1_p2_p3_fixes.md):
//  · presence is stamped with the receiver's clock, never the student's;
//  · sends are retried and queued until the channel is SUBSCRIBED;
//  · one student cannot flood the log (per-student sliding window);
//  · a violation is only sent on the channel it belongs to;
//  · a channel teardown only removes the session that owns it.

import { supabase } from '../lib/supabase';
import type { SecurityTierAction } from '../lib/securityTiers';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  checkRateLimit,
  HEARTBEAT_MIN_INTERVAL_MS,
  LOG_EVENTS_PER_WINDOW,
  LOG_EVENT_WINDOW_MS,
  retryBroadcast,
  stampHeartbeatReceipt,
} from '../lib/proctorGuards';

// ─── Types & Interfaces ────────────────────────────────────────────────────────

export type StudentExamStatus = 'active' | 'warning' | 'locked' | 'submitted' | 'offline';

export interface ProctorViolationSummary {
  timestamp: string;
  detail: string;
  type?: string;
}

export interface ProctorStudentState {
  studentId: string;           // Canonical candidate identifier
  studentName: string;
  candidateNumber?: string;
  candidateClass?: string;
  status: StudentExamStatus;
  answeredCount: number;
  totalQuestions: number;
  currentIndex: number;
  timeLeftSeconds: number;
  violationsCount: number;
  lastViolation?: string;
  lockReason?: string;
  multiMonitorDetected: boolean;
  deviceOS?: string;
  lastHeartbeat: number;       // Sender's clock (diagnostic only)
  /** Receiver's clock at receipt — the authoritative presence timestamp. */
  clientTimestamp?: number;
  recentViolations?: ProctorViolationSummary[];
  exceededMaxViolations?: boolean;
  maxViolations?: number;
  strikeCount?: number;
  currentTierName?: string;
  currentTierAction?: SecurityTierAction;
  totalPenaltySeconds?: number;
  autoSubmittedBySecurity?: boolean;
  quizCode?: string;
  quizTitle?: string;
}

export type ProctorCommandType = 'unlock' | 'add_time' | 'force_submit' | 'announcement' | 'pardon';

export interface ProctorCommand {
  id: string;
  targetStudentId: string | 'ALL';
  targetClass?: string;        // Scopes broadcast to a specific class cohort (e.g. "X IPA 1")
  type: ProctorCommandType;
  minutes?: number;            // For 'add_time' (e.g. +5)
  message?: string;            // For 'announcement'
  timestamp: number;
}

export interface ProctorLogEvent {
  id: string;
  timestamp: string;
  studentName: string;
  candidateNumber?: string;
  quizCode?: string;
  quizTitle?: string;
  type:
    | 'join'
    | 'blur'
    | 'tab_switch'
    | 'fullscreen_exit'
    | 'multi_monitor'
    | 'shortcut'
    | 'locked'
    | 'unlocked'
    | 'time_extended'
    | 'submitted'
    | 'announcement'
    | 'pardon'
    | 'exceeded_limit'
    | 'rate_limit';
  detail: string;
  severity: 'info' | 'warning' | 'critical';
}

function getChannelName(quizCode: string): string {
  return `exam_proctor:${quizCode.trim().toUpperCase()}`;
}

const MAX_QUEUED_PAYLOADS = 50;

/**
 * Sends a broadcast with bounded retries. Returns false when every attempt failed so callers
 * can decide whether the loss matters.
 */
async function sendBroadcastWithRetry(
  channel: RealtimeChannel,
  event: string,
  payload: unknown,
  maxAttempts = 3
): Promise<boolean> {
  return retryBroadcast(
    async () => {
      const status = await channel.send({ type: 'broadcast', event, payload });
      return status as 'ok' | 'timed out' | 'error';
    },
    maxAttempts
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// STUDENT SIDE HOOKS
// ═══════════════════════════════════════════════════════════════════════════════

let studentChannel: RealtimeChannel | null = null;
let studentChannelCode = '';
let studentSubscribed = false;
let activeSessionToken = '';
let currentStudentId: string = '';
let currentStudentClass: string = '';
let pendingStudentPayloads: Array<{ event: string; payload: unknown }> = [];

export interface StudentProctorCallbacks {
  onCommandReceived: (cmd: ProctorCommand) => void;
  onSyncRequested?: () => void;
}

function flushStudentQueue(): void {
  if (!studentChannel || !studentSubscribed) return;
  const channel = studentChannel;
  const queue = pendingStudentPayloads;
  pendingStudentPayloads = [];
  queue.forEach(({ event, payload }) => {
    void sendBroadcastWithRetry(channel, event, payload);
  });
}

function enqueueOrSendStudent(event: string, payload: unknown): void {
  if (!studentChannel || !studentSubscribed) {
    // Keep only the newest heartbeat: stale states are worthless and would stack up.
    if (event === 'student_heartbeat') {
      pendingStudentPayloads = pendingStudentPayloads.filter((item) => item.event !== event);
    }
    pendingStudentPayloads.push({ event, payload });
    if (pendingStudentPayloads.length > MAX_QUEUED_PAYLOADS) pendingStudentPayloads.shift();
    return;
  }
  void sendBroadcastWithRetry(studentChannel, event, payload);
}

/**
 * Connects a student client to the live proctor channel.
 * `sessionToken` scopes teardown to this sitting (defaults to the student id).
 */
export function joinProctorSession(
  quizCode: string,
  initialState: ProctorStudentState,
  callbacks: StudentProctorCallbacks,
  sessionToken?: string
): RealtimeChannel {
  leaveProctorSession();

  currentStudentId = initialState.studentId;
  currentStudentClass = (initialState.candidateClass || '').trim();
  activeSessionToken = sessionToken || initialState.studentId;
  studentChannelCode = quizCode.trim().toUpperCase();
  studentSubscribed = false;
  pendingStudentPayloads = [];

  const channelName = getChannelName(quizCode);

  studentChannel = supabase.channel(channelName, {
    config: { broadcast: { self: false } },
  });

  // Listen for commands broadcast by teacher
  studentChannel.on('broadcast', { event: 'proctor_cmd' }, ({ payload }) => {
    const cmd = payload as ProctorCommand;
    if (!cmd) return;

    // Check if targeted to ALL or this student
    const matchesStudent = cmd.targetStudentId === 'ALL' || cmd.targetStudentId === currentStudentId;

    // Check if targeted to a specific class
    const matchesClass =
      !cmd.targetClass ||
      (Boolean(currentStudentClass) &&
        cmd.targetClass.trim().toLowerCase() === currentStudentClass.toLowerCase());

    if (matchesStudent && matchesClass) {
      callbacks.onCommandReceived(cmd);
    }
  });

  // Listen for proctor immediate state sync requests
  studentChannel.on('broadcast', { event: 'proctor_sync_request' }, () => {
    callbacks.onSyncRequested?.();
  });

  studentChannel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      studentSubscribed = true;
      flushStudentQueue();
      sendStudentHeartbeat(initialState);
    } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR') {
      studentSubscribed = false;
    }
  });

  return studentChannel;
}

/**
 * Sends a telemetry update / heartbeat to the teacher dashboard.
 */
export function sendStudentHeartbeat(state: ProctorStudentState): void {
  if (!studentChannel) return;
  enqueueOrSendStudent('student_heartbeat', { ...state, lastHeartbeat: Date.now() });
}

/**
 * Broadcasts a security violation event to the proctor log stream.
 */
export function sendStudentViolation(
  quizCode: string,
  studentState: ProctorStudentState,
  violation: { type: string; detail: string; severity?: 'info' | 'warning' | 'critical' }
): void {
  if (!studentChannel) return;

  const normalizedCode = (quizCode || studentState.quizCode || '').trim().toUpperCase();
  // Never leak an event onto a channel that belongs to a different sitting.
  if (studentChannelCode && normalizedCode && normalizedCode !== studentChannelCode) {
    console.warn('[proctor] violation dropped: channel/quiz mismatch', { normalizedCode, studentChannelCode });
    return;
  }

  const eventPayload: ProctorLogEvent = {
    id: `evt-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    timestamp: new Date().toISOString(),
    studentName: studentState.studentName,
    candidateNumber: studentState.candidateNumber,
    quizCode: normalizedCode || studentChannelCode,
    quizTitle: studentState.quizTitle,
    type: (violation.type as any) || 'blur',
    detail: violation.detail,
    severity: violation.severity || 'warning',
  };

  enqueueOrSendStudent('proctor_log_event', eventPayload);

  // Also update heartbeat state
  sendStudentHeartbeat({ ...studentState, quizCode: normalizedCode || studentChannelCode });
}

/**
 * Cleans up the student's realtime connection.
 * When `expectedToken` is supplied, a stale cleanup (old effect, secondary tab) will not tear
 * down a newer session that owns the channel.
 */
export function leaveProctorSession(expectedToken?: string): void {
  if (expectedToken && activeSessionToken && expectedToken !== activeSessionToken) return;
  if (studentChannel) {
    supabase.removeChannel(studentChannel);
    studentChannel = null;
  }
  studentSubscribed = false;
  pendingStudentPayloads = [];
  activeSessionToken = '';
  studentChannelCode = '';
  currentStudentId = '';
  currentStudentClass = '';
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEACHER (PROCTOR) SIDE HOOKS
// ═══════════════════════════════════════════════════════════════════════════════

const hostChannels = new Map<string, RealtimeChannel>();
const hostSubscribed = new Map<string, boolean>();
const pendingHostCommands = new Map<string, ProctorCommand[]>();
const lastHeartbeatAt = new Map<string, number>();
const logRateState = new Map<string, { windowStart: number; count: number; warned: boolean }>();

export interface ProctorDashboardCallbacks {
  onHeartbeat: (student: ProctorStudentState) => void;
  onLogEvent: (event: ProctorLogEvent) => void;
}

function flushHostQueue(code: string): void {
  const ch = hostChannels.get(code);
  const queue = pendingHostCommands.get(code);
  if (!ch || !queue || !hostSubscribed.get(code)) return;
  pendingHostCommands.set(code, []);
  queue.forEach((cmd) => {
    void sendBroadcastWithRetry(ch, 'proctor_cmd', cmd);
  });
}

/**
 * Connects the teacher dashboard to receive live student telemetry across multiple quizzes.
 */
export function subscribeMultiProctorDashboard(
  quizCodes: string[],
  callbacks: ProctorDashboardCallbacks
): void {
  destroyProctorSession();

  const normalizedCodes = Array.from(
    new Set(quizCodes.map((c) => c.trim().toUpperCase()).filter(Boolean))
  );

  normalizedCodes.forEach((code) => {
    const channelName = getChannelName(code);
    const ch = supabase.channel(channelName, {
      config: { broadcast: { self: false } },
    });

    ch.on('broadcast', { event: 'student_heartbeat' }, ({ payload }) => {
      const student = payload as ProctorStudentState;
      const receivedAt = Date.now();
      const key = `${code}::${student.studentId}`;

      // One student's client cannot drown the dashboard in beats. State changes still pass.
      const previous = lastHeartbeatAt.get(key);
      const isStateChange = student.status === 'submitted' || student.status === 'locked';
      if (
        previous !== undefined &&
        !isStateChange &&
        receivedAt - previous < HEARTBEAT_MIN_INTERVAL_MS
      ) {
        return;
      }
      lastHeartbeatAt.set(key, receivedAt);

      callbacks.onHeartbeat({
        ...stampHeartbeatReceipt(student, receivedAt),
        quizCode: (student.quizCode || code).toUpperCase(),
      });
    });

    ch.on('broadcast', { event: 'proctor_log_event' }, ({ payload }) => {
      const logEvent = payload as ProctorLogEvent;
      const rateKey = `${code}::${(logEvent.studentName || '').toLowerCase()}|${(logEvent.candidateNumber || '').toLowerCase()}`;
      const decision = checkRateLimit(logRateState, rateKey, Date.now(), LOG_EVENTS_PER_WINDOW, LOG_EVENT_WINDOW_MS);

      if (!decision.allowed) {
        if (decision.warn) {
          callbacks.onLogEvent({
            id: `rate_${Date.now()}`,
            timestamp: new Date().toISOString(),
            studentName: logEvent.studentName,
            candidateNumber: logEvent.candidateNumber,
            quizCode: code,
            quizTitle: logEvent.quizTitle,
            type: 'rate_limit',
            detail: 'Telemetry rate limit exceeded for this candidate — throttling noisy event stream',
            severity: 'warning',
          });
        }
        return;
      }

      callbacks.onLogEvent({
        ...logEvent,
        quizCode: (logEvent.quizCode || code).toUpperCase(),
      });
    });

    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        hostSubscribed.set(code, true);
        flushHostQueue(code);
        void sendBroadcastWithRetry(ch, 'proctor_sync_request', { requestedAt: Date.now() });
      } else {
        hostSubscribed.set(code, false);
      }
    });

    hostChannels.set(code, ch);
  });
}

/**
 * Connects the teacher dashboard to receive live student telemetry for a single quiz.
 */
export function subscribeProctorDashboard(
  quizCode: string,
  callbacks: ProctorDashboardCallbacks
): RealtimeChannel | null {
  subscribeMultiProctorDashboard([quizCode], callbacks);
  return hostChannels.get(quizCode.trim().toUpperCase()) ?? null;
}

/**
 * Broadcasts an invigilator command (unlock, add_time, force submit, announcement) to students on a specific quiz channel.
 * Commands issued before the host channel is SUBSCRIBED are queued and flushed on connect.
 */
export function sendProctorCommand(
  quizCode: string,
  targetStudentId: string | 'ALL',
  type: ProctorCommandType,
  options?: { minutes?: number; message?: string; targetClass?: string }
): void {
  const code = quizCode.trim().toUpperCase();
  const ch = hostChannels.get(code);
  if (!ch) return;

  const cmd: ProctorCommand = {
    id: `cmd-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    targetStudentId,
    targetClass: options?.targetClass,
    type,
    minutes: options?.minutes,
    message: options?.message,
    timestamp: Date.now(),
  };

  if (!hostSubscribed.get(code)) {
    const queue = pendingHostCommands.get(code) ?? [];
    queue.push(cmd);
    if (queue.length > MAX_QUEUED_PAYLOADS) queue.shift();
    pendingHostCommands.set(code, queue);
    return;
  }

  void sendBroadcastWithRetry(ch, 'proctor_cmd', cmd);
}

/**
 * Closes all active teacher proctor dashboard channels.
 */
export function destroyProctorSession(): void {
  hostChannels.forEach((ch) => {
    supabase.removeChannel(ch);
  });
  hostChannels.clear();
  hostSubscribed.clear();
  pendingHostCommands.clear();
  lastHeartbeatAt.clear();
  logRateState.clear();
}
