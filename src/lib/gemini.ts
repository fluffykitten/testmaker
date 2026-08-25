// ─── Gemini API Integration ──────────────────────────────────────────────────
// Sends PDF pages to Google's multimodal AI for structured question extraction.
// Features dynamic model discovery, auto-fallback, and retry.

import type { ExtractionResult, Question, SubQuestion, QuestionStyle } from '../types/database';
import { ensureInlineMathDelimiters } from '../components/ExamMathText';

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;

/**
 * Builds the extraction prompt sent alongside each PDF.
 * When includeGuidance is true, instructs Gemini to generate rich teacher marking guidance
 * and common student misconceptions/traps.
 */
export function getExtractionPrompt(includeGuidance: boolean = true): string {
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

  return `You are an expert educational assessment parser. Analyze the attached exam past paper PDF page(s) and any mark scheme content.

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
    "paper_number": 41
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
          "question_text": "Describe one effect of increasing the temperature on the collisions between reacting particles.",
          "marks": 2,
          "mark_scheme": "Particles have greater kinetic energy [1]; more collisions have energy $\\ge E_a$ [1]"${subGuidanceSnippet}
        }
      ],
      "mark_scheme": {
        "marking_points": ["See sub-question breakdown [7]"],
        "acceptable_answers": []${guidanceSchemaSnippet}
      }
    }
  ]
}

CRITICAL FORMATTING RULES:
1. Identify the exact paper provenance in paper_metadata and each question:
   - "series": Examination series/month, e.g., "Oct/Nov", "May/June", "Feb/March", "Winter", "Summer", or "Specimen".
   - "year": 4-digit exam year, e.g. 2024, 2025.
   - "paper_number": Specific paper number or variant, e.g. 1, 2, 4, 11, 21, 41, 42, 61.
2. Group all sub-questions of Question 1, Question 2, Question 3 etc. inside their parent question's sub_questions array. Do not fragment them into separate top-level questions.
3. Convert ALL mathematical symbols, chemical formulas, and equations to LaTeX enclosed in single dollar signs (e.g. '$CaCO_3$', '$\\text{Fe}_2\\text{O}_3$', '$0.05 \\times 24 = 1.2\\text{ dm}^3$'). NEVER leave bare LaTeX commands like '\\text{Fe}_{2}\\text{O}_{3}' or '\\frac{1}{2}' unenclosed without dollar signs in regular sentence text. For nuclide/isotope notation, use standard LaTeX format: '{}^{40}_{20}\\text{W}' or '{}^{A}_{Z}\\text{X}'. Never use '_^{40}'.
4. TABLE EXTRACTION (CRITICAL):
   - Transcribe ALL standard data tables, experimental results, titration data, physical properties tables, organic reaction test tables, and student completion/fill-in tables into clean, structured Markdown Tables (| Header 1 | Header 2 | ... |\\n|---|---|---|...|) directly inside "question_text" or "sub_questions[].question_text".
   - Preserve all row and column headers, values, units (e.g. $g/cm^3$, $^\\circ\\text{C}$), and blank fill-in cells ([       ]).
   - ALWAYS do BOTH for standard data tables: (1) transcribe the table as a Markdown table in question_text AND (2) set has_diagram=true with a bounding_box that crops the original table image from the PDF.
   - EXCEPTION FOR PERIODIC TABLE OUTLINES / GRIDS: If a question shows a Periodic Table outline or grid labeled as a figure (e.g., "Fig. 1.1 shows part of the Periodic Table" or a grid with Roman numeral groups I to VIII):
     * Do NOT attempt to transcribe the Periodic Table as a markdown table (the stepped layout and empty groups will distort).
     * Instead, treat it as a DIAGRAM (Rule 5): set has_diagram=true and provide an accurate bounding_box to crop the Periodic Table figure cleanly.
5. DIAGRAMS, GRAPHS & PROCESS FLOWCHARTS (CRITICAL):
    - Set has_diagram=true for visual drawings, apparatus setups, graphs/curves, electrical circuit schematics, biological cell illustrations, reaction/process diagrams, and PERIODIC TABLE OUTLINES/GRIDS (e.g. Fig. 1.1).
    - PROCESS FLOWCHARTS & FILL-IN BOXES: When a question shows a sequence of stages with boxes and arrows or fill-in boxes (e.g. Fig. 3.1 showing water treatment stages, industrial flowcharts, reaction pathways):
      a) DIAGRAM CROPPING: Set has_diagram=true and set bounding_box [ymin, xmin, ymax, xmax] to fully enclose the flowchart boxes, arrows, labels, and figure caption (e.g. "Fig. 3.1").
      b) TEXT TRANSCRIBING: In "question_text", transcribe the flowchart sequence in structured box format:
         [ sedimentation ] → [ filtration ] → [ use of carbon ] → [ ................................ ]
         Fig. 3.1
    - BOUNDING BOX GOLDEN RULE: It is MUCH better to make the bounding box TOO LARGE than too small. A slightly oversized box can be trimmed later, but a cropped-off diagram is useless. When in doubt, EXTEND the box generously with AT LEAST 80 units of margin on ALL 4 sides.
    - FULL VERTICAL SCAN: Before setting ymax, visually scan ALL the way down to find the true bottom edge and figure caption. Set ymax to capture EVERYTHING.
    - STOP AT NEXT QUESTION BOUNDARY: Never allow ymax to overshoot into the next question.
6. TICK BOX & CHECKBOX QUESTIONS (CRITICAL):
    - When a structured sub-question asks students to "Tick (✓) one box" or "Tick (✓) two boxes" or choose from a list with checkboxes:
      a) In "question_text" or "sub_questions[].question_text", preserve the prompt and format all choices with checkbox brackets [ ]:
         Choose the correct statement that describes the structure and bonding in graphite.
         Tick (✓) one box.
         simple covalent molecule [ ]
         giant ionic [ ]
         simple ionic [ ]
         giant covalent [ ]
      b) Set "options": ["simple covalent molecule", "giant ionic", "simple ionic", "giant covalent"] on that sub-question object.
      c) In "mark_scheme", state which box is correct (e.g. "giant covalent [1]").
7. question_style must be one of: "Structured", "Multiple Choice", "Calculation", "Short Answer".
8. estimated_difficulty must be one of: "Easy", "Medium", "Hard".
9. Keep full question text — do not omit sub-questions.
10. If a question has no sub-parts (like an MCQ in Paper 1 or Paper 2), set "sub_questions": [] and put options in "options".
11. In LaTeX formulas, always escape backslashes properly in JSON strings (use \\\\rightarrow, \\\\frac, \\\\Delta, \\\\text, \\\\times, \\\\ge).
${
  includeGuidance
    ? `12. TEACHER MARKING GUIDANCE & COMMON MISCONCEPTIONS (CRITICAL):
    - For "guidance": Provide 1-3 concrete, high-utility teacher marking notes (e.g. method marks (M1, A1), error carried forward (ecf) rules, acceptable alternative units/notations, required significant figures).
    - For "common_misconceptions": Provide 1-3 specific mistakes, traps, or false intuitions students typically make on this specific question.`
    : ''
}`;
}

