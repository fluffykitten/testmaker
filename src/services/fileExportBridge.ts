import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import saveAs from 'file-saver';

/**
 * Universal File Exporter for 1:1 Web & Mobile Parity.
 *
 * - On Web: Triggers standard browser download via file-saver.
 * - On Native Android / iOS: Writes file to device cache and opens the native OS
 *   Share Sheet so the user can save to Files, AirDrop, open in Word, or print.
 */
export async function exportFileUniversal(
  blob: Blob,
  filename: string,
  _mimeType: string = 'application/octet-stream'
): Promise<void> {
  // If running in standard web browser, use browser download
  if (!Capacitor.isNativePlatform()) {
    saveAs(blob, filename);
    return;
  }

  // Running on Native Mobile (iOS / Android)
  try {
    const base64Data = await blobToBase64(blob);

    const writeResult = await Filesystem.writeFile({
      path: filename,
      data: base64Data,
      directory: Directory.Cache,
    });

    await Share.share({
      title: filename,
      url: writeResult.uri,
      dialogTitle: `Export ${filename}`,
    });
  } catch (err) {
    console.warn('Native mobile share failed, falling back to web download:', err);
    saveAs(blob, filename);
  }
}

/**
 * Helper to convert Blob to pure Base64 string without data-url prefix.
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.readAsDataURL(blob);
  });
}
