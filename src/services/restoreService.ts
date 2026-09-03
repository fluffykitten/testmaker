/**
 * Intelligent Restore Service for TestMaker.
 * Inspects, validates, and restores Supabase SQL tables and re-uploads diagram image files
 * into Supabase Storage ('exam-diagrams' bucket), rewriting URLs to match the active project.
 */

import { supabase } from '../lib/supabase';
import { extractDiagramFileName, type BackupManifest } from './backupService';
import { getSavedSettings, saveSettings } from '../lib/settings';
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

function getStorageMimeType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webm')) return 'audio/webm';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  return 'application/octet-stream';
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
 * Re-uploads diagram and audio files from archive into Supabase Storage and maps old URLs to new URLs.
 * Returns both the urlMap and any captured storage errors for maximum diagnostic visibility.
 */
async function restoreDiagramsToStorage(
  zip: any,
  onProgress?: (count: number, total: number) => void
): Promise<{ urlMap: Map<string, string>; storageErrors: string[] }> {
  const urlMap = new Map<string, string>();
  const storageErrors: string[] = [];
  const diagramsFolder = zip.folder('diagrams');
  if (!diagramsFolder) return { urlMap, storageErrors };

  const entries: { path: string; file: any }[] = [];
  diagramsFolder.forEach((relativePath: string, file: any) => {
    if (!file.dir) entries.push({ path: relativePath, file });
  });

  if (entries.length === 0) return { urlMap, storageErrors };

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
          const contentType = getStorageMimeType(fileName);

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
          } else {
            const hint =
              error.message.includes('not found') || error.message.includes('Bucket')
                ? " (Please ensure the 'exam-diagrams' public bucket exists in Supabase Storage)"
                : '';
            storageErrors.push(`Storage upload failed for ${fileName}: ${error.message}${hint}`);
          }
        } catch (err: any) {
          storageErrors.push(`Failed to upload media ${path}: ${err?.message || 'Storage error'}`);
        }
      })
    );

    onProgress?.(Math.min(entries.length, i + batch.length), entries.length);
  }

  return { urlMap, storageErrors };
}

/**
 * Rewrites a question's diagram_url and audio_url using newly uploaded storage URLs,
 * checking manifest.diagramMapping first for collision-safe lookup.
 */
