import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import type { PublishedQuiz } from '../services/quizManagerService';
import {
  getSubmissionsForQuiz,
  fetchSubmissionsFromSupabase,
  setQuizSubmissionsStatus,
  deleteSubmission,
  clearSubmissionsForQuiz,
  updateSubmission,
  importSubmissionToken,
  ingestEmergencySubmissionBatch,
  exportAllSubmissionsExcel,
  exportSingleSubmissionExcel,
  formatProctorTimestamp,
  formatSubmissionDateTime,
  formatCandidateAnswer,
  type StudentSubmission,
  type QuestionSubmissionResult,
  type BatchEmergencyIngestionSummary,
} from '../services/quizSubmissionService';
import { fetchAndApplyOverrides } from '../services/quizCodeService';
import { fetchCustomTestWithQuestions } from '../services/testBuilderService';
import { evaluateAnswerWithGemini } from '../services/aiGradingService';
import {
  gradeDeterministicAnswer,
  gradeSubmissionDeterministically,
  resolveQuestionModelAnswer,
} from '../services/deterministicGradingService';
import type { Question } from '../types/database';
import {
  exportClassQuizReportPdf,
  exportIndividualStudentReportPdf,
  exportStudentFeedbackReportPdf,
  exportBatchStudentFeedbackReportPdf,
} from '../services/quizReportPdfService';
import { supabase } from '../lib/supabase';
import {
  partitionAnalyticsSubmissions,
  resolveStoredAnswer,
} from '../lib/examSubmissionGuards';
import { ExamMathText } from './ExamMathText';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { GradeThresholdEditor } from './GradeThresholdEditor';
import {
  deriveGradeFromPercentage,
  sanitizeGradeThresholds,
  GRADE_VISUALS,
  type GradeThresholds,
  type GradeLetter,
} from '../utils/gradeThresholdUtils';
import { savePublishedQuiz } from '../services/quizManagerService';
import './QuizResultsModal.css';

interface QuizResultsModalProps {
  quiz: PublishedQuiz;
  onClose: () => void;
}

