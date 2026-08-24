import { useState, useEffect } from 'react';
import type { Question } from '../types/database';
import {
  saveCustomTest,
  type ExamHeaderConfig,
} from '../services/testBuilderService';
import { TestHeaderEditor } from '../components/TestHeaderEditor';
import { TestQuestionItem } from '../components/TestQuestionItem';
import { TestStatsSidebar } from '../components/TestStatsSidebar';
import { TestPaperPreview } from '../components/TestPaperPreview';
import { ExportModal } from '../components/ExportModal';
import { QuestionEditorModal } from '../components/QuestionEditorModal';
import { QuestionVariantModal } from '../components/QuestionVariantModal';
import { SmartTestAssemblerModal } from '../components/SmartTestAssemblerModal';
import { StudentShareModal } from '../components/StudentShareModal';
import './TestBuilderPage.css';

interface TestBuilderPageProps {
  initialQuestions: Question[];
  onRemoveQuestion: (questionId: string) => void;
  onNavigateToBank: () => void;
  onLaunchTestRun?: (questions: Question[], headerConfig: ExamHeaderConfig) => void;
}

export function TestBuilderPage({
  initialQuestions,
  onRemoveQuestion,
  onNavigateToBank,
  onLaunchTestRun,
}: TestBuilderPageProps) {
  const [questions, setQuestions] = useState<Question[]>(initialQuestions);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedSuccessMsg, setSavedSuccessMsg] = useState<string | null>(null);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);
  const [variantQuestion, setVariantQuestion] = useState<Question | null>(null);
  const [isAssemblerOpen, setIsAssemblerOpen] = useState(false);

  // Sync questions if props change
  useEffect(() => {
    setQuestions(initialQuestions);
  }, [initialQuestions]);

  // Exam Header Settings
  const [headerConfig, setHeaderConfig] = useState<ExamHeaderConfig>({
    title: 'IGCSE Chemistry Practice Assessment',
    schoolName: '',
    subject: 'Chemistry',
    subjectCode: '0620',
    durationMinutes: 45,
    instructions: 'Answer all questions. Write your answers in the spaces provided on the question paper. You may use a calculator.',
    additionalMaterials: 'Periodic Table (enclosed)',
  });

  const totalMarks = questions.reduce((sum, q) => sum + (q.marks || 0), 0);
  const suggestedDuration = Math.round(totalMarks * 1.25);

  // Re-ordering
  const handleMoveUp = (index: number) => {
    if (index === 0) return;
    setQuestions((prev) => {
      const next = [...prev];
      const temp = next[index];
      next[index] = next[index - 1];
      next[index - 1] = temp;
      return next;
    });
  };

  const handleMoveDown = (index: number) => {
    if (index >= questions.length - 1) return;
    setQuestions((prev) => {
      const next = [...prev];
      const temp = next[index];
      next[index] = next[index + 1];
      next[index + 1] = temp;
      return next;
    });
  };

  const handleRemove = (qid: string) => {
    onRemoveQuestion(qid);
    setQuestions((prev) => prev.filter((q) => q.id !== qid));
  };

  // Save to Supabase & Local Storage
  const handleSaveTest = async () => {
    if (questions.length === 0) return;
    setIsSaving(true);
    setSavedSuccessMsg(null);

    try {
      const saved = await saveCustomTest({
        title: headerConfig.title || 'Custom Exam Test',
        totalMarks,
        questionIds: questions.map((q) => q.id),
        headerConfig,
      });

      setSavedSuccessMsg(`Custom exam saved successfully! (ID: ${saved.id.slice(0, 8)})`);
      setTimeout(() => setSavedSuccessMsg(null), 6000);
    } catch (err: any) {
      alert(`Save failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="builder-page">
      <div className="builder-container">
        {/* ─── Page Header ─────────────────────────────────────────────────── */}
        <div className="builder-top-header animate-fade-in no-print">
          <div>
            <h1 className="builder-title">Test Builder Workspace</h1>
            <p className="builder-subtitle">
              Arrange, customize, and preview your custom exam paper with live mark analytics and print layout.
            </p>
          </div>

          <div className="builder-view-switcher">
            <button
              type="button"
              className="builder-assemble-btn"
              onClick={() => setIsAssemblerOpen(true)}
              title="Automatically assemble exam matching target marks and topics"
            >
              ⚡ Auto-Assemble
            </button>

            <button
              type="button"
              className="builder-share-top-btn"
              onClick={() => setIsShareModalOpen(true)}
              disabled={questions.length === 0}
              title="Share Quiz code or export to Canvas/Moodle/Google Forms"
            >
              🔗 Share & LMS
            </button>

            {onLaunchTestRun && (
              <button
                type="button"
                className="builder-testrun-top-btn"
                onClick={() => onLaunchTestRun(questions, headerConfig)}
                disabled={questions.length === 0}
                title="Launch interactive student test-run simulation"
              >
                ▶️ Test-Run Quiz
              </button>
            )}

            <button
              type="button"
              className="builder-export-top-btn"
              onClick={() => setIsExportModalOpen(true)}
              disabled={questions.length === 0}
            >
              📄 Export Word/PDF
            </button>
            <button
              type="button"
              className={`builder-switch-btn ${!isPreviewMode ? 'builder-switch-btn--active' : ''}`}
              onClick={() => setIsPreviewMode(false)}
            >
              ✏️ Editor
            </button>
            <button
              type="button"
              className={`builder-switch-btn ${isPreviewMode ? 'builder-switch-btn--active' : ''}`}
              onClick={() => setIsPreviewMode(true)}
            >
              👁️ Paper Preview
            </button>
          </div>
        </div>

        {/* Success Alert */}
        {savedSuccessMsg && (
          <div className="builder-success-banner animate-slide-up no-print">
            <div className="builder-success-text">
              <span>✓</span> {savedSuccessMsg}
            </div>
            <button
              type="button"
              className="builder-export-shortcut-btn"
              onClick={() => setIsExportModalOpen(true)}
            >
              Export Exam (.docx/PDF) →
            </button>
          </div>
        )}

        {/* ─── Empty State ─────────────────────────────────────────────────── */}
        {questions.length === 0 ? (
          <div className="builder-empty animate-fade-in">
            <div className="builder-empty-icon">📝</div>
            <h2 className="builder-empty-title">Your Test Workspace is Empty</h2>
            <p className="builder-empty-desc">
              You haven't selected any questions for this custom exam yet.
              Browse the Question Bank, or use the <strong>Smart Auto-Assembler</strong> to generate a complete paper in seconds.
            </p>
            <div className="builder-empty-actions">
              <button
                type="button"
                className="builder-btn-assemble"
                onClick={() => setIsAssemblerOpen(true)}
              >
                ⚡ Auto-Assemble with Criteria
              </button>
              <button
                type="button"
                className="builder-btn-secondary"
                onClick={onNavigateToBank}
              >
                ← Go to Question Bank
              </button>
            </div>
          </div>
        ) : (
          /* ─── Workspace Layout ─────────────────────────────────────────────── */
          isPreviewMode ? (
            <TestPaperPreview
              headerConfig={headerConfig}
              questions={questions}
              totalMarks={totalMarks}
            />
          ) : (
            <div className="builder-grid">
              {/* Left Column: Header Editor + Question List */}
              <div className="builder-main-column">
                <TestHeaderEditor
                  config={headerConfig}
                  onChange={setHeaderConfig}
                  suggestedDuration={suggestedDuration}
                />

                <div className="builder-questions-section">
                  <div className="builder-section-header">
                    <h3 className="builder-section-title">
                      Exam Questions ({questions.length} items • {totalMarks} marks)
                    </h3>
                    <span className="builder-section-hint">
                      Use ▲ ▼ to reorder questions
                    </span>
                  </div>

                  <div className="builder-questions-list">
                    {questions.map((q, idx) => (
                      <TestQuestionItem
                        key={q.id || idx}
                        question={q}
                        index={idx}
                        totalQuestions={questions.length}
                        onMoveUp={handleMoveUp}
                        onMoveDown={handleMoveDown}
                        onRemove={handleRemove}
                        onEdit={(target) => setEditingQuestion(target)}
                        onGenerateVariant={(target) => setVariantQuestion(target)}
                      />
                    ))}
                  </div>
                </div>
              </div>

              {/* Right Column: Sticky Live Analytics Sidebar */}
              <div className="builder-sidebar-column">
                <TestStatsSidebar
                  questions={questions}
                  onSaveTest={handleSaveTest}
                  isSaving={isSaving}
                  onNavigateToBank={onNavigateToBank}
                  onTogglePreviewMode={() => setIsPreviewMode(!isPreviewMode)}
                  isPreviewMode={isPreviewMode}
                  onOpenExportModal={() => setIsExportModalOpen(true)}
                />
              </div>
            </div>
          )
        )}
      </div>

      {/* Question Variant Generator Modal */}
      <QuestionVariantModal
        isOpen={!!variantQuestion}
        question={variantQuestion}
        onClose={() => setVariantQuestion(null)}
        onAddToTest={(newVariant) => {
          setQuestions((prev) => [...prev, newVariant]);
          setSavedSuccessMsg(`✨ Variant question ${newVariant.question_number} added to exam!`);
          setTimeout(() => setSavedSuccessMsg(null), 3000);
        }}
        onSaveToBank={(newVariant) => {
          setQuestions((prev) => [...prev, newVariant]);
          setSavedSuccessMsg(`✨ Variant question ${newVariant.question_number} saved & added to exam!`);
          setTimeout(() => setSavedSuccessMsg(null), 3000);
        }}
        onOpenInEditor={(newVariant) => {
          setVariantQuestion(null);
          setEditingQuestion(newVariant);
        }}
      />

      {/* Smart Test Auto-Assembler Modal */}
      <SmartTestAssemblerModal
        isOpen={isAssemblerOpen}
        onClose={() => setIsAssemblerOpen(false)}
        onLoadIntoBuilder={(assembled) => {
          setQuestions(assembled);
          const totalM = assembled.reduce((sum, q) => sum + (q.marks || 1), 0);
          setSavedSuccessMsg(`⚡ Auto-assembled ${assembled.length} questions (${totalM} marks) loaded into custom test!`);
          setTimeout(() => setSavedSuccessMsg(null), 4000);
        }}
      />

      {/* Question Editor Modal */}
      <QuestionEditorModal
        isOpen={!!editingQuestion}
        question={editingQuestion}
        onClose={() => setEditingQuestion(null)}
        onSave={(savedQuestion) => {
          setQuestions((prev) => {
            const exists = prev.some((q) => q.id === savedQuestion.id);
            if (exists) {
              return prev.map((q) => (q.id === savedQuestion.id ? savedQuestion : q));
            }
            return [...prev, savedQuestion];
          });
          setSavedSuccessMsg(`Question ${savedQuestion.question_number} updated in custom exam.`);
          setTimeout(() => setSavedSuccessMsg(null), 3000);
        }}
      />

      {/* Student Share & LMS Export Modal */}
      <StudentShareModal
        isOpen={isShareModalOpen}
        onClose={() => setIsShareModalOpen(false)}
        headerConfig={headerConfig}
        questions={questions}
        onLaunchTestRun={() => {
          setIsShareModalOpen(false);
          if (onLaunchTestRun) onLaunchTestRun(questions, headerConfig);
        }}
      />

      {/* Export Modal */}
      <ExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        headerConfig={headerConfig}
        questions={questions}
      />
    </div>
  );
}
