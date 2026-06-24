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
   * Get all customers with pagination and optional search.
   */
  async function getAllCustomers(page, pageSize, search, sortBy, sortDir, category, batchLabel) {
    if (!baseUrl || !key) return { data: [], total: 0, page: page || 1, pageSize: pageSize || 50 };

    try {
      var p = page || 1;
      var ps = pageSize || 50; // no cap — fetch whatever client asks

      var baseSearch = '';
      if (search) {
        baseSearch = '&or=(name.ilike.%25' + encodeURIComponent(search) + '%25,mobile.ilike.%25' + encodeURIComponent(search) + '%25,company_name.ilike.%25' + encodeURIComponent(search) + '%25)';
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
      var orderClause = '&order=created_at.desc'; // default
      if (sortBy) {
        var dir = (sortDir === 'asc' ? 'asc' : 'desc');
        orderClause = '&order=' + encodeURIComponent(sortBy) + '.' + dir;
        if (sortBy !== 'created_at') {
          orderClause += ',created_at.desc'; // secondary sort
        }
      }

      // Try column sets from most to least specific
      var colSets = [
        'name,mobile,company_name,category,note,fund,batch_label,created_at,last_operation',
        'name,mobile,company_name,category,note,fund,created_at,last_operation',
        'name,mobile,company_name,category,note,batch_label,created_at',
        'name,mobile,company_name,category,note,created_at',
        'name,mobile,company_name,created_at',
        '*'
      ];

      // Supabase max 1000 rows/request. Loop until we hit the end.
      var SUPABASE_MAX = 1000;
      var allData = [];
      var totalCount = 0;
      var from = (p - 1) * ps;
      var currentFrom = from;

      while (true) {
        var fetchSize = SUPABASE_MAX;
        // On the last chunk, we may overshoot the total; Supabase just returns
        // whatever is left, so we can always ask for a full SUPABASE_MAX.
        var currentTo = currentFrom + fetchSize - 1;

        var headersWithCount = Object.assign({}, headers(), {
          'Range': currentFrom + '-' + currentTo,
          'Prefer': 'count=exact'
        });

        var resp = null;
        var batch = null;

        for (var ci = 0; ci < colSets.length; ci++) {
          var url2 = baseUrl + '/rest/v1/customers?select=' + colSets[ci] + orderClause + baseSearch + filterParams;
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

        if (batch.length < fetchSize) break; // no more data
        currentFrom += fetchSize;
      }

      if (allData.length === 0) {
        console.error('[supabase] getAllCustomers failed, returning empty');
        return { data: [], total: 0, page: p, pageSize: ps };
      }

      // Use Content-Range total if available, otherwise fetched count
      return { data: allData, total: totalCount || allData.length, page: p, pageSize: ps };
    } catch (e) {
      console.error('[supabase] getAllCustomers error:', e.message);
      return { data: [], total: 0, page: page || 1, pageSize: pageSize || 50 };
    }
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
      var noteVal = (c.note || '').trim();
      var callNoteVal = (c.callNote || '').trim();
      if (callNoteVal) {
        var marker = '[通话小记] ' + callNoteVal;
        if (!noteVal.includes(marker)) {
          if (noteVal) {
            noteVal += '\n' + marker;
          } else {
            noteVal = marker;
          }
        }
      }

      var fundVal = (c.fund || '').trim();
      if (fundVal) {
        // We want to ensure that fund is saved in noteVal JSON
        if (noteVal.indexOf('{') === 0) {
          try {
            var obj = JSON.parse(noteVal);
            if (obj && typeof obj === 'object') {
              obj.fund = fundVal;
              noteVal = JSON.stringify(obj);
            }
          } catch (e) {
            noteVal = JSON.stringify({ note: noteVal, fund: fundVal });
          }
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
        batch_label: (c.batch_label || '').trim()
      };
    }).filter(function(r) {
      return r.mobile.length > 0;
    });

    // Deduplicate by mobile to avoid "ON CONFLICT DO UPDATE command cannot affect row a second time"
    var uniqueMap = {};
    var uniqueRows = [];
    rows.forEach(function(row) {
      uniqueMap[row.mobile] = row;
    });
    for (var m in uniqueMap) {
      if (uniqueMap.hasOwnProperty(m)) {
        uniqueRows.push(uniqueMap[m]);
      }
    }

    if (uniqueRows.length === 0) return { count: 0 };

    let count = 0;
    const batchSize = 500;
    for (let i = 0; i < uniqueRows.length; i += batchSize) {
      const chunk = uniqueRows.slice(i, i + batchSize);
      const resp = await fetch(baseUrl + '/rest/v1/customers?on_conflict=mobile', {
        method: 'POST',
        headers: Object.assign({}, headers(), {
          'Prefer': 'resolution=merge-duplicates'
        }),
        body: JSON.stringify(chunk)
      });

      if (!resp.ok) {
        const text = await resp.text();
        // If fund column doesn't exist, retry without it
        if (text.includes('fund') && text.includes('column')) {
          const fallbackRows = chunk.map(function(r) {
            var copy = Object.assign({}, r);
            delete copy.fund;
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
            throw new Error('Supabase upsert customers fallback failed [' + fbResp.status + ']: ' + fbText);
          }
        } else if (text.includes('batch_label') && text.includes('column')) {
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

  /**
   * Batch update category for all customers with a given batch_label.
   * Uses a simpler approach: fetch all matching mobiles first, then PATCH each.
   */
  async function batchUpdateCategory(batchLabel, category) {
    if (!baseUrl || !key) throw new Error('Supabase not configured');
    if (!batchLabel || !category) throw new Error('batch_label and category required');

    // Fetch all matching mobiles (pagination loop)
    var allMobiles = [];
    var offset = 0;
    var pageSize = 1000;
    while (true) {
      var url2 = baseUrl + '/rest/v1/customers?select=mobile&batch_label=eq.' + encodeURIComponent(batchLabel) + '&limit=' + pageSize + '&offset=' + offset;
      var pageResp = await fetch(url2, { headers: headers() });
      if (!pageResp.ok) {
        var text = await pageResp.text();
        throw new Error('Batch query failed [' + pageResp.status + ']: ' + text);
      }
      var page = await pageResp.json();
      if (!Array.isArray(page) || page.length === 0) break;
      allMobiles.push.apply(allMobiles, page.map(function(r) { return r.mobile; }));
      if (page.length < pageSize) break;
      offset += pageSize;
    }

    if (allMobiles.length === 0) return { count: 0 };

    // PATCH each one
    var updated = 0;
    for (var i = 0; i < allMobiles.length; i++) {
      var patchResp = await fetch(
        baseUrl + '/rest/v1/customers?mobile=eq.' + encodeURIComponent(allMobiles[i]),
        {
          method: 'PATCH',
          headers: Object.assign({}, headers(), { 'Prefer': 'return=minimal' }),
          body: JSON.stringify({ category: category })
        }
      );
      if (patchResp.ok) updated++;
    }

    return { count: updated };
  }

  /**
   * Get a random batch of customers. Counts total rows first, then picks
   * a random offset and fetches `limit` records.
   */
  async function getRandomCustomers(limit) {
    if (!baseUrl || !key) return { data: [], total: 0 };

    try {
      var lim = Math.min(limit || 50, 200);

      // 1. Count total rows
      var countResp = await fetch(
        baseUrl + '/rest/v1/customers?select=id&limit=0',
        {
          headers: Object.assign({}, headers(), {
            'Prefer': 'count=exact'
          })
        }
      );

      var totalCount = 0;
      if (countResp.ok) {
        var contentRange = countResp.headers.get('Content-Range');
        if (contentRange) {
          var parts = contentRange.split('/');
          if (parts.length === 2) totalCount = parseInt(parts[1], 10) || 0;
        }
      }

      if (totalCount === 0) return { data: [], total: 0 };

      // 2. Pick a random offset that still leaves room for `lim` rows
      var maxOffset = Math.max(0, totalCount - lim);
      var randomOffset = Math.floor(Math.random() * (maxOffset + 1));

      // 3. Fetch `lim` rows from that offset
      var hdrs = Object.assign({}, headers(), {
        'Range': randomOffset + '-' + (randomOffset + lim - 1)
      });

      var colSets = [
        'name,mobile,company_name,category,note,fund,batch_label,created_at,last_operation',
        'name,mobile,company_name,category,note,fund,created_at,last_operation',
        'name,mobile,company_name,category,note,batch_label,created_at',
        'name,mobile,company_name,category,note,created_at',
        'name,mobile,company_name,created_at',
        '*'
      ];

      var resp = null;
      var data = null;
      for (var ci = 0; ci < colSets.length; ci++) {
        var qUrl = baseUrl + '/rest/v1/customers?select=' + colSets[ci] + '&order=created_at.desc';
        resp = await fetch(qUrl, { headers: hdrs });
        if (resp.ok) {
          data = await resp.json();
          break;
        }
      }

      return {
        data: Array.isArray(data) ? data : [],
        total: totalCount,
        offset: randomOffset,
        limit: lim
      };
    } catch (e) {
      console.error('[supabase] getRandomCustomers error:', e.message);
      return { data: [], total: 0, error: e.message };
    }
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
    upsertCustomers: upsertCustomers,
    getAllCustomers: getAllCustomers,
    updateCustomer: updateCustomer,
    getRandomCustomers: getRandomCustomers,
    batchUpdateCategory: batchUpdateCategory,
    deleteCustomer: deleteCustomer,
    deleteCustomers: deleteCustomers,
    saveCorrection: saveCorrection,
    getCorrections: getCorrections,
    getCorrectionsForExport: getCorrectionsForExport,
    getCorrectionsCount: getCorrectionsCount
  };

  /**
   * Update a single customer by mobile (unique key).
   * fields: { category?, note?, company_name?, name? }
   */
  async function updateCustomer(mobile, fields) {
    if (!baseUrl || !key) throw new Error('Supabase not configured');
    if (!mobile) throw new Error('mobile is required');

    const resp = await fetch(
      baseUrl + '/rest/v1/customers?mobile=eq.' + encodeURIComponent(mobile),
      {
        method: 'PATCH',
        headers: Object.assign({}, headers(), { 'Prefer': 'return=representation' }),
        body: JSON.stringify(fields)
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error('Supabase update customer failed [' + resp.status + ']: ' + text);
    }

    const data = await resp.json();
    return data && data[0] ? data[0] : null;
  }

  async function deleteCustomer(mobile) {
    if (!baseUrl || !key) throw new Error('Supabase not configured');
    if (!mobile) throw new Error('mobile is required');

    const resp = await fetch(
      baseUrl + '/rest/v1/customers?mobile=eq.' + encodeURIComponent(mobile),
      {
        method: 'DELETE',
        headers: headers()
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error('Supabase delete customer failed [' + resp.status + ']: ' + text);
    }
    return true;
  }

  async function deleteCustomers(mobiles) {
    if (!baseUrl || !key) throw new Error('Supabase not configured');
    if (!mobiles || mobiles.length === 0) throw new Error('mobiles are required');

    const chunkSize = 100;
    for (let i = 0; i < mobiles.length; i += chunkSize) {
      const chunk = mobiles.slice(i, i + chunkSize);
      const inClause = chunk.map(function(m) { return encodeURIComponent(m); }).join(',');
      const resp = await fetch(
        baseUrl + '/rest/v1/customers?mobile=in.(' + inClause + ')',
        {
          method: 'DELETE',
          headers: headers()
        }
      );
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error('Supabase delete customers failed [' + resp.status + ']: ' + text);
      }
    }
    return true;
  }

  /**
   * Save an OCR correction record (training data).
   */
  async function saveCorrection(correction) {
    if (!baseUrl || !key) return null;

    const row = {
      raw_text: correction.rawText || '',
      original_json: correction.originalContacts || [],
      corrected_json: correction.correctedContacts || [],
      source_file: correction.sourceFile || '',
      ocr_pipeline: correction.ocrPipeline || 'ai_vision',
      ocr_mode: correction.ocrMode || 'bulk',
      edit_count: correction.editCount || 0,
      metadata: correction.metadata || {}
    };

    const resp = await fetch(baseUrl + '/rest/v1/ocr_corrections', {
      method: 'POST',
      headers: Object.assign({}, headers(), {
        'Prefer': 'return=representation'
      }),
      body: JSON.stringify(row)
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error('[supabase] saveCorrection failed:', text);
      throw new Error('Supabase saveCorrection failed [' + resp.status + ']: ' + text);
    }

    const data = await resp.json();
    return data && data[0] ? data[0] : null;
  }

  /**
   * Get OCR corrections with pagination and optional filtering.
   */
  async function getCorrections(page, pageSize, minEdits, sort) {
    if (!baseUrl || !key) return { data: [], total: 0, page: page || 1, pageSize: pageSize || 20 };

    try {
      var p = page || 1;
      var ps = pageSize || 20;
      var from = (p - 1) * ps;
      var to = from + ps - 1;

      var url2 = baseUrl + '/rest/v1/ocr_corrections?select=*';

      // Filter: only show rows with edits if minEdits > 0
      if (minEdits && minEdits > 0) {
        url2 += '&edit_count=gte.' + minEdits;
      }

      // Sort
      if (sort === 'oldest') {
        url2 += '&order=created_at.asc';
      } else {
        url2 += '&order=created_at.desc';
      }

      var headersWithCount = Object.assign({}, headers(), {
        'Range': from + '-' + to,
        'Prefer': 'count=exact'
      });

      var resp = await fetch(url2, { headers: headersWithCount });

      if (!resp.ok) {
        var text = await resp.text();
        throw new Error('Supabase getCorrections failed [' + resp.status + ']: ' + text);
      }

      var data = await resp.json();
      var total = data.length;
      var contentRange = resp.headers.get('Content-Range');
      if (contentRange) {
        var parts = contentRange.split('/');
        if (parts.length === 2) total = parseInt(parts[1], 10) || total;
      }

      return {
        data: Array.isArray(data) ? data : [],
        total: total,
        page: p,
        pageSize: ps
      };
    } catch (e) {
      console.error('[supabase] getCorrections error:', e.message);
      return { data: [], total: 0, page: page || 1, pageSize: pageSize || 20 };
    }
  }

  /**
   * Get OCR corrections for JSONL export.
   */
  async function getCorrectionsForExport(limit) {
    if (!baseUrl || !key) return [];

    var maxLimit = Math.min(limit || 200, 1000);
    var url2 = baseUrl + '/rest/v1/ocr_corrections?select=*&edit_count=gt.0&order=created_at.desc&limit=' + maxLimit;

    var resp = await fetch(url2, { headers: headers() });

    if (!resp.ok) {
      var text = await resp.text();
      throw new Error('Supabase getCorrectionsForExport failed [' + resp.status + ']: ' + text);
    }

    return await resp.json();
  }

  /**
   * Get total count of OCR corrections.
   */
  async function getCorrectionsCount() {
    if (!baseUrl || !key) return 0;

    try {
      var resp = await fetch(
        baseUrl + '/rest/v1/ocr_corrections?select=id&limit=0',
        {
          headers: Object.assign({}, headers(), {
            'Prefer': 'count=exact'
          })
        }
      );

      if (!resp.ok) return 0;

      var contentRange = resp.headers.get('Content-Range');
      if (contentRange) {
        var parts = contentRange.split('/');
        if (parts.length === 2) return parseInt(parts[1], 10) || 0;
      }
      return 0;
    } catch (e) {
      console.error('[supabase] getCorrectionsCount error:', e.message);
      return 0;
    }
  }
}


