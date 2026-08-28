import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import { renderPeriodicTableHtml, PERIODIC_TABLE_ELEMENTS } from '../services/periodicTableService';
import './PeriodicTableDrawer.css';

interface PeriodicTableDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

const ZOOM_PRESETS = [1.0, 1.25, 1.5, 1.75, 2.0];

export const PeriodicTableDrawer: React.FC<PeriodicTableDrawerProps> = ({ isOpen, onClose }) => {
  const [zoom, setZoom] = useState<number>(1.0);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');

  const backdropDismiss = useBackdropDismiss(onClose);

  const periodicTableHtml = useMemo(() => {
    return renderPeriodicTableHtml({ rotated: false });
  }, []);

  // Zoom actions
  const handleZoomIn = useCallback(() => {
    setZoom((prev) => Math.min(2.2, +(prev + 0.2).toFixed(2)));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((prev) => Math.max(0.7, +(prev - 0.2).toFixed(2)));
  }, []);

  const handleResetZoom = useCallback(() => {
    setZoom(1.0);
  }, []);

  // Keyboard zoom shortcuts (+ / - / 0 / f)
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }

      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        handleZoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        handleZoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        handleResetZoom();
      } else if (e.key === 'f' || e.key === 'F') {
        setIsFullscreen((prev) => !prev);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleZoomIn, handleZoomOut, handleResetZoom]);

  // Search element match
  const matchedElement = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return null;
    const all = Object.values(PERIODIC_TABLE_ELEMENTS);
    return (
      all.find((el) => el.sym.toLowerCase() === q) ||
      all.find((el) => String(el.num) === q) ||
      all.find((el) => el.name.toLowerCase() === q) ||
      all.find((el) => el.name.toLowerCase().startsWith(q)) ||
      null
    );
  }, [searchQuery]);

  if (!isOpen) return null;

  return (
    <div className="pt-drawer-backdrop animate-fade-in" {...backdropDismiss}>
      <div
        className={`pt-drawer-card animate-scale-up ${isFullscreen ? 'pt-drawer-card--fullscreen' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="pt-drawer-header">
          <div className="pt-drawer-title-wrap">
            <span className="pt-icon">🧪</span>
            <div>
              <h2 className="pt-title">Cambridge Chemistry Reference & Periodic Table</h2>
              <p className="pt-sub">Official IGCSE / GCE A-Level Periodic Table of Elements & Physical Constants</p>
            </div>
          </div>
          <div className="pt-header-actions">
            <button
              type="button"
              className={`pt-fullscreen-btn ${isFullscreen ? 'pt-btn-active' : ''}`}
              onClick={() => setIsFullscreen(!isFullscreen)}
              title={isFullscreen ? 'Exit Fullscreen' : 'Maximize Table (F)'}
            >
              {isFullscreen ? '⤦ Restore' : '⛶ Fullscreen'}
            </button>
            <button type="button" className="pt-close-btn" onClick={onClose} title="Close Reference Sheet (Esc)">
              ✕
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="pt-drawer-body">
          {/* Key Formula & Physical Constants Ribbon */}
          <div className="pt-constants-grid">
            <div className="pt-const-card">
              <span className="const-name">Molar Gas Volume (<i>V</i><sub>m</sub>)</span>
              <strong className="const-val">24.0 dm³/mol (at r.t.p.)</strong>
            </div>
            <div className="pt-const-card">
              <span className="const-name">Avogadro Constant (<i>L</i>)</span>
              <strong className="const-val">6.02 × 10²³ mol⁻¹</strong>
            </div>
            <div className="pt-const-card">
              <span className="const-name">Mole Calculations</span>
              <strong className="const-val"><i>n</i> = <i>m</i> / <i>M</i><sub>r</sub> &nbsp;•&nbsp; <i>n</i> = <i>c</i> × <i>V</i> (dm³)</strong>
            </div>
            <div className="pt-const-card">
              <span className="const-name">Standard Temperature & Pressure</span>
              <strong className="const-val">25 °C (298 K) &nbsp;•&nbsp; 1 atm (101 kPa)</strong>
            </div>
          </div>

          {/* Interactive Toolbar: Zoom Controls + Quick Element Search */}
          <div className="pt-toolbar">
            <div className="pt-zoom-controls">
              <span className="pt-toolbar-label">🔍 Zoom:</span>
              <button
                type="button"
                className="pt-tool-btn"
                onClick={handleZoomOut}
                disabled={zoom <= 0.7}
                title="Zoom Out (-)"
              >
                −
              </button>
              <button
                type="button"
                className="pt-zoom-display"
                onClick={handleResetZoom}
                title="Click to reset zoom (0)"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                type="button"
                className="pt-tool-btn"
                onClick={handleZoomIn}
                disabled={zoom >= 2.2}
                title="Zoom In (+)"
              >
                +
              </button>

              {/* Quick Preset Pills */}
              <div className="pt-zoom-presets">
                {ZOOM_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className={`pt-preset-pill ${Math.abs(zoom - preset) < 0.05 ? 'pt-preset-pill--active' : ''}`}
                    onClick={() => setZoom(preset)}
                  >
                    {Math.round(preset * 100)}%
                  </button>
                ))}
              </div>

              {zoom !== 1.0 && (
                <button
                  type="button"
                  className="pt-reset-btn"
                  onClick={handleResetZoom}
                  title="Reset zoom to 100%"
                >
                  ↺ Reset
                </button>
              )}
            </div>

            {/* Quick Element Search */}
            <div className="pt-search-wrap">
              <span className="pt-search-icon">🔎</span>
              <input
                type="text"
                className="pt-search-input"
                placeholder="Find element (e.g. Cl, Fe, 17, Copper)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
              {searchQuery && (
                <button
                  type="button"
                  className="pt-search-clear"
                  onClick={() => setSearchQuery('')}
                  title="Clear element search"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Highlighted Element Summary Card */}
          {matchedElement && (
            <div className="pt-element-badge animate-fade-in">
              <div className="pt-elem-symbol-box">
                <span className="pt-elem-num">{matchedElement.num}</span>
                <span className="pt-elem-sym">{matchedElement.sym}</span>
                <span className="pt-elem-mass">{matchedElement.mass}</span>
              </div>
              <div className="pt-elem-info">
                <strong className="pt-elem-name">{matchedElement.name.toUpperCase()}</strong>
                <span className="pt-elem-details">
                  Atomic Number: <strong>{matchedElement.num}</strong> • Relative Atomic Mass (<i>A</i><sub>r</sub>): <strong>{matchedElement.mass}</strong>
                </span>
              </div>
              <button
                type="button"
                className="pt-elem-dismiss"
                onClick={() => setSearchQuery('')}
                title="Dismiss element highlight"
              >
                ✕
              </button>
            </div>
          )}

          {/* Rendered Authentic Periodic Table with Zoom Container */}
          <div className="pt-table-scroll-container">
            <div
              className="pt-zoom-viewport"
              style={{
                zoom: zoom,
                minWidth: `${Math.round(800 * zoom)}px`,
              }}
            >
              <div
                className="pt-table-embed"
                dangerouslySetInnerHTML={{ __html: periodicTableHtml }}
              />
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="pt-drawer-footer">
          <span className="pt-footer-tip">
            💡 Tip: Use <strong>+</strong> / <strong>−</strong> keys to zoom, <strong>0</strong> to reset, or drag/scroll to pan.
          </span>
          <button type="button" className="sq-btn sq-btn-primary" onClick={onClose}>
            Done & Return to Exam
          </button>
        </div>
      </div>
    </div>
  );
};
