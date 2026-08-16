import React from "react";

interface State {
  error?: Error;
}

/**
 * 渲染层最后一道保险：组件运行时异常时显示可操作提示，避免整窗白屏。
 * 详细堆栈仍通过 console.error 进入主进程日志 ~/.wuwei/logs/minicc.log。
 */
export class RendererErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[renderer-fatal]", error, info.componentStack);
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main style={styles.page}>
        <section style={styles.card}>
          <div style={styles.mark}>无为</div>
          <h1 style={styles.title}>界面加载失败</h1>
          <p style={styles.text}>客户端遇到渲染异常，没有丢失你的会话数据。请先重启；若仍失败，可把下方错误发给开发者。</p>
          <pre style={styles.error}>{this.state.error.message || String(this.state.error)}</pre>
          <button style={styles.button} onClick={() => window.location.reload()}>重新加载</button>
        </section>
      </main>
    );
  }
}

const styles: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", display: "grid", placeItems: "center", padding: 24, color: "#F4F6F8", background: "#16191E", fontFamily: '"Microsoft YaHei", system-ui, sans-serif' },
  card: { width: "min(560px, 100%)", padding: 30, border: "1px solid rgba(244,246,248,.14)", borderRadius: 16, background: "#1E232A", boxShadow: "0 24px 60px rgba(0,0,0,.28)" },
  mark: { color: "#C05F3C", fontSize: 14, letterSpacing: ".18em" },
  title: { margin: "12px 0", fontSize: 24, fontWeight: 600 },
  text: { margin: "0 0 18px", color: "#B7C0C7", fontSize: 14, lineHeight: 1.75 },
  error: { maxHeight: 160, overflow: "auto", padding: 12, borderRadius: 8, color: "#F0C2B3", background: "#12151A", whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12 },
  button: { marginTop: 18, padding: "9px 18px", border: 0, borderRadius: 8, color: "#fff", background: "#C05F3C", cursor: "pointer" },
};