function rewriteQuestionMediaUrls(
  q: Question,
  mediaUrlMap: Map<string, string>,
  diagramMapping?: Record<string, string>
): Question {
  function getNewMediaUrl(origUrl: string | null | undefined): string | null {
    if (!origUrl || typeof origUrl !== 'string' || !origUrl.startsWith('http')) {
      return origUrl || null;
    }
    // 1. Try manifest mapping
    if (diagramMapping && diagramMapping[origUrl]) {
      const mappedFileName = diagramMapping[origUrl];
      if (mediaUrlMap.has(mappedFileName)) {
        return mediaUrlMap.get(mappedFileName)!;
      }
    }
    // 2. Fallback to filename extraction
    const fileName = extractDiagramFileName(origUrl);
    if (mediaUrlMap.has(fileName)) {
      return mediaUrlMap.get(fileName)!;
    }
    return origUrl;
  }

  const updatedDiagramUrl = getNewMediaUrl(q.diagram_url);
  const updatedAudioUrl = getNewMediaUrl(q.audio_url);

  // Also rewrite any sub-questions with diagrams or audio
  const subQuestions = (q as any).sub_questions;
  let updatedSubs = subQuestions;
  if (Array.isArray(subQuestions)) {
    updatedSubs = subQuestions.map((sub: any) => {
      let subDiagram = sub?.diagram_url;
      let subAudio = sub?.audio_url;
      if (subDiagram) subDiagram = getNewMediaUrl(subDiagram);
      if (subAudio) subAudio = getNewMediaUrl(subAudio);
      return {
        ...sub,
        diagram_url: subDiagram,
        audio_url: subAudio,
      };
    });
  }

  return {
    ...q,
    diagram_url: updatedDiagramUrl,
    audio_url: updatedAudioUrl,
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
      const { error: testDelErr } = await (supabase.from('custom_tests') as any)
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');
      if (testDelErr) errors.push(`Replace mode error (custom_tests): ${testDelErr.message}`);

      const { error: qDelErr } = await (supabase.from('questions') as any)
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');
      if (qDelErr) errors.push(`Replace mode error (questions): ${qDelErr.message}`);
    }

    // ─── Step 1: Re-upload storage diagrams & audio ───────────────────────
    onProgress?.('Restoring exam diagrams and audio to Supabase Storage…', 20);
    const { urlMap: mediaUrlMap, storageErrors } = await restoreDiagramsToStorage(zip, (done, total) => {
      onProgress?.(
        `Uploading media (${done}/${total})…`,
        20 + Math.round((done / total) * 35)
      );
    });
    diagramsRestored = mediaUrlMap.size;
    if (storageErrors.length > 0) {
      errors.push(...storageErrors);
    }

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

    // ─── Step 3: Restore Questions with Schema Drift Fallback ──────────────
    onProgress?.('Restoring question bank records…', 70);
    const questionsFile = zip.file('data/questions.json');
    if (questionsFile) {
      const qList = JSON.parse(await questionsFile.async('string')) as Question[];
      if (Array.isArray(qList) && qList.length > 0) {
        const BATCH_SIZE = 100;
        for (let i = 0; i < qList.length; i += BATCH_SIZE) {
          const batch = qList.slice(i, i + BATCH_SIZE).map((q) => {
            return rewriteQuestionMediaUrls(q, mediaUrlMap, diagramMapping);
          });

          let { error } = await (supabase.from('questions') as any).upsert(batch, {
            onConflict: 'id',
          });

          // Schema drift fallback: if target Supabase table doesn't have newer columns yet
          if (
            error &&
            error.message &&
            (error.message.includes('diagram_source') ||
              error.message.includes('resource_ref') ||
              error.message.includes('insert_page_number') ||
              error.message.includes('audio_url') ||
              error.message.includes('audio_metadata'))
          ) {
            console.warn(
              '[RestoreService] Extended columns missing in target database; falling back to core schema:',
              error.message
            );
            const fallbackBatch = batch.map(
              ({
                diagram_source,
                resource_ref,
                insert_page_number,
                audio_url,
                audio_metadata,
                mark_scheme,
                ...rest
              }: any) => {
                const ms =
                  typeof mark_scheme === 'object' && mark_scheme !== null ? { ...mark_scheme } : { raw: mark_scheme };
                if (audio_url) (ms as any)._audio_url = audio_url;
                if (audio_metadata) (ms as any)._audio_metadata = audio_metadata;
                if (diagram_source) (ms as any)._diagram_source = diagram_source;
                if (resource_ref) (ms as any)._resource_ref = resource_ref;
                if (insert_page_number) (ms as any)._insert_page_number = insert_page_number;
                return {
                  ...rest,
                  mark_scheme: ms,
                };
              }
            );

            const retry = await (supabase.from('questions') as any).upsert(fallbackBatch, {
              onConflict: 'id',
            });
            error = retry.error;
          }

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

    // ─── Step 4: Restore Custom Tests with Foreign Key Fallback ───────────
    onProgress?.('Restoring custom tests…', 86);
    const testsFile = zip.file('data/custom_tests.json');
    if (testsFile) {
      const tList = JSON.parse(await testsFile.async('string')) as CustomTest[];
      if (Array.isArray(tList) && tList.length > 0) {
        let { error } = await (supabase.from('custom_tests') as any).upsert(tList, {
          onConflict: 'id',
        });

        // Foreign key fallback: if user_id does not exist in target project's auth.users
        if (
          error &&
          (error.message.includes('user_id') ||
            error.message.includes('foreign key') ||
            error.message.includes('fkey') ||
            error.message.includes('auth.users') ||
            error.message.includes('users'))
        ) {
          console.warn('[RestoreService] Foreign key constraint on user_id failed, retrying with user_id: null fallback');
          const sanitized = tList.map(({ user_id, ...rest }) => ({ ...rest, user_id: null }));
          const retry = await (supabase.from('custom_tests') as any).upsert(sanitized, {
            onConflict: 'id',
          });
          error = retry.error;
        }

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

    // ─── Step 7: Sync Client LocalStorage & Notify Application ────────────
    onProgress?.('Synchronizing local caches & finalizing restore…', 98);
    if (typeof window !== 'undefined') {
      // Sync published quizzes and school classes to localStorage
      if (appConfigFile) {
        try {
          const cfgList = JSON.parse(await appConfigFile.async('string'));
          if (Array.isArray(cfgList)) {
            const pubQuizzes = cfgList.find((c: any) => c.key === 'published_quizzes');
            if (pubQuizzes?.value) {
              localStorage.setItem('fluffykitten_published_quizzes', pubQuizzes.value);
              window.dispatchEvent(new Event('published_quizzes_updated'));
            }
            const schoolClasses = cfgList.find((c: any) => c.key === 'school_classes');
            if (schoolClasses?.value) {
              const parsed = JSON.parse(schoolClasses.value);
              if (Array.isArray(parsed) && parsed.length > 0) {
                const cur = getSavedSettings();
                saveSettings({ ...cur, classes: parsed });
                window.dispatchEvent(new Event('settings_updated'));
              }
            }
          }
        } catch (e) {
          console.warn('[RestoreService] Cache sync note:', e);
        }
      }

      window.dispatchEvent(new Event('questions_updated'));
      window.dispatchEvent(new Event('tests_updated'));
      window.dispatchEvent(new Event('quiz_submissions_updated'));
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
