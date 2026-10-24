// Mapiranje Garmin odgovora u retke tablica (vidi sql/schema.sql).
// Sva polja su opcionalna – Garmin izostavlja ili vraća null kad sat nije nošen.

const num = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));
const int = (v) => (num(v) == null ? null : Math.round(Number(v)));
const msToDate = (v) => (num(v) == null ? null : new Date(Number(v)));

function sleepRows(payload) {
  const list = Array.isArray(payload) ? payload : payload ? [payload] : [];
  return list
    .filter((s) => s && s.calendarDate)
    .map((s) => ({
      calendar_date: s.calendarDate,
      sleep_start: msToDate(s.sleepStartTimestampGMT),
      sleep_end: msToDate(s.sleepEndTimestampGMT),
      sleep_s: int(s.sleepTimeSeconds),
      deep_s: int(s.deepSleepSeconds),
      light_s: int(s.lightSleepSeconds),
      rem_s: int(s.remSleepSeconds),
      awake_s: int(s.awakeSleepSeconds),
      awake_count: int(s.awakeCount),
      sleep_score: int(s.sleepScores?.overall?.value),
      sleep_score_qualifier: s.sleepScores?.overall?.qualifierKey ?? null,
      avg_sleep_hr: int(s.avgHeartRate),
      avg_sleep_stress: int(s.avgSleepStress),
      avg_respiration: num(s.averageRespirationValue),
      avg_spo2: int(s.averageSpO2Value),
      lowest_spo2: int(s.lowestSpO2Value),
      sleep_need_min: int(s.sleepNeed?.actual),
      score_feedback: s.sleepScoreFeedback ?? null,
    }));
}

function hrvRows(payload) {
  return (payload?.hrvSummaries || [])
    .filter((h) => h && h.calendarDate)
    .map((h) => ({
      calendar_date: h.calendarDate,
      last_night_avg: int(h.lastNightAvg),
      last_night_5min_high: int(h.lastNight5MinHigh),
      weekly_avg: int(h.weeklyAvg),
      baseline_low_upper: int(h.baseline?.lowUpper),
      baseline_balanced_low: int(h.baseline?.balancedLow),
      baseline_balanced_upper: int(h.baseline?.balancedUpper),
      status: h.status ?? null,
    }));
}

function wellnessRows(payload) {
  return (payload?.data || [])
    .filter((d) => d && d.calendarDate)
    .map((d) => ({
      calendar_date: d.calendarDate,
      resting_hr: int(d.heartRate?.restingValue),
      min_hr: int(d.heartRate?.minValue),
      max_hr: int(d.heartRate?.maxValue),
      steps: int(d.movement?.steps?.value),
      active_kcal: int(d.calories?.burnedActive),
      intensity_moderate: int(d.intensityMinutes?.moderate),
      intensity_vigorous: int(d.intensityMinutes?.vigorous),
      stress_avg: int(d.stress?.avgLevel),
      stress_max: int(d.stress?.maxLevel),
      stress_qualifier: d.stress?.qualifier ?? null,
      high_stress_s: num(d.stress?.highStressDurationInMillis) == null ? null : Math.round(d.stress.highStressDurationInMillis / 1000),
      bb_min: int(d.bodyBattery?.minValue),
      bb_max: int(d.bodyBattery?.maxValue),
      bb_charged: int(d.bodyBattery?.chargedValue),
      bb_drained: int(d.bodyBattery?.drainedValue),
      respiration_avg: num(d.respiration?.avgValue),
      spo2_avg: int(d.pulseOx?.avgValue),
    }));
}

// Garmin vraća "2026-10-25 09:12:00" (GMT bez oznake zone) ili ISO; normaliziraj
function gmt(v) {
  if (!v) return null;
  const s = String(v).replace(' ', 'T');
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
}

// Odgovor može biti niz ili { activities: [...] } / { activityList: [...] }
function activityList(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.activities || payload?.activityList || [];
}

function activityRows(payload) {
  return activityList(payload)
    .filter((a) => a && a.activityId != null && a.startTimeLocal)
    .map((a) => ({
      activity_id: Number(a.activityId),
      calendar_date: String(a.startTimeLocal).slice(0, 10),
      start_local: String(a.startTimeLocal).replace('T', ' ').slice(0, 19),
      start_gmt: gmt(a.startTimeGMT),
      type_key: a.activityType?.typeKey ?? a.activityTypeDTO?.typeKey ?? null,
      name: a.activityName ?? null,
      duration_s: int(a.duration ?? a.elapsedDuration),
      distance_m: num(a.distance),
      avg_hr: int(a.averageHR ?? a.averageHeartRate),
      max_hr: int(a.maxHR ?? a.maxHeartRate),
      calories: int(a.calories),
      aerobic_te: num(a.aerobicTrainingEffect),
      anaerobic_te: num(a.anaerobicTrainingEffect),
      training_load: num(a.activityTrainingLoad ?? a.trainingLoad),
      hr_zone1_s: int(a.hrTimeInZone_1),
      hr_zone2_s: int(a.hrTimeInZone_2),
      hr_zone3_s: int(a.hrTimeInZone_3),
      hr_zone4_s: int(a.hrTimeInZone_4),
      hr_zone5_s: int(a.hrTimeInZone_5),
      vo2max: num(a.vO2MaxValue ?? a.vo2MaxValue),
      raw: JSON.stringify(a),
    }));
}

// Struktura Fitness Age odgovora nije javno dokumentirana – čitamo defenzivno, sirovo spremamo cijelo
function fitnessAgeRow(date, p) {
  if (!p || typeof p !== 'object') return null;
  const pick = (...keys) => {
    for (const k of keys) {
      const v = k.split('.').reduce((o, x) => (o == null ? o : o[x]), p);
      if (num(v) != null) return Math.round(num(v) * 10) / 10;
    }
    return null;
  };
  const row = {
    calendar_date: date,
    chronological_age: pick('chronologicalAge', 'chronoAge', 'age'),
    fitness_age: pick('fitnessAge', 'currentFitnessAge', 'fitnessAgeValue'),
    achievable_fitness_age: pick('achievableFitnessAge', 'potentialFitnessAge'),
    payload: JSON.stringify(p),
  };
  return row.fitness_age == null && row.chronological_age == null ? null : row;
}

module.exports = { sleepRows, hrvRows, wellnessRows, activityRows, activityList, fitnessAgeRow };
