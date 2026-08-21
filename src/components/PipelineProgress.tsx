import type { PipelineState } from '../lib/pdfProcessor';
import './PipelineProgress.css';

interface PipelineProgressProps {
  state: PipelineState;
}

const STAGE_LABELS: Record<string, { label: string; icon: string }> = {
  uploading: { label: 'Uploading PDF', icon: '📤' },
  extracting: { label: 'AI Extraction', icon: '🤖' },
  'cropping-diagrams': { label: 'Processing Diagrams', icon: '✂️' },
  reviewing: { label: 'Ready for Review', icon: '✅' },
  saving: { label: 'Saving to Database', icon: '💾' },
  complete: { label: 'Complete', icon: '🎉' },
  error: { label: 'Error', icon: '❌' },
};

const STAGE_ORDER = ['uploading', 'extracting', 'cropping-diagrams', 'reviewing'];

/**
 * Visual pipeline progress indicator showing each stage with a progress bar,
 * step dots, and the current status message.
 */
export function PipelineProgress({ state }: PipelineProgressProps) {
  if (state.stage === 'idle') return null;

  const currentStageIdx = STAGE_ORDER.indexOf(state.stage);
  const stageInfo = STAGE_LABELS[state.stage] || { label: state.stage, icon: '⏳' };

  return (
    <div className={`pipeline-progress animate-fade-in ${state.stage === 'error' ? 'pipeline-progress--error' : ''}`}>
      {/* Step Dots */}
      <div className="pipeline-steps">
        {STAGE_ORDER.map((stage, idx) => {
          let stepClass = 'pipeline-step';
          if (idx < currentStageIdx) stepClass += ' pipeline-step--complete';
          else if (idx === currentStageIdx) stepClass += ' pipeline-step--active';

          return (
            <div key={stage} className="pipeline-step-wrapper">
              <div className={stepClass}>
                {idx < currentStageIdx ? '✓' : idx + 1}
              </div>
              <span className="pipeline-step-label">
                {STAGE_LABELS[stage]?.label || stage}
              </span>
              {idx < STAGE_ORDER.length - 1 && (
                <div
                  className={`pipeline-step-line ${
                    idx < currentStageIdx ? 'pipeline-step-line--complete' : ''
                  }`}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Progress Bar */}
      <div className="pipeline-bar-track">
        <div
          className="pipeline-bar-fill"
          style={{ width: `${state.progress}%` }}
        />
      </div>

      {/* Status Message */}
      <div className="pipeline-status">
        <span className="pipeline-status-icon">{stageInfo.icon}</span>
        <span className="pipeline-status-text">{state.message}</span>
      </div>

      {/* Error Detail */}
      {state.error && (
        <div className="pipeline-error">
          <pre className="pipeline-error-detail">{state.error}</pre>
        </div>
      )}
    </div>
  );
}
