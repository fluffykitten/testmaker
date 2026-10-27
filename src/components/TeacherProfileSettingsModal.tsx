import { useState, useEffect } from 'react';
import { useTeacherProfile } from '../contexts/TeacherProfileContext';
import './TeacherProfileSettingsModal.css';

interface TeacherProfileSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const COHORT_OPTIONS = ['Grade 10', 'Grade 11', 'Grade 12'] as const;

function parseCohortsToGrades(classes: string[]): string[] {
  const grades = new Set<string>();
  for (const c of classes) {
    if (c.includes('10')) grades.add('Grade 10');
    if (c.includes('11')) grades.add('Grade 11');
    if (c.includes('12')) grades.add('Grade 12');
  }
  return grades.size > 0 ? Array.from(grades).sort() : ['Grade 10'];
}

export function TeacherProfileSettingsModal({
  isOpen,
  onClose,
}: TeacherProfileSettingsModalProps) {
  const { activeProfile, updateCurrentProfile } = useTeacherProfile();

  const [name, setName] = useState('');
  const [title, setTitle] = useState('Dr.');
  const [selectedCohorts, setSelectedCohorts] = useState<string[]>(['Grade 10', 'Grade 11']);
  const [autoPeriodicTable, setAutoPeriodicTable] = useState(true);
  const [defaultCalc, setDefaultCalc] = useState<'scientific' | 'basic'>('scientific');

  // PIN settings
  const [pinChangeMode, setPinChangeMode] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [removePin, setRemovePin] = useState(false);

  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  useEffect(() => {
    if (activeProfile && isOpen) {
      setName(activeProfile.name);
      setTitle(activeProfile.title || 'Dr.');
      setSelectedCohorts(parseCohortsToGrades(activeProfile.default_classes));
      setAutoPeriodicTable(activeProfile.preferences.autoEnablePeriodicTable ?? true);
      setDefaultCalc(activeProfile.preferences.defaultCalculator ?? 'scientific');
      setPinChangeMode(false);
      setNewPin('');
      setRemovePin(false);
      setErrorMsg('');
      setSuccessMsg('');
    }
  }, [activeProfile, isOpen]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !activeProfile) return null;

  const toggleCohort = (grade: string) => {
    setSelectedCohorts((prev) => {
      if (prev.includes(grade)) {
        const next = prev.filter((g) => g !== grade);
        return next.length > 0 ? next : [grade];
      }
      return [...prev, grade].sort();
    });
  };

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!activeProfile) return;
    if (!name.trim()) {
      setErrorMsg('Teacher name cannot be empty');
      return;
    }

    if (pinChangeMode && !removePin && newPin.trim().length !== 4) {
      setErrorMsg('PIN must be exactly 4 digits (or check Remove PIN)');
      return;
    }

    setIsSaving(true);
    setErrorMsg('');
    try {
      let pinUpdate: string | null | undefined = undefined;
      if (pinChangeMode) {
        pinUpdate = removePin ? null : newPin.trim();
      }

      await updateCurrentProfile({
        name: name.trim(),
        title: title.trim(),
        default_classes: selectedCohorts.length > 0 ? selectedCohorts : ['Grade 10'],
        preferences: {
          ...activeProfile.preferences,
          autoEnablePeriodicTable: autoPeriodicTable,
          defaultCalculator: defaultCalc,
        },
        newPin: pinUpdate,
      });

      setSuccessMsg('Profile updated successfully!');
      setTimeout(() => {
        onClose();
      }, 700);
    } catch {
      setErrorMsg('Failed to update profile settings.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="teacher-settings-overlay" role="dialog" aria-modal="true">
      <div className="teacher-settings-card">
        <div className="teacher-settings-header">
          <div>
            <h2 className="teacher-settings-title">Teacher Profile & Tool Settings</h2>
            <p className="teacher-settings-subtitle">
              Configure your workspace preferences and subject defaults.
            </p>
          </div>
          <button
            type="button"
            className="teacher-settings-close-btn"
            onClick={onClose}
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSave} className="teacher-settings-form">
          {errorMsg && <div className="teacher-settings-error">{errorMsg}</div>}
          {successMsg && <div className="teacher-settings-success">{successMsg}</div>}

          {/* Identity Section */}
          <div className="teacher-settings-section">
            <span className="teacher-settings-section-title">Identity & Cohorts</span>

            <div className="teacher-input-row">
              <div className="teacher-field teacher-field--sm">
                <label htmlFor="settings-title" className="teacher-label">Title</label>
                <select
                  id="settings-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="teacher-select"
                >
                  <option value="Dr.">Dr.</option>
                  <option value="Mr.">Mr.</option>
                  <option value="Ms.">Ms.</option>
                  <option value="Mrs.">Mrs.</option>
                  <option value="Ibu">Ibu</option>
                  <option value="Pak">Pak</option>
                  <option value="Ustadz">Ustadz</option>
                  <option value="Ustadzah">Ustadzah</option>
                </select>
              </div>
              <div className="teacher-field teacher-field--lg">
                <label htmlFor="settings-name" className="teacher-label">Teacher Name</label>
                <input
                  id="settings-name"
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="teacher-text-input"
                />
              </div>
            </div>

            {/* Multi-select Cohort: Grade 10, Grade 11, Grade 12 */}
            <div className="teacher-field">
              <label className="teacher-label">Default Teaching Cohorts (Multi-Select)</label>
              <div className="teacher-cohort-buttons" role="group" aria-label="Select Teaching Cohorts">
                {COHORT_OPTIONS.map((grade) => {
                  const isSelected = selectedCohorts.includes(grade);
                  return (
                    <button
                      key={grade}
                      type="button"
                      className={`teacher-cohort-btn ${isSelected ? 'teacher-cohort-btn--selected' : ''}`}
                      onClick={() => toggleCohort(grade)}
                      aria-pressed={isSelected}
                    >
                      <span className="teacher-cohort-check">{isSelected ? '✓' : '+'}</span>
                      <span>{grade}</span>
                    </button>
                  );
                })}
              </div>
              <span className="teacher-field-hint">
                These grades will be pre-selected when authoring exams or viewing student directories.
              </span>
            </div>
          </div>

          {/* Subject Exam Tools Defaults */}
          <div className="teacher-settings-section">
            <span className="teacher-settings-section-title">
              Subject Exam Defaults ({activeProfile.subject}{activeProfile.subject_code ? ` ${activeProfile.subject_code}` : ''})
            </span>

            <label className="teacher-checkbox-label">
              <input
                type="checkbox"
                checked={autoPeriodicTable}
                onChange={(e) => setAutoPeriodicTable(e.target.checked)}
                className="teacher-checkbox"
              />
              <div>
                <span className="teacher-checkbox-title">Auto-Enable Cambridge Periodic Table Drawer</span>
                <span className="teacher-checkbox-desc">
                  Automatically enables the landscape periodic table drawer for student assessments and Creative Mode.
                </span>
              </div>
            </label>

            <div className="teacher-field" style={{ marginTop: '10px' }}>
              <label htmlFor="settings-calc" className="teacher-label">Default Student Calculator</label>
              <select
                id="settings-calc"
                value={defaultCalc}
                onChange={(e) => setDefaultCalc(e.target.value as 'scientific' | 'basic')}
                className="teacher-select"
              >
                <option value="scientific">Scientific (Trigonometry, Radicals, Powers)</option>
                <option value="basic">Basic (Standard arithmetic only)</option>
              </select>
            </div>
          </div>

          {/* Security PIN Section */}
          <div className="teacher-settings-section">
            <span className="teacher-settings-section-title">Profile Security (4-Digit PIN)</span>

            {!pinChangeMode ? (
              <div className="teacher-pin-status-row">
                <span className="teacher-pin-status">
                  {activeProfile.pin_hash ? '🔒 Protected with 4-digit PIN' : '🔓 PIN-free (1-click access)'}
                </span>
                <button
                  type="button"
                  className="teacher-change-pin-btn"
                  onClick={() => setPinChangeMode(true)}
                >
                  {activeProfile.pin_hash ? 'Change or Remove PIN' : 'Set 4-Digit PIN'}
                </button>
              </div>
            ) : (
              <div className="teacher-pin-edit-box">
                {activeProfile.pin_hash && (
                  <label className="teacher-checkbox-label" style={{ marginBottom: '8px' }}>
                    <input
                      type="checkbox"
                      checked={removePin}
                      onChange={(e) => setRemovePin(e.target.checked)}
                      className="teacher-checkbox"
                    />
                    <span>Remove PIN (Switch to 1-click access)</span>
                  </label>
                )}

                {!removePin && (
                  <div className="teacher-field">
                    <label htmlFor="settings-new-pin" className="teacher-label">New 4-Digit PIN</label>
                    <input
                      id="settings-new-pin"
                      type="password"
                      inputMode="numeric"
                      maxLength={4}
                      placeholder="••••"
                      value={newPin}
                      onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                      className="teacher-text-input teacher-text-input--pin"
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="teacher-form-actions">
            <button
              type="button"
              className="teacher-secondary-btn"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSaving}
              className="teacher-primary-btn"
            >
              {isSaving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
