import { useState } from 'react';
import type { Question } from '../types/database';
import type { ExamHeaderConfig } from '../services/testBuilderService';
import {
  exportStudentPaperDocx,
  exportTeacherMarkSchemeDocx,
} from '../services/docxExportService';
import {
  openStudentPaperPrintWindow,
  openTeacherMarkSchemePrintWindow,
} from '../services/pdfExportService';
import './ExportModal.css';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  headerConfig: ExamHeaderConfig;
  questions: Question[];
}

export function ExportModal({
  isOpen,
  onClose,
  headerConfig,
  questions,
}: ExportModalProps) {
  const [includeAnswerLines, setIncludeAnswerLines] = useState(true);
  const [linesPerMark, setLinesPerMark] = useState(2);
  const [isExporting, setIsExporting] = useState(false);
  const [activeTask, setActiveTask] = useState<string | null>(null);

  if (!isOpen) return null;

  const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0);

  // 1. Export Student Docx
  const handleExportStudentDocx = async () => {
    setIsExporting(true);
    setActiveTask('Generating Student Word Document (.docx)…');
    try {
      await exportStudentPaperDocx(headerConfig, questions, {
        includeAnswerLines,
        linesPerMark,
      });
    } catch (err: any) {
      alert(`Export failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsExporting(false);
      setActiveTask(null);
    }
  };

  // 2. Export Teacher Mark Scheme Docx
  const handleExportTeacherDocx = async () => {
    setIsExporting(true);
    setActiveTask('Generating Teacher Mark Scheme (.docx)…');
    try {
      await exportTeacherMarkSchemeDocx(headerConfig, questions);
    } catch (err: any) {
      alert(`Export failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsExporting(false);
      setActiveTask(null);
    }
  };

  // 3. Open Student PDF
  const handleOpenStudentPdf = () => {
    openStudentPaperPrintWindow(headerConfig, questions, {
      includeAnswerLines,
      linesPerMark,
    });
  };

  // 4. Open Teacher PDF
  const handleOpenTeacherPdf = () => {
    openTeacherMarkSchemePrintWindow(headerConfig, questions);
  };

  return (
    <div className="export-modal-backdrop animate-fade-in" onClick={onClose}>
      <div
        className="export-modal-card animate-scale-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="export-modal-header">
          <div className="export-modal-title-group">
            <span className="export-modal-icon">⚡</span>
            <div>
              <h2 className="export-modal-title">Export Exam Paper</h2>
              <p className="export-modal-subtitle">
                {headerConfig.title || 'Untitled Assessment'} • {questions.length} questions • {totalMarks} marks
              </p>
            </div>
          </div>

          <button
            type="button"
            className="export-modal-close"
            onClick={onClose}
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* Options Bar */}
        <div className="export-options-box">
          <div className="export-opt-row">
            <label className="export-checkbox-label">
              <input
                type="checkbox"
                checked={includeAnswerLines}
                onChange={(e) => setIncludeAnswerLines(e.target.checked)}
              />
              <span>Include handwriting dotted answer lines</span>
            </label>

            {includeAnswerLines && (
              <div className="export-lines-selector">
                <span>Density:</span>
                <button
                  type="button"
                  className={`export-density-pill ${linesPerMark === 2 ? 'export-density-pill--active' : ''}`}
                  onClick={() => setLinesPerMark(2)}
                >
                  Standard (2 lines/m)
                </button>
                <button
                  type="button"
                  className={`export-density-pill ${linesPerMark === 3 ? 'export-density-pill--active' : ''}`}
                  onClick={() => setLinesPerMark(3)}
                >
                  Spacious (3 lines/m)
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Export Cards Grid */}
        <div className="export-grid">
          {/* Card 1: Student Word */}
          <div className="export-card" onClick={handleExportStudentDocx}>
            <div className="export-card-icon-wrap export-card-icon--word">
              📄
            </div>
            <div className="export-card-content">
              <div className="export-card-header-row">
                <h3 className="export-card-name">Student Question Paper (.docx)</h3>
                <span className="export-badge export-badge--word">Word</span>
              </div>
              <p className="export-card-desc">
                Fully editable Microsoft Word document with classroom header, question stems, and handwriting answer lines.
              </p>
            </div>
            <button
              type="button"
              className="export-card-action-btn"
              disabled={isExporting}
            >
              Download Word
            </button>
          </div>

          {/* Card 2: Teacher Mark Scheme Word */}
          <div className="export-card" onClick={handleExportTeacherDocx}>
            <div className="export-card-icon-wrap export-card-icon--ms">
              🔑
            </div>
            <div className="export-card-content">
              <div className="export-card-header-row">
                <h3 className="export-card-name">Teacher Mark Scheme (.docx)</h3>
                <span className="export-badge export-badge--word">Word</span>
              </div>
              <p className="export-card-desc">
                Structured Word table with marking points, sub-question allocations, and acceptable answers for quick grading.
              </p>
            </div>
            <button
              type="button"
              className="export-card-action-btn"
              disabled={isExporting}
            >
              Download Word
            </button>
          </div>

          {/* Card 3: Student PDF */}
          <div className="export-card" onClick={handleOpenStudentPdf}>
            <div className="export-card-icon-wrap export-card-icon--pdf">
              📑
            </div>
            <div className="export-card-content">
              <div className="export-card-header-row">
                <h3 className="export-card-name">Student Exam Paper (PDF)</h3>
                <span className="export-badge export-badge--pdf">Print / PDF</span>
              </div>
              <p className="export-card-desc">
                Instant high-resolution print window ready to save as PDF or print directly on standard A4 paper.
              </p>
            </div>
            <button
              type="button"
              className="export-card-action-btn"
            >
              Print / Save PDF
            </button>
          </div>

          {/* Card 4: Teacher PDF */}
          <div className="export-card" onClick={handleOpenTeacherPdf}>
            <div className="export-card-icon-wrap export-card-icon--pdf">
              🎓
            </div>
            <div className="export-card-content">
              <div className="export-card-header-row">
                <h3 className="export-card-name">Teacher Mark Scheme (PDF)</h3>
                <span className="export-badge export-badge--pdf">Print / PDF</span>
              </div>
              <p className="export-card-desc">
                Clean printable grading key table with mark breakdowns, ready to archive or share with colleagues.
              </p>
            </div>
            <button
              type="button"
              className="export-card-action-btn"
            >
              Print / Save PDF
            </button>
          </div>
        </div>

        {/* Loading Banner */}
        {isExporting && (
          <div className="export-loading-banner animate-fade-in">
            <div className="export-spinner" />
            <span>{activeTask || 'Generating document…'}</span>
          </div>
        )}
      </div>
    </div>
  );
}
