// Regression guard for exam-mode Esc/F11 blocking.
//
//   node scripts/verify-exam-key-lock.mjs
//
// The bug: the security effect depended on `logViolation`, whose identity changed on every
// countdown tick, so the effect re-subscribed every second and its cleanup released the
// Keyboard Lock — leaving Esc/F11 unblocked ~1s into the exam. These assertions are
// structural because the lock lifecycle needs a real browser to exercise.
import fs from 'node:fs';

const file = 'src/pages/StudentQuizRunner.tsx';
const source = fs.readFileSync(file, 'utf8');

const problems = [];
const check = (condition, message) => { if (!condition) problems.push(message); };

const effectStart = source.indexOf('// ─── 3. Anti-Cheating & Clipboard Event Listeners');
check(effectStart >= 0, 'security effect marker not found');

// The effect's dependency array is the one immediately before the multi-monitor section.
const depsMatch = source.slice(effectStart).match(/\}, \[([^\]]*)\]\);\s*\r?\n\s*\/\/ ─── 3B\./);
check(Boolean(depsMatch), 'could not locate the security effect dependency array');

if (depsMatch) {
  const deps = depsMatch[1].split(',').map((d) => d.trim()).filter(Boolean);
  check(!deps.includes('logViolation'), `security effect depends on logViolation — it will re-subscribe on every timer tick (deps: ${deps.join(', ')})`);
  check(deps.includes('securityEnabled'), 'security effect lost its securityEnabled dependency');
  check(deps.every((d) => ['hasStarted', 'isSubmitted', 'isGrading', 'securityEnabled', 'isExamMode'].includes(d)), `unexpected volatile dependency in security effect: ${deps.join(', ')}`);
}

const bodyEnd = source.indexOf('// ─── 3B.', effectStart);
const body = source.slice(effectStart, bodyEnd);

check(/logViolationRef\.current\(type, detail\)/.test(body), 'violations are not routed through logViolationRef inside the effect');
check(/assertKeyboardLock/.test(body) && /enableKeyboardLock\(\['Escape', 'F11'\]\)/.test(body), 'effect no longer re-asserts the keyboard lock on subscribe');
check(/isEscapeOrF11\(e\)/.test(body), 'Escape/F11 handler missing');
check(/Attempted to leave the exam view/.test(body), 'Esc/F11 attempts are not recorded as a violation');
check(/lastBlockedExitAtRef/.test(body), 'Esc/F11 violation logging is not throttled');
check(/releaseKeyboardLock\(\)/.test(body), 'cleanup no longer releases the keyboard lock');

// The notice that tells the candidate/invigilator the browser cannot block the keys.
check(/keyboardLockAvailable === false/.test(source), 'browser-capability notice missing from the exam UI');
check(/setKeyboardLockAvailable/.test(body), 'effect never records keyboard-lock availability');

if (problems.length) {
  console.log(`FAIL ${file}`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exit(1);
}
console.log(`PASS ${file}`);
console.log('  · security effect deps stable (no logViolation / countdown state)');
console.log('  · lock re-asserted on subscribe, released only on teardown');
console.log('  · Esc/F11 attempts recorded, throttled, and capability surfaced');
