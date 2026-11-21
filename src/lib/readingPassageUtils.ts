/**
 * Pure utilities for Reading Passage boundary detection (`[passage]...[/passage]`,
 * `[no_passage]`, explicit Markdown headings, multi-paragraph heuristics) and
 * Question Editor selection/token wrapping (`**bold**`, `*italic*`, `[u]underline[/u]`, etc.).
 *
 * Kept dependency-free so it can run safely in UI components, exporters, and Node tests
 * without circular imports.
 */

export const PASSAGE_OPEN_TAG = '[passage]';
export const PASSAGE_CLOSE_TAG = '[/passage]';
export const NO_PASSAGE_TAG = '[no_passage]';

export interface QuestionParts {
  passageText: string | null;
  promptText: string;
  explicitMode?: 'none' | 'explicit_block' | 'disabled';
}

export interface SelectionWrapResult {
  nextText: string;
  nextSelStart: number;
  nextSelEnd: number;
}

export interface InstructionBlock {
  type: 'bullet' | 'paragraph';
  text: string;
  explicitBullet?: boolean;
}

/** Parses candidate instructions into clean bullet & paragraph lines (preventing double bullets). */
export function parseInstructionLines(raw: string): InstructionBlock[] {
  if (!raw || typeof raw !== 'string') return [];
  const normalized = raw.replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const blocks: InstructionBlock[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Matches `- item`, `• item`, or `* item` (but NOT `*italic*` or `**bold**`)
    const bulletMatch = trimmed.match(/^(?:[-•]|(?:\*(?!\*)))\s+(.+)$/);
    if (bulletMatch && bulletMatch[1]) {
      blocks.push({
        type: 'bullet',
        text: bulletMatch[1].trim(),
        explicitBullet: true,
      });
    } else {
      blocks.push({
        type: 'paragraph',
        text: trimmed,
        explicitBullet: false,
      });
    }
  }

  return blocks;
}

/** Toggles a `- ` bullet prefix across the currently selected line(s) in a textarea. */
export function toggleBulletPrefixOnSelection(
  text: string,
  selStart: number,
  selEnd: number
): SelectionWrapResult {
  const source = text || '';
  const start = Math.max(0, Math.min(selStart, selEnd, source.length));
  const end = Math.max(start, Math.min(Math.max(selStart, selEnd), source.length));

  const lineStart = source.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  const nextNl = source.indexOf('\n', end);
  const lineEnd = nextNl === -1 ? source.length : nextNl;

  const block = source.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const bulletPrefixRegex = /^(?:[-•]|(?:\*(?!\*)))\s+/;
  const nonEmptyLines = lines.filter((l) => l.trim().length > 0);
  const allBulleted =
    nonEmptyLines.length > 0 && nonEmptyLines.every((l) => bulletPrefixRegex.test(l.trimStart()));

  const transformed = lines
    .map((line) => {
      if (lines.length > 1 && line.trim().length === 0) return line;
      if (allBulleted) {
        return line.replace(/^(\s*)(?:[-•]|(?:\*(?!\*)))\s+/, '$1');
      }
      if (bulletPrefixRegex.test(line.trimStart())) return line;
      return `- ${line}`;
    })
    .join('\n');

  const before = source.slice(0, lineStart);
  const after = source.slice(lineEnd);
  return {
    nextText: `${before}${transformed}${after}`,
    nextSelStart: lineStart + transformed.length,
    nextSelEnd: lineStart + transformed.length,
  };
}

/** Inserts a newline at the active cursor/selection range. */
export function insertNewLineAtSelection(
  text: string,
  selStart: number,
  selEnd: number
): SelectionWrapResult {
  const source = text || '';
  const start = Math.max(0, Math.min(selStart, selEnd, source.length));
  const end = Math.max(start, Math.min(Math.max(selStart, selEnd), source.length));
  const nextText = `${source.slice(0, start)}\n${source.slice(end)}`;
  const caret = start + 1;
  return {
    nextText,
    nextSelStart: caret,
    nextSelEnd: caret,
  };
}

const PASSAGE_TAGS_REGEX = /\[\/?passage\]|\[no_passage\]/gi;
const EXPLICIT_PASSAGE_BLOCK_REGEX = /\[passage\]([\s\S]*?)\[\/passage\]/i;
const NO_PASSAGE_DIRECTIVE_REGEX = /\[no_passage\]/i;

const LANGUAGE_HEADER_LINE_REGEX =
  /^###\s*(?:Text|Passage|Reading|Stimulus|Wacana|Bacaan|Teks)(?:\s+[A-Za-z0-9]+)?\b[^\n]*/i;
