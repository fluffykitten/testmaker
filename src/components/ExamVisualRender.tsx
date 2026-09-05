import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import './ExamVisualRender.css';

/**
 * Sanitizes and normalizes an SVG string produced by AI or loaded from database.
 * - Strips markdown code blocks (```xml ... ``` or ```svg ... ```)
 * - Ensures safe XML boundaries (<svg ... </svg>)
 * - Removes potentially hazardous script tags and event handlers
 * - Enforces responsive viewBox and removes hardcoded fixed pixel dimensions
 * - Adds exam styling class
 */
export function cleanSvgContent(rawSvg: string | null | undefined): string | null {
  if (!rawSvg || typeof rawSvg !== 'string') return null;

  let cleaned = rawSvg.trim();

  // Strip markdown code fences if model wrapped the SVG
  if (cleaned.startsWith('```xml')) cleaned = cleaned.slice(6);
  else if (cleaned.startsWith('```svg')) cleaned = cleaned.slice(6);
  else if (cleaned.startsWith('```html')) cleaned = cleaned.slice(7);
  else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);

  if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
  cleaned = cleaned.trim();

  // Find start of <svg and end of </svg>
  const svgStartIdx = cleaned.indexOf('<svg');
  const svgEndIdx = cleaned.lastIndexOf('</svg>');

  if (svgStartIdx === -1 || svgEndIdx === -1 || svgEndIdx <= svgStartIdx) {
    return null;
  }

  cleaned = cleaned.substring(svgStartIdx, svgEndIdx + 6).trim();

  // Security sanitization: strip script tags & inline event handlers
  cleaned = cleaned.replace(/<script[\s\S]*?<\/script>/gi, '');
  cleaned = cleaned.replace(/\bon[a-z]+\s*=\s*(['"]).*?\1/gi, '');
  cleaned = cleaned.replace(/\bon[a-z]+\s*=\s*[^>\s]+/gi, '');
  cleaned = cleaned.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '');

  // Ensure xmlns is present
  if (!cleaned.includes('xmlns=')) {
    cleaned = cleaned.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  // Ensure responsive viewBox: if width and height exist without viewBox, synthesize viewBox
  const viewBoxMatch = cleaned.match(/viewBox\s*=\s*["']([^"']+)["']/i);
  if (!viewBoxMatch) {
    const widthMatch = cleaned.match(/\bwidth\s*=\s*["']?(\d+(?:\.\d+)?)(?:px)?["']?/i);
    const heightMatch = cleaned.match(/\bheight\s*=\s*["']?(\d+(?:\.\d+)?)(?:px)?["']?/i);
    if (widthMatch && heightMatch) {
      const w = parseFloat(widthMatch[1]);
      const h = parseFloat(heightMatch[1]);
      if (w > 0 && h > 0) {
        cleaned = cleaned.replace('<svg', `<svg viewBox="0 0 ${w} ${h}"`);
      }
    } else {
      // Default standard exam graphic viewBox fallback
      cleaned = cleaned.replace('<svg', '<svg viewBox="0 0 500 300"');
    }
  }

  // Remove hardcoded pixel width/height from the outer <svg> so it scales fluidly via CSS
  cleaned = cleaned.replace(/(<svg[^>]*?)\s+(?:width|height)\s*=\s*["'][^"']*["']/gi, '$1');

  // Inject or ensure class="exam-svg-graphic"
  if (!cleaned.includes('exam-svg-graphic')) {
    if (cleaned.includes('class="')) {
      cleaned = cleaned.replace('class="', 'class="exam-svg-graphic ');
    } else {
      cleaned = cleaned.replace('<svg', '<svg class="exam-svg-graphic"');
    }
  }

  return cleaned;
}

export interface ExamVisualRenderProps {
  svgContent?: string | null;
  diagramUrl?: string | null;
  resourceRef?: string | null;
  alt?: string;
  caption?: string;
  diagramType?: 'apparatus' | 'graph' | 'choice_grid' | 'circuit' | 'photo' | null;
  hasEmbeddedValues?: boolean;
  interactiveZoom?: boolean;
  onExternalZoom?: () => void;
  className?: string;
}

export const ExamVisualRender: React.FC<ExamVisualRenderProps> = ({
  svgContent,
  diagramUrl,
  resourceRef,
  alt = 'Question Diagram',
  caption,
  diagramType,
  interactiveZoom = true,
  onExternalZoom,
  className = '',
}) => {
  const [isZoomOpen, setIsZoomOpen] = useState(false);

  const sanitizedSvg = cleanSvgContent(svgContent);

  // If neither SVG nor diagram URL is available, render nothing
  if (!sanitizedSvg && !diagramUrl) {
    return null;
  }

  const handleOpenZoom = () => {
    if (onExternalZoom) {
      onExternalZoom();
    } else if (interactiveZoom) {
      setIsZoomOpen(true);
    }
  };

  const displayCaption = caption || resourceRef || null;

  return (
    <div className={`exam-visual-container ${className}`}>
      {sanitizedSvg ? (
        <div
          className="exam-svg-wrap"
          onClick={handleOpenZoom}
          title="Vector diagram • Click to zoom"
          dangerouslySetInnerHTML={{ __html: sanitizedSvg }}
        />
      ) : (
        <div className="exam-visual-img-wrap" onClick={handleOpenZoom} title="Click to zoom image">
          <img
            src={diagramUrl!}
            alt={alt}
            className="exam-visual-img"
            loading="lazy"
            decoding="async"
          />
        </div>
      )}

      {displayCaption && (
        <div className="exam-visual-caption">{displayCaption}</div>
      )}

      {diagramType && (
        <span className="exam-visual-badge">
          {diagramType === 'circuit' && '⚡ Circuit'}
          {diagramType === 'graph' && '📈 Graph'}
          {diagramType === 'choice_grid' && '🔲 4-Choice Visual'}
          {diagramType === 'apparatus' && '🔬 Apparatus'}
          {diagramType === 'photo' && '📷 Photograph'}
        </span>
      )}

      {/* Internal Zoom Lightbox Modal */}
      {isZoomOpen &&
        createPortal(
          <div className="exam-visual-zoom-overlay" onClick={() => setIsZoomOpen(false)}>
            <div className="exam-visual-zoom-content" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="exam-visual-zoom-close"
                onClick={() => setIsZoomOpen(false)}
                title="Close"
              >
                ✕
              </button>

              <div className="exam-visual-zoom-body">
                {sanitizedSvg ? (
                  <div
                    style={{ width: '100%' }}
                    dangerouslySetInnerHTML={{ __html: sanitizedSvg }}
                  />
                ) : (
                  <img src={diagramUrl!} alt={alt} />
                )}
              </div>

              {displayCaption && (
                <div className="exam-visual-caption" style={{ marginTop: '14px', fontSize: '1rem' }}>
                  {displayCaption}
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
