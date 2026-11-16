// ─── Teacher Profile Service ──────────────────────────────────────────────────
// Manages cloud-synced and locally-cached teacher profiles, unified educator
// login/registration RPCs, subject isolation, and 4-digit PIN helpers.

import { supabase, TEACHER_SESSION_TOKEN_KEY, hasActiveTeacherSession, isSupabaseConfigured } from '../lib/supabase';
import type { TeacherProfile, TeacherPreferences } from '../types/database';
import { sha256Hex, verifyPinAgainstHashOrPlain } from '../utils/cryptoUtils';

export const ACTIVE_PROFILE_KEY = 'testmaker_active_teacher_profile_id';
export const CACHED_PROFILES_KEY = 'testmaker_cached_teacher_profiles';
const VERIFIED_SESSION_KEY = 'testmaker_pin_verified';

export const DEFAULT_CHEMISTRY_PROFILE: TeacherProfile = {
  id: 'chem-default-budi',
  name: 'Dr. Budi Santoso',
  title: 'Dr.',
  role: 'teacher',
  subject: 'Chemistry',
  subject_code: '0620',
  pin_hash: null, // PIN-free by default
  default_classes: ['10-A', '10-B', '11-A'],
  preferences: {
    autoEnablePeriodicTable: true,
    defaultCalculator: 'scientific',
    showOtherSubjects: false,
    defaultExamDurationMinutes: 45,
  },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// In-memory module cache
let inMemoryProfiles: TeacherProfile[] | null = null;
let hasFetchedCloudProfiles = false;

function sanitizeProfileForStorage(profile: TeacherProfile): TeacherProfile {
  const { pin_hash: _ph, ...rest } = profile as TeacherProfile & { password_hash?: unknown };
  delete rest.password_hash;
  return {
    ...rest,
    pin_hash: null,
    default_classes: Array.isArray(rest.default_classes) ? rest.default_classes : ['10-A', '10-B'],
    preferences: rest.preferences || {
      autoEnablePeriodicTable: true,
      defaultCalculator: 'scientific',
      showOtherSubjects: false,
      defaultExamDurationMinutes: 45,
    },
  };
}

function mapRawTeacherProfile(row: any): TeacherProfile {
  return sanitizeProfileForStorage({
    id: row.id,
    name: row.name,
    title: row.title || undefined,
    email: row.email ?? null,
    username: row.username ?? null,
    role: row.role === 'admin' ? 'admin' : 'teacher',
    is_active: row.is_active !== false,
    has_password: Boolean(row.has_password),
    must_change_password: Boolean(row.must_change_password),
    last_login_at: row.last_login_at ?? null,
    subject: row.subject || 'Chemistry',
    subject_code: row.subject_code || '',
    pin_hash: null,
    default_classes: Array.isArray(row.default_classes) ? row.default_classes : ['Grade 10', 'Grade 11'],
    preferences: (row.preferences as TeacherPreferences) || {
      autoEnablePeriodicTable: true,
      defaultCalculator: 'scientific',
      showOtherSubjects: false,
    },
    created_at: row.created_at || new Date().toISOString(),
    updated_at: row.updated_at || new Date().toISOString(),
  });
}

function getCachedProfiles(): TeacherProfile[] {
  try {
    const raw = localStorage.getItem(CACHED_PROFILES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(sanitizeProfileForStorage) : [];
  } catch {
    return [];
  }
}

function saveCachedProfiles(profiles: TeacherProfile[]): void {
  const sanitized = profiles.map(sanitizeProfileForStorage);
  try {
    inMemoryProfiles = sanitized;
    localStorage.setItem(CACHED_PROFILES_KEY, JSON.stringify(sanitized));
  } catch (err) {
    console.warn('Failed to save teacher profiles to localStorage:', err);
  }
}

/**
 * Persists an authenticated session token + educator profile and activates the workspace.
 */
export function upsertAuthenticatedTeacherProfile(
  profile: TeacherProfile,
  token?: string
): TeacherProfile {
  const cleanProfile = mapRawTeacherProfile(profile);

  if (typeof sessionStorage !== 'undefined') {
    if (token && token.trim()) {
      sessionStorage.setItem(TEACHER_SESSION_TOKEN_KEY, token.trim());
    }
    sessionStorage.setItem(VERIFIED_SESSION_KEY, 'true');
  }

  const existing = getCachedProfiles();
  const merged = [...existing.filter((p) => p.id !== cleanProfile.id), cleanProfile];
  saveCachedProfiles(merged);
  hasFetchedCloudProfiles = false;
  setActiveTeacherProfileId(cleanProfile.id);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('teacher_session_authenticated', { detail: { profile: cleanProfile } }));
  }

  return cleanProfile;
}

export interface TeacherAuthRpcResult {
  status: 'ok' | 'setup_required' | 'invalid_credentials' | 'rpc_unavailable' | 'error';
  token?: string;
  expiresAt?: string;
  profile?: TeacherProfile;
  message?: string;
  error?: string;
}

function isRpcUnavailableError(error: any): boolean {
  if (!error) return false;
  const msg = String(error.message || error.details || error || '').toLowerCase();
  const code = String(error.code || '').toUpperCase();
  return (
    code === 'PGRST202' ||
    code === '42883' ||
    msg.includes('could not find the function') ||
    msg.includes('does not exist') ||
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('timeout')
  );
}

/**
 * Authenticates an educator by email/username/display name + password via Supabase RPC.
 */
