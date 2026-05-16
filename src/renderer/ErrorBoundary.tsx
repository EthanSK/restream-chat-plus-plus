import React from 'react';

/**
 * Renderer-wide React error boundary.
 *
 * Without this, any throw during render (hook-rule violation, IPC crash,
 * unhandled async rejection bubbling into render via a setState) blanks
 * the entire window with no UI feedback — the user just sees an empty
 * dark rectangle and has no way to recover. v0.1.15 shipped exactly that
 * symptom because of a hook-ordering bug in ChatInputInline (see commit
 * history for details).
 *
 * The boundary catches anything thrown during a child render or lifecycle
 * call and shows:
 *   - a human-readable header
 *   - the error message + (collapsed) stack
 *   - a "Reset settings + retry" button that nukes localStorage and
 *     reloads the renderer. The OAuth token lives in the main-process
 *     electron-store (not localStorage), so this is non-destructive to
 *     the user's session — it only clears any renderer-side caches.
 *   - a plain "Reload" button for the common case where a transient
 *     render-time blip just needs a redraw.
 *
 * We intentionally avoid trying to recover IN-PLACE (i.e. clearing the
 * error state and re-rendering children) because the same hook-violation
 * would just throw again on the next render. A full document reload is
 * the most reliable recovery.
 */
interface State {
  error?: Error;
  info?: React.ErrorInfo;
}

interface Props {
  children: React.ReactNode;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Log to the renderer console so it shows up in DevTools + when the
    // user launches with `--enable-logging` from the terminal.
    console.error('[ErrorBoundary] caught render error', error, info);
    this.setState({ error, info });
  }

  private resetAndReload = (): void => {
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch {
      // best-effort; storage may be disabled
    }
    location.reload();
  };

  private reload = (): void => {
    location.reload();
  };

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    const { error, info } = this.state;
    return (
      <div className="error-boundary" role="alert" aria-live="assertive">
        <div className="error-boundary-card">
          <h1>Restream Chat++ encountered an error</h1>
          <p className="error-boundary-msg">
            {error.message || String(error) || 'Unknown error'}
          </p>
          <details className="error-boundary-stack">
            <summary>Stack trace</summary>
            <pre>{error.stack || '(no stack)'}</pre>
            {info?.componentStack ? (
              <>
                <strong>Component stack:</strong>
                <pre>{info.componentStack}</pre>
              </>
            ) : null}
          </details>
          <div className="error-boundary-actions">
            <button
              type="button"
              className="btn primary"
              onClick={this.reload}
            >
              Reload
            </button>
            <button
              type="button"
              className="btn"
              onClick={this.resetAndReload}
              title="Clears localStorage/sessionStorage and reloads. Does NOT sign you out — OAuth tokens live in the main process."
            >
              Reset settings + retry
            </button>
          </div>
          <p className="error-boundary-foot">
            If this keeps happening, click <strong>Logs</strong> in the
            toolbar (after reloading) and report the issue on GitHub.
          </p>
        </div>
      </div>
    );
  }
}
