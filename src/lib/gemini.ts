// ─── Gemini API Integration ──────────────────────────────────────────────────
// Sends PDF pages to Google's multimodal AI for structured question extraction.
// Features dynamic model discovery, auto-fallback, and retry.

import type { ExtractionResult, Question, SubQuestion, QuestionStyle } from '../types/database';
import { ensureInlineMathDelimiters } from '../components/ExamMathText';

/**
 * Collects and deduplicates all available Gemini API keys from environment variables.
 * Supports:
 * - VITE_GEMINI_API_KEYS (comma or space separated list of keys)
 * - VITE_GEMINI_API_KEY (primary key)
 * - VITE_GEMINI_API_KEY_2, VITE_GEMINI_API_KEY_3... (secondary/additional keys)
 */
export function getGeminiApiKeys(): string[] {
  const keys: string[] = [];

  const rawList = import.meta.env.VITE_GEMINI_API_KEYS;
  if (typeof rawList === 'string') {
    rawList
      .split(/[,;\s]+/)
      .map((k) => k.trim())
      .filter((k) => k.length > 5 && !k.includes('your-gemini-api-key'))
      .forEach((k) => keys.push(k));
  }

  const primary = import.meta.env.VITE_GEMINI_API_KEY;
  if (typeof primary === 'string' && primary.trim().length > 5 && !primary.includes('your-gemini-api-key')) {
    keys.push(primary.trim());
  }

  const secondary = import.meta.env.VITE_GEMINI_API_KEY_2;
  if (typeof secondary === 'string' && secondary.trim().length > 5 && !secondary.includes('your-gemini-api-key')) {
    keys.push(secondary.trim());
  }

  const tertiary = import.meta.env.VITE_GEMINI_API_KEY_3;
  if (typeof tertiary === 'string' && tertiary.trim().length > 5 && !tertiary.includes('your-gemini-api-key')) {
    keys.push(tertiary.trim());
  }

  // Deduplicate preserving order
  const uniqueKeys = Array.from(new Set(keys));
  return uniqueKeys;
}

/**
 * Returns a specific API key by index (round-robin / deterministic chunk sharding).
 */
export function getApiKeyForChunk(chunkIndex: number = 0): string {
  const pool = getGeminiApiKeys();
  if (pool.length === 0) {
    return import.meta.env.VITE_GEMINI_API_KEY || '';
  }
  return pool[chunkIndex % pool.length];
}

/**
 * Checks whether 2 or more distinct API keys are configured for parallel turbo extraction.
 */
export function hasMultipleApiKeys(): boolean {
  return getGeminiApiKeys().length >= 2;
}

export type SubjectDomain = 'stem' | 'humanities' | 'languages';

/**
 * Builds the specialized STEM (Sciences, Math, Technology) extraction prompt.
 * Focuses on LaTeX math, chemical formulas ($CaCO_3$, equations), nuclide notation, titration tables, and circuit schematics.
 */
export function getStemExtractionPrompt(includeGuidance: boolean = true): string {
  const guidanceSchemaSnippet = includeGuidance
    ? `,
      "guidance": [
        "Examiner tip / guidance on method marks or allowable working",
        "Accept alternative valid chemical or mathematical equations"
      ],
      "common_misconceptions": [
        "Common mistake: forgetting to convert units or missing the state symbol",
        "Common confusion between reactants and products in equilibrium"
      ]`
    : '';

  const subGuidanceSnippet = includeGuidance
    ? `,
          "guidance": "Examiner guidance for sub-part: allow error carried forward (ecf)",
          "common_misconceptions": ["Students often forget to square the denominator"]`
    : '';

  return `You are an expert educational assessment parser specializing in STEM (Chemistry, Physics, Biology, Mathematics, and Computer Science).
Analyze the attached exam past paper PDF page(s) and any mark scheme content.

Extract every numbered question (e.g., Question 1, Question 2, Question 3) as a structured JSON object. 

CRITICAL RULE FOR MULTI-PART / STRUCTURED QUESTIONS (e.g. Paper 4, Theory, Extended papers):
Do NOT split sub-parts (a), (b)(i), (b)(ii), (c) into separate top-level questions! 
Group all sub-parts belonging to Question 1 under a SINGLE Question 1 container object, with:
- "question_number": "1"
- "question_text": The main stem / introductory context describing the question or setup
- "has_diagram": true if there is a shared diagram/table/apparatus for this question
- "total_marks": Sum of all sub-question marks
- "sub_questions": An array containing all sub-parts [(a), (b)(i), (b)(ii), (c)...] with their respective text, marks, and mark scheme!

Output strictly valid JSON matching this exact schema — no markdown fences, no commentary:

{
  "paper_metadata": {
    "subject": "Chemistry",
    "subject_code": "0620",
    "year": 2023,
    "series": "May/June",
    "paper_number": 41,
    "has_insert_booklet": false
  },
  "questions": [
    {
      "question_number": "1",
      "parent_question_id": "Q1",
      "page_number": 1,
      "year": 2023,
      "series": "May/June",
      "paper_number": 41,
      "question_text": "A student investigates the rate of reaction between dilute hydrochloric acid and marble chips ($CaCO_3$).",
      "question_style": "Structured",
      "total_marks": 7,
      "estimated_difficulty": "Medium",
      "topic": "States of Matter",
      "sub_topic": "Rates of Reaction",
      "has_diagram": true,
      "diagram_source": "qp",
      "bounding_box": [150, 45, 420, 550],
      "options": null,
      "sub_questions": [
        {
          "sub_id": "(a)",
          "question_text": "State the formula of hydrochloric acid.",
          "marks": 1,
          "mark_scheme": "$HCl$ [1]"${subGuidanceSnippet}
        },
        {
          "sub_id": "(b)(i)",
          "question_text": "Explain why the rate of reaction decreases as the reaction proceeds.",
          "marks": 2,
          "mark_scheme": "Concentration of reactants decreases [1]; fewer successful collisions per unit time [1]"${subGuidanceSnippet}
        },
        {
          "sub_id": "(b)(ii)",
          "question_text": "Calculate the volume of $CO_2$ gas produced at standard temperature and pressure from 0.05 mol of $CaCO_3$.",
          "marks": 2,
          "mark_scheme": "$0.05 \\times 24 = 1.2 \\text{ dm}^3$ [2]"${subGuidanceSnippet}
        },
        {
          "sub_id": "(c)",
          "question_text": "Complete the table to show the formula and physical state of each compound at r.t.p.\\n\\n| Compound Name | Formula | State at r.t.p. |\\n|---|---|---|\\n| Methane | $CH_4$ | gas |\\n| Calcium carbonate | $CaCO_3$ | solid |\\n| Sodium chloride | [       ] | [       ] |",
          "marks": 2,
          "mark_scheme": "$NaCl$ [1]; solid [1]"${subGuidanceSnippet}
        },
        {
          "sub_id": "(d)",
          "question_text": "Describe one effect of increasing the temperature on the collisions between reacting particles.",
          "marks": 2,
          "mark_scheme": "Particles have greater kinetic energy [1]; more collisions have energy $\\ge E_a$ [1]"${subGuidanceSnippet}
        }
      ],
      "mark_scheme": {
        "marking_points": ["See sub-question breakdown [7]"],
        "acceptable_answers": []${guidanceSchemaSnippet}
      }
    },
    {
      "question_number": "2",
      "parent_question_id": "Q2",
      "page_number": 1,
      "year": 2023,
      "series": "May/June",
      "paper_number": 11,
      "question_text": "Which particle has the same electronic structure as an argon atom?",
      "question_style": "Multiple Choice",
      "total_marks": 1,
      "estimated_difficulty": "Easy",
      "topic": "Atomic Structure",
      "sub_topic": "Electronic Configuration",
      "has_diagram": false,
      "diagram_source": null,
      "bounding_box": null,
      "options": ["A $Na^+$", "B $Mg^{2+}$", "C $Cl^-$", "D $K$"],
      "sub_questions": [],
      "mark_scheme": {
        "marking_points": ["C [1]"],
        "acceptable_answers": ["C"]${guidanceSchemaSnippet}
      }
    }
  ]
}

CRITICAL FORMATTING RULES:
1. MANDATORY TABLE TRANSCRIPTION IN SUB-QUESTIONS & MAIN QUESTIONS (TOP PRIORITY):
   - Whenever ANY sub-question (e.g. (a), (b)(i), (c)) or main question contains or refers to a data table, experimental observations, titration readings, physical properties matrix, or student fill-in completion grid:
     a) You MUST transcribe the COMPLETE Markdown Table (| Header 1 | Header 2 | ... |\\n|---|---|...|\\n| Row 1 | Val 1 | ... |) directly in that sub_question's "question_text" field.
     b) ABSOLUTELY NEVER omit the table or replace it with placeholder text.
     c) Preserve ALL column headers, row labels, units (e.g. $g/cm^3$, $^\\circ\\text{C}$, $s$, $cm^3$, $kJ/mol$, $bpm$, $arbitrary units$), given values, and blank fill-in cells represented as '[       ]'.
2. BIOLOGY SPECIALIZED PATTERNS (CRITICAL):
   - DICHOTOMOUS KEYS & MULTI-SPECIMEN COLLAGES (e.g. Fig. 1.1 showing species A–F on one page, and Key table on the next page):
     * Crop the specimen collage (all specimens A to F together with the Fig title) as the diagram on that question/sub-question.
     * Transcribe the complete Dichotomous Key table in "question_text" with input blanks '[ ]' for student answers.
   - MATCHING DRAWINGS & BOXES (e.g. Draw lines from specimen boxes to group names):
     * Capture the entire matching layout (left boxes and right target boxes) in the bounding box so the visual task is 100% complete.
   - BIOLOGY GRAPHS WITH LEGENDS/KEYS (e.g. Enzyme pH activity curves with Key for Enzyme A & B, population growth curves):
     * Ensure bounding boxes generously capture the graph curve, axis titles, units, AND the Legend/Key box below or beside the axes.
   - ANATOMICAL / CELL DIAGRAMS (e.g. Animal/plant cell with organelle pointers H, J, K, L, M, or reflex arc neurone pointers S, R, T):
     * Crop the full diagram including all pointer lines and letter labels.
   - MCQ COMPARISON TABLES (e.g. Row A, B, C, D with multiple columns for cell types, food tests, diffusion factors):
     * Transcribe the complete comparison table in "question_text" and set options: ["A", "B", "C", "D"] (or full row descriptors).
   - NUMBERED STATEMENTS IN MCQS (e.g. Statements 1, 2, 3, 4 followed by "Which statements are correct?"):
     * Keep statements 1, 2, 3, 4 in "question_text" before the options ["A 1 and 3", "B 1 and 4", ...].
   - FILL-IN-THE-BLANK SENTENCES:
     * Transcribe completion statements with clear blank lines (e.g. 'Organisms are classified into groups by the .......................................... that they share.') and mark brackets [ ].
3. Group all sub-questions inside their parent question's sub_questions array. Do not fragment them into separate top-level questions.
4. CHEMICAL FORMULAS, WORD EQUATIONS & MATH:
   - Convert ALL mathematical symbols, chemical formulas, and equations to LaTeX enclosed in single dollar signs (e.g. '$CH_4$', '$CaCO_3$', '$\\text{Fe}_2\\text{O}_3$', '$0.05 \\times 24 = 1.2\\text{ dm}^3$').
   - For Biology word equations and reaction paths, use arrows: '$glucose \\rightarrow alcohol + carbon dioxide$' or '$carbon dioxide + water \\rightarrow glucose + oxygen$'.
   - For nuclide/isotope notation, use standard LaTeX format: '{}^{40}_{20}\\text{W}'.
5. Identify paper provenance: series, year, paper_number.
6. DIAGRAMS, GRAPHS & SCHEMATICS:
   - Set has_diagram=true for drawings, apparatus setups, circuit schematics, cell illustrations, graphs, and reaction flowcharts.
   - Set diagram_source="qp".
   - Set bounding_box [ymin, xmin, ymax, xmax] (0-1000 scale) generously with at least 80 units margin on all sides.
7. TICK BOX QUESTIONS:
   - If a question asks to "Tick (✓) the conclusions/boxes", format choices as [ ] and put options array on that question/sub-question.
8. In JSON strings, ALWAYS double-escape all LaTeX backslashes (\\\\rightarrow, \\\\frac, \\\\Delta, \\\\text, \\\\times, \\\\ge, \\\\circ).
9. ANSWER KEYS & SOLUTIONS: If the PDF contains an answer key or solutions grid at the end (e.g., '1: B, 2: C, 3: A...'), use it to assign correct options and populate 'acceptable_answers' and 'marking_points'.
10. CURRENCY & PRICES: When transcribing prices or costs (e.g. $25, $1.50), write them as normal text without LaTeX delimiters to prevent math rendering conflicts.
`;
}

