import { useState } from 'react';
import type { Question } from '../types/database';
import './TestStatsSidebar.css';

interface TestStatsSidebarProps {
  questions: Question[];
  onSaveTest: () => void;
  isSaving: boolean;
  onNavigateToBank: () => void;
  onTogglePreviewMode: () => void;
  isPreviewMode: boolean;
  onOpenExportModal: () => void;
}

export function TestStatsSidebar({
  questions,
  onSaveTest,
  isSaving,
  onNavigateToBank,
  onTogglePreviewMode,
  isPreviewMode,
  onOpenExportModal,
}: TestStatsSidebarProps) {
  const [targetMarks, setTargetMarks] = useState<number>(50);

  // Calculations
  const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0);
  const totalQuestions = questions.length;
  const estimatedMins = Math.round(totalMarks * 1.25);

  // Difficulty breakdown
  const diffCounts = { Easy: 0, Medium: 0, Hard: 0 };
  questions.forEach((q) => {
    if (q.difficulty === 'Easy') diffCounts.Easy += q.marks;
    else if (q.difficulty === 'Hard') diffCounts.Hard += q.marks;
    else diffCounts.Medium += q.marks;
  });

  const easyPct = totalMarks > 0 ? Math.round((diffCounts.Easy / totalMarks) * 100) : 0;
  const medPct = totalMarks > 0 ? Math.round((diffCounts.Medium / totalMarks) * 100) : 0;
  const hardPct = totalMarks > 0 ? Math.round((diffCounts.Hard / totalMarks) * 100) : 0;

  // Topic breakdown
  const topicCounts = new Map<string, number>();
  questions.forEach((q) => {
    const current = topicCounts.get(q.topic) || 0;
    topicCounts.set(q.topic, current + q.marks);
  });

  const markProgressPct = Math.min(100, Math.round((totalMarks / targetMarks) * 100));

  return (
    <aside className="test-sidebar">
      {/* ─── Summary Header ─────────────────────────────────────────────────── */}
      <div className="test-sidebar-card">
        <h3 className="test-sidebar-title">Exam Summary</h3>

        {/* Total Marks Tally */}
        <div className="test-stat-box">
          <div className="test-stat-header">
            <span className="test-stat-label">Total Marks</span>
            <span className="test-stat-value">
              <strong className="text-primary">{totalMarks}</strong> / {targetMarks}
            </span>
          </div>

          <div className="test-progress-track">
            <div
              className={`test-progress-fill ${totalMarks >= targetMarks ? 'test-progress-fill--complete' : ''}`}
              style={{ width: `${markProgressPct}%` }}
            />
          </div>

          <div className="test-target-row">
            <label htmlFor="target-marks-input" className="test-target-label">Target:</label>
            <input
              id="target-marks-input"
              type="number"
              min="10"
              max="200"
              className="test-target-input"
              value={targetMarks}
              onChange={(e) => setTargetMarks(parseInt(e.target.value) || ('' as any))}
            />
            <span className="test-target-unit">marks</span>
          </div>
        </div>

        {/* Quick Metrics */}
        <div className="test-metrics-grid">
          <div className="test-metric-item">
            <span className="test-metric-val">{totalQuestions}</span>
            <span className="test-metric-lbl">Questions</span>
          </div>

          <div className="test-metric-item">
            <span className="test-metric-val">~{estimatedMins}m</span>
            <span className="test-metric-lbl">Est. Time</span>
          </div>
        </div>
      </div>

      {/* ─── Difficulty Balance ─────────────────────────────────────────────── */}
      <div className="test-sidebar-card">
        <h4 className="test-sidebar-subtitle">Difficulty Balance</h4>

        {totalMarks > 0 ? (
          <div className="test-diff-container">
            {/* Multi-segment progress bar */}
            <div className="test-diff-bar">
              {easyPct > 0 && (
                <div
                  className="test-diff-seg test-diff-seg--easy"
                  style={{ width: `${easyPct}%` }}
                  title={`Easy: ${easyPct}% (${diffCounts.Easy} marks)`}
                />
              )}
              {medPct > 0 && (
                <div
                  className="test-diff-seg test-diff-seg--med"
                  style={{ width: `${medPct}%` }}
                  title={`Medium: ${medPct}% (${diffCounts.Medium} marks)`}
                />
              )}
              {hardPct > 0 && (
                <div
                  className="test-diff-seg test-diff-seg--hard"
                  style={{ width: `${hardPct}%` }}
                  title={`Hard: ${hardPct}% (${diffCounts.Hard} marks)`}
                />
              )}
            </div>

            <div className="test-diff-legend">
              <span className="test-diff-tag test-diff-tag--easy">
                🟢 {easyPct}% Easy ({diffCounts.Easy}m)
              </span>
              <span className="test-diff-tag test-diff-tag--med">
                🟡 {medPct}% Medium ({diffCounts.Medium}m)
              </span>
              <span className="test-diff-tag test-diff-tag--hard">
                🔴 {hardPct}% Hard ({diffCounts.Hard}m)
              </span>
            </div>
          </div>
        ) : (
          <p className="test-sidebar-muted">No questions selected yet.</p>
        )}
      </div>

      {/* ─── Topic Coverage ─────────────────────────────────────────────────── */}
      <div className="test-sidebar-card">
        <h4 className="test-sidebar-subtitle">Topic Coverage</h4>

        {topicCounts.size > 0 ? (
          <div className="test-topics-list">
            {Array.from(topicCounts.entries()).map(([topic, marks]) => (
              <div key={topic} className="test-topic-row">
                <span className="test-topic-name" title={topic}>{topic}</span>
                <span className="test-topic-marks">{marks}m</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="test-sidebar-muted">Add questions to see topic spread.</p>
        )}
      </div>

      {/* ─── Workspace Actions ──────────────────────────────────────────────── */}
      <div className="test-sidebar-actions">
        <button
          type="button"
          className="test-action-btn test-action-btn--export"
          onClick={onOpenExportModal}
          disabled={totalQuestions === 0}
          id="export-exam-btn"
        >
          ⚡ Export Exam (.docx & PDF)
        </button>

        <button
          type="button"
          className="test-action-btn test-action-btn--preview"
          onClick={onTogglePreviewMode}
          id="toggle-paper-preview-btn"
        >
          {isPreviewMode ? '✏️ Return to Editor' : '👁️ View Print-Ready Paper'}
        </button>

        <button
          type="button"
          className="test-action-btn test-action-btn--save"
          onClick={onSaveTest}
          disabled={isSaving || totalQuestions === 0}
          id="save-custom-test-btn"
        >
          {isSaving ? 'Saving…' : '💾 Save Custom Test'}
        </button>

        <button
          type="button"
          className="test-action-btn test-action-btn--add"
          onClick={onNavigateToBank}
        >
          + Add More Questions from Bank
        </button>
      </div>
    </aside>
  );
}
