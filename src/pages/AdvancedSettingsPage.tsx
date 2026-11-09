import { useState, useEffect, useRef, type KeyboardEvent, type ClipboardEvent } from 'react';
import { BackupRestoreModal } from '../components/BackupRestoreModal';
import {
  type AppSettings,
  getSavedSettings,
  saveSettings,
  DEFAULT_CLASSES,
  DEFAULT_SUBJECTS,
  saveSchoolClasses,
  loadAndSyncSchoolClasses,
  getSchoolSubjects,
  saveSchoolSubjects,
  loadAndSyncSchoolSubjects,
  loadAndSyncGoogleDriveClientId,
  syncGoogleDriveClientIdToCloud,
  saveCreativeModeLandingVisibility,
  loadAndSyncCreativeModeLandingVisibility,
  getGeminiExtractionModel,
  saveGeminiExtractionModel,
  syncGeminiExtractionModelToCloud,
  loadAndSyncGeminiExtractionModel,
  getGeminiApiKeyTier,
  saveGeminiApiKeyTier,
  syncGeminiApiKeyTierToCloud,
  loadAndSyncGeminiApiKeyTier,
  type GeminiApiKeyTier,
} from '../lib/settings';
import { testR2Connection } from '../services/storageService';
import { testGeminiModelConnectivity, getConfiguredApiKeyStatus } from '../lib/gemini';
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
  const [rosterSubTab, setRosterSubTab] = useState<'classes' | 'students' | 'subjects'>('classes');
  const [subjects, setSubjects] = useState<string[]>(() => getSchoolSubjects());
  const [newSubjectInput, setNewSubjectInput] = useState('');
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

  // Cloudflare R2 Media Proxy State
  const [r2EndpointInput, setR2EndpointInput] = useState(
    () => getSavedSettings().r2MediaEndpoint || 'https://testmaker-media.icmadani.workers.dev'
  );
  const [r2SecretInput, setR2SecretInput] = useState(
    () => getSavedSettings().r2UploadSecret || 'tm_r2_uploader_secret_2026'
  );
  const [isTestingR2, setIsTestingR2] = useState(false);
  const [r2TestResult, setR2TestResult] = useState<{ ok: boolean; latencyMs?: number; error?: string } | null>(null);

  // Gemini AI Extraction Model & Key Tier State
  const initialModel = getGeminiExtractionModel();
  const isInitialPreset = initialModel === 'gemini-3.5-flash-lite' || initialModel === 'gemini-3.8-flash';
  const [geminiModelPreset, setGeminiModelPreset] = useState<'gemini-3.5-flash-lite' | 'gemini-3.8-flash' | 'custom'>(
    () => (isInitialPreset ? (initialModel as 'gemini-3.5-flash-lite' | 'gemini-3.8-flash') : 'custom')
  );
  const [customModelInput, setCustomModelInput] = useState(() => (isInitialPreset ? '' : initialModel));
  const [geminiKeyTier, setGeminiKeyTier] = useState<GeminiApiKeyTier>(() => getGeminiApiKeyTier());
  const [isTestingModel, setIsTestingModel] = useState(false);
  const [modelTestFeedback, setModelTestFeedback] = useState<{ ok: boolean; message: string } | null>(null);
  const [isSavingModel, setIsSavingModel] = useState(false);
  const keySlotStatus = getConfiguredApiKeyStatus(geminiKeyTier);

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
      loadAndSyncSchoolSubjects().then((subjs) => {
        setSubjects(subjs);
      });
      loadAndSyncGoogleDriveClientId().then((id) => {
        if (id) setGoogleClientIdInput(id);
      });
      loadAndSyncCreativeModeLandingVisibility().then((hide) => {
        setSettingsState((prev) => ({ ...prev, hideCreativeModeOnLanding: hide }));
      });
      loadAndSyncGeminiExtractionModel().then((cloudModel) => {
        if (cloudModel) {
          const isPreset = cloudModel === 'gemini-3.5-flash-lite' || cloudModel === 'gemini-3.8-flash';
          setGeminiModelPreset(isPreset ? (cloudModel as 'gemini-3.5-flash-lite' | 'gemini-3.8-flash') : 'custom');
          if (!isPreset) {
            setCustomModelInput(cloudModel);
          }
          setSettingsState((prev) => ({ ...prev, geminiExtractionModel: cloudModel }));
        }
      });
      loadAndSyncGeminiApiKeyTier().then((cloudTier) => {
        if (cloudTier) {
          setGeminiKeyTier(cloudTier);
          setSettingsState((prev) => ({ ...prev, geminiApiKeyTier: cloudTier }));
        }
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

  const handleToggleHideCreativeMode = (hide: boolean) => {
    updateSetting('hideCreativeModeOnLanding', hide);
    saveCreativeModeLandingVisibility(hide);
    showNotice(
      hide
        ? '✓ Creative Mode Hub & Avatar Studio hidden from student landing page'
        : '✓ Creative Mode Hub & Avatar Studio now visible on landing page'
    );
  };

  const handleSaveGeminiModel = async () => {
    const finalModel = geminiModelPreset === 'custom' ? customModelInput.trim() : geminiModelPreset;
    if (!finalModel) {
      showNotice('Please provide a valid Gemini model identifier.');
      return;
    }
    setIsSavingModel(true);
    try {
      saveGeminiExtractionModel(finalModel);
      saveGeminiApiKeyTier(geminiKeyTier);
      const updated = {
        ...settings,
        geminiExtractionModel: finalModel,
        geminiApiKeyTier: geminiKeyTier,
      };
      setSettingsState(updated);
      saveSettings(updated);
      const [modelSynced, tierSynced] = await Promise.all([
        syncGeminiExtractionModelToCloud(finalModel),
        syncGeminiApiKeyTierToCloud(geminiKeyTier),
      ]);
      const tierLabel =
        geminiKeyTier === 'paid'
          ? 'Paid Key'
          : geminiKeyTier === 'free'
            ? 'Free Key'
            : 'Auto-Failover (Paid + Free)';
      if (modelSynced || tierSynced) {
        showNotice(`✓ Gemini config saved & synced to cloud: "${finalModel}" (${tierLabel})`);
      } else {
        showNotice(`✓ Gemini config saved locally: "${finalModel}" (${tierLabel})`);
      }
    } finally {
      setIsSavingModel(false);
    }
  };

  const handleTestGeminiModel = async () => {
    const targetModel = geminiModelPreset === 'custom' ? customModelInput.trim() : geminiModelPreset;
    if (!targetModel) {
      setModelTestFeedback({ ok: false, message: 'Please enter a custom model name to test.' });
      return;
    }
    setIsTestingModel(true);
    setModelTestFeedback(null);
    try {
      const res = await testGeminiModelConnectivity(targetModel, undefined, geminiKeyTier);
      setModelTestFeedback({ ok: res.ok, message: res.message });
    } catch (err: any) {
      setModelTestFeedback({ ok: false, message: err?.message || 'Failed to ping Gemini API.' });
    } finally {
      setIsTestingModel(false);
    }
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

  // ─── School Subjects Handlers ────────────────────────────────────────────────
  const handleAddSubject = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newSubjectInput.trim();
    if (!trimmed) return;
    if (subjects.map((s) => s.toLowerCase()).includes(trimmed.toLowerCase())) {
      showNotice(`Subject "${trimmed}" already exists.`);
      return;
    }
    const updated = [...subjects, trimmed];
    setSubjects(updated);
    saveSchoolSubjects(updated);
    setNewSubjectInput('');
    showNotice(`✓ Added "${trimmed}" to school subjects & synced to cloud`);
  };

  const handleRemoveSubject = (subjToRemove: string) => {
    if (subjects.length <= 1) {
      showNotice('At least one subject must remain configured.');
      return;
    }
    const updated = subjects.filter((s) => s !== subjToRemove);
    setSubjects(updated);
    saveSchoolSubjects(updated);
    showNotice(`✓ Removed "${subjToRemove}" from school subjects`);
  };

  const handleResetSubjects = () => {
    if (window.confirm('Reset all academic subjects to ICM default list?')) {
      setSubjects(DEFAULT_SUBJECTS);
      saveSchoolSubjects(DEFAULT_SUBJECTS);
      showNotice('✓ Reset subjects to school defaults');
    }
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

  // ─── Cloudflare R2 Media Proxy Handlers ───────────────────────────────────────
  const handleSaveR2Config = () => {
    updateSetting('r2MediaEndpoint', r2EndpointInput.trim());
    updateSetting('r2UploadSecret', r2SecretInput.trim());
    showNotice('✓ Cloudflare R2 media endpoint & secret saved');
  };

  const handleTestR2Connection = async () => {
    setIsTestingR2(true);
    setR2TestResult(null);
    try {
      const res = await testR2Connection();
      setR2TestResult(res);
      if (res.ok) {
        showNotice(`✓ Cloudflare R2 connection active! Latency: ${res.latencyMs}ms`);
      } else {
        showNotice(`⚠️ Cloudflare R2 test notice: ${res.error}`);
      }
    } finally {
      setIsTestingR2(false);
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
            <span className="adv-tab-counter">{(settings.classes || DEFAULT_CLASSES).length} classes · {subjects.length} subjects · {roster.length} students</span>
          </button>

          <button
            type="button"
            className={`adv-tab-btn ${activeSection === 'security' ? 'adv-tab-btn--active' : ''}`}
            onClick={() => setActiveSection('security')}
          >
            🛡️ Exam Security & Feature Controls
            <span className="adv-tab-counter">Watermarking · Creative Mode · Auto-Lock</span>
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
                <button
                  type="button"
                  className={`adv-subtab-btn ${rosterSubTab === 'subjects' ? 'adv-subtab-btn--active' : ''}`}
                  onClick={() => setRosterSubTab('subjects')}
                >
                  📚 Primary Subjects ({subjects.length})
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
            ) : rosterSubTab === 'students' ? (
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
            ) : (
              <div className="adv-subjects-pane" style={{ padding: '20px 0 0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '10px' }}>
                  <div>
                    <h3 className="adv-subheading" style={{ margin: 0 }}>Academic Subjects & Departments ({subjects.length})</h3>
                    <p style={{ margin: '4px 0 0', fontSize: '0.8125rem', color: 'var(--color-text-secondary, #64748b)' }}>
                      Manage available academic subjects for teacher workspaces, question filters, and Creative Mode.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="adv-btn-secondary"
                    onClick={handleResetSubjects}
                    title="Reset to default ICM subject list"
                  >
                    ↺ Reset to Defaults
                  </button>
                </div>

                <div className="adv-class-chip-wrap">
                  {subjects.map((subj) => (
                    <span key={subj} className="adv-class-chip">
                      <span className="adv-class-chip-tag">📚</span>
                      <span className="adv-class-chip-name">{subj}</span>
                      <button
                        type="button"
                        className="adv-class-chip-del"
                        onClick={() => handleRemoveSubject(subj)}
                        title={`Remove subject ${subj}`}
                        aria-label={`Remove subject ${subj}`}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>

                {/* Add Subject Form */}
                <form onSubmit={handleAddSubject} className="adv-add-class-form" style={{ marginTop: '20px' }}>
                  <input
                    type="text"
                    className="adv-input"
                    placeholder="Add new subject (e.g. Sociology, Art, Computer Science)..."
                    value={newSubjectInput}
                    onChange={(e) => setNewSubjectInput(e.target.value)}
                    style={{ maxWidth: '380px' }}
                  />
                  <button
                    type="submit"
                    className="adv-btn-primary"
                    disabled={!newSubjectInput.trim()}
                  >
                    + Add Subject
                  </button>
                </form>
              </div>
            )}
          </div>
        )}

        {/* ─── SECTION 2: Exam Security Defaults ─────────────────────────────── */}
        {activeSection === 'security' && (
          <div className="adv-section-card">
            <div className="adv-section-header">
              <div>
                <h2 className="adv-section-title">🛡️ Exam Security & Feature Controls</h2>
                <p className="adv-section-subtitle">
                  Configure default integrity protections, candidate watermarking, multi-monitor shields, portal visibility, and automatic lockouts.
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

              {/* Gemini AI Model & API Key Tier for Paper Extraction */}
              <div className="adv-setting-card adv-setting-card--vertical">
                <div className="adv-setting-info" style={{ width: '100%' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px', width: '100%', flexWrap: 'wrap', gap: '8px' }}>
                    <strong className="adv-setting-title">⚡ Gemini Model & API Key Selection</strong>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      <span className="adv-tab-counter" style={{ background: 'rgba(99, 102, 241, 0.15)', color: 'var(--color-primary-500, #6366f1)', padding: '2px 8px', borderRadius: '4px', fontWeight: 600 }}>
                        Model: {geminiModelPreset === 'custom' ? (customModelInput || 'Custom') : (geminiModelPreset === 'gemini-3.5-flash-lite' ? '3.5 Flash Lite' : '3.8 Flash')}
                      </span>
                      <span
                        className="adv-tab-counter"
                        style={{
                          background: geminiKeyTier === 'paid' ? 'rgba(16, 185, 129, 0.15)' : geminiKeyTier === 'free' ? 'rgba(14, 165, 233, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                          color: geminiKeyTier === 'paid' ? '#059669' : geminiKeyTier === 'free' ? '#0284c7' : '#d97706',
                          padding: '2px 8px',
                          borderRadius: '4px',
                          fontWeight: 600,
                        }}
                      >
                        Key: {geminiKeyTier === 'paid' ? '💳 Paid Key' : geminiKeyTier === 'free' ? '🆓 Free Key' : '🔄 Auto (Paid + Free)'}
                      </span>
                    </div>
                  </div>
                  <p className="adv-setting-desc">
                    Choose the primary Gemini AI model and which Cloudflare-configured API key tier to utilize for parsing question papers, mark schemes, resource booklets, and AI grading. Keys remain unexposed in the web UI.
                  </p>
                </div>

                {/* 1. Model Preset Options */}
                <div style={{ width: '100%', marginTop: '10px' }}>
                  <span style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted, #64748b)', marginBottom: '6px' }}>
                    1. Select Gemini Model
                  </span>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
                    <button
                      type="button"
                      className={`adv-tab-btn ${geminiModelPreset === 'gemini-3.5-flash-lite' ? 'adv-tab-btn--active' : ''}`}
                      style={{ padding: '8px 16px', fontSize: '13px', borderRadius: '8px' }}
                      onClick={() => {
                        setGeminiModelPreset('gemini-3.5-flash-lite');
                        setModelTestFeedback(null);
                      }}
                    >
                      ⚡ Gemini 3.5 Flash Lite <span style={{ opacity: 0.75, fontSize: '11px', marginLeft: '4px' }}>(Ultra-Fast ~5s)</span>
                    </button>
                    <button
                      type="button"
                      className={`adv-tab-btn ${geminiModelPreset === 'gemini-3.8-flash' ? 'adv-tab-btn--active' : ''}`}
                      style={{ padding: '8px 16px', fontSize: '13px', borderRadius: '8px' }}
                      onClick={() => {
                        setGeminiModelPreset('gemini-3.8-flash');
                        setModelTestFeedback(null);
                      }}
                    >
                      🧠 Gemini 3.8 Flash <span style={{ opacity: 0.75, fontSize: '11px', marginLeft: '4px' }}>(High Visual Reasoning)</span>
                    </button>
                    <button
                      type="button"
                      className={`adv-tab-btn ${geminiModelPreset === 'custom' ? 'adv-tab-btn--active' : ''}`}
                      style={{ padding: '8px 16px', fontSize: '13px', borderRadius: '8px' }}
                      onClick={() => {
                        setGeminiModelPreset('custom');
                        setModelTestFeedback(null);
                      }}
                    >
                      🛠️ Custom Model...
                    </button>
                  </div>
                </div>

                {/* Custom Model Input if custom preset selected */}
                {geminiModelPreset === 'custom' && (
                  <div style={{ marginTop: '4px', marginBottom: '12px', width: '100%' }}>
                    <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--text-muted, #64748b)', marginBottom: '4px' }}>
                      Custom Model Identifier (e.g. <code>gemini-2.5-pro</code>, <code>gemini-2.0-flash</code>)
                    </label>
                    <input
                      type="text"
                      className="adv-input"
                      placeholder="e.g. gemini-2.5-pro"
                      value={customModelInput}
                      onChange={(e) => {
                        setCustomModelInput(e.target.value);
                        setModelTestFeedback(null);
                      }}
                      style={{ width: '100%', maxWidth: '420px', fontFamily: 'monospace' }}
                    />
                  </div>
                )}

                {/* 2. API Key Tier Selection (Cloudflare Configured — Never Exposes Raw Keys) */}
                <div style={{ width: '100%', marginTop: '4px', marginBottom: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px', flexWrap: 'wrap', gap: '6px' }}>
                    <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted, #64748b)' }}>
                      2. Select Cloudflare API Key Tier
                    </span>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted, #64748b)' }}>
                      🔒 Keys configured in Cloudflare ({keySlotStatus.paidConfigured ? 'Paid ✓' : 'Paid —'} · {keySlotStatus.freeConfigured ? 'Free ✓' : 'Free —'})
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className={`adv-tab-btn ${geminiKeyTier === 'paid' ? 'adv-tab-btn--active' : ''}`}
                      style={{ padding: '8px 16px', fontSize: '13px', borderRadius: '8px' }}
                      onClick={() => {
                        setGeminiKeyTier('paid');
                        setModelTestFeedback(null);
                      }}
                    >
                      💳 Paid API Key <span style={{ opacity: 0.75, fontSize: '11px', marginLeft: '4px' }}>(High Quota / Bulk Extraction)</span>
                    </button>
                    <button
                      type="button"
                      className={`adv-tab-btn ${geminiKeyTier === 'free' ? 'adv-tab-btn--active' : ''}`}
                      style={{ padding: '8px 16px', fontSize: '13px', borderRadius: '8px' }}
                      onClick={() => {
                        setGeminiKeyTier('free');
                        setModelTestFeedback(null);
                      }}
                    >
                      🆓 Free API Key <span style={{ opacity: 0.75, fontSize: '11px', marginLeft: '4px' }}>(Zero Cost / Standard Quota)</span>
                    </button>
                    <button
                      type="button"
                      className={`adv-tab-btn ${geminiKeyTier === 'auto' ? 'adv-tab-btn--active' : ''}`}
                      style={{ padding: '8px 16px', fontSize: '13px', borderRadius: '8px' }}
                      onClick={() => {
                        setGeminiKeyTier('auto');
                        setModelTestFeedback(null);
                      }}
                    >
                      🔄 Auto-Failover <span style={{ opacity: 0.75, fontSize: '11px', marginLeft: '4px' }}>(Paid Primary + Free Backup)</span>
                    </button>
                  </div>
                </div>

                {/* Test Feedback Notice */}
                {modelTestFeedback && (
                  <div
                    style={{
                      padding: '10px 14px',
                      borderRadius: '8px',
                      marginBottom: '12px',
                      width: '100%',
                      fontSize: '13px',
                      backgroundColor: modelTestFeedback.ok ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                      color: modelTestFeedback.ok ? '#059669' : '#dc2626',
                      border: `1px solid ${modelTestFeedback.ok ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                    }}
                  >
                    <span>{modelTestFeedback.ok ? '✓' : '⚠️'}</span>
                    <span>{modelTestFeedback.message}</span>
                  </div>
                )}

                {/* Action Buttons: Test Connection & Save */}
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="adv-btn-secondary"
                    onClick={handleTestGeminiModel}
                    disabled={isTestingModel || (geminiModelPreset === 'custom' && !customModelInput.trim())}
                  >
                    {isTestingModel ? 'Testing Model & Key…' : '🔍 Test Model & Key Availability'}
                  </button>
                  <button
                    type="button"
                    className="adv-btn-primary"
                    onClick={handleSaveGeminiModel}
                    disabled={isSavingModel || (geminiModelPreset === 'custom' && !customModelInput.trim())}
                  >
                    {isSavingModel ? 'Saving…' : '💾 Save & Sync AI Config to Cloud'}
                  </button>
                </div>
              </div>

              {/* AI Diagram & Image Generation for Variants */}
              <div className="adv-setting-card">
                <div className="adv-setting-info">
                  <strong className="adv-setting-title">🎨 AI Diagram & Image Generation (Variants)</strong>
                  <p className="adv-setting-desc">
                    When disabled (recommended), question variants will retain and reference the authentic original diagram or photo, focusing AI variations purely on question stems, calculations, and mark schemes. When enabled, Workers AI diffusion and Parametric SVG synthesis can generate new visuals.
                  </p>
                </div>
                <button
                  type="button"
                  className={`adv-toggle-btn ${settings.enableVariantImageGeneration ? 'adv-toggle-btn--active' : ''}`}
                  onClick={() => updateSetting('enableVariantImageGeneration', !settings.enableVariantImageGeneration)}
                >
                  {settings.enableVariantImageGeneration ? 'Enabled' : 'Disabled (Original Retained)'}
                </button>
              </div>

              {/* Gamified Quiz Mode (Quizizz Style) Feature Toggle */}
              <div className="adv-setting-card">
                <div className="adv-setting-info">
                  <strong className="adv-setting-title">🎮 Gamified Quiz Mode (Quizizz Style)</strong>
                  <p className="adv-setting-desc">
                    Enables interactive Quizizz-style arcade challenges with colored cards, audio effects, powerups, streaks, and live multiplayer leaderboards. When disabled (default), only Formal Examination Mode is available.
                  </p>
                </div>
                <button
                  type="button"
                  className={`adv-toggle-btn ${settings.enableQuizizzMode ? 'adv-toggle-btn--active' : ''}`}
                  onClick={() => updateSetting('enableQuizizzMode', !settings.enableQuizizzMode)}
                >
                  {settings.enableQuizizzMode ? 'Enabled' : 'Disabled (Formal Exam Only)'}
                </button>
              </div>

              {/* Creative Mode Hub & Avatar Studio on Landing Page */}
              <div className="adv-setting-card">
                <div className="adv-setting-info">
                  <strong className="adv-setting-title">🎨 Hide Creative Mode Hub & Avatar Studio (Landing Page)</strong>
                  <p className="adv-setting-desc">
                    Hides the Creative Mode Hub, student avatar studio, coin balances, and topic mastery card from the student portal landing page. Recommended during formal examination periods or high-stakes testing sessions to minimize student distraction.
                  </p>
                </div>
                <button
                  type="button"
                  className={`adv-toggle-btn ${settings.hideCreativeModeOnLanding ? 'adv-toggle-btn--active' : ''}`}
                  onClick={() => handleToggleHideCreativeMode(!settings.hideCreativeModeOnLanding)}
                >
                  {settings.hideCreativeModeOnLanding ? 'Hidden on Landing (Active)' : 'Visible (Default)'}
                </button>
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

              {/* Cloudflare R2 Media Storage Configuration */}
              <div className="adv-setting-card adv-setting-card--vertical">
                <div className="adv-setting-info">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
                    <strong className="adv-setting-title">⚡ Cloudflare R2 Media Storage (Zero Egress Fees)</strong>
                    <span style={{ 
                      fontSize: '11px', 
                      fontWeight: 600, 
                      padding: '2px 8px', 
                      borderRadius: '12px', 
                      background: 'rgba(16, 185, 129, 0.15)', 
                      color: '#10b981',
                      border: '1px solid rgba(16, 185, 129, 0.3)'
                    }}>
                      Worker Active
                    </span>
                  </div>
                  <p className="adv-setting-desc">
                    Diagrams and listening exam audio are streamed directly from Cloudflare R2 with $0 bandwidth fees and zero Indonesian ISP blocks.
                  </p>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '8px' }}>
                  <div>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: '4px' }}>
                      Media Worker Endpoint URL
                    </label>
                    <input
                      type="text"
                      className="adv-input adv-input-mono"
                      placeholder="https://testmaker-media.icmadani.workers.dev"
                      value={r2EndpointInput}
                      onChange={(e) => setR2EndpointInput(e.target.value)}
                    />
                  </div>

                  <div>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: '4px' }}>
                      Upload Authorization Secret
                    </label>
                    <input
                      type="password"
                      className="adv-input adv-input-mono"
                      placeholder="Upload secret token"
                      value={r2SecretInput}
                      onChange={(e) => setR2SecretInput(e.target.value)}
                    />
                  </div>

                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '4px' }}>
                    <button
                      type="button"
                      className="adv-btn-primary"
                      onClick={handleSaveR2Config}
                    >
                      Save R2 Configuration
                    </button>
                    <button
                      type="button"
                      className="adv-btn-secondary"
                      onClick={handleTestR2Connection}
                      disabled={isTestingR2}
                    >
                      {isTestingR2 ? 'Testing...' : '⚡ Test Connection'}
                    </button>
                    {r2TestResult && (
                      <span style={{ 
                        fontSize: '12px', 
                        color: r2TestResult.ok ? '#10b981' : '#ef4444', 
                        fontWeight: 600 
                      }}>
                        {r2TestResult.ok ? `✓ Latency: ${r2TestResult.latencyMs}ms` : `❌ ${r2TestResult.error}`}
                      </span>
                    )}
                  </div>
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
