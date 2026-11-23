import React, { useState, useEffect, useMemo, useCallback, useRef, useDeferredValue } from 'react';
import type { PublishedQuiz } from '../services/quizManagerService';
import {
  subscribeMultiProctorDashboard,
  sendProctorCommand,
  destroyProctorSession,
  type ProctorStudentState,
  type ProctorLogEvent,
  type StudentExamStatus,
} from '../services/examProctorRealtimeService';
import {
  getSubmissionsForQuiz,
  fetchProctorMonitoredSubmissions,
  ingestEmergencySubmissionBatch,
  type BatchEmergencyIngestionSummary,
} from '../services/quizSubmissionService';
import { fetchAndApplyOverrides } from '../services/quizCodeService';
import { fetchCustomTestWithQuestions } from '../services/testBuilderService';
import type { Question } from '../types/database';
import { getCanonicalProctorStudentId } from '../utils/examSecurityUtils';
import {
  clampProgressPercent,
  clampTelemetry,
  computeSubmissionProgress,
  highWaterViolations,
  verifyAndBindStudentHeartbeatProof,
} from '../lib/proctorGuards';
import {
  recordProctorAuditEvent,
  loadProctorAuditEvents,
  onProctorAuditAuthError,
} from '../services/proctorAuditLogService';
import {
  OVERDUE_LOCK_THRESHOLD_MS,
  reconcileStudentLockTimestamp,
  getLockedDurationMs,
  formatLockedDuration,
  computeWaitCompensationMinutes,
  findOverdueLockedStudents,
  filterProctorLogs,
  upsertProctorAlertToast,
  getPriorityTriageRank,
  type ProctorLogCategory,
  type ProctorAlertSoundMode,
  type ProctorAlertScopeMode,
  type ProctorAlertToast,
} from '../lib/proctorAlertEngine';
import { exportProctorAuditLogExcelICM } from '../services/icmExcelExportService';
import { supabase, hasActiveTeacherSession, isSupabaseConfigured } from '../lib/supabase';
import { getSchoolClasses, loadAndSyncSchoolClasses } from '../lib/settings';
import {
  normalizeTargetClassKey,
  resolveProctorSidebarClasses,
} from '../lib/examTargetClasses';
import {
  getSchoolRoster,
  loadAndSyncSchoolRoster,
  type RosterStudent,
} from '../services/studentRosterService';
import './LiveInvigilatorModal.css';

export interface LiveInvigilatorModalProps {
  quizzes: PublishedQuiz[];
  initialFocusQuizCode?: string;
  onClose: () => void;
}

export type ProctorSortOption =
  | 'priority'
  | 'class_seat'
  | 'status'
  | 'name'
  | 'progress'
  | 'time_left'
  | 'violations';

function playProctorChime(kind: 'violation' | 'locked' | 'locked_overdue'): void {
  if (typeof window === 'undefined') return;
  try {
    const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext | undefined;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const notes =
      kind === 'locked_overdue'
        ? [880, 660, 880, 1046]
        : kind === 'locked'
          ? [784, 587]
          : [659];

    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = kind === 'locked_overdue' ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.13);
      gain.gain.setValueAtTime(0.001, now + idx * 0.13);
      gain.gain.exponentialRampToValueAtTime(0.11, now + idx * 0.13 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.13 + 0.11);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.13);
      osc.stop(now + idx * 0.13 + 0.12);
    });

    setTimeout(() => {
      void ctx.close().catch(() => { });
    }, notes.length * 160 + 200);
  } catch {
    // Ignore Web Audio errors when autoplay is blocked before interaction
  }
}

