import React from 'react';
import { renderPeriodicTableHtml } from '../services/periodicTableService';
import './PeriodicTableDrawer.css';

interface PeriodicTableDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export const PeriodicTableDrawer: React.FC<PeriodicTableDrawerProps> = ({ isOpen, onClose }) => {
  if (!isOpen) return null;

  const periodicTableHtml = renderPeriodicTableHtml({ rotated: false });

  return (
    <div className="pt-drawer-backdrop animate-fade-in" onClick={onClose}>
      <div className="pt-drawer-card animate-scale-up" onClick={(e) => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="pt-drawer-header">
          <div className="pt-drawer-title-wrap">
            <span className="pt-icon">🧪</span>
            <div>
              <h2 className="pt-title">Cambridge Chemistry Reference & Periodic Table</h2>
              <p className="pt-sub">Official IGCSE / GCE A-Level Periodic Table of Elements & Physical Constants</p>
            </div>
          </div>
          <button type="button" className="pt-close-btn" onClick={onClose} title="Close Reference Sheet">
            ✕
          </button>
        </div>

        {/* Modal Body */}
        <div className="pt-drawer-body">
          {/* Key Formula & Physical Constants Ribbon */}
          <div className="pt-constants-grid">
            <div className="pt-const-card">
              <span className="const-name">Molar Gas Volume ($V_m$)</span>
              <strong className="const-val">24.0 dm³/mol (at r.t.p.)</strong>
            </div>
            <div className="pt-const-card">
              <span className="const-name">Avogadro Constant ($L$)</span>
              <strong className="const-val">6.02 × 10²³ mol⁻¹</strong>
            </div>
            <div className="pt-const-card">
              <span className="const-name">Mole Calculations</span>
              <strong className="const-val">n = m / Mᵣ &nbsp;•&nbsp; n = c × V (dm³)</strong>
            </div>
            <div className="pt-const-card">
              <span className="const-name">Standard Temperature & Pressure</span>
              <strong className="const-val">25 °C (298 K) &nbsp;•&nbsp; 1 atm (101 kPa)</strong>
            </div>
          </div>

          {/* Rendered Authentic Periodic Table */}
          <div className="pt-table-scroll-container">
            <div
              className="pt-table-embed"
              dangerouslySetInnerHTML={{ __html: periodicTableHtml }}
            />
          </div>
        </div>

        {/* Modal Footer */}
        <div className="pt-drawer-footer">
          <span className="pt-footer-tip">💡 Tip: You can keep this reference sheet open during calculations.</span>
          <button type="button" className="sq-btn sq-btn-primary" onClick={onClose}>
            Done & Return to Exam
          </button>
        </div>
      </div>
    </div>
  );
};
