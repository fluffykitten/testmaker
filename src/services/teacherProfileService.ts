// ─── Teacher Profile Service ──────────────────────────────────────────────────
// Manages cloud-synced and locally-cached teacher profiles, subject isolation,
// and optional 4-digit personal PIN verification.

import { supabase } from '../lib/supabase';
import type { TeacherProfile, TeacherPreferences } from '../types/database';
import { sha256Hex, verifyPinAgainstHashOrPlain } from '../utils/cryptoUtils';

export const ACTIVE_PROFILE_KEY = 'testmaker_active_teacher_profile_id';
export const CACHED_PROFILES_KEY = 'testmaker_cached_teacher_profiles';

export const DEFAULT_CHEMISTRY_PROFILE: TeacherProfile = {
  id: 'chem-default-budi',
  name: 'Dr. Budi Santoso',
  title: 'Dr.',
  subject: 'Chemistry',
  subject_code: '0620',
  pin_hash: null, // PIN-free by default
  default_classes: ['10-A', '11-A', '12-A'],
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

function getCachedProfiles(): TeacherProfile[] {
  try {
    const raw = localStorage.getItem(CACHED_PROFILES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCachedProfiles(profiles: TeacherProfile[]): void {
  try {
    inMemoryProfiles = profiles;
    localStorage.setItem(CACHED_PROFILES_KEY, JSON.stringify(profiles));
  } catch (err) {
    console.warn('Failed to save teacher profiles to localStorage:', err);
  }
}

/**
 * Retrieves all teacher profiles from Supabase, falling back to local cache if offline.
 */
export async function fetchTeacherProfiles(): Promise<TeacherProfile[]> {
  if (inMemoryProfiles && inMemoryProfiles.length > 0) {
    return inMemoryProfiles;
  }
  try {
    const timeoutPromise = new Promise<{ data: null; error: string }>((resolve) =>
      setTimeout(() => resolve({ data: null, error: 'timeout' }), 4000)
    );

    const queryPromise = (supabase.from('teacher_profiles' as any) as any)
      .select('*')
      .order('created_at', { ascending: true });

    const res = (await Promise.race([queryPromise, timeoutPromise])) as {
      data: any[] | null;
      error: any;
    };

    if (!res.error && res.data && res.data.length > 0) {
      const profiles: TeacherProfile[] = res.data.map((row) => ({
        id: row.id,
        name: row.name,
        title: row.title || undefined,
        subject: row.subject || 'Chemistry',
        subject_code: row.subject_code || '0620',
        pin_hash: row.pin_hash || null,
        default_classes: Array.isArray(row.default_classes) ? row.default_classes : ['10-A', '11-A'],
        preferences: (row.preferences as TeacherPreferences) || {
          autoEnablePeriodicTable: true,
          defaultCalculator: 'scientific',
          showOtherSubjects: false,
        },
        created_at: row.created_at || new Date().toISOString(),
        updated_at: row.updated_at || new Date().toISOString(),
      }));

      saveCachedProfiles(profiles);
      return profiles;
    }
  } catch (err) {
    console.warn('Failed to query teacher profiles from Supabase, using local cache:', err);
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
    subject_code: string;
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
    subject_code: payload.subject_code.trim() || '0620',
    pin_hash: pinHash,
    default_classes: payload.default_classes && payload.default_classes.length > 0
      ? payload.default_classes
      : ['10-A', '11-A'],
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
