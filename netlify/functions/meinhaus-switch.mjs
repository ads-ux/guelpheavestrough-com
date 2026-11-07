// Meinhaus control page (2026-10-29)
//   GET  ?status=1          public JSON: which trades/sites are paused (read by the Twilio phone function)
//   GET  ?key=K             the switch page: pause/resume each trade, download the lead sheet
//   POST key=K&trade=T&action=pause|resume
//   GET  ?key=K&csv=1&days=N   download the last N days of the lead sheet (default 30)
//   GET  ?key=K&void=<leadIds>|&voidPhone=<digits>&reason=R[&days=N][&confirm=1]
//                          mark rows pushed in error so the weekly sheet stops counting them
import { getStore } from '@netlify/blobs';
import meinhaus from './lib/meinhaus.js';
import { rowsBetween, toCsv } from './lib/ledger.mjs';

const { SITES } = meinhaus;
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
const norm10 = (p) => { const d = String(p == null ? '' : p).replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : d; };

function trades() {
  const t = {};
  for (const [k, v] of Object.entries(SITES)) {
    if (!v.enabled) continue;
    (t[v.trade] = t[v.trade] || new Set()).add(v.label);
  }
  return Object.keys(t).sort().map(name => ({ name, sites: [...t[name]].sort() }));
}

export default async (req) => {
  const store = getStore({ name: 'meinhaus', consistency: 'strong' });
  const url = new URL(req.url);
  const paused = (await store.get('paused-trades', { type: 'json' }).catch(() => null)) || [];

  if (req.method === 'GET' && url.searchParams.get('status') === '1') {
    const pausedSites = [];
    for (const [k, v] of Object.entries(SITES)) if (v.enabled && paused.includes(v.trade)) pausedSites.push(k);
    return Response.json({ paused, pausedSites }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const KEY = Netlify.env.get('MEINHAUS_SWITCH_KEY') || '';
  let key = url.searchParams.get('key') || '';
  let form = null;
  if (req.method === 'POST') { form = new URLSearchParams(await req.text()); key = form.get('key') || key; }
  if (!KEY || key !== KEY) return new Response('Not found', { status: 404 });

  if (req.method === 'GET' && url.searchParams.get('csv') === '1') {
    const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '30', 10) || 30, 1), 366);
    const rows = await rowsBetween(store, Date.now() - days * 86400000, Date.now());
    return new Response(toCsv(rows), { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="meinhaus-leads-last-${days}-days.csv"` } });
  }

  // ---- 2026-11-07 void action (Mark): mark ledger rows that were pushed in error, so the
  // Monday sheet stops counting them. summary() in ledger.mjs counts status === 'sent' only.
  //   ?key=K&void=1444,1453&reason=junk          by Meinhaus lead id
  //   ?key=K&voidPhone=4168558223&reason=blocked-caller   every row for one number, duplicates included
  // Dry run unless &confirm=1. The original row is copied to void-log/<iso>-<leadId> first.
  if (req.method === 'GET' && (url.searchParams.get('void') || url.searchParams.get('voidPhone'))) {
    const ids = new Set((url.searchParams.get('void') || '').split(',').map(s => s.trim()).filter(Boolean));
    const phones = new Set((url.searchParams.get('voidPhone') || '').split(',').map(norm10).filter(Boolean));
    const reason = ((url.searchParams.get('reason') || 'junk').replace(/[^a-z0-9 -]/gi, '').trim() || 'junk').slice(0, 40);
    const days = Math.min(Math.max(parseInt(url.searchParams.get('days') || '45', 10) || 45, 1), 366);
    const confirm = url.searchParams.get('confirm') === '1';
    const today = new Date().toISOString().slice(0, 10);
    const months = new Set([new Date().toISOString().slice(0, 7)]);
    for (let t = Date.now() - days * 86400000; t <= Date.now(); t += 86400000 * 20) months.add(new Date(t).toISOString().slice(0, 7));
    const hits = [];
    for (const m of months) {
      const { blobs } = await store.list({ prefix: 'ledger/' + m + '/' });
      for (const b of blobs) {
        const row = await store.get(b.key, { type: 'json' });
        if (!row || !String(row.status || '').startsWith('sent')) continue;
        if (!(ids.has(String(row.meinhausLeadId || '')) || phones.has(norm10(row.phone)))) continue;
        hits.push({ key: b.key, row });
      }
    }
    hits.sort((a, b) => (a.row.date < b.row.date ? -1 : 1));
    if (confirm) {
      for (const h of hits) {
        await store.setJSON('void-log/' + new Date().toISOString() + '-' + (h.row.meinhausLeadId || 'x'), h.row);
        await store.setJSON(h.key, Object.assign({}, h.row, { status: 'void: ' + reason + ' (pushed as #' + (h.row.meinhausLeadId || '?') + ' - not billable, retracted ' + today + ')' }));
      }
    }
    return Response.json({
      confirmed: confirm, reason, matched: hits.length,
      rows: hits.map(h => ({ leadId: h.row.meinhausLeadId, site: h.row.site, who: h.row.name || h.row.phone, date: h.row.date, newLead: h.row.newLead, was: h.row.status })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  }

  let note = '';
  if (form) {
    const trade = form.get('trade'), action = form.get('action');
    if (trades().some(t => t.name === trade)) {
      const next = new Set(paused);
      if (action === 'pause') next.add(trade); else next.delete(trade);
      const list = [...next].sort();
      await store.setJSON('paused-trades', list);
      await store.setJSON('switch-log/' + new Date().toISOString(), { trade, action });
      paused.length = 0; paused.push(...list);
      note = `${trade} ${action === 'pause' ? 'paused' : 'turned back on'}.`;
    }
  }

  const rows = trades().map(t => {
    const on = !paused.includes(t.name);
    return `<tr><td><b>${esc(t.name)}</b><div class="s">${esc(t.sites.join(', '))}</div></td>` +
      `<td class="st ${on ? 'on' : 'off'}">${on ? 'On' : 'Paused'}</td>` +
      `<td><form method="post"><input type="hidden" name="key" value="${esc(key)}"><input type="hidden" name="trade" value="${esc(t.name)}">` +
      `<button name="action" value="${on ? 'pause' : 'resume'}">${on ? 'Pause' : 'Turn back on'}</button></form></td></tr>`;
  }).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>Lead switch</title><style>body{font-family:system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#1d1d1f;background:#fff}
h1{font-size:22px}table{width:100%;border-collapse:collapse}td{padding:10px 8px;border-bottom:1px solid #e5e5e5;vertical-align:top}
.s{color:#777;font-size:12px;margin-top:3px}.st{font-weight:600;white-space:nowrap}.on{color:#1f7a3d}.off{color:#b3261e}
button{padding:7px 12px;border-radius:6px;border:1px solid #bbb;background:#f6f6f6;cursor:pointer;white-space:nowrap}.n{background:#eef6ee;padding:10px;border-radius:6px}</style></head>
<body><h1>Lead switch</h1><p>Pause a trade when you can't keep up. Paused leads stop coming to you and go back to WeProvideLeads. Turn it back on any time.</p>
${note ? `<p class="n">${esc(note)}</p>` : ''}<p><a href="?key=${encodeURIComponent(key)}&csv=1&days=30">Download the last 30 days of leads (CSV)</a></p>
<table>${rows}</table></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
};
