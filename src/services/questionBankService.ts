import { supabase } from '../lib/supabase';
import type { Question, Syllabus, QuestionDifficulty, QuestionStyle } from '../types/database';
import { getBookmarkedQuestionIds } from './questionBookmarkService';
import { getAllQuestionTagsMap } from './questionTagService';
import { expandFormulaSearch } from '../lib/formulaSearch';

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
  sortBy?: 'created_at' | 'marks_desc' | 'marks_asc' | 'difficulty' | 'year_desc' | 'question_number_asc' | 'question_number_desc';
  page?: number;
  pageSize?: number;
}

export interface PaperTypesSummary {
  seriesOptions: { value: string; label: string; rawName: string; count: number }[];
  paperNumberOptions: { value: string; label: string; paperNumber: number; count: number }[];
}

export interface QuestionQueryResult {
  questions: Question[];
  totalCount: number;
  page: number;
  totalPages: number;
}

/**
 * Fetches all available syllabuses/subjects
 */
export async function fetchSyllabuses(): Promise<Syllabus[]> {
  const { data, error } = await supabase
    .from('syllabuses')
    .select('*')
    .order('subject_name', { ascending: true });

  if (error) {
    console.error('Failed to fetch syllabuses:', error);
    return [];
  }

  return data as Syllabus[];
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
 * Fetches distinct topics for a given syllabus (or all syllabuses) with intelligent inference
 */
export async function fetchTopics(syllabusId?: string): Promise<{ topic: string; subTopics: string[] }[]> {
  let query = supabase
    .from('questions')
    .select('topic, sub_topic, question_text, syllabus_id');

  if (syllabusId) {
    query = query.eq('syllabus_id', syllabusId);
  }

  let { data, error } = await query;

  // Fallback: If syllabusId filter yielded no results, fetch all questions to avoid empty topic lists
  if ((!data || data.length === 0) && syllabusId) {
    const fallbackRes = await supabase.from('questions').select('topic, sub_topic, question_text, syllabus_id');
    if (fallbackRes.data && fallbackRes.data.length > 0) {
      data = fallbackRes.data;
    }
  }

  if (error || !data) {
    console.error('Failed to fetch topics:', error);
    return [];
  }

  // Aggregate topics and distinct sub-topics with smart inference
  const topicMap = new Map<string, Set<string>>();

  data.forEach((row: any) => {
    let rawTopic = row.topic?.trim() || '';
    if (!rawTopic || rawTopic.toLowerCase() === 'general') {
      rawTopic = inferTopicFromContent(row.question_text, row.sub_topic);
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
  });

  return Array.from(topicMap.entries())
    .map(([topic, subTopicsSet]) => ({
      topic,
      subTopics: Array.from(subTopicsSet).sort(),
    }))
    .sort((a, b) => a.topic.localeCompare(b.topic));
}

/**
 * Fetches distinct paper types (exam series and paper numbers) from questions in the database
 */
export async function fetchPaperTypes(syllabusId?: string): Promise<PaperTypesSummary> {
  let query = supabase
    .from('questions')
    .select('series, paper_number, syllabus_id');

  if (syllabusId) {
    query = query.eq('syllabus_id', syllabusId);
  }

  let { data, error } = await query;

  // Fallback: If syllabusId filter yielded no results, fetch all questions to ensure options are available
  if ((!data || data.length === 0) && syllabusId) {
    const fallbackRes = await supabase
      .from('questions')
      .select('series, paper_number, syllabus_id');
    if (fallbackRes.data && fallbackRes.data.length > 0) {
      data = fallbackRes.data;
    }
  }

  if (error || !data) {
    console.error('Failed to fetch paper types:', error);
    return { seriesOptions: [], paperNumberOptions: [] };
  }

  const seriesMap = new Map<string, number>();
  const paperNumMap = new Map<number, number>();

  data.forEach((row: any) => {
    if (row.series && typeof row.series === 'string' && row.series.trim()) {
      const s = row.series.trim();
      seriesMap.set(s, (seriesMap.get(s) || 0) + 1);
    }
    if (row.paper_number !== null && row.paper_number !== undefined) {
      const p = Number(row.paper_number);
      if (!isNaN(p)) {
        paperNumMap.set(p, (paperNumMap.get(p) || 0) + 1);
      }
    }
  });

  const seriesOptions = Array.from(seriesMap.entries())
    .map(([series, count]) => ({
      value: `series:${series}`,
      label: `${series} (${count})`,
      rawName: series,
      count,
    }))
    .sort((a, b) => b.count - a.count || a.rawName.localeCompare(b.rawName));

  const paperNumberOptions = Array.from(paperNumMap.entries())
    .map(([num, count]) => ({
      value: `paper:${num}`,
      label: `Paper ${num} (${count})`,
      paperNumber: num,
      count,
    }))
    .sort((a, b) => a.paperNumber - b.paperNumber);

  return { seriesOptions, paperNumberOptions };
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
        if ((a.paper_number || 0) !== (b.paper_number || 0)) {
          return (a.paper_number || 0) - (b.paper_number || 0);
        }
        return compareQuestionNumbers(a.question_number, b.question_number);
      });
      break;
  }

  return sorted;
}

