/**
 * Cambridge Practical (0620/5x) extraction prompt.
 *
 * The structure is not requested from the model — it is supplied, taken from the
 * deterministic paper outline. The model's job is transcription and mark-scheme
 * writing only. See paper5update.md §Phase 3.
 */

// Explicit .ts extension: lets the Node verification harness import this module
// directly (tsconfig has allowImportingTsExtensions; Vite resolves it too).
import { outlineToPromptText } from './paperOutlineParse.ts';
import type { PaperOutline } from './paperOutlineParse.ts';

export interface PracticalPromptOptions {
  includeGuidance?: boolean;
  /** A mark scheme PDF is attached after the question paper (Phase 4). */
  hasMarkScheme?: boolean;
}

export function getCambridgePracticalExtractionPrompt(
  outline: PaperOutline,
  options: PracticalPromptOptions = {},
): string {
  const includeGuidance = options.includeGuidance !== false;
  const hasMarkScheme = options.hasMarkScheme === true;
  const structure = outlineToPromptText(outline);
  const hasQ3 = outline.questions.some((q) => q.number === 3);

  return `You are transcribing one Cambridge IGCSE Chemistry Practical paper (syllabus 0620, Paper 5) that has ALREADY been structurally parsed.

## AUTHORITATIVE STRUCTURE — ground truth, not a suggestion

${structure}

Rules that override anything you read on the page:
1. Return exactly ${outline.questions.length} questions, numbered ${outline.questions.map((q) => q.number).join(', ')}.
2. Each question's "sub_questions" array must contain exactly the sub-parts listed above, in that order, with those exact "sub_id" strings and those exact "marks".
3. Never add a sub-question that is not listed. Never merge two listed sub-parts. Never renumber.
4. Where the list says "section stem — no sub-question", do NOT emit that id as a sub-question: its printed text becomes the opening of the next listed sub-part (e.g. (c) text goes into (c)(i)).
5. If the printed page appears to disagree with the list, the list is correct.
${hasQ3 ? '6. Question 3 has no sub-parts: set "sub_questions": [] and "total_marks": 6.' : ''}

## TRANSCRIPTION RULES

- "question_text" = the printed stem that appears BEFORE the first sub-part, verbatim. For Question 1 this includes every "Experiment 1"…"Experiment n" block, every bullet, every volume and reagent. Do not summarise or shorten.
- Each sub-part's "question_text" = its printed text from its label up to the next label. Keep "dropwise" and "in excess" observation prompts on separate lines where they are printed that way.
- Dotted answer lines are answer spaces: render each as "____". Never emit runs of dots.
- Exclude page furniture: "DO NOT WRITE IN THIS MARGIN", "* 0000… *", "DFD", "© UCLES", "[Turn over", page numbers, barcodes.
- Exclude the "Notes for use in qualitative analysis" pages entirely — they are reference material, not questions.
- Keep chemical formulae, charges and units as printed (cm³, ° C, Fe³⁺, SO₄²⁻). Use plain text or LaTeX, never a broken fragment like "cm3" alone on a line.
- Mark allocations come ONLY from the structure list. Do not recompute them from the page.

## FIGURES, TABLES AND GRAPHS

- Every printed table (e.g. "Table 1.1", "Table 3.1") must appear twice: as a Markdown table inside the owning "question_text", and as an entry in that question's "data_tables" array: { "title": "Table 1.1", "columns": ["..."], "rows": [["..."]] }.
- Attach a figure whenever the question relies on printed artwork the candidate must read or complete: a graph grid to plot on, an apparatus diagram, a specimen photograph. Applies to ANY question, including the 6-mark planning question if it shows apparatus. Set "has_diagram": true, "diagram_source": "qp", "diagram_type": "graph" | "apparatus" | "photo", and "resource_ref" to the printed label (e.g. "Fig. 1.1", "Fig. 3.1"). Never invent a label.
- A figure marked "has_diagram": true MUST also carry its location, or it cannot be cropped:
  - "page_number": the 1-indexed PDF page the figure is printed on.
  - "bounding_box": [ymin, xmin, ymax, xmax] on a 0–1000 scale (origin top-left), tightly enclosing ONLY the artwork — the drawing plus its own labels and caption. Do not include the surrounding question text, headers, footers or page margins.
  - If you genuinely cannot estimate the box, omit "has_diagram" rather than setting it without coordinates.
- Do not attach a diagram to a part that merely mentions a figure described earlier.

## MARK SCHEME

${
  hasMarkScheme
    ? '- This request includes the official mark scheme PDF (preamble pages removed). Where it covers a sub-part, copy its marking points into that sub-question\'s "mark_scheme" and into the question\'s "mark_scheme.marking_points" — do not paraphrase accepted answers.\n- Only where the mark scheme is silent, solve the sub-part yourself to Cambridge standard.\n- Never let the mark scheme change the question text or the marks from the structure list.'
    : includeGuidance
      ? '- Solve each sub-part yourself to Cambridge standard and put every marking point in that sub-question\'s "marks" and in the question\'s "mark_scheme.marking_points" (one string per mark, abbreviated to the essential answer).'
      : '- Provide "mark_scheme.marking_points" with one concise string per mark.'
}
- For Question 3 (the 6-mark plan) give exactly six marking points covering apparatus, method, measurement, and the calculation of percentage by mass.

## OUTPUT

Return a single JSON object, no prose, no code fence:

{
  "paper_metadata": { "subject": "Chemistry", "subject_code": "0620", "year": <number>, "series": "<May/June | Oct/Nov | Feb/March>", "paper_number": "${outline.profile.paperCode}", "has_insert_booklet": false },
  "questions": [
    {
      "question_number": "1",
      "parent_question_id": null,
      "page_number": <1-indexed PDF page where the question starts>,
      "question_text": "...",
      "question_style": "Structured",
      "total_marks": <number>,
      "estimated_difficulty": "Medium",
      "topic": "...",
      "sub_topic": "...",
      "has_diagram": <boolean>,
      "diagram_source": "qp" | null,
      "diagram_type": "graph" | "apparatus" | null,
      "resource_ref": "Fig. 1.1" | null,
      "bounding_box": [<ymin>, <xmin>, <ymax>, <xmax>] | null,
      "options": null,
      "data_tables": [ { "title": "Table 1.1", "columns": ["..."], "rows": [["..."]] } ],
      "sub_questions": [
        { "sub_id": "${outline.questions[0]?.subs[0]?.id ?? '(a)'}", "question_text": "...", "marks": <number>, "page_number": <number>, "has_diagram": false, "diagram_type": null }
      ],
      "mark_scheme": { "marking_points": ["...", "..."] }
    }
  ]
}`;
}
