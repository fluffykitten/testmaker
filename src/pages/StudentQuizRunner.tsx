import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import type { Question } from '../types/database';
import type { ExamHeaderConfig } from '../services/testBuilderService';
import { resolveStudentQuiz } from '../services/quizCodeService';
import {
  saveQuizSubmission,
  saveQuizSubmissionCloud,
  saveDeviceReceipt,
  generateResultPin,
  formatProctorTimestamp,
  cleanMcqOptionContent,
  type StudentSubmission,
  type QuestionSubmissionResult,
} from '../services/quizSubmissionService';
import { gradeDeterministicAnswer, resolveMcqCorrectOptionIndex } from '../services/deterministicGradingService';
import { evaluateAnswerWithGemini } from '../services/aiGradingService';
import { exportIndividualStudentReportPdf } from '../services/quizReportPdfService';
import { ExamMathText } from '../components/ExamMathText';
import { PeriodicTableDrawer } from '../components/PeriodicTableDrawer';
import { ScientificCalculatorModal } from '../components/ScientificCalculatorModal';
import { ResourceBookletDrawer } from '../components/ResourceBookletDrawer';
import './StudentQuizRunner.css';

interface StudentQuizRunnerProps {
  testIdOrCode?: string;
  initialQuestions?: Question[];
  initialHeaderConfig?: ExamHeaderConfig;
  onExit?: () => void;
  onSwitchToGameMode?: () => void;
}

interface ViolationRecord {
  type: 'tab_switch' | 'fullscreen_exit' | 'blocked_shortcut' | 'window_blur';
  timestamp: string;
  detail: string;
}

const QUICK_CHEM_SYMBOLS = [
  '→', '⇌', 'Δ', '°C', 'mol/dm³', 'g/cm³', 'kJ/mol', '(s)', '(l)', '(g)', '(aq)', '⁺', '⁻', '²', '³', '⁴'
];

interface ModelAnswerClause {
  label: string;
  content: string;
  marks?: string;
}

function parseModelAnswerClauses(rawText: string): ModelAnswerClause[] {
  if (!rawText) return [];

  // Split by semicolon or newline
  const rawParts = rawText
    .split(/(?:;|\n)+/)
    .map((p) => p.trim())
    .filter(Boolean);

  const results: ModelAnswerClause[] = [];

  for (const part of rawParts) {
    let text = part;

    // 1. Extract subId or label prefix like "4(a)", "(a)", "4(e)(i)", "State at $T_1$:", "State at T1:", "anode:"
    let label = '';
    const labelMatch = text.match(/^(\d*\([a-z0-9ivx]+\)(?:\([a-z0-9ivx]+\))?|state at \$?[a-z0-9_]+\$?:|[a-z0-9\s\$_\{\}]+:)/i);
    if (labelMatch) {
      label = labelMatch[1].replace(/:$/, '').trim();
      text = text.slice(labelMatch[0].length).trim();
    }

    // 2. Extract mark annotations: [1], [2], [M1], [A1], (1 mark), [2 marks], (1), (2)
    let marks = '';
    const marksMatch = text.match(/(?:\[|\()(\d+)\s*(?:marks?|m)?(?:\]|\))/i) || text.match(/\[([A-Za-z0-9\s]+)\]/);
    if (marksMatch) {
      marks = marksMatch[1];
    }

    // 3. Clean marks from text
    const cleanText = text
      .replace(/\[\s*(?:\d+|[A-Za-z]\d*)\s*(?:marks?)?\s*\]/gi, '')
      .replace(/\(\s*\d+\s*(?:marks?)?\s*\)/gi, '')
      .trim();

    results.push({
      label,
      content: cleanText || text,
      marks: marks ? `${marks} mark${marks !== '1' && !isNaN(Number(marks)) ? 's' : ''}` : undefined,
    });
  }

  return results;
}

