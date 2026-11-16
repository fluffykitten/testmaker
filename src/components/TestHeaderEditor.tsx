import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import type { ExamHeaderConfig } from '../services/testBuilderService';
import {
  wrapSelectionWithToken,
  toggleBulletPrefixOnSelection,
  insertNewLineAtSelection,
  type SelectionWrapResult,
} from '../lib/readingPassageUtils';
import './TestHeaderEditor.css';

interface TestHeaderEditorProps {
  config: ExamHeaderConfig;
  onChange: (updated: ExamHeaderConfig) => void;
  suggestedDuration: number;
  onResetToAutoDetect?: () => void;
}

export function TestHeaderEditor({
  config,
  onChange,
  suggestedDuration,
  onResetToAutoDetect,
}: TestHeaderEditorProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const instructionsRef = useRef<HTMLTextAreaElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    selStart: number;
    selEnd: number;
    hasSelection: boolean;
  } | null>(null);

  const handleFieldChange = (field: keyof ExamHeaderConfig, value: any) => {
    onChange({
      ...config,
      [field]: value,
      isUserCustomized: true,
    });
  };

  // Auto-resize Candidate Instructions textarea to fit its content cleanly
  useLayoutEffect(() => {
    if (!isExpanded) return;
    const el = instructionsRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(68, el.scrollHeight)}px`;
  }, [config.instructions, isExpanded]);

  // Dismiss instruction context menu on outside click or Escape
  useEffect(() => {
    if (!ctxMenu) return;
    const handleOutside = (ev: MouseEvent) => {
      if (contextMenuRef.current && contextMenuRef.current.contains(ev.target as Node)) return;
      setCtxMenu(null);
    };
    const handleKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setCtxMenu(null);
    };
    window.addEventListener('mousedown', handleOutside);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handleOutside);
      window.removeEventListener('keydown', handleKey);
    };
  }, [ctxMenu]);

  const applyInstructionTransform = (
    transform: (text: string, start: number, end: number) => SelectionWrapResult,
    explicitRange?: { start: number; end: number }
  ) => {
    const el = instructionsRef.current;
    const currentText = config.instructions || '';
    const start = explicitRange ? explicitRange.start : (el ? el.selectionStart : currentText.length);
    const end = explicitRange ? explicitRange.end : (el ? el.selectionEnd : currentText.length);

    const res = transform(currentText, start, end);
    handleFieldChange('instructions', res.nextText);
    setCtxMenu(null);

    setTimeout(() => {
      const target = instructionsRef.current;
      if (target) {
        target.focus();
        target.setSelectionRange(res.nextSelStart, res.nextSelEnd);
      }
    }, 20);
  };

  const handleInstructionsContextMenu = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    const menuW = 216;
    const menuH = 220;
    const x = Math.max(8, Math.min(e.clientX, window.innerWidth - menuW - 12));
    const y = Math.max(8, Math.min(e.clientY, window.innerHeight - menuH - 12));
    setCtxMenu({
      x,
      y,
      selStart: el.selectionStart,
      selEnd: el.selectionEnd,
      hasSelection: el.selectionEnd > el.selectionStart,
    });
  };

  const handleInstructionsKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === 'b') {
      e.preventDefault();
      applyInstructionTransform((t, s, end) => wrapSelectionWithToken(t, s, end, '**', '**', 'bold text'));
    } else if (key === 'i') {
      e.preventDefault();
      applyInstructionTransform((t, s, end) => wrapSelectionWithToken(t, s, end, '*', '*', 'italic text'));
    } else if (key === 'u') {
      e.preventDefault();
      applyInstructionTransform((t, s, end) => wrapSelectionWithToken(t, s, end, '[u]', '[/u]', 'underlined text'));
    }
  };

  return (
    <div className="header-editor-card">
      <div className="header-editor-title-row" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="header-editor-title-group">
          <span className="header-editor-icon">📝</span>
          <div>
            <h3 className="header-editor-heading">
              Exam Paper Configuration
              {config.isUserCustomized && (
                <span className="header-editor-custom-badge" title="Header values locked by teacher edits">
                  Customized
                </span>
              )}
            </h3>
            <p className="header-editor-subheading">
              {config.title || 'Untitled Assessment'} • {config.schoolName || 'Default School'} • {config.durationMinutes} mins
            </p>
          </div>
        </div>

        <div className="header-editor-actions" onClick={(e) => e.stopPropagation()}>
          {onResetToAutoDetect && (
            <button
              type="button"
              className="header-editor-autodetect-btn"
              onClick={onResetToAutoDetect}
              title="Reset header fields and auto-detect subject from current questions"
            >
              ↺ Auto-Detect
            </button>
          )}
          <button
            type="button"
            className="header-editor-toggle"
            title={isExpanded ? 'Collapse settings' : 'Expand settings'}
            onClick={() => setIsExpanded(!isExpanded)}
          >
            {isExpanded ? '▲ Collapse' : '▼ Customize Header'}
          </button>
        </div>
      </div>

      {isExpanded && (
        <div className="header-editor-form animate-fade-in">
          {/* Header Layout Style Selector */}
          <div className="header-template-selector">
            <span className="header-template-label">Cover Page Style:</span>
            <div className="header-template-options">
              <button
                type="button"
                className={`header-template-btn ${(!config.layoutTemplate || config.layoutTemplate === 'cambridge') ? 'header-template-btn--active' : ''}`}
                onClick={() => handleFieldChange('layoutTemplate', 'cambridge')}
              >
                🎓 Cambridge IGCSE Style
              </button>
              <button
                type="button"
                className={`header-template-btn ${config.layoutTemplate === 'standard' ? 'header-template-btn--active' : ''}`}
                onClick={() => handleFieldChange('layoutTemplate', 'standard')}
              >
                🏫 Standard School Exam Style
              </button>
            </div>
          </div>

          <div className="header-grid-2">
            {/* Exam Title */}
            <div className="header-field">
              <label className="header-field-label" htmlFor="exam-title">
                Exam Title <span className="text-required">*</span>
              </label>
              <input
                id="exam-title"
                type="text"
                className="header-input"
                placeholder="e.g. IGCSE Chemistry End of Term Assessment"
                value={config.title}
                onChange={(e) => handleFieldChange('title', e.target.value)}
              />
            </div>

            {/* School / Institution Name */}
            <div className="header-field">
              <label className="header-field-label" htmlFor="school-name">
                School / Institution Name
              </label>
              <input
                id="school-name"
                type="text"
                className="header-input"
                placeholder="e.g. Cambridge International Academy"
                value={config.schoolName}
                onChange={(e) => handleFieldChange('schoolName', e.target.value)}
              />
            </div>
          </div>

          <div className="header-grid-3">
            {/* Subject */}
            <div className="header-field">
              <label className="header-field-label" htmlFor="exam-subject">
                Subject
              </label>
              <input
                id="exam-subject"
                type="text"
                className="header-input"
                placeholder="e.g. Chemistry"
                value={config.subject}
                onChange={(e) => handleFieldChange('subject', e.target.value)}
              />
            </div>

            {/* Subject Code */}
            <div className="header-field">
              <label className="header-field-label" htmlFor="exam-code">
                Syllabus Code
              </label>
              <input
                id="exam-code"
                type="text"
                className="header-input"
                placeholder="e.g. 0620 / 41"
                value={config.subjectCode}
                onChange={(e) => handleFieldChange('subjectCode', e.target.value)}
              />
            </div>

            {/* Duration */}
            <div className="header-field">
              <div className="header-field-label-flex">
                <label className="header-field-label" htmlFor="exam-duration">
                  Duration (Minutes)
                </label>
                {suggestedDuration > 0 && suggestedDuration !== config.durationMinutes && (
                  <button
                    type="button"
                    className="header-suggest-btn"
                    onClick={() => handleFieldChange('durationMinutes', suggestedDuration)}
                    title={`Set duration to recommended ~${suggestedDuration} mins`}
                  >
                    Auto ({suggestedDuration}m)
                  </button>
                )}
              </div>
              <input
                id="exam-duration"
                type="number"
                min="5"
                max="300"
                className="header-input"
                value={config.durationMinutes}
                onChange={(e) => handleFieldChange('durationMinutes', parseInt(e.target.value) || 0)}
              />
            </div>
          </div>

          {/* Instructions */}
          <div className="header-field">
            <div className="header-field-label-flex">
              <label className="header-field-label" htmlFor="exam-instructions">
                Candidate Instructions
              </label>
              <span className="header-field-hint">
                Press Enter for new lines · Start with &quot;- &quot; for bullets · Right-click to format
              </span>
            </div>
            <textarea
              id="exam-instructions"
              ref={instructionsRef}
              rows={2}
              className="header-textarea header-textarea--auto"
              placeholder="e.g. Answer all questions.&#10;- Write in dark blue or black pen.&#10;- You may use an electronic calculator."
              value={config.instructions}
              onChange={(e) => handleFieldChange('instructions', e.target.value)}
              onContextMenu={handleInstructionsContextMenu}
              onKeyDown={handleInstructionsKeyDown}
            />
          </div>

          {/* Additional Materials */}
          <div className="header-field">
            <label className="header-field-label" htmlFor="exam-materials">
              Additional Materials Provided
            </label>
            <input
              id="exam-materials"
              type="text"
              className="header-input"
              placeholder="e.g. Periodic Table (enclosed), Rough scratch paper"
              value={config.additionalMaterials || ''}
              onChange={(e) => handleFieldChange('additionalMaterials', e.target.value)}
            />
          </div>
        </div>
      )}

      {ctxMenu && (
        <div
          ref={contextMenuRef}
          className="header-inst-context-menu"
          role="menu"
          aria-label="Instruction Formatting Menu"
          style={{ top: `${ctxMenu.y}px`, left: `${ctxMenu.x}px` }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="header-inst-ctx-title">
            {ctxMenu.hasSelection ? 'Format Selection' : 'Insert Format'}
          </div>
          <button
            type="button"
            role="menuitem"
            className="header-inst-ctx-item"
            onClick={() =>
              applyInstructionTransform(
                (t, s, e) => wrapSelectionWithToken(t, s, e, '**', '**', 'bold text'),
                { start: ctxMenu.selStart, end: ctxMenu.selEnd }
              )
            }
          >
            <span><strong>B</strong> Bold</span>
            <kbd>Ctrl+B</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            className="header-inst-ctx-item"
            onClick={() =>
              applyInstructionTransform(
                (t, s, e) => wrapSelectionWithToken(t, s, e, '*', '*', 'italic text'),
                { start: ctxMenu.selStart, end: ctxMenu.selEnd }
              )
            }
          >
            <span><em>I</em> Italic</span>
            <kbd>Ctrl+I</kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            className="header-inst-ctx-item"
            onClick={() =>
              applyInstructionTransform(
                (t, s, e) => wrapSelectionWithToken(t, s, e, '[u]', '[/u]', 'underlined text'),
                { start: ctxMenu.selStart, end: ctxMenu.selEnd }
              )
            }
          >
            <span><u>U</u> Underline</span>
            <kbd>Ctrl+U</kbd>
          </button>
          <div className="header-inst-ctx-divider" />
          <button
            type="button"
            role="menuitem"
            className="header-inst-ctx-item"
            onClick={() =>
              applyInstructionTransform(toggleBulletPrefixOnSelection, {
                start: ctxMenu.selStart,
                end: ctxMenu.selEnd,
              })
            }
          >
            <span>• Toggle Bullet Point</span>
            <kbd>- </kbd>
          </button>
          <button
            type="button"
            role="menuitem"
            className="header-inst-ctx-item"
            onClick={() =>
              applyInstructionTransform(insertNewLineAtSelection, {
                start: ctxMenu.selStart,
                end: ctxMenu.selEnd,
              })
            }
          >
            <span>↵ New Line</span>
            <kbd>Enter</kbd>
          </button>
        </div>
      )}
    </div>
  );
}
