// ─── DOCX Image Dimension, Scaling & Transcoding Helpers ─────────────────────
// Ensures embedded exam diagrams and institutional logos preserve exact aspect ratios
// without upscaling small images and transcodes WebP/SVG bytes into valid PNG for Word.

export interface LoadedImageData {
  data: Uint8Array;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
  type: 'png' | 'jpg';
}

export interface ImageDimensions {
  width: number;
  height: number;
  format: 'png' | 'jpg' | 'webp' | 'svg' | 'unknown';
}

/**
 * Fits (naturalW, naturalH) inside (maxW, maxH) while preserving exact aspect ratio.
 * By default never upscales images smaller than the bounding box.
 */
export function fitImageDimensions(
  naturalW: number,
  naturalH: number,
  maxW: number,
  maxH: number,
  allowUpscale = false
): { width: number; height: number } {
  if (!naturalW || !naturalH || naturalW <= 0 || naturalH <= 0) {
    return { width: Math.round(maxW), height: Math.round(maxH) };
  }
  const limitScale = allowUpscale ? Number.POSITIVE_INFINITY : 1;
  const scale = Math.min(maxW / naturalW, maxH / naturalH, limitScale);
  return {
    width: Math.max(1, Math.round(naturalW * scale)),
    height: Math.max(1, Math.round(naturalH * scale)),
  };
}

/**
 * Decodes pixel dimensions and container format directly from PNG, JPEG, WebP, or SVG bytes.
 */
