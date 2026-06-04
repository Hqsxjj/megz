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
        return { company_name: c.trim(), bank_name: '建行建易贷' };
      }
      return {
        company_name: (c.company_name || '').trim(),
        alias: c.alias || null,
        bank_name: c.bank_name || '建行建易贷'
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

    const resp = await fetch(
      baseUrl + '/rest/v1/whitelist_companies?select=id,company_name,alias,bank_name,created_at&order=company_name.asc',
      { headers: headers() }
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error('Supabase query failed [' + resp.status + ']: ' + text);
    }

    const data = await resp.json();
    return data || [];
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
      var name = (entry.company_name || '').toLowerCase().trim();
      if (name) {
        lookup[name] = entry;
      }
    });

    return (companyNames || []).map(function(name) {
      if (!name || !name.trim()) {
        return { company: name, isMatch: false, matchedName: null };
      }
      var key = name.toLowerCase().trim();
      var match = lookup[key] || null;
      return {
        company: name,
        isMatch: !!match,
        matchedName: match ? match.company_name : null
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

  return {
    upsertCompanies: upsertCompanies,
    getAllCompanies: getAllCompanies,
    checkCompanies: checkCompanies,
    deleteCompany: deleteCompany
  };
}
