import { useState, useCallback, useRef, useEffect } from 'react';
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
import {
  saveUploadDraft,
  loadUploadDraft,
  hasUploadDraft,
  deleteUploadDraft,
} from '../lib/uploadDraftStorage';
import type { SubjectDomain } from '../lib/gemini';
import type { ExtractionResult } from '../types/database';
import './UploadPage.css';

function formatRelativeTime(timestamp: number): string {
  const diffSec = Math.floor((Date.now() - timestamp) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} minute${diffMin > 1 ? 's' : ''} ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
}

/**
 * Phase 2 Upload Page — orchestrates the full extraction flow:
 * 1. PDF upload drop zone & Auto-Save Draft Recovery
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

  // Draft recovery state
  const [draftInfo, setDraftInfo] = useState<{
    exists: boolean;
    fileName?: string;
    timestamp?: number;
    questionCount?: number;
  } | null>(null);
  const [isRestoringDraft, setIsRestoringDraft] = useState(false);

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

  // Check for an existing uncommitted draft on mount
  useEffect(() => {
    hasUploadDraft().then((info) => {
      if (info.exists) {
        setDraftInfo(info);
      }
    });
  }, []);

  // ─── Handle Resume & Discard Draft ───────────────────────────────────────

  const handleResumeDraft = async () => {
    setIsRestoringDraft(true);
    try {
      const draft = await loadUploadDraft();
      if (draft) {
        setExtractionResult(draft.result);
        setDiagramData(draft.diagramData);
        setPreviewUrls(draft.previewUrls);
        setUploadedQpFile(draft.qpFile);
        setUploadedInsertFile(draft.insertFile);
        selectedFilesRef.current = {
          qpFile: draft.qpFile,
          msFile: null,
          insertFile: draft.insertFile,
        };
        setPipelineState({
          stage: 'reviewing',
          message: `Restored draft from ${draft.fileName} (${draft.result.questions.length} questions).`,
          progress: 90,
          result: draft.result,
          error: null,
        });
        setDraftInfo(null);
      }
    } catch (err) {
      console.warn('Failed to restore draft:', err);
    } finally {
      setIsRestoringDraft(false);
    }
  };

  const handleDiscardDraft = async () => {
    await deleteUploadDraft();
    setDraftInfo(null);
  };

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

        // Auto-save draft to IndexedDB to protect teacher against accidental refresh
        await saveUploadDraft(qpFile.name, result, data, qpFile, insertFile);
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
      // Once successfully saved, purge the draft
      await deleteUploadDraft();
      setDraftInfo(null);
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
    deleteUploadDraft();
    setDraftInfo(null);

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

        {/* Stage: Idle — Show Upload Zone & Draft Recovery Banner */}
        {pipelineState.stage === 'idle' && (
          <div className="upload-page-center">
            {/* Unsaved Draft Recovery Banner */}
            {draftInfo?.exists && (
              <div className="upload-draft-banner animate-fade-in">
                <div className="upload-draft-icon">💾</div>
                <div className="upload-draft-content">
                  <div className="upload-draft-header">
                    <strong>Unsaved Extraction Draft Found</strong>
                    <span className="upload-draft-badge">Auto-Saved</span>
                  </div>
                  <p className="upload-draft-text">
                    You have an uncommitted extraction from <strong>{draftInfo.fileName}</strong>{' '}
                    ({draftInfo.questionCount} questions, saved {formatRelativeTime(draftInfo.timestamp || Date.now())}).
                  </p>
                </div>
                <div className="upload-draft-actions">
                  <button
                    type="button"
                    className="upload-draft-btn upload-draft-btn--resume"
                    onClick={handleResumeDraft}
                    disabled={isRestoringDraft}
                    id="resume-draft-btn"
                  >
                    {isRestoringDraft ? 'Restoring…' : '⚡ Resume Review'}
                  </button>
                  <button
                    type="button"
                    className="upload-draft-btn upload-draft-btn--discard"
                    onClick={handleDiscardDraft}
                    id="discard-draft-btn"
                  >
                    Discard
                  </button>
                </div>
              </div>
            )}

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
                if (extractionResult) {
                  saveUploadDraft(
                    uploadedQpFile?.name || 'Exam Paper',
                    extractionResult,
                    next,
                    uploadedQpFile,
                    uploadedInsertFile
                  );
                }
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
