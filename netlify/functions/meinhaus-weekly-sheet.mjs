// Every Monday morning: email Mark last week's Meinhaus lead sheet (CSV attached)
// so he can forward it to Meinhaus. Mark sends it himself. 2026-10-29.
import { getStore } from '@netlify/blobs';
import { rowsBetween, toCsv, summary } from './lib/ledger.mjs';

export default async () => {
  const key = Netlify.env.get('RESEND_API_KEY') || Netlify.env.get('weprovideleadsnetlify');
  const to = (Netlify.env.get('MAIL_INTERNAL') || 'mark@weprovideleads.com').split(',').map(s => s.trim()).filter(Boolean);
  const toMs = Date.now(), fromMs = toMs - 7 * 86400000;
  const rows = await rowsBetween(getStore('meinhaus'), fromMs, toMs);
  const s = summary(rows);
  const day = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/Toronto', month: 'short', day: 'numeric' });
  const trades = Object.entries(s.byTrade).sort((a, b) => b[1] - a[1]).map(([t, n]) => `<li>${t}: ${n}</li>`).join('');
  const html = `<div style="font-family:sans-serif"><h3>Meinhaus lead sheet, ${day(fromMs)} to ${day(toMs)}</h3>` +
    `<p><b>${s.sent}</b> leads sent (${s.newLeads} new, ${s.sent - s.newLeads} duplicates), <b>${s.hot}</b> marked HOT.</p>` +
    (trades ? `<ul>${trades}</ul>` : '') + `<p>The full list is attached. Forward this to Meinhaus when you're ready.</p></div>`;
  if (!key) { console.log('weekly sheet: no Resend key'); return; }
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: Netlify.env.get('MAIL_FROM') || 'WeProvideLeads <hello@weprovideleads.com>', to,
      subject: `Meinhaus weekly lead sheet: ${s.sent} leads, ${day(fromMs)} to ${day(toMs)}`, html,
      attachments: [{ filename: `meinhaus-leads-${new Date(toMs).toISOString().slice(0, 10)}.csv`, content: Buffer.from(toCsv(rows)).toString('base64') }] }) });
  console.log('weekly sheet sent', r.status, s.sent);
};

// Mondays 12:47 UTC (8:47 am Toronto in summer time, 7:47 am in winter)
export const config = { schedule: '47 12 * * 1' };
