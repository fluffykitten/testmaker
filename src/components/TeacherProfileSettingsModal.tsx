import { useState, useEffect } from 'react';
import { useTeacherProfile } from '../contexts/TeacherProfileContext';
import { changeOwnTeacherPassword } from '../services/teacherProfileService';
import { getSchoolClasses, DEFAULT_CLASSES } from '../lib/settings';
import './TeacherProfileSettingsModal.css';

interface TeacherProfileSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}



export function TeacherProfileSettingsModal({
  isOpen,
  onClose,
}: TeacherProfileSettingsModalProps) {
  const { activeProfile, updateCurrentProfile } = useTeacherProfile();

  // Dynamic school classes / cohorts from admin configuration
  const [availableClasses, setAvailableClasses] = useState<string[]>(() => {
    const list = getSchoolClasses();
    return list.length > 0 ? list : DEFAULT_CLASSES;
  });

  useEffect(() => {
    function handleClassesUpdated(e: Event) {
      const customEvent = e as CustomEvent<{ classes?: string[] }>;
      if (customEvent.detail?.classes) {
        setAvailableClasses(customEvent.detail.classes);
      } else {
        setAvailableClasses(getSchoolClasses());
      }
    }
    window.addEventListener('school_classes_updated', handleClassesUpdated);
    return () => window.removeEventListener('school_classes_updated', handleClassesUpdated);
  }, []);

  const [name, setName] = useState('');
  const [title, setTitle] = useState('Dr.');
  const [selectedCohorts, setSelectedCohorts] = useState<string[]>(() => {
    const list = getSchoolClasses();
    return list.length > 0 ? [list[0]] : DEFAULT_CLASSES.slice(0, 2);
  });
  const [autoPeriodicTable, setAutoPeriodicTable] = useState(true);
  const [defaultCalc, setDefaultCalc] = useState<'scientific' | 'basic'>('scientific');

  // PIN settings
  const [pinChangeMode, setPinChangeMode] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [removePin, setRemovePin] = useState(false);

  // Self-service login password change state
  const [passwordChangeMode, setPasswordChangeMode] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newLoginPassword, setNewLoginPassword] = useState('');
  const [confirmLoginPassword, setConfirmLoginPassword] = useState('');

  const [isSaving, setIsSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  useEffect(() => {
    if (activeProfile && isOpen) {
      setName(activeProfile.name);
      setTitle(activeProfile.title || 'Dr.');
      setSelectedCohorts(Array.isArray(activeProfile.default_classes) && activeProfile.default_classes.length > 0 ? activeProfile.default_classes : [availableClasses[0] || '10-A']);
      setAutoPeriodicTable(activeProfile.preferences.autoEnablePeriodicTable ?? true);
      setDefaultCalc(activeProfile.preferences.defaultCalculator ?? 'scientific');
      setPinChangeMode(false);
      setNewPin('');
      setRemovePin(false);
      setPasswordChangeMode(Boolean(activeProfile.must_change_password));
      setCurrentPassword('');
      setNewLoginPassword('');
      setConfirmLoginPassword('');
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

    if (passwordChangeMode) {
      if (activeProfile.has_password && !currentPassword) {
        setErrorMsg('Please enter your current login password');
        return;
      }
      if (newLoginPassword.trim().length < 6) {
        setErrorMsg('New login password must be at least 6 characters');
        return;
      }
      if (newLoginPassword !== confirmLoginPassword) {
        setErrorMsg('New login password and confirmation do not match');
        return;
      }
    }

    setIsSaving(true);
    setErrorMsg('');
    try {
      if (passwordChangeMode) {
        const pwRes = await changeOwnTeacherPassword(
          currentPassword,
          newLoginPassword,
          activeProfile.id
        );
        if (pwRes.status !== 'ok') {
          setErrorMsg(pwRes.error || 'Failed to update login password.');
          setIsSaving(false);
          return;
        }
      }

      let pinUpdate: string | null | undefined = undefined;
      if (pinChangeMode) {
        pinUpdate = removePin ? null : newPin.trim();
      }

      await updateCurrentProfile({
        name: name.trim(),
        title: title.trim(),
        default_classes: selectedCohorts.length > 0 ? selectedCohorts : [availableClasses[0] || '10-A'],
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

            {/* Multi-select Cohort: Dynamic school classes from Admin configuration */}
            <div className="teacher-field">
              <label className="teacher-label">Default Teaching Cohorts / Classes (Multi-Select)</label>
              <div className="teacher-cohort-buttons" role="group" aria-label="Select Teaching Cohorts">
                {availableClasses.map((cls) => {
                  const isSelected = selectedCohorts.includes(cls);
                  return (
                    <button
                      key={cls}
                      type="button"
                      className={`teacher-cohort-btn ${isSelected ? 'teacher-cohort-btn--selected' : ''}`}
                      onClick={() => toggleCohort(cls)}
                      aria-pressed={isSelected}
                    >
                      <span className="teacher-cohort-check">{isSelected ? '✓' : '+'}</span>
                      <span>{cls}</span>
                    </button>
                  );
                })}
              </div>
              <span className="teacher-field-hint">
                Select the classes you teach. Test filters and student rosters will adapt.
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

          {/* Account Login & Password Section */}
          <div className="teacher-settings-section">
            <span className="teacher-settings-section-title">
              Account Login &amp; Password ({activeProfile.role === 'admin' ? '🛡️ Admin' : '👩‍🏫 Teacher'})
            </span>

            {(activeProfile.username || activeProfile.email) && (
              <div style={{ fontSize: '0.82rem', color: 'var(--color-text-secondary, #64748b)', marginBottom: '8px' }}>
                Signed in as:{' '}
                <strong>
                  {activeProfile.username ? `@${activeProfile.username}` : ''}
                  {activeProfile.username && activeProfile.email ? ' • ' : ''}
                  {activeProfile.email || ''}
                </strong>
              </div>
            )}

            {!passwordChangeMode ? (
              <div className="teacher-pin-status-row">
                <span className="teacher-pin-status">
                  {activeProfile.has_password ? '🔑 Personal login password configured' : '🔓 No login password set'}
                </span>
                <button
                  type="button"
                  className="teacher-change-pin-btn"
                  onClick={() => setPasswordChangeMode(true)}
                >
                  Change Login Password
                </button>
              </div>
            ) : (
              <div className="teacher-pin-edit-box" style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {activeProfile.has_password && (
                  <div className="teacher-field">
                    <label htmlFor="settings-current-pw" className="teacher-label">Current Password</label>
                    <input
                      id="settings-current-pw"
                      type="password"
                      placeholder="Enter current password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      className="teacher-text-input"
                      autoComplete="current-password"
                    />
                  </div>
                )}
                <div className="teacher-input-row">
                  <div className="teacher-field">
                    <label htmlFor="settings-new-pw" className="teacher-label">New Password (min 6 chars)</label>
                    <input
                      id="settings-new-pw"
                      type="password"
                      placeholder="New password"
                      value={newLoginPassword}
                      onChange={(e) => setNewLoginPassword(e.target.value)}
                      className="teacher-text-input"
                      autoComplete="new-password"
                    />
                  </div>
                  <div className="teacher-field">
                    <label htmlFor="settings-confirm-pw" className="teacher-label">Confirm New Password</label>
                    <input
                      id="settings-confirm-pw"
                      type="password"
                      placeholder="Confirm password"
                      value={confirmLoginPassword}
                      onChange={(e) => setConfirmLoginPassword(e.target.value)}
                      className="teacher-text-input"
                      autoComplete="new-password"
                    />
                  </div>
                </div>
                {!activeProfile.must_change_password && (
                  <button
                    type="button"
                    className="teacher-secondary-btn"
                    style={{ alignSelf: 'flex-start', padding: '4px 10px', fontSize: '0.78rem' }}
                    onClick={() => {
                      setPasswordChangeMode(false);
                      setCurrentPassword('');
                      setNewLoginPassword('');
                      setConfirmLoginPassword('');
                    }}
                  >
                    Cancel Password Change
                  </button>
                )}
              </div>
            )}
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
