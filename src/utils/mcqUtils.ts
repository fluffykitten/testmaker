/**
 * Utility for parsing and standardizing Multiple Choice Question (MCQ) option choices.
 */

export function parseMcqOption(opt: any, defaultIdx: number): { letter: string; text: string } {
  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  const fallbackLetter = letters[defaultIdx] || String.fromCharCode(65 + defaultIdx);

  if (!opt) {
    return { letter: fallbackLetter, text: '' };
  }

  const str = String(opt).trim();

  // Pattern matches formats like:
  // - "A: 37.8%"
  // - "A. Option text"
  // - "A) Option text"
  // - "**A** Option text"
  // - "**A:** Option text"
  // - "[A] Option text"
  // - "(A) Option text"
  // - "A - Option text"
  const match = str.match(/^(\*{0,2}|\[|\()?([A-F])(\*{0,2}|\]|\))?[:.)\s\-]+([\s\S]*)$/i);
  if (match) {
    const letter = match[2].toUpperCase();
    let text = match[4].trim();
    // Strip any residual unclosed markdown bold markers at the start
    text = text.replace(/^(\*{1,2}|:|\.)\s*/, '').replace(/\s*\*{1,2}$/, '');
    return {
      letter,
      text: text || str,
    };
  }

  return {
    letter: fallbackLetter,
    text: str,
  };
}
