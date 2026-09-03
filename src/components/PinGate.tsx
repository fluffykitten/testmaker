import { useState, useRef, useEffect, type ReactNode, type KeyboardEvent, type ClipboardEvent } from 'react';
import { supabase } from '../lib/supabase';
import { verifyPinAgainstHashOrPlain } from '../utils/cryptoUtils';
import './PinGate.css';

const PIN_LENGTH = 6;
const SESSION_KEY = 'testmaker_pin_verified';
const LOCAL_PIN_CACHE_KEY = 'testmaker_cached_access_pin';
const ATTEMPTS_KEY = 'testmaker_pin_failed_attempts';
const LOCKOUT_KEY = 'testmaker_pin_lockout_until';

function getLockoutRemainingSeconds(): number {
  try {
    const until = parseInt(localStorage.getItem(LOCKOUT_KEY) || '0', 10);
    const now = Date.now();
    return until > now ? Math.ceil((until - now) / 1000) : 0;
  } catch {
    return 0;
  }
}

function getFailedAttempts(): number {
  try {
    return parseInt(localStorage.getItem(ATTEMPTS_KEY) || '0', 10) || 0;
  } catch {
    return 0;
  }
}

function recordFailedAttempt(): { attempts: number; lockoutSeconds: number } {
  const attempts = getFailedAttempts() + 1;
  let lockoutSeconds = 0;

  if (attempts >= 10) {
    lockoutSeconds = 30 * 60; // 30 minutes
  } else if (attempts >= 5) {
    lockoutSeconds = 5 * 60; // 5 minutes
  } else if (attempts >= 3) {
    lockoutSeconds = 30; // 30 seconds
  }

  try {
    localStorage.setItem(ATTEMPTS_KEY, String(attempts));
    if (lockoutSeconds > 0) {
      localStorage.setItem(LOCKOUT_KEY, String(Date.now() + lockoutSeconds * 1000));
    }
  } catch {}

  return { attempts, lockoutSeconds };
}

