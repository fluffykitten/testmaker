/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';
import type { TeacherProfile } from '../types/database';
import {
  fetchTeacherProfiles,
  getActiveTeacherProfileId,
  setActiveTeacherProfileId,
  verifyTeacherProfilePin,
  updateTeacherProfile,
} from '../services/teacherProfileService';

export interface TeacherProfileContextValue {
  activeProfile: TeacherProfile | null;
  profiles: TeacherProfile[];
  isLoading: boolean;
  isLocked: boolean;
  showAllSubjects: boolean;
  toggleShowAllSubjects: () => void;
  switchProfile: (profileId: string, enteredPin?: string) => Promise<{ success: boolean; error?: string }>;
  unlockProfile: (enteredPin: string) => Promise<boolean>;
  lockProfile: () => void;
  refreshProfiles: () => Promise<void>;
  updateCurrentProfile: (
    updates: Partial<Omit<TeacherProfile, 'id' | 'created_at'>> & { newPin?: string | null }
  ) => Promise<void>;
  isSubjectMatching: (subjectOrText?: string | null, syllabusIdOrCode?: string | null) => boolean;
}

export const TeacherProfileContext = createContext<TeacherProfileContextValue | null>(null);

export function TeacherProfileProvider({ children }: { children: ReactNode }) {
  const [profiles, setProfiles] = useState<TeacherProfile[]>([]);
  const [activeProfile, setActiveProfile] = useState<TeacherProfile | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isLocked, setIsLocked] = useState<boolean>(false);
  const [showAllSubjects, setShowAllSubjects] = useState<boolean>(false);

  const loadProfiles = useCallback(async () => {
    setIsLoading(true);
    try {
      const list = await fetchTeacherProfiles();
      setProfiles(list);

      const activeId = getActiveTeacherProfileId();
      const matched = activeId ? list.find((p) => p.id === activeId) || null : null;

      setActiveProfile(matched);
      setShowAllSubjects(matched?.preferences?.showOtherSubjects ?? false);
    } catch (err) {
      console.warn('Error loading teacher profiles:', err);
      setActiveProfile(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProfiles();

    const handleProfileChanged = () => {
      loadProfiles();
    };

    window.addEventListener('teacher_profile_changed', handleProfileChanged);
    window.addEventListener('teacher_profile_updated', handleProfileChanged);
    return () => {
      window.removeEventListener('teacher_profile_changed', handleProfileChanged);
      window.removeEventListener('teacher_profile_updated', handleProfileChanged);
    };
  }, [loadProfiles]);

  const toggleShowAllSubjects = useCallback(() => {
    setShowAllSubjects((prev) => {
      const next = !prev;
      if (activeProfile) {
        // Persist preference into profile
        updateTeacherProfile(activeProfile.id, {
          preferences: { ...activeProfile.preferences, showOtherSubjects: next },
        }).catch((err) => console.warn('Failed to persist showOtherSubjects:', err));
      }
      return next;
    });
  }, [activeProfile]);

  const switchProfile = useCallback(
    async (profileId: string, enteredPin?: string): Promise<{ success: boolean; error?: string }> => {
      const target = profiles.find((p) => p.id === profileId);
      if (!target) {
        return { success: false, error: 'Teacher profile not found' };
      }

      if (target.pin_hash) {
        if (!enteredPin) {
          return { success: false, error: 'PIN required' };
        }
        const valid = await verifyTeacherProfilePin(target, enteredPin);
        if (!valid) {
          return { success: false, error: 'Incorrect 4-digit PIN' };
        }
      }

      setActiveProfile(target);
      setActiveTeacherProfileId(target.id);
      setIsLocked(false);
      setShowAllSubjects(target.preferences.showOtherSubjects ?? false);
      return { success: true };
    },
    [profiles]
  );

  const unlockProfile = useCallback(
    async (enteredPin: string): Promise<boolean> => {
      if (!activeProfile) return true;
      const valid = await verifyTeacherProfilePin(activeProfile, enteredPin);
      if (valid) {
        setIsLocked(false);
        return true;
      }
      return false;
    },
    [activeProfile]
  );

  const lockProfile = useCallback(() => {
    if (activeProfile?.pin_hash) {
      setIsLocked(true);
    }
  }, [activeProfile]);

  const updateCurrentProfile = useCallback(
    async (
      updates: Partial<Omit<TeacherProfile, 'id' | 'created_at'>> & { newPin?: string | null }
    ): Promise<void> => {
      if (!activeProfile) return;
      const updated = await updateTeacherProfile(activeProfile.id, updates);
      setActiveProfile(updated);
      setProfiles((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    },
    [activeProfile]
  );

  /**
   * Helper to check if a test, question, or syllabus matches the active teacher's subject.
   */
  const isSubjectMatching = useCallback(
    (subjectOrText?: string | null, syllabusIdOrCode?: string | null): boolean => {
      if (showAllSubjects || !activeProfile) {
        return true; // "Show all subjects" toggle is ON
      }

      const activeSubj = activeProfile.subject.toLowerCase();
      const activeCode = (activeProfile.subject_code || '').toLowerCase().trim();

      if (activeCode && syllabusIdOrCode) {
        const normCode = syllabusIdOrCode.toLowerCase();
        if (normCode === activeCode || normCode.includes(activeCode)) {
          return true;
        }
      }

      if (subjectOrText) {
        const normSubj = subjectOrText.toLowerCase();
        if (normSubj.includes(activeSubj) || (activeCode && normSubj.includes(activeCode))) {
          return true;
        }
        // Specific Chemistry terms
        if (activeSubj === 'chemistry' && /chem|stoich|acid|periodic/i.test(normSubj)) {
          return true;
        }
      }

      return false;
    },
    [showAllSubjects, activeProfile]
  );

  return (
    <TeacherProfileContext.Provider
      value={{
        activeProfile,
        profiles,
        isLoading,
        isLocked,
        showAllSubjects,
        toggleShowAllSubjects,
        switchProfile,
        unlockProfile,
        lockProfile,
        refreshProfiles: loadProfiles,
        updateCurrentProfile,
        isSubjectMatching,
      }}
    >
      {children}
    </TeacherProfileContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTeacherProfile(): TeacherProfileContextValue {
  const ctx = useContext(TeacherProfileContext);
  if (!ctx) {
    throw new Error('useTeacherProfile must be used within a TeacherProfileProvider');
  }
  return ctx;
}
