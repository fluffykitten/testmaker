import { supabase } from './supabase';
import {
  type SecurityViolationTier,
  DEFAULT_SECURITY_TIERS,
  normalizeSecurityTiers,
} from './securityTiers';
import {
  type TopicMasteryTier,
  DEFAULT_TOPIC_MASTERY_TIERS,
  normalizeTopicMasteryTiers,
} from './topicMastery';

export type ThemeMode = 'light' | 'dark' | 'system';
export type AccentColor = 'indigo' | 'emerald' | 'violet' | 'rose' | 'amber' | 'sky';
export type FontSize = 'small' | 'normal' | 'medium' | 'large';
export type Density = 'comfortable' | 'compact';
export type GeminiApiKeyTier = 'auto' | 'paid' | 'free';

export interface AppSettings {
  theme: ThemeMode;
  accent: AccentColor;
  fontSize: FontSize;
  density: Density;
  defaultAiGuidanceEnabled: boolean;
  defaultEnableWatermark?: boolean;      // Per-candidate ghost watermark (default: disabled)
  defaultEnableMultiMonitor?: boolean;    // Multi-monitor detection shield (default: disabled)
  defaultRequireStudentPin?: boolean;     // Require 4-digit personal candidate PIN from school roster (default: disabled)
  autoLockMinutes?: number;              // Inactivity auto-lock in minutes (default: 15, 0 = disabled)
  classes: string[]; // Configured list of school classes / cohorts for formal exams
  subjects?: string[]; // Configured list of school subjects / departments
  googleDriveClientId?: string;
  autoBackupEnabled?: boolean;
  autoBackupFrequency?: 'on_paper_upload' | 'daily' | 'weekly';
  lastBackupTimestamp?: number;
  lastBackupFileName?: string;
  storageProvider?: 'cloudflare_r2' | 'supabase';
  r2MediaEndpoint?: string;
  r2UploadSecret?: string;
  enableVariantImageGeneration?: boolean; // AI diagram & SVG generation for question variants (default: false)
  enableQuizizzMode?: boolean;            // Quizizz gamified mode feature flag (default: false)
  hideCreativeModeOnLanding?: boolean;    // Hide Creative Mode Hub & Avatar Studio on landing page (default: false)
  hideEmergencyExamButton?: boolean;      // Hide Emergency Save & Exit button during student exams (default: false)
  allowTeacherAccountClaiming?: boolean;  // Allow creating/claiming teacher accounts from login screen (default: false)
  securityTiers?: SecurityViolationTier[]; // Dynamic list of strike escalation penalty tiers
  topicMasteryTiers?: TopicMasteryTier[];  // Dynamic list of topic mastery performance bands
  geminiExtractionModel?: string;         // AI Model for Paper Extraction: 'gemini-3.5-flash-lite' | 'gemini-3.8-flash' | custom model
  geminiApiKeyTier?: GeminiApiKeyTier;    // Active Cloudflare-configured API Key Tier: 'auto' | 'paid' | 'free'
}

const STORAGE_KEY = 'testmaker_user_settings';

export const DEFAULT_CLASSES: string[] = [
  '10-A',
  '10-B',
  '10-C',
  '11-A',
  '11-B',
  '11-C',
  '12-A',
  '12-B',
  '12-C',
];

export const DEFAULT_SUBJECTS: string[] = [
  'Chemistry',
  'Physics',
  'Biology',
  'Mathematics',
  'English',
  'Geography',
  'Economics',
  'Sociology',
  'PAI',
  'Arabic',
  'Bahasa Indonesia',
];

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  accent: 'indigo',
  fontSize: 'normal',
  density: 'comfortable',
  defaultAiGuidanceEnabled: true,
  defaultEnableWatermark: false,
  defaultEnableMultiMonitor: false,
  defaultRequireStudentPin: false,
  autoLockMinutes: 15,
  classes: DEFAULT_CLASSES,
  subjects: DEFAULT_SUBJECTS,
  autoBackupEnabled: false,
  autoBackupFrequency: 'on_paper_upload',
  storageProvider: 'cloudflare_r2',
  r2MediaEndpoint: 'https://testmaker-media.icmadani.workers.dev',
  r2UploadSecret: 'tm_r2_uploader_secret_2026',
  enableVariantImageGeneration: false,
  enableQuizizzMode: false,
  hideCreativeModeOnLanding: false,
  hideEmergencyExamButton: false,
  allowTeacherAccountClaiming: false,
  securityTiers: DEFAULT_SECURITY_TIERS,
  topicMasteryTiers: DEFAULT_TOPIC_MASTERY_TIERS,
  geminiExtractionModel: 'gemini-3.5-flash-lite',
  geminiApiKeyTier: 'auto',
};

