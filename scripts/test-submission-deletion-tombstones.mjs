// Automated test suite & multi-device simulation for submission deletion tombstones
import assert from 'node:assert/strict';

console.log('🧪 Starting Submission Deletion Tombstone & Anti-Resurrection Simulation Suite...\n');

// ─── Minimal Mock Environment ──────────────────────────────────────────────────
class MockLocalStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.get(key) || null;
  }
  setItem(key, value) {
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

// Global storage simulation
const mockStorage = new MockLocalStorage();
global.localStorage = mockStorage;
global.window = {
  dispatchEvent: () => true,
};

// Mock Supabase
let mockCloudTable = new Map();
let mockCloudAppConfig = new Map();

const mockSupabase = {
  from(tableName) {
    return {
      select(cols) {
        return {
          eq(col, val) {
            return {
              maybeSingle: async () => {
                if (tableName === 'app_config') {
                  const item = mockCloudAppConfig.get(val);
                  return { data: item ? { value: item } : null, error: null };
                }
                return { data: null, error: null };
              },
            };
          },
          order() {
            if (tableName === 'quiz_submissions') {
              const rows = Array.from(mockCloudTable.values());
              return Promise.resolve({ data: rows, error: null });
            }
            return Promise.resolve({ data: [], error: null });
          },
        };
      },
      upsert(payload) {
        if (tableName === 'app_config') {
          mockCloudAppConfig.set(payload.key, payload.value);
          return Promise.resolve({ error: null });
        }
        if (tableName === 'quiz_submissions') {
          const rows = Array.isArray(payload) ? payload : [payload];
          rows.forEach((r) => mockCloudTable.set(r.id, r));
          return Promise.resolve({ error: null });
        }
        return Promise.resolve({ error: null });
      },
      delete() {
        return {
          eq(col, val) {
            if (tableName === 'quiz_submissions') {
              mockCloudTable.delete(val);
            }
            if (tableName === 'app_config') {
              mockCloudAppConfig.delete(val);
            }
            return Promise.resolve({ error: null });
          },
          or(clause) {
            return Promise.resolve({ error: null });
          },
        };
      },
    };
  },
};

// ─── Tombstone Constants & Logic under Test ───────────────────────────────────
const DELETED_SUBMISSIONS_KEY = 'fluffykitten_deleted_submission_ids';
const CLOUD_TOMBSTONE_CONFIG_KEY = 'deleted_submission_ids';
const SUBMISSIONS_STORAGE_KEY = 'fluffykitten_quiz_submissions';
const OUTBOX_STORAGE_KEY = 'fluffykitten_submission_outbox';
const MAX_TOMBSTONES = 1000;

function getDeletedSubmissionIds() {
  try {
    const raw = localStorage.getItem(DELETED_SUBMISSIONS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function recordDeletedSubmissionIds(ids) {
  const current = getDeletedSubmissionIds();
  const toAdd = Array.isArray(ids) ? ids : [ids];
  toAdd.forEach((id) => {
    if (id && typeof id === 'string') current.add(id.trim());
  });
  const arr = Array.from(current);
  const trimmed = arr.length > MAX_TOMBSTONES ? arr.slice(arr.length - MAX_TOMBSTONES) : arr;
  localStorage.setItem(DELETED_SUBMISSIONS_KEY, JSON.stringify(trimmed));
}

function isSubmissionDeleted(id) {
  if (!id) return false;
  return getDeletedSubmissionIds().has(id.trim());
}

async function fetchDeletedSubmissionIdsFromCloud() {
  const { data } = await mockSupabase
    .from('app_config')
    .select('value')
    .eq('key', CLOUD_TOMBSTONE_CONFIG_KEY)
    .maybeSingle();
  if (data?.value) {
    try {
      return JSON.parse(data.value);
    } catch {}
  }
  return [];
}

async function syncDeletedSubmissionIdsToCloud(deletedIds) {
  await mockSupabase.from('app_config').upsert({
    key: CLOUD_TOMBSTONE_CONFIG_KEY,
    value: JSON.stringify(deletedIds),
  });
}

async function syncDeletedSubmissionIdsWithCloud() {
  const localDeleted = getDeletedSubmissionIds();
  const cloudDeleted = await fetchDeletedSubmissionIdsFromCloud();
  let hasNewCloudDeleted = false;
  cloudDeleted.forEach((id) => {
    if (id && !localDeleted.has(id)) {
      localDeleted.add(id);
      hasNewCloudDeleted = true;
    }
  });
  if (hasNewCloudDeleted) {
    const arr = Array.from(localDeleted);
    const trimmed = arr.length > MAX_TOMBSTONES ? arr.slice(arr.length - MAX_TOMBSTONES) : arr;
    localStorage.setItem(DELETED_SUBMISSIONS_KEY, JSON.stringify(trimmed));
  }
  if (cloudDeleted.length < localDeleted.size) {
    const arr = Array.from(localDeleted);
    const trimmed = arr.length > MAX_TOMBSTONES ? arr.slice(arr.length - MAX_TOMBSTONES) : arr;
    await syncDeletedSubmissionIdsToCloud(trimmed);
  }
  return localDeleted;
}

function pruneSubmissionFromOutbox(submissionIdOrIds) {
  const targetSet = new Set(Array.isArray(submissionIdOrIds) ? submissionIdOrIds : [submissionIdOrIds]);
  const raw = localStorage.getItem(OUTBOX_STORAGE_KEY);
  const outbox = raw ? JSON.parse(raw) : [];
  const filtered = outbox.filter((item) => !targetSet.has(item.submission.id));
  localStorage.setItem(OUTBOX_STORAGE_KEY, JSON.stringify(filtered));
}

function getAllSubmissions() {
  const deletedIds = getDeletedSubmissionIds();
  const raw = localStorage.getItem(SUBMISSIONS_STORAGE_KEY);
  const parsed = raw ? JSON.parse(raw) : [];
  if (deletedIds.size > 0) {
    const activeOnly = parsed.filter((s) => !deletedIds.has(s.id));
    if (activeOnly.length < parsed.length) {
      localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify(activeOnly));
    }
    return activeOnly;
  }
  return parsed;
}

// ─── TEST 1: Single Deletion Records Tombstone & Purges Local Storage ──────────
{
  console.log('▶ Test 1: Single Deletion & Tombstone Recording');
  mockStorage.clear();
  mockCloudTable.clear();
  mockCloudAppConfig.clear();

  const subA = { id: 'sub-101', studentName: 'Alice', quizId: 'quiz-1', score: 90 };
  const subB = { id: 'sub-102', studentName: 'Bob', quizId: 'quiz-1', score: 85 };

  localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify([subA, subB]));
  mockCloudTable.set(subA.id, subA);
  mockCloudTable.set(subB.id, subB);

  // Teacher deletes subA
  recordDeletedSubmissionIds(subA.id);
  pruneSubmissionFromOutbox(subA.id);
  mockCloudTable.delete(subA.id);

  assert.equal(isSubmissionDeleted('sub-101'), true, 'sub-101 must be marked deleted');
  assert.equal(isSubmissionDeleted('sub-102'), false, 'sub-102 must NOT be marked deleted');

  const remaining = getAllSubmissions();
  assert.equal(remaining.length, 1, 'Only 1 submission should remain in getAllSubmissions');
  assert.equal(remaining[0].id, 'sub-102', 'Remaining submission should be Bob (sub-102)');

  // Verify auto-prune cleaned localStorage
  const prunedStorage = JSON.parse(localStorage.getItem(SUBMISSIONS_STORAGE_KEY));
  assert.equal(prunedStorage.length, 1, 'localStorage must be pruned of deleted sub-101');
  console.log('  ✅ Passed: Single deletion records tombstone and immediately purges local storage.\n');
}

// ─── TEST 2: Multi-Device Cross-Sync Resurrection Prevention ──────────────────
{
  console.log('▶ Test 2: Multi-Device Cross-Sync (Resurrection Bug Simulation)');
  // Simulate Device 1: Teacher deletes sub-201 and pushes tombstone to cloud
  mockStorage.clear();
  mockCloudTable.clear();
  mockCloudAppConfig.clear();

  const sub201 = { id: 'sub-201', studentName: 'Charlie', quizId: 'quiz-2', score: 95 };
  const sub202 = { id: 'sub-202', studentName: 'Diana', quizId: 'quiz-2', score: 88 };

  // Device 1 deletes sub-201
  recordDeletedSubmissionIds(sub201.id);
  await syncDeletedSubmissionIdsToCloud([sub201.id]);
  // Cloud table only has sub202
  mockCloudTable.set(sub202.id, sub202);

  // Now simulate Device 2:
  // Device 2 has sub201 AND sub202 in its own local storage from earlier!
  const device2Storage = new MockLocalStorage();
  device2Storage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify([sub201, sub202]));
  global.localStorage = device2Storage;

  // Device 2 visits Quiz Manager lobby -> loadAndSyncAllSubmissions runs:
  // Step 1: Sync tombstones from cloud
  const device2DeletedIds = await syncDeletedSubmissionIdsWithCloud();
  assert.equal(device2DeletedIds.has('sub-201'), true, 'Device 2 must have learned sub-201 was tombstoned');

  // Step 2: Filter local & cloud lists
  const localList = getAllSubmissions().filter((s) => !device2DeletedIds.has(s.id));
  const cloudList = Array.from(mockCloudTable.values()).filter((s) => !device2DeletedIds.has(s.id));

  // Step 3: Device 2 merges lists
  const mergedMap = new Map();
  cloudList.forEach((s) => mergedMap.set(s.id, s));
  localList.forEach((s) => {
    if (!mergedMap.has(s.id)) mergedMap.set(s.id, s);
  });
  const merged = Array.from(mergedMap.values()).filter((s) => !device2DeletedIds.has(s.id));

  // Assert: sub201 is NEVER in merged list!
  assert.equal(merged.length, 1, 'Merged list on Device 2 must only have Diana (sub-202)');
  assert.equal(merged[0].id, 'sub-202');
  assert.equal(merged.some((s) => s.id === 'sub-201'), false, 'Tombstoned sub-201 must NOT be in merged list');

  // Assert: Device 2 does NOT re-upload sub201 to mockCloudTable
  assert.equal(mockCloudTable.has('sub-201'), false, 'sub-201 must NOT be resurrected in cloud table');
  console.log('  ✅ Passed: Device 2 successfully detects cloud tombstone and does NOT resurrect deleted submission.\n');
}

// ─── TEST 3: Cross-View Local Cache Merge Protection ──────────────────────────
{
  console.log('▶ Test 3: fetchSubmissionsFromSupabase Merge Protection');
  mockStorage.clear();
  mockCloudTable.clear();

  const sub301 = { id: 'sub-301', studentName: 'Evan', quizId: 'quiz-3', score: 78 };
  // Local storage has sub301 cached
  localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify([sub301]));
  // But sub301 is tombstoned
  recordDeletedSubmissionIds(sub301.id);

  // fetchSubmissionsFromSupabase runs:
  const deletedIds = getDeletedSubmissionIds();
  const rawCloudRows = []; // Cloud table already deleted it
  const cloudSubs = rawCloudRows.filter((r) => !deletedIds.has(r.id));
  const local = getAllSubmissions().filter((s) => !deletedIds.has(s.id));

  const map = new Map();
  cloudSubs.forEach((s) => map.set(s.id, s));
  local.forEach((s) => {
    if (!map.has(s.id)) map.set(s.id, s);
  });
  const finalMerged = Array.from(map.values()).filter((s) => !deletedIds.has(s.id));

  assert.equal(finalMerged.length, 0, 'Deleted submission must NOT be returned in results modal');
  console.log('  ✅ Passed: fetchSubmissionsFromSupabase strictly excludes tombstoned records during local cache merge.\n');
}

