import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as XLSX from 'xlsx';

// Minimal browser globals for importing client services in Node
const memStorage = new Map();
if (!globalThis.localStorage) {
  globalThis.localStorage = {
    getItem: (k) => (memStorage.has(k) ? memStorage.get(k) : null),
    setItem: (k, v) => memStorage.set(k, String(v)),
    removeItem: (k) => memStorage.delete(k),
    clear: () => memStorage.clear(),
  };
}
if (!globalThis.window) {
  globalThis.window = {
    localStorage: globalThis.localStorage,
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { origin: 'http://localhost', href: 'http://localhost/' },
  };
}

const {
  normalizeClassLabel,
  formatRoomWithGender,
  ICM_SCHOOL_CLASSES_26_27,
  ICM_SEMESTER1_2026_2027_SCHEDULE,
  doesScheduleEntryMatchClass,
  filterScheduleForClass,
  sortStudentsForDeskCards,
  validateExamScheduleEntries,
} = await import('../src/lib/examSchedule.ts');

const {
  parseBulkRosterText,
  parseExcelRosterWorkbook,
  planRosterExcelImport,
} = await import('../src/services/studentRosterService.ts');

const {
  mirrorDeskCardSlots,
  renderCandidateDeskCardsHtml,
} = await import('../src/services/candidateCardPrintService.ts');

const { DEFAULT_SCHOOL_LOGO, DEFAULT_CAMBRIDGE_LOGO } = await import(
  '../src/assets/logoConstants.ts'
);

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

// ── 1. Class Normalization & Room Formatting ──────────────────────────────────

check(
  'DC-1: normalizeClassLabel normalizes "X IPA3" -> "X IPA 3" and "x  ips 2" -> "X IPS 2"',
  normalizeClassLabel('X IPA3') === 'X IPA 3' &&
    normalizeClassLabel('x  ips 2') === 'X IPS 2' &&
    normalizeClassLabel('10 ipa 1') === 'X IPA 1' &&
    normalizeClassLabel('10-A') === '10-A'
);

check(
  'DC-2: formatRoomWithGender formats ICM room headers cleanly with gender label',
  formatRoomWithGender('RUANG 1 - AKHWAT (Total: 16 Siswa)') === 'Room 1 - Akhwat' &&
    formatRoomWithGender('RUANG 6 - IKHWAN (Total: 16 Siswa)') === 'Room 6 - Ikhwan' &&
    formatRoomWithGender('ruang 5 - akhwat') === 'Room 5 - Akhwat'
);

// ── 2. Schedule Filtering Rules (Practical strictly Grade 10 IPA, etc.) ───────

const xIpaSched = filterScheduleForClass(ICM_SEMESTER1_2026_2027_SCHEDULE, 'X IPA 2');
check(
  'DC-3: X IPA receives 3 Grade-10 IPA Practicals + 10 Written sessions = 13 rows',
  xIpaSched.length === 13 &&
    xIpaSched.filter((e) => e.category === 'practical').length === 3 &&
    xIpaSched.some((e) => e.subject === 'English Listening G.10') &&
    !xIpaSched.some((e) => e.subject === 'Sociology'),
  `Got count=${xIpaSched.length}`
);

const xiIpaSched = filterScheduleForClass(ICM_SEMESTER1_2026_2027_SCHEDULE, 'XI IPA 1');
check(
  'DC-4: XI IPA receives 9 Written sessions ONLY (no G.10 Practicals, no G.10 Listening, no IPS)',
  xiIpaSched.length === 9 &&
    xiIpaSched.filter((e) => e.category === 'practical').length === 0 &&
    !xiIpaSched.some((e) => e.subject === 'English Listening G.10') &&
    !xiIpaSched.some((e) => e.subject === 'Economics'),
  `Got count=${xiIpaSched.length}`
);

const xIpsSched = filterScheduleForClass(ICM_SEMESTER1_2026_2027_SCHEDULE, 'X IPS 2');
check(
  'DC-5: X IPS 2 receives 10 Written sessions (IPS electives + G.10 Listening, NO IPA Practicals)',
  xIpsSched.length === 10 &&
    xIpsSched.some((e) => e.subject === 'Sociology') &&
    xIpsSched.some((e) => e.subject === 'English Listening G.10') &&
    !xIpsSched.some((e) => e.category === 'practical') &&
    !xIpsSched.some((e) => e.subject === 'Chemistry'),
  `Got count=${xIpsSched.length}`
);

