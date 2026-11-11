/**
 * 170-Student Exam Mode Pilot & Hardware Stress Drill
 * Quiz Code: ICM170
 * 
 * 10 Multi-Discipline Questions testing all built-in test tools:
 * 1. Chemistry: Periodic Table Drawer lookup (Chlorine Ar & Group VII)
 * 2. Physics: Scientific Calculator Modal (Kinetic energy Ek = 1/2 mv²)
 * 3. English Listening: Cloud audio player stream with 2-play limit
 * 4. Biology: In-stem SVG diagram inspection (Leaf transverse anatomy)
 * 5. Geography: Resource Booklet Drawer inspection (Mount Merapi topographic map & elevation)
 * 6. Economics: Interactive ExamDataTable with in-cell typing for equilibrium
 * 7. Multi-Select: Economic policy checkboxes ("Select exactly TWO options")
 * 8. Chemistry: Inline gap cloze passage (exothermic thermochemistry)
 * 9. Arabic: RTL layout with Arabic option letter badges (أ, ب, ج, د)
 * 10. Bahasa Indonesia: Teks eksplanasi ilmiah & ecological reading comprehension
 */

import type { Question, CustomTest } from '../types/database';
import type { PublishedQuiz } from '../services/quizManagerService';

export const PILOT_EXAM_ID = 'pilot-exam-170';
export const PILOT_QUIZ_CODE = 'ICM170';
export const PILOT_TEACHER_PIN = '2026';

