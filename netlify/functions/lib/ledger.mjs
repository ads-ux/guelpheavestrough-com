// Builds the Meinhaus lead sheet (CSV) from the ledger rows in Blobs. 2026-10-29.
const COLS = [['date', 'Date (Toronto)'], ['site', 'Site'], ['trade', 'Trade'], ['source', 'How they reached us'], ['name', 'Customer'], ['phone', 'Phone'], ['email', 'Email'], ['address', 'Address'], ['hot', 'HOT'], ['meinhausLeadId', 'Meinhaus lead #'], ['newLead', 'New or duplicate'], ['status', 'Status'], ['ref', 'Our reference']];
const esc = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const toronto = (iso) => new Date(iso).toLocaleString('en-CA', { timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

export async function rowsBetween(store, fromMs, toMs) {
  const months = new Set();
  for (let t = fromMs; t <= toMs + 86400000 * 31; t += 86400000 * 27) months.add(new Date(Math.min(t, toMs)).toISOString().slice(0, 7));
  months.add(new Date(toMs).toISOString().slice(0, 7));
  const rows = [];
  for (const m of months) {
    const { blobs } = await store.list({ prefix: 'ledger/' + m + '/' });
    for (const b of blobs) {
      const iso = b.key.split('/')[2].slice(0, 24);
      const t = Date.parse(iso);
      if (!(t >= fromMs && t < toMs)) continue;
      const r = await store.get(b.key, { type: 'json' });
      if (r) rows.push(r);
    }
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  return rows;
}

export function toCsv(rows) {
  const out = [COLS.map(c => c[1]).join(',')];
  for (const r of rows) out.push(COLS.map(([k]) => esc(k === 'date' ? toronto(r.date) : r[k])).join(','));
  return out.join('\n') + '\n';
}

export function summary(rows) {
  const sent = rows.filter(r => r.status === 'sent');
  const byTrade = {};
  for (const r of sent) byTrade[r.trade] = (byTrade[r.trade] || 0) + 1;
  return { total: rows.length, sent: sent.length, newLeads: sent.filter(r => r.newLead === 'new').length, hot: sent.filter(r => r.hot).length, byTrade };
}
