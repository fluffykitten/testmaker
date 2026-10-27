import { useState, useEffect } from 'react';
import { useTeacherProfile } from '../contexts/TeacherProfileContext';
import { createTeacherProfile } from '../services/teacherProfileService';
import { getSchoolSubjects, DEFAULT_SUBJECTS, getSchoolClasses, DEFAULT_CLASSES } from '../lib/settings';
import type { TeacherProfile } from '../types/database';
import './TeacherProfileModal.css';

interface TeacherProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
}



const KNOWN_SYLLABUS_CODES: Record<string, string> = {
  Chemistry: '0620',
  Physics: '0625',
  Biology: '0610',
  Mathematics: '0580',
  English: '0500',
  Geography: '0460',
  Economics: '0455',
  Sociology: '0495',
  PAI: '',
  Arabic: '',
  'Bahasa Indonesia': '',
};

function getSubjectIcon(subject: string): string {
  const s = (subject || '').toLowerCase();
  if (s.includes('chem')) return '🧪';
  if (s.includes('phys')) return '⚡';
  if (s.includes('bio')) return '🧬';
  if (s.includes('math')) return '📐';
  if (s.includes('eng')) return '📖';
  if (s.includes('geo')) return '🌍';
  if (s.includes('econ')) return '📈';
  if (s.includes('socio')) return '⚖️';
  if (s.includes('pai') || s.includes('islam')) return '🕌';
  if (s.includes('arab')) return '📜';
  if (s.includes('indonesia')) return '🇮🇩';
  return '📚';
}