// High-fidelity SVG diagram for Q4 (Biology: Leaf Anatomy)
const LEAF_ANATOMY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 360" width="100%" height="auto" style="max-width:560px;margin:0 auto;display:block;">
  <defs>
    <linearGradient id="cuticleGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fef08a"/>
      <stop offset="100%" stop-color="#facc15"/>
    </linearGradient>
    <linearGradient id="epidermisGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ecfdf5"/>
      <stop offset="100%" stop-color="#d1fae5"/>
    </linearGradient>
    <linearGradient id="palisadeGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#86efac"/>
      <stop offset="100%" stop-color="#22c55e"/>
    </linearGradient>
    <linearGradient id="spongyGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#bbf7d0"/>
      <stop offset="100%" stop-color="#4ade80"/>
    </linearGradient>
  </defs>

  <!-- Background Canvas -->
  <rect width="600" height="360" fill="#f8fafc" rx="14" stroke="#cbd5e1" stroke-width="2"/>
  <text x="300" y="28" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" font-weight="bold" fill="#1e293b">Fig. 4.1: Transverse Section of a Dicotyledonous Leaf</text>

  <!-- Waxy Cuticle Upper -->
  <rect x="50" y="45" width="500" height="10" fill="url(#cuticleGrad)" stroke="#eab308" stroke-width="1.5" rx="3"/>

  <!-- Upper Epidermis (Layer A) -->
  <g id="layerA">
    <rect x="50" y="58" width="60" height="30" fill="url(#epidermisGrad)" stroke="#059669" stroke-width="1.5" rx="3"/>
    <rect x="112" y="58" width="60" height="30" fill="url(#epidermisGrad)" stroke="#059669" stroke-width="1.5" rx="3"/>
    <rect x="174" y="58" width="60" height="30" fill="url(#epidermisGrad)" stroke="#059669" stroke-width="1.5" rx="3"/>
    <rect x="236" y="58" width="60" height="30" fill="url(#epidermisGrad)" stroke="#059669" stroke-width="1.5" rx="3"/>
    <rect x="298" y="58" width="60" height="30" fill="url(#epidermisGrad)" stroke="#059669" stroke-width="1.5" rx="3"/>
    <rect x="360" y="58" width="60" height="30" fill="url(#epidermisGrad)" stroke="#059669" stroke-width="1.5" rx="3"/>
    <rect x="422" y="58" width="60" height="30" fill="url(#epidermisGrad)" stroke="#059669" stroke-width="1.5" rx="3"/>
    <rect x="484" y="58" width="66" height="30" fill="url(#epidermisGrad)" stroke="#059669" stroke-width="1.5" rx="3"/>
  </g>

  <!-- Palisade Mesophyll (Layer B) - Elongated vertical cells rich in chloroplasts -->
  <g id="layerB">
    <rect x="55" y="93" width="34" height="95" fill="url(#palisadeGrad)" stroke="#15803d" stroke-width="1.5" rx="5"/>
    <rect x="94" y="93" width="34" height="95" fill="url(#palisadeGrad)" stroke="#15803d" stroke-width="1.5" rx="5"/>
    <rect x="133" y="93" width="34" height="95" fill="url(#palisadeGrad)" stroke="#15803d" stroke-width="1.5" rx="5"/>
    <rect x="172" y="93" width="34" height="95" fill="url(#palisadeGrad)" stroke="#15803d" stroke-width="1.5" rx="5"/>
    <rect x="211" y="93" width="34" height="95" fill="url(#palisadeGrad)" stroke="#15803d" stroke-width="1.5" rx="5"/>
    <rect x="250" y="93" width="34" height="95" fill="url(#palisadeGrad)" stroke="#15803d" stroke-width="1.5" rx="5"/>
    <rect x="289" y="93" width="34" height="95" fill="url(#palisadeGrad)" stroke="#15803d" stroke-width="1.5" rx="5"/>
    <rect x="328" y="93" width="34" height="95" fill="url(#palisadeGrad)" stroke="#15803d" stroke-width="1.5" rx="5"/>
    <rect x="367" y="93" width="34" height="95" fill="url(#palisadeGrad)" stroke="#15803d" stroke-width="1.5" rx="5"/>
    <rect x="406" y="93" width="34" height="95" fill="url(#palisadeGrad)" stroke="#15803d" stroke-width="1.5" rx="5"/>
    <rect x="445" y="93" width="34" height="95" fill="url(#palisadeGrad)" stroke="#15803d" stroke-width="1.5" rx="5"/>
    <rect x="484" y="93" width="34" height="95" fill="url(#palisadeGrad)" stroke="#15803d" stroke-width="1.5" rx="5"/>
    <rect x="521" y="93" width="29" height="95" fill="url(#palisadeGrad)" stroke="#15803d" stroke-width="1.5" rx="5"/>
  </g>

  <!-- Spongy Mesophyll with Air Spaces (Layer C) -->
  <g id="layerC">
    <ellipse cx="85" cy="215" rx="22" ry="16" fill="url(#spongyGrad)" stroke="#16a34a" stroke-width="1.5"/>
    <ellipse cx="145" cy="225" rx="24" ry="18" fill="url(#spongyGrad)" stroke="#16a34a" stroke-width="1.5"/>
    <ellipse cx="205" cy="210" rx="20" ry="15" fill="url(#spongyGrad)" stroke="#16a34a" stroke-width="1.5"/>
    <ellipse cx="270" cy="225" rx="25" ry="19" fill="url(#spongyGrad)" stroke="#16a34a" stroke-width="1.5"/>
    <ellipse cx="335" cy="215" rx="23" ry="17" fill="url(#spongyGrad)" stroke="#16a34a" stroke-width="1.5"/>
    <ellipse cx="400" cy="225" rx="22" ry="16" fill="url(#spongyGrad)" stroke="#16a34a" stroke-width="1.5"/>
    <ellipse cx="465" cy="210" rx="25" ry="18" fill="url(#spongyGrad)" stroke="#16a34a" stroke-width="1.5"/>
    <ellipse cx="520" cy="225" rx="20" ry="15" fill="url(#spongyGrad)" stroke="#16a34a" stroke-width="1.5"/>

    <ellipse cx="110" cy="255" rx="21" ry="16" fill="url(#spongyGrad)" stroke="#16a34a" stroke-width="1.5"/>
    <ellipse cx="175" cy="260" rx="23" ry="17" fill="url(#spongyGrad)" stroke="#16a34a" stroke-width="1.5"/>
    <ellipse cx="240" cy="255" rx="20" ry="15" fill="url(#spongyGrad)" stroke="#16a34a" stroke-width="1.5"/>
    <ellipse cx="370" cy="260" rx="22" ry="16" fill="url(#spongyGrad)" stroke="#16a34a" stroke-width="1.5"/>
    <ellipse cx="435" cy="255" rx="24" ry="17" fill="url(#spongyGrad)" stroke="#16a34a" stroke-width="1.5"/>
    <ellipse cx="495" cy="260" rx="22" ry="15" fill="url(#spongyGrad)" stroke="#16a34a" stroke-width="1.5"/>
  </g>

  <!-- Lower Epidermis & Guard Cells (Layer D) -->
  <g id="layerD">
    <rect x="50" y="285" width="70" height="24" fill="url(#epidermisGrad)" stroke="#059669" stroke-width="1.5" rx="3"/>
    <rect x="122" y="285" width="70" height="24" fill="url(#epidermisGrad)" stroke="#059669" stroke-width="1.5" rx="3"/>
    <!-- Guard Cells & Stomatal Pore -->
    <ellipse cx="210" cy="297" rx="14" ry="11" fill="#86efac" stroke="#15803d" stroke-width="2"/>
    <ellipse cx="236" cy="297" rx="14" ry="11" fill="#86efac" stroke="#15803d" stroke-width="2"/>
    <ellipse cx="223" cy="297" rx="4" ry="7" fill="#0f172a"/>
    <rect x="256" y="285" width="75" height="24" fill="url(#epidermisGrad)" stroke="#059669" stroke-width="1.5" rx="3"/>
    <rect x="333" y="285" width="75" height="24" fill="url(#epidermisGrad)" stroke="#059669" stroke-width="1.5" rx="3"/>
    <!-- Guard Cells 2 -->
    <ellipse cx="426" cy="297" rx="14" ry="11" fill="#86efac" stroke="#15803d" stroke-width="2"/>
    <ellipse cx="452" cy="297" rx="14" ry="11" fill="#86efac" stroke="#15803d" stroke-width="2"/>
    <ellipse cx="439" cy="297" rx="4" ry="7" fill="#0f172a"/>
    <rect x="472" y="285" width="78" height="24" fill="url(#epidermisGrad)" stroke="#059669" stroke-width="1.5" rx="3"/>
  </g>

  <!-- Lower Cuticle -->
  <rect x="50" y="311" width="500" height="6" fill="url(#cuticleGrad)" stroke="#eab308" stroke-width="1" rx="2"/>

  <!-- Pointers and Labels (A, B, C, D) -->
  <!-- Pointer A: Upper Epidermis -->
  <line x1="15" y1="73" x2="48" y2="73" stroke="#dc2626" stroke-width="2.5" marker-end="url(#arrow)"/>
  <rect x="8" y="60" width="26" height="26" rx="6" fill="#dc2626"/>
  <text x="21" y="78" fill="#ffffff" font-size="16" font-weight="bold" text-anchor="middle" font-family="sans-serif">A</text>

  <!-- Pointer B: Palisade Mesophyll -->
  <line x1="15" y1="140" x2="52" y2="140" stroke="#dc2626" stroke-width="2.5"/>
  <rect x="8" y="127" width="26" height="26" rx="6" fill="#dc2626"/>
  <text x="21" y="145" fill="#ffffff" font-size="16" font-weight="bold" text-anchor="middle" font-family="sans-serif">B</text>

  <!-- Pointer C: Spongy Mesophyll -->
  <line x1="15" y1="230" x2="58" y2="230" stroke="#dc2626" stroke-width="2.5"/>
  <rect x="8" y="217" width="26" height="26" rx="6" fill="#dc2626"/>
  <text x="21" y="235" fill="#ffffff" font-size="16" font-weight="bold" text-anchor="middle" font-family="sans-serif">C</text>

  <!-- Pointer D: Guard Cells / Stomata -->
  <line x1="15" y1="297" x2="192" y2="297" stroke="#dc2626" stroke-width="2.5"/>
  <rect x="8" y="284" width="26" height="26" rx="6" fill="#dc2626"/>
  <text x="21" y="302" fill="#ffffff" font-size="16" font-weight="bold" text-anchor="middle" font-family="sans-serif">D</text>
