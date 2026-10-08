import { useState, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import type { Question } from '../types/database';
import {
  fetchCustomTestsWithMetadata,
  fetchCustomTestWithQuestions,
  type CustomTestWithDetails,
  type ExamHeaderConfig,
} from '../services/testBuilderService';
import {
  getPublishedQuizzes,
  loadAndSyncPublishedQuizzes,
  savePublishedQuiz,
  deletePublishedQuiz,
  toggleQuizActiveStatus,
  createDraftFromTest,
  type PublishedQuiz,
} from '../services/quizManagerService';
import { getSubmissionsForQuiz, loadAndSyncAllSubmissions } from '../services/quizSubmissionService';
import { fetchQuestionsByIds } from '../services/quizCodeService';
import { QuizResultsModal } from '../components/QuizResultsModal';
import { OfflineGradingModal } from '../components/OfflineGradingModal';
import { LiveInvigilatorModal } from '../components/LiveInvigilatorModal';
import { ConfirmDeleteModal } from '../components/ConfirmDeleteModal';
import { getSavedSettings } from '../lib/settings';
import { SubjectIcon, getSubjectMetadata } from '../utils/subjectMeta';
import './QuizManagerPage.css';

interface QuizManagerPageProps {
  onLaunchTestRun: (questions: Question[], headerConfig?: ExamHeaderConfig) => void;
  onLaunchGameHost?: (quiz: PublishedQuiz, questions: Question[]) => void;
  onNavigateToBuilder?: () => void;
  onNavigateToSaved?: () => void;
  onNavigateToBank?: () => void;
}

type SortOption = 'latest' | 'submissions' | 'title';
type FilterStatus = 'all' | 'active' | 'paused' | 'exam' | 'game';

export function QuizManagerPage({
  onLaunchTestRun,
  onLaunchGameHost,
  onNavigateToBuilder,
  onNavigateToSaved,
  onNavigateToBank: _onNavigateToBank,
}: QuizManagerPageProps) {
  const [quizzes, setQuizzes] = useState<PublishedQuiz[]>(() => {
    try {
      const pubList = getPublishedQuizzes();
      return pubList.map((q) => {
        if (!q.subject || q.subject.toLowerCase() === 'assessment') {
          return { ...q, subject: 'Chemistry' };
        }
        return q;
      });
    } catch {
      return [];
    }
  });

  const [savedTests, setSavedTests] = useState<CustomTestWithDetails[]>([]);
  const [loading, setLoading] = useState(() => quizzes.length === 0);
  const [, setSubmissionsVersion] = useState(0);

  // ─── Two-Level Architecture State ───────────────────────────────────────────
  // Level 1: activeSubjectView === null (Show Subject Cards Hub)
  // Level 2: activeSubjectView === 'all' | '<SubjectName>' (Show Clean Exam List)
  const [activeSubjectView, setActiveSubjectView] = useState<string | null>(null);

  // Level 2 Controls
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<FilterStatus>('all');
  const [sortBy, setSortBy] = useState<SortOption>('latest');
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');
  const [isGroupedBySubject, setIsGroupedBySubject] = useState<boolean>(false);

  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null);
  const [showDraftPin, setShowDraftPin] = useState<boolean>(false);
  const [deleteModalState, setDeleteModalState] = useState<{ isOpen: boolean; quizId: string; title: string }>({
    isOpen: false,
    quizId: '',
    title: '',
  });
  const [isDeleting, setIsDeleting] = useState(false);
  const [openMobileMenuId, setOpenMobileMenuId] = useState<string | null>(null);

  // Modal states
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [activeQuizDraft, setActiveQuizDraft] = useState<PublishedQuiz | null>(null);
  const [securityDefaults, setSecurityDefaults] = useState(() => getSavedSettings());
  const isQuizizzAllowed = Boolean(securityDefaults.enableQuizizzMode);
  const [selectedQuizForResults, setSelectedQuizForResults] = useState<PublishedQuiz | null>(null);
  const [selectedQuizForProctor, setSelectedQuizForProctor] = useState<PublishedQuiz | null>(null);
  const [originalQuizCode, setOriginalQuizCode] = useState<string | null>(null);
  const [offlineGradingData, setOfflineGradingData] = useState<{
    headerConfig: ExamHeaderConfig;
    questions: Question[];
  } | null>(null);
  const [isSelectOfflineTestOpen, setIsSelectOfflineTestOpen] = useState(false);

  const configModalDismiss = useBackdropDismiss(() => {
    setIsConfigModalOpen(false);
    setActiveQuizDraft(null);
    setOriginalQuizCode(null);
  });

  // ─── 1. Load Data on Mount ──────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    const sanitize = (list: PublishedQuiz[]) =>
      list.map((q) => {
        if (!q.subject || q.subject.toLowerCase() === 'assessment') {
          return { ...q, subject: 'Chemistry' };
        }
        return q;
      });

    try {
      setSecurityDefaults(getSavedSettings());
      const pubList = getPublishedQuizzes();
      if (pubList.length > 0) {
        setQuizzes(sanitize(pubList));
        setLoading(false);
      }

      const [testsRes, syncedRes] = await Promise.allSettled([
        fetchCustomTestsWithMetadata(),
        loadAndSyncPublishedQuizzes(),
      ]);

      if (testsRes.status === 'fulfilled') {
        setSavedTests(testsRes.value);
      }
      if (syncedRes.status === 'fulfilled') {
        setQuizzes(sanitize(syncedRes.value));
      }

      loadAndSyncAllSubmissions().then(() => {
        setSubmissionsVersion((v) => v + 1);
      });
    } catch (err) {
      console.error('Error loading quiz manager data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();

    const handleSubmissionsUpdated = () => setSubmissionsVersion((v) => v + 1);
    const handleSettingsUpdated = () => setSecurityDefaults(getSavedSettings());
    const handleTestsUpdated = () => loadData();
    const handleQuizzesUpdated = () => loadData();

    window.addEventListener('submissions_updated', handleSubmissionsUpdated);
    window.addEventListener('storage', handleSettingsUpdated);
    window.addEventListener('tests_updated', handleTestsUpdated);
    window.addEventListener('quizzes_updated', handleQuizzesUpdated);

    return () => {
      window.removeEventListener('submissions_updated', handleSubmissionsUpdated);
      window.removeEventListener('storage', handleSettingsUpdated);
      window.removeEventListener('tests_updated', handleTestsUpdated);
      window.removeEventListener('quizzes_updated', handleQuizzesUpdated);
    };
  }, [loadData]);

  // Keyboard navigation: Escape key returns to Subject Hub
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === 'Escape' &&
        activeSubjectView !== null &&
        !isConfigModalOpen &&
        !selectedQuizForResults &&
        !selectedQuizForProctor &&
        !deleteModalState.isOpen &&
        !offlineGradingData &&
        !isSelectOfflineTestOpen
      ) {
        setActiveSubjectView(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeSubjectView, isConfigModalOpen, selectedQuizForResults, selectedQuizForProctor, deleteModalState.isOpen, offlineGradingData, isSelectOfflineTestOpen]);

  // ─── 2. Data Aggregation for Level 1: Subject Hub ──────────────────────────
  const subjectSummaries = useMemo(() => {
    const map = new Map<
      string,
      {
        subjectName: string;
        quizCount: number;
        activeCount: number;
        pausedCount: number;
        totalSubmissions: number;
        latestDate: number;
      }
    >();

    quizzes.forEach((q) => {
      const sub = q.subject?.trim() || 'General';
      const existing = map.get(sub) || {
        subjectName: sub,
        quizCount: 0,
        activeCount: 0,
        pausedCount: 0,
        totalSubmissions: 0,
        latestDate: 0,
      };

      existing.quizCount += 1;
      if (q.isActive) existing.activeCount += 1;
      else existing.pausedCount += 1;

      const subs = getSubmissionsForQuiz(q.id, q.quizCode, q.testId).length;
      existing.totalSubmissions += subs;

      const d = new Date(q.updatedAt || q.createdAt).getTime();
      if (d > existing.latestDate) existing.latestDate = d;

      map.set(sub, existing);
    });

    return Array.from(map.values()).sort((a, b) => b.quizCount - a.quizCount);
  }, [quizzes]);

  // ─── 3. Filtered Quizzes for Level 2 Drill-Down ─────────────────────────────
  const subjectFilteredQuizzes = useMemo(() => {
    if (!activeSubjectView || activeSubjectView === 'all') return quizzes;
    return quizzes.filter(
      (q) => (q.subject || 'General').toLowerCase() === activeSubjectView.toLowerCase()
    );
  }, [quizzes, activeSubjectView]);

  const finalFilteredQuizzes = useMemo(() => {
    const list = subjectFilteredQuizzes.filter((quiz) => {
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        quiz.title.toLowerCase().includes(q) ||
        quiz.quizCode.toLowerCase().includes(q) ||
        (quiz.subject || '').toLowerCase().includes(q);

      if (!matchesSearch) return false;

      if (statusFilter === 'active') return quiz.isActive;
      if (statusFilter === 'paused') return !quiz.isActive;
      if (statusFilter === 'exam') return quiz.quizMode !== 'game';
      if (statusFilter === 'game') return quiz.quizMode === 'game';
      return true;
    });

    return list.sort((a, b) => {
      switch (sortBy) {
        case 'latest':
          return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime();
        case 'submissions': {
          const countA = getSubmissionsForQuiz(a.id, a.quizCode, a.testId).length;
          const countB = getSubmissionsForQuiz(b.id, b.quizCode, b.testId).length;
          return countB - countA;
        }
        case 'title':
          return a.title.localeCompare(b.title);
        default:
          return 0;
      }
    });
  }, [subjectFilteredQuizzes, searchQuery, statusFilter, sortBy]);

  const groupedSections = useMemo(() => {
    if (!isGroupedBySubject) {
      return { 'All Assessments': finalFilteredQuizzes };
    }
    const map: Record<string, PublishedQuiz[]> = {};
    finalFilteredQuizzes.forEach((quiz) => {
      const key = quiz.subject || 'General';
      if (!map[key]) map[key] = [];
      map[key].push(quiz);
    });
    return map;
  }, [finalFilteredQuizzes, isGroupedBySubject]);

  // ─── 4. Handlers ────────────────────────────────────────────────────────────
  const handleOpenCreateModal = (initialMode: 'exam' | 'game' = 'exam') => {
    if (savedTests.length === 0) {
      alert('You have no saved tests yet. Please build and save a test first before creating an interactive quiz.');
      onNavigateToBuilder?.();
      return;
    }

    const currentSettings = getSavedSettings();
    setSecurityDefaults(currentSettings);

    const effectiveMode = (initialMode === 'game' && currentSettings.enableQuizizzMode) ? 'game' : 'exam';
    const firstTest = savedTests[0];
    setSelectedTestId(firstTest.id);
    const draft = createDraftFromTest(firstTest);
    draft.quizMode = effectiveMode;
    draft.isExamMode = effectiveMode === 'exam';
    if (!currentSettings.defaultEnableWatermark) {
      draft.enableWatermark = false;
    }
    if (!currentSettings.defaultEnableMultiMonitor) {
      draft.enableMultiMonitorDetection = false;
    }
    setOriginalQuizCode(null);
    setActiveQuizDraft(draft);
    setIsConfigModalOpen(true);
  };

  const handleOpenOfflineGrader = () => {
    if (savedTests.length === 0) {
      alert('You have no saved tests yet. Please build and save a test first before grading offline students.');
      onNavigateToBuilder?.();
      return;
    }
    if (savedTests.length === 1) {
      handleLaunchOfflineGraderForTest(savedTests[0].id);
    } else {
      setIsSelectOfflineTestOpen(true);
    }
  };

  const handleLaunchOfflineGraderForTest = async (testId: string) => {
    setIsSelectOfflineTestOpen(false);
    try {
      const resolved = await fetchCustomTestWithQuestions(testId);
      const testMeta = savedTests.find((t) => t.id === testId);
      if (resolved && resolved.questions.length > 0) {
        setOfflineGradingData({
          headerConfig: {
            title: testMeta?.header_config?.title || testMeta?.title || 'Offline Exam Assessment',
            schoolName: testMeta?.header_config?.schoolName || '',
            subject: testMeta?.header_config?.subject || testMeta?.primarySubject || 'Chemistry',
            subjectCode: testMeta?.header_config?.subjectCode || '',
            durationMinutes: testMeta?.header_config?.durationMinutes || Math.round((testMeta?.total_marks || 20) * 1.25),
            instructions: testMeta?.header_config?.instructions || 'Answer all questions.',
            additionalMaterials: testMeta?.header_config?.additionalMaterials || '',
          },
          questions: resolved.questions,
        });
      } else {
        alert('This saved test has no questions to grade.');
      }
    } catch (err: any) {
      alert(`Failed to load test questions: ${err?.message || 'Unknown error'}`);
    }
  };

  const handleSelectSavedTest = (testId: string) => {
    setSelectedTestId(testId);
    const selected = savedTests.find((t) => t.id === testId);
    if (selected) {
      const currentSettings = getSavedSettings();
      setSecurityDefaults(currentSettings);
      const isEditing = Boolean(originalQuizCode);
      const draft = createDraftFromTest(
        selected,
        undefined,
        undefined,
        isEditing ? activeQuizDraft || undefined : undefined
      );
      if (activeQuizDraft?.quizMode) {
        draft.quizMode = activeQuizDraft.quizMode;
      }
      if (!currentSettings.defaultEnableWatermark) {
        draft.enableWatermark = false;
      }
      if (!currentSettings.defaultEnableMultiMonitor) {
        draft.enableMultiMonitorDetection = false;
      }
      setActiveQuizDraft(draft);
    }
  };

  const handleOpenEditModal = (quiz: PublishedQuiz) => {
    const currentSettings = getSavedSettings();
    setSecurityDefaults(currentSettings);
    setOriginalQuizCode(quiz.quizCode);
    setActiveQuizDraft({
      ...quiz,
      quizMode: quiz.quizMode || 'exam',
      enableWatermark: currentSettings.defaultEnableWatermark ? (quiz.enableWatermark ?? false) : false,
      enableMultiMonitorDetection: currentSettings.defaultEnableMultiMonitor ? (quiz.enableMultiMonitorDetection ?? false) : false,
    });
    setSelectedTestId(quiz.testId);
    setIsConfigModalOpen(true);
    setOpenMobileMenuId(null);
  };

  const handleSaveQuizConfig = async () => {
    if (!activeQuizDraft) return;
    const cleanCode = activeQuizDraft.quizCode.trim().toUpperCase();
    if (!cleanCode) {
      alert('Please provide a valid Quiz Code.');
      return;
    }

    const duplicate = quizzes.find(
      (q) => q.id !== activeQuizDraft.id && q.quizCode.trim().toUpperCase() === cleanCode
    );
    if (duplicate) {
      alert(
        `The Quiz Code "${cleanCode}" is already in use by quiz "${duplicate.title}". Please choose a different code so students can join the right quiz.`
      );
      return;
    }

    if (originalQuizCode && originalQuizCode.trim().toUpperCase() !== cleanCode) {
      const existingSubsCount = getSubmissionsForQuiz(activeQuizDraft.id, originalQuizCode, activeQuizDraft.testId).length;
      if (existingSubsCount > 0) {
        const proceed = window.confirm(
          `Notice: This quiz already has ${existingSubsCount} candidate submission(s) recorded under code "${originalQuizCode}". Changing the code will redirect future candidates to the new code. Proceed?`
        );
        if (!proceed) return;
      }
    }

    const cleanSubject = activeQuizDraft.subject?.trim() || 'Chemistry';
    const effectiveTeacherPin = activeQuizDraft.teacherPin || '1234';
    const currentSettings = getSavedSettings();

    const isExam = activeQuizDraft.isExamMode ?? true;
    const resolvedDuration = activeQuizDraft.durationMinutes || 45;
    const updatedHeader = activeQuizDraft.headerConfig
      ? { ...activeQuizDraft.headerConfig, durationMinutes: resolvedDuration, subject: cleanSubject, teacherPin: effectiveTeacherPin }
      : {
          title: activeQuizDraft.title || 'Examination',
          schoolName: '',
          subject: cleanSubject,
          subjectCode: '',
          durationMinutes: resolvedDuration,
          instructions: '',
          teacherPin: effectiveTeacherPin,
        };

    const updated: PublishedQuiz = {
      ...activeQuizDraft,
      quizCode: cleanCode,
      teacherPin: effectiveTeacherPin,
      subject: cleanSubject,
      durationMinutes: resolvedDuration,
      headerConfig: updatedHeader,
      quizMode: activeQuizDraft.quizMode || 'exam',
      enableWatermark: currentSettings.defaultEnableWatermark ? (activeQuizDraft.enableWatermark ?? false) : false,
      enableMultiMonitorDetection: currentSettings.defaultEnableMultiMonitor ? (activeQuizDraft.enableMultiMonitorDetection ?? false) : false,
      showInstantSolutions: isExam ? false : (activeQuizDraft.showInstantSolutions ?? false),
      updatedAt: new Date().toISOString(),
    };

    const saved = await savePublishedQuiz(updated, originalQuizCode || undefined);
    setQuizzes(saved);

    setIsConfigModalOpen(false);
    setActiveQuizDraft(null);
    setOriginalQuizCode(null);
    setSaveSuccessMsg(`✨ Quiz "${updated.title}" saved successfully with Code [${updated.quizCode}]!`);
    setTimeout(() => setSaveSuccessMsg(null), 4000);
  };

  const handleDeleteQuiz = (id: string, title: string) => {
    setDeleteModalState({ isOpen: true, quizId: id, title });
    setOpenMobileMenuId(null);
  };

  const handleConfirmDelete = async () => {
    const { quizId } = deleteModalState;
    if (!quizId) return;

    setIsDeleting(true);
    try {
      await deletePublishedQuiz(quizId);
    } finally {
      setIsDeleting(false);
      setDeleteModalState({ isOpen: false, quizId: '', title: '' });
    }
  };

  const handleToggleActive = async (id: string) => {
    await toggleQuizActiveStatus(id);
    setQuizzes(getPublishedQuizzes());
  };

  const handleCopyCode = (quizCode: string, id: string) => {
    navigator.clipboard.writeText(quizCode);
    setCopiedCodeId(id);
    setTimeout(() => setCopiedCodeId(null), 2000);
  };

  const handleCopyLink = (quizCode: string, id: string) => {
    const url = `${window.location.origin}${window.location.pathname}?quiz=${quizCode}`;
    navigator.clipboard.writeText(url);
    setCopiedLinkId(id);
    setTimeout(() => setCopiedLinkId(null), 2000);
    setOpenMobileMenuId(null);
  };

  const handleRunQuizSimulation = async (quiz: PublishedQuiz) => {
    const res = await fetchCustomTestWithQuestions(quiz.testId);
    if (!res || res.questions.length === 0) {
      alert('Failed to load questions for this test.');
      return;
    }

    const testMeta = savedTests.find((t) => t.id === quiz.testId);
    const resolvedHeader: ExamHeaderConfig = {
      title: testMeta?.header_config?.title || quiz.title,
      schoolName: testMeta?.header_config?.schoolName || '',
      subject: testMeta?.header_config?.subject || quiz.subject || 'Chemistry',
      subjectCode: testMeta?.header_config?.subjectCode || '',
      durationMinutes: quiz.durationMinutes || testMeta?.header_config?.durationMinutes || 45,
      instructions: testMeta?.header_config?.instructions || 'Simulated Assessment Run',
      additionalMaterials: testMeta?.header_config?.additionalMaterials || '',
      teacherPin: quiz.teacherPin || '1234',
    };

    onLaunchTestRun(res.questions, resolvedHeader);
  };

  const handleStartLiveGame = async (quiz: PublishedQuiz) => {
    if (!onLaunchGameHost) {
      alert('Multiplayer game mode is currently initializing.');
      return;
    }

    try {
      let finalQuestions: Question[] = [];
      if (quiz.testId) {
        const customRes = await fetchCustomTestWithQuestions(quiz.testId);
        if (customRes && customRes.questions.length > 0) {
          finalQuestions = customRes.questions;
        }
      }

      if (finalQuestions.length === 0 && quiz.questionIds && quiz.questionIds.length > 0) {
        finalQuestions = await fetchQuestionsByIds(quiz.questionIds);
      }

      if (finalQuestions.length === 0) {
        alert('This quiz has no questions associated with it. Please re-configure questions in Test Builder.');
        return;
      }

      onLaunchGameHost(quiz, finalQuestions);
    } catch (err: any) {
      alert(`Failed to prepare multiplayer host: ${err?.message || 'Unknown error'}`);
    }
  };

  const activeSubjectMeta = activeSubjectView && activeSubjectView !== 'all'
    ? getSubjectMetadata(activeSubjectView)
    : null;

  return (
    <div className="qm-page" onClick={() => setOpenMobileMenuId(null)}>
      <div className="qm-container">
        {/* Loading State */}
        {loading && (
          <div className="qm-skeleton-grid animate-fade-in">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <div key={n} className="qm-skeleton-card animate-pulse" />
            ))}
          </div>
        )}

        {/* Global Empty State */}
        {!loading && quizzes.length === 0 && (
          <div className="qm-empty-state animate-fade-in">
            <div className="qm-empty-visual">
              <SubjectIcon subject="general" size={48} />
            </div>
            <h2 className="qm-empty-heading">No Interactive Quizzes Published Yet</h2>
            <p className="qm-empty-text">
              Convert your saved exams into live interactive online tests with instant student codes, live invigilation, or multiplayer game sessions.
            </p>
            <div className="qm-empty-actions">
              {isQuizizzAllowed && (
                <button
                  type="button"
                  className="qm-btn qm-btn--game"
                  onClick={() => handleOpenCreateModal('game')}
                >
                  🎮 Create Quizizz Game
                </button>
              )}
              <button
                type="button"
                className="qm-btn qm-btn--primary"
                onClick={() => handleOpenCreateModal('exam')}
              >
                📝 Publish Formal Exam
              </button>
              {savedTests.length === 0 ? (
                <button
                  type="button"
                  className="qm-btn qm-btn--secondary"
                  onClick={onNavigateToBuilder}
                >
                  Open Test Builder
                </button>
              ) : (
                <button
                  type="button"
                  className="qm-btn qm-btn--secondary"
                  onClick={onNavigateToSaved}
                >
                  View Saved Tests
                </button>
              )}
            </div>
          </div>
        )}

        {/* Success Alert */}
        {saveSuccessMsg && (
          <div className="qm-success-banner animate-slide-up">
            <span>✓</span> {saveSuccessMsg}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════════
            LEVEL 1: SUBJECT HUB OVERVIEW (When activeSubjectView === null)
        ═══════════════════════════════════════════════════════════════════════ */}
        {!loading && quizzes.length > 0 && activeSubjectView === null && (
          <div className="qm-hub-view animate-fade-in">
            {/* Hub Header */}
            <header className="qm-hub-header">
              <div className="qm-hub-header-left">
                <h1 className="qm-hub-title">Interactive Quizzes &amp; Live Assessments</h1>
                <p className="qm-hub-subtitle">
                  Manage {quizzes.length} live assessment{quizzes.length !== 1 ? 's' : ''} organized across {subjectSummaries.length} academic departments. Monitor real-time student submissions and launch proctoring cockpits.
                </p>
              </div>

              <div className="qm-hub-header-actions">
                <button
                  type="button"
                  className="qm-btn qm-btn--secondary qm-btn--grade-offline"
                  onClick={handleOpenOfflineGrader}
                  title="Grade offline physical papers using rapid Excel or visual grid"
                >
                  📊 Grade Offline Exam
                </button>

                <button
                  type="button"
                  className="qm-btn qm-btn--secondary"
                  onClick={() => {
                    setActiveSubjectView('all');
                    setStatusFilter('all');
                    setSearchQuery('');
                  }}
                  title="View all quizzes in a unified clean directory"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7" height="7" />
                    <rect x="14" y="3" width="7" height="7" />
                    <rect x="14" y="14" width="7" height="7" />
                    <rect x="3" y="14" width="7" height="7" />
                  </svg>
                  <span>All Quizzes ({quizzes.length})</span>
                </button>

                {isQuizizzAllowed && (
                  <button
                    type="button"
                    className="qm-btn qm-btn--game"
                    onClick={() => handleOpenCreateModal('game')}
                  >
                    🎮 Quizizz Game
                  </button>
                )}

                <button
                  type="button"
                  className="qm-btn qm-btn--primary"
                  onClick={() => handleOpenCreateModal('exam')}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  <span>Publish Exam</span>
                </button>
              </div>
            </header>

            {/* Department Cards Grid */}
            <div className="qm-subject-grid">
              {subjectSummaries.map((summary) => {
                const meta = getSubjectMetadata(summary.subjectName);
                const latestDateFormatted = summary.latestDate
                  ? new Date(summary.latestDate).toLocaleDateString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      year: 'numeric',
                    })
                  : null;

                return (
                  <div
                    key={summary.subjectName}
                    className="qm-subject-card"
                    style={{ '--subject-accent': meta.color } as React.CSSProperties}
                    onClick={() => {
                      setActiveSubjectView(summary.subjectName);
                      setStatusFilter('all');
                      setSearchQuery('');
                    }}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setActiveSubjectView(summary.subjectName);
                      }
                    }}
                  >
                    {/* Top Row: Subject Logo Badge & Syllabus Code */}
                    <div className="qm-subject-card-top">
                      <div
                        className="qm-subject-logo-badge"
                        style={{
                          backgroundColor: meta.bgLight,
                          borderColor: meta.borderLight,
                        }}
                      >
                        <SubjectIcon subject={summary.subjectName} size={28} />
                      </div>

                      <span className="qm-subject-code-pill">
                        {meta.code}
                      </span>
                    </div>

                    {/* Subject Title & Description */}
                    <div className="qm-subject-card-body">
                      <h2 className="qm-subject-card-title">{summary.subjectName}</h2>
                      <p className="qm-subject-card-desc">{meta.description}</p>
                    </div>

                    {/* Metrics Row: Quizzes, Active Status, Submissions */}
                    <div className="qm-subject-metrics">
                      <div className="qm-subject-metric-item">
                        <span className="qm-subject-metric-val">{summary.quizCount}</span>
                        <span className="qm-subject-metric-lbl">Quizzes</span>
                      </div>
                      <div className="qm-subject-metric-sep" />
                      <div className="qm-subject-metric-item">
                        <span className="qm-subject-metric-val" style={{ color: '#059669' }}>
                          {summary.activeCount}
                        </span>
                        <span className="qm-subject-metric-lbl">Active</span>
                      </div>
                      <div className="qm-subject-metric-sep" />
                      <div className="qm-subject-metric-item">
                        <span className="qm-subject-metric-val">{summary.totalSubmissions}</span>
                        <span className="qm-subject-metric-lbl">Turned In</span>
                      </div>
                    </div>

                    {/* Footer: Last Updated & Explore CTA */}
                    <div className="qm-subject-card-footer">
                      <span className="qm-subject-last-updated">
                        {latestDateFormatted ? `Active ${latestDateFormatted}` : 'Active'}
                      </span>

                      <div className="qm-subject-explore-link">
                        <span>Explore Quizzes</span>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════════
            LEVEL 2: CLEAN EXAM DIRECTORY (When activeSubjectView !== null)
        ═══════════════════════════════════════════════════════════════════════ */}
        {!loading && quizzes.length > 0 && activeSubjectView !== null && (
          <div
            className="qm-drilldown-view animate-fade-in"
            style={{ '--subject-accent': activeSubjectMeta?.color || 'var(--color-primary-600)' } as React.CSSProperties}
          >
            {/* Breadcrumb Navigation Bar */}
            <div className="qm-breadcrumb-bar">
              <div className="qm-breadcrumb-left">
                <button
                  type="button"
                  className="qm-back-btn"
                  onClick={() => {
                    setActiveSubjectView(null);
                    setSearchQuery('');
                    setStatusFilter('all');
                  }}
                  title="Return to Subject Hub (Press Esc)"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                  <span>Departments</span>
                </button>

                <div className="qm-breadcrumb-divider">/</div>

                <div className="qm-breadcrumb-current">
                  {activeSubjectView === 'all' ? (
                    <div className="qm-breadcrumb-icon-wrap">
                      <SubjectIcon subject="general" size={18} />
                      <span className="qm-breadcrumb-title">All Departments</span>
                    </div>
                  ) : (
                    <div className="qm-breadcrumb-icon-wrap">
                      <SubjectIcon subject={activeSubjectView} size={18} />
                      <span className="qm-breadcrumb-title">{activeSubjectView}</span>
                    </div>
                  )}
                  <span className="qm-breadcrumb-count-badge">
                    {subjectFilteredQuizzes.length} assessment{subjectFilteredQuizzes.length !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>

              <div className="qm-breadcrumb-right">
                {isQuizizzAllowed && (
                  <button
                    type="button"
                    className="qm-btn qm-btn--game qm-btn--sm"
                    onClick={() => handleOpenCreateModal('game')}
                  >
                    🎮 Quizizz
                  </button>
                )}
                <button
                  type="button"
                  className="qm-btn qm-btn--primary qm-btn--sm"
                  onClick={() => handleOpenCreateModal('exam')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  <span>+ Publish Exam</span>
                </button>
              </div>
            </div>

            {/* Minimalist Filter Bar */}
            <div className="qm-filter-bar">
              <div className="qm-filter-bar-row">
                {/* Search Box */}
                <div className="qm-search-box">
                  <svg className="qm-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="text"
                    className="qm-search-input"
                    placeholder={`Search ${activeSubjectView === 'all' ? 'all' : activeSubjectView} quizzes or codes...`}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      className="qm-search-clear"
                      onClick={() => setSearchQuery('')}
                      title="Clear search"
                    >
                      ✕
                    </button>
                  )}
                </div>

                {/* View Mode & Sorter */}
                <div className="qm-filter-controls">
                  <div className="qm-view-toggle">
                    <button
                      type="button"
                      className={`qm-view-toggle-btn ${viewMode === 'cards' ? 'qm-view-toggle-btn--active' : ''}`}
                      onClick={() => setViewMode('cards')}
                      title="Cards Grid View"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="7" height="7" rx="1" />
                        <rect x="14" y="3" width="7" height="7" rx="1" />
                        <rect x="14" y="14" width="7" height="7" rx="1" />
                        <rect x="3" y="14" width="7" height="7" rx="1" />
                      </svg>
                      <span>Cards</span>
                    </button>
                    <button
                      type="button"
                      className={`qm-view-toggle-btn ${viewMode === 'table' ? 'qm-view-toggle-btn--active' : ''}`}
                      onClick={() => setViewMode('table')}
                      title="Table List View"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <line x1="3" y1="9" x2="21" y2="9" />
                        <line x1="3" y1="15" x2="21" y2="15" />
                      </svg>
                      <span>List</span>
                    </button>
                  </div>

                  {activeSubjectView === 'all' && (
                    <button
                      type="button"
                      className={`qm-view-toggle-btn ${isGroupedBySubject ? 'qm-view-toggle-btn--active' : ''}`}
                      onClick={() => setIsGroupedBySubject((v) => !v)}
                      style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-md)', padding: '5px 10px' }}
                      title="Group assessments by department"
                    >
                      {isGroupedBySubject ? 'Grouped' : 'Flat'}
                    </button>
                  )}

                  <div className="qm-sort-wrap">
                    <span className="qm-sort-label">Sort:</span>
                    <select
                      className="qm-sort-select"
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value as SortOption)}
                    >
                      <option value="latest">Latest Active</option>
                      <option value="submissions">Most Submissions</option>
                      <option value="title">Title (A-Z)</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Status Filter Chips */}
              <div className="qm-status-pills-row">
                <span className="qm-status-pills-label">Status:</span>
                <div className="qm-status-pills-list">
                  <button
                    type="button"
                    className={`qm-status-pill ${statusFilter === 'all' ? 'qm-status-pill--active' : ''}`}
                    onClick={() => setStatusFilter('all')}
                  >
                    All ({subjectFilteredQuizzes.length})
                  </button>
                  <button
                    type="button"
                    className={`qm-status-pill ${statusFilter === 'active' ? 'qm-status-pill--active' : ''}`}
                    onClick={() => setStatusFilter('active')}
                  >
                    Active ({subjectFilteredQuizzes.filter((q) => q.isActive).length})
                  </button>
                  <button
                    type="button"
                    className={`qm-status-pill ${statusFilter === 'paused' ? 'qm-status-pill--active' : ''}`}
                    onClick={() => setStatusFilter('paused')}
                  >
                    Paused ({subjectFilteredQuizzes.filter((q) => !q.isActive).length})
                  </button>
                  <button
                    type="button"
                    className={`qm-status-pill ${statusFilter === 'exam' ? 'qm-status-pill--active' : ''}`}
                    onClick={() => setStatusFilter('exam')}
                  >
                    Formal Exams ({subjectFilteredQuizzes.filter((q) => q.quizMode !== 'game').length})
                  </button>
                  {isQuizizzAllowed && (
                    <button
                      type="button"
                      className={`qm-status-pill ${statusFilter === 'game' ? 'qm-status-pill--active' : ''}`}
                      onClick={() => setStatusFilter('game')}
                    >
                      Quizizz Games ({subjectFilteredQuizzes.filter((q) => q.quizMode === 'game').length})
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* No Search Matches State */}
            {finalFilteredQuizzes.length === 0 && (
              <div className="qm-empty-state qm-empty-state--compact animate-fade-in">
                <div className="qm-empty-visual">
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </div>
                <h3 className="qm-empty-heading">No matching quizzes found</h3>
                <p className="qm-empty-text">
                  No published assessments match your active search or status filters. Try clearing your search query.
                </p>
                <button
                  type="button"
                  className="qm-btn qm-btn--secondary"
                  onClick={() => {
                    setSearchQuery('');
                    setStatusFilter('all');
                  }}
                >
                  Reset Filters
                </button>
              </div>
            )}

            {/* ─── Clean Exam Rows (Linear/Notion-Style Minimalist List) ────── */}
            {finalFilteredQuizzes.length > 0 && (
              <div className="qm-list-sections">
                {Object.keys(groupedSections).map((sectionName) => {
                  const sectionQuizzes = groupedSections[sectionName] || [];
                  if (sectionQuizzes.length === 0) return null;

                  return (
                    <section key={sectionName} className="qm-topic-section animate-fade-in">
                      {isGroupedBySubject && (
                        <div className="qm-section-header">
                          <div className="qm-section-header-left">
                            <h2 className="qm-section-title">{sectionName}</h2>
                            <span className="qm-section-badge">{sectionQuizzes.length}</span>
                          </div>
                        </div>
                      )}

                      {viewMode === 'cards' ? (
                        <div className="qm-cards-grid">
                          {sectionQuizzes.map((quiz) => {
                            const isGame = isQuizizzAllowed && quiz.quizMode === 'game';
                            const subName = quiz.subject?.trim() || 'General';
                            const subMeta = getSubjectMetadata(subName);
                            const submissionCount = getSubmissionsForQuiz(quiz.id, quiz.quizCode, quiz.testId).length;

                            return (
                              <div
                                key={quiz.id}
                                className="qm-card"
                                style={{ '--subject-accent': subMeta.color } as React.CSSProperties}
                                onClick={() => {
                                  if (isGame) {
                                    handleStartLiveGame(quiz);
                                  } else {
                                    setSelectedQuizForProctor(quiz);
                                  }
                                }}
                              >
                                {/* Top Bar: Subject Badge + Active/Paused Toggle */}
                                <div className="qm-card-top">
                                  <div
                                    className="qm-card-sub-badge"
                                    style={{
                                      backgroundColor: subMeta.bgLight,
                                      borderColor: subMeta.borderLight,
                                    }}
                                  >
                                    <SubjectIcon subject={subName} size={15} />
                                    <span className="qm-card-sub-name" style={{ color: subMeta.color }}>
                                      {subName}
                                    </span>
                                    <span className="qm-card-sub-format">
                                      • {isGame ? 'Quizizz' : 'Exam'}
                                    </span>
                                  </div>

                                  <button
                                    type="button"
                                    className={`qm-row-status-btn ${quiz.isActive ? 'qm-row-status--active' : 'qm-row-status--paused'}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleToggleActive(quiz.id);
                                    }}
                                    title="Toggle active status"
                                  >
                                    <span className="qm-row-status-dot" />
                                    <span>{quiz.isActive ? 'Active' : 'Paused'}</span>
                                  </button>
                                </div>

                                {/* Title & Metadata Specs */}
                                <div className="qm-card-body">
                                  <h3 className="qm-card-title" title={quiz.title}>
                                    {quiz.title}
                                  </h3>

                                  <div className="qm-card-meta-chips">
                                    <span className="qm-card-chip">
                                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <circle cx="12" cy="12" r="10" />
                                        <polyline points="12 6 12 12 16 14" />
                                      </svg>
                                      <span>{isGame ? `${quiz.questionTimerSeconds || 20}s / Q` : `${quiz.durationMinutes || 45} mins`}</span>
                                    </span>

                                    <span className="qm-card-chip">
                                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                        <polyline points="14 2 14 8 20 8" />
                                      </svg>
                                      <span>{quiz.questionCount || 0} Qs</span>
                                    </span>

                                    {quiz.securityEnabled && (
                                      <span className="qm-card-chip qm-card-chip--security" title="Candidate Tab Lockdown Active">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                                        </svg>
                                        <span>Lockdown</span>
                                      </span>
                                    )}
                                  </div>
                                </div>

                                {/* Student Access Code Box */}
                                <div
                                  className="qm-card-code-box"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCopyCode(quiz.quizCode, quiz.id);
                                  }}
                                  title="Click to copy student access code"
                                >
                                  <div className="qm-card-code-info">
                                    <span className="qm-card-code-lbl">Access Code</span>
                                    <span className="qm-card-code-val">{quiz.quizCode}</span>
                                  </div>

                                  <div className="qm-card-code-btn">
                                    {copiedCodeId === quiz.id ? (
                                      <span className="qm-card-code-copied">✓ Copied</span>
                                    ) : (
                                      <span className="qm-card-code-copy">
                                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                        </svg>
                                        Copy
                                      </span>
                                    )}
                                  </div>
                                </div>

                                {/* Submissions Metric Strip */}
                                <div className="qm-card-metrics-strip">
                                  <div
                                    className="qm-card-sub-count"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedQuizForResults(quiz);
                                    }}
                                    title="View candidate scorebook"
                                  >
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                      <line x1="18" y1="20" x2="18" y2="10" />
                                      <line x1="12" y1="20" x2="12" y2="4" />
                                      <line x1="6" y1="20" x2="6" y2="14" />
                                    </svg>
                                    <span>
                                      <strong>{submissionCount}</strong> turned in
                                    </span>
                                    <span className="qm-card-metric-arrow">→</span>
                                  </div>

                                  {quiz.teacherPin && (
                                    <span className="qm-card-pin-pill" title="Teacher Invigilator Unlock PIN">
                                      PIN: {quiz.teacherPin}
                                    </span>
                                  )}
                                </div>

                                {/* Card Actions Footer */}
                                <div className="qm-card-actions">
                                  <div className="qm-card-main-actions">
                                    {isGame ? (
                                      <button
                                        type="button"
                                        className="qm-btn qm-btn--game qm-btn--card-main"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleStartLiveGame(quiz);
                                        }}
                                      >
                                        🎮 Start Host
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        className="qm-btn qm-btn--primary qm-btn--card-main"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          setSelectedQuizForProctor(quiz);
                                        }}
                                      >
                                        🛡️ Live Proctor
                                      </button>
                                    )}

                                    <button
                                      type="button"
                                      className="qm-btn qm-btn--secondary qm-btn--card-sub"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setSelectedQuizForResults(quiz);
                                      }}
                                      title="View Results"
                                    >
                                      Results
                                    </button>
                                  </div>

                                  {/* Micro Action Buttons */}
                                  <div className="qm-card-micro-actions">
                                    <button
                                      type="button"
                                      className="qm-card-icon-action"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleRunQuizSimulation(quiz);
                                      }}
                                      title="Test Run as student"
                                    >
                                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                        <polygon points="5 3 19 12 5 21 5 3" />
                                      </svg>
                                    </button>

                                    <button
                                      type="button"
                                      className="qm-card-icon-action"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleCopyLink(quiz.quizCode, quiz.id);
                                      }}
                                      title={copiedLinkId === quiz.id ? 'Copied link!' : 'Copy Direct Link'}
                                    >
                                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                      </svg>
                                    </button>

                                    <button
                                      type="button"
                                      className="qm-card-icon-action"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleOpenEditModal(quiz);
                                      }}
                                      title="Quiz Settings & Anti-cheat"
                                    >
                                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                        <circle cx="12" cy="12" r="3" />
                                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                                      </svg>
                                    </button>

                                    <button
                                      type="button"
                                      className="qm-card-icon-action qm-card-icon-action--danger"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleDeleteQuiz(quiz.id, quiz.title);
                                      }}
                                      title="Unpublish & Delete"
                                    >
                                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                        <polyline points="3 6 5 6 21 6" />
                                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                      </svg>
                                    </button>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <div className="qm-rows-container">
                        {sectionQuizzes.map((quiz) => {
                          const isGame = isQuizizzAllowed && quiz.quizMode === 'game';
                          const subName = quiz.subject?.trim() || 'General';
                          const subMeta = getSubjectMetadata(subName);
                          const submissionCount = getSubmissionsForQuiz(quiz.id, quiz.quizCode, quiz.testId).length;

                          return (
                            <div
                              key={quiz.id}
                              className="qm-exam-row"
                              onClick={(e) => {
                                if (
                                  (e.target as HTMLElement).closest('.qm-row-actions') ||
                                  (e.target as HTMLElement).closest('.qm-mobile-action-btn') ||
                                  (e.target as HTMLElement).closest('.qm-row-code-pill') ||
                                  (e.target as HTMLElement).closest('.qm-row-status-btn')
                                ) {
                                  return;
                                }
                                // Default row click: open proctor for exams, or host for games
                                if (isGame) {
                                  handleStartLiveGame(quiz);
                                } else {
                                  setSelectedQuizForProctor(quiz);
                                }
                              }}
                            >
                              {/* Left Column: Subject Logo, Title & Metadata */}
                              <div className="qm-exam-main">
                                <div
                                  className="qm-exam-icon-slot"
                                  style={{
                                    backgroundColor: subMeta.bgLight,
                                    borderColor: subMeta.borderLight,
                                  }}
                                  title={subName}
                                >
                                  <SubjectIcon subject={subName} size={18} />
                                </div>

                                <div className="qm-exam-details">
                                  <div className="qm-exam-title-row">
                                    <h3 className="qm-exam-title" title={quiz.title}>
                                      {quiz.title}
                                    </h3>
                                  </div>

                                  <div className="qm-exam-meta-row">
                                    <span className="qm-exam-subject-tag" style={{ color: subMeta.color }}>
                                      {subName}
                                    </span>
                                    <span className="qm-meta-dot">•</span>
                                    <span className="qm-exam-format-text">
                                      {isGame ? 'Quizizz Game' : 'Formal Exam'}
                                    </span>
                                    <span className="qm-meta-dot">•</span>
                                    <span>
                                      {isGame
                                        ? `${quiz.questionTimerSeconds || 20}s / Q`
                                        : `${quiz.durationMinutes || 45} mins`}
                                    </span>
                                    <span className="qm-meta-dot">•</span>
                                    <span>{quiz.questionCount || 0} Questions</span>
                                  </div>
                                </div>
                              </div>

                              {/* Middle Column: Access Code & Status Pills */}
                              <div className="qm-exam-stats">
                                {/* Access Code Pill (1-click copy) */}
                                <button
                                  type="button"
                                  className="qm-row-code-pill"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCopyCode(quiz.quizCode, quiz.id);
                                  }}
                                  title="Click to copy student access code"
                                >
                                  <span className="qm-row-code-lbl">Code:</span>
                                  <span className="qm-row-code-val">{quiz.quizCode}</span>
                                  <span className="qm-row-code-copy-status">
                                    {copiedCodeId === quiz.id ? '✓ Copied' : '📋'}
                                  </span>
                                </button>

                                {/* Submissions Tally */}
                                <div
                                  className="qm-stat-badge"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedQuizForResults(quiz);
                                  }}
                                  style={{ cursor: 'pointer' }}
                                  title="Click to view candidate results & scorebook"
                                >
                                  <span className="qm-stat-value">{submissionCount}</span>
                                  <span className="qm-stat-unit">Turned In</span>
                                </div>

                                {/* Active / Paused Status Toggle */}
                                <button
                                  type="button"
                                  className={`qm-row-status-btn ${quiz.isActive ? 'qm-row-status--active' : 'qm-row-status--paused'}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleToggleActive(quiz.id);
                                  }}
                                  title="Toggle active status"
                                >
                                  <span className="qm-row-status-dot" />
                                  <span>{quiz.isActive ? 'Active' : 'Paused'}</span>
                                </button>
                              </div>

                              {/* Right Edge: Hover Quick Actions Bar */}
                              <div className="qm-row-actions">
                                {/* 1. Primary: Live Proctor (Exam) or Live Host (Game) */}
                                {isGame ? (
                                  <button
                                    type="button"
                                    className="qm-action-btn qm-action-btn--game"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleStartLiveGame(quiz);
                                    }}
                                    title="Start Live Multiplayer Game Host"
                                    aria-label="Start Game Host"
                                  >
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                      <rect x="2" y="6" width="20" height="12" rx="2" />
                                      <path d="M6 12h4m-2-2v4" />
                                      <line x1="15" y1="11" x2="15.01" y2="11" />
                                      <line x1="18" y1="13" x2="18.01" y2="13" />
                                    </svg>
                                    <span className="qm-action-tooltip">Host Game</span>
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className="qm-action-btn qm-action-btn--primary"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSelectedQuizForProctor(quiz);
                                    }}
                                    title={`Open Live Proctoring Cockpit (${quiz.quizCode})`}
                                    aria-label="Live Proctor"
                                  >
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                                    </svg>
                                    <span className="qm-action-tooltip">Proctor</span>
                                  </button>
                                )}

                                {/* 2. View Results */}
                                <button
                                  type="button"
                                  className="qm-action-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSelectedQuizForResults(quiz);
                                  }}
                                  title={`View results & scores (${submissionCount})`}
                                  aria-label="View Results"
                                >
                                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="18" y1="20" x2="18" y2="10" />
                                    <line x1="12" y1="20" x2="12" y2="4" />
                                    <line x1="6" y1="20" x2="6" y2="14" />
                                  </svg>
                                  <span className="qm-action-tooltip">Results</span>
                                </button>

                                {/* 3. Test Run Simulation */}
                                <button
                                  type="button"
                                  className="qm-action-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRunQuizSimulation(quiz);
                                  }}
                                  title="Test-run this quiz in the browser as student"
                                  aria-label="Test Run"
                                >
                                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <polygon points="5 3 19 12 5 21 5 3" />
                                  </svg>
                                  <span className="qm-action-tooltip">Test Run</span>
                                </button>

                                {/* 4. Copy Direct Link */}
                                <button
                                  type="button"
                                  className="qm-action-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleCopyLink(quiz.quizCode, quiz.id);
                                  }}
                                  title="Copy Direct Join Link"
                                  aria-label="Copy Link"
                                >
                                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                                  </svg>
                                  <span className="qm-action-tooltip">{copiedLinkId === quiz.id ? 'Copied!' : 'Link'}</span>
                                </button>

                                {/* 5. Settings / Edit */}
                                <button
                                  type="button"
                                  className="qm-action-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleOpenEditModal(quiz);
                                  }}
                                  title="Configure settings, code, timer, or PIN"
                                  aria-label="Configure Settings"
                                >
                                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="12" cy="12" r="3" />
                                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                                  </svg>
                                  <span className="qm-action-tooltip">Settings</span>
                                </button>

                                <div className="qm-action-sep" />

                                {/* 6. Delete */}
                                <button
                                  type="button"
                                  className="qm-action-btn qm-action-btn--danger"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleDeleteQuiz(quiz.id, quiz.title || 'Untitled Assessment');
                                  }}
                                  title="Unpublish and delete quiz"
                                  aria-label="Delete Quiz"
                                >
                                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="3 6 5 6 21 6" />
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                  </svg>
                                  <span className="qm-action-tooltip">Delete</span>
                                </button>
                              </div>

                              {/* Mobile Actions Menu Button */}
                              <div className="qm-mobile-actions">
                                <button
                                  type="button"
                                  className="qm-mobile-action-btn"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setOpenMobileMenuId(openMobileMenuId === quiz.id ? null : quiz.id);
                                  }}
                                  aria-label="Actions menu"
                                >
                                  •••
                                </button>

                                {openMobileMenuId === quiz.id && (
                                  <div className="qm-mobile-menu animate-fade-in" onClick={(e) => e.stopPropagation()}>
                                    {isGame ? (
                                      <button
                                        type="button"
                                        className="qm-mobile-menu-item"
                                        onClick={() => handleStartLiveGame(quiz)}
                                      >
                                        🎮 Start Game Host
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        className="qm-mobile-menu-item"
                                        onClick={() => setSelectedQuizForProctor(quiz)}
                                      >
                                        🛡️ Live Proctor
                                      </button>
                                    )}
                                    <button
                                      type="button"
                                      className="qm-mobile-menu-item"
                                      onClick={() => setSelectedQuizForResults(quiz)}
                                    >
                                      📊 View Results ({submissionCount})
                                    </button>
                                    <button
                                      type="button"
                                      className="qm-mobile-menu-item"
                                      onClick={() => handleRunQuizSimulation(quiz)}
                                    >
                                      ▶️ Test Run
                                    </button>
                                    <button
                                      type="button"
                                      className="qm-mobile-menu-item"
                                      onClick={() => handleCopyLink(quiz.quizCode, quiz.id)}
                                    >
                                      🔗 Copy Direct Link
                                    </button>
                                    <button
                                      type="button"
                                      className="qm-mobile-menu-item"
                                      onClick={() => handleOpenEditModal(quiz)}
                                    >
                                      ⚙️ Quiz Settings
                                    </button>
                                    <div className="qm-mobile-menu-divider" />
                                    <button
                                      type="button"
                                      className="qm-mobile-menu-item qm-mobile-menu-item--danger"
                                      onClick={() => handleDeleteQuiz(quiz.id, quiz.title)}
                                    >
                                      🗑️ Delete Quiz
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    </section>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─── Results & Proctoring Audit Modal ─────────────────────────────────── */}
      {selectedQuizForResults && (
        <QuizResultsModal
          quiz={selectedQuizForResults}
          onClose={() => setSelectedQuizForResults(null)}
        />
      )}

      {/* ─── Create & Configure Quiz Modal ────────────────────────────────────── */}
      {isConfigModalOpen && activeQuizDraft && createPortal(
        <div className="qm-modal-backdrop animate-fade-in" {...configModalDismiss}>
          <div className="qm-modal-card animate-scale-up" onClick={(e) => e.stopPropagation()}>
            <div className="qm-modal-header">
              <div>
                <h2 className="qm-modal-title">
                  {originalQuizCode ? `Edit Quiz: ${activeQuizDraft.title}` : 'Configure Interactive Quiz Settings'}
                </h2>
                <p className="qm-modal-sub">
                  {originalQuizCode
                    ? 'Update access token, PIN, time limit, and anti-cheating rules'
                    : 'Set up student access code, subject, timer rules, and anti-cheating controls'}
                </p>
              </div>
              <button
                type="button"
                className="qm-modal-close"
                onClick={() => {
                  setIsConfigModalOpen(false);
                  setActiveQuizDraft(null);
                  setOriginalQuizCode(null);
                }}
              >
                ✕
              </button>
            </div>

            <div className="qm-modal-body">
              {/* Step 1: Select Saved Test */}
              <div className="qm-form-group">
                <label className="qm-form-label">Select Source Test from Saved Exams:</label>
                <select
                  className="qm-form-select"
                  value={selectedTestId || ''}
                  onChange={(e) => handleSelectSavedTest(e.target.value)}
                  disabled={Boolean(originalQuizCode)}
                >
                  {savedTests.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title} ({t.primarySubject || t.header_config?.subject || 'Chemistry'} • {t.question_ids?.length || 0} questions • {t.total_marks} marks)
                    </option>
                  ))}
                </select>
                {originalQuizCode && (
                  <span className="qm-form-hint" style={{ fontSize: '0.78rem' }}>
                    Source test questions are locked to this quiz. To publish a different test, create a new interactive quiz.
                  </span>
                )}
              </div>

              {/* Step 2: Subject & Title */}
              <div className="qm-form-row">
                <div className="qm-form-group" style={{ flex: 1 }}>
                  <label className="qm-form-label">Subject:</label>
                  <input
                    type="text"
                    className="qm-form-input"
                    value={activeQuizDraft.subject}
                    onChange={(e) =>
                      setActiveQuizDraft({
                        ...activeQuizDraft,
                        subject: e.target.value,
                      })
                    }
                    placeholder="e.g. Chemistry, Physics, Biology"
                  />
                </div>

                <div className="qm-form-group" style={{ flex: 2 }}>
                  <label className="qm-form-label">Quiz Title:</label>
                  <input
                    type="text"
                    className="qm-form-input"
                    value={activeQuizDraft.title}
                    onChange={(e) =>
                      setActiveQuizDraft({
                        ...activeQuizDraft,
                        title: e.target.value,
                      })
                    }
                    placeholder="e.g. End of Term Chemistry Assessment"
                  />
                </div>
              </div>

              {/* Step 3: Custom Quiz Code */}
              <div className="qm-form-group">
                <label className="qm-form-label">Custom Quiz Code / Token:</label>
                <div className="qm-code-input-wrap">
                  <span className="qm-code-prefix-icon">🔑</span>
                  <input
                    type="text"
                    className="qm-form-input qm-form-input--code"
                    value={activeQuizDraft.quizCode}
                    onChange={(e) =>
                      setActiveQuizDraft({
                        ...activeQuizDraft,
                        quizCode: e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ''),
                      })
                    }
                    placeholder="e.g. CHEM-101 or MIDTERM26"
                    maxLength={16}
                  />
                </div>
                {activeQuizDraft.quizCode.trim().length > 0 &&
                  quizzes.some(
                    (q) =>
                      q.id !== activeQuizDraft.id &&
                      q.quizCode.trim().toUpperCase() === activeQuizDraft.quizCode.trim().toUpperCase()
                  ) ? (
                  <span style={{ color: '#ef4444', fontSize: '0.82rem', fontWeight: 600, display: 'block', marginTop: '6px' }}>
                    ⚠️ This Quiz Code is already in use by another quiz. Please choose a unique code.
                  </span>
                ) : (
                  <span className="qm-form-hint">
                    Students will use this exact code to join on the landing page.
                  </span>
                )}
              </div>

              {/* Step 4: Assessment Format (Formal Exam vs Quizizz Game) */}
              {isQuizizzAllowed && (
                <div className="qm-form-group">
                  <label className="qm-form-label">Quiz Assessment Format:</label>
                  <div className="qm-mode-selector-grid">
                    <div
                      className={`qm-mode-card ${activeQuizDraft.quizMode !== 'game' ? 'qm-mode-card--selected' : ''}`}
                      onClick={() =>
                        setActiveQuizDraft({
                          ...activeQuizDraft,
                          quizMode: 'exam',
                        })
                      }
                    >
                      <span className="qm-mode-icon">📝</span>
                      <div className="qm-mode-info">
                        <strong>Formal Exam Mode</strong>
                        <p>Timed assessment with fullscreen lockdown, tab-switch tracking, and proctoring audit log.</p>
                      </div>
                    </div>

                    <div
                      className={`qm-mode-card ${activeQuizDraft.quizMode === 'game' ? 'qm-mode-card--selected qm-mode-card--game-sel' : ''}`}
                      onClick={() =>
                        setActiveQuizDraft({
                          ...activeQuizDraft,
                          quizMode: 'game',
                        })
                      }
                    >
                      <span className="qm-mode-icon">🎮</span>
                      <div className="qm-mode-info">
                        <strong>Quizizz Game Mode (MCQ)</strong>
                        <p>Fast-paced game-show with power-ups (50/50, time freeze), answer streaks, fun sounds, and live leaderboard.</p>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Conditional Settings based on quizMode */}
              {isQuizizzAllowed && activeQuizDraft.quizMode === 'game' ? (
                /* ─── Game Mode Settings ────────────────────────────────────────── */
                <div className="qm-game-settings-panel animate-fade-in">
                  <div className="qm-form-row">
                    <div className="qm-form-group" style={{ flex: 1 }}>
                      <label className="qm-form-label">Seconds Per Question:</label>
                      <select
                        className="qm-form-select"
                        value={activeQuizDraft.questionTimerSeconds || 20}
                        onChange={(e) =>
                          setActiveQuizDraft({
                            ...activeQuizDraft,
                            questionTimerSeconds: parseInt(e.target.value, 10),
                          })
                        }
                      >
                        <option value={10}>⚡ 10 Seconds (Speedrun)</option>
                        <option value={15}>⏱️ 15 Seconds (Fast)</option>
                        <option value={20}>⏱️ 20 Seconds (Standard)</option>
                        <option value={30}>⏱️ 30 Seconds (Relaxed)</option>
                        <option value={45}>⏱️ 45 Seconds (Deep Thinking)</option>
                        <option value={60}>⏱️ 60 Seconds (Calculations)</option>
                      </select>
                    </div>

                    <div className="qm-form-group" style={{ flex: 1 }}>
                      <label className="qm-form-label">Base Points / Question:</label>
                      <input
                        type="number"
                        className="qm-form-input"
                        value={activeQuizDraft.pointsPerQuestion || 1000}
                        onChange={(e) =>
                          setActiveQuizDraft({
                            ...activeQuizDraft,
                            pointsPerQuestion: parseInt(e.target.value, 10) || 1000,
                          })
                        }
                        step={100}
                        min={100}
                        max={5000}
                      />
                    </div>
                  </div>

                  {/* Game Toggles Grid */}
                  <div className="qm-game-toggles-grid">
                    <label className="qm-checkbox-label">
                      <input
                        type="checkbox"
                        checked={activeQuizDraft.enablePowerUps ?? true}
                        onChange={(e) =>
                          setActiveQuizDraft({
                            ...activeQuizDraft,
                            enablePowerUps: e.target.checked,
                          })
                        }
                      />
                      <span>✂️ Power-Ups (50/50, Time Freeze, 2× Points)</span>
                    </label>

                    <label className="qm-checkbox-label">
                      <input
                        type="checkbox"
                        checked={activeQuizDraft.enableStreaks ?? true}
                        onChange={(e) =>
                          setActiveQuizDraft({
                            ...activeQuizDraft,
                            enableStreaks: e.target.checked,
                          })
                        }
                      />
                      <span>🔥 Streak Multipliers (Up to 3× Score)</span>
                    </label>

                    <label className="qm-checkbox-label">
                      <input
                        type="checkbox"
                        checked={activeQuizDraft.enableFunSounds ?? true}
                        onChange={(e) =>
                          setActiveQuizDraft({
                            ...activeQuizDraft,
                            enableFunSounds: e.target.checked,
                          })
                        }
                      />
                      <span>🔊 Fun Synthesized Sound FX &amp; Airhorns</span>
                    </label>

                    <label className="qm-checkbox-label">
                      <input
                        type="checkbox"
                        checked={activeQuizDraft.enableMemes ?? true}
                        onChange={(e) =>
                          setActiveQuizDraft({
                            ...activeQuizDraft,
                            enableMemes: e.target.checked,
                          })
                        }
                      />
                      <span>🎉 Meme Reactions &amp; Emoji Feedback</span>
                    </label>

                    <label className="qm-checkbox-label">
                      <input
                        type="checkbox"
                        checked={activeQuizDraft.shuffleQuestions ?? true}
                        onChange={(e) =>
                          setActiveQuizDraft({
                            ...activeQuizDraft,
                            shuffleQuestions: e.target.checked,
                          })
                        }
                      />
                      <span>🔀 Randomize Question Order</span>
                    </label>

                    <label className="qm-checkbox-label">
                      <input
                        type="checkbox"
                        checked={activeQuizDraft.shuffleOptions ?? true}
                        onChange={(e) =>
                          setActiveQuizDraft({
                            ...activeQuizDraft,
                            shuffleOptions: e.target.checked,
                          })
                        }
                      />
                      <span>🔀 Randomize MCQ Choices</span>
                    </label>
                  </div>
                </div>
              ) : (
                /* ─── Formal Exam Mode Settings ─────────────────────────────────── */
                <>
                  <div className="qm-form-row">
                    <div className="qm-form-group" style={{ flex: 1 }}>
                      <label className="qm-form-label">Duration (Minutes):</label>
                      <input
                        type="number"
                        className="qm-form-input"
                        value={activeQuizDraft.durationMinutes}
                        onChange={(e) =>
                          setActiveQuizDraft({
                            ...activeQuizDraft,
                            durationMinutes: parseInt(e.target.value, 10) || 0,
                          })
                        }
                        min={5}
                        max={300}
                      />
                    </div>

                    <div className="qm-form-group" style={{ flex: 1 }}>
                      <label className="qm-form-label">Exam Mode Type:</label>
                      <select
                        className="qm-form-select"
                        value={activeQuizDraft.isExamMode ? 'exam' : 'practice'}
                        onChange={(e) =>
                          setActiveQuizDraft({
                            ...activeQuizDraft,
                            isExamMode: e.target.value === 'exam',
                          })
                        }
                      >
                        <option value="exam">🔒 Timed Exam (Strict Lockdown)</option>
                        <option value="practice">📖 Practice Mode (Flexible)</option>
                      </select>
                    </div>
                  </div>

                  {/* Anti-Cheating & Proctoring Rules Panel */}
                  <div className="qm-security-panel">
                    <div className="qm-sec-header">
                      <div>
                        <strong>Institutional Security &amp; Anti-Cheating Suite</strong>
                        <p>Lockdown student tabs, monitor multi-screens, and prevent exam leakages.</p>
                      </div>
                      <label className="qm-switch" title="Toggle anti-cheat guard">
                        <input
                          type="checkbox"
                          checked={activeQuizDraft.securityEnabled}
                          onChange={(e) =>
                            setActiveQuizDraft({
                              ...activeQuizDraft,
                              securityEnabled: e.target.checked,
                            })
                          }
                        />
                        <span className="qm-slider" />
                      </label>
                    </div>

                    {activeQuizDraft.securityEnabled && (
                      <>
                        <div className="qm-sec-subrules">
                          <label className="qm-checkbox-label">
                            <input
                              type="checkbox"
                              checked={activeQuizDraft.requireTeacherUnlock ?? true}
                              onChange={(e) =>
                                setActiveQuizDraft({
                                  ...activeQuizDraft,
                                  requireTeacherUnlock: e.target.checked,
                                })
                              }
                            />
                            <span>Require Teacher 4-Digit PIN to unlock exam if violation triggers</span>
                          </label>

                          {securityDefaults.defaultEnableWatermark && (
                            <label className="qm-checkbox-label">
                              <input
                                type="checkbox"
                                checked={activeQuizDraft.enableWatermark ?? false}
                                onChange={(e) =>
                                  setActiveQuizDraft({
                                    ...activeQuizDraft,
                                    enableWatermark: e.target.checked,
                                  })
                                }
                              />
                              <span>Candidate Dynamic Security Watermark (Anti-Photo Leaks)</span>
                            </label>
                          )}

                          {securityDefaults.defaultEnableMultiMonitor && (
                            <label className="qm-checkbox-label">
                              <input
                                type="checkbox"
                                checked={activeQuizDraft.enableMultiMonitorDetection ?? false}
                                onChange={(e) =>
                                  setActiveQuizDraft({
                                    ...activeQuizDraft,
                                    enableMultiMonitorDetection: e.target.checked,
                                  })
                                }
                              />
                              <span>Multi-Monitor Dual-Screen Shield (Prevents secondary monitors)</span>
                            </label>
                          )}

                          <label className="qm-checkbox-label">
                            <input
                              type="checkbox"
                              checked={activeQuizDraft.requireStudentPin ?? false}
                              onChange={(e) =>
                                setActiveQuizDraft({
                                  ...activeQuizDraft,
                                  requireStudentPin: e.target.checked,
                                })
                              }
                            />
                            <span>Require Student 4-Digit Security PIN to enter quiz</span>
                          </label>
                        </div>

                        {/* PIN Configuration Box */}
                        <div className="qm-pin-config-box">
                          <label className="qm-checkbox-label" style={{ fontWeight: 700 }}>
                            <span>🔑 Teacher Invigilator Unlock PIN:</span>
                          </label>
                          <div className="qm-pin-input-group">
                            <div className="qm-pin-inputs-row">
                              <input
                                type={showDraftPin ? 'text' : 'password'}
                                className="qm-form-input qm-pin-input"
                                value={activeQuizDraft.teacherPin || '1234'}
                                onChange={(e) =>
                                  setActiveQuizDraft({
                                    ...activeQuizDraft,
                                    teacherPin: e.target.value.replace(/\D/g, '').slice(0, 8),
                                  })
                                }
                                placeholder="1234"
                                maxLength={8}
                              />
                              <button
                                type="button"
                                className="qm-btn qm-btn-secondary qm-btn-pin-action"
                                onClick={() => setShowDraftPin((v) => !v)}
                              >
                                {showDraftPin ? '🙈 Hide' : '👁️ View'}
                              </button>
                            </div>
                            <p className="qm-pin-hint">
                              Used by the teacher in the classroom to unlock student devices after violation lockouts.
                            </p>
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Model Solutions & Results Release Policy */}
                  {activeQuizDraft.isExamMode ? (
                    <div
                      style={{
                        background: 'rgba(59, 130, 246, 0.08)',
                        border: '1px solid rgba(59, 130, 246, 0.25)',
                        borderRadius: '10px',
                        padding: '12px 16px',
                        fontSize: '0.8125rem',
                        color: 'var(--color-text-secondary)',
                        display: 'flex',
                        gap: '10px',
                        alignItems: 'flex-start',
                      }}
                    >
                      <span style={{ fontSize: '1.25rem' }}>🔒</span>
                      <div>
                        <strong style={{ color: 'var(--color-text-primary)', display: 'block', marginBottom: '2px' }}>
                          Model Solutions Withheld During Exam (Deferred Grading)
                        </strong>
                        In Timed Exam Mode, model solutions, mark schemes, and scores are never revealed on submission. Students receive an official confirmation receipt, and results are only released when you evaluate and publish them from the gradebook.
                      </div>
                    </div>
                  ) : (
                    <div className="qm-checkbox-row">
                      <label className="qm-checkbox-label">
                        <input
                          type="checkbox"
                          checked={activeQuizDraft.showInstantSolutions}
                          onChange={(e) =>
                            setActiveQuizDraft({
                              ...activeQuizDraft,
                              showInstantSolutions: e.target.checked,
                            })
                          }
                        />
                        <span>Show model solutions, marking schemes, and misconception warnings on submission</span>
                      </label>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="qm-modal-footer">
              <button
                type="button"
                className="qm-btn qm-btn-secondary"
                onClick={() => {
                  setIsConfigModalOpen(false);
                  setActiveQuizDraft(null);
                  setOriginalQuizCode(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="qm-btn qm-btn-primary"
                onClick={handleSaveQuizConfig}
              >
                {originalQuizCode ? '💾 Save Changes' : '🚀 Save & Publish Quiz'}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Offline Exam Test Selection Modal */}
      {isSelectOfflineTestOpen && createPortal(
        <div className="qm-modal-backdrop animate-fade-in" onClick={() => setIsSelectOfflineTestOpen(false)}>
          <div
            className="qm-modal-card animate-scale-up"
            style={{ maxWidth: '550px' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="qm-modal-header">
              <div className="qm-modal-title-group">
                <span className="qm-modal-icon">📊</span>
                <div>
                  <h2 className="qm-modal-title">Select Exam to Grade Offline</h2>
                  <p className="qm-modal-subtitle">Choose which saved assessment you want to grade students for</p>
                </div>
              </div>
              <button
                type="button"
                className="qm-modal-close"
                onClick={() => setIsSelectOfflineTestOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="qm-modal-body" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {savedTests.map((t) => (
                  <div
                    key={t.id}
                    onClick={() => handleLaunchOfflineGraderForTest(t.id)}
                    style={{
                      padding: '12px 14px',
                      borderRadius: '8px',
                      border: '1px solid var(--color-border)',
                      background: 'var(--color-surface-sunken)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      transition: 'all 0.15s ease',
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-primary-500)';
                      (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-elevated)';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.borderColor = 'var(--color-border)';
                      (e.currentTarget as HTMLElement).style.background = 'var(--color-surface-sunken)';
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 700, color: 'var(--color-text-primary)' }}>{t.title || 'Untitled Assessment'}</div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
                        {t.header_config?.subject || t.primarySubject || 'Chemistry'} • {t.total_marks || 0} marks • {t.question_ids?.length || 0} questions
                      </div>
                    </div>
                    <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--color-primary-600)' }}>Select →</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Offline Grading Modal */}
      {offlineGradingData && (
        <OfflineGradingModal
          isOpen={true}
          onClose={() => setOfflineGradingData(null)}
          headerConfig={offlineGradingData.headerConfig}
          questions={offlineGradingData.questions}
          onViewInGradebook={(quiz) => {
            setOfflineGradingData(null);
            loadData();
            setSelectedQuizForResults(quiz);
          }}
        />
      )}

      {/* Live Invigilator Proctoring Cockpit Modal */}
      {selectedQuizForProctor && (
        <LiveInvigilatorModal
          quiz={selectedQuizForProctor}
          onClose={() => setSelectedQuizForProctor(null)}
        />
      )}

      {/* Confirm Delete Modal */}
      <ConfirmDeleteModal
        isOpen={deleteModalState.isOpen}
        title="Delete Interactive Quiz"
        message={`Are you sure you want to unpublish and permanently delete "${deleteModalState.title}"?`}
        isDeleting={isDeleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteModalState({ isOpen: false, quizId: '', title: '' })}
      />
    </div>
  );
}
