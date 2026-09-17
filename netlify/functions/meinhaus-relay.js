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

function resp(statusCode, obj) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
