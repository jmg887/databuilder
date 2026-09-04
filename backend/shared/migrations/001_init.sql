-- Revenue Attribution Analytics — v1 initial schema
-- Target: RDS Postgres. Run once against a fresh database.

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()

-- ---------------------------------------------------------------------------
-- sites
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sites (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id         uuid NOT NULL,
  name                  text NOT NULL,
  domain                text,
  stripe_webhook_secret text, -- reference to a Secrets Manager secret name, not plaintext
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- visitors  (first-touch attribution fields)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS visitors (
  id                uuid PRIMARY KEY,           -- generated client-side
  site_id           uuid NOT NULL REFERENCES sites(id),
  first_seen_at     timestamptz,
  first_referrer    text,
  first_utm_source  text,
  first_utm_medium  text,
  first_utm_campaign text,
  email             text,                       -- optional, via identify event
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id            uuid PRIMARY KEY,               -- minted client-side
  visitor_id    uuid NOT NULL REFERENCES visitors(id),
  site_id       uuid NOT NULL REFERENCES sites(id),
  started_at    timestamptz,
  referrer      text,
  landing_page  text,
  utm_source    text,
  utm_medium    text,
  utm_campaign  text
);

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id          bigserial PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES sessions(id),
  site_id     uuid NOT NULL REFERENCES sites(id), -- denormalized for query speed
  type        text NOT NULL,
  page_url    text,
  occurred_at timestamptz
);

-- ---------------------------------------------------------------------------
-- payments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id            uuid NOT NULL REFERENCES sites(id),
  visitor_id         uuid REFERENCES visitors(id),  -- nullable: unattributed allowed
  stripe_event_id    text NOT NULL,
  stripe_customer_id text,
  amount_cents       integer,
  currency           text,
  status             text,
  occurred_at        timestamptz
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_visitors_site_id  ON visitors (site_id, id);
CREATE INDEX IF NOT EXISTS idx_sessions_visitor  ON sessions (visitor_id);
CREATE INDEX IF NOT EXISTS idx_events_site_time   ON events (site_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_payments_site_time ON payments (site_id, occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_stripe_event ON payments (stripe_event_id);
