import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { installHostedRuntime } from "./hosted";

installHostedRuntime();

class Boundary extends React.Component<{ children: React.ReactNode }, { err: any }> {
  state = { err: null as any };
  static getDerivedStateFromError(err: any) { return { err }; }
  render() {
    if (this.state.err) return <div className="content"><div className="card"><h2>Something went wrong on this page</h2><p className="small muted" style={{ marginTop: 6 }}>{String(this.state.err?.message ?? this.state.err)}</p><button className="btn" style={{ marginTop: 10 }} onClick={() => this.setState({ err: null })}>Try again</button></div></div>;
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(<Boundary><App /></Boundary>);