export async function loginTeacherAccount(
  identifier: string,
  password: string
): Promise<TeacherAuthRpcResult> {
  try {
    const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) =>
      setTimeout(() => resolve({ data: null, error: new Error('timeout') }), 7000)
    );
    const rpcPromise = (supabase as any).rpc('login_teacher_account', {
      p_identifier: identifier.trim(),
      p_password: password,
    });

    const res = (await Promise.race([rpcPromise, timeoutPromise])) as { data: any; error: any };
    if (res.error) {
      if (isRpcUnavailableError(res.error)) {
        return { status: 'rpc_unavailable', error: res.error.message || 'Authentication RPC unavailable.' };
      }
      return { status: 'error', error: res.error.message || 'Sign-in failed.' };
    }

    const payload = res.data || {};
    if (payload.status === 'ok' && payload.profile) {
      return {
        status: 'ok',
        token: payload.token,
        expiresAt: payload.expiresAt,
        profile: mapRawTeacherProfile(payload.profile),
      };
    }

    if (payload.status === 'setup_required' && payload.profile) {
      return {
        status: 'setup_required',
        profile: mapRawTeacherProfile(payload.profile),
        message: payload.message,
      };
    }

    return {
      status: payload.status === 'invalid_credentials' ? 'invalid_credentials' : 'error',
      error: payload.error || 'Invalid username/email or password.',
    };
  } catch (err: any) {
    if (isRpcUnavailableError(err)) {
      return { status: 'rpc_unavailable', error: err?.message || 'Network timeout.' };
    }
    return { status: 'error', error: err?.message || 'Unable to sign in right now.' };
  }
}

/**
 * Creates a new educator account or claims a passwordless legacy profile (Master-PIN gated).
 */
export async function registerOrClaimTeacherAccount(payload: {
  masterPin: string;
  email?: string;
  username?: string;
  password: string;
  name: string;
  title?: string;
  subject?: string;
  subjectCode?: string;
  defaultClasses?: string[];
  claimProfileId?: string | null;
}): Promise<TeacherAuthRpcResult> {
  try {
    const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) =>
      setTimeout(() => resolve({ data: null, error: new Error('timeout') }), 7000)
    );
    const rpcPromise = (supabase as any).rpc('register_or_claim_teacher_account', {
      p_master_pin: payload.masterPin.trim(),
      p_email: payload.email?.trim() || '',
      p_username: payload.username?.trim() || '',
      p_password: payload.password,
      p_name: payload.name.trim(),
      p_title: payload.title?.trim() || 'Dr.',
      p_subject: payload.subject?.trim() || 'Chemistry',
      p_subject_code: payload.subjectCode?.trim() || '0620',
      p_default_classes:
        payload.defaultClasses && payload.defaultClasses.length > 0
          ? payload.defaultClasses
          : ['10-A', '10-B'],
      p_claim_profile_id: payload.claimProfileId || null,
    });

    const res = (await Promise.race([rpcPromise, timeoutPromise])) as { data: any; error: any };
    if (res.error) {
      if (isRpcUnavailableError(res.error)) {
        return { status: 'rpc_unavailable', error: res.error.message || 'Registration RPC unavailable.' };
      }
      return { status: 'error', error: res.error.message || 'Account setup failed.' };
    }

    const out = res.data || {};
    if (out.status === 'ok' && out.profile) {
      return {
        status: 'ok',
        token: out.token,
        expiresAt: out.expiresAt,
        profile: mapRawTeacherProfile(out.profile),
      };
    }

    return {
      status: 'error',
      error: out.error || 'Could not create or claim educator account.',
    };
  } catch (err: any) {
    return {
      status: isRpcUnavailableError(err) ? 'rpc_unavailable' : 'error',
      error: err?.message || 'Account setup failed.',
    };
  }
}

/**
 * Resets a forgotten teacher password using the 6-digit School Master PIN.
 */
export async function resetTeacherPasswordWithMasterPin(
  identifier: string,
  newPassword: string,
  masterPin: string
): Promise<TeacherAuthRpcResult> {
  try {
    const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) =>
      setTimeout(() => resolve({ data: null, error: new Error('timeout') }), 7000)
    );
    const rpcPromise = (supabase as any).rpc('reset_teacher_password_with_master_pin', {
      p_identifier: identifier.trim(),
      p_new_password: newPassword,
      p_master_pin: masterPin.trim(),
    });

    const res = (await Promise.race([rpcPromise, timeoutPromise])) as { data: any; error: any };
    if (res.error) {
      if (isRpcUnavailableError(res.error)) {
        return { status: 'rpc_unavailable', error: res.error.message || 'Password reset RPC unavailable.' };
      }
      return { status: 'error', error: res.error.message || 'Password reset failed.' };
    }

    const out = res.data || {};
    if (out.status === 'ok' && out.profile) {
      return {
        status: 'ok',
        token: out.token,
        expiresAt: out.expiresAt,
        profile: mapRawTeacherProfile(out.profile),
      };
    }

    return {
      status: 'error',
      error: out.error || 'Could not reset password.',
    };
  } catch (err: any) {
    return {
      status: isRpcUnavailableError(err) ? 'rpc_unavailable' : 'error',
      error: err?.message || 'Password reset failed.',
    };
  }
}

/**
 * Revokes the current teacher session token on the server and clears local session keys.
 */
export async function logoutTeacherSession(): Promise<void> {
  try {
    if (hasActiveTeacherSession()) {
      await Promise.race([
        (supabase as any).rpc('logout_teacher_session'),
        new Promise((resolve) => setTimeout(resolve, 2500)),
      ]);
    }
  } catch {
    // Always clear client session keys even when offline
  } finally {
    inMemoryProfiles = null;
    hasFetchedCloudProfiles = false;
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(TEACHER_SESSION_TOKEN_KEY);
      sessionStorage.removeItem(VERIFIED_SESSION_KEY);
    }
  }
}

/**
 * Retrieves teacher profiles from Supabase only when an authenticated teacher session is active,
 * falling back to local cache otherwise (preventing anonymous /teacher_profiles queries).
 */
