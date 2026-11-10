// ═══════════════════════════════════════════════════════════════════════════════
// TEST: Multi-Tier Exam Security Violation & Penalty System
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';
import {
  DEFAULT_SECURITY_TIERS,
  normalizeSecurityTiers,
  validateSecurityTiers,
  resolveTierForStrike,
  shouldCountAsStrike,
  applyTimePenalty,
  resolveUnlockClock,
  STRIKE_COALESCE_MS,
  PENALTY_GRACE_SECONDS,
} from '../src/lib/securityTiers.ts';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('🧪 Running Multi-Tier Exam Security Test Suite...\n');

// ─── PART A: Unit Tests for Pure Tier Engine ─────────────────────────────────

// A1: Default tiers integrity
check(
  'A1. DEFAULT_SECURITY_TIERS has 4 escalation tiers with required final auto_submit',
  DEFAULT_SECURITY_TIERS.length === 4 &&
  DEFAULT_SECURITY_TIERS[0].action === 'warning' &&
  DEFAULT_SECURITY_TIERS[1].action === 'time_penalty' &&
  DEFAULT_SECURITY_TIERS[1].penaltyMinutes === 5 &&
  DEFAULT_SECURITY_TIERS[2].action === 'time_penalty' &&
  DEFAULT_SECURITY_TIERS[2].penaltyMinutes === 10 &&
  DEFAULT_SECURITY_TIERS[3].action === 'auto_submit'
);

// A2: Normalization on null / empty input
const normEmpty = normalizeSecurityTiers(null);
check(
  'A2. normalizeSecurityTiers(null) returns deep copy of DEFAULT_SECURITY_TIERS',
  normEmpty.length === 4 && normEmpty[3].action === 'auto_submit'
);

// A3: Normalization ensures ascending order & final tier auto_submit
const unsortedRaw = [
  { strikeCount: 3, name: 'Late Penalty', action: 'time_penalty', penaltyMinutes: 10 },
  { strikeCount: 1, name: 'First Warning', action: 'warning' },
  { strikeCount: 2, name: 'Mid Penalty', action: 'time_penalty', penaltyMinutes: 5 },
];
const normUnsorted = normalizeSecurityTiers(unsortedRaw);
check(
  'A3. normalizeSecurityTiers sorts ascending and converts final tier to auto_submit',
  normUnsorted.length === 3 &&
  normUnsorted[0].strikeCount === 1 &&
  normUnsorted[1].strikeCount === 2 &&
  normUnsorted[2].strikeCount === 3 &&
  normUnsorted[2].action === 'auto_submit'
);

// A4: Validate default tiers
const valDefault = validateSecurityTiers(DEFAULT_SECURITY_TIERS);
check('A4. validateSecurityTiers(DEFAULT_SECURITY_TIERS) succeeds with 0 errors', valDefault.ok && valDefault.errors.length === 0);

// A5: Validate fails on non-strictly increasing strikes
const nonIncreasing = [
  { id: '1', strikeCount: 1, name: 'T1', action: 'warning' },
  { id: '2', strikeCount: 1, name: 'T2', action: 'auto_submit' },
];
const valNonInc = validateSecurityTiers(nonIncreasing);
check(
  'A5. validateSecurityTiers fails on duplicate/non-increasing strike counts',
  !valNonInc.ok && valNonInc.errors.some((e) => e.includes('strictly greater'))
);

// A6: Validate fails when final tier is not auto_submit
const noAutoSubmit = [
  { id: '1', strikeCount: 1, name: 'T1', action: 'warning' },
  { id: '2', strikeCount: 2, name: 'T2', action: 'time_penalty', penaltyMinutes: 5 },
];
const valNoAuto = validateSecurityTiers(noAutoSubmit);
check(
  'A6. validateSecurityTiers fails when final tier action is not auto_submit',
  !valNoAuto.ok && valNoAuto.errors.some((e) => e.includes('Final Warning (Auto Submit)'))
);

// A7: Validate fails on invalid penalty minutes
const invalidPenalty = [
  { id: '1', strikeCount: 1, name: 'T1', action: 'warning' },
  { id: '2', strikeCount: 2, name: 'T2', action: 'time_penalty', penaltyMinutes: 0 },
  { id: '3', strikeCount: 3, name: 'T3', action: 'auto_submit' },
];
const valInvPen = validateSecurityTiers(invalidPenalty);
check(
  'A7. validateSecurityTiers fails on time_penalty with 0 minutes',
  !valInvPen.ok && valInvPen.errors.some((e) => e.includes('between 1 and 120'))
);

