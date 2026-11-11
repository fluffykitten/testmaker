import React from 'react';
import { getSubjectMetadata, SUBJECT_REGISTRY, type SubjectMetadata } from './subjectCatalog';

export { getSubjectMetadata, SUBJECT_REGISTRY, type SubjectMetadata };

interface SubjectIconProps {
  subject: string;
  size?: number;
  className?: string;
}

/**
 * Crisp, authentic vector logo icon for each subject type
 */
export const SubjectIcon: React.FC<SubjectIconProps> = ({ subject, size = 24, className = '' }) => {
  const meta = getSubjectMetadata(subject);
  const key = meta.id;

  switch (key) {
    case 'mathematics':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={meta.color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          aria-label="Mathematics"
        >
          {/* Compass and Sigma / Function */}
          <path d="M4 19L11 5l7 14" />
          <path d="M6.5 14h9" />
          <circle cx="11" cy="5" r="1.5" fill={meta.color} />
          <path d="M17 7h3l-3 4h3" />
        </svg>
      );

    case 'chemistry':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={meta.color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          aria-label="Chemistry"
        >
          {/* Laboratory Flask with Bubbles */}
          <path d="M10 2v5.5L4.5 18a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3L14 7.5V2" />
          <path d="M8.5 2h7" />
          <path d="M7 16h10" />
          <circle cx="10" cy="12" r="1" fill={meta.color} />
          <circle cx="13" cy="14" r="1.2" fill={meta.color} />
        </svg>
      );

    case 'physics':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={meta.color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          aria-label="Physics"
        >
          {/* Atomic Nucleus and Orbital Ellipses */}
          <circle cx="12" cy="12" r="2.5" fill={meta.color} />
          <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(30 12 12)" />
          <ellipse cx="12" cy="12" rx="9" ry="4" transform="rotate(-30 12 12)" />
        </svg>
      );

    case 'biology':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={meta.color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          aria-label="Biology"
        >
          {/* DNA Helix strand */}
          <path d="M2 15c6.667-6 13.333 0 20-6" />
          <path d="M2 9c6.667 6 13.333 0 20 6" />
          <path d="M5 12v3" />
          <path d="M12 9v6" />
          <path d="M19 9v3" />
          <path d="M8.5 9.5l1 5" />
          <path d="M15.5 9.5l-1 5" />
        </svg>
      );

    case 'computer science':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={meta.color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          aria-label="Computer Science"
        >
          {/* Code Terminal / Processor */}
          <rect x="3" y="4" width="18" height="15" rx="3" />
          <path d="M7 9l3 3-3 3" />
          <line x1="12" y1="15" x2="16" y2="15" />
          <line x1="8" y1="21" x2="16" y2="21" />
        </svg>
      );

    case 'economics':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={meta.color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          aria-label="Economics"
        >
          {/* Market Trending Chart & Target */}
          <path d="M3 3v18h18" />
          <path d="M19 9l-5 5-4-4-5 5" />
          <polyline points="15 9 19 9 19 13" />
        </svg>
      );

    case 'business studies':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={meta.color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          aria-label="Business Studies"
        >
          {/* Executive Briefcase */}
          <rect x="2" y="7" width="20" height="14" rx="2" />
          <path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2" />
          <path d="M12 12v2" />
          <path d="M2 13h20" />
        </svg>
      );

    case 'geography':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={meta.color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          aria-label="Geography"
        >
          {/* Globe & Meridians */}
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      );

    case 'history':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={meta.color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          aria-label="History"
        >
          {/* Classical Architectural Pillar */}
          <path d="M4 21h16" />
          <path d="M4 3h16" />
          <path d="M6 7v11" />
          <path d="M10 7v11" />
          <path d="M14 7v11" />
          <path d="M18 7v11" />
          <path d="M5 5h14" />
          <path d="M5 19h14" />
        </svg>
      );

    case 'english':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={meta.color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          aria-label="English"
        >
          {/* Open Book & Literary Quill */}
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
        </svg>
      );

    case 'bahasa indonesia':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={meta.color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          aria-label="Bahasa Indonesia"
        >
          {/* Dialogue & Literature Symbol */}
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          <path d="M8 9h8" />
          <path d="M8 13h5" />
        </svg>
      );

    case 'islamic studies':
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={meta.color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          aria-label="Islamic Studies"
        >
          {/* Crescent Star & Quranic Arch */}
          <path d="M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z" />
          <polygon points="17 4 17.8 5.6 19.6 5.9 18.3 7.2 18.6 9 17 8.1 15.4 9 15.7 7.2 14.4 5.9 16.2 5.6" fill={meta.color} />
        </svg>
      );

    default:
      return (
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          fill="none"
          stroke={meta.color}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={className}
          aria-label="General Examination"
        >
          {/* Academic Graduation Mortarboard */}
          <path d="M22 10v6M2 10l10-5 10 5-10 5z" />
          <path d="M6 12v5c3 3 9 3 12 0v-5" />
        </svg>
      );
  }
};
