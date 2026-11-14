import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import * as pdfjsLib from 'pdfjs-dist';
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import type { ExamAttachment } from '../services/quizManagerService';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import './ExamAttachmentModal.css';

if (typeof window !== 'undefined' && pdfjsWorker) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;
}

interface PdfCanvasViewerProps {
  url: string;
  zoomLevel: number;
}

/**
 * Renders PDF attachments onto protected <canvas> pages via pdfjs-dist so the
 * browser's native PDF plugin (and its built-in Download / Print toolbar) is never exposed.
 */
const PdfCanvasViewer: React.FC<PdfCanvasViewerProps> = ({ url, zoomLevel }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [pageCount, setPageCount] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null;
    const abortCtrl = new AbortController();

    async function renderPdfPages() {
      const container = containerRef.current;
      if (!container) return;
      container.innerHTML = '';
      setLoading(true);
      setErrorMsg(null);
      setPageCount(0);

      try {
        const response = await fetch(url, { signal: abortCtrl.signal });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        if (cancelled) return;

        loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
        const pdfDoc = await loadingTask.promise;
        if (cancelled) {
          await loadingTask.destroy();
          return;
        }

        const total = pdfDoc.numPages;
        setPageCount(total);

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const cssScale = (zoomLevel / 100) * 1.25;

        for (let p = 1; p <= total; p++) {
          if (cancelled) break;
          const page = await pdfDoc.getPage(p);
          if (cancelled) break;

          const baseViewport = page.getViewport({ scale: cssScale });
          const renderViewport = page.getViewport({ scale: cssScale * dpr });

          const pageWrap = document.createElement('div');
          pageWrap.className = 'exam-att-pdf-page-wrap';

          const badge = document.createElement('div');
          badge.className = 'exam-att-pdf-page-badge';
          badge.textContent = `Page ${p} of ${total}`;

          const canvas = document.createElement('canvas');
          canvas.className = 'exam-att-pdf-canvas';
          canvas.width = Math.ceil(renderViewport.width);
          canvas.height = Math.ceil(renderViewport.height);
          canvas.style.width = `${Math.ceil(baseViewport.width)}px`;
          canvas.style.height = `${Math.ceil(baseViewport.height)}px`;
          canvas.oncontextmenu = (ev) => ev.preventDefault();

          const ctx = canvas.getContext('2d');
          if (ctx) {
            await page.render({ canvasContext: ctx, canvas, viewport: renderViewport }).promise;
          }

          pageWrap.appendChild(badge);
          pageWrap.appendChild(canvas);
          container.appendChild(pageWrap);
        }
      } catch (err: any) {
        if (!cancelled && err?.name !== 'AbortError') {
          console.error('Secure PDF attachment render error:', err);
          setErrorMsg('Unable to render PDF insert in secure viewer.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    renderPdfPages();

    return () => {
      cancelled = true;
      abortCtrl.abort();
      if (loadingTask) {
        loadingTask.destroy().catch(() => {});
      }
    };
  }, [url, zoomLevel]);

  return (
    <div
      className="exam-att-pdf-viewport"
      onContextMenu={(e) => e.preventDefault()}
    >
      {loading && (
        <div className="exam-att-pdf-status">
          ⏳ Rendering secure reference pages{pageCount > 0 ? ` (${pageCount} pages)` : ''}…
        </div>
      )}
      {errorMsg && (
        <div className="exam-att-pdf-status exam-att-pdf-status--error">
          ⚠️ {errorMsg}
        </div>
      )}
      <div ref={containerRef} className="exam-att-pdf-pages" />
    </div>
  );
};

interface ExamAttachmentModalProps {
  isOpen: boolean;
  onClose: () => void;
  attachments: ExamAttachment[];
  initialAttachmentId?: string;
}

export const ExamAttachmentModal: React.FC<ExamAttachmentModalProps> = ({
  isOpen,
  onClose,
  attachments,
  initialAttachmentId,
}) => {
  const backdropDismiss = useBackdropDismiss(onClose);
  const [selectedId, setSelectedId] = useState<string>(() => {
    return initialAttachmentId || attachments[0]?.id || '';
  });
  const [zoomLevel, setZoomLevel] = useState<number>(100);

  if (!isOpen || attachments.length === 0) return null;

  const currentAttachment =
    attachments.find((a) => a.id === selectedId) || attachments[0];

  const isPdf =
    currentAttachment.fileType === 'pdf' ||
    currentAttachment.name.toLowerCase().endsWith('.pdf') ||
    currentAttachment.url.toLowerCase().includes('.pdf');

  const isImage =
    currentAttachment.fileType === 'image' ||
    /\.(png|jpe?g|webp|gif|svg)$/i.test(currentAttachment.name) ||
    currentAttachment.url.startsWith('data:image/');

  return createPortal(
    <div className="exam-att-backdrop animate-fade-in" {...backdropDismiss}>
      <div
        className="exam-att-modal animate-scale-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="exam-att-header">
          <div className="exam-att-header-left">
            <span className="exam-att-header-icon">📎</span>
            <div>
              <h3 className="exam-att-title">
                {currentAttachment.name}
              </h3>
              <p className="exam-att-subtitle">
                Official Examination Reference Insert • Candidate View
              </p>
            </div>
          </div>

          <div className="exam-att-header-actions">
            {/* Zoom Controls for Images and Secure PDF Pages */}
            {(isImage || isPdf) && (
              <div className="exam-att-zoom-controls">
                <button
                  type="button"
                  className="exam-att-zoom-btn"
                  onClick={() => setZoomLevel((z) => Math.max(50, z - 25))}
                  title="Zoom Out"
                >
                  −
                </button>
                <span className="exam-att-zoom-level">{zoomLevel}%</span>
                <button
                  type="button"
                  className="exam-att-zoom-btn"
                  onClick={() => setZoomLevel((z) => Math.min(250, z + 25))}
                  title="Zoom In"
                >
                  +
                </button>
                <button
                  type="button"
                  className="exam-att-zoom-btn"
                  onClick={() => setZoomLevel(100)}
                  title="Reset Zoom"
                >
                  1:1
                </button>
              </div>
            )}

            <button
              type="button"
              className="exam-att-close-btn"
              onClick={onClose}
              title="Close Reference Material (Esc)"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Multi-Attachment Tabs (if more than 1 attachment) */}
        {attachments.length > 1 && (
          <div className="exam-att-tabs">
            {attachments.map((att) => (
              <button
                key={att.id}
                type="button"
                className={`exam-att-tab ${att.id === currentAttachment.id ? 'exam-att-tab--active' : ''}`}
                onClick={() => {
                  setSelectedId(att.id);
                  setZoomLevel(100);
                }}
              >
                <span>{att.fileType === 'pdf' ? '📄' : att.fileType === 'image' ? '🖼️' : '📝'}</span>
                <span className="exam-att-tab-name">{att.name}</span>
              </button>
            ))}
          </div>
        )}

        {/* Modal Content Viewer (No native browser PDF toolbar / download affordances) */}
        <div className="exam-att-content" onContextMenu={(e) => e.preventDefault()}>
          {isPdf ? (
            <PdfCanvasViewer url={currentAttachment.url} zoomLevel={zoomLevel} />
          ) : isImage ? (
            <div className="exam-att-img-viewport">
              <img
                src={currentAttachment.url}
                alt={currentAttachment.name}
                className="exam-att-img"
                draggable={false}
                onContextMenu={(e) => e.preventDefault()}
                style={{ transform: `scale(${zoomLevel / 100})` }}
              />
            </div>
          ) : (
            <div className="exam-att-fallback">
              <div className="exam-att-pdf-status">
                🔒 Preview is restricted for this attachment format ({currentAttachment.name}) during secure examination mode.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
