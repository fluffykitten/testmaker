// ─── Diagram Cropper ───────────────────────────────────────────────────────────
// Renders PDF pages via pdf.js and crops diagram regions using Canvas.
// Uploads cropped images to Supabase Storage with local Object URL fallback for preview.

import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { supabase } from './supabase';

// Configure pdf.js worker using Vite's ?url loader for 100% reliable bundling
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

// ─── Constants ─────────────────────────────────────────────────────────────────

/** High-resolution render scale for crisp diagram extraction */
const RENDER_SCALE = 4.0;

/** Base padding around bounding box as fraction of crop dimensions */
const BASE_PADDING_FRACTION = 0.15;

/** Minimum crop output dimensions in pixels (at render scale) */
const MIN_CROP_WIDTH = 200;
const MIN_CROP_HEIGHT = 150;

/** Fraction of edge strip to scan for non-white pixels */
const EDGE_SCAN_STRIP = 0.10;

/** Brightness threshold — pixels darker than this are considered "content" (0-255) */
const CONTENT_BRIGHTNESS_THRESHOLD = 240;

/** If ymax is within this many units of 1000, consider cross-page stitching */
const PAGE_BOUNDARY_THRESHOLD = 50;

/** Width fraction of the left margin to scan for question numbers */
const LEFT_MARGIN_FRACTION = 0.12;

/**
 * Normalizes any bounding box structure (array, object, 0-1 or 0-1000 scale)
 * to a standardized [ymin, xmin, ymax, xmax] on a 0-1000 scale.
 */
function normalizeBoundingBox(rawBox: any): [number, number, number, number] {
  if (!rawBox) {
    // Default fallback region in the middle of page if diagram was flagged without coords
    return [100, 30, 700, 970];
  }

  let ymin = 0, xmin = 0, ymax = 1000, xmax = 1000;

  if (Array.isArray(rawBox) && rawBox.length >= 4) {
    [ymin, xmin, ymax, xmax] = rawBox.map(Number);
  } else if (typeof rawBox === 'object') {
    ymin = Number(rawBox.ymin ?? rawBox.top ?? rawBox.y1 ?? 0);
    xmin = Number(rawBox.xmin ?? rawBox.left ?? rawBox.x1 ?? 0);
    ymax = Number(rawBox.ymax ?? rawBox.bottom ?? rawBox.y2 ?? 1000);
    xmax = Number(rawBox.xmax ?? rawBox.right ?? rawBox.x2 ?? 1000);
  }

  // If coordinates are in 0-1 scale, scale to 0-1000
  if (ymax <= 1.0 && xmax <= 1.0 && (ymax > 0 || xmax > 0)) {
    ymin *= 1000;
    xmin *= 1000;
    ymax *= 1000;
    xmax *= 1000;
  }

  // Clamp within 0-1000
  ymin = Math.max(0, Math.min(1000, ymin));
  xmin = Math.max(0, Math.min(1000, xmin));
  ymax = Math.max(ymin + 20, Math.min(1000, ymax));
  xmax = Math.max(xmin + 20, Math.min(1000, xmax));

  return [ymin, xmin, ymax, xmax];
}

/**
 * Renders a specific page of a PDF to an offscreen canvas at high resolution.
 */
async function renderPdfPage(
  pdfDocument: pdfjsLib.PDFDocumentProxy,
  pageNumber: number,
  scale: number = RENDER_SCALE
): Promise<HTMLCanvasElement> {
  const boundedPage = Math.max(1, Math.min(pdfDocument.numPages, pageNumber));
  const page = await pdfDocument.getPage(boundedPage);

  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('Failed to get canvas 2D context');

  const renderContext = {
    canvasContext: context,
    viewport,
    canvas,
  };

  await page.render(renderContext as any).promise;
  return canvas;
}

/**
 * Stitches two canvases vertically (top then bottom).
 * Used for diagrams that span across a page boundary.
 */
