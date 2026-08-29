import { useState, useEffect } from 'react';
import type { Question, Syllabus } from '../types/database';
import {
  saveCustomTest,
  type ExamHeaderConfig,
} from '../services/testBuilderService';
import { fetchSyllabuses } from '../services/questionBankService';
import { TestHeaderEditor } from '../components/TestHeaderEditor';
import { TestQuestionItem } from '../components/TestQuestionItem';
import { TestStatsSidebar } from '../components/TestStatsSidebar';
import { TestPaperPreview } from '../components/TestPaperPreview';
import { ExportModal } from '../components/ExportModal';
import { QuestionEditorModal } from '../components/QuestionEditorModal';
import { QuestionVariantModal } from '../components/QuestionVariantModal';
import { SmartTestAssemblerModal } from '../components/SmartTestAssemblerModal';
import { StudentShareModal } from '../components/StudentShareModal';
import { BatchAudioModal } from '../components/BatchAudioModal';
import './TestBuilderPage.css';

/**
 * Intelligent helper to detect the predominant subject, syllabus code, and default materials from exam questions
 */
function inferSubjectFromQuestions(
  questions: Question[],
  syllabuses: Syllabus[] = []
): {
  subject: string;
  subjectCode: string;
  defaultTitle: string;
  additionalMaterials: string;
  instructions: string;
} {
  if (!questions || questions.length === 0) {
    return {
      subject: 'Geography',
      subjectCode: '0460',
      defaultTitle: 'IGCSE Geography Practice Assessment',
      additionalMaterials: 'An Insert (enclosed)',
      instructions: 'Answer all questions. Write in dark blue or black pen. You may use an HB pencil for any diagrams or graphs. You may use a calculator. The Insert contains additional resources for some questions.',
    };
  }

  // 1. Check syllabus_id counts
  const syllabusCounts = new Map<string, number>();
  for (const q of questions) {
    if (q.syllabus_id) {
      syllabusCounts.set(q.syllabus_id, (syllabusCounts.get(q.syllabus_id) || 0) + 1);
    }
  }

  let topSyllabusId: string | null = null;
  let maxCount = 0;
  for (const [sId, count] of syllabusCounts.entries()) {
    if (count > maxCount) {
      maxCount = count;
      topSyllabusId = sId;
    }
  }

  if (topSyllabusId) {
    const matched = syllabuses.find((s) => s.id === topSyllabusId);
    if (matched) {
      const isGeo = /geograph/i.test(matched.subject_name) || matched.subject_code === '0460';
      const isChem = /chem/i.test(matched.subject_name) || matched.subject_code === '0620';
      const isPhys = /phys/i.test(matched.subject_name) || matched.subject_code === '0625';

      let materials = '';
      if (isChem) materials = 'Periodic Table (enclosed)';
      else if (isGeo) materials = 'An Insert (enclosed)';
      else if (isPhys) materials = 'Calculator, ruler';

      let instructions = 'Answer all questions. Write your answers in the spaces provided on the question paper. You may use a calculator.';
      if (isGeo) {
        instructions = 'Answer all questions. Write in dark blue or black pen. You may use an HB pencil for any diagrams or graphs. You may use a calculator. The Insert contains additional resources for some questions.';
      }

      return {
        subject: matched.subject_name,
        subjectCode: matched.subject_code,
        defaultTitle: `IGCSE ${matched.subject_name} Practice Assessment`,
        additionalMaterials: materials,
        instructions,
      };
    }
  }

  // 2. Topic & Content-based detection fallback
  const allText = questions
    .map((q) => `${q.topic || ''} ${q.sub_topic || ''} ${q.question_text || ''}`)
    .join(' ')
    .toLowerCase();

  // English, Languages & IELTS
  if (/english|ielts|toefl|listening|reading|comprehension|passage|grammar|vocabulary|literature|writing|essay|dialogue|conversation|cloze|tka|akm|bahasa inggris|indonesian|spanish|french/i.test(allText)) {
    return {
      subject: 'English',
      subjectCode: '0500',
      defaultTitle: 'English Practice Assessment',
      additionalMaterials: 'Listening Equipment / Insert (if applicable)',
      instructions: 'Answer all questions. Write your answers in the spaces provided on the question paper.',
    };
  }

  // Geography
  if (/geograph|population|tectonic|earthquake|volcano|weather|climate|river|coast|settlement|migration|urban|landform/i.test(allText)) {
    return {
      subject: 'Geography',
      subjectCode: '0460',
      defaultTitle: 'IGCSE Geography Practice Assessment',
      additionalMaterials: 'An Insert (enclosed)',
      instructions: 'Answer all questions. Write in dark blue or black pen. You may use an HB pencil for any diagrams or graphs. You may use a calculator. The Insert contains additional resources for some questions.',
    };
  }

  // Biology
  if (/biology|cell|photosynthesis|enzyme|respiration|organism|plant|digest|circulat|genetics|dna|ecosystem/i.test(allText)) {
    return {
      subject: 'Biology',
      subjectCode: '0610',
      defaultTitle: 'IGCSE Biology Practice Assessment',
      additionalMaterials: '',
      instructions: 'Answer all questions. Write your answers in the spaces provided on the question paper. You may use a calculator.',
    };
  }

  // Physics
  if (/physics|force|velocity|acceleration|energy|wave|refraction|lens|magnet|circuit|current|voltage|radioactivity/i.test(allText)) {
    return {
      subject: 'Physics',
      subjectCode: '0625',
      defaultTitle: 'IGCSE Physics Practice Assessment',
      additionalMaterials: 'Calculator, ruler',
      instructions: 'Answer all questions. Write your answers in the spaces provided on the question paper. You may use a calculator.',
    };
  }

  // Mathematics
  if (/math|algebra|geometry|calculus|trigonometry|matrix|fraction|probability|statistic|arithmetic|polynomial|vector/i.test(allText)) {
    return {
      subject: 'Mathematics',
      subjectCode: '0580',
      defaultTitle: 'IGCSE Mathematics Practice Assessment',
      additionalMaterials: 'Scientific Calculator, ruler, protractor, compass',
      instructions: 'Answer all questions. Write your answers in the spaces provided on the question paper. You must show all necessary working clearly.',
    };
  }

  // Economics
  if (/economic|business|account|inflation|gdp|finance|market|monopoly|trade|revenue|cost|elasticity|demand|supply/i.test(allText)) {
    return {
      subject: 'Economics',
      subjectCode: '0455',
      defaultTitle: 'IGCSE Economics Practice Assessment',
      additionalMaterials: '',
      instructions: 'Answer all questions. Write your answers in the spaces provided on the question paper. You may use a calculator.',
    };
  }

  // History
  if (/history|treaty|war|revolution|reich|cold war|league of nations|armistice|empire|colony/i.test(allText)) {
    return {
      subject: 'History',
      subjectCode: '0470',
      defaultTitle: 'IGCSE History Practice Assessment',
      additionalMaterials: 'An Insert (enclosed)',
      instructions: 'Answer all questions. Write your answers in the spaces provided on the question paper.',
    };
  }

  // Chemistry (Fallback default)
  return {
    subject: 'Chemistry',
    subjectCode: '0620',
    defaultTitle: 'IGCSE Chemistry Practice Assessment',
    additionalMaterials: 'Periodic Table (enclosed)',
    instructions: 'Answer all questions. Write your answers in the spaces provided on the question paper. You may use a calculator.',
  };
}

