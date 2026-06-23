#!/usr/bin/env node
/**
 * Claude → WeChat Bridge (megz integrated)
 * ==========================================
 * Directly connects Claude AI to WeChat via the iLink ClawBot protocol.
 * Built into the megz daily-work-tracking project.
 *
 * Usage (from megz/ root):
 *   node bridge/index.js               # Login + start bridge + HTTP API
 *   node bridge/index.js --login-only  # Login only (save credentials)
 *
 * HTTP API runs on port 3080 (configurable via BRIDGE_PORT env var).
 * The megz frontend calls these endpoints to import WeChat conversations
 * into the learning management system.
 *
 * Limits imposed by WeChat (server-side, cannot bypass):
 *   - Only direct/private chat (no groups)
 *   - 24-hour active window after user's last message
 *   - ~10 reply quota per user message within the window
 */

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ilink from "./lib/ilink.js";
import * as claude from "./lib/claude.js";
import * as media from "./lib/media.js";
import { createHttpServer } from "./lib/http-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

// Load .env from bridge/ directory regardless of CWD
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
}

// ── Config ─────────────────────────────────────────────────────────────────

// Persistence is handled via Worker KV — no local files needed for cloud deployment

const BRIDGE_PORT = parseInt(process.env.PORT || process.env.BRIDGE_PORT) || 3080;

// Long-poll settings
const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

// Session expiry (WeChat may return errcode to pause)
const SESSION_EXPIRED_ERRCODE = -1001;

// ── Persistence (via Worker KV) ────────────────────────────────────────────

const WORKER_URL = process.env.WORKER_URL || "http://localhost:8787";

async function saveAccountToWorker(data) {
  try {
    const res = await fetch(`${WORKER_URL}/api/bridge/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: data }),
    });
    if (res.ok) {
      console.log("💾 账号信息已同步到 Worker KV");
    }
  } catch (err) {
    console.warn("⚠️  保存账号到 Worker 失败:", err.message);
  }
}

async function loadAccountFromWorker() {
  try {
    const res = await fetch(`${WORKER_URL}/api/bridge/config`);
    if (res.ok) {
      const data = await res.json();
      if (data.account && data.account.botToken && data.account.baseUrl) {
        return data.account;
      }
    }
  } catch (err) {
    console.warn("⚠️  从 Worker 读取账号失败:", err.message);
  }
  return null;
}

async function saveSyncBufToWorker(buf) {
  try {
    await fetch(`${WORKER_URL}/api/bridge/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ syncBuf: buf }),
    });
  } catch (err) {
    // Non-critical
  }
}

async function loadSyncBufFromWorker() {
  try {
    const res = await fetch(`${WORKER_URL}/api/bridge/config`);
    if (res.ok) {
      const data = await res.json();
      return data.syncBuf || "";
    }
  } catch (err) {
    // Non-critical
  }
  return "";
}

// ── Message Processor ──────────────────────────────────────────────────────

async function processMessage(msg, account) {
  const fromUserId = msg.from_user_id;
  const contextToken = msg.context_token;
  const text = ilink.extractMessageText(msg);

  console.log(`\n📩 收到消息 from=${fromUserId}: "${text.slice(0, 100)}"`);

  if (!text && !ilink.hasMedia(msg)) {
    console.log("  ⏭️  空消息，跳过");
    return;
  }

  try {
    // Send "typing..." indicator
    await ilink.sendTyping({
      baseUrl: account.baseUrl,
      token: account.botToken,
      toUserId: fromUserId,
      contextToken,
    });

    // Keep typing indicator alive with a periodic refresh
    const typingInterval = setInterval(() => {
      ilink.sendTyping({
        baseUrl: account.baseUrl,
        token: account.botToken,
        toUserId: fromUserId,
        contextToken,
      }).catch(() => {});
    }, 5000);

    let response;

    if (text) {
      // Text message → Claude
      response = await claude.chat({
        userId: fromUserId,
        message: text,
        onToken: (token) => {
          // Silent streaming — could be used for progress
          process.stdout.write(token);
        },
      });
    } else {
      response = "📎 收到了媒体消息（图片/文件/语音暂不支持自动处理，请用文字描述）";
    }

    clearInterval(typingInterval);

    // Send response back to WeChat
    if (response) {
      // Split long messages if needed (WeChat has practical limits)
      const chunks = splitLongMessage(response, 2000);
      for (const chunk of chunks) {
        await ilink.sendTextMessage({
          baseUrl: account.baseUrl,
          token: account.botToken,
          toUserId: fromUserId,
          text: chunk,
          contextToken,
        });
      }
      console.log(`  ✅ 已回复 (${chunks.length} 条消息)`);
    }
  } catch (err) {
    console.error(`  ❌ 处理消息失败:`, err.message);

    // Try to send error message to user
    try {
      await ilink.sendTextMessage({
        baseUrl: account.baseUrl,
        token: account.botToken,
        toUserId: fromUserId,
        text: `抱歉，处理你的消息时出错了：${err.message.slice(0, 100)}`,
        contextToken,
      });
    } catch {
      // Can't even send error — give up
    }
  }
}

