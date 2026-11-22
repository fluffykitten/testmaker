import { useEffect, useMemo, useRef, useState } from 'react';
import type { CustomTestWithDetails } from '../services/testBuilderService';
import {
  extractSavedTestSubjects,
  filterSavedTests,
  getSavedTestSubject,
  sortSavedTestsNewestFirst,
} from '../lib/sourceTestPickerUtils';

interface SourceTestComboboxProps {
  savedTests: CustomTestWithDetails[];
  selectedTestId: string | null;
  onSelect: (testId: string) => void;
  disabled?: boolean;
}

export function SourceTestCombobox({
  savedTests,
  selectedTestId,
  onSelect,
  disabled = false,
}: SourceTestComboboxProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [subjectFilter, setSubjectFilter] = useState<string>('ALL');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const sortedTests = useMemo(() => sortSavedTestsNewestFirst(savedTests), [savedTests]);
  const subjects = useMemo(() => extractSavedTestSubjects(sortedTests), [sortedTests]);
  const selectedTest = useMemo(
    () => savedTests.find((t) => t.id === selectedTestId) || sortedTests[0] || null,
    [savedTests, sortedTests, selectedTestId]
  );

  const filteredTests = useMemo(
    () => filterSavedTests(sortedTests, searchQuery, subjectFilter),
    [sortedTests, searchQuery, subjectFilter]
  );

  useEffect(() => {
    if (!isOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) {
      const id = setTimeout(() => searchInputRef.current?.focus(), 20);
      return () => clearTimeout(id);
    }
  }, [isOpen]);

  const selectedSubject = selectedTest ? getSavedTestSubject(selectedTest) : 'General';
  const selectedQCount = selectedTest?.question_ids?.length || 0;
  const selectedMarks = selectedTest?.total_marks || 0;

  return (
    <div className="qm-source-picker" ref={containerRef}>
      <button
        type="button"
        className={`qm-source-picker-trigger ${isOpen ? 'qm-source-picker-trigger--open' : ''} ${
          disabled ? 'qm-source-picker-trigger--disabled' : ''
        }`}
        onClick={() => {
          if (disabled) return;
          setIsOpen((prev) => !prev);
        }}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
      >
        <div className="qm-source-picker-selected">
          <span className="qm-source-picker-title">
            {selectedTest?.title || 'Select a saved exam…'}
          </span>
          {selectedTest && (
            <span className="qm-source-picker-meta">
              <span className="qm-source-picker-subj">{selectedSubject}</span>
              <span>•</span>
              <span>{selectedQCount} Qs</span>
              <span>•</span>
              <span>{selectedMarks} marks</span>
            </span>
          )}
        </div>
        <span className="qm-source-picker-chevron" aria-hidden="true">
          {disabled ? '🔒' : isOpen ? '▴' : '▾'}
        </span>
      </button>

      {isOpen && !disabled && (
        <div className="qm-source-picker-popover" role="listbox" aria-label="Saved exams">
          <div className="qm-source-picker-search-row">
            <span className="qm-source-picker-search-icon" aria-hidden="true">🔍</span>
            <input
              ref={searchInputRef}
              type="text"
              className="qm-source-picker-search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={`Search ${savedTests.length} saved exams by title, subject, or topic…`}
            />
            {searchQuery && (
              <button
                type="button"
                className="qm-source-picker-clear"
                onClick={() => setSearchQuery('')}
                title="Clear search"
              >
                ✕
              </button>
            )}
          </div>

          {subjects.length > 1 && (
            <div className="qm-source-picker-chips">
              <button
                type="button"
                className={`qm-source-chip ${subjectFilter === 'ALL' ? 'qm-source-chip--active' : ''}`}
                onClick={() => setSubjectFilter('ALL')}
              >
                All ({sortedTests.length})
              </button>
              {subjects.map((subj) => (
                <button
                  key={subj}
                  type="button"
                  className={`qm-source-chip ${
                    subjectFilter.toLowerCase() === subj.toLowerCase() ? 'qm-source-chip--active' : ''
                  }`}
                  onClick={() =>
                    setSubjectFilter((prev) =>
                      prev.toLowerCase() === subj.toLowerCase() ? 'ALL' : subj
                    )
                  }
                >
                  {subj}
                </button>
              ))}
            </div>
          )}

          <div className="qm-source-picker-list">
            {filteredTests.length === 0 ? (
              <div className="qm-source-picker-empty">
                <span>No saved exams match your filter.</span>
                {(searchQuery || subjectFilter !== 'ALL') && (
                  <button
                    type="button"
                    className="qm-source-picker-reset"
                    onClick={() => {
                      setSearchQuery('');
                      setSubjectFilter('ALL');
                    }}
                  >
                    Reset filters
                  </button>
                )}
              </div>
            ) : (
              filteredTests.map((t) => {
                const isSelected = t.id === selectedTestId;
                const subj = getSavedTestSubject(t);
                const qCount = t.question_ids?.length || 0;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`qm-source-picker-item ${
                      isSelected ? 'qm-source-picker-item--selected' : ''
                    }`}
                    onClick={() => {
                      onSelect(t.id);
                      setIsOpen(false);
                    }}
                  >
                    <div className="qm-source-picker-item-main">
                      <span className="qm-source-picker-item-title">{t.title || 'Untitled Exam'}</span>
                      <span className="qm-source-picker-item-sub">
                        <span className="qm-source-picker-subj">{subj}</span>
                        <span>• {qCount} questions • {t.total_marks || 0} marks</span>
                      </span>
                    </div>
                    {isSelected && <span className="qm-source-picker-check">✓</span>}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
