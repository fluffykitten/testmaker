import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  EXAM_FALLBACK_LOCKED_KEYS,
  EXAM_LOCKED_KEYS,
  enableKeyboardLock,
  isCopyShortcut,
  isWindowsOrCopilotKey,
  requestSecureFullscreen,
} from '../src/utils/examSecurityUtils.ts';

function runUnitTests() {
  // 1. Copy shortcut classification (silent block, no DevTools collision)
  assert.equal(isCopyShortcut({ key: 'c', code: 'KeyC', ctrlKey: true }), true, 'Ctrl+C must match copy shortcut');
  assert.equal(isCopyShortcut({ key: 'C', code: 'KeyC', ctrlKey: true }), true, 'Ctrl+C with uppercase key must match');
  assert.equal(isCopyShortcut({ key: 'c', code: 'KeyC', metaKey: true }), true, 'Cmd+C must match copy shortcut');
  assert.equal(isCopyShortcut({ key: 'Insert', code: 'Insert', ctrlKey: true }), true, 'Ctrl+Insert must match copy shortcut');
  assert.equal(isCopyShortcut({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }), false, 'Ctrl+Shift+C (DevTools Inspector) must NOT be treated as copy');
  assert.equal(isCopyShortcut({ key: 'c', code: 'KeyC', ctrlKey: true, altKey: true }), false, 'Ctrl+Alt+C must not match copy');
  assert.equal(isCopyShortcut({ key: 'v', code: 'KeyV', ctrlKey: true }), false, 'Ctrl+V (paste) must not match copy');
  assert.equal(isCopyShortcut({ key: 'c', code: 'KeyC' }), false, 'Plain letter c must not match copy');

  // 2. Windows & Copilot key classification
  assert.equal(isWindowsOrCopilotKey({ key: 'Meta', code: 'MetaLeft', metaKey: true }), true, 'Left Windows key must match');
  assert.equal(isWindowsOrCopilotKey({ key: 'Meta', code: 'MetaRight', metaKey: true }), true, 'Right Windows key must match');
  assert.equal(isWindowsOrCopilotKey({ key: 'OS', code: 'OSLeft' }), true, 'Legacy OSLeft key must match');
  assert.equal(isWindowsOrCopilotKey({ key: 'F23', code: 'F23', shiftKey: true, metaKey: true }), true, 'Windows 11 Copilot chord (Shift+Meta+F23) must match');
  assert.equal(isWindowsOrCopilotKey({ key: 'F23', code: 'F23' }), true, 'Standalone F23 Copilot key must match');
  assert.equal(isWindowsOrCopilotKey({ key: 'LaunchAssistant', code: 'LaunchAssistant' }), true, 'LaunchAssistant key must match');
  assert.equal(isWindowsOrCopilotKey({ key: 'c', code: 'KeyC', metaKey: true }), true, 'Win+C shortcut must match');
  assert.equal(isWindowsOrCopilotKey({ key: 'Shift', code: 'ShiftLeft', shiftKey: true }), false, 'Plain Shift key must not match Windows/Copilot guard');
  assert.equal(isWindowsOrCopilotKey({ key: 'v', code: 'KeyV', metaKey: true }), false, 'Cmd+V on macOS must not be treated as Windows/Copilot key');
  assert.equal(isWindowsOrCopilotKey({ key: 'c', code: 'KeyC', ctrlKey: true }), false, 'Ctrl+C is handled as copy, not Windows/Copilot');

  console.log('✓ Copy and Windows/Copilot key classification checks passed');
}

async function runKeyboardLockTests() {
  assert.deepEqual(EXAM_FALLBACK_LOCKED_KEYS, ['Escape', 'F11']);
  assert.deepEqual(EXAM_LOCKED_KEYS, ['Escape', 'F11', 'MetaLeft', 'MetaRight', 'F23']);

  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const origDocDesc = Object.getOwnPropertyDescriptor(globalThis, 'document');

  try {
    // 3a. Primary lock locks all extended keys when supported
    const calls1 = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        keyboard: {
          lock: async (keys) => {
            calls1.push([...keys]);
          },
        },
      },
    });
    const okPrimary = await enableKeyboardLock();
    assert.equal(okPrimary, true);
    assert.deepEqual(calls1, [['Escape', 'F11', 'MetaLeft', 'MetaRight', 'F23']]);

    // 3b. Fallback lock retries ['Escape', 'F11'] if extended keys throw on an unsupported browser/OS
    const calls2 = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        keyboard: {
          lock: async (keys) => {
            calls2.push([...keys]);
            if (keys.includes('MetaLeft') || keys.includes('F23')) {
              throw new DOMException('Unsupported key code', 'InvalidAccessError');
            }
          },
        },
      },
    });
    const okFallback = await enableKeyboardLock(EXAM_LOCKED_KEYS);
    assert.equal(okFallback, true);
    assert.deepEqual(calls2, [
      ['Escape', 'F11', 'MetaLeft', 'MetaRight', 'F23'],
      ['Escape', 'F11'],
    ]);

    // 3c. requestSecureFullscreen locks EXAM_LOCKED_KEYS once fullscreenElement is active
    const calls3 = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        keyboard: {
          lock: async (keys) => {
            calls3.push([...keys]);
          },
        },
      },
    });
    const fakeEl = {
      requestFullscreen: async () => {
        docObj.fullscreenElement = fakeEl;
      },
    };
    const docObj = {
      fullscreenElement: null,
      documentElement: fakeEl,
    };
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: docObj,
    });
    const fsOk = await requestSecureFullscreen();
    assert.equal(fsOk, true);
    assert.deepEqual(calls3, [['Escape', 'F11', 'MetaLeft', 'MetaRight', 'F23']]);
  } finally {
    if (origNavDesc) Object.defineProperty(globalThis, 'navigator', origNavDesc);
    else delete globalThis.navigator;
    if (origDocDesc) Object.defineProperty(globalThis, 'document', origDocDesc);
    else delete globalThis.document;
  }

  console.log('✓ Keyboard Lock & fallback behavior checks passed');
}

