/**
 * Biološka dob – transparentan model po uzoru na WHOOP Age.
 *
 * NIJE validiran medicinski model. Svaka metrika daje pomak u "godinama" prema
 * grubim pragovima iz javnih smjernica i populacijskih studija (WHO aktivnost,
 * koraci/mortalitet, mirovni puls, trajanje i pravilnost sna). Pragovi su ispod
 * u jednom mjestu – mijenjaj ih slobodno. Najkorisniji je TREND, ne apsolutni broj.
 *
 *   bio_age      = kronološka dob + Σ pomaka, na zadnjih 180 dana
 *   bio_age_30d  = isti model na zadnjih 30 dana
 *   trend_years  = bio_age_30d − bio_age   (> 0 → zadnji mjesec lošiji od prosjeka)
 */
const { pool } = require('./db');
const garmin = require('./garmin');
const { TZ, addDays } = require('./dates');

// [gornja granica (isključivo), pomak u godinama]; zadnji red = sve iznad
const step = (table) => (v) => {
  for (const [limit, years] of table) if (v < limit) return years;
  return table[table.length - 1][1];
};

const MODEL = {
  // prosječni dnevni koraci
  steps: step([[4000, 3], [6000, 1.5], [8000, 0.5], [10000, 0], [12000, -1], [Infinity, -1.5]]),
  // prosječni mirovni puls (bpm)
  restingHr: step([[50, -2], [55, -1.5], [60, -1], [65, 0], [70, 0.5], [75, 1.5], [Infinity, 3]]),
  // prosječni sati sna po noći
  sleepHours: step([[6, 2], [7, 0.5], [9, 0], [Infinity, 1]]),
  // standardna devijacija sredine sna (min) – pravilnost ritma
  sleepConsistency: step([[30, -0.5], [60, 0], [90, 0.5], [Infinity, 1.5]]),
  // tjedni intenzitet: umjerene min + 2 × intenzivne (WHO: 150–300)
  intensityWeekly: step([[75, 2], [150, 1], [300, 0], [600, -1], [Infinity, -1.5]]),
  // treninzi snage tjedno (WHO: ≥ 2 dana)
  strengthWeekly: step([[1, 1], [2, 0], [Infinity, -1]]),
  // Garmin Fitness Age (VO2 max, RHR, BMI, aktivnost) – pola razlike, max ±4
  fitnessAge: (diff) => Math.max(-4, Math.min(4, diff * 0.5)),
};

