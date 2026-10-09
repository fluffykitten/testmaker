import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import './ExamScratchpadModal.css';

interface ExamScratchpadModalProps {
  isOpen: boolean;
  onClose: () => void;
  storageKey?: string;
}

export const ExamScratchpadModal: React.FC<ExamScratchpadModalProps> = ({
  isOpen,
  onClose,
  storageKey = 'exam_student_scratchpad',
}) => {
  const [activeTab, setActiveTab] = useState<'canvas' | 'text'>('canvas');
  const [textNotes, setTextNotes] = useState<string>(() => {
    try {
      return localStorage.getItem(`${storageKey}_notes`) || '';
    } catch {
      return '';
    }
  });

  const [color, setColor] = useState<string>('#24448c');
  const [isEraser, setIsEraser] = useState<boolean>(false);
  const [lineWidth, setLineWidth] = useState<number>(3);
  const [history, setHistory] = useState<ImageData[]>([]);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef<boolean>(false);
  const lastPosRef = useRef<{ x: number; y: number } | null>(null);

  const backdropDismiss = useBackdropDismiss(onClose);

  // Sync text notes to storage
  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setTextNotes(val);
    try {
      localStorage.setItem(`${storageKey}_notes`, val);
    } catch {
      // Storage unavailable
    }
  };

  // Resize canvas to match display size without losing content
  const initCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    if (canvas.width !== rect.width || canvas.height !== rect.height) {
      // Preserve existing image data if available
      let imgData: ImageData | null = null;
      if (canvas.width > 0 && canvas.height > 0) {
        try {
          imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        } catch {
          // ignore
        }
      }

      canvas.width = rect.width;
      canvas.height = rect.height;

      // Fill light background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (imgData) {
        ctx.putImageData(imgData, 0, 0);
      }
    }
  }, []);

  useEffect(() => {
    if (isOpen && activeTab === 'canvas') {
      const timer = setTimeout(initCanvas, 50);
      return () => clearTimeout(timer);
    }
  }, [isOpen, activeTab, initCanvas]);

  // Pointer event helpers for canvas
  const getCanvasCoords = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  const saveHistoryState = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    try {
      const state = ctx.getImageData(0, 0, canvas.width, canvas.height);
      setHistory((prev) => [...prev.slice(-15), state]);
    } catch {
      // ignore
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    isDrawingRef.current = true;
    saveHistoryState();
    const coords = getCanvasCoords(e);
    lastPosRef.current = coords;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.beginPath();
      ctx.arc(coords.x, coords.y, (isEraser ? lineWidth * 3 : lineWidth) / 2, 0, Math.PI * 2);
      ctx.fillStyle = isEraser ? '#ffffff' : color;
      ctx.fill();
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current || !lastPosRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const coords = getCanvasCoords(e);
    ctx.beginPath();
    ctx.moveTo(lastPosRef.current.x, lastPosRef.current.y);
    ctx.lineTo(coords.x, coords.y);
    ctx.strokeStyle = isEraser ? '#ffffff' : color;
    ctx.lineWidth = isEraser ? lineWidth * 4 : lineWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    lastPosRef.current = coords;
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    lastPosRef.current = null;
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const handleUndo = () => {
    if (history.length === 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const lastState = history[history.length - 1];
    setHistory((prev) => prev.slice(0, -1));
    ctx.putImageData(lastState, 0, 0);
  };

  const handleClearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    saveHistoryState();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  };

  if (!isOpen) return null;

  return createPortal(
    <div className="esp-modal-backdrop animate-fade-in" {...backdropDismiss}>
      <div className="esp-modal-card animate-scale-up" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="esp-header">
          <div className="esp-header-left">
            <span className="esp-header-icon">📝</span>
            <strong className="esp-header-title">Digital Scratchpad</strong>
            <div className="esp-tab-pill-group">
              <button
                type="button"
                className={`esp-tab-pill ${activeTab === 'canvas' ? 'active' : ''}`}
                onClick={() => setActiveTab('canvas')}
              >
                ✏️ Drawing Sheet
              </button>
              <button
                type="button"
                className={`esp-tab-pill ${activeTab === 'text' ? 'active' : ''}`}
                onClick={() => setActiveTab('text')}
              >
                📋 Rough Notes
              </button>
            </div>
          </div>
          <button type="button" className="esp-close-btn" onClick={onClose} title="Close Scratchpad">
            ✕
          </button>
        </div>

        {/* Scratchpad Content */}
        <div className="esp-body">
          {activeTab === 'canvas' ? (
            <div className="esp-canvas-container">
              {/* Canvas Toolbar */}
              <div className="esp-canvas-toolbar">
                <div className="esp-toolbar-colors">
                  {[
                    { c: '#24448c', label: 'ICM Blue' },
                    { c: '#10b981', label: 'ICM Green' },
                    { c: '#0f172a', label: 'Dark Slate' },
                    { c: '#dc2626', label: 'Red' },
                    { c: '#7c3aed', label: 'Purple' },
                  ].map(({ c, label }) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={label}
                      className={`esp-color-swatch ${color === c && !isEraser ? 'active' : ''}`}
                      style={{ background: c }}
                      onClick={() => {
                        setColor(c);
                        setIsEraser(false);
                      }}
                    />
                  ))}
                  <button
                    type="button"
                    className={`esp-tool-btn ${isEraser ? 'active' : ''}`}
                    onClick={() => setIsEraser((prev) => !prev)}
                    title="Eraser"
                  >
                    🧹 Eraser
                  </button>
                </div>

                <div className="esp-toolbar-sizes">
                  {[2, 4, 8].map((sz) => (
                    <button
                      key={sz}
                      type="button"
                      className={`esp-tool-btn ${lineWidth === sz && !isEraser ? 'active' : ''}`}
                      onClick={() => {
                        setLineWidth(sz);
                        setIsEraser(false);
                      }}
                      title={`Brush size ${sz}px`}
                    >
                      {sz === 2 ? 'Thin' : sz === 4 ? 'Medium' : 'Thick'}
                    </button>
                  ))}
                </div>

                <div className="esp-toolbar-actions">
                  <button
                    type="button"
                    className="esp-tool-btn"
                    onClick={handleUndo}
                    disabled={history.length === 0}
                    title="Undo stroke"
                  >
                    ↩ Undo
                  </button>
                  <button
                    type="button"
                    className="esp-tool-btn esp-tool-btn--danger"
                    onClick={handleClearCanvas}
                    title="Clear drawing board"
                  >
                    🗑 Clear
                  </button>
                </div>
              </div>

              {/* Canvas Element */}
              <div className="esp-canvas-wrapper">
                <canvas
                  ref={canvasRef}
                  className="esp-canvas"
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerUp}
                />
              </div>
            </div>
          ) : (
            <div className="esp-text-container">
              <textarea
                className="esp-textarea"
                placeholder="Use this rough sheet to write working steps, arithmetic formulas, or temporary notes..."
                value={textNotes}
                onChange={handleTextChange}
                autoFocus
              />
              <div className="esp-text-footer">
                <span>Notes are automatically saved locally during your exam session.</span>
                <button
                  type="button"
                  className="esp-tool-btn esp-tool-btn--danger"
                  onClick={() => {
                    if (window.confirm('Clear all rough notes?')) {
                      setTextNotes('');
                      try {
                        localStorage.removeItem(`${storageKey}_notes`);
                      } catch {
                        // ignore
                      }
                    }
                  }}
                >
                  Clear Notes
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
