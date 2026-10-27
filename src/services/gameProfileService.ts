import { supabase } from '../lib/supabase';
import type {
  GameProfile,
  GameAvatarConfig,
  GameMatchHistoryItem,
  TopicMasteryRecord,
} from '../types/database';

export const ACTIVE_GAME_PROFILE_KEY = 'testmaker_active_game_profile';
export const CACHED_GAME_PROFILES_KEY = 'testmaker_cached_game_profiles';

export const DEFAULT_AVATAR: GameAvatarConfig = {
  skin: '#ffd8b3',
  eyes: 'curious',
  hair: 'curly_brunette',
  outfit: 'lab_coat',
  prop: 'erlenmeyer_flask',
  aura: 'none',
};

// SHA-256 client helper for 4-digit PIN hashing
async function sha256Hex(plainText: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(plainText);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let hash = 0;
  for (let i = 0; i < plainText.length; i++) {
    hash = (hash << 5) - hash + plainText.charCodeAt(i);
    hash |= 0;
  }
  return 'fallback_' + Math.abs(hash).toString(16);
}

// In-memory module cache
let inMemoryActiveProfile: GameProfile | null = null;
let inMemoryProfiles: GameProfile[] | null = null;

export function getActiveGameProfile(): GameProfile | null {
  if (inMemoryActiveProfile) return inMemoryActiveProfile;
  try {
    const raw = localStorage.getItem(ACTIVE_GAME_PROFILE_KEY);
    if (raw) {
      inMemoryActiveProfile = JSON.parse(raw);
      return inMemoryActiveProfile;
    }
  } catch {
    // ignore
  }
  return null;
}

export function setActiveGameProfile(profile: GameProfile | null): void {
  inMemoryActiveProfile = profile;
  try {
    if (profile) {
      localStorage.setItem(ACTIVE_GAME_PROFILE_KEY, JSON.stringify(profile));
    } else {
      localStorage.removeItem(ACTIVE_GAME_PROFILE_KEY);
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('game_profile_changed', { detail: { profile } })
      );
    }
  } catch (err) {
    console.warn('Failed to set active game profile in storage:', err);
  }
}

export function getCachedGameProfiles(): GameProfile[] {
  if (inMemoryProfiles) return inMemoryProfiles;
  try {
    const raw = localStorage.getItem(CACHED_GAME_PROFILES_KEY);
    if (raw) {
      inMemoryProfiles = JSON.parse(raw);
      return inMemoryProfiles || [];
    }
  } catch {
    // ignore
  }
  return [];
}

export function saveCachedGameProfiles(profiles: GameProfile[]): void {
  inMemoryProfiles = profiles;
  try {
    localStorage.setItem(CACHED_GAME_PROFILES_KEY, JSON.stringify(profiles));
  } catch (err) {
    console.warn('Failed to cache game profiles in localStorage:', err);
  }
}

/**
 * Log in to an existing Creative Mode student profile via handle & 4-digit PIN.
 */
export async function loginGameProfile(
  handle: string,
  pin: string
): Promise<{ success: boolean; profile?: GameProfile; error?: string }> {
  const cleanHandle = (handle || '').trim();
  const cleanPin = (pin || '').trim();

  if (!cleanHandle) {
    return { success: false, error: 'Please enter your Creative handle.' };
  }
  if (cleanPin.length !== 4) {
    return { success: false, error: 'PIN must be exactly 4 digits.' };
  }

  const pinHash = await sha256Hex(cleanPin);

  // 1. Try Supabase cloud RPC
  try {
    const { data, error } = await (supabase.rpc as any)('auth_game_profile', {
      p_handle: cleanHandle,
      p_pin_hash: pinHash,
    });

    if (!error && data?.success && data.profile) {
      const profile = data.profile as GameProfile;
      setActiveGameProfile(profile);

      const cached = getCachedGameProfiles();
      const updated = [...cached.filter((p) => p.id !== profile.id), profile];
      saveCachedGameProfiles(updated);

      return { success: true, profile };
    } else if (data?.error) {
      return { success: false, error: data.error };
    }
  } catch (err) {
    console.warn('Supabase auth_game_profile failed, attempting local cache check:', err);
  }

  // 2. Fallback to local storage cache
  const cachedList = getCachedGameProfiles();
  const matched = cachedList.find(
    (p) => p.handle.toLowerCase() === cleanHandle.toLowerCase()
  );

  if (!matched) {
    return {
      success: false,
      error: `Creative handle "${cleanHandle}" was not found. Please create a new profile.`,
    };
  }

  if (matched.pin_hash !== pinHash) {
    return { success: false, error: 'Incorrect 4-digit PIN for this handle.' };
  }

  setActiveGameProfile(matched);
  return { success: true, profile: matched };
}

/**
 * Register a new Creative Mode profile with handle, 4-digit PIN, cohort, and custom avatar.
 */
