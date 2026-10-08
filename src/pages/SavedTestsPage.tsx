import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  fetchCustomTestsWithMetadata,
  fetchCustomTestWithQuestions,
  deleteCustomTest,
  getLocalTests,
  type ExamHeaderConfig,
  type CustomTestWithDetails,
} from '../services/testBuilderService';
import { ExportModal } from '../components/ExportModal';
import { OfflineGradingModal } from '../components/OfflineGradingModal';
import { ConfirmDeleteModal } from '../components/ConfirmDeleteModal';
import { GoogleFormsExportModal } from '../components/GoogleFormsExportModal';
import { ExamVariantModal } from '../components/ExamVariantModal';
import type { Question, CustomTest } from '../types/database';
import { SubjectIcon, getSubjectMetadata } from '../utils/subjectMeta';
import './SavedTestsPage.css';

interface SavedTestsPageProps {
  onLoadTestIntoBuilder: (questions: Question[], headerConfig?: ExamHeaderConfig, testId?: string) => void;
  onNavigateToBuilder: () => void;
  onNavigateToBank: () => void;
  onNavigateToQuizzes?: () => void;
}

type SortOption = 'latest' | 'oldest' | 'title' | 'marks' | 'questions';

export function SavedTestsPage({
  onLoadTestIntoBuilder,
  onNavigateToBuilder,
  onNavigateToBank,
  onNavigateToQuizzes,
}: SavedTestsPageProps) {
  const [tests, setTests] = useState<CustomTestWithDetails[]>(() => {
    try {
      const local = getLocalTests();
      return local.map((t: CustomTest) => ({
        ...t,
        topics: [],
        subjects: t.header_config?.subject ? [t.header_config.subject] : ['General'],
        primaryTopic: 'General',
        primarySubject: t.header_config?.subject || 'General',
      }));
    } catch {
      return [];
    }
  });

  const [isLoading, setIsLoading] = useState(() => tests.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteModalState, setDeleteModalState] = useState<{ isOpen: boolean; testId: string; title: string }>({
    isOpen: false,
    testId: '',
    title: '',
  });
  const [loadingTestId, setLoadingTestId] = useState<string | null>(null);

  // ─── Two-Level Architecture State ───────────────────────────────────────────
  // Level 1: activeSubjectView === null (Show Subject Cards Hub)
  // Level 2: activeSubjectView === 'all' | '<SubjectName>' (Show Clean Exam List)
  const [activeSubjectView, setActiveSubjectView] = useState<string | null>(null);

  // Level 2 Controls
  const [activeTopicFilter, setActiveTopicFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isGroupedByTopic, setIsGroupedByTopic] = useState<boolean>(false);
  const [sortBy, setSortBy] = useState<SortOption>('latest');
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  // Mobile / Touch dropdown actions menu state
  const [openMobileMenuId, setOpenMobileMenuId] = useState<string | null>(null);

  // Modals state
  const [exportData, setExportData] = useState<{
    headerConfig: ExamHeaderConfig;
    questions: Question[];
  } | null>(null);

  const [offlineGradingData, setOfflineGradingData] = useState<{
    headerConfig: ExamHeaderConfig;
    questions: Question[];
  } | null>(null);

  const [googleFormsData, setGoogleFormsData] = useState<{
    headerConfig: ExamHeaderConfig;
    questions: Question[];
  } | null>(null);

  const [variantData, setVariantData] = useState<{
    headerConfig: ExamHeaderConfig;
    questions: Question[];
  } | null>(null);

  const toggleGroupCollapse = useCallback((groupName: string) => {
    setCollapsedGroups((prev) => ({
      ...prev,
      [groupName]: !prev[groupName],
    }));
  }, []);

  const loadTests = useCallback(async () => {
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

    const handleTestsUpdated = () => {
      loadTests();
    };

    window.addEventListener('tests_updated', handleTestsUpdated);
    return () => {
      window.removeEventListener('tests_updated', handleTestsUpdated);
    };
  }, [loadTests]);

  // Keyboard navigation: Escape key returns to Subject Hub
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && activeSubjectView !== null && !deleteModalState.isOpen && !exportData && !offlineGradingData && !googleFormsData && !variantData) {
        setActiveSubjectView(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeSubjectView, deleteModalState.isOpen, exportData, offlineGradingData, googleFormsData, variantData]);

  // ─── Actions Handlers ───────────────────────────────────────────────────────
  const handleOpenTest = async (test: CustomTestWithDetails) => {
    setLoadingTestId(test.id);
    try {
      const resolved = await fetchCustomTestWithQuestions(test.id);
      if (resolved && resolved.questions.length > 0) {
        const effectiveHeader: ExamHeaderConfig = {
          title: test.header_config?.title || test.title || 'Custom Exam Assessment',
          schoolName: test.header_config?.schoolName || '',
          subject: test.header_config?.subject || test.primarySubject || 'General',
          subjectCode: test.header_config?.subjectCode || '',
          durationMinutes: test.header_config?.durationMinutes || Math.round((test.total_marks || 20) * 1.25),
          instructions: test.header_config?.instructions || 'Answer all questions. Write your answers in the spaces provided on the question paper.',
          additionalMaterials: test.header_config?.additionalMaterials || '',
          layoutTemplate: test.header_config?.layoutTemplate,
          teacherPin: test.header_config?.teacherPin,
        };
        onLoadTestIntoBuilder(resolved.questions, effectiveHeader, test.id);
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
            title: test.header_config?.title || test.title || 'Custom Exam Assessment',
            schoolName: test.header_config?.schoolName || '',
            subject: test.header_config?.subject || test.primarySubject || 'General',
            subjectCode: test.header_config?.subjectCode || '',
            durationMinutes: test.header_config?.durationMinutes || Math.round((test.total_marks || 20) * 1.25),
            instructions: test.header_config?.instructions || 'Answer all questions. Write your answers in the spaces provided on the question paper.',
            additionalMaterials: test.header_config?.additionalMaterials || 'Periodic Table / Formula Sheet (if applicable)',
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
            title: test.header_config?.title || test.title || 'Offline Exam Assessment',
            schoolName: test.header_config?.schoolName || '',
            subject: test.header_config?.subject || test.primarySubject || 'General',
            subjectCode: test.header_config?.subjectCode || '',
            durationMinutes: test.header_config?.durationMinutes || Math.round((test.total_marks || 20) * 1.25),
            instructions: test.header_config?.instructions || 'Answer all questions.',
            additionalMaterials: test.header_config?.additionalMaterials || '',
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

  const handleGoogleFormsExport = async (test: CustomTestWithDetails) => {
    setLoadingTestId(test.id);
    try {
      const resolved = await fetchCustomTestWithQuestions(test.id);
      if (resolved && resolved.questions.length > 0) {
        setGoogleFormsData({
          headerConfig: {
            title: test.header_config?.title || test.title || 'Custom Exam Assessment',
            schoolName: test.header_config?.schoolName || '',
            subject: test.header_config?.subject || test.primarySubject || 'General',
            subjectCode: test.header_config?.subjectCode || '',
            durationMinutes: test.header_config?.durationMinutes || Math.round((test.total_marks || 20) * 1.25),
            instructions: test.header_config?.instructions || 'Answer all questions. Write your answers clearly.',
            additionalMaterials: test.header_config?.additionalMaterials || '',
          },
          questions: resolved.questions,
        });
      } else {
        alert('This saved test has no questions to export.');
      }
    } catch (err: any) {
      alert(`Failed to prepare Google Forms export: ${err?.message || 'Unknown error'}`);
    } finally {
      setLoadingTestId(null);
    }
  };

  const handleGenerateVariant = async (test: CustomTestWithDetails) => {
    setLoadingTestId(test.id);
    try {
      const resolved = await fetchCustomTestWithQuestions(test.id);
      if (resolved && resolved.questions.length > 0) {
        setVariantData({
          headerConfig: {
            title: test.header_config?.title || test.title || 'Exam Assessment',
            schoolName: test.header_config?.schoolName || '',
            subject: test.header_config?.subject || test.primarySubject || 'General',
            subjectCode: test.header_config?.subjectCode || '',
            durationMinutes: test.header_config?.durationMinutes || Math.round((test.total_marks || 20) * 1.25),
            instructions: test.header_config?.instructions || 'Answer all questions. Write your answers clearly.',
            additionalMaterials: test.header_config?.additionalMaterials || '',
            layoutTemplate: test.header_config?.layoutTemplate,
          },
          questions: resolved.questions,
        });
      } else {
        alert('This saved test has no questions to generate variants from.');
      }
    } catch (err: any) {
      alert(`Failed to prepare variant generation: ${err?.message || 'Unknown error'}`);
    } finally {
      setLoadingTestId(null);
    }
  };

  const handleDeleteTest = (testId: string, title: string) => {
    setDeleteModalState({ isOpen: true, testId, title });
    setOpenMobileMenuId(null);
  };

  const handleConfirmDelete = async () => {
    const { testId } = deleteModalState;
    if (!testId) return;

    setDeletingId(testId);
    try {
      const ok = await deleteCustomTest(testId);
      if (!ok) {
        alert('Failed to delete custom test from database.');
      }
    } catch (err: any) {
      alert(`Failed to delete custom test: ${err?.message || 'Unknown error'}`);
    } finally {
      setDeletingId(null);
      setDeleteModalState({ isOpen: false, testId: '', title: '' });
    }
  };

  // ─── Data Aggregation for Subject Hub (Level 1) ────────────────────────────
  const subjectSummaries = useMemo(() => {
    const map = new Map<
      string,
      {
        subjectName: string;
        examCount: number;
        totalQuestions: number;
        totalMarks: number;
        topicsSet: Set<string>;
        latestDate: number;
      }
    >();

    tests.forEach((t) => {
      const sub = t.primarySubject || (t.subjects[0] ?? 'General');
      const existing = map.get(sub) || {
        subjectName: sub,
        examCount: 0,
        totalQuestions: 0,
        totalMarks: 0,
        topicsSet: new Set<string>(),
        latestDate: 0,
      };

      existing.examCount += 1;
      existing.totalQuestions += t.question_ids?.length || 0;
      existing.totalMarks += t.total_marks || 0;
      t.topics.forEach((top) => existing.topicsSet.add(top));
      if (t.primaryTopic) existing.topicsSet.add(t.primaryTopic);

      const d = new Date(t.created_at).getTime();
      if (d > existing.latestDate) existing.latestDate = d;

      map.set(sub, existing);
    });

    return Array.from(map.values()).sort((a, b) => b.examCount - a.examCount);
  }, [tests]);

  // ─── Filtered Data for Drill-Down (Level 2) ────────────────────────────────
  const subjectFilteredTests = useMemo(() => {
    if (!activeSubjectView || activeSubjectView === 'all') return tests;
    return tests.filter(
      (t) => t.subjects.includes(activeSubjectView) || t.primarySubject === activeSubjectView
    );
  }, [tests, activeSubjectView]);

  // Topics available strictly within current subject drill-down
  const availableTopicsForSubject = useMemo(() => {
    const set = new Set<string>();
    subjectFilteredTests.forEach((t) => {
      t.topics.forEach((top) => set.add(top));
      if (t.primaryTopic && t.primaryTopic !== 'General') set.add(t.primaryTopic);
    });
    return Array.from(set).sort();
  }, [subjectFilteredTests]);

  // Filtered by Search & Topic
  const finalFilteredList = useMemo(() => {
    const list = subjectFilteredTests.filter((t) => {
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

    // Sorting
    return list.sort((a, b) => {
      switch (sortBy) {
        case 'latest':
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        case 'oldest':
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case 'title':
          return a.title.localeCompare(b.title);
        case 'marks':
          return (b.total_marks || 0) - (a.total_marks || 0);
        case 'questions':
          return (b.question_ids?.length || 0) - (a.question_ids?.length || 0);
        default:
          return 0;
      }
    });
  }, [subjectFilteredTests, searchQuery, activeTopicFilter, sortBy]);

  // Grouping by Topic
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

  const groupKeys = useMemo(() => {
    return Object.keys(groupedTopicSections).sort((a, b) => {
      if (a === 'Multi-Topic') return 1;
      if (b === 'Multi-Topic') return -1;
      if (a === 'General') return 1;
      if (b === 'General') return -1;
      return a.localeCompare(b);
    });
  }, [groupedTopicSections]);

  const areAllCollapsed = useMemo(() => {
    if (groupKeys.length === 0) return false;
    return groupKeys.every((k) => !!collapsedGroups[k]);
  }, [groupKeys, collapsedGroups]);

  const toggleAllGroups = useCallback(() => {
    if (areAllCollapsed) {
      setCollapsedGroups({});
    } else {
      const allCollapsed: Record<string, boolean> = {};
      groupKeys.forEach((k) => {
        allCollapsed[k] = true;
      });
      setCollapsedGroups(allCollapsed);
    }
  }, [areAllCollapsed, groupKeys]);

  const activeSubjectMeta = activeSubjectView && activeSubjectView !== 'all'
    ? getSubjectMetadata(activeSubjectView)
    : null;

  return (
    <div className="saved-page" onClick={() => setOpenMobileMenuId(null)}>
      <div className="saved-container">
        {/* Loading State */}
        {isLoading && (
          <div className="saved-skeleton-grid animate-fade-in">
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <div key={n} className="saved-skeleton-card animate-pulse" />
            ))}
          </div>
        )}

        {/* Error State */}
        {!isLoading && error && (
          <div className="saved-error animate-fade-in">
            <div className="saved-error-icon">⚠️</div>
            <div className="saved-error-body">
              <h3 className="saved-error-title">Failed to load saved tests</h3>
              <p className="saved-error-msg">{error}</p>
            </div>
            <button
              type="button"
              className="saved-btn saved-btn--secondary"
              onClick={loadTests}
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty State (Global) */}
        {!isLoading && !error && tests.length === 0 && (
          <div className="saved-empty-state animate-fade-in">
            <div className="saved-empty-visual">
              <SubjectIcon subject="general" size={48} />
            </div>
            <h2 className="saved-empty-heading">No Saved Exams Found</h2>
            <p className="saved-empty-text">
              You haven't saved any custom tests yet. Select questions from the Question Bank and save them in the Test Builder to automatically organize them into departments and topics here.
            </p>
            <div className="saved-empty-actions">
              <button
                type="button"
                className="saved-btn saved-btn--primary"
                onClick={onNavigateToBank}
              >
                Browse Question Bank
              </button>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════════
            LEVEL 1: SUBJECT HUB OVERVIEW (When activeSubjectView === null)
        ═══════════════════════════════════════════════════════════════════════ */}
        {!isLoading && !error && tests.length > 0 && activeSubjectView === null && (
          <div className="saved-hub-view animate-fade-in">
            {/* Hub Header */}
            <header className="saved-hub-header">
              <div className="saved-hub-header-left">
                <h1 className="saved-hub-title">Saved Exams &amp; Tests</h1>
                <p className="saved-hub-subtitle">
                  Browse {tests.length} assessment{tests.length !== 1 ? 's' : ''} organized across {subjectSummaries.length} academic departments. Click a subject to explore its tests and export papers.
                </p>
              </div>

              <div className="saved-hub-header-actions">
                <button
                  type="button"
                  className="saved-btn saved-btn--secondary"
                  onClick={() => {
                    setActiveSubjectView('all');
                    setActiveTopicFilter('all');
                    setSearchQuery('');
                  }}
                  title="View all exams in a comprehensive clean list"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="7" height="7" />
                    <rect x="14" y="3" width="7" height="7" />
                    <rect x="14" y="14" width="7" height="7" />
                    <rect x="3" y="14" width="7" height="7" />
                  </svg>
                  <span>All Exams ({tests.length})</span>
                </button>

                <button
                  type="button"
                  className="saved-btn saved-btn--primary"
                  onClick={onNavigateToBank}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  <span>Create New Exam</span>
                </button>
              </div>
            </header>

            {/* Subject Cards Grid */}
            <div className="saved-subject-grid">
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
                    className="saved-subject-card"
                    style={{ '--subject-accent': meta.color } as React.CSSProperties}
                    onClick={() => {
                      setActiveSubjectView(summary.subjectName);
                      setActiveTopicFilter('all');
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
                    {/* Card Top Row: Subject Logo Badge & Syllabus Code */}
                    <div className="saved-subject-card-top">
                      <div
                        className="saved-subject-logo-badge"
                        style={{
                          backgroundColor: meta.bgLight,
                          borderColor: meta.borderLight,
                        }}
                      >
                        <SubjectIcon subject={summary.subjectName} size={28} />
                      </div>

                      <span className="saved-subject-code-pill">
                        {meta.code}
                      </span>
                    </div>

                    {/* Subject Title & Description */}
                    <div className="saved-subject-card-body">
                      <h2 className="saved-subject-card-title">{summary.subjectName}</h2>
                      <p className="saved-subject-card-desc">{meta.description}</p>
                    </div>

                    {/* Metrics Row: Exams, Topics, Questions */}
                    <div className="saved-subject-metrics">
                      <div className="saved-subject-metric-item">
                        <span className="saved-subject-metric-val">{summary.examCount}</span>
                        <span className="saved-subject-metric-lbl">Exams</span>
                      </div>
                      <div className="saved-subject-metric-sep" />
                      <div className="saved-subject-metric-item">
                        <span className="saved-subject-metric-val">{summary.topicsSet.size}</span>
                        <span className="saved-subject-metric-lbl">Topics</span>
                      </div>
                      <div className="saved-subject-metric-sep" />
                      <div className="saved-subject-metric-item">
                        <span className="saved-subject-metric-val">{summary.totalQuestions}</span>
                        <span className="saved-subject-metric-lbl">Questions</span>
                      </div>
                    </div>

                    {/* Footer: Last Updated & Action Arrow */}
                    <div className="saved-subject-card-footer">
                      <span className="saved-subject-last-updated">
                        {latestDateFormatted ? `Updated ${latestDateFormatted}` : 'Active'}
                      </span>

                      <div className="saved-subject-explore-link">
                        <span>Explore</span>
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
            LEVEL 2: CLEAN EXAM LIST DRILL-DOWN (When activeSubjectView !== null)
        ═══════════════════════════════════════════════════════════════════════ */}
        {!isLoading && !error && tests.length > 0 && activeSubjectView !== null && (
          <div
            className="saved-drilldown-view animate-fade-in"
            style={{ '--subject-accent': activeSubjectMeta?.color || 'var(--color-primary-600)' } as React.CSSProperties}
          >
            {/* Breadcrumb Navigation Bar */}
            <div className="saved-breadcrumb-bar">
              <div className="saved-breadcrumb-left">
                <button
                  type="button"
                  className="saved-back-btn"
                  onClick={() => {
                    setActiveSubjectView(null);
                    setSearchQuery('');
                    setActiveTopicFilter('all');
                  }}
                  title="Return to Subject Hub (Press Esc)"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="15 18 9 12 15 6" />
                  </svg>
                  <span>Departments</span>
                </button>

                <div className="saved-breadcrumb-divider">/</div>

                <div className="saved-breadcrumb-current">
                  {activeSubjectView === 'all' ? (
                    <div className="saved-breadcrumb-icon-wrap">
                      <SubjectIcon subject="general" size={18} />
                      <span className="saved-breadcrumb-title">All Subjects</span>
                    </div>
                  ) : (
                    <div className="saved-breadcrumb-icon-wrap">
                      <SubjectIcon subject={activeSubjectView} size={18} />
                      <span className="saved-breadcrumb-title">{activeSubjectView}</span>
                    </div>
                  )}
                  <span className="saved-breadcrumb-count-badge">
                    {subjectFilteredTests.length} exam{subjectFilteredTests.length !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>

              <div className="saved-breadcrumb-right">
                <button
                  type="button"
                  className="saved-btn saved-btn--primary saved-btn--sm"
                  onClick={onNavigateToBank}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                  <span>+ New Exam</span>
                </button>
              </div>
            </div>

            {/* Minimalist Filter Bar */}
            <div className="saved-filter-bar">
              <div className="saved-filter-bar-row">
                {/* Search Box */}
                <div className="saved-search-box">
                  <svg className="saved-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <input
                    type="text"
                    className="saved-search-input"
                    placeholder={`Search ${activeSubjectView === 'all' ? 'all' : activeSubjectView} tests or topics...`}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                  {searchQuery && (
                    <button
                      type="button"
                      className="saved-search-clear"
                      onClick={() => setSearchQuery('')}
                      title="Clear search"
                    >
                      ✕
                    </button>
                  )}
                </div>

                {/* View Mode & Expand Accordions */}
                <div className="saved-filter-controls">
                  <div className="saved-view-toggle">
                    <button
                      type="button"
                      className={`saved-view-toggle-btn ${isGroupedByTopic ? 'saved-view-toggle-btn--active' : ''}`}
                      onClick={() => setIsGroupedByTopic(true)}
                      title="Group assessments by topic"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="8" y1="6" x2="21" y2="6" />
                        <line x1="8" y1="12" x2="21" y2="12" />
                        <line x1="8" y1="18" x2="21" y2="18" />
                        <line x1="3" y1="6" x2="3.01" y2="6" />
                        <line x1="3" y1="12" x2="3.01" y2="12" />
                        <line x1="3" y1="18" x2="3.01" y2="18" />
                      </svg>
                      <span>Grouped</span>
                    </button>
                    <button
                      type="button"
                      className={`saved-view-toggle-btn ${!isGroupedByTopic ? 'saved-view-toggle-btn--active' : ''}`}
                      onClick={() => setIsGroupedByTopic(false)}
                      title="Show flat table"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="2" />
                        <line x1="3" y1="9" x2="21" y2="9" />
                        <line x1="3" y1="15" x2="21" y2="15" />
                      </svg>
                      <span>Flat</span>
                    </button>
                  </div>

                  {isGroupedByTopic && groupKeys.length > 1 && (
                    <button
                      type="button"
                      className="saved-collapse-all-btn"
                      onClick={toggleAllGroups}
                      title={areAllCollapsed ? 'Expand all topic sections' : 'Collapse all topic sections'}
                    >
                      {areAllCollapsed ? 'Expand All' : 'Collapse All'}
                    </button>
                  )}

                  {/* Sort Selector */}
                  <div className="saved-sort-wrap">
                    <span className="saved-sort-label">Sort:</span>
                    <select
                      className="saved-sort-select"
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value as SortOption)}
                    >
                      <option value="latest">Latest Created</option>
                      <option value="oldest">Oldest First</option>
                      <option value="title">Title (A-Z)</option>
                      <option value="marks">Highest Marks</option>
                      <option value="questions">Most Questions</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Topic Filter Pills (Horizontal scrollable) */}
              {availableTopicsForSubject.length > 1 && (
                <div className="saved-topic-pills-row">
                  <span className="saved-topic-pills-label">Topics:</span>
                  <div className="saved-topic-pills-list">
                    <button
                      type="button"
                      className={`saved-topic-pill ${activeTopicFilter === 'all' ? 'saved-topic-pill--active' : ''}`}
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
                          className={`saved-topic-pill ${activeTopicFilter === top ? 'saved-topic-pill--active' : ''}`}
                          onClick={() => setActiveTopicFilter(top)}
                        >
                          {top} ({count})
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* No Search Matches State */}
            {finalFilteredList.length === 0 && (
              <div className="saved-empty-state saved-empty-state--compact animate-fade-in">
                <div className="saved-empty-visual">
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                </div>
                <h3 className="saved-empty-heading">No matching assessments</h3>
                <p className="saved-empty-text">
                  No saved tests match your search criteria. Try modifying your search query or reset the topic filter.
                </p>
                <button
                  type="button"
                  className="saved-btn saved-btn--secondary"
                  onClick={() => {
                    setSearchQuery('');
                    setActiveTopicFilter('all');
                  }}
                >
                  Reset Filters
                </button>
              </div>
            )}

            {/* ─── Clean Exam Rows (Linear/Notion-Style Minimalist List) ────── */}
            {finalFilteredList.length > 0 && (
              <div className="saved-list-sections">
                {groupKeys.map((groupName) => {
                  const groupTests = groupedTopicSections[groupName] || [];
                  if (groupTests.length === 0) return null;

                  const isCollapsed = isGroupedByTopic && !!collapsedGroups[groupName];

                  return (
                    <section key={groupName} className="saved-topic-section animate-fade-in">
                      {/* Section Header (Only in Grouped Mode) */}
                      {isGroupedByTopic && (
                        <div
                          className="saved-section-header"
                          onClick={() => toggleGroupCollapse(groupName)}
                          role="button"
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              toggleGroupCollapse(groupName);
                            }
                          }}
                        >
                          <div className="saved-section-header-left">
                            <span className={`saved-section-chevron ${isCollapsed ? 'saved-section-chevron--collapsed' : ''}`}>
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <polyline points="6 9 12 15 18 9" />
                              </svg>
                            </span>
                            <h2 className="saved-section-title">{groupName}</h2>
                            <span className="saved-section-badge">
                              {groupTests.length}
                            </span>
                          </div>

                          <span className="saved-section-toggle-text">
                            {isCollapsed ? 'Expand' : 'Collapse'}
                          </span>
                        </div>
                      )}

                      {/* Exam Rows Table/List */}
                      {!isCollapsed && (
                        <div className="saved-rows-container">
                          {groupTests.map((test) => {
                            const qCount = test.question_ids?.length || 0;
                            const testSub = test.primarySubject || (test.subjects[0] ?? 'General');
                            const subMeta = getSubjectMetadata(testSub);
                            const dateFormatted = new Date(test.created_at).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            });

                            return (
                              <div
                                key={test.id}
                                className="saved-exam-row"
                                onClick={(e) => {
                                  // Open in builder if row itself is clicked (outside of actions)
                                  if ((e.target as HTMLElement).closest('.saved-row-actions') || (e.target as HTMLElement).closest('.saved-mobile-action-btn')) {
                                    return;
                                  }
                                  handleOpenTest(test);
                                }}
                              >
                                {/* Left Column: Subject Logo Icon, Title & Tags */}
                                <div className="saved-exam-main">
                                  <div
                                    className="saved-exam-icon-slot"
                                    style={{
                                      backgroundColor: subMeta.bgLight,
                                      borderColor: subMeta.borderLight,
                                    }}
                                    title={testSub}
                                  >
                                    <SubjectIcon subject={testSub} size={18} />
                                  </div>

                                  <div className="saved-exam-details">
                                    <div className="saved-exam-title-row">
                                      <h3 className="saved-exam-title" title={test.title}>
                                        {test.title || 'Untitled Assessment Paper'}
                                      </h3>
                                    </div>

                                    <div className="saved-exam-meta-row">
                                      <span className="saved-exam-subject-tag" style={{ color: subMeta.color }}>
                                        {testSub}
                                      </span>

                                      {test.primaryTopic && test.primaryTopic !== 'General' && (
                                        <>
                                          <span className="saved-meta-dot">•</span>
                                          <span className="saved-exam-topic-tag">
                                            {test.primaryTopic}
                                          </span>
                                        </>
                                      )}

                                      <span className="saved-meta-dot">•</span>
                                      <span className="saved-exam-date">{dateFormatted}</span>
                                    </div>
                                  </div>
                                </div>

                                {/* Center/Right Column: Metadata Numbers */}
                                <div className="saved-exam-stats">
                                  <div className="saved-stat-badge saved-stat-badge--marks" title="Total Assessment Marks">
                                    <span className="saved-stat-value">{test.total_marks || 0}</span>
                                    <span className="saved-stat-unit">Marks</span>
                                  </div>

                                  <div className="saved-stat-badge saved-stat-badge--questions" title="Question Count">
                                    <span className="saved-stat-value">{qCount}</span>
                                    <span className="saved-stat-unit">Questions</span>
                                  </div>
                                </div>

                                {/* Right Edge: Hover Quick Actions Bar (Completely quiet until hover) */}
                                <div className="saved-row-actions">
                                  {/* 1. Open in Builder (Primary) */}
                                  <button
                                    type="button"
                                    className="saved-action-btn saved-action-btn--primary"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleOpenTest(test);
                                    }}
                                    disabled={loadingTestId === test.id}
                                    title="Open and edit in Standardized Test Builder"
                                    aria-label="Open in Builder"
                                  >
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M12 20h9" />
                                      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                                    </svg>
                                    <span className="saved-action-tooltip">Builder</span>
                                  </button>

                                  {/* 2. Export Word / PDF */}
                                  <button
                                    type="button"
                                    className="saved-action-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleExportTest(test);
                                    }}
                                    disabled={loadingTestId === test.id}
                                    title="Export Cambridge Word/PDF Exam Paper"
                                    aria-label="Export Paper"
                                  >
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                      <polyline points="7 10 12 15 17 10" />
                                      <line x1="12" y1="15" x2="12" y2="3" />
                                    </svg>
                                    <span className="saved-action-tooltip">Export</span>
                                  </button>

                                  {/* 3. Parallel Twin Variant (Set B) */}
                                  <button
                                    type="button"
                                    className="saved-action-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleGenerateVariant(test);
                                    }}
                                    disabled={loadingTestId === test.id}
                                    title="Generate Parallel Twin Assessment (Set B)"
                                    aria-label="Generate Twin Variant"
                                  >
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                      <polyline points="16 3 21 3 21 8" />
                                      <line x1="4" y1="20" x2="21" y2="3" />
                                      <polyline points="21 16 21 21 16 21" />
                                      <line x1="15" y1="15" x2="21" y2="21" />
                                      <line x1="4" y1="4" x2="9" y2="9" />
                                    </svg>
                                    <span className="saved-action-tooltip">Variant</span>
                                  </button>

                                  {/* 4. Google Forms Export */}
                                  <button
                                    type="button"
                                    className="saved-action-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleGoogleFormsExport(test);
                                    }}
                                    disabled={loadingTestId === test.id}
                                    title="Export directly to Google Forms Quiz"
                                    aria-label="Export to Forms"
                                  >
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                      <polyline points="14 2 14 8 20 8" />
                                      <line x1="16" y1="13" x2="8" y2="13" />
                                      <line x1="16" y1="17" x2="8" y2="17" />
                                      <polyline points="10 9 9 9 8 9" />
                                    </svg>
                                    <span className="saved-action-tooltip">Forms</span>
                                  </button>

                                  {/* 5. Offline Exam Grade */}
                                  <button
                                    type="button"
                                    className="saved-action-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleGradeOffline(test);
                                    }}
                                    disabled={loadingTestId === test.id}
                                    title="Grade offline physical exam via Rapid Excel / Grid"
                                    aria-label="Grade Offline"
                                  >
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                      <line x1="18" y1="20" x2="18" y2="10" />
                                      <line x1="12" y1="20" x2="12" y2="4" />
                                      <line x1="6" y1="20" x2="6" y2="14" />
                                    </svg>
                                    <span className="saved-action-tooltip">Grade</span>
                                  </button>

                                  <div className="saved-action-sep" />

                                  {/* 6. Delete Exam */}
                                  <button
                                    type="button"
                                    className="saved-action-btn saved-action-btn--danger"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDeleteTest(test.id, test.title || 'Untitled Assessment');
                                    }}
                                    disabled={deletingId === test.id}
                                    title="Delete saved test"
                                    aria-label="Delete test"
                                  >
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                      <polyline points="3 6 5 6 21 6" />
                                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                    </svg>
                                    <span className="saved-action-tooltip">Delete</span>
                                  </button>
                                </div>

                                {/* Mobile/Touch Actions Trigger */}
                                <div className="saved-mobile-actions">
                                  <button
                                    type="button"
                                    className="saved-mobile-action-btn"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setOpenMobileMenuId(openMobileMenuId === test.id ? null : test.id);
                                    }}
                                    aria-label="Actions menu"
                                  >
                                    •••
                                  </button>

                                  {openMobileMenuId === test.id && (
                                    <div className="saved-mobile-menu animate-fade-in" onClick={(e) => e.stopPropagation()}>
                                      <button
                                        type="button"
                                        className="saved-mobile-menu-item"
                                        onClick={() => handleOpenTest(test)}
                                      >
                                        ✏️ Open in Builder
                                      </button>
                                      <button
                                        type="button"
                                        className="saved-mobile-menu-item"
                                        onClick={() => handleExportTest(test)}
                                      >
                                        📄 Export Paper
                                      </button>
                                      <button
                                        type="button"
                                        className="saved-mobile-menu-item"
                                        onClick={() => handleGenerateVariant(test)}
                                      >
                                        🔀 Generate Twin Variant
                                      </button>
                                      <button
                                        type="button"
                                        className="saved-mobile-menu-item"
                                        onClick={() => handleGoogleFormsExport(test)}
                                      >
                                        📝 Google Forms
                                      </button>
                                      <button
                                        type="button"
                                        className="saved-mobile-menu-item"
                                        onClick={() => handleGradeOffline(test)}
                                      >
                                        📊 Offline Grading
                                      </button>
                                      <div className="saved-mobile-menu-divider" />
                                      <button
                                        type="button"
                                        className="saved-mobile-menu-item saved-mobile-menu-item--danger"
                                        onClick={() => handleDeleteTest(test.id, test.title)}
                                      >
                                        🗑️ Delete Test
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

      {/* ─── Modals ──────────────────────────────────────────────────────────── */}
      {exportData && (
        <ExportModal
          isOpen={true}
          onClose={() => setExportData(null)}
          headerConfig={exportData.headerConfig}
          questions={exportData.questions}
        />
      )}

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

      <ConfirmDeleteModal
        isOpen={deleteModalState.isOpen}
        title="Delete Custom Exam"
        message={`Are you sure you want to permanently delete "${deleteModalState.title}"?`}
        isDeleting={!!deletingId}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteModalState({ isOpen: false, testId: '', title: '' })}
      />

      {googleFormsData && (
        <GoogleFormsExportModal
          isOpen={true}
          onClose={() => setGoogleFormsData(null)}
          headerConfig={googleFormsData.headerConfig}
          questions={googleFormsData.questions}
        />
      )}

      {variantData && (
        <ExamVariantModal
          isOpen={true}
          onClose={() => setVariantData(null)}
          originalHeaderConfig={variantData.headerConfig}
          originalQuestions={variantData.questions}
          onSaveComplete={() => {
            loadTests();
          }}
          onOpenInBuilder={(qs, hc) => {
            onLoadTestIntoBuilder(qs, hc);
          }}
        />
      )}
    </div>
  );
}
