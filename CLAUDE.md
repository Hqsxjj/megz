# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

"每日工作" (Daily Work) — a Cloudflare Worker that serves a single-page app for tracking daily work metrics: WeChat counts, intent counts, client registrations, and todo lists. The entire application (HTML, CSS, JS, and API routes) lives in one file: `src/index.js`.

## 🍎 iOS 27 Design System — 永久开发标准

**所有 UI 开发必须遵循 iOS 设计规范。** 完整细则见 `[[ios-design-standards]]` 记忆文件。

核心要点速查：
- **圆角**: 卡片 16px, 按钮/输入框 10px, 胶囊 999px
- **边框**: 全局 0.5px hairline，禁用粗边框和 dashed 分隔线
- **配色**: text `#1c1c1e` / `#3a3a3c` / `#5c5c60`（iOS 语义色），禁止纯黑纯白
- **字体**: SF Pro 优先，字重 400/500/600/700 四级，禁用 Light/ExtraBold
- **全局**: `letter-spacing: -0.01em`, `-webkit-font-smoothing: antialiased`
- **触摸**: 独立按钮 ≥44px, 内联按钮 ≥32px
- **图标**: SF Symbols 风格 SVG, 1.25px 圆头描边, currentColor
- **阴影**: 用 `--shadow-card` 变量，不要硬编码

## ⛔ 全局规则：禁止添加图标 / emoji

**无论任何时候、任何修改，严禁在 UI 中新增装饰性 emoji 或图标。** 包括但不限于：

- 按钮标签（💾📋🔍🤖🎙️📥🚀⚡➕✏️📤🎉🏷️🔮📱📊📈🤝👋🌱🔥等）
- 搜索框 placeholder
- Section / 配置面板标题
- 提示文字、说明文字
- 卡片标签、徽章

**例外（功能性的，允许保留）：**
- `✕` — 关闭/删除按钮的标准符号
- `⚠️` — 警告标识
- `✅❌` — 状态检测/诊断结果
- `⏳` — 加载进度指示
- `🔌` — 连接状态指示

## ⛔ 模板字符串中的转义规则（关键！多次踩坑）

**所有客户端 JS 代码都在一个模板字符串（backtick `` ` ``）里（`const HTML = \`...\`` 第 3126 行起）。模板字符串会处理转义序列：**

- `\n` → 真正的换行符 → JS 字符串中出现未转义换行 → **`Uncaught SyntaxError: Invalid or unexpected token`**
- `\\n` → 模板处理后变成 `\n` → JS 解析器看到的是合法的换行转义 ✓
- `\t` → 真正的 tab 符（同理，需要用 `\\t`）
- **正则字面量同理**：`\d` `\s` `\[` `\]` `\(` 等单反斜杠会被模板吃掉 → 正则源码损坏 → **`Uncaught SyntaxError: Invalid regular expression: ...: Range out of order in character class`**（2026-08-04 实测踩坑）。正则里的每个反斜杠都要双写：`/^\\[\\s*(\\d{4}...$/`

**规则：在模板字符串内编写客户端 JS 时，所有字符串字面量中的 `\n`、`\t` 等都要双写反斜杠：`'\\n'`、`'\\t'`；正则里的 `\d` `\s` `\[` `\]` 等同样双写。**

`node --check` 无法发现此问题，因为模板字符串在运行时才求值。

## Commands

- **Deploy**: `npx wrangler deploy`
- **Preview locally**: `npx wrangler dev`

No build step, no package.json, no tests.

## Architecture

**Storage**: Cloudflare Workers KV (`DATA_KV` namespace, binding defined in `wrangler.toml`). All persistence goes through KV — keys are prefixed with `work:YYYY-MM-DD`. The frontend also mirrors data in `localStorage` and auto-syncs from KV on first load, then pushes local changes to KV every 5 seconds.

**Routing**: The Worker checks `request.url` pathname. Four API routes (`/api/data`, `/api/calendar`, `/api/stats`) handle JSON CRUD; any other request receives the full HTML page. All API responses include CORS `Access-Control-Allow-Origin: *`.

**Frontend**: Inline SPA with no frameworks. Features PIN-lock privacy screen (default PIN `8520`), +/- counters with gradient cards, weekly/monthly stats, compact calendar, client registration with edit/delete, today/tomorrow todo lists with daily auto-rollover, dark mode toggle, and dynamic wallpaper from picsum.photos with daily cache. Keyboard shortcuts: `+`/`-` to increment/decrement WeChat count, `Ctrl+Z` to lock the page.

**Deployment**: GitHub Actions triggers `wrangler deploy` on push to `main` (requires `CF_API_TOKEN` and `CF_ACCOUNT_ID` secrets).

## WeChat Bridge (bridge/)

The `bridge/` directory contains a local Node.js service that connects Claude AI to WeChat via the iLink ClawBot protocol. It is integrated with the learning management feature: WeChat conversations can be imported as learning cards.

- **Start everything**: `npm start` — runs both `wrangler dev` and the bridge
- **Bridge only**: `npm run bridge`
- **Login only**: `npm run bridge:login`
- **HTTP API**: `http://localhost:3080` (status, conversations, learning extraction)

The bridge must run locally (persistent long-poll, file I/O). It cannot run on Cloudflare Workers.

**Setup**: `cd bridge && npm install` first. Copy `bridge/.env.example` to `bridge/.env` and configure API keys.
