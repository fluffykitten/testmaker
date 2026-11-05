import { Component, type ReactNode, type ErrorInfo } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Unhandled React error caught by ErrorBoundary:', error, errorInfo);
  }

  handleReset = () => {
    this.props.onReset?.();
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const errorMessage = String(this.state.error?.message || '');
      const isChunkLoadError =
        errorMessage.includes('dynamically imported module') ||
        errorMessage.includes('Loading chunk') ||
        errorMessage.includes('Importing a module script failed') ||
        errorMessage.includes('error loading dynamically imported module');

      if (isChunkLoadError) {
        return (
          <div
            style={{
              padding: '32px 24px',
              margin: '24px auto',
              maxWidth: '560px',
              backgroundColor: 'var(--color-surface, #ffffff)',
              border: '1px solid var(--color-primary-300, #a5b4fc)',
              borderRadius: '16px',
              boxShadow: '0 10px 25px rgba(0,0,0,0.08)',
              textAlign: 'center',
              fontFamily: 'system-ui, -apple-system, sans-serif',
            }}
          >
            <div style={{ fontSize: '2.5rem', marginBottom: '12px' }}>🔄</div>
            <h2
              style={{
                fontSize: '1.25rem',
                fontWeight: 700,
                color: 'var(--color-text-primary, #1e293b)',
                marginBottom: '8px',
              }}
            >
              New Version Available
            </h2>
            <p
              style={{
                fontSize: '0.875rem',
                color: 'var(--color-text-secondary, #64748b)',
                marginBottom: '20px',
                lineHeight: 1.5,
              }}
            >
              A new version of the platform was recently deployed. Please reload the page to get the latest components.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                padding: '10px 24px',
                backgroundColor: 'var(--color-primary-600, #4f46e5)',
                color: '#ffffff',
                border: 'none',
                borderRadius: '8px',
                fontWeight: 600,
                cursor: 'pointer',
                fontSize: '0.875rem',
                boxShadow: '0 2px 8px rgba(79, 70, 229, 0.3)',
              }}
            >
              Reload Application
            </button>
          </div>
        );
      }

      return (
        <div
          style={{
            padding: '32px 24px',
            margin: '24px auto',
            maxWidth: '600px',
            backgroundColor: 'var(--color-surface, #ffffff)',
            border: '1px solid var(--color-danger-300, #fca5a5)',
            borderRadius: '16px',
            boxShadow: '0 10px 25px rgba(0,0,0,0.1)',
            textAlign: 'center',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          <div style={{ fontSize: '2.5rem', marginBottom: '12px' }}>⚠️</div>
          <h2
            style={{
              fontSize: '1.25rem',
              fontWeight: 700,
              color: 'var(--color-text-primary, #1e293b)',
              marginBottom: '8px',
            }}
          >
            Something went wrong rendering this component
          </h2>
          <p
            style={{
              fontSize: '0.875rem',
              color: 'var(--color-text-secondary, #64748b)',
              marginBottom: '16px',
              wordBreak: 'break-word',
            }}
          >
            {this.state.error?.message || 'An unexpected error occurred.'}
          </p>
          <button
            type="button"
            onClick={this.handleReset}
            style={{
              padding: '10px 20px',
              backgroundColor: 'var(--color-primary-600, #4f46e5)',
              color: '#ffffff',
              border: 'none',
              borderRadius: '8px',
              fontWeight: 600,
              cursor: 'pointer',
              fontSize: '0.875rem',
            }}
          >
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
