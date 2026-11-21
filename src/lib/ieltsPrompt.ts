/**
 * IELTS / CEFR Multi-Skill extraction prompt (pure — no pdfjs, no DOM, no React).
 *
 * Activated only when the teacher selects Languages -> "IELTS / CEFR Multi-Skill"
 * (or when subjectClassifier identifies an IELTS / CEFR multi-skill paper).
 * Leaves STEM, Humanities, and standard Languages (TKA / AKM / Bahasa) prompts untouched.
 */

import { buildMarkSchemeStrictnessBlock } from './markSchemePrompt.ts';

export function getIeltsCefrExtractionPrompt(
  includeGuidance: boolean = true,
  hasMarkScheme: boolean = false
): string {
  const guidanceSchemaSnippet = includeGuidance
    ? `,
      "guidance": [
        "Examiner note: cite exact evidence in the recording or passage supporting the key",
        "Check word-limit and spelling constraints strictly"
      ],
      "common_misconceptions": [
        "Distractor mentioned by speaker / passage before self-correction",
        "Exceeding the printed word limit (e.g. writing 2 words instead of ONE WORD ONLY)"
      ]`
    : '';

  return `You are an expert IELTS, CEFR, and Cambridge English proficiency assessment parser.
Analyze the attached exam paper PDF page(s) and any mark scheme / answer key content.
This paper assesses Listening, Reading, and Writing skills (and may append Speaking and scoring rubrics at the back).

CRITICAL EXTRACTION RULES (READ CAREFULLY):

1. SKILL SECTION PREFIXING (MANDATORY TO PREVENT NUMBER COLLISIONS):
   - Multi-skill IELTS / CEFR papers restart numbering across skills (e.g. Listening 1–20, Reading 1–22, Writing Task).
   - Prefix EVERY "question_number" by skill section:
     * Listening items: "L1-10" (boxed note/form completion), "L11", "L12", "L15-16", etc. Set "topic" starting with "Listening - ...".
     * Reading items: "R1-6", "R7", "R14", "R18-22", etc. Set "topic" starting with "Reading - ...".
     * Writing items: "W1" (and "W2" if there are two Writing tasks). Set "topic" starting with "Writing - ...".
   - Set "passage_ref": null on ALL Listening and Writing questions. Only Reading questions reference Reading Passages.

2. SECTIONS TO STRICTLY SKIP / IGNORE:
   - DO NOT extract Speaking tasks ("SPEAKING", examiner cue cards, "Describe a big city you would like to visit", "- End of the test -").
   - DO NOT extract rubric/band conversion appendices ("Listening Scoring Rubrics", "Reading Scoring Rubrics", "Writing Rubrics", "Speaking rubrics", "Scoring system", "CEFR Description").
   - If a PDF chunk contains ONLY cover/instructions, Speaking, blank writing sheets, or scoring rubrics, return "questions": [].

3. COHESIVE BOXED NOTE / FORM / SUMMARY COMPLETION ("Fill in the Blank"):
   - When a section presents a bordered note sheet, form, table, or summary paragraph with multiple numbered blanks sharing one instruction (e.g. Listening Questions 1–10 "Buckworth Conservation Group", Reading Questions 1–6 "The London underground railway", Reading Questions 18–22 "Roman amphitheatres"):
     a) Keep the ENTIRE boxed completion block as ONE cohesive question object (e.g. "question_number": "L1-10", "total_marks": 10; "question_number": "R1-6", "total_marks": 6; "question_number": "R18-22", "total_marks": 5).
     b) Set "question_style": "Fill in the Blank".
     c) Preserve the EXACT word/number limit instruction at the top verbatim (e.g. "Write **ONE WORD AND/OR A NUMBER** for each answer." or "Choose **ONE WORD ONLY** from the passage for each answer.").
     d) Preserve EVERY heading, bullet, line, currency symbol (note: when a printed blank number sits directly before a symbol like "10 £ ............" treat the bold number 10 as blank [10] and output "£ [10]"), and blank in order, replacing the entire dotted/underlined blank line (and any leading printed blank number) cleanly with "[1]", "[2]", ..., "[10]" (do NOT leave trailing dots "......" or underscores "____" after "[1]"). Verify ALL printed blank numbers are present and NONE are skipped or leaked into another question!
     e) In "mark_scheme":
        - "marking_points": one entry per blank matching exact numbers, e.g. ["[18] fortress [1]", "[19] bullfights [1]", ...].
        - "acceptable_answers": ["[18] fortress", "[19] bullfights", ...].
        - For Reading blanks, every answer word MUST come verbatim from the Reading Passage and obey the printed word limit!
        - For Listening blanks when no transcript/key is provided in the PDF, infer plausible context-appropriate tentative answers and state in "guidance" that answers should be verified against the official audio recording.

4. SINGLE-CHOICE MULTIPLE CHOICE (e.g. Listening 11–14, A/B/C or A/B/C/D):
   - Set "question_style": "Multiple Choice", "total_marks": 1.
   - Put all choices in "options": ["A. ...", "B. ...", "C. ..."] (NEVER duplicate options inside "question_text").

5. PAIRED MULTI-SELECT QUESTIONS ("Choose TWO letters, A–E", e.g. Questions 15 and 16, 17 and 18, 19 and 20):
   - Extract each pair as ONE single "Multiple Select" question ("question_number": "L15-16", "total_marks": 2) instead of creating a duplicate 0-mark second question!
   - Put all 5 options A–E in "options": ["A. ...", "B. ...", "C. ...", "D. ...", "E. ..."].
   - Set "mark_scheme": { "marking_points": ["A, E [2]"], "acceptable_answers": ["A, E"] }.

6. READING "TRUE / FALSE / NOT GIVEN" & "YES / NO / NOT GIVEN" (e.g. Reading Questions 7–13):
   - Extract each numbered statement as an interactive "Multiple Choice" question!
   - Set "question_style": "Multiple Choice", "total_marks": 1, "passage_ref": "Passage 1" (matching the source passage).
   - Set "options": ["A. TRUE", "B. FALSE", "C. NOT GIVEN"] (or ["A. YES", "B. NO", "C. NOT GIVEN"] when the prompt asks YES/NO/NOT GIVEN).
   - Set "question_text" to the statement stem ONLY (plus the brief instruction if helpful, without listing A/B/C inside "question_text").
   - Set "mark_scheme.acceptable_answers" to the matching letter AND label (e.g. ["C", "NOT GIVEN"]) and "marking_points" to ["C. NOT GIVEN [1]"].

7. READING PARAGRAPH / SECTION MATCHING ("Which section contains the following information? A–G", e.g. Reading Questions 14–17):
   - Extract each numbered statement as an interactive "Multiple Choice" question!
   - Set "question_style": "Multiple Choice", "total_marks": 1, "passage_ref": "Passage 2" (matching the source passage).
   - Set "options" to cover every lettered section in that passage:
     ["A. Section A", "B. Section B", "C. Section C", "D. Section D", "E. Section E", "F. Section F", "G. Section G"].
   - Set "mark_scheme.acceptable_answers" to the section letter (e.g. ["A"]).

8. READING PASSAGES CATALOG ("passages" ARRAY):
   - Extract each Reading Passage verbatim ONCE into top-level "passages" ONLY IF at least one of its Reading questions appears in the attached page(s) (skip passages whose questions are not yet in this chunk):
     * "id": "Passage 1", "Passage 2", etc.
     * "heading": Passage title verbatim (e.g. "The development of the London underground railway" or "Stadiums: past, present and future").
     * "body": EVERY word, paragraph, and section label (e.g. "A  ...", "B  ...") faithfully from top to bottom. NEVER truncate or use "...".
     * "page_number": PDF page number where the passage starts.
     * "target_questions": Array of Reading question numbers only (e.g. ["R1-6", "R7", ..., "R13"]).
   - On Reading questions, set "passage_ref" to that passage's "id" and DO NOT copy the whole passage inside "question_text".

9. ACADEMIC WRITING TASK (e.g. Task 1 / Task 2 Essay):
   - Extract the complete boxed prompt and task instructions verbatim as "question_number": "W1", "question_style": "Structured", "passage_ref": null, "options": null.
   - Preserve exact word targets (e.g. "Write at least 250 words.") inside "question_text".
   - Set "total_marks": 40 and populate "mark_scheme":
     * "marking_points": ["Task Achievement / Response (25%) [10]", "Coherence and Cohesion (25%) [10]", "Lexical Resource (25%) [10]", "Grammatical Range and Accuracy (25%) [10]"]
     * "acceptable_answers": ["Structured academic response meeting the minimum word count and addressing all parts of the prompt."].

10. MARK SCHEME & ANSWER KEY STRICTNESS:
${buildMarkSchemeStrictnessBlock(hasMarkScheme, false)}

Output strictly valid JSON matching this schema — no markdown fences, no commentary:

{
  "paper_metadata": {
    "subject": "English (IELTS / CEFR)",
    "subject_code": "IELTS",
    "year": 2026,
    "series": "CEFR Assessment",
    "paper_number": 1,
    "has_insert_booklet": false
  },
  "passages": [
    {
      "id": "Passage 1",
      "heading": "Reading Passage Heading",
      "body": "Full verbatim text of passage...",
      "page_number": 6,
      "target_questions": ["R1-6", "R7", "R8"]
    }
  ],
  "questions": [
    {
      "question_number": "L1-10",
      "parent_question_id": "L1-10",
      "passage_ref": null,
      "page_number": 3,
      "year": 2026,
      "series": "CEFR Assessment",
      "paper_number": 1,
      "question_text": "Complete the notes below.\\nWrite **ONE WORD AND/OR A NUMBER** for each answer.\\n\\n**Title**\\n- item 1 [1]\\n- cost of session: £ [10]",
      "question_style": "Fill in the Blank",
      "total_marks": 10,
      "estimated_difficulty": "Medium",
      "topic": "Listening - Note Completion",
      "sub_topic": "Form & Note Completion",
      "has_diagram": false,
      "diagram_source": null,
      "bounding_box": null,
      "options": null,
      "sub_questions": [],
      "mark_scheme": {
        "marking_points": ["[1] litter [1]", "[10] 10 [1]"],
        "acceptable_answers": ["[1] litter", "[10] 10"]${guidanceSchemaSnippet}
      }
    }
  ]
}
`;
}
