// ─── Unified Cloud Storage Service ─────────────────────────────────────────────
// Routes diagram image and audio uploads to Cloudflare R2 via high-speed Worker proxy
// (10 GB free forever, $0 egress bandwidth fees, unblocked in Indonesia).
// Automatically falls back to Supabase Storage if Cloudflare R2 is offline or unconfigured.

import { supabase } from '../lib/supabase';
import { getSavedSettings } from '../lib/settings';

const DEFAULT_R2_ENDPOINT = 'https://testmaker-media.icmadani.workers.dev';
const DEFAULT_R2_SECRET = 'tm_r2_uploader_secret_2026';

export interface StorageUploadResult {
  url: string;
  provider: 'cloudflare_r2' | 'supabase';
}

/**
 * Returns active media proxy endpoint from env, settings, or default.
 */
export function getR2MediaEndpoint(): string {
  const envUrl = (import.meta as any).env?.VITE_R2_MEDIA_ENDPOINT;
  if (envUrl && typeof envUrl === 'string' && envUrl.trim()) {
    return envUrl.trim().replace(/\/+$/, '');
  }
  const settings = getSavedSettings();
  if ((settings as any).r2MediaEndpoint && typeof (settings as any).r2MediaEndpoint === 'string') {
    return (settings as any).r2MediaEndpoint.trim().replace(/\/+$/, '');
  }
  return DEFAULT_R2_ENDPOINT;
}

/**
 * Returns upload secret from env, settings, or default.
 */
export function getR2UploadSecret(): string {
  const envSecret = (import.meta as any).env?.VITE_R2_UPLOAD_SECRET;
  if (envSecret && typeof envSecret === 'string' && envSecret.trim()) {
    return envSecret.trim();
  }
  const settings = getSavedSettings();
  if ((settings as any).r2UploadSecret && typeof (settings as any).r2UploadSecret === 'string') {
    return (settings as any).r2UploadSecret.trim();
  }
  return DEFAULT_R2_SECRET;
}

/**
 * Checks if Cloudflare R2 is enabled.
 */
export function isR2StorageEnabled(): boolean {
  const settings = getSavedSettings();
  if ((settings as any).storageProvider === 'supabase') return false;
  return Boolean(getR2MediaEndpoint());
}

/**
 * Uploads a file blob to Cloudflare R2 via Worker proxy.
 */
