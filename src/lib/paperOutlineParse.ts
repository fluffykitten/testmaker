/**
 * Deterministic Paper Outline — pure parsing layer (no pdfjs, no DOM, no network).
 *
 * Reads the PDF text layer as positioned glyph runs and recovers the printed
 * question / part / sub-part skeleton with its marks. This is the authoritative
 * structure handed to the extraction prompt; when it cannot be proven, the
 * caller must fall back to vision-only extraction.
 *
 * Everything is inferred per paper (font height, page bands, column positions)
 * — there are no per-paper constants. See paper5update.md §Phase 0.
 */

export type PageKind = 'cover' | 'question' | 'blank' | 'notes';

export interface RawTextItem {
  s: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RawPage {
  page: number;
  width: number;
  height: number;
  items: RawTextItem[];
}

export interface OutlineLeaf {
  id: string;            // "(a)", "(b)(ii)", "(f)(iii)"
  page: number;
  marks: number | null;  // null = section stem (no marks of its own) or unresolved
  isStem: boolean;       // has children printed underneath it
}

export interface OutlineQuestion {
  number: number;
  page: number;
  declaredTotal: number | null;  // printed "[Total: N]"
  stemMarks: number;             // marks attached to the question itself (e.g. Q3 [6])
  total: number;                 // stemMarks + Σ leaf marks
  subs: OutlineLeaf[];
  /** Printed section ("A", "B"), when the paper groups questions into sections. */
  section?: string;
}

export interface OutlinePage {
  index: number;
  kind: PageKind;
  /** First meaningful printed line — used as the title of a notes/insert page. */
  title?: string;
}

export type PaperFamily = 'practical-5x' | 'practical-6x' | 'structured' | 'mcq' | 'unknown';

export interface PaperProfile {
  key: string;          // "0620/53"
  syllabus: string;     // "0620"
  paperCode: string;    // "53"
  family: PaperFamily;
  totalMarks: number | null;
  questionCount: number | null;
  /** Candidate answers a subset; printed question marks exceed the paper total. */
  optionalChoice?: boolean;
  /** Question number → option-group label, for optional-choice papers. */
  optionGroups?: Record<number, string>;
}

export interface PaperOutline {
  profile: PaperProfile;
  columns: { question: number; part: number; roman: number };
  pages: OutlinePage[];
  questions: OutlineQuestion[];
  totalMarks: number | null;
  usable: boolean;
  reasons: string[];
}

export interface OutlineHint {
  fileName?: string;
}

const ROMAN_RE = /^\((i{1,3}|iv|v|vi{1,3})\)$/;
const PART_RE = /^\(([a-z])\)$/;
const QUESTION_RE = /^(\d{1,2})\s+([A-Z\u201c"(].*)$/;
const SCRIPT_RE = /^[\d+\-\u2013\u2014]{1,3}$/;
const MARK_RE = /\[(\d+)\]\s*$/;
const TOTAL_RE = /\[Total:\s*(\d+)\]/;

const ROMAN_ORDER = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii'];

/** Glyph runs that are page furniture, barcode debris or CMS artefacts. */
function isNoise(s: string, item: RawTextItem, page: RawPage): boolean {
  if (!s) return true;
  const t = s.trim();
  if (!t) return true;
  if (/DO NOT WRITE IN THIS MARGIN|\[Turn over|UCLES|^\*\s*\d{10,}\s*\*$/i.test(t)) return true;
  if (/^\d{4}\/\d{2}\/[A-Z]\/[A-Z]\/\d{2}$/.test(t)) return true;
  if (t === 'DFD' || t === ',') return true;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\uE000-\uF8FF]/.test(t)) return true;
  const high = [...t].filter((c) => c.charCodeAt(0) > 0x7f).length;
  if (high > 0 && high / t.length > 0.35) return true;
  // header/footer bands, expressed as fractions of the page (never fixed pixels)
  if (item.y > page.height * 0.955 || item.y < page.height * 0.045) return true;
  return false;
}

interface Line {
  y: number;
  x: number;
  right: number;
  h: number;
  text: string;
  items: RawTextItem[];
  pageIdx: number;
}

/** Cluster positioned glyph runs into visual lines for one page. */
function buildLines(page: RawPage): { lines: Line[]; bodyHeight: number } {
  const items = page.items
    .map((it) => ({ ...it, s: it.s.replace(/\u00AD/g, '') }))
    .filter((it) => !isNoise(it.s, it, page) && it.s.trim() !== '');

  const hist = new Map<number, number>();
  for (const it of items) {
    if (it.s.trim().length >= 3) hist.set(it.h, (hist.get(it.h) ?? 0) + 1);
  }
  const bodyHeight = [...hist.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 11;

  // Re-attach sub/superscripts that pdfjs emitted as separate runs (the 3 of cm3).
  const bodies = items.filter((i) => i.h >= bodyHeight - 2);
  const consumed = new Set<RawTextItem>();
  for (const it of items) {
    if (it.h >= bodyHeight - 1 || !SCRIPT_RE.test(it.s.trim())) continue;
    let best: RawTextItem | null = null;
    let bestScore = Infinity;
    for (const b of bodies) {
      const dy = it.y - b.y;
      if (dy === 0 || Math.abs(dy) > bodyHeight * 0.6) continue;
      const gap = it.x - (b.x + b.w);
      if (gap < -2 || gap > bodyHeight * 0.6) continue;
      const score = Math.abs(gap) + Math.abs(dy) * 0.5;
      if (score < bestScore) { bestScore = score; best = b; }
    }
    if (best) { best.s += it.s.trim(); best.w += it.w; consumed.add(it); }
  }

  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Line[] = [];
  for (const it of items) {
    if (consumed.has(it)) continue;
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= Math.max(2, bodyHeight * 0.3)) last.items.push(it);
    else lines.push({ y: it.y, x: it.x, right: 0, h: it.h, text: '', items: [it], pageIdx: page.page });
  }

  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
    line.x = line.items[0].x;
    line.right = Math.max(...line.items.map((i) => i.x + i.w));
    line.h = Math.max(...line.items.map((i) => i.h));
    let text = '';
    let prev: RawTextItem | null = null;
    for (const it of line.items) {
      if (prev && it.x - (prev.x + prev.w) > 1.2) text += ' ';
      text += it.s;
      prev = it;
    }
    line.text = text.replace(/\s+/g, ' ').trim();
  }

  // A superscript that landed on its own visual line rejoins the line above it.
  const kept: Line[] = [];
  for (const line of lines) {
    const prev = kept[kept.length - 1];
    if (
      prev &&
      line.items.every((i) => i.h < bodyHeight - 1) &&
      SCRIPT_RE.test(line.text) &&
      prev.y - line.y <= bodyHeight
    ) {
      prev.items.push(...line.items);
      prev.text += line.text;
      continue;
    }
    kept.push(line);
  }

  return {
    lines: kept.filter((l) => l.h >= bodyHeight - 1 && l.y < page.height * 0.95),
    bodyHeight,
  };
}

function mode(values: number[]): number | null {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) { best = value; bestCount = count; }
  }
  return best;
}

