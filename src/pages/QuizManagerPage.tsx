import { useState, useEffect, useMemo } from 'react';
import type { Question } from '../types/database';
import {
  fetchCustomTestsWithMetadata,
  fetchCustomTestWithQuestions,
  type CustomTestWithDetails,
  type ExamHeaderConfig,
} from '../services/testBuilderService';
import {
  getPublishedQuizzes,
  savePublishedQuiz,
  deletePublishedQuiz,
  toggleQuizActiveStatus,
  createDraftFromTest,
  type PublishedQuiz,
} from '../services/quizManagerService';
import { getSubmissionsForQuiz } from '../services/quizSubmissionService';
import { QuizResultsModal } from '../components/QuizResultsModal';
import './QuizManagerPage.css';

interface QuizManagerPageProps {
  onLaunchTestRun: (questions: Question[], headerConfig?: ExamHeaderConfig) => void;
  onLaunchGameHost?: (quiz: PublishedQuiz, questions: Question[]) => void;
  onNavigateToBuilder: () => void;
  onNavigateToSaved: () => void;
}

export function QuizManagerPage({
  onLaunchTestRun,
  onLaunchGameHost,
  onNavigateToBuilder,
  onNavigateToSaved,
}: QuizManagerPageProps) {
  const [quizzes, setQuizzes] = useState<PublishedQuiz[]>([]);
  const [savedTests, setSavedTests] = useState<CustomTestWithDetails[]>([]);
  const [loading, setLoading] = useState(true);

  // Subject Filtering & Search
  const [selectedSubject, setSelectedSubject] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isGroupedBySubject, setIsGroupedBySubject] = useState<boolean>(true);

  // Modal State
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [activeQuizDraft, setActiveQuizDraft] = useState<PublishedQuiz | null>(null);
  const [selectedTestId, setSelectedTestId] = useState<string>('');
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null);
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | null>(null);

  // Results Modal State
  const [selectedQuizForResults, setSelectedQuizForResults] = useState<PublishedQuiz | null>(null);

  // ─── 1. Load Data on Mount ──────────────────────────────────────────────────
  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setLoading(true);
    try {
      const pubList = getPublishedQuizzes();
      // Sanitize any older published quizzes that fell back to generic "Assessment"
      const sanitized = pubList.map((q) => {
        if (!q.subject || q.subject.toLowerCase() === 'assessment') {
          return { ...q, subject: 'Chemistry' };
        }
        return q;
      });
      setQuizzes(sanitized);

      const tests = await fetchCustomTestsWithMetadata();
      setSavedTests(tests);
    } catch (err) {
      console.error('Error loading quiz manager data:', err);
    } finally {
      setLoading(false);
    }
  }

  // ─── 2. Available Subjects List ─────────────────────────────────────────────
  const availableSubjects = useMemo(() => {
    const subs = Array.from(
      new Set(quizzes.map((q) => q.subject?.trim() || 'Chemistry'))
    ).filter(Boolean);
    return ['all', ...subs];
  }, [quizzes]);

  // ─── 3. Filtered Quizzes ────────────────────────────────────────────────────
  const filteredQuizzes = useMemo(() => {
    return quizzes.filter((quiz) => {
      const matchesSubject =
        selectedSubject === 'all' ||
        (quiz.subject || 'Chemistry').toLowerCase() === selectedSubject.toLowerCase();
      
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        quiz.title.toLowerCase().includes(q) ||
        quiz.quizCode.toLowerCase().includes(q) ||
        (quiz.subject || '').toLowerCase().includes(q);

      return matchesSubject && matchesSearch;
    });
  }, [quizzes, selectedSubject, searchQuery]);

  // Group by subject dictionary
  const groupedBySubject = useMemo(() => {
    const map = new Map<string, PublishedQuiz[]>();
    filteredQuizzes.forEach((quiz) => {
      const subj = quiz.subject?.trim() || 'Chemistry';
      if (!map.has(subj)) map.set(subj, []);
      map.get(subj)!.push(quiz);
    });
    return map;
  }, [filteredQuizzes]);

  // ─── 4. Create / Edit Quiz Flow ─────────────────────────────────────────────
  const handleOpenCreateModal = (initialMode: 'exam' | 'game' = 'exam') => {
    if (savedTests.length === 0) {
      alert('You have no saved tests yet. Please build and save a test first before creating an interactive quiz.');
      onNavigateToBuilder();
      return;
    }

    const firstTest = savedTests[0];
    setSelectedTestId(firstTest.id);
    const draft = createDraftFromTest(firstTest);
    draft.quizMode = initialMode;
    setActiveQuizDraft(draft);
    setIsConfigModalOpen(true);
  };

  const handleSelectSavedTest = (testId: string) => {
    setSelectedTestId(testId);
    const selected = savedTests.find((t) => t.id === testId);
    if (selected) {
      const draft = createDraftFromTest(selected);
      if (activeQuizDraft?.quizMode) {
        draft.quizMode = activeQuizDraft.quizMode;
      }
      setActiveQuizDraft(draft);
    }
  };

  const handleOpenEditModal = (quiz: PublishedQuiz) => {
    setActiveQuizDraft({ ...quiz, quizMode: quiz.quizMode || 'exam' });
    setSelectedTestId(quiz.testId);
    setIsConfigModalOpen(true);
  };

  const handleQuickSetMode = (quizId: string, mode: 'exam' | 'game') => {
    const target = quizzes.find((q) => q.id === quizId);
    if (!target) return;
    const updated = { ...target, quizMode: mode, updatedAt: new Date().toISOString() };
    savePublishedQuiz(updated);
    setQuizzes(getPublishedQuizzes());
    setSaveSuccessMsg(`Switched "${updated.title}" to ${mode === 'game' ? '🎮 Quizizz Game Mode' : '📝 Formal Exam Mode'}!`);
    setTimeout(() => setSaveSuccessMsg(null), 3000);
  };

  const handleSaveQuizConfig = () => {
    if (!activeQuizDraft) return;
    const cleanCode = activeQuizDraft.quizCode.trim().toUpperCase();
    if (!cleanCode) {
      alert('Please provide a valid Quiz Code.');
      return;
    }

    const cleanSubject = activeQuizDraft.subject?.trim() || 'Chemistry';

    const updated: PublishedQuiz = {
      ...activeQuizDraft,
      quizCode: cleanCode,
      subject: cleanSubject,
      quizMode: activeQuizDraft.quizMode || 'exam',
      updatedAt: new Date().toISOString(),
    };

    savePublishedQuiz(updated);
    setQuizzes(getPublishedQuizzes());
    setIsConfigModalOpen(false);
    setActiveQuizDraft(null);
    setSaveSuccessMsg(`✨ Quiz "${updated.title}" configured with Code [${updated.quizCode}]!`);
    setTimeout(() => setSaveSuccessMsg(null), 4000);
  };

  // ─── 5. Action Handlers ─────────────────────────────────────────────────────
  const handleDeleteQuiz = (id: string) => {
    if (confirm('Are you sure you want to unpublish and delete this interactive quiz?')) {
      deletePublishedQuiz(id);
      setQuizzes(getPublishedQuizzes());
    }
  };

  const handleToggleActive = (id: string) => {
    toggleQuizActiveStatus(id);
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
  };

  const handleRunQuizSimulation = async (quiz: PublishedQuiz) => {
    const res = await fetchCustomTestWithQuestions(quiz.testId);
    const questions = res?.questions || [];
    onLaunchTestRun(questions, quiz.headerConfig);
  };

  const handleStartLiveGame = async (quiz: PublishedQuiz) => {
    const res = await fetchCustomTestWithQuestions(quiz.testId);
    const questions = res?.questions || [];
    if (onLaunchGameHost) {
      onLaunchGameHost(quiz, questions);
    } else {
      onLaunchTestRun(questions, quiz.headerConfig);
    }
  };

  // Helper function to render a quiz card
  const renderQuizCard = (quiz: PublishedQuiz) => {
    const directLink = `${window.location.origin}${window.location.pathname}?quiz=${quiz.quizCode}`;
    const submissionCount = getSubmissionsForQuiz(quiz.id, quiz.quizCode).length;
    const isGame = quiz.quizMode === 'game';

    return (
      <div key={quiz.id} className={`qm-quiz-card animate-scale-up ${isGame ? 'qm-quiz-card--game' : ''}`}>
        {/* Card Header */}
        <div className="qm-card-header">
          <div className="qm-card-title-group">
            <div className="qm-pill-row">
              <span className="qm-subject-pill">{quiz.subject || 'Chemistry'}</span>
              {isGame ? (
                <span className="qm-mode-badge qm-mode-badge--game">🎮 QUIZIZZ GAME</span>
              ) : (
                <span className="qm-mode-badge qm-mode-badge--exam">📝 FORMAL EXAM</span>
              )}
            </div>
            <h3 className="qm-quiz-title">{quiz.title}</h3>
          </div>

          <button
            type="button"
            className={`qm-status-toggle ${quiz.isActive ? 'qm-status--active' : 'qm-status--paused'}`}
            onClick={() => handleToggleActive(quiz.id)}
            title="Click to toggle quiz active status"
          >
            {quiz.isActive ? '🟢 Active' : '⏸️ Paused'}
          </button>
        </div>

        {/* 1-Click Format Switcher Bar on Card */}
        <div className="qm-card-format-toggle-bar">
          <span className="qm-format-lbl">MODE:</span>
          <button
            type="button"
            className={`qm-format-chip ${!isGame ? 'qm-format-chip--active-exam' : ''}`}
            onClick={() => handleQuickSetMode(quiz.id, 'exam')}
            title="Switch this quiz to Formal Exam mode"
          >
            📝 Formal Exam
          </button>
          <button
            type="button"
            className={`qm-format-chip ${isGame ? 'qm-format-chip--active-game' : ''}`}
            onClick={() => handleQuickSetMode(quiz.id, 'game')}
            title="Switch this quiz to Quizizz Game mode"
          >
            🎮 Quizizz Game
          </button>
        </div>

        {/* Access Token Banner */}
        <div className="qm-code-banner">
          <div className="qm-code-info">
            <span className="qm-code-lbl">STUDENT ACCESS CODE:</span>
            <span className="qm-code-value">{quiz.quizCode}</span>
          </div>

          <div className="qm-code-actions">
            <button
              type="button"
              className="qm-btn-icon"
              onClick={() => handleCopyCode(quiz.quizCode, quiz.id)}
              title="Copy Code"
            >
              {copiedCodeId === quiz.id ? '✓ Copied' : '📋 Copy Code'}
            </button>
            <button
              type="button"
              className="qm-btn-icon"
              onClick={() => handleCopyLink(quiz.quizCode, quiz.id)}
              title="Copy Direct Link"
            >
              {copiedLinkId === quiz.id ? '✓ Copied' : '🔗 Copy Link'}
            </button>
          </div>
        </div>

        {/* Config Badges */}
        <div className="qm-config-pills">
          {isGame ? (
            <>
              <span className="qm-pill">⚡ {quiz.questionTimerSeconds || 20}s per Question</span>
              <span className="qm-pill">🏆 {quiz.pointsPerQuestion || 1000} Base Pts</span>
              {quiz.enablePowerUps && <span className="qm-pill">✂️ Power-Ups</span>}
              {quiz.enableStreaks && <span className="qm-pill">🔥 Streaks</span>}
              {quiz.enableFunSounds && <span className="qm-pill">🔊 Sound FX</span>}
            </>
          ) : (
            <>
              <span className="qm-pill">
                ⏱️ {quiz.durationMinutes} mins ({quiz.isExamMode ? 'Timed Exam' : 'Practice'})
              </span>
              <span className="qm-pill">
                📝 {quiz.questionCount} Questions • {quiz.totalMarks} Marks
              </span>
              <span className={`qm-pill ${quiz.securityEnabled ? 'qm-pill--security' : ''}`}>
                {quiz.securityEnabled ? '🔒 Anti-Cheating ON' : '🔓 Open Browser'}
              </span>
              {quiz.showInstantSolutions && (
                <span className="qm-pill">💡 Instant Solutions</span>
              )}
            </>
          )}
        </div>

        {/* Direct Link Preview */}
        <div className="qm-link-preview-box">
          <input
            type="text"
            className="qm-link-preview-input"
            value={directLink}
            readOnly
          />
        </div>

        {/* Actions 2-Tier Container */}
        <div className="qm-card-actions-wrap">
          {/* Top Tier: Full-Width Primary Button */}
          {isGame ? (
            <div className="qm-dual-launch-row">
              <button
                type="button"
                className="qm-btn qm-btn-testrun qm-btn-game-host"
                onClick={() => handleStartLiveGame(quiz)}
                title="Start real-time multiplayer game session as teacher host"
              >
                🎮 Start Live Multiplayer Game (Host)
              </button>
              <button
                type="button"
                className="qm-btn qm-btn-solo-game"
                onClick={() => handleRunQuizSimulation(quiz)}
                title="Test-run this quiz in solo game mode"
              >
                🕹️ Solo Run
              </button>
            </div>
          ) : (
            <div className="qm-dual-launch-row">
              <button
                type="button"
                className="qm-btn qm-btn-testrun"
                onClick={() => handleRunQuizSimulation(quiz)}
                title="Test-run this quiz in the browser as a formal timed exam"
              >
                ▶️ Test-Run Interactive Exam
              </button>
              <button
                type="button"
                className="qm-btn qm-btn-solo-game"
                onClick={() => {
                  handleQuickSetMode(quiz.id, 'game');
                  handleStartLiveGame({ ...quiz, quizMode: 'game' });
                }}
                title="Launch as Quizizz Game mode instead"
              >
                🎮 Play as Game
              </button>
            </div>
          )}

          {/* Bottom Tier: Results, Settings & Delete */}
          <div className="qm-card-sub-actions">
            <button
              type="button"
              className="qm-btn qm-btn-results"
              onClick={() => setSelectedQuizForResults(quiz)}
              title="View student answers, scores, and proctoring audit log"
            >
              📊 View Results {submissionCount > 0 ? `(${submissionCount})` : '(0)'}
            </button>

            <button
              type="button"
              className="qm-btn qm-btn-secondary"
              onClick={() => handleOpenEditModal(quiz)}
              title="Configure settings, custom code, subject, or timer"
            >
              ⚙️ Settings
            </button>

            <button
              type="button"
              className="qm-btn qm-btn-danger-text"
              onClick={() => handleDeleteQuiz(quiz.id)}
              title="Delete / Unpublish quiz"
            >
              🗑️
            </button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="qm-root animate-fade-in">
      <div className="qm-container">
        {/* Page Header */}
        <div className="qm-top-bar">
          <div>
            <div className="qm-title-badge">STUDENT ASSESSMENT HUB</div>
            <h1 className="qm-page-title">Interactive Quizzes & Live Assessments</h1>
            <p className="qm-page-subtitle">
              Convert saved tests into live interactive student quizzes or competitive Quizizz game arenas with custom codes, timer countdowns, and live leaderboards.
            </p>
          </div>

          <div className="qm-top-actions">
            <button
              type="button"
              className="qm-btn qm-btn-primary qm-btn-header qm-btn-quizizz-top"
              onClick={() => handleOpenCreateModal('game')}
              title="Create a new fast-paced gamified quiz (Quizizz style)"
            >
              🎮 Create Quizizz Game
            </button>
            <button
              type="button"
              className="qm-btn qm-btn-secondary qm-btn-header"
              onClick={() => handleOpenCreateModal('exam')}
              title="Publish as formal timed exam paper"
            >
              📝 Publish Formal Exam
            </button>
          </div>
        </div>

        {/* Success Alert */}
        {saveSuccessMsg && (
          <div className="qm-success-banner animate-slide-up">
            <span>✓</span> {saveSuccessMsg}
          </div>
        )}

        {/* Stats Strip */}
        <div className="qm-stats-grid">
          <div className="qm-stat-card">
            <span className="stat-num">{quizzes.length}</span>
            <span className="stat-lbl">Published Quizzes</span>
          </div>
          <div className="qm-stat-card">
            <span className="stat-num">{quizzes.filter((q) => q.isActive).length}</span>
            <span className="stat-lbl">Active & Open for Students</span>
          </div>
          <div className="qm-stat-card">
            <span className="stat-num">{quizzes.filter((q) => q.securityEnabled).length}</span>
            <span className="stat-lbl">Anti-Cheating Guard Active</span>
          </div>
          <div className="qm-stat-card">
            <span className="stat-num">{availableSubjects.length > 1 ? availableSubjects.length - 1 : 1}</span>
            <span className="stat-lbl">Subjects Covered</span>
          </div>
        </div>

        {/* ─── Subject Filter & Search Bar ───────────────────────────────────── */}
        {quizzes.length > 0 && (
          <div className="qm-filter-toolbar">
            {/* Subject Tabs */}
            <div className="qm-subject-tabs">
              {availableSubjects.map((subj) => {
                const count =
                  subj === 'all'
                    ? quizzes.length
                    : quizzes.filter((q) => (q.subject || 'Chemistry').toLowerCase() === subj.toLowerCase()).length;
                return (
                  <button
                    key={subj}
                    type="button"
                    className={`qm-subj-tab ${selectedSubject.toLowerCase() === subj.toLowerCase() ? 'qm-subj-tab--active' : ''}`}
                    onClick={() => setSelectedSubject(subj)}
                  >
                    {subj === 'all' ? '🌐 All Subjects' : `📚 ${subj}`}
                    <span className="qm-subj-count">{count}</span>
                  </button>
                );
              })}
            </div>

            {/* Search and Group Toggle */}
            <div className="qm-filter-right">
              <div className="qm-search-wrap">
                <span className="qm-search-icon">🔍</span>
                <input
                  type="text"
                  className="qm-search-input"
                  placeholder="Search quizzes or code..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="qm-search-clear"
                    onClick={() => setSearchQuery('')}
                  >
                    ✕
                  </button>
                )}
              </div>

              <button
                type="button"
                className={`qm-group-toggle-btn ${isGroupedBySubject ? 'qm-group-toggle-btn--active' : ''}`}
                onClick={() => setIsGroupedBySubject((v) => !v)}
                title="Toggle grouping by subject sections"
              >
                {isGroupedBySubject ? '📁 Grouped by Subject' : '📄 Flat List'}
              </button>
            </div>
          </div>
        )}

        {/* ─── Quizzes Content ───────────────────────────────────────────────── */}
        {loading ? (
          <div className="qm-loading">
            <div className="qm-spinner" />
            <p>Loading assessment hub...</p>
          </div>
        ) : quizzes.length === 0 ? (
          <div className="qm-empty-card animate-scale-up">
            <div className="qm-empty-icon">🎓</div>
            <h2 className="qm-empty-title">No Interactive Quizzes Published Yet</h2>
            <p className="qm-empty-desc">
              You haven't converted any of your saved tests into an interactive quiz yet.
              Click the button below to pick a saved test and set up student access codes and security rules.
            </p>
            <div className="qm-empty-actions">
              <button
                type="button"
                className="qm-btn qm-btn-primary qm-btn-quizizz-top"
                onClick={() => handleOpenCreateModal('game')}
              >
                🎮 Create First Quizizz Game
              </button>
              <button
                type="button"
                className="qm-btn qm-btn-secondary"
                onClick={() => handleOpenCreateModal('exam')}
              >
                📝 Publish Formal Exam
              </button>
              {savedTests.length === 0 ? (
                <button
                  type="button"
                  className="qm-btn qm-btn-secondary"
                  onClick={onNavigateToBuilder}
                >
                  📝 Open Test Builder
                </button>
              ) : (
                <button
                  type="button"
                  className="qm-btn qm-btn-secondary"
                  onClick={onNavigateToSaved}
                >
                  📂 View Saved Tests
                </button>
              )}
            </div>
          </div>
        ) : filteredQuizzes.length === 0 ? (
          <div className="qm-no-results-card">
            <p>No quizzes matched your search or subject filter.</p>
            <button
              type="button"
              className="qm-btn qm-btn-secondary"
              onClick={() => {
                setSelectedSubject('all');
                setSearchQuery('');
              }}
            >
              Reset Filters
            </button>
          </div>
        ) : isGroupedBySubject && selectedSubject === 'all' ? (
          /* Render Grouped by Subject Sections */
          <div className="qm-subject-sections-list">
            {Array.from(groupedBySubject.entries()).map(([subj, subjQuizzes]) => (
              <section key={subj} className="qm-subject-section">
                <div className="qm-section-header">
                  <div className="qm-section-title-wrap">
                    <span className="qm-section-icon">📚</span>
                    <h2 className="qm-section-title">{subj}</h2>
                    <span className="qm-section-count-badge">
                      {subjQuizzes.length} quiz{subjQuizzes.length !== 1 ? 'zes' : ''}
                    </span>
                  </div>
                </div>

                <div className="qm-quizzes-grid">
                  {subjQuizzes.map(renderQuizCard)}
                </div>
              </section>
            ))}
          </div>
        ) : (
          /* Render Flat Grid */
          <div className="qm-quizzes-grid">
            {filteredQuizzes.map(renderQuizCard)}
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
      {isConfigModalOpen && activeQuizDraft && (
        <div className="qm-modal-backdrop animate-fade-in" onClick={() => setIsConfigModalOpen(false)}>
          <div className="qm-modal-card animate-scale-up" onClick={(e) => e.stopPropagation()}>
            <div className="qm-modal-header">
              <div>
                <h2 className="qm-modal-title">Configure Interactive Quiz Settings</h2>
                <p className="qm-modal-sub">Set up student access code, subject, timer rules, and anti-cheating controls</p>
              </div>
              <button
                type="button"
                className="qm-modal-close"
                onClick={() => setIsConfigModalOpen(false)}
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
                  value={selectedTestId}
                  onChange={(e) => handleSelectSavedTest(e.target.value)}
                >
                  {savedTests.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title} ({t.primarySubject || t.header_config?.subject || 'Chemistry'} • {t.question_ids?.length || 0} questions • {t.total_marks} marks)
                    </option>
                  ))}
                </select>
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
                <span className="qm-form-hint">
                  Students will use this exact code to join on the landing page.
                </span>
              </div>

              {/* Step 4: Assessment Format (Formal Exam vs Quizizz Game) */}
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

              {/* Conditional Settings based on quizMode */}
              {activeQuizDraft.quizMode === 'game' ? (
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
                      <span>🔊 Fun Synthesized Sound FX & Airhorns</span>
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
                      <span>🎉 Meme Reactions & Emoji Feedback</span>
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
                            durationMinutes: Math.max(5, parseInt(e.target.value, 10) || 45),
                          })
                        }
                        min={5}
                        max={300}
                      />
                    </div>

                    <div className="qm-form-group" style={{ flex: 1 }}>
                      <label className="qm-form-label">Assessment Mode:</label>
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
                        <option value="exam">⏱️ Timed Exam Mode</option>
                        <option value="practice">💡 Self-Paced Practice</option>
                      </select>
                    </div>
                  </div>

                  {/* Anti-Cheating & Security Controls */}
                  <div className="qm-security-toggle-card">
                    <div className="qm-sec-header">
                      <span className="sec-icon">🔒</span>
                      <div>
                        <strong>Anti-Cheating & Exam Browser Lock</strong>
                        <p>Enforces fullscreen view, tracks Alt+Tab / tab switching, and blocks copy/paste.</p>
                      </div>
                      <label className="qm-switch">
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
                      <div className="qm-sec-subrules">
                        <div className="sec-rule-item">✓ Mandatory Fullscreen prompt on start</div>
                        <div className="sec-rule-item">✓ Real-time Alt+Tab and window blur strikes</div>
                        <div className="sec-rule-item">✓ Disabled Right-Click, F12 inspect, and Copy/Paste</div>
                        <div className="sec-rule-item">✓ Timestamped Proctoring Audit Trail on teacher results</div>
                      </div>
                    )}
                  </div>

                  {/* Show Instant Solutions */}
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
                </>
              )}
            </div>

            <div className="qm-modal-footer">
              <button
                type="button"
                className="qm-btn qm-btn-secondary"
                onClick={() => setIsConfigModalOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="qm-btn qm-btn-primary"
                onClick={handleSaveQuizConfig}
              >
                🚀 Save & Publish Quiz
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
