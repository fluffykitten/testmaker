/**
 * ICM Exam Simulation Part 2 (12-Question Variant in Saved Tests)
 *
 * Isomorphic simulation variant covering all ICM170 hardware/UI capabilities
 * plus Structured Multi-Part Math/STEM Quick Symbols (Q11) and Split-View
 * Reading Passage + Word-Target Writing (Q12):
 *  1. Chemistry (0620)     — Periodic Table Drawer (Sodium Na, Z=11)
 *  2. Physics (0625)       — Scientific Calculator (GPE Ep = mgh)
 *  3. English (0510)       — Audio Library Track ("0L1 my room" placeholder MCQ)
 *  4. Biology (0610)       — In-Stem SVG Diagram (Human Heart Cross-Section)
 *  5. Geography (0460)     — Resource Booklet Drawer (Storm Hydrograph Fig. 5.2)
 *  6. Economics (0455)     — Interactive Fillable ExamDataTable (Production Cost)
 *  7. Economics (0455)     — Multiple Select Checkboxes (Monetary Policy)
 *  8. Chemistry (0620)     — Inline Gap Cloze [opt1|opt2] (Electrolysis)
 *  9. Arabic Language      — RTL Layout & Arabic Option Badges (الجملة الاسمية)
 * 10. Bahasa Indonesia     — Informational Text Comprehension (Mangrove Pesisir)
 * 11. Mathematics (0580)   — Structured Multi-Part (a)/(b) + Math Quick Symbols
 * 12. English / IELTS      — Split-View Reading Passage (>=600 chars) & 80+ Word Task
 */

import type { Question, CustomTest } from '../types/database';

export const PILOT_SIM_PART2_ID = 'pilot-sim-part2-12q';
export const PILOT_SIM_PART2_AUDIO_TITLE = '0L1 my room';

