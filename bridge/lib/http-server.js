/**
 * Local HTTP API server for the WeChat bridge.
 *
 * Exposes endpoints so the megz frontend (running in browser) can:
 *  - Check bridge connection status
 *  - Trigger QR code login and poll login status
 *  - List recent WeChat conversations
 *  - Fetch conversation history
 *  - Convert a conversation into a learning card
 *
 * Uses Node.js built-in `http` module — zero extra dependencies.
 */

import http from "node:http";

/**
 * Create and return an HTTP server (does NOT start listening).
 *
 * @param {object} deps
 * @param {Map<string, Array<{role: string, content: string}>>} deps.conversations - from claude.js
 * @param {() => object|null} deps.getAccount - returns current account or null if not logged in
 * @param {() => boolean} deps.isRunning - whether the bridge long-poll loop is active
 * @param {() => number} deps.getUptime - seconds since bridge started
 * @param {object} deps.loginState - reactive login state object { qrcode, qrcodeUrl, status, message, refreshCount }
 * @param {(qrcode: string) => Promise<void>} deps.startLogin - trigger background QR polling
 */
export function createHttpServer({
  conversations,
  getAccount,
  isRunning,
  getUptime,
  loginState,
  startLogin,
}) {
  const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  function json(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      ...CORS_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          resolve({ _raw: body });
        }
      });
      req.on("error", reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "") || "/"; // normalize trailing slash

    // GET /api/bridge/status
    if (req.method === "GET" && path === "/api/bridge/status") {
      const account = getAccount ? getAccount() : null;
      const convCount = conversations ? conversations.size : 0;
      const connected = !!(account && account.botToken);
      const ls = loginState || {};

      return json(res, 200, {
        running: isRunning ? isRunning() : false,
        connected,
        loginRequired: !connected && !ls.qrcode,
        loginState: ls.status || "idle",
        loginMessage: ls.message || "",
        qrcodeUrl: ls.qrcodeUrl || null,
        uptime: getUptime ? getUptime() : 0,
        accountId: account?.accountId || null,
        userId: account?.userId || null,
        conversationCount: convCount,
      });
    }

    // POST /api/bridge/login/start — trigger QR code generation
    if (req.method === "POST" && path === "/api/bridge/login/start") {
      try {
        // Check if already connected
        const account = getAccount ? getAccount() : null;
        if (account && account.botToken) {
          return json(res, 200, {
            success: true,
            alreadyConnected: true,
            message: "已登录，无需重新扫码",
          });
        }

        // Check if login already in progress
        if (loginState && loginState.qrcode && loginState.status === "waiting") {
          return json(res, 200, {
            success: true,
            qrcode: loginState.qrcode,
            qrcodeUrl: loginState.qrcodeUrl,
            status: loginState.status,
            message: "已有进行中的二维码，请直接扫描",
          });
        }

        // Import ilink dynamically to avoid issues
        const ilink = await import("./ilink.js");
        const qrResult = await ilink.getQRCode();

        if (!qrResult.qrcodeUrl) {
          return json(res, 500, { error: "获取二维码失败" });
        }

        // Update login state
        if (loginState) {
          loginState.qrcode = qrResult.qrcode;
          loginState.qrcodeUrl = qrResult.qrcodeUrl;
          loginState.status = "waiting";
          loginState.message = "等待扫码...";
          loginState.refreshCount = 0;
        }

        // Start background polling (non-blocking)
        if (startLogin) {
          startLogin(qrResult.qrcode).catch((err) => {
            console.error("后台登录异常:", err.message);
          });
        }

        return json(res, 200, {
          success: true,
          qrcode: qrResult.qrcode,
          qrcodeUrl: qrResult.qrcodeUrl,
          status: "waiting",
          message: "请用微信扫描二维码",
        });
      } catch (err) {
        console.error("登录启动失败:", err.message);
        return json(res, 500, { error: `启动登录失败: ${err.message}` });
      }
    }

    // GET /api/bridge/login/status — poll current login progress
    if (req.method === "GET" && path === "/api/bridge/login/status") {
      const ls = loginState || {};
      const account = getAccount ? getAccount() : null;

      if (account && account.botToken && ls.status === "confirmed") {
        // Successfully connected
        return json(res, 200, {
          status: "confirmed",
          message: "登录成功",
          accountId: account.accountId,
          userId: account.userId,
        });
      }

      return json(res, 200, {
        status: ls.status || "idle",
        message: ls.message || "",
        qrcodeUrl: ls.qrcodeUrl || null,
        refreshCount: ls.refreshCount || 0,
      });
    }

    // GET /api/bridge/conversations
    if (req.method === "GET" && path === "/api/bridge/conversations") {
      if (!conversations || conversations.size === 0) {
        return json(res, 200, { conversations: [] });
      }

      const list = [];
      for (const [userId, msgs] of conversations.entries()) {
        const lastUserMsg = [...msgs].reverse().find((m) => m.role === "user");
        list.push({
          userId,
          lastMessage: lastUserMsg ? lastUserMsg.content.slice(0, 100) : "",
          messageCount: msgs.length,
        });
      }
      list.sort((a, b) => b.messageCount - a.messageCount);
      return json(res, 200, { conversations: list });
    }

    // GET /api/bridge/conversations/:userId
    const convMatch = path.match(/^\/api\/bridge\/conversations\/(.+)$/);
    if (req.method === "GET" && convMatch) {
      const userId = decodeURIComponent(convMatch[1]);
      if (!conversations || !conversations.has(userId)) {
        return json(res, 404, { error: "用户对话不存在" });
      }
      const msgs = conversations.get(userId);
      return json(res, 200, {
        userId,
        messages: msgs.map((m, i) => ({
          index: i,
          role: m.role,
          content: m.content,
        })),
        messageCount: msgs.length,
      });
    }

    // POST /api/bridge/learning/save
    if (req.method === "POST" && path === "/api/bridge/learning/save") {
      const body = await readBody(req);
      const userId = body.userId;

      if (!userId) {
        return json(res, 400, { error: "缺少 userId 参数" });
      }

      if (!conversations || !conversations.has(userId)) {
        return json(res, 404, { error: "未找到该用户的对话记录" });
      }

      const allMsgs = conversations.get(userId);
      const messageCount = Math.min(body.messageCount || 20, allMsgs.length);
      const msgs = allMsgs.slice(-messageCount);

      const conversationText = msgs
        .map((m) => `${m.role === "user" ? "用户" : "AI"}: ${m.content}`)
        .join("\n\n");

      try {
        const claude = await import("./claude.js");
        const result = await claude.summarizeConversation(conversationText, {
          userId,
          messageCount,
        });
        return json(res, 200, { success: true, data: result });
      } catch (err) {
        console.error("  ❌ 提炼学习卡片失败:", err.message);
        return json(res, 500, { error: `AI 提炼失败: ${err.message}` });
      }
    }

    // 404
    return json(res, 404, { error: "Not found" });
  });

  return server;
}
