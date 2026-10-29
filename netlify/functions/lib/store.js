// ============================================================================
// Shared state for the Meinhaus relay (Netlify Blobs store "meinhaus").
//   paused-trades      JSON array of trade names Meinhaus has paused
//                      (read via the meinhaus-switch status endpoint, which is
//                       a v2 function with strongly consistent Blobs access)
//   ledger/YYYY-MM/... one JSON row per lead we push (weekly sheet source)
// Every helper fails soft: if storage is unavailable, leads still flow.
// Added 2026-10-29.
// ============================================================================
const { getStore, connectLambda } = require('@netlify/blobs');
const STATUS_URL = process.env.MEINHAUS_SWITCH_STATUS_URL || 'https://guelpheavestrough.com/.netlify/functions/meinhaus-switch?status=1';

function store(event) {
  try {
    if (event && event.blobs) connectLambda(event);
    return getStore('meinhaus');
  } catch (e) { console.log('blobs unavailable', e.message); return null; }
}

async function getPaused() {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch(STATUS_URL, { signal: ctl.signal, headers: { 'Cache-Control': 'no-cache' } });
    clearTimeout(t);
    const j = await r.json();
    return Array.isArray(j.paused) ? j.paused : [];
  } catch (e) { console.log('paused read failed', e.message); return []; }
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
