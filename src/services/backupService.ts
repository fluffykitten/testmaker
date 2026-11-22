/**
 * Full-Fidelity Backup Service for TestMaker.
 * Backs up all Supabase SQL tables (syllabuses, questions, custom tests, app config, submissions)
 * and downloads binary diagram images from the exam-diagrams storage bucket into a compressed ZIP archive.
 */

import { supabase } from '../lib/supabase';
import type { Question, Syllabus, CustomTest } from '../types/database';
import {
  resolveOptionDiagramUrls,
  resolveQuestionImageUrlsExcludingStandaloneSvg,
} from '../utils/questionDiagramUtils';

export interface BackupProgressCallback {
  (status: string, percentage: number): void;
}

export interface BackupManifest {
  version: string;
  generator: string;
  timestamp: number;
  createdAt: string;
  supabaseProjectRef?: string;
  mediaIncluded?: boolean;
  diagramMapping?: Record<string, string>; // Maps original image URL -> archive filename
  warnings?: string[];
  stats: {
    syllabusesCount: number;
    questionsCount: number;
    customTestsCount: number;
    quizSubmissionsCount: number;
    appConfigCount?: number;
    teacherProfilesCount?: number;
    proctorAuditEventsCount?: number;
    gameProfilesCount?: number;
    diagramsCount: number;
    mediaSkippedCount?: number;
    failedMediaCount?: number;
  };
}

export interface BackupDataset {
  syllabuses: Syllabus[];
  customTests: CustomTest[];
  appConfig: any[];
  quizSubmissions: any[];
  teacherProfiles: any[];
  proctorAuditEvents: any[];
  gameProfiles: any[];
  questions: Question[];
  tableWarnings: string[];
}

export interface BackupArchiveOptions {
  includeMedia?: boolean;
}

export interface IncrementalMediaPlan {
  diagramMapping: Record<string, string>;
  toDownload: Array<{ url: string; fileName: string }>;
  skippedExistingCount: number;
}

export interface BackupArchiveResult {
  blob: Blob;
  fileName: string;
  manifest: BackupManifest;
}

/**
 * Extracts the storage file path or clean filename from a Supabase Storage public URL.
 * e.g. "https://xxx.supabase.co/storage/v1/object/public/exam-diagrams/diagrams/0620_2021_p41_q1.webp" -> "0620_2021_p41_q1.webp"
 */
export function extractDiagramFileName(url: string): string {
  try {
    const cleanUrl = url.split('?')[0];
    const segments = cleanUrl.split('/');
    const last = segments[segments.length - 1];
    return last || `diagram_${Date.now()}`;
  } catch {
    return `diagram_${Date.now()}`;
  }
}

/**
 * Fetches all records from a Supabase table with pagination to bypass the default 1,000 row cap.
 */
export async function fetchWithTimeout(url: string, timeoutMs = 15000): Promise<Response> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    return await fetch(url, controller ? { signal: controller.signal } : undefined);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isSkippableOptionalTableError(error: { code?: string; message?: string }): boolean {
  const code = String(error.code || '').toUpperCase();
  const msg = String(error.message || '');
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    code === '42501' ||
    /does not exist|schema cache|could not find the table|permission denied/i.test(msg)
  );
}

async function fetchAllTableRows<T = any>(
  tableName: string,
  onBatch?: (fetched: number) => void,
  options?: { optional?: boolean; warnings?: string[] }
): Promise<T[]> {
  let allRows: T[] = [];
  let from = 0;
  const batchSize = 1000;

  while (true) {
    const { data, error } = await (supabase.from(tableName as any) as any)
      .select('*')
      .range(from, from + batchSize - 1);

    if (error) {
      if (options?.optional && isSkippableOptionalTableError(error)) {
        console.warn(`[BackupService] Optional table ${tableName} skipped:`, error.message);
        options.warnings?.push(`Optional table "${tableName}" skipped (${error.message}).`);
        return [];
      }
      throw new Error(`Failed to read "${tableName}" from database: ${error.message}`);
    }

    if (!data || data.length === 0) break;
    allRows = allRows.concat(data);
    onBatch?.(allRows.length);

    if (data.length < batchSize) break;
    from += batchSize;
  }

  return allRows;
}

