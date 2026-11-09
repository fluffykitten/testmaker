import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateCambridgeHubUrl } from '../src/services/questionBankService.ts';

console.log('=== Post-Upload Cambridge Support Hub Links Test Suite ===\n');

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
// 1. URL Validation Verification
// ─────────────────────────────────────────────────────────────────────────────
console.log('--- 1. Testing Cambridge Support Hub URL Validation ---');

await test('validateCambridgeHubUrl correctly validates QP item link', () => {
  const qpUrl = 'https://schoolsupporthub.cambridge.org/item/90bdc4c3-16ac-4ee1-9e89-07e6fd472c9a';
  const res = validateCambridgeHubUrl(qpUrl);
  assert.equal(res.isValid, true);
  assert.equal(res.isCambridgeHubDomain, true);
  assert.equal(res.normalizedUrl, qpUrl);
  assert.equal(res.warning, undefined);
});

await test('validateCambridgeHubUrl correctly validates Mark Scheme item link', () => {
  const msUrl = 'https://schoolsupporthub.cambridge.org/item/ms-uuid-12345';
  const res = validateCambridgeHubUrl(msUrl);
  assert.equal(res.isValid, true);
  assert.equal(res.isCambridgeHubDomain, true);
});

await test('validateCambridgeHubUrl warns gently on non-Cambridge domain', () => {
  const extUrl = 'https://drive.google.com/file/d/12345';
  const res = validateCambridgeHubUrl(extUrl);
  assert.equal(res.isValid, true);
  assert.equal(res.isCambridgeHubDomain, false);
  assert.ok(res.warning && res.warning.includes('schoolsupporthub.cambridge.org'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. ExtractionReview Component Wiring Checks
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 2. Testing ExtractionReview Component Wiring ---');

await test('ExtractionReview contains Cambridge Support Hub Links card and inputs', () => {
  const src = fs.readFileSync('src/components/ExtractionReview.tsx', 'utf8');
  assert.ok(src.includes('review-cambridge-links-card'), 'Missing review-cambridge-links-card class');
  assert.ok(src.includes('review-qp-hub-url'), 'Missing review-qp-hub-url input ID');
  assert.ok(src.includes('review-ms-hub-url'), 'Missing review-ms-hub-url input ID');
  assert.ok(src.includes('handleUpdateCambridgeLink'), 'Missing handleUpdateCambridgeLink handler');
  assert.ok(src.includes('qpValidation'), 'Missing qpValidation check');
  assert.ok(src.includes('msValidation'), 'Missing msValidation check');
});

await test('ExtractionReview Edit Paper Details modal contains QP & MS inputs', () => {
  const src = fs.readFileSync('src/components/ExtractionReview.tsx', 'utf8');
  assert.ok(src.includes('metadataDraft.cambridge_hub_url'), 'Missing metadataDraft.cambridge_hub_url in modal');
  assert.ok(src.includes('metadataDraft.cambridge_ms_hub_url'), 'Missing metadataDraft.cambridge_ms_hub_url in modal');
});

await test('ExtractionReview includes Cambridge QP & MS link metadata badges', () => {
  const src = fs.readFileSync('src/components/ExtractionReview.tsx', 'utf8');
  assert.ok(src.includes('label="Cambridge QP Link"'), 'Missing Cambridge QP Link badge');
  assert.ok(src.includes('label="Cambridge MS Link"'), 'Missing Cambridge MS Link badge');
});

await test('ExtractionReview handleSaveClick maps paperMetadata Cambridge links to questions', () => {
  const src = fs.readFileSync('src/components/ExtractionReview.tsx', 'utf8');
  assert.ok(
    src.includes('cambridge_hub_url: q.cambridge_hub_url || paperMetadata.cambridge_hub_url || null'),
    'Missing cambridge_hub_url propagation in handleSaveClick'
  );
  assert.ok(
    src.includes('cambridge_ms_hub_url: q.cambridge_ms_hub_url || paperMetadata.cambridge_ms_hub_url || null'),
    'Missing cambridge_ms_hub_url propagation in handleSaveClick'
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Pipeline & Processor Wiring Checks
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n--- 3. Testing Processor & Upload Page Wiring ---');

await test('pdfProcessor saveExtractedQuestions falls back to paper_metadata.cambridge_hub_url and ms_hub_url', () => {
  const src = fs.readFileSync('src/lib/pdfProcessor.ts', 'utf8');
  assert.ok(
    src.includes('q.cambridge_hub_url ||'),
    'Missing q.cambridge_hub_url fallback check in saveExtractedQuestions'
  );
  assert.ok(
    src.includes('paper_metadata.cambridge_hub_url ||'),
    'Missing paper_metadata.cambridge_hub_url fallback check in saveExtractedQuestions'
  );
  assert.ok(
    src.includes('paper_metadata.cambridge_ms_hub_url ||'),
    'Missing paper_metadata.cambridge_ms_hub_url fallback check in saveExtractedQuestions'
  );
});

await test('UploadPage wires onUpdateMetadata and auto-save draft persistence', () => {
  const src = fs.readFileSync('src/pages/UploadPage.tsx', 'utf8');
  assert.ok(src.includes('onUpdateMetadata='), 'Missing onUpdateMetadata prop on ExtractionReview');
  assert.ok(src.includes('saveUploadDraft'), 'Missing saveUploadDraft inside onUpdateMetadata');
});

await test('PdfUpload optionally accepts upfront Cambridge links', () => {
  const src = fs.readFileSync('src/components/PdfUpload.tsx', 'utf8');
  assert.ok(src.includes('upload-qp-hub-link'), 'Missing upload-qp-hub-link in PdfUpload');
  assert.ok(src.includes('upload-ms-hub-link'), 'Missing upload-ms-hub-link in PdfUpload');
  assert.ok(src.includes('cambridgeHubUrl:'), 'Missing cambridgeHubUrl in handleExtract options');
});

console.log('\n========================================');
console.log(`Results: ${passedTests}/${totalTests} tests passed (${Math.round((passedTests / totalTests) * 100)}%)`);
console.log('========================================\n');

if (passedTests !== totalTests) {
  process.exit(1);
}

