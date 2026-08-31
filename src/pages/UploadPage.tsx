import { useState, useCallback, useRef } from 'react';
import { PdfUpload } from '../components/PdfUpload';
import { PipelineProgress } from '../components/PipelineProgress';
import { ExtractionReview } from '../components/ExtractionReview';
import {
  runExtractionPipeline,
  saveExtractedQuestions,
  type PipelineState,
} from '../lib/pdfProcessor';
import {
  revokeLocalDiagramUrls,
  type DiagramCropItem,
} from '../lib/diagramCropper';
import type { SubjectDomain } from '../lib/gemini';
import type { ExtractionResult } from '../types/database';
import './UploadPage.css';

/**
 * Phase 2 Upload Page — orchestrates the full extraction flow:
 * 1. PDF upload drop zone
 * 2. Pipeline progress indicator
 * 3. Extraction review with save/discard (zero cloud storage uploads)
 * 4. Success confirmation
 */
export function UploadPage() {
  const [pipelineState, setPipelineState] = useState<PipelineState>({
    stage: 'idle',
    message: '',
    progress: 0,
    result: null,
    error: null,
  });

  const [extractionResult, setExtractionResult] = useState<ExtractionResult | null>(null);
  const [diagramData, setDiagramData] = useState<Map<string, DiagramCropItem>>(new Map());
  const [previewUrls, setPreviewUrls] = useState<Map<string, string>>(new Map());
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [uploadedQpFile, setUploadedQpFile] = useState<File | null>(null);
  const [uploadedInsertFile, setUploadedInsertFile] = useState<File | null>(null);

  const selectedFilesRef = useRef<{
    qpFile: File | null;
    msFile: File | null;
    insertFile: File | null;
  }>({
    qpFile: null,
    msFile: null,
    insertFile: null,
  });

  const isProcessing = ['uploading', 'extracting', 'cropping-diagrams'].includes(pipelineState.stage);

  // ─── Handle PDF Selection & Extraction ───────────────────────────────────

  const handleFilesSelected = useCallback(
    async (
      qpFile: File,
      msFile: File | null,
      insertFile: File | null,
      options: { includeGuidance: boolean; domain: SubjectDomain } = { includeGuidance: true, domain: 'stem' }
    ) => {
      setSavedCount(null);
      setExtractionResult(null);
      setUploadedQpFile(qpFile);
      setUploadedInsertFile(insertFile);
      selectedFilesRef.current = { qpFile, msFile, insertFile };

      try {
        const { result, diagramData: data, previewUrls: urls } = await runExtractionPipeline(
          qpFile,
          msFile,
          insertFile,
          setPipelineState,
          options
        );
        setExtractionResult(result);
        setDiagramData(data);
        setPreviewUrls(urls);
      } catch {
        // Error state is already set by the pipeline
      }
    },
    []
  );

  // ─── Handle Save to Database (Uploads storage files on confirm) ──────────

  const handleConfirmSave = useCallback(async (customResult?: ExtractionResult) => {
    const resultToSave = customResult || extractionResult;
    if (!resultToSave) return;

    setIsSaving(true);
    setPipelineState((prev) => ({
      ...prev,
      stage: 'saving',
      message: 'Uploading diagrams and saving questions to database…',
      progress: 95,
    }));

    try {
      const count = await saveExtractedQuestions(
        resultToSave,
        diagramData,
        selectedFilesRef.current.qpFile,
        selectedFilesRef.current.msFile,
        selectedFilesRef.current.insertFile
      );
      setSavedCount(count);
      window.dispatchEvent(new Event('questions_updated'));
      setPipelineState({
        stage: 'complete',
        message: `Successfully saved ${count} questions!`,
        progress: 100,
        result: resultToSave,
        error: null,
      });
    } catch (err) {
      setPipelineState({
        stage: 'error',
        message: err instanceof Error ? err.message : 'Save failed',
        progress: 0,
        result: resultToSave,
        error: err instanceof Error ? err.message : 'Unknown save error',
      });
    } finally {
      setIsSaving(false);
    }
  }, [extractionResult, diagramData]);

  // ─── Handle Discard (Leaves Supabase Storage 100% Clean) ─────────────────

  const handleCancel = useCallback(() => {
    // Revoke any created browser memory Object URLs
    revokeLocalDiagramUrls(diagramData);

    setPipelineState({
      stage: 'idle',
      message: '',
      progress: 0,
      result: null,
      error: null,
    });
    setExtractionResult(null);
    setDiagramData(new Map());
    setPreviewUrls(new Map());
    setSavedCount(null);
    setUploadedQpFile(null);
    setUploadedInsertFile(null);
    selectedFilesRef.current = { qpFile: null, msFile: null, insertFile: null };
  }, [diagramData]);

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="upload-page">
      <div className="upload-page-inner">
        {/* Page Header */}
        <div className="upload-page-header animate-fade-in">
          <h1 className="upload-page-title">
            Upload Past Paper
          </h1>
          <p className="upload-page-desc">
            Upload a past paper PDF. The AI extracts questions, formulas, diagrams, and auto-generates or matches the mark scheme.
          </p>
        </div>

        {/* Stage: Idle — Show Upload Zone */}
        {pipelineState.stage === 'idle' && (
          <div className="upload-page-center">
            <PdfUpload
              onFilesSelected={handleFilesSelected}
              isProcessing={isProcessing}
            />
          </div>
        )}

        {/* Stage: Processing — Show Progress */}
        {isProcessing && (
          <div className="upload-page-center">
            <PipelineProgress state={pipelineState} />
          </div>
        )}

        {/* Stage: Error — Show Progress (with error) + Retry */}
        {pipelineState.stage === 'error' && (
          <div className="upload-page-center">
            <PipelineProgress state={pipelineState} />
            <button
              className="upload-retry-btn animate-fade-in"
              onClick={handleCancel}
              id="retry-upload-btn"
            >
              ← Try Another PDF
            </button>
          </div>
        )}

        {/* Stage: Reviewing — Show Extracted Questions */}
        {pipelineState.stage === 'reviewing' && (extractionResult || pipelineState.result) && (
          <ExtractionReview
            result={extractionResult || pipelineState.result!}
            diagramUrls={previewUrls}
            pdfFile={uploadedQpFile || selectedFilesRef.current.qpFile}
            insertFile={uploadedInsertFile || selectedFilesRef.current.insertFile}
            onUpdateDiagram={(qNum, item) => {
              setDiagramData((prev) => {
                const next = new Map(prev);
                next.set(qNum, item);
                return next;
              });
              setPreviewUrls((prev) => {
                const next = new Map(prev);
                next.set(qNum, item.localUrl);
                return next;
              });
            }}
            onConfirmSave={handleConfirmSave}
            onCancel={handleCancel}
            isSaving={isSaving}
          />
        )}

        {/* Stage: Saving */}
        {pipelineState.stage === 'saving' && (
          <div className="upload-page-center">
            <PipelineProgress state={pipelineState} />
          </div>
        )}

        {/* Stage: Complete — Success */}
        {pipelineState.stage === 'complete' && savedCount !== null && (
          <div className="upload-success animate-fade-in">
            <div className="upload-success-icon">🎉</div>
            <h2 className="upload-success-title">
              {savedCount} Questions Saved!
            </h2>
            <p className="upload-success-desc">
              The extracted questions are now in your question bank and ready
              to use in the Test Builder.
            </p>
            <div className="upload-success-actions">
              <button
                className="upload-success-btn upload-success-btn--primary"
                onClick={handleCancel}
                id="upload-another-btn"
              >
                Upload Another Paper
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
