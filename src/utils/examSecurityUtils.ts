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

  // 2. Screen Details API via getScreenDetails — ONLY if permission is already granted!
  // Calling getScreenDetails() while permission is 'prompt' triggers Chromium's
  // "wants to manage your windows" permission popup, which forcibly exits fullscreen.
  try {
    const win = window as any;
    if (
      typeof win.getScreenDetails === 'function' &&
      typeof navigator !== 'undefined' &&
      navigator.permissions &&
      typeof navigator.permissions.query === 'function'
    ) {
      const permStatus = await navigator.permissions.query({
        name: 'window-management' as PermissionName,
      });
      if (permStatus.state === 'granted') {
        const details = await win.getScreenDetails();
        if (details && details.screens && details.screens.length > 1) {
          return {
            isMultiMonitor: true,
            reason: `Multiple active displays connected (${details.screens.length} monitors)`,
          };
        }
      }
    }
  } catch {
    // Permission query or Screen Details unavailable; fall back silently to screen.isExtended & heuristics
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

/**
 * FNV-1a style 64-bit (two-seed) digest, 12 hex chars.
 *
 * `formatSessionHash` is fine for a short display code but unusable as an identity: it takes
 * the first 6 hex chars of a 32-bit rolling hash, which drops exactly the low bits that make
 * "…0012" and "…0013" different. Two candidates would collapse onto one proctor row.
 */
function stableIdentityHash(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code + i;
    h2 = Math.imul(h2, 0x85ebca6b);
  }
  const hex = (value: number) => (value >>> 0).toString(16).padStart(8, '0');
  return hex(h1) + hex(h2);
}

/**
 * Produces a deterministic, collision-resistant canonical student ID for one quiz sitting.
 *
 * The live channel and the submitted record used to derive different keys (a session hash
 * seeded with startTime vs. "name_number"), so the same candidate appeared twice on the
 * invigilator dashboard and a reload created a third row. This id deliberately excludes
 * startTime: reloading, resuming and submitting all resolve to the same key.
 */
export function getCanonicalProctorStudentId(params: {
  quizCode?: string;
  studentName?: string;
  candidateNumber?: string;
  studentClass?: string;
}): string {
  const norm = (value?: string) => (value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const code = (params.quizCode || '').trim().toUpperCase();
  const name = norm(params.studentName) || 'candidate';
  const number = norm(params.candidateNumber);
  const klass = norm(params.studentClass);
  // candidateNumber is the strongest discriminator; class separates same-name students in
  // different cohorts when no number was issued.
  const identity = number ? `${name}#${number}` : klass ? `${name}@${klass}` : name;
  return `cand_${stableIdentityHash(`${code}::${identity}`).slice(0, 12)}`;
}

export const EXAM_FALLBACK_LOCKED_KEYS = ['Escape', 'F11'];
export const EXAM_LOCKED_KEYS = ['Escape', 'F11', 'MetaLeft', 'MetaRight', 'F23'];

export interface KeyboardShortcutLike {
  key?: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/**
 * Matches user copy shortcuts (Ctrl+C, Cmd+C, Ctrl+Insert) while excluding
 * developer/system combos like Ctrl+Shift+C (DevTools element inspector).
 */
export function isCopyShortcut(e: KeyboardShortcutLike): boolean {
  if (!e) return false;
  const key = (e.key || '').toLowerCase();
  const code = e.code || '';
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
    if (key === 'c' || code === 'KeyC') return true;
  }
  if (e.ctrlKey && !e.shiftKey && !e.altKey) {
    if (key === 'insert' || code === 'Insert') return true;
  }
  return false;
}

/**
 * Matches Windows / Super keys and Copilot hardware/shell shortcuts
 * (MetaLeft/Right, OSLeft/Right, Windows 11 Copilot's Shift+Meta+F23 / F23,
 * LaunchAssistant, and Win+C).
 */
export function isWindowsOrCopilotKey(e: KeyboardShortcutLike): boolean {
  if (!e) return false;
  const key = e.key || '';
  const code = e.code || '';
  const lowerKey = key.toLowerCase();

  if (
    key === 'Meta' ||
    key === 'OS' ||
    code === 'MetaLeft' ||
    code === 'MetaRight' ||
    code === 'OSLeft' ||
    code === 'OSRight'
  ) {
    return true;
  }

  if (key === 'F23' || code === 'F23' || key === 'LaunchAssistant' || key === 'Assistant') {
    return true;
  }

  // Win+C is used for Copilot on Windows (also blocks Cmd+C quietly without triggering a strike)
  if (e.metaKey && !e.ctrlKey && !e.altKey && (lowerKey === 'c' || code === 'KeyC')) {
    return true;
  }

  return false;
}

/**
 * Locks physical keys (Escape, F11, and Windows/Copilot key codes when supported) in
 * supported browsers (Chromium / Chrome / Edge) using the W3C Keyboard Lock API so they
 * cannot exit fullscreen or trigger OS/browser overlays during exam fullscreen.
 */
export async function enableKeyboardLock(keys: string[] = EXAM_LOCKED_KEYS): Promise<boolean> {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as any;
  if (nav.keyboard && typeof nav.keyboard.lock === 'function') {
    try {
      await nav.keyboard.lock(keys);
      return true;
    } catch (err) {
      // Fall back to Escape + F11 if an extended key code is rejected on this platform/browser
      const hasExtendedKeys = keys.some((k) => !EXAM_FALLBACK_LOCKED_KEYS.includes(k));
      if (hasExtendedKeys) {
        try {
          await nav.keyboard.lock(EXAM_FALLBACK_LOCKED_KEYS);
          return true;
        } catch (fallbackErr) {
          console.debug('[Security] Keyboard lock fallback note:', fallbackErr);
          return false;
        }
      }
      console.debug('[Security] Keyboard lock note:', err);
      return false;
    }
  }
  return false;
}

/**
 * Releases any active hardware keyboard locks.
 */
export function releaseKeyboardLock(): void {
  if (typeof navigator === 'undefined') return;
  const nav = navigator as any;
  if (nav.keyboard && typeof nav.keyboard.unlock === 'function') {
    try {
      nav.keyboard.unlock();
    } catch { }
  }
}

/**
 * Requests browser fullscreen with navigationUI set to 'hide' (suppresses Windows touchscreen
 * edge-swipe overlays where supported) and engages W3C Keyboard Lock for Escape and F11.
 */
export async function requestSecureFullscreen(): Promise<boolean> {
  if (typeof document === 'undefined') return false;
  try {
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      try {
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      } catch {
        await document.documentElement.requestFullscreen();
      }
    }
    // Lock Escape, F11, and Windows/Copilot keys using W3C Keyboard Lock API once in fullscreen
    if (document.fullscreenElement) {
      await enableKeyboardLock(EXAM_LOCKED_KEYS);
    }
    return !!document.fullscreenElement;
  } catch (err) {
    console.warn('[Security] Fullscreen request notice:', err);
    return false;
  }
}

/**
 * Solution 3 Cross-Browser State Masking for Security / Teacher PIN inputs.
 * Keeps the DOM input as type="text" displaying only '•' bullets while updating the real
 * secret string in memory. Completely prevents browser "Save Password?" popups and DOM inspection.
 */
export function applyMaskedPinInput(
  rawDomValue: string,
  currentSecret: string,
  maxLen = 20
): string {
  if (!rawDomValue) return '';
  const keptBullets = (rawDomValue.match(/•/g) || []).length;
  const addedChars = rawDomValue.replace(/•/g, '');
  return (currentSecret.slice(0, keptBullets) + addedChars).slice(0, maxLen);
}
