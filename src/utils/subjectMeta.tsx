import React from 'react';

export interface SubjectMetadata {
  id: string;
  name: string;
  code: string;
  color: string;
  bgLight: string;
  borderLight: string;
  bgDark: string;
  borderDark: string;
  description: string;
}

/**
 * Standard Cambridge and Core Subject Catalog with verified codes and palette
 */
export const SUBJECT_REGISTRY: Record<string, SubjectMetadata> = {
  mathematics: {
    id: 'mathematics',
    name: 'Mathematics',
    code: '0580 / 9709',
    color: '#4f46e5',
    bgLight: '#eef2ff',
    borderLight: '#c7d2fe',
    bgDark: 'rgba(79, 70, 229, 0.15)',
    borderDark: 'rgba(79, 70, 229, 0.35)',
    description: 'Pure mathematics, calculus, algebra, trigonometry & statistics',
  },
  chemistry: {
    id: 'chemistry',
    name: 'Chemistry',
    code: '0620 / 9701',
    color: '#059669',
    bgLight: '#ecfdf5',
    borderLight: '#a7f3d0',
    bgDark: 'rgba(5, 150, 105, 0.15)',
    borderDark: 'rgba(5, 150, 105, 0.35)',
    description: 'Stoichiometry, physical, organic & inorganic chemistry principles',
  },
  physics: {
    id: 'physics',
    name: 'Physics',
    code: '0625 / 9702',
    color: '#0284c7',
    bgLight: '#f0f9ff',
    borderLight: '#bae6fd',
    bgDark: 'rgba(2, 132, 199, 0.15)',
    borderDark: 'rgba(2, 132, 199, 0.35)',
    description: 'Mechanics, wave properties, electromagnetism & quantum atomic physics',
  },
  biology: {
    id: 'biology',
    name: 'Biology',
    code: '0610 / 9700',
    color: '#16a34a',
    bgLight: '#f0fdf4',
    borderLight: '#bbf7d0',
    bgDark: 'rgba(22, 163, 74, 0.15)',
    borderDark: 'rgba(22, 163, 74, 0.35)',
    description: 'Cell biology, genetics, physiology, molecular systems & ecology',
  },
  'computer science': {
    id: 'computer science',
    name: 'Computer Science',
    code: '0478 / 9618',
    color: '#7c3aed',
    bgLight: '#f5f3ff',
    borderLight: '#ddd6fe',
    bgDark: 'rgba(124, 58, 237, 0.15)',
    borderDark: 'rgba(124, 58, 237, 0.35)',
    description: 'Algorithms, data structures, computer architecture & logic networks',
  },
  economics: {
    id: 'economics',
    name: 'Economics',
    code: '0455 / 9708',
    color: '#d97706',
    bgLight: '#fffbeb',
    borderLight: '#fde68a',
    bgDark: 'rgba(217, 119, 6, 0.15)',
    borderDark: 'rgba(217, 119, 6, 0.35)',
    description: 'Micro & macro economics, market equilibrium & fiscal dynamics',
  },
  'business studies': {
    id: 'business studies',
    name: 'Business Studies',
    code: '0450 / 9609',
    color: '#0284c7',
    bgLight: '#f0f9ff',
    borderLight: '#bae6fd',
    bgDark: 'rgba(2, 132, 199, 0.15)',
    borderDark: 'rgba(2, 132, 199, 0.35)',
    description: 'Enterprise management, operations, marketing strategy & finance',
  },
  geography: {
    id: 'geography',
    name: 'Geography',
    code: '0460 / 9696',
    color: '#0d9488',
    bgLight: '#f0fdfa',
    borderLight: '#99f6e4',
    bgDark: 'rgba(13, 148, 136, 0.15)',
    borderDark: 'rgba(13, 148, 136, 0.35)',
    description: 'Physical geography, urban topography, climate systems & human settlements',
  },
  history: {
    id: 'history',
    name: 'History',
    code: '0470 / 9489',
    color: '#78716c',
    bgLight: '#f5f5f4',
    borderLight: '#d6d3d1',
    bgDark: 'rgba(120, 113, 108, 0.15)',
    borderDark: 'rgba(120, 113, 108, 0.35)',
    description: 'Modern 20th century international relations, treatises & developments',
  },
  english: {
    id: 'english',
    name: 'English Language',
    code: '0500 / 9093',
    color: '#6366f1',
    bgLight: '#eef2ff',
    borderLight: '#c7d2fe',
    bgDark: 'rgba(99, 102, 241, 0.15)',
    borderDark: 'rgba(99, 102, 241, 0.35)',
    description: 'Reading analysis, narrative writing, comprehension & critical essay',
  },
  'bahasa indonesia': {
    id: 'bahasa indonesia',
    name: 'Bahasa Indonesia',
    code: '0545 / NAT-ID',
    color: '#e11d48',
    bgLight: '#fff1f2',
    borderLight: '#fecdd3',
    bgDark: 'rgba(225, 29, 72, 0.15)',
    borderDark: 'rgba(225, 29, 72, 0.35)',
    description: 'Literasi bahasa, tata bahasa baku, pemahaman wacana & komposisi karya',
  },
  'islamic studies': {
    id: 'islamic studies',
    name: 'Islamic Studies & Quran',
    code: '0493 / ICM-IS',
    color: '#047857',
    bgLight: '#ecfdf5',
    borderLight: '#a7f3d0',
    bgDark: 'rgba(4, 120, 87, 0.15)',
    borderDark: 'rgba(4, 120, 87, 0.35)',
    description: 'Hadith studies, Quranic literacy, Islamic jurisprudence & history',
  },
  general: {
    id: 'general',
    name: 'General Assessment',
    code: 'GEN-EXAM',
    color: '#475569',
    bgLight: '#f1f5f9',
    borderLight: '#cbd5e1',
    bgDark: 'rgba(71, 85, 105, 0.15)',
    borderDark: 'rgba(71, 85, 105, 0.35)',
    description: 'Interdisciplinary examinations, general testing & mixed question papers',
  },
};

