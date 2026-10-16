'use strict';
// Applies db/schema.sql (idempotent). Run standalone or on server boot.
const fs = require('fs');
const path = require('path');
const pool = require('./db');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await pool.query(sql);
}

if (require.main === module) {
  migrate()
    .then(() => { console.log('migrations applied'); return pool.end(); })
    .catch((err) => { console.error('migration failed:', err.message); process.exit(1); });
} else {
  module.exports = migrate;
}
