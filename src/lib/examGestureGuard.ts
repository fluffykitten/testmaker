/**
 * Exam gesture guard — pure decision logic.
 *
 * Touchscreen and precision-trackpad browsers turn horizontal overscroll into a
 * history navigation ("swipe to go back"). In an exam that is catastrophic: it can
 * unmount the runner and trigger a false cheating strike.
 *
 * These predicates decide, without touching the DOM, whether a touch/wheel event
 * must be swallowed. The runner wires them to non-passive listeners.
 * See touchscreen_browser_security_plan.md §Layer 1–2.
 */

/** Width of the bezel zone where the OS/compositor starts a back gesture. */
export const EDGE_THRESHOLD = 32;

/** Minimum horizontal travel before a swipe is treated as navigation. */
export const MIN_HORIZONTAL_SWIPE = 10;

/** Horizontal travel from an edge touch that counts as a swipe (not a tap wobble). */
export const MIN_EDGE_SWIPE = 5;

/** Horizontal/vertical ratio above which a drag is "horizontal". */
export const HORIZONTAL_DOMINANCE = 1.25;

/** Minimum wheel deltaX before a two-finger trackpad swipe is considered. */
export const MIN_WHEEL_DELTA = 4;

export function isEdgeTouchStart(clientX: number, viewportWidth: number, threshold = EDGE_THRESHOLD): boolean {
  if (!Number.isFinite(clientX) || !Number.isFinite(viewportWidth)) return false;
  return clientX <= threshold || clientX >= viewportWidth - threshold;
}

export interface TouchMoveDecisionInput {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  startedAtEdge: boolean;
  /** The event target sits inside a legitimately horizontal widget (slider, wide table, canvas). */
  insideHorizontalWidget: boolean;
}

export function shouldBlockTouchMove(input: TouchMoveDecisionInput): boolean {
  const deltaX = input.currentX - input.startX;
  const deltaY = input.currentY - input.startY;
  const absX = Math.abs(deltaX);
  const absY = Math.abs(deltaY);

  // A swipe that began in the bezel is always a navigation gesture.
  if (input.startedAtEdge && absX > MIN_EDGE_SWIPE) return true;

  // Horizontal-dominant drags are navigation, unless a horizontal widget owns them.
  if (absX > absY * HORIZONTAL_DOMINANCE && absX > MIN_HORIZONTAL_SWIPE) {
    return !input.insideHorizontalWidget;
  }

  return false;
}

export interface WheelDecisionInput {
  deltaX: number;
  deltaY: number;
  insideScroller: boolean;
  /** Scroller is already at the edge the gesture is pushing against. */
  atLeftEdge: boolean;
  atRightEdge: boolean;
}

export function shouldBlockWheel(input: WheelDecisionInput): boolean {
  const absX = Math.abs(input.deltaX);
  const absY = Math.abs(input.deltaY);

  // Vertical scrolling is never touched.
  if (absX <= absY || absX <= MIN_WHEEL_DELTA) return false;

  if (input.insideScroller) {
    // Let the table pan until its own edge, then swallow the remainder so the
    // browser never sees a horizontal overscroll it could turn into history.
    if (input.deltaX < 0) return input.atLeftEdge;
    if (input.deltaX > 0) return input.atRightEdge;
    return false;
  }

  return true;
}

/** Rapid pops (<300 ms apart) must be re-seeded more aggressively than a normal back press. */
export function isRapidPop(now: number, lastPopAt: number, windowMs = 300): boolean {
  return lastPopAt > 0 && now - lastPopAt < windowMs;
}

/** Guard entries to (re)push after a pop: a rapid double-swipe needs a deeper cushion. */
export function guardEntriesToSeed(rapid: boolean): number {
  return rapid ? 2 : 1;
}

/** Treat a blur/visibility loss as gesture fallout rather than a violation for this long. */
export const GESTURE_BLUR_GRACE_MS = 450;

export function wasRecentlyIntercepted(now: number, interceptedAt: number, withinMs = GESTURE_BLUR_GRACE_MS): boolean {
  if (!interceptedAt) return false;
  return now - interceptedAt < withinMs;
}
