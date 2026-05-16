import React from "react";

interface State {
  hasError: boolean;
  error?: Error;
}

export default class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 24, fontFamily: "sans-serif" }}>
          <h2 style={{ color: "#c0392b" }}>系統發生錯誤</h2>
          <p style={{ color: "#666" }}>請重新整理頁面，若問題持續請聯絡客服。</p>
          {this.state.error?.message && (
            <pre
              style={{
                background: "#f8f8f8",
                padding: 12,
                marginTop: 12,
                fontSize: 12,
                color: "#666",
                overflow: "auto",
              }}
            >
              {this.state.error.message}
            </pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
