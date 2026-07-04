# megz 独立版 — 每日工作主界面

纯 KV 存储，不依赖 Supabase。PIN 码通过 Cloudflare KV 动态配置。

---

## 部署教程（3 分钟）

### 前提条件
- 安装了 [Node.js](https://nodejs.org/)（v18+）
- 注册了 [Cloudflare 账号](https://dash.cloudflare.com/)

### 第 1 步：安装 Wrangler

```bash
npm install -g wrangler
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
[[kv_namespaces]]
binding = "DATA_KV"
id = "abc123def456..."
```

**复制那个 `id`**，打开 `wrangler.toml`，把 `YOUR_KV_NAMESPACE_ID` 替换掉。

### 第 4 步：设置自定义 PIN 码

```bash
npx wrangler kv:key put --binding=DATA_KV "config:pin_code" "你的6位数字密码"
```

> ⚠️ 如果不设置，默认密码为 `8520`。建议改成自己的。

### 第 5 步：部署

```bash
npx wrangler deploy
```

部署成功后打开浏览器访问终端显示的地址（例如 `https://megz-standalone.你的用户名.workers.dev`）。

---

## 修改密码

```bash
npx wrangler kv:key put --binding=DATA_KV "config:pin_code" "新密码"
```

刷新页面立即生效。

---

## 文件说明

| 文件 | 说明 |
|------|------|
| `src/index.js` | Worker 主文件（主界面 + API + PIN 锁，纯 KV 存储） |
| `wrangler.toml` | 部署配置（只需填 KV id） |

## 存储说明

所有数据存储在 Cloudflare Workers KV 中（key 格式：`work:YYYY-MM-DD`）。**不依赖 Supabase 或任何外部数据库**，一个 KV 就够用。

## 功能

- ✅ 微信计数（+/− 按钮 + 键盘快捷键 `+` `-`）
- ✅ 意向客户登记（编辑、删除、分类）
- ✅ 待办清单（今天 + 明天，自动日滚动）
- ✅ 周报 / 月报统计
- ✅ 紧凑日历视图 + 暗色模式
- ✅ 动态壁纸（picsum 每日缓存）
- ✅ PIN 码隐私锁屏（Ctrl+Z 一键锁屏，密码通过 KV 配置）
- ✅ 数据自动同步（localStorage ↔ KV，5 秒推送）
