'use strict';

const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

// Each entry runs once, in order; PRAGMA user_version records progress.
const migrations = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    postal_address TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    last_login_at TEXT,
    home_until TEXT,
    landlord_until TEXT,
    sub_sku TEXT,
    sub_status TEXT,
    sub_token TEXT,
    sub_started_at TEXT,
    sub_cancelled_at TEXT,
    reminder_day INTEGER NOT NULL DEFAULT 1,
    email_opt_in INTEGER NOT NULL DEFAULT 1,
    anon_id TEXT,
    referrer TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );

  CREATE TABLE properties (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nickname TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    municipality TEXT NOT NULL DEFAULT '',
    account_number TEXT NOT NULL DEFAULT '',
    account_holder TEXT NOT NULL DEFAULT '',
    stand_number TEXT NOT NULL DEFAULT '',
    water_meter_no TEXT NOT NULL DEFAULT '',
    elec_meter_no TEXT NOT NULL DEFAULT '',
    track_water INTEGER NOT NULL DEFAULT 1,
    track_electricity INTEGER NOT NULL DEFAULT 0,
    dispute_email TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_properties_user ON properties(user_id);

  CREATE TABLE readings (
    id INTEGER PRIMARY KEY,
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    utility TEXT NOT NULL CHECK (utility IN ('water','electricity')),
    reading_date TEXT NOT NULL,
    value REAL NOT NULL,
    photo_file TEXT,
    photo_mime TEXT,
    photo_taken_at TEXT,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_readings_property ON readings(property_id, utility, reading_date);

  CREATE TABLE bills (
    id INTEGER PRIMARY KEY,
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    bill_date TEXT NOT NULL,
    due_date TEXT,
    total_due_cents INTEGER NOT NULL DEFAULT 0,
    document_file TEXT,
    document_mime TEXT,
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_bills_property ON bills(property_id, bill_date);

  CREATE TABLE bill_lines (
    id INTEGER PRIMARY KEY,
    bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('consumption','charge','interest')),
    utility TEXT,
    label TEXT NOT NULL DEFAULT '',
    reading_type TEXT NOT NULL DEFAULT 'unknown',
    prev_reading REAL,
    curr_reading REAL,
    prev_date TEXT,
    curr_date TEXT,
    units_billed REAL,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    disputed INTEGER NOT NULL DEFAULT 0,
    dispute_reason TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX idx_bill_lines_bill ON bill_lines(bill_id);

  CREATE TABLE disputes (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    bill_ids TEXT NOT NULL DEFAULT '[]',
    disputed_amount_cents INTEGER NOT NULL DEFAULT 0,
    undisputed_monthly_cents INTEGER NOT NULL DEFAULT 0,
    findings_json TEXT NOT NULL DEFAULT '{}',
    grounds_extra TEXT NOT NULL DEFAULT '',
    lodged_at TEXT,
    reference_number TEXT NOT NULL DEFAULT '',
    resolved_at TEXT,
    outcome TEXT NOT NULL DEFAULT '',
    credit_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_disputes_user ON disputes(user_id);

  CREATE TABLE dispute_events (
    id INTEGER PRIMARY KEY,
    dispute_id INTEGER NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
    event_date TEXT NOT NULL,
    kind TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    reference TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE payments (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_email TEXT NOT NULL DEFAULT '',
    sku TEXT NOT NULL,
    method TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    amount_cents INTEGER NOT NULL,
    fee_cents INTEGER NOT NULL DEFAULT 0,
    m_payment_id TEXT UNIQUE,
    pf_payment_id TEXT UNIQUE,
    reference TEXT,
    is_recurring INTEGER NOT NULL DEFAULT 0,
    raw TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX idx_payments_user ON payments(user_id);
  CREATE INDEX idx_payments_status ON payments(status, completed_at);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    ts TEXT NOT NULL,
    anon_id TEXT,
    user_id INTEGER,
    name TEXT NOT NULL,
    path TEXT,
    referrer TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    props TEXT
  );
  CREATE INDEX idx_events_name_ts ON events(name, ts);
  CREATE INDEX idx_events_user ON events(user_id);

  CREATE TABLE reminders_sent (
    key TEXT PRIMARY KEY,
    user_id INTEGER,
    sent_at TEXT NOT NULL
  );
  `,
];

function open(file = config.dbFile) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const { user_version: version } = db.prepare('PRAGMA user_version').get();
  for (let i = version; i < migrations.length; i++) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[i]);
      db.exec(`PRAGMA user_version = ${i + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

const db = open();

// Small helpers so call sites stay terse.
db.one = (sql, ...params) => db.prepare(sql).get(...params);
db.all = (sql, ...params) => db.prepare(sql).all(...params);
db.run = (sql, ...params) => db.prepare(sql).run(...params);
db.tx = (fn) => {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
};

module.exports = db;
