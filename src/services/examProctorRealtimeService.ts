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
}

export type ProctorCommandType = 'unlock' | 'add_time' | 'force_submit' | 'announcement';

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
    | 'announcement';
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

let hostChannel: RealtimeChannel | null = null;

export interface ProctorDashboardCallbacks {
  onHeartbeat: (student: ProctorStudentState) => void;
  onLogEvent: (event: ProctorLogEvent) => void;
}

/**
 * Connects the teacher dashboard to receive live student telemetry.
 */
export function subscribeProctorDashboard(
  quizCode: string,
  callbacks: ProctorDashboardCallbacks
): RealtimeChannel {
  destroyProctorSession();

  const channelName = getChannelName(quizCode);

  hostChannel = supabase.channel(channelName, {
    config: { broadcast: { self: false } },
  });

  hostChannel.on('broadcast', { event: 'student_heartbeat' }, ({ payload }) => {
    callbacks.onHeartbeat(payload as ProctorStudentState);
  });

  hostChannel.on('broadcast', { event: 'proctor_log_event' }, ({ payload }) => {
    callbacks.onLogEvent(payload as ProctorLogEvent);
  });

  hostChannel.subscribe();
  return hostChannel;
}

/**
 * Broadcasts an invigilator command (unlock, add time, force submit, announcement) to students.
 */
export function sendProctorCommand(
  targetStudentId: string | 'ALL',
  type: ProctorCommandType,
  options?: { minutes?: number; message?: string }
): void {
  if (!hostChannel) return;

  const cmd: ProctorCommand = {
    id: `cmd-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    targetStudentId,
    type,
    minutes: options?.minutes,
    message: options?.message,
    timestamp: Date.now(),
  };

  hostChannel.send({
    type: 'broadcast',
    event: 'proctor_cmd',
    payload: cmd,
  });
}

/**
 * Closes the teacher proctor dashboard channel.
 */
export function destroyProctorSession(): void {
  if (hostChannel) {
    supabase.removeChannel(hostChannel);
    hostChannel = null;
  }
}
