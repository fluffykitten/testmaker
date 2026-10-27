// ─── Google Forms OAuth Service ───────────────────────────────────────────────
// Handles Google Identity Services (GIS) token acquisition, in-memory caching,
// silent renewal, and secure session revocation.

import {
  loadGsiScript,
  requestTokenViaDirectPopup,
  GSI_ERROR_HINT,
} from '../googleAuthShared';
import { FORMS_BODY_SCOPE } from './googleFormsTypes';

export { loadGsiScript, requestTokenViaDirectPopup, GSI_ERROR_HINT };

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
    await loadGsiScript().catch(() => {});
    if ((window as any).google?.accounts?.oauth2?.revoke) {
      await new Promise<void>((resolve) => {
        (window as any).google.accounts.oauth2.revoke(tokenToRevoke, () => {
          resolve();
        });
      });
      return true;
    }
    // Fallback: revoke via Google revoke endpoint
    await fetch(`https://accounts.google.com/o/oauth2/revoke?token=${encodeURIComponent(tokenToRevoke)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }).catch(() => {});
    return true;
  } catch (err) {
    console.warn('[GoogleFormsOAuth] Revocation error:', err);
  }
  return false;
}

/**
 * Requests a Google OAuth access token specifically with scope https://www.googleapis.com/auth/forms.body.
 * Supports silent memory cache, standard GIS SDK, and automatic Direct Popup fallback
 * when ad-blockers (uBlock Origin, Brave Shields, AdGuard, Privacy Badger) block GIS.
 */
export async function requestGoogleFormsToken(clientId: string, forceConsent = false): Promise<string> {
  // 1. Check in-memory cache first
  if (!forceConsent) {
    const cached = getCachedFormsToken(clientId);
    if (cached) {
      return cached;
    }
  }

  // 2. Try standard Google Identity Services (GIS) SDK first
  let useGsi = false;
  try {
    await loadGsiScript();
    if ((window as any).google?.accounts?.oauth2) {
      useGsi = true;
    }
  } catch (err) {
    console.warn('[GoogleFormsOAuth] GIS script load failed or blocked by ad-blocker. Falling back to direct popup flow:', err);
    useGsi = false;
  }

  if (useGsi) {
    try {
      const token = await new Promise<string>((resolve, reject) => {
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

          const reqOptions = forceConsent ? { prompt: 'consent' } : {};
          tokenClient.requestAccessToken(reqOptions);
        } catch (err: any) {
          reject(new Error(err?.message || 'Failed to initialize Google login popup.'));
        }
      });
      return token;
    } catch (gsiErr: any) {
      const msg = gsiErr?.message || '';
      if (msg === 'popup_closed_by_user') {
        throw gsiErr;
      }
      console.warn('[GoogleFormsOAuth] GIS token request failed, attempting direct OAuth popup fallback:', gsiErr);
    }
  }

  // 3. Fallback: Direct OAuth 2.0 Web Popup (Immune to ad-blockers & Brave Shields)
  const popupResult = await requestTokenViaDirectPopup(clientId, FORMS_BODY_SCOPE, forceConsent);
  setCachedFormsToken(clientId, popupResult.accessToken, popupResult.expiresIn);
  return popupResult.accessToken;
}