</svg>`;

// High-fidelity SVG diagram for Q5 (Geography: Mount Merapi elevation & contour map)
const MERAPI_CONTOUR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 340" width="100%" height="auto" style="max-width:560px;margin:0 auto;display:block;">
  <rect width="600" height="340" fill="#f1f5f9" rx="14" stroke="#94a3b8" stroke-width="2"/>
  <text x="300" y="26" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" font-weight="bold" fill="#0f172a">Fig. 5.1: Topographic Profile & Contour Survey of Mount Merapi</text>

  <!-- Volcanic Peak Profile -->
  <path d="M 60,280 Q 200,260 270,120 Q 300,60 330,120 Q 400,260 540,280 Z" fill="#cbd5e1" stroke="#475569" stroke-width="2"/>
  <path d="M 285,100 L 300,70 L 315,100 Z" fill="#ef4444" opacity="0.3"/>

  <!-- Crater Rim Marker X -->
  <circle cx="300" cy="70" r="10" fill="#dc2626" stroke="#ffffff" stroke-width="2"/>
  <text x="300" y="52" text-anchor="middle" font-family="sans-serif" font-size="13" font-weight="bold" fill="#dc2626">X (Crater Rim: 2930 m)</text>

  <!-- Observation Post Marker Y -->
  <circle cx="450" cy="230" r="8" fill="#2563eb" stroke="#ffffff" stroke-width="2"/>
  <text x="450" y="215" text-anchor="middle" font-family="sans-serif" font-size="12" font-weight="bold" fill="#2563eb">Y (Observation Post: 1280 m)</text>

  <!-- Valley Settlement (Hazard Zone) -->
  <rect x="90" y="265" width="80" height="20" fill="#fde047" stroke="#ca8a04" stroke-width="1.5" rx="4"/>
  <text x="130" y="279" text-anchor="middle" font-family="sans-serif" font-size="10" font-weight="bold" fill="#854d0e">Valley Settlement</text>

  <!-- Contour lines representation -->
  <ellipse cx="300" cy="180" rx="120" ry="25" fill="none" stroke="#64748b" stroke-width="1.5" stroke-dasharray="4,4"/>
  <ellipse cx="300" cy="220" rx="170" ry="32" fill="none" stroke="#64748b" stroke-width="1.5" stroke-dasharray="4,4"/>
  <text x="435" y="180" font-family="sans-serif" font-size="10" fill="#64748b">2000 m contour</text>
  <text x="480" y="220" font-family="sans-serif" font-size="10" fill="#64748b">1500 m contour</text>
</svg>`;

