# Database Schema — Revenue Attribution Analytics (v1)

Primary database: **RDS Postgres**. Chosen over DynamoDB because the product
relies on relational queries: group-by source, joins between sessions and
payments, and date-range filters.

All tables live in the default `public` schema. The canonical DDL is in
`backend/shared/migrations/001_init.sql`.

---

## `sites`

The website being tracked. One owner per site (single-owner in v1).

| column | type | notes |
|---|---|---|
| `id` | `uuid` PK (default `gen_random_uuid()`) | public site ID, embedded in the tracking script |
| `owner_user_id` | `uuid` | Cognito user sub |
| `name` | `text` | display name |
| `domain` | `text` | site domain |
| `stripe_webhook_secret` | `text` | **reference** to the Secrets Manager secret name, not the plaintext value. Populated automatically by the self-service connect flow (Stripe webhook-creation response) |
| `stripe_restricted_key_secret` | `text` | **reference** to the Secrets Manager secret holding the customer's Stripe restricted key (`rk_live_…`), never plaintext. Added by migration `002` |
| `stripe_webhook_endpoint_id` | `text` | Stripe webhook endpoint id (`we_…`), kept so the endpoint can be deleted on disconnect. Added by migration `002` |
| `stripe_connected_at` | `timestamptz` | when Stripe was connected (null = not connected). Added by migration `002` |
| `stripe_backfill_status` | `text` | `pending` \| `running` \| `complete` \| `failed`. Added by migration `002` |
| `onboarding_dismissed_at` | `timestamptz` | set when the user dismisses the completed onboarding banner; null = not dismissed. Added by migration `003` |
| `created_at` | `timestamptz` default `now()` | |

> The Stripe self-service integration columns are added by
> `backend/shared/migrations/002_stripe_integration.sql` (additive `ALTER
> TABLE`; the table is not recreated). Restricted keys and signing secrets
> live only in Secrets Manager under `databuilder-prod/site-<id>-stripe-rak`
> and `databuilder-prod/site-<id>-stripe-webhook`; the columns store only the
> secret *names*.

> The onboarding checklist's current step is **derived** from real data
> (site exists / has traffic / `stripe_connected_at`), never stored.
> `onboarding_dismissed_at` (migration `003`,
> `backend/shared/migrations/003_onboarding.sql`) only records whether the
> user dismissed the "setup complete" banner, so dismissal persists across
> sessions and devices — no separate mutable "current step" column exists.

---

## `visitors`

A unique visitor, identified by a first-party cookie UUID generated
client-side. Holds the **first-touch** attribution fields captured on the
visitor's very first page load.

| column | type | notes |
|---|---|---|
| `id` | `uuid` PK | generated client-side, stored in a 1-year first-party cookie |
| `site_id` | `uuid` FK → `sites(id)` | |
| `first_seen_at` | `timestamptz` | |
| `first_referrer` | `text` | raw referrer URL on first visit |
| `first_utm_source` | `text` | |
| `first_utm_medium` | `text` | |
| `first_utm_campaign` | `text` | |
| `email` | `text` nullable | captured via an optional `identify` event; used to match Stripe payments |
| `created_at` | `timestamptz` default `now()` | |

> First-touch is enforced by the ingest lambda: visitor rows are inserted
> once (`ON CONFLICT (id) DO NOTHING`), so the first UTM/referrer values are
> never overwritten by later visits.

---

## `sessions`

A visit grouping. A new session starts after ~30 min of inactivity (session
ID minted client-side by the tracking script).

| column | type | notes |
|---|---|---|
| `id` | `uuid` PK | minted client-side |
| `visitor_id` | `uuid` FK → `visitors(id)` | |
| `site_id` | `uuid` FK → `sites(id)` | |
| `started_at` | `timestamptz` | |
| `referrer` | `text` | |
| `landing_page` | `text` | |
| `utm_source` | `text` | |
| `utm_medium` | `text` | |
| `utm_campaign` | `text` | |

---

## `events`

Individual events, mainly `pageview`.

| column | type | notes |
|---|---|---|
| `id` | `bigserial` PK | |
| `session_id` | `uuid` FK → `sessions(id)` | |
| `site_id` | `uuid` FK → `sites(id)` | denormalized for query speed |
| `type` | `text` | e.g. `pageview` |
| `page_url` | `text` | |
| `occurred_at` | `timestamptz` | |

---

## `payments`

Stripe payment events, with a nullable link to the attributed visitor.

| column | type | notes |
|---|---|---|
| `id` | `uuid` PK (default `gen_random_uuid()`) | |
| `site_id` | `uuid` FK → `sites(id)` | |
| `visitor_id` | `uuid` FK → `visitors(id)`, nullable | null when the payment could not be attributed |
| `stripe_event_id` | `text` | idempotency key — dedupes repeated webhook deliveries |
| `stripe_customer_id` | `text` | |
| `amount_cents` | `integer` | |
| `currency` | `text` | |
| `status` | `text` | e.g. `paid`, `refunded` |
| `occurred_at` | `timestamptz` | |

---

## Indexes

| index | table / columns | purpose |
|---|---|---|
| `idx_visitors_site_id` | `visitors(site_id, id)` | visitor lookups per site |
| `idx_sessions_visitor` | `sessions(visitor_id)` | join sessions to a visitor |
| `idx_events_site_time` | `events(site_id, occurred_at)` | date-range traffic queries |
| `idx_payments_site_time` | `payments(site_id, occurred_at)` | date-range revenue queries |
| `uq_payments_stripe_event` | `payments(stripe_event_id)` UNIQUE | webhook idempotency |

---

## Attribution model

Revenue is attributed **first-touch**: a payment's revenue is credited to
the channel the visitor arrived on during their *first* visit
(`visitors.first_utm_source` / `first_referrer`), not their latest session.

The join for dashboard aggregation is:

```
payments → visitors (visitor_id) → first_utm_source / first_referrer
```

Unattributed payments (`visitor_id IS NULL`) are surfaced under a
`(unattributed)` bucket rather than dropped.