const schedVal = validateExamScheduleEntries(ICM_SEMESTER1_2026_2027_SCHEDULE);
check('DC-6: Preset ICM 2026/2027 schedule passes validation', schedVal.ok);

check(
  'DC-7: Grade target "X" does not leak into "XI IPA 1" or "XII IPA 1"',
  doesScheduleEntryMatchClass(
    { id: 't1', date: 'Fri', time: '09.30', subject: 'Listening', targetClass: 'X' },
    'X IPS 2'
  ) &&
    !doesScheduleEntryMatchClass(
      { id: 't1', date: 'Fri', time: '09.30', subject: 'Listening', targetClass: 'X' },
      'XI IPA 1'
    ) &&
    !doesScheduleEntryMatchClass(
      { id: 't1', date: 'Fri', time: '09.30', subject: 'Listening', targetClass: 'X' },
      'XII IPA 1'
    )
);

// ── 3. Natural Room & Seat Sorting ────────────────────────────────────────────

const unsorted = [
  { name: 'Student R10 S10', class: 'X IPA 1', room: 'Room 10 - Ikhwan', seatNumber: '10' },
  { name: 'Student R2 S12', class: 'X IPA 2', room: 'Room 2 - Akhwat', seatNumber: '12' },
  { name: 'Student R2 S2', class: 'X IPA 2', room: 'Room 2 - Akhwat', seatNumber: '2' },
];
const sorted = sortStudentsForDeskCards(unsorted, 'room_seat');
check(
  'DC-8: Natural Room & Seat sort orders Room 2 Seat 2 -> Room 2 Seat 12 -> Room 10 Seat 10',
  sorted[0].name === 'Student R2 S2' &&
    sorted[1].name === 'Student R2 S12' &&
    sorted[2].name === 'Student R10 S10'
);

// ── 4. Bulk Text & Tabular Excel Parsing (incl. Room, Seat #, No vs NIS) ──────

const bulkParsed = parseBulkRosterText(
  'Alya Murti\tX IPS2\t262710004\t4821\tRuang 1 - Akhwat\t4\nAmando Saktika\tX IPA1\t262710066\t\tRoom 6 - Ikhwan\t1',
  'X IPA 1'
);
check(
  'DC-9: parseBulkRosterText normalizes classes, extracts room with gender & seatNumber',
  bulkParsed.length === 2 &&
    bulkParsed[0].class === 'X IPS 2' &&
    bulkParsed[0].room === 'Room 1 - Akhwat' &&
    bulkParsed[0].seatNumber === '4' &&
    bulkParsed[0].pin === '4821' &&
    bulkParsed[1].class === 'X IPA 1' &&
    bulkParsed[1].room === 'Room 6 - Ikhwan' &&
    bulkParsed[1].seatNumber === '1' &&
    bulkParsed[1].pin.length === 4
);

const wbFlat = XLSX.utils.book_new();
const wsFlat = XLSX.utils.json_to_sheet([
  {
    No: 1,
    NIS: '262710004',
    Nama: 'Alya Murti Noor Ramadhianti',
    Kelas: 'X IPS2',
    Ruang: 'RUANG 1 - AKHWAT',
    Seat: '4',
  },
  {
    No: 2,
    NIS: '262710003',
    Nama: 'Alvira Nauroh Saajidah',
    Kelas: 'X IPA3',
    Ruang: 'Room 4 - Akhwat',
    Seat: '2',
  },
]);
XLSX.utils.book_append_sheet(wbFlat, wsFlat, 'Roster');
const flatBuf = XLSX.write(wbFlat, { bookType: 'xlsx', type: 'array' });
const flatResult = parseExcelRosterWorkbook(flatBuf);
check(
  'DC-10: Tabular Excel parser prefers NIS over row No., normalizes X IPA3/X IPS2, and extracts Room + Seat #',
  flatResult.students.length === 2 &&
    flatResult.students[0].candidateNumber === '262710004' &&
    flatResult.students[0].class === 'X IPS 2' &&
    flatResult.students[0].room === 'Room 1 - Akhwat' &&
    flatResult.students[0].seatNumber === '4' &&
    flatResult.students[1].class === 'X IPA 3' &&
    flatResult.students[1].candidateNumber === '262710003'
);

// ── 5. Smart Sync Plan: PIN Preservation, Normalization & Pruning ─────────────