/**
 * Builds the specialized Humanities & Social Sciences (Geography, History, Economics, Env Mgmt, English) prompt.
 * Enforces cross-referencing of Insert / Resource Booklets, mapping "Fig. 1.1 in the Insert", "Photograph A", "Table 2.1",
 * and generating a structured insert_resources catalog.
 */
export function getHumanitiesExtractionPrompt(
  hasInsert: boolean = true,
  includeGuidance: boolean = true,
  extractResourceCatalog: boolean = true
): string {
  const guidanceSchemaSnippet = includeGuidance
    ? `,
      "guidance": [
        "Examiner tip: award marks for specific geographical / historical terminology (e.g. hydraulic action, lateral erosion, push/pull factors, treaty clauses)",
        "Allow equivalent valid regional examples or case study statistics"
      ],
      "common_misconceptions": [
        "Common error: confusing weather with climate, or confounding rural-urban migration causes with consequences",
        "Students often describe features without referring to evidence from the resource/map"
      ]`
    : '';

  const subGuidanceSnippet = includeGuidance
    ? `,
          "guidance": "Examiner tip: 1 mark for identification from Fig. 1.1, 1 mark for explanation",
          "common_misconceptions": ["Candidates frequently quote data without units"]`
    : '';

  const insertCatalogPrompt = (hasInsert && extractResourceCatalog)
    ? `
6. ROOT "insert_resources" CATALOG:
   - Extract an array listing all unique resource items in the Insert Booklet:
   "insert_resources": [
     {
       "id": "Fig. 1.1",
       "title": "Average annual population growth rates between 1950 and 2100 (estimated)",
       "page_number": 2,
       "target_questions": ["1(a)"]
     },
     {
       "id": "Fig. 2.1",
       "title": "A map showing information about settlements in Extremadura, Spain",
       "page_number": 3,
       "target_questions": ["2(a)"]
     },
     {
       "id": "Figs. 2.2, 2.3 and 2.4",
       "title": "Photographs showing settlements with different functions",
       "page_number": 4,
       "target_questions": ["2(b)"]
     }
   ]`
    : (hasInsert && !extractResourceCatalog)
    ? `
6. ROOT "insert_resources" CATALOG:
   - To conserve token usage on this chunk, do NOT output an "insert_resources" catalog array. Only output "paper_metadata" and "questions".`
    : '';

  const insertSchemaRule = hasInsert
    ? `
DIAGRAMS, MAPS & INSERT PLACEMENT RULES (CRITICAL — READ CAREFULLY):
1. TOP-LEVEL QUESTION STEM & INSERT PLACEMENT (BEFORE SUB-QUESTIONS):
   - In Cambridge structured papers (e.g. Geography Paper 1), Question 1 begins with a Part (a) introductory stem referencing an Insert figure (e.g. "1 (a) Study Fig. 1.1 (Insert), showing...").
   - Place this introductory stem in the parent Question's "question_text".
   - Set "has_diagram": true, "diagram_source": "insert", "resource_ref": "Fig. 1.1", "insert_page_number": <page in insert>, "bounding_box": [<ymin>, <xmin>, <ymax>, <xmax>].
   - The sub-questions (a)(i), (a)(ii), (a)(iii), (a)(iv) that follow MUST NOT duplicate the insert or diagram! Set "has_diagram": false, "diagram_url": null, "diagram_source": null, "resource_ref": null on those sub-questions.

2. SUBSEQUENT PARTS INTRODUCING IN-PAPER OR INSERT FIGURES (e.g. Part (b)):
   - When Part (b) introduces a new figure (e.g. "(b) Study Fig. 1.2, a graph showing..." in Question Paper OR "(b) Study Figs. 2.2, 2.3 and 2.4 (Insert)..." in Insert Booklet):
     - Place the Part (b) intro text on the first sub-question of that section (e.g. "(b)(i)").
     - Set "has_diagram": true ON THAT SUB-QUESTION!
     - If the figure is in the Question Paper: set "diagram_source": "qp", "resource_ref": "Fig. 1.2", "page_number": <page in QP>, "bounding_box": [<ymin>, <xmin>, <ymax>, <xmax> in QP].
     - If the figure is in the Insert Booklet: set "diagram_source": "insert", "resource_ref": "Figs. 2.2, 2.3 and 2.4", "insert_page_number": <page in Insert>, "bounding_box": [<ymin>, <xmin>, <ymax>, <xmax> in Insert].
     - Subsequent sub-questions (e.g. (b)(ii), (c)) DO NOT duplicate the diagram!

3. MULTIPLE FIGURES / PHOTOGRAPHS IN INSERT (e.g. Figs 2.2, 2.3, 2.4 or Fig 3.1 & 3.2):
   - Always extract bounding box for the visual content on that Insert page.
   - For Part (a) figures, set on parent question. For Part (b) figures, set on sub-question (b)(i).

4. IN-LINE TABLES & TICK-BOX GRIDS:
   - When a question contains a comparison table (e.g. Question 2(a)(iii) settlement service table) or tick table (e.g. Question 3(a)(ii)), format it cleanly as a Markdown Table inside "question_text".

5. EXTENDED CASE STUDY QUESTIONS (e.g. Part (c)):
   - Transcribe full prompts (e.g. "(c) For a named country you have studied, describe a policy used to influence its population growth rate.") as sub_id "(c)".

${insertCatalogPrompt}`
    : `
FIGURES & MAPS IN QUESTION PAPER:
If figures, diagrams, maps, climate graphs, or sketches are embedded in the Question Paper:
- For Part (a) figures: set "has_diagram": true, "diagram_source": "qp", "page_number": <page in QP>, "bounding_box": [ymin, xmin, ymax, xmax] on the parent question.
- For Part (b) figures: set "has_diagram": true, "diagram_source": "qp", "page_number": <page in QP>, "bounding_box": [ymin, xmin, ymax, xmax] on sub-question (b)(i).
- Do NOT duplicate the diagram onto every sub-question; place it before the sub-questions or on the specific part stem.`;

  return `You are an expert educational assessment parser specializing in Cambridge IGCSE, GCSE, and International A-Level Geography (0460, 0976, 2217), History (0470, 0977), Economics (0455), Environmental Management (0680), Sociology, and English.
Analyze the attached exam Question Paper PDF${hasInsert ? ', Insert / Resource Booklet PDF,' : ''} and any mark scheme content.

Extract every numbered question (e.g., Question 1, Question 2, Question 3...) as a structured JSON object.

CRITICAL RULE FOR MULTI-PART / STRUCTURED QUESTIONS:
Do NOT split sub-parts (a)(i), (a)(ii), (b)(i), (b)(ii), (c) into separate top-level questions! 
Group all sub-parts belonging to Question 1 under a SINGLE Question 1 container object with:
- "question_number": "1"
- "question_text": The main stem / introductory context placed BEFORE sub-questions (e.g. "1 (a) Study Fig. 1.1 (Insert), showing average annual population growth rates between 1950 and 2100 (estimated).")
- "has_diagram": true if there is a figure, photograph, map, or chart for this question stem
- "diagram_source": "insert" (if figure is in the Insert Booklet) OR "qp" (if figure is in the Question Paper)
- "resource_ref": Figure/Photo reference (e.g. "Fig. 1.1", "Photograph A", "Fig. 2.1")
- "total_marks": Sum of all sub-question marks (e.g. 25 marks)
- "sub_questions": An array containing all sub-parts [(a)(i), (a)(ii), (a)(iii), (a)(iv), (b)(i), (b)(ii), (c)] with their respective text, marks, and mark schemes!

${insertSchemaRule}

Output strictly valid JSON matching this exact schema — no markdown fences, no commentary:

{
  "paper_metadata": {
    "subject": "Geography",
    "subject_code": "0460",
    "year": 2025,
    "series": "Oct/Nov",
    "paper_number": 11,
    "has_insert_booklet": ${hasInsert ? 'true' : 'false'}
  },
  ${(hasInsert && extractResourceCatalog) ? `"insert_resources": [
    {
      "id": "Fig. 1.1",
      "title": "Average annual population growth rates between 1950 and 2100 (estimated)",
      "page_number": 2,
      "target_questions": ["1(a)"]
    },
    {
      "id": "Fig. 2.1",
      "title": "A map showing information about settlements in Extremadura, Spain",
      "page_number": 3,
      "target_questions": ["2(a)"]
    },
    {
      "id": "Figs. 2.2, 2.3 and 2.4",
      "title": "Photographs showing settlements with different functions",
      "page_number": 4,
      "target_questions": ["2(b)"]
    }
  ],` : ''}
  "questions": [
    {
      "question_number": "1",
      "parent_question_id": "Q1",
      "page_number": 2,
      "year": 2025,
      "series": "Oct/Nov",
      "paper_number": 11,
      "question_text": "1 (a) Study Fig. 1.1 (Insert), showing average annual population growth rates between 1950 and 2100 (estimated).",
      "question_style": "Structured",
      "total_marks": 25,
      "estimated_difficulty": "Medium",
      "topic": "Population and Settlement",
      "sub_topic": "Population Dynamics",
      "has_diagram": true,
      "diagram_source": ${hasInsert ? '"insert"' : '"qp"'},
      "resource_ref": "Fig. 1.1",
      "insert_page_number": ${hasInsert ? '2' : 'null'},
      "bounding_box": [115, 60, 580, 930],
      "options": null,
      "sub_questions": [
        {
          "sub_id": "(a)(i)",
          "question_text": "Identify the average annual population growth rate of the USA.",
          "marks": 1,
          "has_diagram": false,
          "diagram_url": null,
          "diagram_source": null,
          "resource_ref": null,
          "mark_scheme": "0–0.9% [1]"${subGuidanceSnippet}
        },
        {
          "sub_id": "(a)(ii)",
          "question_text": "Put the following four countries in rank order according to their average annual population growth rates:\\nAngola, Australia, China, Peru\\n\\nhighest: ...\\n...\\n...\\nlowest: ...",
          "marks": 2,
          "has_diagram": false,
          "diagram_url": null,
          "diagram_source": null,
          "resource_ref": null,
          "mark_scheme": "Angola, Peru, Australia, China [2] (All in correct order = 2 marks, 2 or 3 correct = 1 mark)"${subGuidanceSnippet}
        },
        {
          "sub_id": "(a)(iii)",
          "question_text": "Describe the distribution of countries where the population is decreasing.",
          "marks": 3,
          "has_diagram": false,
          "diagram_url": null,
          "diagram_source": null,
          "resource_ref": null,
          "mark_scheme": "Unevenly distributed [1]; clustered [1]; mainly in Northern hemisphere / north of Equator [1]; Northern Asia [1]; Eastern Europe [1]"${subGuidanceSnippet}
        },
        {
          "sub_id": "(a)(iv)",
          "question_text": "Explain why there has been a reduction in population growth rates in some countries.",
          "marks": 4,
          "has_diagram": false,
          "diagram_url": null,
          "diagram_source": null,
          "resource_ref": null,
          "mark_scheme": "Reduction in birth rates [1]; reduced infant mortality [1]; increased death rates [1]; government anti-natal policy [1]; greater access to contraception [1]; female emancipation / careers [1]; later marriage age [1]"${subGuidanceSnippet}
        },
        {
          "sub_id": "(b)(i)",
          "question_text": "(b) Study Fig. 1.2, a graph showing information about the population of MEDCs and LEDCs between 2015 and 2040 (estimated).\\n\\n(i) Compare the expected changes in the total population of MEDCs and LEDCs between 2015 and 2040. You should refer to years and use statistics in your answer.",
          "marks": 3,
          "has_diagram": true,
          "diagram_url": null,
          "diagram_source": "qp",
          "resource_ref": "Fig. 1.2",
          "page_number": 3,
          "insert_page_number": null,
          "bounding_box": [115, 360, 430, 785],
          "mark_scheme": "MEDC remains similar [1]; LEDC increases [1]; Stats: MEDC 1300 million every year but LEDC starts at 2190-2200 million in 2015 and expected to be 4000 million in 2040 [1]"${subGuidanceSnippet}
        },
        {
          "sub_id": "(b)(ii)",
          "question_text": "Describe the problems experienced in countries as a result of high rates of population growth.",
          "marks": 5,
          "has_diagram": false,
          "diagram_url": null,
          "diagram_source": null,
          "resource_ref": null,
          "mark_scheme": "Difficult to find housing / squatter settlements [1]; spread of disease [1]; lack of employment / poverty [1]; pressure on health services / education [1]; traffic congestion [1]; water/air pollution [1]"${subGuidanceSnippet}
        },
        {
          "sub_id": "(c)",
          "question_text": "For a named country you have studied, describe a policy used to influence its population growth rate.",
          "marks": 7,
          "has_diagram": false,
          "diagram_url": null,
          "diagram_source": null,
          "resource_ref": null,
          "mark_scheme": "Level 1 (1-3 marks): Limited detail describing population policy.\\nLevel 2 (4-6 marks): Developed statements explaining how policy influences growth rate.\\nLevel 3 (7 marks): Named example with place-specific details and developed points."${subGuidanceSnippet}
        }
      ],
      "mark_scheme": {
        "marking_points": ["See sub-question breakdown [25]"],
        "acceptable_answers": []${guidanceSchemaSnippet}
      }
    },
    {
      "question_number": "2",
      "parent_question_id": "Q2",
      "page_number": 6,
      "year": 2025,
      "series": "Oct/Nov",
      "paper_number": 11,
      "question_text": "2 (a) Study Fig. 2.1 (Insert), a map showing information about settlements in Extremadura, a region of Spain (an MEDC in Europe).",
      "question_style": "Structured",
      "total_marks": 25,
      "estimated_difficulty": "Medium",
      "topic": "Population and Settlement",
      "sub_topic": "Settlement and Service Provision",
      "has_diagram": true,
      "diagram_source": ${hasInsert ? '"insert"' : '"qp"'},
      "resource_ref": "Fig. 2.1",
      "insert_page_number": ${hasInsert ? '3' : 'null'},
      "bounding_box": [100, 150, 680, 850],
      "options": null,
      "sub_questions": [
        {
          "sub_id": "(a)(i)",
          "question_text": "How many settlements with a population of over 20000 are there in the Extremadura region?",
          "marks": 1,
          "has_diagram": false,
          "diagram_url": null,
          "diagram_source": null,
          "resource_ref": null,
          "mark_scheme": "7 [1]"${subGuidanceSnippet}
        },
        {
          "sub_id": "(a)(ii)",
          "question_text": "Using Fig. 2.1 only, describe the hierarchy of settlements in the Extremadura region.",
          "marks": 2,
          "has_diagram": false,
          "diagram_url": null,
          "diagram_source": null,
          "resource_ref": null,
          "mark_scheme": "Numbers of settlements decrease as population size increases [1]; exception at top with more over 20000 than 10000-19999 [1]"${subGuidanceSnippet}
        },
        {
          "sub_id": "(a)(iii)",
          "question_text": "Use the following words to fill in the table to show likely differences in service provision in the settlements labelled X and Y in Fig. 2.1:\\n*convenience, few, high, low, many, specialist*\\n\\n| | settlement X | settlement Y |\\n| :--- | :--- | :--- |\\n| **amount of services** | | |\\n| **order of services** | | |\\n| **type of services** | | |",
          "marks": 3,
          "has_diagram": false,
          "diagram_url": null,
          "diagram_source": null,
          "resource_ref": null,
          "mark_scheme": "settlement X: few, low, convenience [1.5]; settlement Y: many, high, specialist [1.5]"${subGuidanceSnippet}
        },
        {
          "sub_id": "(a)(iv)",
          "question_text": "Explain why the sphere of influence of settlement Z is likely to be large.",
          "marks": 4,
          "has_diagram": false,
          "diagram_url": null,
          "diagram_source": null,
          "resource_ref": null,
          "mark_scheme": "Many / variety of goods sold [1]; high order services / specialist goods [1]; people travel a long way [1]; good transport / road access [1]"${subGuidanceSnippet}
        },
        {
          "sub_id": "(b)(i)",
          "question_text": "(b) Study Figs. 2.2, 2.3 and 2.4 (Insert), photographs showing settlements with different functions.\\n\\n(i) Using evidence from Figs. 2.2, 2.3 and 2.4 only, identify the functions of each settlement.\\n\\nChoose your answers from the following list:\\n*commercial, cultural, industrial, mining, port, tourism*\\n\\n- Fig. 2.2: ...\\n- Fig. 2.3: ...\\n- Fig. 2.4: ...",
          "marks": 3,
          "has_diagram": true,
          "diagram_url": null,
          "diagram_source": ${hasInsert ? '"insert"' : '"qp"'},
          "resource_ref": "Figs. 2.2, 2.3 and 2.4",
          "insert_page_number": ${hasInsert ? '4' : 'null'},
          "page_number": ${hasInsert ? 'null' : '7'},
          "bounding_box": [120, 150, 850, 850],
          "mark_scheme": "Fig. 2.2 = port [1]; Fig. 2.3 = industrial [1]; Fig. 2.4 = commercial [1]"${subGuidanceSnippet}
        },
        {
          "sub_id": "(b)(ii)",
          "question_text": "Describe and explain the service provision in tourist resorts.",
          "marks": 5,
          "has_diagram": false,
          "diagram_url": null,
          "diagram_source": null,
          "resource_ref": null,
          "mark_scheme": "Hotels / accommodation [1]; restaurants / cafes [1]; transport / taxis / train station [1]; entertainment / museums [1]; souvenir shops [1]; tourist info [1]"${subGuidanceSnippet}
        },
        {
          "sub_id": "(c)",
          "question_text": "For a named settlement, state its main function and explain why it has this function.",
          "marks": 7,
          "has_diagram": false,
          "diagram_url": null,
          "diagram_source": null,
          "resource_ref": null,
          "mark_scheme": "Level 1 (1-3 marks): Simple statements explaining settlement function.\\nLevel 2 (4-6 marks): Developed statements explaining reasons for function.\\nLevel 3 (7 marks): Named example with place-specific detail."${subGuidanceSnippet}
        }
      ],
      "mark_scheme": {
        "marking_points": ["See sub-question breakdown [25]"],
        "acceptable_answers": []${guidanceSchemaSnippet}
      }
    }
  ]
}

CRITICAL FORMATTING RULES:
1. INSERT & DIAGRAM PLACEMENT:
   - Place the primary figure (e.g. Fig. 1.1 or Fig. 2.1 in Insert) at the Question stem BEFORE the sub-questions.
   - Do NOT duplicate the diagram on sub-questions (a)(i), (a)(ii), (a)(iii), (a)(iv).
   - If Part (b) introduces a new figure (e.g. Fig. 1.2 in Question Paper OR Figs. 2.2, 2.3, 2.4 in Insert), set has_diagram=true, diagram_source, bounding_box, page_number/insert_page_number on sub-question (b)(i).
2. DATA TABLES & FIELDWORK GRIDS:
   - When a question includes a data table or fill-in table (e.g. Question 2(a)(iii) settlement table), format the complete Markdown Table in question_text.
3. Group all sub-questions of Question 1, Question 2, etc. inside their parent question's sub_questions array.
4. EXTENDED CASE STUDY RESPONSE:
   - Transcribe full case study prompts (e.g. "(c) For a named country you have studied...").
5. BOUNDING BOXES FOR MAPS & PHOTOGRAPHS:
   - Make bounding boxes generous around the entire photograph, map, key/legend, and figure caption.
6. In JSON strings, escape quotes and backslashes properly.
7. SHARED READING PASSAGES & STIMULUS (English, Literature, History, Economics):
   - When multiple questions refer to a shared passage, poem, article, or case study (e.g. 'Read the text below and answer Questions 1 to 5'): preserve the full text.
   - Either place the stimulus text in the parent question stem with questions as sub_questions, OR attach the relevant excerpt/context to each linked question's 'question_text' so each question is fully comprehensible.
8. ANSWER KEYS & SOLUTIONS: If an answer key or solutions table appears on the final page (e.g., '1: B, 2: C, 3: A...'), use it to assign correct options and populate 'acceptable_answers' and 'marking_points'.
9. CURRENCY & PRICES: When transcribing prices or costs (e.g. $50, $12.50), write them as regular text without LaTeX math delimiters.
`;
}

