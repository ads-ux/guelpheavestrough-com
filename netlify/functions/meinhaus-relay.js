// ============================================================================
// POST /.netlify/functions/meinhaus-relay
//
// Generic inbound relay: anything that is NOT a Netlify form on this site
// (today: the Twilio voicemail/SMS function) posts a normalised lead here and
// we forward it to Meinhaus. Protected by a shared key so nobody can inject
// leads into Erik's account.
//
//   Header:  X-WPL-Key: <WPL_RELAY_KEY>      (or ?key= in the query string)
//   Body:    JSON { site, source, name, email, phone, address, message, extra, ref }
//              site   = Twilio PHONE_CONFIG label ("Guelph Eavestrough") or hostname
//              ref    = optional; defaults to wpl-<site>-<phone digits> so the same
//                       caller within 14 days is NOT double-created at Meinhaus
//
// Env vars: MEINHAUS_API_TOKEN (Secret), WPL_RELAY_KEY (Secret), RESEND_API_KEY (opt)
// ============================================================================
const { pushLead, auditEmail, siteFor, slug, digits } = require('./lib/meinhaus.js');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return resp(405, { error: 'POST only' });

  const expected = process.env.WPL_RELAY_KEY || '';
  const given = (event.headers && (event.headers['x-wpl-key'] || event.headers['X-WPL-Key'])) ||
                (event.queryStringParameters && event.queryStringParameters.key) || '';
  if (!expected || given !== expected) return resp(401, { error: 'bad key' });

  let lead;
  try { lead = JSON.parse(event.body || '{}'); } catch (e) { return resp(400, { error: 'bad json' }); }

  // A Netlify Forms "outgoing webhook" notification from another WPL site posts the raw
  // submission object here (has .data + .site_url). Normalise it so satellite sites need
  // no functions of their own — just a notification hook pointing at this URL.
  if (lead && lead.data && (lead.site_url || lead.form_name) && !lead.site) {
    const d = lead.data || {};
    const host = String(lead.site_url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    const msg = String(d.message || d.details || d.description || '').trim();
    lead = {
      site: host,
      source: `web form (${lead.form_name || 'contact'})`,
      name: d.name || [d.first_name, d.last_name].filter(Boolean).join(' '),
      email: d.email,
      phone: d.phone || d.tel,
      address: d.address || d.property_address,
      message: msg,
      extra: { 'Service requested': d.service, 'Photos/video': fileUrls(d.photos), 'Submitted': lead.created_at, 'Page': lead.site_url ? `${lead.site_url}/` : undefined },
      ref: `wpl-${host.replace(/\W+/g, '-')}-form-${lead.id || lead.number || Date.now()}`,
    };
  }

  const site = siteFor(lead.site);
  if (!site) return resp(200, { ok: false, skipped: 'site-not-mapped', site: lead.site });

  lead.source = lead.source || 'phone';
  lead.ref = lead.ref || `wpl-${slug(site.label)}-${digits(lead.phone) || Date.now()}`;

  const dryRun = event.queryStringParameters && event.queryStringParameters.dryrun === '1';
  const result = await pushLead(lead, { dryRun });
  console.log('meinhaus relay', JSON.stringify({ site: site.key, ref: lead.ref, ok: result.ok, status: result.status, skipped: result.skipped, dryRun: !!dryRun, leadId: result.json && result.json.lead && result.json.lead.id, isNewLead: result.json && result.json.isNewLead }));
  if (!dryRun) await auditEmail(lead, result);
  return resp(200, { ok: result.ok, skipped: result.skipped || null, status: result.status || null, leadId: result.json && result.json.lead ? result.json.lead.id : null, isNewLead: result.json ? result.json.isNewLead : null, dryRun: !!dryRun, body: dryRun ? result.body : undefined });
};

function fileUrls(v) {
  if (!v) return undefined;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(x => (x && (x.url || x))).filter(Boolean).join(' ');
  if (v.url) return v.url;
  return undefined;
}

function resp(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