export function TeacherProfileModal({ isOpen, onClose }: TeacherProfileModalProps) {
  const { profiles, activeProfile, switchProfile, refreshProfiles } = useTeacherProfile();

    // Dynamic school subjects from settings
  const [availableSubjects, setAvailableSubjects] = useState<string[]>(() => {
    const list = getSchoolSubjects();
    return list.length > 0 ? list : DEFAULT_SUBJECTS;
  });

  // Dynamic school classes / cohorts from admin configuration
  const [availableClasses, setAvailableClasses] = useState<string[]>(() => {
    const list = getSchoolClasses();
    return list.length > 0 ? list : DEFAULT_CLASSES;
  });

  // Listen for admin changes to classes
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

  // Listen for admin changes to subjects
  useEffect(() => {
    function handleSubjectsUpdated(e: Event) {
      const customEvent = e as CustomEvent<{ subjects?: string[] }>;
      if (customEvent.detail?.subjects) {
        setAvailableSubjects(customEvent.detail.subjects);
      } else {
        setAvailableSubjects(getSchoolSubjects());
      }
    }
    window.addEventListener('school_subjects_updated', handleSubjectsUpdated);
    return () => window.removeEventListener('school_subjects_updated', handleSubjectsUpdated);
  }, []);

  // Mode: 'list' | 'pin_prompt' | 'create'
  const [modalMode, setModalMode] = useState<'list' | 'pin_prompt' | 'create'>('list');
  const [selectedTarget, setSelectedTarget] = useState<TeacherProfile | null>(null);

  // PIN Prompt State
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState('');

  // Create Profile Form State
  const [newName, setNewName] = useState('');
  const [newTitle, setNewTitle] = useState('Dr.');
  const [newSubject, setNewSubject] = useState('Chemistry');
  const [newSubjectCode, setNewSubjectCode] = useState('0620');
  const [selectedCohorts, setSelectedCohorts] = useState<string[]>(() => {
    const list = getSchoolClasses();
    return list.length > 0 ? [list[0]] : DEFAULT_CLASSES.slice(0, 2);
  });
  const [newPin, setNewPin] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createError, setCreateError] = useState('');

  useEffect(() => {
    if (isOpen) {
      setModalMode('list');
      setPinInput('');
      setPinError('');
      setCreateError('');
    }
  }, [isOpen]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && isOpen) {
        if (modalMode !== 'list') {
          setModalMode('list');
        } else if (activeProfile) {
          onClose();
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, modalMode, onClose, activeProfile]);

  if (!isOpen) return null;

  const toggleCohort = (grade: string) => {
    setSelectedCohorts((prev) => {
      if (prev.includes(grade)) {
        const next = prev.filter((g) => g !== grade);
        return next.length > 0 ? next : [grade]; // keep at least 1 grade
      }
      return [...prev, grade].sort();
    });
  };

  async function handleSelectProfile(profile: TeacherProfile) {
    if (activeProfile && profile.id === activeProfile.id) {
      onClose();
      return;
    }

    if (profile.pin_hash) {
      setSelectedTarget(profile);
      setPinInput('');
      setPinError('');
      setModalMode('pin_prompt');
    } else {
      const res = await switchProfile(profile.id);
      if (res.success) {
        onClose();
      }
    }
  }

  async function handlePinSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedTarget) return;

    if (pinInput.trim().length !== 4) {
      setPinError('PIN must be 4 digits');
      return;
    }

    const res = await switchProfile(selectedTarget.id, pinInput);
    if (res.success) {
      onClose();
    } else {
      setPinError(res.error || 'Incorrect PIN');
    }
  }

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) {
      setCreateError('Please enter teacher name');
      return;
    }

    if (newPin.trim() && newPin.trim().length !== 4) {
      setCreateError('Optional PIN must be exactly 4 digits');
      return;
    }

    setIsSubmitting(true);
    setCreateError('');
    try {
      const created = await createTeacherProfile({
        name: newName.trim(),
        title: newTitle.trim(),
        subject: newSubject.trim(),
        subject_code: newSubjectCode.trim() || '',
        default_classes: selectedCohorts.length > 0 ? selectedCohorts : [availableClasses[0] || '10-A'],
        pin: newPin.trim() || undefined,
        preferences: {
          autoEnablePeriodicTable: newSubject.toLowerCase() === 'chemistry',
          defaultCalculator: 'scientific',
          showOtherSubjects: false,
        },
      });

      await refreshProfiles();
      await switchProfile(created.id, newPin.trim() || undefined);
      onClose();
    } catch {
      setCreateError('Failed to create profile. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  const isFirstTimeOnboarding = !activeProfile;

  return (
    <div className="teacher-modal-overlay" role="dialog" aria-modal="true">
      <div className="teacher-modal-card">
        {/* Modal Header */}
        <div className="teacher-modal-header">
          <div>
            <h2 className="teacher-modal-title">
              {modalMode === 'list' && (isFirstTimeOnboarding ? 'Welcome! Select Educator Profile' : 'Select Teacher Profile')}
              {modalMode === 'pin_prompt' && 'Enter 4-Digit Teacher PIN'}
              {modalMode === 'create' && 'Create Teacher Profile'}
            </h2>
            <p className="teacher-modal-subtitle">
              {modalMode === 'list' && (isFirstTimeOnboarding
                ? 'Choose an available educator profile or create a new one to begin.'
                : 'Pick your educator workspace to isolate tests and student data.')}
              {modalMode === 'pin_prompt' && `Protected profile: ${selectedTarget?.name}`}
              {modalMode === 'create' && 'Set up your subject and cohort defaults for this device.'}
            </p>
          </div>
          {/* Only show close button if a profile is already active */}
          {!isFirstTimeOnboarding && (
            <button
              type="button"
              className="teacher-modal-close-btn"
              onClick={onClose}
              aria-label="Close modal"
            >
              ✕
            </button>
          )}
        </div>

        {/* Modal Content */}
        <div className="teacher-modal-body">
          {/* Mode 1: List Profiles */}
          {modalMode === 'list' && (
            <div className="teacher-list-view">
              {isFirstTimeOnboarding && (
                <div className="teacher-onboarding-banner">
                  <span className="teacher-onboarding-icon" aria-hidden="true">👋</span>
                  <div>
                    <strong>Welcome to ICM Test Maker & Creative Mode</strong>
                    <p>
                      Please select an available teacher profile below, or create a brand new profile for your subject.
                    </p>
                  </div>
                </div>
              )}

              <div className="teacher-cards-grid">
                {profiles.map((p) => {
                  const isActive = p.id === activeProfile?.id;
                  const icon = getSubjectIcon(p.subject);

                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`teacher-profile-card ${isActive ? 'teacher-profile-card--active' : ''}`}
                      onClick={() => handleSelectProfile(p)}
                    >
                      <div className="teacher-card-icon">{icon}</div>
                      <div className="teacher-card-info">
                        <div className="teacher-card-name-row">
                          <span className="teacher-card-name">{p.name}</span>
                          {isActive && <span className="teacher-card-active-tag">Active</span>}
                          {p.pin_hash && <span className="teacher-card-pin-tag" title="Protected with 4-digit PIN">🔒 PIN</span>}
                        </div>
                        <span className="teacher-card-subject">
                          {p.subject}{p.subject_code ? ` (${p.subject_code})` : ''}
                        </span>
                        <span className="teacher-card-classes">
                          Cohorts: {p.default_classes.join(', ')}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>

              <div className="teacher-list-footer">
                <button
                  type="button"
                  className="teacher-create-btn"
                  onClick={() => setModalMode('create')}
                >
                  <span>+ New Teacher Profile</span>
                </button>
              </div>
            </div>
          )}

          {/* Mode 2: PIN Prompt */}
          {modalMode === 'pin_prompt' && (
            <form onSubmit={handlePinSubmit} className="teacher-pin-form">
              <p className="teacher-pin-desc">
                Enter the 4-digit security PIN for <strong>{selectedTarget?.name}</strong> to unlock this workspace.
              </p>

              <div className="teacher-pin-input-group">
                <input
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  autoFocus
                  placeholder="••••"
                  value={pinInput}
                  onChange={(e) => {
                    const val = e.target.value.replace(/\D/g, '').slice(0, 4);
                    setPinInput(val);
                    setPinError('');
                  }}
                  className="teacher-pin-input"
                />
              </div>

              {pinError && <div className="teacher-form-error">{pinError}</div>}

              <div className="teacher-form-actions">
                <button
                  type="button"
                  className="teacher-secondary-btn"
                  onClick={() => setModalMode('list')}
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={pinInput.length !== 4}
                  className="teacher-primary-btn"
                >
                  Verify & Enter
                </button>
              </div>
            </form>
          )}

          {/* Mode 3: Create Profile */}
          {modalMode === 'create' && (
            <form onSubmit={handleCreateSubmit} className="teacher-create-form">
              {createError && <div className="teacher-form-error">{createError}</div>}

              <div className="teacher-input-row">
                <div className="teacher-field teacher-field--sm">
                  <label htmlFor="teacher-title" className="teacher-label">Title</label>
                  <select
                    id="teacher-title"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
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
                  <label htmlFor="teacher-name" className="teacher-label">Teacher Name *</label>
                  <input
                    id="teacher-name"
                    type="text"
                    required
                    placeholder="e.g. Budi Santoso"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="teacher-text-input"
                  />
                </div>
              </div>

              <div className="teacher-input-row">
                <div className="teacher-field">
                  <label htmlFor="teacher-subject" className="teacher-label">Primary Subject *</label>
                  <select
                    id="teacher-subject"
                    value={newSubject}
                    onChange={(e) => {
                      const val = e.target.value;
                      setNewSubject(val);
                      if (KNOWN_SYLLABUS_CODES[val] !== undefined) {
                        setNewSubjectCode(KNOWN_SYLLABUS_CODES[val]);
                      }
                    }}
                    className="teacher-select"
                  >
                    {availableSubjects.map((subj) => (
                      <option key={subj} value={subj}>
                        {subj}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="teacher-field">
                  <label htmlFor="teacher-subject-code" className="teacher-label">
                    Syllabus Code <span className="teacher-label-optional">(Optional)</span>
                  </label>
                  <input
                    id="teacher-subject-code"
                    type="text"
                    placeholder="e.g. 0620 (Optional)"
                    value={newSubjectCode}
                    onChange={(e) => setNewSubjectCode(e.target.value)}
                    className="teacher-text-input"
                  />
                </div>
              </div>

              {/* Multi-select Cohort: Dynamic school classes from Admin configuration */}
              <div className="teacher-field">
                <label className="teacher-label">Teaching Cohorts / Classes (Multi-Select)</label>
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
                  Select all classes you teach. Test filters and student rosters will adapt.
                </span>
              </div>

              <div className="teacher-field">
                <label htmlFor="teacher-pin" className="teacher-label">
                  Optional 4-Digit Security PIN <span className="teacher-label-optional">(Leave blank for 1-click access)</span>
                </label>
                <input
                  id="teacher-pin"
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  placeholder="Optional PIN (e.g. 1234)"
                  value={newPin}
                  onChange={(e) => setNewPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  className="teacher-text-input"
                />
              </div>

              <div className="teacher-form-actions">
                <button
                  type="button"
                  className="teacher-secondary-btn"
                  onClick={() => setModalMode('list')}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || !newName.trim()}
                  className="teacher-primary-btn"
                >
                  {isSubmitting ? 'Creating…' : 'Create & Activate Workspace'}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
