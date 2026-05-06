const DEFAULT_PIN = '8520';

function getDeviceId(request) {
  const url = new URL(request.url);
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
  const userAgent = request.headers.get('User-Agent') || '';
  return url.searchParams.get('device') || btoa(clientIP + userAgent).slice(0, 32);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const device = getDeviceId(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (path === '/api/data' && request.method === 'GET') {
      try {
        const raw = await env.DATA_KV.get(device);
        const data = raw ? JSON.parse(raw) : {
          wechat: {},
          intent: {},
          clients: [],
          memo: '',
          todayTodo: [],
          tomorrowTodo: [],
          darkMode: false,
          lastReset: ''
        };
        return new Response(JSON.stringify({ success: true, data }), { headers: corsHeaders() });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: corsHeaders() });
      }
    }

    if (path === '/api/data' && request.method === 'POST') {
      try {
        const body = await request.json();
        if (body.pin !== DEFAULT_PIN) {
          return new Response(JSON.stringify({ success: false, error: 'PIN错误' }), { status: 403, headers: corsHeaders() });
        }
        await env.DATA_KV.put(device, JSON.stringify(body.data));
        return new Response(JSON.stringify({ success: true }), { headers: corsHeaders() });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: corsHeaders() });
      }
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders() });
  }
};
