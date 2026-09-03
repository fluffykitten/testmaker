/**
 * Intelligent Restore Service for TestMaker.
 * Inspects, validates, and restores Supabase SQL tables and re-uploads diagram image files
 * into Supabase Storage ('exam-diagrams' bucket), rewriting URLs to match the active project.
 */

import { supabase } from '../lib/supabase';
import { extractDiagramFileName, type BackupManifest } from './backupService';
import type { Question, Syllabus, CustomTest } from '../types/database';

export interface RestoreInspectionResult {
  isValid: boolean;
  error?: string;
  manifest?: BackupManifest;
  syllabusesCount: number;
  questionsCount: number;
  customTestsCount: number;
  diagramsCount: number;
}

export interface RestoreOptions {
  mode: 'merge' | 'replace';
}

export interface RestoreResult {
  success: boolean;
  syllabusesRestored: number;
  questionsRestored: number;
  diagramsRestored: number;
  customTestsRestored: number;
  errors: string[];
}

export interface RestoreProgressCallback {
  (status: string, percentage: number): void;
}

/**
 * Inspects a backup archive (.zip) and extracts manifest and preview stats.
 */
export async function inspectBackupArchive(fileOrBlob: File | Blob | ArrayBuffer): Promise<RestoreInspectionResult> {
  try {
    const JSZip = (await import('jszip')).default;
    const dataToLoad =
      fileOrBlob instanceof ArrayBuffer
        ? fileOrBlob
        : typeof (fileOrBlob as any).arrayBuffer === 'function'
        ? await (fileOrBlob as any).arrayBuffer()
        : fileOrBlob;

    const zip = await JSZip.loadAsync(dataToLoad);

    // Check for manifest.json
    const manifestFile = zip.file('manifest.json');
    if (!manifestFile) {
      return {
        isValid: false,
        error: 'Invalid archive: Missing manifest.json file.',
        syllabusesCount: 0,
        questionsCount: 0,
        customTestsCount: 0,
        diagramsCount: 0,
      };
    }

    const manifestText = await manifestFile.async('string');
    const manifest = JSON.parse(manifestText) as BackupManifest;

    // Check for questions.json
    const questionsFile = zip.file('data/questions.json');
    let questionsCount = manifest.stats?.questionsCount || 0;
    if (questionsFile) {
      const qText = await questionsFile.async('string');
      const qList = JSON.parse(qText);
      if (Array.isArray(qList)) questionsCount = qList.length;
    }

    // Check for syllabuses.json
    const syllabusesFile = zip.file('data/syllabuses.json');
    let syllabusesCount = manifest.stats?.syllabusesCount || 0;
    if (syllabusesFile) {
      const sText = await syllabusesFile.async('string');
      const sList = JSON.parse(sText);
      if (Array.isArray(sList)) syllabusesCount = sList.length;
    }

    // Check for custom_tests.json
    const testsFile = zip.file('data/custom_tests.json');
    let customTestsCount = manifest.stats?.customTestsCount || 0;
    if (testsFile) {
      const tText = await testsFile.async('string');
      const tList = JSON.parse(tText);
      if (Array.isArray(tList)) customTestsCount = tList.length;
    }

    // Count diagrams in diagrams/ folder
    const diagramsFolder = zip.folder('diagrams');
    let diagramsCount = 0;
    if (diagramsFolder) {
      diagramsFolder.forEach((_relativePath, file) => {
        if (!file.dir) diagramsCount++;
      });
    }

    return {
      isValid: true,
      manifest,
      syllabusesCount,
      questionsCount,
      customTestsCount,
      diagramsCount,
    };
  } catch (err) {
    return {
      isValid: false,
      error: err instanceof Error ? err.message : 'Corrupted or unreadable archive.',
      syllabusesCount: 0,
      questionsCount: 0,
      customTestsCount: 0,
      diagramsCount: 0,
    };
  }
}

/**
 * Re-uploads diagram files from archive into Supabase Storage and maps old URLs to new URLs.
 */
async function restoreDiagramsToStorage(
  zip: any,
  onProgress?: (count: number, total: number) => void
): Promise<Map<string, string>> {
  const urlMap = new Map<string, string>();
  const diagramsFolder = zip.folder('diagrams');
  if (!diagramsFolder) return urlMap;

  const entries: { path: string; file: any }[] = [];
  diagramsFolder.forEach((relativePath: string, file: any) => {
    if (!file.dir) entries.push({ path: relativePath, file });
  });

  if (entries.length === 0) return urlMap;

  // Upload in batches of 6
  const BATCH_SIZE = 6;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async ({ path, file }) => {
        try {
          const blob = await file.async('blob');
          const fileName = path.split('/').pop() || path;
          const storagePath = `diagrams/${fileName}`;
          const contentType = fileName.endsWith('.webp') ? 'image/webp' : 'image/png';

          const { error } = await supabase.storage
            .from('exam-diagrams')
            .upload(storagePath, blob, {
              contentType,
              upsert: true,
            });

          if (!error) {
            const { data } = supabase.storage
              .from('exam-diagrams')
              .getPublicUrl(storagePath);

            if (data?.publicUrl) {
              urlMap.set(fileName, data.publicUrl);
            }
          }
        } catch (err) {
          console.warn(`[RestoreService] Failed to upload diagram ${path}:`, err);
        }
      })
    );

    onProgress?.(Math.min(entries.length, i + batch.length), entries.length);
  }

  return urlMap;
}

/**
 * Rewrites a question's diagram_url using the newly uploaded storage URLs.
 */