function stitchCanvasesVertically(
  topCanvas: HTMLCanvasElement,
  bottomCanvas: HTMLCanvasElement
): HTMLCanvasElement {
  const stitched = document.createElement('canvas');
  stitched.width = Math.max(topCanvas.width, bottomCanvas.width);
  stitched.height = topCanvas.height + bottomCanvas.height;

  const ctx = stitched.getContext('2d');
  if (!ctx) throw new Error('Failed to get stitch canvas context');

  ctx.drawImage(topCanvas, 0, 0);
  ctx.drawImage(bottomCanvas, 0, topCanvas.height);

  return stitched;
}

/**
 * Scans a strip along each edge of the cropped image to detect non-white pixels.
 * Returns which edges contain content and should be expanded.
 */
function detectContentAtEdges(
  canvas: HTMLCanvasElement
): { top: boolean; right: boolean; bottom: boolean; left: boolean } {
  const ctx = canvas.getContext('2d');
  if (!ctx) return { top: false, right: false, bottom: false, left: false };

  const { width, height } = canvas;
  const stripW = Math.max(1, Math.round(width * EDGE_SCAN_STRIP));
  const stripH = Math.max(1, Math.round(height * EDGE_SCAN_STRIP));

  const hasContentInRegion = (
    rx: number, ry: number, rw: number, rh: number
  ): boolean => {
    // Clamp to valid canvas region
    const sx = Math.max(0, Math.round(rx));
    const sy = Math.max(0, Math.round(ry));
    const sw = Math.min(width - sx, Math.max(1, Math.round(rw)));
    const sh = Math.min(height - sy, Math.max(1, Math.round(rh)));

    if (sw <= 0 || sh <= 0) return false;

    let imageData: ImageData;
    try {
      imageData = ctx.getImageData(sx, sy, sw, sh);
    } catch {
      return false;
    }
    const data = imageData.data;

    // Sample every 4th pixel for performance on large images
    const step = Math.max(1, Math.floor(data.length / (4 * 2000))) * 4;
    for (let i = 0; i < data.length; i += step) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];

      // Skip fully transparent pixels
      if (a < 10) continue;

      // Check if pixel is dark enough to be "content"
      const brightness = (r + g + b) / 3;
      if (brightness < CONTENT_BRIGHTNESS_THRESHOLD) {
        return true;
      }
    }
    return false;
  };

  return {
    top: hasContentInRegion(0, 0, width, stripH),
    bottom: hasContentInRegion(0, height - stripH, width, stripH),
    left: hasContentInRegion(0, 0, stripW, height),
    right: hasContentInRegion(width - stripW, 0, stripW, height),
  };
}

/**
 * Detects whether a horizontal strip of the source canvas contains a
 * bold question number in the left margin — indicating the start of a
 * new exam question. Used to prevent the iterative edge expansion from
 * overshooting past the current question's diagram into the next question.
 *
 * Exam papers always place question numbers (e.g. "17", "3") as bold text
 * in the leftmost ~12% of the page. Bold numbers create a dense cluster of
 * dark pixels in that margin strip, whereas diagram lines that may drift
 * into the left edge are much sparser.
 *
 * @param sourceCanvas - The full rendered PDF page canvas
 * @param stripY - The y-pixel coordinate of the top of the strip to scan
 * @param stripHeight - The height of the strip in pixels
 * @returns true if a question number boundary is detected
 */
function detectQuestionBoundary(
  sourceCanvas: HTMLCanvasElement,
  stripY: number,
  stripHeight: number
): boolean {
  const ctx = sourceCanvas.getContext('2d');
  if (!ctx) return false;

  const { width } = sourceCanvas;
  const marginWidth = Math.max(1, Math.round(width * LEFT_MARGIN_FRACTION));

  // Clamp to canvas bounds
  const sy = Math.max(0, Math.round(stripY));
  const sh = Math.min(sourceCanvas.height - sy, Math.max(1, Math.round(stripHeight)));
  const sw = Math.min(width - 0, marginWidth);

  if (sh <= 0 || sw <= 0) return false;

  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(0, sy, sw, sh);
  } catch {
    return false;
  }

  const data = imageData.data;
  let darkPixelCount = 0;

  // Sample every pixel row/col in the left margin
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 10) continue;

    const brightness = (data[i] + data[i + 1] + data[i + 2]) / 3;
    if (brightness < CONTENT_BRIGHTNESS_THRESHOLD) {
      darkPixelCount++;
    }
  }

  const totalPixels = sw * sh;
  const density = darkPixelCount / totalPixels;

  // Bold question numbers create a noticeable cluster of dark pixels in the margin (at least 40 dark pixels & 1.5% density)
  return darkPixelCount >= 40 && density >= 0.015;
}