const existingDb = [
  {
    id: 'id-carissa',
    name: 'CARISSA ZHAFIRA ZIARAMADHAN',
    class: 'X IPA 2',
    candidateNumber: '262710014',
    pin: '7742',
  },
  {
    id: 'id-alvira',
    name: 'Alvira Nauroh Saajidah',
    class: 'X IPA3',
    candidateNumber: '262710003',
    pin: '8831',
  },
  {
    id: 'id-extra-1',
    name: 'Legacy Student One',
    class: 'XII IPA 2',
    candidateNumber: '232499991',
    pin: '1111',
  },
  {
    id: 'id-extra-2',
    name: 'Legacy Student Two',
    class: 'XII IPA 2',
    candidateNumber: '232499992',
    pin: '2222',
  },
];
const importPlan = planRosterExcelImport(
  existingDb,
  ['X IPA 2', 'X IPA3', 'XII IPA 2'],
  {
    format: 'tabular',
    detectedClasses: ['X IPA 2', 'X IPA 3', 'X IPS 2'],
    students: [
      {
        id: 'tmp-1',
        name: 'CARISSA ZHAFIRA ZIARAMADHAN',
        class: 'X IPA 2',
        candidateNumber: '262710014',
        room: 'Room 1 - Akhwat',
        seatNumber: '1',
        pin: '9999',
      },
      {
        id: 'tmp-2',
        name: 'ALVIRA NAUROH SAAJIDAH',
        class: 'X IPA 3',
        candidateNumber: '262710003',
        room: 'Room 4 - Akhwat',
        seatNumber: '2',
        pin: '9998',
      },
      {
        id: 'tmp-3',
        name: 'ALYA MURTI NOOR RAMADHIANTI',
        class: 'X IPS 2',
        candidateNumber: '262710004',
        room: 'Room 1 - Akhwat',
        seatNumber: '4',
        pin: '5512',
      },
    ],
  }
);

check(
  'DC-11: planRosterExcelImport preserves existing PINs, normalizes X IPA3 -> X IPA 3, adds X IPS 2, and flags extra students to prune',
  importPlan.preservedPinCount === 2 &&
    importPlan.syncedRosterPruned.find((s) => s.candidateNumber === '262710014')?.pin === '7742' &&
    importPlan.syncedRosterPruned.find((s) => s.candidateNumber === '262710003')?.pin === '8831' &&
    importPlan.syncedRosterPruned.length === 3 &&
    importPlan.mergedRosterKeepExtras.length === 5 &&
    importPlan.extraStudentsToPrune.length === 2 &&
    importPlan.renamedClasses.some((r) => r.from === 'X IPA3' && r.to === 'X IPA 3') &&
    importPlan.addedClasses.includes('X IPS 2') &&
    importPlan.normalizedClasses.includes('X IPA 3') &&
    !importPlan.normalizedClasses.includes('X IPA3')
);

// ── 6. Duplex Mirroring, 2x3 Chunking, Logos & XSS Escaping ───────────────────

const longMirror = mirrorDeskCardSlots(['A', 'B', 'C', 'D', 'E'], 'long');
assert.deepEqual(longMirror, ['B', 'A', 'D', 'C', null, 'E']);
const shortMirror = mirrorDeskCardSlots(['A', 'B'], 'short');
assert.deepEqual(shortMirror, [null, null, null, null, 'A', 'B']);
check('DC-12: mirrorDeskCardSlots mirrors both long-edge and short-edge duplex orientations accurately', true);

const sevenStudents = Array.from({ length: 7 }, (_, i) => ({
  id: `s-${i + 1}`,
  name: i === 6 ? '<script>alert("xss")</script> Last Candidate' : `Candidate ${i + 1}`,
  class: i === 0 ? 'X IPA 1' : 'XI IPS 2',
  candidateNumber: `26271000${i + 1}`,
  room: i === 6 ? 'Room 2 - Akhwat <img onerror=1>' : `Room 1 - Akhwat`,
  seatNumber: String(i + 1),
  pin: `${1000 + i}`,
}));
const renderedHtml = renderCandidateDeskCardsHtml(sevenStudents, ICM_SEMESTER1_2026_2027_SCHEDULE, {
  includeScheduleBack: true,
  duplexFlip: 'long',
  sortMode: 'room_seat',
});
const frontSheetCount = (renderedHtml.match(/class="desk-card-sheet desk-card-sheet--front"/g) || []).length;
const backSheetCount = (renderedHtml.match(/class="desk-card-sheet desk-card-sheet--back"/g) || []).length;
check(
  'DC-13: renderCandidateDeskCardsHtml chunks 7 candidates into 2 front + 2 mirrored back 2x3 A4 sheets with both logos, CANDIDATE CARD title, ink-saving white Seat pill & XSS escaping',
  frontSheetCount === 2 &&
    backSheetCount === 2 &&
    renderedHtml.includes('<div class="card-title">CANDIDATE CARD</div>') &&
    !renderedHtml.includes('CANDIDATE DESK CARD') &&
    renderedHtml.includes('align-items: baseline;') &&
    renderedHtml.includes(DEFAULT_SCHOOL_LOGO) &&
    renderedHtml.includes(DEFAULT_CAMBRIDGE_LOGO) &&
    !renderedHtml.includes('<script>alert("xss")</script>') &&
    renderedHtml.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;') &&
    renderedHtml.includes('&lt;img onerror=1&gt;')
);

