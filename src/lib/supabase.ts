import { createClient } from '@supabase/supabase-js';
import type { Database } from '../types/database';

export const supabaseUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || process.env?.VITE_SUPABASE_URL || 'https://placeholder.supabase.co';
export const supabaseAnonKey = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_ANON_KEY) || process.env?.VITE_SUPABASE_ANON_KEY || 'placeholder-key';

export const TEACHER_SESSION_TOKEN_KEY = 'testmaker_teacher_token';

export function getActiveTeacherSessionToken(): string {
  if (typeof sessionStorage === 'undefined') return '';
  try {
    return (sessionStorage.getItem(TEACHER_SESSION_TOKEN_KEY) || '').trim();
  } catch {
    return '';
  }
}

export function hasActiveTeacherSession(): boolean {
  return Boolean(getActiveTeacherSessionToken());
}

function teacherAwareFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const token = getActiveTeacherSessionToken();
  if (!token) {
    return globalThis.fetch(input, init);
  }

  const headers = new Headers(
    init?.headers || (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined)
  );
  if (!headers.has('x-teacher-session')) {
    headers.set('x-teacher-session', token);
  }

  return globalThis.fetch(input, {
    ...init,
    headers,
  });
}

export function isSupabaseConfigured(): boolean {
  return Boolean(
    supabaseUrl &&
    !supabaseUrl.includes('placeholder.supabase.co') &&
    supabaseAnonKey &&
    supabaseAnonKey !== 'placeholder-key'
  );
}

export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  global: {
    fetch: teacherAwareFetch,
  },
});
