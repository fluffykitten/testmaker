/**
 * Client-Side Google Drive Service for TestMaker Backups.
 * Uses Google Identity Services (GIS) OAuth 2.0 with the restricted 'drive.file' scope.
 * Only accesses files and folders created by TestMaker inside Google Drive.
 */

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: { access_token?: string; error?: any }) => void;
            error_callback?: (err: any) => void;
          }) => {
            requestAccessToken: (options?: { prompt?: string }) => void;
          };
        };
      };
    };
  }
}

export class GoogleDriveAuthExpiredError extends Error {
  constructor(message = 'Google Drive authorization expired. Please sign in again.') {
    super(message);
    this.name = 'GoogleDriveAuthExpiredError';
  }
}

export interface GoogleDriveBackupItem {
  id: string;
  name: string;
  sizeBytes?: number;
  createdTime: string;
  formattedSize: string;
}

export interface GoogleDriveTokenResult {
  accessToken: string;
  expiresIn: number; // in seconds
  expiresAt: number; // timestamp in ms
}

import {
  loadGsiScript,
  requestTokenViaDirectPopup,
  GIS_SCRIPT_URL,
  GSI_ERROR_HINT,
} from './googleAuthShared';

export { loadGsiScript, requestTokenViaDirectPopup, GIS_SCRIPT_URL, GSI_ERROR_HINT };

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const BACKUP_FOLDER_NAME = 'TestMaker Backups';

/**
 * Requests a Google Drive OAuth access token using Google Identity Services popup,
 * capturing token lifetime.
 */
export async function requestGoogleDriveToken(clientId: string): Promise<string> {
  const result = await requestGoogleDriveTokenDetails(clientId);
  return result.accessToken;
}

export async function requestGoogleDriveTokenDetails(clientId: string): Promise<GoogleDriveTokenResult> {
  let useGsi = false;
  try {
    await loadGsiScript();
    if (window.google?.accounts?.oauth2) {
      useGsi = true;
    }
  } catch (err) {
    console.warn('[GoogleDrive] GIS script unavailable or blocked by ad-blocker, falling back to direct popup:', err);
    useGsi = false;
  }

  if (useGsi) {
    try {
      return await new Promise<GoogleDriveTokenResult>((resolve, reject) => {
        try {
          const tokenClient = window.google!.accounts.oauth2.initTokenClient({
            client_id: clientId,
            scope: DRIVE_FILE_SCOPE,
            callback: (resp: any) => {
              if (resp.access_token) {
                const expiresIn = resp.expires_in ? Number(resp.expires_in) : 3600;
                const expiresAt = Date.now() + expiresIn * 1000;
                resolve({
                  accessToken: resp.access_token,
                  expiresIn,
                  expiresAt,
                });
              } else {
                reject(new Error(resp.error?.message || 'Google Drive authentication was cancelled.'));
              }
            },
            error_callback: (err: any) => {
              reject(new Error(err?.message || 'Google authentication error.'));
            },
          });

          tokenClient.requestAccessToken({ prompt: 'consent' });
        } catch (err: any) {
          reject(new Error(err?.message || 'Failed to initialize Google login.'));
        }
      });
    } catch (gsiErr: any) {
      const msg = gsiErr?.message || '';
      if (msg === 'popup_closed_by_user') {
        throw gsiErr;
      }
      console.warn('[GoogleDrive] GIS token client failed, attempting direct popup:', gsiErr);
    }
  }

  // Fallback: Direct Popup (Immune to ad-blockers and Brave Shields)
  const popupRes = await requestTokenViaDirectPopup(clientId, DRIVE_FILE_SCOPE, true);
  return {
    accessToken: popupRes.accessToken,
    expiresIn: popupRes.expiresIn,
    expiresAt: Date.now() + popupRes.expiresIn * 1000,
  };
}

/**
 * Finds the "TestMaker Backups" folder in Google Drive, or creates it if it doesn't exist.
 */
