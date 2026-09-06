import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type { PublicRosterStudent } from '../services/studentRosterService';
import './CandidateNameAutocomplete.css';

export interface CandidateNameAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onSelectCandidate: (candidate: PublicRosterStudent) => void;
  roster: PublicRosterStudent[];
  selectedClass?: string;
  placeholder?: string;
  disabled?: boolean;
  hasError?: boolean;
  autoFocus?: boolean;
}

/**
 * Highlights matches of query within text safely
 */
function highlightMatch(text: string, query: string): React.ReactNode {
  const cleanQ = query.trim();
  if (!cleanQ) return text;

  const idx = text.toLowerCase().indexOf(cleanQ.toLowerCase());
  if (idx === -1) return text;

  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + cleanQ.length);
  const after = text.slice(idx + cleanQ.length);

  return (
    <>
      {before}
      <span className="candidate-autocomplete-highlight">{match}</span>
      {highlightMatch(after, query)}
    </>
  );
}

export function CandidateNameAutocomplete({
  value,
  onChange,
  onSelectCandidate,
  roster,
  selectedClass,
  placeholder = 'Select or type your name...',
  disabled = false,
  hasError = false,
  autoFocus = false,
}: CandidateNameAutocompleteProps) {
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [highlightedIndex, setHighlightedIndex] = useState<number>(-1);

  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Filter candidates based on search query and optional selected class
  const filteredCandidates = useMemo(() => {
    if (!roster || roster.length === 0) return [];

    const q = value.trim().toLowerCase();
    const cleanClass = (selectedClass || '').trim().toLowerCase();

    if (!q) {
      // If no query typed, show candidates for selected class first, then others
      return [...roster].sort((a, b) => {
        const aMatchesClass = cleanClass && a.class.trim().toLowerCase() === cleanClass;
        const bMatchesClass = cleanClass && b.class.trim().toLowerCase() === cleanClass;
        if (aMatchesClass && !bMatchesClass) return -1;
        if (!aMatchesClass && bMatchesClass) return 1;
        return a.name.localeCompare(b.name);
      }).slice(0, 35);
    }

    // Filter matching name, candidate number, or class
    const matches = roster.filter((student) => {
      const sName = student.name.toLowerCase();
      const sClass = student.class.toLowerCase();
      const sNum = (student.candidateNumber || '').toLowerCase();
      return sName.includes(q) || sClass.includes(q) || sNum.includes(q);
    });

    // Score and prioritize results
    return matches.sort((a, b) => {
      const aName = a.name.toLowerCase();
      const bName = b.name.toLowerCase();

      // 1. Exact full name match
      if (aName === q && bName !== q) return -1;
      if (bName === q && aName !== q) return 1;

      // 2. Name starts with query
      const aStarts = aName.startsWith(q);
      const bStarts = bName.startsWith(q);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;

      // 3. Current selected class priority
      const aMatchesClass = cleanClass && a.class.trim().toLowerCase() === cleanClass;
      const bMatchesClass = cleanClass && b.class.trim().toLowerCase() === cleanClass;
      if (aMatchesClass && !bMatchesClass) return -1;
      if (!aMatchesClass && bMatchesClass) return 1;

      return aName.localeCompare(bName);
    }).slice(0, 35);
  }, [roster, value, selectedClass]);

  // Outside click listener to dismiss menu
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent | TouchEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('touchstart', handleOutsideClick);
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('touchstart', handleOutsideClick);
    };
  }, []);

  // Scroll active item into view when navigating via arrow keys
  useEffect(() => {
    if (highlightedIndex >= 0 && listRef.current) {
      const activeEl = listRef.current.children[highlightedIndex + 1] as HTMLElement; // +1 accounts for header
      if (activeEl && typeof activeEl.scrollIntoView === 'function') {
        activeEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [highlightedIndex]);

  const handleSelect = useCallback(
    (student: PublicRosterStudent) => {
      onSelectCandidate(student);
      setIsOpen(false);
      setHighlightedIndex(-1);
    },
    [onSelectCandidate]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        setHighlightedIndex(filteredCandidates.length > 0 ? 0 : -1);
      } else {
        setHighlightedIndex((prev) =>
          filteredCandidates.length > 0 ? (prev + 1) % filteredCandidates.length : -1
        );
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen) {
        setIsOpen(true);
        setHighlightedIndex(filteredCandidates.length > 0 ? filteredCandidates.length - 1 : -1);
      } else {
        setHighlightedIndex((prev) =>
          filteredCandidates.length > 0
            ? (prev - 1 + filteredCandidates.length) % filteredCandidates.length
            : -1
        );
      }
    } else if (e.key === 'Enter') {
      if (isOpen && highlightedIndex >= 0 && highlightedIndex < filteredCandidates.length) {
        e.preventDefault();
        handleSelect(filteredCandidates[highlightedIndex]);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsOpen(false);
      setHighlightedIndex(-1);
    } else if (e.key === 'Tab') {
      setIsOpen(false);
    }
  };

  const handleClear = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onChange('');
    setIsOpen(true);
    setHighlightedIndex(-1);
    inputRef.current?.focus();
  };

  const handleToggle = (e: React.MouseEvent) => {
    e.preventDefault();
    if (disabled) return;
    setIsOpen((prev) => !prev);
    inputRef.current?.focus();
  };

  const cleanQuery = value.trim();

  return (
    <div className="candidate-autocomplete-root" ref={rootRef}>
      <div className="candidate-autocomplete-input-wrap">
        <span className="candidate-autocomplete-icon" aria-hidden="true">
          👤
        </span>
        <input
          ref={inputRef}
          type="text"
          className={`candidate-autocomplete-input ${hasError ? 'has-error' : ''}`}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            setIsOpen(true);
            setHighlightedIndex(-1);
          }}
          onFocus={() => {
            if (roster && roster.length > 0) {
              setIsOpen(true);
            }
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          autoFocus={autoFocus}
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={isOpen}
          aria-autocomplete="list"
        />

        <div className="candidate-autocomplete-actions">
          {value && !disabled && (
            <button
              type="button"
              className="candidate-autocomplete-clear-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleClear}
              title="Clear candidate name"
              aria-label="Clear name"
            >
              ✕
            </button>
          )}
          {roster && roster.length > 0 && !disabled && (
            <button
              type="button"
              className={`candidate-autocomplete-toggle-btn ${isOpen ? 'open' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleToggle}
              title={isOpen ? 'Close suggestions' : 'Open student directory'}
              aria-label="Toggle student list"
            >
              ▼
            </button>
          )}
        </div>
      </div>

      {isOpen && roster && roster.length > 0 && (
        <ul className="candidate-autocomplete-menu" ref={listRef} role="listbox">
          <li className="candidate-autocomplete-header" role="presentation">
            <span>Official Student Roster</span>
            <span>{filteredCandidates.length} found</span>
          </li>

          {filteredCandidates.length === 0 ? (
            <li className="candidate-autocomplete-empty" role="presentation">
              <strong>No matching student found</strong>
              <span>Press enter to proceed with manual entry: "{cleanQuery}"</span>
            </li>
          ) : (
            filteredCandidates.map((student, index) => {
              const isSelected = student.name.trim().toLowerCase() === value.trim().toLowerCase();
              const isHighlighted = highlightedIndex === index;
              const isCurrentClass =
                selectedClass &&
                student.class.trim().toLowerCase() === selectedClass.trim().toLowerCase();

              return (
                <li
                  key={student.id || `${student.name}_${student.class}_${index}`}
                  className={`candidate-autocomplete-item ${isHighlighted ? 'highlighted' : ''} ${
                    isSelected ? 'selected' : ''
                  }`}
                  role="option"
                  aria-selected={isSelected}
                  // onMouseDown with preventDefault ensures the input doesn't lose focus or drop event
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleSelect(student);
                  }}
                  onClick={() => handleSelect(student)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                >
                  <div className="candidate-autocomplete-info">
                    <span className="candidate-autocomplete-name">
                      {highlightMatch(student.name, value)}
                    </span>
                  </div>

                  <div className="candidate-autocomplete-meta">
                    <span
                      className={`candidate-autocomplete-badge ${
                        isCurrentClass ? 'current-class' : ''
                      }`}
                    >
                      {student.class}
                    </span>
                    {student.candidateNumber && (
                      <span className="candidate-autocomplete-id-badge">
                        #{student.candidateNumber}
                      </span>
                    )}
                  </div>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
