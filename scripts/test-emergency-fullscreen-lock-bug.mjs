// ═══════════════════════════════════════════════════════════════════════════════
// TEST: Emergency Save & Exit vs Fullscreen/Window Blur Security Guards
// ═══════════════════════════════════════════════════════════════════════════════
// Verifies whether clicking "Emergency Save & Exit" causes document.exitFullscreen()
// or file download window blur to trigger false cheating violations and exam locks.
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';

const source = fs.readFileSync('src/pages/StudentQuizRunner.tsx', 'utf8');

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

console.log('🧪 Verifying Emergency Save vs Security Guard Race Conditions...\n');

// 1. Locate handleEmergencySaveAndExit
const emergencyMatch = source.match(/const\s+handleEmergencySaveAndExit\s*=\s*useCallback\(async\s*\(\)\s*=>\s*\{([\s\S]*?)\},\s*\[/);
check('1. handleEmergencySaveAndExit exists', Boolean(emergencyMatch));

if (emergencyMatch) {
  const body = emergencyMatch[1];

  // Flaw A: Does handleEmergencySaveAndExit reset isSubmittingRef.current to false in finally?
  const hasUnsafeFinally = /finally\s*\{[\s\S]*?isSubmittingRef\.current\s*=\s*false[\s\S]*?\}/.test(body);
  check(
    '2. isSubmittingRef.current must NOT be unconditionally reset to false if submission succeeded',
    !hasUnsafeFinally || /if\s*\(!isSubmittedRef\.current\)/.test(body)
  );

  // Flaw B: Is there a synchronous isSubmittedRef to guard event listeners against React state batching lag?
  check(
    '3. isSubmittedRef is set to true immediately upon emergency save',
    /isSubmittedRef\.current\s*=\s*true/.test(body)
  );

  // Flaw C: Is isLockedByProctor cleared when emergency saving?
  check(
    '4. isLockedByProctor is cleared upon emergency save',
    /setIsLockedByProctor\(false\)/.test(body)
  );
}

// 2. Check security event handlers for isSubmittedRef protection
{
  const securityEffectStart = source.indexOf('// ─── 3. Anti-Cheating & Clipboard Event Listeners');
  const securityEffectEnd = source.indexOf('// ─── 3B.', securityEffectStart);
  const securityBody = source.slice(securityEffectStart, securityEffectEnd);

  check(
    '5. handleFullscreenChange guards with isSubmittedRef.current',
    /isSubmittedRef\.current/.test(securityBody)
  );

  check(
    '6. handleWindowBlur guards with isSubmittedRef.current',
    /handleWindowBlur[\s\S]*?isSubmittedRef\.current/.test(securityBody)
  );

  check(
    '7. handleVisibilityChange guards with isSubmittedRef.current',
    /handleVisibilityChange[\s\S]*?isSubmittedRef\.current/.test(securityBody)
  );
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}