/**
 * Trims excess whitespace around a cropped canvas while preserving a clean margin.
 */
function trimExcessWhitespace(
  canvas: HTMLCanvasElement,
  margin: number = 24
): HTMLCanvasElement {
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  const { width, height } = canvas;
  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(0, 0, width, height);
  } catch {
    return canvas;
  }

  const data = imageData.data;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  let hasContent = false;

  // Scan pixels (step 2 for speed on high-res)
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const idx = (y * width + x) * 4;
      const a = data[idx + 3];
      if (a < 10) continue;

      const brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      if (brightness < CONTENT_BRIGHTNESS_THRESHOLD) {
        hasContent = true;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (!hasContent) return canvas;

  // Add margin around detected content
  const trimX = Math.max(0, minX - margin);
  const trimY = Math.max(0, minY - margin);
  const trimW = Math.min(width - trimX, Math.max(MIN_CROP_WIDTH, maxX - minX + margin * 2));
  const trimH = Math.min(height - trimY, Math.max(MIN_CROP_HEIGHT, maxY - minY + margin * 2));

  // If trim doesn't meaningfully reduce space (>10px on any side), return original
  if (trimW >= width - 10 && trimH >= height - 10) {
    return canvas;
  }

  const trimmedCanvas = document.createElement('canvas');
  trimmedCanvas.width = trimW;
  trimmedCanvas.height = trimH;
  const trimmedCtx = trimmedCanvas.getContext('2d');
  if (!trimmedCtx) return canvas;

  trimmedCtx.drawImage(
    canvas,
    trimX, trimY, trimW, trimH,
    0, 0, trimW, trimH
  );

  return trimmedCanvas;
}

/**
 * Crops a region from a canvas using normalized bounding box coordinates (0-1000 scale).
 * Applies generous padding, minimum dimension enforcement, smart edge expansion,
 * and automatic question boundary trimming.
 * Returns a PNG Blob of the cropped region.
 */
