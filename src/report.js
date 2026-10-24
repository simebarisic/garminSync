const { pool } = require('./db');

const ICON = { green: '🟢', yellow: '🟡', red: '🔴' };
const pad = (v, n) => String(v ?? '–').padStart(n);

async function report(days = 14) {
  const { rows } = await pool.query(
    `SELECT * FROM garmin.recovery_daily
     WHERE calendar_date > (SELECT max(calendar_date) FROM garmin.recovery_daily) - $1::int
     ORDER BY calendar_date`,
    [days]
  );
  if (!rows.length) {
    console.log('Nema podataka – pokreni prvo sync ili backfill.');
    return rows;
  }

  console.log('\n  datum        ukupno  HRV (balans)       RHR  Δ28d   san   score  REM%  BB');
  console.log('  ' + '─'.repeat(78));
  for (const r of rows) {
    const d = String(r.calendar_date).slice(0, 10);
    const bal = r.hrv_bal_low ? `${r.hrv_bal_low}–${r.hrv_bal_upper}` : '';
    const delta = r.rhr_delta == null ? '–' : (r.rhr_delta > 0 ? '+' : '') + Number(r.rhr_delta).toFixed(1);
    console.log(
      `  ${d}   ${ICON[r.recovery] || '⚪'}    ` +
        `${ICON[r.hrv_flag] || ' '}${pad(r.hrv, 4)} ${bal.padEnd(9)}  ` +
        `${ICON[r.rhr_flag] || ' '}${pad(r.rhr, 3)} ${pad(delta, 5)}  ` +
        `${ICON[r.sleep_flag] || ' '}${pad(r.sleep_h == null ? null : Number(r.sleep_h).toFixed(1), 4)}h ${pad(r.sleep_score, 4)}  ` +
        `${pad(r.rem_pct, 4)}  ${pad(r.body_battery_am, 3)}`
    );
  }
  console.log('');
  return rows;
}

module.exports = { report };
