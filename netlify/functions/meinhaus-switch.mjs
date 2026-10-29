// Meinhaus control page (2026-10-29)
//   GET  ?status=1          public JSON: which trades/sites are paused (read by the Twilio phone function)
//   GET  ?key=K             the switch page: pause/resume each trade, download the lead sheet
//   POST key=K&trade=T&action=pause|resume
//   GET  ?key=K&csv=1&days=N   download the last N days of the lead sheet (default 30)
import { getStore } from '@netlify/blobs';
import meinhaus from './lib/meinhaus.js';
import { rowsBetween, toCsv } from './lib/ledger.mjs';

const { SITES } = meinhaus;
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function trades() {
  const t = {};
  for (const [k, v] of Object.entries(SITES)) {
    if (!v.enabled) continue;
    (t[v.trade] = t[v.trade] || new Set()).add(v.label);
  }
  return Object.keys(t).sort().map(name => ({ name, sites: [...t[name]].sort() }));
}

export default async (req) => {
  const store = getStore('meinhaus');
  const url = new URL(req.url);
  const paused = (await store.get('paused-trades', { type: 'json' }).catch(() => null)) || [];

  if (req.method === 'GET' && url.searchParams.get('status') === '1') {
    const pausedSites = [];
    for (const [k, v] of Object.entries(SITES)) if (v.enabled && paused.includes(v.trade)) pausedSites.push(k);
    return Response.json({ paused, pausedSites }, { headers: { 'Cache-Control': 'public, max-age=30' } });
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
