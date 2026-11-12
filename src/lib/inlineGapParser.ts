export interface GapSegment {
  type: 'text' | 'gap';
  content?: string;
  gapId: string;
  gapNum: number;
  expectedAnswer?: string;
  choices?: string[];
}

const GAP_TOKEN_REGEX =
  /(\[\s*\d+\s*\]|\[\s*(?:blank|gap)\s*(\d*)\s*\]|\{\{\s*\d+\s*\}\}|_{3,}|\[_{2,}\]|\[\s*(\d+)\s*:\s*([^\]]+)\]|\[([^|[\]\n]+(?:\|[^|[\]\n]+)+)\])/gi;

/**
 * Checks whether `targetIndex` sits inside an active `$ ... $` or `$$ ... $$` math block,
 * ignoring currency amounts like `$4.00` that do not open LaTeX math mode.
 */
function isInsideMathBlock(text: string, targetIndex: number): boolean {
  let inInlineMath = false;
  let inDisplayMath = false;

  for (let i = 0; i < targetIndex; i++) {
    if (text[i] === '\\') {
      i++; // Skip escaped characters like \$
      continue;
    }
    if (text[i] === '$') {
      if (text[i + 1] === '$') {
        inDisplayMath = !inDisplayMath;
        i++;
        continue;
      }
      if (!inDisplayMath && !inInlineMath) {
        // Skip currency numbers like $4.00 or $1,000 unless followed directly by $ (e.g. $25$)
        const after = text.slice(i);
        if (/^\$\d+(?:,\d{3})*(?:\.\d+)?(?!\.?\d)(?=[^$\w]|$)/.test(after)) {
          continue;
        }
      }
      if (!inDisplayMath) {
        inInlineMath = !inInlineMath;
      }
    }
  }

  return inInlineMath || inDisplayMath;
}

/**
 * Extracts pipe-delimited inline choice options from `[opt1|opt2|...]`.
 * Returns null if fewer than 2 non-empty options exist.
 */
function parsePipeChoices(inner: string): string[] | null {
  if (!inner || !inner.includes('|')) return null;
  const parts = inner
    .split('|')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  return parts;
}

/**
 * Checks if a string contains inline gap tokens like `[1]`, `[blank]`, `____`,
 * `{{1}}`, `[1: answer]`, or pipe-choice tokens like `[released|absorbed]`.
 * Avoids false positives on trailing exam mark allocations like `"State why. [1]"`.
 */
export function hasInlineGaps(text: string): boolean {
  if (!text) return false;
  return parseGapSegments(text).some((seg) => seg.type === 'gap');
}

/**
 * Parses question text into text blocks and numbered gap/choice segments.
 */
export function parseGapSegments(text: string): GapSegment[] {
  if (!text) return [];

  const segments: GapSegment[] = [];
  const gapRegex = new RegExp(GAP_TOKEN_REGEX.source, 'gi');

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let autoGapCounter = 1;

  while ((match = gapRegex.exec(text)) !== null) {
    const matchedStr = match[0];

    // Skip matches inside active LaTeX math delimiters
    if (isInsideMathBlock(text, match.index)) {
      continue;
    }

    const isSimpleBracketNumber = /^\[\s*\d+\s*\]$/.test(matchedStr);
    const beforeText = text.substring(0, match.index);
    const afterText = text.substring(match.index + matchedStr.length);
    // Ignore trailing mark allocation at the end of a line/prompt after sentence punctuation (e.g. ". [2]")
    if (isSimpleBracketNumber && /[.?!:]\s*$/.test(beforeText) && /^\s*(?:\n|$)/.test(afterText)) {
      continue;
    }

    let choices: string[] | undefined = undefined;
    // Check bracketed pipe choices `[opt1|opt2|...]`
    if (matchedStr.startsWith('[') && matchedStr.endsWith(']') && matchedStr.includes('|')) {
      const parsedChoices = parsePipeChoices(matchedStr.slice(1, -1));
      if (!parsedChoices) {
        continue;
      }
      choices = parsedChoices;
    }

    // 1. Preceding text segment
    if (match.index > lastIndex) {
      const textChunk = text.substring(lastIndex, match.index);
      if (textChunk) {
        segments.push({ type: 'text', content: textChunk, gapId: '', gapNum: 0 });
      }
    }

    let gapNum = autoGapCounter;
    let expectedAnswer: string | undefined = undefined;

    if (!choices) {
      // Check if matched format has an explicit gap number (not when choices themselves contain numbers)
      const explicitNumMatch = matchedStr.match(
        /^(?:\[\s*(\d+)\s*\]|\[\s*(?:blank|gap)\s*(\d+)\s*\]|\{\{\s*(\d+)\s*\}\}|\[\s*(\d+)\s*:)/i
      );
      const explicitNum =
        explicitNumMatch?.[1] || explicitNumMatch?.[2] || explicitNumMatch?.[3] || explicitNumMatch?.[4];
      if (explicitNum) {
        gapNum = parseInt(explicitNum, 10);
      }

      // Check for inline answer syntax e.g. [1: Springfield]
      const keyMatch = matchedStr.match(/^\[\s*\d+\s*:\s*([^\]]+)\]$/);
      if (keyMatch) {
        expectedAnswer = keyMatch[1].trim();
      }
    }

    const gapId = `gap_${gapNum}`;
    segments.push({
      type: 'gap',
      gapId,
      gapNum,
      expectedAnswer,
      choices,
    });

    autoGapCounter = Math.max(autoGapCounter + 1, gapNum + 1);
    lastIndex = match.index + matchedStr.length;
  }

  // 2. Trailing text segment
  if (lastIndex < text.length) {
    const trailing = text.substring(lastIndex);
    if (trailing) {
      segments.push({ type: 'text', content: trailing, gapId: '', gapNum: 0 });
    }
  }

  return segments;
}

