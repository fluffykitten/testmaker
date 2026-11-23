import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import type { Question } from '../types/database';
import {
  fetchCustomTestsWithMetadata,
  fetchCustomTestWithQuestions,
  getLocalTestsWithMetadata,
  getLocalTests,
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
  getLastQuizCloudSyncStatus,
  prewarmExamPaperCache,
  type PublishedQuiz,
  type ExamAttachment,
} from '../services/quizManagerService';
import { uploadExamAttachment } from '../services/storageService';
import { getSubmissionsForQuiz, loadAndSyncAllSubmissions } from '../services/quizSubmissionService';
import { fetchQuestionsByIds } from '../services/quizCodeService';
import { QuizResultsModal } from '../components/QuizResultsModal';
import { OfflineGradingModal } from '../components/OfflineGradingModal';
import { LiveInvigilatorModal } from '../components/LiveInvigilatorModal';
import { ConfirmDeleteModal } from '../components/ConfirmDeleteModal';
import { CandidateCardPrintModal } from '../components/CandidateCardPrintModal';
import { SemesterDayOrganizerModal } from '../components/SemesterDayOrganizerModal';
import { GradeThresholdEditor } from '../components/GradeThresholdEditor';
import { SourceTestCombobox } from '../components/SourceTestCombobox';
import { DEFAULT_GRADE_THRESHOLDS, GRADE_PRESETS } from '../utils/gradeThresholdUtils';
import { getSavedSettings, getSchoolClasses, loadAndSyncSchoolClasses } from '../lib/settings';
import {
  normalizeTargetClassKey,
  parseTargetClassList,
  serializeTargetClassList,
  toggleTargetClassSelection,
} from '../lib/examTargetClasses';
import {
  resolveEffectiveQuizStatus,
  validateExamScheduleWindow,
  isoToLocalDateTimeInput,
  localDateTimeInputToIso,
  buildWindowFromSchoolScheduleEntry,
  formatScheduleWindowLabel,
  getLocalTimezoneLabel,
} from '../lib/examSessionSchedule';
import type { ExamScheduleEntry } from '../lib/examSchedule';
import { getExamSchedule, loadAndSyncExamSchedule } from '../services/examScheduleService';
import { SubjectIcon, getSubjectMetadata } from '../utils/subjectMeta';
import { useTeacherProfile } from '../hooks/useTeacherProfile';
import './QuizManagerPage.css';

interface QuizManagerPageProps {
  onLaunchTestRun: (questions: Question[], headerConfig?: ExamHeaderConfig) => void;
  onLaunchGameHost?: (quiz: PublishedQuiz, questions: Question[]) => void;
  onNavigateToBuilder?: () => void;
  onNavigateToSaved?: () => void;
  onNavigateToBank?: () => void;
}

type SortOption = 'latest' | 'submissions' | 'title';
type FilterStatus = 'all' | 'active' | 'scheduled' | 'paused' | 'exam' | 'game';

function sanitizePublishedQuizList(list: PublishedQuiz[]): PublishedQuiz[] {
  return list.map((q) => {
    if (!q.subject || q.subject.toLowerCase() === 'assessment') {
      return { ...q, subject: q.headerConfig?.subject?.trim() || 'General' };
    }
    return q;
  });
}

