import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';

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
  OVERDUE_LOCK_THRESHOLD_MS,
  reconcileStudentLockTimestamp,
  getLockedDurationMs,
  formatLockedDuration,
  computeWaitCompensationMinutes,
  findOverdueLockedStudents,
  filterProctorLogs,
  upsertProctorAlertToast,
  getPriorityTriageRank,
} = await import('../src/lib/proctorAlertEngine.ts');

const { buildProctorAuditLogWorkbookICM } = await import('../src/services/icmExcelExportService.ts');

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

const baseStudent = (overrides = {}) => ({
  studentId: 'stu_ali',
  studentName: 'Ali Hasan',
  candidateNumber: '001',
  candidateClass: '10-A',
  status: 'active',
  answeredCount: 5,
  totalQuestions: 20,
  currentIndex: 6,
  timeLeftSeconds: 1800,
  violationsCount: 0,
  multiMonitorDetected: false,
  lastHeartbeat: 1_000_000,
  quizCode: 'CHEM10',
  ...overrides,
});

// ── 1. Lock Timestamp Reconciliation ──────────────────────────────────────────

const t0 = 1_700_000_000_000;
const lockedInit = reconcileStudentLockTimestamp(undefined, baseStudent({ status: 'locked' }), t0);
check('PA-1a: Initial lock stamps receiver clock timestamp', lockedInit === t0);

const tamperedLater = reconcileStudentLockTimestamp(
  baseStudent({ status: 'locked', lockedSince: t0 }),
  baseStudent({ status: 'locked', lockedSince: t0 + 999_999 }),
  t0 + 25_000
);
check('PA-1b: Subsequent locked heartbeats preserve original lock episode timestamp', tamperedLater === t0);

const unlockedCleared = reconcileStudentLockTimestamp(
  baseStudent({ status: 'locked', lockedSince: t0 }),
  baseStudent({ status: 'active', lockedSince: t0 }),
  t0 + 30_000
);
check('PA-1c: Transitioning to active clears lockedSince', unlockedCleared === undefined);

const futureClamped = reconcileStudentLockTimestamp(
  undefined,
  baseStudent({ status: 'locked', lockedSince: t0 + 500_000 }),
  t0
);
check('PA-1d: Future sender clock lockedSince is clamped to receiver nowMs', futureClamped === t0);

// ── 2. Overdue (> 1 Minute) Lock-Screen Escalation Sweep ──────────────────────

const alertedEpisodes = {};
const stuLocked = baseStudent({ status: 'locked', lockedSince: t0 });
const stuAutoSub = baseStudent({
  studentId: 'stu_budi',
  studentName: 'Budi',
  status: 'locked',
  lockedSince: t0 - 120_000,
  autoSubmittedBySecurity: true,
});

check(
  'PA-2a: Student locked for 59s does not trigger >1m escalation alert',
  findOverdueLockedStudents([stuLocked, stuAutoSub], alertedEpisodes, t0 + 59_000).length === 0
);

const firstSweep = findOverdueLockedStudents(
  [stuLocked, stuAutoSub],
  alertedEpisodes,
  t0 + OVERDUE_LOCK_THRESHOLD_MS
);
check(
  'PA-2b: Student locked for exactly 60s triggers overdue escalation (auto-submitted excluded)',
  firstSweep.length === 1 && firstSweep[0].studentId === 'stu_ali'
);

// Record episode alert as modal does
alertedEpisodes['CHEM10::stu_ali'] = stuLocked.lockedSince;
check(
  'PA-2c: Already-alerted lock episode does not re-fire on next tick',
  findOverdueLockedStudents([stuLocked], alertedEpisodes, t0 + 95_000).length === 0
);

// Simulate unlock then new lock later
const stuRelocked = baseStudent({ status: 'locked', lockedSince: t0 + 200_000 });
const secondEpisode = findOverdueLockedStudents([stuRelocked], alertedEpisodes, t0 + 265_000);
check(
  'PA-2d: Re-locking in a new episode re-arms 1-minute overdue escalation',
  secondEpisode.length === 1 && secondEpisode[0].studentId === 'stu_ali'
);

check(
  'PA-3: Duration formatting & compensation minutes behave accurately',
  getLockedDurationMs(stuLocked, t0 + 125_000) === 125_000 &&
    formatLockedDuration(125_000) === '02:05' &&
    computeWaitCompensationMinutes(65_000) === 1 &&
    computeWaitCompensationMinutes(140_000) === 2 &&
    computeWaitCompensationMinutes(3_600_000) === 15
);

// ── 3. Individual & Class Log Filtering ───────────────────────────────────────

