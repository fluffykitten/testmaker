// ─── Question Bookmark Service ────────────────────────────────────────────────
// Manages teacher-bookmarked and favorite exam questions with local persistence.

const BOOKMARKS_STORAGE_KEY = 'fluffykitten_bookmarked_questions';

export function getBookmarkedQuestionIds(): Set<string> {
  try {
    const raw = localStorage.getItem(BOOKMARKS_STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch (err) {
    console.error('Failed to load bookmarks:', err);
    return new Set();
  }
}

export function isQuestionBookmarked(questionId: string): boolean {
  return getBookmarkedQuestionIds().has(questionId);
}

export function toggleBookmarkQuestion(questionId: string): boolean {
  try {
    const current = getBookmarkedQuestionIds();
    let isNowBookmarked = false;

    if (current.has(questionId)) {
      current.delete(questionId);
      isNowBookmarked = false;
    } else {
      current.add(questionId);
      isNowBookmarked = true;
    }

    localStorage.setItem(BOOKMARKS_STORAGE_KEY, JSON.stringify(Array.from(current)));
    window.dispatchEvent(new CustomEvent('bookmarks_updated', { detail: { questionId, isBookmarked: isNowBookmarked } }));
    return isNowBookmarked;
  } catch (err) {
    console.error('Failed to toggle bookmark:', err);
    return false;
  }
}

export function clearAllBookmarks(): void {
  try {
    localStorage.removeItem(BOOKMARKS_STORAGE_KEY);
    window.dispatchEvent(new CustomEvent('bookmarks_updated'));
  } catch (err) {
    console.error('Failed to clear bookmarks:', err);
  }
}