export async function fetchTeacherProfiles(): Promise<TeacherProfile[]> {
  if (inMemoryProfiles && inMemoryProfiles.length > 0 && (!hasActiveTeacherSession() || hasFetchedCloudProfiles)) {
    return inMemoryProfiles;
  }

  if (hasActiveTeacherSession()) {
    try {
      const timeoutPromise = new Promise<{ data: null; error: string }>((resolve) =>
        setTimeout(() => resolve({ data: null, error: 'timeout' }), 4000)
      );

      const queryPromise = (supabase.from('teacher_profiles' as any) as any)
        .select('id, name, title, email, username, role, is_active, must_change_password, last_login_at, subject, subject_code, default_classes, preferences, created_at, updated_at')
        .order('created_at', { ascending: true });

      const res = (await Promise.race([queryPromise, timeoutPromise])) as {
        data: any[] | null;
        error: any;
      };

      if (!res.error && res.data && res.data.length > 0) {
        const prevCached = new Map(getCachedProfiles().map((p) => [p.id, p]));
        const profiles = res.data.map((row) => {
          const prev = prevCached.get(row.id);
          return mapRawTeacherProfile({
            ...row,
            has_password:
              row.has_password !== undefined
                ? Boolean(row.has_password)
                : Boolean(prev?.has_password || row.last_login_at),
            must_change_password:
              row.must_change_password !== undefined
                ? Boolean(row.must_change_password)
                : Boolean(prev?.must_change_password),
          });
        });
        hasFetchedCloudProfiles = true;
        saveCachedProfiles(profiles);
        return profiles;
      }
    } catch (err) {
      console.warn('Failed to query teacher profiles from Supabase, using local cache:', err);
    }
  }

  // Fallback to local storage cache
  const cached = getCachedProfiles();
  if (cached.length > 0) {
    return cached;
  }

  // Seed default Chemistry profile if nothing exists anywhere
  saveCachedProfiles([DEFAULT_CHEMISTRY_PROFILE]);
  return [DEFAULT_CHEMISTRY_PROFILE];
}

/**
 * Returns the currently active profile ID from localStorage.
 */
export function getActiveTeacherProfileId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_PROFILE_KEY);
  } catch {
    return null;
  }
}

/**
 * Sets the active teacher profile ID and dispatches a notification event.
 */
export function setActiveTeacherProfileId(id: string | null): void {
  try {
    if (id) {
      localStorage.setItem(ACTIVE_PROFILE_KEY, id);
    } else {
      localStorage.removeItem(ACTIVE_PROFILE_KEY);
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('teacher_profile_changed', { detail: { profileId: id } }));
    }
  } catch (err) {
    console.warn('Failed to set active teacher profile ID:', err);
  }
}

/**
 * Creates a new teacher profile in Supabase and local cache.
 */
export async function createTeacherProfile(
  payload: {
    name: string;
    title?: string;
    subject: string;
    subject_code?: string;
    pin?: string;
    default_classes?: string[];
    preferences?: Partial<TeacherPreferences>;
  }
): Promise<TeacherProfile> {
  const pinHash = payload.pin && payload.pin.trim().length === 4
    ? await sha256Hex(payload.pin.trim())
    : null;

  const newId = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'tp_' + Date.now().toString(36);

  const newProfile: TeacherProfile = {
    id: newId,
    name: payload.name.trim(),
    title: payload.title?.trim() || null,
    subject: payload.subject.trim() || 'Chemistry',
    subject_code: payload.subject_code ? payload.subject_code.trim() : '',
    pin_hash: pinHash,
    default_classes: payload.default_classes && payload.default_classes.length > 0
      ? payload.default_classes
      : ['Grade 10', 'Grade 11'],
    preferences: {
      autoEnablePeriodicTable: payload.preferences?.autoEnablePeriodicTable ?? true,
      defaultCalculator: payload.preferences?.defaultCalculator ?? 'scientific',
      showOtherSubjects: payload.preferences?.showOtherSubjects ?? false,
      defaultExamDurationMinutes: payload.preferences?.defaultExamDurationMinutes ?? 45,
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  try {
    const { data, error } = await (supabase.from('teacher_profiles' as any) as any)
      .insert({
        id: newProfile.id,
        name: newProfile.name,
        title: newProfile.title,
        subject: newProfile.subject,
        subject_code: newProfile.subject_code,
        pin_hash: newProfile.pin_hash,
        default_classes: newProfile.default_classes,
        preferences: newProfile.preferences,
      })
      .select('*')
      .single();

    if (!error && data) {
      newProfile.id = data.id;
    }
  } catch (err) {
    console.warn('Failed to insert teacher profile into Supabase, saving to local cache:', err);
  }

  const existing = getCachedProfiles();
  const updated = [...existing.filter((p) => p.id !== newProfile.id), newProfile];
  saveCachedProfiles(updated);
  setActiveTeacherProfileId(newProfile.id);

  return newProfile;
}

/**
 * Updates an existing teacher profile in Supabase and local cache.
 */
export async function updateTeacherProfile(
  id: string,
  updates: Partial<Omit<TeacherProfile, 'id' | 'created_at'>> & { newPin?: string | null }
): Promise<TeacherProfile> {
  const cached = getCachedProfiles();
  const existing = cached.find((p) => p.id === id) || DEFAULT_CHEMISTRY_PROFILE;

  let pinHash = existing.pin_hash;
  if (updates.newPin !== undefined) {
    if (updates.newPin && updates.newPin.trim().length === 4) {
      pinHash = await sha256Hex(updates.newPin.trim());
    } else if (updates.newPin === null || updates.newPin === '') {
      pinHash = null;
    }
  }

  const updatedProfile: TeacherProfile = {
    ...existing,
    name: updates.name !== undefined ? updates.name.trim() : existing.name,
    title: updates.title !== undefined ? updates.title : existing.title,
    subject: updates.subject !== undefined ? updates.subject.trim() : existing.subject,
    subject_code: updates.subject_code !== undefined ? updates.subject_code.trim() : existing.subject_code,
    pin_hash: pinHash,
    default_classes: updates.default_classes || existing.default_classes,
    preferences: {
      ...existing.preferences,
      ...(updates.preferences || {}),
    },
    updated_at: new Date().toISOString(),
  };

  try {
    await (supabase.from('teacher_profiles' as any) as any)
      .update({
        name: updatedProfile.name,
        title: updatedProfile.title,
        subject: updatedProfile.subject,
        subject_code: updatedProfile.subject_code,
        pin_hash: updatedProfile.pin_hash,
        default_classes: updatedProfile.default_classes,
        preferences: updatedProfile.preferences,
        updated_at: updatedProfile.updated_at,
      })
      .eq('id', id);
  } catch (err) {
    console.warn('Failed to update teacher profile in Supabase:', err);
  }

  const newProfiles = cached.map((p) => (p.id === id ? updatedProfile : p));
  saveCachedProfiles(newProfiles);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('teacher_profile_updated', { detail: { profile: updatedProfile } }));
  }

  return updatedProfile;
}