// A8: Resolve tier for Strike 1
const t1 = resolveTierForStrike(DEFAULT_SECURITY_TIERS, 1);
check('A8. resolveTierForStrike(1) resolves to Early Warning (warning)', t1?.name === 'Early Warning' && t1?.action === 'warning');

// A9: Resolve tier for Strike 2
const t2 = resolveTierForStrike(DEFAULT_SECURITY_TIERS, 2);
check('A9. resolveTierForStrike(2) resolves to Warning with Penalty (-5m)', t2?.name === 'Warning with Penalty' && t2?.penaltyMinutes === 5);

// A10: Resolve tier for Strike 4
const t4 = resolveTierForStrike(DEFAULT_SECURITY_TIERS, 4);
check('A10. resolveTierForStrike(4) resolves to Final Warning (auto_submit)', t4?.action === 'auto_submit');

// A11: Resolve tier for Strike 10 clamps to final tier
const t10 = resolveTierForStrike(DEFAULT_SECURITY_TIERS, 10);
check('A11. resolveTierForStrike(10) clamps to final auto_submit tier', t10?.action === 'auto_submit' && t10?.strikeCount === 4);

// A12: Resolve tier below lowest threshold returns null
const customTiers = [
  { id: 't2', strikeCount: 2, name: 'Tier 2', action: 'warning' },
  { id: 't3', strikeCount: 3, name: 'Tier 3', action: 'auto_submit' },
];
const tBelow = resolveTierForStrike(customTiers, 1);
check('A12. resolveTierForStrike returns null if strike count is below first tier threshold', tBelow === null);

// ─── PART B: Scenario & State Machine Tests ──────────────────────────────────

// B1: Rule R1 — No strikes while locked
const now = Date.now();
const canStrikeWhileLocked = shouldCountAsStrike({
  isLocked: true,
  nowMs: now,
  lastStrikeAtMs: now - 10000,
});
check('B1. Rule R1: shouldCountAsStrike is FALSE when screen is already locked', canStrikeWhileLocked === false);

// B2: Rule R2 — Coalesce rapid violation bursts within 2s
const canStrikeBurst = shouldCountAsStrike({
  isLocked: false,
  nowMs: now,
  lastStrikeAtMs: now - 800, // 800ms ago (e.g. Alt+Tab fired blur then tab_switch)
  coalesceMs: STRIKE_COALESCE_MS,
});
check('B2. Rule R2: shouldCountAsStrike is FALSE for rapid burst within 2s', canStrikeBurst === false);

// B3: Strike allowed after coalesce window passes
const canStrikeAfterCoalesce = shouldCountAsStrike({
  isLocked: false,
  nowMs: now,
  lastStrikeAtMs: now - 2500, // 2.5s ago
  coalesceMs: STRIKE_COALESCE_MS,
});
check('B3. shouldCountAsStrike is TRUE once 2s coalesce window has elapsed', canStrikeAfterCoalesce === true);

// B4: Time penalty deduction math
const baseEnd = now + 30 * 60 * 1000; // 30 minutes left
const penaltyResult = applyTimePenalty({
  targetEndTime: baseEnd,
  nowMs: now,
  penaltyMinutes: 5,
});
check(
  'B4. applyTimePenalty cleanly deducts 5 minutes (300s) from targetEndTime',
  penaltyResult.remainingSeconds === 25 * 60 &&
  penaltyResult.deductedSeconds === 300 &&
  penaltyResult.exhausted === false
);

// B5: Time penalty clamped at nowMs when penalty exceeds remaining time
const shortEnd = now + 3 * 60 * 1000; // 3 minutes left
const clampResult = applyTimePenalty({
  targetEndTime: shortEnd,
  nowMs: now,
  penaltyMinutes: 10,
});
check(
  'B5. applyTimePenalty clamps remaining time at 0 and flags exhausted=true',
  clampResult.remainingSeconds === 0 &&
  clampResult.deductedSeconds === 180 &&
  clampResult.exhausted === true &&
  clampResult.targetEndTime === now
);

// B6: 30-second grace clock on teacher unlock if exhausted
const unlockGrace = resolveUnlockClock({
  targetEndTime: now, // exhausted
  nowMs: now,
  graceSeconds: PENALTY_GRACE_SECONDS,
});
check(
  'B6. resolveUnlockClock grants 30-second grace window when remaining time was exhausted by penalty',
  unlockGrace.graceApplied === true &&
  unlockGrace.remainingSeconds === 30 &&
  unlockGrace.targetEndTime === now + 30 * 1000
);

// ─── PART C: Source Code Tripwires ───────────────────────────────────────────

