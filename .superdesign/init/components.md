# Shared UI Primitives

This file documents core reusable UI primitives with their full source implementations.

---

## ConfirmDeleteModal
- **File**: `src/components/ConfirmDeleteModal.tsx`
- **Description**: Modal dialog for confirming destructive operations with backdrop dismiss and loading state.
- **Props**:
  - `isOpen: boolean`
  - `title: string`
  - `message: string`
  - `isDeleting?: boolean`
  - `confirmLabel?: string`
  - `onConfirm: () => void`
  - `onCancel: () => void`

```tsx
import { createPortal } from 'react-dom';
import { useBackdropDismiss } from '../hooks/useBackdropDismiss';
import './ConfirmDeleteModal.css';

interface ConfirmDeleteModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  isDeleting?: boolean;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDeleteModal({
  isOpen,
  title,
  message,
  isDeleting = false,
  confirmLabel = 'Delete Permanently',
  onConfirm,
  onCancel,
}: ConfirmDeleteModalProps) {
  const backdropDismiss = useBackdropDismiss(onCancel);

  if (!isOpen) return null;

  return createPortal(
    <div className="confirm-overlay" {...backdropDismiss}>
      <div className="confirm-card" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-icon-wrap">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
        </div>

        <h3 className="confirm-title">{title}</h3>
        <p className="confirm-message">{message}</p>

        <div className="confirm-actions">
          <button
            type="button"
            className="confirm-btn confirm-btn--cancel"
            onClick={onCancel}
            disabled={isDeleting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="confirm-btn confirm-btn--danger"
            onClick={onConfirm}
            disabled={isDeleting}
          >
            {isDeleting ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
```

---

## TurnstileWidget
- **File**: `src/components/TurnstileWidget.tsx`
- **Description**: Invisible Cloudflare Turnstile bot verification wrapper with graceful fallback.
- **Props**:
  - `onVerify: (token: string) => void`
  - `onError?: (error?: any) => void`
  - `onExpire?: () => void`
  - `action?: string`
  - `className?: string`

```tsx
import React, { useEffect, useRef } from 'react';

declare global {
  interface Window {
    turnstile?: {
      render: (container: HTMLElement | string, params: any) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
      execute: (container?: HTMLElement | string, params?: any) => void;
    };
    onTurnstileLoaded?: () => void;
  }
}

interface TurnstileWidgetProps {
  onVerify: (token: string) => void;
  onError?: (error?: any) => void;
  onExpire?: () => void;
  action?: string;
  className?: string;
}

const SCRIPT_ID = 'cf-turnstile-script';
let isScriptLoading = false;

function loadTurnstileScript(): Promise<void> {
  return new Promise((resolve) => {
    if (window.turnstile) {
      resolve();
      return;
    }

    if (document.getElementById(SCRIPT_ID)) {
      const checkInterval = setInterval(() => {
        if (window.turnstile) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 50);
      return;
    }

    if (isScriptLoading) return;
    isScriptLoading = true;

    window.onTurnstileLoaded = () => {
      resolve();
    };

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=onTurnstileLoaded';
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  });
}

export const TurnstileWidget: React.FC<TurnstileWidgetProps> = ({
  onVerify,
  onError,
  onExpire,
  action,
  className,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY;

    if (!siteKey) {
      const timer = setTimeout(() => {
        onVerify('dev-bypass-turnstile-token');
      }, 50);
      return () => clearTimeout(timer);
    }

    let isMounted = true;

    loadTurnstileScript().then(() => {
      if (!isMounted || !containerRef.current || !window.turnstile) return;

      try {
        if (widgetIdRef.current) {
          window.turnstile.remove(widgetIdRef.current);
          widgetIdRef.current = null;
        }

        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          size: 'invisible',
          action: action || 'generic',
          callback: (token: string) => {
            if (isMounted) onVerify(token);
          },
          'error-callback': (err: any) => {
            console.warn('[TurnstileWidget] Challenge error:', err);
            if (isMounted && onError) onError(err);
          },
          'expired-callback': () => {
            if (isMounted && onExpire) onExpire();
          },
        });
      } catch (err) {
        console.warn('[TurnstileWidget] Render error, bypassing for resilience:', err);
        if (isMounted) onVerify('dev-bypass-turnstile-token');
      }
    });

    return () => {
      isMounted = false;
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {}
        widgetIdRef.current = null;
      }
    };
  }, [action, onVerify, onError, onExpire]);

  return (
    <div
      ref={containerRef}
      className={`turnstile-invisible-container ${className || ''}`}
      style={{ display: 'none', position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
      aria-hidden="true"
    />
  );
};
```

---

## ConnectionStatus
- **File**: `src/components/ConnectionStatus.tsx`
- **Description**: Real-time Supabase connection health indicator pill with pulse status icon.
- **Props**: None (self-contained status listener)

```tsx
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

type ConnectionState = 'connecting' | 'connected' | 'error';

export function ConnectionStatus() {
  const [state, setState] = useState<ConnectionState>('connecting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    async function checkConnection() {
      try {
        setState('connecting');
        const { error } = await supabase
          .from('syllabuses')
          .select('id', { count: 'exact', head: true });

        if (error) {
          if (error.message.includes('relation') && error.message.includes('does not exist')) {
            setState('connected');
            setErrorMsg('Connected, but tables not found. Run the SQL migration first.');
          } else {
            setState('error');
            setErrorMsg(error.message);
          }
        } else {
          setState('connected');
          setErrorMsg(null);
        }
      } catch (err: unknown) {
        setState('error');
        setErrorMsg(err instanceof Error ? err.message : 'Unknown connection error');
      }
    }

    checkConnection();
  }, []);

  const stateConfig = {
    connecting: {
      color: 'var(--color-warning-400)',
      label: 'Connecting…',
      bgClass: 'connecting',
    },
    connected: {
      color: 'var(--color-accent-500)',
      label: 'Supabase Connected',
      bgClass: 'connected',
    },
    error: {
      color: 'var(--color-danger-500)',
      label: 'Connection Failed',
      bgClass: 'error',
    },
  };

  const config = stateConfig[state];

  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: '8px',
      padding: '6px 14px',
      borderRadius: 'var(--radius-xl)',
      background: state === 'connected'
        ? 'rgba(16, 185, 129, 0.1)'
        : state === 'error'
          ? 'rgba(244, 63, 94, 0.1)'
          : 'rgba(251, 191, 36, 0.1)',
      border: `1px solid ${config.color}30`,
      fontSize: '0.8125rem',
      fontWeight: 500,
      color: config.color,
      transition: 'all var(--transition-base)',
    }}>
      <span
        style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: config.color,
          animation: state === 'connecting' ? 'pulse-soft 1.5s ease-in-out infinite' : 'none',
          boxShadow: state === 'connected' ? `0 0 8px ${config.color}60` : 'none',
        }}
      />
      <span>{config.label}</span>
      {errorMsg && (
        <span style={{
          fontSize: '0.75rem',
          color: 'var(--color-text-tertiary)',
          marginLeft: '4px',
        }}>
          — {errorMsg}
        </span>
      )}
    </div>
  );
}
```