export function getImageDimensionsFromBytes(bytes: Uint8Array): ImageDimensions {
  if (!bytes || bytes.length < 12) {
    return { width: 0, height: 0, format: 'unknown' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A ... IHDR at bytes 16..23
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes.length >= 24) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      width: view.getUint32(16, false),
      height: view.getUint32(20, false),
      format: 'png',
    };
  }

  // JPEG: FF D8 ... walk SOF0..SOF3, SOF5..SOF7, SOF9..SOF11 markers
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS
      if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      const segLen = view.getUint16(offset + 2, false);
      if (segLen < 2 || offset + 2 + segLen > bytes.length) break;
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof && offset + 9 <= bytes.length) {
        return {
          height: view.getUint16(offset + 5, false),
          width: view.getUint16(offset + 7, false),
          format: 'jpg',
        };
      }
      offset += 2 + segLen;
    }
    return { width: 0, height: 0, format: 'jpg' };
  }

  // WebP: "RIFF" <len> "WEBP" followed by VP8X / VP8  / VP8L chunks
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let pos = 12;
    while (pos + 8 <= bytes.length) {
      const chunkId = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
      const chunkSize = view.getUint32(pos + 4, true);
      const dataStart = pos + 8;

      if (chunkId === 'VP8X' && dataStart + 10 <= bytes.length) {
        const w = 1 + (bytes[dataStart + 4] | (bytes[dataStart + 5] << 8) | (bytes[dataStart + 6] << 16));
        const h = 1 + (bytes[dataStart + 7] | (bytes[dataStart + 8] << 8) | (bytes[dataStart + 9] << 16));
        return { width: w, height: h, format: 'webp' };
      }
      if (chunkId === 'VP8 ' && dataStart + 10 <= bytes.length) {
        const w = view.getUint16(dataStart + 6, true) & 0x3fff;
        const h = view.getUint16(dataStart + 8, true) & 0x3fff;
        return { width: w, height: h, format: 'webp' };
      }
      if (chunkId === 'VP8L' && dataStart + 5 <= bytes.length) {
        const bits = view.getUint32(dataStart + 1, true);
        const w = (bits & 0x3fff) + 1;
        const h = ((bits >> 14) & 0x3fff) + 1;
        return { width: w, height: h, format: 'webp' };
      }

      pos = dataStart + chunkSize + (chunkSize % 2);
    }
    return { width: 0, height: 0, format: 'webp' };
  }

  // SVG check (plain text XML containing <svg)
  try {
    const head = new TextDecoder().decode(bytes.subarray(0, Math.min(512, bytes.length)));
    if (/<svg[\s>]/i.test(head)) {
      const vbMatch = head.match(/viewBox\s*=\s*["']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*["']/i);
      const wMatch = head.match(/\bwidth\s*=\s*["']\s*([\d.]+)/i);
      const hMatch = head.match(/\bheight\s*=\s*["']\s*([\d.]+)/i);
      const w = wMatch ? parseFloat(wMatch[1]) : vbMatch ? parseFloat(vbMatch[1]) : 400;
      const h = hMatch ? parseFloat(hMatch[1]) : vbMatch ? parseFloat(vbMatch[2]) : 250;
      return { width: Math.round(w), height: Math.round(h), format: 'svg' };
    }
  } catch {
    // Ignore decode errors on binary payloads
  }

  return { width: 0, height: 0, format: 'unknown' };
}

/**
 * Transcodes WebP/SVG (or unknown raster bytes) to genuine PNG bytes inside a browser context
 * and reads exact natural pixel dimensions. In headless/Node test contexts without DOM Canvas,
 * preserves bytes and returns decoded pixel dimensions so aspect ratios remain accurate.
 */
async function transcodeToPngIfNeeded(
  bytes: Uint8Array,
  info: ImageDimensions
): Promise<{ data: Uint8Array; width: number; height: number; type: 'png' | 'jpg' } | null> {
  if (info.format === 'jpg') {
    return {
      data: bytes,
      width: info.width || 380,
      height: info.height || 220,
      type: 'jpg',
    };
  }

  if (info.format === 'png' && info.width > 0 && info.height > 0) {
    return {
      data: bytes,
      width: info.width,
      height: info.height,
      type: 'png',
    };
  }

  // Browser-side transcode of WebP / SVG / exotic formats -> true PNG bytes
  const mime =
    info.format === 'webp'
      ? 'image/webp'
      : info.format === 'svg'
        ? 'image/svg+xml'
        : 'image/png';

  if (typeof document !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    try {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      const blob = new Blob([copy.buffer], { type: mime });
      if (typeof createImageBitmap === 'function' && info.format !== 'svg') {
        const bitmap = await createImageBitmap(blob);
        try {
          const w = bitmap.width || info.width || 380;
          const h = bitmap.height || info.height || 220;
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(bitmap, 0, 0, w, h);
            const pngBlob = await new Promise<Blob | null>((resolve) =>
              canvas.toBlob((b) => resolve(b), 'image/png')
            );
            if (pngBlob) {
              const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
              return { data: pngBytes, width: w, height: h, type: 'png' };
            }
          }
        } finally {
          bitmap.close();
        }
      }

      // Fallback HTMLImageElement route (also supports SVG reliably)
      const objUrl = URL.createObjectURL(blob);
      try {
        const img = await new Promise<HTMLImageElement>((resolve, reject) => {
          const el = new Image();
          el.onload = () => resolve(el);
          el.onerror = reject;
          el.src = objUrl;
        });
        const w = img.naturalWidth || img.width || info.width || 380;
        const h = img.naturalHeight || img.height || info.height || 220;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, w, h);
          const pngBlob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob((b) => resolve(b), 'image/png')
          );
          if (pngBlob) {
            const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
            return { data: pngBytes, width: w, height: h, type: 'png' };
          }
        }
      } finally {
        URL.revokeObjectURL(objUrl);
      }
    } catch {
      // Fall through to raw bytes with decoded natural dimensions
    }
  }

  // Never emit WebP/SVG/unknown raw bytes mislabeled as PNG — Word will reject or distort them.
  return null;
}

/**
 * Decodes raw image bytes (data URI or fetched URL), normalizes WebP/SVG to PNG when possible,
 * and returns exact natural pixel dimensions so callers never distort image aspect ratios.
 */
export async function prepareDocxImageBytes(bytes: Uint8Array): Promise<LoadedImageData | null> {
  if (!bytes || bytes.length === 0) return null;
  const info = getImageDimensionsFromBytes(bytes);
  const prepared = await transcodeToPngIfNeeded(bytes, info);
  if (!prepared) return null;
  return {
    data: prepared.data,
    width: prepared.width,
    height: prepared.height,
    naturalWidth: prepared.width,
    naturalHeight: prepared.height,
    type: prepared.type,
  };
}
