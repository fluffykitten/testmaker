import React, { useId, useMemo } from 'react';
import { ExamMathText } from './ExamMathText';
import { hasInlineGaps, parseGapSegments, type GapSegment } from '../lib/inlineGapParser';
import './InlineGapText.css';

export { hasInlineGaps, parseGapSegments, type GapSegment };

export interface GapEvaluation {
  gapId: string;
  gapNum: number;
  studentAnswer: string;
  expectedAnswer?: string;
  isCorrect?: boolean;
}

interface InlineGapTextProps {
  content: string;
  values?: Record<string, string>;
  evaluations?: Record<string, GapEvaluation>;
  isReadOnly?: boolean;
  onGapChange?: (gapId: string, value: string) => void;
  className?: string;
}

export function InlineGapText({
  content,
  values = {},
  evaluations,
  isReadOnly = false,
  onGapChange,
  className = '',
}: InlineGapTextProps) {
  const compId = useId().replace(/[:]/g, '');

  const segments = useMemo(() => parseGapSegments(content), [content]);

  // Handle Tab/Enter forward jumping
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, currentGapIndex: number) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const allInputs = document.querySelectorAll<HTMLInputElement>(`.sq-cloze-input-${compId}`);
      if (allInputs[currentGapIndex + 1]) {
        allInputs[currentGapIndex + 1].focus();
      }
    }
  };

  let gapIndexCounter = 0;

  return (
    <div className={`sq-inline-gap-container ${className}`}>
      {segments.map((seg, idx) => {
        if (seg.type === 'text') {
          return <ExamMathText key={idx} content={seg.content || ''} />;
        }

        const currentGapIndex = gapIndexCounter++;
        const gapVal = values[seg.gapId] ?? values[String(seg.gapNum)] ?? '';
        const evalData = evaluations?.[seg.gapId] || evaluations?.[String(seg.gapNum)];

        // Review mode rendering with correctness pill
        if (isReadOnly) {
          const isCorrect = evalData?.isCorrect ?? (seg.expectedAnswer ? gapVal.trim().toLowerCase() === seg.expectedAnswer.trim().toLowerCase() : undefined);
          const expected = evalData?.expectedAnswer || seg.expectedAnswer;

          return (
            <span
              key={idx}
              className={`sq-gap-review-pill ${
                isCorrect === true
                  ? 'sq-gap-review-pill--correct'
                  : isCorrect === false
                  ? 'sq-gap-review-pill--incorrect'
                  : 'sq-gap-review-pill--neutral'
              }`}
            >
              <span className="sq-gap-num-tag">{seg.gapNum}</span>
              <span className="sq-gap-val-text">{gapVal || '(blank)'}</span>
              {isCorrect === true && <span className="sq-gap-status-icon">✓</span>}
              {isCorrect === false && (
                <span className="sq-gap-incorrect-wrap">
                  <span className="sq-gap-status-icon">✗</span>
                  {expected && <span className="sq-gap-key-hint">Ans: {expected}</span>}
                </span>
              )}
            </span>
          );
        }

        // Active Interactive Input Mode
        return (
          <span key={idx} className="sq-gap-input-wrap">
            <span className="sq-gap-badge">{seg.gapNum}</span>
            {seg.choices && seg.choices.length >= 2 ? (
              <select
                id={`gap-input-${compId}-${seg.gapNum}`}
                className={`sq-gap-select sq-cloze-input-${compId} ${gapVal ? 'sq-gap-select--filled' : ''}`}
                dir="auto"
                value={gapVal}
                aria-label={`Select term for blank ${seg.gapNum}`}
                onChange={(e) => onGapChange?.(seg.gapId, e.target.value)}
              >
                <option value="">Select term…</option>
                {seg.choices.map((choice, cIdx) => (
                  <option key={cIdx} value={choice}>
                    {choice}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                id={`gap-input-${compId}-${seg.gapNum}`}
                className={`sq-gap-input sq-cloze-input-${compId}`}
                dir="auto"
                value={gapVal}
                placeholder={`[ ${seg.gapNum} ]`}
                onChange={(e) => onGapChange?.(seg.gapId, e.target.value)}
                onKeyDown={(e) => handleKeyDown(e, currentGapIndex)}
                autoComplete="off"
                spellCheck="false"
              />
            )}
          </span>
        );
      })}
    </div>
  );
}
