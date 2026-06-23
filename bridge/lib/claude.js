/**
 * LLM integration for WeChat bridge — thin HTTP proxy to Cloudflare Worker.
 *
 * All AI processing now happens on the Cloudflare Worker, which has access to:
 *  - KV (daily work data, config)
 *  - Supabase (customers, knowledge base, whitelist)
 *  - Cloudflare Workers AI (vision models)
 *  - External AI APIs (DeepSeek, Gemini)
 *
 * This module only maintains conversation history and forwards requests.
 *
 * Set WORKER_URL in bridge/.env (defaults to http://localhost:8787 for local dev).
 */

// ── Configuration ───────────────────────────────────────────────────────────

const WORKER_URL = process.env.WORKER_URL || "http://localhost:8787";
const DEFAULT_MAX_HISTORY = 20;

// ── Conversation Store ─────────────────────────────────────────────────────

/** @type {Map<string, Array<{role: string, content: string}>>} */
export const conversations = new Map();

function getConversation(userId) {
  if (!conversations.has(userId)) {
    conversations.set(userId, []);
  }
  return conversations.get(userId);
}

function trimHistory(messages, maxTurns) {
  const maxMessages = maxTurns * 2;
  if (messages.length > maxMessages) {
    return messages.slice(-maxMessages);
  }
  return messages;
}

// ── HTTP forward to Worker ──────────────────────────────────────────────────

/**
 * POST to Worker's /api/bridge/chat endpoint.
 */
async function forwardChat(userId, message, history) {
  const res = await fetch(`${WORKER_URL}/api/bridge/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, message, history }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Worker returned ${res.status}`);
  }

  const data = await res.json();
  return data.reply || "";
}

/**
 * POST to Worker's /api/bridge/learning/save endpoint.
 */
async function forwardLearningSave(conversationText) {
  const res = await fetch(`${WORKER_URL}/api/bridge/learning/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationText, source_type: "微信聊天" }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Worker returned ${res.status}`);
  }

  const data = await res.json();
  return data.data;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Send a message and get AI response (forwarded to Cloudflare Worker).
 */
export async function chat({ userId, message, opts = {} }) {
  const maxHistory = opts.maxHistory || DEFAULT_MAX_HISTORY;
  const conversation = getConversation(userId);

  // Add user message to history
  conversation.push({ role: "user", content: message });

  // Trim and send recent history to Worker for context
  const history = trimHistory([...conversation], maxHistory);
  // Remove the last (just-added) user message from history param — Worker adds it
  const historyForWorker = history.slice(0, -1);

  try {
    const response = await forwardChat(userId, message, historyForWorker);

    // Add response to history
    if (response) {
      conversation.push({ role: "assistant", content: response });
    }

    // Trim
    const finalTrimmed = trimHistory(conversation, maxHistory);
    conversations.set(userId, finalTrimmed);

    return response;
  } catch (err) {
    console.error(`  ❌ Worker chat error:`, err.message);
    // Remove the user message we just added to avoid polluting history
    conversation.pop();
    throw err;
  }
}

/**
 * Summarize a conversation into a learning card (forwarded to Cloudflare Worker).
 */
export async function summarizeConversation(conversationText, opts = {}) {
  console.log(`  📝 转发学习提炼到 Worker (${conversationText.length} chars)`);

  try {
    const result = await forwardLearningSave(conversationText);
    return result;
  } catch (err) {
    console.error(`  ⚠️  学习提炼失败，使用本地 mock: ${err.message}`);
    // Local fallback
    const preview = conversationText.slice(0, 100).replace(/\n/g, " ");
    return {
      title: "微信对话提炼",
      summary: preview.length > 50 ? preview.slice(0, 50) + "..." : preview,
      content: "（自动提炼失败，使用本地摘要）\n" + conversationText.slice(0, 500),
      tags: ["微信", "学习", "对话提炼"],
      source_type: "微信聊天",
    };
  }
}

// ── Utility Exports ────────────────────────────────────────────────────────

export function clearHistory(userId) {
  conversations.delete(userId);
}

export function getConversationCount() {
  return conversations.size;
}

export function getProvider() {
  return "cloudflare-worker";
}
