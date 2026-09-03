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
  quizSubmissionsCount: number;
  appConfigCount: number;
  diagramsCount: number;
}

export interface RestoreOptions {
  mode: 'merge' | 'replace';
}

export interface RestoreResult {
  success: boolean;
  hasPartialSuccess?: boolean;
  syllabusesRestored: number;
  questionsRestored: number;
  diagramsRestored: number;
  customTestsRestored: number;
  quizSubmissionsRestored: number;
  appConfigRestored: number;
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
        quizSubmissionsCount: 0,
        appConfigCount: 0,
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

    // Check for quiz_submissions.json
    const submissionsFile = zip.file('data/quiz_submissions.json');
    let quizSubmissionsCount = manifest.stats?.quizSubmissionsCount || 0;
    if (submissionsFile) {
      const subText = await submissionsFile.async('string');
      const subList = JSON.parse(subText);
      if (Array.isArray(subList)) quizSubmissionsCount = subList.length;
    }

    // Check for app_config.json
    const appConfigFile = zip.file('data/app_config.json');
    let appConfigCount = manifest.stats?.appConfigCount || 0;
    if (appConfigFile) {
      const cfgText = await appConfigFile.async('string');
      const cfgList = JSON.parse(cfgText);
      if (Array.isArray(cfgList)) appConfigCount = cfgList.length;
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
      quizSubmissionsCount,
      appConfigCount,
      diagramsCount,
    };
  } catch (err) {
    return {
      isValid: false,
      error: err instanceof Error ? err.message : 'Corrupted or unreadable archive.',
      syllabusesCount: 0,
      questionsCount: 0,
      customTestsCount: 0,
      quizSubmissionsCount: 0,
      appConfigCount: 0,
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
 * Rewrites a question's diagram_url using the newly uploaded storage URLs,
 * checking manifest.diagramMapping first for collision-safe lookup.
 */
function rewriteQuestionDiagramUrls(
  q: Question,
  diagramUrlMap: Map<string, string>,
  diagramMapping?: Record<string, string>
): Question {
  function getNewDiagramUrl(origUrl: string): string {
    // 1. Try manifest mapping
    if (diagramMapping && diagramMapping[origUrl]) {
      const mappedFileName = diagramMapping[origUrl];
      if (diagramUrlMap.has(mappedFileName)) {
        return diagramUrlMap.get(mappedFileName)!;
      }
    }
    // 2. Fallback to filename extraction
    const fileName = extractDiagramFileName(origUrl);
    if (diagramUrlMap.has(fileName)) {
      return diagramUrlMap.get(fileName)!;
    }
    return origUrl;
  }

  let updatedUrl = q.diagram_url;
  if (q.diagram_url) {
    updatedUrl = getNewDiagramUrl(q.diagram_url);
  }

  // Also rewrite any sub-questions with diagrams
  const subQuestions = (q as any).sub_questions;
  let updatedSubs = subQuestions;
  if (Array.isArray(subQuestions)) {
    updatedSubs = subQuestions.map((sub: any) => {
      if (sub?.diagram_url) {
        return { ...sub, diagram_url: getNewDiagramUrl(sub.diagram_url) };
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
  options: RestoreOptions = { mode: 'merge' },
  onProgress?: RestoreProgressCallback
): Promise<RestoreResult> {
  const errors: string[] = [];
  let syllabusesRestored = 0;
  let questionsRestored = 0;
  let diagramsRestored = 0;
  let customTestsRestored = 0;
  let quizSubmissionsRestored = 0;
  let appConfigRestored = 0;

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

    // Read manifest for collision-free diagram mapping if available
    let diagramMapping: Record<string, string> | undefined;
    const manifestFile = zip.file('manifest.json');
    if (manifestFile) {
      try {
        const manifest = JSON.parse(await manifestFile.async('string')) as BackupManifest;
        diagramMapping = manifest.diagramMapping;
      } catch {
        // Continue with standard filename extraction if manifest parse fails
      }
    }

    // ─── Optional: If Replace mode, clear existing questions & tests ───────
    if (options.mode === 'replace') {
      onProgress?.('Clearing existing records for clean replace…', 15);
      try {
        // Delete dependent custom_tests first, then questions
        await (supabase.from('custom_tests') as any).delete().neq('id', '00000000-0000-0000-0000-000000000000');
        await (supabase.from('questions') as any).delete().neq('id', '00000000-0000-0000-0000-000000000000');
      } catch (err: any) {
        errors.push(`Replace mode clean error: ${err?.message || 'Could not clear existing records'}`);
      }
    }

    // ─── Step 1: Re-upload storage diagrams ───────────────────────────────
    onProgress?.('Restoring exam diagrams to Supabase Storage…', 20);
    const diagramUrlMap = await restoreDiagramsToStorage(zip, (done, total) => {
      onProgress?.(
        `Uploading diagrams (${done}/${total})…`,
        20 + Math.round((done / total) * 35)
      );
    });
    diagramsRestored = diagramUrlMap.size;

    // ─── Step 2: Restore Syllabuses (Batched) ─────────────────────────────
    onProgress?.('Restoring syllabuses…', 60);
    const syllabusesFile = zip.file('data/syllabuses.json');
    if (syllabusesFile) {
      const sList = JSON.parse(await syllabusesFile.async('string')) as Syllabus[];
      if (Array.isArray(sList) && sList.length > 0) {
        const { error } = await (supabase.from('syllabuses') as any).upsert(sList, {
          onConflict: 'id',
        });
        if (error) {
          errors.push(`Syllabuses: ${error.message}`);
        } else {
          syllabusesRestored = sList.length;
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
            return rewriteQuestionDiagramUrls(q, diagramUrlMap, diagramMapping);
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
            70 + Math.round(((i + batch.length) / qList.length) * 15)
          );
        }
      }
    }

    // ─── Step 4: Restore Custom Tests ─────────────────────────────────────
    onProgress?.('Restoring custom tests…', 86);
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

    // ─── Step 5: Restore Quiz Submissions ─────────────────────────────────
    onProgress?.('Restoring quiz submissions…', 90);
    const submissionsFile = zip.file('data/quiz_submissions.json');
    if (submissionsFile) {
      try {
        const subList = JSON.parse(await submissionsFile.async('string'));
        if (Array.isArray(subList) && subList.length > 0) {
          const BATCH_SIZE = 100;
          for (let i = 0; i < subList.length; i += BATCH_SIZE) {
            const batch = subList.slice(i, i + BATCH_SIZE);
            const { error } = await (supabase.from('quiz_submissions') as any).upsert(batch, {
              onConflict: 'id',
            });
            if (error) {
              errors.push(`Quiz submissions batch ${i}: ${error.message}`);
            } else {
              quizSubmissionsRestored += batch.length;
            }
          }
        }
      } catch (err: any) {
        errors.push(`Quiz submissions: ${err?.message || 'Parse error'}`);
      }
    }

    // ─── Step 6: Restore App Config (onConflict: 'key') ────────────────────
    onProgress?.('Restoring application configurations…', 94);
    const appConfigFile = zip.file('data/app_config.json');
    if (appConfigFile) {
      try {
        const cfgList = JSON.parse(await appConfigFile.async('string'));
        if (Array.isArray(cfgList) && cfgList.length > 0) {
          const { error } = await (supabase.from('app_config') as any).upsert(cfgList, {
            onConflict: 'key',
          });
          if (error) {
            errors.push(`App config: ${error.message}`);
          } else {
            appConfigRestored = cfgList.length;
          }
        }
      } catch (err: any) {
        errors.push(`App config: ${err?.message || 'Parse error'}`);
      }
    }

    // ─── Step 7: Notify application ───────────────────────────────────────
    onProgress?.('Finalizing restore…', 98);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event('questions_updated'));
      window.dispatchEvent(new Event('tests_updated'));
    }

    onProgress?.(errors.length === 0 ? 'Restore completed successfully!' : 'Restore completed with notes.', 100);

    const success = errors.length === 0;
    const hasPartialSuccess =
      errors.length > 0 &&
      (questionsRestored > 0 ||
        syllabusesRestored > 0 ||
        customTestsRestored > 0 ||
        quizSubmissionsRestored > 0 ||
        appConfigRestored > 0);

    return {
      success,
      hasPartialSuccess,
      syllabusesRestored,
      questionsRestored,
      diagramsRestored,
      customTestsRestored,
      quizSubmissionsRestored,
      appConfigRestored,
      errors,
    };
  } catch (err: any) {
    errors.push(err?.message || 'Restore process encountered an unexpected failure.');
    return {
      success: false,
      hasPartialSuccess: false,
      syllabusesRestored,
      questionsRestored,
      diagramsRestored,
      customTestsRestored,
      quizSubmissionsRestored,
      appConfigRestored,
      errors,
    };
  }
}
