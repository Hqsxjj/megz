// Supabase REST API helper for Cloudflare Workers
// Uses fetch() directly to avoid SDK compatibility issues

export function createSupabaseClient(env) {
  const baseUrl = env.SUPABASE_URL;
  const key = env.SUPABASE_KEY;

  if (!baseUrl || !key) {
    console.warn('[supabase] SUPABASE_URL or SUPABASE_KEY not configured. All operations will be no-ops.');
  }

  function headers() {
    return {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': 'Bearer ' + key,
      'Prefer': 'return=minimal'
    };
  }

  /**
   * Upsert companies into the whitelist.
   * Accepts array of strings or array of { company_name, alias? } objects.
   * Uses resolution=merge-duplicates to upsert by unique company_name.
   */
  async function upsertCompanies(companies) {
    if (!baseUrl || !key) throw new Error('Supabase not configured');
    if (!Array.isArray(companies) || companies.length === 0) {
      return { count: 0 };
    }

    // Normalize: accept both string[] and object[]
    const rows = companies.map(function(c) {
      if (typeof c === 'string') {
        return { company_name: c.trim(), bank_name: '建行建易贷', status: '正常' };
      }
      return {
        company_name: (c.company_name || '').trim(),
        alias: c.alias || null,
        bank_name: c.bank_name || '建行建易贷',
        status: c.status || '正常'
      };
    }).filter(function(r) {
      return r.company_name.length > 0;
    });

    if (rows.length === 0) return { count: 0 };

    let count = 0;
    const batchSize = 1000;
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      const resp = await fetch(baseUrl + '/rest/v1/whitelist_companies?on_conflict=company_name', {
        method: 'POST',
        headers: Object.assign({}, headers(), {
          'Prefer': 'resolution=merge-duplicates'
        }),
        body: JSON.stringify(chunk)
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error('Supabase upsert failed [' + resp.status + ']: ' + text);
      }
      count += chunk.length;
    }

    return { count: count };
  }

  /**
   * Get all whitelist companies, sorted by company_name.
   */
  async function getAllCompanies() {
    if (!baseUrl || !key) return [];

    var all = [];
    var page = 0;
    var pageSize = 1000;

    while (true) {
      var from = page * pageSize;
      var to = from + pageSize - 1;

      var resp = await fetch(
        baseUrl + '/rest/v1/whitelist_companies?select=id,company_name,alias,bank_name,status,created_at&order=company_name.asc',
        {
          headers: Object.assign({}, headers(), {
            'Range': from + '-' + to
          })
        }
      );

      if (!resp.ok) {
        var text = await resp.text();
        throw new Error('Supabase query failed [' + resp.status + ']: ' + text);
      }

      var data = await resp.json();
      if (!Array.isArray(data) || data.length === 0) {
        break;
      }

      all.push.apply(all, data);

      if (data.length < pageSize) {
        break;
      }

      page++;
    }

    return all;
  }

  /**
   * Check client company names against the whitelist.
   * Returns match results with case-insensitive comparison.
   */
  async function checkCompanies(companyNames) {
    if (!baseUrl || !key) throw new Error('Supabase not configured');

    // Fetch the full whitelist (efficient for typical sizes <10000 entries)
    const whitelist = await getAllCompanies();

    // Build a Set of lowercased company names for O(1) lookup
    var lookup = {};
    whitelist.forEach(function(entry) {
      if (entry.status === '已失效' || entry.status === '已删除') {
        return;
      }
      var name = (entry.company_name || '').toLowerCase().trim();
      if (name) {
        lookup[name] = entry;
      }
      var alias = (entry.alias || '').toLowerCase().trim();
      if (alias) {
        lookup[alias] = entry;
      }
    });

    return (companyNames || []).map(function(name) {
      if (!name || !name.trim()) {
        return { company: name, isMatch: false, matchedName: null, bank_name: null, status: null };
      }
      var key = name.toLowerCase().trim();
      var match = lookup[key] || null;
      return {
        company: name,
        isMatch: !!match,
        matchedName: match ? match.company_name : null,
        bank_name: match ? match.bank_name : null,
        status: match ? match.status : null
      };
    });
  }

  /**
   * Delete a company from the whitelist by name.
   */
  async function deleteCompany(companyName) {
    if (!baseUrl || !key) throw new Error('Supabase not configured');
    if (!companyName || !companyName.trim()) {
      throw new Error('company_name is required');
    }

    const resp = await fetch(
      baseUrl + '/rest/v1/whitelist_companies?company_name=eq.' + encodeURIComponent(companyName.trim()),
      {
        method: 'DELETE',
        headers: headers()
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error('Supabase delete failed [' + resp.status + ']: ' + text);
    }

    return { success: true };
  }

  /**
   * Save learning knowledge item to Supabase knowledge_base table.
   */
  async function saveKnowledge(item) {
    if (!baseUrl || !key) return null;

    const row = {
      title: item.title || '未命名知识',
      summary: item.summary || '',
      content: item.content || '',
      tags: Array.isArray(item.tags) ? item.tags : [],
      source_type: item.source_type || '自定义'
    };

    const resp = await fetch(baseUrl + '/rest/v1/knowledge_base', {
      method: 'POST',
      headers: Object.assign({}, headers(), {
        'Prefer': 'return=representation'
      }),
      body: JSON.stringify(row)
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error('[supabase] saveKnowledge failed:', text);
      throw new Error('Supabase saveKnowledge failed: ' + text);
    }

    const data = await resp.json();
    return data && data[0] ? data[0] : null;
  }

  async function searchCustomers(queryStr) {
    if (!baseUrl || !key) return [];
    const resp = await fetch(
      baseUrl + '/rest/v1/customers?select=*&or=(name.ilike.%' + encodeURIComponent(queryStr) + '%,mobile.ilike.%' + encodeURIComponent(queryStr) + '%,company_name.ilike.%' + encodeURIComponent(queryStr) + '%)&order=created_at.desc',
      { headers: headers() }
    );
    if (!resp.ok) return [];
    return await resp.json();
  }

  async function searchSpeech(queryStr) {
    if (!baseUrl || !key) return [];
    const resp = await fetch(
      baseUrl + '/rest/v1/speech_library?select=*&or=(category.ilike.%' + encodeURIComponent(queryStr) + '%,scenario.ilike.%' + encodeURIComponent(queryStr) + '%,content.ilike.%' + encodeURIComponent(queryStr) + '%)&order=score.desc',
      { headers: headers() }
    );
    if (!resp.ok) return [];
    return await resp.json();
  }

  async function searchLoanCases(queryStr) {
    if (!baseUrl || !key) return [];
    const resp = await fetch(
      baseUrl + '/rest/v1/loan_cases?select=*&or=(company_name.ilike.%' + encodeURIComponent(queryStr) + '%,loan_product.ilike.%' + encodeURIComponent(queryStr) + '%)&order=company_name.asc',
      { headers: headers() }
    );
    if (!resp.ok) return [];
    return await resp.json();
  }

  async function searchKnowledge(queryStr) {
    if (!baseUrl || !key) return [];
    const resp = await fetch(
      baseUrl + '/rest/v1/knowledge_base?select=*&or=(title.ilike.%' + encodeURIComponent(queryStr) + '%,summary.ilike.%' + encodeURIComponent(queryStr) + '%,content.ilike.%' + encodeURIComponent(queryStr) + '%)&limit=5',
      { headers: headers() }
    );
    if (!resp.ok) return [];
    return await resp.json();
  }

  /**
   * Upsert customers (dialer clients) into Supabase.
   * Uses mobile as unique key to prevent duplicates.
   * Each customer gets: name, mobile, company_name, note, batch_label
   */
  async function upsertCustomers(customers) {
    if (!baseUrl || !key) return { count: 0, error: 'Supabase not configured' };
    if (!Array.isArray(customers) || customers.length === 0) return { count: 0 };

    const rows = customers.map(function(c) {
      return {
        name: (c.name || '').trim() || '未知姓名',
        mobile: (c.mobile || c.phone || '').trim(),
        company_name: (c.company || c.company_name || '').trim(),
        note: (c.note || '').trim(),
        batch_label: (c.batch_label || '').trim()
      };
    }).filter(function(r) {
      return r.mobile.length > 0;
    });

    if (rows.length === 0) return { count: 0 };

    let count = 0;
    const batchSize = 500;
    for (let i = 0; i < rows.length; i += batchSize) {
      const chunk = rows.slice(i, i + batchSize);
      const resp = await fetch(baseUrl + '/rest/v1/customers?on_conflict=mobile', {
        method: 'POST',
        headers: Object.assign({}, headers(), {
          'Prefer': 'resolution=merge-duplicates'
        }),
        body: JSON.stringify(chunk)
      });

      if (!resp.ok) {
        const text = await resp.text();
        // If batch_label column doesn't exist, retry without it
        if (text.includes('batch_label') && text.includes('column')) {
          const fallbackRows = chunk.map(function(r) {
            var copy = Object.assign({}, r);
            delete copy.batch_label;
            delete copy.note;
            return copy;
          });
          const fbResp = await fetch(baseUrl + '/rest/v1/customers?on_conflict=mobile', {
            method: 'POST',
            headers: Object.assign({}, headers(), {
              'Prefer': 'resolution=merge-duplicates'
            }),
            body: JSON.stringify(fallbackRows)
          });
          if (!fbResp.ok) {
            const fbText = await fbResp.text();
            throw new Error('Supabase upsert customers failed [' + fbResp.status + ']: ' + fbText);
          }
        } else {
          throw new Error('Supabase upsert customers failed [' + resp.status + ']: ' + text);
        }
      }
      count += chunk.length;
    }

    return { count: count };
  }

  return {
    upsertCompanies: upsertCompanies,
    getAllCompanies: getAllCompanies,
    checkCompanies: checkCompanies,
    deleteCompany: deleteCompany,
    saveKnowledge: saveKnowledge,
    searchCustomers: searchCustomers,
    searchSpeech: searchSpeech,
    searchLoanCases: searchLoanCases,
    searchKnowledge: searchKnowledge,
    upsertCustomers: upsertCustomers
  };
}