export async function findOrCreateBackupFolder(accessToken: string): Promise<string> {
  const query = encodeURIComponent(`mimeType='application/vnd.google-apps.folder' and name='${BACKUP_FOLDER_NAME}' and trashed=false`);
  const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)`;

  const searchRes = await fetch(searchUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (searchRes.status === 401) {
    throw new GoogleDriveAuthExpiredError();
  }

  if (!searchRes.ok) {
    const errText = await searchRes.text();
    throw new Error(`Google Drive search failed (${searchRes.status}): ${errText}`);
  }

  const data = await searchRes.json();
  if (data.files && data.files.length > 0) {
    return data.files[0].id;
  }

  // Create folder
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: BACKUP_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });

  if (createRes.status === 401) {
    throw new GoogleDriveAuthExpiredError();
  }

  if (!createRes.ok) {
    const errText = await createRes.text();
    throw new Error(`Failed to create Google Drive backup folder (${createRes.status}): ${errText}`);
  }

  const folder = await createRes.json();
  return folder.id;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Lists previous TestMaker backups stored in the Google Drive folder.
 */
export async function listGoogleDriveBackups(accessToken: string): Promise<GoogleDriveBackupItem[]> {
  const folderId = await findOrCreateBackupFolder(accessToken);
  const query = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name,size,createdTime)&orderBy=createdTime+desc`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401) {
    throw new GoogleDriveAuthExpiredError();
  }

  if (!res.ok) {
    throw new Error(`Failed to list Google Drive backups (${res.status})`);
  }

  const data = await res.json();
  const files = data.files || [];

  return files.map((f: any) => ({
    id: f.id,
    name: f.name,
    sizeBytes: f.size ? parseInt(f.size, 10) : undefined,
    createdTime: f.createdTime,
    formattedSize: f.size ? formatBytes(parseInt(f.size, 10)) : 'Unknown size',
  }));
}

/**
 * Uploads a backup archive (.zip) directly to Google Drive via multipart upload.
 */
export async function uploadBackupToGoogleDrive(
  accessToken: string,
  backupBlob: Blob,
  fileName: string
): Promise<{ id: string; name: string }> {
  const folderId = await findOrCreateBackupFolder(accessToken);

  const metadata = {
    name: fileName,
    parents: [folderId],
    mimeType: 'application/zip',
  };

  const boundary = '-------314159265358979323846';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const metadataPart = `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`;
  const mediaHeaderPart = `${delimiter}Content-Type: application/zip\r\n\r\n`;

  const metadataBlob = new Blob([metadataPart], { type: 'text/plain' });
  const mediaHeaderBlob = new Blob([mediaHeaderPart], { type: 'text/plain' });
  const closeBlob = new Blob([closeDelimiter], { type: 'text/plain' });

  const multipartBody = new Blob([metadataBlob, mediaHeaderBlob, backupBlob, closeBlob]);

  const uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart';

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: multipartBody,
  });

  if (res.status === 401) {
    throw new GoogleDriveAuthExpiredError();
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Google Drive upload failed (${res.status}): ${errText}`);
  }

  return await res.json();
}

/**
 * Downloads a backup file from Google Drive as a Blob.
 */
export async function downloadBackupFromGoogleDrive(
  accessToken: string,
  fileId: string
): Promise<Blob> {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401) {
    throw new GoogleDriveAuthExpiredError();
  }

  if (!res.ok) {
    throw new Error(`Failed to download backup from Google Drive (${res.status})`);
  }

  return await res.blob();
}

/**
 * Deletes an old backup file from Google Drive.
 */
export async function deleteGoogleDriveBackup(
  accessToken: string,
  fileId: string
): Promise<void> {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}`;

  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 401) {
    throw new GoogleDriveAuthExpiredError();
  }

  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to delete backup from Google Drive (${res.status})`);
  }
}
