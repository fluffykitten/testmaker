import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import { supabase } from '../lib/supabase';
import {
  normalizeQuestionRecord,
  batchUpdateCognitiveLevels,
} from '../services/questionBankService';
import { analyzeCognitiveLevelsBatch } from '../lib/gemini';
import type { Question } from '../types/database';
import './BatchCognitiveAnalyzeModal.css';

interface BatchCognitiveAnalyzeModalProps {
  isOpen: boolean;
  onClose: () => void;
  syllabusId?: string;
  onComplete?: () => void;
}

export function BatchCognitiveAnalyzeModal({
  isOpen,
  onClose,
  syllabusId,
}: BatchCognitiveAnalyzeModalProps) {
  const [scope, setScope] = useState<'unclassified' | 'all'>('unclassified');
  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [completedCount, setCompletedCount] = useState<number | null>(null);

  const backdropDismiss = useBackdropDismiss(onClose);

  if (!isOpen) return null;

  const handleStartAnalysis = async () => {
    setIsRunning(true);
    setStatusMessage('Scanning questions from database…');
    setProgress(null);
    setCompletedCount(null);

    try {
      let query = (supabase as any)
        .from('questions')
        .select('*');

      if (syllabusId) {
        query = query.eq('syllabus_id', syllabusId);
      }

      const { data, error } = await query;
      if (error) throw error;

      const allQuestions: Question[] = (data || []).map(normalizeQuestionRecord);

      // Filter target questions based on scope
      const targetQuestions = allQuestions.filter((q) => {
        if (scope === 'all') return true;
        return !q.cognitive_level;
      });

      if (targetQuestions.length === 0) {
        setStatusMessage(
          scope === 'unclassified'
            ? 'All questions in this syllabus already have Bloom\'s cognitive levels assigned.'
            : 'No questions found in this syllabus.'
        );
        setIsRunning(false);
        return;
      }

      const total = targetQuestions.length;
      setProgress({ current: 0, total });
      let processed = 0;
      const batchSize = 12;

      for (let i = 0; i < total; i += batchSize) {
        const chunk = targetQuestions.slice(i, i + batchSize);
        setStatusMessage(`Analyzing batch ${Math.floor(i / batchSize) + 1} of ${Math.ceil(total / batchSize)}…`);

        const results = await analyzeCognitiveLevelsBatch(
          chunk.map((q) => ({
            id: q.id,
            question_number: q.question_number,
            question_text: q.question_text,
            question_style: q.question_style,
            marks: q.marks,
            sub_questions: (q.sub_questions || []).map((s) => ({
              sub_id: s.sub_id,
              question_text: s.question_text,
              marks: s.marks,
            })),
          }))
        );

        if (results.length > 0) {
          const updates = results.map((r: any) => {
            const originalQ = chunk.find((c) => c.id === r.id);
            const updatedSubs = (originalQ?.sub_questions || []).map((s) => {
              const matchedSub = (r.sub_questions || []).find((ms: any) => ms.sub_id === s.sub_id);
              return {
                ...s,
                cognitive_level: matchedSub?.cognitive_level || r.cognitive_level,
              };
            });

            return {
              id: r.id,
              cognitive_level: r.cognitive_level,
              sub_questions: updatedSubs,
            };
          });

          await batchUpdateCognitiveLevels(updates);
        }

        processed += chunk.length;
        setProgress({ current: Math.min(processed, total), total });
      }

      setCompletedCount(processed);
      setStatusMessage(`Completed Bloom's Taxonomy classification for ${processed} questions.`);
    } catch (err: any) {
      console.error('Batch cognitive classification error:', err);
      setStatusMessage(`Error: ${err?.message || 'Classification failed'}`);
    } finally {
      setIsRunning(false);
    }
  };

  return createPortal(
    <div
      className="batch-cog-overlay"
      onMouseDown={backdropDismiss.onMouseDown}
      onClick={backdropDismiss.onClick}
      role="dialog"
      aria-modal="true"
      aria-labelledby="batch-cog-title"
    >
      <div className="batch-cog-card">
        <div className="batch-cog-header">
          <div>
            <h2 id="batch-cog-title" className="batch-cog-title">
              Bloom's Taxonomy Cognitive Classification
            </h2>
            <div className="batch-cog-subtitle">
              Automated AI cognitive level backfill for Table of Specifications
            </div>
          </div>
          <button
            type="button"
            className="batch-cog-close"
            onClick={onClose}
            disabled={isRunning}
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        <div className="batch-cog-body">
          <p className="batch-cog-desc">
            Analyzes question prompts, action verbs, and marks using Gemini AI to assign Bloom's Cognitive Levels (C1 to C6) to both parent questions and each nested sub-part.
          </p>

          <div className="batch-cog-levels-grid">
            <div className="batch-cog-level-item">
              <span className="batch-cog-level-tag">C1</span> Remembering (State, define, name)
            </div>
            <div className="batch-cog-level-item">
              <span className="batch-cog-level-tag">C2</span> Understanding (Describe, explain)
            </div>
            <div className="batch-cog-level-item">
              <span className="batch-cog-level-tag">C3</span> Applying (Calculate, construct, solve)
            </div>
            <div className="batch-cog-level-item">
              <span className="batch-cog-level-tag">C4</span> Analyzing (Compare, deduce, graphs)
            </div>
            <div className="batch-cog-level-item">
              <span className="batch-cog-level-tag">C5</span> Evaluating (Justify, assess errors)
            </div>
            <div className="batch-cog-level-item">
              <span className="batch-cog-level-tag">C6</span> Creating (Plan investigation, design)
            </div>
          </div>

          {!isRunning && completedCount === null && (
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#334155', marginBottom: '8px' }}>
                Classification Scope:
              </label>
              <div style={{ display: 'flex', gap: '16px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="scope"
                    value="unclassified"
                    checked={scope === 'unclassified'}
                    onChange={() => setScope('unclassified')}
                  />
                  Unclassified questions only
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.85rem', cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="scope"
                    value="all"
                    checked={scope === 'all'}
                    onChange={() => setScope('all')}
                  />
                  Re-analyze all questions
                </label>
              </div>
            </div>
          )}

          {progress && (
            <div className="batch-cog-progress-wrap">
              <div className="batch-cog-progress-bar-bg">
                <div
                  className="batch-cog-progress-bar-fill"
                  style={{ width: `${Math.round((progress.current / progress.total) * 100)}%` }}
                />
              </div>
              <div className="batch-cog-progress-text">
                <span>{statusMessage}</span>
                <span>{progress.current} / {progress.total}</span>
              </div>
            </div>
          )}

          {!progress && statusMessage && (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: '6px',
                fontSize: '0.85rem',
                background: statusMessage.startsWith('Error') ? '#fef2f2' : '#f0fdf4',
                color: statusMessage.startsWith('Error') ? '#b91c1c' : '#15803d',
                border: `1px solid ${statusMessage.startsWith('Error') ? '#fecaca' : '#bbf7d0'}`,
              }}
            >
              {statusMessage}
            </div>
          )}
        </div>

        <div className="batch-cog-footer">
          <button
            type="button"
            className="past-paper-btn"
            onClick={onClose}
            disabled={isRunning}
          >
            {completedCount !== null ? 'Done' : 'Cancel'}
          </button>
          {completedCount === null && (
            <button
              type="button"
              className="past-paper-btn past-paper-btn-primary"
              onClick={handleStartAnalysis}
              disabled={isRunning}
            >
              {isRunning ? 'Analyzing…' : 'Start Classification'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
