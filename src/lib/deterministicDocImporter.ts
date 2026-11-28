import JSZip from 'jszip';
import type { ExtractedPassage, ExtractedQuestion, ExtractionResult } from '../types/database';
import { containsArabicScript } from './arabicTextUtils';

export function isStructuredDocFile(file: { name?: string; type?: string } | null | undefined): boolean {
  if (!file) return false;
  const name = (file.name || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  return (
    name.endsWith('.docx') ||
    name.endsWith('.html') ||
    name.endsWith('.htm') ||
    type === 'text/html' ||
    type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
}

function easternDigitsToWestern(str: string): string {
  return str.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));
}

function decodeHtmlAndXmlEntities(str: string): string {
  return str
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function stripTagsPreservingLines(fragment: string): string {
  return decodeHtmlAndXmlEntities(
    fragment
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:div|p|li|tr|h[1-6]|article|section)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTotalMarksAndCleanStem(rawStem: string): { stem: string; totalMarks: number } {
  let totalMarks = 1;
  const markMatch = rawStem.match(/\[\s*Total\s*:\s*(\d+(?:\.\d+)?)\s*\]/i);
  if (markMatch) {
    totalMarks = Number(markMatch[1]) || 1;
  }
  const stem = rawStem.replace(/\[\s*Total\s*:\s*\d+(?:\.\d+)?\s*\]/gi, '').trim();
  return { stem, totalMarks };
}

function expandTargetRangeFromText(text: string): string[] {
  const norm = easternDigitsToWestern(text);
  const m = norm.match(/(\d{1,3})\s*[–\-—]\s*(\d{1,3})/);
  if (!m) return [];
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start || end - start > 60) return [];
  return Array.from({ length: end - start + 1 }, (_, i) => String(start + i));
}

function inferSubjectAndMeta(combinedText: string, fileName?: string): ExtractionResult['paper_metadata'] {
  const hasAr = containsArabicScript(combinedText);
  return {
    subject: hasAr ? 'Arabic' : 'General',
    subject_code: hasAr ? 'BAR' : 'GEN',
    year: new Date().getFullYear(),
    series: fileName ? 'Imported Document' : 'General',
    paper_number: 1,
    has_insert_booklet: false,
  };
}

const OPTION_LINE_RE = /^\s*((?:أ|إ|آ|ا|ب|ج|د|هـ|ه|[A-H]))\s*[.)]\s+([\s\S]+)$/;
const QUESTION_START_RE = /^\s*(?:SOAL\s+NO\s*|Question\s*)?([0-9٠-٩]{1,3})\s*[.):\-]\s+([\s\S]*)$/i;
const PASSAGE_HEADER_RE = /^(?:اقرأ الن[ّ]?ص[ّ]?|الح[ِ]?و[َ]?ار|Teks untuk|Read the following)/i;

/**
 * Parses clean HTML exported from TestMaker clean templates (.q-card / .writing-item / .passage-box)
 * or falls back to plain-line deterministic parsing for arbitrary HTML files.
 */
