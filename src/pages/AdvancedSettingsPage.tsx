import { useState, useEffect, useRef, useMemo, type KeyboardEvent, type ClipboardEvent } from 'react';
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
  saveEmergencyExamButtonVisibility,
  loadAndSyncEmergencyExamButtonVisibility,
  saveTeacherAccountClaimingSetting,
  loadAndSyncTeacherAccountClaiming,
  getGeminiExtractionModel,
  saveGeminiExtractionModel,
  syncGeminiExtractionModelToCloud,
  loadAndSyncGeminiExtractionModel,
  getGeminiApiKeyTier,
  saveGeminiApiKeyTier,
  syncGeminiApiKeyTierToCloud,
  loadAndSyncGeminiApiKeyTier,
  type GeminiApiKeyTier,
  getSecurityTiers,
  saveSecurityTiers,
  loadAndSyncSecurityTiers,
  getTopicMasteryTiers,
  saveTopicMasteryTiers,
  loadAndSyncTopicMasteryTiers,
} from '../lib/settings';
import {
  type SecurityViolationTier,
  type SecurityTierAction,
  DEFAULT_SECURITY_TIERS,
  validateSecurityTiers,
} from '../lib/securityTiers';
import {
  type TopicMasteryTier,
  type MasteryTierColor,
  DEFAULT_TOPIC_MASTERY_TIERS,
  validateTopicMasteryTiers,
  normalizeTopicMasteryTiers,
} from '../lib/topicMastery';
import { testR2Connection } from '../services/storageService';
import { testGeminiModelConnectivity, getConfiguredApiKeyStatus } from '../lib/gemini';
import {
  type RosterStudent,
  type ExcelRosterParseResult,
  type RosterImportPlan,
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
  normalizeRosterAndClasses,
  planRosterExcelImport,
} from '../services/studentRosterService';
import {
  type ExamScheduleEntry,
  type ExamScheduleCategory,
  ICM_SCHOOL_CLASSES_26_27,
  ICM_SEMESTER1_2026_2027_SCHEDULE,
  validateExamScheduleEntries,
  formatRoomWithGender,
} from '../lib/examSchedule';
import {
  getExamSchedule,
  saveExamSchedule,
  loadAndSyncExamSchedule,
} from '../services/examScheduleService';
import {
  adminListTeacherAccounts,
  adminCreateTeacherAccount,
  adminUpdateTeacherAccount,
  adminResetTeacherPassword,
  adminDeleteTeacherAccount,
  generateTemporaryTeacherPassword,
  getActiveTeacherProfileId,
} from '../services/teacherProfileService';
import type { TeacherProfile } from '../types/database';
import { CandidateCardPrintModal } from '../components/CandidateCardPrintModal';
import './AdvancedSettingsPage.css';

const ADVANCED_MASTER_PIN = '140798';
const ADVANCED_SESSION_KEY = 'testmaker_advanced_pin_verified';
const PIN_LENGTH = 6;

function formatEducatorDisplayName(title?: string | null, name?: string | null): string {
  const cleanName = (name || '').trim();
  const cleanTitle = (title || '').trim();
  if (!cleanTitle) return cleanName;
  if (!cleanName) return cleanTitle;
  const lowerName = cleanName.toLowerCase();
  const lowerTitle = cleanTitle.toLowerCase();
  if (lowerName === lowerTitle || lowerName.startsWith(`${lowerTitle} `) || lowerName.startsWith(`${lowerTitle}.`)) {
    return cleanName;
  }
  return `${cleanTitle} ${cleanName}`;
}