function resetFailedAttempts() {
  try {
    localStorage.removeItem(ATTEMPTS_KEY);
    localStorage.removeItem(LOCKOUT_KEY);
  } catch {}
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// In-memory module cache for instant validation across views
let inMemoryPin: string | null = null;
let fetchPinPromise: Promise<string | null> | null = null;

/**
 * Prefetches the access PIN into memory and localStorage ahead of time.
 * Safe to call multiple times; deduplicates concurrent in-flight requests.
 */
export function prefetchAccessPin(): Promise<string | null> {
  if (inMemoryPin) return Promise.resolve(inMemoryPin);
  if (fetchPinPromise) return fetchPinPromise;

  fetchPinPromise = (async () => {
    try {
      // 1. Check localStorage first for instant offline/cached access
      const cached = localStorage.getItem(LOCAL_PIN_CACHE_KEY);
      if (cached) {
        inMemoryPin = cached;
      }

      // 2. Query Supabase with a 4-second timeout to avoid hanging on slow network/cold start
      const timeoutPromise = new Promise<{ data: null; error: string }>((resolve) =>
        setTimeout(() => resolve({ data: null, error: 'timeout' }), 4000)
      );

      const queryPromise = supabase
        .from('app_config')
        .select('value')
        .eq('key', 'access_pin')
        .single();

      const res = (await Promise.race([queryPromise, timeoutPromise])) as {
        data: { value: string } | null;
        error: any;
      };

      if (!res.error && res.data?.value) {
        inMemoryPin = res.data.value;
        try {
          localStorage.setItem(LOCAL_PIN_CACHE_KEY, res.data.value);
        } catch {}
        return res.data.value;
      }

      return inMemoryPin;
    } catch (err) {
      console.warn('Silent access PIN prefetch error:', err);
      return inMemoryPin;
    } finally {
      fetchPinPromise = null;
    }
  })();

  return fetchPinPromise;
}

interface PinGateProps {
  children: ReactNode;
  onBackToPortal?: () => void;
}

export function PinGate({ children, onBackToPortal }: PinGateProps) {
  const [verified, setVerified] = useState(() => sessionStorage.getItem(SESSION_KEY) === 'true');
  const [correctPin, setCorrectPin] = useState<string | null>(() => {
    return inMemoryPin || localStorage.getItem(LOCAL_PIN_CACHE_KEY);
  });
  const [verifying, setVerifying] = useState(false);
  const [lockoutRemaining, setLockoutRemaining] = useState<number>(() => getLockoutRemainingSeconds());
  const [digits, setDigits] = useState<string[]>(Array(PIN_LENGTH).fill(''));
  const [error, setError] = useState('');
  const [shaking, setShaking] = useState(false);
  const [success, setSuccess] = useState(false);
  const [showPin, setShowPin] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  // Lockout countdown timer
  useEffect(() => {
    if (lockoutRemaining <= 0) return;

    const interval = setInterval(() => {
      const remaining = getLockoutRemainingSeconds();
      setLockoutRemaining(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
        setError('');
        setTimeout(() => inputRefs.current[0]?.focus(), 100);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [lockoutRemaining]);

  // Prefetch and sync PIN in background without blocking UI
  useEffect(() => {
    if (verified) return;

    prefetchAccessPin().then((pin) => {
      if (pin) {
        setCorrectPin(pin);
      }
    });

    // Auto-focus first input immediately on mount if not locked out
    if (lockoutRemaining <= 0) {
      const timer = setTimeout(() => {
        inputRefs.current[0]?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [verified, lockoutRemaining]);

  if (verified) {
    return <>{children}</>;
  }

  const handleDigitChange = (index: number, value: string) => {
    if (lockoutRemaining > 0) return;

    // Only allow numeric input
    const digit = value.replace(/\D/g, '').slice(-1);
    const newDigits = [...digits];
    newDigits[index] = digit;
    setDigits(newDigits);
    setError('');

    // Auto-advance to next input
    if (digit && index < PIN_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when all digits are filled
    if (digit && index === PIN_LENGTH - 1) {
      const fullPin = newDigits.join('');
      if (fullPin.length === PIN_LENGTH) {
        validatePin(fullPin);
      }
    }
  };

  const handleKeyDown = (index: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (lockoutRemaining > 0) return;

    if (e.key === 'Backspace') {
      if (!digits[index] && index > 0) {
        // Move back and clear previous
        const newDigits = [...digits];
        newDigits[index - 1] = '';
        setDigits(newDigits);
        inputRefs.current[index - 1]?.focus();
        e.preventDefault();
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      inputRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < PIN_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    } else if (e.key === 'Enter') {
      const fullPin = digits.join('');
      if (fullPin.length === PIN_LENGTH) {
        validatePin(fullPin);
      }
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLInputElement>) => {
    if (lockoutRemaining > 0) return;
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, PIN_LENGTH);
    if (pasted.length > 0) {
      const newDigits = Array(PIN_LENGTH).fill('');
      for (let i = 0; i < pasted.length; i++) {
        newDigits[i] = pasted[i];
      }
      setDigits(newDigits);
      setError('');
      // Focus the next empty or last input
      const focusIdx = Math.min(pasted.length, PIN_LENGTH - 1);
      inputRefs.current[focusIdx]?.focus();

      if (pasted.length === PIN_LENGTH) {
        validatePin(pasted);
      }
    }
  };

  const validatePin = async (pin: string) => {
    if (lockoutRemaining > 0) return;

    let targetPin = correctPin;

    if (!targetPin) {
      setVerifying(true);
      targetPin = await prefetchAccessPin();
      setVerifying(false);
    }

    // Fail-open fallback if database is completely offline/unreachable
    if (!targetPin) {
      resetFailedAttempts();
      setSuccess(true);
      sessionStorage.setItem(SESSION_KEY, 'true');
      setTimeout(() => setVerified(true), 800);
      return;
    }

    const isMatch = await verifyPinAgainstHashOrPlain(pin, targetPin);

    if (isMatch) {
      resetFailedAttempts();
      setSuccess(true);
      sessionStorage.setItem(SESSION_KEY, 'true');
      setTimeout(() => setVerified(true), 800);
    } else {
      const { attempts, lockoutSeconds } = recordFailedAttempt();

      if (lockoutSeconds > 0) {
        setLockoutRemaining(lockoutSeconds);
        setError(`Too many failed attempts. Device locked for ${formatDuration(lockoutSeconds)}.`);
      } else {
        const remainingBeforeLockout = 3 - attempts;
        setError(
          remainingBeforeLockout > 0
            ? `Incorrect PIN. ${remainingBeforeLockout} attempt${remainingBeforeLockout === 1 ? '' : 's'} remaining before cooldown.`
            : 'Incorrect PIN. Please try again.'
        );
      }

      setShaking(true);
      setTimeout(() => {
        setShaking(false);
        setDigits(Array(PIN_LENGTH).fill(''));
        if (lockoutSeconds <= 0) {
          inputRefs.current[0]?.focus();
        }
      }, 600);
    }
  };

  const handleSubmit = () => {
    if (lockoutRemaining > 0) return;
    const fullPin = digits.join('');
    if (fullPin.length === PIN_LENGTH) {
      validatePin(fullPin);
    }
  };

  const allFilled = digits.every((d) => d !== '');

  return (
    <div className={`pin-gate-overlay ${success ? 'pin-gate--success' : ''}`}>
      <div className={`pin-gate-card ${shaking ? 'pin-shake' : ''}`}>
        {success ? (
          <>
            <div className="pin-success-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
                <path d="M5 13l4 4L19 7" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <p className="pin-success-text">Welcome in! 🐱</p>
          </>
        ) : (
          <>
            {/* Avatar & Branding */}
            <div className="pin-gate-avatar-wrapper">
              <img src="/avatar.jpg" alt="fluffykitten" className="pin-gate-avatar" />
            </div>

            <h2 className="pin-gate-title">Enter Access PIN</h2>
            <p className="pin-gate-subtitle">
              Please enter your 6-digit PIN to continue
            </p>

            {/* Lockout Banner */}
            {lockoutRemaining > 0 && (
              <div className="pin-lockout-banner animate-fade-in">
                <span className="pin-lockout-icon">⏳</span>
                <div className="pin-lockout-text">
                  <strong>Cooldown Active</strong>
                  <span>Please wait <span className="pin-lockout-timer">{formatDuration(lockoutRemaining)}</span> before trying again.</span>
                </div>
              </div>
            )}

            {/* Digit inputs */}
            <div className="pin-digits-row">
              {digits.map((digit, i) => (
                <input
                  key={i}
                  ref={(el) => { inputRefs.current[i] = el; }}
                  type={showPin ? 'text' : 'password'}
                  inputMode="numeric"
                  maxLength={1}
                  value={digit}
                  disabled={lockoutRemaining > 0}
                  onChange={(e) => handleDigitChange(i, e.target.value)}
                  onKeyDown={(e) => handleKeyDown(i, e)}
                  onPaste={i === 0 ? handlePaste : undefined}
                  className={`pin-digit-input ${digit ? 'pin-digit--filled' : ''} ${error ? 'pin-digit--error' : ''}`}
                  autoComplete="off"
                  aria-label={`PIN digit ${i + 1}`}
                />
              ))}
            </div>

            {/* Visibility Mask Toggle */}
            <div className="pin-mask-toggle-wrap">
              <button
                type="button"
                className="pin-mask-toggle-btn"
                onClick={() => setShowPin(!showPin)}
                title={showPin ? 'Hide PIN numbers' : 'Show PIN numbers'}
              >
                {showPin ? (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                    <span>Hide Numbers</span>
                  </>
                ) : (
                  <>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                    <span>Show Numbers</span>
                  </>
                )}
              </button>
            </div>

            {/* Error */}
            <div className="pin-error-msg">
              {error && (
                <>
                  <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                  {error}
                </>
              )}
            </div>

            {/* Submit */}
            <button
              className="pin-submit-btn"
              onClick={handleSubmit}
              disabled={!allFilled || verifying || lockoutRemaining > 0}
              id="pin-submit-btn"
            >
              {lockoutRemaining > 0
                ? `Cooldown (${formatDuration(lockoutRemaining)})`
                : verifying
                  ? 'Verifying…'
                  : 'Unlock'}
            </button>

            {onBackToPortal && (
              <button
                type="button"
                className="pin-back-portal-btn"
                onClick={onBackToPortal}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--color-text-secondary)',
                  fontSize: '0.8125rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  marginTop: '10px',
                }}
              >
                ← Back to Portal Landing Page
              </button>
            )}

            <a
              href="https://github.com/fluffykitten"
              target="_blank"
              rel="noopener noreferrer"
              className="pin-gate-creator-link"
            >
              by github.com/fluffykitten
            </a>
          </>
        )}
      </div>
    </div>
  );
}
