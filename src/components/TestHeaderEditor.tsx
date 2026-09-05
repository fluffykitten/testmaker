import { useState } from 'react';
import type { ExamHeaderConfig } from '../services/testBuilderService';
import './TestHeaderEditor.css';

interface TestHeaderEditorProps {
  config: ExamHeaderConfig;
  onChange: (updated: ExamHeaderConfig) => void;
  suggestedDuration: number;
}

export function TestHeaderEditor({
  config,
  onChange,
  suggestedDuration,
}: TestHeaderEditorProps) {
  const [isExpanded, setIsExpanded] = useState(true);

  const handleFieldChange = (field: keyof ExamHeaderConfig, value: any) => {
    onChange({
      ...config,
      [field]: value,
    });
  };

  return (
    <div className="header-editor-card">
      <div className="header-editor-title-row" onClick={() => setIsExpanded(!isExpanded)}>
        <div className="header-editor-title-group">
          <span className="header-editor-icon">📝</span>
          <div>
            <h3 className="header-editor-heading">Exam Paper Configuration</h3>
            <p className="header-editor-subheading">
              {config.title || 'Untitled Assessment'} • {config.schoolName || 'Default School'} • {config.durationMinutes} mins
            </p>
          </div>
        </div>

        <button
          type="button"
          className="header-editor-toggle"
          title={isExpanded ? 'Collapse settings' : 'Expand settings'}
        >
          {isExpanded ? '▲ Collapse' : '▼ Customize Header'}
        </button>
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
            <label className="header-field-label" htmlFor="exam-instructions">
              Candidate Instructions
            </label>
            <textarea
              id="exam-instructions"
              rows={2}
              className="header-textarea"
              placeholder="e.g. Answer all questions. Write in dark blue or black pen. You may use an electronic calculator."
              value={config.instructions}
              onChange={(e) => handleFieldChange('instructions', e.target.value)}
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
    </div>
  );
}
