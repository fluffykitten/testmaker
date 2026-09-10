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

    // Graceful local development bypass if no site key is set
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
        // Clean up any existing widget instance
        if (widgetIdRef.current) {
          window.turnstile.remove(widgetIdRef.current);
          widgetIdRef.current = null;
        }

        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          size: 'invisible', // 100% Invisible Mode as requested
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

  // Hidden container for invisible mode challenge
  return (
    <div
      ref={containerRef}
      className={`turnstile-invisible-container ${className || ''}`}
      style={{ display: 'none', position: 'absolute', width: 0, height: 0, overflow: 'hidden' }}
      aria-hidden="true"
    />
  );
};
