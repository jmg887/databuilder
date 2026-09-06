# API Endpoints — Revenue Attribution Analytics (v1)

Base URL is the API Gateway HTTP API endpoint (Terraform output
`api_base_url`).

There are three categories of endpoint:

- **Public** — called by the tracking script, no auth.
- **Webhook** — called by Stripe, verified by signature.
- **Authenticated** — called by the dashboard, requires a Cognito JWT.

---

## Public

### `POST /collect`

Accepts a batch of events from the tracking script. No authentication.
CORS accepts any origin (public tracking endpoint by design). The `siteId`
is validated to exist before any data is written. Best-effort per-site rate
limiting is applied (plus API Gateway throttling).

**Request body**

```json
{
  "siteId": "<uuid>",
  "events": [
    {
      "type": "visitor.created",
      "visitorId": "<uuid>",
      "referrer": "https://news.example.com/",
      "utmSource": "twitter",
      "utmMedium": "social",
      "utmCampaign": "launch",
      "timestamp": "2026-09-03T10:00:00.000Z"
    },
    {
      "type": "pageview",
      "visitorId": "<uuid>",
      "sessionId": "<uuid>",
      "pageUrl": "https://app.example.com/pricing",
      "referrer": "https://news.example.com/",
      "utmSource": "twitter",
      "utmMedium": "social",
      "utmCampaign": "launch",
      "timestamp": "2026-09-03T10:00:01.000Z"
    },
    {
      "type": "identify",
      "visitorId": "<uuid>",
      "email": "buyer@example.com",
      "timestamp": "2026-09-03T10:05:00.000Z"
    }
  ]
}
```

**Event types**

| type | purpose |
|---|---|
| `visitor.created` | first ever load; captures first-touch referrer + UTM (written once) |
| `pageview` | records a pageview, upserting visitor + session |
| `identify` | attaches an email to the visitor for later Stripe attribution |

**Responses**

| status | body |
|---|---|
| `200` | `{ "ok": true, "accepted": <n> }` |
| `400` | `{ "error": "..." }` (bad JSON, missing siteId/events) |
| `404` | `{ "error": "unknown siteId" }` |
| `429` | `{ "error": "rate limit exceeded" }` |

---

## Webhook

### `POST /webhooks/stripe?site=<siteId>`

Receives Stripe webhook events. The `site` query parameter identifies which
site's webhook signing secret to verify against. The `Stripe-Signature`
header is **mandatory** and verified before any processing — unsigned or
invalid requests are rejected with `400`.

Processed event types:

- `checkout.session.completed`
- `invoice.paid`

Other event types are acknowledged with `200` and ignored.

Attribution (first-touch): the payment is matched to a visitor by the
Stripe customer email against a visitor whose email was captured via an
`identify` event. If no match is found, the payment is stored
**unattributed** (`visitor_id = NULL`) — no false match is forced.

Idempotency: `payments.stripe_event_id` is unique, so repeated deliveries of
the same event are de-duped (`{ "ok": true, "deduped": true }`).

**Responses**

| status | body |
|---|---|
| `200` | `{ "ok": true }` / `{ "ok": true, "deduped": true }` / `{ "ok": true, "ignored": "<type>" }` |
| `400` | `{ "error": "missing site query parameter" }` / `missing stripe-signature header` / `signature verification failed` |
| `404` | `{ "error": "unknown site or missing webhook secret" }` |

---

## Authenticated (dashboard)

All routes require a valid Cognito ID token in the
`Authorization: Bearer <jwt>` header. The API Gateway JWT authorizer
verifies the token; the owner user id is taken from the `sub` claim. Every
`/sites/:id/*` route verifies the site is owned by the caller.

### `GET /sites`

List sites owned by the logged-in user.

```json
{ "sites": [ { "id": "...", "name": "...", "domain": "...", "created_at": "..." } ] }
```

### `POST /sites`

Create a new site. Generates a site ID and a copy-pasteable snippet.

**Request**

```json
{ "name": "My SaaS", "domain": "app.example.com" }
```

**Response** `201`

```json
{
  "site": { "id": "<uuid>", "name": "My SaaS", "domain": "app.example.com", "created_at": "..." },
  "snippet": "<script async src=\"https://.../t.js\" data-site-id=\"<uuid>\"></script>"
}
```

### `GET /sites/:id/overview?range=7d|30d|90d`

Traffic + revenue by first-touch source for the date range (default `30d`).

```json
{
  "range": { "days": 30, "start": "..." },
  "totals": { "total_visitors": 1234, "total_revenue_cents": 45600 },
  "breakdown": [
    {
      "source": "twitter",
      "visitors": 300,
      "revenue_cents": 20000,
      "payments": 4,
      "revenue_per_visitor_cents": 66
    },
    { "source": "(unattributed)", "visitors": 0, "revenue_cents": 5000, "payments": 1, "revenue_per_visitor_cents": 0 }
  ]
}
```

### `GET /sites/:id/visitors?range=7d|30d|90d`

Visitor list with first-touch attribution detail and per-visitor revenue
(default `30d`, capped at 500 rows).