// Accent palette color mappings for --color-primary tokens
const ACCENT_PALETTES: Record<AccentColor, {
  50: string; 100: string; 200: string; 300: string; 400: string;
  500: string; 600: string; 700: string; 800: string; 900: string;
  glow: string;
}> = {
  indigo: {
    50: '#eef2ff', 100: '#e0e7ff', 200: '#c7d2fe', 300: '#a5b4fc', 400: '#818cf8',
    500: '#6366f1', 600: '#4f46e5', 700: '#4338ca', 800: '#3730a3', 900: '#312e81',
    glow: 'rgba(99, 102, 241, 0.25)',
  },
  emerald: {
    50: '#ecfdf5', 100: '#d1fae5', 200: '#a7f3d0', 300: '#6ee7b7', 400: '#34d399',
    500: '#10b981', 600: '#059669', 700: '#047857', 800: '#065f46', 900: '#064e3b',
    glow: 'rgba(16, 185, 129, 0.25)',
  },
  violet: {
    50: '#f5f3ff', 100: '#ede9fe', 200: '#ddd6fe', 300: '#c4b5fd', 400: '#a78bfa',
    500: '#8b5cf6', 600: '#7c3aed', 700: '#6d28d9', 800: '#5b21b6', 900: '#4c1d95',
    glow: 'rgba(139, 92, 246, 0.25)',
  },
  rose: {
    50: '#fff1f2', 100: '#ffe4e6', 200: '#fecdd3', 300: '#fda4af', 400: '#fb7185',
    500: '#f43f5e', 600: '#e11d48', 700: '#be123c', 800: '#9f1239', 900: '#881337',
    glow: 'rgba(244, 63, 94, 0.25)',
  },
  amber: {
    50: '#fffbeb', 100: '#fef3c7', 200: '#fde68a', 300: '#fcd34d', 400: '#fbbf24',
    500: '#f59e0b', 600: '#d97706', 700: '#b45309', 800: '#92400e', 900: '#78350f',
    glow: 'rgba(245, 158, 11, 0.25)',
  },
  sky: {
    50: '#f0f9ff', 100: '#e0f2fe', 200: '#bae6fd', 300: '#7dd3fc', 400: '#38bdf8',
    500: '#0ea5e9', 600: '#0284c7', 700: '#0369a1', 800: '#075985', 900: '#0c4a6e',
    glow: 'rgba(14, 165, 233, 0.25)',
  },
};

const FONT_SIZE_PX: Record<FontSize, string> = {
  small: '14px',
  normal: '16px',
  medium: '18px',
  large: '20px',
};

/**
 * Loads user settings from localStorage or returns defaults
 */
export function getSavedSettings(): AppSettings {
  const DEFAULT_CLIENT_ID = '369298482584-mk30jqplfvlc70th4b5qom7n0he53ogs.apps.googleusercontent.com';
  const envGoogleClientId =
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GOOGLE_DRIVE_CLIENT_ID) ||
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GOOGLE_CLIENT_ID) ||
    DEFAULT_CLIENT_ID;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Auto-migrate from deprecated test client ID if cached in user's localStorage
      const localId =
        !parsed.googleDriveClientId || parsed.googleDriveClientId.startsWith('601968506903')
          ? envGoogleClientId
          : parsed.googleDriveClientId;

      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        googleDriveClientId: localId,
        securityTiers: parsed.securityTiers ? normalizeSecurityTiers(parsed.securityTiers) : DEFAULT_SECURITY_TIERS,
        topicMasteryTiers: parsed.topicMasteryTiers ? normalizeTopicMasteryTiers(parsed.topicMasteryTiers) : DEFAULT_TOPIC_MASTERY_TIERS,
      };
    }
  } catch (e) {
    console.warn('Failed to read settings:', e);
  }
  return {
    ...DEFAULT_SETTINGS,
    googleDriveClientId: envGoogleClientId,
  };
}

/**
 * Applies theme, accent tokens, font-size, and density to the document
 */
export function applySettings(settings: AppSettings): void {
  const root = document.documentElement;

  // 1. Theme (Dark / Light / System)
  const isDark =
    settings.theme === 'dark' ||
    (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  if (isDark) {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }

  // 2. Accent Color Palette CSS Variables
  const palette = ACCENT_PALETTES[settings.accent] || ACCENT_PALETTES.indigo;
  root.style.setProperty('--color-primary-50', palette[50]);
  root.style.setProperty('--color-primary-100', palette[100]);
  root.style.setProperty('--color-primary-200', palette[200]);
  root.style.setProperty('--color-primary-300', palette[300]);
  root.style.setProperty('--color-primary-400', palette[400]);
  root.style.setProperty('--color-primary-500', palette[500]);
  root.style.setProperty('--color-primary-600', palette[600]);
  root.style.setProperty('--color-primary-700', palette[700]);
  root.style.setProperty('--color-primary-800', palette[800]);
  root.style.setProperty('--color-primary-900', palette[900]);
  root.style.setProperty('--shadow-glow', `0 0 20px ${palette.glow}`);

  // 3. Base Font Size
  root.style.fontSize = FONT_SIZE_PX[settings.fontSize] || '16px';

  // 4. Density Data Attribute
  root.setAttribute('data-density', settings.density);
}

/**
 * Saves and applies new settings
 */
export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn('Failed to save settings:', e);
  }
  applySettings(settings);
}