export const PILOT_EXAM_170_QUESTIONS: Question[] = [
  // Q1: Chemistry (Periodic Table Lookup)
  {
    id: 'pilot-q1-chem',
    syllabus_id: '0620-chemistry',
    year: 2026,
    series: 'Pilot',
    paper_number: '1',
    question_number: '1',
    parent_question_id: 'Q1',
    topic: 'Periodic Table & Halogens',
    sub_topic: 'Group VII Properties',
    difficulty: 'Easy',
    cognitive_level: 'C1',
    marks: 2,
    diagram_url: null,
    has_embedded_values: false,
    created_at: '2026-11-11T18:50:00.000Z',
    options: [
      'A: Relative atomic mass: 35.5 • Group: VII (Halogens)',
      'B: Relative atomic mass: 17.0 • Group: VII (Halogens)',
      'C: Relative atomic mass: 35.5 • Group: VIII (Noble gases)',
      'D: Relative atomic mass: 71.0 • Group: VII (Halogens)',
    ],
    question_style: 'Multiple Choice',
    question_text: `Use the on-screen **Periodic Table** (🧪 button in the top bar) to locate the element with atomic number $17$ (Chlorine, $\\text{Cl}$).

Which row correctly states its relative atomic mass ($A_r$) to one decimal place and its Group in the Periodic Table?`,
    sub_questions: [],
    mark_scheme: {
      marking_points: [
        'Relative atomic mass of Chlorine is 35.5',
        'Chlorine is located in Group VII (Group 17) of the Periodic Table',
      ],
      acceptable_answers: ['A', 'A: Relative atomic mass: 35.5 • Group: VII (Halogens)'],
      guidance: ['Students must open the Periodic Table drawer and verify chlorine (Cl, atomic #17).'],
    },
  },

  // Q2: Physics (Scientific Calculator)
  {
    id: 'pilot-q2-phys',
    syllabus_id: '0625-physics',
    year: 2026,
    series: 'Pilot',
    paper_number: '2',
    question_number: '2',
    parent_question_id: 'Q2',
    topic: 'Mechanics & Energy',
    sub_topic: 'Kinetic Energy Calculations',
    difficulty: 'Medium',
    cognitive_level: 'C3',
    marks: 2,
    diagram_url: null,
    has_embedded_values: true,
    created_at: '2026-11-11T18:50:00.000Z',
    question_style: 'Multiple Choice',
    question_text: `An electric test vehicle of mass $m = 1200\\text{ kg}$ accelerates uniformly from rest to a final velocity of $v = 25\\text{ m/s}$.

Using the on-screen **Scientific Calculator** (🧮 button in the top bar), calculate the kinetic energy ($E_k$) of the vehicle in **Joules ($\\text{J}$)**.

$$E_k = \\frac{1}{2} m v^2$$

Which option correctly states the kinetic energy of the vehicle?`,
    options: [
      'A: 15,000 J',
      'B: 150,000 J',
      'C: 375,000 J',
      'D: 750,000 J',
    ],
    sub_questions: [],
    mark_scheme: {
      marking_points: [
        'Formula: Ek = 0.5 * 1200 * (25^2)',
        'Calculation: 600 * 625 = 375,000 J (Option C)',
      ],
      acceptable_answers: ['C', 'C: 375,000 J', '375,000 J', '375000'],
      guidance: ['Option C is correct. Students should use the Scientific Calculator to compute 0.5 * 1200 * 25^2.'],
    },
  },

  // Q3: English as a Second Language (Listening Audio Player)
  {
    id: 'pilot-q3-eng',
    syllabus_id: '0510-english',
    year: 2026,
    series: 'Pilot',
    paper_number: '3',
    question_number: '3',
    parent_question_id: 'Q3',
    topic: 'Listening Comprehension',
    sub_topic: 'School Exhibition Announcement',
    difficulty: 'Easy',
    cognitive_level: 'C2',
    marks: 2,
    diagram_url: null,
    created_at: '2026-11-11T18:50:00.000Z',
    audio_url: '/audio/pilot-english-listening.wav',
    audio_metadata: {
      title: 'Track 1: School Robotics & Science Exhibition Broadcast',
      transcript: 'Attention students and invigilators. The annual Insan Cendekia Madani science and robotics exhibition will officially open in the secondary campus auditorium at 10:15 AM immediately following the morning assembly. Please ensure your project badges are clearly visible before entering the main hall.',
      duration: 19,
      play_limit: 2,
    },
    question_style: 'Multiple Choice',
    question_text: `Listen to the school announcement regarding the annual robotics and science exhibition. You may play the recording up to **2 times**.

According to the audio broadcast, at what time does the exhibition officially open in the secondary campus auditorium?`,
    options: [
      'A: 09:30 AM',
      'B: 10:15 AM',
      'C: 11:45 AM',
      'D: 02:00 PM',
    ],
    sub_questions: [],
    mark_scheme: {
      marking_points: ['Exhibition opens at 10:15 AM as stated in the broadcast track.'],
      acceptable_answers: ['B', 'B: 10:15 AM'],
    },
  },

  // Q4: Cambridge Biology (In-Stem Leaf Anatomy Diagram) - Reordered to #4
  {
    id: 'pilot-q4-bio',
    syllabus_id: '0610-biology',
    year: 2026,
    series: 'Pilot',
    paper_number: '4',
    question_number: '4',
    parent_question_id: 'Q4',
    topic: 'Plant Nutrition & Gas Exchange',
    sub_topic: 'Leaf Anatomy & Photosynthesis',
    difficulty: 'Medium',
    cognitive_level: 'C2',
    marks: 2,
    diagram_url: null,
    svg_content: LEAF_ANATOMY_SVG,
    diagram_type: 'photo',
    created_at: '2026-11-11T18:50:00.000Z',
    question_style: 'Multiple Choice',
    question_text: `Fig. 4.1 shows a transverse section through a dicotyledonous leaf as viewed under a high-power microscope.

Which row correctly identifies the letter designating the **palisade mesophyll** (the layer with the highest concentration of chloroplasts) and names the specialized cells regulating the stomata in the lower epidermis?`,
    options: [
      'A: Layer A • Epidermal pavement cells',
      'B: Layer B • Guard cells',
      'C: Layer C • Spongy mesophyll cells',
      'D: Layer D • Phloem companion cells',
    ],
    sub_questions: [],
    mark_scheme: {
      marking_points: [
        'Layer B identifies the palisade mesophyll layer.',
        'Guard cells regulate the opening and closing of stomata in the lower epidermis (Option B).',
      ],
      acceptable_answers: ['B', 'B: Layer B • Guard cells'],
      guidance: ['Layer B has vertically elongated cells packed with chloroplasts. Guard cells flank the stomata.'],
    },
  },

  // Q5: Cambridge Geography (Resource Booklet Inspection)
  {
    id: 'pilot-q5-geog',
    syllabus_id: '0460-geography',
    year: 2026,
    series: 'Pilot',
    paper_number: '1',
    question_number: '5',
    parent_question_id: 'Q5',
    topic: 'Geographical Skills & Volcanic Hazards',
    sub_topic: 'Topographic Contours & Risk Assessment',
    difficulty: 'Medium',
    cognitive_level: 'C3',
    marks: 2,
    diagram_url: null,
    svg_content: MERAPI_CONTOUR_SVG,
    resource_ref: 'Fig. 5.1',
    created_at: '2026-11-11T18:50:00.000Z',
    question_style: 'Multiple Choice',
    question_text: `Study **Fig. 5.1** in the **Resource Booklet** (📖 button in the top bar), which shows a topographic survey map and volcanic profile of Mount Merapi.

Which row correctly identifies the volcanic summit feature at location **X** and the elevation difference between the summit crater rim X ($2930\\text{ m}$) and the observation outpost Y ($1280\\text{ m}$)?`,
    options: [
      'A: Summit Caldera • Elevation difference: 1280 m',
      'B: Volcanic Crater • Elevation difference: 1650 m',
      'C: Pyroclastic Cone • Elevation difference: 2150 m',
      'D: Lava Dome • Elevation difference: 2930 m',
    ],
    sub_questions: [],
    mark_scheme: {
      marking_points: [
        'Summit feature X is a volcanic crater.',
        'Elevation difference = 2930 m - 1280 m = 1650 m (Option B).',
      ],
      acceptable_answers: ['B', 'B: Volcanic Crater • Elevation difference: 1650 m'],
      _insert_resources: [
        {
          id: 'Fig. 5.1',
          title: 'Topographic Contour Profile of Mount Merapi Volcano',
          page_number: 1,
          text_content: 'Topographic elevation map showing summit crater rim X at 2930m, observation outpost Y at 1280m, and river valley settlement hazard zone.',
          target_questions: ['Q5'],
        },
      ],
    } as any,
  },

  // Q6: Cambridge Economics (Interactive Data Table)
  {
    id: 'pilot-q6-econ',
    syllabus_id: '0455-economics',
    year: 2026,
    series: 'Pilot',
    paper_number: '2',
    question_number: '6',
    parent_question_id: 'Q6',
    topic: 'Microeconomics & Price Mechanism',
    sub_topic: 'Market Equilibrium & Schedule',
    difficulty: 'Medium',
    cognitive_level: 'C3',
    marks: 3,
    diagram_url: null,
    created_at: '2026-11-11T18:50:00.000Z',
    question_style: 'Structured',
    question_text: `The table below displays the weekly market demand and supply schedules for organic apples in a local market.

Study the schedule and **type the missing values directly into the empty cell in the interactive table below**:`,
    options: null,
    data_tables: [
      {
        id: 'Table 6.1',
        title: 'Market Demand and Supply Schedule for Organic Apples',
        headers: ['Price per kg ($)', 'Quantity Demanded (kg)', 'Quantity Supplied (kg)', 'Market State'],
        rows: [
          ['$2.00', '500', '200', 'Shortage (-300 kg)'],
          ['$3.00', '400', '300', 'Shortage (-100 kg)'],
          [
            '$4.00',
            { value: '', is_blank: true, expected_answer: '350' },
            '350',
            'Market Equilibrium (Balanced)',
          ],
          ['$5.00', '250', '450', 'Surplus (+200 kg)'],
        ],
      },
    ],
    sub_questions: [
      {
        sub_id: 'a',
        question_text: 'Complete the blank cell in Table 6.1 for Quantity Demanded at $4.00 per kg where the market is in equilibrium. [2 marks]',
        marks: 2,
        mark_scheme: '350',
        guidance: 'At equilibrium, quantity demanded equals quantity supplied = 350 kg.',
      },
      {
        sub_id: 'b',
        question_text: 'State the equilibrium price per kilogram for organic apples. [1 mark]',
        marks: 1,
        mark_scheme: '$4.00',
        guidance: 'Equilibrium price is $4.00.',
      },
    ],
    mark_scheme: {
      marking_points: [
        'Equilibrium quantity = 350 kg',
        'Equilibrium price = $4.00',
      ],
      acceptable_answers: ['350', '$4.00'],
    },
  },

  // Q7: Multi-Select (Carbon Reduction Policies)
  {
    id: 'pilot-q7-multi',
    syllabus_id: '0455-economics',
    year: 2026,
    series: 'Pilot',
    paper_number: '1',
    question_number: '7',
    parent_question_id: 'Q7',
    topic: 'Environmental Economics',
    sub_topic: 'Government Intervention & Market Failure',
    difficulty: 'Medium',
    cognitive_level: 'C4',
    marks: 2,
    diagram_url: null,
    created_at: '2026-11-11T18:50:00.000Z',
    question_style: 'Multiple Select',
    question_text: `Which **TWO** of the following government policies are direct market-based interventions designed to internalize negative externalities and reduce carbon emissions?

**(Select exactly TWO options)**`,
    options: [
      'A: Levying a Pigouvian carbon tax on high-polluting industries',
      'B: Providing unconditional cash grants to fossil fuel refineries',
      'C: Establishing an emissions trading permit system (cap-and-trade)',
      'D: Imposing a mandatory maximum price ceiling on solar panels',
      'E: Banning public transport usage during peak hours',
    ],
    sub_questions: [],
    mark_scheme: {
      marking_points: [
        'Option A: Carbon tax internalizes the social cost of carbon emissions.',
        'Option C: Cap-and-trade establishes a market price for carbon pollution permits.',
      ],
      acceptable_answers: ['A, C', 'C, A', 'A,C', 'C,A', 'A and C'],
      guidance: ['1 mark for each correct selection. Deduct 1 mark if more than 2 options chosen.'],
    },
  },

  // Q8: Chemistry (Inline Gap Cloze Passage)
  {
    id: 'pilot-q8-cloze',
    syllabus_id: '0620-chemistry',
    year: 2026,
    series: 'Pilot',
    paper_number: '2',
    question_number: '8',
    parent_question_id: 'Q8',
    topic: 'Thermochemistry & Energetics',
    sub_topic: 'Exothermic Reactions & Enthalpy Change',
    difficulty: 'Easy',
    cognitive_level: 'C2',
    marks: 3,
    diagram_url: null,
    created_at: '2026-11-11T18:50:00.000Z',
    question_style: 'Fill in the Blank',
    question_text: `Complete the scientific explanation regarding chemical energetics below by typing or selecting the correct terms:

During an exothermic chemical reaction, heat energy is [released|absorbed] to the surroundings. This transfer of thermal energy causes the temperature of the reaction mixture to [increase|decrease]. The overall enthalpy change ($\\Delta H$) for any exothermic reaction has a [negative|positive] value.`,
    options: null,
    sub_questions: [],
    mark_scheme: {
      marking_points: [
        'Gap 1: released',
        'Gap 2: increase',
        'Gap 3: negative',
      ],
      acceptable_answers: ['released', 'increase', 'negative'],
      guidance: ['Award 1 mark for each correctly completed blank.'],
    },
  },

  // Q9: Bahasa Arab (Arabic Grammar & RTL Layout)
  {
    id: 'pilot-q9-arab',
    syllabus_id: 'arabic-language',
    year: 2026,
    series: 'Pilot',
    paper_number: '1',
    question_number: '9',
    parent_question_id: 'Q9',
    topic: 'النحو والصرف',
    sub_topic: 'الفعل الماضي وأحكامه',
    difficulty: 'Easy',
    cognitive_level: 'C1',
    marks: 2,
    diagram_url: null,
    created_at: '2026-11-11T18:50:00.000Z',
    question_style: 'Multiple Choice',
    question_text: `اخْتَرْ الْجُمْلَةَ الَّتِي تَحْتَوِي عَلَى **فِعْلٍ مَاضٍ** صَحِيحٍ مِمَّا يَلِي:`,
    options: [
      'أ: ذَهَبَ الطَّالِبُ إِلَى الْمَدْرَسَةِ مُبَكِّرًا',
      'ب: يَكْتُبُ التِّلْمِيذُ الدَّرْسَ فِي الدَّفْتَرِ',
      'ج: اِقْرَأْ كِتَابَكَ بِعِنَايَةٍ',
      'د: سَوْفَ يَنْجَحُ الْمُجْتَهِدُ فِي الاخْتِبَارِ',
    ],
    sub_questions: [],
    mark_scheme: {
      marking_points: [
        'الفعل "ذَهَبَ" فعل ماضٍ مبني على الفتح الظاهر.',
      ],
      acceptable_answers: [
        'A',
        'أ',
        'أ: ذَهَبَ الطَّالِبُ إِلَى الْمَدْرَسَةِ مُبَكِّرًا',
        'ذَهَبَ الطَّالِبُ إِلَى الْمَدْرَسَةِ مُبَكِّرًا',
      ],
      guidance: ['الخيار (أ) هو الصحيح لأن "ذهب" فعل ماضٍ.'],
    },
  },

  // Q10: Bahasa Indonesia (Teks Eksplanasi Ilmiah)
  {
    id: 'pilot-q10-indo',
    syllabus_id: 'bahasa-indonesia',
    year: 2026,
    series: 'Pilot',
    paper_number: '1',
    question_number: '10',
    parent_question_id: 'Q10',
    topic: 'Teks Eksplanasi & Literasi Membaca',
    sub_topic: 'Pemahaman Gagasan Pokok & Kosakata Ilmiah',
    difficulty: 'Medium',
    cognitive_level: 'C2',
    marks: 2,
    diagram_url: null,
    created_at: '2026-11-11T18:50:00.000Z',
    question_style: 'Multiple Choice',
    question_text: `Bacalah kutipan teks eksplanasi ilmiah berikut dengan cermat:

> *"Fotosintesis merupakan proses biokimia pembentukan karbohidrat dari bahan anorganik yang dilakukan oleh tumbuhan berklorofil dengan bantuan energi cahaya matahari. Proses ini tidak hanya menghasilkan glukosa sebagai sumber energi bagi tumbuhan, tetapi juga melepaskan gas oksigen ke atmosfer bumi yang sangat esensial bagi kelangsungan hidup organisme aerobik."*

Berdasarkan teks di atas, manakah pernyataan berikut yang paling tepat mengenai **fungsi ekologis utama** dari proses fotosintesis?`,
    options: [
      'A: Mengurangi kelembapan udara secara drastis di ekosistem hutan tropis',
      'B: Memproduksi gas oksigen yang vital bagi organisme aerobik serta menyediakan cadangan energi organik',
      'C: Mengubah energi kinetik menjadi energi termal di dalam vakuola tumbuhan',
      'D: Menghentikan siklus karbon di lapisan biosfer bumi',
    ],
    sub_questions: [],
    mark_scheme: {
      marking_points: [
        'Oksigen esensial bagi organisme aerobik dan glukosa sebagai sumber energi organik.',
      ],
      acceptable_answers: [
        'B',
        'B: Memproduksi gas oksigen yang vital bagi organisme aerobik serta menyediakan cadangan energi organik',
      ],
      guidance: ['Pilihan B merupakan representasi tepat dari kalimat kedua kutipan teks.'],
    },
  },
];