function runRunnerRegressionChecks() {
  const runnerPath = path.resolve(process.cwd(), 'src/pages/StudentQuizRunner.tsx');
  const src = fs.readFileSync(runnerPath, 'utf8');

  // Assert silent Ctrl+C / Copy handling does NOT recordViolation or open lock screen
  const keyDownCopyMatch = src.match(/if\s*\(\s*isExamMode\s*&&\s*isCopyShortcut\(e\)\s*\)\s*\{([\s\S]*?)\}/);
  assert.ok(keyDownCopyMatch, 'isCopyShortcut(e) block missing in StudentQuizRunner.tsx');
  assert.ok(/e\.preventDefault\(\)/.test(keyDownCopyMatch[1]), 'Ctrl+C handler must call preventDefault()');
  assert.ok(/e\.stopPropagation\(\)/.test(keyDownCopyMatch[1]), 'Ctrl+C handler must call stopPropagation()');
  assert.ok(!/recordViolation/.test(keyDownCopyMatch[1]), 'Ctrl+C handler must NOT call recordViolation()');

  const handleCopyMatch = src.match(/const\s+handleCopy\s*=\s*\(e:\s*ClipboardEvent\)\s*=>\s*\{([\s\S]*?)\n\s{4}\};/);
  assert.ok(handleCopyMatch, 'handleCopy interceptor missing in StudentQuizRunner.tsx');
  assert.ok(/e\.preventDefault\(\)/.test(handleCopyMatch[1]), 'handleCopy must call preventDefault()');
  assert.ok(/flushClipboard\(\)/.test(handleCopyMatch[1]), 'handleCopy must clear clipboard');
  assert.ok(!/recordViolation/.test(handleCopyMatch[1]), 'handleCopy must NOT call recordViolation()');

  // Assert silent Windows/Copilot handling does NOT recordViolation
  const winCopilotMatch = src.match(/if\s*\(\s*isExamMode\s*&&\s*isWindowsOrCopilotKey\(e\)\s*\)\s*\{([\s\S]*?)\}/);
  assert.ok(winCopilotMatch, 'isWindowsOrCopilotKey(e) block missing in StudentQuizRunner.tsx');
  assert.ok(/e\.preventDefault\(\)/.test(winCopilotMatch[1]), 'Windows/Copilot handler must call preventDefault()');
  assert.ok(/e\.stopPropagation\(\)/.test(winCopilotMatch[1]), 'Windows/Copilot handler must call stopPropagation()');
  assert.ok(!/recordViolation/.test(winCopilotMatch[1]), 'Windows/Copilot handler must NOT call recordViolation()');

  // Assert capture-phase registration for copy event on both window and document
  assert.ok(
    src.includes("window.addEventListener('copy', handleCopy, { capture: true })") &&
      src.includes("document.addEventListener('copy', handleCopy, { capture: true })") &&
      src.includes("window.removeEventListener('copy', handleCopy, { capture: true })") &&
      src.includes("document.removeEventListener('copy', handleCopy, { capture: true })"),
    'copy listener must be registered & cleaned up in capture phase on both window and document'
  );

  // Assert DevTools Inspector Ctrl+Shift+C still stays protected
  assert.ok(
    /Ctrl\+Shift\+I[\s\S]*recordViolation\('blocked_shortcut'/.test(src),
    'Ctrl+Shift+I / J / C DevTools guard must remain active'
  );

  console.log('✓ StudentQuizRunner structural regression checks passed');
}

runUnitTests();
await runKeyboardLockTests();
runRunnerRegressionChecks();
console.log('\nALL EXAM KEYBOARD CONTROL TESTS PASSED');

