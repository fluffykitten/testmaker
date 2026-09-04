import { useState, useEffect, useRef, type KeyboardEvent, type ClipboardEvent } from 'react';
import { BackupRestoreModal } from '../components/BackupRestoreModal';
import {
  type AppSettings,
  getSavedSettings,
  saveSettings,
  DEFAULT_CLASSES,
  saveSchoolClasses,
  loadAndSyncSchoolClasses,
  loadAndSyncGoogleDriveClientId,
  syncGoogleDriveClientIdToCloud,
} from '../lib/settings';
import {
  type RosterStudent,
  getSchoolRoster,
  saveSchoolRoster,
  loadAndSyncSchoolRoster,
  assignMissingPins,
  regenerateAllPins,
  parseBulkRosterText,
  exportRosterToExcel,
  generateRandom4DigitPin,
  parseExcelRosterFile,
  downloadSampleExcelTemplate,
} from '../services/studentRosterService';
import './AdvancedSettingsPage.css';

const ADVANCED_MASTER_PIN = '140798';
const ADVANCED_SESSION_KEY = 'testmaker_advanced_pin_verified';
const PIN_LENGTH = 6;

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

interface AdvancedSettingsPageProps {
  onBack: () => void;
}

export function AdvancedSettingsPage({ onBack }: AdvancedSettingsPageProps) {
  // Authentication State
  const [isUnlocked, setIsUnlocked] = useState(
    () => sessionStorage.getItem(ADVANCED_SESSION_KEY) === 'true'
  );
  const [pinDigits, setPinDigits] = useState<string[]>(Array(PIN_LENGTH).fill(''));
  const [pinError, setPinError] = useState('');
  const [isShaking, setIsShaking] = useState(false);
  const pinInputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Application & Roster Settings State
  const [settings, setSettingsState] = useState<AppSettings>(() => getSavedSettings());
  const [roster, setRoster] = useState<RosterStudent[]>(() => getSchoolRoster());
  const [activeSection, setActiveSection] = useState<'roster' | 'security' | 'cloud'>('roster');
  const [rosterSubTab, setRosterSubTab] = useState<'classes' | 'students'>('classes');
  const [selectedRosterClass, setSelectedRosterClass] = useState<string>('ALL');

  // School Classes Inputs
  const [newClassInput, setNewClassInput] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  // Student Directory Inputs
  const [newStudentName, setNewStudentName] = useState('');
  const [newStudentClass, setNewStudentClass] = useState('');
  const [newStudentNumber, setNewStudentNumber] = useState('');
  const [isBulkImportOpen, setIsBulkImportOpen] = useState(false);
  const [bulkImportText, setBulkImportText] = useState('');
  const [copiedPinStudentId, setCopiedPinStudentId] = useState<string | null>(null);

  // Excel File Upload
  const excelFileInputRef = useRef<HTMLInputElement>(null);
  const [isParsingExcel, setIsParsingExcel] = useState(false);

  // Cloud & Backup State
  const [isBackupModalOpen, setIsBackupModalOpen] = useState(false);
  const [googleClientIdInput, setGoogleClientIdInput] = useState(
    () => getSavedSettings().googleDriveClientId || ''
  );
  const [isSavingClientId, setIsSavingClientId] = useState(false);

  // Focus first pin digit on load if locked
  useEffect(() => {
    if (!isUnlocked) {
      setTimeout(() => pinInputRefs.current[0]?.focus(), 100);
    }
  }, [isUnlocked]);

  // Sync cloud classes, roster, and Google Drive ID on unlock
  useEffect(() => {
    if (isUnlocked) {
      loadAndSyncSchoolClasses().then((classes) => {
        setSettingsState((prev) => ({ ...prev, classes }));
      });
      loadAndSyncSchoolRoster().then((students) => {
        setRoster(students);
      });
      loadAndSyncGoogleDriveClientId().then((id) => {
        if (id) setGoogleClientIdInput(id);
      });
    }
  }, [isUnlocked]);

  const showNotice = (msg: string, duration = 3000) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), duration);
  };

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const updated = { ...settings, [key]: value };
    setSettingsState(updated);
    saveSettings(updated);
  };

  // ─── PIN Gate Handlers ───────────────────────────────────────────────────────
  const handlePinDigitChange = (index: number, val: string) => {
    const char = val.replace(/\D/g, '').slice(-1);
    const updated = [...pinDigits];
    updated[index] = char;
    setPinDigits(updated);
    setPinError('');

    if (char && index < PIN_LENGTH - 1) {
      pinInputRefs.current[index + 1]?.focus();
    }

    if (char && index === PIN_LENGTH - 1) {
      const fullPin = updated.join('');
      if (fullPin.length === PIN_LENGTH) {
        verifyMasterPin(fullPin);
      }
    }
  };

  const handlePinKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      if (!pinDigits[index] && index > 0) {
        const updated = [...pinDigits];
        updated[index - 1] = '';
        setPinDigits(updated);
        pinInputRefs.current[index - 1]?.focus();
        e.preventDefault();
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      pinInputRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < PIN_LENGTH - 1) {
      pinInputRefs.current[index + 1]?.focus();
    } else if (e.key === 'Enter') {
      const fullPin = pinDigits.join('');
      if (fullPin.length === PIN_LENGTH) {
        verifyMasterPin(fullPin);
      }
    }
  };

  const handlePinPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, PIN_LENGTH);
    if (!pasted) return;

    const updated = Array(PIN_LENGTH).fill('');
    for (let i = 0; i < pasted.length; i++) {
      updated[i] = pasted[i];
    }
    setPinDigits(updated);
    setPinError('');

    const focusIdx = Math.min(pasted.length, PIN_LENGTH - 1);
    pinInputRefs.current[focusIdx]?.focus();

    if (pasted.length === PIN_LENGTH) {
      verifyMasterPin(pasted);
    }
  };

  const verifyMasterPin = (entered: string) => {
    if (entered === ADVANCED_MASTER_PIN) {
      sessionStorage.setItem(ADVANCED_SESSION_KEY, 'true');
      setIsUnlocked(true);
      setPinError('');
    } else {
      setIsShaking(true);
      setPinError('Incorrect Master PIN. Access denied.');
      setTimeout(() => {
        setIsShaking(false);
        setPinDigits(Array(PIN_LENGTH).fill(''));
        pinInputRefs.current[0]?.focus();
      }, 600);
    }
  };

  const handleLockSettings = () => {
    sessionStorage.removeItem(ADVANCED_SESSION_KEY);
    setIsUnlocked(false);
    setPinDigits(Array(PIN_LENGTH).fill(''));
  };

  // ─── School Classes Handlers ────────────────────────────────────────────────
  const handleAddClass = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const trimmed = newClassInput.trim();
    if (!trimmed) return;

    const currentClasses = settings.classes || DEFAULT_CLASSES;
    const exists = currentClasses.some((c) => c.toLowerCase() === trimmed.toLowerCase());
    if (exists) {
      showNotice(`"${trimmed}" is already in the list.`);
      return;
    }

    const updatedClasses = [...currentClasses, trimmed];
    updateSetting('classes', updatedClasses);
    saveSchoolClasses(updatedClasses);
    setNewClassInput('');
    showNotice(`✓ Added class "${trimmed}"`);
  };

  const handleRemoveClass = (classToRemove: string) => {
    const currentClasses = settings.classes || DEFAULT_CLASSES;
    const filtered = currentClasses.filter((c) => c !== classToRemove);
    updateSetting('classes', filtered);
    saveSchoolClasses(filtered);
    showNotice(`Removed class "${classToRemove}"`);
  };

  const handleApplyPreset = (presetClasses: string[]) => {
    updateSetting('classes', presetClasses);
    saveSchoolClasses(presetClasses);
    showNotice('✓ Applied class preset');
  };

  // ─── Student Directory Handlers ─────────────────────────────────────────────
  const handleAddStudent = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const name = newStudentName.trim();
    if (!name) return;

    const assignedClass = newStudentClass || (settings.classes && settings.classes[0]) || '10-A';
    const newStudent: RosterStudent = {
      id: crypto.randomUUID(),
      name,
      class: assignedClass,
      candidateNumber: newStudentNumber.trim() || undefined,
      pin: generateRandom4DigitPin(),
      createdAt: new Date().toISOString(),
    };

    const updated = [...roster, newStudent];
    setRoster(updated);
    saveSchoolRoster(updated);
    setNewStudentName('');
    setNewStudentNumber('');
    showNotice(`✓ Added candidate "${name}" (4-Digit PIN: ${newStudent.pin})`);
  };

  const handleDeleteStudent = (id: string) => {
    const updated = roster.filter((s) => s.id !== id);
    setRoster(updated);
    saveSchoolRoster(updated);
  };

  const handleRegeneratePins = () => {
    if (roster.length === 0) return;
    if (confirm('Regenerate fresh 4-digit PINs for ALL students in the school directory?')) {
      const updated = regenerateAllPins(roster);
      setRoster(updated);
      saveSchoolRoster(updated);
      showNotice(`✓ Generated fresh 4-digit PINs for ${updated.length} students`);
    }
  };

  const handleExportRosterExcel = () => {
    if (roster.length === 0) {
      alert('No students found in roster to export.');
      return;
    }
    exportRosterToExcel(roster, selectedRosterClass);
    showNotice('✓ Exported class roster Excel spreadsheet');
  };

  const handleExecuteBulkImport = () => {
    const raw = bulkImportText.trim();
    if (!raw) return;
    const defaultCls = (settings.classes && settings.classes[0]) || '10-A';
    const parsed = parseBulkRosterText(raw, defaultCls);
    if (parsed.length === 0) {
      alert('Could not parse any student names. Please check format.');
      return;
    }

    const merged = assignMissingPins([...roster, ...parsed]);
    setRoster(merged);
    saveSchoolRoster(merged);
    setBulkImportText('');
    setIsBulkImportOpen(false);
    showNotice(`✓ Successfully imported ${parsed.length} students with 4-digit PINs`);
  };

  const handleCopyPin = (studentId: string, pin: string) => {
    navigator.clipboard.writeText(pin);
    setCopiedPinStudentId(studentId);
    setTimeout(() => setCopiedPinStudentId(null), 2000);
  };

  // ─── Excel File Import Handler ──────────────────────────────────────────────
  const handleExcelFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsParsingExcel(true);
    try {
      const parsed = await parseExcelRosterFile(file);
      if (parsed.students.length === 0) {
        alert('No student records found in the uploaded Excel file. Please ensure there is a Name and Class column.');
        return;
      }

      // 1. Merge detected classes with current active classes
      const currentClasses = settings.classes || DEFAULT_CLASSES;
      const combinedClassesSet = new Set<string>(currentClasses);
      for (const cls of parsed.detectedClasses) {
        if (cls && cls.trim()) {
          combinedClassesSet.add(cls.trim());
        }
      }
      const updatedClasses = Array.from(combinedClassesSet);
      updateSetting('classes', updatedClasses);
      saveSchoolClasses(updatedClasses);

      // 2. Merge parsed students with existing roster without duplicate name+class
      const existingKeySet = new Set<string>(
        roster.map((s) => `${s.class.toLowerCase()}_${s.name.toLowerCase()}`)
      );
      const newUniqueStudents = parsed.students.filter(
        (s) => !existingKeySet.has(`${s.class.toLowerCase()}_${s.name.toLowerCase()}`)
      );

      const mergedRoster = assignMissingPins([...roster, ...newUniqueStudents]);
      setRoster(mergedRoster);
      saveSchoolRoster(mergedRoster);

      showNotice(
        `✓ Imported ${parsed.students.length} students across ${parsed.detectedClasses.length} classes (${parsed.detectedClasses.join(', ')})!`,
        5000
      );
    } catch (err: any) {
      console.error('Excel import error:', err);
      alert(`Failed to import Excel file: ${err?.message || 'Invalid format'}`);
    } finally {
      setIsParsingExcel(false);
      if (excelFileInputRef.current) {
        excelFileInputRef.current.value = '';
      }
    }
  };

  const handleDownloadTemplate = () => {
    downloadSampleExcelTemplate();
    showNotice('✓ Downloaded Students & Classes Excel template');
  };

  // ─── Google Drive Client ID Sync ────────────────────────────────────────────
  const handleSaveGoogleClientId = async () => {
    const trimmed = googleClientIdInput.trim();
    setIsSavingClientId(true);
    updateSetting('googleDriveClientId', trimmed);
    const ok = await syncGoogleDriveClientIdToCloud(trimmed);
    setIsSavingClientId(false);
    if (ok) {
      showNotice('✓ Google OAuth Client ID saved & synced to cloud');
    } else {
      showNotice('✓ Saved locally (Cloud sync check app_config)');
    }
  };

  // ═════════════════════════════════════════════════════════════════════════════
  // VIEW 1: LOCKED PIN GATE
  // ═════════════════════════════════════════════════════════════════════════════
  if (!isUnlocked) {
    return (
      <div className="adv-pin-page">
        <div className="adv-pin-card-wrapper">
          <div className={`adv-pin-card ${isShaking ? 'adv-pin-card--shaking' : ''}`}>
            <div className="adv-pin-icon-wrap">
              <span className="adv-pin-shield-icon">🛡️</span>
            </div>

            <div className="adv-pin-badge">Restricted Administration</div>
            <h1 className="adv-pin-title">Master Administrator PIN</h1>
            <p className="adv-pin-desc">
              Please enter the 6-digit Master PIN to unlock School Classes, Student Directory & 4-Digit PINs, Exam Security Defaults, and Cloud Backups.
            </p>

            {/* 6-Digit PIN Boxes */}
            <div className="adv-pin-digits-row" onPaste={handlePinPaste}>
              {pinDigits.map((digit, idx) => (
                <input
                  key={idx}
                  ref={(el) => {
                    pinInputRefs.current[idx] = el;
                  }}
                  type="password"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={1}
                  value={digit}
                  onChange={(e) => handlePinDigitChange(idx, e.target.value)}
                  onKeyDown={(e) => handlePinKeyDown(idx, e)}
                  className={`adv-pin-input-box ${digit ? 'adv-pin-input-box--filled' : ''} ${pinError ? 'adv-pin-input-box--error' : ''}`}
                  autoComplete="off"
                />
              ))}
            </div>

            {pinError && <div className="adv-pin-error-msg">{pinError}</div>}

            <div className="adv-pin-actions">
              <button
                type="button"
                className="adv-pin-submit-btn"
                onClick={() => verifyMasterPin(pinDigits.join(''))}
                disabled={pinDigits.join('').length !== PIN_LENGTH}
              >
                Unlock Advanced Settings
              </button>

              <button
                type="button"
                className="adv-pin-cancel-btn"
                onClick={onBack}
              >
                ← Back to Dashboard
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ═════════════════════════════════════════════════════════════════════════════
  // VIEW 2: UNLOCKED ADVANCED SETTINGS DASHBOARD
  // ═════════════════════════════════════════════════════════════════════════════
  return (
    <div className="adv-settings-page">
      {/* ─── Top Bar ─────────────────────────────────────────────────────────── */}
      <div className="adv-topbar">
        <div className="adv-topbar-inner">
          <div className="adv-topbar-left">
            <button
              type="button"
              className="adv-back-btn"
              onClick={onBack}
              title="Return to primary app navigation"
            >
              ← Back to Dashboard
            </button>
            <div className="adv-topbar-title-wrap">
              <span className="adv-topbar-badge">🛡️ Master Admin Area</span>
              <h1 className="adv-topbar-title">Advanced Administration & Security</h1>
            </div>
          </div>

          <div className="adv-topbar-right">
            {notice && (
              <span className="adv-notice-pill animate-fade-in">{notice}</span>
            )}
            <button
              type="button"
              className="adv-lock-btn"
              onClick={handleLockSettings}
              title="Immediately lock access requiring PIN 140798 again"
            >
              🔒 Lock Settings
            </button>
          </div>
        </div>
      </div>

      {/* Hidden File Input for Excel Import */}
      <input
        type="file"
        ref={excelFileInputRef}
        accept=".xlsx,.xls,.csv"
        onChange={handleExcelFileSelect}
        style={{ display: 'none' }}
      />

      <div className="adv-page-container">
        {/* ─── Navigation Tabs ───────────────────────────────────────────────── */}
        <div className="adv-nav-tabs">
          <button
            type="button"
            className={`adv-tab-btn ${activeSection === 'roster' ? 'adv-tab-btn--active' : ''}`}
            onClick={() => setActiveSection('roster')}
          >
            🏫 School Classes & Student Directory
            <span className="adv-tab-counter">{(settings.classes || DEFAULT_CLASSES).length} classes · {roster.length} students</span>
          </button>

          <button
            type="button"
            className={`adv-tab-btn ${activeSection === 'security' ? 'adv-tab-btn--active' : ''}`}
            onClick={() => setActiveSection('security')}
          >
            🛡️ Exam Security Defaults
            <span className="adv-tab-counter">Watermarking · Multi-Monitor · Auto-Lock</span>
          </button>

          <button
            type="button"
            className={`adv-tab-btn ${activeSection === 'cloud' ? 'adv-tab-btn--active' : ''}`}
            onClick={() => setActiveSection('cloud')}
          >
            💾 Cloud Backup & Storage Safety
            <span className="adv-tab-counter">Supabase · Google Drive OAuth</span>
          </button>
        </div>

        {/* ─── SECTION 1: School Classes & Student Directory ─────────────────── */}
        {activeSection === 'roster' && (
          <div className="adv-section-card">
            <div className="adv-section-header">
              <div>
                <h2 className="adv-section-title">🏫 School Classes & Student Directory</h2>
                <p className="adv-section-subtitle">
                  Configure school class cohorts, candidate directories, and unique 4-digit exam PINs. Import classes and students directly from Excel spreadsheets.
                </p>
              </div>

              {/* Sub-tab switcher */}
              <div className="adv-subtab-switch">
                <button
                  type="button"
                  className={`adv-subtab-btn ${rosterSubTab === 'classes' ? 'adv-subtab-btn--active' : ''}`}
                  onClick={() => setRosterSubTab('classes')}
                >
                  🏷️ Classes & Cohorts ({(settings.classes || DEFAULT_CLASSES).length})
                </button>
                <button
                  type="button"
                  className={`adv-subtab-btn ${rosterSubTab === 'students' ? 'adv-subtab-btn--active' : ''}`}
                  onClick={() => setRosterSubTab('students')}
                >
                  👨‍🎓 Student Directory & 4-Digit PINs ({roster.length})
                </button>
              </div>
            </div>

            {/* Excel Import Banner */}
            <div className="adv-excel-banner">
              <div className="adv-excel-banner-info">
                <span className="adv-excel-icon">📊</span>
                <div>
                  <strong className="adv-excel-title">Import Classes & Students from Excel</strong>
                  <span className="adv-excel-subtitle">
                    Upload an Excel (.xlsx, .xls, .csv) spreadsheet. All unique classes and candidate rosters are gathered in one click!
                  </span>
                </div>
              </div>
              <div className="adv-excel-banner-actions">
                <button
                  type="button"
                  className="adv-btn-secondary"
                  onClick={handleDownloadTemplate}
                  title="Download sample Excel template"
                >
                  📥 Download Template
                </button>
                <button
                  type="button"
                  className="adv-btn-primary"
                  onClick={() => excelFileInputRef.current?.click()}
                  disabled={isParsingExcel}
                >
                  {isParsingExcel ? '⏳ Parsing Sheet...' : '📁 Choose Excel File'}
                </button>
              </div>
            </div>

            {rosterSubTab === 'classes' ? (
              <div className="adv-classes-pane">
                <h3 className="adv-subheading">Active School Classes</h3>
                <div className="adv-class-chip-wrap">
                  {(settings.classes || DEFAULT_CLASSES).map((cls) => (
                    <span key={cls} className="adv-class-chip">
                      <span className="adv-class-chip-tag">🏷️</span>
                      <span className="adv-class-chip-name">{cls}</span>
                      <button
                        type="button"
                        className="adv-class-chip-del"
                        onClick={() => handleRemoveClass(cls)}
                        title={`Remove class ${cls}`}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>

                {/* Add Class Form */}
                <form onSubmit={handleAddClass} className="adv-add-class-form">
                  <input
                    type="text"
                    className="adv-input"
                    placeholder="Enter new class (e.g. 10-D, IB HL, Year 11-1)..."
                    value={newClassInput}
                    onChange={(e) => setNewClassInput(e.target.value)}
                  />
                  <button
                    type="submit"
                    className="adv-btn-primary"
                    disabled={!newClassInput.trim()}
                  >
                    + Add Class
                  </button>
                </form>

                {/* Presets */}
                <div className="adv-presets-row">
                  <span className="adv-presets-label">Class Presets:</span>
                  {CLASS_PRESETS.map((preset, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className="adv-btn-secondary adv-btn-sm"
                      onClick={() => handleApplyPreset(preset.classes)}
                    >
                      {preset.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="adv-btn-secondary adv-btn-sm adv-btn-danger-outline"
                    onClick={() => handleApplyPreset(DEFAULT_CLASSES)}
                  >
                    ↺ Reset Defaults
                  </button>
                </div>
              </div>
            ) : (
              <div className="adv-students-pane">
                {/* Students Toolbar */}
                <div className="adv-students-toolbar">
                  <select
                    className="adv-input adv-select-filter"
                    value={selectedRosterClass}
                    onChange={(e) => setSelectedRosterClass(e.target.value)}
                  >
                    <option value="ALL">All Classes ({roster.length} Candidates)</option>
                    {(settings.classes || DEFAULT_CLASSES).map((cls) => (
                      <option key={cls} value={cls}>
                        {cls} ({roster.filter((s) => s.class === cls).length} students)
                      </option>
                    ))}
                  </select>

                  <div className="adv-toolbar-actions">
                    <button
                      type="button"
                      className="adv-btn-secondary"
                      onClick={() => setIsBulkImportOpen(true)}
                    >
                      📋 Paste Text
                    </button>
                    <button
                      type="button"
                      className="adv-btn-secondary"
                      onClick={handleRegeneratePins}
                      title="Regenerate fresh 4-digit PINs for all candidates"
                    >
                      🔄 Re-roll PINs
                    </button>
                    <button
                      type="button"
                      className="adv-btn-secondary"
                      onClick={handleExportRosterExcel}
                      title="Export candidate list with 4-digit PIN slips to Excel"
                    >
                      📊 Export to Excel
                    </button>
                  </div>
                </div>

                {/* Add Student Inline Form */}
                <form onSubmit={handleAddStudent} className="adv-add-student-form">
                  <input
                    type="text"
                    className="adv-input"
                    placeholder="Candidate full name..."
                    value={newStudentName}
                    onChange={(e) => setNewStudentName(e.target.value)}
                    style={{ flex: '2 1 200px' }}
                  />
                  <select
                    className="adv-input"
                    value={newStudentClass || (settings.classes && settings.classes[0]) || '10-A'}
                    onChange={(e) => setNewStudentClass(e.target.value)}
                    style={{ flex: '1 1 120px' }}
                  >
                    {(settings.classes || DEFAULT_CLASSES).map((cls) => (
                      <option key={cls} value={cls}>{cls}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    className="adv-input"
                    placeholder="Candidate # (opt)"
                    value={newStudentNumber}
                    onChange={(e) => setNewStudentNumber(e.target.value)}
                    style={{ flex: '1 1 100px' }}
                  />
                  <button
                    type="submit"
                    className="adv-btn-primary"
                    disabled={!newStudentName.trim()}
                  >
                    + Add Student
                  </button>
                </form>

                {/* Student Table */}
                <div className="adv-table-container">
                  {roster.filter((s) => selectedRosterClass === 'ALL' || s.class === selectedRosterClass).length === 0 ? (
                    <div className="adv-table-empty">
                      No students found in {selectedRosterClass === 'ALL' ? 'the directory' : selectedRosterClass}. Upload an Excel file above or add a candidate.
                    </div>
                  ) : (
                    <table className="adv-table">
                      <thead>
                        <tr>
                          <th>Candidate Full Name</th>
                          <th style={{ width: '110px' }}>Class</th>
                          <th style={{ width: '110px' }}>Cand #</th>
                          <th style={{ width: '140px' }}>4-Digit PIN</th>
                          <th style={{ width: '40px' }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {roster
                          .filter((s) => selectedRosterClass === 'ALL' || s.class === selectedRosterClass)
                          .map((student) => (
                            <tr key={student.id}>
                              <td className="adv-table-name">{student.name}</td>
                              <td className="adv-table-sub">{student.class}</td>
                              <td className="adv-table-sub">{student.candidateNumber || '-'}</td>
                              <td>
                                <span
                                  onClick={() => handleCopyPin(student.id, student.pin)}
                                  className={`adv-pin-chip ${copiedPinStudentId === student.id ? 'adv-pin-chip--copied' : ''}`}
                                  title="Click to copy PIN to clipboard"
                                >
                                  {student.pin}
                                  <span className="adv-pin-chip-icon">
                                    {copiedPinStudentId === student.id ? '✓' : '📋'}
                                  </span>
                                </span>
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="adv-table-del-btn"
                                  onClick={() => handleDeleteStudent(student.id)}
                                  title={`Remove ${student.name}`}
                                >
                                  ✕
                                </button>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  )}
                </div>

                {/* Bulk Import Paste Dialog */}
                {isBulkImportOpen && (
                  <div className="adv-bulk-paste-dialog">
                    <div className="adv-bulk-header">
                      <strong>📋 Paste Student Roster (from Excel or CSV)</strong>
                      <button
                        type="button"
                        className="adv-bulk-close"
                        onClick={() => setIsBulkImportOpen(false)}
                      >
                        ✕
                      </button>
                    </div>
                    <p className="adv-bulk-help">
                      Paste one student per line. Format: <code>Candidate Name, Class, Candidate # (optional)</code>
                    </p>
                    <textarea
                      rows={5}
                      className="adv-input adv-bulk-textarea"
                      placeholder="Alex Johnson, 10-A, 001&#10;Samantha Lee, 10-A, 002&#10;David Miller, 10-B, 003"
                      value={bulkImportText}
                      onChange={(e) => setBulkImportText(e.target.value)}
                    />
                    <div className="adv-bulk-actions">
                      <button
                        type="button"
                        className="adv-btn-secondary"
                        onClick={() => setIsBulkImportOpen(false)}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="adv-btn-primary"
                        disabled={!bulkImportText.trim()}
                        onClick={handleExecuteBulkImport}
                      >
                        Import Students & Generate PINs
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* ─── SECTION 2: Exam Security Defaults ─────────────────────────────── */}
        {activeSection === 'security' && (
          <div className="adv-section-card">
            <div className="adv-section-header">
              <div>
                <h2 className="adv-section-title">🛡️ Exam Security Defaults</h2>
                <p className="adv-section-subtitle">
                  Configure default integrity protections, candidate watermarking, multi-monitor shields, and automatic lockouts.
                </p>
              </div>
            </div>

            <div className="adv-settings-grid">
              {/* Dynamic Watermark */}
              <div className="adv-setting-card">
                <div className="adv-setting-info">
                  <strong className="adv-setting-title">💧 Candidate Dynamic Watermarking</strong>
                  <p className="adv-setting-desc">
                    Overlays candidate full name, student ID, and randomized timestamp hash across questions and diagrams to deter screen photos and exam leaks.
                  </p>
                </div>
                <button
                  type="button"
                  className={`adv-toggle-btn ${settings.defaultEnableWatermark ? 'adv-toggle-btn--active' : ''}`}
                  onClick={() => updateSetting('defaultEnableWatermark', !settings.defaultEnableWatermark)}
                >
                  {settings.defaultEnableWatermark ? 'Enabled' : 'Disabled'}
                </button>
              </div>

              {/* Multi-Monitor Detection */}
              <div className="adv-setting-card">
                <div className="adv-setting-info">
                  <strong className="adv-setting-title">🖥️ Multi-Monitor Detection Shield</strong>
                  <p className="adv-setting-desc">
                    Detects extended desktop displays and dual-screen configurations. Logs proctoring violations and warns students if unauthorized screens are detected.
                  </p>
                </div>
                <button
                  type="button"
                  className={`adv-toggle-btn ${settings.defaultEnableMultiMonitor ? 'adv-toggle-btn--active' : ''}`}
                  onClick={() => updateSetting('defaultEnableMultiMonitor', !settings.defaultEnableMultiMonitor)}
                >
                  {settings.defaultEnableMultiMonitor ? 'Enabled' : 'Disabled'}
                </button>
              </div>

              {/* Inactivity Auto-Lock */}
              <div className="adv-setting-card">
                <div className="adv-setting-info">
                  <strong className="adv-setting-title">⏱️ Inactivity Auto-Lock</strong>
                  <p className="adv-setting-desc">
                    Automatically locks the Teacher Suite if the computer is left idle on a desk or connected to a classroom projector.
                  </p>
                </div>
                <select
                  className="adv-input adv-select-width"
                  value={settings.autoLockMinutes ?? 15}
                  onChange={(e) => updateSetting('autoLockMinutes', parseInt(e.target.value, 10))}
                >
                  <option value={5}>5 Minutes</option>
                  <option value={15}>15 Minutes (Default)</option>
                  <option value={30}>30 Minutes</option>
                  <option value={0}>Never (Disabled)</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {/* ─── SECTION 3: Cloud Backup & Storage Safety ──────────────────────── */}
        {activeSection === 'cloud' && (
          <div className="adv-section-card">
            <div className="adv-section-header">
              <div>
                <h2 className="adv-section-title">💾 Cloud Backup & Storage Safety</h2>
                <p className="adv-section-subtitle">
                  Manage full offline database backups, Google Drive automated snapshots, and inspect Supabase storage quotas.
                </p>
              </div>
            </div>

            <div className="adv-settings-grid">
              {/* Backup Modal Trigger Card */}
              <div className="adv-setting-card">
                <div className="adv-setting-info">
                  <strong className="adv-setting-title">💾 Supabase & Google Drive Backup Suite</strong>
                  <p className="adv-setting-desc">
                    Download full offline ZIP snapshots of your question bank, saved tests, and diagrams, or synchronize directly with Google Drive cloud folders.
                  </p>
                </div>
                <button
                  type="button"
                  className="adv-btn-primary"
                  onClick={() => setIsBackupModalOpen(true)}
                >
                  Open Backup Suite
                </button>
              </div>

              {/* Google Drive OAuth Client ID Management */}
              <div className="adv-setting-card adv-setting-card--vertical">
                <div className="adv-setting-info">
                  <strong className="adv-setting-title">🔑 Google OAuth Client ID</strong>
                  <p className="adv-setting-desc">
                    Configure your Google Drive Web Client ID. Stored securely in both local cache and Supabase <code>app_config</code> so it never disappears across sessions.
                  </p>
                </div>
                <div className="adv-input-action-row">
                  <input
                    type="text"
                    className="adv-input adv-input-mono"
                    placeholder="e.g. 123456789-abcdefg.apps.googleusercontent.com"
                    value={googleClientIdInput}
                    onChange={(e) => setGoogleClientIdInput(e.target.value)}
                  />
                  <button
                    type="button"
                    className="adv-btn-primary"
                    onClick={handleSaveGoogleClientId}
                    disabled={isSavingClientId}
                  >
                    {isSavingClientId ? 'Saving...' : 'Save & Sync Client ID'}
                  </button>
                </div>
              </div>

              {/* Architecture & Quota Safety Summary */}
              <div className="adv-setting-card adv-setting-card--info">
                <span className="adv-info-icon">💡</span>
                <div className="adv-setting-info">
                  <strong className="adv-setting-title">Storage Safety Guarantee</strong>
                  <p className="adv-setting-desc">
                    Student auto-saves use single-row in-place <code>UPSERT</code> operations in Supabase. 100 students doing an exam consume only ~0.5 MB total (less than 0.1% of the Supabase free tier).
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <BackupRestoreModal
        isOpen={isBackupModalOpen}
        onClose={() => setIsBackupModalOpen(false)}
      />
    </div>
  );
}
