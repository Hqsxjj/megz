# megz 独立版 — 每日工作主界面

纯 KV 存储，不依赖 Supabase。PIN 码通过 Cloudflare KV 动态配置。

---

## 方式一：让 Claude 帮你部署（推荐）

**对我说**：「帮我部署 megz 独立版，密码设成 xxxxxx」

然后我会自动执行下面的流程：

```bash
# 1. 进入目录
cd C:\Users\Administrator\megz\standalone

# 2. 登录 Cloudflare（如果还没登过）
npx wrangler login

# 3. 创建 KV 命名空间
npx wrangler kv:namespace create DATA_KV

# 4. 把上面输出的 id 写入 wrangler.toml（替换 YOUR_KV_NAMESPACE_ID）

# 5. 设置 PIN 密码
npx wrangler kv:key put --binding=DATA_KV "config:pin_code" "你的密码"

# 6. 部署
npx wrangler deploy
```

**如果已有 KV 命名空间**，可以跳过第 3 步，直接用现有的 KV id 更新 wrangler.toml 就行。

---

## 方式二：网页端手动部署（无需安装任何软件）

### 第 1 步：打开 Workers 控制台

浏览器打开 https://dash.cloudflare.com

左侧菜单找到 **Workers 和 Pages** → 点击 **创建应用程序** → 选择 **创建 Worker**。

### 第 2 步：粘贴代码

给 Worker 起个名字（比如 `megz`）。

删掉编辑器里默认的示例代码，**全选清空**，然后把包里的 `src/index.js` 文件内容**全部复制粘贴进去**。

> 用记事本或 VS Code 打开 `src/index.js`，Ctrl+A 全选，Ctrl+C 复制，到网页编辑器里 Ctrl+V 粘贴。

### 第 3 步：创建 KV 并绑定

1. 左侧菜单点 **存储和数据库** → **KV** → **创建命名空间**
2. 名称填 `DATA_KV`，点创建
3. 回到刚才的 Worker 页面 → 点 **设置** 标签 → **绑定** → **添加绑定**
4. 按下面填写：
   - 变量名称：`DATA_KV`
   - KV 命名空间：选刚才创建的 `DATA_KV`
5. 点保存

### 第 4 步：设置 PIN 密码

1. 左侧菜单 → **存储和数据库** → **KV** → 点进 `DATA_KV`
2. 点击右上角 **添加条目**
3. 键（Key）填：`config:pin_code`
4. 值（Value）填：你想设的密码（比如 `123456`，不设则默认 `8520`）
5. 点保存

### 第 5 步：部署

回到 Worker 编辑器页面，点右上角蓝色 **部署** 按钮。

部署完成后，访问 `https://你的worker名.你的用户名.workers.dev` 就能用了。

---

## 方式二：命令行部署（Wrangler CLI）

### 前提条件
- 安装了 [Node.js](https://nodejs.org/)（v18+）
- 注册了 [Cloudflare 账号](https://dash.cloudflare.com/)

### 第 1 步：安装 Wrangler

```bash
npm install -g wrangler
```

### 第 2 步：登录

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

**复制那个 `id`**，打开包里的 `wrangler.toml`，把 `YOUR_KV_NAMESPACE_ID` 替换掉。

### 第 4 步：设置 PIN 密码

```bash
npx wrangler kv:key put --binding=DATA_KV "config:pin_code" "你的密码"
```

### 第 5 步：部署

```bash
npx wrangler deploy
```

---

## 修改密码

**网页端**：KV → DATA_KV → 找到 `config:pin_code` → 编辑 → 改值 → 保存。

**命令行**：

```bash
npx wrangler kv:key put --binding=DATA_KV "config:pin_code" "新密码"
```

刷新页面立即生效。

---

## 文件说明

| 文件 | 说明 |
|------|------|
| `src/index.js` | Worker 主文件（界面 + API + PIN 锁，纯 KV 存储） |
| `wrangler.toml` | 部署配置（命令行方式用） |

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
