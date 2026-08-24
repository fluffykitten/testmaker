import { useState, useEffect, useRef, useCallback } from 'react';
import type { Question } from '../types/database';
import type { ExamHeaderConfig } from '../services/testBuilderService';
import { resolveStudentQuiz } from '../services/quizCodeService';
import {
  saveQuizSubmission,
  type StudentSubmission,
  type QuestionSubmissionResult,
} from '../services/quizSubmissionService';
import { ExamMathText } from '../components/ExamMathText';
import './StudentQuizRunner.css';

interface StudentQuizRunnerProps {
  testIdOrCode?: string;
  initialQuestions?: Question[];
  initialHeaderConfig?: ExamHeaderConfig;
  onExit?: () => void;
}

interface ViolationRecord {
  type: 'tab_switch' | 'fullscreen_exit' | 'blocked_shortcut' | 'window_blur';
  timestamp: string;
  detail: string;
}

export function StudentQuizRunner({
  testIdOrCode,
  initialQuestions,
  initialHeaderConfig,
  onExit,
}: StudentQuizRunnerProps) {
  // Test Data State
  const [loading, setLoading] = useState(!initialQuestions);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(initialHeaderConfig?.title || 'Interactive Examination');
  const [headerConfig, setHeaderConfig] = useState<ExamHeaderConfig | undefined>(initialHeaderConfig);
  const [questions, setQuestions] = useState<Question[]>(initialQuestions || []);

  // Candidate Info
  const [candidateName, setCandidateName] = useState(() => `Candidate ${Math.floor(1000 + Math.random() * 9000)}`);
  const [startTime, setStartTime] = useState<number>(Date.now());

  // Exam Progress State
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string | number>>({});
  const [flaggedIndices, setFlaggedIndices] = useState<Set<number>>(new Set());
  const [isExamMode, setIsExamMode] = useState(true); // true = Strict Timed Exam, false = Practice Mode
  const [hasStarted, setHasStarted] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [timeLeft, setTimeLeft] = useState(45 * 60);

  // 🔒 Security & Anti-Cheating State
  const [securityEnabled, setSecurityEnabled] = useState(true);
  const [violations, setViolations] = useState<ViolationRecord[]>([]);
  const [securityAlert, setSecurityAlert] = useState<string | null>(null);

  // Diagram Zoom
  const [zoomedImage, setZoomedImage] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  // ─── 1. Load Quiz by Code or ID ─────────────────────────────────────────────
  useEffect(() => {
    if (initialQuestions && initialQuestions.length > 0) {
      setQuestions(initialQuestions);
      if (initialHeaderConfig?.durationMinutes) {
        setTimeLeft(initialHeaderConfig.durationMinutes * 60);
      }
      setLoading(false);
      return;
    }

    if (!testIdOrCode) {
      setError('No Quiz Code or Test ID provided.');
      setLoading(false);
      return;
    }

    async function load() {
      setLoading(true);
      try {
        const data = await resolveStudentQuiz(testIdOrCode!);
        if (!data || data.questions.length === 0) {
          setError(`Quiz "${testIdOrCode}" not found. Please check your quiz code with your teacher.`);
        } else {
          setTitle(data.title);
          setHeaderConfig(data.headerConfig);
          setQuestions(data.questions);
          if (data.durationMinutes) {
            setTimeLeft(data.durationMinutes * 60);
          } else if (data.headerConfig?.durationMinutes) {
            setTimeLeft(data.headerConfig.durationMinutes * 60);
          }
          if (data.isExamMode !== undefined) {
            setIsExamMode(data.isExamMode);
          }
          if (data.securityEnabled !== undefined) {
            setSecurityEnabled(data.securityEnabled);
          }
        }
      } catch (err: any) {
        setError(`Failed to load quiz: ${err?.message || 'Network error'}`);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [testIdOrCode, initialQuestions, initialHeaderConfig]);

  // ─── 2. Violation Logger ───────────────────────────────────────────────────
  const logViolation = useCallback(
    (type: ViolationRecord['type'], detail: string) => {
      if (!hasStarted || isSubmitted || !securityEnabled) return;
      const now = new Date().toLocaleTimeString();
      const rec: ViolationRecord = { type, timestamp: now, detail };
      setViolations((prev) => [...prev, rec]);
      setSecurityAlert(`⚠️ SECURITY VIOLATION: ${detail} (Recorded at ${now})`);
    },
    [hasStarted, isSubmitted, securityEnabled]
  );

  // ─── 3. Anti-Cheating Event Listeners ──────────────────────────────────────
  useEffect(() => {
    if (!hasStarted || isSubmitted || !securityEnabled) return;

    // A. Tab switch / Visibility change
    const handleVisibilityChange = () => {
      if (document.hidden) {
        logViolation('tab_switch', 'Switched away from exam tab or minimized window');
      }
    };

    // B. Window Blur (e.g. Alt+Tab or clicking outside)
    const handleWindowBlur = () => {
      logViolation('window_blur', 'Exam window lost focus (Alt+Tab / App switch)');
    };

    // C. Fullscreen change
    const handleFullscreenChange = () => {
      const isFull = !!document.fullscreenElement;
      if (!isFull && hasStarted && !isSubmitted) {
        logViolation('fullscreen_exit', 'Exited fullscreen secure exam view');
      }
    };

    // D. Keyboard Shortcut Trapping
    const handleKeyDown = (e: KeyboardEvent) => {
      // Block F12 (DevTools)
      if (e.key === 'F12') {
        e.preventDefault();
        logViolation('blocked_shortcut', 'Attempted to open Developer Tools (F12)');
      }
      // Block Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+Shift+C
      if (e.ctrlKey && e.shiftKey && (e.key === 'I' || e.key === 'i' || e.key === 'J' || e.key === 'j' || e.key === 'C' || e.key === 'c')) {
        e.preventDefault();
        logViolation('blocked_shortcut', 'Attempted to inspect page elements');
      }
      // Block Ctrl+P (Print), Ctrl+S (Save), Ctrl+U (View source)
      if (e.ctrlKey && (e.key === 'p' || e.key === 'P' || e.key === 's' || e.key === 'S' || e.key === 'u' || e.key === 'U')) {
        e.preventDefault();
        logViolation('blocked_shortcut', `Attempted browser action (Ctrl+${e.key.toUpperCase()})`);
      }
      // Block Ctrl+C (Copy), Ctrl+V (Paste) in Exam Mode
      if (isExamMode && e.ctrlKey && (e.key === 'c' || e.key === 'C' || e.key === 'v' || e.key === 'V')) {
        e.preventDefault();
        logViolation('blocked_shortcut', 'Copying and pasting is disabled during exam');
      }
    };

    // E. Prevent accidental unload/reload
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = 'You have an active exam in progress. Are you sure you want to leave?';
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('blur', handleWindowBlur);
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('blur', handleWindowBlur);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [hasStarted, isSubmitted, securityEnabled, isExamMode, logViolation]);

  // ─── 4. Submit Handler ───────────────────────────────────────────────────
  const handleSubmitExam = useCallback(() => {
    if (!isSubmitted) {
      setIsSubmitted(true);
      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }

      // Calculate Submission Details & Save to Service
      try {
        const durationSec = Math.max(1, Math.round((Date.now() - startTime) / 1000));
        const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0);
        let earnedMarks = 0;
        const qResults: QuestionSubmissionResult[] = [];
        const topicBreakdown: Record<string, { totalMarks: number; earnedMarks: number; percentage: number }> = {};

        questions.forEach((q, idx) => {
          const top = q.topic || 'General';
          if (!topicBreakdown[top]) topicBreakdown[top] = { totalMarks: 0, earnedMarks: 0, percentage: 0 };
          const qMarks = q.marks || 1;
          topicBreakdown[top].totalMarks += qMarks;

          let isCorrect = false;
          let qEarned = 0;
          const userAns = answers[idx];

          if (q.options && q.options.length > 0) {
            const correctIdx = (q as any).correct_option !== undefined ? (q as any).correct_option : 0;
            if (userAns !== undefined && userAns === correctIdx) {
              isCorrect = true;
              qEarned = qMarks;
            }
          } else if (userAns && String(userAns).trim().length > 0) {
            isCorrect = true;
            qEarned = qMarks;
          }

          earnedMarks += qEarned;
          topicBreakdown[top].earnedMarks += qEarned;

          qResults.push({
            questionId: q.id,
            questionNumber: idx + 1,
            topic: top,
            maxMarks: qMarks,
            earnedMarks: qEarned,
            isCorrect,
            studentAnswer: userAns !== undefined ? userAns : '',
            correctAnswer: typeof q.mark_scheme === 'string'
              ? q.mark_scheme
              : typeof q.mark_scheme === 'object' && q.mark_scheme !== null
              ? (q.mark_scheme as any).answer_text || (q.mark_scheme as any).steps?.join('; ') || ''
              : (q.options ? q.options[0] : undefined),
            misconceptions: (q as any).metadata?.misconceptions || (q as any).misconceptions || [],
          });
        });

        Object.keys(topicBreakdown).forEach((top) => {
          const item = topicBreakdown[top];
          item.percentage = item.totalMarks > 0 ? (item.earnedMarks / item.totalMarks) * 100 : 0;
        });

        const submission: StudentSubmission = {
          id: `sub_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          quizId: testIdOrCode || 'direct_quiz',
          quizCode: testIdOrCode || 'EXAM',
          quizTitle: title,
          subject: headerConfig?.subject || 'Chemistry',
          studentName: candidateName.trim() || 'Candidate',
          submittedAt: new Date().toISOString(),
          durationSeconds: durationSec,
          score: earnedMarks,
          totalMarks,
          percentage: totalMarks > 0 ? (earnedMarks / totalMarks) * 100 : 100,
          violationsCount: violations.length,
          proctoringLogs: violations.map((v, i) => ({
            timestamp: v.timestamp,
            event: v.detail,
            strike: i + 1,
            severity: v.type === 'blocked_shortcut' ? 'critical' : 'warning',
          })),
          questionResults: qResults,
          topicBreakdown,
        };

        saveQuizSubmission(submission);
      } catch (err) {
        console.error('Failed to save student submission:', err);
      }
    }
  }, [isSubmitted, startTime, questions, answers, testIdOrCode, title, headerConfig, candidateName, violations]);

  // ─── 5. Countdown Timer ───────────────────────────────────────────────────
  useEffect(() => {
    if (!hasStarted || isSubmitted || !isExamMode) return;
    if (timeLeft <= 0) {
      handleSubmitExam();
      return;
    }

    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          handleSubmitExam();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [hasStarted, isSubmitted, isExamMode, timeLeft, handleSubmitExam]);

  // ─── 6. Start Exam & Enter Fullscreen ──────────────────────────────────────
  const handleStartExam = async () => {
    setStartTime(Date.now());
    if (securityEnabled && containerRef.current) {
      try {
        if (document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        }
      } catch (err) {
        console.warn('Fullscreen request blocked:', err);
      }
    }
    setHasStarted(true);
  };

  // ─── 7. Question Navigation & Answers ──────────────────────────────────────
  const currentQuestion = questions[currentIndex];
  const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0);

  const handleSelectOption = (optionIndex: number) => {
    if (isSubmitted) return;
    setAnswers((prev) => ({ ...prev, [currentIndex]: optionIndex }));
  };

  const handleTextAnswerChange = (val: string) => {
    if (isSubmitted) return;
    setAnswers((prev) => ({ ...prev, [currentIndex]: val }));
  };

  const handleToggleFlag = () => {
    setFlaggedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(currentIndex)) next.delete(currentIndex);
      else next.add(currentIndex);
      return next;
    });
  };

  // ─── 7. Scoring & Analytics ────────────────────────────────────────────────
  const calculateResults = () => {
    let mcqEarned = 0;
    let mcqTotal = 0;
    const topicStats: Record<string, { earned: number; total: number }> = {};

    questions.forEach((q, idx) => {
      const topic = q.topic || 'General';
      if (!topicStats[topic]) topicStats[topic] = { earned: 0, total: 0 };
      topicStats[topic].total += q.marks || 1;

      if (q.options && q.options.length > 0) {
        mcqTotal += q.marks || 1;
        // In practice/exam, answer is recorded
        if (answers[idx] !== undefined) {
          // Assume option selected gets marks in student practice review
          mcqEarned += q.marks || 1;
          topicStats[topic].earned += q.marks || 1;
        }
      }
    });

    const percentage = mcqTotal > 0 ? Math.round((mcqEarned / mcqTotal) * 100) : 100;
    return { mcqEarned, mcqTotal, percentage, topicStats };
  };

  // ─── Clean MCQ Option Text & Stem ─────────────────────────────────────────
  const cleanOptionText = (text: string, oIdx: number) => {
    if (!text) return '';
    const letter = String.fromCharCode(65 + oIdx);
    return text
      .replace(new RegExp(`^\\s*(\\(${letter}\\)|${letter}[\\.\\)\\:\\s\\-]+)\\s*`, 'i'), '')
      .trim();
  };

  const cleanQuestionStem = (stem: string, options?: string[] | null) => {
    if (!stem || !options || options.length === 0) return stem;
    const lines = stem.split('\n');
    const optStartIdx = lines.findIndex((l) => /^\s*A[.)\s:-]/.test(l));
    if (optStartIdx > 0 && lines.length - optStartIdx <= 6) {
      const remaining = lines.slice(optStartIdx).join('\n');
      if (/\bB[.)\s:-]/.test(remaining) && /\bC[.)\s:-]/.test(remaining)) {
        return lines.slice(0, optStartIdx).join('\n').trim();
      }
    }
    return stem;
  };

  // Format mm:ss
  const formatTimer = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
  };

  // ─── Loading / Error Screens ──────────────────────────────────────────────
  if (loading) {
    return (
      <div className="student-quiz-loading-screen">
        <div className="student-quiz-spinner" />
        <h2>Loading Assessment…</h2>
        <p>Fetching questions and formulas</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="student-quiz-error-screen">
        <div className="error-icon">⚠️</div>
        <h2>Assessment Unavailable</h2>
        <p>{error}</p>
        {onExit && (
          <button className="sq-btn sq-btn-primary" onClick={onExit} style={{ marginTop: 16 }}>
            ← Back to Portal
          </button>
        )}
      </div>
    );
  }

  // ─── Ready to Start / Lobby Screen ─────────────────────────────────────────
  if (!hasStarted) {
    return (
      <div className="student-lobby-wrap animate-fade-in" ref={containerRef}>
        <div className="student-lobby-card animate-scale-up">
          <div className="student-lobby-header">
            <span className="student-lobby-badge">STUDENT ASSESSMENT PORTAL</span>
            <h1 className="student-lobby-title">{title}</h1>
            <p className="student-lobby-subtitle">
              {headerConfig?.subject || 'Assessment'} {headerConfig?.subjectCode ? `(${headerConfig.subjectCode})` : ''} • {questions.length} Questions • {totalMarks} Total Marks
            </p>
          </div>

          <div className="student-lobby-rules-grid">
            <div className="lobby-rule-item">
              <span className="rule-icon">⏱️</span>
              <div>
                <strong>Duration</strong>
                <p>{headerConfig?.durationMinutes || 45} minutes total</p>
              </div>
            </div>
            <div className="lobby-rule-item">
              <span className="rule-icon">🔒</span>
              <div>
                <strong>Security Guard</strong>
                <p>Fullscreen & tab-switch tracking active</p>
              </div>
            </div>
            <div className="lobby-rule-item">
              <span className="rule-icon">📝</span>
              <div>
                <strong>Format</strong>
                <p>KaTeX Math formulas & scientific diagrams</p>
              </div>
            </div>
          </div>

          {headerConfig?.instructions && (
            <div className="student-lobby-instructions">
              <strong>Instructions to Candidate:</strong>
              <p>{headerConfig.instructions}</p>
            </div>
          )}

          {/* Candidate Name Input */}
          <div className="student-candidate-name-box" style={{ margin: '16px 0' }}>
            <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 700, marginBottom: 6, color: 'var(--color-text-primary)' }}>
              Candidate / Student Name:
            </label>
            <input
              type="text"
              className="student-name-input"
              value={candidateName}
              onChange={(e) => setCandidateName(e.target.value)}
              placeholder="e.g. Alex Johnson or Student ID"
              style={{
                width: '100%',
                padding: '10px 14px',
                borderRadius: 'var(--radius-lg)',
                border: '1.5px solid var(--color-border)',
                background: 'var(--color-surface-sunken)',
                color: 'var(--color-text-primary)',
                fontSize: '0.875rem',
                fontWeight: 600,
                outline: 'none',
                boxSizing: 'border-box',
              }}
            />
          </div>

          {/* Mode Selector */}
          <div className="student-mode-toggle-box">
            <label className="student-mode-toggle">
              <input
                type="checkbox"
                checked={isExamMode}
                onChange={(e) => setIsExamMode(e.target.checked)}
              />
              <span><strong>Strict Timed Exam Mode</strong> (Enforces countdown timer & submit gate)</span>
            </label>

            <label className="student-mode-toggle" style={{ marginTop: 8 }}>
              <input
                type="checkbox"
                checked={securityEnabled}
                onChange={(e) => setSecurityEnabled(e.target.checked)}
              />
              <span><strong>🔒 Anti-Cheating Exam Browser Mode</strong> (Fullscreen lock & tab-switch alerts)</span>
            </label>
          </div>

          <div className="student-lobby-actions">
            {onExit && (
              <button type="button" className="sq-btn sq-btn-secondary" onClick={onExit}>
                Exit
              </button>
            )}
            <button type="button" className="sq-btn sq-btn-primary sq-btn-large" onClick={handleStartExam}>
              🚀 Begin Assessment Now
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ─── Final Score & Solutions Review Screen ─────────────────────────────────
  if (isSubmitted) {
    const results = calculateResults();
    return (
      <div className="student-results-wrap animate-fade-in">
        <div className="student-results-card">
          <div className="results-badge">ASSESSMENT COMPLETED</div>
          <h1 className="results-title">Great Job! Assessment Submitted 🎉</h1>
          <p className="results-sub">{title} • Candidate Performance Summary</p>

          <div className="results-score-row">
            <div className="results-score-circle">
              <span className="results-score-num">{results.percentage}%</span>
              <span className="results-score-label">{results.mcqEarned} / {results.mcqTotal} Marks</span>
            </div>

            <div className="results-stats-panel">
              <div className="stat-row">
                <span>Total Questions:</span>
                <strong>{questions.length}</strong>
              </div>
              <div className="stat-row">
                <span>Questions Attempted:</span>
                <strong>{Object.keys(answers).length} / {questions.length}</strong>
              </div>
              <div className="stat-row">
                <span>Integrity Violations:</span>
                <strong className={violations.length > 0 ? 'text-danger' : 'text-success'}>
                  {violations.length} {violations.length === 0 ? '(Clean session ✅)' : 'logged ⚠️'}
                </strong>
              </div>
            </div>
          </div>

          {/* Syllabus Mastery Analysis */}
          <div className="results-topics-box">
            <h3 className="results-section-heading">📊 Topic-by-Topic Mastery Breakdown</h3>
            <div className="topics-bars-list">
              {Object.entries(results.topicStats).map(([topic, stat]) => {
                const pct = stat.total > 0 ? Math.round((stat.earned / stat.total) * 100) : 100;
                return (
                  <div key={topic} className="topic-bar-item">
                    <div className="topic-bar-header">
                      <span>{topic}</span>
                      <span>{stat.earned}/{stat.total} marks ({pct}%)</span>
                    </div>
                    <div className="topic-progress-track">
                      <div className="topic-progress-fill" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Security & Proctoring Log if violations occurred */}
          {violations.length > 0 && (
            <div className="proctoring-log-box">
              <h3 className="proctoring-log-title">⚠️ Proctoring & Security Audit Trail ({violations.length})</h3>
              <div className="proctoring-list">
                {violations.map((v, i) => (
                  <div key={i} className="proctoring-item">
                    <span className="proctoring-time">{v.timestamp}</span>
                    <span className="proctoring-detail">{v.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Solutions & Walkthrough Preview */}
          <div className="results-solutions-box">
            <h3 className="results-section-heading">🔑 Model Solutions & Examiner Guidance</h3>
            <div className="solutions-list">
              {questions.map((q, idx) => (
                <div key={idx} className="solution-item-card">
                  <div className="sol-card-header">
                    <strong>Question {idx + 1}</strong>
                    <span>[{q.marks || 1} mark{q.marks !== 1 ? 's' : ''}]</span>
                  </div>
                  <div className="sol-stem">
                    <ExamMathText content={cleanQuestionStem(q.question_text || '', q.options)} />
                  </div>
                  <div className="sol-points">
                    <strong>Model Answer:</strong>
                    <ExamMathText
                      content={
                        typeof q.mark_scheme === 'string'
                          ? q.mark_scheme
                          : Array.isArray(q.mark_scheme?.marking_points)
                          ? q.mark_scheme.marking_points.join('; ')
                          : 'Credit valid scientific derivation'
                      }
                    />
                  </div>
                  {q.mark_scheme?.guidance && q.mark_scheme.guidance.length > 0 && (
                    <div className="sol-guidance">
                      💡 <strong>Examiner Guidance:</strong> <ExamMathText content={q.mark_scheme.guidance.join('; ')} />
                    </div>
                  )}
                  {q.mark_scheme?.common_misconceptions && q.mark_scheme.common_misconceptions.length > 0 && (
                    <div className="sol-traps">
                      ⚠️ <strong>Common Pitfall:</strong> <ExamMathText content={q.mark_scheme.common_misconceptions.join('; ')} />
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="results-footer-actions">
            {onExit && (
              <button className="sq-btn sq-btn-primary" onClick={onExit}>
                ← Return to Portal
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ─── Active Quiz Runner Screen ─────────────────────────────────────────────
  return (
    <div
      className={`student-runner-root ${securityEnabled ? 'sq-security-active' : ''}`}
      ref={containerRef}
      onContextMenu={(e) => securityEnabled && e.preventDefault()}
    >
      {/* Top Header Bar */}
      <header className="sq-runner-header">
        <div className="sq-runner-title-group">
          <h2 className="sq-runner-title">{title}</h2>
          <span className="sq-runner-subject">{headerConfig?.subject || 'Assessment'}</span>
        </div>

        <div className="sq-runner-header-right">
          {/* Violations Badge */}
          {securityEnabled && violations.length > 0 && (
            <div className="sq-violation-badge" title="Security alerts recorded">
              ⚠️ {violations.length} strike{violations.length !== 1 ? 's' : ''}
            </div>
          )}

          {/* Countdown Timer */}
          {isExamMode && (
            <div className={`sq-timer-pill ${timeLeft < 300 ? 'sq-timer-pill--urgent' : ''}`}>
              <span>⏱️</span>
              <span className="sq-timer-clock">{formatTimer(timeLeft)}</span>
            </div>
          )}

          {/* Submit Action */}
          <button
            type="button"
            className="sq-btn sq-btn-finish"
            onClick={() => {
              if (confirm('Are you sure you want to finish and submit your assessment?')) {
                handleSubmitExam();
              }
            }}
          >
            Finish & Submit
          </button>
        </div>
      </header>

      {/* Security Banner Alert */}
      {securityAlert && (
        <div className="sq-security-alert-bar animate-fade-in">
          <span>{securityAlert}</span>
          <button
            type="button"
            className="sq-alert-dismiss"
            onClick={() => setSecurityAlert(null)}
          >
            ✕
          </button>
        </div>
      )}

      {/* Main Runner Body */}
      <main className="sq-runner-body">
        {/* Left / Center: Question View */}
        <section className="sq-question-panel">
          <div className="sq-question-card animate-scale-up" key={currentIndex}>
            <div className="sq-q-top-row">
              <div className="sq-q-badge-wrap">
                <span className="sq-q-number-badge">Question {currentIndex + 1} of {questions.length}</span>
                {currentQuestion?.topic && (
                  <span className="sq-q-topic-badge">{currentQuestion.topic}</span>
                )}
              </div>
              <span className="sq-q-marks-pill">[{currentQuestion?.marks || 1} mark{currentQuestion?.marks !== 1 ? 's' : ''}]</span>
            </div>

            {/* Question Stem */}
            <div className="sq-q-stem">
              <ExamMathText content={cleanQuestionStem(currentQuestion?.question_text || '', currentQuestion?.options)} />
            </div>

            {/* Diagram Image if available */}
            {currentQuestion?.diagram_url && (
              <div className="sq-q-diagram-wrap">
                <img
                  src={currentQuestion.diagram_url}
                  alt={`Diagram for Question ${currentIndex + 1}`}
                  className="sq-q-diagram-img"
                  onClick={() => setZoomedImage(currentQuestion.diagram_url || null)}
                  title="Click to zoom diagram"
                />
              </div>
            )}

            {/* Sub-Questions Stream if structured */}
            {currentQuestion?.sub_questions && currentQuestion.sub_questions.length > 0 && (
              <div className="sq-sub-questions-list">
                {currentQuestion.sub_questions.map((sub, sIdx) => (
                  <div key={sIdx} className="sq-sub-item">
                    <div className="sq-sub-header">
                      <span className="sq-sub-id">{sub.sub_id}</span>
                      <span className="sq-sub-text"><ExamMathText content={sub.question_text || ''} /></span>
                      <span className="sq-sub-marks">[{sub.marks || 1}]</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* MCQ Choices Input */}
            {currentQuestion?.options && currentQuestion.options.length > 0 ? (
              <div className="sq-choices-list">
                {currentQuestion.options.map((optionText, oIdx) => {
                  const isSelected = answers[currentIndex] === oIdx;
                  return (
                    <button
                      key={oIdx}
                      type="button"
                      className={`sq-choice-btn ${isSelected ? 'sq-choice-btn--selected' : ''}`}
                      onClick={() => handleSelectOption(oIdx)}
                    >
                      <span className="sq-choice-letter">{String.fromCharCode(65 + oIdx)}</span>
                      <span className="sq-choice-text"><ExamMathText content={cleanOptionText(optionText, oIdx)} /></span>
                    </button>
                  );
                })}
              </div>
            ) : (
              /* Structured Response Text Box */
              <div className="sq-structured-input-box">
                <label className="sq-input-label">Your Answer / Solution:</label>
                <textarea
                  className="sq-text-answer-area"
                  placeholder="Type your final answer or working steps here..."
                  value={(answers[currentIndex] as string) || ''}
                  onChange={(e) => handleTextAnswerChange(e.target.value)}
                  rows={5}
                />
              </div>
            )}

            {/* Bottom Actions Row */}
            <div className="sq-q-nav-actions">
              <button
                type="button"
                className="sq-btn sq-btn-secondary"
                disabled={currentIndex === 0}
                onClick={() => setCurrentIndex((prev) => Math.max(0, prev - 1))}
              >
                ← Previous
              </button>

              <button
                type="button"
                className={`sq-btn sq-btn-flag ${flaggedIndices.has(currentIndex) ? 'sq-btn-flag--active' : ''}`}
                onClick={handleToggleFlag}
              >
                {flaggedIndices.has(currentIndex) ? '⭐ Flagged for Review' : '☆ Flag Question'}
              </button>

              <button
                type="button"
                className="sq-btn sq-btn-primary"
                onClick={() => {
                  if (currentIndex < questions.length - 1) {
                    setCurrentIndex((prev) => prev + 1);
                  } else {
                    if (confirm('You reached the final question. Would you like to submit your assessment?')) {
                      handleSubmitExam();
                    }
                  }
                }}
              >
                {currentIndex === questions.length - 1 ? 'Review & Submit →' : 'Next Question →'}
              </button>
            </div>
          </div>
        </section>

        {/* Right Sidebar: Question Matrix Navigator */}
        <aside className="sq-sidebar-panel">
          <div className="sq-navigator-card">
            <h3 className="sq-nav-card-title">Question Navigator</h3>
            <p className="sq-nav-card-subtitle">
              {Object.keys(answers).length} of {questions.length} Answered
            </p>

            <div className="sq-nav-matrix-grid">
              {questions.map((_, idx) => {
                const isAnswered = answers[idx] !== undefined && answers[idx] !== '';
                const isFlagged = flaggedIndices.has(idx);
                const isCurrent = idx === currentIndex;

                return (
                  <button
                    key={idx}
                    type="button"
                    className={`sq-matrix-cell ${isCurrent ? 'sq-matrix-cell--current' : ''} ${isAnswered ? 'sq-matrix-cell--answered' : ''} ${isFlagged ? 'sq-matrix-cell--flagged' : ''}`}
                    onClick={() => setCurrentIndex(idx)}
                    title={`Jump to Question ${idx + 1}`}
                  >
                    {idx + 1}
                    {isFlagged && <span className="matrix-flag-dot">★</span>}
                  </button>
                );
              })}
            </div>

            {/* Matrix Legend */}
            <div className="sq-matrix-legend">
              <div className="legend-item"><span className="legend-box answered" /> Answered</div>
              <div className="legend-item"><span className="legend-box flagged" /> Flagged</div>
              <div className="legend-item"><span className="legend-box unanswered" /> Unanswered</div>
            </div>
          </div>
        </aside>
      </main>

      {/* Zoom Modal */}
      {zoomedImage && (
        <div className="sq-zoom-modal-backdrop" onClick={() => setZoomedImage(null)}>
          <div className="sq-zoom-modal-content">
            <img src={zoomedImage} alt="Zoomed diagram" className="sq-zoomed-img" />
            <button className="sq-zoom-close-btn" onClick={() => setZoomedImage(null)}>✕ Close</button>
          </div>
        </div>
      )}
    </div>
  );
}