const CLASS_PRESETS: { label: string; classes: string[] }[] = [
  {
    label: 'ICM Senior High 26/27 (13 Classes)',
    classes: ICM_SCHOOL_CLASSES_26_27,
  },
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
  const [activeSection, setActiveSection] = useState<'roster' | 'teachers' | 'security' | 'mastery' | 'cloud'>('roster');
  const [rosterSubTab, setRosterSubTab] = useState<'classes' | 'students' | 'schedule' | 'subjects'>('classes');
  const [subjects, setSubjects] = useState<string[]>(() => getSchoolSubjects());
  const [newSubjectInput, setNewSubjectInput] = useState('');
  const [selectedRosterClass, setSelectedRosterClass] = useState<string>('ALL');
  const [selectedRosterRoom, setSelectedRosterRoom] = useState<string>('ALL');

  // School Classes Inputs
  const [newClassInput, setNewClassInput] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  // Student Directory Inputs
  const [newStudentName, setNewStudentName] = useState('');
  const [newStudentClass, setNewStudentClass] = useState('');
  const [newStudentNumber, setNewStudentNumber] = useState('');
  const [newStudentRoom, setNewStudentRoom] = useState('');
  const [newStudentSeat, setNewStudentSeat] = useState('');
  const [editingRoomSeatId, setEditingRoomSeatId] = useState<string | null>(null);
  const [editRoomValue, setEditRoomValue] = useState('');
  const [editSeatValue, setEditSeatValue] = useState('');
  const [isBulkImportOpen, setIsBulkImportOpen] = useState(false);
  const [bulkImportText, setBulkImportText] = useState('');
  const [copiedPinStudentId, setCopiedPinStudentId] = useState<string | null>(null);

  // Excel File Upload & Smart Diff Review
  const excelFileInputRef = useRef<HTMLInputElement>(null);
  const [isParsingExcel, setIsParsingExcel] = useState(false);
  const [pendingExcelReview, setPendingExcelReview] = useState<{
    parseResult: ExcelRosterParseResult;
    plan: RosterImportPlan;
    pruneExtras: boolean;
    importSchedule: boolean;
  } | null>(null);

  // Exam Schedule State & Desk Card Print Modal
  const [examSchedule, setExamSchedule] = useState<ExamScheduleEntry[]>(() => getExamSchedule());
  const [isSavingSchedule, setIsSavingSchedule] = useState(false);
  const [newSchedDate, setNewSchedDate] = useState('');
  const [newSchedTime, setNewSchedTime] = useState('');
  const [newSchedSubject, setNewSchedSubject] = useState('');
  const [newSchedDuration, setNewSchedDuration] = useState("90'");
  const [newSchedTarget, setNewSchedTarget] = useState('ALL');
  const [newSchedCategory, setNewSchedCategory] = useState<ExamScheduleCategory>('written');
  const [isPrintCardsModalOpen, setIsPrintCardsModalOpen] = useState(false);

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

  // Security Violation Escalation Tiers State
  const [securityTiers, setSecurityTiers] = useState<SecurityViolationTier[]>(() => getSecurityTiers());
  const [isSavingTiers, setIsSavingTiers] = useState(false);
  const tierValidation = useMemo(() => validateSecurityTiers(securityTiers), [securityTiers]);

  // Topic Mastery Reporting Bands State
  const [topicMasteryTiers, setTopicMasteryTiers] = useState<TopicMasteryTier[]>(() => getTopicMasteryTiers());
  const [isSavingMasteryTiers, setIsSavingMasteryTiers] = useState(false);
  const masteryTierValidation = useMemo(
    () => validateTopicMasteryTiers(topicMasteryTiers),
    [topicMasteryTiers]
  );

  // Educator Accounts Management State
  const [teacherAccounts, setTeacherAccounts] = useState<TeacherProfile[]>([]);
  const [isLoadingTeachers, setIsLoadingTeachers] = useState(false);
  const [newTeacherTitle, setNewTeacherTitle] = useState('Mr.');
  const [newTeacherName, setNewTeacherName] = useState('');
  const [newTeacherUsername, setNewTeacherUsername] = useState('');
  const [newTeacherEmail, setNewTeacherEmail] = useState('');
  const [newTeacherRole, setNewTeacherRole] = useState<'teacher' | 'admin'>('teacher');
  const [newTeacherSubject, setNewTeacherSubject] = useState('Chemistry');
  const [newTeacherSubjectCode, setNewTeacherSubjectCode] = useState('0620');
  const [newTeacherClasses, setNewTeacherClasses] = useState<string[]>(() =>
    (getSavedSettings().classes || DEFAULT_CLASSES).slice(0, 2)
  );
  const [newTeacherPassword, setNewTeacherPassword] = useState(() => generateTemporaryTeacherPassword());
  const [newTeacherMustChangePw, setNewTeacherMustChangePw] = useState(true);
  const [isCreatingTeacher, setIsCreatingTeacher] = useState(false);
  const [teacherFormError, setTeacherFormError] = useState<string | null>(null);
  const [issuedCredentialsBanner, setIssuedCredentialsBanner] = useState<{
    name: string;
    identifier: string;
    password: string;
    role: string;
    mustChange: boolean;
  } | null>(null);

  const [editingTeacherId, setEditingTeacherId] = useState<string | null>(null);
  const [editTeacherTitle, setEditTeacherTitle] = useState('Mr.');
  const [editTeacherName, setEditTeacherName] = useState('');
  const [editTeacherUsername, setEditTeacherUsername] = useState('');
  const [editTeacherEmail, setEditTeacherEmail] = useState('');
  const [editTeacherRole, setEditTeacherRole] = useState<'teacher' | 'admin'>('teacher');
  const [editTeacherSubject, setEditTeacherSubject] = useState('Chemistry');
  const [editTeacherSubjectCode, setEditTeacherSubjectCode] = useState('');
  const [editTeacherClasses, setEditTeacherClasses] = useState<string[]>([]);
  const [editTeacherPassword, setEditTeacherPassword] = useState('');
  const [editTeacherMustChangePw, setEditTeacherMustChangePw] = useState(true);
  const [editTeacherError, setEditTeacherError] = useState<string | null>(null);
  const [isSavingTeacherEdit, setIsSavingTeacherEdit] = useState(false);

  const [resetPwTeacherId, setResetPwTeacherId] = useState<string | null>(null);
  const [resetPwValue, setResetPwValue] = useState('');
  const [resetPwMustChange, setResetPwMustChange] = useState(true);
  const [resetPwError, setResetPwError] = useState<string | null>(null);
  const [isResettingTeacherPw, setIsResettingTeacherPw] = useState(false);
  const [teacherDirectoryError, setTeacherDirectoryError] = useState<string | null>(null);

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
      loadAndSyncExamSchedule().then((entries) => {
        setExamSchedule(entries);
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
      loadAndSyncEmergencyExamButtonVisibility().then((hide) => {
        setSettingsState((prev) => ({ ...prev, hideEmergencyExamButton: hide }));
      });
      loadAndSyncTeacherAccountClaiming().then((enabled) => {
        setSettingsState((prev) => ({ ...prev, allowTeacherAccountClaiming: enabled }));
      });
      loadAndSyncSecurityTiers().then((tiers) => {
        if (tiers && tiers.length > 0) {
          setSecurityTiers(tiers);
        }
      });
      loadAndSyncTopicMasteryTiers().then((tiers) => {
        if (tiers && tiers.length > 0) {
          setTopicMasteryTiers(tiers);
        }
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
      setIsLoadingTeachers(true);
      adminListTeacherAccounts()
        .then((res) => {
          setTeacherAccounts(res.profiles || []);
          setTeacherDirectoryError(res.status === 'error' ? res.error || null : null);
        })
        .finally(() => setIsLoadingTeachers(false));
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

  const handleToggleHideEmergencyExamButton = (hide: boolean) => {
    updateSetting('hideEmergencyExamButton', hide);
    saveEmergencyExamButtonVisibility(hide);
    showNotice(
      hide
        ? '✓ Emergency Save button is now HIDDEN in student exam runner'
        : '✓ Emergency Save button is now VISIBLE in student exam runner'
    );
  };

  const handleToggleTeacherAccountClaiming = (enabled: boolean) => {
    updateSetting('allowTeacherAccountClaiming', enabled);
    saveTeacherAccountClaimingSetting(enabled);
    showNotice(
      enabled
        ? '✓ Educator account creation & profile claiming ENABLED on login screen'
        : '✓ Educator account creation & profile claiming DISABLED'
    );
  };

  const handleUpdateTier = (index: number, patch: Partial<SecurityViolationTier>) => {
    setSecurityTiers((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  };

  const handleAddTier = () => {
    setSecurityTiers((prev) => {
      const next = [...prev];
      const lastIndex = next.length - 1;
      const finalTier = { ...next[lastIndex] };
      const prevStrike = lastIndex > 0 ? next[lastIndex - 1].strikeCount : 0;
      const newStrike = prevStrike + 1;
      if (finalTier.strikeCount <= newStrike) {
        finalTier.strikeCount = newStrike + 1;
      }
      next[lastIndex] = finalTier;

      const newTier: SecurityViolationTier = {
        id: `tier_${Date.now()}`,
        strikeCount: newStrike,
        name: `Warning with Penalty`,
        action: 'time_penalty',
        penaltyMinutes: 5,
        studentNotice: `Strike ${newStrike}. 5 minutes deducted from exam time.`,
      };
      next.splice(lastIndex, 0, newTier);
      return next;
    });
  };

  const handleDeleteTier = (index: number) => {
    setSecurityTiers((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((_, i) => i !== index);
      const lastIndex = next.length - 1;
      if (next[lastIndex].action !== 'auto_submit') {
        next[lastIndex] = {
          ...next[lastIndex],
          action: 'auto_submit',
          penaltyMinutes: 0,
          name: next[lastIndex].name || 'Final Warning (Auto Submit)',
        };
      }
      return next;
    });
  };

  const handleRestoreDefaultTiers = () => {
    setSecurityTiers(JSON.parse(JSON.stringify(DEFAULT_SECURITY_TIERS)));
    showNotice('✓ Restored 4-tier default escalation policy');
  };

  const handleSaveTiers = async () => {
    const val = validateSecurityTiers(securityTiers);
    if (!val.ok) {
      showNotice(`Cannot save tiers: ${val.errors[0]}`);
      return;
    }
    setIsSavingTiers(true);
    try {
      saveSecurityTiers(securityTiers);
      showNotice('✓ Violation escalation tiers saved and synced to cloud');
    } finally {
      setIsSavingTiers(false);
    }
  };

  const handleUpdateMasteryTier = (index: number, patch: Partial<TopicMasteryTier>) => {
    setTopicMasteryTiers((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  };

  const handleAddMasteryTier = () => {
    setTopicMasteryTiers((prev) => {
      const highestBelow100 = prev
        .map((t) => t.minPercentage)
        .filter((p) => p < 95);
      const suggestedMin = highestBelow100.length > 0
        ? Math.min(95, Math.max(5, Math.round(highestBelow100[0] + 10)))
        : 60;
      const newTier: TopicMasteryTier = {
        id: `mastery_${Date.now()}`,
        minPercentage: suggestedMin,
        label: 'Proficient',
        color: 'blue',
        recommendation: 'Solid understanding with minor gaps to reinforce.',
      };
      return normalizeTopicMasteryTiers([...prev, newTier]);
    });
  };

  const handleDeleteMasteryTier = (index: number) => {
    setTopicMasteryTiers((prev) => {
      if (prev.length <= 1) return prev;
      const target = prev[index];
      if (target && target.minPercentage === 0) return prev;
      return prev.filter((_, i) => i !== index);
    });
  };

  const handleRestoreDefaultMasteryTiers = () => {
    setTopicMasteryTiers(DEFAULT_TOPIC_MASTERY_TIERS.map((t) => ({ ...t })));
    showNotice('✓ Restored default 3-band Topic Mastery thresholds (75% / 50% / 0%)');
  };

  const handleSaveMasteryTiers = async () => {
    const val = validateTopicMasteryTiers(topicMasteryTiers);
    if (!val.ok) {
      showNotice(`Cannot save mastery bands: ${val.errors[0]}`);
      return;
    }
    setIsSavingMasteryTiers(true);
    try {
      const normalized = normalizeTopicMasteryTiers(topicMasteryTiers);
      setTopicMasteryTiers(normalized);
      saveTopicMasteryTiers(normalized);
      showNotice('✓ Topic mastery bands saved and synced to cloud');
    } finally {
      setIsSavingMasteryTiers(false);
    }
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

  const normalizationPreview = useMemo(
    () => normalizeRosterAndClasses(roster, settings.classes || DEFAULT_CLASSES),
    [roster, settings.classes]
  );

  const handleNormalizeClassesNow = async () => {
    const { roster: nextRoster, classes: nextClasses, renamedClasses } = normalizationPreview;
    if (renamedClasses.length === 0) {
      showNotice('✓ All class names are already cleanly formatted');
      return;
    }
    updateSetting('classes', nextClasses);
    saveSchoolClasses(nextClasses);
    setRoster(nextRoster);
    await saveSchoolRoster(nextRoster);
    showNotice(
      `✓ Normalized ${renamedClasses.map((r) => `${r.from} → ${r.to}`).join(', ')} and synced to cloud`,
      5000
    );
  };

  // ─── Student Directory Handlers ─────────────────────────────────────────────
  const handleAddStudent = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const name = newStudentName.trim();
    if (!name) return;

    const assignedClass = newStudentClass || (settings.classes && settings.classes[0]) || '10-A';
    const rawRoom = newStudentRoom.trim();
    const newStudent: RosterStudent = {
      id: crypto.randomUUID(),
      name,
      class: assignedClass,
      candidateNumber: newStudentNumber.trim() || undefined,
      room: rawRoom ? formatRoomWithGender(rawRoom) : undefined,
      seatNumber: newStudentSeat.trim() || undefined,
      pin: generateRandom4DigitPin(),
      createdAt: new Date().toISOString(),
    };

    const updated = assignMissingPins([...roster, newStudent]);
    setRoster(updated);
    saveSchoolRoster(updated);
    const addedWithPin = updated[updated.length - 1];
    setNewStudentName('');
    setNewStudentNumber('');
    setNewStudentRoom('');
    setNewStudentSeat('');
    showNotice(`✓ Added candidate "${name}" (4-Digit PIN: ${addedWithPin.pin})`);
  };

  const handleStartEditRoomSeat = (student: RosterStudent) => {
    setEditingRoomSeatId(student.id);
    setEditRoomValue(student.room || '');
    setEditSeatValue(student.seatNumber || '');
  };

  const handleSaveInlineRoomSeat = (studentId: string) => {
    const cleanRoom = editRoomValue.trim() ? formatRoomWithGender(editRoomValue) : undefined;
    const cleanSeat = editSeatValue.trim() || undefined;
    const updated = roster.map((s) =>
      s.id === studentId ? { ...s, room: cleanRoom, seatNumber: cleanSeat } : s
    );
    setRoster(updated);
    saveSchoolRoster(updated);
    setEditingRoomSeatId(null);
    showNotice('✓ Updated candidate room & seat');
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

  // ─── Excel File Import Handler & Smart Review ───────────────────────────────
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

      const plan = planRosterExcelImport(roster, settings.classes || DEFAULT_CLASSES, parsed);
      setPendingExcelReview({
        parseResult: parsed,
        plan,
        pruneExtras: plan.extraStudentsToPrune.length > 0,
        importSchedule: Boolean(parsed.detectedSchedule && parsed.detectedSchedule.length > 0),
      });
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

  const handleApplyPendingExcelImport = async () => {
    if (!pendingExcelReview) return;
    const { parseResult, plan, pruneExtras, importSchedule } = pendingExcelReview;

    const finalClasses = plan.normalizedClasses;
    const finalRoster = pruneExtras ? plan.syncedRosterPruned : plan.mergedRosterKeepExtras;

    updateSetting('classes', finalClasses);
    saveSchoolClasses(finalClasses);
    setRoster(finalRoster);
    const cloudSaved = await saveSchoolRoster(finalRoster);

    if (importSchedule && parseResult.detectedSchedule && parseResult.detectedSchedule.length > 0) {
      setExamSchedule(parseResult.detectedSchedule);
      await saveExamSchedule(parseResult.detectedSchedule);
    }

    setPendingExcelReview(null);
    setRosterSubTab('students');
    showNotice(
      `✓ Synced ${finalRoster.length} candidates (${plan.preservedPinCount} PINs kept, ${plan.addedStudents.length} new${pruneExtras && plan.extraStudentsToPrune.length > 0 ? `, ${plan.extraStudentsToPrune.length} pruned` : ''})${cloudSaved ? ' to cloud' : ' (cached locally)'}!`,
      6000
    );
  };

  const handleDownloadTemplate = () => {
    downloadSampleExcelTemplate();
    showNotice('✓ Downloaded Students & Classes Excel template');
  };

  // ─── Exam Schedule Handlers (Desk Card Reverse Side) ────────────────────────
  const handleAddScheduleRow = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!newSchedDate.trim() || !newSchedTime.trim() || !newSchedSubject.trim()) return;
    const nextRow: ExamScheduleEntry = {
      id: `sched-${Date.now()}`,
      date: newSchedDate.trim(),
      time: newSchedTime.trim(),
      subject: newSchedSubject.trim(),
      duration: newSchedDuration.trim(),
      targetClass: newSchedTarget.trim() || 'ALL',
      category: newSchedCategory,
    };
    setExamSchedule((prev) => [...prev, nextRow]);
    setNewSchedSubject('');
  };

  const handleUpdateScheduleRow = (idx: number, patch: Partial<ExamScheduleEntry>) => {
    setExamSchedule((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  };

  const handleDeleteScheduleRow = (idx: number) => {
    setExamSchedule((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleLoadIcmSchedulePreset = () => {
    setExamSchedule(ICM_SEMESTER1_2026_2027_SCHEDULE.map((item) => ({ ...item })));
    showNotice('✓ Loaded ICM 1st Semester A.Y. 2026/2027 timetable (remember to Save & Sync)');
  };

  const handleSaveExamSchedule = async () => {
    const val = validateExamScheduleEntries(examSchedule);
    if (!val.ok) {
      showNotice(`⚠️ ${val.errors[0]}`);
      return;
    }
    setIsSavingSchedule(true);
    try {
      const ok = await saveExamSchedule(examSchedule);
      showNotice(
        ok
          ? `✓ Saved & synced ${examSchedule.length} exam schedule sessions to cloud`
          : `✓ Saved ${examSchedule.length} exam schedule sessions locally`
      );
    } finally {
      setIsSavingSchedule(false);
    }
  };

  const availableRosterRooms = useMemo(() => {
    const set = new Set<string>();
    for (const s of roster) {
      if (s.room?.trim()) set.add(s.room.trim());
    }
    return Array.from(set).sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    );
  }, [roster]);

  const filteredRosterStudents = useMemo(() => {
    return roster.filter((s) => {
      if (selectedRosterClass !== 'ALL' && s.class !== selectedRosterClass) return false;
      if (selectedRosterRoom !== 'ALL') {
        if (selectedRosterRoom === '__UNASSIGNED__') return !s.room?.trim();
        if ((s.room || '').trim() !== selectedRosterRoom) return false;
      }
      return true;
    });
  }, [roster, selectedRosterClass, selectedRosterRoom]);

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

  // ─── Educator Accounts Management Handlers ────────────────────────────────────
  const refreshTeacherAccountsList = async () => {
    setIsLoadingTeachers(true);
    setTeacherDirectoryError(null);
    try {
      const res = await adminListTeacherAccounts();
      setTeacherAccounts(res.profiles || []);
      if (res.status === 'error' && res.error) {
        setTeacherDirectoryError(res.error);
      }
    } finally {
      setIsLoadingTeachers(false);
    }
  };

  const toggleNewTeacherClass = (cls: string) => {
    setNewTeacherClasses((prev) =>
      prev.includes(cls) ? (prev.length > 1 ? prev.filter((c) => c !== cls) : [cls]) : [...prev, cls]
    );
  };

  const toggleEditTeacherClass = (cls: string) => {
    setEditTeacherClasses((prev) =>
      prev.includes(cls) ? (prev.length > 1 ? prev.filter((c) => c !== cls) : [cls]) : [...prev, cls]
    );
  };

  const handleCreateTeacherSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTeacherFormError(null);
    if (!newTeacherName.trim()) {
      setTeacherFormError('Please enter the educator display name.');
      return;
    }
    if (!newTeacherUsername.trim() && !newTeacherEmail.trim()) {
      setTeacherFormError('Please provide either a username or school email address.');
      return;
    }
    if (newTeacherPassword.trim().length < 6) {
      setTeacherFormError('Initial password must be at least 6 characters.');
      return;
    }

    setIsCreatingTeacher(true);
    try {
      const res = await adminCreateTeacherAccount({
        name: newTeacherName.trim(),
        title: newTeacherTitle.trim() || 'Mr.',
        email: newTeacherEmail.trim(),
        username: newTeacherUsername.trim(),
        password: newTeacherPassword,
        role: newTeacherRole,
        subject: newTeacherSubject.trim() || 'Chemistry',
        subjectCode: newTeacherSubjectCode.trim(),
        defaultClasses:
          newTeacherClasses.length > 0
            ? newTeacherClasses
            : (settings.classes || DEFAULT_CLASSES).slice(0, 2),
        mustChangePassword: newTeacherMustChangePw,
      });

      if (res.status !== 'ok' || !res.profile) {
        setTeacherFormError(res.error || 'Could not create educator account.');
        return;
      }

      const created = res.profile;
      setTeacherAccounts((prev) => [...prev.filter((p) => p.id !== created.id), created]);
      setIssuedCredentialsBanner({
        name: formatEducatorDisplayName(created.title, created.name),
        identifier: created.username || created.email || created.name,
        password: newTeacherPassword,
        role: created.role === 'admin' ? 'Admin' : 'Teacher',
        mustChange: Boolean(created.must_change_password),
      });
      setNewTeacherName('');
      setNewTeacherUsername('');
      setNewTeacherEmail('');
      setNewTeacherPassword(generateTemporaryTeacherPassword());
      showNotice(`✓ Created educator account for ${created.name}`);
    } finally {
      setIsCreatingTeacher(false);
    }
  };

  const handleStartEditTeacher = (profile: TeacherProfile) => {
    const inferredTitle =
      profile.title ||
      ['Dr.', 'Mr.', 'Ms.', 'Mrs.', 'Ibu', 'Bapak', 'Pak', 'Ustadz', 'Ustadzah'].find((opt) =>
        (profile.name || '').trim().toLowerCase().startsWith(opt.toLowerCase())
      ) ||
      'Mr.';
    setEditingTeacherId(profile.id);
    setEditTeacherTitle(inferredTitle);
    setEditTeacherName(profile.name || '');
    setEditTeacherUsername(profile.username || '');
    setEditTeacherEmail(profile.email || '');
    setEditTeacherRole(profile.role === 'admin' ? 'admin' : 'teacher');
    setEditTeacherSubject(profile.subject || 'Chemistry');
    setEditTeacherSubjectCode(profile.subject_code || '');
    setEditTeacherClasses(
      Array.isArray(profile.default_classes) && profile.default_classes.length > 0
        ? profile.default_classes
        : (settings.classes || DEFAULT_CLASSES).slice(0, 2)
    );
    setEditTeacherPassword('');
    setEditTeacherMustChangePw(true);
    setEditTeacherError(null);
  };

  const handleSaveEditTeacher = async (teacherId: string) => {
    setEditTeacherError(null);
    if (!editTeacherName.trim()) {
      const msg = 'Educator name cannot be empty.';
      setEditTeacherError(msg);
      showNotice(`⚠️ ${msg}`);
      return;
    }
    if (editTeacherPassword.trim() && editTeacherPassword.trim().length < 6) {
      const msg = 'Optional login password must be at least 6 characters.';
      setEditTeacherError(msg);
      showNotice(`⚠️ ${msg}`);
      return;
    }

    setIsSavingTeacherEdit(true);
    try {
      const res = await adminUpdateTeacherAccount({
        teacherId,
        name: editTeacherName.trim(),
        title: editTeacherTitle.trim(),
        email: editTeacherEmail.trim(),
        username: editTeacherUsername.trim(),
        role: editTeacherRole,
        subject: editTeacherSubject.trim(),
        subjectCode: editTeacherSubjectCode.trim(),
        defaultClasses: editTeacherClasses,
      });

      if (res.status !== 'ok' || !res.profile) {
        const msg = res.error || 'Failed to update educator account.';
        setEditTeacherError(msg);
        showNotice(`⚠️ ${msg}`);
        return;
      }

      let finalProfile = res.profile;

      if (editTeacherPassword.trim()) {
        const pwRes = await adminResetTeacherPassword({
          teacherId,
          newPassword: editTeacherPassword,
          mustChangePassword: editTeacherMustChangePw,
        });
        if (pwRes.status !== 'ok' || !pwRes.profile) {
          setTeacherAccounts((prev) => prev.map((p) => (p.id === teacherId ? finalProfile : p)));
          const msg = pwRes.error || 'Account details saved, but setting the password failed.';
          setEditTeacherError(msg);
          showNotice(`⚠️ ${msg}`);
          return;
        }
        finalProfile = pwRes.profile;
        setIssuedCredentialsBanner({
          name: formatEducatorDisplayName(finalProfile.title, finalProfile.name),
          identifier: finalProfile.username || finalProfile.email || finalProfile.name,
          password: editTeacherPassword,
          role: finalProfile.role === 'admin' ? 'Admin' : 'Teacher',
          mustChange: Boolean(finalProfile.must_change_password),
        });
      }

      setTeacherAccounts((prev) => prev.map((p) => (p.id === teacherId ? finalProfile : p)));
      setEditingTeacherId(null);
      setEditTeacherPassword('');
      setEditTeacherError(null);
      showNotice(`✓ Updated account for ${finalProfile.name}`);
    } finally {
      setIsSavingTeacherEdit(false);
    }
  };

  const handleToggleTeacherActiveStatus = async (profile: TeacherProfile) => {
    setTeacherDirectoryError(null);
    const nextActive = profile.is_active === false;
    const res = await adminUpdateTeacherAccount({
      teacherId: profile.id,
      isActive: nextActive,
    });
    if (res.status === 'ok' && res.profile) {
      setTeacherAccounts((prev) => prev.map((p) => (p.id === profile.id ? res.profile! : p)));
      showNotice(
        nextActive
          ? `✓ Reactivated educator account for ${profile.name}`
          : `✓ Suspended ${profile.name} and revoked active sessions`
      );
    } else {
      const msg = res.error || 'Could not update account status.';
      setTeacherDirectoryError(msg);
      showNotice(`⚠️ ${msg}`);
    }
  };

  const handleOpenResetTeacherPw = (profile: TeacherProfile) => {
    setResetPwTeacherId(profile.id);
    setResetPwValue(generateTemporaryTeacherPassword());
    setResetPwMustChange(true);
    setResetPwError(null);
  };

  const handleConfirmResetTeacherPw = async (profile: TeacherProfile) => {
    setResetPwError(null);
    if (resetPwValue.trim().length < 6) {
      const msg = 'New password must be at least 6 characters.';
      setResetPwError(msg);
      showNotice(`⚠️ ${msg}`);
      return;
    }
    setIsResettingTeacherPw(true);
    try {
      const res = await adminResetTeacherPassword({
        teacherId: profile.id,
        newPassword: resetPwValue,
        mustChangePassword: resetPwMustChange,
      });
      if (res.status === 'ok' && res.profile) {
        setTeacherAccounts((prev) => prev.map((p) => (p.id === profile.id ? res.profile! : p)));
        setIssuedCredentialsBanner({
          name: formatEducatorDisplayName(profile.title, profile.name),
          identifier: profile.username || profile.email || profile.name,
          password: resetPwValue,
          role: profile.role === 'admin' ? 'Admin' : 'Teacher',
          mustChange: resetPwMustChange,
        });
        setResetPwTeacherId(null);
        setResetPwError(null);
        showNotice(`✓ Password reset for ${profile.name}`);
      } else {
        const msg = res.error || 'Password reset failed.';
        setResetPwError(msg);
        showNotice(`⚠️ ${msg}`);
      }
    } finally {
      setIsResettingTeacherPw(false);
    }
  };

  const handleDeleteTeacher = async (profile: TeacherProfile) => {
    setTeacherDirectoryError(null);
    const currentActiveId = getActiveTeacherProfileId();
    if (currentActiveId && currentActiveId === profile.id) {
      const msg = 'Switch to another profile before deleting your currently active profile.';
      setTeacherDirectoryError(msg);
      showNotice(`⚠️ ${msg}`);
      return;
    }
    if (typeof window !== 'undefined' && !window.confirm(`Delete educator account "${profile.name}"?`)) {
      return;
    }
    const res = await adminDeleteTeacherAccount(profile.id);
    if (res.status === 'ok') {
      setTeacherAccounts((prev) => prev.filter((p) => p.id !== profile.id));
      showNotice(`✓ Deleted educator account "${profile.name}"`);
    } else {
      const msg = res.error || 'Could not delete educator account.';
      setTeacherDirectoryError(msg);
      showNotice(`⚠️ ${msg}`);
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
            className={`adv-tab-btn ${activeSection === 'teachers' ? 'adv-tab-btn--active' : ''}`}
            onClick={() => setActiveSection('teachers')}
          >
            👩‍🏫 Educator Accounts
            <span className="adv-tab-counter">{teacherAccounts.length} educators · Central Login &amp; Roles</span>
          </button>

          <button
            type="button"
            className={`adv-tab-btn ${activeSection === 'security' ? 'adv-tab-btn--active' : ''}`}
            onClick={() => setActiveSection('security')}
          >
            🛡️ Exam Security & Feature Controls
            <span className="adv-tab-counter">Watermarking · Multi-Monitor · Emergency Button · Auto-Lock</span>
          </button>

          <button
            type="button"
            className={`adv-tab-btn ${activeSection === 'mastery' ? 'adv-tab-btn--active' : ''}`}
            onClick={() => setActiveSection('mastery')}
          >
            🎯 Topic Mastery & Reporting
            <span className="adv-tab-counter">{topicMasteryTiers.length} mastery bands</span>
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
                  className={`adv-subtab-btn ${rosterSubTab === 'schedule' ? 'adv-subtab-btn--active' : ''}`}
                  onClick={() => setRosterSubTab('schedule')}
                >
                  📅 Exam Schedule ({examSchedule.length})
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
                    Supports standard Excel tables (Name, Class, Cand #, Room, Seat #, PIN) AND multi-sheet ICM Exam Workbooks. Existing student PINs are preserved automatically!
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

            {/* Interactive Excel Import Review Panel (PIN Preservation & Prune Preview) */}
            {pendingExcelReview && (
              <div
                style={{
                  marginBottom: '1.5rem',
                  padding: '16px 18px',
                  borderRadius: '14px',
                  border: '1.5px solid #6366f1',
                  background: 'rgba(99, 102, 241, 0.08)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
                  <div>
                    <strong style={{ fontSize: '0.98rem', color: 'var(--color-text-primary, #f8fafc)' }}>
                      📋 Review Excel Import &amp; Sync Summary
                    </strong>
                    <div style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary, #94a3b8)', marginTop: '2px' }}>
                      {pendingExcelReview.parseResult.sourceSummary}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="adv-btn-secondary adv-btn-sm"
                    onClick={() => setPendingExcelReview(null)}
                  >
                    ✕ Dismiss
                  </button>
                </div>

                <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', fontSize: '0.8rem' }}>
                  <span className="adv-tab-counter" style={{ padding: '4px 10px', borderRadius: '999px', background: 'rgba(16,185,129,0.14)', color: '#10b981', fontWeight: 700 }}>
                    🔒 {pendingExcelReview.plan.preservedPinCount} Existing PINs Preserved
                  </span>
                  <span className="adv-tab-counter" style={{ padding: '4px 10px', borderRadius: '999px', background: 'rgba(59,130,246,0.14)', color: '#60a5fa', fontWeight: 700 }}>
                    ➕ {pendingExcelReview.plan.addedStudents.length} New Candidates
                  </span>
                  <span className="adv-tab-counter" style={{ padding: '4px 10px', borderRadius: '999px', background: 'rgba(139,92,246,0.14)', color: '#a78bfa', fontWeight: 700 }}>
                    🪑 {pendingExcelReview.plan.updatedRoomSeatCount} Room/Seat Updates
                  </span>
                  {pendingExcelReview.plan.renamedClasses.length > 0 && (
                    <span className="adv-tab-counter" style={{ padding: '4px 10px', borderRadius: '999px', background: 'rgba(245,158,11,0.14)', color: '#f59e0b', fontWeight: 700 }}>
                      🏷️ Normalize: {pendingExcelReview.plan.renamedClasses.map((r) => `${r.from} → ${r.to}`).join(', ')}
                    </span>
                  )}
                  {pendingExcelReview.plan.addedClasses.length > 0 && (
                    <span className="adv-tab-counter" style={{ padding: '4px 10px', borderRadius: '999px', background: 'rgba(16,185,129,0.14)', color: '#34d399', fontWeight: 700 }}>
                      + Added Classes: {pendingExcelReview.plan.addedClasses.join(', ')}
                    </span>
                  )}
                </div>

                {pendingExcelReview.parseResult.autoPlacements && pendingExcelReview.parseResult.autoPlacements.length > 0 && (
                  <div style={{ fontSize: '0.78rem', padding: '8px 12px', borderRadius: '8px', background: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(245, 158, 11, 0.35)' }}>
                    <strong>📌 Auto-Placed Unassigned Candidates:</strong>{' '}
                    {pendingExcelReview.parseResult.autoPlacements
                      .map((ap) => `${ap.name} (${ap.class}) → ${ap.room} #${ap.seatNumber}`)
                      .join(' · ')}
                  </div>
                )}

                {pendingExcelReview.plan.extraStudentsToPrune.length > 0 && (
                  <div style={{ fontSize: '0.78rem', padding: '10px 12px', borderRadius: '8px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 700, cursor: 'pointer', marginBottom: '4px' }}>
                      <input
                        type="checkbox"
                        checked={pendingExcelReview.pruneExtras}
                        onChange={(e) =>
                          setPendingExcelReview((prev) => (prev ? { ...prev, pruneExtras: e.target.checked } : prev))
                        }
                      />
                      <span>
                        Prune {pendingExcelReview.plan.extraStudentsToPrune.length} extra candidate
                        {pendingExcelReview.plan.extraStudentsToPrune.length === 1 ? '' : 's'} not in this Excel sheet
                      </span>
                    </label>
                    <div style={{ opacity: 0.85, paddingLeft: '22px' }}>
                      {pendingExcelReview.plan.extraStudentsToPrune
                        .slice(0, 8)
                        .map((s) => `${s.name} (${s.class})`)
                        .join(', ')}
                      {pendingExcelReview.plan.extraStudentsToPrune.length > 8
                        ? `, +${pendingExcelReview.plan.extraStudentsToPrune.length - 8} more`
                        : ''}
                    </div>
                  </div>
                )}

                {pendingExcelReview.parseResult.detectedSchedule && pendingExcelReview.parseResult.detectedSchedule.length > 0 && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={pendingExcelReview.importSchedule}
                      onChange={(e) =>
                        setPendingExcelReview((prev) => (prev ? { ...prev, importSchedule: e.target.checked } : prev))
                      }
                    />
                    <span>
                      Also import {pendingExcelReview.parseResult.detectedSchedule.length} Exam Schedule sessions from Time Table sheet (Practical dates restricted to Grade 10 IPA)
                    </span>
                  </label>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '4px' }}>
                  <button
                    type="button"
                    className="adv-btn-secondary"
                    onClick={() => setPendingExcelReview(null)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="adv-btn-primary"
                    onClick={handleApplyPendingExcelImport}
                  >
                    ✓ Apply Import &amp; Sync to Cloud
                  </button>
                </div>
              </div>
            )}

            {rosterSubTab === 'classes' ? (
              <div className="adv-classes-pane">
                {normalizationPreview.renamedClasses.length > 0 && (
                  <div
                    style={{
                      marginBottom: '14px',
                      padding: '10px 14px',
                      borderRadius: '10px',
                      background: 'rgba(245, 158, 11, 0.12)',
                      border: '1px solid rgba(245, 158, 11, 0.35)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '12px',
                      flexWrap: 'wrap',
                      fontSize: '0.82rem',
                    }}
                  >
                    <span>
                      ⚠️ Unnormalized class spacing detected:{' '}
                      <strong>
                        {normalizationPreview.renamedClasses.map((r) => `${r.from} → ${r.to}`).join(', ')}
                      </strong>
                    </span>
                    <button
                      type="button"
                      className="adv-btn-primary adv-btn-sm"
                      onClick={handleNormalizeClassesNow}
                    >
                      🔧 Fix Spacing &amp; Merge Roster
                    </button>
                  </div>
                )}

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
                    placeholder="Enter new class (e.g. X IPS 2, 10-D, IB HL)..."
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
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
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

                    <select
                      className="adv-input adv-select-filter"
                      value={selectedRosterRoom}
                      onChange={(e) => setSelectedRosterRoom(e.target.value)}
                    >
                      <option value="ALL">All Rooms ({availableRosterRooms.length})</option>
                      {availableRosterRooms.map((rm) => (
                        <option key={rm} value={rm}>
                          {rm} ({roster.filter((s) => (s.room || '').trim() === rm).length})
                        </option>
                      ))}
                      {roster.some((s) => !s.room?.trim()) && (
                        <option value="__UNASSIGNED__">
                          Unassigned Room ({roster.filter((s) => !s.room?.trim()).length})
                        </option>
                      )}
                    </select>
                  </div>

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
                      title="Export candidate list with Room, Seat # & 4-digit PIN slips to Excel"
                    >
                      📊 Export to Excel
                    </button>
                    <button
                      type="button"
                      className="adv-btn-primary"
                      disabled={roster.length === 0}
                      onClick={() => setIsPrintCardsModalOpen(true)}
                      title="Print 2x3 A4 Candidate Desk Cards with ICM & Cambridge logos and duplex schedule"
                    >
                      🪪 Print Desk Cards
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
                    style={{ flex: '2 1 180px' }}
                  />
                  <select
                    className="adv-input"
                    value={newStudentClass || (settings.classes && settings.classes[0]) || '10-A'}
                    onChange={(e) => setNewStudentClass(e.target.value)}
                    style={{ flex: '1 1 110px' }}
                  >
                    {(settings.classes || DEFAULT_CLASSES).map((cls) => (
                      <option key={cls} value={cls}>{cls}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    className="adv-input"
                    placeholder="Cand # / NIS (opt)"
                    value={newStudentNumber}
                    onChange={(e) => setNewStudentNumber(e.target.value)}
                    style={{ flex: '1 1 100px' }}
                  />
                  <input
                    type="text"
                    className="adv-input"
                    placeholder="Room (e.g. Room 1 - Akhwat)"
                    value={newStudentRoom}
                    onChange={(e) => setNewStudentRoom(e.target.value)}
                    style={{ flex: '1 1 140px' }}
                  />
                  <input
                    type="text"
                    className="adv-input"
                    placeholder="Seat # (opt)"
                    value={newStudentSeat}
                    onChange={(e) => setNewStudentSeat(e.target.value)}
                    style={{ flex: '0 1 85px' }}
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
                  {filteredRosterStudents.length === 0 ? (
                    <div className="adv-table-empty">
                      No students found matching {selectedRosterClass === 'ALL' ? 'the directory' : selectedRosterClass}
                      {selectedRosterRoom !== 'ALL' ? ` in ${selectedRosterRoom === '__UNASSIGNED__' ? 'Unassigned Room' : selectedRosterRoom}` : ''}. Upload an Excel file above or add a candidate.
                    </div>
                  ) : (
                    <table className="adv-table">
                      <thead>
                        <tr>
                          <th>Candidate Full Name</th>
                          <th style={{ width: '105px' }}>Class</th>
                          <th style={{ width: '105px' }}>Cand #</th>
                          <th style={{ width: '215px' }}>Room &amp; Seat #</th>
                          <th style={{ width: '125px' }}>4-Digit PIN</th>
                          <th style={{ width: '40px' }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredRosterStudents.map((student) => {
                          const isEditing = editingRoomSeatId === student.id;
                          return (
                            <tr key={student.id}>
                              <td className="adv-table-name">{student.name}</td>
                              <td className="adv-table-sub">{student.class}</td>
                              <td className="adv-table-sub">{student.candidateNumber || '-'}</td>
                              <td>
                                {isEditing ? (
                                  <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                                    <input
                                      type="text"
                                      className="adv-input"
                                      placeholder="Room..."
                                      value={editRoomValue}
                                      onChange={(e) => setEditRoomValue(e.target.value)}
                                      style={{ padding: '4px 6px', fontSize: '0.75rem', width: '120px' }}
                                    />
                                    <input
                                      type="text"
                                      className="adv-input"
                                      placeholder="#"
                                      value={editSeatValue}
                                      onChange={(e) => setEditSeatValue(e.target.value)}
                                      style={{ padding: '4px 6px', fontSize: '0.75rem', width: '44px' }}
                                    />
                                    <button
                                      type="button"
                                      className="adv-btn-primary adv-btn-sm"
                                      onClick={() => handleSaveInlineRoomSeat(student.id)}
                                      title="Save Room & Seat"
                                    >
                                      ✓
                                    </button>
                                    <button
                                      type="button"
                                      className="adv-btn-secondary adv-btn-sm"
                                      onClick={() => setEditingRoomSeatId(null)}
                                      title="Cancel edit"
                                    >
                                      ✕
                                    </button>
                                  </div>
                                ) : (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                    <span className="adv-table-sub" style={{ fontSize: '0.78rem' }}>
                                      {student.room ? student.room : '—'}
                                      {student.seatNumber ? ` · #${student.seatNumber}` : ''}
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => handleStartEditRoomSeat(student)}
                                      title="Edit room & seat number"
                                      style={{
                                        background: 'transparent',
                                        border: 'none',
                                        cursor: 'pointer',
                                        opacity: 0.65,
                                        fontSize: '0.75rem',
                                        padding: '2px',
                                      }}
                                    >
                                      ✏️
                                    </button>
                                  </div>
                                )}
                              </td>
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
                          );
                        })}
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
                      Paste one student per line. Format: <code>Name, Class, Candidate #, PIN (opt), Room (opt), Seat # (opt)</code>
                    </p>
                    <textarea
                      rows={5}
                      className="adv-input adv-bulk-textarea"
                      placeholder="Alya Murti, X IPS 2, 262710004, , Room 1 - Akhwat, 4&#10;Amando Saktika, X IPA 1, 262710066, , Room 6 - Ikhwan, 1"
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
            ) : rosterSubTab === 'schedule' ? (
              <div className="adv-students-pane" style={{ paddingTop: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '10px' }}>
                  <div>
                    <h3 className="adv-subheading" style={{ margin: 0 }}>
                      📅 Exam Schedule (Duplex Desk Card Back Side)
                    </h3>
                    <p style={{ margin: '4px 0 0', fontSize: '0.8125rem', color: 'var(--color-text-secondary, #64748b)' }}>
                      Rows are automatically filtered per candidate class/grade on the reverse side of printed desk cards (supports <code>ALL</code>, <code>IPA</code>, <code>IPS</code>, <code>X</code>, <code>X IPA</code>, or exact class names).
                    </p>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="adv-btn-secondary"
                      onClick={handleLoadIcmSchedulePreset}
                      title="Load verified ICM Semester 1 A.Y. 2026/2027 Practical (Grade 10 IPA) & Written timetable"
                    >
                      📅 Load ICM 1st Sem 26/27
                    </button>
                    <button
                      type="button"
                      className="adv-btn-secondary"
                      disabled={roster.length === 0}
                      onClick={() => setIsPrintCardsModalOpen(true)}
                    >
                      🪪 Print Desk Cards
                    </button>
                    <button
                      type="button"
                      className="adv-btn-primary"
                      onClick={handleSaveExamSchedule}
                      disabled={isSavingSchedule}
                    >
                      {isSavingSchedule ? 'Saving…' : '💾 Save & Sync Schedule'}
                    </button>
                  </div>
                </div>

                {/* Add Exam Schedule Row Form */}
                <form onSubmit={handleAddScheduleRow} className="adv-add-student-form" style={{ marginBottom: '14px' }}>
                  <input
                    type="text"
                    className="adv-input"
                    placeholder="Day & Date (e.g. Mon, 30 Nov 2026)"
                    value={newSchedDate}
                    onChange={(e) => setNewSchedDate(e.target.value)}
                    style={{ flex: '1.3 1 150px' }}
                  />
                  <input
                    type="text"
                    className="adv-input"
                    placeholder="Time (e.g. 07.30 - 09.30)"
                    value={newSchedTime}
                    onChange={(e) => setNewSchedTime(e.target.value)}
                    style={{ flex: '1 1 130px' }}
                  />
                  <input
                    type="text"
                    className="adv-input"
                    placeholder="Subject / Paper..."
                    value={newSchedSubject}
                    onChange={(e) => setNewSchedSubject(e.target.value)}
                    style={{ flex: '1.4 1 150px' }}
                  />
                  <input
                    type="text"
                    className="adv-input"
                    placeholder="Dur (e.g. 120')"
                    value={newSchedDuration}
                    onChange={(e) => setNewSchedDuration(e.target.value)}
                    style={{ flex: '0.5 1 75px' }}
                  />
                  <input
                    type="text"
                    className="adv-input"
                    placeholder="Target (ALL, IPA, IPS, X IPA...)"
                    value={newSchedTarget}
                    onChange={(e) => setNewSchedTarget(e.target.value)}
                    style={{ flex: '0.8 1 115px' }}
                  />
                  <select
                    className="adv-input"
                    value={newSchedCategory}
                    onChange={(e) => setNewSchedCategory(e.target.value as ExamScheduleCategory)}
                    style={{ flex: '0.7 1 105px' }}
                  >
                    <option value="written">Written</option>
                    <option value="practical">Practical</option>
                  </select>
                  <button
                    type="submit"
                    className="adv-btn-primary"
                    disabled={!newSchedDate.trim() || !newSchedTime.trim() || !newSchedSubject.trim()}
                  >
                    + Add Session
                  </button>
                </form>

                {/* Editable Schedule Table */}
                <div className="adv-table-container">
                  {examSchedule.length === 0 ? (
                    <div className="adv-table-empty">
                      No exam schedule sessions configured. Click <strong>📅 Load ICM 1st Sem 26/27</strong> or add a session above.
                    </div>
                  ) : (
                    <table className="adv-table">
                      <thead>
                        <tr>
                          <th style={{ width: '165px' }}>Day / Date</th>
                          <th style={{ width: '150px' }}>Time</th>
                          <th>Subject / Paper</th>
                          <th style={{ width: '75px' }}>Dur.</th>
                          <th style={{ width: '115px' }}>Target Class</th>
                          <th style={{ width: '105px' }}>Type</th>
                          <th style={{ width: '40px' }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {examSchedule.map((row, idx) => (
                          <tr key={row.id || idx}>
                            <td>
                              <input
                                type="text"
                                className="adv-input"
                                style={{ padding: '4px 6px', fontSize: '0.78rem', width: '100%' }}
                                value={row.date}
                                onChange={(e) => handleUpdateScheduleRow(idx, { date: e.target.value })}
                              />
                            </td>
                            <td>
                              <input
                                type="text"
                                className="adv-input"
                                style={{ padding: '4px 6px', fontSize: '0.78rem', width: '100%' }}
                                value={row.time}
                                onChange={(e) => handleUpdateScheduleRow(idx, { time: e.target.value })}
                              />
                            </td>
                            <td>
                              <input
                                type="text"
                                className="adv-input"
                                style={{ padding: '4px 6px', fontSize: '0.78rem', width: '100%' }}
                                value={row.subject}
                                onChange={(e) => handleUpdateScheduleRow(idx, { subject: e.target.value })}
                              />
                            </td>
                            <td>
                              <input
                                type="text"
                                className="adv-input"
                                style={{ padding: '4px 6px', fontSize: '0.78rem', width: '100%' }}
                                value={row.duration || ''}
                                onChange={(e) => handleUpdateScheduleRow(idx, { duration: e.target.value })}
                              />
                            </td>
                            <td>
                              <input
                                type="text"
                                className="adv-input"
                                style={{ padding: '4px 6px', fontSize: '0.78rem', width: '100%', fontWeight: 700 }}
                                value={row.targetClass || 'ALL'}
                                onChange={(e) => handleUpdateScheduleRow(idx, { targetClass: e.target.value })}
                              />
                            </td>
                            <td>
                              <select
                                className="adv-input"
                                style={{ padding: '4px 6px', fontSize: '0.75rem', width: '100%' }}
                                value={row.category || 'written'}
                                onChange={(e) =>
                                  handleUpdateScheduleRow(idx, {
                                    category: e.target.value as ExamScheduleCategory,
                                  })
                                }
                              >
                                <option value="written">Written</option>
                                <option value="practical">Practical</option>
                              </select>
                            </td>
                            <td>
                              <button
                                type="button"
                                className="adv-table-del-btn"
                                onClick={() => handleDeleteScheduleRow(idx)}
                                title={`Delete ${row.subject}`}
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

            {/* ── Multi-Tier Security Violation Escalation Policy ── */}
            <div className="adv-tier-policy-card">
              <div className="adv-tier-header">
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '1.25rem' }}>🚨</span>
                    <h3 className="adv-tier-title">Violation Escalation Tiers (School-Wide Policy)</h3>
                    <span className="adv-tier-count-badge">
                      {securityTiers.length} {securityTiers.length === 1 ? 'Tier' : 'Tiers'}
                    </span>
                  </div>
                  <p className="adv-tier-subtitle">
                    Progressive actions enforced when candidates commit security strikes (tab-switching, exiting fullscreen, unauthorized window blur, or multi-monitor extensions).
                  </p>
                </div>
                <div className="adv-tier-header-actions">
                  <button
                    type="button"
                    className="adv-btn-secondary"
                    onClick={handleRestoreDefaultTiers}
                    title="Restore default 4-tier policy (Warning → -5m → -10m → Auto Submit)"
                  >
                    ↺ Restore 4-Tier Default
                  </button>
                  <button
                    type="button"
                    className="adv-btn-primary"
                    onClick={handleSaveTiers}
                    disabled={isSavingTiers || !tierValidation.ok}
                  >
                    {isSavingTiers ? 'Saving…' : '💾 Save & Sync Tiers'}
                  </button>
                </div>
              </div>

              {/* Live Flow Breadcrumb Pill Bar */}
              <div className="adv-tier-flow-bar">
                <span className="adv-tier-flow-label">Active Escalation Flow:</span>
                <div className="adv-tier-flow-pills">
                  {securityTiers.map((t, idx) => (
                    <div key={t.id || idx} className="adv-tier-flow-item">
                      <div className={`adv-tier-pill adv-tier-pill--${t.action}`}>
                        <span className="adv-tier-pill-strike">Strike {t.strikeCount}:</span>
                        <span className="adv-tier-pill-name">{t.name}</span>
                        {t.action === 'time_penalty' && (
                          <span className="adv-tier-pill-penalty">(-{t.penaltyMinutes || 5}m)</span>
                        )}
                        {t.action === 'auto_submit' && (
                          <span className="adv-tier-pill-auto">🛑 Auto-Submit</span>
                        )}
                      </div>
                      {idx < securityTiers.length - 1 && <span className="adv-tier-flow-arrow">→</span>}
                    </div>
                  ))}
                </div>
              </div>

              {/* Inline Validation Banner */}
              {!tierValidation.ok && (
                <div className="adv-tier-validation-alert">
                  <strong>⚠️ Policy Configuration Issues:</strong>
                  <ul>
                    {tierValidation.errors.map((err: string, i: number) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Tiers Editor List */}
              <div className="adv-tier-list">
                {securityTiers.map((tier, idx) => {
                  const isFinal = idx === securityTiers.length - 1;
                  return (
                    <div
                      key={tier.id || idx}
                      className={`adv-tier-card adv-tier-card--${tier.action} ${isFinal ? 'adv-tier-card--final' : ''}`}
                    >
                      {/* Top Row: Core Rule Attributes */}
                      <div className="adv-tier-card-top">
                        <div className="adv-tier-field adv-tier-field--strike">
                          <label className="adv-tier-field-label">Strike #</label>
                          <div className="adv-tier-strike-input-wrap">
                            <span className={`adv-tier-strike-pill ${isFinal ? 'adv-tier-strike-pill--final' : ''}`}>
                              #{tier.strikeCount}
                            </span>
                            <input
                              type="number"
                              className="adv-input adv-tier-input-strike"
                              min={1}
                              max={50}
                              value={tier.strikeCount}
                              onChange={(e) =>
                                handleUpdateTier(idx, { strikeCount: parseInt(e.target.value, 10) || 1 })
                              }
                              title="Strike count threshold"
                            />
                          </div>
                        </div>

                        <div className="adv-tier-field adv-tier-field--name">
                          <label className="adv-tier-field-label">Tier Display Name</label>
                          <input
                            type="text"
                            className="adv-input adv-tier-input-name"
                            placeholder="e.g. Warning with Penalty"
                            value={tier.name}
                            onChange={(e) => handleUpdateTier(idx, { name: e.target.value })}
                          />
                        </div>

                        <div className="adv-tier-field adv-tier-field--action">
                          <label className="adv-tier-field-label">Enforced Action</label>
                          <select
                            className="adv-input adv-tier-select-action"
                            value={tier.action}
                            onChange={(e) => {
                              const newAction = e.target.value as SecurityTierAction;
                              handleUpdateTier(idx, {
                                action: newAction,
                                penaltyMinutes: newAction === 'time_penalty' ? (tier.penaltyMinutes || 5) : 0,
                              });
                            }}
                          >
                            <option value="warning">Early Warning (PIN Unlock, No Penalty)</option>
                            <option value="time_penalty">Warning with Time Penalty (PIN Unlock + Deduct Time)</option>
                            <option value="auto_submit">Final Warning (Lock & Auto-Submit Immediately)</option>
                          </select>
                        </div>

                        <div className="adv-tier-field adv-tier-field--penalty">
                          <label className="adv-tier-field-label">Time Deduction</label>
                          {tier.action === 'time_penalty' ? (
                            <div className="adv-tier-penalty-input-group">
                              <input
                                type="number"
                                className="adv-input adv-tier-input-penalty"
                                min={1}
                                max={120}
                                value={tier.penaltyMinutes ?? 5}
                                onChange={(e) =>
                                  handleUpdateTier(idx, {
                                    penaltyMinutes: Math.max(1, parseInt(e.target.value, 10) || 1),
                                  })
                                }
                              />
                              <span className="adv-tier-penalty-unit">mins</span>
                            </div>
                          ) : (
                            <span className={`adv-tier-action-badge adv-tier-action-badge--${tier.action}`}>
                              {tier.action === 'auto_submit' ? '🛑 Irreversible' : '0 min (None)'}
                            </span>
                          )}
                        </div>

                        <div className="adv-tier-del-wrap">
                          <button
                            type="button"
                            className="adv-tier-del-btn"
                            disabled={securityTiers.length <= 1 || isFinal}
                            onClick={() => handleDeleteTier(idx)}
                            title={isFinal ? 'Final auto-submit tier cannot be removed' : 'Remove escalation tier'}
                          >
                            🗑️
                          </button>
                        </div>
                      </div>

                      {/* Bottom Row: Candidate Lock Notice */}
                      <div className="adv-tier-card-bottom">
                        <div className="adv-tier-field adv-tier-field--notice">
                          <label className="adv-tier-field-label">
                            Lock Screen Student Notice{' '}
                            <span className="adv-tier-field-hint">(Shown on candidate's device when locked)</span>
                          </label>
                          <input
                            type="text"
                            className="adv-input adv-tier-input-notice"
                            placeholder="Optional message shown on candidate lock screen..."
                            value={tier.studentNotice || ''}
                            onChange={(e) => handleUpdateTier(idx, { studentNotice: e.target.value })}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Add Tier Action */}
              <div className="adv-tier-footer-row">
                <button
                  type="button"
                  className="adv-btn-secondary"
                  onClick={handleAddTier}
                  disabled={securityTiers.length >= 10}
                >
                  + Add Escalation Tier
                </button>
                <span style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
                  Tiers are enforced sequentially. The final tier must be <strong>Final Warning (Auto Submit)</strong>.
                </span>
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

              {/* Require Personal Candidate PIN Default */}
              <div className="adv-setting-card">
                <div className="adv-setting-info">
                  <strong className="adv-setting-title">🪪 Require Personal Candidate PIN (Default)</strong>
                  <p className="adv-setting-desc">
                    Enables the 4-digit school roster PIN gate by default whenever new formal examinations are published in Interactive Quizzes.
                  </p>
                </div>
                <button
                  type="button"
                  className={`adv-toggle-btn ${settings.defaultRequireStudentPin ? 'adv-toggle-btn--active' : ''}`}
                  onClick={() => updateSetting('defaultRequireStudentPin', !settings.defaultRequireStudentPin)}
                >
                  {settings.defaultRequireStudentPin ? 'Enabled' : 'Disabled'}
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

              {/* Emergency Save Button Visibility */}
              <div className="adv-setting-card">
                <div className="adv-setting-info">
                  <strong className="adv-setting-title">⚠️ Hide Emergency Save Button (Exam Runner)</strong>
                  <p className="adv-setting-desc">
                    Hides the "⚠️ Emergency Save" button in the candidate exam interface. When hidden, students cannot self-initiate emergency offline hand-in, preventing unauthorized early exits or distractions.
                  </p>
                </div>
                <button
                  type="button"
                  className={`adv-toggle-btn ${settings.hideEmergencyExamButton ? 'adv-toggle-btn--active' : ''}`}
                  onClick={() => handleToggleHideEmergencyExamButton(!settings.hideEmergencyExamButton)}
                >
                  {settings.hideEmergencyExamButton ? 'Hidden (Active)' : 'Visible (Default)'}
                </button>
              </div>

              {/* Educator Account Creation & Profile Claiming */}
              <div className="adv-setting-card">
                <div className="adv-setting-info">
                  <strong className="adv-setting-title">🔐 Educator Account Claiming & Self-Registration</strong>
                  <p className="adv-setting-desc">
                    When enabled, educators can create new accounts or claim passwordless legacy profiles from the Educator Portal login screen using the 6-digit School Master PIN. Keep disabled when accounts are managed centrally.
                  </p>
                </div>
                <button
                  type="button"
                  className={`adv-toggle-btn ${settings.allowTeacherAccountClaiming ? 'adv-toggle-btn--active' : ''}`}
                  onClick={() => handleToggleTeacherAccountClaiming(!settings.allowTeacherAccountClaiming)}
                >
                  {settings.allowTeacherAccountClaiming ? 'Enabled' : 'Disabled (Default)'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ─── SECTION 3: Topic Mastery & Academic Reporting Standards ────────── */}
        {activeSection === 'mastery' && (
          <div className="adv-section-card">
            <div className="adv-section-header">
              <div>
                <h2 className="adv-section-title">🎯 Topic Mastery & Reporting Bands</h2>
                <p className="adv-section-subtitle">
                  Configure percentage cutoffs, labels, color coding, and focus guidance used across individual student Excel reports and diagnostic sheets.
                </p>
              </div>
            </div>

            <div className="adv-tier-policy-card">
              <div className="adv-tier-header">
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '1.25rem' }}>📊</span>
                    <h3 className="adv-tier-title">Topic Mastery Classification Bands</h3>
                    <span className="adv-tier-count-badge">
                      {topicMasteryTiers.length} {topicMasteryTiers.length === 1 ? 'Band' : 'Bands'}
                    </span>
                  </div>
                  <p className="adv-tier-subtitle">
                    Scores are matched against the highest tier whose minimum percentage is met (sorted highest to lowest).
                  </p>
                </div>
                <div className="adv-tier-header-actions">
                  <button
                    type="button"
                    className="adv-btn-secondary"
                    onClick={handleRestoreDefaultMasteryTiers}
                    title="Restore default mastery bands (75% Mastered, 50% Developing, 0% Needs Support)"
                  >
                    ↺ Restore Defaults
                  </button>
                  <button
                    type="button"
                    className="adv-btn-primary"
                    onClick={handleSaveMasteryTiers}
                    disabled={isSavingMasteryTiers || !masteryTierValidation.ok}
                  >
                    {isSavingMasteryTiers ? 'Saving…' : '💾 Save & Sync Bands'}
                  </button>
                </div>
              </div>

              {/* Active Bands Preview */}
              <div className="adv-tier-flow-bar">
                <span className="adv-tier-flow-label">Active Bands:</span>
                <div className="adv-tier-flow-pills">
                  {[...topicMasteryTiers]
                    .sort((a, b) => b.minPercentage - a.minPercentage)
                    .map((tier, idx, arr) => (
                      <div key={tier.id || idx} className="adv-tier-flow-item">
                        <div className={`adv-tier-pill adv-tier-pill--mastery-${tier.color}`}>
                          <span className="adv-tier-pill-strike">&ge; {tier.minPercentage}%:</span>
                          <span className="adv-tier-pill-name">{tier.label || 'Untitled'}</span>
                        </div>
                        {idx < arr.length - 1 && <span className="adv-tier-flow-arrow">·</span>}
                      </div>
                    ))}
                </div>
              </div>

              {!masteryTierValidation.ok && (
                <div className="adv-tier-validation-alert">
                  <strong>⚠️ Mastery Band Configuration Issues:</strong>
                  <ul>
                    {masteryTierValidation.errors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="adv-tier-list">
                {topicMasteryTiers.map((tier, idx) => {
                  const isBaseline = tier.minPercentage === 0;
                  return (
                    <div
                      key={tier.id || idx}
                      className={`adv-tier-card adv-tier-card--mastery-${tier.color}`}
                    >
                      <div className="adv-tier-card-top">
                        <div className="adv-tier-field adv-tier-field--strike">
                          <label className="adv-tier-field-label">Min %</label>
                          <div className="adv-tier-strike-input-wrap">
                            <input
                              type="number"
                              className="adv-input adv-tier-input-strike"
                              min={0}
                              max={100}
                              value={tier.minPercentage}
                              onChange={(e) =>
                                handleUpdateMasteryTier(idx, {
                                  minPercentage: Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                                })
                              }
                            />
                          </div>
                        </div>

                        <div className="adv-tier-field adv-tier-field--name">
                          <label className="adv-tier-field-label">Mastery Label</label>
                          <input
                            type="text"
                            className="adv-input adv-tier-input-name"
                            placeholder="e.g. Mastered"
                            value={tier.label}
                            onChange={(e) => handleUpdateMasteryTier(idx, { label: e.target.value })}
                          />
                        </div>

                        <div className="adv-tier-field adv-tier-field--action">
                          <label className="adv-tier-field-label">Report Color Tone</label>
                          <select
                            className="adv-input adv-tier-select-action"
                            value={tier.color}
                            onChange={(e) =>
                              handleUpdateMasteryTier(idx, { color: e.target.value as MasteryTierColor })
                            }
                          >
                            <option value="emerald">Emerald (Green — High Mastery)</option>
                            <option value="blue">Blue (Developing / On Track)</option>
                            <option value="amber">Amber (Caution / Consolidating)</option>
                            <option value="crimson">Crimson (Red — Needs Support)</option>
                          </select>
                        </div>

                        <div className="adv-tier-del-wrap">
                          <button
                            type="button"
                            className="adv-tier-del-btn"
                            disabled={topicMasteryTiers.length <= 1 || isBaseline}
                            onClick={() => handleDeleteMasteryTier(idx)}
                            title={isBaseline ? '0% baseline tier cannot be removed' : 'Remove mastery band'}
                          >
                            🗑️
                          </button>
                        </div>
                      </div>

                      <div className="adv-tier-card-bottom">
                        <div className="adv-tier-field adv-tier-field--notice">
                          <label className="adv-tier-field-label">
                            Focus / Examiner Recommendation Note{' '}
                            <span className="adv-tier-field-hint">(Printed beside matching topics in Excel report)</span>
                          </label>
                          <input
                            type="text"
                            className="adv-input adv-tier-input-notice"
                            placeholder="Optional recommendation shown in the Topic Mastery tab..."
                            value={tier.recommendation || ''}
                            onChange={(e) =>
                              handleUpdateMasteryTier(idx, { recommendation: e.target.value })
                            }
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="adv-tier-footer-row">
                <button
                  type="button"
                  className="adv-btn-secondary"
                  onClick={handleAddMasteryTier}
                  disabled={topicMasteryTiers.length >= 8}
                >
                  + Add Mastery Band
                </button>
                <span style={{ fontSize: '0.75rem', color: 'var(--color-text-tertiary)' }}>
                  Changes apply automatically to single and batch Excel reports (0% baseline band is required).
                </span>
              </div>
            </div>
          </div>
        )}

        {/* ─── SECTION 4: Cloud Backup & Storage Safety ──────────────────────── */}
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

        {/* ─── SECTION 5: Educator Accounts & Access Management ───────────────── */}
        {activeSection === 'teachers' && (
          <div className="adv-section-card">
            <div className="adv-section-header">
              <div>
                <h2 className="adv-section-title">👩‍🏫 Educator Accounts &amp; Central Provisioning</h2>
                <p className="adv-section-subtitle">
                  Create teacher or admin login accounts with temporary passwords, manage teaching cohorts and subjects, reset passwords, or suspend access without sharing the School Master PIN.
                </p>
              </div>
              <button
                type="button"
                className="adv-btn-secondary"
                onClick={refreshTeacherAccountsList}
                disabled={isLoadingTeachers}
              >
                {isLoadingTeachers ? '⏳ Syncing…' : '🔄 Refresh Accounts'}
              </button>
            </div>

            {issuedCredentialsBanner && (
              <div className="adv-teacher-credentials-banner">
                <div>
                  <strong className="adv-teacher-credentials-title">
                    🔑 Credentials Ready for {issuedCredentialsBanner.name} ({issuedCredentialsBanner.role})
                  </strong>
                  <div className="adv-teacher-credentials-meta">
                    Login Identifier: <code>{issuedCredentialsBanner.identifier}</code> · Password:{' '}
                    <code>{issuedCredentialsBanner.password}</code>{' '}
                    {issuedCredentialsBanner.mustChange ? '(Must change on first sign-in)' : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className="adv-btn-primary"
                    onClick={() => {
                      const text = `Educator Portal Login (${issuedCredentialsBanner.name})\nUsername/Email: ${issuedCredentialsBanner.identifier}\nTemporary Password: ${issuedCredentialsBanner.password}${issuedCredentialsBanner.mustChange ? '\n(You will be prompted to set a personal password on first sign-in.)' : ''}`;
                      navigator.clipboard?.writeText(text);
                      showNotice('✓ Copied login credentials to clipboard');
                    }}
                  >
                    📋 Copy Credentials
                  </button>
                  <button
                    type="button"
                    className="adv-btn-secondary"
                    onClick={() => setIssuedCredentialsBanner(null)}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            )}

            {/* Create Educator Account Form */}
            <form
              onSubmit={handleCreateTeacherSubmit}
              className="adv-tier-policy-card"
              style={{ marginBottom: '1.5rem' }}
            >
              <div className="adv-tier-header">
                <div>
                  <h3 className="adv-tier-title">➕ Provision New Educator Account</h3>
                  <p className="adv-tier-subtitle">
                    Creates an active login account directly in Supabase without switching your current session.
                  </p>
                </div>
              </div>

              {teacherFormError && (
                <div className="adv-teacher-form-error">
                  ⚠️ {teacherFormError}
                </div>
              )}

              <div className="adv-teacher-form-grid">
                <div className="adv-teacher-field">
                  <label htmlFor="adv-new-teacher-title" className="adv-teacher-label">Title</label>
                  <select
                    id="adv-new-teacher-title"
                    className="adv-input"
                    value={newTeacherTitle}
                    onChange={(e) => setNewTeacherTitle(e.target.value)}
                  >
                    {['Dr.', 'Mr.', 'Ms.', 'Mrs.', 'Ibu', 'Bapak', 'Pak', 'Ustadz', 'Ustadzah'].map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="adv-teacher-field">
                  <label htmlFor="adv-new-teacher-name" className="adv-teacher-label">Full Display Name *</label>
                  <input
                    id="adv-new-teacher-name"
                    type="text"
                    className="adv-input"
                    placeholder="e.g. Siti Rahma"
                    value={newTeacherName}
                    onChange={(e) => setNewTeacherName(e.target.value)}
                    required
                  />
                </div>

                <div className="adv-teacher-field">
                  <label htmlFor="adv-new-teacher-username" className="adv-teacher-label">Username *</label>
                  <input
                    id="adv-new-teacher-username"
                    type="text"
                    className="adv-input"
                    placeholder="e.g. siti.bio"
                    value={newTeacherUsername}
                    onChange={(e) => setNewTeacherUsername(e.target.value)}
                  />
                </div>

                <div className="adv-teacher-field">
                  <label htmlFor="adv-new-teacher-email" className="adv-teacher-label">School Email</label>
                  <input
                    id="adv-new-teacher-email"
                    type="email"
                    className="adv-input"
                    placeholder="siti@icm.sch.id"
                    value={newTeacherEmail}
                    onChange={(e) => setNewTeacherEmail(e.target.value)}
                  />
                </div>

                <div className="adv-teacher-field">
                  <label htmlFor="adv-new-teacher-role" className="adv-teacher-label">Role</label>
                  <select
                    id="adv-new-teacher-role"
                    className="adv-input"
                    value={newTeacherRole}
                    onChange={(e) => setNewTeacherRole(e.target.value as 'teacher' | 'admin')}
                  >
                    <option value="teacher">👩‍🏫 Teacher</option>
                    <option value="admin">🛡️ Administrator</option>
                  </select>
                </div>

                <div className="adv-teacher-field">
                  <label htmlFor="adv-new-teacher-subject" className="adv-teacher-label">Primary Subject</label>
                  <select
                    id="adv-new-teacher-subject"
                    className="adv-input"
                    value={newTeacherSubject}
                    onChange={(e) => setNewTeacherSubject(e.target.value)}
                  >
                    {(subjects.length > 0 ? subjects : DEFAULT_SUBJECTS).map((subj) => (
                      <option key={subj} value={subj}>
                        {subj}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="adv-teacher-field">
                  <label htmlFor="adv-new-teacher-code" className="adv-teacher-label">Syllabus Code</label>
                  <input
                    id="adv-new-teacher-code"
                    type="text"
                    className="adv-input"
                    placeholder="e.g. 0610"
                    value={newTeacherSubjectCode}
                    onChange={(e) => setNewTeacherSubjectCode(e.target.value)}
                  />
                </div>

                <div className="adv-teacher-field">
                  <label htmlFor="adv-new-teacher-pw" className="adv-teacher-label">Initial / Temp Password *</label>
                  <div className="adv-teacher-pw-group">
                    <input
                      id="adv-new-teacher-pw"
                      type="text"
                      className="adv-input adv-input-mono"
                      value={newTeacherPassword}
                      onChange={(e) => setNewTeacherPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      className="adv-btn-secondary"
                      title="Generate random temporary password"
                      onClick={() => setNewTeacherPassword(generateTemporaryTeacherPassword())}
                    >
                      🎲
                    </button>
                  </div>
                </div>
              </div>

              {/* Teaching Cohorts Multi-Select */}
              <div style={{ marginBottom: '16px' }}>
                <span className="adv-teacher-label" style={{ marginBottom: '8px' }}>
                  Default Teaching Cohorts / Classes
                </span>
                <div className="adv-cohort-pills-wrap">
                  {(settings.classes || DEFAULT_CLASSES).map((cls) => {
                    const active = newTeacherClasses.includes(cls);
                    return (
                      <button
                        key={cls}
                        type="button"
                        onClick={() => toggleNewTeacherClass(cls)}
                        className={`adv-cohort-pill ${active ? 'adv-cohort-pill--active' : ''}`}
                      >
                        {active ? '✓ ' : '+ '}
                        {cls}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="adv-teacher-form-footer">
                <label className="adv-teacher-checkbox-label">
                  <input
                    type="checkbox"
                    checked={newTeacherMustChangePw}
                    onChange={(e) => setNewTeacherMustChangePw(e.target.checked)}
                  />
                  <span>Require educator to change password on first sign-in</span>
                </label>

                <button type="submit" className="adv-btn-primary" disabled={isCreatingTeacher}>
                  {isCreatingTeacher ? '⏳ Creating Account…' : '➕ Create Educator Account'}
                </button>
              </div>
            </form>

            {/* Educator Directory List */}
            <div className="adv-tier-policy-card">
              <div className="adv-tier-header">
                <div>
                  <h3 className="adv-tier-title">
                    📋 Registered Educator Accounts ({teacherAccounts.length})
                  </h3>
                  <p className="adv-tier-subtitle">
                    Manage credentials, roles, subject assignments, and session access across all educators. To upgrade a legacy profile without a password, click <strong>Register / Edit</strong> on that educator card.
                  </p>
                </div>
              </div>

              {teacherDirectoryError && (
                <div className="adv-teacher-form-error">
                  ⚠️ {teacherDirectoryError}
                </div>
              )}

              <div className="adv-teacher-directory-list">
                {teacherAccounts.map((t) => {
                  const isEditing = editingTeacherId === t.id;
                  const isResettingPw = resetPwTeacherId === t.id;
                  const isSuspended = t.is_active === false;
                  const subjectOptions = Array.from(
                    new Set([
                      ...(subjects.length > 0 ? subjects : DEFAULT_SUBJECTS),
                      ...(editTeacherSubject ? [editTeacherSubject] : []),
                    ])
                  );

                  return (
                    <div
                      key={t.id}
                      className={`adv-teacher-row-card ${isSuspended ? 'adv-teacher-row-card--suspended' : ''}`}
                    >
                      <div className="adv-teacher-row-top">
                        <div className="adv-teacher-row-identity">
                          <div className="adv-teacher-row-title-line">
                            <span className="adv-teacher-row-name">
                              {formatEducatorDisplayName(t.title, t.name)}
                            </span>
                            <span
                              className={`adv-teacher-badge ${
                                t.role === 'admin' ? 'adv-teacher-badge--admin' : 'adv-teacher-badge--teacher'
                              }`}
                            >
                              {t.role === 'admin' ? '🛡️ Admin' : '👩‍🏫 Teacher'}
                            </span>
                            <span
                              className={`adv-teacher-badge ${
                                isSuspended ? 'adv-teacher-badge--suspended' : 'adv-teacher-badge--active'
                              }`}
                            >
                              {isSuspended ? '⛔ Suspended' : '● Active'}
                            </span>
                            <span
                              className={`adv-teacher-badge ${
                                t.must_change_password
                                  ? 'adv-teacher-badge--pw-temp'
                                  : t.has_password
                                    ? 'adv-teacher-badge--pw-ok'
                                    : 'adv-teacher-badge--pw-legacy'
                              }`}
                            >
                              {t.must_change_password
                                ? '⏳ Temp Password (Change on Sign-In)'
                                : t.has_password
                                  ? '🔑 Password Configured'
                                  : '🔓 Legacy (No Password)'}
                            </span>
                          </div>

                          <div className="adv-teacher-row-meta">
                            {t.username ? `@${t.username}` : 'No username'} · {t.email || 'No email'} ·{' '}
                            <strong>
                              {t.subject}
                              {t.subject_code ? ` (${t.subject_code})` : ''}
                            </strong>{' '}
                            · Cohorts: {(t.default_classes || []).join(', ') || 'None'}
                          </div>
                        </div>

                        <div className="adv-teacher-actions">
                          <button
                            type="button"
                            className="adv-btn-secondary"
                            onClick={() => (isEditing ? setEditingTeacherId(null) : handleStartEditTeacher(t))}
                          >
                            {isEditing
                              ? '✕ Cancel Edit'
                              : !t.has_password
                                ? '⚡ Register / Edit'
                                : '✏️ Edit'}
                          </button>
                          <button
                            type="button"
                            className="adv-btn-secondary"
                            onClick={() =>
                              isResettingPw ? setResetPwTeacherId(null) : handleOpenResetTeacherPw(t)
                            }
                          >
                            🔑 Reset Password
                          </button>
                          <button
                            type="button"
                            className="adv-btn-secondary"
                            onClick={() => handleToggleTeacherActiveStatus(t)}
                          >
                            {isSuspended ? '✅ Activate' : '⏸️ Suspend'}
                          </button>
                          <button
                            type="button"
                            className="adv-btn-secondary adv-btn-danger-outline"
                            onClick={() => handleDeleteTeacher(t)}
                          >
                            🗑️ Delete
                          </button>
                        </div>
                      </div>

                      {/* Inline Password Reset Panel */}
                      {isResettingPw && (
                        <div className="adv-teacher-subpanel">
                          {resetPwError && (
                            <div className="adv-teacher-form-error" style={{ marginBottom: 0 }}>
                              ⚠️ {resetPwError}
                            </div>
                          )}
                          <div className="adv-teacher-reset-row">
                            <span className="adv-teacher-label">New / Temporary Password:</span>
                            <input
                              type="text"
                              className="adv-input adv-input-mono"
                              value={resetPwValue}
                              onChange={(e) => setResetPwValue(e.target.value)}
                            />
                            <button
                              type="button"
                              className="adv-btn-secondary"
                              onClick={() => setResetPwValue(generateTemporaryTeacherPassword())}
                            >
                              🎲 Generate
                            </button>
                            <label className="adv-teacher-checkbox-label">
                              <input
                                type="checkbox"
                                checked={resetPwMustChange}
                                onChange={(e) => setResetPwMustChange(e.target.checked)}
                              />
                              <span>Require change on next sign-in</span>
                            </label>
                            <button
                              type="button"
                              className="adv-btn-primary"
                              disabled={isResettingTeacherPw}
                              onClick={() => handleConfirmResetTeacherPw(t)}
                            >
                              {isResettingTeacherPw ? 'Saving…' : '💾 Save New Password'}
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Inline Edit Panel */}
                      {isEditing && (
                        <div className="adv-teacher-subpanel">
                          {editTeacherError && (
                            <div className="adv-teacher-form-error" style={{ marginBottom: 0 }}>
                              ⚠️ {editTeacherError}
                            </div>
                          )}
                          <div className="adv-teacher-form-grid" style={{ marginBottom: 0 }}>
                            <div className="adv-teacher-field">
                              <label className="adv-teacher-label">Title</label>
                              <select
                                className="adv-input"
                                value={editTeacherTitle}
                                onChange={(e) => setEditTeacherTitle(e.target.value)}
                              >
                                {Array.from(
                                  new Set([
                                    'Dr.',
                                    'Mr.',
                                    'Ms.',
                                    'Mrs.',
                                    'Ibu',
                                    'Bapak',
                                    'Pak',
                                    'Ustadz',
                                    'Ustadzah',
                                    ...(editTeacherTitle ? [editTeacherTitle] : []),
                                  ])
                                ).map((opt) => (
                                  <option key={opt} value={opt}>
                                    {opt}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="adv-teacher-field">
                              <label className="adv-teacher-label">Name</label>
                              <input
                                type="text"
                                className="adv-input"
                                value={editTeacherName}
                                onChange={(e) => setEditTeacherName(e.target.value)}
                              />
                            </div>
                            <div className="adv-teacher-field">
                              <label className="adv-teacher-label">Username</label>
                              <input
                                type="text"
                                className="adv-input"
                                placeholder="e.g. hamida.soc"
                                value={editTeacherUsername}
                                onChange={(e) => setEditTeacherUsername(e.target.value)}
                              />
                            </div>
                            <div className="adv-teacher-field">
                              <label className="adv-teacher-label">Email</label>
                              <input
                                type="email"
                                className="adv-input"
                                placeholder="name@icm.sch.id"
                                value={editTeacherEmail}
                                onChange={(e) => setEditTeacherEmail(e.target.value)}
                              />
                            </div>
                            <div className="adv-teacher-field">
                              <label className="adv-teacher-label">Role</label>
                              <select
                                className="adv-input"
                                value={editTeacherRole}
                                onChange={(e) => setEditTeacherRole(e.target.value as 'teacher' | 'admin')}
                              >
                                <option value="teacher">👩‍🏫 Teacher</option>
                                <option value="admin">🛡️ Admin</option>
                              </select>
                            </div>
                            <div className="adv-teacher-field">
                              <label className="adv-teacher-label">Subject</label>
                              <select
                                className="adv-input"
                                value={editTeacherSubject}
                                onChange={(e) => setEditTeacherSubject(e.target.value)}
                              >
                                {subjectOptions.map((s) => (
                                  <option key={s} value={s}>
                                    {s}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div className="adv-teacher-field">
                              <label className="adv-teacher-label">Syllabus Code</label>
                              <input
                                type="text"
                                className="adv-input"
                                value={editTeacherSubjectCode}
                                onChange={(e) => setEditTeacherSubjectCode(e.target.value)}
                              />
                            </div>
                            <div className="adv-teacher-field">
                              <label className="adv-teacher-label">
                                {t.has_password ? 'New Login Password (Optional)' : 'Set Login Password (Optional)'}
                              </label>
                              <div className="adv-teacher-pw-group">
                                <input
                                  type="text"
                                  className="adv-input adv-input-mono"
                                  placeholder="Leave blank to keep unchanged"
                                  value={editTeacherPassword}
                                  onChange={(e) => setEditTeacherPassword(e.target.value)}
                                />
                                <button
                                  type="button"
                                  className="adv-btn-secondary"
                                  title="Generate temporary password"
                                  onClick={() => setEditTeacherPassword(generateTemporaryTeacherPassword())}
                                >
                                  🎲
                                </button>
                              </div>
                            </div>
                          </div>

                          {editTeacherPassword.trim().length > 0 && (
                            <label className="adv-teacher-checkbox-label">
                              <input
                                type="checkbox"
                                checked={editTeacherMustChangePw}
                                onChange={(e) => setEditTeacherMustChangePw(e.target.checked)}
                              />
                              <span>Require educator to change password on first sign-in</span>
                            </label>
                          )}

                          <div>
                            <span className="adv-teacher-label" style={{ marginBottom: '8px' }}>
                              Teaching Cohorts / Classes
                            </span>
                            <div className="adv-cohort-pills-wrap">
                              {(settings.classes || DEFAULT_CLASSES).map((cls) => {
                                const active = editTeacherClasses.includes(cls);
                                return (
                                  <button
                                    key={cls}
                                    type="button"
                                    onClick={() => toggleEditTeacherClass(cls)}
                                    className={`adv-cohort-pill ${active ? 'adv-cohort-pill--active' : ''}`}
                                  >
                                    {active ? '✓ ' : '+ '}
                                    {cls}
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          <div className="adv-teacher-subpanel-footer">
                            <button
                              type="button"
                              className="adv-btn-secondary"
                              onClick={() => setEditingTeacherId(null)}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              className="adv-btn-primary"
                              disabled={isSavingTeacherEdit}
                              onClick={() => handleSaveEditTeacher(t.id)}
                            >
                              {isSavingTeacherEdit ? 'Saving…' : '💾 Save Changes'}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      <BackupRestoreModal
        isOpen={isBackupModalOpen}
        onClose={() => setIsBackupModalOpen(false)}
      />

      <CandidateCardPrintModal
        isOpen={isPrintCardsModalOpen}
        onClose={() => setIsPrintCardsModalOpen(false)}
        initialClassFilter={selectedRosterClass}
        rosterOverride={roster}
        scheduleOverride={examSchedule}
      />
    </div>
  );
}