export async function registerGameProfile(payload: {
  handle: string;
  pin: string;
  realName?: string;
  studentClass: string;
  avatar?: GameAvatarConfig;
}): Promise<GameProfile> {
  const cleanHandle = payload.handle.trim();
  const cleanPin = payload.pin.trim();

  if (!cleanHandle) throw new Error('Creative handle is required');
  if (cleanPin.length !== 4) throw new Error('PIN must be 4 digits');

  const pinHash = await sha256Hex(cleanPin);
  const avatar = payload.avatar || DEFAULT_AVATAR;

  const newId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'gp_' + Date.now().toString(36);

  const newProfile: GameProfile = {
    id: newId,
    handle: cleanHandle,
    real_name: payload.realName?.trim() || null,
    class: payload.studentClass.trim() || '10-A',
    pin_hash: pinHash,
    avatar,
    coins: 50,
    xp: 0,
    level: 1,
    unlocked_items: ['default_lab_coat', 'erlenmeyer_flask'],
    topic_mastery: {},
    match_history: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Try saving to Supabase
  try {
    const { data, error } = await (supabase.from('game_profiles' as any) as any)
      .insert({
        id: newProfile.id,
        handle: newProfile.handle,
        real_name: newProfile.real_name,
        class: newProfile.class,
        pin_hash: newProfile.pin_hash,
        avatar: newProfile.avatar,
        coins: newProfile.coins,
        xp: newProfile.xp,
        level: newProfile.level,
        unlocked_items: newProfile.unlocked_items,
        topic_mastery: newProfile.topic_mastery,
        match_history: newProfile.match_history,
      })
      .select('*')
      .single();

    if (!error && data) {
      newProfile.id = data.id;
    }
  } catch (err) {
    console.warn('Failed to insert game profile into Supabase, saving to local cache:', err);
  }

  const existing = getCachedGameProfiles();
  const updated = [...existing.filter((p) => p.id !== newProfile.id), newProfile];
  saveCachedGameProfiles(updated);
  setActiveGameProfile(newProfile);

  return newProfile;
}

/**
 * Updates avatar customization and unlocks purchased cosmetic items.
 */
export async function updateGameAvatar(
  profileId: string,
  avatar: GameAvatarConfig,
  purchasedItem?: string,
  cost?: number
): Promise<GameProfile> {
  const current = getActiveGameProfile();
  const baseProfile =
    current && current.id === profileId
      ? current
      : getCachedGameProfiles().find((p) => p.id === profileId);

  if (!baseProfile) {
    throw new Error('Profile not found');
  }

  const itemCost = Math.max(0, cost || 0);
  if (itemCost > baseProfile.coins) {
    throw new Error('Insufficient coins for this cosmetic upgrade');
  }

  const unlocked = new Set(baseProfile.unlocked_items || []);
  if (purchasedItem) {
    unlocked.add(purchasedItem);
  }

  const updatedProfile: GameProfile = {
    ...baseProfile,
    avatar,
    coins: baseProfile.coins - itemCost,
    unlocked_items: Array.from(unlocked),
    updated_at: new Date().toISOString(),
  };

  try {
    await (supabase.from('game_profiles' as any) as any)
      .update({
        avatar: updatedProfile.avatar,
        coins: updatedProfile.coins,
        unlocked_items: updatedProfile.unlocked_items,
        updated_at: updatedProfile.updated_at,
      })
      .eq('id', profileId);
  } catch (err) {
    console.warn('Supabase update failed for avatar, updating locally:', err);
  }

  const cached = getCachedGameProfiles();
  const updatedList = cached.map((p) => (p.id === profileId ? updatedProfile : p));
  saveCachedGameProfiles(updatedList);
  setActiveGameProfile(updatedProfile);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('game_profile_updated', { detail: { profile: updatedProfile } })
    );
  }

  return updatedProfile;
}

/**
 * Award match rewards (coins, XP, level) and update topic mastery & recent match history.
 */
