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


// ---------------------------------------------------------------------------
// Duplicate guard (2026-11-09, Mark: "make sure we're not doing any duplicates").
// Every successful push also writes a tiny index entry per contact, so the next
// push for the same person on the same site is one Blobs GET away instead of a
// scan of the whole month. Keyed on site + normalised contact:
//     contact/<site-slug>--<10-digit phone | lowercased email>
// Fails open everywhere: if the index cannot be read, the lead is pushed.
// ---------------------------------------------------------------------------
const DEDUPE_DAYS = Number(process.env.MEINHAUS_DEDUPE_DAYS || 14);
const phone10 = (p) => { const d = String(p == null ? '' : p).replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : d; };
const slugKey = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function contactKeys(site, lead) {
  const out = [];
  const sk = slugKey(site && (site.label || site.key));
  const ph = phone10(lead && lead.phone);
  if (ph.length === 10) out.push('contact/' + sk + '--' + ph);
  const em = String((lead && lead.email) || '').trim().toLowerCase();
  if (em && /\S+@\S+\.\S+/.test(em)) out.push('contact/' + sk + '--' + em.replace(/[^a-z0-9._@+-]/g, '_'));
  return out;
}

// Returns { leadId, date, ref, days } for a recent push to the same contact, else null.
async function recentLead(event, site, lead) {
  const s = store(event);
  if (!s) return null;
  const now = Date.now();
  for (const k of contactKeys(site, lead)) {
    try {
      const v = await s.get(k, { type: 'json' });
      if (!v || !v.leadId) continue;
      const age = (now - Date.parse(v.date)) / 86400000;
      if (!(age >= 0)) continue;
      if (age <= DEDUPE_DAYS) return { leadId: v.leadId, date: v.date, ref: v.ref || '', days: age };
    } catch (e) { console.log('dedupe read failed', k, e.message); }
  }
  return null;
}

async function rememberContact(event, site, lead, leadId) {
  if (!leadId) return;
  const s = store(event);
  if (!s) return;
  const payload = { leadId: leadId, date: new Date().toISOString(), ref: lead.ref || '', site: site.label };
  for (const k of contactKeys(site, lead)) {
    try { await s.setJSON(k, payload); } catch (e) { console.log('dedupe write failed', k, e.message); }
  }
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

module.exports = { store, getPaused, recordLead, recentLead, rememberContact, DEDUPE_DAYS };
