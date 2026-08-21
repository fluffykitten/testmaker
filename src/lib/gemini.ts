// ─── Gemini API Integration ──────────────────────────────────────────────────
// Sends PDF pages to Google's multimodal AI for structured question extraction.
// Features dynamic model discovery, auto-fallback, and retry.

import type { ExtractionResult } from '../types/database';

const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY;

/**
 * The extraction prompt sent alongside each PDF.
 * Instructs Gemini to return structured JSON matching our database schema.
 */
const EXTRACTION_PROMPT = `You are an expert educational assessment parser. Analyze the attached exam past paper PDF page(s) and any mark scheme content.

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
          "mark_scheme": "$HCl$ [1]"
        },
        {
          "sub_id": "(b)(i)",
          "question_text": "Explain why the rate of reaction decreases as the reaction proceeds.",
          "marks": 2,
          "mark_scheme": "Concentration of reactants decreases [1]; fewer successful collisions per unit time [1]"
        },
        {
          "sub_id": "(b)(ii)",
          "question_text": "Calculate the volume of $CO_2$ gas produced at standard temperature and pressure from 0.05 mol of $CaCO_3$.",
          "marks": 2,
          "mark_scheme": "$0.05 \\times 24 = 1.2 \\text{ dm}^3$ [2]"
        },
        {
          "sub_id": "(c)",
          "question_text": "Describe one effect of increasing the temperature on the collisions between reacting particles.",
          "marks": 2,
          "mark_scheme": "Particles have greater kinetic energy [1]; more collisions have energy $\\ge E_a$ [1]"
        }
      ],
      "mark_scheme": {
        "marking_points": ["See sub-question breakdown [7]"],
        "acceptable_answers": []
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
3. Convert ALL mathematical symbols, chemical formulas, and equations to LaTeX inside $...$ delimiters.
4. TABLE EXTRACTION (CRITICAL):
   - Transcribe ALL data tables, experimental results, periodic tables, organic reaction tables, matching tables, and student completion tables into clean, structured Markdown Tables (| Header 1 | Header 2 | ... |\\n|---|---|---|...|) directly inside "question_text" or "sub_questions[].question_text".
   - Preserve all row and column headers, values, units (e.g. $g/cm^3$, $^\circ\text{C}$), and blank fill-in cells ([       ]).
   - Do NOT treat tables as image diagrams. Do NOT crop text tables with bounding_box.
5. DIAGRAMS & GRAPHS:
    - ONLY set has_diagram=true for actual visual drawings, apparatus setups, graphs/curves, electrical circuit schematics, biological cell illustrations, and reaction diagrams.
    - If has_diagram=true, include 1-indexed page_number and bounding_box as [ymin, xmin, ymax, xmax] on a 0-1000 normalized scale.
    - BOUNDING BOX GOLDEN RULE: It is MUCH better to make the bounding box TOO LARGE than too small. A slightly oversized box can be trimmed later, but a cropped-off diagram is useless. When in doubt, EXTEND the box generously.
    - BOUNDING BOX PADDING: Provide an EXTREMELY generous bounding box with AT LEAST 80 units of margin on ALL 4 sides. The bounding box MUST fully enclose:
      * The complete illustration, drawing, or graph (every line, curve, shaded area)
      * ALL axis titles, axis labels, tick marks, and scale numbers on graphs
      * ALL figure labels and captions (e.g. "Fig. 1.1", "Diagram 3.2") — these are often BELOW the main drawing
      * ALL arrows, annotation lines, pointers, and callout text
      * ALL keys, legends, and label boxes — these are often to the RIGHT or BELOW the diagram
      * ALL chemical apparatus labels (e.g. "beaker", "Bunsen burner", "thermometer")
    - COMMON BOUNDING BOX FAILURES TO AVOID:
      * Cutting off apparatus labels that appear at the BOTTOM of a diagram (e.g. "gas syringe", "delivery tube")
      * Cutting off graph X-axis titles and tick-mark labels below the axis line
      * Cutting off figure captions like "Fig. 2.1" that sit beneath the illustration
      * Cutting off the bottom row of a 2×2 grid of apparatus/options (A, B, C, D)
      * Missing labels or arrows that extend to the right side of the diagram
    - FULL VERTICAL SCAN (CRITICAL): Before setting ymax, visually scan ALL the way down from the top of the diagram to find the TRUE bottom edge. Many diagrams have content (labels, captions, legends, the bottom row of a grid) that extends much further down than the main drawing area. Set ymax to capture EVERYTHING, then add 80 units of margin below that.
    - SHARED DIAGRAMS: If a diagram is shared across multiple sub-questions (e.g. an apparatus setup for Q1(a), (b), (c)), include the FULL diagram bounding box in the parent question — do NOT crop to just one sub-part's region.
    - MULTI-PANEL / GRID DIAGRAMS (CRITICAL): Many MCQ questions show 2×2 or 2×1 grids of apparatus setups labeled A, B, C, D (e.g. four different gas collection methods, four different circuit arrangements). The bounding box MUST enclose ALL panels (A, B, C, AND D) — not just the top row. Scan the FULL vertical extent of the diagram area down to where the last panel ends.
    - STOP AT NEXT QUESTION BOUNDARY (CRITICAL): Never allow ymax to overshoot into the NEXT question (e.g. Question 17). The bounding box MUST stop cleanly in the white space gap below the current question's diagrams/options, BEFORE the bold question number of the next question.
    - BALANCED BOUNDING BOX: Ensure all sub-diagrams, labels (A, B, C, D), apparatus, and captions are fully inside, but STOP before the next question starts.
6. question_style must be one of: "Structured", "Multiple Choice", "Calculation", "Short Answer".
7. estimated_difficulty must be one of: "Easy", "Medium", "Hard".
8. Keep full question text — do not omit sub-questions.
9. If a question has no sub-parts (like an MCQ in Paper 1 or Paper 2), set "sub_questions": [] and put options in "options".
10. In LaTeX formulas, always escape backslashes properly in JSON strings (use \\\\rightarrow, \\\\frac, \\\\Delta, \\\\text, \\\\times, \\\\ge).`;

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
      if (next && '\"\\/bfnrtu'.includes(next)) {
        result += char;
        escaped = true;
      } else {
        // Unescaped LaTeX backslash (e.g. \rightarrow, \Delta) -> escape it as \\
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

  return result;
}