const sampleLogs = [
  {
    id: '1',
    timestamp: '2026-11-16T08:01:00Z',
    studentId: 'stu_ali',
    studentName: 'Ali Hasan',
    candidateNumber: '001',
    candidateClass: '10-A',
    quizCode: 'CHEM10',
    type: 'tab_switch',
    detail: 'Switched browser tab',
    severity: 'warning',
  },
  {
    id: '2',
    timestamp: '2026-11-16T08:02:00Z',
    studentId: 'stu_ali',
    studentName: 'Ali Hasan',
    candidateNumber: '001',
    candidateClass: '10-A',
    quizCode: 'CHEM10',
    type: 'unlocked',
    detail: 'Remotely unlocked by invigilator',
    severity: 'info',
  },
  {
    id: '3',
    timestamp: '2026-11-16T08:03:00Z',
    studentId: 'stu_citra',
    studentName: 'Citra Dewi',
    candidateNumber: '002',
    candidateClass: '10-B',
    quizCode: 'CHEM10',
    type: 'locked',
    detail: '=cmd|"calc" EXITED FULLSCREEN',
    severity: 'critical',
  },
];

const class10ALogs = filterProctorLogs(sampleLogs, { quizCode: 'CHEM10', className: '10-A' });
check('PA-4a: Class log filter isolates events for Class 10-A', class10ALogs.length === 2);

const aliInterventions = filterProctorLogs(sampleLogs, {
  quizCode: 'CHEM10',
  studentId: 'stu_ali',
  category: 'interventions',
});
check(
  'PA-4b: Individual student + interventions filter captures unlock event',
  aliInterventions.length === 1 && aliInterventions[0].id === '2'
);

const violationSearch = filterProctorLogs(sampleLogs, {
  category: 'violations',
  search: 'switched',
});
check(
  'PA-4c: Violation category + keyword search narrows to tab_switch event',
  violationSearch.length === 1 && violationSearch[0].id === '1'
);

// ── 4. Toast Coalescing & Priority Triage Sort ────────────────────────────────

let toasts = [];
toasts = upsertProctorAlertToast(toasts, {
  id: 't1',
  compositeKey: 'CHEM10::stu_ali',
  quizCode: 'CHEM10',
  studentId: 'stu_ali',
  studentName: 'Ali Hasan',
  kind: 'violation',
  severity: 'warning',
  title: 'Notice 1',
  detail: 'Blur #1',
  createdAt: t0,
});
toasts = upsertProctorAlertToast(toasts, {
  id: 't2',
  compositeKey: 'CHEM10::stu_ali',
  quizCode: 'CHEM10',
  studentId: 'stu_ali',
  studentName: 'Ali Hasan',
  kind: 'violation',
  severity: 'warning',
  title: 'Notice 2',
  detail: 'Blur #2',
  createdAt: t0 + 4000,
});
check(
  'PA-5: Coalesces rapid duplicate alerts from same student within 15s window',
  toasts.length === 1 && toasts[0].repeatCount === 2 && toasts[0].detail === 'Blur #2'
);

const rankOverdue = getPriorityTriageRank(stuLocked, t0 + 70_000, false);
const rankLockedFresh = getPriorityTriageRank(stuLocked, t0 + 10_000, false);
const rankWarning = getPriorityTriageRank(baseStudent({ status: 'warning', violationsCount: 1 }), t0, false);
const rankActive = getPriorityTriageRank(baseStudent({ status: 'active' }), t0, false);
check(
  'PA-6: Priority triage strictly orders Overdue Lock < Fresh Lock < Warning < Active',
  rankOverdue < rankLockedFresh && rankLockedFresh < rankWarning && rankWarning < rankActive
);

// ── 5. Proctoring Audit Log Excel Export ──────────────────────────────────────

const { wb, filename } = buildProctorAuditLogWorkbookICM(sampleLogs, {
  reportTitle: 'Proctoring Log — Class 10-A',
  quizCode: 'CHEM10',
  targetClass: '10-A',
});
const buf = await wb.xlsx.writeBuffer();
const parsed = new ExcelJS.Workbook();
await parsed.xlsx.load(buf);
const ws = parsed.getWorksheet('Proctoring Audit Log');
check(
  'PA-7: Proctoring Audit Log Excel workbook embeds dual logos, sanitizes cells, and bounds metadata',
  Boolean(ws) &&
    filename === '10-a_proctor_audit_log.xlsx' &&
    ws.getImages().length === 2 &&
    String(ws.getCell('H9').value).startsWith("'=cmd")
);

console.log(`\nSummary: ${passed} passed, ${failed} failed`);
assert.equal(failed, 0, `${failed} assertion(s) failed`);
