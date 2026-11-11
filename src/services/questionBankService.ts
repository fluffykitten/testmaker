import { supabase } from '../lib/supabase';
import type { Question, Syllabus, QuestionDifficulty, QuestionStyle, CognitiveLevel } from '../types/database';
import { getBookmarkedQuestionIds } from './questionBookmarkService';
import { getAllQuestionTagsMap } from './questionTagService';
import { expandFormulaSearch } from '../lib/formulaSearch';
import { extractSvgFromDiagramUrl } from '../lib/gemini';

export interface QuestionFilterParams {
  searchQuery?: string;
  syllabusId?: string;
  topic?: string;
  subTopic?: string;
  difficulty?: QuestionDifficulty;
  paperNumber?: number | 'mcq' | 'theory' | 'atp'; // helper presets
  paperType?: string; // e.g. 'mcq' | 'theory' | 'atp' | 'paper:1' | 'series:Try Out TKA 1' | 'Try Out TKA 1'
  year?: number;
  series?: string;
  minMarks?: number;
  maxMarks?: number;
  questionStyle?: QuestionStyle;
  hasAudio?: boolean;
  bookmarkedOnly?: boolean;
  customTag?: string;
  cognitiveLevel?: CognitiveLevel | 'all';
  sortBy?: 'created_at' | 'marks_desc' | 'marks_asc' | 'difficulty' | 'year_desc' | 'question_number_asc' | 'question_number_desc';
  page?: number;
  pageSize?: number;
}

export interface PaperTypesSummary {
  seriesOptions: { value: string; label: string; rawName: string; count: number }[];
  paperNumberOptions: { value: string; label: string; paperNumber: string | number; count: number }[];
}

export interface QuestionQueryResult {
  questions: Question[];
  totalCount: number;
  page: number;
  totalPages: number;
}

// ─── High-Performance In-Memory & Persistent Query Caches ───────────────────
const SYLLABUSES_STORAGE_KEY = 'testmaker_qb_syllabuses_v1';
const FACETS_STORAGE_KEY_PREFIX = 'testmaker_qb_facets_v1_';

let syllabusesCache: { data: Syllabus[]; timestamp: number } | null = null;
const topicsCache = new Map<string, { data: { topic: string; subTopics: string[] }[]; timestamp: number }>();
const paperTypesCache = new Map<string, { data: PaperTypesSummary; timestamp: number }>();
const questionsQueryCache = new Map<string, { data: QuestionQueryResult; timestamp: number }>();

// In-flight promise deduplication to prevent redundant concurrent queries
let inFlightSyllabuses: Promise<Syllabus[]> | null = null;
const inFlightFacets = new Map<
  string,
  Promise<{ topics: { topic: string; subTopics: string[] }[]; paperTypes: PaperTypesSummary }>
