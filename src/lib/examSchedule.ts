// ─── Examination Schedule, Class Normalization & Seating Helpers ──────────────
// Pure domain helpers for desk card schedule filtering, ICM class normalization,
// room label formatting, and candidate distribution sorting.

export type ExamScheduleCategory = 'written' | 'practical' | 'other';

export interface ExamScheduleEntry {
  id: string;
  date: string;         // e.g. "Mon, 30 Nov 2026"
  time: string;         // e.g. "07.30 - 09.30"
  subject: string;      // e.g. "Mathematics"
  duration?: string;    // e.g. "120'"
  targetClass?: string; // e.g. "ALL", "IPA", "IPS", "X", "X IPA", "X IPA 1"
  category?: ExamScheduleCategory;
}

export interface DeskCardSortableCandidate {
  name: string;
  class: string;
  candidateNumber?: string;
  room?: string;
  seatNumber?: string;
}

export const ICM_SCHOOL_CLASSES_26_27: string[] = [
  'X IPA 1',
  'X IPA 2',
  'X IPA 3',
  'X IPS 1',
  'X IPS 2',
  'XI IPA 1',
  'XI IPA 2',
  'XI IPS 1',
  'XI IPS 2',
  'XII IPA 1',
  'XII IPA 2',
  'XII IPS 1',
  'XII IPS 2',
];

/**
 * Verified 1st Semester A.Y. 2026/2027 Timetable for SMA Insan Cendekia Madani.
 * Note: Practical Exam dates (23–26 Nov 2026) target Grade 10 IPA ("X IPA") only.
 */
export const ICM_SEMESTER1_2026_2027_SCHEDULE: ExamScheduleEntry[] = [
  {
    id: 'icm-2627-prac-phy',
    date: 'Mon, 23 Nov 2026',
    time: '07.30 / 09.00 / 10.30',
    subject: 'Practical: Physics',
    duration: "60'",
    targetClass: 'X IPA',
    category: 'practical',
  },
  {
    id: 'icm-2627-prac-che',
    date: 'Tue, 24 Nov 2026',
    time: '07.30 / 09.00 / 10.30',
    subject: 'Practical: Chemistry',
    duration: "60'",
    targetClass: 'X IPA',
    category: 'practical',
  },
  {
    id: 'icm-2627-prac-bio',
    date: 'Thu, 26 Nov 2026',
    time: '07.30 / 09.00 / 10.30',
    subject: 'Practical: Biology',
    duration: "60'",
    targetClass: 'X IPA',
    category: 'practical',
  },
  {
    id: 'icm-2627-writ-math',
    date: 'Mon, 30 Nov 2026',
    time: '07.30 - 09.30',
    subject: 'Mathematics',
    duration: "120'",
    targetClass: 'ALL',
    category: 'written',
  },
  {
    id: 'icm-2627-writ-arab',
    date: 'Mon, 30 Nov 2026',
    time: '10.00 - 11.30',
    subject: 'Arabic',
    duration: "90'",
    targetClass: 'ALL',
    category: 'written',
  },
  {
    id: 'icm-2627-writ-che',
    date: 'Tue, 1 Dec 2026',
    time: '07.30 - 09.30',
    subject: 'Chemistry',
    duration: "120'",
    targetClass: 'IPA',
    category: 'written',
  },
  {
    id: 'icm-2627-writ-soc',
    date: 'Tue, 1 Dec 2026',
    time: '07.30 - 09.30',
    subject: 'Sociology',
    duration: "120'",
    targetClass: 'IPS',
    category: 'written',
  },
  {
    id: 'icm-2627-writ-eng',
    date: 'Tue, 1 Dec 2026',
    time: '10.00 - 12.00',
    subject: 'English',
    duration: "120'",
    targetClass: 'ALL',
    category: 'written',
  },
  {
    id: 'icm-2627-writ-bio',
    date: 'Wed, 2 Dec 2026',
    time: '07.30 - 09.30',
    subject: 'Biology',
    duration: "120'",
    targetClass: 'IPA',
    category: 'written',
  },
  {
    id: 'icm-2627-writ-geo',
    date: 'Wed, 2 Dec 2026',
    time: '07.30 - 09.30',
    subject: 'Geography',
    duration: "120'",
    targetClass: 'IPS',
    category: 'written',
  },
  {
    id: 'icm-2627-writ-pkn',
    date: 'Wed, 2 Dec 2026',
    time: '10.00 - 11.30',
    subject: 'Civics (PKN)',
    duration: "90'",
    targetClass: 'ALL',
    category: 'written',
  },
  {
    id: 'icm-2627-writ-phy',
    date: 'Thu, 3 Dec 2026',
    time: '07.30 - 09.30',
    subject: 'Physics',
    duration: "120'",
    targetClass: 'IPA',
    category: 'written',
  },
  {
    id: 'icm-2627-writ-eco',
    date: 'Thu, 3 Dec 2026',
    time: '07.30 - 09.30',
    subject: 'Economics',
    duration: "120'",
    targetClass: 'IPS',
    category: 'written',
  },
  {
    id: 'icm-2627-writ-ind',
    date: 'Thu, 3 Dec 2026',
    time: '10.00 - 12.00',
    subject: 'Bahasa Indonesia',
    duration: "120'",
    targetClass: 'ALL',
    category: 'written',
  },
  {
    id: 'icm-2627-writ-pai',
    date: 'Fri, 4 Dec 2026',
    time: '07.30 - 09.00',
    subject: 'PAI',
    duration: "90'",
    targetClass: 'ALL',
    category: 'written',
  },
  {
    id: 'icm-2627-writ-lis10',
    date: 'Fri, 4 Dec 2026',
    time: '09.30 - 10.20',
    subject: 'English Listening G.10',
    duration: "50'",
    targetClass: 'X',
    category: 'written',
  },
];