/**
 * Normalizes any subject string to metadata
 */
export function getSubjectMetadata(rawSubject: string): SubjectMetadata {
  if (!rawSubject) return SUBJECT_REGISTRY.general;

  const lower = rawSubject.toLowerCase().trim();

  if (lower.includes('math') || lower.includes('algebra') || lower.includes('calculus')) {
    return SUBJECT_REGISTRY.mathematics;
  }
  if (lower.includes('chem')) {
    return SUBJECT_REGISTRY.chemistry;
  }
  if (lower.includes('phys')) {
    return SUBJECT_REGISTRY.physics;
  }
  if (lower.includes('bio')) {
    return SUBJECT_REGISTRY.biology;
  }
  if (lower.includes('computer') || lower.includes('cs') || lower.includes('python') || lower.includes('coding')) {
    return SUBJECT_REGISTRY['computer science'];
  }
  if (lower.includes('econ')) {
    return SUBJECT_REGISTRY.economics;
  }
  if (lower.includes('business')) {
    return SUBJECT_REGISTRY['business studies'];
  }
  if (lower.includes('geograph')) {
    return SUBJECT_REGISTRY.geography;
  }
  if (lower.includes('histor')) {
    return SUBJECT_REGISTRY.history;
  }
  if (lower.includes('english') || lower.includes('ielts') || lower.includes('toefl') || lower.includes('litera')) {
    return SUBJECT_REGISTRY.english;
  }
  if (lower.includes('indonesia') || lower.includes('bahasa')) {
    return SUBJECT_REGISTRY['bahasa indonesia'];
  }
  if (lower.includes('islam') || lower.includes('quran') || lower.includes('pai') || lower.includes('agama')) {
    return SUBJECT_REGISTRY['islamic studies'];
  }

  // Check direct key match
  for (const key of Object.keys(SUBJECT_REGISTRY)) {
    if (lower.includes(key)) return SUBJECT_REGISTRY[key];
  }

  // Fallback for custom named subjects
  return {
    id: rawSubject.toLowerCase().replace(/\s+/g, '-'),
    name: rawSubject,
    code: 'EXAM',
    color: '#475569',
    bgLight: '#f1f5f9',
    borderLight: '#cbd5e1',
    bgDark: 'rgba(71, 85, 105, 0.15)',
    borderDark: 'rgba(71, 85, 105, 0.35)',
    description: `Custom assessment papers for ${rawSubject}`,
  };
}

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
