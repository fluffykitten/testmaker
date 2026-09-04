import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import {
  renderPdfPageToCanvas,
  getPdfPageCount,
  cropExactCanvasRegion,
} from '../lib/diagramCropper';
import './DiagramCropModal.css';

export interface DiagramCropResult {
  blob: Blob;
  localUrl: string;
  boundingBox: [number, number, number, number];
  pageNumber: number;
  sourceDoc?: 'qp' | 'insert';
}

interface DiagramCropModalProps {
  isOpen: boolean;
  pdfFile?: File | null;
  insertFile?: File | null;
  initialSourceType?: 'qp' | 'insert';
  imageSrc?: string | null;
  initialBoundingBox?: [number, number, number, number] | null;
  initialPageNumber?: number;
  initialQpPageNumber?: number;
  initialInsertPageNumber?: number;
  questionNumber?: string;
  onClose: () => void;
  onSaveCrop: (result: DiagramCropResult) => void;
}

type HandleType = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';

export function DiagramCropModal({
  isOpen,
  pdfFile: initialPdfFile,
  insertFile,
  initialSourceType = 'qp',
  imageSrc: initialImageSrc,
  initialBoundingBox,
  initialPageNumber = 1,
  initialQpPageNumber = 1,
  initialInsertPageNumber = 1,
  questionNumber = '1',
  onClose,
  onSaveCrop,
}: DiagramCropModalProps) {
  const [activeSourceType, setActiveSourceType] = useState<'qp' | 'insert'>(initialSourceType);
  const [activePdfFile, setActivePdfFile] = useState<File | null>(() => {
    if (initialSourceType === 'insert' && insertFile) return insertFile;
    return initialPdfFile || null;
  });
  const [activeImageSrc, setActiveImageSrc] = useState<string | null>(initialImageSrc || null);

  const [currentPage, setCurrentPage] = useState(() => {
    if (initialSourceType === 'insert') return initialInsertPageNumber || initialPageNumber || 1;
    return initialQpPageNumber || initialPageNumber || 1;
  });
  const [totalPages, setTotalPages] = useState(1);
  const [isLoadingContent, setIsLoadingContent] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Normalized Bounding Box: [ymin, xmin, ymax, xmax] on 0-1000 scale
  const [box, setBox] = useState<[number, number, number, number]>([150, 50, 600, 950]);

  const [sourceImgUrl, setSourceImgUrl] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [zoomLevel, setZoomLevel] = useState<number>(1);

  const containerRef = useRef<HTMLDivElement>(null);
  const internalSourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const filePickerRef = useRef<HTMLInputElement>(null);

  const isDraggingRef = useRef<{
    active: boolean;
    handle: HandleType;
    startX: number;
    startY: number;
    initialBox: [number, number, number, number];
    containerWidth: number;
    containerHeight: number;
  } | null>(null);

  // Sync props when opening or switching question
  useEffect(() => {
    if (!isOpen) return;
    const targetSource = (initialSourceType === 'insert' && insertFile) ? 'insert' : 'qp';
    setActiveSourceType(targetSource);
    const targetPdf = targetSource === 'insert' ? (insertFile || null) : (initialPdfFile || null);
    setActivePdfFile(targetPdf);
    setActiveImageSrc(initialImageSrc || null);
    
    const targetPage = targetSource === 'insert'
      ? (initialInsertPageNumber || initialPageNumber || 1)
      : (initialQpPageNumber || initialPageNumber || 1);
    setCurrentPage(targetPage);

    if (initialBoundingBox && Array.isArray(initialBoundingBox) && initialBoundingBox.length >= 4) {
      const [y1, x1, y2, x2] = initialBoundingBox.map(Number);
      setBox([
        Math.max(0, isNaN(y1) ? 150 : y1),
        Math.max(0, isNaN(x1) ? 50 : x1),
        Math.min(1000, isNaN(y2) ? 600 : y2),
        Math.min(1000, isNaN(x2) ? 950 : x2),
      ]);
    } else {
      setBox([150, 50, 600, 950]);
    }
  }, [
    isOpen,
    initialPdfFile,
    insertFile,
    initialSourceType,
    initialImageSrc,
    initialPageNumber,
    initialQpPageNumber,
    initialInsertPageNumber,
    initialBoundingBox,
  ]);

  // Read PDF total page count
  useEffect(() => {
    if (!isOpen || !activePdfFile) return;
    getPdfPageCount(activePdfFile)
      .then((count) => setTotalPages(count))
      .catch(() => setTotalPages(1));
  }, [isOpen, activePdfFile]);

  // Render content to offscreen canvas and create display URL
  const renderSourceContent = useCallback(async () => {
    setIsLoadingContent(true);
    setErrorMessage(null);

    try {
      if (activePdfFile) {
        // Render PDF page to high-res offscreen canvas
        const rendered = await renderPdfPageToCanvas(activePdfFile, currentPage, 2.5);
        internalSourceCanvasRef.current = rendered;

        // Create Blob URL for display image
        const blob = await new Promise<Blob>((resolve, reject) => {
          rendered.toBlob((b) => {
            if (b) resolve(b);
            else reject(new Error('Failed to create page image blob'));
          }, 'image/png');
        });

        const url = URL.createObjectURL(blob);
        setSourceImgUrl((prev) => {
          if (prev && prev.startsWith('blob:') && prev !== initialImageSrc) {
            URL.revokeObjectURL(prev);
          }
          return url;
        });
      } else if (activeImageSrc) {
        // Load image to memory canvas
        const img = new Image();
        img.crossOrigin = 'anonymous';

        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => {
            const fallbackImg = new Image();
            fallbackImg.onload = () => {
              img.width = fallbackImg.width;
              img.height = fallbackImg.height;
              resolve();
            };
            fallbackImg.onerror = () => reject(new Error('Failed to load image source.'));
            fallbackImg.src = activeImageSrc;
          };
          img.src = activeImageSrc;
        });

        const memCanvas = document.createElement('canvas');
        memCanvas.width = img.naturalWidth || img.width || 800;
        memCanvas.height = img.naturalHeight || img.height || 600;
        const memCtx = memCanvas.getContext('2d');
        if (memCtx) memCtx.drawImage(img, 0, 0);
        internalSourceCanvasRef.current = memCanvas;
        setSourceImgUrl(activeImageSrc);
      } else {
        internalSourceCanvasRef.current = null;
        setSourceImgUrl(null);
      }
    } catch (err: any) {
      console.error('Failed to load crop content:', err);
      // Fallback: If PDF render failed but imageSrc exists, try imageSrc
      if (activePdfFile && activeImageSrc) {
        try {
          const img = new Image();
          await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = reject;
            img.src = activeImageSrc;
          });
          const memCanvas = document.createElement('canvas');
          memCanvas.width = img.naturalWidth || img.width || 800;
          memCanvas.height = img.naturalHeight || img.height || 600;
          const memCtx = memCanvas.getContext('2d');
          if (memCtx) memCtx.drawImage(img, 0, 0);
          internalSourceCanvasRef.current = memCanvas;
          setSourceImgUrl(activeImageSrc);
          setIsLoadingContent(false);
          return;
        } catch {
          // fall through
        }
      }
      setErrorMessage(err?.message || 'Failed to render PDF page or image');
    } finally {
      setIsLoadingContent(false);
    }
  }, [activePdfFile, activeImageSrc, currentPage, initialImageSrc]);

  useEffect(() => {
    if (isOpen) {
      renderSourceContent();
    }
  }, [isOpen, renderSourceContent]);

  // Update live preview crop
  const updateCropPreview = useCallback(async () => {
    if (!internalSourceCanvasRef.current) return;
    try {
      const { blob, localUrl } = await cropExactCanvasRegion(
        internalSourceCanvasRef.current,
        box
      );
      setPreviewBlob(blob);
      setPreviewUrl((prev) => {
        if (prev && prev.startsWith('blob:')) {
          URL.revokeObjectURL(prev);
        }
        return localUrl;
      });
    } catch (err) {
      console.warn('Crop preview update error:', err);
    }
  }, [box]);

  useEffect(() => {
    if (!isLoadingContent && internalSourceCanvasRef.current) {
      updateCropPreview();
    }
  }, [isLoadingContent, box, updateCropPreview]);

  // Pointer drag handles
  const handlePointerDown = (
    e: React.MouseEvent | React.TouchEvent,
    handle: HandleType
  ) => {
    e.preventDefault();
    e.stopPropagation();

    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();

    isDraggingRef.current = {
      active: true,
      handle,
      startX: clientX,
      startY: clientY,
      initialBox: [...box],
      containerWidth: rect.width,
      containerHeight: rect.height,
    };

    window.addEventListener('mousemove', handlePointerMove);
    window.addEventListener('mouseup', handlePointerUp);
    window.addEventListener('touchmove', handlePointerMove, { passive: false });
    window.addEventListener('touchend', handlePointerUp);
  };

  const handlePointerMove = useCallback((e: MouseEvent | TouchEvent) => {
    if (!isDraggingRef.current || !isDraggingRef.current.active) return;
    e.preventDefault();

    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    const { handle, startX, startY, initialBox, containerWidth, containerHeight } =
      isDraggingRef.current;

    const deltaX = ((clientX - startX) / containerWidth) * 1000;
    const deltaY = ((clientY - startY) / containerHeight) * 1000;

    let [ymin, xmin, ymax, xmax] = initialBox;
    const MIN_SIZE = 25;

    switch (handle) {
      case 'nw':
        ymin = Math.max(0, Math.min(initialBox[2] - MIN_SIZE, initialBox[0] + deltaY));
        xmin = Math.max(0, Math.min(initialBox[3] - MIN_SIZE, initialBox[1] + deltaX));
        break;
      case 'n':
        ymin = Math.max(0, Math.min(initialBox[2] - MIN_SIZE, initialBox[0] + deltaY));
        break;
      case 'ne':
        ymin = Math.max(0, Math.min(initialBox[2] - MIN_SIZE, initialBox[0] + deltaY));
        xmax = Math.min(1000, Math.max(initialBox[1] + MIN_SIZE, initialBox[3] + deltaX));
        break;
      case 'e':
        xmax = Math.min(1000, Math.max(initialBox[1] + MIN_SIZE, initialBox[3] + deltaX));
        break;
      case 'se':
        ymax = Math.min(1000, Math.max(initialBox[0] + MIN_SIZE, initialBox[2] + deltaY));
        xmax = Math.min(1000, Math.max(initialBox[1] + MIN_SIZE, initialBox[3] + deltaX));
        break;
      case 's':
        ymax = Math.min(1000, Math.max(initialBox[0] + MIN_SIZE, initialBox[2] + deltaY));
        break;
      case 'sw':
        ymax = Math.min(1000, Math.max(initialBox[0] + MIN_SIZE, initialBox[2] + deltaY));
        xmin = Math.max(0, Math.min(initialBox[3] - MIN_SIZE, initialBox[1] + deltaX));
        break;
      case 'w':
        xmin = Math.max(0, Math.min(initialBox[3] - MIN_SIZE, initialBox[1] + deltaX));
        break;
      case 'move': {
        const width = initialBox[3] - initialBox[1];
        const height = initialBox[2] - initialBox[0];

        let newXmin = initialBox[1] + deltaX;
        let newYmin = initialBox[0] + deltaY;

        if (newXmin < 0) newXmin = 0;
        if (newXmin + width > 1000) newXmin = 1000 - width;
        if (newYmin < 0) newYmin = 0;
        if (newYmin + height > 1000) newYmin = 1000 - height;

        xmin = newXmin;
        ymin = newYmin;
        xmax = newXmin + width;
        ymax = newYmin + height;
        break;
      }
    }

    setBox([Math.round(ymin), Math.round(xmin), Math.round(ymax), Math.round(xmax)]);
  }, []);

  const handlePointerUp = useCallback(() => {
    isDraggingRef.current = null;
    window.removeEventListener('mousemove', handlePointerMove);
    window.removeEventListener('mouseup', handlePointerUp);
    window.removeEventListener('touchmove', handlePointerMove);
    window.removeEventListener('touchend', handlePointerUp);
  }, [handlePointerMove]);

  // Preset adjustments
  const adjustPadding = (deltaPct: number) => {
    const [ymin, xmin, ymax, xmax] = box;
    const w = xmax - xmin;
    const h = ymax - ymin;
    const dw = (w * deltaPct) / 2;
    const dh = (h * deltaPct) / 2;

    setBox([
      Math.max(0, Math.round(ymin - dh)),
      Math.max(0, Math.round(xmin - dw)),
      Math.min(1000, Math.round(ymax + dh)),
      Math.min(1000, Math.round(xmax + dw)),
    ]);
  };

  const expandFullWidth = () => {
    setBox(([ymin, , ymax]) => [ymin, 20, ymax, 980]);
  };

  const resetCrop = () => {
    if (initialBoundingBox && initialBoundingBox.length >= 4) {
      setBox([...initialBoundingBox]);
    } else {
      setBox([150, 50, 600, 950]);
    }
  };

  const handleSelectFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type === 'application/pdf') {
      setActivePdfFile(file);
      setActiveImageSrc(null);
      setCurrentPage(1);
    } else {
      const url = URL.createObjectURL(file);
      setActiveImageSrc(url);
      setActivePdfFile(null);
    }
    e.target.value = '';
  };

  const handleSave = () => {
    if (!previewBlob || !previewUrl) return;
    onSaveCrop({
      blob: previewBlob,
      localUrl: previewUrl,
      boundingBox: box,
      pageNumber: currentPage,
      sourceDoc: activeSourceType,
    });
    onClose();
  };

  const backdropDismiss = useBackdropDismiss(onClose);

  if (!isOpen) return null;

  const topPct = (box[0] / 10).toFixed(2);
  const leftPct = (box[1] / 10).toFixed(2);
  const heightPct = ((box[2] - box[0]) / 10).toFixed(2);
  const widthPct = ((box[3] - box[1]) / 10).toFixed(2);

  const hasSource = !!(activePdfFile || activeImageSrc || sourceImgUrl);

  return createPortal(
    <div className="crop-modal-backdrop animate-fade-in" {...backdropDismiss}>
      <div
        className="crop-modal-card animate-scale-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ─── Modal Header ───────────────────────────────────────────────── */}
        <div className="crop-modal-header">
          <div className="crop-modal-header-left">
            <span className="crop-modal-icon">✂️</span>
            <div>
              <h3 className="crop-modal-title">
                Fine-Tune Diagram Crop {questionNumber ? `(Q${questionNumber})` : ''}
              </h3>
              <p className="crop-modal-subtitle">
                Drag handles to adjust bounding box and capture all labels, apparatus, and graphs with zero cutoff.
              </p>
            </div>
          </div>

          <div className="crop-modal-header-actions">
            <button
              type="button"
              className="crop-btn-primary crop-btn-header-save"
              onClick={handleSave}
              disabled={isLoadingContent || !previewBlob}
              title="Apply & Save Cropped Diagram"
            >
              ✓ Save Crop
            </button>
            <button
              type="button"
              className="crop-modal-close-btn"
              onClick={onClose}
              aria-label="Close modal"
            >
              ✕
            </button>
          </div>
        </div>

        {/* ─── Controls Toolbar ───────────────────────────────────────────── */}
        <div className="crop-modal-toolbar">
          {/* Document Source Switcher (QP vs Insert Booklet) */}
          {insertFile && initialPdfFile && (
            <div className="crop-toolbar-group" style={{ background: 'rgba(255, 255, 255, 0.05)', padding: '2px', borderRadius: '8px' }}>
              <button
                type="button"
                className="crop-btn-tool"
                style={{
                  background: activeSourceType === 'qp' ? '#6366f1' : 'transparent',
                  color: activeSourceType === 'qp' ? '#ffffff' : 'inherit',
                  fontWeight: 700,
                }}
                onClick={() => {
                  setActiveSourceType('qp');
                  setActivePdfFile(initialPdfFile);
                  setCurrentPage(initialQpPageNumber || 1);
                }}
              >
                📄 Question Paper
              </button>
              <button
                type="button"
                className="crop-btn-tool"
                style={{
                  background: activeSourceType === 'insert' ? '#0ea5e9' : 'transparent',
                  color: activeSourceType === 'insert' ? '#ffffff' : 'inherit',
                  fontWeight: 700,
                }}
                onClick={() => {
                  setActiveSourceType('insert');
                  setActivePdfFile(insertFile);
                  setCurrentPage(initialInsertPageNumber || 1);
                }}
              >
                📖 Insert Booklet
              </button>
            </div>
          )}

          {/* Page Selector (for PDFs) */}
          {activePdfFile && totalPages > 1 && (
            <div className="crop-toolbar-group">
              <span className="crop-toolbar-label">Page:</span>
              <button
                type="button"
                className="crop-btn-page"
                disabled={currentPage <= 1 || isLoadingContent}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                title="Previous page"
              >
                ◀
              </button>
              <select
                className="crop-page-select"
                value={currentPage}
                disabled={isLoadingContent}
                onChange={(e) => setCurrentPage(Number(e.target.value) || 1)}
                style={{
                  background: 'rgba(255, 255, 255, 0.08)',
                  color: '#ffffff',
                  border: '1px solid rgba(255, 255, 255, 0.15)',
                  borderRadius: '6px',
                  padding: '2px 8px',
                  fontWeight: 600,
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                }}
              >
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                  <option key={p} value={p} style={{ background: '#1e293b', color: '#ffffff' }}>
                    Page {p} of {totalPages}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="crop-btn-page"
                disabled={currentPage >= totalPages || isLoadingContent}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                title="Next page"
              >
                ▶
              </button>
            </div>
          )}

          {/* Quick Presets */}
          {hasSource && (
            <div className="crop-toolbar-group">
              <span className="crop-toolbar-label">Quick Adjust:</span>
              <button
                type="button"
                className="crop-btn-tool"
                onClick={() => adjustPadding(0.1)}
                title="Expand box by 10% in all directions"
              >
                +10% Padding
              </button>
              <button
                type="button"
                className="crop-btn-tool"
                onClick={() => adjustPadding(-0.1)}
                title="Shrink box by 10%"
              >
                -10% Padding
              </button>
              <button
                type="button"
                className="crop-btn-tool"
                onClick={expandFullWidth}
                title="Expand horizontally across entire page"
              >
                Full Width
              </button>
              <button
                type="button"
                className="crop-btn-tool"
                onClick={resetCrop}
                title="Reset box to initial boundary"
              >
                Reset
              </button>
            </div>
          )}

          {/* Change Source File */}
          <div className="crop-toolbar-group">
            <input
              type="file"
              ref={filePickerRef}
              accept="image/*,application/pdf"
              style={{ display: 'none' }}
              onChange={handleSelectFile}
            />
            <button
              type="button"
              className="crop-btn-tool"
              onClick={() => filePickerRef.current?.click()}
              title="Open a PDF past paper or image to crop"
            >
              📁 {hasSource ? 'Change Source PDF/Image' : 'Select PDF/Image'}
            </button>
          </div>

          {/* Zoom controls */}
          {hasSource && (
            <div className="crop-toolbar-group crop-toolbar-group--right">
              <span className="crop-toolbar-label">Zoom:</span>
              <button
                type="button"
                className="crop-btn-tool"
                onClick={() => setZoomLevel((z) => Math.max(0.6, z - 0.2))}
              >
                −
              </button>
              <span className="crop-zoom-label">{Math.round(zoomLevel * 100)}%</span>
              <button
                type="button"
                className="crop-btn-tool"
                onClick={() => setZoomLevel((z) => Math.min(2.5, z + 0.2))}
              >
                +
              </button>
              <button
                type="button"
                className="crop-btn-tool"
                onClick={() => setZoomLevel(1)}
              >
                Fit
              </button>
            </div>
          )}
        </div>

        {/* ─── Body Area: Interactive Workspace Left + Live Preview Right ─────── */}
        <div className="crop-modal-body">
          {/* Interactive Source Canvas Workspace */}
          <div className="crop-workspace-area">
            {!hasSource ? (
              <div className="crop-empty-state animate-fade-in">
                <span className="crop-empty-icon">📄</span>
                <h4>No Source PDF or Image Selected</h4>
                <p>Upload a past paper PDF or diagram image to visually crop and fine-tune boundaries.</p>
                <button
                  type="button"
                  className="crop-btn-primary"
                  onClick={() => filePickerRef.current?.click()}
                >
                  📁 Select Past Paper PDF / Image
                </button>
              </div>
            ) : errorMessage ? (
              <div className="crop-error-state">
                <span>⚠️</span>
                <p>{errorMessage}</p>
                <button
                  type="button"
                  className="crop-btn-tool"
                  onClick={() => filePickerRef.current?.click()}
                >
                  Choose Another File
                </button>
              </div>
            ) : (
              <div
                className="crop-canvas-wrapper"
                style={{ transform: `scale(${zoomLevel})`, transformOrigin: 'top center' }}
              >
                {isLoadingContent && (
                  <div className="crop-loading-overlay animate-fade-in">
                    <span className="crop-loading-spinner" />
                    <p>Rendering source page…</p>
                  </div>
                )}

                {sourceImgUrl && (
                  <div ref={containerRef} className="crop-interactive-container">
                    {/* Rendered Source Page Image */}
                    <img
                      src={sourceImgUrl}
                      alt={`Source page ${currentPage}`}
                      className="crop-source-image"
                      draggable={false}
                    />

                    {/* Dark Shade Overlays outside bounding box */}
                    <div
                      className="crop-shade-box crop-shade-top"
                      style={{ height: `${topPct}%` }}
                    />
                    <div
                      className="crop-shade-box crop-shade-bottom"
                      style={{
                        top: `${(box[2] / 10).toFixed(2)}%`,
                        height: `${(100 - box[2] / 10).toFixed(2)}%`,
                      }}
                    />
                    <div
                      className="crop-shade-box crop-shade-left"
                      style={{ top: `${topPct}%`, height: `${heightPct}%`, width: `${leftPct}%` }}
                    />
                    <div
                      className="crop-shade-box crop-shade-right"
                      style={{
                        top: `${topPct}%`,
                        height: `${heightPct}%`,
                        left: `${(box[3] / 10).toFixed(2)}%`,
                        width: `${(100 - box[3] / 10).toFixed(2)}%`,
                      }}
                    />

                    {/* Active Crop Box with 8 Resizing Handles */}
                    <div
                      className="crop-selection-box"
                      style={{
                        top: `${topPct}%`,
                        left: `${leftPct}%`,
                        width: `${widthPct}%`,
                        height: `${heightPct}%`,
                      }}
                      onMouseDown={(e) => handlePointerDown(e, 'move')}
                      onTouchStart={(e) => handlePointerDown(e, 'move')}
                    >
                      {/* Grid rule of thirds lines */}
                      <div className="crop-grid-line crop-grid-h1" />
                      <div className="crop-grid-line crop-grid-h2" />
                      <div className="crop-grid-line crop-grid-v1" />
                      <div className="crop-grid-line crop-grid-v2" />

                      {/* 8 Resize Handles */}
                      <div
                        className="crop-handle crop-handle-nw"
                        onMouseDown={(e) => handlePointerDown(e, 'nw')}
                        onTouchStart={(e) => handlePointerDown(e, 'nw')}
                      />
                      <div
                        className="crop-handle crop-handle-n"
                        onMouseDown={(e) => handlePointerDown(e, 'n')}
                        onTouchStart={(e) => handlePointerDown(e, 'n')}
                      />
                      <div
                        className="crop-handle crop-handle-ne"
                        onMouseDown={(e) => handlePointerDown(e, 'ne')}
                        onTouchStart={(e) => handlePointerDown(e, 'ne')}
                      />
                      <div
                        className="crop-handle crop-handle-e"
                        onMouseDown={(e) => handlePointerDown(e, 'e')}
                        onTouchStart={(e) => handlePointerDown(e, 'e')}
                      />
                      <div
                        className="crop-handle crop-handle-se"
                        onMouseDown={(e) => handlePointerDown(e, 'se')}
                        onTouchStart={(e) => handlePointerDown(e, 'se')}
                      />
                      <div
                        className="crop-handle crop-handle-s"
                        onMouseDown={(e) => handlePointerDown(e, 's')}
                        onTouchStart={(e) => handlePointerDown(e, 's')}
                      />
                      <div
                        className="crop-handle crop-handle-sw"
                        onMouseDown={(e) => handlePointerDown(e, 'sw')}
                        onTouchStart={(e) => handlePointerDown(e, 'sw')}
                      />
                      <div
                        className="crop-handle crop-handle-w"
                        onMouseDown={(e) => handlePointerDown(e, 'w')}
                        onTouchStart={(e) => handlePointerDown(e, 'w')}
                      />

                      {/* Drag Move Prompt Tag */}
                      <span className="crop-box-tag">Drag center to move</span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Live Preview Sidebar */}
          <div className="crop-preview-sidebar">
            <div className="crop-preview-header">
              <span className="crop-preview-title">Live Result Preview</span>
              <span className="crop-dimensions-badge">
                {box[3] - box[1]} × {box[2] - box[0]} pts
              </span>
            </div>

            <div className="crop-preview-card">
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt="Cropped preview"
                  className="crop-preview-img"
                />
              ) : (
                <div className="crop-preview-empty">
                  <span>🖼️</span>
                  <p>Crop preview will appear here</p>
                </div>
              )}
            </div>

            <div className="crop-preview-tips">
              <p className="crop-tip-title">💡 Cropping Tips:</p>
              <ul className="crop-tip-list">
                <li>Include 10–15px margin around apparatus, circuits, and graph axes.</li>
                <li>Capture figure labels (e.g. <em>Fig. 1.1</em>) if referenced in question text.</li>
                <li>You can zoom in or switch PDF pages using the toolbar above.</li>
              </ul>
            </div>
          </div>
        </div>

        {/* ─── Modal Footer ───────────────────────────────────────────────── */}
        <div className="crop-modal-footer">
          <div className="crop-footer-left">
            <span className="crop-box-coords">
              Bounds: [{box[0]}, {box[1]}, {box[2]}, {box[3]}] • Page {currentPage}
            </span>
          </div>

          <div className="crop-footer-right">
            <button
              type="button"
              className="crop-btn-secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="button"
              className="crop-btn-primary"
              onClick={handleSave}
              disabled={isLoadingContent || !previewBlob}
            >
              ✓ Apply & Save Cropped Diagram
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
