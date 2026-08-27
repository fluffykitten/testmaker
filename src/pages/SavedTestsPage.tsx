import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  fetchCustomTestsWithMetadata,
  fetchCustomTestWithQuestions,
  deleteCustomTest,
  type ExamHeaderConfig,
  type CustomTestWithDetails,
} from '../services/testBuilderService';
import { ExportModal } from '../components/ExportModal';
import { OfflineGradingModal } from '../components/OfflineGradingModal';
import type { Question } from '../types/database';
import './SavedTestsPage.css';

interface SavedTestsPageProps {
  onLoadTestIntoBuilder: (questions: Question[]) => void;
  onNavigateToBuilder: () => void;
  onNavigateToBank: () => void;
  onNavigateToQuizzes?: () => void;
}

export function SavedTestsPage({
  onLoadTestIntoBuilder,
  onNavigateToBuilder,
  onNavigateToBank,
  onNavigateToQuizzes,
}: SavedTestsPageProps) {
  const [tests, setTests] = useState<CustomTestWithDetails[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [loadingTestId, setLoadingTestId] = useState<string | null>(null);

  // 1st Level: Selected Subject (defaults to 'all' or first available subject)
  const [selectedSubject, setSelectedSubject] = useState<string>('all');

  // 2nd Level: Topic Filtering & Grouping within that Subject
  const [isGroupedByTopic, setIsGroupedByTopic] = useState<boolean>(true);
  const [activeTopicFilter, setActiveTopicFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const [exportData, setExportData] = useState<{
    headerConfig: ExamHeaderConfig;
    questions: Question[];
  } | null>(null);

  const [offlineGradingData, setOfflineGradingData] = useState<{
    headerConfig: ExamHeaderConfig;
    questions: Question[];
  } | null>(null);

  const loadTests = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchCustomTestsWithMetadata();
      setTests(data);
    } catch (err: any) {
      setError(err?.message || 'Failed to load saved tests');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadTests();
  }, [loadTests]);

  const handleOpenTest = async (test: CustomTestWithDetails) => {
    setLoadingTestId(test.id);
    try {
      const resolved = await fetchCustomTestWithQuestions(test.id);
      if (resolved && resolved.questions.length > 0) {
        onLoadTestIntoBuilder(resolved.questions);
        onNavigateToBuilder();
      } else {
        alert('This saved test has no questions associated with it.');
      }
    } catch (err: any) {
      alert(`Failed to load test questions: ${err?.message || 'Unknown error'}`);
    } finally {
      setLoadingTestId(null);
    }
  };

  const handleExportTest = async (test: CustomTestWithDetails) => {
    setLoadingTestId(test.id);
    try {
      const resolved = await fetchCustomTestWithQuestions(test.id);
      if (resolved && resolved.questions.length > 0) {
        setExportData({
          headerConfig: {
            title: test.title || 'Custom Exam Assessment',
            schoolName: '',
            subject: test.primarySubject || 'General Assessment',
            subjectCode: '',
            durationMinutes: Math.round((test.total_marks || 20) * 1.25),
            instructions: 'Answer all questions. Write your answers in the spaces provided on the question paper.',
            additionalMaterials: 'Periodic Table / Formula Sheet (if applicable)',
          },
          questions: resolved.questions,
        });
      } else {
        alert('This saved test has no questions to export.');
      }
    } catch (err: any) {
      alert(`Failed to prepare export: ${err?.message || 'Unknown error'}`);
    } finally {
      setLoadingTestId(null);
    }
  };

  const handleGradeOffline = async (test: CustomTestWithDetails) => {
    setLoadingTestId(test.id);
    try {
      const resolved = await fetchCustomTestWithQuestions(test.id);
      if (resolved && resolved.questions.length > 0) {
        setOfflineGradingData({
          headerConfig: {
            title: test.title || 'Offline Exam Assessment',
            schoolName: '',
            subject: test.primarySubject || 'General Assessment',
            subjectCode: '',
            durationMinutes: Math.round((test.total_marks || 20) * 1.25),
            instructions: 'Answer all questions.',
            additionalMaterials: '',
          },
          questions: resolved.questions,
        });
      } else {
        alert('This saved test has no questions to grade.');
      }
    } catch (err: any) {
      alert(`Failed to prepare offline grading: ${err?.message || 'Unknown error'}`);
    } finally {
      setLoadingTestId(null);
    }
  };

  const handleDeleteTest = async (testId: string) => {
    if (!confirm('Are you sure you want to delete this custom exam?')) return;

    setDeletingId(testId);
    try {
      const ok = await deleteCustomTest(testId);
      if (ok) {
        setTests((prev) => prev.filter((t) => t.id !== testId));
      } else {
        alert('Failed to delete custom test from database.');
      }
    } finally {
      setDeletingId(null);
    }
  };

  // 1. All unique available subjects
  const availableSubjects = useMemo(() => {
    const set = new Set<string>();
    tests.forEach((t) => {
      t.subjects.forEach((s) => set.add(s));
    });
    return Array.from(set).sort();
  }, [tests]);

  // 2. Tests filtered by Subject selection
  const subjectFilteredTests = useMemo(() => {
    if (selectedSubject === 'all') return tests;
    return tests.filter(
      (t) => t.subjects.includes(selectedSubject) || t.primarySubject === selectedSubject
    );
  }, [tests, selectedSubject]);

  // 3. Topics available STRICTLY within the selected subject
  const availableTopicsForSubject = useMemo(() => {
    const set = new Set<string>();
    subjectFilteredTests.forEach((t) => {
      t.topics.forEach((top) => set.add(top));
    });
    return Array.from(set).sort();
  }, [subjectFilteredTests]);

  // 4. Tests filtered by Subject + Topic Filter + Search Query
  const finalFilteredList = useMemo(() => {
    return subjectFilteredTests.filter((t) => {
      const query = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !query ||
        t.title.toLowerCase().includes(query) ||
        t.primaryTopic.toLowerCase().includes(query) ||
        t.primarySubject.toLowerCase().includes(query) ||
        t.topics.some((top) => top.toLowerCase().includes(query)) ||
        t.subjects.some((sub) => sub.toLowerCase().includes(query));

      if (!matchesSearch) return false;

      if (activeTopicFilter === 'all') return true;

      return t.topics.includes(activeTopicFilter) || t.primaryTopic === activeTopicFilter;
    });
  }, [subjectFilteredTests, searchQuery, activeTopicFilter]);

  // 5. Group tests by Topic within the active subject
  const groupedTopicSections = useMemo(() => {
    if (!isGroupedByTopic) {
      return { 'All Assessments': finalFilteredList };
    }

    const map: Record<string, CustomTestWithDetails[]> = {};

    finalFilteredList.forEach((test) => {
      const key = test.primaryTopic || 'General';
      if (!map[key]) map[key] = [];
      map[key].push(test);
    });

    return map;
  }, [finalFilteredList, isGroupedByTopic]);

  const groupKeys = Object.keys(groupedTopicSections).sort((a, b) => {
    if (a === 'Multi-Topic') return 1;
    if (b === 'Multi-Topic') return -1;
    return a.localeCompare(b);
  });

  return (
    <div className="saved-page">
      <div className="saved-container">
        {/* ─── Page Header ─────────────────────────────────────────────────── */}
        <div className="saved-header animate-fade-in">
          <div>
            <h1 className="saved-title">Saved Exams & Tests</h1>
            <p className="saved-subtitle">
              Select a subject to view its topic breakdowns, explore saved assessments, and export Word/PDF papers.
            </p>
          </div>

          <button
            type="button"
            className="saved-new-btn"
            onClick={onNavigateToBank}
          >
            + Create New Exam
          </button>
        </div>

        {/* ─── 1st Level: Subject Selection Bar ────────────────────────────── */}
        {!isLoading && !error && tests.length > 0 && (
          <div className="saved-subject-bar animate-fade-in">
            <span className="saved-subject-label">Select Subject:</span>
            <div className="saved-subject-tabs">
              <button
                type="button"
                className={`saved-subject-tab ${selectedSubject === 'all' ? 'saved-subject-tab--active' : ''}`}
                onClick={() => {
                  setSelectedSubject('all');
                  setActiveTopicFilter('all');
                }}
              >
                🌐 All Subjects ({tests.length})
              </button>

              {availableSubjects.map((subj) => {
                const count = tests.filter(
                  (t) => t.subjects.includes(subj) || t.primarySubject === subj
                ).length;

                return (
                  <button
                    key={subj}
                    type="button"
                    className={`saved-subject-tab ${selectedSubject === subj ? 'saved-subject-tab--active' : ''}`}
                    onClick={() => {
                      setSelectedSubject(subj);
                      setActiveTopicFilter('all');
                    }}
                  >
                    📚 {subj} ({count})
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ─── 2nd Level: Topic Controls (Scoped strictly to Selected Subject) ── */}
        {!isLoading && !error && subjectFilteredTests.length > 0 && (
          <div className="saved-controls-card animate-fade-in">
            <div className="saved-controls-top">
              {/* Grouping Toggle */}
              <div className="saved-group-toggle">
                <span className="saved-group-label">View Mode:</span>
                <button
                  type="button"
                  className={`saved-group-btn ${isGroupedByTopic ? 'saved-group-btn--active' : ''}`}
                  onClick={() => setIsGroupedByTopic(true)}
                  title="Group tests by topic sections"
                >
                  🏷️ Group by Topic
                </button>
                <button
                  type="button"
                  className={`saved-group-btn ${!isGroupedByTopic ? 'saved-group-btn--active' : ''}`}
                  onClick={() => setIsGroupedByTopic(false)}
                  title="Show all tests in a flat list"
                >
                  📋 Flat Grid
                </button>
              </div>

              {/* Search Bar */}
              <div className="saved-search-box">
                <span className="saved-search-icon">🔍</span>
                <input
                  type="text"
                  className="saved-search-input"
                  placeholder={`Search ${selectedSubject === 'all' ? 'all' : selectedSubject} tests…`}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="saved-search-clear"
                    onClick={() => setSearchQuery('')}
                  >
                    ✕
                  </button>
                )}
              </div>
            </div>

            {/* Subject-Scoped Topic Filter Pills */}
            {availableTopicsForSubject.length > 1 && (
              <div className="saved-filter-pills">
                <span className="saved-pills-label">Topics in {selectedSubject === 'all' ? 'All Subjects' : selectedSubject}:</span>
                <button
                  type="button"
                  className={`saved-filter-pill ${activeTopicFilter === 'all' ? 'saved-filter-pill--active' : ''}`}
                  onClick={() => setActiveTopicFilter('all')}
                >
                  All Topics ({subjectFilteredTests.length})
                </button>
                {availableTopicsForSubject.map((top) => {
                  const count = subjectFilteredTests.filter(
                    (t) => t.topics.includes(top) || t.primaryTopic === top
                  ).length;

                  return (
                    <button
                      key={top}
                      type="button"
                      className={`saved-filter-pill ${activeTopicFilter === top ? 'saved-filter-pill--active' : ''}`}
                      onClick={() => setActiveTopicFilter(top)}
                    >
                      🏷️ {top} ({count})
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Loading State */}
        {isLoading && (
          <div className="saved-skeleton-grid">
            {[1, 2, 3].map((n) => (
              <div key={n} className="saved-skeleton-card animate-pulse" />
            ))}
          </div>
        )}

        {/* Error State */}
        {!isLoading && error && (
          <div className="saved-error animate-fade-in">
            <span>⚠️</span>
            <p>{error}</p>
            <button
              type="button"
              className="saved-btn saved-btn--secondary"
              onClick={loadTests}
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty State */}
        {!isLoading && !error && tests.length === 0 && (
          <div className="saved-empty animate-fade-in">
            <div className="saved-empty-icon">📁</div>
            <h2 className="saved-empty-title">No Saved Exams Found</h2>
            <p className="saved-empty-desc">
              You haven't saved any custom tests yet. Select questions from the Question Bank and save them in the Test Builder to organize them here by topic and subject.
            </p>
            <button
              type="button"
              className="saved-btn saved-btn--primary"
              onClick={onNavigateToBank}
            >
              Browse Question Bank
            </button>
          </div>
        )}

        {/* No Matches Filter State */}
        {!isLoading && !error && tests.length > 0 && finalFilteredList.length === 0 && (
          <div className="saved-empty animate-fade-in">
            <div className="saved-empty-icon">🔎</div>
            <h2 className="saved-empty-title">No Matching Exams</h2>
            <p className="saved-empty-desc">
              No saved tests match your search criteria in {selectedSubject === 'all' ? 'all subjects' : selectedSubject}. Try adjusting your search query or reset your filter.
            </p>
            <button
              type="button"
              className="saved-btn saved-btn--secondary"
              onClick={() => {
                setSearchQuery('');
                setActiveTopicFilter('all');
                setSelectedSubject('all');
              }}
            >
              Reset All Filters
            </button>
          </div>
        )}

        {/* ─── Grouped Topic Sections ──────────────────────────────────────── */}
        {!isLoading && !error && finalFilteredList.length > 0 && (
          <div className="saved-sections-wrapper">
            {groupKeys.map((groupName) => {
              const groupTests = groupedTopicSections[groupName] || [];
              if (groupTests.length === 0) return null;

              const isMultiTopic = groupName === 'Multi-Topic';
              const isAll = groupName === 'All Assessments';

              return (
                <section key={groupName} className="saved-group-section animate-fade-in">
                  <div className="saved-group-header">
                    <div className="saved-group-title-row">
                      <span className="saved-group-icon">
                        {isAll ? '📋' : isMultiTopic ? '🎯' : '🧪'}
                      </span>
                      <h2 className="saved-group-name">{groupName}</h2>
                      <span className="saved-group-count">
                        {groupTests.length} exam{groupTests.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                  </div>

                  <div className="saved-grid">
                    {groupTests.map((test) => {
                      const qCount = test.question_ids?.length || 0;
                      const dateFormatted = new Date(test.created_at).toLocaleDateString('en-US', {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      });

                      return (
                        <div key={test.id} className="saved-card">
                          <div className="saved-card-header">
                            <div className="saved-card-badge-row">
                              <span className="saved-badge saved-badge--marks">
                                {test.total_marks || 0} Marks
                              </span>
                              <span className="saved-badge saved-badge--count">
                                {qCount} Question{qCount !== 1 ? 's' : ''}
                              </span>
                            </div>

                            <span className="saved-card-date">{dateFormatted}</span>
                          </div>

                          <h3 className="saved-card-title">{test.title || 'Untitled Assessment'}</h3>

                          {/* Topic & Subject Pill Tags */}
                          <div className="saved-card-topics">
                            {test.subjects.map((sub) => (
                              <span key={sub} className="saved-tag saved-tag--subject" title="Subject">
                                📖 {sub}
                              </span>
                            ))}
                            {test.topics.slice(0, 3).map((top) => (
                              <span key={top} className="saved-tag saved-tag--topic" title="Topic">
                                🏷️ {top}
                              </span>
                            ))}
                            {test.topics.length > 3 && (
                              <span className="saved-tag saved-tag--more" title={test.topics.slice(3).join(', ')}>
                                +{test.topics.length - 3} more
                              </span>
                            )}
                          </div>

                          <div className="saved-card-footer">
                            <button
                              type="button"
                              className="saved-card-btn saved-card-btn--open"
                              onClick={() => handleOpenTest(test)}
                              disabled={loadingTestId === test.id}
                            >
                              {loadingTestId === test.id ? 'Loading…' : '✏️ Open in Builder'}
                            </button>

                            <button
                              type="button"
                              className="saved-card-btn saved-card-btn--export"
                              onClick={() => handleExportTest(test)}
                              disabled={loadingTestId === test.id}
                              title="Export Word / PDF"
                            >
                              ⚡ Export
                            </button>

                            <button
                              type="button"
                              className="saved-card-btn saved-card-btn--grade"
                              onClick={() => handleGradeOffline(test)}
                              disabled={loadingTestId === test.id}
                              title="Grade offline paper exam via Excel or Rapid Grid"
                            >
                              📊 Grade Offline
                            </button>

                            <button
                              type="button"
                              className="saved-card-btn saved-card-btn--delete"
                              onClick={() => handleDeleteTest(test.id)}
                              disabled={deletingId === test.id}
                              title="Delete saved test"
                            >
                              {deletingId === test.id ? '…' : '🗑️'}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </div>

      {/* Export Modal */}
      {exportData && (
        <ExportModal
          isOpen={true}
          onClose={() => setExportData(null)}
          headerConfig={exportData.headerConfig}
          questions={exportData.questions}
        />
      )}

      {/* Offline Grading Modal */}
      {offlineGradingData && (
        <OfflineGradingModal
          isOpen={true}
          onClose={() => setOfflineGradingData(null)}
          headerConfig={offlineGradingData.headerConfig}
          questions={offlineGradingData.questions}
          onViewInGradebook={() => {
            setOfflineGradingData(null);
            if (onNavigateToQuizzes) onNavigateToQuizzes();
          }}
        />
      )}
    </div>
  );
}