function cropFromCanvas(
  sourceCanvas: HTMLCanvasElement,
  boundingBox: [number, number, number, number]
): Promise<Blob> {
  const [ymin, xmin, ymax, xmax] = boundingBox;
  const { width, height } = sourceCanvas;

  // Convert 0-1000 normalized coords to pixel coords
  const rawCropX = Math.round((xmin / 1000) * width);
  const rawCropY = Math.round((ymin / 1000) * height);
  const rawCropW = Math.round(((xmax - xmin) / 1000) * width);
  const rawCropH = Math.round(((ymax - ymin) / 1000) * height);

  // Add generous padding (15% of crop dimensions)
  const padX = Math.round(rawCropW * BASE_PADDING_FRACTION);
  const padY = Math.round(rawCropH * BASE_PADDING_FRACTION);

  let cropX = Math.max(0, rawCropX - padX);
  let cropY = Math.max(0, rawCropY - padY);
  let cropW = Math.min(width - cropX, Math.max(MIN_CROP_WIDTH, rawCropW + 2 * padX));
  let cropH = Math.min(height - cropY, Math.max(MIN_CROP_HEIGHT, rawCropH + 2 * padY));

  // ─── Initial crop for edge scanning ──────────────────────────────────
  const scanCanvas = document.createElement('canvas');
  scanCanvas.width = cropW;
  scanCanvas.height = cropH;
  const scanCtx = scanCanvas.getContext('2d');
  if (!scanCtx) throw new Error('Failed to get scan canvas context');

  scanCtx.drawImage(
    sourceCanvas,
    cropX, cropY, cropW, cropH,
    0, 0, cropW, cropH
  );

  // ─── Iterative smart edge expansion ──────────────────────────────────
  // Scan the border strips of the crop. If content (ink/lines) is detected
  // at any edge, expand that edge and re-scan. Repeat up to MAX_EXPANSION_PASSES
  // times. This handles cases where Gemini's box misses large portions
  // (e.g. bottom row of a 2×2 apparatus grid labeled A, B, C, D).
  //
  // QUESTION BOUNDARY GUARD: Before expanding vertically, check the area
  // we'd expand into for bold question numbers in the left margin (e.g. "17").
  // If a question number is detected, stop expanding in that direction —
  // we've reached the boundary between this question and the next.
  const MAX_EXPANSION_PASSES = 6;
  const EXPANSION_STEP = 0.15; // 15% of original crop dimensions per pass
  // Height of the strip to scan for question numbers (in pixels)
  const BOUNDARY_SCAN_HEIGHT = Math.max(16, Math.round(rawCropH * 0.06));

  for (let pass = 0; pass < MAX_EXPANSION_PASSES; pass++) {
    // Re-render the current crop region for scanning
    const iterCanvas = document.createElement('canvas');
    iterCanvas.width = cropW;
    iterCanvas.height = cropH;
    const iterCtx = iterCanvas.getContext('2d');
    if (!iterCtx) break;

    iterCtx.drawImage(
      sourceCanvas,
      cropX, cropY, cropW, cropH,
      0, 0, cropW, cropH
    );

    const contentEdges = detectContentAtEdges(iterCanvas);
    const expandX = Math.round(rawCropW * EXPANSION_STEP);
    const expandY = Math.round(rawCropH * EXPANSION_STEP);

    let expanded = false;

    // ── Top expansion (with question boundary guard) ───────────────
    if (contentEdges.top && cropY > 0) {
      const probeY = Math.max(0, cropY - expandY);
      const probeH = Math.max(1, BOUNDARY_SCAN_HEIGHT);
      const hitBoundary = detectQuestionBoundary(sourceCanvas, probeY, probeH);
      if (!hitBoundary) {
        const expansion = Math.min(cropY, expandY);
        cropY -= expansion;
        cropH += expansion;
        expanded = true;
      }
    }

    // ── Bottom expansion (with question boundary guard) ────────────
    if (contentEdges.bottom && (cropY + cropH) < height) {
      const probeY = cropY + cropH;
      const probeH = Math.max(1, BOUNDARY_SCAN_HEIGHT);
      const hitBoundary = detectQuestionBoundary(sourceCanvas, probeY, probeH);
      if (!hitBoundary) {
        const expansion = Math.min(height - cropY - cropH, expandY);
        cropH += expansion;
        expanded = true;
      }
    }

    // ── Left expansion (no boundary guard needed) ─────────────────
    if (contentEdges.left && cropX > 0) {
      const expansion = Math.min(cropX, expandX);
      cropX -= expansion;
      cropW += expansion;
      expanded = true;
    }

    // ── Right expansion (no boundary guard needed) ────────────────
    if (contentEdges.right && (cropX + cropW) < width) {
      const expansion = Math.min(width - cropX - cropW, expandX);
      cropW += expansion;
      expanded = true;
    }

    // If no edge had content, the crop is clean — stop expanding
    if (!expanded) break;
  }

  // ─── Post-expansion boundary trim (prevents overshoot into next question) ──
  // Scan the bottom 35% of the crop region upward in small steps. If a bold
  // question number (e.g. "17") is already inside the bottom of the crop,
  // trim cropH back to cut cleanly above the question number.
  const bottomScanDepth = Math.round(cropH * 0.35);
  const scanStep = 8;
  const scanSliceH = 14;

  for (let offset = 0; offset < bottomScanDepth; offset += scanStep) {
    const testY = cropY + cropH - offset - scanSliceH;
    if (testY <= cropY) break;
    if (detectQuestionBoundary(sourceCanvas, testY, scanSliceH)) {
      // Detected a question number starting around testY; trim cropH to just above it
      const newH = Math.max(MIN_CROP_HEIGHT, testY - cropY - 12);
      if (newH < cropH) {
        cropH = newH;
        break;
      }
    }
  }

  // ─── Final clamp and minimum size enforcement ───────────────────────
  cropX = Math.max(0, cropX);
  cropY = Math.max(0, cropY);
  cropW = Math.min(width - cropX, Math.max(MIN_CROP_WIDTH, cropW));
  cropH = Math.min(height - cropY, Math.max(MIN_CROP_HEIGHT, cropH));

  // ─── Initial crop canvas ────────────────────────────────────────────
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = cropW;
  cropCanvas.height = cropH;

  const ctx = cropCanvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get crop canvas context');

  ctx.drawImage(
    sourceCanvas,
    cropX, cropY, cropW, cropH,
    0, 0, cropW, cropH
  );

  // ─── Trim excess outer whitespace while preserving comfortable margin ─
  const finalCanvas = trimExcessWhitespace(cropCanvas, 24);

  return new Promise((resolve, reject) => {
    // Try WebP first for 70-80% smaller file size and 4x-5x higher storage capacity
    finalCanvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          // Fallback to PNG if WebP is unsupported
          finalCanvas.toBlob(
            (pngBlob) => {
              if (pngBlob) resolve(pngBlob);
              else reject(new Error('Canvas toBlob returned null'));
            },
            'image/png',
            0.95
          );
        }
      },
      'image/webp',
      0.88
    );
  });
}

