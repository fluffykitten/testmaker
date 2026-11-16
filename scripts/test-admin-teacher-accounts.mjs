// ─── Admin Teacher Account Management & Password Lifecycle Tests ────────────
import fs from 'node:fs';
import path from 'node:path';

const storage = new Map();
const sessionStore = new Map();

globalThis.localStorage = {
  getItem: (k) => (storage.has(k) ? storage.get(k) : null),
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
};

globalThis.sessionStorage = {
  getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
  setItem: (k, v) => sessionStore.set(k, String(v)),
  removeItem: (k) => sessionStore.delete(k),
  clear: () => sessionStore.clear(),
};

if (typeof globalThis.window === 'undefined') {
  globalThis.window = {
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
}

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`PASS: ${label}`);
    passed++;
  } else {
    console.error(`FAIL: ${label}`);
    failed++;
  }
}

async function run() {
  // ─── Step 1: Migration 026 & Database Types ─────────────────────────────────
  const mig026 = fs.readFileSync(
    path.resolve('supabase/migrations/026_admin_teacher_account_management.sql'),
    'utf8'
  );
  const dbTypes = fs.readFileSync(path.resolve('src/types/database.ts'), 'utf8');

  assert(
    mig026.includes('ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE') &&
      mig026.includes("'must_change_password'") &&
      mig026.includes("'is_active'") &&
      dbTypes.includes('is_active?: boolean;') &&
      dbTypes.includes('must_change_password?: boolean;'),
    'AT-1a: Migration 026 & TeacherProfile type define must_change_password and is_active'
  );

  assert(
    mig026.includes('CREATE OR REPLACE FUNCTION public.is_admin_or_master_pin') &&
      mig026.includes('CREATE OR REPLACE FUNCTION public.admin_list_teacher_accounts') &&
      mig026.includes('CREATE OR REPLACE FUNCTION public.admin_create_teacher_account') &&
      mig026.includes('CREATE OR REPLACE FUNCTION public.admin_update_teacher_account') &&
      mig026.includes('CREATE OR REPLACE FUNCTION public.admin_reset_teacher_password') &&
      mig026.includes('CREATE OR REPLACE FUNCTION public.admin_delete_teacher_account') &&
      mig026.includes('CREATE OR REPLACE FUNCTION public.change_own_teacher_password'),
    'AT-1b: Migration 026 defines all 5 Admin RPCs, auth helper, and self-service password change RPC'
  );

  assert(
    mig026.includes('IF COALESCE(v_updated.is_active, TRUE) = FALSE THEN') &&
      mig026.includes('DELETE FROM public.teacher_auth_sessions') &&
      mig026.includes('v_caller_id = p_teacher_id'),
    'AT-1c: Migration 026 revokes active sessions on deactivation/password reset and blocks self-deletion'
  );

  // ─── Step 2: Service Layer (teacherProfileService.ts) ───────────────────────
  const { supabase } = await import('../src/lib/supabase.ts');
  const {
    generateTemporaryTeacherPassword,
    adminListTeacherAccounts,
    adminCreateTeacherAccount,
    adminUpdateTeacherAccount,
    adminResetTeacherPassword,
    adminDeleteTeacherAccount,
    changeOwnTeacherPassword,
    setActiveTeacherProfileId,
    getActiveTeacherProfileId,
  } = await import('../src/services/teacherProfileService.ts');

  // Mock Supabase RPC to simulate offline/pre-migration fallback deterministically
  const rpcCalls = [];
  supabase.rpc = async (fnName, args) => {
    rpcCalls.push({ fnName, args });
    return {
      data: null,
      error: { code: 'PGRST202', message: `Could not find the function public.${fnName}` },
    };
  };

  const tempPw = generateTemporaryTeacherPassword();
  assert(
    /^ICM-[2-9]{4}$/.test(tempPw) && tempPw.length === 8,
    `AT-2a: generateTemporaryTeacherPassword creates readable 8-char password (${tempPw})`
  );

  // Set active profile to an admin ID and verify adminCreateTeacherAccount does NOT hijack activeProfileId
  setActiveTeacherProfileId('admin-root-1');
  const createRes = await adminCreateTeacherAccount({
    masterPin: '140798',
    name: 'Siti Rahma',
    title: 'Ibu',
    email: 'siti@icm.sch.id',
    username: 'siti.bio',
    password: tempPw,
    role: 'teacher',
    subject: 'Biology',
    subjectCode: '0610',
    defaultClasses: ['X IPA 1', 'X IPA 2'],
    mustChangePassword: true,
  });

  assert(
    createRes.status === 'ok' &&
      createRes.profile?.name === 'Siti Rahma' &&
      createRes.profile?.username === 'siti.bio' &&
      createRes.profile?.role === 'teacher' &&
      createRes.profile?.has_password === true &&
      createRes.profile?.must_change_password === true &&
      createRes.profile?.is_active === true &&
      getActiveTeacherProfileId() === 'admin-root-1',
    'AT-2b: adminCreateTeacherAccount provisions educator with temporary password without hijacking active workspace'
  );

  // Duplicate username/email check
  const dupRes = await adminCreateTeacherAccount({
    masterPin: '140798',
    name: 'Duplicate Teacher',
    username: 'siti.bio',
    password: 'password123',
  });
  assert(
    dupRes.status === 'error' && /already exists/i.test(dupRes.error || ''),
    'AT-2c: adminCreateTeacherAccount rejects duplicate email/username'
  );

  // Update role + suspend/reactivate + reset password + self-service password change + delete
  const createdId = createRes.profile.id;
  const updateRes = await adminUpdateTeacherAccount({
    masterPin: '140798',
    teacherId: createdId,
    role: 'admin',
    isActive: false,
  });
  assert(
    updateRes.status === 'ok' &&
      updateRes.profile?.role === 'admin' &&
      updateRes.profile?.is_active === false,
    'AT-2d: adminUpdateTeacherAccount updates role and suspends account (is_active=false)'
  );

  const resetRes = await adminResetTeacherPassword({
    masterPin: '140798',
    teacherId: createdId,
    newPassword: 'ICM-9988',
    mustChangePassword: true,
  });
  assert(
    resetRes.status === 'ok' &&
      resetRes.profile?.must_change_password === true &&
      resetRes.profile?.is_active === true,
    'AT-2e: adminResetTeacherPassword re-activates account and flags must_change_password=true'
  );

  const selfChangeRes = await changeOwnTeacherPassword('ICM-9988', 'MyPersonalPass2026!', createdId);
  assert(
    selfChangeRes.status === 'ok' &&
      selfChangeRes.profile?.must_change_password === false &&
      selfChangeRes.profile?.has_password === true,
    'AT-2f: changeOwnTeacherPassword clears must_change_password=false after educator sets personal password'
  );

  const listBeforeDelete = await adminListTeacherAccounts('140798');
  const deleteRes = await adminDeleteTeacherAccount(createdId, '140798');
  const listAfterDelete = await adminListTeacherAccounts('140798');
  assert(
    listBeforeDelete.profiles.some((p) => p.id === createdId) &&
      deleteRes.status === 'ok' &&
      !listAfterDelete.profiles.some((p) => p.id === createdId),
    'AT-2g: adminDeleteTeacherAccount removes educator account cleanly'
  );

  // ─── Step 3: Forced First-Login Password Change & Self-Service Modal ────────
  const pinGateSrc = fs.readFileSync(path.resolve('src/components/PinGate.tsx'), 'utf8');
  const settingsModalSrc = fs.readFileSync(
    path.resolve('src/components/TeacherProfileSettingsModal.tsx'),
    'utf8'
  );

  assert(
    pinGateSrc.includes("viewMode === 'force_change_password'") &&
      pinGateSrc.includes('if (res.profile.must_change_password)') &&
      pinGateSrc.includes('handleForcePasswordChangeSubmit') &&
      pinGateSrc.includes('changeOwnTeacherPassword('),
    'AT-3a: PinGate intercepts login when must_change_password=true and requires setting a new personal password'
  );

  assert(
    settingsModalSrc.includes('changeOwnTeacherPassword(') &&
      settingsModalSrc.includes('Change Login Password') &&
      settingsModalSrc.includes('Account Login &amp; Password'),
    'AT-3b: TeacherProfileSettingsModal exposes self-service Change Login Password section'
  );

  // ─── Step 4: Admin Educator Accounts Dashboard Tab ──────────────────────────
  const advSrc = fs.readFileSync(path.resolve('src/pages/AdvancedSettingsPage.tsx'), 'utf8');

  assert(
    advSrc.includes("activeSection === 'teachers'") &&
      advSrc.includes('Provision New Educator Account') &&
      advSrc.includes('Registered Educator Accounts') &&
      advSrc.includes('Copy Credentials'),
    'AT-4a: AdvancedSettingsPage renders Educator Accounts tab, provisioning form, directory list, and Copy Credentials banner'
  );

  assert(
    advSrc.includes('adminListTeacherAccounts(') &&
      advSrc.includes('adminCreateTeacherAccount(') &&
      advSrc.includes('adminUpdateTeacherAccount(') &&
      advSrc.includes('adminResetTeacherPassword(') &&
      advSrc.includes('adminDeleteTeacherAccount('),
    'AT-4b: AdvancedSettingsPage wires all 5 Admin Educator Account management service calls'
  );

  // ─── Step 5: Bootstrap Admin Auth, Direct Fallback & Inline Edit/Password ───
  assert(
    mig026.includes("WHERE LOWER(TRIM(COALESCE(role, 'teacher'))) = 'admin'") &&
      mig026.includes('AND is_active = TRUE'),
    'AT-5a: Migration 026 supports bootstrap admin authorization when no active admin row exists yet'
  );

  const svcSrc = fs.readFileSync(path.resolve('src/services/teacherProfileService.ts'), 'utf8');
  assert(
    svcSrc.includes('fetchDirectTeacherAccountsFromTable') &&
      svcSrc.includes('computeSaltedTeacherPasswordHash') &&
      svcSrc.includes('isUuidString(') &&
      advSrc.includes('editTeacherError') &&
      advSrc.includes('editTeacherPassword') &&
      advSrc.includes('Register / Edit'),
    'AT-5b: Pre-026 direct Supabase table fallback, UUID guard, inline edit error display, and optional password setup in Edit are wired'
  );

  console.log(`\nAdmin Teacher Account tests: ${passed} passed, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
