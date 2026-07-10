// Hybrid data store: KV for app data, Supabase REST API for dialer customers
// Non-dialer features (knowledge, whitelist, etc.) use KV
// Dialer customer CRUD uses Supabase PostgREST directly

export function createSupabaseClient(env) {
  const kv = env.DATA_KV;
  const baseUrl = env.SUPABASE_URL;
  const key = env.SUPABASE_KEY;

  if (!baseUrl || !key) {
    console.warn('[supabase] SUPABASE_URL or SUPABASE_KEY not configured. Dialer CRUD will be no-ops.');
  }

  function headers() {
    return {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': 'Bearer ' + key,
      'Prefer': 'return=minimal'
    };
  }

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

  // ========== Customer CRUD (Supabase PostgREST) ==========

  /**
   * Get all customers with pagination and optional search.
   */
  async function getAllCustomers(page, pageSize, search, sortBy, sortDir, category, batchLabel, excludeMobiles, accountId) {
    if (!baseUrl || !key) return { data: [], total: 0, page: page || 1, pageSize: pageSize || 50 };

    try {
      var p = page || 1;
      var ps = pageSize || 50;

      var baseSearch = '';
      if (search) {
        baseSearch = '&or=(name.ilike.%25' + encodeURIComponent(search) + '%25,mobile.ilike.%25' + encodeURIComponent(search) + '%25,company_name.ilike.%25' + encodeURIComponent(search) + '%25)';
      }

      // Exclude cooldown mobiles (cap at 100 to keep URL within limits)
      var excludeFilter = '';
      if (excludeMobiles && Array.isArray(excludeMobiles) && excludeMobiles.length > 0) {
        var capped = excludeMobiles.slice(0, 100);
        excludeFilter = '&mobile=not.in.(' + capped.map(function(m) { return encodeURIComponent(m); }).join(',') + ')';
      }

      // Account filter: if accountId provided, restrict to that account
      // Master accounts pass empty accountId to see all data
      var accountFilter = '';
      if (accountId) {
        accountFilter = '&account_id=eq.' + encodeURIComponent(accountId);
      }

      var filterParams = '';
      if (category) {
        if (category === '线索池') {
          filterParams += '&or=(category.eq.待跟进,category.eq.潜在客户,category.is.null,category.eq.,category.eq.未分类)';
        } else if (category === '公海客户') {
          filterParams += '&or=(category.eq.公海客户,category.eq.其他)';
        } else {
          filterParams += '&category=eq.' + encodeURIComponent(category);
        }
      }
      if (batchLabel) {
        filterParams += '&batch_label=eq.' + encodeURIComponent(batchLabel);
      }

      // Build sort clause
      var orderClause = '&order=created_at.desc';
      if (sortBy) {
        var dir = (sortDir === 'asc' ? 'asc' : 'desc');
        orderClause = '&order=' + encodeURIComponent(sortBy) + '.' + dir;
        if (sortBy !== 'created_at') {
          orderClause += ',created_at.desc';
        }
      }

      // Try column sets from most to least specific
      var colSets = [
        'name,mobile,company_name,category,note,batch_label,created_at,last_operation,pulled_at,account_id',
        'name,mobile,company_name,category,note,created_at,last_operation,pulled_at,account_id',
        'name,mobile,company_name,category,note,batch_label,created_at,account_id',
        'name,mobile,company_name,category,note,created_at,account_id',
        'name,mobile,company_name,created_at,account_id',
        '*'
      ];

      var SUPABASE_MAX = 1000;
      var allData = [];
      var totalCount = 0;
      var from = (p - 1) * ps;
      var currentFrom = from;

      while (true) {
        var currentTo = currentFrom + SUPABASE_MAX - 1;
        var headersWithCount = Object.assign({}, headers(), {
          'Range': currentFrom + '-' + currentTo,
          'Prefer': 'count=exact'
        });

        var resp = null;
        var batch = null;

        for (var ci = 0; ci < colSets.length; ci++) {
          var url2 = baseUrl + '/rest/v1/customers?select=' + colSets[ci] + orderClause + baseSearch + excludeFilter + accountFilter + filterParams;
          resp = await fetch(url2, { headers: headersWithCount });
          if (resp.ok) {
            batch = await resp.json();
            break;
          }
        }

        if (!batch || !Array.isArray(batch)) break;

        allData = allData.concat(batch);

        var contentRange = resp.headers.get('Content-Range');
        if (contentRange) {
          var parts = contentRange.split('/');
          if (parts.length === 2) totalCount = parseInt(parts[1], 10) || totalCount;
        }

        if (batch.length < SUPABASE_MAX) break;
        currentFrom += SUPABASE_MAX;
      }

      if (allData.length === 0) {
        console.error('[supabase] getAllCustomers failed, returning empty');
        return { data: [], total: 0, page: p, pageSize: ps };
      }

      return { data: allData, total: totalCount || allData.length, page: p, pageSize: ps };
    } catch (e) {
      console.error('[supabase] getAllCustomers error:', e.message);
      return { data: [], total: 0, page: page || 1, pageSize: pageSize || 50 };
    }
  }

  /**
   * Upsert customers into Supabase. Uses mobile as unique key (on_conflict=mobile).
   */
  async function upsertCustomers(customers, accountId) {
    if (!baseUrl || !key) return { count: 0, error: 'Supabase not configured' };
    if (!Array.isArray(customers) || customers.length === 0) return { count: 0 };

    var acctId = accountId || null;
    var rows = customers.map(function(c) {
      var noteVal = (c.note || '').trim();
      var callNoteVal = (c.callNote || '').trim();
      if (callNoteVal) {
        var marker = '[通话小记] ' + callNoteVal;
        if (noteVal.indexOf(marker) === -1) {
          if (noteVal) { noteVal += '\n' + marker; }
          else { noteVal = marker; }
        }
      }

      var fundVal = (c.fund || '').trim();
      if (fundVal) {
        if (noteVal.indexOf('{') === 0) {
          try {
            var obj = JSON.parse(noteVal);
            if (obj && typeof obj === 'object') { obj.fund = fundVal; noteVal = JSON.stringify(obj); }
          } catch (e) { noteVal = JSON.stringify({ note: noteVal, fund: fundVal }); }
        } else {
          noteVal = JSON.stringify({ note: noteVal, fund: fundVal });
        }
      }

      return {
        name: (c.name || '').trim() || '未知姓名',
        mobile: (c.mobile || c.phone || '').trim(),
        company_name: (c.company || c.company_name || '').trim(),
        note: noteVal,
        category: (c.category || '').trim() || '公海客户',
        batch_label: (c.batch_label || '').trim(),
        account_id: c.account_id || acctId
      };
    }).filter(function(r) { return r.mobile.length > 0; });

    // Deduplicate by mobile
    var uniqueMap = {};
    rows.forEach(function(row) { uniqueMap[row.mobile] = row; });
    var uniqueRows = [];
    for (var m in uniqueMap) {
      if (uniqueMap.hasOwnProperty(m)) { uniqueRows.push(uniqueMap[m]); }
    }

    if (uniqueRows.length === 0) return { count: 0 };

    // Cross-account protection: check existing mobile owners
    var skippedForeignCount = 0;
    if (acctId) {
      try {
        var existingMobiles = {};
        var allMobiles = Object.keys(uniqueMap);
        for (var mi = 0; mi < allMobiles.length; mi += 100) {
          var mobileChunk = allMobiles.slice(mi, mi + 100);
          var inFilter = 'mobile=in.(' + mobileChunk.map(function(m) { return encodeURIComponent(m); }).join(',') + ')';
          var checkUrl = baseUrl + '/rest/v1/customers?select=mobile,account_id&' + inFilter;
          var checkResp = await fetch(checkUrl, { headers: headers() });
          if (checkResp.ok) {
            var checkData = await checkResp.json();
            if (Array.isArray(checkData)) {
              for (var ci = 0; ci < checkData.length; ci++) {
                existingMobiles[checkData[ci].mobile] = checkData[ci].account_id;
              }
            }
          }
        }
        var safeRows = [];
        for (var ri = 0; ri < uniqueRows.length; ri++) {
          var rowMobile = uniqueRows[ri].mobile;
          var existingOwner = existingMobiles[rowMobile];
          if (existingOwner && existingOwner !== acctId) {
            skippedForeignCount++;
            console.warn('[supabase] Skipping mobile ' + rowMobile.slice(0, 3) + '**** — owned by ' + existingOwner);
          } else {
            safeRows.push(uniqueRows[ri]);
          }
        }
        uniqueRows = safeRows;
      } catch (preCheckErr) {
        console.warn('[supabase] Pre-check for cross-account owners failed:', preCheckErr.message);
      }
    }

    if (uniqueRows.length === 0) {
      console.warn('[supabase] All ' + skippedForeignCount + ' mobiles owned by other accounts — nothing to upsert');
      return { count: 0, skipped: skippedForeignCount };
    }

    var count = 0;
    var batchSize = 500;
    for (var i = 0; i < uniqueRows.length; i += batchSize) {
      var chunk = uniqueRows.slice(i, i + batchSize);
      var resp = await fetch(baseUrl + '/rest/v1/customers?on_conflict=mobile', {
        method: 'POST',
        headers: Object.assign({}, headers(), { 'Prefer': 'resolution=merge-duplicates' }),
        body: JSON.stringify(chunk)
      });

      if (!resp.ok) {
        var text = await resp.text();
        if (text.indexOf('fund') !== -1 && text.indexOf('column') !== -1) {
          var fallbackRows = chunk.map(function(r) { var copy = Object.assign({}, r); delete copy.fund; return copy; });
          var fbResp = await fetch(baseUrl + '/rest/v1/customers?on_conflict=mobile', {
            method: 'POST',
            headers: Object.assign({}, headers(), { 'Prefer': 'resolution=merge-duplicates' }),
            body: JSON.stringify(fallbackRows)
          });
          if (!fbResp.ok) {
            var fbText = await fbResp.text();
            throw new Error('Supabase upsert customers fallback failed [' + fbResp.status + ']: ' + fbText);
          }
        } else if (text.indexOf('batch_label') !== -1 && text.indexOf('column') !== -1) {
          var fallbackRows2 = chunk.map(function(r) { var copy = Object.assign({}, r); delete copy.batch_label; delete copy.note; return copy; });
          var fbResp2 = await fetch(baseUrl + '/rest/v1/customers?on_conflict=mobile', {
            method: 'POST',
            headers: Object.assign({}, headers(), { 'Prefer': 'resolution=merge-duplicates' }),
            body: JSON.stringify(fallbackRows2)
          });
          if (!fbResp2.ok) {
            var fbText2 = await fbResp2.text();
            throw new Error('Supabase upsert customers failed [' + fbResp2.status + ']: ' + fbText2);
          }
        } else {
          throw new Error('Supabase upsert customers failed [' + resp.status + ']: ' + text);
        }
      }
      count += chunk.length;
    }

    return { count: count, skipped: skippedForeignCount || 0 };
  }

  /**
   * Batch update category for all customers with a given batch_label.
   */
  async function batchUpdateCategory(batchLabel, category, accountId) {
    if (!baseUrl || !key) throw new Error('Supabase not configured');
    if (!batchLabel || !category) throw new Error('batch_label and category required');

    var acctFilter = '';
    if (accountId) {
      acctFilter = '&account_id=eq.' + encodeURIComponent(accountId);
    }

    // Fetch all matching mobiles
    var allMobiles = [];
    var offset = 0;
    var pageSz = 1000;
    while (true) {
      var url2 = baseUrl + '/rest/v1/customers?select=mobile&batch_label=eq.' + encodeURIComponent(batchLabel) + acctFilter + '&limit=' + pageSz + '&offset=' + offset;
      var pageResp = await fetch(url2, { headers: headers() });
      if (!pageResp.ok) {
        var text = await pageResp.text();
        throw new Error('Batch query failed [' + pageResp.status + ']: ' + text);
      }
      var page = await pageResp.json();
      if (!Array.isArray(page) || page.length === 0) break;
      allMobiles.push.apply(allMobiles, page.map(function(r) { return r.mobile; }));
      if (page.length < pageSz) break;
      offset += pageSz;
    }

    if (allMobiles.length === 0) return { count: 0 };

    // PATCH each one
    var updated = 0;
    for (var i = 0; i < allMobiles.length; i++) {
      var patchUrl = baseUrl + '/rest/v1/customers?mobile=eq.' + encodeURIComponent(allMobiles[i]);
      if (accountId) {
        patchUrl += '&account_id=eq.' + encodeURIComponent(accountId);
      }
      var patchResp = await fetch(patchUrl, {
        method: 'PATCH',
        headers: Object.assign({}, headers(), { 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ category: category })
      });
      if (patchResp.ok) updated++;
    }

    return { count: updated };
  }

  /**
   * Get customers for dialer batch pull using pulled_at ordering.
   * Never-pulled customers come first (newest first), then oldest-pulled cycle back.
   */
  async function getCustomersForDialer(limit, excludeMobiles, accountId) {
    if (!baseUrl || !key) return { data: [], total: 0 };

    try {
      var lim = Math.min(limit || 50, 200);

      // Build mobile not.in filter
      var notInFilter = '';
      if (excludeMobiles && excludeMobiles.length > 0) {
        var uniqueMobiles = [];
        for (var ei = 0; ei < excludeMobiles.length; ei++) {
          var m = (excludeMobiles[ei] || '').trim();
          if (m && uniqueMobiles.indexOf(m) === -1) uniqueMobiles.push(m);
        }
        if (uniqueMobiles.length > 0) {
          notInFilter = '&mobile=not.in.(' + uniqueMobiles.map(function(m) { return encodeURIComponent(m); }).join(',') + ')';
        }
      }

      // Account filter: if accountId provided, restrict to that account
      // Master accounts pass empty accountId to see all data
      var accountFilter = '';
      if (accountId) {
        accountFilter = '&account_id=eq.' + encodeURIComponent(accountId);
      }

      // 10-day cooldown via pulled_at
      var cooldownDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      var cooldownFilter = '&or=(pulled_at.is.null,pulled_at.lt.' + encodeURIComponent(cooldownDate) + ')';

      // Order: never-pulled first (nulls first), then oldest-pulled ascend
      var orderFilter = '&order=pulled_at.asc.nullsfirst,created_at.desc';

      var colSets = [
        'name,mobile,company_name,category,note,batch_label,created_at,last_operation,pulled_at,account_id',
        'name,mobile,company_name,category,note,created_at,last_operation,pulled_at,account_id',
        'name,mobile,company_name,category,note,batch_label,created_at,pulled_at,account_id',
        'name,mobile,company_name,category,note,created_at,pulled_at,account_id',
        'name,mobile,company_name,created_at,pulled_at,account_id',
        '*'
      ];

      var hdrs = Object.assign({}, headers(), {
        'Range': '0-' + (lim - 1),
        'Prefer': 'count=exact'
      });

      var data = null;
      var resp = null;
      for (var ci = 0; ci < colSets.length; ci++) {
        var qUrl = baseUrl + '/rest/v1/customers?select=' + colSets[ci] + orderFilter + cooldownFilter + accountFilter + notInFilter;
        resp = await fetch(qUrl, { headers: hdrs });
        if (resp.ok) {
          data = await resp.json();
          break;
        }
      }

      var totalCount = 0;
      if (resp) {
        var contentRange = resp.headers.get('Content-Range');
        if (contentRange) {
          var parts = contentRange.split('/');
          if (parts.length === 2) totalCount = parseInt(parts[1], 10) || 0;
        }
      }

      return {
        data: Array.isArray(data) ? data : [],
        total: totalCount,
        limit: lim
      };
    } catch (e) {
      console.error('[supabase] getCustomersForDialer error:', e.message);
      return { data: [], total: 0, error: e.message };
    }
  }

  /**
   * Batch-update pulled_at = NOW() for customers just loaded into the dialer.
   */
  async function batchSetPulledAt(mobiles, accountId) {
    if (!baseUrl || !key) return;
    if (!mobiles || mobiles.length === 0) return;

    try {
      var uniqueMobiles = [];
      for (var i = 0; i < mobiles.length; i++) {
        var m = (mobiles[i] || '').trim();
        if (m && uniqueMobiles.indexOf(m) === -1) uniqueMobiles.push(m);
      }
      if (uniqueMobiles.length === 0) return;

      var inFilter = 'mobile=in.(' + uniqueMobiles.map(function(m) { return encodeURIComponent(m); }).join(',') + ')';
      var qUrl = baseUrl + '/rest/v1/customers?' + inFilter;
      if (accountId) {
        qUrl += '&account_id=eq.' + encodeURIComponent(accountId);
      }
      var body = JSON.stringify({ pulled_at: new Date().toISOString() });

      var resp = await fetch(qUrl, {
        method: 'PATCH',
        headers: Object.assign({}, headers(), {
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        }),
        body: body
      });
      if (!resp.ok) {
        var errText = '';
        try { errText = await resp.text(); } catch(_) {}
        console.error('[supabase] batchSetPulledAt PATCH failed: HTTP ' + resp.status + ' — ' + errText.slice(0, 300));
      }
    } catch (e) {
      console.error('[supabase] batchSetPulledAt error:', e.message);
    }
  }

  /**
   * Update a single customer by mobile.
   */
  async function updateCustomer(mobile, fields, accountId) {
    if (!baseUrl || !key) return null;
    if (!mobile) return null;

    try {
      var updateUrl = baseUrl + '/rest/v1/customers?mobile=eq.' + encodeURIComponent(mobile);
      if (accountId) {
        updateUrl += '&account_id=eq.' + encodeURIComponent(accountId);
      }
      var resp = await fetch(updateUrl, {
        method: 'PATCH',
        headers: Object.assign({}, headers(), { 'Prefer': 'return=representation' }),
        body: JSON.stringify(fields)
      });

      if (!resp.ok) {
        var text = await resp.text();
        throw new Error('Supabase update customer failed [' + resp.status + ']: ' + text);
      }

      var data = await resp.json();
      return data && data[0] ? data[0] : null;
    } catch (e) {
      console.error('[supabase] updateCustomer error:', e.message);
      return null;
    }
  }

  async function deleteCustomer(mobile, accountId) {
    if (!baseUrl || !key) return { success: false, error: 'Supabase not configured' };
    if (!mobile) return { success: false, error: 'mobile is required' };

    try {
      var delUrl = baseUrl + '/rest/v1/customers?mobile=eq.' + encodeURIComponent(mobile);
      if (accountId) {
        delUrl += '&account_id=eq.' + encodeURIComponent(accountId);
      }
      var resp = await fetch(delUrl, { method: 'DELETE', headers: headers() });

      if (!resp.ok) {
        var text = await resp.text();
        throw new Error('Supabase delete customer failed [' + resp.status + ']: ' + text);
      }
      return { success: true };
    } catch (e) {
      console.error('[supabase] deleteCustomer error:', e.message);
      return { success: false, error: e.message };
    }
  }

  async function deleteCustomers(mobiles, accountId) {
    if (!baseUrl || !key) return { success: false, error: 'Supabase not configured' };
    if (!mobiles || mobiles.length === 0) return { success: false, error: 'mobiles are required' };

    try {
      var acctFilter = '';
      if (accountId) {
        acctFilter = '&account_id=eq.' + encodeURIComponent(accountId);
      }

      var chunkSize = 100;
      for (var i = 0; i < mobiles.length; i += chunkSize) {
        var chunk = mobiles.slice(i, i + chunkSize);
        var inClause = chunk.map(function(m) { return encodeURIComponent(m); }).join(',');
        var delUrl = baseUrl + '/rest/v1/customers?mobile=in.(' + inClause + ')' + acctFilter;
        var resp = await fetch(delUrl, { method: 'DELETE', headers: headers() });
        if (!resp.ok) {
          var text = await resp.text();
          throw new Error('Supabase batch delete failed [' + resp.status + ']: ' + text);
        }
      }
      return { success: true };
    } catch (e) {
      console.error('[supabase] deleteCustomers error:', e.message);
      return { success: false, error: e.message };
    }
  }

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
