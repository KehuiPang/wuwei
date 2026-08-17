// Ink 展示组件：把对话条目结构化渲染成终端 UI。
import React from "react";
import { Box, Text } from "ink";
import type { SessionUsage } from "../agent/loop.js";

// 终端界面文案跟随语言（WUWEI_LANG 在 src/index.tsx 入口按系统语言定，桌面端由设置写入）
const tt = (zh: string, en: string) => (process.env.WUWEI_LANG === "en" ? en : zh);

export type Item =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | {
      type: "tool";
      name: string;
      input: Record<string, unknown>;
      result?: string;
      isError?: boolean;
      status: "running" | "done" | "denied";
    }
  | { type: "notice"; text: string };

function previewInput(input: Record<string, unknown>): string {
  const s = JSON.stringify(input);
  return s.length > 120 ? s.slice(0, 120) + "…" : s;
}

// 工具结果只显示前若干行，超出提示截断
function clip(text: string, lines = 8): { body: string; clipped: boolean } {
  const arr = text.split("\n");
  return { body: arr.slice(0, lines).join("\n"), clipped: arr.length > lines };
}

export function ToolView({ item }: { item: Extract<Item, { type: "tool" }> }) {
  const mark =
    item.status === "running" ? "⚙" : item.status === "denied" ? "⊘" : item.isError ? "✗" : "✓";
  const markColor =
    item.status === "running"
      ? "yellow"
      : item.status === "denied"
        ? "gray"
        : item.isError
          ? "red"
          : "green";
  const clipped = item.result ? clip(item.result) : null;
  return (
    <Box flexDirection="column" marginLeft={2} marginY={0}>
      <Text>
        <Text color={markColor}>{mark} </Text>
        <Text color="cyan">{item.name}</Text>
        <Text dimColor> {previewInput(item.input)}</Text>
      </Text>
      {clipped && (
        <Box marginLeft={2} flexDirection="column">
          <Text dimColor>{clipped.body}</Text>
          {clipped.clipped && <Text dimColor>{tt("…（已截断）", "…(truncated)")}</Text>}
        </Box>
      )}
    </Box>
  );
}

export function MessageItem({ item }: { item: Item }) {
  if (item.type === "user")
    return (
      <Box marginTop={1}>
        <Text color="green">› </Text>
        <Text bold>{item.text}</Text>
      </Box>
    );
  if (item.type === "assistant")
    return (
      <Box marginTop={1}>
        <Text>{item.text}</Text>
      </Box>
    );
  if (item.type === "notice")
    return (
      <Box marginTop={1}>
        <Text color="yellow">ⓘ {item.text}</Text>
      </Box>
    );
  return <ToolView item={item} />;
}

export function StatusBar({
  provider,
  model,
  usage,
  busy,
}: {
  provider: string;
  model: string;
  usage: SessionUsage;
  busy: boolean;
}) {
  return (
    <Box marginTop={1}>
      <Text dimColor>
        {busy ? "● " : "○ "}
        {provider} · {model} │ {tt("本上下文≈", "context ≈")}
        {usage.lastInput} · {tt("累计 in ", "total in ")}
        {usage.totalInput}/out {usage.totalOutput} │ /help /reset /exit
      </Text>
    </Box>
  );
}

export function PermissionPrompt({
  name,
  input,
}: {
  name: string;
  input: Record<string, unknown>;
}) {
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">
        {tt("需要执行 ", "Wants to run ")}
        <Text bold>{name}</Text>
      </Text>
      <Text dimColor>{previewInput(input)}</Text>
      <Text>
        {tt("允许? ", "Allow? ")}
        <Text color="green">y</Text> / <Text color="red">N</Text> / <Text color="cyan">a</Text>
        {tt("=总是允许该工具", "=always allow this tool")}
      </Text>
    </Box>
  );
}
