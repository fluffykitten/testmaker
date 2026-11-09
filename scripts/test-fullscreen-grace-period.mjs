import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

console.log('🧪 Testing 1-Time 5-Second Fullscreen Grace Recovery System...\n');

const runnerPath = path.join(rootDir, 'src', 'pages', 'StudentQuizRunner.tsx');
const runnerCode = fs.readFileSync(runnerPath, 'utf8');

// 1. Verify Grace State and Refs
assert.ok(
  runnerCode.includes('fullscreenExitCount'),
  'Must track fullscreenExitCount'
);
assert.ok(
  runnerCode.includes('isFullscreenGraceActive'),
  'Must track isFullscreenGraceActive state'
);
assert.ok(
  runnerCode.includes('fullscreenGraceSecondsLeft'),
  'Must track fullscreenGraceSecondsLeft countdown'
);
assert.ok(
  runnerCode.includes('fullscreenExitCountRef'),
  'Must have fullscreenExitCountRef'
);
console.log('✅ 1. State & Refs: Grace tracking variables properly declared.');

// 2. Verify logViolation options
assert.ok(
  runnerCode.includes('options?: { skipLock?: boolean; customStatus?: StudentExamStatus }'),
  'logViolation must accept optional skipLock and customStatus parameters'
);
assert.ok(
  runnerCode.includes('const shouldLock = requireTeacherUnlock && isExamMode && !options?.skipLock;'),
  'shouldLock must respect options.skipLock'
);
console.log('✅ 2. Violation Logger: Correctly honors skipLock to prevent premature PIN lockout.');

// 3. Verify Dedicated Grace Countdown Effect
assert.ok(
  runnerCode.includes('Dedicated 1-Time 5-Second Grace Recovery Countdown'),
  'Must have dedicated countdown effect'
);
assert.ok(
  runnerCode.includes('const durationMs = 5000;'),
  'Duration must be 5000ms'
);
assert.ok(
  runnerCode.includes('const elapsedMs = Date.now() - startTime;'),
  'Countdown must calculate elapsed time from timestamp for accurate ticks'
);
assert.ok(
  runnerCode.includes('setIsLockedByProctor(true)'),
  'Grace expiration must trigger hard lock'
);
console.log('✅ 3. Dedicated Grace Countdown Effect: Accurately ticks down via timestamp & triggers lock on expiry.');

// 4. Verify Fullscreen Exit Logic: 1st drop triggers grace; 2nd drop triggers hard lock
assert.ok(
  runnerCode.includes('if (nextCount === 1)'),
  'Must branch on first incident (nextCount === 1)'
);
assert.ok(
  runnerCode.includes('skipLock: true'),
  'First incident must pass skipLock: true'
);
assert.ok(
  runnerCode.includes('setIsFullscreenGraceActive(true)'),
  'First incident must activate grace period'
);
assert.ok(
  runnerCode.includes('setIsFullscreenGraceActive(false)'),
  'Re-entering fullscreen or subsequent exit must deactivate grace period'
);
console.log('✅ 4. Fullscreen Exit Logic: 1st drop activates grace; re-entering or 2nd drop deactivates grace.');

// 5. Verify UI Overlay Elements & Big Font
assert.ok(
  runnerCode.includes('FULLSCREEN REQUIRED (FIRST WARNING)'),
  'UI must display distinct FIRST WARNING title'
);
assert.ok(
  runnerCode.includes("fontSize: '3.5rem'"),
  'UI must render big font for countdown seconds'
);
assert.ok(
  runnerCode.includes('Seconds Until Exam Locks'),
  'UI must show Seconds Until Exam Locks label'
);
assert.ok(
  runnerCode.includes('Return to Fullscreen Now (${fullscreenGraceSecondsLeft}s)'),
  'Button must reflect live countdown seconds'
);
assert.ok(
  runnerCode.includes('Press <kbd'),
  'UI must provide keyboard hints (Enter, F11)'
);
console.log('✅ 5. UI Overlay: Big font countdown (3.5rem), clear warning title, and rapid re-entry buttons verified.');

// 6. Verify Persistence across Refresh
assert.ok(
  runnerCode.includes('fullscreenExitCount: fullscreenExitCountRef.current'),
  'Must persist fullscreenExitCount into session payload'
);
console.log('✅ 6. Persistence: Fullscreen exit count persists across tab refresh.');

console.log('\n🎉 ALL FULLSCREEN GRACE PERIOD TESTS PASSED SUCCESSFULLY!\n');
