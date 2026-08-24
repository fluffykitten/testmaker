import { useState } from 'react';
import { createPortal } from 'react-dom';
import type { Question, CustomTest } from '../types/database';
import type { ExamHeaderConfig } from '../services/testBuilderService';
import { generateQuizCode } from '../services/quizCodeService';
import { exportOfflineInteractiveHtmlQuiz } from '../services/htmlQuizExportService';
import {
  exportCanvasMoodleQtiXml,
  exportGoogleFormsQuiz,
  exportKahootQuizizzCsv,
} from '../services/lmsExportService';
import './StudentShareModal.css';

interface StudentShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  headerConfig: ExamHeaderConfig;
  questions: Question[];
  testId?: string;
  onLaunchTestRun: () => void;
}

export function StudentShareModal({
  isOpen,
  onClose,
  headerConfig,
  questions,
  testId,
  onLaunchTestRun,
}: StudentShareModalProps) {
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  if (!isOpen) return null;

  const dummyTest: CustomTest = {
    id: testId || 'TEST_' + Math.random().toString(36).substring(2, 8).toUpperCase(),
    title: headerConfig.title || 'Examination Assessment',
    header_config: headerConfig,
    total_marks: questions.reduce((sum, q) => sum + (q.marks || 0), 0),
    question_ids: questions.map((q) => q.id),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const quizCode = generateQuizCode(dummyTest);
  const shareableUrl = `${window.location.origin}${window.location.pathname}?quiz=${quizCode}`;

  const handleCopyLink = () => {
    navigator.clipboard.writeText(shareableUrl);
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2000);
  };

  const handleCopyCode = () => {
    navigator.clipboard.writeText(quizCode);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  return createPortal(
    <div className="share-modal-backdrop animate-fade-in" onClick={onClose}>
      <div
        className="share-modal-card animate-scale-up"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="share-modal-header">
          <div className="share-modal-title-group">
            <span className="share-modal-icon">🔗</span>
            <div>
              <h2 className="share-modal-title">Share Quiz & LMS Export</h2>
              <p className="share-modal-subtitle">
                {headerConfig.title || 'Assessment'} • {questions.length} questions
              </p>
            </div>
          </div>

          <button
            type="button"
            className="share-modal-close"
            onClick={onClose}
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* Modal Content */}
        <div className="share-modal-body">
          {/* Section 1: Student Code & Web Link */}
          <div className="share-section-box">
            <h3 className="share-section-heading">🎓 1. Student Access Code & Link</h3>
            <p className="share-section-desc">
              Students can join directly without logging in by entering this code on the landing page or clicking the link.
            </p>

            <div className="share-code-display-row">
              <div className="quiz-code-badge-wrap">
                <span className="quiz-code-label">QUIZ CODE:</span>
                <span className="quiz-code-text">{quizCode}</span>
                <button
                  type="button"
                  className="quiz-code-copy-btn"
                  onClick={handleCopyCode}
                  title="Copy Quiz Code"
                >
                  {copiedCode ? '✓ Copied' : '📋 Copy'}
                </button>
              </div>

              <button
                type="button"
                className="sq-btn sq-btn-primary"
                onClick={onLaunchTestRun}
              >
                ▶️ Test-Run Quiz
              </button>
            </div>

            <div className="share-link-input-group">
              <input
                type="text"
                className="share-link-input"
                value={shareableUrl}
                readOnly
              />
              <button
                type="button"
                className="share-link-copy-btn"
                onClick={handleCopyLink}
              >
                {copiedLink ? '✓ Copied Link' : 'Copy Direct Link'}
              </button>
            </div>
          </div>

          {/* Section 2: Offline Standalone HTML */}
          <div className="share-section-box">
            <h3 className="share-section-heading">📦 2. Offline Standalone Quiz (.html)</h3>
            <p className="share-section-desc">
              Download a single self-contained HTML file to distribute via Google Classroom, WhatsApp, or flash drives. Works 100% offline with zero server requirements.
            </p>
            <button
              type="button"
              className="share-action-btn share-action-btn--html"
              onClick={() => exportOfflineInteractiveHtmlQuiz(headerConfig, questions)}
            >
              📥 Download Offline Interactive Quiz (.html)
            </button>
          </div>

          {/* Section 3: LMS & Digital Quiz Exporters */}
          <div className="share-section-box">
            <h3 className="share-section-heading">🌐 3. LMS & Online Quiz Platform Exports</h3>
            <p className="share-section-desc">
              Import this exam directly into Canvas, Moodle, Google Forms, or Kahoot.
            </p>

            <div className="share-lms-grid">
              {/* Canvas / Moodle QTI XML */}
              <div
                className="share-lms-card"
                onClick={() => exportCanvasMoodleQtiXml(headerConfig, questions)}
              >
                <div className="lms-icon">🏛️</div>
                <div className="lms-info">
                  <strong>Canvas / Moodle / Blackboard</strong>
                  <span>QTI 2.1 Standard Quiz XML Package</span>
                </div>
                <button type="button" className="lms-export-badge">Export QTI XML</button>
              </div>

              {/* Google Forms Import */}
              <div
                className="share-lms-card"
                onClick={() => exportGoogleFormsQuiz(headerConfig, questions)}
              >
                <div className="lms-icon">📝</div>
                <div className="lms-info">
                  <strong>Google Forms Quiz</strong>
                  <span>Form Builder payload with auto-grading</span>
                </div>
                <button type="button" className="lms-export-badge">Export Forms CSV</button>
              </div>

              {/* Kahoot / Quizizz Game */}
              <div
                className="share-lms-card"
                onClick={() => exportKahootQuizizzCsv(headerConfig, questions)}
              >
                <div className="lms-icon">🎮</div>
                <div className="lms-info">
                  <strong>Kahoot & Quizizz</strong>
                  <span>Spreadsheet for live classroom review games</span>
                </div>
                <button type="button" className="lms-export-badge">Export Kahoot CSV</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
