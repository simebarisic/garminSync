// Garmin Connect Personal API klijent (read-only).
// Putanje prema službenom klijentu: github.com/garmin/connect-personal-api-python

const BASE = (process.env.GARMIN_API_BASE || 'https://personal.connectapi.garmin.com').replace(/\/$/, '');
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
const REFRESH_BEFORE_MS = 60 * 60 * 1000; // obnovi token sat prije isteka (kao službeni klijent)

let cached = null; // { token, expMs }

function apiKey() {
  const k = (process.env.GARMIN_API_KEY || '').trim();
  if (!k) throw new Error('GARMIN_API_KEY nije postavljen');
  return k;
}

function jwtExpMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    if (payload.exp) return payload.exp * 1000;
  } catch {
    /* nije JWT */
  }
  return Date.now() + 2 * REFRESH_BEFORE_MS; // nepoznato – pretpostavi kratko trajanje
}

async function getToken(force = false) {
  if (!force && cached && cached.expMs - Date.now() > REFRESH_BEFORE_MS) return cached.token;

  // Bez 'Accept: application/json' – token endpoint na to vraća 406
  const res = await fetch(BASE + TOKEN_PATH, {
    method: 'POST',
    headers: { Authorization: `ApiKey ${apiKey()}`, Accept: '*/*' },
  });
  const text = (await res.text()).trim();
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? ' – ključ je istekao ili obrisan? Napravi novi u Garmin Connect → Personal API.' : '';
    throw new Error(`Token: HTTP ${res.status}${hint} ${text.slice(0, 200)}`);
  }
  let token = text;
  if (text.startsWith('{')) {
    const j = JSON.parse(text);
    token = j.access_token || j.accessToken || j.token;
  }
  token = token.replace(/^"|"$/g, '');
  cached = { token, expMs: jwtExpMs(token) };
  return token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, query = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v));

  let refreshed = false;
  for (let attempt = 1; ; attempt++) {
    const token = await getToken();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });

    if (res.status === 401 && !refreshed) {
      refreshed = true;
      attempt--; // obnova tokena se ne broji kao pokušaj
      await getToken(true);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const ra = parseInt(res.headers.get('retry-after') || '', 10);
      const wait = Number.isFinite(ra) ? ra * 1000 : 2000 * 2 ** attempt;
      console.warn(`  ⏳ HTTP ${res.status} na ${path} – pokušaj ${attempt + 1} za ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
}

// ---- endpointi (svi rasponi su inkluzivni, datumi YYYY-MM-DD) ----

const sleepSummaries = (start, end) =>
  get('/sleep-service/sleep/dailySleepSummariesByDate', { startDate: start, endDate: end });

const hrvSummaries = (start, end) => get(`/hrv-service/hrv/daily/${start}/${end}`);

const dailySummaries = (start, end) =>
  get('/usersummary-service/v2/dailysummaries', { startDate: start, endDate: end });

const activities = (start, end, offset = 0, limit = 40) =>
  get('/activitylist-service/activities/search/activities', { start: offset, limit, startDate: start, endDate: end });

const fitnessAge = (date) => get(`/fitnessage-service/fitnessage/v2/${date}`);

const userSettings = () => get('/userprofile-service/userprofile/settings');

module.exports = { getToken, get, sleepSummaries, hrvSummaries, dailySummaries, activities, fitnessAge, userSettings };
