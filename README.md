# 每日工作 (Daily Work)

一个跑在 Cloudflare Workers 上的工作记录 SPA，纯 KV 存储，零数据库依赖。

## 功能

- 每日微信/意向/回访计数、客户登记、待办清单
- 意向客户全量表、周/月统计、紧凑日历
- PIN 锁屏、深色模式、动态壁纸
- AI 智能问答（知识库、客户搜索、白名单核对）
- 企业微信 Webhook 同步

## 部署

### 前提

1. 一个 [Cloudflare](https://cloudflare.com) 账号
2. 安装 [Node.js](https://nodejs.org)（本地开发用）

### 1. Fork 仓库

点击右上角 Fork，克隆到你自己的 GitHub。

### 2. 创建 KV Namespace

进入 Cloudflare Dashboard → Workers & Pages → KV → 创建命名空间：

```
名称: DATA_KV
```

创建后会得到一个 `id`，记下来。

### 3. 配置 wrangler.toml

把 KV namespace 的 `id` 填入 `wrangler.toml`：

```toml
[[kv_namespaces]]
binding = "DATA_KV"
id = "你的KV_ID"
```

删除 `[ai]` 和 `[triggers]` 段（免费用户不需要）。

### 4. 设置 GitHub Actions Secrets

在仓库 Settings → Secrets and variables → Actions → New repository secret：

| Secret | 说明 |
|--------|------|
| `CF_API_TOKEN` | Cloudflare API Token（在 Cloudflare Dashboard → My Profile → API Tokens 创建，选 "Edit Cloudflare Workers" 模板） |
| `CF_ACCOUNT_ID` | Cloudflare Account ID（Dashboard 首页右侧或 Workers 页面 URL 里） |

### 5. 推送部署

修改完 `wrangler.toml` 后 commit + push，GitHub Actions 自动部署到 Cloudflare Workers。

部署成功后访问 `https://你的worker名.你的用户名.workers.dev`。

### 6. 自定义域名（可选）

在 Cloudflare Dashboard → Workers & Pages → 你的 Worker → Triggers → Custom Domains 绑定自己的域名。

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars   # AI 功能需要的话填 API Key
npx wrangler dev
```

## 环境变量

| 变量 | 说明 | 必填 |
|------|------|------|
| `AI_API_KEY` | AI 大模型 API Key（Gemini/DeepSeek 兼容） | 否，没配 AI 功能不工作 |
| `AI_API_BASE` | AI API 地址，默认 Gemini | 否 |
| `AI_API_MODEL` | 模型名，默认 gemini-2.5-flash | 否 |
| `WECOM_WEBHOOK_URL` | 企业微信 Webhook 地址 | 否 |

## 项目结构

```
src/
  index.js        Worker 入口 + 主页面 SPA
  supabase.js     KV 数据读写封装
  anti-bot.js     反爬虫/限流
  wecom_crypt.js  企业微信消息加密
```

## 相关项目

- [bhp](https://github.com/Hqsxjj/bhp) — 智能快捷拨号助手（子账户系统 + Supabase 客户管理）

## License

MIT
