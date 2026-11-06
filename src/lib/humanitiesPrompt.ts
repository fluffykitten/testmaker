/**
 * Humanities extraction prompt (pure — no pdfjs, no DOM, no React).
 *
 * Extracted from gemini.ts so the harness and the Node verification scripts can build
 * the exact prompt the app sends. The Geography 0460 archetype is the default; a
 * detected SubjectProfile switches the subject-specific rules (Sociology 0495 adds the
 * in-paper "Source A" stimulus, shared-lead-in definition parts and level descriptors).
 */

import type { SubjectProfile } from './subjectClassifier.ts';

export function getHumanitiesExtractionPrompt(
  hasInsert: boolean = true,
  includeGuidance: boolean = true,
  extractResourceCatalog: boolean = true,
  isIgcse: boolean = true,
  profile?: SubjectProfile
): string {
  const subjectName = profile?.subjectName ?? 'Geography';
  const syllabusCode = profile?.syllabusCode ?? (isIgcse ? '0460' : 'GEO');
  // The Humanities archetype was written for Geography 0460. Sociology 0495 needs the
  // in-paper "Source A" stimulus, shared-lead-in definition parts and level descriptors.
  const isSociology = profile?.syllabusCode === '0495';
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

  const introText = isIgcse
    ? `You are an expert educational assessment parser specializing in Cambridge IGCSE, GCSE, and International A-Level Geography (0460, 0976, 2217), History (0470, 0977), Economics (0455), Environmental Management (0680), Sociology, and English.
Analyze the attached exam Question Paper PDF${hasInsert ? ', Insert / Resource Booklet PDF,' : ''} and any mark scheme content.`
    : `You are an expert educational assessment parser specializing in Geography, History, Economics, Social Sciences, Civics, Environmental Studies, and English / Humanities across international and regional exam curricula (such as AP, IB, national high school boards, and general assessments).
Analyze the attached exam Question Paper PDF${hasInsert ? ', Resource / Stimulus Booklet PDF,' : ''} and any mark scheme / answer key content.`;

  const structureRule = isIgcse
    ? `CRITICAL RULE FOR MULTI-PART / STRUCTURED QUESTIONS:
Do NOT split sub-parts (a)(i), (a)(ii), (b)(i), (b)(ii), (c) into separate top-level questions! 
Group all sub-parts belonging to Question 1 under a SINGLE Question 1 container object with:
- "question_number": "1"
- "question_text": The main stem / introductory context placed BEFORE sub-questions (e.g. "1 (a) Study Fig. 1.1 (Insert), showing average annual population growth rates between 1950 and 2100 (estimated).")
- "has_diagram": true if there is a figure, photograph, map, or chart for this question stem
- "diagram_source": "insert" (if figure is in the Insert Booklet) OR "qp" (if figure is in the Question Paper)
- "resource_ref": Figure/Photo reference (e.g. "Fig. 1.1", "Photograph A", "Fig. 2.1")
- "total_marks": Sum of all sub-question marks (e.g. 25 marks)
- "sub_questions": An array containing all sub-parts [(a)(i), (a)(ii), (a)(iii), (a)(iv), (b)(i), (b)(ii), (c)] with their respective text, marks, and mark schemes!`
    : `QUESTION STRUCTURE RULES (GENERAL / NON-IGCSE):
- For multi-part questions (e.g. Question 1 with parts (a), (b), (c) or 1.1, 1.2), keep them grouped under the parent Question container in 'sub_questions'.
- For standalone questions (e.g. Question 1, Question 2 without sub-parts), output each question as its own top-level question with 'sub_questions': [].
- If a question references a reading passage, excerpt, map, or chart, capture that context in the question text or link it to sub-questions.
- In 'paper_metadata', extract the real subject, year, and paper title. Do not hallucinate Cambridge syllabus codes (like 0460) or series (like 'Oct/Nov') if not present.`;

  const metadataSnippet = isIgcse
    ? `"paper_metadata": {
    "subject": "${subjectName}",
    "subject_code": "${syllabusCode}",
    "year": 2025,
    "series": "Oct/Nov",
    "paper_number": 11,
    "has_insert_booklet": ${hasInsert ? 'true' : 'false'}
  }`
    : `"paper_metadata": {
    "subject": "${subjectName}",
    "subject_code": "${syllabusCode}",
    "year": 2025,
    "series": "General / Semester",
    "paper_number": 1,
    "has_insert_booklet": ${hasInsert ? 'true' : 'false'}
  }`;

  const insertResourcesSnippet = (hasInsert && extractResourceCatalog)
    ? `"insert_resources": [
    {
      "id": "${isIgcse ? 'Fig. 1.1' : 'Figure 1'}",
      "title": "${isIgcse ? 'Average annual population growth rates between 1950 and 2100 (estimated)' : 'Projected global population trends by continent'}",
      "page_number": 2,
      "target_questions": ["1(a)"]
    },
    {
      "id": "${isIgcse ? 'Fig. 2.1' : 'Resource 2'}",
      "title": "${isIgcse ? 'A map showing information about settlements in Extremadura, Spain' : 'Infographic illustrating urban microclimates and land use'}",
      "page_number": 3,
      "target_questions": ["2(a)"]
    }${isIgcse ? `,
    {
      "id": "Figs. 2.2, 2.3 and 2.4",
      "title": "Photographs showing settlements with different functions",
      "page_number": 4,
      "target_questions": ["2(b)"]
    }` : ''}
  ],`
    : '';

  const questionsSnippet = isIgcse
    ? `[
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
          "question_text": "Put the following four countries in rank order according to their average annual population growth rates:\\\\nAngola, Australia, China, Peru\\\\n\\\\nhighest: ...\\\\n...\\\\n...\\\\nlowest: ...",
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
          "question_text": "(b) Study Fig. 1.2, a graph showing information about the population of MEDCs and LEDCs between 2015 and 2040 (estimated).\\\\n\\\\n(i) Compare the expected changes in the total population of MEDCs and LEDCs between 2015 and 2040. You should refer to years and use statistics in your answer.",
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
          "mark_scheme": "Level 1 (1-3 marks): Limited detail describing population policy.\\\\nLevel 2 (4-6 marks): Developed statements explaining how policy influences growth rate.\\\\nLevel 3 (7 marks): Named example with place-specific details and developed points."${subGuidanceSnippet}
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
          "question_text": "Use the following words to fill in the table to show likely differences in service provision in the settlements labelled X and Y in Fig. 2.1:\\\\n*convenience, few, high, low, many, specialist*\\\\n\\\\n| | settlement X | settlement Y |\\\\n| :--- | :--- | :--- |\\\\n| **amount of services** | | |\\\\n| **order of services** | | |\\\\n| **type of services** | | |",
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
          "question_text": "(b) Study Figs. 2.2, 2.3 and 2.4 (Insert), photographs showing settlements with different functions.\\\\n\\\\n(i) Using evidence from Figs. 2.2, 2.3 and 2.4 only, identify the functions of each settlement.\\\\n\\\\nChoose your answers from the following list:\\\\n*commercial, cultural, industrial, mining, port, tourism*\\\\n\\\\n- Fig. 2.2: ...\\\\n- Fig. 2.3: ...\\\\n- Fig. 2.4: ...",
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
          "mark_scheme": "Level 1 (1-3 marks): Simple statements explaining settlement function.\\\\nLevel 2 (4-6 marks): Developed statements explaining reasons for function.\\\\nLevel 3 (7 marks): Named example with place-specific detail."${subGuidanceSnippet}
        }
      ],
      "mark_scheme": {
        "marking_points": ["See sub-question breakdown [25]"],
        "acceptable_answers": []${guidanceSchemaSnippet}
      }
    }
  ]`
    : `[
    {
      "question_number": "1",
      "parent_question_id": "Q1",
      "page_number": 2,
      "year": 2025,
      "series": "General / Semester",
      "paper_number": 1,
      "question_text": "Study Figure 1${hasInsert ? ' (Resource Booklet)' : ''}, showing projected global population trends by continent.",
      "question_style": "Structured",
      "total_marks": 6,
      "estimated_difficulty": "Medium",
      "topic": "Human Geography",
      "sub_topic": "Demographic Patterns",
      "has_diagram": true,
      "diagram_source": ${hasInsert ? '"insert"' : '"qp"'},
      "resource_ref": "Figure 1",
      "insert_page_number": ${hasInsert ? '2' : 'null'},
      "bounding_box": [115, 60, 580, 930],
      "options": null,
      "sub_questions": [
        {
          "sub_id": "(a)",
          "question_text": "Identify the continent projected to experience the highest population growth rate.",
          "marks": 1,
          "has_diagram": false,
          "diagram_url": null,
          "diagram_source": null,
          "resource_ref": null,
          "mark_scheme": "Africa [1]"${subGuidanceSnippet}
        },
        {
          "sub_id": "(b)",
          "question_text": "Describe two socio-economic factors contributing to declining birth rates in developed nations.",
          "marks": 2,
          "has_diagram": false,
          "diagram_url": null,
          "diagram_source": null,
          "resource_ref": null,
          "mark_scheme": "Increased access to higher education/careers for women [1]; higher cost of living and childrearing [1]"${subGuidanceSnippet}
        },
        {
          "sub_id": "(c)",
          "question_text": "Explain one policy government leaders can implement to address challenges associated with an aging population.",
          "marks": 3,
          "has_diagram": false,
          "diagram_url": null,
          "diagram_source": null,
          "resource_ref": null,
          "mark_scheme": "Raising the retirement age or pension reform [1]; encouraging skilled immigration [1]; investing in healthcare infrastructure [1]"${subGuidanceSnippet}
        }
      ],
      "mark_scheme": {
        "marking_points": ["See sub-question breakdown [6]"],
        "acceptable_answers": []${guidanceSchemaSnippet}
      }
    },
    {
      "question_number": "2",
      "parent_question_id": "Q2",
      "page_number": 3,
      "year": 2025,
      "series": "General / Semester",
      "paper_number": 1,
      "question_text": "Which factor is primarily responsible for the urban heat island effect?",
      "question_style": "Multiple Choice",
      "total_marks": 1,
      "estimated_difficulty": "Easy",
      "topic": "Urban Geography",
      "sub_topic": "Urban Environments",
      "has_diagram": false,
      "diagram_source": null,
      "bounding_box": null,
      "options": [
        "A. High concentration of dark, impermeable surfaces like asphalt and concrete",
        "B. Abundance of expansive urban parks and wetlands",
        "C. Low levels of vehicular and industrial emissions",
        "D. Widespread use of reflective roofing materials"
      ],
      "sub_questions": [],
      "mark_scheme": {
        "marking_points": ["A [1]"],
        "acceptable_answers": ["A"]${guidanceSchemaSnippet}
      }
    }
  ]`;

  const subjectLine = `This paper is ${subjectName}${/^\d{4}$/.test(syllabusCode) ? ` (${syllabusCode})` : ''}.`;

  const sociologyRules = isSociology
    ? `

SOCIOLOGY (0495) RULES — THIS PAPER IS NOT GEOGRAPHY:
1. IN-PAPER TEXT STIMULUS ("Source A"):
   - Paper 1 Question 1 prints a reading passage labelled "Source A" inside the question paper itself.
   - Put the complete passage, verbatim, at the start of Question 1's "question_text", before its sub-questions.
   - ALSO populate the root "passages" array using these exact keys (NEVER "title" or "text"):
     "passages": [{ "id": "Source A", "heading": "<heading as printed>", "body": "<full passage text>", "page_number": <page>, "target_questions": ["1"] }]
   - Sub-parts (a)(i)–(a)(iii) depend on Source A; parts (b)–(e) are general research-methods questions.
2. DEFINITION SUB-PARTS WITH A SHARED LEAD-IN:
   - Question 2 and Question 3 may print "Define the term: (a)" above "(i) agencies of socialisation [2]" and "(ii) hybrid identities [2]".
   - Extract them as "(a)(i)" and "(a)(ii)", each repeating the shared lead-in:
     { "sub_id": "(a)(i)", "question_text": "Define the term: agencies of socialisation", "marks": 2 }
3. HIGH-MARK ESSAYS (8–14 MARKS) USE THE PUBLISHED LEVELS OF RESPONSE:
   - Parts worth 8 marks or more are marked against the generic level grids (Tables A–D), which the mark scheme attaches. Do not invent point-marking lists for them.
   - Write "mark_scheme" as a single string: one line per level with its mark band, then the indicative content:
     "Level 4 (12–14 marks): …\\\\nLevel 3 (8–11 marks): …\\\\nLevel 2 (4–7 marks): …\\\\nLevel 1 (1–3 marks): …\\\\n\\\\nIndicative content — For:\\\\n• …\\\\n• …\\\\n\\\\nIndicative content — Against:\\\\n• …"
   - Use the table named in the answer table for that part (e.g. "Use Table A to mark answers to this question").
4. OPTIONAL QUESTIONS STAY IN THE OUTPUT:
   - The cover says "Answer two questions" or "Answer either Question 2 or Question 3". Extract every question (Q1, Q2, Q3) anyway — the teacher wants the whole pool.
   - "total_marks" is the marks printed for THAT question (e.g. 40), not the 80-mark paper total.
5. The JSON samples below illustrate the SHAPE only, using Geography content. Do not copy their subject matter, figures or wording.`
    : '';

  return `${introText}

${subjectLine}

Extract every numbered question (e.g., Question 1, Question 2, Question 3...) as a structured JSON object.

${structureRule}

${sociologyRules}

${insertSchemaRule}

Output strictly valid JSON matching this exact schema — no markdown fences, no commentary:

{
  ${metadataSnippet},
  ${insertResourcesSnippet}
  "questions": ${questionsSnippet}
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
10. MULTIPLE CHOICE OPTIONS: When a question has multiple choice options, extract them exclusively into the "options" array. NEVER duplicate or include the choices (A, B, C, D, E) inside "question_text".
`;
}
