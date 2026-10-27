import { useState, useRef, useEffect } from 'react';
import { useTeacherProfile } from '../contexts/TeacherProfileContext';
import './TeacherProfileChip.css';

interface TeacherProfileChipProps {
  onOpenSwitchModal: () => void;
  onOpenSettingsModal: () => void;
}

export function TeacherProfileChip({
  onOpenSwitchModal,
  onOpenSettingsModal,
}: TeacherProfileChipProps) {
  const {
    activeProfile,
    showAllSubjects,
    toggleShowAllSubjects,
    lockProfile,
    isLocked,
  } = useTeacherProfile();

  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  if (!activeProfile) return null;

  const subjectIcon =
    activeProfile.subject.toLowerCase() === 'chemistry'
      ? '🧪'
      : activeProfile.subject.toLowerCase() === 'physics'
      ? '⚡'
      : activeProfile.subject.toLowerCase() === 'biology'
      ? '🧬'
      : '📚';

  return (
    <div className="teacher-chip-wrapper" ref={dropdownRef}>
      <button
        type="button"
        className={`teacher-chip-btn ${isLocked ? 'teacher-chip-btn--locked' : ''}`}
        onClick={() => setIsOpen((prev) => !prev)}
        aria-haspopup="true"
        aria-expanded={isOpen}
        title={`Active Teacher Profile: ${activeProfile.name} (${activeProfile.subject})`}
      >
        <span className="teacher-chip-icon" aria-hidden="true">
          {isLocked ? '🔒' : subjectIcon}
        </span>
        <div className="teacher-chip-meta">
          <span className="teacher-chip-name">{activeProfile.name}</span>
          <span className="teacher-chip-subject">
            {showAllSubjects ? 'All Subjects' : activeProfile.subject}
          </span>
        </div>
        <svg
          className={`teacher-chip-chevron ${isOpen ? 'teacher-chip-chevron--open' : ''}`}
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {isOpen && (
        <div className="teacher-chip-dropdown" role="menu">
          <div className="teacher-chip-dropdown-header">
            <span className="teacher-chip-dropdown-label">Active Workspace</span>
            <span className="teacher-chip-dropdown-classes">
              {activeProfile.default_classes.join(', ')}
            </span>
          </div>

          <div className="teacher-chip-dropdown-divider" />

          {/* Subject Isolation Quick Toggle */}
          <button
            type="button"
            className="teacher-chip-menu-item"
            role="menuitem"
            onClick={() => {
              toggleShowAllSubjects();
              setIsOpen(false);
            }}
          >
            <span className="teacher-chip-menu-icon" aria-hidden="true">
              {showAllSubjects ? '🔒' : '🌐'}
            </span>
            <div className="teacher-chip-menu-text">
              <span className="teacher-chip-menu-title">
                {showAllSubjects ? `Focus: ${activeProfile.subject} Only` : 'Show All Subjects'}
              </span>
              <span className="teacher-chip-menu-desc">
                {showAllSubjects
                  ? `Filter questions & tests to ${activeProfile.subject}`
                  : 'View materials across all departments'}
              </span>
            </div>
          </button>

          {/* Switch Profile */}
          <button
            type="button"
            className="teacher-chip-menu-item"
            role="menuitem"
            onClick={() => {
              setIsOpen(false);
              onOpenSwitchModal();
            }}
          >
            <span className="teacher-chip-menu-icon" aria-hidden="true">
              🔄
            </span>
            <div className="teacher-chip-menu-text">
              <span className="teacher-chip-menu-title">Switch Teacher Profile</span>
              <span className="teacher-chip-menu-desc">Change educator profile on this device</span>
            </div>
          </button>

          {/* Edit Profile & Preferences */}
          <button
            type="button"
            className="teacher-chip-menu-item"
            role="menuitem"
            onClick={() => {
              setIsOpen(false);
              onOpenSettingsModal();
            }}
          >
            <span className="teacher-chip-menu-icon" aria-hidden="true">
              ⚙️
            </span>
            <div className="teacher-chip-menu-text">
              <span className="teacher-chip-menu-title">Profile & Tool Settings</span>
              <span className="teacher-chip-menu-desc">Classes, 4-digit PIN, periodic table</span>
            </div>
          </button>

          {/* Lock Profile (if PIN enabled) */}
          {activeProfile.pin_hash && (
            <>
              <div className="teacher-chip-dropdown-divider" />
              <button
                type="button"
                className="teacher-chip-menu-item teacher-chip-menu-item--lock"
                role="menuitem"
                onClick={() => {
                  setIsOpen(false);
                  lockProfile();
                }}
              >
                <span className="teacher-chip-menu-icon" aria-hidden="true">
                  🔒
                </span>
                <div className="teacher-chip-menu-text">
                  <span className="teacher-chip-menu-title">Lock Profile</span>
                  <span className="teacher-chip-menu-desc">Requires 4-digit PIN to re-enter</span>
                </div>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
