/**
 * Pure prompt-block builder for Mark Scheme alignment strictness (zero imports so
 * raw Node harnesses, Vite, and TypeScript can import it cleanly).
 */
export function buildMarkSchemeStrictnessBlock(
  hasMarkScheme: boolean,
  isIgcse: boolean = true
): string {
  if (hasMarkScheme) {
    return `OFFICIAL MARK SCHEME STRICT ALIGNMENT PROTOCOL (NON-NEGOTIABLE):
- An Official Mark Scheme / Answer Key PDF IS ATTACHED (DOCUMENT 3). It is the SINGLE AUTHORITATIVE SOURCE OF TRUTH for all answers and mark allocations.
- TRANSCRIBE OFFICIAL ANSWERS VERBATIM: Copy the official answer letters, numerical values, units, tolerances, equations, marking points, acceptable alternatives ("allow", "accept", "ora", "owtte", "ecf"), and rejected/ignored answers ("ignore", "reject") directly from DOCUMENT 3.
- STRICT NO-OVERRIDE RULE: NEVER replace, override, "correct", or blend an official Mark Scheme answer with your own solved answer — even if the official key looks counter-intuitive!
- EXACT LABEL ALIGNMENT: Match every entry strictly by its printed Question Number AND sub-part label (e.g., Q2(b)(ii) must map ONLY to 2(b)(ii)). Never shift rows up/down or merge neighboring questions' marking points.
- MARK-TAG SUM PARITY: Preserve bracketed mark tags ("[1]", "[2]") so their sum matches the printed marks of each question or sub-question (respecting any stated "(max N)" cap).
- STYLE-SPECIFIC OFFICIAL TRANSCRIPTION:
  * Multiple Choice: set "acceptable_answers" to the exact official letter (e.g. ["B"]) and include the letter in "marking_points" (e.g. ["B [1]"]).
  * Multiple Select: set "acceptable_answers" to the comma-separated official letters (e.g. ["A, C"]) and "marking_points": ["A, C [2]"].
  * Table Choice: output one marking point per statement row in exact table order matching the official key.
- HONEST MISSING-PART FALLBACK ONLY: ONLY if a question or sub-question is genuinely absent or unreadable in DOCUMENT 3, solve it to examiner standard and MUST prepend "[NOT IN MARK SCHEME — AI SOLVED] " to the first marking point (or sub-question "mark_scheme") and record this in "guidance".`;
  }

  const standardLabel = isIgcse
    ? 'official Cambridge IGCSE / A-Level Chief Examiner marking standards'
    : 'rigorous subject-specific Chief Examiner marking standards';

  return `AUTONOMOUS MARK SCHEME GENERATION PROTOCOL (QUESTION PAPER ONLY — NO MARK SCHEME ATTACHED):
- NO separate Mark Scheme PDF is attached (unless an Answer Key appears on trailing pages of DOCUMENT 1). Solve every question and sub-question accurately using ${standardLabel}.
- STRICT MARK-TAG SUM PARITY: Every mark scheme MUST break points into explicit "[1]" or "[2]" tags whose sum equals the question's printed "total_marks" (or sub-question's "marks", or note "(max N)" explicitly).
- VISUAL GROUNDING REQUIRED: Read all numerical values, axis scales, tables, circuit labels, and structural diagrams carefully from the attached pages before solving.
- STYLE-SPECIFIC ANSWER FORMATTING:
  * Multiple Choice: determine the exact single correct letter (A–E); set "acceptable_answers": ["<Letter>"] and "marking_points": ["<Letter> — <concise scientific/textual justification> [1]"].
  * Multiple Select: put exact comma-separated letters in "acceptable_answers" (e.g. ["A, C"]) and "marking_points": ["A, C — <justification> [2]"].
  * Table Choice: output one marking point per statement row in exact table row order (e.g. ["Row 1: Tepat [1]", "Row 2: Tidak Tepat [1]"]).
  * Fill in the Blank: output one entry per numbered blank matching the gap number (e.g. ["[1] exact word [1]"], "acceptable_answers": ["[1] exact word / synonym"]).
  * Calculation / Quantitative STEM: include explicit formula/method mark ("[1]"), substitution/working mark ("[1]"), final answer with units ("[1]"), AND include Cambridge 2–3 significant-figure roundings / valid tolerance ranges / equivalent unit conversions in "acceptable_answers".`;
}
