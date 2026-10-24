// Datumi kao 'YYYY-MM-DD' stringovi u zadanoj vremenskoj zoni (default Europe/Zagreb).
const TZ = process.env.TZ_NAME || process.env.TZ || 'Europe/Zagreb';

const fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

const today = () => fmtDate.format(new Date());
const nowHHMM = () => fmtTime.format(new Date());

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

// Podijeli [from, to] na komade od najviše `size` dana
function chunks(from, to, size) {
  const out = [];
  for (let s = from; s <= to; s = addDays(s, size)) {
    const e = addDays(s, size - 1);
    out.push([s, e < to ? e : to]);
  }
  return out;
}

module.exports = { TZ, today, nowHHMM, addDays, isYmd, chunks };
