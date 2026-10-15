import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  // "page" replaces the whole screen and offers a reload; "panel" stands in
  // for one part of it and offers a remount, leaving the rest working.
  scope: "page" | "panel";
  // What failed, in the person's words: "The chat".
  label?: string;
};

type State = { error: Error | null };

/**
 * Without one, a render error anywhere unmounts the whole tree and leaves a
 * blank page. A reload is the honest recovery at page scope: the document
 * lives in the realtime server, not in this tab, so nothing synced is lost.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    if (this.props.scope === "page") {
      return (
        <div className="centered" role="alert">
          <p className="error">Something went wrong and this page stopped working.</p>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      );
    }

    return (
      <div className="boundary-panel" role="alert">
        <p className="error">{this.props.label ?? "This part"} stopped working.</p>
        <button type="button" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