// SVG Diagram for Q4 (Biology: Mammalian Heart Cross-Section)
const HEART_CHAMBERS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 360" width="100%" height="auto" style="max-width:560px;margin:0 auto;display:block;">
  <defs>
    <linearGradient id="deoxGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#dbeafe"/>
      <stop offset="100%" stop-color="#93c5fd"/>
    </linearGradient>
    <linearGradient id="oxGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#fee2e2"/>
      <stop offset="100%" stop-color="#fca5a5"/>
    </linearGradient>
    <linearGradient id="wallGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fecaca"/>
      <stop offset="100%" stop-color="#ef4444"/>
    </linearGradient>
  </defs>

  <rect width="600" height="360" fill="#f8fafc" rx="14" stroke="#cbd5e1" stroke-width="2"/>
  <text x="300" y="28" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" font-weight="bold" fill="#1e293b">Fig. 4.2: Vertical Section Through a Mammalian Heart</text>

  <!-- Outer Myocardium Shell (noticeably thicker muscular wall around Chamber D on viewer's right) -->
  <path d="M 145 90 C 120 140, 130 270, 290 322 C 455 295, 495 160, 445 88 C 405 60, 195 60, 145 90 Z" fill="url(#wallGrad)" stroke="#991b1b" stroke-width="3"/>

  <!-- Septum Divider -->
  <path d="M 288 150 L 290 302" stroke="#7f1d1d" stroke-width="14" stroke-linecap="round"/>

  <!-- Chamber A: Right Atrium (viewer left upper) -->
  <path d="M 162 98 C 145 120, 152 162, 185 168 L 272 168 L 272 102 Z" fill="url(#deoxGrad)" stroke="#1d4ed8" stroke-width="2"/>
  <text x="215" y="140" text-anchor="middle" font-family="system-ui, sans-serif" font-size="18" font-weight="800" fill="#1e3a8a">A</text>

  <!-- Chamber B: Right Ventricle (viewer left lower, thinner outer wall) -->
  <path d="M 165 182 C 165 245, 205 288, 275 298 L 275 182 Z" fill="url(#deoxGrad)" stroke="#1d4ed8" stroke-width="2"/>
  <text x="225" y="242" text-anchor="middle" font-family="system-ui, sans-serif" font-size="18" font-weight="800" fill="#1e3a8a">B</text>

  <!-- Chamber C: Left Atrium (viewer right upper) -->
  <path d="M 308 102 L 308 168 L 415 168 C 438 155, 438 118, 418 98 Z" fill="url(#oxGrad)" stroke="#b91c1c" stroke-width="2"/>
  <text x="368" y="140" text-anchor="middle" font-family="system-ui, sans-serif" font-size="18" font-weight="800" fill="#7f1d1d">C</text>

  <!-- Chamber D: Left Ventricle (viewer right lower, thick muscular wall) -->
  <path d="M 308 182 L 308 294 C 365 282, 395 245, 398 182 Z" fill="url(#oxGrad)" stroke="#b91c1c" stroke-width="2"/>
  <text x="352" y="240" text-anchor="middle" font-family="system-ui, sans-serif" font-size="18" font-weight="800" fill="#7f1d1d">D</text>

  <!-- Thick Wall Annotation -->
  <line x1="418" y1="240" x2="466" y2="240" stroke="#7f1d1d" stroke-width="2"/>
  <polygon points="410,240 422,235 422,245" fill="#7f1d1d"/>
  <text x="472" y="236" font-family="system-ui, sans-serif" font-size="11" font-weight="bold" fill="#7f1d1d">Thickest</text>
  <text x="472" y="250" font-family="system-ui, sans-serif" font-size="11" font-weight="bold" fill="#7f1d1d">muscular wall</text>

  <!-- Major Vessels Labels -->
  <rect x="230" y="42" width="140" height="24" rx="6" fill="#ffffff" stroke="#cbd5e1"/>
  <text x="300" y="58" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" font-weight="bold" fill="#334155">To Body (Aorta) ↑</text>

  <!-- Legend -->
  <rect x="20" y="330" width="560" height="24" rx="6" fill="#f1f5f9"/>
  <text x="300" y="346" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" font-weight="bold" fill="#475569">Blue = Deoxygenated blood (Right side)  |  Red = Oxygenated blood (Left side)</text>
</svg>`;

// SVG Resource Booklet Figure for Q5 (Geography: Storm Hydrograph)
const STORM_HYDROGRAPH_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 350" width="100%" height="auto" style="max-width:560px;margin:0 auto;display:block;">
  <rect width="600" height="350" fill="#f8fafc" rx="14" stroke="#cbd5e1" stroke-width="2"/>
  <text x="300" y="26" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" font-weight="bold" fill="#0f172a">Fig. 5.2: River Ciliwung Basin — Storm Hydrograph (12-Hour Event)</text>

  <!-- Grid -->
  <g stroke="#e2e8f0" stroke-width="1">
    <line x1="70" y1="60" x2="540" y2="60"/>
    <line x1="70" y1="110" x2="540" y2="110"/>
    <line x1="70" y1="160" x2="540" y2="160"/>
    <line x1="70" y1="210" x2="540" y2="210"/>
    <line x1="70" y1="260" x2="540" y2="260"/>
  </g>

  <!-- Axes -->
  <line x1="70" y1="55" x2="70" y2="280" stroke="#334155" stroke-width="2"/>
  <line x1="70" y1="280" x2="540" y2="280" stroke="#334155" stroke-width="2"/>
  <text x="26" y="170" transform="rotate(-90 26 170)" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" font-weight="bold" fill="#1e293b">Discharge (m³/s)</text>

  <!-- Y Axis Labels -->
  <text x="60" y="284" text-anchor="end" font-family="system-ui, sans-serif" font-size="10" fill="#475569">0</text>
  <text x="60" y="214" text-anchor="end" font-family="system-ui, sans-serif" font-size="10" fill="#475569">50</text>
  <text x="60" y="164" text-anchor="end" font-family="system-ui, sans-serif" font-size="10" fill="#475569">100</text>
  <text x="60" y="114" text-anchor="end" font-family="system-ui, sans-serif" font-size="10" fill="#475569">150</text>

  <!-- Rainfall Bars (Peak at 04:00) -->
  <rect x="110" y="245" width="24" height="35" fill="#60a5fa" opacity="0.8"/>
  <rect x="160" y="215" width="24" height="65" fill="#3b82f6" opacity="0.85"/>
  <rect x="210" y="185" width="24" height="95" fill="#1d4ed8"/>
  <rect x="260" y="238" width="24" height="42" fill="#60a5fa" opacity="0.8"/>

  <!-- Peak Rainfall Marker at X (04:00) -->
  <circle cx="222" cy="185" r="5" fill="#1e3a8a"/>
  <text x="222" y="174" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" font-weight="bold" fill="#1e3a8a">Peak Rain (04:00)</text>

  <!-- River Discharge Curve (Peak at Y = 09:30, 145 m3/s) -->
  <path d="M 70 258 C 140 255, 210 245, 280 205 C 330 165, 365 112, 395 112 C 430 112, 470 190, 535 245" fill="none" stroke="#dc2626" stroke-width="3.5" stroke-linecap="round"/>

  <!-- Baseflow line -->
  <path d="M 70 258 L 535 250" fill="none" stroke="#64748b" stroke-width="1.5" stroke-dasharray="5,4"/>
  <text x="485" y="264" font-family="system-ui, sans-serif" font-size="10" fill="#475569">Baseflow</text>

  <!-- Peak Discharge Marker at Y (09:30) -->
  <circle cx="395" cy="112" r="6" fill="#dc2626" stroke="#ffffff" stroke-width="2"/>
  <text x="405" y="96" font-family="system-ui, sans-serif" font-size="11" font-weight="bold" fill="#991b1b">Peak Discharge Y (09:30, 145 m³/s)</text>

  <!-- Lag Time Bracket -->
  <line x1="222" y1="78" x2="395" y2="78" stroke="#0f766e" stroke-width="2" stroke-dasharray="3,2"/>
  <text x="308" y="71" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" font-weight="bold" fill="#0f766e">Lag Time</text>

  <!-- Time Axis Labels -->
  <text x="122" y="298" text-anchor="middle" font-family="system-ui, sans-serif" font-size="10" fill="#475569">02:00</text>
  <text x="222" y="298" text-anchor="middle" font-family="system-ui, sans-serif" font-size="10" font-weight="bold" fill="#1e3a8a">04:00</text>
  <text x="310" y="298" text-anchor="middle" font-family="system-ui, sans-serif" font-size="10" fill="#475569">07:00</text>
  <text x="395" y="298" text-anchor="middle" font-family="system-ui, sans-serif" font-size="10" font-weight="bold" fill="#991b1b">09:30</text>
  <text x="515" y="298" text-anchor="middle" font-family="system-ui, sans-serif" font-size="10" fill="#475569">12:00</text>

  <rect x="40" y="314" width="520" height="26" rx="6" fill="#f1f5f9"/>
  <text x="300" y="331" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" font-weight="bold" fill="#334155">Blue bars = Rainfall intensity (mm/hr)  |  Red curve = River discharge (m³/s)</text>
</svg>`;

export const PILOT_SIM_PART2_QUESTIONS: Question[] = [
  // Q1: Chemistry (Periodic Table Drawer Lookup — Sodium Na)
  {
    id: 'pilot2-q1-chem',
    syllabus_id: '0620-chemistry',
    year: 2026,
    series: 'Pilot',
    paper_number: '1',
    question_number: '1',
    parent_question_id: 'Q1',
    topic: 'Periodic Table & Alkali Metals',
    sub_topic: 'Group I Properties',
    difficulty: 'Easy',
    cognitive_level: 'C1',
    marks: 2,
    diagram_url: null,
    has_embedded_values: false,
    created_at: '2026-11-20T01:56:00.000Z',
    options: [
      'A: Relative atomic mass: 11.0 • Group: I (Alkali metals)',
      'B: Relative atomic mass: 23.0 • Group: II (Alkaline earth metals)',
      'C: Relative atomic mass: 23.0 • Group: I (Alkali metals)',
      'D: Relative atomic mass: 39.1 • Group: I (Alkali metals)',
    ],
    question_style: 'Multiple Choice',
    question_text: `Use the on-screen **Periodic Table** (🧪 button in the top bar) to locate the element with atomic number $11$ (Sodium, $\\text{Na}$).

Which row correctly states its relative atomic mass ($A_r$) to one decimal place and its Group in the Periodic Table?`,
    sub_questions: [],
    mark_scheme: {
      marking_points: [
        'Relative atomic mass of Sodium (Na) is 23.0.',
        'Sodium is located in Group I (Alkali metals).',
      ],
      acceptable_answers: ['C', 'C: Relative atomic mass: 23.0 • Group: I (Alkali metals)'],
      guidance: ['Students should open the Periodic Table drawer and inspect Sodium (Na, Z = 11).'],
    },
  },

  // Q2: Physics (Scientific Calculator Modal — Gravitational Potential Energy)
  {
    id: 'pilot2-q2-phys',
    syllabus_id: '0625-physics',
    year: 2026,
    series: 'Pilot',
    paper_number: '2',
    question_number: '2',
    parent_question_id: 'Q2',
    topic: 'Mechanics & Energy',
    sub_topic: 'Gravitational Potential Energy',
    difficulty: 'Medium',
    cognitive_level: 'C3',
    marks: 2,
    diagram_url: null,
    has_embedded_values: true,
    created_at: '2026-11-20T01:56:00.000Z',
    question_style: 'Multiple Choice',
    question_text: `A construction crane lifts a steel girder of mass $m = 850\\text{ kg}$ vertically upward to a height of $h = 45\\text{ m}$ where the gravitational field strength is $g = 9.8\\text{ N/kg}$.

Using the on-screen **Scientific Calculator** (🧮 button in the top bar), calculate the gain in gravitational potential energy ($\\Delta E_p$) in **Joules ($\\text{J}$)**.

$$\\Delta E_p = m g h$$

Which option correctly states the gain in gravitational potential energy?`,
    options: [
      'A: 38,250 J',
      'B: 374,850 J',
      'C: 416,500 J',
      'D: 833,000 J',
    ],
    sub_questions: [],
    mark_scheme: {
      marking_points: [
        'Formula: Ep = 850 * 9.8 * 45',
        'Calculation: 8330 * 45 = 374,850 J (Option B).',
      ],
      acceptable_answers: ['B', 'B: 374,850 J', '374,850 J', '374850'],
      guidance: ['Option B is correct (850 × 9.8 × 45 = 374,850 J).'],
    },
  },

  // Q3: English as a Second Language (Dynamic Audio Library Placeholder — "0L1 my room")
  {
    id: 'pilot2-q3-eng',
    syllabus_id: '0510-english',
    year: 2026,
    series: 'Pilot',
    paper_number: '3',
    question_number: '3',
    parent_question_id: 'Q3',
    topic: 'Listening Comprehension',
    sub_topic: 'Audio Track — 0L1 my room',
    difficulty: 'Easy',
    cognitive_level: 'C2',
    marks: 2,
    diagram_url: null,
    created_at: '2026-11-20T01:56:00.000Z',
    audio_url: null,
    audio_metadata: {
      title: PILOT_SIM_PART2_AUDIO_TITLE,
      play_limit: 2,
      libraryLookupTitle: PILOT_SIM_PART2_AUDIO_TITLE,
    } as any,
    question_style: 'Multiple Choice',
    question_text: `[PLACEHOLDER — Edit in Question Editor after listening to "${PILOT_SIM_PART2_AUDIO_TITLE}"]

Listen carefully to the audio track **"${PILOT_SIM_PART2_AUDIO_TITLE}"**. You may play the recording up to **2 times**.

Replace this question stem and the options below with your exact comprehension question matching the "${PILOT_SIM_PART2_AUDIO_TITLE}" recording:`,
    options: [
      'A: Option 1 (Replace after checking "0L1 my room")',
      'B: Option 2 (Replace after checking "0L1 my room")',
      'C: Option 3 (Replace after checking "0L1 my room")',
      'D: Option 4 (Replace after checking "0L1 my room")',
    ],
    sub_questions: [],
    mark_scheme: {
      marking_points: ['Placeholder question linked dynamically to Audio Library track "0L1 my room". Update correct option in Question Editor.'],
      acceptable_answers: ['A'],
    },
  },

  // Q4: Cambridge Biology (In-Stem Heart Anatomy SVG Diagram)
  {
    id: 'pilot2-q4-bio',
    syllabus_id: '0610-biology',
    year: 2026,
    series: 'Pilot',
    paper_number: '4',
    question_number: '4',
    parent_question_id: 'Q4',
    topic: 'Transport in Animals',
    sub_topic: 'Mammalian Heart Structure & Blood Pressure',
    difficulty: 'Medium',
    cognitive_level: 'C2',
    marks: 2,
    diagram_url: null,
    svg_content: HEART_CHAMBERS_SVG,
    diagram_type: 'photo',
    created_at: '2026-11-20T01:56:00.000Z',
    question_style: 'Multiple Choice',
    question_text: `Fig. 4.2 shows a vertical section through a mammalian heart.

Which row correctly identifies the chamber letter representing the **left ventricle** and explains why it possesses the **thickest muscular wall**?`,
    options: [
      'A: Chamber A • Receives low-pressure blood returning from the vena cava',
      'B: Chamber B • Pumps deoxygenated blood a short distance to the lungs',
      'C: Chamber C • Collects oxygenated blood arriving from the pulmonary veins',
      'D: Chamber D • Generates high pressure to pump oxygenated blood around the whole body via the aorta',
    ],
    sub_questions: [],
    mark_scheme: {
      marking_points: [
        'Chamber D is the left ventricle (thickest muscular wall).',
        'It pumps oxygenated blood to the entire systemic circulation at high pressure via the aorta (Option D).',
      ],
      acceptable_answers: ['D', 'D: Chamber D • Generates high pressure to pump oxygenated blood around the whole body via the aorta'],
      guidance: ['Left ventricle (D) pumps blood around the systemic circuit, requiring greater muscular force than the right ventricle (B).'],
    },
  },

  // Q5: Cambridge Geography (Resource Booklet Drawer — Storm Hydrograph Fig. 5.2)
  {
    id: 'pilot2-q5-geog',
    syllabus_id: '0460-geography',
    year: 2026,
    series: 'Pilot',
    paper_number: '1',
    question_number: '5',
    parent_question_id: 'Q5',
    topic: 'Rivers & Drainage Basins',
    sub_topic: 'Storm Hydrographs & Lag Time',
    difficulty: 'Medium',
    cognitive_level: 'C3',
    marks: 2,
    diagram_url: null,
    svg_content: STORM_HYDROGRAPH_SVG,
    resource_ref: 'Fig. 5.2',
    created_at: '2026-11-20T01:56:00.000Z',
    question_style: 'Multiple Choice',
    question_text: `Open **Fig. 5.2** in the **Resource Booklet** (📖 button in the top bar), which displays a 12-hour storm hydrograph for a river drainage basin.

Peak rainfall occurred at **04:00** and peak river discharge **Y** ($145\\text{ m}^3\\text{/s}$) was recorded at **09:30**. What is the **basin lag time** between peak rainfall and peak discharge, and which factor would most likely shorten this lag time?`,
    options: [
      'A: Lag time: 4 hours 30 minutes • Dense forest interception across gentle clay slopes',
      'B: Lag time: 5 hours 30 minutes • Rapid surface runoff from impermeable urban surfaces',
      'C: Lag time: 6 hours 30 minutes • High soil permeability in sandy bedrock',
      'D: Lag time: 9 hours 30 minutes • Low antecedent rainfall before the storm',
    ],
    sub_questions: [],
    mark_scheme: {
      marking_points: [
        'Lag time = 09:30 - 04:00 = 5 hours 30 minutes.',
        'Impermeable urban surfaces reduce infiltration and increase surface runoff, shortening lag time (Option B).',
      ],
      acceptable_answers: ['B', 'B: Lag time: 5 hours 30 minutes • Rapid surface runoff from impermeable urban surfaces'],
      _insert_resources: [
        {
          id: 'Fig. 5.2',
          title: 'River Ciliwung Basin — Storm Hydrograph (12-Hour Event)',
          page_number: 1,
          text_content: 'Storm hydrograph showing peak rainfall at 04:00, baseflow, and peak discharge Y of 145 m3/s at 09:30.',
          target_questions: ['Q5'],
        },
      ],
    } as any,
  },

  // Q6: Cambridge Economics (Interactive Fillable ExamDataTable — Production Costs)
  {
    id: 'pilot2-q6-econ',
    syllabus_id: '0455-economics',
    year: 2026,
    series: 'Pilot',
    paper_number: '2',
    question_number: '6',
    parent_question_id: 'Q6',
    topic: 'Costs, Revenue & Profit',
    sub_topic: 'Fixed, Variable & Total Cost Schedules',
    difficulty: 'Medium',
    cognitive_level: 'C3',
    marks: 3,
    diagram_url: null,
    created_at: '2026-11-20T01:56:00.000Z',
    question_style: 'Structured',
    question_text: `Table 6.2 shows the weekly production cost schedule for a small workshop manufacturing folding bicycles.

Study the schedule and **type the missing value directly into the empty cell in the interactive table below**:`,
    options: null,
    data_tables: [
      {
        id: 'Table 6.2',
        title: 'Weekly Production Cost Schedule (Folding Bicycles)',
        headers: ['Weekly Output (units)', 'Total Fixed Cost ($)', 'Total Variable Cost ($)', 'Total Cost ($)'],
        rows: [
          ['0', '$400', '$0', '$400'],
          ['10', '$400', '$300', '$700'],
          [
            '20',
            '$400',
            '$550',
            { value: '', is_blank: true, expected_answer: '950' },
          ],
          ['30', '$400', '$900', '$1,300'],
        ],
      },
    ],
    sub_questions: [
      {
        sub_id: 'a',
        question_text: 'Complete the blank cell in Table 6.2 for Total Cost ($) at an output of 20 units. [2 marks]',
        marks: 2,
        mark_scheme: '950',
        guidance: 'Total Cost = Fixed Cost ($400) + Variable Cost ($550) = $950.',
      },
      {
        sub_id: 'b',
        question_text: 'Calculate the Average Fixed Cost per bicycle at an output of 20 units ($). [1 mark]',
        marks: 1,
        mark_scheme: '20',
        guidance: 'Average Fixed Cost = $400 / 20 units = $20.',
      },
    ],
    mark_scheme: {
      marking_points: [
        'Total Cost at 20 units = $950 (or 950)',
        'Average Fixed Cost at 20 units = $20 (or 20)',
      ],
      acceptable_answers: ['950', '20'],
    },
  },

  // Q7: Economics (Multiple Select Checkboxes — Monetary Policy Tools)
  {
    id: 'pilot2-q7-multi',
    syllabus_id: '0455-economics',
    year: 2026,
    series: 'Pilot',
    paper_number: '1',
    question_number: '7',
    parent_question_id: 'Q7',
    topic: 'Macroeconomic Policy',
    sub_topic: 'Expansionary Monetary Policy',
    difficulty: 'Medium',
    cognitive_level: 'C4',
    marks: 2,
    diagram_url: null,
    created_at: '2026-11-20T01:56:00.000Z',
    question_style: 'Multiple Select',
    question_text: `Which **TWO** of the following actions are **expansionary monetary policy** measures taken by a central bank to stimulate aggregate demand during a recession?

**(Select exactly TWO options)**`,
    options: [
      'A: Lowering the central bank base interest rate',
      'B: Increasing corporate income tax rates on manufacturers',
      'C: Imposing import quotas on foreign electronics',
      'D: Purchasing government bonds from commercial banks (quantitative easing)',
      'E: Cutting public infrastructure capital expenditure',
    ],
    sub_questions: [],
    mark_scheme: {
      marking_points: [
        'Option A: Lowering base interest rates reduces borrowing costs and boosts consumption/investment.',
        'Option D: Quantitative easing expands commercial bank reserves and money supply.',
      ],
      acceptable_answers: ['A, D', 'D, A', 'A,D', 'D,A', 'A and D'],
      guidance: ['Award 1 mark for each correct option (strict all-or-nothing in strict mode).'],
    },
  },

  // Q8: Chemistry (Inline Gap Cloze Passage — Electrolysis)
  {
    id: 'pilot2-q8-cloze',
    syllabus_id: '0620-chemistry',
    year: 2026,
    series: 'Pilot',
    paper_number: '2',
    question_number: '8',
    parent_question_id: 'Q8',
    topic: 'Electrochemistry',
    sub_topic: 'Electrolysis of Concentrated Aqueous Sodium Chloride',
    difficulty: 'Medium',
    cognitive_level: 'C2',
    marks: 3,
    diagram_url: null,
    created_at: '2026-11-20T01:56:00.000Z',
    question_style: 'Fill in the Blank',
    question_text: `Complete the scientific explanation regarding the electrolysis of concentrated aqueous sodium chloride (brine) using inert graphite electrodes:

During electrolysis, [chlorine|oxygen] gas is discharged at the positive anode, while [hydrogen|sodium] gas is evolved at the negative cathode. Because hydroxide ions ($\\text{OH}^-$) remain in the solution alongside sodium ions, the remaining electrolyte turns [alkaline|acidic].`,
    options: null,
    sub_questions: [],
    mark_scheme: {
      marking_points: [
        'Gap 1: chlorine',
        'Gap 2: hydrogen',
        'Gap 3: alkaline',
      ],
      acceptable_answers: ['chlorine', 'hydrogen', 'alkaline'],
      guidance: ['Award 1 mark per correct gap selection.'],
    },
  },

  // Q9: Bahasa Arab (RTL Layout & Arabic Grammar — Nominal Sentence)
  {
    id: 'pilot2-q9-arab',
    syllabus_id: 'arabic-language',
    year: 2026,
    series: 'Pilot',
    paper_number: '1',
    question_number: '9',
    parent_question_id: 'Q9',
    topic: 'النحو والصرف',
    sub_topic: 'الجملة الاسمية والمبتدأ والخبر',
    difficulty: 'Easy',
    cognitive_level: 'C1',
    marks: 2,
    diagram_url: null,
    created_at: '2026-11-20T01:56:00.000Z',
    question_style: 'Multiple Choice',
    question_text: `اخْتَرْ **الْجُمْلَةَ الِاسْمِيَّةَ** الصَّحِيحَةَ (الَّتِي تَبْدَأُ بِمُبْتَدَأٍ وَخَبَرٍ) مِمَّا يَلِي:`,
    options: [
      'أ: يَزْرَعُ الْفَلَّاحُ الْأَرْضَ فِي الصَّبَاحِ',
      'ب: السَّمَاءُ صَافِيَةٌ فَوْقَ الْمَدِينَةِ',
      'ج: كَتَبَ التِّلْمِيذُ الْوَاجِبَ الْمَنْزِلِيَّ',
      'د: اِجْتَهِدْ فِي دُرُوسِكَ كُلَّ يَوْمٍ',
    ],
    sub_questions: [],
    mark_scheme: {
      marking_points: [
        'جملة "السَّمَاءُ صَافِيَةٌ فَوْقَ الْمَدِينَةِ" جملة اسمية مبدوءة باسم (مبتدأ وخبر).',
      ],
      acceptable_answers: [
        'B',
        'ب',
        'ب: السَّمَاءُ صَافِيَةٌ فَوْقَ الْمَدِينَةِ',
        'السَّمَاءُ صَافِيَةٌ فَوْقَ الْمَدِينَةِ',
      ],
      guidance: ['الخيار (ب) هو الصحيح لأن الجملة تبدأ باسم مرفوع (السماءُ صافيةٌ).'],
    },
  },

  // Q10: Bahasa Indonesia (Teks Informasi Ekologi Mangrove)
  {
    id: 'pilot2-q10-indo',
    syllabus_id: 'bahasa-indonesia',
    year: 2026,
    series: 'Pilot',
    paper_number: '1',
    question_number: '10',
    parent_question_id: 'Q10',
    topic: 'Literasi Membaca & Teks Informasi',
    sub_topic: 'Simpulan Fungsi Ekologis Teks',
    difficulty: 'Medium',
    cognitive_level: 'C2',
    marks: 2,
    diagram_url: null,
    created_at: '2026-11-20T01:56:00.000Z',
    question_style: 'Multiple Choice',
    question_text: `Bacalah kutipan teks informasi ilmiah berikut dengan saksama:

> *"Ekosistem hutan mangrove di wilayah pesisir berfungsi sebagai benteng alami yang meredam energi gelombang pasang dan mencegah abrasi pantai. Selain menahan pengikisan garis pantai, sistem perakaran mangrove yang rapat juga menjadi tempat pemijahan berbagai biota laut serta mampu menyerap karbon biru dalam jumlah besar."*

Berdasarkan kutipan di atas, manakah kesimpulan yang paling tepat mengenai **peran ganda ekosistem mangrove**?`,
    options: [
      'A: Meningkatkan kecepatan gelombang pasang agar air laut cepat surut',
      'B: Menggantikan seluruh terumbu karang di perairan laut dalam',
      'C: Menahan abrasi pesisir sekaligus menyediakan habitat biota laut dan penyerap karbon',
      'D: Mengurangi kadar garam air laut hingga menjadi air tawar siap minum',
    ],
    sub_questions: [],
    mark_scheme: {
      marking_points: [
        'Mangrove meredam gelombang untuk mencegah abrasi pantai, menjadi tempat pemijahan biota laut, dan menyerap karbon biru (Pilihan C).',
      ],
      acceptable_answers: [
        'C',
        'C: Menahan abrasi pesisir sekaligus menyediakan habitat biota laut dan penyerap karbon',
      ],
      guidance: ['Pilihan C merangkum kedua kalimat pada kutipan teks secara akurat.'],
    },
  },

  // Q11: Mathematics (Structured Multi-Part with Math Quick-Symbol Helper)
  {
    id: 'pilot2-q11-math',
    syllabus_id: '0580-mathematics',
    year: 2026,
    series: 'Pilot',
    paper_number: '2',
    question_number: '11',
    parent_question_id: 'Q11',
    topic: 'Algebra & Sequences',
    sub_topic: 'Quadratic Sequences & nth Term Formula',
    difficulty: 'Hard',
    cognitive_level: 'C3',
    marks: 4,
    diagram_url: null,
    created_at: '2026-11-20T01:56:00.000Z',
    question_style: 'Structured',
    question_text: `[no_passage] Consider the quadratic number sequence whose first five terms ($n = 1, 2, 3, 4, 5$) are shown below:

$$3,\\quad 7,\\quad 13,\\quad 21,\\quad 31,\\quad \\dots$$

You may use the on-screen **Math Quick Symbols** ($\\Sigma\\text{ Math}$, exponents $x^n$, or fractions) and **Scratchpad** (📝) if needed.`,
    options: null,
    sub_questions: [
      {
        sub_id: 'a',
        question_text: 'Find the $6\\text{th}$ term of this sequence. [1 mark]',
        marks: 1,
        mark_scheme: '43',
        guidance: 'First differences are +4, +6, +8, +10, so next difference is +12; 31 + 12 = 43.',
      },
      {
        sub_id: 'b',
        question_text: 'Write an algebraic expression for the $n\\text{th}$ term of the sequence in simplified quadratic form ($an^2 + bn + c$). [3 marks]',
        marks: 3,
        mark_scheme: 'n^2 + n + 1',
        guidance: 'Second difference = 2 => a = 1 (n^2). Subtracting n^2 leaves 2, 3, 4, 5, 6 = n + 1. Therefore nth term = n^2 + n + 1.',
      },
    ],
    mark_scheme: {
      marking_points: [
        '(a) 43 (1 mark)',
        '(b) n^2 + n + 1 (or n^{2} + n + 1) (3 marks)',
      ],
      acceptable_answers: ['43', 'n^2 + n + 1', 'n^{2}+n+1'],
    },
  },

  // Q12: English / IELTS Reading Split-View + Writing Word-Target Response
  {
    id: 'pilot2-q12-reading-writing',
    syllabus_id: '0510-english',
    year: 2026,
    series: 'Pilot',
    paper_number: '2',
    question_number: '12',
    parent_question_id: 'Q12',
    topic: 'Reading & Directed Writing — Urban Ecology',
    sub_topic: 'Vertical Forests & Microclimate Mitigation',
    difficulty: 'Medium',
    cognitive_level: 'C4',
    marks: 4,
    diagram_url: null,
    created_at: '2026-11-20T01:56:00.000Z',
    question_style: 'Structured',
    question_text: `[passage]
**Vertical Forests in Dense Tropical Cities**

As Southeast Asian cities expand upward, dark concrete towers absorb intense solar radiation throughout the afternoon and release trapped heat long after sunset—a phenomenon known as the urban heat island effect. To counter rising indoor cooling costs without sacrificing scarce street-level space, architects in Singapore, Jakarta, and Kuala Lumpur have begun wrapping high-rise facades in tiered "vertical forests."

Unlike decorative planter boxes, engineered facade ecosystems pair drought-tolerant native shrubs with deep structural soil troughs irrigated by harvested rainwater. On sunny afternoons, broad leaf canopies physically shade exterior glass walls, blocking direct thermal gain before it reaches office interiors. Simultaneously, plants draw moisture upward through their roots and release water vapor through microscopic leaf pores via evapotranspiration, absorbing ambient heat energy and noticeably cooling the surrounding air layer.

Early thermal monitoring on multi-story residential towers indicates that densely vegetated balconies can lower external wall surface temperatures by up to 11 °C compared with neighboring unshaded concrete buildings, while also filtering fine traffic dust particles near busy arterial roads.
[/passage]

Read the passage on the left and answer in the response box below. **Write at least 80 words** explaining **two distinct mechanisms** by which vertical forests cool dense city buildings, and note **one additional environmental benefit** mentioned in the text. [4 marks]`,
    options: null,
    sub_questions: [],
    mark_scheme: {
      marking_points: [
        'Mechanism 1: Leaf canopies physically shade glass facades/walls, blocking direct solar radiation/thermal gain (1 mark).',
        'Mechanism 2: Evapotranspiration releases water vapor from leaves, absorbing ambient heat energy to cool surrounding air (1 mark).',
        'Additional benefit: Filtering fine traffic dust / particulates OR utilizing harvested rainwater / lowering exterior wall temperature up to 11 °C (1 mark).',
        'Clarity, coherent explanation in >= 80 words using student own phrasing (1 mark).',
      ],
      acceptable_answers: ['shading and evapotranspiration; filters fine traffic dust particles'],
      guidance: ['Award up to 4 marks for clear explanation of shading, evapotranspiration, an additional benefit, and sustained coherent response (>=80 words).'],
    },
  },
];

export const PILOT_SIM_PART2_TOTAL_MARKS = PILOT_SIM_PART2_QUESTIONS.reduce(
  (sum, q) => sum + (q.marks || 0),
  0
);

export const PILOT_SIM_PART2_CUSTOM_TEST: CustomTest = {
  id: PILOT_SIM_PART2_ID,
  user_id: null,
  title: 'ICM Exam Simulation Part 2',
  total_marks: PILOT_SIM_PART2_TOTAL_MARKS,
  question_ids: PILOT_SIM_PART2_QUESTIONS.map((q) => q.id),
  created_at: '2026-11-20T01:56:00.000Z',
  header_config: {
    title: 'ICM Exam Simulation Part 2',
    schoolName: 'Insan Cendekia Madani',
    subject: 'Cambridge Multi-Discipline Simulation',
    subjectCode: '0002',
    durationMinutes: 30,
    instructions:
      'Answer all 12 questions. Test each on-screen tool: Periodic Table (Q1), Scientific Calculator (Q2), Audio Player ("0L1 my room", Q3), Heart Diagram (Q4), Resource Booklet (Q5), Interactive Data Table (Q6), Multi-Select (Q7), Inline Cloze (Q8), Arabic RTL (Q9), Bahasa Indonesia (Q10), Multi-Part Math Symbols (Q11), and Split-View Reading & Writing Word Counter (Q12).',
    questionOverrides: Object.fromEntries(
      PILOT_SIM_PART2_QUESTIONS.map((q) => [q.id, q])
    ),
  },
};
