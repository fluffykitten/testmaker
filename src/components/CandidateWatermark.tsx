import React, { useMemo } from 'react';
import './CandidateWatermark.css';

export interface CandidateWatermarkProps {
  candidateName?: string;
  candidateNumber?: string;
  candidateClass?: string;
  quizCode?: string;
  sessionHash?: string;
  timestamp?: string;
  opacity?: number;
  variant?: 'page' | 'diagram' | 'modal';
  className?: string;
}

export const CandidateWatermark: React.FC<CandidateWatermarkProps> = ({
  candidateName,
  candidateNumber,
  candidateClass,
  quizCode,
  sessionHash,
  timestamp,
  opacity,
  variant = 'page',
  className = '',
}) => {
  // Format primary and secondary watermark text strings
  const { line1, line2, patternId } = useMemo(() => {
    const name = (candidateName || 'OFFICIAL CANDIDATE').trim().toUpperCase();
    const num = candidateNumber ? `NO: ${candidateNumber.trim()}` : '';
    const cls = candidateClass ? `[${candidateClass.trim()}]` : '';
    const code = (quizCode || 'EXAM').trim().toUpperCase();
    const hash = (sessionHash || 'SESS').trim().toUpperCase();
    const timeStr = timestamp || new Date().toISOString().slice(0, 10);

    const l1 = [name, num, cls].filter(Boolean).join(' • ');
    const l2 = [`CODE: ${code}`, `ID: #${hash}`, timeStr].filter(Boolean).join(' • ');
    const pid = `wm-pat-${Math.random().toString(36).substring(2, 9)}`;

    return { line1: l1, line2: l2, patternId: pid };
  }, [candidateName, candidateNumber, candidateClass, quizCode, sessionHash, timestamp]);

  const defaultOpacity = variant === 'diagram' ? 0.13 : variant === 'modal' ? 0.11 : 0.08;
  const effectiveOpacity = opacity !== undefined ? opacity : defaultOpacity;

  return (
    <div
      className={`candidate-watermark-overlay candidate-watermark-overlay--${variant} ${className}`}
      style={{ opacity: effectiveOpacity }}
      aria-hidden="true"
    >
      <svg className="candidate-watermark-svg" width="100%" height="100%">
        <defs>
          <pattern
            id={patternId}
            width="340"
            height="170"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(-26)"
          >
            <text
              x="20"
              y="50"
              className="candidate-watermark-text candidate-watermark-text--primary"
            >
              {line1}
            </text>
            <text
              x="20"
              y="90"
              className="candidate-watermark-text candidate-watermark-text--secondary"
            >
              {line2}
            </text>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${patternId})`} />
      </svg>
    </div>
  );
};

export default CandidateWatermark;
