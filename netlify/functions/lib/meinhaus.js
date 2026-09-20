// ============================================================================
// WeProvideLeads -> Meinhaus Lead Import API  (shared library)
//
// Pushes ONE lead per call to POST https://meinhaus.ca/lead-gen/leads
// Spec: "Lead Import API - Meinhaus" (Sept 2026).
//   - Bearer token in MEINHAUS_API_TOKEN (Netlify env var, Secret)
//   - At least one of email / phone required (422 otherwise)
//   - external_ref = our idempotency key; same ref within ~14 days returns the
//     original lead with isNewLead:false instead of creating a duplicate
//   - Rate limit 30 req/min per token -> we retry 429/5xx with backoff
//
// Zero npm deps. Runs on Netlify Functions (Node 18+, global fetch).
// ============================================================================

const MEINHAUS_ENDPOINT = 'https://meinhaus.ca/lead-gen/leads';

// ---------------------------------------------------------------------------
// WHICH SITES PUSH TO MEINHAUS.
// Key = site hostname (as Netlify reports it in payload.site_url) OR the
// Twilio PHONE_CONFIG "site" label. `enabled:false` keeps a site mapped but
// silent — flip to true the day Erik agrees to terms for that trade.
// ---------------------------------------------------------------------------
const SITES = {
  // ---- PAID: $500 + HST / month, exclusive, since Sep 2026 ----
  'guelpheavestrough.com':        { enabled: true,  trade: 'Eavestrough',            label: 'Guelph Eavestrough', domain: 'guelpheavestrough.com' },
  'Guelph Eavestrough':           { enabled: true,  trade: 'Eavestrough',            label: 'Guelph Eavestrough', domain: 'guelpheavestrough.com' },

  // ---- FREE TEST → $750/mo offer sent Sep 2026. ON since 2026-09-20 (Mark) ----
  'guelphdrywalling.com':         { enabled: true,  trade: 'Drywalling',             label: 'Guelph Drywalling', domain: 'guelphdrywalling.com' },
  'Guelph Drywalling':            { enabled: true,  trade: 'Drywalling',             label: 'Guelph Drywalling', domain: 'guelphdrywalling.com' },

  // ---- NOT YET SOLD — mapped so enabling is a one-word change ----
  'guelphbasementwaterproofing.com': { enabled: false, trade: 'Basement Waterproofing', label: 'Guelph Basement Waterproofing', domain: 'guelphbasementwaterproofing.com' },
  'Guelph Basement Waterproofing':   { enabled: false, trade: 'Basement Waterproofing', label: 'Guelph Basement Waterproofing', domain: 'guelphbasementwaterproofing.com' },
  'guelphfoundationrepair.com':      { enabled: false, trade: 'Foundation Repair',      label: 'Guelph Foundation Repair', domain: 'guelphfoundationrepair.com' },
  'Guelph Foundation Repair':        { enabled: false, trade: 'Foundation Repair',      label: 'Guelph Foundation Repair', domain: 'guelphfoundationrepair.com' },
  'guelphplumbers.ca':               { enabled: false, trade: 'Plumbing',               label: 'Guelph Plumbers', domain: 'guelphplumbers.ca' },
  'Guelph Plumbers':                 { enabled: false, trade: 'Plumbing',               label: 'Guelph Plumbers', domain: 'guelphplumbers.ca' },
};

