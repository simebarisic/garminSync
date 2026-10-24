/**
 * Telegram obavijesti: jutarnji sažetak oporavka + upozorenja.
 * Bez TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID sve se samo ispisuje u log.
 */
const { pool } = require('./db');
const { today, addDays } = require('./dates');

const API = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT = process.env.TELEGRAM_CHAT_ID || '';
const enabled = () => Boolean(TOKEN && CHAT);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function send(html) {
  if (!enabled()) {
    console.log(`  📭 (Telegram nije podešen)\n${html.replace(/<[^>]+>/g, '')}`);
    return false;
  }
  const res = await fetch(`${API}/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!res.ok) {
    console.error(`  ❌ Telegram: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return false;
  }
  return true;
}

// ---- upozorenja: isti tekst najviše jednom u ALERT_COOLDOWN_H sati ----
const COOLDOWN_MS = parseFloat(process.env.ALERT_COOLDOWN_H || '6') * 3600 * 1000;
const lastSent = new Map();

async function alert(key, html) {
  const now = Date.now();
  if (now - (lastSent.get(key) || 0) < COOLDOWN_MS) return false;
  lastSent.set(key, now);
  return send(`⚠️ <b>garmin-sync</b>\n${html}`);
}

async function alertsAfterSync(result) {
  if (result.authError) {
    return alert('auth',
      'Garmin API ključ više ne radi (istekao ili obrisan).\n' +
      'Napravi novi: Garmin Connect → Settings → Personal API, upiši ga u <code>.env</code> i restartaj: ' +
      '<code>docker compose up -d app</code>');
  }
  if (result.errors.length) {
    await alert(`errors:${result.errors.map((e) => e.split(':')[0]).join('|')}`,
      `Sync je završio s ${result.errors.length} grešaka:\n` +
      result.errors.slice(0, 5).map((e) => `• <code>${esc(e)}</code>`).join('\n'));
  }
  // sat nije sinkroniziran s mobitelom → nema sna za danas/jučer
  const { rows: [r] } = await pool.query('SELECT max(calendar_date) AS last FROM garmin.sleep_daily');
  if (r.last && r.last < addDays(today(), -1)) {
    await alert('stale', `Zadnji podaci o snu su od <b>${r.last}</b>. Sinkroniziraj sat s Garmin Connect aplikacijom.`);
  }
}

// ---- jutarnji sažetak ----
const ICON = { green: '🟢', yellow: '🟡', red: '🔴' };
const ADVICE = {
  green: 'Spreman si za težak trening.',
  yellow: 'Umjereno – drži volumen/intenzitet, bez novih rekorda.',
  red: 'Tijelo traži odmor – lagano kretanje, mobilnost ili slobodan dan.',
};

async function morningMessage() {
  const { rows: [r] } = await pool.query(
    `SELECT * FROM garmin.recovery_daily WHERE calendar_date <= $1 AND (hrv IS NOT NULL OR sleep_h IS NOT NULL)
     ORDER BY calendar_date DESC LIMIT 1`, [today()]);
  if (!r) return null;

  const lines = [`${ICON[r.recovery] || '⚪'} <b>Oporavak ${r.calendar_date}</b>`];
  if (r.recovery) lines.push(ADVICE[r.recovery]);
  lines.push('');
  if (r.hrv != null)
    lines.push(`${ICON[r.hrv_flag] || '•'} HRV <b>${r.hrv}</b> ms (balans ${r.hrv_bal_low}–${r.hrv_bal_upper})`);
  if (r.rhr != null)
    lines.push(`${ICON[r.rhr_flag] || '•'} Mirovni puls <b>${r.rhr}</b>` +
      (r.rhr_delta != null ? ` (${r.rhr_delta > 0 ? '+' : ''}${Number(r.rhr_delta).toFixed(1)} vs 28d)` : ''));
  if (r.sleep_h != null)
    lines.push(`${ICON[r.sleep_flag] || '•'} San <b>${Number(r.sleep_h).toFixed(1)} h</b>` +
      (r.sleep_score != null ? `, score ${r.sleep_score}` : '') + (r.rem_pct != null ? `, REM ${r.rem_pct}%` : ''));
  if (r.body_battery_am != null) lines.push(`🔋 Body Battery ${r.body_battery_am}`);
  if (r.activities_yday) lines.push(`🏋️ Jučer: ${r.activities_yday} trening(a)` +
    (r.training_load_yday != null ? `, load ${Math.round(r.training_load_yday)}` : ''));

  const { rows: [b] } = await pool.query(
    'SELECT bio_age, chronological_age, trend_years FROM garmin.bio_age_daily ORDER BY calendar_date DESC LIMIT 1');
  if (b) {
    const t = b.trend_years == null ? '' : Number(b.trend_years) > 0.2 ? ' ↗︎ zadnji mjesec lošije' : Number(b.trend_years) < -0.2 ? ' ↘︎ zadnji mjesec bolje' : ' → stabilno';
    lines.push(`🧬 Biološka dob ${b.bio_age} (kronološka ${Math.floor(Number(b.chronological_age))})${t}`);
  }
  return lines.join('\n');
}

async function sendMorning() {
  const msg = await morningMessage();
  if (!msg) return false;
  return send(msg);
}

module.exports = { send, alert, alertsAfterSync, morningMessage, sendMorning, enabled };
