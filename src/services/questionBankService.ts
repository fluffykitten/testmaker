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
 * Fetches distinct topics for a given syllabus (or all syllabuses)
 */
export async function fetchTopics(syllabusId?: string): Promise<{ topic: string; subTopics: string[] }[]> {
  let query = supabase
    .from('questions')
    .select('topic, sub_topic');

  if (syllabusId) {
    query = query.eq('syllabus_id', syllabusId);
  }

  const { data, error } = await query;

  if (error || !data) {
    console.error('Failed to fetch topics:', error);
    return [];
  }

  // Aggregate topics and distinct sub-topics
  const topicMap = new Map<string, Set<string>>();

  data.forEach((row: any) => {
    if (row.topic) {
      if (!topicMap.has(row.topic)) {
        topicMap.set(row.topic, new Set());
      }
      if (row.sub_topic) {
        topicMap.get(row.topic)!.add(row.sub_topic);
      }
    }
  });

  return Array.from(topicMap.entries()).map(([topic, subTopicsSet]) => ({
    topic,
    subTopics: Array.from(subTopicsSet),
  }));
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
    .select('id, syllabus_id, topic, marks');

  if (error || !data || data.length === 0) {
    return [];
  }

  const subjectGroups = new Map<string, Map<string, { count: number; marks: number }>>();

  data.forEach((row: any) => {
    const sId = row.syllabus_id || 'general';
    const topic = row.topic?.trim() || 'General';
    const marks = row.marks || 1;

    if (!subjectGroups.has(sId)) {
      subjectGroups.set(sId, new Map());
    }
    const topicMap = subjectGroups.get(sId)!;
    const current = topicMap.get(topic) || { count: 0, marks: 0 };
    topicMap.set(topic, { count: current.count + 1, marks: current.marks + marks });
  });

  const result: SubjectTopicSummary[] = [];

  subjectGroups.forEach((topicMap, sId) => {
    const sObj = syllabusMap.get(sId);
    const subjectName = sObj ? sObj.subject_name : 'Uploaded Past Papers';
    const subjectCode = sObj?.subject_code;

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

    if (formulaExp.isFormula && formulaExp.expandedTokens.length > 1) {
      const orClauses = formulaExp.expandedTokens
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
    questions: (data as Question[]) || [],
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

  return data as Question;
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
 * Updates an entire question record in Supabase
 */
export async function updateQuestion(
  id: string,
  updates: Partial<Omit<Question, 'id' | 'created_at'>>
): Promise<Question | null> {
  const { data, error } = await (supabase as any)
    .from('questions')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();

  if (error || !data) {
    console.error(`Failed to update question ${id}:`, error);
    return null;
  }

  return data as Question;
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

  // If insert failed due to missing options column in DB, retry without options
  if (error && error.message && error.message.toLowerCase().includes('options')) {
    const { options, ...payloadWithoutOptions } = payload;
    const retryResult = await (supabase as any)
      .from('questions')
      .insert([payloadWithoutOptions])
      .select('*')
      .single();
    data = retryResult.data;
    error = retryResult.error;
  }

  if (error || !data) {
    console.error('Failed to create custom question:', error);
    throw new Error(error?.message || 'Failed to create question record in database.');
  }

  return data as Question;
}
