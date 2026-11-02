// ─── Exam Proctor Realtime Service ───────────────────────────────────────────
// Real-time bidirectional invigilation communication via Supabase Realtime Broadcast.
// Zero database overhead: uses live WebSockets for instant student telemetry and teacher controls.

import { supabase } from '../lib/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';

// ─── Types & Interfaces ────────────────────────────────────────────────────────

export type StudentExamStatus = 'active' | 'warning' | 'locked' | 'submitted' | 'offline';

export interface ProctorViolationSummary {
  timestamp: string;
  detail: string;
  type?: string;
}

export interface ProctorStudentState {
  studentId: string;           // Unique session hash or candidate identifier
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
  lastHeartbeat: number;       // Unix timestamp (ms)
  recentViolations?: ProctorViolationSummary[];
  exceededMaxViolations?: boolean;
  maxViolations?: number;
  quizCode?: string;
  quizTitle?: string;
}

export type ProctorCommandType = 'unlock' | 'add_time' | 'force_submit' | 'announcement' | 'pardon';

export interface ProctorCommand {
  id: string;
  targetStudentId: string | 'ALL';
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
    | 'exceeded_limit';
  detail: string;
  severity: 'info' | 'warning' | 'critical';
}

function getChannelName(quizCode: string): string {
  return `exam_proctor:${quizCode.trim().toUpperCase()}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STUDENT SIDE HOOKS
// ═══════════════════════════════════════════════════════════════════════════════

let studentChannel: RealtimeChannel | null = null;
let currentStudentId: string = '';

export interface StudentProctorCallbacks {
  onCommandReceived: (cmd: ProctorCommand) => void;
  onSyncRequested?: () => void;
}

/**
 * Connects a student client to the live proctor channel.
 */
export function joinProctorSession(
  quizCode: string,
  initialState: ProctorStudentState,
  callbacks: StudentProctorCallbacks
): RealtimeChannel {
  leaveProctorSession();

  currentStudentId = initialState.studentId;
  const channelName = getChannelName(quizCode);

  studentChannel = supabase.channel(channelName, {
    config: { broadcast: { self: false } },
  });

  // Listen for commands broadcast by teacher
  studentChannel.on('broadcast', { event: 'proctor_cmd' }, ({ payload }) => {
    const cmd = payload as ProctorCommand;
    if (cmd && (cmd.targetStudentId === 'ALL' || cmd.targetStudentId === currentStudentId)) {
      callbacks.onCommandReceived(cmd);
    }
  });

  // Listen for proctor immediate state sync requests
  studentChannel.on('broadcast', { event: 'proctor_sync_request' }, () => {
    callbacks.onSyncRequested?.();
  });

  studentChannel.subscribe((status) => {
    if (status === 'SUBSCRIBED') {
      sendStudentHeartbeat(initialState);
    }
  });

  return studentChannel;
}

/**
 * Sends a telemetry update / heartbeat to the teacher dashboard.
 */
export function sendStudentHeartbeat(state: ProctorStudentState): void {
  if (!studentChannel) return;
  studentChannel.send({
    type: 'broadcast',
    event: 'student_heartbeat',
    payload: { ...state, lastHeartbeat: Date.now() },
  });
}

/**
 * Broadcasts a security violation event to the proctor log stream.
 */
export function sendStudentViolation(
  _quizCode: string,
  studentState: ProctorStudentState,
  violation: { type: string; detail: string; severity?: 'info' | 'warning' | 'critical' }
): void {
  if (!studentChannel) return;
  const eventPayload: ProctorLogEvent = {
    id: `evt-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    timestamp: new Date().toISOString(),
    studentName: studentState.studentName,
    candidateNumber: studentState.candidateNumber,
    quizCode: studentState.quizCode,
    quizTitle: studentState.quizTitle,
    type: (violation.type as any) || 'blur',
    detail: violation.detail,
    severity: violation.severity || 'warning',
  };

  studentChannel.send({
    type: 'broadcast',
    event: 'proctor_log_event',
    payload: eventPayload,
  });

  // Also update heartbeat state
  sendStudentHeartbeat(studentState);
}

/**
 * Cleans up the student's realtime connection.
 */
export function leaveProctorSession(): void {
  if (studentChannel) {
    supabase.removeChannel(studentChannel);
    studentChannel = null;
    currentStudentId = '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEACHER (PROCTOR) SIDE HOOKS
// ═══════════════════════════════════════════════════════════════════════════════

const hostChannels = new Map<string, RealtimeChannel>();

export interface ProctorDashboardCallbacks {
  onHeartbeat: (student: ProctorStudentState) => void;
  onLogEvent: (event: ProctorLogEvent) => void;
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
      callbacks.onHeartbeat({
        ...student,
        quizCode: (student.quizCode || code).toUpperCase(),
      });
    });

    ch.on('broadcast', { event: 'proctor_log_event' }, ({ payload }) => {
      const logEvent = payload as ProctorLogEvent;
      callbacks.onLogEvent({
        ...logEvent,
        quizCode: (logEvent.quizCode || code).toUpperCase(),
      });
    });

    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        ch.send({
          type: 'broadcast',
          event: 'proctor_sync_request',
          payload: { requestedAt: Date.now() },
        });
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
 * Broadcasts an invigilator command (unlock, add time, force submit, announcement) to students on a specific quiz channel.
 */
export function sendProctorCommand(
  quizCode: string,
  targetStudentId: string | 'ALL',
  type: ProctorCommandType,
  options?: { minutes?: number; message?: string }
): void {
  const ch = hostChannels.get(quizCode.trim().toUpperCase());
  if (!ch) return;

  const cmd: ProctorCommand = {
    id: `cmd-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    targetStudentId,
    type,
    minutes: options?.minutes,
    message: options?.message,
    timestamp: Date.now(),
  };

  ch.send({
    type: 'broadcast',
    event: 'proctor_cmd',
    payload: cmd,
  });
}

/**
 * Closes all active teacher proctor dashboard channels.
 */
export function destroyProctorSession(): void {
  hostChannels.forEach((ch) => {
    supabase.removeChannel(ch);
  });
  hostChannels.clear();
}