/**
 * Builds the specialized Language, Literature, Reading Comprehension, and TKA/National Exam extraction prompt.
 * Focuses on reading passage preservation, 5-option MCQs (A-E/a-e), complex multiple select (Pilihan Ganda Kompleks),
 * matching/category tables (Menjodohkan), and in-PDF answer key/pembahasan parsing with 100% verbatim accuracy.
 */
export function getLanguageExtractionPrompt(includeGuidance: boolean = true): string {
  const guidanceSchemaSnippet = includeGuidance
    ? `,
      "guidance": [
        "Pembahasan: Teks secara eksplisit menyatakan...",
        "Pedagogical explanation of why Option C is correct and distractor analysis"
      ],
      "common_misconceptions": [
        "Common student error: confusing primary purpose with a supporting detail in paragraph 2",
        "Selecting only one option when multiple choices are required"
      ]`
    : '';

  return `You are an expert assessment parser specializing in English Language & Literature, Reading Comprehension, TKA / AKM / National Exams (e.g. SMA/MA Kelas 12 Bahasa Inggris), SAT, ACT, and Language Proficiency Assessments.
Analyze the attached exam paper PDF page(s) and any mark scheme / answer key content.

Extract every numbered question (e.g. Question 1, 2, 3... 30) as a structured JSON object.

CRITICAL READING COMPREHENSION & PASSAGE ASSOCIATION RULES:
1. FULL VERBATIM PASSAGE PRESERVATION & SECTION LINKING (NO TRUNCATION / NO ELLIPSIS):
   - ABSOLUTELY NEVER USE ELLIPSIS (...) OR TRUNCATE A READING TEXT!
   - You MUST extract and transcribe EVERY SINGLE WORD, SENTENCE, AND PARAGRAPH of the reading passage faithfully from top to bottom.
   - When a reading passage / stimulus text applies to a group of questions (e.g. Text 1 applies to Questions 1–4; Text 4 applies to Questions 14–18):
     * On the FIRST question of that passage group (e.g. Question 1): provide the complete reading text heading and ALL body paragraphs verbatim in "question_text", followed by the Question 1 prompt.
     * On subsequent questions in that group (e.g. Questions 2, 3, 4): include the passage header reference (e.g. "### Text 1: Exploring Komodo National Park\n\n**Question 2:** The text primarily discusses...") and the specific question stem/options. Our system automatically propagates the complete body paragraphs to all linked questions in the group!
     * NEVER omit, shorten, or summarize any paragraph from the reading passage.
   - Format "question_text" cleanly with Markdown:
     "### Text 1: Exploring Komodo National Park (KNP)\n(Descriptive/Expository Text, 4 Questions)\n\nKomodo National Park (KNP) in East Nusa Tenggara is a UNESCO World Heritage Site. The park was established to protect the endangered Komodo dragon and its habitat, but it also safeguards amazing marine and terrestrial biodiversity. The surrounding waters are part of the Coral Triangle, making it one of the planet's richest areas in terms of marine life.\n\nOne of its main attractions is Padar Island. A challenging trek takes visitors to the summit for an iconic view of three bays with different colored sand. This view is a paradise for photographers. Another popular attraction is Pink Beach, named after its unique sand color—a mixture of white sand and red coral fragments. The spot offers tranquility for swimming and relaxing.\n\nA visit to KNP is more than just tourism; it's a contribution to conservation. Every ticket purchased supports the protection of the endangered Komodo dragon. Through responsible exploration, visitors can enjoy the natural beauty while helping ensure the survival of this unique ecosystem.\n\n1. [Matching/Table] What is the main purpose of visitors coming to these places: supporting conservation or enjoying natural beauty? Click Conservation or Natural Beauty for each place!"

2. EXTRACT 100% OF ALL QUESTIONS WITHOUT SKIPPING ANY:
   - You MUST extract every numbered question (e.g. Question 1 to Question 30+) present across all pages.
   - Never skip, merge, or omit any question. Maintain sequential order.

3. 5-OPTION MULTIPLE CHOICE QUESTIONS (A, B, C, D, E or a, b, c, d, e):
   - When a question has 5 options (A–E or a–e) and exactly 1 correct answer:
   - Set "question_style": "Multiple Choice".
   - Extract ALL 5 options in "options": ["A. ...", "B. ...", "C. ...", "D. ...", "E. ..."].
   - Set "total_marks": 1.

4. MULTIPLE SELECT / COMPLEX MULTIPLE CHOICE ("Pilihan Ganda Kompleks" / "[Multiple Select]" / "There is more than one answer"):
   - When a question header specifies "[Multiple Select]" or "(There is more than one correct answer. Tick (✓) on every correct answer!)" or is classified as "Pilihan Ganda Kompleks" in the answer key:
   - Set "question_style": "Multiple Select".
   - Extract ALL choices (A–E) in "options".
   - In "mark_scheme":
     - Set "acceptable_answers": ["B, C"] (or ["B, C, E"], ["A, C, D"], etc.).
     - Set "marking_points": ["Correct options: B, C [2]"].
   - Assign appropriate total_marks (e.g. 2 or 3 marks).

5. MATCHING & CATEGORY TABLES ("Menjodohkan" / Matrix / Categorization):
   - When a question presents a classification table (e.g. "[Matching/Table]" or "Menjodohkan"):
   - Set "question_style": "Structured".
   - Transcribe the complete table as a clean Markdown Table inside "question_text":
     "| Place | Conservation | Natural Beauty |\\n|---|---|---|\\n| KNP Waters | [ ] | [ ] |\\n| Padar Island | [ ] | [ ] |\\n| Pink Beach | [ ] | [ ] |"
   - In "mark_scheme":
     - Set "acceptable_answers": ["KNP Waters: Conservation; Padar Island: Natural Beauty; Pink Beach: Natural Beauty"].
     - Set "marking_points": ["KNP Waters = Conservation [1]", "Padar Island = Natural Beauty [1]", "Pink Beach = Natural Beauty [1]"].

6. IN-PDF ANSWER KEYS & EXPLANATIONS ("Kunci Jawaban dan Pembahasan"):
   - Match each question number in the table (e.g. No. 1 to No. 30) with its question.
   - Extract the correct answer into "acceptable_answers" and "marking_points".
   - Extract the complete pedagogical explanation / reasoning ("Pembahasan") verbatim into "guidance" or "marking_points". DO NOT summarize the Pembahasan!

7. STRICT VERBATIM LANGUAGE PRESERVATION (ZERO UNWANTED TRANSLATIONS):
   - ABSOLUTELY NEVER translate English reading texts or questions into Indonesian.
   - ABSOLUTELY NEVER translate Indonesian instructions, headers, or "Pembahasan" into English.
   - Preserve the exact verbatim text and original language of all passages, questions, options, table rows, and explanations.

8. IELTS & CAMBRIDGE FILL-IN-THE-BLANK, FORM COMPLETION & NOTES COMPLETION (CRITICAL):
   - When a question requires filling in missing words/numbers in sentences, notes, forms, summaries, or tables:
     a) Set "question_style": "Fill in the Blank".
     b) Replace blank lines or dots with numbered bracket gaps "[1]", "[2]", "[3]" directly inside the sentence or form layout:
        e.g. "Customer Name: [1]\\nAddress: 42 [2] Avenue\\nDate of departure: [3]\\nType of ticket: [4]"
     c) Set "total_marks" to the number of gaps (e.g. 4 marks for 4 gaps).
     d) In "mark_scheme":
        - "marking_points": ["[1] John Smith [1]", "[2] Springfield [1]", "[3] 15 October / 15th October [1]", "[4] economy / return [1]"]
        - "acceptable_answers": ["[1] John Smith / J. Smith", "[2] Springfield / Springfield Ave", "[3] 15 October / October 15 / 15th Oct", "[4] economy / return ticket"]

Output strictly valid JSON matching this exact schema — no markdown fences, no commentary:

{
  "paper_metadata": {
    "subject": "English",
    "subject_code": "ENG",
    "year": 2026,
    "series": "Tray Out TKA",
    "paper_number": 1,
    "has_insert_booklet": false
  },
  "questions": [
    {
      "question_number": "1",
      "parent_question_id": "Q1",
      "page_number": 3,
      "year": 2026,
      "series": "TKA",
      "paper_number": 1,
      "question_text": "### Text 1: Exploring Komodo National Park (KNP)\\n(Descriptive/Expository Text, 4 Questions)\\n\\nKomodo National Park (KNP) in East Nusa Tenggara is a UNESCO World Heritage Site. The park was established to protect the endangered Komodo dragon and its habitat, but it also safeguards amazing marine and terrestrial biodiversity. The surrounding waters are part of the Coral Triangle, making it one of the planet's richest areas in terms of marine life.\\n\\nOne of its main attractions is Padar Island. A challenging trek takes visitors to the summit for an iconic view of three bays with different colored sand. This view is a paradise for photographers. Another popular attraction is Pink Beach, named after its unique sand color—a mixture of white sand and red coral fragments. The spot offers tranquility for swimming and relaxing.\\n\\nA visit to KNP is more than just tourism; it's a contribution to conservation. Every ticket purchased supports the protection of the endangered Komodo dragon. Through responsible exploration, visitors can enjoy the natural beauty while helping ensure the survival of this unique ecosystem.\\n\\n1. [Matching/Table] What is the main purpose of visitors coming to these places: supporting conservation or enjoying natural beauty? Click Conservation or Natural Beauty for each place!\\n\\n| Place | Conservation | Natural Beauty |\\n|---|---|---|\\n| KNP Waters | | |\\n| Padar Island | | |\\n| Pink Beach | | |",
      "question_style": "Structured",
      "total_marks": 3,
      "estimated_difficulty": "Medium",
      "topic": "Reading Comprehension - Descriptive Text",
      "sub_topic": "Categorization & Purpose",
      "has_diagram": false,
      "diagram_source": null,
      "bounding_box": null,
      "options": null,
      "sub_questions": [],
      "mark_scheme": {
        "marking_points": [
          "KNP Waters: Conservation [1]",
          "Padar Island: Natural Beauty [1]",
          "Pink Beach: Natural Beauty [1]"
        ],
        "acceptable_answers": [
          "KNP Waters: Conservation; Padar Island: Natural Beauty; Pink Beach: Natural Beauty"
        ]${guidanceSchemaSnippet}
      }
    },
    {
      "question_number": "2",
      "parent_question_id": "Q2",
      "page_number": 4,
      "year": 2026,
      "series": "TKA",
      "paper_number": 1,
      "question_text": "### Text 1: Exploring Komodo National Park (KNP)\\n(Descriptive/Expository Text, 4 Questions)\\n\\nKomodo National Park (KNP) in East Nusa Tenggara is a UNESCO World Heritage Site. The park was established to protect the endangered Komodo dragon and its habitat, but it also safeguards amazing marine and terrestrial biodiversity. The surrounding waters are part of the Coral Triangle, making it one of the planet's richest areas in terms of marine life.\\n\\nOne of its main attractions is Padar Island. A challenging trek takes visitors to the summit for an iconic view of three bays with different colored sand. This view is a paradise for photographers. Another popular attraction is Pink Beach, named after its unique sand color—a mixture of white sand and red coral fragments. The spot offers tranquility for swimming and relaxing.\\n\\nA visit to KNP is more than just tourism; it's a contribution to conservation. Every ticket purchased supports the protection of the endangered Komodo dragon. Through responsible exploration, visitors can enjoy the natural beauty while helping ensure the survival of this unique ecosystem.\\n\\n2. [Multiple Choice]\\nThe text primarily discusses...",
      "question_style": "Multiple Choice",
      "total_marks": 1,
      "estimated_difficulty": "Easy",
      "topic": "Reading Comprehension - Main Idea",
      "sub_topic": "General Understanding",
      "has_diagram": false,
      "diagram_source": null,
      "bounding_box": null,
      "options": [
        "A. Efforts to protect the Komodo dragon and islands in Indonesia.",
        "B. Marine biodiversity and coral reefs in the Coral Triangle.",
        "C. The natural beauty and importance of conservation at Komodo National Park.",
        "D. Diving and hiking activities available to tourists in Flores.",
        "E. Three bays with different colored sand on Padar Island."
      ],
      "sub_questions": [],
      "mark_scheme": {
        "marking_points": ["C [1]"],
        "acceptable_answers": ["C"]${guidanceSchemaSnippet}
      }
    },
    {
      "question_number": "3",
      "parent_question_id": "Q3",
      "page_number": 4,
      "year": 2026,
      "series": "TKA",
      "paper_number": 1,
      "question_text": "### Text 1: Exploring Komodo National Park (KNP)\\n(Descriptive/Expository Text, 4 Questions)\\n\\nKomodo National Park (KNP) in East Nusa Tenggara is a UNESCO World Heritage Site. The park was established to protect the endangered Komodo dragon and its habitat, but it also safeguards amazing marine and terrestrial biodiversity. The surrounding waters are part of the Coral Triangle, making it one of the planet's richest areas in terms of marine life.\\n\\nOne of its main attractions is Padar Island. A challenging trek takes visitors to the summit for an iconic view of three bays with different colored sand. This view is a paradise for photographers. Another popular attraction is Pink Beach, named after its unique sand color—a mixture of white sand and red coral fragments. The spot offers tranquility for swimming and relaxing.\\n\\nA visit to KNP is more than just tourism; it's a contribution to conservation. Every ticket purchased supports the protection of the endangered Komodo dragon. Through responsible exploration, visitors can enjoy the natural beauty while helping ensure the survival of this unique ecosystem.\\n\\n3. [Multiple Select]\\nWhich parts of the text best support the description of Komodo National Park as an \\"ecological paradise\\"? (There is more than one correct answer. Click on every correct answer!)",
      "question_style": "Multiple Select",
      "total_marks": 2,
      "estimated_difficulty": "Medium",
      "topic": "Reading Comprehension - Supporting Evidence",
      "sub_topic": "Multiple Select",
      "has_diagram": false,
      "diagram_source": null,
      "bounding_box": null,
      "options": [
        "A. The iconic view featuring three bays with different colored sand.",
        "B. The park was established to protect the Komodo dragon and its habitat, but it also safeguards amazing marine and terrestrial biodiversity.",
        "C. The surrounding waters are part of the Coral Triangle, making it one of the planet's richest areas in terms of marine life.",
        "D. Every ticket purchased supports the protection of the endangered Komodo dragon."
      ],
      "sub_questions": [],
      "mark_scheme": {
        "marking_points": ["B, C [2]"],
        "acceptable_answers": ["B, C", "B", "C"]${guidanceSchemaSnippet}
      }
    }
  ]
}
`;
}

