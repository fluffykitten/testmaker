import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  filterRosterByTargetClasses,
  parseTargetClassList,
  resolveAvailableExamClasses,
  resolveProctorSidebarClasses,
  serializeTargetClassList,
  toggleTargetClassSelection,
} from '../src/lib/examTargetClasses.ts';

function run() {
  const schoolClasses = ['10-A', '10-B', '11-A', 'X IPA 1', 'X IPS 2'];
  const roster = [
    { id: '1', name: 'Alice', class: '10-A' },
    { id: '2', name: 'Bob', class: '10-B' },
    { id: '3', name: 'Citra', class: '11-A' },
    { id: '4', name: 'Dina', class: 'X IPA 1' },
    { id: '5', name: 'Eko', class: 'X IPS 2' },
  ];

  // 1. Parse / serialize / toggle helpers
  assert.deepEqual(parseTargetClassList(''), []);
  assert.deepEqual(parseTargetClassList('ALL'), []);
  assert.deepEqual(parseTargetClassList('10-A, 10-b, 10-A, X IPA1'), ['10-A', '10-b', 'X IPA 1']);
  assert.equal(serializeTargetClassList(['10-A', ' 10-B ', '10-a']), '10-A, 10-B');
  assert.equal(toggleTargetClassSelection('', '10-A'), '10-A');
  assert.equal(toggleTargetClassSelection('10-A, 10-B', '10-a'), '10-B');
  assert.equal(toggleTargetClassSelection('10-A', '11-A'), '10-A, 11-A');
  console.log('PASS  Target class parsing, serialization & pill toggling work cleanly');

  // 2. Empty targetClass -> all school classes & full roster appear
  assert.deepEqual(resolveAvailableExamClasses(schoolClasses, ''), schoolClasses);
  assert.equal(filterRosterByTargetClasses(roster, '').length, 5);
  console.log('PASS  Empty targetClass shows all default school classes and full candidate roster');

  // 3. Specific target classes filter both dropdown options and candidate names (with spacing normalization)
  const filteredClasses = resolveAvailableExamClasses(schoolClasses, 'X IPA1, 10-B, Olympians');
  assert.deepEqual(filteredClasses, ['10-B', 'X IPA 1', 'Olympians']);
  const filteredRoster = filterRosterByTargetClasses(roster, 'X IPA1, 10-B');
  assert.deepEqual(
    filteredRoster.map((r) => r.name),
    ['Bob', 'Dina']
  );
  console.log('PASS  Selected target classes filter dropdown options & CandidateNameAutocomplete roster');

  // 4. Live Proctor sidebar scoping in Focus vs All mode (+ live custom-typed student classes)
  const focusSidebar = resolveProctorSidebarClasses({
    schoolClasses,
    monitoredTargetClasses: ['10-A, X IPA1'],
    liveStudentClasses: ['10-D'],
    scope: 'focus',
  });
  assert.deepEqual(focusSidebar, ['10-A', '10-D', 'X IPA 1']);

  const allSidebar = resolveProctorSidebarClasses({
    schoolClasses,
    monitoredTargetClasses: ['10-A'],
    liveStudentClasses: ['Unassigned'],
    scope: 'all',
  });
  assert.deepEqual(allSidebar, ['10-A', '10-B', '11-A', 'X IPA 1', 'X IPS 2', 'Unassigned']);
  console.log('PASS  Live Proctor sidebar scopes to target classes in focus mode & includes live custom classes');

  // 5. Source wiring checks across QuizManagerPage, StudentQuizRunner & LiveInvigilatorModal
  const qmSrc = fs.readFileSync('src/pages/QuizManagerPage.tsx', 'utf8');
  assert.match(qmSrc, /toggleTargetClassSelection\(/);
  assert.match(qmSrc, /All Classes \(Default\)/);

  const runnerSrc = fs.readFileSync('src/pages/StudentQuizRunner.tsx', 'utf8');
  assert.match(runnerSrc, /roster=\{selectableRoster\}/);
  assert.match(runnerSrc, /selectableExamClasses\.map/);
  assert.match(runnerSrc, /value="__custom__"/);

  const proctorSrc = fs.readFileSync('src/components/LiveInvigilatorModal.tsx', 'utf8');
  assert.match(proctorSrc, /resolveProctorSidebarClasses\(/);
  assert.match(proctorSrc, /loadAndSyncSchoolClasses\(/);
  console.log('PASS  UI wiring verified across QuizManagerPage, StudentQuizRunner & LiveInvigilatorModal');
}

run();
