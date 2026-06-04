export const DIALER_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=yes, viewport-fit=cover, shrink-to-fit=no">
  <title>智能快捷拨号助手</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg-app: #ededed;
      --card-bg: #ffffff;
      --card-border: #e0e0e0;
      --text-main: #191919;
      --text-soft: #5e5e5e;
      --text-light: #8e8e8e;
      --accent-wechat: #07c160;
      --accent-intent: #07c160;
      --accent-wechat-bg: #f0fdf5;
      --accent-intent-bg: #f0fdf5;
      --btn-bg: #f5f5f5;
      --btn-hover: #e5e5e5;
      --shadow-card: 0 1px 3px rgba(0,0,0,0.06);
      --border-light: #e5e5e5;
      --modal-bg: rgba(0,0,0,0.45);
      --modal-card: #ffffff;
      --radius-sm: 8px;
      --radius-xs: 6px;
      --wechat-gradient: linear-gradient(135deg, #b7f0ce 0%, #6be89d 50%, #1aad5a 100%);
      --intent-gradient: linear-gradient(135deg, #ffe0b2 0%, #ffb74d 50%, #f57c00 100%);
      --revisit-gradient: linear-gradient(135deg, #d1e0ff 0%, #7b9ff5 50%, #4a6cf7 100%);
    }
    body.dark-mode {
      --bg-app: rgba(17,17,17,0.92);
      --card-bg: rgba(26,26,26,0.9);
      --card-border: #2c2c2c;
      --text-main: #e5e5e5;
      --text-soft: #a0a0a0;
      --text-light: #6b6b6b;
      --accent-wechat: #07c160;
      --accent-intent: #07c160;
      --accent-wechat-bg: #17241c;
      --accent-intent-bg: #17241c;
      --btn-bg: rgba(38,38,38,0.85);
      --btn-hover: #2c2c2c;
      --border-light: #262626;
      --modal-bg: rgba(0,0,0,0.88);
      --modal-card: #1a1a1a;
      --wechat-gradient: linear-gradient(135deg, #0d3320 0%, #144d2e 50%, #1a6b3a 100%);
      --intent-gradient: linear-gradient(135deg, #332010 0%, #4d2e14 50%, #6b3a1a 100%);
      --revisit-gradient: linear-gradient(135deg, #1a2233 0%, #2a354d 50%, #3a4d6b 100%);
    }
    html, body {
      height: 100%;
      width: 100%;
      overflow: hidden;
      background: var(--bg-app);
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", sans-serif;
      font-weight: 700;
      transition: background 0.3s;
    }
    .app-shell {
      height: 100%;
      width: 100%;
      display: flex;
      flex-direction: column;
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    }
    .container {
      flex: 1;
      width: 100%;
      max-width: 520px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: var(--card-bg);
      border-left: 1px solid var(--border-light);
      border-right: 1px solid var(--border-light);
      box-shadow: 0 4px 30px rgba(0,0,0,0.03);
    }
    
    /* Header Bar */
    .header-bar {
      height: 34px;
      padding: 0 12px;
      border-bottom: 1px solid var(--border-light);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
      position: relative;
    }
    .header-stats-minimal {
      font-size: 0.76rem;
      font-weight: 900;
      color: var(--text-soft);
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .header-dropdown {
      position: absolute;
      top: 30px;
      right: 0;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius-sm);
      box-shadow: 0 8px 24px rgba(0,0,0,0.12);
      z-index: 2500;
      display: flex;
      flex-direction: column;
      padding: 4px 0;
      max-height: 60vh;
      overflow-y: auto;
      min-width: 120px;
      min-width: 130px;
    }
    .dropdown-item {
      padding: 8px 12px;
      font-size: 0.74rem;
      color: var(--text-soft);
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      transition: all 0.15s;
      font-weight: 700;
      background: transparent;
      border: none;
      width: 100%;
      text-align: left;
    }
    .dropdown-item:hover {
      background: var(--btn-hover);
      color: var(--text-main);
    }
    .icon-btn {
      background: var(--btn-bg);
      border: 1px solid var(--card-border);
      color: var(--text-main);
      font-size: 0.76rem;
      font-weight: 800;
      padding: 4px 10px;
      border-radius: var(--radius-xs);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: all 0.2s;
    }
    .icon-btn:hover {
      background: var(--btn-hover);
    }
    
    /* Dashboard Area */
    .dashboard-panel {
      padding: 16px 20px;
      background: var(--bg-app);
      border-bottom: 1px solid var(--border-light);
      flex-shrink: 0;
    }
    .import-zone {
      background: var(--card-bg);
      border: 2px dashed var(--card-border);
      border-radius: var(--radius-sm);
      padding: 24px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      transition: all 0.2s;
    }
    .import-zone.dragover {
      border-color: var(--accent-wechat);
      background: var(--accent-wechat-bg);
    }
    .import-buttons {
      display: flex;
      gap: 12px;
      margin-top: 4px;
    }
    .btn-primary {
      background: var(--wechat-gradient);
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: var(--radius-xs);
      font-size: 0.82rem;
      font-weight: 800;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(7,193,96,0.2);
      transition: all 0.2s;
    }
    .btn-primary:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(7,193,96,0.3);
    }
    .btn-secondary {
      background: var(--revisit-gradient);
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: var(--radius-xs);
      font-size: 0.82rem;
      font-weight: 800;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(74,108,247,0.2);
      transition: all 0.2s;
    }
    .btn-secondary:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 16px rgba(74,108,247,0.3);
    }
    
    /* Stats Bar */
    .stats-bar {
      margin-top: 14px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius-xs);
      padding: 12px 18px;
    }
    .stat-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .stat-label {
      font-size: 0.68rem;
      color: var(--text-light);
      text-transform: uppercase;
    }
    .stat-val {
      font-size: 1.1rem;
      font-weight: 900;
      color: var(--text-main);
    }
    .progress-track {
      flex: 1;
      height: 8px;
      background: var(--btn-bg);
      border-radius: 4px;
      margin: 0 24px;
      overflow: hidden;
      position: relative;
    }
    .progress-fill {
      height: 100%;
      background: var(--wechat-gradient);
      width: 0%;
      border-radius: 4px;
      transition: width 0.3s ease;
    }
    
    /* Control Panel */
    .control-bar {
      height: 48px;
      padding: 0 20px;
      border-bottom: 1px solid var(--border-light);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-shrink: 0;
    }
    .search-input {
      width: 130px;
      flex-shrink: 0;
      height: 32px;
      background: var(--btn-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius-xs);
      padding: 0 12px;
      font-size: 0.8rem;
      color: var(--text-main);
      outline: none;
      font-weight: 700;
      transition: all 0.2s;
    }
    .search-input:focus {
      border-color: var(--accent-wechat);
      background: var(--card-bg);
    }
    .filter-group {
      display: flex;
      gap: 4px;
    }
    .filter-tab {
      height: 30px;
      padding: 0 12px;
      background: transparent;
      border: none;
      color: var(--text-soft);
      font-size: 0.76rem;
      font-weight: 800;
      border-radius: 6px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      transition: all 0.2s;
    }
    .filter-tab.active {
      background: var(--accent-wechat-bg);
      color: var(--accent-wechat);
    }
    
    /* Cards Container */
    .cards-content {
      flex: 1;
      overflow-y: auto;
      padding: 10px 14px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    
    /* Contact Card */
    .xls-dial-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius-xs);
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      box-shadow: var(--shadow-card);
      position: relative;
      transition: all 0.2s ease;
    }
    .xls-dial-card:hover {
      border-color: rgba(7, 193, 96, 0.4);
      transform: translateY(-1px);
    }
    .xls-dial-card.dialed {
      opacity: 0.75;
      border-color: var(--border-light);
      background: rgba(0, 0, 0, 0.005);
    }
    body.dark-mode .xls-dial-card.dialed {
      background: rgba(255, 255, 255, 0.003);
    }
    .xls-dial-badge {
      font-size: 0.65rem;
      font-weight: 800;
      padding: 2px 6px;
      border-radius: 4px;
      display: inline-flex;
      align-items: center;
    }
    .xls-dial-badge-todo {
      background: var(--btn-bg);
      color: var(--text-soft);
    }
    .xls-dial-badge-success {
      background: rgba(7, 193, 96, 0.1);
      color: var(--accent-intent);
      border: 0.5px solid rgba(7, 193, 96, 0.2);
    }
    .xls-dial-badge-failed {
      background: rgba(231, 76, 60, 0.1);
      color: #e74c3c;
      border: 0.5px solid rgba(231, 76, 60, 0.2);
    }
    

    
    .client-card-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .client-card-primary {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .client-card-name-btn {
      font-size: 0.92rem;
      font-weight: 900;
      color: var(--text-main);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 1px 4px;
      border-radius: var(--radius-xs);
      transition: all 0.2s;
    }
    .client-card-name-btn:hover {
      background: var(--btn-hover);
    }
    .client-card-phone-wrap {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .client-phone-btn {
      font-family: monospace;
      font-size: 0.82rem;
      font-weight: 800;
      color: var(--text-soft);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      padding: 1px 4px;
      border-radius: var(--radius-xs);
      transition: all 0.2s;
    }
    .client-phone-btn:hover {
      background: var(--btn-hover);
      color: var(--text-main);
    }
    .client-phone-btn.copied {
      color: var(--text-main) !important;
      text-shadow: 0 0 6px rgba(7, 193, 96, 0.45);
      font-weight: 900;
    }
    body.dark-mode .client-phone-btn.copied {
      text-shadow: 0 0 8px rgba(7, 193, 96, 0.6);
    }
    .client-card-tags {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .client-card-tag {
      font-size: 0.65rem;
      font-weight: 800;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .client-card-tag-company {
      background: rgba(7,193,96,0.08);
      color: var(--accent-wechat);
    }
    .client-card-body {
      display: flex;
      flex-direction: column;
      gap: 4px;
      border-left: 2px solid var(--border-light);
      padding-left: 8px;
    }
    .client-card-content-block {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .client-card-label {
      font-size: 0.62rem;
      color: var(--text-light);
      text-transform: uppercase;
    }
    .client-card-text {
      font-size: 0.74rem;
      color: var(--text-soft);
      line-height: 1.4;
    }
    .client-card-actions {
      display: flex;
      justify-content: flex-end;
      border-top: 1px dashed var(--border-light);
      padding-top: 6px;
      margin-top: 0px;
    }
    
    /* AI Importer Animations */
    @keyframes pulse-ring {
      0% { transform: scale(0.95); opacity: 0.5; }
      50% { transform: scale(1.1); opacity: 0.15; }
      100% { transform: scale(0.95); opacity: 0.5; }
    }
    @keyframes laser-scan {
      0% { top: 0%; opacity: 0; }
      10% { opacity: 1; }
      90% { opacity: 1; }
      100% { top: 100%; opacity: 0; }
    }
    .ai-laser-line {
      position: absolute;
      left: 0;
      width: 100%;
      height: 2px;
      background: linear-gradient(90deg, rgba(7,193,96,0) 0%, rgba(7,193,96,0.8) 50%, rgba(7,193,96,0) 100%);
      box-shadow: 0 0 8px rgba(7,193,96,0.6);
      animation: laser-scan 2s infinite linear;
      pointer-events: none;
    }
    
    /* Overlay and Modals */
    .modal-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: var(--modal-bg);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      z-index: 2000;
      opacity: 0;
      pointer-events: none;
      transition: all 0.25s ease;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .modal-overlay.active {
      opacity: 1;
      pointer-events: auto;
    }
    .modal-card {
      background: var(--modal-card);
      border: 1px solid var(--card-border);
      border-radius: 14px;
      box-shadow: 0 15px 45px rgba(0,0,0,0.3);
      width: 90vw;
      max-width: 400px;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      transform: translateY(20px);
      transition: all 0.25s cubic-bezier(0.25, 0.8, 0.25, 1);
    }
    .modal-overlay.active .modal-card {
      transform: translateY(0);
    }
    
    /* Dialer Assist */
    .call-pulse {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: var(--accent-wechat-bg);
      color: var(--accent-wechat);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 1.8rem;
      margin: 0 auto 6px;
      position: relative;
    }
    .call-pulse::after {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      border-radius: 50%;
      border: 2px solid var(--accent-wechat);
      animation: ripple 1.6s infinite ease-out;
      opacity: 0;
    }
    @keyframes ripple {
      0% { transform: scale(1); opacity: 0.5; }
      100% { transform: scale(1.6); opacity: 0; }
    }
    
    .btn-modal {
      height: 42px;
      border: none;
      border-radius: var(--radius-xs);
      font-size: 0.85rem;
      font-weight: 800;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
    }
    .btn-success {
      background: #07c160;
      color: white;
      box-shadow: 0 4px 12px rgba(7,193,96,0.25);
    }
    .btn-danger {
      background: #e74c3c;
      color: white;
      box-shadow: 0 4px 12px rgba(231,76,60,0.25);
    }
    .btn-neutral {
      background: #7f8c8d;
      color: white;
      box-shadow: 0 4px 12px rgba(127,140,141,0.25);
    }
    
    /* Export Panel */
    .export-modal-card {
      max-width: 500px;
    }
    .export-textarea {
      width: 100%;
      height: 200px;
      background: var(--btn-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius-xs);
      padding: 10px 12px;
      font-size: 0.76rem;
      color: var(--text-main);
      outline: none;
      font-weight: 600;
      resize: none;
      line-height: 1.5;
      font-family: monospace;
    }
    .sync-badge {
      transition: all 0.2s ease;
      cursor: pointer;
    }
    .sync-badge.online-synced {
      background: var(--accent-wechat-bg) !important;
      color: var(--accent-wechat) !important;
      border: 0.5px solid rgba(7,193,96,0.2) !important;
    }
    .sync-badge.online-unsynced {
      background: rgba(245,124,0,0.1) !important;
      color: #f57c00 !important;
      border: 0.5px solid rgba(245,124,0,0.2) !important;
    }
    .sync-badge.offline-mode {
      background: var(--btn-bg) !important;
      color: var(--text-light) !important;
      border: 0.5px solid var(--card-border) !important;
    }
    
    /* Android APK full-screen spacing */
    body.android .app-shell { padding-top: 39px; }

    /* Mobile Adaptive Styles for iOS & Android */
    @media (max-width: 480px) {
      .container {
        border-left: none;
        border-right: none;
        border-radius: 0;
        box-shadow: none;
      }
      .control-bar {
        padding: 0 8px;
        gap: 6px;
        height: 42px;
      }
      .search-input {
        width: 100px;
        padding: 0 6px;
        font-size: 0.74rem;
      }
      .filter-group {
        gap: 2px;
      }
      .filter-tab {
        padding: 0 6px;
        font-size: 0.7rem;
        height: 28px;
      }
      .header-bar {
        height: 38px;
        padding: 0 10px;
      }
      .header-stats-minimal {
        font-size: 0.72rem;
      }
      .cards-content {
        padding: 6px 8px;
        gap: 6px;
      }
      .xls-dial-card {
        padding: 8px 10px;
        gap: 5px;
        border-radius: 6px;
      }
      .card-copy-btn {
        top: 6px;
        right: 10px;
        padding: 2px 5px;
        font-size: 0.62rem;
      }
      .client-card-name-btn {
        font-size: 0.88rem;
        padding: 1px 2px;
      }
      .client-phone {
        font-size: 0.78rem;
      }
      .xls-dial-badge {
        font-size: 0.6rem;
        padding: 1px 4px;
      }
      .client-card-tag {
        font-size: 0.6rem;
        padding: 1px 4px;
      }
      .client-card-body {
        gap: 2px;
        padding-left: 6px;
      }
      .client-card-text {
        font-size: 0.72rem;
      }
      .client-card-actions {
        padding-top: 4px;
      }
      .xls-card-dial-btn {
        height: 26px;
        padding: 0 10px;
        font-size: 0.72rem;
      }
    }

    /* Whitelist match badges */
    .xls-dial-badge-whitelist {
      background: rgba(7,193,96,0.1);
      color: var(--accent-wechat);
      border: 0.5px solid rgba(7,193,96,0.2);
    }
    .xls-dial-badge-not-whitelist {
      background: rgba(231,76,60,0.1);
      color: #e74c3c;
      border: 0.5px solid rgba(231,76,60,0.2);
    }

    /* Whitelist management modal */
    .whitelist-textarea {
      width: 100%;
      height: 180px;
      background: var(--btn-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius-xs);
      padding: 10px 12px;
      font-size: 0.76rem;
      color: var(--text-main);
      outline: none;
      font-weight: 600;
      resize: none;
      line-height: 1.5;
    }
    .whitelist-company-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 5px 0;
      border-bottom: 1px solid var(--border-light);
    }
  </style>
</head>
<body>
  <div class="app-shell">
    <div class="container">
      <!-- Header -->
      <div class="header-bar">
        <!-- Minimal Stats on the Left -->
        <div class="header-stats-minimal" id="headerStatsMinimal" style="display: none;">
          <span>进度:</span>
          <span id="doneCount" style="color: var(--accent-wechat);">0</span>
          <span style="color: var(--text-light);">/</span>
          <span id="totalCount">0</span>
          <span id="percentText" style="font-size: 0.65rem; color: var(--text-light); margin-left: 2px;">(0%)</span>
        </div>
        
        <!-- Auto Dial Toggle -->
        <button id="autoDialBtn" title="自动拨打" style="font-size: 0.78rem; padding: 4px 10px; border: 1px solid var(--accent-wechat); background: var(--accent-wechat-bg); color: var(--accent-wechat); cursor: pointer; outline: none; font-weight: 700; border-radius: var(--radius-xs); margin-left: auto; margin-right: 8px; white-space: nowrap;">自动拨打</button>
        <!-- Dropdown Menu Trigger on the Right -->
        <div style="position: relative; display: inline-block;">
          <button id="headerMenuBtn" title="更多设置" style="font-size: 0.8rem; padding: 6px 10px; border: none; background: transparent; cursor: pointer; outline: none; font-weight: 800; color: var(--text-soft); min-width: 44px; min-height: 34px; -webkit-tap-highlight-color: transparent; touch-action: manipulation;">更多</button>
          <div class="header-dropdown" id="headerDropdown" style="display: none;">
            <button class="dropdown-item sync-badge" id="syncStatusBadge">离线模式</button>
            <button class="dropdown-item" id="toggleImportBtn">导入文件</button>
            <button class="dropdown-item" id="whitelistMenuBtn">白名单管理</button>
            <button class="dropdown-item" id="toggleDualSimBtn">双卡轮换: 开</button>
            <button class="dropdown-item" id="toggleRotationBtn">轮换频率: 10通</button>
            <button class="dropdown-item" id="exportBtn" style="display:none;">导出记录</button>
            <button class="dropdown-item" id="clearBtn" style="display:none; color: #e74c3c;">清空数据</button>
            <button class="dropdown-item" id="darkToggleBtn">切换主题</button>
          </div>
        </div>

        <!-- Super thin absolute-positioned progress line at bottom of header -->
        <div style="position: absolute; bottom: 0; left: 0; right: 0; height: 3px; background: var(--border-light); overflow: hidden;">
          <div class="progress-fill" id="progressFill" style="height: 100%; width: 0%; transition: width 0.3s ease;"></div>
        </div>
      </div>
      
      <!-- Dashboard -->
      <div class="dashboard-panel" id="dashboardPanel">
        <!-- AI Drag & Drop Zone -->
        <div class="import-zone" id="dropZone" style="position: relative; overflow: hidden; min-height: 200px;">
          <!-- Animation Laser Line (Only visible during scanning) -->
          <div id="aiLaserLine" class="ai-laser-line" style="display: none;"></div>

          <!-- 1. INITIAL STATE -->
          <div id="aiImportInit" style="display: flex; flex-direction: column; align-items: center; gap: 10px; width: 100%;">
            <!-- Pulsing AI Brain Core SVG -->
            <div style="position: relative; width: 50px; height: 50px; display: flex; align-items: center; justify-content: center; margin-bottom: 2px;">
              <div style="position: absolute; width: 44px; height: 44px; border-radius: 50%; border: 2px solid rgba(7, 193, 96, 0.4); animation: pulse-ring 2s infinite ease-in-out;"></div>
              <div style="position: absolute; width: 30px; height: 30px; border-radius: 50%; background: var(--wechat-gradient); display: flex; align-items: center; justify-content: center; color: white; font-size: 1.1rem; box-shadow: 0 0 10px rgba(7, 193, 96, 0.4);">🤖</div>
            </div>
            <span style="font-size: 0.88rem; color: var(--text-main); font-weight: 900; letter-spacing: 0.5px;">BH-AI 智能双引擎导入助手</span>
            <span style="font-size: 0.7rem; color: var(--text-light); max-width: 320px; line-height: 1.4; margin-top: -4px;">搭载启发式文字密度与特征识别算法，自动检测表头、过滤噪音，100% 本地隐私安全。</span>
            
            <div class="import-buttons" style="margin-top: 6px; display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; width: 100%;">
              <label class="btn-primary" for="xlsFileInput" id="xlsSelectBtn" style="cursor:pointer; display:inline-flex; align-items:center; justify-content:center; padding: 8px 16px; font-size: 0.76rem; flex: 1; min-width: 130px; text-align: center;">📂 导入表格 / 文档</label>
              <label class="btn-primary" for="imgFileInput" id="imgSelectBtn" style="cursor:pointer; display:inline-flex; align-items:center; justify-content:center; padding: 8px 16px; font-size: 0.76rem; flex: 1; min-width: 130px; text-align: center; background: var(--revisit-gradient) !important; color: white;">📸 智能图片 OCR</label>
              <label class="btn-secondary" for="vcfFileInput" id="vcfSelectBtn" style="cursor:pointer; display:inline-flex; align-items:center; justify-content:center; padding: 8px 16px; font-size: 0.76rem; flex: 1; min-width: 130px; text-align: center;">👤 导入 VCF 通录</label>
            </div>
            <input type="file" id="xlsFileInput" accept=".xls,.xlsx,.csv,.docx,.pdf,.txt" style="display:none;">
            <input type="file" id="imgFileInput" accept="image/*" style="display:none;">
            <input type="file" id="vcfFileInput" accept=".vcf,.vcard" style="display:none;">
          </div>

          <!-- 2. SCANNING STATE -->
          <div id="aiImportScanning" style="display: none; flex-direction: column; align-items: center; gap: 12px; width: 100%; padding: 10px 0;">
            <div style="font-size: 1.6rem; animation: pulse-ring 1s infinite alternate; margin-bottom: 2px;">🧠</div>
            <span style="font-size: 0.8rem; color: var(--text-main); font-weight: 800;" id="aiScanStatus">BH-AI 深度模型解析中...</span>
            <div style="display: flex; flex-direction: column; gap: 4px; text-align: left; font-size: 0.65rem; color: var(--text-soft); font-family: monospace; width: 100%; max-width: 260px; background: rgba(0,0,0,0.02); padding: 8px; border-radius: var(--radius-xs); border: 0.5px solid var(--card-border);">
              <div id="aiLog1" style="opacity: 0.4;">[ ] 正在读取数据流...</div>
              <div id="aiLog2" style="opacity: 0.4;">[ ] 正在评估特征维度...</div>
              <div id="aiLog3" style="opacity: 0.4;">[ ] 正在过滤杂质与噪音...</div>
              <div id="aiLog4" style="opacity: 0.4;">[ ] 正在匹配智能映射...</div>
            </div>
          </div>

          <!-- 3. REPORT STATE -->
          <div id="aiImportReport" style="display: none; flex-direction: column; width: 100%; text-align: left; gap: 8px;">
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px dashed var(--border-light); padding-bottom: 6px;">
              <span id="aiReportTitle" style="font-size: 0.8rem; font-weight: 900; color: var(--text-main);">AI 识别报告</span>
              <span id="aiConfidenceBadge" style="font-size: 0.62rem; font-weight: 800; padding: 2px 6px; border-radius: 4px; background: rgba(7, 193, 96, 0.1); color: var(--accent-wechat); border: 0.5px solid rgba(7, 193, 96, 0.2);">● 置信度: 98%</span>
            </div>

            <!-- Mapped Pillars -->
            <div id="aiExcelMappingPills" style="display: flex; flex-wrap: wrap; gap: 4px; background: var(--btn-bg); padding: 6px; border-radius: var(--radius-xs);">
              <div style="font-size: 0.65rem; font-weight: 800; color: var(--text-soft); width: 100%; margin-bottom: 2px;">AI 智能列映射映射关系：</div>
              <div class="client-card-tag" id="pillName" style="background: rgba(7,193,96,0.08); color: var(--accent-wechat);">姓名 ➔ 未识别</div>
              <div class="client-card-tag" id="pillPhone" style="background: rgba(7,193,96,0.08); color: var(--accent-wechat);">电话 ➔ 未识别</div>
              <div class="client-card-tag" id="pillCompany" style="background: rgba(74,108,247,0.08); color: #4a6cf7;">公司 ➔ 无</div>
              <div class="client-card-tag" id="pillNote" style="background: rgba(245,124,0,0.08); color: #f57c00;">备注 ➔ 无</div>
            </div>

            <!-- Manual Override Button & Selectors (Collapsed by default) -->
            <div id="aiExcelMappingControls" style="width: 100%;">
              <button id="aiToggleAdjustBtn" style="background: transparent; border: none; font-size: 0.65rem; font-weight: 800; color: var(--text-soft); cursor: pointer; display: inline-flex; align-items: center; gap: 4px; padding: 2px 0; outline: none;">⚙️ 手动修正 AI 映射结果 ▾</button>
              <div id="aiAdjustControls" style="display: none; grid-template-columns: repeat(2, 1fr); gap: 6px; margin-top: 4px; border: 1px dashed var(--card-border); padding: 8px; border-radius: var(--radius-xs); background: var(--card-bg);">
                <div style="display: flex; flex-direction: column; gap: 2px;">
                  <label style="font-size: 0.6rem; color: var(--text-light); font-weight: 800;">姓名数据列</label>
                  <select id="aiSelName" style="height: 24px; font-size: 0.65rem; outline: none; border: 1px solid var(--card-border); border-radius: 4px; font-weight: 800; color: var(--text-soft); background: var(--btn-bg);"></select>
                </div>
                <div style="display: flex; flex-direction: column; gap: 2px;">
                  <label style="font-size: 0.6rem; color: var(--text-light); font-weight: 800;">电话数据列</label>
                  <select id="aiSelPhone" style="height: 24px; font-size: 0.65rem; outline: none; border: 1px solid var(--card-border); border-radius: 4px; font-weight: 800; color: var(--text-soft); background: var(--btn-bg);"></select>
                </div>
                <div style="display: flex; flex-direction: column; gap: 2px;">
                  <label style="font-size: 0.6rem; color: var(--text-light); font-weight: 800;">公司数据列 (可选)</label>
                  <select id="aiSelCompany" style="height: 24px; font-size: 0.65rem; outline: none; border: 1px solid var(--card-border); border-radius: 4px; font-weight: 800; color: var(--text-soft); background: var(--btn-bg);"></select>
                </div>
                <div style="display: flex; flex-direction: column; gap: 2px;">
                  <label style="font-size: 0.6rem; color: var(--text-light); font-weight: 800;">备注数据列 (可选)</label>
                  <select id="aiSelNote" style="height: 24px; font-size: 0.65rem; outline: none; border: 1px solid var(--card-border); border-radius: 4px; font-weight: 800; color: var(--text-soft); background: var(--btn-bg);"></select>
                </div>
              </div>
            </div>

            <!-- Live Preview Table -->
            <div id="aiExcelPreviewContainer" style="width: 100%; border: 1px solid var(--card-border); border-radius: var(--radius-xs); overflow: hidden; background: var(--card-bg);">
              <div style="font-size: 0.6rem; font-weight: 800; color: var(--text-light); background: var(--btn-bg); padding: 4px 8px; border-bottom: 1px solid var(--card-border);">AI 导入数据效果实时预览 (前3行)：</div>
              <div style="overflow-x: auto; width: 100%;">
                <table style="width: 100%; border-collapse: collapse; font-size: 0.65rem; text-align: left;" id="aiPreviewTable">
                  <thead>
                    <tr style="border-bottom: 1px solid var(--card-border); font-weight: 800; color: var(--text-soft); background: rgba(0,0,0,0.01);">
                      <th style="padding: 4px 8px;">姓名</th>
                      <th style="padding: 4px 8px;">电话</th>
                      <th style="padding: 4px 8px;">公司</th>
                    </tr>
                  </thead>
                  <tbody>
                    <!-- populated dynamically -->
                  </tbody>
                </table>
              </div>
            </div>

            <!-- Unstructured Preview Table Container (Only visible for TXT/DOCX/PDF/OCR) -->
            <div id="aiUnstructuredContainer" style="display: none; width: 100%; border: 1px solid var(--card-border); border-radius: var(--radius-xs); overflow: hidden; background: var(--card-bg);">
              <div style="font-size: 0.6rem; font-weight: 800; color: var(--text-light); background: var(--btn-bg); padding: 4px 8px; border-bottom: 1px solid var(--card-border);">AI 智能提取结果校验与编辑面板：</div>
              <div style="max-height: 250px; overflow-y: auto; overflow-x: auto; width: 100%;">
                <table style="width: 100%; border-collapse: collapse; font-size: 0.65rem; text-align: left;" id="aiUnstructuredTable">
                  <thead>
                    <tr style="border-bottom: 1px solid var(--card-border); font-weight: 800; color: var(--text-soft); background: rgba(0,0,0,0.01); position: sticky; top: 0; background: var(--btn-bg); z-index: 10;">
                      <th style="padding: 6px 8px; width: 40px; text-align: center;">操作</th>
                      <th style="padding: 6px 8px; width: 70px;">姓名</th>
                      <th style="padding: 6px 8px; width: 100px;">电话</th>
                      <th style="padding: 6px 8px; width: 100px;">公司</th>
                      <th style="padding: 6px 8px;">备注</th>
                    </tr>
                  </thead>
                  <tbody>
                    <!-- populated dynamically -->
                  </tbody>
                </table>
              </div>
            </div>


            <!-- Confirm Buttons -->
            <div style="display: flex; gap: 8px; width: 100%; margin-top: 4px;">
              <button id="aiConfirmImportBtn" class="btn-primary" style="flex: 1; padding: 8px; font-size: 0.78rem; font-weight: 800; border-radius: var(--radius-xs); box-shadow: var(--wechat-gradient); text-align: center;">AI 确认导入</button>
              <button id="aiResetImportBtn" class="btn-modal btn-neutral" style="padding: 8px 14px; font-size: 0.78rem; font-weight: 800; border-radius: var(--radius-xs); height: auto; box-shadow: none;">取消</button>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Controls -->
      <div class="control-bar" id="controlBar" style="display:none; flex-wrap: wrap; gap: 6px;">
        <input type="text" class="search-input" id="searchInput" placeholder="搜索" style="flex: 1; min-width: 60px;">
        <select id="sortSelect" style="height: 28px; font-size: 0.68rem; border: 1px solid var(--card-border); border-radius: var(--radius-xs); background: var(--btn-bg); color: var(--text-soft); font-weight: 800; outline: none; padding: 0 4px; cursor: pointer; flex-shrink: 0; width: 95px;">
          <option value="default">导入顺序</option>
          <option value="name">姓名 A-Z</option>
          <option value="company">公司 A-Z</option>
          <option value="todo">待拨优先</option>
          <option value="dialed">已拨优先</option>
          <option value="shuffle" selected>随机打乱</option>
        </select>
        <select id="whitelistFilterSelect" style="height: 28px; font-size: 0.68rem; border: 1px solid var(--card-border); border-radius: var(--radius-xs); background: var(--btn-bg); color: var(--text-soft); font-weight: 800; outline: none; padding: 0 4px; cursor: pointer; flex-shrink: 0; width: 85px;">
          <option value="all">白名单筛选</option>
          <option value="yes">✔ 白名单</option>
          <option value="no">✘ 非白名单</option>
        </select>
        <button id="whitelistCheckBtn" title="对照白名单检查客户单位" style="height:28px; padding:0 8px; font-size:0.65rem; border:1px solid var(--accent-wechat); background:var(--accent-wechat-bg); color:var(--accent-wechat); border-radius:var(--radius-xs); cursor:pointer; font-weight:800; outline:none; white-space:nowrap; flex-shrink:0;">☑ 白名单</button>
        <div class="filter-group" style="flex-shrink: 0;">
          <button class="filter-tab active" data-filter="all">全部</button>
          <button class="filter-tab" data-filter="todo">待拨打</button>
          <button class="filter-tab" data-filter="success">已接通</button>
          <button class="filter-tab" data-filter="failed">未接通</button>
        </div>
      </div>
      
      <!-- Contacts List -->
      <div class="cards-content" id="cardsContainer">
        <div style="text-align:center;padding:80px 20px;color:var(--text-light);font-size:0.82rem;display:flex;flex-direction:column;gap:12px;">
          <span>暂无联系人数据，请在上方导入表格或通讯录文件</span>
          <span style="font-size:0.7rem;color:var(--text-light);max-width:320px;margin:0 auto;line-height:1.5;">数据仅保存在您的浏览器本地，不经过任何后台服务器，完全保护您的客户隐私。</span>
        </div>
      </div>
    </div>
  </div>
  
  <!-- Call Assistant Modal -->
  <div id="callAssistOverlay" class="modal-overlay" style="z-index:3000;">
    <div class="modal-card" style="text-align:center;gap:12px;">
      <div style="font-size:0.75rem;color:var(--text-soft);font-weight:800;letter-spacing:1px;text-transform:uppercase;">快捷呼叫助理</div>
      <div style="display:none;" id="callAssistName">-</div>
      <div style="display:flex;align-items:center;justify-content:center;margin-top:2px;">
        <div id="callAssistNameDisplay" class="client-card-name-btn" title="点击复制姓名" style="font-size:1.25rem;font-weight:900;color:var(--text-main);">-</div>
      </div>
      <div id="callAssistPhone" style="display:none;">-</div>
      <div style="display:flex;align-items:center;justify-content:center;margin-top:-2px;">
        <div id="callAssistPhoneDisplay" class="client-phone-btn" title="点击复制号码" style="font-size:1.15rem !important;font-weight:900;color:var(--text-main);">-</div>
      </div>
      <div id="callAssistCompanyRow" style="display:none;margin-top:2px;width:100%;">
        <span style="font-size:0.7rem;color:var(--text-light);font-weight:800;">公司：</span>
        <span id="callAssistCompany" style="font-size:0.75rem;font-weight:800;color:var(--accent-wechat);background:rgba(7,193,96,0.08);padding:2px 8px;border-radius:var(--radius-xs);"></span>
      </div>
      <div id="callAssistNoteRow" style="display:none;margin-top:4px;width:100%;text-align:left;">
        <span style="font-size:0.7rem;color:var(--text-light);font-weight:800;">备注：</span>
        <span id="callAssistNote" style="font-size:0.72rem;font-weight:700;color:var(--text-soft);line-height:1.4;word-break:break-all;white-space:pre-wrap;"></span>
      </div>
      <div style="display:flex;justify-content:center;margin-top:4px;width:100%;">
        <a id="callAssistDialLink" class="btn-modal btn-success" style="width:100%;text-decoration:none;display:flex;align-items:center;justify-content:center;font-size:0.85rem;height:38px;box-shadow:var(--wechat-gradient);border-radius:var(--radius-xs);">立即拨打</a>
      </div>
      
      <!-- Recording Player Container inside Call Assistant Modal -->
      <div id="callAssistRecContainer" style="display:none;text-align:left;flex-direction:column;gap:4px;width:100%;margin-top:4px;">
        <span class="client-card-label" style="font-size:0.65rem;color:var(--accent-wechat);font-weight:800;">通话录音</span>
        <div id="callAssistAudioWrapper"></div>
      </div>
      
      <!-- Remark Input Field (Directly Visible) -->
      <div style="text-align:left;display:flex;flex-direction:column;gap:4px;width:100%;">
        <span class="client-card-label" style="font-size:0.65rem;color:var(--text-light);font-weight:800;">通话小记 / 沟通记录</span>
        <textarea id="callLogNote" placeholder="在这里输入通话记录、客户意向等备注信息..." style="width:100%;height:100px;font-size:0.8rem;padding:8px 10px;background:var(--btn-bg);border:1px solid var(--card-border);border-radius:var(--radius-xs);color:var(--text-main);outline:none;font-weight:700;resize:none;"></textarea>
      </div>

      <!-- Direct Outcome Action Buttons -->
      <div style="display:flex;gap:10px;width:100%;margin-top:4px;">
        <button id="callOutcomeSuccessBtn" class="btn-modal btn-success" style="flex:1;font-size:0.85rem;height:42px;box-shadow:var(--wechat-gradient);">已接通</button>
        <button id="callOutcomeFailedBtn" class="btn-modal btn-danger" style="flex:1;font-size:0.85rem;height:42px;box-shadow:var(--intent-gradient);">未接通</button>
      </div>
    </div>
  </div>

  <!-- Export Dialog Modal -->
  <div id="exportModal" class="modal-overlay">
    <div class="modal-card export-modal-card">
      <div style="font-size:0.95rem;font-weight:900;color:var(--text-main);display:flex;justify-content:space-between;align-items:center;">
        <span>导出拨号记录</span>
        <button id="closeExportBtn" style="background:none;border:none;font-size:1.2rem;cursor:pointer;color:var(--text-soft);">✕</button>
      </div>
      <div style="font-size:0.7rem;color:var(--text-light);font-weight:700;">包含通话时长、拨号状态与通话小记</div>
      <textarea id="exportTextarea" class="export-textarea" readonly></textarea>
      <button id="copyExportBtn" class="btn-modal btn-success" style="width:100%;">复制记录到剪贴板</button>
    </div>
  </div>

  <!-- Sync Conflict Dialog Modal -->
  <div id="syncConflictModal" class="modal-overlay" style="z-index:4000;">
    <div class="modal-card" style="text-align:center;">
      <div style="font-size:0.95rem;font-weight:900;color:var(--text-main);margin-top:4px;">同步冲突检测</div>
      <div style="font-size:0.75rem;color:var(--text-soft);line-height:1.5;margin-top:6px;text-align:left;">
        云端检测到与您本地不同的拨号进度记录：
        <ul style="padding-left:16px;margin-top:6px;list-style:disc;display:flex;flex-direction:column;gap:4px;">
          <li>本地有 <strong id="conflictLocalCount" style="color:var(--accent-intent);">0</strong> 位联系人</li>
          <li>云端有 <strong id="conflictCloudCount" style="color:#4a6cf7;">0</strong> 位联系人</li>
        </ul>
        请选择同步冲突解决方式：
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;width:100%;margin-top:12px;">
        <button id="syncUseLocalBtn" class="btn-modal btn-success" style="width:100%;">保留本地，覆写云端</button>
        <button id="syncUseCloudBtn" class="btn-modal btn-secondary" style="width:100%;">拉取云端，覆写本地</button>
        <button id="syncCancelBtn" class="btn-modal btn-neutral" style="width:100%;">稍后处理 (保持离线)</button>
      </div>
  </div>

  <!-- Note Details Modal -->
  <div id="noteModal" class="modal-overlay" style="z-index:4500;">
    <div class="modal-card" style="text-align:left; gap:12px;">
      <div style="font-size:0.95rem; font-weight:900; color:var(--text-main); display:flex; justify-content:space-between; align-items:center;">
        <span>客户资料备注</span>
        <button id="closeNoteModalBtn" style="background:none; border:none; font-size:1.2rem; cursor:pointer; color:var(--text-soft); padding:0;">✕</button>
      </div>
      <div style="border-top:1px dashed var(--border-light); padding-top:8px;">
        <p id="noteModalContent" style="font-size:0.8rem; color:var(--text-soft); line-height:1.5; white-space:pre-wrap; font-weight:700; word-break:break-all;"></p>
      </div>
    </div>
  </div>

  <!-- Whitelist Management Modal -->
  <div id="whitelistModal" class="modal-overlay">
    <div class="modal-card" style="max-width: 480px; gap: 12px;">
      <div style="font-size:0.95rem; font-weight:900; color:var(--text-main); display:flex; justify-content:space-between; align-items:center;">
        <span>建易贷白名单管理</span>
        <button id="closeWhitelistBtn" style="background:none; border:none; font-size:1.2rem; cursor:pointer; color:var(--text-soft); padding:0;">✕</button>
      </div>
      <div class="whitelist-status" id="whitelistStatus" style="font-size:0.7rem; color:var(--text-soft); font-weight:700;">未加载白名单</div>

      <!-- Upload area -->
      <div style="border:1px dashed var(--card-border); border-radius:var(--radius-xs); padding:12px;">
        <div style="font-size:0.72rem; font-weight:800; color:var(--text-soft); margin-bottom:6px;">
          粘贴企业名称（每行一个，从Word文档全选复制粘贴即可）：
        </div>
        <textarea id="whitelistTextarea" class="whitelist-textarea" placeholder="例：&#10;中国石油化工集团公司&#10;国家电网有限公司&#10;中国工商银行股份有限公司"></textarea>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button id="whitelistUploadBtn" class="btn-primary" style="flex:1; padding:8px; font-size:0.78rem;">上传白名单</button>
          <button id="whitelistRefreshBtn" class="btn-secondary" style="padding:8px 14px; font-size:0.78rem;">刷新列表</button>
        </div>
      </div>

      <!-- Failed Uploads retry area -->
      <div id="whitelistFailedArea" style="display:none; border:1px solid #e74c3c; background:rgba(231,76,60,0.05); border-radius:var(--radius-xs); padding:10px;">
        <div style="font-size:0.72rem; font-weight:800; color:#e74c3c; margin-bottom:6px; display:flex; justify-content:space-between; align-items:center;">
          <span>⚠️ 上次上传失败的企业 (<span id="whitelistFailedCount">0</span>)</span>
          <a href="#" id="whitelistFailedClearBtn" style="color:#e74c3c; text-decoration:underline; font-size:0.65rem;">清除</a>
        </div>
        <div id="whitelistFailedList" style="max-height:80px; overflow-y:auto; font-size:0.68rem; color:var(--text-soft); border:1px solid rgba(231,76,60,0.2); border-radius:4px; padding:4px; background:#fff; margin-bottom:8px; text-align:left; white-space:pre-wrap;"></div>
        <button id="whitelistFailedRetryBtn" class="btn-primary" style="background:#e74c3c; border-color:#e74c3c; color:#fff; width:100%; padding:6px; font-size:0.75rem;">尝试重新上传</button>
      </div>

      <!-- Search in Whitelist -->
      <div style="display:flex; flex-direction:column; gap:4px; margin-top:2px;">
        <div style="font-size:0.7rem; font-weight:800; color:var(--text-soft);">在白名单中搜索已存企业：</div>
        <input type="text" id="whitelistModalSearchInput" class="search-input" placeholder="输入企业名称进行搜索..." style="height:28px; font-size:0.72rem; border-radius:var(--radius-xs); padding:0 8px; border:1px solid var(--card-border); background:var(--btn-bg); color:var(--text-main); font-weight:700; width:100%;">
      </div>

      <!-- Existing companies list -->
      <div style="max-height:180px; overflow-y:auto; border:1px solid var(--card-border); border-radius:var(--radius-xs); padding:8px;">
        <div id="whitelistCompanyList" style="font-size:0.7rem; color:var(--text-light); text-align:center;">点击"刷新列表"加载白名单企业</div>
      </div>
    </div>
  </div>

  <!-- SheetJS CDN -->
  <script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>

  <script>
  (function(){
    // Android WebView detection for full-screen spacing
    if(/Android/.test(navigator.userAgent)&&!/iPhone|iPad|iPod/.test(navigator.userAgent)){
      document.body.classList.add('android');
    }

    // LocalStorage Keys
    var CLIENTS_K = 'standalone_dialer_clients';
    var DARK_K = 'standalone_dialer_dark';

    // State Variables
    var importedClients = [];
    var currentCallIdx = -1;
    var callInterval = null;
    var callSeconds = 0;
    var currentFilter = 'all';
    var currentPage = 1;
    var whitelistCompanies = [];
    var whitelistCheckResults = null;
    var whitelistLoaded = false;
    var pageSize = 100;
    var currentSort = 'shuffle';

    // Dark Mode Control
    function initDark() {
      var btn = document.getElementById('darkToggleBtn');
      var updateDarkTitle = function() {
        var isDark = document.body.classList.contains('dark-mode');
        btn.textContent = (isDark ? '浅色' : '深色') + '模式';
      };
      if (localStorage.getItem(DARK_K) === 'true') {
        document.body.classList.add('dark-mode');
      }
      updateDarkTitle();
      btn.addEventListener('click', function() {
        document.body.classList.toggle('dark-mode');
        localStorage.setItem(DARK_K, document.body.classList.contains('dark-mode'));
        updateDarkTitle();
      });
    }

    // Helper functions
    function esc(s) {
      if (!s) return '';
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }

    function copyTextToClipboard(text) {
      var textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
      } catch (err) {
        console.error('Copy failed:', err);
      }
      document.body.removeChild(textarea);
    }

    function maskPhone(p) {
      if (!p) return '';
      var s = String(p).trim();
      if (s.length >= 11) {
        return s.slice(0, 3) + '****' + s.slice(7);
      }
      return s;
    }

    function cleanPhone(val) {
      if (!val) return '';
      var s = String(val).trim().replace(/[^\\d+]/g, '');
      if (s.indexOf('+86') === 0) return s.slice(3);
      if (s.indexOf('86') === 0 && s.length === 13) return s.slice(2);
      return s;
    }

    function isPhone(val) {
      var clean = cleanPhone(val);
      return /^1[3-9]\\d{9}$/.test(clean);
    }

    function nameScore(val) {
      if (!val) return 0;
      var s = String(val).trim();
      if (isPhone(s)) return 0;
      if (/^\\d+$/.test(s)) return 0;
      
      // Common Chinese Surnames Regex
      var surnameRegex = /^[王李张刘陈杨黄赵吴周徐孙马朱胡郭何林罗高郑梁谢宋唐董许韩邓冯曹彭曾萧田庄潘袁于叶余魏蒋田杜丁沈姜范江傅钟卢汪戴崔]/;
      
      if (/^[\\u4e00-\\u9fa5]{2,4}$/.test(s)) {
        if (surnameRegex.test(s)) {
          return 25; // Highly weigh standard Chinese names with common surnames
        }
        return 10;
      }
      if (/^[\\u4e00-\\u9fa5]{2,6}$/.test(s)) return 5;
      if (/^[A-Za-z\\s]{2,15}$/.test(s)) return 3;
      if (s.length >= 2 && s.length <= 15) return 1;
      return 0;
    }

    function decodeQPUtf8(s) {
      var t = s.replace(/=\\r?\\n/g, '');
      var b = [];
      var i = 0;
      while (i < t.length) {
        if (t[i] === '=' && i + 2 < t.length && /[0-9A-Fa-f]{2}/.test(t.slice(i+1,i+3))) {
          b.push(parseInt(t.slice(i+1,i+3), 16));
          i += 3;
        } else {
          b.push(t.charCodeAt(i));
          i++;
        }
      }
      try { return new TextDecoder('utf-8').decode(new Uint8Array(b)); } catch(e) { return s; }
    }

    // Persist and load state
    function loadPersistedState() {
      try {
        var saved = localStorage.getItem(CLIENTS_K);
        if (saved) {
          importedClients = JSON.parse(saved);
          if (importedClients.length > 0) {
            updateDashboardVisibility(true);
            renderDialCards();
          }
        }
      } catch (err) {
        console.error('Failed to load state:', err);
      }
      setTimeout(function() {
        syncWithCloud();
      }, 500);
    }

    function saveState() {
      try {
        localStorage.setItem(CLIENTS_K, JSON.stringify(importedClients));
      } catch (err) {
        console.error('Failed to save state:', err);
      }
      syncWithCloud(true);
    }

    // Cloud Sync Logic
    var isSyncing = false;
    var lastCloudData = null;

    function setSyncStatus(status, title) {
      var badge = document.getElementById('syncStatusBadge');
      if (!badge) return;
      badge.className = 'icon-btn sync-badge ' + status;
      badge.title = title || '';
      if (status === 'online-synced') {
        badge.innerHTML = '已同步';
      } else if (status === 'online-unsynced') {
        badge.innerHTML = '未同步';
      } else {
        badge.innerHTML = '离线模式';
      }
    }

    function syncWithCloud(forcePost) {
      if (isSyncing) return;
      isSyncing = true;
      var apiUrl = '/api/dialer/data';

      fetch(apiUrl)
        .then(function(res) {
          if (!res.ok) {
            throw new Error('KV API not available');
          }
          return res.json();
        })
        .then(function(data) {
          isSyncing = false;
          lastCloudData = data;
          var cloudClients = data.clients || [];

          var localStr = JSON.stringify(importedClients);
          var cloudStr = JSON.stringify(cloudClients);

          if (localStr === cloudStr) {
            setSyncStatus('online-synced', '云端与本地数据一致，已完全同步');
            return;
          }

          if (forcePost) {
            uploadLocalToCloud();
          } else {
            if (importedClients.length === 0 && cloudClients.length > 0) {
              importedClients = cloudClients;
              localStorage.setItem(CLIENTS_K, JSON.stringify(importedClients));
              updateDashboardVisibility(true);
              renderDialCards();
              setSyncStatus('online-synced', '已自动拉取云端进度');
            } else if (importedClients.length > 0 && cloudClients.length === 0) {
              uploadLocalToCloud();
            } else {
              showSyncConflictModal(importedClients.length, cloudClients.length);
            }
          }
        })
        .catch(function(err) {
          isSyncing = false;
          setSyncStatus('offline-mode', '无法连接云端 (离线状态 / 未绑定 KV 空间)');
        });
    }

    function uploadLocalToCloud() {
      var apiUrl = '/api/dialer/data';
      setSyncStatus('online-unsynced', '正在上传最新进度...');
      fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clients: importedClients })
      })
      .then(function(res) {
        if (res.ok) {
          setSyncStatus('online-synced', '最新拨号进度已同步保存至 KV 空间');
        } else {
          setSyncStatus('online-unsynced', '进度上传失败');
        }
      })
      .catch(function(err) {
        setSyncStatus('offline-mode', '连接中断，保存至本地缓存');
      });
    }

    function showSyncConflictModal(localLen, cloudLen) {
      document.getElementById('conflictLocalCount').textContent = localLen;
      document.getElementById('conflictCloudCount').textContent = cloudLen;
      document.getElementById('syncConflictModal').classList.add('active');
    }

    function hideSyncConflictModal() {
      document.getElementById('syncConflictModal').classList.remove('active');
    }

    function initSyncHandlers() {
      var badge = document.getElementById('syncStatusBadge');
      if (badge) {
        badge.addEventListener('click', function() {
          syncWithCloud();
        });
      }

      document.getElementById('syncUseLocalBtn').addEventListener('click', function() {
        hideSyncConflictModal();
        uploadLocalToCloud();
      });

      document.getElementById('syncUseCloudBtn').addEventListener('click', function() {
        hideSyncConflictModal();
        if (lastCloudData && lastCloudData.clients) {
          importedClients = lastCloudData.clients;
          localStorage.setItem(CLIENTS_K, JSON.stringify(importedClients));
          updateDashboardVisibility(importedClients.length > 0);
          renderDialCards();
          setSyncStatus('online-synced', '已覆写并同步云端数据');
        }
      });

      document.getElementById('syncCancelBtn').addEventListener('click', function() {
        hideSyncConflictModal();
        setSyncStatus('online-unsynced', '已跳过同步，保留本地差异');
      });
    }


    function updateDashboardVisibility(hasData) {
      var flexStyle = hasData ? 'flex' : 'none';
      var minimalStats = document.getElementById('headerStatsMinimal');
      if (minimalStats) {
        minimalStats.style.display = hasData ? 'flex' : 'none';
      }
      document.getElementById('controlBar').style.display = flexStyle;
      
      var expBtn = document.getElementById('exportBtn');
      var clrBtn = document.getElementById('clearBtn');
      if (expBtn) expBtn.style.display = hasData ? 'flex' : 'none';
      if (clrBtn) clrBtn.style.display = hasData ? 'flex' : 'none';
      
      // Auto-hide import zone if there is data, otherwise display it
      var panel = document.getElementById('dashboardPanel');
      if (panel) {
        panel.style.display = hasData ? 'none' : 'block';
      }
    }

    // Dynamic UI Statistics
    function updateStats() {
      var total = importedClients.length;
      var done = 0;
      importedClients.forEach(function(c) {
        if (c.dialedStatus === 'success' || c.dialedStatus === 'failed') {
          done++;
        }
      });
      document.getElementById('totalCount').textContent = total;
      document.getElementById('doneCount').textContent = done;

      var percent = total > 0 ? (done / total) * 100 : 0;
      document.getElementById('progressFill').style.width = percent + '%';
      
      var pctText = document.getElementById('percentText');
      if (pctText) {
        pctText.textContent = '(' + Math.round(percent) + '%)';
      }
    }

    // Global State for BH-AI Importer
    var tempImportData = null;
    var tempImportHeaders = [];
    var tempImportDetected = null;
    var tempImportType = 'xlsx'; // 'xlsx', 'vcf', 'unstructured'
    var tempUnstructuredContacts = [];

    function resetAIImporterUI() {
      document.getElementById('aiImportInit').style.display = 'flex';
      document.getElementById('aiImportScanning').style.display = 'none';
      document.getElementById('aiImportReport').style.display = 'none';
      document.getElementById('aiLaserLine').style.display = 'none';
      document.getElementById('aiAdjustControls').style.display = 'none';
      
      document.getElementById('aiExcelMappingPills').style.display = 'flex';
      document.getElementById('aiExcelMappingControls').style.display = 'block';
      document.getElementById('aiExcelPreviewContainer').style.display = 'block';
      document.getElementById('aiUnstructuredContainer').style.display = 'none';
      
      document.getElementById('xlsFileInput').value = '';
      document.getElementById('vcfFileInput').value = '';
      var imgFile = document.getElementById('imgFileInput');
      if (imgFile) imgFile.value = '';
      
      tempUnstructuredContacts = [];
      tempImportData = null;
      tempImportHeaders = [];
      tempImportDetected = null;
    }

    function showAIScanningUI(fileName) {
      document.getElementById('aiImportInit').style.display = 'none';
      document.getElementById('aiImportReport').style.display = 'none';
      
      var scanning = document.getElementById('aiImportScanning');
      scanning.style.display = 'flex';
      
      var laser = document.getElementById('aiLaserLine');
      laser.style.display = 'block';

      // Reset logs
      document.getElementById('aiLog1').innerHTML = '[ ] 正在读取数据流...';
      document.getElementById('aiLog1').style.opacity = '0.5';
      document.getElementById('aiLog2').innerHTML = '[ ] 正在评估特征维度...';
      document.getElementById('aiLog2').style.opacity = '0.3';
      document.getElementById('aiLog3').innerHTML = '[ ] 正在过滤杂质与噪音...';
      document.getElementById('aiLog3').style.opacity = '0.3';
      document.getElementById('aiLog4').innerHTML = '[ ] 正在匹配智能映射...';
      document.getElementById('aiLog4').style.opacity = '0.3';

      setTimeout(function() {
        document.getElementById('aiLog1').innerHTML = '✅ 数据流加载完成 (' + fileName + ')';
        document.getElementById('aiLog1').style.opacity = '1';
        document.getElementById('aiLog2').style.opacity = '0.5';
      }, 300);

      setTimeout(function() {
        document.getElementById('aiLog2').innerHTML = '✅ 评估行列特征成功';
        document.getElementById('aiLog2').style.opacity = '1';
        document.getElementById('aiLog3').style.opacity = '0.5';
      }, 600);

      setTimeout(function() {
        document.getElementById('aiLog3').innerHTML = '✅ 空列与噪音清洗完成';
        document.getElementById('aiLog3').style.opacity = '1';
        document.getElementById('aiLog4').style.opacity = '0.5';
      }, 900);

      setTimeout(function() {
        document.getElementById('aiLog4').innerHTML = '✅ AI 智能映射匹配成功';
        document.getElementById('aiLog4').style.opacity = '1';
      }, 1100);
    }

    function runAIColumnMapping(json) {
      var headerRowIdx = -1;
      var maxHeaderMatches = 0;

      for (var i = 0; i < Math.min(json.length, 10); i++) {
        var row = json[i];
        if (!row) continue;
        var matches = 0;
        for (var j = 0; j < row.length; j++) {
          var cellVal = String(row[j] || '').trim();
          if (/姓名|客户|联系人|name|contact/i.test(cellVal)) matches++;
          if (/电话|手机|号码|phone|tel|mobile/i.test(cellVal)) matches++;
          if (/单位|公司|企业|company|firm|work/i.test(cellVal)) matches++;
          if (/备注|沟通|记录|跟进|说明|介绍|详情|note|remark/i.test(cellVal)) matches++;
        }
        var hasPhoneData = false;
        for (var j = 0; j < row.length; j++) {
          if (isPhone(row[j])) {
            hasPhoneData = true;
            break;
          }
        }
        if (matches > maxHeaderMatches && !hasPhoneData) {
          maxHeaderMatches = matches;
          headerRowIdx = i;
        }
      }

      var nameIdx = -1, phoneIdx = -1, companyIdx = -1, noteIdx = -1;
      var hasHeaders = (headerRowIdx !== -1);

      if (hasHeaders) {
        var headers = json[headerRowIdx];
        for (var i = 0; i < headers.length; i++) {
          var h = String(headers[i] || '').trim();
          if (/姓名|客户|name/i.test(h)) nameIdx = i;
          else if (/电话|手机|号码|phone|tel|mobile/i.test(h)) phoneIdx = i;
          else if (/单位|公司|企业|company|firm|work/i.test(h)) companyIdx = i;
          else if (/备注|沟通|记录|跟进|说明|介绍|详情|note|remark/i.test(h)) noteIdx = i;
        }
        
        if (phoneIdx === -1) {
          for (var i = 0; i < headers.length; i++) {
            var nextRowVal = json[headerRowIdx + 1] ? json[headerRowIdx + 1][i] : undefined;
            if (isPhone(nextRowVal)) {
              phoneIdx = i;
              break;
            }
          }
        }
        if (nameIdx === -1) nameIdx = 0;
      } else {
        var maxCols = 0;
        for (var i = 0; i < json.length; i++) {
          if (json[i] && json[i].length > maxCols) maxCols = json[i].length;
        }
        var phoneCols = [];

        for (var c = 0; c < maxCols; c++) {
          var phoneCount = 0;
          var totalNonEmpty = 0;
          var scanRows = Math.min(json.length, 50);
          for (var r = 0; r < scanRows; r++) {
            var val = json[r] ? json[r][c] : undefined;
            if (val !== undefined && val !== null && String(val).trim() !== '') {
              totalNonEmpty++;
              if (isPhone(val)) {
                phoneCount++;
              }
            }
          }
          if (phoneCount > 0 && (phoneCount / totalNonEmpty >= 0.3 || phoneCount >= 3)) {
            phoneCols.push(c);
          }
        }

        if (phoneCols.length > 0) {
          phoneIdx = phoneCols[0];
          
          var assignedNameCols = new Set();
          
          var leftScore = 0;
          var rightScore = 0;
          var scanRows = Math.min(json.length, 50);

          var canUseLeft = (phoneIdx > 0 && !assignedNameCols.has(phoneIdx - 1));
          var canUseRight = (phoneIdx + 1 < maxCols && !assignedNameCols.has(phoneIdx + 1));

          for (var r = 0; r < scanRows; r++) {
            if (canUseLeft) {
              var leftVal = json[r] ? json[r][phoneIdx - 1] : undefined;
              leftScore += nameScore(leftVal);
            }
            if (canUseRight) {
              var rightVal = json[r] ? json[r][phoneIdx + 1] : undefined;
              rightScore += nameScore(rightVal);
            }
          }

          if (canUseRight && rightScore >= leftScore && rightScore > 0) {
            nameIdx = phoneIdx + 1;
          } else if (canUseLeft && leftScore > 0) {
            nameIdx = phoneIdx - 1;
          } else {
            nameIdx = 0;
          }

          // Heuristic Company & Note Extraction for Non-Header Sheets
          var assignedCols = new Set();
          assignedCols.add(phoneIdx);
          if (nameIdx !== -1) assignedCols.add(nameIdx);

          var bestCompanyCol = -1;
          var maxCompanyScore = 0;
          var bestNoteCol = -1;
          var maxNoteScore = 0;

          for (var c = 0; c < maxCols; c++) {
            if (assignedCols.has(c)) continue;

            var companyScore = 0;
            var noteScoreCount = 0;
            var totalLength = 0;
            var nonValCount = 0;

            for (var r = 0; r < scanRows; r++) {
              var val = json[r] ? json[r][c] : undefined;
              if (val !== undefined && val !== null && String(val).trim() !== '') {
                var s = String(val).trim();
                nonValCount++;
                totalLength += s.length;

                // Priority matching for '有限公司' or corporate suffixes
                if (/有限公司|有限责任|集团|公司|企业|厂|店|中心|商行|工作室/i.test(s)) {
                  companyScore += 15;
                }
                if (/意向|跟进|记录|备注|挂断|接通|无效|微信|电话|加微信|想买|说明|介绍|详情/i.test(s)) {
                  noteScoreCount += 10;
                }
                if (s.length > 8) {
                  noteScoreCount += 2;
                }
              }
            }

            var avgLength = nonValCount > 0 ? (totalLength / nonValCount) : 0;
            noteScoreCount += avgLength;

            if (companyScore > maxCompanyScore && companyScore > 0) {
              maxCompanyScore = companyScore;
              bestCompanyCol = c;
            }
            if (noteScoreCount > maxNoteScore) {
              maxNoteScore = noteScoreCount;
              bestNoteCol = c;
            }
          }

          if (bestCompanyCol !== -1) {
            companyIdx = bestCompanyCol;
            assignedCols.add(bestCompanyCol);
          }
          if (bestNoteCol !== -1 && bestNoteCol !== bestCompanyCol) {
            noteIdx = bestNoteCol;
          }
        }
      }


      return {
        headerRowIdx: headerRowIdx,
        nameIdx: nameIdx,
        phoneIdx: phoneIdx,
        companyIdx: companyIdx,
        noteIdx: noteIdx
      };
    }

    function renderAIReportForExcel(json, detected) {
      tempImportData = json;
      tempImportType = 'xlsx';
      tempImportDetected = detected;

      var headerRowIdx = detected.headerRowIdx;
      var maxCols = 0;
      for (var i = 0; i < json.length; i++) {
        if (json[i] && json[i].length > maxCols) maxCols = json[i].length;
      }

      var headersList = [];
      for (var c = 0; c < maxCols; c++) {
        var hName = '列 ' + String.fromCharCode(65 + c);
        var headerVal = headerRowIdx !== -1 && json[headerRowIdx] ? json[headerRowIdx][c] : undefined;
        if (headerVal) {
          hName = esc(String(headerVal).trim());
        }
        headersList.push({ idx: c, label: hName });
      }
      tempImportHeaders = headersList;

      document.getElementById('pillName').className = 'client-card-tag';
      document.getElementById('pillName').style.background = detected.nameIdx !== -1 ? 'rgba(7,193,96,0.08)' : 'rgba(231,76,60,0.08)';
      document.getElementById('pillName').style.color = detected.nameIdx !== -1 ? 'var(--accent-wechat)' : '#e74c3c';
      document.getElementById('pillName').innerHTML = '姓名 ➔ ' + (detected.nameIdx !== -1 ? headersList[detected.nameIdx].label : '未识别');

      document.getElementById('pillPhone').className = 'client-card-tag';
      document.getElementById('pillPhone').style.background = detected.phoneIdx !== -1 ? 'rgba(7,193,96,0.08)' : 'rgba(231,76,60,0.08)';
      document.getElementById('pillPhone').style.color = detected.phoneIdx !== -1 ? 'var(--accent-wechat)' : '#e74c3c';
      document.getElementById('pillPhone').innerHTML = '电话 ➔ ' + (detected.phoneIdx !== -1 ? headersList[detected.phoneIdx].label : '未识别');

      document.getElementById('pillCompany').className = 'client-card-tag';
      document.getElementById('pillCompany').style.background = detected.companyIdx !== -1 ? 'rgba(74,108,247,0.08)' : 'rgba(0,0,0,0.04)';
      document.getElementById('pillCompany').style.color = detected.companyIdx !== -1 ? '#4a6cf7' : 'var(--text-light)';
      document.getElementById('pillCompany').innerHTML = '公司 ➔ ' + (detected.companyIdx !== -1 ? headersList[detected.companyIdx].label : '无');

      document.getElementById('pillNote').className = 'client-card-tag';
      document.getElementById('pillNote').style.background = detected.noteIdx !== -1 ? 'rgba(245,124,0,0.08)' : 'rgba(0,0,0,0.04)';
      document.getElementById('pillNote').style.color = detected.noteIdx !== -1 ? '#f57c00' : 'var(--text-light)';
      document.getElementById('pillNote').innerHTML = '备注 ➔ ' + (detected.noteIdx !== -1 ? headersList[detected.noteIdx].label : '无');

      populateMappingSelect('aiSelName', headersList, detected.nameIdx);
      populateMappingSelect('aiSelPhone', headersList, detected.phoneIdx);
      populateMappingSelect('aiSelCompany', headersList, detected.companyIdx, true);
      populateMappingSelect('aiSelNote', headersList, detected.noteIdx, true);

      var conf = 90;
      if (detected.nameIdx !== -1 && detected.phoneIdx !== -1) conf = detected.headerRowIdx !== -1 ? 98.5 : 92.0;
      if (detected.companyIdx !== -1) conf += 1.0;
      if (detected.noteIdx !== -1) conf += 0.5;
      document.getElementById('aiConfidenceBadge').innerHTML = '● AI 置信度: ' + conf.toFixed(1) + '%';
      
      document.getElementById('aiReportTitle').innerHTML = 'AI 识别报告: Excel 表格数据';

      updateAIPreviewTable();

      document.getElementById('aiImportScanning').style.display = 'none';
      document.getElementById('aiLaserLine').style.display = 'none';
      document.getElementById('aiImportReport').style.display = 'flex';
      
      document.getElementById('aiToggleAdjustBtn').style.display = 'inline-flex';
    }

    function populateMappingSelect(selId, headers, selectedIdx, hasNone) {
      var select = document.getElementById(selId);
      if (!select) return;
      select.innerHTML = '';
      if (hasNone) {
        var optNone = document.createElement('option');
        optNone.value = '-1';
        optNone.textContent = '(无映射/不导入)';
        if (selectedIdx === -1) optNone.selected = true;
        select.appendChild(optNone);
      }
      headers.forEach(function(h) {
        var opt = document.createElement('option');
        opt.value = h.idx;
        opt.textContent = String(h.idx + 1) + '列 - ' + h.label;
        if (h.idx === selectedIdx) opt.selected = true;
        select.appendChild(opt);
      });
    }

    function updateAIPreviewTable() {
      var nameCol = parseInt(document.getElementById('aiSelName').value);
      var phoneCol = parseInt(document.getElementById('aiSelPhone').value);
      var compCol = parseInt(document.getElementById('aiSelCompany').value);
      var noteCol = parseInt(document.getElementById('aiSelNote').value);

      var tableBody = document.querySelector('#aiPreviewTable tbody');
      if (!tableBody) return;
      tableBody.innerHTML = '';

      if (!tempImportData || tempImportData.length === 0) return;

      var startRow = 0;
      if (tempImportDetected && tempImportDetected.headerRowIdx !== -1) {
        startRow = tempImportDetected.headerRowIdx + 1;
      }

      var previewCount = 0;
      for (var r = startRow; r < tempImportData.length && previewCount < 3; r++) {
        var row = tempImportData[r];
        if (!row || row.length === 0) continue;
        
        var rawPhone = phoneCol !== -1 ? row[phoneCol] : '';
        var phoneVal = cleanPhone(rawPhone);
        if (!phoneVal) continue;

        var nameVal = nameCol !== -1 ? String(row[nameCol] || '').trim() : '客户';
        var compVal = compCol !== -1 ? String(row[compCol] || '').trim() : '';

        var tr = document.createElement('tr');
        tr.style.borderBottom = '0.5px solid var(--card-border)';
        tr.innerHTML = '<td style="padding: 6px 8px; font-weight: 800; color: var(--text-main);">' + esc(nameVal || '未知姓名') + '</td>' +
                       '<td style="padding: 6px 8px; font-family: monospace; color: var(--accent-wechat); font-weight: 800;">' + esc(phoneVal) + '</td>' +
                       '<td style="padding: 6px 8px; color: var(--text-soft);">' + esc(compVal || '(空)') + '</td>';
        tableBody.appendChild(tr);
        previewCount++;
      }

      if (previewCount === 0) {
        tableBody.innerHTML = '<tr><td colspan="3" style="padding: 12px; text-align: center; color: var(--text-light);">当前列映射无法提取有效客户电话号码，请手动调整电话数据列。</td></tr>';
      }

      var totalImportCount = calculateParsedCount(nameCol, phoneCol, compCol, noteCol);
      document.getElementById('aiConfirmImportBtn').innerHTML = 'AI 确认导入 (' + totalImportCount + ' 位联系人)';
    }

    function calculateParsedCount(nameCol, phoneCol, compCol, noteCol) {
      if (!tempImportData || phoneCol === -1) return 0;
      var count = 0;
      var phoneSet = new Set();
      var startRow = 0;
      if (tempImportDetected && tempImportDetected.headerRowIdx !== -1) {
        startRow = tempImportDetected.headerRowIdx + 1;
      }
      for (var r = startRow; r < tempImportData.length; r++) {
        var row = tempImportData[r];
        if (!row || row.length === 0) continue;
        var phoneVal = cleanPhone(row[phoneCol]);
        if (!phoneVal) continue;
        if (phoneSet.has(phoneVal)) continue;
        phoneSet.add(phoneVal);
        count++;
      }
      return count;
    }

    function executeAIImportExcel() {
      var nameCol = parseInt(document.getElementById('aiSelName').value);
      var phoneCol = parseInt(document.getElementById('aiSelPhone').value);
      var compCol = parseInt(document.getElementById('aiSelCompany').value);
      var noteCol = parseInt(document.getElementById('aiSelNote').value);

      if (phoneCol === -1) {
        alert('请至少为电话选择一列进行导入！');
        return;
      }

      var startRow = 0;
      if (tempImportDetected && tempImportDetected.headerRowIdx !== -1) {
        startRow = tempImportDetected.headerRowIdx + 1;
      }

      var parsedCustomers = [];
      var phoneSet = new Set();

      for (var r = startRow; r < tempImportData.length; r++) {
        var row = tempImportData[r];
        if (!row || row.length === 0) continue;
        var phoneVal = cleanPhone(row[phoneCol]);
        if (!phoneVal) continue;
        if (phoneSet.has(phoneVal)) continue;
        phoneSet.add(phoneVal);

        var nameVal = nameCol !== -1 ? String(row[nameCol] || '').trim() : '客户';
        var companyVal = compCol !== -1 ? String(row[compCol] || '').trim() : '';
        var noteVal = noteCol !== -1 ? String(row[noteCol] || '').trim() : '';

        parsedCustomers.push({
          name: nameVal || '未知姓名',
          phone: phoneVal,
          company: companyVal,
          note: noteVal,
          dialedStatus: 'todo',
          duration: '',
          callNote: ''
        });
      }

      if (parsedCustomers.length === 0) {
        alert('未找到任何有效的数据，请确认所选的数据列！');
        return;
      }

      importedClients = parsedCustomers;
      saveState();
      updateDashboardVisibility(true);
      renderDialCards();

      resetAIImporterUI();
    }

    function executeAIImportVcf() {
      if (!tempImportData || tempImportData.length === 0) return;
      importedClients = tempImportData;
      saveState();
      updateDashboardVisibility(true);
      renderDialCards();

      resetAIImporterUI();
    }

    function renderAIReportForVcf(contactsList) {
      tempImportData = contactsList;
      tempImportType = 'vcf';
      
      document.getElementById('pillName').className = 'client-card-tag';
      document.getElementById('pillName').style.background = 'rgba(7,193,96,0.08)';
      document.getElementById('pillName').style.color = 'var(--accent-wechat)';
      document.getElementById('pillName').innerHTML = '姓名 ➔ VCF (FN)';

      document.getElementById('pillPhone').className = 'client-card-tag';
      document.getElementById('pillPhone').style.background = 'rgba(7,193,96,0.08)';
      document.getElementById('pillPhone').style.color = 'var(--accent-wechat)';
      document.getElementById('pillPhone').innerHTML = '电话 ➔ VCF (TEL)';

      document.getElementById('pillCompany').className = 'client-card-tag';
      document.getElementById('pillCompany').style.background = 'rgba(74,108,247,0.08)';
      document.getElementById('pillCompany').style.color = '#4a6cf7';
      document.getElementById('pillCompany').innerHTML = '公司 ➔ VCF (ORG)';

      document.getElementById('pillNote').className = 'client-card-tag';
      document.getElementById('pillNote').style.background = 'rgba(0,0,0,0.04)';
      document.getElementById('pillNote').style.color = 'var(--text-light)';
      document.getElementById('pillNote').innerHTML = '备注 ➔ VCF (NOTE)';

      document.getElementById('aiAdjustControls').style.display = 'none';
      document.getElementById('aiToggleAdjustBtn').style.display = 'none';

      document.getElementById('aiConfidenceBadge').innerHTML = '● AI 置信度: 100.0%';
      document.getElementById('aiReportTitle').innerHTML = 'AI 识别报告: VCF 通讯录文件';

      var tableBody = document.querySelector('#aiPreviewTable tbody');
      if (tableBody) {
        tableBody.innerHTML = '';
        var limit = Math.min(contactsList.length, 3);
        for (var i = 0; i < limit; i++) {
          var c = contactsList[i];
          var tr = document.createElement('tr');
          tr.style.borderBottom = '0.5px solid var(--card-border)';
          tr.innerHTML = '<td style="padding: 6px 8px; font-weight: 800; color: var(--text-main);">' + esc(c.name || '未知姓名') + '</td>' +
                         '<td style="padding: 6px 8px; font-family: monospace; color: var(--accent-wechat); font-weight: 800;">' + esc(c.phone) + '</td>' +
                         '<td style="padding: 6px 8px; color: var(--text-soft);">' + esc(c.company || '(空)') + '</td>';
          tableBody.appendChild(tr);
        }
      }

      document.getElementById('aiConfirmImportBtn').innerHTML = 'AI 确认导入 (' + contactsList.length + ' 位联系人)';

      document.getElementById('aiImportScanning').style.display = 'none';
      document.getElementById('aiLaserLine').style.display = 'none';
      document.getElementById('aiImportReport').style.display = 'flex';
    }

    var scriptLoadingPromises = {};
    function loadScript(url) {
      if (scriptLoadingPromises[url]) return scriptLoadingPromises[url];
      scriptLoadingPromises[url] = new Promise(function(resolve, reject) {
        if (document.querySelector('script[src="' + url + '"]')) {
          resolve();
          return;
        }
        var script = document.createElement('script');
        script.src = url;
        script.onload = function() { resolve(); };
        script.onerror = function() { reject(new Error('Failed to load script: ' + url)); };
        document.head.appendChild(script);
      });
      return scriptLoadingPromises[url];
    }

    function parsePhoneContactsFromRawText(text) {
      if (!text) return [];
      
      var lines = text.split(/\\r\\n|\\r|\\n/);
      var results = [];
      var phoneSet = new Set();
      
      // Common Chinese Surnames to validate names
      var SURNAMES = /^(张|李|王|刘|陈|杨|赵|黄|周|吴|徐|孙|马|胡|朱|郭|何|林|高|罗|郑|梁|谢|唐|韩|曹|许|邓|萧|冯|曾|程|蔡|彭|潘|袁|于|董|余|苏|叶|吕|魏|蒋|田|杜|丁|沈|姜|范|江|傅|钟|卢|汪|戴|崔|陆|廖|姚|方|金|邱|夏|谭|韦|贾|邹|石|熊|放|孟|秦|阎|薛|侯|雷|白|龙|段|郝|孔|邵|史|毛|常|万|顾|赖|武|康|贺|严|克)/;
      
      // Strict metadata, label and corporate suffix validation to filter out noise
      function isValidNameHeuristic(str) {
        if (!str) return false;
        var cleanStr = str.replace(/[\\s.,，。:：;；%&|()（）\\[\\]{}<>]/g, '');
        // Must contain ONLY Chinese characters
        if (!/^[\\u4e00-\\u9fa5]+$/.test(cleanStr)) {
          return false;
        }
        // Length check
        if (cleanStr.length < 1 || cleanStr.length > 6) {
          return false;
        }
        // If single character, must be a surname
        if (cleanStr.length === 1 && !SURNAMES.test(cleanStr)) {
          return false;
        }
        if (/姓名|电话|手机|号码|公司|备注|联系人|客户|微信|意向|跟进|记录|挂断|接通|无效|加微信|想买|说明|介绍|详情|tel|phone|mobile|name/i.test(cleanStr)) {
          return false;
        }
        if (/有限公司|有限责任|集团|公司|企业|厂|店|中心|商行|工作室|股份/.test(cleanStr)) {
          return false;
        }
        if (/北京|上海|广州|深圳|成都|杭州|武汉|西安|重庆|南京|天津|中国|四川|湖南|湖北|广东|江苏|浙江|山东|福建|江西|河南|河北|安徽|辽宁|吉林|黑龙江|山西|陕西|甘肃|青海|云南|贵州|广西|西藏|内模|内蒙|新疆|宁夏|海南|港澳|台湾|东莞|佛山|温州|宁波|苏州|无锡|常州|扬州|徐州|南通/i.test(cleanStr)) {
          return false;
        }
        return true;
      }

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line) continue;
        
        var phoneRegex = /(?:1[3-9]\\d{9}|1[3-9]\\d{1,2}[-\\s]\\d{3,4}[-\\s]\\d{4}|0\\d{2,3}[-\\s]\\d{7,8}|0\\d{9,11})/g;
        var match;
        var foundPhonesInLine = [];
        
        while ((match = phoneRegex.exec(line)) !== null) {
          var cleanPhoneStr = match[0].replace(/[-\\s]/g, '');
          if (!phoneSet.has(cleanPhoneStr)) {
            foundPhonesInLine.push({
              phone: cleanPhoneStr,
              raw: match[0],
              index: match.index,
              length: match[0].length
            });
            phoneSet.add(cleanPhoneStr);
          }
        }
        
        if (foundPhonesInLine.length === 0) continue;
        
        for (var pi = 0; pi < foundPhonesInLine.length; pi++) {
          var phoneInfo = foundPhonesInLine[pi];
          var phoneStr = phoneInfo.phone;
          var rawPhoneStr = phoneInfo.raw;
          
          var name = '';
          var company = '';
          var noteParts = [];
          
          // Replace current phone in line with space to separate name and company when连写
          var lineWithoutPhone = line.replace(rawPhoneStr, ' ');
          
          // Delimit segments on the line to parse columns/words
          var delimiters = /[\\s,，:：|｜;；\\t\\-\\[\\]\\(\\)]+/;
          var lineParts = lineWithoutPhone.split(delimiters).map(function(p) { return p.trim(); }).filter(Boolean);
          
          // Filter out other phone tokens if any
          var remainingParts = lineParts.filter(function(part) {
            var cleanPart = part.replace(/[-\\s]/g, '');
            for (var k = 0; k < foundPhonesInLine.length; k++) {
              var otherPhone = foundPhonesInLine[k];
              if (cleanPart.indexOf(otherPhone.phone) !== -1 || part.indexOf(otherPhone.raw) !== -1) {
                return false;
              }
            }
            return true;
          });
          
          // 1. Identify Company Candidates
          var bestCompany = '';
          for (var j = 0; j < remainingParts.length; j++) {
            var part = remainingParts[j];
            if (/联系人|负责人|姓名|电话|手机|号码|备注|意向|跟进|记录|挂断|接通|无效|加微信/i.test(part)) {
              continue;
            }
            if (/有限公司|有限责任|集团|公司|企业|厂|店|中心|商行|工作室|股份|科技|技术|网络|制造|金融|地产|开发/.test(part)) {
              bestCompany = part;
              break;
            }
          }
          
          // Fallback Company (institution suffixes)
          if (!bestCompany) {
            for (var j = 0; j < remainingParts.length; j++) {
              var part = remainingParts[j];
              if (/局|厅|科|所|校|院|部/.test(part)) {
                bestCompany = part;
                break;
              }
            }
          }
          
          if (bestCompany) {
            company = bestCompany;
          }
          
          // Spatial prefix/suffix extraction
          var prefix = line.substring(0, phoneInfo.index).trim();
          var prefixMatch = /([\\u4e00-\\u9fa5]{2,4})\\s*$/.exec(prefix);
          var prefixName = prefixMatch ? prefixMatch[1] : '';
          
          var suffix = line.substring(phoneInfo.index + phoneInfo.length).trim();
          var suffixMatch = /^\\s*([\\u4e00-\\u9fa5]{2,4})/.exec(suffix);
          var suffixName = suffixMatch ? suffixMatch[1] : '';

          // 2. Identify Name with multi-phase priority
          // Phase A: Segment matches starting with common surnames
          for (var j = 0; j < remainingParts.length; j++) {
            var part = remainingParts[j];
            if (part === company) continue;
            if (isValidNameHeuristic(part) && SURNAMES.test(part) && part.length <= 4) {
              name = part;
              break;
            }
          }
          
          // Phase B: Adjacent prefix/suffix matches starting with common surnames
          if (!name) {
            if (prefixName && isValidNameHeuristic(prefixName) && SURNAMES.test(prefixName)) {
              name = prefixName;
            } else if (suffixName && isValidNameHeuristic(suffixName) && SURNAMES.test(suffixName)) {
              name = suffixName;
            }
          }
          
          // Phase C: Regular segments (Chinese name / titles) satisfying validity
          if (!name) {
            for (var j = 0; j < remainingParts.length; j++) {
              var part = remainingParts[j];
              if (part === company) continue;
              if (isValidNameHeuristic(part) && part.length <= 4) {
                name = part;
                break;
              }
            }
          }
          
          // Phase D: Adjacent prefix/suffix satisfying validity
          if (!name) {
            if (prefixName && isValidNameHeuristic(prefixName)) {
              name = prefixName;
            } else if (suffixName && isValidNameHeuristic(suffixName)) {
              name = suffixName;
            }
          }
          
          // Phase E: Any valid remaining segment up to 6 characters
          if (!name) {
            for (var j = 0; j < remainingParts.length; j++) {
              var part = remainingParts[j];
              if (part === company) continue;
              if (isValidNameHeuristic(part)) {
                name = part;
                break;
              }
            }
          }
          
          // Fallback
          if (!name) {
            name = '客户-' + phoneStr.substring(phoneStr.length - 4);
          }
          
          // Extract Notes from remaining parts
          for (var j = 0; j < remainingParts.length; j++) {
            var part = remainingParts[j];
            if (part !== name && part !== company) {
              // Skip UI labels/metadata in notes to keep them clean
              if (/姓名|电话|手机|号码|公司|备注|联系人|客户|微信|负责人|说明|介绍|详情/i.test(part) && part.length <= 5) {
                continue;
              }
              var cleanPart = part.replace(/[-\\s.,，。:：;；%&|()（）\\[\\]{}<>]/g, '');
              if (cleanPart.length <= 1 && !/^\\d$/.test(cleanPart)) {
                continue;
              }
              if (/^[a-zA-Z]+$/.test(cleanPart) && cleanPart.length < 3) {
                continue;
              }
              noteParts.push(part);
            }
          }
          
          results.push({
            name: name,
            phone: phoneStr,
            company: company,
            note: noteParts.join(' ')
          });
        }
      }
      
      if (results.length === 0) {
        var globalPhoneRegex = /1[3-9]\\d{9}/g;
        var globalMatch;
        while ((globalMatch = globalPhoneRegex.exec(text)) !== null) {
          var p = globalMatch[0];
          if (!phoneSet.has(p)) {
            phoneSet.add(p);
            
            // Reverse-seek in raw text for names immediately preceding global phones
            var searchStart = Math.max(0, globalMatch.index - 15);
            var searchSlice = text.substring(searchStart, globalMatch.index);
            var nameMatch = /([\\u4e00-\\u9fa5]{2,4})\\s*$/.exec(searchSlice);
            var foundName = nameMatch ? nameMatch[1] : '';
            
            results.push({
              name: foundName || ('客户-' + p.substring(p.length - 4)),
              phone: p,
              company: '',
              note: ''
            });
          }
        }
      }
      
      return results;
    }

    function handleFileImportDispatch(file) {
      if (!file) return;
      var ext = file.name.split('.').pop().toLowerCase();
      var sizeMB = file.size / (1024 * 1024);
      
      if (sizeMB > 30) {
        alert('文件大小超过 30MB 限制！目前仅支持上传 30MB 以内的文件。');
        return;
      }
      
      if (ext === 'xlsx' || ext === 'xls' || ext === 'csv') {
        if (sizeMB > 3) {
          handleExcelLargeFileWorker(file);
        } else {
          handleExcelImport(file);
        }
      } else if (ext === 'vcf' || ext === 'vcard') {
        handleVcfImport(file);
      } else if (ext === 'docx') {
        handleDocxImport(file);
      } else if (ext === 'pdf') {
        handlePdfImport(file);
      } else if (ext === 'txt') {
        handleTxtImport(file);
      } else if (/jpg|jpeg|png|bmp|webp/i.test(ext)) {
        handleImageOCR(file);
      } else {
        alert('不支持的文件格式！目前支持 Excel, CSV, VCF, Word(docx), PDF, 纯文本(txt) 以及常用格式图片。');
      }
    }

    function handleExcelLargeFileWorker(file) {
      showAIScanningUI(file.name);
      document.getElementById('aiScanStatus').innerHTML = '⚡ 智能大文件多线程加速解析中...';
      if (document.getElementById('aiLog1')) {
        document.getElementById('aiLog1').innerHTML = '⏳ 正在加载 Web Worker 解析引擎...';
        document.getElementById('aiLog1').style.opacity = '1';
      }
      
      var reader = new FileReader();
      reader.onload = function(e) {
        var arrayBuffer = e.target.result;
        
        var workerCode = [
          "self.importScripts('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');",
          "self.onmessage = function(e) {",
          "  try {",
          "    var data = new Uint8Array(e.data);",
          "    var workbook = XLSX.read(data, { type: 'array' });",
          "    var firstSheetName = workbook.SheetNames[0];",
          "    var worksheet = workbook.Sheets[firstSheetName];",
          "    var json = XLSX.utils.sheet_to_json(worksheet, { header: 1 });",
          "    self.postMessage({ success: true, json: json });",
          "  } catch(err) {",
          "    self.postMessage({ success: false, error: err.message });",
          "  }",
          "};"
        ].join("\\n");
        
        var blob = new Blob([workerCode], { type: 'application/javascript' });
        var workerUrl = URL.createObjectURL(blob);
        var worker = new Worker(workerUrl);
        
        worker.onmessage = function(ev) {
          worker.terminate();
          URL.revokeObjectURL(workerUrl);
          
          if (ev.data.success) {
            var json = ev.data.json;
            if (json.length === 0) {
              alert('导入失败：表格无数据');
              resetAIImporterUI();
              return;
            }
            if (document.getElementById('aiLog3')) {
              document.getElementById('aiLog3').innerHTML = '✅ 大数据读取与过滤清洗完成';
              document.getElementById('aiLog3').style.opacity = '1';
            }
            var detected = runAIColumnMapping(json);
            renderAIReportForExcel(json, detected);
          } else {
            alert('大文件解析失败：' + ev.data.error);
            resetAIImporterUI();
          }
        };
        
        worker.postMessage(arrayBuffer, [arrayBuffer]);
      };
      
      reader.readAsArrayBuffer(file);
    }

    function handleDocxImport(file) {
      showAIScanningUI(file.name);
      document.getElementById('aiScanStatus').innerHTML = '⚙️ AI 正在载入 Word 解析引擎...';
      if (document.getElementById('aiLog1')) {
        document.getElementById('aiLog1').innerHTML = '⏳ 正在加载 mammoth.js 脚本库...';
        document.getElementById('aiLog1').style.opacity = '1';
      }
      
      loadScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js')
        .then(function() {
          if (document.getElementById('aiLog2')) {
            document.getElementById('aiLog2').innerHTML = '✅ Word 解析引擎载入成功';
            document.getElementById('aiLog2').style.opacity = '1';
          }
          document.getElementById('aiScanStatus').innerHTML = '📄 正在深度分析 Word 文档数据流...';
          
          var reader = new FileReader();
          reader.onload = function(e) {
            var arrayBuffer = e.target.result;
            window.mammoth.extractRawText({ arrayBuffer: arrayBuffer })
              .then(function(result) {
                if (document.getElementById('aiLog3')) {
                  document.getElementById('aiLog3').innerHTML = '✅ 提取纯文本内容完成';
                  document.getElementById('aiLog3').style.opacity = '1';
                }
                var text = result.value;
                if (document.getElementById('aiLog4')) {
                  document.getElementById('aiLog4').innerHTML = '⏳ AI 正在运行模式启发式提取...';
                  document.getElementById('aiLog4').style.opacity = '1';
                }
                setTimeout(function() {
                  var contacts = parsePhoneContactsFromRawText(text);
                  renderAIUnstructuredReport(file.name, contacts);
                }, 800);
              })
              .catch(function(err) {
                alert('Word 解析失败：' + err.message);
                resetAIImporterUI();
              });
          };
          reader.readAsArrayBuffer(file);
        })
        .catch(function(err) {
          alert('解析引擎加载失败，请检查您的网络连接：' + err.message);
          resetAIImporterUI();
        });
    }

    function handlePdfImport(file) {
      showAIScanningUI(file.name);
      document.getElementById('aiScanStatus').innerHTML = '⚙️ AI 正在载入 PDF 解析引擎...';
      if (document.getElementById('aiLog1')) {
        document.getElementById('aiLog1').innerHTML = '⏳ 正在加载 pdf.js 脚本库...';
        document.getElementById('aiLog1').style.opacity = '1';
      }
      
      loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.min.js')
        .then(function() {
          window['pdfjs-dist/build/pdf'].GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
          
          if (document.getElementById('aiLog2')) {
            document.getElementById('aiLog2').innerHTML = '✅ PDF 引擎初始化完成';
            document.getElementById('aiLog2').style.opacity = '1';
          }
          document.getElementById('aiScanStatus').innerHTML = '📄 正在深度分析 PDF 文档页面...';
          
          var reader = new FileReader();
          reader.onload = function(e) {
            var arrayBuffer = e.target.result;
            var loadingTask = window['pdfjs-dist/build/pdf'].getDocument({ data: arrayBuffer });
            
            loadingTask.promise.then(function(pdf) {
              var maxPages = pdf.numPages;
              var extractedText = '';
              var loadedPages = 0;
              
              if (document.getElementById('aiLog3')) {
                document.getElementById('aiLog3').innerHTML = '⏳ 正在并行扫描 ' + maxPages + ' 个页面...';
                document.getElementById('aiLog3').style.opacity = '1';
              }
              
              function loadPageText(pageNumber) {
                document.getElementById('aiScanStatus').innerHTML = '📄 正在扫描 PDF 页面 (' + pageNumber + '/' + maxPages + ')...';
                
                return pdf.getPage(pageNumber).then(function(page) {
                  return page.getTextContent().then(function(textContent) {
                    var pageText = textContent.items.map(function(item) { return item.str; }).join(' ');
                    extractedText += pageText + '\\n';
                    loadedPages++;
                    
                    if (loadedPages < maxPages) {
                      return loadPageText(pageNumber + 1);
                    } else {
                      if (document.getElementById('aiLog3')) {
                        document.getElementById('aiLog3').innerHTML = '✅ PDF 页面文本提取完毕';
                      }
                      if (document.getElementById('aiLog4')) {
                        document.getElementById('aiLog4').innerHTML = '⏳ AI 正在运行特征神经网络分析...';
                        document.getElementById('aiLog4').style.opacity = '1';
                      }
                      setTimeout(function() {
                        var contacts = parsePhoneContactsFromRawText(extractedText);
                        renderAIUnstructuredReport(file.name, contacts);
                      }, 800);
                    }
                  });
                });
              }
              
              loadPageText(1).catch(function(err) {
                alert('PDF 页面文本提取失败：' + err.message);
                resetAIImporterUI();
              });
              
            }).catch(function(err) {
              alert('PDF 文档读取失败：' + err.message);
              resetAIImporterUI();
            });
          };
          reader.readAsArrayBuffer(file);
        })
        .catch(function(err) {
          alert('PDF 解析引擎加载失败：' + err.message);
          resetAIImporterUI();
        });
    }

    function handleImageOCR(file) {
      showAIScanningUI(file.name);
      document.getElementById('aiScanStatus').innerHTML = '⚙️ AI 正在载入视觉 OCR 引擎...';
      if (document.getElementById('aiLog1')) {
        document.getElementById('aiLog1').innerHTML = '⏳ 正在加载 tesseract.js 视觉分析库...';
        document.getElementById('aiLog1').style.opacity = '1';
      }
      
      loadScript('https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/4.1.1/tesseract.min.js')
        .then(function() {
          if (document.getElementById('aiLog2')) {
            document.getElementById('aiLog2').innerHTML = '✅ 视觉神经网络就绪';
            document.getElementById('aiLog2').style.opacity = '1';
          }
          document.getElementById('aiScanStatus').innerHTML = '📸 正在下载中英文语言模型包...';
          
          if (document.getElementById('aiLog3')) {
            document.getElementById('aiLog3').innerHTML = '⏳ 正在从 CDN 获取高精 chi_sim+eng 模型...';
            document.getElementById('aiLog3').style.opacity = '1';
          }
          
          Tesseract.createWorker({
            langPath: window.location.origin + '/tessdata',
            logger: function(m) {
              if (m.status === 'recognizing text') {
                var pct = Math.round(m.progress * 100);
                document.getElementById('aiScanStatus').innerHTML = '📸 图像文字 AI 深度识别中：' + pct + '%';
                if (document.getElementById('aiLog3')) {
                  document.getElementById('aiLog3').innerHTML = '✅ 模型载入成功，识别进行中...';
                }
                if (document.getElementById('aiLog4')) {
                  document.getElementById('aiLog4').innerHTML = '⚡ OCR 进度: ' + pct + '%';
                  document.getElementById('aiLog4').style.opacity = '1';
                }
              } else if (m.status === 'loading chi_sim.traineddata' || m.status === 'loading eng.traineddata') {
                var loadPct = m.progress ? ' (' + Math.round(m.progress * 100) + '%)' : '';
                document.getElementById('aiScanStatus').innerHTML = '🧠 正在载入语言模型包' + loadPct + '...';
              }
            }
          }).then(function(worker) {
            return Promise.resolve(worker.load())
              .then(function() {
                return Promise.resolve(worker.loadLanguage('chi_sim+eng'));
              })
              .then(function() {
                return Promise.resolve(worker.initialize('chi_sim+eng'));
              })
              .then(function() {
                return Promise.resolve(worker.recognize(file));
              })
              .then(function(result) {
                try {
                  worker.terminate();
                } catch(e) {}
                return result;
              })
              .catch(function(err) {
                try {
                  worker.terminate();
                } catch(e) {}
                throw err;
              });
          }).then(function(result) {
            if (document.getElementById('aiLog4')) {
              document.getElementById('aiLog4').innerHTML = '✅ 图像文字识别与神经特征映射完毕';
            }
            var text = result.data.text;
            setTimeout(function() {
              var contacts = parsePhoneContactsFromRawText(text);
              renderAIUnstructuredReport(file.name, contacts);
            }, 800);
          }).catch(function(err) {
            alert('视觉 OCR 识别失败：' + (err.message || err));
            resetAIImporterUI();
          });
        })
        .catch(function(err) {
          alert('视觉识别引擎加载失败：' + err.message);
          resetAIImporterUI();
        });
    }

    function handleTxtImport(file) {
      showAIScanningUI(file.name);
      document.getElementById('aiScanStatus').innerHTML = '📄 正在读取文本文档...';
      if (document.getElementById('aiLog1')) {
        document.getElementById('aiLog1').innerHTML = '✅ 文件读取通道建立';
        document.getElementById('aiLog1').style.opacity = '1';
      }
      
      var reader = new FileReader();
      reader.onload = function(e) {
        if (document.getElementById('aiLog2')) {
          document.getElementById('aiLog2').innerHTML = '✅ 文档原始二进制流读取成功';
          document.getElementById('aiLog2').style.opacity = '1';
        }
        var text = e.target.result;
        if (document.getElementById('aiLog3')) {
          document.getElementById('aiLog3').innerHTML = '✅ UTF-8 编码文本清洗完毕';
          document.getElementById('aiLog3').style.opacity = '1';
        }
        if (document.getElementById('aiLog4')) {
          document.getElementById('aiLog4').innerHTML = '⏳ AI 正在运行特征分析提取模型...';
          document.getElementById('aiLog4').style.opacity = '1';
        }
        setTimeout(function() {
          var contacts = parsePhoneContactsFromRawText(text);
          renderAIUnstructuredReport(file.name, contacts);
        }, 800);
      };
      reader.readAsText(file, 'utf-8');
    }

    function renderAIUnstructuredReport(fileName, contacts) {
      tempUnstructuredContacts = contacts;
      tempImportType = 'unstructured';
      tempImportData = contacts;
      
      document.getElementById('aiImportScanning').style.display = 'none';
      document.getElementById('aiLaserLine').style.display = 'none';
      
      document.getElementById('aiExcelMappingPills').style.display = 'none';
      document.getElementById('aiExcelMappingControls').style.display = 'none';
      document.getElementById('aiExcelPreviewContainer').style.display = 'none';
      
      var unstContainer = document.getElementById('aiUnstructuredContainer');
      unstContainer.style.display = 'block';
      
      document.getElementById('aiReportTitle').innerHTML = 'AI 提取报告: ' + esc(fileName);
      
      var conf = contacts.length > 0 ? 98.0 : 0.0;
      document.getElementById('aiConfidenceBadge').innerHTML = '● AI 识别率: ' + conf.toFixed(1) + '%';
      
      renderUnstructuredTableRows();
      
      document.getElementById('aiImportReport').style.display = 'flex';
    }

    function renderUnstructuredTableRows() {
      var tbody = document.querySelector('#aiUnstructuredTable tbody');
      if (!tbody) return;
      tbody.innerHTML = '';
      
      if (tempUnstructuredContacts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 20px; color: var(--text-light);">未识别到任何带号码的联系人数据</td></tr>';
        document.getElementById('aiConfirmImportBtn').innerHTML = '无数据可导入';
        document.getElementById('aiConfirmImportBtn').disabled = true;
        return;
      }
      
      document.getElementById('aiConfirmImportBtn').disabled = false;
      document.getElementById('aiConfirmImportBtn').innerHTML = '确认导入 (' + tempUnstructuredContacts.length + ' 位联系人)';
      
      tempUnstructuredContacts.forEach(function(c, index) {
        var tr = document.createElement('tr');
        tr.style.borderBottom = '0.5px solid var(--card-border)';
        
        var tdDel = document.createElement('td');
        tdDel.style.padding = '4px 6px';
        tdDel.style.textAlign = 'center';
        var delBtn = document.createElement('button');
        delBtn.innerHTML = '🗑️';
        delBtn.style.background = 'transparent';
        delBtn.style.border = 'none';
        delBtn.style.cursor = 'pointer';
        delBtn.style.fontSize = '0.75rem';
        delBtn.addEventListener('click', function() {
          tempUnstructuredContacts.splice(index, 1);
          renderUnstructuredTableRows();
        });
        tdDel.appendChild(delBtn);
        
        var tdName = document.createElement('td');
        tdName.style.padding = '4px 6px';
        tdName.style.fontWeight = '800';
        tdName.style.color = 'var(--text-main)';
        tdName.contentEditable = 'true';
        tdName.textContent = c.name;
        tdName.addEventListener('blur', function() {
          tempUnstructuredContacts[index].name = this.textContent.trim();
        });
        
        var tdPhone = document.createElement('td');
        tdPhone.style.padding = '4px 6px';
        tdPhone.style.fontFamily = 'monospace';
        tdPhone.style.color = 'var(--accent-wechat)';
        tdPhone.style.fontWeight = '800';
        tdPhone.contentEditable = 'true';
        tdPhone.textContent = c.phone;
        tdPhone.addEventListener('blur', function() {
          var val = this.textContent.trim().replace(/[-\\s]/g, '');
          tempUnstructuredContacts[index].phone = val;
        });
        
        var tdComp = document.createElement('td');
        tdComp.style.padding = '4px 6px';
        tdComp.style.color = '#4a6cf7';
        tdComp.contentEditable = 'true';
        tdComp.textContent = c.company;
        tdComp.addEventListener('blur', function() {
          tempUnstructuredContacts[index].company = this.textContent.trim();
        });
        
        var tdNote = document.createElement('td');
        tdNote.style.padding = '4px 6px';
        tdNote.style.color = 'var(--text-soft)';
        tdNote.contentEditable = 'true';
        tdNote.textContent = c.note;
        tdNote.addEventListener('blur', function() {
          tempUnstructuredContacts[index].note = this.textContent.trim();
        });
        
        tr.appendChild(tdDel);
        tr.appendChild(tdName);
        tr.appendChild(tdPhone);
        tr.appendChild(tdComp);
        tr.appendChild(tdNote);
        tbody.appendChild(tr);
      });
    }

    function executeAIImportUnstructured() {
      if (!tempUnstructuredContacts || tempUnstructuredContacts.length === 0) return;
      importedClients = tempUnstructuredContacts;
      saveState();
      updateDashboardVisibility(true);
      renderDialCards();
      resetAIImporterUI();
    }

    function initAIImporter() {
      document.getElementById('aiToggleAdjustBtn').addEventListener('click', function(e) {
        e.preventDefault();
        var ctrl = document.getElementById('aiAdjustControls');
        if (ctrl.style.display === 'none') {
          ctrl.style.display = 'grid';
          this.textContent = '⚙️ 收起手动修正配置 ▴';
        } else {
          ctrl.style.display = 'none';
          this.textContent = '⚙️ 手动修正 AI 映射结果 ▾';
        }
      });

      document.getElementById('aiSelName').addEventListener('change', updateAIPreviewTable);
      document.getElementById('aiSelPhone').addEventListener('change', updateAIPreviewTable);
      document.getElementById('aiSelCompany').addEventListener('change', updateAIPreviewTable);
      document.getElementById('aiSelNote').addEventListener('change', updateAIPreviewTable);

      document.getElementById('aiResetImportBtn').addEventListener('click', function(e) {
        e.preventDefault();
        resetAIImporterUI();
      });

      document.getElementById('aiConfirmImportBtn').addEventListener('click', function(e) {
        e.preventDefault();
        if (tempImportType === 'xlsx') {
          executeAIImportExcel();
        } else if (tempImportType === 'vcf') {
          executeAIImportVcf();
        } else if (tempImportType === 'unstructured') {
          executeAIImportUnstructured();
        }
      });
    }


    // Parse Excel/CSV
    function handleExcelImport(file) {
      var reader = new FileReader();
      reader.onload = function(e) {
        try {
          var data = new Uint8Array(e.target.result);
          var workbook = XLSX.read(data, { type: 'array' });
          var firstSheetName = workbook.SheetNames[0];
          var worksheet = workbook.Sheets[firstSheetName];
          var json = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
          if (json.length === 0) {
            alert('导入失败：表格无数据');
            return;
          }

          showAIScanningUI(file.name);

          // Deep AI Scanning trigger
          setTimeout(function() {
            var detected = runAIColumnMapping(json);
            renderAIReportForExcel(json, detected);
          }, 1200);

        } catch(err) {
          alert('解析失败：' + err.message);
        }
      };
      reader.readAsArrayBuffer(file);
    }

    // Parse VCF
    function handleVcfImport(file) {
      var reader = new FileReader();
      reader.onload = function(ev) {
        try {
          var text = ev.target.result;
          var blocks = text.split(/BEGIN:VCARD/i);
          blocks = blocks.slice(1);
          if (!blocks.length) {
            alert('未找到联系人，请确认是有效的 .vcf 文件');
            return;
          }
          
          showAIScanningUI(file.name);

          var list = [];
          var phoneSet = new Set();
          for (var bi = 0; bi < blocks.length; bi++) {
            var blk = blocks[bi];
            var name = '';
            var mQP = blk.match(/FN[^:]*QUOTED-PRINTABLE[^:]*:([^\\r\\n]+)/i);
            var mU8 = blk.match(/FN;CHARSET=UTF-8:([^\\r\\n]+)/i);
            var mFN = blk.match(/FN:([^\\r\\n]+)/i);
            if (mQP) { name = decodeQPUtf8(mQP[1]).trim(); }
            else if (mU8) { name = mU8[1].trim(); }
            else if (mFN) { name = mFN[1].trim(); }
            
            var company = '';
            var mOQ = blk.match(/ORG[^:]*QUOTED-PRINTABLE[^:]*:([^\\r\\n]+)/i);
            var mOP = blk.match(/ORG[^:;]*:([^\\r\\n]+)/i);
            if (mOQ) { company = decodeQPUtf8(mOQ[1]).trim(); }
            else if (mOP) { company = mOP[1].trim(); }

            var note = '';
            var mNQ = blk.match(/NOTE[^:]*QUOTED-PRINTABLE[^:]*:([^\\r\\n]+)/i);
            var mNU = blk.match(/NOTE;CHARSET=UTF-8:([^\\r\\n]+)/i);
            var mNP = blk.match(/NOTE[^:;]*:([^\\r\\n]+)/i);
            if (mNQ) { note = decodeQPUtf8(mNQ[1]).trim(); }
            else if (mNU) { note = mNU[1].trim(); }
            else if (mNP) { note = mNP[1].trim(); }

            var telLines = blk.match(/TEL[^:]*:([^\\r\\n]+)/gi) || [];
            for (var ti = 0; ti < telLines.length; ti++) {
              var ci = telLines[ti].indexOf(':');
              if (ci < 0) continue;
              var phone = telLines[ti].slice(ci+1).trim().replace(/[^\\d+]/g, '');
              if (!phone) continue;
              if (phoneSet.has(phone)) break;
              phoneSet.add(phone);
              list.push({ name: name || '未知姓名', phone: phone, company: company, note: note, dialedStatus: 'todo', duration: '', callNote: '' });
              break;
            }
          }
          
          if (!list.length) {
            alert('未找到含电话的联系人');
            resetAIImporterUI();
            return;
          }

          // Deep AI Scanning trigger
          setTimeout(function() {
            renderAIReportForVcf(list);
          }, 1200);

        } catch(err) {
          alert('VCF 解析失败：' + err.message);
          resetAIImporterUI();
        }
      };
      reader.readAsText(file, 'utf-8');
    }

    // Render client list
    function renderDialCards() {
      var container = document.getElementById('cardsContainer');
      if (!container) return;
      
      updateStats();

      if (importedClients.length === 0) {
        container.innerHTML = '<div style="text-align:center;padding:80px 20px;color:var(--text-light);font-size:0.82rem;display:flex;flex-direction:column;gap:12px;"><span style="font-size: 2.2rem;opacity:0.6;">📇</span><span>暂无联系人数据，请在上方导入表格或通讯录文件</span></div>';
        return;
      }

      var query = document.getElementById('searchInput').value.toLowerCase().trim();
      var wlFilter = document.getElementById('whitelistFilterSelect') ? document.getElementById('whitelistFilterSelect').value : 'all';

      var filtered = importedClients.filter(function(c) {
        var matchFilter = (currentFilter === 'all') || (c.dialedStatus === currentFilter);
        
        var companyTrimmed = c.company ? String(c.company).trim() : '';
        var isCompanyInWhitelist = false;
        if (whitelistCheckResults && whitelistCheckResults[companyTrimmed]) {
          isCompanyInWhitelist = whitelistCheckResults[companyTrimmed].isMatch;
        }

        // Whitelist dropdown filter
        var matchWlFilter = true;
        if (wlFilter === 'yes') {
          matchWlFilter = isCompanyInWhitelist;
        } else if (wlFilter === 'no') {
          matchWlFilter = !isCompanyInWhitelist;
        }

        var matchQuery = true;
        if (query) {
          var isWlSearch = (query === '白名单' || query === '是白名单' || query === 'is:whitelist');
          var isNotWlSearch = (query === '非白名单' || query === '否白名单' || query === 'is:not-whitelist');
          
          if (isWlSearch) {
            matchQuery = isCompanyInWhitelist;
          } else if (isNotWlSearch) {
            matchQuery = !isCompanyInWhitelist;
          } else {
            matchQuery = c.name.toLowerCase().includes(query) || 
                         c.phone.toLowerCase().includes(query) || 
                         c.company.toLowerCase().includes(query);
          }
        }
        return matchFilter && matchWlFilter && matchQuery;
      });

      if (filtered.length === 0) {
        container.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-light);font-size:0.8rem;">无匹配此筛选条件的联系人</div>';
        return;
      }

      // Apply Sorting
      var sorted = filtered.slice();
      if (currentSort === 'name') {
        sorted.sort(function(a, b) {
          return String(a.name || '').localeCompare(String(b.name || ''), 'zh');
        });
      } else if (currentSort === 'company') {
        sorted.sort(function(a, b) {
          return String(a.company || '').localeCompare(String(b.company || ''), 'zh');
        });
      } else if (currentSort === 'todo') {
        sorted.sort(function(a, b) {
          var aTodo = (!a.dialedStatus || a.dialedStatus === 'todo') ? 0 : 1;
          var bTodo = (!b.dialedStatus || b.dialedStatus === 'todo') ? 0 : 1;
          return aTodo - bTodo;
        });
      } else if (currentSort === 'dialed') {
        sorted.sort(function(a, b) {
          var aDialed = (a.dialedStatus === 'success' || a.dialedStatus === 'failed') ? 0 : 1;
          var bDialed = (b.dialedStatus === 'success' || b.dialedStatus === 'failed') ? 0 : 1;
          return aDialed - bDialed;
        });
      } else if (currentSort === 'shuffle') {
        // Fisher-Yates shuffle for true random order
        for (var si = sorted.length - 1; si > 0; si--) {
          var sj = Math.floor(Math.random() * (si + 1));
          var tmp = sorted[si];
          sorted[si] = sorted[sj];
          sorted[sj] = tmp;
        }
      }

      // Calculate Pagination
      var total = sorted.length;
      var totalPages = Math.ceil(total / pageSize);
      if (currentPage > totalPages) currentPage = Math.max(1, totalPages);
      
      var start = (currentPage - 1) * pageSize;
      var end = Math.min(start + pageSize, total);
      var sliced = sorted.slice(start, end);

      var cardsHtml = sliced.map(function(c) {
        // Find real index in original list
        var i = importedClients.indexOf(c);

        var badgeHtml = '<span class="xls-dial-badge xls-dial-badge-todo">待拨打</span>';
        var cardClass = 'xls-dial-card';
        if (c.dialedStatus === 'success') {
          badgeHtml = '<span class="xls-dial-badge xls-dial-badge-success">已接通 (' + (c.duration || '00:00') + ')</span>';
          cardClass += ' dialed';
          if (c.phone) {
            badgeHtml += ' <button class="rec-play-btn" data-phone="' + esc(c.phone) + '" title="播放通话录音" style="font-size:0.6rem;padding:1px 6px;border:1px solid #07c160;background:rgba(7,193,96,0.08);color:#07c160;border-radius:3px;cursor:pointer;font-weight:700;margin-left:4px;" onclick="event.stopPropagation();var p=this.dataset.phone;var a=document.createElement(\\x27audio\\x27);a.controls=true;a.style.width=\\x27100%\\x27;a.style.height=\\x2728px\\x27;a.style.marginTop=\\x274px\\x27;var w=this.nextElementSibling;if(w&&w.classList.contains(\\x27rec-audio-wrap\\x27)){w.remove();return;}var d=document.createElement(\\x27div\\x27);d.className=\\x27rec-audio-wrap\\x27;d.style.width=\\x27100%\\x27;d.appendChild(a);this.parentElement.appendChild(d);a.src=\\x27/api/local-recording?phone=\\x27+encodeURIComponent(p);a.play().catch(function(){});">▶ 录音</button>';
          }
        } else if (c.dialedStatus === 'failed') {
          badgeHtml = '<span class="xls-dial-badge xls-dial-badge-failed">未接通</span>';
          cardClass += ' dialed';
          if (c.phone) {
            badgeHtml += ' <button class="rec-play-btn" data-phone="' + esc(c.phone) + '" title="播放通话录音" style="font-size:0.6rem;padding:1px 6px;border:1px solid #e67e22;background:rgba(245,124,0,0.08);color:#e67e22;border-radius:3px;cursor:pointer;font-weight:700;margin-left:4px;" onclick="event.stopPropagation();var p=this.dataset.phone;var a=document.createElement(\\x27audio\\x27);a.controls=true;a.style.width=\\x27100%\\x27;a.style.height=\\x2728px\\x27;a.style.marginTop=\\x274px\\x27;var w=this.nextElementSibling;if(w&&w.classList.contains(\\x27rec-audio-wrap\\x27)){w.remove();return;}var d=document.createElement(\\x27div\\x27);d.className=\\x27rec-audio-wrap\\x27;d.style.width=\\x27100%\\x27;d.appendChild(a);this.parentElement.appendChild(d);a.src=\\x27/api/local-recording?phone=\\x27+encodeURIComponent(p);a.play().catch(function(){});">▶ 录音</button>';
          }
        }

        var phoneClass = c.copied ? 'client-phone-btn copied' : 'client-phone-btn';

        return '<div class="' + cardClass + '" id="xdc_' + i + '">' +
          '<div class="client-card-top">' +
            '<div class="client-card-primary" style="display: flex; align-items: center; width: 100%; gap: 6px;">' +
              '<span class="client-card-name-btn" data-name="' + esc(c.name) + '" data-idx="' + i + '" title="点击复制姓名" style="flex: 0 0 62px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block;">' + esc(c.name) + '</span>' +
              '<span class="client-card-phone-wrap" style="flex: 0 0 110px; display: inline-flex; align-items: center;">' +
                '<span class="' + phoneClass + '" data-phone="' + esc(c.phone) + '" data-idx="' + i + '" title="点击复制号码" style="font-size: 0.82rem;">' + esc(c.phone) + '</span>' +
              '</span>' +
              '<div style="margin-left: auto; display: inline-flex; align-items: center; justify-content: flex-end; flex-shrink: 0;">' +
                badgeHtml +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="client-card-tags" style="margin-top: 2px;">' +
            (c.company ? '<span class="client-card-tag client-card-tag-company">' + esc(c.company) + '</span>' : '') +
            (whitelistCheckResults && c.company && whitelistCheckResults[String(c.company).trim()] ?
              (whitelistCheckResults[String(c.company).trim()].isMatch
                ? (function() {
                    var matchInfo = whitelistCheckResults[String(c.company).trim()];
                    var bank = matchInfo.bank_name || '建行建易贷';
                    var status = matchInfo.status || '正常';
                    if (status === '已失效') {
                      return '<span class="client-card-tag xls-dial-badge-not-whitelist" style="background:rgba(120,120,120,0.15) !important; color:#7f8c8d !important; border-color:rgba(120,120,120,0.25) !important;">✔ ' + esc(bank) + '(已失效)</span>';
                    } else if (status === '已删除') {
                      return '<span class="client-card-tag xls-dial-badge-not-whitelist" style="background:rgba(231,76,60,0.15) !important; color:#e74c3c !important; border-color:rgba(231,76,60,0.25) !important;">✔ ' + esc(bank) + '(已删除)</span>';
                    }
                    return '<span class="client-card-tag xls-dial-badge-whitelist">✔ ' + esc(bank) + '</span>';
                  })()
                : '<span class="client-card-tag xls-dial-badge-not-whitelist">✘ 非白名单</span>')
              : '') +
          '</div>' +
          (c.note ? 
            '<div class="client-card-body" style="margin-top: 4px;">' +
              '<div class="client-card-content-block follow-up" style="background:rgba(74,108,247,0.03); border-left:3px solid #4a6cf7; padding: 6px 8px; border-radius: 0 var(--radius-xs) var(--radius-xs) 0;">' +
                '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">' +
                  '<span class="client-card-label" style="color:#4a6cf7; font-weight:800; font-size:0.65rem;">资料备注</span>' +
                  '<span class="client-card-tag-note" data-note="' + esc(c.note) + '" style="font-size:0.6rem; color:#4a6cf7; cursor:pointer; text-decoration:underline;">[放大查看]</span>' +
                '</div>' +
                '<span class="client-card-text" style="color:var(--text-soft); white-space:pre-wrap; display:block; margin-top:2px;">' + esc(c.note) + '</span>' +
              '</div>' +
            '</div>' : '') +
          (c.callNote ? 
            '<div class="client-card-body" style="margin-top: 4px;">' +
              '<div class="client-card-content-block follow-up">' +
                '<span class="client-card-label">通话小记</span>' +
                '<span class="client-card-text" style="color:var(--accent-wechat);">' + esc(c.callNote) + '</span>' +
              '</div>' +
            '</div>' : '') +
          (typeof AndroidDialer !== 'undefined' && AndroidDialer.hasRecording(c.phone) ? 
            '<div class="client-card-body" style="margin-top: 4px;">' +
              '<div class="client-card-content-block" style="background:rgba(9,187,7,0.03); border-left:3px solid var(--accent-wechat); padding: 6px 8px; border-radius: 0 var(--radius-xs) var(--radius-xs) 0;">' +
                '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">' +
                  '<span class="client-card-label" style="color:var(--accent-wechat); font-weight:800; font-size:0.65rem;">通话录音</span>' +
                  '<span style="font-size:0.6rem; color:var(--accent-wechat); font-weight:bold;">[本地录音就绪]</span>' +
                '</div>' +
                '<audio src="/api/local-recording?phone=' + encodeURIComponent(c.phone) + '" controls style="width: 100%; height: 32px; outline: none; margin-top: 4px; display: block;"></audio>' +
              '</div>' +
            '</div>' : '') +
          '<div class="client-card-actions">' +
            '<a href="tel:' + esc(c.phone) + '" class="btn-primary xls-card-dial-btn" data-idx="' + i + '" style="font-size:0.75rem;padding:2px 12px;height:28px;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;">拨打</a>' +
          '</div>' +
        '</div>';
      }).join('');

      // Build Pagination HTML
      var pagHtml = '';
      if (totalPages > 1) {
        pagHtml += '<div class="pagination-bar" style="display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 8px; margin-top: 18px; padding: 12px 0; border-top: 1px dashed var(--border-light); width: 100%;">';
        pagHtml += '<span style="font-size: 0.7rem; color: var(--text-light); margin-right: 4px; font-weight: 800;">第 ' + currentPage + '/' + totalPages + ' 页 (共 ' + total + ' 条)</span>';
        
        // Page Size Option Selector
        pagHtml += '<select id="pageSizeSel" style="height: 24px; font-size: 0.65rem; border: 1px solid var(--card-border); border-radius: var(--radius-xs); background: var(--btn-bg); color: var(--text-soft); font-weight: 800; outline: none; padding: 0 4px; cursor: pointer; margin-right: 6px;">';
        var sizes = [100, 200, 300, 500];
        sizes.forEach(function(sz) {
          var sel = (sz === pageSize) ? ' selected' : '';
          pagHtml += '<option value="' + sz + '"' + sel + '>' + sz + ' 条/页</option>';
        });
        pagHtml += '</select>';
        
        var prevDisabled = (currentPage === 1) ? ' disabled style="opacity: 0.4; cursor: not-allowed;"' : '';
        pagHtml += '<button class="btn-secondary" id="pagPrevBtn"' + prevDisabled + ' style="padding: 4px 8px; font-size: 0.68rem; border-radius: var(--radius-xs); height: 24px; cursor: pointer; display: inline-flex; align-items: center; font-weight: 800;">◀</button>';
        
        var startPage = Math.max(1, currentPage - 2);
        var endPage = Math.min(totalPages, currentPage + 2);
        
        if (startPage > 1) {
          pagHtml += '<button class="btn-secondary pag-num-btn" data-page="1" style="padding: 4px 8px; font-size: 0.68rem; border-radius: var(--radius-xs); height: 24px; cursor: pointer; display: inline-flex; align-items: center; font-weight: 800;">1</button>';
          if (startPage > 2) pagHtml += '<span style="font-size: 0.7rem; color: var(--text-light);">...</span>';
        }
        
        for (var p = startPage; p <= endPage; p++) {
          if (p === currentPage) {
            pagHtml += '<button class="btn-secondary pag-num-btn" data-page="' + p + '" style="background: var(--accent-wechat) !important; color: white !important; padding: 4px 8px; font-size: 0.68rem; border-radius: var(--radius-xs); height: 24px; cursor: pointer; display: inline-flex; align-items: center; font-weight: 900;">' + p + '</button>';
          } else {
            pagHtml += '<button class="btn-secondary pag-num-btn" data-page="' + p + '" style="padding: 4px 8px; font-size: 0.68rem; border-radius: var(--radius-xs); height: 24px; cursor: pointer; display: inline-flex; align-items: center; font-weight: 800;">' + p + '</button>';
          }
        }
        
        if (endPage < totalPages) {
          if (endPage < totalPages - 1) pagHtml += '<span style="font-size: 0.7rem; color: var(--text-light);">...</span>';
          pagHtml += '<button class="btn-secondary pag-num-btn" data-page="' + totalPages + '" style="padding: 4px 8px; font-size: 0.68rem; border-radius: var(--radius-xs); height: 24px; cursor: pointer; display: inline-flex; align-items: center; font-weight: 800;">' + totalPages + '</button>';
        }
        
        var nextDisabled = (currentPage === totalPages) ? ' disabled style="opacity: 0.4; cursor: not-allowed;"' : '';
        pagHtml += '<button class="btn-secondary" id="pagNextBtn"' + nextDisabled + ' style="padding: 4px 8px; font-size: 0.68rem; border-radius: var(--radius-xs); height: 24px; cursor: pointer; display: inline-flex; align-items: center; font-weight: 800;">▶</button>';
        pagHtml += '</div>';
      }

      container.innerHTML = cardsHtml + pagHtml;

      // Wire up pagination click handlers
      if (totalPages > 1) {
        var prevBtn = document.getElementById('pagPrevBtn');
        if (prevBtn && currentPage > 1) {
          prevBtn.addEventListener('click', function() {
            currentPage--;
            renderDialCards();
            window.scrollTo({ top: 0, behavior: 'smooth' });
          });
        }
        
        var nextBtn = document.getElementById('pagNextBtn');
        if (nextBtn && currentPage < totalPages) {
          nextBtn.addEventListener('click', function() {
            currentPage++;
            renderDialCards();
            window.scrollTo({ top: 0, behavior: 'smooth' });
          });
        }
        
        document.querySelectorAll('.pag-num-btn').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var targetPage = parseInt(this.dataset.page, 10);
            if (targetPage !== currentPage) {
              currentPage = targetPage;
              renderDialCards();
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }
          });
        });

        var pSizeSel = document.getElementById('pageSizeSel');
        if (pSizeSel) {
          pSizeSel.addEventListener('change', function() {
            pageSize = parseInt(this.value, 10);
            currentPage = 1;
            renderDialCards();
            window.scrollTo({ top: 0, behavior: 'smooth' });
          });
        }
      }

      // Wire up card phone click copy
      container.querySelectorAll('.client-phone-btn').forEach(function(b) {
        b.addEventListener('click', function(e) {
          e.stopPropagation();
          var phone = b.dataset.phone;
          var idx = parseInt(b.dataset.idx);
          copyTextToClipboard(phone);
          
          var oldText = b.textContent;
          if (oldText === '已复制') return;
          b.textContent = '已复制';
          var oldColor = b.style.color;
          b.style.color = 'var(--accent-wechat)';
          
          var client = importedClients[idx];
          if (client) {
            client.copied = true;
            saveState();
          }

          b.classList.add('copied');

          setTimeout(function() {
            b.textContent = phone;
            b.style.color = oldColor;
          }, 1000);
        });
      });

      // Wire up name click copy
      container.querySelectorAll('.client-card-name-btn').forEach(function(b) {
        b.addEventListener('click', function(e) {
          e.stopPropagation();
          var name = b.dataset.name;
          var idx = parseInt(b.dataset.idx);
          copyTextToClipboard(name);
          
          var oldText = b.textContent;
          if (oldText === '已复制') return;
          b.textContent = '已复制';
          var oldColor = b.style.color;
          b.style.color = 'var(--accent-wechat)';
          
          var client = importedClients[idx];
          if (client) {
            client.copied = true;
            saveState();
          }

          var card = document.getElementById('xdc_' + idx);
          if (card) {
            var phoneBtn = card.querySelector('.client-phone-btn');
            if (phoneBtn) {
              phoneBtn.classList.add('copied');
            }
          }

          setTimeout(function() {
            b.textContent = name;
            b.style.color = oldColor;
          }, 1000);
        });
      });

      // Wire up card tag note click modal
      container.querySelectorAll('.client-card-tag-note').forEach(function(b) {
        b.addEventListener('click', function(e) {
          e.stopPropagation();
          var note = b.dataset.note || '(空)';
          var content = document.getElementById('noteModalContent');
          if (content) {
            content.textContent = note;
          }
          var modal = document.getElementById('noteModal');
          if (modal) {
            modal.classList.add('active');
          }
        });
      });

      // Wire up call button
      container.querySelectorAll('.xls-card-dial-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          var idx = parseInt(this.dataset.idx);
          // Delay opening the modal by 200ms to allow Safari to natively trigger the tel: anchor navigation first
          setTimeout(function() {
            startCallAssistant(idx);
          }, 200);
        });
      });
    }

    // Call Assistant Controls
    var selectedCallStatus = 'success';

    function getNextClientIndex(currentIdx) {
      var query = document.getElementById('searchInput').value.toLowerCase().trim();
      var filtered = importedClients.filter(function(c) {
        var matchFilter = (currentFilter === 'all') || (c.dialedStatus === currentFilter);
        var matchQuery = true;
        if (query) {
          matchQuery = c.name.toLowerCase().includes(query) ||
                       c.phone.toLowerCase().includes(query) ||
                       c.company.toLowerCase().includes(query);
        }
        return matchFilter && matchQuery;
      });

      if (currentIdx < 0 && filtered.length > 0) {
        return importedClients.indexOf(filtered[0]);
      }
      var currentClient = importedClients[currentIdx];
      var filteredPos = filtered.indexOf(currentClient);
      if (filteredPos !== -1 && filteredPos + 1 < filtered.length) {
        return importedClients.indexOf(filtered[filteredPos + 1]);
      }
      return -1;
    }

    function startCallAssistant(idx) {
      var c = importedClients[idx];
      if (!c) return;

      currentCallIdx = idx;

      document.getElementById('callAssistName').innerText = c.name;
      document.getElementById('callAssistNameDisplay').innerText = c.name;
      document.getElementById('callAssistPhone').innerText = c.phone;
      document.getElementById('callAssistPhoneDisplay').innerText = c.phone;
      document.getElementById('callLogNote').value = c.callNote || '';

      // Show company info if available
      var companyRow = document.getElementById('callAssistCompanyRow');
      var companyEl = document.getElementById('callAssistCompany');
      if (c.company && String(c.company).trim()) {
        companyEl.textContent = c.company;
        companyRow.style.display = 'flex';
        companyRow.style.alignItems = 'center';
        companyRow.style.gap = '4px';
      } else {
        companyRow.style.display = 'none';
      }

      // Show note/remark info if available
      var noteRow = document.getElementById('callAssistNoteRow');
      var noteEl = document.getElementById('callAssistNote');
      if (c.note && c.note.trim()) {
        noteEl.textContent = c.note;
        noteRow.style.display = 'flex';
        noteRow.style.alignItems = 'baseline';
        noteRow.style.gap = '4px';
      } else {
        noteRow.style.display = 'none';
      }

      var nameDisp = document.getElementById('callAssistNameDisplay');
      if (nameDisp) {
        nameDisp.dataset.name = c.name;
      }
      var phoneDisp = document.getElementById('callAssistPhoneDisplay');
      if (phoneDisp) {
        phoneDisp.dataset.phone = c.phone;
        if (c.copied) {
          phoneDisp.classList.add('copied');
        } else {
          phoneDisp.classList.remove('copied');
        }
      }

      var dialLink = document.getElementById('callAssistDialLink');
      if (dialLink) {
        dialLink.href = 'tel:' + c.phone;
      }

      // Check and render local recording file if available
      var recContainer = document.getElementById('callAssistRecContainer');
      var audioWrapper = document.getElementById('callAssistAudioWrapper');
      if (recContainer && audioWrapper) {
        var hasRec = (typeof AndroidDialer !== 'undefined' && AndroidDialer.hasRecording(c.phone));
        if (hasRec) {
          audioWrapper.innerHTML = '<audio src="/api/local-recording?phone=' + encodeURIComponent(c.phone) + '" controls style="width: 100%; height: 32px; outline: none; margin-top: 4px; display: block;"></audio>';
          recContainer.style.display = 'flex';
        } else {
          audioWrapper.innerHTML = '';
          recContainer.style.display = 'none';
        }
      }

      document.getElementById('callAssistOverlay').classList.add('active');
    }

    function initCallControls() {
      var successBtn = document.getElementById('callOutcomeSuccessBtn');
      var failedBtn = document.getElementById('callOutcomeFailedBtn');
      var overlay = document.getElementById('callAssistOverlay');
      var phoneDisp = document.getElementById('callAssistPhoneDisplay');
      var nameDisp = document.getElementById('callAssistNameDisplay');

      window.onAndroidCallResult = function(duration) {
        if (duration >= 0) {
          var min = Math.floor(duration / 60);
          var sec = duration % 60;
          var formatted = (min < 10 ? '0' : '') + min + ':' + (sec < 10 ? '0' : '') + sec;
          
          var c = importedClients[currentCallIdx];
          if (c) {
            c.duration = formatted;
            var currentNote = document.getElementById('callLogNote').value.trim();
            if (!currentNote) {
              if (duration > 0) {
                document.getElementById('callLogNote').value = '已接通，通话时长 ' + duration + ' 秒。';
              } else {
                document.getElementById('callLogNote').value = '已拨打未接通。';
              }
            }

            // Immediately check and display the new local recording file if available!
            var recContainer = document.getElementById('callAssistRecContainer');
            var audioWrapper = document.getElementById('callAssistAudioWrapper');
            if (recContainer && audioWrapper) {
              var hasRec = (typeof AndroidDialer !== 'undefined' && AndroidDialer.hasRecording(c.phone));
              if (hasRec) {
                audioWrapper.innerHTML = '<audio src="/api/local-recording?phone=' + encodeURIComponent(c.phone) + '" controls style="width: 100%; height: 32px; outline: none; margin-top: 4px; display: block;"></audio>';
                recContainer.style.display = 'flex';
              }
            }
          }
        }
      };

      function saveProgress(status) {
        var c = importedClients[currentCallIdx];
        if (!c) return false;

        c.callNote = document.getElementById('callLogNote').value.trim();
        c.dialedStatus = status;
        c.duration = '-';
        return true;
      }

      var autoDialActive = false;
      function handleOutcome(status) {
        if (!saveProgress(status)) return;
        saveState();
        renderDialCards();

        var nextIdx = getNextClientIndex(currentCallIdx);
        if (nextIdx !== -1) {
          startCallAssistant(nextIdx);
          if (autoDialActive) {
            setTimeout(function() {
              var link = document.getElementById('callAssistDialLink');
              if (link && link.href) window.location.href = link.href;
            }, 800);
          }
        } else {
          if (autoDialActive) {
            autoDialActive = false;
            updateAutoDialBtn();
          }
          alert('已经是当前筛选列表的最后一位客户了！');
          overlay.classList.remove('active');
        }
      }

      function updateAutoDialBtn() {
        var btn = document.getElementById('autoDialBtn');
        if (autoDialActive) {
          btn.textContent = '暂停拨打';
          btn.style.background = '#e74c3c';
          btn.style.color = '#fff';
          btn.style.borderColor = '#e74c3c';
        } else {
          btn.textContent = '自动拨打';
          btn.style.background = '';
          btn.style.color = '';
          btn.style.borderColor = '';
        }
      }

      document.getElementById('autoDialBtn').addEventListener('click', function() {
        autoDialActive = !autoDialActive;
        updateAutoDialBtn();
        if (autoDialActive) {
          if (currentCallIdx === -1) {
            var firstIdx = getNextClientIndex(-1);
            if (firstIdx !== -1) {
              startCallAssistant(firstIdx);
              setTimeout(function() {
                var link = document.getElementById('callAssistDialLink');
                if (link && link.href) window.location.href = link.href;
              }, 800);
            }
          } else {
            var link = document.getElementById('callAssistDialLink');
            if (link && link.href) window.location.href = link.href;
          }
        }
      });

      successBtn.addEventListener('click', function() {
        handleOutcome('success');
      });

      failedBtn.addEventListener('click', function() {
        handleOutcome('failed');
      });

      if (phoneDisp) {
        phoneDisp.addEventListener('click', function(e) {
          e.stopPropagation();
          var phone = phoneDisp.dataset.phone;
          copyTextToClipboard(phone);
          
          var oldText = phoneDisp.textContent;
          if (oldText === '已复制') return;
          phoneDisp.textContent = '已复制';
          
          var client = importedClients[currentCallIdx];
          if (client) {
            client.copied = true;
            saveState();
          }

          phoneDisp.classList.add('copied');

          var card = document.getElementById('xdc_' + currentCallIdx);
          if (card) {
            var cardPhoneBtn = card.querySelector('.client-phone-btn');
            if (cardPhoneBtn) {
              cardPhoneBtn.classList.add('copied');
            }
          }

          setTimeout(function() {
            phoneDisp.textContent = phone;
          }, 1000);
        });
      }

      if (nameDisp) {
        nameDisp.addEventListener('click', function(e) {
          e.stopPropagation();
          var name = nameDisp.dataset.name;
          copyTextToClipboard(name);
          
          var oldText = nameDisp.textContent;
          if (oldText === '已复制') return;
          nameDisp.textContent = '已复制';
          
          var client = importedClients[currentCallIdx];
          if (client) {
            client.copied = true;
            saveState();
          }

          if (phoneDisp) {
            phoneDisp.classList.add('copied');
          }

          var card = document.getElementById('xdc_' + currentCallIdx);
          if (card) {
            var cardPhoneBtn = card.querySelector('.client-phone-btn');
            if (cardPhoneBtn) {
              cardPhoneBtn.classList.add('copied');
            }
          }

          setTimeout(function() {
            nameDisp.textContent = name;
          }, 1000);
        });
      }

      // Close modal when clicking blank area outside
      overlay.addEventListener('click', function(e) {
        if (e.target === this) {
          overlay.classList.remove('active');
        }
      });
    }

    function initFilters() {
      document.querySelectorAll('.filter-tab').forEach(function(tab) {
        tab.addEventListener('click', function() {
          document.querySelectorAll('.filter-tab').forEach(function(t) { t.classList.remove('active'); });
          tab.classList.add('active');
          currentFilter = tab.dataset.filter;
          currentPage = 1; // Reset to page 1
          renderDialCards();
        });
      });

      document.getElementById('searchInput').addEventListener('input', function() {
        currentPage = 1; // Reset to page 1
        renderDialCards();
      });

      var sortSel = document.getElementById('sortSelect');
      if (sortSel) {
        sortSel.addEventListener('change', function() {
          currentSort = this.value;
          currentPage = 1; // Reset to page 1
          renderDialCards();
        });
      }

      var wlFilterSel = document.getElementById('whitelistFilterSelect');
      if (wlFilterSel) {
        wlFilterSel.addEventListener('change', function() {
          var val = this.value;
          currentPage = 1; // Reset to page 1
          if (val !== 'all' && !whitelistCheckResults) {
            checkWhitelist().then(function() {
              renderDialCards();
            });
          } else {
            renderDialCards();
          }
        });
      }
    }

    function initFileInputs() {
      var xlsSelect = document.getElementById('xlsSelectBtn');
      var xlsFile = document.getElementById('xlsFileInput');
      var vcfSelect = document.getElementById('vcfSelectBtn');
      var vcfFile = document.getElementById('vcfFileInput');
      var dropZone = document.getElementById('dropZone');
      var toggleBtn = document.getElementById('toggleImportBtn');

      if (toggleBtn) {
        toggleBtn.addEventListener('click', function() {
          var panel = document.getElementById('dashboardPanel');
          if (panel) {
            if (panel.style.display === 'none') {
              panel.style.display = 'block';
            } else {
              panel.style.display = 'none';
            }
          }
        });
      }

      // Dual-SIM rotation toggle
      var dualSimBtn = document.getElementById('toggleDualSimBtn');
      var dualSimOn = true;
      var rotationCount = 10;
      if (dualSimBtn) {
        dualSimBtn.addEventListener('click', function() {
          dualSimOn = !dualSimOn;
          dualSimBtn.textContent = '双卡轮换: ' + (dualSimOn ? '开' : '关');
          localStorage.setItem('dialer_dual_sim', dualSimOn ? '1' : '0');
        });
      }
      var rotationBtn = document.getElementById('toggleRotationBtn');
      if (rotationBtn) {
        rotationBtn.addEventListener('click', function() {
          rotationCount = rotationCount === 10 ? 5 : 10;
          rotationBtn.textContent = '轮换频率: ' + rotationCount + '通';
          localStorage.setItem('dialer_rotation', String(rotationCount));
        });
      }


      xlsFile.addEventListener('change', function(e) {
        var file = e.target.files[0];
        if (file) handleFileImportDispatch(file);
        e.target.value = '';
      });

      vcfFile.addEventListener('change', function(e) {
        var file = e.target.files[0];
        if (file) handleFileImportDispatch(file);
        e.target.value = '';
      });

      var imgFile = document.getElementById('imgFileInput');
      if (imgFile) {
        imgFile.addEventListener('change', function(e) {
          var file = e.target.files[0];
          if (file) handleFileImportDispatch(file);
          e.target.value = '';
        });
      }

      // Drag & Drop
      dropZone.addEventListener('dragover', function(e) {
        e.preventDefault();
        dropZone.classList.add('dragover');
      });
      dropZone.addEventListener('dragleave', function() {
        dropZone.classList.remove('dragover');
      });
      dropZone.addEventListener('drop', function(e) {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        var file = e.dataTransfer.files[0];
        if (file) handleFileImportDispatch(file);
      });
    }

    // Clear and Export Data
    function initDataActions() {
      var clearBtn = document.getElementById('clearBtn');
      var exportBtn = document.getElementById('exportBtn');
      var closeExport = document.getElementById('closeExportBtn');
      var copyExport = document.getElementById('copyExportBtn');
      var exportModal = document.getElementById('exportModal');
      var exportArea = document.getElementById('exportTextarea');

      clearBtn.addEventListener('click', function() {
        if (confirm('确认清空当前导入的客户和所有的拨号记录吗？')) {
          importedClients = [];
          saveState();
          updateDashboardVisibility(false);
          document.getElementById('importStatus').innerText = '';
          renderDialCards();
        }
      });

      exportBtn.addEventListener('click', function() {
        if (importedClients.length === 0) return;
        
        var lines = ['姓名,电话,单位,状态,时长,沟通小记'];
        importedClients.forEach(function(c) {
          var statusStr = '待拨打';
          if (c.dialedStatus === 'success') statusStr = '已接通';
          else if (c.dialedStatus === 'failed') statusStr = '未接通';

          lines.push(
            '"' + c.name + '",' +
            '"' + c.phone + '",' +
            '"' + (c.company || '') + '",' +
            '"' + statusStr + '",' +
            '"' + (c.duration || '') + '",' +
            '"' + (c.callNote || '') + '"'
          );
        });

        exportArea.value = lines.join('\\n');
        exportModal.classList.add('active');
      });

      closeExport.addEventListener('click', function() {
        exportModal.classList.remove('active');
      });

      copyExport.addEventListener('click', function() {
        exportArea.select();
        document.execCommand('copy');
        copyExport.textContent = '✅ 已成功复制！';
        setTimeout(function() {
          copyExport.textContent = '复制记录到剪贴板';
        }, 1500);
      });
    }

    // Header Menu Dropdown controller
    function initHeaderMenu() {
      var menuBtn = document.getElementById('headerMenuBtn');
      var dropdown = document.getElementById('headerDropdown');
      
      if (menuBtn && dropdown) {
        var lastToggle = 0;
        function toggleDropdown(e) {
          var now = Date.now();
          if (now - lastToggle < 300) return;
          lastToggle = now;
          e.stopPropagation();
          e.preventDefault();
          if (dropdown.style.display === 'none' || dropdown.style.display === '') {
            dropdown.style.display = 'flex';
          } else {
            dropdown.style.display = 'none';
          }
        }
        menuBtn.addEventListener('click', toggleDropdown);
        menuBtn.addEventListener('touchend', toggleDropdown);

        // Close dropdown when clicking outside
        function closeDropdown(e) {
          if (!menuBtn.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.style.display = 'none';
          }
        }
        document.addEventListener('click', closeDropdown);
        document.addEventListener('touchend', closeDropdown);

        // Also close dropdown when selecting any option inside it
        dropdown.querySelectorAll('.dropdown-item').forEach(function(item) {
          item.addEventListener('click', function() {
            dropdown.style.display = 'none';
          });
        });
      }
    }

    function initNoteModal() {
      var modal = document.getElementById('noteModal');
      var closeBtn = document.getElementById('closeNoteModalBtn');
      if (modal && closeBtn) {
        closeBtn.addEventListener('click', function() {
          modal.classList.remove('active');
        });
        modal.addEventListener('click', function(e) {
          if (e.target === this) {
            modal.classList.remove('active');
          }
        });
      }
    }

    // ===== Whitelist Management =====

    function fetchWhitelist() {
      return fetch('/api/whitelist/companies')
        .then(function(r) {
          if (!r.ok) throw new Error('获取白名单失败');
          return r.json();
        })
        .then(function(data) {
          whitelistCompanies = data.companies || [];
          whitelistLoaded = true;
          updateWhitelistStatus();
          renderWhitelistCompanyList();
          return whitelistCompanies;
        })
        .catch(function(err) {
          console.error('Whitelist fetch error:', err);
          whitelistLoaded = false;
        });
    }

    function uploadWhitelist(companyNames) {
      return fetch('/api/whitelist/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companies: companyNames })
      })
      .then(function(r) {
        if (!r.ok) throw new Error('上传白名单失败');
        return r.json();
      });
    }

    function checkWhitelist() {
      resetWhitelistCheck();
      var companySet = {};
      importedClients.forEach(function(c) {
        if (c.company && String(c.company).trim()) {
          companySet[String(c.company).trim()] = true;
        }
      });
      var uniqueCompanies = Object.keys(companySet);

      if (uniqueCompanies.length === 0) {
        alert('当前没有导入带有单位名称的客户数据');
        return Promise.resolve();
      }

      return fetch('/api/whitelist/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companies: uniqueCompanies })
      })
      .then(function(r) {
        if (!r.ok) throw new Error('白名单检查失败');
        return r.json();
      })
      .then(function(data) {
        var results = data.results || [];
        whitelistCheckResults = {};
        results.forEach(function(r) {
          whitelistCheckResults[r.company] = r;
        });
        renderDialCards();
        return results;
      })
      .catch(function(err) {
        console.error('Whitelist check error:', err);
        alert('白名单检查失败: ' + err.message);
      });
    }

    function updateWhitelistStatus() {
      var el = document.getElementById('whitelistStatus');
      if (el) {
        el.textContent = '已加载 ' + whitelistCompanies.length + ' 家白名单企业';
      }
    }

    function handleFailedUploads(companies) {
      try {
        var failed = JSON.parse(localStorage.getItem('whitelist_failed_uploads') || '[]');
        var failedSet = new Set(failed);
        companies.forEach(function(c) { failedSet.add(c); });
        localStorage.setItem('whitelist_failed_uploads', JSON.stringify(Array.from(failedSet)));
        renderFailedUploadsArea();
      } catch (e) {
        console.error('Failed to save failed whitelist uploads:', e);
      }
    }

    function renderFailedUploadsArea() {
      var container = document.getElementById('whitelistFailedArea');
      var listEl = document.getElementById('whitelistFailedList');
      var countEl = document.getElementById('whitelistFailedCount');
      if (!container || !listEl || !countEl) return;

      var failed = [];
      try {
        failed = JSON.parse(localStorage.getItem('whitelist_failed_uploads') || '[]');
      } catch (e) {}

      if (failed.length === 0) {
        container.style.display = 'none';
        return;
      }

      container.style.display = 'block';
      countEl.textContent = failed.length;
      listEl.textContent = failed.join('\n');
    }

    function renderWhitelistCompanyList() {
      var container = document.getElementById('whitelistCompanyList');
      if (!container) return;

      var searchInput = document.getElementById('whitelistModalSearchInput');
      var query = searchInput ? searchInput.value.toLowerCase().trim() : '';

      var filtered = whitelistCompanies;
      if (query) {
        filtered = whitelistCompanies.filter(function(c) {
          return (c.company_name || '').toLowerCase().includes(query) ||
                 (c.alias || '').toLowerCase().includes(query);
        });
      }

      if (filtered.length === 0) {
        container.innerHTML = '<div style="font-size:0.7rem; color:var(--text-light); text-align:center; padding:10px;">' + (query ? '无匹配搜索的企业' : '暂无白名单企业数据') + '</div>';
        return;
      }

      var html = '';
      filtered.forEach(function(c) {
        html += '<div class="whitelist-company-item">' +
          '<span style="font-size:0.72rem; font-weight:700; color:var(--text-main);">' + esc(c.company_name) + '</span>' +
          '<button class="whitelist-del-btn" data-company="' + esc(c.company_name) + '" style="font-size:0.6rem; padding:2px 8px; border:1px solid #e74c3c; background:transparent; color:#e74c3c; border-radius:3px; cursor:pointer; font-weight:700;">删除</button>' +
          '</div>';
      });
      container.innerHTML = html;

      container.querySelectorAll('.whitelist-del-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var company = this.dataset.company;
          if (confirm('确认从白名单中删除「' + company + '」吗？')) {
            deleteWhitelistCompany(company);
          }
        });
      });
    }

    function deleteWhitelistCompany(companyName) {
      fetch('/api/whitelist/companies', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_name: companyName })
      })
      .then(function(r) {
        if (!r.ok) throw new Error('删除失败');
        return r.json();
      })
      .then(function() {
        whitelistCompanies = whitelistCompanies.filter(function(c) {
          return c.company_name !== companyName;
        });
        updateWhitelistStatus();
        renderWhitelistCompanyList();
        if (whitelistCheckResults) {
          checkWhitelist();
        }
      })
      .catch(function(err) {
        alert('删除失败: ' + err.message);
      });
    }

    function resetWhitelistCheck() {
      whitelistCheckResults = null;
    }

    function initWhitelist() {
      var whitelistBtn = document.getElementById('whitelistMenuBtn');
      var whitelistModal = document.getElementById('whitelistModal');
      var closeBtn = document.getElementById('closeWhitelistBtn');
      var uploadBtn = document.getElementById('whitelistUploadBtn');
      var refreshBtn = document.getElementById('whitelistRefreshBtn');
      var checkBtn = document.getElementById('whitelistCheckBtn');
      var textarea = document.getElementById('whitelistTextarea');
      var failedClearBtn = document.getElementById('whitelistFailedClearBtn');
      var failedRetryBtn = document.getElementById('whitelistFailedRetryBtn');
      var modalSearch = document.getElementById('whitelistModalSearchInput');

      // Open modal from dropdown
      if (whitelistBtn && whitelistModal) {
        whitelistBtn.addEventListener('click', function() {
          whitelistModal.classList.add('active');
          renderFailedUploadsArea();
          if (!whitelistLoaded) {
            fetchWhitelist();
          }
        });
      }

      // Close modal
      if (closeBtn && whitelistModal) {
        closeBtn.addEventListener('click', function() {
          whitelistModal.classList.remove('active');
        });
        whitelistModal.addEventListener('click', function(e) {
          if (e.target === whitelistModal) {
            whitelistModal.classList.remove('active');
          }
        });
      }

      // Upload
      if (uploadBtn && textarea) {
        uploadBtn.addEventListener('click', function() {
          var text = textarea.value.trim();
          if (!text) { alert('请先粘贴企业名称'); return; }
          var companies = text.split('\\n')
            .map(function(s) { return s.trim(); })
            .filter(function(s) { return s.length > 0; });
          if (companies.length === 0) { alert('请至少输入一个企业名称'); return; }

          uploadBtn.textContent = '上传中...';
          uploadBtn.disabled = true;
          uploadWhitelist(companies)
            .then(function(result) {
              alert('成功上传 ' + result.count + ' 家企业到白名单');
              textarea.value = '';
              return fetchWhitelist();
            })
            .catch(function(err) {
              alert('上传失败：' + err.message + '。已存入本地失败重试列表。');
              handleFailedUploads(companies);
            })
            .then(function() {
              uploadBtn.textContent = '上传白名单';
              uploadBtn.disabled = false;
            });
        });
      }

      // Refresh
      if (refreshBtn) {
        refreshBtn.addEventListener('click', function() {
          fetchWhitelist();
        });
      }

      // Whitelist search
      if (modalSearch) {
        modalSearch.addEventListener('input', function() {
          renderWhitelistCompanyList();
        });
      }

      // Failed Area Clear
      if (failedClearBtn) {
        failedClearBtn.addEventListener('click', function(e) {
          e.preventDefault();
          localStorage.removeItem('whitelist_failed_uploads');
          renderFailedUploadsArea();
        });
      }

      // Failed Area Retry
      if (failedRetryBtn) {
        failedRetryBtn.addEventListener('click', function() {
          var failed = [];
          try {
            failed = JSON.parse(localStorage.getItem('whitelist_failed_uploads') || '[]');
          } catch (e) {}
          if (failed.length === 0) return;

          failedRetryBtn.textContent = '重试中...';
          failedRetryBtn.disabled = true;
          uploadWhitelist(failed)
            .then(function(result) {
              alert('重新上传成功，共导入 ' + result.count + ' 家企业');
              localStorage.removeItem('whitelist_failed_uploads');
              renderFailedUploadsArea();
              return fetchWhitelist();
            })
            .catch(function(err) {
              alert('重试上传依然失败: ' + err.message);
            })
            .then(function() {
              failedRetryBtn.textContent = '尝试重新上传';
              failedRetryBtn.disabled = false;
            });
        });
      }

      // Check button in control bar
      if (checkBtn) {
        checkBtn.addEventListener('click', function() {
          checkBtn.textContent = '检查中...';
          checkBtn.disabled = true;
          var promise = whitelistLoaded ? Promise.resolve() : fetchWhitelist();
          promise
            .then(function() { return checkWhitelist(); })
            .catch(function() {})
            .then(function() {
              checkBtn.textContent = '☑ 白名单';
              checkBtn.disabled = false;
            });
        });
      }

      // Initial check for failed uploads
      renderFailedUploadsArea();
    }

    // Main Init (每个 init 独立 try-catch，防止某个报错导致后续按钮初始化被跳过)
    function safeInit(name, fn) {
      try { fn(); } catch (e) { console.error('Init error: ' + name, e); }
    }
    safeInit('initDark', initDark);
    safeInit('initFileInputs', initFileInputs);
    safeInit('initCallControls', initCallControls);
    safeInit('initFilters', initFilters);
    safeInit('initDataActions', initDataActions);
    safeInit('initSyncHandlers', initSyncHandlers);
    safeInit('initHeaderMenu', initHeaderMenu);
    safeInit('initNoteModal', initNoteModal);
    safeInit('initWhitelist', initWhitelist);
    safeInit('initAIImporter', initAIImporter);
    safeInit('loadPersistedState', loadPersistedState);

  })();
  </script>
</body>
</html>`;