/**
 * Verifies a teacher's entered 4-digit PIN against their profile.
 * Returns true if the profile has no PIN or if the PIN matches.
 */
export async function verifyTeacherProfilePin(
  profile: TeacherProfile,
  enteredPin: string
): Promise<boolean> {
  if (!profile.pin_hash) {
    return true; // PIN-free profile
  }
  return verifyPinAgainstHashOrPlain(enteredPin, profile.pin_hash);
}

// ─── Admin Educator Account Management & Self-Service Password RPCs ───────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidString(value: string | null | undefined): boolean {
  return Boolean(value && UUID_REGEX.test(value.trim()));
}

async function computeSaltedTeacherPasswordHash(plainPassword: string): Promise<string> {
  const randomBytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(randomBytes);
  } else {
    for (let i = 0; i < randomBytes.length; i++) {
      randomBytes[i] = Math.floor(Math.random() * 256);
    }
  }
  const salt = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const digest = await sha256Hex(`${salt}::${plainPassword}`);
  return `${salt}:${digest.toLowerCase()}`;
}

async function fetchDirectTeacherAccountsFromTable(): Promise<TeacherProfile[] | null> {
  if (!isSupabaseConfigured() || !hasActiveTeacherSession()) return null;
  try {
    const { data, error } = await (supabase.from('teacher_profiles' as any) as any)
      .select('id, name, title, email, username, role, is_active, last_login_at, subject, subject_code, default_classes, preferences, created_at, updated_at')
      .order('created_at', { ascending: true });
    if (error || !Array.isArray(data)) return null;
    const prevCached = new Map(getCachedProfiles().map((p) => [p.id, p]));
    const mapped = data.map((row: any) => {
      const prev = prevCached.get(row.id);
      return mapRawTeacherProfile({
        ...row,
        has_password:
          row.has_password !== undefined
            ? Boolean(row.has_password)
            : Boolean(prev?.has_password || row.last_login_at),
        must_change_password:
          row.must_change_password !== undefined
            ? Boolean(row.must_change_password)
            : Boolean(prev?.must_change_password),
      });
    });
    hasFetchedCloudProfiles = true;
    saveCachedProfiles(mapped);
    return mapped;
  } catch {
    return null;
  }
}

/**
 * Generates an unambiguous, human-readable 8-character temporary password (e.g. `ICM-4829`).
 */
export function generateTemporaryTeacherPassword(): string {
  const digits = '23456789';
  let suffix = '';
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(4);
    crypto.getRandomValues(buf);
    for (let i = 0; i < 4; i++) {
      suffix += digits[buf[i] % digits.length];
    }
  } else {
    for (let i = 0; i < 4; i++) {
      suffix += digits[Math.floor(Math.random() * digits.length)];
    }
  }
  return `ICM-${suffix}`;
}

/**
 * Lists all educator accounts (active and suspended) for the Admin dashboard.
 */
export async function adminListTeacherAccounts(
  masterPin?: string
): Promise<{ status: 'ok' | 'error'; profiles: TeacherProfile[]; error?: string }> {
  try {
    const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) =>
      setTimeout(() => resolve({ data: null, error: new Error('timeout') }), 6000)
    );
    const rpcPromise = (supabase as any).rpc('admin_list_teacher_accounts', {
      p_master_pin: (masterPin || '').trim() || null,
    });

    const res = (await Promise.race([rpcPromise, timeoutPromise])) as { data: any; error: any };
    if (res.error) {
      if (isRpcUnavailableError(res.error)) {
        const directRows = await fetchDirectTeacherAccountsFromTable();
        if (directRows) return { status: 'ok', profiles: directRows };

        const cached = getCachedProfiles();
        const fallback = cached.length > 0 ? cached : [DEFAULT_CHEMISTRY_PROFILE];
        if (cached.length === 0) saveCachedProfiles(fallback);
        return { status: 'ok', profiles: fallback };
      }
      return { status: 'error', profiles: getCachedProfiles(), error: res.error.message || 'Failed to load educator accounts.' };
    }

    const out = res.data || {};
    if (out.status === 'ok' && Array.isArray(out.profiles)) {
      const profiles = out.profiles.map(mapRawTeacherProfile);
      hasFetchedCloudProfiles = true;
      saveCachedProfiles(profiles);
      return { status: 'ok', profiles };
    }

    return {
      status: 'error',
      profiles: getCachedProfiles(),
      error: out.error || 'Unable to list educator accounts.',
    };
  } catch (err: any) {
    if (isRpcUnavailableError(err)) {
      const directRows = await fetchDirectTeacherAccountsFromTable();
      if (directRows) return { status: 'ok', profiles: directRows };

      const cached = getCachedProfiles();
      const fallback = cached.length > 0 ? cached : [DEFAULT_CHEMISTRY_PROFILE];
      return { status: 'ok', profiles: fallback };
    }
    return { status: 'error', profiles: getCachedProfiles(), error: err?.message || 'Unable to list educator accounts.' };
  }
}

