import { useState, useEffect } from 'react';
import { PinGate } from './components/PinGate';
import { OnboardingTutorial } from './components/OnboardingTutorial';
import { ConnectionStatus } from './components/ConnectionStatus';
import { SettingsModal } from './components/SettingsModal';
import { ErrorBoundary } from './components/ErrorBoundary';
import { getSavedSettings, applySettings } from './lib/settings';
import { UploadPage } from './pages/UploadPage';
import { QuestionBankPage } from './pages/QuestionBankPage';
import { TestBuilderPage } from './pages/TestBuilderPage';
import { SavedTestsPage } from './pages/SavedTestsPage';
import { QuizManagerPage } from './pages/QuizManagerPage';
import { PortalLandingPage } from './pages/PortalLandingPage';
import { StudentQuizRunner } from './pages/StudentQuizRunner';
import { GameQuizRunner } from './pages/GameQuizRunner';
import { GameHostController } from './pages/GameHostController';
import { resolveStudentQuiz } from './services/quizCodeService';
import type { PublishedQuiz } from './services/quizManagerService';
import { supabase } from './lib/supabase';
import type { Question } from './types/database';
import type { ExamHeaderConfig } from './services/testBuilderService';
import { useMobileLifecycle } from './hooks/useMobileLifecycle';
import './App.css';

