import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import type { Question } from '../types/database';
import type { ExamHeaderConfig } from '../services/testBuilderService';
import {
  exportStudentPaperDocx,
  exportAnswerBookletDocx,
  exportTeacherMarkSchemeDocx,
  exportMcqAnswerSheetDocx,
} from '../services/docxExportService';
import {
  openStudentPaperPrintWindow,
  openAnswerBookletPrintWindow,
  openTeacherMarkSchemePrintWindow,
  openMcqAnswerSheetPrintWindow,
  openPeriodicTablePrintWindow,
  openInsertBookletPrintWindow,
} from '../services/pdfExportService';
import {
  EXAM_LAYOUT_TEMPLATES,
  DEFAULT_EXPORT_OPTIONS,
  type ExamLayoutTemplate,
  type ExportLayoutOptions,
} from '../types/exportTemplates';
import { exportOfflineGradingTemplateExcel } from '../services/offlineGradingService';
import { DEFAULT_SCHOOL_LOGO } from '../assets/logoConstants';
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
  const [customLogo, setCustomLogo] = useState<string>(() => {
    return localStorage.getItem('fluffykitten_school_logo') || DEFAULT_SCHOOL_LOGO;
  });

  const [layoutOptions, setLayoutOptions] = useState<ExportLayoutOptions>({
    ...DEFAULT_EXPORT_OPTIONS,
    schoolName: headerConfig.schoolName || '',
    schoolLogoUrl: localStorage.getItem('fluffykitten_school_logo') || DEFAULT_SCHOOL_LOGO,
  });

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      if (dataUrl) {
        setCustomLogo(dataUrl);
        try {
          localStorage.setItem('fluffykitten_school_logo', dataUrl);
        } catch {}
        setLayoutOptions((prev) => ({ ...prev, schoolLogoUrl: dataUrl }));
      }
    };
    reader.readAsDataURL(file);
  };

  const [isExporting, setIsExporting] = useState(false);
  const [activeTask, setActiveTask] = useState<string | null>(null);
  const backdropDismiss = useBackdropDismiss(onClose);

  if (!isOpen) return null;

  const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0);

  const isChemistry =
    /chem/i.test(headerConfig.subject || '') ||
    headerConfig.subjectCode === '0620' ||
    headerConfig.subjectCode === '0971';

  const isSocialSubject =
    /geograph|history|sociolog|econom|business|social|humanit|global/i.test(headerConfig.subject || '');

  // Template switch handler
  const handleSelectTemplate = (tId: ExamLayoutTemplate) => {
    const meta = EXAM_LAYOUT_TEMPLATES.find((t) => t.id === tId);
    setLayoutOptions((prev) => ({
      ...prev,
      template: tId,
      columns: meta ? meta.defaultColumns : 1,
      answerLineStyle: meta ? meta.defaultAnswerLineStyle : 'dotted',
    }));
  };

  // 1. Export Student Word Document
  const handleExportStudentDocx = async () => {
    setIsExporting(true);
    setActiveTask('Generating Student Word Document (.docx)…');
    try {
      if (layoutOptions.template === 'separate_answer_booklet') {
        // Export Questions-only docx
        await exportStudentPaperDocx(headerConfig, questions, {
          ...layoutOptions,
          includeAnswerLines: false,
        });
      } else {
        await exportStudentPaperDocx(headerConfig, questions, layoutOptions);
      }
    } catch (err: any) {
      alert(`Export failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsExporting(false);
      setActiveTask(null);
    }
  };

  // 2. Export Separate Answer Booklet Word Document
  const handleExportAnswerBookletDocx = async () => {
    setIsExporting(true);
    setActiveTask('Generating Candidate Answer Booklet (.docx)…');
    try {
      await exportAnswerBookletDocx(headerConfig, questions, layoutOptions);
    } catch (err: any) {
      alert(`Export failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsExporting(false);
      setActiveTask(null);
    }
  };

  // 3. Export Teacher Mark Scheme Docx
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

  // 4. Open Student PDF / Print
  const handleOpenStudentPdf = () => {
    if (layoutOptions.template === 'separate_answer_booklet') {
      openStudentPaperPrintWindow(headerConfig, questions, {
        ...layoutOptions,
        includeAnswerLines: false,
      });
    } else {
      openStudentPaperPrintWindow(headerConfig, questions, layoutOptions);
    }
  };

  // 5. Open Answer Booklet PDF / Print
  const handleOpenAnswerBookletPdf = () => {
    openAnswerBookletPrintWindow(headerConfig, questions, layoutOptions);
  };

  // 6. Open Teacher Mark Scheme PDF / Print
  const handleOpenTeacherPdf = () => {
    openTeacherMarkSchemePrintWindow(headerConfig, questions, layoutOptions);
  };

  // 7. Export Multiple Choice Answer Sheet Docx
  const handleExportMcqDocx = async () => {
    setIsExporting(true);
    setActiveTask('mcq-docx');
    try {
      await exportMcqAnswerSheetDocx(headerConfig, questions, layoutOptions);
    } catch (err) {
      console.error('Failed to export MCQ Answer Sheet Word:', err);
      alert('Error generating MCQ Answer Sheet Word file.');
    } finally {
      setIsExporting(false);
      setActiveTask(null);
    }
  };

  // 8. Open Multiple Choice Answer Sheet PDF / Print
  const handleOpenMcqPdf = () => {
    openMcqAnswerSheetPrintWindow(headerConfig, questions, layoutOptions);
  };

  // 9. Export Offline Excel Grading Template
  const handleExportOfflineTemplate = () => {
    try {
      exportOfflineGradingTemplateExcel(headerConfig, questions);
    } catch (err) {
      console.error('Failed to export offline template:', err);
      alert('Failed to generate offline grading template.');
    }
  };

  return createPortal(
    <div className="export-modal-backdrop animate-fade-in" {...backdropDismiss}>
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

        {/* ─── Step 1: Layout Template Selector ────────────────────────────── */}
        <div className="export-section-title">
          <span>🎨</span> 1. Select Layout & Styling Template:
        </div>

        <div className="export-templates-grid">
          {EXAM_LAYOUT_TEMPLATES.map((tmpl) => (
            <div
              key={tmpl.id}
              className={`export-template-card ${layoutOptions.template === tmpl.id ? 'export-template-card--active' : ''}`}
              onClick={() => handleSelectTemplate(tmpl.id)}
            >
              <div className="export-tmpl-header">
                <span className="export-tmpl-icon">{tmpl.icon}</span>
                <span className="export-tmpl-badge">{tmpl.badge}</span>
              </div>
              <h4 className="export-tmpl-name">{tmpl.name}</h4>
              <p className="export-tmpl-desc">{tmpl.description}</p>
            </div>
          ))}
        </div>

        {/* ─── Step 2: Customization Controls ──────────────────────────────── */}
        <div className="export-options-box">
          <div className="export-options-grid">
            {/* School / Institution Name */}
            <div className="export-opt-col">
              <label className="export-opt-label">School / Institution Name:</label>
              <input
                type="text"
                className="export-text-input"
                placeholder="e.g. Insan Cendekia Madani"
                value={layoutOptions.schoolName}
                onChange={(e) =>
                  setLayoutOptions((prev) => ({ ...prev, schoolName: e.target.value }))
                }
              />
            </div>

            {/* School Logo */}
            <div className="export-opt-col">
              <label className="export-opt-label">Header School Logo (Top-Left):</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <img
                  src={customLogo}
                  alt="School Logo"
                  style={{ height: '32px', maxWidth: '120px', objectFit: 'contain', background: '#fff', border: '1px solid #cbd5e1', borderRadius: '4px', padding: '2px 4px' }}
                />
                <label className="export-pill-btn" style={{ cursor: 'pointer', margin: 0 }}>
                  📁 Change Logo
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={handleLogoUpload}
                  />
                </label>
              </div>
            </div>

            {/* Answer Line Styling */}
            <div className="export-opt-col">
              <label className="export-opt-label">Answer Lines:</label>
              <div className="export-pill-group">
                <button
                  type="button"
                  className={`export-pill-btn ${layoutOptions.includeAnswerLines && layoutOptions.answerLineStyle === 'dotted' ? 'export-pill-btn--active' : ''}`}
                  onClick={() =>
                    setLayoutOptions((prev) => ({
                      ...prev,
                      includeAnswerLines: true,
                      answerLineStyle: 'dotted',
                    }))
                  }
                >
                  Dotted Lines
                </button>
                <button
                  type="button"
                  className={`export-pill-btn ${layoutOptions.includeAnswerLines && layoutOptions.answerLineStyle === 'solid' ? 'export-pill-btn--active' : ''}`}
                  onClick={() =>
                    setLayoutOptions((prev) => ({
                      ...prev,
                      includeAnswerLines: true,
                      answerLineStyle: 'solid',
                    }))
                  }
                >
                  Solid Lines
                </button>
                <button
                  type="button"
                  className={`export-pill-btn ${!layoutOptions.includeAnswerLines ? 'export-pill-btn--active' : ''}`}
                  onClick={() =>
                    setLayoutOptions((prev) => ({ ...prev, includeAnswerLines: false }))
                  }
                >
                  No Lines
                </button>
              </div>
            </div>

            {/* Spacing & Density */}
            {layoutOptions.includeAnswerLines && (
              <div className="export-opt-col">
                <label className="export-opt-label">Line Spacing:</label>
                <div className="export-pill-group">
                  <button
                    type="button"
                    className={`export-pill-btn ${layoutOptions.linesPerMark === 1 ? 'export-pill-btn--active' : ''}`}
                    onClick={() =>
                      setLayoutOptions((prev) => ({ ...prev, linesPerMark: 1 }))
                    }
                  >
                    Compact (1/mark)
                  </button>
                  <button
                    type="button"
                    className={`export-pill-btn ${layoutOptions.linesPerMark === 2 ? 'export-pill-btn--active' : ''}`}
                    onClick={() =>
                      setLayoutOptions((prev) => ({ ...prev, linesPerMark: 2 }))
                    }
                  >
                    Standard (2/mark)
                  </button>
                  <button
                    type="button"
                    className={`export-pill-btn ${layoutOptions.linesPerMark === 3 ? 'export-pill-btn--active' : ''}`}
                    onClick={() =>
                      setLayoutOptions((prev) => ({ ...prev, linesPerMark: 3 }))
                    }
                  >
                    Spacious (3/mark)
                  </button>
                </div>
              </div>
            )}

            {/* Column Layout */}
            <div className="export-opt-col">
              <label className="export-opt-label">Page Layout:</label>
              <div className="export-pill-group">
                <button
                  type="button"
                  className={`export-pill-btn ${layoutOptions.columns === 1 ? 'export-pill-btn--active' : ''}`}
                  onClick={() =>
                    setLayoutOptions((prev) => ({ ...prev, columns: 1 }))
                  }
                >
                  1-Column (Standard)
                </button>
                <button
                  type="button"
                  className={`export-pill-btn ${layoutOptions.columns === 2 ? 'export-pill-btn--active' : ''}`}
                  onClick={() =>
                    setLayoutOptions((prev) => ({ ...prev, columns: 2 }))
                  }
                >
                  2-Column (Paper Saver)
                </button>
              </div>
            </div>

            {/* Multiple Choice Answer Sheet Checkbox */}
            <div className="export-opt-col" style={{ gridColumn: '1 / -1', background: '#f0fdf4', padding: '10px 14px', borderRadius: '6px', border: '1px solid #bbf7d0', marginTop: '4px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', fontWeight: 600, color: '#166534', fontSize: '13px', margin: 0 }}>
                <input
                  type="checkbox"
                  checked={!!layoutOptions.includeMcqAnswerSheet}
                  onChange={(e) =>
                    setLayoutOptions((prev) => ({ ...prev, includeMcqAnswerSheet: e.target.checked }))
                  }
                  style={{ width: '18px', height: '18px', accentColor: '#16a34a', cursor: 'pointer' }}
                />
                <span>Attach Multiple Choice Bubble Answer Sheet to Student Exam Paper (Page Break)</span>
              </label>
            </div>

            {/* Chemistry Periodic Table Checkbox (Available only for Chemistry) */}
            {isChemistry && (
              <div className="export-opt-col" style={{ gridColumn: '1 / -1', background: '#eff6ff', padding: '10px 14px', borderRadius: '6px', border: '1px solid #bfdbfe', marginTop: '4px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', fontWeight: 600, color: '#1e40af', fontSize: '13px', margin: 0 }}>
                  <input
                    type="checkbox"
                    checked={!!layoutOptions.includePeriodicTable}
                    onChange={(e) =>
                      setLayoutOptions((prev) => ({ ...prev, includePeriodicTable: e.target.checked }))
                    }
                    style={{ width: '18px', height: '18px', accentColor: '#2563eb', cursor: 'pointer' }}
                  />
                  <span>🧪 Attach Official Cambridge IGCSE Periodic Table of Elements (Page Break)</span>
                </label>
              </div>
            )}
          </div>
        </div>

        {/* ─── Step 3: Export Actions Grid ─────────────────────────────────── */}
        <div className="export-section-title">
          <span>📥</span> 2. Download or Print ({EXAM_LAYOUT_TEMPLATES.find((t) => t.id === layoutOptions.template)?.name}):
        </div>

        <div className="export-grid">
          {layoutOptions.template === 'mark_scheme_pro' ? (
            <>
              {/* Comprehensive Mark Scheme Word */}
              <div className="export-card" onClick={handleExportTeacherDocx}>
                <div className="export-card-icon-wrap export-card-icon--ms">
                  🔑
                </div>
                <div className="export-card-content">
                  <div className="export-card-header-row">
                    <h3 className="export-card-name">Comprehensive Mark Scheme (.docx)</h3>
                    <span className="export-badge export-badge--word">Word</span>
                  </div>
                  <p className="export-card-desc">
                    Full teacher document with question context, step-by-step model answers, Examiner Guidance (💡), and Student Traps (⚠️).
                  </p>
                </div>
                <button
                  type="button"
                  className="export-card-action-btn"
                  disabled={isExporting}
                >
                  Download Solutions (.docx)
                </button>
              </div>

              {/* Comprehensive Mark Scheme PDF */}
              <div className="export-card" onClick={handleOpenTeacherPdf}>
                <div className="export-card-icon-wrap export-card-icon--pdf">
                  📑
                </div>
                <div className="export-card-content">
                  <div className="export-card-header-row">
                    <h3 className="export-card-name">Comprehensive Mark Scheme (PDF)</h3>
                    <span className="export-badge export-badge--pdf">Print / PDF</span>
                  </div>
                  <p className="export-card-desc">
                    Printable teacher grading edition with question stems and color-coded examiner notes.
                  </p>
                </div>
                <button
                  type="button"
                  className="export-card-action-btn"
                >
                  Print / Save PDF
                </button>
              </div>

              {/* Student Exam Paper Docx */}
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
                    Matching blank student exam paper ready for classroom distribution.
                  </p>
                </div>
                <button
                  type="button"
                  className="export-card-action-btn export-card-action-btn--sub"
                  disabled={isExporting}
                >
                  Download Student Word
                </button>
              </div>

              {/* Student Exam Paper PDF */}
              <div className="export-card" onClick={handleOpenStudentPdf}>
                <div className="export-card-icon-wrap export-card-icon--pdf">
                  🎓
                </div>
                <div className="export-card-content">
                  <div className="export-card-header-row">
                    <h3 className="export-card-name">Student Question Paper (PDF)</h3>
                    <span className="export-badge export-badge--pdf">Print / PDF</span>
                  </div>
                  <p className="export-card-desc">
                    Matching student paper in clean A4 print preview.
                  </p>
                </div>
                <button
                  type="button"
                  className="export-card-action-btn export-card-action-btn--sub"
                >
                  Print Student PDF
                </button>
              </div>
            </>
          ) : layoutOptions.template === 'separate_answer_booklet' ? (
            <>
              {/* Question Paper (No answer lines) */}
              <div className="export-card" onClick={handleExportStudentDocx}>
                <div className="export-card-icon-wrap export-card-icon--word">
                  📄
                </div>
                <div className="export-card-content">
                  <div className="export-card-header-row">
                    <h3 className="export-card-name">Questions-Only Paper</h3>
                    <span className="export-badge export-badge--word">Word / PDF</span>
                  </div>
                  <p className="export-card-desc">
                    Compact question paper without answer lines (students write answers in separate booklet).
                  </p>
                </div>
                <div className="export-card-split-btns" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="export-card-action-btn export-card-action-btn--sub"
                    onClick={handleExportStudentDocx}
                    disabled={isExporting}
                  >
                    Word (.docx)
                  </button>
                  <button
                    type="button"
                    className="export-card-action-btn"
                    onClick={handleOpenStudentPdf}
                  >
                    Print PDF
                  </button>
                </div>
              </div>

              {/* Candidate Answer Booklet */}
              <div className="export-card" onClick={handleOpenAnswerBookletPdf}>
                <div className="export-card-icon-wrap export-card-icon--booklet">
                  📝
                </div>
                <div className="export-card-content">
                  <div className="export-card-header-row">
                    <h3 className="export-card-name">Candidate Answer Booklet</h3>
                    <span className="export-badge export-badge--pdf">Word / PDF</span>
                  </div>
                  <p className="export-card-desc">
                    Dedicated lined booklet with candidate identification and structured answer slots.
                  </p>
                </div>
                <div className="export-card-split-btns" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="export-card-action-btn export-card-action-btn--sub"
                    onClick={handleExportAnswerBookletDocx}
                    disabled={isExporting}
                  >
                    Word (.docx)
                  </button>
                  <button
                    type="button"
                    className="export-card-action-btn"
                    onClick={handleOpenAnswerBookletPdf}
                  >
                    Print PDF
                  </button>
                </div>
              </div>

              {/* Teacher Mark Scheme */}
              <div className="export-card" onClick={handleOpenTeacherPdf}>
                <div className="export-card-icon-wrap export-card-icon--ms">
                  🔑
                </div>
                <div className="export-card-content">
                  <div className="export-card-header-row">
                    <h3 className="export-card-name">Teacher Mark Scheme</h3>
                    <span className="export-badge export-badge--word">Solutions</span>
                  </div>
                  <p className="export-card-desc">
                    Complete solution key with marking points, sub-question allocations, and teacher notes.
                  </p>
                </div>
                <div className="export-card-split-btns" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="export-card-action-btn export-card-action-btn--sub"
                    onClick={handleExportTeacherDocx}
                    disabled={isExporting}
                  >
                    Word (.docx)
                  </button>
                  <button
                    type="button"
                    className="export-card-action-btn"
                    onClick={handleOpenTeacherPdf}
                  >
                    Print PDF
                  </button>
                </div>
              </div>
            </>
          ) : (
            <>
              {/* Card 1: Student Word (.docx) */}
              <div className="export-card" onClick={handleExportStudentDocx}>
                <div className="export-card-icon-wrap export-card-icon--word">
                  📄
                </div>
                <div className="export-card-content">
                  <div className="export-card-header-row">
                    <h3 className="export-card-name">Student Exam Paper (.docx)</h3>
                    <span className="export-badge export-badge--word">Word</span>
                  </div>
                  <p className="export-card-desc">
                    Editable Word document styled with {layoutOptions.template === 'cambridge_official' ? 'Cambridge candidate box' : 'worksheet header'}, question stems, and formatted answer lines.
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

              {/* Card 2: Student PDF Print */}
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
                    High-resolution print window formatted for A4 printing or saving directly as clean PDF.
                  </p>
                </div>
                <button
                  type="button"
                  className="export-card-action-btn"
                >
                  Print / Save PDF
                </button>
              </div>

              {/* Card 3: Separate Answer Booklet */}
              <div className="export-card" onClick={handleOpenAnswerBookletPdf}>
                <div className="export-card-icon-wrap export-card-icon--booklet">
                  📝
                </div>
                <div className="export-card-content">
                  <div className="export-card-header-row">
                    <h3 className="export-card-name">Candidate Answer Booklet</h3>
                    <span className="export-badge export-badge--pdf">PDF / Word</span>
                  </div>
                  <p className="export-card-desc">
                    Separate lined booklet for student answers. Paired with questions-only papers to minimize paper usage.
                  </p>
                </div>
                <div className="export-card-split-btns" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="export-card-action-btn export-card-action-btn--sub"
                    onClick={handleExportAnswerBookletDocx}
                    disabled={isExporting}
                  >
                    Word (.docx)
                  </button>
                  <button
                    type="button"
                    className="export-card-action-btn"
                    onClick={handleOpenAnswerBookletPdf}
                  >
                    Print PDF
                  </button>
                </div>
              </div>

              {/* Card 4: Teacher Mark Scheme */}
              <div className="export-card" onClick={handleOpenTeacherPdf}>
                <div className="export-card-icon-wrap export-card-icon--ms">
                  🔑
                </div>
                <div className="export-card-content">
                  <div className="export-card-header-row">
                    <h3 className="export-card-name">Teacher Mark Scheme</h3>
                    <span className="export-badge export-badge--word">Solutions</span>
                  </div>
                  <p className="export-card-desc">
                    Complete solution key with marking points, sub-question allocations, teacher guidance, and misconception traps.
                  </p>
                </div>
                <div className="export-card-split-btns" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="export-card-action-btn export-card-action-btn--sub"
                    onClick={handleExportTeacherDocx}
                    disabled={isExporting}
                  >
                    Word (.docx)
                  </button>
                  <button
                    type="button"
                    className="export-card-action-btn"
                    onClick={handleOpenTeacherPdf}
                  >
                    Print PDF
                  </button>
                </div>
              </div>

              {/* Card 5: Dedicated Multiple Choice Bubble Answer Sheet */}
              <div className="export-card" onClick={handleOpenMcqPdf}>
                <div className="export-card-icon-wrap" style={{ background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0' }}>
                  ⭕
                </div>
                <div className="export-card-content">
                  <div className="export-card-header-row">
                    <h3 className="export-card-name">Multiple Choice Answer Sheet</h3>
                    <span className="export-badge" style={{ background: '#dcfce7', color: '#15803d' }}>Bubble Grid</span>
                  </div>
                  <p className="export-card-desc">
                    Official Cambridge/standard bubble answer sheet with candidate boxes, shading guide, and examiner score box.
                  </p>
                </div>
                <div className="export-card-split-btns" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    className="export-card-action-btn export-card-action-btn--sub"
                    onClick={handleExportMcqDocx}
                    disabled={isExporting}
                  >
                    Word (.docx)
                  </button>
                  <button
                    type="button"
                    className="export-card-action-btn"
                    onClick={handleOpenMcqPdf}
                  >
                    Print PDF
                  </button>
                </div>
              </div>

              {/* Card 6: Offline Excel Grading Template */}
              <div className="export-card" onClick={handleExportOfflineTemplate}>
                <div className="export-card-icon-wrap" style={{ background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0' }}>
                  📊
                </div>
                <div className="export-card-content">
                  <div className="export-card-header-row">
                    <h3 className="export-card-name">Offline Excel Grading Template</h3>
                    <span className="export-badge" style={{ background: '#dcfce7', color: '#15803d' }}>Excel (.xlsx)</span>
                  </div>
                  <p className="export-card-desc">
                    Ready-to-use spreadsheet with question columns, answer key, and mark scheme for rapid offline grading and auto-evaluation.
                  </p>
                </div>
                <button
                  type="button"
                  className="export-card-action-btn"
                >
                  Download Excel (.xlsx)
                </button>
              </div>

              {/* Chemistry Only: Periodic Table Card */}
              {isChemistry && (
                <div className="export-card" onClick={() => openPeriodicTablePrintWindow(headerConfig)}>
                  <div className="export-card-icon-wrap" style={{ background: '#eff6ff', color: '#2563eb', border: '1px solid #bfdbfe' }}>
                    🧪
                  </div>
                  <div className="export-card-content">
                    <div className="export-card-header-row">
                      <h3 className="export-card-name">The Periodic Table of Elements</h3>
                      <span className="export-badge" style={{ background: '#dbeafe', color: '#1d4ed8' }}>Chemistry</span>
                    </div>
                    <p className="export-card-desc">
                      Official Cambridge IGCSE Chemistry Periodic Table (clean version with barcodes and margins removed).
                    </p>
                  </div>
                  <button
                    type="button"
                    className="export-card-action-btn"
                  >
                    Print / Save PDF
                  </button>
                </div>
              )}

              {/* Social Subjects Only: Insert / Resource Booklet Card */}
              {isSocialSubject && (
                <div className="export-card" onClick={() => openInsertBookletPrintWindow(headerConfig, questions, layoutOptions)}>
                  <div className="export-card-icon-wrap" style={{ background: '#fef3c7', color: '#d97706', border: '1px solid #fde68a' }}>
                    🗺️
                  </div>
                  <div className="export-card-content">
                    <div className="export-card-header-row">
                      <h3 className="export-card-name">Insert / Resource Booklet</h3>
                      <span className="export-badge" style={{ background: '#fef3c7', color: '#b45309' }}>Social Sciences</span>
                    </div>
                    <p className="export-card-desc">
                      Dedicated Cambridge resource booklet containing figures, maps, tables, case studies, and source extracts.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="export-card-action-btn"
                  >
                    Print / Save Insert
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Loading Banner */}
        {isExporting && (
          <div className="export-loading-banner animate-fade-in">
            <div className="export-spinner" />
            <span>{activeTask || 'Generating document…'}</span>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
