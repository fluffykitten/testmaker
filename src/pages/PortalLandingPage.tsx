import { useState, useEffect, useCallback } from 'react';
import {
  getDeviceReceipts,
  getPendingOutboxSubmissions,
  flushSubmissionOutbox,
  exportSubmissionToFile,
  type DeviceExamReceipt,
  type SubmissionOutboxItem,
} from '../services/quizSubmissionService';
import { StudentResultModal } from '../components/StudentResultModal';
import './PortalLandingPage.css';

interface PortalLandingPageProps {
  onJoinQuiz: (code: string) => void;
  onEnterTeacherSuite: () => void;
}

const PLATFORM_FEATURES = [
  {
    icon: '🤖',
    badge: 'AI-POWERED',
    badgeClass: 'badge--indigo',
    title: 'Past Paper AI Extractor & Cropper',
    desc: 'Upload PDF past papers to parse question stems, sub-questions, and mark schemes automatically. Precision diagram cropper isolates and attaches figures seamlessly.',
    highlights: ['Gemini PDF Parsing', 'Diagram Bounding Box Cropper', 'Automatic Mark Scheme Association'],
  },
  {
    icon: '🏛️',
    badge: 'CAMBRIDGE READY',
    badgeClass: 'badge--amber',
    title: 'Cambridge Exam Layouts & Tools',
    desc: 'Generate authentic Cambridge cover pages, syllabus codes, and dotted answer lines. Built-in upright IGCSE Periodic Table drawer, Scientific Calculator, and Resource Booklets.',
    highlights: ['Official Cambridge Covers', 'Upright Periodic Table Drawer', 'On-Screen Scientific Calculator'],
  },
  {
    icon: '🎮',
    badge: 'INTERACTIVE',
    badgeClass: 'badge--purple',
    title: 'Gamified Arena & Live Host',
    desc: 'Quizizz-inspired sprint arena with synthesized sound effects, combo multipliers, speed bonuses, and interactive feedback. Teachers can host live multiplayer sessions with leaderboards.',
    highlights: ['Synthesized Web Audio Engine', 'Combo Streaks & Speed Bonuses', 'Live Multiplayer Host Dashboard'],
  },
  {
    icon: '🛡️',
    badge: 'HIGH INTEGRITY',
    badgeClass: 'badge--rose',
    title: 'Proctored Exam Security',
    desc: 'Enforce fullscreen exam mode with tab-switch detection, proctor strike logging, 5-minute and 1-minute audio-visual time alerts, and invigilator PIN unlock gates.',
    highlights: ['Fullscreen Enforcement', 'Tab & Blur Violation Tracking', 'Audio Time Alerts & Proctor PIN'],
  },
  {
    icon: '📝',
    badge: 'SMART MARKING',
    badgeClass: 'badge--emerald',
    title: 'AI Examiner & Teacher Remarking',
    desc: 'Automated MCQ/formula grading, step-by-step model answers, chemical formula formatting with KaTeX math notation, and full teacher mark override capabilities.',
    highlights: ['Structured Model Answer Cards', 'Chemical Formula Auto-Formatting', 'Teacher Remarking & Overrides'],
  },
  {
    icon: '📊',
    badge: 'ANALYTICS',
    badgeClass: 'badge--blue',
    title: 'Cohort Analytics & PDF Reports',
    desc: 'Track class score distributions, question difficulty rankings, and topic mastery heatmaps. Export print-ready Class Cohort Analytics and Individual Student Diagnostic Reports.',
    highlights: ['Topic Mastery Heatmaps', 'Printable Class Cohort PDF', 'Student Sub-Question Breakdown PDF'],
  },
  {
    icon: '📄',
    badge: 'VERSATILE',
    badgeClass: 'badge--cyan',
    title: 'Word, PDF & HTML Exports',
    desc: 'Export tests directly to Microsoft Word (.docx) with LaTeX super/subscript runs, camera-ready PDF test papers with mark schemes, or self-contained offline HTML interactive quizzes.',
    highlights: ['Native Word (.docx) with Math', 'Print-Ready PDF Test Papers', 'Standalone Offline HTML Quizzes'],
  },
  {
    icon: '🗂️',
    badge: 'ORGANIZED',
    badgeClass: 'badge--teal',
    title: 'Subject & Topic Organization',
    desc: 'Catalog tests and question items by subject and topic hierarchies. Instant search, topic filtering, class grouping, and one-click test loading into the custom builder.',
    highlights: ['Hierarchical Subject Grouping', 'Topic-Scoped Search & Filters', '1-Click Test Builder Loading'],
  },
];