/**
 * Retrieves configured school classes from settings
 */
export function getSchoolClasses(): string[] {
  const settings = getSavedSettings();
  if (Array.isArray(settings.classes) && settings.classes.length > 0) {
    return settings.classes;
  }
  return DEFAULT_CLASSES;
}

/**
 * Saves configured school classes to local settings and syncs to Supabase cloud app_config
 */
export function saveSchoolClasses(classes: string[]): void {
  const cleanClasses = Array.from(
    new Set(
      classes
        .map((c) => String(c || '').trim())
        .filter(Boolean)
    )
  );

  const current = getSavedSettings();
  const updated: AppSettings = {
    ...current,
    classes: cleanClasses.length > 0 ? cleanClasses : DEFAULT_CLASSES,
  };
  saveSettings(updated);
  // Async cloud sync in background
  syncSchoolClassesToCloud(updated.classes).catch(() => {});
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('school_classes_updated', { detail: { classes: updated.classes } }));
  }
}

/**
 * Syncs school classes to Supabase app_config store
 */
export async function syncSchoolClassesToCloud(classes: string[]): Promise<boolean> {
  try {
    const { error } = await (supabase.from('app_config' as any) as any).upsert({
      key: 'school_classes',
      value: JSON.stringify(classes),
    });
    if (error) {
      console.warn('School classes cloud sync notice:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Cloud sync error for school classes:', err);
    return false;
  }
}

let inflightSchoolClassesPromise: Promise<string[]> | null = null;

/**
 * Loads school classes from local storage, fetches from Supabase cloud app_config if available,
 * and returns the authoritative class list.
 */
export async function loadAndSyncSchoolClasses(): Promise<string[]> {
  if (lastStudentLobbySettingsSeededAt > 0 && Date.now() - lastStudentLobbySettingsSeededAt < 120_000) {
    return getSchoolClasses();
  }
  if (inflightSchoolClassesPromise) return inflightSchoolClassesPromise;

  inflightSchoolClassesPromise = (async () => {
    const localClasses = getSchoolClasses();

    try {
      const { data, error } = (await (supabase.from('app_config' as any) as any)
        .select('value')
        .eq('key', 'school_classes')
        .maybeSingle()) as { data: { value: string } | null; error: any };

      if (!error && data?.value) {
        const parsed = JSON.parse(data.value);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const cleanCloud = parsed.map(String).filter(Boolean);
          const current = getSavedSettings();
          if (JSON.stringify(current.classes) !== JSON.stringify(cleanCloud)) {
            const updated = { ...current, classes: cleanCloud };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
            if (typeof window !== 'undefined') {
              window.dispatchEvent(new CustomEvent('school_classes_updated', { detail: { classes: cleanCloud } }));
            }
          }
          return cleanCloud;
        }
      }
    } catch (err) {
      console.warn('Could not fetch school classes from cloud, using local cache:', err);
    }

    return localClasses;
  })().finally(() => {
    inflightSchoolClassesPromise = null;
  });

  return inflightSchoolClassesPromise;
}

/**
 * Retrieves configured school subjects from settings
 */
export function getSchoolSubjects(): string[] {
  const settings = getSavedSettings();
  if (Array.isArray(settings.subjects) && settings.subjects.length > 0) {
    return settings.subjects;
  }
  return DEFAULT_SUBJECTS;
}

/**
 * Saves configured school subjects to local settings and syncs to Supabase cloud app_config
 */
export function saveSchoolSubjects(subjects: string[]): void {
  const cleanSubjects = Array.from(
    new Set(
      subjects
        .map((s) => String(s || '').trim())
        .filter(Boolean)
    )
  );

  const current = getSavedSettings();
  const updated: AppSettings = {
    ...current,
    subjects: cleanSubjects.length > 0 ? cleanSubjects : DEFAULT_SUBJECTS,
  };
  saveSettings(updated);
  syncSchoolSubjectsToCloud(updated.subjects || DEFAULT_SUBJECTS).catch(() => {});
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('school_subjects_updated', { detail: { subjects: updated.subjects } }));
  }
}

/**
 * Syncs school subjects to Supabase app_config store
 */
export async function syncSchoolSubjectsToCloud(subjects: string[]): Promise<boolean> {
  try {
    const { error } = await (supabase.from('app_config' as any) as any).upsert({
      key: 'school_subjects',
      value: JSON.stringify(subjects),
    });
    if (error) {
      console.warn('School subjects cloud sync notice:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Failed to sync school subjects to Supabase cloud:', err);
    return false;
  }
}

/**
 * Loads school subjects from Supabase cloud app_config and syncs locally
 */
export async function loadAndSyncSchoolSubjects(): Promise<string[]> {
  const localSubjects = getSchoolSubjects();

  try {
    const { data, error } = (await (supabase.from('app_config' as any) as any)
      .select('value')
      .eq('key', 'school_subjects')
      .maybeSingle()) as { data: { value: string } | null; error: any };

    if (!error && data?.value) {
      const parsed = JSON.parse(data.value);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const cleanCloud = parsed.map(String).filter(Boolean);
        const current = getSavedSettings();
        if (JSON.stringify(current.subjects) !== JSON.stringify(cleanCloud)) {
          const updated = { ...current, subjects: cleanCloud };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
        }
        return cleanCloud;
      }
    }
  } catch (err) {
    console.warn('Could not fetch school subjects from cloud, using local cache:', err);
  }

  return localSubjects;
}

