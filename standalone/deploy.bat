@echo off
REM ============================================================
REM megz 手动部署脚本 (Windows PowerShell)
REM 使用方法: 双击运行，或在 PowerShell 中执行 .\deploy.ps1
REM ============================================================
echo =========================================
echo   megz 每日工作 — 一键部署脚本
echo =========================================
echo.

REM 检查 Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ 未检测到 Node.js，请先安装: https://nodejs.org
    pause
    exit /b 1
)
echo ✅ Node.js 已检测到

REM 登录
echo.
echo 📋 检查 Cloudflare 登录状态...
call npx wrangler whoami >nul 2>&1
if %errorlevel% neq 0 (
    echo 🔐 需要登录 Cloudflare，浏览器将自动打开...
    call npx wrangler login
)
echo ✅ Cloudflare 已登录

REM 创建 KV
echo.
echo 📋 创建 KV 命名空间（如已存在会报错，可忽略）...
call npx wrangler kv:namespace create DATA_KV 2>&1

echo.
echo 📋 如果上面创建成功，请复制输出的 id，打开 wrangler.toml
echo    把 YOUR_KV_NAMESPACE_ID 替换为实际的 id
echo.
echo    然后继续执行部署:
echo    npx wrangler deploy
echo.
echo    设置 PIN 密码:
echo    npx wrangler kv:key put --binding=DATA_KV "config:pin_code" "你的密码"
echo.
echo =========================================
echo   详细说明请阅读 README.md
echo =========================================
pause