/**
 * Repairs unescaped LaTeX backslashes and control characters in LLM JSON output.
 */
function sanitizeJsonString(input: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      const next = input[i + 1];
      // In JSON, only \" and \\ are universally safe escapes.
      // If backslash is followed by an alphabet character (e.g. \text, \frac, \times, \rightarrow, \Delta, \begin),
      // it is a LaTeX command and must be double-escaped as \\.
      if (next === '"' || next === '\\' || next === '/') {
        result += char;
        escaped = true;
      } else if (next === 'n' && (input[i + 2] === ' ' || input[i + 2] === '\n' || input[i + 2] === '"' || !input[i + 2])) {
        // Genuine newline escape \n
        result += char;
        escaped = true;
      } else {
        // LaTeX backslash (e.g. \text, \times, \Delta, \frac, \cdot, \rightarrow) -> escape as \\
        result += '\\\\';
      }
      continue;
    }

    if (char === '"') {
      inString = !inString;
      result += char;
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

export function parseRobustJson<T = any>(rawText: string): T {
  let cleaned = rawText.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();

  // Attempt 1: Standard parse
  try {
    return JSON.parse(cleaned);
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

  throw new Error(
    `Failed to parse Gemini response as JSON.\n\nRaw output snippet:\n${cleaned.slice(0, 500)}`
  );
}

/**
 * Dynamically queries Google AI Studio API for all available models that support generateContent.
 */
async function discoverAvailableModels(): Promise<string[]> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`
    );
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.models)) {
        const models = data.models
          .filter((m: any) =>
            m.supportedGenerationMethods?.includes('generateContent')
          )
          .map((m: any) => m.name.replace(/^models\//, ''))
          .filter((name: string) => name.toLowerCase().includes('gemini'));

        // Prioritize flash models, then pro
        models.sort((a: string, b: string) => {
          const aFlash = a.includes('flash') ? 1 : 0;
          const bFlash = b.includes('flash') ? 1 : 0;
          return bFlash - aFlash;
        });

        if (models.length > 0) {
          return models;
        }
      }
    }
  } catch (err) {
    console.warn('Failed to dynamically discover models:', err);
  }

  // Static fallback list if discovery fails
  return [
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest',
    'gemini-1.5-pro',
    'gemini-1.5-pro-latest',
    'gemini-2.0-flash',
    'gemini-2.5-flash',
  ];
}

/**
 * Helper to call a specific Gemini model endpoint with a custom prompt
 */
async function callGeminiModel(
  modelName: string,
  pdfBase64: string,
  markSchemeBase64?: string,
  promptText: string = getExtractionPrompt(true)
): Promise<Response> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
  
  const parts: any[] = [
    { text: promptText },
    {
      inlineData: {
        mimeType: 'application/pdf',
        data: pdfBase64,
      },
    },
  ];

  if (markSchemeBase64) {
    parts.push({
      inlineData: {
        mimeType: 'application/pdf',
        data: markSchemeBase64,
      },
    });
  }

  return fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts,
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1,
        maxOutputTokens: 16384,
      },
    }),
  });
}

export interface ExtractionOptions {
  includeGuidance?: boolean;
}

/**
 * Sends a PDF file to Gemini for structured extraction with automated model discovery and fallback.
 * Accepts optional mark scheme PDF base64 to pair official mark schemes with 100% fidelity.
 * Returns parsed question data matching our ExtractionResult schema.
 */
export async function extractQuestionsFromPdf(
  pdfBase64: string,
  markSchemeBase64?: string,
  onProgress?: (status: string) => void,
  options: ExtractionOptions = { includeGuidance: true }
): Promise<ExtractionResult> {
  if (!GEMINI_API_KEY) {
    throw new Error(
      'Missing VITE_GEMINI_API_KEY in .env.local. ' +
      'Get your API key from https://aistudio.google.com/apikey'
    );
  }

  const promptText = getExtractionPrompt(options.includeGuidance !== false);

  onProgress?.('Discovering available Gemini models…');

  // If user configured a specific model, try it first
  const userConfiguredModel = import.meta.env.VITE_GEMINI_MODEL;
  const discoveredModels = await discoverAvailableModels();

  const candidateModels = Array.from(
    new Set([userConfiguredModel, ...discoveredModels].filter(Boolean) as string[])
  );

  let lastError = '';
  let response: Response | null = null;
  let usedModel = '';

  for (const model of candidateModels) {
    onProgress?.(`Contacting Gemini AI (${model})…`);
    try {
      response = await callGeminiModel(model, pdfBase64, markSchemeBase64, promptText);

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

      // If overloaded (503 / 429), wait 2s and try next model
      if (response.status === 503 || response.status === 429) {
        onProgress?.(`Model ${model} is busy, trying alternate model…`);
        await new Promise((r) => setTimeout(r, 2000));
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

  // Normalize all questions to ensure bare LaTeX formulas outside $ are wrapped in $...$
  parsed.questions = parsed.questions.map((q) => ({
    ...q,
    question_text: ensureInlineMathDelimiters(q.question_text || ''),
    options: Array.isArray(q.options)
      ? q.options.map((opt) => (typeof opt === 'string' ? ensureInlineMathDelimiters(opt) : opt))
      : q.options,
    sub_questions: Array.isArray(q.sub_questions)
      ? q.sub_questions.map((sq) => ({
          ...sq,
          question_text: ensureInlineMathDelimiters(sq.question_text || ''),
          mark_scheme: sq.mark_scheme ? ensureInlineMathDelimiters(sq.mark_scheme) : sq.mark_scheme,
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
  if (!GEMINI_API_KEY) {
    throw new Error(
      'Missing VITE_GEMINI_API_KEY in .env.local. ' +
      'Get your API key from https://aistudio.google.com/apikey'
    );
  }

  const userConfiguredModel = import.meta.env.VITE_GEMINI_MODEL;
  const discoveredModels = await discoverAvailableModels();
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
      "guidance": "Specific guidance for sub-part",
      "common_misconceptions": ["Specific trap for sub-part"]
    }
  ]
}`;

  let response: Response | null = null;
  let lastError = '';

  for (const model of candidateModels) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
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
 * Generates an AI-powered variant / twin of an existing exam question.
 * Supports parallel twins, scaffolding foundation versions, challenging extensions,
 * and format conversions with complete mark schemes and examiner guidance.
 */
export async function generateQuestionVariant(
  original: Question,
  options: GenerateVariantOptions
): Promise<Partial<Question>> {
  if (!GEMINI_API_KEY) {
    throw new Error('Gemini API key is not configured. Please set VITE_GEMINI_API_KEY.');
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
4. Provide a complete, rigorous mark_scheme object containing:
   - "marking_points": string array with mark allocations in square brackets (e.g. "Calculates moles of $HCl$: $0.05\\text{ mol}$ [1]")
   - "acceptable_answers": string array of allowed alternatives
   - "guidance": string array with examiner advice
   - "common_misconceptions": string array of student mistakes
5. Return strictly a single valid JSON object matching the schema below (no code block ticks, no markdown formatting outside JSON):

{
  "question_text": "The main question stem or context",
  "question_style": "${options.mode === 'mcq' ? 'Multiple Choice' : options.mode === 'structured' ? 'Structured' : original.question_style || 'Structured'}",
  "difficulty": "${options.mode === 'scaffold' ? 'Easy' : options.mode === 'extension' ? 'Hard' : original.difficulty || 'Medium'}",
  "marks": ${options.mode === 'mcq' ? 1 : Math.max(Number(original.marks) || 1, options.mode === 'structured' ? 4 : 1)},
  "topic": "${original.topic}",
  "sub_topic": ${original.sub_topic ? JSON.stringify(original.sub_topic) : 'null'},
  "options": ${options.mode === 'mcq' ? '["A. ...", "B. ...", "C. ...", "D. ..."]' : 'null'},
  "sub_questions": ${options.mode === 'mcq' ? '[]' : `[
    {
      "sub_id": "(a)",
      "question_text": "First sub-part text in $LaTeX$",
      "marks": 1,
      "mark_scheme": "Answer in $LaTeX$ [1]",
      "guidance": "Examiner guidance note",
      "common_misconceptions": ["Common mistake"]
    },
    {
      "sub_id": "(b)",
      "question_text": "Second sub-part text in $LaTeX$",
      "marks": 2,
      "mark_scheme": "Method [1]; final answer [1]",
      "guidance": "Allow ecf",
      "common_misconceptions": ["Calculation error"]
    }
  ]`},
  "mark_scheme": {
    "marking_points": [
      "Point 1 with mark allocation [1]",
      "Point 2 [1]"
    ],
    "acceptable_answers": ["Alternative answer 1"],
    "guidance": ["Examiner tip 1"],
    "common_misconceptions": ["Misconception 1"]
  }
}`;

  const availableModels = await discoverAvailableModels();
  let response: Response | null = null;
  let lastError = '';

  for (const modelName of availableModels) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
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

  // Sanitize sub-questions
  let sanitizedSubs: SubQuestion[] = Array.isArray(parsed.sub_questions)
    ? parsed.sub_questions.map((sub: any) => ({
        sub_id: String(sub.sub_id || ''),
        question_text: String(sub.question_text || ''),
        marks: Number(sub.marks) || 1,
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
      }))
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
    diagram_url: null,
  };
}
