/**
 * IndexedDB storage engine for Auto-Save Draft Recovery on the Paper Uploading page.
 * Safely persists multi-megabyte extraction results, question mark schemes, and diagram Blobs
 * to protect teachers against accidental page refreshes, tab closures, or browser crashes.
 */

import type { ExtractionResult } from '../types/database';
import type { DiagramCropItem } from './diagramCropper';

const DB_NAME = 'testmaker_offline_db';
const DB_VERSION = 1;
const STORE_NAME = 'upload_drafts';
const DRAFT_KEY = 'active_upload_draft';
const DRAFT_TTL_MS = 48 * 60 * 60 * 1000; // 48 Hours

export interface StoredDiagramItem {
  key: string;
  blob: Blob;
  pageNumber?: number;
  sourceDoc?: 'qp' | 'insert';
}

export interface RawUploadDraft {
  id: string;
  timestamp: number;
  fileName: string;
  result: ExtractionResult;
  diagrams: StoredDiagramItem[];
  qpBlob?: Blob | null;
  qpName?: string | null;
  insertBlob?: Blob | null;
  insertName?: string | null;
}

export interface ReconstitutedDraft {
  fileName: string;
  timestamp: number;
  result: ExtractionResult;
  diagramData: Map<string, DiagramCropItem>;
  previewUrls: Map<string, string>;
  qpFile: File | null;
  insertFile: File | null;
}

function getIndexedDB(): IDBFactory | null {
  if (typeof window !== 'undefined' && window.indexedDB) {
    return window.indexedDB;
  }
  return null;
}

function openDatabase(): Promise<IDBDatabase> {
  const idb = getIndexedDB();
  if (!idb) {
    return Promise.reject(new Error('IndexedDB is not supported in this browser environment.'));
  }

  return new Promise((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Failed to open IndexedDB.'));
  });
}

/**
 * Saves the current extraction draft into IndexedDB.
 */
export async function saveUploadDraft(
  fileName: string,
  result: ExtractionResult,
  diagramData: Map<string, DiagramCropItem>,
  qpFile?: File | null,
  insertFile?: File | null
): Promise<void> {
  try {
    const db = await openDatabase();

    const diagrams: StoredDiagramItem[] = [];
    for (const [key, item] of diagramData.entries()) {
      if (item && item.blob) {
        diagrams.push({
          key,
          blob: item.blob,
          pageNumber: item.pageNumber,
          sourceDoc: item.sourceDoc,
        });
      }
    }

    const draftRecord: RawUploadDraft = {
      id: DRAFT_KEY,
      timestamp: Date.now(),
      fileName: fileName || result.paper_metadata.subject || 'Exam Paper',
      result,
      diagrams,
      qpBlob: qpFile || null,
      qpName: qpFile?.name || null,
      insertBlob: insertFile || null,
      insertName: insertFile?.name || null,
    };

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.put(draftRecord);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error('Failed to save upload draft.'));
    });
  } catch (err) {
    console.warn('[DraftRecovery] Failed to auto-save extraction draft:', err);
  }
}

/**
 * Checks if a valid, unexpired upload draft exists in IndexedDB.
 */
export async function hasUploadDraft(): Promise<{ exists: boolean; fileName?: string; timestamp?: number; questionCount?: number }> {
  try {
    const db = await openDatabase();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(DRAFT_KEY);

      req.onsuccess = () => {
        const raw = req.result as RawUploadDraft | undefined;
        if (!raw || !raw.result) {
          resolve({ exists: false });
          return;
        }

        // Check expiration (48 hours)
        if (Date.now() - raw.timestamp > DRAFT_TTL_MS) {
          deleteUploadDraft().catch(() => {});
          resolve({ exists: false });
          return;
        }

        resolve({
          exists: true,
          fileName: raw.fileName,
          timestamp: raw.timestamp,
          questionCount: raw.result.questions?.length || 0,
        });
      };

      req.onerror = () => resolve({ exists: false });
    });
  } catch {
    return { exists: false };
  }
}

/**
 * Loads and reconstitutes the saved upload draft from IndexedDB,
 * converting stored Blobs back into fresh in-memory Object URLs.
 */
export async function loadUploadDraft(): Promise<ReconstitutedDraft | null> {
  try {
    const db = await openDatabase();
    const raw = await new Promise<RawUploadDraft | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(DRAFT_KEY);

      req.onsuccess = () => resolve((req.result as RawUploadDraft) || null);
      req.onerror = () => reject(req.error || new Error('Failed to load upload draft.'));
    });

    if (!raw || !raw.result) return null;

    // Check expiration (48 hours)
    if (Date.now() - raw.timestamp > DRAFT_TTL_MS) {
      await deleteUploadDraft();
      return null;
    }

    // Reconstitute DiagramCropItems with fresh local Object URLs
    const diagramData = new Map<string, DiagramCropItem>();
    const previewUrls = new Map<string, string>();

    for (const d of raw.diagrams || []) {
      if (d.blob) {
        const localUrl = URL.createObjectURL(d.blob);
        diagramData.set(d.key, {
          blob: d.blob,
          localUrl,
          pageNumber: d.pageNumber,
          sourceDoc: d.sourceDoc,
        });
        previewUrls.set(d.key, localUrl);
      }
    }

    // Reconstitute File objects if available
    const qpFile = raw.qpBlob
      ? new File([raw.qpBlob], raw.qpName || 'recovered_qp.pdf', { type: 'application/pdf' })
      : null;

    const insertFile = raw.insertBlob
      ? new File([raw.insertBlob], raw.insertName || 'recovered_insert.pdf', { type: 'application/pdf' })
      : null;

    return {
      fileName: raw.fileName,
      timestamp: raw.timestamp,
      result: raw.result,
      diagramData,
      previewUrls,
      qpFile,
      insertFile,
    };
  } catch (err) {
    console.warn('[DraftRecovery] Error restoring upload draft:', err);
    return null;
  }
}

/**
 * Purges the saved upload draft from IndexedDB.
 */
export async function deleteUploadDraft(): Promise<void> {
  try {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(DRAFT_KEY);

      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error || new Error('Failed to delete upload draft.'));
    });
  } catch (err) {
    console.warn('[DraftRecovery] Failed to delete upload draft:', err);
  }
}