/**
 * Main prompt dispatcher based on subject domain and insert configuration.
 */
export function getExtractionPrompt(
  includeGuidance: boolean = true,
  domain: SubjectDomain = 'stem',
  hasInsert: boolean = false,
  extractResourceCatalog: boolean = true
): string {
  if (domain === 'languages') {
    return getLanguageExtractionPrompt(includeGuidance);
  }
  if (domain === 'humanities') {
    return getHumanitiesExtractionPrompt(hasInsert, includeGuidance, extractResourceCatalog);
  }
  return getStemExtractionPrompt(includeGuidance);
}

/**
 * Repairs unescaped LaTeX backslashes and control characters in LLM JSON output.
 * Ensures LaTeX commands like \text, \frac, \times, \rightarrow, \theta, \beta, \Delta
 * are NEVER corrupted into JSON control characters like \t (tab), \f (formfeed), \r (CR), \b (backspace).
 */
export function sanitizeJsonString(input: string): string {
  let result = '';
  let inString = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (char === '"') {
      // Check if this quote is escaped
      let backslashCount = 0;
      let j = i - 1;
      while (j >= 0 && input[j] === '\\') {
        backslashCount++;
        j--;
      }
      if (backslashCount % 2 === 0) {
        inString = !inString;
      }
      result += char;
      continue;
    }

    if (inString && char === '\\') {
      const nextChar = input[i + 1];
      const afterNext = input[i + 2];

      // 1. Double backslash \\ already escaped -> keep as \\
      if (nextChar === '\\') {
        result += '\\\\';
        i++; // skip next backslash
        continue;
      }

      // 2. Standard JSON quote escape \"
      if (nextChar === '"') {
        result += '\\"';
        i++;
        continue;
      }

      // 3. Standard JSON slash escape \/
      if (nextChar === '/') {
        result += '\\/';
        i++;
        continue;
      }

      // 4. Check for genuine JSON newline \n vs LaTeX commands starting with n (\nu, \nabla, \neq)
      if (nextChar === 'n' && (!afterNext || !/[a-zA-Z]/.test(afterNext))) {
        result += '\\n';
        i++;
        continue;
      }

      // 5. Check for genuine JSON tab \t vs LaTeX commands starting with t (\text, \times, \theta, \to, \tan, \tau)
      if (nextChar === 't' && (!afterNext || !/[a-zA-Z]/.test(afterNext))) {
        result += '\\t';
        i++;
        continue;
      }

      // 6. Check for genuine JSON carriage return \r vs LaTeX (\rightarrow, \right, \rho)
      if (nextChar === 'r' && (!afterNext || !/[a-zA-Z]/.test(afterNext))) {
        result += '\\r';
        i++;
        continue;
      }

      // 7. All other backslashes followed by letters or LaTeX symbols (\text, \frac, \times, \Delta, etc.)
      // MUST be double-escaped as \\ so JSON.parse preserves the backslash in memory.
      result += '\\\\';
      continue;
    }

    if (inString) {
      if (char === '\n') {
        result += '\\n';
        continue;
      }
      if (char === '\r') {
        result += '\\r';
        continue;
      }
      if (char === '\t') {
        result += '\\t';
        continue;
      }
      const code = char.charCodeAt(0);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
        continue; // Strip invalid ASCII control characters
      }
    }

    result += char;
  }

  // Normalize malformed isotope notation like _^{40}_{20}W -> {}^{40}_{20}W
  result = result
    .replace(/_\^\{([^{}]+)\}_\{([^{}]+)\}/g, '{}^{$1}_{$2}')
    .replace(/_\{([^{}]+)\}\^\{([^{}]+)\}/g, '{}^{$2}_{$1}')
    .replace(/_\^\{([^{}]+)\}/g, '{}^{$1}');

  return result;
}

