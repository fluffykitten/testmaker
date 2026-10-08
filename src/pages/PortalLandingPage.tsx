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
import { prefetchAccessPin } from '../components/PinGate';
import { TurnstileWidget } from '../components/TurnstileWidget';
import { verifyTurnstileToken } from '../services/turnstileService';
import { ICM_LOGO_PATH, CAMBRIDGE_LOGO_PATH } from '../assets/logoConstants';
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

  // Split View Filter: 'all' | 'students' | 'teachers'
  const [portalViewFilter, setPortalViewFilter] = useState<'all' | 'students' | 'teachers'>('all');

  // Take Quiz Form State
  const [quizCodeInput, setQuizCodeInput] = useState('');
  const [codeError, setCodeError] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');

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
    prefetchAccessPin();
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

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = quizCodeInput.trim().toUpperCase();
    if (!clean) {
      setCodeError('Please enter a Quiz Code or Test ID.');
      return;
    }

    const check = await verifyTurnstileToken(turnstileToken, 'portal_join');
    if (!check.success) {
      setCodeError('Security challenge failed. Please refresh the page and try again.');
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
        {/* Minimalist Institutional Header */}
        <header className="portal-brand-header">
          <div className="portal-brand-logos">
            <div className="portal-logo-card" title="Insan Cendekia Madani">
              <img src={ICM_LOGO_PATH} alt="ICM" className="portal-logo-img" />
            </div>
            <div className="portal-logo-divider" />
            <div className="portal-logo-card" title="Cambridge Assessment International Education">
              <img src={CAMBRIDGE_LOGO_PATH} alt="Cambridge Assessment" className="portal-logo-img" />
            </div>
          </div>

          <div className="portal-meta-badge">
            <span className="portal-live-dot" />
            <span>Academic Year 2026/2027 • Accredited Cambridge International School</span>
          </div>

          <h1 className="portal-title">
            ICM <span className="portal-title-accent">Exam Platform</span>
          </h1>
          <p className="portal-subtitle">
            The unified Cambridge assessment studio and secure examination portal for Insan Cendekia Madani. Select your pathway below to begin.
          </p>
        </header>

        {/* ─── Pending Offline Exam Outbox Banner ─── */}
        {pendingOutbox.length > 0 && (
          <div className="portal-outbox-banner">
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', textAlign: 'left' }}>
              <span style={{ fontSize: '1.6rem' }}>⚠️</span>
              <div>
                <strong style={{ color: '#b45309', fontSize: '0.95rem', display: 'block' }}>
                  {pendingOutbox.length} Pending Exam Submission{pendingOutbox.length > 1 ? 's' : ''} Stored Locally
                </strong>
                <span style={{ fontSize: '0.8125rem', color: '#64748b' }}>
                  {pendingOutbox.map((i) => `${i.submission.quizCode} (${i.submission.studentName})`).join(' • ')}
                </span>
                {outboxSyncMsg && (
                  <div style={{ fontSize: '0.8125rem', color: '#059669', marginTop: '4px', fontWeight: 600 }}>
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
                  background: '#059669',
                  color: '#ffffff',
                  border: 'none',
                  padding: '8px 16px',
                  borderRadius: '8px',
                  fontSize: '0.8125rem',
                  fontWeight: 800,
                  cursor: isFlushingOutbox ? 'not-allowed' : 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '6px',
                  boxShadow: '0 2px 8px rgba(5, 150, 105, 0.2)',
                }}
              >
                {isFlushingOutbox ? '⏳ Syncing...' : '🔄 Sync Now'}
              </button>

              <button
                type="button"
                onClick={() => exportSubmissionToFile(pendingOutbox[0].submission)}
                style={{
                  background: '#ffffff',
                  color: '#334155',
                  border: '1px solid #cbd5e1',
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

        {/* ─── Segmented Split View Filter ─── */}
        <div className="portal-split-toggle" role="tablist" aria-label="Portal View Selection">
          <button
            type="button"
            className={`portal-split-toggle-btn ${portalViewFilter === 'all' ? 'portal-split-toggle-btn--active' : ''}`}
            onClick={() => setPortalViewFilter('all')}
          >
            <span>👥</span> Dual Split View
          </button>
          <button
            type="button"
            className={`portal-split-toggle-btn ${portalViewFilter === 'students' ? 'portal-split-toggle-btn--active' : ''}`}
            onClick={() => setPortalViewFilter('students')}
          >
            <span>🎓</span> For Students
          </button>
          <button
            type="button"
            className={`portal-split-toggle-btn ${portalViewFilter === 'teachers' ? 'portal-split-toggle-btn--active' : ''}`}
            onClick={() => setPortalViewFilter('teachers')}
          >
            <span>🧑‍🏫</span> For Teachers
          </button>
        </div>

        {/* ─── Dual Split Cards Grid (Students vs Teachers) ─── */}
        <div className={`portal-cards-grid ${portalViewFilter === 'students' ? 'portal-cards-grid--students-only' : ''} ${portalViewFilter === 'teachers' ? 'portal-cards-grid--teachers-only' : ''}`}>
          {/* Card 1: Students Portal */}
          {(portalViewFilter === 'all' || portalViewFilter === 'students') && (
            <div className="portal-card portal-card--student">
              <div className="portal-card-header">
                <div className="portal-card-icon-wrap portal-card-icon--student">
                  🎓
                </div>
                <div className="portal-card-badge portal-card-badge--student">
                  <span>●</span> STUDENT PORTAL
                </div>
              </div>
              <h2 className="portal-card-heading">Join Exam or Check Results</h2>
              <p className="portal-card-desc">
                Enter your test token to launch your timed Cambridge exam, compete in a sprint arena, or retrieve marked scripts.
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
                  <TurnstileWidget action="portal_join" onVerify={setTurnstileToken} />
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
                    <span style={{ fontSize: '0.7rem', color: '#64748b', marginTop: '4px', display: 'block' }}>
                      💡 You received this 3-digit PIN on your exam confirmation receipt.
                    </span>
                  </div>

                  <button type="submit" className="portal-btn portal-btn--student" style={{ marginTop: '8px' }}>
                    🔍 Retrieve My Marked Paper
                  </button>
                </form>
              )}

              {/* Student Reassurance Badges */}
              <div className="portal-student-reassurance">
                <span className="portal-reassurance-chip">✓ Fullscreen Lockdown</span>
                <span className="portal-reassurance-chip">✓ KaTeX Live Formulas</span>
                <span className="portal-reassurance-chip">✓ Offline Auto-Sync</span>
                <span className="portal-reassurance-chip">✓ Instant Score</span>
              </div>
            </div>
          )}

          {/* Card 2: Teacher Suite */}
          {(portalViewFilter === 'all' || portalViewFilter === 'teachers') && (
            <div
              className="portal-card portal-card--teacher"
              onClick={onEnterTeacherSuite}
              onMouseEnter={() => prefetchAccessPin()}
              onFocus={() => prefetchAccessPin()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onEnterTeacherSuite();
                }
              }}
            >
              <div className="portal-card-header">
                <div className="portal-card-icon-wrap portal-card-icon--teacher">
                  🧑‍🏫
                </div>
                <div className="portal-card-badge portal-card-badge--teacher">
                  <span>●</span> FOR EDUCATORS
                </div>
              </div>
              <h2 className="portal-card-heading">Teacher Authoring Studio</h2>
              <p className="portal-card-desc">
                Construct Cambridge exams, ingest past papers with Gemini AI, and administer proctored assessments.
              </p>

              {/* Minimalist Teacher Modules Showcase */}
              <div className="portal-teacher-modules-list">
                <div className="portal-teacher-module-item">
                  <span className="portal-teacher-module-icon">📚</span>
                  <span className="portal-teacher-module-text">Cambridge Question Bank with Formula Expansion</span>
                </div>
                <div className="portal-teacher-module-item">
                  <span className="portal-teacher-module-icon">🤖</span>
                  <span className="portal-teacher-module-text">Gemini Multimodal AI Past Paper PDF Ingestion</span>
                </div>
                <div className="portal-teacher-module-item">
                  <span className="portal-teacher-module-icon">📝</span>
                  <span className="portal-teacher-module-text">Standardized Test Builder with AO Mark Balancing</span>
                </div>
                <div className="portal-teacher-module-item">
                  <span className="portal-teacher-module-icon">📑</span>
                  <span className="portal-teacher-module-text">Word (.docx), PDF & Comprehensive Mark Schemes</span>
                </div>
                <div className="portal-teacher-module-item">
                  <span className="portal-teacher-module-icon">🛡️</span>
                  <span className="portal-teacher-module-text">Anti-Cheat Real-Time Proctoring & Strike Logs</span>
                </div>
                <div className="portal-teacher-module-item">
                  <span className="portal-teacher-module-icon">📊</span>
                  <span className="portal-teacher-module-text">Automated Multi-Sheet Excel Class Gradebooks</span>
                </div>
              </div>

              <div className="portal-teacher-action-wrap">
                <button type="button" className="portal-btn portal-btn--teacher">
                  Enter Teacher Suite (PIN Protected) →
                </button>
              </div>

              <div className="portal-card-footer-note">
                <span>🔒</span> Protected by 6-digit access PIN • Inactivity auto-lock enabled
              </div>
            </div>
          )}
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

        {/* Minimalist Institutional Footer */}
        <footer className="portal-footer">
          <div className="portal-footer-line">
            <span>ICM Exam Platform</span> • <span>Insan Cendekia Madani</span> • <span>Cambridge International School</span>
          </div>
          <div className="portal-footer-sub">
            Unified Cambridge Assessment & Secure Examination Portal • Academic Year 2026/2027
          </div>
          <div className="portal-footer-status">
            <span className="portal-live-dot" />
            <span>Examination Systems Operational & Synced</span>
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