/**
 * Split a long message into chunks that fit WeChat's display limits.
 */
function splitLongMessage(text, maxLen = 2000) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a natural boundary
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt === -1 || splitAt < maxLen / 2) {
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt === -1 || splitAt < maxLen / 2) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trim();
  }

  return chunks;
}

// ── Shared State ────────────────────────────────────────────────────────────

let bridgeRunning = false;
let bridgeStartTime = 0;
let currentAccount = null;       // { botToken, baseUrl, accountId, userId, savedAt }
let longPollAbortController = null;
let httpServer = null;

// Login state (for frontend-triggered QR login)
export const loginState = {
  qrcode: null,         // current qrcode string
  qrcodeUrl: null,      // QR image URL
  status: "idle",       // "idle" | "waiting" | "scanned" | "confirmed" | "expired" | "error"
  message: "",
  account: null,        // set on confirmed
  refreshCount: 0,
};

// ── Main Bridge Loop ───────────────────────────────────────────────────────

async function runBridge(account) {
  currentAccount = account;
  bridgeRunning = true;
  bridgeStartTime = Date.now();

  console.log("\n🤖 Claude → WeChat 桥接启动");
  console.log(`   Base URL: ${account.baseUrl}`);
  console.log(`   Account: ${account.accountId}`);
  console.log(`   Model: ${process.env.CLAUDE_MODEL || "claude-sonnet-4-6"}`);
  console.log(`   Persistence: Worker KV\n`);

  // ── Notify the server we're starting ──────────────────────────────────

  await ilink.notifyStart({
    baseUrl: account.baseUrl,
    token: account.botToken,
  });

  // Restore the long-poll cursor
  let getUpdatesBuf = await loadSyncBufFromWorker();
  if (getUpdatesBuf) {
    console.log(`📋 从上次位置恢复 (${getUpdatesBuf.length} bytes)`);
  }

  let consecutiveFailures = 0;
  let sessionPausedUntil = 0;
  longPollAbortController = new AbortController();

  // ── Long-poll loop ───────────────────────────────────────────────────

  console.log("👂 开始监听消息...\n");

  while (!longPollAbortController.signal.aborted) {
    try {
      // Check if session is paused
      if (Date.now() < sessionPausedUntil) {
        const waitMs = sessionPausedUntil - Date.now();
        console.log(`⏸️  会话暂停中，等待 ${Math.ceil(waitMs / 1000)}s...`);
        await sleep(Math.min(waitMs, 60_000), longPollAbortController.signal);
        continue;
      }

      // Long-poll for new messages
      const resp = await ilink.getUpdates({
        baseUrl: account.baseUrl,
        token: account.botToken,
        getUpdatesBuf,
        abortSignal: longPollAbortController.signal,
      });

      // Check for API errors
      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        if (resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE) {
          const pauseMs = 15 * 60_000;
          sessionPausedUntil = Date.now() + pauseMs;
          console.error(`⛔ 会话过期 (errcode=${resp.errcode}), 暂停 ${Math.ceil(pauseMs / 60000)} 分钟`);
          consecutiveFailures = 0;
          continue;
        }

        consecutiveFailures++;
        console.error(`⚠️  getUpdates 错误: ret=${resp.ret} errcode=${resp.errcode} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);

        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`🛑 ${MAX_CONSECUTIVE_FAILURES} 次连续失败，退避 ${BACKOFF_DELAY_MS / 1000}s`);
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, longPollAbortController.signal);
        } else {
          await sleep(RETRY_DELAY_MS, longPollAbortController.signal);
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf) {
        getUpdatesBuf = resp.get_updates_buf;
        saveSyncBufToWorker(getUpdatesBuf);
      }

      const msgs = resp.msgs ?? [];
      if (msgs.length > 0) {
        console.log(`📬 收到 ${msgs.length} 条消息`);
        for (const msg of msgs) {
          await processMessage(msg, account);
        }
      }
    } catch (err) {
      if (longPollAbortController.signal.aborted) break;
      if (err.name === "AbortError") continue;

      consecutiveFailures++;
      console.error(`❌ getUpdates 异常 (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, err.message);

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`🛑 ${MAX_CONSECUTIVE_FAILURES} 次连续异常，退避 ${BACKOFF_DELAY_MS / 1000}s`);
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, longPollAbortController.signal);
      } else {
        await sleep(RETRY_DELAY_MS, longPollAbortController.signal);
      }
    }
  }
}

