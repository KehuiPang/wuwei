# 无为 (wuwei)

AI Agent（CLI + 桌面版）。

本质：**LLM + 工具执行循环 + 界面**。模型接各家 API 或本地 OpenAI 兼容端点（vLLM / Ollama 等），壳（harness）全自研。

## 运行

```bash
npm install

# 方式一：接 Claude API
export ANTHROPIC_API_KEY=sk-...
export WUWEI_MODEL=claude-sonnet-5      # 可选
npm run dev

# 方式二：接本地/兼容端点（vLLM / Ollama 等）
export WUWEI_BASE_URL=http://localhost:8000/v1
export WUWEI_MODEL=qwen3-coder
npm run dev
```

进入后直接输入需求；`/reset` 清空对话，`/exit` 退出。写文件/跑命令类操作会请求确认（y / N / a=以后总是允许该工具）。

## 结构

```
src/
  index.tsx         终端入口（Ink TUI）：构造 Agent 并 render <App/>
  config.ts         从环境变量决定模型后端
  types.ts          统一消息/工具/Provider 类型（贴近 Anthropic Messages 语义）
  agent/
    loop.ts         ★ Agent 主循环 + token 计数 + 上下文自动压缩
    provider.ts     四后端：anthropic(api-key/oauth) / openai 兼容 / codex(Responses)
    prompt.ts       系统提示词
  tools/index.ts    read/write/edit/bash/glob/grep 工具集
  ui/
    app.tsx         Ink 主应用（把流式 hooks 映射成 React 状态）
    views.tsx       展示组件：消息/工具块/状态栏/权限确认框
  *-test.ts(x)      可复现验证：oauth-mock / codex-probe / codex-agent / compact / ui
```

## 路线

- [x] P0 打通循环
- [x] P1 工具补齐（read/write/edit/bash/glob/grep）+ 流式输出 + 权限确认
- [x] P1.5 Claude 订阅 OAuth 请求方式（本地 mock 调通）
- [x] P1.6 Codex 订阅版（ChatGPT 登录 / Responses API，真机跑通，model=gpt-5.5）
- [x] P2 上下文自动压缩（长任务不崩）+ token 计数
- [x] P3 Ink TUI（结构化消息/工具块、权限确认框、状态栏 token、slash 命令）
- [x] P4 Electron 桌面 GUI（多会话、流式、Markdown、图片、快捷切换）
- [x] P5 多平台预设 + 账号/额度体系（见下）
- [ ] P6 子 Agent / MCP 挂载 / 记忆文件(CLAUDE.md) / diff 高亮

## 桌面版（Electron GUI）

- **供应商预设**：Codex 订阅 / Claude 订阅(Claude Code) / Claude API / OpenAI / 智谱 GLM / DeepSeek / MiniMax / 豆包 / 通义千问 / Kimi / Kimi Code 订阅 / 腾讯混元 / Grok / 自定义端点；各平台凭证分槽保存，底栏可快捷切供应商/模型。
- **账号 & 额度**（均实测响应头/接口对齐）：
  - DeepSeek / 智谱：账户余额 + 本会话消耗(token×单价)
  - Claude 订阅：用户名/邮箱/套餐(读 `~/.claude.json`) + 5小时/周额度(`anthropic-ratelimit-unified-*`)
  - Codex/GPT：套餐 + 5小时/周额度(`x-codex-*`)
- **流式输出** + **上下文自动压缩**(按各模型真实窗口的 80%)。

后端类型：`anthropic`(api-key)、`anthropic`+OAuth(Claude 订阅)、`openai`兼容(DeepSeek/智谱/Kimi/… 及本地 vLLM)、`codex`(ChatGPT 订阅)。
省额度：`WUWEI_COMPACT_THRESHOLD`(默认取模型窗口 80%) 超阈值自动把旧历史总结成摘要；`WUWEI_KEEP_RECENT`(默认6) 保留最近条数。

## 更新日志

### v1.2.0
- **Claude 订阅一键授权**：应用内窗口 / 系统浏览器（复用已登录 Google 账号，授权码回填）两种方式，PKCE（关键点 `state=verifier`，否则 claude.ai 报 Invalid request format）；免去手动 `claude setup-token` + 复制粘贴
- **连通状态灯**（底栏）：🔴 未配置/未授权 · 🟢 实测 ping 通 · 🟡 已配置但报错；点击弹说明并一键引导修复；切平台/切模型自动重测
- **API Key 复制即自动设置**：缺 key 时点「去获取 XX 的 API Key」开官网，复制后自动读剪贴板 → 按平台验证连通 → 通过即落库并提示「已设置完成」；内联授权条与设置页同一逻辑，无需手动粘贴/确认
- **缺凭证提示按平台自适应**：Claude→一键 OAuth；Codex→引导终端 `codex login`；通义千问/DeepSeek/智谱等→跳各自官网获取 key
- **系统提示词可配置**：设置里查看 / 编辑 / 清空（全局，`{model}`/`{cwd}` 占位符自动替换）
- 报错提示中文化 + 同类去重；Codex 订阅补充可选模型；修 OAuth 模式空系统文本块导致 400；Windows 窗口/任务栏图标

### v1.1.0
- **桌面版新增供应商**：智谱 GLM / Kimi / 腾讯混元 / Grok
- **账号 & 额度对接**（均实测响应头/接口对齐）：DeepSeek·智谱 余额 + 本会话消耗；Claude 订阅 用户名/邮箱/套餐（读 `~/.claude.json`）+ 5小时/周额度；Codex/GPT 套餐 + 额度
- **流式输出**；底栏供应商/模型**快捷切换**；**应用设置弹窗**（Claude Code token 过期刷新开关，默认关）
- **凭证分槽保护**：修复切换供应商时 API key 被清空
- 上下文压缩按各模型真实窗口（80%）；UI：模型选平台下方 + 灰字、简约眼睛图标、供应商顺序、各家 keyUrl 修正

### v1.0.0
- 从零复刻 Claude Code：LLM + 工具循环 + UI；四后端（Claude API / 订阅 OAuth / OpenAI 兼容 / Codex）；工具集 + 权限确认；上下文压缩 + token 计数；Ink TUI + Electron 桌面版。
