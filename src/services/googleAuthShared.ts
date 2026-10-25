/**
 * Shared Google Authentication Services for TestMaker.
 * Supports both:
 * 1. Google Identity Services (GIS) SDK (initTokenClient).
 * 2. Direct OAuth 2.0 Web Popup Flow (bypasses ad-blockers like uBlock Origin, Brave Shields, AdGuard).
 */

export const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';

export const GSI_ERROR_HINT =
  'Failed to load Google Identity Services SDK. If you are using an ad-blocker (uBlock Origin, Brave Shields, AdGuard, or Privacy Badger), it may be blocking accounts.google.com on this domain.';

export class GoogleAuthBlockedError extends Error {
  isGsiBlocked = true;
  constructor(message = GSI_ERROR_HINT) {
    super(message);
    this.name = 'GoogleAuthBlockedError';
  }
}

/**
 * Dynamically loads the Google Identity Services client script if not already present,
 * with fast polling, dead-script cleanup, and error detection.
 */
export function loadGsiScript(timeoutMs = 1500): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return resolve();
    if ((window as any).google?.accounts?.oauth2) return resolve();

    const existing = document.querySelector(`script[src*="accounts.google.com/gsi/client"]`);
    if (existing) {
      if ((window as any).google?.accounts?.oauth2) return resolve();

      let pollCount = 0;
      const maxPolls = Math.max(10, Math.floor(timeoutMs / 50));
      const pollTimer = setInterval(() => {
        pollCount++;
        if ((window as any).google?.accounts?.oauth2) {
          clearInterval(pollTimer);
          resolve();
        } else if (pollCount > maxPolls) {
          clearInterval(pollTimer);
          // If existing script failed or timed out, remove stale element so future attempts can retry
          try {
            existing.remove();
          } catch {}
          reject(new GoogleAuthBlockedError());
        }
      }, 50);
      return;
    }

    const script = document.createElement('script');
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.defer = true;

    let timer: any = null;

    script.onload = () => {
      setTimeout(() => {
        if (timer) clearTimeout(timer);
        if ((window as any).google?.accounts?.oauth2) {
          resolve();
        } else {
          try { script.remove(); } catch {}
          reject(new GoogleAuthBlockedError());
        }
      }, 100);
    };

    script.onerror = () => {
      if (timer) clearTimeout(timer);
      try { script.remove(); } catch {}
      reject(new GoogleAuthBlockedError());
    };

    timer = setTimeout(() => {
      if ((window as any).google?.accounts?.oauth2) {
        resolve();
      } else {
        try { script.remove(); } catch {}
        reject(new GoogleAuthBlockedError());
      }
    }, timeoutMs);

    document.head.appendChild(script);
  });
}

/**
 * Directly opens a centered Google OAuth 2.0 authorization popup.
 * This completely bypasses ad-blockers (uBlock Origin, Brave Shields, AdGuard, Privacy Badger)
 * because top-level user-initiated popup windows to accounts.google.com are never blocked.
 */
export function requestTokenViaDirectPopup(
  clientId: string,
  scope: string,
  forceConsent = false
): Promise<{ accessToken: string; expiresIn: number }> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined') {
      return reject(new Error('Window context is unavailable.'));
    }

    // Center the popup window on the screen
    const width = 500;
    const height = 650;
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));

    const redirectUri = window.location.origin;
    const promptVal = forceConsent ? 'consent' : 'select_account';

    const authUrl =
      `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&response_type=token` +
      `&scope=${encodeURIComponent(scope)}` +
      `&include_granted_scopes=true` +
      `&prompt=${encodeURIComponent(promptVal)}`;

    const popup = window.open(
      authUrl,
      'google_oauth_popup',
      `width=${width},height=${height},top=${top},left=${left},status=no,toolbar=no,menubar=no`
    );

    if (!popup || popup.closed) {
      return reject(
        new Error(
          'Google sign-in popup was blocked by your browser. Please allow popups for this site in your browser address bar.'
        )
      );
    }

    let isDone = false;
    let pollTimer: any = null;
    let safetyTimer: any = null;

    const cleanup = () => {
      isDone = true;
      window.removeEventListener('message', handleMessage);
      if (pollTimer) clearInterval(pollTimer);
      if (safetyTimer) clearTimeout(safetyTimer);
    };

    // Primary token receiver: postMessage from index.html head script
    const handleMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (isDone) return;

      if (event.data?.type === 'GOOGLE_OAUTH_TOKEN_SUCCESS' && event.data?.accessToken) {
        cleanup();
        try { popup.close(); } catch {}
        resolve({
          accessToken: event.data.accessToken,
          expiresIn: Number(event.data.expiresIn) || 3599,
        });
      } else if (event.data?.type === 'GOOGLE_OAUTH_TOKEN_ERROR') {
        cleanup();
        try { popup.close(); } catch {}
        reject(new Error(event.data.error || 'Google sign-in was denied or encountered an error.'));
      }
    };

    window.addEventListener('message', handleMessage);

    // Fallback token receiver: Polling popup window location hash
    pollTimer = setInterval(() => {
      if (isDone) return;

      try {
        if (!popup || popup.closed) {
          cleanup();
          reject(new Error('popup_closed_by_user'));
          return;
        }

        // Check if popup has redirected back to redirectUri (same-origin check)
        const popupHref = popup.location.href;
        if (popupHref && popupHref.startsWith(redirectUri)) {
          const hash = popup.location.hash ? popup.location.hash.substring(1) : '';
          if (hash.includes('access_token=')) {
            const params = new URLSearchParams(hash);
            const token = params.get('access_token');
            const expiresIn = Number(params.get('expires_in')) || 3599;
            cleanup();
            try { popup.close(); } catch {}
            if (token) {
              resolve({ accessToken: token, expiresIn });
            } else {
              reject(new Error('Failed to retrieve access token from Google response.'));
            }
          } else if (hash.includes('error=')) {
            const params = new URLSearchParams(hash);
            const err = params.get('error') || 'Access denied';
            cleanup();
            try { popup.close(); } catch {}
            reject(new Error(`Google authorization error: ${err}`));
          }
        }
      } catch {
        // Cross-origin access exception while popup is on accounts.google.com is expected & normal.
      }
    }, 250);

    // Safety timeout: 5 minutes
    safetyTimer = setTimeout(() => {
      if (!isDone) {
        cleanup();
        try { popup.close(); } catch {}
        reject(new Error('Google sign-in timed out. Please try again.'));
      }
    }, 5 * 60 * 1000);
  });
}