function fixTrailingCommas(input: string): string {
  return input.replace(/,\s*([}\]])/g, '$1');
}

function fixUnquotedKeys(input: string): string {
  return input.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
}

function fixMissingCommas(input: string): string {
  return input
    .replace(/\}\s*\{/g, '},{')
    .replace(/\]\s*\[/g, '],[')
    .replace(/"\s*\n\s*"/g, '",\n"');
}

/**
 * Repairs any truncated JSON (e.g. when LLM cuts off mid-string or mid-array)
 * by closing unclosed strings, stripping dangling commas, and closing open brackets/braces.
 */
function repairAnyTruncatedJson(input: string): string {
  let str = input.trim();
  let inString = false;
  let escaped = false;
  let openBrackets = 0;
  let openBraces = 0;

  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\') {
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (c === '[') openBrackets++;
      else if (c === ']') openBrackets = Math.max(0, openBrackets - 1);
      else if (c === '{') openBraces++;
      else if (c === '}') openBraces = Math.max(0, openBraces - 1);
    }
  }

  // If cut off inside an unclosed string, close the string quote
  if (inString) {
    str += '"';
  }

  // Remove any trailing dangling commas (e.g. `[ "A", "B", ` or `{ "k": "v", `)
  str = str.replace(/,\s*$/g, '');

  // Close unclosed brackets and braces
  while (openBrackets > 0) {
    str += ']';
    openBrackets--;
  }
  while (openBraces > 0) {
    str += '}';
    openBraces--;
  }

  return str;
}