export function QuizResultsModal({ quiz, onClose }: QuizResultsModalProps) {
  const [currentQuiz, setCurrentQuiz] = useState<PublishedQuiz>(quiz);
  const [isCurveEditorOpen, setIsCurveEditorOpen] = useState(false);
  const [curveSavedMsg, setCurveSavedMsg] = useState<string | null>(null);

  useEffect(() => {
    setCurrentQuiz(quiz);
  }, [quiz]);

  const handleUpdateGradeThresholds = async (gradeThresholds: GradeThresholds) => {
    const updated: PublishedQuiz = { ...currentQuiz, gradeThresholds };
    setCurrentQuiz(updated);
    try {
      await savePublishedQuiz(updated);
      setCurveSavedMsg('✅ Boundaries updated');
      setTimeout(() => setCurveSavedMsg(null), 3000);
    } catch (err) {
      console.error('Failed to save updated grade curve:', err);
    }
  };
  const [submissions, setSubmissions] = useState<StudentSubmission[]>(() =>
    getSubmissionsForQuiz(quiz.id, quiz.quizCode, quiz.testId)
  );
  const [isLoadingSubmissions, setIsLoadingSubmissions] = useState<boolean>(() => {
    return getSubmissionsForQuiz(quiz.id, quiz.quizCode, quiz.testId).length === 0;
  });
  const [selectedSubmission, setSelectedSubmission] = useState<StudentSubmission | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'clean' | 'flagged'>('all');
  const [selectedClass, setSelectedClass] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'score-desc' | 'score-asc' | 'name-asc' | 'strikes-desc'>('score-desc');
  const [showMarkSchemeInReports, setShowMarkSchemeInReports] = useState<boolean>(true);
  const [isExportMenuOpen, setIsExportMenuOpen] = useState<boolean>(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isExportMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setIsExportMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isExportMenuOpen]);

  // Live Connection State
  const [isLiveConnected, setIsLiveConnected] = useState<boolean>(true);

  // Manual / Batch Emergency Paper Import State
  const [isImportModalOpen, setIsImportModalOpen] = useState<boolean>(false);
  const [importTokenInput, setImportTokenInput] = useState<string>('');
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccessMsg, setImportSuccessMsg] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState<boolean>(false);
  const [isDragOverDropzone, setIsDragOverDropzone] = useState<boolean>(false);
  const [batchIngestionSummary, setBatchIngestionSummary] =
    useState<BatchEmergencyIngestionSummary | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importModalDismiss = useBackdropDismiss(() => setIsImportModalOpen(false));

  // Teacher Mark Override State
  const [editingQuestionId, setEditingQuestionId] = useState<string | null>(null);
  const [editMarksInput, setEditMarksInput] = useState<number>(0);
  const [editSubMarksInput, setEditSubMarksInput] = useState<Record<number, number>>({});
  const [editTeacherNote, setEditTeacherNote] = useState<string>('');
  const [savedQuestionId, setSavedQuestionId] = useState<string | null>(null);
  const [isEditingTotalScore, setIsEditingTotalScore] = useState<boolean>(false);
  const [editTotalScoreInput, setEditTotalScoreInput] = useState<number>(0);

  // Batch AI Examiner & Release State
  const [isBatchGrading, setIsBatchGrading] = useState<boolean>(false);
  const [gradingProgress, setGradingProgress] = useState<{ current: number; total: number; text: string }>({
    current: 0,
    total: 0,
    text: '',
  });

  const [deleteModalState, setDeleteModalState] = useState<{
    isOpen: boolean;
    type: 'single' | 'bulk';
    submissionId?: string;
    title: string;
    message: string;
  }>({ isOpen: false, type: 'single', title: '', message: '' });
  const [isDeleting, setIsDeleting] = useState(false);

  // Candidate Inspection & Forensic Telemetry State
  const [expandedRevisions, setExpandedRevisions] = useState<Record<string, boolean>>({});

  const getViolationIcon = (type?: string) => {
    switch (type) {
      case 'fullscreen_exit': return '🖥️';
      case 'tab_switch':
      case 'blur':
      case 'window_blur': return '📑';
      case 'multi_monitor': return '🖥️🖥️';
      case 'blocked_shortcut': return '⌨️';
      case 'print_screen': return '📸';
      case 'dev_tools': return '🛠️';
      default: return '⚠️';
    }
  };

  const formatElapsedSeconds = (sec?: number) => {
    if (sec === undefined || sec === null || sec < 0) return '';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `+${m}m ${s < 10 ? '0' : ''}${s}s`;
  };

  const toggleRevision = (qId: string) => {
    setExpandedRevisions((prev) => ({ ...prev, [qId]: !prev[qId] }));
  };

  const [masterQuestions, setMasterQuestions] = useState<Question[]>([]);
  const masterQuestionsRef = useRef<Question[]>([]);
  const isAutoGradingRef = useRef<boolean>(false);

  useEffect(() => {
    masterQuestionsRef.current = [];
  }, [quiz.id, quiz.testId]);

  const loadQuizQuestionsWithOverrides = useCallback(async () => {
    if (masterQuestionsRef.current.length > 0) {
      return masterQuestionsRef.current;
    }
    if (quiz.testId) {
      const customRes = await fetchCustomTestWithQuestions(quiz.testId);
      if (customRes && customRes.questions && customRes.questions.length > 0) {
        masterQuestionsRef.current = customRes.questions;
        setMasterQuestions(customRes.questions);
        return customRes.questions;
      }
    }
    const fallbackQuestions = await fetchAndApplyOverrides(
      quiz.questionIds || [],
      quiz.headerConfig?.questionOverrides
    );
    if (fallbackQuestions.length > 0) {
      masterQuestionsRef.current = fallbackQuestions;
      setMasterQuestions(fallbackQuestions);
    }
    return fallbackQuestions;
  }, [quiz.testId, quiz.questionIds, quiz.headerConfig?.questionOverrides]);

  // Keep the active candidate inspection pane in sync whenever submissions update
  useEffect(() => {
    setSelectedSubmission((prev) => {
      if (!prev) return null;
      const updated = submissions.find((s) => s.id === prev.id);
      return updated && updated !== prev ? updated : prev;
    });
  }, [submissions]);

  const refreshSubmissions = useCallback(async () => {
    try {
      if (submissions.length === 0) {
        setIsLoadingSubmissions(true);
      }
      const subs = await fetchSubmissionsFromSupabase(quiz.id, quiz.quizCode, quiz.testId);
      setSubmissions(subs);
      setSelectedSubmission((prev) =>
        prev ? subs.find((s) => s.id === prev.id) || prev : null
      );

      // Automatically evaluate any un-graded deterministic/MCQ items from Exam Mode
      // submissions (where candidate payloads were sanitized of mark schemes).
      const hasPotentialUnresolved = subs.some(
        (s) =>
          !s.questionResults ||
          s.questionResults.length === 0 ||
          s.questionResults.some(
            (qr) =>
              qr.aiFeedback === 'Awaiting examiner AI evaluation' ||
              !qr.correctAnswer ||
              qr.correctAnswer === 'See mark scheme' ||
              (qr.subQuestionResults || []).some(
                (sr: any) => sr.feedback === 'Awaiting examiner AI evaluation'
              )
          )
      );

      if (hasPotentialUnresolved && !isAutoGradingRef.current) {
        isAutoGradingRef.current = true;
        try {
          const questions = await loadQuizQuestionsWithOverrides();
          if (questions && questions.length > 0) {
            let anyChanged = false;
            const autoGradedList: StudentSubmission[] = [];
            for (const sub of subs) {
              const { updatedSub, changed } = gradeSubmissionDeterministically(
                sub,
                questions,
                quiz.totalMarks,
                { onlyUnresolved: true }
              );
              if (changed) {
                anyChanged = true;
                await updateSubmission(updatedSub);
                autoGradedList.push(updatedSub);
              } else {
                autoGradedList.push(sub);
              }
            }
            if (anyChanged) {
              setSubmissions(autoGradedList);
              setSelectedSubmission((prev) =>
                prev ? autoGradedList.find((s) => s.id === prev.id) || prev : null
              );
            }
          }
        } catch (autoErr) {
          console.warn('Auto deterministic grading warning:', autoErr);
        } finally {
          isAutoGradingRef.current = false;
        }
      } else if (masterQuestionsRef.current.length === 0) {
        loadQuizQuestionsWithOverrides().catch(() => {});
      }
    } catch (e) {
      console.warn('Failed to refresh submissions:', e);
    } finally {
      setIsLoadingSubmissions(false);
    }
  }, [quiz.id, quiz.quizCode, quiz.testId, quiz.totalMarks, submissions.length, loadQuizQuestionsWithOverrides]);

  useEffect(() => {
    refreshSubmissions();

    // 1. Listen for local window events
    const handleSubmissionsUpdated = () => {
      refreshSubmissions();
    };
    window.addEventListener('submissions_updated', handleSubmissionsUpdated);

    // 2. Real-time Supabase Subscription for live submissions
    const cleanCode = (quiz.quizCode || '').toUpperCase();
    const channelName = `quiz_results_${cleanCode || quiz.id}_${Date.now()}`;
    const channel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'quiz_submissions',
        },
        () => {
          refreshSubmissions();
        }
      )
      .subscribe((status) => {
        setIsLiveConnected(status === 'SUBSCRIBED');
      });

    return () => {
      window.removeEventListener('submissions_updated', handleSubmissionsUpdated);
      supabase.removeChannel(channel);
    };
  }, [quiz.id, quiz.quizCode, refreshSubmissions]);

  const handleImportSubmit = async (rawText: string) => {
    const clean = rawText.trim();
    if (!clean) {
      setImportError('Please enter a valid exam token or JSON string.');
      return;
    }
    setIsImporting(true);
    setImportError(null);
    setImportSuccessMsg(null);
    setBatchIngestionSummary(null);
    try {
      const res = await importSubmissionToken(clean, quiz.quizCode);
      if (res.success && res.submission) {
        if (res.status === 'skipped_older') {
          setImportSuccessMsg(
            `⏭️ Skipped older offline file for ${res.submission.studentName} — newer cloud record preserved.`
          );
        } else {
          setImportSuccessMsg(
            `✅ Successfully ${res.status === 'updated' ? 'updated' : 'imported'} paper for candidate: ${res.submission.studentName} (${res.submission.score}/${res.submission.totalMarks} marks)!`
          );
        }
        setImportTokenInput('');
        await refreshSubmissions();
      } else {
        setImportError(res.error || 'Failed to import exam submission.');
      }
    } catch (err: any) {
      setImportError(err?.message || 'Error parsing submission token');
    } finally {
      setIsImporting(false);
    }
  };

  const handleBatchFilesProcess = async (fileList: FileList | File[]) => {
    const filesArray = Array.from(fileList);
    if (filesArray.length === 0) return;

    setIsImporting(true);
    setImportError(null);
    setImportSuccessMsg(null);
    setBatchIngestionSummary(null);

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

      const summary = await ingestEmergencySubmissionBatch(loadedFiles, {
        expectedQuizCode: quiz.quizCode,
        existingSubmissions: submissions,
      });

      setBatchIngestionSummary(summary);
      await refreshSubmissions();

      if (summary.failedCount === 0) {
        setImportSuccessMsg(
          `✅ Batch ingestion complete: ${summary.insertedCount} new, ${summary.updatedCount} updated, ${summary.skippedOlderCount} skipped (newer in cloud).`
        );
      } else if (summary.insertedCount + summary.updatedCount > 0) {
        setImportSuccessMsg(
          `⚠️ Partial batch ingestion: ${summary.insertedCount + summary.updatedCount} succeeded, ${summary.failedCount} failed verification.`
        );
      } else {
        setImportError(
          `❌ All ${summary.failedCount} file(s) failed AES-GCM verification or belonged to a different exam.`
        );
      }
    } catch (err: any) {
      setImportError(err?.message || 'Batch emergency file ingestion failed.');
    } finally {
      setIsImporting(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleBatchFilesProcess(e.target.files);
    }
    e.target.value = '';
  };

  const unanalyzedCount = useMemo(() => {
    return submissions.filter((s) => s.status === 'submitted' || !s.status).length;
  }, [submissions]);

  const isAllReleased = useMemo(() => {
    return submissions.length > 0 && submissions.every((s) => s.status === 'published');
  }, [submissions]);

  const handleToggleRelease = async () => {
    const nextStatus = isAllReleased ? 'graded' : 'published';
    const confirmed = confirm(
      isAllReleased
        ? 'Hide results from students? Candidates will not be able to view their scores on the portal.'
        : 'Release results to students? Candidates can now enter their quiz code and name on the portal to view their marked paper and download their PDF reports.'
    );
    if (!confirmed) return;

    await setQuizSubmissionsStatus(quiz.id, quiz.quizCode, nextStatus);
    refreshSubmissions();
  };

  const handleRunBatchAI = async () => {
    const targets = submissions.filter((s) => s.status === 'submitted' || !s.status);
    if (targets.length === 0) {
      alert('All student submissions have already been analyzed.');
      return;
    }

    setIsBatchGrading(true);
    setGradingProgress({ current: 0, total: targets.length, text: 'Fetching exam questions...' });

    try {
      const questions = await loadQuizQuestionsWithOverrides();
      if (!questions || questions.length === 0) {
        alert('Could not load questions for this test.');
        setIsBatchGrading(false);
        return;
      }

      for (let sIdx = 0; sIdx < targets.length; sIdx++) {
        const sub = targets[sIdx];
        setGradingProgress({
          current: sIdx + 1,
          total: targets.length,
          text: `Analyzing candidate: ${sub.studentName} (${sIdx + 1} of ${targets.length})...`,
        });

        const rawAnswers = sub.rawAnswers || {};
        const answersById = sub.forensics?.answersByQuestionId;
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

          const prevResult = sub.questionResults?.find((r) => r.questionId === q.id) || sub.questionResults?.[idx];
          const isMcq =
            q.question_style === 'Multiple Choice' ||
            q.question_style === 'Multiple Select' ||
            Boolean(q.options && q.options.length > 0 && q.question_style !== 'Structured');
          let finalStudentAnswer: string | number = resolveStoredAnswer({
            rawAnswers,
            answersByQuestionId: answersById,
            questionId: q.id,
            index: idx,
          }) ?? '';

          // Case A: Sub-questions (excluding MCQ/Multiple Select)
          if (q.sub_questions && q.sub_questions.length > 0 && !isMcq) {
            let totalSubEarned = 0;
            for (let sqIdx = 0; sqIdx < q.sub_questions.length; sqIdx++) {
              const sq = q.sub_questions[sqIdx];
              let subAns = resolveStoredAnswer({
                rawAnswers,
                answersByQuestionId: answersById,
                questionId: q.id,
                subId: sq.sub_id,
                index: idx,
                subIndex: sqIdx,
              });
              if (subAns === undefined || subAns === '') {
                const prevSub = prevResult?.subQuestionResults?.find((sr: any) => sr.subId === sq.sub_id) || prevResult?.subQuestionResults?.[sqIdx];
                if (prevSub?.studentAnswer !== undefined && prevSub.studentAnswer !== '') {
                  subAns = prevSub.studentAnswer;
                } else {
                  subAns = '';
                }
              }
              const subMarks = sq.marks || 1;

              const det = gradeDeterministicAnswer(subAns, q, sqIdx);
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
                setGradingProgress({
                  current: sIdx + 1,
                  total: targets.length,
                  text: `Evaluating ${sub.studentName}: Q${idx + 1}(${sq.sub_id})...`,
                });
                const aiRes = await evaluateAnswerWithGemini(q, sqIdx, String(subAns));
                totalSubEarned += aiRes.earnedMarks;
                gradingMethod = aiRes.evaluatedBy === 'gemini' ? 'ai_gemini' : 'rule_fallback';
                subResults.push({
                  subId: sq.sub_id,
                  questionText: sq.question_text,
                  studentAnswer: subAns,
                  earnedMarks: aiRes.earnedMarks,
                  maxMarks: subMarks,
                  isCorrect: aiRes.isCorrect,
                  feedback: aiRes.feedback,
                  criteria: aiRes.criteriaResults,
                });
                // Throttled delay to respect Gemini rate limits
                await new Promise((r) => setTimeout(r, 1200));
              }
            }
            qEarned = Math.min(totalSubEarned, qMarks);
            isCorrect = qEarned === qMarks;
          }
          // Case B: Standalone Question (MCQ, Multiple-Select, Matching Table, or Structured)
          else {
            let userAns = resolveStoredAnswer({
              rawAnswers,
              answersByQuestionId: answersById,
              questionId: q.id,
              index: idx,
            });
            if (userAns === undefined || userAns === '') {
              if (prevResult?.studentAnswer !== undefined && prevResult.studentAnswer !== '') {
                userAns = prevResult.studentAnswer;
              } else {
                userAns = '';
              }
            }
            finalStudentAnswer = userAns;
            const det = gradeDeterministicAnswer(userAns, q);
            if (det.isHandled || isMcq) {
              qEarned = det.earnedMarks;
              isCorrect = det.isCorrect;
              aiFeedback = det.feedback;
              gradingMethod = det.matchType === 'mcq' ? 'mcq' : 'deterministic';
            } else {
              setGradingProgress({
                current: sIdx + 1,
                total: targets.length,
                text: `Evaluating ${sub.studentName}: Question ${idx + 1}...`,
              });
              const aiRes = await evaluateAnswerWithGemini(q, undefined, String(userAns));
              qEarned = aiRes.earnedMarks;
              isCorrect = aiRes.isCorrect;
              aiFeedback = aiRes.feedback;
              missingPoints = aiRes.missingKeyPoints;
              criteriaBreakdown = aiRes.criteriaResults;
              gradingMethod = aiRes.evaluatedBy === 'gemini' ? 'ai_gemini' : 'rule_fallback';
              // Throttled delay to respect Gemini rate limits
              await new Promise((r) => setTimeout(r, 1200));
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
            studentAnswer: finalStudentAnswer,
            correctAnswer: resolveQuestionModelAnswer(q),
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

        const updatedSub: StudentSubmission = {
          ...sub,
          score: earnedMarks,
          totalMarks: quiz.totalMarks || sub.totalMarks,
          percentage: (quiz.totalMarks || sub.totalMarks) > 0 ? Math.round((earnedMarks / (quiz.totalMarks || sub.totalMarks)) * 100) : 100,
          questionResults: qResults,
          topicBreakdown,
          status: sub.status === 'published' ? 'published' : 'graded',
        };

        await updateSubmission(updatedSub);
        setSelectedSubmission((prev) => (prev && prev.id === updatedSub.id ? updatedSub : prev));
      }

      await refreshSubmissions();
    } catch (err) {
      console.error('Batch grading error:', err);
      alert('An error occurred during batch grading. Please check your network and Gemini API key.');
    } finally {
      setIsBatchGrading(false);
    }
  };

  const handleRegradeAllDeterministic = async () => {
    if (submissions.length === 0) return;
    const confirmed = confirm(
      `Re-grade ${submissions.length} submission(s) deterministically from the original student answers?\n\nMCQ and gap-fill answers will be recalculated. Descriptive answers already graded by AI or by hand are preserved (their marks are never overwritten with 0).`
    );
    if (!confirmed) return;

    setIsBatchGrading(true);
    setGradingProgress({ current: 0, total: submissions.length, text: 'Fetching test questions...' });

    try {
      const questions = await loadQuizQuestionsWithOverrides();
      if (!questions || questions.length === 0) {
        alert('Could not load questions for this test.');
        setIsBatchGrading(false);
        return;
      }

      let totalPreserved = 0;
      const updatedList: StudentSubmission[] = [];
      for (let sIdx = 0; sIdx < submissions.length; sIdx++) {
        const sub = submissions[sIdx];
        setGradingProgress({
          current: sIdx + 1,
          total: submissions.length,
          text: `Re-grading candidate: ${sub.studentName} (${sIdx + 1} of ${submissions.length})...`,
        });

        const { updatedSub, preservedCount } = gradeSubmissionDeterministically(
          sub,
          questions,
          quiz.totalMarks,
          { onlyUnresolved: false }
        );

        await updateSubmission(updatedSub);
        updatedList.push(updatedSub);
        totalPreserved += preservedCount;
      }

      setSubmissions(updatedList);
      setSelectedSubmission((prev) =>
        prev ? updatedList.find((s) => s.id === prev.id) || prev : null
      );
      await refreshSubmissions();
      alert(
        totalPreserved > 0
          ? `✅ Re-graded ${submissions.length} submission(s). ${totalPreserved} AI/manual descriptive mark(s) were preserved unchanged.`
          : `✅ Successfully re-graded all ${submissions.length} submission(s) deterministically!`
      );
    } catch (err) {
      console.error('Re-grading error:', err);
      alert('An error occurred during re-grading.');
    } finally {
      setIsBatchGrading(false);
    }
  };

  // ─── Unique Classes ─────────────────────────────────────────────────────────
  const availableClasses = useMemo(() => {
    const classes = Array.from(new Set(submissions.map((s) => s.studentClass || 'General')));
    return classes.sort();
  }, [submissions]);

  // ─── Analytics Summary ──────────────────────────────────────────────────────
  // Exam-mode submissions are stored with `status: 'submitted'` and a provisional
  // deterministic score (often 0 on structured papers). Averaging those into the
  // class KPIs made a whole cohort look like it had failed before grading ran.
  const stats = useMemo(() => {
    const activeSubmissions = selectedClass === 'all'
      ? submissions
      : submissions.filter((s) => (s.studentClass || 'General').toLowerCase() === selectedClass.toLowerCase());

    const emptyGrades: Record<GradeLetter, number> = { 'A*': 0, A: 0, B: 0, C: 0, D: 0, E: 0, U: 0 };

    if (activeSubmissions.length === 0) {
      return {
        count: 0,
        gradedCount: 0,
        pendingGradingCount: 0,
        isProvisional: false,
        avgScore: 0,
        avgPercentage: 0,
        highestScore: 0,
        lowestScore: 0,
        cleanCount: 0,
        flaggedCount: 0,
        gradeCounts: emptyGrades,
        classTopics: [] as { topic: string; earnedMarks: number; totalMarks: number; percentage: number }[],
      };
    }

    const split = partitionAnalyticsSubmissions(activeSubmissions);
    const analyticsSubmissions = split.analytics;
    const count = activeSubmissions.length;
    const gradedCount = analyticsSubmissions.length;
    const pendingGradingCount = split.pending.length;
    const isProvisional = split.provisional;

    const totalScore = analyticsSubmissions.reduce((s, sub) => s + sub.score, 0);
    const avgScore = gradedCount > 0 ? totalScore / gradedCount : 0;
    const avgPercentage = (avgScore / (currentQuiz.totalMarks || 1)) * 100;
    const highestScore = gradedCount > 0 ? Math.max(...analyticsSubmissions.map((s) => s.score)) : 0;
    const lowestScore = gradedCount > 0 ? Math.min(...analyticsSubmissions.map((s) => s.score)) : 0;
    const cleanCount = activeSubmissions.filter((s) => s.violationsCount === 0).length;
    const flaggedCount = count - cleanCount;

    const gradeCounts: Record<GradeLetter, number> = { ...emptyGrades };
    const topicMap = new Map<string, { topic: string; earnedMarks: number; totalMarks: number }>();

    analyticsSubmissions.forEach((sub) => {
      const g = deriveGradeFromPercentage(sub.percentage, currentQuiz.gradeThresholds).grade;
      gradeCounts[g] = (gradeCounts[g] || 0) + 1;

      if (sub.topicBreakdown) {
        Object.entries(sub.topicBreakdown).forEach(([topName, tData]) => {
          const cleanName = topName.trim() || 'General';
          const key = cleanName.toLowerCase();
          const prev = topicMap.get(key) || { topic: cleanName, earnedMarks: 0, totalMarks: 0 };
          prev.earnedMarks += Number(tData.earnedMarks) || 0;
          prev.totalMarks += Number(tData.totalMarks) || 0;
          topicMap.set(key, prev);
        });
      }
    });

    const classTopics = Array.from(topicMap.values())
      .map((t) => ({
        ...t,
        percentage: t.totalMarks > 0 ? (t.earnedMarks / t.totalMarks) * 100 : 0,
      }))
      .sort((a, b) => a.percentage - b.percentage);

    return {
      count,
      gradedCount,
      pendingGradingCount,
      isProvisional,
      avgScore,
      avgPercentage,
      highestScore,
      lowestScore,
      cleanCount,
      flaggedCount,
      gradeCounts,
      classTopics,
    };
  }, [submissions, currentQuiz.totalMarks, currentQuiz.gradeThresholds, selectedClass]);

  // ─── Filtered & Sorted Submissions ──────────────────────────────────────────
  const filteredSubmissions = useMemo(() => {
    const filtered = submissions.filter((sub) => {
      const q = searchFilter.toLowerCase().trim();
      const matchesSearch = !q || sub.studentName.toLowerCase().includes(q) || (sub.candidateNumber && sub.candidateNumber.includes(q));
      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'clean' && sub.violationsCount === 0) ||
        (statusFilter === 'flagged' && sub.violationsCount > 0);
      const matchesClass =
        selectedClass === 'all' ||
        (sub.studentClass || 'General').toLowerCase() === selectedClass.toLowerCase();

      return matchesSearch && matchesStatus && matchesClass;
    });

    return [...filtered].sort((a, b) => {
      if (sortBy === 'score-desc') return b.percentage - a.percentage || a.studentName.localeCompare(b.studentName);
      if (sortBy === 'score-asc') return a.percentage - b.percentage || a.studentName.localeCompare(b.studentName);
      if (sortBy === 'name-asc') return a.studentName.localeCompare(b.studentName);
      if (sortBy === 'strikes-desc') return b.violationsCount - a.violationsCount || b.percentage - a.percentage;
      return 0;
    });
  }, [submissions, searchFilter, statusFilter, selectedClass, sortBy]);

  const handleDelete = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setDeleteModalState({
      isOpen: true,
      type: 'single',
      submissionId: id,
      title: 'Delete Submission',
      message: 'Are you sure you want to delete this submission record?',
    });
  };

  const handleClearAll = () => {
    setDeleteModalState({
      isOpen: true,
      type: 'bulk',
      title: 'Delete All Submissions',
      message: `Are you sure you want to delete all ${submissions.length} submission records for this quiz?`,
    });
  };

  const handleConfirmDelete = async () => {
    setIsDeleting(true);
    try {
      if (deleteModalState.type === 'single' && deleteModalState.submissionId) {
        await deleteSubmission(deleteModalState.submissionId);
        if (selectedSubmission?.id === deleteModalState.submissionId) setSelectedSubmission(null);
      } else if (deleteModalState.type === 'bulk') {
        await clearSubmissionsForQuiz(quiz.id, quiz.quizCode);
        setSelectedSubmission(null);
      }
    } finally {
      setIsDeleting(false);
      setDeleteModalState((s) => ({ ...s, isOpen: false }));
    }
  };

  const handleExportAllExcel = () => {
    exportAllSubmissionsExcel(currentQuiz.title, currentQuiz.quizCode, currentQuiz.totalMarks, submissions, {
      subject: currentQuiz.subject,
      schoolName: currentQuiz.headerConfig?.schoolName,
      targetClass: selectedClass !== 'all' ? selectedClass : undefined,
      gradeThresholds: currentQuiz.gradeThresholds,
    });
  };

  const handleExportSingleExcel = (sub: StudentSubmission) => {
    exportSingleSubmissionExcel(sub, { gradeThresholds: currentQuiz.gradeThresholds });
  };

  const handleStartEditing = (qr: QuestionSubmissionResult) => {
    setEditingQuestionId(qr.questionId);
    if (qr.subQuestionResults && qr.subQuestionResults.length > 0) {
      const subMap: Record<number, number> = {};
      let subSum = 0;
      qr.subQuestionResults.forEach((sub, idx) => {
        const clamped = Math.max(0, Math.min(sub.maxMarks || 1, Number(sub.earnedMarks) || 0));
        subMap[idx] = clamped;
        subSum += clamped;
      });
      setEditSubMarksInput(subMap);
      setEditMarksInput(Math.min(qr.maxMarks, subSum));
    } else {
      setEditSubMarksInput({});
      setEditMarksInput(qr.earnedMarks);
    }
    setEditTeacherNote('');
  };

  const handleSubMarkChange = (qr: QuestionSubmissionResult, sIdx: number, rawVal: number) => {
    const subMax = qr.subQuestionResults?.[sIdx]?.maxMarks || 1;
    const clamped = isNaN(rawVal) ? 0 : Math.max(0, Math.min(subMax, rawVal));
    setEditSubMarksInput((prev) => {
      const next = { ...prev, [sIdx]: clamped };
      const totalSub = (qr.subQuestionResults || []).reduce(
        (acc, s, idx) => acc + Math.max(0, Math.min(s.maxMarks || 1, Number(next[idx] ?? s.earnedMarks ?? 0))),
        0
      );
      setEditMarksInput(Math.min(qr.maxMarks, totalSub));
      return next;
    });
  };

  const handleSaveMarkOverride = async (qr: QuestionSubmissionResult) => {
    if (!selectedSubmission) return;

    const hasSubQuestions = Boolean(qr.subQuestionResults && qr.subQuestionResults.length > 0);
    let finalQuestionEarned = Math.max(0, Math.min(qr.maxMarks, Number(editMarksInput) || 0));
    let updatedSubResults = qr.subQuestionResults;

    if (hasSubQuestions && qr.subQuestionResults) {
      updatedSubResults = qr.subQuestionResults.map((sub, idx) => {
        const subMax = sub.maxMarks || 1;
        const newSubEarned = Math.max(0, Math.min(subMax, Number(editSubMarksInput[idx] ?? sub.earnedMarks ?? 0)));
        const prevSubEarned = Number(sub.earnedMarks) || 0;
        const wasEdited = newSubEarned !== prevSubEarned;
        let nextFeedback = sub.feedback;
        if (wasEdited && (!nextFeedback || nextFeedback === 'Awaiting examiner AI evaluation')) {
          nextFeedback = `Marked by teacher (${newSubEarned}/${subMax} mark${subMax !== 1 ? 's' : ''})`;
        }
        return {
          ...sub,
          earnedMarks: newSubEarned,
          isCorrect: newSubEarned >= subMax,
          feedback: nextFeedback,
        };
      });
      finalQuestionEarned = Math.min(
        qr.maxMarks,
        updatedSubResults.reduce((acc, s) => acc + (Number(s.earnedMarks) || 0), 0)
      );
    }

    const updatedQuestionResults = selectedSubmission.questionResults.map((q) => {
      if (q.questionId === qr.questionId) {
        let nextAiFeedback = q.aiFeedback;
        if (nextAiFeedback === 'Awaiting examiner AI evaluation') {
          nextAiFeedback = undefined;
        }
        if (editTeacherNote.trim()) {
          nextAiFeedback = `${nextAiFeedback ? nextAiFeedback + '\n' : ''}✏️ [Teacher Note]: ${editTeacherNote.trim()}`;
        }
        return {
          ...q,
          earnedMarks: finalQuestionEarned,
          isCorrect: finalQuestionEarned >= q.maxMarks,
          aiFeedback: nextAiFeedback,
          subQuestionResults: updatedSubResults,
        };
      }
      // Ensure any other multi-part question's earnedMarks reflects the sum of its sub-questions
      if (q.subQuestionResults && q.subQuestionResults.length > 0) {
        const subSum = Math.min(
          q.maxMarks,
          q.subQuestionResults.reduce((acc, s) => acc + (Number(s.earnedMarks) || 0), 0)
        );
        if (subSum !== q.earnedMarks) {
          return {
            ...q,
            earnedMarks: subSum,
            isCorrect: subSum >= q.maxMarks,
          };
        }
      }
      return q;
    });

    const computedTotalEarned = updatedQuestionResults.reduce((acc, q) => acc + (Number(q.earnedMarks) || 0), 0);
    const newScore = Math.max(0, Math.min(selectedSubmission.totalMarks, computedTotalEarned));
    const newPct = selectedSubmission.totalMarks > 0 ? Math.round((newScore / selectedSubmission.totalMarks) * 100) : 0;
    const diff = newScore - selectedSubmission.score;

    // Recompute topic breakdown directly from updatedQuestionResults for 100% consistency
    const updatedTopicBreakdown: Record<string, { totalMarks: number; earnedMarks: number; percentage: number }> = {};
    updatedQuestionResults.forEach((q) => {
      const top = q.topic || 'General';
      if (!updatedTopicBreakdown[top]) {
        updatedTopicBreakdown[top] = { totalMarks: 0, earnedMarks: 0, percentage: 0 };
      }
      updatedTopicBreakdown[top].totalMarks += q.maxMarks || 1;
      updatedTopicBreakdown[top].earnedMarks += q.earnedMarks || 0;
    });
    Object.keys(updatedTopicBreakdown).forEach((top) => {
      const item = updatedTopicBreakdown[top];
      item.percentage = item.totalMarks > 0 ? (item.earnedMarks / item.totalMarks) * 100 : 0;
    });

    const hasRemainingAwaitingAI = updatedQuestionResults.some(
      (q) =>
        q.aiFeedback === 'Awaiting examiner AI evaluation' ||
        (q.subQuestionResults && q.subQuestionResults.some((sr) => sr.feedback === 'Awaiting examiner AI evaluation'))
    );

    const updatedSubmission: StudentSubmission = {
      ...selectedSubmission,
      score: newScore,
      percentage: newPct,
      questionResults: updatedQuestionResults,
      teacherAdjustedMarks: (selectedSubmission.teacherAdjustedMarks || 0) + diff,
      topicBreakdown: updatedTopicBreakdown,
      status: selectedSubmission.status === 'submitted' && !hasRemainingAwaitingAI ? 'graded' : selectedSubmission.status,
      updatedAt: new Date().toISOString(),
    };

    // Optimistic UI update: apply immediately so Save feels instantaneous
    setSelectedSubmission(updatedSubmission);
    setSubmissions((prev) => prev.map((s) => (s.id === updatedSubmission.id ? updatedSubmission : s)));
    setEditingQuestionId(null);
    setSavedQuestionId(qr.questionId);
    setTimeout(() => {
      setSavedQuestionId((curr) => (curr === qr.questionId ? null : curr));
    }, 2500);

    // Sync to localStorage & Supabase in background
    updateSubmission(updatedSubmission).catch((err) => {
      console.warn('Background mark override sync warning:', err);
    });
  };

  const handleSaveTotalScoreOverride = async () => {
    if (!selectedSubmission) return;
    const newScore = Math.max(0, Math.min(selectedSubmission.totalMarks, editTotalScoreInput));
    const newPct = selectedSubmission.totalMarks > 0 ? Math.round((newScore / selectedSubmission.totalMarks) * 100) : 0;
    const diff = newScore - selectedSubmission.score;

    // Clone or initialize topic breakdown
    const updatedTopicBreakdown: Record<string, { totalMarks: number; earnedMarks: number; percentage: number }> = {};
    if (selectedSubmission.topicBreakdown && Object.keys(selectedSubmission.topicBreakdown).length > 0) {
      Object.entries(selectedSubmission.topicBreakdown).forEach(([k, v]) => {
        updatedTopicBreakdown[k] = { ...v };
      });
    } else if (selectedSubmission.questionResults && selectedSubmission.questionResults.length > 0) {
      selectedSubmission.questionResults.forEach((q) => {
        const top = q.topic || 'General';
        if (!updatedTopicBreakdown[top]) {
          updatedTopicBreakdown[top] = { totalMarks: 0, earnedMarks: 0, percentage: 0 };
        }
        updatedTopicBreakdown[top].totalMarks += q.maxMarks || 1;
        updatedTopicBreakdown[top].earnedMarks += q.earnedMarks || 0;
      });
      Object.keys(updatedTopicBreakdown).forEach((top) => {
        const item = updatedTopicBreakdown[top];
        item.percentage = item.totalMarks > 0 ? (item.earnedMarks / item.totalMarks) * 100 : 0;
      });
    }

    if (Object.keys(updatedTopicBreakdown).length === 0) {
      updatedTopicBreakdown['General'] = {
        totalMarks: selectedSubmission.totalMarks || 1,
        earnedMarks: newScore,
        percentage: newPct,
      };
    } else if (diff > 0) {
      // Distribute positive bonus marks starting from the lowest-performing topics
      let remainingDiff = diff;
      const topicKeys = Object.keys(updatedTopicBreakdown).sort(
        (a, b) => updatedTopicBreakdown[a].percentage - updatedTopicBreakdown[b].percentage
      );

      for (const t of topicKeys) {
        if (remainingDiff <= 0) break;
        const item = updatedTopicBreakdown[t];
        const headroom = Math.max(0, item.totalMarks - item.earnedMarks);
        if (headroom > 0) {
          const addMarks = Math.min(remainingDiff, headroom);
          item.earnedMarks += addMarks;
          item.percentage = item.totalMarks > 0 ? (item.earnedMarks / item.totalMarks) * 100 : 0;
          remainingDiff -= addMarks;
        }
      }
    } else if (diff < 0) {
      // Deduct marks starting from the highest-performing topics
      let remainingDeduct = Math.abs(diff);
      const topicKeys = Object.keys(updatedTopicBreakdown).sort(
        (a, b) => updatedTopicBreakdown[b].percentage - updatedTopicBreakdown[a].percentage
      );

      for (const t of topicKeys) {
        if (remainingDeduct <= 0) break;
        const item = updatedTopicBreakdown[t];
        const removable = item.earnedMarks;
        if (removable > 0) {
          const deductMarks = Math.min(remainingDeduct, removable);
          item.earnedMarks -= deductMarks;
          item.percentage = item.totalMarks > 0 ? (item.earnedMarks / item.totalMarks) * 100 : 0;
          remainingDeduct -= deductMarks;
        }
      }
    }

    const updatedSubmission: StudentSubmission = {
      ...selectedSubmission,
      score: newScore,
      percentage: newPct,
      teacherAdjustedMarks: (selectedSubmission.teacherAdjustedMarks || 0) + diff,
      topicBreakdown: updatedTopicBreakdown,
      updatedAt: new Date().toISOString(),
    };

    // Optimistic UI update: apply immediately
    setSelectedSubmission(updatedSubmission);
    setSubmissions((prev) => prev.map((s) => (s.id === updatedSubmission.id ? updatedSubmission : s)));
    setIsEditingTotalScore(false);

    updateSubmission(updatedSubmission).catch((err) => {
      console.warn('Background total score override sync warning:', err);
    });
  };

  const backdropDismiss = useBackdropDismiss(onClose);

  return createPortal(
    <div className="qrm-backdrop animate-fade-in" {...backdropDismiss}>
      <div className="qrm-modal animate-scale-up" onClick={(e) => e.stopPropagation()}>
        {/* Unified Top Command Bar */}
        <div className="qrm-header">
          <div className="qrm-header-info">
            <div className="qrm-header-title-row">
              <span className="qrm-subject-badge">{currentQuiz.subject || 'Chemistry'}</span>
              <h2 className="qrm-title" title={currentQuiz.title}>{currentQuiz.title}</h2>
              <code className="qrm-code" title="Assessment Access Code">{currentQuiz.quizCode}</code>
              <span className="qrm-meta-summary">
                {currentQuiz.totalMarks} Marks • {submissions.length} Submission{submissions.length !== 1 ? 's' : ''}
              </span>

              {unanalyzedCount > 0 ? (
                <span className="qrm-status-badge awaiting">
                  ⏳ {unanalyzedCount} Awaiting AI
                </span>
              ) : submissions.length > 0 ? (
                <span className="qrm-status-badge graded">
                  ✅ All Graded
                </span>
              ) : null}

              {submissions.length > 0 && (
                <span className={`qrm-status-badge ${isAllReleased ? 'released' : 'hidden'}`}>
                  {isAllReleased ? '📢 Released' : '🔒 Hidden'}
                </span>
              )}
            </div>
          </div>

          <div className="qrm-header-actions">
            <button
              type="button"
              className={`qrm-btn-header-ghost ${isCurveEditorOpen ? 'active' : ''}`}
              onClick={() => setIsCurveEditorOpen((prev) => !prev)}
              title="Fine-tune percentage thresholds for each grade tier"
            >
              📊 Grade Curve
            </button>

            {submissions.length > 0 && (
              <>
                <button
                  type="button"
                  className="qrm-btn-header-ghost"
                  onClick={handleRegradeAllDeterministic}
                  disabled={isBatchGrading}
                  title="Re-calculate all submissions from original student answers using official answer key (100% deterministic)"
                >
                  🔄 Re-Grade MCQ
                </button>

                {unanalyzedCount > 0 && (
                  <button
                    type="button"
                    className="qrm-btn-header-ai"
                    onClick={handleRunBatchAI}
                    disabled={isBatchGrading}
                    title="Execute batch AI pedagogical diagnostics on all submissions"
                  >
                    {isBatchGrading ? '⏳ Evaluating...' : '🤖 Run Batch AI'}
                  </button>
                )}

                <button
                  type="button"
                  className="qrm-btn-header-ghost"
                  onClick={handleToggleRelease}
                  disabled={unanalyzedCount > 0 && !isAllReleased}
                  title={unanalyzedCount > 0 && !isAllReleased ? 'Run Batch AI Analysis first before releasing results' : (isAllReleased ? 'Hide marks from students' : 'Release results to students')}
                >
                  {isAllReleased ? '🔒 Hide Marks' : '📢 Release Results'}
                </button>
              </>
            )}

            {/* Consolidated Export & Tools Dropdown */}
            <div className="qrm-export-dropdown-wrap" ref={exportMenuRef}>
              <button
                type="button"
                className={`qrm-btn-export-trigger ${isExportMenuOpen ? 'active' : ''}`}
                onClick={() => setIsExportMenuOpen((prev) => !prev)}
                title="Export reports or import offline student scripts"
              >
                <span>📤 Export &amp; Tools</span>
                <span className="qrm-caret">{isExportMenuOpen ? '▴' : '▾'}</span>
              </button>

              {isExportMenuOpen && (
                <div className="qrm-export-popover animate-fade-in">
                  {submissions.length > 0 && (
                    <>
                      <div className="qrm-popover-section-lbl">Report Settings</div>
                      <label className="qrm-popover-toggle">
                        <input
                          type="checkbox"
                          checked={showMarkSchemeInReports}
                          onChange={(e) => setShowMarkSchemeInReports(e.target.checked)}
                        />
                        <span>Include Mark Scheme in PDFs</span>
                      </label>

                      <div className="qrm-popover-divider" />
                      <div className="qrm-popover-section-lbl">Class Deliverables</div>

                      <button
                        type="button"
                        className="qrm-popover-item"
                        onClick={() => {
                          setIsExportMenuOpen(false);
                          exportBatchStudentFeedbackReportPdf(submissions, currentQuiz.title, selectedClass, {
                            showMarkScheme: showMarkSchemeInReports,
                            gradeThresholds: currentQuiz.gradeThresholds,
                          });
                        }}
                      >
                        <span className="qrm-popover-icon batch">🎓</span>
                        <div className="qrm-popover-item-text">
                          <strong>Batch 1-Page Reports (PDF)</strong>
                          <span>Individual report cards for {stats.count} candidates</span>
                        </div>
                      </button>

                      <button
                        type="button"
                        className="qrm-popover-item"
                        onClick={() => {
                          setIsExportMenuOpen(false);
                          exportClassQuizReportPdf(currentQuiz, submissions, selectedClass);
                        }}
                      >
                        <span className="qrm-popover-icon pdf">📄</span>
                        <div className="qrm-popover-item-text">
                          <strong>Export Class Report (PDF)</strong>
                          <span>Cohort analytics, grade bands &amp; rankings</span>
                        </div>
                      </button>

                      <button
                        type="button"
                        className="qrm-popover-item"
                        onClick={() => {
                          setIsExportMenuOpen(false);
                          handleExportAllExcel();
                        }}
                      >
                        <span className="qrm-popover-icon excel">📗</span>
                        <div className="qrm-popover-item-text">
                          <strong>Export All (Excel .xlsx)</strong>
                          <span>Official ICM gradebook &amp; item analysis</span>
                        </div>
                      </button>

                      <div className="qrm-popover-divider" />
                    </>
                  )}

                  <div className="qrm-popover-section-lbl">Offline Recovery</div>
                  <button
                    type="button"
                    className="qrm-popover-item"
                    onClick={() => {
                      setIsExportMenuOpen(false);
                      setIsImportModalOpen(true);
                      setImportError(null);
                      setImportSuccessMsg(null);
                      setImportTokenInput('');
                    }}
                  >
                    <span className="qrm-popover-icon import">📥</span>
                    <div className="qrm-popover-item-text">
                      <strong>Import Offline Paper</strong>
                      <span>Upload .exam backup file or token string</span>
                    </div>
                  </button>
                </div>
              )}
            </div>

            {/* Live Sync Status Indicator */}
            <div
              className="qrm-live-badge"
              title={isLiveConnected ? 'Connected to live database. Submissions appear in real-time.' : 'Connecting to database...'}
            >
              <span
                className="qrm-live-dot"
                style={{
                  background: isLiveConnected ? '#22c55e' : '#eab308',
                  boxShadow: isLiveConnected ? '0 0 6px #22c55e' : 'none',
                }}
              />
              <span>{isLiveConnected ? 'Live' : 'Syncing'}</span>
            </div>

            <button type="button" className="qrm-close-btn" onClick={onClose} title="Close Results Workspace">
              ✕
            </button>
          </div>
        </div>

        {/* Live Grade Curve Tuning Drawer (When toggled from top bar) */}
        {isCurveEditorOpen && (
          <div className="qrm-curve-panel animate-fade-in">
            <div className="qrm-curve-panel-header">
              <div>
                <div className="qrm-curve-panel-title">
                  <span>📊</span> Grade Boundaries &amp; Curve Tuning
                </div>
                <div className="qrm-curve-panel-sub">
                  Fine-tune cutoff percentages for this assessment. Changes apply live to all student badges, class diagnostics, and report exports.
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {curveSavedMsg && <span className="qrm-curve-saved-badge">{curveSavedMsg}</span>}
                <button
                  type="button"
                  className="qrm-btn-header-ghost"
                  onClick={() => setIsCurveEditorOpen(false)}
                >
                  ✕ Close Editor
                </button>
              </div>
            </div>
            <GradeThresholdEditor
              value={currentQuiz.gradeThresholds}
              onChange={handleUpdateGradeThresholds}
              totalMarks={currentQuiz.totalMarks}
            />
          </div>
        )}

        {/* Live Batch Grading Progress Bar */}
        {isBatchGrading && (
          <div className="qrm-batch-progress-bar">
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', marginBottom: '6px' }}>
              <span style={{ fontWeight: 700, color: 'var(--icm-blue)' }}>
                🤖 {gradingProgress.text}
              </span>
              <span style={{ fontWeight: 800, color: 'var(--color-text-primary)' }}>
                {gradingProgress.current} / {gradingProgress.total} Candidates
              </span>
            </div>
            <div style={{ height: '6px', background: 'var(--color-border)', borderRadius: '3px', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${gradingProgress.total > 0 ? (gradingProgress.current / gradingProgress.total) * 100 : 0}%`,
                  height: '100%',
                  background: 'linear-gradient(90deg, #8b5cf6, #3b82f6)',
                  borderRadius: '3px',
                  transition: 'width 0.4s ease',
                }}
              />
            </div>
          </div>
        )}

        {/* Body Split View */}
        <div className="qrm-body-layout">
          {/* Left Panel: Student Roster List */}
          <div className="qrm-roster-panel">
            {/* Top Navigation Button: Class Overview */}
            <div className="qrm-overview-nav-wrap">
              <button
                type="button"
                className={`qrm-overview-nav-btn ${!selectedSubmission ? 'active' : ''}`}
                onClick={() => setSelectedSubmission(null)}
              >
                <div className="qrm-ov-btn-left">
                  <span className="qrm-ov-icon">📊</span>
                  <div className="qrm-ov-btn-text">
                    <strong>Class Overview &amp; Analytics</strong>
                    <span>
                      {stats.count} Student{stats.count !== 1 ? 's' : ''} • Avg {stats.avgPercentage.toFixed(0)}%
                      {stats.pendingGradingCount > 0 ? ` • ${stats.pendingGradingCount} pending` : ''}
                    </span>
                  </div>
                </div>
                <span className="qrm-ov-chevron">›</span>
              </button>
            </div>

            <div className="qrm-roster-toolbar">
              <input
                type="text"
                className="qrm-roster-search"
                placeholder="Search candidate name or ID..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
              />

              {/* Compact Class & Sort Controls */}
              <div className="qrm-roster-select-row">
                {availableClasses.length > 1 && (
                  <select
                    className="qrm-compact-select"
                    value={selectedClass}
                    onChange={(e) => setSelectedClass(e.target.value)}
                    title="Filter by class cohort"
                  >
                    <option value="all">All Classes ({submissions.length})</option>
                    {availableClasses.map((cls) => {
                      const clsCount = submissions.filter((s) => (s.studentClass || 'General').toLowerCase() === cls.toLowerCase()).length;
                      return (
                        <option key={cls} value={cls}>
                          {cls} ({clsCount})
                        </option>
                      );
                    })}
                  </select>
                )}

                <select
                  className="qrm-compact-select"
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as any)}
                  title="Sort student roster"
                >
                  <option value="score-desc">Score: High → Low</option>
                  <option value="score-asc">Score: Low → High</option>
                  <option value="name-asc">Name: A → Z</option>
                  <option value="strikes-desc">Most Strikes</option>
                </select>
              </div>

              <div className="qrm-status-filter-pills">
                <button
                  type="button"
                  className={`qrm-filter-pill ${statusFilter === 'all' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('all')}
                >
                  All ({filteredSubmissions.length})
                </button>
                <button
                  type="button"
                  className={`qrm-filter-pill ${statusFilter === 'clean' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('clean')}
                >
                  🟢 Clean ({stats.cleanCount})
                </button>
                <button
                  type="button"
                  className={`qrm-filter-pill ${statusFilter === 'flagged' ? 'active' : ''}`}
                  onClick={() => setStatusFilter('flagged')}
                >
                  ⚠️ Flagged ({stats.flaggedCount})
                </button>
              </div>
            </div>

            {isLoadingSubmissions && submissions.length === 0 ? (
              <div className="qrm-empty-roster">
                <div className="qrm-loading-spinner" />
                <h3>Syncing Submissions…</h3>
                <p>
                  Connecting to cloud database to retrieve candidate papers and audit telemetry.
                </p>
              </div>
            ) : submissions.length === 0 ? (
              <div className="qrm-empty-roster">
                <div className="empty-icon">📝</div>
                <h3>No Submissions Yet</h3>
                <p>
                  When students complete this quiz using code <strong>{currentQuiz.quizCode}</strong>, their answers, scores, and proctoring audit logs will show up here instantly.
                </p>
              </div>
            ) : filteredSubmissions.length === 0 ? (
              <div className="qrm-empty-roster">
                <p>No students matched your search filter.</p>
              </div>
            ) : (
              <div className="qrm-student-list">
                {filteredSubmissions.map((sub) => {
                  const isSelected = selectedSubmission?.id === sub.id;
                  const isClean = sub.violationsCount === 0;
                  const percent = Math.round(sub.percentage);
                  const candGrade = deriveGradeFromPercentage(sub.percentage, currentQuiz.gradeThresholds);

                  return (
                    <div
                      key={sub.id}
                      className={`qrm-student-card ${isSelected ? 'selected' : ''}`}
                      onClick={() => setSelectedSubmission(sub)}
                    >
                      <div className="qrm-sc-col-left">
                        <div className="qrm-sc-name-group">
                          <span
                            className="qrm-sc-dot"
                            style={{
                              background: isSelected
                                ? 'var(--icm-blue)'
                                : percent >= 70
                                ? '#10b981'
                                : percent >= 40
                                ? '#f59e0b'
                                : '#ef4444',
                            }}
                          />
                          <strong className="qrm-sc-name" title={sub.studentName}>{sub.studentName}</strong>
                        </div>
                        <div className="qrm-sc-subline">
                          <span className="qrm-sc-class">{sub.studentClass || 'General'}</span>
                          <span className={`qrm-sc-status ${sub.status || 'submitted'}`}>
                            {sub.status === 'published' ? 'Released' : sub.status === 'graded' ? 'Graded' : 'Awaiting AI'}
                          </span>
                          {sub.forensics?.ingestionSource === 'emergency_offline' && (
                            <span
                              style={{
                                fontSize: '0.68rem',
                                fontWeight: 700,
                                padding: '2px 6px',
                                borderRadius: '6px',
                                background: 'rgba(16, 185, 129, 0.16)',
                                color: '#34d399',
                                border: '1px solid rgba(16, 185, 129, 0.35)',
                              }}
                              title={`Emergency offline package ingested at ${sub.forensics?.ingestedAt || 'hand-in'}`}
                            >
                              📥 Offline Ingested
                            </span>
                          )}
                          {!isClean && (
                            <span className="qrm-sc-strike-tag" title={`${sub.violationsCount} security strike(s)`}>
                              ⚠️ {sub.violationsCount} Strike{sub.violationsCount !== 1 ? 's' : ''}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="qrm-sc-col-right">
                        <div className="qrm-sc-score-block">
                          <span className="qrm-sc-score-raw">
                            {sub.score}<small>/{sub.totalMarks}</small>
                          </span>
                          <span className="qrm-sc-score-pct">{percent}%</span>
                        </div>
                        <span
                          className="grade-tag"
                          style={{
                            backgroundColor: candGrade.color,
                            color: candGrade.textColor,
                          }}
                        >
                          {candGrade.grade}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {submissions.length > 0 && (
              <div className="qrm-roster-footer">
                <button
                  type="button"
                  className="qrm-btn-danger-link"
                  onClick={handleClearAll}
                >
                  🗑️ Clear All Submissions
                </button>
              </div>
            )}
          </div>

          {/* Right Panel: Class Overview Dashboard OR Candidate Script Inspector */}
          <div className="qrm-detail-panel">
            {!selectedSubmission ? (
              <div className="qrm-overview-dashboard animate-fade-in">
                {/* Overview Top Bar */}
                <div className="qrm-ov-header">
                  <div>
                    <h3 className="qrm-ov-title">
                      Class Performance Overview {selectedClass !== 'all' ? `— ${selectedClass}` : '— All Classes'}
                    </h3>
                    <p className="qrm-ov-subtitle">
                      Select any student on the left roster to inspect their individual script, adjust marks, or review proctoring logs.
                    </p>
                  </div>

                  {submissions.length > 0 && (
                    <div className="qrm-ov-quick-exports">
                      <button
                        type="button"
                        className="qrm-btn-main qrm-btn-main-batch"
                        onClick={() =>
                          exportBatchStudentFeedbackReportPdf(submissions, currentQuiz.title, selectedClass, {
                            showMarkScheme: showMarkSchemeInReports,
                            gradeThresholds: currentQuiz.gradeThresholds,
                          })
                        }
                      >
                        🎓 Batch 1-Page Reports
                      </button>
                      <button
                        type="button"
                        className="qrm-btn-main qrm-btn-main-class"
                        onClick={() => exportClassQuizReportPdf(currentQuiz, submissions, selectedClass)}
                      >
                        📄 Class Report (PDF)
                      </button>
                      <button
                        type="button"
                        className="qrm-btn-main qrm-btn-main-excel"
                        onClick={handleExportAllExcel}
                      >
                        📗 Export Excel (.xlsx)
                      </button>
                    </div>
                  )}
                </div>

                {/* 4 Executive KPI Cards */}
                <div className="qrm-ov-kpi-grid">
                  <div className="qrm-ov-kpi-card">
                    <span className="qrm-ov-kpi-label">Total Candidates</span>
                    <span className="qrm-ov-kpi-val">{stats.count}</span>
                    <span className="qrm-ov-kpi-foot">
                      {selectedClass === 'all' ? `${availableClasses.length || 1} cohort(s)` : `Cohort: ${selectedClass}`}
                    </span>
                  </div>

                  <div className="qrm-ov-kpi-card">
                    <span className="qrm-ov-kpi-label">Cohort Average</span>
                    <span className="qrm-ov-kpi-val kpi-val--score">
                      {stats.gradedCount > 0
                        ? `${stats.avgScore.toFixed(1)} / ${currentQuiz.totalMarks}`
                        : stats.count > 0
                          ? 'Awaiting grading'
                          : '—'}
                    </span>
                    <span className="qrm-ov-kpi-foot">
                      {stats.gradedCount > 0
                        ? `${stats.avgPercentage.toFixed(1)}% Mean (${deriveGradeFromPercentage(stats.avgPercentage, currentQuiz.gradeThresholds).grade})${stats.pendingGradingCount > 0 ? ` • ${stats.pendingGradingCount} pending` : ''}`
                        : stats.isProvisional
                          ? `Provisional — ${stats.pendingGradingCount} awaiting AI/teacher grading`
                          : 'No submissions yet'}
                    </span>
                  </div>

                  <div className="qrm-ov-kpi-card">
                    <span className="qrm-ov-kpi-label">Score Range</span>
                    <span className="qrm-ov-kpi-val kpi-val--highest">
                      {stats.gradedCount > 0 ? `${stats.highestScore} / ${currentQuiz.totalMarks}` : '—'}
                    </span>
                    <span className="qrm-ov-kpi-foot">
                      {stats.gradedCount > 0
                        ? `Highest: ${stats.highestScore} • Lowest: ${stats.lowestScore}`
                        : stats.pendingGradingCount > 0
                          ? 'Awaiting grading'
                          : '—'}
                    </span>
                  </div>

                  <div className="qrm-ov-kpi-card">
                    <span className="qrm-ov-kpi-label">Exam Integrity</span>
                    <span className="qrm-ov-kpi-val kpi-val--integrity">
                      {stats.count > 0 ? `${((stats.cleanCount / stats.count) * 100).toFixed(0)}%` : '—'}
                    </span>
                    <span className="qrm-ov-kpi-foot">
                      {stats.cleanCount} Clean • {stats.flaggedCount} Flagged
                    </span>
                  </div>
                </div>

                {/* Grade Band Distribution & Curve Card */}
                <div className="qrm-ov-section-card">
                  <div className="qrm-ov-section-header">
                    <div>
                      <h4>📈 Grade Band Distribution (A* – U)</h4>
                      <p>Live distribution of candidates across configured Cambridge grade thresholds.</p>
                    </div>
                    <button
                      type="button"
                      className={`qrm-btn-header-ghost ${isCurveEditorOpen ? 'active' : ''}`}
                      onClick={() => setIsCurveEditorOpen((prev) => !prev)}
                    >
                      {isCurveEditorOpen ? '✓ Hide Curve Editor' : '⚙️ Adjust Grade Curve'}
                    </button>
                  </div>

                  {(() => {
                    const gt = sanitizeGradeThresholds(currentQuiz.gradeThresholds);
                    const tiers: { grade: GradeLetter; cutoffLabel: string }[] = [
                      { grade: 'A*', cutoffLabel: `≥ ${gt.aStar}%` },
                      { grade: 'A', cutoffLabel: `${gt.a}–${gt.aStar - 1}%` },
                      { grade: 'B', cutoffLabel: `${gt.b}–${gt.a - 1}%` },
                      { grade: 'C', cutoffLabel: `${gt.c}–${gt.b - 1}%` },
                      { grade: 'D', cutoffLabel: `${gt.d}–${gt.c - 1}%` },
                      { grade: 'E', cutoffLabel: `${gt.e}–${gt.d - 1}%` },
                      { grade: 'U', cutoffLabel: `< ${gt.e}%` },
                    ];

                    return (
                      <div className="qrm-grade-dist-grid">
                        {tiers.map(({ grade, cutoffLabel }) => {
                          const gCount = stats.gradeCounts[grade] || 0;
                          const gPct = stats.gradedCount > 0 ? Math.round((gCount / stats.gradedCount) * 100) : 0;
                          const vis = GRADE_VISUALS[grade];

                          return (
                            <div key={grade} className="qrm-grade-dist-col">
                              <div className="qrm-gd-top">
                                <span
                                  className="qrm-gd-pill"
                                  style={{ backgroundColor: vis.color, color: vis.textColor }}
                                >
                                  {grade}
                                </span>
                                <span className="qrm-gd-cutoff">{cutoffLabel}</span>
                              </div>
                              <div className="qrm-gd-bar-track">
                                <div
                                  className="qrm-gd-bar-fill"
                                  style={{
                                    height: `${Math.max(gCount > 0 ? 10 : 0, gPct)}%`,
                                    background: vis.color,
                                  }}
                                />
                              </div>
                              <div className="qrm-gd-bottom">
                                <strong>{gCount}</strong>
                                <span>({gPct}%)</span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>

                {/* Class-Wide Syllabus Topic Mastery */}
                {stats.classTopics.length > 0 && (
                  <div className="qrm-ov-section-card">
                    <div className="qrm-ov-section-header">
                      <div>
                        <h4>🎯 Cohort Syllabus Topic Mastery</h4>
                        <p>Aggregated accuracy across {stats.gradedCount} graded candidate{stats.gradedCount !== 1 ? 's' : ''} (sorted from lowest to highest mastery).</p>
                      </div>
                    </div>
                    <div className="topic-bars">
                      {stats.classTopics.map((t) => (
                        <div key={t.topic} className="topic-bar-row">
                          <div className="topic-bar-labels">
                            <span>{t.topic}</span>
                            <span>
                              {t.earnedMarks} / {t.totalMarks} marks ({Math.round(t.percentage)}%)
                            </span>
                          </div>
                          <div className="topic-progress-bg">
                            <div
                              className="topic-progress-fill"
                              style={{
                                width: `${Math.min(100, Math.max(0, t.percentage))}%`,
                                background:
                                  t.percentage >= 75
                                    ? '#10b981'
                                    : t.percentage >= 50
                                    ? 'var(--icm-blue)'
                                    : '#ef4444',
                              }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="qrm-detail-content animate-fade-in">
                {/* Candidate Quick Navigation Bar */}
                {(() => {
                  const curIdx = filteredSubmissions.findIndex((s) => s.id === selectedSubmission.id);
                  const prevSub = curIdx > 0 ? filteredSubmissions[curIdx - 1] : null;
                  const nextSub = curIdx >= 0 && curIdx < filteredSubmissions.length - 1 ? filteredSubmissions[curIdx + 1] : null;

                  return (
                    <div className="qrm-cand-nav-bar">
                      <button
                        type="button"
                        className="qrm-back-overview-btn"
                        onClick={() => setSelectedSubmission(null)}
                      >
                        ← Back to Class Overview
                      </button>

                      <div className="qrm-cand-Order-controls">
                        <span className="qrm-cand-pos-label">
                          Candidate {curIdx >= 0 ? curIdx + 1 : 1} of {filteredSubmissions.length}
                        </span>
                        <button
                          type="button"
                          className="qrm-cand-step-btn"
                          disabled={!prevSub}
                          onClick={() => prevSub && setSelectedSubmission(prevSub)}
                          title={prevSub ? `Previous: ${prevSub.studentName}` : 'First candidate'}
                        >
                          ◀ Prev
                        </button>
                        <button
                          type="button"
                          className="qrm-cand-step-btn"
                          disabled={!nextSub}
                          onClick={() => nextSub && setSelectedSubmission(nextSub)}
                          title={nextSub ? `Next: ${nextSub.studentName}` : 'Last candidate'}
                        >
                          Next ▶
                        </button>
                      </div>
                    </div>
                  );
                })()}

                {/* Candidate Overview Card */}
                <div className="qrm-candidate-header-card">
                  <div className="cand-info">
                    <h2>{selectedSubmission.studentName}</h2>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center', margin: '4px 0 6px', flexWrap: 'wrap' }}>
                      <span style={{ background: 'var(--icm-blue, #24448c)', color: '#ffffff', padding: '2px 8px', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 700 }}>
                        Class: {selectedSubmission.studentClass || 'General'}
                      </span>
                      {selectedSubmission.candidateNumber && (
                        <span style={{ background: 'var(--color-surface-sunken)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', padding: '2px 8px', borderRadius: '4px', fontSize: '0.75rem', fontFamily: 'monospace' }}>
                          Cand ID: #{selectedSubmission.candidateNumber}
                        </span>
                      )}
                      {selectedSubmission.resultPin && (
                        <span
                          style={{
                            background: 'rgba(234, 179, 8, 0.15)',
                            color: '#b45309',
                            border: '1px solid rgba(234, 179, 8, 0.3)',
                            padding: '2px 8px',
                            borderRadius: '4px',
                            fontSize: '0.75rem',
                            fontFamily: 'monospace',
                            fontWeight: 700,
                          }}
                          title="Candidate 3-digit Personal Access PIN"
                        >
                          PIN: {selectedSubmission.resultPin}
                        </span>
                      )}
                    </div>
                    <p>
                      Submitted on {formatSubmissionDateTime(selectedSubmission.submittedAt)}
                      {selectedSubmission.durationSeconds > 0 ? ` • Duration: ${Math.floor(selectedSubmission.durationSeconds / 60)}m ${selectedSubmission.durationSeconds % 60}s` : ''}
                    </p>
                  </div>

                  <div className="cand-grade">
                    {isEditingTotalScore ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }} onClick={(e) => e.stopPropagation()}>
                        <input
                          type="number"
                          min={0}
                          max={selectedSubmission.totalMarks}
                          value={editTotalScoreInput}
                          onChange={(e) => setEditTotalScoreInput(e.target.value ? Number(e.target.value) : ('' as any))}
                          className="qrm-mark-number-input"
                          style={{ width: '58px', fontSize: '0.95rem', padding: '4px 6px' }}
                        />
                        <span style={{ fontSize: '0.875rem', fontWeight: 700 }}>/ {selectedSubmission.totalMarks}</span>
                        <button
                          type="button"
                          className="qrm-grade-save-btn"
                          onClick={handleSaveTotalScoreOverride}
                        >
                          ✓ Save
                        </button>
                        <button
                          type="button"
                          className="qrm-grade-cancel-btn"
                          onClick={() => setIsEditingTotalScore(false)}
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className="cand-grade-num">
                          {selectedSubmission.score} / {selectedSubmission.totalMarks}
                        </span>
                        <span className="cand-grade-pct">{selectedSubmission.percentage.toFixed(1)}%</span>
                        {(() => {
                          const sg = deriveGradeFromPercentage(selectedSubmission.percentage, currentQuiz.gradeThresholds);
                          return (
                            <span
                              style={{
                                backgroundColor: sg.color,
                                color: sg.textColor,
                                fontWeight: 800,
                                padding: '3px 8px',
                                borderRadius: '4px',
                                fontSize: '0.8rem',
                                marginLeft: '8px',
                              }}
                            >
                              Grade {sg.grade}
                            </span>
                          );
                        })()}
                        <button
                          type="button"
                          className="qrm-grade-edit-btn"
                          style={{ marginTop: '4px' }}
                          onClick={() => {
                            setIsEditingTotalScore(true);
                            setEditTotalScoreInput(selectedSubmission.score);
                          }}
                          title="Directly adjust candidate total score"
                        >
                          ✏️ Edit Total Score
                        </button>
                      </>
                    )}
                  </div>

                  <div className="cand-actions">
                    <button
                      type="button"
                      className="qrm-btn"
                      style={{
                        background: '#7c3aed',
                        color: '#ffffff',
                        fontWeight: 700,
                        fontSize: '0.8125rem',
                        padding: '6px 12px',
                        borderRadius: '6px',
                        border: 'none',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                      onClick={() => exportStudentFeedbackReportPdf(selectedSubmission, undefined, { showMarkScheme: showMarkSchemeInReports, gradeThresholds: currentQuiz.gradeThresholds })}
                      title="Print 1-page student feedback & improvement report card"
                    >
                      🎓 1-Page Report
                    </button>

                    <button
                      type="button"
                      className="qrm-btn"
                      style={{
                        background: '#dc2626',
                        color: '#ffffff',
                        fontWeight: 700,
                        fontSize: '0.8125rem',
                        padding: '6px 12px',
                        borderRadius: '6px',
                        border: 'none',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                      onClick={() => exportIndividualStudentReportPdf(selectedSubmission, { showMarkScheme: showMarkSchemeInReports, gradeThresholds: currentQuiz.gradeThresholds })}
                      title="Export this candidate's full diagnostic script as PDF"
                    >
                      📄 Full Script
                    </button>

                    <button
                      type="button"
                      className="qrm-btn qrm-btn-excel-sm"
                      onClick={() => handleExportSingleExcel(selectedSubmission)}
                      title="Export individual student report to Excel (.xlsx)"
                    >
                      📗 Export Excel (.xlsx)
                    </button>

                    <button
                      type="button"
                      className="cand-delete-btn"
                      onClick={() => handleDelete(selectedSubmission.id)}
                      title="Delete this submission"
                    >
                      🗑️
                    </button>
                  </div>
                </div>

                {/* 🔒 Anti-Cheating & Proctoring Audit Box (Only for Online exams) */}
                {selectedSubmission.durationSeconds > 0 && !selectedSubmission.quizCode?.startsWith('OFFLINE') && (
                  <div className={`qrm-proctor-card ${selectedSubmission.violationsCount > 0 ? 'alert' : 'clean'}`}>
                    <div className="proctor-header">
                      <span className="proctor-icon">
                        {selectedSubmission.violationsCount === 0 ? '🛡️' : '🚨'}
                      </span>
                      <div>
                        <strong>Exam Browser & Proctoring Audit Trail</strong>
                        <p>
                          {selectedSubmission.violationsCount === 0
                            ? 'Zero suspicious events detected. Candidate remained in fullscreen and stayed focused.'
                            : `${selectedSubmission.violationsCount} security violation strike(s) recorded during the session.`}
                        </p>
                      </div>
                    </div>

                    {selectedSubmission.forensics?.autoSubmittedBySecurity ? (
                      <div className="proctor-exceeded-banner" style={{ background: 'rgba(239, 68, 68, 0.15)', borderColor: '#ef4444' }}>
                        🛑 <strong>Auto-Submitted by Security Policy:</strong> Candidate reached final violation tier ({selectedSubmission.forensics.finalTierReached || 'Auto-Submit'}). The exam was automatically locked and submitted.
                      </div>
                    ) : selectedSubmission.forensics?.exceededMaxViolations ? (
                      <div className="proctor-exceeded-banner animate-pulse">
                        🚨 <strong>Security Threshold Exceeded:</strong> Candidate exceeded the allowed strike threshold ({selectedSubmission.forensics?.finalStrikeCount ?? selectedSubmission.violationsCount} strikes recorded).
                      </div>
                    ) : null}

                    {Boolean(selectedSubmission.forensics?.totalPenaltySeconds && selectedSubmission.forensics.totalPenaltySeconds > 0) && (
                      <div style={{
                        marginTop: '8px',
                        padding: '6px 12px',
                        background: 'rgba(234, 88, 12, 0.12)',
                        border: '1px solid rgba(234, 88, 12, 0.3)',
                        borderRadius: '6px',
                        fontSize: '0.8125rem',
                        color: 'var(--color-text-primary)',
                      }}>
                        ⏱️ <strong>Time Penalties Applied:</strong> Total {Math.round(selectedSubmission.forensics!.totalPenaltySeconds! / 60)} minutes deducted across violation escalation tiers.
                      </div>
                    )}

                    {selectedSubmission.proctoringLogs && selectedSubmission.proctoringLogs.length > 0 && (
                      <div className="proctor-timeline">
                        {selectedSubmission.proctoringLogs.map((log, idx) => (
                          <div key={idx} className={`proctor-log-item ${log.severity === 'critical' ? 'critical' : 'warning'}`}>
                            <span className="log-strike-tag">Strike {log.strike}</span>
                            <span className="log-type-icon" title={log.type || 'violation'}>
                              {getViolationIcon(log.type)}
                            </span>
                            <span className="log-time">
                              {formatProctorTimestamp(log.timestamp)}
                              {log.elapsedExamSeconds !== undefined && log.elapsedExamSeconds >= 0 && (
                                <span className="log-elapsed"> ({formatElapsedSeconds(log.elapsedExamSeconds)})</span>
                              )}
                            </span>
                            <span className="log-event">{log.event}</span>
                            {log.severity && (
                              <span className={`log-severity-badge ${log.severity}`}>
                                {log.severity.toUpperCase()}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Topic Breakdown Progress */}
                {selectedSubmission.topicBreakdown && Object.keys(selectedSubmission.topicBreakdown).length > 0 && (
                  <div className="qrm-topics-card">
                    <h4>Topic Mastery Breakdown</h4>
                    <div className="topic-bars">
                      {Object.entries(selectedSubmission.topicBreakdown).map(([top, data]) => (
                        <div key={top} className="topic-bar-row">
                          <div className="topic-bar-labels">
                            <span>{top}</span>
                            <span>{data.earnedMarks} / {data.totalMarks} ({Math.round(data.percentage)}%)</span>
                          </div>
                          <div className="topic-progress-bg">
                            <div
                              className="topic-progress-fill"
                              style={{ width: `${Math.min(100, Math.max(0, data.percentage))}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Detailed Questions & Answers List */}
                <div className="qrm-questions-breakdown">
                  <h4>Question Responses ({selectedSubmission.questionResults?.length || 0})</h4>

                  <div className="qrm-questions-list">
                    {selectedSubmission.questionResults?.map((qr) => {
                      const timeAnalytics = selectedSubmission.forensics?.questionTimeAnalytics?.find(
                        (t) => t.questionId === qr.questionId || t.questionIndex === qr.questionNumber - 1
                      );
                      const qRevisions = selectedSubmission.forensics?.answerChangeLogs?.filter(
                        (c) => c.questionId === qr.questionId || c.questionIndex === qr.questionNumber - 1
                      ) || [];
                      const masterQuestion =
                        masterQuestions.find((mq) => mq.id === qr.questionId) ||
                        masterQuestions[qr.questionNumber - 1];
                      const displayCorrectAnswer =
                        (!qr.correctAnswer || qr.correctAnswer === 'See mark scheme') && masterQuestion
                          ? resolveQuestionModelAnswer(masterQuestion)
                          : qr.correctAnswer;

                      return (
                        <div
                          key={qr.questionId}
                          className={`qrm-q-item ${qr.isCorrect ? 'correct' : 'incorrect'}`}
                        >
                          <div className="q-item-header">
                            <div className="q-num-topic">
                              <span className="q-badge">Q{qr.questionNumber}</span>
                              <span className="q-topic">{qr.topic}</span>
                              {timeAnalytics && (
                                <span
                                  className={`q-dwell-badge ${timeAnalytics.totalDwellSeconds < 5 && timeAnalytics.totalDwellSeconds > 0 ? 'rapid' : ''}`}
                                  title={`Total dwell: ${timeAnalytics.totalDwellSeconds}s across ${timeAnalytics.visitCount} visits`}
                                >
                                  ⏱️ {Math.floor(timeAnalytics.totalDwellSeconds / 60)}m {timeAnalytics.totalDwellSeconds % 60}s • {timeAnalytics.visitCount}v
                                  {timeAnalytics.totalDwellSeconds < 5 && timeAnalytics.totalDwellSeconds > 0 && ' ⚡'}
                                </span>
                              )}
                              {qRevisions.length > 0 && (
                                <button
                                  type="button"
                                  className="q-revision-pill-btn"
                                  onClick={() => toggleRevision(qr.questionId)}
                                  title="View answer change forensic timeline"
                                >
                                  ✏️ {qRevisions.length} rev{qRevisions.length !== 1 ? 's' : ''} {expandedRevisions[qr.questionId] ? '▲' : '▼'}
                                </button>
                              )}
                            </div>

                          <div className="q-marks-tag" style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                            {editingQuestionId === qr.questionId ? (
                              <div className="qrm-grade-action-bar" onClick={(e) => e.stopPropagation()}>
                                {qr.subQuestionResults && qr.subQuestionResults.length > 0 ? (
                                  <span
                                    className="qrm-auto-total-badge"
                                    title="Total mark is automatically calculated from the sum of sub-questions below"
                                  >
                                    ∑ {editMarksInput} / {qr.maxMarks} Marks (from parts)
                                  </span>
                                ) : (
                                  <div className="qrm-mark-input-group">
                                    <input
                                      type="number"
                                      min={0}
                                      max={qr.maxMarks}
                                      step="any"
                                      value={editMarksInput}
                                      onChange={(e) => setEditMarksInput(e.target.value !== '' ? Number(e.target.value) : ('' as any))}
                                      className="qrm-mark-number-input"
                                    />
                                    <span className="qrm-mark-denom">/ {qr.maxMarks}</span>
                                  </div>
                                )}
                                <button
                                  type="button"
                                  className="qrm-grade-save-btn"
                                  onClick={() => handleSaveMarkOverride(qr)}
                                  title="Save marks and remark immediately"
                                >
                                  ✓ Save
                                </button>
                                <button
                                  type="button"
                                  className="qrm-grade-cancel-btn"
                                  onClick={() => setEditingQuestionId(null)}
                                  title="Cancel editing"
                                >
                                  ✕ Cancel
                                </button>
                              </div>
                            ) : (
                              <>
                                {savedQuestionId === qr.questionId && (
                                  <span className="qrm-saved-pill animate-fade-in">
                                    ✓ Saved
                                  </span>
                                )}
                                <span>
                                  {qr.isCorrect ? '✓ ' : '✗ '}
                                  {qr.subQuestionResults && qr.subQuestionResults.length > 0
                                    ? Math.min(
                                        qr.maxMarks,
                                        qr.subQuestionResults.reduce((acc, s) => acc + (Number(s.earnedMarks) || 0), 0)
                                      )
                                    : qr.earnedMarks}{' '}
                                  / {qr.maxMarks} Mark{qr.maxMarks !== 1 ? 's' : ''}
                                </span>
                                <button
                                  type="button"
                                  className="qrm-grade-edit-btn"
                                  onClick={() => handleStartEditing(qr)}
                                  title={
                                    qr.subQuestionResults && qr.subQuestionResults.length > 0
                                      ? 'Grade individual sub-questions or add teacher remark'
                                      : 'Adjust mark or add teacher remark'
                                  }
                                >
                                  ✏️ {qr.subQuestionResults && qr.subQuestionResults.length > 0 ? 'Grade Parts' : 'Edit Mark / Remark'}
                                </button>
                              </>
                            )}
                          </div>
                        </div>

                        {/* Teacher Remark Input Form if editing */}
                        {editingQuestionId === qr.questionId && (
                          <div className="qrm-teacher-remark-box">
                            <label className="qrm-teacher-remark-label">
                              Teacher Remark / Feedback Annotation (optional):
                            </label>
                            <input
                              type="text"
                              placeholder="e.g. Awarded +1 for valid alternative derivation of molar volume"
                              value={editTeacherNote}
                              onChange={(e) => setEditTeacherNote(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  handleSaveMarkOverride(qr);
                                }
                              }}
                              className="qrm-teacher-remark-input"
                            />
                          </div>
                        )}

                        <div className="q-answer-details">
                          {/* Sub-Questions Results if present */}
                          {qr.subQuestionResults && qr.subQuestionResults.length > 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '8px' }}>
                              {qr.subQuestionResults.map((sub, sIdx) => {
                                const cleanSubId = String(sub.subId || sIdx + 1).replace(/^\(+|\)+$/g, '');
                                const subMax = sub.maxMarks || 1;
                                const isEditingThisQuestion = editingQuestionId === qr.questionId;
                                const activeSubMark = isEditingThisQuestion
                                  ? Number(editSubMarksInput[sIdx] ?? sub.earnedMarks ?? 0)
                                  : Number(sub.earnedMarks ?? 0);
                                const isSubFullMarks = activeSubMark >= subMax;

                                return (
                                  <div
                                    key={sIdx}
                                    className={`qrm-sub-item-card ${isEditingThisQuestion ? 'is-editing' : ''}`}
                                  >
                                    <div className="qrm-sub-item-header">
                                      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flex: 1 }}>
                                        <strong className="qrm-sub-part-label">Part ({cleanSubId})</strong>
                                        {sub.questionText && (
                                          <span className="qrm-sub-prompt-snippet">
                                            <ExamMathText content={sub.questionText} />
                                          </span>
                                        )}
                                      </div>

                                      {isEditingThisQuestion ? (
                                        <div className="qrm-sub-grade-controls" onClick={(e) => e.stopPropagation()}>
                                          {subMax <= 5 && Number.isInteger(subMax) && (
                                            <div className="qrm-sub-quick-pills" title="Quickly select mark for this part">
                                              {Array.from({ length: subMax + 1 }, (_, m) => (
                                                <button
                                                  key={m}
                                                  type="button"
                                                  className={`qrm-sub-quick-pill ${activeSubMark === m ? (m === subMax ? 'active-full' : m > 0 ? 'active-partial' : 'active-zero') : ''}`}
                                                  onClick={() => handleSubMarkChange(qr, sIdx, m)}
                                                >
                                                  {m}
                                                </button>
                                              ))}
                                            </div>
                                          )}
                                          <div className="qrm-sub-input-wrap">
                                            <input
                                              type="number"
                                              min={0}
                                              max={subMax}
                                              step="any"
                                              value={editSubMarksInput[sIdx] ?? sub.earnedMarks ?? 0}
                                              onChange={(e) =>
                                                handleSubMarkChange(
                                                  qr,
                                                  sIdx,
                                                  e.target.value !== '' ? Number(e.target.value) : 0
                                                )
                                              }
                                              onKeyDown={(e) => {
                                                if (e.key === 'Enter') {
                                                  e.preventDefault();
                                                  handleSaveMarkOverride(qr);
                                                }
                                              }}
                                              className="qrm-sub-mark-input"
                                            />
                                            <span className="qrm-sub-mark-max">
                                              / {subMax} mark{subMax !== 1 ? 's' : ''}
                                            </span>
                                          </div>
                                        </div>
                                      ) : (
                                        <button
                                          type="button"
                                          className={`qrm-sub-mark-badge-btn ${isSubFullMarks ? 'is-correct' : activeSubMark > 0 ? 'is-partial' : 'is-zero'}`}
                                          onClick={() => handleStartEditing(qr)}
                                          title={`Click to edit mark for Part (${cleanSubId})`}
                                        >
                                          <span>
                                            {activeSubMark} / {subMax} mark{subMax !== 1 ? 's' : ''}
                                          </span>
                                          <span className="qrm-sub-edit-hint">✏️</span>
                                        </button>
                                      )}
                                    </div>
                                    <div style={{ color: 'var(--color-text-secondary)' }}>
                                      Candidate Answer:{' '}
                                      <strong style={{ color: 'var(--color-text-primary)' }}>
                                        <ExamMathText content={String(sub.studentAnswer || '(blank)')} />
                                      </strong>
                                    </div>
                                    {sub.feedback && (
                                      <div style={{ fontSize: '0.75rem', color: isSubFullMarks ? '#16a34a' : 'var(--color-text-secondary)', marginTop: 3 }}>
                                        <ExamMathText content={sub.feedback} />
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="ans-block">
                              <span className="ans-lbl">Student Answer:</span>
                              <span className={`ans-val ${qr.isCorrect ? 'correct-text' : 'wrong-text'}`}>
                                <ExamMathText content={formatCandidateAnswer(qr.studentAnswer, qr.options, qr.gradingMethod)} />
                              </span>
                            </div>
                          )}

                          {qr.aiFeedback && (
                            <div style={{ background: 'rgba(139, 92, 246, 0.1)', border: '1px solid rgba(139, 92, 246, 0.3)', borderRadius: '6px', padding: '6px 10px', margin: '6px 0', fontSize: '0.8125rem' }}>
                              <strong style={{ color: '#a78bfa', display: 'block', marginBottom: 2 }}>💡 Examiner Feedback:</strong>
                              <ExamMathText content={qr.aiFeedback} />
                            </div>
                          )}

                          {displayCorrectAnswer && (
                            <div className="ans-block">
                              <span className="ans-lbl">Model Solution / Correct Answer:</span>
                              <div className="ans-val model-text">
                                <ExamMathText content={formatCandidateAnswer(displayCorrectAnswer, qr.options || masterQuestion?.options, qr.gradingMethod)} />
                              </div>
                            </div>
                          )}

                          {qr.misconceptions && qr.misconceptions.length > 0 && (
                            <div className="ans-misconceptions">
                              <span className="misc-lbl">⚠️ Common Misconception:</span>
                              <ul>
                                {qr.misconceptions.map((m, mIdx) => (
                                  <li key={mIdx}>{m}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                          {/* Forensic Answer Revision Timeline */}
                          {expandedRevisions[qr.questionId] && qRevisions.length > 0 && (
                            <div className="q-revision-timeline animate-fade-in">
                              <div className="q-revision-timeline-header">
                                <span>Forensic Answer Revision Trail:</span>
                                <span className="q-revision-count">{qRevisions.length} modification{qRevisions.length !== 1 ? 's' : ''}</span>
                              </div>
                              <div className="q-revision-list">
                                {qRevisions.map((rev, rIdx) => (
                                  <div key={rIdx} className="q-revision-item">
                                    <span className="rev-num">#{rIdx + 1}</span>
                                    <span className="rev-elapsed">{formatElapsedSeconds(rev.elapsedExamSeconds)}</span>
                                    <div className="rev-change">
                                      <span className="rev-old">
                                        {formatCandidateAnswer(rev.previousAnswer, qr.options, qr.gradingMethod, true) || '(empty)'}
                                      </span>
                                      <span className="rev-arrow">➔</span>
                                      <span className="rev-new">
                                        {formatCandidateAnswer(rev.newAnswer, qr.options, qr.gradingMethod, true)}
                                      </span>
                                    </div>
                                    {rev.timeSinceLastActionMs < 2000 && rev.timeSinceLastActionMs > 0 && (
                                      <span className="rev-rapid-tag" title={`Changed in ${rev.timeSinceLastActionMs}ms`}>
                                        ⚡ Rapid (&lt;2s)
                                      </span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ─── Manual Exam Paper Import Modal ─── */}
      {isImportModalOpen && (
        <div
          className="qrm-import-backdrop animate-fade-in"
          {...importModalDismiss}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(6px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10000,
            padding: '20px',
          }}
        >
          <div
            className="qrm-import-modal animate-scale-up"
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#0f172a',
              border: '1px solid rgba(255, 255, 255, 0.15)',
              borderRadius: '16px',
              maxWidth: '680px',
              width: '100%',
              maxHeight: '88vh',
              overflowY: 'auto',
              padding: '24px',
              boxShadow: '0 20px 40px rgba(0, 0, 0, 0.5)',
              color: '#f8fafc',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>📥</span> Batch Ingest Emergency Offline Papers (.exam)
              </h3>
              <button
                type="button"
                onClick={() => setIsImportModalOpen(false)}
                style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: '1.2rem', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>

            <p style={{ fontSize: '0.84rem', color: '#94a3b8', marginTop: 0, marginBottom: '16px', lineHeight: 1.5 }}>
              Drag and drop one or multiple <strong>AES-256-GCM encrypted <code>.exam</code></strong> files collected via USB or device file transfer. Conflict resolution automatically applies <strong>Newest Timestamp Wins</strong>.
            </p>

            {/* Option 1: Multi-File Batch Drag & Drop Zone */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDragOverDropzone(true);
              }}
              onDragLeave={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDragOverDropzone(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setIsDragOverDropzone(false);
                if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                  handleBatchFilesProcess(e.dataTransfer.files);
                }
              }}
              style={{
                border: isDragOverDropzone
                  ? '2px dashed #10b981'
                  : '2px dashed rgba(255, 255, 255, 0.25)',
                borderRadius: '14px',
                padding: '24px 20px',
                textAlign: 'center',
                marginBottom: '16px',
                background: isDragOverDropzone
                  ? 'rgba(16, 185, 129, 0.1)'
                  : 'rgba(255, 255, 255, 0.03)',
                transition: 'all 0.15s ease',
              }}
            >
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".exam,.json"
                onChange={handleFileUpload}
                style={{ display: 'none' }}
              />
              <div style={{ fontSize: '2rem', marginBottom: '8px' }}>
                {isImporting ? '⏳' : isDragOverDropzone ? '📂' : '🛡️'}
              </div>
              <div style={{ fontSize: '0.92rem', fontWeight: 700, color: '#f1f5f9', marginBottom: '8px' }}>
                {isImporting
                  ? 'Decrypting & verifying emergency packages...'
                  : 'Drag & drop multiple .exam files here'}
              </div>
              <button
                type="button"
                disabled={isImporting}
                onClick={() => fileInputRef.current?.click()}
                style={{
                  background: '#3b82f6',
                  color: '#ffffff',
                  border: 'none',
                  padding: '10px 20px',
                  borderRadius: '8px',
                  fontWeight: 700,
                  fontSize: '0.875rem',
                  cursor: isImporting ? 'not-allowed' : 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
              >
                📁 Select .exam Files (Batch Supported)
              </button>
              <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '8px' }}>
                Verifies AES-GCM authentication tags &bull; Syncs directly to Supabase cloud
              </div>
            </div>

            {/* Batch Ingestion Results & Audit Table */}
            {batchIngestionSummary && (
              <div
                style={{
                  background: 'rgba(15, 23, 42, 0.65)',
                  border: '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: '12px',
                  padding: '14px',
                  marginBottom: '16px',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: '10px',
                    marginBottom: '12px',
                    fontSize: '0.78rem',
                    fontWeight: 700,
                  }}
                >
                  <span style={{ color: '#94a3b8' }}>
                    Files Processed: <strong style={{ color: '#fff' }}>{batchIngestionSummary.totalFiles}</strong>
                  </span>
                  <span style={{ color: '#22c55e' }}>
                    ✅ New: {batchIngestionSummary.insertedCount}
                  </span>
                  <span style={{ color: '#38bdf8' }}>
                    🔄 Updated: {batchIngestionSummary.updatedCount}
                  </span>
                  <span style={{ color: '#f59e0b' }}>
                    ⏭️ Skipped (Older): {batchIngestionSummary.skippedOlderCount}
                  </span>
                  {batchIngestionSummary.failedCount > 0 && (
                    <span style={{ color: '#ef4444' }}>
                      ❌ Failed: {batchIngestionSummary.failedCount}
                    </span>
                  )}
                </div>

                <div style={{ maxHeight: '180px', overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.1)', textAlign: 'left', color: '#94a3b8' }}>
                        <th style={{ padding: '6px 8px' }}>Candidate</th>
                        <th style={{ padding: '6px 8px' }}>File</th>
                        <th style={{ padding: '6px 8px' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {batchIngestionSummary.results.map((r, idx) => (
                        <tr key={`${r.fileName}_${idx}`} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
                          <td style={{ padding: '6px 8px', fontWeight: 600 }}>
                            {r.studentName || 'Unknown'}
                            {r.candidateNumber ? ` (#${r.candidateNumber})` : ''}
                          </td>
                          <td style={{ padding: '6px 8px', color: '#94a3b8', fontFamily: 'monospace', fontSize: '0.72rem' }}>
                            {r.fileName}
                          </td>
                          <td style={{ padding: '6px 8px' }}>
                            {r.status === 'inserted' && (
                              <span style={{ color: '#22c55e', fontWeight: 700 }}>✅ Valid New Paper</span>
                            )}
                            {r.status === 'updated' && (
                              <span style={{ color: '#38bdf8', fontWeight: 700 }}>🔄 Updated (Newer than Cloud)</span>
                            )}
                            {r.status === 'skipped_older' && (
                              <span style={{ color: '#f59e0b', fontWeight: 700 }} title={r.reason}>
                                ⏭️ Skipped (Older than Cloud)
                              </span>
                            )}
                            {r.status === 'failed' && (
                              <span style={{ color: '#ef4444', fontWeight: 700 }} title={r.error}>
                                ❌ {r.error || 'Decryption Failed'}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div style={{ textAlign: 'center', margin: '12px 0', color: '#64748b', fontSize: '0.8125rem', fontWeight: 700 }}>
              — OR PASTE SINGLE EXAM TOKEN / JSON —
            </div>

            {/* Option 2: Paste Token / JSON */}
            <textarea
              placeholder="Paste EXAM_TOKEN:... or encrypted .exam JSON payload here"
              value={importTokenInput}
              onChange={(e) => setImportTokenInput(e.target.value)}
              rows={3}
              style={{
                width: '100%',
                background: '#1e293b',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                borderRadius: '8px',
                padding: '10px',
                color: '#ffffff',
                fontFamily: 'monospace',
                fontSize: '0.8125rem',
                boxSizing: 'border-box',
                resize: 'vertical',
              }}
            />

            {importError && (
              <div style={{ color: '#ef4444', fontSize: '0.8125rem', marginTop: '8px', fontWeight: 600 }}>
                ⚠️ {importError}
              </div>
            )}

            {importSuccessMsg && (
              <div style={{ color: '#22c55e', fontSize: '0.8125rem', marginTop: '8px', fontWeight: 600 }}>
                {importSuccessMsg}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '18px' }}>
              <button
                type="button"
                onClick={() => setIsImportModalOpen(false)}
                style={{
                  background: 'rgba(255, 255, 255, 0.1)',
                  border: 'none',
                  color: '#ffffff',
                  padding: '8px 16px',
                  borderRadius: '8px',
                  fontSize: '0.875rem',
                  cursor: 'pointer',
                }}
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => handleImportSubmit(importTokenInput)}
                disabled={isImporting || !importTokenInput.trim()}
                style={{
                  background: '#10b981',
                  border: 'none',
                  color: '#ffffff',
                  padding: '8px 18px',
                  borderRadius: '8px',
                  fontSize: '0.875rem',
                  fontWeight: 700,
                  cursor: isImporting || !importTokenInput.trim() ? 'not-allowed' : 'pointer',
                  opacity: isImporting || !importTokenInput.trim() ? 0.6 : 1,
                }}
              >
                {isImporting ? 'Importing...' : '📥 Import Pasted Token'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Delete Modal */}
      <ConfirmDeleteModal
        isOpen={deleteModalState.isOpen}
        title={deleteModalState.title}
        message={deleteModalState.message}
        isDeleting={isDeleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteModalState((s) => ({ ...s, isOpen: false }))}
      />
    </div>,
    document.body
  );
}
