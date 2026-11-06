/**
 * Deterministic subject / syllabus recognition (pure — no pdfjs, no DOM).
 *
 * The upload UI asks the teacher to pick STEM / Humanities / Languages, and the
 * extraction prompt used to assume "Humanities" meant Geography 0460. Sociology
 * 0495 therefore arrived with geography examples, a Geography metadata default,
 * and no rules for its in-paper "Source A" stimulus or 8–14 mark level grids.
 *
 * This module answers one question from the printed cover: which syllabus is this?
 * Only values measured against a real paper are asserted — an unknown syllabus must
 * degrade to a neutral profile, never to a confident wrong one (see Plan/humanities.md).
 */

export type SubjectDomainName = 'stem' | 'humanities' | 'languages';

export interface SubjectProfile {
  syllabusCode: string;
  subjectName: string;
  domain: SubjectDomainName;
  /** Paper ships a separate insert / resource booklet. Advisory. */
  hasInsertByDefault: boolean;
  /** Paper prints its stimulus (e.g. Sociology "Source A") inside the question paper. */
  hasInPaperStimulus: boolean;
  /** Candidate answers a subset, so printed question marks exceed the paper total. */
  isOptionalChoicePaper: boolean;
  /** Printed paper total. Only set where verified against a real paper. */
  standardTotalMarks?: number;
}

/**
 * Cambridge IGCSE syllabi seen by this app. Flags are advisory hints, not hard
 * rules; anything not measured on a real paper is left conservative (false).
 */
export const SYLLABUS_REGISTRY: Record<string, SubjectProfile> = {
  '0495': {
    syllabusCode: '0495',
    subjectName: 'Sociology',
    domain: 'humanities',
    hasInsertByDefault: false,
    hasInPaperStimulus: true,
    isOptionalChoicePaper: true,
    // Measured on 0495_s25_qp_11: "The total mark for this paper is 80" while the
    // paper prints Q1+Q2+Q3 = 120, because candidates answer Q1 and either Q2 or Q3.
    standardTotalMarks: 80,
  },
  '9696': {
    syllabusCode: '9696',
    subjectName: 'Geography (AS/A Level)',
    domain: 'humanities',
    hasInsertByDefault: true,
    hasInPaperStimulus: false,
    isOptionalChoicePaper: true,
    // Measured on 9696/11: "The total mark for this paper is 60" while 6 questions print
    // 120 marks, because Section A is compulsory and Section B requires one of three.
    standardTotalMarks: 60,
  },
  '0460': {
    syllabusCode: '0460',
    subjectName: 'Geography',
    domain: 'humanities',
    hasInsertByDefault: true,
    hasInPaperStimulus: false,
    isOptionalChoicePaper: true,
    // Paper 1 total mark is 75 (answers 3 of 6, each 25 marks); Paper 2 total mark is 60 (all compulsory).
    standardTotalMarks: 75,
  },
  '0470': {
    syllabusCode: '0470',
    subjectName: 'History',
    domain: 'humanities',
    hasInsertByDefault: false,
    hasInPaperStimulus: true,
    isOptionalChoicePaper: true,
  },
  '0455': {
    syllabusCode: '0455',
    subjectName: 'Economics',
    domain: 'humanities',
    hasInsertByDefault: false,
    hasInPaperStimulus: true,
    isOptionalChoicePaper: true,
  },
  '0620': { syllabusCode: '0620', subjectName: 'Chemistry', domain: 'stem', hasInsertByDefault: false, hasInPaperStimulus: false, isOptionalChoicePaper: false },
  '0625': { syllabusCode: '0625', subjectName: 'Physics', domain: 'stem', hasInsertByDefault: false, hasInPaperStimulus: false, isOptionalChoicePaper: false },
  '0610': { syllabusCode: '0610', subjectName: 'Biology', domain: 'stem', hasInsertByDefault: false, hasInPaperStimulus: false, isOptionalChoicePaper: false },
};

/** Neutral profile for a humanities paper whose syllabus could not be identified. */
export const NEUTRAL_HUMANITIES_PROFILE: SubjectProfile = {
  syllabusCode: 'HUM',
  subjectName: 'Humanities',
  domain: 'humanities',
  hasInsertByDefault: false,
  hasInPaperStimulus: false,
  isOptionalChoicePaper: false,
};

export interface SubjectMatch {
  profile: SubjectProfile;
  syllabusCode: string;
  /** Paper code as printed, e.g. "11" of 0495/11. Empty when the cover omitted it. */
  paperCode: string;
  /** "code" when a 4-digit syllabus code was matched; "title" by subject name only. */
  method: 'code' | 'title';
  /** The matched text, for logging and UI display. */
  evidence: string;
}

const CODE_IN_TEXT_RE = /(?:^|[^0-9])(\d{4})\s*\/\s*(\d{1,2})(?![0-9])/;
const CODE_IN_NAME_RE = /(\d{4})[^\n\r]{0,60}?(?:_|\s|paper\s*|p)(\d{2})(?:\D|$)/i;

/**
 * Identifies the syllabus from the first pages of a question paper (or its filename).
 * Returns null when nothing matches — callers must treat that as "unknown", not as a default.
 */
export function classifySubject(pageTexts: string[], hint?: { fileName?: string }): SubjectMatch | null {
  const haystack = [hint?.fileName ?? '', ...pageTexts.slice(0, 2)].join(' ').replace(/\s+/g, ' ');

  const fromText = haystack.match(CODE_IN_TEXT_RE);
  const fromName = (hint?.fileName ?? '').match(CODE_IN_NAME_RE);
  const syllabusCode = fromText?.[1] ?? fromName?.[1] ?? '';
  const paperCode = fromText?.[2] ?? fromName?.[2] ?? '';

  if (syllabusCode && SYLLABUS_REGISTRY[syllabusCode]) {
    return {
      profile: SYLLABUS_REGISTRY[syllabusCode],
      syllabusCode,
      paperCode,
      method: 'code',
      evidence: syllabusCode,
    };
  }

  // No usable code: fall back to the subject name printed on the cover.
  const upper = haystack.toUpperCase();
  for (const profile of Object.values(SYLLABUS_REGISTRY)) {
    if (upper.includes(profile.subjectName.toUpperCase())) {
      return {
        profile,
        syllabusCode: profile.syllabusCode,
        paperCode,
        method: 'title',
        evidence: profile.subjectName,
      };
    }
  }

  return null;
}

/** Registry lookup for a syllabus code already known from another reader (e.g. the outline). */
export function subjectForSyllabus(syllabusCode: string | undefined | null): SubjectProfile | null {
  if (!syllabusCode) return null;
  return SYLLABUS_REGISTRY[syllabusCode] ?? null;
}

/** The profile a humanities paper should be extracted with when detection failed. */
export function humanitiesProfileFor(match: SubjectMatch | null | undefined): SubjectProfile {
  return match?.profile ?? NEUTRAL_HUMANITIES_PROFILE;
}
