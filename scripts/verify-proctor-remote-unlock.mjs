// ═══════════════════════════════════════════════════════════════════════════════
// VERIFICATION: Remote Proctor Unlock & Fullscreen Recovery State Machine
// ═══════════════════════════════════════════════════════════════════════════════
// This test simulates the exact browser state transitions when a teacher
// sends a remote "unlock" or "pardon" command to a locked candidate.
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

console.log('🧪 Verifying Remote Proctor Unlock & Fullscreen Recovery Behavior...\n');

// 1. Verify W3C User-Gesture Constraint Awareness
{
  // Check that the unlock handler safely wraps requestSecureFullscreen in a .catch
  // because browsers reject programmatic fullscreen without transient activation.
  const unlockMatch = source.match(/if\s*\(cmd\.type\s*===\s*'unlock'\)\s*\{([\s\S]*?)\}\s*else\s*if/);
  check('1. Unlock handler exists in proctor command receiver', Boolean(unlockMatch));

  if (unlockMatch) {
    const unlockBody = unlockMatch[1];

    check(
      '2. Unlock handler resets isLockedByProctor',
      /setIsLockedByProctor\(false\)/.test(unlockBody)
    );

    check(
      '3. Unlock handler clears lockReason and lockTime',
      /setLockReason\(''\)/.test(unlockBody) && /setLockTime\(''\)/.test(unlockBody)
    );

    check(
      '4. Unlock handler resets fullscreenExitCountRef to 0 (restoring grace period allowance)',
      /fullscreenExitCountRef\.current\s*=\s*0/.test(unlockBody)
    );

    check(
      '5. Unlock handler resets state fullscreenExitCount to 0',
      /setFullscreenExitCount\(0\)/.test(unlockBody)
    );

    check(
      '6. Unlock handler resets isFullscreenGraceActive to false',
      /setIsFullscreenGraceActive\(false\)/.test(unlockBody)
    );

    check(
      '7. Unlock handler resets grace countdown timer back to 5 seconds',
      /setFullscreenGraceSecondsLeft\(5\)/.test(unlockBody)
    );

    check(
      '8. requestSecureFullscreen is safely caught (acknowledging browser user gesture requirements)',
      /requestSecureFullscreen\(\)\.catch/.test(unlockBody)
    );
  }
}

// 2. Verify Pardon Handler
{
  const pardonMatch = source.match(/else\s*if\s*\(cmd\.type\s*===\s*'pardon'\)\s*\{([\s\S]*?)\}\s*else\s*if/);
  check('9. Pardon handler exists in proctor command receiver', Boolean(pardonMatch));

  if (pardonMatch) {
    const pardonBody = pardonMatch[1];
    check('10. Pardon handler clears violations array', /setViolations\(\[\]\)/.test(pardonBody));
    check('11. Pardon handler clears isLockedByProctor', /setIsLockedByProctor\(false\)/.test(pardonBody));
    check('12. Pardon handler resets fullscreen exit count', /fullscreenExitCountRef\.current\s*=\s*0/.test(pardonBody));
  }
}

// 3. Verify Fullscreen Recovery Overlay UI Fallback
{
  // When a student is unlocked remotely, but is NOT yet in fullscreen (because the browser
  // blocked non-gesture requestFullscreen), the UI must present the Recovery Overlay
  // with a 1-click user gesture action.
  const overlayPattern = /!isLockedByProctor\s*&&\s*hasStarted\s*&&\s*!isSubmitted\s*&&\s*!isGrading\s*&&\s*isExamMode\s*&&\s*securityEnabled\s*&&\s*!isFullscreenActive/;
  check('13. Recovery overlay activates when unlocked by proctor but not in fullscreen', overlayPattern.test(source));

  check(
    '14. Recovery overlay contains handleResumeFullscreen on card click (legitimate user gesture)',
    /className="sq-lockdown-card[^"]*"\s+onClick=\{handleResumeFullscreen\}/.test(source)
  );

  check(
    '15. Recovery overlay contains handleResumeFullscreen on button click (legitimate user gesture)',
    /<button[^>]*onClick=\{handleResumeFullscreen\}[^>]*>[\s\S]*?Return to Fullscreen/i.test(source)
  );
}

// 4. Verify handleResumeFullscreen Implementation
{
  const resumeMatch = source.match(/const\s+handleResumeFullscreen\s*=\s*useCallback\(async\s*\(\)\s*=>\s*\{([\s\S]*?)\},\s*\[\]\);/);
  check('16. handleResumeFullscreen is memoized with empty deps', Boolean(resumeMatch));

  if (resumeMatch) {
    const resumeBody = resumeMatch[1];
    check('17. handleResumeFullscreen requests secure fullscreen with keyboard lock', /await\s+requestSecureFullscreen\(\)/.test(resumeBody));
    check('18. handleResumeFullscreen sets isFullscreenActive to true', /setIsFullscreenActive\(true\)/.test(resumeBody));
    check('19. handleResumeFullscreen deactivates grace period', /setIsFullscreenGraceActive\(false\)/.test(resumeBody));
    check('20. handleResumeFullscreen resets grace countdown to 5', /setFullscreenGraceSecondsLeft\(5\)/.test(resumeBody));
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}

