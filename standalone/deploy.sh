#!/bin/bash
# ============================================================
# megz 手动部署脚本 (Mac / Linux)
# 使用方法: bash deploy.sh
# ============================================================
set -e

echo "========================================="
echo "  megz 每日工作 — 一键部署脚本"
echo "========================================="
echo ""

# 1. 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "❌ 未检测到 Node.js，请先安装: https://nodejs.org"
    exit 1
fi
echo "✅ Node.js $(node -v)"

# 2. 安装 Wrangler
if ! command -v npx &> /dev/null; then
    echo "❌ 未检测到 npx，请确认 Node.js 安装正确"
    exit 1
fi

# 3. 登录 Cloudflare（如果未登录）
echo ""
echo "📋 检查 Cloudflare 登录状态..."
if ! npx wrangler whoami &> /dev/null; then
    echo "🔐 需要登录 Cloudflare，浏览器将自动打开..."
    npx wrangler login
fi
echo "✅ Cloudflare 已登录"

# 4. 创建 KV 命名空间（如果还没有）
echo ""
echo "📋 检查 KV 命名空间..."
KV_OUTPUT=$(npx wrangler kv:namespace create DATA_KV 2>&1) || true
KV_ID=$(echo "$KV_OUTPUT" | grep -oE '"id":\s*"[^"]+"' | head -1 | cut -d'"' -f4)

if [ -z "$KV_ID" ]; then
    # 可能已经存在，尝试列出
    echo "KV 命名空间可能已存在，尝试获取现有 ID..."
    KV_LIST=$(npx wrangler kv:namespace list 2>&1)
    KV_ID=$(echo "$KV_LIST" | grep -oE '"id":\s*"[^"]+"' | head -1 | cut -d'"' -f4)
fi

if [ -z "$KV_ID" ]; then
    echo "❌ 无法创建或找到 KV 命名空间，请在 Cloudflare Dashboard 手动创建"
    echo "   访问: https://dash.cloudflare.com → Workers & Pages → KV → 创建命名空间"
    echo "   名称: DATA_KV"
    echo "   然后将 ID 填入 wrangler.toml 的 YOUR_KV_NAMESPACE_ID"
    exit 1
fi
echo "✅ KV 命名空间 ID: $KV_ID"

# 5. 更新 wrangler.toml
echo ""
echo "📋 更新 wrangler.toml..."
sed -i.bak "s/YOUR_KV_NAMESPACE_ID/$KV_ID/" wrangler.toml
rm -f wrangler.toml.bak
echo "✅ wrangler.toml 已更新"

# 6. 询问 PIN 密码
echo ""
read -p "🔐 请设置 PIN 解锁密码 (默认 8520): " PIN_CODE
PIN_CODE=${PIN_CODE:-8520}

# 7. 部署
echo ""
echo "🚀 开始部署到 Cloudflare Workers..."
npx wrangler deploy

# 8. 设置 PIN 密码
echo ""
echo "📋 设置 PIN 密码..."
echo "$PIN_CODE" | npx wrangler kv:key put --binding=DATA_KV "config:pin_code" "$PIN_CODE" 2>/dev/null || \
    npx wrangler kv:key put --binding=DATA_KV "config:pin_code" "$PIN_CODE"

echo ""
echo "========================================="
echo "  ✅ 部署完成！"
echo "  访问: https://megz-standalone.你的用户名.workers.dev"
echo "  PIN 密码: $PIN_CODE"
echo "========================================="
