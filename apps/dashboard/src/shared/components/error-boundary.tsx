import { Component, type ReactNode } from "react";

interface State {
  error: Error | null;
}

/**
 * Page-level error boundary. A render crash inside a route must not freeze the
 * shell (which looks like "the app needs a refresh") — it shows the message and
 * a retry, and the key in Shell clears it on the next navigation.
 */
export class PageErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // eslint-disable-next-line no-console
    console.error("[page] render failed:", error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="rounded-lg border border-line bg-background p-4">
        <p className="font-semibold tracking-tight">This page failed to render</p>
        <p className="mt-1 font-mono text-xs text-red-600 dark:text-red-400">{error.message}</p>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="mt-3 rounded-md border border-line px-3 py-1.5 text-sm font-medium transition-colors focus-ring hover:bg-muted/40"
        >
          Try again
        </button>
      </div>
    );
  }
}