// ── Background QR Login ────────────────────────────────────────────────────

async function startBackgroundLogin(qrcode) {
  loginState.qrcode = qrcode;
  loginState.status = "waiting";
  loginState.message = "等待扫码...";
  loginState.refreshCount = 0;

  console.log("📱 后台登录轮询已启动");

  try {
    const result = await ilink.pollQRStatus(qrcode, {
      timeoutMs: 480_000,
      verbose: false,
      onRefresh: (newQr) => {
        loginState.qrcode = newQr.qrcode;
        loginState.qrcodeUrl = newQr.qrcodeUrl;
        loginState.refreshCount++;
        loginState.status = "waiting";
        loginState.message = `二维码已刷新 (${loginState.refreshCount}次)`;
        console.log(`🔄 QR 已刷新 (${loginState.refreshCount}次)`);
      },
    });

    if (result.connected) {
      loginState.status = "confirmed";
      loginState.message = "登录成功！";
      loginState.account = {
        botToken: result.botToken,
        baseUrl: result.baseUrl,
        accountId: result.accountId,
        userId: result.userId,
        savedAt: new Date().toISOString(),
      };

      // Save account
      saveAccountToWorker(loginState.account);
      console.log(`\n✅ 后台登录成功！Account: ${loginState.account.accountId}`);

      // Auto-start the bridge
      await runBridge(loginState.account);
    } else {
      loginState.status = "error";
      loginState.message = result.message || "登录失败";
      console.error(`\n❌ 后台登录失败: ${loginState.message}`);
    }
  } catch (err) {
    loginState.status = "error";
    loginState.message = err.message;
    console.error(`\n❌ 后台登录异常: ${err.message}`);
  }
}

// ── doLogin (CLI mode — still works, but no process.exit) ──────────────────

async function doLogin() {
  console.log("🔑 正在获取登录二维码...\n");

  const qrResult = await ilink.getQRCode();
  if (!qrResult.qrcodeUrl) {
    throw new Error("获取二维码失败");
  }

  try {
    const qrterm = (await import("qrcode-terminal")).default;
    qrterm.generate(qrResult.qrcodeUrl, { small: true });
  } catch {}

  console.log(`\n📱 请用微信扫描上方二维码`);
  console.log(`   或访问: ${qrResult.qrcodeUrl}\n`);
  console.log("⏳ 等待扫码确认...\n");

  // Also update loginState for frontend access
  loginState.qrcode = qrResult.qrcode;
  loginState.qrcodeUrl = qrResult.qrcodeUrl;
  loginState.status = "waiting";
  loginState.message = "等待扫码...";

  const result = await ilink.pollQRStatus(qrResult.qrcode);

  if (result.connected) {
    loginState.status = "confirmed";
    loginState.message = "登录成功！";
    const account = {
      botToken: result.botToken,
      baseUrl: result.baseUrl,
      accountId: result.accountId,
      userId: result.userId,
      savedAt: new Date().toISOString(),
    };
    saveAccountToWorker(account);
    loginState.account = account;
    console.log(`\n✅ 已连接到微信！`);
    console.log(`   Bot ID: ${result.accountId}`);
    console.log(`   User ID: ${result.userId}`);
    return account;
  } else {
    loginState.status = "error";
    loginState.message = result.message;
    throw new Error(result.message);
  }
}

