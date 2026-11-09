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
//              ref    = optional; defaults to wpl-<site>-<10 digit phone>
//
// Duplicates are stopped on OUR side (2026-11-09), not Meinhaus's: see the
// duplicate guard below and recentLead()/rememberContact() in lib/store.js.
// Window: MEINHAUS_DEDUPE_DAYS, default 14.
//
// Env vars: MEINHAUS_API_TOKEN (Secret), WPL_RELAY_KEY (Secret), RESEND_API_KEY (opt)
// ============================================================================
const { pushLead, auditEmail, pausedEmail, hotReasons, siteFor, slug, digits, buildPayload } = require('./lib/meinhaus.js');
const { getPaused, recordLead, recentLead, rememberContact, DEDUPE_DAYS } = require('./lib/store.js');

// Same caller must give the same ref on every lane. The call lane sends +1519…,
// the text lane sends 519…; unnormalised that created leads #1503 and #1504 for
// one person on 2026-11-09. Last 10 digits, always.
const phone10 = (p) => { const d = String(p == null ? '' : p).replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : d; };
// Seconds-apart doubles (a voicemail and its text reply) can land before the
// Blobs index is readable, so a warm container also remembers what it just sent.
const seen = () => { const g = (typeof globalThis !== 'undefined' ? globalThis : global); return (g.__mhSeen = g.__mhSeen || new Map()); };

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
  lead.ref = lead.ref || `wpl-${slug(site.label)}-${phone10(lead.phone) || Date.now()}`;

  const dryRun = event.queryStringParameters && event.queryStringParameters.dryrun === '1';
  const paused = await getPaused(event);
  const isPaused = paused.indexOf(site.trade) !== -1;

  // ---- Duplicate guard. Meinhaus's own ~14-day window is not reliable (three
  // real duplicates were created on 2026-09-21 by replaying identical refs), so
  // we decide on our side. Two layers, both fail open: a warm-container memo for
  // doubles seconds apart, then the Blobs contact index for hours or days apart.
  // On a hit we do NOT create a second lead; the new detail is mailed against the
  // lead that already exists, which is what dupDetailEmail() is for.
  let prior = null;
  // Evaluated on dry runs too, so the guard is testable without creating a lead.
  // Only the memo and index WRITES are gated on !dryRun, further down.
  if (!isPaused) {
    const memoKey = slug(site.label) + '|' + (phone10(lead.phone) || String(lead.email || '').toLowerCase());
    const memo = seen().get(memoKey);
    if (memo && Date.now() - memo.at < 15 * 60000) prior = { leadId: memo.leadId, date: new Date(memo.at).toISOString(), days: 0, via: 'memo' };
    if (!prior) {
      const r = await recentLead(event, site, lead);
      if (r) prior = Object.assign({ via: 'ledger' }, r);
    }
  }

  let result;
  if (prior) {
    console.log('meinhaus dedupe', site.label, 'matches lead', prior.leadId, 'via', prior.via, prior.days.toFixed(2) + 'd old');
    result = { ok: true, dedupedLocally: true, dryRun: !!dryRun, priorLeadId: prior.leadId, json: { lead: { id: prior.leadId }, isNewLead: false }, body: buildPayload(lead, site) };
  } else {
    result = isPaused ? { ok: false, skipped: 'trade-paused' } : await pushLead(lead, { dryRun });
  }
  if (isPaused) await pausedEmail(lead, site);
  if (!dryRun && !prior && result.ok && result.json && result.json.lead) {
    const id = result.json.lead.id;
    seen().set(slug(site.label) + '|' + (phone10(lead.phone) || String(lead.email || '').toLowerCase()), { leadId: id, at: Date.now() });
    await rememberContact(event, site, lead, id);
  }
  if (!dryRun) await recordLead(event, lead, site, result, !!hotReasons(lead));
  console.log('meinhaus relay', JSON.stringify({ site: site.key, ref: lead.ref, ok: result.ok, status: result.status, skipped: result.skipped, dryRun: !!dryRun, deduped: !!result.dedupedLocally, leadId: result.json && result.json.lead && result.json.lead.id, isNewLead: result.json && result.json.isNewLead }));
  if (!dryRun) await auditEmail(lead, result);
  return resp(200, { ok: result.ok, deduped: !!result.dedupedLocally, dedupeOf: result.priorLeadId || null, skipped: result.skipped || null, status: result.status || null, leadId: result.json && result.json.lead ? result.json.lead.id : null, isNewLead: result.json ? result.json.isNewLead : null, dryRun: !!dryRun, body: dryRun ? result.body : undefined });
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