/**
 * Pre-configured PublishedQuiz record for instant execution & resolution
 */
export const PILOT_EXAM_170_PUBLISHED_QUIZ: PublishedQuiz = {
  id: PILOT_EXAM_ID,
  testId: PILOT_EXAM_ID,
  title: 'ICM Cambridge Exam System Pilot (170-Student Drill)',
  quizCode: PILOT_QUIZ_CODE,
  subject: 'Cambridge Multi-Discipline Pilot',
  totalMarks: 22,
  questionCount: 10,
  questionIds: PILOT_EXAM_170_QUESTIONS.map((q) => q.id),
  durationMinutes: 20,
  isExamMode: true,
  securityEnabled: true,
  enableWatermark: false,
  enableMultiMonitorDetection: true,
  hideEmergencyExamButton: false,
  requireTeacherUnlock: true,
  teacherPin: PILOT_TEACHER_PIN,
  maxViolations: 4,
  showInstantSolutions: false,
  requireStudentPin: false,
  limitOneAttempt: true,
  isActive: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  allowCalculator: true,
  calculatorType: 'scientific',
  allowPeriodicTable: true,
  allowScratchpad: true,
  allowFormulaSheet: true,
  headerConfig: {
    title: 'ICM Cambridge Exam System Pilot (170-Student Drill)',
    schoolName: 'Insan Cendekia Madani',
    subject: 'Cambridge Multi-Discipline Orientation',
    subjectCode: '0001',
    durationMinutes: 20,
    instructions: 'Answer all 10 questions. Test each on-screen tool: Periodic Table (Q1), Scientific Calculator (Q2), Audio Player (Q3), Leaf Anatomy Diagram (Q4), Resource Booklet (Q5), Data Table (Q6), Multi-Select (Q7), Inline Cloze (Q8), Arabic RTL (Q9), and Bahasa Indonesia (Q10). Do not press Esc, Alt+Tab, or F11 during the examination.',
    teacherPin: PILOT_TEACHER_PIN,
    questionOverrides: Object.fromEntries(
      PILOT_EXAM_170_QUESTIONS.map((q) => [q.id, q])
    ),
  },
};

