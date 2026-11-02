import React from 'react';
import type { GradeThresholds, GradeLetter } from '../utils/gradeThresholdUtils';
import {
  GRADE_PRESETS,
  GRADE_VISUALS,
  DEFAULT_GRADE_THRESHOLDS,
  validateGradeThresholds,
  calculateRawMarkCutoff,
} from '../utils/gradeThresholdUtils';
import './GradeThresholdEditor.css';

interface GradeThresholdEditorProps {
  value?: GradeThresholds;
  onChange: (thresholds: GradeThresholds) => void;
  totalMarks?: number;
  disabled?: boolean;
  className?: string;
}

const EDITABLE_TIERS: { key: keyof GradeThresholds; grade: GradeLetter }[] = [
  { key: 'aStar', grade: 'A*' },
  { key: 'a', grade: 'A' },
  { key: 'b', grade: 'B' },
  { key: 'c', grade: 'C' },
  { key: 'd', grade: 'D' },
  { key: 'e', grade: 'E' },
];

export const GradeThresholdEditor: React.FC<GradeThresholdEditorProps> = ({
  value = DEFAULT_GRADE_THRESHOLDS,
  onChange,
  totalMarks,
  disabled = false,
  className = '',
}) => {
  const current = value || DEFAULT_GRADE_THRESHOLDS;
  const validation = validateGradeThresholds(current);

  const handleTierChange = (key: keyof GradeThresholds, rawVal: string) => {
    const num = parseFloat(rawVal);
    const updated = {
      ...current,
      [key]: isNaN(num) ? 0 : num,
    };
    onChange(updated);
  };

  const handleApplyPreset = (presetThresholds: GradeThresholds) => {
    onChange({ ...presetThresholds });
  };

  return (
    <div className={`gte-container ${className}`}>
      {/* Preset Action Bar */}
      <div className="gte-presets-bar">
        <span className="gte-presets-label">Curve Presets:</span>
        <div className="gte-preset-chips">
          {GRADE_PRESETS.map((preset) => {
            const isMatch =
              current.aStar === preset.thresholds.aStar &&
              current.a === preset.thresholds.a &&
              current.b === preset.thresholds.b &&
              current.c === preset.thresholds.c &&
              current.d === preset.thresholds.d &&
              current.e === preset.thresholds.e;

            return (
              <button
                key={preset.id}
                type="button"
                className={`gte-preset-chip ${isMatch ? 'gte-preset-chip--active' : ''}`}
                onClick={() => handleApplyPreset(preset.thresholds)}
                disabled={disabled}
                title={preset.description}
              >
                {preset.name}
              </button>
            );
          })}
          <button
            type="button"
            className="gte-preset-chip gte-preset-chip--reset"
            onClick={() => handleApplyPreset(DEFAULT_GRADE_THRESHOLDS)}
            disabled={disabled}
            title="Reset to Cambridge standard (90/80/70/60/50/40)"
          >
            ↺ Reset
          </button>
        </div>
      </div>

      {/* Thresholds Grid */}
      <div className="gte-grid">
        {EDITABLE_TIERS.map(({ key, grade }) => {
          const visual = GRADE_VISUALS[grade];
          const pct = current[key];
          const rawMark = totalMarks && totalMarks > 0 ? calculateRawMarkCutoff(pct, totalMarks) : null;

          return (
            <div key={key} className="gte-tier-card">
              <div className="gte-tier-header">
                <span
                  className="gte-tier-badge"
                  style={{
                    backgroundColor: visual.color,
                    color: visual.textColor,
                  }}
                >
                  {grade}
                </span>
                <span className="gte-tier-title">{visual.tierName}</span>
              </div>

              <div className="gte-tier-input-wrap">
                <span className="gte-prefix">≥</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  className="gte-number-input"
                  value={pct || ''}
                  onChange={(e) => handleTierChange(key, e.target.value)}
                  disabled={disabled}
                  aria-label={`${grade} minimum percentage threshold`}
                />
                <span className="gte-unit">%</span>
              </div>

              {rawMark !== null && (
                <div className="gte-raw-marks" title={`Minimum ${rawMark} marks out of ${totalMarks}`}>
                  ≥ <strong>{rawMark}</strong> / {totalMarks} marks
                </div>
              )}
            </div>
          );
        })}

        {/* Ungraded Tier (U) Card */}
        <div className="gte-tier-card gte-tier-card--ungraded">
          <div className="gte-tier-header">
            <span
              className="gte-tier-badge"
              style={{
                backgroundColor: GRADE_VISUALS['U'].color,
                color: GRADE_VISUALS['U'].textColor,
              }}
            >
              U
            </span>
            <span className="gte-tier-title">{GRADE_VISUALS['U'].tierName}</span>
          </div>

          <div className="gte-tier-input-wrap gte-tier-auto">
            <span className="gte-prefix">&lt;</span>
            <span className="gte-auto-val">{current.e}%</span>
          </div>

          {totalMarks && totalMarks > 0 ? (
            <div className="gte-raw-marks" title={`Below ${calculateRawMarkCutoff(current.e, totalMarks)} marks`}>
              &lt; <strong>{calculateRawMarkCutoff(current.e, totalMarks)}</strong> marks
            </div>
          ) : (
            <div className="gte-raw-marks">Below Grade E cutoff</div>
          )}
        </div>
      </div>

      {/* Validation Alert */}
      {!validation.isValid && (
        <div className="gte-validation-error" role="alert">
          <span className="gte-error-icon">⚠️</span>
          <span>{validation.error}</span>
        </div>
      )}
    </div>
  );
};
