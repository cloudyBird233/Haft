import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from './ui/button';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Last-resort recovery surface for unexpected render errors. Route-level error
 * states handle expected API failures; this catches programming errors so the
 * app never becomes a blank white page.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Unhandled application error', error, info.componentStack);
  }

  private handleReload = (): void => {
    window.location.reload();
  };

  override render(): ReactNode {
    if (this.state.error) {
      return (
        <main
          data-testid="app-error-boundary"
          className="flex min-h-screen items-center justify-center bg-canvas px-6 text-ink"
        >
          <section
            className="panel w-full max-w-md p-7 text-center"
            aria-labelledby="app-error-title"
          >
            <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-[#fbf1ee] text-[#873d2f]">
              <AlertTriangle size={20} aria-hidden="true" />
            </span>
            <h1
              id="app-error-title"
              role="alert"
              className="mt-4 text-[18px] font-semibold tracking-[-0.02em]"
            >
              Something went wrong
            </h1>
            <p className="mt-2 text-[12.5px] leading-5 text-muted">
              The interface hit an unexpected error. Reloading the application will restore the
              latest persisted state.
            </p>
            <Button
              variant="primary"
              className="mt-5"
              onClick={this.handleReload}
              data-testid="app-error-reload-button"
            >
              <RotateCcw size={14} aria-hidden="true" />
              Reload application
            </Button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
