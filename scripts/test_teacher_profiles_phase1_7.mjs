import assert from 'assert';
import { DEFAULT_SUBJECTS, getSchoolSubjects, saveSchoolSubjects } from '../src/lib/settings.js';
import {
  createTeacherProfile,
  fetchTeacherProfiles,
  getActiveTeacherProfileId,
  setActiveTeacherProfileId,
} from '../src/services/teacherProfileService.js';

if (typeof document === 'undefined') {
  global.document = {
    documentElement: {
      classList: {
        toggle: () => {},
        add: () => {},
        remove: () => {},
      },
      style: {
        setProperty: () => {},
      },
      setAttribute: () => {},
      getAttribute: () => null,
    },
  };
}
if (typeof localStorage === 'undefined') {
  const store = new Map();
  global.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

if (typeof window === 'undefined') {
  global.window = {
    dispatchEvent: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

if (typeof CustomEvent === 'undefined') {
  global.CustomEvent = class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
}

async function runTests() {
  console.log('🧪 Starting Phase 1.7 Verification Tests...\n');

  // Test 1: Verify DEFAULT_SUBJECTS has all requested subjects
  console.log('Test 1: Verify Primary Subjects');
  const requiredSubjects = ['Sociology', 'PAI', 'Arabic', 'Bahasa Indonesia'];
  for (const subj of requiredSubjects) {
    assert(
      DEFAULT_SUBJECTS.includes(subj),
      `DEFAULT_SUBJECTS must include ${subj}`
    );
  }
  console.log('✓ All requested subjects (Sociology, PAI, Arabic, Bahasa Indonesia) are present in DEFAULT_SUBJECTS.');

  // Test 2: Admin can add new custom subjects dynamically
  console.log('\nTest 2: Admin Add Custom Subject');
  const initialSubjects = getSchoolSubjects();
  assert(Array.isArray(initialSubjects), 'getSchoolSubjects should return an array');
  const customSubj = 'Astronomy & Astrophysics';
  const updatedSubjects = [...initialSubjects, customSubj];
  saveSchoolSubjects(updatedSubjects);

  const reloadedSubjects = getSchoolSubjects();
  assert(reloadedSubjects.includes(customSubj), 'Custom subject must be saved');
  console.log('✓ Custom subject dynamically added and retrieved via getSchoolSubjects().');

  // Test 3: Profile creation with Grade 10, 11, 12 multi-select cohorts
  console.log('\nTest 3: Profile Creation with Cohort Multi-Select');
  const gradeCohorts = ['Grade 10', 'Grade 12'];
  const profileWithGrades = await createTeacherProfile({
    name: 'Ustadz Ahmad',
    title: 'Ustadz',
    subject: 'Arabic',
    subject_code: '', // Optional syllabus code left blank
    default_classes: gradeCohorts,
  });

  assert.strictEqual(profileWithGrades.name, 'Ustadz Ahmad');
  assert.strictEqual(profileWithGrades.subject, 'Arabic');
  assert.strictEqual(profileWithGrades.subject_code, '');
  assert.deepStrictEqual(profileWithGrades.default_classes, ['Grade 10', 'Grade 12']);
  console.log('✓ Profile created successfully with optional blank syllabus code and Grade 10 & 12 multi-select.');

  // Test 4: First-time opening profile detection
  console.log('\nTest 4: First-Time Onboarding Flag');
  setActiveTeacherProfileId(null);
  assert.strictEqual(getActiveTeacherProfileId(), null);
  console.log('✓ When active teacher ID is null in storage, system requires onboarding prompt.');

  console.log('\n🎉 ALL PHASE 1.7 TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
