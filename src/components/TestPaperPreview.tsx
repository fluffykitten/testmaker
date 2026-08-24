import type { Question } from '../types/database';
import type { ExamHeaderConfig } from '../services/testBuilderService';
import { ExamMathText } from './ExamMathText';
import { parseMcqOption } from '../utils/mcqUtils';
import './TestPaperPreview.css';

interface TestPaperPreviewProps {
  headerConfig: ExamHeaderConfig;
  questions: Question[];
  totalMarks: number;
}

export function TestPaperPreview({
  headerConfig,
  questions,
  totalMarks,
}: TestPaperPreviewProps) {
  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="paper-preview-wrapper animate-fade-in">
      {/* Print Controls Bar (hidden during actual print) */}
      <div className="paper-print-bar no-print">
        <div className="paper-print-bar-info">
          <span>📄 Print-Ready Paper Preview ({questions.length} questions • {totalMarks} marks)</span>
        </div>
        <button
          type="button"
          className="paper-print-btn"
          onClick={handlePrint}
          id="print-paper-btn"
        >
          🖨️ Print / Save as PDF
        </button>
      </div>

      {/* ─── Printable Exam Sheet ─────────────────────────────────────────── */}
      <div className="exam-paper-sheet">
        {/* Cover / Header Section */}
        <header className="exam-paper-header">
          {headerConfig.schoolName && (
            <div className="exam-school-name">{headerConfig.schoolName}</div>
          )}

          {/* Candidate identification header */}
          <div className="exam-candidate-box">
            <div className="exam-cand-row">
              <div className="exam-cand-field exam-cand-field--name">
                <span className="exam-cand-label">NAME:</span>
                <div className="exam-cand-line" />
              </div>

              <div className="exam-cand-field exam-cand-field--class">
                <span className="exam-cand-label">CLASS:</span>
                <div className="exam-cand-line" />
              </div>

              <div className="exam-cand-field exam-cand-field--date">
                <span className="exam-cand-label">DATE:</span>
                <div className="exam-cand-line" />
              </div>
            </div>
          </div>

          <div className="exam-divider" />

          {/* Title & Metadata */}
          <div className="exam-meta-block">
            <div className="exam-meta-left">
              <h1 className="exam-title-text">{headerConfig.title}</h1>
              {headerConfig.subject && (
                <div className="exam-subject-text">
                  {headerConfig.subject} {headerConfig.subjectCode ? `(${headerConfig.subjectCode})` : ''}
                </div>
              )}
            </div>

            <div className="exam-meta-right">
              <div className="exam-time-text">{headerConfig.durationMinutes} minutes</div>
              <div className="exam-marks-total-box">
                Total Marks: <strong>{totalMarks}</strong>
              </div>
            </div>
          </div>

          {/* Instructions Box */}
          <div className="exam-instructions-box">
            <p className="exam-inst-title">INSTRUCTIONS</p>
            <ul className="exam-inst-list">
              <li>{headerConfig.instructions}</li>
              {headerConfig.additionalMaterials && (
                <li>Additional materials: {headerConfig.additionalMaterials}</li>
              )}
              <li>The number of marks for each question or part question is shown in brackets [ ].</li>
            </ul>
          </div>
        </header>

        {/* ─── Question Stream ─────────────────────────────────────────────── */}
        <main className="exam-question-stream">
          {questions.map((q, idx) => (
            <section key={q.id || idx} className="exam-q-section">
              {/* Question Number & Stem */}
              <div className="exam-q-row">
                <span className="exam-q-num">{idx + 1}</span>
                <div className="exam-q-content">
                  <div className="exam-q-stem">
                    <ExamMathText content={q.question_text} />
                  </div>

                  {/* Diagram */}
                  {q.diagram_url && (
                    <div className="exam-q-diagram">
                      <img src={q.diagram_url} alt={`Diagram ${idx + 1}`} />
                    </div>
                  )}

                  {/* MCQ Options */}
                  {q.options && q.options.length > 0 && (
                    <div className="exam-mcq-table">
                      {q.options.map((opt, oi) => {
                        const { letter, text } = parseMcqOption(opt, oi);
                        return (
                          <div key={oi} className="exam-mcq-row" style={{ display: 'flex', alignItems: 'baseline', gap: '14px' }}>
                            <span style={{ fontWeight: 'bold', minWidth: '22px', color: '#1e293b' }}>{letter}</span>
                            <div style={{ flex: 1 }}>
                              <ExamMathText content={text} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Structured Sub-Questions */}
                  {q.sub_questions && q.sub_questions.length > 0 ? (
                    <div className="exam-sub-stream">
                      {q.sub_questions.map((sub, si) => (
                        <div key={si} className="exam-sub-block">
                          <div className="exam-sub-row">
                            <span className="exam-sub-id">{sub.sub_id}</span>
                            <div className="exam-sub-text">
                              <ExamMathText content={sub.question_text} />
                            </div>
                            <span className="exam-mark-right">[{sub.marks}]</span>
                          </div>

                          {/* Student Answer Lines */}
                          <div className="exam-answer-lines">
                            {Array.from({ length: Math.min(6, Math.max(2, (sub.marks || 1) * 2)) }).map((_, li) => (
                              <div key={li} className="exam-line" />
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    /* Single question answer lines if not MCQ */
                    !q.options || q.options.length === 0 ? (
                      <div className="exam-answer-lines">
                        {Array.from({ length: Math.min(6, Math.max(2, (q.marks || 1) * 2)) }).map((_, li) => (
                          <div key={li} className="exam-line" />
                        ))}
                      </div>
                    ) : null
                  )}

                  {/* Question Total Marks Footer */}
                  <div className="exam-q-total-row">
                    <span className="exam-q-total-badge">[Total: {q.marks}]</span>
                  </div>
                </div>
              </div>
            </section>
          ))}
        </main>
      </div>
    </div>
  );
}