// ── Graceful Shutdown ──────────────────────────────────────────────────────

function setupShutdown() {
  const shutdown = async () => {
    console.log("\n🛑 正在关闭...");
    bridgeRunning = false;

    if (longPollAbortController) {
      longPollAbortController.abort();
    }

    if (httpServer) {
      httpServer.close(() => {
        console.log("  🌐 HTTP API 已关闭");
      });
    }

    if (currentAccount) {
      await ilink.notifyStop({
        baseUrl: currentAccount.baseUrl,
        token: currentAccount.botToken,
      }).catch(() => {});
    }

    console.log("👋 已断开连接");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// ── Utilities ──────────────────────────────────────────────────────────────

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      }, { once: true });
    }
  });
}

// ── Entry Point ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const loginOnly = args.includes("--login-only");

  console.log("🤖 Claude → WeChat Bridge v1.0.0 (megz integrated)\n");

  // ── Start HTTP API server FIRST (before login) ─────────────────────────

  httpServer = createHttpServer({
    conversations: claude.conversations,
    getAccount: () => currentAccount,
    isRunning: () => bridgeRunning,
    getUptime: () => bridgeStartTime ? Math.floor((Date.now() - bridgeStartTime) / 1000) : 0,
    loginState,
    startLogin: (qrcode) => startBackgroundLogin(qrcode),
  });

  httpServer.listen(BRIDGE_PORT, () => {
    console.log(`🌐 HTTP API 已启动: http://localhost:${BRIDGE_PORT}`);
    console.log(`   GET  /api/bridge/status        — 桥接状态`);
    console.log(`   POST /api/bridge/login/start   — 扫码登录`);
    console.log(`   GET  /api/bridge/login/status  — 登录状态`);
    console.log(`   GET  /api/bridge/conversations  — 对话列表`);
    console.log(`   POST /api/bridge/learning/save  — 提炼学习卡片\n`);
  });

  setupShutdown();

  // ── Try to load existing account ────────────────────────────────────────

  let account = loadAccountFromWorker();

  if (!account || args.includes("--relogin")) {
    console.log("🆕 需要登录微信 ClawBot");
    console.log("   终端模式: 即将弹出二维码...");
    console.log(`   前端模式: 访问 http://localhost:${BRIDGE_PORT}/api/bridge/login/start\n`);

    if (loginOnly) {
      // CLI login mode
      account = await doLogin();
      if (account) {
        console.log("✅ 登录完成！凭据已保存，可启动桥接: node bridge/index.js");
        process.exit(0);
      } else {
        console.error("❌ 登录失败");
        process.exit(1);
      }
    } else {
      // Non-login-only without account: keep HTTP server running, wait for frontend login
      console.log("💡 HTTP 服务已启动，等待前端触发扫码登录...");
      console.log("   也可以在终端重新运行: node bridge/index.js --login-only\n");
      // Keep process alive (HTTP server is running)
      // The long-poll loop will start after frontend triggers login
    }
  } else {
    console.log(`✅ 使用已保存的账号: ${account.accountId}`);
    console.log(`   保存时间: ${account.savedAt}\n`);

    if (loginOnly) {
      console.log("✅ 已登录！运行 `node bridge/index.js` 启动桥接");
      process.exit(0);
    }

    // Auto-start bridge with existing account
    await runBridge(account);
  }
}

main().catch((err) => {
  console.error("💥 Fatal error:", err);
  process.exit(1);
});