function addHttpUrl(urls: Set<string>, candidate: unknown): void {
  if (typeof candidate === 'string') {
    const trimmed = candidate.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      urls.add(trimmed);
    }
  }
}

function collectQuestionMediaUrls(q: any, urls: Set<string>): void {
  if (!q || typeof q !== 'object') return;
  for (const url of resolveQuestionImageUrlsExcludingStandaloneSvg(q)) {
    addHttpUrl(urls, url);
  }
  for (const optUrl of resolveOptionDiagramUrls(q)) {
    addHttpUrl(urls, optUrl);
  }
  addHttpUrl(urls, q.audio_url);
  addHttpUrl(urls, q.source_pdf_url);
  addHttpUrl(urls, q.insert_pdf_url);

  const ms = q.mark_scheme;
  if (ms && typeof ms === 'object') {
    addHttpUrl(urls, ms._source_pdf_url);
    addHttpUrl(urls, ms._insert_pdf_url);
    if (Array.isArray(ms._insert_resources)) {
      for (const res of ms._insert_resources) {
        addHttpUrl(urls, res?.url);
      }
    }
  }

  if (Array.isArray(q.insert_resources)) {
    for (const res of q.insert_resources) {
      addHttpUrl(urls, res?.url);
    }
  }

  if (Array.isArray(q.sub_questions)) {
    for (const sub of q.sub_questions) {
      for (const subUrl of resolveQuestionImageUrlsExcludingStandaloneSvg(sub)) {
        addHttpUrl(urls, subUrl);
      }
      for (const subOptUrl of resolveOptionDiagramUrls(sub)) {
        addHttpUrl(urls, subOptUrl);
      }
      addHttpUrl(urls, sub?.audio_url);
    }
  }
}

/**
 * Collects all unique diagram, audio, PDF, and insert-resource URLs referenced
 * across questions and cached published_quizzes snapshots.
 */
export function collectMediaUrls(
  questions: Question[],
  appConfigRows?: Array<{ key?: string; value?: string }>
): Set<string> {
  const urls = new Set<string>();

  for (const q of questions) {
    collectQuestionMediaUrls(q, urls);
  }

  if (Array.isArray(appConfigRows)) {
    const pubRow = appConfigRows.find((r) => r?.key === 'published_quizzes');
    if (pubRow?.value) {
      try {
        const parsedQuizzes = JSON.parse(pubRow.value);
        if (Array.isArray(parsedQuizzes)) {
          for (const quiz of parsedQuizzes) {
            if (Array.isArray(quiz?.questions)) {
              for (const qq of quiz.questions) {
                collectQuestionMediaUrls(qq, urls);
              }
            }
          }
        }
      } catch {
        // Ignore malformed published_quizzes cache during URL scan
      }
    }
  }

  return urls;
}

/**
 * Provides a fast lightweight estimate of database rows and assets before running full backup.
 */
export async function getBackupEstimate(): Promise<{
  questionsCount: number;
  syllabusesCount: number;
  customTestsCount: number;
}> {
  try {
    const [qRes, sRes, tRes] = await Promise.all([
      supabase.from('questions').select('id', { count: 'exact', head: true }),
      supabase.from('syllabuses').select('id', { count: 'exact', head: true }),
      supabase.from('custom_tests').select('id', { count: 'exact', head: true }),
    ]);

    return {
      questionsCount: qRes.count || 0,
      syllabusesCount: sRes.count || 0,
      customTestsCount: tRes.count || 0,
    };
  } catch (err) {
    console.warn('[BackupService] Failed to get backup estimate:', err);
    return { questionsCount: 0, syllabusesCount: 0, customTestsCount: 0 };
  }
}

/**
 * Fetches all SQL tables needed for both ZIP snapshots and incremental PC folder syncs.
 */
