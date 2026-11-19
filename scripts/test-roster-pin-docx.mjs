import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { Packer } from 'docx';

// Minimal DOM storage shim for Node ESM testing
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

const {
  prepareRosterForPinExport,
  buildRosterPinDocxDocument,
} = await import('../src/services/rosterPinDocxService.ts');

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`PASS: ${label}`);
    passed++;
  } else {
    console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// Synthetic roster spanning 2 classes (>18 students in X IPA 1 to test multi-page slip chunking + 1 missing PIN)
const sampleRoster = [
  ...Array.from({ length: 20 }, (_, idx) => ({
    id: `ipa1-${idx + 1}`,
    name: idx === 0 ? 'Zaidan Pratama' : `Student Alpha ${String(idx).padStart(2, '0')}`,
    class: 'X IPA 1',
    candidateNumber: `2600${idx + 1}`,
    room: 'Room 1',
    seatNumber: String(idx + 1),
    pin: idx === 19 ? '' : String(1100 + idx),
  })),
  {
    id: 'ipa2-1',
    name: 'Alya Rahma',
    class: 'X IPA 2',
    candidateNumber: '26099',
    room: 'Room 2',
    seatNumber: '1',
    pin: '8421',
  },
  {
    id: 'ipa2-2',
    name: 'Budi Santoso',
    class: 'X IPA 2',
    candidateNumber: '26100',
    room: 'Room 2',
    seatNumber: '2',
    pin: '9512',
  },
];

// ── Test 1: Missing PIN Auto-Assignment ─────────────────────────────────────
const { updatedRoster, assignedCount } = prepareRosterForPinExport(sampleRoster);
const allFourDigit = updatedRoster.every((s) => /^\d{4}$/.test(s.pin));
const allUnique = new Set(updatedRoster.map((s) => s.pin)).size === updatedRoster.length;
check(
  'RPD-1: prepareRosterForPinExport auto-assigns unique 4-digit PINs for missing entries',
  assignedCount === 1 && allFourDigit && allUnique,
  JSON.stringify({ assignedCount, allFourDigit, allUnique })
);

// ── Test 2: Generate & Inspect DOCX XML Package ─────────────────────────────
const doc = await buildRosterPinDocxDocument(updatedRoster);
const buffer = await Packer.toBuffer(doc);
const zip = await JSZip.loadAsync(buffer);
const docXml = await zip.file('word/document.xml')?.async('string');

check(
  'RPD-2: Generated .docx is a valid Word OOXML archive with word/document.xml',
  Boolean(docXml && docXml.length > 2000 && zip.file('[Content_Types].xml'))
);

// Check both sections, class headings, alphabetical order, and page breaks
const ipa1MasterIdx = docXml.indexOf('Candidate Name &amp; Exam PIN Sheet — X IPA 1');
const ipa2MasterIdx = docXml.indexOf('Candidate Name &amp; Exam PIN Sheet — X IPA 2');
const ipa1SlipPage1Idx = docXml.indexOf('Cut-Out Student PIN Slips — X IPA 1 (Page 1/2)');
const ipa1SlipPage2Idx = docXml.indexOf('Cut-Out Student PIN Slips — X IPA 1 (Page 2/2)');
const ipa2SlipIdx = docXml.indexOf('Cut-Out Student PIN Slips — X IPA 2');

const pageBreakMatches = docXml.match(/<w:pageBreakBefore/g) || [];

check(
  'RPD-3: Document places Master Tables per class first, followed by 18-per-page Cut-Out Slips per class with page breaks',
  ipa1MasterIdx > -1 &&
    ipa2MasterIdx > ipa1MasterIdx &&
    ipa1SlipPage1Idx > ipa2MasterIdx &&
    ipa1SlipPage2Idx > ipa1SlipPage1Idx &&
    ipa2SlipIdx > ipa1SlipPage2Idx &&
    pageBreakMatches.length >= 4,
  JSON.stringify({
    ipa1MasterIdx,
    ipa2MasterIdx,
    ipa1SlipPage1Idx,
    ipa1SlipPage2Idx,
    ipa2SlipIdx,
    pageBreakCount: pageBreakMatches.length,
  })
);

// Strictly minimal fields check: Name, Class, PIN present; Room, Seat #, Candidate Number absent
const newAssignedPin = updatedRoster.find((s) => s.id === 'ipa1-20')?.pin;
check(
  'RPD-4: Strictly renders Student Name, Class, and 4-digit PIN while omitting Room, Seat #, and Candidate #',
  docXml.includes('Zaidan Pratama') &&
    docXml.includes('Alya Rahma') &&
    docXml.includes('8421') &&
    docXml.includes(String(newAssignedPin)) &&
    !docXml.includes('Room 1') &&
    !docXml.includes('Room 2') &&
    !docXml.includes('26099'),
  JSON.stringify({ newAssignedPin })
);

// Class filter test
const singleClassDoc = await buildRosterPinDocxDocument(updatedRoster, { classFilter: 'X IPA 2' });
const singleBuf = await Packer.toBuffer(singleClassDoc);
const singleZip = await JSZip.loadAsync(singleBuf);
const singleXml = await singleZip.file('word/document.xml')?.async('string');
check(
  'RPD-5: classFilter restricts exported document strictly to the selected class',
  Boolean(singleXml) &&
    singleXml.includes('Alya Rahma') &&
    singleXml.includes('8421') &&
    !singleXml.includes('Zaidan Pratama')
);

// Wiring check on AdvancedSettingsPage & CandidateCardPrintModal
const advSrc = fs.readFileSync(path.resolve('src/pages/AdvancedSettingsPage.tsx'), 'utf8');
const modalSrc = fs.readFileSync(path.resolve('src/components/CandidateCardPrintModal.tsx'), 'utf8');
check(
  'RPD-6: AdvancedSettingsPage and CandidateCardPrintModal wire Export PINs (.docx) cleanly',
  advSrc.includes('exportRosterPinSheetDocx') &&
    advSrc.includes('Export PINs (.docx)') &&
    modalSrc.includes('exportRosterPinSheetDocx') &&
    modalSrc.includes('Export PINs (.docx)')
);

console.log(`\nRoster PIN DOCX export tests: ${passed} passed, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