/**
 * Pre-configured CustomTest record for instant display in Saved Tests dashboard
 */
export const PILOT_CUSTOM_TEST: CustomTest = {
  id: PILOT_EXAM_ID,
  user_id: null,
  title: 'ICM Cambridge Exam System Pilot (170-Student Drill)',
  total_marks: 22,
  question_ids: PILOT_EXAM_170_QUESTIONS.map((q) => q.id),
  created_at: '2026-11-11T18:50:00.000Z',
  header_config: {
    title: 'ICM Cambridge Exam System Pilot (170-Student Drill)',
    schoolName: 'Insan Cendekia Madani',
    subject: 'Cambridge Multi-Discipline Pilot',
    subjectCode: '0001',
    durationMinutes: 20,
    instructions: 'Answer all 10 questions. Test each on-screen tool: Periodic Table (Q1), Scientific Calculator (Q2), Audio Player (Q3), Leaf Anatomy Diagram (Q4), Resource Booklet (Q5), Data Table (Q6), Multi-Select (Q7), Inline Cloze (Q8), Arabic RTL (Q9), and Bahasa Indonesia (Q10). Do not press Esc, Alt+Tab, or F11 during the examination.',
    teacherPin: PILOT_TEACHER_PIN,
    questionOverrides: Object.fromEntries(
      PILOT_EXAM_170_QUESTIONS.map((q) => [q.id, q])
    ),
  },
};
