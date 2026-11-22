import type { CustomTestWithDetails } from '../services/testBuilderService';

export function getSavedTestSubject(test: CustomTestWithDetails): string {
  return (test.primarySubject || test.header_config?.subject || 'General').trim() || 'General';
}

export function sortSavedTestsNewestFirst(tests: CustomTestWithDetails[]): CustomTestWithDetails[] {
  return [...tests]
    .map((test, index) => ({
      test,
      index,
      ts: Date.parse(test.updated_at || test.created_at || '') || 0,
    }))
    .sort((a, b) => {
      if (b.ts !== a.ts) return b.ts - a.ts;
      return a.index - b.index;
    })
    .map((item) => item.test);
}

export function extractSavedTestSubjects(tests: CustomTestWithDetails[]): string[] {
  const seen = new Map<string, string>();
  for (const t of tests) {
    const subj = getSavedTestSubject(t);
    const key = subj.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, subj);
    }
  }
  return Array.from(seen.values()).sort((a, b) => {
    if (a.toLowerCase() === 'general') return 1;
    if (b.toLowerCase() === 'general') return -1;
    return a.localeCompare(b);
  });
}

export function filterSavedTests(
  tests: CustomTestWithDetails[],
  query: string,
  subjectFilter: string = 'ALL'
): CustomTestWithDetails[] {
  const normalizedSubject = subjectFilter.trim().toLowerCase();
  const q = query.trim().toLowerCase();

  return tests.filter((t) => {
    const subj = getSavedTestSubject(t);
    if (normalizedSubject && normalizedSubject !== 'all' && subj.toLowerCase() !== normalizedSubject) {
      return false;
    }
    if (!q) return true;

    const haystack = [
      t.title || '',
      subj,
      t.header_config?.subjectCode || '',
      ...(Array.isArray(t.topics) ? t.topics : []),
    ]
      .join(' ')
      .toLowerCase();

    return q.split(/\s+/).every((token) => haystack.includes(token));
  });
}
