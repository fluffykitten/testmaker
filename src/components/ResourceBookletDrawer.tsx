import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { Question } from '../types/database';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import { exportInsertBookletDocx } from '../services/docxExportService';
import { openInsertBookletPrintWindow } from '../services/pdfExportService';
import './ResourceBookletDrawer.css';

export interface ResourceBookletItem {
  id: string;             // e.g. "Fig. 1.1", "Photograph A", "Table 2.1"
  title: string;          // e.g. "Settlement hierarchy in Country X"
  imageUrl?: string | null;
  textContent?: string | null;
  pageNumber?: number;
  targetQuestions?: string[];
}

interface ResourceBookletDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  subject?: string;
  resources?: ResourceBookletItem[];
  questions?: Question[];
  activeResourceRef?: string | null;
}

/**
 * Interactive Resource Booklet Drawer for Geography, History, Economics, and Social Sciences:
 * - Slide-out / floating modal with high-resolution pan, zoom, and fit controls
 * - Quick jump navigation tabs to immediately focus on the active question's figure
 * - Full support for topographic contour maps, aerial photos, synoptic charts, and case study texts
 */
export function ResourceBookletDrawer({
  isOpen,
  onClose,
  title = 'Cambridge IGCSE Insert / Resource Booklet',
  subject = 'Geography',
  resources = [],
  questions = [],
  activeResourceRef,
}: ResourceBookletDrawerProps) {
  // Aggregate all available booklet resources from explicit resources and questions
  const aggregatedResources: ResourceBookletItem[] = (() => {
    const map = new Map<string, ResourceBookletItem>();

    // 1. Explicit insert resources
    resources.forEach((r) => {
      map.set(r.id, r);
    });

    // 2. Derive resources from questions with resource_ref or insert diagrams
    questions.forEach((q, idx) => {
      const qRef = q.resource_ref || `Resource Q${q.question_number || idx + 1}`;
      const img = q.diagram_url;

      if (q.resource_ref || q.diagram_source === 'insert' || (img && !map.has(qRef))) {
        if (!map.has(qRef)) {
          map.set(qRef, {
            id: qRef,
            title: q.topic ? `${q.topic} (Q${q.question_number})` : `Resource for Question ${q.question_number}`,
            imageUrl: img,
            pageNumber: q.insert_page_number || (q as any).page_number,
            targetQuestions: [`Q${q.question_number}`],
          });
        }
      }

      // Check sub-questions
      (q.sub_questions || []).forEach((sub) => {
        if (sub.resource_ref || sub.diagram_url) {
          const subRef = sub.resource_ref || `${qRef} ${sub.sub_id}`;
          if (!map.has(subRef)) {
            map.set(subRef, {
              id: subRef,
              title: `${q.topic || 'Resource'} — ${sub.sub_id}`,
              imageUrl: sub.diagram_url || img,
              targetQuestions: [`Q${q.question_number} ${sub.sub_id}`],
            });
          }
        }
      });
    });

    return Array.from(map.values());
  })();

  // Active selected resource
  const [selectedId, setSelectedId] = useState<string>(() => {
    if (activeResourceRef && aggregatedResources.some((r) => r.id === activeResourceRef)) {
      return activeResourceRef;
    }
    return aggregatedResources[0]?.id || '';
  });

  // Zoom and pan state
  const [scale, setScale] = useState<number>(1);
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);

  // Sync active resource when prop changes
  useEffect(() => {
    if (activeResourceRef && aggregatedResources.some((r) => r.id === activeResourceRef)) {
      setSelectedId(activeResourceRef);
      handleResetZoom();
    }
  }, [activeResourceRef]);

  // Reset zoom on resource change
  const handleResetZoom = useCallback(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }, []);

  const handleSelectResource = (id: string) => {
    setSelectedId(id);
    handleResetZoom();
  };

  const handleZoomIn = () => setScale((s) => Math.min(4.0, s + 0.25));
  const handleZoomOut = () => setScale((s) => Math.max(0.5, s - 0.25));

  // Pan dragging handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (scale <= 1) return;
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX - position.x,
      y: e.clientY - position.y,
    };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDragging) return;
    setPosition({
      x: e.clientX - dragStartRef.current.x,
      y: e.clientY - dragStartRef.current.y,
    });
  };

  const handleMouseUp = () => setIsDragging(false);

  // Wheel zoom handler
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    if (e.deltaY < 0) {
      setScale((s) => Math.min(4.0, s + 0.15));
    } else {
      setScale((s) => Math.max(0.5, s - 0.15));
    }
  };

  const currentResource = aggregatedResources.find((r) => r.id === selectedId) || aggregatedResources[0];

  const backdropDismiss = useBackdropDismiss(onClose);

  if (!isOpen) return null;

  return createPortal(
    <div className="rbd-backdrop animate-fade-in" {...backdropDismiss}>
      <div className="rbd-card animate-scale-up" onClick={(e) => e.stopPropagation()}>
        {/* ─── Header ──────────────────────────────────────────────────────── */}
        <div className="rbd-header">
          <div className="rbd-header-left">
            <span className="rbd-booklet-icon">📖</span>
            <div>
              <div className="rbd-title-row">
                <h2 className="rbd-title">{title}</h2>
                <span className="rbd-subject-badge">{subject}</span>
              </div>
              <p className="rbd-subtitle">
                Study resources, maps, photographs, and tables referenced in the assessment questions.
              </p>
            </div>
          </div>
          <div className="rbd-header-actions" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              className="rbd-export-btn rbd-export-btn--docx"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 12px',
                background: '#2563eb',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
              onClick={() => exportInsertBookletDocx({ title, subject }, questions)}
              title="Download Insert as Word document (.docx)"
            >
              📥 Word (.docx)
            </button>
            <button
              type="button"
              className="rbd-export-btn rbd-export-btn--pdf"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '6px 12px',
                background: '#f1f5f9',
                color: '#334155',
                border: '1px solid #cbd5e1',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
              onClick={() => openInsertBookletPrintWindow({ title, subject }, questions)}
              title="Print or Save Insert as PDF"
            >
              🖨️ Print PDF
            </button>
            <button type="button" className="rbd-btn-close" onClick={onClose} title="Close Booklet (Esc)">
              ✕
            </button>
          </div>
        </div>

        {/* ─── Resource Selector Strip ─────────────────────────────────────── */}
        {aggregatedResources.length > 0 && (
          <div className="rbd-nav-strip">
            <span className="rbd-nav-label">Resources ({aggregatedResources.length}):</span>
            <div className="rbd-nav-pills">
              {aggregatedResources.map((res) => {
                const isActive = res.id === currentResource?.id;
                return (
                  <button
                    key={res.id}
                    type="button"
                    className={`rbd-pill ${isActive ? 'rbd-pill--active' : ''}`}
                    onClick={() => handleSelectResource(res.id)}
                    title={res.title}
                  >
                    <span className="rbd-pill-id">{res.id}</span>
                    <span className="rbd-pill-title">{res.title}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ─── Main Viewer Body ────────────────────────────────────────────── */}
        <div className="rbd-body">
          {currentResource ? (
            <div className="rbd-viewer-container">
              {/* Resource Info Bar */}
              <div className="rbd-resource-bar">
                <div className="rbd-resource-meta">
                  <span className="rbd-res-tag">{currentResource.id}</span>
                  <span className="rbd-res-name">{currentResource.title}</span>
                  {currentResource.pageNumber && (
                    <span className="rbd-res-page">Page {currentResource.pageNumber}</span>
                  )}
                </div>

                {/* Pan / Zoom Control Tools */}
                <div className="rbd-toolbar">
                  <button
                    type="button"
                    className="rbd-tool-btn"
                    onClick={handleZoomOut}
                    title="Zoom Out (-)"
                    disabled={scale <= 0.5}
                  >
                    🔍−
                  </button>
                  <span className="rbd-zoom-level">{Math.round(scale * 100)}%</span>
                  <button
                    type="button"
                    className="rbd-tool-btn"
                    onClick={handleZoomIn}
                    title="Zoom In (+)"
                    disabled={scale >= 4.0}
                  >
                    🔍+
                  </button>
                  <button
                    type="button"
                    className="rbd-tool-btn rbd-tool-btn--reset"
                    onClick={handleResetZoom}
                    title="Reset Fit (100%)"
                  >
                    Fit
                  </button>
                </div>
              </div>

              {/* Interactive Zoomable Viewport */}
              <div
                ref={viewportRef}
                className={`rbd-viewport ${scale > 1 ? 'rbd-viewport--draggable' : ''} ${
                  isDragging ? 'rbd-viewport--dragging' : ''
                }`}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
                onWheel={handleWheel}
              >
                {currentResource.imageUrl ? (
                  <div
                    className="rbd-image-wrap"
                    style={{
                      transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
                      transformOrigin: 'center center',
                    }}
                  >
                    <img
                      src={currentResource.imageUrl}
                      alt={currentResource.title}
                      className="rbd-image"
                      draggable={false}
                    />
                  </div>
                ) : currentResource.textContent ? (
                  <div className="rbd-text-content">
                    <pre>{currentResource.textContent}</pre>
                  </div>
                ) : (
                  <div className="rbd-empty-state">
                    <span className="rbd-empty-icon">🗺️</span>
                    <p>No high-resolution figure available for this resource.</p>
                  </div>
                )}
              </div>

              {/* Navigation Hint */}
              <div className="rbd-footer-hint">
                <span>💡 Use scroll wheel or toolbar to zoom in. When zoomed, drag to pan across maps and photos.</span>
              </div>
            </div>
          ) : (
            <div className="rbd-no-resources">
              <span className="rbd-no-res-icon">📖</span>
              <h3>No Resources in Booklet</h3>
              <p>This exam paper does not contain any attached Insert figures or resource booklet sheets.</p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
