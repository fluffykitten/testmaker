import assert from 'node:assert/strict';
import fs from 'node:fs';
import JSZip from 'jszip';
import { Packer } from 'docx';
import {
  normalizeQuestionRecord,
  aggregatePastPapersSummaryFromRows,
  validateCambridgeHubUrl,
} from '../src/services/questionBankService.ts';
import {
  buildCitationInfo,
  buildCitationCellChildren,
  buildAccessInstructionCalloutTable,
  buildTableOfSpecificationsDocument,
} from '../src/services/tosExportService.ts';

console.log('=== Table of Specifications (ToS) Dual/Triple Citation Links Test Suite ===\n');

let totalTests = 0;
let passedTests = 0;

async function test(name, fn) {
  totalTests++;
  try {
    await fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. URL Validation & Domain Check
// ─────────────────────────────────────────────────────────────────────────────
console.log('--- 1. Testing Cambridge Support Hub URL Validation ---');

await test('Recognizes official schoolsupporthub.cambridge.org item URL without warning', () => {
  const url = 'https://schoolsupporthub.cambridge.org/item/90bdc4c3-16ac-4ee1-9e89-07e6fd472c9a';
  const res = validateCambridgeHubUrl(url);
  assert.equal(res.isValid, true);
  assert.equal(res.isCambridgeHubDomain, true);
  assert.equal(res.normalizedUrl, url);
  assert.equal(res.warning, undefined);
});

await test('Allows valid non-Cambridge https URL with gentle warning tip', () => {
  const url = 'https://intranet.icm.sch.id/cambridge/item/12345';
  const res = validateCambridgeHubUrl(url);
  assert.equal(res.isValid, true);
  assert.equal(res.isCambridgeHubDomain, false);
  assert.ok(res.warning && res.warning.includes('schoolsupporthub.cambridge.org'));
});

await test('Rejects empty or malformed URLs', () => {
  assert.equal(validateCambridgeHubUrl('').isValid, false);
  assert.equal(validateCambridgeHubUrl('not-a-url').isValid, false);
  assert.equal(validateCambridgeHubUrl('ftp://files.example.com/qp.pdf').isValid, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Question Normalization & Past Paper Group Aggregation
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 2. Testing Schema Normalization & JSONB Fallback ---');

await test('normalizeQuestionRecord extracts cambridge_hub_url and cambridge_ms_hub_url from native columns', () => {
  const raw = {
    id: 'q-1',
    question_number: '1',
    source_pdf_url: 'https://server.icm.sch.id/0620_m23_qp_22.pdf',
    cambridge_hub_url: 'https://schoolsupporthub.cambridge.org/item/90bdc4c3-16ac-4ee1-9e89-07e6fd472c9a',
    cambridge_ms_hub_url: 'https://schoolsupporthub.cambridge.org/item/aaaa1111-2222-3333-4444-555566667777',
    mark_scheme: { marking_points: ['B'] },
  };
  const norm = normalizeQuestionRecord(raw);
  assert.equal(norm.source_pdf_url, 'https://server.icm.sch.id/0620_m23_qp_22.pdf');
  assert.equal(norm.cambridge_hub_url, 'https://schoolsupporthub.cambridge.org/item/90bdc4c3-16ac-4ee1-9e89-07e6fd472c9a');
  assert.equal(norm.cambridge_ms_hub_url, 'https://schoolsupporthub.cambridge.org/item/aaaa1111-2222-3333-4444-555566667777');
});

await test('normalizeQuestionRecord falls back to mark_scheme._cambridge_hub_url and _cambridge_ms_hub_url', () => {
  const raw = {
    id: 'q-2',
    question_number: '2',
    mark_scheme: {
      marking_points: ['A'],
      _source_pdf_url: 'https://server.icm.sch.id/0620_m23_qp_22.pdf',
      _cambridge_hub_url: 'https://schoolsupporthub.cambridge.org/item/qp-fallback-id',
      _cambridge_ms_hub_url: 'https://schoolsupporthub.cambridge.org/item/ms-fallback-id',
    },
  };
  const norm = normalizeQuestionRecord(raw);
  assert.equal(norm.source_pdf_url, 'https://server.icm.sch.id/0620_m23_qp_22.pdf');
  assert.equal(norm.cambridge_hub_url, 'https://schoolsupporthub.cambridge.org/item/qp-fallback-id');
  assert.equal(norm.cambridge_ms_hub_url, 'https://schoolsupporthub.cambridge.org/item/ms-fallback-id');
});

await test('aggregatePastPapersSummaryFromRows aggregates Server PDF, QP Hub, and MS Hub counts', () => {
  const rows = [
    {
      id: 'q1',
      syllabus_id: 'syl-chem',
      year: 2023,
      series: 'February/March',
      paper_number: 22,
      source_pdf_url: 'https://server.icm.sch.id/0620_m23_qp_22.pdf',
      cambridge_hub_url: 'https://schoolsupporthub.cambridge.org/item/qp-22',
      cambridge_ms_hub_url: 'https://schoolsupporthub.cambridge.org/item/ms-22',
      syllabuses: { id: 'syl-chem', subject_name: 'Chemistry', subject_code: '0620' },
    },
    {
      id: 'q2',
      syllabus_id: 'syl-chem',
      year: 2023,
      series: 'February/March',
      paper_number: 22,
      mark_scheme: {
        _source_pdf_url: 'https://server.icm.sch.id/0620_m23_qp_22.pdf',
        _cambridge_hub_url: 'https://schoolsupporthub.cambridge.org/item/qp-22',
      },
      syllabuses: { id: 'syl-chem', subject_name: 'Chemistry', subject_code: '0620' },
    },
  ];

  const groups = aggregatePastPapersSummaryFromRows(rows);
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.equal(g.totalQuestions, 2);
  assert.equal(g.linkedPdfCount, 2);
  assert.equal(g.hasPdfUrl, true);
  assert.equal(g.linkedHubCount, 2);
  assert.equal(g.hasHubUrl, true);
  assert.equal(g.sampleHubUrl, 'https://schoolsupporthub.cambridge.org/item/qp-22');
  assert.equal(g.linkedMsHubCount, 1);
  assert.equal(g.hasMsHubUrl, true);
  assert.equal(g.sampleMsHubUrl, 'https://schoolsupporthub.cambridge.org/item/ms-22');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Citation Info Resolution
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 3. Testing buildCitationInfo Resolution ---');

await test('buildCitationInfo extracts Server PDF deep link, QP Hub URL, MS Hub URL, and Insert URL', () => {
  const q = {
    id: 'q-10',
    syllabus_id: 'syl-1',
    year: 2023,
    series: 'February/March',
    paper_number: 22,
    question_number: '4',
    page_number: 5,
    source_pdf_url: 'https://server.icm.sch.id/papers/0620_m23_qp_22.pdf',
    cambridge_hub_url: 'https://schoolsupporthub.cambridge.org/item/90bdc4c3-16ac-4ee1-9e89-07e6fd472c9a',
    cambridge_ms_hub_url: 'https://schoolsupporthub.cambridge.org/item/11112222-3333-4444-5555-666677778888',
    insert_pdf_url: 'https://server.icm.sch.id/papers/0620_m23_in_22.pdf',
    insert_page_number: 2,
    resource_ref: 'Fig. 4.1',
    diagram_source: 'insert',
    question_text: 'Study Fig. 4.1',
    question_style: 'Structured',
    topic: 'Stoichiometry',
    sub_topic: null,
    difficulty: 'Medium',
    marks: 3,
    diagram_url: null,
    sub_questions: [],
    mark_scheme: null,
    created_at: '2026-01-01T00:00:00Z',
  };

  const info = buildCitationInfo(q);
  assert.equal(info.citationPrefix, 'IGCSE Level:');
  assert.ok(info.citationBody.includes('Paper 22 February/March 2023'));
  assert.ok(info.citationBody.includes('(QP p. 5)'));
  assert.equal(info.citationUrl, 'https://server.icm.sch.id/papers/0620_m23_qp_22.pdf#page=5');
  assert.equal(info.cambridgeHubUrl, 'https://schoolsupporthub.cambridge.org/item/90bdc4c3-16ac-4ee1-9e89-07e6fd472c9a');
  assert.equal(info.cambridgeMsHubUrl, 'https://schoolsupporthub.cambridge.org/item/11112222-3333-4444-5555-666677778888');
  assert.equal(info.insertCitationUrl, 'https://server.icm.sch.id/papers/0620_m23_in_22.pdf#page=2');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. End-to-End .docx XML & Relationship Verification
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 4. Testing Exported ToS .docx Hyperlinks & Instruction Callout ---');

await test('Generated .docx contains Access Instruction Callout, Title Hyperlink to QP Hub, Server Copy raw link, and Official Mark Scheme (Hub) link', async () => {
  const questions = [
    {
      id: 'q-linked',
      syllabus_id: 'syl-1',
      year: 2023,
      series: 'February/March',
      paper_number: 22,
      question_number: '1',
      page_number: 2,
      source_pdf_url: 'https://server.icm.sch.id/papers/0620_m23_qp_22.pdf',
      cambridge_hub_url: 'https://schoolsupporthub.cambridge.org/item/90bdc4c3-16ac-4ee1-9e89-07e6fd472c9a',
      cambridge_ms_hub_url: 'https://schoolsupporthub.cambridge.org/item/f8a9b1c2-d3e4-4f5a-9b8c-7d6e5f4a3b2c',
      question_text: 'Which statement describes an endothermic reaction?',
      question_style: 'Multiple Choice',
      topic: 'Chemical Energetics',
      sub_topic: 'Exothermic and endothermic reactions',
      difficulty: 'Medium',
      cognitive_level: 'C2',
      marks: 1,
      diagram_url: null,
      options: ['A. Heat is released', 'B. Thermal energy is taken in', 'C. Temperature rises', 'D. Combustion'],
      sub_questions: [],
      mark_scheme: { marking_points: ['B'] },
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      id: 'q-server-only',
      syllabus_id: 'syl-1',
      year: 2022,
      series: 'May/June',
      paper_number: 42,
      question_number: '2',
      page_number: 6,
      source_pdf_url: 'https://server.icm.sch.id/papers/0620_s22_qp_42.pdf',
      cambridge_hub_url: null,
      cambridge_ms_hub_url: null,
      question_text: 'Define the term isotope.',
      question_style: 'Short Answer',
      topic: 'Atomic Structure',
      sub_topic: 'Isotopes',
      difficulty: 'Easy',
      cognitive_level: 'C1',
      marks: 2,
      diagram_url: null,
      options: null,
      sub_questions: [],
      mark_scheme: { marking_points: ['Atoms of the same element with different numbers of neutrons'] },
      created_at: '2026-01-01T00:00:00Z',
    },
  ];

  const headerConfig = {
    title: 'IGCSE Chemistry Assessment',
    subject: 'Chemistry (0620)',
    gradeLevel: 'Grade 10',
    durationMinutes: 45,
    academicYear: '2026/2027',
  };

  const doc = await buildTableOfSpecificationsDocument(headerConfig, questions);
  const buffer = await Packer.toBuffer(doc);
  const zip = await JSZip.loadAsync(buffer);

  const docXml = await zip.file('word/document.xml').async('string');
  const relsXml = await zip.file('word/_rels/document.xml.rels').async('string');

  // 1. Verify top Access Instruction Callout Note Box exists before the main table
  assert.ok(docXml.includes('Past Paper Citation &amp; Verification Guide'), 'Missing callout box title');
  assert.ok(
    docXml.includes('Paper titles link directly to official Cambridge School Support Hub resources'),
    'Missing Access Note instruction text'
  );
  assert.ok(
    docXml.includes('Server Copy') && docXml.includes('login-free page access to archived PDF copies on the school server'),
    'Missing Server Copy explanation in callout box'
  );

  // 2. Verify callout box appears BEFORE the main table header ("Core/Supplement")
  const calloutIdx = docXml.indexOf('Past Paper Citation &amp; Verification Guide');
  const tableHeaderIdx = docXml.indexOf('Core/Supplement');
  assert.ok(calloutIdx > 0 && tableHeaderIdx > calloutIdx, 'Callout box must be positioned above the main ToS table');

  // 3. Verify Relationships in document.xml.rels contain all 3 external URLs for Q1
  assert.ok(
    relsXml.includes('https://schoolsupporthub.cambridge.org/item/90bdc4c3-16ac-4ee1-9e89-07e6fd472c9a'),
    'Missing Cambridge QP Hub hyperlink target in document.xml.rels'
  );
  assert.ok(
    relsXml.includes('https://server.icm.sch.id/papers/0620_m23_qp_22.pdf#page=2'),
    'Missing Server Copy PDF deep-link target in document.xml.rels'
  );
  assert.ok(
    relsXml.includes('https://schoolsupporthub.cambridge.org/item/f8a9b1c2-d3e4-4f5a-9b8c-7d6e5f4a3b2c'),
    'Missing Cambridge MS Hub hyperlink target in document.xml.rels'
  );

  // 4. Verify paper title text, Server Copy label, and Official Mark Scheme (Hub) text in document.xml
  assert.ok(
    docXml.includes('IGCSE Level: Paper 22 February/March 2023 (p. 2)'),
    'Missing formatted paper title for Q1'
  );
  assert.ok(docXml.includes('Server Copy: '), 'Missing "Server Copy: " prefix');
  assert.ok(
    docXml.includes('https://server.icm.sch.id/papers/0620_m23_qp_22.pdf#page=2'),
    'Missing raw server link text in Citation cell'
  );
  assert.ok(
    docXml.includes('Official Mark Scheme (Hub) \u2197'),
    'Missing concise "Official Mark Scheme (Hub) ↗" hyperlink text'
  );
});

await test('buildCitationCellChildren renders 3 paragraphs when QP Hub, Server PDF, and MS Hub are present', () => {
  const children = buildCitationCellChildren({
    citationPrefix: 'IGCSE Level:',
    citationBody: 'Paper 22 February/March 2023 (p. 2)',
    citationUrl: 'https://server.icm.sch.id/papers/0620_m23_qp_22.pdf#page=2',
    cambridgeHubUrl: 'https://schoolsupporthub.cambridge.org/item/90bdc4c3-16ac-4ee1-9e89-07e6fd472c9a',
    cambridgeMsHubUrl: 'https://schoolsupporthub.cambridge.org/item/ms-uuid',
  });
  assert.equal(children.length, 3);
  assert.ok(buildAccessInstructionCalloutTable('Calibri'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Static Component Integration Checks
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 5. Testing UI Component Wiring ---');

await test('PastPaperPdfManagerModal wires Cambridge QP Hub & MS Hub batch actions', () => {
  const modalSrc = fs.readFileSync('src/components/PastPaperPdfManagerModal.tsx', 'utf8');
  assert.ok(modalSrc.includes('batchAttachCambridgeHubUrl'));
  assert.ok(modalSrc.includes('batchDetachCambridgeHubUrl'));
  assert.ok(modalSrc.includes('batchAttachCambridgeMsHubUrl'));
  assert.ok(modalSrc.includes('batchDetachCambridgeMsHubUrl'));
  assert.ok(modalSrc.includes('Link QP Hub'));
  assert.ok(modalSrc.includes('Link MS Hub'));
});

await test('QuestionEditorModal wires cambridgeHubUrl and cambridgeMsHubUrl inputs and batch checkbox', () => {
  const editorSrc = fs.readFileSync('src/components/QuestionEditorModal.tsx', 'utf8');
  assert.ok(editorSrc.includes('cambridgeHubUrl'));
  assert.ok(editorSrc.includes('cambridgeMsHubUrl'));
  assert.ok(editorSrc.includes('batchAttachCambridgeHubUrl'));
  assert.ok(editorSrc.includes('batchAttachCambridgeMsHubUrl'));
});

console.log('\n========================================');
console.log(`Results: ${passedTests}/${totalTests} tests passed (${Math.round((passedTests / totalTests) * 100)}%)`);
console.log('========================================\n');

if (passedTests !== totalTests) {
  process.exit(1);
}

