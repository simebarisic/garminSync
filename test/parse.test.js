const test = require('node:test');
const assert = require('node:assert/strict');
const { sleepRows, hrvRows, wellnessRows, activityRows, fitnessAgeRow } = require('../src/parse');
const { chunks, addDays } = require('../src/dates');

test('sleepRows: polja iz stvarnog oblika odgovora', () => {
  const [r] = sleepRows([{
    calendarDate: '2026-10-21', sleepTimeSeconds: 23880, deepSleepSeconds: 4440, remSleepSeconds: 960,
    sleepStartTimestampGMT: 1792527391000, sleepScores: { overall: { value: 58, qualifierKey: 'POOR' } },
    sleepNeed: { actual: 510 }, averageRespirationValue: 15,
  }]);
  assert.equal(r.calendar_date, '2026-10-21');
  assert.equal(r.sleep_s, 23880);
  assert.equal(r.sleep_score, 58);
  assert.equal(r.sleep_need_min, 510);
  assert.ok(r.sleep_start instanceof Date);
  assert.equal(r.awake_s, null);
});

test('hrvRows i wellnessRows', () => {
  const [h] = hrvRows({ hrvSummaries: [{ calendarDate: '2026-10-21', lastNightAvg: 50, baseline: { lowUpper: 61, balancedLow: 65, balancedUpper: 79 }, status: 'UNBALANCED' }] });
  assert.deepEqual([h.last_night_avg, h.baseline_balanced_low, h.status], [50, 65, 'UNBALANCED']);

  const [w] = wellnessRows({ data: [{ calendarDate: '2026-10-21', heartRate: { restingValue: 53 }, stress: { avgLevel: 28, highStressDurationInMillis: 720000 }, bodyBattery: { maxValue: 50 } }] });
  assert.deepEqual([w.resting_hr, w.stress_avg, w.high_stress_s, w.bb_max, w.steps], [53, 28, 720, 50, null]);
});

test('activityRows: niz ili objekt, lokalni datum, GMT bez zone', () => {
  const a = { activityId: 123, startTimeLocal: '2026-10-25 18:30:00', startTimeGMT: '2026-10-25 16:30:00', activityType: { typeKey: 'strength_training' }, duration: 3600.5, activityTrainingLoad: 85.2, hrTimeInZone_2: 600 };
  for (const payload of [[a], { activities: [a] }]) {
    const [r] = activityRows(payload);
    assert.equal(r.calendar_date, '2026-10-25');
    assert.equal(r.type_key, 'strength_training');
    assert.equal(r.duration_s, 3601);
    assert.equal(r.start_gmt.toISOString(), '2026-10-25T16:30:00.000Z');
    assert.equal(r.hr_zone2_s, 600);
  }
  assert.deepEqual(activityRows([]), []);
});

test('fitnessAgeRow: defenzivno čitanje', () => {
  assert.equal(fitnessAgeRow('2026-10-24', { chronologicalAge: 30, fitnessAge: 26.84 }).fitness_age, 26.8);
  assert.equal(fitnessAgeRow('2026-10-24', {}), null);
  assert.equal(fitnessAgeRow('2026-10-24', null), null);
});

test('chunks pokriva raspon bez rupa', () => {
  const c = chunks('2026-01-01', '2026-03-15', 28);
  assert.equal(c[0][0], '2026-01-01');
  assert.equal(c[c.length - 1][1], '2026-03-15');
  for (let i = 1; i < c.length; i++) assert.equal(c[i][0], addDays(c[i - 1][1], 1));
});
