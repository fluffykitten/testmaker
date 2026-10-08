# Page Component Dependency Trees

This document catalogs the component dependency hierarchies for all key application views in the ICM Exam Platform.

---

## 1. Minimalist Portal Landing Page
- **Route / Mode**: `appMode === 'portal'` (Default)
- **Entry**: `src/pages/PortalLandingPage.tsx`
- **Dependencies**:
  - `src/components/StudentResultModal.tsx`
    - `src/components/ExamMathText.tsx`
  - `src/components/PinGate.tsx`
    - `src/components/TurnstileWidget.tsx`
  - `src/services/quizSubmissionService.ts`
  - `src/services/turnstileService.ts`
  - `src/assets/logoConstants.ts`
  - `src/pages/PortalLandingPage.css`

---

## 2. Educator Dashboard (HomePage)
- **Route / Mode**: `appMode === 'teacher' && currentPage === 'home'`
- **Entry**: `src/App.tsx` (`HomePage` component)
- **Dependencies**:
  - `src/components/OnboardingTutorial.tsx`
  - `src/components/ConnectionStatus.tsx`
  - `src/components/SettingsModal.tsx`
    - `src/components/BackupRestoreModal.tsx`
  - `src/assets/logoConstants.ts`
  - `src/App.css`

---

## 3. Question Bank & Formula Search
- **Route / Mode**: `currentPage === 'bank'`
- **Entry**: `src/pages/QuestionBankPage.tsx`
- **Dependencies**:
  - `src/components/QuestionCard.tsx`
    - `src/components/ExamMathText.tsx`
    - `src/components/ExamVisualRender.tsx`
  - `src/components/QuestionFilters.tsx`
  - `src/components/QuestionEditorModal.tsx`
    - `src/components/DiagramCropModal.tsx`
    - `src/components/FormulaHelperModal.tsx`
  - `src/components/QuestionDetailModal.tsx`
  - `src/components/QuestionVariantModal.tsx`
  - `src/components/BatchAudioModal.tsx`
  - `src/services/questionBankService.ts`
  - `src/services/formulaSearch.ts`
  - `src/pages/QuestionBankPage.css`

---

## 4. Standardized Test Builder
- **Route / Mode**: `currentPage === 'builder'`
- **Entry**: `src/pages/TestBuilderPage.tsx`
- **Dependencies**:
  - `src/components/TestQuestionItem.tsx`
    - `src/components/ExamMathText.tsx`
  - `src/components/TestHeaderEditor.tsx`
  - `src/components/TestStatsSidebar.tsx`
  - `src/components/TestPaperPreview.tsx`
  - `src/components/SmartTestAssemblerModal.tsx`
  - `src/components/ExportModal.tsx`
  - `src/components/QuestionVariantModal.tsx`
  - `src/services/testBuilderService.ts`
  - `src/services/docxExportService.ts`
  - `src/pages/TestBuilderPage.css`

---

## 5. Saved Cambridge Tests Catalog
- **Route / Mode**: `currentPage === 'saved'`
- **Entry**: `src/pages/SavedTestsPage.tsx`
- **Dependencies**:
  - `src/components/ConfirmDeleteModal.tsx`
  - `src/components/ExportModal.tsx`
  - `src/services/storageService.ts`
  - `src/services/quizCodeService.ts`
  - `src/pages/SavedTestsPage.css`

---

## 6. Interactive Quizzes & Live Proctoring
- **Route / Mode**: `currentPage === 'quizzes'`
- **Entry**: `src/pages/QuizManagerPage.tsx`
- **Dependencies**:
  - `src/components/QuizResultsModal.tsx`
    - `src/components/ExamMathText.tsx`
  - `src/components/StudentShareModal.tsx`
  - `src/components/LiveInvigilatorModal.tsx`
  - `src/components/OfflineGradingModal.tsx`
  - `src/components/ExamVariantModal.tsx`
  - `src/components/ConfirmDeleteModal.tsx`
  - `src/services/quizManagerService.ts`
  - `src/services/quizReportPdfService.ts`
  - `src/services/lmsExportService.ts`
  - `src/pages/QuizManagerPage.css`

---

## 7. Multimodal Past Paper AI Uploader
- **Route / Mode**: `currentPage === 'upload'`
- **Entry**: `src/pages/UploadPage.tsx`
- **Dependencies**:
  - `src/components/PdfUpload.tsx`
  - `src/components/PipelineProgress.tsx`
  - `src/components/ExtractionReview.tsx`
    - `src/components/DiagramCropModal.tsx`
    - `src/components/ExamMathText.tsx`
  - `src/services/pdfExtractionService.ts`
  - `src/pages/UploadPage.css`

---

## 8. Student Quiz Runner (Lockdown Exam Mode)
- **Route / Mode**: `appMode === 'student_quiz'`
- **Entry**: `src/pages/StudentQuizRunner.tsx`
- **Dependencies**:
  - `src/components/ExamMathText.tsx`
  - `src/components/ExamVisualRender.tsx`
  - `src/components/InlineGapText.tsx`
  - `src/components/CandidateWatermark.tsx`
  - `src/components/PeriodicTableDrawer.tsx`
  - `src/components/ScientificCalculatorModal.tsx`
  - `src/components/ResourceBookletDrawer.tsx`
  - `src/components/ExamAudioPlayer.tsx`
  - `src/services/quizCodeService.ts`
  - `src/services/quizSubmissionService.ts`
  - `src/services/examProctorRealtimeService.ts`
  - `src/pages/StudentQuizRunner.css`

---

## 9. Advanced Settings & Cloud Integration
- **Route / Mode**: `currentPage === 'advanced_settings'`
- **Entry**: `src/pages/AdvancedSettingsPage.tsx`
- **Dependencies**:
  - `src/lib/settings.ts`
  - `src/lib/supabase.ts`
  - `src/services/autoBackupService.ts`
  - `src/pages/AdvancedSettingsPage.css`