export async function awardGameMatchRewards(
  profileId: string,
  matchData: {
    coins: number;
    xp: number;
    subject: string;
    topicResults: { topic: string; correct: boolean }[];
    summary: Omit<GameMatchHistoryItem, 'timestamp'>;
  }
): Promise<GameProfile> {
  const current = getActiveGameProfile();
  const baseProfile =
    current && current.id === profileId
      ? current
      : getCachedGameProfiles().find((p) => p.id === profileId);

  if (!baseProfile) {
    throw new Error('Profile not found');
  }

  const matchSummary: GameMatchHistoryItem = {
    ...matchData.summary,
    timestamp: Date.now(),
  };

  // 1. Try Supabase RPC first
  try {
    const { data, error } = await (supabase.rpc as any)('sync_game_match_rewards', {
      p_profile_id: profileId,
      p_coins: Math.max(0, matchData.coins),
      p_xp: Math.max(0, matchData.xp),
      p_subject: matchData.subject || 'Chemistry',
      p_topic_results: matchData.topicResults,
      p_match_summary: matchSummary,
    });

    if (!error && data?.success && data.profile) {
      const updated = data.profile as GameProfile;
      setActiveGameProfile(updated);
      const cached = getCachedGameProfiles();
      saveCachedGameProfiles(cached.map((p) => (p.id === profileId ? updated : p)));
      return updated;
    }
  } catch (err) {
    console.warn('Supabase sync_game_match_rewards failed, calculating locally:', err);
  }

  // 2. Client-side local calculation fallback
  const newXp = baseProfile.xp + Math.max(0, matchData.xp);
  const newLevel = 1 + Math.floor(newXp / 150);
  const newCoins = baseProfile.coins + Math.max(0, matchData.coins);

  const subject = matchData.subject || 'Chemistry';
  const mastery = { ...(baseProfile.topic_mastery || {}) };
  const subjMastery: Record<string, TopicMasteryRecord> = { ...(mastery[subject] || {}) };

  for (const item of matchData.topicResults) {
    const topic = item.topic?.trim() || 'General';
    const curr = subjMastery[topic] || { correct: 0, total: 0, masteryPct: 0, lastPracticed: '' };
    const cCorrect = curr.correct + (item.correct ? 1 : 0);
    const cTotal = curr.total + 1;
    subjMastery[topic] = {
      correct: cCorrect,
      total: cTotal,
      masteryPct: Math.round((cCorrect / cTotal) * 100),
      lastPracticed: new Date().toISOString(),
    };
  }

  mastery[subject] = subjMastery;

  const history = [matchSummary, ...(baseProfile.match_history || [])].slice(0, 20);

  const localUpdated: GameProfile = {
    ...baseProfile,
    coins: newCoins,
    xp: newXp,
    level: newLevel,
    topic_mastery: mastery,
    match_history: history,
    updated_at: new Date().toISOString(),
  };

  const cached = getCachedGameProfiles();
  const updatedList = cached.map((p) => (p.id === profileId ? localUpdated : p));
  saveCachedGameProfiles(updatedList);
  setActiveGameProfile(localUpdated);

  return localUpdated;
}

/**
 * Updates a student's cohort class.
 */
export async function updateStudentClass(
  profileId: string,
  newClass: string
): Promise<GameProfile> {
  const cleanClass = (newClass || '').trim();
  if (!cleanClass) {
    throw new Error('Class/cohort name is required');
  }

  const current = getActiveGameProfile();
  const baseProfile =
    current && current.id === profileId
      ? current
      : getCachedGameProfiles().find((p) => p.id === profileId);

  if (!baseProfile) {
    throw new Error('Profile not found');
  }

  const updatedProfile: GameProfile = {
    ...baseProfile,
    class: cleanClass,
    updated_at: new Date().toISOString(),
  };

  try {
    await (supabase.from('game_profiles' as any) as any)
      .update({
        class: updatedProfile.class,
        updated_at: updatedProfile.updated_at,
      })
      .eq('id', profileId);
  } catch (err) {
    console.warn('Supabase update failed for student class, updating locally:', err);
  }

  const cached = getCachedGameProfiles();
  const updatedList = cached.map((p) => (p.id === profileId ? updatedProfile : p));
  saveCachedGameProfiles(updatedList);
  setActiveGameProfile(updatedProfile);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('game_profile_updated', { detail: { profile: updatedProfile } })
    );
  }

  return updatedProfile;
}

/**
 * Fetch profiles for a cohort (for Teacher Creative Directory analytics).
 */
export async function fetchClassGameProfiles(studentClass?: string): Promise<GameProfile[]> {
  try {
    let query = (supabase.from('game_profiles' as any) as any)
      .select('*')
      .order('xp', { ascending: false });

    if (studentClass && studentClass !== 'ALL') {
      query = query.eq('class', studentClass);
    }

    const { data, error } = await query;
    if (!error && data && data.length > 0) {
      return data as GameProfile[];
    }
  } catch (err) {
    console.warn('Failed to fetch class game profiles from Supabase, using local cache:', err);
  }

  const cached = getCachedGameProfiles();
  if (studentClass && studentClass !== 'ALL') {
    return cached.filter((p) => p.class === studentClass);
  }
  return cached;
}

/**
 * Reset a student's 4-digit PIN (Teacher admin action).
 */
export async function resetStudentGamePin(profileId: string, newPin: string): Promise<boolean> {
  if (newPin.trim().length !== 4) return false;
  const pinHash = await sha256Hex(newPin.trim());

  try {
    const { error } = await (supabase.from('game_profiles' as any) as any)
      .update({ pin_hash: pinHash, updated_at: new Date().toISOString() })
      .eq('id', profileId);

    if (error) {
      console.warn('Failed to reset student PIN on Supabase:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Error resetting student PIN:', err);
    return false;
  }
}