/**
 * Syncs Google Drive Client ID to Supabase app_config store
 */
export async function syncGoogleDriveClientIdToCloud(clientId: string): Promise<boolean> {
  const trimmed = clientId ? clientId.trim() : '';
  if (!trimmed) return false;
  try {
    const { error } = await (supabase.from('app_config' as any) as any).upsert({
      key: 'google_drive_client_id',
      value: JSON.stringify(trimmed),
    });
    if (error) {
      console.warn('Google Drive Client ID cloud sync notice:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Cloud sync error for Google Drive Client ID:', err);
    return false;
  }
}

/**
 * Loads Google Drive Client ID from local storage or cloud app_config if available
 */
export async function loadAndSyncGoogleDriveClientId(): Promise<string> {
  const DEFAULT_CLIENT_ID = '369298482584-mk30jqplfvlc70th4b5qom7n0he53ogs.apps.googleusercontent.com';
  const current = getSavedSettings();

  try {
    const { data, error } = (await (supabase.from('app_config' as any) as any)
      .select('value')
      .eq('key', 'google_drive_client_id')
      .maybeSingle()) as { data: { value: string } | null; error: any };

    if (!error && data?.value) {
      const parsed = JSON.parse(data.value);
      if (typeof parsed === 'string' && parsed.trim()) {
        const cloudId = parsed.trim();
        if (current.googleDriveClientId !== cloudId) {
          const updated = { ...current, googleDriveClientId: cloudId };
          saveSettings(updated);
        }
        return cloudId;
      }
    }
  } catch (err) {
    console.warn('Could not fetch Google Drive Client ID from cloud:', err);
  }

  // Fallback to local storage or default
  if (current.googleDriveClientId && current.googleDriveClientId.trim() && !current.googleDriveClientId.startsWith('601968506903')) {
    syncGoogleDriveClientIdToCloud(current.googleDriveClientId).catch(() => {});
    return current.googleDriveClientId;
  }

  const fallback =
    (typeof import.meta !== 'undefined' && import.meta.env?.VITE_GOOGLE_DRIVE_CLIENT_ID) ||
    DEFAULT_CLIENT_ID;
  const updated = { ...current, googleDriveClientId: fallback };
  saveSettings(updated);
  syncGoogleDriveClientIdToCloud(fallback).catch(() => {});
  return fallback;
}

/**
 * Saves and syncs Creative Mode landing page visibility to local settings & Supabase cloud app_config
 */
export function saveCreativeModeLandingVisibility(hide: boolean): void {
  const current = getSavedSettings();
  const updated: AppSettings = {
    ...current,
    hideCreativeModeOnLanding: hide,
  };
  saveSettings(updated);
  syncCreativeModeLandingVisibilityToCloud(hide).catch(() => {});
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('creative_mode_landing_visibility_updated', {
        detail: { hideCreativeModeOnLanding: hide },
      })
    );
  }
}

/**
 * Syncs Creative Mode landing page visibility to Supabase app_config store
 */
export async function syncCreativeModeLandingVisibilityToCloud(hide: boolean): Promise<boolean> {
  try {
    const { error } = await (supabase.from('app_config' as any) as any).upsert({
      key: 'hide_creative_mode_landing',
      value: JSON.stringify(hide),
    });
    if (error) {
      console.warn('Creative Mode landing visibility cloud sync notice:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Cloud sync error for Creative Mode landing visibility:', err);
    return false;
  }
}

let inflightCreativeModeVisibilityPromise: Promise<boolean> | null = null;

/**
 * Loads Creative Mode landing page visibility from local storage, fetches from Supabase cloud app_config if available,
 * and updates local cache.
 */
export async function loadAndSyncCreativeModeLandingVisibility(): Promise<boolean> {
  if (inflightCreativeModeVisibilityPromise) return inflightCreativeModeVisibilityPromise;

  inflightCreativeModeVisibilityPromise = (async () => {
    const current = getSavedSettings();
    const localVal = Boolean(current.hideCreativeModeOnLanding);

    try {
      const { data, error } = (await (supabase.from('app_config' as any) as any)
        .select('value')
        .eq('key', 'hide_creative_mode_landing')
        .maybeSingle()) as { data: { value: string } | null; error: any };

      if (!error && data?.value !== undefined && data?.value !== null) {
        const parsed = JSON.parse(data.value);
        const cloudVal = Boolean(parsed);
        if (current.hideCreativeModeOnLanding !== cloudVal) {
          const updated = { ...current, hideCreativeModeOnLanding: cloudVal };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('creative_mode_landing_visibility_updated', {
                detail: { hideCreativeModeOnLanding: cloudVal },
              })
            );
          }
        }
        return cloudVal;
      }
    } catch (err) {
      console.warn('Could not fetch Creative Mode landing visibility from cloud:', err);
    }

    return localVal;
  })().finally(() => {
    inflightCreativeModeVisibilityPromise = null;
  });

  return inflightCreativeModeVisibilityPromise;
}

