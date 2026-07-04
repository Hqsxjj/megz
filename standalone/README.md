# megz 独立版 — 每日工作主界面

不含硬编码解锁密码的独立部署版本。PIN 码通过 Cloudflare KV 动态配置，每次部署可设不同密码。

---

## 部署教程（5 分钟）

### 前提条件
- 安装了 [Node.js](https://nodejs.org/)（v18 或更高）
- 注册了 [Cloudflare 账号](https://dash.cloudflare.com/)

### 第 1 步：安装 Wrangler CLI

打开终端（PowerShell 或命令提示符），运行：

```bash
npm install -g wrangler
```

验证安装：

```bash
npx wrangler --version
```

### 第 2 步：登录 Cloudflare

```bash
npx wrangler login
```

浏览器会自动打开，点击「Allow」授权。

### 第 3 步：创建 KV 命名空间

```bash
npx wrangler kv:namespace create DATA_KV
```

输出类似：

```
Add the following to your wrangler.toml:
[[kv_namespaces]]
binding = "DATA_KV"
id = "abc123def456..."
```

**复制那个 `id` 值**（例如 `abc123def456...`），打开 `wrangler.toml`，把 `YOUR_KV_NAMESPACE_ID` 替换为这个 id。

### 第 4 步：设置自定义 PIN 码

```bash
npx wrangler kv:key put --binding=DATA_KV "config:pin_code" "你的6位数字密码"
```

> ⚠️ 如果不设置，默认密码为 `8520`。建议修改为自己的密码。

### 第 5 步：（可选）配置 Supabase 数据库

如果需要客户管理功能（意向客户录入、分类、备注等），需要 Supabase：

1. 在 [supabase.com](https://supabase.com) 创建免费项目
2. 获取项目 URL 和 `anon` key
3. 在 `wrangler.toml` 的 `[vars]` 中填入：

```toml
[vars]
SUPABASE_URL = "https://你的项目.supabase.co"
SUPABASE_KEY = "你的anon key"
```

不需要客户管理功能可跳过此步。

### 第 6 步：部署到 Cloudflare

```bash
npx wrangler deploy
```

部署成功后，终端会显示你的 Workers 地址，例如：

```
https://megz-standalone.你的用户名.workers.dev
```

在浏览器打开这个地址即可使用。

---

## 修改密码

部署后随时可以修改 PIN 码：

```bash
npx wrangler kv:key put --binding=DATA_KV "config:pin_code" "新密码"
```

修改立即生效（刷新页面后需要输入新密码）。

---

## 文件说明

| 文件 | 说明 |
|------|------|
| `src/index.js` | Worker 主文件，包含完整的主界面 HTML + 后端 API |
| `src/supabase.js` | Supabase 数据库客户端 |
| `wrangler.toml` | 部署配置文件 |

## 功能列表

- ✅ 微信计数（+/− 按钮 + 键盘快捷键）
- ✅ 意向客户登记（支持编辑、删除、分类标记）
- ✅ 客户资料字段（公司、公积金、备注等）
- ✅ 待办清单（今天 + 明天，自动日滚动）
- ✅ 周报 / 月报统计
- ✅ 紧凑日历视图
- ✅ 暗色模式
- ✅ 动态壁纸背景
- ✅ PIN 码隐私锁屏（密码通过 KV 配置，可按设备设不同密码）
- ✅ Ctrl+Z 一键锁屏
- ✅ 数据自动同步（localStorage + KV + 定时推送）
