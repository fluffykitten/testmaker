import { useState, useEffect } from 'react';
import { PinGate } from './components/PinGate';
import { OnboardingTutorial } from './components/OnboardingTutorial';
import { ConnectionStatus } from './components/ConnectionStatus';
import { SettingsModal } from './components/SettingsModal';
import { getSavedSettings, applySettings } from './lib/settings';
import { UploadPage } from './pages/UploadPage';
import { QuestionBankPage } from './pages/QuestionBankPage';
import { TestBuilderPage } from './pages/TestBuilderPage';
import { SavedTestsPage } from './pages/SavedTestsPage';
import type { Question } from './types/database';
import './App.css';

export type Page = 'home' | 'bank' | 'builder' | 'saved' | 'upload';

function App() {
  const [currentPage, setCurrentPage] = useState<Page>('home');
  const [selectedQuestions, setSelectedQuestions] = useState<Map<string, Question>>(new Map());
  const [tutorialRestartSignal, setTutorialRestartSignal] = useState(0);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

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
    window.location.reload();
  };

  const selectedIds = new Set(selectedQuestions.keys());
  const selectedCount = selectedQuestions.size;
  const questionsList = Array.from(selectedQuestions.values());

  return (
    <PinGate>
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
                className={`nav-tab ${currentPage === 'upload' ? 'nav-tab--active' : ''}`}
                onClick={() => setCurrentPage('upload')}
                id="nav-upload"
              >
                Upload Papers
              </button>
            </div>

            <div className="nav-right">
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
          />
        )}
        {currentPage === 'saved' && (
          <SavedTestsPage
            onLoadTestIntoBuilder={handleLoadTestIntoBuilder}
            onNavigateToBuilder={() => setCurrentPage('builder')}
            onNavigateToBank={() => setCurrentPage('bank')}
          />
        )}
        {currentPage === 'upload' && <UploadPage />}

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
  return (
    <main className="hero-section">
      <div className="hero-content animate-fade-in">
        <h1 className="hero-title">
          fluffykitten's
          <br />
          <span className="text-gradient">test maker</span>
        </h1>

        <p className="hero-description">
          Upload past papers, extract questions with AI, and craft custom exams
          with drag-and-drop ease. Filter by topic, paper, difficulty, and marks.
        </p>

        {/* Quick Actions */}
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
            Test Builder {selectedCount > 0 ? `(${selectedCount} questions)` : ''}
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

        {/* ─── Feature Showcase ──────────────────────────────────────────────── */}
        <div className="feature-grid">
          <FeatureCard
            icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
            title="Question Bank"
            description="Hundreds of exam questions organized by topic, difficulty, and year with powerful search and filters."
            accent="indigo"
          />
          <FeatureCard
            icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M12 16v-4M12 8h.01M22 12c0 5.523-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2s10 4.477 10 10z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            }
            title="AI Extraction"
            description="Upload PDF past papers and let AI extract questions, diagrams, mark schemes, and metadata automatically."
            accent="violet"
          />
          <FeatureCard
            icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M9 14l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
            title="Test Builder"
            description="Drag-and-drop questions into custom exams with live analytics, mark totals, and topic coverage stats."
            accent="emerald"
          />
          <FeatureCard
            icon={
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            }
            title="Export Engine"
            description="One-click export to Word (.docx) and PDF with professional formatting and teacher mark schemes."
            accent="amber"
          />
        </div>

        {/* Restart Tutorial Button */}
        <button className="tutorial-restart-btn" onClick={onRestartTutorial}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            <path d="M22 2v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Restart Tutorial
        </button>
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
  accent: 'indigo' | 'violet' | 'emerald' | 'amber';
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

export default App;