/**
 * Centrally creates a new educator or admin account with login credentials without hijacking the admin's active workspace.
 */
export async function adminCreateTeacherAccount(payload: {
  masterPin?: string;
  name: string;
  title?: string;
  email?: string;
  username?: string;
  password: string;
  role?: 'teacher' | 'admin';
  subject?: string;
  subjectCode?: string;
  defaultClasses?: string[];
  mustChangePassword?: boolean;
}): Promise<TeacherAuthRpcResult> {
  const cleanName = (payload.name || '').trim();
  const cleanEmail = (payload.email || '').trim().toLowerCase();
  const cleanUsername = (payload.username || '').trim().toLowerCase();
  const cleanPassword = payload.password || '';
  const cleanRole: 'teacher' | 'admin' = payload.role === 'admin' ? 'admin' : 'teacher';
  const mustChange = payload.mustChangePassword ?? true;
  const cleanTitle = payload.title?.trim() || 'Dr.';
  const cleanSubject = payload.subject?.trim() || 'Chemistry';
  const cleanSubjectCode = payload.subjectCode !== undefined ? payload.subjectCode.trim() : '0620';
  const cleanClasses =
    payload.defaultClasses && payload.defaultClasses.length > 0
      ? payload.defaultClasses
      : ['10-A', '10-B'];

  if (!cleanName) {
    return { status: 'error', error: 'Educator full display name is required.' };
  }
  if (!cleanUsername && !cleanEmail) {
    return { status: 'error', error: 'Please provide a username or school email address.' };
  }
  if (cleanPassword.trim().length < 6) {
    return { status: 'error', error: 'Initial password must be at least 6 characters.' };
  }

  const runCreateFallback = async (): Promise<TeacherAuthRpcResult> => {
    if (isSupabaseConfigured() && hasActiveTeacherSession()) {
      try {
        const passwordHash = await computeSaltedTeacherPasswordHash(cleanPassword);
        const { data, error } = await (supabase.from('teacher_profiles' as any) as any)
          .insert({
            name: cleanName,
            title: cleanTitle,
            email: cleanEmail || null,
            username: cleanUsername || null,
            password_hash: passwordHash,
            role: cleanRole,
            subject: cleanSubject,
            subject_code: cleanSubjectCode,
            default_classes: cleanClasses,
            is_active: true,
          })
          .select('id, name, title, email, username, role, is_active, last_login_at, subject, subject_code, default_classes, preferences, created_at, updated_at')
          .single();

        if (error) {
          if (String(error.code) === '23505' || /unique|duplicate/i.test(String(error.message || ''))) {
            return {
              status: 'error',
              error: 'An educator account with that email or username already exists.',
            };
          }
          return {
            status: 'error',
            error: error.message || 'Could not create educator account in Supabase.',
          };
        }

        if (data) {
          const created = mapRawTeacherProfile({
            ...data,
            has_password: true,
            must_change_password: false,
          });
          const existing = getCachedProfiles();
          saveCachedProfiles([...existing.filter((p) => p.id !== created.id), created]);
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('teacher_profile_updated', { detail: { profile: created } }));
          }
          return { status: 'ok', profile: created };
        }
      } catch (err: any) {
        return { status: 'error', error: err?.message || 'Could not create educator account.' };
      }
    }

    return createLocalAdminTeacherFallback({
      name: cleanName,
      title: cleanTitle,
      email: cleanEmail || null,
      username: cleanUsername || null,
      role: cleanRole,
      subject: cleanSubject,
      subjectCode: cleanSubjectCode,
      defaultClasses: cleanClasses,
      mustChangePassword: mustChange,
    });
  };

  try {
    const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) =>
      setTimeout(() => resolve({ data: null, error: new Error('timeout') }), 7000)
    );
    const rpcPromise = (supabase as any).rpc('admin_create_teacher_account', {
      p_master_pin: (payload.masterPin || '').trim(),
      p_name: cleanName,
      p_title: cleanTitle,
      p_email: cleanEmail || null,
      p_username: cleanUsername || null,
      p_password: cleanPassword,
      p_role: cleanRole,
      p_subject: cleanSubject,
      p_subject_code: cleanSubjectCode,
      p_default_classes: cleanClasses,
      p_must_change_password: mustChange,
    });

    const res = (await Promise.race([rpcPromise, timeoutPromise])) as { data: any; error: any };
    if (res.error) {
      if (isRpcUnavailableError(res.error)) {
        return await runCreateFallback();
      }
      return { status: 'error', error: res.error.message || 'Failed to create educator account.' };
    }

    const out = res.data || {};
    if (out.status === 'ok' && out.profile) {
      const created = mapRawTeacherProfile(out.profile);
      const existing = getCachedProfiles();
      const merged = [...existing.filter((p) => p.id !== created.id), created];
      saveCachedProfiles(merged);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('teacher_profile_updated', { detail: { profile: created } }));
      }
      return { status: 'ok', profile: created };
    }

    return {
      status: 'error',
      error: out.error || 'Could not create educator account.',
    };
  } catch (err: any) {
    if (isRpcUnavailableError(err)) {
      return await runCreateFallback();
    }
    return { status: 'error', error: err?.message || 'Failed to create educator account.' };
  }
}