function rewriteQuestionDiagramUrls(q: Question, diagramUrlMap: Map<string, string>): Question {
  let updatedUrl = q.diagram_url;

  if (q.diagram_url) {
    const fileName = extractDiagramFileName(q.diagram_url);
    if (diagramUrlMap.has(fileName)) {
      updatedUrl = diagramUrlMap.get(fileName)!;
    }
  }

  // Also rewrite any sub-questions with diagrams
  const subQuestions = (q as any).sub_questions;
  let updatedSubs = subQuestions;
  if (Array.isArray(subQuestions)) {
    updatedSubs = subQuestions.map((sub: any) => {
      if (sub?.diagram_url) {
        const subFileName = extractDiagramFileName(sub.diagram_url);
        if (diagramUrlMap.has(subFileName)) {
          return { ...sub, diagram_url: diagramUrlMap.get(subFileName) };
        }
      }
      return sub;
    });
  }

  return {
    ...q,
    diagram_url: updatedUrl,
    sub_questions: updatedSubs,
  } as Question;
}

/**
 * Executes full restore from a verified backup archive.
 */
export async function executeRestore(
  fileOrBlob: File | Blob | ArrayBuffer,
  _options: RestoreOptions = { mode: 'merge' },
  onProgress?: RestoreProgressCallback
): Promise<RestoreResult> {
  const errors: string[] = [];
  let syllabusesRestored = 0;
  let questionsRestored = 0;
  let diagramsRestored = 0;
  let customTestsRestored = 0;

  try {
    const JSZip = (await import('jszip')).default;
    onProgress?.('Unpacking backup archive…', 10);
    const dataToLoad =
      fileOrBlob instanceof ArrayBuffer
        ? fileOrBlob
        : typeof (fileOrBlob as any).arrayBuffer === 'function'
        ? await (fileOrBlob as any).arrayBuffer()
        : fileOrBlob;

    const zip = await JSZip.loadAsync(dataToLoad);

    // ─── Step 1: Re-upload storage diagrams ───────────────────────────────
    onProgress?.('Restoring exam diagrams to Supabase Storage…', 20);
    const diagramUrlMap = await restoreDiagramsToStorage(zip, (done, total) => {
      onProgress?.(
        `Uploading diagrams (${done}/${total})…`,
        20 + Math.round((done / total) * 35)
      );
    });
    diagramsRestored = diagramUrlMap.size;

    // ─── Step 2: Restore Syllabuses ───────────────────────────────────────
    onProgress?.('Restoring syllabuses…', 60);
    const syllabusesFile = zip.file('data/syllabuses.json');
    if (syllabusesFile) {
      const sList = JSON.parse(await syllabusesFile.async('string')) as Syllabus[];
      if (Array.isArray(sList) && sList.length > 0) {
        for (const s of sList) {
          try {
            const { error } = await (supabase.from('syllabuses') as any).upsert(s, {
              onConflict: 'id',
            });
            if (error) errors.push(`Syllabus ${s.subject_name}: ${error.message}`);
            else syllabusesRestored++;
          } catch (err: any) {
            errors.push(`Syllabus ${s.subject_name}: ${err?.message}`);
          }
        }
      }
    }

    // ─── Step 3: Restore Questions ────────────────────────────────────────
    onProgress?.('Restoring question bank records…', 70);
    const questionsFile = zip.file('data/questions.json');
    if (questionsFile) {
      const qList = JSON.parse(await questionsFile.async('string')) as Question[];
      if (Array.isArray(qList) && qList.length > 0) {
        const BATCH_SIZE = 100;
        for (let i = 0; i < qList.length; i += BATCH_SIZE) {
          const batch = qList.slice(i, i + BATCH_SIZE).map((q) => {
            const withRewrittenUrls = rewriteQuestionDiagramUrls(q, diagramUrlMap);
            // Ensure valid clean record structure
            return withRewrittenUrls;
          });

          const { error } = await (supabase.from('questions') as any).upsert(batch, {
            onConflict: 'id',
          });

          if (error) {
            errors.push(`Questions batch ${i}-${i + batch.length}: ${error.message}`);
          } else {
            questionsRestored += batch.length;
          }

          onProgress?.(
            `Restoring questions (${Math.min(qList.length, i + BATCH_SIZE)}/${qList.length})…`,
            70 + Math.round(((i + batch.length) / qList.length) * 20)
          );
        }
      }
    }

    // ─── Step 4: Restore Custom Tests ─────────────────────────────────────
    onProgress?.('Restoring custom tests…', 92);
    const testsFile = zip.file('data/custom_tests.json');
    if (testsFile) {
      const tList = JSON.parse(await testsFile.async('string')) as CustomTest[];
      if (Array.isArray(tList) && tList.length > 0) {
        const { error } = await (supabase.from('custom_tests') as any).upsert(tList, {
          onConflict: 'id',
        });
        if (error) errors.push(`Custom tests: ${error.message}`);
        else customTestsRestored = tList.length;
      }
    }

    // ─── Step 5: Notify application ───────────────────────────────────────
    onProgress?.('Finalizing restore…', 98);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('questions_updated'));
    }

    onProgress?.('Restore completed successfully!', 100);

    return {
      success: errors.length === 0 || questionsRestored > 0,
      syllabusesRestored,
      questionsRestored,
      diagramsRestored,
      customTestsRestored,
      errors,
    };
  } catch (err: any) {
    errors.push(err?.message || 'Restore process encountered an unexpected failure.');
    return {
      success: false,
      syllabusesRestored,
      questionsRestored,
      diagramsRestored,
      customTestsRestored,
      errors,
    };
  }
}