/**
 * Attempts to repair truncated questions JSON by finding the last complete question object.
 */
function repairTruncatedQuestionsJson(input: string): string {
  let str = input.trim();
  const lastQuestionEnd = str.lastIndexOf('}');
  if (lastQuestionEnd !== -1) {
    const candidate = str.substring(0, lastQuestionEnd + 1);
    return repairAnyTruncatedJson(candidate);
  }
  return repairAnyTruncatedJson(input);
}

/**
 * Fallback item-by-item question extractor when global JSON.parse fails due to syntax anomalies.
 */
function extractQuestionsArrayFallback(text: string): { paper_metadata?: any; questions: any[] } | null {
  try {
    let paper_metadata: any = {};
    const metaMatch = text.match(/"paper_metadata"\s*:\s*\{([^}]+)\}/);
    if (metaMatch) {
      try {
        paper_metadata = JSON.parse(`{${metaMatch[1]}}`);
      } catch {}
    }

    const qArrayStart = text.indexOf('"questions"');
    if (qArrayStart === -1) return null;

    const bracketStart = text.indexOf('[', qArrayStart);
    if (bracketStart === -1) return null;

    const questionsText = text.slice(bracketStart);
    const questions: any[] = [];
    let inString = false;
    let escaped = false;
    let braceDepth = 0;
    let objStartIndex = -1;

    for (let i = 0; i < questionsText.length; i++) {
      const c = questionsText[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        continue;
      }
      if (c === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (c === '{') {
          if (braceDepth === 0) {
            objStartIndex = i;
          }
          braceDepth++;
        } else if (c === '}') {
          braceDepth--;
          if (braceDepth === 0 && objStartIndex !== -1) {
            const objStr = questionsText.slice(objStartIndex, i + 1);
            try {
              const parsedQ = JSON.parse(objStr);
              if (parsedQ && (parsedQ.question_number || parsedQ.question_text)) {
                questions.push(parsedQ);
              }
            } catch {
              try {
                const sanitizedObj = fixTrailingCommas(
                  fixUnquotedKeys(sanitizeJsonString(repairAnyTruncatedJson(objStr)))
                );
                const parsedQ = JSON.parse(sanitizedObj);
                if (parsedQ && (parsedQ.question_number || parsedQ.question_text)) {
                  questions.push(parsedQ);
                }
              } catch {}
            }
            objStartIndex = -1;
          }
        }
      }
    }

    if (questions.length > 0) {
      return { paper_metadata, questions };
    }
  } catch {}
  return null;
}

/**
 * Normalizes and removes common LLM extraction glitches like "extCH4", "ext{CH4}",
 * and raw control characters from accidental \t / \r / \f JSON parses.
 */
export function cleanExtAndLatexArtifacts(text: string): string {
  if (!text || typeof text !== 'string') return text || '';

  return text
    // Replace tab-corrupted \text, \times, \theta, \rightarrow, \frac
    .replace(/\t+ext(?=\{|\s*[A-Za-z0-9])/g, '\\text')
    .replace(/\t+imes\b/g, '\\times')
    .replace(/\t+heta\b/g, '\\theta')
    .replace(/\r+ightarrow\b/g, '\\rightarrow')
    .replace(/\r+ightleftharpoons\b/g, '\\rightleftharpoons')
    .replace(/\f+rac\b/g, '\\frac')
    .replace(/[\b]+eta\b/g, '\\beta')
    // Remove "ext" prefix accidentally added in front of chemical formulas (e.g. extCH4, extCO2, extH2O, extCaCO3, extHCl)
    .replace(/\bext([A-Z][a-z]?\d*(?:[A-Z][a-z]?\d*)*)\b/g, '$1')
    // Remove "ext{...}" (e.g. ext{CH}_4 -> CH_4 or ext{CaCO_3} -> CaCO_3)
    .replace(/\bext\{([^{}]+)\}/g, '$1');
}

export function parseRobustJson<T = any>(rawText: string): T {
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();

  // Attempt 1: Pre-sanitized LaTeX backslashes & valid JSON parse (protects \text from turning into tab)
  try {
    const sanitized = sanitizeJsonString(cleaned);
    return JSON.parse(sanitized);
  } catch {}

  // Attempt 2: Sanitized control chars + LaTeX backslashes + trailing commas
  try {
    const sanitized = fixTrailingCommas(sanitizeJsonString(cleaned));
    return JSON.parse(sanitized);
  } catch {}

  // Attempt 3: Fix unquoted keys and missing commas
  try {
    const fixedKeys = fixTrailingCommas(fixMissingCommas(fixUnquotedKeys(sanitizeJsonString(cleaned))));
    return JSON.parse(fixedKeys);
  } catch {}

  // Attempt 4: General truncation repair + sanitization
  try {
    const repaired = fixTrailingCommas(fixUnquotedKeys(sanitizeJsonString(repairAnyTruncatedJson(cleaned))));
    return JSON.parse(repaired);
  } catch {}

  // Attempt 5: Question list truncation recovery
  try {
    const repairedQuestions = fixTrailingCommas(
      fixUnquotedKeys(sanitizeJsonString(repairTruncatedQuestionsJson(cleaned)))
    );
    return JSON.parse(repairedQuestions);
  } catch {}

  // Attempt 6: Item-by-item question object recovery fallback
  const fallback = extractQuestionsArrayFallback(cleaned);
  if (fallback && fallback.questions && fallback.questions.length > 0) {
    return fallback as unknown as T;
  }

  // Attempt 7: Raw standard parse fallback
  try {
    return JSON.parse(cleaned);
  } catch {}

  throw new Error(
    `Failed to parse Gemini response as JSON.\n\nRaw output snippet:\n${cleaned.slice(0, 500)}`
  );
}

let cachedDiscoveredModels: string[] | null = null;

/**
 * Dynamically queries Google AI Studio API for all available models that support generateContent.
 * Caches results in memory to avoid 1.5-2.5s network latency on every upload.
 */
async function discoverAvailableModels(targetApiKey?: string): Promise<string[]> {
  if (cachedDiscoveredModels && cachedDiscoveredModels.length > 0) {
    return cachedDiscoveredModels;
  }

  const keyToUse = targetApiKey || getApiKeyForChunk(0);
  if (!keyToUse) return ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite'];

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${keyToUse}`
    );
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.models)) {
        const models = data.models
          .filter((m: any) =>
            m.supportedGenerationMethods?.includes('generateContent')
          )
          .map((m: any) => m.name.replace(/^models\//, ''))
          .filter(
            (name: string) =>
              name.toLowerCase().includes('gemini') &&
              !name.includes('flash-latest') && // Exclude legacy aliases that hang on v1beta
              !name.includes('flash-lite-latest')
          );

        // Prioritize active, ultra-fast vision Flash models (Gemini 3.5 Flash Lite -> Gemini 3.1 Flash Lite -> Gemini 3.6 Flash -> Gemini 3.5 Flash)
        models.sort((a: string, b: string) => {
          const score = (m: string) => {
            if (m === 'gemini-3.5-flash-lite') return 20;
            if (m === 'gemini-3.1-flash-lite') return 18;
            if (m === 'gemini-3.6-flash') return 16;
            if (m === 'gemini-3.7-flash') return 14;
            if (m === 'gemini-3.5-flash') return 10;
            if (m.includes('flash-lite')) return 8;
            if (m.includes('flash')) return 6;
            return 1;
          };
          return score(b) - score(a);
        });

        if (models.length > 0) {
          cachedDiscoveredModels = models;
          return models;
        }
      }
    }
  } catch (err) {
    console.warn('Failed to dynamically discover models:', err);
  }

  // Static fallback list with verified ultra-fast models
  const staticFallbacks = [
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
  ];
  cachedDiscoveredModels = staticFallbacks;
  return staticFallbacks;
}

/**
 * Helper to call a specific Gemini model endpoint with a custom prompt, target API key, and timeout.
 * Accepts optional markSchemeBase64 and insertBase64 (for Geography / Humanities insert booklets).
 * Supports automatic key failover if a 429 / 503 limit is encountered!
 */
async function callGeminiModel(
  modelName: string,
  pdfBase64: string,
  markSchemeBase64?: string,
  insertBase64?: string,
  promptText: string = getStemExtractionPrompt(true),
  targetApiKey?: string
): Promise<Response> {
  const keyPool = getGeminiApiKeys();
  const primaryKey = targetApiKey || keyPool[0] || import.meta.env.VITE_GEMINI_API_KEY || '';

  // Order candidate keys starting with primaryKey, followed by others in the pool
  const candidateKeys = [primaryKey, ...keyPool.filter((k) => k !== primaryKey)].filter(Boolean);

  let lastRes: Response | null = null;
  let lastErr: any = null;

  for (const currentKey of candidateKeys) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${currentKey}`;

    const parts: any[] = [
      { text: promptText },
      {
        inlineData: {
          mimeType: 'application/pdf',
          data: pdfBase64,
        },
      },
    ];

    if (insertBase64) {
      parts.push({
        inlineData: {
          mimeType: 'application/pdf',
          data: insertBase64,
        },
      });
    }

    if (markSchemeBase64) {
      parts.push({
        inlineData: {
          mimeType: 'application/pdf',
          data: markSchemeBase64,
        },
      });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 35000); // 35s timeout per model attempt

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.0,
            maxOutputTokens: 16384,
          },
        }),
      });
      clearTimeout(timeoutId);

      // If success or a non-quota client error (400/404), return immediately
      if (res.ok || (res.status !== 429 && res.status !== 503)) {
        return res;
      }

      lastRes = res;
      console.warn(`[Gemini] Key ending in ...${currentKey.slice(-6)} hit status ${res.status} on ${modelName}. Trying alternate key if available.`);
    } catch (err) {
      clearTimeout(timeoutId);
      lastErr = err;
      console.warn(`[Gemini] Key ending in ...${currentKey.slice(-6)} encountered error on ${modelName}:`, err);
    }
  }

  if (lastRes) return lastRes;
  if (lastErr) throw lastErr;
  throw new Error(`All candidate API keys failed for model ${modelName}.`);
}

