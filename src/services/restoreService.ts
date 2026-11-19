/**
 * Intelligent Restore Service for TestMaker.
 * Inspects, validates, and restores Supabase SQL tables and re-uploads diagram image files
 * into Supabase Storage ('exam-diagrams' bucket), rewriting URLs to match the active project.
 */

import { supabase } from '../lib/supabase';
import { extractDiagramFileName, type BackupManifest } from './backupService';
import { getSavedSettings, saveSettings } from '../lib/settings';
import {
  ensureFolderPermission,
  isDirectoryHandleLike,
  listMediaFilesFromDirectory,
  readTextFileFromDirectory,
} from './localBackupFolderService';
import type { Question, Syllabus, CustomTest } from '../types/database';

export type RestoreSourceInput = File | Blob | ArrayBuffer | FileSystemDirectoryHandle;

interface RestoreArchiveReader {
  readText: (relativePath: string) => Promise<string | null>;
  listMediaEntries: () => Promise<Array<{ fileName: string; getBlob: () => Promise<Blob> }>>;
}

async function openRestoreArchive(source: RestoreSourceInput): Promise<RestoreArchiveReader> {
  if (isDirectoryHandleLike(source)) {
    const granted = await ensureFolderPermission(source, 'read');
    if (!granted) {
      throw new Error('Folder read permission was denied. Please allow read access to restore from this folder.');
    }
    return {
      readText: (relativePath: string) => readTextFileFromDirectory(source, relativePath),
      listMediaEntries: async () => {
        const items = await listMediaFilesFromDirectory(source);
        return items.map(({ fileName, getBlob }) => ({ fileName, getBlob }));
      },
    };
  }

  const JSZip = (await import('jszip')).default;
  const dataToLoad =
    source instanceof ArrayBuffer
      ? source
      : typeof (source as Blob).arrayBuffer === 'function'
      ? await (source as Blob).arrayBuffer()
      : source;
  const zip = await JSZip.loadAsync(dataToLoad);

  return {
    readText: async (relativePath: string) => {
      const f = zip.file(relativePath);
      return f ? f.async('string') : null;
    },
    listMediaEntries: async () => {
      const entries: Array<{ fileName: string; getBlob: () => Promise<Blob> }> = [];
      const diagramsFolder = zip.folder('diagrams');
      if (!diagramsFolder) return entries;
      diagramsFolder.forEach((relativePath: string, file: any) => {
        if (!file.dir) {
          const fileName = relativePath.split('/').pop() || relativePath;
          entries.push({ fileName, getBlob: () => file.async('blob') });
        }
      });
      return entries;
    },
  };
}

export interface RestoreInspectionResult {
  isValid: boolean;
  error?: string;
  manifest?: BackupManifest;
  syllabusesCount: number;
  questionsCount: number;
  customTestsCount: number;
  quizSubmissionsCount: number;
  appConfigCount: number;
  teacherProfilesCount?: number;
  proctorAuditEventsCount?: number;
  gameProfilesCount?: number;
  diagramsCount: number;
  warnings?: string[];
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
  teacherProfilesRestored?: number;
  proctorAuditEventsRestored?: number;
  gameProfilesRestored?: number;
  errors: string[];
}