// Check last back page has empty slot before Card 7 Back (row [slot7, empty] mirrored -> [empty, slot7])
const lastBackMarker = renderedHtml.lastIndexOf('class="desk-card-sheet desk-card-sheet--back"');
const lastBackChunk = renderedHtml.slice(lastBackMarker);
const firstEmptyIdx = lastBackChunk.indexOf('desk-card-slot--empty');
const lastCardBackIdx = lastBackChunk.indexOf('desk-card-slot--back');
check(
  'DC-14: Partial page reverse side places empty spacer on left so Card 7 Back aligns directly behind Card 7 Front',
  firstEmptyIdx > 0 && lastCardBackIdx > firstEmptyIdx
);

// ── 7. Real Uploaded Excel Workbook Verification (if present locally) ──────────

const uploadedWorkbookPath =
  'C:/Users/orin/.gemini/antigravity/brain/c47873ec-764e-4639-9c60-2d8b6e73fc78/.user_uploaded/media_1794839778860_3b83b7ba.xlsx';
if (fs.existsSync(uploadedWorkbookPath)) {
  const realBuf = fs.readFileSync(uploadedWorkbookPath);
  const realParsed = parseExcelRosterWorkbook(
    realBuf.buffer.slice(realBuf.byteOffset, realBuf.byteOffset + realBuf.byteLength)
  );

  const audrey = realParsed.students.find((s) => s.candidateNumber === '262710010');
  const ahmadHanant = realParsed.students.find((s) => s.candidateNumber === '242510004');
  const azzamPandya = realParsed.students.find((s) => s.candidateNumber === '242510039');
  const allAssignedRoomSeat = realParsed.students.every((s) => Boolean(s.room && s.seatNumber));
  const xIps2Count = realParsed.students.filter((s) => s.class === 'X IPS 2').length;
  const xIpa3Count = realParsed.students.filter((s) => s.class === 'X IPA 3').length;
  const practicalCount = (realParsed.detectedSchedule || []).filter(
    (e) => e.category === 'practical'
  ).length;
  const practicalTargetsAllXIpa = (realParsed.detectedSchedule || [])
    .filter((e) => e.category === 'practical')
    .every((e) => e.targetClass === 'X IPA');

  check(
    'DC-15: Real ICM workbook extracts all 166 active 26/27 candidates across 13 classes (incl. X IPS 2 & X IPA 3)',
    realParsed.format === 'icm_workbook' &&
      realParsed.students.length === 166 &&
      realParsed.detectedClasses.length === ICM_SCHOOL_CLASSES_26_27.length &&
      xIps2Count === 7 &&
      xIpa3Count === 11 &&
      allAssignedRoomSeat,
    `students=${realParsed.students.length}, classes=${realParsed.detectedClasses.length}`
  );

  check(
    'DC-16: Real ICM workbook auto-places Audrey (Room 5 - Akhwat #13), Ahmad Hanant (Room 11 - Ikhwan #9), and recovers Azzam Pandya (Room 9 - Ikhwan #16)',
    audrey?.room === 'Room 5 - Akhwat' &&
      audrey?.seatNumber === '13' &&
      ahmadHanant?.room === 'Room 11 - Ikhwan' &&
      ahmadHanant?.seatNumber === '9' &&
      azzamPandya?.room === 'Room 9 - Ikhwan' &&
      azzamPandya?.seatNumber === '16',
    JSON.stringify({ audrey, ahmadHanant, azzamPandya })
  );

  check(
    'DC-17: Real ICM workbook parses 16 schedule entries with 3 Practical dates targeted exclusively to X IPA',
    (realParsed.detectedSchedule || []).length === 16 &&
      practicalCount === 3 &&
      practicalTargetsAllXIpa,
    `scheduleLen=${realParsed.detectedSchedule?.length}, prac=${practicalCount}`
  );
} else {
  console.log('SKIP: DC-15..17 skipped (local uploaded workbook fixture not present)');
}

console.log(`\nCandidate Desk Card tests: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