>();
const inFlightQuestions = new Map<string, Promise<QuestionQueryResult>>();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes TTL
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const filterValidUuids = (ids: string[]): string[] => ids.filter((id) => UUID_REGEX.test(id));
const quotePostgrestIlikePattern = (rawToken: string): string => {
  const escaped = rawToken.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"%${escaped}%"`;
};
let prefetchTimeoutId: ReturnType<typeof setTimeout> | null = null;

// Hydrate syllabuses cache synchronously from localStorage if available
if (typeof window !== 'undefined') {
  try {
    const rawSyl = localStorage.getItem(SYLLABUSES_STORAGE_KEY);
    if (rawSyl) {
      const parsed = JSON.parse(rawSyl);
      if (parsed && Array.isArray(parsed.data)) {
        syllabusesCache = parsed;
      }
    }
  } catch {}
}

/**
 * Synchronously returns cached syllabuses if available (prevents mount waterfalls)
 */
export function getCachedSyllabuses(): Syllabus[] {
  return syllabusesCache ? syllabusesCache.data : [];
}

/**
 * Synchronously returns cached topics for a syllabus if available
 */
export function getCachedTopics(syllabusId?: string): { topic: string; subTopics: string[] }[] {
  const cacheKey = syllabusId || '__all__';
  const mem = topicsCache.get(cacheKey);
  if (mem) return mem.data;
  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(FACETS_STORAGE_KEY_PREFIX + cacheKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.topics) {
          topicsCache.set(cacheKey, { data: parsed.topics, timestamp: parsed.timestamp || 0 });
          if (parsed?.paperTypes) {
            paperTypesCache.set(cacheKey, { data: parsed.paperTypes, timestamp: parsed.timestamp || 0 });
          }
          return parsed.topics;
        }
      }
    } catch {}
  }
  return [];
}

/**
 * Synchronously returns cached paper types for a syllabus if available
 */
export function getCachedPaperTypes(syllabusId?: string): PaperTypesSummary {
  const cacheKey = syllabusId || '__all__';
  const mem = paperTypesCache.get(cacheKey);
  if (mem) return mem.data;
  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(FACETS_STORAGE_KEY_PREFIX + cacheKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.paperTypes) {
          paperTypesCache.set(cacheKey, { data: parsed.paperTypes, timestamp: parsed.timestamp || 0 });
          if (parsed?.topics) {
            topicsCache.set(cacheKey, { data: parsed.topics, timestamp: parsed.timestamp || 0 });
          }
          return parsed.paperTypes;
        }
      }
    } catch {}
  }
  return { seriesOptions: [], paperNumberOptions: [] };
}

export function clearQuestionBankCache(options: { preservePastPapersSummary?: boolean } = {}): void {
  syllabusesCache = null;
  topicsCache.clear();
  paperTypesCache.clear();
  questionsQueryCache.clear();
  if (!options.preservePastPapersSummary) {
    pastPapersSummaryCache = {};
    inFlightPastPapersSummary = {};
  }
  inFlightSyllabuses = null;
  inFlightFacets.clear();
  inFlightQuestions.clear();
  if (typeof window !== 'undefined') {
    try {
      localStorage.removeItem(SYLLABUSES_STORAGE_KEY);
      Object.keys(localStorage).forEach((k) => {
        if (k.startsWith(FACETS_STORAGE_KEY_PREFIX)) {
          localStorage.removeItem(k);
        }
      });
    } catch {}
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('questions_updated', () => clearQuestionBankCache({ preservePastPapersSummary: true }));
  window.addEventListener('tags_updated', () => clearQuestionBankCache({ preservePastPapersSummary: true }));
  window.addEventListener('bookmarks_updated', () => clearQuestionBankCache({ preservePastPapersSummary: true }));
}

/**
 * Fetches all available syllabuses/subjects (cached in memory & localStorage with SWR deduplication)
 */
export async function fetchSyllabuses(): Promise<Syllabus[]> {
  if (syllabusesCache && Date.now() - syllabusesCache.timestamp < CACHE_TTL_MS) {
    return syllabusesCache.data;
  }
  if (inFlightSyllabuses) {
    return inFlightSyllabuses;
  }

  const refreshPromise = (async () => {
    try {
      const { data, error } = await supabase
        .from('syllabuses')
        .select('*')
        .order('subject_name', { ascending: true });

      if (error) {
        console.error('Failed to fetch syllabuses:', error);
        return syllabusesCache ? syllabusesCache.data : [];
      }

      const result = data as Syllabus[];
      const entry = { data: result, timestamp: Date.now() };
      syllabusesCache = entry;
      if (typeof window !== 'undefined') {
        try {
          localStorage.setItem(SYLLABUSES_STORAGE_KEY, JSON.stringify(entry));
        } catch {}
      }
      return result;
    } finally {
      inFlightSyllabuses = null;
    }
  })();

  inFlightSyllabuses = refreshPromise;

  // Stale-while-revalidate: if we already have cached syllabuses, return immediately while refreshing
  if (syllabusesCache && syllabusesCache.data.length > 0) {
    return syllabusesCache.data;
  }

  return refreshPromise;
}

/**
 * Creates (or reuses an existing) subject/syllabus in Supabase and updates caches immediately.
 */
export async function createOrGetSyllabus(
  subjectName: string,
  subjectCode?: string
): Promise<Syllabus> {
  const cleanName = subjectName.trim();
  if (!cleanName) {
    throw new Error('Subject name is required');
  }

  const derivedCode = (
    subjectCode?.trim() ||
    cleanName
      .replace(/[^a-zA-Z0-9\s]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.slice(0, 4))
      .join('-')
      .toUpperCase() ||
    'SUBJ'
  ).slice(0, 20);

  const existingList = await fetchSyllabuses();
  const matched = existingList.find(
    (s) =>
      s.subject_name.trim().toLowerCase() === cleanName.toLowerCase() ||
      (subjectCode?.trim() && s.subject_code.trim().toLowerCase() === derivedCode.toLowerCase())
  );
  if (matched) {
    return matched;
  }

  const { data: created, error } = await (supabase.from('syllabuses' as any) as any)
    .insert({ subject_name: cleanName, subject_code: derivedCode })
    .select('*')
    .single();

  if (error || !created) {
    throw new Error(error?.message || 'Failed to create subject syllabus');
  }

  const createdSyllabus = created as Syllabus;
  const updatedList = [...existingList, createdSyllabus].sort((a, b) =>
    a.subject_name.localeCompare(b.subject_name)
  );
  const entry = { data: updatedList, timestamp: Date.now() };
  syllabusesCache = entry;

  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(SYLLABUSES_STORAGE_KEY, JSON.stringify(entry));
    } catch {}
    window.dispatchEvent(new CustomEvent('syllabuses_updated', { detail: { syllabuses: updatedList } }));
  }

  return createdSyllabus;
}

/**
 * Helper to infer a rich topic from question text, sub-topic or domain keywords
 */
export function inferTopicFromContent(text?: string, subTopic?: string): string {
  if (subTopic && subTopic.trim() && subTopic.trim().toLowerCase() !== 'general') {
    return subTopic.trim();
  }
  if (!text) return 'General';
  const lower = text.toLowerCase();

  // Arabic Language & Islamic Studies
  if (/نحو|فاعل|مفعول|مبتدأ|خبر|إعراب|اعراب|فعل|اسم|حرف/u.test(text)) return 'النحو والصرف (Arabic Grammar)';
  if (/قراءة|نص|فقرة|فهم المقروء|استيعاب/u.test(text)) return 'فهم المقروء (Reading Comprehension)';
  if (/بلاغة|تشبيه|استعارة|كناية|محسنات/u.test(text)) return 'البلاغة والأدب (Rhetoric & Literature)';
  if (/مفردات|معنى|مرادف|ضد|معجم/u.test(text)) return 'المفردات والدلالة (Vocabulary)';
  if (/قرآن|تفسير|حديث|فقه|عقيدة|توحيد|سيرة/u.test(text)) return 'الدراسات الإسلامية (Islamic Studies)';

  // English & Languages
  if (/reading|comprehension|passage|text\s*\d|komodo|article|paragraph/i.test(lower)) return 'Reading Comprehension';
  if (/listen|dialogue|speaker|conversation|audio|recording|transcript/i.test(lower)) return 'Listening Comprehension';
  if (/grammar|tense|verb|noun|adjective|preposition|pronoun|sentence/i.test(lower)) return 'Grammar & Usage';
  if (/vocabulary|word|synonym|antonym|definition|lexis/i.test(lower)) return 'Vocabulary & Word Choice';
  if (/cloze|fill in|blank|complete/i.test(lower)) return 'Language Completion';

  // Chemistry
  if (/acid|base|salt|ph|alkali|neutral/i.test(lower)) return 'Acids, Bases & Salts';
  if (/atom|electron|proton|neutron|isotope|nuclide/i.test(lower)) return 'Atomic Structure';
  if (/mole|stoich|concentration|avogadro|equation|titrat/i.test(lower)) return 'Stoichiometry & Mole Concept';
  if (/organic|alkane|alkene|alcohol|polymer|ester|hydrocarbon/i.test(lower)) return 'Organic Chemistry';
  if (/periodic|halogen|noble gas|transition|metal/i.test(lower)) return 'Periodic Table & Trends';
  if (/redox|oxidation|reduction|electrolysis/i.test(lower)) return 'Electrochemistry & Redox';
  if (/rate|catalyst|equilibrium|le chatelier/i.test(lower)) return 'Reaction Rates & Equilibrium';

  // Biology
  if (/cell|membrane|organelle|nucleus|cytoplasm|mitochondria/i.test(lower)) return 'Cell Biology';
  if (/photosynthesis|chlorophyll|light reaction/i.test(lower)) return 'Plant Nutrition & Photosynthesis';
  if (/enzyme|catalyst|denature|active site/i.test(lower)) return 'Enzymes & Biological Reactions';
  if (/genetics|dna|gene|chromosome|inheritance/i.test(lower)) return 'Genetics & Inheritance';
  if (/ecology|ecosystem|food web|trophic/i.test(lower)) return 'Ecology & Environment';

  // Physics
  if (/force|mass|acceleration|newton|gravity|friction/i.test(lower)) return 'Forces & Dynamics';
  if (/energy|work|power|kinetic|potential/i.test(lower)) return 'Work, Energy & Power';
  if (/wave|frequency|wavelength|sound|light|refraction|lens/i.test(lower)) return 'Waves & Optics';
  if (/electric|circuit|current|voltage|resistance|ohm/i.test(lower)) return 'Electricity & Magnetism';
  if (/thermal|heat|temperature|conduction|convection/i.test(lower)) return 'Thermal Physics';

  // Geography
  if (/population|migration|urban|settlement|birth rate|death rate/i.test(lower)) return 'Population & Settlement';
  if (/volcano|earthquake|plate tectonic|crust/i.test(lower)) return 'Earthquakes & Volcanoes';
  if (/river|coast|wave|erosion|deposition|delta/i.test(lower)) return 'Rivers & Coasts';
  if (/weather|climate|rain|monsoon|temperature/i.test(lower)) return 'Weather & Climate';

  // Mathematics
  if (/algebra|equation|solve|variable|linear|quadratic/i.test(lower)) return 'Algebra & Functions';
  if (/geometry|angle|triangle|circle|polygon|perimeter|area/i.test(lower)) return 'Geometry & Measure';
  if (/probability|statistic|mean|median|mode|histogram/i.test(lower)) return 'Probability & Statistics';

  return 'General';
}

/**
 * Unified lightweight facets fetcher that retrieves BOTH topics and paperTypes in a single query
 * and persists aggregated facets in localStorage for instant Stale-While-Revalidate loading.
 */
async function fetchQuestionFacets(
  syllabusId?: string
): Promise<{ topics: { topic: string; subTopics: string[] }[]; paperTypes: PaperTypesSummary }> {
  const cacheKey = syllabusId || '__all__';
  const now = Date.now();
  const cachedTopics = topicsCache.get(cacheKey);
  const cachedPapers = paperTypesCache.get(cacheKey);

  if (
    cachedTopics &&
    cachedPapers &&
    now - cachedTopics.timestamp < CACHE_TTL_MS &&
    now - cachedPapers.timestamp < CACHE_TTL_MS
  ) {
    return { topics: cachedTopics.data, paperTypes: cachedPapers.data };
  }

  // Hydrate from localStorage if memory cache is empty
  if (!cachedTopics || !cachedPapers) {
    getCachedTopics(syllabusId);
    getCachedPaperTypes(syllabusId);
  }

  const inFlight = inFlightFacets.get(cacheKey);
  if (inFlight) {
    const memT = topicsCache.get(cacheKey);
    const memP = paperTypesCache.get(cacheKey);
    if (memT && memP && memT.data.length > 0) {
      return { topics: memT.data, paperTypes: memP.data };
    }
    return inFlight;
  }

  const refreshPromise = (async () => {
    try {
      let query = supabase
        .from('questions')
        .select('topic, sub_topic, series, paper_number, syllabus_id')
        .range(0, 2999);

      if (syllabusId) {
        query = query.eq('syllabus_id', syllabusId);
      }

      let { data, error } = await query;

      // Fallback: If syllabusId filter yielded no results, fetch across all syllabuses
      if ((!data || data.length === 0) && syllabusId) {
        const fallbackRes = await supabase
          .from('questions')
          .select('topic, sub_topic, series, paper_number, syllabus_id')
          .range(0, 2999);
        if (fallbackRes.data && fallbackRes.data.length > 0) {
          data = fallbackRes.data;
        }
      }

      if (error || !data) {
        console.error('Failed to fetch question facets:', error);
        return {
          topics: topicsCache.get(cacheKey)?.data || [],
          paperTypes: paperTypesCache.get(cacheKey)?.data || { seriesOptions: [], paperNumberOptions: [] },
        };
      }

      const topicMap = new Map<string, Set<string>>();
      const seriesMap = new Map<string, number>();
      const paperNumMap = new Map<string, number>();

      data.forEach((row: any) => {
        let rawTopic = row.topic?.trim() || '';
        if (!rawTopic || rawTopic.toLowerCase() === 'general') {
          rawTopic = inferTopicFromContent(undefined, row.sub_topic);
        }

        if (rawTopic && rawTopic.trim()) {
          const cleanTopic = rawTopic.trim();
          if (!topicMap.has(cleanTopic)) {
            topicMap.set(cleanTopic, new Set());
          }
          if (row.sub_topic && row.sub_topic.trim() && row.sub_topic.trim().toLowerCase() !== 'general') {
            topicMap.get(cleanTopic)!.add(row.sub_topic.trim());
          }
        }

        if (row.series && typeof row.series === 'string' && row.series.trim()) {
          const s = row.series.trim();
          seriesMap.set(s, (seriesMap.get(s) || 0) + 1);
        }
        if (row.paper_number !== null && row.paper_number !== undefined) {
          const p = String(row.paper_number).trim();
          if (p) {
            paperNumMap.set(p, (paperNumMap.get(p) || 0) + 1);
          }
        }
      });

      const topics = Array.from(topicMap.entries())
        .map(([topic, subTopicsSet]) => ({
          topic,
          subTopics: Array.from(subTopicsSet).sort(),
        }))
        .sort((a, b) => a.topic.localeCompare(b.topic));

      const seriesOptions = Array.from(seriesMap.entries())
        .map(([series, count]) => ({
          value: `series:${series}`,
          label: `${series} (${count})`,
          rawName: series,
          count,
        }))
        .sort((a, b) => b.count - a.count || a.rawName.localeCompare(b.rawName));

      const paperNumberOptions = Array.from(paperNumMap.entries())
        .map(([val, count]) => {
          const isPureDigits = /^\d+$/.test(val);
          return {
            value: `paper:${val}`,
            label: isPureDigits ? `Paper ${val} (${count})` : `${val} (${count})`,
            paperNumber: val,
            count,
          };
        })
        .sort((a, b) => {
          const numA = Number(a.paperNumber);
          const numB = Number(b.paperNumber);
          if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
          return a.label.localeCompare(b.label);
        });

      const paperTypes: PaperTypesSummary = { seriesOptions, paperNumberOptions };
      const ts = Date.now();
      topicsCache.set(cacheKey, { data: topics, timestamp: ts });
      paperTypesCache.set(cacheKey, { data: paperTypes, timestamp: ts });

      if (typeof window !== 'undefined') {
        try {
          localStorage.setItem(
            FACETS_STORAGE_KEY_PREFIX + cacheKey,
            JSON.stringify({ topics, paperTypes, timestamp: ts })
          );
        } catch {}
      }

      return { topics, paperTypes };
    } finally {
      inFlightFacets.delete(cacheKey);
    }
  })();

  inFlightFacets.set(cacheKey, refreshPromise);

  // Stale-while-revalidate: return cached facets immediately if present while refreshing in background
  const staleTopics = topicsCache.get(cacheKey);
  const stalePapers = paperTypesCache.get(cacheKey);
  if (staleTopics && stalePapers && staleTopics.data.length > 0) {
    return { topics: staleTopics.data, paperTypes: stalePapers.data };
  }

  return refreshPromise;
}

/**
 * Fetches distinct topics for a given syllabus (or all syllabuses) with unified facet query
 */
export async function fetchTopics(syllabusId?: string): Promise<{ topic: string; subTopics: string[] }[]> {
  const facets = await fetchQuestionFacets(syllabusId);
  return facets.topics;
}

/**
 * Fetches distinct paper types (exam series and paper numbers) from questions in the database (cached)
 */
export async function fetchPaperTypes(syllabusId?: string): Promise<PaperTypesSummary> {
  const facets = await fetchQuestionFacets(syllabusId);
  return facets.paperTypes;
}

export interface SubjectTopicSummary {
  syllabusId: string | null;
  subjectName: string;
  subjectCode?: string;
  topics: {
    name: string;
    questionCount: number;
    totalMarks: number;
  }[];
}

/**
 * Returns subjects and their exact uploaded topics and question counts from the Question Bank.
 */
export async function fetchUploadedSubjectTopics(): Promise<SubjectTopicSummary[]> {
  const syllabuses = await fetchSyllabuses();
  const syllabusMap = new Map<string, Syllabus>();
  syllabuses.forEach((s) => syllabusMap.set(s.id, s));

  const { data, error } = await supabase
    .from('questions')
    .select('id, syllabus_id, topic, sub_topic, question_text, marks');

  if (error || !data || data.length === 0) {
    return [];
  }

  const subjectGroups = new Map<string, Map<string, { count: number; marks: number }>>();
  const subjectTexts = new Map<string, string>();

  data.forEach((row: any) => {
    const sId = row.syllabus_id || 'general';
    let topic = row.topic?.trim();
    if (!topic || topic.toLowerCase() === 'general') {
      topic = inferTopicFromContent(row.question_text, row.sub_topic);
    }
    const marks = row.marks || 1;

    if (!subjectGroups.has(sId)) {
      subjectGroups.set(sId, new Map());
      subjectTexts.set(sId, '');
    }
    const topicMap = subjectGroups.get(sId)!;
    const current = topicMap.get(topic) || { count: 0, marks: 0 };
    topicMap.set(topic, { count: current.count + 1, marks: current.marks + marks });

    if (row.question_text) {
      subjectTexts.set(sId, (subjectTexts.get(sId) || '') + ' ' + row.question_text.slice(0, 100));
    }
  });

  const result: SubjectTopicSummary[] = [];

  subjectGroups.forEach((topicMap, sId) => {
    const sObj = syllabusMap.get(sId);
    let subjectName = sObj ? sObj.subject_name : '';
    const subjectCode = sObj?.subject_code;

    // If subject is missing or 'general', infer from question text
    if (!subjectName || subjectName.toLowerCase() === 'general' || subjectName === 'Uploaded Past Papers') {
      const sampleText = subjectTexts.get(sId) || '';
      if (/reading|comprehension|passage|grammar|vocabulary|english|ielts|listening/i.test(sampleText)) subjectName = 'English';
      else if (/chem|stoich|acid|base|organic|element/i.test(sampleText)) subjectName = 'Chemistry';
      else if (/geograph|population|tectonic|weather/i.test(sampleText)) subjectName = 'Geography';
      else if (/biology|cell|photosynthesis|enzyme/i.test(sampleText)) subjectName = 'Biology';
      else if (/physics|force|energy|wave|circuit/i.test(sampleText)) subjectName = 'Physics';
      else if (/math|algebra|geometry|calculus/i.test(sampleText)) subjectName = 'Mathematics';
      else subjectName = sObj?.subject_name || 'General';
    }

    const topics = Array.from(topicMap.entries())
      .map(([name, stats]) => ({
        name,
        questionCount: stats.count,
        totalMarks: stats.marks,
      }))
      .sort((a, b) => b.questionCount - a.questionCount);

    result.push({
      syllabusId: sId === 'general' ? null : sId,
      subjectName,
      subjectCode,
      topics,
    });
  });

  return result;
}

/**
 * Compares two question numbers naturally so that 1, 2, 3, ... 9, 10, 11
 * are ordered numerically rather than alphabetically (1, 10, 11, 2, ...).
 * Also handles subparts (e.g. 1(a), 1(b), 2(a)) and question prefixes (e.g. Q1, Q2, Question 10).
 */
export function compareQuestionNumbers(
  a?: string | number | null,
  b?: string | number | null
): number {
  if (a === b) return 0;
  const strA = a !== undefined && a !== null ? String(a).trim() : '';
  const strB = b !== undefined && b !== null ? String(b).trim() : '';
  if (!strA && !strB) return 0;
  if (!strA) return 1;
  if (!strB) return -1;

  // Handle section difficulty prefixes for multi-tier assessments (e.g. Save My Exams / PMA: Easy -> Medium -> Hard)
  const getDifficultyWeight = (str: string): number => {
    const s = str.toLowerCase();
    if (s.startsWith('easy') || s.startsWith('e-') || s.startsWith('e ') || /^e\d+/i.test(s)) return 100;
    if (s.startsWith('medium') || s.startsWith('med') || s.startsWith('m-') || s.startsWith('m ') || /^m\d+/i.test(s)) return 200;
    if (s.startsWith('hard') || s.startsWith('h-') || s.startsWith('h ') || /^h\d+/i.test(s)) return 300;
    return 0;
  };

  const weightA = getDifficultyWeight(strA);
  const weightB = getDifficultyWeight(strB);

  if (weightA > 0 && weightB > 0 && weightA !== weightB) {
    return weightA - weightB;
  }

  if (weightA > 0 && weightB > 0 && weightA === weightB) {
    const cleanA = strA.replace(/^(?:easy|medium|med|hard|[emh])\s*[-:_]?\s*(?:q|question)?\s*/i, '');
    const cleanB = strB.replace(/^(?:easy|medium|med|hard|[emh])\s*[-:_]?\s*(?:q|question)?\s*/i, '');
    return cleanA.localeCompare(cleanB, undefined, { numeric: true, sensitivity: 'base' });
  }

  return strA.localeCompare(strB, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Stably sorts a list of questions according to the specified sort criteria,
 * applying natural alphanumeric ordering to question numbers (1, 2, 3... 10, 11).
 */
export function sortQuestionsList(
  questions: Question[],
  sortBy: string = 'year_desc'
): Question[] {
  const sorted = [...questions];

  switch (sortBy) {
    case 'question_number_asc':
      sorted.sort((a, b) => {
        const qDiff = compareQuestionNumbers(a.question_number, b.question_number);
        if (qDiff !== 0) return qDiff;
        return (b.year || 0) - (a.year || 0);
      });
      break;

    case 'question_number_desc':
      sorted.sort((a, b) => {
        const qDiff = compareQuestionNumbers(b.question_number, a.question_number);
        if (qDiff !== 0) return qDiff;
        return (b.year || 0) - (a.year || 0);
      });
      break;

    case 'marks_desc':
      sorted.sort((a, b) => {
        const mDiff = (b.marks || 0) - (a.marks || 0);
        if (mDiff !== 0) return mDiff;
        return compareQuestionNumbers(a.question_number, b.question_number);
      });
      break;

    case 'marks_asc':
      sorted.sort((a, b) => {
        const mDiff = (a.marks || 0) - (b.marks || 0);
        if (mDiff !== 0) return mDiff;
        return compareQuestionNumbers(a.question_number, b.question_number);
      });
      break;

    case 'difficulty': {
      const rank = (d: string | null) => (d === 'Easy' ? 1 : d === 'Medium' ? 2 : d === 'Hard' ? 3 : 4);
      sorted.sort((a, b) => {
        const dDiff = rank(a.difficulty) - rank(b.difficulty);
        if (dDiff !== 0) return dDiff;
        return compareQuestionNumbers(a.question_number, b.question_number);
      });
      break;
    }

    case 'created_at':
      sorted.sort((a, b) => {
        const timeA = a.created_at ? new Date(a.created_at).getTime() : 0;
        const timeB = b.created_at ? new Date(b.created_at).getTime() : 0;
        return timeB - timeA;
      });
      break;

    case 'year_desc':
    default:
      sorted.sort((a, b) => {
        if ((b.year || 0) !== (a.year || 0)) {
          return (b.year || 0) - (a.year || 0);
        }
        const pNumA = Number(a.paper_number);
        const pNumB = Number(b.paper_number);
        if (!isNaN(pNumA) && !isNaN(pNumB) && pNumA !== pNumB) {
          return pNumA - pNumB;
        }
        const pStrA = String(a.paper_number || '');
        const pStrB = String(b.paper_number || '');
        if (pStrA !== pStrB) {
          return pStrA.localeCompare(pStrB);
        }
        return compareQuestionNumbers(a.question_number, b.question_number);
      });
      break;
  }

  return sorted;
}

function getNormalizedCacheKey(params: QuestionFilterParams): string {
  const normalized: Record<string, any> = {};
  const keys = Object.keys(params).sort() as (keyof QuestionFilterParams)[];
  for (const k of keys) {
    const val = params[k];
    if (val !== undefined && val !== null && val !== '') {
      normalized[k] = val;
    }
  }
  return JSON.stringify(normalized);
}

/**
 * Synchronously returns cached question query result if available
 */
export function getCachedQuestionsQuery(params: QuestionFilterParams): QuestionQueryResult | null {
  const cacheKey = getNormalizedCacheKey(params);
  const cached = questionsQueryCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  return null;
}

/**
 * Silently prefetches and caches the next page of questions in the background after main UI settles
 */
export function prefetchNextQuestionsPage(currentParams: QuestionFilterParams): void {
  const currentPage = currentParams.page || 1;
  const nextParams = { ...currentParams, page: currentPage + 1 };
  const nextKey = getNormalizedCacheKey(nextParams);
  if (questionsQueryCache.has(nextKey) || inFlightQuestions.has(nextKey)) {
    return;
  }
  if (prefetchTimeoutId) {
    clearTimeout(prefetchTimeoutId);
  }
  prefetchTimeoutId = setTimeout(() => {
    prefetchTimeoutId = null;
    if (!questionsQueryCache.has(nextKey) && !inFlightQuestions.has(nextKey)) {
      fetchQuestions(nextParams).catch(() => {
        // Silent catch for background prefetch
      });
    }
  }, 500);
}

/**
 * Dynamic multi-filter question query with server-side sorting and pagination
 */
export async function fetchQuestions(
  params: QuestionFilterParams = {}
): Promise<QuestionQueryResult> {
  const cacheKey = getNormalizedCacheKey(params);
  const cached = questionsQueryCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  const inFlight = inFlightQuestions.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const promise = (async () => {
    try {
      const {
        searchQuery,
        syllabusId,
        topic,
        subTopic,
        difficulty,
        paperNumber,
        paperType,
        year,
        series,
        minMarks,
        maxMarks,
        questionStyle,
        sortBy = 'year_desc',
        page = 1,
        pageSize = 12,
      } = params;

      // Build the base filtered query with server-side ordering
      const buildFilteredQuery = () => {
        let q = supabase
          .from('questions')
          .select('*', { count: 'exact' });

        // Filter: Syllabus
        if (syllabusId) {
          q = q.eq('syllabus_id', syllabusId);
        }

        // Filter: Topic
        if (topic) {
          q = q.eq('topic', topic);
        }

        // Filter: Sub-topic
        if (subTopic) {
          q = q.eq('sub_topic', subTopic);
        }

        // Filter: Difficulty
        if (difficulty) {
          q = q.eq('difficulty', difficulty);
        }

        // Filter: Cognitive Level (Bloom's Taxonomy)
        if (params.cognitiveLevel && params.cognitiveLevel !== 'all') {
          q = q.filter('mark_scheme->>_cognitive_level', 'eq', params.cognitiveLevel);
        }


        // Filter: Paper Type (Presets, Specific Paper Number, or Exam Series e.g. "Try Out TKA 1")
        const activePaperType = paperType || (typeof paperNumber === 'string' ? paperNumber : undefined);

        if (activePaperType) {
          if (activePaperType === 'mcq' || activePaperType === 'preset:mcq') {
            q = q.in('paper_number', [1, 2, 11, 12, 13, 21, 22, 23]);
          } else if (activePaperType === 'theory' || activePaperType === 'preset:theory') {
            q = q.in('paper_number', [3, 4, 31, 32, 33, 41, 42, 43]);
          } else if (activePaperType === 'atp' || activePaperType === 'preset:atp') {
            q = q.in('paper_number', [6, 61, 62, 63, '6', '61', '62', '63']);
          } else if (activePaperType.startsWith('series:')) {
            const seriesVal = activePaperType.replace('series:', '').trim();
            q = q.eq('series', seriesVal);
          } else if (activePaperType.startsWith('paper:')) {
            const rawP = activePaperType.replace('paper:', '').trim();
            const pNum = Number(rawP);
            if (!isNaN(pNum) && /^\d+$/.test(rawP)) {
              q = q.or(`paper_number.eq.${pNum},paper_number.eq.${rawP}`);
            } else {
              q = q.eq('paper_number', rawP);
            }
          } else {
            const parsedNum = Number(activePaperType);
            if (!isNaN(parsedNum) && /^\d+$/.test(activePaperType.trim())) {
              q = q.or(`paper_number.eq.${parsedNum},paper_number.eq.${activePaperType.trim()}`);
            } else {
              q = q.ilike('series', `%${activePaperType.trim()}%`);
            }
          }
        } else {
          if (paperNumber) {
            if (typeof paperNumber === 'number') {
              q = q.or(`paper_number.eq.${paperNumber},paper_number.eq.${String(paperNumber)}`);
            } else if (paperNumber === 'mcq') {
              q = q.in('paper_number', [1, 2, 11, 12, 13, 21, 22, 23, '1', '2', '11', '12', '13', '21', '22', '23']);
            } else if (paperNumber === 'theory') {
              q = q.in('paper_number', [3, 4, 31, 32, 33, 41, 42, 43, '3', '4', '31', '32', '33', '41', '42', '43']);
            } else if (paperNumber === 'atp') {
              q = q.in('paper_number', [6, 61, 62, 63, '6', '61', '62', '63']);
            } else {
              q = q.eq('paper_number', paperNumber);
            }
          }

          if (series) {
            q = q.ilike('series', `%${series}%`);
          }
        }

        // Filter: Year
        if (year) {
          q = q.eq('year', year);
        }

        // Filter: Marks Range
        if (minMarks !== undefined) {
          q = q.gte('marks', minMarks);
        }
        if (maxMarks !== undefined) {
          q = q.lte('marks', maxMarks);
        }
        // Filter: Question Style
        if (questionStyle) {
          q = q.eq('question_style', questionStyle);
        }

        // Filter: Has Audio Track
        if (params.hasAudio) {
          q = q.not('audio_url', 'is', null).neq('audio_url', '');
        }

        // Filter: Bookmarks Only
        if (params.bookmarkedOnly) {
          const bookmarkedIds = filterValidUuids(Array.from(getBookmarkedQuestionIds()));
          if (bookmarkedIds.length === 0) {
            return null;
          }
          q = q.in('id', bookmarkedIds);
        }

        // Filter: Custom Teacher Tag
        if (params.customTag) {
          const tagMap = getAllQuestionTagsMap();
          const targetTag = params.customTag.toLowerCase().trim().replace(/^#/, '');
          const taggedIds = filterValidUuids(
            Object.keys(tagMap).filter((id) =>
              tagMap[id].some((t) => t.toLowerCase() === targetTag)
            )
          );
          if (taggedIds.length === 0) {
            return null;
          }
          q = q.in('id', taggedIds);
        }

        // Filter: Full-text search with Chemical Formula, LaTeX Symbol & Custom Tag Expansion
        if (searchQuery && searchQuery.trim()) {
          const rawTerm = searchQuery.trim();
          const isTagQuery = rawTerm.startsWith('#');
          const tagMap = getAllQuestionTagsMap();

          if (isTagQuery) {
            // Explicit tag search: e.g. #tka, #mock2026, #homework
            const cleanTag = rawTerm.replace(/^#+/, '').trim().toLowerCase();
            const matchedTagIds = filterValidUuids(
              Object.keys(tagMap).filter((id) =>
                tagMap[id].some((t) => t.toLowerCase().includes(cleanTag))
              )
            );
            if (matchedTagIds.length === 0) {
              return null;
            }
            q = q.in('id', matchedTagIds);
          } else {
            const term = rawTerm;
            const formulaExp = expandFormulaSearch(term);
            const lowerTerm = term.toLowerCase();

            // Check if search term matches any custom teacher tags
            const tagMatchedIds = filterValidUuids(
              Object.keys(tagMap).filter((id) =>
                tagMap[id].some((t) => t.toLowerCase() === lowerTerm || t.toLowerCase().includes(lowerTerm))
              )
            );

            const tokensToSearch = Array.from(
              new Set(
                [term, ...formulaExp.expandedTokens]
                  .map((t) => t.trim())
                  .filter((t) => t.length > 0)
              )
            );

            const textClauses = tokensToSearch
              .slice(0, 15)
              .map((tok) => {
                const pattern = quotePostgrestIlikePattern(tok);
                return `question_text.ilike.${pattern},topic.ilike.${pattern},sub_topic.ilike.${pattern}`;
              });

            if (tagMatchedIds.length > 0) {
              const idClause = tagMatchedIds.length === 1
                ? `id.eq.${tagMatchedIds[0]}`
                : `id.in.(${tagMatchedIds.slice(0, 50).join(',')})`;
              q = q.or([idClause, ...textClauses].join(','));
            } else if (textClauses.length > 1) {
              q = q.or(textClauses.join(','));
            } else {
              const pattern = quotePostgrestIlikePattern(term);
              q = q.or(`question_text.ilike.${pattern},topic.ilike.${pattern},sub_topic.ilike.${pattern}`);
            }
          }
        }

        // Server-side ordering using indexed / numeric columns
        switch (sortBy) {
          case 'question_number_asc':
            q = q
              .order('question_number_numeric', { ascending: true, nullsFirst: false })
              .order('question_number', { ascending: true })
              .order('year', { ascending: false, nullsFirst: false });
            break;
          case 'question_number_desc':
            q = q
              .order('question_number_numeric', { ascending: false, nullsFirst: false })
              .order('question_number', { ascending: false })
              .order('year', { ascending: false, nullsFirst: false });
            break;
          case 'marks_desc':
            q = q
              .order('marks', { ascending: false, nullsFirst: false })
              .order('question_number_numeric', { ascending: true, nullsFirst: false })
              .order('question_number', { ascending: true });
            break;
          case 'marks_asc':
            q = q
              .order('marks', { ascending: true, nullsFirst: false })
              .order('question_number_numeric', { ascending: true, nullsFirst: false })
              .order('question_number', { ascending: true });
            break;
          case 'difficulty':
            q = q
              .order('difficulty', { ascending: true, nullsFirst: false })
              .order('question_number_numeric', { ascending: true, nullsFirst: false })
              .order('question_number', { ascending: true });
            break;
          case 'created_at':
            q = q.order('created_at', { ascending: false, nullsFirst: false });
            break;
          case 'year_desc':
          default:
            q = q
              .order('year', { ascending: false, nullsFirst: false })
              .order('paper_number', { ascending: true, nullsFirst: false })
              .order('question_number_numeric', { ascending: true, nullsFirst: false })
              .order('question_number', { ascending: true });
            break;
        }

        return q;
      };

      const initialQuery = buildFilteredQuery();
      if (initialQuery === null) {
        return { questions: [], totalCount: 0, page: 1, totalPages: 1 };
      }

      const requestedPage = Math.max(1, page);
      const from = (requestedPage - 1) * pageSize;
      const to = from + pageSize - 1;

      // When filtering by a specific topic or sorting by difficulty, fetch up to 60 rows if small
      // so multi-tier questions (Easy -> Medium -> Hard) sort naturally across pages.
      // For general browsing across hundreds/thousands of questions, fetch ONLY the requested page slice!
      const useSmallPackSort = Boolean(topic || sortBy === 'difficulty') && requestedPage === 1;
      const fetchEnd = useSmallPackSort ? Math.max(to, 59) : to;

      const { data, error, count } = await initialQuery.range(from, fetchEnd);

      if (error) {
        console.error('Failed to fetch questions:', error);
        return {
          questions: [],
          totalCount: 0,
          page: requestedPage,
          totalPages: 1,
        };
      }

      const rawQuestions: any[] = Array.isArray(data) ? data : [];
      const totalCount = count ?? rawQuestions.length;
      const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
      const safePage = Math.min(requestedPage, totalPages);

      let pageQuestions: Question[];

      if (useSmallPackSort && rawQuestions.length > pageSize && totalCount <= 60) {
        // Sort the entire small topic pack in memory and populate cache for all its pages
        const allNormalized = rawQuestions.map(normalizeQuestionRecord);
        const allSorted = sortQuestionsList(allNormalized, sortBy);
        const now = Date.now();
        for (let p = 1; p <= totalPages; p++) {
          const pFrom = (p - 1) * pageSize;
          const pSlice = allSorted.slice(pFrom, pFrom + pageSize);
          const pKey = getNormalizedCacheKey({ ...params, page: p });
          questionsQueryCache.set(pKey, {
            data: {
              questions: pSlice,
              totalCount,
              page: p,
              totalPages,
            },
            timestamp: now,
          });
        }
        pageQuestions = allSorted.slice(0, pageSize);
      } else {
        const slicedRaw = rawQuestions.slice(0, pageSize);
        const normalizedQuestions = slicedRaw.map(normalizeQuestionRecord);
        pageQuestions = sortQuestionsList(normalizedQuestions, sortBy);
      }

      const queryResult: QuestionQueryResult = {
        questions: pageQuestions,
        totalCount,
        page: safePage,
        totalPages,
      };

      // Cache query result in memory (limit cache to 100 queries)
      if (questionsQueryCache.size >= 100) {
        const oldest = questionsQueryCache.keys().next().value;
        if (oldest) questionsQueryCache.delete(oldest);
      }
      questionsQueryCache.set(cacheKey, { data: queryResult, timestamp: Date.now() });

      return queryResult;
    } finally {
      inFlightQuestions.delete(cacheKey);
    }
  })();

  inFlightQuestions.set(cacheKey, promise);
  return promise;
}

/**
 * Proactively prefetches initial question bank data in the background (idle/hover)
 */
export function prewarmQuestionBankData(pageSize = 12, syllabusId?: string): void {
  try {
    fetchSyllabuses()
      .then(() => {
        fetchQuestionFacets(syllabusId).catch(() => {});
        fetchQuestions({ syllabusId, sortBy: 'year_desc', page: 1, pageSize }).catch(() => {});
      })
      .catch(() => {});
  } catch {}
}

/**
 * Fetch a single question by UUID with full details
 */
export async function fetchQuestionById(id: string): Promise<Question | null> {
  if (!UUID_REGEX.test(id)) {
    return null;
  }

  const { data, error } = await supabase
    .from('questions')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error || !data) {
    if (error) console.error(`Failed to fetch question ${id}:`, error);
    return null;
  }

  return normalizeQuestionRecord(data);
}

/**
 * Delete a single question by UUID
 */
export async function deleteQuestion(id: string): Promise<boolean> {
  if (!UUID_REGEX.test(id)) {
    return false;
  }

  clearQuestionBankCache();
  const { error } = await supabase
    .from('questions')
    .delete()
    .eq('id', id);

  if (error) {
    console.error(`Failed to delete question ${id}:`, error);
    return false;
  }

  if (typeof window !== 'undefined') window.dispatchEvent(new Event('questions_updated'));
  return true;
}

/**
 * Delete multiple questions by array of UUIDs (bulk deletion)
 */
export async function deleteQuestions(ids: string[]): Promise<{ success: boolean; deletedCount: number }> {
  const validIds = filterValidUuids(ids || []);
  if (validIds.length === 0) {
    return { success: true, deletedCount: 0 };
  }

  clearQuestionBankCache();
  const { error } = await supabase
    .from('questions')
    .delete()
    .in('id', validIds);

  if (error) {
    console.error('Failed to bulk delete questions:', error);
    return { success: false, deletedCount: 0 };
  }

  if (typeof window !== 'undefined') window.dispatchEvent(new Event('questions_updated'));
  return { success: true, deletedCount: validIds.length };
}

/**
 * Updates a question's mark scheme and sub-questions (e.g. after AI guidance enrichment)
 */
export async function updateQuestionMarkScheme(
  id: string,
  markScheme: Question['mark_scheme'],
  subQuestions?: Question['sub_questions']
): Promise<boolean> {
  if (!UUID_REGEX.test(id)) {
    return false;
  }

  const payload: any = { mark_scheme: markScheme };
  if (subQuestions !== undefined) {
    payload.sub_questions = subQuestions;
  }

  const { error } = await (supabase as any)
    .from('questions')
    .update(payload)
    .eq('id', id);

  if (error) {
    console.error(`Failed to update mark scheme for question ${id}:`, error);
    return false;
  }

  clearQuestionBankCache();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('questions_updated'));
  return true;
}

/**
 * Normalizes question record, unpacking embedded audio/diagram metadata if schema fallback was used
 */
export function normalizeQuestionRecord(q: any): Question {
  if (!q) return q;
  const audioUrl = q.audio_url || q.mark_scheme?._audio_url || null;
  const audioMetadata = q.audio_metadata || q.mark_scheme?._audio_metadata || null;
  const diagramSource = q.diagram_source || q.mark_scheme?._diagram_source || null;
  const resourceRef = q.resource_ref || q.mark_scheme?._resource_ref || null;
  const insertPageNumber = q.insert_page_number || q.mark_scheme?._insert_page_number || null;
  const svgContent = q.svg_content || q.mark_scheme?._svg_content || extractSvgFromDiagramUrl(q.diagram_url) || null;
  const aiDiagramPrompt = q.ai_diagram_prompt || q.mark_scheme?._ai_diagram_prompt || null;
  const diagramType = q.diagram_type || q.mark_scheme?._diagram_type || null;
  const hasEmbeddedValues = q.has_embedded_values ?? q.mark_scheme?._has_embedded_values;
  const dataTables = q.data_tables || q.mark_scheme?._data_tables;
  const scratchpad = q.scratchpad || q.mark_scheme?._scratchpad;
  const cognitiveLevel = q.cognitive_level || q.mark_scheme?._cognitive_level || null;
  const sourcePdfUrl = q.source_pdf_url || q.mark_scheme?._source_pdf_url || null;
  const cambridgeHubUrl = q.cambridge_hub_url || q.mark_scheme?._cambridge_hub_url || null;
  const cambridgeMsHubUrl = q.cambridge_ms_hub_url || q.mark_scheme?._cambridge_ms_hub_url || null;
  const insertPdfUrl = q.insert_pdf_url || q.mark_scheme?._insert_pdf_url || null;
  const pageNumber = q.page_number !== undefined && q.page_number !== null ? q.page_number : (q.mark_scheme?._page_number ?? null);

  const normalizedSubs = Array.isArray(q.sub_questions)
    ? q.sub_questions.map((sub: any) => ({
        ...sub,
        cognitive_level: sub.cognitive_level || sub.mark_scheme?._cognitive_level || null,
        svg_content: sub.svg_content || extractSvgFromDiagramUrl(sub.diagram_url) || null,
        ai_diagram_prompt: sub.ai_diagram_prompt || sub.mark_scheme?._ai_diagram_prompt || null,
      }))
    : q.sub_questions;

  return {
    ...q,
    cognitive_level: cognitiveLevel,
    source_pdf_url: sourcePdfUrl,
    cambridge_hub_url: cambridgeHubUrl,
    cambridge_ms_hub_url: cambridgeMsHubUrl,
    ...(insertPdfUrl ? { insert_pdf_url: insertPdfUrl } : {}),
    page_number: pageNumber,
    svg_content: svgContent,
    ai_diagram_prompt: aiDiagramPrompt,
    ...(diagramType ? { diagram_type: diagramType } : {}),
    ...(hasEmbeddedValues !== undefined ? { has_embedded_values: hasEmbeddedValues } : {}),
    ...(dataTables ? { data_tables: dataTables } : {}),
    ...(scratchpad ? { scratchpad } : {}),
    sub_questions: normalizedSubs,
    audio_url: audioUrl,
    audio_metadata: audioMetadata,
    diagram_source: diagramSource,
    resource_ref: resourceRef,
    insert_page_number: insertPageNumber,
  };
}

/**
 * Updates an entire question record in Supabase with automatic schema-fallback resilience
 */
export async function updateQuestion(
  id: string,
  updates: Partial<Omit<Question, 'id' | 'created_at'>>
): Promise<Question | null> {
  if (!UUID_REGEX.test(id)) {
    return null;
  }

  const payload: any = { ...updates };

  // Ensure SVG content is preserved in diagram_url if no separate diagram_url is set
  if (payload.svg_content && !payload.diagram_url) {
    payload.diagram_url = `data:image/svg+xml;utf8,${encodeURIComponent(payload.svg_content)}`;
  }

  // Normalize sub_questions SVG content into diagram_url as well
  if (Array.isArray(payload.sub_questions)) {
    payload.sub_questions = payload.sub_questions.map((sub: any) => ({
      ...sub,
      cognitive_level: sub.cognitive_level || null,
      diagram_url:
        sub.diagram_url ||
        (sub.svg_content ? `data:image/svg+xml;utf8,${encodeURIComponent(sub.svg_content)}` : null),
      ai_diagram_prompt: sub.ai_diagram_prompt || null,
    }));
  }

  // Embed non-schema metadata into mark_scheme JSONB so it persists cleanly
  if (
    payload.ai_diagram_prompt !== undefined ||
    payload.svg_content !== undefined ||
    payload.diagram_type !== undefined ||
    payload.has_embedded_values !== undefined ||
    payload.data_tables !== undefined ||
    payload.scratchpad !== undefined ||
    payload.cognitive_level !== undefined ||
    payload.source_pdf_url !== undefined ||
    payload.cambridge_hub_url !== undefined ||
    payload.cambridge_ms_hub_url !== undefined ||
    payload.insert_pdf_url !== undefined ||
    payload.page_number !== undefined
  ) {
    const baseMarkScheme =
      typeof payload.mark_scheme === 'object' && payload.mark_scheme !== null
        ? { ...payload.mark_scheme }
        : { marking_points: payload.mark_scheme ? [String(payload.mark_scheme)] : ['See marking criteria'] };

    if (payload.ai_diagram_prompt) {
      baseMarkScheme._ai_diagram_prompt = payload.ai_diagram_prompt;
    } else if (payload.ai_diagram_prompt === null) {
      delete baseMarkScheme._ai_diagram_prompt;
    }

    if (payload.svg_content && payload.diagram_url && !String(payload.diagram_url).startsWith('data:image/svg')) {
      baseMarkScheme._svg_content = payload.svg_content;
    } else if (!payload.svg_content) {
      delete baseMarkScheme._svg_content;
    }

    if (payload.diagram_type) baseMarkScheme._diagram_type = payload.diagram_type;
    if (payload.has_embedded_values !== undefined) baseMarkScheme._has_embedded_values = payload.has_embedded_values;
    if (payload.data_tables) baseMarkScheme._data_tables = payload.data_tables;
    if (payload.scratchpad) baseMarkScheme._scratchpad = payload.scratchpad;
    if (payload.cognitive_level) {
      baseMarkScheme._cognitive_level = payload.cognitive_level;
    } else if (payload.cognitive_level === null) {
      delete baseMarkScheme._cognitive_level;
    }
    if (payload.source_pdf_url) {
      baseMarkScheme._source_pdf_url = payload.source_pdf_url;
    } else if (payload.source_pdf_url === null) {
      delete baseMarkScheme._source_pdf_url;
    }
    if (payload.cambridge_hub_url) {
      baseMarkScheme._cambridge_hub_url = payload.cambridge_hub_url;
    } else if (payload.cambridge_hub_url === null) {
      delete baseMarkScheme._cambridge_hub_url;
    }
    if (payload.cambridge_ms_hub_url) {
      baseMarkScheme._cambridge_ms_hub_url = payload.cambridge_ms_hub_url;
    } else if (payload.cambridge_ms_hub_url === null) {
      delete baseMarkScheme._cambridge_ms_hub_url;
    }
    if (payload.insert_pdf_url) {
      baseMarkScheme._insert_pdf_url = payload.insert_pdf_url;
    } else if (payload.insert_pdf_url === null) {
      delete baseMarkScheme._insert_pdf_url;
    }
    if (payload.page_number !== undefined) baseMarkScheme._page_number = payload.page_number;

    payload.mark_scheme = baseMarkScheme;
  }

  // Strip virtual / non-migrated client-only properties that do not exist as columns in `questions`
  delete payload.svg_content;
  delete payload.ai_diagram_prompt;
  delete payload.diagram_type;
  delete payload.has_embedded_values;
  delete payload.data_tables;
  delete payload.scratchpad;
  delete payload.question_number_numeric;
  delete payload.cambridge_hub_url;
  delete payload.cambridge_ms_hub_url;
  delete payload.insert_pdf_url;
  delete payload.id;
  delete payload.created_at;

  let { data, error } = await (supabase as any)
    .from('questions')
    .update(payload)
    .eq('id', id)
    .select('*')
    .maybeSingle();

  // If column doesn't exist in schema cache (e.g. older DB missing migrations 005-017)
  if (
    error &&
    error.message &&
    (error.message.includes('audio_metadata') ||
      error.message.includes('audio_url') ||
      error.message.includes('options') ||
      error.message.includes('diagram_source') ||
      error.message.includes('resource_ref') ||
      error.message.includes('paper_number') ||
      error.message.includes('cognitive_level') ||
      error.message.includes('source_pdf_url') ||
      error.message.includes('page_number') ||
      error.message.includes('ai_diagram_prompt') ||
      error.message.includes('svg_content') ||
      error.message.includes('invalid input syntax for type integer') ||
      error.message.includes('insert_page_number'))
  ) {
    console.warn('Dedicated column not found in database schema, falling back to embedded mark_scheme:', error.message);
    const fallbackPayload: any = { ...payload };
    const markScheme = typeof fallbackPayload.mark_scheme === 'object' && fallbackPayload.mark_scheme !== null
      ? { ...fallbackPayload.mark_scheme }
      : { raw: fallbackPayload.mark_scheme };

    if (fallbackPayload.audio_url) markScheme._audio_url = fallbackPayload.audio_url;
    if (fallbackPayload.audio_metadata) markScheme._audio_metadata = fallbackPayload.audio_metadata;
    if (fallbackPayload.diagram_source) markScheme._diagram_source = fallbackPayload.diagram_source;
    if (fallbackPayload.resource_ref) markScheme._resource_ref = fallbackPayload.resource_ref;
    if (fallbackPayload.insert_page_number) markScheme._insert_page_number = fallbackPayload.insert_page_number;
    if (fallbackPayload.ai_diagram_prompt) markScheme._ai_diagram_prompt = fallbackPayload.ai_diagram_prompt;
    if (fallbackPayload.cognitive_level) markScheme._cognitive_level = fallbackPayload.cognitive_level;
    if (fallbackPayload.source_pdf_url) markScheme._source_pdf_url = fallbackPayload.source_pdf_url;
    if (fallbackPayload.page_number !== undefined) markScheme._page_number = fallbackPayload.page_number;

    delete fallbackPayload.audio_url;
    delete fallbackPayload.audio_metadata;
    delete fallbackPayload.ai_diagram_prompt;
    delete fallbackPayload.svg_content;
    delete fallbackPayload.cognitive_level;
    delete fallbackPayload.source_pdf_url;
    delete fallbackPayload.page_number;
    if (error.message.includes('options')) delete fallbackPayload.options;
    if (error.message.includes('paper_number') || error.message.includes('invalid input syntax for type integer')) {
      fallbackPayload.paper_number = 1;
    }
    delete fallbackPayload.diagram_source;
    delete fallbackPayload.resource_ref;
    delete fallbackPayload.insert_page_number;
    fallbackPayload.mark_scheme = markScheme;

    const retryRes = await (supabase as any)
      .from('questions')
      .update(fallbackPayload)
      .eq('id', id)
      .select('*')
      .maybeSingle();

    data = retryRes.data;
    error = retryRes.error;
  }

  if (error || !data) {
    console.error(`Failed to update question ${id}:`, error);
    return null;
  }

  clearQuestionBankCache();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('questions_updated'));
  return normalizeQuestionRecord(data);
}

/**
 * Inserts a new custom question authored by the teacher or generated as a variant
 */
export async function createQuestion(
  questionData: Partial<Question>
): Promise<Question | null> {
  const isUuid = (str?: string | null) =>
    !!str && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

  // 1. Resolve a valid syllabus_id (foreign key requirement)
  let validSyllabusId = questionData.syllabus_id;
  if (!isUuid(validSyllabusId)) {
    const { data: syllabuses } = await (supabase as any)
      .from('syllabuses')
      .select('id')
      .limit(1);

    if (syllabuses && syllabuses.length > 0) {
      validSyllabusId = (syllabuses[0] as any).id;
    } else {
      const { data: newSyllabus } = await (supabase as any)
        .from('syllabuses')
        .insert({ subject_name: 'General', subject_code: 'GEN' })
        .select('id')
        .maybeSingle();
      if (newSyllabus) {
        validSyllabusId = newSyllabus.id;
      }
    }
  }

  // 2. Build clean insert payload (strip temp / non-UUID IDs and created_at)
  let baseMarkScheme: any =
    typeof questionData.mark_scheme === 'object' && questionData.mark_scheme !== null
      ? { ...questionData.mark_scheme }
      : questionData.mark_scheme
        ? { marking_points: [String(questionData.mark_scheme)] }
        : null;

  const ensureMarkScheme = () => {
    if (!baseMarkScheme) baseMarkScheme = {};
    return baseMarkScheme;
  };

  if ((questionData as any).ai_diagram_prompt) {
    ensureMarkScheme()._ai_diagram_prompt = (questionData as any).ai_diagram_prompt;
  }
  if (questionData.cognitive_level) {
    ensureMarkScheme()._cognitive_level = questionData.cognitive_level;
  }
  if (questionData.source_pdf_url) {
    ensureMarkScheme()._source_pdf_url = questionData.source_pdf_url;
  }
  if (questionData.cambridge_hub_url) {
    ensureMarkScheme()._cambridge_hub_url = questionData.cambridge_hub_url;
  }
  if (questionData.cambridge_ms_hub_url) {
    ensureMarkScheme()._cambridge_ms_hub_url = questionData.cambridge_ms_hub_url;
  }
  if (questionData.insert_pdf_url) {
    ensureMarkScheme()._insert_pdf_url = questionData.insert_pdf_url;
  }
  if (questionData.page_number !== undefined && questionData.page_number !== null) {
    ensureMarkScheme()._page_number = questionData.page_number;
  }

  const payload: any = {
    syllabus_id: validSyllabusId,
    year: Number(questionData.year) || new Date().getFullYear(),
    series: questionData.series || 'Variant',
    paper_number: questionData.paper_number !== undefined && questionData.paper_number !== null
      ? (typeof questionData.paper_number === 'number' ? questionData.paper_number : String(questionData.paper_number).trim())
      : '1',
    question_number: questionData.question_number || '1',
    parent_question_id: questionData.parent_question_id || null,
    question_text: typeof questionData.question_text === 'string' ? questionData.question_text : (questionData.question_text ? JSON.stringify(questionData.question_text) : ''),
    question_style: questionData.question_style || 'Structured',
    topic: questionData.topic || 'General',
    sub_topic: questionData.sub_topic || null,
    difficulty: questionData.difficulty || 'Medium',
    cognitive_level: questionData.cognitive_level || null,
    source_pdf_url: questionData.source_pdf_url || null,
    page_number: questionData.page_number || null,
    marks: Number(questionData.marks) || 1,
    diagram_url:
      questionData.diagram_url ||
      (questionData.svg_content
        ? `data:image/svg+xml;utf8,${encodeURIComponent(questionData.svg_content)}`
        : null),
    diagram_source: (questionData as any).diagram_source || null,
    resource_ref: (questionData as any).resource_ref || null,
    insert_page_number: (questionData as any).insert_page_number || null,
    audio_url: questionData.audio_url || null,
    audio_metadata: questionData.audio_metadata || null,
    options: Array.isArray(questionData.options) ? questionData.options : null,
    sub_questions: Array.isArray(questionData.sub_questions)
      ? questionData.sub_questions.map((sub: any) => ({
          ...sub,
          cognitive_level: sub.cognitive_level || null,
          diagram_url:
            sub.diagram_url ||
            (sub.svg_content ? `data:image/svg+xml;utf8,${encodeURIComponent(sub.svg_content)}` : null),
          ai_diagram_prompt: (sub as any).ai_diagram_prompt || null,
        }))
      : [],
    mark_scheme: baseMarkScheme,
  };

  // If a valid UUID id was passed explicitly, retain it; otherwise let DB generate UUID
  if (isUuid(questionData.id)) {
    payload.id = questionData.id;
  }

  // 3. Attempt insert
  let { data, error } = await (supabase as any)
    .from('questions')
    .insert([payload])
    .select('*')
    .maybeSingle();

  // If insert failed due to missing columns in legacy DB schema, fallback to embedded mark_scheme
  if (
    error &&
    error.message &&
    (error.message.includes('audio_metadata') ||
      error.message.includes('audio_url') ||
      error.message.includes('options') ||
      error.message.includes('diagram_source') ||
      error.message.includes('resource_ref') ||
      error.message.includes('cognitive_level') ||
      error.message.includes('source_pdf_url') ||
      error.message.includes('page_number') ||
      error.message.includes('ai_diagram_prompt') ||
      error.message.includes('insert_page_number'))
  ) {
    console.warn('Dedicated columns not found in database schema, falling back to embedded mark_scheme:', error.message);
    const fallbackPayload: any = { ...payload };
    const markScheme = typeof fallbackPayload.mark_scheme === 'object' && fallbackPayload.mark_scheme !== null
      ? { ...fallbackPayload.mark_scheme }
      : { raw: fallbackPayload.mark_scheme };

    if (fallbackPayload.audio_url) markScheme._audio_url = fallbackPayload.audio_url;
    if (fallbackPayload.audio_metadata) markScheme._audio_metadata = fallbackPayload.audio_metadata;
    if (fallbackPayload.diagram_source) markScheme._diagram_source = fallbackPayload.diagram_source;
    if (fallbackPayload.resource_ref) markScheme._resource_ref = fallbackPayload.resource_ref;
    if (fallbackPayload.insert_page_number) markScheme._insert_page_number = fallbackPayload.insert_page_number;
    if (fallbackPayload.ai_diagram_prompt) markScheme._ai_diagram_prompt = fallbackPayload.ai_diagram_prompt;
    if (fallbackPayload.cognitive_level) markScheme._cognitive_level = fallbackPayload.cognitive_level;
    if (fallbackPayload.source_pdf_url) markScheme._source_pdf_url = fallbackPayload.source_pdf_url;
    if (fallbackPayload.page_number !== undefined) markScheme._page_number = fallbackPayload.page_number;

    delete fallbackPayload.audio_url;
    delete fallbackPayload.audio_metadata;
    delete fallbackPayload.ai_diagram_prompt;
    delete fallbackPayload.cognitive_level;
    delete fallbackPayload.source_pdf_url;
    delete fallbackPayload.page_number;
    if (error.message.includes('options')) delete fallbackPayload.options;
    if (error.message.includes('paper_number') || error.message.includes('invalid input syntax for type integer')) {
      fallbackPayload.paper_number = 1;
    }
    delete fallbackPayload.diagram_source;
    delete fallbackPayload.resource_ref;
    delete fallbackPayload.insert_page_number;
    fallbackPayload.mark_scheme = markScheme;

    const retryResult = await (supabase as any)
      .from('questions')
      .insert([fallbackPayload])
      .select('*')
      .maybeSingle();

    data = retryResult.data;
    error = retryResult.error;
  }

  if (error || !data) {
    console.error('Failed to create custom question:', error);
    throw new Error(error?.message || 'Failed to create question record in database.');
  }

  clearQuestionBankCache();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('questions_updated'));
  return normalizeQuestionRecord(data);
}

// ─── Past Paper Source PDF & Batch Cognitive Classification Helpers ───────────

export interface PastPaperGroupSummary {
  key: string;
  syllabusId: string;
  subjectName: string;
  subjectCode: string;
  year: number;
  series: string;
  paperNumber: string | number;
  questionCount: number;
  linkedPdfCount: number;
  totalQuestions: number;
  hasPdfUrl: boolean;
  samplePdfUrl: string | null;
  linkedHubCount: number;
  hasHubUrl: boolean;
  sampleHubUrl: string | null;
  linkedMsHubCount: number;
  hasMsHubUrl: boolean;
  sampleMsHubUrl: string | null;
}

/**
 * Pure helper to aggregate question rows into distinct PastPaperGroupSummary objects.
 */
export function aggregatePastPapersSummaryFromRows(data: any[]): PastPaperGroupSummary[] {
  const groups = new Map<string, PastPaperGroupSummary>();

  data.forEach((row: any) => {
    const sId = row.syllabus_id || '';
    const syl = row.syllabuses || {};
    const yr = Number(row.year) || 0;
    const ser = String(row.series || '').trim();
    const pNum = row.paper_number !== null && row.paper_number !== undefined ? String(row.paper_number).trim() : '1';

    const key = `${sId}_${yr}_${ser}_${pNum}`;
    const pdfUrl = row.source_pdf_url || row.mark_scheme?._source_pdf_url || null;
    const hubUrl = row.cambridge_hub_url || row.mark_scheme?._cambridge_hub_url || null;
    const msHubUrl = row.cambridge_ms_hub_url || row.mark_scheme?._cambridge_ms_hub_url || null;

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        syllabusId: sId,
        subjectName: syl.subject_name || 'General Subject',
        subjectCode: syl.subject_code || '',
        year: yr,
        series: ser,
        paperNumber: pNum,
        questionCount: 0,
        linkedPdfCount: 0,
        totalQuestions: 0,
        hasPdfUrl: false,
        samplePdfUrl: null,
        linkedHubCount: 0,
        hasHubUrl: false,
        sampleHubUrl: null,
        linkedMsHubCount: 0,
        hasMsHubUrl: false,
        sampleMsHubUrl: null,
      });
    }

    const group = groups.get(key)!;
    group.questionCount += 1;
    group.totalQuestions += 1;
    if (pdfUrl) {
      group.linkedPdfCount += 1;
      group.hasPdfUrl = true;
      if (!group.samplePdfUrl) {
        group.samplePdfUrl = pdfUrl;
      }
    }
    if (hubUrl) {
      group.linkedHubCount += 1;
      group.hasHubUrl = true;
      if (!group.sampleHubUrl) {
        group.sampleHubUrl = hubUrl;
      }
    }
    if (msHubUrl) {
      group.linkedMsHubCount += 1;
      group.hasMsHubUrl = true;
      if (!group.sampleMsHubUrl) {
        group.sampleMsHubUrl = msHubUrl;
      }
    }
  });

  return Array.from(groups.values()).sort((a, b) => {
    if (b.year !== a.year) return b.year - a.year;
    return a.series.localeCompare(b.series) || String(a.paperNumber).localeCompare(String(b.paperNumber));
  });
}

// Cache for past paper groups summary (TTL 5 minutes)
let pastPapersSummaryCache: Record<string, { data: PastPaperGroupSummary[]; timestamp: number } | undefined> = {};
let inFlightPastPapersSummary: Record<string, Promise<PastPaperGroupSummary[]> | undefined> = {};

export function clearPastPapersSummaryCache(syllabusId?: string): void {
  if (syllabusId) {
    delete pastPapersSummaryCache[syllabusId];
    delete pastPapersSummaryCache['all'];
  } else {
    pastPapersSummaryCache = {};
  }
}

/**
 * Optimistically updates the in-memory past paper summary cache for a paper group.
 */
export function updatePastPapersSummaryCache(
  filter: { syllabusId: string; year: number; series: string; paperNumber: string | number },
  updates: Partial<PastPaperGroupSummary>
): void {
  const applyUpdates = (list: PastPaperGroupSummary[]) => {
    return list.map((paper) => {
      const matches =
        paper.syllabusId === filter.syllabusId &&
        paper.year === filter.year &&
        paper.series.toLowerCase() === filter.series.toLowerCase() &&
        String(paper.paperNumber) === String(filter.paperNumber);

      if (!matches) return paper;
      return { ...paper, ...updates };
    });
  };

  const allCache = pastPapersSummaryCache['all'];
  if (allCache?.data) {
    allCache.data = applyUpdates(allCache.data);
  }
  if (filter.syllabusId) {
    const sylCache = pastPapersSummaryCache[filter.syllabusId];
    if (sylCache?.data) {
      sylCache.data = applyUpdates(sylCache.data);
    }
  }
}

/**
 * Fetches an aggregated summary of all distinct past papers in the Question Bank,
 * including how many questions are linked to a Question Paper PDF and Cambridge Support Hub URLs.
 * Results are cached in-memory with automatic cache busting on updates.
 */
export async function fetchDistinctPastPapersSummary(
  syllabusId?: string,
  options: { forceRefresh?: boolean } = {}
): Promise<PastPaperGroupSummary[]> {
  const cacheKey = syllabusId || 'all';

  const cached = pastPapersSummaryCache[cacheKey];
  if (!options.forceRefresh && cached) {
    if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data;
    }
  }

  const inFlight = inFlightPastPapersSummary[cacheKey];
  if (inFlight) {
    return inFlight;
  }

  const fetchPromise = (async () => {
    const allRows: any[] = [];
    const pageSize = 1000;
    let from = 0;

    while (true) {
      let query = (supabase as any)
        .from('questions')
        .select('id, syllabus_id, year, series, paper_number, mark_scheme, source_pdf_url, cambridge_hub_url, cambridge_ms_hub_url, syllabuses ( id, subject_name, subject_code )')
        .range(from, from + pageSize - 1);

      if (syllabusId) {
        query = query.eq('syllabus_id', syllabusId);
      }

      let { data, error } = await query;
      if (
        error &&
        (error.message?.includes('source_pdf_url') ||
          error.message?.includes('cambridge_hub_url') ||
          error.message?.includes('cambridge_ms_hub_url') ||
          error.code === '42703')
      ) {
        let fallbackQuery = (supabase as any)
          .from('questions')
          .select('id, syllabus_id, year, series, paper_number, mark_scheme, syllabuses ( id, subject_name, subject_code )')
          .range(from, from + pageSize - 1);
        if (syllabusId) {
          fallbackQuery = fallbackQuery.eq('syllabus_id', syllabusId);
        }
        const res = await fallbackQuery;
        data = res.data;
        error = res.error;
      }

      if (error) {
        console.error('Failed to fetch distinct past papers page:', error);
        break;
      }

      if (!data || data.length === 0) {
        break;
      }

      allRows.push(...data);
      if (data.length < pageSize) {
        break;
      }
      from += pageSize;
    }

    const aggregated = aggregatePastPapersSummaryFromRows(allRows);
    pastPapersSummaryCache[cacheKey] = { data: aggregated, timestamp: Date.now() };
    return aggregated;
  })()
    .finally(() => {
      delete inFlightPastPapersSummary[cacheKey];
    });

  inFlightPastPapersSummary[cacheKey] = fetchPromise;
  return fetchPromise;
}

/**
 * Attaches a source Question Paper PDF URL to all questions belonging to a specific past paper group.
 * Strictly requires a non-empty syllabusId and verifies subject codes to prevent cross-subject contamination.
 */
export async function batchAttachPastPaperPdf(
  filter: { syllabusId: string; year: number; series: string; paperNumber: string | number },
  pdfUrl: string
): Promise<{ success: boolean; updatedCount: number }> {
  clearQuestionBankCache({ preservePastPapersSummary: true });

  if (!filter.syllabusId || !filter.syllabusId.trim()) {
    throw new Error('batchAttachPastPaperPdf requires a valid, non-empty syllabusId to prevent cross-subject contamination.');
  }

  // Cross-check: If PDF URL starts with a subject code (e.g. papers/0620_...), verify it matches target syllabus
  if (pdfUrl && pdfUrl.trim()) {
    const codeMatch = pdfUrl.match(/papers\/([A-Za-z0-9_-]+?)_\d{4}/);
    if (codeMatch && UUID_REGEX.test(filter.syllabusId.trim())) {
      const pdfSubCode = codeMatch[1].toLowerCase();
      const { data: targetSyl } = await (supabase as any)
        .from('syllabuses')
        .select('subject_code, subject_name')
        .eq('id', filter.syllabusId.trim())
        .maybeSingle();

      if (targetSyl?.subject_code && pdfSubCode !== targetSyl.subject_code.toLowerCase()) {
        throw new Error(
          `Subject mismatch: Cannot attach ${codeMatch[1].toUpperCase()} PDF to ${targetSyl.subject_name} (${targetSyl.subject_code}).`
        );
      }
    }
  }

  let query = (supabase as any)
    .from('questions')
    .select('id, mark_scheme')
    .eq('syllabus_id', filter.syllabusId.trim())
    .eq('year', filter.year);

  if (filter.series) {
    query = query.eq('series', filter.series);
  }

  const pNum = Number(filter.paperNumber);
  if (!isNaN(pNum) && /^\d+$/.test(String(filter.paperNumber).trim())) {
    query = query.or(`paper_number.eq.${pNum},paper_number.eq.${String(filter.paperNumber).trim()}`);
  } else {
    query = query.eq('paper_number', String(filter.paperNumber).trim());
  }

  const { data, error } = await query;
  if (error || !data || data.length === 0) {
    return { success: !error, updatedCount: 0 };
  }

  const ids = data.map((d: any) => d.id);

  // 1. Try native column update if present
  await (supabase as any)
    .from('questions')
    .update({ source_pdf_url: pdfUrl })
    .in('id', ids);

  // 2. Also keep mark_scheme JSONB in sync for maximum schema resilience
  let successCount = 0;
  for (const row of data) {
    const ms = typeof row.mark_scheme === 'object' && row.mark_scheme !== null
      ? { ...row.mark_scheme }
      : { marking_points: ['See mark scheme'] };
    ms._source_pdf_url = pdfUrl;

    const { error: msErr } = await (supabase as any)
      .from('questions')
      .update({ mark_scheme: ms })
      .eq('id', row.id);

    if (!msErr) successCount += 1;
  }

  updatePastPapersSummaryCache(filter, {
    hasPdfUrl: true,
    samplePdfUrl: pdfUrl,
    linkedPdfCount: data.length,
  });

  if (typeof window !== 'undefined') window.dispatchEvent(new Event('questions_updated'));
  return { success: true, updatedCount: successCount };
}

/**
 * Validates an external URL (e.g. Cambridge School Support Hub item link)
 * and checks whether it points to `schoolsupporthub.cambridge.org`.
 */
export function validateCambridgeHubUrl(rawUrl: string): {
  isValid: boolean;
  isCambridgeHubDomain: boolean;
  normalizedUrl: string;
  warning?: string;
  error?: string;
} {
  const trimmed = (rawUrl || '').trim();
  if (!trimmed) {
    return {
      isValid: false,
      isCambridgeHubDomain: false,
      normalizedUrl: '',
      error: 'URL cannot be empty.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      isValid: false,
      isCambridgeHubDomain: false,
      normalizedUrl: trimmed,
      error: 'Please enter a valid http:// or https:// URL.',
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      isValid: false,
      isCambridgeHubDomain: false,
      normalizedUrl: trimmed,
      error: 'URL must start with http:// or https://.',
    };
  }

  const host = parsed.hostname.toLowerCase();
  const isCambridgeHubDomain =
    host === 'schoolsupporthub.cambridge.org' || host.endsWith('.cambridge.org');

  return {
    isValid: true,
    isCambridgeHubDomain,
    normalizedUrl: trimmed,
    warning: isCambridgeHubDomain
      ? undefined
      : 'Tip: This link is not from schoolsupporthub.cambridge.org, but it will still be saved and linked.',
  };
}

/**
 * Helper to query question rows belonging to a specific past paper group.
 */
async function fetchQuestionsForPaperGroup(filter: {
  syllabusId: string;
  year: number;
  series: string;
  paperNumber: string | number;
}): Promise<{ data: any[]; error: any }> {
  let query = (supabase as any)
    .from('questions')
    .select('id, mark_scheme')
    .eq('syllabus_id', filter.syllabusId.trim())
    .eq('year', filter.year);

  if (filter.series) {
    query = query.eq('series', filter.series);
  }

  const pNum = Number(filter.paperNumber);
  if (!isNaN(pNum) && /^\d+$/.test(String(filter.paperNumber).trim())) {
    query = query.or(`paper_number.eq.${pNum},paper_number.eq.${String(filter.paperNumber).trim()}`);
  } else {
    query = query.eq('paper_number', String(filter.paperNumber).trim());
  }

  const { data, error } = await query;
  return { data: data || [], error };
}

/**
 * Attaches an official Cambridge School Support Hub Question Paper (QP) URL
 * to all questions belonging to a specific past paper group.
 */
export async function batchAttachCambridgeHubUrl(
  filter: { syllabusId: string; year: number; series: string; paperNumber: string | number },
  hubUrl: string
): Promise<{ success: boolean; updatedCount: number }> {
  clearQuestionBankCache({ preservePastPapersSummary: true });

  if (!filter.syllabusId || !filter.syllabusId.trim()) {
    throw new Error('batchAttachCambridgeHubUrl requires a valid, non-empty syllabusId.');
  }

  const check = validateCambridgeHubUrl(hubUrl);
  if (!check.isValid) {
    throw new Error(check.error || 'Invalid Cambridge Support Hub URL.');
  }

  const { data, error } = await fetchQuestionsForPaperGroup(filter);
  if (error || data.length === 0) {
    return { success: !error, updatedCount: 0 };
  }

  // Note: Cambridge Hub URLs are persisted inside questions.mark_scheme JSONB (_cambridge_hub_url)
  let successCount = 0;
  for (const row of data) {
    const ms =
      typeof row.mark_scheme === 'object' && row.mark_scheme !== null
        ? { ...row.mark_scheme }
        : { marking_points: ['See mark scheme'] };
    ms._cambridge_hub_url = check.normalizedUrl;

    const { error: msErr } = await (supabase as any)
      .from('questions')
      .update({ mark_scheme: ms })
      .eq('id', row.id);

    if (!msErr) successCount += 1;
  }

  updatePastPapersSummaryCache(filter, {
    hasHubUrl: true,
    sampleHubUrl: check.normalizedUrl,
    linkedHubCount: data.length,
  });

  if (typeof window !== 'undefined') window.dispatchEvent(new Event('questions_updated'));
  return { success: true, updatedCount: successCount };
}

/**
 * Detaches / clears the Cambridge School Support Hub Question Paper (QP) URL
 * from all questions belonging to a specific past paper group.
 */
export async function batchDetachCambridgeHubUrl(
  filter: { syllabusId: string; year: number; series: string; paperNumber: string | number }
): Promise<{ success: boolean; updatedCount: number }> {
  clearQuestionBankCache({ preservePastPapersSummary: true });

  if (!filter.syllabusId || !filter.syllabusId.trim()) {
    throw new Error('batchDetachCambridgeHubUrl requires a valid, non-empty syllabusId.');
  }

  const { data, error } = await fetchQuestionsForPaperGroup(filter);
  if (error || data.length === 0) {
    return { success: !error, updatedCount: 0 };
  }

  let successCount = 0;
  for (const row of data) {
    if (typeof row.mark_scheme === 'object' && row.mark_scheme !== null && row.mark_scheme._cambridge_hub_url) {
      const ms = { ...row.mark_scheme };
      delete ms._cambridge_hub_url;

      const { error: msErr } = await (supabase as any)
        .from('questions')
        .update({ mark_scheme: ms })
        .eq('id', row.id);

      if (!msErr) successCount += 1;
    } else {
      successCount += 1;
    }
  }

  updatePastPapersSummaryCache(filter, {
    hasHubUrl: false,
    sampleHubUrl: null,
    linkedHubCount: 0,
  });

  if (typeof window !== 'undefined') window.dispatchEvent(new Event('questions_updated'));
  return { success: true, updatedCount: successCount };
}

/**
 * Attaches an official Cambridge School Support Hub Mark Scheme (MS) URL
 * to all questions belonging to a specific past paper group.
 */
export async function batchAttachCambridgeMsHubUrl(
  filter: { syllabusId: string; year: number; series: string; paperNumber: string | number },
  msHubUrl: string
): Promise<{ success: boolean; updatedCount: number }> {
  clearQuestionBankCache({ preservePastPapersSummary: true });

  if (!filter.syllabusId || !filter.syllabusId.trim()) {
    throw new Error('batchAttachCambridgeMsHubUrl requires a valid, non-empty syllabusId.');
  }

  const check = validateCambridgeHubUrl(msHubUrl);
  if (!check.isValid) {
    throw new Error(check.error || 'Invalid Cambridge Mark Scheme Hub URL.');
  }

  const { data, error } = await fetchQuestionsForPaperGroup(filter);
  if (error || data.length === 0) {
    return { success: !error, updatedCount: 0 };
  }

  let successCount = 0;
  for (const row of data) {
    const ms =
      typeof row.mark_scheme === 'object' && row.mark_scheme !== null
        ? { ...row.mark_scheme }
        : { marking_points: ['See mark scheme'] };
    ms._cambridge_ms_hub_url = check.normalizedUrl;

    const { error: msErr } = await (supabase as any)
      .from('questions')
      .update({ mark_scheme: ms })
      .eq('id', row.id);

    if (!msErr) successCount += 1;
  }

  updatePastPapersSummaryCache(filter, {
    hasMsHubUrl: true,
    sampleMsHubUrl: check.normalizedUrl,
    linkedMsHubCount: data.length,
  });

  if (typeof window !== 'undefined') window.dispatchEvent(new Event('questions_updated'));
  return { success: true, updatedCount: successCount };
}

/**
 * Detaches / clears the Cambridge School Support Hub Mark Scheme (MS) URL
 * from all questions belonging to a specific past paper group.
 */
export async function batchDetachCambridgeMsHubUrl(
  filter: { syllabusId: string; year: number; series: string; paperNumber: string | number }
): Promise<{ success: boolean; updatedCount: number }> {
  clearQuestionBankCache({ preservePastPapersSummary: true });

  if (!filter.syllabusId || !filter.syllabusId.trim()) {
    throw new Error('batchDetachCambridgeMsHubUrl requires a valid, non-empty syllabusId.');
  }

  const { data, error } = await fetchQuestionsForPaperGroup(filter);
  if (error || data.length === 0) {
    return { success: !error, updatedCount: 0 };
  }

  let successCount = 0;
  for (const row of data) {
    if (typeof row.mark_scheme === 'object' && row.mark_scheme !== null && row.mark_scheme._cambridge_ms_hub_url) {
      const ms = { ...row.mark_scheme };
      delete ms._cambridge_ms_hub_url;

      const { error: msErr } = await (supabase as any)
        .from('questions')
        .update({ mark_scheme: ms })
        .eq('id', row.id);

      if (!msErr) successCount += 1;
    } else {
      successCount += 1;
    }
  }

  updatePastPapersSummaryCache(filter, {
    hasMsHubUrl: false,
    sampleMsHubUrl: null,
    linkedMsHubCount: 0,
  });

  if (typeof window !== 'undefined') window.dispatchEvent(new Event('questions_updated'));
  return { success: true, updatedCount: successCount };
}

/**
 * Unlinks / removes a source Question Paper PDF URL from all questions belonging to a specific past paper group.
 */
export async function batchDetachPastPaperPdf(
  filter: { syllabusId: string; year: number; series: string; paperNumber: string | number }
): Promise<{ success: boolean; updatedCount: number }> {
  clearQuestionBankCache({ preservePastPapersSummary: true });

  if (!filter.syllabusId || !filter.syllabusId.trim()) {
    throw new Error('batchDetachPastPaperPdf requires a valid, non-empty syllabusId.');
  }

  let query = (supabase as any)
    .from('questions')
    .select('id, mark_scheme')
    .eq('syllabus_id', filter.syllabusId.trim())
    .eq('year', filter.year);

  if (filter.series) {
    query = query.eq('series', filter.series);
  }

  const pNum = Number(filter.paperNumber);
  if (!isNaN(pNum) && /^\d+$/.test(String(filter.paperNumber).trim())) {
    query = query.or(`paper_number.eq.${pNum},paper_number.eq.${String(filter.paperNumber).trim()}`);
  } else {
    query = query.eq('paper_number', String(filter.paperNumber).trim());
  }

  const { data, error } = await query;
  if (error || !data || data.length === 0) {
    return { success: !error, updatedCount: 0 };
  }

  const ids = filterValidUuids(data.map((d: any) => d.id));

  // 1. Clear native column
  if (ids.length > 0) {
    await (supabase as any)
      .from('questions')
      .update({ source_pdf_url: null })
      .in('id', ids);
  }

  // 2. Clear from mark_scheme JSONB
  let successCount = 0;
  for (const row of data) {
    if (typeof row.mark_scheme === 'object' && row.mark_scheme !== null && row.mark_scheme._source_pdf_url) {
      const ms = { ...row.mark_scheme };
      delete ms._source_pdf_url;

      const { error: msErr } = await (supabase as any)
        .from('questions')
        .update({ mark_scheme: ms })
        .eq('id', row.id);

      if (!msErr) successCount += 1;
    } else {
      successCount += 1;
    }
  }

  updatePastPapersSummaryCache(filter, {
    hasPdfUrl: false,
    samplePdfUrl: null,
    linkedPdfCount: 0,
  });

  if (typeof window !== 'undefined') window.dispatchEvent(new Event('questions_updated'));
  return { success: true, updatedCount: successCount };
}

export async function batchUpdateCognitiveLevels(
  updates: {
    id: string;
    cognitiveLevel?: CognitiveLevel;
    cognitive_level?: CognitiveLevel;
    subQuestions?: any[];
    sub_questions?: any[];
  }[]
): Promise<number> {
  clearQuestionBankCache();
  let updatedCount = 0;

  for (const item of updates) {
    if (!UUID_REGEX.test(item.id)) continue;
    const level = item.cognitiveLevel || item.cognitive_level || 'C2';
    const subQs = item.sub_questions || item.subQuestions;

    // Fetch current mark_scheme and sub_questions to merge cleanly
    const { data: current } = await (supabase as any)
      .from('questions')
      .select('mark_scheme, sub_questions')
      .eq('id', item.id)
      .maybeSingle();

    if (!current) continue;

    const ms = typeof current?.mark_scheme === 'object' && current?.mark_scheme !== null
      ? { ...current.mark_scheme }
      : { marking_points: ['See mark scheme'] };
    ms._cognitive_level = level;

    const effectiveSubQs = subQs || current?.sub_questions;

    // Primary attempt: update both mark_scheme and cognitive_level column
    const payload: any = {
      cognitive_level: level,
      mark_scheme: ms,
    };
    if (effectiveSubQs) {
      payload.sub_questions = effectiveSubQs;
    }

    const { error } = await (supabase as any)
      .from('questions')
      .update(payload)
      .eq('id', item.id);

    if (!error) {
      updatedCount += 1;
    } else {
      // Fallback: if 'cognitive_level' column is not in DB schema, update mark_scheme & sub_questions only
      delete payload.cognitive_level;
      const { error: retryErr } = await (supabase as any)
        .from('questions')
        .update(payload)
        .eq('id', item.id);

      if (!retryErr) updatedCount += 1;
    }
  }

  if (typeof window !== 'undefined') window.dispatchEvent(new Event('questions_updated'));
  return updatedCount;
}