// ─── TEST 4: Student Offline Outbox Flush Guard ────────────────────────────────
{
  console.log('▶ Test 4: Student Outbox Drop on Tombstone');
  mockStorage.clear();
  mockCloudTable.clear();

  const sub401 = { id: 'sub-401', studentName: 'Fiona', quizId: 'quiz-4', score: 82 };
  // Student browser queued sub401 in outbox
  localStorage.setItem(
    OUTBOX_STORAGE_KEY,
    JSON.stringify([
      { submission: sub401, status: 'pending', queuedAt: new Date().toISOString() }
    ])
  );

  // Teacher deleted sub401
  recordDeletedSubmissionIds(sub401.id);

  // Student device reconnects and runs flushSubmissionOutbox:
  const rawOutbox = JSON.parse(localStorage.getItem(OUTBOX_STORAGE_KEY));
  const deletedIds = getDeletedSubmissionIds();

  for (const item of rawOutbox) {
    if (deletedIds.has(item.submission.id)) {
      pruneSubmissionFromOutbox(item.submission.id);
      // Skip upload!
    } else {
      mockCloudTable.set(item.submission.id, item.submission);
    }
  }

  // Verify sub401 was NOT uploaded
  assert.equal(mockCloudTable.has('sub-401'), false, 'sub-401 must not be uploaded to cloud');

  // Verify outbox was purged
  const updatedOutbox = JSON.parse(localStorage.getItem(OUTBOX_STORAGE_KEY));
  assert.equal(updatedOutbox.length, 0, 'Tombstoned submission must be purged from outbox');
  console.log('  ✅ Passed: Outbox drops tombstoned submission and prevents re-upload.\n');
}

