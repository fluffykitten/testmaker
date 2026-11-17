/**
 * Incremental Local PC Folder Backup Service (File System Access API + IndexedDB).
 * Syncs database JSON snapshots and downloads ONLY new or missing diagrams, audio,
 * and PDFs into a user-chosen local folder without re-downloading or re-zipping old files.
 */

import {
  collectMediaUrls,
  fetchBackupDataset,
  fetchWithTimeout,
  planIncrementalMediaNames,
  type BackupManifest,
  type BackupProgressCallback,
} from './backupService';

export interface LocalFolderPermissionHandle extends FileSystemDirectoryHandle {
  queryPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
}

export interface LocalFolderSyncResult {
  folderName: string;
  manifest: BackupManifest;
  mediaSkippedExisting: number;
  mediaDownloadedNew: number;
  failedMediaCount: number;
}

const IDB_NAME = 'testmaker_local_backup_db';
const IDB_STORE = 'handles';
const HANDLE_KEY = 'backup_folder';

export function isLocalFolderSyncSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function' &&
    typeof indexedDB !== 'undefined'
  );
}

export function isDirectoryHandleLike(value: unknown): value is FileSystemDirectoryHandle {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    (value as FileSystemDirectoryHandle).kind === 'directory' &&
    typeof (value as FileSystemDirectoryHandle).getFileHandle === 'function' &&
    typeof (value as FileSystemDirectoryHandle).getDirectoryHandle === 'function'
  );
}

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB handle store'));
  });
}

export async function saveBackupFolderHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const db = await openHandleDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(handle, HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Failed to store folder handle'));
    });
  } finally {
    db.close();
  }
}

export async function loadSavedBackupFolderHandle(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await openHandleDb();
    try {
      const result = await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const req = tx.objectStore(IDB_STORE).get(HANDLE_KEY);
        req.onsuccess = () => resolve(isDirectoryHandleLike(req.result) ? req.result : null);
        req.onerror = () => reject(req.error);
      });
      return result;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function clearSavedBackupFolderHandle(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openHandleDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        tx.objectStore(IDB_STORE).delete(HANDLE_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  } catch {
    // Non-fatal IndexedDB cleanup failure
  }
}

export async function ensureFolderPermission(
  handle: FileSystemDirectoryHandle,
  mode: 'read' | 'readwrite' = 'readwrite'
): Promise<boolean> {
  const permHandle = handle as LocalFolderPermissionHandle;
  try {
    if (typeof permHandle.queryPermission === 'function') {
      const current = await permHandle.queryPermission({ mode });
      if (current === 'granted') return true;
    }
    if (typeof permHandle.requestPermission === 'function') {
      const requested = await permHandle.requestPermission({ mode });
      return requested === 'granted';
    }
    return true;
  } catch {
    return false;
  }
}

export async function pickBackupFolderHandle(
  mode: 'read' | 'readwrite' = 'readwrite'
): Promise<FileSystemDirectoryHandle> {
  if (!isLocalFolderSyncSupported()) {
    throw new Error('Local PC folder sync is only supported in Chromium desktop browsers (Chrome, Edge, Brave).');
  }
  const picker = (
    window as unknown as {
      showDirectoryPicker: (options?: {
        id?: string;
        mode?: 'read' | 'readwrite';
        startIn?: string;
      }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
  const handle = await picker({
    id: 'testmaker-backup-folder',
    mode,
    startIn: 'documents',
  });
  await saveBackupFolderHandle(handle);
  return handle;
}

export async function readTextFileFromDirectory(
  root: FileSystemDirectoryHandle,
  relativePath: string
): Promise<string | null> {
  const parts = relativePath.split('/').filter(Boolean);
  if (parts.length === 0) return null;

  let dir = root;
  try {
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create: false });
    }
    const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: false });
    const file = await fileHandle.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

async function writeFileToDirectory(
  root: FileSystemDirectoryHandle,
  relativePath: string,
  content: string | ArrayBuffer | Blob
): Promise<void> {
  const parts = relativePath.split('/').filter(Boolean);
  let dir = root;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i], { create: true });
  }
  const fileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(content);
  } finally {
    await writable.close();
  }
}

export async function listMediaFilesFromDirectory(
  root: FileSystemDirectoryHandle
): Promise<Array<{ fileName: string; size: number; getBlob: () => Promise<Blob> }>> {
  const result: Array<{ fileName: string; size: number; getBlob: () => Promise<Blob> }> = [];
  let diagramsDir: FileSystemDirectoryHandle;
  try {
    diagramsDir = await root.getDirectoryHandle('diagrams', { create: false });
  } catch {
    return result;
  }

  if (typeof diagramsDir.entries !== 'function') return result;

  for await (const [name, entry] of diagramsDir.entries()) {
    if (entry.kind !== 'file') continue;
    const fileHandle = entry as FileSystemFileHandle;
    const file = await fileHandle.getFile();
    if (file.size > 0) {
      result.push({
        fileName: name,
        size: file.size,
        getBlob: () => fileHandle.getFile(),
      });
    }
  }

  return result;
}

/**
 * Incrementally syncs all SQL tables (JSON) and only newly added/missing media assets
 * into the selected local PC folder.
 */