```json
{
  "range": { "days": 30, "start": "..." },
  "visitors": [
    {
      "id": "<uuid>",
      "first_seen_at": "...",
      "first_referrer": "https://news.example.com/",
      "first_utm_source": "twitter",
      "first_utm_medium": "social",
      "first_utm_campaign": "launch",
      "email": "buyer@example.com",
      "revenue_cents": 5000,
      "payments": 1
    }
  ]
}
```

**Auth error**

| status | body |
|---|---|
| `401` | `{ "error": "unauthorized" }` |
| `404` | `{ "error": "site not found" }` (unknown or not owned) |

---

## Authenticated — Stripe self-service integration

Same auth + ownership rules as the other `/sites/:id/*` routes. Restricted
keys and signing secrets are stored only in Secrets Manager and are **never**
returned by any endpoint.

### `GET /sites/:id/integrations`

Current connection status, for the dashboard to render on load.

```json
{
  "stripe": {
    "connected": true,
    "connectedAt": "2026-09-05T10:00:00.000Z",
    "backfillStatus": "complete"
  }
}
```

When not connected: `{ "stripe": { "connected": false, "connectedAt": null, "backfillStatus": null } }`.

### `POST /sites/:id/integrations/stripe`

Connect Stripe using a customer-generated **restricted API key**.

**Request**

```json
{ "stripeRak": "rk_live_..." }
```

**Behavior**

1. Validate the key starts with `rk_live_` (test/secret/publishable keys are
   rejected before any Stripe call — see *Key policy* below).
2. Store the key in Secrets Manager (`databuilder-prod/site-<id>-stripe-rak`)
   and reference it from `sites.stripe_restricted_key_secret`.
3. Create a Stripe webhook endpoint using the customer's key:
   - `url`: `<api_base_url>/webhooks/stripe?site=<id>`
   - `enabled_events`: `["checkout.session.completed", "invoice.paid"]`
4. Store the returned signing `secret` (returned only once) in Secrets Manager
   (`databuilder-prod/site-<id>-stripe-webhook`) and reference it from
   `sites.stripe_webhook_secret`.
5. Set `stripe_connected_at = now()`, `stripe_backfill_status = 'pending'`,
   persist the webhook endpoint id.
6. Run the one-time backfill (Section 7) **synchronously**.
7. Return `201`.

If webhook creation fails, the stored restricted key is rolled back and
Stripe's own error message is surfaced.

**Key policy (implementer decision):** only `rk_live_` is accepted. `sk_…`,
`pk_…`, and `rk_test_…` are rejected with `invalid key format`. This is the
brief's documented default (reject test keys in production).

**Responses**

| status | body |
|---|---|
| `201` | `{ "connected": true, "backfillStatus": "complete" }` (or `"failed"` if backfill errored — the connection itself still succeeds) |
| `400` | `{ "error": "invalid key format" }` / `{ "error": "insufficient permissions: <stripe detail>" }` / `{ "error": "stripe error: <detail>" }` |
| `404` | `{ "error": "site not found" }` |
| `409` | `{ "error": "stripe already connected for this site" }` |

### `DELETE /sites/:id/integrations/stripe`

1. Delete the webhook on Stripe (`webhookEndpoints.del`) using the stored
   restricted key + endpoint id (best-effort).
2. Delete both Secrets Manager entries (rak + webhook secret).
3. Clear the Stripe columns on the `sites` row.

**Responses**

| status | body |
|---|---|
| `200` | `{ "disconnected": true }` |
| `404` | `{ "error": "site not found" }` / `{ "error": "not connected" }` |

---

## Backfill

Runs once, synchronously, immediately after a successful connect (MVP choice —
no extra Lambda/queue).

**Source of history.** It paginates Stripe's **Checkout Sessions** list
(`stripe.checkout.sessions.list`), **not** the Events API. The Events API only
retains events for the last 30 days ("List events, going back up to 30 days"),
so sourcing from it silently dropped any payment older than a month — defeating
the purpose of a backfill. Checkout Session objects are bounded only by the
account's own data retention, so historical payments older than 30 days are
included. Only sessions with `payment_status = 'paid'` are recorded.

Each session is normalized with the **shared** `extractFromCheckoutSession` and
inserted with the **shared** `insertPayment` — the exact same attribution
matching the live webhook uses.

**Synthetic ids + idempotency.** Session objects have no Stripe `evt_…` id, so
for the unique `payments(stripe_event_id)` constraint the backfill uses a
stable, deterministic synthetic id `backfill_<session.id>`. The same session
always yields the same id, so re-running the backfill inserts nothing new
(`ON CONFLICT (stripe_event_id) DO NOTHING RETURNING id` — a row is returned
only on a real insert).

**Known tradeoff (documented choice).** A real webhook for the same underlying
payment carries a genuine `evt_…` id, a **different id namespace** from
`backfill_…`. The backfill deliberately does not reconcile the two (no fuzzy
customer+amount+time matching). Consequence: for a payment within the recent
window where the live webhook also fired, two rows can exist for the same
real-world payment (one `evt_…`, one `backfill_…`). This is accepted to keep
the backfill idempotent and simple; it only affects the narrow recent overlap
window (older payments — the whole point of the backfill — have no live-webhook
counterpart). Chosen over amount+time-window matching, which is heuristic and
can wrongly merge two genuinely distinct payments.

On error partway, `stripe_backfill_status` is set to `failed`.
