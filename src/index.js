// 每日工作 - Cloudflare Worker 版本
// 部署后绑定 DATA_KV 即可使用

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ==================== API 接口 ====================
    
    // 获取数据
    if (path === '/api/data' && request.method === 'GET') {
      const date = url.searchParams.get('date');
      if (!date) {
        return new Response(JSON.stringify({ error: '缺少 date 参数' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const rawData = await env.DATA_KV.get(`work:${date}`);
      const data = rawData ? JSON.parse(rawData) : {
        date,
        wechatCount: 0,
        intentCount: 0,
        clients: [],
        todayTodos: [],
        tomorrowTodos: [],
        lastLoadDate: date
      };
      if (!data.lastLoadDate) data.lastLoadDate = date;
      return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 保存数据
    if (path === '/api/data' && request.method === 'POST') {
      const body = await request.json();
      const { date, wechatCount, intentCount, clients, todayTodos, tomorrowTodos, scripts, learns, scriptsVer, learnsVer, clientsVer, todoLog } = body;
      if (!date) {
        return new Response(JSON.stringify({ error: '缺少 date 参数' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const data = {
        date,
        wechatCount: wechatCount || 0,
        intentCount: intentCount || 0,
        clients: clients || [],
        todayTodos: todayTodos || [],
        tomorrowTodos: tomorrowTodos || [],
        scripts: scripts || [],
        scriptsVer: scriptsVer || 0,
        learns: learns || [],
        learnsVer: learnsVer || 0,
        clientsVer: clientsVer || {},
        todoLog: todoLog || [],
        lastLoadDate: date,
        lastModified: new Date().toISOString()
      };
      await env.DATA_KV.put(`work:${date}`, JSON.stringify(data));
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 获取日历数据
    if (path === '/api/calendar' && request.method === 'GET') {
      const month = url.searchParams.get('month');
      if (!month) {
        return new Response(JSON.stringify({ error: '缺少 month 参数' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const list = await env.DATA_KV.list({ prefix: `work:${month}` });
      const calendar = {};
      for (const key of list.keys) {
        const rawData = await env.DATA_KV.get(key.name);
        if (rawData) {
          const d = JSON.parse(rawData);
          const dateKey = key.name.replace('work:', '');
          calendar[dateKey] = {
            w: d.wechatCount || 0,
            i: d.intentCount || 0
          };
        }
      }
      return new Response(JSON.stringify(calendar), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 获取周/月统计
    if (path === '/api/stats' && request.method === 'GET') {
      const month = url.searchParams.get('month');
      if (!month) {
        return new Response(JSON.stringify({ error: '缺少 month 参数' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const list = await env.DATA_KV.list({ prefix: `work:${month}` });
      let weekW = 0, monthW = 0, weekI = 0, monthI = 0;
      const today = new Date();
      const dow = today.getDay();
      const diff = (dow === 0 ? 6 : dow - 1);
      const mon = new Date(today);
      mon.setDate(today.getDate() - diff);
      const monStr = `${mon.getFullYear()}-${String(mon.getMonth()+1).padStart(2,'0')}-${String(mon.getDate()).padStart(2,'0')}`;
      const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
      for (const key of list.keys) {
        const rawData = await env.DATA_KV.get(key.name);
        if (rawData) {
          const d = JSON.parse(rawData);
          monthW += d.wechatCount || 0;
          monthI += d.intentCount || 0;
          if (d.date >= monStr && d.date <= todayStr) {
            weekW += d.wechatCount || 0;
            weekI += d.intentCount || 0;
          }
        }
      }
      return new Response(JSON.stringify({ weekW, monthW, weekI, monthI }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }


    // 导出数据并发送企业微信 webhook
    if (path === '/api/export' && request.method === 'POST') {
      const body = await request.json();
      const { type, webhookUrl } = body;
      if (!type || !webhookUrl) {
        return new Response(JSON.stringify({ error: '缺少参数' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const today = new Date();
      const dow = today.getDay();
      const diff = dow === 0 ? 6 : dow - 1;
      const mon = new Date(today);
      mon.setDate(today.getDate() - diff);
      const monStr = mon.getFullYear() + '-' + String(mon.getMonth()+1).padStart(2,'0') + '-' + String(mon.getDate()).padStart(2,'0');
      const todayStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
      const monthPrefix = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0');

      const list = await env.DATA_KV.list({ prefix: 'work:' + monthPrefix });
      let weekW = 0, monthW = 0, weekI = 0, monthI = 0;
      const sorted = [];
      for (const key of list.keys) {
        const rawData = await env.DATA_KV.get(key.name);
        if (!rawData) continue;
        const d = JSON.parse(rawData);
        sorted.push(d);
        monthW += d.wechatCount || 0;
        monthI += d.intentCount || 0;
        if (d.date >= monStr && d.date <= todayStr) {
          weekW += d.wechatCount || 0;
          weekI += d.intentCount || 0;
        }
      }
      sorted.sort((a,b) => (a.date||'').localeCompare(b.date||''));

      const weekNames = ['日', '一', '二', '三', '四', '五', '六'];
      const title = type === 'week' ? '📊 本周数据统计' : '📊 本月数据统计';
      const dateRange = type === 'week'
        ? monStr + ' ～ ' + todayStr
        : monthPrefix + '-01 ～ ' + todayStr;
      const wTotal = type === 'week' ? weekW : monthW;
      const iTotal = type === 'week' ? weekI : monthI;

      let text = title + '\n\n' + dateRange + '\n\n\n';
      text += '💬 新增微信：**' + wTotal + '**    🎯 新增意向：**' + iTotal + '**\n';
      if (type !== 'week') {
        text += '（💬 本周微信：**' + weekW + '**    🎯 本周意向：**' + weekI + '**）\n';
      }
      text += '\n\n| 日期 | 周 | 💬 | 🎯 | 意向详情 |\n|------|----|----|----|----------|\n';
      for (const d of sorted) {
        if (type === 'week' && (d.date < monStr || d.date > todayStr)) continue;
        const datePart = d.date.slice(5);
        const wk = '周' + weekNames[new Date(d.date + 'T00:00:00').getDay()];
        const w = d.wechatCount || 0;
        const it = d.intentCount || 0;
        const detail = (d.clients || []).map(c => c.name + (c.note ? '（' + c.note + '）' : '')).join('、') || '-';
        text += '| ' + datePart + ' | ' + wk + ' | ' + w + ' | ' + it + ' | ' + detail + ' |\n';
      }
      try {
        const whResp = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msgtype: 'markdown', markdown: { content: text } })
        });
        if (whResp.ok) {
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
      } catch (e) {}
      return new Response(JSON.stringify({ error: 'webhook 发送失败' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // ==================== HTML 页面 ====================
    
    const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=yes, viewport-fit=cover, shrink-to-fit=no">
  <title>每日工作</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg-app: #f4f7fc;
      --card-bg: rgba(255,255,255,0.85);
      --card-border: #e2edf2;
      --text-main: #1f3a4b;
      --text-soft: #4b6f86;
      --text-light: #7f9aae;
      --accent-wechat: #2c7da0;
      --accent-intent: #2f9e68;
      --accent-wechat-bg: #eef3fc;
      --accent-intent-bg: #edfaf3;
      --btn-bg: rgba(255,255,255,0.8);
      --btn-hover: #eef2f5;
      --shadow-card: 0 6px 14px rgba(0,0,0,0.05), 0 2px 4px rgba(0,0,0,0.05);
      --cal-hover: #e9f0f5;
      --cal-today: #e3edf5;
      --border-light: #e2eef5;
      --tooltip-bg: #1e2f3c;
      --tooltip-text: #f0f6fa;
      --modal-bg: rgba(30,35,48,0.75);
      --modal-card: #fff;
      --radius-ios: 10px;
      --radius-sm: 8px;
      --radius-xs: 6px;
      --wechat-gradient: linear-gradient(135deg, #a8e6cf 0%, #56c596 50%, #2d9a6c 100%);
      --intent-gradient: linear-gradient(135deg, #ffd194 0%, #ff9a3c 50%, #ff6d00 100%);
      --today-gradient: linear-gradient(135deg, #ffecd2 0%, #fcb69f 50%, #ff8a65 100%);
      --stats-gradient: linear-gradient(135deg, #e0f7fa 0%, #b2ebf2 50%, #4dd0e1 100%);
      --wallpaper-url: '';
      --wallpaper-opacity: 0.23;
    }
    body.dark-mode {
      --bg-app: rgba(17,22,31,0.85);
      --card-bg: rgba(30,41,56,0.82);
      --card-border: #2d3a4a;
      --text-main: #eef3fc;
      --text-soft: #afc4dc;
      --text-light: #829ab0;
      --accent-wechat: #8fb9d4;
      --accent-intent: #9aceb0;
      --btn-bg: rgba(40,50,63,0.8);
      --btn-hover: #2f3c4b;
      --cal-hover: #26303e;
      --cal-today: #1e3142;
      --border-light: #2a3848;
      --tooltip-bg: #eef3fc;
      --tooltip-text: #11161f;
      --modal-bg: rgba(0,0,0,0.8);
      --modal-card: #1e2938;
      --wechat-gradient: linear-gradient(135deg, #1b4332 0%, #2d6a4f 50%, #40916c 100%);
      --intent-gradient: linear-gradient(135deg, #4a2500 0%, #7c3a00 50%, #b85c00 100%);
      --today-gradient: linear-gradient(135deg, #3e1a0a 0%, #6b2f14 50%, #a0421e 100%);
      --stats-gradient: linear-gradient(135deg, #0d3b4a 0%, #1a5c6e 50%, #2a7d8f 100%);
      --wallpaper-opacity: 0.19;
    }
    html, body { height: 100%; width: 100%; overflow: hidden; background: var(--bg-app); font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Helvetica Neue", "PingFang SC", sans-serif; font-weight: 600; transition: background 0.3s; position: relative; }
    .wallpaper-background { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 0; background-image: var(--wallpaper-url); background-size: cover; background-position: center; background-repeat: no-repeat; opacity: var(--wallpaper-opacity); transition: opacity 0.8s ease, background-image 0.8s ease; pointer-events: none; }
    body.dark-mode .wallpaper-background { opacity: 0.19; }
    .wallpaper-fallback { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); opacity: 0.18; pointer-events: none; }
    body.dark-mode .wallpaper-fallback { background: linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%); opacity: 0.35; }
    .privacy-mask { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.3); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); z-index: 9999; flex-direction: column; justify-content: center; align-items: center; gap: 2rem; color: var(--text-main); font-weight: 600; pointer-events: none; }
    .privacy-wallpaper { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 9998; background-image: var(--wallpaper-url); background-size: cover; background-position: center; background-repeat: no-repeat; opacity: 0; transition: opacity 0.5s ease; pointer-events: none; }
    body.page-hidden .privacy-wallpaper { opacity: 0.85; pointer-events: auto; }
    body.dark-mode.page-hidden .privacy-wallpaper { opacity: 0.80; }
    body.page-hidden .privacy-mask { display: flex; pointer-events: auto; }
    body.page-hidden .app-shell { display: none; }
    .pin-box { display: flex; flex-direction: column; align-items: center; gap: 16px; background: rgba(255,255,255,0.75); padding: 32px 40px; border-radius: var(--radius-ios); box-shadow: 0 25px 60px rgba(0,0,0,0.15), 0 0 0 1px rgba(255,255,255,0.3); border: 1px solid rgba(255,255,255,0.5); min-width: 320px; max-width: 420px; backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); transition: all 0.3s ease; }
    body.dark-mode .pin-box { background: rgba(30,41,56,0.8); border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 25px 60px rgba(0,0,0,0.3); }
    .pin-stats { display: flex; gap: 16px; }
    .pin-stat-item { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 12px 18px; background: rgba(255,255,255,0.6); border-radius: var(--radius-sm); border: 1px solid rgba(255,255,255,0.5); min-width: 100px; backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
    body.dark-mode .pin-stat-item { background: rgba(40,50,63,0.6); border: 1px solid rgba(255,255,255,0.08); }
    .pin-stat-label { font-size: 0.7rem; font-weight: 700; color: var(--text-soft); letter-spacing: 0.5px; }
    .pin-stat-value { font-size: 2rem; font-weight: 900; line-height: 1; }
    .pin-wechat-value { background: var(--wechat-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .pin-intent-value { background: var(--intent-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .pin-input { width: 140px; padding: 8px 14px; border-radius: var(--radius-xs); border: 1.5px solid rgba(200,210,220,0.5); background: rgba(255,255,255,0.5); text-align: center; font-size: 1rem; letter-spacing: 5px; color: var(--text-main); outline: none; font-weight: 700; transition: all 0.3s; backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
    body.dark-mode .pin-input { background: rgba(40,50,63,0.5); border-color: rgba(255,255,255,0.15); }
    .pin-input:focus { border-color: var(--accent-wechat); box-shadow: 0 0 0 4px rgba(44,125,160,0.15); background: rgba(255,255,255,0.7); }
    .pin-btn { background: var(--accent-wechat); border: none; color: white; padding: 8px 32px; border-radius: var(--radius-xs); font-weight: 700; cursor: pointer; font-size: 0.8rem; letter-spacing: 1px; transition: all 0.2s; box-shadow: 0 4px 15px rgba(44,125,160,0.3); }
    .pin-btn:hover { opacity: 0.9; transform: translateY(-2px); box-shadow: 0 6px 20px rgba(44,125,160,0.4); }
    .pin-btn:active { transform: translateY(0); }
    .pin-error { color: #e74c3c; font-size: 0.9rem; min-height: 24px; font-weight: 600; letter-spacing: 0.5px; }
    .notify-bar { position: fixed; top: 0; left: 0; right: 0; background: var(--accent-intent); color: #fff; padding: 12px 20px; font-size: 0.85rem; font-weight: 700; z-index: 10000; transform: translateY(-100%); transition: transform 0.3s ease; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.2); cursor: pointer; }
    .notify-bar.show { transform: translateY(0); }
    .notify-bar .notify-close { position: absolute; right: 14px; top: 50%; transform: translateY(-50%); font-size: 1.1rem; opacity: 0.7; }
    .script-container { position: absolute; left: 20px; top: 80px; display: flex; flex-direction: column; gap: 10px; max-width: 420px; z-index: 1; }
    .script-module { text-align: center; padding: 16px 24px; background: rgba(255,255,255,0.75); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); border-radius: var(--radius-ios); border: 1px solid rgba(255,255,255,0.5); box-shadow: 0 25px 60px rgba(0,0,0,0.15), 0 0 0 1px rgba(255,255,255,0.3); cursor: grab; user-select: none; position: relative; font-size: 1rem; font-weight: 700; color: var(--text-main); line-height: 1.7; letter-spacing: 0.5px; }
    body.dark-mode .script-module { background: rgba(30,41,56,0.8); border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 25px 60px rgba(0,0,0,0.3); }
    .learn-container { position: absolute; right: 20px; top: 80px; display: flex; flex-direction: column; gap: 10px; max-width: 460px; z-index: 1; }
    .learn-module { padding: 16px 20px; background: rgba(255,255,255,0.75); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); border-radius: var(--radius-ios); border: 1px solid rgba(255,255,255,0.5); box-shadow: 0 25px 60px rgba(0,0,0,0.15), 0 0 0 1px rgba(255,255,255,0.3); cursor: grab; user-select: none; position: relative; font-size: 0.85rem; font-weight: 400; color: var(--text-main); line-height: 1.8; letter-spacing: 0.2px; text-align: left; white-space: pre-wrap; word-break: break-word; }
    body.dark-mode .learn-module { background: rgba(30,41,56,0.8); border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 25px 60px rgba(0,0,0,0.3); }
    .learn-check-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 0.8rem; color: var(--text-soft); font-weight: 600; }
    .learn-check-row input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--accent-wechat); cursor: pointer; }
    .script-input-modal { max-width: 460px; }
    .script-input-modal textarea { width: 100%; min-height: 100px; background: var(--btn-bg); border: 1px solid var(--card-border); border-radius: var(--radius-xs); padding: 12px 16px; font-size: 0.85rem; color: var(--text-main); outline: none; resize: vertical; font-weight: 600; line-height: 1.6; }
    .script-input-modal textarea:focus { border-color: var(--accent-wechat); }
    .script-list { max-height: 180px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
    .script-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--btn-bg); border-radius: var(--radius-xs); border: 1px solid var(--card-border); font-size: 0.78rem; color: var(--text-main); font-weight: 600; }
    .script-item-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 8px; }
    .app-shell { height: 100%; width: 100%; display: flex; flex-direction: column; overflow: hidden; position: relative; z-index: 1; }
    .container { flex: 1; display: flex; flex-direction: column; padding: 14px 18px 12px; overflow-y: auto; scrollbar-width: thin; -webkit-overflow-scrolling: touch; }
    .header-bar { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 20px; padding-bottom: 6px; border-bottom: 1px solid var(--border-light); flex-shrink: 0; }
    .title-section { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
    h3 { font-size: 1.45rem; font-weight: 800; letter-spacing: -0.2px; color: var(--text-main); }
    .date-chip { background: var(--card-bg); padding: 4px 12px; border-radius: var(--radius-xs); font-size: 0.75rem; font-weight: 700; color: var(--text-soft); border: 1px solid var(--card-border); }
    .action-group { display: flex; gap: 10px; align-items: center; padding: 2px; }
    .icon-simple { background: rgba(255,255,255,0.08); border: 1.2px solid rgba(179,179,179,0.15); width: 38px; height: 38px; border-radius: var(--radius-xs); display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 1.1rem; color: var(--text-soft); transition: all 0.2s cubic-bezier(0.34,1.56,0.64,1); user-select: none; font-weight: 600; backdrop-filter: blur(8px); position: relative; }
    .icon-simple:hover { background: rgba(255,255,255,0.12); transform: translateY(-2px) scale(1.06); border-color: rgba(179,179,179,0.25); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
    .icon-simple:active { transform: translateY(0px) scale(0.98); }
    .two-columns { display: flex; gap: 20px; flex: 1; min-height: 0; }
    .left-area { flex: 1.2; display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    .right-area { flex: 2.2; display: flex; flex-direction: column; gap: 18px; min-width: 0; }
    .card { background: var(--card-bg); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border-radius: var(--radius-ios); border: 1px solid var(--card-border); box-shadow: var(--shadow-card); padding: 18px 20px; }
    .counter-row { display: flex; gap: 14px; }
    .counter-card { flex: 1; border-radius: var(--radius-sm); padding: 12px; border: 1px solid var(--card-border); position: relative; overflow: hidden; }
    .counter-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0; opacity: 0.15; z-index: 0; border-radius: var(--radius-sm); }
    .wechat-fill { background: var(--wechat-gradient); color: white; }
    .wechat-fill::before { background: var(--wechat-gradient); }
    .intent-fill { background: var(--intent-gradient); color: white; }
    .intent-fill::before { background: var(--intent-gradient); }
    .counter-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; position: relative; z-index: 1; }
    .counter-label { font-size: 0.8rem; font-weight: 700; color: rgba(255,255,255,0.95); text-shadow: 0 1px 2px rgba(0,0,0,0.1); }
    .reset-mini { background: rgba(255,255,255,0.3); border: none; font-size: 0.7rem; color: rgba(255,255,255,0.9); cursor: pointer; padding: 4px 8px; border-radius: var(--radius-xs); font-weight: 600; position: relative; z-index: 1; backdrop-filter: blur(4px); }
    .counter-value { font-size: 2.8rem; font-weight: 800; line-height: 1; color: white; text-shadow: 0 2px 4px rgba(0,0,0,0.15); position: relative; z-index: 1; }
    .button-group { display: flex; gap: 12px; margin-top: 12px; position: relative; z-index: 1; }
    .circle-btn { width: 40px; height: 40px; border-radius: var(--radius-xs); background: rgba(255,255,255,0.35); border: 1px solid rgba(255,255,255,0.5); font-size: 1.5rem; display: flex; align-items: center; justify-content: center; cursor: pointer; color: white; font-weight: 700; backdrop-filter: blur(4px); transition: 0.2s; }
    .circle-btn:hover { background: rgba(255,255,255,0.5); }
    .btn-special { background: rgba(255,255,255,0.45); }
    .stats-row { display: flex; gap: 10px; }
    .stat-block { flex: 1; text-align: center; border-radius: var(--radius-sm); padding: 10px 4px; border: 1px solid var(--card-border); background: var(--stats-gradient); color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.1); box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
    .stat-block .label { font-size: 0.7rem; font-weight: 600; opacity: 0.9; }
    .stat-block .number { font-size: 1.35rem; font-weight: 800; margin-left: 4px; }
    .calendar-compact { padding: 10px 12px; }
    .cal-head { font-size: 0.8rem; font-weight: 700; color: var(--text-soft); margin-bottom: 8px; }
    .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; text-align: center; }
    .cal-weekday { font-size: 0.65rem; font-weight: 700; color: var(--text-light); padding: 4px 0; }
    .cal-day { aspect-ratio: 1/1; display: flex; flex-direction: column; align-items: center; justify-content: center; border-radius: var(--radius-xs); font-size: 0.7rem; font-weight: 700; color: var(--text-main); background: transparent; cursor: pointer; transition: 0.2s; position: relative; }
    .cal-day:hover { background: var(--cal-hover); transform: scale(0.98); }
    .cal-day.today { background: var(--today-gradient); color: white; box-shadow: 0 0 20px rgba(255,138,101,0.5); text-shadow: 0 1px 2px rgba(0,0,0,0.2); }
    .cal-day.past { background: rgba(128,138,150,0.08); color: var(--text-light); }
    body.dark-mode .cal-day.past { background: rgba(128,138,150,0.12); }
    .day-number { font-size: 0.75rem; font-weight: 700; }
    .day-badge { display: flex; gap: 3px; font-size: 0.5rem; margin-top: 2px; color: var(--text-soft); font-weight: 600; }
    .cal-day.today .day-badge { color: rgba(255,255,255,0.9); }
    .day-badge span { background: rgba(100,110,130,0.15); padding: 0px 3px; border-radius: var(--radius-xs); }
    .cal-day.today .day-badge span { background: rgba(255,255,255,0.3); }
    .tooltip-simple { position: fixed; background: var(--tooltip-bg); color: var(--tooltip-text); padding: 6px 14px; border-radius: var(--radius-xs); font-size: 0.7rem; pointer-events: none; z-index: 1100; opacity: 0; transition: 0.1s; white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,0.1); font-weight: 600; }
    .tooltip-simple.show { opacity: 1; }
    .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: var(--modal-bg); backdrop-filter: blur(10px); z-index: 2000; display: flex; align-items: center; justify-content: center; visibility: hidden; opacity: 0; transition: 0.2s; }
    .modal-overlay.active { visibility: visible; opacity: 1; }
    .modal-card { background: var(--modal-card); border-radius: var(--radius-ios); width: 380px; max-width: 90vw; max-height: 70vh; padding: 20px; box-shadow: 0 20px 35px rgba(0,0,0,0.2); border: 1px solid var(--card-border); display: flex; flex-direction: column; gap: 12px; color: var(--text-main); }
    .modal-header { display: flex; justify-content: space-between; align-items: center; font-weight: 700; font-size: 1.1rem; border-bottom: 1px solid var(--border-light); padding-bottom: 8px; }
    .modal-header button { background: none; border: none; font-size: 1.2rem; cursor: pointer; color: var(--text-soft); font-weight: 700; }
    .client-modal-list { overflow-y: auto; display: flex; flex-direction: column; gap: 10px; max-height: 50vh; }
    .modal-client-item { background: var(--btn-bg); border-radius: var(--radius-sm); padding: 10px 12px; border: 1px solid var(--card-border); }
    .modal-client-name { font-weight: 800; }
    .modal-client-phone { font-size: 0.75rem; color: var(--text-soft); margin-left: 8px; font-weight: 600; }
    .modal-client-time { font-size: 0.65rem; color: var(--text-light); margin-left: 8px; font-weight: 500; }
    .modal-client-note { font-size: 0.7rem; color: var(--text-light); margin-top: 4px; font-style: italic; font-weight: 600; }
    .empty-clients { text-align: center; color: var(--text-light); padding: 20px; font-size: 0.8rem; font-weight: 600; }
    .register-block { display: flex; flex-direction: column; gap: 12px; }
    .form-line { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .input-simple { flex: 1; background: var(--btn-bg); border: 1px solid var(--card-border); border-radius: var(--radius-xs); padding: 10px 16px; font-size: 0.85rem; color: var(--text-main); outline: none; min-width: 0; font-weight: 600; }
    .input-simple:focus { border-color: var(--accent-wechat); }
    .btn-add { background: var(--accent-intent); color: white; border: none; border-radius: var(--radius-xs); padding: 10px 22px; font-weight: 700; font-size: 0.85rem; cursor: pointer; white-space: nowrap; }
    .client-scroll { max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
    .client-row { background: var(--btn-bg); border-radius: var(--radius-sm); padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem; border: 1px solid var(--card-border); font-weight: 600; }
    .client-info { flex: 1; display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
    .client-name { font-weight: 700; }
    .client-phone { color: var(--text-soft); font-size: 0.75rem; font-weight: 600; }
    .phone-toggle { background: none; border: none; font-size: 0.8rem; cursor: pointer; padding: 0 2px; opacity: 0.5; transition: opacity 0.2s; vertical-align: middle; line-height: 1; }
    .phone-toggle:hover { opacity: 1; }
    .client-note { color: var(--text-light); font-size: 0.75rem; font-weight: 600; }
    .client-time { color: var(--text-light); font-size: 0.65rem; font-weight: 500; }
    .del-icon { background: none; border: none; font-size: 0.9rem; color: #c97a7a; cursor: pointer; width: 28px; height: 28px; border-radius: var(--radius-xs); font-weight: 700; }
    .edit-icon { background: none; border: none; font-size: 0.9rem; color: var(--accent-wechat); cursor: pointer; width: 28px; height: 28px; border-radius: var(--radius-xs); font-weight: 700; margin-right: 4px; }
    .client-actions { display: flex; align-items: center; gap: 4px; }
    .todo-section { margin-top: 0; }
    .todo-title { font-weight: 700; font-size: 0.9rem; margin-bottom: 10px; color: var(--text-main); }
    .todo-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; max-height: 200px; overflow-y: auto; }
    .todo-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--btn-bg); border-radius: var(--radius-xs); border: 1px solid var(--card-border); font-size: 0.8rem; font-weight: 600; color: var(--text-main); }
    .todo-number { font-weight: 800; color: var(--accent-wechat); min-width: 20px; font-size: 0.85rem; }
    .todo-text { flex: 1; word-break: break-word; line-height: 1.4; }
    .todo-input-row { display: flex; gap: 8px; align-items: center; }
    .todo-input { flex: 1; background: var(--btn-bg); border: 1px solid var(--card-border); border-radius: var(--radius-xs); padding: 8px 14px; font-size: 0.8rem; color: var(--text-main); outline: none; font-weight: 600; }
    .todo-input:focus { border-color: var(--accent-wechat); }
    .todo-add-btn { background: var(--accent-wechat); color: white; border: none; border-radius: var(--radius-xs); padding: 8px 18px; font-weight: 700; font-size: 0.8rem; cursor: pointer; white-space: nowrap; }
    .todo-del-btn { background: none; border: none; color: #c97a7a; cursor: pointer; font-size: 0.85rem; padding: 0 4px; }
    @media (min-width: 761px) {
      .right-area { order: 2; } .left-area { order: 1; }
      .card { padding: 20px 24px; }
      .counter-card { padding: 20px 18px; }
      .counter-label { font-size: 1rem; }
      .counter-value { font-size: 4rem; font-weight: 900; }
      .circle-btn { width: 48px; height: 48px; font-size: 1.8rem; }
      .button-group { gap: 16px; margin-top: 18px; }
      .reset-mini { font-size: 0.8rem; }
      .client-scroll { max-height: 260px; }
      .todo-list { max-height: 240px; }
      .input-simple { padding: 12px 18px; font-size: 0.9rem; }
      .btn-add { padding: 12px 24px; font-size: 0.9rem; }
      .client-row { padding: 12px 16px; font-size: 0.9rem; }
      .todo-item { padding: 10px 14px; font-size: 0.85rem; }
      .todo-input { padding: 10px 16px; font-size: 0.85rem; }
      .todo-add-btn { padding: 10px 20px; font-size: 0.85rem; }
      .todo-title { font-size: 0.95rem; }
    }
    @media (max-width: 760px) {
      .two-columns { flex-direction: column; }
      .right-area { order: 1; } .left-area { order: 2; }
      .pin-box { min-width: 280px; max-width: 90vw; padding: 24px 24px; gap: 12px; }
      .pin-stats { gap: 10px; }
      .pin-stat-item { padding: 10px 12px; min-width: 90px; gap: 4px; }
      .pin-stat-label { font-size: 0.65rem; }
      .pin-stat-value { font-size: 1.6rem; }
      .pin-input { width: 130px; padding: 7px 12px; font-size: 0.9rem; }
      .pin-btn { padding: 7px 20px; font-size: 0.7rem; }
	      .script-container { left: 8px; top: 60px; max-width: 42vw; max-height: 30vh; overflow-y: auto; }
	      .learn-container { right: 8px; top: 60px; max-width: 52vw; max-height: 30vh; overflow-y: auto; }
	      .script-module { padding: 8px 12px; font-size: 0.75rem; }
	      .learn-module { padding: 8px 12px; font-size: 0.7rem; }
    }
  </style>
</head>
<body>
<div class="notify-bar" id="notifyBar" onclick="this.classList.remove('show')"><span id="notifyText"></span><span class="notify-close">✕</span></div>
<div class="wallpaper-fallback"></div>
<div class="wallpaper-background" id="wallpaperBackground"></div>
<div class="privacy-wallpaper" id="privacyWallpaper"></div>
<div class="privacy-mask" id="privacyMask">
  <div class="script-container" id="scriptContainer"></div>
  <div class="learn-container" id="learnContainer"></div>
  <div class="pin-box">
    <div class="pin-stats" id="pinStatsContainer">
      <div class="pin-stat-item"><span class="pin-stat-label">💬 今日微信</span><span class="pin-stat-value pin-wechat-value" id="pinWechatNum">0</span></div>
      <div class="pin-stat-item"><span class="pin-stat-label">🎯 今日意向</span><span class="pin-stat-value pin-intent-value" id="pinIntentNum">0</span></div>
    </div>
    <input type="password" class="pin-input" id="pinInput" placeholder="" maxlength="6" inputmode="numeric" autofocus>
    <button class="pin-btn" id="pinUnlockBtn">解锁进入</button>
    <div class="pin-error" id="pinError"></div>
  </div>
</div>
<div class="app-shell">
  <div class="container">
    <div class="header-bar">
      <div class="title-section"><h3>每日工作</h3><div class="date-chip" id="liveDate"></div></div>
      <div class="action-group">
        <button class="icon-simple" id="scriptBtn" title="话术管理">📝</button>
        <button class="icon-simple" id="learnBtn" title="学习管理">📖</button>
        <button class="icon-simple" id="exportBtn" title="导出数据">📊</button>
        <button class="icon-simple" id="hideBtn" title="一键隐藏 (Ctrl+Z)">👁</button>
        <button class="icon-simple" id="darkToggleBtn" title="深色模式">🌙</button>
      </div>
    </div>
    <div class="two-columns">
      <div class="left-area">
        <div class="counter-row">
          <div class="counter-card wechat-fill">
            <div class="counter-header"><span class="counter-label">💬 今日微信</span><button class="reset-mini" id="resetWechatToday">↺</button></div>
            <div class="counter-value" id="wechatNum">0</div>
            <div class="button-group"><button class="circle-btn" id="wechatMinus">−</button><button class="circle-btn btn-special" id="wechatPlus">+</button></div>
          </div>
          <div class="counter-card intent-fill">
            <div class="counter-header"><span class="counter-label">🎯 今日意向</span></div>
            <div class="counter-value" id="intentNum">0</div>
          </div>
        </div>
        <div class="stats-row">
          <div class="stat-block"><span class="label">💬本周</span> <span class="number" id="weekWechat">0</span></div>
          <div class="stat-block"><span class="label">💬本月</span> <span class="number" id="monthWechat">0</span></div>
          <div class="stat-block"><span class="label">🎯本周</span> <span class="number" id="weekIntent">0</span></div>
          <div class="stat-block"><span class="label">🎯本月</span> <span class="number" id="monthIntent">0</span></div>
        </div>
        <div class="card calendar-compact">
          <div class="cal-head" id="calMonthTitle"></div>
          <div class="cal-grid" id="calGrid"></div>
          <div style="font-size:0.55rem;text-align:center;margin-top:6px;color:var(--text-light);font-weight:600;">点击日期查看意向客户</div>
        </div>
      </div>
      <div class="right-area">
        <div class="card">
          <div style="font-weight:700;margin-bottom:14px;font-size:0.9rem;">🎯 意向登记</div>
          <div class="register-block">
            <div class="form-line"><input type="text" class="input-simple" id="custName" placeholder="姓名" autocomplete="off"><input type="text" class="input-simple" id="custPhone" placeholder="电话" autocomplete="off"></div>
            <input type="text" class="input-simple" id="custNote" placeholder="沟通记录 (必填)" autocomplete="off">
            <button class="btn-add" id="addClientBtn">+ 添加</button>
            <div class="client-scroll" id="clientList"></div>
          </div>
        </div>
        <div class="card">
          <div class="todo-section">
            <div class="todo-title">✅ 今日待办</div>
            <div class="todo-list" id="todayTodoList"></div>
            <div class="todo-input-row"><input type="text" class="todo-input" id="todayTodoInput" placeholder="添加今日待办..." autocomplete="off"><input type="time" class="todo-input" id="todayRemindTime" style="flex:0 0 100px;font-size:0.7rem;padding:8px 4px;"><button class="todo-add-btn" id="addTodayTodoBtn">+ 添加</button></div>
          </div>
        </div>
        <div class="card">
          <div class="todo-section">
            <div class="todo-title">✅ 明日待办</div>
            <div class="todo-list" id="tomorrowTodoList"></div>
            <div class="todo-input-row"><input type="text" class="todo-input" id="todoInput" placeholder="添加明日待办..." autocomplete="off"><input type="time" class="todo-input" id="tomorrowRemindTime" style="flex:0 0 100px;font-size:0.7rem;padding:8px 4px;"><button class="todo-add-btn" id="addTodoBtn">+ 添加</button></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<div id="globalTooltip" class="tooltip-simple"></div>
<div id="scriptModal" class="modal-overlay">
  <div class="modal-card script-input-modal">
    <div class="modal-header"><span>📝 话术管理</span><button id="closeScriptModalBtn">✕</button></div>
    <textarea id="newScriptInput" placeholder="输入话术内容..."></textarea>
    <button class="btn-add" id="addScriptBtn" style="width:100%;">+ 添加话术</button>
    <div class="script-list" id="scriptList"></div>
  </div>
</div>
<div id="learnModal" class="modal-overlay">
  <div class="modal-card script-input-modal">
    <div class="modal-header"><span>📖 学习管理</span><button id="closeLearnModalBtn">✕</button></div>
    <textarea id="newLearnInput" placeholder="输入学习内容..."></textarea>
    <div class="learn-check-row"><input type="checkbox" id="learnShowCheck" checked><label for="learnShowCheck">锁屏显示</label></div>
    <button class="btn-add" id="addLearnBtn" style="width:100%;">保存</button>
    <div class="script-list" id="learnList"></div>
  </div>
</div>
<div id="exportModal" class="modal-overlay">
  <div class="modal-card" style="max-width:400px;">
    <div class="modal-header"><span>📊 导出数据</span><button id="closeExportModalBtn">✕</button></div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;gap:8px;"><button class="btn-add" id="exportWeekBtn" style="flex:1;">📅 导出本周</button><button class="btn-add" id="exportMonthBtn" style="flex:1;">📆 导出本月</button></div>
      <input type="text" class="input-simple" id="webhookUrlInput" placeholder="企业微信 Webhook URL">
      <div style="font-size:0.65rem;color:var(--text-light);">粘贴企业微信群机器人的 Webhook 地址</div>
      <div id="exportStatus" style="font-size:0.75rem;text-align:center;min-height:20px;"></div>
    </div>
  </div>
</div>
<div id="dateModal" class="modal-overlay">
  <div class="modal-card">
    <div class="modal-header"><span id="modalDateTitle">时间线</span><button id="closeModalBtn">✕</button></div>
    <div id="modalClientList" class="client-modal-list"></div>
  </div>
</div>
<script>
(function(){
  const WECHAT_K='wechat_v3', INTENT_K='intent_v3', CLIENTS_K='clients_v3';
  const DARK_K='dark_mode', LOCK_K='locked', TODAY_TODO_K='today_todo_v2', TOMORROW_TODO_K='tomorrow_todo_v2';
  const LAST_LOAD_DATE_K='last_load_date_v1', WALLPAPER_K='wp_cache', SCRIPTS_K='scripts_v1', LEARN_K='learn_v1', SCRIPTS_VER_K='scripts_ver', LEARN_VER_K='learn_ver', CLIENTS_VER_K='clients_ver';
  const DEFAULT_PIN='8520';
  const SYNC_INTERVAL=2000;
  let syncTimer=null;

  const getTodayStr=()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');};
  const getCurrentMonth=()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');};
  const getCurrentTime=()=>{const n=new Date();return String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0')+':'+String(n.getSeconds()).padStart(2,'0');};
  const loadMap=k=>{try{return JSON.parse(localStorage.getItem(k))||{};}catch(e){return{};}};
  const saveMap=(k,o)=>localStorage.setItem(k,JSON.stringify(o));
  const loadTodos=k=>{try{const d=JSON.parse(localStorage.getItem(k))||[];return d.map(t=>typeof t==='string'?{text:t,time:'',date:getTodayStr()}:t);}catch(e){return[];}};
  const saveTodos=(k,a)=>localStorage.setItem(k,JSON.stringify(a));
  const pushTodoLog=async (todo,ds)=>{try{const r=await fetch('/api/data?date='+ds);if(r.ok){const d=await r.json();const log=d.todoLog||[];log.push(todo);await fetch('/api/data',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...d,todoLog:log})});}}catch(e){}};
  const esc=s=>String(s).replace(/[&<>]/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;' })[m]||m);
  const maskPhone=p=>{if(!p||p.length<7)return '****';return '****'.repeat(Math.ceil(p.length/4));};

  function getWeekTotal(map){const t=new Date();const dow=t.getDay();const diff=dow===0?6:dow-1;const mon=new Date(t);mon.setDate(t.getDate()-diff);const ms=mon.getFullYear()+'-'+String(mon.getMonth()+1).padStart(2,'0')+'-'+String(mon.getDate()).padStart(2,'0');const ts=getTodayStr();let s=0;for(let[d,v]of Object.entries(map))if(d>=ms&&d<=ts)s+=v;return s;}
  function getMonthTotal(map){const p=getTodayStr().slice(0,7);let s=0;for(let[d,v]of Object.entries(map))if(d.startsWith(p))s+=v;return s;}

  // ==================== 云端 API ====================
  async function cloudGet(date){try{const r=await fetch('/api/data?date='+date);if(r.ok)return await r.json();}catch(e){console.warn('cloudGet err',e);}return null;}
  async function cloudSave(data){try{const r=await fetch('/api/data',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});if(r.ok)console.log('☁️ 已同步');}catch(e){console.warn('cloudSave err',e);}}
  async function cloudCalendar(month){try{const r=await fetch('/api/calendar?month='+month);if(r.ok)return await r.json();}catch(e){}return null;}
  async function cloudStats(month){try{const r=await fetch('/api/stats?month='+month);if(r.ok)return await r.json();}catch(e){}return null;}

  async function pullFromCloud(){
    const today=getTodayStr();
    const data=await cloudGet(today);
    if(!data)return;
    // 拉取计数（取最大值合并）
    if((data.wechatCount||0)>0){
      const wm=loadMap(WECHAT_K);wm[today]=Math.max(wm[today]||0,data.wechatCount||0);saveMap(WECHAT_K,wm);
    }
    if((data.intentCount||0)>0){
      const im=loadMap(INTENT_K);im[today]=Math.max(im[today]||0,data.intentCount||0);saveMap(INTENT_K,im);
    }
    // 拉取客户（版本号比对）
    if(data.clientsVer!==undefined){
      const localCv=getClientsVer();
      if((data.clientsVer[today]||0)>(localCv[today]||0)){
        localCv[today]=data.clientsVer[today];
        localStorage.setItem(CLIENTS_VER_K,JSON.stringify(localCv));
        if(data.clients&&data.clients.length>0){
          let cl=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
          cl=cl.filter(c=>c.date!==today);
          cl=cl.concat(data.clients);
          localStorage.setItem(CLIENTS_K,JSON.stringify(cl));
        }
      }
    }
    // 拉取话术/学习（版本号比对）
    if(data.scripts!==undefined&&(data.scriptsVer||0)>getScriptsVer()){
      localStorage.setItem(SCRIPTS_VER_K,data.scriptsVer||0);
      saveScripts(data.scripts);renderLockScripts();
    }
    if(data.learns!==undefined&&(data.learnsVer||0)>getLearnsVer()){
      localStorage.setItem(LEARN_VER_K,data.learnsVer||0);
      saveLearns(data.learns);renderLockLearns();
    }
  }

  async function syncToCloud(full=false){
    const today=getTodayStr();
    const wm=loadMap(WECHAT_K), im=loadMap(INTENT_K);
    // 先拉云端当前值，合并计数和客户
    let cloudW=0, cloudI=0, cloudClients=[];
    try{
      const existing=await cloudGet(today);
      if(existing){cloudW=existing.wechatCount||0;cloudI=existing.intentCount||0;cloudClients=existing.clients||[];}
    }catch(e){}
    const finalW=Math.max(wm[today]||0,cloudW);
    const finalI=Math.max(im[today]||0,cloudI);
    // 合并客户：本地+云端去重（按姓名+电话+时间），本地优先
    const localClients=(JSON.parse(localStorage.getItem(CLIENTS_K)||'[]')).filter(c=>c.date===today);
    const mergedClients=[...cloudClients];
    for(const lc of localClients){
      const ei=mergedClients.findIndex(cc=>cc.name===lc.name&&cc.phone===lc.phone&&cc.time===lc.time);
      if(ei>=0){mergedClients[ei]=lc;}else{mergedClients.push(lc);}
    }
    // 更新本地存储为合并后的结果
    const allClients=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
    const nonToday=allClients.filter(c=>c.date!==today);
    localStorage.setItem(CLIENTS_K,JSON.stringify([...nonToday,...mergedClients]));
    const data={
      date:today,
      wechatCount:finalW,
      intentCount:finalI,
      clients:mergedClients,
      todayTodos:loadTodos(TODAY_TODO_K),
      tomorrowTodos:loadTodos(TOMORROW_TODO_K),
      clientsVer:getClientsVer()
    };
    if(full){
      data.scripts=loadScripts();
      data.scriptsVer=getScriptsVer();
      data.learns=loadLearns();
      data.learnsVer=getLearnsVer();
    }
    await cloudSave(data);
    if(finalW!==(wm[today]||0)){wm[today]=finalW;saveMap(WECHAT_K,wm);}
    if(finalI!==(im[today]||0)){im[today]=finalI;saveMap(INTENT_K,im);}
  }

  async function loadFromCloud(date){
    if(!date)date=getTodayStr();
    const data=await cloudGet(date);
    if(data){
      if(data.wechatCount>0){const m=loadMap(WECHAT_K);m[date]=Math.max(m[date]||0,data.wechatCount);saveMap(WECHAT_K,m);}
      if(data.intentCount>0){const m=loadMap(INTENT_K);m[date]=Math.max(m[date]||0,data.intentCount);saveMap(INTENT_K,m);}
      if(data.clients&&data.clients.length>0){const cloudCv2=data.clientsVer||{};const localCv2=getClientsVer();if((cloudCv2[date]||0)>(localCv2[date]||0)){let cl=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');cl=cl.filter(c=>c.date!==date);cl=cl.concat(data.clients);localStorage.setItem(CLIENTS_K,JSON.stringify(cl));localCv2[date]=cloudCv2[date];localStorage.setItem(CLIENTS_VER_K,JSON.stringify(localCv2));}}
      if(data.todayTodos&&data.todayTodos.length>0){const lt=loadTodos(TODAY_TODO_K);if(lt.length===0||data.todayTodos.length>lt.length)saveTodos(TODAY_TODO_K,data.todayTodos);}
      if(data.tomorrowTodos&&data.tomorrowTodos.length>0){const lt=loadTodos(TOMORROW_TODO_K);if(lt.length===0||data.tomorrowTodos.length>lt.length)saveTodos(TOMORROW_TODO_K,data.tomorrowTodos);}
      if(data.scripts!==undefined&&(data.scriptsVer||0)>getScriptsVer()){localStorage.setItem(SCRIPTS_VER_K,data.scriptsVer||0);saveScripts(data.scripts);}
      if(data.learns!==undefined&&(data.learnsVer||0)>getLearnsVer()){localStorage.setItem(LEARN_VER_K,data.learnsVer||0);saveLearns(data.learns);}
      if(data.lastLoadDate)localStorage.setItem(LAST_LOAD_DATE_K,data.lastLoadDate);
      return true;
    }
    return false;
  }

  // ==================== 每日自动检查 ====================
  // 保留函数供手动/定时调用，首次加载在 init 中内联处理
  function autoDailyReset(){
    const todayStr=getTodayStr();
    const lastLoadDate=localStorage.getItem(LAST_LOAD_DATE_K);
    if(lastLoadDate&&lastLoadDate!==todayStr){
      const tomorrow=loadTodos(TOMORROW_TODO_K);
      if(tomorrow.length>0){
        const today=loadTodos(TODAY_TODO_K);
        saveTodos(TODAY_TODO_K,[...tomorrow,...today]);
        saveTodos(TOMORROW_TODO_K,[]);
        console.log('📅 已自动将前一天待办转移到今天');
      }
      localStorage.setItem(LAST_LOAD_DATE_K,todayStr);
    }
  }

  // ==================== 渲染 ====================
  function renderClientList(){
    const today=getTodayStr();
    const clients=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]').filter(c=>c.date===today);
    document.getElementById('clientList').innerHTML=clients.map((c,i)=>'<div class="client-row"><div class="client-info"><span class="client-name">'+esc(c.name)+'</span><span class="client-phone" data-full="'+esc(c.phone)+'">'+esc(maskPhone(c.phone))+'</span><button class="phone-toggle" title="显示号码">👁</button>'+(c.note?'<span class="client-note">📝 '+esc(c.note)+'</span>':'')+'<span class="client-time">⏰ '+esc(c.time||'')+'</span></div><div class="client-actions"><button class="edit-icon" data-idx="'+i+'" title="编辑">✎</button><button class="del-icon" data-idx="'+i+'" title="删除">✕</button></div></div>').join('');
    document.querySelectorAll('.del-icon').forEach(b=>b.addEventListener('click',e=>{
      const i=parseInt(b.dataset.idx);
      const a=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
      const c=a[i];if(!c)return;
      const td=c.date||getTodayStr();
      a.splice(i,1);localStorage.setItem(CLIENTS_K,JSON.stringify(a));
      bumpClientsVer(td);
      const im=loadMap(INTENT_K);if(im[td]>0){im[td]--;saveMap(INTENT_K,im);}
      renderClientList();refreshAll();
    }));
    document.querySelectorAll('.edit-icon').forEach(b=>b.addEventListener('click',e=>{
      const i=parseInt(b.dataset.idx);
      const a=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
      const c=a[i];
      document.getElementById('custName').value=c.name;
      document.getElementById('custPhone').value=c.phone;
      document.getElementById('custNote').value=c.note||'';
      a.splice(i,1);localStorage.setItem(CLIENTS_K,JSON.stringify(a));
      const td=c.date||getTodayStr();
      bumpClientsVer(td);
      const im=loadMap(INTENT_K);
      if(im[td]>0){im[td]--;saveMap(INTENT_K,im);}
      renderClientList();refreshAll();
      document.getElementById('custName').focus();
    }));
    document.querySelectorAll('.phone-toggle').forEach(b=>b.addEventListener('click',e=>{
      e.stopPropagation();
      const phoneSpan=b.previousElementSibling;
      const full=phoneSpan.dataset.full;
      if(phoneSpan.textContent===full){
        phoneSpan.textContent=maskPhone(full);
        b.title='显示号码';
        b.textContent='👁';
      }else{
        phoneSpan.textContent=full;
        b.title='隐藏号码';
        b.textContent='🙈';
      }
    }));
  }

  function renderTodos(){
    const tt=loadTodos(TODAY_TODO_K), tm=loadTodos(TOMORROW_TODO_K);
    const tc=document.getElementById('todayTodoList'), mc=document.getElementById('tomorrowTodoList');
    const makeItem=(t,i,list)=>{
      const txt=typeof t==='string'?t:t.text;
      const rm=t&&t.remind?' 🔔'+esc(t.remind):'';
      return '<div class="todo-item"><span class="todo-number">'+(i+1)+'.</span><span class="todo-text">'+esc(txt)+rm+'</span><button class="todo-del-btn" data-idx="'+i+'" data-list="'+list+'">✕</button></div>';
    };
    tc.innerHTML=tt.length===0?'<div style="font-size:0.75rem;color:var(--text-light);padding:6px;">暂无待办</div>':tt.map((t,i)=>makeItem(t,i,'today')).join('');
    mc.innerHTML=tm.length===0?'<div style="font-size:0.75rem;color:var(--text-light);padding:6px;">暂无待办</div>':tm.map((t,i)=>makeItem(t,i,'tomorrow')).join('');
    document.querySelectorAll('.todo-del-btn').forEach(b=>b.addEventListener('click',e=>{
      const i=parseInt(b.dataset.idx),l=b.dataset.list;
      const todos=loadTodos(l==='today'?TODAY_TODO_K:TOMORROW_TODO_K);
      todos.splice(i,1);saveTodos(l==='today'?TODAY_TODO_K:TOMORROW_TODO_K,todos);renderTodos();
    }));
  }

  function renderCalendar(wm,im){
    const td=new Date(),y=td.getFullYear(),m=td.getMonth();
    const fd=new Date(y,m,1);let si=(fd.getDay()+6)%7;
    const dim=new Date(y,m+1,0).getDate(),ts=getTodayStr();
    const clients=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
    const ccMap={};clients.forEach(c=>{if(c.date)ccMap[c.date]=(ccMap[c.date]||0)+1;});
    const mn=['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
    document.getElementById('calMonthTitle').innerHTML=y+'年 '+mn[m];
    let g='';const wd=['一','二','三','四','五','六','日'];
    wd.forEach(d=>{g+='<div class="cal-weekday">'+d+'</div>';});
    for(let i=0;i<si;i++)g+='<div class="cal-day"></div>';
    for(let d=1;d<=dim;d++){
      const ds=y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');
      const wv=wm[ds]||0,iv=im[ds]||0,cv=ccMap[ds]||0;
      let bh='';if(wv>0||iv>0||cv>0)bh='<div class="day-badge">'+(wv>0?'<span>💬'+wv+'</span>':'')+(iv>0?'<span>🎯'+iv+'</span>':'')+(cv>0?'<span>👤'+cv+'</span>':'')+'</div>';
      const it=ds===ts, pt=ds<ts;
      g+='<div class="cal-day'+(it?' today':pt?' past':'')+'" data-date="'+ds+'" data-w="'+wv+'" data-i="'+iv+'"><div class="day-number">'+d+'</div>'+bh+'</div>';
    }
    document.getElementById('calGrid').innerHTML=g;
    const tip=document.getElementById('globalTooltip');
    document.querySelectorAll('.cal-day[data-date]').forEach(c=>{
      c.addEventListener('mouseenter',e=>{tip.innerHTML='<strong>'+c.dataset.date+'</strong> 💬'+(c.dataset.w||0)+' 🎯'+(c.dataset.i||0);tip.classList.add('show');});
      c.addEventListener('mouseleave',()=>tip.classList.remove('show'));
      c.addEventListener('mousemove',e=>{tip.style.left=(e.clientX+12)+'px';tip.style.top=(e.clientY-28)+'px';});
      c.addEventListener('click',e=>{e.stopPropagation();if(c.dataset.date)showTimelineForDate(c.dataset.date);});
    });
  }

  async function showTimelineForDate(ds){
    document.getElementById('modalDateTitle').innerText=ds+' 时间线';
    document.getElementById('modalClientList').innerHTML='<div class="empty-clients">加载中...</div>';
    document.getElementById('dateModal').classList.add('active');
    let clients=[], todos=[], cloudData=null;
    try{
      const r=await fetch('/api/data?date='+ds);
      if(r.ok){
        cloudData=await r.json();
        if(cloudData.clients&&cloudData.clients.length>0)clients=cloudData.clients;
        if(cloudData.todayTodos&&cloudData.todayTodos.length>0)todos=cloudData.todayTodos;
      }
    }catch(e){}
    // 版本号比对：云端更高用云端，本地更高保留本地
    const localAll=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
    const localDay=localAll.filter(c=>c.date===ds);
    const localCv3=getClientsVer();
    const cloudCv3=(cloudData&&cloudData.clientsVer)||{};
    if((cloudCv3[ds]||0)>(localCv3[ds]||0)){
      const nonDay=localAll.filter(c=>c.date!==ds);
      localStorage.setItem(CLIENTS_K,JSON.stringify([...nonDay,...clients]));
      localCv3[ds]=cloudCv3[ds];
      localStorage.setItem(CLIENTS_VER_K,JSON.stringify(localCv3));
    }else{
      localDay.forEach(lc=>{
        const exist=clients.findIndex(cc=>cc.name===lc.name&&cc.phone===lc.phone&&cc.time===lc.time);
        if(exist>=0){clients[exist]=lc;}else{clients.push(lc);}
      });
    }
    if(todos.length===0&&ds===getTodayStr())todos=loadTodos(TODAY_TODO_K);
    // 同时获取该日期的 todoLog（永久待办记录）
    let todoLog=[];
    if(cloudData&&cloudData.todoLog)todoLog=cloudData.todoLog;
    let timeline=[];
    clients.forEach((c,i)=>{timeline.push({type:'client',time:c.time||'',name:c.name,phone:c.phone,note:c.note,idx:i});});
    todos.forEach(t=>{const txt=typeof t==='string'?t:t.text;const tm=t&&t.time?t.time:'';if(txt)timeline.push({type:'todo',time:tm,text:txt});});
    todoLog.forEach(t=>{const txt=typeof t==='string'?t:t.text;const tm=t&&t.time?t.time:'';const tp=t.type==='tomorrow'?' (明日)':'';if(txt)timeline.push({type:'todo',time:tm,text:txt+tp});});
    timeline.sort((a,b)=>(a.time||'').localeCompare(b.time||''));
    function renderTl(){
      document.getElementById('modalClientList').innerHTML=timeline.length===0?'<div class="empty-clients">📭 当日无记录</div>':timeline.map(e=>{
        if(e.type==='client'){
          return '<div class="modal-client-item" style="border-left:3px solid var(--accent-intent);"><div><span class="modal-client-name">🎯 '+esc(e.name)+'</span><span class="modal-client-phone" data-full="'+esc(e.phone)+'">'+esc(maskPhone(e.phone))+'</span><button class="phone-toggle" title="显示号码">👁</button></div>'+(e.time?'<div style="font-size:0.65rem;color:var(--text-light);margin-top:2px;">⏰ '+esc(e.time)+'</div>':'')+'<div class="modal-client-note" id="cn_'+e.idx+'">'+(e.note?'📝 '+esc(e.note)+' ':'')+'<button class="edit-note-btn" data-idx="'+e.idx+'" style="font-size:0.6rem;background:none;border:1px solid var(--accent-wechat);color:var(--accent-wechat);border-radius:8px;cursor:pointer;padding:1px 8px;">✎'+(e.note?' 编辑':' 添加备注')+'</button></div></div>';
        }else{
          return '<div class="modal-client-item" style="border-left:3px solid var(--accent-wechat);"><div><span class="modal-client-name">✅ 待办</span></div><div style="font-size:0.8rem;color:var(--text-main);margin-top:2px;">'+esc(e.text)+'</div>'+(e.time?'<div style="font-size:0.65rem;color:var(--text-light);margin-top:2px;">⏰ '+esc(e.time)+'</div>':'')+'</div>';
        }
      }).join('');
      bindEditBtns();
      document.querySelectorAll('#modalClientList .phone-toggle').forEach(b=>b.addEventListener('click',e=>{
        e.stopPropagation();
        const phoneSpan=b.previousElementSibling;
        const full=phoneSpan.dataset.full;
        if(phoneSpan.textContent===full){
          phoneSpan.textContent=maskPhone(full);
          b.title='显示号码';
          b.textContent='👁';
        }else{
          phoneSpan.textContent=full;
          b.title='隐藏号码';
          b.textContent='🙈';
        }
      }));
    }
    function bindEditBtns(){
      document.querySelectorAll('.edit-note-btn').forEach(btn=>{
        btn.onclick=function(){
          const idx=parseInt(this.dataset.idx);
          const ti=timeline.find(t=>t.type==='client'&&t.idx===idx);
          if(!ti)return;
          const old=ti.note||'';
          const noteDiv=document.getElementById('cn_'+idx);
          if(!noteDiv)return;
          noteDiv.innerHTML='<textarea id="ein_'+idx+'" style="width:100%;min-height:50px;background:var(--btn-bg);border:1px solid var(--card-border);border-radius:8px;padding:6px 10px;font-size:0.75rem;color:var(--text-main);outline:none;font-weight:600;">'+esc(old)+'</textarea><div style="display:flex;gap:6px;margin-top:4px;"><button id="sn_'+idx+'" style="font-size:0.65rem;background:var(--accent-wechat);color:#fff;border:none;border-radius:8px;cursor:pointer;padding:3px 10px;">保存</button><button id="cn_btn_'+idx+'" style="font-size:0.65rem;background:var(--btn-bg);border:1px solid var(--card-border);color:var(--text-soft);border-radius:8px;cursor:pointer;padding:3px 10px;">取消</button></div>';
          document.getElementById('sn_'+idx).onclick=async ()=>{
            const nn=document.getElementById('ein_'+idx).value.trim();
            ti.note=nn;
            const co=clients.find(c=>c.name===ti.name&&c.phone===ti.phone);
            if(co)co.note=nn;
            const all=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
            const target=all.find(c=>c.date===ds&&c.name===ti.name&&c.phone===ti.phone);
            if(target){target.note=nn;}
            if(!target){all.push({name:ti.name,phone:ti.phone,note:nn,date:ds,time:ti.time||''});}
            localStorage.setItem(CLIENTS_K,JSON.stringify(all));
            const newVer=bumpClientsVer(ds);
            try{
              const existing=await cloudGet(ds);
              const dayClients=all.filter(c=>c.date===ds);
              await cloudSave({
                date:ds,wechatCount:existing?existing.wechatCount||0:0,intentCount:existing?existing.intentCount||0:0,
                clients:dayClients,
                clientsVer:{...((existing&&existing.clientsVer)||{}),[ds]:newVer},
                todayTodos:existing?existing.todayTodos||[]:[],tomorrowTodos:existing?existing.tomorrowTodos||[]:[],
                scripts:existing?existing.scripts||[]:[],scriptsVer:existing?existing.scriptsVer||0:0,
                learns:existing?existing.learns||[]:[],learnsVer:existing?existing.learnsVer||0:0
              });
            }catch(e){}
            renderTl();
          };
          document.getElementById('cn_btn_'+idx).onclick=()=>renderTl();
        };
      });
    }
    renderTl();
  }

  async function syncCalendarFromCloud(){
    const month=getCurrentMonth();
    const cal=await cloudCalendar(month);
    if(cal){
      const wm=loadMap(WECHAT_K), im=loadMap(INTENT_K);
      let changed=false;
      for(const [date, d] of Object.entries(cal)){
        if(d.w>0&&!wm[date]){wm[date]=d.w;changed=true;}
        if(d.i>0&&!im[date]){im[date]=d.i;changed=true;}
      }
      if(changed){saveMap(WECHAT_K,wm);saveMap(INTENT_K,im);}
    }
  }

  function refreshAll(){
    const wm=loadMap(WECHAT_K),im=loadMap(INTENT_K),today=getTodayStr();
    document.getElementById('wechatNum').innerText=wm[today]||0;
    document.getElementById('intentNum').innerText=im[today]||0;
    document.getElementById('pinWechatNum').innerText=wm[today]||0;
    document.getElementById('pinIntentNum').innerText=im[today]||0;
    document.getElementById('weekWechat').innerText=getWeekTotal(wm);
    document.getElementById('monthWechat').innerText=getMonthTotal(wm);
    document.getElementById('weekIntent').innerText=getWeekTotal(im);
    document.getElementById('monthIntent').innerText=getMonthTotal(im);
    const now=new Date();const wk=['周日','周一','周二','周三','周四','周五','周六'];
    document.getElementById('liveDate').innerHTML=(now.getMonth()+1)+'月'+now.getDate()+'日 '+wk[now.getDay()];
    renderCalendar(wm,im);renderClientList();renderTodos();
    // 后台同步
    syncToCloud(false).catch(()=>{});
  }

  function modCounter(key,delta){
    const d=loadMap(key),t=getTodayStr();let v=(d[t]||0)+delta;if(v<0)v=0;
    if(v===0)delete d[t];else d[t]=v;saveMap(key,d);refreshAll();
  }
  function resetToday(key){const d=loadMap(key);delete d[getTodayStr()];saveMap(key,d);refreshAll();}

  async function addClient(){
    const n=document.getElementById('custName').value.trim();
    const p=document.getElementById('custPhone').value.trim();
    const nt=document.getElementById('custNote').value.trim();
    if(!n||!p){alert('请填写姓名和电话');return;}
    if(!nt){alert('沟通记录为必填项');return;}
    const list=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
    const today=getTodayStr(),time=getCurrentTime();
    list.push({name:n,phone:p,note:nt,date:today,time:time});
    localStorage.setItem(CLIENTS_K,JSON.stringify(list));
    bumpClientsVer(today);
    const im=loadMap(INTENT_K);im[today]=(im[today]||0)+1;saveMap(INTENT_K,im);
    document.getElementById('custName').value='';
    document.getElementById('custPhone').value='';
    document.getElementById('custNote').value='';
    renderClientList();refreshAll();
    await syncToCloud(false);
  }

  function addTodayTodo(){
    const input=document.getElementById('todayTodoInput'),text=input.value.trim();
    if(!text)return;const remind=document.getElementById('todayRemindTime').value;
    const todo={text,time:getCurrentTime(),date:getTodayStr(),remind:remind||'',type:'today'};
    const t=loadTodos(TODAY_TODO_K);t.push(todo);saveTodos(TODAY_TODO_K,t);input.value='';document.getElementById('todayRemindTime').value='';renderTodos();
    pushTodoLog(todo,getTodayStr());
  }
  function addTodo(){
    const input=document.getElementById('todoInput'),text=input.value.trim();
    if(!text)return;const remind=document.getElementById('tomorrowRemindTime').value;
    const todo={text,time:getCurrentTime(),date:getTodayStr(),remind:remind||'',type:'tomorrow'};
    const t=loadTodos(TOMORROW_TODO_K);t.push(todo);saveTodos(TOMORROW_TODO_K,t);input.value='';document.getElementById('tomorrowRemindTime').value='';renderTodos();
    pushTodoLog(todo,getTodayStr());
  }

  // ==================== 壁纸 ====================
  const FW=['https://images.pexels.com/photos/36717/amazing-animal-beautiful-beautifull.jpg','https://images.pexels.com/photos/3244513/pexels-photo-3244513.jpeg','https://images.pexels.com/photos/1366919/pexels-photo-1366919.jpeg','https://images.pexels.com/photos/147411/italy-mountains-dawn-daybreak-147411.jpeg','https://images.pexels.com/photos/1671325/pexels-photo-1671325.jpeg'];
  function getWpCache(){try{const c=JSON.parse(localStorage.getItem(WALLPAPER_K));if(c&&c.date===getTodayStr()&&c.url)return c;}catch(e){}return null;}
  function saveWpCache(url){localStorage.setItem(WALLPAPER_K,JSON.stringify({date:getTodayStr(),url}));}
  function rndWp(){return FW[Math.floor(Math.random()*FW.length)];}
  async function fetchWp(){
    const w=Math.floor(screen.width*devicePixelRatio),h=Math.floor(screen.height*devicePixelRatio);
    const rid=Math.floor(Math.random()*1000);
    try{const r=await fetch('https://picsum.photos/id/'+rid+'/info');if(r.ok){const d=await r.json();return 'https://picsum.photos/id/'+d.id+'/'+w+'/'+h;}}catch(e){}
    return 'https://picsum.photos/'+w+'/'+h+'?random='+Date.now();
  }
  function applyWp(url){
    if(!url)return;const img=new Image();
    img.onload=()=>{document.documentElement.style.setProperty('--wallpaper-url','url('+url+')');const pw=document.getElementById('privacyWallpaper');if(pw)pw.style.backgroundImage='url('+url+')';};
    img.onerror=()=>{const fu=rndWp();const fi=new Image();fi.onload=()=>{document.documentElement.style.setProperty('--wallpaper-url','url('+fu+')');const pw=document.getElementById('privacyWallpaper');if(pw)pw.style.backgroundImage='url('+fu+')';};fi.src=fu;};
    img.src=url;
  }
  async function loadWp(force=false){
    if(!force){const c=getWpCache();if(c){applyWp(c.url);return;}}
    let u=null;try{u=await fetchWp();}catch(e){}
    if(!u)u=rndWp();
    if(u){applyWp(u);saveWpCache(u);}
  }
  function initWp(){
    setTimeout(()=>loadWp(false),1000);
    setInterval(()=>{loadWp(true);},3600000);
    function smr(){const n=new Date(),mn=new Date(n);mn.setHours(24,0,0,0);setTimeout(()=>{if(!document.body.classList.contains('page-hidden'))loadWp(true);smr();},mn-n+60000);}smr();
  }

  // ==================== 话术 ====================
  const loadScripts=()=>{try{return JSON.parse(localStorage.getItem(SCRIPTS_K))||[];}catch(e){return[];}};
  const saveScripts=(a)=>localStorage.setItem(SCRIPTS_K,JSON.stringify(a));
  const getScriptsVer=()=>parseInt(localStorage.getItem(SCRIPTS_VER_K)||'0');
  const bumpScriptsVer=()=>{const v=getScriptsVer()+1;localStorage.setItem(SCRIPTS_VER_K,v);return v;};
  function renderScriptList(){
    const ss=loadScripts();
    document.getElementById('scriptList').innerHTML=ss.length===0?'<div style="font-size:0.75rem;color:var(--text-light);padding:8px;text-align:center;">暂无话术</div>':ss.map((s,i)=>'<div class="script-item"><span class="script-item-text">'+esc(s)+'</span><button class="del-icon" data-si="'+i+'">✕</button></div>').join('');
    document.querySelectorAll('#scriptList .del-icon').forEach(b=>b.addEventListener('click',e=>{
      const i=parseInt(b.dataset.si);const a=loadScripts();a.splice(i,1);bumpScriptsVer();saveScripts(a);renderScriptList();renderLockScripts();syncToCloud(true).catch(()=>{});
    }));
  }
  function makeDraggable(el){
    let active=false,sx=0,sy=0,tx=0,ty=0;
    el.addEventListener('mousedown',e=>{active=true;sx=e.clientX-tx;sy=e.clientY-ty;el.style.cursor='grabbing';e.preventDefault();});
    el.addEventListener('touchstart',e=>{active=true;sx=e.touches[0].clientX-tx;sy=e.touches[0].clientY-ty;el.style.cursor='grabbing';},{passive:false});
    document.addEventListener('mousemove',e=>{if(!active)return;tx=e.clientX-sx;ty=e.clientY-sy;el.style.transform='translate('+tx+'px,'+ty+'px)';});
    document.addEventListener('touchmove',e=>{if(!active)return;tx=e.touches[0].clientX-sx;ty=e.touches[0].clientY-sy;el.style.transform='translate('+tx+'px,'+ty+'px)';},{passive:false});
    document.addEventListener('mouseup',()=>{active=false;el.style.cursor='grab';});
    document.addEventListener('touchend',()=>{active=false;el.style.cursor='grab';});
  }
  function renderLockScripts(){
    const ss=loadScripts();
    const container=document.getElementById('scriptContainer');
    if(ss.length===0){container.innerHTML='';return;}
    container.innerHTML=ss.map((s,i)=>'<div class="script-module" data-si="'+i+'">'+esc(s)+'</div>').join('');
    container.querySelectorAll('.script-module').forEach(el=>makeDraggable(el));
  }
  function initScriptFeature(){
    renderLockScripts();
    // script button
    document.getElementById('scriptBtn').addEventListener('click',()=>{
      renderScriptList();document.getElementById('newScriptInput').value='';document.getElementById('scriptModal').classList.add('active');
    });
    document.getElementById('closeScriptModalBtn').addEventListener('click',()=>document.getElementById('scriptModal').classList.remove('active'));
    document.getElementById('scriptModal').addEventListener('click',e=>{if(e.target===document.getElementById('scriptModal'))document.getElementById('scriptModal').classList.remove('active');});
    document.getElementById('addScriptBtn').addEventListener('click',()=>{
      const t=document.getElementById('newScriptInput').value.trim();if(!t)return;
      const a=loadScripts();a.push(t);bumpScriptsVer();saveScripts(a);document.getElementById('newScriptInput').value='';renderScriptList();renderLockScripts();syncToCloud(true).catch(()=>{});
    });
  }

  // ==================== 学习 ====================
  const loadLearns=()=>{try{return JSON.parse(localStorage.getItem(LEARN_K))||[];}catch(e){return[];}};
  const saveLearns=(a)=>localStorage.setItem(LEARN_K,JSON.stringify(a));
  const getLearnsVer=()=>parseInt(localStorage.getItem(LEARN_VER_K)||'0');
  const bumpLearnsVer=()=>{const v=getLearnsVer()+1;localStorage.setItem(LEARN_VER_K,v);return v;};
  const getClientsVer=()=>{try{return JSON.parse(localStorage.getItem(CLIENTS_VER_K))||{};}catch(e){return{};}};
  const bumpClientsVer=ds=>{const cv=getClientsVer();cv[ds]=(cv[ds]||0)+1;localStorage.setItem(CLIENTS_VER_K,JSON.stringify(cv));return cv[ds];};
  function renderLearnList(){
    const ls=loadLearns();
    document.getElementById('learnList').innerHTML=ls.length===0?'<div style="font-size:0.75rem;color:var(--text-light);padding:8px;text-align:center;">暂无学习</div>':ls.map((l,i)=>'<div class="script-item"><span class="script-item-text">'+(l.show?'👁 ':'')+esc(l.text)+'</span><div style="display:flex;gap:6px;align-items:center;"><input type="checkbox" '+(l.show?'checked':'')+' data-li="'+i+'" title="显示"><button class="del-icon" data-li="'+i+'">✕</button></div></div>').join('');
    document.querySelectorAll('#learnList .del-icon').forEach(b=>b.addEventListener('click',e=>{
      const i=parseInt(b.dataset.li);const a=loadLearns();a.splice(i,1);bumpLearnsVer();saveLearns(a);renderLearnList();renderLockLearns();syncToCloud(true).catch(()=>{});
    }));
    document.querySelectorAll('#learnList input[type=checkbox]').forEach(cb=>cb.addEventListener('change',e=>{
      const i=parseInt(cb.dataset.li);const a=loadLearns();a[i].show=cb.checked;bumpLearnsVer();saveLearns(a);renderLearnList();renderLockLearns();syncToCloud(true).catch(()=>{});
    }));
  }
  function renderLockLearns(){
    const ls=loadLearns();
    const container=document.getElementById('learnContainer');
    const visible=ls.filter(l=>l.show);
    if(visible.length===0){container.innerHTML='';return;}
    container.innerHTML=visible.map((l,i)=>'<div class="learn-module" data-li="'+i+'">'+esc(l.text)+'</div>').join('');
    container.querySelectorAll('.learn-module').forEach(el=>makeDraggable(el));
  }
  function initLearnFeature(){
    renderLockLearns();
    document.getElementById('learnBtn').addEventListener('click',()=>{
      renderLearnList();document.getElementById('newLearnInput').value='';document.getElementById('learnShowCheck').checked=true;document.getElementById('learnModal').classList.add('active');
    });
    document.getElementById('closeLearnModalBtn').addEventListener('click',()=>document.getElementById('learnModal').classList.remove('active'));
    document.getElementById('learnModal').addEventListener('click',e=>{if(e.target===document.getElementById('learnModal'))document.getElementById('learnModal').classList.remove('active');});
    document.getElementById('addLearnBtn').addEventListener('click',()=>{
      const t=document.getElementById('newLearnInput').value.trim();
      if(t){
        const show=document.getElementById('learnShowCheck').checked;
        const a=loadLearns();a.push({text:t,show});bumpLearnsVer();saveLearns(a);document.getElementById('newLearnInput').value='';
      }
      renderLearnList();renderLockLearns();syncToCloud(true).catch(()=>{});
    });
  }

  // ==================== 导出 ====================
  function initExport(){
    const savedUrl=localStorage.getItem('webhook_url')||'';
    document.getElementById('webhookUrlInput').value=savedUrl;
    document.getElementById('exportBtn').addEventListener('click',()=>{
      document.getElementById('exportStatus').innerText='';
      document.getElementById('exportModal').classList.add('active');
    });
    document.getElementById('closeExportModalBtn').addEventListener('click',()=>document.getElementById('exportModal').classList.remove('active'));
    document.getElementById('exportModal').addEventListener('click',e=>{if(e.target===document.getElementById('exportModal'))document.getElementById('exportModal').classList.remove('active');});
    async function doExport(type){
      const webhookUrl=document.getElementById('webhookUrlInput').value.trim();
      if(!webhookUrl){document.getElementById('exportStatus').innerText='请填写 Webhook URL';return;}
      localStorage.setItem('webhook_url',webhookUrl);
      document.getElementById('exportStatus').innerText='发送中...';
      try{
        const r=await fetch('/api/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,webhookUrl})});
        if(r.ok){document.getElementById('exportStatus').innerText='✅ 已发送到企业微信';}
        else{document.getElementById('exportStatus').innerText='❌ 发送失败，请检查 URL';}
      }catch(e){document.getElementById('exportStatus').innerText='❌ 网络错误';}
    }
    document.getElementById('exportWeekBtn').addEventListener('click',()=>doExport('week'));
    document.getElementById('exportMonthBtn').addEventListener('click',()=>doExport('month'));
  }

  // ==================== 初始化 ====================
  function initDark(){
    const btn=document.getElementById('darkToggleBtn');
    const updateDarkTitle=()=>btn.title=document.body.classList.contains('dark-mode')?'☀️ 浅色模式':'🌙 深色模式';
    if(localStorage.getItem(DARK_K)==='true')document.body.classList.add('dark-mode');
    updateDarkTitle();
    btn.addEventListener('click',()=>{document.body.classList.toggle('dark-mode');localStorage.setItem(DARK_K,document.body.classList.contains('dark-mode'));updateDarkTitle();});
  }
  function isLocked(){return localStorage.getItem(LOCK_K)==='true';}
  function setLocked(l){if(l){localStorage.setItem(LOCK_K,'true');document.body.classList.add('page-hidden');setTimeout(()=>{const pi=document.getElementById('pinInput');if(pi)pi.focus();},100);}else{localStorage.setItem(LOCK_K,'false');document.body.classList.remove('page-hidden');}}

  const pi=document.getElementById('pinInput'),pib=document.getElementById('pinUnlockBtn'),pie=document.getElementById('pinError');
  function au(){const e=pi.value.trim();if(e===DEFAULT_PIN){localStorage.setItem(UNLOCK_TS_K,Date.now());setLocked(false);pi.value='';pie.innerText='';refreshAll();}else{pie.innerText='PIN码错误';pi.value='';setTimeout(()=>pi.focus(),50);}}
  pib.addEventListener('click',au);pi.addEventListener('keypress',e=>{if(e.key==='Enter')au();});
  document.getElementById('hideBtn').addEventListener('click',()=>{setLocked(true);pi.value='';pie.innerText='';});
  window.addEventListener('keydown',e=>{if(e.ctrlKey&&e.key==='z'){const a=document.activeElement;if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'))return;e.preventDefault();if(document.body.classList.contains('page-hidden'))pie.innerText='请使用PIN解锁';else{setLocked(true);pi.value='';pie.innerText='';}}});
  window.addEventListener('keydown',e=>{if(e.key==='+'||e.key==='='){e.preventDefault();modCounter(WECHAT_K,1);}else if(e.key==='-'||e.key==='_'){e.preventDefault();modCounter(WECHAT_K,-1);}});

  document.getElementById('wechatPlus').addEventListener('click',()=>modCounter(WECHAT_K,1));
  document.getElementById('wechatMinus').addEventListener('click',()=>modCounter(WECHAT_K,-1));
  document.getElementById('resetWechatToday').addEventListener('click',()=>resetToday(WECHAT_K));
  document.getElementById('addClientBtn').addEventListener('click',addClient);
  document.getElementById('addTodayTodoBtn').addEventListener('click',addTodayTodo);
  document.getElementById('addTodoBtn').addEventListener('click',addTodo);
  document.getElementById('todayTodoInput').addEventListener('keypress',e=>{if(e.key==='Enter')addTodayTodo();});
  document.getElementById('todoInput').addEventListener('keypress',e=>{if(e.key==='Enter')addTodo();});
  ['custName','custPhone','custNote'].forEach(id=>document.getElementById(id).addEventListener('keypress',e=>{if(e.key==='Enter')addClient();}));
  document.getElementById('closeModalBtn').addEventListener('click',()=>document.getElementById('dateModal').classList.remove('active'));
  document.getElementById('dateModal').addEventListener('click',e=>{if(e.target===document.getElementById('dateModal'))document.getElementById('dateModal').classList.remove('active');});

  // 后端自动实时同步（无需手动点击）

  // 启动云端同步定时器
  function startSyncTimer(){
    if(syncTimer)clearInterval(syncTimer);
    // 定时拉取其他设备更新；推送仅在用户操作时即时触发
    syncTimer=setInterval(()=>{pullFromCloud().catch(()=>{});},SYNC_INTERVAL);
    // 定时推送业务数据（计数、客户、待办）
    setInterval(()=>{if(!document.body.classList.contains('page-hidden'))syncToCloud(false).catch(()=>{});},SYNC_INTERVAL);
  }

  // 提醒检查
  let lastNotified={};
  setInterval(()=>{
    const now=new Date();
    const hm=String(now.getHours()).padStart(2,'0')+':'+String(now.getMinutes()).padStart(2,'0');
    const today=getTodayStr();
    const all=[...loadTodos(TODAY_TODO_K).map(t=>({...t,list:'today',targetDate:t.date||today})),...loadTodos(TOMORROW_TODO_K).map(t=>{
      const cd=t.date||today;const d=new Date(cd);d.setDate(d.getDate()+1);
      const td=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
      return {...t,list:'tomorrow',targetDate:td};
    })];
    for(const t of all){
      if(!t.remind||t.remind!==hm)continue;
      if(t.targetDate!==today)continue;
      const key=t.list+'_'+t.text+'_'+t.remind+'_'+today;
      if(lastNotified[key])continue;
      lastNotified[key]=true;
      document.getElementById('notifyText').innerText='🔔 '+esc(t.text)+' ('+esc(t.remind)+')';
      document.getElementById('notifyBar').classList.add('show');
      setTimeout(()=>document.getElementById('notifyBar').classList.remove('show'),8000);
    }
  },30000);

  initDark();initWp();initScriptFeature();initLearnFeature();initExport();
  const UNLOCK_TS_K='unlock_ts';
  if((Date.now()-parseInt(localStorage.getItem(UNLOCK_TS_K)||'0'))<3600000){setLocked(false);}else{setLocked(true);}

  // 首次加载从云端恢复数据
  (async()=>{
    const prevLastLoadDate=localStorage.getItem(LAST_LOAD_DATE_K);
    await loadFromCloud(getTodayStr());
    // 跨天自动转移昨日「明日待办」到今日
    const todayStr=getTodayStr();
    if(prevLastLoadDate && prevLastLoadDate!==todayStr){
      let transferred=false;
      try{
        // 优先从前一天云端记录拉取 tomorrowTodos
        const yd=await cloudGet(prevLastLoadDate);
        if(yd && yd.tomorrowTodos && yd.tomorrowTodos.length>0){
          const cur=loadTodos(TODAY_TODO_K);
          saveTodos(TODAY_TODO_K,[...yd.tomorrowTodos,...cur]);
          saveTodos(TOMORROW_TODO_K,[]);
          transferred=true;
          console.log('📅 已从云端转移昨日待办到今日');
        }
      }catch(e){}
      if(!transferred){
        const tomorrow=loadTodos(TOMORROW_TODO_K);
        if(tomorrow.length>0){
          const cur=loadTodos(TODAY_TODO_K);
          saveTodos(TODAY_TODO_K,[...tomorrow,...cur]);
          saveTodos(TOMORROW_TODO_K,[]);
          console.log('📅 已转移本地昨日待办到今日');
        }
      }
    }
    localStorage.setItem(LAST_LOAD_DATE_K,todayStr);
    await syncCalendarFromCloud();
    renderLockScripts();renderLockLearns();
    refreshAll();
    startSyncTimer();
  })();

  setInterval(()=>{if(!document.body.classList.contains('page-hidden'))refreshAll();},60000);
})();
</script>
</body>
</html>`;

    // 返回 HTML 页面
    return new Response(HTML, {
      headers: { 'Content-Type': 'text/html; charset=UTF-8' }
    });
  }
};
