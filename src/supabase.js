// KV-based data store (replaces Supabase)
// All data stored in Cloudflare Workers KV

export function createSupabaseClient(env) {
  const kv = env.DATA_KV;

  async function readJSON(key) {
    try { const raw = await kv.get(key); return raw ? JSON.parse(raw) : []; }
    catch (e) { return []; }
  }

  async function writeJSON(key, data) {
    await kv.put(key, JSON.stringify(data));
  }

  // ========== Knowledge Base ==========

  async function saveKnowledge(item) {
    if (!kv) return { success: false };
    const items = await readJSON('kb:knowledge');
    items.unshift({ ...item, created_at: new Date().toISOString() });
    if (items.length > 1000) items.length = 1000;
    await writeJSON('kb:knowledge', items);
    return { success: true };
  }

  async function searchKnowledge(query) {
    if (!kv || !query) return [];
    const items = await readJSON('kb:knowledge');
    const q = query.toLowerCase();
    return items.filter(i => (i.title || '').toLowerCase().includes(q) || (i.content || '').toLowerCase().includes(q)).slice(0, 10);
  }

  async function searchSpeech(query) {
    if (!kv || !query) return [];
    const items = await readJSON('kb:speech');
    const q = query.toLowerCase();
    return items.filter(i => (i.title || '').toLowerCase().includes(q) || (i.content || '').toLowerCase().includes(q)).slice(0, 10);
  }

  async function searchLoanCases(query) {
    if (!kv || !query) return [];
    const items = await readJSON('kb:loancases');
    const q = query.toLowerCase();
    return items.filter(i => (i.title || '').toLowerCase().includes(q) || (i.content || '').toLowerCase().includes(q)).slice(0, 10);
  }

  // ========== Whitelist Companies ==========

  async function checkCompanies(names) {
    if (!kv || !names || names.length === 0) return [];
    const companies = await readJSON('config:whitelist_companies');
    return names.map(name => {
      const match = companies.find(c => (c.company_name || '').includes(name) || name.includes(c.company_name || ''));
      return match ? { matchedName: match.company_name, isMatch: true, bank_name: match.bank_name || '建行建易贷', status: match.status || '正常' }
        : { matchedName: name, isMatch: false, bank_name: '', status: '未准入' };
    });
  }

  async function upsertCompanies(companies) {
    if (!kv || !Array.isArray(companies) || companies.length === 0) return { count: 0 };
    const existing = await readJSON('config:whitelist_companies');
    const names = new Set(existing.map(c => c.company_name));
    let added = 0;
    companies.forEach(c => {
      const name = (typeof c === 'string' ? c : c.company_name || '').trim();
      if (name && !names.has(name)) {
        existing.push(typeof c === 'string' ? { company_name: name, bank_name: '建行建易贷', status: '正常' } : c);
        names.add(name);
        added++;
      }
    });
    await writeJSON('config:whitelist_companies', existing);
    return { count: added };
  }

  async function getAllCompanies() {
    return await readJSON('config:whitelist_companies');
  }

  // ========== Customer Search ==========

  async function searchCustomers(query) {
    if (!kv || !query) return [];
    const allClients = [];
    const list = await kv.list({ prefix: 'work:' });
    const keys = (list && list.keys) ? list.keys.slice(-90) : []; // last 90 days
    for (const k of keys) {
      try {
        const raw = await kv.get(k.name);
        if (!raw) continue;
        const data = JSON.parse(raw);
        const clients = data.clients || [];
        const q = query.toLowerCase();
        clients.forEach(c => {
          if ((c.name || '').toLowerCase().includes(q) || (c.phone || '').includes(query) || (c.company || '').toLowerCase().includes(q)) {
            allClients.push({ ...c, date: data.date || k.name.replace('work:', '') });
          }
        });
      } catch (e) { /* skip */ }
    }
    return allClients.slice(0, 50);
  }

  // ========== Customer CRUD (stubs — dialer moved to bhp) ==========

  async function getAllCustomers() { return { data: [], total: 0 }; }
  async function getCustomersForDialer() { return { data: [], total: 0 }; }
  async function upsertCustomers() { return { count: 0 }; }
  async function batchSetPulledAt() { }
  async function updateCustomer() { return null; }
  async function deleteCustomer() { return { success: true }; }
  async function deleteCustomers() { return { success: true }; }
  async function batchUpdateCategory() { return { count: 0 }; }

  // ========== OCR Corrections ==========

  async function getCorrectionsCount() {
    if (!kv) return 0;
    try {
      const raw = await kv.get('correction:count');
      return raw ? parseInt(raw, 10) : 0;
    } catch (e) { return 0; }
  }

  return {
    saveKnowledge, searchKnowledge, searchSpeech, searchLoanCases,
    checkCompanies, upsertCompanies, getAllCompanies,
    searchCustomers, getAllCustomers, getCustomersForDialer,
    upsertCustomers, batchSetPulledAt, updateCustomer,
    deleteCustomer, deleteCustomers, batchUpdateCategory,
    getCorrectionsCount
  };
}
