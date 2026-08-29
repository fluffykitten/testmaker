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
  year?: number;
  series?: string;
  minMarks?: number;
  maxMarks?: number;
  questionStyle?: QuestionStyle;
  hasAudio?: boolean;
  bookmarkedOnly?: boolean;
  customTag?: string;
  sortBy?: 'created_at' | 'marks_desc' | 'marks_asc' | 'difficulty' | 'year_desc';
  page?: number;
  pageSize?: number;
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
 * Dynamic multi-filter question query with pagination and sorting
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
    year,
    series,
    minMarks,
    maxMarks,
    questionStyle,
    sortBy = 'year_desc',
    page = 1,
    pageSize = 12,
  } = params;

  let query = supabase
    .from('questions')
    .select('*', { count: 'exact' });

  // Filter: Syllabus
  if (syllabusId) {
    query = query.eq('syllabus_id', syllabusId);
  }

  // Filter: Topic
  if (topic) {
    query = query.eq('topic', topic);
  }

  // Filter: Sub-topic
  if (subTopic) {
    query = query.eq('sub_topic', subTopic);
  }

  // Filter: Difficulty
  if (difficulty) {
    query = query.eq('difficulty', difficulty);
  }

  // Filter: Paper Number or preset
  if (paperNumber) {
    if (typeof paperNumber === 'number') {
      query = query.eq('paper_number', paperNumber);
    } else if (paperNumber === 'mcq') {
      // Paper 1 or 2 (MCQ variants)
      query = query.in('paper_number', [1, 2, 11, 12, 13, 21, 22, 23]);
    } else if (paperNumber === 'theory') {
      // Paper 3 or 4 (Theory/Structured)
      query = query.in('paper_number', [3, 4, 31, 32, 33, 41, 42, 43]);
    } else if (paperNumber === 'atp') {
      // Paper 6 (Alternative to Practical)
      query = query.in('paper_number', [6, 61, 62, 63]);
    }
  }

  // Filter: Year
  if (year) {
    query = query.eq('year', year);
  }

  // Filter: Series
  if (series) {
    query = query.ilike('series', `%${series}%`);
  }

  // Filter: Marks Range
  if (minMarks !== undefined) {
    query = query.gte('marks', minMarks);
  }
  if (maxMarks !== undefined) {
    query = query.lte('marks', maxMarks);
  }
  // Filter: Question Style
  if (questionStyle) {
    query = query.eq('question_style', questionStyle);
  }

  // Filter: Has Audio Track
  if (params.hasAudio) {
    query = query.not('audio_url', 'is', null).neq('audio_url', '');
  }

  // Filter: Bookmarks Only
  if (params.bookmarkedOnly) {
    const bookmarkedIds = Array.from(getBookmarkedQuestionIds());
    if (bookmarkedIds.length === 0) {
      return { questions: [], totalCount: 0, page: 1, totalPages: 1 };
    }
    query = query.in('id', bookmarkedIds);
  }

  // Filter: Custom Teacher Tag
  if (params.customTag) {
    const tagMap = getAllQuestionTagsMap();
    const targetTag = params.customTag.toLowerCase().trim().replace(/^#/, '');
    const taggedIds = Object.keys(tagMap).filter((id) =>
      tagMap[id].some((t) => t.toLowerCase() === targetTag)
    );
    if (taggedIds.length === 0) {
      return { questions: [], totalCount: 0, page: 1, totalPages: 1 };
    }
    query = query.in('id', taggedIds);
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
      // Limit to top 20 distinct variations to avoid exceeding PostgREST query length
      const orClauses = tokensToSearch
        .slice(0, 20)
        .map((tok) => `question_text.ilike.%${tok}%,topic.ilike.%${tok}%,sub_topic.ilike.%${tok}%`)
        .join(',');
      query = query.or(orClauses);
    } else {
      query = query.or(`question_text.ilike.%${term}%,topic.ilike.%${term}%,sub_topic.ilike.%${term}%`);
    }
  }

  // Sorting
  switch (sortBy) {
    case 'marks_desc':
      query = query.order('marks', { ascending: false });
      break;
    case 'marks_asc':
      query = query.order('marks', { ascending: true });
      break;
    case 'difficulty':
      query = query.order('difficulty', { ascending: true });
      break;
    case 'created_at':
      query = query.order('created_at', { ascending: false });
      break;
    case 'year_desc':
    default:
      query = query
        .order('year', { ascending: false })
        .order('paper_number', { ascending: true })
        .order('question_number', { ascending: true });
      break;
  }

  // Pagination
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  query = query.range(from, to);

  const { data, error, count } = await query;

  if (error) {
    console.error('Failed to fetch questions:', error);
    return {
      questions: [],
      totalCount: 0,
      page,
      totalPages: 1,
    };
  }

  const totalCount = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

  return {
    questions: ((data as any[]) || []).map(normalizeQuestionRecord),
    totalCount,
    page,
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