/**
 * Updates educator account creation/claiming availability locally and syncs to Supabase app_config
 */
export function saveTeacherAccountClaimingSetting(enabled: boolean): void {
  const current = getSavedSettings();
  const updated: AppSettings = {
    ...current,
    allowTeacherAccountClaiming: enabled,
  };
  saveSettings(updated);
  syncTeacherAccountClaimingToCloud(enabled).catch(() => {});
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('teacher_account_claiming_updated', {
        detail: { allowTeacherAccountClaiming: enabled },
      })
    );
  }
}

export async function syncTeacherAccountClaimingToCloud(enabled: boolean): Promise<boolean> {
  try {
    const { error } = await (supabase.from('app_config' as any) as any).upsert({
      key: 'allow_teacher_account_claiming',
      value: JSON.stringify(enabled),
    });
    if (error) {
      console.warn('Teacher account claiming cloud sync notice:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Cloud sync error for teacher account claiming setting:', err);
    return false;
  }
}

export async function loadAndSyncTeacherAccountClaiming(): Promise<boolean> {
  const current = getSavedSettings();
  const localVal = Boolean(current.allowTeacherAccountClaiming);

  try {
    const { data, error } = (await (supabase.from('app_config' as any) as any)
      .select('value')
      .eq('key', 'allow_teacher_account_claiming')
      .maybeSingle()) as { data: { value: string } | null; error: any };

    if (!error && data?.value !== undefined && data?.value !== null) {
      const parsed = JSON.parse(data.value);
      const cloudVal = Boolean(parsed);
      if (current.allowTeacherAccountClaiming !== cloudVal) {
        const updated = { ...current, allowTeacherAccountClaiming: cloudVal };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('teacher_account_claiming_updated', {
              detail: { allowTeacherAccountClaiming: cloudVal },
            })
          );
        }
      }
      return cloudVal;
    }
  } catch (err) {
    console.warn('Could not fetch teacher account claiming setting from cloud:', err);
  }

  return localVal;
}

/**
 * Saves and updates Emergency Save Button visibility in local settings and syncs to Supabase cloud app_config
 */
export function saveEmergencyExamButtonVisibility(hide: boolean): void {
  const current = getSavedSettings();
  const updated: AppSettings = {
    ...current,
    hideEmergencyExamButton: hide,
  };
  saveSettings(updated);
  syncEmergencyExamButtonVisibilityToCloud(hide).catch(() => {});
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('emergency_exam_button_visibility_updated', {
        detail: { hideEmergencyExamButton: hide },
      })
    );
  }
}

/**
 * Syncs Emergency Save Button visibility to Supabase app_config store
 */
export async function syncEmergencyExamButtonVisibilityToCloud(hide: boolean): Promise<boolean> {
  try {
    const { error } = await (supabase.from('app_config' as any) as any).upsert({
      key: 'hide_emergency_exam_button',
      value: JSON.stringify(hide),
    });
    if (error) {
      console.warn('Emergency exam button visibility cloud sync notice:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Cloud sync error for Emergency exam button visibility:', err);
    return false;
  }
}

let inflightEmergencyButtonPromise: Promise<boolean> | null = null;
let lastStudentLobbySettingsSeededAt = 0;

/**
 * Seeds student-facing lobby configuration returned by `get_student_exam_paper`
 * so student browsers skip redundant direct `app_config` queries.
 */
export function seedStudentLobbySettingsFromPaper(bundle: {
  schoolClasses?: unknown;
  securityTiers?: unknown;
  hideEmergencyExamButton?: unknown;
}): void {
  if (!bundle || typeof bundle !== 'object') return;
  const hasBundledField =
    bundle.schoolClasses !== undefined ||
    bundle.securityTiers !== undefined ||
    bundle.hideEmergencyExamButton !== undefined;
  if (!hasBundledField) return;

  const current = getSavedSettings();
  let changed = false;
  const next: AppSettings = { ...current };
  let classesUpdated = false;
  let tiersUpdated = false;
  let emergencyBtnUpdated = false;

  if (Array.isArray(bundle.schoolClasses) && bundle.schoolClasses.length > 0) {
    const cleanClasses = bundle.schoolClasses.map(String).filter(Boolean);
    if (cleanClasses.length > 0 && JSON.stringify(current.classes) !== JSON.stringify(cleanClasses)) {
      next.classes = cleanClasses;
      changed = true;
      classesUpdated = true;
    }
  }

  if (Array.isArray(bundle.securityTiers) && bundle.securityTiers.length > 0) {
    const normalizedTiers = normalizeSecurityTiers(bundle.securityTiers as SecurityViolationTier[]);
    if (JSON.stringify(normalizeSecurityTiers(current.securityTiers)) !== JSON.stringify(normalizedTiers)) {
      next.securityTiers = normalizedTiers;
      changed = true;
      tiersUpdated = true;
    }
  }

  if (typeof bundle.hideEmergencyExamButton === 'boolean') {
    if (Boolean(current.hideEmergencyExamButton) !== bundle.hideEmergencyExamButton) {
      next.hideEmergencyExamButton = bundle.hideEmergencyExamButton;
      changed = true;
      emergencyBtnUpdated = true;
    }
  }

  lastStudentLobbySettingsSeededAt = Date.now();
  if (changed && typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore storage access issues
    }
    if (typeof window !== 'undefined') {
      if (classesUpdated) {
        window.dispatchEvent(new CustomEvent('school_classes_updated', { detail: { classes: next.classes } }));
      }
      if (tiersUpdated) {
        window.dispatchEvent(
          new CustomEvent('security_tiers_updated', { detail: { securityTiers: next.securityTiers } })
        );
      }
      if (emergencyBtnUpdated) {
        window.dispatchEvent(
          new CustomEvent('emergency_exam_button_visibility_updated', {
            detail: { hideEmergencyExamButton: next.hideEmergencyExamButton },
          })
        );
      }
    }
  }
}