function classifyPage(index: number, lines: Line[]): PageKind {
  const text = lines.map((l) => l.text).join(' ');
  // A blank page prints the words "BLANK PAGE" on their own line. Match the line,
  // not the page text: the cover says "Any blank pages are indicated".
  if (lines.some((l) => /^BLANK PAGE$/i.test(l.text.trim()))) return 'blank';
  if (index === 1 || /You must answer on the question paper/i.test(text)) return 'cover';
  if (/Notes for use in qualitative analysis/i.test(text)) return 'notes';
  if (/Tests for anions|Tests for aqueous cations|Tests for gases|Flame tests for metal ions/i.test(text)) return 'notes';
  return 'question';
}

function detectProfile(coverText: string, hint?: OutlineHint): PaperProfile {
  const fromCover = coverText.match(/(\d{4})\s*\/\s*(\d{2})/);
  const fromName = hint?.fileName?.match(/(\d{4})[^\n\r]{0,60}?(?:_|\s|paper\s*|p)(\d{2})(?:\D|$)/i);
  const m = fromCover ?? fromName ?? null;
  const syllabus = m?.[1] ?? '';
  const paperCode = m?.[2] ?? '';
  const family = paperFamily(syllabus, paperCode, coverText, hint);
  return {
    key: m ? `${syllabus}/${paperCode}` : 'unknown',
    syllabus,
    paperCode,
    family,
    totalMarks: null,
    questionCount: null,
  };
}