function createLocalAdminTeacherFallback(params: {
  name: string;
  title: string;
  email: string | null;
  username: string | null;
  role: 'teacher' | 'admin';
  subject: string;
  subjectCode: string;
  defaultClasses: string[];
  mustChangePassword: boolean;
}): TeacherAuthRpcResult {
  const existing = getCachedProfiles();
  const duplicate = existing.find(
    (p) =>
      (params.email && (p.email || '').toLowerCase() === params.email) ||
      (params.username && (p.username || '').toLowerCase() === params.username)
  );
  if (duplicate) {
    return {
      status: 'error',
      error: 'An educator account with that email or username already exists.',
    };
  }

  const newId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'tp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);

  const created = mapRawTeacherProfile({
    id: newId,
    name: params.name,
    title: params.title,
    email: params.email,
    username: params.username,
    role: params.role,
    is_active: true,
    has_password: true,
    must_change_password: params.mustChangePassword,
    last_login_at: null,
    subject: params.subject,
    subject_code: params.subjectCode,
    default_classes: params.defaultClasses,
    preferences: {
      autoEnablePeriodicTable: params.subject.toLowerCase() === 'chemistry',
      defaultCalculator: 'scientific',
      showOtherSubjects: false,
      defaultExamDurationMinutes: 45,
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  saveCachedProfiles([...existing, created]);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('teacher_profile_updated', { detail: { profile: created } }));
  }
  return { status: 'ok', profile: created };
}

/**
 * Updates an educator account's metadata, role, teaching cohorts, or active status.
 */
export async function adminUpdateTeacherAccount(payload: {
  masterPin?: string;
  teacherId: string;
  name?: string;
  title?: string;
  email?: string;
  username?: string;
  role?: 'teacher' | 'admin';
  subject?: string;
  subjectCode?: string;
  defaultClasses?: string[];
  isActive?: boolean;
}): Promise<TeacherAuthRpcResult> {
  if (!payload.teacherId) {
    return { status: 'error', error: 'Teacher ID is required.' };
  }

  if (!isUuidString(payload.teacherId)) {
    return updateLocalAdminTeacherFallback(payload);
  }

  const runDirectUpdateFallback = async (): Promise<TeacherAuthRpcResult> => {
    if (isSupabaseConfigured() && hasActiveTeacherSession()) {
      try {
        const patch: Record<string, any> = { updated_at: new Date().toISOString() };
        if (payload.name !== undefined && payload.name.trim()) patch.name = payload.name.trim();
        if (payload.title !== undefined) patch.title = payload.title.trim() || null;
        if (payload.email !== undefined) patch.email = payload.email.trim().toLowerCase() || null;
        if (payload.username !== undefined) patch.username = payload.username.trim().toLowerCase() || null;
        if (payload.role !== undefined) patch.role = payload.role === 'admin' ? 'admin' : 'teacher';
        if (payload.subject !== undefined && payload.subject.trim()) patch.subject = payload.subject.trim();
        if (payload.subjectCode !== undefined) patch.subject_code = payload.subjectCode.trim();
        if (payload.defaultClasses && payload.defaultClasses.length > 0) patch.default_classes = payload.defaultClasses;
        if (payload.isActive !== undefined) patch.is_active = payload.isActive;

        const { data, error } = await (supabase.from('teacher_profiles' as any) as any)
          .update(patch)
          .eq('id', payload.teacherId)
          .select('id, name, title, email, username, role, is_active, last_login_at, subject, subject_code, default_classes, preferences, created_at, updated_at')
          .single();

        if (error) {
          if (String(error.code) === '23505' || /unique|duplicate/i.test(String(error.message || ''))) {
            return {
              status: 'error',
              error: 'Another educator account already uses that email or username.',
            };
          }
          return {
            status: 'error',
            error: error.message || 'Failed to save educator changes in Supabase.',
          };
        }

        if (data) {
          const prev = getCachedProfiles().find((p) => p.id === data.id);
          const updated = mapRawTeacherProfile({
            ...data,
            has_password: Boolean(prev?.has_password || data.last_login_at),
            must_change_password: Boolean(prev?.must_change_password),
          });
          const existing = getCachedProfiles();
          saveCachedProfiles(existing.map((p) => (p.id === updated.id ? updated : p)));
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('teacher_profile_updated', { detail: { profile: updated } }));
          }
          return { status: 'ok', profile: updated };
        }
      } catch (err: any) {
        return { status: 'error', error: err?.message || 'Failed to update educator account.' };
      }
    }

    return updateLocalAdminTeacherFallback(payload);
  };

  try {
    const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) =>
      setTimeout(() => resolve({ data: null, error: new Error('timeout') }), 7000)
    );
    const rpcPromise = (supabase as any).rpc('admin_update_teacher_account', {
      p_master_pin: (payload.masterPin || '').trim() || null,
      p_teacher_id: payload.teacherId,
      p_name: payload.name !== undefined ? payload.name.trim() : null,
      p_title: payload.title !== undefined ? payload.title.trim() : null,
      p_email: payload.email !== undefined ? payload.email.trim().toLowerCase() : null,
      p_username: payload.username !== undefined ? payload.username.trim().toLowerCase() : null,
      p_role: payload.role !== undefined ? payload.role : null,
      p_subject: payload.subject !== undefined ? payload.subject.trim() : null,
      p_subject_code: payload.subjectCode !== undefined ? payload.subjectCode.trim() : null,
      p_default_classes:
        payload.defaultClasses && payload.defaultClasses.length > 0 ? payload.defaultClasses : null,
      p_is_active: payload.isActive !== undefined ? payload.isActive : null,
    });

    const res = (await Promise.race([rpcPromise, timeoutPromise])) as { data: any; error: any };
    if (res.error) {
      if (isRpcUnavailableError(res.error)) {
        return await runDirectUpdateFallback();
      }
      return { status: 'error', error: res.error.message || 'Failed to update educator account.' };
    }

    const out = res.data || {};
    if (out.status === 'ok' && out.profile) {
      const updated = mapRawTeacherProfile(out.profile);
      const existing = getCachedProfiles();
      saveCachedProfiles(existing.map((p) => (p.id === updated.id ? updated : p)));
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('teacher_profile_updated', { detail: { profile: updated } }));
      }
      return { status: 'ok', profile: updated };
    }

    return {
      status: 'error',
      error: out.error || 'Could not update educator account.',
    };
  } catch (err: any) {
    if (isRpcUnavailableError(err)) {
      return await runDirectUpdateFallback();
    }
    return { status: 'error', error: err?.message || 'Failed to update educator account.' };
  }
}

