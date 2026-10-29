// ============================================================================
// Shared state for the Meinhaus relay (Netlify Blobs store "meinhaus").
//   paused-trades      JSON array of trade names Meinhaus has paused
//   ledger/YYYY-MM/... one JSON row per lead we push (weekly sheet source)
// Every helper fails soft: if Blobs is unavailable, leads still flow.
// Added 2026-10-29.
// ============================================================================
const { getStore, connectLambda } = require('@netlify/blobs');

function store(event) {
  try {
    if (event && event.blobs) connectLambda(event);
    return getStore('meinhaus');
  } catch (e) { console.log('blobs unavailable', e.message); return null; }
}

async function getPaused(event) {
  const s = store(event);
  if (!s) return [];
  try { const v = await s.get('paused-trades', { type: 'json' }); return Array.isArray(v) ? v : []; }
  catch (e) { console.log('paused read failed', e.message); return []; }
}

async function recordLead(event, lead, site, result, hot) {
  const s = store(event);
  if (!s) return;
  const now = new Date().toISOString();
  const row = {
    date: now,
    site: site.label, domain: site.domain || site.key, trade: site.trade,
    source: lead.source || '', name: lead.name || '', phone: lead.phone || '', email: lead.email || '',
    address: lead.address || '', hot: hot ? 'HOT' : '',
    meinhausLeadId: result && result.json && result.json.lead ? result.json.lead.id : '',
    newLead: result && result.json ? (result.json.isNewLead === false ? 'duplicate' : 'new') : '',
    status: result && result.ok ? 'sent' : (result && result.skipped ? 'not sent: ' + result.skipped : 'FAILED'),
    ref: lead.ref || '',
  };
  try { await s.setJSON('ledger/' + now.slice(0, 7) + '/' + now + '-' + String(row.ref).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120), row); }
  catch (e) { console.log('ledger write failed', e.message); }
}

module.exports = { store, getPaused, recordLead };
