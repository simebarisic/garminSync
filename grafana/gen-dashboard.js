// Generira grafana/dashboards/oporavak.json
const fs = require('fs');
const ds = { type: 'grafana-postgresql-datasource', uid: 'garmin-pg' };
const tf = '$__timeFilter(calendar_date::timestamp)';
let id = 1;

const target = (rawSql, format = 'time_series') => ({ refId: 'A', datasource: ds, editorMode: 'code', format, rawQuery: true, rawSql });

const flagMappings = [
  { type: 'value', options: {
    green: { text: '🟢 dobro', color: 'green', index: 0 },
    yellow: { text: '🟡 oprez', color: 'yellow', index: 1 },
    red: { text: '🔴 odmor', color: 'red', index: 2 },
  } },
  { type: 'special', options: { match: 'null', result: { text: '–', color: 'transparent', index: 3 } } },
];

const override = (name, props) => ({
  matcher: { id: 'byName', options: name },
  properties: Object.entries(props).map(([id, value]) => ({ id, value })),
});

const ts = (title, gridPos, sql, fieldDefaults = {}, overrides = [], extra = {}) => ({
  id: id++, type: 'timeseries', title, gridPos, datasource: ds,
  targets: [target(sql)],
  fieldConfig: {
    defaults: {
      custom: { drawStyle: 'line', lineWidth: 2, pointSize: 6, showPoints: 'always', spanNulls: false, fillOpacity: 0, ...fieldDefaults.custom },
      color: { mode: 'palette-classic' },
      ...Object.fromEntries(Object.entries(fieldDefaults).filter(([k]) => k !== 'custom')),
    },
    overrides,
  },
  options: { legend: { displayMode: 'list', placement: 'bottom', showLegend: true }, tooltip: { mode: 'multi', sort: 'none' } },
  ...extra,
});

const stat = (title, gridPos, sql, defaults, opts = {}) => ({
  id: id++, type: 'stat', title, gridPos, datasource: ds,
  targets: [target(sql, 'table')],
  fieldConfig: { defaults, overrides: opts.overrides || [] },
  options: {
    reduceOptions: { calcs: ['lastNotNull'], fields: opts.fields || '', values: false },
    colorMode: opts.colorMode || 'background', graphMode: 'none', textMode: 'value_and_name',
    justifyMode: 'center', orientation: 'auto', wideLayout: true, showPercentChange: false,
  },
});

const LATEST = `FROM garmin.recovery_daily
WHERE hrv IS NOT NULL OR sleep_h IS NOT NULL OR rhr IS NOT NULL
ORDER BY calendar_date DESC LIMIT 1`;

