// ============================================================================
// Netlify auto-invokes a function named `submission-created` on EVERY verified
// (non-spam) form submission on this site. No webhook config needed.
//
// This one pushes the lead into Meinhaus (lib/meinhaus.js) and emails Mark an
// audit line with the Meinhaus lead ID. The existing Netlify email
// notification to mark@weprovideleads.com keeps working independently.
//
// Env vars (Site configuration → Environment variables):
//   MEINHAUS_API_TOKEN   bearer token from Meinhaus  (Secret)
//   RESEND_API_KEY       optional — enables the audit email
//   MAIL_INTERNAL        optional — default mark@weprovideleads.com
// ============================================================================
const { pushLead, auditEmail, pausedEmail, hotReasons, siteFor, buildPayload, slug } = require('./lib/meinhaus.js');
const { getPaused, recordLead, recentLead, rememberContact } = require('./lib/store.js');

const phone10 = (p) => { const d = String(p == null ? '' : p).replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : d; };
const seen = () => { const g = (typeof globalThis !== 'undefined' ? globalThis : global); return (g.__mhSeen = g.__mhSeen || new Map()); };

exports.handler = async (event) => {
  let payload;
  try { payload = JSON.parse(event.body || '{}').payload || {}; }
  catch (e) { console.log('submission-created: bad JSON'); return { statusCode: 200, body: 'bad json' }; }

  const data = payload.data || {};
  const host = String(payload.site_url || process.env.URL || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  const formName = payload.form_name || 'contact';

  // Netlify Forms fields on the WPL contact form: name, phone, email, address, message, photos
  const msg = String(data.message || data.details || data.description || '').trim();

  // Test hook: a message containing [WPL-TEST-REF:xyz] forces external_ref=xyz so an
  // end-to-end test replays a ref Meinhaus already holds (isNewLead:false, no new lead).
  const refOverride = (msg.match(/\[WPL-TEST-REF:([A-Za-z0-9._-]+)\]/) || [])[1];

  const lead = {
    site: host,
    source: `web form (${formName})`,
    name: data.name || [data.first_name, data.last_name].filter(Boolean).join(' '),
    email: data.email,
    phone: data.phone || data.tel,
    address: data.address || data.property_address,
    message: msg,
    extra: {
      'Service requested': data.service || data.service_type,
      'Preferred contact': data.contact_method,
      'Photos/video': fileUrls(data.photos),
      'Submitted': payload.created_at,
      'Page': payload.site_url ? `${payload.site_url}/contact` : undefined,
    },
    ref: refOverride || `wpl-${host.replace(/\W+/g, '-')}-form-${payload.id || payload.number || Date.now()}`,
  };

  const site = siteFor(lead.site);
  const isPaused = !!site && (await getPaused(event)).indexOf(site.trade) !== -1;

  // ---- Duplicate guard (2026-11-09), same rules as meinhaus-relay.js. A form ref
  // carries the Netlify submission id, so every re-submit is unique by design: that
  // is how one person became leads #1495 and #1496 thirteen hours apart. Matching is
  // therefore on the CONTACT, not the ref. Skipped when a test ref is forced, since
  // that replay is deliberate. Fails open.
  let prior = null;
  if (site && !isPaused && !refOverride) {
    const memoKey = slug(site.label) + '|' + (phone10(lead.phone) || String(lead.email || '').toLowerCase());
    const memo = seen().get(memoKey);
    if (memo && Date.now() - memo.at < 15 * 60000) prior = { leadId: memo.leadId, days: 0, via: 'memo' };
    if (!prior) {
      const r = await recentLead(event, site, lead);
      if (r) prior = Object.assign({ via: 'ledger' }, r);
    }
  }

  let result;
  if (prior) {
    console.log('meinhaus dedupe', site.label, 'matches lead', prior.leadId, 'via', prior.via, prior.days.toFixed(2) + 'd old');
    result = { ok: true, dedupedLocally: true, priorLeadId: prior.leadId, json: { lead: { id: prior.leadId }, isNewLead: false }, body: buildPayload(lead, site) };
  } else {
    result = isPaused ? { ok: false, skipped: 'trade-paused' } : await pushLead(lead);
  }
  if (isPaused) await pausedEmail(lead, site);
  if (site && !prior && result.ok && result.json && result.json.lead) {
    const id = result.json.lead.id;
    seen().set(slug(site.label) + '|' + (phone10(lead.phone) || String(lead.email || '').toLowerCase()), { leadId: id, at: Date.now() });
    await rememberContact(event, site, lead, id);
  }
  if (site) await recordLead(event, lead, site, result, !!hotReasons(lead));
  console.log('meinhaus push', JSON.stringify({ site: host, ref: lead.ref, ok: result.ok, deduped: !!result.dedupedLocally, status: result.status, skipped: result.skipped, leadId: result.json && result.json.lead && result.json.lead.id, isNewLead: result.json && result.json.isNewLead }));
  await auditEmail(lead, result);
  return { statusCode: 200, body: JSON.stringify({ ok: result.ok, skipped: result.skipped || null, status: result.status || null }) };
};

function fileUrls(v) {
  if (!v) return undefined;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(x => (x && (x.url || x)) ).filter(Boolean).join(' ');
  if (v.url) return v.url;
  return undefined;
}