export interface ExtractionOptions {
  includeGuidance?: boolean;
  domain?: SubjectDomain;
  hasInsertBooklet?: boolean;
  apiKey?: string;
  extractResourceCatalog?: boolean;
}

/**
 * Sends PDF files to Gemini for structured extraction with automated model discovery, key pooling, and fallback.
 * Accepts optional mark scheme PDF base64 and insert booklet PDF base64.
 * Returns parsed question data matching our ExtractionResult schema.
 */
export async function extractQuestionsFromPdf(
  pdfBase64: string,
  markSchemeBase64?: string,
  insertBase64?: string,
  onProgress?: (status: string) => void,
  options: ExtractionOptions = { includeGuidance: true, domain: 'stem' }
): Promise<ExtractionResult> {
  const activeKey = options.apiKey || getApiKeyForChunk(0);
  if (!activeKey) {
    throw new Error(
      'Missing VITE_GEMINI_API_KEY in .env.local. ' +
      'Get your API key from https://aistudio.google.com/apikey'
    );
  }

  const domain = options.domain || 'stem';
  const hasInsert = Boolean(insertBase64 || options.hasInsertBooklet);
  const promptText = getExtractionPrompt(
    options.includeGuidance !== false,
    domain,
    hasInsert,
    options.extractResourceCatalog !== false
  );

  onProgress?.('Discovering available Gemini models…');

  // If user configured a specific model, try it first
  const userConfiguredModel = import.meta.env.VITE_GEMINI_MODEL;
  const discoveredModels = await discoverAvailableModels(activeKey);

  const candidateModels = Array.from(
    new Set([userConfiguredModel, ...discoveredModels].filter(Boolean) as string[])
  );

  let lastError = '';
  let response: Response | null = null;
  let usedModel = '';

  for (const model of candidateModels) {
    onProgress?.(`Contacting Gemini AI (${model})…`);
    try {
      response = await callGeminiModel(model, pdfBase64, markSchemeBase64, insertBase64, promptText, activeKey);

      if (response.ok) {
        usedModel = model;
        break;
      }

      const errorBody = await response.text();
      lastError = `Model ${model} returned (${response.status}): ${errorBody}`;

      // If it's a 404 (model not found / deprecated) or 400 (unsupported), try next candidate model
      if (response.status === 404 || response.status === 400) {
        console.warn(`Model ${model} unavailable, trying fallback…`, errorBody);
        continue;
      }

      // If overloaded (503 / 429), immediately notify and try next candidate model
      if (response.status === 503 || response.status === 429) {
        onProgress?.(`Model ${model} is busy (status ${response.status}), switching to next model…`);
        continue;
      }

      // If other error, still try the next model
      continue;
    } catch (err: any) {
      lastError = err?.message || 'Network error';
    }
  }

  if (!response || !response.ok) {
    throw new Error(
      `All candidate Gemini models failed. Candidates tried: [${candidateModels.join(', ')}]. Last error: ${lastError}`
    );
  }

  onProgress?.(`Parsing AI response from ${usedModel}…`);

  const rawData = await response.json();
  const extractedText = rawData.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!extractedText) {
    throw new Error('Gemini returned an empty response. The PDF may be unreadable or too large.');
  }

  const parsed: ExtractionResult = parseRobustJson<ExtractionResult>(extractedText);

  if (!parsed.paper_metadata || !Array.isArray(parsed.questions)) {
    throw new Error('Response missing required paper_metadata or questions array.');
  }

  // Normalize all questions to clean ext artifacts and ensure bare LaTeX formulas outside $ are wrapped in $...$
  parsed.questions = parsed.questions.map((q) => ({
    ...q,
    diagram_source: q.diagram_source || (hasInsert && q.resource_ref ? 'insert' : q.has_diagram ? 'qp' : null),
    question_text: ensureInlineMathDelimiters(cleanExtAndLatexArtifacts(q.question_text || '')),
    options: Array.isArray(q.options)
      ? q.options.map((opt) => (typeof opt === 'string' ? ensureInlineMathDelimiters(cleanExtAndLatexArtifacts(opt)) : opt))
      : q.options,
    sub_questions: Array.isArray(q.sub_questions)
      ? q.sub_questions.map((sq) => ({
          ...sq,
          diagram_source: sq.diagram_source || (hasInsert && sq.resource_ref ? 'insert' : sq.diagram_url ? 'qp' : null),
          question_text: ensureInlineMathDelimiters(cleanExtAndLatexArtifacts(sq.question_text || '')),
          mark_scheme: sq.mark_scheme ? ensureInlineMathDelimiters(cleanExtAndLatexArtifacts(sq.mark_scheme)) : sq.mark_scheme,
        }))
      : q.sub_questions,
  }));

  onProgress?.(`Extracted ${parsed.questions.length} questions successfully using ${usedModel}.`);
  return parsed;
}

/**
 * On-demand AI enrichment: Generates teacher marking guidance, examiner tips,
 * and common student misconceptions for a single existing Question.
 */