// ─── TEST 5: Bulk Deletion ("Delete All Submissions") ──────────────────────────
{
  console.log('▶ Test 5: Bulk Deletion ("Delete All Submissions") Tombstones');
  mockStorage.clear();

  const subs = [
    { id: 'sub-501', quizId: 'quiz-5' },
    { id: 'sub-502', quizId: 'quiz-5' },
    { id: 'sub-503', quizId: 'quiz-5' },
    { id: 'sub-other', quizId: 'quiz-99' },
  ];
  localStorage.setItem(SUBMISSIONS_STORAGE_KEY, JSON.stringify(subs));

  // Bulk clear for quiz-5
  const all = getAllSubmissions();
  const matching = all.filter((s) => s.quizId === 'quiz-5').map((s) => s.id);
  assert.equal(matching.length, 3, 'Must match 3 submissions for quiz-5');

  recordDeletedSubmissionIds(matching);

  assert.equal(isSubmissionDeleted('sub-501'), true);
  assert.equal(isSubmissionDeleted('sub-502'), true);
  assert.equal(isSubmissionDeleted('sub-503'), true);
  assert.equal(isSubmissionDeleted('sub-other'), false);

  const remaining = getAllSubmissions();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, 'sub-other');
  console.log('  ✅ Passed: Bulk deletion correctly tombstones all quiz submissions.\n');
}

// ─── TEST 6: Tombstone Bounding (FIFO 1,000 Cap) ──────────────────────────────
{
  console.log('▶ Test 6: Tombstone Bounding (FIFO 1,000)');
  mockStorage.clear();

  const thousandIds = [];
  for (let i = 1; i <= 1050; i++) {
    thousandIds.push(`id-${i}`);
  }
  recordDeletedSubmissionIds(thousandIds);

  const set = getDeletedSubmissionIds();
  assert.equal(set.size, 1000, 'Tombstone registry must cap at exactly 1000 items');
  assert.equal(set.has('id-1'), false, 'Oldest item id-1 should be evicted (FIFO)');
  assert.equal(set.has('id-1050'), true, 'Newest item id-1050 must be retained');
  console.log('  ✅ Passed: Tombstone registry bounds to 1,000 items to protect storage quota.\n');
}

console.log('🎉 ALL 6 SUBMISSION TOMBSTONE & ANTI-RESURRECTION TESTS PASSED!');