export function PortalLandingPage({
  onJoinQuiz,
  onEnterTeacherSuite,
}: PortalLandingPageProps) {
  // Student Portal Tabs: 'take_quiz' | 'check_results'
  const [studentTab, setStudentTab] = useState<'take_quiz' | 'check_results'>('take_quiz');

  // Take Quiz Form State
  const [quizCodeInput, setQuizCodeInput] = useState('');
  const [codeError, setCodeError] = useState('');

  // Check Results Form State
  const [resultCodeInput, setResultCodeInput] = useState('');
  const [resultCandidateInput, setResultCandidateInput] = useState('');
  const [resultError, setResultError] = useState('');

  // Result Modal State
  const [isResultModalOpen, setIsResultModalOpen] = useState(false);
  const [activeResultLookup, setActiveResultLookup] = useState<{ quizCode: string; candidateId: string; pin: string }>({
    quizCode: '',
    candidateId: '',
    pin: '',
  });

  // Recent Device Receipts
  const [recentReceipts, setRecentReceipts] = useState<DeviceExamReceipt[]>([]);

  // Outbox Recovery State
  const [pendingOutbox, setPendingOutbox] = useState<SubmissionOutboxItem[]>(() => getPendingOutboxSubmissions());
  const [isFlushingOutbox, setIsFlushingOutbox] = useState<boolean>(false);
  const [outboxSyncMsg, setOutboxSyncMsg] = useState<string | null>(null);

  // Result PIN Input
  const [resultPinInput, setResultPinInput] = useState('');

  const refreshPendingOutbox = useCallback(() => {
    const pending = getPendingOutboxSubmissions();
    setPendingOutbox(pending);
  }, []);

  const handleFlushPendingOutbox = useCallback(async () => {
    if (isFlushingOutbox) return;
    setIsFlushingOutbox(true);
    setOutboxSyncMsg('Syncing pending exam submissions with teacher server...');
    try {
      const res = await flushSubmissionOutbox();
      if (res.syncedCount > 0) {
        setOutboxSyncMsg(`✅ Successfully synced ${res.syncedCount} exam submission(s) to server!`);
        setTimeout(() => setOutboxSyncMsg(null), 4000);
      } else if (res.failedCount > 0) {
        setOutboxSyncMsg('⚠️ Sync attempt failed. Will retry automatically when connection improves.');
      } else {
        setOutboxSyncMsg(null);
      }
    } catch {
      setOutboxSyncMsg('⚠️ Network error during sync. Will retry automatically.');
    } finally {
      setIsFlushingOutbox(false);
      refreshPendingOutbox();
    }
  }, [isFlushingOutbox, refreshPendingOutbox]);

  useEffect(() => {
    const receipts = getDeviceReceipts();
    setRecentReceipts(receipts);
    if (receipts.length > 0) {
      setResultCodeInput(receipts[0].quizCode);
      setResultCandidateInput(receipts[0].studentName || receipts[0].candidateNumber || '');
      setResultPinInput(receipts[0].resultPin || '');
    }

    refreshPendingOutbox();

    // Auto-attempt flush on page mount if online
    if (navigator.onLine && getPendingOutboxSubmissions().length > 0) {
      handleFlushPendingOutbox();
    }

    const handleOnline = () => {
      if (getPendingOutboxSubmissions().length > 0) {
        handleFlushPendingOutbox();
      }
    };

    const handleSubmissionsUpdated = () => {
      refreshPendingOutbox();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('submissions_updated', handleSubmissionsUpdated);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('submissions_updated', handleSubmissionsUpdated);
    };
  }, [handleFlushPendingOutbox, refreshPendingOutbox]);

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

  const handleLookupResults = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanCode = resultCodeInput.trim().toUpperCase();
    const cleanId = resultCandidateInput.trim();

    if (!cleanCode) {
      setResultError('Please enter the Quiz Code.');
      return;
    }
    if (!cleanId) {
      setResultError('Please enter your Candidate Name or Seat #.');
      return;
    }
    if (!resultPinInput.trim()) {
      setResultError('Please enter your 3-digit Personal Access PIN.');
      return;
    }

    setResultError('');
    setActiveResultLookup({ quizCode: cleanCode, candidateId: cleanId, pin: resultPinInput.trim() });
    setIsResultModalOpen(true);
  };

  const handleOpenReceiptResult = (receipt: DeviceExamReceipt) => {
    setActiveResultLookup({
      quizCode: receipt.quizCode,
      candidateId: receipt.studentName || receipt.candidateNumber || '',
      pin: receipt.resultPin || '',
    });
    setIsResultModalOpen(true);
  };

  return (
    <div className="portal-root">
      {/* Ambient Glows */}
      <div className="portal-glow portal-glow--1" />
      <div className="portal-glow portal-glow--2" />
      <div className="portal-glow portal-glow--3" />

      {/* Main Container */}
      <div className="portal-content">
        {/* Compact Brand Header */}
        <header className="portal-brand-header">
          <div className="portal-avatar-wrap">
            <img src="/avatar.jpg" alt="fluffykitten" className="portal-cat-avatar" />
            <span className="portal-online-dot" />
          </div>

          <h1 className="portal-title">fluffykitten's test maker</h1>
          <p className="portal-subtitle">
            Interactive Student Assessment Portal & Teacher Examination Suite
          </p>
        </header>

        {/* ─── Pending Offline Exam Outbox Banner ─── */}
        {pendingOutbox.length > 0 && (
          <div
            style={{
              background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.15), rgba(217, 119, 6, 0.1))',
              border: '1.5px solid #f59e0b',
              borderRadius: '14px',
              padding: '16px 20px',
              marginBottom: '24px',
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '14px',
              boxShadow: '0 4px 15px rgba(245, 158, 11, 0.12)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', textAlign: 'left' }}>
              <span style={{ fontSize: '1.6rem' }}>⚠️</span>
              <div>
                <strong style={{ color: '#fbbf24', fontSize: '0.95rem', display: 'block' }}>
                  {pendingOutbox.length} Pending Exam Submission{pendingOutbox.length > 1 ? 's' : ''} Stored Locally
                </strong>
                <span style={{ fontSize: '0.8125rem', color: '#cbd5e1' }}>
                  {pendingOutbox.map((i) => `${i.submission.quizCode} (${i.submission.studentName})`).join(' • ')}
                </span>
                {outboxSyncMsg && (
                  <div style={{ fontSize: '0.8125rem', color: '#6ee7b7', marginTop: '4px', fontWeight: 600 }}>
                    {outboxSyncMsg}
                  </div>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                onClick={handleFlushPendingOutbox}
                disabled={isFlushingOutbox}
                style={{
                  background: '#f59e0b',
                  color: '#0f172a',
                  border: 'none',
                  padding: '8px 14px',
                  borderRadius: '8px',
                  fontSize: '0.8125rem',
                  fontWeight: 800,
                  cursor: isFlushingOutbox ? 'not-allowed' : 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                }}
              >
                {isFlushingOutbox ? '⏳ Syncing...' : '🔄 Sync Now'}
              </button>

              <button
                type="button"
                onClick={() => exportSubmissionToFile(pendingOutbox[0].submission)}
                style={{
                  background: 'rgba(255, 255, 255, 0.1)',
                  color: '#ffffff',
                  border: '1px solid rgba(255, 255, 255, 0.25)',
                  padding: '8px 14px',
                  borderRadius: '8px',
                  fontSize: '0.8125rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                📥 Backup (.exam)
              </button>
            </div>
          </div>
        )}

        {/* Dual Portal Cards Grid - Positioned at Top */}
        <div className="portal-cards-grid">
          {/* Card 1: Student Quiz Portal */}
          <div className="portal-card portal-card--student">
            <div className="portal-card-badge portal-card-badge--student">FOR STUDENTS</div>
            <div className="portal-card-icon-wrap portal-card-icon--student">
              🎓
            </div>
            <h2 className="portal-card-heading">Interactive Student Portal</h2>
            <p className="portal-card-desc">
              Join your teacher's timed assessment, compete in a gamified sprint arena, or retrieve your marked papers.
            </p>

            {/* Quick-Access Device Receipt Banner */}
            {recentReceipts.length > 0 && (
              <div
                className="portal-receipt-banner animate-fade-in"
                onClick={() => handleOpenReceiptResult(recentReceipts[0])}
                title="Click to retrieve your marked examination script"
              >
                <div className="portal-receipt-info">
                  <span className="portal-receipt-tag">🎉 Recent Exam on this Device</span>
                  <div className="portal-receipt-title">
                    {recentReceipts[0].quizCode}: {recentReceipts[0].quizTitle || 'Examination'} ({recentReceipts[0].studentName})
                  </div>
                </div>
                <span className="portal-receipt-action">Check Result →</span>
              </div>
            )}

            {/* Action Mode Tabs */}
            <div className="portal-tabs-nav">
              <button
                type="button"
                className={`portal-tab-btn ${studentTab === 'take_quiz' ? 'portal-tab-btn--active' : ''}`}
                onClick={() => setStudentTab('take_quiz')}
              >
                🚀 Take Assessment
              </button>
              <button
                type="button"
                className={`portal-tab-btn ${studentTab === 'check_results' ? 'portal-tab-btn--active' : ''}`}
                onClick={() => setStudentTab('check_results')}
              >
                📊 Check Exam Results
              </button>
            </div>

            {studentTab === 'take_quiz' ? (
              /* Tab 1: Take Quiz Form */
              <form onSubmit={handleJoin} className="portal-quiz-form animate-fade-in">
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
                    />
                  </div>
                  {codeError && <span className="portal-error-text">{codeError}</span>}
                </div>

                <button type="submit" className="portal-btn portal-btn--student">
                  🚀 Start Interactive Assessment
                </button>
              </form>
            ) : (
              /* Tab 2: Check Exam Results Form */
              <form onSubmit={handleLookupResults} className="portal-quiz-form animate-fade-in">
                <div className="portal-input-group">
                  <label className="portal-input-label">Exam Code:</label>
                  <div className="portal-input-inner">
                    <span className="portal-input-icon">🔑</span>
                    <input
                      type="text"
                      className="portal-code-input"
                      placeholder="e.g. CHEM-101"
                      value={resultCodeInput}
                      onChange={(e) => {
                        setResultCodeInput(e.target.value.toUpperCase());
                        if (resultError) setResultError('');
                      }}
                      maxLength={36}
                    />
                  </div>
                </div>

                <div className="portal-input-group" style={{ marginTop: '10px' }}>
                  <label className="portal-input-label">Candidate Name or Seat #:</label>
                  <div className="portal-input-inner">
                    <span className="portal-input-icon">👤</span>
                    <input
                      type="text"
                      className="portal-code-input"
                      placeholder="e.g. Alex Chen or Seat 12"
                      value={resultCandidateInput}
                      onChange={(e) => {
                        setResultCandidateInput(e.target.value);
                        if (resultError) setResultError('');
                      }}
                      maxLength={50}
                    />
                  </div>
                  {resultError && <span className="portal-error-text">{resultError}</span>}
                </div>

                <div className="portal-input-group" style={{ marginTop: '10px' }}>
                  <label className="portal-input-label">Personal Access PIN:</label>
                  <div className="portal-input-inner">
                    <span className="portal-input-icon">🔐</span>
                    <input
                      type="text"
                      className="portal-code-input"
                      placeholder="e.g. 847"
                      value={resultPinInput}
                      onChange={(e) => {
                        const v = e.target.value.replace(/\D/g, '').slice(0, 3);
                        setResultPinInput(v);
                        if (resultError) setResultError('');
                      }}
                      maxLength={3}
                      inputMode="numeric"
                      style={{ fontFamily: 'monospace', letterSpacing: '0.2em', fontSize: '1.1rem', fontWeight: 800 }}
                    />
                  </div>
                  <span style={{ fontSize: '0.7rem', color: 'var(--color-text-tertiary, #94a3b8)', marginTop: '4px', display: 'block' }}>
                    💡 You received this 3-digit PIN on your exam confirmation receipt.
                  </span>
                </div>

                <button type="submit" className="portal-btn portal-btn--student" style={{ marginTop: '8px' }}>
                  🔍 Retrieve My Marked Paper
                </button>
              </form>
            )}

            <div className="portal-card-footer-note">
              <span>💡</span> Enter the quiz code or exam code given by your teacher to get started.
            </div>
          </div>

          {/* Card 2: Teacher Suite */}
          <div
            className="portal-card portal-card--teacher"
            onClick={onEnterTeacherSuite}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onEnterTeacherSuite();
              }
            }}
          >
            <div className="portal-card-badge portal-card-badge--teacher">FOR TEACHERS</div>
            <div className="portal-card-icon-wrap portal-card-icon--teacher">
              🧑‍🏫
            </div>
            <h2 className="portal-card-heading">Teacher Test Maker</h2>
            <p className="portal-card-desc">
              Extract questions from past papers with AI, assemble custom Cambridge tests, host live multiplayer arenas, and generate diagnostic PDF reports.
            </p>

            <div className="portal-teacher-action-wrap">
              <button type="button" className="portal-btn portal-btn--teacher">
                Enter Teacher Suite →
              </button>
            </div>

            <div className="portal-card-footer-note">
              <span>✨</span> Full access to question extraction, test builder, live hosting, and reports.
            </div>
          </div>
        </div>

        {/* Platform Capabilities & Feature Showcase */}
        <section className="portal-features-section">
          <div className="portal-section-header">
            <span className="portal-section-badge">PLATFORM CAPABILITIES</span>
            <h2 className="portal-section-title">Everything You Need to Create, Assess & Analyze</h2>
            <p className="portal-section-desc">
              A complete examination suite engineered for Cambridge IGCSE, A-Levels, and modern classrooms with AI assistance, gamification, and proctoring.
            </p>
          </div>

          <div className="portal-features-grid">
            {PLATFORM_FEATURES.map((feat, idx) => (
              <div key={idx} className="portal-feature-card">
                <div className="feature-card-top">
                  <div className="feature-card-icon-wrap">
                    <span className="feature-card-icon">{feat.icon}</span>
                  </div>
                  <span className={`feature-card-badge ${feat.badgeClass}`}>{feat.badge}</span>
                </div>

                <h3 className="feature-card-title">{feat.title}</h3>
                <p className="feature-card-desc">{feat.desc}</p>

                <div className="feature-card-highlights">
                  {feat.highlights.map((h, i) => (
                    <span key={i} className="feature-highlight-tag">
                      <span className="highlight-bullet">•</span> {h}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Footer info */}
        <footer className="portal-footer">
          <div className="portal-footer-line">
            <span>fluffykitten AI Assessment Platform</span> • <span>Version 2.5</span> • <span>Powered by Supabase & Gemini</span>
          </div>
          <div className="portal-footer-sub">
            Built for Cambridge Educators & Interactive Learning
          </div>
        </footer>
      </div>

      {/* Student Attempt History & Result Modal */}
      <StudentResultModal
        isOpen={isResultModalOpen}
        quizCode={activeResultLookup.quizCode}
        candidateIdentifier={activeResultLookup.candidateId}
        pin={activeResultLookup.pin}
        onClose={() => setIsResultModalOpen(false)}
      />
    </div>
  );
}
