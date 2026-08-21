import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

type ConnectionState = 'connecting' | 'connected' | 'error';

/**
 * Pings Supabase on mount by running a lightweight query.
 * Displays a live connection indicator — green (connected), amber (connecting), red (error).
 */
export function ConnectionStatus() {
  const [state, setState] = useState<ConnectionState>('connecting');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    async function checkConnection() {
      try {
        setState('connecting');
        // Lightweight query — just check if we can reach the database
        const { error } = await supabase
          .from('syllabuses')
          .select('id', { count: 'exact', head: true });

        if (error) {
          // Table might not exist yet — check if it's just a missing relation
          if (error.message.includes('relation') && error.message.includes('does not exist')) {
            // Connection works, but schema not yet applied
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