const GENERAL_HEADER_LINE_REGEX =
  /^###\s*(?:Reading\s+Passage|Wacana|Bacaan|Teks)(?:\s+[A-Za-z0-9]+)?\b[^\n]*/i;

const QUESTION_PROMPT_START_REGEX =
  /^(?:(?:\*{1,2})?(?:Question\s*\d+|No\.?\s*\d+|\d+\.)\b|which|what|how|why|where|when|who|whom|whose|according\s+to|based\s+on|from\s+the\s+(?:text|passage|article|dialogue)|explain|state|describe|determine|identify|suggest|compare|evaluate|discuss|summarize|infer|berdasarkan|mengapa|apakah|bagaimana|jelaskan|tentukan|perbaikan|makna|peribahasa|topik|pesan|pendapat|sikap|interpretasi|ulasan|hubungan|masalah|manakah)\b/i;

const NON_PASSAGE_TASK_OPENER_REGEX =
  /^(?:write\s+(?:an?|your)\s+(?:email|letter|essay|article|report|review|story|note|message|paragraph)|you\s+(?:have\s+received|recently|are\s+going\s+to\s+write)|complete\s+the\s+(?:sentences?|gaps?|table|notes?|form)|choose\s+the\s+(?:correct|best)\s+(?:word|phrase|option|answer)|fill\s+in\s+the\s+(?:blanks?|gaps?)|listen\s+to)\b/i;

/** Removes `[passage]`, `[/passage]`, and `[no_passage]` control markers from text. */
export function stripPassageControlTags(text: string, preserveEdges = false): string {
  if (!text || typeof text !== 'string') return '';
  const stripped = text
    .replace(/\[no_passage\][ \t]*\n?/gi, '')
    .replace(PASSAGE_TAGS_REGEX, '')
    .replace(/\n{3,}/g, '\n\n');
  return preserveEdges ? stripped : stripped.trim();
}

export function hasNoPassageDirective(text: string): boolean {
  return Boolean(text && NO_PASSAGE_DIRECTIVE_REGEX.test(text));
}

export function hasExplicitPassageMarkers(text: string): boolean {
  return Boolean(text && EXPLICIT_PASSAGE_BLOCK_REGEX.test(text));
}

/** Toggles `[no_passage]` on or off cleanly at the top of a stem. */
export function toggleNoPassageDirective(text: string): string {
  const source = text || '';
  if (hasNoPassageDirective(source)) {
    return source.replace(/\[no_passage\][ \t]*\n?/gi, '').trimStart();
  }
  const withoutPassageTags = source.replace(/\[\/?passage\]/gi, '');
  const trimmed = withoutPassageTags.replace(/^\s+/, '');
  return trimmed ? `${NO_PASSAGE_TAG}\n${trimmed}` : NO_PASSAGE_TAG;
}

/** Removes all passage control markers while preserving all actual question text. */
export function clearPassageMarkers(text: string): string {
  return stripPassageControlTags(text || '');
}