/**
 * Paper 1/2 are multiple choice in the sciences (0620, 0625, 0610) and Economics (0455),
 * but 80-mark written papers in Sociology (0495), so the paper-code digit alone cannot
 * decide the family. Explicit cover titles and syllabus registry rules take precedence.
 */
function paperFamily(syllabus: string, paperCode: string, coverText: string = '', hint?: OutlineHint): PaperFamily {
  if (paperCode.startsWith('5')) return 'practical-5x';
  if (paperCode.startsWith('6')) return 'practical-6x';
  const textHaystack = [coverText, hint?.fileName ?? ''].join(' ');
  if (/Multiple\s+Choice/i.test(textHaystack) || /four\s+possible\s+answers/i.test(textHaystack) || /\bmcq\b/i.test(textHaystack)) return 'mcq';
  if (/Structured\s+Questions/i.test(textHaystack)) return 'structured';

  const isScience = /^(0620|0625|0610|0653|0654|9701|9702|9700)/.test(syllabus);
  if (isScience) {
    return /^[12]/.test(paperCode) ? 'mcq' : 'structured';
  }

  // Commercial / Humanities syllabi where Paper 1 is Multiple Choice
  const isMcqP1 = /^(0455|0450|0452|2281|7115|7707)/.test(syllabus);
  if (isMcqP1 && paperCode.startsWith('1')) return 'mcq';

  // Written structured papers (Sociology, Geography, History)
  return 'structured';
}

function idOrder(id: string): [number, number] | null {
  const m = id.match(/^\(([a-z])\)(?:\(([ivx]+)\))?$/);
  if (!m) return null;
  const letter = m[1].charCodeAt(0) - 97;
  const roman = m[2] ? ROMAN_ORDER.indexOf(m[2]) : -1;
  return [letter, roman];
}

/**
 * Recover the printed question/sub-part skeleton with marks.
 * Pure: feed it positioned text runs from any PDF reader.
 */
