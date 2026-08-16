import React from "react";

interface State {
  error?: Error;
}

/**
 * 语言判断内联实现：ErrorBoundary 是崩溃后的兜底，不能依赖 context/hook，
 * 也不引入 i18n.ts（避免其副作用在已崩溃的环境里再次抛错）。
 * 直接读 i18n.ts 用的同一个 key（wuwei_lang，值 "zh"/"en"），读不到看时区/系统语言，出错兜底中文。
 */
function isEn(): boolean {
  try {
    const saved = localStorage.getItem("wuwei_lang");
    if (saved === "en") return true;
    if (saved === "zh") return false;
    // 没手选过：跟 getLang() 同一套猜法，免得崩溃页语言和主界面对不上
    const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone || "").toLowerCase();
    if (/shanghai|chongqing|harbin|urumqi|kashgar|hong_kong|macau|taipei/.test(tz)) return false;
    return !/^zh/i.test(navigator.language || "");
  } catch {
    return false;
  }
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
    const en = isEn();
    return (
      <main style={styles.page}>
        <section style={styles.card}>
          <div style={styles.mark}>{en ? "Wuwei" : "无为"}</div>
          <h1 style={styles.title}>{en ? "The interface failed to load" : "界面加载失败"}</h1>
          <p style={styles.text}>
            {en
              ? "Something went wrong while rendering, but none of your conversations were lost. Try reloading first; if that keeps failing, send the error below to the developers."
              : "客户端遇到渲染异常，没有丢失你的会话数据。请先重启；若仍失败，可把下方错误发给开发者。"}
          </p>
          <pre style={styles.error}>{this.state.error.message || String(this.state.error)}</pre>
          <button style={styles.button} onClick={() => window.location.reload()}>{en ? "Reload" : "重新加载"}</button>
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