function siteFor(key) {
  if (!key) return null;
  const k = String(key).trim();
  if (SITES[k]) return { key: k, ...SITES[k] };
  // tolerate "https://guelpheavestrough.com/" or "www."
  const host = k.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase();
  if (SITES[host]) return { key: host, ...SITES[host] };
  return null;
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function digits(s) {
  return String(s || '').replace(/\D/g, '');
}

function clip(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ---------------------------------------------------------------------------
// Build the Meinhaus request body from a normalised WPL lead.
//   lead = { site, source, name, email, phone, address, message, extra: {...},
//            ref }
// ---------------------------------------------------------------------------
function buildPayload(lead, site) {
  const lines = [];
  lines.push(`[WeProvideLeads] ${site.label} — ${lead.source}`);
  lines.push(`Trade: ${site.trade}`);
  if (lead.message) lines.push('', String(lead.message).trim());
  const extra = lead.extra || {};
  const extraLines = Object.entries(extra)
    .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(([k, v]) => `${k}: ${String(v).trim()}`);
  if (extraLines.length) lines.push('', ...extraLines);
  lines.push('', `Source site: https://${site.domain || site.key}`);

  const body = {
    message: clip(lines.join('\n'), 2000),
    external_ref: clip(lead.ref, 255),
  };
  if (lead.name && String(lead.name).trim()) body.name = clip(String(lead.name).trim(), 255);
  if (lead.email && /\S+@\S+\.\S+/.test(lead.email)) body.email = clip(String(lead.email).trim(), 255);
  if (lead.phone && digits(lead.phone).length >= 10) body.phone = normalisePhone(lead.phone);
  if (lead.address && String(lead.address).trim()) body.address = clip(String(lead.address).trim(), 1000);
  return body;
}

// Meinhaus prepends "+1" to whatever digits it receives (test lead #1232 came back
// as "+115199425698" when we sent "+15199425698"), so send the bare 10-digit
// national number for NA and let their side add the country code.
function normalisePhone(p) {
  const d = digits(p);
  if (d.length === 10) return d;
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  return String(p).trim(); // anything odd: pass through, Meinhaus normalises
}

// ---------------------------------------------------------------------------
// POST with retry. Returns { ok, status, json, attempts, skipped? }
// ---------------------------------------------------------------------------
async function pushLead(lead, opts = {}) {
  const token = opts.token || process.env.MEINHAUS_API_TOKEN;
  const site = siteFor(lead.site);
  if (!site) return { ok: false, skipped: 'site-not-mapped', site: lead.site };
  if (!site.enabled && !opts.force) return { ok: false, skipped: 'site-disabled', site: site.key };
  if (!token) return { ok: false, skipped: 'no-token' };

  const body = buildPayload(lead, site);
  if (!body.email && !body.phone) return { ok: false, skipped: 'no-email-or-phone', body };
  if (opts.dryRun) return { ok: true, dryRun: true, body };

  const maxAttempts = opts.maxAttempts || 3;
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(MEINHAUS_ENDPOINT, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch (_) { json = { raw: text.slice(0, 500) }; }
      last = { ok: res.ok, status: res.status, json, attempts: attempt, body };
      if (res.ok) return last;
      // 401/403/422 are permanent — don't hammer the endpoint
      if ([400, 401, 403, 422].includes(res.status)) return last;
      // 429 / 5xx -> back off and retry
    } catch (e) {
      last = { ok: false, status: 0, error: e.message, attempts: attempt, body };
    }
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 1500 * attempt));
  }
  return last;
}

// ---------------------------------------------------------------------------
// Optional audit email to Mark via Resend so every push is searchable in Gmail
// ("Meinhaus lead #1234"). Silent no-op if no Resend key on the site.
// ---------------------------------------------------------------------------
async function auditEmail(lead, result) {
  const key = process.env.RESEND_API_KEY || process.env.weprovideleadsnetlify;
  if (!key) return;
  const to = (process.env.MAIL_INTERNAL || 'mark@weprovideleads.com').split(',').map(s => s.trim()).filter(Boolean);
  const from = process.env.MAIL_FROM || 'WeProvideLeads <hello@weprovideleads.com>';
  const site = siteFor(lead.site) || { label: lead.site };
  let subject, status;
  if (result.ok && result.json && result.json.lead) {
    const id = result.json.lead.id;
    const dup = result.json.isNewLead === false ? ' (duplicate — already existed)' : '';
    subject = `Meinhaus ✓ lead #${id} — ${site.label} — ${lead.name || lead.phone || lead.email}${dup}`;
    status = `Pushed to Meinhaus. Lead ID <b>#${id}</b>${dup}. Ref: <code>${result.body.external_ref}</code>`;
  } else if (result.skipped) {
    return; // nothing sent, nothing to audit
  } else {
    subject = `Meinhaus ✗ FAILED — ${site.label} — ${lead.name || lead.phone || lead.email} (HTTP ${result.status || 'ERR'})`;
    status = `<b style="color:#b00">Push FAILED</b> after ${result.attempts} attempt(s). HTTP ${result.status}. ` +
             `<pre>${escapeHtml(JSON.stringify(result.json || result.error, null, 2))}</pre>` +
             `Forward this lead to admin@meinhaus.ca manually.`;
  }
  const html = `<div style="font-family:sans-serif"><h3>${escapeHtml(site.label)} → Meinhaus</h3><p>${status}</p>` +
    `<pre style="background:#f5f5f5;padding:10px;border-radius:6px">${escapeHtml(JSON.stringify(result.body, null, 2))}</pre></div>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html }),
    });
  } catch (e) { console.log('meinhaus audit email failed', e.message); }
}

function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

module.exports = { SITES, siteFor, buildPayload, pushLead, auditEmail, slug, digits, MEINHAUS_ENDPOINT };
