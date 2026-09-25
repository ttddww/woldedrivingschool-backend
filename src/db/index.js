const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('../config');

const DB_PATH = config.dbPath;
const isMemory = DB_PATH === ':memory:';
if (!isMemory) {
  fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
}

const db = new Database(DB_PATH);
if (!isMemory) db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Safe, repeatable migrations for databases created by earlier versions.
const columns = db.prepare('PRAGMA table_info(payments)').all().map((c) => c.name);
if (!columns.includes('amount_type')) db.exec("ALTER TABLE payments ADD COLUMN amount_type TEXT NOT NULL DEFAULT 'full'");
if (!columns.includes('billing_name')) db.exec("ALTER TABLE payments ADD COLUMN billing_name TEXT");
if (!columns.includes('billing_address')) db.exec("ALTER TABLE payments ADD COLUMN billing_address TEXT");
if (!columns.includes('payment_method')) db.exec("ALTER TABLE payments ADD COLUMN payment_method TEXT");

module.exports = db;