/**
 * Normalizes class spacing and common ICM variants (e.g. "X IPA3" -> "X IPA 3",
 * "x  ips 2" -> "X IPS 2"). Preserves non-ICM labels like "10-A" cleanly trimmed.
 */
export function normalizeClassLabel(rawClass: string): string {
  const collapsed = String(rawClass || '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!collapsed) return '';

  const icmMatch = collapsed.match(/^(X|XI|XII|10|11|12)\s*[- ]?\s*(IPA|IPS)\s*[- ]?\s*(\d+)$/i);
  if (icmMatch) {
    const rawGrade = icmMatch[1].toUpperCase();
    const romanGrade =
      rawGrade === '10' ? 'X' : rawGrade === '11' ? 'XI' : rawGrade === '12' ? 'XII' : rawGrade;
    const stream = icmMatch[2].toUpperCase();
    const num = String(parseInt(icmMatch[3], 10));
    return `${romanGrade} ${stream} ${num}`;
  }

  return collapsed;
}

/**
 * Normalizes and cleans exam room headers into consistent labels with gender tag
 * where present, e.g. "RUANG 1 - AKHWAT (Total: 16 Siswa)" -> "Room 1 - Akhwat".
 */
export function formatRoomWithGender(rawRoom: string): string {
  const trimmed = String(rawRoom || '')
    .replace(/\([^)]*total[^)]*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!trimmed) return '';

  const roomGenderMatch = trimmed.match(/^(?:ruang|room)\s*[:.-]?\s*(\d+)\s*(?:[-–]\s*(akhwat|ikhwan))?$/i);
  if (roomGenderMatch) {
    const num = parseInt(roomGenderMatch[1], 10);
    const genderRaw = roomGenderMatch[2];
    if (genderRaw) {
      const genderTitle = genderRaw.charAt(0).toUpperCase() + genderRaw.slice(1).toLowerCase();
      return `Room ${num} - ${genderTitle}`;
    }
    return `Room ${num}`;
  }

  if (/^\d+$/.test(trimmed)) {
    return `Room ${parseInt(trimmed, 10)}`;
  }

  return trimmed
    .replace(/^ruang\b/i, 'Room')
    .replace(/\bakhwat\b/gi, 'Akhwat')
    .replace(/\bikhwan\b/gi, 'Ikhwan');
}

function getGradeRank(cls: string): number {
  const norm = normalizeClassLabel(cls).toUpperCase();
  if (/^X\b/.test(norm) || /^10\b/.test(norm)) return 10;
  if (/^XI\b/.test(norm) || /^11\b/.test(norm)) return 11;
  if (/^XII\b/.test(norm) || /^12\b/.test(norm)) return 12;
  const numMatch = norm.match(/\d+/);
  return numMatch ? parseInt(numMatch[0], 10) : 999;
}

/**
 * Sorts school class names naturally (Grade X -> XI -> XII, IPA before IPS, numeric suffix).
 */