export async function fetchBackupDataset(
  onProgress?: BackupProgressCallback
): Promise<BackupDataset> {
  onProgress?.('Fetching syllabuses and configurations…', 5);
  const syllabuses = await fetchAllTableRows<Syllabus>('syllabuses');

  onProgress?.('Fetching custom tests…', 10);
  const customTests = await fetchAllTableRows<CustomTest>('custom_tests');

  onProgress?.('Fetching app configurations…', 14);
  const appConfig = await fetchAllTableRows('app_config');

  onProgress?.('Fetching quiz submissions…', 18);
  const quizSubmissions = await fetchAllTableRows('quiz_submissions');

  const tableWarnings: string[] = [];
  onProgress?.('Fetching educator profiles, proctor logs & arena profiles…', 22);
  const teacherProfiles = await fetchAllTableRows('teacher_profiles', undefined, {
    optional: true,
    warnings: tableWarnings,
  });
  const proctorAuditEvents = await fetchAllTableRows('proctor_audit_events', undefined, {
    optional: true,
    warnings: tableWarnings,
  });
  const gameProfiles = await fetchAllTableRows('game_profiles', undefined, {
    optional: true,
    warnings: tableWarnings,
  });

  onProgress?.('Fetching question bank records…', 26);
  const questions = await fetchAllTableRows<Question>('questions', (count) => {
    onProgress?.(`Fetching question bank records (${count} retrieved)…`, 30);
  });

  return {
    syllabuses,
    customTests,
    appConfig,
    quizSubmissions,
    teacherProfiles,
    proctorAuditEvents,
    gameProfiles,
    questions,
    tableWarnings,
  };
}

/**
 * Plans collision-free filenames for all media URLs and diffs against files already stored
 * locally so existing diagrams, audio, and PDFs do not need to be re-downloaded.
 */
export function planIncrementalMediaNames(
  mediaUrls: string[],
  existingMapping?: Record<string, string>,
  existingFilesOnDisk?: Set<string>
): IncrementalMediaPlan {
  const diagramMapping: Record<string, string> = {};
  const usedFileNames = new Set<string>();
  const toDownload: Array<{ url: string; fileName: string }> = [];
  let skippedExistingCount = 0;

  // Preserve mappings whose files already exist on disk so filenames never churn.
  if (existingMapping && existingFilesOnDisk && existingFilesOnDisk.size > 0) {
    const urlSet = new Set(mediaUrls);
    for (const url of mediaUrls) {
      const mapped = existingMapping[url];
      if (mapped && existingFilesOnDisk.has(mapped) && !usedFileNames.has(mapped) && urlSet.has(url)) {
        diagramMapping[url] = mapped;
        usedFileNames.add(mapped);
        skippedExistingCount++;
      }
    }
  }

  function allocateUniqueFileName(url: string): string {
    const raw = extractDiagramFileName(url);
    if (!usedFileNames.has(raw)) {
      usedFileNames.add(raw);
      return raw;
    }
    const lastDot = raw.lastIndexOf('.');
    const base = lastDot > 0 ? raw.slice(0, lastDot) : raw;
    const ext = lastDot > 0 ? raw.slice(lastDot) : '';
    let counter = 2;
    while (usedFileNames.has(`${base}_${counter}${ext}`)) {
      counter++;
    }
    const unique = `${base}_${counter}${ext}`;
    usedFileNames.add(unique);
    return unique;
  }

  for (const url of mediaUrls) {
    if (diagramMapping[url]) continue;
    const fileName = allocateUniqueFileName(url);
    diagramMapping[url] = fileName;
    toDownload.push({ url, fileName });
  }

  return { diagramMapping, toDownload, skippedExistingCount };
}

function isAlreadyCompressedMediaFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return (
    lower.endsWith('.webp') ||
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.gif') ||
    lower.endsWith('.mp3') ||
    lower.endsWith('.webm') ||
    lower.endsWith('.ogg') ||
    lower.endsWith('.m4a') ||
    lower.endsWith('.pdf')
  );
}

/**
 * Generates a snapshot archive (.zip) containing SQL tables and, unless disabled,
 * all binary diagram, audio, and PDF files from storage.
 */
