import assert from 'node:assert/strict';
import {
  TEACHER_DUMMY_STUDENT_NAME,
  TEACHER_DUMMY_STUDENT_PIN,
  TEACHER_DUMMY_CANDIDATE_NUMBER,
  isTeacherDummyStudentName,
  withTeacherDummyRosterEntries,
  verifyStudentPin,
} from '../src/services/studentRosterService.ts';
import { filterRosterByTargetClasses } from '../src/lib/examTargetClasses.ts';

let passed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    process.exit(1);
  }
}

const schoolClasses = [
  'X IPA 1', 'X IPA 2', 'X IPA 3', 'X IPS 1', 'X IPS 2',
  'XI IPA 1', 'XI IPA 2', 'XI IPS 1', 'XI IPS 2',
  'XII IPA 1', 'XII IPA 2', 'XII IPS 1', 'XII IPS 2', 'PSB',
];

const realRoster = [
  { id: 'stu-1', name: 'Aisyah Putri', class: 'X IPA 1', candidateNumber: '101' },
  { id: 'stu-2', name: 'Budi Santoso', class: 'XII IPS 2', candidateNumber: '205' },
];

// 1. Dummy account appears in EVERY school class without modifying real entries
const enrichedAll = withTeacherDummyRosterEntries(realRoster, schoolClasses);
const dummyEntries = enrichedAll.filter((s) => isTeacherDummyStudentName(s.name));
check(
  'TD-1: Dummy account appears in every configured class (14 classes)',
  dummyEntries.length === schoolClasses.length &&
    schoolClasses.every((c) => dummyEntries.some((d) => d.class === c && d.candidateNumber === TEACHER_DUMMY_CANDIDATE_NUMBER)),
  `count=${dummyEntries.length}`
);

// 2. Real roster stays untouched in base array
check(
  'TD-2: Real roster array is not mutated and real entries remain intact',
  realRoster.length === 2 && enrichedAll.length === 2 + schoolClasses.length
);

// 3. Target-class filtering keeps Dummy account available for restricted exams (e.g. only XII IPS 2 + PSB)
const targeted = withTeacherDummyRosterEntries(
  filterRosterByTargetClasses(realRoster, 'XII IPS 2, PSB'),
  ['XII IPS 2', 'PSB']
);
check(
  'TD-3: Target-class filtering preserves Teacher Test Account in targeted classes',
  targeted.some((s) => s.name === TEACHER_DUMMY_STUDENT_NAME && s.class === 'XII IPS 2') &&
    targeted.some((s) => s.name === TEACHER_DUMMY_STUDENT_NAME && s.class === 'PSB') &&
    !targeted.some((s) => s.class === 'X IPA 1')
);

// 4. Offline verifyStudentPin fallback accepts 0000 across any class and rejects non-0000
const validRes = await verifyStudentPin(TEACHER_DUMMY_STUDENT_NAME, 'PSB', TEACHER_DUMMY_STUDENT_PIN);
const wrongRes = await verifyStudentPin('Dummy Student', 'XI IPA 2', '1234');
check(
  'TD-4: verifyStudentPin offline fallback accepts PIN 0000 across any class & rejects wrong PINs',
  validRes.valid === true &&
    validRes.student?.candidateNumber === TEACHER_DUMMY_CANDIDATE_NUMBER &&
    validRes.student?.class === 'PSB' &&
    wrongRes.valid === false
);

console.log(`\n🎉 All ${passed} Teacher Dummy Student tests passed!`);
