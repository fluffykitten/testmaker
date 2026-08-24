// ─── Application Settings & Appearance Manager ──────────────────────────────
// Manages themes, accent colors, font scale, and layout density with localStorage persistence.

export type ThemeMode = 'light' | 'dark' | 'system';
export type AccentColor = 'indigo' | 'emerald' | 'violet' | 'rose' | 'amber' | 'sky';
export type FontSize = 'small' | 'normal' | 'medium' | 'large';
export type Density = 'comfortable' | 'compact';

export interface AppSettings {
  theme: ThemeMode;
  accent: AccentColor;
  fontSize: FontSize;
  density: Density;
  defaultAiGuidanceEnabled: boolean;
}

const STORAGE_KEY = 'testmaker_user_settings';

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'light',
  accent: 'indigo',
  fontSize: 'normal',
  density: 'comfortable',
  defaultAiGuidanceEnabled: true,
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
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    }
  } catch (e) {
    console.warn('Failed to read settings:', e);
  }
  return DEFAULT_SETTINGS;
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