/**
 * Loads Emergency Save Button visibility from local storage, fetches from Supabase cloud app_config if available,
 * and updates local cache.
 */
export async function loadAndSyncEmergencyExamButtonVisibility(): Promise<boolean> {
  if (lastStudentLobbySettingsSeededAt > 0 && Date.now() - lastStudentLobbySettingsSeededAt < 120_000) {
    return Boolean(getSavedSettings().hideEmergencyExamButton);
  }
  if (inflightEmergencyButtonPromise) return inflightEmergencyButtonPromise;

  inflightEmergencyButtonPromise = (async () => {
    const current = getSavedSettings();
    const localVal = Boolean(current.hideEmergencyExamButton);

    try {
      const { data, error } = (await (supabase.from('app_config' as any) as any)
        .select('value')
        .eq('key', 'hide_emergency_exam_button')
        .maybeSingle()) as { data: { value: string } | null; error: any };

      if (!error && data?.value !== undefined && data?.value !== null) {
        const parsed = JSON.parse(data.value);
        const cloudVal = Boolean(parsed);
        if (current.hideEmergencyExamButton !== cloudVal) {
          const updated = { ...current, hideEmergencyExamButton: cloudVal };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('emergency_exam_button_visibility_updated', {
                detail: { hideEmergencyExamButton: cloudVal },
              })
            );
          }
        }
        return cloudVal;
      }
    } catch (err) {
      console.warn('Could not fetch Emergency exam button visibility from cloud:', err);
    }

    return localVal;
  })().finally(() => {
    inflightEmergencyButtonPromise = null;
  });

  return inflightEmergencyButtonPromise;
}


/**
 * Gets the configured Gemini extraction model from local settings or defaults to 'gemini-3.5-flash-lite'
 */
export function getGeminiExtractionModel(): string {
  const current = getSavedSettings();
  const trimmed = current.geminiExtractionModel?.trim();
  return trimmed || 'gemini-3.5-flash-lite';
}

/**
 * Saves and syncs the configured Gemini extraction model to local settings & Supabase cloud app_config
 */
export function saveGeminiExtractionModel(model: string): void {
  const current = getSavedSettings();
  const trimmed = model?.trim() || 'gemini-3.5-flash-lite';
  const updated: AppSettings = {
    ...current,
    geminiExtractionModel: trimmed,
  };

  saveSettings(updated);
  syncGeminiExtractionModelToCloud(trimmed).catch(() => {});
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('gemini_model_updated', {
        detail: { geminiExtractionModel: trimmed },
      })
    );
  }
}

/**
 * Syncs the configured Gemini extraction model to Supabase app_config store
 */
