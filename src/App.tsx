import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { PinGate } from './components/PinGate';
import { OnboardingTutorial } from './components/OnboardingTutorial';
import { SettingsModal } from './components/SettingsModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import {
  getSavedSettings,
  applySettings,
  loadAndSyncSchoolClasses,
  loadAndSyncGoogleDriveClientId,
} from './lib/settings';
import { PortalLandingPage } from './pages/PortalLandingPage';
import { resolveStudentQuiz } from './services/quizCodeService';
import type { PublishedQuiz } from './services/quizManagerService';
import { supabase } from './lib/supabase';
import type { Question, CustomTest } from './types/database';
import { getLocalTests, type ExamHeaderConfig } from './services/testBuilderService';
import { useMobileLifecycle } from './hooks/useMobileLifecycle';
import { initAutoBackupPeriodicScheduler } from './services/autoBackupService';
import { ICM_LOGO_PATH, CAMBRIDGE_LOGO_PATH } from './assets/logoConstants';
import './App.css';

// Lazy-load secondary and teacher pages for rapid initial load & minimal bundle size
const UploadPage = lazy(() => import('./pages/UploadPage').then((m) => ({ default: m.UploadPage })));
const QuestionBankPage = lazy(() => import('./pages/QuestionBankPage').then((m) => ({ default: m.QuestionBankPage })));
const TestBuilderPage = lazy(() => import('./pages/TestBuilderPage').then((m) => ({ default: m.TestBuilderPage })));
const SavedTestsPage = lazy(() => import('./pages/SavedTestsPage').then((m) => ({ default: m.SavedTestsPage })));
const QuizManagerPage = lazy(() => import('./pages/QuizManagerPage').then((m) => ({ default: m.QuizManagerPage })));
const StudentQuizRunner = lazy(() => import('./pages/StudentQuizRunner').then((m) => ({ default: m.StudentQuizRunner })));
const GameQuizRunner = lazy(() => import('./pages/GameQuizRunner').then((m) => ({ default: m.GameQuizRunner })));
const GameHostController = lazy(() => import('./pages/GameHostController').then((m) => ({ default: m.GameHostController })));
const AdvancedSettingsPage = lazy(() => import('./pages/AdvancedSettingsPage').then((m) => ({ default: m.AdvancedSettingsPage })));

function PageLoadingFallback() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '50vh',
        gap: '1rem',
        color: 'var(--color-text-secondary, #94a3b8)',
      }}
    >
      <div
        style={{
          width: '36px',
          height: '36px',
          border: '3px solid rgba(99, 102, 241, 0.15)',
          borderTopColor: 'var(--color-primary-500, #6366f1)',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }}
      />
      <span style={{ fontSize: '0.875rem', fontWeight: 500, letterSpacing: '0.025em' }}>
        Loading module…
      </span>
    </div>
  );
}

export type Page = 'home' | 'bank' | 'builder' | 'saved' | 'quizzes' | 'upload' | 'advanced_settings';
export type AppMode = 'portal' | 'teacher' | 'student_quiz' | 'game_host';