/**
 * Dynamic multi-filter question query with full dataset natural sorting and pagination
 */
export async function fetchQuestions(
  params: QuestionFilterParams = {}
): Promise<QuestionQueryResult> {
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

  // Build the base filtered query
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

    // Filter: Paper Type (Presets, Specific Paper Number, or Exam Series e.g. "Try Out TKA 1")
    const activePaperType = paperType || (typeof paperNumber === 'string' ? paperNumber : undefined);

    if (activePaperType) {
      if (activePaperType === 'mcq' || activePaperType === 'preset:mcq') {
        q = q.in('paper_number', [1, 2, 11, 12, 13, 21, 22, 23]);
      } else if (activePaperType === 'theory' || activePaperType === 'preset:theory') {
        q = q.in('paper_number', [3, 4, 31, 32, 33, 41, 42, 43]);
      } else if (activePaperType === 'atp' || activePaperType === 'preset:atp') {
        q = q.in('paper_number', [6, 61, 62, 63]);
      } else if (activePaperType.startsWith('series:')) {
        const seriesVal = activePaperType.replace('series:', '').trim();
        q = q.eq('series', seriesVal);
      } else if (activePaperType.startsWith('paper:')) {
        const pNum = parseInt(activePaperType.replace('paper:', ''), 10);
        if (!isNaN(pNum)) {
          q = q.eq('paper_number', pNum);
        }
      } else {
        const parsedNum = Number(activePaperType);
        if (!isNaN(parsedNum)) {
          q = q.eq('paper_number', parsedNum);
        } else {
          q = q.ilike('series', `%${activePaperType.trim()}%`);
        }
      }
    } else {
      if (paperNumber) {
        if (typeof paperNumber === 'number') {
          q = q.eq('paper_number', paperNumber);
        } else if (paperNumber === 'mcq') {
          q = q.in('paper_number', [1, 2, 11, 12, 13, 21, 22, 23]);
        } else if (paperNumber === 'theory') {
          q = q.in('paper_number', [3, 4, 31, 32, 33, 41, 42, 43]);
        } else if (paperNumber === 'atp') {
          q = q.in('paper_number', [6, 61, 62, 63]);
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
      const bookmarkedIds = Array.from(getBookmarkedQuestionIds());
      if (bookmarkedIds.length === 0) {
        return null;
      }
      q = q.in('id', bookmarkedIds);
    }

    // Filter: Custom Teacher Tag
    if (params.customTag) {
      const tagMap = getAllQuestionTagsMap();
      const targetTag = params.customTag.toLowerCase().trim().replace(/^#/, '');
      const taggedIds = Object.keys(tagMap).filter((id) =>
        tagMap[id].some((t) => t.toLowerCase() === targetTag)
      );
      if (taggedIds.length === 0) {
        return null;
      }
      q = q.in('id', taggedIds);
    }

    // Filter: Full-text search with Chemical Formula & LaTeX Symbol Expansion
    if (searchQuery && searchQuery.trim()) {
      const term = searchQuery.trim();
      const formulaExp = expandFormulaSearch(term);

      const tokensToSearch = Array.from(
        new Set(
          [term, ...formulaExp.expandedTokens]
            .map((t) => t.trim())
            .filter((t) => t.length > 0)
        )
      );

      if (tokensToSearch.length > 1) {
        const orClauses = tokensToSearch
          .slice(0, 20)
          .map((tok) => `question_text.ilike.%${tok}%,topic.ilike.%${tok}%,sub_topic.ilike.%${tok}%`)
          .join(',');
        q = q.or(orClauses);
      } else {
        q = q.or(`question_text.ilike.%${term}%,topic.ilike.%${term}%,sub_topic.ilike.%${term}%`);
      }
    }

    return q;
  };

  const initialQuery = buildFilteredQuery();
  if (initialQuery === null) {
    return { questions: [], totalCount: 0, page: 1, totalPages: 1 };
  }

  // Fetch initial batch (up to 1,000 questions)
  const { data, error, count } = await initialQuery.range(0, 999);

  if (error) {
    console.error('Failed to fetch questions:', error);
    return {
      questions: [],
      totalCount: 0,
      page,
      totalPages: 1,
    };
  }

  const rawQuestions: any[] = Array.isArray(data) ? [...data] : [];
  const totalCount = count ?? rawQuestions.length;

  // If total matching records exceed 1,000, fetch remaining batches in parallel
  if (totalCount > 1000) {
    const batchPromises = [];
    for (let offset = 1000; offset < totalCount && offset < 5000; offset += 1000) {
      const batchQuery = buildFilteredQuery();
      if (batchQuery) {
        batchPromises.push(batchQuery.range(offset, Math.min(offset + 999, totalCount - 1)));
      }
    }
    const batchResults = await Promise.all(batchPromises);
    for (const res of batchResults) {
      if (res.data && Array.isArray(res.data)) {
        rawQuestions.push(...res.data);
      }
    }
  }

  // Normalize all fetched questions
  const normalizedQuestions: Question[] = rawQuestions.map(normalizeQuestionRecord);

  // Apply complete natural sorting across the ENTIRE result set
  const sortedQuestions = sortQuestionsList(normalizedQuestions, sortBy);

  // Paginate from the perfectly sorted master list
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const from = (safePage - 1) * pageSize;
  const to = from + pageSize;
  const pageQuestions = sortedQuestions.slice(from, to);

  return {
    questions: pageQuestions,
    totalCount,
    page: safePage,
    totalPages,
  };
}

/**
 * Fetch a single question by UUID with full details
 */
export async function fetchQuestionById(id: string): Promise<Question | null> {
  const { data, error } = await supabase
    .from('questions')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !data) {
    console.error(`Failed to fetch question ${id}:`, error);
    return null;
  }

  return normalizeQuestionRecord(data);
}

/**
 * Delete a single question by UUID
 */
export async function deleteQuestion(id: string): Promise<boolean> {
  const { error } = await supabase
    .from('questions')
    .delete()
    .eq('id', id);

  if (error) {
    console.error(`Failed to delete question ${id}:`, error);
    return false;
  }

  return true;
}

/**
 * Delete multiple questions by array of UUIDs (bulk deletion)
 */
export async function deleteQuestions(ids: string[]): Promise<{ success: boolean; deletedCount: number }> {
  if (!ids || ids.length === 0) {
    return { success: true, deletedCount: 0 };
  }

  const { error } = await supabase
    .from('questions')
    .delete()
    .in('id', ids);

  if (error) {
    console.error('Failed to bulk delete questions:', error);
    return { success: false, deletedCount: 0 };
  }

  return { success: true, deletedCount: ids.length };
}

/**
 * Updates a question's mark scheme and sub-questions (e.g. after AI guidance enrichment)
 */
export async function updateQuestionMarkScheme(
  id: string,
  markScheme: Question['mark_scheme'],
  subQuestions?: Question['sub_questions']
): Promise<boolean> {
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

  return {
    ...q,
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
  const payload: any = { ...updates };
  let { data, error } = await (supabase as any)
    .from('questions')
    .update(payload)
    .eq('id', id)
    .select('*')
    .single();

  // If column doesn't exist in schema cache (e.g. audio_metadata or audio_url not migrated yet)
  if (
    error &&
    error.message &&
    (error.message.includes('audio_metadata') ||
      error.message.includes('audio_url') ||
      error.message.includes('options') ||
      error.message.includes('diagram_source') ||
      error.message.includes('resource_ref') ||
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

    delete fallbackPayload.audio_url;
    delete fallbackPayload.audio_metadata;
    if (error.message.includes('options')) delete fallbackPayload.options;
    delete fallbackPayload.diagram_source;
    delete fallbackPayload.resource_ref;
    delete fallbackPayload.insert_page_number;
    fallbackPayload.mark_scheme = markScheme;

    const retryRes = await (supabase as any)
      .from('questions')
      .update(fallbackPayload)
      .eq('id', id)
      .select('*')
      .single();

    data = retryRes.data;
    error = retryRes.error;
  }

  if (error || !data) {
    console.error(`Failed to update question ${id}:`, error);
    return null;
  }

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
        .single();
      if (newSyllabus) {
        validSyllabusId = newSyllabus.id;
      }
    }
  }

  // 2. Build clean insert payload (strip temp / non-UUID IDs and created_at)
  const payload: any = {
    syllabus_id: validSyllabusId,
    year: Number(questionData.year) || new Date().getFullYear(),
    series: questionData.series || 'Variant',
    paper_number: questionData.paper_number !== undefined && questionData.paper_number !== null ? Number(questionData.paper_number) : 1,
    question_number: questionData.question_number || '1',
    parent_question_id: questionData.parent_question_id || null,
    question_text: typeof questionData.question_text === 'string' ? questionData.question_text : (questionData.question_text ? JSON.stringify(questionData.question_text) : ''),
    question_style: questionData.question_style || 'Structured',
    topic: questionData.topic || 'General',
    sub_topic: questionData.sub_topic || null,
    difficulty: questionData.difficulty || 'Medium',
    marks: Number(questionData.marks) || 1,
    diagram_url: questionData.diagram_url || null,
    diagram_source: (questionData as any).diagram_source || null,
    resource_ref: (questionData as any).resource_ref || null,
    insert_page_number: (questionData as any).insert_page_number || null,
    audio_url: questionData.audio_url || null,
    audio_metadata: questionData.audio_metadata || null,
    options: Array.isArray(questionData.options) ? questionData.options : null,
    sub_questions: Array.isArray(questionData.sub_questions) ? questionData.sub_questions : [],
    mark_scheme: questionData.mark_scheme || null,
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
    .single();

  // If insert failed due to missing columns in DB schema, fallback to embedded mark_scheme
  if (
    error &&
    error.message &&
    (error.message.includes('audio_metadata') ||
      error.message.includes('audio_url') ||
      error.message.includes('options') ||
      error.message.includes('diagram_source') ||
      error.message.includes('resource_ref') ||
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

    delete fallbackPayload.audio_url;
    delete fallbackPayload.audio_metadata;
    if (error.message.includes('options')) delete fallbackPayload.options;
    delete fallbackPayload.diagram_source;
    delete fallbackPayload.resource_ref;
    delete fallbackPayload.insert_page_number;
    fallbackPayload.mark_scheme = markScheme;

    const retryResult = await (supabase as any)
      .from('questions')
      .insert([fallbackPayload])
      .select('*')
      .single();

    data = retryResult.data;
    error = retryResult.error;
  }

  if (error || !data) {
    console.error('Failed to create custom question:', error);
    throw new Error(error?.message || 'Failed to create question record in database.');
  }

  return normalizeQuestionRecord(data);
}
