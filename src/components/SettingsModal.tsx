import { useState } from 'react';
import {
  type AppSettings,
  type ThemeMode,
  type AccentColor,
  type FontSize,
  type Density,
  getSavedSettings,
  saveSettings,
  DEFAULT_SETTINGS,
} from '../lib/settings';
import './SettingsModal.css';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRestartTutorial?: () => void;
  onLockApp?: () => void;
}

const ACCENT_OPTIONS: { id: AccentColor; name: string; class: string }[] = [
  { id: 'indigo', name: 'Indigo', class: 'swatch-indigo' },
  { id: 'emerald', name: 'Emerald', class: 'swatch-emerald' },
  { id: 'violet', name: 'Violet', class: 'swatch-violet' },
  { id: 'rose', name: 'Rose', class: 'swatch-rose' },
  { id: 'amber', name: 'Amber', class: 'swatch-amber' },
  { id: 'sky', name: 'Sky', class: 'swatch-sky' },
];

const FONT_OPTIONS: { id: FontSize; label: string; sample: string }[] = [
  { id: 'small', label: 'Small', sample: 'Aa' },
  { id: 'normal', label: 'Default', sample: 'Aa' },
  { id: 'medium', label: 'Medium', sample: 'Aa' },
  { id: 'large', label: 'Large', sample: 'Aa' },
];

export function SettingsModal({
  isOpen,
  onClose,
  onRestartTutorial,
  onLockApp,
}: SettingsModalProps) {
  const [settings, setSettingsState] = useState<AppSettings>(() => getSavedSettings());

  if (!isOpen) return null;

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const updated = { ...settings, [key]: value };
    setSettingsState(updated);
    saveSettings(updated);
  };

  const handleReset = () => {
    setSettingsState(DEFAULT_SETTINGS);
    saveSettings(DEFAULT_SETTINGS);
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
        {/* ─── Header ───────────────────────────────────────────────────────── */}
        <div className="settings-header">
          <div className="settings-title-wrap">
            <div className="settings-icon-badge">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
              </svg>
            </div>
            <h2 className="settings-title">Settings & Appearance</h2>
          </div>
          <button type="button" className="settings-close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* ─── Body ─────────────────────────────────────────────────────────── */}
        <div className="settings-body">
          {/* 1. Theme */}
          <div className="settings-section">
            <h3 className="settings-section-title">Color Theme</h3>
            <div className="settings-segmented-grid">
              {(['light', 'dark', 'system'] as ThemeMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={`settings-seg-btn ${settings.theme === mode ? 'settings-seg-btn--active' : ''}`}
                  onClick={() => updateSetting('theme', mode)}
                >
                  {mode === 'light' && '☀️ Light'}
                  {mode === 'dark' && '🌙 Dark'}
                  {mode === 'system' && '💻 System'}
                </button>
              ))}
            </div>
          </div>

          {/* 2. Accent Color */}
          <div className="settings-section">
            <h3 className="settings-section-title">Accent Palette</h3>
            <div className="settings-accents-grid">
              {ACCENT_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`settings-accent-swatch ${opt.class} ${settings.accent === opt.id ? 'settings-accent-swatch--active' : ''}`}
                  onClick={() => updateSetting('accent', opt.id)}
                  title={opt.name}
                >
                  {settings.accent === opt.id && '✓'}
                </button>
              ))}
            </div>
          </div>

          {/* 3. Font Size */}
          <div className="settings-section">
            <h3 className="settings-section-title">Text Size</h3>
            <div className="settings-font-grid">
              {FONT_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`settings-font-btn ${settings.fontSize === opt.id ? 'settings-font-btn--active' : ''}`}
                  onClick={() => updateSetting('fontSize', opt.id)}
                >
                  <span style={{ fontSize: opt.id === 'small' ? '12px' : opt.id === 'medium' ? '17px' : opt.id === 'large' ? '20px' : '15px', fontWeight: 700 }}>
                    {opt.sample}
                  </span>
                  <span className="settings-font-label">{opt.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 4. Density */}
          <div className="settings-section">
            <h3 className="settings-section-title">Display Density</h3>
            <div className="settings-density-grid">
              {(['comfortable', 'compact'] as Density[]).map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`settings-density-btn ${settings.density === d ? 'settings-density-btn--active' : ''}`}
                  onClick={() => updateSetting('density', d)}
                >
                  {d === 'comfortable' ? '☕ Comfortable' : '⚡ Compact'}
                </button>
              ))}
            </div>
          </div>

          {/* 5. AI Extraction Preferences */}
          <div className="settings-section">
            <h3 className="settings-section-title">AI Extraction Defaults</h3>
            <div className="settings-action-row">
              <div className="settings-action-info">
                <span className="settings-action-name">✨ Auto-Generate Teacher Insights</span>
                <span className="settings-action-desc">Include examiner guidance notes & student misconceptions by default during past paper extraction</span>
              </div>
              <button
                type="button"
                className={`settings-seg-btn ${settings.defaultAiGuidanceEnabled ? 'settings-seg-btn--active' : ''}`}
                style={{ flex: 'none', padding: '6px 16px' }}
                onClick={() => updateSetting('defaultAiGuidanceEnabled', !settings.defaultAiGuidanceEnabled)}
              >
                {settings.defaultAiGuidanceEnabled ? 'Enabled' : 'Disabled'}
              </button>
            </div>
          </div>

          {/* 6. Tools & Management */}
          <div className="settings-section">
            <h3 className="settings-section-title">Tools & Reset</h3>
            <div className="settings-actions-list">
              {onRestartTutorial && (
                <div className="settings-action-row">
                  <div className="settings-action-info">
                    <span className="settings-action-name">Guided Tour</span>
                    <span className="settings-action-desc">Restart the first-time feature onboarding walkthrough</span>
                  </div>
                  <button
                    type="button"
                    className="settings-action-trigger"
                    onClick={() => {
                      onRestartTutorial();
                      onClose();
                    }}
                  >
                    Start Tour
                  </button>
                </div>
              )}

              {onLockApp && (
                <div className="settings-action-row">
                  <div className="settings-action-info">
                    <span className="settings-action-name">Lock Session</span>
                    <span className="settings-action-desc">Prompt for access PIN again on this tab</span>
                  </div>
                  <button
                    type="button"
                    className="settings-action-trigger settings-action-trigger--danger"
                    onClick={() => {
                      onLockApp();
                      onClose();
                    }}
                  >
                    Lock Now
                  </button>
                </div>
              )}

              <div className="settings-action-row">
                <div className="settings-action-info">
                  <span className="settings-action-name">Reset Appearance</span>
                  <span className="settings-action-desc">Restore default theme, accent, and scale</span>
                </div>
                <button
                  type="button"
                  className="settings-action-trigger"
                  onClick={handleReset}
                >
                  Reset Defaults
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* ─── Footer ───────────────────────────────────────────────────────── */}
        <div className="settings-footer">
          <button type="button" className="settings-done-btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
