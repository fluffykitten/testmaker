import { useState, useEffect } from 'react';
import { useTeacherProfile } from '../contexts/TeacherProfileContext';
import { createTeacherProfile } from '../services/teacherProfileService';
import type { TeacherProfile } from '../types/database';
import './TeacherProfileModal.css';

interface TeacherProfileModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function TeacherProfileModal({ isOpen, onClose }: TeacherProfileModalProps) {
  const { profiles, activeProfile, switchProfile, refreshProfiles } = useTeacherProfile();

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
  const [newClasses, setNewClasses] = useState('10-A, 11-A');
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
        } else {
          onClose();
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, modalMode, onClose]);

  if (!isOpen) return null;

  async function handleSelectProfile(profile: TeacherProfile) {
    if (profile.id === activeProfile?.id) {
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
      const classesArray = newClasses
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);

      const created = await createTeacherProfile({
        name: newName.trim(),
        title: newTitle.trim(),
        subject: newSubject.trim(),
        subject_code: newSubjectCode.trim(),
        default_classes: classesArray.length > 0 ? classesArray : ['10-A', '11-A'],
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

  return (
    <div className="teacher-modal-overlay" role="dialog" aria-modal="true">
      <div className="teacher-modal-card">
        {/* Modal Header */}
        <div className="teacher-modal-header">
          <div>
            <h2 className="teacher-modal-title">
              {modalMode === 'list' && 'Select Teacher Profile'}
              {modalMode === 'pin_prompt' && 'Enter 4-Digit Teacher PIN'}
              {modalMode === 'create' && 'Create Teacher Profile'}
            </h2>
            <p className="teacher-modal-subtitle">
              {modalMode === 'list' && 'Pick your educator workspace to isolate tests and student data.'}
              {modalMode === 'pin_prompt' && `Protected profile: ${selectedTarget?.name}`}
              {modalMode === 'create' && 'Set up your subject and default classes for this device.'}
            </p>
          </div>
          <button
            type="button"
            className="teacher-modal-close-btn"
            onClick={onClose}
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        {/* Modal Content */}
        <div className="teacher-modal-body">
          {/* Mode 1: List Profiles */}
          {modalMode === 'list' && (
            <div className="teacher-list-view">
              <div className="teacher-cards-grid">
                {profiles.map((p) => {
                  const isActive = p.id === activeProfile?.id;
                  const icon =
                    p.subject.toLowerCase() === 'chemistry'
                      ? '🧪'
                      : p.subject.toLowerCase() === 'physics'
                      ? '⚡'
                      : p.subject.toLowerCase() === 'biology'
                      ? '🧬'
                      : '📚';

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
                          {p.subject} ({p.subject_code})
                        </span>
                        <span className="teacher-card-classes">
                          Classes: {p.default_classes.join(', ')}
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
                      if (val === 'Chemistry') setNewSubjectCode('0620');
                      else if (val === 'Physics') setNewSubjectCode('0625');
                      else if (val === 'Biology') setNewSubjectCode('0610');
                      else if (val === 'Mathematics') setNewSubjectCode('0580');
                      else if (val === 'English') setNewSubjectCode('0500');
                    }}
                    className="teacher-select"
                  >
                    <option value="Chemistry">Chemistry</option>
                    <option value="Physics">Physics</option>
                    <option value="Biology">Biology</option>
                    <option value="Mathematics">Mathematics</option>
                    <option value="English">English</option>
                    <option value="Geography">Geography</option>
                    <option value="Economics">Economics</option>
                  </select>
                </div>
                <div className="teacher-field">
                  <label htmlFor="teacher-subject-code" className="teacher-label">Syllabus Code *</label>
                  <input
                    id="teacher-subject-code"
                    type="text"
                    required
                    placeholder="e.g. 0620"
                    value={newSubjectCode}
                    onChange={(e) => setNewSubjectCode(e.target.value)}
                    className="teacher-text-input"
                  />
                </div>
              </div>

              <div className="teacher-field">
                <label htmlFor="teacher-classes" className="teacher-label">Default Teaching Cohorts (comma-separated)</label>
                <input
                  id="teacher-classes"
                  type="text"
                  placeholder="e.g. 10-A, 11-A, 12-B"
                  value={newClasses}
                  onChange={(e) => setNewClasses(e.target.value)}
                  className="teacher-text-input"
                />
              </div>

              <div className="teacher-field">
                <label htmlFor="teacher-pin" className="teacher-label">Optional 4-Digit Security PIN (Leave blank for 1-click access)</label>
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
