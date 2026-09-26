#!/usr/bin/env node
/*
 * One-time SQLite -> Supabase PostgreSQL migration.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node scripts/migrate-sqlite-to-postgres.js
 *
 * By default this refuses to overwrite conflicting rows. The target schema
 * should be empty (or contain only schema objects) for the first migration.
 */
const path = require('path');
const Database = require('better-sqlite3');
const { Pool } = require('pg');
const fs = require('fs');

const sqlitePath = process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'wds.db');
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required.');
}
if (!fs.existsSync(sqlitePath)) {
  throw new Error(`SQLite database not found: ${sqlitePath}`);
}

const sqlite = new Database(sqlitePath, { readonly: true });
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false },
});

const schemaPath = path.join(__dirname, '..', 'src', 'db', 'schema.sql');

const tables = [
  'users',
  'programs',
  'student_profiles',
  'courses',
  'instructors',
  'bookings',
  'availability_slots',
  'blocked_dates',
  'appointments',
  'payments',
  'contact_messages',
  'testimonials',
  'faqs',
  'password_reset_tokens',
  'notifications',
  'site_settings',
  'email_outbox',
];

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function ensureSchema(client) {
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await client.query(schema);
}

async function copyTable(client, table) {
  const rows = sqlite.prepare(`SELECT * FROM ${quoteIdent(table)}`).all();
  if (!rows.length) return 0;

  const columns = Object.keys(rows[0]);
  const columnSql = columns.map(quoteIdent).join(', ');
  let copied = 0;

  for (const row of rows) {
    const values = columns.map((c) => row[c]);
    const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `
      INSERT INTO ${quoteIdent(table)} (${columnSql})
      VALUES (${placeholders})
      ON CONFLICT DO NOTHING
    `;
    const result = await client.query(sql, values);
    copied += result.rowCount || 0;
  }

  // Keep BIGSERIAL sequences ahead of the imported IDs.
  if (columns.includes('id')) {
    await client.query(`
      SELECT setval(
        pg_get_serial_sequence('${table}', 'id'),
        COALESCE((SELECT MAX(id) FROM ${quoteIdent(table)}), 1),
        true
      )
    `);
  }

  return copied;
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureSchema(client);

    const counts = {};
    for (const table of tables) {
      counts[table] = await copyTable(client, table);
      console.log(`${table}: copied ${counts[table]} row(s)`);
    }

    await client.query('COMMIT');
    console.log('\nMigration complete.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration failed; transaction rolled back.');
    throw error;
  } finally {
    client.release();
    await pool.end();
    sqlite.close();
  }
}

main().catch(() => process.exit(1));