async function uploadToR2Proxy(
  blob: Blob,
  pathKey: string
): Promise<string | null> {
  const endpoint = getR2MediaEndpoint();
  const secret = getR2UploadSecret();
  if (!endpoint) return null;

  const url = `${endpoint}/${pathKey}`;

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${secret}`,
        'Content-Type': blob.type || 'application/octet-stream',
      },
      body: blob,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.warn(`R2 upload rejected (${response.status}):`, errText);
      return null;
    }

    const json = await response.json().catch(() => null);
    return json?.url || url;
  } catch (err: any) {
    console.warn(`R2 upload network error for ${pathKey}:`, err?.message);
    return null;
  }
}

/**
 * Fallback: Uploads diagram directly to Supabase Storage `exam-diagrams` bucket.
 */
async function uploadDiagramToSupabase(
  blob: Blob,
  pathKey: string
): Promise<string | null> {
  try {
    const isWebP = blob.type === 'image/webp';
    const contentType = isWebP ? 'image/webp' : 'image/png';

    const { error } = await supabase.storage
      .from('exam-diagrams')
      .upload(pathKey, blob, {
        contentType,
        upsert: true,
      });

    if (error) {
      console.warn(`Supabase Storage fallback note (${pathKey}):`, error.message);
      return null;
    }

    const { data } = supabase.storage
      .from('exam-diagrams')
      .getPublicUrl(pathKey);

    return data?.publicUrl || null;
  } catch (err: any) {
    console.warn('Supabase Storage fallback exception:', err?.message);
    return null;
  }
}

/**
 * Fallback: Uploads audio directly to Supabase Storage `exam-audio` (or `exam-diagrams`).
 */
async function uploadAudioToSupabase(
  blob: Blob,
  pathKey: string
): Promise<string | null> {
  try {
    let bucketName = 'exam-audio';
    let { error } = await supabase.storage
      .from(bucketName)
      .upload(pathKey, blob, {
        contentType: blob.type || 'audio/webm',
        upsert: true,
      });

    if (error && (error.message.includes('not found') || error.message.includes('Bucket') || error.message.includes('does not exist'))) {
      bucketName = 'exam-diagrams';
      const fallbackUpload = await supabase.storage
        .from(bucketName)
        .upload(pathKey, blob, {
          contentType: blob.type || 'audio/webm',
          upsert: true,
        });
      error = fallbackUpload.error;
    }

    if (error) {
      console.warn(`Supabase Audio fallback note (${pathKey}):`, error.message);
      return null;
    }

    const { data } = supabase.storage
      .from(bucketName)
      .getPublicUrl(pathKey);

    return data?.publicUrl || null;
  } catch (err: any) {
    console.warn('Supabase Audio fallback exception:', err?.message);
    return null;
  }
}

/**
 * Primary uploader for exam diagrams.
 * Routes to Cloudflare R2 first, transparently falls back to Supabase.
 */
export async function uploadDiagramImage(
  blob: Blob,
  fileName: string
): Promise<string | null> {
  const isWebP = blob.type === 'image/webp';
  const ext = isWebP ? 'webp' : 'png';
  const cleanName = fileName.replace(/\.[a-zA-Z0-9]+$/, '');
  const pathKey = `diagrams/${cleanName}.${ext}`;

  if (isR2StorageEnabled()) {
    const r2Url = await uploadToR2Proxy(blob, pathKey);
    if (r2Url) return r2Url;
    console.warn('Cloudflare R2 failed; falling back to Supabase Storage for diagram.');
  }

  return uploadDiagramToSupabase(blob, pathKey);
}

/**
 * Primary uploader for exam listening tracks and voice recordings.
 * Routes to Cloudflare R2 first, transparently falls back to Supabase.
 */
export async function uploadAudioTrack(
  blob: Blob,
  fileNamePrefix: string = 'audio'
): Promise<string | null> {
  const timestamp = Date.now();
  const rand = Math.random().toString(36).substring(2, 7);
  let ext = 'webm';
  if (blob.type.includes('wav')) ext = 'wav';
  else if (blob.type.includes('mp3') || blob.type.includes('mpeg')) ext = 'mp3';
  else if (blob.type.includes('mp4') || blob.type.includes('m4a')) ext = 'm4a';
  else if (blob.type.includes('ogg')) ext = 'ogg';

  const pathKey = `audio/${fileNamePrefix}_${timestamp}_${rand}.${ext}`;

  if (isR2StorageEnabled()) {
    const r2Url = await uploadToR2Proxy(blob, pathKey);
    if (r2Url) return r2Url;
    console.warn('Cloudflare R2 failed; falling back to Supabase Storage for audio.');
  }

  return uploadAudioToSupabase(blob, pathKey);
}

/**
 * Diagnostic ping test for Cloudflare R2 Worker connection.
 */
export async function testR2Connection(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const endpoint = getR2MediaEndpoint();
  const secret = getR2UploadSecret();
  if (!endpoint) return { ok: false, latencyMs: 0, error: 'Endpoint URL is missing' };

  const start = performance.now();
  try {
    const testKey = `diagrams/__ping_test_${Date.now()}.txt`;
    const testBlob = new Blob(['ping'], { type: 'text/plain' });

    const uploadRes = await fetch(`${endpoint}/${testKey}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${secret}`,
        'Content-Type': 'text/plain',
      },
      body: testBlob,
    });

    if (!uploadRes.ok) {
      return { ok: false, latencyMs: Math.round(performance.now() - start), error: `Upload HTTP ${uploadRes.status}` };
    }

    const readRes = await fetch(`${endpoint}/${testKey}`);
    const latencyMs = Math.round(performance.now() - start);

    if (!readRes.ok) {
      return { ok: false, latencyMs, error: `Read HTTP ${readRes.status}` };
    }

    return { ok: true, latencyMs };
  } catch (err: any) {
    return { ok: false, latencyMs: Math.round(performance.now() - start), error: err?.message || 'Network error' };
  }
}
