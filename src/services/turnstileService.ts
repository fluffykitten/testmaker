// ─── Turnstile Verification Service ─────────────────────────────────────────
// Validates Cloudflare Turnstile anti-bot tokens with graceful fallback for local development.

const WORKER_ENDPOINT =
  import.meta.env.VITE_CLOUDFLARE_WORKER_URL ||
  import.meta.env.VITE_R2_MEDIA_ENDPOINT ||
  'https://testmaker-media.icmadani.workers.dev';

export interface TurnstileVerificationResult {
  success: boolean;
  error?: string;
  isBypassed?: boolean;
}

/**
 * Validates a Turnstile token against the Cloudflare Worker endpoint.
 * In local dev without configured keys or offline, gracefully passes through.
 */
export async function verifyTurnstileToken(
  token: string | null | undefined,
  action?: string
): Promise<TurnstileVerificationResult> {
  // If development bypass token or no site key configured
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;
  if (!siteKey || token === 'dev-bypass-turnstile-token' || !token) {
    if (!siteKey) {
      // Graceful dev bypass
      return { success: true, isBypassed: true };
    }
    return { success: false, error: 'Missing challenge token' };
  }

  try {
    const res = await fetch(`${WORKER_ENDPOINT}/api/verify-turnstile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, action }),
    });

    if (res.ok) {
      const data = await res.json();
      return {
        success: data.success === true,
        error: data.success ? undefined : (data['error-codes']?.join(', ') || 'Bot verification failed'),
      };
    }

    const errData = await res.json().catch(() => ({}));
    return {
      success: false,
      error: errData.error || `Verification failed with status ${res.status}`,
    };
  } catch (err: any) {
    console.warn('[turnstileService] Worker unreachable, falling back gracefully:', err?.message);
    // If worker is temporarily down or network fails in dev, allow fallback to not block teachers
    return { success: true, isBypassed: true };
  }
}
