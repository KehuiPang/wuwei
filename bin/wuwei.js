#!/usr/bin/env node
// 无为 CLI 启动器：用 tsx 运行 TS 源码（无需预编译）。
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../src/index.tsx");
const tsx = resolve(here, "../node_modules/.bin/tsx");

const child = spawn(tsx, [entry], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
