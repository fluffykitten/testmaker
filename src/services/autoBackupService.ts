/**
 * Automated Background Backup Service for TestMaker.
 * Triggers silent cloud backups when conditions are met (e.g. after past paper extraction, or periodic interval).
 */

import { getSavedSettings, saveSettings } from '../lib/settings';
import { createFullBackupArchive } from './backupService';
import { uploadBackupToGoogleDrive, GoogleDriveAuthExpiredError } from './googleDriveService';

let activeDriveToken: string | null = null;
let activeDriveTokenExpiresAt: number = 0;
let isAutoBackingUp = false;
let periodicSchedulerTimer: any = null;

export function setSessionDriveToken(token: string | null, expiresInSec = 3600) {
  activeDriveToken = token;
  activeDriveTokenExpiresAt = token ? Date.now() + expiresInSec * 1000 : 0;
}

export function getSessionDriveToken(): string | null {
  if (!activeDriveToken) return null;
  // If expired, clear and return null
  if (activeDriveTokenExpiresAt > 0 && Date.now() >= activeDriveTokenExpiresAt) {
    activeDriveToken = null;
    activeDriveTokenExpiresAt = 0;
    return null;
  }
  return activeDriveToken;
}

export function isSessionDriveTokenValid(): boolean {
  return !!getSessionDriveToken();
}

/**
 * Initializes the periodic background scheduler for daily/weekly automated backups.
 * Runs an initial check shortly after startup and periodically checks every 15 minutes.
 */
export function initAutoBackupPeriodicScheduler() {
  if (periodicSchedulerTimer || typeof window === 'undefined') return;

  // Run initial check 15 seconds after app startup
  setTimeout(() => {
    triggerAutoBackupIfEligible('interval').catch(() => {});
  }, 15000);

  // Periodic interval check every 15 minutes
  periodicSchedulerTimer = setInterval(() => {
    triggerAutoBackupIfEligible('interval').catch(() => {});
  }, 15 * 60 * 1000);
}

/**
 * Evaluates if an automated backup is due, and performs a silent background backup if eligible.
 */
export async function triggerAutoBackupIfEligible(trigger: 'paper_upload' | 'interval'): Promise<boolean> {
  const settings = getSavedSettings();
  const token = getSessionDriveToken();

  if (!settings.autoBackupEnabled || !token) {
    return false;
  }

  if (isAutoBackingUp) {
    return false;
  }

  const freq = settings.autoBackupFrequency || 'on_paper_upload';
  const lastTime = settings.lastBackupTimestamp || 0;
  const now = Date.now();

  let isDue = false;

  if (trigger === 'paper_upload' && freq === 'on_paper_upload') {
    // Avoid double-backing up within 2 minutes
    if (now - lastTime > 2 * 60 * 1000) {
      isDue = true;
    }
  } else if (freq === 'daily') {
    if (now - lastTime >= 24 * 60 * 60 * 1000) {
      isDue = true;
    }
  } else if (freq === 'weekly') {
    if (now - lastTime >= 7 * 24 * 60 * 60 * 1000) {
      isDue = true;
    }
  }

  if (!isDue) return false;

  try {
    isAutoBackingUp = true;
    console.log('[AutoBackup] Initiating automated cloud backup to Google Drive…');

    const archive = await createFullBackupArchive();
    const result = await uploadBackupToGoogleDrive(token, archive.blob, archive.fileName);

    const updatedSettings = {
      ...settings,
      lastBackupTimestamp: now,
      lastBackupFileName: archive.fileName,
    };
    saveSettings(updatedSettings);

    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('testmaker_auto_backup_done', {
          detail: {
            fileName: archive.fileName,
            driveId: result.id,
            timestamp: now,
          },
        })
      );
    }

    console.log('[AutoBackup] Automated cloud backup completed successfully:', archive.fileName);
    return true;
  } catch (err: any) {
    if (err instanceof GoogleDriveAuthExpiredError) {
      console.warn('[AutoBackup] Google Drive authorization expired. Clearing session token.');
      setSessionDriveToken(null);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('testmaker_gdrive_auth_expired'));
      }
    } else {
      console.warn('[AutoBackup] Automated cloud backup encountered an error:', err);
    }
    return false;
  } finally {
    isAutoBackingUp = false;
  }
}
