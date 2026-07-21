// ── Database layer (Turso / libSQL — cloud SQLite) ──────────────────────────
// In production, point TURSO_DATABASE_URL + TURSO_AUTH_TOKEN at a free Turso
// database so accounts persist across restarts/redeploys. With no env vars set,
// it falls back to a local file (fine for development).
const { createClient } = require('@libsql/client');

const url = process.env.TURSO_DATABASE_URL || ('file:' + require('path').join(__dirname, 'policyauth.db'));
const authToken = process.env.TURSO_AUTH_TOKEN;
const client = createClient(authToken ? { url, authToken } : { url });

async function init() {
  await client.batch([
    `CREATE TABLE IF NOT EXISTS agencies (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS users (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       agency_id INTEGER NOT NULL,
       email TEXT NOT NULL UNIQUE,
       name TEXT NOT NULL,
       password_hash TEXT NOT NULL,
       role TEXT NOT NULL DEFAULT 'owner',
       recovery_hash TEXT,
       sess TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
    `CREATE TABLE IF NOT EXISTS invite_codes (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       code TEXT NOT NULL UNIQUE,
       note TEXT,
       used INTEGER NOT NULL DEFAULT 0,
       used_by TEXT,
       used_at TEXT,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  ], 'write');
}

// Small async helpers so the rest of the code reads like normal SQL.
async function get(sql, args = []) { const r = await client.execute({ sql, args }); return r.rows[0]; }
async function all(sql, args = []) { const r = await client.execute({ sql, args }); return r.rows; }
async function run(sql, args = []) {
  const r = await client.execute({ sql, args });
  return { lastInsertRowid: r.lastInsertRowid != null ? Number(r.lastInsertRowid) : null, changes: r.rowsAffected };
}
// Run several statements atomically (used for register).
async function tx(statements) { return client.batch(statements, 'write'); }

module.exports = { client, init, get, all, run, tx };
