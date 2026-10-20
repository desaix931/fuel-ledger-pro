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

ALTER TABLE fills ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION;
ALTER TABLE fills ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION;
ALTER TABLE fills ADD COLUMN IF NOT EXISTS location_accuracy DOUBLE PRECISION;
ALTER TABLE fills ADD COLUMN IF NOT EXISTS bol_number TEXT;

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

CREATE TABLE IF NOT EXISTS job_applications (
  id                      SERIAL PRIMARY KEY,
  full_name               TEXT NOT NULL,
  phone                   TEXT NOT NULL,
  email                   TEXT NOT NULL,
  street                  TEXT,
  city                    TEXT,
  state                   TEXT,
  zip                     TEXT,
  dob                     DATE,
  cdl_class               TEXT NOT NULL CHECK (cdl_class IN ('A','B','C')),
  endorsements            TEXT NOT NULL DEFAULT '',
  years_experience        NUMERIC(4,1),
  current_employer        TEXT,
  emp1_company            TEXT,
  emp1_dates              TEXT,
  emp1_reason             TEXT,
  emp2_company            TEXT,
  emp2_dates              TEXT,
  emp2_reason             TEXT,
  emp3_company            TEXT,
  emp3_dates              TEXT,
  emp3_reason             TEXT,
  accidents_3yr           BOOLEAN NOT NULL DEFAULT FALSE,
  accidents_details       TEXT,
  violations_3yr          BOOLEAN NOT NULL DEFAULT FALSE,
  violations_details      TEXT,
  license_suspended       BOOLEAN NOT NULL DEFAULT FALSE,
  license_suspended_details TEXT,
  can_pass_drug_test      BOOLEAN,
  twic_holder             BOOLEAN,
  authorized_to_work      BOOLEAN,
  background_consent      BOOLEAN NOT NULL DEFAULT FALSE,
  heard_about             TEXT,
  signature               TEXT NOT NULL,
  signature_date          DATE NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'new'
                          CHECK (status IN ('new','reviewed','hired','declined')),
  source_ip               TEXT,
  email_sent              BOOLEAN NOT NULL DEFAULT FALSE,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 49 CFR 391.21(b) application fields added 2026-10-17 (idempotent).
ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS ssn TEXT;
ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS cdl_state TEXT;
ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS cdl_number TEXT;
ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS cdl_expiry DATE;
ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS equipment_types TEXT NOT NULL DEFAULT '';
ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS prev_addresses JSONB NOT NULL DEFAULT '[]';
ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS employers JSONB NOT NULL DEFAULT '[]';
ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS cmv_history JSONB NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS idx_applications_status ON job_applications (status);
CREATE INDEX IF NOT EXISTS idx_applications_created ON job_applications (created_at);

-- Applicant document photos (license front/back, DOT medical card, extras).
-- Stored as bytea (NOT on disk): Render's container disk is ephemeral,
-- but the Postgres volume survives restarts and redeploys.
CREATE TABLE IF NOT EXISTS application_documents (
  id             SERIAL PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
  doc_type       TEXT NOT NULL CHECK (doc_type IN ('license_front','license_back','medical_card','other')),
  filename       TEXT NOT NULL,
  mimetype       TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  data           BYTEA NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_docs_application ON application_documents (application_id);

-- BOL (Bill of Lading) photos attached to fill entries. Same storage pattern
-- as application_documents: bytea in Postgres (NOT on disk), because Render's
-- container disk is ephemeral. Deleted automatically when the fill is deleted.
CREATE TABLE IF NOT EXISTS fill_documents (
  id             SERIAL PRIMARY KEY,
  fill_id        INTEGER NOT NULL REFERENCES fills(id) ON DELETE CASCADE,
  filename       TEXT NOT NULL,
  mimetype       TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  data           BYTEA NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fill_docs_fill ON fill_documents (fill_id);

-- DOT compliance hiring packages (FMCSA Part 391 / Part 382 driver qualification
-- paperwork). Filled out by the prospective driver AFTER the job application;
-- separate from the /apply application. The package is ALWAYS saved, even when
-- no matching job_applications row is found (match_status='unmatched'), so the
-- office can reconcile it manually.
CREATE TABLE IF NOT EXISTS dot_packages (
  id                   SERIAL PRIMARY KEY,
  matched_application_id INTEGER REFERENCES job_applications(id) ON DELETE SET NULL,
  full_name            TEXT NOT NULL,
  email                TEXT NOT NULL,
  dob                  DATE,
  employers            JSONB NOT NULL DEFAULT '[]',
  drug_alcohol_history JSONB NOT NULL DEFAULT '{}',
  clearinghouse_ack    BOOLEAN NOT NULL DEFAULT FALSE,
  medical              JSONB NOT NULL DEFAULT '{}',
  violations           JSONB NOT NULL DEFAULT '{}',
  road_test_ack        BOOLEAN NOT NULL DEFAULT FALSE,
  release_signature    TEXT NOT NULL,
  release_date         DATE NOT NULL,
  violation_signature  TEXT NOT NULL,
  violation_date       DATE NOT NULL,
  match_status         TEXT NOT NULL DEFAULT 'unmatched'
                       CHECK (match_status IN ('matched','unmatched')),
  status               TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','reviewed','filed')),
  source_ip            TEXT,
  email_sent           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dot_packages_match ON dot_packages (match_status);
CREATE INDEX IF NOT EXISTS idx_dot_packages_status ON dot_packages (status);
CREATE INDEX IF NOT EXISTS idx_dot_packages_created ON dot_packages (created_at);

CREATE INDEX IF NOT EXISTS idx_fills_filled_at ON fills (filled_at);
CREATE INDEX IF NOT EXISTS idx_fills_customer  ON fills (customer_id);
CREATE INDEX IF NOT EXISTS idx_fills_driver    ON fills (driver_id);
CREATE INDEX IF NOT EXISTS idx_jobs_date       ON jobs (scheduled_date);
CREATE INDEX IF NOT EXISTS idx_jobs_driver     ON jobs (driver_id);

-- Quick-pick values removed from the fill form's tap-to-reuse chips (the × on
-- a chip). hidden_through is the value's most recent fill time at dismissal;
-- the chip comes back on its own if a newer fill uses the value again.
CREATE TABLE IF NOT EXISTS hidden_suggestions (
  kind           TEXT NOT NULL CHECK (kind IN ('equipment', 'bol')),
  value          TEXT NOT NULL,
  hidden_through TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kind, value)
);
