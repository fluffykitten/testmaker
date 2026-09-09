// ─── Google Forms OAuth Service ───────────────────────────────────────────────
// Handles Google Identity Services (GIS) token acquisition, in-memory caching,
// silent renewal, and secure session revocation.

import { loadGsiScript } from '../googleDriveService';
import { FORMS_BODY_SCOPE } from './googleFormsTypes';

interface CachedToken {
  accessToken: string;
  expiresAt: number; // Unix timestamp in ms
  clientId: string;
}

let memoryTokenCache: CachedToken | null = null;

/**
 * Returns currently cached valid access token if still within its validity window.
 */
export function getCachedFormsToken(clientId: string): string | null {
  if (
    memoryTokenCache &&
    memoryTokenCache.clientId === clientId &&
    Date.now() < memoryTokenCache.expiresAt - 5 * 60 * 1000 // 5-minute safety buffer
  ) {
    return memoryTokenCache.accessToken;
  }
  return null;
}

/**
 * Stores retrieved access token into memory cache.
 */
export function setCachedFormsToken(clientId: string, accessToken: string, expiresInSeconds = 3599): void {
  memoryTokenCache = {
    clientId,
    accessToken,
    expiresAt: Date.now() + expiresInSeconds * 1000,
  };
}

/**
 * Clears cached token from memory.
 */
export function clearCachedFormsToken(): void {
  memoryTokenCache = null;
}

/**
 * Revokes active Google OAuth token for security (Fixes Issue #15).
 * Useful on shared school or library computers.
 */
export async function revokeGoogleFormsToken(customToken?: string): Promise<boolean> {
  const tokenToRevoke = customToken || memoryTokenCache?.accessToken;
  clearCachedFormsToken();

  if (!tokenToRevoke) return true;

  try {
    await loadGsiScript();
    if ((window as any).google?.accounts?.oauth2?.revoke) {
      await new Promise<void>((resolve) => {
        (window as any).google.accounts.oauth2.revoke(tokenToRevoke, () => {
          resolve();
        });
      });
      return true;
    }
  } catch (err) {
    console.warn('[GoogleFormsOAuth] Revocation error:', err);
  }
  return false;
}

/**
 * Requests a Google OAuth access token specifically with scope https://www.googleapis.com/auth/forms.body.
 * Fixes Issue #1 (uses silent auth when possible) & Issue #3 (utilizes memory cache).
 */
export async function requestGoogleFormsToken(clientId: string, forceConsent = false): Promise<string> {
  // 1. Check in-memory cache first
  if (!forceConsent) {
    const cached = getCachedFormsToken(clientId);
    if (cached) {
      return cached;
    }
  }

  await loadGsiScript();

  if (!(window as any).google?.accounts?.oauth2) {
    throw new Error('Google Identity Services SDK is not available. Please check your internet connection.');
  }

  const fetchToken = (promptMode: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      try {
        const tokenClient = (window as any).google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: FORMS_BODY_SCOPE,
          callback: (resp: any) => {
            if (resp.access_token) {
              const expiresIn = Number(resp.expires_in) || 3599;
              setCachedFormsToken(clientId, resp.access_token, expiresIn);
              resolve(resp.access_token);
            } else {
              const errMsg = typeof resp.error === 'string'
                ? resp.error
                : (resp.error?.message || resp.error_description || 'Google Forms authorization was cancelled or denied.');
              reject(new Error(errMsg));
            }
          },
          error_callback: (err: any) => {
            const errMsg = typeof err === 'string'
              ? err
              : (err?.message || 'Google Forms authentication popup was closed or encountered an error.');
            reject(new Error(errMsg));
          },
        });

        const reqOptions = promptMode ? { prompt: promptMode } : {};
        tokenClient.requestAccessToken(reqOptions);
      } catch (err: any) {
        reject(new Error(err?.message || 'Failed to initialize Google login popup.'));
      }
    });
  };

  if (forceConsent) {
    return fetchToken('consent');
  }

  // Attempt without forcing consent first for repeat users
  try {
    return await fetchToken('');
  } catch (initialErr: any) {
    const msg = initialErr?.message || '';
    // If popup was cancelled or failed due to needing user interaction, fallback to consent prompt
    if (msg.includes('consent') || msg.includes('interaction') || msg.includes('access_denied') || msg.includes('popup_closed')) {
      return fetchToken('consent');
    }
    throw initialErr;
  }
}
