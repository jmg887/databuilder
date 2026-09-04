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
