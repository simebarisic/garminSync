const garmin = require('./garmin');
const { sleepRows, hrvRows, wellnessRows, activityRows, activityList, fitnessAgeRow } = require('./parse');
const { pool, saveRaw, upsert } = require('./db');
const { chunks, addDays } = require('./dates');

// 28 dana po pozivu – ispod svih poznatih Garmin limita (daily summaries puca >~90, sleep 31)
const CHUNK_DAYS = 28;
const ACTIVITY_PAGE = parseInt(process.env.ACTIVITY_PAGE || '40', 10); // Garmin puca na stranicama > ~45
const PAUSE_MS = parseInt(process.env.PAUSE_MS || '1000', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SOURCES = [
  { endpoint: 'sleep-summaries', table: 'sleep_daily', fetch: garmin.sleepSummaries, parse: sleepRows },
  { endpoint: 'hrv-summaries', table: 'hrv_daily', fetch: garmin.hrvSummaries, parse: hrvRows },
  { endpoint: 'daily-summaries', table: 'wellness_daily', fetch: garmin.dailySummaries, parse: wellnessRows },
];

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function fetchActivities(start, end) {
  const all = [];
  for (let offset = 0; offset < 2000; offset += ACTIVITY_PAGE) {
    const page = await garmin.activities(start, end, offset, ACTIVITY_PAGE);
    const list = activityList(page);
    all.push(...list);
    if (list.length < ACTIVITY_PAGE) break;
    await sleep(PAUSE_MS);
  }
  return all;
}

// Fitness Age se sporo mijenja: za kratke raspone samo zadnji dan, za backfill tjedno
function fitnessAgeDates(from, to) {
  const out = [to];
  for (let d = addDays(to, -7); d >= from; d = addDays(d, -7)) out.push(d);
  return out;
}

async function syncRange(from, to, kind = 'sync') {
  const totals = { sleep_daily: 0, hrv_daily: 0, wellness_daily: 0, activities: 0, fitness_age: 0 };
  const errors = [];
  let authError = false;
  const fail = (what, e) => {
    console.error(`  ❌ ${what}: ${e.message}`);
    errors.push(`${what}: ${e.message.slice(0, 160)}`);
    if (/^Token: HTTP (401|403)/.test(e.message)) authError = true;
  };

  const { rows: [log] } = await pool.query(
    `INSERT INTO garmin.sync_log (kind, range_start, range_end) VALUES ($1, $2, $3) RETURNING id`,
    [kind, from, to]
  );

  const parts = chunks(from, to, CHUNK_DAYS);
  for (const [start, end] of parts) {
    if (parts.length > 1) console.log(`  📅 ${start} → ${end}`);

    for (const src of SOURCES) {
      if (authError) break;
      try {
        const payload = await src.fetch(start, end);
        totals[src.table] += await tx(async (c) => {
          await saveRaw(c, src.endpoint, start, end, payload);
          return upsert(c, src.table, src.parse(payload));
        });
      } catch (e) {
        fail(`${src.endpoint} ${start}→${end}`, e);
      }
      await sleep(PAUSE_MS);
    }

    if (authError) break;
    try {
      const list = await fetchActivities(start, end);
      totals.activities += await tx((c) => upsert(c, 'activities', activityRows(list), 'activity_id'));
    } catch (e) {
      fail(`activities ${start}→${end}`, e);
    }
    await sleep(PAUSE_MS);
  }

  if (!authError) {
    for (const d of fitnessAgeDates(from, to)) {
      try {
        const row = fitnessAgeRow(d, await garmin.fitnessAge(d));
        if (row) totals.fitness_age += await tx((c) => upsert(c, 'fitness_age', [row]));
      } catch (e) {
        // Fitness Age nije ključan – bilježi, ali ne ruši sync
        fail(`fitness-age ${d}`, e);
      }
      await sleep(PAUSE_MS);
    }
  }

  await pool.query(
    `UPDATE garmin.sync_log SET finished_at = now(), ok = $2, errors = $3, rows = $4 WHERE id = $1`,
    [log.id, errors.length === 0, errors, JSON.stringify(totals)]
  );

  console.log(
    `  ${errors.length ? '⚠️ ' : '✅'} ${from} → ${to}: san ${totals.sleep_daily}, HRV ${totals.hrv_daily}, ` +
      `wellness ${totals.wellness_daily}, aktivnosti ${totals.activities}, fitness age ${totals.fitness_age}` +
      (errors.length ? ` · ${errors.length} grešaka` : '')
  );
  return { totals, errors, authError };
}

module.exports = { syncRange };