/** Wraps or unwraps the active textarea selection with `openTag` ... `closeTag`. */
export function wrapSelectionWithToken(
  text: string,
  selStart: number,
  selEnd: number,
  openTag: string,
  closeTag: string,
  placeholder = 'text'
): SelectionWrapResult {
  const source = text || '';
  const start = Math.max(0, Math.min(selStart, selEnd, source.length));
  const end = Math.max(start, Math.min(Math.max(selStart, selEnd), source.length));
  const before = source.slice(0, start);
  const selected = source.slice(start, end);
  const after = source.slice(end);

  // Unwrap if the selection itself is already wrapped cleanly
  if (
    selected.length >= openTag.length + closeTag.length &&
    selected.startsWith(openTag) &&
    selected.endsWith(closeTag) &&
    !(openTag === '*' && selected.startsWith('**') && selected.endsWith('**'))
  ) {
    const inner = selected.slice(openTag.length, selected.length - closeTag.length);
    return {
      nextText: `${before}${inner}${after}`,
      nextSelStart: start,
      nextSelEnd: start + inner.length,
    };
  }

  // Unwrap if the surrounding slice immediately before/after carries matching tags
  const surroundedByTags =
    before.endsWith(openTag) &&
    after.startsWith(closeTag) &&
    !(openTag === '*' && before.endsWith('**') && after.startsWith('**'));

  if (surroundedByTags) {
    const trimmedBefore = before.slice(0, before.length - openTag.length);
    const trimmedAfter = after.slice(closeTag.length);
    const nextStart = trimmedBefore.length;
    return {
      nextText: `${trimmedBefore}${selected}${trimmedAfter}`,
      nextSelStart: nextStart,
      nextSelEnd: nextStart + selected.length,
    };
  }

  if (selected.length === 0) {
    const fill = placeholder;
    const inserted = `${openTag}${fill}${closeTag}`;
    const innerStart = start + openTag.length;
    return {
      nextText: `${before}${inserted}${after}`,
      nextSelStart: innerStart,
      nextSelEnd: innerStart + fill.length,
    };
  }

  // Preserve leading/trailing whitespace outside inline markers (except multiline passage/display math blocks)
  const isMultilineTag = openTag.includes('\n') || openTag === PASSAGE_OPEN_TAG;
  if (!isMultilineTag) {
    const leadMatch = selected.match(/^(\s*)([\s\S]*?)(\s*)$/);
    if (leadMatch && leadMatch[2].length > 0) {
      const lead = leadMatch[1];
      const core = leadMatch[2];
      const trail = leadMatch[3];
      const wrapped = `${lead}${openTag}${core}${closeTag}${trail}`;
      const innerStart = start + lead.length + openTag.length;
      return {
        nextText: `${before}${wrapped}${after}`,
        nextSelStart: innerStart,
        nextSelEnd: innerStart + core.length,
      };
    }
  }

  const wrapped = `${openTag}${selected}${closeTag}`;
  const innerStart = start + openTag.length;
  return {
    nextText: `${before}${wrapped}${after}`,
    nextSelStart: innerStart,
    nextSelEnd: innerStart + selected.length,
  };
}

function splitExplicitMarkdownHeader(
  clean: string,
  allowAllLanguageHeaders: boolean
): QuestionParts | null {
  const headerRegex = allowAllLanguageHeaders ? LANGUAGE_HEADER_LINE_REGEX : GENERAL_HEADER_LINE_REGEX;
  const lines = clean.split('\n');
  const headerIdx = lines.findIndex((line) => headerRegex.test(line.trim()));
  if (headerIdx < 0) return null;

  const preHeader = lines.slice(0, headerIdx).join('\n').trim();
  const fromHeader = lines.slice(headerIdx).join('\n').trim();
  const paragraphs = fromHeader.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);

  if (paragraphs.length < 2) {
    return null;
  }

  const headerLineOnly = headerRegex.test(paragraphs[0]) && !paragraphs[0].includes('\n');

  // Stitch format (`### Text 1\n\n<body>...\n\n<prompt>`) requires at least a body paragraph AND prompt paragraph
  if (headerLineOnly && paragraphs.length < 3) {
    return null;
  }

  const promptPara = paragraphs[paragraphs.length - 1];
  const passageParas = paragraphs.slice(0, -1);
  const bodyLength = (headerLineOnly ? passageParas.slice(1) : passageParas).join(' ').trim().length;
  if (bodyLength < 40) {
    return null;
  }

  const passageCombined = [preHeader, ...passageParas].filter(Boolean).join('\n\n').trim();
  return {
    passageText: passageCombined,
    promptText: promptPara,
    explicitMode: 'none',
  };
}

/**
 * Splits a question stem into optional `passageText` (reading stimulus) and `promptText`.
 */