export async function syncGeminiExtractionModelToCloud(model: string): Promise<boolean> {
  const trimmed = model?.trim();
  if (!trimmed) return false;
  try {
    const { error } = await (supabase.from('app_config' as any) as any).upsert({
      key: 'gemini_extraction_model',
      value: JSON.stringify(trimmed),
    });
    if (error) {
      console.warn('Gemini extraction model cloud sync notice:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Cloud sync error for Gemini extraction model:', err);
    return false;
  }
}

/**
 * Loads the configured Gemini extraction model from local storage, fetches from Supabase cloud app_config if available,
 * and updates local cache.
 */
export async function loadAndSyncGeminiExtractionModel(): Promise<string> {
  const current = getSavedSettings();
  const localVal = current.geminiExtractionModel?.trim() || 'gemini-3.5-flash-lite';

  try {
    const { data, error } = (await (supabase.from('app_config' as any) as any)
      .select('value')
      .eq('key', 'gemini_extraction_model')
      .maybeSingle()) as { data: { value: string } | null; error: any };

    if (!error && data?.value !== undefined && data?.value !== null) {
      const parsed = JSON.parse(data.value);
      const cloudVal = typeof parsed === 'string' && parsed.trim() ? parsed.trim() : 'gemini-3.5-flash-lite';
      if (current.geminiExtractionModel !== cloudVal) {
        const updated = { ...current, geminiExtractionModel: cloudVal };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('gemini_model_updated', {
              detail: { geminiExtractionModel: cloudVal },
            })
          );
        }
      }
      return cloudVal;
    }
  } catch (err) {
    console.warn('Could not fetch Gemini extraction model from cloud:', err);
  }

  return localVal;
}

/**
 * Normalizes any raw value into a valid GeminiApiKeyTier ('auto' | 'paid' | 'free')
 */
export function normalizeGeminiApiKeyTier(val: unknown): GeminiApiKeyTier {
  const clean = typeof val === 'string' ? val.trim().toLowerCase() : '';
  if (clean === 'paid' || clean === 'free' || clean === 'auto') {
    return clean;
  }
  return 'auto';
}

/**
 * Gets the configured Gemini API key tier from local settings ('auto' | 'paid' | 'free')
 */
export function getGeminiApiKeyTier(): GeminiApiKeyTier {
  const current = getSavedSettings();
  return normalizeGeminiApiKeyTier(current.geminiApiKeyTier);
}

/**
 * Saves and syncs the configured Gemini API key tier to local settings & Supabase cloud app_config
 */
export function saveGeminiApiKeyTier(tier: GeminiApiKeyTier): void {
  const current = getSavedSettings();
  const normalized = normalizeGeminiApiKeyTier(tier);
  const updated: AppSettings = {
    ...current,
    geminiApiKeyTier: normalized,
  };

  saveSettings(updated);
  syncGeminiApiKeyTierToCloud(normalized).catch(() => {});
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('gemini_api_key_tier_updated', {
        detail: { geminiApiKeyTier: normalized },
      })
    );
  }
}

/**
 * Syncs the configured Gemini API key tier to Supabase app_config store
 */
export async function syncGeminiApiKeyTierToCloud(tier: GeminiApiKeyTier): Promise<boolean> {
  const normalized = normalizeGeminiApiKeyTier(tier);
  try {
    const { error } = await (supabase.from('app_config' as any) as any).upsert({
      key: 'gemini_api_key_tier',
      value: JSON.stringify(normalized),
    });
    if (error) {
      console.warn('Gemini API key tier cloud sync notice:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Cloud sync error for Gemini API key tier:', err);
    return false;
  }
}

/**
 * Loads the configured Gemini API key tier from local storage, fetches from Supabase cloud app_config if available,
 * and updates local cache.
 */
export async function loadAndSyncGeminiApiKeyTier(): Promise<GeminiApiKeyTier> {
  const current = getSavedSettings();
  const localVal = normalizeGeminiApiKeyTier(current.geminiApiKeyTier);

  try {
    const { data, error } = (await (supabase.from('app_config' as any) as any)
      .select('value')
      .eq('key', 'gemini_api_key_tier')
      .maybeSingle()) as { data: { value: string } | null; error: any };

    if (!error && data?.value !== undefined && data?.value !== null) {
      const parsed = JSON.parse(data.value);
      const cloudVal = normalizeGeminiApiKeyTier(parsed);
      if (current.geminiApiKeyTier !== cloudVal) {
        const updated = { ...current, geminiApiKeyTier: cloudVal };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('gemini_api_key_tier_updated', {
              detail: { geminiApiKeyTier: cloudVal },
            })
          );
        }
      }
      return cloudVal;
    }
  } catch (err) {
    console.warn('Could not fetch Gemini API key tier from cloud:', err);
  }

  return localVal;
}

/**
 * Retrieves the currently configured security violation escalation tiers.
 */
export function getSecurityTiers(): SecurityViolationTier[] {
  const current = getSavedSettings();
  return normalizeSecurityTiers(current.securityTiers);
}

/**
 * Saves and updates security escalation tiers in local settings and syncs to Supabase cloud app_config
 */
export function saveSecurityTiers(tiers: SecurityViolationTier[]): void {
  const normalized = normalizeSecurityTiers(tiers);
  const current = getSavedSettings();
  const updated: AppSettings = {
    ...current,
    securityTiers: normalized,
  };
  saveSettings(updated);
  syncSecurityTiersToCloud(normalized).catch(() => {});
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('security_tiers_updated', {
        detail: { securityTiers: normalized },
      })
    );
  }
}

/**
 * Syncs security escalation tiers to Supabase app_config store
 */
