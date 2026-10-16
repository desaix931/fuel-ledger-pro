'use strict';
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render's managed Postgres needs SSL; harmless locally.
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => console.error('pg pool error:', err.message));

module.exports = pool;
