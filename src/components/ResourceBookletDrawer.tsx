import { useState, useRef, useEffect, useCallback, useMemo, useId } from 'react';
import { createPortal } from 'react-dom';
import type { InsertResourceItem, Question } from '../types/database';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import {
  buildBookletResources,
  findMatchingBookletResource,
  type ResourceBookletItem,
} from '../utils/resourceBookletUtils';
import './ResourceBookletDrawer.css';

export type { ResourceBookletItem };

interface ResourceBookletDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  subject?: string;
  resources?: Array<ResourceBookletItem | InsertResourceItem>;
  questions?: Question[];
  activeResourceRef?: string | null;
}

/**
 * Interactive Resource Booklet Drawer for Geography, History, Economics, Practicals, and Social Sciences:
 * - Slide-out / floating modal with high-resolution pan, zoom, and reset fit controls
 * - Supports cropped diagram images, parametric SVGs, qualitative notes sheets, and text passages
 * - Quick jump navigation tabs synced to the active question or sub-question figure
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
  const titleId = useId();

  const aggregatedResources = useMemo(
    () => buildBookletResources({ resources, questions }),
    [resources, questions]
  );

  const [selectedId, setSelectedId] = useState<string>(() => {
    const matched = findMatchingBookletResource(aggregatedResources, activeResourceRef);
    return matched?.id || aggregatedResources[0]?.id || '';
  });

  // Zoom and pan state
  const [scale, setScale] = useState<number>(1);
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const dragStartRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);

  const handleResetZoom = useCallback(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
    setIsDragging(false);
  }, []);

  // Sync active resource when drawer opens or activeResourceRef / aggregatedResources updates
  useEffect(() => {
    if (!isOpen) return;
    if (activeResourceRef) {
      const matched = findMatchingBookletResource(aggregatedResources, activeResourceRef);
      if (matched) {
        setSelectedId(matched.id);
        handleResetZoom();
        return;
      }
    }
    if (!findMatchingBookletResource(aggregatedResources, selectedId) && aggregatedResources[0]) {
      setSelectedId(aggregatedResources[0].id);
      handleResetZoom();
    }
  }, [isOpen, activeResourceRef, aggregatedResources, selectedId, handleResetZoom]);

  // Close drawer on Escape key (R-32 Keyboard Accessibility)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [isOpen, onClose]);

  const currentResource =
    findMatchingBookletResource(aggregatedResources, selectedId) || aggregatedResources[0];

  const hasVisualMedia = Boolean(currentResource?.imageUrl || currentResource?.svgContent);

  // Attach non-passive wheel listener when viewing visual media so scrolling zooms cleanly without console warnings
  useEffect(() => {
    const el = viewportRef.current;
    if (!isOpen || !el || !hasVisualMedia) return;

    const handleNativeWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY < 0) {
        setScale((s) => Math.min(4.0, +(s + 0.15).toFixed(2)));
      } else {
        setScale((s) => Math.max(0.5, +(s - 0.15).toFixed(2)));
      }
    };

    el.addEventListener('wheel', handleNativeWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleNativeWheel);
  }, [isOpen, hasVisualMedia, currentResource?.id]);

  const handleSelectResource = (id: string) => {
    setSelectedId(id);
    handleResetZoom();
  };

  const handleZoomIn = () => setScale((s) => Math.min(4.0, +(s + 0.25).toFixed(2)));
  const handleZoomOut = () => setScale((s) => Math.max(0.5, +(s - 0.25).toFixed(2)));

  // Pan dragging handlers
  const handleMouseDown = (e: React.MouseEvent) => {
    if (!hasVisualMedia || scale <= 1) return;
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

  const backdropDismiss = useBackdropDismiss(onClose);

  if (!isOpen) return null;

  return createPortal(
    <div className="rbd-backdrop animate-fade-in" {...backdropDismiss}>
      <div
        className="rbd-card animate-scale-up"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* Header */}
        <div className="rbd-header">
          <div className="rbd-header-left">
            <span className="rbd-booklet-icon" aria-hidden="true">📖</span>
            <div>
              <div className="rbd-title-row">
                <h2 id={titleId} className="rbd-title">{title}</h2>
                {subject && <span className="rbd-subject-badge">{subject}</span>}
              </div>
              <p className="rbd-subtitle">
                Reference figures, maps, photographs, notes, and tables linked to questions.
              </p>
            </div>
          </div>
          <div className="rbd-header-actions">
            <button
              type="button"
              className="rbd-btn-close"
              onClick={onClose}
              title="Close Booklet (Esc)"
              aria-label="Close Resource Booklet"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Resource Selector Strip */}
        {aggregatedResources.length > 0 && (
          <div className="rbd-nav-strip">
            <span className="rbd-nav-label">Resources ({aggregatedResources.length}):</span>
            <div className="rbd-nav-pills" role="tablist" aria-label="Booklet resources">
              {aggregatedResources.map((res) => {
                const isActive = res.id === currentResource?.id;
                return (
                  <button
                    key={res.id}
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    className={`rbd-pill ${isActive ? 'rbd-pill--active' : ''}`}
                    onClick={() => handleSelectResource(res.id)}
                    title={res.title}
                  >
                    <span className="rbd-pill-id">{res.id}</span>
                    {res.title && res.title !== res.id && (
                      <span className="rbd-pill-title">{res.title}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Main Viewer Body */}
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

                {/* Zoom / Reset Controls (only rendered for visual figures) */}
                {hasVisualMedia && (
                  <div className="rbd-toolbar" aria-label="Image zoom controls">
                    <button
                      type="button"
                      className="rbd-tool-btn"
                      onClick={handleZoomOut}
                      title="Zoom Out"
                      aria-label="Zoom Out"
                      disabled={scale <= 0.5}
                    >
                      −
                    </button>
                    <span className="rbd-zoom-level" aria-live="polite">
                      {Math.round(scale * 100)}%
                    </span>
                    <button
                      type="button"
                      className="rbd-tool-btn"
                      onClick={handleZoomIn}
                      title="Zoom In"
                      aria-label="Zoom In"
                      disabled={scale >= 4.0}
                    >
                      +
                    </button>
                    <button
                      type="button"
                      className="rbd-tool-btn rbd-tool-btn--reset"
                      onClick={handleResetZoom}
                      title="Reset Zoom (100%)"
                    >
                      Fit
                    </button>
                  </div>
                )}
              </div>

              {/* Interactive Viewport */}
              <div
                ref={viewportRef}
                className={`rbd-viewport ${hasVisualMedia && scale > 1 ? 'rbd-viewport--draggable' : ''} ${
                  isDragging ? 'rbd-viewport--dragging' : ''
                }`}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
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
                ) : currentResource.svgContent ? (
                  <div
                    className="rbd-image-wrap"
                    style={{
                      transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
                      transformOrigin: 'center center',
                    }}
                  >
                    <div
                      className="rbd-svg-wrap"
                      aria-label={currentResource.title}
                      dangerouslySetInnerHTML={{ __html: currentResource.svgContent }}
                    />
                  </div>
                ) : currentResource.textContent ? (
                  <div className="rbd-text-content">
                    <pre>{currentResource.textContent}</pre>
                  </div>
                ) : (
                  <div className="rbd-empty-state">
                    <p className="rbd-empty-title">No figure image or text attached</p>
                    <p className="rbd-empty-desc">
                      Resource "{currentResource.id}" is linked to a question, but no image or text payload was included.
                    </p>
                  </div>
                )}
              </div>

              {/* Supporting description / caption when both visual and text exist */}
              {hasVisualMedia && currentResource.textContent && (
                <div className="rbd-caption-bar">
                  {currentResource.textContent}
                </div>
              )}

              {/* Navigation Hint (only for zoomable figures) */}
              {hasVisualMedia && (
                <div className="rbd-footer-hint">
                  <span>Use scroll wheel or toolbar buttons to zoom. When zoomed in, drag to pan.</span>
                </div>
              )}
            </div>
          ) : (
            <div className="rbd-no-resources">
              <h3>No Resources in Booklet</h3>
              <p>This exam paper does not contain any linked insert figures, notes, or resource sheets.</p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
