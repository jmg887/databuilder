-- Onboarding checklist — additive migration.
-- Extends the existing `sites` table; does NOT recreate it.
-- Safe to run against the deployed database.

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS onboarding_dismissed_at timestamptz; -- set when the user dismisses the completed onboarding banner

-- The onboarding checklist's current step is DERIVED from real data
-- (site exists / has traffic / stripe_connected_at), never stored. This
-- column only records whether the user has dismissed the "setup complete"
-- banner, so the dismissal persists across sessions and devices.
