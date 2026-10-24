const fs = require('node:fs');
const path = require('node:path');
const { Pool, types } = require('pg');

// DATE kolone vraćaj kao 'YYYY-MM-DD' string, ne kao JS Date (inače UTC pomak pomakne dan)
types.setTypeParser(1082, (v) => v);

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL nije postavljen');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8');
  const c = await pool.connect();
  try {
    await c.query('SET client_min_messages = warning'); // utišaj "already exists" NOTICE-e
    await c.query(sql);
    await ensureReader(c);
  } finally {
    c.release();
  }
}

// Read-only rola za Grafanu: vidi samo shemu "garmin", ne može ništa mijenjati.
// Kreira se/ažurira pri svakom pokretanju ako je GRAFANA_DB_PASSWORD postavljen.
async function ensureReader(c) {
  const pw = process.env.GRAFANA_DB_PASSWORD;
  if (!pw) return;
  await c.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'garmin_reader') THEN
      CREATE ROLE garmin_reader LOGIN;
    END IF;
  END $$`);
  await c.query(`ALTER ROLE garmin_reader WITH LOGIN PASSWORD ${c.escapeLiteral(pw)}`);
  await c.query(`ALTER ROLE garmin_reader SET default_transaction_read_only = on`);
  await c.query(`GRANT USAGE ON SCHEMA garmin TO garmin_reader`);
  await c.query(`GRANT SELECT ON ALL TABLES IN SCHEMA garmin TO garmin_reader`);
  await c.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA garmin GRANT SELECT ON TABLES TO garmin_reader`);
}

async function saveRaw(client, endpoint, start, end, payload) {
  await client.query(
    `INSERT INTO garmin.raw_payload (endpoint, range_start, range_end, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint, range_start, range_end)
     DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
    [endpoint, start, end, JSON.stringify(payload ?? null)]
  );
}

// Upsert po ključu (default calendar_date); kolone se uzimaju iz prvog retka
async function upsert(client, table, rows, key = 'calendar_date') {
  if (!rows.length) return 0;
  const cols = Object.keys(rows[0]);
  const values = [];
  const tuples = rows.map((r, i) => {
    cols.forEach((c) => values.push(r[c]));
    return `(${cols.map((_, j) => `$${i * cols.length + j + 1}`).join(', ')})`;
  });
  const updates = cols
    .filter((c) => c !== key)
    .map((c) => `${c} = EXCLUDED.${c}`)
    .concat('updated_at = now()')
    .join(', ');
  await client.query(
    `INSERT INTO garmin.${table} (${cols.join(', ')}) VALUES ${tuples.join(', ')}
     ON CONFLICT (${key}) DO UPDATE SET ${updates}`,
    values
  );
  return rows.length;
}

module.exports = { pool, migrate, saveRaw, upsert };