function App() {
  const [appMode, setAppMode] = useState<AppMode>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('quiz') || params.get('code')) return 'student_quiz';
    return 'portal';
  });

  const [activeQuizCode, setActiveQuizCode] = useState<string>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('quiz') || params.get('code') || '';
  });

  const [testRunQuestions, setTestRunQuestions] = useState<Question[] | undefined>();
  const [testRunHeaderConfig, setTestRunHeaderConfig] = useState<ExamHeaderConfig | undefined>();
  const [testRunInitialMode, setTestRunInitialMode] = useState<'exam' | 'game'>('exam');

  // Live Game Host State
  const [activeGameHostQuiz, setActiveGameHostQuiz] = useState<PublishedQuiz | null>(null);
  const [activeGameHostQuestions, setActiveGameHostQuestions] = useState<Question[]>([]);

  const [currentPage, setCurrentPage] = useState<Page>(() => {
    const params = new URLSearchParams(window.location.search);
    if (
      params.get('page') === 'advanced-settings' ||
      params.get('page') === 'advanced' ||
      window.location.hash === '#advanced-settings'
    ) {
      return 'advanced_settings';
    }
    return 'home';
  });
  const [selectedQuestions, setSelectedQuestions] = useState<Map<string, Question>>(() => {
    try {
      const saved = sessionStorage.getItem('testmaker_selected_questions');
      if (saved) {
        const parsed: Question[] = JSON.parse(saved);
        const map = new Map<string, Question>();
        parsed.forEach((q) => map.set(q.id, q));
        return map;
      }
    } catch {
      // ignore
    }
    return new Map();
  });
  const [tutorialRestartSignal, setTutorialRestartSignal] = useState(0);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Mobile lifecycle & hardware back-button integration
  useMobileLifecycle();

  // Initialize and apply user appearance preferences & background backup scheduler
  useEffect(() => {
    applySettings(getSavedSettings());
    initAutoBackupPeriodicScheduler();
    loadAndSyncSchoolClasses().catch(() => {});
    loadAndSyncGoogleDriveClientId().catch(() => {});
  }, []);

  // Sync selected questions to sessionStorage
  useEffect(() => {
    try {
      sessionStorage.setItem(
        'testmaker_selected_questions',
        JSON.stringify(Array.from(selectedQuestions.values()))
      );
    } catch {
      // ignore
    }
  }, [selectedQuestions]);

  const handleToggleSelectQuestion = (question: Question) => {
    setSelectedQuestions((prev) => {
      const next = new Map(prev);
      if (next.has(question.id)) {
        next.delete(question.id);
      } else {
        next.set(question.id, question);
      }
      return next;
    });
  };

  const handleAddMultipleQuestionsToTest = (questionsToAdd: Question[]) => {
    setSelectedQuestions((prev) => {
      const next = new Map(prev);
      questionsToAdd.forEach((q) => next.set(q.id, q));
      return next;
    });
  };

  const handleRemoveQuestionFromTest = (questionId: string) => {
    setSelectedQuestions((prev) => {
      const next = new Map(prev);
      next.delete(questionId);
      return next;
    });
  };

  const handleRemoveQuestionsFromTest = (questionIds: string[]) => {
    setSelectedQuestions((prev) => {
      const next = new Map(prev);
      questionIds.forEach((id) => next.delete(id));
      return next;
    });
  };

  const handleUpdateTestQuestions = useCallback((newQuestions: Question[]) => {
    setSelectedQuestions((prev) => {
      const prevKeys = Array.from(prev.keys());
      const newKeys = newQuestions.map((q) => q.id);
      if (
        prevKeys.length === newKeys.length &&
        prevKeys.every((k, i) => k === newKeys[i]) &&
        Array.from(prev.values()).every((q, i) => q === newQuestions[i])
      ) {
        return prev;
      }
      const map = new Map<string, Question>();
      newQuestions.forEach((q) => map.set(q.id, q));
      return map;
    });
  }, []);

  const [builderLoadedHeaderConfig, setBuilderLoadedHeaderConfig] = useState<ExamHeaderConfig | undefined>();
  const [builderLoadedEditingTestId, setBuilderLoadedEditingTestId] = useState<string | undefined>();

  const handleClearSelection = () => {
    setSelectedQuestions(new Map());
  };

  const handleLoadTestIntoBuilder = (questions: Question[], headerConfig?: ExamHeaderConfig, testId?: string) => {
    const map = new Map<string, Question>();
    questions.forEach((q) => map.set(q.id, q));
    setSelectedQuestions(map);
    setBuilderLoadedHeaderConfig(headerConfig);
    setBuilderLoadedEditingTestId(testId);
    setCurrentPage('builder');
  };

  const handleLockApp = () => {
    sessionStorage.removeItem('testmaker_pin_verified');
    setAppMode('portal');
  };

  // ─── Security Feature 3: Inactivity Auto-Lock & Panic Lock for Teacher Suite ───
  useEffect(() => {
    if (appMode !== 'teacher') return;

    const settings = getSavedSettings();
    const lockMinutes = settings.autoLockMinutes ?? 15;
    const timeoutMs = lockMinutes * 60 * 1000;
    let lastActivityTime = Date.now();

    const recordActivity = () => {
      lastActivityTime = Date.now();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      recordActivity();
      // Panic lock shortcut: Ctrl+Shift+L
      if (e.ctrlKey && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
        e.preventDefault();
        handleLockApp();
      }
    };

    const events: (keyof WindowEventMap)[] = ['mousemove', 'mousedown', 'touchstart', 'scroll'];
    events.forEach((evt) => {
      window.addEventListener(evt, recordActivity, { passive: true });
    });
    window.addEventListener('keydown', handleKeyDown);

    // If autoLockMinutes > 0, check periodically for idle timeout
    let checkInterval: ReturnType<typeof setInterval> | null = null;
    if (lockMinutes > 0) {
      checkInterval = setInterval(() => {
        if (Date.now() - lastActivityTime >= timeoutMs) {
          handleLockApp();
        }
      }, 15000);
    }

    return () => {
      events.forEach((evt) => {
        window.removeEventListener(evt, recordActivity);
      });
      window.removeEventListener('keydown', handleKeyDown);
      if (checkInterval) clearInterval(checkInterval);
    };
  }, [appMode]);

  const selectedIds = new Set(selectedQuestions.keys());
  const selectedCount = selectedQuestions.size;
  const questionsList = Array.from(selectedQuestions.values());

  // ─── Route 1: Portal Landing Page (Student Quiz Code vs Teacher Suite) ───────
  if (appMode === 'portal') {
    return (
      <PortalLandingPage
        onJoinQuiz={(code) => {
          setActiveQuizCode(code);
          setTestRunInitialMode('exam');
          setAppMode('student_quiz');
        }}
        onEnterTeacherSuite={() => setAppMode('teacher')}
      />
    );
  }

  // ─── Route 2: Student Interactive Quiz Runner (Automatic Exam vs Game Mode) ───
  if (appMode === 'student_quiz') {
    return (
      <ErrorBoundary onReset={() => setAppMode('portal')}>
        <StudentQuizDispatcher
          codeOrId={activeQuizCode}
          initialQuestions={testRunQuestions}
          initialHeaderConfig={testRunHeaderConfig}
          initialMode={testRunInitialMode}
          onExit={() => {
            setAppMode('portal');
            setActiveQuizCode('');
            setTestRunQuestions(undefined);
            setTestRunHeaderConfig(undefined);
            window.history.replaceState({}, '', window.location.pathname);
          }}
        />
      </ErrorBoundary>
    );
  }

  // ─── Route 3: Teacher Game Host Session (Multiplayer Dashboard) ─────────────
  if (appMode === 'game_host' && activeGameHostQuiz) {
    return (
      <Suspense fallback={<PageLoadingFallback />}>
        <GameHostController
          quiz={activeGameHostQuiz}
          questions={activeGameHostQuestions}
          onExit={() => {
            setAppMode('teacher');
            setActiveGameHostQuiz(null);
            setActiveGameHostQuestions([]);
          }}
        />
      </Suspense>
    );
  }

  // ─── Route 3: Teacher Test Maker Suite (Protected by 6-Digit PIN) ───────────
  return (
    <PinGate onBackToPortal={() => setAppMode('portal')}>
      <div className="app-root">
        {/* ─── Onboarding Tutorial ─────────────────────────────────────────────── */}
        <OnboardingTutorial restartSignal={tutorialRestartSignal} />

        {/* ─── Settings Modal ─────────────────────────────────────────────────── */}
        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          onRestartTutorial={() => {
            setTutorialRestartSignal((s) => s + 1);
            setIsSettingsOpen(false);
          }}
          onLockApp={handleLockApp}
          onOpenAdvancedSettings={() => {
            setIsSettingsOpen(false);
            setCurrentPage('advanced_settings');
          }}
        />

        {/* ─── Navigation ─────────────────────────────────────────────────────── */}
        <nav className="navbar">
          <div className="navbar-inner">
            <div
              className="nav-logo"
              onClick={() => setCurrentPage('home')}
              id="nav-home"
              style={{ cursor: 'pointer' }}
              title="Return to Dashboard"
            >
              <img src={ICM_LOGO_PATH} alt="ICM" className="nav-logo-img" />
            </div>

            <div className="nav-center">
              <button
                className={`nav-tab ${currentPage === 'bank' ? 'nav-tab--active' : ''}`}
                onClick={() => setCurrentPage('bank')}
                id="nav-bank"
              >
                <svg className="nav-tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <ellipse cx="12" cy="5" rx="9" ry="3"/>
                  <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
                  <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
                </svg>
                <span>Question Bank</span>
              </button>
              <button
                className={`nav-tab ${currentPage === 'builder' ? 'nav-tab--active' : ''}`}
                onClick={() => setCurrentPage('builder')}
                id="nav-builder"
              >
                <svg className="nav-tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 20h9"/>
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                </svg>
                <span>Test Builder</span>
                {selectedCount > 0 && (
                  <span className="nav-tab-badge">{selectedCount}</span>
                )}
              </button>
              <button
                className={`nav-tab ${currentPage === 'saved' ? 'nav-tab--active' : ''}`}
                onClick={() => setCurrentPage('saved')}
                id="nav-saved"
              >
                <svg className="nav-tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                </svg>
                <span>Saved Tests</span>
              </button>
              <button
                className={`nav-tab ${currentPage === 'quizzes' ? 'nav-tab--active' : ''}`}
                onClick={() => setCurrentPage('quizzes')}
                id="nav-quizzes"
              >
                <svg className="nav-tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="22" y1="2" x2="11" y2="13"/>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
                <span>Publish Exam</span>
              </button>
              <button
                className={`nav-tab ${currentPage === 'upload' ? 'nav-tab--active' : ''}`}
                onClick={() => setCurrentPage('upload')}
                id="nav-upload"
              >
                <svg className="nav-tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
                <span>Upload Papers</span>
              </button>
            </div>

            <div className="nav-right">
              <button
                type="button"
                className="nav-portal-switch-btn"
                onClick={() => setAppMode('portal')}
                title="Switch to Student Quiz Portal"
              >
                <span>🎓 Student Portal</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                  <polyline points="15 3 21 3 21 9"/>
                  <line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
              </button>

              <div className="nav-divider" />

              <button
                type="button"
                className="nav-settings-btn"
                onClick={() => setIsSettingsOpen(true)}
                title="Settings & Appearance"
                aria-label="Settings"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
                </svg>
              </button>
            </div>
          </div>
        </nav>

        {/* ─── Page Content ───────────────────────────────────────────────────── */}
        <ErrorBoundary>
          <Suspense fallback={<PageLoadingFallback />}>
            {currentPage === 'home' && (
              <HomePage
                onNavigate={setCurrentPage}
                selectedCount={selectedCount}
              />
            )}
            {currentPage === 'bank' && (
              <QuestionBankPage
                selectedQuestionIds={selectedIds}
                onToggleSelectQuestion={handleToggleSelectQuestion}
                onAddQuestionsToTest={handleAddMultipleQuestionsToTest}
                onClearSelection={handleClearSelection}
                onRemoveQuestionsFromTest={handleRemoveQuestionsFromTest}
                onNavigateToUpload={() => setCurrentPage('upload')}
                onNavigateToBuilder={() => setCurrentPage('builder')}
              />
            )}
            {currentPage === 'builder' && (
              <TestBuilderPage
                initialQuestions={questionsList}
                initialHeaderConfig={builderLoadedHeaderConfig}
                initialTestId={builderLoadedEditingTestId}
                onClearLoadedState={() => {
                  setBuilderLoadedHeaderConfig(undefined);
                  setBuilderLoadedEditingTestId(undefined);
                }}
                onRemoveQuestion={handleRemoveQuestionFromTest}
                onUpdateQuestions={handleUpdateTestQuestions}
                onNavigateToBank={() => setCurrentPage('bank')}
                onLaunchTestRun={(questions, headerConfig) => {
                  setTestRunQuestions(questions);
                  setTestRunHeaderConfig(headerConfig);
                  setTestRunInitialMode('exam');
                  setAppMode('student_quiz');
                }}
                onLaunchGameRun={getSavedSettings().enableQuizizzMode ? (questions, headerConfig) => {
                  setTestRunQuestions(questions);
                  setTestRunHeaderConfig(headerConfig);
                  setTestRunInitialMode('game');
                  setAppMode('student_quiz');
                } : undefined}
              />
            )}
            {currentPage === 'saved' && (
              <SavedTestsPage
                onLoadTestIntoBuilder={handleLoadTestIntoBuilder}
                onNavigateToBuilder={() => setCurrentPage('builder')}
                onNavigateToBank={() => setCurrentPage('bank')}
                onNavigateToQuizzes={() => setCurrentPage('quizzes')}
              />
            )}
            {currentPage === 'quizzes' && (
              <QuizManagerPage
                onLaunchTestRun={(questions, headerConfig) => {
                  setTestRunQuestions(questions);
                  setTestRunHeaderConfig(headerConfig);
                  setAppMode('student_quiz');
                }}
                onLaunchGameHost={getSavedSettings().enableQuizizzMode ? (quiz, questions) => {
                  setActiveGameHostQuiz(quiz);
                  setActiveGameHostQuestions(questions);
                  setAppMode('game_host');
                } : undefined}
                onNavigateToBuilder={() => setCurrentPage('builder')}
                onNavigateToSaved={() => setCurrentPage('saved')}
              />
            )}
            {currentPage === 'upload' && (
              <UploadPage
                onBuildTest={async (ids) => {
                  try {
                    const { fetchQuestionsByIds } = await import('./services/quizCodeService');
                    const fetched = await fetchQuestionsByIds(ids);
                    if (fetched && fetched.length > 0) {
                      handleAddMultipleQuestionsToTest(fetched);
                      setCurrentPage('builder');
                    }
                  } catch (e) {
                    console.error('Failed to load questions for test builder', e);
                  }
                }}
              />
            )}
            {currentPage === 'advanced_settings' && (
              <AdvancedSettingsPage
                onBack={() => setCurrentPage('home')}
              />
            )}
          </Suspense>
        </ErrorBoundary>

        {/* ─── Footer ─────────────────────────────────────────────────────────── */}
        <footer className="app-footer">
          <div className="app-footer-inner">
            <div className="footer-institution">
              <div className="footer-logos">
                <div className="footer-logo-card" title="Insan Cendekia Madani">
                  <img src={ICM_LOGO_PATH} alt="ICM" className="footer-logo-img" />
                </div>
                <div className="footer-logo-card" title="Cambridge Assessment International Education">
                  <img src={CAMBRIDGE_LOGO_PATH} alt="Cambridge Assessment" className="footer-logo-img" />
                </div>
              </div>
              <div className="footer-details">
                <div className="footer-brand-title">ICM Exam Platform</div>
                <div className="footer-brand-desc">
                  Insan Cendekia Madani • Cambridge International School
                </div>
              </div>
            </div>
          </div>
        </footer>
      </div>
    </PinGate>
  );
}