const panels = [
  // ---------------- red 1: danas ----------------
  stat('Oporavak danas', { x: 0, y: 0, w: 6, h: 5 },
    `SELECT calendar_date AS "Datum", recovery AS "Oporavak" ${LATEST}`,
    { mappings: flagMappings, color: { mode: 'thresholds' }, thresholds: { mode: 'absolute', steps: [{ color: 'text', value: null }] } },
    { fields: '/^Oporavak$/' }),

  stat('Jutros', { x: 6, y: 0, w: 14, h: 5 },
    `SELECT hrv AS "HRV (ms)", rhr AS "Mirovni puls", rhr_delta AS "RHR vs 28d",
       sleep_h AS "San (h)", sleep_score AS "Sleep score", body_battery_am AS "Body Battery" ${LATEST}`,
    { color: { mode: 'thresholds' }, thresholds: { mode: 'absolute', steps: [{ color: 'text', value: null }] }, decimals: 1 },
    {
      colorMode: 'value',
      overrides: [
        override('HRV (ms)', { decimals: 0 }),
        override('Mirovni puls', { decimals: 0, unit: 'none' }),
        override('RHR vs 28d', { thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'yellow', value: 3 }, { color: 'red', value: 5 }] } }),
        override('Sleep score', { decimals: 0, thresholds: { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'yellow', value: 50 }, { color: 'green', value: 70 }] } }),
        override('San (h)', { thresholds: { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'yellow', value: 6 }, { color: 'green', value: 7 }] } }),
        override('Body Battery', { decimals: 0, thresholds: { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'yellow', value: 50 }, { color: 'green', value: 75 }] } }),
      ],
    }),

  stat('Sync', { x: 20, y: 0, w: 4, h: 5 },
    `SELECT extract(epoch FROM finished_at) * 1000 AS "Zadnji sync",
       CASE WHEN ok THEN 'ok' ELSE 'greške' END AS "Status"
FROM garmin.sync_log WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`,
    { color: { mode: 'thresholds' }, thresholds: { mode: 'absolute', steps: [{ color: 'text', value: null }] } },
    {
      colorMode: 'value',
      overrides: [
        override('Zadnji sync', { unit: 'dateTimeFromNow' }),
        override('Status', { mappings: [{ type: 'value', options: { ok: { text: '✅ ok', color: 'green', index: 0 }, 'greške': { text: '⚠️ greške', color: 'orange', index: 1 } } }] }),
      ],
    }),

  // ---------------- red 2: timeline oznaka ----------------
  {
    id: id++, type: 'state-timeline', title: 'Oporavak po danima', gridPos: { x: 0, y: 5, w: 24, h: 6 }, datasource: ds,
    targets: [target(`SELECT calendar_date::timestamp AS time,
       recovery AS "Ukupno", hrv_flag AS "HRV", rhr_flag AS "Mirovni puls", sleep_flag AS "San"
FROM garmin.recovery_daily WHERE ${tf} ORDER BY 1`)],
    fieldConfig: { defaults: { mappings: flagMappings, color: { mode: 'thresholds' }, thresholds: { mode: 'absolute', steps: [{ color: 'transparent', value: null }] }, custom: { fillOpacity: 80, lineWidth: 0 } }, overrides: [] },
    options: { showValue: 'never', mergeValues: false, alignValue: 'center', rowHeight: 0.85, legend: { showLegend: false }, tooltip: { mode: 'multi' } },
  },

  // ---------------- red 3: HRV + RHR ----------------
  ts('HRV – noćni prosjek vs Garmin balans', { x: 0, y: 11, w: 12, h: 9 },
    `SELECT calendar_date::timestamp AS time,
       hrv_bal_low AS "Balans donja", hrv_bal_upper AS "Balans gornja",
       hrv_28d_avg AS "28d prosjek", hrv AS "HRV"
FROM garmin.recovery_daily WHERE ${tf} ORDER BY 1`,
    { unit: 'ms' },
    [
      override('Balans donja', { 'custom.lineWidth': 0, 'custom.showPoints': 'never', color: { mode: 'fixed', fixedColor: 'green' }, 'custom.hideFrom': { legend: true, tooltip: false, viz: false } }),
      override('Balans gornja', { 'custom.lineWidth': 0, 'custom.showPoints': 'never', 'custom.fillBelowTo': 'Balans donja', 'custom.fillOpacity': 15, color: { mode: 'fixed', fixedColor: 'green' }, displayName: 'Balansirani raspon' }),
      override('28d prosjek', { 'custom.lineStyle': { fill: 'dash', dash: [6, 4] }, 'custom.showPoints': 'never', 'custom.lineWidth': 1, color: { mode: 'fixed', fixedColor: 'text' } }),
      override('HRV', { color: { mode: 'fixed', fixedColor: 'blue' } }),
    ]),

  ts('Mirovni puls', { x: 12, y: 11, w: 12, h: 9 },
    `SELECT calendar_date::timestamp AS time, rhr AS "Mirovni puls", rhr_28d_avg AS "28d prosjek"
FROM garmin.recovery_daily WHERE ${tf} ORDER BY 1`,
    { unit: 'none', decimals: 0 },
    [
      override('28d prosjek', { 'custom.lineStyle': { fill: 'dash', dash: [6, 4] }, 'custom.showPoints': 'never', 'custom.lineWidth': 1, color: { mode: 'fixed', fixedColor: 'text' }, decimals: 1 }),
      override('Mirovni puls', { color: { mode: 'fixed', fixedColor: 'red' } }),
    ]),

  // ---------------- red 4: san + body battery ----------------
  ts('San – faze i score', { x: 0, y: 20, w: 12, h: 9 },
    `SELECT calendar_date::timestamp AS time,
       round(deep_s / 3600.0, 2)  AS "Duboki",
       round(light_s / 3600.0, 2) AS "Lagani",
       round(rem_s / 3600.0, 2)   AS "REM",
       round(awake_s / 3600.0, 2) AS "Budan",
       sleep_score                AS "Sleep score"
FROM garmin.sleep_daily WHERE ${tf} ORDER BY 1`,
    { unit: 'h', custom: { drawStyle: 'bars', fillOpacity: 85, lineWidth: 1, showPoints: 'never', stacking: { mode: 'normal', group: 'A' }, barAlignment: 0 } },
    [
      override('Duboki', { color: { mode: 'fixed', fixedColor: 'dark-blue' } }),
      override('Lagani', { color: { mode: 'fixed', fixedColor: 'light-blue' } }),
      override('REM', { color: { mode: 'fixed', fixedColor: 'purple' } }),
      override('Budan', { color: { mode: 'fixed', fixedColor: 'orange' } }),
      override('Sleep score', {
        'custom.drawStyle': 'line', 'custom.lineWidth': 2, 'custom.showPoints': 'always', 'custom.fillOpacity': 0,
        'custom.stacking': { mode: 'none', group: 'A' }, 'custom.axisPlacement': 'right', unit: 'none', min: 0, max: 100,
        color: { mode: 'fixed', fixedColor: 'text' },
      }),
    ]),

  ts('Body Battery i jučerašnji stres', { x: 12, y: 20, w: 12, h: 9 },
    `SELECT calendar_date::timestamp AS time,
       bb_max AS "Body Battery (max/jutro)", bb_min AS "Body Battery (min)", stress_avg AS "Prosječni stres"
FROM garmin.wellness_daily WHERE ${tf} ORDER BY 1`,
    { unit: 'none', min: 0, max: 100 },
    [
      override('Body Battery (max/jutro)', { color: { mode: 'fixed', fixedColor: 'green' }, 'custom.fillBelowTo': 'Body Battery (min)', 'custom.fillOpacity': 12 }),
      override('Body Battery (min)', { color: { mode: 'fixed', fixedColor: 'green' }, 'custom.lineWidth': 1, 'custom.showPoints': 'never' }),
      override('Prosječni stres', { color: { mode: 'fixed', fixedColor: 'orange' }, 'custom.lineStyle': { fill: 'dash', dash: [6, 4] } }),
    ]),

  // ---------------- red 5: tablica ----------------
  {
    id: id++, type: 'table', title: 'Zadnja 3 tjedna', gridPos: { x: 0, y: 29, w: 24, h: 12 }, datasource: ds,
    targets: [target(`SELECT calendar_date AS "Datum", recovery AS "Ukupno",
       hrv AS "HRV", hrv_status AS "HRV status", hrv_flag AS "HRV ⚑",
       rhr AS "RHR", rhr_delta AS "RHR Δ28d", rhr_flag AS "RHR ⚑",
       sleep_h AS "San h", sleep_score AS "Score", rem_pct AS "REM %", deep_pct AS "Duboki %", sleep_flag AS "San ⚑",
       body_battery_am AS "BB", stress_yday AS "Stres jučer", intensity_pts_yday AS "Intenzitet jučer"
FROM garmin.recovery_daily
WHERE calendar_date > current_date - 21
ORDER BY calendar_date DESC`, 'table')],
    fieldConfig: {
      defaults: { custom: { align: 'center', cellOptions: { type: 'auto' } } },
      overrides: ['Ukupno', 'HRV ⚑', 'RHR ⚑', 'San ⚑'].map((n) =>
        override(n, { mappings: flagMappings, 'custom.cellOptions': { type: 'color-background', mode: 'basic' }, 'custom.width': 95 })),
    },
    options: { showHeader: true, cellHeight: 'sm', footer: { show: false } },
  },

  // ---------------- red 6: trening ----------------
  { id: id++, type: 'row', title: 'Trening', collapsed: false, gridPos: { x: 0, y: 41, w: 24, h: 1 }, panels: [] },

  ts('Training load po danu', { x: 0, y: 42, w: 12, h: 8 },
    `SELECT calendar_date::timestamp AS time,
       round(sum(training_load)) AS "Training load",
       round(sum(duration_s) / 60.0) AS "Trajanje (min)"
FROM garmin.activities WHERE ${tf} GROUP BY 1 ORDER BY 1`,
    { custom: { drawStyle: 'bars', fillOpacity: 80, lineWidth: 1, showPoints: 'never' } },
    [
      override('Training load', { color: { mode: 'fixed', fixedColor: 'purple' } }),
      override('Trajanje (min)', { 'custom.drawStyle': 'line', 'custom.axisPlacement': 'right', 'custom.showPoints': 'always', color: { mode: 'fixed', fixedColor: 'text' } }),
    ]),

  {
    id: id++, type: 'table', title: 'Zadnji treninzi', gridPos: { x: 12, y: 42, w: 12, h: 8 }, datasource: ds,
    targets: [target(`SELECT start_local AS "Početak", name AS "Naziv", type_key AS "Tip",
       round(duration_s / 60.0) AS "Min", avg_hr AS "Ø puls", round(training_load) AS "Load",
       aerobic_te AS "Aerobni TE", anaerobic_te AS "Anaerobni TE"
FROM garmin.activities ORDER BY start_local DESC LIMIT 15`, 'table')],
    fieldConfig: { defaults: { custom: { align: 'auto', cellOptions: { type: 'auto' } } }, overrides: [] },
    options: { showHeader: true, cellHeight: 'sm', footer: { show: false } },
  },

  // ---------------- red 7: biološka dob ----------------
  { id: id++, type: 'row', title: 'Biološka dob (procjena, nije medicinska mjera)', collapsed: false, gridPos: { x: 0, y: 50, w: 24, h: 1 }, panels: [] },

  stat('Biološka dob', { x: 0, y: 51, w: 6, h: 8 },
    `SELECT bio_age AS "Biološka", chronological_age AS "Kronološka", trend_years AS "Trend 30d"
FROM garmin.bio_age_daily ORDER BY calendar_date DESC LIMIT 1`,
    { decimals: 1, unit: 'none', color: { mode: 'thresholds' }, thresholds: { mode: 'absolute', steps: [{ color: 'text', value: null }] } },
    {
      colorMode: 'value',
      overrides: [
        override('Trend 30d', { unit: 'none', thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'text', value: -0.2 }, { color: 'orange', value: 0.2 }] } }),
      ],
    }),

  ts('Biološka dob kroz vrijeme', { x: 6, y: 51, w: 10, h: 8 },
    `SELECT b.calendar_date::timestamp AS time,
       b.chronological_age AS "Kronološka", b.bio_age AS "Biološka (180d)",
       b.bio_age_30d AS "Biološka (30d)", f.fitness_age AS "Garmin Fitness Age"
FROM garmin.bio_age_daily b
LEFT JOIN garmin.fitness_age f ON f.calendar_date = b.calendar_date
WHERE ${tf.replace('calendar_date', 'b.calendar_date')} ORDER BY 1`,
    { decimals: 1, custom: { showPoints: 'never', spanNulls: true } },
    [
      override('Kronološka', { color: { mode: 'fixed', fixedColor: 'text' }, 'custom.lineStyle': { fill: 'dash', dash: [6, 4] }, 'custom.lineWidth': 1 }),
      override('Biološka (180d)', { color: { mode: 'fixed', fixedColor: 'green' }, 'custom.lineWidth': 3 }),
      override('Biološka (30d)', { color: { mode: 'fixed', fixedColor: 'yellow' } }),
      override('Garmin Fitness Age', { color: { mode: 'fixed', fixedColor: 'blue' }, 'custom.showPoints': 'always' }),
    ]),

  {
    id: id++, type: 'table', title: 'Od čega se sastoji (zadnji dan)', gridPos: { x: 16, y: 51, w: 8, h: 8 }, datasource: ds,
    targets: [target(`SELECT replace(c.key, '_', ' ') AS "Metrika",
       (c.value->>'value')::numeric AS "Vrijednost",
       (c.value->>'years')::numeric AS "Godine ±"
FROM (SELECT components FROM garmin.bio_age_daily ORDER BY calendar_date DESC LIMIT 1) b,
     jsonb_each(b.components) c
ORDER BY 3 DESC`, 'table')],
    fieldConfig: {
      defaults: { custom: { align: 'auto', cellOptions: { type: 'auto' } } },
      overrides: [override('Godine ±', {
        'custom.cellOptions': { type: 'color-text' },
        color: { mode: 'thresholds' },
        thresholds: { mode: 'absolute', steps: [{ color: 'green', value: null }, { color: 'text', value: 0 }, { color: 'orange', value: 0.01 }] },
      })],
    },
    options: { showHeader: true, cellHeight: 'sm', footer: { show: false } },
  },
];

const dashboard = {
  uid: 'garmin-oporavak',
  title: 'Oporavak',
  description: 'Jutarnja procjena oporavka iz Garmin podataka (garmin-sync)',
  tags: ['garmin', 'oporavak'],
  timezone: 'utc',          // datumi su dani, ne trenuci – bez pomaka zone
  editable: true,
  graphTooltip: 1,          // dijeljeni crosshair između grafova
  refresh: '30m',
  time: { from: 'now-60d', to: 'now' },
  timepicker: {},
  schemaVersion: 39,
  version: 1,
  templating: { list: [] },
  annotations: { list: [] },
  panels,
};

fs.writeFileSync(process.argv[2], JSON.stringify(dashboard, null, 2) + '\n');
console.log(`ok – ${panels.length} panela`);