export function sortClassNames(classes: string[]): string[] {
  return [...classes].sort((a, b) => {
    const ra = getGradeRank(a);
    const rb = getGradeRank(b);
    if (ra !== rb) return ra - rb;
    return normalizeClassLabel(a).localeCompare(normalizeClassLabel(b), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

function extractClassGradeToken(normalizedUpperClass: string): 'X' | 'XI' | 'XII' | null {
  if (/^(XII|12)(?:\b|\s|-|_)/.test(normalizedUpperClass)) return 'XII';
  if (/^(XI|11)(?:\b|\s|-|_)/.test(normalizedUpperClass)) return 'XI';
  if (/^(X|10)(?:\b|\s|-|_)/.test(normalizedUpperClass)) return 'X';
  const yearMatch = normalizedUpperClass.match(/^YEAR\s*(10|11|12)\b/);
  if (yearMatch) {
    return yearMatch[1] === '10' ? 'X' : yearMatch[1] === '11' ? 'XI' : 'XII';
  }
  return null;
}

function extractTargetGradeToken(tokenUpper: string): 'X' | 'XI' | 'XII' | null {
  if (/^(XII|12|G\.?\s*12|GRADE\s*12)(?:\b|\s|-)/.test(tokenUpper)) return 'XII';
  if (/^(XI|11|G\.?\s*11|GRADE\s*11)(?:\b|\s|-)/.test(tokenUpper)) return 'XI';
  if (/^(X|10|G\.?\s*10|GRADE\s*10)(?:\b|\s|-)/.test(tokenUpper)) return 'X';
  return null;
}

function matchesSingleTargetToken(tokenRaw: string, studentClassRaw: string): boolean {
  const tokenClean = normalizeClassLabel(tokenRaw).toUpperCase();
  const classClean = normalizeClassLabel(studentClassRaw).toUpperCase();

  if (!tokenClean || tokenClean === 'ALL' || tokenClean === '*' || tokenClean === 'EVERYONE') {
    return true;
  }
  if (!classClean) return false;

  // Exact match (handles "X IPA 1", "10-A", "IB-1 CHEMISTRY HL")
  if (tokenClean === classClean) return true;

  // Wildcard prefix e.g. "X IPA *" or "10-*"
  if (tokenClean.endsWith('*')) {
    const prefix = tokenClean.slice(0, -1).trim();
    return prefix.length > 0 && classClean.startsWith(prefix);
  }

  const classGrade = extractClassGradeToken(classClean);
  const classStream = /\bIPA\b/.test(classClean) ? 'IPA' : /\bIPS\b/.test(classClean) ? 'IPS' : null;

  // Compound grade + stream e.g. "X IPA", "10 IPA", "XI IPS"
  const gradeStreamMatch = tokenClean.match(/^(XII|XI|X|12|11|10)\s+(IPA|IPS)$/);
  if (gradeStreamMatch) {
    const targetGrade = extractTargetGradeToken(gradeStreamMatch[1]);
    const targetStream = gradeStreamMatch[2];
    return classGrade === targetGrade && classStream === targetStream;
  }

  // Stream only e.g. "IPA" or "IPS"
  if (tokenClean === 'IPA' || tokenClean === 'IPS') {
    return classStream === tokenClean;
  }

  // Grade only e.g. "X", "10", "G.10", "Grade 10", "XI", "XII"
  if (/^(XII|XI|X|12|11|10|G\.?\s*(?:10|11|12)|GRADE\s*(?:10|11|12))$/.test(tokenClean)) {
    const targetGrade = extractTargetGradeToken(tokenClean);
    return classGrade !== null && classGrade === targetGrade;
  }

  return false;
}

/**
 * Checks whether a given exam schedule row applies to a candidate's class.
 * Supports comma-separated targets (e.g. "X IPA 1, X IPA 2") as well as
 * "ALL", grade ("X", "10"), stream ("IPA", "IPS"), and grade+stream ("X IPA").
 */
export function doesScheduleEntryMatchClass(entry: ExamScheduleEntry, studentClass: string): boolean {
  const rawTarget = String(entry.targetClass || 'ALL').trim();
  if (!rawTarget || rawTarget.toUpperCase() === 'ALL') return true;

  const tokens = rawTarget
    .split(/[,;|/]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length === 0) return true;
  return tokens.some((token) => matchesSingleTargetToken(token, studentClass));
}

export function filterScheduleForClass(
  entries: ExamScheduleEntry[],
  studentClass: string
): ExamScheduleEntry[] {
  return entries.filter((entry) => doesScheduleEntryMatchClass(entry, studentClass));
}

/**
 * Extracts a numeric key for sorting rooms ("Room 2 - Akhwat" -> 2, unassigned -> MAX_SAFE_INTEGER).
 */
function roomSortKey(room?: string): { num: number; text: string } {
  const clean = String(room || '').trim();
  if (!clean) return { num: Number.MAX_SAFE_INTEGER, text: '' };
  const m = clean.match(/\d+/);
  return {
    num: m ? parseInt(m[0], 10) : Number.MAX_SAFE_INTEGER - 1,
    text: clean,
  };
}

function seatSortKey(seat?: string): { num: number; text: string } {
  const clean = String(seat || '').trim();
  if (!clean) return { num: Number.MAX_SAFE_INTEGER, text: '' };
  const m = clean.match(/\d+/);
  return {
    num: m ? parseInt(m[0], 10) : Number.MAX_SAFE_INTEGER - 1,
    text: clean,
  };
}

export type DeskCardSortMode = 'room_seat' | 'class_seat';

/**
 * Sorts candidates cleanly for physical desk distribution or homeroom hand-off.
 * Defaults to natural numeric ordering for Room # and Seat # so Room 2 precedes Room 10.
 */
export function sortStudentsForDeskCards<T extends DeskCardSortableCandidate>(
  students: T[],
  mode: DeskCardSortMode = 'room_seat'
): T[] {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...students].sort((a, b) => {
    if (mode === 'room_seat') {
      const ra = roomSortKey(a.room);
      const rb = roomSortKey(b.room);
      if (ra.num !== rb.num) return ra.num - rb.num;
      const roomTextCmp = collator.compare(ra.text, rb.text);
      if (roomTextCmp !== 0) return roomTextCmp;

      const sa = seatSortKey(a.seatNumber);
      const sb = seatSortKey(b.seatNumber);
      if (sa.num !== sb.num) return sa.num - sb.num;
      const seatTextCmp = collator.compare(sa.text, sb.text);
      if (seatTextCmp !== 0) return seatTextCmp;
    }

    // Class order (X -> XI -> XII, IPA -> IPS, section 1..3)
    const ga = getGradeRank(a.class);
    const gb = getGradeRank(b.class);
    if (ga !== gb) return ga - gb;
    const clsCmp = collator.compare(normalizeClassLabel(a.class), normalizeClassLabel(b.class));
    if (clsCmp !== 0) return clsCmp;

    // Candidate # or Seat # tie-breaker
    const ca = String(a.candidateNumber || a.seatNumber || '').trim();
    const cb = String(b.candidateNumber || b.seatNumber || '').trim();
    if (ca !== cb) {
      if (!ca) return 1;
      if (!cb) return -1;
      const candCmp = collator.compare(ca, cb);
      if (candCmp !== 0) return candCmp;
    }

    return collator.compare(a.name || '', b.name || '');
  });
}

export function normalizeExamScheduleEntries(raw: unknown): ExamScheduleEntry[] {
  if (!Array.isArray(raw)) return [];
  const results: ExamScheduleEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const date = String(obj.date || '').trim();
    const time = String(obj.time || '').trim();
    const subject = String(obj.subject || '').trim();
    if (!subject && !date) continue;

    const categoryRaw = String(obj.category || '').toLowerCase();
    const category: ExamScheduleCategory =
      categoryRaw === 'practical' || /^practical\s*:/i.test(subject)
        ? 'practical'
        : categoryRaw === 'other'
          ? 'other'
          : 'written';

    results.push({
      id: String(obj.id || `sched-${i + 1}-${Date.now()}`).trim(),
      date,
      time,
      subject,
      duration: obj.duration ? String(obj.duration).trim() : '',
      targetClass: normalizeClassLabel(String(obj.targetClass || 'ALL')) || 'ALL',
      category,
    });
  }
  return results;
}

export function validateExamScheduleEntries(entries: ExamScheduleEntry[]): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  entries.forEach((entry, idx) => {
    const label = `Session #${idx + 1}`;
    if (!entry.date.trim()) errors.push(`${label} is missing Day & Date.`);
    if (!entry.time.trim()) errors.push(`${label} is missing Time.`);
    if (!entry.subject.trim()) errors.push(`${label} is missing Subject.`);
  });
  return { ok: errors.length === 0, errors };
}