/**
 * Uploads a diagram image blob (WebP / PNG) to Supabase Storage `exam-diagrams` bucket.
 * Returns the public URL, or null if storage is unconfigured / fails.
 */
async function uploadToStorage(blob: Blob, fileName: string): Promise<string | null> {
  try {
    const isWebP = blob.type === 'image/webp';
    const ext = isWebP ? 'webp' : 'png';
    const contentType = isWebP ? 'image/webp' : 'image/png';
    const path = `diagrams/${fileName}.${ext}`;

    const { error } = await supabase.storage
      .from('exam-diagrams')
      .upload(path, blob, {
        contentType,
        upsert: true,
      });

    if (error) {
      console.warn(`Supabase Storage upload note (${path}):`, error.message);
      return null;
    }

    const { data } = supabase.storage
      .from('exam-diagrams')
      .getPublicUrl(path);

    return data?.publicUrl || null;
  } catch (err: any) {
    console.warn('Storage upload error:', err?.message);
    return null;
  }
}

// ─── Public Interface ──────────────────────────────────────────────────────────

export interface QuestionWithDiagram {
  question_number: string;
  has_diagram: boolean;
  page_number?: number;
  bounding_box?: [number, number, number, number] | any | null;
}

export interface DiagramCropItem {
  blob: Blob;
  localUrl: string;
}

/**
 * Revokes all local Object URLs to free browser memory.
 */
