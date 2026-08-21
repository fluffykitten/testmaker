import { useState, useEffect, useCallback } from 'react';
import {
  fetchCustomTests,
  fetchCustomTestWithQuestions,
  deleteCustomTest,
  type ExamHeaderConfig,
} from '../services/testBuilderService';
import { ExportModal } from '../components/ExportModal';
import type { CustomTest, Question } from '../types/database';
import './SavedTestsPage.css';

interface SavedTestsPageProps {
  onLoadTestIntoBuilder: (questions: Question[]) => void;
  onNavigateToBuilder: () => void;
  onNavigateToBank: () => void;
}

export function SavedTestsPage({
  onLoadTestIntoBuilder,
  onNavigateToBuilder,
  onNavigateToBank,
}: SavedTestsPageProps) {
  const [tests, setTests] = useState<CustomTest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [loadingTestId, setLoadingTestId] = useState<string | null>(null);
  const [exportData, setExportData] = useState<{
    headerConfig: ExamHeaderConfig;
    questions: Question[];
  } | null>(null);

  const loadTests = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const data = await fetchCustomTests();
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

  const handleOpenTest = async (test: CustomTest) => {
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

  const handleExportTest = async (test: CustomTest) => {
    setLoadingTestId(test.id);
    try {
      const resolved = await fetchCustomTestWithQuestions(test.id);
      if (resolved && resolved.questions.length > 0) {
        setExportData({
          headerConfig: {
            title: test.title || 'Custom Exam Assessment',
            schoolName: '',
            subject: 'Chemistry',
            subjectCode: '0620',
            durationMinutes: Math.round((test.total_marks || 20) * 1.25),
            instructions: 'Answer all questions. Write your answers in the spaces provided on the question paper.',
            additionalMaterials: 'Periodic Table (enclosed)',
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

  return (
    <div className="saved-page">
      <div className="saved-container">
        {/* Page Header */}
        <div className="saved-header animate-fade-in">
          <div>
            <h1 className="saved-title">Saved Exams & Tests</h1>
            <p className="saved-subtitle">
              Manage, review, and export all your custom-assembled past paper exam tests.
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
              You haven't saved any custom tests yet. Select questions from the Question Bank and save them in the Test Builder to see them here.
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

        {/* Saved Tests Grid */}
        {!isLoading && !error && tests.length > 0 && (
          <div className="saved-grid">
            {tests.map((test) => {
              const qCount = test.question_ids?.length || 0;
              const dateFormatted = new Date(test.created_at).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              });

              return (
                <div key={test.id} className="saved-card animate-fade-in">
                  <div className="saved-card-header">
                    <div className="saved-card-badge-row">
                      <span className="saved-badge saved-badge--marks">
                        {test.total_marks || 0} Total Marks
                      </span>
                      <span className="saved-badge saved-badge--count">
                        {qCount} Question{qCount !== 1 ? 's' : ''}
                      </span>
                    </div>

                    <span className="saved-card-date">{dateFormatted}</span>
                  </div>

                  <h3 className="saved-card-title">{test.title || 'Untitled Assessment'}</h3>

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
    </div>
  );
}