export function QuizManagerPage({
  onLaunchTestRun,
  onLaunchGameHost,
  onNavigateToBuilder,
  onNavigateToSaved,
  onNavigateToBank: _onNavigateToBank,
}: QuizManagerPageProps) {
  const [quizzes, setQuizzes] = useState<PublishedQuiz[]>(() => {
    try {
      return sanitizePublishedQuizList(getPublishedQuizzes());
    } catch {
      return [];
    }
  });

  const [savedTests, setSavedTests] = useState<CustomTestWithDetails[]>(() => {
    try {
      return getLocalTestsWithMetadata();
    } catch {
      return [];
    }
  });
  const [loading, setLoading] = useState(() => quizzes.length === 0);
  const [submissionsVersion, setSubmissionsVersion] = useState(0);

  // ─── Two-Level Architecture State ───────────────────────────────────────────
  // Level 1: activeSubjectView === null (Show Subject Cards Hub)
  // Level 2: activeSubjectView === 'all' | '<SubjectName>' (Show Clean Exam List)
  const { activeProfile, showAllSubjects } = useTeacherProfile();
  const [activeSubjectView, setActiveSubjectView] = useState<string | null>(() => {
    if (!showAllSubjects && activeProfile) {
      return activeProfile.subject;
    }
    return null;
  });

  const prevProfileIdRef = useRef<string | undefined>(activeProfile?.id);
  const prevShowAllRef = useRef<boolean>(showAllSubjects);

  // Sync active subject view ONLY when teacher profile or showAllSubjects setting actually changes
  useEffect(() => {
    const profileChanged = prevProfileIdRef.current !== activeProfile?.id;
    const showAllChanged = prevShowAllRef.current !== showAllSubjects;

    prevProfileIdRef.current = activeProfile?.id;
    prevShowAllRef.current = showAllSubjects;

    if (!showAllSubjects && activeProfile) {
      if (profileChanged || showAllChanged) {
        setActiveSubjectView(activeProfile.subject);
      }
    }
  }, [activeProfile, showAllSubjects]);

  // Level 2 Controls
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<FilterStatus>('all');
  const [sortBy, setSortBy] = useState<SortOption>('latest');
  const [viewMode, setViewMode] = useState<'cards' | 'table'>('cards');
  const [isGroupedBySubject, setIsGroupedBySubject] = useState<boolean>(false);

  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);
  const [saveWarningMsg, setSaveWarningMsg] = useState<string | null>(null);
  const [selectedTestId, setSelectedTestId] = useState<string | null>(null);
  const [showDraftPin, setShowDraftPin] = useState<boolean>(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const isSavingConfigRef = useRef(false);
  const [busyQuizIds, setBusyQuizIds] = useState<Record<string, boolean>>({});
  const [deleteModalState, setDeleteModalState] = useState<{ isOpen: boolean; quizId: string; title: string }>({
    isOpen: false,
    quizId: '',
    title: '',
  });
  const [isDeleting, setIsDeleting] = useState(false);
  const [isPrewarmingCache, setIsPrewarmingCache] = useState(false);
  const [openMobileMenuId, setOpenMobileMenuId] = useState<string | null>(null);

  // Modal states
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [isPreparingModal, setIsPreparingModal] = useState(false);
  const [isUploadingAttachment, setIsUploadingAttachment] = useState(false);
  const [attachmentUploadError, setAttachmentUploadError] = useState<string | null>(null);
  const [activeQuizDraft, setActiveQuizDraft] = useState<PublishedQuiz | null>(null);
  const [securityDefaults, setSecurityDefaults] = useState(() => getSavedSettings());
  const isQuizizzAllowed = Boolean(securityDefaults.enableQuizizzMode);
  const [selectedQuizForResults, setSelectedQuizForResults] = useState<PublishedQuiz | null>(null);
  const [selectedQuizForProctor, setSelectedQuizForProctor] = useState<PublishedQuiz | null>(null);
  const [isSchoolProctorOpen, setIsSchoolProctorOpen] = useState(false);
  const [isPrintDeskCardsOpen, setIsPrintDeskCardsOpen] = useState(false);
  const [isDayOrganizerOpen, setIsDayOrganizerOpen] = useState(false);
  const [originalQuizCode, setOriginalQuizCode] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [schoolScheduleEntries, setSchoolScheduleEntries] = useState<ExamScheduleEntry[]>(() => {
    try {
      return getExamSchedule();
    } catch {
      return [];
    }
  });
  const [selectedSchedulePresetId, setSelectedSchedulePresetId] = useState<string>('');
  const [schoolClasses, setSchoolClasses] = useState<string[]>(() => getSchoolClasses());
  const [showCustomTargetClassInput, setShowCustomTargetClassInput] = useState(false);
  const [customTargetClassInput, setCustomTargetClassInput] = useState('');
  const [isTargetClassesOpen, setIsTargetClassesOpen] = useState(true);
  const [isScheduleOpen, setIsScheduleOpen] = useState(true);
  const [isGradeCurveOpen, setIsGradeCurveOpen] = useState(false);
  const [offlineGradingData, setOfflineGradingData] = useState<{
    headerConfig: ExamHeaderConfig;
    questions: Question[];
  } | null>(null);
  const [isSelectOfflineTestOpen, setIsSelectOfflineTestOpen] = useState(false);

  const configModalDismiss = useBackdropDismiss(() => {
    if (isSavingConfigRef.current) return;
    setIsConfigModalOpen(false);
    setActiveQuizDraft(null);
    setOriginalQuizCode(null);
    setAttachmentUploadError(null);
    setShowCustomTargetClassInput(false);
    setCustomTargetClassInput('');
    setIsTargetClassesOpen(true);
    setIsScheduleOpen(true);
    setIsGradeCurveOpen(false);
  });

  // ─── 1. Load Data on Mount ──────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    try {
      setSecurityDefaults(getSavedSettings());
      const pubList = getPublishedQuizzes();
      if (pubList.length > 0) {
        setQuizzes(sanitizePublishedQuizList(pubList));
        setLoading(false);
      }

      // 1. Fetch saved tests concurrently without blocking on heavy submission sync
      const testsPromise = fetchCustomTestsWithMetadata()
        .then((tests) => {
          setSavedTests(tests);
          return tests;
        })
        .catch((err) => {
          console.warn('Error loading custom tests for quiz manager:', err);
          return [];
        });

      // 2. Concurrently sync published quizzes and student submissions
      const [syncedRes, submissionsRes] = await Promise.allSettled([
        loadAndSyncPublishedQuizzes(),
        loadAndSyncAllSubmissions(),
      ]);

      if (syncedRes.status === 'fulfilled') {
        setQuizzes(sanitizePublishedQuizList(syncedRes.value));
      }
      if (submissionsRes.status === 'fulfilled') {
        setSubmissionsVersion((v) => v + 1);
      }

      await testsPromise;
    } catch (err) {
      console.error('Error loading quiz manager data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    loadAndSyncSchoolClasses().then((classes) => {
      if (classes && classes.length > 0) setSchoolClasses(classes);
    });

    const handleSubmissionsUpdated = () => setSubmissionsVersion((v) => v + 1);
    const handleSettingsUpdated = () => setSecurityDefaults(getSavedSettings());
    const handleSchoolClassesUpdated = (e: Event) => {
      const custom = e as CustomEvent<{ classes?: string[] }>;
      setSchoolClasses(custom.detail?.classes || getSchoolClasses());
    };
    const handleTestsUpdated = () => {
      fetchCustomTestsWithMetadata()
        .then((tests) => setSavedTests(tests))
        .catch((err) => console.warn('Error refreshing custom tests after update:', err));
    };
    const handleQuizzesUpdated = () => {
      setQuizzes(sanitizePublishedQuizList(getPublishedQuizzes()));
    };

    window.addEventListener('submissions_updated', handleSubmissionsUpdated);
    window.addEventListener('storage', handleSettingsUpdated);
    window.addEventListener('school_classes_updated', handleSchoolClassesUpdated);
    window.addEventListener('tests_updated', handleTestsUpdated);
    window.addEventListener('quizzes_updated', handleQuizzesUpdated);

    return () => {
      window.removeEventListener('submissions_updated', handleSubmissionsUpdated);
      window.removeEventListener('storage', handleSettingsUpdated);
      window.removeEventListener('school_classes_updated', handleSchoolClassesUpdated);
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
        !isSchoolProctorOpen &&
        !isPrintDeskCardsOpen &&
        !isDayOrganizerOpen &&
        !deleteModalState.isOpen &&
        !offlineGradingData &&
        !isSelectOfflineTestOpen
      ) {
        setActiveSubjectView(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeSubjectView, isConfigModalOpen, selectedQuizForResults, selectedQuizForProctor, isSchoolProctorOpen, isPrintDeskCardsOpen, isDayOrganizerOpen, deleteModalState.isOpen, offlineGradingData, isSelectOfflineTestOpen]);

  const activeExamQuizzesRef = useRef<PublishedQuiz[]>([]);
  const activeExamQuizzes = useMemo(() => {
    const next = quizzes.filter((q) => resolveEffectiveQuizStatus(q, nowMs) === 'active' && q.quizMode !== 'game');
    const prev = activeExamQuizzesRef.current;
    if (prev.length === next.length && prev.every((q, idx) => q === next[idx])) {
      return prev;
    }
    activeExamQuizzesRef.current = next;
    return next;
  }, [quizzes, nowMs]);

  const proctorModalQuizzes = useMemo(() => {
    if (!selectedQuizForProctor) return activeExamQuizzes;
    return activeExamQuizzes.some((q) => q.id === selectedQuizForProctor.id)
      ? activeExamQuizzes
      : [selectedQuizForProctor, ...activeExamQuizzes];
  }, [selectedQuizForProctor, activeExamQuizzes]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    loadAndSyncExamSchedule()
      .then((entries) => {
        if (entries && entries.length > 0) setSchoolScheduleEntries(entries);
      })
      .catch(() => {});
  }, []);

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
      if (resolveEffectiveQuizStatus(q, nowMs) === 'active') existing.activeCount += 1;
      else existing.pausedCount += 1;

      const subs = getSubmissionsForQuiz(q.id, q.quizCode, q.testId).length;
      existing.totalSubmissions += subs;

      const d = new Date(q.updatedAt || q.createdAt).getTime();
      if (d > existing.latestDate) existing.latestDate = d;

      map.set(sub, existing);
    });

    return Array.from(map.values()).sort((a, b) => b.quizCount - a.quizCount);
  }, [quizzes, submissionsVersion, nowMs]);

  // ─── 3. Filtered Quizzes for Level 2 Drill-Down ─────────────────────────────
  const subjectFilteredQuizzes = useMemo(() => {
    if (!activeSubjectView || activeSubjectView === 'all') return quizzes;
    const targetSub = activeSubjectView.toLowerCase().trim();
    const targetMeta = getSubjectMetadata(activeSubjectView);

    return quizzes.filter((q) => {
      const quizSub = (q.subject || 'General').toLowerCase().trim();
      if (quizSub === targetSub) return true;
      const quizMeta = getSubjectMetadata(q.subject || 'General');
      return targetMeta.id !== 'general' && quizMeta.id === targetMeta.id;
    });
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

      if (statusFilter === 'active') return resolveEffectiveQuizStatus(quiz, nowMs) === 'active';
      if (statusFilter === 'scheduled') return resolveEffectiveQuizStatus(quiz, nowMs) === 'scheduled';
      if (statusFilter === 'paused') {
        const eff = resolveEffectiveQuizStatus(quiz, nowMs);
        return eff === 'paused' || eff === 'closed';
      }
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
  }, [subjectFilteredQuizzes, searchQuery, statusFilter, sortBy, submissionsVersion, nowMs]);

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
  const handleOpenCreateModal = async (initialMode: 'exam' | 'game' = 'exam') => {
    if (isPreparingModal) return;

    let availableTests = savedTests;

    // 1. Check synchronous local storage if memory state is empty
    if (availableTests.length === 0) {
      const local = getLocalTestsWithMetadata();
      if (local.length > 0) {
        setSavedTests(local);
        availableTests = local;
      }
    }

    // 2. If still empty, fetch on-demand from Supabase cloud before alerting
    if (availableTests.length === 0) {
      setIsPreparingModal(true);
      try {
        const fetched = await fetchCustomTestsWithMetadata();
        if (fetched.length > 0) {
          setSavedTests(fetched);
          availableTests = fetched;
        }
      } catch (err) {
        console.warn('On-demand test fetch failed:', err);
      } finally {
        setIsPreparingModal(false);
      }
    }

    // 3. Only if truly 0 tests exist after cloud confirmation, show alert
    if (availableTests.length === 0) {
      alert('You have no saved tests yet. Please build and save a test first before creating an interactive quiz.');
      onNavigateToBuilder?.();
      return;
    }

    const currentSettings = getSavedSettings();
    setSecurityDefaults(currentSettings);

    const effectiveMode = (initialMode === 'game' && currentSettings.enableQuizizzMode) ? 'game' : 'exam';
    const firstTest = availableTests[0];
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
    setAttachmentUploadError(null);
    setActiveQuizDraft(draft);
    setIsTargetClassesOpen(true);
    setIsScheduleOpen(true);
    setIsGradeCurveOpen(false);
    setIsConfigModalOpen(true);
  };

  const handleOpenOfflineGrader = async () => {
    if (isPreparingModal) return;

    let availableTests = savedTests;

    // 1. Check synchronous local storage if memory state is empty
    if (availableTests.length === 0) {
      const local = getLocalTestsWithMetadata();
      if (local.length > 0) {
        setSavedTests(local);
        availableTests = local;
      }
    }

    // 2. If still empty, fetch on-demand from Supabase cloud before alerting
    if (availableTests.length === 0) {
      setIsPreparingModal(true);
      try {
        const fetched = await fetchCustomTestsWithMetadata();
        if (fetched.length > 0) {
          setSavedTests(fetched);
          availableTests = fetched;
        }
      } catch (err) {
        console.warn('On-demand test fetch for offline grader failed:', err);
      } finally {
        setIsPreparingModal(false);
      }
    }

    if (availableTests.length === 0) {
      alert('You have no saved tests yet. Please build and save a test first before grading offline students.');
      onNavigateToBuilder?.();
      return;
    }
    if (availableTests.length === 1) {
      handleLaunchOfflineGraderForTest(availableTests[0].id);
    } else {
      setIsSelectOfflineTestOpen(true);
    }
  };

  const handleLaunchOfflineGraderForTest = async (testId: string) => {
    setIsSelectOfflineTestOpen(false);
    try {
      const resolved = await fetchCustomTestWithQuestions(testId);
      const testMeta = savedTests.find((t) => t.id === testId) || getLocalTests().find((t) => t.id === testId);
      if (resolved && resolved.questions.length > 0) {
        setOfflineGradingData({
          headerConfig: {
            title: testMeta?.header_config?.title || testMeta?.title || 'Offline Exam Assessment',
            schoolName: testMeta?.header_config?.schoolName || '',
            subject: testMeta?.header_config?.subject || (testMeta as any)?.primarySubject || 'General',
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
    const selected = savedTests.find((t) => t.id === testId) || getLocalTests().find((t) => t.id === testId);
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

  const savedTestById = useMemo(() => {
    const map = new Map<string, CustomTestWithDetails>();
    for (const t of savedTests) {
      map.set(t.id, t);
    }
    return map;
  }, [savedTests]);

  const hydrateQuizFromSavedTest = useCallback(
    (quiz: PublishedQuiz): PublishedQuiz => {
      if (!quiz.testId) return quiz;
      const savedTest = savedTestById.get(quiz.testId);
      if (!savedTest) return quiz;
      const savedQuestionIds =
        savedTest.question_ids && savedTest.question_ids.length > 0
          ? savedTest.question_ids
          : quiz.questionIds;
      const savedTotalMarks = savedTest.total_marks > 0 ? savedTest.total_marks : quiz.totalMarks;
      const savedQuestionCount =
        savedQuestionIds && savedQuestionIds.length > 0 ? savedQuestionIds.length : quiz.questionCount;
      return {
        ...quiz,
        questionIds: savedQuestionIds,
        questionCount: savedQuestionCount,
        totalMarks: savedTotalMarks,
        headerConfig: savedTest.header_config
          ? {
              ...(quiz.headerConfig || {}),
              ...savedTest.header_config,
              title: quiz.title || quiz.headerConfig?.title || savedTest.header_config.title,
              subject: quiz.subject || quiz.headerConfig?.subject || savedTest.header_config.subject,
              durationMinutes:
                quiz.durationMinutes ||
                quiz.headerConfig?.durationMinutes ||
                savedTest.header_config.durationMinutes,
            }
          : quiz.headerConfig,
      };
    },
    [savedTestById]
  );

  const handleOpenEditModal = (quiz: PublishedQuiz) => {
    const hydratedQuiz = hydrateQuizFromSavedTest(quiz);
    const currentSettings = getSavedSettings();
    setSecurityDefaults(currentSettings);
    setOriginalQuizCode(hydratedQuiz.quizCode);
    setAttachmentUploadError(null);
    setActiveQuizDraft({
      ...hydratedQuiz,
      attachments: hydratedQuiz.attachments ? [...hydratedQuiz.attachments] : [],
      allowCalculator: quiz.allowCalculator ?? false,
      calculatorType: quiz.calculatorType || 'scientific',
      allowPeriodicTable: quiz.allowPeriodicTable ?? false,
      allowScratchpad: quiz.allowScratchpad ?? false,
      allowFormulaSheet: quiz.allowFormulaSheet ?? false,
      quizMode: quiz.quizMode || 'exam',
      enableWatermark: currentSettings.defaultEnableWatermark ? (quiz.enableWatermark ?? false) : false,
      enableMultiMonitorDetection: currentSettings.defaultEnableMultiMonitor ? (quiz.enableMultiMonitorDetection ?? false) : false,
      hideEmergencyExamButton: quiz.hideEmergencyExamButton ?? currentSettings.hideEmergencyExamButton ?? false,
      requireStudentPin: quiz.requireStudentPin ?? false,
      allowStudentScriptDownload: quiz.allowStudentScriptDownload ?? false,
      scheduledStartAt: quiz.scheduledStartAt ?? null,
      scheduledEndAt: quiz.scheduledEndAt ?? null,
    });
    setSelectedSchedulePresetId('');
    setSelectedTestId(quiz.testId);
    setIsTargetClassesOpen(true);
    setIsScheduleOpen(true);
    setIsGradeCurveOpen(false);
    setIsConfigModalOpen(true);
    setOpenMobileMenuId(null);
  };

  const handleUploadAttachment = async (files: FileList | null) => {
    if (!files || files.length === 0 || !activeQuizDraft) return;
    setIsUploadingAttachment(true);
    setAttachmentUploadError(null);
    try {
      const uploadedList: ExamAttachment[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (file.size > 25 * 1024 * 1024) {
          throw new Error(`File "${file.name}" exceeds the 25 MB limit.`);
        }
        const att = await uploadExamAttachment(file, activeQuizDraft.quizCode || 'EXAM');
        uploadedList.push(att);
      }
      setActiveQuizDraft((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          attachments: [...(prev.attachments || []), ...uploadedList],
        };
      });
    } catch (err: any) {
      setAttachmentUploadError(err.message || 'Failed to upload attachment');
    } finally {
      setIsUploadingAttachment(false);
    }
  };

  const handleRemoveAttachment = (attachmentId: string) => {
    if (!activeQuizDraft) return;
    setActiveQuizDraft({
      ...activeQuizDraft,
      attachments: (activeQuizDraft.attachments || []).filter((a) => a.id !== attachmentId),
    });
  };

  const handleSaveQuizConfig = async () => {
    if (!activeQuizDraft || isSavingConfigRef.current) return;
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

    const cleanSubject = activeQuizDraft.subject?.trim() || activeQuizDraft.headerConfig?.subject?.trim() || 'General';
    const effectiveTeacherPin = activeQuizDraft.teacherPin || '1234';
    const currentSettings = getSavedSettings();

    const isExam = activeQuizDraft.isExamMode ?? true;
    const isGame = (activeQuizDraft.quizMode || 'exam') === 'game';
    const nextStartAt = isGame ? null : (activeQuizDraft.scheduledStartAt ?? null);
    const nextEndAt = isGame ? null : (activeQuizDraft.scheduledEndAt ?? null);

    if (!isGame) {
      const schedCheck = validateExamScheduleWindow(nextStartAt, nextEndAt);
      if (!schedCheck.valid) {
        setIsScheduleOpen(true);
        alert(schedCheck.error || 'Please fix the Session Schedule times before saving.');
        return;
      }
    }

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
      hideEmergencyExamButton: activeQuizDraft.hideEmergencyExamButton ?? currentSettings.hideEmergencyExamButton ?? false,
      requireStudentPin: Boolean(activeQuizDraft.requireStudentPin),
      showInstantSolutions: isExam ? false : (activeQuizDraft.showInstantSolutions ?? false),
      allowStudentScriptDownload: Boolean(activeQuizDraft.allowStudentScriptDownload),
      scheduledStartAt: nextStartAt,
      scheduledEndAt: nextEndAt,
      updatedAt: new Date().toISOString(),
    };

    isSavingConfigRef.current = true;
    setIsSavingConfig(true);
    try {
      const saved = await savePublishedQuiz(updated, originalQuizCode || undefined);
      setQuizzes(sanitizePublishedQuizList(saved));

      setIsConfigModalOpen(false);
      setActiveQuizDraft(null);
      setOriginalQuizCode(null);

      const syncStatus = getLastQuizCloudSyncStatus();
      if (syncStatus && syncStatus.quizId === updated.id && !syncStatus.listSynced) {
        setSaveSuccessMsg(null);
        const sizeNote =
          typeof syncStatus.payloadBytes === 'number' && syncStatus.payloadBytes > 0
            ? `, ${Math.round(syncStatus.payloadBytes / 1024)} KB`
            : '';
        const reasonText = syncStatus.error ? ` (${syncStatus.error}${sizeNote})` : '';
        if (syncStatus.codeIndexSynced) {
          setSaveWarningMsg(
            `Saved locally and exam code [${updated.quizCode}] is live for students, but the cloud dashboard list sync failed${reasonText} — click Save or reload shortly if using another device.`
          );
          setTimeout(() => setSaveWarningMsg(null), 10000);
        } else {
          setSaveWarningMsg(
            `Saved locally only — Supabase cloud sync failed${reasonText || ' (timeout)'}. Check your internet connection and re-save before students join.`
          );
          setTimeout(() => setSaveWarningMsg(null), 10000);
        }
      } else {
        setSaveWarningMsg(null);
        setSaveSuccessMsg(`✨ Quiz "${updated.title}" saved successfully with Code [${updated.quizCode}]!`);
        setTimeout(() => setSaveSuccessMsg(null), 4000);
        if (updated.isActive) {
          void prewarmExamPaperCache([updated.quizCode]);
        }
      }
    } finally {
      isSavingConfigRef.current = false;
      setIsSavingConfig(false);
    }
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
    if (busyQuizIds[id]) return;
    setBusyQuizIds((prev) => ({ ...prev, [id]: true }));
    try {
      const updated = await toggleQuizActiveStatus(id);
      setQuizzes(sanitizePublishedQuizList(getPublishedQuizzes()));
      if (updated?.isActive && updated.quizCode) {
        void prewarmExamPaperCache([updated.quizCode]);
      }
    } finally {
      setBusyQuizIds((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  const handlePrewarmExamCache = async () => {
    if (isPrewarmingCache) return;
    const warmableCodes = quizzes
      .filter((q) => {
        const eff = resolveEffectiveQuizStatus(q, nowMs);
        return eff === 'active' || eff === 'scheduled';
      })
      .map((q) => q.quizCode)
      .filter(Boolean);

    if (warmableCodes.length === 0) {
      setSaveSuccessMsg(null);
      setSaveWarningMsg('No active or scheduled exams available to pre-warm right now.');
      setTimeout(() => setSaveWarningMsg(null), 4500);
      return;
    }

    setIsPrewarmingCache(true);
    try {
      const res = await prewarmExamPaperCache(warmableCodes);
      if (res.ok) {
        setSaveWarningMsg(null);
        setSaveSuccessMsg(
          `⚡ Pre-warmed ${res.warmedCount} exam paper${res.warmedCount === 1 ? '' : 's'} into cloud cache (${res.ttlMinutes} min TTL) — ready for simultaneous student entry.`
        );
        setTimeout(() => setSaveSuccessMsg(null), 6000);
      } else {
        setSaveSuccessMsg(null);
        setSaveWarningMsg(
          `Could not pre-warm exam cache (${res.error || 'ensure Migration 037 is applied'}).`
        );
        setTimeout(() => setSaveWarningMsg(null), 8000);
      }
    } finally {
      setIsPrewarmingCache(false);
    }
  };

  const handleOpenQuizNow = async (quiz: PublishedQuiz) => {
    if (busyQuizIds[quiz.id]) return;
    setBusyQuizIds((prev) => ({ ...prev, [quiz.id]: true }));
    try {
      const updated: PublishedQuiz = {
        ...quiz,
        isActive: true,
        scheduledStartAt: null,
        updatedAt: new Date().toISOString(),
      };
      const saved = await savePublishedQuiz(updated);
      setQuizzes(sanitizePublishedQuizList(saved));
      const syncStatus = getLastQuizCloudSyncStatus();
      if (syncStatus && syncStatus.quizId === updated.id && !syncStatus.codeIndexSynced) {
        setSaveSuccessMsg(null);
        setSaveWarningMsg(
          `Opened locally only — Supabase cloud sync failed (${syncStatus.error || 'timeout'}). Retry shortly.`
        );
        setTimeout(() => setSaveWarningMsg(null), 8000);
      } else {
        setSaveWarningMsg(null);
        setSaveSuccessMsg(`🟢 "${quiz.title}" opened immediately for candidates.`);
        setTimeout(() => setSaveSuccessMsg(null), 3500);
        if (updated.quizCode) {
          void prewarmExamPaperCache([updated.quizCode]);
        }
      }
    } finally {
      setBusyQuizIds((prev) => {
        const next = { ...prev };
        delete next[quiz.id];
        return next;
      });
    }
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

    const testMeta = savedTests.find((t) => t.id === quiz.testId) || getLocalTests().find((t) => t.id === quiz.testId);
    const resolvedHeader: ExamHeaderConfig = {
      title: testMeta?.header_config?.title || quiz.title,
      schoolName: testMeta?.header_config?.schoolName || '',
      subject: testMeta?.header_config?.subject || quiz.subject || 'General',
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

        {/* Cloud Sync Warning Alert */}
        {saveWarningMsg && (
          <div
            className="animate-slide-up"
            role="alert"
            style={{
              background: 'rgba(245, 158, 11, 0.12)',
              border: '1px solid rgba(245, 158, 11, 0.4)',
              color: '#d97706',
              padding: '12px 18px',
              borderRadius: 'var(--radius-lg)',
              fontSize: '0.875rem',
              fontWeight: 600,
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <span>⚠</span> {saveWarningMsg}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════════
            LEVEL 1: SUBJECT HUB OVERVIEW (When activeSubjectView === null)
        ═══════════════════════════════════════════════════════════════════════ */}
        {!loading && quizzes.length > 0 && activeSubjectView === null && (
          <div className="qm-hub-view animate-fade-in">
            {/* Hub Header: Two-Zone Command Layout */}
            <header className="qm-hub-header">
              <div className="qm-hub-header-top">
                <div className="qm-hub-header-left">
                  <h1 className="qm-hub-title">Interactive Quizzes &amp; Live Assessments</h1>
                  <p className="qm-hub-subtitle">
                    Manage {quizzes.length} live assessment{quizzes.length !== 1 ? 's' : ''} organized across {subjectSummaries.length} academic departments. Monitor real-time student submissions and launch proctoring cockpits.
                  </p>
                </div>

                <div className="qm-hub-primary-actions">
                  <div className="qm-view-segmented" role="tablist" aria-label="Assessment view mode">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={activeSubjectView === null}
                      className={`qm-view-seg-btn ${activeSubjectView === null ? 'is-active' : ''}`}
                      onClick={() => setActiveSubjectView(null)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                      </svg>
                      <span>Departments</span>
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={false}
                      className="qm-view-seg-btn"
                      onClick={() => {
                        setActiveSubjectView('all');
                        setStatusFilter('all');
                        setSearchQuery('');
                      }}
                      title="View all quizzes in a unified clean directory"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="7" height="7" />
                        <rect x="14" y="3" width="7" height="7" />
                        <rect x="14" y="14" width="7" height="7" />
                        <rect x="3" y="14" width="7" height="7" />
                      </svg>
                      <span>All Quizzes</span>
                      <span className="qm-view-seg-count">{quizzes.length}</span>
                    </button>
                  </div>

                  {isQuizizzAllowed && (
                    <button
                      type="button"
                      className="qm-btn qm-btn--game"
                      onClick={() => handleOpenCreateModal('game')}
                    >
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="6" y1="12" x2="10" y2="12" />
                        <line x1="8" y1="10" x2="8" y2="14" />
                        <line x1="15" y1="13" x2="15.01" y2="13" />
                        <line x1="18" y1="11" x2="18.01" y2="11" />
                        <rect x="2" y="6" width="20" height="12" rx="4" />
                      </svg>
                      <span>Quizizz Game</span>
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
              </div>

              {/* Operational Command Dock */}
              <div className="qm-ops-dock">
                <div className="qm-ops-group">
                  <span className="qm-ops-group-label">Exam Ops</span>

                  <button
                    type="button"
                    className="qm-op-btn qm-op-btn--days"
                    onClick={() => setIsDayOrganizerOpen(true)}
                    title="Organize exams by semester exam day to activate, warm cache, or pause per day"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                      <line x1="16" y1="2" x2="16" y2="6" />
                      <line x1="8" y1="2" x2="8" y2="6" />
                      <line x1="3" y1="10" x2="21" y2="10" />
                    </svg>
                    <span>Semester Days</span>
                  </button>

                  <button
                    type="button"
                    className="qm-op-btn qm-op-btn--warm"
                    onClick={handlePrewarmExamCache}
                    disabled={isPrewarmingCache}
                    title="Compile and warm active & scheduled exam papers in Supabase cache (90 min) before students join"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                    </svg>
                    <span>{isPrewarmingCache ? 'Warming…' : 'Pre-Warm Cache'}</span>
                  </button>

                  <button
                    type="button"
                    className={`qm-op-btn qm-op-btn--proctor ${activeExamQuizzes.length > 0 ? 'is-live' : ''}`}
                    onClick={() => setIsSchoolProctorOpen(true)}
                    title="Monitor all active examinations across all classes simultaneously"
                  >
                    {activeExamQuizzes.length > 0 ? (
                      <span className="qm-live-dot" aria-hidden="true" />
                    ) : (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9" />
                        <path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5" />
                        <circle cx="12" cy="12" r="2" />
                        <path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5" />
                        <path d="M19.1 4.9C23 8.8 23 15.1 19.1 19" />
                      </svg>
                    )}
                    <span>School Live Proctor</span>
                    <span className="qm-op-count-pill">
                      {activeExamQuizzes.length > 0 ? `${activeExamQuizzes.length} live` : '0'}
                    </span>
                  </button>
                </div>

                <div className="qm-ops-group">
                  <span className="qm-ops-divider" aria-hidden="true" />
                  <span className="qm-ops-group-label">Tools</span>

                  <button
                    type="button"
                    className="qm-op-btn"
                    onClick={() => setIsPrintDeskCardsOpen(true)}
                    title="Print 2x3 A4 Candidate Desk Cards (Profile + PIN + Schedule)"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="5" width="20" height="14" rx="2" />
                      <circle cx="8" cy="12" r="2.2" />
                      <line x1="13" y1="10" x2="18.5" y2="10" />
                      <line x1="13" y1="14" x2="17" y2="14" />
                    </svg>
                    <span>Desk Cards</span>
                  </button>

                  <button
                    type="button"
                    className="qm-op-btn"
                    onClick={handleOpenOfflineGrader}
                    title="Grade offline physical papers using rapid Excel or visual grid"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="18" y1="20" x2="18" y2="10" />
                      <line x1="12" y1="20" x2="12" y2="4" />
                      <line x1="6" y1="20" x2="6" y2="14" />
                    </svg>
                    <span>Grade Offline Exam</span>
                  </button>
                </div>
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
                <button
                  type="button"
                  className="qm-op-btn qm-op-btn--days"
                  onClick={() => setIsDayOrganizerOpen(true)}
                  title="Organize exams by semester exam day to activate, warm cache, or pause per day"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                  <span>Semester Days</span>
                </button>

                <button
                  type="button"
                  className="qm-op-btn qm-op-btn--warm"
                  onClick={handlePrewarmExamCache}
                  disabled={isPrewarmingCache}
                  title="Compile and warm active & scheduled exam papers in Supabase cache (90 min) before students join"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                  </svg>
                  <span>{isPrewarmingCache ? 'Warming…' : 'Pre-Warm Cache'}</span>
                </button>

                <button
                  type="button"
                  className={`qm-op-btn qm-op-btn--proctor ${activeExamQuizzes.length > 0 ? 'is-live' : ''}`}
                  onClick={() => setIsSchoolProctorOpen(true)}
                  title="Monitor all active examinations across all classes simultaneously"
                >
                  {activeExamQuizzes.length > 0 && <span className="qm-live-dot" aria-hidden="true" />}
                  <span>School Live Proctor</span>
                  <span className="qm-op-count-pill">
                    {activeExamQuizzes.length > 0 ? `${activeExamQuizzes.length} live` : '0'}
                  </span>
                </button>

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
                  <span>Publish Exam</span>
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
                    Active ({subjectFilteredQuizzes.filter((q) => resolveEffectiveQuizStatus(q, nowMs) === 'active').length})
                  </button>
                  <button
                    type="button"
                    className={`qm-status-pill ${statusFilter === 'scheduled' ? 'qm-status-pill--active' : ''}`}
                    onClick={() => setStatusFilter('scheduled')}
                  >
                    Scheduled ({subjectFilteredQuizzes.filter((q) => resolveEffectiveQuizStatus(q, nowMs) === 'scheduled').length})
                  </button>
                  <button
                    type="button"
                    className={`qm-status-pill ${statusFilter === 'paused' ? 'qm-status-pill--active' : ''}`}
                    onClick={() => setStatusFilter('paused')}
                  >
                    Paused / Closed ({subjectFilteredQuizzes.filter((q) => {
                      const eff = resolveEffectiveQuizStatus(q, nowMs);
                      return eff === 'paused' || eff === 'closed';
                    }).length})
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
                            const effectiveStatus = resolveEffectiveQuizStatus(quiz, nowMs);
                            const scheduleLabel =
                              !isGame && (quiz.scheduledStartAt || quiz.scheduledEndAt)
                                ? formatScheduleWindowLabel(quiz.scheduledStartAt, quiz.scheduledEndAt)
                                : '';
                            const statusDisplay =
                              effectiveStatus === 'active'
                                ? 'Active'
                                : effectiveStatus === 'scheduled'
                                  ? 'Scheduled'
                                  : effectiveStatus === 'closed'
                                    ? 'Closed'
                                    : 'Paused';

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
                                    className={`qm-row-status-btn qm-row-status--${effectiveStatus}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleToggleActive(quiz.id);
                                    }}
                                    title={
                                      quiz.isActive
                                        ? 'Click to manually pause student access'
                                        : 'Click to re-enable / arm exam access'
                                    }
                                  >
                                    <span className="qm-row-status-dot" />
                                    <span>{statusDisplay}</span>
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
                                      <span>{hydrateQuizFromSavedTest(quiz).questionCount || 0} Qs</span>
                                    </span>

                                    {quiz.securityEnabled && (
                                      <span className="qm-card-chip qm-card-chip--security" title="Candidate Tab Lockdown Active">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                                        </svg>
                                        <span>Lockdown</span>
                                      </span>
                                    )}
                                    {quiz.requireStudentPin && (
                                      <span className="qm-card-chip qm-card-chip--security" title="4-Digit Personal Candidate PIN Required">
                                        <span>🪪 Student PIN</span>
                                      </span>
                                    )}
                                  </div>
                                </div>

                                {scheduleLabel && (
                                  <div
                                    className={`qm-card-schedule-strip ${
                                      effectiveStatus === 'closed'
                                        ? 'qm-card-schedule-strip--closed'
                                        : effectiveStatus === 'paused'
                                          ? 'qm-card-schedule-strip--paused'
                                          : ''
                                    }`}
                                    title={`Entry Window: ${scheduleLabel}`}
                                  >
                                    <span className="qm-card-schedule-text">🗓️ {scheduleLabel}</span>
                                    {effectiveStatus === 'scheduled' && (
                                      <button
                                        type="button"
                                        className="qm-open-now-btn"
                                        style={{ flexShrink: 0 }}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleOpenQuizNow(quiz);
                                        }}
                                        title="Clear scheduled start delay and open exam immediately"
                                      >
                                        ▶ Open Now
                                      </button>
                                    )}
                                  </div>
                                )}

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
                          const effectiveStatus = resolveEffectiveQuizStatus(quiz, nowMs);
                          const scheduleLabel =
                            !isGame && (quiz.scheduledStartAt || quiz.scheduledEndAt)
                              ? formatScheduleWindowLabel(quiz.scheduledStartAt, quiz.scheduledEndAt)
                              : '';
                          const statusDisplay =
                            effectiveStatus === 'active'
                              ? 'Active'
                              : effectiveStatus === 'scheduled'
                                ? 'Scheduled'
                                : effectiveStatus === 'closed'
                                  ? 'Closed'
                                  : 'Paused';

                          return (
                            <div
                              key={quiz.id}
                              className="qm-exam-row"
                              onClick={(e) => {
                                if (
                                  (e.target as HTMLElement).closest('.qm-row-actions') ||
                                  (e.target as HTMLElement).closest('.qm-mobile-action-btn') ||
                                  (e.target as HTMLElement).closest('.qm-row-code-pill') ||
                                  (e.target as HTMLElement).closest('.qm-row-status-btn') ||
                                  (e.target as HTMLElement).closest('.qm-open-now-btn')
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
                                    <span>{hydrateQuizFromSavedTest(quiz).questionCount || 0} Questions</span>
                                    {scheduleLabel && (
                                      <>
                                        <span className="qm-meta-dot">•</span>
                                        <span style={{ color: '#4f46e5', fontWeight: 600 }}>🗓️ {scheduleLabel}</span>
                                      </>
                                    )}
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

                                {/* Active / Scheduled / Closed / Paused Status Toggle */}
                                {effectiveStatus === 'scheduled' && (
                                  <button
                                    type="button"
                                    className="qm-open-now-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleOpenQuizNow(quiz);
                                    }}
                                    title="Clear scheduled start delay and open exam immediately"
                                  >
                                    ▶ Open Now
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className={`qm-row-status-btn qm-row-status--${effectiveStatus}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleToggleActive(quiz.id);
                                  }}
                                  title={
                                    quiz.isActive
                                      ? 'Click to manually pause student access'
                                      : 'Click to re-enable / arm exam access'
                                  }
                                >
                                  <span className="qm-row-status-dot" />
                                  <span>{statusDisplay}</span>
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
          quiz={hydrateQuizFromSavedTest(selectedQuizForResults)}
          onClose={() => setSelectedQuizForResults(null)}
        />
      )}

      {/* ─── Create & Configure Quiz Modal ────────────────────────────────────── */}
      {isConfigModalOpen && activeQuizDraft && createPortal(
        <div className="qm-modal-backdrop animate-fade-in" {...configModalDismiss}>
          <div className="qm-modal-card qm-studio-modal animate-scale-up" onClick={(e) => e.stopPropagation()}>
            {/* ─── Minimalist Header with ICM Logo ─────────────────────── */}
            <div className="qm-modal-header qm-studio-header">
              <div className="qm-studio-header-brand">
                <img
                  src="/logos/icm_school_logo.png"
                  alt="ICM Logo"
                  className="qm-studio-logo"
                  onError={(e) => {
                    (e.currentTarget as HTMLElement).style.display = 'none';
                  }}
                />
                <div className="qm-studio-header-divider" />
                <div>
                  <h2 className="qm-modal-title">
                    {originalQuizCode ? `Exam Settings: ${activeQuizDraft.title}` : 'Configure Exam Settings'}
                  </h2>
                  <p className="qm-modal-sub">
                    Cambridge International School ID395 • {activeQuizDraft.subject || 'Assessment'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="qm-modal-close"
                onClick={() => {
                  setIsConfigModalOpen(false);
                  setActiveQuizDraft(null);
                  setOriginalQuizCode(null);
                }}
                title="Close settings"
              >
                ✕
              </button>
            </div>

            {/* ─── Unified 1-Page Settings Body ─────────────────────────── */}
            <div className="qm-modal-body qm-studio-body">
              <div className="qm-studio-grid">
                {/* ═══ LEFT COLUMN: Identification & Timing ═══════════════ */}
                <div className="qm-studio-col">
                  {/* Section 1: Identification */}
                  <section className="qm-studio-section">
                    <h3 className="qm-studio-section-title">
                      <span>🏷️</span> Identification
                    </h3>
                  {/* Select Saved Test (Searchable Combobox) */}
                  <div className="qm-form-group">
                    <label className="qm-form-label">Select Source Test from Saved Exams:</label>
                    <SourceTestCombobox
                      savedTests={savedTests}
                      selectedTestId={selectedTestId}
                      onSelect={handleSelectSavedTest}
                      disabled={Boolean(originalQuizCode)}
                    />
                    {originalQuizCode && (
                      <span className="qm-form-hint" style={{ fontSize: '0.76rem' }}>
                        Source test questions are locked to this quiz. To publish a different test, create a new interactive quiz.
                      </span>
                    )}
                  </div>

                  {/* Subject & Title */}
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

                  {/* Custom Quiz Code */}
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
                      <span style={{ color: '#ef4444', fontSize: '0.8rem', fontWeight: 600, display: 'block', marginTop: '4px' }}>
                        ⚠️ This Quiz Code is already in use by another quiz. Please choose a unique code.
                      </span>
                    ) : (
                      <span className="qm-form-hint">
                        Students use this exact code to join on the landing page.
                      </span>
                    )}
                  </div>

                  {/* Target Class Cohort (Collapsible Accordion) */}
                  {(() => {
                    const selectedTargets = parseTargetClassList(activeQuizDraft.targetClass);
                    const selectedKeys = new Set(selectedTargets.map((c) => normalizeTargetClassKey(c)));
                    const extraCustomTargets = selectedTargets.filter(
                      (c) => !schoolClasses.some((sc) => normalizeTargetClassKey(sc) === normalizeTargetClassKey(c))
                    );
                    const pillOptions = [...schoolClasses, ...extraCustomTargets];
                    const classSummary =
                      selectedTargets.length === 0
                        ? 'All school classes & candidate names'
                        : selectedTargets.length <= 3
                          ? selectedTargets.join(', ')
                          : `${selectedTargets.slice(0, 2).join(', ')} +${selectedTargets.length - 2} more`;

                    const handleAddCustomTargetClass = () => {
                      const trimmed = customTargetClassInput.trim();
                      if (!trimmed) return;
                      const merged = serializeTargetClassList([...selectedTargets, trimmed]);
                      setActiveQuizDraft({
                        ...activeQuizDraft,
                        targetClass: merged,
                      });
                      setCustomTargetClassInput('');
                      setShowCustomTargetClassInput(false);
                    };

                    return (
                      <div className="qm-accordion-card">
                        <button
                          type="button"
                          className="qm-accordion-trigger"
                          onClick={() => setIsTargetClassesOpen((v) => !v)}
                          aria-expanded={isTargetClassesOpen}
                        >
                          <div className="qm-accordion-left">
                            <span className="qm-accordion-title">👥 Target Classes</span>
                            <span className="qm-accordion-summary">{classSummary}</span>
                          </div>
                          <div className="qm-accordion-right">
                            <span
                              className={`qm-target-classes-badge ${
                                selectedTargets.length > 0 ? 'qm-target-classes-badge--filtered' : ''
                              }`}
                            >
                              {selectedTargets.length === 0
                                ? 'All Classes'
                                : `${selectedTargets.length} Selected`}
                            </span>
                            {selectedTargets.length > 0 && (
                              <span
                                role="button"
                                tabIndex={0}
                                className="qm-target-clear-btn"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActiveQuizDraft({
                                    ...activeQuizDraft,
                                    targetClass: '',
                                  });
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setActiveQuizDraft({
                                      ...activeQuizDraft,
                                      targetClass: '',
                                    });
                                  }
                                }}
                              >
                                Clear
                              </span>
                            )}
                            <span className="qm-accordion-chevron" aria-hidden="true">
                              {isTargetClassesOpen ? '▴' : '▾'}
                            </span>
                          </div>
                        </button>

                        {isTargetClassesOpen && (
                          <div className="qm-accordion-body">
                            <div className="qm-cohort-pills" role="group" aria-label="Target classes">
                              {pillOptions.map((cls) => {
                                const active = selectedKeys.has(normalizeTargetClassKey(cls));
                                return (
                                  <button
                                    key={cls}
                                    type="button"
                                    className={`qm-cohort-pill ${active ? 'qm-cohort-pill--active' : ''}`}
                                    onClick={() =>
                                      setActiveQuizDraft({
                                        ...activeQuizDraft,
                                        targetClass: toggleTargetClassSelection(activeQuizDraft.targetClass, cls),
                                      })
                                    }
                                  >
                                    {active && <span>✓</span>}
                                    <span>{cls}</span>
                                  </button>
                                );
                              })}
                              <button
                                type="button"
                                className="qm-cohort-pill qm-cohort-pill--add"
                                onClick={() => setShowCustomTargetClassInput((v) => !v)}
                              >
                                {showCustomTargetClassInput ? 'Cancel' : '+ Custom'}
                              </button>
                            </div>

                            {showCustomTargetClassInput && (
                              <div className="qm-cohort-custom-row">
                                <input
                                  type="text"
                                  className="qm-form-input"
                                  value={customTargetClassInput}
                                  onChange={(e) => setCustomTargetClassInput(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      handleAddCustomTargetClass();
                                    }
                                  }}
                                  placeholder="Enter ad-hoc class (e.g. 10-D, Olympians)..."
                                  autoFocus
                                />
                                <button
                                  type="button"
                                  className="qm-btn-secondary"
                                  onClick={handleAddCustomTargetClass}
                                  disabled={!customTargetClassInput.trim()}
                                >
                                  Add
                                </button>
                              </div>
                            )}

                            <span className="qm-form-hint">
                              Leave all unselected to allow all school classes. Selecting classes filters dropdowns, autocomplete, and live proctoring.
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Assessment Format (Formal Exam vs Quizizz Game) */}
                  {isQuizizzAllowed && (
                    <div className="qm-form-group" style={{ marginTop: '4px' }}>
                      <label className="qm-form-label">Assessment Format:</label>
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
                            <p>Timed assessment with fullscreen lockdown, proctoring audit log, and examiner tools.</p>
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
                            <p>Fast-paced game-show with power-ups, answer streaks, sound FX, and live leaderboard.</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </section>

                  {/* Section 2: Format & Timing */}
                  <section className="qm-studio-section">
                    <h3 className="qm-studio-section-title">
                      <span>⏱️</span> Format &amp; Timing
                    </h3>
                  {isQuizizzAllowed && activeQuizDraft.quizMode === 'game' ? (
                    /* Game Mode Settings */
                    <div className="qm-game-settings-panel">
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
                          <span>🔊 Fun Sound FX &amp; Synthesized Cues</span>
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
                    /* Formal Exam Mode Timing */
                    <div className="qm-timing-panel" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
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
                          <span className="qm-form-hint">Standard papers: 45–120 mins.</span>
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
                          <span className="qm-form-hint">Practice allows flexible pauses &amp; retry.</span>
                        </div>
                      </div>

                      {/* Practice Mode Solution Release */}
                      {!activeQuizDraft.isExamMode && (
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

                      {/* Session Schedule Accordion */}
                      {(() => {
                        const hasSchedule = Boolean(
                          activeQuizDraft.scheduledStartAt || activeQuizDraft.scheduledEndAt
                        );
                        const schedCheck = validateExamScheduleWindow(
                          activeQuizDraft.scheduledStartAt,
                          activeQuizDraft.scheduledEndAt
                        );
                        const schedSummary = hasSchedule
                          ? formatScheduleWindowLabel(
                              activeQuizDraft.scheduledStartAt,
                              activeQuizDraft.scheduledEndAt
                            ) || `Scheduled • ${getLocalTimezoneLabel()}`
                          : `Immediate entry • ${getLocalTimezoneLabel()}`;

                        return (
                          <div className="qm-accordion-card">
                            <button
                              type="button"
                              className="qm-accordion-trigger"
                              onClick={() => setIsScheduleOpen((v) => !v)}
                              aria-expanded={isScheduleOpen}
                            >
                              <div className="qm-accordion-left">
                                <span className="qm-accordion-title">🗓️ Session Schedule</span>
                                <span className="qm-accordion-summary">
                                  {!schedCheck.valid ? '⚠️ Invalid window' : schedSummary}
                                </span>
                              </div>
                              <div className="qm-accordion-right">
                                {hasSchedule && (
                                  <span className="qm-target-classes-badge qm-target-classes-badge--filtered">
                                    Scheduled
                                  </span>
                                )}
                                <span className="qm-accordion-chevron" aria-hidden="true">
                                  {isScheduleOpen ? '▴' : '▾'}
                                </span>
                              </div>
                            </button>

                            {isScheduleOpen && (
                              <div className="qm-accordion-body">
                                <div className="qm-schedule-header-row">
                                  <p className="qm-studio-card-sub" style={{ margin: 0 }}>
                                    Optional auto open &amp; entry-close times. Manual Pause always overrides.
                                  </p>
                                  <span className="qm-schedule-tz-pill" title="Times entered below use this local timezone">
                                    🌐 {getLocalTimezoneLabel()}
                                  </span>
                                </div>

                                {schoolScheduleEntries.length > 0 && (
                                  <div className="qm-form-group" style={{ marginBottom: '2px' }}>
                                    <label className="qm-form-label" htmlFor="qm-school-sched-preset">
                                      Pick from School Exam Schedule (Quick-Fill):
                                    </label>
                                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                      <select
                                        id="qm-school-sched-preset"
                                        className="qm-form-select"
                                        value={selectedSchedulePresetId}
                                        onChange={(e) => {
                                          const presetId = e.target.value;
                                          setSelectedSchedulePresetId(presetId);
                                          const entry = schoolScheduleEntries.find((item) => item.id === presetId);
                                          if (entry) {
                                            const win = buildWindowFromSchoolScheduleEntry(
                                              entry,
                                              activeQuizDraft.durationMinutes || 60
                                            );
                                            setActiveQuizDraft({
                                              ...activeQuizDraft,
                                              scheduledStartAt: win.scheduledStartAt,
                                              scheduledEndAt: win.scheduledEndAt,
                                            });
                                          }
                                        }}
                                      >
                                        <option value="">— Custom Date &amp; Time —</option>
                                        {schoolScheduleEntries.map((entry) => (
                                          <option key={entry.id} value={entry.id}>
                                            {entry.date} • {entry.time} — {entry.subject}
                                            {entry.targetClass && entry.targetClass !== 'ALL' ? ` (${entry.targetClass})` : ''}
                                          </option>
                                        ))}
                                      </select>
                                      {hasSchedule && (
                                        <button
                                          type="button"
                                          className="qm-btn qm-btn-secondary"
                                          style={{ whiteSpace: 'nowrap' }}
                                          onClick={() => {
                                            setSelectedSchedulePresetId('');
                                            setActiveQuizDraft({
                                              ...activeQuizDraft,
                                              scheduledStartAt: null,
                                              scheduledEndAt: null,
                                            });
                                          }}
                                        >
                                          Clear
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                )}

                                <div className="qm-form-row">
                                  <div className="qm-form-group" style={{ flex: 1 }}>
                                    <label className="qm-form-label" htmlFor="qm-sched-start">
                                      Auto-Open At:
                                    </label>
                                    <input
                                      id="qm-sched-start"
                                      type="datetime-local"
                                      className="qm-form-input"
                                      value={isoToLocalDateTimeInput(activeQuizDraft.scheduledStartAt)}
                                      onChange={(e) => {
                                        setSelectedSchedulePresetId('');
                                        setActiveQuizDraft({
                                          ...activeQuizDraft,
                                          scheduledStartAt: localDateTimeInputToIso(e.target.value),
                                        });
                                      }}
                                    />
                                  </div>

                                  <div className="qm-form-group" style={{ flex: 1 }}>
                                    <label className="qm-form-label" htmlFor="qm-sched-end">
                                      Close Entry At (Optional):
                                    </label>
                                    <input
                                      id="qm-sched-end"
                                      type="datetime-local"
                                      className="qm-form-input"
                                      value={isoToLocalDateTimeInput(activeQuizDraft.scheduledEndAt)}
                                      onChange={(e) => {
                                        setSelectedSchedulePresetId('');
                                        setActiveQuizDraft({
                                          ...activeQuizDraft,
                                          scheduledEndAt: localDateTimeInputToIso(e.target.value),
                                        });
                                      }}
                                    />
                                  </div>
                                </div>

                                {!schedCheck.valid && (
                                  <div className="qm-schedule-error">
                                    ⚠️ {schedCheck.error}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })()}

                      {/* Post-Exam Full Script PDF / Stem Review Policy (safe-by-default OFF) */}
                      <div className="qm-checkbox-row" style={{ marginTop: '2px' }}>
                        <label className="qm-checkbox-label">
                          <input
                            type="checkbox"
                            checked={Boolean(activeQuizDraft.allowStudentScriptDownload)}
                            onChange={(e) =>
                              setActiveQuizDraft({
                                ...activeQuizDraft,
                                allowStudentScriptDownload: e.target.checked,
                              })
                            }
                          />
                          <span>Allow students to view &amp; download Full Script PDF after results release</span>
                        </label>
                      </div>
                    </div>
                  )}
                </section>

                {/* 3. Grade Boundaries & Curve (Collapsible Accordion) */}
                {(() => {
                  const gThresh = activeQuizDraft.gradeThresholds || DEFAULT_GRADE_THRESHOLDS;
                  const matchedPreset = GRADE_PRESETS.find(
                    (p) =>
                      p.thresholds.aStar === gThresh.aStar &&
                      p.thresholds.a === gThresh.a &&
                      p.thresholds.b === gThresh.b &&
                      p.thresholds.c === gThresh.c &&
                      p.thresholds.d === gThresh.d &&
                      p.thresholds.e === gThresh.e
                  );
                  const curveSummary = matchedPreset
                    ? `${matchedPreset.name} (A* ≥ ${gThresh.aStar}%)`
                    : `Custom Curve (A* ≥ ${gThresh.aStar}% • D ≥ ${gThresh.d}%)`;

                  return (
                    <div className="qm-accordion-card">
                      <button
                        type="button"
                        className="qm-accordion-trigger"
                        onClick={() => setIsGradeCurveOpen((v) => !v)}
                        aria-expanded={isGradeCurveOpen}
                      >
                        <div className="qm-accordion-left">
                          <span className="qm-accordion-title">📊 Grade Boundaries (A* – U)</span>
                          <span className="qm-accordion-summary">{curveSummary}</span>
                        </div>
                        <div className="qm-accordion-right">
                          <span className="qm-accordion-chevron" aria-hidden="true">
                            {isGradeCurveOpen ? '▴' : '▾'}
                          </span>
                        </div>
                      </button>

                      {isGradeCurveOpen && (
                        <div className="qm-accordion-body">
                          <GradeThresholdEditor
                            value={activeQuizDraft.gradeThresholds}
                            onChange={(gradeThresholds) =>
                              setActiveQuizDraft({
                                ...activeQuizDraft,
                                gradeThresholds,
                              })
                            }
                            totalMarks={activeQuizDraft.totalMarks}
                          />
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* ═══ RIGHT COLUMN: Security (Top) + Tools + Attachments ══ */}
              <div className="qm-studio-col">
                {/* 1. Security & Integrity (TOP of Right Column) */}
                <section className="qm-studio-section">
                  <h3 className="qm-studio-section-title">
                    <span>🛡️</span> Security &amp; Integrity
                  </h3>
                  <div className="qm-studio-card qm-studio-security-card">
                    <div className="qm-studio-card-row">
                      <div>
                        <strong className="qm-studio-card-title">Browser Lockdown</strong>
                        <p className="qm-studio-card-sub">Blocks tab switching and unauthorized apps</p>
                      </div>
                      <label className="qm-switch" title="Toggle browser lockdown">
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

                    <div className="qm-studio-divider" />

                    <div className="qm-studio-card-row">
                      <div>
                        <strong className="qm-studio-card-title">🪪 Require Personal Candidate PIN</strong>
                        <p className="qm-studio-card-sub">4-digit roster PIN before starting or resuming</p>
                      </div>
                      <label className="qm-switch" title="Toggle 4-digit Personal Candidate PIN verification">
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
                        <span className="qm-slider" />
                      </label>
                    </div>

                    {activeQuizDraft.securityEnabled && (
                      <div className="qm-studio-security-sub">
                        <div className="qm-studio-sec-mini-tile" title="Dynamic student ID overlay to prevent photo leaks">
                          <div>
                            <span className="qm-studio-sub-label">Candidate Watermark</span>
                            <p className="qm-studio-card-sub">Student ID overlay</p>
                          </div>
                          <label className="qm-switch">
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
                            <span className="qm-slider" />
                          </label>
                        </div>

                        <div className="qm-studio-sec-mini-tile" title="Alerts invigilator if student has secondary displays">
                          <div>
                            <span className="qm-studio-sub-label">Multi-Monitor Alert</span>
                            <p className="qm-studio-card-sub">Detect 2nd display</p>
                          </div>
                          <label className="qm-switch">
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
                            <span className="qm-slider" />
                          </label>
                        </div>

                        <div className="qm-studio-sec-mini-tile" title="Hides the mid-exam emergency save & exit button for students">
                          <div>
                            <span className="qm-studio-sub-label">Hide Emergency Save</span>
                            <p className="qm-studio-card-sub">No mid-exam exit</p>
                          </div>
                          <label className="qm-switch">
                            <input
                              type="checkbox"
                              checked={activeQuizDraft.hideEmergencyExamButton ?? false}
                              onChange={(e) =>
                                setActiveQuizDraft({
                                  ...activeQuizDraft,
                                  hideEmergencyExamButton: e.target.checked,
                                })
                              }
                            />
                            <span className="qm-slider" />
                          </label>
                        </div>

                        <div className="qm-studio-pin-row" title="Classroom PIN to unlock student lockout strikes">
                          <div>
                            <span className="qm-studio-sub-label">Unlock PIN</span>
                            <p className="qm-studio-card-sub">Strike reset</p>
                          </div>
                          <div className="qm-pin-inputs-row" style={{ marginTop: 0 }}>
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
                              style={{ width: '70px', padding: '5px 7px', fontSize: '0.8rem' }}
                            />
                            <button
                              type="button"
                              className="qm-btn qm-btn-secondary"
                              style={{ padding: '4px 7px', fontSize: '0.72rem' }}
                              onClick={() => setShowDraftPin((v) => !v)}
                              title={showDraftPin ? 'Hide PIN' : 'Show PIN'}
                            >
                              {showDraftPin ? '🙈' : '👁️'}
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </section>

                {/* 2. Candidate Tools (BELOW Security) */}
                <section className="qm-studio-section">
                  <h3 className="qm-studio-section-title">
                    <span>🧰</span> Candidate Tools
                  </h3>
                  <div className="qm-studio-card">
                    {/* Calculator with inline Scientific vs Basic toggle */}
                    <div className="qm-studio-card-row">
                      <div style={{ flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ fontSize: '1.05rem' }}>🧮</span>
                          <strong className="qm-studio-card-title">Calculator</strong>
                        </div>
                        {activeQuizDraft.allowCalculator && (
                          <div className="qm-studio-calc-pills">
                            <button
                              type="button"
                              className={`qm-studio-calc-pill ${activeQuizDraft.calculatorType !== 'basic' ? 'active' : ''}`}
                              onClick={() => setActiveQuizDraft({ ...activeQuizDraft, calculatorType: 'scientific' })}
                            >
                              Scientific
                            </button>
                            <button
                              type="button"
                              className={`qm-studio-calc-pill ${activeQuizDraft.calculatorType === 'basic' ? 'active' : ''}`}
                              onClick={() => setActiveQuizDraft({ ...activeQuizDraft, calculatorType: 'basic' })}
                            >
                              Basic
                            </button>
                          </div>
                        )}
                      </div>
                      <label className="qm-switch" title="Toggle calculator">
                        <input
                          type="checkbox"
                          checked={activeQuizDraft.allowCalculator ?? false}
                          onChange={(e) =>
                            setActiveQuizDraft({
                              ...activeQuizDraft,
                              allowCalculator: e.target.checked,
                            })
                          }
                        />
                        <span className="qm-slider" />
                      </label>
                    </div>

                    <div className="qm-studio-divider" />

                    {/* 3 Reference Tool Quick Toggles */}
                    <div className="qm-studio-tools-row">
                      <label className="qm-studio-tool-toggle">
                        <input
                          type="checkbox"
                          checked={activeQuizDraft.allowPeriodicTable ?? false}
                          onChange={(e) =>
                            setActiveQuizDraft({
                              ...activeQuizDraft,
                              allowPeriodicTable: e.target.checked,
                            })
                          }
                        />
                        <span className="qm-studio-tool-chip">
                          <span>🧪</span>
                          <span>Periodic Table</span>
                        </span>
                      </label>

                      <label className="qm-studio-tool-toggle">
                        <input
                          type="checkbox"
                          checked={activeQuizDraft.allowScratchpad ?? false}
                          onChange={(e) =>
                            setActiveQuizDraft({
                              ...activeQuizDraft,
                              allowScratchpad: e.target.checked,
                            })
                          }
                        />
                        <span className="qm-studio-tool-chip">
                          <span>📝</span>
                          <span>Scratchpad</span>
                        </span>
                      </label>

                      <label className="qm-studio-tool-toggle">
                        <input
                          type="checkbox"
                          checked={activeQuizDraft.allowFormulaSheet ?? false}
                          onChange={(e) =>
                            setActiveQuizDraft({
                              ...activeQuizDraft,
                              allowFormulaSheet: e.target.checked,
                            })
                          }
                        />
                        <span className="qm-studio-tool-chip">
                          <span>📐</span>
                          <span>Formula Sheet</span>
                        </span>
                      </label>
                    </div>
                  </div>
                </section>

                {/* 3. Attachments & Reference Materials */}
                <section className="qm-studio-section">
                  <h3 className="qm-studio-section-title">
                    <span>📎</span> Attachments &amp; Reference Inserts
                    {((activeQuizDraft.attachments?.length || 0) > 0) && (
                      <span className="qm-tool-count-chip" style={{ marginLeft: '8px' }}>
                        {activeQuizDraft.attachments?.length} attached
                      </span>
                    )}
                  </h3>

                  {/* Upload Dropzone */}
                  <label className={`qm-attachment-dropzone ${isUploadingAttachment ? 'qm-attachment-dropzone--uploading' : ''}`}>
                    <input
                      type="file"
                      multiple
                      accept=".pdf,image/*,.docx,.txt"
                      style={{ display: 'none' }}
                      disabled={isUploadingAttachment}
                      onChange={(e) => {
                        handleUploadAttachment(e.target.files);
                        e.target.value = '';
                      }}
                    />
                    {isUploadingAttachment ? (
                      <div className="qm-attachment-dropzone-inner">
                        <span className="qm-spinner" />
                        <span>Uploading file...</span>
                      </div>
                    ) : (
                      <div className="qm-attachment-dropzone-inner" style={{ padding: '4px 10px' }}>
                        <span className="qm-dropzone-icon" style={{ fontSize: '1.15rem' }}>📥</span>
                        <div>
                          <strong>Click or drag to attach reference materials</strong>
                          <p>PDF case studies, formula sheets, maps (Max 25 MB)</p>
                        </div>
                      </div>
                    )}
                  </label>

                  {attachmentUploadError && (
                    <div className="qm-alert-error" style={{ marginTop: '6px' }}>
                      ⚠️ {attachmentUploadError}
                    </div>
                  )}

                  {/* Staged Attachments List */}
                  {activeQuizDraft.attachments && activeQuizDraft.attachments.length > 0 && (
                    <div className="qm-attachment-list" style={{ marginTop: '6px' }}>
                      {activeQuizDraft.attachments.map((att) => (
                        <div key={att.id} className="qm-attachment-item" style={{ padding: '6px 10px' }}>
                          <span className="qm-attachment-icon" style={{ fontSize: '1rem' }}>
                            {att.fileType === 'pdf' ? '📄' : att.fileType === 'image' ? '🖼️' : '📝'}
                          </span>
                          <div className="qm-attachment-info">
                            <span className="qm-attachment-name" title={att.name}>{att.name}</span>
                            <span className="qm-attachment-meta">
                              {att.sizeBytes ? `${(att.sizeBytes / 1024 / 1024).toFixed(2)} MB` : 'File'}
                            </span>
                          </div>
                          <div className="qm-attachment-actions">
                            <a
                              href={att.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="qm-attachment-btn"
                              title="View document"
                            >
                              View
                            </a>
                            <button
                              type="button"
                              className="qm-attachment-btn qm-attachment-btn--delete"
                              onClick={() => handleRemoveAttachment(att.id)}
                              title="Remove attachment"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            </div>
          </div>

          <div className="qm-modal-footer qm-studio-footer">
            <span className="qm-studio-footer-note">
              <span>
                Settings apply to code <strong>{activeQuizDraft.quizCode || '—'}</strong>
              </span>
              {activeQuizDraft.quizCode.trim().length > 0 &&
                quizzes.some(
                  (q) =>
                    q.id !== activeQuizDraft.id &&
                    q.quizCode.trim().toUpperCase() === activeQuizDraft.quizCode.trim().toUpperCase()
                ) && (
                  <span className="qm-studio-footer-warn">
                    • ⚠️ Duplicate code in use
                  </span>
                )}
            </span>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                type="button"
                className="qm-btn qm-btn-secondary"
                disabled={isSavingConfig}
                onClick={() => {
                  if (isSavingConfigRef.current) return;
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
                disabled={isSavingConfig}
                onClick={handleSaveQuizConfig}
              >
                {isSavingConfig ? 'Saving...' : originalQuizCode ? 'Save Changes' : 'Save & Publish Exam'}
              </button>
            </div>
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
                        {t.header_config?.subject || t.primarySubject || 'General'} • {t.total_marks || 0} marks • {t.question_ids?.length || 0} questions
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
          quizzes={proctorModalQuizzes}
          initialFocusQuizCode={selectedQuizForProctor.quizCode}
          onClose={() => setSelectedQuizForProctor(null)}
        />
      )}
      {isSchoolProctorOpen && !selectedQuizForProctor && (
        <LiveInvigilatorModal
          quizzes={activeExamQuizzes}
          onClose={() => setIsSchoolProctorOpen(false)}
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

      {/* Candidate Desk Card Print Modal */}
      <CandidateCardPrintModal
        isOpen={isPrintDeskCardsOpen}
        onClose={() => setIsPrintDeskCardsOpen(false)}
      />

      {/* Semester Exam Day Organizer Modal */}
      <SemesterDayOrganizerModal
        isOpen={isDayOrganizerOpen}
        onClose={() => setIsDayOrganizerOpen(false)}
        quizzes={quizzes}
        scheduleEntries={schoolScheduleEntries}
        nowMs={nowMs}
        onQuizzesChanged={(next) => setQuizzes(sanitizePublishedQuizList(next))}
        onNotify={(type, message) => {
          if (type === 'success') {
            setSaveWarningMsg(null);
            setSaveSuccessMsg(message);
            setTimeout(() => setSaveSuccessMsg(null), 5500);
          } else {
            setSaveSuccessMsg(null);
            setSaveWarningMsg(message);
            setTimeout(() => setSaveWarningMsg(null), 8000);
          }
        }}
      />
    </div>
  );
}
