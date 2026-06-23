/**
 * iLink Bot API client — direct implementation of the WeChat ClawBot protocol.
 *
 * Protocol reverse-engineered from @tencent-weixin/openclaw-weixin v2.4.4 source.
 * No OpenClaw dependency. Pure HTTP/JSON + AES-128-ECB for media.
 *
 * API base: https://ilinkai.weixin.qq.com (auth)
 * API base: dynamic from confirmed QR response (operations)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ── Constants ──────────────────────────────────────────────────────────────

const ILINK_APP_ID = "bot";
const FIXED_AUTH_BASE = "https://ilinkai.weixin.qq.com";
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;
const BOT_TYPE = "3";

// Build client version from package.json version (uint32: 0x00MMNNPP)
const pkg = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8")
);
const [major = 0, minor = 0, patch = 0] = (pkg.version || "1.0.0")
  .split(".")
  .map((p) => parseInt(p, 10));
const ILINK_APP_CLIENT_VERSION =
  ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);

// ── Helpers ────────────────────────────────────────────────────────────────

function ensureTrailingSlash(url) {
  return url.endsWith("/") ? url : `${url}/`;
}

function randomWechatUin() {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildCommonHeaders() {
  return {
    "iLink-App-Id": ILINK_APP_ID,
    "iLink-App-ClientVersion": String(ILINK_APP_CLIENT_VERSION),
  };
}

function buildAuthHeaders(token) {
  return {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
    ...buildCommonHeaders(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// ── Low-level HTTP ─────────────────────────────────────────────────────────

async function apiPost({ baseUrl, endpoint, body, token, timeoutMs, label }) {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: buildAuthHeaders(token),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`${label} ${res.status}: ${rawText.slice(0, 500)}`);
    }
    return JSON.parse(rawText);
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      // Long-poll timeout is normal — return empty
      if (label === "getUpdates") return { ret: 0, msgs: [] };
      throw new Error(`${label}: request timeout after ${timeoutMs}ms`);
    }
    throw err;
  }
}

async function apiGet({ baseUrl, endpoint, timeoutMs, label }) {
  const url = new URL(endpoint, ensureTrailingSlash(baseUrl));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: buildCommonHeaders(),
      signal: controller.signal,
    });
    clearTimeout(timer);

    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`${label} ${res.status}: ${rawText.slice(0, 500)}`);
    }
    return JSON.parse(rawText);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ── Auth API ───────────────────────────────────────────────────────────────

/**
 * Step 1: Get a QR code for WeChat scanning.
 * Returns { qrcode, qrcode_img_content }
 */
export async function getQRCode() {
  const result = await apiPost({
    baseUrl: FIXED_AUTH_BASE,
    endpoint: `ilink/bot/get_bot_qrcode?bot_type=${BOT_TYPE}`,
    body: { local_token_list: [] },
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: "getQRCode",
  });
  return { qrcode: result.qrcode, qrcodeUrl: result.qrcode_img_content };
}

const MAX_QR_REFRESH = 3;

/**
 * Step 2: Poll QR code scan status until confirmed.
 * Auto-refreshes QR code on expiry (up to 3 times).
 * Returns { connected, botToken, accountId, baseUrl, userId } on success.
 */
export async function pollQRStatus(initialQrcode, { timeoutMs = 480_000, verbose = true, onRefresh } = {}) {
  const deadline = Date.now() + timeoutMs;
  let currentQrcode = initialQrcode;
  let scannedPrinted = false;
  let refreshCount = 1;

  while (Date.now() < deadline) {
    let result;
    try {
      result = await apiGet({
        baseUrl: FIXED_AUTH_BASE,
        endpoint: `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(currentQrcode)}`,
        timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
        label: "pollQRStatus",
      });
    } catch (err) {
      // Network error / gateway timeout — retry
      if (verbose) process.stdout.write("e");
      await sleep(2000);
      continue;
    }

    switch (result.status) {
      case "wait":
        if (verbose) process.stdout.write(".");
        break;
      case "scaned":
        if (!scannedPrinted) {
          console.log("\n📱 已扫描，正在确认...");
          scannedPrinted = true;
        }
        break;
      case "confirmed":
        console.log("\n✅ 登录成功！");
        return {
          connected: true,
          botToken: result.bot_token,
          accountId: result.ilink_bot_id,
          baseUrl: result.baseurl || FIXED_AUTH_BASE,
          userId: result.ilink_user_id,
        };
      case "expired": {
        refreshCount++;
        if (refreshCount > MAX_QR_REFRESH) {
          return { connected: false, message: `二维码已过期 ${MAX_QR_REFRESH} 次，请重新运行` };
        }
        console.log(`\n⏳ 二维码已过期，正在刷新 (${refreshCount-1}/${MAX_QR_REFRESH})...`);
        try {
          const newQr = await getQRCode();
          currentQrcode = newQr.qrcode;
          scannedPrinted = false;
          console.log(`🔄 新二维码已生成，请重新扫描`);
          console.log(`   或访问: ${newQr.qrcodeUrl}\n`);
          if (onRefresh) onRefresh(newQr);
          // Re-display QR in terminal
          try {
            const qrterm = (await import("qrcode-terminal")).default;
            qrterm.generate(newQr.qrcodeUrl, { small: true });
          } catch {}
        } catch (refreshErr) {
          console.error(`❌ 刷新二维码失败: ${refreshErr.message}`);
        }
        break;
      }
      case "binded_redirect":
        return { connected: false, alreadyConnected: true, message: "已连接过此 OpenClaw，无需重复连接" };
      case "need_verifycode":
        console.log("\n🔢 需要输入手机微信上显示的数字验证码...");
        // For automated flow, skip verify code — user should re-try without it
        return { connected: false, message: "需要验证码，请在手机上确认后重试" };
      case "scaned_but_redirect":
        // IDC redirect — continue with same qrcode
        if (verbose) process.stdout.write("R");
        break;
      default:
        if (verbose) console.log(`\n状态: ${result.status}`);
    }

    await sleep(1000);
  }

  return { connected: false, message: "登录超时" };
}