export function splitPassageAndPrompt(
  text: string,
  _options?: string[] | null,
  opts?: { allowParagraphHeuristic?: boolean; cleanText?: string }
): QuestionParts {
  const source = typeof opts?.cleanText === 'string' ? opts.cleanText : text || '';
  if (!source) return { passageText: null, promptText: '', explicitMode: 'none' };

  // Tier 0: Explicit `[no_passage]` override disables all heuristics & cross-question inheritance
  if (hasNoPassageDirective(source)) {
    return {
      passageText: null,
      promptText: stripPassageControlTags(source),
      explicitMode: 'disabled',
    };
  }

  // Tier 1: Explicit `[passage]...[/passage]` start/end boundaries
  const explicitMatch = source.match(EXPLICIT_PASSAGE_BLOCK_REGEX);
  if (explicitMatch && explicitMatch[1] !== undefined) {
    const innerPassage = stripPassageControlTags(explicitMatch[1]).trim();
    const beforeBlock = source.slice(0, explicitMatch.index || 0);
    const afterBlock = source.slice((explicitMatch.index || 0) + explicitMatch[0].length);
    const remainingPrompt = stripPassageControlTags(`${beforeBlock}\n\n${afterBlock}`);
    if (innerPassage) {
      return {
        passageText: innerPassage,
        promptText: remainingPrompt,
        explicitMode: 'explicit_block',
      };
    }
  }

  const clean = stripPassageControlTags(source);

  // Automatic heuristics require at least 180 chars of stem text
  if (clean.length < 180) {
    return { passageText: null, promptText: clean, explicitMode: 'none' };
  }

  // Tier 2: Fixed Rule 1 — Explicit `###` Header Split across multi-paragraph passages
  const headerSplit = splitExplicitMarkdownHeader(clean, Boolean(opts?.allowParagraphHeuristic));
  if (headerSplit) {
    return headerSplit;
  }

  // Tier 3: Tightened Rule 2 — Multi-paragraph heuristic for standalone language questions
  if (opts?.allowParagraphHeuristic) {
    const paragraphs = clean.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (paragraphs.length >= 2) {
      const lastP = paragraphs[paragraphs.length - 1];
      const precedingText = paragraphs.slice(0, -1).join('\n\n');
      const hasMathOrTable = precedingText.includes('$$') || /^\s*\|.*\|/m.test(precedingText);
      const looksLikeTaskOpener = NON_PASSAGE_TASK_OPENER_REGEX.test(precedingText);
      const looksLikeQuestionPrompt =
        lastP.includes('?') ||
        QUESTION_PROMPT_START_REGEX.test(lastP);

      const meetsBodyThreshold =
        paragraphs.length >= 3
          ? precedingText.length >= 260
          : precedingText.length >= 350;

      if (looksLikeQuestionPrompt && meetsBodyThreshold && !hasMathOrTable && !looksLikeTaskOpener) {
        return {
          passageText: precedingText,
          promptText: lastP,
          explicitMode: 'none',
        };
      }
    }
  }

  return { passageText: null, promptText: clean, explicitMode: 'none' };
}

/**
 * Resolves an inherited reading passage from earlier questions on multi-question language sets.
 */
export function resolveInheritedStimulusPassage<T extends { question_text?: string | null }>(
  questions: T[],
  currentIndex: number,
  opts: {
    isLanguageExam: boolean;
    isCurrentStemOrMath: boolean;
    isQuestionStemOrMath: (q: T) => boolean;
    cleanStem?: (text: string, q: T) => string;
  }
): string | null {
  if (!opts.isLanguageExam || opts.isCurrentStemOrMath) return null;
  const currentQ = questions[currentIndex];
  if (!currentQ) return null;

  const currentRaw = currentQ.question_text || '';
  if (
    hasNoPassageDirective(currentRaw) ||
    hasExplicitPassageMarkers(currentRaw) ||
    /###\s*(?:Text|Passage|Reading|Stimulus|Wacana|Bacaan|Teks)(?:\s+[A-Za-z0-9]+)?\b/i.test(currentRaw)
  ) {
    return null;
  }

  for (let i = currentIndex - 1; i >= 0; i--) {
    const prevQ = questions[i];
    if (!prevQ || opts.isQuestionStemOrMath(prevQ)) break;

    const prevRaw = prevQ.question_text || '';
    if (hasNoPassageDirective(prevRaw)) continue;

    // 1. Prefer explicit `[passage]...[/passage]` on an earlier question
    const explicitPrev = prevRaw.match(EXPLICIT_PASSAGE_BLOCK_REGEX);
    if (explicitPrev && explicitPrev[1]?.trim()) {
      return stripPassageControlTags(explicitPrev[1]);
    }

    // 2. Otherwise check `### Text / Passage / Reading / Stimulus / Wacana / Bacaan / Teks` headers
    const cleanedPrev = opts.cleanStem ? opts.cleanStem(prevRaw, prevQ) : prevRaw;
    const strippedPrev = stripPassageControlTags(cleanedPrev);
    if (/###\s*(?:Text|Passage|Reading|Stimulus|Wacana|Bacaan|Teks)(?:\s+[A-Za-z0-9]+)?\b/i.test(strippedPrev)) {
      const splitPrev = splitExplicitMarkdownHeader(strippedPrev, true);
      if (splitPrev?.passageText) {
        return splitPrev.passageText;
      }
      // Fallback: header + body without a separated prompt paragraph
      const match = strippedPrev.match(
        /(###\s*(?:Text|Passage|Reading|Stimulus|Wacana|Bacaan|Teks)(?:\s+[A-Za-z0-9]+)?\b[\s\S]*?)(?=(?:\n\s*\d+\.|\n\s*\*\*Question|\n\s*Question\s*\d+|$))/i
      );
      if (match && match[1]) {
        return match[1].trim();
      }
    }
  }

  return null;
}