export async function enrichQuestionWithGuidance(
  question: Question
): Promise<{
  guidance: string[];
  common_misconceptions: string[];
  sub_questions?: SubQuestion[];
}> {
  const activeKey = getApiKeyForChunk(0);
  if (!activeKey) {
    throw new Error(
      'Missing VITE_GEMINI_API_KEY in .env.local. ' +
      'Get your API key from https://aistudio.google.com/apikey'
    );
  }

  const userConfiguredModel = import.meta.env.VITE_GEMINI_MODEL;
  const discoveredModels = await discoverAvailableModels(activeKey);
  const candidateModels = Array.from(
    new Set([userConfiguredModel, ...discoveredModels].filter(Boolean) as string[])
  );

  const prompt = `You are a chief examiner and educational assessment expert.
Analyze this exam question and generate actionable teacher marking guidance and common student misconceptions:

Question:
Topic: ${question.topic || 'General'}
Question Number: ${question.question_number}
Question Text: ${question.question_text}
Total Marks: ${question.marks}
Options: ${question.options ? JSON.stringify(question.options) : 'N/A'}
Sub-questions: ${JSON.stringify(question.sub_questions || [])}
Existing Mark Scheme: ${JSON.stringify(question.mark_scheme || {})}

Return strictly valid JSON with this schema (no markdown formatting, no commentary):
{
  "guidance": [
    "Practical teacher marking note: specific method mark criteria (M1, A1), acceptable alternative notations, error carried forward rules, or required units."
  ],
  "common_misconceptions": [
    "Typical student error, conceptual misconception, or arithmetic trap."
  ],
  "sub_questions": [
    {
      "sub_id": "(a)",
      "guidance": "Examiner guidance for sub-question",
      "common_misconceptions": ["Student misconception for sub-question"]
    }
  ]
}`;

  let response: Response | null = null;
  let lastError = '';

  for (const model of candidateModels) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${activeKey}`;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.2,
            maxOutputTokens: 2048,
          },
        }),
      });

      if (response.ok) break;
      lastError = await response.text();
    } catch (e: any) {
      lastError = e?.message || 'Network error';
    }
  }

  if (!response || !response.ok) {
    throw new Error(`Failed to enrich question with AI guidance: ${lastError}`);
  }

  const rawData = await response.json();
  const text = rawData.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('AI returned empty response for guidance enrichment.');

  const parsed = parseRobustJson<{
    guidance: string[];
    common_misconceptions: string[];
    sub_questions?: { sub_id: string; guidance?: string; common_misconceptions?: string[] }[];
  }>(text);

  // Merge sub-question guidance back into existing sub_questions if present
  let mergedSubQuestions: SubQuestion[] | undefined = undefined;
  if (question.sub_questions && question.sub_questions.length > 0) {
    mergedSubQuestions = question.sub_questions.map((sq) => {
      const match = parsed.sub_questions?.find((pSq) => pSq.sub_id === sq.sub_id);
      return {
        ...sq,
        guidance: match?.guidance || sq.guidance,
        common_misconceptions: match?.common_misconceptions || sq.common_misconceptions,
      };
    });
  }

  return {
    guidance: parsed.guidance || [],
    common_misconceptions: parsed.common_misconceptions || [],
    sub_questions: mergedSubQuestions,
  };
}

/**
 * Converts a File object to a base64 string (without the data URI prefix).
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

export type VariantMode = 'parallel' | 'scaffold' | 'extension' | 'mcq' | 'structured';

export interface GenerateVariantOptions {
  mode: VariantMode;
  customInstruction?: string;
}

/**
 * Generates an educational variant of an existing question using Gemini.
 */
export async function generateQuestionVariant(
  original: Question,
  options: GenerateVariantOptions
): Promise<Partial<Question>> {
  const activeKey = getApiKeyForChunk(0);
  if (!activeKey) {
    throw new Error(
      'Missing VITE_GEMINI_API_KEY in .env.local. ' +
      'Get your API key from https://aistudio.google.com/apikey'
    );
  }

  let modeInstruction = '';
  switch (options.mode) {
    case 'parallel':
      modeInstruction = `Generate a PARALLEL TWIN question. Keep the exact same format (${original.question_style || 'Structured'}), total marks (${original.marks}), and structure. Alter numerical values, chemical compounds, biological specimens, or physical contexts while testing the identical core concepts.`;
      break;
    case 'scaffold':
      modeInstruction = `Generate a SCAFFOLDED / FOUNDATION variant. Make this question slightly more accessible (Easy / Foundation level) by breaking down complex multi-step reasoning into step-by-step guided sub-parts, providing clearer scaffolding prompts, or using simpler numerical values.`;
      break;
    case 'extension':
      modeInstruction = `Generate a CHALLENGING EXTENSION variant. Increase the difficulty (Hard / Higher-order thinking) by combining concepts, asking for evaluation/justification, requiring inverted algebraic calculations, or removing scaffolding.`;
      break;
    case 'mcq':
      modeInstruction = `CONVERT TO MULTIPLE CHOICE (CRITICAL):
Transform this question into a single 4-option Multiple Choice Question (options A, B, C, D) with 1 correct option and 3 plausible distractors.
- "question_style": "Multiple Choice"
- "options": ["A. ...", "B. ...", "C. ...", "D. ..."]
- "marks": 1
- "sub_questions": [] (MUST BE EMPTY).`;
      break;
    case 'structured':
      modeInstruction = `CONVERT TO STRUCTURED (CRITICAL):
Transform this into an open-ended, multi-part Structured Theory Question with 2 to 4 sub-questions (e.g. (a), (b)(i), (b)(ii), (c)) with written explanations, definitions, calculations, or justifications totaling around ${Math.max(Number(original.marks) || 1, 4)} marks.
- "question_style": "Structured"
- "options": null (DO NOT output multiple choice options! "options" MUST BE NULL)
- "sub_questions": MUST contain at least 2 structured sub-parts [(a), (b)...], each with its own "sub_id", "question_text", "marks", and "mark_scheme".`;
      break;
  }

  const customPromptSnippet = options.customInstruction
    ? `\nTEACHER CUSTOM INSTRUCTION: "${options.customInstruction}"\n`
    : '';

  const prompt = `You are an expert exam author for Cambridge IGCSE, GCSE, and A-Level assessments.
Create a new syllabus-aligned variant of the following exam question.

ORIGINAL QUESTION DETAILS:
- Topic: ${original.topic}
- Sub-topic: ${original.sub_topic || 'N/A'}
- Style: ${original.question_style}
- Difficulty: ${original.difficulty}
- Total Marks: ${original.marks}
- Stem: ${original.question_text}
${original.diagram_url ? `- Has Diagram/Visual Resource: Yes (${original.resource_ref ? `Referenced as ${original.resource_ref}` : 'Visual figure/diagram attached'}). The variant question retains this visual context.` : ''}
${original.options ? `- Original Options: ${JSON.stringify(original.options)}` : ''}
${original.sub_questions && original.sub_questions.length > 0 ? `- Original Sub-questions: ${JSON.stringify(original.sub_questions)}` : ''}
${original.mark_scheme ? `- Original Mark Scheme: ${JSON.stringify(original.mark_scheme)}` : ''}

GENERATION GOAL:
${modeInstruction}
${customPromptSnippet}

REQUIREMENTS:
1. Wrap ALL chemical formulas, scientific notation, units, and math equations in LaTeX ($...$ for inline, $$...$$ for block). Example: $CaCO_3$, $\\frac{2}{3}$, $1.5\\times 10^5\\text{ Pa}$, $dm^3$.
2. For structured questions, generate a coherent stem and an array of sub_questions, each with sub_id, question_text, marks, and mark_scheme. "options" MUST BE null!
3. For MCQ questions, generate 4 options A, B, C, D and leave sub_questions empty.
4. If the original question contains or references a diagram, figure, chart, or apparatus (e.g. "Fig. 1.1", "the diagram shows...", etc.), retain or adapt appropriate references to the diagram/figure so that the generated variant makes sense with the transferred diagram/picture.
5. Provide a complete, rigorous mark_scheme object containing:
   - "marking_points": string array with mark allocations in square brackets (e.g. "Calculates moles of $HCl$: $0.05\\text{ mol}$ [1]")
   - "acceptable_answers": string array of allowed alternatives
   - "guidance": string array with examiner advice
   - "common_misconceptions": string array of student mistakes
6. Return strictly a single valid JSON object matching the schema below (no code block ticks, no markdown formatting outside JSON):

{
  "question_text": "The main question stem or context",
  "question_style": "${options.mode === 'mcq' ? 'Multiple Choice' : options.mode === 'structured' ? 'Structured' : original.question_style || 'Structured'}",
  "marks": ${options.mode === 'mcq' ? 1 : original.marks || 4},
  "difficulty": "${options.mode === 'scaffold' ? 'Easy' : options.mode === 'extension' ? 'Hard' : original.difficulty || 'Medium'}",
  "topic": "${original.topic}",
  "sub_topic": "${original.sub_topic || ''}",
  "options": ${options.mode === 'mcq' ? '["A. ...", "B. ...", "C. ...", "D. ..."]' : 'null'},
  "sub_questions": ${options.mode === 'mcq' ? '[]' : '[{"sub_id": "(a)", "question_text": "...", "marks": 2, "mark_scheme": "Mark point [2]"}]'},
  "mark_scheme": {
    "marking_points": ["Mark point [1]"],
    "acceptable_answers": ["Alternative answer"],
    "guidance": ["Examiner tip 1"],
    "common_misconceptions": ["Misconception 1"]
  }
} `;

  const availableModels = await discoverAvailableModels(activeKey);
  let response: Response | null = null;
  let lastError = '';

  for (const modelName of availableModels) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${activeKey}`;
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.3,
            maxOutputTokens: 8192,
          },
        }),
      });

      if (response.ok) break;
      lastError = await response.text();
    } catch (e: any) {
      lastError = e?.message || 'Network error';
    }
  }

  if (!response || !response.ok) {
    throw new Error(`Failed to generate question variant: ${lastError}`);
  }

  const rawData = await response.json();
  const text = rawData.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('AI returned empty response for question variant.');

  const parsed = parseRobustJson<any>(text);

  // Sanitize sub-questions while preserving diagram and metadata from original where applicable
  let sanitizedSubs: SubQuestion[] = Array.isArray(parsed.sub_questions)
    ? parsed.sub_questions.map((sub: any, idx: number) => {
        const origSub = original.sub_questions?.find((os) => os.sub_id === sub.sub_id) || original.sub_questions?.[idx];
        const subDiagramUrl = sub.diagram_url || origSub?.diagram_url || null;
        return {
          sub_id: String(sub.sub_id || ''),
          question_text: String(sub.question_text || ''),
          marks: Number(sub.marks) || 1,
          has_diagram: Boolean(subDiagramUrl || sub.has_diagram || origSub?.has_diagram),
          diagram_url: subDiagramUrl,
          diagram_source: sub.diagram_source || origSub?.diagram_source || null,
          resource_ref: sub.resource_ref || origSub?.resource_ref || null,
          page_number: sub.page_number || origSub?.page_number || null,
          insert_page_number: sub.insert_page_number || origSub?.insert_page_number || null,
          bounding_box: sub.bounding_box || origSub?.bounding_box || null,
          audio_url: sub.audio_url || origSub?.audio_url || null,
          audio_metadata: sub.audio_metadata || origSub?.audio_metadata || null,
          options: Array.isArray(sub.options) ? sub.options : (origSub?.options || null),
          mark_scheme: typeof sub.mark_scheme === 'string'
            ? sub.mark_scheme
            : (sub.mark_scheme?.marking_points
                ? (Array.isArray(sub.mark_scheme.marking_points) ? sub.mark_scheme.marking_points.join('; ') : String(sub.mark_scheme.marking_points))
                : (sub.mark_scheme ? JSON.stringify(sub.mark_scheme) : '')),
          guidance: typeof sub.guidance === 'string'
            ? sub.guidance
            : (Array.isArray(sub.guidance) ? sub.guidance.join('; ') : (sub.guidance ? JSON.stringify(sub.guidance) : '')),
          common_misconceptions: Array.isArray(sub.common_misconceptions)
            ? sub.common_misconceptions.map(String)
            : (typeof sub.common_misconceptions === 'string' ? [sub.common_misconceptions] : []),
        };
      })
    : [];

  // If structured mode was requested but LLM didn't return sub-questions, synthesize basic parts
  if (options.mode === 'structured' && sanitizedSubs.length === 0) {
    sanitizedSubs = [
      {
        sub_id: '(a)',
        question_text: parsed.question_text || 'Explain the underlying chemical/physical principle.',
        marks: 1,
        mark_scheme: parsed.mark_scheme?.marking_points?.[0] || 'Correct explanation [1]',
      },
      {
        sub_id: '(b)',
        question_text: 'Describe one method to verify this result experimentally.',
        marks: 2,
        mark_scheme: 'Apparatus described [1]; measurement recorded [1]',
      },
    ];
  }

  // Format resolution based on requested mode
  let finalStyle: QuestionStyle = 'Structured';
  let finalOptions: string[] | null = null;
  let finalSubs: SubQuestion[] | undefined = undefined;

  if (options.mode === 'mcq') {
    finalStyle = 'Multiple Choice';
    finalOptions = Array.isArray(parsed.options) && parsed.options.length > 0
      ? parsed.options.map(String)
      : ['A. Option A', 'B. Option B', 'C. Option C', 'D. Option D'];
    finalSubs = undefined;
  } else if (options.mode === 'structured') {
    finalStyle = 'Structured';
    finalOptions = null;
    finalSubs = sanitizedSubs.length > 0 ? sanitizedSubs : undefined;
  } else {
    finalStyle = (parsed.question_style as QuestionStyle) || original.question_style || 'Structured';
    finalOptions = finalStyle === 'Multiple Choice' && Array.isArray(parsed.options)
      ? parsed.options.map(String)
      : null;
    finalSubs = finalStyle !== 'Multiple Choice' && sanitizedSubs.length > 0
      ? sanitizedSubs
      : undefined;
  }

  // Calculate total marks
  const computedMarks = finalSubs && finalSubs.length > 0
    ? finalSubs.reduce((sum, s) => sum + s.marks, 0)
    : (finalStyle === 'Multiple Choice' ? 1 : Number(parsed.marks) || original.marks || 1);

  // Sanitize mark scheme
  const sanitizedMarkScheme = {
    marking_points: Array.isArray(parsed.mark_scheme?.marking_points)
      ? parsed.mark_scheme.marking_points.map(String)
      : (parsed.mark_scheme?.marking_points ? [String(parsed.mark_scheme.marking_points)] : ['See sub-question breakdown']),
    acceptable_answers: Array.isArray(parsed.mark_scheme?.acceptable_answers)
      ? parsed.mark_scheme.acceptable_answers.map(String)
      : [],
    guidance: Array.isArray(parsed.mark_scheme?.guidance)
      ? parsed.mark_scheme.guidance.map(String)
      : [],
    common_misconceptions: Array.isArray(parsed.mark_scheme?.common_misconceptions)
      ? parsed.mark_scheme.common_misconceptions.map(String)
      : [],
  };

  return {
    syllabus_id: original.syllabus_id,
    year: original.year || new Date().getFullYear(),
    series: original.series || 'Variant',
    paper_number: original.paper_number || 1,
    question_number: `${original.question_number} (Variant)`,
    question_text: String(parsed.question_text || ''),
    question_style: finalStyle,
    topic: parsed.topic || original.topic,
    sub_topic: parsed.sub_topic || original.sub_topic,
    difficulty: parsed.difficulty || original.difficulty,
    marks: computedMarks,
    options: finalOptions,
    sub_questions: finalSubs,
    mark_scheme: sanitizedMarkScheme,
    diagram_url: original.diagram_url || null,
    diagram_source: original.diagram_source || null,
    resource_ref: original.resource_ref || null,
    insert_page_number: original.insert_page_number || null,
    audio_url: original.audio_url || null,
    audio_metadata: original.audio_metadata || null,
  };
}
