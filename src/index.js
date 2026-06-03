// 每日工作 - Cloudflare Worker 版本
// 部署后绑定 DATA_KV 即可使用

import { DIALER_HTML } from './dialer_html.js';
import { createSupabaseClient } from './supabase.js';

async function getAllKVKeys(env, prefix) {
  let keys = [];
  let cursor = undefined;
  while (true) {
    const list = await env.DATA_KV.list({ prefix, cursor });
    keys.push(...list.keys);
    if (list.list_complete || !list.cursor) {
      break;
    }
    cursor = list.cursor;
  }
  return keys;
}

async function getKVValuesConcurrently(env, keys) {
  const results = [];
  const concurrency = 30;
  for (let i = 0; i < keys.length; i += concurrency) {
    const chunk = keys.slice(i, i + concurrency);
    const promises = chunk.map(key => env.DATA_KV.get(key.name).then(val => ({ name: key.name, val })));
    const resolved = await Promise.all(promises);
    results.push(...resolved);
  }
  return results;
}

async function sendWebhookMarkdown(url, baseHeader, items, itemFormatter) {
  const enc = new TextEncoder();
  let currentText = baseHeader;
  let currentBytes = enc.encode(baseHeader).length;
  let part = 1;
  const sendChunk = async (content) => {
    const whResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown', markdown: { content } })
    });
    if (!whResp.ok) {
      throw new Error('HTTP ' + whResp.status + ': ' + (await whResp.text()));
    }
    const body = await whResp.json();
    if (body.errcode !== 0) {
      throw new Error('WeChat API 错误 [' + body.errcode + ']: ' + (body.errmsg || '未知'));
    }
  };

  for (const item of items) {
    const itemText = itemFormatter(item);
    const itemBytes = enc.encode(itemText).length;
    if (currentBytes + itemBytes > 4000) {
      await sendChunk(currentText);
      part++;
      currentText = '### ' + (baseHeader.match(/###\s*([^\n]+)/)?.[1] || '导出数据') + ' (续' + part + ')\n\n---\n\n' + itemText;
      currentBytes = enc.encode(currentText).length;
    } else {
      currentText += itemText;
      currentBytes += itemBytes;
    }
  }
  if (currentText.length > 0) {
    await sendChunk(currentText);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight handler
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // Supabase client（SUPABASE_URL/KEY 未配置时降级为 no-op）
    const supabase = createSupabaseClient(env);

    // 0. 安卓 App 自动更新接口
    if (path === '/api/app-version' && request.method === 'GET') {
      return new Response(JSON.stringify({
        versionCode: 2,
        versionName: "1.1.0",
        apkUrl: "https://github.com/Hqsxjj/megz/releases/download/latest/app-debug.apk",
        changeLog: "1. 新增本地通话录音深度检索与直接在卡片上播放支持\n2. 适配高版本 Android MediaStore 通话录音音频检索\n3. 深度整合双卡轮拨与通话记录时长自动提取"
      }), {
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // ==================== BHP 拨号器接口与页面并入 ====================
    
    // 1. 获取拨号器数据
    if (path === '/api/dialer/data' && request.method === 'GET') {
      const data = await env.DATA_KV.get('dialer:data');
      return new Response(data || JSON.stringify({ clients: [] }), {
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // 2. 保存拨号器数据
    if (path === '/api/dialer/data' && request.method === 'POST') {
      try {
        const body = await request.json();
        await env.DATA_KV.put('dialer:data', JSON.stringify(body));
        return new Response(JSON.stringify({ success: true }), {
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    // 3. 代理 SheetJS 资源以加快文件解析加载
    if (path === '/xlsx.full.min.js') {
      return fetch('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js');
    }

    // 4. 服务 PWA manifest
    if (path === '/manifest.json') {
      const manifest = {
        name: '每日工作',
        short_name: '每日工作',
        description: '每日工作追踪：微信、意向、上门、回款、待办',
        start_url: '/',
        display: 'standalone',
        background_color: '#ededed',
        theme_color: '#4a6cf7',
        orientation: 'portrait',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
        ]
      };
      return new Response(JSON.stringify(manifest), {
        headers: { 'Content-Type': 'application/manifest+json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 5. 服务 App 图标 SVG
    if (path === '/icon.svg') {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#4a6cf7"/><stop offset="50%" stop-color="#6b8dff"/><stop offset="100%" stop-color="#07c160"/></linearGradient></defs><rect width="512" height="512" rx="110" fill="url(#bg)"/><rect x="72" y="96" width="368" height="344" rx="50" fill="none" stroke="white" stroke-width="22"/><line x1="72" y1="196" x2="440" y2="196" stroke="white" stroke-width="22"/><rect x="140" y="48" width="44" height="88" rx="22" fill="white"/><rect x="328" y="48" width="44" height="88" rx="22" fill="white"/><circle cx="180" cy="290" r="28" fill="white"/><circle cx="256" cy="290" r="28" fill="white"/><circle cx="332" cy="290" r="28" fill="white"/><circle cx="180" cy="380" r="28" fill="white"/><circle cx="256" cy="380" r="28" fill="white"/></svg>`;
      return new Response(svg, {
        headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 6. 服务拨号器单页 HTML
    if (path === '/dialer' || path === '/dialer/') {
      return new Response(DIALER_HTML, {
        headers: { 'Content-Type': 'text/html; charset=UTF-8' }
      });
    }

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
        revisitCount: 0,
        visitCount: 0,
        paymentCount: 0,
        clients: [],
        todayTodos: [],
        tomorrowTodos: [],
        tempClients: [],
        lastLoadDate: date
      };
      if (!data.lastLoadDate) data.lastLoadDate = date;
      if (!data.tempClients) data.tempClients = [];
      if (data.visitCount === undefined) data.visitCount = 0;
      if (data.paymentCount === undefined) data.paymentCount = 0;
      // Inject global webhook URL so it persists across all dates and new days
      data.webhookUrl = await env.DATA_KV.get('config:webhook_url') || '';
      // Inject goals
      data.goals = JSON.parse(await env.DATA_KV.get('config:goals') || '{}');
      return new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 保存数据（服务端合并，解决多设备同步冲突）
    if (path === '/api/data' && request.method === 'POST') {
      const body = await request.json();
      const items = Array.isArray(body) ? body : [body];
      let hasError = false;
      for (const item of items) {
        const { date, wechatCount, intentCount, revisitCount, visitCount, paymentCount, clients, todayTodos, tomorrowTodos, tempClients, scripts, learns, todoLog, webhookUrl, _ts } = item;
        if (!date) { hasError = true; continue; }
        
        // If a non-empty Webhook URL is supplied, persist it globally
        if (webhookUrl) {
          await env.DATA_KV.put('config:webhook_url', webhookUrl);
        }

        // 读取云端现有数据
        const rawExisting = await env.DATA_KV.get(`work:${date}`);
        const existing = rawExisting ? JSON.parse(rawExisting) : {};
        // 客户列表按 phone 号码唯一性合并（同一电话号码只保留最新记录）
        // incoming 中的客户记录会覆盖 base 中相同电话号码的旧记录
        const mergeClients = (base, incoming) => {
          const map = new Map();
          (base || []).forEach(c => map.set(c.phone, c));
          (incoming || []).forEach(c => map.set(c.phone, c));
          return [...map.values()];
        };
        const mergedClients = mergeClients(existing.clients, clients);
        const merged = {
          date,
          wechatCount: Math.max(existing.wechatCount || 0, wechatCount || 0),
          intentCount: mergedClients.length,
          revisitCount: Math.max(existing.revisitCount || 0, revisitCount || 0),
          visitCount: Math.max(existing.visitCount || 0, visitCount || 0),
          paymentCount: Math.max(existing.paymentCount || 0, paymentCount || 0),
          clients: mergedClients,
          todayTodos: todayTodos || existing.todayTodos || [],
          tomorrowTodos: tomorrowTodos || existing.tomorrowTodos || [],
          tempClients: tempClients || existing.tempClients || [],
          scripts: scripts || existing.scripts || [],
          learns: learns || existing.learns || [],
          todoLog: todoLog || existing.todoLog || [],
          webhookUrl: webhookUrl || existing.webhookUrl || '',
          lastLoadDate: date,
          lastModified: new Date().toISOString(),
          _ts: _ts || Date.now()
        };
        await env.DATA_KV.put(`work:${date}`, JSON.stringify(merged));
      }
      if (items.length === 0 || (hasError && items.length === 1)) {
        return new Response(JSON.stringify({ error: '缺少 date 参数' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 原子操作同步 —— 每个增删改作为独立 delta 推送到 KV，保证最快同步
    if (path === '/api/sync' && request.method === 'POST') {
      const body = await request.json();
      const { date, op } = body;
      if (!date || !op) {
        return new Response(JSON.stringify({ error: '缺少 date 或 op 参数' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      const raw = await env.DATA_KV.get(`work:${date}`);
      const data = raw ? JSON.parse(raw) : {
        date, wechatCount: 0, intentCount: 0, revisitCount: 0, visitCount: 0, paymentCount: 0, clients: [],
        todayTodos: [], tomorrowTodos: [], tempClients: [], scripts: [], learns: [], todoLog: []
      };
      if (!data.tempClients) data.tempClients = [];
      const ts = Date.now();
      switch (op) {
        case 'incWechat': {
          const delta = body.delta || 0;
          data.wechatCount = Math.max((data.wechatCount || 0) + delta, 0);
          break;
        }
        case 'incRevisit': {
          const delta = body.delta || 0;
          data.revisitCount = Math.max((data.revisitCount || 0) + delta, 0);
          break;
        }
        case 'incVisit': {
          const delta = body.delta || 0;
          data.visitCount = Math.max((data.visitCount || 0) + delta, 0);
          break;
        }
        case 'incPayment': {
          const delta = body.delta || 0;
          data.paymentCount = Math.max((data.paymentCount || 0) + delta, 0);
          break;
        }
        case 'addClient': {
          if (body.client) {
            data.clients = [...(data.clients || []), body.client];
            data.intentCount = data.clients.length;
          }
          break;
        }
        // DEPRECATED: Use removeClientByMatch instead to avoid index mismatch on multi-device concurrent deletes
        case 'removeClientByIndex': {
          if (body.index !== undefined && body.index >= 0) {
            data.clients = data.clients || [];
            data.clients.splice(body.index, 1);
            data.intentCount = data.clients.length;
          }
          break;
        }
        case 'removeClientByMatch': {
          if (body.name && body.phone && body.time) {
            data.clients = (data.clients || []).filter(
              c => !(c.name === body.name && c.phone === body.phone && c.time === body.time)
            );
            data.intentCount = data.clients.length;
          }
          break;
        }
        case 'updateClient': {
          if (body.matchName && body.matchPhone && body.client) {
            data.clients = data.clients || [];
            const idx = data.clients.findIndex(c =>
              c.name === body.matchName &&
              c.phone === body.matchPhone &&
              (body.matchTime ? c.time === body.matchTime : true)
            );
            if (idx >= 0) {
              data.clients[idx] = body.client;
            } else {
              data.clients.push(body.client);
            }
            data.intentCount = data.clients.length;
          }
          break;
        }
        case 'updateClientNote': {
          if (body.name && body.phone && body.note !== undefined) {
            data.clients = (data.clients || []).map(c =>
              c.name === body.name && c.phone === body.phone ? { ...c, note: body.note } : c
            );
          }
          break;
        }
        case 'setTodayTodos':
          data.todayTodos = body.todos || [];
          break;
        case 'setTomorrowTodos':
          data.tomorrowTodos = body.todos || [];
          break;
        case 'setTempClients':
          data.tempClients = body.tempClients || [];
          break;
        case 'pushTodoLog':
          if (body.todo) {
            data.todoLog = [...(data.todoLog || []), body.todo];
          }
          break;
        case 'setScripts':
          data.scripts = body.scripts || [];
          break;
        case 'setLearns':
          data.learns = body.learns || [];
          break;
        case 'setAllClients':
          data.clients = body.clients || [];
          data.intentCount = (body.clients || []).length;
          break;
        case 'setWebhookUrl':
          data.webhookUrl = body.webhookUrl || '';
          await env.DATA_KV.put('config:webhook_url', data.webhookUrl);
          break;
        case 'setGoals':
          await env.DATA_KV.put('config:goals', JSON.stringify(body.goals || {}));
          break;
        default:
          return new Response(JSON.stringify({ error: '未知操作: ' + op }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
      }
      data._ts = ts;
      data.lastModified = new Date().toISOString();
      await env.DATA_KV.put(`work:${date}`, JSON.stringify(data));
      return new Response(JSON.stringify({ success: true, _ts: ts }), {
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
      const keys = await getAllKVKeys(env, 'work:' + month);
      const keyValues = await getKVValuesConcurrently(env, keys);
      const calendar = {};
      for (const kv of keyValues) {
        if (kv.val) {
          try {
            const d = JSON.parse(kv.val);
            const dateKey = kv.name.replace('work:', '');
            calendar[dateKey] = {
              w: d.wechatCount || 0,
              i: d.intentCount || 0,
              r: d.revisitCount || 0,
              v: d.visitCount || 0,
              p: d.paymentCount || 0
            };
          } catch(e) {}
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
      const keys = await getAllKVKeys(env, 'work:' + month);
      const keyValues = await getKVValuesConcurrently(env, keys);
      let weekW = 0, monthW = 0, weekI = 0, monthI = 0, weekR = 0, monthR = 0, weekV = 0, monthV = 0, weekP = 0, monthP = 0;
      const today = new Date();
      const dow = today.getDay();
      const diff = (dow === 0 ? 6 : dow - 1);
      const mon = new Date(today);
      mon.setDate(today.getDate() - diff);
      const monStr = mon.getFullYear() + '-' + String(mon.getMonth()+1).padStart(2,'0') + '-' + String(mon.getDate()).padStart(2,'0');
      const todayStr = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
      for (const kv of keyValues) {
        if (kv.val) {
          try {
            const d = JSON.parse(kv.val);
            monthW += d.wechatCount || 0;
            monthI += d.intentCount || 0;
            monthR += d.revisitCount || 0;
            monthV += d.visitCount || 0;
            monthP += d.paymentCount || 0;
            if (d.date >= monStr && d.date <= todayStr) {
              weekW += d.wechatCount || 0;
              weekI += d.intentCount || 0;
              weekR += d.revisitCount || 0;
              weekV += d.visitCount || 0;
              weekP += d.paymentCount || 0;
            }
          } catch(e) {}
        }
      }
      const goals = JSON.parse(await env.DATA_KV.get('config:goals') || '{}');
      return new Response(JSON.stringify({ weekW, monthW, weekI, monthI, weekR, monthR, weekV, monthV, weekP, monthP, goals }), {
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }
    // 获取全量意向客户
    if (path === '/api/all-clients' && request.method === 'GET') {
      const keys = await getAllKVKeys(env, 'work:');
      const keyValues = await getKVValuesConcurrently(env, keys);
      const allClients = [];
      for (const kv of keyValues) {
        if (kv.val) {
          try {
            const d = JSON.parse(kv.val);
            if (d.clients) {
              d.clients.forEach(c => {
                c.date = c.date || kv.name.replace('work:', '');
                allClients.push(c);
              });
            }
          } catch(e) {}
        }
      }
      allClients.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
      return new Response(JSON.stringify(allClients), {
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

      // SSRF Defence: Only allow official Weixin Work domain prefixes
      if (!webhookUrl.startsWith('https://qyapi.weixin.qq.com/')) {
        return new Response(JSON.stringify({ error: 'SSRF 安全防御：仅允许向企业微信官方域名发送 Webhook 请求' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }

      // 导出单个意向客户
      if (type === 'single_client') {
        const client = body.client;
        if (!client) {
          return new Response(JSON.stringify({ error: '缺少 client 参数' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        const weekNames = ['日', '一', '二', '三', '四', '五', '六'];
        const datePart = (client.date || '').slice(5);
        const wk = client.date ? ' 周' + weekNames[new Date(client.date + 'T00:00:00').getDay()] : '';
        
        let text = '> 姓名：' + client.name + '\n';
        text += '> 日期: ' + datePart + wk + ' | 时间: ' + (client.time || '—') + '\n';
        text += '> 电话: ' + (client.phone || '—') + '\n';
        text += '> 单位: ' + (client.company || '—') + ' | 公积金: ' + (client.fund || '—') + '\n';
        if (client.note) text += '> 沟通: ' + client.note.replace(/\n/g, ' ') + '\n';
        if (client.followUp) text += '> 跟进: ' + client.followUp.replace(/\n/g, ' ') + '\n';
        
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
          return new Response(JSON.stringify({ error: '企业微信接口返回错误: ' + whResp.status }), {
            status: whResp.status,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: '发送 webhook 遇到网络错误: ' + e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
      }

      // 导出全量意向客户
      if (type === 'all_clients') {
        const keys = await getAllKVKeys(env, 'work:');
        const keyValues = await getKVValuesConcurrently(env, keys);
        const allClients = [];
        for (const kv of keyValues) {
          if (kv.val) {
            try {
              const d = JSON.parse(kv.val);
              if (d.clients) {
                (d.clients || []).forEach(c => {
                  allClients.push({ ...c, date: c.date || kv.name.replace('work:', '') });
                });
              }
            } catch(e) {}
          }
        }
        allClients.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

        const weekNames = ['日', '一', '二', '三', '四', '五', '六'];
        const total = allClients.length;

        const baseHeader = '### 意向客户全量表\n> 共计 **' + total + '** 位意向客户\n\n---\n\n';
        const itemFormatter = (c) => {
          const datePart = (c.date || '').slice(5);
          const wk = c.date ? ' 周' + weekNames[new Date(c.date + 'T00:00:00').getDay()] : '';
          let itemText = '> 姓名：' + c.name + '\n';
          itemText += '> 日期: ' + datePart + wk + ' | 时间: ' + (c.time || '—') + '\n';
          itemText += '> 电话: ' + (c.phone || '—') + '\n';
          itemText += '> 单位: ' + (c.company || '—') + ' | 公积金: ' + (c.fund || '—') + '\n';
          if (c.note) itemText += '> 沟通: ' + c.note.replace(/\n/g, ' ') + '\n';
          if (c.followUp) itemText += '> 跟进: ' + c.followUp.replace(/\n/g, ' ') + '\n';
          itemText += '\n';
          return itemText;
        };

        try {
          await sendWebhookMarkdown(webhookUrl, baseHeader, allClients, itemFormatter);
          return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: 'Webhook 发送失败: ' + e.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
      }

      // 逐条导出全量意向客户（每个客户一条消息）
      if (type === 'all_clients_solo') {
        const keys = await getAllKVKeys(env, 'work:');
        const keyValues = await getKVValuesConcurrently(env, keys);
        const allClients = [];
        for (const kv of keyValues) {
          if (kv.val) {
            try {
              const d = JSON.parse(kv.val);
              if (d.clients) {
                (d.clients || []).forEach(c => {
                  allClients.push({ ...c, date: c.date || kv.name.replace('work:', '') });
                });
              }
            } catch(e) {}
          }
        }
        allClients.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

        const weekNames = ['日', '一', '二', '三', '四', '五', '六'];
        const buildText = (c) => {
          const datePart = (c.date || '').slice(5);
          const wk = c.date ? ' 周' + weekNames[new Date(c.date + 'T00:00:00').getDay()] : '';
          let text = '> 姓名：' + c.name + '\n';
          text += '> 日期: ' + datePart + wk + ' | 时间: ' + (c.time || '—') + '\n';
          text += '> 电话: ' + (c.phone || '—') + '\n';
          text += '> 单位: ' + (c.company || '—') + ' | 公积金: ' + (c.fund || '—') + '\n';
          if (c.note) text += '> 沟通: ' + c.note.replace(/\n/g, ' ') + '\n';
          if (c.followUp) text += '> 跟进: ' + c.followUp.replace(/\n/g, ' ') + '\n';
          return text;
        };

        let sent = 0, failed = 0;
        const concurrency = 3;
        for (let i = 0; i < allClients.length; i += concurrency) {
          const batch = allClients.slice(i, i + concurrency);
          const results = await Promise.all(batch.map(async (c) => {
            try {
              const whResp = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ msgtype: 'markdown', markdown: { content: buildText(c) } })
              });
              if (!whResp.ok) throw new Error('HTTP ' + whResp.status);
              const body = await whResp.json();
              if (body.errcode !== 0) throw new Error('[errcode ' + body.errcode + '] ' + (body.errmsg || ''));
              return true;
            } catch(e) { return false; }
          }));
          for (const r of results) {
            if (r) sent++; else failed++;
          }
        }

        return new Response(JSON.stringify({ success: true, sent, failed, total: allClients.length }), {
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

      const keys = await getAllKVKeys(env, 'work:' + monthPrefix);
      const keyValues = await getKVValuesConcurrently(env, keys);
      let weekW = 0, monthW = 0, weekI = 0, monthI = 0, weekR = 0, monthR = 0;
      const sorted = [];
      for (const kv of keyValues) {
        if (!kv.val) continue;
        try {
          const d = JSON.parse(kv.val);
          sorted.push(d);
          monthW += d.wechatCount || 0;
          monthI += d.intentCount || 0;
          monthR += d.revisitCount || 0;
          if (d.date >= monStr && d.date <= todayStr) {
            weekW += d.wechatCount || 0;
            weekI += d.intentCount || 0;
            weekR += d.revisitCount || 0;
          }
        } catch(e) {}
      }
      sorted.sort((a,b) => (a.date||'').localeCompare(b.date||''));

      const weekNames = ['日', '一', '二', '三', '四', '五', '六'];
      const title = type === 'week' ? '本周数据统计' : '本月数据统计';
      const dateRange = type === 'week'
        ? monStr + ' ～ ' + todayStr
        : monthPrefix + '-01 ～ ' + todayStr;
      const wTotal = type === 'week' ? weekW : monthW;
      const iTotal = type === 'week' ? weekI : monthI;
      const rTotal = type === 'week' ? weekR : monthR;

      const baseHeader = '### ' + title + '\n' +
        '> ' + dateRange + '\n\n' +
        '<font color="info">新增微信：**' + wTotal + '**</font>\n' +
        '<font color="warning">新增意向：**' + iTotal + '**</font>\n' +
        '<font color="comment">客户回访：**' + rTotal + '**</font>\n' +
        (type !== 'week' ? '\n> 本周参考: 微信 **' + weekW + '** | 意向 **' + weekI + '** | 回访 **' + weekR + '**\n' : '') +
        '\n---\n\n';

      const activeDays = sorted.filter(d => {
        if (type === 'week' && (d.date < monStr || d.date > todayStr)) return false;
        return true;
      });

      const itemFormatter = (d) => {
        const datePart = d.date.slice(5);
        const wk = '周' + weekNames[new Date(d.date + 'T00:00:00').getDay()];
        const w = d.wechatCount || 0;
        const it = d.intentCount || 0;
        const r = d.revisitCount || 0;
        
        const clients = d.clients || [];
        let detail = '';
        if (clients.length > 0) {
          detail = clients.map(c => c.name + (c.company ? ' [' + c.company + ']' : '') + (c.fund ? ' {' + c.fund + '}' : '') + (c.note ? ' （' + c.note + '）' : '')).join('\n> ');
        } else {
          detail = '*(无新增意向)*';
        }
        
        let itemText = '**' + datePart + ' ' + wk + '**\n';
        itemText += '> <font color="info">微信: ' + w + '</font> | <font color="warning">意向: ' + it + '</font> | <font color="comment">回访: ' + r + '</font>\n';
        itemText += '> ' + detail + '\n\n';
        return itemText;
      };

      try {
        await sendWebhookMarkdown(webhookUrl, baseHeader, activeDays, itemFormatter);
        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: 'Webhook 发送失败: ' + e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // ==================== HTML 页面 ====================
    
    const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=yes, viewport-fit=cover, shrink-to-fit=no">
  <title>每日工作</title>
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="theme-color" content="#ededed">
  <link rel="manifest" href="/manifest.json">
  <link rel="apple-touch-icon" href="/icon.svg">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
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
      --cal-hover: #f5f5f5;
      --cal-today: rgba(7,193,96,0.1);
      --border-light: #e5e5e5;
      --tooltip-bg: #191919;
      --tooltip-text: #ffffff;
      --modal-bg: rgba(0,0,0,0.45);
      --modal-card: #ffffff;
      --radius-ios: 10px;
      --radius-sm: 8px;
      --radius-xs: 6px;
      --wechat-gradient: linear-gradient(135deg, #b7f0ce 0%, #6be89d 50%, #1aad5a 100%);
      --intent-gradient: linear-gradient(135deg, #ffe0b2 0%, #ffb74d 50%, #f57c00 100%);
      --revisit-gradient: linear-gradient(135deg, #d1e0ff 0%, #7b9ff5 50%, #4a6cf7 100%);
      --visit-gradient: linear-gradient(135deg, #c8e6c9 0%, #66bb6a 50%, #388e3c 100%);
      --payment-gradient: linear-gradient(135deg, #fff9c4 0%, #ffd54f 50%, #f9a825 100%);
      --today-gradient: linear-gradient(135deg, #ffe0cc 0%, #ffab7a 50%, #ff7744 100%);
      --stats-gradient: linear-gradient(135deg, #d4f0f0 0%, #80cbc4 50%, #26a69a 100%);
      --wallpaper-url: '';
      --wallpaper-opacity: 0.13;
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
      --cal-hover: #222222;
      --cal-today: rgba(7,193,96,0.18);
      --border-light: #262626;
      --tooltip-bg: #e5e5e5;
      --tooltip-text: #111111;
      --modal-bg: rgba(0,0,0,0.88);
      --modal-card: #1a1a1a;
      --wechat-gradient: linear-gradient(135deg, #0d3320 0%, #144d2e 50%, #1a6b3a 100%);
      --intent-gradient: linear-gradient(135deg, #332010 0%, #4d2e14 50%, #6b3a1a 100%);
      --revisit-gradient: linear-gradient(135deg, #1a2233 0%, #2a354d 50%, #3a4d6b 100%);
      --visit-gradient: linear-gradient(135deg, #1b3320 0%, #2d5a30 50%, #3d7a40 100%);
      --payment-gradient: linear-gradient(135deg, #332b10 0%, #5a4a1a 50%, #7a6a20 100%);
      --today-gradient: linear-gradient(135deg, #2a1a0d 0%, #3d2614 50%, #52331a 100%);
      --stats-gradient: linear-gradient(135deg, #0d2626 0%, #143d3d 50%, #1a5252 100%);
      --wallpaper-opacity: 0.12;
    }
    html, body { height: 100%; min-height: 100%; min-height: -webkit-fill-available; width: 100%; overflow: hidden; background: var(--bg-app); font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", sans-serif; font-weight: 700; transition: background 0.3s; position: relative; }
    .wallpaper-background { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 0; background-image: var(--wallpaper-url); background-size: cover; background-position: center; background-repeat: no-repeat; opacity: var(--wallpaper-opacity); transition: opacity 0.8s ease, background-image 0.8s ease; pointer-events: none; }
    body.dark-mode .wallpaper-background { opacity: 0.12; }
    .wallpaper-fallback { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: -1; background: linear-gradient(135deg, #a8e6cf 0%, #dcedc1 100%); opacity: 0.15; pointer-events: none; }
    body.dark-mode .wallpaper-fallback { background: linear-gradient(180deg, #0a0a0a 0%, #141414 50%, #0d0d0d 100%); opacity: 0.6; }
    .privacy-mask { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.3); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); z-index: 9999; flex-direction: column; justify-content: center; align-items: center; gap: 2rem; color: var(--text-main); font-weight: 600; pointer-events: none; }
    .privacy-wallpaper { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 9998; background-image: var(--wallpaper-url); background-size: cover; background-position: center; background-repeat: no-repeat; opacity: 0; transition: opacity 0.5s ease; pointer-events: none; }
    body.page-hidden .privacy-wallpaper { opacity: 0.85; pointer-events: auto; }
    body.dark-mode.page-hidden .privacy-wallpaper { opacity: 0.70; }
    body.page-hidden .privacy-mask { display: flex; pointer-events: auto; }
    body.page-hidden .app-shell { display: none; }
    .pin-box { display: flex; flex-direction: column; align-items: center; gap: 22px; background: #ffffff; padding: 45px 56px; border-radius: var(--radius-ios); box-shadow: 0 8px 30px rgba(0,0,0,0.08); border: 1px solid rgba(0,0,0,0.04); min-width: 448px; max-width: 588px; transition: all 0.3s ease; z-index: 45; position: absolute; top: 60%; left: 50%; transform: translate(-50%, -50%); }
    body.dark-mode .pin-box { background: rgba(26,26,26,0.9); border: 1px solid rgba(255,255,255,0.06); box-shadow: 0 25px 60px rgba(0,0,0,0.55); }
    .pin-stats { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; }
    .pin-stat-item { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 12px 16px; background: #fafafa; border-radius: var(--radius-sm); border: 1px solid rgba(0,0,0,0.04); min-width: 110px; flex: 1; }
    body.dark-mode .pin-stat-item { background: rgba(38,38,38,0.7); border: 1px solid rgba(255,255,255,0.06); }
    .pin-stat-label { font-size: 0.82rem; font-weight: 700; color: var(--text-soft); letter-spacing: 0.3px; white-space: nowrap; }
    .pin-stat-value { font-size: 2.2rem; font-weight: 900; line-height: 1; }
    .pin-wechat-value { background: var(--wechat-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .pin-intent-value { background: var(--intent-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .pin-revisit-value { background: var(--revisit-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .pin-visit-value { background: var(--visit-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .pin-payment-value { background: var(--payment-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }
    .pin-input { width: 196px; padding: 11px 20px; border-radius: var(--radius-xs); border: 1.5px solid rgba(0,0,0,0.08); background: #fafafa; text-align: center; font-size: 1.4rem; letter-spacing: 7px; color: var(--text-main); outline: none; font-weight: 700; transition: all 0.3s; }
    body.dark-mode .pin-input { background: rgba(38,38,38,0.6); border-color: rgba(255,255,255,0.08); }
    .pin-input:focus { border-color: var(--accent-wechat); box-shadow: 0 0 0 4px rgba(7,193,96,0.25); background: #ffffff; }
    .pin-btn { background: var(--accent-wechat); border: none; color: white; padding: 11px 45px; border-radius: var(--radius-xs); font-weight: 700; cursor: pointer; font-size: 1.12rem; letter-spacing: 1px; transition: all 0.2s; box-shadow: 0 4px 15px rgba(7,193,96,0.25); }
    .pin-btn:hover { opacity: 0.9; transform: translateY(-2px); box-shadow: 0 6px 20px rgba(7,193,96,0.35); }
    .pin-btn:active { transform: translateY(0); }
    .pin-error { color: #e74c3c; font-size: 1.26rem; min-height: 24px; font-weight: 600; letter-spacing: 0.5px; }
    .timer-container { position: absolute; top: 18%; left: 50%; margin-left: -160px; width: 320px; z-index: 20000; display: none; cursor: grab; user-select: none; }
    .timer-container.show { display: block; }
    .timer-box { width: 100%; display: flex; flex-direction: column; gap: 12px; align-items: center; background: #ffffff; padding: 24px 32px; border-radius: var(--radius-ios); box-shadow: 0 4px 20px rgba(0,0,0,0.06); border: 1px solid rgba(0,0,0,0.04); }
    body.dark-mode .timer-box { background: rgba(26,26,26,0.9); border: 1px solid rgba(255,255,255,0.06); box-shadow: 0 15px 40px rgba(0,0,0,0.55); }
    .timer-display { font-size: 3.2rem; font-weight: 900; text-align: center; font-variant-numeric: tabular-nums; letter-spacing: 3px; color: var(--accent-wechat); text-shadow: 0 2px 8px rgba(0,0,0,0.1); height: 70px; line-height: 70px; display: block; }
    .timer-box.active .timer-input, .timer-box.active .timer-label, .timer-box.active .timer-separator { display: none; }
    .timer-inputs { display: flex; gap: 8px; justify-content: center; align-items: center; transition: all 0.3s ease; }
    .timer-input-group { display: flex; flex-direction: column; gap: 4px; align-items: center; }
    .timer-input { width: 50px; padding: 8px 6px; text-align: center; font-size: 1rem; font-weight: 700; border: 1.5px solid rgba(0,0,0,0.08); border-radius: var(--radius-xs); background: #fafafa; color: var(--text-main); outline: none; transition: all 0.2s; }
    body.dark-mode .timer-input { background: rgba(38,38,38,0.6); border-color: rgba(255,255,255,0.08); }
    .timer-input:focus { border-color: var(--accent-wechat); box-shadow: 0 0 0 3px rgba(7,193,96,0.25); background: #ffffff; }
    .timer-label { font-size: 0.75rem; font-weight: 600; color: var(--text-soft); }
    .timer-separator { font-size: 1.2rem; font-weight: 700; color: var(--text-main); margin-bottom: 12px; }
    .timer-buttons { display: flex; gap: 8px; justify-content: center; transition: all 0.3s ease; }
    .timer-btn { padding: 8px 16px; border: none; border-radius: var(--radius-xs); font-weight: 700; cursor: pointer; font-size: 0.9rem; transition: all 0.2s; }
    .timer-btn-start { background: var(--accent-wechat); color: white; box-shadow: 0 4px 12px rgba(7,193,96,0.25); }
    .timer-btn-start:hover { opacity: 0.9; transform: translateY(-2px); }
    .timer-btn-start:active { transform: translateY(0); }
    .timer-btn-reset { background: rgba(0,0,0,0.04); color: var(--text-main); }
    body.dark-mode .timer-btn-reset { background: rgba(255,255,255,0.06); }
    body.dark-mode .icon-simple { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.06); color: var(--text-main); }
    body.dark-mode .icon-simple:hover { background: rgba(255,255,255,0.1); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    body.dark-mode .goal-chip.goal-met { background: rgba(7,193,96,0.12); color: #2ecc71; }
    body.dark-mode .goal-chip.goal-half { background: rgba(245,124,0,0.12); color: #f0a04b; }
    body.dark-mode .goal-chip.goal-low { background: rgba(74,108,247,0.1); color: #7b9ff5; }
    body.dark-mode .sync-indicator { background: rgba(255,255,255,0.06); border-color: rgba(255,255,255,0.06); color: var(--text-main); }
    body.dark-mode .sync-indicator:hover { background: rgba(255,255,255,0.1); box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
    .timer-btn-reset:hover { background: rgba(0,0,0,0.08); }
    .timer-display.completed { animation: pulse 0.6s ease-in-out; }
    @keyframes pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.05); } }
    .notify-bar { position: fixed; top: 0; left: 0; right: 0; background: var(--accent-intent); color: #fff; padding: 12px 20px; font-size: 0.85rem; font-weight: 700; z-index: 10000; transform: translateY(-100%); transition: transform 0.3s ease; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.2); cursor: pointer; }
    .notify-bar.show { transform: translateY(0); }
    .notify-bar .notify-close { position: absolute; right: 14px; top: 50%; transform: translateY(-50%); font-size: 1.1rem; opacity: 0.7; }
    .script-container { position: absolute; left: 20px; top: 80px; display: flex; flex-direction: column; gap: 10px; max-width: 420px; z-index: 1; }
    .script-module { text-align: left; padding: 16px 20px; background: #ffffff; border-radius: var(--radius-ios); border: 1px solid rgba(0,0,0,0.04); box-shadow: 0 2px 12px rgba(0,0,0,0.06); cursor: grab; user-select: none; position: relative; font-size: 0.92rem; font-weight: 400; color: var(--text-main); line-height: 1.8; letter-spacing: 0.2px; white-space: pre-wrap; word-break: break-word; }
    body.dark-mode .script-module { background: rgba(26,26,26,0.9); border: 1px solid rgba(255,255,255,0.06); box-shadow: 0 25px 60px rgba(0,0,0,0.55); }
    .learn-container { position: absolute; right: 20px; top: 80px; display: flex; flex-direction: column; gap: 10px; max-width: 460px; z-index: 1; }
    .learn-module { padding: 16px 20px; background: #ffffff; border-radius: var(--radius-ios); border: 1px solid rgba(0,0,0,0.04); box-shadow: 0 2px 12px rgba(0,0,0,0.06); cursor: grab; user-select: none; position: relative; font-size: 0.85rem; font-weight: 400; color: var(--text-main); line-height: 1.8; letter-spacing: 0.2px; text-align: left; white-space: pre-wrap; word-break: break-word; }
    body.dark-mode .learn-module { background: rgba(26,26,26,0.9); border: 1px solid rgba(255,255,255,0.06); box-shadow: 0 25px 60px rgba(0,0,0,0.55); }
    .learn-check-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 0.8rem; color: var(--text-soft); font-weight: 600; }
    .learn-check-row input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--accent-wechat); cursor: pointer; }
    .script-input-modal { max-width: 460px; }
    .script-input-modal textarea { width: 100%; min-height: 100px; background: var(--btn-bg); border: 1px solid var(--card-border); border-radius: var(--radius-xs); padding: 12px 16px; font-size: 0.85rem; color: var(--text-main); outline: none; resize: vertical; font-weight: 600; line-height: 1.6; }
    .script-input-modal textarea:focus { border-color: var(--accent-wechat); }
    .script-list { max-height: 180px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
    .script-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--btn-bg); border-radius: var(--radius-xs); border: 1px solid var(--card-border); font-size: 0.78rem; color: var(--text-main); font-weight: 600; }
    .script-item-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-right: 8px; }
    .app-shell { height: 100%; height: 100dvh; width: 100%; display: flex; flex-direction: column; overflow: hidden; position: relative; z-index: 1; }
    .container { flex: 1; display: flex; flex-direction: column; padding: 14px 18px 12px; overflow-y: auto; scrollbar-width: thin; -webkit-overflow-scrolling: touch; }
    .header-bar { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 20px; padding-bottom: 6px; border-bottom: 1px solid var(--border-light); flex-shrink: 0; }
    .title-section { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
    h3 { font-size: 1.45rem; font-weight: 800; letter-spacing: -0.2px; color: var(--text-main); }
    .app-logo { display: flex; align-items: center; gap: 10px; }
    .app-icon { width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, #4a6cf7 0%, #6b8dff 40%, #07c160 100%); box-shadow: 0 0 24px rgba(74,108,247,0.3), 0 4px 16px rgba(7,193,96,0.2); position: relative; flex-shrink: 0; animation: iconPulse 4s ease-in-out infinite; }
    .app-icon svg { width: 100%; height: 100%; }
    @keyframes iconPulse { 0%, 100% { box-shadow: 0 0 24px rgba(74,108,247,0.3), 0 4px 16px rgba(7,193,96,0.2); } 50% { box-shadow: 0 0 36px rgba(74,108,247,0.45), 0 6px 24px rgba(7,193,96,0.3); } }
    body.dark-mode .app-icon { box-shadow: 0 0 20px rgba(74,108,247,0.4), 0 4px 16px rgba(7,193,96,0.25); }
    body.dark-mode .app-icon { animation: iconPulseDark 4s ease-in-out infinite; }
    @keyframes iconPulseDark { 0%, 100% { box-shadow: 0 0 20px rgba(74,108,247,0.4), 0 4px 16px rgba(7,193,96,0.25); } 50% { box-shadow: 0 0 32px rgba(74,108,247,0.55), 0 6px 24px rgba(7,193,96,0.35); } }
    /* PWA safe area for iOS notch & home indicator */
    .app-shell { padding-top: constant(safe-area-inset-top); padding-top: env(safe-area-inset-top); padding-bottom: constant(safe-area-inset-bottom); padding-bottom: env(safe-area-inset-bottom); }
    .container { padding-bottom: max(env(safe-area-inset-bottom),12px); }
    @media (max-width: 760px) { .app-icon { width: 34px; height: 34px; border-radius: 8px; } .app-logo { gap: 8px; } }
    .date-chip { background: var(--card-bg); padding: 4px 12px; border-radius: var(--radius-xs); font-size: 0.75rem; font-weight: 700; color: var(--text-soft); border: 1px solid var(--card-border); }
    .goal-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .goal-chip { background: var(--card-bg); padding: 4px 12px; border-radius: var(--radius-xs); font-size: 0.75rem; font-weight: 700; border: 1px solid var(--card-border); color: var(--text-soft); white-space: nowrap; cursor: default; }
    .goal-chip.goal-met { background: rgba(7,193,96,0.08); color: #07c160; }
    .goal-chip.goal-half { background: rgba(245,124,0,0.08); color: #e67e22; }
    .goal-chip.goal-low { background: rgba(74,108,247,0.06); color: #4a6cf7; }
    .goal-eye { background: none; border: none; cursor: pointer; font-size: 0.85rem; padding: 2px 4px; opacity: 0.5; transition: opacity 0.2s; line-height: 1; }
    .goal-eye:hover { opacity: 1; }
    .goal-eye.eye-off { opacity: 0.25; }
    .action-group { display: flex; gap: 10px; align-items: center; padding: 2px; position: relative; }
    .icon-simple { background: #f5f5f5; border: 1px solid rgba(0,0,0,0.04); min-width: 38px; height: 38px; padding: 0 6px; border-radius: var(--radius-xs); display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 0.78rem; color: var(--text-soft); transition: all 0.2s cubic-bezier(0.34,1.56,0.64,1); user-select: none; font-weight: 600; position: relative; white-space: nowrap; }
    .icon-simple:hover { background: #e8e8e8; transform: translateY(-2px) scale(1.06); box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
    .icon-simple:active { transform: translateY(0px) scale(0.98); }
	    .log-list { max-height: 50vh; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; font-size: 0.8rem; font-weight: 600; color: var(--text-main); margin-top: 10px; }
	    .log-item { background: var(--btn-bg); padding: 10px 14px; border-radius: var(--radius-xs); border: 1px solid var(--card-border); display: flex; flex-direction: column; gap: 6px; }
	    .log-time { font-size: 0.7rem; color: var(--text-light); }
	    .menu-dropdown { position: absolute; right: 0; top: 100%; margin-top: 8px; background: var(--card-bg); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border-radius: var(--radius-ios); border: 1px solid var(--card-border); box-shadow: 0 12px 32px rgba(0,0,0,0.15); display: none; flex-direction: column; gap: 2px; padding: 6px; z-index: 100; min-width: 168px; }
	    .menu-dropdown.show { display: flex; }
	    .menu-item { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: transparent; border: none; border-radius: var(--radius-xs); cursor: pointer; font-size: 0.8rem; font-weight: 600; color: var(--text-main); white-space: nowrap; transition: background 0.15s; width: 100%; text-align: left; }
	    .menu-item:hover { background: var(--btn-hover); }
    .two-columns { display: flex; gap: 20px; flex: 1; min-height: 0; }
    .left-area { flex: 1; display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    .right-area { flex: 2; display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    .card { background: var(--card-bg); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); border-radius: var(--radius-ios); border: 1px solid var(--card-border); box-shadow: var(--shadow-card); padding: 18px 20px; }
    .counter-row { display: flex; gap: 14px; }
    .counter-card { flex: 1; border-radius: var(--radius-sm); padding: 12px; border: 1px solid var(--card-border); position: relative; overflow: hidden; }
    .counter-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; bottom: 0; opacity: 0.15; z-index: 0; border-radius: var(--radius-sm); }
    .wechat-fill { background: var(--wechat-gradient); color: white; }
    .wechat-fill::before { background: var(--wechat-gradient); }
    .intent-fill { background: var(--intent-gradient); color: white; }
    .intent-fill::before { background: var(--intent-gradient); }
    .revisit-fill { background: var(--revisit-gradient); color: white; }
    .revisit-fill::before { background: var(--revisit-gradient); }
    .visit-fill { background: var(--visit-gradient); color: white; }
    .visit-fill::before { background: var(--visit-gradient); }
    .payment-fill { background: var(--payment-gradient); color: white; }
    .payment-fill::before { background: var(--payment-gradient); }
    .counter-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; position: relative; z-index: 1; }
    .counter-header .button-group { display: flex; gap: 6px; margin-top: 0; }
    .counter-header .circle-btn { width: 28px; height: 28px; font-size: 1.1rem; border-radius: 4px; }
    .counter-label { font-size: 0.8rem; font-weight: 700; color: rgba(255,255,255,0.95); text-shadow: 0 1px 2px rgba(0,0,0,0.1); }
    .reset-mini { background: rgba(255,255,255,0.3); border: none; font-size: 0.7rem; color: rgba(255,255,255,0.9); cursor: pointer; padding: 4px 8px; border-radius: var(--radius-xs); font-weight: 600; position: relative; z-index: 1; backdrop-filter: blur(4px); }
    .counter-value { font-size: 2.4rem; font-weight: 800; line-height: 1; color: white; text-shadow: 0 2px 4px rgba(0,0,0,0.15); position: relative; z-index: 1; }
    .counter-stats { display: flex; gap: 12px; margin-top: 6px; position: relative; z-index: 1; font-size: 0.7rem; color: rgba(255,255,255,0.8); font-weight: 600; }
    .counter-stats b { font-weight: 800; }
    .button-group { display: flex; gap: 12px; margin-top: 12px; position: relative; z-index: 1; }
    .circle-btn { width: 40px; height: 40px; border-radius: var(--radius-xs); background: rgba(255,255,255,0.35); border: 1px solid rgba(255,255,255,0.5); font-size: 1.5rem; display: flex; align-items: center; justify-content: center; cursor: pointer; color: white; font-weight: 700; backdrop-filter: blur(4px); transition: 0.2s; }
    .circle-btn:hover { background: rgba(255,255,255,0.5); }
    .btn-special { background: rgba(255,255,255,0.45); }
    .stats-row { display: flex; gap: 10px; }
    .stat-block { flex: 1; text-align: center; border-radius: var(--radius-sm); padding: 10px 4px; border: 1px solid var(--card-border); color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.1); box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
    .stat-wechat { background: var(--wechat-gradient); }
    .stat-intent { background: var(--intent-gradient); }
    .stat-revisit { background: var(--revisit-gradient); }
    .stat-block .label { font-size: 0.7rem; font-weight: 600; opacity: 0.9; }
    .stat-block .number { font-size: 1.35rem; font-weight: 800; margin-left: 4px; }
    .calendar-compact { padding: 10px 12px; }
    .cal-head { display: flex; align-items: center; justify-content: center; gap: 10px; font-size: 0.8rem; font-weight: 700; color: var(--text-soft); margin-bottom: 8px; }
    .cal-nav-btn { background: none; border: 1px solid var(--card-border); border-radius: var(--radius-xs); cursor: pointer; padding: 2px 8px; font-size: 0.7rem; color: var(--text-soft); transition: all 0.2s; }
    .cal-nav-btn:hover { background: var(--card-bg); color: var(--text-main); }
    .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; text-align: center; }
    .cal-weekday { font-size: 0.65rem; font-weight: 800; color: var(--text-soft); padding: 4px 0; }
    .cal-day { aspect-ratio: 1/1; display: flex; flex-direction: column; align-items: center; justify-content: center; border-radius: var(--radius-xs); font-size: 0.7rem; font-weight: 800; color: var(--text-main); background: transparent; cursor: pointer; transition: 0.2s; position: relative; }
    .cal-day:hover { background: var(--cal-hover); transform: scale(0.98); }
    .cal-day.today { background: var(--today-gradient); color: white; box-shadow: 0 0 20px rgba(255,138,101,0.5); text-shadow: 0 1px 2px rgba(0,0,0,0.2); }
    .cal-day.past { background: rgba(128,138,150,0.08); color: var(--text-soft); }
    body.dark-mode .cal-day.past { background: rgba(255,255,255,0.03); }
    .day-number { font-size: 0.78rem; font-weight: 800; }
    .day-badge { display: flex; gap: 3px; font-size: 0.5rem; margin-top: 2px; color: var(--text-soft); font-weight: 700; }
    .cal-day.today .day-badge { color: rgba(255,255,255,0.9); }
    .day-badge span { background: rgba(100,110,130,0.15); padding: 0px 3px; border-radius: var(--radius-xs); }
    .cal-day.today .day-badge span { background: rgba(255,255,255,0.3); }
    .tooltip-simple { position: fixed; background: var(--tooltip-bg); color: var(--tooltip-text); padding: 6px 14px; border-radius: var(--radius-xs); font-size: 0.7rem; pointer-events: none; z-index: 1100; opacity: 0; transition: 0.1s; white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,0.1); font-weight: 600; }
    .tooltip-simple.show { opacity: 1; }
    .modal-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: var(--modal-bg); backdrop-filter: blur(10px); z-index: 2000; display: flex; align-items: center; justify-content: center; visibility: hidden; opacity: 0; transition: 0.2s; }
    .modal-overlay.active { visibility: visible; opacity: 1; }
    .modal-card { background: var(--modal-card); border-radius: var(--radius-ios); width: 1100px; max-width: 98vw; max-height: 90vh; padding: 24px 32px; box-shadow: 0 24px 60px rgba(0,0,0,0.25); border: 1px solid var(--card-border); display: flex; flex-direction: column; gap: 16px; color: var(--text-main); }
    .modal-header { display: flex; justify-content: space-between; align-items: center; font-weight: 700; font-size: 1.1rem; border-bottom: 1px solid var(--border-light); padding-bottom: 10px; }
    .modal-header button { background: none; border: none; font-size: 1.2rem; cursor: pointer; color: var(--text-soft); font-weight: 700; }
    .modal-header-meta { display: flex; align-items: center; gap: 14px; }
    .modal-section-title { font-size: 0.78rem; font-weight: 700; color: var(--text-soft); letter-spacing: 0.5px; text-transform: uppercase; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
    .modal-section-title::after { content: ''; flex: 1; height: 1px; background: var(--border-light); }
    .client-modal-list { overflow-y: auto; display: flex; flex-direction: column; gap: 16px; max-height: 75vh; padding-top: 2px; position: relative; }
    /* ===== 意向客户表格 ===== */
    .intent-table { width: 100%; border-collapse: collapse; font-size: 0.83rem; table-layout: auto; }
    .intent-table thead tr { background: linear-gradient(90deg, rgba(7,193,96,0.08) 0%, rgba(7,193,96,0.03) 100%); border-bottom: 2px solid rgba(7,193,96,0.18); }
    body.dark-mode .intent-table thead tr { background: linear-gradient(90deg, rgba(7,193,96,0.12) 0%, rgba(7,193,96,0.04) 100%); }
    .intent-table th { padding: 9px 14px; font-size: 0.72rem; font-weight: 800; color: var(--accent-intent); letter-spacing: 0.4px; text-align: left; white-space: nowrap; }
    .intent-table td { padding: 11px 14px; border-bottom: 1px solid var(--border-light); vertical-align: top; color: var(--text-main); font-weight: 600; }
    .intent-table tbody tr { transition: background 0.15s; }
    .intent-table tbody tr:hover { background: rgba(7,193,96,0.04); }
    body.dark-mode .intent-table tbody tr:hover { background: rgba(7,193,96,0.06); }
    .intent-table tbody tr:last-child td { border-bottom: none; }
    /* 序号/姓名/电话/公司/时间/编辑 — 按内容撑开，不折行 */
    .tbl-seq { font-size: 0.68rem; font-weight: 800; color: var(--text-light); text-align: center; white-space: nowrap; }
    .tbl-name { font-weight: 800; font-size: 0.88rem; white-space: nowrap; }
    .tbl-phone-wrap { display: inline-flex; align-items: center; gap: 5px; font-family: monospace; font-size: 0.8rem; color: var(--text-soft); white-space: nowrap; }
    .tbl-tag { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 0.68rem; font-weight: 700; white-space: nowrap; }
    .tbl-tag-company { background: rgba(7,193,96,0.08); color: var(--accent-wechat); }
    .tbl-tag-fund { background: rgba(255,154,60,0.15); color: #c97a00; }
    body.dark-mode .tbl-tag-fund { color: #d4933a; }
    /* 沟通记录列 — 最大宽度优先，文字完整换行显示 */
    .tbl-note-cell { min-width: 320px; width: 99%; }
    .tbl-note-text { color: var(--text-main); font-size: 0.86rem; font-weight: 600; line-height: 1.7; word-break: break-word; white-space: pre-wrap; text-align: left; }
    .tbl-note-empty { color: var(--text-light); font-size: 0.75rem; font-style: italic; }
    .tbl-time { font-size: 0.7rem; color: var(--text-light); white-space: nowrap; }
    .tbl-action { text-align: center; white-space: nowrap; }
    .edit-note-btn { font-size: 0.78rem; background: transparent; border: 1px solid var(--accent-wechat); color: var(--accent-wechat); border-radius: 50%; cursor: pointer; width: 26px; height: 26px; padding: 0; display: inline-flex; justify-content: center; align-items: center; font-weight: 700; transition: all 0.2s; }
    .edit-note-btn:hover { background: var(--accent-wechat); color: #fff; transform: scale(1.1); }
    .tbl-note-edit-wrap { display: flex; flex-direction: column; gap: 6px; }
    .tbl-note-edit-wrap textarea { width: 100%; min-height: 90px; background: var(--btn-bg); border: 1.5px solid var(--accent-wechat); border-radius: 6px; padding: 8px 10px; font-size: 0.86rem; color: var(--text-main); outline: none; font-weight: 600; resize: vertical; line-height: 1.7; }
    .tbl-note-edit-wrap textarea:focus { box-shadow: 0 0 0 3px rgba(7,193,96,0.25); }
    .tbl-note-edit-btns { display: flex; gap: 5px; }
    .tbl-save-btn { font-size: 0.65rem; background: var(--accent-wechat); color: #fff; border: none; border-radius: 6px; cursor: pointer; padding: 4px 12px; font-weight: 700; }
    .tbl-cancel-btn { font-size: 0.65rem; background: var(--btn-bg); border: 1px solid var(--card-border); color: var(--text-soft); border-radius: 6px; cursor: pointer; padding: 4px 12px; font-weight: 700; }
    /* ===== 待办卡片（保留原样式） ===== */
    .todo-card-item { display: flex; align-items: flex-start; gap: 10px; padding: 10px 14px; background: var(--btn-bg); border-radius: var(--radius-xs); border: 1px solid var(--card-border); font-size: 0.82rem; font-weight: 600; color: var(--text-main); }
    .todo-card-icon { font-size: 1rem; flex-shrink: 0; margin-top: 1px; }
    .todo-card-text { flex: 1; line-height: 1.5; word-break: break-word; }
    .todo-card-time { font-size: 0.68rem; color: var(--text-light); white-space: nowrap; margin-top: 2px; }
    .phone-toggle { background: none; border: none; font-size: 0.8rem; cursor: pointer; opacity: 0.6; transition: opacity 0.2s; padding: 0; outline: none; }
    .phone-toggle:hover { opacity: 1; }
    .empty-clients { text-align: center; color: var(--text-light); padding: 30px 20px; font-size: 0.85rem; font-weight: 600; }
    .card-title { font-weight: 700; font-size: 0.9rem; margin-bottom: 12px; color: var(--text-main); }
    .register-block { display: flex; flex-direction: column; gap: 8px; }
    .form-line { display: flex; gap: 8px; align-items: center; width: 100%; }
    .input-simple, .todo-input { flex: 1; width: 100%; height: 38px; padding: 0 12px; font-size: 0.85rem; background: var(--btn-bg); border: 0.5px solid var(--card-border); border-radius: var(--radius-xs); color: var(--text-main); outline: none; min-width: 0; font-weight: 600; box-sizing: border-box; transition: all 0.2s; }
    .input-simple:focus, .todo-input:focus { border-color: var(--accent-wechat); box-shadow: 0 0 0 2px rgba(7,193,96,0.25); }
    textarea.input-simple, .note-textarea { height: auto; min-height: 68px; padding: 10px 12px; resize: vertical; line-height: 1.6; }
    .note-textarea { font-family: inherit; }
    .btn-add, .todo-add-btn { height: 38px; padding: 0 18px; font-size: 0.85rem; font-weight: 700; border: none; border-radius: var(--radius-xs); color: white; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; transition: all 0.2s; }
    .btn-add { background: var(--accent-intent); }
    .todo-add-btn { background: var(--accent-wechat); }
    .btn-add:hover, .todo-add-btn:hover { opacity: 0.92; transform: translateY(-1px); }
    .btn-add:active, .todo-add-btn:active { transform: translateY(0); }
    .time-input-compact { flex: 0 0 92px !important; min-width: 92px !important; padding: 0 6px !important; text-align: center; }
    .client-scroll { max-height: 220px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
    .client-row { background: var(--btn-bg); border-radius: var(--radius-sm); padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem; border: 0.5px solid var(--card-border); font-weight: 600; }
    .client-info { flex: 1; display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
    .client-name { font-weight: 700; }
    .client-phone, .modal-client-phone { color: var(--text-soft) !important; font-size: 0.75rem; font-weight: 600; text-decoration: none !important; cursor: pointer; }
    .client-phone:hover, .modal-client-phone:hover { text-decoration: underline !important; }
    .phone-toggle { background: none; border: none; font-size: 0.8rem; cursor: pointer; padding: 0 2px; opacity: 0.5; transition: opacity 0.2s; vertical-align: middle; line-height: 1; }
    .phone-toggle:hover { opacity: 1; }
    .client-note { color: var(--text-light); font-size: 0.75rem; font-weight: 600; }
    .del-icon { background: none; border: none; font-size: 0.9rem; color: #c97a7a; cursor: pointer; width: 28px; height: 28px; border-radius: var(--radius-xs); font-weight: 700; }
    .edit-icon { background: none; border: none; font-size: 0.9rem; color: var(--accent-wechat); cursor: pointer; width: 28px; height: 28px; border-radius: var(--radius-xs); font-weight: 700; margin-right: 4px; }
    .export-single-btn { background: none; border: none; font-size: 0.9rem; color: var(--accent-intent); cursor: pointer; width: 28px; height: 28px; border-radius: var(--radius-xs); font-weight: 700; margin-right: 4px; }
    .export-timeline-single-btn { font-size: 0.78rem; background: transparent; border: 1px solid var(--accent-intent); color: var(--accent-intent); border-radius: 50%; cursor: pointer; width: 26px; height: 26px; padding: 0; display: inline-flex; justify-content: center; align-items: center; font-weight: 700; transition: all 0.2s; margin-right: 4px; }
    .export-timeline-single-btn:hover { background: var(--accent-intent); color: #fff; transform: scale(1.1); }
    .sync-indicator.offline { border-color: rgba(231,76,60,0.6); background: rgba(231,76,60,0.05); }
    body.dark-mode .sync-indicator.offline { border-color: rgba(231,76,60,0.7); background: rgba(231,76,60,0.1); }
    .client-actions { display: flex; align-items: center; gap: 4px; }
    .todo-list { display: flex; flex-direction: column; gap: 8px; max-height: 200px; overflow-y: auto; }
    .todo-item { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--btn-bg); border-radius: var(--radius-xs); border: 0.5px solid var(--card-border); font-size: 0.8rem; font-weight: 600; color: var(--text-main); }
    .todo-number { font-weight: 800; color: var(--accent-wechat); min-width: 20px; font-size: 0.85rem; }
    .todo-text { flex: 1; word-break: break-word; line-height: 1.4; }
    .todo-input-row { display: flex; gap: 8px; align-items: center; width: 100%; }
    .todo-del-btn { background: none; border: none; color: #c97a7a; cursor: pointer; font-size: 0.85rem; padding: 0 4px; }
    .sync-indicator { display: flex; align-items: center; gap: 5px; background: #f5f5f5; border: 1px solid rgba(0,0,0,0.04); height: 38px; border-radius: var(--radius-xs); padding: 0 12px; cursor: pointer; font-size: 0.72rem; color: var(--text-soft); transition: all 0.2s cubic-bezier(0.34,1.56,0.64,1); user-select: none; font-weight: 700; white-space: nowrap; position: relative; }
    .sync-indicator:hover { background: #e8e8e8; transform: translateY(-2px) scale(1.02); box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
    .sync-indicator:active { transform: translateY(0px) scale(0.97); }
    .sync-indicator .sync-icon { font-size: 1rem; display: inline-block; transition: transform 0.3s; }
    .sync-indicator.syncing .sync-icon { animation: sync-spin 1.2s ease-in-out infinite; }
    .sync-indicator.synced { border-color: rgba(7,193,96,0.3); }
    .sync-indicator.pending { border-color: rgba(255,154,60,0.45); }
    .sync-indicator.error { border-color: rgba(201,122,122,0.5); }
    .sync-badge { display: inline-flex; align-items: center; justify-content: center; background: rgba(255,154,60,0.85); color: #fff; border-radius: 50%; min-width: 16px; height: 16px; font-size: 0.55rem; font-weight: 800; }
    .sync-indicator.synced .sync-badge { background: rgba(7,193,96,0.8); }
    .sync-indicator.error .sync-badge { background: rgba(201,122,122,0.85); }
    .sync-tooltip { position: absolute; top: calc(100% + 8px); right: 0; background: var(--tooltip-bg); color: var(--tooltip-text); padding: 6px 12px; border-radius: var(--radius-xs); font-size: 0.62rem; white-space: nowrap; box-shadow: 0 4px 12px rgba(0,0,0,0.15); font-weight: 600; opacity: 0; pointer-events: none; transition: opacity 0.15s; z-index: 200; }
    .sync-indicator:hover .sync-tooltip { opacity: 1; }
    @keyframes sync-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    @media (min-width: 761px) {
      .right-area { order: 2; } .left-area { order: 1; }
      .card { padding: 14px 16px; }
      .counter-card { padding: 16px 14px; }
      .counter-label { font-size: 0.85rem; }
      .counter-value { font-size: 3.2rem; font-weight: 900; }
      .circle-btn { width: 42px; height: 42px; font-size: 1.5rem; }
      .button-group { gap: 12px; margin-top: 14px; }
      .reset-mini { font-size: 0.75rem; }
      .client-scroll { max-height: 200px; }
      .todo-list { max-height: 180px; }
      .card-title { font-size: 0.85rem; margin-bottom: 10px; }
      .input-simple, .todo-input { height: 34px; padding: 0 10px; font-size: 0.8rem; }
      .btn-add, .todo-add-btn { height: 34px; padding: 0 14px; font-size: 0.8rem; }
      .time-input-compact { flex: 0 0 84px !important; min-width: 84px !important; padding: 0 4px !important; }
      .client-row { padding: 8px 12px; font-size: 0.8rem; }
      .todo-item { padding: 6px 10px; font-size: 0.8rem; }
      /* PC/desktop monthly calendar font size increases and bottom alignment */
      .calendar-compact { flex: 1; display: flex; flex-direction: column; }
      .cal-head { font-size: 0.95rem; margin-bottom: 12px; }
      .cal-grid { flex: 1; align-content: space-around; }
      .cal-weekday { font-size: 0.8rem; padding: 6px 0; }
      .cal-day { font-size: 0.82rem; }
      .day-number { font-size: 0.94rem; }
      .day-badge { font-size: 0.65rem; margin-top: 4px; gap: 4px; }
      .day-badge span { padding: 1px 4px; }
    }
    @media (min-width: 1024px) {
      .right-area {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 16px;
      }
    }
    @media (max-width: 760px) {
      .timer-container { display: none !important; }
      .timer-box { padding: 16px 20px; }
      .timer-display { font-size: 2.5rem; }
      .two-columns { flex-direction: column; gap: 20px; flex: none; }
      .left-area, .right-area { flex: none; width: 100%; }
      .right-area { order: 1; } .left-area { order: 2; }
      .container { padding: 10px 12px 10px; }
      .header-bar { margin-bottom: 12px; padding-bottom: 8px; flex-wrap: wrap; gap: 8px; align-items: center; }
      .title-section h3 { font-size: 1.2rem; }
      .modal-card { padding: 16px 14px; gap: 12px; }
      .client-modal-list { overflow-x: auto; -webkit-overflow-scrolling: touch; }
      .pin-box { min-width: 320px; max-width: 92vw; padding: 28px 20px; gap: 14px; top: 35%; transform: translate(-50%, -35%); }
      .pin-stats { gap: 8px; }
      .pin-stat-item { padding: 10px 10px; min-width: 90px; gap: 4px; }
      .pin-stat-label { font-size: 0.75rem; }
      .pin-stat-value { font-size: 1.8rem; }
      .pin-input { width: 182px; padding: 10px 17px; font-size: 1.26rem; }
      .pin-btn { padding: 10px 28px; font-size: 0.98rem; }
      .script-container { display: none !important; }
      .learn-container { right: 8px; top: 60px; max-width: 52vw; max-height: 25vh; overflow-y: auto; }
      .script-module { padding: 8px 12px; font-size: 0.72rem; text-align: left; font-weight: 400; line-height: 1.6; }
      .learn-module { padding: 8px 12px; font-size: 0.7rem; }
      
      /* Mobile optimization additions */
      .card { padding: 12px 14px; border-radius: 10px; }
      .card-title { font-size: 0.82rem; margin-bottom: 8px; }
      .counter-row { gap: 8px; }
      .counter-card { padding: 8px; }
      .counter-value { font-size: 1.6rem; }
      .counter-header .circle-btn { width: 24px; height: 24px; font-size: 0.9rem; border-radius: 3px; }
      .counter-header .button-group { gap: 4px; }
      .counter-stats { font-size: 0.6rem; gap: 8px; }
      .button-group { gap: 6px; margin-top: 6px; justify-content: center; }
      .circle-btn { width: 30px; height: 30px; font-size: 1.1rem; border-radius: 6px; }
      .reset-mini { padding: 2px 4px; font-size: 0.6rem; }
      .stats-row { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
      .stat-block { padding: 6px 2px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; }
      .stat-block .label { font-size: 0.62rem; }
      .stat-block .number { font-size: 1rem; margin-left: 0; }
      .cal-day { aspect-ratio: auto; min-height: 38px; padding: 4px 2px; }
      .todo-input-row { flex-wrap: wrap; gap: 8px; }
      .todo-input { flex: 1 1 100%; }
      .time-input-compact { flex: 1 !important; min-width: 0 !important; }
      .todo-add-btn { flex: 1; }
      .client-actions { flex-shrink: 0; }
      .icon-simple { min-width: 32px; height: 32px; font-size: 0.72rem; padding: 0 4px; }
      .sync-indicator { height: 32px; padding: 0 8px; font-size: 0.68rem; }
      #logBtn { height: 32px !important; padding: 0 8px !important; font-size: 0.72rem !important; }
      .intent-table { font-size: 0.75rem; }
      .intent-table th, .intent-table td { padding: 8px 6px; }
      .tbl-note-cell { min-width: 200px; }

      /* Mobile: 全量客户弹窗留出空白可点区域 */
      #allClientsModal .modal-card { max-height: 93vh !important; max-width: 100vw !important; margin-top: 7vh !important; border-radius: 16px 16px 0 0 !important; }
      /* Mobile: 隐藏操作列标签，保留编辑按钮 */
      #allClientsModal td[data-label="操作"]::before { content: none !important; }
      /* Mobile clients table card layout */
      .clients-table, .clients-table thead, .clients-table tbody, .clients-table th, .clients-table td, .clients-table tr {
        display: block;
        width: 100% !important;
        box-sizing: border-box;
      }
      .clients-table thead {
        display: none !important;
      }
      .clients-table tbody tr {
        background: var(--btn-bg);
        border: 1px solid var(--card-border);
        border-radius: var(--radius-sm);
        padding: 12px 14px;
        margin-bottom: 12px;
        box-shadow: 0 4px 10px rgba(0,0,0,0.1);
      }
      .clients-table td {
        padding: 6px 0 !important;
        border-bottom: 0.5px dashed var(--border-light) !important;
        text-align: left !important;
        font-size: 0.85rem !important;
        display: flex;
        align-items: flex-start;
        justify-content: flex-start;
        min-height: 28px;
      }
      .clients-table td:last-child {
        border-bottom: none !important;
        justify-content: center;
      }
      .clients-table td::before {
        content: attr(data-label) ": ";
        font-weight: 800;
        color: var(--text-soft);
        width: 80px;
        flex-shrink: 0;
        margin-top: 1px;
      }
      .clients-table td[data-label="沟通情况"],
      .clients-table td[data-label="跟进情况"] {
        flex-direction: column;
        align-items: stretch;
        padding: 8px 0 !important;
      }
      .clients-table td[data-label="沟通情况"]::before,
      .clients-table td[data-label="跟进情况"]::before {
        width: 100%;
        margin-bottom: 6px;
      }
      .clients-table td[data-label="沟通情况"] span,
      .clients-table td[data-label="跟进情况"] span {
        padding-left: 4px;
        line-height: 1.4;
      }
      .clients-table td input,
      .clients-table td textarea {
        flex: 1;
        width: 100% !important;
        box-sizing: border-box !important;
      }
    }
    /* ===== 紧凑表格与待办行样式 ===== */
    .table-compact { width: 100%; border-collapse: collapse; font-size: 0.78rem; color: var(--text-main); text-align: left; }
    .table-compact th { padding: 4px 6px; font-weight: 700; color: var(--text-soft); border-bottom: 0.5px solid var(--card-border); font-size: 0.72rem; }
    .table-compact td { padding: 6px 6px; border-bottom: 0.5px solid var(--card-border); vertical-align: middle; font-weight: 600; }
    .table-compact tr:last-child td { border-bottom: none; }
    .table-compact tr:hover { background: var(--btn-hover); }
    .client-detail { color: var(--text-light); font-size: 0.72rem; }
    .client-note-text { color: var(--text-soft); font-size: 0.75rem; word-break: break-word; }
    .client-time-text { color: var(--text-light); font-size: 0.7rem; }
    
    .todo-item-clean { display: flex; align-items: center; gap: 8px; padding: 6px 4px; border-bottom: 0.5px solid var(--card-border); font-size: 0.78rem; font-weight: 600; color: var(--text-main); transition: background 0.15s; }
    .todo-item-clean:hover { background: var(--btn-hover); }
    .todo-item-clean:last-child { border-bottom: none; }
    .todo-number-clean { font-weight: 800; color: var(--accent-wechat); font-size: 0.78rem; min-width: 16px; }
    .todo-text-clean { flex: 1; word-break: break-word; line-height: 1.4; }
    .todo-del-btn-clean { background: none; border: none; color: #c97a7a; cursor: pointer; font-size: 0.8rem; padding: 0 4px; opacity: 0.5; transition: opacity 0.2s; }
    .todo-del-btn-clean:hover { opacity: 1; }
    .todo-time-tag { background: var(--card-border); color: var(--text-soft); padding: 1px 4px; border-radius: 4px; font-size: 0.65rem; margin-left: 6px; font-weight: 700; }

    /* ===== 客户端卡片排版样式 ===== */
    .client-card-item {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: var(--radius-sm);
      padding: 12px 14px;
      margin-bottom: 12px;
      box-shadow: var(--shadow-card);
      transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      display: flex;
      flex-direction: column;
      gap: 10px;
      position: relative;
    }
    .client-card-item:hover {
      border-color: rgba(7, 193, 96, 0.4);
      box-shadow: 0 6px 16px rgba(0,0,0,0.06);
      transform: translateY(-1px);
    }
    body.dark-mode .client-card-item:hover {
      border-color: rgba(7, 193, 96, 0.5);
      box-shadow: 0 6px 16px rgba(0,0,0,0.25);
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
      flex-wrap: wrap;
    }
    .client-card-name {
      font-size: 0.88rem;
      font-weight: 800;
      color: var(--text-main);
    }
    .client-card-phone-wrap {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--btn-bg);
      padding: 2px 8px;
      border-radius: 12px;
    }
    .client-card-phone {
      font-size: 0.78rem;
      font-weight: 700;
      color: var(--accent-intent);
      text-decoration: none;
    }
    .client-card-time {
      font-size: 0.72rem;
      color: var(--text-light);
      font-weight: 600;
    }
    .client-card-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .client-card-tag {
      font-size: 0.72rem;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: var(--radius-xs);
    }
    .client-card-tag-company {
      background: var(--accent-intent-bg);
      color: var(--accent-intent);
      border: 0.5px solid rgba(7, 193, 96, 0.2);
    }
    .client-card-tag-fund {
      background: rgba(255, 183, 77, 0.1);
      color: #e67e22;
      border: 0.5px solid rgba(255, 183, 77, 0.2);
    }
    body.dark-mode .client-card-tag-fund {
      background: rgba(230, 126, 34, 0.15);
      color: #f39c12;
    }
    .client-card-body {
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: rgba(0,0,0,0.015);
      padding: 8px;
      border-radius: 6px;
      border: 0.5px solid var(--border-light);
    }
    body.dark-mode .client-card-body {
      background: rgba(255,255,255,0.01);
    }
    .client-card-content-block {
      display: flex;
      flex-direction: column;
      gap: 3px;
      font-size: 0.78rem;
      border-left: 2px solid var(--border-light);
      padding-left: 8px;
    }
    .client-card-content-block.follow-up {
      border-left-color: var(--accent-wechat);
    }
    .client-card-label {
      font-size: 0.65rem;
      font-weight: 800;
      color: var(--text-light);
      letter-spacing: 0.5px;
    }
    .client-card-text {
      color: var(--text-soft);
      font-weight: 600;
      line-height: 1.45;
      word-break: break-all;
    }
    .client-card-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 4px;
      border-top: 1px dashed var(--border-light);
      padding-top: 8px;
    }



    /* ==================== Android 专属适配 ==================== */
    body.android { font-family: Roboto, "Noto Sans SC", "Noto Sans", "Droid Sans Fallback", sans-serif; }
    /* Android 使用 static vh 避免 toolbar 收展导致 dvh 布局抖动 */
    body.android .app-shell { height: 100vh; height: -webkit-fill-available; padding-top: 39px; }
    /* Android backdrop-filter 性能差，降低或关闭 */
    body.android .card { backdrop-filter: none; -webkit-backdrop-filter: none; }
    body.android .menu-dropdown { backdrop-filter: none; -webkit-backdrop-filter: none; }
    body.android .pin-box { backdrop-filter: none; -webkit-backdrop-filter: none; }
    body.android .privacy-mask { backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); }
    body.android .modal-overlay { backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); }
    body.android .circle-btn { backdrop-filter: none; }
    body.android .reset-mini { backdrop-filter: none; }
    /* Android 调整锁屏 PIN 框位置 */
    body.android .pin-box { top: 45%; }
    /* ===== 白名单搜索 ===== */
    .whitelist-search-card { padding: 12px 16px; }
    .whitelist-search-row { display: flex; gap: 8px; align-items: center; }
    .whitelist-search-input { flex: 1; height: 34px; padding: 0 12px; font-size: 0.82rem; background: var(--btn-bg); border: 1.5px solid var(--card-border); border-radius: var(--radius-xs); color: var(--text-main); outline: none; font-weight: 600; transition: all 0.2s; }
    .whitelist-search-input:focus { border-color: var(--accent-wechat); box-shadow: 0 0 0 3px rgba(7,193,96,0.2); }
    .whitelist-search-input::placeholder { color: var(--text-light); font-weight: 500; }
    .whitelist-result { font-size: 0.78rem; font-weight: 700; padding: 6px 12px; border-radius: var(--radius-xs); white-space: nowrap; transition: all 0.2s; }
    .whitelist-result.match { background: rgba(7,193,96,0.1); color: #07c160; border: 1px solid rgba(7,193,96,0.2); }
    .whitelist-result.no-match { background: rgba(231,76,60,0.06); color: #c97a7a; border: 1px solid rgba(231,76,60,0.15); }
    .whitelist-result.loading { background: rgba(74,108,247,0.06); color: #4a6cf7; border: 1px solid rgba(74,108,247,0.15); }
    .whitelist-result.error { background: rgba(231,76,60,0.08); color: #e74c3c; border: 1px solid rgba(231,76,60,0.2); }
    body.dark-mode .whitelist-result.match { background: rgba(7,193,96,0.12); color: #2ecc71; }
    body.dark-mode .whitelist-result.no-match { background: rgba(231,76,60,0.08); color: #e07070; }
    body.dark-mode .whitelist-result.loading { background: rgba(74,108,247,0.1); color: #7b9ff5; }
    @media (max-width: 760px) {
      .whitelist-search-row { flex-direction: column; }
      .whitelist-result { white-space: normal; text-align: center; width: 100%; }
    }
    .whitelist-textarea { width: 100%; height: 180px; background: var(--btn-bg); border: 1px solid var(--card-border); border-radius: var(--radius-xs); padding: 10px 12px; font-size: 0.78rem; color: var(--text-main); outline: none; font-weight: 600; resize: vertical; line-height: 1.6; }
    .whitelist-textarea:focus { border-color: var(--accent-wechat); box-shadow: 0 0 0 2px rgba(7,193,96,0.2); }
    .whitelist-company-row { display: flex; justify-content: space-between; align-items: center; padding: 5px 8px; border-bottom: 0.5px solid var(--border-light); font-size: 0.72rem; font-weight: 600; color: var(--text-main); }
    .whitelist-company-row:last-child { border-bottom: none; }
    .whitelist-del-btn { background: none; border: none; color: #c97a7a; cursor: pointer; font-size: 0.75rem; padding: 2px 6px; }
  </style>
</head>
<body>
<div class="notify-bar" id="notifyBar" onclick="this.classList.remove('show')"><span id="notifyText"></span><span class="notify-close">✕</span></div>
<div class="wallpaper-fallback"></div>
<div class="wallpaper-background" id="wallpaperBackground"></div>
<div class="privacy-wallpaper" id="privacyWallpaper"></div>
<div class="timer-container" id="timerContainer">
  <div class="timer-box" id="timerBox">
    <div class="timer-display" id="timerDisplay">00:00:00</div>
    <div class="timer-inputs">
      <div class="timer-input-group">
        <input type="number" class="timer-input" id="timerHours" min="0" max="23" value="0" placeholder="0">
        <span class="timer-label">时</span>
      </div>
      <span class="timer-separator">:</span>
      <div class="timer-input-group">
        <input type="number" class="timer-input" id="timerMinutes" min="0" max="59" value="1" placeholder="0">
        <span class="timer-label">分</span>
      </div>
      <span class="timer-separator">:</span>
      <div class="timer-input-group">
        <input type="number" class="timer-input" id="timerSeconds" min="0" max="59" value="0" placeholder="0">
        <span class="timer-label">秒</span>
      </div>
    </div>
    <div class="timer-buttons">
      <button class="timer-btn timer-btn-start" id="timerStartBtn">启动</button>
      <button class="timer-btn timer-btn-reset" id="timerResetBtn">重置</button>
    </div>
  </div>
</div>
<div class="privacy-mask" id="privacyMask">
  <div class="script-container" id="scriptContainer"></div>
  <div class="learn-container" id="learnContainer"></div>
  <div class="pin-box">
    <div class="pin-stats" id="pinStatsContainer">
      <div class="pin-stat-item"><span class="pin-stat-label">今日微信</span><span class="pin-stat-value pin-wechat-value" id="pinWechatNum">0</span></div>
      <div class="pin-stat-item"><span class="pin-stat-label">今日意向</span><span class="pin-stat-value pin-intent-value" id="pinIntentNum">0</span></div>
      <div class="pin-stat-item"><span class="pin-stat-label">今日回访</span><span class="pin-stat-value pin-revisit-value" id="pinRevisitNum">0</span></div>
    </div>
    <input type="password" class="pin-input" id="pinInput" placeholder="" maxlength="6" inputmode="numeric" autofocus>
    <button class="pin-btn" id="pinUnlockBtn">解锁进入</button>
    <div class="pin-error" id="pinError"></div>
  </div>
</div>
<div class="app-shell">
  <div class="container">
    <div class="header-bar">
      <div class="title-section"><div class="app-logo"><div class="app-icon"><svg viewBox="0 0 48 48" fill="none"><rect x="6" y="8" width="36" height="34" rx="5" fill="none" stroke="white" stroke-width="2.5"/><line x1="6" y1="18" x2="42" y2="18" stroke="white" stroke-width="2.5"/><rect x="12" y="4" width="4" height="8" rx="2" fill="white"/><rect x="32" y="4" width="4" height="8" rx="2" fill="white"/><circle cx="16" cy="27" r="2.5" fill="white"/><circle cx="24" cy="27" r="2.5" fill="white"/><circle cx="32" cy="27" r="2.5" fill="white"/><circle cx="16" cy="35" r="2.5" fill="white"/><circle cx="24" cy="35" r="2.5" fill="white"/></svg></div><h3>每日工作</h3></div><div class="date-chip" id="liveDate"></div><button class="goal-eye eye-off" id="goalEyeBtn" title="显示目标数字">👁</button><div class="goal-chips" id="goalChips"></div></div>
      <div class="action-group">
        <button class="sync-indicator" id="syncBtn" title="点击手动同步"><span class="sync-icon" id="syncIcon">⇅</span><span id="syncLabel">同步中</span><div class="sync-tooltip" id="syncTooltip">正在连接...</div></button>
        <button class="icon-simple" id="allClientsBtn" title="意向客户全量表">全量</button>
        <button class="icon-simple" id="dialerBtn" title="快捷拨号助手" onclick="window.open('/dialer', '_blank')">拨号</button>
        <button class="icon-simple" id="hideBtn" title="一键隐藏 (Ctrl+Z)">锁屏</button>
        <button class="icon-simple" id="menuToggleBtn" title="菜单">≡</button>
        <div class="menu-dropdown" id="menuDropdown">
          <button class="menu-item" id="logBtn">同步日志</button>
          <button class="menu-item" id="scriptBtn">话术管理</button>
          <button class="menu-item" id="learnBtn">学习管理</button>
          <button class="menu-item" id="exportBtn">导出数据</button>
          <button class="menu-item" id="goalBtn">目标设定</button>
          <button class="menu-item" id="darkToggleBtn">深色模式</button>
        </div>
      </div>
    </div>
    <div class="two-columns">
      <div class="left-area">
        <div class="counter-row">
          <div class="counter-card wechat-fill">
            <div class="counter-header"><span class="counter-label">微信</span><div class="button-group"><button class="circle-btn" id="wechatMinus">−</button><button class="circle-btn btn-special" id="wechatPlus">+</button></div></div>
            <div class="counter-value" id="wechatNum">0</div>
            <div class="counter-stats"><span>本周 <b id="weekWechat">0</b></span><span>本月 <b id="monthWechat">0</b></span></div>
          </div>
          <div class="counter-card intent-fill">
            <div class="counter-header"><span class="counter-label">意向</span></div>
            <div class="counter-value" id="intentNum">0</div>
            <div class="counter-stats"><span>本周 <b id="weekIntent">0</b></span><span>本月 <b id="monthIntent">0</b></span></div>
          </div>
          <div class="counter-card revisit-fill">
            <div class="counter-header"><span class="counter-label">回访</span><div class="button-group"><button class="circle-btn" id="revisitMinus">−</button><button class="circle-btn btn-special" id="revisitPlus">+</button></div></div>
            <div class="counter-value" id="revisitNum">0</div>
            <div class="counter-stats"><span>本周 <b id="weekRevisit">0</b></span><span>本月 <b id="monthRevisit">0</b></span></div>
          </div>
        </div>
        <div class="card calendar-compact">
          <div class="cal-head"><button class="cal-nav-btn" id="calPrevBtn" title="上个月">◀</button><span id="calMonthTitle"></span><button class="cal-nav-btn" id="calNextBtn" title="下个月">▶</button></div>
          <div class="cal-grid" id="calGrid"></div>
          <div style="font-size:0.55rem;text-align:center;margin-top:6px;color:var(--text-light);font-weight:600;">点击日期查看意向客户</div>
        </div>
      </div>
      <div class="right-area">
        <div class="card whitelist-search-card">
          <div class="card-title" style="display:flex;align-items:center;gap:6px;">🔍 白名单查询<button class="icon-simple" id="whitelistManageBtn" style="font-size:0.65rem;height:24px;min-width:auto;padding:0 8px;margin-left:auto;">管理</button></div>
          <div class="whitelist-search-row">
            <input type="text" class="whitelist-search-input" id="whitelistSearchInput" placeholder="输入单位名称，查是否在白名单..." autocomplete="off">
            <span class="whitelist-result" id="whitelistResult"></span>
          </div>
        </div>
        <div class="card">
          <div class="card-title">意向登记</div>
          <div class="register-block">
            <div class="form-line"><input type="text" class="input-simple" id="custName" placeholder="姓名" autocomplete="off"><input type="text" class="input-simple" id="custPhone" placeholder="电话" autocomplete="off"></div>
            <div class="form-line"><input type="text" class="input-simple" id="custCompany" placeholder="单位" autocomplete="off"><input type="text" class="input-simple" id="custFund" placeholder="公积金" autocomplete="off"></div>
            <textarea class="input-simple note-textarea" id="custNote" placeholder="沟通记录 (必填)" rows="3"></textarea>
            <textarea class="input-simple note-textarea" id="custFollowUp" placeholder="跟进情况" rows="2"></textarea>
            <button class="btn-add" id="addClientBtn">+ 添加</button>
            <div class="client-scroll" id="clientList"></div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">临时登记 (待晚回访)</div>
          <div class="register-block">
            <div class="form-line"><input type="text" class="input-simple" id="tempCustName" placeholder="姓名" autocomplete="off"><input type="text" class="input-simple" id="tempCustPhone" placeholder="电话/联系方式" autocomplete="off"></div>
            <textarea class="input-simple note-textarea" id="tempCustNote" placeholder="回访备注/待聊内容" rows="2"></textarea>
            <button class="btn-add" id="addTempCustBtn" style="background:var(--accent-wechat);">+ 登记</button>
            <div class="client-scroll" id="tempClientList"></div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">今日待办</div>
          <div class="register-block">
            <div class="todo-input-row"><input type="text" class="todo-input" id="todayTodoInput" placeholder="添加今日待办..." autocomplete="off"><input type="time" class="todo-input time-input-compact" id="todayRemindTime"><button class="todo-add-btn" id="addTodayTodoBtn">+ 添加</button></div>
            <div class="todo-list" id="todayTodoList"></div>
          </div>
        </div>
        <div class="card">
          <div class="card-title">明日待办</div>
          <div class="register-block">
            <div class="todo-input-row"><input type="text" class="todo-input" id="todoInput" placeholder="添加明日待办..." autocomplete="off"><input type="time" class="todo-input time-input-compact" id="tomorrowRemindTime"><button class="todo-add-btn" id="addTodoBtn">+ 添加</button></div>
            <div class="todo-list" id="tomorrowTodoList"></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
<div id="globalTooltip" class="tooltip-simple"></div>
<div id="scriptModal" class="modal-overlay">
  <div class="modal-card script-input-modal">
    <div class="modal-header"><span>话术管理</span><button id="closeScriptModalBtn">×</button></div>
    <textarea id="newScriptInput" placeholder="输入话术内容..."></textarea>
    <button class="btn-add" id="addScriptBtn" style="width:100%;">+ 添加话术</button>
    <div class="script-list" id="scriptList"></div>
  </div>
</div>
<div id="learnModal" class="modal-overlay">
  <div class="modal-card script-input-modal">
    <div class="modal-header"><span>学习管理</span><button id="closeLearnModalBtn">×</button></div>
    <textarea id="newLearnInput" placeholder="输入学习内容..."></textarea>
    <div class="learn-check-row"><input type="checkbox" id="learnShowCheck" checked><label for="learnShowCheck">锁屏显示</label></div>
    <button class="btn-add" id="addLearnBtn" style="width:100%;">保存</button>
    <div class="script-list" id="learnList"></div>
  </div>
</div>
<div id="exportModal" class="modal-overlay">
  <div class="modal-card" style="max-width:400px;">
    <div class="modal-header"><span>导出数据</span><button id="closeExportModalBtn">×</button></div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;gap:8px;"><button class="btn-add" id="exportWeekBtn" style="flex:1;">导出本周</button><button class="btn-add" id="exportMonthBtn" style="flex:1;">导出本月</button><button class="btn-add" id="exportAllClientsBtn" style="flex:1;background:var(--intent-gradient);">导出全量</button></div>
      <div style="display:flex;gap:8px;"><button class="btn-add" id="exportSoloBtn" style="flex:1;background:var(--revisit-gradient);">逐条导出全量</button></div>
      <input type="text" class="input-simple" id="webhookUrlInput" placeholder="企业微信 Webhook URL">
      <div style="font-size:0.65rem;color:var(--text-light);">粘贴企业微信群机器人的 Webhook 地址</div>
      <div id="exportStatus" style="font-size:0.75rem;text-align:center;min-height:20px;"></div>
    </div>
  </div>
</div>
<div id="logModal" class="modal-overlay">
  <div class="modal-card" style="max-width:420px;">
    <div class="modal-header"><span>同步日志</span><button id="closeLogModalBtn">×</button></div>
    <div class="log-list" id="syncLogList"></div>
  </div>
</div>
<div id="allClientsModal" class="modal-overlay">
  <div class="modal-card" style="width:100vw;height:100vh;max-width:100vw;max-height:100vh;margin:0;border-radius:0;border:none;box-sizing:border-box;">
    <div class="modal-header"><div style="display:flex;align-items:center;gap:12px;"><span>意向客户全量登记表</span><button id="allClientsAddBtn" class="btn-add" style="font-size:0.75rem;padding:4px 12px;height:28px;">+ 新增意向</button><button id="allClientsExportBtn" class="btn-add" style="font-size:0.75rem;padding:4px 12px;height:28px;background:var(--intent-gradient);">导出</button></div><button id="closeAllClientsModalBtn">✕</button></div>
    <div style="overflow-x:auto;flex:1;min-height:0;margin-top:10px;">
      <table class="clients-table" style="width:100%;border-collapse:collapse;text-align:left;font-size:0.8rem;font-weight:500;">
        <thead>
          <tr style="border-bottom:2px solid var(--border-light);color:var(--text-soft);font-weight:700;">
            <th style="padding:10px 8px;">日期</th>
            <th style="padding:10px 8px;">姓名</th>
            <th style="padding:10px 8px;">电话</th>
            <th style="padding:10px 8px;">单位</th>
            <th style="padding:10px 8px;">公积金</th>
            <th style="padding:10px 8px;">沟通情况</th>
            <th style="padding:10px 8px;">跟进情况</th>
            <th style="padding:10px 8px;text-align:center;">操作</th>
          </tr>
        </thead>
        <tbody id="allClientsTableBody">
          <!-- JS 动态渲染 -->
        </tbody>
      </table>
    </div>
  </div>
</div>
<div id="dateModal" class="modal-overlay">
  <div class="modal-card">
    <div class="modal-header"><span id="modalDateTitle">时间线</span><button id="closeModalBtn">×</button></div>
    <div id="modalClientList" class="client-modal-list"></div>
  </div>
</div>
<div id="goalModal" class="modal-overlay">
  <div class="modal-card" style="max-width:420px;">
    <div class="modal-header"><span>目标设定</span><button id="closeGoalModalBtn">×</button></div>
    <div style="display:flex;flex-direction:column;gap:12px;">
      <div style="font-size:0.75rem;font-weight:800;color:var(--text-soft);border-bottom:1px solid var(--border-light);padding-bottom:4px;">每周目标</div>
      <div style="display:flex;gap:8px;align-items:center;"><label style="font-size:0.8rem;font-weight:600;min-width:60px;">上门</label><input type="number" class="input-simple" id="goalWeeklyVisit" min="0" placeholder="0" style="flex:1;"></div>
      <div style="display:flex;gap:8px;align-items:center;"><label style="font-size:0.8rem;font-weight:600;min-width:60px;">微信</label><input type="number" class="input-simple" id="goalWeeklyWechat" min="0" placeholder="0" style="flex:1;"></div>
      <div style="font-size:0.75rem;font-weight:800;color:var(--text-soft);border-bottom:1px solid var(--border-light);padding-bottom:4px;margin-top:4px;">每月目标</div>
      <div style="display:flex;gap:8px;align-items:center;"><label style="font-size:0.8rem;font-weight:600;min-width:60px;">微信</label><input type="number" class="input-simple" id="goalMonthlyWechat" min="0" placeholder="0" style="flex:1;"></div>
      <div style="display:flex;gap:8px;align-items:center;"><label style="font-size:0.8rem;font-weight:600;min-width:60px;">上门</label><input type="number" class="input-simple" id="goalMonthlyVisit" min="0" placeholder="0" style="flex:1;"></div>
      <div style="display:flex;gap:8px;align-items:center;"><label style="font-size:0.8rem;font-weight:600;min-width:60px;">回款</label><input type="number" class="input-simple" id="goalMonthlyPayment" min="0" placeholder="0" style="flex:1;"></div>
      <button class="btn-add" id="saveGoalBtn" style="width:100%;margin-top:4px;">保存目标</button>
      <div id="goalStatus" style="font-size:0.75rem;text-align:center;min-height:20px;color:var(--text-soft);"></div>
    </div>
  </div>
</div>
<div id="whitelistManageModal" class="modal-overlay">
  <div class="modal-card" style="max-width:500px;">
    <div class="modal-header"><span>白名单管理</span><button id="closeWhitelistManageModalBtn">×</button></div>
    <div style="font-size:0.72rem;font-weight:700;color:var(--text-soft);">粘贴企业名称（每行一个），去重上传到白名单：</div>
    <textarea id="whitelistManageTextarea" class="whitelist-textarea" placeholder="例：&#10;中国石油化工集团公司&#10;国家电网有限公司&#10;中国工商银行股份有限公司"></textarea>
    <div style="display:flex;gap:8px;">
      <button class="btn-add" id="whitelistUploadManageBtn" style="flex:1;">上传白名单</button>
      <button class="btn-add" id="whitelistRefreshManageBtn" style="flex:1;background:var(--revisit-gradient);">刷新列表</button>
    </div>
    <div id="whitelistManageStatus" style="font-size:0.72rem;text-align:center;min-height:20px;color:var(--text-soft);"></div>
    <div style="max-height:250px;overflow-y:auto;border:1px solid var(--card-border);border-radius:var(--radius-xs);padding:8px;">
      <div id="whitelistManageList" style="font-size:0.7rem;color:var(--text-light);text-align:center;">点击"刷新列表"查看白名单企业</div>
    </div>
  </div>
</div>

<script>
(function(){
  const WECHAT_K='wechat_v3', INTENT_K='intent_v3', CLIENTS_K='clients_v3', REVISIT_K='revisit_v1';
  const VISIT_K='visit_v1', PAYMENT_K='payment_v1', GOALS_K='goals_v1';
  const DARK_K='dark_mode', LOCK_K='locked', TODAY_TODO_K='today_todo_v2', TOMORROW_TODO_K='tomorrow_todo_v2';
  const LAST_LOAD_DATE_K='last_load_date_v1', WALLPAPER_K='wp_cache', SCRIPTS_K='scripts_v1', LEARN_K='learn_v1', LOCAL_TS_K='local_ts_v1';
  const TEMP_CLIENTS_K='temp_clients_v1';
  const OP_QUEUE_K='op_queue_v1'; // 操作队列：持久化到 localStorage，页面关闭后下次打开继续补发
  const DEFAULT_PIN='8520';
  const PULL_INTERVAL=15000; // 15秒拉一次，加快跨设备更新
  let syncTimer=null;

  const getTodayStr=()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');};
  const getCurrentMonth=()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');};
  const getCurrentTime=()=>{const n=new Date();return String(n.getHours()).padStart(2,'0')+':'+String(n.getMinutes()).padStart(2,'0')+':'+String(n.getSeconds()).padStart(2,'0');};
  const loadMap=k=>{try{return JSON.parse(localStorage.getItem(k))||{};}catch(e){return{};}};
  const saveMap=(k,o)=>localStorage.setItem(k,JSON.stringify(o));
  const loadTodos=k=>{try{const d=JSON.parse(localStorage.getItem(k))||[];return d.map(t=>typeof t==='string'?{text:t,time:'',date:getTodayStr()}:t);}catch(e){return[];}};
  const saveTodos=(k,a)=>localStorage.setItem(k,JSON.stringify(a));
  const loadGoals=()=>{try{return JSON.parse(localStorage.getItem(GOALS_K))||{};}catch(e){return{};}};
  const saveGoals=(g)=>localStorage.setItem(GOALS_K,JSON.stringify(g));
  const pushTodoLog=async (todo,ds)=>{syncOp('pushTodoLog',{todo});};
  const esc=s=>String(s).replace(/[&<>]/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;' })[m]||m);
  const maskPhone=p=>{if(!p||p.length<7)return '****';return '****'.repeat(Math.ceil(p.length/4));};

  function getWeekTotal(map,month){const ref=month?new Date(month+'-01'):new Date();const dow=ref.getDay();const diff=dow===0?6:dow-1;const mon=new Date(ref);mon.setDate(ref.getDate()-diff);const ms=mon.getFullYear()+'-'+String(mon.getMonth()+1).padStart(2,'0')+'-'+String(mon.getDate()).padStart(2,'0');const end=month?new Date(ref.getFullYear(),ref.getMonth()+1,0):new Date();const es=end.getFullYear()+'-'+String(end.getMonth()+1).padStart(2,'0')+'-'+String(end.getDate()).padStart(2,'0');const tsNow=getTodayStr();const ts=month&&month!==getCurrentMonth()?es:tsNow;let s=0;for(let[d,v]of Object.entries(map))if(d>=ms&&d<=ts)s+=v;return s;}
  function getMonthTotal(map,month){const p=month||getTodayStr().slice(0,7);let s=0;for(let[d,v]of Object.entries(map))if(d.startsWith(p))s+=v;return s;}
  let calendarMonth=getCurrentMonth();

  // ==================== 云端 API ====================
  async function cloudGet(date){try{const r=await fetch('/api/data?date='+date);if(r.ok)return await r.json();}catch(e){}return null;}
  async function cloudSave(data){try{await fetch('/api/data',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});}catch(e){}}

  // ==================== Outbox 队列（Office式同步）====================
  // 每次操作先写入队列（localStorage），再发网。关页也不丢，下次打开继续补发。
  const loadOpQueue=()=>{try{return JSON.parse(localStorage.getItem(OP_QUEUE_K))||[];}catch(e){return[];}};
  const saveOpQueue=q=>localStorage.setItem(OP_QUEUE_K,JSON.stringify(q));
  let _draining=false;
  async function drainQueue(){
    if(_draining)return;
    _draining=true;
    _syncStatus='syncing';updateSyncIndicator();
    try{
      let anyOk=false;
      while(true){
        const q=loadOpQueue();
        if(q.length===0)break;
        const item=q[0];
        const {_qid,...body}=item;
        let ok=false;
        let status=0;
        let errMsg='';
        if(!item._retry)item._retry=0;
        try{
          const r=await fetch('/api/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
          status=r.status;
          if(r.ok){const d=await r.json();if(d._ts)localStorage.setItem(LOCAL_TS_K,d._ts);ok=true;anyOk=true;}
          else{errMsg='HTTP '+r.status;}
        }catch(e){errMsg=e.message||'网络连接错误';}
        if(ok){
          saveOpQueue(loadOpQueue().filter(function(i){return i._qid!==_qid;}));
          updateSyncIndicator();
        }else{
          if(status>=400&&status<500){
            addSyncLog('⚠️ 放弃无效操作 ['+item.op+']: '+errMsg);
            saveOpQueue(loadOpQueue().filter(function(i){return i._qid!==_qid;}));
            updateSyncIndicator();
            continue;
          }
          item._retry++;
          if(item._retry>=5){
            addSyncLog('❌ 操作 ['+item.op+'] 重试 5 次失败已丢弃: '+errMsg);
            saveOpQueue(loadOpQueue().filter(function(i){return i._qid!==_qid;}));
            updateSyncIndicator();
            continue;
          }
          const currentQueue=loadOpQueue();
          const currentItemIdx=currentQueue.findIndex(function(i){return i._qid===_qid;});
          if(currentItemIdx>=0){
            currentQueue[currentItemIdx]._retry=item._retry;
            saveOpQueue(currentQueue);
          }
          _syncStatus='pending';updateSyncIndicator();
          break;
        }
      }
      if(loadOpQueue().length===0){_syncStatus='synced';if(anyOk){_lastSyncTime=new Date();addSyncLog('✅ 增量队列推送云端成功');}}
    }finally{_draining=false;updateSyncIndicator();}
  }
  // 每次操作：先写队列（持久化），再尝试发送
  async function syncOp(op,payload,customDate){
    const targetDate=customDate||getTodayStr();
    const item={_qid:Date.now()+'_'+Math.random().toString(36).slice(2),date:targetDate,op,...payload};
    const q=loadOpQueue();q.push(item);saveOpQueue(q);
    await drainQueue();
  }
  async function cloudCalendar(month){try{const r=await fetch('/api/calendar?month='+month);if(r.ok)return await r.json();}catch(e){}return null;}
  async function cloudStats(month){try{const r=await fetch('/api/stats?month='+month);if(r.ok)return await r.json();}catch(e){}return null;}

  // ==================== 同步状态指示器 ====================
  let _lastSyncTime=null;
  let _syncStatus='syncing';
  function updateSyncIndicator(){
    var btn=document.getElementById('syncBtn');
    var icon=document.getElementById('syncIcon');
    var label=document.getElementById('syncLabel');
    var tip=document.getElementById('syncTooltip');
    if(!btn)return;
    var q=loadOpQueue();
    var qLen=q.length;
    var st=_syncStatus;
    if(!navigator.onLine)st='offline';
    if(st!=='syncing'&&st!=='error'&&st!=='offline'){st=qLen>0?'pending':'synced';}
    btn.className='sync-indicator '+st;
    if(st==='syncing'){
      icon.textContent='⇅';label.textContent='同步中...';
    }else if(st==='offline'){
      icon.textContent='🔌';label.textContent='离线模式';
    }else if(st==='pending'){
      icon.textContent='⇅';label.innerHTML='<span class="sync-badge">'+qLen+'</span> 待同步';
    }else if(st==='error'){
      icon.textContent='⇅';label.textContent='同步失败';
    }else{
      icon.textContent='⇅';label.textContent='已同步';
    }
    var timeStr='--:--';
    if(_lastSyncTime){
      var hh=String(_lastSyncTime.getHours()).padStart(2,'0');
      var mm=String(_lastSyncTime.getMinutes()).padStart(2,'0');
      var ss=String(_lastSyncTime.getSeconds()).padStart(2,'0');
      timeStr=hh+':'+mm+':'+ss;
    }
    tip.textContent='\u{1F552} '+timeStr+(qLen>0?' | 队列: '+qLen+'\u6761':'');
  }

  // 保存当前完整状态到 KV
  async function saveFullState(full){
    const today=getTodayStr();
    const wm=loadMap(WECHAT_K);
    const rm=loadMap(REVISIT_K);
    const vm=loadMap(VISIT_K);
    const pm=loadMap(PAYMENT_K);
    const allClients=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
    const webhookUrl=localStorage.getItem('webhook_url')||'';

    if(full){
      const scripts=loadScripts();
      const learns=loadLearns();
      const dates = new Set([...Object.keys(wm), ...Object.keys(rm), ...Object.keys(vm), ...Object.keys(pm), ...allClients.map(c=>c.date).filter(Boolean), today]);
      const ts = Date.now();
      const payload = [];
      for(const d of dates){
        const dClients=allClients.filter(c=>c.date===d);
        const item = {
          date:d,
          wechatCount:wm[d]||0,
          intentCount:dClients.length,
          revisitCount:rm[d]||0,
          visitCount:vm[d]||0,
          paymentCount:pm[d]||0,
          clients:dClients,
          webhookUrl:webhookUrl,
          _ts:ts
        };
        if(d===today){
          item.todayTodos=loadTodos(TODAY_TODO_K).filter(t=>(typeof t==='string'?today:(t.date||today))===today);
          item.tomorrowTodos=loadTodos(TOMORROW_TODO_K).filter(t=>(typeof t==='string'?today:(t.date||today))===today);
          item.tempClients=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
          item.scripts=scripts;
          item.learns=learns;
        }
        payload.push(item);
      }
      localStorage.setItem(LOCAL_TS_K,ts);
      await cloudSave(payload);
      addSyncLog('✅ 手动全量历史数据同步成功');
    } else {
      const todayClients=allClients.filter(c=>c.date===today);
      const data={
        date:today,
        wechatCount:wm[today]||0,
        intentCount:todayClients.length,
        revisitCount:rm[today]||0,
        visitCount:vm[today]||0,
        paymentCount:pm[today]||0,
        clients:todayClients,
        todayTodos:loadTodos(TODAY_TODO_K).filter(t=>(typeof t==='string'?today:(t.date||today))===today),
        tomorrowTodos:loadTodos(TOMORROW_TODO_K).filter(t=>(typeof t==='string'?today:(t.date||today))===today),
        tempClients:JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]'),
        webhookUrl:webhookUrl,
        _ts:Date.now()
      };
      localStorage.setItem(LOCAL_TS_K,data._ts);
      await cloudSave(data);
    }
  }

  // 从 KV 拉取最新数据，如果云端更新则覆盖本地
  async function pullLatest(){
    const today=getTodayStr();
    let data=null;
    try{
      data=await cloudGet(today);
    }catch(errVal){
      addSyncLog('⚠️ 同步拉取异常: '+errVal.message);
      return;
    }
    if(!data)return;
    const localTs=parseInt(localStorage.getItem(LOCAL_TS_K)||'0');
    if((data._ts||0)>localTs){
      // 微信计数取最大值
      const wm=loadMap(WECHAT_K);
      wm[today]=Math.max(wm[today]||0, data.wechatCount||0);
      saveMap(WECHAT_K,wm);
      const im=loadMap(INTENT_K);im[today]=data.intentCount||0;saveMap(INTENT_K,im);
      // 回访计数取最大值
      const rm=loadMap(REVISIT_K);
      rm[today]=Math.max(rm[today]||0, data.revisitCount||0);
      saveMap(REVISIT_K,rm);
      // 上门计数取最大值
      const vm=loadMap(VISIT_K);
      vm[today]=Math.max(vm[today]||0, data.visitCount||0);
      saveMap(VISIT_K,vm);
      // 回款计数取最大值
      const pm=loadMap(PAYMENT_K);
      pm[today]=Math.max(pm[today]||0, data.paymentCount||0);
      saveMap(PAYMENT_K,pm);
      // 目标：云端版本为准
      if(data.goals!==undefined)saveGoals(data.goals);
      // 客户列表：合并（取并集），云端新增的保留，本地新增的也保留
      if(data.clients!==undefined){
        const allClients=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
        const nonToday=allClients.filter(c=>c.date!==today);
        const localToday=allClients.filter(c=>c.date===today);
        const mergeMap=new Map();
        // 先放本地（保留本地未同步的条目）
        localToday.forEach(c=>mergeMap.set(c.name+'|'+c.phone+'|'+(c.time||''),c));
        // 再放云端（云端的备注/字段更新会覆盖同 key 的本地旧值）
        (data.clients||[]).forEach(c=>mergeMap.set(c.name+'|'+c.phone+'|'+(c.time||''),c));
        localStorage.setItem(CLIENTS_K,JSON.stringify([...nonToday,...mergeMap.values()]));
      }
      // 待办：云端版本为准（通过 setTodayTodos/setTomorrowTodos 原子同步）
      if(data.todayTodos!==undefined)saveTodos(TODAY_TODO_K,data.todayTodos);
      if(data.tomorrowTodos!==undefined)saveTodos(TOMORROW_TODO_K,data.tomorrowTodos);
      // 临时登记：云端版本为准
      if(data.tempClients!==undefined)localStorage.setItem(TEMP_CLIENTS_K,JSON.stringify(data.tempClients));
      // 话术/学习
      if(data.scripts!==undefined){saveScripts(data.scripts);renderLockScripts();}
      if(data.learns!==undefined){saveLearns(data.learns);renderLockLearns();}
      // 同步 Webhook URL 并保存到本地，解耦 DOM 访问
      if(data.webhookUrl!==undefined)localStorage.setItem('webhook_url',data.webhookUrl);
      localStorage.setItem(LOCAL_TS_K,data._ts);
      refreshAll();
      addSyncLog('✅ 拉取并合并云端最新数据完成');
    }
    _lastSyncTime=new Date();
    if(loadOpQueue().length===0)_syncStatus='synced';
    updateSyncIndicator();
  }

  // 跨天从云端恢复数据（页面加载时使用）
  async function loadFromCloud(date){
    if(!date)date=getTodayStr();
    let data=null;
    try{
      data=await cloudGet(date);
    }catch(errVal){
      addSyncLog('⚠️ 跨天数据拉取异常: '+errVal.message);
      return false;
    }
    if(!data)return false;
    const wm=loadMap(WECHAT_K);wm[date]=data.wechatCount||0;saveMap(WECHAT_K,wm);
    const im=loadMap(INTENT_K);im[date]=data.intentCount||0;saveMap(INTENT_K,im);
    const rm=loadMap(REVISIT_K);rm[date]=data.revisitCount||0;saveMap(REVISIT_K,rm);
    const vm=loadMap(VISIT_K);vm[date]=data.visitCount||0;saveMap(VISIT_K,vm);
    const pm=loadMap(PAYMENT_K);pm[date]=data.paymentCount||0;saveMap(PAYMENT_K,pm);
    if(data.goals!==undefined)saveGoals(data.goals);
    if(data.clients!==undefined){
      const all=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
      const nonDay=all.filter(c=>c.date!==date);
      localStorage.setItem(CLIENTS_K,JSON.stringify([...nonDay,...(data.clients||[])]));
    }
    if(data.todayTodos!==undefined)saveTodos(TODAY_TODO_K,data.todayTodos);
    if(data.tomorrowTodos!==undefined)saveTodos(TOMORROW_TODO_K,data.tomorrowTodos);
    if(data.tempClients!==undefined)localStorage.setItem(TEMP_CLIENTS_K,JSON.stringify(data.tempClients));
    if(data.scripts!==undefined)saveScripts(data.scripts);
    if(data.learns!==undefined)saveLearns(data.learns);
    if(data.webhookUrl!==undefined)localStorage.setItem('webhook_url',data.webhookUrl);
    if(data.lastLoadDate)localStorage.setItem(LAST_LOAD_DATE_K,data.lastLoadDate);
    localStorage.setItem(LOCAL_TS_K,data._ts||Date.now());
    return true;
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
    const container = document.getElementById('clientList');
    if(!container)return;
    if(clients.length===0){
      container.innerHTML='<div class="empty-clients">暂无意向客户</div>';
      return;
    }
    container.innerHTML=clients.map((c,i)=>{
      return '<div class="client-card-item">'+
        '<div class="client-card-top">'+
          '<div class="client-card-primary">'+
            '<span class="client-card-name">'+esc(c.name)+'</span>'+
            '<span class="client-card-phone-wrap">'+
              '<a class="client-phone" href="tel:'+esc(c.phone)+'" data-full="'+esc(c.phone)+'">'+esc(maskPhone(c.phone))+'</a>'+
              '<button class="phone-toggle" title="显示号码">看</button>'+
            '</span>'+
          '</div>'+
          (c.time ? '<span class="client-card-time">'+esc(c.time)+'</span>' : '')+
        '</div>'+
        '<div class="client-card-tags">'+
          (c.company ? '<span class="client-card-tag client-card-tag-company">'+esc(c.company)+'</span>' : '')+
          (c.fund ? '<span class="client-card-tag client-card-tag-fund">公积金: '+esc(c.fund)+'</span>' : '')+
        '</div>'+
        '<div class="client-card-body">'+
          '<div class="client-card-content-block">'+
            '<span class="client-card-label">沟通记录</span>'+
            '<span class="client-card-text">'+esc(c.note||'')+'</span>'+
          '</div>'+
          (c.followUp ? 
            '<div class="client-card-content-block follow-up">'+
              '<span class="client-card-label">跟进情况</span>'+
              '<span class="client-card-text" style="color:var(--accent-wechat);">'+esc(c.followUp)+'</span>'+
            '</div>' : '')+
        '</div>'+
        '<div class="client-card-actions">'+
          '<button class="export-single-btn" data-name="'+esc(c.name)+'" data-phone="'+esc(c.phone)+'" data-time="'+esc(c.time||'')+'" title="导出">出</button>'+
          '<button class="edit-icon" data-name="'+esc(c.name)+'" data-phone="'+esc(c.phone)+'" data-time="'+esc(c.time||'')+'" title="编辑">编</button>'+
          '<button class="del-icon" data-name="'+esc(c.name)+'" data-phone="'+esc(c.phone)+'" data-time="'+esc(c.time||'')+'" title="删除">×</button>'+
        '</div>'+
      '</div>';
    }).join('');

    container.querySelectorAll('.del-icon').forEach(b=>b.addEventListener('click',async e=>{
      const name=b.dataset.name;
      const phone=b.dataset.phone;
      const time=b.dataset.time;
      const a=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
      const idx=a.findIndex(c=>c.name===name&&c.phone===phone&&c.time===time);
      if(idx<0)return;
      a.splice(idx,1);localStorage.setItem(CLIENTS_K,JSON.stringify(a));
      renderClientList();refreshAll();
      await syncOp('removeClientByMatch',{name:name,phone:phone,time:time});
    }));
    container.querySelectorAll('.edit-icon').forEach(b=>b.addEventListener('click',async e=>{
      const name=b.dataset.name;
      const phone=b.dataset.phone;
      const time=b.dataset.time;
      const a=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
      const idx=a.findIndex(c=>c.name===name&&c.phone===phone&&c.time===time);
      if(idx<0)return;
      const c=a[idx];
      document.getElementById('custName').value=c.name;
      document.getElementById('custPhone').value=c.phone;
      document.getElementById('custCompany').value=c.company||'';
      document.getElementById('custFund').value=c.fund||'';
      document.getElementById('custNote').value=c.note||'';
      document.getElementById('custFollowUp').value=c.followUp||'';
      a.splice(idx,1);localStorage.setItem(CLIENTS_K,JSON.stringify(a));
      renderClientList();refreshAll();
      await syncOp('removeClientByMatch',{name:name,phone:phone,time:time});
      document.getElementById('custName').focus();
    }));
    container.querySelectorAll('.export-single-btn').forEach(b=>b.addEventListener('click',async e=>{
      const name=b.dataset.name;
      const phone=b.dataset.phone;
      const time=b.dataset.time;
      const a=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
      const c=a.find(item=>item.name===name&&item.phone===phone&&(time?item.time===time:true));
      if(!c)return;
      const savedUrl=(localStorage.getItem('webhook_url')||'').trim();
      if(!savedUrl){
        alert('请先在主菜单 → 导出数据 中配置企业微信 Webhook URL');
        return;
      }
      b.textContent='...';
      b.disabled=true;
      try{
        const r=await fetch('/api/export',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({type:'single_client',webhookUrl:savedUrl,client:c})
        });
        if(r.ok){
          alert('客户已成功导出到企业微信！');
        }else{
          const err=await r.json();
          alert('导出失败: ' + (err.error || r.statusText));
        }
      }catch(errVal){
        alert('网络错误: ' + errVal.message);
      }
      b.textContent='出';
      b.disabled=false;
    }));
    container.querySelectorAll('.phone-toggle').forEach(b=>b.addEventListener('click',e=>{
      e.stopPropagation();
      const phoneSpan=b.previousElementSibling;
      const full=phoneSpan.dataset.full;
      if(phoneSpan.textContent===full){
        phoneSpan.textContent=maskPhone(full);
        b.title='显示号码';
        b.textContent='看';
      }else{
        phoneSpan.textContent=full;
        b.title='隐藏号码';
        b.textContent='隐';
      }
    }));
  }

  function renderTodos(){
    const today=getTodayStr();
    const tt=loadTodos(TODAY_TODO_K).filter(t=>(typeof t==='string'?today:(t.date||today))===today);
    const tm=loadTodos(TOMORROW_TODO_K).filter(t=>(typeof t==='string'?today:(t.date||today))===today);
    const tc=document.getElementById('todayTodoList'), mc=document.getElementById('tomorrowTodoList');
    const makeItem=(t,i,list)=>{
      const txt=typeof t==='string'?t:t.text;
      const rm=t&&t.remind?'<span class="todo-time-tag">'+esc(t.remind)+'</span>':'';
      return '<div class="todo-item-clean"><span class="todo-number-clean">'+(i+1)+'.</span><span class="todo-text-clean">'+esc(txt)+rm+'</span><button class="todo-del-btn-clean" data-idx="'+i+'" data-list="'+list+'">✕</button></div>';
    };
    tc.innerHTML=tt.length===0?'<div style="font-size:0.75rem;color:var(--text-light);padding:6px;">暂无待办</div>':tt.map((t,i)=>makeItem(t,i,'today')).join('');
    mc.innerHTML=tm.length===0?'<div style="font-size:0.75rem;color:var(--text-light);padding:6px;">暂无待办</div>':tm.map((t,i)=>makeItem(t,i,'tomorrow')).join('');
    document.querySelectorAll('.todo-del-btn-clean').forEach(b=>b.addEventListener('click',async e=>{
      const i=parseInt(b.dataset.idx),l=b.dataset.list;
      const todos=loadTodos(l==='today'?TODAY_TODO_K:TOMORROW_TODO_K);
      todos.splice(i,1);saveTodos(l==='today'?TODAY_TODO_K:TOMORROW_TODO_K,todos);renderTodos();
      await syncOp(l==='today'?'setTodayTodos':'setTomorrowTodos',{todos});
    }));
  }

  function renderCalendar(wm,im){
    const [y,m]=calendarMonth.split('-').map(Number);const ref=new Date(y,m-1);
    const fd=new Date(y,m-1,1);let si=(fd.getDay()+6)%7;
    const dim=new Date(y,m,0).getDate(),ts=getTodayStr();
    const clients=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
    const ccMap={};clients.forEach(c=>{if(c.date)ccMap[c.date]=(ccMap[c.date]||0)+1;});
    const mn=['1月','2月','3月','4月','5月','6月','7月','8月','9月','10月','11月','12月'];
    document.getElementById('calMonthTitle').innerHTML=y+'年 '+mn[m-1];
    let g='';const wd=['一','二','三','四','五','六','日'];
    wd.forEach(d=>{g+='<div class="cal-weekday">'+d+'</div>';});
    for(let i=0;i<si;i++)g+='<div class="cal-day"></div>';
    for(let d=1;d<=dim;d++){
      const ds=y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
      const wv=wm[ds]||0,iv=im[ds]||0,cv=ccMap[ds]||0;
      let bh='';if(wv>0||iv>0||cv>0)bh='<div class="day-badge">'+(wv>0?'<span>微'+wv+'</span>':'')+(iv>0?'<span>意'+iv+'</span>':'')+(cv>0?'<span>客'+cv+'</span>':'')+'</div>';
      const it=ds===ts, pt=ds<ts;
      g+='<div class="cal-day'+(it?' today':pt?' past':'')+'" data-date="'+ds+'" data-w="'+wv+'" data-i="'+iv+'"><div class="day-number">'+d+'</div>'+bh+'</div>';
    }
    document.getElementById('calGrid').innerHTML=g;
    const tip=document.getElementById('globalTooltip');
    document.querySelectorAll('.cal-day[data-date]').forEach(c=>{
      c.addEventListener('mouseenter',e=>{tip.innerHTML='<strong>'+c.dataset.date+'</strong> 微'+(c.dataset.w||0)+' 意'+(c.dataset.i||0);tip.classList.add('show');});
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
    // 合并本地客户到云端列表（本地最新优先）
    const localAll=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
    const localDay=localAll.filter(c=>c.date===ds);
    localDay.forEach(lc=>{
      const exist=clients.findIndex(cc=>cc.name===lc.name&&cc.phone===lc.phone&&cc.time===lc.time);
      if(exist>=0){clients[exist]=lc;}else{clients.push(lc);}
    });
    if(todos.length===0&&ds===getTodayStr())todos=loadTodos(TODAY_TODO_K);
    // 同时获取该日期的 todoLog（永久待办记录）
    let todoLog=[];
    if(cloudData&&cloudData.todoLog)todoLog=cloudData.todoLog;
    let timeline=[];
    clients.forEach((c,i)=>{timeline.push({type:'client',time:c.time||'',name:c.name,phone:c.phone,company:c.company||'',fund:c.fund||'',note:c.note,idx:i});});
    todos.forEach(t=>{const txt=typeof t==='string'?t:t.text;const tm=t&&t.time?t.time:'';if(txt)timeline.push({type:'todo',time:tm,text:txt});});
    todoLog.forEach(t=>{const txt=typeof t==='string'?t:t.text;const tm=t&&t.time?t.time:'';const tp=t.type==='tomorrow'?' (明日)':'';if(txt)timeline.push({type:'todo',time:tm,text:txt+tp});});
    timeline.sort((a,b)=>(a.time||'').localeCompare(b.time||''));
    function renderTl(){
      const clients_in_tl = timeline.filter(e=>e.type==='client');
      const todos_in_tl   = timeline.filter(e=>e.type==='todo');

      if(timeline.length===0){
        document.getElementById('modalClientList').innerHTML='<div class="empty-clients">— 当日无记录 —</div>';
        return;
      }

      let html = '';

      // ===== 意向客户区 =====
      if(clients_in_tl.length>0){
        html += '<div>';
        html += '<div class="modal-section-title">意向客户<span style="font-size:0.7rem;color:var(--accent-intent);margin-left:4px;font-weight:800;">'+clients_in_tl.length+'人</span></div>';
        html += '<div style="display:flex;flex-direction:column;gap:10px;">';
        clients_in_tl.forEach((e,i)=>{
          html += '<div class="client-card-item">'+
            '<div class="client-card-top">'+
              '<div class="client-card-primary">'+
                '<span class="client-card-name">'+esc(e.name)+'</span>'+
                '<span class="client-card-phone-wrap">'+
                  '<a class="modal-client-phone" href="tel:'+esc(e.phone)+'" data-full="'+esc(e.phone)+'">'+esc(maskPhone(e.phone))+'</a>'+
                  '<button class="phone-toggle" title="显示号码">看</button>'+
                '</span>'+
              '</div>'+
              (e.time ? '<span class="client-card-time">'+esc(e.time)+'</span>' : '')+
            '</div>'+
            '<div class="client-card-tags">'+
              (e.company ? '<span class="client-card-tag client-card-tag-company">'+esc(e.company)+'</span>' : '')+
              (e.fund ? '<span class="client-card-tag client-card-tag-fund">公积金: '+esc(e.fund)+'</span>' : '')+
            '</div>'+
            '<div class="client-card-body">'+
              '<div class="client-card-content-block">'+
                '<span class="client-card-label">沟通记录</span>'+
                '<div id="cn_'+e.idx+'">'+
                  '<div class="tbl-note-text" style="cursor:pointer;">'+(e.note?esc(e.note):'<span class="tbl-note-empty">点击添加沟通记录…</span>')+'</div>'+
                '</div>'+
              '</div>'+
            '</div>'+
            '<div class="client-card-actions">'+
              '<button class="export-timeline-single-btn" data-idx="'+e.idx+'" title="导出">出</button>'+
              '<button class="edit-note-btn" title="'+(e.note?'修改记录':'添加记录')+'" data-idx="'+e.idx+'">编</button>'+
            '</div>'+
          '</div>';
        });
        html += '</div></div>';
      }

      // ===== 待办事项区 =====
      if(todos_in_tl.length>0){
        html += '<div style="margin-top:'+(clients_in_tl.length>0?'4px':'0')+'">';
        html += '<div class="modal-section-title">待办事项 <span style="font-size:0.7rem;color:var(--accent-wechat);margin-left:4px;font-weight:800;">'+todos_in_tl.length+'条</span></div>';
        html += '<div style="display:flex;flex-direction:column;gap:6px;">';
        todos_in_tl.forEach(e=>{
          html += '<div class="todo-card-item"><div style="flex:1;"><div class="todo-card-text">'+esc(e.text)+'</div>'+(e.time?'<div class="todo-card-time">'+esc(e.time)+'</div>':'')+'</div></div>';
        });
        html += '</div></div>';
      }

      document.getElementById('modalClientList').innerHTML = html;

      bindEditBtns();
      // Bind Timeline Single Client Export
      document.querySelectorAll('.export-timeline-single-btn').forEach(btn=>{
        btn.onclick=async function(){
          const idx=parseInt(this.dataset.idx);
          const ti=timeline.find(t=>t.type==='client'&&t.idx===idx);
          if(!ti)return;
          const savedUrl=(localStorage.getItem('webhook_url')||'').trim();
          if(!savedUrl){
            alert('请先在主菜单 → 导出数据 中配置企业微信 Webhook URL');
            return;
          }
          btn.textContent='...';
          btn.disabled=true;
          try{
            const r=await fetch('/api/export',{
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body:JSON.stringify({
                type:'single_client',
                webhookUrl:savedUrl,
                client:{
                  date:ds,
                  name:ti.name,
                  phone:ti.phone,
                  company:ti.company,
                  fund:ti.fund,
                  note:ti.note,
                  time:ti.time
                }
              })
            });
            if(r.ok){
              alert('客户已成功导出到企业微信！');
            }else{
              const err=await r.json();
              alert('导出失败: ' + (err.error || r.statusText));
            }
          }catch(errVal){
            alert('网络错误: ' + errVal.message);
          }
          btn.textContent='出';
          btn.disabled=false;
        };
      });
      document.querySelectorAll('#modalClientList .phone-toggle').forEach(b=>b.addEventListener('click',e=>{
        e.stopPropagation();
        const phoneSpan=b.previousElementSibling;
        const full=phoneSpan.dataset.full;
        if(phoneSpan.textContent===full){
          phoneSpan.textContent=maskPhone(full);
          b.title='显示号码';
          b.textContent='看';
        }else{
          phoneSpan.textContent=full;
          b.title='隐藏号码';
          b.textContent='隐';
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
          noteDiv.innerHTML='<div class="tbl-note-edit-wrap"><textarea id="ein_'+idx+'">'+esc(old)+'</textarea><div class="tbl-note-edit-btns"><button id="sn_'+idx+'" class="tbl-save-btn">保存</button><button id="cn_btn_'+idx+'" class="tbl-cancel-btn">取消</button></div></div>';
          document.getElementById('sn_'+idx).onclick=async ()=>{
            const nn=document.getElementById('ein_'+idx).value.trim();
            ti.note=nn;
            const co=clients.find(c=>c.name===ti.name&&c.phone===ti.phone);
            if(co)co.note=nn;
            const all=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
            let target=all.find(c=>c.date===ds&&c.name===ti.name&&c.phone===ti.phone);
            if(!target){target=all.find(c=>c.name===ti.name&&c.phone===ti.phone);}
            if(target){target.note=nn;}
            else{all.push({name:ti.name,phone:ti.phone,company:ti.company,fund:ti.fund,note:nn,date:ds,time:ti.time||''});}
            localStorage.setItem(CLIENTS_K,JSON.stringify(all));
            await syncOp('updateClientNote',{name:ti.name,phone:ti.phone,note:nn});
            renderTl();
          };
          document.getElementById('cn_btn_'+idx).onclick=()=>renderTl();
        };
      });
    }
    renderTl();
  }

  async function syncCalendarFromCloud(){
    const month=calendarMonth;
    const cal=await cloudCalendar(month);
    if(cal){
      const wm=loadMap(WECHAT_K), im=loadMap(INTENT_K), rm=loadMap(REVISIT_K), vm=loadMap(VISIT_K), pm=loadMap(PAYMENT_K);
      let changed=false;
      for(const [date, d] of Object.entries(cal)){
        const nw = Math.max(wm[date]||0, d.w||0);
        if(nw !== (wm[date]||0)){ wm[date]=nw; changed=true; }
        const ni = Math.max(im[date]||0, d.i||0);
        if(ni !== (im[date]||0)){ im[date]=ni; changed=true; }
        const nr = Math.max(rm[date]||0, d.r||0);
        if(nr !== (rm[date]||0)){ rm[date]=nr; changed=true; }
        const nv = Math.max(vm[date]||0, d.v||0);
        if(nv !== (vm[date]||0)){ vm[date]=nv; changed=true; }
        const np = Math.max(pm[date]||0, d.p||0);
        if(np !== (pm[date]||0)){ pm[date]=np; changed=true; }
      }
      if(changed){saveMap(WECHAT_K,wm);saveMap(INTENT_K,im);saveMap(REVISIT_K,rm);saveMap(VISIT_K,vm);saveMap(PAYMENT_K,pm);}
      addSyncLog('✅ 拉取云端历史日历完成');
    }
  }

  const SHOW_GOAL_NUM_K='show_goal_num_v1';
  function renderGoalChips(){
    const container=document.getElementById('goalChips');
    const showNum=localStorage.getItem(SHOW_GOAL_NUM_K)==='true';
    const eyeBtn=document.getElementById('goalEyeBtn');
    if(eyeBtn){
      eyeBtn.className='goal-eye'+(showNum?'':' eye-off');
      eyeBtn.title=showNum?'隐藏目标数字':'显示目标数字';
    }
    const wm=loadMap(WECHAT_K),vm=loadMap(VISIT_K),pm=loadMap(PAYMENT_K);
    const goals=loadGoals();
    let html='';
    const makeChip=(label,actual,target)=>{
      if(!target||target<=0)return'';
      if(!showNum) return '<span class="goal-chip">'+label+'</span>';
      const pct=Math.round(actual/target*100);
      const cls=pct>=100?'goal-met':pct>=50?'goal-half':'goal-low';
      return '<span class="goal-chip '+cls+'">'+label+' '+actual+'/'+target+'</span>';
    };
    html+=makeChip('本周上门',getWeekTotal(vm),goals.weeklyVisit);
    html+=makeChip('本周微信',getWeekTotal(wm),goals.weeklyWechat);
    html+=makeChip('本月微信',getMonthTotal(wm,calendarMonth),goals.monthlyWechat);
    html+=makeChip('本月上门',getMonthTotal(vm,calendarMonth),goals.monthlyVisit);
    html+=makeChip('本月回款',getMonthTotal(pm,calendarMonth),goals.monthlyPayment);
    container.innerHTML=html;
  }
  function toggleGoalNumbers(){
    const cur=localStorage.getItem(SHOW_GOAL_NUM_K)==='true';
    localStorage.setItem(SHOW_GOAL_NUM_K,!cur);
    renderGoalChips();
  }

  function refreshAll(){
    const wm=loadMap(WECHAT_K),im=loadMap(INTENT_K),rm=loadMap(REVISIT_K),vm=loadMap(VISIT_K),pm=loadMap(PAYMENT_K),today=getTodayStr();
    // 意向计数直接从当日客户数派生，确保永远准确
    const allClients=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
    const todayClients=allClients.filter(c=>c.date===today);
    const todayIntent=todayClients.length;
    im[today]=todayIntent;saveMap(INTENT_K,im);
    document.getElementById('wechatNum').innerText=wm[today]||0;
    document.getElementById('intentNum').innerText=todayIntent;
    document.getElementById('revisitNum').innerText=rm[today]||0;
    document.getElementById('pinWechatNum').innerText=wm[today]||0;
    document.getElementById('pinIntentNum').innerText=todayIntent;
    document.getElementById('pinRevisitNum').innerText=rm[today]||0;
    document.getElementById('weekWechat').innerText=getWeekTotal(wm);
    document.getElementById('monthWechat').innerText=getMonthTotal(wm);
    document.getElementById('weekIntent').innerText=getWeekTotal(im);
    document.getElementById('monthIntent').innerText=getMonthTotal(im);
    document.getElementById('weekRevisit').innerText=getWeekTotal(rm);
    document.getElementById('monthRevisit').innerText=getMonthTotal(rm);
    const now=new Date();const wk=['周日','周一','周二','周三','周四','周五','周六'];
    document.getElementById('liveDate').innerHTML=(now.getMonth()+1)+'月'+now.getDate()+'日 '+wk[now.getDay()];
    renderCalendar(wm,im);renderClientList();renderTodos();renderTempClientList();
    renderGoalChips();
  }

  async function modCounter(key,delta,op){
    // 直接在本地值基础上增减，立即响应；服务端原子写入保证多设备最终一致
    const t=getTodayStr();
    const d=loadMap(key);
    let v=Math.max((d[t]||0)+delta,0);
    if(v===0)delete d[t];else d[t]=v;saveMap(key,d);
    refreshAll();
    await syncOp(op||'incWechat',{delta});
  }
  async function resetToday(key,op){const d=loadMap(key);const t=getTodayStr();const old=d[t]||0;delete d[t];saveMap(key,d);refreshAll();if(old>0)await syncOp(op||'incWechat',{delta:-old});}

  async function addClient(){
    const n=document.getElementById('custName').value.trim();
    const p=document.getElementById('custPhone').value.trim();
    const c=document.getElementById('custCompany').value.trim();
    const f=document.getElementById('custFund').value.trim();
    const nt=document.getElementById('custNote').value.trim();
    const fu=document.getElementById('custFollowUp').value.trim();
    if(!n){alert('姓名不能为空，请填写完整！');return;}
    if(!p){alert('电话号码不能为空，请填写完整！');return;}
    if(!nt){alert('沟通记录为必填项，请填写完整！');return;}
    const list=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
    const today=getTodayStr(),time=getCurrentTime();
    const newClient={name:n,phone:p,company:c,fund:f,note:nt,followUp:fu,date:today,time:time};
    list.push(newClient);
    localStorage.setItem(CLIENTS_K,JSON.stringify(list));
    document.getElementById('custName').value='';
    document.getElementById('custPhone').value='';
    document.getElementById('custCompany').value='';
    document.getElementById('custFund').value='';
    document.getElementById('custNote').value='';
    document.getElementById('custFollowUp').value='';
    renderClientList();refreshAll();
    // 只用原子 syncOp，不再并发 saveFullState（避免竞态导致云端客户重复/覆盖）
    await syncOp('addClient',{client:newClient});
  }

  async function addTempClient(){
    const n=document.getElementById('tempCustName').value.trim();
    const p=document.getElementById('tempCustPhone').value.trim();
    const nt=document.getElementById('tempCustNote').value.trim();
    if(!n||!p){alert('请填写姓名和联系方式');return;}
    const list=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
    const today=getTodayStr(),time=getCurrentTime();
    const newClient={name:n,phone:p,note:nt,date:today,time:time};
    list.push(newClient);
    localStorage.setItem(TEMP_CLIENTS_K,JSON.stringify(list));
    document.getElementById('tempCustName').value='';
    document.getElementById('tempCustPhone').value='';
    document.getElementById('tempCustNote').value='';
    renderTempClientList();
    await syncOp('setTempClients',{tempClients:list});
  }

  function renderTempClientList(){
    const list=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
    const container = document.getElementById('tempClientList');
    if(!container) return;
    if(list.length===0){
      container.innerHTML='<div class="empty-clients">暂无临时登记客户</div>';
      return;
    }
    container.innerHTML=list.map((c,i)=>{
      return '<div class="client-card-item">'+
        '<div class="client-card-top">'+
          '<div class="client-card-primary">'+
            '<span class="client-card-name">'+esc(c.name)+'</span>'+
            '<span class="client-card-phone-wrap">'+
              '<a class="client-phone" href="tel:'+esc(c.phone)+'" data-full="'+esc(c.phone)+'">'+esc(maskPhone(c.phone))+'</a>'+
              '<button class="phone-toggle" title="显示号码">看</button>'+
            '</span>'+
          '</div>'+
          (c.time ? '<span class="client-card-time">'+esc(c.time)+'</span>' : '')+
        '</div>'+
        '<div class="client-card-body">'+
          '<div class="client-card-content-block">'+
            '<span class="client-card-label">回访备注</span>'+
            '<span class="client-card-text">'+esc(c.note||'')+'</span>'+
          '</div>'+
        '</div>'+
        '<div class="client-card-actions">'+
          '<button class="convert-temp-btn" data-idx="'+i+'" title="转为正式意向客户" style="font-size:1.1rem;padding:0;background:none;border:none;color:var(--accent-intent);cursor:pointer;margin-right:8px;font-weight:700;">→</button>'+
          '<button class="del-icon del-temp-btn" data-idx="'+i+'" title="删除" style="vertical-align:middle;padding:0;width:20px;height:20px;line-height:20px;display:inline-block;">×</button>'+
        '</div>'+
      '</div>';
    }).join('');
    
    // 绑定删除按钮
    container.querySelectorAll('.del-temp-btn').forEach(b=>{
      b.onclick=async function(){
        const idx=parseInt(this.dataset.idx);
        const a=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
        a.splice(idx,1);
        localStorage.setItem(TEMP_CLIENTS_K,JSON.stringify(a));
        renderTempClientList();
        await syncOp('setTempClients',{tempClients:a});
      };
    });

    // 绑定转意向按钮
    container.querySelectorAll('.convert-temp-btn').forEach(b=>{
      b.onclick=async function(){
        const idx=parseInt(this.dataset.idx);
        const a=JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]');
        const c=a[idx];
        
        // 填充正式客户登记输入框
        document.getElementById('custName').value=c.name;
        document.getElementById('custPhone').value=c.phone;
        document.getElementById('custNote').value=c.note||'';
        document.getElementById('custCompany').value='';
        document.getElementById('custFund').value='';
        
        // 从临时列表中删除
        a.splice(idx,1);
        localStorage.setItem(TEMP_CLIENTS_K,JSON.stringify(a));
        renderTempClientList();
        await syncOp('setTempClients',{tempClients:a});
        
        // 聚焦姓名输入框，方便用户补充单位/公积金并点击添加
        document.getElementById('custName').focus();
        
        // 正式卡片微缩放动画高亮
        const card = document.getElementById('custName').closest('.card');
        if(card){
          card.style.transform = 'scale(1.02)';
          card.style.transition = 'all 0.3s';
          setTimeout(() => card.style.transform = 'none', 500);
        }
      };
    });

    // 绑定手机号切换
    container.querySelectorAll('.phone-toggle').forEach(b=>b.addEventListener('click',e=>{
      e.stopPropagation();
      const phoneSpan=b.previousElementSibling;
      const full=phoneSpan.dataset.full;
      if(phoneSpan.textContent===full){
        phoneSpan.textContent=maskPhone(full);
        b.title='显示号码';
        b.textContent='看';
      }else{
        phoneSpan.textContent=full;
        b.title='隐藏号码';
        b.textContent='隐';
      }
    }));
  }

  async function addTodayTodo(){
    const input=document.getElementById('todayTodoInput'),text=input.value.trim();
    if(!text)return;const remind=document.getElementById('todayRemindTime').value;
    const todo={text,time:getCurrentTime(),date:getTodayStr(),remind:remind||'',type:'today'};
    const t=loadTodos(TODAY_TODO_K);t.push(todo);saveTodos(TODAY_TODO_K,t);input.value='';document.getElementById('todayRemindTime').value='';renderTodos();
    pushTodoLog(todo,getTodayStr());
    await syncOp('setTodayTodos',{todos:t});
  }
  async function addTodo(){
    const input=document.getElementById('todoInput'),text=input.value.trim();
    if(!text)return;const remind=document.getElementById('tomorrowRemindTime').value;
    const todo={text,time:getCurrentTime(),date:getTodayStr(),remind:remind||'',type:'tomorrow'};
    const t=loadTodos(TOMORROW_TODO_K);t.push(todo);saveTodos(TOMORROW_TODO_K,t);input.value='';document.getElementById('tomorrowRemindTime').value='';renderTodos();
    pushTodoLog(todo,getTodayStr());
    await syncOp('setTomorrowTodos',{todos:t});
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
  function renderScriptList(){
    const ss=loadScripts();
    document.getElementById('scriptList').innerHTML=ss.length===0?'<div style="font-size:0.75rem;color:var(--text-light);padding:8px;text-align:center;">暂无话术</div>':ss.map((s,i)=>'<div class="script-item" data-si="'+i+'"><span class="script-item-text">'+esc(s)+'</span><div style="display:flex;gap:4px;align-items:center;flex-shrink:0;"><button class="edit-icon" data-si="'+i+'" title="编辑">编</button><button class="del-icon" data-si="'+i+'">×</button></div></div>').join('');
    document.querySelectorAll('#scriptList .del-icon').forEach(b=>b.addEventListener('click',async e=>{
      const i=parseInt(b.dataset.si);const a=loadScripts();a.splice(i,1);saveScripts(a);renderScriptList();renderLockScripts();
      await syncOp('setScripts',{scripts:a});
    }));
    document.querySelectorAll('#scriptList .edit-icon').forEach(b=>b.addEventListener('click',e=>{
      const i=parseInt(b.dataset.si);const a=loadScripts();const old=a[i];const item=document.querySelector('#scriptList .script-item[data-si="'+i+'"]');
      item.innerHTML='<input class="input-simple" id="editScriptInput_'+i+'" value="'+esc(old).replace(/"/g,'&quot;')+'" style="flex:1;font-size:0.75rem;padding:6px 10px;min-width:0;"><div style="display:flex;gap:4px;flex-shrink:0;"><button class="btn-add" id="saveScriptEdit_'+i+'" style="font-size:0.7rem;padding:6px 12px;">保存</button><button class="del-icon" id="cancelScriptEdit_'+i+'" style="color:var(--text-soft);">取消</button></div>';
      document.getElementById('saveScriptEdit_'+i).addEventListener('click',async ()=>{
        const v=document.getElementById('editScriptInput_'+i).value.trim();if(!v)return;
        a[i]=v;saveScripts(a);renderScriptList();renderLockScripts();
        await syncOp('setScripts',{scripts:a});
      });
      document.getElementById('cancelScriptEdit_'+i).addEventListener('click',()=>renderScriptList());
      document.getElementById('editScriptInput_'+i).addEventListener('keypress',e=>{if(e.key==='Enter')document.getElementById('saveScriptEdit_'+i).click();});
      document.getElementById('editScriptInput_'+i).focus();
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
    document.getElementById('addScriptBtn').addEventListener('click',async ()=>{
      const t=document.getElementById('newScriptInput').value.trim();if(!t)return;
      const a=loadScripts();a.push(t);saveScripts(a);document.getElementById('newScriptInput').value='';renderScriptList();renderLockScripts();
      await syncOp('setScripts',{scripts:a});
    });
  }

  // ==================== 学习 ====================
  const loadLearns=()=>{try{return JSON.parse(localStorage.getItem(LEARN_K))||[];}catch(e){return[];}};
  const saveLearns=(a)=>localStorage.setItem(LEARN_K,JSON.stringify(a));
  function renderLearnList(){
    const ls=loadLearns();
    document.getElementById('learnList').innerHTML=ls.length===0?'<div style="font-size:0.75rem;color:var(--text-light);padding:8px;text-align:center;">暂无学习</div>':ls.map((l,i)=>'<div class="script-item"><span class="script-item-text">'+esc(l.text)+'</span><div style="display:flex;gap:6px;align-items:center;"><input type="checkbox" '+(l.show?'checked':'')+' data-li="'+i+'" title="锁屏显示"><button class="del-icon" data-li="'+i+'">×</button></div></div>').join('');
    document.querySelectorAll('#learnList .del-icon').forEach(b=>b.addEventListener('click',async e=>{
      const i=parseInt(b.dataset.li);const a=loadLearns();a.splice(i,1);saveLearns(a);renderLearnList();renderLockLearns();
      await syncOp('setLearns',{learns:a});
    }));
    document.querySelectorAll('#learnList input[type=checkbox]').forEach(cb=>cb.addEventListener('change',async e=>{
      const i=parseInt(cb.dataset.li);const a=loadLearns();a[i].show=cb.checked;saveLearns(a);renderLearnList();renderLockLearns();
      await syncOp('setLearns',{learns:a});
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
    document.getElementById('addLearnBtn').addEventListener('click',async ()=>{
      const t=document.getElementById('newLearnInput').value.trim();
      if(t){
        const show=document.getElementById('learnShowCheck').checked;
        const a=loadLearns();a.push({text:t,show});saveLearns(a);
        document.getElementById('newLearnInput').value='';
        await syncOp('setLearns',{learns:a});
      }
      renderLearnList();renderLockLearns();
    });
  }

  // ==================== 导出 ====================
  function initExport(){
    document.getElementById('exportBtn').addEventListener('click',()=>{
      document.getElementById('exportStatus').innerText='';
      document.getElementById('webhookUrlInput').value=localStorage.getItem('webhook_url')||'';
      document.getElementById('exportModal').classList.add('active');
    });
    document.getElementById('closeExportModalBtn').addEventListener('click',()=>document.getElementById('exportModal').classList.remove('active'));
    document.getElementById('exportModal').addEventListener('click',e=>{if(e.target===document.getElementById('exportModal'))document.getElementById('exportModal').classList.remove('active');});
    
    // Bind blur to immediately sync the webhookUrl to KV
    document.getElementById('webhookUrlInput').addEventListener('blur',()=>{
      const val=document.getElementById('webhookUrlInput').value.trim();
      localStorage.setItem('webhook_url',val);
      syncOp('setWebhookUrl',{webhookUrl:val});
    });

    async function doExport(type){
      const webhookUrl=document.getElementById('webhookUrlInput').value.trim();
      if(!webhookUrl){document.getElementById('exportStatus').innerText='请填写 Webhook URL';return;}
      localStorage.setItem('webhook_url',webhookUrl);
      syncOp('setWebhookUrl',{webhookUrl:webhookUrl});
      
      document.getElementById('exportStatus').innerText='发送中...';
      try{
        const r=await fetch('/api/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type,webhookUrl})});
        if(r.ok){
          const data = await r.json();
          if (data.sent !== undefined) {
            document.getElementById('exportStatus').innerText = '已发送 ' + data.sent + '/' + data.total + (data.failed > 0 ? '（' + data.failed + ' 条失败）' : '');
          } else {
            document.getElementById('exportStatus').innerText = '已发送到企业微信';
          }
        }
        else{
          const err=await r.json();
          document.getElementById('exportStatus').innerText='发送失败: '+(err.error||r.statusText);
        }
      }catch(e){document.getElementById('exportStatus').innerText='网络错误: '+e.message;}
    }
    document.getElementById('exportWeekBtn').addEventListener('click',()=>doExport('week'));
    document.getElementById('exportMonthBtn').addEventListener('click',()=>doExport('month'));
    document.getElementById('exportAllClientsBtn').addEventListener('click',()=>doExport('all_clients'));
    document.getElementById('exportSoloBtn').addEventListener('click',()=>doExport('all_clients_solo'));
  }




  // ==================== Android 设备检测 ====================
  function initAndroid(){
    const ua=navigator.userAgent||"";
    const isAndroid=/Android/.test(ua)&&!/iPhone|iPad|iPod/.test(ua);
    if(isAndroid)document.body.classList.add("android");
  }
  function initDark(){
    const btn=document.getElementById('darkToggleBtn');
    const themeMeta=document.querySelector('meta[name="theme-color"]');
    const updateDarkTitle=()=>{const isDark=document.body.classList.contains('dark-mode');btn.textContent=(isDark?'浅色':'深色')+'模式';btn.title=isDark?'切换浅色模式':'切换深色模式';if(themeMeta)themeMeta.content=isDark?'#111111':'#ededed';};
    if(localStorage.getItem(DARK_K)==='true')document.body.classList.add('dark-mode');
    updateDarkTitle();
    btn.addEventListener('click',()=>{document.body.classList.toggle('dark-mode');localStorage.setItem(DARK_K,document.body.classList.contains('dark-mode'));updateDarkTitle();});
  }
  function initGoals(){
    const modal=document.getElementById('goalModal');
    const btn=document.getElementById('goalBtn');
    const closeBtn=document.getElementById('closeGoalModalBtn');
    const saveBtn=document.getElementById('saveGoalBtn');
    const status=document.getElementById('goalStatus');
    btn.addEventListener('click',()=>{
      const goals=loadGoals();
      document.getElementById('goalWeeklyVisit').value=goals.weeklyVisit||'';
      document.getElementById('goalWeeklyWechat').value=goals.weeklyWechat||'';
      document.getElementById('goalMonthlyWechat').value=goals.monthlyWechat||'';
      document.getElementById('goalMonthlyVisit').value=goals.monthlyVisit||'';
      document.getElementById('goalMonthlyPayment').value=goals.monthlyPayment||'';
      status.textContent='';
      modal.classList.add('active');
    });
    closeBtn.addEventListener('click',()=>modal.classList.remove('active'));
    modal.addEventListener('click',e=>{if(e.target===modal)modal.classList.remove('active');});
    saveBtn.addEventListener('click',async()=>{
      const goals={
        weeklyVisit:parseInt(document.getElementById('goalWeeklyVisit').value)||0,
        weeklyWechat:parseInt(document.getElementById('goalWeeklyWechat').value)||0,
        monthlyWechat:parseInt(document.getElementById('goalMonthlyWechat').value)||0,
        monthlyVisit:parseInt(document.getElementById('goalMonthlyVisit').value)||0,
        monthlyPayment:parseInt(document.getElementById('goalMonthlyPayment').value)||0
      };
      saveGoals(goals);
      try{await syncOp('setGoals',{goals});status.textContent='✅ 目标已保存';}catch(e){status.textContent='⚠️ 保存失败，已存本地';}
      modal.classList.remove('active');
      renderGoalChips();
    });
  }
  function isLocked(){return localStorage.getItem(LOCK_K)==='true';}

  // ==================== 日志功能 ====================
  const SYNC_LOG_K='sync_logs_v1';
  function loadSyncLogs(){try{return JSON.parse(localStorage.getItem(SYNC_LOG_K))||[];}catch(e){return[];}}
  function saveSyncLogs(logs){localStorage.setItem(SYNC_LOG_K,JSON.stringify(logs.slice(0,50)));}
  function addSyncLog(msg){
    const logs=loadSyncLogs();
    const d=new Date();
    const ts=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0');
    logs.unshift({ts,msg});
    saveSyncLogs(logs);
  }
  function renderSyncLogs(){
    const list=document.getElementById('syncLogList');
    if(!list)return;
    const esc=(s)=>s.replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const logs=loadSyncLogs();
    list.innerHTML=logs.length===0?'<div style="text-align:center;padding:20px;color:var(--text-light);">暂无日志</div>':logs.map(l=>'<div class="log-item"><span class="log-msg">'+esc(l.msg)+'</span><span class="log-time">'+l.ts+'</span></div>').join('');
  }
  function initLogs(){
    document.getElementById('logBtn').addEventListener('click',()=>{
      renderSyncLogs();
      document.getElementById('logModal').classList.add('active');
    });
    document.getElementById('closeLogModalBtn').addEventListener('click',()=>document.getElementById('logModal').classList.remove('active'));
    document.getElementById('logModal').addEventListener('click',e=>{if(e.target===document.getElementById('logModal'))document.getElementById('logModal').classList.remove('active');});
  }
  function setLocked(l){if(l){localStorage.setItem(LOCK_K,'true');document.body.classList.add('page-hidden');setTimeout(()=>{const pi=document.getElementById('pinInput');if(pi)pi.focus();},100);}else{localStorage.setItem(LOCK_K,'false');document.body.classList.remove('page-hidden');const tc=document.getElementById('timerContainer');if(tc)tc.classList.remove('show');}}

  function hashPinSimple(str){
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
    }
    return (hash >>> 0).toString(16);
  }
  const pi=document.getElementById('pinInput'),pib=document.getElementById('pinUnlockBtn'),pie=document.getElementById('pinError');
  function au(){const e=pi.value.trim();if(hashPinSimple(e)==='7c7cacd4'){localStorage.setItem(UNLOCK_TS_K,Date.now());setLocked(false);pi.value='';pie.innerText='';refreshAll();}else{pie.innerText='PIN码错误';pi.value='';setTimeout(function(){pi.focus();},50);}}
  pib.addEventListener('click',au);pi.addEventListener('keypress',e=>{if(e.key==='Enter')au();});
  document.getElementById('hideBtn').addEventListener('click',()=>{setLocked(true);pi.value='';pie.innerText='';});
  window.addEventListener('keydown',e=>{if(e.ctrlKey&&e.key==='z'){const a=document.activeElement;if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'))return;e.preventDefault();if(document.body.classList.contains('page-hidden'))pie.innerText='请使用PIN解锁';else{setLocked(true);pi.value='';pie.innerText='';}}});
  window.addEventListener('keydown',e=>{if(e.ctrlKey&&e.key.toLowerCase()==='q'){if(!document.body.classList.contains('page-hidden'))return;const a=document.activeElement;if(a&&(a.tagName==='INPUT'||a.tagName==='TEXTAREA'))return;e.preventDefault();const tc=document.getElementById('timerContainer');if(tc)tc.classList.toggle('show');}});
  window.addEventListener('keydown',e=>{if(e.key==='+'||e.key==='='){e.preventDefault();modCounter(WECHAT_K,1,'incWechat');}else if(e.key==='-'||e.key==='_'){e.preventDefault();modCounter(WECHAT_K,-1,'incWechat');}else if(e.key==='ArrowUp'){e.preventDefault();modCounter(REVISIT_K,1,'incRevisit');}else if(e.key==='ArrowDown'){e.preventDefault();modCounter(REVISIT_K,-1,'incRevisit');}});

  // ==================== 锁屏计时器 ====================
  const TIMER_K='timer_state_v1';
  let timerInterval=null,timerRunning=false,timerTotalSeconds=0,timerRemainingSeconds=0;
  const th=document.getElementById('timerHours'),tm=document.getElementById('timerMinutes'),ts=document.getElementById('timerSeconds');
  const tdb=document.getElementById('timerDisplay'),tsb=document.getElementById('timerStartBtn'),trb=document.getElementById('timerResetBtn'),tb=document.getElementById('timerBox');
  const loadTimerState=()=>{try{return JSON.parse(localStorage.getItem(TIMER_K))||{running:false,h:0,m:1,s:0,remainder:0};}catch(e){return{running:false,h:0,m:1,s:0,remainder:0};}};
  const saveTimerState=()=>localStorage.setItem(TIMER_K,JSON.stringify({running:timerRunning,h:parseInt(th.value||0),m:parseInt(tm.value||0),s:parseInt(ts.value||0),remainder:timerRemainingSeconds}));
  const updateTimerDisplay=()=>{const hh=String(Math.floor(timerRemainingSeconds/3600)).padStart(2,'0'),mm=String(Math.floor((timerRemainingSeconds%3600)/60)).padStart(2,'0'),ss=String(timerRemainingSeconds%60).padStart(2,'0');tdb.textContent=hh+':'+mm+':'+ss;};
  const stopTimer=()=>{if(timerInterval)clearInterval(timerInterval);timerRunning=false;tsb.textContent='启动';tb.classList.remove('active');trb.disabled=false;updateTimerDisplay();saveTimerState();};
  const startTimer=()=>{
    const h=Math.max(0,Math.min(23,parseInt(th.value||0)));const m=Math.max(0,Math.min(59,parseInt(tm.value||0)));const s=Math.max(0,Math.min(59,parseInt(ts.value||0)));
    timerTotalSeconds=h*3600+m*60+s;if(timerTotalSeconds===0 && timerRemainingSeconds===0){return; }
    if(timerRemainingSeconds===0)timerRemainingSeconds=timerTotalSeconds;
    timerRunning=true;tsb.textContent='暂停';tb.classList.add('active');trb.disabled=false;
    timerInterval=setInterval(()=>{if(timerRemainingSeconds>0){timerRemainingSeconds--;updateTimerDisplay();}else{stopTimer();timerRemainingSeconds=0;updateTimerDisplay();tdb.classList.add('completed');setTimeout(()=>tdb.classList.remove('completed'),600);document.getElementById('notifyText').innerText='⏱️ 计时器已结束';document.getElementById('notifyBar').classList.add('show');setTimeout(()=>document.getElementById('notifyBar').classList.remove('show'),5000);}saveTimerState();},1000);
    saveTimerState();
  };
  const toggleTimer=()=>{if(timerRunning){stopTimer();}else{startTimer();}};
  const resetTimer=()=>{stopTimer();timerRemainingSeconds=0;updateTimerDisplay();trb.disabled=true;saveTimerState();};
  const initTimer=()=>{
    const state=loadTimerState();
    th.value=state.h;
    tm.value=state.m;
    ts.value=state.s;
    timerRemainingSeconds=state.remainder;
    updateTimerDisplay();
    [th,tm,ts].forEach(el=>el.addEventListener('change',()=>{if(timerRunning)stopTimer();timerRemainingSeconds=0;saveTimerState();}));
    [th,tm,ts].forEach(el=>el.addEventListener('input',()=>{if(timerRunning)stopTimer();timerRemainingSeconds=0;updateTimerDisplay();saveTimerState();}));
    tsb.addEventListener('click',toggleTimer);
    trb.addEventListener('click',resetTimer);
    trb.disabled=timerRemainingSeconds===0;

    const tc=document.getElementById('timerContainer');
    if(tc){
      let active=false,sx=0,sy=0,tx=0,ty=0;
      tc.addEventListener('mousedown',e=>{
        if(e.target.tagName==='INPUT'||e.target.tagName==='BUTTON'||e.target.closest('.timer-inputs')||e.target.closest('.timer-buttons')) return;
        active=true;
        sx=e.clientX-tx;
        sy=e.clientY-ty;
        tc.style.cursor='grabbing';
        e.preventDefault();
      });
      tc.addEventListener('touchstart',e=>{
        if(e.target.tagName==='INPUT'||e.target.tagName==='BUTTON'||e.target.closest('.timer-inputs')||e.target.closest('.timer-buttons')) return;
        active=true;
        sx=e.touches[0].clientX-tx;
        sy=e.touches[0].clientY-ty;
        tc.style.cursor='grabbing';
      },{passive:true});
      document.addEventListener('mousemove',e=>{
        if(!active)return;
        tx=e.clientX-sx;
        ty=e.clientY-sy;
        tc.style.transform='translate('+tx+'px,'+ty+'px)';
      });
      document.addEventListener('touchmove',e=>{
        if(!active)return;
        tx=e.touches[0].clientX-sx;
        ty=e.touches[0].clientY-sy;
        tc.style.transform='translate('+tx+'px,'+ty+'px)';
      },{passive:false});
      const endDrag=()=>{active=false;tc.style.cursor='grab';};
      document.addEventListener('mouseup',endDrag);
      document.addEventListener('touchend',endDrag);
    }
  };
  initTimer();

  document.getElementById('wechatPlus').addEventListener('click',()=>modCounter(WECHAT_K,1,'incWechat'));
  document.getElementById('wechatMinus').addEventListener('click',()=>modCounter(WECHAT_K,-1,'incWechat'));
  document.getElementById('revisitPlus').addEventListener('click',()=>modCounter(REVISIT_K,1,'incRevisit'));
  document.getElementById('revisitMinus').addEventListener('click',()=>modCounter(REVISIT_K,-1,'incRevisit'));
  document.getElementById('syncBtn').addEventListener('click',async()=>{
    _syncStatus='syncing';updateSyncIndicator();
    calendarMonth=getCurrentMonth();
    try{await drainQueue();await saveFullState(true);await pullLatest();await syncCalendarFromCloud();refreshAll();}catch(e){_syncStatus='error';}
    updateSyncIndicator();
  });
  document.getElementById('addClientBtn').addEventListener('click',addClient);
  document.getElementById('addTodayTodoBtn').addEventListener('click',addTodayTodo);
  document.getElementById('addTodoBtn').addEventListener('click',addTodo);
  document.getElementById('todayTodoInput').addEventListener('keypress',e=>{if(e.key==='Enter')addTodayTodo();});
  document.getElementById('todoInput').addEventListener('keypress',e=>{if(e.key==='Enter')addTodo();});
  ['custName','custPhone','custCompany','custFund'].forEach(id=>document.getElementById(id).addEventListener('keypress',e=>{if(e.key==='Enter')addClient();}));
  document.getElementById('addTempCustBtn').addEventListener('click',addTempClient);
  ['tempCustName','tempCustPhone'].forEach(id=>document.getElementById(id).addEventListener('keypress',e=>{if(e.key==='Enter')addTempClient();}));

  // 白名单搜索（含防抖）
  let _wlDebounceTimer = null;
  async function searchWhitelist(query) {
    const resultEl = document.getElementById('whitelistResult');
    if (!query || !query.trim()) {
      resultEl.className = 'whitelist-result';
      resultEl.innerHTML = '';
      return;
    }
    resultEl.className = 'whitelist-result loading';
    resultEl.innerHTML = '查询中...';
    try {
      const r = await fetch('/api/whitelist/search?q=' + encodeURIComponent(query.trim()));
      const data = await r.json();
      if (data.error) {
        resultEl.className = 'whitelist-result error';
        resultEl.innerHTML = '⚠ ' + esc(data.error);
      } else if (data.result && data.result.isMatch) {
        resultEl.className = 'whitelist-result match';
        resultEl.innerHTML = '✅ 已匹配: ' + esc(data.result.matchedName || query);
      } else {
        resultEl.className = 'whitelist-result no-match';
        resultEl.innerHTML = '❌ 未在白名单中';
      }
    } catch (e) {
      resultEl.className = 'whitelist-result error';
      resultEl.innerHTML = '⚠ 查询失败';
    }
  }
  document.getElementById('whitelistSearchInput').addEventListener('input', function(e) {
    if (_wlDebounceTimer) clearTimeout(_wlDebounceTimer);
    const val = e.target.value;
    _wlDebounceTimer = setTimeout(function() { searchWhitelist(val); }, 300);
  });
  document.getElementById('whitelistSearchInput').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
      if (_wlDebounceTimer) { clearTimeout(_wlDebounceTimer); _wlDebounceTimer = null; }
      searchWhitelist(e.target.value);
    }
  });

  // 白名单管理弹窗
  document.getElementById('whitelistManageBtn').addEventListener('click', function() {
    document.getElementById('whitelistManageModal').classList.add('active');
  });
  document.getElementById('closeWhitelistManageModalBtn').addEventListener('click', function() {
    document.getElementById('whitelistManageModal').classList.remove('active');
  });
  document.getElementById('whitelistManageModal').addEventListener('click', function(e) {
    if (e.target === document.getElementById('whitelistManageModal')) {
      document.getElementById('whitelistManageModal').classList.remove('active');
    }
  });

  async function refreshWhitelistList() {
    const listEl = document.getElementById('whitelistManageList');
    const statusEl = document.getElementById('whitelistManageStatus');
    listEl.innerHTML = '加载中...';
    statusEl.innerHTML = '';
    try {
      const r = await fetch('/api/whitelist/companies');
      const data = await r.json();
      if (data.error) {
        listEl.innerHTML = '<span style="color:#e74c3c;">加载失败: ' + esc(data.error) + '</span>';
        return;
      }
      const companies = data.companies || [];
      if (companies.length === 0) {
        listEl.innerHTML = '暂无白名单企业';
        return;
      }
      listEl.innerHTML = companies.map(function(c) {
        return '<div class="whitelist-company-row">' +
          '<span>' + esc(c.company_name) + '</span>' +
          '<button class="whitelist-del-btn" data-name="' + esc(c.company_name) + '">×</button>' +
        '</div>';
      }).join('');
      // 绑定删除按钮
      listEl.querySelectorAll('.whitelist-del-btn').forEach(function(btn) {
        btn.addEventListener('click', async function() {
          const name = btn.dataset.name;
          try {
            const r = await fetch('/api/whitelist/companies', {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ company_name: name })
            });
            const d = await r.json();
            if (d.success) {
              statusEl.innerHTML = '已删除: ' + esc(name);
              refreshWhitelistList();
            } else {
              statusEl.innerHTML = '<span style="color:#e74c3c;">删除失败: ' + esc(d.error || '未知错误') + '</span>';
            }
          } catch(e) {
            statusEl.innerHTML = '<span style="color:#e74c3c;">删除失败</span>';
          }
        });
      });
      statusEl.innerHTML = '共 ' + companies.length + ' 家企业';
    } catch(e) {
      listEl.innerHTML = '<span style="color:#e74c3c;">加载失败，请检查网络</span>';
    }
  }

  document.getElementById('whitelistRefreshManageBtn').addEventListener('click', refreshWhitelistList);

  document.getElementById('whitelistUploadManageBtn').addEventListener('click', async function() {
    const textarea = document.getElementById('whitelistManageTextarea');
    const statusEl = document.getElementById('whitelistManageStatus');
    const raw = textarea.value.trim();
    if (!raw) {
      statusEl.innerHTML = '<span style="color:#e74c3c;">请粘贴企业名称后再上传</span>';
      return;
    }
    const companies = raw.split(/[\n\r]+/).map(function(s) { return s.trim(); }).filter(Boolean);
    // 去重
    const unique = [];
    const seen = new Set();
    companies.forEach(function(c) {
      if (!seen.has(c)) { seen.add(c); unique.push(c); }
    });
    if (unique.length === 0) {
      statusEl.innerHTML = '<span style="color:#e74c3c;">没有有效的企业名称</span>';
      return;
    }
    statusEl.innerHTML = '正在上传 ' + unique.length + ' 家企业...';
    try {
      const r = await fetch('/api/whitelist/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companies: unique })
      });
      const data = await r.json();
      if (data.success) {
        statusEl.innerHTML = '✅ 成功上传 ' + data.count + ' 家企业';
        textarea.value = '';
        refreshWhitelistList();
      } else {
        statusEl.innerHTML = '<span style="color:#e74c3c;">上传失败: ' + esc(data.error || '未知错误') + '</span>';
      }
    } catch(e) {
      statusEl.innerHTML = '<span style="color:#e74c3c;">上传失败，请检查网络</span>';
    }
  });

  document.getElementById('closeModalBtn').addEventListener('click',()=>document.getElementById('dateModal').classList.remove('active'));
  document.getElementById('dateModal').addEventListener('click',e=>{if(e.target===document.getElementById('dateModal'))document.getElementById('dateModal').classList.remove('active');});

  // 云端同步：自适应动态调度排空队列与数据拉取
  function scheduleNextTick(){
    if(syncTimer)clearTimeout(syncTimer);
    syncTimer=setTimeout(async function(){
      if(!document.hidden && navigator.onLine){
        try{await drainQueue();await pullLatest();}catch(e){}
      }
      scheduleNextTick();
    },PULL_INTERVAL);
  }

  window.triggerFastSync=function(){
    if(syncTimer)clearTimeout(syncTimer);
    drainQueue().then(function(){
      pullLatest().catch(function(){});
    }).finally(function(){
      scheduleNextTick();
    });
  };

  function startSyncTimer(){
    scheduleNextTick();
    // 切回标签时立即触发极速同步并刷新历史日历
    document.addEventListener('visibilitychange',function(){
      if(!document.hidden){
        window.triggerFastSync();
        syncCalendarFromCloud().then(function(){refreshAll();}).catch(function(){});
      }
    });
    // 监听网络连接状态事件，提供即时状态感知和自动重试
    window.addEventListener('online',function(){
      addSyncLog('🌐 网络已恢复，正在重试同步...');
      _syncStatus='syncing';
      updateSyncIndicator();
      window.triggerFastSync();
    });
    window.addEventListener('offline',function(){
      addSyncLog('📡 网络已断开，切换到本地离线模式');
      _syncStatus='offline';
      updateSyncIndicator();
    });
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

  // ==================== 意向客户全量表 ====================
  async function loadAllClients() {
    try {
      const r = await fetch('/api/all-clients');
      if (r.ok) {
        const data = await r.json();
        renderAllClientsTable(data);
      }
    } catch(e) {
      const local = JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
      local.sort((a,b) => (b.date||'').localeCompare(a.date||''));
      renderAllClientsTable(local);
    }
  }

  function renderAllClientsTable(clients) {
    const tbody = document.getElementById('allClientsTableBody');
    if (clients.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-light); padding: 20px;">暂无数据</td></tr>';
      return;
    }
    tbody.innerHTML = clients.map((c, idx) => {
      const company = c.company || '-';
      const fund = c.fund || '-';
      const note = c.note || '-';
      const followUp = c.followUp || '-';
      return '<tr data-date="'+esc(c.date)+'" data-name="'+esc(c.name)+'" data-phone="'+esc(c.phone)+'">'+
        '<td data-label="日期" style="padding: 10px 8px; white-space: nowrap;">'+esc(c.date)+'</td>'+
        '<td data-label="姓名" style="padding: 10px 8px; font-weight: 700;">'+esc(c.name)+'</td>'+
        '<td data-label="电话" style="padding: 10px 8px; white-space: nowrap;"><a class="client-phone" href="tel:'+esc(c.phone)+'" data-full="'+esc(c.phone)+'">'+esc(maskPhone(c.phone))+'</a><button class="phone-toggle" style="background:none;border:none;margin-left:4px;cursor:pointer;opacity:0.5;" title="显示号码">看</button></td>'+
        '<td data-label="单位" style="padding: 10px 8px;">'+esc(company)+'</td>'+
        '<td data-label="公积金" style="padding: 10px 8px;">'+esc(fund)+'</td>'+
        '<td data-label="沟通情况" style="padding: 10px 8px; min-width: 240px; max-width: 400px; word-break: break-word;"><span style="flex: 1; word-break: break-word; white-space: pre-wrap;">'+esc(note)+'</span></td>'+
        '<td data-label="跟进情况" style="padding: 10px 8px; min-width: 180px; max-width: 300px; word-break: break-word;"><span style="flex: 1; word-break: break-word; white-space: pre-wrap;">'+esc(followUp)+'</span></td>'+
        '<td data-label="操作" style="padding: 10px 8px; text-align: center; white-space: nowrap;">'+
          '<button class="export-all-single-btn" data-date="'+esc(c.date)+'" data-name="'+esc(c.name)+'" data-phone="'+esc(c.phone)+'" data-time="'+esc(c.time||'')+'" style="background:none;border:none;color:var(--accent-intent);cursor:pointer;font-size:0.9rem;font-weight:700;margin-right:6px;" title="导出">导出</button>'+
          '<button class="edit-all-client-btn" data-date="'+esc(c.date)+'" data-name="'+esc(c.name)+'" data-phone="'+esc(c.phone)+'" data-time="'+esc(c.time||'')+'" style="background:none;border:none;color:var(--accent-wechat);cursor:pointer;font-size:0.9rem;font-weight:700;margin-right:6px;" title="编辑">编辑</button>'+
        '</td>'+
      '</tr>';
    }).join('');

    tbody.querySelectorAll('.phone-toggle').forEach(b => b.addEventListener('click', e => {
      e.stopPropagation();
      const phoneSpan = b.previousElementSibling;
      const full = phoneSpan.dataset.full;
      if (phoneSpan.textContent === full) {
        phoneSpan.textContent = maskPhone(full);
        b.title = '显示号码';
        b.textContent = '看';
      } else {
        phoneSpan.textContent = full;
        b.title = '隐藏号码';
        b.textContent = '隐';
      }
    }));

    tbody.querySelectorAll('.export-all-single-btn').forEach(b => b.addEventListener('click', async e => {
      const date = b.dataset.date;
      const name = b.dataset.name;
      const phone = b.dataset.phone;
      const time = b.dataset.time;
      const c = clients.find(item => item.date === date && item.name === name && item.phone === phone && (time ? item.time === time : true));
      if (!c) return;
      const savedUrl = (localStorage.getItem('webhook_url') || '').trim();
      if (!savedUrl) {
        alert('请先在主菜单 → 导出数据 中配置企业微信 Webhook URL');
        return;
      }
      b.textContent = '发送中...';
      b.disabled = true;
      try {
        const r = await fetch('/api/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'single_client', webhookUrl: savedUrl, client: c })
        });
        if (r.ok) {
          alert('客户已成功导出到企业微信！');
        } else {
          const err = await r.json();
          alert('导出失败: ' + (err.error || r.statusText));
        }
      } catch (errVal) {
        alert('网络错误: ' + errVal.message);
      }
      b.textContent = '导出';
      b.disabled = false;
    }));

    tbody.querySelectorAll('.edit-all-client-btn').forEach(b => b.addEventListener('click', e => {
      const date = b.dataset.date;
      const name = b.dataset.name;
      const phone = b.dataset.phone;
      const time = b.dataset.time;
      const tr = b.closest('tr');
      
      const c = clients.find(item => item.date === date && item.name === name && item.phone === phone && (time ? item.time === time : true));
      if (!c) return;

      tr.innerHTML = 
        '<td data-label="日期" style="padding: 10px 8px; white-space: nowrap;">'+esc(date)+'</td>'+
        '<td data-label="姓名" style="padding: 10px 8px;"><input type="text" class="input-simple edit-name-input" style="padding: 4px 6px; font-size: 0.8rem; font-weight: 700; width: 80px;" value="'+esc(c.name)+'"></td>'+
        '<td data-label="电话" style="padding: 10px 8px;"><input type="text" class="input-simple edit-phone-input" style="padding: 4px 6px; font-size: 0.8rem; width: 110px;" value="'+esc(c.phone)+'"></td>'+
        '<td data-label="单位" style="padding: 10px 8px;"><input type="text" class="input-simple edit-company-input" style="padding: 4px 6px; font-size: 0.8rem; width: 120px;" value="'+esc(c.company||'')+'"></td>'+
        '<td data-label="公积金" style="padding: 10px 8px;"><input type="text" class="input-simple edit-fund-input" style="padding: 4px 6px; font-size: 0.8rem; width: 80px;" value="'+esc(c.fund||'')+'"></td>'+
        '<td data-label="沟通情况" style="padding: 10px 8px;"><textarea class="input-simple edit-note-input" style="padding: 4px 6px; font-size: 0.8rem; width: 100%; min-height: 80px; resize: vertical; line-height: 1.6;">'+esc(c.note||'')+'</textarea></td>'+
        '<td data-label="跟进情况" style="padding: 10px 8px;"><textarea class="input-simple edit-follow-input" style="padding: 4px 6px; font-size: 0.8rem; width: 100%; min-height: 80px; resize: vertical; line-height: 1.6;">'+esc(c.followUp||'')+'</textarea></td>'+
        '<td data-label="操作" style="padding: 10px 8px; text-align: center; white-space: nowrap;">'+
          '<button class="save-all-client-btn" style="background:none;border:none;color:var(--accent-wechat);cursor:pointer;font-size:0.9rem;font-weight:700;margin-right:6px;" title="保存">保存</button>'+
          '<button class="cancel-all-client-btn" style="background:none;border:none;color:var(--text-light);cursor:pointer;font-size:0.9rem;font-weight:700;" title="取消">取消</button>'+
        '</td>';

      // Bind Save
      tr.querySelector('.save-all-client-btn').onclick = async () => {
        const n = tr.querySelector('.edit-name-input').value.trim();
        const p = tr.querySelector('.edit-phone-input').value.trim();
        const comp = tr.querySelector('.edit-company-input').value.trim();
        const fund = tr.querySelector('.edit-fund-input').value.trim();
        const nt = tr.querySelector('.edit-note-input').value.trim();
        const fu = tr.querySelector('.edit-follow-input').value.trim();

        if(!n){alert('姓名不能为空，请填写完整！');return;}
        if(!p){alert('电话号码不能为空，请填写完整！');return;}
        if(!nt){alert('沟通记录为必填项，请填写完整！');return;}

        // 更新本地数据
        const allList = JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
        const idx = allList.findIndex(item => item.date === date && item.name === name && item.phone === phone && (time ? item.time === time : true));
        const updatedClient = {
          date: date,
          time: c.time || getCurrentTime(),
          name: n,
          phone: p,
          company: comp,
          fund: fund,
          note: nt,
          followUp: fu
        };
        if (idx !== -1) {
          allList[idx] = updatedClient;
        } else {
          allList.push(updatedClient);
        }
        localStorage.setItem(CLIENTS_K, JSON.stringify(allList));

        // 原子更新云端
        await syncOp('updateClient', { matchName: name, matchPhone: phone, matchTime: c.time||'', client: updatedClient }, date);

        loadAllClients();
        renderClientList();
        refreshAll();
      };

      // Bind Cancel
      tr.querySelector('.cancel-all-client-btn').onclick = () => {
        loadAllClients();
      };
    }));
  }

  function initAllClientsBtn() {
    document.getElementById('allClientsBtn').addEventListener('click', () => {
      loadAllClients();
      document.getElementById('allClientsModal').classList.add('active');
    });
    document.getElementById('closeAllClientsModalBtn').addEventListener('click', () => {
      document.getElementById('allClientsModal').classList.remove('active');
    });
    document.getElementById('allClientsModal').addEventListener('click', e => {
      if (e.target === document.getElementById('allClientsModal')) {
        document.getElementById('allClientsModal').classList.remove('active');
        return;
      }
      const card = document.querySelector('#allClientsModal .modal-card');
      if (card && card.contains(e.target) && !e.target.closest('button, input, textarea, a, select, label, tr')) {
        document.getElementById('allClientsModal').classList.remove('active');
      }
    });

    const addBtn = document.getElementById('allClientsAddBtn');
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        if (document.getElementById('newClientRow')) return;
        const tbody = document.getElementById('allClientsTableBody');
        const emptyTd = tbody.querySelector('td[colspan="8"]');
        if (emptyTd) {
          tbody.innerHTML = '';
        }
        const tr = document.createElement('tr');
        tr.id = 'newClientRow';
        tr.innerHTML = 
          '<td data-label="日期" style="padding: 10px 8px; white-space: nowrap;"><input type="date" class="input-simple new-date-input" style="padding: 4px 6px; font-size: 0.8rem; width: 115px;" value="' + getTodayStr() + '"></td>' +
          '<td data-label="姓名" style="padding: 10px 8px;"><input type="text" class="input-simple new-name-input" placeholder="姓名" style="padding: 4px 6px; font-size: 0.8rem; font-weight: 700; width: 80px;"></td>' +
          '<td data-label="电话" style="padding: 10px 8px;"><input type="text" class="input-simple new-phone-input" placeholder="电话" style="padding: 4px 6px; font-size: 0.8rem; width: 110px;"></td>' +
          '<td data-label="单位" style="padding: 10px 8px;"><input type="text" class="input-simple new-company-input" placeholder="单位" style="padding: 4px 6px; font-size: 0.8rem; width: 120px;"></td>' +
          '<td data-label="公积金" style="padding: 10px 8px;"><input type="text" class="input-simple new-fund-input" placeholder="公积金" style="padding: 4px 6px; font-size: 0.8rem; width: 80px;"></td>' +
          '<td data-label="沟通情况" style="padding: 10px 8px;"><textarea class="input-simple new-note-input" placeholder="沟通情况" style="padding: 4px 6px; font-size: 0.8rem; width: 100%; min-height: 80px; resize: vertical; line-height: 1.6;"></textarea></td>' +
          '<td data-label="跟进情况" style="padding: 10px 8px;"><textarea class="input-simple new-follow-input" placeholder="跟进情况" style="padding: 4px 6px; font-size: 0.8rem; width: 100%; min-height: 80px; resize: vertical; line-height: 1.6;"></textarea></td>' +
          '<td data-label="操作" style="padding: 10px 8px; text-align: center; white-space: nowrap;">' +
            '<button class="save-new-client-btn" style="background:none;border:none;color:var(--accent-wechat);cursor:pointer;font-size:0.9rem;font-weight:700;margin-right:6px;" title="保存">保存</button>' +
            '<button class="cancel-new-client-btn" style="background:none;border:none;color:var(--text-light);cursor:pointer;font-size:0.9rem;font-weight:700;" title="取消">取消</button>' +
          '</td>';
        tbody.insertBefore(tr, tbody.firstChild);

        tr.querySelector('.save-new-client-btn').onclick = async () => {
          const d = tr.querySelector('.new-date-input').value.trim();
          const n = tr.querySelector('.new-name-input').value.trim();
          const p = tr.querySelector('.new-phone-input').value.trim();
          const comp = tr.querySelector('.new-company-input').value.trim();
          const fund = tr.querySelector('.new-fund-input').value.trim();
          const nt = tr.querySelector('.new-note-input').value.trim();
          const fu = tr.querySelector('.new-follow-input').value.trim();

          if(!d){alert('请选择日期！');return;}
          if(!n){alert('姓名不能为空，请填写完整！');return;}
          if(!p){alert('电话号码不能为空，请填写完整！');return;}
          if(!nt){alert('沟通记录为必填项，请填写完整！');return;}

          const newClient = {
            name: n,
            phone: p,
            company: comp,
            fund: fund,
            note: nt,
            followUp: fu,
            date: d,
            time: getCurrentTime()
          };

          const allList = JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
          allList.push(newClient);
          localStorage.setItem(CLIENTS_K, JSON.stringify(allList));

          const countForDate = allList.filter(c => c.date === d).length;
          const im = loadMap(INTENT_K);
          im[d] = countForDate;
          saveMap(INTENT_K, im);

          await syncOp('addClient', { client: newClient }, d);

          loadAllClients();
          renderClientList();
          refreshAll();
        };

        tr.querySelector('.cancel-new-client-btn').onclick = () => {
          loadAllClients();
        };
      });
    }

    // 一键导出全量意向
    const exportBtn = document.getElementById('allClientsExportBtn');
    if (exportBtn) {
      exportBtn.addEventListener('click', async () => {
        const webhookUrl = (localStorage.getItem('webhook_url') || '').trim();
        if (!webhookUrl) { alert('请先在主菜单 → 导出数据 中配置企业微信 Webhook URL'); return; }
        exportBtn.textContent = '发送中...';
        exportBtn.disabled = true;
        try {
          const r = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'all_clients', webhookUrl }) });
          if (r.ok) { alert('已发送到企业微信'); }
          else {
            try { const err = await r.json(); alert('发送失败: ' + (err.error || r.statusText)); }
            catch(_) { alert('发送失败，请检查 Webhook URL'); }
          }
        } catch(e) { alert('网络错误: ' + e.message); }
        exportBtn.textContent = '导出';
        exportBtn.disabled = false;
      });
    }
  }

  initAndroid();initLogs();initDark();initWp();initScriptFeature();initLearnFeature();initExport();initAllClientsBtn();initGoals();
  document.getElementById('goalEyeBtn').addEventListener('click',toggleGoalNumbers);
  function calGo(delta){
    const [y,m]=calendarMonth.split('-').map(Number);
    const d=new Date(y,m-1+delta,1);
    calendarMonth=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');
    syncCalendarFromCloud().then(()=>refreshAll());
  }
  document.getElementById('calPrevBtn').addEventListener('click',()=>calGo(-1));
  document.getElementById('calNextBtn').addEventListener('click',()=>calGo(1));
  // 菜单下拉
  (function(){
    const toggle=document.getElementById('menuToggleBtn');
    const dropdown=document.getElementById('menuDropdown');
    toggle.addEventListener('click',e=>{e.stopPropagation();dropdown.classList.toggle('show');});
    document.addEventListener('click',e=>{if(!dropdown.contains(e.target)&&e.target!==toggle)dropdown.classList.remove('show');});
    dropdown.querySelectorAll('.menu-item').forEach(item=>item.addEventListener('click',()=>dropdown.classList.remove('show')));
  })();
  const UNLOCK_TS_K='unlock_ts';
  if((Date.now()-parseInt(localStorage.getItem(UNLOCK_TS_K)||'0'))<3600000){setLocked(false);}else{setLocked(true);}

  // 首次加载：先补发上次未完成的操作，再从云端拉取最新状态
  (async()=>{
    // 1. 先补发上次关页前没有发成功的操作（Office 式離线队列）
    await drainQueue();
    // 2. 再拉取云端最新状态
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
          const transferred2=yd.tomorrowTodos.map(t=>({...(typeof t==='string'?{text:t}:t),date:todayStr}));
          saveTodos(TODAY_TODO_K,[...transferred2,...cur]);
          saveTodos(TOMORROW_TODO_K,[]);
          transferred=true;
          console.log('📅 已从云端转移昨日待办到今日');
        }
      }catch(e){}
      if(!transferred){
        const tomorrow=loadTodos(TOMORROW_TODO_K);
        if(tomorrow.length>0){
          const cur=loadTodos(TODAY_TODO_K);
          const transferred3=tomorrow.map(t=>({...(typeof t==='string'?{text:t}:t),date:todayStr}));
          saveTodos(TODAY_TODO_K,[...transferred3,...cur]);
          saveTodos(TOMORROW_TODO_K,[]);
          console.log('📅 已转移本地昨日待办到今日');
        }
      }
    }
    localStorage.setItem(LAST_LOAD_DATE_K,todayStr);
    calendarMonth=getCurrentMonth();
    await syncCalendarFromCloud();
    renderLockScripts();renderLockLearns();
    refreshAll();
    startSyncTimer();
  })();

  setInterval(()=>{if(!document.body.classList.contains('page-hidden')&&!document.hidden)refreshAll();},60000);

  // 页面即将关闭时用 sendBeacon 兜底保存（keepalive 保证关闭后仍能发出）
  // 注意：不在 visibilitychange 时调用 saveFullState，避免设备 B 切标签时
  // 用陈旧的本地数据覆盖云端（设备 A 刚同步上去的数据）
  window.addEventListener('beforeunload',()=>{
    const today=getTodayStr();
    const wm=loadMap(WECHAT_K);
    const rm=loadMap(REVISIT_K);
    const vm=loadMap(VISIT_K);
    const pm=loadMap(PAYMENT_K);
    const allClients=JSON.parse(localStorage.getItem(CLIENTS_K)||'[]');
    const todayClients=allClients.filter(c=>c.date===today);
    const payload=JSON.stringify({
      date:today,
      wechatCount:wm[today]||0,
      intentCount:todayClients.length,
      revisitCount:rm[today]||0,
      visitCount:vm[today]||0,
      paymentCount:pm[today]||0,
      clients:todayClients,
      todayTodos:loadTodos(TODAY_TODO_K).filter(t=>(typeof t==='string'?today:(t.date||today))===today),
      tomorrowTodos:loadTodos(TOMORROW_TODO_K).filter(t=>(typeof t==='string'?today:(t.date||today))===today),
      tempClients:JSON.parse(localStorage.getItem(TEMP_CLIENTS_K)||'[]'),
      scripts:loadScripts(),
      learns:loadLearns(),
      _ts:Date.now()
    });
    navigator.sendBeacon('/api/data',new Blob([payload],{type:'application/json'}));
  });
})();
</script>
</body>
</html>`;

    // ========== 白名单 API（基于 Supabase） ==========

    // 上传白名单企业（批量 upsert）
    if (path === '/api/whitelist/upload' && request.method === 'POST') {
      try {
        const body = await request.json();
        const companies = body.companies;
        if (!Array.isArray(companies) || companies.length === 0) {
          return new Response(JSON.stringify({ error: '请提供 companies 数组' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        if (companies.length > 5000) {
          return new Response(JSON.stringify({ error: '单次最多上传 5000 家企业' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        const result = await supabase.upsertCompanies(companies);
        return new Response(JSON.stringify({ success: true, count: result.count }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 获取所有白名单企业
    if (path === '/api/whitelist/companies' && request.method === 'GET') {
      try {
        const companies = await supabase.getAllCompanies();
        return new Response(JSON.stringify({ companies: companies }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 检查客户单位是否在白名单
    if (path === '/api/whitelist/check' && request.method === 'POST') {
      try {
        const body = await request.json();
        const companies = body.companies;
        if (!Array.isArray(companies)) {
          return new Response(JSON.stringify({ error: '请提供 companies 数组' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        const results = await supabase.checkCompanies(companies);
        return new Response(JSON.stringify({ results: results }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 搜索白名单企业（GET 快速查询）
    if (path === '/api/whitelist/search' && request.method === 'GET') {
      const q = url.searchParams.get('q');
      if (!q || !q.trim()) {
        return new Response(JSON.stringify({ result: { company: '', isMatch: false, matchedName: null } }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
      try {
        const results = await supabase.checkCompanies([q.trim()]);
        return new Response(JSON.stringify({ result: results[0] }), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 删除白名单企业
    if (path === '/api/whitelist/companies' && request.method === 'DELETE') {
      try {
        const body = await request.json();
        const companyName = body.company_name;
        if (!companyName || !companyName.trim()) {
          return new Response(JSON.stringify({ error: '请提供 company_name' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }
        const result = await supabase.deleteCompany(companyName);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // 返回 HTML 页面
    return new Response(HTML, {
      headers: { 'Content-Type': 'text/html; charset=UTF-8' }
    });
  }
};
