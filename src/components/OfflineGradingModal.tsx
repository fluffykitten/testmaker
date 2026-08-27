import { useState, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import type { Question } from '../types/database';
import type { ExamHeaderConfig } from '../services/testBuilderService';
import {
  getOfflineGradingColumns,
  exportOfflineGradingTemplateExcel,
  parseOfflineGradingExcel,
  gradeOfflineSubmissions,
  saveOfflineExamToGradebook,
  type OfflineGradingColumn,
  type RawOfflineStudentRow,
} from '../services/offlineGradingService';
import {
  exportAllSubmissionsExcel,
  type StudentSubmission,
} from '../services/quizSubmissionService';
import { exportClassQuizReportPdf } from '../services/quizReportPdfService';
import type { PublishedQuiz } from '../services/quizManagerService';
import './OfflineGradingModal.css';

interface OfflineGradingModalProps {
  isOpen: boolean;
  onClose: () => void;
  headerConfig: ExamHeaderConfig;
  questions: Question[];
  onViewInGradebook?: (quiz: PublishedQuiz) => void;
}

export function OfflineGradingModal({
  isOpen,
  onClose,
  headerConfig,
  questions,
  onViewInGradebook,
}: OfflineGradingModalProps) {
  const backdropDismiss = useBackdropDismiss(onClose);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [activeTab, setActiveTab] = useState<'upload' | 'grid'>('upload');
  const [currentStep, setCurrentStep] = useState<'entry' | 'review' | 'success'>('entry');
  const [isMaximized, setIsMaximized] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingMessage, setProcessingMessage] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Data State
  const columns: OfflineGradingColumn[] = useMemo(() => {
    return getOfflineGradingColumns(questions);
  }, [questions]);

  const totalMarks = useMemo(() => {
    return columns.reduce((s, c) => s + c.maxMarks, 0);
  }, [columns]);

  // Graded Submissions
  const [gradedSubmissions, setGradedSubmissions] = useState<StudentSubmission[]>([]);
  const [savedQuiz, setSavedQuiz] = useState<PublishedQuiz | null>(null);

  // In-App Rapid Grader Grid State
  const [gridRows, setGridRows] = useState<RawOfflineStudentRow[]>([
    {
      rowNumber: 1,
      studentName: '',
      studentClass: 'General',
      candidateNumber: '001',
      answers: {},
    },
    {
      rowNumber: 2,
      studentName: '',
      studentClass: 'General',
      candidateNumber: '002',
      answers: {},
    },
    {
      rowNumber: 3,
      studentName: '',
      studentClass: 'General',
      candidateNumber: '003',
      answers: {},
    },
  ]);

  // ─── Class Statistics Calculation ───────────────────────────────────────────
  const stats = useMemo(() => {
    if (gradedSubmissions.length === 0) return null;
    const count = gradedSubmissions.length;
    const totalScore = gradedSubmissions.reduce((s, sub) => s + sub.score, 0);
    const avgScore = totalScore / count;
    const avgPct = totalMarks > 0 ? (avgScore / totalMarks) * 100 : 0;
    const highest = Math.max(...gradedSubmissions.map((s) => s.score));
    const lowest = Math.min(...gradedSubmissions.map((s) => s.score));
    const passCount = gradedSubmissions.filter((s) => s.percentage >= 50).length;
    const passRate = Math.round((passCount / count) * 100);

    return {
      count,
      avgScore: avgScore.toFixed(1),
      avgPct: avgPct.toFixed(1),
      highest,
      lowest,
      passRate,
    };
  }, [gradedSubmissions, totalMarks]);

  // Inline Mark Override Editor State
  const [editingCell, setEditingCell] = useState<{ subId: string; qId: string } | null>(null);

  if (!isOpen) return null;

  // ─── 1. Download Blank Excel Template ───────────────────────────────────────
  const handleDownloadTemplate = () => {
    try {
      exportOfflineGradingTemplateExcel(headerConfig, questions);
    } catch (err: any) {
      alert(`Failed to download template: ${err?.message || 'Unknown error'}`);
    }
  };

  // ─── 2. Handle File Upload & Auto-Grading ────────────────────────────────────
  const handleFileUpload = async (file: File) => {
    if (!file) return;
    setIsProcessing(true);
    setErrorMessage(null);
    setProcessingMessage(`Reading ${file.name}…`);

    try {
      const parsed = await parseOfflineGradingExcel(file, questions);
      if (parsed.rows.length === 0) {
        throw new Error('No candidate rows detected in the uploaded file. Please ensure Sheet 1 contains candidate data.');
      }

      setProcessingMessage(`Auto-grading ${parsed.rows.length} candidates against Cambridge mark scheme…`);
      const graded = await gradeOfflineSubmissions(
        parsed.rows,
        columns,
        headerConfig.title || 'Offline Exam Assessment',
        headerConfig.subject || 'Chemistry'
      );

      setGradedSubmissions(graded);
      setCurrentStep('review');
    } catch (err: any) {
      console.error('Offline grading error:', err);
      setErrorMessage(err?.message || 'Failed to process Excel file.');
    } finally {
      setIsProcessing(false);
      setProcessingMessage('');
    }
  };

  // ─── 3. In-App Rapid Grader Handlers ────────────────────────────────────────
  const handleGridCellChange = (rowIndex: number, colId: string, value: string) => {
    setGridRows((prev) => {
      const next = [...prev];
      next[rowIndex] = {
        ...next[rowIndex],
        answers: {
          ...next[rowIndex].answers,
          [colId]: value,
        },
      };

      // Automatically add a fresh candidate row when typing in the last row!
      if (rowIndex === prev.length - 1 && value.trim().length > 0) {
        next.push({
          rowNumber: next.length + 1,
          studentName: '',
          studentClass: next[rowIndex]?.studentClass || 'General',
          candidateNumber: String(next.length + 1).padStart(3, '0'),
          answers: {},
        });
      }

      return next;
    });
  };

  const handleGridMetadataChange = (
    rowIndex: number,
    field: 'studentName' | 'studentClass' | 'candidateNumber',
    value: string
  ) => {
    setGridRows((prev) => {
      const next = [...prev];
      next[rowIndex] = {
        ...next[rowIndex],
        [field]: value,
      };

      // Automatically add a fresh candidate row when typing in the last row!
      if (rowIndex === prev.length - 1 && value.trim().length > 0) {
        next.push({
          rowNumber: next.length + 1,
          studentName: '',
          studentClass: next[rowIndex]?.studentClass || 'General',
          candidateNumber: String(next.length + 1).padStart(3, '0'),
          answers: {},
        });
      }

      return next;
    });
  };

  const handleAddGridRow = () => {
    setGridRows((prev) => [
      ...prev,
      {
        rowNumber: prev.length + 1,
        studentName: '',
        studentClass: prev[prev.length - 1]?.studentClass || 'General',
        candidateNumber: String(prev.length + 1).padStart(3, '0'),
        answers: {},
      },
    ]);
  };

  const handleDeleteGridRow = (rowIndex: number) => {
    setGridRows((prev) => {
      if (prev.length <= 1) {
        return [{ rowNumber: 1, studentName: '', studentClass: 'General', candidateNumber: '001', answers: {} }];
      }
      return prev.filter((_, idx) => idx !== rowIndex).map((r, i) => ({ ...r, rowNumber: i + 1 }));
    });
  };

  const handlePasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text || !text.trim()) {
        alert('Clipboard is empty. Copy some candidate rows from Excel or Google Sheets first.');
        return;
      }

      const lines = text.trim().split(/\r?\n/);
      if (lines.length === 0) return;

      const newRows: RawOfflineStudentRow[] = [];
      lines.forEach((line, lIdx) => {
        const parts = line.split('\t');
        if (parts.length >= 1) {
          const name = parts[0].trim();
          if (!name) return;
          const sClass = parts[1]?.trim() || 'General';
          const candNum = parts[2]?.trim() || String(lIdx + 1).padStart(3, '0');
          const answers: Record<string, string> = {};

          if (parts.length > 3) {
            columns.forEach((col, cIdx) => {
              const val = parts[3 + cIdx];
              if (val !== undefined) answers[col.id] = val.trim();
            });
          }

          newRows.push({
            rowNumber: newRows.length + 1,
            studentName: name,
            studentClass: sClass,
            candidateNumber: candNum,
            answers,
          });
        }
      });

      if (newRows.length > 0) {
        // Append a fresh trailing row ready for next candidate
        newRows.push({
          rowNumber: newRows.length + 1,
          studentName: '',
          studentClass: newRows[newRows.length - 1]?.studentClass || 'General',
          candidateNumber: String(newRows.length + 1).padStart(3, '0'),
          answers: {},
        });
        setGridRows(newRows);
      }
    } catch (err) {
      console.warn('Could not read clipboard:', err);
      alert('Could not access clipboard. Please paste directly into the inputs or ensure browser clipboard permission is granted.');
    }
  };

  const handleAutoGradeGrid = async () => {
    const validRows = gridRows.filter((r) => r.studentName.trim().length > 0);
    if (validRows.length === 0) {
      alert('Please enter at least one candidate name in the grid before auto-grading.');
      return;
    }

    setIsProcessing(true);
    setProcessingMessage(`Auto-grading ${validRows.length} grid candidates…`);
    try {
      const graded = await gradeOfflineSubmissions(
        validRows,
        columns,
        headerConfig.title || 'Offline Exam Assessment',
        headerConfig.subject || 'Chemistry'
      );
      setGradedSubmissions(graded);
      setCurrentStep('review');
    } catch (err: any) {
      alert(`Auto-grading failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsProcessing(false);
      setProcessingMessage('');
    }
  };

  // ─── 4. Quick Inline Mark Override ──────────────────────────────────────────
  const handleOverrideMark = (subId: string, qId: string, newMark: number) => {
    setGradedSubmissions((prev) => {
      return prev.map((sub) => {
        if (sub.id !== subId) return sub;

        const updatedQResults = sub.questionResults.map((qr) => {
          if (qr.questionId !== qId) return qr;
          const cappedMark = Math.max(0, Math.min(newMark, qr.maxMarks));
          return {
            ...qr,
            earnedMarks: cappedMark,
            isCorrect: cappedMark === qr.maxMarks,
            aiFeedback: `Teacher manual override: ${cappedMark}/${qr.maxMarks}`,
          };
        });

        const newTotalScore = updatedQResults.reduce((s, q) => s + q.earnedMarks, 0);
        const newPct = totalMarks > 0 ? (newTotalScore / totalMarks) * 100 : 0;

        return {
          ...sub,
          score: newTotalScore,
          percentage: Math.round(newPct * 10) / 10,
          questionResults: updatedQResults,
        };
      });
    });
    setEditingCell(null);
  };

  // ─── 5. Batch Gemini AI Grading for Descriptive Answers ─────────────────────
  const handleBatchAiGrading = async () => {
    setIsProcessing(true);
    setProcessingMessage('Evaluating complex descriptive answers with Gemini AI…');

    try {
      // Re-run grading with useAiForDescriptive: true
      const rawRows: RawOfflineStudentRow[] = gradedSubmissions.map((s, idx) => {
        const answers: Record<string, string | number> = {};
        s.questionResults.forEach((qr) => {
          answers[qr.questionId] = qr.studentAnswer;
        });
        return {
          rowNumber: idx + 1,
          studentName: s.studentName,
          studentClass: s.studentClass || 'General',
          candidateNumber: s.candidateNumber || '-',
          answers,
        };
      });

      const reGraded = await gradeOfflineSubmissions(
        rawRows,
        columns,
        headerConfig.title || 'Offline Exam Assessment',
        headerConfig.subject || 'Chemistry',
        { useAiForDescriptive: true }
      );

      setGradedSubmissions(reGraded);
    } catch (err: any) {
      alert(`AI Grading encountered an issue: ${err?.message || 'Check your Gemini API connection.'}`);
    } finally {
      setIsProcessing(false);
      setProcessingMessage('');
    }
  };

  // ─── 6. Save Offline Exam to Central Gradebook ──────────────────────────────
  const handleSaveToGradebook = () => {
    if (gradedSubmissions.length === 0) return;

    try {
      const { publishedQuiz } = saveOfflineExamToGradebook(
        headerConfig.title || 'Offline Exam Assessment',
        headerConfig.subject || 'Chemistry',
        questions,
        gradedSubmissions
      );
      setSavedQuiz(publishedQuiz);
      setCurrentStep('success');
    } catch (err: any) {
      alert(`Failed to save exam to gradebook: ${err?.message || 'Unknown error'}`);
    }
  };


  return createPortal(
    <div className={`og-backdrop animate-fade-in ${isMaximized ? 'og-backdrop--maximized' : ''}`} {...backdropDismiss}>
      <div className={`og-card animate-scale-up ${isMaximized ? 'og-card--maximized' : ''}`} onClick={(e) => e.stopPropagation()}>
        {/* Modal Header */}
        <div className="og-header">
          <div className="og-title-group">
            <span className="og-icon">📊</span>
            <div>
              <h2 className="og-title">Offline Exam Auto-Grader</h2>
              <p className="og-subtitle">
                {headerConfig.title || 'Assessment'} • {questions.length} questions ({columns.length} items) • {totalMarks} marks
              </p>
            </div>
          </div>
          <div className="og-header-actions">
            <button
              type="button"
              className="og-header-icon-btn"
              onClick={() => setIsMaximized(!isMaximized)}
              title={isMaximized ? 'Restore window size' : 'Maximize window for full workspace'}
            >
              {isMaximized ? '❐' : '⛶'}
            </button>
            <button type="button" className="og-close-btn" onClick={onClose} title="Close">
              ✕
            </button>
          </div>
        </div>

        {/* Tab Navigation (Only during Entry phase) */}
        {currentStep === 'entry' && (
          <div className="og-tabs">
            <button
              type="button"
              className={`og-tab ${activeTab === 'upload' ? 'og-tab--active' : ''}`}
              onClick={() => setActiveTab('upload')}
            >
              <span>📁</span> Upload Excel Spreadsheet
            </button>
            <button
              type="button"
              className={`og-tab ${activeTab === 'grid' ? 'og-tab--active' : ''}`}
              onClick={() => setActiveTab('grid')}
            >
              <span>⚡</span> In-App Rapid Grader Grid
              <span className="og-tab-badge">Fast Entry</span>
            </button>
          </div>
        )}

        {/* Modal Body */}
        <div className="og-body">
          {/* Error Banner */}
          {errorMessage && (
            <div
              style={{
                background: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: '8px',
                padding: '0.875rem 1rem',
                color: '#991b1b',
                marginBottom: '1rem',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              <span>⚠️</span>
              <span>{errorMessage}</span>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════════════════
              STEP 1: ENTRY PHASE (Upload Excel OR In-App Rapid Grader)
             ═══════════════════════════════════════════════════════════════════ */}
          {currentStep === 'entry' && activeTab === 'upload' && (
            <div className="og-upload-grid animate-fade-in">
              {/* Left Panel: Download Template */}
              <div className="og-panel">
                <h3 className="og-panel-title">
                  <span>📥</span> 1. Download Blank Excel Template
                </h3>
                <p className="og-panel-desc">
                  Download a pre-formatted Excel workbook customized for this test. It includes student data entry columns, the official Cambridge mark scheme reference, and scoring rules.
                </p>

                <div className="og-download-card">
                  <div className="og-download-specs">
                    <span className="og-spec-tag">📄 3 Pre-configured Sheets</span>
                    <span className="og-spec-tag">🎯 {columns.length} Question Items</span>
                    <span className="og-spec-tag">🔑 Reference Key Included</span>
                  </div>

                  <button
                    type="button"
                    className="og-btn og-btn--secondary"
                    onClick={handleDownloadTemplate}
                  >
                    <span>📥</span> Download Excel Template (.xlsx)
                  </button>
                </div>
              </div>

              {/* Right Panel: Upload Filled File */}
              <div className="og-panel">
                <h3 className="og-panel-title">
                  <span>📤</span> 2. Upload Filled Responses
                </h3>
                <p className="og-panel-desc">
                  Upload the completed spreadsheet. Testmaker will auto-grade all chemical formulas, calculations, MCQs, and keywords instantly.
                </p>

                <div
                  className="og-dropzone"
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (e.dataTransfer.files?.[0]) {
                      handleFileUpload(e.dataTransfer.files[0]);
                    }
                  }}
                >
                  <span className="og-dropzone-icon">📁</span>
                  <h4 className="og-dropzone-title">Click to browse or drag & drop</h4>
                  <p className="og-dropzone-hint">Supports .xlsx, .xls, or .csv</p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      if (e.target.files?.[0]) {
                        handleFileUpload(e.target.files[0]);
                      }
                    }}
                  />
                </div>
              </div>
            </div>
          )}

          {currentStep === 'entry' && activeTab === 'grid' && (
            <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <div className="og-grid-toolbar">
                <p style={{ margin: 0, fontSize: '0.875rem', color: '#64748b' }}>
                  💡 Tip: Type candidate name in the last row to <strong>automatically add a new row</strong>. Use <strong>Tab</strong> to move between columns.
                </p>

                <div className="og-grid-actions">
                  <button
                    type="button"
                    className="og-btn og-btn--secondary"
                    onClick={handlePasteClipboard}
                    title="Paste student list copied from Excel or Google Sheets (Tab-separated)"
                  >
                    📋 Paste from Excel/Sheets
                  </button>
                  <button type="button" className="og-btn og-btn--secondary" onClick={handleAddGridRow}>
                    + Add Candidate Row
                  </button>
                  <button
                    type="button"
                    className="og-btn og-btn--primary"
                    onClick={handleAutoGradeGrid}
                    disabled={isProcessing}
                  >
                    ⚡ Auto-Grade Grid Responses
                  </button>
                </div>
              </div>

              <div className="og-table-scroll">
                <table className="og-table">
                  <thead>
                    <tr>
                      <th className="og-col-sticky-action">#</th>
                      <th className="og-col-sticky-name">Candidate Name</th>
                      <th style={{ minWidth: '110px' }}>Class</th>
                      <th style={{ minWidth: '90px' }}>ID / Seat</th>
                      {columns.map((col) => (
                        <th key={col.id} style={{ minWidth: '110px' }} title={col.questionStem}>
                          <div>{col.columnKey}</div>
                          <div style={{ fontSize: '0.7rem', fontWeight: 500, color: '#64748b' }}>
                            {col.maxMarks}m • {col.questionStyle === 'Multiple Choice' ? 'MCQ' : 'Part'}
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {gridRows.map((row, rIdx) => (
                      <tr key={row.rowNumber}>
                        <td className="og-col-sticky-action">
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                            <span style={{ color: '#94a3b8', fontWeight: 600, fontSize: '0.8rem' }}>{rIdx + 1}</span>
                            {gridRows.length > 1 && (
                              <button
                                type="button"
                                className="og-row-del-btn"
                                onClick={() => handleDeleteGridRow(rIdx)}
                                title="Remove candidate row"
                              >
                                ✕
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="og-col-sticky-name">
                          <input
                            type="text"
                            className="og-cell-input"
                            placeholder="e.g. John Smith"
                            value={row.studentName}
                            onChange={(e) => handleGridMetadataChange(rIdx, 'studentName', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            className="og-cell-input"
                            placeholder="10-A"
                            value={row.studentClass}
                            onChange={(e) => handleGridMetadataChange(rIdx, 'studentClass', e.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            className="og-cell-input"
                            placeholder="001"
                            value={row.candidateNumber}
                            onChange={(e) => handleGridMetadataChange(rIdx, 'candidateNumber', e.target.value)}
                          />
                        </td>
                        {columns.map((col) => (
                          <td key={col.id}>
                            <input
                              type="text"
                              className="og-cell-input"
                              placeholder={col.questionStyle === 'Multiple Choice' ? 'A-D' : 'Ans / Mark'}
                              value={row.answers[col.id] ?? ''}
                              onChange={(e) => handleGridCellChange(rIdx, col.id, e.target.value)}
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════════════════
              STEP 2: REVIEW & VERIFICATION PHASE
             ═══════════════════════════════════════════════════════════════════ */}
          {currentStep === 'review' && (
            <div className="animate-fade-in">
              {/* Cohort Metrics Banner */}
              {stats && (
                <div className="og-stats-row">
                  <div className="og-stat-card">
                    <span className="og-stat-label">Total Candidates</span>
                    <span className="og-stat-val">{stats.count}</span>
                  </div>
                  <div className="og-stat-card">
                    <span className="og-stat-label">Class Average</span>
                    <span className="og-stat-val" style={{ color: '#2563eb' }}>
                      {stats.avgScore} / {totalMarks} ({stats.avgPct}%)
                    </span>
                  </div>
                  <div className="og-stat-card">
                    <span className="og-stat-label">Highest Score</span>
                    <span className="og-stat-val" style={{ color: '#16a34a' }}>
                      {stats.highest} / {totalMarks}
                    </span>
                  </div>
                  <div className="og-stat-card">
                    <span className="og-stat-label">Lowest Score</span>
                    <span className="og-stat-val" style={{ color: '#dc2626' }}>
                      {stats.lowest} / {totalMarks}
                    </span>
                  </div>
                  <div className="og-stat-card">
                    <span className="og-stat-label">Pass Rate (≥50%)</span>
                    <span className="og-stat-val">{stats.passRate}%</span>
                  </div>
                </div>
              )}

              {/* Review Table Header & AI Grading Trigger */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '0.75rem',
                  flexWrap: 'wrap',
                  gap: '0.5rem',
                }}
              >
                <div style={{ fontSize: '0.875rem', color: '#475569' }}>
                  Showing auto-graded results. Click any question badge to override marks.
                </div>

                <button
                  type="button"
                  className="og-btn og-btn--secondary"
                  style={{ fontSize: '0.8125rem', padding: '0.45rem 0.85rem' }}
                  onClick={handleBatchAiGrading}
                  disabled={isProcessing}
                >
                  ✨ Run Gemini AI on Descriptive Answers
                </button>
              </div>

              {/* Graded Candidates Table */}
              <div className="og-table-scroll">
                <table className="og-table">
                  <thead>
                    <tr>
                      <th className="og-col-sticky-action">#</th>
                      <th className="og-col-sticky-name">Candidate</th>
                      <th style={{ minWidth: '90px' }}>Class</th>
                      <th style={{ minWidth: '90px' }}>Score</th>
                      <th style={{ minWidth: '70px' }}>%</th>
                      <th style={{ minWidth: '70px' }}>Grade</th>
                      {columns.map((col) => (
                        <th key={col.id} style={{ minWidth: '110px' }}>
                          <div>{col.columnKey}</div>
                          <div style={{ fontSize: '0.7rem', color: '#64748b' }}>Max {col.maxMarks}m</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {gradedSubmissions.map((sub, sIdx) => {
                      const grade =
                        sub.percentage >= 90
                          ? 'A*'
                          : sub.percentage >= 80
                          ? 'A'
                          : sub.percentage >= 70
                          ? 'B'
                          : sub.percentage >= 60
                          ? 'C'
                          : sub.percentage >= 50
                          ? 'D'
                          : sub.percentage >= 40
                          ? 'E'
                          : 'U';

                      const gradeColor =
                        grade === 'A*' || grade === 'A'
                          ? '#16a34a'
                          : grade === 'B'
                          ? '#2563eb'
                          : grade === 'C'
                          ? '#d97706'
                          : '#dc2626';

                      return (
                        <tr key={sub.id}>
                          <td className="og-col-sticky-action" style={{ color: '#94a3b8', fontWeight: 600 }}>{sIdx + 1}</td>
                          <td className="og-col-sticky-name" style={{ fontWeight: 600, color: '#0f172a' }}>{sub.studentName}</td>
                          <td style={{ color: '#64748b' }}>{sub.studentClass}</td>
                          <td style={{ fontWeight: 700, color: '#1e293b' }}>
                            {sub.score} / {totalMarks}
                          </td>
                          <td style={{ fontWeight: 600 }}>{sub.percentage}%</td>
                          <td>
                            <span
                              className="og-grade-pill"
                              style={{ background: `${gradeColor}15`, color: gradeColor }}
                            >
                              {grade}
                            </span>
                          </td>

                          {columns.map((col) => {
                            const qr = sub.questionResults.find((q) => q.questionId === col.id);
                            const earned = qr ? qr.earnedMarks : 0;
                            const isFull = qr?.isCorrect;
                            const isZero = earned === 0;

                            const isEditing =
                              editingCell?.subId === sub.id && editingCell?.qId === col.id;

                            return (
                              <td key={col.id}>
                                {isEditing ? (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                                    <input
                                      type="number"
                                      min={0}
                                      max={col.maxMarks}
                                      autoFocus
                                      defaultValue={earned}
                                      style={{
                                        width: '50px',
                                        padding: '2px 4px',
                                        border: '1px solid #2563eb',
                                        borderRadius: '4px',
                                        fontSize: '0.8rem',
                                      }}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                          handleOverrideMark(
                                            sub.id,
                                            col.id,
                                            Number((e.target as HTMLInputElement).value)
                                          );
                                        } else if (e.key === 'Escape') {
                                          setEditingCell(null);
                                        }
                                      }}
                                      onBlur={(e) => {
                                        handleOverrideMark(
                                          sub.id,
                                          col.id,
                                          Number(e.target.value)
                                        );
                                      }}
                                    />
                                    <span style={{ fontSize: '0.75rem', color: '#64748b' }}>/{col.maxMarks}</span>
                                  </div>
                                ) : (
                                  <div
                                    style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}
                                    onClick={() => setEditingCell({ subId: sub.id, qId: col.id })}
                                    title={`Click to adjust marks. Student answer: "${qr?.studentAnswer || '-'}" | Feedback: ${qr?.aiFeedback || '-'}`}
                                  >
                                    <span
                                      className={`og-mark-badge ${
                                        isFull
                                          ? 'og-mark-badge--full'
                                          : isZero
                                          ? 'og-mark-badge--zero'
                                          : 'og-mark-badge--partial'
                                      }`}
                                    >
                                      {earned}/{col.maxMarks}
                                    </span>
                                    <span
                                      style={{
                                        fontSize: '0.72rem',
                                        color: '#64748b',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                        maxWidth: '100px',
                                      }}
                                    >
                                      {qr?.studentAnswer || '—'}
                                    </span>
                                  </div>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════════════════════
              STEP 3: SAVED SUCCESS SCREEN
             ═══════════════════════════════════════════════════════════════════ */}
          {currentStep === 'success' && (
            <div className="og-success-wrap animate-fade-in">
              <span className="og-success-icon">🎉</span>
              <h3 className="og-success-title">Offline Exam Saved to Gradebook!</h3>
              <p className="og-success-desc">
                {gradedSubmissions.length} student scripts have been registered under{' '}
                <strong>{savedQuiz?.title || 'Offline Exam'}</strong>. You can now download individual
                Cambridge diagnostic report cards, print class reports, or view analytics.
              </p>

              <div className="og-success-actions">
                {savedQuiz && onViewInGradebook && (
                  <button
                    type="button"
                    className="og-btn og-btn--primary"
                    onClick={() => {
                      onClose();
                      onViewInGradebook(savedQuiz);
                    }}
                  >
                    <span>📊</span> View in Quiz Manager / Gradebook
                  </button>
                )}

                <button
                  type="button"
                  className="og-btn og-btn--secondary"
                  onClick={() => {
                    exportClassQuizReportPdf(
                      savedQuiz || {
                        title: headerConfig.title || 'Offline Exam Assessment',
                        quizCode: 'OFFLINE',
                        totalMarks,
                        subject: headerConfig.subject,
                      },
                      gradedSubmissions
                    );
                  }}
                >
                  <span>📄</span> Download Class PDF Report
                </button>

                <button
                  type="button"
                  className="og-btn og-btn--secondary"
                  onClick={() => {
                    exportAllSubmissionsExcel(
                      headerConfig.title || 'Offline Exam Assessment',
                      'OFFLINE',
                      totalMarks,
                      gradedSubmissions
                    );
                  }}
                >
                  <span>📥</span> Download Excel Gradebook
                </button>

                <button type="button" className="og-btn og-btn--secondary" onClick={onClose}>
                  Done
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        {currentStep === 'review' && (
          <div className="og-footer">
            <div className="og-footer-left">
              <button
                type="button"
                className="og-btn og-btn--secondary"
                onClick={() => setCurrentStep('entry')}
              >
                ← Back / Re-Upload
              </button>

              <button
                type="button"
                className="og-btn og-btn--secondary"
                onClick={() => {
                  exportAllSubmissionsExcel(
                    headerConfig.title || 'Offline Assessment',
                    'OFFLINE',
                    totalMarks,
                    gradedSubmissions
                  );
                }}
              >
                <span>📥</span> Export Excel
              </button>
            </div>

            <div className="og-footer-right">
              <button
                type="button"
                className="og-btn og-btn--success"
                onClick={handleSaveToGradebook}
              >
                <span>💾</span> Save to Gradebook & Generate Reports
              </button>
            </div>
          </div>
        )}

        {/* Loading Spinner Banner */}
        {isProcessing && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(255, 255, 255, 0.85)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 50,
              gap: '1rem',
            }}
          >
            <div
              style={{
                width: '38px',
                height: '38px',
                border: '3px solid #cbd5e1',
                borderTopColor: '#2563eb',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite',
              }}
            />
            <span style={{ fontWeight: 600, color: '#1e293b', fontSize: '0.95rem' }}>
              {processingMessage || 'Processing…'}
            </span>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
