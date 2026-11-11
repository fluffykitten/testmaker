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
  if (lower.includes('econ')) {
    return SUBJECT_REGISTRY.economics;
  }
  if (lower.includes('computer') || /\bcs\b/.test(lower) || lower.includes('python') || lower.includes('coding')) {
    return SUBJECT_REGISTRY['computer science'];
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

