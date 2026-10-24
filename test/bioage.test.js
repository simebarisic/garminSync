process.env.DATABASE_URL ||= 'postgres://test@localhost/test'; // db.js traži varijablu; pool se ne spaja dok se ne koristi
const test = require('node:test');
const assert = require('node:assert/strict');
const { MODEL, evaluate } = require('../src/bioage');
const { addDays } = require('../src/dates');

test('MODEL pragovi', () => {
  assert.equal(MODEL.steps(3000), 3);
  assert.equal(MODEL.steps(9000), 0);
  assert.equal(MODEL.steps(15000), -1.5);
  assert.equal(MODEL.restingHr(48), -2);
  assert.equal(MODEL.restingHr(80), 3);
  assert.equal(MODEL.sleepHours(7.5), 0);
  assert.equal(MODEL.sleepHours(5.5), 2);
  assert.equal(MODEL.intensityWeekly(200), 0);
  assert.equal(MODEL.strengthWeekly(2), -1);
  assert.equal(MODEL.fitnessAge(-20), -4);
});

function fakeData({ days = 200, steps = 9000, rhr = 52, sleepH = 7.5, inten = 30, strengthEvery = 0 } = {}) {
  const end = '2026-10-24';
  const well = new Map(), sleep = new Map(), strength = new Set();
  for (let i = 0; i < days; i++) {
    const d = addDays(end, -i);
    well.set(d, { calendar_date: d, steps, resting_hr: rhr, intensity: inten });
    sleep.set(d, { calendar_date: d, sleep_s: sleepH * 3600, mid_from_noon: 900 + (i % 3) * 10 });
    if (strengthEvery && i % strengthEvery === 0) strength.add(d);
  }
  return { end, data: { well, sleep, strength, activitiesSince: strengthEvery ? addDays(end, -days) : null, fitnessAge: [] } };
}

test('zdrave navike → mlađa biološka dob', () => {
  const { end, data } = fakeData({ steps: 11000, rhr: 50, inten: 45, strengthEvery: 3 });
  const r = evaluate(data, end, 180, 30);
  assert.ok(r.bio < 30, `očekivano < 30, dobiveno ${r.bio}`);
  assert.ok('snaga_tjedno' in r.comp);
});

test('loše navike → starija biološka dob', () => {
  const { end, data } = fakeData({ steps: 3500, rhr: 72, sleepH: 5.5, inten: 5 });
  assert.ok(evaluate(data, end, 180, 30).bio > 35);
});

test('premalo podataka → null; bez aktivnosti nema komponente snage', () => {
  const few = fakeData({ days: 10 });
  assert.equal(evaluate(few.data, few.end, 180, 30), null);
  const { end, data } = fakeData();
  assert.ok(!('snaga_tjedno' in evaluate(data, end, 180, 30).comp));
});