function fixTrailingCommas(input: string): string {
  return input.replace(/,\s*([}\]])/g, '$1');
}

/**
 * Attempts to repair truncated JSON (e.g. when LLM runs out of output tokens)
 * by finding the last complete question object and closing all open brackets.
 */
function repairTruncatedQuestionsJson(input: string): string {
  let str = input.trim();

  // Find the last complete question object closure '}'
  const lastQuestionEnd = str.lastIndexOf('}');
  if (lastQuestionEnd !== -1) {
    const candidate = str.substring(0, lastQuestionEnd + 1);
    // Count open brackets
    let openBrackets = 0;
    let openBraces = 0;
    let inString = false;
    let escaped = false;

    for (let i = 0; i < candidate.length; i++) {
      const c = candidate[i];
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (!inString) {
        if (c === '[') openBrackets++;
        else if (c === ']') openBrackets--;
        else if (c === '{') openBraces++;
        else if (c === '}') openBraces--;
      }
    }

    let closing = '';
    while (openBrackets > 0) { closing += ']'; openBrackets--; }
    while (openBraces > 0) { closing += '}'; openBraces--; }

    return candidate + closing;
  }

  return input;
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
  } catch {
    // Attempt 2: Sanitized control chars + LaTeX backslashes + trailing commas
    try {
      const sanitized = fixTrailingCommas(sanitizeJsonString(cleaned));
      return JSON.parse(sanitized);
    } catch {
      // Attempt 3: Truncation recovery (if long exam paper hit output token boundary)
      try {
        const repaired = fixTrailingCommas(sanitizeJsonString(repairTruncatedQuestionsJson(cleaned)));
        return JSON.parse(repaired);
      } catch (err: any) {
        throw new Error(
          `Failed to parse Gemini response as JSON: ${err?.message || 'Invalid format'}\n\nRaw output snippet:\n${cleaned.slice(0, 500)}`
        );
      }
    }
  }
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
 * Helper to call a specific Gemini model endpoint
 */
async function callGeminiModel(
  modelName: string,
  pdfBase64: string,
  markSchemeBase64?: string
): Promise<Response> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`;
  
  const parts: any[] = [
    { text: EXTRACTION_PROMPT },
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

/**
 * Sends a PDF file to Gemini for structured extraction with automated model discovery and fallback.
 * Accepts optional mark scheme PDF base64 to pair official mark schemes with 100% fidelity.
 * Returns parsed question data matching our ExtractionResult schema.
 */
export async function extractQuestionsFromPdf(
  pdfBase64: string,
  markSchemeBase64?: string,
  onProgress?: (status: string) => void
): Promise<ExtractionResult> {
  if (!GEMINI_API_KEY) {
    throw new Error(
      'Missing VITE_GEMINI_API_KEY in .env.local. ' +
      'Get your API key from https://aistudio.google.com/apikey'
    );
  }

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
      response = await callGeminiModel(model, pdfBase64, markSchemeBase64);

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

  onProgress?.(`Extracted ${parsed.questions.length} questions successfully using ${usedModel}.`);
  return parsed;
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
