/**
 * Full-Fidelity Backup Service for TestMaker.
 * Backs up all Supabase SQL tables (syllabuses, questions, custom tests, app config, submissions)
 * and downloads binary diagram images from the exam-diagrams storage bucket into a compressed ZIP archive.
 */

import { supabase } from '../lib/supabase';
import type { Question, Syllabus, CustomTest } from '../types/database';

export interface BackupProgressCallback {
  (status: string, percentage: number): void;
}

export interface BackupManifest {
  version: string;
  generator: string;
  timestamp: number;
  createdAt: string;
  supabaseProjectRef?: string;
  diagramMapping?: Record<string, string>; // Maps original image URL -> zip archive filename
  stats: {
    syllabusesCount: number;
    questionsCount: number;
    customTestsCount: number;
    quizSubmissionsCount: number;
    appConfigCount?: number;
    diagramsCount: number;
  };
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
async function fetchAllTableRows<T = any>(
  tableName: string,
  onBatch?: (fetched: number) => void
): Promise<T[]> {
  let allRows: T[] = [];
  let from = 0;
  const batchSize = 1000;

  while (true) {
    const { data, error } = await (supabase.from(tableName as any) as any)
      .select('*')
      .range(from, from + batchSize - 1);

    if (error) {
      console.warn(`[BackupService] Warning fetching ${tableName}:`, error.message);
      break;
    }

    if (!data || data.length === 0) break;
    allRows = allRows.concat(data);
    onBatch?.(allRows.length);

    if (data.length < batchSize) break;
    from += batchSize;
  }

  return allRows;
}

/**
 * Collects all unique diagram URLs referenced in questions and sub-questions.
 */
function collectDiagramUrls(questions: Question[]): Set<string> {
  const urls = new Set<string>();

  for (const q of questions) {
    if (q.diagram_url && typeof q.diagram_url === 'string' && q.diagram_url.startsWith('http')) {
      urls.add(q.diagram_url);
    }
    // Check sub_questions if present
    const subQuestions = (q as any).sub_questions;
    if (Array.isArray(subQuestions)) {
      for (const sub of subQuestions) {
        if (sub?.diagram_url && typeof sub.diagram_url === 'string' && sub.diagram_url.startsWith('http')) {
          urls.add(sub.diagram_url);
        }
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
 * Generates a complete snapshot archive (.zip) containing:
 * - manifest.json (metadata, counts, timestamps)
 * - data/syllabuses.json
 * - data/questions.json
 * - data/custom_tests.json
 * - data/app_config.json
 * - data/quiz_submissions.json
 * - diagrams/* (all binary diagram image files)
 */
export async function createFullBackupArchive(
  onProgress?: BackupProgressCallback
): Promise<BackupArchiveResult> {
  // Dynamically import JSZip so it never adds weight to initial page load
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();

  // ─── Step 1: Export SQL Tables ──────────────────────────────────────────
  onProgress?.('Fetching syllabuses and configurations…', 5);
  const syllabuses = await fetchAllTableRows<Syllabus>('syllabuses');

  onProgress?.('Fetching custom tests…', 10);
  const customTests = await fetchAllTableRows<CustomTest>('custom_tests');

  onProgress?.('Fetching app configurations…', 15);
  const appConfig = await fetchAllTableRows('app_config');

  onProgress?.('Fetching quiz submissions…', 20);
  const quizSubmissions = await fetchAllTableRows('quiz_submissions');

  onProgress?.('Fetching question bank records…', 25);
  const questions = await fetchAllTableRows<Question>('questions', (count) => {
    onProgress?.(`Fetching question bank records (${count} retrieved)…`, 30);
  });

  // ─── Step 2: Pack Database JSON ─────────────────────────────────────────
  const dataFolder = zip.folder('data')!;
  dataFolder.file('syllabuses.json', JSON.stringify(syllabuses, null, 2));
  dataFolder.file('questions.json', JSON.stringify(questions, null, 2));
  dataFolder.file('custom_tests.json', JSON.stringify(customTests, null, 2));
  dataFolder.file('app_config.json', JSON.stringify(appConfig, null, 2));
  dataFolder.file('quiz_submissions.json', JSON.stringify(quizSubmissions, null, 2));

  // ─── Step 3: Fetch & Pack Storage Diagram Blobs ─────────────────────────
  const diagramUrls = Array.from(collectDiagramUrls(questions));
  const diagramsFolder = zip.folder('diagrams')!;
  const diagramMapping: Record<string, string> = {};
  const usedFileNames = new Set<string>();
  let diagramsPacked = 0;

  function getUniqueArchiveFileName(url: string): string {
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

  // Pre-assign collision-free filenames for all unique diagram URLs
  for (const url of diagramUrls) {
    diagramMapping[url] = getUniqueArchiveFileName(url);
  }

  if (diagramUrls.length > 0) {
    onProgress?.(`Backing up ${diagramUrls.length} exam diagrams from storage…`, 40);

    // Fetch images in concurrent batches of 8 to balance speed and network stability
    const BATCH_SIZE = 8;
    for (let i = 0; i < diagramUrls.length; i += BATCH_SIZE) {
      const batch = diagramUrls.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (url) => {
          try {
            const fileName = diagramMapping[url];
            const res = await fetch(url);
            if (res.ok) {
              const arrayBuffer = await res.arrayBuffer();
              diagramsFolder.file(fileName, arrayBuffer);
              diagramsPacked++;
            }
          } catch (err) {
            console.warn(`[BackupService] Failed to download diagram ${url}:`, err);
          }
        })
      );

      const pct = 40 + Math.round(((i + batch.length) / diagramUrls.length) * 45);
      onProgress?.(
        `Archiving diagrams (${diagramsPacked}/${diagramUrls.length})…`,
        Math.min(85, pct)
      );
    }
  }

  // ─── Step 4: Write Manifest ─────────────────────────────────────────────
  const now = new Date();
  const manifest: BackupManifest = {
    version: '1.0',
    generator: 'TestMaker Cloud Backup Engine',
    timestamp: now.getTime(),
    createdAt: now.toISOString(),
    diagramMapping,
    stats: {
      syllabusesCount: syllabuses.length,
      questionsCount: questions.length,
      customTestsCount: customTests.length,
      quizSubmissionsCount: quizSubmissions.length,
      appConfigCount: appConfig.length,
      diagramsCount: diagramsPacked,
    },
  };

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  // ─── Step 5: Compress ZIP Archive ───────────────────────────────────────
  onProgress?.('Compressing backup archive…', 90);
  const blob = await zip.generateAsync(
    {
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    },
    (metadata) => {
      onProgress?.(`Compressing: ${Math.round(metadata.percent)}%`, 90 + Math.round(metadata.percent * 0.09));
    }
  );

  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');
  const fileName = `testmaker-backup-${dateStr}-${timeStr}.zip`;

  onProgress?.('Backup archive ready!', 100);

  return {
    blob,
    fileName,
    manifest,
  };
}