export async function executeLocalFolderSyncBackup(
  rootHandle: FileSystemDirectoryHandle,
  onProgress?: BackupProgressCallback
): Promise<LocalFolderSyncResult> {
  const granted = await ensureFolderPermission(rootHandle, 'readwrite');
  if (!granted) {
    throw new Error('Folder write permission was denied. Please grant access to sync your backup folder.');
  }

  // ─── Step 1: Fetch Database Tables ──────────────────────────────────────
  const dataset = await fetchBackupDataset(onProgress);

  // ─── Step 2: Write Fresh Database JSON Tables ───────────────────────────
  onProgress?.('Writing database snapshots to PC folder…', 34);
  await writeFileToDirectory(rootHandle, 'data/syllabuses.json', JSON.stringify(dataset.syllabuses, null, 2));
  await writeFileToDirectory(rootHandle, 'data/questions.json', JSON.stringify(dataset.questions, null, 2));
  await writeFileToDirectory(rootHandle, 'data/custom_tests.json', JSON.stringify(dataset.customTests, null, 2));
  await writeFileToDirectory(rootHandle, 'data/app_config.json', JSON.stringify(dataset.appConfig, null, 2));
  await writeFileToDirectory(rootHandle, 'data/quiz_submissions.json', JSON.stringify(dataset.quizSubmissions, null, 2));
  await writeFileToDirectory(rootHandle, 'data/teacher_profiles.json', JSON.stringify(dataset.teacherProfiles, null, 2));
  await writeFileToDirectory(rootHandle, 'data/proctor_audit_events.json', JSON.stringify(dataset.proctorAuditEvents, null, 2));
  await writeFileToDirectory(rootHandle, 'data/game_profiles.json', JSON.stringify(dataset.gameProfiles, null, 2));

  // ─── Step 3: Diff Against Existing Files on Disk ────────────────────────
  onProgress?.('Scanning existing media files in your backup folder…', 40);
  let existingMapping: Record<string, string> | undefined;
  const oldManifestText = await readTextFileFromDirectory(rootHandle, 'manifest.json');
  if (oldManifestText) {
    try {
      const oldManifest = JSON.parse(oldManifestText) as BackupManifest;
      existingMapping = oldManifest.diagramMapping;
    } catch {
      // Ignore malformed previous manifest and treat all files carefully
    }
  }

  const diskMedia = await listMediaFilesFromDirectory(rootHandle);
  const existingFilesOnDisk = new Set(diskMedia.map((m) => m.fileName));

  const mediaUrls = Array.from(collectMediaUrls(dataset.questions, dataset.appConfig));
  const plan = planIncrementalMediaNames(mediaUrls, existingMapping, existingFilesOnDisk);
  const diagramMapping = plan.diagramMapping;
  const failedMediaUrls: string[] = [];
  let mediaDownloadedNew = 0;

  if (plan.toDownload.length > 0) {
    onProgress?.(
      `Downloading ${plan.toDownload.length} new media file(s) (${plan.skippedExistingCount} already on PC)…`,
      45
    );

    const BATCH_SIZE = 6;
    for (let i = 0; i < plan.toDownload.length; i += BATCH_SIZE) {
      const batch = plan.toDownload.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async ({ url, fileName }) => {
          try {
            const res = await fetchWithTimeout(url, 15000);
            if (res.ok) {
              const buf = await res.arrayBuffer();
              await writeFileToDirectory(rootHandle, `diagrams/${fileName}`, buf);
              mediaDownloadedNew++;
            } else {
              failedMediaUrls.push(`${fileName} (HTTP ${res.status})`);
              delete diagramMapping[url];
            }
          } catch (err) {
            console.warn(`[LocalBackupFolder] Failed to download media ${url}:`, err);
            failedMediaUrls.push(fileName);
            delete diagramMapping[url];
          }
        })
      );

      const pct = 45 + Math.round(((i + batch.length) / plan.toDownload.length) * 45);
      onProgress?.(
        `Syncing new media (${mediaDownloadedNew}/${plan.toDownload.length}, ${plan.skippedExistingCount} skipped)…`,
        Math.min(92, pct)
      );
    }
  } else {
    onProgress?.(
      `All ${plan.skippedExistingCount} media files already up to date on PC!`,
      90
    );
  }

  // ─── Step 4: Write Updated Manifest ─────────────────────────────────────
  onProgress?.('Updating backup manifest…', 95);
  const now = new Date();
  const warnings: string[] = [...dataset.tableWarnings];
  if (failedMediaUrls.length > 0) {
    warnings.push(
      `${failedMediaUrls.length} media asset(s) could not be downloaded: ${failedMediaUrls.slice(0, 5).join(', ')}${failedMediaUrls.length > 5 ? '…' : ''}`
    );
  }

  const totalPresentMedia = plan.skippedExistingCount + mediaDownloadedNew;
  const manifest: BackupManifest = {
    version: '1.1',
    generator: 'TestMaker Incremental Folder Sync',
    timestamp: now.getTime(),
    createdAt: now.toISOString(),
    mediaIncluded: true,
    diagramMapping,
    ...(warnings.length > 0 ? { warnings } : {}),
    stats: {
      syllabusesCount: dataset.syllabuses.length,
      questionsCount: dataset.questions.length,
      customTestsCount: dataset.customTests.length,
      quizSubmissionsCount: dataset.quizSubmissions.length,
      appConfigCount: dataset.appConfig.length,
      teacherProfilesCount: dataset.teacherProfiles.length,
      proctorAuditEventsCount: dataset.proctorAuditEvents.length,
      gameProfilesCount: dataset.gameProfiles.length,
      diagramsCount: totalPresentMedia,
      mediaSkippedCount: plan.skippedExistingCount,
      failedMediaCount: failedMediaUrls.length,
    },
  };

  await writeFileToDirectory(rootHandle, 'manifest.json', JSON.stringify(manifest, null, 2));
  onProgress?.('Folder sync completed!', 100);

  return {
    folderName: rootHandle.name,
    manifest,
    mediaSkippedExisting: plan.skippedExistingCount,
    mediaDownloadedNew,
    failedMediaCount: failedMediaUrls.length,
  };
}
