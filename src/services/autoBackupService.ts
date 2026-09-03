/**
 * Automated Background Backup Service for TestMaker.
 * Triggers silent cloud backups when conditions are met (e.g. after past paper extraction, or periodic interval).
 */

import { getSavedSettings, saveSettings } from '../lib/settings';
import { createFullBackupArchive } from './backupService';
import { uploadBackupToGoogleDrive } from './googleDriveService';

let activeDriveToken: string | null = null;
let isAutoBackingUp = false;

export function setSessionDriveToken(token: string | null) {
  activeDriveToken = token;
}

export function getSessionDriveToken(): string | null {
  return activeDriveToken;
}

/**
 * Evaluates if an automated backup is due, and performs a silent background backup if eligible.
 */
export async function triggerAutoBackupIfEligible(trigger: 'paper_upload' | 'interval'): Promise<boolean> {
  const settings = getSavedSettings();

  if (!settings.autoBackupEnabled || !activeDriveToken) {
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
    const result = await uploadBackupToGoogleDrive(activeDriveToken, archive.blob, archive.fileName);

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
  } catch (err) {
    console.warn('[AutoBackup] Automated cloud backup encountered an error:', err);
    return false;
  } finally {
    isAutoBackingUp = false;
  }
}
