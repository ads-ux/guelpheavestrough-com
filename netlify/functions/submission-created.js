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
const { pushLead, auditEmail } = require('./lib/meinhaus.js');

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

  const result = await pushLead(lead);
  console.log('meinhaus push', JSON.stringify({ site: host, ref: lead.ref, ok: result.ok, status: result.status, skipped: result.skipped, leadId: result.json && result.json.lead && result.json.lead.id, isNewLead: result.json && result.json.isNewLead }));
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
