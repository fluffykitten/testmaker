import { useState } from 'react';
import './PortalLandingPage.css';

interface PortalLandingPageProps {
  onJoinQuiz: (code: string) => void;
  onEnterTeacherSuite: () => void;
}

export function PortalLandingPage({
  onJoinQuiz,
  onEnterTeacherSuite,
}: PortalLandingPageProps) {
  const [quizCodeInput, setQuizCodeInput] = useState('');
  const [codeError, setCodeError] = useState('');

  const handleJoin = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = quizCodeInput.trim().toUpperCase();
    if (!clean) {
      setCodeError('Please enter a Quiz Code or Test ID.');
      return;
    }
    setCodeError('');
    onJoinQuiz(clean);
  };

  return (
    <div className="portal-root animate-fade-in">
      {/* Background Glows */}
      <div className="portal-glow portal-glow--1" />
      <div className="portal-glow portal-glow--2" />

      {/* Main Container */}
      <div className="portal-content animate-scale-up">
        {/* Brand Header */}
        <header className="portal-brand-header">
          <div className="portal-avatar-wrap">
            <img src="/avatar.jpg" alt="fluffykitten" className="portal-cat-avatar" />
            <span className="portal-online-dot" />
          </div>
          <h1 className="portal-title">fluffykitten's test maker</h1>
          <p className="portal-subtitle">
            Complete Examination Creation & Interactive Student Assessment Suite
          </p>
        </header>

        {/* Dual Portal Cards Grid */}
        <div className="portal-cards-grid">
          {/* Card 1: Student Quiz Portal */}
          <div className="portal-card portal-card--student">
            <div className="portal-card-badge portal-card-badge--student">FOR STUDENTS</div>
            <div className="portal-card-icon-wrap portal-card-icon--student">
              🎓
            </div>
            <h2 className="portal-card-heading">Interactive Quiz Portal</h2>
            <p className="portal-card-desc">
              Join your teacher's online assessment or practice test. Complete with timer, math formulas, and instant score reports.
            </p>

            <form onSubmit={handleJoin} className="portal-quiz-form">
              <div className="portal-input-group">
                <label className="portal-input-label">Enter Quiz Code / Token:</label>
                <div className="portal-input-inner">
                  <span className="portal-input-icon">🔑</span>
                  <input
                    type="text"
                    className="portal-code-input"
                    placeholder="e.g. CHEM-101 or TEST-839"
                    value={quizCodeInput}
                    onChange={(e) => {
                      setQuizCodeInput(e.target.value.toUpperCase());
                      if (codeError) setCodeError('');
                    }}
                    maxLength={36}
                    autoFocus
                  />
                </div>
                {codeError && <span className="portal-error-text">{codeError}</span>}
              </div>

              <button type="submit" className="portal-btn portal-btn--student">
                🚀 Start Interactive Quiz
              </button>
            </form>

            <div className="portal-card-footer-note">
              <span>💡</span> No account needed. Just enter the code given by your teacher.
            </div>
          </div>

          {/* Card 2: Teacher Suite */}
          <div className="portal-card portal-card--teacher" onClick={onEnterTeacherSuite}>
            <div className="portal-card-badge portal-card-badge--teacher">FOR TEACHERS</div>
            <div className="portal-card-icon-wrap portal-card-icon--teacher">
              🧑‍🏫
            </div>
            <h2 className="portal-card-heading">Teacher Test Maker</h2>
            <p className="portal-card-desc">
              Extract questions from past papers, assemble custom tests, generate Cambridge layouts, and export to Word, PDF, or LMS.
            </p>

            <div className="portal-teacher-features-list">
              <div className="feature-pill">📂 Past Paper PDF Extractor</div>
              <div className="feature-pill">⚡ Smart Test Auto-Assembler</div>
              <div className="feature-pill">🏛️ Cambridge & Worksheet Layouts</div>
              <div className="feature-pill">🔑 Teacher Mark Schemes & Solutions</div>
            </div>

            <button type="button" className="portal-btn portal-btn--teacher">
              🔒 Enter Teacher Suite (PIN Protected)
            </button>

            <div className="portal-card-footer-note">
              <span>🛡️</span> Protected with your 6-digit administrator PIN.
            </div>
          </div>
        </div>

        {/* Footer info */}
        <footer className="portal-footer">
          <span>fluffykitten AI Assessment Platform</span> • <span>Version 2.4</span> • <span>Powered by Supabase & Gemini</span>
        </footer>
      </div>
    </div>
  );
}
