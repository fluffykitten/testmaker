// ─── Question Tag Service ─────────────────────────────────────────────────────
// Manages teacher-defined custom tags on questions (e.g. #homework, #mock2026, #hard).

const TAGS_STORAGE_KEY = 'fluffykitten_question_tags';

export function getAllQuestionTagsMap(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(TAGS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error('Failed to load question tags:', err);
    return {};
  }
}

export function getQuestionTags(questionId: string): string[] {
  const map = getAllQuestionTagsMap();
  return map[questionId] || [];
}

export function addQuestionTag(questionId: string, rawTag: string): string[] {
  const tag = rawTag.trim().replace(/^#/, '').toLowerCase();
  if (!tag) return getQuestionTags(questionId);

  const map = getAllQuestionTagsMap();
  const existing = map[questionId] || [];
  if (!existing.includes(tag)) {
    const updated = [...existing, tag];
    map[questionId] = updated;
    localStorage.setItem(TAGS_STORAGE_KEY, JSON.stringify(map));
    window.dispatchEvent(new CustomEvent('tags_updated', { detail: { questionId, tags: updated } }));
    return updated;
  }
  return existing;
}

export function removeQuestionTag(questionId: string, rawTag: string): string[] {
  const tag = rawTag.trim().replace(/^#/, '').toLowerCase();
  const map = getAllQuestionTagsMap();
  const existing = map[questionId] || [];
  const updated = existing.filter((t) => t.toLowerCase() !== tag);
  
  if (updated.length > 0) {
    map[questionId] = updated;
  } else {
    delete map[questionId];
  }

  localStorage.setItem(TAGS_STORAGE_KEY, JSON.stringify(map));
  window.dispatchEvent(new CustomEvent('tags_updated', { detail: { questionId, tags: updated } }));
  return updated;
}

export function getDistinctCustomTags(): { tag: string; count: number }[] {
  const map = getAllQuestionTagsMap();
  const counts = new Map<string, number>();

  Object.values(map).forEach((tags) => {
    tags.forEach((t) => {
      counts.set(t, (counts.get(t) || 0) + 1);
    });
  });

  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}
