import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import type { Question } from '../types/database';
import type { ExamHeaderConfig } from '../services/testBuilderService';
import { resolveStudentQuiz } from '../services/quizCodeService';
import {
  saveQuizSubmission,
  type StudentSubmission,
  type QuestionSubmissionResult,
} from '../services/quizSubmissionService';
import { gradeDeterministicAnswer } from '../services/deterministicGradingService';
import { evaluateAnswerWithGemini } from '../services/aiGradingService';
import { ExamMathText } from '../components/ExamMathText';
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
  const [candidateName, setCandidateName] = useState<string>(() => savedExam?.candidateName || `Candidate ${Math.floor(1000 + Math.random() * 9000)}`);
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

  // Grading & AI Evaluation State
  const [isGrading, setIsGrading] = useState<boolean>(false);
  const [gradingProgressText, setGradingProgressText] = useState<string>('');
  const [completedSubmission, setCompletedSubmission] = useState<StudentSubmission | null>(null);

  // 🔒 Security & Anti-Cheating State
  const [securityEnabled, setSecurityEnabled] = useState(() => savedExam?.securityEnabled ?? true);
  const [violations, setViolations] = useState<ViolationRecord[]>(() => savedExam?.violations || []);
  const [securityAlert, setSecurityAlert] = useState<string | null>(null);
  const [showSubmitModal, setShowSubmitModal] = useState<boolean>(false);
  const isSubmittingRef = useRef<boolean>(false);

  // Diagram Zoom
  const [zoomedImage, setZoomedImage] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

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

  // ─── 2. Violation Logger ───────────────────────────────────────────────────
  const logViolation = useCallback(
    (type: ViolationRecord['type'], detail: string) => {
      if (!hasStarted || isSubmitted || isGrading || isSubmittingRef.current || !securityEnabled) return;
      const now = new Date().toLocaleTimeString();
      const rec: ViolationRecord = { type, timestamp: now, detail };
      setViolations((prev) => [...prev, rec]);
      setSecurityAlert(`⚠️ SECURITY VIOLATION: ${detail} (Recorded at ${now})`);
    },
    [hasStarted, isSubmitted, isGrading, securityEnabled]
  );

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
    setGradingProgressText('Evaluating answers with Deterministic Matcher & AI Examiner...');

    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }

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
          const correctIdx = (q as any).correct_option !== undefined ? (q as any).correct_option : 0;
          if (userAns !== undefined && Number(userAns) === correctIdx) {
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
          topic: top,
          maxMarks: qMarks,
          earnedMarks: qEarned,
          isCorrect,
          studentAnswer: answers[idx] !== undefined ? answers[idx] : '',
          correctAnswer: typeof q.mark_scheme === 'string'
            ? q.mark_scheme
            : Array.isArray(q.mark_scheme?.marking_points)
            ? q.mark_scheme.marking_points.join('; ')
            : (q.options ? q.options[0] : undefined),
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
  }, [isSubmitted, isGrading, startTime, questions, answers, testIdOrCode, title, headerConfig, candidateName, violations, sessionKey]);

  // Auto-persist exam state to sessionStorage across page refreshes
  useEffect(() => {
    if (hasStarted && !isSubmitted) {
      try {
        sessionStorage.setItem(
          sessionKey,
          JSON.stringify({
            candidateName,
            startTime,
            currentIndex,
            answers,
            flaggedIndices: Array.from(flaggedIndices),
            isExamMode,
            hasStarted,
            isSubmitted,
            timeLeft,
            securityEnabled,
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
    startTime,
    currentIndex,
    answers,
    flaggedIndices,
    isExamMode,
    hasStarted,
    isSubmitted,
    timeLeft,
    securityEnabled,
    violations,
  ]);

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
                    <span className="proctoring-time">{v.timestamp}</span>
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

                    {/* Sub-Questions Results Breakdown if present */}
                    {qRes?.subQuestionResults && qRes.subQuestionResults.length > 0 && (
                      <div className="sol-sub-results-list" style={{ margin: '10px 0', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {qRes.subQuestionResults.map((sub, sIdx) => (
                          <div
                            key={sIdx}
                            style={{
                              background: 'var(--color-surface-sunken)',
                              padding: '10px 14px',
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
                            <div style={{ fontSize: '0.8125rem', color: 'var(--color-text-secondary)', marginBottom: sub.feedback ? 4 : 0 }}>
                              Your Answer:{' '}
                              <strong style={{ color: 'var(--color-text-primary)' }}>
                                <ExamMathText content={String(sub.studentAnswer || '(blank)')} />
                              </strong>
                            </div>
                            {sub.feedback && (
                              <div style={{ fontSize: '0.75rem', color: sub.isCorrect ? '#22c55e' : 'var(--color-text-secondary)' }}>
                                <ExamMathText content={sub.feedback} />
                              </div>
                            )}
                          </div>
                        ))}
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
            onClick={() => setShowSubmitModal(true)}
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
          onClick={() => setShowSubmitModal(false)}
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
