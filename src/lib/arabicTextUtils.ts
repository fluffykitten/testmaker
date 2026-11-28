/**
 * Utilities for detecting, normalizing, and guiding extraction of Arabic script
 * (including Qur'an/Hadis diacritics, tajwid excerpts, and mixed Arabic + Latin/Indonesian text).
 *
 * Pure module (no DOM, no pdfjs) so both browser UI and Node verification scripts can import it.
 */

export const ARABIC_ANY_CHAR_RE =
  /[\u0600-\u06FF\u0750-\u077F\u0870-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

const ARABIC_PRESENTATION_FORM_RUN_RE = /[\uFB50-\uFDFF\uFE70-\uFEFF]+/g;

// Explicit Unicode BiDi embedding/override controls that can scramble mixed prose when copied from PDFs
const EXPLICIT_BIDI_CONTROL_RE = /[\u202A-\u202E\u2066-\u2069]/g;

// Detached combining harakat/diacritics separated by horizontal space from their preceding Arabic letter
// e.g. PDF ToUnicode CMap artifacts like "خَلْق ِ السَّمَاوَات" or "أَن ْ" -> "خَلْقِ السَّمَاوَات", "أَنْ"
const DETACHED_HARAKAT_RE =
  /([\u0621-\u064A\u066E-\u06D3\u06D5\u06EE-\u06EF])[ \t]+([\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]+)/g;

export function containsArabicScript(text: string): boolean {
  if (!text || typeof text !== 'string') return false;
  return ARABIC_ANY_CHAR_RE.test(text);
}

/**
 * Normalizes Arabic text extracted from PDFs or pasted from external editors:
 * 1. Converts ONLY Arabic Presentation Forms (U+FB50–U+FEFF) back to canonical logical Unicode
 *    (U+0600–U+06FF) via selective NFKC, leaving math superscripts/fractions untouched.
 * 2. Strips stale Unicode BiDi override control characters that break browser <bdi> isolation.
 * 3. Reattaches stray horizontal spaces between an Arabic base letter and its combining harakat.
 */
export function normalizeExtractedArabicText(text: string): string {
  if (!text || typeof text !== 'string') return text || '';
  if (!containsArabicScript(text) && !EXPLICIT_BIDI_CONTROL_RE.test(text)) {
    return text;
  }

  return text
    .replace(EXPLICIT_BIDI_CONTROL_RE, '')
    .replace(ARABIC_PRESENTATION_FORM_RUN_RE, (seq) => seq.normalize('NFKC'))
    .replace(DETACHED_HARAKAT_RE, '$1$2');
}

const ARABIC_INLINE_MOJIBAKE_RE =
  /[\u0621-\u064A\u064B-\u065F][a-z?$%<>~\\|`]|(?:^|[\s])[a-z?$%<>~\\|`][\u0621-\u064A]|[\u0621-\u064A][a-z?$%<>~\\|`][\u0621-\u064A]/i;
const ORPHANED_TOKEN_INITIAL_HARAKAT_RE = /(?:^|\s)[\u064B-\u065F\u0670]/;
const ARABIC_TOKEN_RE = /[\u0621-\u064A\u064B-\u065F\u0670]+/g;
const ALLOWED_SINGLE_ARABIC_TOKENS = new Set(['و', 'أ', 'ب', 'ج', 'د', 'ه']);

/**
 * Detects whether an extracted PDF text page contains Arabic ToUnicode CMap corruption
 * (Presentation Forms, detached/orphaned harakat, inline ASCII mojibake, or fragmented ligatures).
 * Clean UTF-8 Arabic PDFs (e.g. browser-printed HTML or modern Word exports) return `false`
 * so extraction uses their exact Unicode text layer instead of error-prone PNG vision OCR.
 */
export function hasCorruptedArabicTextLayer(pageText: string): boolean {
  if (!pageText || !containsArabicScript(pageText)) return false;

  if (new RegExp(ARABIC_PRESENTATION_FORM_RUN_RE.source).test(pageText)) return true;
  if (new RegExp(DETACHED_HARAKAT_RE.source).test(pageText)) return true;
  if (ORPHANED_TOKEN_INITIAL_HARAKAT_RE.test(pageText)) return true;
  if (ARABIC_INLINE_MOJIBAKE_RE.test(pageText)) return true;

  const tokens = pageText.match(ARABIC_TOKEN_RE) || [];
  if (tokens.length >= 12) {
    let singleBaseCount = 0;
    for (const tok of tokens) {
      const stripped = tok.replace(/[\u064B-\u065F\u0670]/g, '');
      if (stripped.length === 1 && !ALLOWED_SINGLE_ARABIC_TOKENS.has(stripped)) {
        singleBaseCount++;
      }
    }
    if (singleBaseCount / tokens.length >= 0.35) {
      return true;
    }
  }

  return false;
}

const ARABIC_BASE_LETTER_RE = /[\u0621-\u064A]/g;
const ARABIC_COMBINING_HARAKAT_RE = /[\u064B-\u065F\u0670]/g;
const ARABIC_LAM_SUKUN_RE = /\u0627\u0644\u0652/g;
const OPTION_PREFIX_STRIP_RE = /^(?:[أإآابجدهو]|[A-H])[.):\s-]+/i;

/**
 * Audits an extracted Arabic question + options for signs of AI over-diacritization
 * ("auto-tashkil"), duplicate auto-corrected distractors, or detached/corrupted encoding
 * so non-Arabic speakers can immediately spot extractions that warrant visual PDF comparison.
 */
export function auditArabicQuestionFidelity(question: {
  question_text?: string | null;
  options?: string[] | null;
}): { status: 'ok' | 'warning'; issues: string[] } {
  const issues: string[] = [];
  const rawParts: string[] = [];

  if (typeof question?.question_text === 'string' && question.question_text.trim()) {
    rawParts.push(question.question_text);
  }
  const rawOptions = Array.isArray(question?.options) ? question.options : [];
  for (const opt of rawOptions) {
    if (typeof opt === 'string' && opt.trim()) rawParts.push(opt);
  }

  const combined = rawParts.join('\n');
  if (!containsArabicScript(combined)) {
    return { status: 'ok', issues: [] };
  }

  // Check 1: Duplicate MCQ option bodies (AI may have normalized away a subtle distractor)
  if (rawOptions.length >= 2) {
    const normalizedBodies = rawOptions
      .map((opt) =>
        String(opt || '')
          .trim()
          .replace(OPTION_PREFIX_STRIP_RE, '')
          .replace(/\s+/g, ' ')
          .trim()
      )
      .filter(Boolean);
    if (new Set(normalizedBodies).size < normalizedBodies.length) {
      issues.push('Duplicate MCQ options detected — AI may have auto-corrected a distractor.');
    }
  }

  // Check 2: Possible AI auto-tashkil (sukun on bare ال or unusually dense diacritics)
  const baseLetters = combined.match(ARABIC_BASE_LETTER_RE)?.length ?? 0;
  const harakatCount = combined.match(ARABIC_COMBINING_HARAKAT_RE)?.length ?? 0;
  const lamSukunCount = combined.match(ARABIC_LAM_SUKUN_RE)?.length ?? 0;
  if (lamSukunCount >= 2 || (baseLetters >= 20 && harakatCount / baseLetters >= 0.72)) {
    issues.push(
      "High harakat density / 'الْ' detected — possible AI auto-tashkil (extra harakat added). Compare with original PDF page."
    );
  }

  // Check 3: Corrupted Presentation Form glyphs or detached harakat artifacts
  if (
    new RegExp(ARABIC_PRESENTATION_FORM_RUN_RE.source).test(combined) ||
    new RegExp(DETACHED_HARAKAT_RE.source).test(combined)
  ) {
    issues.push('Detached harakat or Presentation Form characters detected.');
  }

  return {
    status: issues.length > 0 ? 'warning' : 'ok',
    issues,
  };
}

/**
 * Shared prompt instructions injected across all subject domains (STEM, Humanities, Languages)
 * so Arabic verses, Hadith, vocabulary, and mixed Arabic + Indonesian/English stems are
 * transcribed visually from page images rather than corrupted PDF ToUnicode text streams.
 */
export function buildArabicExtractionGuidance(): string {
  return `ARABIC SCRIPT & MIXED ARABIC + INDONESIAN/ENGLISH EXTRACTION PROTOCOL (CRITICAL):
- Many exam PDFs (PAI, Al-Qur'an Hadis, Fiqih, Bahasa Arab) store a CORRUPTED embedded PDF text layer for Arabic: letters may be reversed left-to-right, harakat split across lines, Allah/lam-alif ligatures scrambled, or hamza letters omitted (for example, printing "ا ْلَْلْبَاب" / "ْلَْا" in the PDF text layer when the page visually shows "الْأَلْبَابِ" and "الْأَ").
- ALWAYS read ALL Arabic words, verses, Hadith, and short inline Arabic terms VISUALLY from the rendered page image(s). NEVER copy corrupted or reversed Arabic sequences from an underlying PDF text layer.
- NO AUTO-TASHKIL / LITERAL DIACRITICS ONLY (STRICT):
  * ONLY output a harakah/diacritic (َ, ِ, ُ, ْ, ّ, ٰ, ً, ٍ, ٌ) if that exact mark is VISUALLY PRINTED on that letter in the source page image.
  * NEVER auto-vowellize (auto-tashkil) unvowelled letters, NEVER add a sukun (ْ) onto bare "ال" (e.g. keep "الغَدَاء وَ العَشَاء" as printed, NOT "الْغَدَاءِ وَ الْعِشَاءِ"), NEVER invent unprinted final grammatical case endings (i'rab) such as "ٌ" on "مُحَمَّد" if not printed, and NEVER convert partially vowelled Arabic into fully vowelled Arabic.
- PAY SPECIAL ATTENTION TO SHORT INLINE ARABIC SNIPPETS INSIDE INDONESIAN/ENGLISH SENTENCES (e.g. tajwid/nahwu questions like "menemukan bacaan الْأَلْبَابِ ... hukum bacaan pada bagian الْأَ dalam kata tersebut"):
  * Carefully inspect every single letter (especially أ, إ, آ, ء, ع, غ, ه, و, ي) and every harakat/diacritic (َ, ِ, ُ, ْ, ّ, ٰ, ً, ٍ, ٌ) visually on the page image.
  * When an inline excerpt refers to a word or phrase inside the verse/quote printed directly above it, cross-check that the extracted inline word and sub-part characters strictly match that printed verse/word visually.
- PRESERVE EXACT DISTRACTOR DIFFERENCES ACROSS ARABIC MCQ OPTIONS (CRITICAL — DO NOT "AUTO-CORRECT"):
  * Arabic grammar/orthography MCQs intentionally test subtle visual differences between choices. NEVER auto-correct, normalize away, or fix typos/spacing in MCQ options!
  * Each Arabic page is sent as a high-resolution margin-cropped PNG image — inspect every Arabic word, space, and harakat directly from that page image rather than guessing or translating.
  * Keep detached vs. joined word/pronoun spacing literally as visually printed (for example, keep the visible space in "أ. سَكَنُ كَ" vs connected "ه. سَكَنُكَ", or "غُرْفَتُكُمْ" vs "غُرْفَتُ كُمْ").
  * Keep every single-harakat or spelling variant distinct—verify carefully whether the mark on the final letter is a fatha (َ above), kasra (ِ below — Note: even in Traditional Arabic fonts where kasra sits right beneath the stroke/loop of ك/ن), damma (ُ), or sukun (ْ) (for example, "ج. سَكَنُكِ" with kasra below vs "ه. سَكَنُكَ" with fatha above; "طَلَابٌ" vs "طِلَابٌ" vs "طُلَّابٌ"). Before finalizing any MCQ, verify visually that every choice is faithful and distinct.
- Output ALL Arabic in canonical logical Unicode reading order (standard U+0600–U+06FF letters with harakat immediately after each letter). NEVER output visually reversed Arabic, NEVER use Arabic Presentation Forms (U+FB50–U+FEFF), and NEVER wrap Arabic text inside LaTeX ($...$) or Markdown (*...* / **...**).`;
}
