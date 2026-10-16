-- fuel-ledger-pro schema (PostgreSQL)
-- Applied on every boot; all statements are idempotent.
-- NOTE: all fill timestamps are the business's local time (no time zone),
-- so ledgers always show the time the driver entered.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','driver')),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS customers (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  contact_name  TEXT,
  contact_email TEXT,
  contact_phone TEXT,
  notes         TEXT,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sites (
  id          SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  name        TEXT NOT NULL,
  address     TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS equipment (
  id          SERIAL PRIMARY KEY,
  site_id     INTEGER REFERENCES sites(id),
  label       TEXT NOT NULL,
  eq_type     TEXT,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS fills (
  id              SERIAL PRIMARY KEY,
  filled_at       TIMESTAMP NOT NULL,
  customer_id     INTEGER NOT NULL REFERENCES customers(id),
  site_id         INTEGER REFERENCES sites(id),
  equipment_id    INTEGER REFERENCES equipment(id),
  equipment_label TEXT NOT NULL,
  fuel_type       TEXT NOT NULL,
  gallons         NUMERIC(10,2) NOT NULL CHECK (gallons > 0 AND gallons < 100000),
  driver_id       INTEGER NOT NULL REFERENCES users(id),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jobs (
  id             SERIAL PRIMARY KEY,
  customer_id    INTEGER NOT NULL REFERENCES customers(id),
  site_id        INTEGER REFERENCES sites(id),
  scheduled_date DATE NOT NULL,
  window_start   TIME,
  window_end     TIME,
  driver_id      INTEGER REFERENCES users(id),
  status         TEXT NOT NULL DEFAULT 'scheduled'
                 CHECK (status IN ('scheduled','in_progress','done','cancelled')),
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fills_filled_at ON fills (filled_at);
CREATE INDEX IF NOT EXISTS idx_fills_customer  ON fills (customer_id);
CREATE INDEX IF NOT EXISTS idx_fills_driver    ON fills (driver_id);
CREATE INDEX IF NOT EXISTS idx_jobs_date       ON jobs (scheduled_date);
CREATE INDEX IF NOT EXISTS idx_jobs_driver     ON jobs (driver_id);