const normalizeName = (value?: string) => (value || '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Two dashboard rows describe the same candidate (used to retire pre-canonical-id keys). */
function sameCandidate(a: ProctorStudentState, b: ProctorStudentState): boolean {
  if (normalizeName(a.studentName) !== normalizeName(b.studentName)) return false;
  const numA = (a.candidateNumber || '').trim().toLowerCase();
  const numB = (b.candidateNumber || '').trim().toLowerCase();
  if (numA && numB) return numA === numB;
  if (!numA && !numB) return (a.candidateClass || '').trim().toLowerCase() === (b.candidateClass || '').trim().toLowerCase();
  return false;
}

export const LiveInvigilatorModal: React.FC<LiveInvigilatorModalProps> = ({
  quizzes,
  initialFocusQuizCode,
  onClose,
}) => {
  // ─── Scope State: Single Exam vs School-Wide All Active Exams ─────────────────
  const [scope, setScope] = useState<'focus' | 'all'>(() => {
    if (initialFocusQuizCode) {
      const exists = quizzes.some(
        (q) => q.quizCode.toUpperCase() === initialFocusQuizCode.trim().toUpperCase()
      );
      if (exists) return 'focus';
    }
    return 'all';
  });

  // ─── Navigation & Filtering State ───────────────────────────────────────────
  const [sidebarMode, setSidebarMode] = useState<'class' | 'exam'>('class');
  const [selectedKey, setSelectedKey] = useState<string>('__ALL__');
  const [secondaryFilter, setSecondaryFilter] = useState<string>('all');
  const [hideEmptyClasses, setHideEmptyClasses] = useState<boolean>(false);

  // ─── Telemetry & Audit Stream State ─────────────────────────────────────────
  const [students, setStudents] = useState<Record<string, ProctorStudentState>>({});
  const [logEvents, setLogEvents] = useState<ProctorLogEvent[]>([]);
  const [activeFilter, setActiveFilter] = useState<
    'all' | 'exceeded' | 'locked' | 'warnings' | 'active' | 'submitted' | 'missing'
  >('all');
  const [schoolClasses, setSchoolClasses] = useState<string[]>(() => getSchoolClasses());
  const [schoolRoster, setSchoolRoster] = useState<RosterStudent[]>(() => {
    try {
      return getSchoolRoster();
    } catch {
      return [];
    }
  });

  useEffect(() => {
    loadAndSyncSchoolClasses().then((classes) => {
      if (classes && classes.length > 0) {
        setSchoolClasses(classes);
      }
    }).catch(() => { });

    loadAndSyncSchoolRoster().then((list) => {
      if (list && list.length > 0) {
        setSchoolRoster(list);
      }
    }).catch(() => { });

    const handleSchoolClassesUpdated = (e: Event) => {
      const custom = e as CustomEvent<{ classes?: string[] }>;
      setSchoolClasses(custom.detail?.classes || getSchoolClasses());
    };
    window.addEventListener('school_classes_updated', handleSchoolClassesUpdated);
    return () => window.removeEventListener('school_classes_updated', handleSchoolClassesUpdated);
  }, []);
  const [sortBy, setSortBy] = useState<ProctorSortOption>('class_seat');
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const pendingHeartbeatsRef = useRef<Record<string, ProctorStudentState>>({});
  /** Composite key → time the teacher pardoned it; lets the strike high-water mark drop once. */
  const pardonedAtRef = useRef<Record<string, number>>({});
  /** Canonical/draft key → first-seen SHA-256 session proof (`VULN-P3-10`). */
  const boundHeartbeatKeysRef = useRef<Record<string, string>>({});
  const [showAnnouncementModal, setShowAnnouncementModal] = useState(false);
  const [announcementText, setAnnouncementText] = useState('');
  const [announcementSuccess, setAnnouncementSuccess] = useState(false);
  const [showLogDrawer, setShowLogDrawer] = useState(false);
  const [logScopeMode, setLogScopeMode] = useState<'current_scope' | 'whole_school'>('current_scope');
  const [logCategory, setLogCategory] = useState<ProctorLogCategory>('all');
  const [logSearch, setLogSearch] = useState('');
  const [selectedStudentLogKey, setSelectedStudentLogKey] = useState<string | null>(null);
  const [directNoticeTargetKey, setDirectNoticeTargetKey] = useState<string | null>(null);
  const [directNoticeText, setDirectNoticeText] = useState('');
  const [directNoticeSent, setDirectNoticeSent] = useState(false);
  const [alertToasts, setAlertToasts] = useState<ProctorAlertToast[]>([]);
  const [alertSoundMode, setAlertSoundMode] = useState<ProctorAlertSoundMode>('all');
  const [alertScopeMode, setAlertScopeMode] = useState<ProctorAlertScopeMode>('selected_scope');
  const [unreadViolationsByClass, setUnreadViolationsByClass] = useState<Record<string, number>>({});
  const [focusedStudentKey, setFocusedStudentKey] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table');
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const cardRefs = useRef<Record<string, HTMLElement | null>>({});
  const alertedOverdueEpisodeRef = useRef<Record<string, number>>({});
  const alertScopeRef = useRef({ alertScopeMode, alertSoundMode, sidebarMode, selectedKey, secondaryFilter });
  alertScopeRef.current = { alertScopeMode, alertSoundMode, sidebarMode, selectedKey, secondaryFilter };
  const [cloudAuthWarning, setCloudAuthWarning] = useState<string | null>(null);

  // Verify live teacher cloud session on mount and subscribe to RLS auth failures
  useEffect(() => {
    let active = true;
    const expiredMessage =
      'Cloud invigilator session expired or not signed in — live WebSocket telemetry continues, but cloud audit logs, command signing, and result syncing are paused until you sign in again.';

    const checkSession = async () => {
      if (!hasActiveTeacherSession()) {
        if (active) setCloudAuthWarning(expiredMessage);
        return;
      }
      try {
        const { data, error } = await (supabase as any).rpc('is_authenticated_teacher');
        if (!active) return;
        if (error || data !== true) {
          setCloudAuthWarning(expiredMessage);
        } else {
          setCloudAuthWarning(null);
        }
      } catch {
        // Keep current banner state on transient network errors
      }
    };

    void checkSession();
    const intervalId = setInterval(() => void checkSession(), 60_000);
    const unsubAuditErr = onProctorAuditAuthError(() => {
      if (active) setCloudAuthWarning(expiredMessage);
    });

    return () => {
      active = false;
      clearInterval(intervalId);
      unsubAuditErr();
    };
  }, []);

  // ─── Air-Gapped Emergency Offline Paper Ingestion State ────────────────────
  const [showEmergencyIngestModal, setShowEmergencyIngestModal] = useState(false);
  const [isIngestingEmergency, setIsIngestingEmergency] = useState(false);
  const [isDragOverEmergency, setIsDragOverEmergency] = useState(false);
  const [emergencyIngestionSummary, setEmergencyIngestionSummary] =
    useState<BatchEmergencyIngestionSummary | null>(null);
  const emergencyFileInputRef = useRef<HTMLInputElement>(null);

  // ─── Monitored Quizzes Directory ───────────────────────────────────────────
  const quizByCode = useMemo(() => {
    const map: Record<string, PublishedQuiz> = {};
    quizzes.forEach((q) => {
      if (q.quizCode) {
        map[q.quizCode.trim().toUpperCase()] = q;
      }
    });
    return map;
  }, [quizzes]);

  const monitoredQuizzes = useMemo(() => {
    if (scope === 'focus' && initialFocusQuizCode) {
      const clean = initialFocusQuizCode.trim().toUpperCase();
      const target = quizByCode[clean];
      if (target) return [target];
    }
    return quizzes;
  }, [scope, initialFocusQuizCode, quizByCode, quizzes]);

  const monitoredCodesKey = useMemo(() => {
    return monitoredQuizzes
      .map((q) => (q.quizCode || '').trim().toUpperCase())
      .filter(Boolean)
      .sort()
      .join('|');
  }, [monitoredQuizzes]);

  const monitoredQuizzesRef = useRef(monitoredQuizzes);
  monitoredQuizzesRef.current = monitoredQuizzes;
  const quizByCodeRef = useRef(quizByCode);
  quizByCodeRef.current = quizByCode;

  const isMultiExam = monitoredQuizzes.length > 1;
  const singleFocusQuiz = monitoredQuizzes.length === 1 ? monitoredQuizzes[0] : null;

  // Helper helpers
  const getMaxViolations = useCallback(
    (s: ProctorStudentState): number => {
      if (typeof s.maxViolations === 'number' && s.maxViolations > 0) {
        return s.maxViolations;
      }
      const q = s.quizCode ? quizByCode[s.quizCode.toUpperCase()] : undefined;
      return q?.maxViolations || 0;
    },
    [quizByCode]
  );

  const isStudentExceeded = useCallback(
    (s: ProctorStudentState): boolean => {
      if (s.autoSubmittedBySecurity) return true;
      const maxV = getMaxViolations(s);
      const strikes = s.strikeCount ?? s.violationsCount;
      return Boolean(s.exceededMaxViolations || (maxV > 0 && strikes >= maxV));
    },
    [getMaxViolations]
  );

  const getStudentClass = (s: ProctorStudentState): string => {
    return (s.candidateClass || '').trim() || 'Unassigned';
  };

  // Reset selected key & secondary filter when scope or sidebar mode changes
  useEffect(() => {
    setSelectedKey('__ALL__');
    setSecondaryFilter('all');
  }, [scope, sidebarMode]);

  // ─── 1. Submissions Backfill from Storage & DB ─────────────────────────────
  useEffect(() => {
    const currentMonitoredQuizzes = monitoredQuizzesRef.current;
    if (currentMonitoredQuizzes.length === 0) return;

    let cancelled = false;

    // A. Local submissions backfill
    try {
      const localLoaded: Record<string, ProctorStudentState> = {};
      currentMonitoredQuizzes.forEach((quiz) => {
        const localSubs = getSubmissionsForQuiz(quiz.id, quiz.quizCode);
        if (localSubs && localSubs.length > 0) {
          localSubs.forEach((sub) => {
            const qCode = (quiz.quizCode || '').trim().toUpperCase();
            // Same key the live channel uses, so the submitted row replaces the live row
            // instead of appearing beside it (P1-B).
            const canonicalId =
              sub.forensics?.proctorStudentId ||
              getCanonicalProctorStudentId({
                quizCode: qCode,
                studentName: sub.studentName,
                candidateNumber: sub.candidateNumber,
                studentClass: sub.studentClass,
              });
            const compositeKey = `${qCode}::${canonicalId}`;
            const subProgress = computeSubmissionProgress(sub, quiz.questionCount);
            localLoaded[compositeKey] = {
              studentId: canonicalId,
              studentName: sub.studentName,
              candidateNumber: sub.candidateNumber,
              candidateClass: sub.studentClass,
              status: 'submitted',
              answeredCount: subProgress.answeredCount,
              totalQuestions: subProgress.totalQuestions,
              currentIndex: subProgress.totalQuestions,
              timeLeftSeconds: 0,
              violationsCount: sub.violationsCount || 0,
              multiMonitorDetected: false,
              lastHeartbeat: new Date(sub.submittedAt).getTime() || Date.now(),
              quizCode: qCode,
              quizTitle: quiz.title,
            };
          });
        }
      });

      if (Object.keys(localLoaded).length > 0) {
        setStudents((prev) => ({ ...localLoaded, ...prev }));
      }
    } catch { }

    // B. Cloud submissions sync (scoped strictly to monitoredQuizzes, read-only)
    fetchProctorMonitoredSubmissions(monitoredQuizzes)
      .then((allSubs) => {
        if (cancelled) return;
        const cloudLoaded: Record<string, ProctorStudentState> = {};
        const hasDetailedResultsByKey: Record<string, boolean> = {};
        monitoredQuizzesRef.current.forEach((quiz) => {
          const qCode = (quiz.quizCode || '').trim().toUpperCase();
          const quizSubs = allSubs.filter(
            (s) => s.quizId === quiz.id || s.quizCode.toUpperCase() === qCode
          );
          const fallbackTotal = Math.max(1, Math.round(Number(quiz.questionCount) || 1));
          quizSubs.forEach((sub) => {
            // Same canonical key as the live channel (P1-B).
            const canonicalId =
              sub.forensics?.proctorStudentId ||
              getCanonicalProctorStudentId({
                quizCode: qCode,
                studentName: sub.studentName,
                candidateNumber: sub.candidateNumber,
                studentClass: sub.studentClass,
              });
            const compositeKey = `${qCode}::${canonicalId}`;
            const hasQuestionResults =
              Array.isArray(sub.questionResults) && sub.questionResults.length > 0;
            const subProgress = computeSubmissionProgress(sub, quiz.questionCount);
            const resolvedTotal = hasQuestionResults ? subProgress.totalQuestions : fallbackTotal;
            const resolvedAnswered = hasQuestionResults ? subProgress.answeredCount : fallbackTotal;
            hasDetailedResultsByKey[compositeKey] = hasQuestionResults;
            cloudLoaded[compositeKey] = {
              studentId: canonicalId,
              studentName: sub.studentName,
              candidateNumber: sub.candidateNumber,
              candidateClass: sub.studentClass,
              status: 'submitted',
              answeredCount: resolvedAnswered,
              totalQuestions: resolvedTotal,
              currentIndex: resolvedTotal,
              timeLeftSeconds: 0,
              violationsCount: sub.violationsCount || 0,
              multiMonitorDetected: false,
              lastHeartbeat: new Date(sub.submittedAt).getTime() || Date.now(),
              quizCode: qCode,
              quizTitle: quiz.title,
            };
          });
        });

        if (Object.keys(cloudLoaded).length > 0) {
          setStudents((prev) => {
            const next = { ...prev };
            Object.entries(cloudLoaded).forEach(([compKey, row]) => {
              const existing = next[compKey];
              if (!existing || existing.status !== 'submitted') {
                const keepExistingCounts =
                  Boolean(existing) &&
                  !hasDetailedResultsByKey[compKey] &&
                  (existing.answeredCount || 0) > 0;
                next[compKey] = keepExistingCounts
                  ? {
                    ...row,
                    answeredCount: existing.answeredCount,
                    totalQuestions: existing.totalQuestions || row.totalQuestions,
                    currentIndex: existing.currentIndex || row.currentIndex,
                  }
                  : row;
              }
            });
            return next;
          });
        }
      })
      .catch(() => { });

    return () => {
      cancelled = true;
    };
  }, [monitoredCodesKey]);

  // ─── 1B. Micro-Batch Heartbeats Flush (300ms window for high-volume 200+ concurrency) ─
  useEffect(() => {
    const timer = setInterval(() => {
      const pending = pendingHeartbeatsRef.current;
      const keys = Object.keys(pending);
      if (keys.length === 0) return;

      pendingHeartbeatsRef.current = {};
      setStudents((prev) => {
        let changed = false;
        const next: Record<string, ProctorStudentState> = { ...prev };

        keys.forEach((compKey) => {
          const incoming = pending[compKey];
          const existing = next[compKey];
          if (existing?.status === 'submitted' && incoming.status !== 'submitted') {
            return;
          }

          // Clamp self-reported numbers; strikes never fall without a teacher pardon.
          const bounds = clampTelemetry(incoming, incoming.totalQuestions || existing?.totalQuestions || 1);
          const pardoned = Boolean(pardonedAtRef.current[compKey]);
          if (pardoned) delete pardonedAtRef.current[compKey];

          const nowBeatMs = incoming.lastHeartbeat || Date.now();
          const reconciledLockedSince = reconcileStudentLockTimestamp(existing, incoming, nowBeatMs);
          if (incoming.status !== 'locked' && existing?.status === 'locked') {
            delete alertedOverdueEpisodeRef.current[compKey];
          }

          next[compKey] = {
            ...existing,
            ...incoming,
            ...bounds,
            lastHeartbeat: nowBeatMs,
            lockedSince: reconciledLockedSince,
            violationsCount: highWaterViolations(existing?.violationsCount, bounds.violationsCount, pardoned),
          };
          changed = true;

          // Retire any row left under a legacy or duplicate key for the same candidate.
          Object.keys(next).forEach((key) => {
            if (key === compKey) return;
            const other = next[key];
            if (!other || other.quizCode !== next[compKey].quizCode) return;
            if (!sameCandidate(other, next[compKey])) return;
            next[compKey] = {
              ...next[compKey],
              violationsCount: highWaterViolations(next[compKey].violationsCount, other.violationsCount, pardoned),
            };
            delete next[key];
            changed = true;
          });
        });

        return changed ? next : prev;
      });
    }, 300);

    return () => clearInterval(timer);
  }, []);

  // ─── 2. Multi-Channel Real-time WebSockets Subscription ────────────────────
  useEffect(() => {
    const codes = monitoredQuizzesRef.current
      .map((q) => (q.quizCode || '').trim().toUpperCase())
      .filter(Boolean);

    if (codes.length === 0) return;

    const handleHeartbeat = (student: ProctorStudentState) => {
      const qCode = (student.quizCode || '').trim().toUpperCase();
      // Older clients send a session hash; normalise every beat to the canonical id so one
      // candidate maps to exactly one dashboard row.
      const canonicalId = getCanonicalProctorStudentId({
        quizCode: qCode,
        studentName: student.studentName,
        candidateNumber: student.candidateNumber,
        studentClass: student.candidateClass,
      });
      const compKey = `${qCode}::${canonicalId}`;

      const proofCheck = verifyAndBindStudentHeartbeatProof(
        boundHeartbeatKeysRef.current,
        compKey,
        student
      );
      if (!proofCheck.accepted) {
        return;
      }

      pendingHeartbeatsRef.current[compKey] = {
        ...student,
        studentId: canonicalId,
        quizCode: qCode,
        quizTitle: student.quizTitle || quizByCodeRef.current[qCode]?.title,
        // Receipt time, not the sender's clock (P1-A).
        lastHeartbeat: Date.now(),
      };

      // Recover activity logs from recentViolations telemetry if missing
      if (student.recentViolations && student.recentViolations.length > 0) {
        setLogEvents((prev) => {
          const existingKeys = new Set(
            prev.map((e) => `${e.quizCode || ''}_${e.studentName}_${e.timestamp}_${e.detail}`)
          );
          const recovered: ProctorLogEvent[] = [];

          student.recentViolations!.forEach((v, idx) => {
            const dedupeKey = `${qCode}_${student.studentName}_${v.timestamp}_${v.detail}`;
            if (!existingKeys.has(dedupeKey)) {
              existingKeys.add(dedupeKey);
              recovered.push({
                id: `recov_${compKey}_${idx}_${v.timestamp || Date.now()}`,
                timestamp: v.timestamp || new Date().toISOString(),
                studentId: canonicalId,
                studentName: student.studentName,
                candidateNumber: student.candidateNumber,
                candidateClass: student.candidateClass,
                quizCode: qCode,
                quizTitle: student.quizTitle || quizByCodeRef.current[qCode]?.title,
                type: (v.type as any) || 'blur',
                detail: v.detail,
                severity:
                  v.type === 'blocked_shortcut' || v.type === 'multi_monitor'
                    ? 'critical'
                    : 'warning',
              });
            }
          });

          if (recovered.length === 0) return prev;
          const merged = [...recovered, ...prev].sort(
            (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
          );
          return merged.slice(0, 1000);
        });
      }
    };

    const handleLogEvent = (event: ProctorLogEvent) => {
      const qCode = (event.quizCode || '').trim().toUpperCase();
      const canonicalId = getCanonicalProctorStudentId({
        quizCode: qCode,
        studentName: event.studentName,
        candidateNumber: event.candidateNumber,
        studentClass: event.candidateClass,
      });
      const compKey = `${qCode}::${canonicalId}`;
      const proofCheck = verifyAndBindStudentHeartbeatProof(
        boundHeartbeatKeysRef.current,
        compKey,
        event
      );
      if (!proofCheck.accepted) {
        return;
      }

      const enriched: ProctorLogEvent = {
        ...event,
        studentId: canonicalId,
        quizCode: qCode,
        quizTitle: event.quizTitle || quizByCodeRef.current[qCode]?.title,
      };
      setLogEvents((prev) => [enriched, ...prev.slice(0, 999)]);

      // Live violation / lock notification & unread badge updates
      const isAlertableViolation =
        enriched.type === 'blur' ||
        enriched.type === 'tab_switch' ||
        enriched.type === 'fullscreen_exit' ||
        enriched.type === 'multi_monitor' ||
        enriched.type === 'shortcut' ||
        enriched.type === 'exceeded_limit' ||
        enriched.type === 'locked' ||
        (enriched.type as string) === 'blocked_shortcut';

      if (isAlertableViolation) {
        const clsKey = (enriched.candidateClass || '').trim() || 'Unassigned';
        setUnreadViolationsByClass((prev) => ({
          ...prev,
          [clsKey]: (prev[clsKey] || 0) + 1,
        }));

        // Stamp lockedSince immediately if a 'locked' event arrives before the next periodic heartbeat
        if (enriched.type === 'locked') {
          setStudents((prev) => {
            const cur = prev[compKey];
            if (!cur || (cur.status === 'locked' && cur.lockedSince)) return prev;
            return {
              ...prev,
              [compKey]: {
                ...cur,
                status: 'locked',
                lockedSince: cur.lockedSince || Date.now(),
                lockReason: enriched.detail || cur.lockReason,
              },
            };
          });
        }

        const scopeCfg = alertScopeRef.current;
        const inSelectedScope = (() => {
          if (scopeCfg.alertScopeMode === 'whole_school' || scopeCfg.selectedKey === '__ALL__') {
            return true;
          }
          if (scopeCfg.sidebarMode === 'class') {
            if (clsKey !== scopeCfg.selectedKey) return false;
            if (scopeCfg.secondaryFilter !== 'all' && qCode !== scopeCfg.secondaryFilter.toUpperCase()) {
              return false;
            }
            return true;
          }
          if (qCode !== scopeCfg.selectedKey.toUpperCase()) return false;
          if (scopeCfg.secondaryFilter !== 'all' && clsKey !== scopeCfg.secondaryFilter) return false;
          return true;
        })();

        if (inSelectedScope) {
          const isLockToast = enriched.type === 'locked' || enriched.severity === 'critical';
          const toastKind: ProctorAlertToast['kind'] = enriched.type === 'locked' ? 'locked' : 'violation';
          const toastId = `toast_${compKey}_${toastKind}_${Date.now()}`;

          setAlertToasts((prev) =>
            upsertProctorAlertToast(prev, {
              id: toastId,
              compositeKey: compKey,
              quizCode: qCode,
              studentId: canonicalId,
              studentName: enriched.studentName,
              candidateNumber: enriched.candidateNumber,
              candidateClass: enriched.candidateClass,
              kind: toastKind,
              severity: isLockToast ? 'critical' : 'warning',
              title:
                enriched.type === 'locked'
                  ? 'Candidate Lock Screen Triggered'
                  : enriched.severity === 'critical'
                    ? 'Critical Security Violation'
                    : 'Candidate Security Notice',
              detail: enriched.detail,
              createdAt: Date.now(),
            })
          );

          if (
            scopeCfg.alertSoundMode === 'all' ||
            (scopeCfg.alertSoundMode === 'critical_only' && isLockToast)
          ) {
            playProctorChime(enriched.type === 'locked' ? 'locked' : 'violation');
          }
        }
      }

      // Student clients persist their own audit events directly; mirror locally without duplicate DB inserts.
      recordProctorAuditEvent(
        {
          id: enriched.id,
          quizCode: qCode,
          studentId: canonicalId,
          studentName: enriched.studentName,
          candidateNumber: enriched.candidateNumber,
          candidateClass: enriched.candidateClass,
          eventType: enriched.type,
          severity: enriched.severity,
          detail: enriched.detail,
          actor: 'student',
          createdAt: enriched.timestamp,
        },
        { localOnly: true }
      );
    };

    subscribeMultiProctorDashboard(codes, {
      onHeartbeat: handleHeartbeat,
      onLogEvent: handleLogEvent,
      onAuthError: () =>
        setCloudAuthWarning(
          'Cloud invigilator session expired or not signed in — live WebSocket telemetry continues, but cloud audit logs, command signing, and result syncing are paused until you sign in again.'
        ),
    });

    // Rebuild the violation/intervention trail after a reload or on a second invigilator's
    // machine (P1-C). Events already on screen are skipped by id.
    void loadProctorAuditEvents(codes, 1000).then((events) => {
      if (!events.length) return;
      setLogEvents((prev) => {
        const seen = new Set(prev.map((entry) => entry.id));
        const restored: ProctorLogEvent[] = events
          .filter((entry) => !seen.has(entry.id))
          .map((entry) => ({
            id: entry.id,
            timestamp: entry.createdAt,
            studentId: entry.studentId,
            studentName: entry.studentName,
            candidateNumber: entry.candidateNumber,
            candidateClass: entry.candidateClass,
            quizCode: entry.quizCode,
            type: entry.eventType as ProctorLogEvent['type'],
            detail: entry.detail,
            severity: entry.severity,
          }));
        if (!restored.length) return prev;
        return [...restored, ...prev]
          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
          .slice(0, 1000);
      });
    });

    // Pre-warm exam_paper_cache for monitored codes before the room opens (and refresh every 4 min
    // before the 5-min TTL expires) so 200 simultaneous student logins never trigger cold rebuilds.
    const warmTimeouts: ReturnType<typeof setTimeout>[] = [];
    const warmMonitoredPapers = () => {
      if (!isSupabaseConfigured()) return;
      codes.slice(0, 20).forEach((code, idx) => {
        const t = setTimeout(() => {
          void Promise.resolve(
            (supabase as any).rpc?.('get_student_exam_paper', { p_code: code })
          ).catch(() => { });
        }, idx * 80);
        warmTimeouts.push(t);
      });
    };
    warmMonitoredPapers();
    const warmTimer = setInterval(warmMonitoredPapers, 240_000);

    return () => {
      clearInterval(warmTimer);
      warmTimeouts.forEach(clearTimeout);
      destroyProctorSession();
    };
  }, [monitoredCodesKey]);

  // Periodic offline sweep (mark offline if heartbeat missing for >45s)
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setStudents((prev) => {
        let changed = false;
        const next = { ...prev };
        Object.keys(next).forEach((id) => {
          const s = next[id];
          if (s.status !== 'submitted' && s.status !== 'offline' && now - s.lastHeartbeat > 45000) {
            next[id] = { ...s, status: 'offline' };
            changed = true;
          }
        });
        return changed ? next : prev;
      });
    }, 10000);

    return () => clearInterval(interval);
  }, []);

  // ─── 2A. Live Lock-Screen Wait Ticker & >1 Minute Escalation Sweep ─────────
  const hasAnyLockedCandidate = useMemo(
    () => Object.values(students).some((s) => s.status === 'locked'),
    [students]
  );

  useEffect(() => {
    if (!hasAnyLockedCandidate) return;
    setNowMs(Date.now());
    const timer = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [hasAnyLockedCandidate]);

  // Clear unread violation counter when opening a class or toggling the log drawer
  useEffect(() => {
    if (sidebarMode === 'class' && selectedKey !== '__ALL__') {
      setUnreadViolationsByClass((prev) => {
        if (!prev[selectedKey]) return prev;
        const next = { ...prev };
        delete next[selectedKey];
        return next;
      });
    } else if (showLogDrawer) {
      setUnreadViolationsByClass({});
    }
  }, [sidebarMode, selectedKey, showLogDrawer]);

  // Auto-dismiss non-critical warning toasts after 8 seconds
  useEffect(() => {
    const warnings = alertToasts.filter((t) => t.severity === 'warning');
    if (warnings.length === 0) return;
    const timer = setInterval(() => {
      const cutoff = Date.now() - 8000;
      setAlertToasts((prev) => prev.filter((t) => t.severity === 'critical' || t.createdAt > cutoff));
    }, 1000);
    return () => clearInterval(timer);
  }, [alertToasts]);

  // ─── 2B. Centralized School Roster Directory by Class ───────────────────────
  const rosterByClass = useMemo(() => {
    const map: Record<string, RosterStudent[]> = {};
    const byNormalizedKey: Record<string, string> = {};
    schoolClasses.forEach((sc) => {
      const trimmed = sc.trim();
      if (trimmed) {
        byNormalizedKey[normalizeTargetClassKey(trimmed)] = trimmed;
      }
    });

    schoolRoster.forEach((r) => {
      const rawCls = (r.class || '').trim();
      if (!rawCls) return;
      const cls = byNormalizedKey[normalizeTargetClassKey(rawCls)] || rawCls;
      if (!map[cls]) map[cls] = [];
      map[cls].push(r);
    });
    return map;
  }, [schoolRoster, schoolClasses]);

  // ─── 3. Candidate Aggregations & Sidebar Navigation Models ─────────────────
  const allStudentList = useMemo(() => Object.values(students), [students]);

  // Filter students by monitored quizzes
  const activeMonitoredStudents = useMemo(() => {
    const allowed = new Set(
      monitoredQuizzes.map((q) => (q.quizCode || '').trim().toUpperCase())
    );
    return allStudentList.filter((s) => s.quizCode && allowed.has(s.quizCode.toUpperCase()));
  }, [allStudentList, monitoredQuizzes]);

  // Distinct Classes (Scoped to Exam Target Classes in focus mode, or All School Classes + Live Discovered)
  const sidebarClasses = useMemo(() => {
    let list = resolveProctorSidebarClasses({
      schoolClasses,
      monitoredTargetClasses: monitoredQuizzes.map((q) => q.targetClass),
      liveStudentClasses: activeMonitoredStudents.map((s) => getStudentClass(s)),
      scope,
    });

    if (hideEmptyClasses) {
      list = list.filter((cls) =>
        activeMonitoredStudents.some((s) => getStudentClass(s) === cls)
      );
    }
    return list;
  }, [schoolClasses, monitoredQuizzes, activeMonitoredStudents, hideEmptyClasses, scope]);

  // Per-Class metrics with Roster Reconciliation
  const classStats = useMemo(() => {
    const map: Record<
      string,
      { total: number; locked: number; warnings: number; exceeded: number; rosterTotal: number; missingCount: number }
    > = {};
    sidebarClasses.forEach((c) => {
      const rTotal = rosterByClass[c]?.length || 0;
      map[c] = { total: 0, locked: 0, warnings: 0, exceeded: 0, rosterTotal: rTotal, missingCount: 0 };
    });

    activeMonitoredStudents.forEach((s) => {
      const cls = getStudentClass(s);
      if (!map[cls]) {
        const rTotal = rosterByClass[cls]?.length || 0;
        map[cls] = { total: 0, locked: 0, warnings: 0, exceeded: 0, rosterTotal: rTotal, missingCount: 0 };
      }
      map[cls].total++;
      if (s.status === 'locked') map[cls].locked++;
      if (isStudentExceeded(s)) map[cls].exceeded++;
      if (s.status === 'warning' || s.multiMonitorDetected || s.violationsCount > 0) {
        map[cls].warnings++;
      }
    });

    // Calculate missing students count per class
    Object.keys(map).forEach((cls) => {
      const classRoster = rosterByClass[cls] || [];
      if (classRoster.length === 0) {
        map[cls].missingCount = 0;
        return;
      }
      const connected = activeMonitoredStudents.filter((s) => getStudentClass(s) === cls);
      const connectedNames = new Set(connected.map((s) => s.studentName.trim().toLowerCase()));
      const connectedSeats = new Set(
        connected.map((s) => (s.candidateNumber || '').trim().toLowerCase()).filter(Boolean)
      );
      const missing = classRoster.filter((r) => {
        const nameMatch = connectedNames.has(r.name.trim().toLowerCase());
        const seatMatch = r.candidateNumber && connectedSeats.has(r.candidateNumber.trim().toLowerCase());
        return !nameMatch && !seatMatch;
      });
      map[cls].missingCount = missing.length;
    });

    return map;
  }, [sidebarClasses, activeMonitoredStudents, isStudentExceeded, rosterByClass]);

  // Per-Exam metrics
  const examStats = useMemo(() => {
    const map: Record<
      string,
      { total: number; locked: number; warnings: number; exceeded: number }
    > = {};
    monitoredQuizzes.forEach((q) => {
      const code = (q.quizCode || '').trim().toUpperCase();
      map[code] = { total: 0, locked: 0, warnings: 0, exceeded: 0 };
    });

    activeMonitoredStudents.forEach((s) => {
      const code = (s.quizCode || '').trim().toUpperCase();
      if (!map[code]) {
        map[code] = { total: 0, locked: 0, warnings: 0, exceeded: 0 };
      }
      map[code].total++;
      if (s.status === 'locked') map[code].locked++;
      if (isStudentExceeded(s)) map[code].exceeded++;
      if (s.status === 'warning' || s.multiMonitorDetected || s.violationsCount > 0) {
        map[code].warnings++;
      }
    });

    return map;
  }, [monitoredQuizzes, activeMonitoredStudents, isStudentExceeded]);

  // ─── 4. Scope Students (Sidebar Selection + Secondary Dropdown) ───────────
  const scopeStudents = useMemo(() => {
    return activeMonitoredStudents.filter((s) => {
      if (sidebarMode === 'class') {
        if (selectedKey !== '__ALL__' && getStudentClass(s) !== selectedKey) {
          return false;
        }
        if (secondaryFilter !== 'all' && (s.quizCode || '').toUpperCase() !== secondaryFilter.toUpperCase()) {
          return false;
        }
      } else {
        if (selectedKey !== '__ALL__' && (s.quizCode || '').toUpperCase() !== selectedKey.toUpperCase()) {
          return false;
        }
        if (secondaryFilter !== 'all' && getStudentClass(s) !== secondaryFilter) {
          return false;
        }
      }
      return true;
    });
  }, [activeMonitoredStudents, sidebarMode, selectedKey, secondaryFilter]);

  // Friendly Scope Label for bulk controls
  const scopeLabel = useMemo(() => {
    if (selectedKey === '__ALL__') {
      return isMultiExam ? 'All Candidates' : singleFocusQuiz?.title || 'All Candidates';
    }
    if (sidebarMode === 'class') {
      return `Class ${selectedKey}`;
    }
    const q = quizByCode[selectedKey.toUpperCase()];
    return q ? `${q.quizCode} (${q.title})` : `Exam ${selectedKey}`;
  }, [selectedKey, sidebarMode, isMultiExam, singleFocusQuiz, quizByCode]);

  // Scoped KPIs
  const scopedStats = useMemo(() => {
    let active = 0;
    let locked = 0;
    let warnings = 0;
    let multiMonitor = 0;
    let submitted = 0;
    let offline = 0;
    let exceeded = 0;

    scopeStudents.forEach((s) => {
      if (isStudentExceeded(s)) exceeded++;
      if (s.status === 'locked') locked++;
      else if (s.status === 'warning') warnings++;
      else if (s.status === 'active') active++;
      else if (s.status === 'submitted') submitted++;
      else if (s.status === 'offline') offline++;

      if (s.multiMonitorDetected) multiMonitor++;
    });

    return {
      total: scopeStudents.length,
      active,
      locked,
      warnings,
      multiMonitor,
      submitted,
      offline,
      exceeded,
    };
  }, [scopeStudents, isStudentExceeded]);

  // ─── 4B. Reconciled Missing Candidates in Current Scope ───────────────────────
  const missingStudents = useMemo(() => {
    let expectedRoster: RosterStudent[] = [];

    const activeOrTargetClassKeys = new Set<string>(
      activeMonitoredStudents
        .map((s) => normalizeTargetClassKey(getStudentClass(s)))
        .filter((k) => k && k !== 'unassigned')
    );
    monitoredQuizzes.forEach((q) => {
      if (q.targetClass) {
        q.targetClass
          .split(',')
          .map((c) => normalizeTargetClassKey(c))
          .filter((k) => k && k !== 'all')
          .forEach((k) => activeOrTargetClassKeys.add(k));
      }
    });

    if (sidebarMode === 'class') {
      if (selectedKey === '__ALL__') {
        sidebarClasses.forEach((cls) => {
          if (activeOrTargetClassKeys.has(normalizeTargetClassKey(cls)) && rosterByClass[cls]) {
            expectedRoster.push(...rosterByClass[cls]);
          }
        });
      } else {
        expectedRoster = rosterByClass[selectedKey] || [];
      }
    } else {
      if (secondaryFilter !== 'all') {
        expectedRoster = rosterByClass[secondaryFilter] || [];
      } else {
        sidebarClasses.forEach((cls) => {
          if (activeOrTargetClassKeys.has(normalizeTargetClassKey(cls)) && rosterByClass[cls]) {
            expectedRoster.push(...rosterByClass[cls]);
          }
        });
      }
    }

    if (expectedRoster.length === 0) return [];

    const connectedNames = new Set(scopeStudents.map((s) => s.studentName.trim().toLowerCase()));
    const connectedSeats = new Set(
      scopeStudents.map((s) => (s.candidateNumber || '').trim().toLowerCase()).filter(Boolean)
    );

    const missing = expectedRoster.filter((r) => {
      const nameMatch = connectedNames.has(r.name.trim().toLowerCase());
      const seatMatch = r.candidateNumber && connectedSeats.has(r.candidateNumber.trim().toLowerCase());
      return !nameMatch && !seatMatch;
    });

    if (deferredSearchQuery.trim()) {
      const q = deferredSearchQuery.toLowerCase();
      return missing.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.candidateNumber || '').toLowerCase().includes(q) ||
          (r.class || '').toLowerCase().includes(q)
      );
    }

    return missing.sort((a, b) => {
      const classComp = (a.class || '').localeCompare(b.class || '');
      if (classComp !== 0) return classComp;
      const numA = parseInt((a.candidateNumber || '').replace(/\D/g, ''), 10);
      const numB = parseInt((b.candidateNumber || '').replace(/\D/g, ''), 10);
      if (!isNaN(numA) && !isNaN(numB) && numA !== numB) {
        return numA - numB;
      }
      return a.name.localeCompare(b.name);
    });
  }, [
    sidebarMode,
    selectedKey,
    secondaryFilter,
    sidebarClasses,
    rosterByClass,
    scopeStudents,
    activeMonitoredStudents,
    monitoredQuizzes,
    deferredSearchQuery,
  ]);

  // ─── 5. Filtered & Sorted Student View ──────────────────────────────────────
  const filteredStudents = useMemo(() => {
    const list = scopeStudents.filter((s) => {
      if (activeFilter === 'exceeded' && !isStudentExceeded(s)) return false;
      if (activeFilter === 'locked' && s.status !== 'locked') return false;
      if (
        activeFilter === 'warnings' &&
        s.status !== 'warning' &&
        !s.multiMonitorDetected &&
        s.violationsCount === 0
      ) {
        return false;
      }
      if (activeFilter === 'active' && s.status !== 'active') return false;
      if (activeFilter === 'submitted' && s.status !== 'submitted') return false;

      if (deferredSearchQuery.trim()) {
        const q = deferredSearchQuery.toLowerCase();
        const matchName = s.studentName.toLowerCase().includes(q);
        const matchNum = (s.candidateNumber || '').toLowerCase().includes(q);
        const matchClass = (s.candidateClass || '').toLowerCase().includes(q);
        const matchCode = (s.quizCode || '').toLowerCase().includes(q);
        if (!matchName && !matchNum && !matchClass && !matchCode) return false;
      }

      return true;
    });

    return [...list].sort((a, b) => {
      if (sortBy === 'priority') {
        const rA = getPriorityTriageRank(a, nowMs, isStudentExceeded(a));
        const rB = getPriorityTriageRank(b, nowMs, isStudentExceeded(b));
        if (rA !== rB) return rA - rB;
        const lockA = getLockedDurationMs(a, nowMs);
        const lockB = getLockedDurationMs(b, nowMs);
        if (lockA !== lockB) return lockB - lockA;
        return a.studentName.localeCompare(b.studentName);
      }
      if (sortBy === 'class_seat') {
        const classComp = (a.candidateClass || '').localeCompare(b.candidateClass || '');
        if (classComp !== 0) return classComp;
        const numA = parseInt((a.candidateNumber || '').replace(/\D/g, ''), 10);
        const numB = parseInt((b.candidateNumber || '').replace(/\D/g, ''), 10);
        if (!isNaN(numA) && !isNaN(numB) && numA !== numB) {
          return numA - numB;
        }
        const seatComp = (a.candidateNumber || '').localeCompare(b.candidateNumber || '');
        if (seatComp !== 0) return seatComp;
        return a.studentName.localeCompare(b.studentName);
      }
      if (sortBy === 'status') {
        const priority: Record<StudentExamStatus, number> = {
          locked: 1,
          warning: 2,
          active: 3,
          offline: 4,
          submitted: 5,
        };
        const pDiff = (priority[a.status] || 99) - (priority[b.status] || 99);
        if (pDiff !== 0) return pDiff;
        return a.studentName.localeCompare(b.studentName);
      }
      if (sortBy === 'name') {
        return a.studentName.localeCompare(b.studentName);
      }
      if (sortBy === 'progress') {
        const pctA = a.totalQuestions > 0 ? a.answeredCount / a.totalQuestions : 0;
        const pctB = b.totalQuestions > 0 ? b.answeredCount / b.totalQuestions : 0;
        return pctB - pctA;
      }
      if (sortBy === 'time_left') {
        return a.timeLeftSeconds - b.timeLeftSeconds;
      }
      if (sortBy === 'violations') {
        return b.violationsCount - a.violationsCount;
      }
      return 0;
    });
  }, [scopeStudents, activeFilter, deferredSearchQuery, sortBy, isStudentExceeded, nowMs]);

  // Trigger > 1 minute overdue lock escalation alerts & chime
  useEffect(() => {
    if (!hasAnyLockedCandidate) return;
    const overdueList = findOverdueLockedStudents(
      activeMonitoredStudents,
      alertedOverdueEpisodeRef.current,
      nowMs,
      OVERDUE_LOCK_THRESHOLD_MS
    );
    if (overdueList.length === 0) return;

    const scopeCfg = alertScopeRef.current;
    let shouldPlayUrgentChime = false;

    overdueList.forEach((s) => {
      const qCode = (s.quizCode || '').trim().toUpperCase();
      const compKey = `${qCode}::${s.studentId}`;
      alertedOverdueEpisodeRef.current[compKey] = s.lockedSince!;

      const clsKey = getStudentClass(s);
      const inScope =
        scopeCfg.alertScopeMode === 'whole_school' ||
        scopeCfg.selectedKey === '__ALL__' ||
        (scopeCfg.sidebarMode === 'class'
          ? clsKey === scopeCfg.selectedKey &&
          (scopeCfg.secondaryFilter === 'all' || qCode === scopeCfg.secondaryFilter.toUpperCase())
          : qCode === scopeCfg.selectedKey.toUpperCase() &&
          (scopeCfg.secondaryFilter === 'all' || clsKey === scopeCfg.secondaryFilter));

      const waitStr = formatLockedDuration(getLockedDurationMs(s, nowMs));
      const detailMsg = `Candidate stayed on violation lock screen for ${waitStr} (> 1 min). Verification / unlock needed.`;

      if (inScope) {
        shouldPlayUrgentChime = true;
        setAlertToasts((prev) =>
          upsertProctorAlertToast(prev, {
            id: `toast_overdue_${compKey}_${s.lockedSince}`,
            compositeKey: compKey,
            quizCode: qCode,
            studentId: s.studentId,
            studentName: s.studentName,
            candidateNumber: s.candidateNumber,
            candidateClass: s.candidateClass,
            kind: 'locked_overdue',
            severity: 'critical',
            title: `🚨 Stuck on Violation Screen (${waitStr})`,
            detail: s.lockReason || detailMsg,
            createdAt: nowMs,
            lockedDurationMs: getLockedDurationMs(s, nowMs),
          })
        );
      }

      const evtId = `evt-overdue-${compKey}-${s.lockedSince}`;
      const evtIso = new Date(nowMs).toISOString();
      setLogEvents((prev) => {
        if (prev.some((e) => e.id === evtId)) return prev;
        return [
          {
            id: evtId,
            timestamp: evtIso,
            studentId: s.studentId,
            studentName: s.studentName,
            candidateNumber: s.candidateNumber,
            candidateClass: s.candidateClass,
            quizCode: qCode,
            quizTitle: s.quizTitle || quizByCode[qCode]?.title,
            type: 'locked_overdue' as const,
            detail: detailMsg,
            severity: 'critical' as const,
          },
          ...prev.slice(0, 999),
        ];
      });

      recordProctorAuditEvent({
        id: evtId,
        quizCode: qCode,
        studentId: s.studentId,
        studentName: s.studentName,
        candidateNumber: s.candidateNumber,
        candidateClass: s.candidateClass,
        eventType: 'locked_overdue',
        severity: 'critical',
        detail: detailMsg,
        actor: 'invigilator',
        createdAt: evtIso,
      });
    });

    if (shouldPlayUrgentChime && scopeCfg.alertSoundMode !== 'muted') {
      playProctorChime('locked_overdue');
    }
  }, [hasAnyLockedCandidate, activeMonitoredStudents, nowMs, quizByCode]);

  // Scoped locked candidates waiting >= 1 minute (sticky triage banner)
  const overdueLockedInScope = useMemo(() => {
    return scopeStudents
      .filter((s) => s.status === 'locked' && getLockedDurationMs(s, nowMs) >= OVERDUE_LOCK_THRESHOLD_MS)
      .sort((a, b) => (a.lockedSince || nowMs) - (b.lockedSince || nowMs));
  }, [scopeStudents, nowMs]);

  // Filtered Activity Logs for Class / Exam / School Log Drawer
  const drawerLogEvents = useMemo(() => {
    const scopeClass =
      logScopeMode === 'current_scope'
        ? sidebarMode === 'class' && selectedKey !== '__ALL__'
          ? selectedKey
          : sidebarMode === 'exam' && secondaryFilter !== 'all'
            ? secondaryFilter
            : undefined
        : undefined;
    const scopeQuiz =
      logScopeMode === 'current_scope'
        ? sidebarMode === 'exam' && selectedKey !== '__ALL__'
          ? selectedKey
          : sidebarMode === 'class' && secondaryFilter !== 'all'
            ? secondaryFilter
            : scope === 'focus' && singleFocusQuiz
              ? singleFocusQuiz.quizCode
              : undefined
        : undefined;

    return filterProctorLogs(logEvents, {
      quizCode: scopeQuiz,
      className: scopeClass,
      category: logCategory,
      search: logSearch,
    });
  }, [
    logEvents,
    logScopeMode,
    sidebarMode,
    selectedKey,
    secondaryFilter,
    scope,
    singleFocusQuiz,
    logCategory,
    logSearch,
  ]);

  // Individual Candidate Timeline Events
  const selectedStudentLogTarget = selectedStudentLogKey ? students[selectedStudentLogKey] : undefined;
  const selectedStudentLogs = useMemo(() => {
    if (!selectedStudentLogTarget) return [];
    return filterProctorLogs(logEvents, {
      quizCode: selectedStudentLogTarget.quizCode,
      studentId: selectedStudentLogTarget.studentId,
      studentName: selectedStudentLogTarget.studentName,
      candidateNumber: selectedStudentLogTarget.candidateNumber,
    });
  }, [selectedStudentLogTarget, logEvents]);

  // ─── 6. Command Handlers (Individual & Scoped Bulk) ─────────────────────────
  const handleRemoteUnlock = useCallback((compositeKey: string) => {
    const s = students[compositeKey];
    if (!s || !s.quizCode) return;

    delete pendingHeartbeatsRef.current[compositeKey];
    delete boundHeartbeatKeysRef.current[compositeKey];
    delete alertedOverdueEpisodeRef.current[compositeKey];
    if (s.draftKey) {
      delete boundHeartbeatKeysRef.current[s.draftKey];
    }
    sendProctorCommand(s.quizCode, s.studentId, 'unlock');
    setAlertToasts((prev) =>
      prev.filter((t) => !(t.compositeKey === compositeKey && (t.kind === 'locked' || t.kind === 'locked_overdue')))
    );
    setStudents((prev) => {
      if (!prev[compositeKey]) return prev;
      return {
        ...prev,
        [compositeKey]: {
          ...prev[compositeKey],
          status: 'active',
          lockReason: undefined,
          lockedSince: undefined,
        },
      };
    });
    setLogEvents((prev) => [
      {
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        timestamp: new Date().toISOString(),
        studentId: s.studentId,
        studentName: s.studentName,
        candidateNumber: s.candidateNumber,
        candidateClass: s.candidateClass,
        quizCode: s.quizCode,
        type: 'unlocked',
        detail: `Remotely unlocked by invigilator`,
        severity: 'info',
      },
      ...prev,
    ]);
    recordProctorAuditEvent({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      quizCode: s.quizCode,
      studentId: s.studentId,
      studentName: s.studentName,
      candidateNumber: s.candidateNumber,
      candidateClass: s.candidateClass,
      eventType: 'unlocked',
      severity: 'info',
      detail: 'Remotely unlocked by invigilator',
      actor: 'invigilator',
      createdAt: new Date().toISOString(),
    });
  }, [students]);

  const handleUnlockAndCompensate = useCallback((compositeKey: string, minutes: number) => {
    const s = students[compositeKey];
    if (!s || !s.quizCode) return;
    const safeMinutes = Math.max(1, Math.min(15, Math.round(minutes)));

    delete pendingHeartbeatsRef.current[compositeKey];
    delete boundHeartbeatKeysRef.current[compositeKey];
    delete alertedOverdueEpisodeRef.current[compositeKey];
    if (s.draftKey) {
      delete boundHeartbeatKeysRef.current[s.draftKey];
    }

    sendProctorCommand(s.quizCode, s.studentId, 'unlock');
    sendProctorCommand(s.quizCode, s.studentId, 'add_time', { minutes: safeMinutes });

    setAlertToasts((prev) => prev.filter((t) => t.compositeKey !== compositeKey));
    setStudents((prev) => {
      if (!prev[compositeKey]) return prev;
      return {
        ...prev,
        [compositeKey]: {
          ...prev[compositeKey],
          status: 'active',
          lockReason: undefined,
          lockedSince: undefined,
          timeLeftSeconds: prev[compositeKey].timeLeftSeconds + safeMinutes * 60,
        },
      };
    });

    const nowIso = new Date().toISOString();
    const detailText = `Unlocked & compensated +${safeMinutes}m lock wait time by invigilator`;
    setLogEvents((prev) => [
      {
        id: `evt-unlock-comp-${Date.now()}`,
        timestamp: nowIso,
        studentId: s.studentId,
        studentName: s.studentName,
        candidateNumber: s.candidateNumber,
        candidateClass: s.candidateClass,
        quizCode: s.quizCode,
        type: 'unlocked',
        detail: detailText,
        severity: 'info',
      },
      ...prev,
    ]);
    recordProctorAuditEvent({
      id: `audit-unlock-comp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      quizCode: s.quizCode,
      studentId: s.studentId,
      studentName: s.studentName,
      candidateNumber: s.candidateNumber,
      candidateClass: s.candidateClass,
      eventType: 'unlocked',
      severity: 'info',
      detail: detailText,
      actor: 'invigilator',
      createdAt: nowIso,
    });
  }, [students]);

  const handleAddTime = useCallback((compositeKey: string, minutes: number) => {
    const s = students[compositeKey];
    if (!s || !s.quizCode) return;

    delete pendingHeartbeatsRef.current[compositeKey];
    sendProctorCommand(s.quizCode, s.studentId, 'add_time', { minutes });
    setStudents((prev) => {
      if (!prev[compositeKey]) return prev;
      return {
        ...prev,
        [compositeKey]: {
          ...prev[compositeKey],
          timeLeftSeconds: prev[compositeKey].timeLeftSeconds + minutes * 60,
        },
      };
    });
    setLogEvents((prev) => [
      {
        id: `evt-${Date.now()}`,
        timestamp: new Date().toISOString(),
        studentId: s.studentId,
        studentName: s.studentName,
        candidateNumber: s.candidateNumber,
        candidateClass: s.candidateClass,
        quizCode: s.quizCode,
        type: 'time_extended',
        detail: `Added +${minutes} minutes to exam clock`,
        severity: 'info',
      },
      ...prev,
    ]);
    recordProctorAuditEvent({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      quizCode: s.quizCode,
      studentId: s.studentId,
      studentName: s.studentName,
      candidateNumber: s.candidateNumber,
      candidateClass: s.candidateClass,
      eventType: 'time_extended',
      severity: 'info',
      detail: `Added +${minutes} minutes to exam clock`,
      actor: 'invigilator',
      createdAt: new Date().toISOString(),
    });
  }, [students]);

  const handleForceSubmit = useCallback((compositeKey: string) => {
    const s = students[compositeKey];
    if (!s || !s.quizCode) return;

    if (
      !window.confirm(
        `Are you sure you want to force submit ${s.studentName}'s examination? This will finalize their attempt immediately.`
      )
    ) {
      return;
    }

    delete pendingHeartbeatsRef.current[compositeKey];
    delete alertedOverdueEpisodeRef.current[compositeKey];
    sendProctorCommand(s.quizCode, s.studentId, 'force_submit');
    setAlertToasts((prev) => prev.filter((t) => t.compositeKey !== compositeKey));
    setStudents((prev) => {
      if (!prev[compositeKey]) return prev;
      return {
        ...prev,
        [compositeKey]: {
          ...prev[compositeKey],
          status: 'submitted',
          lockedSince: undefined,
        },
      };
    });
    setLogEvents((prev) => [
      {
        id: `evt-${Date.now()}`,
        timestamp: new Date().toISOString(),
        studentId: s.studentId,
        studentName: s.studentName,
        candidateNumber: s.candidateNumber,
        candidateClass: s.candidateClass,
        quizCode: s.quizCode,
        type: 'submitted',
        detail: `Exam submission forced by invigilator`,
        severity: 'critical',
      },
      ...prev,
    ]);
    recordProctorAuditEvent({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      quizCode: s.quizCode,
      studentId: s.studentId,
      studentName: s.studentName,
      candidateNumber: s.candidateNumber,
      candidateClass: s.candidateClass,
      eventType: 'submitted',
      severity: 'critical',
      detail: 'Exam submission forced by invigilator',
      actor: 'invigilator',
      createdAt: new Date().toISOString(),
    });
  }, [students]);

  const handlePardon = useCallback((compositeKey: string) => {
    const s = students[compositeKey];
    if (!s || !s.quizCode || s.autoSubmittedBySecurity) return;

    delete pendingHeartbeatsRef.current[compositeKey];
    delete alertedOverdueEpisodeRef.current[compositeKey];
    sendProctorCommand(s.quizCode, s.studentId, 'pardon');
    // Lets the strike high-water mark fall once for this candidate.
    pardonedAtRef.current[compositeKey] = Date.now();
    setAlertToasts((prev) => prev.filter((t) => t.compositeKey !== compositeKey));
    setStudents((prev) => {
      if (!prev[compositeKey]) return prev;
      return {
        ...prev,
        [compositeKey]: {
          ...prev[compositeKey],
          status: 'active',
          strikeCount: 0,
          currentTierName: undefined,
          currentTierAction: undefined,
          exceededMaxViolations: false,
          lockReason: undefined,
          lockedSince: undefined,
          lastViolation: undefined,
        },
      };
    });
    setLogEvents((prev) => [
      {
        id: `evt-${Date.now()}`,
        timestamp: new Date().toISOString(),
        studentId: s.studentId,
        studentName: s.studentName,
        candidateNumber: s.candidateNumber,
        candidateClass: s.candidateClass,
        quizCode: s.quizCode,
        type: 'pardon',
        detail: `Security strikes reset to 0 by invigilator (prior time penalties retained)`,
        severity: 'info',
      },
      ...prev,
    ]);
    recordProctorAuditEvent({
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      quizCode: s.quizCode,
      studentId: s.studentId,
      studentName: s.studentName,
      candidateNumber: s.candidateNumber,
      candidateClass: s.candidateClass,
      eventType: 'pardon',
      severity: 'info',
      detail: 'Security strike counter reset to 0 by invigilator (prior time penalties retained)',
      actor: 'invigilator',
      createdAt: new Date().toISOString(),
    });
  }, [students]);

  const handleLocateStudent = useCallback((compositeKey: string) => {
    setActiveFilter('all');
    setSearchQuery('');
    setFocusedStudentKey(compositeKey);
    setTimeout(() => {
      const el = cardRefs.current[compositeKey];
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 80);
    setTimeout(() => {
      setFocusedStudentKey((cur) => (cur === compositeKey ? null : cur));
    }, 3500);
  }, []);

  const handleSendDirectNotice = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!directNoticeTargetKey || !directNoticeText.trim()) return;
    const s = students[directNoticeTargetKey];
    if (!s || !s.quizCode) return;

    const msg = directNoticeText.trim();
    sendProctorCommand(s.quizCode, s.studentId, 'announcement', { message: msg });
    const nowIso = new Date().toISOString();
    setLogEvents((prev) => [
      {
        id: `evt-direct-${Date.now()}`,
        timestamp: nowIso,
        studentId: s.studentId,
        studentName: s.studentName,
        candidateNumber: s.candidateNumber,
        candidateClass: s.candidateClass,
        quizCode: s.quizCode,
        type: 'announcement',
        detail: `Direct notice sent to candidate: "${msg}"`,
        severity: 'info',
      },
      ...prev,
    ]);
    recordProctorAuditEvent({
      id: `audit-direct-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      quizCode: s.quizCode,
      studentId: s.studentId,
      studentName: s.studentName,
      candidateNumber: s.candidateNumber,
      candidateClass: s.candidateClass,
      eventType: 'announcement',
      severity: 'info',
      detail: `Direct notice sent to candidate: "${msg}"`,
      actor: 'invigilator',
      createdAt: nowIso,
    });

    setDirectNoticeSent(true);
    setTimeout(() => {
      setDirectNoticeSent(false);
      setDirectNoticeTargetKey(null);
      setDirectNoticeText('');
    }, 1000);
  }, [directNoticeTargetKey, directNoticeText, students]);

  // Scoped Bulk: Unlock
  const handleScopedUnlock = useCallback(() => {
    const lockedTargets = scopeStudents.filter((s) => s.status === 'locked' && s.quizCode);
    if (lockedTargets.length === 0) return;

    if (selectedKey === '__ALL__' && isMultiExam) {
      if (
        !window.confirm(
          `Unlock all ${lockedTargets.length} locked candidate(s) across ${monitoredQuizzes.length} exams?`
        )
      ) {
        return;
      }
    }

    const targetClass =
      sidebarMode === 'class' && selectedKey !== '__ALL__'
        ? selectedKey
        : sidebarMode === 'exam' && secondaryFilter !== 'all'
          ? secondaryFilter
          : undefined;

    const targetQuizzes = Array.from(
      new Set(lockedTargets.map((t) => t.quizCode!).filter(Boolean))
    );
    const codesToSend =
      targetQuizzes.length > 0 ? targetQuizzes : monitoredQuizzes.map((q) => q.quizCode);

    codesToSend.forEach((code) => {
      sendProctorCommand(code, 'ALL', 'unlock', { targetClass });
    });

    const lockedKeys = new Set(
      lockedTargets.map((t) => `${t.quizCode!.toUpperCase()}::${t.studentId}`)
    );
    lockedKeys.forEach((k) => {
      delete boundHeartbeatKeysRef.current[k];
      delete alertedOverdueEpisodeRef.current[k];
    });
    lockedTargets.forEach((t) => {
      if (t.draftKey) {
        delete boundHeartbeatKeysRef.current[t.draftKey];
      }
    });
    setAlertToasts((prev) =>
      prev.filter((t) => !(lockedKeys.has(t.compositeKey) && (t.kind === 'locked' || t.kind === 'locked_overdue')))
    );
    setStudents((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((k) => {
        if (lockedKeys.has(k)) {
          next[k] = { ...next[k], status: 'active', lockReason: undefined, lockedSince: undefined };
        }
      });
      return next;
    });

    const createdAt = new Date().toISOString();
    const detail = `Unlocked ${lockedTargets.length} locked candidate(s)`;
    setLogEvents((prev) => [
      {
        id: `evt-${Date.now()}`,
        timestamp: createdAt,
        studentName: scopeLabel,
        candidateClass: targetClass,
        quizCode: codesToSend.length === 1 ? codesToSend[0] : undefined,
        type: 'unlocked',
        detail,
        severity: 'info',
      },
      ...prev,
    ]);
    codesToSend.forEach((code) => {
      recordProctorAuditEvent({
        id: `audit-bulk-unlock-${code}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        quizCode: code,
        studentId: targetClass ? `ALL::${targetClass}` : 'ALL',
        studentName: scopeLabel,
        candidateClass: targetClass,
        eventType: 'unlocked',
        severity: 'info',
        detail,
        actor: 'invigilator',
        createdAt,
      });
    });
  }, [scopeStudents, selectedKey, isMultiExam, monitoredQuizzes.length, sidebarMode, secondaryFilter, scopeLabel]);

  // Scoped Bulk: Add Time
  const handleScopedAddTime = useCallback(
    (minutes: number) => {
      const activeTargets = scopeStudents.filter((s) => s.status !== 'submitted' && s.quizCode);
      if (activeTargets.length === 0) return;

      if (selectedKey === '__ALL__' && isMultiExam) {
        if (
          !window.confirm(
            `Grant +${minutes} minutes extra time to all ${activeTargets.length} active candidate(s) across ${monitoredQuizzes.length} exams?`
          )
        ) {
          return;
        }
      }

      const targetClass =
        sidebarMode === 'class' && selectedKey !== '__ALL__'
          ? selectedKey
          : sidebarMode === 'exam' && secondaryFilter !== 'all'
            ? secondaryFilter
            : undefined;

      const targetQuizzes = Array.from(
        new Set(activeTargets.map((t) => t.quizCode!).filter(Boolean))
      );
      const codesToSend =
        targetQuizzes.length > 0 ? targetQuizzes : monitoredQuizzes.map((q) => q.quizCode);

      codesToSend.forEach((code) => {
        sendProctorCommand(code, 'ALL', 'add_time', { minutes, targetClass });
      });

      const targetKeys = new Set(
        activeTargets.map((t) => `${t.quizCode!.toUpperCase()}::${t.studentId}`)
      );
      setStudents((prev) => {
        const next = { ...prev };
        Object.keys(next).forEach((k) => {
          if (targetKeys.has(k)) {
            next[k] = {
              ...next[k],
              timeLeftSeconds: next[k].timeLeftSeconds + minutes * 60,
            };
          }
        });
        return next;
      });

      const createdAt = new Date().toISOString();
      const detail = `Added +${minutes}m extra time to ${activeTargets.length} candidate(s)`;
      setLogEvents((prev) => [
        {
          id: `evt-${Date.now()}`,
          timestamp: createdAt,
          studentName: scopeLabel,
          type: 'time_extended',
          detail,
          severity: 'info',
        },
        ...prev,
      ]);
      codesToSend.forEach((code) => {
        recordProctorAuditEvent({
          id: `audit-bulk-time-${code}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          quizCode: code,
          studentId: targetClass ? `ALL::${targetClass}` : 'ALL',
          studentName: scopeLabel,
          candidateClass: targetClass,
          eventType: 'time_extended',
          severity: 'info',
          detail,
          actor: 'invigilator',
          createdAt,
        });
      });
    },
    [scopeStudents, selectedKey, isMultiExam, monitoredQuizzes.length, sidebarMode, secondaryFilter, scopeLabel]
  );

  // Scoped Bulk: Announcement
  const handleBroadcastAnnouncement = (e: React.FormEvent) => {
    e.preventDefault();
    if (!announcementText.trim()) return;

    const message = announcementText.trim();
    const activeTargets = scopeStudents.filter((s) => s.status !== 'submitted' && s.quizCode);

    if (selectedKey === '__ALL__' && isMultiExam) {
      if (
        !window.confirm(
          `Broadcast notice to candidates across ${monitoredQuizzes.length} exams?`
        )
      ) {
        return;
      }
    }

    const targetClass =
      sidebarMode === 'class' && selectedKey !== '__ALL__'
        ? selectedKey
        : sidebarMode === 'exam' && secondaryFilter !== 'all'
          ? secondaryFilter
          : undefined;

    const targetQuizzes = Array.from(
      new Set(activeTargets.map((t) => t.quizCode!).filter(Boolean))
    );
    const codesToSend =
      targetQuizzes.length > 0 ? targetQuizzes : monitoredQuizzes.map((q) => q.quizCode);

    codesToSend.forEach((code) => {
      sendProctorCommand(code, 'ALL', 'announcement', { message, targetClass });
    });

    setLogEvents((prev) => [
      {
        id: `evt-${Date.now()}`,
        timestamp: new Date().toISOString(),
        studentName: scopeLabel,
        type: 'announcement',
        detail: `Notice broadcast: "${message}"`,
        severity: 'info',
      },
      ...prev,
    ]);

    setAnnouncementSuccess(true);
    setTimeout(() => {
      setAnnouncementSuccess(false);
      setShowAnnouncementModal(false);
      setAnnouncementText('');
    }, 1200);
  };

  // Batch Ingest Emergency Offline Papers (.exam) directly into the Live Cockpit
  const handleEmergencyFilesIngest = useCallback(
    async (fileList: FileList | File[]) => {
      const filesArray = Array.from(fileList);
      if (filesArray.length === 0) return;

      setIsIngestingEmergency(true);
      setEmergencyIngestionSummary(null);

      try {
        const loadedFiles = await Promise.all(
          filesArray.map(
            (file) =>
              new Promise<{ fileName: string; content: string }>((resolve) => {
                const reader = new FileReader();
                reader.onload = (evt) => {
                  resolve({
                    fileName: file.name,
                    content: (evt.target?.result as string) || '',
                  });
                };
                reader.onerror = () => {
                  resolve({ fileName: file.name, content: '' });
                };
                reader.readAsText(file);
              })
          )
        );

        const allowedCodes = monitoredQuizzes
          .map((q) => (q.quizCode || '').trim().toUpperCase())
          .filter(Boolean);

        // Load authoritative question banks per monitored quiz so offline .exam scores are re-graded deterministically
        const questionsByQuizCode: Record<string, Question[]> = {};
        await Promise.all(
          monitoredQuizzes.map(async (q) => {
            const code = (q.quizCode || '').trim().toUpperCase();
            if (!code || questionsByQuizCode[code]) return;
            try {
              if (q.testId) {
                const customRes = await fetchCustomTestWithQuestions(q.testId);
                if (customRes?.questions && customRes.questions.length > 0) {
                  questionsByQuizCode[code] = customRes.questions;
                  return;
                }
              }
              if (q.questionIds && q.questionIds.length > 0) {
                const loaded = await fetchAndApplyOverrides(
                  q.questionIds,
                  q.headerConfig?.questionOverrides
                );
                if (loaded.length > 0) {
                  questionsByQuizCode[code] = loaded;
                }
              }
            } catch {
              // Best-effort; ingestEmergencySubmissionContent zeros forged scores if questions unavailable
            }
          })
        );

        const summary = await ingestEmergencySubmissionBatch(loadedFiles, {
          allowedQuizCodes: allowedCodes,
          questionsByQuizCode,
        });

        setEmergencyIngestionSummary(summary);

        // Immediately reconcile cockpit student cards for every newly ingested or updated paper
        const ingestedSubmissions = summary.results
          .filter((r) => (r.status === 'inserted' || r.status === 'updated') && r.submission)
          .map((r) => r.submission!);

        if (ingestedSubmissions.length > 0) {
          setStudents((prev) => {
            const next = { ...prev };
            ingestedSubmissions.forEach((sub) => {
              const qCode = (sub.quizCode || '').trim().toUpperCase();
              const quizMeta = quizByCode[qCode];
              const canonicalId =
                sub.forensics?.proctorStudentId ||
                getCanonicalProctorStudentId({
                  quizCode: qCode,
                  studentName: sub.studentName,
                  candidateNumber: sub.candidateNumber,
                  studentClass: sub.studentClass,
                });
              const compKey = `${qCode}::${canonicalId}`;
              const existing = next[compKey];

              const hasQuestionResults =
                Array.isArray(sub.questionResults) && sub.questionResults.length > 0;
              const subProgress = computeSubmissionProgress(
                sub,
                quizMeta?.questionCount || existing?.totalQuestions || 1
              );
              next[compKey] = {
                studentId: canonicalId,
                studentName: sub.studentName,
                candidateNumber: sub.candidateNumber || existing?.candidateNumber || '',
                candidateClass: sub.studentClass || existing?.candidateClass || '',
                status: 'submitted',
                answeredCount: hasQuestionResults
                  ? subProgress.answeredCount
                  : existing?.answeredCount || 0,
                totalQuestions: hasQuestionResults
                  ? subProgress.totalQuestions
                  : quizMeta?.questionCount || existing?.totalQuestions || 1,
                currentIndex: hasQuestionResults
                  ? subProgress.totalQuestions
                  : quizMeta?.questionCount || existing?.currentIndex || 1,
                timeLeftSeconds: 0,
                violationsCount: sub.violationsCount || existing?.violationsCount || 0,
                multiMonitorDetected: false,
                deviceOS: existing?.deviceOS || 'Emergency File (.exam)',
                lastHeartbeat: Date.now(),
                exceededMaxViolations: Boolean(sub.forensics?.exceededMaxViolations),
                quizCode: qCode,
                quizTitle: quizMeta?.title || sub.quizTitle,
              };
            });
            return next;
          });

          setLogEvents((prev) => [
            ...ingestedSubmissions.map((sub) => ({
              id: `evt-emerg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              timestamp: new Date().toISOString(),
              studentName: sub.studentName,
              quizCode: sub.quizCode,
              type: 'submitted' as const,
              detail: `📥 Emergency offline paper (.exam) decrypted and ingested`,
              severity: 'info' as const,
            })),
            ...prev,
          ]);
        }
      } finally {
        setIsIngestingEmergency(false);
      }
    },
    [monitoredQuizzes, quizByCode]
  );

  const formatClock = (seconds: number) => {
    if (seconds <= 0) return '00:00';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const getStatusBadge = (status: StudentExamStatus, multiMonitor: boolean) => {
    if (status === 'locked') {
      return <span className="lip-status-badge lip-status-badge--locked">🚨 LOCKED</span>;
    }
    if (status === 'warning' || multiMonitor) {
      return (
        <span className="lip-status-badge lip-status-badge--warning">
          {multiMonitor ? '🟣 MULTI-MONITOR' : '⚠️ WARNING'}
        </span>
      );
    }
    if (status === 'active') {
      return <span className="lip-status-badge lip-status-badge--active">🟢 FOCUSED</span>;
    }
    if (status === 'submitted') {
      return <span className="lip-status-badge lip-status-badge--submitted">⚪ SUBMITTED</span>;
    }
    return <span className="lip-status-badge lip-status-badge--offline">⚫ OFFLINE</span>;
  };

  const renderSecurityBadge = (s: ProctorStudentState, isExceeded: boolean, maxV: number) => {
    if (s.autoSubmittedBySecurity) {
      return (
        <span
          className="lip-badge-exceeded-limit"
          style={{ background: '#b91c1c', borderColor: '#ef4444' }}
          title="Candidate exceeded maximum security strike allowance and was auto-submitted"
        >
          🛑 AUTO-SUBMIT ({s.strikeCount ?? s.violationsCount})
        </span>
      );
    }
    if (isExceeded) {
      return (
        <span
          className="lip-badge-exceeded-limit"
          title="Candidate exceeded allowed security notices"
        >
          🚨 LIMIT ({s.strikeCount ?? s.violationsCount}/{maxV || 'Max'})
        </span>
      );
    }
    if (s.currentTierAction === 'time_penalty' && (s.totalPenaltySeconds || 0) > 0) {
      return (
        <span
          className="lip-badge-exceeded-limit"
          style={{ background: '#c2410c', borderColor: '#f97316' }}
          title={`Active Penalty Tier: ${s.currentTierName}`}
        >
          ⏱️ {s.currentTierName} (-{Math.round((s.totalPenaltySeconds || 0) / 60)}m)
        </span>
      );
    }
    if (s.currentTierName && (s.strikeCount ?? 0) > 0) {
      return (
        <span
          className="lip-badge-exceeded-limit"
          style={{ background: '#d97706', borderColor: '#f59e0b' }}
          title={`Security Tier: ${s.currentTierName}`}
        >
          ⚠️ Strike {s.strikeCount}
        </span>
      );
    }
    return null;
  };

  const renderCandidateActions = (
    s: ProctorStudentState,
    compositeKey: string,
    isLocked: boolean,
    isOverdueLock: boolean,
    compMinutes: number,
    compact = false
  ) => {
    const isLiveSession = s.status !== 'submitted' && !s.autoSubmittedBySecurity;
    return (
      <div className={compact ? 'lip-row-actions' : 'lip-card-actions'}>
        {isLiveSession && (
          <>
            {isLocked ? (
              <>
                <button
                  type="button"
                  className="lip-card-btn lip-card-btn--unlock"
                  onClick={() => handleRemoteUnlock(compositeKey)}
                  title="Remotely clear lock screen and resume candidate examination"
                >
                  🔓 Unlock
                </button>
                {isOverdueLock && (
                  <button
                    type="button"
                    className="lip-card-btn lip-card-btn--compensate"
                    onClick={() => handleUnlockAndCompensate(compositeKey, compMinutes)}
                    title={`Unlock and add +${compMinutes}m wait compensation`}
                  >
                    +{compMinutes}m
                  </button>
                )}
              </>
            ) : (
              <button
                type="button"
                className="lip-card-btn lip-card-btn--time"
                onClick={() => handleAddTime(compositeKey, 5)}
                title="Add +5 minutes accommodation to candidate"
              >
                ⏱️ +5m
              </button>
            )}
            {(s.strikeCount ?? s.violationsCount) > 0 && (
              <button
                type="button"
                className="lip-card-btn lip-card-btn--pardon"
                onClick={() => handlePardon(compositeKey)}
                title="Pardon strikes and reset violation counters"
              >
                🛡️ Pardon
              </button>
            )}
            <button
              type="button"
              className="lip-card-btn lip-card-btn--notice"
              onClick={() => {
                setDirectNoticeTargetKey(compositeKey);
                setDirectNoticeText('');
                setDirectNoticeSent(false);
              }}
              title="Send direct warning/notice to this student only"
            >
              💬 Notice
            </button>
            <button
              type="button"
              className="lip-card-btn lip-card-btn--force"
              onClick={() => handleForceSubmit(compositeKey)}
              title="Force submission of exam attempt"
            >
              🛑 Submit
            </button>
          </>
        )}
        <button
          type="button"
          className="lip-card-btn lip-card-btn--log"
          onClick={() => setSelectedStudentLogKey(compositeKey)}
          title="View individual candidate security & action log"
        >
          📜 Log
        </button>
      </div>
    );
  };

  return (
    <div className="lip-modal-overlay animate-fade-in" role="dialog" aria-modal="true">
      <div className="lip-modal-container">
        {/* Top Command Header */}
        <header className="lip-header">
          <div className="lip-header-title-wrap">
            <div className="lip-live-indicator">
              <span className="lip-pulse-dot" />
              <span className="lip-live-text">LIVE COCKPIT</span>
            </div>
            <div>
              <div className="lip-title-row">
                <h2 className="lip-title">
                  🛡️ {scope === 'focus' && singleFocusQuiz ? (
                    <>
                      Live Proctor:{' '}
                      <span className="lip-quiz-name">{singleFocusQuiz.title}</span>
                    </>
                  ) : (
                    <>
                      School-Wide Live Invigilator:{' '}
                      <span className="lip-quiz-name">
                        {monitoredQuizzes.length} Active Exam{monitoredQuizzes.length !== 1 ? 's' : ''}
                      </span>
                    </>
                  )}
                </h2>

                {initialFocusQuizCode && (
                  <div className="lip-scope-pills" role="tablist">
                    <button
                      type="button"
                      className={`lip-scope-pill ${scope === 'focus' ? 'lip-scope-pill--active' : ''}`}
                      onClick={() => setScope('focus')}
                    >
                      Single Exam ({initialFocusQuizCode})
                    </button>
                    <button
                      type="button"
                      className={`lip-scope-pill ${scope === 'all' ? 'lip-scope-pill--active' : ''}`}
                      onClick={() => setScope('all')}
                    >
                      All Active School Exams ({quizzes.length})
                    </button>
                  </div>
                )}
              </div>

              {singleFocusQuiz && scope === 'focus' && (
                <div className="lip-subtitle">
                  <span>Code: <strong>{singleFocusQuiz.quizCode}</strong></span>
                  <span>•</span>
                  <span>PIN: <strong>{singleFocusQuiz.teacherPin || '1234'}</strong></span>
                  <span>•</span>
                  <span>Duration: <strong>{singleFocusQuiz.durationMinutes} mins</strong></span>
                  <span>•</span>
                  <span>Questions: <strong>{singleFocusQuiz.questionCount}</strong></span>
                </div>
              )}
            </div>
          </div>

          <div className="lip-header-actions">
            <div className="lip-alert-controls" title="Live Violation Notification Scope & Sound">
              <button
                type="button"
                className={`lip-alert-chip ${alertScopeMode === 'selected_scope' ? 'lip-alert-chip--active' : ''}`}
                onClick={() =>
                  setAlertScopeMode((m) => (m === 'selected_scope' ? 'whole_school' : 'selected_scope'))
                }
                title="Toggle whether violation pop-up alerts follow your selected Class/Exam filter or cover the whole school"
              >
                {alertScopeMode === 'selected_scope' ? '🎯 Alerts: Selected Scope' : '🌐 Alerts: Whole School'}
              </button>
              <button
                type="button"
                className={`lip-alert-chip ${alertSoundMode === 'muted' ? 'lip-alert-chip--muted' : 'lip-alert-chip--sound'}`}
                onClick={() =>
                  setAlertSoundMode((m) =>
                    m === 'all' ? 'critical_only' : m === 'critical_only' ? 'muted' : 'all'
                  )
                }
                title="Cycle alert chime mode: All Violations → Critical & >1m Stuck Only → Muted"
              >
                {alertSoundMode === 'all'
                  ? '🔔 Sound: All'
                  : alertSoundMode === 'critical_only'
                    ? '🚨 Sound: Critical'
                    : '🔕 Muted'}
              </button>
            </div>
            <button
              type="button"
              className="lip-btn-log-toggle"
              style={{
                background: 'rgba(16, 185, 129, 0.14)',
                borderColor: 'rgba(16, 185, 129, 0.4)',
                color: '#34d399',
              }}
              onClick={() => {
                setEmergencyIngestionSummary(null);
                setShowEmergencyIngestModal(true);
              }}
              title="Batch ingest encrypted .exam emergency files collected via USB or device file transfer"
            >
              📥 Ingest Emergency Papers
            </button>
            <button
              type="button"
              className={`lip-btn-log-toggle ${showLogDrawer ? 'lip-btn-log-toggle--active' : ''}`}
              onClick={() => setShowLogDrawer(!showLogDrawer)}
              title="Toggle Class & School Activity Log Drawer"
            >
              📜 Audit Logs ({logEvents.length})
              {Object.values(unreadViolationsByClass).reduce((a, b) => a + b, 0) > 0 && !showLogDrawer && (
                <span className="lip-log-unread-dot">
                  +{Object.values(unreadViolationsByClass).reduce((a, b) => a + b, 0)}
                </span>
              )}
            </button>
            <button
              type="button"
              className="lip-close-btn"
              onClick={onClose}
              aria-label="Close Invigilator Dashboard"
            >
              ✕
            </button>
          </div>
        </header>

        {cloudAuthWarning && (
          <div role="alert" className="lip-auth-warning-bar">
            <span>⚠️ {cloudAuthWarning}</span>
          </div>
        )}

        {/* ─── Split Screen Shell: Left Sidebar & Right Stage ──────────────── */}
        <div className="lip-shell">
          {/* Left Sidebar (Classes / Exams) */}
          <aside className="lip-sidebar" aria-label="Cohorts Navigation">
            <div className="lip-sidebar-switch">
              <button
                type="button"
                className={`lip-sidebar-switch-btn ${sidebarMode === 'class' ? 'lip-sidebar-switch-btn--active' : ''
                  }`}
                onClick={() => setSidebarMode('class')}
              >
                🏫 Classes
              </button>
              <button
                type="button"
                className={`lip-sidebar-switch-btn ${sidebarMode === 'exam' ? 'lip-sidebar-switch-btn--active' : ''
                  }`}
                onClick={() => setSidebarMode('exam')}
              >
                📝 Exams ({monitoredQuizzes.length})
              </button>
            </div>

            {/* Pinned 'All Candidates' Row */}
            <button
              type="button"
              className={`lip-sidebar-item lip-sidebar-item--all ${selectedKey === '__ALL__' ? 'lip-sidebar-item--active' : ''
                }`}
              onClick={() => setSelectedKey('__ALL__')}
            >
              <div className="lip-sidebar-item-info">
                <span className="lip-sidebar-icon">🌐</span>
                <span className="lip-sidebar-name">All Candidates</span>
              </div>
              <div className="lip-sidebar-item-badges">
                {scopedStats.exceeded > 0 && (
                  <span className="lip-sidebar-alert lip-sidebar-alert--critical" title="Exceeded strikes limit">
                    🚨 {scopedStats.exceeded}
                  </span>
                )}
                {scopedStats.locked > 0 && (
                  <span className="lip-sidebar-alert lip-sidebar-alert--critical" title="Locked candidates">
                    🔒 {scopedStats.locked}
                  </span>
                )}
                <span className="lip-sidebar-count">{activeMonitoredStudents.length}</span>
              </div>
            </button>

            {/* Scrollable Items List */}
            <div className="lip-sidebar-list">
              {sidebarMode === 'class' ? (
                sidebarClasses.map((cls) => {
                  const m = classStats[cls] || { total: 0, locked: 0, warnings: 0, exceeded: 0 };
                  const isSelected = selectedKey === cls;
                  return (
                    <button
                      key={cls}
                      type="button"
                      className={`lip-sidebar-item ${isSelected ? 'lip-sidebar-item--active' : ''}`}
                      onClick={() => setSelectedKey(cls)}
                    >
                      <div className="lip-sidebar-item-info">
                        <span className="lip-sidebar-icon">🏫</span>
                        <span className="lip-sidebar-name" title={cls}>
                          {cls}
                        </span>
                      </div>
                      <div className="lip-sidebar-item-badges">
                        {(unreadViolationsByClass[cls] || 0) > 0 && (
                          <span
                            className="lip-sidebar-alert lip-sidebar-alert--unread"
                            title={`${unreadViolationsByClass[cls]} new violation alert(s)`}
                          >
                            +{unreadViolationsByClass[cls]}
                          </span>
                        )}
                        {m.exceeded > 0 && (
                          <span className="lip-sidebar-alert lip-sidebar-alert--critical" title="Exceeded limit">
                            🚨 {m.exceeded}
                          </span>
                        )}
                        {m.locked > 0 && (
                          <span className="lip-sidebar-alert lip-sidebar-alert--critical" title="Locked">
                            🔒 {m.locked}
                          </span>
                        )}
                        {m.warnings > 0 && m.locked === 0 && m.exceeded === 0 && (
                          <span className="lip-sidebar-alert lip-sidebar-alert--warning" title="Warnings">
                            ⚠️ {m.warnings}
                          </span>
                        )}
                        {m.missingCount > 0 && (
                          <span className="lip-sidebar-alert lip-sidebar-alert--missing" title={`${m.missingCount} candidate(s) not joined yet`}>
                            👻 {m.missingCount}
                          </span>
                        )}
                        <span className="lip-sidebar-count">
                          {m.rosterTotal > 0 ? `${m.total}/${m.rosterTotal}` : m.total}
                        </span>
                      </div>
                    </button>
                  );
                })
              ) : (
                monitoredQuizzes.map((q) => {
                  const code = (q.quizCode || '').trim().toUpperCase();
                  const m = examStats[code] || { total: 0, locked: 0, warnings: 0, exceeded: 0 };
                  const isSelected = selectedKey === code;
                  return (
                    <button
                      key={q.id || code}
                      type="button"
                      className={`lip-sidebar-item ${isSelected ? 'lip-sidebar-item--active' : ''}`}
                      onClick={() => setSelectedKey(code)}
                    >
                      <div className="lip-sidebar-item-info">
                        <span className="lip-sidebar-icon">📝</span>
                        <div className="lip-sidebar-title-col">
                          <span className="lip-sidebar-name" title={q.title}>
                            {q.title}
                          </span>
                          <span className="lip-sidebar-code">{code}</span>
                        </div>
                      </div>
                      <div className="lip-sidebar-item-badges">
                        {m.exceeded > 0 && (
                          <span className="lip-sidebar-alert lip-sidebar-alert--critical" title="Exceeded limit">
                            🚨 {m.exceeded}
                          </span>
                        )}
                        {m.locked > 0 && (
                          <span className="lip-sidebar-alert lip-sidebar-alert--critical" title="Locked">
                            🔒 {m.locked}
                          </span>
                        )}
                        <span className="lip-sidebar-count">{m.total}</span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>

            {/* Sidebar Footer Controls */}
            {sidebarMode === 'class' && (
              <div className="lip-sidebar-footer">
                <label className="lip-checkbox-label">
                  <input
                    type="checkbox"
                    checked={hideEmptyClasses}
                    onChange={(e) => setHideEmptyClasses(e.target.checked)}
                  />
                  <span>Hide empty classes</span>
                </label>
              </div>
            )}
          </aside>

          {/* Right Main Stage */}
          <main className="lip-stage">
            {/* Stage Scope Header & Toolbar */}
            <div className="lip-stage-head">
              <div className="lip-stage-title-wrap">
                <h3 className="lip-stage-title">
                  {selectedKey === '__ALL__' ? (
                    sidebarMode === 'class' ? '🌐 All School Classes' : '🌐 All Active Exam Papers'
                  ) : sidebarMode === 'class' ? (
                    `🏫 ${selectedKey}`
                  ) : (
                    `📝 ${quizByCode[selectedKey.toUpperCase()]?.title || selectedKey} (${selectedKey})`
                  )}
                </h3>
                <span className="lip-stage-count-badge">
                  {filteredStudents.length} candidate{filteredStudents.length !== 1 ? 's' : ''} showing
                </span>
              </div>
            </div>

            {/* Sticky Escalation Triage Banner for Candidates on Lock Screen > 1 Minute */}
            {overdueLockedInScope.length > 0 && (
              <div className="lip-overdue-triage-banner" role="alert">
                <div className="lip-overdue-triage-head">
                  <span>
                    🚨 <strong>{overdueLockedInScope.length} Candidate{overdueLockedInScope.length !== 1 ? 's' : ''} Stuck on Violation Screen (&ge; 1 min):</strong>{' '}
                    Exam timer continues while waiting for invigilator unlock.
                  </span>
                </div>
                <div className="lip-overdue-triage-chips">
                  {overdueLockedInScope.slice(0, 6).map((s) => {
                    const qCode = (s.quizCode || '').trim().toUpperCase();
                    const compKey = `${qCode}::${s.studentId}`;
                    const waitMs = getLockedDurationMs(s, nowMs);
                    const waitStr = formatLockedDuration(waitMs);
                    const compMins = computeWaitCompensationMinutes(waitMs);
                    return (
                      <div key={compKey} className="lip-overdue-chip">
                        <span className="lip-overdue-chip-name">
                          {s.studentName}
                          {s.candidateClass ? ` (${s.candidateClass})` : ''} · ⏳ {waitStr}
                        </span>
                        <div className="lip-overdue-chip-btns">
                          <button
                            type="button"
                            className="lip-chip-btn lip-chip-btn--unlock"
                            onClick={() => handleRemoteUnlock(compKey)}
                            title="Unlock immediately"
                          >
                            🔓 Unlock
                          </button>
                          <button
                            type="button"
                            className="lip-chip-btn lip-chip-btn--comp"
                            onClick={() => handleUnlockAndCompensate(compKey, compMins)}
                            title={`Unlock and add +${compMins}m wait compensation`}
                          >
                            +{compMins}m &amp; Unlock
                          </button>
                          <button
                            type="button"
                            className="lip-chip-btn"
                            onClick={() => handleLocateStudent(compKey)}
                            title="Locate student card"
                          >
                            🔍
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Toolbar: Status Tabs, Secondary Filter, Sorter, Search, and Scoped Bulk Buttons */}
            <div className="lip-toolbar">
              <div className="lip-filter-tabs">
                <button
                  type="button"
                  className={`lip-tab ${activeFilter === 'all' ? 'lip-tab--active' : ''}`}
                  onClick={() => setActiveFilter('all')}
                >
                  All ({scopeStudents.length})
                </button>
                {scopedStats.exceeded > 0 && (
                  <button
                    type="button"
                    className={`lip-tab lip-tab-btn--exceeded ${activeFilter === 'exceeded' ? 'lip-tab--active' : ''
                      }`}
                    onClick={() => setActiveFilter('exceeded')}
                  >
                    🚨 Exceeded ({scopedStats.exceeded})
                  </button>
                )}
                <button
                  type="button"
                  className={`lip-tab ${activeFilter === 'locked' ? 'lip-tab--active' : ''}`}
                  onClick={() => setActiveFilter('locked')}
                >
                  🔒 Locked ({scopedStats.locked})
                </button>
                <button
                  type="button"
                  className={`lip-tab ${activeFilter === 'warnings' ? 'lip-tab--active' : ''}`}
                  onClick={() => setActiveFilter('warnings')}
                >
                  ⚠️ Warnings ({scopedStats.warnings + scopedStats.multiMonitor})
                </button>
                <button
                  type="button"
                  className={`lip-tab ${activeFilter === 'active' ? 'lip-tab--active' : ''}`}
                  onClick={() => setActiveFilter('active')}
                >
                  🟢 Active ({scopedStats.active})
                </button>
                <button
                  type="button"
                  className={`lip-tab ${activeFilter === 'submitted' ? 'lip-tab--active' : ''}`}
                  onClick={() => setActiveFilter('submitted')}
                >
                  ⚪ Submitted ({scopedStats.submitted})
                </button>
                {missingStudents.length > 0 && (
                  <button
                    type="button"
                    className={`lip-tab lip-tab--missing ${activeFilter === 'missing' ? 'lip-tab--active' : ''}`}
                    onClick={() => setActiveFilter('missing')}
                    title="Candidates registered in school roster who have not joined yet"
                  >
                    👻 Not Joined ({missingStudents.length})
                  </button>
                )}
              </div>

              {/* Secondary Filter Dropdown */}
              <div className="lip-filter-dropdowns">
                {sidebarMode === 'class' ? (
                  <div className="lip-select-wrap">
                    <span className="lip-select-icon">📝</span>
                    <select
                      className="lip-select"
                      value={secondaryFilter}
                      onChange={(e) => setSecondaryFilter(e.target.value)}
                      aria-label="Filter by Exam Paper"
                      title="Filter candidates by Exam Paper"
                    >
                      <option value="all">All Exam Papers ({monitoredQuizzes.length})</option>
                      {monitoredQuizzes.map((q) => (
                        <option key={q.id || q.quizCode} value={q.quizCode.toUpperCase()}>
                          {q.quizCode} - {q.title}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <div className="lip-select-wrap">
                    <span className="lip-select-icon">🏫</span>
                    <select
                      className="lip-select"
                      value={secondaryFilter}
                      onChange={(e) => setSecondaryFilter(e.target.value)}
                      aria-label="Filter by Class Cohort"
                      title="Filter candidates by School Class"
                    >
                      <option value="all">All Classes ({sidebarClasses.length})</option>
                      {sidebarClasses.map((cls) => (
                        <option key={cls} value={cls}>
                          {cls}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {/* Sorter */}
                <div className="lip-select-wrap">
                  <span className="lip-select-icon">⇅</span>
                  <select
                    className="lip-select"
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as ProctorSortOption)}
                    aria-label="Sort candidates"
                    title="Sort Candidate Cards"
                  >
                    <option value="priority">🚨 Priority Triage (Overdue &amp; Locked First)</option>
                    <option value="class_seat">Class &amp; Seat No.</option>
                    <option value="status">Status (Alerts First)</option>
                    <option value="name">Candidate Name (A-Z)</option>
                    <option value="progress">Progress (% High to Low)</option>
                    <option value="time_left">Time Left (Least First)</option>
                    <option value="violations">Violations (Most First)</option>
                  </select>
                </div>
              </div>

              <div className="lip-search-wrap">
                <input
                  type="text"
                  className="lip-search-input"
                  placeholder="🔍 Search name, seat, class, or code..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>

              {/* View Mode Switcher (Compact Table vs Cards) */}
              <div className="lip-view-toggle" role="group" aria-label="View Mode">
                <button
                  type="button"
                  className={`lip-view-btn ${viewMode === 'table' ? 'lip-view-btn--active' : ''}`}
                  onClick={() => setViewMode('table')}
                  title="Compact table view for scanning whole-school exams quickly"
                >
                  ☰ Table
                </button>
                <button
                  type="button"
                  className={`lip-view-btn ${viewMode === 'cards' ? 'lip-view-btn--active' : ''}`}
                  onClick={() => setViewMode('cards')}
                  title="Detailed card grid view"
                >
                  ⊞ Cards
                </button>
              </div>

              {/* Scoped Bulk Action Controls */}
              <div className="lip-cohort-actions">
                <button
                  type="button"
                  className="lip-btn-cohort lip-btn-announce"
                  onClick={() => setShowAnnouncementModal(true)}
                  title={`Broadcast an urgent banner notice to ${scopeLabel}`}
                >
                  📢 Notice
                </button>
                {scopedStats.locked > 0 && (
                  <button
                    type="button"
                    className="lip-btn-cohort lip-btn-unlock-all"
                    onClick={handleScopedUnlock}
                    title={`Remotely unlock all ${scopedStats.locked} locked candidate(s) in ${scopeLabel}`}
                  >
                    🔓 Unlock All ({scopedStats.locked})
                  </button>
                )}
                <button
                  type="button"
                  className="lip-btn-cohort lip-btn-add-all-time"
                  onClick={() => handleScopedAddTime(5)}
                  title={`Grant +5 minutes extra time to active candidates in ${scopeLabel}`}
                >
                  ⏱️ +5m Scope
                </button>
              </div>
            </div>

            {/* Candidate Cards Grid & Activity Log Drawer */}
            <div className="lip-body">
              <div
                className={`lip-grid-container ${showLogDrawer ? 'lip-grid-container--with-drawer' : ''
                  }`}
              >
                {activeFilter === 'missing' ? (
                  missingStudents.length === 0 ? (
                    <div className="lip-empty-state">
                      <span className="lip-empty-icon">🎉</span>
                      <h3>Full Attendance!</h3>
                      <p>All candidates from the school roster in {scopeLabel} have connected to the examination.</p>
                    </div>
                  ) : (
                    <div className="lip-students-grid">
                      {missingStudents.map((m) => (
                        <div
                          key={`missing_${m.class}_${m.id || m.name}`}
                          className="lip-student-card lip-student-card--missing"
                        >
                          <div className="lip-card-header">
                            <div className="lip-student-info">
                              <h4 className="lip-student-name" title={m.name}>
                                {m.name}
                              </h4>
                              <div className="lip-student-sub">
                                {m.candidateNumber && (
                                  <span className="lip-tag lip-tag-seat">
                                    Seat: {m.candidateNumber}
                                  </span>
                                )}
                                <span className="lip-tag lip-tag-class">
                                  {m.class}
                                </span>
                              </div>
                            </div>
                            <div className="lip-card-badge-wrap">
                              <span className="lip-status-badge lip-status-badge--missing">
                                ⚫ NOT JOINED
                              </span>
                            </div>
                          </div>

                          <div className="lip-missing-notice-box">
                            <span className="lip-missing-icon">👻</span>
                            <span className="lip-missing-text">
                              Candidate is registered in the class roster but has not connected to this exam session yet.
                            </span>
                          </div>

                          <div className="lip-card-telemetry">
                            <div className="lip-telemetry-row">
                              <span className="lip-telemetry-label">Status:</span>
                              <span style={{ color: 'var(--color-text-secondary)', fontWeight: 600 }}>
                                Expected from School Roster
                              </span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                ) : filteredStudents.length === 0 ? (
                  <div className="lip-empty-state">
                    {activeMonitoredStudents.length === 0 ? (
                      <>
                        <span className="lip-empty-icon">📡</span>
                        <h3>Waiting for Candidates to Connect</h3>
                        <p>
                          {monitoredQuizzes.length === 1
                            ? `Share Quiz Code "${monitoredQuizzes[0].quizCode}" with your candidates.`
                            : `Share Quiz Codes with your classes. As candidates join, their live telemetry, progress, and timers will stream here automatically.`}
                        </p>
                      </>
                    ) : (
                      <>
                        <span className="lip-empty-icon">🔍</span>
                        <h3>No candidates found in {scopeLabel} matching filters</h3>
                        <button
                          type="button"
                          className="lip-btn-clear-filter"
                          onClick={() => {
                            setActiveFilter('all');
                            setSecondaryFilter('all');
                            setSearchQuery('');
                          }}
                        >
                          Clear Filters
                        </button>
                      </>
                    )}
                  </div>
                ) : viewMode === 'table' ? (
                  <div className="lip-table-wrap">
                    <table className="lip-table">
                      <thead>
                        <tr>
                          <th>Candidate</th>
                          <th>Class{isMultiExam ? ' / Exam' : ''}</th>
                          <th>Status</th>
                          <th>Progress</th>
                          <th>Time Left</th>
                          <th>Strikes</th>
                          <th style={{ textAlign: 'right' }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredStudents.map((s) => {
                          const qCode = (s.quizCode || '').trim().toUpperCase();
                          const compositeKey = `${qCode}::${s.studentId}`;
                          const progressPct = clampProgressPercent(
                            s.answeredCount,
                            s.totalQuestions
                          );
                          const isLocked = s.status === 'locked';
                          const isExceeded = isStudentExceeded(s);
                          const maxV = getMaxViolations(s);
                          const lockDurationMs = isLocked ? getLockedDurationMs(s, nowMs) : 0;
                          const isOverdueLock = isLocked && lockDurationMs >= OVERDUE_LOCK_THRESHOLD_MS;
                          const compMinutes = computeWaitCompensationMinutes(lockDurationMs);
                          const strikes = s.strikeCount ?? s.violationsCount;
                          const hasValidSeat = Boolean(s.candidateNumber && s.candidateNumber.trim() !== '-');

                          return (
                            <tr
                              key={compositeKey}
                              ref={(el) => {
                                cardRefs.current[compositeKey] = el;
                              }}
                              className={`lip-table-row ${isOverdueLock
                                ? 'lip-table-row--overdue'
                                : isLocked
                                  ? 'lip-table-row--locked'
                                  : isExceeded
                                    ? 'lip-table-row--exceeded'
                                    : s.status === 'warning'
                                      ? 'lip-table-row--warning'
                                      : ''
                                } ${focusedStudentKey === compositeKey ? 'lip-table-row--focused' : ''}`}
                            >
                              <td>
                                <div className="lip-table-candidate">
                                  <span className="lip-table-name" title={s.studentName}>
                                    {s.studentName}
                                  </span>
                                  {hasValidSeat && (
                                    <span className="lip-tag lip-tag-seat">Seat {s.candidateNumber}</span>
                                  )}
                                  {isLocked && s.lockReason && (
                                    <span className="lip-table-lock-reason" title={s.lockReason}>
                                      {isOverdueLock ? '🚨' : '🔒'} {s.lockReason}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td>
                                <div className="lip-table-cohort">
                                  <span className="lip-tag lip-tag-class">
                                    {s.candidateClass || 'Unassigned'}
                                  </span>
                                  {isMultiExam && s.quizCode && (
                                    <span className="lip-tag lip-tag-exam">{s.quizCode}</span>
                                  )}
                                </div>
                              </td>
                              <td>
                                <div className="lip-table-status">
                                  {getStatusBadge(s.status, s.multiMonitorDetected)}
                                  {isLocked && s.lockedSince && (
                                    <span
                                      className={`lip-lock-timer-pill ${isOverdueLock ? 'lip-lock-timer-pill--overdue' : ''
                                        }`}
                                    >
                                      ⏳ {formatLockedDuration(lockDurationMs)}
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td>
                                <div className="lip-table-progress">
                                  <div className="lip-progress-track lip-progress-track--compact">
                                    <div
                                      className="lip-progress-fill"
                                      style={{
                                        width: `${progressPct}%`,
                                        backgroundColor:
                                          progressPct === 100
                                            ? 'var(--color-success, #16a34a)'
                                            : 'var(--color-primary, #2563eb)',
                                      }}
                                    />
                                  </div>
                                  <span className="lip-table-progress-txt">
                                    {s.answeredCount}/{s.totalQuestions}
                                    {s.status !== 'submitted' && s.currentIndex > 0
                                      ? ` · Q${s.currentIndex}`
                                      : ''}
                                  </span>
                                </div>
                              </td>
                              <td>
                                <span className="lip-clock-val">{formatClock(s.timeLeftSeconds)}</span>
                              </td>
                              <td>
                                <div className="lip-table-strikes">
                                  <span
                                    className={`lip-telemetry-val ${strikes > 0 ? 'lip-telemetry-val--violation' : ''}`}
                                    title={s.lastViolation || undefined}
                                  >
                                    {strikes}
                                    {maxV > 0 ? `/${maxV}` : ''}
                                  </span>
                                  {renderSecurityBadge(s, isExceeded, maxV)}
                                </div>
                              </td>
                              <td style={{ textAlign: 'right' }}>
                                {renderCandidateActions(s, compositeKey, isLocked, isOverdueLock, compMinutes, true)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="lip-students-grid">
                    {filteredStudents.map((s) => {
                      const qCode = (s.quizCode || '').trim().toUpperCase();
                      const compositeKey = `${qCode}::${s.studentId}`;
                      const progressPct = clampProgressPercent(
                        s.answeredCount,
                        s.totalQuestions
                      );
                      const isLocked = s.status === 'locked';
                      const isExceeded = isStudentExceeded(s);
                      const maxV = getMaxViolations(s);
                      const lockDurationMs = isLocked ? getLockedDurationMs(s, nowMs) : 0;
                      const isOverdueLock = isLocked && lockDurationMs >= OVERDUE_LOCK_THRESHOLD_MS;
                      const compMinutes = computeWaitCompensationMinutes(lockDurationMs);
                      const hasValidSeat = Boolean(s.candidateNumber && s.candidateNumber.trim() !== '-');

                      return (
                        <div
                          key={compositeKey}
                          ref={(el) => {
                            cardRefs.current[compositeKey] = el;
                          }}
                          className={`lip-student-card ${isExceeded ? 'lip-student-card--exceeded' : ''
                            } ${isLocked ? 'lip-student-card--locked' : ''} ${isOverdueLock ? 'lip-student-card--overdue' : ''
                            } ${s.status === 'warning' ? 'lip-student-card--warning' : ''} ${focusedStudentKey === compositeKey ? 'lip-student-card--focused' : ''
                            }`}
                        >
                          {/* Compact Card Header */}
                          <div className="lip-card-header">
                            <div className="lip-student-info">
                              <h4 className="lip-student-name lip-student-name--compact" title={s.studentName}>
                                {s.studentName}
                              </h4>
                              <div className="lip-student-sub">
                                {hasValidSeat && (
                                  <span className="lip-tag lip-tag-seat">
                                    Seat {s.candidateNumber}
                                  </span>
                                )}
                                {s.candidateClass && (
                                  <span className="lip-tag lip-tag-class">
                                    {s.candidateClass}
                                  </span>
                                )}
                                {isMultiExam && s.quizCode && (
                                  <span
                                    className="lip-tag lip-tag-exam"
                                    title={s.quizTitle || s.quizCode}
                                  >
                                    📝 {s.quizCode}
                                  </span>
                                )}
                              </div>
                            </div>
                            <div className="lip-card-badge-wrap">
                              {getStatusBadge(s.status, s.multiMonitorDetected)}
                              {renderSecurityBadge(s, isExceeded, maxV)}
                            </div>
                          </div>

                          {/* Lock Reason Banner */}
                          {isLocked && (
                            <div
                              className={`lip-card-lock-banner ${isOverdueLock ? 'lip-card-lock-banner--overdue' : ''
                                }`}
                            >
                              <span className="lip-lock-icon">{isOverdueLock ? '🚨' : '🔒'}</span>
                              <span className="lip-lock-text">
                                {s.lockReason || 'Locked due to browser blur or security notice'}
                              </span>
                              {s.lockedSince && (
                                <span
                                  className={`lip-lock-timer-pill ${isOverdueLock ? 'lip-lock-timer-pill--overdue' : ''
                                    }`}
                                >
                                  ⏳ {formatLockedDuration(lockDurationMs)}
                                </span>
                              )}
                            </div>
                          )}

                          {/* Compact Progress & Strikes Row */}
                          <div className="lip-card-progress-section">
                            <div className="lip-progress-labels">
                              <span>
                                <strong>{s.answeredCount}</strong>/{s.totalQuestions} ({progressPct}%)
                                {s.status !== 'submitted' && s.currentIndex > 0
                                  ? ` · Q${s.currentIndex}`
                                  : ''}
                              </span>
                              <span
                                className={`lip-telemetry-val ${(s.strikeCount ?? s.violationsCount) > 0 ? 'lip-telemetry-val--violation' : ''}`}
                              >
                                {s.strikeCount ?? s.violationsCount} strike{(s.strikeCount ?? s.violationsCount) !== 1 ? 's' : ''}
                                {(s.totalPenaltySeconds || 0) > 0 && ` (-${Math.round((s.totalPenaltySeconds || 0) / 60)}m)`}
                              </span>
                              <span className="lip-clock-val">
                                ⏱️ {formatClock(s.timeLeftSeconds)}
                              </span>
                            </div>
                            <div className="lip-progress-track">
                              <div
                                className="lip-progress-fill"
                                style={{
                                  width: `${progressPct}%`,
                                  backgroundColor:
                                    progressPct === 100
                                      ? 'var(--color-success, #16a34a)'
                                      : 'var(--color-primary, #2563eb)',
                                }}
                              />
                            </div>
                          </div>

                          {/* Contextual Student Actions */}
                          {renderCandidateActions(s, compositeKey, isLocked, isOverdueLock, compMinutes, false)}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Right Side Class & School Activity Log Drawer */}
              {showLogDrawer && (
                <div className="lip-log-drawer animate-slide-in-right">
                  <div className="lip-log-drawer-header">
                    <div>
                      <h3>📜 Audit Logs ({drawerLogEvents.length})</h3>
                      <span className="lip-log-drawer-sub">
                        {logScopeMode === 'current_scope' ? `Scope: ${scopeLabel}` : 'Scope: Whole School'}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <button
                        type="button"
                        className="lip-log-export-btn"
                        disabled={drawerLogEvents.length === 0}
                        onClick={() => {
                          void exportProctorAuditLogExcelICM(drawerLogEvents, {
                            reportTitle: `Proctoring Log — ${logScopeMode === 'current_scope' ? scopeLabel : 'Whole School'}`,
                            quizCode: singleFocusQuiz?.quizCode || 'ALL',
                            targetClass: logScopeMode === 'current_scope' ? scopeLabel : 'Whole School',
                            filenameSlug: logScopeMode === 'current_scope' ? scopeLabel : 'whole_school',
                          });
                        }}
                        title="Export filtered proctoring log to ICM Excel (.xlsx)"
                      >
                        📥 .xlsx
                      </button>
                      <button
                        type="button"
                        className="lip-log-close"
                        onClick={() => setShowLogDrawer(false)}
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {/* Drawer Scope, Category & Search Controls */}
                  <div className="lip-log-controls">
                    <div className="lip-log-scope-row">
                      <button
                        type="button"
                        className={`lip-log-pill ${logScopeMode === 'current_scope' ? 'lip-log-pill--active' : ''}`}
                        onClick={() => setLogScopeMode('current_scope')}
                      >
                        🏫 Current Filter
                      </button>
                      <button
                        type="button"
                        className={`lip-log-pill ${logScopeMode === 'whole_school' ? 'lip-log-pill--active' : ''}`}
                        onClick={() => setLogScopeMode('whole_school')}
                      >
                        🌐 Whole School
                      </button>
                    </div>
                    <div className="lip-log-cat-row">
                      {([
                        { id: 'all', label: 'All' },
                        { id: 'violations', label: '⚠️ Violations' },
                        { id: 'locks', label: '🔒 Locks' },
                        { id: 'interventions', label: '🛡️ Actions' },
                      ] as const).map((cat) => (
                        <button
                          key={cat.id}
                          type="button"
                          className={`lip-log-pill ${logCategory === cat.id ? 'lip-log-pill--active' : ''}`}
                          onClick={() => setLogCategory(cat.id)}
                        >
                          {cat.label}
                        </button>
                      ))}
                    </div>
                    <input
                      type="text"
                      className="lip-log-search"
                      placeholder="Filter logs by student, seat, or event..."
                      value={logSearch}
                      onChange={(e) => setLogSearch(e.target.value)}
                    />
                  </div>

                  <div className="lip-log-events-list">
                    {drawerLogEvents.length === 0 ? (
                      <div className="lip-log-empty">No activity events match the selected filter.</div>
                    ) : (
                      drawerLogEvents.map((evt) => {
                        const timeStr = new Date(evt.timestamp).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        });
                        const evtCompKey =
                          evt.quizCode && evt.studentId
                            ? `${evt.quizCode.toUpperCase()}::${evt.studentId}`
                            : null;
                        return (
                          <div
                            key={evt.id}
                            className={`lip-log-item lip-log-item--${evt.severity} ${evtCompKey && students[evtCompKey] ? 'lip-log-item--clickable' : ''
                              }`}
                            onClick={() => {
                              if (evtCompKey && students[evtCompKey]) {
                                setSelectedStudentLogKey(evtCompKey);
                              }
                            }}
                            title={
                              evtCompKey && students[evtCompKey]
                                ? 'Click to open full individual student log'
                                : undefined
                            }
                          >
                            <div className="lip-log-top">
                              <span className="lip-log-name">
                                {isMultiExam && evt.quizCode ? `[${evt.quizCode}] ` : ''}
                                {evt.studentName}
                                {evt.candidateClass ? ` (${evt.candidateClass})` : ''}
                              </span>
                              <span className="lip-log-time">{timeStr}</span>
                            </div>
                            <div className="lip-log-detail">{evt.detail}</div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          </main>
        </div>

        {/* Floating Live Violation & Overdue Lock Notification Stack */}
        {alertToasts.length > 0 && (
          <div className="lip-toast-stack" role="region" aria-label="Live Proctoring Notifications">
            {alertToasts.map((toast) => {
              const targetState = students[toast.compositeKey];
              const isStillLocked = targetState?.status === 'locked';
              const compMins = toast.lockedDurationMs
                ? computeWaitCompensationMinutes(toast.lockedDurationMs)
                : 1;
              return (
                <div
                  key={toast.id}
                  className={`lip-toast lip-toast--${toast.severity} ${toast.kind === 'locked_overdue' ? 'lip-toast--overdue' : ''
                    }`}
                >
                  <div className="lip-toast-head">
                    <span className="lip-toast-title">
                      {toast.title}
                      {toast.repeatCount > 1 && (
                        <span className="lip-toast-repeat">×{toast.repeatCount}</span>
                      )}
                    </span>
                    <button
                      type="button"
                      className="lip-toast-close"
                      onClick={() => setAlertToasts((prev) => prev.filter((t) => t.id !== toast.id))}
                      aria-label="Dismiss notification"
                    >
                      ✕
                    </button>
                  </div>
                  <div className="lip-toast-student">
                    <strong>{toast.studentName}</strong>
                    {toast.candidateClass ? ` · ${toast.candidateClass}` : ''}
                    {toast.candidateNumber ? ` · Seat ${toast.candidateNumber}` : ''}
                    {toast.quizCode ? ` · ${toast.quizCode}` : ''}
                  </div>
                  <div className="lip-toast-detail">{toast.detail}</div>
                  <div className="lip-toast-actions">
                    {isStillLocked && (
                      <button
                        type="button"
                        className="lip-toast-btn lip-toast-btn--unlock"
                        onClick={() => handleRemoteUnlock(toast.compositeKey)}
                      >
                        🔓 Unlock
                      </button>
                    )}
                    {isStillLocked && toast.kind === 'locked_overdue' && (
                      <button
                        type="button"
                        className="lip-toast-btn lip-toast-btn--comp"
                        onClick={() => handleUnlockAndCompensate(toast.compositeKey, compMins)}
                      >
                        +{compMins}m &amp; Unlock
                      </button>
                    )}
                    <button
                      type="button"
                      className="lip-toast-btn"
                      onClick={() => handleLocateStudent(toast.compositeKey)}
                    >
                      🔍 Locate
                    </button>
                    <button
                      type="button"
                      className="lip-toast-btn"
                      onClick={() => setSelectedStudentLogKey(toast.compositeKey)}
                    >
                      📜 History
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Individual Candidate Audit Log Modal */}
        {selectedStudentLogKey && selectedStudentLogTarget && (
          <div
            className="lip-announcement-dialog animate-fade-in"
            role="dialog"
            onClick={() => setSelectedStudentLogKey(null)}
          >
            <div
              className="lip-announcement-card lip-student-log-modal"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="lip-student-log-head">
                <div>
                  <h3 style={{ margin: 0 }}>
                    📜 Candidate Audit Log: {selectedStudentLogTarget.studentName}
                  </h3>
                  <div className="lip-student-log-meta">
                    <span>Class: <strong>{selectedStudentLogTarget.candidateClass || 'Unassigned'}</strong></span>
                    <span>•</span>
                    <span>Seat: <strong>{selectedStudentLogTarget.candidateNumber || '-'}</strong></span>
                    <span>•</span>
                    <span>Exam: <strong>{selectedStudentLogTarget.quizCode}</strong></span>
                    <span>•</span>
                    <span>Strikes: <strong>{selectedStudentLogTarget.strikeCount ?? selectedStudentLogTarget.violationsCount}</strong></span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <button
                    type="button"
                    className="lip-log-export-btn"
                    onClick={() => {
                      void exportProctorAuditLogExcelICM(selectedStudentLogs, {
                        reportTitle: `Candidate Log — ${selectedStudentLogTarget.studentName}`,
                        quizCode: selectedStudentLogTarget.quizCode,
                        targetClass: selectedStudentLogTarget.candidateClass || 'Candidate',
                        filenameSlug: `${selectedStudentLogTarget.studentName}_${selectedStudentLogTarget.quizCode || ''}`,
                      });
                    }}
                  >
                    📥 Export Student Log (.xlsx)
                  </button>
                  <button
                    type="button"
                    className="lip-log-close"
                    onClick={() => setSelectedStudentLogKey(null)}
                  >
                    ✕
                  </button>
                </div>
              </div>

              {selectedStudentLogTarget.status === 'locked' && (
                <div className="lip-card-lock-banner" style={{ marginBottom: '12px' }}>
                  <span>🔒</span>
                  <span style={{ flex: 1 }}>
                    Currently Locked ({formatLockedDuration(getLockedDurationMs(selectedStudentLogTarget, nowMs))}) —{' '}
                    {selectedStudentLogTarget.lockReason || 'Security trigger'}
                  </span>
                  <button
                    type="button"
                    className="lip-chip-btn lip-chip-btn--unlock"
                    onClick={() => handleRemoteUnlock(selectedStudentLogKey)}
                  >
                    🔓 Unlock Now
                  </button>
                </div>
              )}

              <div className="lip-student-log-timeline">
                {selectedStudentLogs.length === 0 ? (
                  <div className="lip-log-empty">No discrete proctoring events recorded for this candidate yet.</div>
                ) : (
                  selectedStudentLogs.map((evt) => (
                    <div key={evt.id} className={`lip-log-item lip-log-item--${evt.severity}`}>
                      <div className="lip-log-top">
                        <span className="lip-log-name">
                          {String(evt.type || 'event').replace(/_/g, ' ').toUpperCase()}
                        </span>
                        <span className="lip-log-time">
                          {new Date(evt.timestamp).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </span>
                      </div>
                      <div className="lip-log-detail">{evt.detail}</div>
                    </div>
                  ))
                )}
              </div>

              <div className="lip-announcement-actions" style={{ justifyContent: 'space-between', marginTop: '12px' }}>
                {selectedStudentLogTarget.status !== 'submitted' && !selectedStudentLogTarget.autoSubmittedBySecurity ? (
                  <button
                    type="button"
                    className="lip-card-btn lip-card-btn--notice"
                    onClick={() => {
                      setDirectNoticeTargetKey(selectedStudentLogKey);
                      setDirectNoticeText('');
                      setDirectNoticeSent(false);
                    }}
                  >
                    💬 Send Direct Notice
                  </button>
                ) : (
                  <span />
                )}
                <button
                  type="button"
                  className="lip-btn-cancel"
                  onClick={() => setSelectedStudentLogKey(null)}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Direct Individual Candidate Notice ("Whisper") Modal */}
        {directNoticeTargetKey && students[directNoticeTargetKey] && (
          <div
            className="lip-announcement-dialog animate-fade-in"
            role="dialog"
            onClick={() => setDirectNoticeTargetKey(null)}
          >
            <div className="lip-announcement-card" onClick={(e) => e.stopPropagation()}>
              <h3>💬 Direct Notice: {students[directNoticeTargetKey].studentName}</h3>
              <p>
                Send a private banner message to{' '}
                <strong>{students[directNoticeTargetKey].studentName}</strong>
                {students[directNoticeTargetKey].candidateClass
                  ? ` (${students[directNoticeTargetKey].candidateClass})`
                  : ''}{' '}
                without interrupting other candidates.
              </p>
              <div className="lip-quick-templates">
                {[
                  'Please keep your eyes on your own screen.',
                  'Please re-enter fullscreen mode immediately.',
                  'Please raise your hand to speak with the invigilator.',
                ].map((tpl) => (
                  <button
                    key={tpl}
                    type="button"
                    className="lip-template-pill"
                    onClick={() => setDirectNoticeText(tpl)}
                  >
                    {tpl}
                  </button>
                ))}
              </div>
              <form onSubmit={handleSendDirectNotice}>
                <textarea
                  className="lip-announcement-textarea"
                  placeholder="Type a direct reminder for this candidate..."
                  rows={3}
                  value={directNoticeText}
                  onChange={(e) => setDirectNoticeText(e.target.value)}
                  autoFocus
                />
                <div className="lip-announcement-actions">
                  <button
                    type="button"
                    className="lip-btn-cancel"
                    onClick={() => setDirectNoticeTargetKey(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="lip-btn-send-announce"
                    disabled={!directNoticeText.trim()}
                  >
                    {directNoticeSent ? '✓ Notice Delivered!' : '💬 Send Direct Notice'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Broadcast Announcement Modal */}
        {showAnnouncementModal && (
          <div className="lip-announcement-dialog animate-fade-in" role="dialog">
            <div className="lip-announcement-card">
              <h3>📢 Broadcast Notice: {scopeLabel}</h3>
              <p>
                Send an urgent banner notice to candidate screens in <strong>{scopeLabel}</strong>.
                It will appear prominently across the top of their examination window in real time.
              </p>
              <form onSubmit={handleBroadcastAnnouncement}>
                <textarea
                  className="lip-announcement-textarea"
                  placeholder="e.g. Candidates: 15 minutes remaining. Please review Question 4 diagram note."
                  rows={3}
                  value={announcementText}
                  onChange={(e) => setAnnouncementText(e.target.value)}
                  autoFocus
                />
                <div className="lip-announcement-actions">
                  <button
                    type="button"
                    className="lip-btn-cancel"
                    onClick={() => setShowAnnouncementModal(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="lip-btn-send-announce"
                    disabled={!announcementText.trim()}
                  >
                    {announcementSuccess ? '✓ Broadcast Sent!' : `📢 Send to ${scopeLabel}`}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {/* Air-Gapped Emergency Offline Paper Batch Ingestion Modal */}
        {showEmergencyIngestModal && (
          <div
            className="lip-announcement-dialog animate-fade-in"
            role="dialog"
            onClick={() => setShowEmergencyIngestModal(false)}
          >
            <div
              className="lip-announcement-card"
              style={{ maxWidth: '640px', width: '100%' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <h3 style={{ margin: 0 }}>📥 Ingest Emergency Offline Papers (.exam)</h3>
                <button
                  type="button"
                  onClick={() => setShowEmergencyIngestModal(false)}
                  style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: '1.1rem', cursor: 'pointer' }}
                >
                  ✕
                </button>
              </div>
              <p style={{ marginBottom: '14px' }}>
                Drop one or multiple AES-256-GCM encrypted <code>.exam</code> files collected from candidates in{' '}
                <strong>{scopeLabel}</strong>. Ingested candidates immediately transition to <strong>SUBMITTED</strong> on the live roster.
              </p>

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setIsDragOverEmergency(true);
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setIsDragOverEmergency(false);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setIsDragOverEmergency(false);
                  if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    handleEmergencyFilesIngest(e.dataTransfer.files);
                  }
                }}
                style={{
                  border: isDragOverEmergency
                    ? '2px dashed #10b981'
                    : '2px dashed rgba(255, 255, 255, 0.25)',
                  borderRadius: '14px',
                  padding: '24px 18px',
                  textAlign: 'center',
                  marginBottom: '16px',
                  background: isDragOverEmergency
                    ? 'rgba(16, 185, 129, 0.1)'
                    : 'rgba(255, 255, 255, 0.03)',
                }}
              >
                <input
                  ref={emergencyFileInputRef}
                  type="file"
                  multiple
                  accept=".exam,.json"
                  onChange={(e) => {
                    if (e.target.files && e.target.files.length > 0) {
                      handleEmergencyFilesIngest(e.target.files);
                    }
                    e.target.value = '';
                  }}
                  style={{ display: 'none' }}
                />
                <div style={{ fontSize: '1.85rem', marginBottom: '6px' }}>
                  {isIngestingEmergency ? '⏳' : isDragOverEmergency ? '📂' : '🛡️'}
                </div>
                <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#f8fafc', marginBottom: '10px' }}>
                  {isIngestingEmergency
                    ? 'Decrypting & reconciling candidate papers...'
                    : 'Drag & drop .exam files here from USB drive'}
                </div>
                <button
                  type="button"
                  disabled={isIngestingEmergency}
                  onClick={() => emergencyFileInputRef.current?.click()}
                  style={{
                    background: '#10b981',
                    color: '#ffffff',
                    border: 'none',
                    padding: '9px 18px',
                    borderRadius: '8px',
                    fontWeight: 700,
                    fontSize: '0.84rem',
                    cursor: isIngestingEmergency ? 'not-allowed' : 'pointer',
                  }}
                >
                  📁 Select .exam Files (Batch Supported)
                </button>
              </div>

              {emergencyIngestionSummary && (
                <div
                  style={{
                    background: 'rgba(15, 23, 42, 0.75)',
                    border: '1px solid rgba(255, 255, 255, 0.12)',
                    borderRadius: '10px',
                    padding: '12px',
                    marginBottom: '14px',
                  }}
                >
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px', fontSize: '0.78rem', fontWeight: 700, marginBottom: '8px' }}>
                    <span style={{ color: '#94a3b8' }}>Total: {emergencyIngestionSummary.totalFiles}</span>
                    <span style={{ color: '#22c55e' }}>✅ New: {emergencyIngestionSummary.insertedCount}</span>
                    <span style={{ color: '#38bdf8' }}>🔄 Updated: {emergencyIngestionSummary.updatedCount}</span>
                    <span style={{ color: '#f59e0b' }}>⏭️ Skipped (Older): {emergencyIngestionSummary.skippedOlderCount}</span>
                    {emergencyIngestionSummary.failedCount > 0 && (
                      <span style={{ color: '#ef4444' }}>❌ Failed: {emergencyIngestionSummary.failedCount}</span>
                    )}
                  </div>
                  <div style={{ maxHeight: '160px', overflowY: 'auto', fontSize: '0.76rem' }}>
                    {emergencyIngestionSummary.results.map((r, idx) => (
                      <div
                        key={`${r.fileName}_${idx}`}
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          padding: '5px 4px',
                          borderBottom: '1px solid rgba(255, 255, 255, 0.06)',
                        }}
                      >
                        <span>
                          <strong>{r.studentName || r.fileName}</strong>
                          {r.candidateNumber ? ` (#${r.candidateNumber})` : ''}
                        </span>
                        <span>
                          {r.status === 'inserted' && <span style={{ color: '#22c55e' }}>✅ Submitted</span>}
                          {r.status === 'updated' && <span style={{ color: '#38bdf8' }}>🔄 Updated</span>}
                          {r.status === 'skipped_older' && <span style={{ color: '#f59e0b' }}>⏭️ Skipped (Older)</span>}
                          {r.status === 'failed' && <span style={{ color: '#ef4444' }}>❌ {r.error}</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="lip-announcement-actions">
                <button
                  type="button"
                  className="lip-btn-cancel"
                  onClick={() => setShowEmergencyIngestModal(false)}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default LiveInvigilatorModal;
