# Admin Educator Account Management & Password Lifecycle Plan

## Context & Problem Statement
Previously, `AdvancedSettingsPage.tsx` (the Master Admin area) had no way for an administrator to centrally view, create, edit, deactivate, or reset passwords for educator accounts:
1. **Self-Registration on Login Screen (`PinGate.tsx`)** required toggling `allowTeacherAccountClaiming = true` and sharing the 6-digit School Master PIN with teachers, and hardcoded `role = 'teacher'`.
2. **In-App Profile Creation (`TeacherProfileModal.tsx`)** only created passwordless rows (`email = NULL`, `username = NULL`, `password_hash = NULL`) that could not sign in via `PinGate.tsx`, and immediately hijacked the active user's session.
3. **No Password Lifecycle Controls**: Admin could not provision an account with a temporary password (`must_change_password`), suspend (`is_active = false`) an account to revoke active sessions, or let teachers change their own password inside the workspace.

---

## Execution Plan (5 Testable Steps)

### Step 1: Database Migration (`026_admin_teacher_account_management.sql`) & Types
- **Files**:
  - `supabase/migrations/026_admin_teacher_account_management.sql`
  - `src/types/database.ts`
- **Changes**:
  - Add `must_change_password BOOLEAN NOT NULL DEFAULT FALSE` to `public.teacher_profiles`.
  - Update `public.sanitize_teacher_profile_json(p_row)` to include `'is_active', COALESCE(p_row.is_active, TRUE)` and `'must_change_password', COALESCE(p_row.must_change_password, FALSE)`.
  - Create helper `public.is_admin_or_master_pin(p_master_pin TEXT DEFAULT NULL) RETURNS BOOLEAN` that checks either an active `teacher_auth_sessions` token with `role = 'admin'` or `public.verify_teacher_access_pin(p_master_pin)`.
  - Create Admin RPCs (`SECURITY DEFINER`, granted to `anon, authenticated`):
    1. `public.admin_list_teacher_accounts(p_master_pin TEXT DEFAULT NULL) RETURNS JSONB`
    2. `public.admin_create_teacher_account(p_master_pin TEXT, p_name TEXT, p_title TEXT, p_email TEXT, p_username TEXT, p_password TEXT, p_role TEXT, p_subject TEXT, p_subject_code TEXT, p_default_classes TEXT[], p_must_change_password BOOLEAN DEFAULT TRUE) RETURNS JSONB`
    3. `public.admin_update_teacher_account(p_master_pin TEXT, p_teacher_id UUID, p_name TEXT, p_title TEXT, p_email TEXT, p_username TEXT, p_role TEXT, p_subject TEXT, p_subject_code TEXT, p_default_classes TEXT[], p_is_active BOOLEAN) RETURNS JSONB` (revokes `teacher_auth_sessions` when `p_is_active = FALSE`)
    4. `public.admin_reset_teacher_password(p_master_pin TEXT, p_teacher_id UUID, p_new_password TEXT, p_must_change_password BOOLEAN DEFAULT TRUE) RETURNS JSONB` (revokes existing sessions for `p_teacher_id` without altering the caller's session)
    5. `public.admin_delete_teacher_account(p_master_pin TEXT, p_teacher_id UUID) RETURNS JSONB`
  - Create Self-Service Password RPC:
    6. `public.change_own_teacher_password(p_current_password TEXT, p_new_password TEXT, p_teacher_id UUID DEFAULT NULL) RETURNS JSONB` (verifies current password for the authenticated teacher, updates `password_hash`, clears `must_change_password = FALSE`).
  - Extend `TeacherProfile` in `src/types/database.ts` with `is_active?: boolean` and `must_change_password?: boolean`.
- **Step 1 Test (`AT-1`)**: Verify migration SQL syntax, RPC definitions, `sanitize_teacher_profile_json` fields, and session revocation rules.

---

### Step 2: Service Layer (`teacherProfileService.ts`)
- **Files**:
  - `src/services/teacherProfileService.ts`
- **Changes**:
  - Update `mapRawTeacherProfile` to preserve `is_active: row.is_active !== false` and `must_change_password: Boolean(row.must_change_password)`.
  - Implement:
    - `adminListTeacherAccounts(masterPin?: string)`
    - `adminCreateTeacherAccount(payload)`
    - `adminUpdateTeacherAccount(payload)`
    - `adminResetTeacherPassword(payload)`
    - `adminDeleteTeacherAccount(teacherId, masterPin?)`
    - `changeOwnTeacherPassword(currentPassword, newPassword, teacherId?)`
    - `generateTemporaryTeacherPassword()` (generates a readable 8-char temporary password, e.g. `ICM-4829`)
  - Include offline/local-cache fallback when Supabase RPCs are unreachable in local/offline environments, ensuringAdmin CRUD never overwrites `ACTIVE_PROFILE_KEY` or the admin's own session token.
- **Step 2 Test (`AT-2`)**: Verify `adminCreateTeacherAccount`, `adminUpdateTeacherAccount`, `adminResetTeacherPassword`, `adminDeleteTeacherAccount`, and `changeOwnTeacherPassword` preserve admin session isolation and update profile flags (`role`, `is_active`, `must_change_password`, `has_password`).

---

### Step 3: Forced First-Login Password Change & Self-Service Password Update (`PinGate.tsx` & `TeacherProfileSettingsModal.tsx`)
- **Files**:
  - `src/components/PinGate.tsx`
  - `src/components/TeacherProfileSettingsModal.tsx`
- **Changes**:
  - **`PinGate.tsx`**:
    - Add `'force_change_password'` view mode triggered when `loginTeacherAccount` returns a profile with `must_change_password === true`.
    - Prompts the educator to enter & confirm a new personal password (at least 6 characters, different from the temporary password), calls `changeOwnTeacherPassword`, updates the cached profile (`must_change_password: false`), and completes unlock.
  - **`TeacherProfileSettingsModal.tsx`**:
    - Add an **Account Login & Password** section showing the educator's `username` / `email` and `role` badge, plus a **Change Login Password** form (`Current Password`, `New Password`, `Confirm Password`) calling `changeOwnTeacherPassword`.
- **Step 3 Test (`AT-3`)**: Verify `PinGate.tsx` gates login completion when `must_change_password` is true and `TeacherProfileSettingsModal.tsx` exposes self-service password change.

---

### Step 4: Admin Educator Accounts Dashboard Tab (`AdvancedSettingsPage.tsx`)
- **Files**:
  - `src/pages/AdvancedSettingsPage.tsx`
- **Changes**:
  - Add a new top-level tab: **👩‍🏫 Educator Accounts** (`activeSection === 'teachers'`).
  - **Create Educator Account Card**:
    - Inputs: Title, Full Name, Username, School Email, Role (`teacher` / `admin`), Primary Subject, Syllabus Code, Teaching Cohorts multi-select, Initial Password (with `🎲 Generate` button), and `[x] Require password change on first sign-in` toggle.
    - One-click **📋 Copy Login Credentials** banner after creation or password reset.
  - **Educator Accounts Directory**:
    - Displays each account with Name, Title, Username/Email, Role badge (`🛡️ Admin` / `👩‍🏫 Teacher`), Subject & Cohorts, Status badges (`Active` / `Suspended`, `🔑 Password Set` / `⏳ Temp Password` / `🔓 No Password`), and `last_login_at`.
    - Actions per row: **Edit Account** (inline panel/modal for name, username, email, role, subject, classes), **Reset Password** (sets temporary password with `must_change_password = true`), **Activate / Suspend** toggle (`is_active`), and **Delete**.
- **Step 4 Test (`AT-4`)**: Verify `AdvancedSettingsPage.tsx` renders the Educator Accounts tab and wires all admin CRUD/reset/suspend handlers.

---

### Step 5: End-to-End Test Suite, Lint & Production Build
- **Files**:
  - `scripts/test-admin-teacher-accounts.mjs`
  - `package.json` (`"test:teacher-accounts"`)
- **Verification**:
  - Run `npm run test:teacher-accounts`
  - Run `npx oxlint` on all modified files
  - Run `npm run build` (`tsc -b && vite build`)