export function revokeLocalDiagramUrls(
  diagramMap: Map<string, DiagramCropItem | string>
): void {
  for (const item of diagramMap.values()) {
    const url = typeof item === 'string' ? item : item.localUrl;
    if (url && url.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Uploads local diagram blobs to Supabase Storage `exam-diagrams` bucket.
 * Called ONLY when the user confirms saving to the database.
 * Returns a map of question_number → permanent Supabase Storage public URL.
 */
export async function uploadDiagramsToStorage(
  diagramMap: Map<string, DiagramCropItem>,
  paperInfo: { subject_code: string; year: number; paper_number: number },
  onProgress?: (status: string) => void
): Promise<Map<string, string>> {
  const publicUrls = new Map<string, string>();
  const total = diagramMap.size;
  let current = 0;

  for (const [qNum, item] of diagramMap.entries()) {
    current++;
    onProgress?.(`Uploading diagram ${current}/${total} to permanent storage…`);
    const safeName = `${paperInfo.subject_code}_${paperInfo.year}_p${paperInfo.paper_number}_${qNum.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}`;
    const publicUrl = await uploadToStorage(item.blob, safeName);
    if (publicUrl) {
      publicUrls.set(qNum, publicUrl);
    }
  }

  return publicUrls;
}

/**
 * Processes all diagram-bearing questions from an extraction result purely in-memory:
 * 1. Loads the PDF document
 * 2. Renders the target PDF page(s) at 4x resolution
 * 3. Handles multi-page stitching for diagrams near page boundaries
 * 4. Crops the bounding box region with generous padding + smart edge expansion
 * 5. Creates local Object URLs for instant, zero-upload UI preview
 * 
 * ZERO files are uploaded to Supabase Storage during this stage!
 */
export async function cropDiagramsLocally(
  pdfFile: File,
  questions: QuestionWithDiagram[],
  onProgress?: (status: string) => void
): Promise<Map<string, DiagramCropItem>> {
  const diagramQuestions = questions.filter((q) => q.has_diagram);

  if (diagramQuestions.length === 0) {
    onProgress?.('No diagrams detected.');
    return new Map();
  }

  onProgress?.(`Processing ${diagramQuestions.length} diagram(s) at high resolution…`);

  const results = new Map<string, DiagramCropItem>();

  try {
    const pdfBytes = await pdfFile.arrayBuffer();
    const pdfDocument = await pdfjsLib.getDocument({ data: pdfBytes }).promise;

    // Cache rendered pages (at 4x resolution)
    const pageCache = new Map<number, HTMLCanvasElement>();
    // Cache stitched page pairs for cross-boundary diagrams
    const stitchCache = new Map<string, HTMLCanvasElement>();

    for (let i = 0; i < diagramQuestions.length; i++) {
      const q = diagramQuestions[i];
      try {
        const targetPage = q.page_number && q.page_number > 0
          ? q.page_number
          : 1;

        // Render the primary page
        if (!pageCache.has(targetPage)) {
          onProgress?.(`Rendering PDF page ${targetPage} at ${RENDER_SCALE}x resolution…`);
          const canvas = await renderPdfPage(pdfDocument, targetPage);
          pageCache.set(targetPage, canvas);
        }

        const normalizedBox = normalizeBoundingBox(q.bounding_box);
        const [, , ymax] = normalizedBox;

        // ─── Multi-page stitching ──────────────────────────────────────
        // If the diagram's bottom edge is near the page boundary AND there's
        // a next page, stitch both pages vertically to capture cross-boundary content.
        const needsStitch =
          ymax >= (1000 - PAGE_BOUNDARY_THRESHOLD) &&
          targetPage < pdfDocument.numPages;

        let sourceCanvas: HTMLCanvasElement;

        if (needsStitch) {
          const stitchKey = `${targetPage}-${targetPage + 1}`;
          if (!stitchCache.has(stitchKey)) {
            onProgress?.(`Stitching pages ${targetPage}–${targetPage + 1} for cross-boundary diagram…`);

            // Render next page
            const nextPage = targetPage + 1;
            if (!pageCache.has(nextPage)) {
              const nextCanvas = await renderPdfPage(pdfDocument, nextPage);
              pageCache.set(nextPage, nextCanvas);
            }

            const topCanvas = pageCache.get(targetPage)!;
            const bottomCanvas = pageCache.get(nextPage)!;
            const stitched = stitchCanvasesVertically(topCanvas, bottomCanvas);
            stitchCache.set(stitchKey, stitched);
          }

          sourceCanvas = stitchCache.get(stitchKey)!;

          // Adjust bounding box for stitched canvas
          const topPageCanvas = pageCache.get(targetPage)!;
          const stitchedHeight = sourceCanvas.height;
          const topPageFraction = topPageCanvas.height / stitchedHeight;

          normalizedBox[0] = normalizedBox[0] * topPageFraction;
          normalizedBox[2] = Math.min(1000, normalizedBox[2] * topPageFraction + 150 * (1 - topPageFraction));
        } else {
          sourceCanvas = pageCache.get(targetPage)!;
        }

        onProgress?.(`Cropping diagram for Q${q.question_number}…`);
        const blob = await cropFromCanvas(sourceCanvas, normalizedBox);

        // Create local object URL for instant UI preview (zero network / storage)
        const localUrl = URL.createObjectURL(blob);
        results.set(q.question_number, { blob, localUrl });
      } catch (cropErr) {
        console.warn(`Failed to crop diagram for Q${q.question_number}:`, cropErr);
      }
    }

    onProgress?.(`Prepared ${results.size}/${diagramQuestions.length} diagrams locally.`);
  } catch (pdfErr) {
    console.error('Failed to load PDF for diagram cropping:', pdfErr);
  }

  return results;
}

/**
 * Backward compatibility wrapper if needed.
 */
export async function cropAndUploadDiagrams(
  pdfFile: File,
  questions: QuestionWithDiagram[],
  paperInfo: { subject_code: string; year: number; paper_number: number },
  onProgress?: (status: string) => void
): Promise<Map<string, string>> {
  const localMap = await cropDiagramsLocally(pdfFile, questions, onProgress);
  const publicUrls = await uploadDiagramsToStorage(localMap, paperInfo, onProgress);
  return publicUrls;
}

/**
 * Gets total page count of a PDF document
 */
export async function getPdfPageCount(pdfSource: File | ArrayBuffer): Promise<number> {
  const data = pdfSource instanceof File ? await pdfSource.arrayBuffer() : pdfSource;
  const pdfDocument = await pdfjsLib.getDocument({ data }).promise;
  return pdfDocument.numPages;
}

/**
 * Renders a specific page of a PDF document to an HTMLCanvasElement for interactive viewing or fine-tuning
 */
export async function renderPdfPageToCanvas(
  pdfSource: File | ArrayBuffer,
  pageNumber: number,
  scale: number = 2.5
): Promise<HTMLCanvasElement> {
  const data = pdfSource instanceof File ? await pdfSource.arrayBuffer() : pdfSource;
  const pdfDocument = await pdfjsLib.getDocument({ data }).promise;
  return renderPdfPage(pdfDocument, pageNumber, scale);
}

/**
 * Interactive fine-tuning crop of a bounding box [ymin, xmin, ymax, xmax] from a canvas
 */
export async function cropCanvasRegion(
  canvas: HTMLCanvasElement,
  box: [number, number, number, number]
): Promise<{ blob: Blob; localUrl: string }> {
  return cropExactCanvasRegion(canvas, box);
}

/**
 * Crops the exact user-defined bounding box from a canvas without automatic padding shifts
 */
export async function cropExactCanvasRegion(
  canvas: HTMLCanvasElement,
  box: [number, number, number, number]
): Promise<{ blob: Blob; localUrl: string }> {
  const [ymin, xmin, ymax, xmax] = normalizeBoundingBox(box);
  const { width, height } = canvas;

  const cropX = Math.max(0, Math.round((xmin / 1000) * width));
  const cropY = Math.max(0, Math.round((ymin / 1000) * height));
  const cropW = Math.min(width - cropX, Math.max(20, Math.round(((xmax - xmin) / 1000) * width)));
  const cropH = Math.min(height - cropY, Math.max(20, Math.round(((ymax - ymin) / 1000) * height)));

  const outCanvas = document.createElement('canvas');
  outCanvas.width = cropW;
  outCanvas.height = cropH;
  const ctx = outCanvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get crop canvas context');

  ctx.drawImage(canvas, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

  // Convert to WebP or PNG blob
  const blob: Blob = await new Promise((resolve, reject) => {
    outCanvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else {
          outCanvas.toBlob((png) => {
            if (png) resolve(png);
            else reject(new Error('Failed to create blob'));
          }, 'image/png');
        }
      },
      'image/webp',
      0.92
    );
  });

  const localUrl = URL.createObjectURL(blob);
  return { blob, localUrl };
}

/**
 * Uploads a single diagram Blob directly to Supabase Storage and returns the public URL
 */
export async function uploadSingleDiagramBlob(
  blob: Blob,
  pathInfo: { subject_code?: string; year?: number; paper_number?: number; question_number: string }
): Promise<string | null> {
  const { subject_code = 'GEN', year = new Date().getFullYear(), paper_number = 1, question_number } = pathInfo;
  const sanitizedQ = question_number.replace(/[^a-zA-Z0-9_-]/g, '_');
  const fileName = `${subject_code}_${year}_p${paper_number}_q${sanitizedQ}_${Date.now()}`;
  return uploadToStorage(blob, fileName);
}
