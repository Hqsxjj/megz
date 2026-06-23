#!/usr/bin/env node
/**
 * Start both wrangler dev (Cloudflare Worker) and the WeChat bridge.
 *
 * Usage: node bridge/scripts/start-all.js
 *
 * Both processes share the same terminal — Ctrl+C kills both.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

console.log("🚀 megz 全栈启动");
console.log("   wrangler dev  +  Claude → WeChat 桥接\n");

// ── Start wrangler dev ──────────────────────────────────────────────────

const wrangler = spawn("npx", ["wrangler", "dev"], {
  cwd: ROOT,
  stdio: "inherit",
  shell: true,
});

wrangler.on("error", (err) => {
  console.error("❌ wrangler dev 启动失败:", err.message);
});

// ── Start bridge ────────────────────────────────────────────────────────

const bridge = spawn("node", ["bridge/index.js"], {
  cwd: ROOT,
  stdio: "inherit",
  shell: true,
});

bridge.on("error", (err) => {
  console.error("❌ bridge 启动失败:", err.message);
});

// ── Graceful shutdown ───────────────────────────────────────────────────

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n🛑 正在关闭所有服务...");

  // Kill wrangler (it spawns children, so use taskkill on Windows)
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(wrangler.pid), "/T", "/F"], { shell: true });
    spawn("taskkill", ["/pid", String(bridge.pid), "/T", "/F"], { shell: true });
  } else {
    wrangler.kill("SIGINT");
    bridge.kill("SIGINT");
  }

  // Give them a moment, then force exit
  setTimeout(() => {
    console.log("👋 已关闭");
    process.exit(0);
  }, 2000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
