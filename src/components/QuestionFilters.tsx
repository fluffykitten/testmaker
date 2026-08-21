import React, { useState, useEffect } from 'react';
import type { QuestionFilterParams } from '../services/questionBankService';
import type { Syllabus, QuestionDifficulty, QuestionStyle } from '../types/database';
import './QuestionFilters.css';

interface QuestionFiltersProps {
  filters: QuestionFilterParams;
  onFilterChange: (newFilters: QuestionFilterParams) => void;
  syllabuses: Syllabus[];
  topics: { topic: string; subTopics: string[] }[];
  totalResults: number;
}

export function QuestionFilters({
  filters,
  onFilterChange,
  syllabuses,
  topics,
  totalResults,
}: QuestionFiltersProps) {
  const [searchInput, setSearchInput] = useState(filters.searchQuery || '');

  // Debounce search input
  useEffect(() => {
    const handler = setTimeout(() => {
      if (searchInput !== (filters.searchQuery || '')) {
        onFilterChange({ ...filters, searchQuery: searchInput || undefined, page: 1 });
      }
    }, 350);

    return () => clearTimeout(handler);
  }, [searchInput, filters, onFilterChange]);

  const handleSyllabusChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    onFilterChange({
      ...filters,
      syllabusId: val || undefined,
      topic: undefined, // reset topic when syllabus changes
      subTopic: undefined,
      page: 1,
    });
  };

  const handleTopicChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    onFilterChange({
      ...filters,
      topic: val || undefined,
      subTopic: undefined,
      page: 1,
    });
  };

  const handleDifficultyClick = (diff?: QuestionDifficulty) => {
    onFilterChange({
      ...filters,
      difficulty: filters.difficulty === diff ? undefined : diff,
      page: 1,
    });
  };

  const handlePaperTypeClick = (paperType?: 'mcq' | 'theory' | 'atp') => {
    onFilterChange({
      ...filters,
      paperNumber: filters.paperNumber === paperType ? undefined : paperType,
      page: 1,
    });
  };

  const handleStyleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value as QuestionStyle;
    onFilterChange({
      ...filters,
      questionStyle: val || undefined,
      page: 1,
    });
  };

  const handleSortChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value as any;
    onFilterChange({
      ...filters,
      sortBy: val,
      page: 1,
    });
  };

  const handleResetFilters = () => {
    setSearchInput('');
    onFilterChange({
      sortBy: 'year_desc',
      page: 1,
      pageSize: filters.pageSize || 12,
    });
  };

  const hasActiveFilters = Boolean(
    filters.searchQuery ||
    filters.syllabusId ||
    filters.topic ||
    filters.subTopic ||
    filters.difficulty ||
    filters.paperNumber ||
    filters.questionStyle ||
    filters.minMarks ||
    filters.maxMarks
  );

  return (
    <aside className="filters-sidebar">
      {/* Search Box */}
      <div className="filter-group">
        <label className="filter-label" htmlFor="q-search-input">Search Questions</label>
        <div className="search-input-wrapper">
          <span className="search-icon">🔍</span>
          <input
            id="q-search-input"
            type="text"
            className="search-input"
            placeholder="Search topic, formula, text…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          {searchInput && (
            <button
              type="button"
              className="search-clear-btn"
              onClick={() => setSearchInput('')}
              title="Clear search"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Subject / Syllabus Selector */}
      <div className="filter-group">
        <label className="filter-label" htmlFor="syllabus-select">Subject & Syllabus</label>
        <select
          id="syllabus-select"
          className="filter-select"
          value={filters.syllabusId || ''}
          onChange={handleSyllabusChange}
        >
          <option value="">All Subjects</option>
          {syllabuses.map((s) => (
            <option key={s.id} value={s.id}>
              {s.subject_name} ({s.subject_code})
            </option>
          ))}
        </select>
      </div>

      {/* Topic Selector */}
      <div className="filter-group">
        <label className="filter-label" htmlFor="topic-select">Topic</label>
        <select
          id="topic-select"
          className="filter-select"
          value={filters.topic || ''}
          onChange={handleTopicChange}
        >
          <option value="">All Topics ({topics.length})</option>
          {topics.map((t) => (
            <option key={t.topic} value={t.topic}>
              {t.topic}
            </option>
          ))}
        </select>
      </div>

      {/* Paper Type Selector */}
      <div className="filter-group">
        <label className="filter-label">Paper Type</label>
        <div className="filter-pills">
          <button
            type="button"
            className={`filter-pill ${!filters.paperNumber ? 'filter-pill--active' : ''}`}
            onClick={() => handlePaperTypeClick(undefined)}
          >
            All Papers
          </button>
          <button
            type="button"
            className={`filter-pill ${filters.paperNumber === 'mcq' ? 'filter-pill--active' : ''}`}
            onClick={() => handlePaperTypeClick('mcq')}
          >
            P1/P2 MCQ
          </button>
          <button
            type="button"
            className={`filter-pill ${filters.paperNumber === 'theory' ? 'filter-pill--active' : ''}`}
            onClick={() => handlePaperTypeClick('theory')}
          >
            P3/P4 Theory
          </button>
          <button
            type="button"
            className={`filter-pill ${filters.paperNumber === 'atp' ? 'filter-pill--active' : ''}`}
            onClick={() => handlePaperTypeClick('atp')}
          >
            P6 ATP
          </button>
        </div>
      </div>

      {/* Difficulty Selector */}
      <div className="filter-group">
        <label className="filter-label">Difficulty</label>
        <div className="filter-pills">
          <button
            type="button"
            className={`filter-pill ${!filters.difficulty ? 'filter-pill--active' : ''}`}
            onClick={() => handleDifficultyClick(undefined)}
          >
            All
          </button>
          <button
            type="button"
            className={`filter-pill filter-pill--easy ${filters.difficulty === 'Easy' ? 'filter-pill--active' : ''}`}
            onClick={() => handleDifficultyClick('Easy')}
          >
            🟢 Easy
          </button>
          <button
            type="button"
            className={`filter-pill filter-pill--medium ${filters.difficulty === 'Medium' ? 'filter-pill--active' : ''}`}
            onClick={() => handleDifficultyClick('Medium')}
          >
            🟡 Medium
          </button>
          <button
            type="button"
            className={`filter-pill filter-pill--hard ${filters.difficulty === 'Hard' ? 'filter-pill--active' : ''}`}
            onClick={() => handleDifficultyClick('Hard')}
          >
            🔴 Hard
          </button>
        </div>
      </div>

      {/* Question Style */}
      <div className="filter-group">
        <label className="filter-label" htmlFor="style-select">Question Style</label>
        <select
          id="style-select"
          className="filter-select"
          value={filters.questionStyle || ''}
          onChange={handleStyleChange}
        >
          <option value="">All Styles</option>
          <option value="Structured">Structured / Multi-part</option>
          <option value="Multiple Choice">Multiple Choice</option>
          <option value="Calculation">Calculation</option>
          <option value="Short Answer">Short Answer</option>
        </select>
      </div>

      {/* Sort By */}
      <div className="filter-group">
        <label className="filter-label" htmlFor="sort-select">Sort By</label>
        <select
          id="sort-select"
          className="filter-select"
          value={filters.sortBy || 'year_desc'}
          onChange={handleSortChange}
        >
          <option value="year_desc">Year (Newest First)</option>
          <option value="marks_desc">Marks (High to Low)</option>
          <option value="marks_asc">Marks (Low to High)</option>
          <option value="created_at">Recently Added</option>
        </select>
      </div>

      {/* Active Filter Summary / Reset */}
      {hasActiveFilters && (
        <div className="filter-reset-section animate-fade-in">
          <div className="filter-results-info">
            Matching <span className="text-highlight">{totalResults}</span> questions
          </div>
          <button
            type="button"
            className="filter-reset-btn"
            onClick={handleResetFilters}
            id="reset-all-filters-btn"
          >
            ↺ Reset All Filters
          </button>
        </div>
      )}
    </aside>
  );
}
