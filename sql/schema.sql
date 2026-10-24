-- =============================================================================
-- Garmin Tracker – shema za praćenje oporavka
-- Postgres 14+. Sve u zasebnoj shemi "garmin" da ne miješa s drugim appovima.
--
-- Konvencija datuma: calendar_date = dan BUĐENJA (isto kao Garmin za san i HRV).
-- Dnevne metrike (stres, koraci, intensity) su za cijeli kalendarski dan, pa u
-- recovery viewu gledamo JUČERAŠNJE opterećenje uz JUTROŠNJI oporavak.
-- =============================================================================

CREATE SCHEMA IF NOT EXISTS garmin;

-- -----------------------------------------------------------------------------
-- Sirovi odgovori – sve što Garmin vrati, da možemo naknadno izvući nova polja
-- bez ponovnog povlačenja.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS garmin.raw_payload (
    endpoint     text        NOT NULL,          -- 'sleep-summaries', 'hrv-summaries', 'daily-summaries'
    range_start  date        NOT NULL,
    range_end    date        NOT NULL,
    fetched_at   timestamptz NOT NULL DEFAULT now(),
    payload      jsonb       NOT NULL,
    PRIMARY KEY (endpoint, range_start, range_end)
);

-- -----------------------------------------------------------------------------
-- San  ← /sleep-service/sleep/dailySleepSummariesByDate
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS garmin.sleep_daily (
    calendar_date          date PRIMARY KEY,
    sleep_start            timestamptz,      -- sleepStartTimestampGMT (epoch ms)
    sleep_end              timestamptz,      -- sleepEndTimestampGMT
    sleep_s                int,              -- sleepTimeSeconds
    deep_s                 int,
    light_s                int,
    rem_s                  int,
    awake_s                int,
    awake_count            smallint,
    sleep_score            smallint,         -- sleepScores.overall.value
    sleep_score_qualifier  text,             -- sleepScores.overall.qualifierKey
    avg_sleep_hr           smallint,         -- avgHeartRate
    avg_sleep_stress       smallint,         -- avgSleepStress
    avg_respiration        numeric(4,1),     -- averageRespirationValue
    avg_spo2               smallint,         -- averageSpO2Value
    lowest_spo2            smallint,
    sleep_need_min         smallint,         -- sleepNeed.actual (Garminova procjena potrebe, min)
    score_feedback         text,             -- sleepScoreFeedback
    updated_at             timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- HRV  ← /hrv-service/hrv/daily/{start}/{end}
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS garmin.hrv_daily (
    calendar_date            date PRIMARY KEY,
    last_night_avg           smallint,       -- lastNightAvg (ms)
    last_night_5min_high     smallint,
    weekly_avg               smallint,
    baseline_low_upper       smallint,       -- ispod ovoga = LOW
    baseline_balanced_low    smallint,       -- balanced raspon: [balanced_low, balanced_upper]
    baseline_balanced_upper  smallint,
    status                   text,           -- BALANCED / UNBALANCED / LOW / POOR
    updated_at               timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Dnevni wellness  ← /usersummary-service/v2/dailysummaries  (data[])
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS garmin.wellness_daily (
    calendar_date        date PRIMARY KEY,
    resting_hr           smallint,           -- heartRate.restingValue
    min_hr               smallint,
    max_hr               smallint,
    steps                int,                -- movement.steps.value
    active_kcal          int,                -- calories.burnedActive
    intensity_moderate   smallint,           -- intensityMinutes.moderate
    intensity_vigorous   smallint,
    stress_avg           smallint,           -- stress.avgLevel
    stress_max           smallint,
    stress_qualifier     text,
    high_stress_s        int,                -- stress.highStressDurationInMillis / 1000
    bb_min               smallint,           -- bodyBattery.minValue
    bb_max               smallint,           -- bodyBattery.maxValue (≈ jutarnja vrijednost)
    bb_charged           smallint,
    bb_drained           smallint,
    respiration_avg      numeric(4,1),
    spo2_avg             smallint,
    updated_at           timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Aktivnosti  ← /activitylist-service/activities/search/activities
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS garmin.activities (
    activity_id     bigint PRIMARY KEY,
    calendar_date   date NOT NULL,           -- lokalni datum početka
    start_local     timestamp,
    start_gmt       timestamptz,
    type_key        text,                    -- strength_training, running, cycling, ...
    name            text,
    duration_s      int,
    distance_m      numeric(10,1),
    avg_hr          smallint,
    max_hr          smallint,
    calories        int,
    aerobic_te      numeric(3,1),            -- Training Effect 0–5
    anaerobic_te    numeric(3,1),
    training_load   numeric(7,1),
    hr_zone1_s      int,
    hr_zone2_s      int,
    hr_zone3_s      int,
    hr_zone4_s      int,
    hr_zone5_s      int,
    vo2max          numeric(4,1),
    raw             jsonb,
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activities_date_idx ON garmin.activities (calendar_date);

-- -----------------------------------------------------------------------------
-- Garmin Fitness Age  ← /fitnessage-service/fitnessage/v2/{date}
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS garmin.fitness_age (
    calendar_date           date PRIMARY KEY,
    chronological_age       numeric(4,1),
    fitness_age             numeric(4,1),
    achievable_fitness_age  numeric(4,1),
    payload                 jsonb,
    updated_at              timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Biološka dob (vlastiti, transparentni model – vidi src/bioage.js)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS garmin.bio_age_daily (
    calendar_date       date PRIMARY KEY,
    chronological_age   numeric(4,1),
    bio_age             numeric(4,1),        -- 180-dnevni prozor
    bio_age_30d         numeric(4,1),        -- isti model na zadnjih 30 dana
    trend_years         numeric(4,1),        -- bio_age_30d − bio_age: > 0 = navike zadnjih mjesec dana lošije
    data_days           int,
    components          jsonb,               -- {metrika: {value, years}}
    updated_at          timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- Log syncova – za Grafanu i upozorenja
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS garmin.sync_log (
    id           bigserial PRIMARY KEY,
    started_at   timestamptz NOT NULL DEFAULT now(),
    finished_at  timestamptz,
    kind         text,                      -- sync / backfill
    range_start  date,
    range_end    date,
    ok           boolean,
    errors       text[],
    rows         jsonb
);

-- -----------------------------------------------------------------------------
-- RECOVERY VIEW – jedan red po jutru, s 28-dnevnim osobnim baselineom i oznakama
--
-- Logika oznaka (namjerno jednostavna i transparentna, lako se mijenja):
--   HRV:   ispod Garminovog low praga → red; ispod balanced raspona → yellow
--   RHR:   ≥5 bpm iznad 28d prosjeka → red; ≥3 bpm → yellow
--   San:   < 6h ili score < 50 → red; < 90% Garminove potrebe ili score < 70 → yellow
--   Ukupno: ≥2 red → red; 1 red ili ≥2 yellow → yellow; inače green
-- Baseline koristi PRETHODNIH 28 dana (bez današnjeg), da današnji dan ne
-- "razvodni" vlastitu usporedbu. Treba min. 7 dana podataka da bi bio valjan.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW garmin.recovery_daily AS
WITH days AS (
    SELECT d::date AS calendar_date
    FROM generate_series(
        (SELECT min(calendar_date) FROM garmin.wellness_daily),
        (SELECT max(calendar_date) FROM garmin.wellness_daily),
        interval '1 day') d
),
base AS (
    SELECT
        d.calendar_date,
        h.last_night_avg            AS hrv,
        h.baseline_low_upper        AS hrv_low_upper,
        h.baseline_balanced_low     AS hrv_bal_low,
        h.baseline_balanced_upper   AS hrv_bal_upper,
        h.status                    AS hrv_status,
        w.resting_hr                AS rhr,
        s.sleep_s,
        s.sleep_score,
        s.deep_s, s.rem_s,
        s.sleep_need_min,
        w.bb_max                    AS body_battery_am,
        -- jučerašnje opterećenje
        wy.stress_avg               AS stress_yday,
        COALESCE(wy.intensity_moderate, 0) + 2 * COALESCE(wy.intensity_vigorous, 0) AS intensity_pts_yday,
        wy.active_kcal              AS active_kcal_yday,
        ay.training_load            AS training_load_yday,
        ay.n                        AS activities_yday,
        COALESCE(ay.strength, false) AS strength_yday
    FROM days d
    LEFT JOIN (
        SELECT calendar_date, count(*) AS n, sum(training_load) AS training_load,
               bool_or(type_key = 'strength_training') AS strength
        FROM garmin.activities GROUP BY calendar_date
    ) ay ON ay.calendar_date = d.calendar_date - 1
    LEFT JOIN garmin.hrv_daily      h  ON h.calendar_date  = d.calendar_date
    LEFT JOIN garmin.sleep_daily    s  ON s.calendar_date  = d.calendar_date
    LEFT JOIN garmin.wellness_daily w  ON w.calendar_date  = d.calendar_date
    LEFT JOIN garmin.wellness_daily wy ON wy.calendar_date = d.calendar_date - 1
),
rolling AS (
    SELECT b.*,
        avg(rhr)       OVER w28 AS rhr_28d_avg,
        count(rhr)     OVER w28 AS rhr_28d_n,
        avg(hrv)       OVER w28 AS hrv_28d_avg,
        stddev(hrv)    OVER w28 AS hrv_28d_sd,
        count(hrv)     OVER w28 AS hrv_28d_n,
        avg(sleep_s)   OVER w28 AS sleep_28d_avg
    FROM base b
    WINDOW w28 AS (ORDER BY calendar_date ROWS BETWEEN 28 PRECEDING AND 1 PRECEDING)
),
flags AS (
    SELECT r.*,
        CASE
            WHEN hrv IS NULL                     THEN NULL
            WHEN hrv < hrv_low_upper             THEN 'red'
            WHEN hrv < hrv_bal_low               THEN 'yellow'
            ELSE 'green'
        END AS hrv_flag,
        CASE
            WHEN rhr IS NULL OR rhr_28d_n < 7    THEN NULL
            WHEN rhr - rhr_28d_avg >= 5          THEN 'red'
            WHEN rhr - rhr_28d_avg >= 3          THEN 'yellow'
            ELSE 'green'
        END AS rhr_flag,
        CASE
            WHEN sleep_s IS NULL                                   THEN NULL
            WHEN sleep_s < 6 * 3600 OR sleep_score < 50            THEN 'red'
            WHEN sleep_s < 0.9 * COALESCE(sleep_need_min, 480) * 60
              OR sleep_score < 70                                  THEN 'yellow'
            ELSE 'green'
        END AS sleep_flag
    FROM rolling r
)
SELECT
    calendar_date,
    hrv, hrv_status, hrv_bal_low, hrv_bal_upper,
    round(hrv_28d_avg, 1)                          AS hrv_28d_avg,
    CASE WHEN hrv_28d_n >= 7
         THEN round((hrv - hrv_28d_avg) / NULLIF(hrv_28d_sd, 0), 2) END AS hrv_z,
    rhr,
    round(rhr_28d_avg, 1)                          AS rhr_28d_avg,
    round(rhr - rhr_28d_avg, 1)                    AS rhr_delta,
    round(sleep_s / 3600.0, 2)                     AS sleep_h,
    sleep_score,
    round(100.0 * rem_s  / NULLIF(sleep_s, 0))     AS rem_pct,
    round(100.0 * deep_s / NULLIF(sleep_s, 0))     AS deep_pct,
    body_battery_am,
    stress_yday, intensity_pts_yday, active_kcal_yday,
    hrv_flag, rhr_flag, sleep_flag,
    CASE
        WHEN num_nonnulls(hrv_flag, rhr_flag, sleep_flag) = 0 THEN NULL
        WHEN COALESCE((hrv_flag = 'red')::int, 0) + COALESCE((rhr_flag = 'red')::int, 0)
           + COALESCE((sleep_flag = 'red')::int, 0) >= 2     THEN 'red'
        WHEN 'red' IN (hrv_flag, rhr_flag, sleep_flag)
          OR COALESCE((hrv_flag = 'yellow')::int, 0) + COALESCE((rhr_flag = 'yellow')::int, 0)
           + COALESCE((sleep_flag = 'yellow')::int, 0) >= 2  THEN 'yellow'
        ELSE 'green'
    END AS recovery,
    -- dodano kasnije (CREATE OR REPLACE VIEW dopušta samo dodavanje stupaca na kraj)
    training_load_yday, activities_yday, strength_yday
FROM flags
ORDER BY calendar_date;
