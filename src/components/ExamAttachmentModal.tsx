import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import type { ExamAttachment } from '../services/quizManagerService';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import './ExamAttachmentModal.css';

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
            {/* Zoom Controls for Images */}
            {isImage && (
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

        {/* Modal Content Viewer */}
        <div className="exam-att-content">
          {isPdf ? (
            <iframe
              src={currentAttachment.url}
              title={currentAttachment.name}
              className="exam-att-iframe"
            />
          ) : isImage ? (
            <div className="exam-att-img-viewport">
              <img
                src={currentAttachment.url}
                alt={currentAttachment.name}
                className="exam-att-img"
                style={{ transform: `scale(${zoomLevel / 100})` }}
              />
            </div>
          ) : (
            <div className="exam-att-fallback">
              <iframe
                src={currentAttachment.url}
                title={currentAttachment.name}
                className="exam-att-iframe"
              />
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