interface TestBuilderPageProps {
  initialQuestions: Question[];
  onRemoveQuestion: (questionId: string) => void;
  onNavigateToBank: () => void;
  onUpdateQuestions?: (questions: Question[]) => void;
  onLaunchTestRun?: (questions: Question[], headerConfig: ExamHeaderConfig) => void;
  onLaunchGameRun?: (questions: Question[], headerConfig: ExamHeaderConfig) => void;
}

export function TestBuilderPage({
  initialQuestions,
  onRemoveQuestion,
  onNavigateToBank,
  onUpdateQuestions,
  onLaunchTestRun,
  onLaunchGameRun,
}: TestBuilderPageProps) {
  const [questions, setQuestions] = useState<Question[]>(initialQuestions);
  const [syllabuses, setSyllabuses] = useState<Syllabus[]>([]);
  const [isPreviewMode, setIsPreviewMode] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [savedSuccessMsg, setSavedSuccessMsg] = useState<string | null>(null);
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [isShareModalOpen, setIsShareModalOpen] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);
  const [variantQuestion, setVariantQuestion] = useState<Question | null>(null);
  const [isAssemblerOpen, setIsAssemblerOpen] = useState(false);
  const [isBatchAudioModalOpen, setIsBatchAudioModalOpen] = useState(false);

  // Load syllabuses from Supabase
  useEffect(() => {
    fetchSyllabuses().then(setSyllabuses).catch(console.error);
  }, []);

  // Sync questions if props change
  useEffect(() => {
    setQuestions(initialQuestions);
  }, [initialQuestions]);

  // Exam Header Settings with session persistence
  const [headerConfig, setHeaderConfig] = useState<ExamHeaderConfig>(() => {
    try {
      const saved = sessionStorage.getItem('testmaker_builder_header_config');
      if (saved) return JSON.parse(saved);
    } catch {
      // ignore
    }
    const initialDetected = inferSubjectFromQuestions(initialQuestions);
    return {
      title: initialDetected.defaultTitle,
      schoolName: '',
      subject: initialDetected.subject,
      subjectCode: initialDetected.subjectCode,
      durationMinutes: 45,
      instructions: initialDetected.instructions,
      additionalMaterials: initialDetected.additionalMaterials,
    };
  });

  // Dynamically auto-adapt subject when questions or syllabuses change
  useEffect(() => {
    if (questions.length === 0) return;
    const detected = inferSubjectFromQuestions(questions, syllabuses);

    setHeaderConfig((prev) => {
      const prevSubject = (prev.subject || '').trim().toLowerCase();
      const detectedSubject = detected.subject.trim().toLowerCase();

      const isDefaultTitle =
        !prev.title ||
        (prev.title.startsWith('IGCSE ') && prev.title.endsWith('Practice Assessment'));

      const isSubjectMismatch =
        prevSubject !== detectedSubject &&
        (prevSubject === 'chemistry' || !prevSubject || isDefaultTitle);

      if (isSubjectMismatch) {
        return {
          ...prev,
          subject: detected.subject,
          subjectCode: detected.subjectCode,
          title: isDefaultTitle ? detected.defaultTitle : prev.title.replace(new RegExp(prev.subject || 'Chemistry', 'i'), detected.subject),
          additionalMaterials: detected.additionalMaterials,
          instructions: detected.instructions || prev.instructions,
        };
      }
      return prev;
    });
  }, [questions, syllabuses]);

  useEffect(() => {
    try {
      sessionStorage.setItem('testmaker_builder_header_config', JSON.stringify(headerConfig));
    } catch {
      // ignore
    }
  }, [headerConfig]);

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
      onUpdateQuestions?.(next);
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
      onUpdateQuestions?.(next);
      return next;
    });
  };

  const handleRemove = (qid: string) => {
    onRemoveQuestion(qid);
    setQuestions((prev) => {
      const updated = prev.filter((q) => q.id !== qid);
      onUpdateQuestions?.(updated);
      return updated;
    });
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

            <button
              type="button"
              className="builder-audio-top-btn"
              onClick={() => setIsBatchAudioModalOpen(true)}
              disabled={questions.length === 0}
              title="Attach or assign audio listening track across question range (IELTS format)"
            >
              🎧 Audio Tracks
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
          setQuestions((prev) => {
            const exists = prev.some((q) => q.id === newVariant.id);
            if (exists) return prev;
            const updated = [...prev, newVariant];
            onUpdateQuestions?.(updated);
            return updated;
          });
          setSavedSuccessMsg(`✨ Variant question ${newVariant.question_number} added to exam!`);
          setTimeout(() => setSavedSuccessMsg(null), 3000);
        }}
        onSaveToBank={(newVariant) => {
          setQuestions((prev) => {
            const exists = prev.some((q) => q.id === newVariant.id);
            if (exists) {
              const updated = prev.map((q) => (q.id === newVariant.id ? newVariant : q));
              onUpdateQuestions?.(updated);
              return updated;
            }
            return prev;
          });
          setSavedSuccessMsg(`✨ Variant question ${newVariant.question_number} saved to Question Bank!`);
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
          onUpdateQuestions?.(assembled);
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
            const updated = exists
              ? prev.map((q) => (q.id === savedQuestion.id ? savedQuestion : q))
              : [...prev, savedQuestion];
            onUpdateQuestions?.(updated);
            return updated;
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
        onLaunchGameRun={() => {
          setIsShareModalOpen(false);
          if (onLaunchGameRun) onLaunchGameRun(questions, headerConfig);
        }}
      />

      {/* Export Modal */}
      <ExportModal
        isOpen={isExportModalOpen}
        onClose={() => setIsExportModalOpen(false)}
        headerConfig={headerConfig}
        questions={questions}
      />

      {/* Batch Audio Range Modal */}
      <BatchAudioModal
        isOpen={isBatchAudioModalOpen}
        onClose={() => setIsBatchAudioModalOpen(false)}
        questions={questions}
        onApplyAudioToRange={(updated) => {
          setQuestions(updated);
          onUpdateQuestions?.(updated);
          setSavedSuccessMsg(`🎧 Audio listening track applied across target questions!`);
          setTimeout(() => setSavedSuccessMsg(null), 3500);
        }}
      />
    </div>
  );
}
