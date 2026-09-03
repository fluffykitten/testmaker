// ─── Exam Security Utilities ──────────────────────────────────────────────────
// Provides clipboard sanitization, multi-monitor detection, and watermark hashing.

/**
 * Generates a short, consistent 6-character hex hash from a session string.
 */
export function formatSessionHash(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).toUpperCase().padStart(6, '0').slice(0, 6);
}

/**
 * Sanitizes and clears the OS / browser clipboard buffer.
 * Fails silently if clipboard write permissions are restricted.
 */
export async function flushClipboard(): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText('');
      return true;
    }
  } catch (err) {
    // Clipboard API can fail if document is out of focus or blocked by permissions
    console.debug('[Security] Clipboard flush omitted:', err);
  }
  return false;
}

export interface MultiMonitorCheckResult {
  isMultiMonitor: boolean;
  reason?: string;
}

/**
 * Inspects modern Screen Details API and coordinate heuristics to detect secondary displays.
 */
export async function detectMultiMonitor(): Promise<MultiMonitorCheckResult> {
  if (typeof window === 'undefined' || typeof screen === 'undefined') {
    return { isMultiMonitor: false };
  }

  // 1. Modern Chromium Screen Details API (isExtended property)
  try {
    const scr = window.screen as any;
    if (scr && scr.isExtended === true) {
      return {
        isMultiMonitor: true,
        reason: 'Extended display or secondary monitor detected via Screen Details API',
      };
    }
  } catch (err) {
    console.debug('[Security] isExtended check note:', err);
  }

  // 2. Screen Details API via getScreenDetails (if granted or supported)
  try {
    const win = window as any;
    if (typeof win.getScreenDetails === 'function') {
      const details = await win.getScreenDetails();
      if (details && details.screens && details.screens.length > 1) {
        return {
          isMultiMonitor: true,
          reason: `Multiple active displays connected (${details.screens.length} monitors)`,
        };
      }
    }
  } catch {
    // Permission prompt may not be permitted synchronously; continue to heuristics
  }

  // 3. Window Coordinate Heuristics (e.g. window placed on negative coordinate or beyond primary screen bounds)
  try {
    const screenLeft = window.screenLeft ?? window.screenX ?? 0;
    const screenTop = window.screenTop ?? window.screenY ?? 0;
    const screenWidth = window.screen.width;
    const screenHeight = window.screen.height;

    // Window positioned on a left-placed or top-placed secondary monitor
    if (screenLeft < -20 || screenTop < -20) {
      return {
        isMultiMonitor: true,
        reason: 'Window bounds positioned across secondary display offset',
      };
    }

    // Window positioned on a right-placed monitor with x coordinate beyond primary width
    if (screenLeft >= screenWidth - 10) {
      return {
        isMultiMonitor: true,
        reason: 'Window bounds positioned on secondary external display',
      };
    }

    // Window positioned below primary monitor
    if (screenTop >= screenHeight - 10) {
      return {
        isMultiMonitor: true,
        reason: 'Window bounds positioned on vertical secondary display',
      };
    }

    // Window spanning wider than the primary screen
    if (window.outerWidth > screenWidth + 50) {
      return {
        isMultiMonitor: true,
        reason: 'Window spans across multiple display viewports',
      };
    }
  } catch (err) {
    console.debug('[Security] Coordinate heuristic note:', err);
  }

  return { isMultiMonitor: false };
}
