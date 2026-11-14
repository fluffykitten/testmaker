// ─── Teacher Profile Service ──────────────────────────────────────────────────
// Manages cloud-synced and locally-cached teacher profiles, unified educator
// login/registration RPCs, subject isolation, and 4-digit PIN helpers.

import { supabase, TEACHER_SESSION_TOKEN_KEY, hasActiveTeacherSession } from '../lib/supabase';
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
    has_password: Boolean(row.has_password),
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
        .select('id, name, title, email, username, role, is_active, last_login_at, subject, subject_code, default_classes, preferences, created_at, updated_at')
        .order('created_at', { ascending: true });

      const res = (await Promise.race([queryPromise, timeoutPromise])) as {
        data: any[] | null;
        error: any;
      };

      if (!res.error && res.data && res.data.length > 0) {
        const profiles = res.data.map(mapRawTeacherProfile);
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