export function parseOutline(pages: RawPage[], hint?: OutlineHint): PaperOutline {
  const pageKinds: OutlinePage[] = [];
  const questionPages: { page: RawPage; lines: Line[]; width: number }[] = [];
  let coverText = '';

  for (const page of pages) {
    const { lines } = buildLines(page);
    const kind = classifyPage(page.page, lines);
    const title = kind === 'notes' || kind === 'cover'
      ? (lines.find((l) => l.text.trim().length > 3)?.text ?? '').slice(0, 160)
      : undefined;
    pageKinds.push({ index: page.page, kind, title });
    if (kind === 'cover') coverText += ' ' + lines.map((l) => l.text).join(' ');
    if (kind === 'question' && lines.length) {
      questionPages.push({ page, lines, width: page.width });
    }
  }

  const profile = detectProfile(coverText, hint);
  const totalMarkMatch = coverText.match(/total mark for this paper is (\d+)/i);
  const totalMarks = totalMarkMatch ? Number(totalMarkMatch[1]) : null;
  profile.totalMarks = totalMarks;

  // Optional-choice papers let the candidate answer a subset ("Answer two questions in
  // total: Answer Question 1. Answer either Question 2 or Question 3."), so the printed
  // question marks legitimately exceed the paper total. That is not a parse failure.
  const optionalChoice =
    /Answer\s+either\s+Question\s+\d+\s+or\s+Question\s+\d+/i.test(coverText) ||
    /Answer\s+(?:one|two|three|four|\d+)\s+questions\b/i.test(coverText) ||
    /Answer\s+one\s+question\s+from\s+each\s+section/i.test(coverText);
  profile.optionalChoice = optionalChoice;

  // ---- column inference (per paper, never hardcoded) ----
  const qXs: number[] = [];
  const partXs: number[] = [];
  const romanXs: number[] = [];
  for (const { lines } of questionPages) {
    for (const line of lines) {
      const first = line.items[0]?.s.trim() ?? '';
      if (QUESTION_RE.test(line.text) && line.x < 130) {
        qXs.push(line.x);
        const second = line.items[1]?.s.trim() ?? '';
        if (PART_RE.test(second)) partXs.push(line.items[1].x);
      }
      if (PART_RE.test(first)) partXs.push(line.x);
      if (ROMAN_RE.test(first)) romanXs.push(line.x);
    }
  }
  const questionCol = mode(qXs) ?? 50;
  const partCol = mode(partXs.filter((x) => x >= questionCol - 2)) ?? questionCol + 22;
  const romanCol = mode(romanXs.filter((x) => x > partCol + 4)) ?? partCol + 22;
  const near = (x: number, col: number, tol = 9) => Math.abs(x - col) <= tol;

  // ---- walk the paper ----
  const questions: OutlineQuestion[] = [];
  let current: OutlineQuestion | null = null;
  let currentPart: string | null = null;
  let currentLeaf: OutlineLeaf | null = null;
  let currentSection: string | null = null;

  for (const { lines, width } of questionPages) {
    for (const line of lines) {
      // "Section A" / "Section B" headings group questions for optional-choice papers.
      const sectionMatch = line.text.match(/^Section\s+([A-Z])\b/);
      if (sectionMatch) {
        currentSection = sectionMatch[1];
        continue;
      }

      const questionMatch = line.text.match(QUESTION_RE);
      if (questionMatch && near(line.x, questionCol)) {
        const isMcq = profile.family === 'mcq';
        current = {
          number: Number(questionMatch[1]),
          page: line.pageIdx,
          declaredTotal: null,
          stemMarks: isMcq ? 1 : 0,
          total: isMcq ? 1 : 0,
          subs: [],
          section: currentSection ?? undefined,
        };
        questions.push(current);
        currentPart = null;
        currentLeaf = null;

        // AS/A Level and Economics papers pack the first sub-part onto the question line —
        // "4 (a) (i) Define … [4]" (AS Geography) or "1 (a) Calculate … [1]" (Economics).
        const inlineCompound = questionMatch[2].match(/^\(([a-h])\)\s*\(\s*(i{1,3}|iv|v|vi{1,3})\s*\)/);
        const inlineSimple = !inlineCompound ? questionMatch[2].match(/^\(([a-h])\)\s+(?!\()/) : null;
        if (inlineCompound) {
          const inlineMarks = line.text.match(MARK_RE);
          const marks = inlineMarks && line.right > width * 0.86 ? Number(inlineMarks[1]) : null;
          currentPart = inlineCompound[1];
          currentLeaf = { id: `(${inlineCompound[1]})(${inlineCompound[2]})`, page: line.pageIdx, marks, isStem: false };
          current.subs.push(currentLeaf);
        } else if (inlineSimple) {
          const inlineMarks = line.text.match(MARK_RE);
          const marks = inlineMarks && line.right > width * 0.86 ? Number(inlineMarks[1]) : null;
          currentPart = inlineSimple[1];
          currentLeaf = { id: `(${inlineSimple[1]})`, page: line.pageIdx, marks, isStem: false };
          current.subs.push(currentLeaf);
        }
        continue;
      }
      if (!current) continue;

      const totalMatch = line.text.match(TOTAL_RE);
      if (totalMatch) {
        current.declaredTotal = Number(totalMatch[1]);
        continue;
      }

      const tokens = line.items.map((i) => i.s.trim()).filter(Boolean);
      const tok0 = tokens[0] ?? '';
      let part: string | null = null;
      let roman: string | null = null;

      // "(i)" is ambiguous: a part letter in papers running (a)…(k), a roman
      // numeral in others. The inferred column decides, never the regex.
      if (PART_RE.test(tok0) && near(line.x, partCol)) {
        part = tok0.match(PART_RE)![1];
        if (tokens[1] && ROMAN_RE.test(tokens[1]) && near(line.items[1].x, romanCol)) {
          roman = tokens[1].match(ROMAN_RE)![1];
        }
      } else if (ROMAN_RE.test(tok0) && near(line.x, romanCol)) {
        roman = tok0.match(ROMAN_RE)![1];
      }

      const markMatch = line.text.match(MARK_RE);
      const marks = markMatch && line.right > width * 0.86 ? Number(markMatch[1]) : null;

      if (part) {
        currentPart = part;
        if (!roman) currentLeaf = null;
      } else if (roman && !currentPart) {
        // Some papers print "Define the term: (a)" above "(i) …", orphaning the roman
        // numerals. They belong to part (a), not to a dangling "(i)".
        currentPart = 'a';
      }

      if (part || roman) {
        const id = part
          ? (roman ? `(${part})(${roman})` : `(${part})`)
          : `(${currentPart})(${roman})`;
        currentLeaf = { id, page: line.pageIdx, marks, isStem: false };
        current.subs.push(currentLeaf);
        continue;
      }

      if (marks !== null) {
        if (currentLeaf && currentLeaf.marks === null) currentLeaf.marks = marks;
        else if (current.subs.length === 0) current.stemMarks += marks;
        else current.subs.push({ id: `${currentLeaf?.id ?? ''}*`, page: line.pageIdx, marks, isStem: false });
      }
    }
  }

  // ---- section stems: a leaf with no marks that has roman children under it ----
  for (const q of questions) {
    for (let i = 0; i < q.subs.length; i++) {
      const leaf = q.subs[i];
      if (leaf.marks !== null) continue;
      const hasChild = q.subs.slice(i + 1).some((s) => s.id.startsWith(`${leaf.id}(`));
      leaf.isStem = hasChild;
    }
    q.total = q.stemMarks + q.subs.reduce((sum, s) => sum + (s.marks ?? 0), 0);
  }

  // ---- optional-choice grouping ----
  // Record which questions are alternatives so the question bank and test builder do not
  // silently place two mutually exclusive questions in one paper.
  if (optionalChoice) {
    // Two-tier papers state the rule per section: "Section A: answer all questions / answer Question 1.
    // Section B: answer one question / answer three questions." The section headings printed in the body
    // decide which questions belong to the optional group.
    const sectionACompulsory =
      /Section\s+A\s*:?\s*(?:answer\s+)?(?:all\s+questions|Question\s+1\b)/i.test(coverText);
    const sectionBOptionalMatch = coverText.match(
      /Section\s+B\s*:?\s*(?:answer\s+)?(one|two|three|four|\d+)\s+question/i,
    );
    const either = coverText.match(
      /Answer\s+Question\s+(\d+)[\s\S]{0,60}?either\s+Question\s+(\d+)\s+or\s+Question\s+(\d+)/i,
    );
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4 };

    const oneFromEachSection = /one\s+(?:question\s+)?from\s+each\s+section/i.test(coverText);

    if (oneFromEachSection) {
      const groups: Record<number, string> = {};
      const sections = [...new Set(questions.map((q) => q.section).filter(Boolean))];
      for (const sec of sections) {
        const secQuestions = questions.filter((q) => q.section === sec);
        if (secQuestions.length > 1) {
          const label = `Section ${sec}: choose 1 of ${secQuestions.length} (Q${secQuestions[0].number}–Q${secQuestions[secQuestions.length - 1].number})`;
          for (const q of secQuestions) {
            groups[q.number] = label;
          }
        }
      }
      profile.optionGroups = groups;
    } else if (sectionACompulsory && sectionBOptionalMatch) {
      const bCount = words[sectionBOptionalMatch[1].toLowerCase()] ?? Number(sectionBOptionalMatch[1]);
      const optionalQuestions = questions.filter((q) => q.section === 'B');
      if (optionalQuestions.length) {
        const label = `Section B: choose ${bCount} of ${optionalQuestions.length} (Q${optionalQuestions[0].number}–Q${optionalQuestions[optionalQuestions.length - 1].number})`;
        profile.optionGroups = Object.fromEntries(optionalQuestions.map((q) => [q.number, label]));
      }
    } else if (either) {
      const label = `Optional: answer either Question ${either[2]} or Question ${either[3]}`;
      profile.optionGroups = { [Number(either[2])]: label, [Number(either[3])]: label };
    } else {
      const countMatch = coverText.match(/Answer\s+(one|two|three|four|\d+)\s+questions\b/i);
      const count = countMatch ? words[countMatch[1].toLowerCase()] ?? Number(countMatch[1]) : null;
      if (count && count < questions.length) {
        const label = `Optional: answer ${count} of ${questions.length}`;
        profile.optionGroups = Object.fromEntries(questions.map((q) => [q.number, label]));
      }
    }
  }

  // ---- gate ----
  const reasons: string[] = [];
  if (questions.length === 0) reasons.push('no question anchors found');
  // ids are only required to be unique *within* a question: every question restarts at (a).
  for (const q of questions) {
    const ids = q.subs.map((s) => s.id);
    if (new Set(ids).size !== ids.length) reasons.push(`duplicate sub-question ids in Q${q.number}`);
    if (ids.some((id) => id.includes('*'))) reasons.push(`unattributed marks in Q${q.number}`);
    if (q.declaredTotal !== null && q.total !== q.declaredTotal) {
      reasons.push(`Q${q.number} marks ${q.total} != printed total ${q.declaredTotal}`);
    }
  }
  for (const q of questions) {
    let prev: [number, number] | null = null;
    for (const leaf of q.subs) {
      const order = idOrder(leaf.id);
      if (!order) continue;
      if (prev && (order[0] < prev[0] || (order[0] === prev[0] && order[1] <= prev[1]))) {
        reasons.push(`non-monotonic ids in Q${q.number}`);
        break;
      }
      prev = order;
    }
  }
  const sum = questions.reduce((a, q) => a + q.total, 0);
  const optionalSumAccepted = optionalChoice && totalMarks !== null && sum > totalMarks;
  if (totalMarks !== null && sum !== totalMarks && !optionalSumAccepted) {
    reasons.push(`marks sum ${sum} != printed total ${totalMarks}`);
  }
  if (profile.family === 'practical-5x' && questions.length !== 3) {
    reasons.push(`expected 3 questions for ${profile.key}, found ${questions.length}`);
  }
  profile.questionCount = questions.length;

  return {
    profile,
    columns: { question: questionCol, part: partCol, roman: romanCol },
    pages: pageKinds,
    questions,
    totalMarks,
    usable: reasons.length === 0,
    reasons,
  };
}

/** Flatten to the compact, prompt-ready form used by the extraction call. */
export function outlineToPromptText(outline: PaperOutline): string {
  return outline.questions
    .map((q) => {
      const subs = q.subs
        .map((s) => {
          if (s.marks !== null) return `${s.id}[${s.marks}]`;
          return s.isStem ? `${s.id} (section stem — no sub-question)` : s.id;
        })
        .join(' ');
      const total = q.declaredTotal ?? q.total;
      return subs
        ? `Q${q.number}: ${subs}    (total ${total})`
        : `Q${q.number}: no sub-parts    (total ${total})`;
    })
    .join('\n');
}

/** The sub-parts the extractor must return, in printed order (section stems excluded). */
export function expectedSubIds(outline: PaperOutline): Record<number, string[]> {
  const map: Record<number, string[]> = {};
  for (const q of outline.questions) {
    map[q.number] = q.subs.filter((s) => !s.isStem).map((s) => s.id);
  }
  return map;
}

