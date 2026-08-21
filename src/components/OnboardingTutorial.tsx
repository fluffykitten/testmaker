import { useState, useEffect, useCallback, useRef } from 'react';
import './OnboardingTutorial.css';

const STORAGE_KEY = 'testmaker_onboarding_done';

// ─── Tutorial Step Definitions ────────────────────────────────────────────────

interface TutorialStep {
  targetSelector: string | null; // null = centered welcome/outro card
  title: string;
  description: string;
  position?: 'top' | 'bottom' | 'left' | 'right';
}

const STEPS: TutorialStep[] = [
  {
    targetSelector: null, // Welcome step — centered card
    title: 'Welcome to Test Maker! 🐱',
    description:
      "Let's take a quick tour of the app so you know where everything is. This will only take a moment!",
  },
  {
    targetSelector: '#nav-home',
    title: 'Dashboard',
    description:
      'This is your home base. Get an overview of all the features and quick-access buttons to jump into any section.',
    position: 'bottom',
  },
  {
    targetSelector: '#nav-bank',
    title: 'Question Bank',
    description:
      'Browse all extracted exam questions. Filter by topic, difficulty, year, marks, and more. Select questions to add them to your test.',
    position: 'bottom',
  },
  {
    targetSelector: '#nav-builder',
    title: 'Test Builder',
    description:
      'Assemble your custom exam here. Reorder questions with drag-and-drop, view live stats, and save or export your test.',
    position: 'bottom',
  },
  {
    targetSelector: '#nav-saved',
    title: 'Saved Tests',
    description:
      'Access all your previously saved tests. Load them back into the builder to edit, or export directly as Word/PDF.',
    position: 'bottom',
  },
  {
    targetSelector: '#nav-upload',
    title: 'Upload Papers',
    description:
      'Upload past exam papers as PDFs. Our AI extracts questions, diagrams, topics, and mark schemes automatically.',
    position: 'bottom',
  },
  {
    targetSelector: '#hero-bank-btn',
    title: 'Quick Actions',
    description:
      "Use these shortcut buttons on the dashboard to jump straight into any section. Try browsing the Question Bank first!",
    position: 'top',
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

interface OnboardingTutorialProps {
  restartSignal?: number; // Increment to restart the tutorial
}

export function OnboardingTutorial({ restartSignal }: OnboardingTutorialProps) {
  const [active, setActive] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // Check if tutorial should start
  useEffect(() => {
    if (!localStorage.getItem(STORAGE_KEY)) {
      // Small delay to let the DOM settle after PIN gate
      const timer = setTimeout(() => setActive(true), 600);
      return () => clearTimeout(timer);
    }
  }, []);

  // Handle restart signal
  useEffect(() => {
    if (restartSignal && restartSignal > 0) {
      setStepIndex(0);
      setActive(true);
    }
  }, [restartSignal]);

  // Update target rect when step changes
  const updateTargetRect = useCallback(() => {
    const step = STEPS[stepIndex];
    if (!step || !step.targetSelector) {
      setTargetRect(null);
      return;
    }
    const el = document.querySelector(step.targetSelector);
    if (el) {
      setTargetRect(el.getBoundingClientRect());
    } else {
      setTargetRect(null);
    }
  }, [stepIndex]);

  useEffect(() => {
    if (!active) return;
    updateTargetRect();

    // Recalculate on resize/scroll
    window.addEventListener('resize', updateTargetRect);
    window.addEventListener('scroll', updateTargetRect, true);
    return () => {
      window.removeEventListener('resize', updateTargetRect);
      window.removeEventListener('scroll', updateTargetRect, true);
    };
  }, [active, stepIndex, updateTargetRect]);

  // Dismiss permanently
  const handleDismiss = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, 'true');
    setActive(false);
  }, []);

  // Navigation
  const handleNext = useCallback(() => {
    if (stepIndex < STEPS.length - 1) {
      setStepIndex((s) => s + 1);
    } else {
      handleDismiss();
    }
  }, [stepIndex, handleDismiss]);

  const handlePrev = useCallback(() => {
    if (stepIndex > 0) {
      setStepIndex((s) => s - 1);
    }
  }, [stepIndex]);

  if (!active) return null;

  const currentStep = STEPS[stepIndex];
  const isWelcome = currentStep.targetSelector === null;
  const isLast = stepIndex === STEPS.length - 1;
  const progress = ((stepIndex + 1) / STEPS.length) * 100;

  // Compute tooltip position
  const getTooltipStyle = (): React.CSSProperties => {
    if (!targetRect || isWelcome) return {};

    const padding = 12;
    const tooltipWidth = 340;
    const pos = currentStep.position || 'bottom';

    let top = 0;
    let left = 0;

    switch (pos) {
      case 'bottom':
        top = targetRect.bottom + padding;
        left = targetRect.left + targetRect.width / 2 - tooltipWidth / 2;
        break;
      case 'top':
        top = targetRect.top - padding;
        left = targetRect.left + targetRect.width / 2 - tooltipWidth / 2;
        break;
      case 'left':
        top = targetRect.top + targetRect.height / 2 - 80;
        left = targetRect.left - tooltipWidth - padding;
        break;
      case 'right':
        top = targetRect.top + targetRect.height / 2 - 80;
        left = targetRect.right + padding;
        break;
    }

    // Keep in viewport
    left = Math.max(16, Math.min(left, window.innerWidth - tooltipWidth - 16));
    if (pos === 'top') {
      // tooltip appears above, need to measure height — approximate
      top = Math.max(16, top - 200);
    }

    return { top: `${top}px`, left: `${left}px` };
  };

  // SVG spotlight mask
  const spotlightPadding = 8;
  const spotlightRadius = 10;

  return (
    <div className="tutorial-overlay">
      {/* SVG backdrop with cutout */}
      <svg className="tutorial-spotlight-svg" onClick={(e) => e.stopPropagation()}>
        <defs>
          <mask id="tutorial-spotlight-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {targetRect && !isWelcome && (
              <rect
                x={targetRect.left - spotlightPadding}
                y={targetRect.top - spotlightPadding}
                width={targetRect.width + spotlightPadding * 2}
                height={targetRect.height + spotlightPadding * 2}
                rx={spotlightRadius}
                ry={spotlightRadius}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill="rgba(0, 0, 0, 0.55)"
          mask="url(#tutorial-spotlight-mask)"
        />
        {/* Subtle glow ring around spotlight */}
        {targetRect && !isWelcome && (
          <rect
            x={targetRect.left - spotlightPadding - 2}
            y={targetRect.top - spotlightPadding - 2}
            width={targetRect.width + spotlightPadding * 2 + 4}
            height={targetRect.height + spotlightPadding * 2 + 4}
            rx={spotlightRadius + 2}
            ry={spotlightRadius + 2}
            fill="none"
            stroke="rgba(99, 102, 241, 0.5)"
            strokeWidth="2"
          />
        )}
      </svg>

      {/* Welcome card (centered) */}
      {isWelcome && (
        <div className="tutorial-welcome-card">
          <div className="tutorial-welcome-icon">
            <svg width="32" height="32" viewBox="0 0 28 28" fill="none">
              <rect width="28" height="28" rx="8" fill="url(#tut-grad)" />
              <path d="M8 9h12M8 14h8M8 19h10" stroke="white" strokeWidth="2" strokeLinecap="round" />
              <defs>
                <linearGradient id="tut-grad" x1="0" y1="0" x2="28" y2="28">
                  <stop stopColor="#818cf8" />
                  <stop offset="1" stopColor="#6366f1" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <h2 className="tutorial-welcome-title">{currentStep.title}</h2>
          <p className="tutorial-welcome-desc">{currentStep.description}</p>
          <div className="tutorial-welcome-actions">
            <button className="tutorial-start-btn" onClick={handleNext}>
              Start Tour
            </button>
            <button className="tutorial-dismiss-btn" onClick={handleDismiss}>
              Skip, I know my way around
            </button>
          </div>
        </div>
      )}

      {/* Step tooltip (positioned near target) */}
      {!isWelcome && (
        <div
          ref={tooltipRef}
          className="tutorial-tooltip"
          style={getTooltipStyle()}
          key={stepIndex} // Re-trigger enter animation
        >
          <div className="tutorial-tooltip-header">
            <span className="tutorial-step-indicator">{stepIndex}</span>
            <h3 className="tutorial-step-title">{currentStep.title}</h3>
          </div>

          <p className="tutorial-step-description">{currentStep.description}</p>

          <div className="tutorial-progress-bar">
            <div className="tutorial-progress-fill" style={{ width: `${progress}%` }} />
          </div>

          <div className="tutorial-actions">
            <button className="tutorial-skip-btn" onClick={handleDismiss}>
              Skip tour
            </button>
            <div className="tutorial-nav-btns">
              {stepIndex > 1 && (
                <button className="tutorial-prev-btn" onClick={handlePrev}>
                  ← Back
                </button>
              )}
              <button className="tutorial-next-btn" onClick={handleNext}>
                {isLast ? 'Finish ✓' : 'Next →'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