export function parseStructuredHtmlExam(html: string, fileName?: string): ExtractionResult {
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');
  const mainMatch = withoutScripts.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const cleanedHtml = mainMatch ? mainMatch[1] : withoutScripts;

  const blockMatches = [
    ...cleanedHtml.matchAll(/<(section|article)\s+class=["'][^"']*\b(passage-box|q-card|writing-item)\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/gi),
  ];

  if (blockMatches.length === 0) {
    const plain = stripTagsPreservingLines(cleanedHtml);
    return parsePlainLinesToExtractionResult(plain.split(/\r?\n/), fileName);
  }

  const passages: ExtractedPassage[] = [];
  const questions: ExtractedQuestion[] = [];
  let passageCounter = 0;
  let sharedWritingInstruction = '';

  for (const m of blockMatches) {
    const kind = m[2].toLowerCase();
    const inner = m[3];

    if (kind === 'passage-box') {
      passageCounter++;
      const headingMatch = inner.match(/<div\s+class=["']passage-heading["'][^>]*>([\s\S]*?)<\/div>/i);
      const heading = headingMatch ? stripTagsPreservingLines(headingMatch[1]) : `Passage ${passageCounter}`;
      const bodyRaw = headingMatch ? inner.replace(headingMatch[0], '') : inner;
      const body = stripTagsPreservingLines(bodyRaw);
      const targets = expandTargetRangeFromText(heading);
      passages.push({
        id: targets.length > 0 ? `Passage Q${targets[0]}-${targets[targets.length - 1]}` : `Passage ${passageCounter}`,
        heading,
        body,
        page_number: 1,
        target_questions: targets,
      });
      continue;
    }

    // Remove .img-note before extracting stem/options
    const withoutNotes = inner.replace(/<div\s+class=["']img-note["'][^>]*>[\s\S]*?<\/div>/gi, '');
    const numMatch = withoutNotes.match(/<span\s+class=["']q-num["'][^>]*>([\s\S]*?)<\/span>/i);
    const qNumRaw = numMatch ? stripTagsPreservingLines(numMatch[1]).replace(/\.$/, '').trim() : '';
    const qNum = easternDigitsToWestern(qNumRaw);

    const stemMatch = withoutNotes.match(/<div\s+class=["']q-stem["'][^>]*>([\s\S]*?)<\/div>/i);
    const stemRaw = stemMatch ? stripTagsPreservingLines(stemMatch[1]) : '';

    if (kind === 'writing-item' && !qNum) {
      sharedWritingInstruction = stemRaw;
      continue;
    }

    let qText = stemRaw;
    if (qNum) {
      const escapedNum = qNumRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      qText = qText.replace(new RegExp(`^${escapedNum}\\s*[.)]?\\s*`), '').trim();
    }

    if (kind === 'writing-item' && !stemMatch) {
      const fullText = stripTagsPreservingLines(withoutNotes);
      const stripped = qNum
        ? fullText.replace(new RegExp(`^${qNumRaw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[.)]?\\s*`), '').trim()
        : fullText;
      qText = sharedWritingInstruction ? `${sharedWritingInstruction}\n${stripped}` : stripped;
    }

    const scrambleMatch = withoutNotes.match(/<div\s+class=["']scramble-words["'][^>]*>([\s\S]*?)<\/div>/i);
    if (scrambleMatch) {
      qText = `${qText}\n\n${stripTagsPreservingLines(scrambleMatch[1])}`.trim();
    }

    const { stem: cleanStem, totalMarks } = extractTotalMarksAndCleanStem(qText);

    const optionsBlock = withoutNotes.match(/<div\s+class=["']options[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*$/i);
    const options: string[] = [];
    if (optionsBlock) {
      for (const optDiv of optionsBlock[1].matchAll(/<div(?:\s+[^>]*)?>([\s\S]*?)<\/div>/gi)) {
        const optText = stripTagsPreservingLines(optDiv[1]);
        if (optText) options.push(optText);
      }
    }

    if (!qNum && !cleanStem) continue;
    const questionNumber = qNum || String(questions.length + 1);
    const linkedPassage = passages.find((p) => p.target_questions?.includes(questionNumber));

    questions.push({
      question_number: questionNumber,
      parent_question_id: null,
      page_number: 1,
      question_text: cleanStem,
      question_style: options.length >= 2 ? 'Multiple Choice' : 'Short Answer',
      total_marks: totalMarks,
      estimated_difficulty: 'Medium',
      topic: 'Arabic',
      sub_topic: null,
      has_diagram: false,
      bounding_box: null,
      options: options.length >= 2 ? options : null,
      mark_scheme: null,
      passage_ref: linkedPassage ? linkedPassage.id : null,
    });
  }

  const allText = [
    ...passages.map((p) => `${p.heading}\n${p.body}`),
    ...questions.map((q) => q.question_text),
  ].join('\n');

  return {
    paper_metadata: inferSubjectAndMeta(allText, fileName),
    questions,
    passages: passages.length > 0 ? passages : undefined,
  };
}

/**
 * Deterministic line-based parser for Word (.docx) paragraphs and plain text exams.
 * Preserves every character and harakah verbatim without AI re-typing.
 */
export function parsePlainLinesToExtractionResult(rawLines: string[], fileName?: string): ExtractionResult {
  const lines = rawLines.map((l) => l.trim()).filter(Boolean);
  const passages: ExtractedPassage[] = [];
  const questions: ExtractedQuestion[] = [];

  let activePassage: ExtractedPassage | null = null;
  let collectingPassage = false;
  let currentQ: ExtractedQuestion | null = null;

  const flushQuestion = () => {
    if (!currentQ) return;
    const { stem, totalMarks } = extractTotalMarksAndCleanStem(currentQ.question_text);
    currentQ.question_text = stem;
    currentQ.total_marks = totalMarks;
    currentQ.question_style = currentQ.options && currentQ.options.length >= 2 ? 'Multiple Choice' : 'Short Answer';
    questions.push(currentQ);
    currentQ = null;
  };

  for (const line of lines) {
    if (/^\[?\s*Turn over\s*\]?$/i.test(line)) continue;
    if (/^\[Total:\s*\d+\]$/i.test(line) && currentQ) {
      currentQ.question_text = `${currentQ.question_text} ${line}`.trim();
      continue;
    }

    if (PASSAGE_HEADER_RE.test(line)) {
      flushQuestion();
      collectingPassage = true;
      const targets = expandTargetRangeFromText(line);
      activePassage = {
        id: targets.length > 0 ? `Passage Q${targets[0]}-${targets[targets.length - 1]}` : `Passage ${passages.length + 1}`,
        heading: line,
        body: '',
        page_number: 1,
        target_questions: targets,
      };
      passages.push(activePassage);
      continue;
    }

    const qMatch = line.match(QUESTION_START_RE);
    if (qMatch) {
      const qNum = easternDigitsToWestern(qMatch[1]);
      // Avoid splitting sub-bullets (e.g. "١. ..." when inside an active non-MCQ writing stem)
      const isSubBulletInNonMcq =
        currentQ &&
        (!currentQ.options || currentQ.options.length === 0) &&
        Number(qNum) <= 6 &&
        Number(currentQ.question_number) > 10;

      if (!isSubBulletInNonMcq) {
        collectingPassage = false;
        flushQuestion();
        const currentPassage: ExtractedPassage | null = activePassage;
        const linked: ExtractedPassage | null =
          currentPassage && (currentPassage.target_questions?.length === 0 || currentPassage.target_questions?.includes(qNum))
            ? currentPassage
            : passages.find((p) => p.target_questions?.includes(qNum)) || null;
        if (linked && linked.target_questions && !linked.target_questions.includes(qNum) && linked === currentPassage) {
          linked.target_questions.push(qNum);
        }
        currentQ = {
          question_number: qNum,
          parent_question_id: null,
          page_number: 1,
          question_text: qMatch[2].trim(),
          question_style: 'Short Answer',
          total_marks: 1,
          estimated_difficulty: 'Medium',
          topic: 'Arabic',
          sub_topic: null,
          has_diagram: false,
          bounding_box: null,
          options: [],
          mark_scheme: null,
          passage_ref: linked ? linked.id : null,
        };
        continue;
      }
    }

    if (collectingPassage && activePassage) {
      activePassage.body = activePassage.body ? `${activePassage.body}\n${line}` : line;
      continue;
    }

    const optMatch = line.match(OPTION_LINE_RE);
    if (optMatch && currentQ) {
      currentQ.options = [...(currentQ.options || []), line];
      continue;
    }

    if (currentQ) {
      currentQ.question_text = currentQ.question_text ? `${currentQ.question_text}\n${line}` : line;
    }
  }

  flushQuestion();

  const nonEmptyPassages = passages.filter((p) => p.body.trim().length > 0);
  const validIds = new Set(nonEmptyPassages.map((p) => p.id));
  for (const q of questions) {
    if (q.passage_ref && !validIds.has(q.passage_ref)) q.passage_ref = null;
  }

  return {
    paper_metadata: inferSubjectAndMeta(lines.join('\n'), fileName),
    questions,
    passages: nonEmptyPassages.length > 0 ? nonEmptyPassages : undefined,
  };
}

/**
 * Extracts exact Unicode paragraphs from a Word (.docx) file directly via JSZip
 * and parses numbered questions + options without any AI call.
 */
export async function parseStructuredDocxExam(
  bytes: Uint8Array | ArrayBuffer,
  fileName?: string
): Promise<ExtractionResult> {
  const zip = await JSZip.loadAsync(bytes);
  const docFile = zip.file('word/document.xml');
  if (!docFile) {
    throw new Error('Invalid .docx file: missing word/document.xml');
  }
  const xml = await docFile.async('string');
  const paragraphs: string[] = [];

  for (const pMatch of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const pXml = pMatch[1]
      .replace(/<w:tab\s*\/>/g, ' ')
      .replace(/<w:br\b[^>]*\/>/g, '\n');
    const runs: string[] = [];
    for (const tMatch of pXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)) {
      runs.push(decodeHtmlAndXmlEntities(tMatch[1]));
    }
    const text = runs.join('').trim();
    if (text) {
      paragraphs.push(...text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    }
  }

  return parsePlainLinesToExtractionResult(paragraphs, fileName);
}

export async function importStructuredDocumentDeterministically(file: File): Promise<ExtractionResult> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.docx') || file.type.includes('wordprocessingml')) {
    const buf = await file.arrayBuffer();
    return parseStructuredDocxExam(buf, file.name);
  }
  const html = await file.text();
  return parseStructuredHtmlExam(html, file.name);
}