function updateLocalAdminTeacherFallback(payload: {
  teacherId: string;
  name?: string;
  title?: string;
  email?: string;
  username?: string;
  role?: 'teacher' | 'admin';
  subject?: string;
  subjectCode?: string;
  defaultClasses?: string[];
  isActive?: boolean;
}): TeacherAuthRpcResult {
  const existing = getCachedProfiles();
  const target = existing.find((p) => p.id === payload.teacherId);
  if (!target) {
    return { status: 'error', error: 'Educator account not found.' };
  }

  const nextEmail = payload.email !== undefined ? payload.email.trim().toLowerCase() || null : target.email ?? null;
  const nextUsername =
    payload.username !== undefined ? payload.username.trim().toLowerCase() || null : target.username ?? null;

  const conflict = existing.find(
    (p) =>
      p.id !== payload.teacherId &&
      ((nextEmail && (p.email || '').toLowerCase() === nextEmail) ||
        (nextUsername && (p.username || '').toLowerCase() === nextUsername))
  );
  if (conflict) {
    return { status: 'error', error: 'Another educator account already uses that email or username.' };
  }

  const updated = mapRawTeacherProfile({
    ...target,
    name: payload.name !== undefined && payload.name.trim() ? payload.name.trim() : target.name,
    title: payload.title !== undefined ? payload.title.trim() || undefined : target.title,
    email: nextEmail,
    username: nextUsername,
    role: payload.role !== undefined ? (payload.role === 'admin' ? 'admin' : 'teacher') : target.role,
    subject: payload.subject !== undefined && payload.subject.trim() ? payload.subject.trim() : target.subject,
    subject_code: payload.subjectCode !== undefined ? payload.subjectCode.trim() : target.subject_code,
    default_classes:
      payload.defaultClasses && payload.defaultClasses.length > 0
        ? payload.defaultClasses
        : target.default_classes,
    is_active: payload.isActive !== undefined ? payload.isActive : target.is_active !== false,
    updated_at: new Date().toISOString(),
  });

  saveCachedProfiles(existing.map((p) => (p.id === updated.id ? updated : p)));
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('teacher_profile_updated', { detail: { profile: updated } }));
  }
  return { status: 'ok', profile: updated };
}

/**
 * Centrally resets an educator's password without switching the Admin's own active workspace.
 */
export async function adminResetTeacherPassword(payload: {
  masterPin?: string;
  teacherId: string;
  newPassword: string;
  mustChangePassword?: boolean;
}): Promise<TeacherAuthRpcResult> {
  if (!payload.teacherId) {
    return { status: 'error', error: 'Teacher ID is required.' };
  }
  if ((payload.newPassword || '').trim().length < 6) {
    return { status: 'error', error: 'New password must be at least 6 characters.' };
  }

  const mustChange = payload.mustChangePassword ?? true;

  const runDirectResetFallback = async (): Promise<TeacherAuthRpcResult> => {
    if (isSupabaseConfigured() && hasActiveTeacherSession() && isUuidString(payload.teacherId)) {
      try {
        const passwordHash = await computeSaltedTeacherPasswordHash(payload.newPassword);
        const { data, error } = await (supabase.from('teacher_profiles' as any) as any)
          .update({
            password_hash: passwordHash,
            is_active: true,
            updated_at: new Date().toISOString(),
          })
          .eq('id', payload.teacherId)
          .select('id, name, title, email, username, role, is_active, last_login_at, subject, subject_code, default_classes, preferences, created_at, updated_at')
          .single();

        if (error) {
          return { status: 'error', error: error.message || 'Password reset failed in Supabase.' };
        }
        if (data) {
          const updated = mapRawTeacherProfile({
            ...data,
            has_password: true,
            must_change_password: false,
          });
          const existing = getCachedProfiles();
          saveCachedProfiles(existing.map((p) => (p.id === updated.id ? updated : p)));
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('teacher_profile_updated', { detail: { profile: updated } }));
          }
          return { status: 'ok', profile: updated };
        }
      } catch (err: any) {
        return { status: 'error', error: err?.message || 'Password reset failed.' };
      }
    }

    const existing = getCachedProfiles();
    const target = existing.find((p) => p.id === payload.teacherId);
    if (!target) return { status: 'error', error: 'Educator account not found.' };
    const updated = mapRawTeacherProfile({
      ...target,
      has_password: true,
      must_change_password: mustChange,
      is_active: true,
      updated_at: new Date().toISOString(),
    });
    saveCachedProfiles(existing.map((p) => (p.id === updated.id ? updated : p)));
    return { status: 'ok', profile: updated };
  };

  if (!isUuidString(payload.teacherId)) {
    return await runDirectResetFallback();
  }

  try {
    const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) =>
      setTimeout(() => resolve({ data: null, error: new Error('timeout') }), 7000)
    );
    const rpcPromise = (supabase as any).rpc('admin_reset_teacher_password', {
      p_master_pin: (payload.masterPin || '').trim() || null,
      p_teacher_id: payload.teacherId,
      p_new_password: payload.newPassword,
      p_must_change_password: mustChange,
    });

    const res = (await Promise.race([rpcPromise, timeoutPromise])) as { data: any; error: any };
    if (res.error) {
      if (isRpcUnavailableError(res.error)) {
        return await runDirectResetFallback();
      }
      return { status: 'error', error: res.error.message || 'Password reset failed.' };
    }

    const out = res.data || {};
    if (out.status === 'ok' && out.profile) {
      const updated = mapRawTeacherProfile(out.profile);
      const existing = getCachedProfiles();
      saveCachedProfiles(existing.map((p) => (p.id === updated.id ? updated : p)));
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('teacher_profile_updated', { detail: { profile: updated } }));
      }
      return { status: 'ok', profile: updated };
    }

    return {
      status: 'error',
      error: out.error || 'Could not reset educator password.',
    };
  } catch (err: any) {
    if (isRpcUnavailableError(err)) {
      return await runDirectResetFallback();
    }
    return { status: 'error', error: err?.message || 'Password reset failed.' };
  }
}