function renderStructuredModelAnswer(markScheme: any) {
  const rawText = typeof markScheme === 'string'
    ? markScheme
    : Array.isArray(markScheme?.marking_points)
    ? markScheme.marking_points.join('; ')
    : markScheme?.acceptable_answers?.join('; ') || 'Credit valid scientific derivation';

  const clauses = parseModelAnswerClauses(rawText);

  if (clauses.length <= 1) {
    return (
      <div className="sol-points-single" style={{ padding: '8px 12px', background: 'var(--color-surface-sunken)', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-border)' }}>
        <ExamMathText content={rawText} />
      </div>
    );
  }

  return (
    <div className="sol-points-grid" style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' }}>
      {clauses.map((clause, cIdx) => (
        <div
          key={cIdx}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
            background: 'var(--color-surface-sunken)',
            padding: '8px 12px',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--color-border)',
            fontSize: '0.875rem',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0 }}>
            {clause.label ? (
              <span
                style={{
                  fontWeight: 800,
                  fontSize: '0.75rem',
                  padding: '2px 8px',
                  borderRadius: '6px',
                  background: 'var(--color-primary-500, #8b5cf6)',
                  color: '#ffffff',
                  whiteSpace: 'nowrap',
                }}
              >
                <ExamMathText content={clause.label} />
              </span>
            ) : (
              <span style={{ color: 'var(--color-text-secondary)', fontWeight: 700 }}>•</span>
            )}
            <div style={{ flex: 1, color: 'var(--color-text-primary)' }}>
              <ExamMathText content={clause.content} />
            </div>
          </div>
          {clause.marks && (
            <span
              style={{
                fontSize: '0.75rem',
                fontWeight: 700,
                background: 'rgba(255, 255, 255, 0.08)',
                padding: '2px 8px',
                borderRadius: '6px',
                color: 'var(--color-text-secondary)',
                whiteSpace: 'nowrap',
              }}
            >
              [{clause.marks}]
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function StudentQuizRunner({
  testIdOrCode,
  initialQuestions,
  initialHeaderConfig,
  onExit,
  onSwitchToGameMode,
}: StudentQuizRunnerProps) {
  // Test Data State
  const [loading, setLoading] = useState(!initialQuestions);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(initialHeaderConfig?.title || 'Interactive Examination');
  const [headerConfig, setHeaderConfig] = useState<ExamHeaderConfig | undefined>(initialHeaderConfig);
  const [questions, setQuestions] = useState<Question[]>(initialQuestions || []);

  // Session Persistence Key (per exam code)
  const sessionKey = `exam_sess_${testIdOrCode || 'testrun'}`;
  const getSavedExamState = () => {
    try {
      const raw = sessionStorage.getItem(sessionKey);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  const savedExam = useRef(getSavedExamState()).current;

  // Candidate Info
  const [candidateName, setCandidateName] = useState<string>(() => savedExam?.candidateName || '');
  const [candidateClass, setCandidateClass] = useState<string>(() => savedExam?.candidateClass || '');
  const [candidateNumber, setCandidateNumber] = useState<string>(() => savedExam?.candidateNumber || '');
  const [startTime, setStartTime] = useState<number>(() => savedExam?.startTime || Date.now());

  // Exam Progress State
  const [currentIndex, setCurrentIndex] = useState<number>(() => savedExam?.currentIndex || 0);
  const [answers, setAnswers] = useState<Record<string | number, string | number>>(() => savedExam?.answers || {});
  const [flaggedIndices, setFlaggedIndices] = useState<Set<number>>(() => new Set(savedExam?.flaggedIndices || []));
  const [isExamMode, setIsExamMode] = useState<boolean>(() => savedExam?.isExamMode ?? true); // true = Strict Timed Exam, false = Practice Mode
  const [isTeacherLocked, setIsTeacherLocked] = useState<boolean>(() => !!testIdOrCode);
  const [hasStarted, setHasStarted] = useState<boolean>(() => savedExam?.hasStarted || false);
  const [isSubmitted, setIsSubmitted] = useState<boolean>(() => savedExam?.isSubmitted || false);
  const [timeLeft, setTimeLeft] = useState<number>(() => savedExam?.timeLeft ?? (45 * 60));

  // Reference & Tool Drawers
  const [showPeriodicTable, setShowPeriodicTable] = useState<boolean>(false);
  const [showCalculator, setShowCalculator] = useState<boolean>(false);
  const [showResourceBooklet, setShowResourceBooklet] = useState<boolean>(false);
  const [timeWarning, setTimeWarning] = useState<string | null>(null);

  // Grading & AI Evaluation State
  const [isGrading, setIsGrading] = useState<boolean>(false);
  const [gradingProgressText, setGradingProgressText] = useState<string>('');
  const [completedSubmission, setCompletedSubmission] = useState<StudentSubmission | null>(null);

  // 🔒 Security & Anti-Cheating State
  const [securityEnabled, setSecurityEnabled] = useState(() => savedExam?.securityEnabled ?? true);
  const [requireTeacherUnlock, setRequireTeacherUnlock] = useState<boolean>(() => savedExam?.requireTeacherUnlock ?? true);
  const [teacherPin, setTeacherPin] = useState<string>(() => savedExam?.teacherPin || '1234');
  const [isLockedByProctor, setIsLockedByProctor] = useState<boolean>(() => savedExam?.isLockedByProctor || false);
  const [lockReason, setLockReason] = useState<string>(() => savedExam?.lockReason || '');
  const [lockTime, setLockTime] = useState<string>(() => savedExam?.lockTime || '');
  const [pinInput, setPinInput] = useState<string>('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [isUnlocking, setIsUnlocking] = useState<boolean>(false);
  const [violations, setViolations] = useState<ViolationRecord[]>(() => savedExam?.violations || []);
  const [securityAlert, setSecurityAlert] = useState<string | null>(null);
  const [showSubmitModal, setShowSubmitModal] = useState<boolean>(false);
  const isSubmittingRef = useRef<boolean>(false);

  // Diagram Zoom
  const [zoomedImage, setZoomedImage] = useState<string | null>(null);
  const [hasCopiedPin, setHasCopiedPin] = useState<boolean>(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const submitModalDismiss = useBackdropDismiss(() => setShowSubmitModal(false));
  const zoomModalDismiss = useBackdropDismiss(() => setZoomedImage(null));

  // Accurate Sub-Questions and Answered Items Counting
  const quizStats = useMemo(() => {
    let totalItems = 0;
    let answeredItems = 0;

    for (let qIdx = 0; qIdx < questions.length; qIdx++) {
      const q = questions[qIdx];
      if (q.sub_questions && q.sub_questions.length > 0) {
        for (let sIdx = 0; sIdx < q.sub_questions.length; sIdx++) {
          totalItems++;
          const subKey = `${qIdx}_${sIdx}`;
          const val = answers[subKey] !== undefined ? answers[subKey] : (answers[qIdx] as any)?.[sIdx];
          if (val !== undefined && String(val).trim().length > 0) {
            answeredItems++;
          }
        }
      } else {
        totalItems++;
        const val = answers[qIdx];
        if (val !== undefined && String(val).trim().length > 0) {
          answeredItems++;
        }
      }
    }

    return {
      totalItems,
      answeredItems,
      unansweredItems: Math.max(0, totalItems - answeredItems),
    };
  }, [questions, answers]);

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
          if (data.requireTeacherUnlock !== undefined) {
            setRequireTeacherUnlock(data.requireTeacherUnlock);
          }
          if (data.teacherPin) {
            setTeacherPin(data.teacherPin);
          }
          setIsTeacherLocked(true);
        }
      } catch (err: any) {
        setError(`Failed to load quiz: ${err?.message || 'Network error'}`);
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [testIdOrCode, initialQuestions, initialHeaderConfig]);

  // ─── 2. Violation Logger & Invigilator Lock Gate ─────────────────────────
  const logViolation = useCallback(
    (type: ViolationRecord['type'], detail: string) => {
      if (!hasStarted || isSubmitted || isGrading || isSubmittingRef.current || !securityEnabled) return;
      const nowIso = new Date().toISOString();
      const rec: ViolationRecord = { type, timestamp: nowIso, detail };
      setViolations((prev) => [...prev, rec]);

      if (requireTeacherUnlock && isExamMode) {
        setIsLockedByProctor(true);
        setLockReason(detail);
        setLockTime(nowIso);
        setPinError(null);
        setPinInput('');
      } else {
        setSecurityAlert(`⚠️ SECURITY VIOLATION: ${detail} (Recorded at ${formatProctorTimestamp(nowIso)})`);
      }
    },
    [hasStarted, isSubmitted, isGrading, securityEnabled, requireTeacherUnlock, isExamMode]
  );

  const handleUnlockWithPin = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const entered = pinInput.trim();
    const expected = (teacherPin || '1234').trim();

    if (!entered) {
      setPinError('Please enter the Teacher / Proctor PIN.');
      return;
    }

    if (entered.toUpperCase() === expected.toUpperCase()) {
      setIsUnlocking(true);
      setTimeout(async () => {
        setIsLockedByProctor(false);
        setLockReason('');
        setLockTime('');
        setPinInput('');
        setPinError(null);
        setIsUnlocking(false);
        setSecurityAlert('✅ Exam unlocked by invigilator. Please remain focused in fullscreen.');
        setTimeout(() => setSecurityAlert(null), 5000);

        // Re-enter Fullscreen on unlock
        try {
          if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
            await document.documentElement.requestFullscreen();
          }
        } catch (err) {
          console.warn('Fullscreen resume notice:', err);
        }
      }, 350);
    } else {
      setPinError('❌ Incorrect Teacher PIN. Please have the exam invigilator verify and re-enter.');
    }
  };

  // ─── 3. Anti-Cheating Event Listeners ──────────────────────────────────────
  useEffect(() => {
    if (!hasStarted || isSubmitted || isGrading || isSubmittingRef.current || !securityEnabled) return;

    // A. Tab switch / Visibility change
    const handleVisibilityChange = () => {
      if (document.hidden && !isSubmittingRef.current && !isSubmitted) {
        logViolation('tab_switch', 'Switched away from exam tab or minimized window');
      }
    };

    // B. Window Blur (e.g. Alt+Tab or clicking outside)
    const handleWindowBlur = () => {
      if (!isSubmittingRef.current && !isSubmitted && !isGrading) {
        logViolation('window_blur', 'Exam window lost focus (Alt+Tab / App switch)');
      }
    };

    // C. Fullscreen change
    const handleFullscreenChange = () => {
      const isFull = !!document.fullscreenElement;
      if (!isFull && hasStarted && !isSubmitted && !isGrading && !isSubmittingRef.current) {
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
      if (!isSubmittingRef.current && !isSubmitted) {
        e.preventDefault();
        e.returnValue = 'You have an active exam in progress. Are you sure you want to leave?';
      }
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
  }, [hasStarted, isSubmitted, isGrading, securityEnabled, isExamMode, logViolation]);

  // ─── 4. Submit & Grading Handler (Deterministic + AI Pipeline) ────────────
  const handleSubmitExam = useCallback(async () => {
    if (isSubmitted || isGrading || isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setShowSubmitModal(false);
    setIsGrading(true);

    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }

    // ── Formal Exam Mode: Fast Deferred Submit Pipeline ──
    // Saves raw responses to Supabase immediately with zero AI rate-limit delays.
    if (isExamMode) {
      setGradingProgressText('Submitting examination responses to examiner...');
      try {
        const durationSec = Math.max(1, Math.round((Date.now() - startTime) / 1000));
        const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0);
        let earnedMarks = 0;
        const qResults: QuestionSubmissionResult[] = [];
        const topicBreakdown: Record<string, { totalMarks: number; earnedMarks: number; percentage: number }> = {};

        for (let idx = 0; idx < questions.length; idx++) {
          const q = questions[idx];
          const top = q.topic || 'General';
          if (!topicBreakdown[top]) topicBreakdown[top] = { totalMarks: 0, earnedMarks: 0, percentage: 0 };
          const qMarks = q.marks || 1;
          topicBreakdown[top].totalMarks += qMarks;

          let isCorrect = false;
          let qEarned = 0;
          let gradingMethod: 'mcq' | 'deterministic' | 'ai_gemini' | 'rule_fallback' = 'deterministic';
          const subResults: any[] = [];

          // Fast deterministic evaluation for MCQs
          if (q.options && q.options.length > 0) {
            gradingMethod = 'mcq';
            const userAns = answers[idx];
            const correctIdx = resolveMcqCorrectOptionIndex(q);
            const userNum = userAns !== undefined && userAns !== '' ? Number(userAns) : -1;
            const userLetter = typeof userAns === 'string' && userAns.trim().length === 1
              ? userAns.trim().toUpperCase().charCodeAt(0) - 65
              : -1;

            if (userNum === correctIdx || userLetter === correctIdx) {
              isCorrect = true;
              qEarned = qMarks;
            }
          } else if (q.sub_questions && q.sub_questions.length > 0) {
            let totalSubEarned = 0;
            for (let sIdx = 0; sIdx < q.sub_questions.length; sIdx++) {
              const sq = q.sub_questions[sIdx];
              const subKey = `${idx}_${sIdx}`;
              const subAns = (answers[subKey] !== undefined ? answers[subKey] : (answers[idx] as any)?.[sIdx]) ?? '';
              const subMarks = sq.marks || 1;

              const det = gradeDeterministicAnswer(subAns, q, sIdx);
              if (det.isHandled) {
                totalSubEarned += det.earnedMarks;
                subResults.push({
                  subId: sq.sub_id,
                  questionText: sq.question_text,
                  studentAnswer: subAns,
                  earnedMarks: det.earnedMarks,
                  maxMarks: subMarks,
                  isCorrect: det.isCorrect,
                  feedback: det.feedback,
                });
              } else {
                subResults.push({
                  subId: sq.sub_id,
                  questionText: sq.question_text,
                  studentAnswer: subAns,
                  earnedMarks: 0,
                  maxMarks: subMarks,
                  isCorrect: false,
                  feedback: 'Awaiting examiner AI evaluation',
                });
              }
            }
            qEarned = Math.min(totalSubEarned, qMarks);
            isCorrect = qEarned === qMarks;
          } else {
            const userAns = answers[idx] ?? '';
            const det = gradeDeterministicAnswer(userAns, q);
            if (det.isHandled) {
              qEarned = det.earnedMarks;
              isCorrect = det.isCorrect;
              gradingMethod = 'deterministic';
            }
          }

          earnedMarks += qEarned;
          topicBreakdown[top].earnedMarks += qEarned;

          qResults.push({
            questionId: q.id,
            questionNumber: idx + 1,
            questionText: q.question_text,
            options: q.options || undefined,
            topic: top,
            maxMarks: qMarks,
            earnedMarks: qEarned,
            isCorrect,
            studentAnswer: answers[idx] !== undefined ? answers[idx] : '',
            correctAnswer: (q.options && q.options.length > 0)
              ? `Option ${String.fromCharCode(65 + resolveMcqCorrectOptionIndex(q))}: ${cleanMcqOptionContent(q.options[resolveMcqCorrectOptionIndex(q)] || '', resolveMcqCorrectOptionIndex(q))}`
              : typeof q.mark_scheme === 'string'
              ? q.mark_scheme
              : Array.isArray(q.mark_scheme?.marking_points)
              ? q.mark_scheme.marking_points.join('; ')
              : undefined,
            misconceptions: (q as any).metadata?.misconceptions || (q as any).misconceptions || [],
            gradingMethod,
            subQuestionResults: subResults.length > 0 ? subResults : undefined,
          });
        }

        Object.keys(topicBreakdown).forEach((top) => {
          const item = topicBreakdown[top];
          item.percentage = item.totalMarks > 0 ? (item.earnedMarks / item.totalMarks) * 100 : 0;
        });

        const submission: StudentSubmission = {
          id: `sub_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          quizId: testIdOrCode || 'direct_quiz',
          quizCode: (testIdOrCode || 'EXAM').toUpperCase(),
          quizTitle: title,
          subject: headerConfig?.subject || 'Chemistry',
          studentName: candidateName.trim() || 'Candidate',
          studentClass: candidateClass.trim() || 'General',
          candidateNumber: candidateNumber.trim() || undefined,
          submittedAt: new Date().toISOString(),
          durationSeconds: durationSec,
          score: earnedMarks,
          totalMarks,
          percentage: totalMarks > 0 ? Math.round((earnedMarks / totalMarks) * 100) : 100,
          violationsCount: violations.length,
          proctoringLogs: violations.map((v, i) => ({
            timestamp: v.timestamp,
            event: v.detail,
            strike: i + 1,
            severity: v.type === 'blocked_shortcut' ? 'critical' : 'warning',
          })),
          rawAnswers: { ...answers },
          questionResults: qResults,
          topicBreakdown,
          status: 'submitted',
          resultPin: generateResultPin(),
        };

        await saveQuizSubmissionCloud(submission);
        saveDeviceReceipt({
          quizCode: (testIdOrCode || 'EXAM').toUpperCase(),
          quizTitle: title,
          studentName: candidateName.trim() || 'Candidate',
          candidateNumber: candidateNumber.trim() || undefined,
          submittedAt: submission.submittedAt,
          resultPin: submission.resultPin,
        });

        setCompletedSubmission(submission);

        try {
          sessionStorage.removeItem(sessionKey);
        } catch {}

        setIsSubmitted(true);
      } catch (err) {
        console.error('Failed to submit exam:', err);
        setIsSubmitted(true);
      } finally {
        setIsGrading(false);
      }
      return;
    }

    // ── Practice Mode: Immediate Client AI Pipeline ──
    setGradingProgressText('Evaluating answers with Deterministic Matcher & AI Examiner...');

    try {
      const durationSec = Math.max(1, Math.round((Date.now() - startTime) / 1000));
      const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0);
      let earnedMarks = 0;
      const qResults: QuestionSubmissionResult[] = [];
      const topicBreakdown: Record<string, { totalMarks: number; earnedMarks: number; percentage: number }> = {};

      for (let idx = 0; idx < questions.length; idx++) {
        const q = questions[idx];
        const top = q.topic || 'General';
        if (!topicBreakdown[top]) topicBreakdown[top] = { totalMarks: 0, earnedMarks: 0, percentage: 0 };
        const qMarks = q.marks || 1;
        topicBreakdown[top].totalMarks += qMarks;

        let isCorrect = false;
        let qEarned = 0;
        let aiFeedback: string | undefined;
        let missingPoints: string[] | undefined;
        let criteriaBreakdown: Array<{ point: string; achieved: boolean; examinerNote?: string }> | undefined;
        let gradingMethod: 'mcq' | 'deterministic' | 'ai_gemini' | 'rule_fallback' = 'deterministic';
        const subResults: any[] = [];

        // Case A: Multiple Choice Question
        if (q.options && q.options.length > 0) {
          gradingMethod = 'mcq';
          const userAns = answers[idx];
          const correctIdx = resolveMcqCorrectOptionIndex(q);
          const userNum = userAns !== undefined && userAns !== '' ? Number(userAns) : -1;
          const userLetter = typeof userAns === 'string' && userAns.trim().length === 1
            ? userAns.trim().toUpperCase().charCodeAt(0) - 65
            : -1;

          if (userNum === correctIdx || userLetter === correctIdx) {
            isCorrect = true;
            qEarned = qMarks;
          }
        }
        // Case B: Multi-Part Structured Question
        else if (q.sub_questions && q.sub_questions.length > 0) {
          let totalSubEarned = 0;
          for (let sIdx = 0; sIdx < q.sub_questions.length; sIdx++) {
            const sq = q.sub_questions[sIdx];
            const subKey = `${idx}_${sIdx}`;
            const subAns = (answers[subKey] !== undefined ? answers[subKey] : (answers[idx] as any)?.[sIdx]) ?? '';
            const subMarks = sq.marks || 1;

            // Fast deterministic evaluation first
            const det = gradeDeterministicAnswer(subAns, q, sIdx);
            if (det.isHandled) {
              totalSubEarned += det.earnedMarks;
              subResults.push({
                subId: sq.sub_id,
                studentAnswer: subAns,
                earnedMarks: det.earnedMarks,
                maxMarks: subMarks,
                isCorrect: det.isCorrect,
                feedback: det.feedback,
              });
            } else {
              // Descriptive sub-part -> evaluate with Gemini AI Examiner
              setGradingProgressText(`AI Examiner evaluating Q${idx + 1}(${sq.sub_id})...`);
              const aiRes = await evaluateAnswerWithGemini(q, sIdx, String(subAns));
              totalSubEarned += aiRes.earnedMarks;
              gradingMethod = aiRes.evaluatedBy === 'gemini' ? 'ai_gemini' : 'rule_fallback';
              subResults.push({
                subId: sq.sub_id,
                studentAnswer: subAns,
                earnedMarks: aiRes.earnedMarks,
                maxMarks: subMarks,
                isCorrect: aiRes.isCorrect,
                feedback: aiRes.feedback,
                criteria: aiRes.criteriaResults,
              });
            }
          }

          qEarned = Math.min(totalSubEarned, qMarks);
          isCorrect = qEarned === qMarks;
        }
        // Case C: Standalone Structured / Short Answer Question
        else {
          const userAns = answers[idx] ?? '';
          const det = gradeDeterministicAnswer(userAns, q);
          if (det.isHandled) {
            qEarned = det.earnedMarks;
            isCorrect = det.isCorrect;
            aiFeedback = det.feedback;
            gradingMethod = 'deterministic';
          } else {
            setGradingProgressText(`AI Examiner evaluating Question ${idx + 1}...`);
            const aiRes = await evaluateAnswerWithGemini(q, undefined, String(userAns));
            qEarned = aiRes.earnedMarks;
            isCorrect = aiRes.isCorrect;
            aiFeedback = aiRes.feedback;
            missingPoints = aiRes.missingKeyPoints;
            criteriaBreakdown = aiRes.criteriaResults;
            gradingMethod = aiRes.evaluatedBy === 'gemini' ? 'ai_gemini' : 'rule_fallback';
          }
        }

        earnedMarks += qEarned;
        topicBreakdown[top].earnedMarks += qEarned;

        qResults.push({
          questionId: q.id,
          questionNumber: idx + 1,
          questionText: q.question_text,
          options: q.options || undefined,
          topic: top,
          maxMarks: qMarks,
          earnedMarks: qEarned,
          isCorrect,
          studentAnswer: answers[idx] !== undefined ? answers[idx] : '',
          correctAnswer: (q.options && q.options.length > 0)
            ? `Option ${String.fromCharCode(65 + resolveMcqCorrectOptionIndex(q))}: ${cleanMcqOptionContent(q.options[resolveMcqCorrectOptionIndex(q)] || '', resolveMcqCorrectOptionIndex(q))}`
            : typeof q.mark_scheme === 'string'
            ? q.mark_scheme
            : Array.isArray(q.mark_scheme?.marking_points)
            ? q.mark_scheme.marking_points.join('; ')
            : undefined,
          misconceptions: (q as any).metadata?.misconceptions || (q as any).misconceptions || [],
          aiFeedback,
          missingPoints,
          criteriaBreakdown,
          gradingMethod,
          subQuestionResults: subResults.length > 0 ? subResults : undefined,
        });
      }

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
        studentClass: candidateClass.trim() || 'General',
        candidateNumber: candidateNumber.trim() || undefined,
        submittedAt: new Date().toISOString(),
        durationSeconds: durationSec,
        score: earnedMarks,
        totalMarks,
        percentage: totalMarks > 0 ? Math.round((earnedMarks / totalMarks) * 100) : 100,
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
      setCompletedSubmission(submission);

      try {
        sessionStorage.removeItem(sessionKey);
      } catch {}

      setIsSubmitted(true);
    } catch (err) {
      console.error('Failed to grade student submission:', err);
      setIsSubmitted(true);
    } finally {
      setIsGrading(false);
    }
  }, [isSubmitted, isGrading, startTime, questions, answers, testIdOrCode, title, headerConfig, candidateName, candidateClass, candidateNumber, violations, sessionKey]);

  // Auto-persist exam state to sessionStorage across page refreshes
  useEffect(() => {
    if (hasStarted && !isSubmitted) {
      try {
        sessionStorage.setItem(
          sessionKey,
          JSON.stringify({
            candidateName,
            candidateClass,
            candidateNumber,
            startTime,
            currentIndex,
            answers,
            flaggedIndices: Array.from(flaggedIndices),
            isExamMode,
            hasStarted,
            isSubmitted,
            timeLeft,
            securityEnabled,
            requireTeacherUnlock,
            teacherPin,
            isLockedByProctor,
            lockReason,
            lockTime,
            violations,
          })
        );
      } catch (e) {
        console.warn('Exam state save error:', e);
      }
    }
  }, [
    sessionKey,
    candidateName,
    candidateClass,
    candidateNumber,
    startTime,
    currentIndex,
    answers,
    flaggedIndices,
    isExamMode,
    hasStarted,
    isSubmitted,
    timeLeft,
    securityEnabled,
    requireTeacherUnlock,
    teacherPin,
    isLockedByProctor,
    lockReason,
    lockTime,
    violations,
  ]);

  // ─── 5. Countdown Timer & Time Remaining Warnings ──────────────────────────
  useEffect(() => {
    if (!hasStarted || isSubmitted || !isExamMode) return;
    if (timeLeft <= 0) {
      handleSubmitExam();
      return;
    }

    if (timeLeft === 300) {
      setTimeWarning('⚠️ 5 Minutes Remaining! Please review and finalize your answers.');
      setTimeout(() => setTimeWarning(null), 6000);
    } else if (timeLeft === 60) {
      setTimeWarning('🚨 1 Minute Remaining! Examination will auto-submit when the countdown reaches zero.');
      setTimeout(() => setTimeWarning(null), 6000);
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

  const handleSubAnswerChange = (subKey: string, val: string) => {
    if (isSubmitted) return;
    setAnswers((prev) => ({ ...prev, [subKey]: val }));
  };

  const handleInsertSymbol = (targetKey: string | number, symbol: string) => {
    if (isSubmitted) return;
    setAnswers((prev) => {
      const currentVal = String(prev[targetKey] || '');
      return { ...prev, [targetKey]: currentVal + symbol };
    });
  };

  const handleToggleFlag = () => {
    setFlaggedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(currentIndex)) next.delete(currentIndex);
      else next.add(currentIndex);
      return next;
    });
  };

  // ─── 8. Scoring & Analytics ────────────────────────────────────────────────
  const calculateResults = () => {
    if (completedSubmission) {
      const earned = completedSubmission.score;
      const total = completedSubmission.totalMarks;
      const pct = completedSubmission.percentage;
      const topicStats: Record<string, { earned: number; total: number }> = {};
      Object.entries(completedSubmission.topicBreakdown).forEach(([k, v]) => {
        topicStats[k] = { earned: v.earnedMarks, total: v.totalMarks };
      });
      return { mcqEarned: earned, mcqTotal: total, percentage: pct, topicStats, questionResults: completedSubmission.questionResults };
    }

    let mcqEarned = 0;
    let mcqTotal = 0;
    const topicStats: Record<string, { earned: number; total: number }> = {};

    questions.forEach((q, idx) => {
      const topic = q.topic || 'General';
      if (!topicStats[topic]) topicStats[topic] = { earned: 0, total: 0 };
      topicStats[topic].total += q.marks || 1;
      mcqTotal += q.marks || 1;

      if (answers[idx] !== undefined) {
        mcqEarned += q.marks || 1;
        topicStats[topic].earned += q.marks || 1;
      }
    });

    const percentage = mcqTotal > 0 ? Math.round((mcqEarned / mcqTotal) * 100) : 100;
    return { mcqEarned, mcqTotal, percentage, topicStats, questionResults: [] };
  };

  // ─── Clean MCQ Option Text & Stem ─────────────────────────────────────────
  const cleanOptionText = (text: string, oIdx: number) => {
    return cleanMcqOptionContent(text, oIdx);
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

  // ─── Loading / Grading / Error Screens ─────────────────────────────────────
  if (loading) {
    return (
      <div className="student-quiz-loading-screen">
        <div className="student-quiz-spinner" />
        <h2>Loading Assessment…</h2>
        <p>Fetching questions and formulas</p>
      </div>
    );
  }

  if (isGrading) {
    return (
      <div className="student-quiz-loading-screen animate-fade-in">
        <div className="student-quiz-spinner" style={{ borderTopColor: '#8b5cf6' }} />
        <h2>Evaluating Assessment Results...</h2>
        <p>{gradingProgressText || 'Analyzing responses with Deterministic Matcher & AI Examiner'}</p>
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
              <span className="rule-icon">🤖</span>
              <div>
                <strong>Marking System</strong>
                <p>Fast-Matcher & AI Examiner active</p>
              </div>
            </div>
            <div className="lobby-rule-item">
              <span className="rule-icon">📊</span>
              <div>
                <strong>Instant Diagnostic</strong>
                <p>Topic mastery & criteria review</p>
              </div>
            </div>
          </div>

          {headerConfig?.instructions && (
            <div className="student-lobby-instructions">
              <strong>Instructions to Candidate:</strong>
              <p>{headerConfig.instructions}</p>
            </div>
          )}

          {/* Candidate Information Form */}
          <div className="student-candidate-name-box" style={{ margin: '16px 0', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 700, marginBottom: 4, color: 'var(--color-text-primary)' }}>
                Candidate Full Name: <span style={{ color: '#ef4444' }}>*</span>
              </label>
              <input
                type="text"
                className="student-name-input"
                value={candidateName}
                onChange={(e) => setCandidateName(e.target.value)}
                placeholder="e.g. Alex Johnson"
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

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 700, marginBottom: 4, color: 'var(--color-text-primary)' }}>
                  Class / Section / Set:
                </label>
                <input
                  type="text"
                  value={candidateClass}
                  onChange={(e) => setCandidateClass(e.target.value)}
                  placeholder="e.g. 10-A, Year 11-1"
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 'var(--radius-md)',
                    border: '1.5px solid var(--color-border)',
                    background: 'var(--color-surface-sunken)',
                    color: 'var(--color-text-primary)',
                    fontSize: '0.8125rem',
                    fontWeight: 600,
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 700, marginBottom: 4, color: 'var(--color-text-primary)' }}>
                  Candidate ID / Seat #:
                </label>
                <input
                  type="text"
                  value={candidateNumber}
                  onChange={(e) => setCandidateNumber(e.target.value)}
                  placeholder="e.g. 0042 or Seat 12"
                  style={{
                    width: '100%',
                    padding: '8px 12px',
                    borderRadius: 'var(--radius-md)',
                    border: '1.5px solid var(--color-border)',
                    background: 'var(--color-surface-sunken)',
                    color: 'var(--color-text-primary)',
                    fontSize: '0.8125rem',
                    fontWeight: 600,
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            </div>
          </div>

          {/* Mode Policy: Locked for Formal Teacher Exams vs Configurable for Practice Previews */}
          {isTeacherLocked ? (
            <div
              style={{
                background: 'var(--color-surface-sunken)',
                border: '1.5px solid var(--color-border)',
                borderRadius: 'var(--radius-lg)',
                padding: '14px 18px',
                margin: '16px 0',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                textAlign: 'left',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span
                  style={{
                    fontSize: '0.8125rem',
                    fontWeight: 800,
                    color: 'var(--color-text-primary)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                  }}
                >
                  🛡️ Formal Examination Policy
                </span>
                <span
                  style={{
                    fontSize: '0.7rem',
                    fontWeight: 800,
                    background: 'rgba(16, 185, 129, 0.15)',
                    color: '#10b981',
                    padding: '3px 8px',
                    borderRadius: '6px',
                    border: '1px solid rgba(16, 185, 129, 0.3)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                  }}
                >
                  Enforced by Teacher
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                <div
                  style={{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-md)',
                    padding: '8px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                  }}
                >
                  <span style={{ fontSize: '1.2rem' }}>⏱️</span>
                  <div>
                    <strong style={{ fontSize: '0.8rem', display: 'block', color: 'var(--color-text-primary)' }}>
                      {isExamMode ? `${Math.round(timeLeft / 60)} Mins Countdown` : 'Self-Paced Practice'}
                    </strong>
                    <span style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)' }}>
                      {isExamMode ? 'Strict timer with auto-submit' : 'No time limit'}
                    </span>
                  </div>
                </div>

                <div
                  style={{
                    background: 'var(--color-surface)',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-md)',
                    padding: '8px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                  }}
                >
                  <span style={{ fontSize: '1.2rem' }}>🔒</span>
                  <div>
                    <strong style={{ fontSize: '0.8rem', display: 'block', color: 'var(--color-text-primary)' }}>
                      {securityEnabled ? 'Anti-Cheating Monitored' : 'Standard Browser'}
                    </strong>
                    <span style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)' }}>
                      {securityEnabled ? 'Fullscreen & tab-switch tracking' : 'Open browser'}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* Practice Preview Mode Selector */}
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

              {/* Quick Switch to Quizizz Game Mode Banner */}
              {onSwitchToGameMode && (
                <div
                  style={{
                    background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.15), rgba(236, 72, 153, 0.15))',
                    border: '1.5px solid rgba(139, 92, 246, 0.4)',
                    borderRadius: 'var(--radius-lg)',
                    padding: '12px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                    marginTop: '16px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <span style={{ fontSize: '1.5rem' }}>🎮</span>
                    <div>
                      <strong style={{ fontSize: '0.875rem', color: 'var(--color-text-primary)', display: 'block' }}>
                        Prefer a gamified Quizizz challenge?
                      </strong>
                      <span style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
                        Play with 4 colored cards, audio effects, power-ups, and streaks!
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="sq-btn"
                    style={{
                      background: 'linear-gradient(135deg, #8b5cf6, #ec4899)',
                      color: '#ffffff',
                      fontWeight: 800,
                      fontSize: '0.8125rem',
                      padding: '8px 14px',
                      whiteSpace: 'nowrap',
                    }}
                    onClick={onSwitchToGameMode}
                  >
                    🎮 Switch to Quizizz Mode
                  </button>
                </div>
              )}
            </>
          )}

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
    // In Formal Exam Mode, do not show scores/solutions until released by teacher
    if (completedSubmission?.status === 'submitted') {
      const durationMin = Math.floor((completedSubmission.durationSeconds || 0) / 60);
      const durationSec = (completedSubmission.durationSeconds || 0) % 60;
      return (
        <div className="student-results-wrap animate-fade-in">
          <div className="student-results-card" style={{ maxWidth: '680px', margin: '0 auto', textAlign: 'center' }}>
            <div
              style={{
                width: '72px',
                height: '72px',
                borderRadius: '50%',
                background: 'rgba(34, 197, 94, 0.15)',
                border: '2px solid rgba(34, 197, 94, 0.4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: '2.5rem',
                margin: '0 auto 16px',
              }}
            >
              🛡️
            </div>
            <div className="results-badge" style={{ background: '#16a34a', color: '#fff' }}>EXAMINATION CONFIRMED</div>
            <h1 className="results-title" style={{ marginTop: '8px' }}>Exam Submitted Successfully 🎉</h1>
            <p className="results-sub" style={{ color: 'var(--color-text-secondary)' }}>
              {title} • Official Candidate Receipt
            </p>

            <div
              style={{
                background: 'var(--color-surface-sunken, #f8fafc)',
                border: '1.5px solid var(--color-border, #e2e8f0)',
                borderRadius: '14px',
                padding: '20px 24px',
                margin: '20px 0',
                textAlign: 'left',
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
                gap: '16px',
              }}
            >
              <div>
                <span style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary, #64748b)', textTransform: 'uppercase', fontWeight: 700 }}>Candidate Name</span>
                <div style={{ fontWeight: 800, fontSize: '1.05rem', color: 'var(--color-text-primary, #0f172a)', marginTop: '2px' }}>{candidateName || 'Candidate'}</div>
              </div>
              {candidateNumber && (
                <div>
                  <span style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary, #64748b)', textTransform: 'uppercase', fontWeight: 700 }}>Candidate / Seat #</span>
                  <div style={{ fontWeight: 800, fontSize: '1.05rem', color: 'var(--color-text-primary, #0f172a)', marginTop: '2px' }}>{candidateNumber}</div>
                </div>
              )}
              <div>
                <span style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary, #64748b)', textTransform: 'uppercase', fontWeight: 700 }}>Class / Section</span>
                <div style={{ fontWeight: 800, fontSize: '1.05rem', color: 'var(--color-text-primary, #0f172a)', marginTop: '2px' }}>{candidateClass || 'General'}</div>
              </div>
              <div>
                <span style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary, #64748b)', textTransform: 'uppercase', fontWeight: 700 }}>Time Submitted</span>
                <div style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--color-text-primary, #0f172a)', marginTop: '2px' }}>
                  {new Date(completedSubmission.submittedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </div>
              </div>
              <div>
                <span style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary, #64748b)', textTransform: 'uppercase', fontWeight: 700 }}>Exam Duration</span>
                <div style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--color-text-primary, #0f172a)', marginTop: '2px' }}>
                  {durationMin}m {durationSec}s
                </div>
              </div>
              <div>
                <span style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary, #64748b)', textTransform: 'uppercase', fontWeight: 700 }}>Proctoring Status</span>
                <div style={{ fontWeight: 800, fontSize: '0.95rem', color: violations.length === 0 ? '#16a34a' : '#d97706', marginTop: '2px' }}>
                  {violations.length === 0 ? 'Clean (0 Strikes) ✅' : `${violations.length} Warning(s) Logged ⚠️`}
                </div>
              </div>
            </div>

            {/* Personal Access PIN Card — High-contrast security ticket */}
            {completedSubmission.resultPin && (
              <div
                style={{
                  background: '#0f172a',
                  border: '2px solid #f59e0b',
                  borderRadius: '16px',
                  padding: '24px',
                  margin: '20px 0',
                  textAlign: 'center',
                  boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.3), 0 0 20px rgba(245, 158, 11, 0.2)',
                  color: '#ffffff',
                }}
              >
                <div style={{ fontSize: '0.8125rem', color: '#fbbf24', textTransform: 'uppercase', fontWeight: 800, letterSpacing: '0.08em', marginBottom: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                  <span>🔐</span> YOUR PERSONAL ACCESS PIN
                </div>

                <div
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgba(245, 158, 11, 0.12)',
                    border: '2px dashed #f59e0b',
                    borderRadius: '12px',
                    padding: '8px 24px 8px 34px',
                    margin: '6px 0 14px',
                  }}
                >
                  <span
                    style={{
                      fontSize: '3.25rem',
                      fontWeight: 900,
                      fontFamily: 'monospace',
                      letterSpacing: '0.28em',
                      color: '#ffffff',
                      textShadow: '0 2px 14px rgba(245, 158, 11, 0.5)',
                      lineHeight: 1.1,
                    }}
                  >
                    {completedSubmission.resultPin}
                  </span>
                </div>

                <div style={{ marginBottom: '12px' }}>
                  <button
                    type="button"
                    onClick={() => {
                      if (completedSubmission?.resultPin) {
                        navigator.clipboard?.writeText(completedSubmission.resultPin);
                        setHasCopiedPin(true);
                        setTimeout(() => setHasCopiedPin(false), 2500);
                      }
                    }}
                    style={{
                      background: hasCopiedPin ? '#16a34a' : 'rgba(255, 255, 255, 0.12)',
                      border: '1px solid rgba(255, 255, 255, 0.25)',
                      color: '#ffffff',
                      padding: '6px 14px',
                      borderRadius: '8px',
                      fontSize: '0.8125rem',
                      fontWeight: 700,
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}
                  >
                    {hasCopiedPin ? '✅ PIN Copied to Clipboard!' : '📋 Copy PIN'}
                  </button>
                </div>

                <div style={{ fontSize: '0.875rem', color: '#cbd5e1', lineHeight: '1.5', maxWidth: '520px', margin: '0 auto' }}>
                  ⚠️ <strong style={{ color: '#fbbf24' }}>Important:</strong> Please write down or screenshot this 3-digit PIN. You will need it together with your name to view your marked paper and examiner notes when results are released.
                </div>
              </div>
            )}

            {/* Examiner Evaluation Card — High-contrast alert */}
            <div
              style={{
                background: 'rgba(37, 99, 235, 0.07)',
                border: '1.5px solid rgba(37, 99, 235, 0.25)',
                borderRadius: '14px',
                padding: '18px 20px',
                margin: '20px 0',
                textAlign: 'left',
                display: 'flex',
                gap: '14px',
                alignItems: 'flex-start',
              }}
            >
              <span style={{ fontSize: '1.75rem', lineHeight: 1 }}>ℹ️</span>
              <div style={{ fontSize: '0.875rem', lineHeight: '1.6', color: 'var(--color-text-primary, #0f172a)' }}>
                <strong style={{ fontSize: '0.95rem', display: 'block', marginBottom: '4px', color: 'var(--color-text-primary, #1e3a8a)' }}>
                  Examiner Evaluation in Progress
                </strong>
                <span style={{ color: 'var(--color-text-secondary, #334155)', display: 'block', marginBottom: '10px' }}>
                  Your responses have been securely recorded and synced to the examiner's database. In accordance with formal exam standards, marks, model solutions, and Cambridge advice will be released after teacher review.
                </span>
                <div
                  style={{
                    background: 'rgba(37, 99, 235, 0.1)',
                    border: '1px solid rgba(37, 99, 235, 0.2)',
                    borderRadius: '8px',
                    padding: '8px 12px',
                    color: '#1d4ed8',
                    fontWeight: 700,
                    fontSize: '0.8125rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                  }}
                >
                  <span>🔑</span>
                  <span>
                    When results are published, enter Exam Code <strong>({testIdOrCode || 'EXAM'})</strong> on the portal to view your marked paper and download your official PDF report.
                  </span>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'center', gap: '12px', marginTop: '24px' }}>
              {onExit && (
                <button
                  type="button"
                  className="sq-btn sq-btn-primary"
                  style={{
                    padding: '12px 32px',
                    fontSize: '1rem',
                    fontWeight: 700,
                    borderRadius: '10px',
                  }}
                  onClick={onExit}
                >
                  ← Return to Portal
                </button>
              )}
            </div>
          </div>
        </div>
      );
    }

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
                <span>Total Questions / Parts:</span>
                <strong>{quizStats.totalItems}</strong>
              </div>
              <div className="stat-row">
                <span>Questions Attempted:</span>
                <strong>{quizStats.answeredItems} of {quizStats.totalItems}</strong>
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
                    <span className="proctoring-time">{formatProctorTimestamp(v.timestamp)}</span>
                    <span className="proctoring-detail">{v.detail}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Solutions & Detailed Diagnostic Walkthrough */}
          <div className="results-solutions-box">
            <h3 className="results-section-heading">🔑 Question-by-Question Marking & AI Examiner Review</h3>
            <div className="solutions-list">
              {questions.map((q, idx) => {
                const qRes = results.questionResults.find((r) => r.questionNumber === idx + 1);
                const earnedM = qRes?.earnedMarks ?? (answers[idx] !== undefined ? q.marks || 1 : 0);
                const maxM = q.marks || 1;
                const isFullCredit = earnedM === maxM;

                return (
                  <div key={idx} className="solution-item-card">
                    <div className="sol-card-header">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <strong>Question {idx + 1}</strong>
                        {qRes?.gradingMethod && (
                          <span className="sq-grading-method-tag">
                            {qRes.gradingMethod === 'mcq'
                              ? '🔘 MCQ'
                              : qRes.gradingMethod === 'deterministic'
                              ? '⚡ Fast-Match'
                              : '🤖 AI Examiner'}
                          </span>
                        )}
                      </div>
                      <span
                        className="sq-score-badge"
                        style={{
                          background: isFullCredit ? 'rgba(34, 197, 94, 0.15)' : earnedM > 0 ? 'rgba(234, 179, 8, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                          color: isFullCredit ? '#22c55e' : earnedM > 0 ? '#eab308' : '#ef4444',
                          fontWeight: 800,
                          padding: '4px 10px',
                          borderRadius: '999px',
                          fontSize: '0.8125rem',
                        }}
                      >
                        {isFullCredit ? '✓ ' : earnedM > 0 ? '⚠️ ' : '✗ '}
                        {earnedM} / {maxM} Mark{maxM !== 1 ? 's' : ''}
                      </span>
                    </div>

                    <div className="sol-stem">
                      <ExamMathText content={cleanQuestionStem(q.question_text || '', q.options)} />
                    </div>

                    {/* Question Diagram if present */}
                    {q.diagram_url && (
                      <div className="sol-diagram-wrap" style={{ margin: '12px 0', textAlign: 'center' }}>
                        <img
                          src={q.diagram_url}
                          alt={`Diagram for Question ${idx + 1}`}
                          style={{
                            maxWidth: '100%',
                            maxHeight: '340px',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid var(--color-border)',
                            cursor: 'zoom-in',
                            background: '#ffffff',
                          }}
                          onClick={() => setZoomedImage(q.diagram_url || null)}
                          title="Click to zoom diagram"
                        />
                      </div>
                    )}

                    {/* Sub-Questions Results Breakdown if present */}
                    {qRes?.subQuestionResults && qRes.subQuestionResults.length > 0 && (
                      <div className="sol-sub-results-list" style={{ margin: '12px 0', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                        {qRes.subQuestionResults.map((sub, sIdx) => {
                          const subQ = q.sub_questions?.[sIdx];
                          return (
                            <div
                              key={sIdx}
                              style={{
                                background: 'var(--color-surface-sunken)',
                                padding: '12px 16px',
                                borderRadius: 'var(--radius-md)',
                                border: '1px solid var(--color-border)',
                              }}
                            >
                              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                                <strong>Part ({sub.subId})</strong>
                                <span style={{ color: sub.isCorrect ? '#22c55e' : '#ef4444', fontWeight: 700, fontSize: '0.8125rem' }}>
                                  {sub.earnedMarks} / {sub.maxMarks} mark{sub.maxMarks !== 1 ? 's' : ''}
                                </span>
                              </div>

                              {/* Sub Question Prompt & Table if present */}
                              {subQ?.question_text && (
                                <div style={{ fontSize: '0.875rem', marginBottom: 8, color: 'var(--color-text-primary)' }}>
                                  <ExamMathText content={subQ.question_text} />
                                </div>
                              )}

                              {/* Sub Question Diagram if present */}
                              {subQ?.diagram_url && (
                                <div style={{ margin: '8px 0', textAlign: 'center' }}>
                                  <img
                                    src={subQ.diagram_url}
                                    alt={`Diagram for Part (${sub.subId})`}
                                    style={{
                                      maxWidth: '100%',
                                      maxHeight: '260px',
                                      borderRadius: 'var(--radius-md)',
                                      border: '1px solid var(--color-border)',
                                      cursor: 'zoom-in',
                                      background: '#ffffff',
                                    }}
                                    onClick={() => setZoomedImage(subQ.diagram_url || null)}
                                    title="Click to zoom diagram"
                                  />
                                </div>
                              )}

                              <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', marginBottom: sub.feedback ? 4 : 0 }}>
                                Your Answer:{' '}
                                <strong style={{ color: 'var(--color-text-primary)' }}>
                                  <ExamMathText content={String(sub.studentAnswer || '(blank)')} />
                                </strong>
                              </div>
                              {sub.feedback && (
                                <div style={{ fontSize: '0.75rem', color: sub.isCorrect ? '#22c55e' : 'var(--color-text-secondary)', marginTop: 2 }}>
                                  <ExamMathText content={sub.feedback} />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Point-by-Point Criteria Breakdown */}
                    {qRes?.criteriaBreakdown && qRes.criteriaBreakdown.length > 0 && (
                      <div className="sol-criteria-box" style={{ margin: '12px 0' }}>
                        <strong style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 6 }}>
                          📋 Mark Scheme Criteria Breakdown:
                        </strong>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {qRes.criteriaBreakdown.map((crit, cIdx) => (
                            <div
                              key={cIdx}
                              style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: '8px',
                                fontSize: '0.8125rem',
                                color: crit.achieved ? '#22c55e' : 'var(--color-text-secondary)',
                                background: crit.achieved ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)',
                                padding: '6px 10px',
                                borderRadius: 'var(--radius-sm)',
                                border: `1px solid ${crit.achieved ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`,
                              }}
                            >
                              <span style={{ fontWeight: 800 }}>{crit.achieved ? '✓' : '✗'}</span>
                              <div style={{ flex: 1 }}>
                                <div>
                                  <ExamMathText content={crit.point} />
                                </div>
                                {crit.examinerNote && (
                                  <div style={{ fontSize: '0.75rem', opacity: 0.85, marginTop: 2, fontStyle: 'italic' }}>
                                    <ExamMathText content={`Note: ${crit.examinerNote}`} />
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* AI Feedback & Missing Keypoints */}
                    {qRes?.aiFeedback && (
                      <div
                        className="sol-ai-feedback"
                        style={{
                          background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.12), rgba(59, 130, 246, 0.12))',
                          border: '1px solid rgba(139, 92, 246, 0.35)',
                          borderRadius: 'var(--radius-md)',
                          padding: '10px 14px',
                          margin: '10px 0',
                          fontSize: '0.8125rem',
                        }}
                      >
                        <strong style={{ color: '#a78bfa', display: 'block', marginBottom: 4 }}>💡 Examiner Feedback:</strong>
                        <div style={{ margin: 0, color: 'var(--color-text-primary)' }}>
                          <ExamMathText content={qRes.aiFeedback} />
                        </div>
                      </div>
                    )}

                    {/* Official Cambridge Mark Scheme Structured Breakdown */}
                    <div className="sol-points" style={{ marginTop: '12px' }}>
                      <strong style={{ display: 'block', marginBottom: '6px', color: 'var(--color-text-primary)' }}>
                        Official Model Answer & Mark Scheme:
                      </strong>
                      {renderStructuredModelAnswer(q.mark_scheme)}
                    </div>

                    {q.mark_scheme?.guidance && q.mark_scheme.guidance.length > 0 && (
                      <div className="sol-guidance" style={{ marginTop: 8 }}>
                        💡 <strong>Examiner Guidance:</strong> <ExamMathText content={q.mark_scheme.guidance.join('; ')} />
                      </div>
                    )}
                    {q.mark_scheme?.common_misconceptions && q.mark_scheme.common_misconceptions.length > 0 && (
                      <div className="sol-traps" style={{ marginTop: 6 }}>
                        ⚠️ <strong>Common Pitfall:</strong> <ExamMathText content={q.mark_scheme.common_misconceptions.join('; ')} />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="results-footer-actions" style={{ display: 'flex', gap: '12px', justifyContent: 'center', marginTop: '24px', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="sq-btn"
              style={{
                background: '#dc2626',
                color: '#ffffff',
                fontWeight: 800,
                padding: '10px 20px',
                borderRadius: '8px',
                border: 'none',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '0.9375rem',
                boxShadow: '0 4px 12px rgba(220, 38, 38, 0.3)',
              }}
              onClick={() => {
                const results = calculateResults();
                const submissionToExport: StudentSubmission = completedSubmission || {
                  id: `sub_${Date.now()}`,
                  quizId: testIdOrCode || 'direct_quiz',
                  quizCode: testIdOrCode || 'EXAM',
                  quizTitle: title,
                  subject: headerConfig?.subject || 'Chemistry',
                  studentName: candidateName.trim() || 'Candidate',
                  submittedAt: new Date().toISOString(),
                  durationSeconds: Math.floor((Date.now() - startTime) / 1000),
                  score: results.mcqEarned,
                  totalMarks: results.mcqTotal,
                  percentage: results.percentage,
                  violationsCount: violations.length,
                  proctoringLogs: violations.map((v, i) => ({
                    timestamp: v.timestamp,
                    event: v.detail,
                    strike: i + 1,
                    severity: v.type === 'blocked_shortcut' ? 'critical' : 'warning',
                  })),
                  questionResults: results.questionResults,
                  topicBreakdown: Object.fromEntries(
                    Object.entries(results.topicStats).map(([topic, stat]) => [
                      topic,
                      {
                        totalMarks: stat.total,
                        earnedMarks: stat.earned,
                        percentage: stat.total > 0 ? Math.round((stat.earned / stat.total) * 100) : 0,
                      },
                    ])
                  ),
                };
                exportIndividualStudentReportPdf(submissionToExport);
              }}
            >
              📄 Download My Exam Report (PDF)
            </button>

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
          {/* Interactive Exam Reference Tools: Periodic Table, Scientific Calculator, Resource Booklet */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              className="sq-btn"
              style={{
                background: 'rgba(16, 185, 129, 0.15)',
                color: '#34d399',
                border: '1px solid rgba(16, 185, 129, 0.35)',
                borderRadius: '8px',
                fontSize: '0.8125rem',
                fontWeight: 700,
                padding: '6px 12px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                cursor: 'pointer',
              }}
              onClick={() => setShowResourceBooklet(true)}
              title="Open Cambridge Insert / Resource Booklet (Maps, Photos, Figures)"
            >
              <span>📖</span>
              <span>Resource Booklet</span>
            </button>

            <button
              type="button"
              className="sq-btn"
              style={{
                background: 'rgba(56, 189, 248, 0.15)',
                color: '#38bdf8',
                border: '1px solid rgba(56, 189, 248, 0.35)',
                borderRadius: '8px',
                fontSize: '0.8125rem',
                fontWeight: 700,
                padding: '6px 12px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                cursor: 'pointer',
              }}
              onClick={() => setShowPeriodicTable(true)}
              title="Open Cambridge Periodic Table of Elements & Physical Constants"
            >
              <span>🧪</span>
              <span>Periodic Table</span>
            </button>

            <button
              type="button"
              className="sq-btn"
              style={{
                background: 'rgba(139, 92, 246, 0.15)',
                color: '#c084fc',
                border: '1px solid rgba(139, 92, 246, 0.35)',
                borderRadius: '8px',
                fontSize: '0.8125rem',
                fontWeight: 700,
                padding: '6px 12px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                cursor: 'pointer',
              }}
              onClick={() => setShowCalculator(true)}
              title="Open On-Screen Scientific Calculator"
            >
              <span>🧮</span>
              <span>Calculator</span>
            </button>
          </div>

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
            onClick={() => setShowSubmitModal(true)}
          >
            Finish & Submit
          </button>
        </div>
      </header>

      {/* Time Remaining Warning Banner */}
      {timeWarning && (
        <div
          className="animate-fade-in"
          style={{
            background: 'linear-gradient(135deg, #f59e0b, #d97706)',
            color: '#ffffff',
            padding: '10px 18px',
            fontWeight: 800,
            fontSize: '0.875rem',
            textAlign: 'center',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            boxShadow: '0 4px 12px rgba(217, 119, 6, 0.3)',
          }}
        >
          <span>{timeWarning}</span>
          <button
            type="button"
            onClick={() => setTimeWarning(null)}
            style={{
              background: 'rgba(0,0,0,0.2)',
              border: 'none',
              color: '#ffffff',
              borderRadius: '4px',
              padding: '2px 6px',
              cursor: 'pointer',
              marginLeft: '8px',
              fontSize: '0.75rem',
            }}
          >
            Dismiss
          </button>
        </div>
      )}

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

            {/* Insert / Resource Booklet Trigger Button */}
            {(currentQuestion?.resource_ref || currentQuestion?.diagram_source === 'insert') && (
              <div style={{ margin: '8px 0 12px' }}>
                <button
                  type="button"
                  className="sq-btn"
                  style={{
                    background: 'rgba(14, 165, 233, 0.12)',
                    color: '#0284c7',
                    border: '1px solid rgba(14, 165, 233, 0.35)',
                    borderRadius: '8px',
                    fontSize: '0.8125rem',
                    fontWeight: 700,
                    padding: '6px 14px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '8px',
                    cursor: 'pointer',
                  }}
                  onClick={() => setShowResourceBooklet(true)}
                  title="Open Resource Booklet to view maps, photos, or diagrams referenced in this question"
                >
                  <span>📖</span>
                  <span>Open {currentQuestion.resource_ref || 'Figure / Map'} in Resource Booklet</span>
                  <span style={{ fontSize: '0.75rem', opacity: 0.8 }}>↗</span>
                </button>
              </div>
            )}

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

            {/* 1. Multi-Part Sub-Questions Stream if structured */}
            {currentQuestion?.sub_questions && currentQuestion.sub_questions.length > 0 ? (
              <div className="sq-sub-questions-list" style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
                {currentQuestion.sub_questions.map((sub, sIdx) => {
                  const subKey = `${currentIndex}_${sIdx}`;
                  const subVal = String(answers[subKey] || '');
                  return (
                    <div
                      key={sIdx}
                      className="sq-sub-card"
                      style={{
                        background: 'var(--color-surface-sunken)',
                        padding: '16px',
                        borderRadius: 'var(--radius-lg)',
                        border: '1px solid var(--color-border)',
                      }}
                    >
                      <div className="sq-sub-header" style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 10 }}>
                        <span className="sq-sub-id" style={{ fontWeight: 800, color: 'var(--color-primary-500)' }}>({sub.sub_id})</span>
                        <div className="sq-sub-text" style={{ flex: 1 }}>
                          <ExamMathText content={sub.question_text || ''} />
                        </div>
                        <span className="sq-sub-marks" style={{ fontWeight: 700, fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                          [{sub.marks || 1} mark{sub.marks !== 1 ? 's' : ''}]
                        </span>
                      </div>

                      {/* Sub-Question Diagram (if specifically attached to this sub-part) */}
                      {sub.diagram_url && (
                        <div className="sq-sub-diagram-wrap" style={{ margin: '8px 0 12px' }}>
                          <img
                            src={sub.diagram_url}
                            alt={`Diagram for ${sub.sub_id}`}
                            className="sq-q-diagram-img"
                            style={{ maxHeight: '280px', borderRadius: '8px', cursor: 'zoom-in' }}
                            onClick={() => setZoomedImage(sub.diagram_url || null)}
                            title="Click to zoom diagram"
                          />
                        </div>
                      )}

                      {/* Quick Symbol Insert Bar for sub-question */}
                      <div className="sq-symbol-toolbar" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', marginBottom: 8 }}>
                        <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--color-text-secondary)', marginRight: 4 }}>Insert:</span>
                        {QUICK_CHEM_SYMBOLS.map((sym) => (
                          <button
                            key={sym}
                            type="button"
                            className="sq-sym-pill"
                            style={{
                              background: 'var(--color-surface-elevated)',
                              border: '1px solid var(--color-border)',
                              borderRadius: 'var(--radius-sm)',
                              padding: '2px 6px',
                              fontSize: '0.75rem',
                              cursor: 'pointer',
                              color: 'var(--color-text-primary)',
                            }}
                            onClick={() => handleInsertSymbol(subKey, sym)}
                            title={`Insert ${sym}`}
                          >
                            {sym}
                          </button>
                        ))}
                      </div>

                      <div className="sq-sub-input-wrap">
                        <textarea
                          className="sq-text-answer-area"
                          placeholder={`Type answer for part (${sub.sub_id})...`}
                          value={subVal}
                          onChange={(e) => handleSubAnswerChange(subKey, e.target.value)}
                          rows={3}
                          style={{
                            width: '100%',
                            padding: '10px 14px',
                            borderRadius: 'var(--radius-md)',
                            border: '1.5px solid var(--color-border)',
                            background: 'var(--color-surface)',
                            color: 'var(--color-text-primary)',
                            fontSize: '0.875rem',
                            outline: 'none',
                            boxSizing: 'border-box',
                          }}
                        />
                        {subVal.trim() && (
                          <div style={{ marginTop: 6, fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                            <span style={{ fontWeight: 700, marginRight: 6 }}>Live Preview:</span>
                            <ExamMathText content={subVal} />
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : currentQuestion?.options && currentQuestion.options.length > 0 ? (
              /* 2. MCQ Choices Input */
              <div className="sq-choices-list">
                {currentQuestion.options.map((optionText, oIdx) => {
                  const isSelected = Number(answers[currentIndex]) === oIdx;
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
              /* 3. Structured Single Response Text Box */
              <div className="sq-structured-input-box" style={{ marginTop: 16 }}>
                <label className="sq-input-label" style={{ display: 'block', fontSize: '0.875rem', fontWeight: 700, marginBottom: 8 }}>
                  Your Response / Chemical Formula / Calculation:
                </label>

                {/* Quick Symbol Insert Bar */}
                <div className="sq-symbol-toolbar" style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--color-text-secondary)', marginRight: 4 }}>Insert:</span>
                  {QUICK_CHEM_SYMBOLS.map((sym) => (
                    <button
                      key={sym}
                      type="button"
                      className="sq-sym-pill"
                      style={{
                        background: 'var(--color-surface-elevated)',
                        border: '1px solid var(--color-border)',
                        borderRadius: 'var(--radius-sm)',
                        padding: '2px 6px',
                        fontSize: '0.75rem',
                        cursor: 'pointer',
                        color: 'var(--color-text-primary)',
                      }}
                      onClick={() => handleInsertSymbol(currentIndex, sym)}
                      title={`Insert ${sym}`}
                    >
                      {sym}
                    </button>
                  ))}
                </div>

                <textarea
                  className="sq-text-answer-area"
                  placeholder="Type your final answer, chemical equation, or calculation steps here..."
                  value={String(answers[currentIndex] || '')}
                  onChange={(e) => handleTextAnswerChange(e.target.value)}
                  rows={5}
                />
                {answers[currentIndex] && typeof answers[currentIndex] === 'string' && String(answers[currentIndex]).trim() && (
                  <div style={{ marginTop: 6, fontSize: '0.8125rem', color: 'var(--color-text-secondary)' }}>
                    <span style={{ fontWeight: 700, marginRight: 6 }}>Live Preview:</span>
                    <ExamMathText content={String(answers[currentIndex])} />
                  </div>
                )}
              </div>
            )}

            {/* Bottom Actions Row */}
            <div className="sq-q-nav-actions" style={{ marginTop: 24 }}>
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
                    setShowSubmitModal(true);
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
              {quizStats.answeredItems} of {quizStats.totalItems} Items Answered
            </p>

            <div className="sq-nav-matrix-grid">
              {questions.map((_, idx) => {
                const isAnswered = answers[idx] !== undefined || Object.keys(answers).some((k) => String(k).startsWith(`${idx}_`));
                const isCurrent = currentIndex === idx;
                const isFlagged = flaggedIndices.has(idx);

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

      {/* In-App Submit Confirmation Modal (Preserves Window Focus & Fullscreen) */}
      {showSubmitModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 99999,
            background: 'rgba(15, 23, 42, 0.85)',
            backdropFilter: 'blur(8px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '16px',
          }}
          {...submitModalDismiss}
        >
          <div
            style={{
              background: 'var(--color-surface, #1e293b)',
              border: '1.5px solid var(--color-border, rgba(255, 255, 255, 0.15))',
              borderRadius: '20px',
              maxWidth: '440px',
              width: '100%',
              padding: '24px',
              boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)',
              textAlign: 'center',
              color: 'var(--color-text-primary, #ffffff)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: '2.5rem', marginBottom: '12px' }}>📝</div>
            <h3 style={{ fontSize: '1.25rem', fontWeight: 800, margin: '0 0 8px' }}>
              Submit Examination?
            </h3>
            <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary, #94a3b8)', margin: '0 0 16px' }}>
              Are you ready to submit your exam? Your responses will be evaluated against the mark scheme.
            </p>

            {/* Answered vs Unanswered summary */}
            <div
              style={{
                background: quizStats.unansweredItems > 0 ? 'rgba(239, 68, 68, 0.12)' : 'rgba(16, 185, 129, 0.12)',
                border: `1px solid ${quizStats.unansweredItems > 0 ? 'rgba(239, 68, 68, 0.3)' : 'rgba(16, 185, 129, 0.3)'}`,
                borderRadius: '12px',
                padding: '10px 14px',
                marginBottom: '20px',
                fontSize: '0.8125rem',
                display: 'flex',
                justifyContent: 'space-around',
              }}
            >
              <div>
                <span style={{ color: 'var(--color-text-secondary, #94a3b8)' }}>Answered:</span>{' '}
                <strong style={{ color: '#10b981' }}>{quizStats.answeredItems}</strong>
              </div>
              <div>
                <span style={{ color: 'var(--color-text-secondary, #94a3b8)' }}>Unanswered:</span>{' '}
                <strong style={{ color: quizStats.unansweredItems > 0 ? '#ef4444' : '#10b981' }}>{quizStats.unansweredItems}</strong>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
              <button
                type="button"
                className="sq-btn sq-btn-secondary"
                style={{ flex: 1, padding: '10px 16px', fontWeight: 700 }}
                onClick={() => setShowSubmitModal(false)}
              >
                Continue Exam
              </button>
              <button
                type="button"
                className="sq-btn sq-btn-finish"
                style={{ flex: 1, padding: '10px 16px', fontWeight: 800 }}
                onClick={() => {
                  handleSubmitExam();
                }}
              >
                🚀 Confirm & Submit
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Zoom Modal */}
      {zoomedImage && (
        <div className="sq-zoom-modal-backdrop" {...zoomModalDismiss}>
          <div className="sq-zoom-modal-content" onClick={(e) => e.stopPropagation()}>
            <img src={zoomedImage} alt="Zoomed diagram" className="sq-zoomed-img" />
            <button className="sq-zoom-close-btn" onClick={() => setZoomedImage(null)}>✕ Close</button>
          </div>
        </div>
      )}

      {/* Cambridge Chemistry Reference Sheet & Periodic Table Drawer */}
      <PeriodicTableDrawer
        isOpen={showPeriodicTable}
        onClose={() => setShowPeriodicTable(false)}
      />

      {/* On-Screen Scientific Calculator Modal */}
      <ScientificCalculatorModal
        isOpen={showCalculator}
        onClose={() => setShowCalculator(false)}
      />

      {/* Cambridge Insert / Resource Booklet Drawer */}
      <ResourceBookletDrawer
        isOpen={showResourceBooklet}
        onClose={() => setShowResourceBooklet(false)}
        questions={questions}
        activeResourceRef={currentQuestion?.resource_ref}
        subject={headerConfig?.subject || 'Geography'}
        title={`${title} — Resource Booklet`}
      />

      {/* 🚨 Fullscreen Exam Lockdown Overlay (Requires Teacher / Invigilator PIN) */}
      {isLockedByProctor && hasStarted && !isSubmitted && (
        <div className="sq-lockdown-overlay animate-fade-in">
          <div className="sq-lockdown-card animate-scale-up" onClick={(e) => e.stopPropagation()}>
            <div className="sq-lockdown-icon-wrap">
              <span className="sq-lockdown-pulse-ring" />
              <span className="sq-lockdown-icon">🚨</span>
            </div>

            <h2 className="sq-lockdown-title">EXAMINATION LOCKED</h2>
            <p className="sq-lockdown-subtitle">
              An unauthorized action was detected. This assessment has been temporarily locked to maintain exam integrity.
            </p>

            {/* Incident Details Card */}
            <div className="sq-lockdown-details-box">
              <div className="sq-lockdown-row">
                <span className="sq-ld-lbl">Violation Event:</span>
                <span className="sq-ld-val text-danger">{lockReason || 'Exam window lost focus / Alt+Tab'}</span>
              </div>
              <div className="sq-lockdown-row">
                <span className="sq-ld-lbl">Detected At:</span>
                <span className="sq-ld-val">{formatProctorTimestamp(lockTime || new Date().toISOString())}</span>
              </div>
              <div className="sq-lockdown-row">
                <span className="sq-ld-lbl">Integrity Strikes:</span>
                <span className="sq-ld-val" style={{ color: '#ea580c', fontWeight: 800 }}>
                  Strike {violations.length} recorded
                </span>
              </div>
              {isExamMode && (
                <div className="sq-lockdown-row">
                  <span className="sq-ld-lbl">Remaining Time:</span>
                  <span className="sq-ld-val" style={{ fontFamily: 'monospace', fontWeight: 800 }}>
                    ⏱️ {formatTimer(timeLeft)}
                  </span>
                </div>
              )}
            </div>

            {/* Invigilator PIN Input Form */}
            <form className="sq-lockdown-form" onSubmit={handleUnlockWithPin}>
              <div className="sq-ld-form-header">
                <span className="sq-ld-key-icon">🔑</span>
                <span>Proctor / Teacher Unlock Gate</span>
              </div>
              <p className="sq-ld-form-desc">
                Please raise your hand and notify your teacher or invigilator to enter the authorization PIN.
              </p>

              <div className="sq-ld-input-row">
                <input
                  type="password"
                  className={`sq-ld-pin-input ${pinError ? 'sq-ld-input--error animate-shake' : ''}`}
                  value={pinInput}
                  onChange={(e) => {
                    setPinInput(e.target.value);
                    if (pinError) setPinError(null);
                  }}
                  placeholder="Enter Teacher PIN"
                  maxLength={20}
                  autoFocus
                  disabled={isUnlocking}
                />
                <button
                  type="submit"
                  className="sq-btn sq-ld-unlock-btn"
                  disabled={isUnlocking || !pinInput.trim()}
                >
                  {isUnlocking ? 'Unlocking...' : '🔓 Unlock Exam'}
                </button>
              </div>

              {pinError && (
                <div className="sq-ld-error-msg animate-fade-in">
                  {pinError}
                </div>
              )}
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
