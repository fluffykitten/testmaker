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
import type { Question } from './types/database';
import type { ExamHeaderConfig } from './services/testBuilderService';
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
                onRestartTutorial={() => setTutorialRestartSignal((s) => s + 1)}
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
                onLaunchGameRun={(questions, headerConfig) => {
                  setTestRunQuestions(questions);
                  setTestRunHeaderConfig(headerConfig);
                  setTestRunInitialMode('game');
                  setAppMode('student_quiz');
                }}
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
                onLaunchGameHost={(quiz, questions) => {
                  setActiveGameHostQuiz(quiz);
                  setActiveGameHostQuestions(questions);
                  setAppMode('game_host');
                }}
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
                <div className="footer-copyright">
                  Official Examination & Assessment Suite • Powered by Gemini AI & Supabase
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

interface HomePageProps {
  onNavigate: (page: Page) => void;
  selectedCount: number;
  onRestartTutorial: () => void;
}

function HomePage({ onNavigate, selectedCount, onRestartTutorial }: HomePageProps) {
  const [stats, setStats] = useState({
    totalQuestions: 0,
    savedTests: 0,
    quizzes: 0,
    bookmarks: 0,
  });

  useEffect(() => {
    async function loadStats() {
      try {
        // Fetch total question count from Supabase
        const { count } = await supabase
          .from('questions')
          .select('*', { count: 'exact', head: true });

        // Fetch local saved tests & quizzes
        const savedTestsRaw = localStorage.getItem('testmaker_saved_tests');
        const savedTestsCount = savedTestsRaw ? JSON.parse(savedTestsRaw).length : 0;

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
          savedTests: savedTestsCount,
          quizzes: quizzesCount,
          bookmarks: bookmarksCount,
        });
      } catch (err) {
        console.error('Failed to load dashboard stats:', err);
      }
    }
    loadStats();
  }, []);

  return (
    <main className="hero-section">
      <div className="hero-content animate-fade-in">
        {/* ─── Institutional Brand Showcase Banner ─── */}
        <div className="hero-brand-banner">
          <div className="hero-logo-card hero-logo-card--icm" title="Insan Cendekia Madani">
            <img src={ICM_LOGO_PATH} alt="Insan Cendekia Madani" className="hero-logo-img" />
          </div>

          <div className="hero-brand-divider">
            <div className="hero-brand-tag">
              <span className="hero-brand-dot" />
              <span>Official Examination & Assessment Suite</span>
            </div>
            <span className="hero-brand-subtag">Insan Cendekia Madani • Cambridge International School</span>
          </div>

          <div className="hero-logo-card hero-logo-card--cambridge" title="Cambridge Assessment International Education">
            <img src={CAMBRIDGE_LOGO_PATH} alt="Cambridge Assessment International Education" className="hero-logo-img" />
          </div>
        </div>

        {/* Top Header Badge */}
        <div className="hero-badge-pill">
          <span className="badge-sparkle">🏛️</span>
          <span>Cambridge Assessment & Secondary Examination Suite</span>
        </div>

        <h1 className="hero-title">
          <span className="hero-title-prefix">ICM</span>{' '}
          <span className="text-gradient">Exam Platform</span>
        </h1>

        <p className="hero-description">
          The unified examination authoring, AI paper ingestion, and proctored testing suite for <strong>Insan Cendekia Madani</strong>.
          Ingest Cambridge past papers with Gemini AI, build syllabus-aligned assessments with live KaTeX rendering,
          export standardized Word/PDF exam papers & examiner mark schemes, and execute secure proctored live examinations.
        </p>

        {/* ─── Live KPI Metrics Ribbon ─── */}
        <div className="hero-stats-ribbon">
          <div className="hero-stat-card" onClick={() => onNavigate('bank')} title="View Question Bank">
            <span className="stat-icon">📚</span>
            <div className="stat-info">
              <strong>{stats.totalQuestions > 0 ? stats.totalQuestions : '150+'}</strong>
              <span>Questions in Bank</span>
            </div>
          </div>

          <div className="hero-stat-card" onClick={() => onNavigate('saved')} title="View Custom Test Papers">
            <span className="stat-icon">📑</span>
            <div className="stat-info">
              <strong>{stats.savedTests}</strong>
              <span>Saved Test Papers</span>
            </div>
          </div>

          <div className="hero-stat-card" onClick={() => onNavigate('quizzes')} title="View Live Exam Sessions">
            <span className="stat-icon">🚀</span>
            <div className="stat-info">
              <strong>{stats.quizzes}</strong>
              <span>Live & Online Exams</span>
            </div>
          </div>

          <div className="hero-stat-card" onClick={() => onNavigate('bank')} title="View Starred Questions">
            <span className="stat-icon">⭐</span>
            <div className="stat-info">
              <strong>{stats.bookmarks}</strong>
              <span>Bookmarked Exemplars</span>
            </div>
          </div>
        </div>

        {/* ─── Quick Actions ─── */}
        <div className="hero-actions">
          <button
            className="hero-btn hero-btn--primary"
            onClick={() => onNavigate('bank')}
            id="hero-bank-btn"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M4 6h12M4 10h12M4 14h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Browse Question Bank
          </button>

          <button
            className="hero-btn hero-btn--secondary"
            onClick={() => onNavigate('builder')}
            id="hero-builder-btn"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M4 4h12v12H4z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <path d="M4 8h12M8 4v12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Test Builder {selectedCount > 0 ? `(${selectedCount})` : ''}
          </button>

          <button
            className="hero-btn hero-btn--secondary"
            onClick={() => onNavigate('saved')}
            id="hero-saved-btn"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M3 4a1 1 0 011-1h12a1 1 0 011 1v2a1 1 0 01-1 1H4a1 1 0 01-1-1V4zM3 10a1 1 0 011-1h12a1 1 0 011 1v6a1 1 0 01-1 1H4a1 1 0 01-1-1v-6z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
            Saved Test Papers
          </button>

          <button
            className="hero-btn hero-btn--quizzes"
            onClick={() => onNavigate('quizzes')}
            id="hero-quizzes-btn"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Interactive Live Exams
          </button>

          <button
            className="hero-btn hero-btn--secondary"
            onClick={() => onNavigate('upload')}
            id="hero-upload-btn"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
              <path d="M10 14V2M6 6l4-4 4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M3 13v4a2 2 0 002 2h10a2 2 0 002-2v-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Upload Past Papers
          </button>
        </div>

        {/* ─── 4-Step Cambridge Examination Pipeline ─── */}
        <div className="workflow-container">
          <div className="workflow-step" onClick={() => onNavigate('upload')}>
            <span className="step-num">1</span>
            <div className="step-content">
              <strong>Ingest Past Papers</strong>
              <p>Upload Cambridge PDF exams & mark schemes with Gemini AI diagram extraction</p>
            </div>
          </div>

          <div className="workflow-arrow">→</div>

          <div className="workflow-step" onClick={() => onNavigate('builder')}>
            <span className="step-num">2</span>
            <div className="step-content">
              <strong>Assemble & Balance</strong>
              <p>Balance AO1/AO2/AO3 marks, syllabus coverage, and generate AI variants</p>
            </div>
          </div>

          <div className="workflow-arrow">→</div>

          <div className="workflow-step" onClick={() => onNavigate('saved')}>
            <span className="step-num">3</span>
            <div className="step-content">
              <strong>Official Papers & Schemes</strong>
              <p>Export Word (.docx), printable PDF test papers, and comprehensive mark schemes</p>
            </div>
          </div>

          <div className="workflow-arrow">→</div>

          <div className="workflow-step" onClick={() => onNavigate('quizzes')}>
            <span className="step-num">4</span>
            <div className="step-content">
              <strong>Run Proctored Exams</strong>
              <p>Launch live online exams with anti-cheat lockdown and Excel gradebooks</p>
            </div>
          </div>
        </div>

        {/* ─── Feature Showcase (6 Core Capabilities) ─── */}
        <div className="feature-grid">
          <FeatureCard
            icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
            title="Question Bank & Formula Search"
            description="Browse exam questions by topic, difficulty, marks, and auto-expanding chemical formulas (H2SO4, KMnO4, \Delta H)."
            accent="indigo"
          />
          <FeatureCard
            icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M12 16v-4M12 8h.01M22 12c0 5.523-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2s10 4.477 10 10z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            }
            title="AI Ingestion Pipeline"
            description="Upload PDF past papers and let Gemini AI extract questions, diagrams, KaTeX equations, and mark schemes automatically."
            accent="violet"
          />
          <FeatureCard
            icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M9 14l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
            title="Test Builder & Live Analytics"
            description="Drag-and-drop questions into custom exams with live syllabus coverage, difficulty balance meters, and mark counters."
            accent="emerald"
          />
          <FeatureCard
            icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
            title="Word, PDF & Mark Schemes"
            description="One-click export to Word (.docx), student test PDFs, and Comprehensive Teacher Mark Schemes with examiner guidance."
            accent="amber"
          />
          <FeatureCard
            icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <rect x="2" y="3" width="20" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
                <path d="M8 21h8M12 17v4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            }
            title="Interactive Quizzes & Anti-Cheat"
            description="Run paperless exams with custom tokens, full-screen lockdown, Alt+Tab prevention, and proctoring violation logs."
            accent="cyan"
          />
          <FeatureCard
            icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M18 20V10M12 20V4M6 20v-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
            title="Excel Gradebooks & Audit Reports"
            description="Inspect question-by-question candidate answers and export native multi-sheet Excel (.xlsx) class gradebooks."
            accent="rose"
          />
        </div>

        {/* Restart Tutorial Button */}
        <div className="hero-footer-actions">
          <button className="tutorial-restart-btn" onClick={onRestartTutorial}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <path d="M22 2v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Restart Interactive Tutorial
          </button>
        </div>
      </div>

      {/* Background decoration */}
      <div className="hero-bg-glow" />
    </main>
  );
}

// ─── Feature Card Component ──────────────────────────────────────────────────

interface FeatureCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  accent: 'indigo' | 'violet' | 'emerald' | 'amber' | 'cyan' | 'rose';
}

function FeatureCard({ icon, title, description, accent }: FeatureCardProps) {
  return (
    <div className={`feature-card feature-card--${accent}`}>
      <div className={`feature-card-icon feature-card-icon--${accent}`}>
        {icon}
      </div>
      <h3 className="feature-card-title">{title}</h3>
      <p className="feature-card-desc">{description}</p>
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
    resolveStudentQuiz(codeOrId)
      .then((data) => {
        if (!isMounted) return;
        if (data?.quizMode === 'game') {
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

  if (resolvedMode === 'game') {
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
        onSwitchToGameMode={!codeOrId ? () => setResolvedMode('game') : undefined}
      />
    </Suspense>
  );
}

export default App;



