import assert from 'node:assert/strict';
import fs from 'node:fs';
import JSZip from 'jszip';
import { collectMediaUrls, planIncrementalMediaNames } from '../src/services/backupService.ts';
import {
  inspectBackupArchive,
  rewritePublishedQuizzesMediaUrls,
  rewriteQuestionMediaUrls,
  syncRestoredAppConfigToLocalStorage,
} from '../src/services/restoreService.ts';

async function run() {
  // 1. collectMediaUrls gathers images, audio, QP/insert PDFs, insert_resources, sub-questions, and published_quizzes caches
  const sampleQuestions = [
    {
      id: '11111111-1111-1111-1111-111111111111',
      diagram_url: 'https://old.supabase.co/storage/v1/object/public/exam-diagrams/diagrams/q1.png',
      audio_url: 'https://old.supabase.co/storage/v1/object/public/exam-diagrams/audio/track1.mp3',
      source_pdf_url: 'https://old.supabase.co/storage/v1/object/public/exam-diagrams/papers/0620_qp.pdf',
      insert_resources: [
        { id: 'r1', label: 'Map A', url: 'https://old.supabase.co/storage/v1/object/public/exam-diagrams/diagrams/mapA.webp' },
      ],
      mark_scheme: {
        _insert_pdf_url: 'https://old.supabase.co/storage/v1/object/public/exam-diagrams/papers/0620_insert.pdf',
        _insert_resources: [
          { id: 'r2', label: 'Table B', url: 'https://old.supabase.co/storage/v1/object/public/exam-diagrams/diagrams/tableB.png' },
        ],
      },
      sub_questions: [
        {
          sub_id: 'a',
          diagram_url: 'https://old.supabase.co/storage/v1/object/public/exam-diagrams/folderB/q1.png',
          audio_url: 'data:audio/mp3;base64,AAA',
        },
      ],
    },
  ];

  const appConfig = [
    {
      key: 'published_quizzes',
      value: JSON.stringify([
        {
          id: 'pub-1',
          questions: [
            {
              id: 'cached-q1',
              diagram_url: 'https://old.supabase.co/storage/v1/object/public/exam-diagrams/diagrams/cached.png',
            },
          ],
        },
      ]),
    },
  ];

  const collected = collectMediaUrls(sampleQuestions, appConfig);
  assert.equal(collected.size, 8, `Expected 8 unique http(s) URLs, got ${collected.size}`);
  assert.ok(!collected.has('data:audio/mp3;base64,AAA'), 'Data URIs must be skipped');
  console.log('PASS  collectMediaUrls captures diagrams, audio, PDFs, resources, sub-questions & published quiz snapshots');

  // 2. rewriteQuestionMediaUrls & rewritePublishedQuizzesMediaUrls handle collision-safe mapping
  const diagramMapping = {
    'https://old.supabase.co/storage/v1/object/public/exam-diagrams/diagrams/q1.png': 'q1.png',
    'https://old.supabase.co/storage/v1/object/public/exam-diagrams/folderB/q1.png': 'q1_2.png',
    'https://old.supabase.co/storage/v1/object/public/exam-diagrams/audio/track1.mp3': 'track1.mp3',
    'https://old.supabase.co/storage/v1/object/public/exam-diagrams/papers/0620_qp.pdf': '0620_qp.pdf',
    'https://old.supabase.co/storage/v1/object/public/exam-diagrams/papers/0620_insert.pdf': '0620_insert.pdf',
    'https://old.supabase.co/storage/v1/object/public/exam-diagrams/diagrams/mapA.webp': 'mapA.webp',
    'https://old.supabase.co/storage/v1/object/public/exam-diagrams/diagrams/tableB.png': 'tableB.png',
    'https://old.supabase.co/storage/v1/object/public/exam-diagrams/diagrams/cached.png': 'cached.png',
  };

  const newUrlMap = new Map([
    ['q1.png', 'https://new.supabase.co/storage/v1/object/public/exam-diagrams/diagrams/q1.png'],
    ['q1_2.png', 'https://new.supabase.co/storage/v1/object/public/exam-diagrams/diagrams/q1_2.png'],
    ['track1.mp3', 'https://new.supabase.co/storage/v1/object/public/exam-diagrams/audio/track1.mp3'],
    ['0620_qp.pdf', 'https://new.supabase.co/storage/v1/object/public/exam-diagrams/papers/0620_qp.pdf'],
    ['0620_insert.pdf', 'https://new.supabase.co/storage/v1/object/public/exam-diagrams/papers/0620_insert.pdf'],
    ['mapA.webp', 'https://new.supabase.co/storage/v1/object/public/exam-diagrams/diagrams/mapA.webp'],
    ['tableB.png', 'https://new.supabase.co/storage/v1/object/public/exam-diagrams/diagrams/tableB.png'],
    ['cached.png', 'https://new.supabase.co/storage/v1/object/public/exam-diagrams/diagrams/cached.png'],
  ]);

  const rewrittenQ = rewriteQuestionMediaUrls(sampleQuestions[0], newUrlMap, diagramMapping);
  assert.equal(rewrittenQ.diagram_url, newUrlMap.get('q1.png'));
  assert.equal(rewrittenQ.sub_questions[0].diagram_url, newUrlMap.get('q1_2.png'));
  assert.equal(rewrittenQ.audio_url, newUrlMap.get('track1.mp3'));
  assert.equal(rewrittenQ.source_pdf_url, newUrlMap.get('0620_qp.pdf'));
  assert.equal(rewrittenQ.mark_scheme._insert_pdf_url, newUrlMap.get('0620_insert.pdf'));
  assert.equal(rewrittenQ.insert_resources[0].url, newUrlMap.get('mapA.webp'));
  assert.equal(rewrittenQ.mark_scheme._insert_resources[0].url, newUrlMap.get('tableB.png'));

  const rewrittenPubJson = rewritePublishedQuizzesMediaUrls(appConfig[0].value, newUrlMap, diagramMapping);
  const rewrittenPub = JSON.parse(rewrittenPubJson);
  assert.equal(rewrittenPub[0].questions[0].diagram_url, newUrlMap.get('cached.png'));
  console.log('PASS  Cross-project URL rewriting preserves collision mapping across questions & published_quizzes');

  // 3. inspectBackupArchive reads v1.1 tables & warnings accurately
  const zip = new JSZip();
  zip.file(
    'manifest.json',
    JSON.stringify({
      version: '1.1',
      generator: 'Test',
      timestamp: Date.now(),
      createdAt: new Date().toISOString(),
      warnings: ['1 media asset(s) could not be downloaded: missing.png (HTTP 404)'],
      stats: {
        syllabusesCount: 1,
        questionsCount: 1,
        customTestsCount: 1,
        quizSubmissionsCount: 1,
        appConfigCount: 1,
        teacherProfilesCount: 2,
        proctorAuditEventsCount: 3,
        gameProfilesCount: 4,
        diagramsCount: 1,
      },
    })
  );
  zip.folder('data').file('questions.json', JSON.stringify(sampleQuestions));
  zip.folder('data').file('syllabuses.json', JSON.stringify([{ id: 's1' }]));
  zip.folder('data').file('custom_tests.json', JSON.stringify([{ id: 't1' }]));
  zip.folder('data').file('quiz_submissions.json', JSON.stringify([{ id: 'sub1' }]));
  zip.folder('data').file('app_config.json', JSON.stringify(appConfig));
  zip.folder('data').file('teacher_profiles.json', JSON.stringify([{ id: 'tp1' }, { id: 'tp2' }]));
  zip.folder('data').file('proctor_audit_events.json', JSON.stringify([{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]));
  zip.folder('data').file('game_profiles.json', JSON.stringify([{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }, { id: 'g4' }]));
  zip.folder('diagrams').file('q1.png', new Uint8Array([1, 2, 3]));

  const zipBuf = await zip.generateAsync({ type: 'arraybuffer' });
  const insp = await inspectBackupArchive(zipBuf);
  assert.equal(insp.isValid, true);
  assert.equal(insp.teacherProfilesCount, 2);
  assert.equal(insp.proctorAuditEventsCount, 3);
  assert.equal(insp.gameProfilesCount, 4);
  assert.equal(insp.diagramsCount, 1);
  assert.equal(insp.warnings?.length, 1);
  console.log('PASS  inspectBackupArchive inspects extended v1.1 tables & warnings cleanly');

  // 4. syncRestoredAppConfigToLocalStorage populates all school & settings caches
  const store = new Map();
  const dispatched = [];
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.window = {
    dispatchEvent: (ev) => dispatched.push(ev.type),
    matchMedia: () => ({ matches: false }),
  };
  globalThis.document = {
    documentElement: {
      classList: { add: () => {}, remove: () => {} },
      setAttribute: () => {},
      style: { setProperty: () => {} },
    },
  };
  globalThis.Event = class Event {
    constructor(type) {
      this.type = type;
    }
  };
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  };

  syncRestoredAppConfigToLocalStorage([
    { key: 'published_quizzes', value: '[{"id":"q"}]' },
    { key: 'school_roster', value: '[{"id":"stu1","name":"Ali","class":"10-A","pin":"1234"}]' },
    { key: 'exam_schedule_entries', value: '[{"id":"ex1","subject":"Chemistry"}]' },
    { key: 'school_classes', value: '["10-A","10-B"]' },
    { key: 'school_subjects', value: '["Chemistry","Physics"]' },
    { key: 'hide_creative_mode_landing', value: 'true' },
    { key: 'allow_teacher_account_claiming', value: 'false' },
    { key: 'gemini_extraction_model', value: 'gemini-3.8-flash' },
  ]);

  assert.equal(store.get('fluffykitten_published_quizzes'), '[{"id":"q"}]');
  assert.ok(store.get('testmaker_school_student_roster')?.includes('Ali'));
  assert.ok(store.get('testmaker_school_exam_schedule')?.includes('Chemistry'));
  const savedSettings = JSON.parse(store.get('testmaker_user_settings') || '{}');
  assert.deepEqual(savedSettings.classes, ['10-A', '10-B']);
  assert.deepEqual(savedSettings.subjects, ['Chemistry', 'Physics']);
  assert.equal(savedSettings.hideCreativeModeOnLanding, true);
  assert.equal(savedSettings.allowTeacherAccountClaiming, false);
  assert.equal(savedSettings.geminiExtractionModel, 'gemini-3.8-flash');
  assert.ok(dispatched.includes('published_quizzes_updated'));
  assert.ok(dispatched.includes('school_roster_updated'));
  assert.ok(dispatched.includes('exam_schedule_updated'));
  assert.ok(dispatched.includes('settings_updated'));
  console.log('PASS  syncRestoredAppConfigToLocalStorage syncs quizzes, roster, schedule & settings');

  // 5. Source tripwires for fail-loud backup & complete clean replace
  const backupSrc = fs.readFileSync('src/services/backupService.ts', 'utf8');
  assert.match(backupSrc, /throw new Error\(`Failed to read "\$\{tableName\}" from database/);
  assert.match(backupSrc, /42501/);
  assert.match(backupSrc, /permission denied/i);
  assert.match(backupSrc, /teacher_profiles\.json/);
  assert.match(backupSrc, /proctor_audit_events\.json/);
  assert.match(backupSrc, /game_profiles\.json/);

  const modalSrc = fs.readFileSync('src/components/BackupRestoreModal.tsx', 'utf8');
  assert.match(modalSrc, /backupError && !isBackingUp/);

  const restoreSrc = fs.readFileSync('src/services/restoreService.ts', 'utf8');
  assert.match(restoreSrc, /Replace mode error \(syllabuses\)/);
  assert.match(restoreSrc, /Replace mode error \(quiz_submissions\)/);
  assert.match(restoreSrc, /Replace mode error \(app_config\)/);
  assert.doesNotMatch(restoreSrc, /\.from\('teacher_profiles'[^)]*\)\s*\.delete\(/);
  console.log('PASS  Source tripwires confirm fail-loud backup & safe Clean Replace behavior');

  // 6. Incremental folder sync planning skips files already on disk and catches missing/new ones
  const existingMap = {
    'https://cdn/old/a.png': 'a.png',
    'https://cdn/old/b.png': 'b.png',
    'https://cdn/missing/c.png': 'c.png',
  };
  const diskSet = new Set(['a.png', 'b.png']); // c.png missing on disk
  const plan = planIncrementalMediaNames(
    [
      'https://cdn/old/a.png',
      'https://cdn/old/b.png',
      'https://cdn/missing/c.png',
      'https://cdn/new/a.png', // collides in filename with old/a.png!
    ],
    existingMap,
    diskSet
  );
  assert.equal(plan.skippedExistingCount, 2, 'a.png and b.png on disk should be skipped');
  assert.equal(plan.toDownload.length, 2, 'Only missing c.png and new a.png should be downloaded');
  assert.equal(plan.diagramMapping['https://cdn/new/a.png'], 'a_2.png');
  assert.equal(plan.diagramMapping['https://cdn/missing/c.png'], 'c.png');
  console.log('PASS  planIncrementalMediaNames skips existing disk files & prevents name collisions');

  // 7. Folder-handle restore inspection via FileSystemDirectoryHandle adapter
  const fakeFiles = new Map([
    ['manifest.json', JSON.stringify({ version: '1.1', stats: { questionsCount: 1 }, mediaIncluded: false })],
    ['data/questions.json', JSON.stringify([{ id: '11111111-1111-1111-1111-111111111111' }])],
  ]);
  const makeFileHandle = (content) => ({
    kind: 'file',
    getFile: async () => new Blob([content]),
  });
  const makeDir = (prefix) => ({
    kind: 'directory',
    name: 'TestMaker-Backups',
    getDirectoryHandle: async (sub) => {
      if (sub === 'diagrams') throw new Error('no diagrams');
      return makeDir(prefix ? `${prefix}/${sub}` : sub);
    },
    getFileHandle: async (name) => {
      const key = prefix ? `${prefix}/${name}` : name;
      if (!fakeFiles.has(key)) throw new Error('missing');
      return makeFileHandle(fakeFiles.get(key));
    },
  });
  const dirInsp = await inspectBackupArchive(makeDir(''));
  assert.equal(dirInsp.isValid, true);
  assert.equal(dirInsp.questionsCount, 1);
  assert.equal(dirInsp.manifest?.mediaIncluded, false);
  console.log('PASS  inspectBackupArchive supports synced local backup folders cleanly');
}

await run();
process.exit(0);
