if (typeof globalThis.localStorage === 'undefined') {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

import fs from 'node:fs';
import path from 'node:path';
import { sanitizeQuestionsForStudent } from '../src/lib/examSubmissionGuards.ts';
import { normalizeQuestionRecord } from '../src/services/questionBankService.ts';
import {
  buildBookletResources,
  findMatchingBookletResource,
  getQuestionBookletTrigger,
  getSubQuestionBookletTrigger,
} from '../src/utils/resourceBookletUtils.ts';
import { resolveStudentQuiz } from '../src/services/quizCodeService.ts';
import { PILOT_QUIZ_CODE } from '../src/data/pilotExam170Data.ts';

let passed = 0;
let failed = 0;

function assertCheck(name, condition, detail = '') {
  if (condition) {
    console.log(`PASS  ${name}`);
    passed += 1;
  } else {
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    failed += 1;
  }
}

console.log('Testing Exam Resource Booklet Pipeline & Drawer Controls...\n');

// ---------------------------------------------------------------------------
// Case 1: Formal Exam Mode sanitizeQuestionsForStudent preserves insert_resources
// while keeping mark_scheme === null and stripping answer keys.
// ---------------------------------------------------------------------------
const humanitiesRawQuestion = {
  id: 'hum-q1',
  question_number: '1',
  question_text: 'Study Fig. 1.1 in the Insert. Describe the river delta.',
  question_type: 'structured',
  max_marks: 4,
  diagram_url: 'data:image/png;base64,DELTA_FIG_1_1',
  diagram_source: 'insert',
  resource_ref: 'Fig. 1.1',
  insert_page_number: 2,
  acceptable_answers: ['arcuate'],
  mark_scheme: {
    marking_points: [{ mark_code: 'B1', point: 'Arcuate delta', marks: 1 }],
    _insert_resources: [
      {
        id: 'Fig. 1.1',
        title: 'Satellite photograph of a river delta',
        page_number: 2,
        text_content: 'Source: USGS Earth Observatory',
        target_questions: ['1'],
      },
      {
        id: 'Fig. 2.2',
        title: 'Population pyramid for Country Y',
        diagram_url: 'data:image/png;base64,PYRAMID_2_2',
        page_number: 4,
        target_questions: ['1(b)'],
      },
      {
        id: 'Fig. 9.9',
        title: 'Unused stub from excluded question',
        page_number: 9,
        target_questions: ['9'],
      },
    ],
  },
  sub_questions: [
    {
      id: 'hum-q1-a',
      sub_id: '(a)',
      question_text: 'Refer to Fig. 1.1.',
      marks: 2,
      mark_scheme: { marking_points: [{ mark_code: 'M1', point: 'distributaries', marks: 1 }] },
    },
    {
      id: 'hum-q1-b',
      sub_id: '(b)',
      question_text: 'Using Figs. 2.2 and 2.3 in the Insert, explain the pyramid shape.',
      marks: 2,
      diagram_url: 'data:image/png;base64,PYRAMID_2_3',
      diagram_source: 'insert',
      resource_ref: 'Fig. 2.3',
    },
  ],
};

const normalizedHumanities = normalizeQuestionRecord({ ...humanitiesRawQuestion });
assertCheck(
  'Case 1a: normalizeQuestionRecord unpacks mark_scheme._insert_resources onto insert_resources',
  Array.isArray(normalizedHumanities.insert_resources) && normalizedHumanities.insert_resources.length === 3
);

const [sanitizedHumanities] = sanitizeQuestionsForStudent([humanitiesRawQuestion], true);
assertCheck(
  'Case 1b: Formal Exam Mode sanitizeQuestionsForStudent keeps mark_scheme strictly null',
  sanitizedHumanities.mark_scheme === null
);
assertCheck(
  'Case 1c: Formal Exam Mode strips acceptable_answers and sub_question mark_scheme',
  sanitizedHumanities.acceptable_answers === undefined &&
    sanitizedHumanities.sub_questions[0].mark_scheme === undefined
);
assertCheck(
  'Case 1d: Formal Exam Mode preserves top-level insert_resources from mark_scheme._insert_resources',
  Array.isArray(sanitizedHumanities.insert_resources) &&
    sanitizedHumanities.insert_resources.length === 3 &&
    sanitizedHumanities.insert_resources[0].id === 'Fig. 1.1'
);

// ---------------------------------------------------------------------------
// Case 2: Humanities merge — catalog metadata + question diagram_url merge cleanly,
// never skipping question imageUrl on overlapping ID, plus multi-figure sub-questions.
// ---------------------------------------------------------------------------
const humResources = buildBookletResources({ questions: [sanitizedHumanities] });
const fig11 = findMatchingBookletResource(humResources, 'Fig. 1.1');
const fig22 = findMatchingBookletResource(humResources, 'Fig. 2.2');
const fig23 = findMatchingBookletResource(humResources, 'Fig. 2.3');
const fig99 = findMatchingBookletResource(humResources, 'Fig. 9.9');

assertCheck(
  'Case 2a: Merging Fig. 1.1 catalog metadata with q.diagram_url preserves imageUrl, title, textContent, and pageNumber',
  Boolean(fig11) &&
    fig11.imageUrl === 'data:image/png;base64,DELTA_FIG_1_1' &&
    fig11.title.includes('Satellite photograph') &&
    fig11.textContent === 'Source: USGS Earth Observatory' &&
    fig11.pageNumber === 2
);
assertCheck(
  'Case 2b: Sub-question insert resource Fig. 2.3 and catalog Fig. 2.2 are both present',
  Boolean(fig22 && fig22.imageUrl === 'data:image/png;base64,PYRAMID_2_2') &&
    Boolean(fig23 && fig23.imageUrl === 'data:image/png;base64,PYRAMID_2_3')
);
assertCheck(
  'Case 2c: Ghost metadata item Fig. 9.9 (no content, unreferenced by active questions) is filtered out',
  fig99 === undefined
);

const q1Trigger = getQuestionBookletTrigger(sanitizedHumanities, 0, humResources);
const subBTrigger = getSubQuestionBookletTrigger(sanitizedHumanities.sub_questions[1], sanitizedHumanities, 0, humResources);
assertCheck(
  'Case 2d: Question trigger and sub-question trigger resolve to booklet items',
  q1Trigger?.refId === 'Fig. 1.1' && subBTrigger?.refId === 'Fig. 2.3'
);

// ---------------------------------------------------------------------------
// Case 3: Chemistry 0620/5x Qualitative Analysis Notes (snake_case diagram_url + target_questions)
// and excluding Question Paper in-line figures (diagram_source === 'qp').
// ---------------------------------------------------------------------------
const chemRawQuestions = [
  {
    id: 'chem-q1',
    question_number: '1',
    question_text: 'Fig. 1.1 shows the titration apparatus.',
    question_type: 'structured',
    max_marks: 10,
    diagram_url: 'data:image/png;base64,QP_APPARATUS_FIG_1_1',
    diagram_source: 'qp',
    resource_ref: 'Fig. 1.1',
    mark_scheme: {
      marking_points: [{ mark_code: 'M1', point: 'burette', marks: 1 }],
    },
  },
  {
    id: 'chem-q2',
    question_number: '2',
    question_text: 'You are provided with Qualitative Analysis Notes to identify solid L.',
    question_type: 'structured',
    max_marks: 12,
    mark_scheme: {
      _insert_resources: [
        {
          id: 'qualitative-notes-1',
          title: 'Notes for use in qualitative analysis (Page 1)',
          diagram_url: 'data:image/png;base64,QUAL_NOTES_PAGE_1',
          page_number: 7,
          target_questions: ['2'],
        },
        {
          id: 'qualitative-notes-2',
          title: 'Notes for use in qualitative analysis (Page 2)',
          diagram_url: 'data:image/png;base64,QUAL_NOTES_PAGE_2',
          page_number: 8,
          target_questions: ['2'],
        },
      ],
    },
  },
];

const chemSanitized = sanitizeQuestionsForStudent(chemRawQuestions, true);
const chemResources = buildBookletResources({ questions: chemSanitized });
const qpFig = findMatchingBookletResource(chemResources, 'Fig. 1.1');
const notes1 = findMatchingBookletResource(chemResources, 'qualitative-notes-1');
const q1ChemTrigger = getQuestionBookletTrigger(chemSanitized[0], 0, chemResources);
const q2ChemTrigger = getQuestionBookletTrigger(chemSanitized[1], 1, chemResources);

assertCheck(
  'Case 3a: Question Paper diagram_source="qp" figure is NOT pulled into Resource Booklet',
  qpFig === undefined && q1ChemTrigger === null
);
assertCheck(
  'Case 3b: Chemistry 0620/5x Qualitative Analysis Notes normalize snake_case diagram_url -> imageUrl',
  Boolean(notes1) && notes1.imageUrl === 'data:image/png;base64,QUAL_NOTES_PAGE_1' && chemResources.length === 2
);
assertCheck(
  'Case 3c: target_questions=["2"] triggers Resource Booklet button directly on Chemistry Q2',
  q2ChemTrigger?.refId === 'qualitative-notes-1'
);

// ---------------------------------------------------------------------------
// Case 4: Pilot Exam ICM170 end-to-end resolution preserves Q5 SVG + text + trigger
// ---------------------------------------------------------------------------
const resolvedPilot = await resolveStudentQuiz(PILOT_QUIZ_CODE);
const pilotSanitized = resolvedPilot?.questions || [];
const pilotQ5 = pilotSanitized.find((q) => q.id === 'pilot-q5-geog');
const pilotResources = buildBookletResources({ questions: pilotSanitized });
const pilotFig51 = findMatchingBookletResource(pilotResources, 'Fig. 5.1');
const pilotQ5Index = pilotSanitized.findIndex((q) => q.id === 'pilot-q5-geog');
const pilotQ5Trigger = getQuestionBookletTrigger(pilotQ5, pilotQ5Index, pilotResources);

assertCheck(
  'Case 4a: Pilot Exam ICM170 resolves with Q5 mark_scheme === null and insert_resources preserved',
  Boolean(pilotQ5) && pilotQ5.mark_scheme === null && Array.isArray(pilotQ5.insert_resources) && pilotQ5.insert_resources.length >= 1
);
assertCheck(
  'Case 4b: Pilot Q5 Fig. 5.1 merges SVG contour map, descriptive textContent, and pageNumber',
  Boolean(pilotFig51) &&
    pilotFig51.title.includes('Merapi') &&
    typeof pilotFig51.svgContent === 'string' &&
    pilotFig51.svgContent.includes('<svg') &&
    typeof pilotFig51.textContent === 'string' &&
    pilotFig51.textContent.includes('Topographic elevation map') &&
    pilotFig51.pageNumber === 1
);
assertCheck(
  'Case 4c: Pilot Q5 exposes a clickable booklet trigger pointing to Fig. 5.1',
  pilotQ5Trigger?.refId === 'Fig. 5.1'
);

const standalonePreview = buildBookletResources({
  resources: [{ id: 'Insert Cover', title: 'Insert Overview', page_number: 1 }],
  questions: [],
});
assertCheck(
  'Case 4d: Standalone preview (questions=[]) retains catalog metadata items without content',
  standalonePreview.length === 1 && standalonePreview[0].id === 'Insert Cover'
);

// ---------------------------------------------------------------------------
// Case 5: ResourceBookletDrawer UI clean-up assertions (no Print PDF / Word export)
// ---------------------------------------------------------------------------
const drawerPath = path.resolve(process.cwd(), 'src/components/ResourceBookletDrawer.tsx');
const drawerSource = fs.readFileSync(drawerPath, 'utf8');
const runnerPath = path.resolve(process.cwd(), 'src/pages/StudentQuizRunner.tsx');
const runnerSource = fs.readFileSync(runnerPath, 'utf8');

assertCheck(
  'Case 5a: ResourceBookletDrawer removes Print PDF and Word (.docx) export buttons and helpers',
  !drawerSource.includes('openInsertBookletPrintWindow') &&
    !drawerSource.includes('exportInsertBookletDocx') &&
    !drawerSource.includes('Print PDF') &&
    !drawerSource.includes('Word (.docx)')
);
assertCheck(
  'Case 5b: ResourceBookletDrawer supports Escape closing, SVG rendering, and conditional zoom controls',
  drawerSource.includes("e.key === 'Escape'") &&
    drawerSource.includes('dangerouslySetInnerHTML') &&
    drawerSource.includes('hasVisualMedia')
);
assertCheck(
  'Case 5c: StudentQuizRunner passes normalized hasResourceBooklet / buildBookletResources into runner and drawer',
  runnerSource.includes('buildBookletResources') &&
    runnerSource.includes('getQuestionBookletTrigger') &&
    runnerSource.includes('getSubQuestionBookletTrigger') &&
    runnerSource.includes('activeBookletResourceRef')
);

console.log(`\nSummary: ${passed} passed, ${failed} failed.`);
if (failed > 0) {
  process.exit(1);
}
