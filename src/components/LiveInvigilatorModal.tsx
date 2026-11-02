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
import { getSubmissionsForQuiz, loadAndSyncAllSubmissions } from '../services/quizSubmissionService';
import { getSchoolClasses } from '../lib/settings';
import './LiveInvigilatorModal.css';

export interface LiveInvigilatorModalProps {
  quizzes: PublishedQuiz[];
  initialFocusQuizCode?: string;
  onClose: () => void;
}

export type ProctorSortOption = 'class_seat' | 'status' | 'name' | 'progress' | 'time_left' | 'violations';

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
    'all' | 'exceeded' | 'locked' | 'warnings' | 'active' | 'submitted'
  >('all');
  const [sortBy, setSortBy] = useState<ProctorSortOption>('class_seat');
  const [searchQuery, setSearchQuery] = useState('');
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const pendingHeartbeatsRef = useRef<Record<string, ProctorStudentState>>({});
  const [showAnnouncementModal, setShowAnnouncementModal] = useState(false);
  const [announcementText, setAnnouncementText] = useState('');
  const [announcementSuccess, setAnnouncementSuccess] = useState(false);
  const [showLogDrawer, setShowLogDrawer] = useState(false);

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
      const maxV = getMaxViolations(s);
      return Boolean(s.exceededMaxViolations || (maxV > 0 && s.violationsCount >= maxV));
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
    if (monitoredQuizzes.length === 0) return;

    // A. Local submissions backfill
    try {
      const localLoaded: Record<string, ProctorStudentState> = {};
      monitoredQuizzes.forEach((quiz) => {
        const localSubs = getSubmissionsForQuiz(quiz.id, quiz.quizCode);
        if (localSubs && localSubs.length > 0) {
          localSubs.forEach((sub) => {
            const rawId = (sub.candidateNumber ? `${sub.studentName}_${sub.candidateNumber}` : sub.studentName) || sub.id;
            const qCode = (quiz.quizCode || '').trim().toUpperCase();
            const compositeKey = `${qCode}::${rawId}`;
            localLoaded[compositeKey] = {
              studentId: rawId,
              studentName: sub.studentName,
              candidateNumber: sub.candidateNumber,
              candidateClass: sub.studentClass,
              status: 'submitted',
              answeredCount: sub.questionResults?.length || quiz.questionCount,
              totalQuestions: quiz.questionCount,
              currentIndex: quiz.questionCount,
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
    } catch {}

    // B. Cloud submissions sync
    loadAndSyncAllSubmissions()
      .then((allSubs) => {
        const cloudLoaded: Record<string, ProctorStudentState> = {};
        monitoredQuizzes.forEach((quiz) => {
          const qCode = (quiz.quizCode || '').trim().toUpperCase();
          const quizSubs = allSubs.filter(
            (s) => s.quizId === quiz.id || s.quizCode.toUpperCase() === qCode
          );
          quizSubs.forEach((sub) => {
            const rawId = (sub.candidateNumber ? `${sub.studentName}_${sub.candidateNumber}` : sub.studentName) || sub.id;
            const compositeKey = `${qCode}::${rawId}`;
            cloudLoaded[compositeKey] = {
              studentId: rawId,
              studentName: sub.studentName,
              candidateNumber: sub.candidateNumber,
              candidateClass: sub.studentClass,
              status: 'submitted',
              answeredCount: sub.questionResults?.length || quiz.questionCount,
              totalQuestions: quiz.questionCount,
              currentIndex: quiz.questionCount,
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
              if (!next[compKey] || next[compKey].status !== 'submitted') {
                next[compKey] = row;
              }
            });
            return next;
          });
        }
      })
      .catch(() => {});
  }, [monitoredCodesKey, monitoredQuizzes]);

  // ─── 1B. Micro-Batch Heartbeats Flush (300ms window for high-volume 200+ concurrency) ─
  useEffect(() => {
    const timer = setInterval(() => {
      const pending = pendingHeartbeatsRef.current;
      const keys = Object.keys(pending);
      if (keys.length === 0) return;

      pendingHeartbeatsRef.current = {};
      setStudents((prev) => {
        let changed = false;
        const next = { ...prev };
        keys.forEach((compKey) => {
          const student = pending[compKey];
          const existing = next[compKey];
          if (existing?.status === 'submitted' && student.status !== 'submitted') {
            return;
          }
          next[compKey] = student;
          changed = true;
        });
        return changed ? next : prev;
      });
    }, 300);

    return () => clearInterval(timer);
  }, []);

  // ─── 2. Multi-Channel Real-time WebSockets Subscription ────────────────────
  useEffect(() => {
    const codes = monitoredQuizzes
      .map((q) => (q.quizCode || '').trim().toUpperCase())
      .filter(Boolean);

    if (codes.length === 0) return;

    const handleHeartbeat = (student: ProctorStudentState) => {
      const qCode = (student.quizCode || '').trim().toUpperCase();
      const compKey = `${qCode}::${student.studentId}`;

      pendingHeartbeatsRef.current[compKey] = {
        ...student,
        quizCode: qCode,
        quizTitle: student.quizTitle || quizByCode[qCode]?.title,
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
                studentName: student.studentName,
                candidateNumber: student.candidateNumber,
                quizCode: qCode,
                quizTitle: student.quizTitle || quizByCode[qCode]?.title,
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
          return merged.slice(0, 250);
        });
      }
    };

    const handleLogEvent = (event: ProctorLogEvent) => {
      const qCode = (event.quizCode || '').trim().toUpperCase();
      const enriched: ProctorLogEvent = {
        ...event,
        quizCode: qCode,
        quizTitle: event.quizTitle || quizByCode[qCode]?.title,
      };
      setLogEvents((prev) => [enriched, ...prev.slice(0, 249)]);
    };

    subscribeMultiProctorDashboard(codes, {
      onHeartbeat: handleHeartbeat,
      onLogEvent: handleLogEvent,
    });

    return () => {
      destroyProctorSession();
    };
  }, [monitoredCodesKey, monitoredQuizzes, quizByCode]);

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

  // ─── 3. Candidate Aggregations & Sidebar Navigation Models ─────────────────
  const allStudentList = useMemo(() => Object.values(students), [students]);

  // Filter students by monitored quizzes
  const activeMonitoredStudents = useMemo(() => {
    const allowed = new Set(
      monitoredQuizzes.map((q) => (q.quizCode || '').trim().toUpperCase())
    );
    return allStudentList.filter((s) => s.quizCode && allowed.has(s.quizCode.toUpperCase()));
  }, [allStudentList, monitoredQuizzes]);

  // Distinct Classes (School Config + Live Discovered)
  const sidebarClasses = useMemo(() => {
    const classesSet = new Set<string>(getSchoolClasses());
    activeMonitoredStudents.forEach((s) => {
      classesSet.add(getStudentClass(s));
    });

    let list = Array.from(classesSet).filter((c) => c !== 'Unassigned').sort();
    if (classesSet.has('Unassigned')) {
      list.push('Unassigned');
    }

    if (hideEmptyClasses) {
      list = list.filter((cls) =>
        activeMonitoredStudents.some((s) => getStudentClass(s) === cls)
      );
    }
    return list;
  }, [activeMonitoredStudents, hideEmptyClasses]);

  // Per-Class metrics
  const classStats = useMemo(() => {
    const map: Record<
      string,
      { total: number; locked: number; warnings: number; exceeded: number }
    > = {};
    sidebarClasses.forEach((c) => {
      map[c] = { total: 0, locked: 0, warnings: 0, exceeded: 0 };
    });

    activeMonitoredStudents.forEach((s) => {
      const cls = getStudentClass(s);
      if (!map[cls]) {
        map[cls] = { total: 0, locked: 0, warnings: 0, exceeded: 0 };
      }
      map[cls].total++;
      if (s.status === 'locked') map[cls].locked++;
      if (isStudentExceeded(s)) map[cls].exceeded++;
      if (s.status === 'warning' || s.multiMonitorDetected || s.violationsCount > 0) {
        map[cls].warnings++;
      }
    });

    return map;
  }, [sidebarClasses, activeMonitoredStudents, isStudentExceeded]);

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
  }, [scopeStudents, activeFilter, deferredSearchQuery, sortBy, isStudentExceeded]);

  // ─── 6. Command Handlers (Individual & Scoped Bulk) ─────────────────────────
  const handleRemoteUnlock = useCallback((compositeKey: string) => {
    const s = students[compositeKey];
    if (!s || !s.quizCode) return;

    delete pendingHeartbeatsRef.current[compositeKey];
    sendProctorCommand(s.quizCode, s.studentId, 'unlock');
    setStudents((prev) => {
      if (!prev[compositeKey]) return prev;
      return {
        ...prev,
        [compositeKey]: {
          ...prev[compositeKey],
          status: 'active',
          lockReason: undefined,
        },
      };
    });
    setLogEvents((prev) => [
      {
        id: `evt-${Date.now()}`,
        timestamp: new Date().toISOString(),
        studentName: s.studentName,
        quizCode: s.quizCode,
        type: 'unlocked',
        detail: `Remotely unlocked by invigilator`,
        severity: 'info',
      },
      ...prev,
    ]);
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
        studentName: s.studentName,
        quizCode: s.quizCode,
        type: 'time_extended',
        detail: `Added +${minutes} minutes to exam clock`,
        severity: 'info',
      },
      ...prev,
    ]);
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
    sendProctorCommand(s.quizCode, s.studentId, 'force_submit');
    setStudents((prev) => {
      if (!prev[compositeKey]) return prev;
      return {
        ...prev,
        [compositeKey]: {
          ...prev[compositeKey],
          status: 'submitted',
        },
      };
    });
    setLogEvents((prev) => [
      {
        id: `evt-${Date.now()}`,
        timestamp: new Date().toISOString(),
        studentName: s.studentName,
        quizCode: s.quizCode,
        type: 'submitted',
        detail: `Exam submission forced by invigilator`,
        severity: 'critical',
      },
      ...prev,
    ]);
  }, [students]);

  const handlePardon = useCallback((compositeKey: string) => {
    const s = students[compositeKey];
    if (!s || !s.quizCode) return;

    delete pendingHeartbeatsRef.current[compositeKey];
    sendProctorCommand(s.quizCode, s.studentId, 'pardon');
    setStudents((prev) => {
      if (!prev[compositeKey]) return prev;
      return {
        ...prev,
        [compositeKey]: {
          ...prev[compositeKey],
          status: 'active',
          violationsCount: 0,
          exceededMaxViolations: false,
          lockReason: undefined,
          lastViolation: undefined,
        },
      };
    });
    setLogEvents((prev) => [
      {
        id: `evt-${Date.now()}`,
        timestamp: new Date().toISOString(),
        studentName: s.studentName,
        quizCode: s.quizCode,
        type: 'pardon',
        detail: `Security violations cleared and candidate pardoned`,
        severity: 'info',
      },
      ...prev,
    ]);
  }, [students]);

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
    setStudents((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((k) => {
        if (lockedKeys.has(k)) {
          next[k] = { ...next[k], status: 'active', lockReason: undefined };
        }
      });
      return next;
    });

    setLogEvents((prev) => [
      {
        id: `evt-${Date.now()}`,
        timestamp: new Date().toISOString(),
        studentName: scopeLabel,
        type: 'unlocked',
        detail: `Unlocked ${lockedTargets.length} locked candidate(s)`,
        severity: 'info',
      },
      ...prev,
    ]);
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

      setLogEvents((prev) => [
        {
          id: `evt-${Date.now()}`,
          timestamp: new Date().toISOString(),
          studentName: scopeLabel,
          type: 'time_extended',
          detail: `Added +${minutes}m extra time to ${activeTargets.length} candidate(s)`,
          severity: 'info',
        },
        ...prev,
      ]);
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
            <button
              type="button"
              className={`lip-btn-log-toggle ${showLogDrawer ? 'lip-btn-log-toggle--active' : ''}`}
              onClick={() => setShowLogDrawer(!showLogDrawer)}
              title="Toggle Live Activity Log Stream"
            >
              📜 Audit Feed ({logEvents.length})
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

        {/* Global / Scoped Stats Metrics Bar */}
        <div className="lip-stats-bar">
          <div className="lip-stat-card">
            <span className="lip-stat-label">Total in Scope</span>
            <span className="lip-stat-val">{scopedStats.total}</span>
          </div>
          <div className="lip-stat-card lip-stat-card--active">
            <span className="lip-stat-label">🟢 Focused</span>
            <span className="lip-stat-val">{scopedStats.active}</span>
          </div>
          <div
            className={`lip-stat-card lip-stat-card--locked ${
              scopedStats.locked > 0 ? 'lip-stat-card--alert' : ''
            }`}
          >
            <span className="lip-stat-label">🚨 Locked by PIN</span>
            <span className="lip-stat-val">{scopedStats.locked}</span>
          </div>
          <div className="lip-stat-card lip-stat-card--warning">
            <span className="lip-stat-label">⚠️ Warnings</span>
            <span className="lip-stat-val">{scopedStats.warnings}</span>
          </div>
          {scopedStats.exceeded > 0 && (
            <div className="lip-stat-card lip-stat-card--locked" style={{ borderColor: '#ef4444' }}>
              <span className="lip-stat-label">🚨 Limit Exceeded</span>
              <span className="lip-stat-val" style={{ color: '#ef4444' }}>
                {scopedStats.exceeded}
              </span>
            </div>
          )}
          {scopedStats.multiMonitor > 0 && (
            <div className="lip-stat-card lip-stat-card--multimonitor">
              <span className="lip-stat-label">🟣 Multi-Screen</span>
              <span className="lip-stat-val">{scopedStats.multiMonitor}</span>
            </div>
          )}
          <div className="lip-stat-card lip-stat-card--submitted">
            <span className="lip-stat-label">⚪ Submitted</span>
            <span className="lip-stat-val">{scopedStats.submitted}</span>
          </div>
        </div>

        {/* ─── Split Screen Shell: Left Sidebar & Right Stage ──────────────── */}
        <div className="lip-shell">
          {/* Left Sidebar (Classes / Exams) */}
          <aside className="lip-sidebar" aria-label="Cohorts Navigation">
            <div className="lip-sidebar-switch">
              <button
                type="button"
                className={`lip-sidebar-switch-btn ${
                  sidebarMode === 'class' ? 'lip-sidebar-switch-btn--active' : ''
                }`}
                onClick={() => setSidebarMode('class')}
              >
                🏫 Classes
              </button>
              <button
                type="button"
                className={`lip-sidebar-switch-btn ${
                  sidebarMode === 'exam' ? 'lip-sidebar-switch-btn--active' : ''
                }`}
                onClick={() => setSidebarMode('exam')}
              >
                📝 Exams ({monitoredQuizzes.length})
              </button>
            </div>

            {/* Pinned 'All Candidates' Row */}
            <button
              type="button"
              className={`lip-sidebar-item lip-sidebar-item--all ${
                selectedKey === '__ALL__' ? 'lip-sidebar-item--active' : ''
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
                        <span className="lip-sidebar-count">{m.total}</span>
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
                    className={`lip-tab lip-tab-btn--exceeded ${
                      activeFilter === 'exceeded' ? 'lip-tab--active' : ''
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

              {/* Scoped Bulk Action Controls */}
              <div className="lip-cohort-actions">
                <button
                  type="button"
                  className="lip-btn-cohort lip-btn-announce"
                  onClick={() => setShowAnnouncementModal(true)}
                  title={`Broadcast an urgent banner notice to ${scopeLabel}`}
                >
                  📢 Notice to {scopeLabel}
                </button>
                {scopedStats.locked > 0 && (
                  <button
                    type="button"
                    className="lip-btn-cohort lip-btn-unlock-all"
                    onClick={handleScopedUnlock}
                    title={`Remotely unlock all ${scopedStats.locked} locked candidate(s) in ${scopeLabel}`}
                  >
                    🔓 Unlock {scopeLabel} ({scopedStats.locked})
                  </button>
                )}
                <button
                  type="button"
                  className="lip-btn-cohort lip-btn-add-all-time"
                  onClick={() => handleScopedAddTime(5)}
                  title={`Grant +5 minutes extra time to active candidates in ${scopeLabel}`}
                >
                  ⏱️ +5m {scopeLabel}
                </button>
              </div>
            </div>

            {/* Candidate Cards Grid & Activity Log Drawer */}
            <div className="lip-body">
              <div
                className={`lip-grid-container ${
                  showLogDrawer ? 'lip-grid-container--with-drawer' : ''
                }`}
              >
                {filteredStudents.length === 0 ? (
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
                ) : (
                  <div className="lip-students-grid">
                    {filteredStudents.map((s) => {
                      const qCode = (s.quizCode || '').trim().toUpperCase();
                      const compositeKey = `${qCode}::${s.studentId}`;
                      const progressPct =
                        s.totalQuestions > 0
                          ? Math.round((s.answeredCount / s.totalQuestions) * 100)
                          : 0;
                      const isLocked = s.status === 'locked';
                      const isExceeded = isStudentExceeded(s);
                      const maxV = getMaxViolations(s);

                      return (
                        <div
                          key={compositeKey}
                          className={`lip-student-card ${
                            isExceeded ? 'lip-student-card--exceeded' : ''
                          } ${isLocked ? 'lip-student-card--locked' : ''} ${
                            s.status === 'warning' ? 'lip-student-card--warning' : ''
                          }`}
                        >
                          {/* Card Header */}
                          <div className="lip-card-header">
                            <div className="lip-student-info">
                              <h4 className="lip-student-name" title={s.studentName}>
                                {s.studentName}
                              </h4>
                              <div className="lip-student-sub">
                                {s.candidateNumber && (
                                  <span className="lip-tag lip-tag-seat">
                                    Seat: {s.candidateNumber}
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
                              {isExceeded && (
                                <span
                                  className="lip-badge-exceeded-limit"
                                  title="Candidate exceeded allowed security notices"
                                >
                                  🚨 LIMIT EXCEEDED ({s.violationsCount}/{maxV || 'Max'})
                                </span>
                              )}
                              {getStatusBadge(s.status, s.multiMonitorDetected)}
                            </div>
                          </div>

                          {/* Lock Reason Banner */}
                          {isLocked && (
                            <div className="lip-card-lock-banner">
                              <span className="lip-lock-icon">🔒</span>
                              <span className="lip-lock-text">
                                {s.lockReason || 'Locked due to browser blur or security notice'}
                              </span>
                            </div>
                          )}

                          {/* Progress Bar & Clock */}
                          <div className="lip-card-progress-section">
                            <div className="lip-progress-labels">
                              <span>
                                Progress: <strong>{s.answeredCount}</strong> / {s.totalQuestions}{' '}
                                ({progressPct}%)
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

                          {/* Violations & Strikes Telemetry */}
                          <div className="lip-card-telemetry">
                            <div className="lip-telemetry-row">
                              <span className="lip-telemetry-label">Violations:</span>
                              <span
                                className={`lip-telemetry-val ${
                                  s.violationsCount > 0 ? 'lip-telemetry-val--violation' : ''
                                }`}
                                title={
                                  s.recentViolations && s.recentViolations.length > 0
                                    ? s.recentViolations
                                        .map(
                                          (v, i) =>
                                            `${i + 1}. [${new Date(v.timestamp).toLocaleTimeString(
                                              [],
                                              {
                                                hour: '2-digit',
                                                minute: '2-digit',
                                                second: '2-digit',
                                              }
                                            )}] ${v.detail}`
                                        )
                                        .join('\n')
                                    : s.lastViolation || undefined
                                }
                              >
                                {s.violationsCount} strike{s.violationsCount !== 1 ? 's' : ''}
                              </span>
                            </div>
                            {s.multiMonitorDetected && (
                              <div className="lip-telemetry-row lip-telemetry-row--multi">
                                <span>🖥️ Multi-display detected</span>
                              </div>
                            )}
                            {s.deviceOS && (
                              <div className="lip-telemetry-row lip-telemetry-row--device">
                                <span>📱 {s.deviceOS}</span>
                              </div>
                            )}
                          </div>

                          {/* Student Action Buttons */}
                          <div className="lip-card-actions">
                            {isLocked ? (
                              <button
                                type="button"
                                className="lip-card-btn lip-card-btn--unlock"
                                onClick={() => handleRemoteUnlock(compositeKey)}
                                title="Remotely clear lock screen and resume candidate examination"
                              >
                                🔓 Remote Unlock
                              </button>
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
                            {s.violationsCount > 0 && (
                              <button
                                type="button"
                                className="lip-card-btn lip-card-btn--pardon"
                                onClick={() => handlePardon(compositeKey)}
                                title="Pardon strikes and reset violation counters"
                              >
                                🛡️ Pardon
                              </button>
                            )}
                            {s.status !== 'submitted' && (
                              <button
                                type="button"
                                className="lip-card-btn lip-card-btn--force"
                                onClick={() => handleForceSubmit(compositeKey)}
                                title="Force submission of exam attempt"
                              >
                                🛑 Submit
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Right Side Live Activity Log Stream */}
              {showLogDrawer && (
                <div className="lip-log-drawer animate-slide-in-right">
                  <div className="lip-log-drawer-header">
                    <h3>📜 Live Activity Stream</h3>
                    <button
                      type="button"
                      className="lip-log-close"
                      onClick={() => setShowLogDrawer(false)}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="lip-log-events-list">
                    {logEvents.length === 0 ? (
                      <div className="lip-log-empty">No activity events logged yet.</div>
                    ) : (
                      logEvents.map((evt) => {
                        const timeStr = new Date(evt.timestamp).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                          second: '2-digit',
                        });
                        return (
                          <div
                            key={evt.id}
                            className={`lip-log-item lip-log-item--${evt.severity}`}
                          >
                            <div className="lip-log-top">
                              <span className="lip-log-name">
                                {isMultiExam && evt.quizCode ? `[${evt.quizCode}] ` : ''}
                                {evt.studentName}
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
      </div>
    </div>
  );
};

export default LiveInvigilatorModal;