export type Page = 'home' | 'bank' | 'builder' | 'saved' | 'quizzes' | 'upload';
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

  const [currentPage, setCurrentPage] = useState<Page>('home');
  const [selectedQuestions, setSelectedQuestions] = useState<Map<string, Question>>(new Map());
  const [tutorialRestartSignal, setTutorialRestartSignal] = useState(0);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Mobile lifecycle & hardware back-button integration
  useMobileLifecycle();

  // Initialize and apply user appearance preferences
  useEffect(() => {
    applySettings(getSavedSettings());
  }, []);

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

  const handleRemoveQuestionFromTest = (questionId: string) => {
    setSelectedQuestions((prev) => {
      const next = new Map(prev);
      next.delete(questionId);
      return next;
    });
  };

  const handleClearSelection = () => {
    setSelectedQuestions(new Map());
  };

  const handleLoadTestIntoBuilder = (questions: Question[]) => {
    const map = new Map<string, Question>();
    questions.forEach((q) => map.set(q.id, q));
    setSelectedQuestions(map);
    setCurrentPage('builder');
  };

  const handleLockApp = () => {
    sessionStorage.removeItem('testmaker_pin_verified');
    setAppMode('portal');
  };

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
      <StudentQuizDispatcher
        codeOrId={activeQuizCode}
        initialQuestions={testRunQuestions}
        initialHeaderConfig={testRunHeaderConfig}
        initialMode={testRunInitialMode}
        onExit={() => {
          setAppMode('portal');
          setTestRunQuestions(undefined);
          setTestRunHeaderConfig(undefined);
          window.history.replaceState({}, '', window.location.pathname);
        }}
      />
    );
  }

  // ─── Route 3: Teacher Game Host Session (Multiplayer Dashboard) ─────────────
  if (appMode === 'game_host' && activeGameHostQuiz) {
    return (
      <GameHostController
        quiz={activeGameHostQuiz}
        questions={activeGameHostQuestions}
        onExit={() => {
          setAppMode('teacher');
          setActiveGameHostQuiz(null);
          setActiveGameHostQuestions([]);
        }}
      />
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
        />

        {/* ─── Navigation ─────────────────────────────────────────────────────── */}
        <nav className="navbar">
          <div className="navbar-inner">
            <div className="nav-logo" onClick={() => setCurrentPage('home')} style={{ cursor: 'pointer' }}>
              <img src="/avatar.jpg" alt="fluffykitten" className="nav-cat-avatar" />
              <span className="nav-title">fluffykitten's test maker</span>
            </div>

            <div className="nav-center">
              <button
                className={`nav-tab ${currentPage === 'home' ? 'nav-tab--active' : ''}`}
                onClick={() => setCurrentPage('home')}
                id="nav-home"
              >
                Dashboard
              </button>
              <button
                className={`nav-tab ${currentPage === 'bank' ? 'nav-tab--active' : ''}`}
                onClick={() => setCurrentPage('bank')}
                id="nav-bank"
              >
                Question Bank
              </button>
              <button
                className={`nav-tab ${currentPage === 'builder' ? 'nav-tab--active' : ''}`}
                onClick={() => setCurrentPage('builder')}
                id="nav-builder"
              >
                Test Builder
                {selectedCount > 0 && (
                  <span className="nav-tab-badge">{selectedCount}</span>
                )}
              </button>
              <button
                className={`nav-tab ${currentPage === 'saved' ? 'nav-tab--active' : ''}`}
                onClick={() => setCurrentPage('saved')}
                id="nav-saved"
              >
                Saved Tests
              </button>
              <button
                className={`nav-tab ${currentPage === 'quizzes' ? 'nav-tab--active' : ''}`}
                onClick={() => setCurrentPage('quizzes')}
                id="nav-quizzes"
              >
                Interactive Quizzes
              </button>
              <button
                className={`nav-tab ${currentPage === 'upload' ? 'nav-tab--active' : ''}`}
                onClick={() => setCurrentPage('upload')}
                id="nav-upload"
              >
                Upload Papers
              </button>
            </div>

            <div className="nav-right">
              <button
                type="button"
                className="nav-portal-switch-btn"
                onClick={() => setAppMode('portal')}
                title="Switch to Student Quiz Portal"
              >
                🎓 Student Portal
              </button>

              <a
                href="https://github.com/fluffykitten"
                target="_blank"
                rel="noopener noreferrer"
                className="nav-creator-pill"
                title="Created by fluffykitten on GitHub"
              >
                <img src="/avatar.jpg" alt="fluffykitten" className="nav-creator-avatar" />
                <span className="nav-creator-name">fluffykitten</span>
              </a>

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

              <ConnectionStatus />
            </div>
          </div>
        </nav>

        {/* ─── Page Content ───────────────────────────────────────────────────── */}
        <ErrorBoundary>
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
              onClearSelection={handleClearSelection}
              onNavigateToUpload={() => setCurrentPage('upload')}
              onNavigateToBuilder={() => setCurrentPage('builder')}
            />
          )}
          {currentPage === 'builder' && (
            <TestBuilderPage
              initialQuestions={questionsList}
              onRemoveQuestion={handleRemoveQuestionFromTest}
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
          {currentPage === 'upload' && <UploadPage />}
        </ErrorBoundary>

        {/* ─── Footer ─────────────────────────────────────────────────────────── */}
        <footer className="app-footer">
          <div className="app-footer-inner">
            <a
              href="https://github.com/fluffykitten"
              target="_blank"
              rel="noopener noreferrer"
              className="footer-creator"
            >
              <img src="/avatar.jpg" alt="fluffykitten" className="footer-creator-avatar" />
              <span>Created with 🐱 by <strong>fluffykitten</strong></span>
              <span className="footer-github-tag">github.com/fluffykitten</span>
            </a>
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

        const quizzesRaw = localStorage.getItem('fluffykitten_published_quizzes');
        const quizzesCount = quizzesRaw ? JSON.parse(quizzesRaw).length : 0;

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
        {/* Top Header Badge */}
        <div className="hero-badge-pill">
          <span className="badge-sparkle">✨</span>
          <span>Next-Gen Cambridge & Science Assessment Suite</span>
        </div>

        <h1 className="hero-title">
          fluffykitten's
          <br />
          <span className="text-gradient">test maker</span>
        </h1>

        <p className="hero-description">
          Ingest past papers with AI, build differentiated assessments with live KaTeX rendering,
          export Word/PDF test papers & examiner mark schemes, and run anti-cheating live quizzes with Excel reports.
        </p>

        {/* ─── Live KPI Metrics Ribbon ─── */}
        <div className="hero-stats-ribbon">
          <div className="hero-stat-card" onClick={() => onNavigate('bank')}>
            <span className="stat-icon">📚</span>
            <div className="stat-info">
              <strong>{stats.totalQuestions > 0 ? stats.totalQuestions : '150+'}</strong>
              <span>Questions in Bank</span>
            </div>
          </div>

          <div className="hero-stat-card" onClick={() => onNavigate('saved')}>
            <span className="stat-icon">📑</span>
            <div className="stat-info">
              <strong>{stats.savedTests}</strong>
              <span>Saved Custom Tests</span>
            </div>
          </div>

          <div className="hero-stat-card" onClick={() => onNavigate('quizzes')}>
            <span className="stat-icon">🚀</span>
            <div className="stat-info">
              <strong>{stats.quizzes}</strong>
              <span>Live Quizzes</span>
            </div>
          </div>

          <div className="hero-stat-card" onClick={() => onNavigate('bank')}>
            <span className="stat-icon">⭐</span>
            <div className="stat-info">
              <strong>{stats.bookmarks}</strong>
              <span>Bookmarked Questions</span>
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
            Saved Tests
          </button>

          <button
            className="hero-btn hero-btn--quizzes"
            onClick={() => onNavigate('quizzes')}
            id="hero-quizzes-btn"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Interactive Quizzes
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
            Upload Papers
          </button>
        </div>

        {/* ─── 4-Step Workflow Visual Guide ─── */}
        <div className="workflow-container">
          <div className="workflow-step" onClick={() => onNavigate('upload')}>
            <span className="step-num">1</span>
            <div className="step-content">
              <strong>Ingest Past Papers</strong>
              <p>Upload PDF exams & mark schemes with Gemini AI diagram extraction</p>
            </div>
          </div>

          <div className="workflow-arrow">→</div>

          <div className="workflow-step" onClick={() => onNavigate('builder')}>
            <span className="step-num">2</span>
            <div className="step-content">
              <strong>Assemble & Differentiate</strong>
              <p>Drag-and-drop questions, balance marks, and generate AI variants</p>
            </div>
          </div>

          <div className="workflow-arrow">→</div>

          <div className="workflow-step" onClick={() => onNavigate('saved')}>
            <span className="step-num">3</span>
            <div className="step-content">
              <strong>Export Papers & Schemes</strong>
              <p>Download Word (.docx), PDF tests, and comprehensive examiner notes</p>
            </div>
          </div>

          <div className="workflow-arrow">→</div>

          <div className="workflow-step" onClick={() => onNavigate('quizzes')}>
            <span className="step-num">4</span>
            <div className="step-content">
              <strong>Run Anti-Cheat Quizzes</strong>
              <p>Launch live online exams with proctoring audit and Excel reports</p>
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
    // If questions were passed directly (e.g. test-run from builder)
    if (!codeOrId && initialQuestions) {
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
      <GameQuizRunner
        testIdOrCode={codeOrId}
        initialQuestions={initialQuestions}
        initialHeaderConfig={initialHeaderConfig}
        initialGameConfig={gameConfig}
        onExit={onExit}
      />
    );
  }

  return (
    <StudentQuizRunner
      testIdOrCode={codeOrId}
      initialQuestions={initialQuestions}
      initialHeaderConfig={initialHeaderConfig}
      onExit={onExit}
      onSwitchToGameMode={!codeOrId ? () => setResolvedMode('game') : undefined}
    />
  );
}

export default App;