/**
 * Deletes an educator account and revokes its sessions.
 */
export async function adminDeleteTeacherAccount(
  teacherId: string,
  masterPin?: string
): Promise<{ status: 'ok' | 'error'; error?: string }> {
  if (!teacherId) {
    return { status: 'error', error: 'Teacher ID is required.' };
  }

  const runDirectDeleteFallback = async (): Promise<{ status: 'ok' | 'error'; error?: string }> => {
    if (isSupabaseConfigured() && hasActiveTeacherSession() && isUuidString(teacherId)) {
      try {
        const { error } = await (supabase.from('teacher_profiles' as any) as any)
          .delete()
          .eq('id', teacherId);
        if (error) {
          return { status: 'error', error: error.message || 'Failed to delete educator account.' };
        }
      } catch (err: any) {
        return { status: 'error', error: err?.message || 'Failed to delete educator account.' };
      }
    }
    const existing = getCachedProfiles();
    if (!existing.some((p) => p.id === teacherId) && !(isSupabaseConfigured() && hasActiveTeacherSession())) {
      return { status: 'error', error: 'Educator account not found.' };
    }
    saveCachedProfiles(existing.filter((p) => p.id !== teacherId));
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('teacher_profile_updated', { detail: { deletedId: teacherId } }));
    }
    return { status: 'ok' };
  };

  if (!isUuidString(teacherId)) {
    return await runDirectDeleteFallback();
  }

  try {
    const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) =>
      setTimeout(() => resolve({ data: null, error: new Error('timeout') }), 7000)
    );
    const rpcPromise = (supabase as any).rpc('admin_delete_teacher_account', {
      p_master_pin: (masterPin || '').trim() || null,
      p_teacher_id: teacherId,
    });

    const res = (await Promise.race([rpcPromise, timeoutPromise])) as { data: any; error: any };
    if (res.error) {
      if (isRpcUnavailableError(res.error)) {
        return await runDirectDeleteFallback();
      }
      return { status: 'error', error: res.error.message || 'Failed to delete educator account.' };
    }

    const out = res.data || {};
    if (out.status === 'ok') {
      const existing = getCachedProfiles();
      saveCachedProfiles(existing.filter((p) => p.id !== teacherId));
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('teacher_profile_updated', { detail: { deletedId: teacherId } }));
      }
      return { status: 'ok' };
    }

    return {
      status: 'error',
      error: out.error || 'Could not delete educator account.',
    };
  } catch (err: any) {
    if (isRpcUnavailableError(err)) {
      return await runDirectDeleteFallback();
    }
    return { status: 'error', error: err?.message || 'Failed to delete educator account.' };
  }
}

/**
 * Allows the currently signed-in educator to change their own password and clear `must_change_password`.
 */
export async function changeOwnTeacherPassword(
  currentPassword: string,
  newPassword: string,
  teacherId?: string
): Promise<TeacherAuthRpcResult> {
  if ((newPassword || '').trim().length < 6) {
    return { status: 'error', error: 'New password must be at least 6 characters.' };
  }

  try {
    const timeoutPromise = new Promise<{ data: null; error: Error }>((resolve) =>
      setTimeout(() => resolve({ data: null, error: new Error('timeout') }), 7000)
    );
    const rpcPromise = (supabase as any).rpc('change_own_teacher_password', {
      p_current_password: currentPassword,
      p_new_password: newPassword,
      p_teacher_id: teacherId || null,
    });

    const res = (await Promise.race([rpcPromise, timeoutPromise])) as { data: any; error: any };
    if (res.error) {
      if (isRpcUnavailableError(res.error)) {
        const targetId = teacherId || getActiveTeacherProfileId();
        const existing = getCachedProfiles();
        const target = existing.find((p) => p.id === targetId);
        if (!target) {
          return { status: 'error', error: 'Active educator profile not found.' };
        }
        const updated = mapRawTeacherProfile({
          ...target,
          has_password: true,
          must_change_password: false,
          updated_at: new Date().toISOString(),
        });
        saveCachedProfiles(existing.map((p) => (p.id === updated.id ? updated : p)));
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('teacher_profile_updated', { detail: { profile: updated } }));
        }
        return { status: 'ok', profile: updated };
      }
      return { status: 'error', error: res.error.message || 'Password change failed.' };
    }

    const out = res.data || {};
    if (out.status === 'ok' && out.profile) {
      const updated = mapRawTeacherProfile(out.profile);
      const existing = getCachedProfiles();
      saveCachedProfiles(existing.map((p) => (p.id === updated.id ? updated : p)));
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('teacher_profile_updated', { detail: { profile: updated } }));
      }
      return { status: 'ok', profile: updated };
    }

    return {
      status: 'error',
      error: out.error || 'Could not change password.',
    };
  } catch (err: any) {
    if (isRpcUnavailableError(err)) {
      const targetId = teacherId || getActiveTeacherProfileId();
      const existing = getCachedProfiles();
      const target = existing.find((p) => p.id === targetId);
      if (target) {
        const updated = mapRawTeacherProfile({
          ...target,
          has_password: true,
          must_change_password: false,
          updated_at: new Date().toISOString(),
        });
        saveCachedProfiles(existing.map((p) => (p.id === updated.id ? updated : p)));
        return { status: 'ok', profile: updated };
      }
    }
    return { status: 'error', error: err?.message || 'Password change failed.' };
  }
}
