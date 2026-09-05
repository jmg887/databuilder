-- Self-service Stripe integration — additive migration.
-- Extends the existing `sites` table; does NOT recreate it.
-- Safe to run against the deployed v1 database.

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS stripe_restricted_key_secret text,  -- Secrets Manager reference, not plaintext
  ADD COLUMN IF NOT EXISTS stripe_connected_at          timestamptz,
  ADD COLUMN IF NOT EXISTS stripe_backfill_status        text, -- 'pending' | 'running' | 'complete' | 'failed'
  ADD COLUMN IF NOT EXISTS stripe_webhook_endpoint_id    text; -- Stripe webhook endpoint id, kept so we can delete it on disconnect

-- `stripe_webhook_secret` (already present) continues to be used exactly as
-- before; this feature only changes how it gets populated (via the Stripe API
-- webhook-creation response, instead of manual copy-paste).
