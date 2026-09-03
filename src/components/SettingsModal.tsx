import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import {
  type AppSettings,
  type ThemeMode,
  type AccentColor,
  type FontSize,
  type Density,
  getSavedSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  DEFAULT_CLASSES,
  saveSchoolClasses,
  loadAndSyncSchoolClasses,
} from '../lib/settings';
import './SettingsModal.css';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRestartTutorial?: () => void;
  onLockApp?: () => void;
}

const CLASS_PRESETS: { label: string; classes: string[] }[] = [
  {
    label: 'Grade 10–12 (A/B/C)',
    classes: ['10-A', '10-B', '10-C', '11-A', '11-B', '11-C', '12-A', '12-B', '12-C'],
  },
  {
    label: 'Year 7–11 (Sets 1-2)',
    classes: [
      'Year 7 Set 1', 'Year 7 Set 2',
      'Year 8 Set 1', 'Year 8 Set 2',
      'Year 9 Set 1', 'Year 9 Set 2',
      'Year 10 Set 1', 'Year 10 Set 2',
      'Year 11 Set 1', 'Year 11 Set 2',
    ],
  },
  {
    label: 'IB Diploma (HL/SL)',
    classes: ['IB-1 Chemistry HL', 'IB-1 Chemistry SL', 'IB-2 Chemistry HL', 'IB-2 Chemistry SL'],
  },
];

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
  const [newClassInput, setNewClassInput] = useState('');
  const [classNotice, setClassNotice] = useState<string | null>(null);
  const backdropDismiss = useBackdropDismiss(onClose);

  // Sync cloud classes on modal open
  useEffect(() => {
    if (isOpen) {
      loadAndSyncSchoolClasses().then((classes) => {
        setSettingsState((prev) => ({ ...prev, classes }));
      });
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const updated = { ...settings, [key]: value };
    setSettingsState(updated);
    saveSettings(updated);
  };

  const handleAddClass = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = newClassInput.trim();
    if (!trimmed) return;

    const currentClasses = settings.classes || DEFAULT_CLASSES;
    const exists = currentClasses.some((c) => c.toLowerCase() === trimmed.toLowerCase());
    if (exists) {
      setClassNotice(`"${trimmed}" is already in the list.`);
      setTimeout(() => setClassNotice(null), 3000);
      return;
    }

    const updatedClasses = [...currentClasses, trimmed];
    updateSetting('classes', updatedClasses);
    saveSchoolClasses(updatedClasses);
    setNewClassInput('');
    setClassNotice(`✓ Added "${trimmed}"`);
    setTimeout(() => setClassNotice(null), 2500);
  };

  const handleRemoveClass = (classToRemove: string) => {
    const currentClasses = settings.classes || DEFAULT_CLASSES;
    const filtered = currentClasses.filter((c) => c !== classToRemove);
    updateSetting('classes', filtered);
    saveSchoolClasses(filtered);
  };

  const handleApplyPreset = (presetClasses: string[]) => {
    updateSetting('classes', presetClasses);
    saveSchoolClasses(presetClasses);
    setClassNotice('✓ Applied class preset');
    setTimeout(() => setClassNotice(null), 2500);
  };

  const handleReset = () => {
    setSettingsState(DEFAULT_SETTINGS);
    saveSettings(DEFAULT_SETTINGS);
    saveSchoolClasses(DEFAULT_CLASSES);
  };

  return createPortal(
    <div className="settings-overlay" {...backdropDismiss}>
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

          {/* 5. Formal Exam Classes Configuration */}
          <div className="settings-section">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
              <h3 className="settings-section-title">🏫 Formal Exam Classes & Cohorts</h3>
              {classNotice && (
                <span className="settings-class-notice animate-fade-in">
                  {classNotice}
                </span>
              )}
            </div>
            <p style={{ margin: '0 0 4px', fontSize: '0.75rem', color: 'var(--color-text-secondary)', lineHeight: 1.4 }}>
              Configure the classes shown in the candidate registration drop-down menu during formal exams.
            </p>

            {/* Configured Classes Tag List */}
            <div className="settings-classes-wrap">
              {(settings.classes || DEFAULT_CLASSES).map((cls) => (
                <span key={cls} className="settings-class-chip">
                  <span className="settings-class-chip-icon">🏷️</span>
                  <span className="settings-class-chip-text">{cls}</span>
                  <button
                    type="button"
                    className="settings-class-chip-remove"
                    onClick={() => handleRemoveClass(cls)}
                    title={`Remove class ${cls}`}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>

            {/* Add New Class Form */}
            <form onSubmit={handleAddClass} className="settings-add-class-form">
              <input
                type="text"
                className="settings-add-class-input"
                placeholder="Type class name (e.g. 10-D, Year 11-1, IB HL)..."
                value={newClassInput}
                onChange={(e) => setNewClassInput(e.target.value)}
              />
              <button
                type="submit"
                className="settings-add-class-btn"
                disabled={!newClassInput.trim()}
              >
                + Add Class
              </button>
            </form>

            {/* Presets & Bulk Actions */}
            <div className="settings-class-presets-row">
              <span style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--color-text-tertiary)' }}>Presets:</span>
              {CLASS_PRESETS.map((p, pIdx) => (
                <button
                  key={pIdx}
                  type="button"
                  className="settings-preset-btn"
                  onClick={() => handleApplyPreset(p.classes)}
                  title={`Load ${p.classes.join(', ')}`}
                >
                  {p.label}
                </button>
              ))}
              <button
                type="button"
                className="settings-preset-btn settings-preset-btn--reset"
                onClick={() => handleApplyPreset(DEFAULT_CLASSES)}
                title="Reset to default Grade 10-12 classes"
              >
                ↺ Defaults
              </button>
            </div>
          </div>

          {/* 6. AI Extraction Preferences */}
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

          {/* 7. Assessment & Exam Security Defaults */}
          <div className="settings-section">
            <h3 className="settings-section-title">Exam Security Defaults</h3>
            <div className="settings-actions-list" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div className="settings-action-row">
                <div className="settings-action-info">
                  <span className="settings-action-name">💧 Candidate Dynamic Watermarking</span>
                  <span className="settings-action-desc">Overlay candidate name, ID, and hash on exam runner and question diagrams to deter leaks/photos</span>
                </div>
                <button
                  type="button"
                  className={`settings-seg-btn ${settings.defaultEnableWatermark ? 'settings-seg-btn--active' : ''}`}
                  style={{ flex: 'none', padding: '6px 16px' }}
                  onClick={() => updateSetting('defaultEnableWatermark', !settings.defaultEnableWatermark)}
                >
                  {settings.defaultEnableWatermark ? 'Enabled' : 'Disabled'}
                </button>
              </div>

              <div className="settings-action-row">
                <div className="settings-action-info">
                  <span className="settings-action-name">🖥️ Multi-Monitor Detection Shield</span>
                  <span className="settings-action-desc">Detect secondary displays / extended screens and log proctoring violations during timed exams</span>
                </div>
                <button
                  type="button"
                  className={`settings-seg-btn ${settings.defaultEnableMultiMonitor ? 'settings-seg-btn--active' : ''}`}
                  style={{ flex: 'none', padding: '6px 16px' }}
                  onClick={() => updateSetting('defaultEnableMultiMonitor', !settings.defaultEnableMultiMonitor)}
                >
                  {settings.defaultEnableMultiMonitor ? 'Enabled' : 'Disabled'}
                </button>
              </div>
            </div>
          </div>

          {/* 8. Tools & Management */}
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
    </div>,
    document.body
  );
}
