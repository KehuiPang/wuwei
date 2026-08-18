import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { Splash } from "./components/Splash.js";
import { RendererErrorBoundary } from "./components/RendererErrorBoundary.js";
import "highlight.js/styles/github.css";
import "./theme.css";
import "./baby/baby.css"; // 数字婴儿 VI(色/间距/圆角/动效标准) + 形象动画

createRoot(document.getElementById("root")!).render(
  <RendererErrorBoundary>
    <App />
    {/* 开屏动画覆盖层：置于 App 之上，播完淡出自卸载，露出主界面 */}
    <Splash />
  </RendererErrorBoundary>,
);
console.log("[boot] renderer mounted ok");
