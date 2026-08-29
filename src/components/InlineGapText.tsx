import React, { useId, useMemo } from 'react';
import { ExamMathText } from './ExamMathText';
import './InlineGapText.css';

export interface GapSegment {
  type: 'text' | 'gap';
  content?: string;
  gapId: string;
  gapNum: number;
  expectedAnswer?: string;
}

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

/**
 * Checks if a string contains inline gap tokens like [1], [blank], ____, {{1}}
 */
export function hasInlineGaps(text: string): boolean {
  if (!text) return false;
  // Match [1], [2], [blank 1], [gap 1], {{1}}, or 3+ underscores
  const gapPattern = /(\[\s*\d+\s*\]|\[\s*(?:blank|gap)\s*\d*\s*\]|\{\{\s*\d+\s*\}\}|_{3,}|\[_{2,}\]|\[\s*\d+\s*:\s*[^\]]+\])/i;
  return gapPattern.test(text);
}

/**
 * Parses question text into text blocks and numbered gap objects
 */
export function parseGapSegments(text: string): GapSegment[] {
  if (!text) return [];

  const segments: GapSegment[] = [];
  const gapRegex = /(\[\s*\d+\s*\]|\[\s*(?:blank|gap)\s*(\d*)\s*\]|\{\{\s*\d+\s*\}\}|_{3,}|\[_{2,}\]|\[\s*(\d+)\s*:\s*([^\]]+)\])/gi;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let autoGapCounter = 1;

  while ((match = gapRegex.exec(text)) !== null) {
    // 1. Preceding text segment
    if (match.index > lastIndex) {
      const textChunk = text.substring(lastIndex, match.index);
      if (textChunk) {
        segments.push({ type: 'text', content: textChunk, gapId: '', gapNum: 0 });
      }
    }

    const matchedStr = match[0];
    let gapNum = autoGapCounter;
    let expectedAnswer: string | undefined = undefined;

    // Check if matched format has an explicit gap number
    const numMatch = matchedStr.match(/\d+/);
    if (numMatch) {
      gapNum = parseInt(numMatch[0], 10);
    } else {
      gapNum = autoGapCounter;
    }

    // Check for inline answer syntax e.g. [1: Springfield]
    const keyMatch = matchedStr.match(/\[\s*\d+\s*:\s*([^\]]+)\]/);
    if (keyMatch) {
      expectedAnswer = keyMatch[1].trim();
    }

    const gapId = `gap_${gapNum}`;
    segments.push({
      type: 'gap',
      gapId,
      gapNum,
      expectedAnswer,
    });

    autoGapCounter = Math.max(autoGapCounter + 1, gapNum + 1);
    lastIndex = match.index + matchedStr.length;
  }

  // 2. Trailing text segment
  if (lastIndex < text.length) {
    const trailing = text.substring(lastIndex);
    if (trailing) {
      segments.push({ type: 'text', content: trailing, gapId: '', gapNum: 0 });
    }
  }

  return segments;
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
            <input
              type="text"
              id={`gap-input-${compId}-${seg.gapNum}`}
              className={`sq-gap-input sq-cloze-input-${compId}`}
              value={gapVal}
              placeholder={`[ ${seg.gapNum} ]`}
              onChange={(e) => onGapChange?.(seg.gapId, e.target.value)}
              onKeyDown={(e) => handleKeyDown(e, currentGapIndex)}
              autoComplete="off"
              spellCheck="false"
            />
          </span>
        );
      })}
    </div>
  );
}
