#!/usr/bin/env node
/**
 * garmin-sync – san, HRV, wellness, aktivnosti i Fitness Age s Garmin Personal API-ja u Postgres.
 *
 *   node src/index.js sync [--days 3]            zadnjih N dana (uključujući danas)
 *   node src/index.js backfill --from 2025-01-01 [--to 2026-10-23]
 *   node src/index.js report [--days 14]         tablica oporavka u terminalu
 *   node src/index.js bioage [--all]             (ponovno) izračunaj biološku dob
 *   node src/index.js notify-test                pošalji jutarnju poruku odmah
 *   node src/index.js daemon                     raspored iz SYNC_TIMES (za Docker)
 */
const { migrate, pool } = require('./db');
const { syncRange } = require('./sync');
const { report } = require('./report');
const { computeBioAge } = require('./bioage');
const notify = require('./notify');
const { TZ, today, nowHHMM, addDays, isYmd } = require('./dates');

const args = process.argv.slice(2);
const cmd = args[0] || 'sync';
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

// Garmin naknadno dorađuje podatke (HRV/san se potvrdi ujutro), pa uvijek
// ponovno povučemo zadnjih par dana – upsert to čini sigurnim.
const DEFAULT_DAYS = parseInt(process.env.SYNC_DAYS || '3', 10);
const SYNC_TIMES = (process.env.SYNC_TIMES || '09:30,21:30').split(',').map((s) => s.trim()).filter(Boolean);
const MORNING_SLOT = SYNC_TIMES[0]; // jutarnja poruka ide nakon prvog synca u danu
const MORNING_ENABLED = (process.env.MORNING_MESSAGE || 'true') !== 'false';

async function runSync(days) {
  const to = today();
  const from = addDays(to, -(days - 1));
  console.log(`🔄 sync ${from} → ${to}`);
  const result = await syncRange(from, to, 'sync');
  await computeBioAge({ days: 30 }).catch((e) => console.error('  ❌ bioage:', e.message));
  return result;
}

async function scheduled(hm) {
  try {
    const result = await runSync(DEFAULT_DAYS);
    await notify.alertsAfterSync(result);
    if (hm === MORNING_SLOT && MORNING_ENABLED && !result.authError) await notify.sendMorning();
    await report(3);
  } catch (e) {
    console.error('❌', e.message);
    await notify.alert('crash', `Sync se srušio: <code>${String(e.message).slice(0, 300)}</code>`).catch(() => {});
  }
}

async function daemon() {
  console.log(`🕒 daemon: sync u ${SYNC_TIMES.join(', ')} (${TZ}), zadnjih ${DEFAULT_DAYS} dana; ` +
    `jutarnja poruka ${MORNING_ENABLED ? `u ${MORNING_SLOT}` : 'isključena'}; Telegram ${notify.enabled() ? 'uključen' : 'nije podešen'}`);
  // odmah pri pokretanju – bez jutarnje poruke, da restart ne šalje duplikat
  const r = await runSync(DEFAULT_DAYS).catch((e) => (console.error('❌', e.message), null));
  if (r) await notify.alertsAfterSync(r).catch(() => {});

  let lastKey = null;
  setInterval(() => {
    const hm = nowHHMM();
    const key = `${today()} ${hm}`;
    if (!SYNC_TIMES.includes(hm) || key === lastKey) return;
    lastKey = key;
    scheduled(hm);
  }, 20 * 1000);
}

async function main() {
  await migrate();

  switch (cmd) {
    case 'sync':
      await runSync(parseInt(opt('days', DEFAULT_DAYS), 10));
      break;

    case 'backfill': {
      const from = opt('from');
      const to = opt('to', today());
      if (!isYmd(from) || !isYmd(to)) throw new Error('Koristi: backfill --from YYYY-MM-DD [--to YYYY-MM-DD]');
      console.log(`⏪ backfill ${from} → ${to}`);
      await syncRange(from, to, 'backfill');
      await computeBioAge({ all: true });
      break;
    }

    case 'report':
      await report(parseInt(opt('days', '14'), 10));
      break;

    case 'bioage':
      await computeBioAge(flag('all') ? { all: true } : { days: parseInt(opt('days', '30'), 10) });
      break;

    case 'notify-test': {
      const msg = await notify.morningMessage();
      if (!msg) console.log('Nema podataka za poruku.');
      else console.log((await notify.send(msg)) ? '📨 poslano' : '(nije poslano)');
      break;
    }

    case 'daemon':
      return daemon(); // ostaje živ

    default:
      throw new Error(`Nepoznata naredba: ${cmd} (sync | backfill | report | bioage | notify-test | daemon)`);
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error('❌', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

process.on('SIGTERM', async () => {
  await pool.end().catch(() => {});
  process.exit(0);
});