// C1: Pure Tier Module Exports
const secTiersSource = fs.readFileSync('src/lib/securityTiers.ts', 'utf8');
check(
  'C1. Pure Tier Module exports all required types, constants, and math functions',
  secTiersSource.includes('export const DEFAULT_SECURITY_TIERS') &&
  secTiersSource.includes('export function normalizeSecurityTiers') &&
  secTiersSource.includes('export function validateSecurityTiers') &&
  secTiersSource.includes('export function resolveTierForStrike') &&
  secTiersSource.includes('export function shouldCountAsStrike') &&
  secTiersSource.includes('export function applyTimePenalty') &&
  secTiersSource.includes('export function resolveUnlockClock')
);

// C2: Settings Type & Helpers
const settingsSource = fs.readFileSync('src/lib/settings.ts', 'utf8');
check(
  'C2. Settings module exports local and cloud sync helpers for security tiers',
  settingsSource.includes('export function getSecurityTiers') &&
  settingsSource.includes('export function saveSecurityTiers') &&
  settingsSource.includes('export async function syncSecurityTiersToCloud') &&
  settingsSource.includes('export async function loadAndSyncSecurityTiers')
);

// C3: App Boot Hook
const appSource = fs.readFileSync('src/App.tsx', 'utf8');
check(
  'C3. App.tsx invokes loadAndSyncSecurityTiers on boot alongside Gemini API key tier',
  appSource.includes('loadAndSyncSecurityTiers')
);

// C4: Admin Settings UI
const advSettingsSource = fs.readFileSync('src/pages/AdvancedSettingsPage.tsx', 'utf8');
check(
  'C4. AdvancedSettingsPage includes Violation Escalation Tiers policy editor',
  advSettingsSource.includes('Violation Escalation Tiers') &&
  advSettingsSource.includes('validateSecurityTiers') &&
  advSettingsSource.includes('handleRestoreDefaultTiers')
);

// C5: Service Contracts & Draft Snapshot
const draftServiceSource = fs.readFileSync('src/services/examDraftService.ts', 'utf8');
const codeServiceSource = fs.readFileSync('src/services/quizCodeService.ts', 'utf8');
check(
  'C5. Exam draft and quiz code services include security tier snapshot contracts',
  draftServiceSource.includes('securityTiersSnapshot?: SecurityViolationTier[]') &&
  draftServiceSource.includes('autoSubmittedBySecurity?: boolean') &&
  codeServiceSource.includes('securityTiers?: SecurityViolationTier[]')
);

// C6: Proctor Realtime Telemetry
const proctorServiceSource = fs.readFileSync('src/services/examProctorRealtimeService.ts', 'utf8');
check(
  'C6. Proctor realtime service includes strike count and active tier state',
  proctorServiceSource.includes('strikeCount?: number') &&
  proctorServiceSource.includes('currentTierName?: string') &&
  proctorServiceSource.includes('currentTierAction?: SecurityTierAction') &&
  proctorServiceSource.includes('totalPenaltySeconds?: number') &&
  proctorServiceSource.includes('autoSubmittedBySecurity?: boolean')
);

// C7: Submission Forensics Extension
const subServiceSource = fs.readFileSync('src/services/quizSubmissionService.ts', 'utf8');
check(
  'C7. Exam forensics includes final strike count, tier reached, and penalty seconds',
  subServiceSource.includes('finalStrikeCount?: number') &&
  subServiceSource.includes('finalTierReached?: string') &&
  subServiceSource.includes('totalPenaltySeconds?: number') &&
  subServiceSource.includes('autoSubmittedBySecurity?: boolean')
);

// C8: StudentQuizRunner Lock Screen & Timer Guard
const runnerSource = fs.readFileSync('src/pages/StudentQuizRunner.tsx', 'utf8');
check(
  'C8. StudentQuizRunner enforces tiered policy, timer lock guard, and final auto-submit',
  runnerSource.includes('shouldCountAsStrike') &&
  runnerSource.includes('resolveTierForStrike') &&
  runnerSource.includes('applyTimePenalty') &&
  runnerSource.includes('resolveUnlockClock') &&
  runnerSource.includes('isFinalSecurityLock') &&
  runnerSource.includes('resolveLockScreenPresentation') &&
  runnerSource.includes('lockPresentation.title')
);

// C9: Live Invigilator Telemetry & Pardon
const cockpitSource = fs.readFileSync('src/components/LiveInvigilatorModal.tsx', 'utf8');
check(
  'C9. Live Invigilator cockpit renders tier badges and resets strike counter on pardon',
  cockpitSource.includes('AUTO-SUBMITTED') &&
  cockpitSource.includes('s.autoSubmittedBySecurity') &&
  cockpitSource.includes('strikeCount: 0')
);

