'use strict';

/**
 * Shared Postgres access for all lambdas.
 *
 * The connection pool is created lazily and cached on the module scope so it
 * survives across warm Lambda invocations. DB credentials are pulled from
 * Secrets Manager (secret ARN/name in DB_SECRET_ARN) and never hardcoded.
 *
 * All query helpers use parameterized queries only — no string concatenation
 * into SQL — to prevent injection.
 */

const { Pool } = require('pg');
const { getSecretJson } = require('./secrets');

let pool = null;

async function getPool() {
  if (pool) return pool;

  // DB connection info comes from a Secrets Manager secret shaped like:
  // { "host": "...", "port": 5432, "username": "...", "password": "...",
  //   "dbname": "..." }
  const secretId = process.env.DB_SECRET_ARN;
  if (!secretId) {
    throw new Error('DB_SECRET_ARN environment variable is not set');
  }
  const creds = await getSecretJson(secretId);

  pool = new Pool({
    host: creds.host,
    port: creds.port || 5432,
    user: creds.username,
    password: creds.password,
    database: creds.dbname || creds.database,
    ssl: { rejectUnauthorized: false },
    max: 2, // keep small — many concurrent lambdas each hold a tiny pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });

  return pool;
}

/**
 * Run a parameterized query. `params` values are always bound, never
 * interpolated into the SQL text.
 */
async function query(text, params) {
  const p = await getPool();
  return p.query(text, params);
}

/**
 * Run `fn` inside a transaction, passing it a dedicated client.
 */
async function withTransaction(fn) {
  const p = await getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getPool, query, withTransaction };