export interface RestoreProgressCallback {
  (status: string, percentage: number): void;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sanitizeQuestionForRestore(q: any): any {
  const {
    cambridge_hub_url,
    cambridge_ms_hub_url,
    insert_pdf_url,
    ai_diagram_prompt,
    svg_content,
    diagram_type,
    has_embedded_values,
    data_tables,
    scratchpad,
    question_number_numeric,
    mark_scheme,
    ...rest
  } = q || {};

  const ms =
    typeof mark_scheme === 'object' && mark_scheme !== null
      ? { ...mark_scheme }
      : mark_scheme !== undefined
        ? { raw: mark_scheme }
        : {};

  if (cambridge_hub_url) (ms as any)._cambridge_hub_url = cambridge_hub_url;
  if (cambridge_ms_hub_url) (ms as any)._cambridge_ms_hub_url = cambridge_ms_hub_url;
  if (insert_pdf_url) (ms as any)._insert_pdf_url = insert_pdf_url;
  if (ai_diagram_prompt) (ms as any)._ai_diagram_prompt = ai_diagram_prompt;
  if (svg_content) (ms as any)._svg_content = svg_content;
  if (diagram_type) (ms as any)._diagram_type = diagram_type;
  if (has_embedded_values !== undefined) (ms as any)._has_embedded_values = has_embedded_values;
  if (data_tables) (ms as any)._data_tables = data_tables;
  if (scratchpad) (ms as any)._scratchpad = scratchpad;

  return {
    ...rest,
    mark_scheme: ms,
  };
}

function getStorageMimeType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.webm')) return 'audio/webm';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  return 'application/octet-stream';
}

function getRestoreStoragePath(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.pdf')) return `papers/${fileName}`;
  if (
    lower.endsWith('.mp3') ||
    lower.endsWith('.webm') ||
    lower.endsWith('.ogg') ||
    lower.endsWith('.wav') ||
    lower.endsWith('.m4a')
  ) {
    return `audio/${fileName}`;
  }
  return `diagrams/${fileName}`;
}

/**
 * Inspects a backup archive (.zip) or synced local backup folder and extracts manifest & preview stats.
 */