// C10: Results & Export Services
const resultsModalSource = fs.readFileSync('src/components/QuizResultsModal.tsx', 'utf8');
const excelSource = fs.readFileSync('src/services/icmExcelExportService.ts', 'utf8');
const pdfSource = fs.readFileSync('src/services/quizReportPdfService.ts', 'utf8');
check(
  'C10. Results modal, Excel export, and PDF report render security tier telemetry',
  resultsModalSource.includes('autoSubmittedBySecurity') &&
  excelSource.includes('autoSubmittedBySecurity') &&
  pdfSource.includes('autoSubmittedBySecurity')
);

// ─── PART D: Tier-Adaptive Lock Screen Unit & UI Guardrail Tests ──────────────

const { resolveLockScreenPresentation, cleanViolationEventText } = await import('../src/lib/securityTiers.ts');

// D1: Strike 1 Warning Presentation
const p1 = resolveLockScreenPresentation({
  tiers: DEFAULT_SECURITY_TIERS,
  strikeCount: 1,
  activeTier: DEFAULT_SECURITY_TIERS[0],
  isFinalLock: false,
  rawLockReason: '[Early Warning] Window blur detected. Invigilator PIN required to resume (no time penalty).',
});
check(
  'D1. Strike 1 resolves to warning variant, caution icon ⚠️, and pausing header',
  p1.variant === 'warning' &&
  p1.icon === '⚠️' &&
  p1.title === 'EXAMINATION PAUSED (FIRST WARNING)' &&
  p1.strikesRemaining === 3 &&
  p1.steps[0].status === 'active' &&
  p1.steps[1].status === 'upcoming'
);

// D2: Strike 2 Time Penalty Presentation & Bounded Labels (Guardrail G1)
const p2 = resolveLockScreenPresentation({
  tiers: DEFAULT_SECURITY_TIERS,
  strikeCount: 2,
  activeTier: DEFAULT_SECURITY_TIERS[1],
  isFinalLock: false,
  rawLockReason: '🚨 [Warning with Penalty] Fullscreen exited. Penalty: -5 min deducted. Invigilator PIN required.',
});
check(
  'D2. Strike 2 resolves to time_penalty variant, siren 🚨, and all stepper labels are <= 12 chars',
  p2.variant === 'time_penalty' &&
  p2.icon === '🚨' &&
  p2.title === 'EXAMINATION LOCKED (TIME PENALTY)' &&
  p2.strikesRemaining === 2 &&
  p2.steps[0].status === 'completed' &&
  p2.steps[1].status === 'active' &&
  p2.steps.every((s) => s.shortLabel.length <= 12)
);

// D3: Final Strike Presentation
const p4 = resolveLockScreenPresentation({
  tiers: DEFAULT_SECURITY_TIERS,
  strikeCount: 4,
  activeTier: DEFAULT_SECURITY_TIERS[3],
  isFinalLock: true,
  rawLockReason: '[Final Warning] Maximum strikes reached.',
});
check(
  'D3. Final strike resolves to final variant, stop sign 🛑, and 0 strikes remaining',
  p4.variant === 'final' &&
  p4.icon === '🛑' &&
  p4.title === 'EXAMINATION TERMINATED (STRIKE LIMIT REACHED)' &&
  p4.strikesRemaining === 0 &&
  p4.steps[3].status === 'active'
);

// D4: cleanViolationEventText boilerplate stripping (Guardrail G2)
const cleanedText = cleanViolationEventText(
  '🚨 [Warning with Penalty] Fullscreen exited. Penalty: -5 min deducted. Invigilator PIN required.'
);
check(
  'D4. cleanViolationEventText strips tier tag and PIN instructions cleanly',
  cleanedText === 'Fullscreen exited'
);

// D5: CSS Collision & Overflow Guardrails (Guardrails G1 - G5)
const cssSource = fs.readFileSync('src/pages/StudentQuizRunner.css', 'utf8');
check(
  'D5. Lock screen CSS contains tier variables, gap on rows, and nowrap labels',
  cssSource.includes('.sq-lockdown-card--warning') &&
  cssSource.includes('.sq-lockdown-card--time_penalty') &&
  cssSource.includes('.sq-lockdown-card--final') &&
  cssSource.includes('.sq-lockdown-stepper') &&
  cssSource.includes('--ld-accent') &&
  cssSource.includes('white-space: nowrap;')
);


console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