// ── Message API ────────────────────────────────────────────────────────────

/**
 * Long-poll for new messages. Returns { ret, msgs[], get_updates_buf }.
 * Call repeatedly with the returned get_updates_buf as cursor.
 */
export async function getUpdates({ baseUrl, token, getUpdatesBuf = "", abortSignal }) {
  try {
    const result = await apiPost({
      baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: {
        get_updates_buf: getUpdatesBuf,
        base_info: { channel_version: pkg.version, bot_agent: "ClaudeWeChatBridge" },
      },
      token,
      timeoutMs: DEFAULT_LONG_POLL_TIMEOUT_MS,
      label: "getUpdates",
    });

    // Check for errors
    if (result.ret !== undefined && result.ret !== 0) {
      throw new Error(`getUpdates error: ret=${result.ret} errcode=${result.errcode} errmsg=${result.errmsg ?? ""}`);
    }

    return result;
  } catch (err) {
    if (err.name === "AbortError" || err.message?.includes("timeout")) {
      return { ret: 0, msgs: [], get_updates_buf: getUpdatesBuf };
    }
    throw err;
  }
}

/**
 * Send a text message to a WeChat user.
 */
export async function sendTextMessage({ baseUrl, token, toUserId, text, contextToken }) {
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      message_type: 2, // BOT
      message_state: 2, // FINISH
      item_list: text ? [{ type: 1, text_item: { text } }] : [],
      context_token: contextToken ?? undefined,
    },
    base_info: { channel_version: pkg.version, bot_agent: "ClaudeWeChatBridge" },
  };

  await apiPost({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body,
    token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: "sendMessage",
  });
}

/**
 * Send an image message (already uploaded to CDN).
 */
export async function sendImageMessage({ baseUrl, token, toUserId, uploaded, contextToken }) {
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: toUserId,
      client_id: `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      message_type: 2,
      message_state: 2,
      item_list: [
        {
          type: 2, // IMAGE
          image_item: {
            media: {
              encrypt_query_param: uploaded.downloadParam,
              aes_key: Buffer.from(uploaded.aeskey).toString("base64"),
              encrypt_type: 1,
            },
            mid_size: uploaded.ciphertextSize,
          },
        },
      ],
      context_token: contextToken ?? undefined,
    },
    base_info: { channel_version: pkg.version, bot_agent: "ClaudeWeChatBridge" },
  };

  await apiPost({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body,
    token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: "sendImage",
  });
}

/**
 * Send typing indicator.
 */
export async function sendTyping({ baseUrl, token, toUserId, contextToken }) {
  await apiPost({
    baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: {
      ilink_user_id: toUserId,
      typing_status: 1, // TYPING
      base_info: { channel_version: pkg.version, bot_agent: "ClaudeWeChatBridge" },
    },
    token,
    timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
    label: "sendTyping",
  });
}

// ── CDN Upload API ─────────────────────────────────────────────────────────

/**
 * Get a pre-signed CDN upload URL.
 */
export async function getUploadUrl({ baseUrl, token, toUserId, filekey, mediaType, rawSize, rawMd5, fileSize, thumbRawSize, thumbMd5, thumbFileSize, aeskey }) {
  const result = await apiPost({
    baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: {
      filekey,
      media_type: mediaType,
      to_user_id: toUserId,
      rawsize: rawSize,
      rawfilemd5: rawMd5,
      filesize: fileSize,
      thumb_rawsize: thumbRawSize,
      thumb_rawfilemd5: thumbMd5,
      thumb_filesize: thumbFileSize,
      no_need_thumb: 1,
      aeskey: aeskey.toString("base64"),
      base_info: { channel_version: pkg.version, bot_agent: "ClaudeWeChatBridge" },
    },
    token,
    timeoutMs: DEFAULT_API_TIMEOUT_MS,
    label: "getUploadUrl",
  });
  return result;
}

// ── Lifecycle API ──────────────────────────────────────────────────────────

export async function notifyStart({ baseUrl, token }) {
  try {
    await apiPost({
      baseUrl,
      endpoint: "ilink/bot/msg/notifystart",
      body: { base_info: { channel_version: pkg.version, bot_agent: "ClaudeWeChatBridge" } },
      token,
      timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
      label: "notifyStart",
    });
  } catch (err) {
    console.warn("⚠️  notifyStart failed (non-fatal):", err.message);
  }
}

export async function notifyStop({ baseUrl, token }) {
  try {
    await apiPost({
      baseUrl,
      endpoint: "ilink/bot/msg/notifystop",
      body: { base_info: { channel_version: pkg.version, bot_agent: "ClaudeWeChatBridge" } },
      token,
      timeoutMs: DEFAULT_CONFIG_TIMEOUT_MS,
      label: "notifyStop",
    });
  } catch (err) {
    console.warn("⚠️  notifyStop failed (non-fatal):", err.message);
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract text body from a WeChat message's item_list.
 */
export function extractMessageText(msg) {
  if (!msg.item_list?.length) return "";

  for (const item of msg.item_list) {
    if (item.type === 1 && item.text_item?.text) {
      return String(item.text_item.text);
    }
    // Voice with transcription
    if (item.type === 3 && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

/**
 * Check if message contains media (image/video/file/voice).
 */
export function hasMedia(msg) {
  return msg.item_list?.some((item) => [2, 4, 5, 3].includes(item.type)) ?? false;
}