export async function syncSecurityTiersToCloud(tiers: SecurityViolationTier[]): Promise<boolean> {
  try {
    const { error } = await (supabase.from('app_config' as any) as any).upsert({
      key: 'exam_security_tiers',
      value: JSON.stringify(tiers),
    });
    if (error) {
      console.warn('Security escalation tiers cloud sync notice:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Cloud sync error for security escalation tiers:', err);
    return false;
  }
}

let inflightSecurityTiersPromise: Promise<SecurityViolationTier[]> | null = null;

/**
 * Loads security escalation tiers from local storage, fetches from Supabase cloud app_config if available,
 * and updates local cache.
 */
export async function loadAndSyncSecurityTiers(): Promise<SecurityViolationTier[]> {
  if (lastStudentLobbySettingsSeededAt > 0 && Date.now() - lastStudentLobbySettingsSeededAt < 120_000) {
    return getSecurityTiers();
  }
  if (inflightSecurityTiersPromise) return inflightSecurityTiersPromise;

  inflightSecurityTiersPromise = (async () => {
    const current = getSavedSettings();
    const localVal = normalizeSecurityTiers(current.securityTiers);

    try {
      const { data, error } = (await (supabase.from('app_config' as any) as any)
        .select('value')
        .eq('key', 'exam_security_tiers')
        .maybeSingle()) as { data: { value: string } | null; error: any };

      if (!error && data?.value !== undefined && data?.value !== null) {
        const parsed = JSON.parse(data.value);
        const cloudVal = normalizeSecurityTiers(parsed);
        const currentJson = JSON.stringify(localVal);
        const cloudJson = JSON.stringify(cloudVal);

        if (currentJson !== cloudJson) {
          const updated = { ...current, securityTiers: cloudVal };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
          if (typeof window !== 'undefined') {
            window.dispatchEvent(
              new CustomEvent('security_tiers_updated', {
                detail: { securityTiers: cloudVal },
              })
            );
          }
        }
        return cloudVal;
      }
    } catch (err) {
      console.warn('Could not fetch security escalation tiers from cloud:', err);
    }

    return localVal;
  })().finally(() => {
    inflightSecurityTiersPromise = null;
  });

  return inflightSecurityTiersPromise;
}

const CLOUD_TOPIC_MASTERY_KEY = 'topic_mastery_tiers';

/**
 * Retrieves the currently configured topic mastery performance tiers.
 * Safe in non-browser environments (returns defaults when localStorage is unavailable).
 */
export function getTopicMasteryTiers(): TopicMasteryTier[] {
  if (typeof localStorage === 'undefined') {
    return DEFAULT_TOPIC_MASTERY_TIERS.map((t) => ({ ...t }));
  }
  const current = getSavedSettings();
  return normalizeTopicMasteryTiers(current.topicMasteryTiers);
}

/**
 * Saves topic mastery tiers to local settings and syncs to Supabase app_config store.
 */
export function saveTopicMasteryTiers(tiers: TopicMasteryTier[]): void {
  const normalized = normalizeTopicMasteryTiers(tiers);
  const current = getSavedSettings();
  saveSettings({
    ...current,
    topicMasteryTiers: normalized,
  });
  syncTopicMasteryTiersToCloud(normalized).catch(() => {});
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('topic_mastery_tiers_updated', {
        detail: { topicMasteryTiers: normalized },
      })
    );
  }
}

/**
 * Syncs topic mastery tiers to Supabase app_config store.
 */
export async function syncTopicMasteryTiersToCloud(tiers: TopicMasteryTier[]): Promise<boolean> {
  try {
    const { error } = await (supabase.from('app_config' as any) as any).upsert({
      key: CLOUD_TOPIC_MASTERY_KEY,
      value: JSON.stringify(tiers),
    });
    if (error) {
      console.warn('Topic mastery tiers cloud sync notice:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('Cloud sync error for topic mastery tiers:', err);
    return false;
  }
}

/**
 * Loads topic mastery tiers from local storage, fetches cloud app_config updates if present,
 * and updates local cache.
 */
export async function loadAndSyncTopicMasteryTiers(): Promise<TopicMasteryTier[]> {
  const current = getSavedSettings();
  const localVal = normalizeTopicMasteryTiers(current.topicMasteryTiers);

  try {
    const { data, error } = (await (supabase.from('app_config' as any) as any)
      .select('value')
      .eq('key', CLOUD_TOPIC_MASTERY_KEY)
      .maybeSingle()) as { data: { value: string } | null; error: any };

    if (!error && data?.value !== undefined && data?.value !== null) {
      const cloudVal = normalizeTopicMasteryTiers(JSON.parse(data.value));
      if (JSON.stringify(localVal) !== JSON.stringify(cloudVal)) {
        const updated = { ...current, topicMasteryTiers: cloudVal };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('topic_mastery_tiers_updated', {
              detail: { topicMasteryTiers: cloudVal },
            })
          );
        }
      }
      return cloudVal;
    }
  } catch (err) {
    console.warn('Could not fetch topic mastery tiers from cloud:', err);
  }

  return localVal;
}
