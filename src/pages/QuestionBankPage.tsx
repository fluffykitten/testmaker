import { useState, useEffect, useCallback } from 'react';
import {
  fetchQuestions,
  fetchSyllabuses,
  fetchTopics,
  deleteQuestion,
  deleteQuestions,
  type QuestionFilterParams,
} from '../services/questionBankService';
import type { Question, Syllabus } from '../types/database';
import { QuestionFilters } from '../components/QuestionFilters';
import { QuestionCard } from '../components/QuestionCard';
import { QuestionDetailModal } from '../components/QuestionDetailModal';
import { QuestionEditorModal } from '../components/QuestionEditorModal';
import { QuestionVariantModal } from '../components/QuestionVariantModal';
import { SmartTestAssemblerModal } from '../components/SmartTestAssemblerModal';
import { ConfirmDeleteModal } from '../components/ConfirmDeleteModal';
import './QuestionBankPage.css';

interface QuestionBankPageProps {
  selectedQuestionIds: Set<string>;
  onToggleSelectQuestion: (question: Question) => void;
  onClearSelection: () => void;
  onNavigateToUpload: () => void;
  onNavigateToBuilder?: () => void;
}

export function QuestionBankPage({
  selectedQuestionIds,
  onToggleSelectQuestion,
  onClearSelection,
  onNavigateToUpload,
  onNavigateToBuilder,
}: QuestionBankPageProps) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [syllabuses, setSyllabuses] = useState<Syllabus[]>([]);
  const [topics, setTopics] = useState<{ topic: string; subTopics: string[] }[]>([]);

  const [filters, setFilters] = useState<QuestionFilterParams>({
    sortBy: 'year_desc',
    page: 1,
    pageSize: 12,
  });

  const [totalCount, setTotalCount] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedDetailQuestion, setSelectedDetailQuestion] = useState<Question | null>(null);
  const [showMobileFilters, setShowMobileFilters] = useState(false);

  // Question Editor state (Create new or Edit existing)
  const [editorState, setEditorState] = useState<{
    isOpen: boolean;
    question: Question | null;
  }>({
    isOpen: false,
    question: null,
  });

  // Question Variant Generator state
  const [variantModalState, setVariantModalState] = useState<{
    isOpen: boolean;
    question: Question | null;
  }>({
    isOpen: false,
    question: null,
  });

  // Smart Test Auto-Assembler modal state
  const [isAssemblerOpen, setIsAssemblerOpen] = useState(false);

  // Question deletion modal state
  const [deleteModalState, setDeleteModalState] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    ids: string[];
  }>({
    isOpen: false,
    title: '',
    message: '',
    ids: [],
  });
  const [isDeleting, setIsDeleting] = useState(false);
  const [actionToast, setActionToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Load syllabuses on mount
  useEffect(() => {
    async function loadSyllabuses() {
      try {
        const sList = await fetchSyllabuses();
        setSyllabuses(sList);
      } catch (err: any) {
        console.error('Error loading syllabuses:', err);
      }
    }
    loadSyllabuses();
  }, []);

  // Fetch topics dynamically whenever the selected syllabus/subject filter changes
  useEffect(() => {
    async function loadTopics() {
      try {
        const tList = await fetchTopics(filters.syllabusId);
        setTopics(tList);
      } catch (err: any) {
        console.error('Error loading topics for subject/syllabus:', err);
      }
    }
    loadTopics();
  }, [filters.syllabusId]);

  // Fetch questions whenever filters change
  const loadQuestions = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await fetchQuestions(filters);
      setQuestions(result.questions);
      setTotalCount(result.totalCount);
      setTotalPages(result.totalPages);
    } catch (err: any) {
      setError(err?.message || 'Failed to load questions from database');
    } finally {
      setIsLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    loadQuestions();
  }, [loadQuestions]);

  useEffect(() => {
    const handleBookmarkOrTagUpdate = () => {
      if (filters.bookmarkedOnly || filters.customTag) {
        loadQuestions();
      }
    };
    window.addEventListener('bookmarks_updated', handleBookmarkOrTagUpdate);
    window.addEventListener('tags_updated', handleBookmarkOrTagUpdate);
    return () => {
      window.removeEventListener('bookmarks_updated', handleBookmarkOrTagUpdate);
      window.removeEventListener('tags_updated', handleBookmarkOrTagUpdate);
    };
  }, [filters.bookmarkedOnly, filters.customTag, loadQuestions]);

  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= totalPages) {
      setFilters((prev) => ({ ...prev, page: newPage }));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  // Single question delete request
  const handleRequestDeleteSingle = (q: Question) => {
    setDeleteModalState({
      isOpen: true,
      title: `Delete Question ${q.question_number}`,
      message: `Are you sure you want to permanently delete Question ${q.question_number} (${q.topic})? This cannot be undone.`,
      ids: [q.id],
    });
  };

  // Bulk question delete request
  const handleRequestDeleteBulk = () => {
    const ids = Array.from(selectedQuestionIds);
    if (ids.length === 0) return;
    setDeleteModalState({
      isOpen: true,
      title: `Delete ${ids.length} Selected Questions`,
      message: `Are you sure you want to permanently delete ${ids.length} selected question(s) from your Question Bank? This cannot be undone.`,
      ids,
    });
  };

  // Confirm and execute delete
  const handleConfirmDelete = async () => {
    if (deleteModalState.ids.length === 0) return;
    setIsDeleting(true);
    try {
      if (deleteModalState.ids.length === 1) {
        const success = await deleteQuestion(deleteModalState.ids[0]);
        if (!success) throw new Error('Failed to delete question from database');
      } else {
        const res = await deleteQuestions(deleteModalState.ids);
        if (!res.success) throw new Error('Failed to delete selected questions');
      }

      setActionToast({
        message: `Successfully deleted ${deleteModalState.ids.length} question${deleteModalState.ids.length > 1 ? 's' : ''}.`,
        type: 'success',
      });
      setTimeout(() => setActionToast(null), 4000);

      // Close modal and refresh list
      setDeleteModalState({ isOpen: false, title: '', message: '', ids: [] });
      await loadQuestions();
    } catch (err: any) {
      setActionToast({
        message: err?.message || 'Error deleting question(s)',
        type: 'error',
      });
      setTimeout(() => setActionToast(null), 4000);
    } finally {
      setIsDeleting(false);
    }
  };

  // Calculate selected statistics
  const selectedCount = selectedQuestionIds.size;

  return (
    <div className="bank-page">
      <div className="bank-page-container">
        {/* ─── Action Notification Toast ────────────────────────────────────── */}
        {actionToast && (
          <div className={`bank-toast bank-toast--${actionToast.type} animate-fade-in`}>
            <span>{actionToast.type === 'success' ? '✓' : '⚠️'}</span>
            <span>{actionToast.message}</span>
          </div>
        )}

        {/* ─── Page Header ─────────────────────────────────────────────────── */}
        <div className="bank-header animate-fade-in">
          <div className="bank-header-left">
            <h1 className="bank-title">Question Bank</h1>
            <p className="bank-subtitle">
              Browse, filter, and curate exam questions from your past paper catalog with KaTeX math rendering.
            </p>
          </div>

          <div className="bank-header-actions">
            <button
              type="button"
              className="bank-mobile-filter-btn"
              onClick={() => setShowMobileFilters(!showMobileFilters)}
            >
              ⚙️ {showMobileFilters ? 'Hide Filters' : 'Filters'}
            </button>

            <button
              type="button"
              className="bank-btn bank-btn--assemble"
              onClick={() => setIsAssemblerOpen(true)}
              title="Automatically generate a balanced test matching custom marks and topics"
            >
              ⚡ Auto-Assemble Test
            </button>

            <button
              type="button"
              className="bank-btn bank-btn--create"
              onClick={() => setEditorState({ isOpen: true, question: null })}
              title="Create a new custom question from scratch"
            >
              ✨ Create Question
            </button>

            <button
              type="button"
              className="bank-btn bank-btn--upload"
              onClick={onNavigateToUpload}
            >
              + Upload Paper
            </button>
          </div>
        </div>

        {/* ─── Main Content Grid: Filters + Question Catalog ───────────────── */}
        <div className="bank-layout">
          {/* Filter Sidebar */}
          <div className={`bank-sidebar ${showMobileFilters ? 'bank-sidebar--open' : ''}`}>
            <QuestionFilters
              filters={filters}
              onFilterChange={(newFilters) => setFilters(newFilters)}
              syllabuses={syllabuses}
              topics={topics}
              totalResults={totalCount}
            />
          </div>

          {/* Catalog Area */}
          <main className="bank-catalog">
            {/* Catalog Toolbar */}
            <div className="bank-toolbar">
              <span className="bank-results-count">
                Showing {questions.length} of <strong>{totalCount}</strong> question{totalCount !== 1 ? 's' : ''}
              </span>

              {selectedCount > 0 && (
                <div className="bank-toolbar-selection animate-fade-in">
                  <span className="bank-selected-indicator">
                    🎯 {selectedCount} selected
                  </span>
                  <button
                    type="button"
                    className="bank-toolbar-delete-btn"
                    onClick={handleRequestDeleteBulk}
                    title="Delete all selected questions from database"
                  >
                    🗑️ Delete Selected
                  </button>
                </div>
              )}
            </div>

            {/* Loading State */}
            {isLoading && (
              <div className="bank-skeleton-grid">
                {[1, 2, 3, 4].map((n) => (
                  <div key={n} className="bank-skeleton-card animate-pulse" />
                ))}
              </div>
            )}

            {/* Error State */}
            {!isLoading && error && (
              <div className="bank-error animate-fade-in">
                <span className="bank-error-icon">⚠️</span>
                <p>{error}</p>
                <button
                  type="button"
                  className="bank-btn bank-btn--secondary"
                  onClick={loadQuestions}
                >
                  Retry
                </button>
              </div>
            )}

            {/* Empty State */}
            {!isLoading && !error && questions.length === 0 && (
              <div className="bank-empty animate-fade-in">
                <div className="bank-empty-icon">📚</div>
                <h3 className="bank-empty-title">No Questions Found</h3>
                <p className="bank-empty-desc">
                  {totalCount === 0 && !filters.searchQuery && !filters.topic
                    ? 'Your Question Bank is currently empty. Upload past paper PDFs to populate the catalog with AI-extracted questions.'
                    : 'No questions match your active filter criteria. Try resetting or adjusting your filters.'}
                </p>
                <div className="bank-empty-actions">
                  <button
                    type="button"
                    className="bank-btn bank-btn--primary"
                    onClick={onNavigateToUpload}
                  >
                    Upload Past Paper
                  </button>
                  <button
                    type="button"
                    className="bank-btn bank-btn--secondary"
                    onClick={() => setFilters({ sortBy: 'year_desc', page: 1, pageSize: 12 })}
                  >
                    Clear Filters
                  </button>
                </div>
              </div>
            )}

            {/* Questions Grid */}
            {!isLoading && !error && questions.length > 0 && (
              <>
                <div className="bank-grid">
                  {questions.map((q) => (
                    <QuestionCard
                      key={q.id}
                      question={q}
                      isSelected={selectedQuestionIds.has(q.id)}
                      onToggleSelect={onToggleSelectQuestion}
                      onViewDetails={(target) => setSelectedDetailQuestion(target)}
                      onEdit={(target) => setEditorState({ isOpen: true, question: target })}
                      onGenerateVariant={(target) => setVariantModalState({ isOpen: true, question: target })}
                      onDelete={handleRequestDeleteSingle}
                    />
                  ))}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="bank-pagination">
                    <button
                      type="button"
                      className="bank-page-btn"
                      disabled={filters.page === 1}
                      onClick={() => handlePageChange((filters.page || 1) - 1)}
                    >
                      ← Previous
                    </button>

                    <span className="bank-page-info">
                      Page <strong>{filters.page}</strong> of <strong>{totalPages}</strong>
                    </span>

                    <button
                      type="button"
                      className="bank-page-btn"
                      disabled={filters.page === totalPages}
                      onClick={() => handlePageChange((filters.page || 1) + 1)}
                    >
                      Next →
                    </button>
                  </div>
                )}
              </>
            )}
          </main>
        </div>
      </div>

      {/* ─── Floating Test Basket Bar ─────────────────────────────────────── */}
      {selectedCount > 0 && (
        <div className="bank-basket-bar animate-slide-up">
          <div className="bank-basket-inner">
            <div className="bank-basket-info">
              <span className="bank-basket-badge">{selectedCount}</span>
              <span className="bank-basket-text">
                Question{selectedCount !== 1 ? 's' : ''} selected
              </span>
            </div>

            <div className="bank-basket-actions">
              <button
                type="button"
                className="bank-basket-btn bank-basket-btn--danger"
                onClick={handleRequestDeleteBulk}
                title="Delete selected questions"
              >
                Delete ({selectedCount})
              </button>

              <button
                type="button"
                className="bank-basket-btn bank-basket-btn--clear"
                onClick={onClearSelection}
              >
                Clear
              </button>

              <button
                type="button"
                className="bank-basket-btn bank-basket-btn--primary"
                onClick={onNavigateToBuilder}
              >
                Build Custom Test →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Detail Modal ─────────────────────────────────────────────────── */}
      {selectedDetailQuestion && (
        <QuestionDetailModal
          question={selectedDetailQuestion}
          onClose={() => setSelectedDetailQuestion(null)}
          isSelected={selectedQuestionIds.has(selectedDetailQuestion.id)}
          onToggleSelect={onToggleSelectQuestion}
          onEdit={(target) => {
            setSelectedDetailQuestion(null);
            setEditorState({ isOpen: true, question: target });
          }}
          onGenerateVariant={(target) => {
            setSelectedDetailQuestion(null);
            setVariantModalState({ isOpen: true, question: target });
          }}
          onQuestionUpdated={(updated) => {
            setQuestions((prev) => prev.map((q) => (q.id === updated.id ? updated : q)));
            setSelectedDetailQuestion(updated);
          }}
        />
      )}

      {/* ─── Question Variant Generator Modal ───────────────────────────────── */}
      <QuestionVariantModal
        isOpen={variantModalState.isOpen}
        question={variantModalState.question}
        onClose={() => setVariantModalState({ isOpen: false, question: null })}
        onSaveToBank={(newQuestion) => {
          setQuestions((prev) => [newQuestion, ...prev]);
          setTotalCount((c) => c + 1);
          setActionToast({
            message: `✨ Variant question ${newQuestion.question_number} saved to Question Bank!`,
            type: 'success',
          });
          setTimeout(() => setActionToast(null), 3000);
        }}
        onAddToTest={(newQuestion) => {
          onToggleSelectQuestion(newQuestion);
          setActionToast({
            message: `✨ Variant question ${newQuestion.question_number} added to custom test!`,
            type: 'success',
          });
          setTimeout(() => setActionToast(null), 3000);
        }}
        onOpenInEditor={(variantQuestion) => {
          setVariantModalState({ isOpen: false, question: null });
          setEditorState({ isOpen: true, question: variantQuestion });
        }}
      />

      {/* ─── Smart Test Auto-Assembler Modal ─────────────────────────────── */}
      <SmartTestAssemblerModal
        isOpen={isAssemblerOpen}
        onClose={() => setIsAssemblerOpen(false)}
        syllabuses={syllabuses}
        topics={topics}
        onLoadIntoBuilder={(assembled) => {
          // Select all assembled questions
          assembled.forEach((q) => {
            if (!selectedQuestionIds.has(q.id)) {
              onToggleSelectQuestion(q);
            }
          });

          setActionToast({
            message: `⚡ Auto-assembled ${assembled.length} questions for custom test!`,
            type: 'success',
          });
          setTimeout(() => setActionToast(null), 3000);

          if (onNavigateToBuilder) {
            onNavigateToBuilder();
          }
        }}
      />

      {/* ─── Question Editor Modal (Create or Edit) ────────────────────────── */}
      <QuestionEditorModal
        isOpen={editorState.isOpen}
        question={editorState.question}
        syllabuses={syllabuses}
        onClose={() => setEditorState({ isOpen: false, question: null })}
        onSave={(savedQuestion) => {
          setQuestions((prev) => {
            const exists = prev.some((q) => q.id === savedQuestion.id);
            if (exists) {
              return prev.map((q) => (q.id === savedQuestion.id ? savedQuestion : q));
            }
            return [savedQuestion, ...prev];
          });

          if (selectedDetailQuestion && selectedDetailQuestion.id === savedQuestion.id) {
            setSelectedDetailQuestion(savedQuestion);
          }

          if (!editorState.question?.id) {
            setTotalCount((c) => c + 1);
          }

          setActionToast({
            message: editorState.question?.id
              ? `Question ${savedQuestion.question_number} updated!`
              : `Question ${savedQuestion.question_number} created and added to bank!`,
            type: 'success',
          });
          setTimeout(() => setActionToast(null), 3000);
        }}
      />

      {/* ─── Confirm Delete Modal ─────────────────────────────────────────── */}
      <ConfirmDeleteModal
        isOpen={deleteModalState.isOpen}
        title={deleteModalState.title}
        message={deleteModalState.message}
        isDeleting={isDeleting}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteModalState({ isOpen: false, title: '', message: '', ids: [] })}
      />
    </div>
  );
}