export async function createFullBackupArchive(
  onProgress?: BackupProgressCallback,
  options?: BackupArchiveOptions
): Promise<BackupArchiveResult> {
  const includeMedia = options?.includeMedia !== false;
  // Dynamically import JSZip so it never adds weight to initial page load
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  // ─── Step 1: Export SQL Tables ──────────────────────────────────────────
  const dataset = await fetchBackupDataset(onProgress);

  // ─── Step 2: Pack Database JSON ─────────────────────────────────────────
  const dataFolder = zip.folder('data')!;
  dataFolder.file('syllabuses.json', JSON.stringify(dataset.syllabuses, null, 2));
  dataFolder.file('questions.json', JSON.stringify(dataset.questions, null, 2));
  dataFolder.file('custom_tests.json', JSON.stringify(dataset.customTests, null, 2));
  dataFolder.file('app_config.json', JSON.stringify(dataset.appConfig, null, 2));
  dataFolder.file('quiz_submissions.json', JSON.stringify(dataset.quizSubmissions, null, 2));
  dataFolder.file('teacher_profiles.json', JSON.stringify(dataset.teacherProfiles, null, 2));
  dataFolder.file('proctor_audit_events.json', JSON.stringify(dataset.proctorAuditEvents, null, 2));
  dataFolder.file('game_profiles.json', JSON.stringify(dataset.gameProfiles, null, 2));

  // ─── Step 3: Fetch & Pack Storage Diagram, Audio & PDF Blobs ────────────
  const mediaUrls = includeMedia ? Array.from(collectMediaUrls(dataset.questions, dataset.appConfig)) : [];
  const diagramsFolder = zip.folder('diagrams')!;
  const mediaPlan = planIncrementalMediaNames(mediaUrls);
  const diagramMapping = mediaPlan.diagramMapping;
  const failedMediaUrls: string[] = [];
  let diagramsPacked = 0;

  if (includeMedia && mediaPlan.toDownload.length > 0) {
    onProgress?.(
      `Backing up ${mediaPlan.toDownload.length} exam diagrams, audio, and PDFs from storage…`,
      40
    );

    const BATCH_SIZE = 8;
    for (let i = 0; i < mediaPlan.toDownload.length; i += BATCH_SIZE) {
      const batch = mediaPlan.toDownload.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async ({ url, fileName }) => {
          try {
            const res = await fetchWithTimeout(url, 15000);
            if (res.ok) {
              const arrayBuffer = await res.arrayBuffer();
              diagramsFolder.file(fileName, arrayBuffer, {
                compression: isAlreadyCompressedMediaFile(fileName) ? 'STORE' : 'DEFLATE',
              });
              diagramsPacked++;
            } else {
              failedMediaUrls.push(`${fileName} (HTTP ${res.status})`);
              delete diagramMapping[url];
            }
          } catch (err) {
            console.warn(`[BackupService] Failed to download media asset ${url}:`, err);
            failedMediaUrls.push(fileName);
            delete diagramMapping[url];
          }
        })
      );

      const pct = 40 + Math.round(((i + batch.length) / mediaPlan.toDownload.length) * 45);
      onProgress?.(
        `Archiving media assets (${diagramsPacked}/${mediaPlan.toDownload.length})…`,
        Math.min(85, pct)
      );
    }
  }

  // ─── Step 4: Write Manifest ─────────────────────────────────────────────
  const now = new Date();
  const warnings: string[] = [...dataset.tableWarnings];
  if (failedMediaUrls.length > 0) {
    warnings.push(
      `${failedMediaUrls.length} media asset(s) could not be downloaded: ${failedMediaUrls.slice(0, 5).join(', ')}${failedMediaUrls.length > 5 ? '…' : ''}`
    );
  }

  const manifest: BackupManifest = {
    version: '1.1',
    generator: 'TestMaker Cloud Backup Engine',
    timestamp: now.getTime(),
    createdAt: now.toISOString(),
    mediaIncluded: includeMedia,
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
      diagramsCount: diagramsPacked,
      failedMediaCount: failedMediaUrls.length,
    },
  };

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  // ─── Step 5: Compress ZIP Archive ───────────────────────────────────────
  onProgress?.('Compressing backup archive…', 90);
  const blob = await zip.generateAsync(
    {
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 3 },
    },
    (metadata) => {
      onProgress?.(`Compressing: ${Math.round(metadata.percent)}%`, 90 + Math.round(metadata.percent * 0.09));
    }
  );

  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');
  const prefix = includeMedia ? 'testmaker-backup' : 'testmaker-db-snapshot';
  const fileName = `${prefix}-${dateStr}-${timeStr}.zip`;

  onProgress?.(includeMedia ? 'Backup archive ready!' : 'Quick database snapshot ready!', 100);

  return {
    blob,
    fileName,
    manifest,
  };
}