const WINDOW_MAIN = 180;
const WINDOW_TREND = 30;
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const sd = (a) => {
  if (a.length < 2) return null;
  const m = avg(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};

function yearsBetween(birth, date) {
  return (new Date(`${date}T00:00:00Z`) - new Date(`${birth}T00:00:00Z`)) / (365.2425 * 86400000);
}

let birthCache;
async function resolveBirthDate() {
  if (birthCache !== undefined) return birthCache;
  birthCache = /^\d{4}-\d{2}-\d{2}$/.test(process.env.BIRTH_DATE || '') ? process.env.BIRTH_DATE : null;
  if (!birthCache) {
    try {
      const s = await garmin.userSettings();
      const b = s?.userData?.birthDate || s?.birthDate;
      if (/^\d{4}-\d{2}-\d{2}/.test(b || '')) birthCache = b.slice(0, 10);
    } catch {
      /* nema – fallback na Fitness Age */
    }
  }
  return birthCache;
}

async function loadData() {
  const q = (sql, p = []) => pool.query(sql, p).then((r) => r.rows);
  const [sleep, well, strength, anyAct, fa] = await Promise.all([
    q(
      `SELECT calendar_date, sleep_s,
         -- sredina sna u minutama od podneva (lokalno), da ponoć ne "lomi" prosjek
         (( extract(epoch FROM ((sleep_start + (sleep_end - sleep_start) / 2) AT TIME ZONE $1)::time) / 60
            - 720 + 1440)::int % 1440) AS mid_from_noon
       FROM garmin.sleep_daily WHERE sleep_s > 3 * 3600`,
      [TZ]
    ),
    q(`SELECT calendar_date, steps, resting_hr,
         COALESCE(intensity_moderate, 0) + 2 * COALESCE(intensity_vigorous, 0) AS intensity
       FROM garmin.wellness_daily`),
    q(`SELECT DISTINCT calendar_date FROM garmin.activities WHERE type_key = 'strength_training'`),
    q(`SELECT min(calendar_date) AS first FROM garmin.activities`),
    q(`SELECT calendar_date, chronological_age, fitness_age FROM garmin.fitness_age ORDER BY calendar_date`),
  ]);
  const byDate = (rows) => new Map(rows.map((r) => [r.calendar_date, r]));
  return {
    sleep: byDate(sleep),
    well: byDate(well),
    strength: new Set(strength.map((r) => r.calendar_date)),
    activitiesSince: anyAct[0]?.first || null,
    fitnessAge: fa,
  };
}

function windowDates(end, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(addDays(end, -i));
  return out;
}

// Izračun za jedan prozor; vraća null ako nema dovoljno podataka
function evaluate(data, end, days, chronoAge) {
  const dates = windowDates(end, days);
  const W = dates.map((d) => data.well.get(d)).filter(Boolean);
  const S = dates.map((d) => data.sleep.get(d)).filter(Boolean);
  const minDays = days >= WINDOW_MAIN ? 30 : 21;
  if (W.length < minDays) return null;

  // metrika ulazi u izračun tek s dovoljno dana (180d prozor: 30, 30d prozor: 10)
  const enough = (arr) => arr.length >= Math.min(minDays, Math.max(10, days / 3));
  const comp = {};
  const add = (key, value, fn) => {
    if (value == null || Number.isNaN(value)) return;
    comp[key] = { value: round1(value), years: round1(fn(value)) };
  };

  const steps = W.map((r) => r.steps).filter((x) => x != null);
  if (enough(steps)) add('koraci', avg(steps), MODEL.steps);

  const rhr = W.map((r) => r.resting_hr).filter((x) => x != null);
  if (enough(rhr)) add('mirovni_puls', avg(rhr), MODEL.restingHr);

  if (enough(S)) {
    add('san_sati', avg(S.map((r) => r.sleep_s / 3600)), MODEL.sleepHours);
    add('san_pravilnost_min', sd(S.map((r) => r.mid_from_noon)), MODEL.sleepConsistency);
  }

  const inten = W.map((r) => r.intensity);
  if (enough(inten)) add('intenzitet_tjedno', avg(inten) * 7, MODEL.intensityWeekly);

  // snagu brojimo samo ako se aktivnosti uopće bilježe od početka prozora
  if (data.activitiesSince && data.activitiesSince <= dates[0]) {
    const n = dates.filter((d) => data.strength.has(d)).length;
    add('snaga_tjedno', (n / days) * 7, MODEL.strengthWeekly);
  }

  const fa = [...data.fitnessAge].reverse().find((r) => r.calendar_date <= end && r.fitness_age != null);
  if (fa && chronoAge != null) add('garmin_fitness_age_razlika', Number(fa.fitness_age) - chronoAge, MODEL.fitnessAge);

  const total = Object.values(comp).reduce((s, c) => s + c.years, 0);
  return { bio: round1(chronoAge + Math.max(-12, Math.min(12, total))), comp, days: W.length };
}

async function computeBioAge({ days = 30, all = false } = {}) {
  const data = await loadData();
  if (!data.well.size) return 0;
  const birth = await resolveBirthDate();
  const dates = [...data.well.keys()].sort();
  const last = dates[dates.length - 1];
  const first = all ? dates[0] : addDays(last, -(days - 1));

  const rows = [];
  for (let d = first; d <= last; d = addDays(d, 1)) {
    let chrono = birth ? yearsBetween(birth, d) : null;
    if (chrono == null) {
      const fa = [...data.fitnessAge].reverse().find((r) => r.calendar_date <= d && r.chronological_age != null)
        || data.fitnessAge.find((r) => r.chronological_age != null);
      chrono = fa ? Number(fa.chronological_age) : null;
    }
    if (chrono == null) continue;

    const main = evaluate(data, d, WINDOW_MAIN, chrono);
    if (!main) continue;
    const recent = evaluate(data, d, WINDOW_TREND, chrono);
    rows.push([d, round1(chrono), main.bio, recent?.bio ?? null,
      recent ? round1(recent.bio - main.bio) : null, main.days, JSON.stringify(main.comp)]);
  }

  if (!rows.length) {
    if (!birth && !data.fitnessAge.length) console.log('  ℹ️  biološka dob: postavi BIRTH_DATE u .env (ili pričekaj Fitness Age s Garmina)');
    return 0;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of rows) {
      await client.query(
        `INSERT INTO garmin.bio_age_daily
           (calendar_date, chronological_age, bio_age, bio_age_30d, trend_years, data_days, components)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (calendar_date) DO UPDATE SET chronological_age = EXCLUDED.chronological_age,
           bio_age = EXCLUDED.bio_age, bio_age_30d = EXCLUDED.bio_age_30d, trend_years = EXCLUDED.trend_years,
           data_days = EXCLUDED.data_days, components = EXCLUDED.components, updated_at = now()`,
        r
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const l = rows[rows.length - 1];
  console.log(`  🧬 biološka dob ${l[0]}: ${l[2]} (kronološka ${l[1]}, trend ${l[4] ?? '–'})`);
  return rows.length;
}

module.exports = { computeBioAge, MODEL, evaluate };
