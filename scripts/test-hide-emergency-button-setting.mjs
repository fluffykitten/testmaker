// ═══════════════════════════════════════════════════════════════════════════════
// TEST: Hide Emergency Exam Button Admin & Runner Setting
// ═══════════════════════════════════════════════════════════════════════════════

import fs from 'node:fs';

const settingsSource = fs.readFileSync('src/lib/settings.ts', 'utf8');
const adminPageSource = fs.readFileSync('src/pages/AdvancedSettingsPage.tsx', 'utf8');
const quizManagerSource = fs.readFileSync('src/services/quizManagerService.ts', 'utf8');
const quizCodeServiceSource = fs.readFileSync('src/services/quizCodeService.ts', 'utf8');
const quizManagerPageSource = fs.readFileSync('src/pages/QuizManagerPage.tsx', 'utf8');
const runnerSource = fs.readFileSync('src/pages/StudentQuizRunner.tsx', 'utf8');

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

console.log('🧪 Verifying Admin Option to Hide Emergency Exam Button...\n');

// 1. Settings Schema & Cloud Sync
check(
  '1. AppSettings has hideEmergencyExamButton property',
  /hideEmergencyExamButton\?\s*:\s*boolean/.test(settingsSource)
);

check(
  '2. DEFAULT_SETTINGS has hideEmergencyExamButton: false',
  /hideEmergencyExamButton\s*:\s*false/.test(settingsSource)
);

check(
  '3. saveEmergencyExamButtonVisibility is exported',
  /export\s+function\s+saveEmergencyExamButtonVisibility/.test(settingsSource)
);

check(
  '4. loadAndSyncEmergencyExamButtonVisibility is exported',
  /export\s+async\s+function\s+loadAndSyncEmergencyExamButtonVisibility/.test(settingsSource)
);

check(
  '5. Cloud sync writes to key "hide_emergency_exam_button"',
  /key\s*:\s*['"]hide_emergency_exam_button['"]/.test(settingsSource)
);

// 2. Admin Settings Page UI
check(
  '6. AdvancedSettingsPage imports emergency button visibility helpers',
  /saveEmergencyExamButtonVisibility/.test(adminPageSource) &&
  /loadAndSyncEmergencyExamButtonVisibility/.test(adminPageSource)
);

check(
  '7. AdvancedSettingsPage has handleToggleHideEmergencyExamButton handler',
  /const\s+handleToggleHideEmergencyExamButton\s*=/.test(adminPageSource)
);

check(
  '8. AdvancedSettingsPage renders Hide Emergency Save Button setting card',
  /Hide Emergency Save Button/.test(adminPageSource) &&
  /settings\.hideEmergencyExamButton/.test(adminPageSource)
);

// 3. Quiz Manager & Code Service
check(
  '9. PublishedQuiz interface supports hideEmergencyExamButton',
  /hideEmergencyExamButton\?\s*:\s*boolean/.test(quizManagerSource)
);

check(
  '10. PublishedQuiz defaults hideEmergencyExamButton from admin settings',
  /hideEmergencyExamButton:\s*existing\?\.hideEmergencyExamButton\s*\?\?\s*\(getSavedSettings\(\)\.hideEmergencyExamButton\s*\?\?\s*false\)/.test(quizManagerSource)
);

check(
  '11. StudentQuizData supports hideEmergencyExamButton',
  /hideEmergencyExamButton\?\s*:\s*boolean/.test(quizCodeServiceSource)
);

check(
  '12. QuizManagerPage provides toggle for Hide Emergency Save Button',
  /Hide Emergency Save Button/.test(quizManagerPageSource) &&
  /activeQuizDraft\.hideEmergencyExamButton/.test(quizManagerPageSource)
);

// 4. Student Quiz Runner
check(
  '13. StudentQuizRunner initializes hideEmergencyExamButton from settings/savedExam',
  /hideEmergencyExamButton[\s\S]*?getSavedSettings\(\)\.hideEmergencyExamButton/.test(runnerSource)
);

check(
  '14. StudentQuizRunner listens for emergency_exam_button_visibility_updated custom event',
  /emergency_exam_button_visibility_updated/.test(runnerSource)
);

check(
  '15. StudentQuizRunner hides emergency save button when hideEmergencyExamButton is true',
  /\{!hideEmergencyExamButton\s*&&\s*\([\s\S]*?className="sq-btn sq-btn-emergency-exit"/.test(runnerSource)
);

check(
  '16. StudentQuizRunner guards emergency modal with hideEmergencyExamButton',
  /\{!hideEmergencyExamButton\s*&&\s*showEmergencyExitModal\s*&&/.test(runnerSource)
);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}