// ─── Home / Dashboard Page ─────────────────────────────────────────────────────

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good Morning, Teacher';
  if (hour < 18) return 'Good Afternoon, Teacher';
  return 'Good Evening, Teacher';
}

interface HomePageProps {
  onNavigate: (page: Page) => void;
  selectedCount: number;
}

function HomePage({ onNavigate, selectedCount }: HomePageProps) {
  const [stats, setStats] = useState({
    totalQuestions: 0,
    savedTests: 0,
    quizzes: 0,
    bookmarks: 0,
  });
  const [recentTests, setRecentTests] = useState<CustomTest[]>([]);

  useEffect(() => {
    async function loadStats() {
      try {
        // Fetch total question count from Supabase
        const { count } = await supabase
          .from('questions')
          .select('*', { count: 'exact', head: true });

        // Fetch local saved tests from testBuilderService
        const localTests = getLocalTests();
        setRecentTests(localTests.slice(0, 4));

        let quizzesCount = 0;
        const quizzesRaw = localStorage.getItem('fluffykitten_published_quizzes');
        if (quizzesRaw) {
          try {
            quizzesCount = JSON.parse(quizzesRaw).length;
          } catch {
            quizzesCount = 0;
          }
        }
        if (quizzesCount === 0) {
          try {
            const { data: cloudCfg } = await (supabase.from('app_config' as any) as any)
              .select('value')
              .eq('key', 'published_quizzes')
              .maybeSingle();
            if (cloudCfg?.value) {
              const parsed = JSON.parse(cloudCfg.value);
              if (Array.isArray(parsed)) quizzesCount = parsed.length;
            }
          } catch {
            // ignore fallback error
          }
        }

        const bookmarksRaw = localStorage.getItem('fluffykitten_bookmarked_questions');
        const bookmarksCount = bookmarksRaw ? JSON.parse(bookmarksRaw).length : 0;

        setStats({
          totalQuestions: count || 0,
          savedTests: localTests.length,
          quizzes: quizzesCount,
          bookmarks: bookmarksCount,
        });
      } catch (err) {
        console.error('Failed to load dashboard stats:', err);
      }
    }
    loadStats();
  }, []);

  const greeting = getGreeting();
  const dateFormatted = new Date().toLocaleDateString('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  return (
    <div className="dash-container animate-fade-in">
      {/* ─── Top Greeting & Compact Stats Header ─── */}
      <header className="dash-header">
        <div className="dash-greeting-wrap">
          <div className="dash-accent-bar" />
          <div>
            <h1 className="dash-title">{greeting}</h1>
            <p className="dash-date">
              {dateFormatted} <span className="dash-sep">•</span> Insan Cendekia Madani Assessment Workspace
            </p>
          </div>
        </div>

        {/* Compact Horizontal KPI Pills */}
        <div className="dash-stats-ribbon">
          <button
            type="button"
            className="dash-stat-pill"
            onClick={() => onNavigate('bank')}
            title="Open Question Bank"
          >
            <span className="dash-stat-dot dash-stat-dot--blue" />
            <span className="dash-stat-val">
              {stats.totalQuestions > 0 ? stats.totalQuestions.toLocaleString() : '150+'}
            </span>
            <span className="dash-stat-label">Questions</span>
          </button>

          <button
            type="button"
            className="dash-stat-pill"
            onClick={() => onNavigate('saved')}
            title="Open Saved Tests"
          >
            <span className="dash-stat-dot dash-stat-dot--green" />
            <span className="dash-stat-val">{stats.savedTests}</span>
            <span className="dash-stat-label">Test Papers</span>
          </button>

          <button
            type="button"
            className="dash-stat-pill"
            onClick={() => onNavigate('quizzes')}
            title="Manage Published Exams"
          >
            <span className="dash-stat-dot dash-stat-dot--amber" />
            <span className="dash-stat-val">{stats.quizzes}</span>
            <span className="dash-stat-label">Live Exams</span>
          </button>

          <button
            type="button"
            className="dash-stat-pill"
            onClick={() => onNavigate('bank')}
            title="View Bookmarked Questions"
          >
            <span className="dash-stat-dot dash-stat-dot--purple" />
            <span className="dash-stat-val">{stats.bookmarks}</span>
            <span className="dash-stat-label">Bookmarked</span>
          </button>
        </div>
      </header>

      {/* ─── Main Workspace Split (Option 2) ─── */}
      <div className="dash-grid">
        {/* Left Column: Launchpad Workflows */}
        <div className="dash-col-left">
          <div className="dash-section-header">
            <div>
              <h2 className="dash-section-title">Launchpad</h2>
              <span className="dash-section-subtitle">Operational Workflows</span>
            </div>
          </div>

          <div className="dash-launch-grid">
            {/* Tile 1: Question Bank */}
            <button
              type="button"
              className="dash-launch-card dash-launch-card--bank"
              onClick={() => onNavigate('bank')}
              id="dash-launch-bank"
            >
              <div className="dash-launch-icon-wrap dash-launch-icon-wrap--blue">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <ellipse cx="12" cy="5" rx="9" ry="3"/>
                  <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
                  <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
                </svg>
              </div>
              <div className="dash-launch-meta">
                <h3 className="dash-launch-name">Question Bank</h3>
                <p className="dash-launch-desc">Search, filter & organize questions with formula support</p>
              </div>
              <span className="dash-launch-arrow">→</span>
            </button>

            {/* Tile 2: Test Builder */}
            <button
              type="button"
              className="dash-launch-card dash-launch-card--builder"
              onClick={() => onNavigate('builder')}
              id="dash-launch-builder"
            >
              <div className="dash-launch-icon-wrap dash-launch-icon-wrap--green">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9"/>
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                </svg>
              </div>
              <div className="dash-launch-meta">
                <div className="dash-launch-title-row">
                  <h3 className="dash-launch-name">Test Builder</h3>
                  {selectedCount > 0 && (
                    <span className="dash-launch-badge">{selectedCount} queued</span>
                  )}
                </div>
                <p className="dash-launch-desc">Assemble exams with live mark balancing & preview</p>
              </div>
              <span className="dash-launch-arrow">→</span>
            </button>

            {/* Tile 3: Publish Exam */}
            <button
              type="button"
              className="dash-launch-card"
              onClick={() => onNavigate('quizzes')}
              id="dash-launch-publish"
            >
              <div className="dash-launch-icon-wrap dash-launch-icon-wrap--slate">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13"/>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
              </div>
              <div className="dash-launch-meta">
                <h3 className="dash-launch-name">Publish Exam</h3>
                <p className="dash-launch-desc">Schedule live assessments, access codes & gradebooks</p>
              </div>
              <span className="dash-launch-arrow">→</span>
            </button>

            {/* Tile 4: Upload Past Papers */}
            <button
              type="button"
              className="dash-launch-card"
              onClick={() => onNavigate('upload')}
              id="dash-launch-upload"
            >
              <div className="dash-launch-icon-wrap dash-launch-icon-wrap--slate">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                  <polyline points="17 8 12 3 7 8"/>
                  <line x1="12" y1="3" x2="12" y2="15"/>
                </svg>
              </div>
              <div className="dash-launch-meta">
                <h3 className="dash-launch-name">Upload Papers</h3>
                <p className="dash-launch-desc">Extract questions and diagrams directly from PDF exam files</p>
              </div>
              <span className="dash-launch-arrow">→</span>
            </button>
          </div>
        </div>

        {/* Right Column: Recent Test Papers */}
        <div className="dash-col-right">
          <div className="dash-section-header">
            <div>
              <h2 className="dash-section-title">Recent Test Papers</h2>
              <span className="dash-section-subtitle">Saved Drafts & Assessment Papers</span>
            </div>
            {recentTests.length > 0 && (
              <button
                type="button"
                className="dash-view-all-btn"
                onClick={() => onNavigate('saved')}
              >
                View All Saved ({stats.savedTests}) →
              </button>
            )}
          </div>

          <div className="dash-recent-card">
            {recentTests.length > 0 ? (
              <div className="dash-recent-list">
                {recentTests.map((test, index) => {
                  const title = test.title || test.header_config?.title || `Assessment Paper #${index + 1}`;
                  const qCount = Array.isArray(test.question_ids) ? test.question_ids.length : 0;
                  const marks = test.total_marks || 0;
                  const dateStr = test.created_at ? new Date(test.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'Recent';

                  return (
                    <div key={test.id || index} className="dash-recent-item">
                      <div className="dash-recent-icon">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                          <polyline points="14 2 14 8 20 8"/>
                          <line x1="16" y1="13" x2="8" y2="13"/>
                          <line x1="16" y1="17" x2="8" y2="17"/>
                          <polyline points="10 9 9 9 8 9"/>
                        </svg>
                      </div>

                      <div className="dash-recent-info">
                        <h4 className="dash-recent-name">{title}</h4>
                        <div className="dash-recent-tags">
                          <span>{qCount} Questions</span>
                          {marks > 0 && <span>• {marks} Marks</span>}
                          <span>• {dateStr}</span>
                        </div>
                      </div>

                      <button
                        type="button"
                        className="dash-recent-action-btn"
                        onClick={() => onNavigate('saved')}
                      >
                        Open Paper →
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="dash-empty-tests">
                <div className="dash-empty-icon">📝</div>
                <h4 className="dash-empty-title">No test papers created yet</h4>
                <p className="dash-empty-desc">
                  Assemble questions from the Question Bank into custom examination papers with automated mark balancing.
                </p>
                <button
                  type="button"
                  className="dash-empty-btn"
                  onClick={() => onNavigate('builder')}
                >
                  Create Your First Test →
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Student Quiz Dispatcher (Routes between Formal Exam and Quizizz Game) ───

interface StudentQuizDispatcherProps {
  codeOrId?: string;
  initialQuestions?: Question[];
  initialHeaderConfig?: ExamHeaderConfig;
  initialMode?: 'exam' | 'game';
  onExit: () => void;
}

function StudentQuizDispatcher({
  codeOrId,
  initialQuestions,
  initialHeaderConfig,
  initialMode = 'exam',
  onExit,
}: StudentQuizDispatcherProps) {
  const [resolvedMode, setResolvedMode] = useState<'exam' | 'game' | 'loading'>('loading');
  const [gameConfig, setGameConfig] = useState<any>(null);

  useEffect(() => {
    // If questions were passed directly (e.g. test-run from builder or simulation)
    if (initialQuestions && initialQuestions.length > 0) {
      setResolvedMode(initialMode || 'exam');
      return;
    }

    if (!codeOrId) {
      setResolvedMode(initialMode || 'exam');
      return;
    }

    let isMounted = true;
    const isQuizizzActive = Boolean(getSavedSettings().enableQuizizzMode);
    resolveStudentQuiz(codeOrId)
      .then((data) => {
        if (!isMounted) return;
        if (data?.quizMode === 'game' && isQuizizzActive) {
          setGameConfig(data);
          setResolvedMode('game');
        } else {
          setResolvedMode('exam');
        }
      })
      .catch(() => {
        if (isMounted) setResolvedMode('exam');
      });

    return () => {
      isMounted = false;
    };
  }, [codeOrId, initialQuestions, initialMode]);

  if (resolvedMode === 'loading') {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0f172a',
          color: '#f8fafc',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              width: '40px',
              height: '40px',
              border: '3px solid rgba(255,255,255,0.1)',
              borderTopColor: '#8b5cf6',
              borderRadius: '50%',
              animation: 'spin 1s linear infinite',
              margin: '0 auto 1rem',
            }}
          />
          <h2 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Connecting to Assessment...</h2>
        </div>
      </div>
    );
  }

  const isQuizizzActive = Boolean(getSavedSettings().enableQuizizzMode);

  if (resolvedMode === 'game' && isQuizizzActive) {
    return (
      <Suspense fallback={<PageLoadingFallback />}>
        <GameQuizRunner
          testIdOrCode={codeOrId}
          initialQuestions={initialQuestions}
          initialHeaderConfig={initialHeaderConfig}
          initialGameConfig={gameConfig}
          onExit={onExit}
        />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<PageLoadingFallback />}>
      <StudentQuizRunner
        testIdOrCode={codeOrId}
        initialQuestions={initialQuestions}
        initialHeaderConfig={initialHeaderConfig}
        onExit={onExit}
        onSwitchToGameMode={!codeOrId && isQuizizzActive ? () => setResolvedMode('game') : undefined}
      />
    </Suspense>
  );
}

export default App;



