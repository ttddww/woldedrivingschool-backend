const { Pool, types } = require('pg');

types.setTypeParser(20, (value) => Number(value));
const { AsyncLocalStorage } = require('async_hooks');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const transactionStorage = new AsyncLocalStorage();

if (!config.databaseUrl) {
  throw new Error(
    'DATABASE_URL is required. Set it to your Supabase PostgreSQL connection string in backend/.env.'
  );
}

const pool = new Pool({
  connectionString: config.databaseUrl,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 10000),
  ssl: config.databaseSsl === 'disable' ? false : { rejectUnauthorized: false },
});

function currentClient() {
  return transactionStorage.getStore() || pool;
}

function translateSql(sql, params) {
  let text = String(sql)
    .replace(/datetime\(\s*'now'\s*\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/datetime\(\s*'now'\s*,\s*'\+(\d+)\s+(second|seconds|minute|minutes|hour|hours|day|days)'\s*\)/gi, "CURRENT_TIMESTAMP + INTERVAL '$1 $2'")
    .replace(/datetime\(\s*'now'\s*,\s*'-(\d+)\s+(second|seconds|minute|minutes|hour|hours|day|days)'\s*\)/gi, "CURRENT_TIMESTAMP - INTERVAL '$1 $2'")
    .replace(/\bifnull\s*\(/gi, 'COALESCE(')
    // SQLite commonly represents boolean flags as 0/1. Supabase/PostgreSQL
    // commonly represents the same columns as BOOLEAN. Keep the existing
    // route SQL compatible with either representation without changing the
    // user's Supabase schema.
    .replace(/\b(is_active|is_blocked|is_published|is_read|is_placeholder)\s*=\s*1\b/gi, '$1 = TRUE')
    .replace(/\b(is_active|is_blocked|is_published|is_read|is_placeholder)\s*=\s*0\b/gi, '$1 = FALSE');

  if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])) {
    const named = params[0];
    const values = [];
    text = text.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, (_, key) => {
      values.push(named[key]);
      return `$${values.length}`;
    });
    return { text, values: coerceBooleanParams(text, values) };
  }

  let index = 0;
  text = text.replace(/\?/g, () => `$${++index}`);
  return { text, values: coerceBooleanParams(text, params) };
}

const BOOLEAN_COLUMNS = new Set([
  'is_active',
  'is_blocked',
  'is_published',
  'is_read',
  'is_placeholder',
]);

function coerceBooleanParams(sql, values) {
  const result = [...values];

  // Handle UPDATE/WHERE forms such as `is_active = ?` and
  // `is_blocked = COALESCE(?, is_blocked)`.
  for (const column of BOOLEAN_COLUMNS) {
    const direct = new RegExp(`\\b${column}\\s*=\\s*\\$(\\d+)`, 'gi');
    const coalesce = new RegExp(`\\b${column}\\s*=\\s*COALESCE\\(\\$(\\d+)\\s*,`, 'gi');
    for (const re of [direct, coalesce]) {
      let match;
      while ((match = re.exec(sql))) {
        const position = Number(match[1]) - 1;
        if (position >= 0 && position < result.length && (result[position] === 0 || result[position] === 1)) {
          result[position] = Boolean(result[position]);
        }
      }
    }
  }

  // Handle INSERT statements where boolean columns appear in the column list.
  const insert = sql.match(/INSERT\s+INTO\s+\w+\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/is);
  if (insert) {
    const columns = insert[1].split(',').map((v) => v.trim().replace(/^["`]|["`]$/g, '').toLowerCase());
    const placeholders = insert[2].split(',').map((v) => v.trim());
    columns.forEach((column, i) => {
      if (!BOOLEAN_COLUMNS.has(column)) return;
      const match = placeholders[i].match(/^\$(\d+)$/);
      if (!match) return;
      const position = Number(match[1]) - 1;
      if (position >= 0 && position < result.length && (result[position] === 0 || result[position] === 1)) {
        result[position] = Boolean(result[position]);
      }
    });
  }

  return result;
}

class PreparedStatement {
  constructor(sql) {
    this.sql = sql;
  }

  async get(...params) {
    const query = translateSql(this.sql, params);
    const result = await currentClient().query(query);
    return result.rows[0];
  }

  async all(...params) {
    const query = translateSql(this.sql, params);
    const result = await currentClient().query(query);
    return result.rows;
  }

  async run(...params) {
    let sql = this.sql.trim().replace(/;\s*$/, '');
    const isInsert = /^INSERT\b/i.test(sql);
    if (isInsert && !/\bRETURNING\b/i.test(sql)) {
      sql += ' RETURNING *';
    }

    const query = translateSql(sql, params);
    const result = await currentClient().query(query);
    const first = result.rows[0] || null;

    return {
      changes: result.rowCount || 0,
      lastInsertRowid: first?.id ?? null,
      row: first,
    };
  }
}

const db = {
  prepare(sql) {
    return new PreparedStatement(sql);
  },

  // Kept callable as db.transaction(fn)() to minimize changes to the existing
  // route code. The returned function starts the transaction and resolves its result.
  transaction(callback) {
    return async () => {
      const client = await pool.connect();
      let released = false;
      try {
        await client.query('BEGIN');
        const result = await transactionStorage.run(client, callback);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } finally {
          client.release();
          released = true;
        }
        throw error;
      } finally {
        if (!released) client.release();
      }
    };
  },

  async close() {
    await pool.end();
  },
};

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');


async function initializeDatabase() {
  await pool.query(schema);
}

db.initialize = initializeDatabase;

module.exports = db;
