// ─── Question Bank Service ───────────────────────────────────────────────────
// Supabase query interface for fetching, filtering, searching, and managing questions.

import { supabase } from '../lib/supabase';
import type { Question, Syllabus, QuestionDifficulty, QuestionStyle } from '../types/database';

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

  // Filter: Full-text search on question_text or topic
  if (searchQuery && searchQuery.trim()) {
    const term = searchQuery.trim();
    query = query.or(`question_text.ilike.%${term}%,topic.ilike.%${term}%,sub_topic.ilike.%${term}%`);
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