export async function inspectBackupArchive(source: RestoreSourceInput): Promise<RestoreInspectionResult> {
  try {
    const archive = await openRestoreArchive(source);

    // Check for manifest.json
    const manifestText = await archive.readText('manifest.json');
    if (!manifestText) {
      return {
        isValid: false,
        error: 'Invalid backup source: Missing manifest.json file.',
        syllabusesCount: 0,
        questionsCount: 0,
        customTestsCount: 0,
        quizSubmissionsCount: 0,
        appConfigCount: 0,
        diagramsCount: 0,
      };
    }

    const manifest = JSON.parse(manifestText) as BackupManifest;

    const readArrayCount = async (path: string, fallback = 0): Promise<number> => {
      const text = await archive.readText(path);
      if (!text) return fallback;
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.length : fallback;
    };

    const questionsCount = await readArrayCount('data/questions.json', manifest.stats?.questionsCount || 0);
    const syllabusesCount = await readArrayCount('data/syllabuses.json', manifest.stats?.syllabusesCount || 0);
    const customTestsCount = await readArrayCount('data/custom_tests.json', manifest.stats?.customTestsCount || 0);
    const quizSubmissionsCount = await readArrayCount('data/quiz_submissions.json', manifest.stats?.quizSubmissionsCount || 0);
    const appConfigCount = await readArrayCount('data/app_config.json', manifest.stats?.appConfigCount || 0);
    const teacherProfilesCount = await readArrayCount('data/teacher_profiles.json', manifest.stats?.teacherProfilesCount || 0);
    const proctorAuditEventsCount = await readArrayCount('data/proctor_audit_events.json', manifest.stats?.proctorAuditEventsCount || 0);
    const gameProfilesCount = await readArrayCount('data/game_profiles.json', manifest.stats?.gameProfilesCount || 0);

    const mediaEntries = await archive.listMediaEntries();
    const diagramsCount = mediaEntries.length;

    return {
      isValid: true,
      manifest,
      syllabusesCount,
      questionsCount,
      customTestsCount,
      quizSubmissionsCount,
      appConfigCount,
      teacherProfilesCount,
      proctorAuditEventsCount,
      gameProfilesCount,
      diagramsCount,
      warnings: manifest.warnings,
    };
  } catch (err) {
    return {
      isValid: false,
      error: err instanceof Error ? err.message : 'Corrupted or unreadable backup source.',
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
 * Re-uploads diagram, audio, and PDF files from archive/folder into Supabase Storage and maps old URLs to new URLs.
 */
async function restoreDiagramsToStorage(
  archive: RestoreArchiveReader,
  onProgress?: (count: number, total: number) => void
): Promise<{ urlMap: Map<string, string>; storageErrors: string[] }> {
  const urlMap = new Map<string, string>();
  const storageErrors: string[] = [];
  const entries = await archive.listMediaEntries();

  if (entries.length === 0) return { urlMap, storageErrors };

  // Upload in batches of 6
  const BATCH_SIZE = 6;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);

    await Promise.all(
      batch.map(async ({ fileName, getBlob }) => {
        try {
          const blob = await getBlob();
          const storagePath = getRestoreStoragePath(fileName);
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
          storageErrors.push(`Failed to upload media ${fileName}: ${err?.message || 'Storage error'}`);
        }
      })
    );

    onProgress?.(Math.min(entries.length, i + batch.length), entries.length);
  }

  return { urlMap, storageErrors };
}

/**
 * Rewrites a question's diagram_url, audio_url, PDF links, and insert_resources URLs
 * using newly uploaded storage URLs, checking manifest.diagramMapping first for collision-safe lookup.
 */
export function rewriteQuestionMediaUrls(
  q: Question,
  mediaUrlMap: Map<string, string>,
  diagramMapping?: Record<string, string>
): Question {
  function getNewMediaUrl(origUrl: string | null | undefined): string | null {
    if (!origUrl || typeof origUrl !== 'string' || !/^https?:\/\//i.test(origUrl.trim())) {
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

  function rewriteResourceList(list: any): any {
    if (!Array.isArray(list)) return list;
    return list.map((res: any) =>
      res && typeof res === 'object' && res.url
        ? { ...res, url: getNewMediaUrl(res.url) || res.url }
        : res
    );
  }

  const updatedDiagramUrl = getNewMediaUrl(q.diagram_url);
  const updatedAudioUrl = getNewMediaUrl(q.audio_url);
  const updatedSourcePdfUrl = getNewMediaUrl((q as any).source_pdf_url);
  const updatedInsertPdfUrl = getNewMediaUrl((q as any).insert_pdf_url);

  let updatedMarkScheme = (q as any).mark_scheme;
  if (updatedMarkScheme && typeof updatedMarkScheme === 'object') {
    updatedMarkScheme = { ...updatedMarkScheme };
    if (updatedMarkScheme._source_pdf_url) {
      updatedMarkScheme._source_pdf_url =
        getNewMediaUrl(updatedMarkScheme._source_pdf_url) || updatedMarkScheme._source_pdf_url;
    }
    if (updatedMarkScheme._insert_pdf_url) {
      updatedMarkScheme._insert_pdf_url =
        getNewMediaUrl(updatedMarkScheme._insert_pdf_url) || updatedMarkScheme._insert_pdf_url;
    }
    if (Array.isArray(updatedMarkScheme._insert_resources)) {
      updatedMarkScheme._insert_resources = rewriteResourceList(updatedMarkScheme._insert_resources);
    }
  }

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
    ...(updatedSourcePdfUrl !== null ? { source_pdf_url: updatedSourcePdfUrl } : {}),
    ...(updatedInsertPdfUrl !== null ? { insert_pdf_url: updatedInsertPdfUrl } : {}),
    ...(Array.isArray((q as any).insert_resources)
      ? { insert_resources: rewriteResourceList((q as any).insert_resources) }
      : {}),
    mark_scheme: updatedMarkScheme,
    sub_questions: updatedSubs,
  } as Question;
}

/**
 * Rewrites embedded question snapshot URLs inside app_config's published_quizzes JSON value.
 */
export function rewritePublishedQuizzesMediaUrls(
  rawValue: string,
  mediaUrlMap: Map<string, string>,
  diagramMapping?: Record<string, string>
): string {
  if (!rawValue || mediaUrlMap.size === 0) return rawValue;
  try {
    const quizzes = JSON.parse(rawValue);
    if (!Array.isArray(quizzes)) return rawValue;
    const rewritten = quizzes.map((quiz: any) => {
      if (!quiz || typeof quiz !== 'object' || !Array.isArray(quiz.questions)) return quiz;
      return {
        ...quiz,
        questions: quiz.questions.map((qq: any) =>
          rewriteQuestionMediaUrls(qq, mediaUrlMap, diagramMapping)
        ),
      };
    });
    return JSON.stringify(rewritten);
  } catch {
    return rawValue;
  }
}

/**
 * Synchronizes restored app_config entries into browser localStorage caches and emits update events.
 */
export function syncRestoredAppConfigToLocalStorage(
  cfgList: Array<{ key?: string; value?: string }>
): void {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined' || !Array.isArray(cfgList)) {
    return;
  }

  const byKey = new Map<string, string>();
  for (const row of cfgList) {
    if (row?.key && typeof row.value === 'string') {
      byKey.set(row.key, row.value);
    }
  }

  const pubQuizzes = byKey.get('published_quizzes');
  if (pubQuizzes !== undefined) {
    localStorage.setItem('fluffykitten_published_quizzes', pubQuizzes);
    window.dispatchEvent(new Event('published_quizzes_updated'));
  }

  const schoolRoster = byKey.get('school_roster');
  if (schoolRoster !== undefined) {
    localStorage.setItem('testmaker_school_student_roster', schoolRoster);
    window.dispatchEvent(new Event('school_roster_updated'));
  }

  const examSchedule = byKey.get('exam_schedule_entries');
  if (examSchedule !== undefined) {
    localStorage.setItem('testmaker_school_exam_schedule', examSchedule);
    try {
      window.dispatchEvent(
        new CustomEvent('exam_schedule_updated', { detail: { entries: JSON.parse(examSchedule) } })
      );
    } catch {
      window.dispatchEvent(new Event('exam_schedule_updated'));
    }
  }

  const cur = getSavedSettings();
  const nextSettings = { ...cur };
  let settingsChanged = false;

  const tryParseJson = (key: string): any => {
    const raw = byKey.get(key);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };

  const classes = tryParseJson('school_classes');
  if (Array.isArray(classes) && classes.length > 0) {
    nextSettings.classes = classes;
    settingsChanged = true;
  }
  const subjects = tryParseJson('school_subjects');
  if (Array.isArray(subjects) && subjects.length > 0) {
    nextSettings.subjects = subjects;
    settingsChanged = true;
  }
  const driveId = byKey.get('google_drive_client_id');
  if (driveId !== undefined) {
    nextSettings.googleDriveClientId = driveId;
    settingsChanged = true;
  }
  const hideCreative = byKey.get('hide_creative_mode_landing');
  if (hideCreative !== undefined) {
    nextSettings.hideCreativeModeOnLanding = hideCreative === 'true';
    settingsChanged = true;
  }
  const allowClaim = byKey.get('allow_teacher_account_claiming');
  if (allowClaim !== undefined) {
    nextSettings.allowTeacherAccountClaiming = allowClaim === 'true';
    settingsChanged = true;
  }
  const hideEmerg = byKey.get('hide_emergency_exam_button');
  if (hideEmerg !== undefined) {
    nextSettings.hideEmergencyExamButton = hideEmerg === 'true';
    settingsChanged = true;
  }
  const geminiModel = byKey.get('gemini_extraction_model');
  if (geminiModel) {
    nextSettings.geminiExtractionModel = geminiModel;
    settingsChanged = true;
  }
  const geminiTier = byKey.get('gemini_api_key_tier');
  if (geminiTier === 'auto' || geminiTier === 'paid' || geminiTier === 'free') {
    nextSettings.geminiApiKeyTier = geminiTier;
    settingsChanged = true;
  }
  const secTiers = tryParseJson('exam_security_tiers');
  if (Array.isArray(secTiers)) {
    nextSettings.securityTiers = secTiers;
    settingsChanged = true;
  }
  const masteryTiers = tryParseJson('topic_mastery_tiers');
  if (Array.isArray(masteryTiers)) {
    nextSettings.topicMasteryTiers = masteryTiers;
    settingsChanged = true;
    window.dispatchEvent(
      new CustomEvent('topic_mastery_tiers_updated', {
        detail: { topicMasteryTiers: masteryTiers },
      })
    );
  }

  if (settingsChanged) {
    saveSettings(nextSettings);
    window.dispatchEvent(new Event('settings_updated'));
  }
}

/**
 * Executes full restore from a verified backup archive (.zip) or synced PC folder.
 */
export async function executeRestore(
  source: RestoreSourceInput,
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
  let teacherProfilesRestored = 0;
  let proctorAuditEventsRestored = 0;
  let gameProfilesRestored = 0;

  try {
    onProgress?.('Opening backup source…', 10);
    const archive = await openRestoreArchive(source);

    // Read manifest for collision-free diagram mapping if available
    let diagramMapping: Record<string, string> | undefined;
    const manifestText = await archive.readText('manifest.json');
    if (manifestText) {
      try {
        const manifest = JSON.parse(manifestText) as BackupManifest;
        diagramMapping = manifest.diagramMapping;
      } catch {
        // Continue with standard filename extraction if manifest parse fails
      }
    }

    const auditText = await archive.readText('data/proctor_audit_events.json');
    const gameProfilesText = await archive.readText('data/game_profiles.json');

    // ─── Optional: If Replace mode, clear existing records cleanly ─────────
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

      const { error: sylDelErr } = await (supabase.from('syllabuses') as any)
        .delete()
        .neq('id', '00000000-0000-0000-0000-000000000000');
      if (sylDelErr) errors.push(`Replace mode error (syllabuses): ${sylDelErr.message}`);

      const { error: subDelErr } = await (supabase.from('quiz_submissions') as any)
        .delete()
        .neq('id', '__never_id__');
      if (subDelErr) errors.push(`Replace mode error (quiz_submissions): ${subDelErr.message}`);

      const { error: cfgDelErr } = await (supabase.from('app_config') as any)
        .delete()
        .neq('key', '__never_key__');
      if (cfgDelErr) errors.push(`Replace mode error (app_config): ${cfgDelErr.message}`);

      if (auditText) {
        const { error: auditDelErr } = await (supabase.from('proctor_audit_events') as any)
          .delete()
          .neq('id', '__never_id__');
        if (auditDelErr) errors.push(`Replace mode error (proctor_audit_events): ${auditDelErr.message}`);
      }

      if (gameProfilesText) {
        const { error: gpDelErr } = await (supabase.from('game_profiles') as any)
          .delete()
          .neq('id', '00000000-0000-0000-0000-000000000000');
        if (gpDelErr && gpDelErr.code !== '42501') {
          errors.push(`Replace mode error (game_profiles): ${gpDelErr.message}`);
        }
      }
    }

    // ─── Step 1: Re-upload storage diagrams & audio ───────────────────────
    onProgress?.('Restoring exam diagrams, audio, and PDFs to Supabase Storage…', 20);
    const { urlMap: mediaUrlMap, storageErrors } = await restoreDiagramsToStorage(archive, (done, total) => {
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
    const syllabusesText = await archive.readText('data/syllabuses.json');
    if (syllabusesText) {
      const sList = JSON.parse(syllabusesText) as Syllabus[];
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
    const questionsText = await archive.readText('data/questions.json');
    if (questionsText) {
      const qList = JSON.parse(questionsText) as Question[];
      if (Array.isArray(qList) && qList.length > 0) {
        const BATCH_SIZE = 100;
        for (let i = 0; i < qList.length; i += BATCH_SIZE) {
          const batch = qList
            .slice(i, i + BATCH_SIZE)
            .filter((q) => !q?.id || UUID_REGEX.test(String(q.id)))
            .map((q) => sanitizeQuestionForRestore(rewriteQuestionMediaUrls(q, mediaUrlMap, diagramMapping)));
          if (batch.length === 0) continue;

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
              error.message.includes('audio_metadata') ||
              error.message.includes('cognitive_level') ||
              error.message.includes('source_pdf_url') ||
              error.message.includes('page_number'))
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
                cognitive_level,
                source_pdf_url,
                page_number,
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
                if (cognitive_level) (ms as any)._cognitive_level = cognitive_level;
                if (source_pdf_url) (ms as any)._source_pdf_url = source_pdf_url;
                if (page_number !== undefined && page_number !== null) (ms as any)._page_number = page_number;
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

    // ─── Step 4: Restore Custom Tests with Schema & Foreign Key Fallback ────
    onProgress?.('Restoring custom tests…', 86);
    const testsText = await archive.readText('data/custom_tests.json');
    if (testsText) {
      const tList = JSON.parse(testsText) as CustomTest[];
      if (Array.isArray(tList) && tList.length > 0) {
        const sqlTests = tList
          .filter((t: any) => UUID_REGEX.test(String(t?.id || '')))
          .map((t: any) => {
            const fullIds = Array.isArray(t.question_ids) ? t.question_ids : [];
            return {
              id: t.id,
              user_id: t.user_id ?? null,
              title: t.title || 'Custom Assessment',
              total_marks: Number(t.total_marks) || 0,
              question_ids: fullIds.filter((qid: string) => UUID_REGEX.test(String(qid || ''))),
              ...(t.created_at ? { created_at: t.created_at } : {}),
            };
          });

        if (sqlTests.length > 0) {
          let { error } = await (supabase.from('custom_tests') as any).upsert(sqlTests, {
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
            const sanitized = sqlTests.map(({ user_id: _uid, ...rest }) => ({ ...rest, user_id: null }));
            const retry = await (supabase.from('custom_tests') as any).upsert(sanitized, {
              onConflict: 'id',
            });
            error = retry.error;
          }

          if (error) errors.push(`Custom tests: ${error.message}`);
          else customTestsRestored = sqlTests.length;
        }

        // Preserve any embedded header_config or non-UUID question_ids in app_config
        const headerRows = tList
          .filter((t: any) => t?.id && (t.header_config || (Array.isArray(t.question_ids) && t.question_ids.some((qid: string) => !UUID_REGEX.test(String(qid || ''))))))
          .map((t: any) => {
            const fullIds = Array.isArray(t.question_ids) ? t.question_ids : [];
            const payload = t.header_config ? { ...t.header_config } : { title: t.title || '', schoolName: '', subject: 'General', subjectCode: '', durationMinutes: 45, instructions: '' };
            if (fullIds.some((qid: string) => !UUID_REGEX.test(String(qid || '')))) {
              payload._savedQuestionIds = fullIds;
            }
            return {
              key: `custom_test_header_${t.id}`,
              value: JSON.stringify(payload),
            };
          });
        if (headerRows.length > 0) {
          try {
            await (supabase.from('app_config') as any).upsert(headerRows, { onConflict: 'key' });
          } catch {
            // non-fatal header preservation failure
          }
        }
      }
    }

    // ─── Step 5: Restore Quiz Submissions ─────────────────────────────────
    onProgress?.('Restoring quiz submissions…', 90);
    const submissionsText = await archive.readText('data/quiz_submissions.json');
    if (submissionsText) {
      try {
        const subList = JSON.parse(submissionsText);
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
    onProgress?.('Restoring application configurations…', 93);
    let restoredCfgList: Array<{ key?: string; value?: string }> | null = null;
    const appConfigText = await archive.readText('data/app_config.json');
    if (appConfigText) {
      try {
        const parsedCfg = JSON.parse(appConfigText);
        if (Array.isArray(parsedCfg) && parsedCfg.length > 0) {
          restoredCfgList = parsedCfg.map((row: any) =>
            row?.key === 'published_quizzes' && typeof row.value === 'string'
              ? {
                  ...row,
                  value: rewritePublishedQuizzesMediaUrls(row.value, mediaUrlMap, diagramMapping),
                }
              : row
          );

          const { error } = await (supabase.from('app_config') as any).upsert(restoredCfgList, {
            onConflict: 'key',
          });
          if (error) {
            errors.push(`App config: ${error.message}`);
          } else {
            appConfigRestored = restoredCfgList.length;
          }
        }
      } catch (err: any) {
        errors.push(`App config: ${err?.message || 'Parse error'}`);
      }
    }

    // ─── Step 6b: Restore Teacher Accounts, Audit Events & Arena Profiles ──
    onProgress?.('Restoring educator accounts & extended records…', 96);
    const teacherText = await archive.readText('data/teacher_profiles.json');
    if (teacherText) {
      try {
        const tProfiles = JSON.parse(teacherText);
        if (Array.isArray(tProfiles) && tProfiles.length > 0) {
          const validProfiles = tProfiles.filter((tp: any) => !tp?.id || UUID_REGEX.test(String(tp.id)));
          if (validProfiles.length > 0) {
            const { error } = await (supabase.from('teacher_profiles') as any).upsert(validProfiles, {
              onConflict: 'id',
            });
            if (error) {
              errors.push(`Teacher profiles: ${error.message}`);
            } else {
              teacherProfilesRestored = validProfiles.length;
            }
          }
        }
      } catch (err: any) {
        errors.push(`Teacher profiles: ${err?.message || 'Parse error'}`);
      }
    }

    if (auditText) {
      try {
        const auditList = JSON.parse(auditText);
        if (Array.isArray(auditList) && auditList.length > 0) {
          const BATCH_SIZE = 200;
          for (let i = 0; i < auditList.length; i += BATCH_SIZE) {
            const batch = auditList.slice(i, i + BATCH_SIZE);
            const { error } = await (supabase.from('proctor_audit_events') as any).upsert(batch, {
              onConflict: 'id',
            });
            if (error) {
              errors.push(`Proctor audit events batch ${i}: ${error.message}`);
            } else {
              proctorAuditEventsRestored += batch.length;
            }
          }
        }
      } catch (err: any) {
        errors.push(`Proctor audit events: ${err?.message || 'Parse error'}`);
      }
    }

    if (gameProfilesText) {
      try {
        const gpList = JSON.parse(gameProfilesText);
        if (Array.isArray(gpList) && gpList.length > 0) {
          const BATCH_SIZE = 100;
          for (let i = 0; i < gpList.length; i += BATCH_SIZE) {
            const batch = gpList.slice(i, i + BATCH_SIZE);
            const { error } = await (supabase.from('game_profiles') as any).upsert(batch, {
              onConflict: 'id',
            });
            if (error) {
              if (error.code === '42501') {
                errors.push('Game profiles skipped (run Migration 028 in Supabase to allow restore).');
              } else {
                errors.push(`Game profiles batch ${i}: ${error.message}`);
              }
              break;
            } else {
              gameProfilesRestored += batch.length;
            }
          }
        }
      } catch (err: any) {
        errors.push(`Game profiles: ${err?.message || 'Parse error'}`);
      }
    }

    // ─── Step 7: Sync Client LocalStorage & Notify Application ────────────
    onProgress?.('Synchronizing local caches & finalizing restore…', 98);
    if (typeof window !== 'undefined') {
      if (restoredCfgList) {
        try {
          syncRestoredAppConfigToLocalStorage(restoredCfgList);
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
        appConfigRestored > 0 ||
        teacherProfilesRestored > 0 ||
        proctorAuditEventsRestored > 0 ||
        gameProfilesRestored > 0);

    return {
      success,
      hasPartialSuccess,
      syllabusesRestored,
      questionsRestored,
      diagramsRestored,
      customTestsRestored,
      quizSubmissionsRestored,
      appConfigRestored,
      teacherProfilesRestored,
      proctorAuditEventsRestored,
      gameProfilesRestored,
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
      teacherProfilesRestored,
      proctorAuditEventsRestored,
      gameProfilesRestored,
      errors,
    };
  }
}
