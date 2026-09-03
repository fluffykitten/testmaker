import React, { useState, useEffect, useMemo, useCallback } from 'react';
import type { PublishedQuiz } from '../services/quizManagerService';
import {
  subscribeProctorDashboard,
  sendProctorCommand,
  destroyProctorSession,
  type ProctorStudentState,
  type ProctorLogEvent,
  type StudentExamStatus,
} from '../services/examProctorRealtimeService';
import { getSubmissionsForQuiz, loadAndSyncAllSubmissions } from '../services/quizSubmissionService';
import './LiveInvigilatorModal.css';

export interface LiveInvigilatorModalProps {
  quiz: PublishedQuiz;
  onClose: () => void;
}

export type ProctorSortOption = 'class_seat' | 'status' | 'name' | 'progress' | 'time_left' | 'violations';

export const LiveInvigilatorModal: React.FC<LiveInvigilatorModalProps> = ({ quiz, onClose }) => {
  const [students, setStudents] = useState<Record<string, ProctorStudentState>>({});
  const [logEvents, setLogEvents] = useState<ProctorLogEvent[]>([]);
  const [activeFilter, setActiveFilter] = useState<'all' | 'locked' | 'warnings' | 'active' | 'submitted'>('all');
  const [activeClassFilter, setActiveClassFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<ProctorSortOption>('class_seat');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAnnouncementModal, setShowAnnouncementModal] = useState(false);
  const [announcementText, setAnnouncementText] = useState('');
  const [announcementSuccess, setAnnouncementSuccess] = useState(false);
  const [showLogDrawer, setShowLogDrawer] = useState(false);

  // ─── 1. Load Initial Submissions from DB & Submissions Store ────────────────
  useEffect(() => {
    // Check locally saved submissions for this quiz immediately
    try {
      const localSubs = getSubmissionsForQuiz(quiz.id);
      if (localSubs && localSubs.length > 0) {
        setStudents((prev) => {
          const next = { ...prev };
          localSubs.forEach((sub) => {
            const sId = (sub.candidateNumber ? `${sub.studentName}_${sub.candidateNumber}` : sub.studentName) || sub.id;
            if (!next[sId]) {
              next[sId] = {
                studentId: sId,
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
              };
            }
          });
          return next;
        });
      }
    } catch {}

    // Also sync latest submissions from cloud database
    loadAndSyncAllSubmissions().then((allSubs) => {
      const quizSubs = allSubs.filter(
        (s) => s.quizId === quiz.id || s.quizCode.toUpperCase() === quiz.quizCode.toUpperCase()
      );
      if (quizSubs.length > 0) {
        setStudents((prev) => {
          const next = { ...prev };
          quizSubs.forEach((sub) => {
            const sId = (sub.candidateNumber ? `${sub.studentName}_${sub.candidateNumber}` : sub.studentName) || sub.id;
            if (!next[sId] || next[sId].status !== 'submitted') {
              next[sId] = {
                studentId: sId,
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
              };
            }
          });
          return next;
        });
      }
    }).catch(() => {});
  }, [quiz.id, quiz.quizCode, quiz.questionCount]);

  // ─── 2. Realtime WebSockets Subscription ───────────────────────────────────
  useEffect(() => {
    const handleHeartbeat = (student: ProctorStudentState) => {
      setStudents((prev) => {
        const existing = prev[student.studentId];
        // If candidate already reported submitted or was force submitted, keep submitted
        if (existing?.status === 'submitted' && student.status !== 'submitted') {
          return prev;
        }
        return {
          ...prev,
          [student.studentId]: student,
        };
      });
    };

    const handleLogEvent = (event: ProctorLogEvent) => {
      setLogEvents((prev) => [event, ...prev.slice(0, 199)]); // Keep last 200 events
    };

    subscribeProctorDashboard(quiz.quizCode, {
      onHeartbeat: handleHeartbeat,
      onLogEvent: handleLogEvent,
    });

    return () => {
      destroyProctorSession();
    };
  }, [quiz.quizCode]);

  // Periodic offline sweep (if no heartbeat for 45s, flag as offline if not submitted)
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

  // ─── 3. Metric Counts & Available Classes ──────────────────────────────────
  const studentList = useMemo(() => Object.values(students), [students]);

  const availableClasses = useMemo(() => {
    const set = new Set<string>();
    studentList.forEach((s) => {
      if (s.candidateClass && s.candidateClass.trim()) {
        set.add(s.candidateClass.trim());
      }
    });
    return Array.from(set).sort();
  }, [studentList]);

  const stats = useMemo(() => {
    let active = 0;
    let locked = 0;
    let warnings = 0;
    let multiMonitor = 0;
    let submitted = 0;
    let offline = 0;

    studentList.forEach((s) => {
      if (s.status === 'locked') locked++;
      else if (s.status === 'warning') warnings++;
      else if (s.status === 'active') active++;
      else if (s.status === 'submitted') submitted++;
      else if (s.status === 'offline') offline++;

      if (s.multiMonitorDetected) multiMonitor++;
    });

    return {
      total: studentList.length,
      active,
      locked,
      warnings,
      multiMonitor,
      submitted,
      offline,
    };
  }, [studentList]);

  // ─── 4. Filtered & Sorted Students ─────────────────────────────────────────
  const filteredStudents = useMemo(() => {
    const list = studentList.filter((s) => {
      // Filter by Status Tab
      if (activeFilter === 'locked' && s.status !== 'locked') return false;
      if (activeFilter === 'warnings' && s.status !== 'warning' && !s.multiMonitorDetected && s.violationsCount === 0) return false;
      if (activeFilter === 'active' && s.status !== 'active') return false;
      if (activeFilter === 'submitted' && s.status !== 'submitted') return false;

      // Filter by Class Dropdown
      if (activeClassFilter !== 'all' && (s.candidateClass || '').trim() !== activeClassFilter) {
        return false;
      }

      // Filter by search
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchName = s.studentName.toLowerCase().includes(q);
        const matchNum = (s.candidateNumber || '').toLowerCase().includes(q);
        const matchClass = (s.candidateClass || '').toLowerCase().includes(q);
        if (!matchName && !matchNum && !matchClass) return false;
      }

      return true;
    });

    // Sort students
    return [...list].sort((a, b) => {
      if (sortBy === 'class_seat') {
        const classComp = (a.candidateClass || '').localeCompare(b.candidateClass || '');
        if (classComp !== 0) return classComp;
        // natural numeric sort for seat / candidate number
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
        const pctA = a.totalQuestions > 0 ? (a.answeredCount / a.totalQuestions) : 0;
        const pctB = b.totalQuestions > 0 ? (b.answeredCount / b.totalQuestions) : 0;
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
  }, [studentList, activeFilter, activeClassFilter, searchQuery, sortBy]);

  // ─── 4. Invigilator Command Actions ────────────────────────────────────────
  const handleRemoteUnlock = useCallback((studentId: string, name: string) => {
    sendProctorCommand(studentId, 'unlock');
    setStudents((prev) => {
      if (!prev[studentId]) return prev;
      return {
        ...prev,
        [studentId]: {
          ...prev[studentId],
          status: 'active',
          lockReason: undefined,
        },
      };
    });
    setLogEvents((prev) => [
      {
        id: `evt-${Date.now()}`,
        timestamp: new Date().toISOString(),
        studentName: name,
        type: 'unlocked',
        detail: `Remotely unlocked by invigilator`,
        severity: 'info',
      },
      ...prev,
    ]);
  }, []);

  const handleUnlockAll = useCallback(() => {
    sendProctorCommand('ALL', 'unlock');
    setStudents((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((id) => {
        if (next[id].status === 'locked') {
          next[id] = { ...next[id], status: 'active', lockReason: undefined };
        }
      });
      return next;
    });
    setLogEvents((prev) => [
      {
        id: `evt-${Date.now()}`,
        timestamp: new Date().toISOString(),
        studentName: 'ALL CANDIDATES',
        type: 'unlocked',
        detail: `All locked students unlocked by invigilator`,
        severity: 'info',
      },
      ...prev,
    ]);
  }, []);

  const handleAddTime = useCallback((studentId: string | 'ALL', minutes: number, studentName?: string) => {
    sendProctorCommand(studentId, 'add_time', { minutes });
    setStudents((prev) => {
      const next = { ...prev };
      if (studentId === 'ALL') {
        Object.keys(next).forEach((id) => {
          next[id] = {
            ...next[id],
            timeLeftSeconds: next[id].timeLeftSeconds + minutes * 60,
          };
        });
      } else if (next[studentId]) {
        next[studentId] = {
          ...next[studentId],
          timeLeftSeconds: next[studentId].timeLeftSeconds + minutes * 60,
        };
      }
      return next;
    });
    setLogEvents((prev) => [
      {
        id: `evt-${Date.now()}`,
        timestamp: new Date().toISOString(),
        studentName: studentId === 'ALL' ? 'ALL CANDIDATES' : studentName || 'Candidate',
        type: 'time_extended',
        detail: `Added +${minutes} minutes to exam clock`,
        severity: 'info',
      },
      ...prev,
    ]);
  }, []);

  const handleForceSubmit = useCallback((studentId: string, name: string) => {
    if (!window.confirm(`Are you sure you want to force submit ${name}'s examination? This action will finalize their attempt immediately.`)) {
      return;
    }
    sendProctorCommand(studentId, 'force_submit');
    setStudents((prev) => {
      if (!prev[studentId]) return prev;
      return {
        ...prev,
        [studentId]: {
          ...prev[studentId],
          status: 'submitted',
        },
      };
    });
    setLogEvents((prev) => [
      {
        id: `evt-${Date.now()}`,
        timestamp: new Date().toISOString(),
        studentName: name,
        type: 'submitted',
        detail: `Exam submission forced by invigilator`,
        severity: 'critical',
      },
      ...prev,
    ]);
  }, []);

  const handleBroadcastAnnouncement = (e: React.FormEvent) => {
    e.preventDefault();
    if (!announcementText.trim()) return;

    sendProctorCommand('ALL', 'announcement', { message: announcementText.trim() });
    setLogEvents((prev) => [
      {
        id: `evt-${Date.now()}`,
        timestamp: new Date().toISOString(),
        studentName: 'ALL CANDIDATES',
        type: 'announcement',
        detail: `Announcement broadcast: "${announcementText.trim()}"`,
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
        {/* Top Header */}
        <div className="lip-header">
          <div className="lip-header-title-wrap">
            <div className="lip-live-indicator">
              <span className="lip-pulse-dot" />
              <span className="lip-live-text">LIVE COCKPIT</span>
            </div>
            <div>
              <h2 className="lip-title">
                🛡️ Live Invigilation & Proctoring:{' '}
                <span className="lip-quiz-name">{quiz.title}</span>
              </h2>
              <div className="lip-subtitle">
                <span>Quiz Code: <strong>{quiz.quizCode}</strong></span>
                <span>•</span>
                <span>PIN: <strong>{quiz.teacherPin || '1234'}</strong></span>
                <span>•</span>
                <span>Duration: <strong>{quiz.durationMinutes} mins</strong></span>
                <span>•</span>
                <span>Total Questions: <strong>{quiz.questionCount}</strong></span>
              </div>
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
        </div>

        {/* Stats Metrics Bar */}
        <div className="lip-stats-bar">
          <div className="lip-stat-card">
            <span className="lip-stat-label">Total Connected</span>
            <span className="lip-stat-val">{stats.total}</span>
          </div>
          <div className="lip-stat-card lip-stat-card--active">
            <span className="lip-stat-label">🟢 Focused</span>
            <span className="lip-stat-val">{stats.active}</span>
          </div>
          <div className={`lip-stat-card lip-stat-card--locked ${stats.locked > 0 ? 'lip-stat-card--alert' : ''}`}>
            <span className="lip-stat-label">🚨 Locked by PIN</span>
            <span className="lip-stat-val">{stats.locked}</span>
          </div>
          <div className="lip-stat-card lip-stat-card--warning">
            <span className="lip-stat-label">⚠️ Warnings</span>
            <span className="lip-stat-val">{stats.warnings}</span>
          </div>
          {stats.multiMonitor > 0 && (
            <div className="lip-stat-card lip-stat-card--multimonitor">
              <span className="lip-stat-label">🟣 Multi-Screen</span>
              <span className="lip-stat-val">{stats.multiMonitor}</span>
            </div>
          )}
          <div className="lip-stat-card lip-stat-card--submitted">
            <span className="lip-stat-label">⚪ Submitted</span>
            <span className="lip-stat-val">{stats.submitted}</span>
          </div>
        </div>

        {/* Action Controls & Filters Bar */}
        <div className="lip-toolbar">
          <div className="lip-filter-tabs">
            <button
              type="button"
              className={`lip-tab ${activeFilter === 'all' ? 'lip-tab--active' : ''}`}
              onClick={() => setActiveFilter('all')}
            >
              All ({studentList.length})
            </button>
            <button
              type="button"
              className={`lip-tab ${activeFilter === 'locked' ? 'lip-tab--active' : ''}`}
              onClick={() => setActiveFilter('locked')}
            >
              🚨 Locked ({stats.locked})
            </button>
            <button
              type="button"
              className={`lip-tab ${activeFilter === 'warnings' ? 'lip-tab--active' : ''}`}
              onClick={() => setActiveFilter('warnings')}
            >
              ⚠️ Warnings ({stats.warnings + stats.multiMonitor})
            </button>
            <button
              type="button"
              className={`lip-tab ${activeFilter === 'active' ? 'lip-tab--active' : ''}`}
              onClick={() => setActiveFilter('active')}
            >
              🟢 Active ({stats.active})
            </button>
            <button
              type="button"
              className={`lip-tab ${activeFilter === 'submitted' ? 'lip-tab--active' : ''}`}
              onClick={() => setActiveFilter('submitted')}
            >
              ⚪ Submitted ({stats.submitted})
            </button>
          </div>

          <div className="lip-filter-dropdowns">
            {/* Class / Cohort Filter */}
            <div className="lip-select-wrap">
              <span className="lip-select-icon">🏫</span>
              <select
                className="lip-select"
                value={activeClassFilter}
                onChange={(e) => setActiveClassFilter(e.target.value)}
                aria-label="Filter by class"
                title="Filter by School Class / Cohort"
              >
                <option value="all">All Classes ({studentList.length})</option>
                {availableClasses.map((cls) => {
                  const count = studentList.filter((s) => (s.candidateClass || '').trim() === cls).length;
                  return (
                    <option key={cls} value={cls}>
                      {cls} ({count})
                    </option>
                  );
                })}
              </select>
            </div>

            {/* Sort Dropdown */}
            <div className="lip-select-wrap">
              <span className="lip-select-icon">⇅</span>
              <select
                className="lip-select"
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as ProctorSortOption)}
                aria-label="Sort candidates"
                title="Sort Candidate Cards"
              >
                <option value="class_seat">Class & Seat No.</option>
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
              placeholder="🔍 Search candidate name, seat, or class..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="lip-cohort-actions">
            <button
              type="button"
              className="lip-btn-cohort lip-btn-announce"
              onClick={() => setShowAnnouncementModal(true)}
              title="Broadcast an urgent notice or banner to all candidate screens"
            >
              📢 Broadcast Notice
            </button>
            {stats.locked > 0 && (
              <button
                type="button"
                className="lip-btn-cohort lip-btn-unlock-all"
                onClick={handleUnlockAll}
                title="Unlock all students currently waiting for teacher PIN"
              >
                🔓 Unlock All ({stats.locked})
              </button>
            )}
            <button
              type="button"
              className="lip-btn-cohort lip-btn-add-all-time"
              onClick={() => handleAddTime('ALL', 5)}
              title="Grant +5 minutes extra time to all active candidates"
            >
              ⏱️ +5m All
            </button>
          </div>
        </div>

        {/* Main Grid View Area */}
        <div className="lip-body">
          <div className={`lip-grid-container ${showLogDrawer ? 'lip-grid-container--with-drawer' : ''}`}>
            {filteredStudents.length === 0 ? (
              <div className="lip-empty-state">
                {studentList.length === 0 ? (
                  <>
                    <span className="lip-empty-icon">📡</span>
                    <h3>Waiting for Candidates to Connect</h3>
                    <p>
                      Share Quiz Code <strong>{quiz.quizCode}</strong> with your students.
                      As soon as they begin, their live focus, timer, and progress will appear here in real time.
                    </p>
                  </>
                ) : (
                  <>
                    <span className="lip-empty-icon">🔍</span>
                    <h3>No candidates match the current filter</h3>
                    <button
                      type="button"
                      className="lip-btn-clear-filter"
                      onClick={() => {
                        setActiveFilter('all');
                        setActiveClassFilter('all');
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
                  const progressPct =
                    s.totalQuestions > 0 ? Math.round((s.answeredCount / s.totalQuestions) * 100) : 0;
                  const isLocked = s.status === 'locked';

                  return (
                    <div
                      key={s.studentId}
                      className={`lip-student-card ${isLocked ? 'lip-student-card--locked' : ''} ${s.status === 'warning' ? 'lip-student-card--warning' : ''}`}
                    >
                      {/* Card Header */}
                      <div className="lip-card-header">
                        <div className="lip-student-info">
                          <h4 className="lip-student-name" title={s.studentName}>
                            {s.studentName}
                          </h4>
                          <div className="lip-student-sub">
                            {s.candidateNumber && (
                              <span className="lip-tag lip-tag-seat">Seat: {s.candidateNumber}</span>
                            )}
                            {s.candidateClass && (
                              <span className="lip-tag lip-tag-class">{s.candidateClass}</span>
                            )}
                          </div>
                        </div>
                        <div className="lip-card-badge-wrap">
                          {getStatusBadge(s.status, s.multiMonitorDetected)}
                        </div>
                      </div>

                      {/* Lock Reason Banner */}
                      {isLocked && (
                        <div className="lip-card-lock-banner">
                          <span className="lip-lock-icon">🔒</span>
                          <span className="lip-lock-text">
                            {s.lockReason || 'Locked due to browser blur / Alt+Tab violation'}
                          </span>
                        </div>
                      )}

                      {/* Progress Bar & Clock */}
                      <div className="lip-card-progress-section">
                        <div className="lip-progress-labels">
                          <span>
                            Progress: <strong>{s.answeredCount}</strong> / {s.totalQuestions} ({progressPct}%)
                          </span>
                          <span className="lip-clock-val">⏱️ {formatClock(s.timeLeftSeconds)}</span>
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

                      {/* Violations and Strikes */}
                      <div className="lip-card-telemetry">
                        <div className="lip-telemetry-row">
                          <span className="lip-telemetry-label">Violations:</span>
                          <span
                            className={`lip-telemetry-val ${s.violationsCount > 0 ? 'lip-telemetry-val--violation' : ''}`}
                          >
                            {s.violationsCount} strikes
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
                            onClick={() => handleRemoteUnlock(s.studentId, s.studentName)}
                            title="Remotely clear lock screen and resume candidate examination"
                          >
                            🔓 Remote Unlock
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="lip-card-btn lip-card-btn--time"
                            onClick={() => handleAddTime(s.studentId, 5, s.studentName)}
                            title="Add +5 minutes accommodation to candidate"
                          >
                            ⏱️ +5m
                          </button>
                        )}
                        {s.status !== 'submitted' && (
                          <button
                            type="button"
                            className="lip-card-btn lip-card-btn--force"
                            onClick={() => handleForceSubmit(s.studentId, s.studentName)}
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
                      <div key={evt.id} className={`lip-log-item lip-log-item--${evt.severity}`}>
                        <div className="lip-log-top">
                          <span className="lip-log-name">{evt.studentName}</span>
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

        {/* Broadcast Announcement Modal */}
        {showAnnouncementModal && (
          <div className="lip-announcement-dialog animate-fade-in" role="dialog">
            <div className="lip-announcement-card">
              <h3>📢 Broadcast Invigilator Notice</h3>
              <p>
                Send an urgent banner notice to all candidate screens in real time. It will appear
                prominently across the top of their examination window.
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
                    {announcementSuccess ? '✓ Broadcast Sent!' : '📢 Send to All Candidates'}
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
