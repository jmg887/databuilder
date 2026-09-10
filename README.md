# databuilder — Revenue Attribution Analytics (MVP)

A lean web-analytics tool for indie founders and small SaaS teams that
connects website traffic to actual paying customers. It answers one
question: **which marketing channel brought in customers who actually
paid?**

Attribution is **first-touch**: revenue is credited to the channel a
visitor arrived on during their very first visit.

This is the v1 MVP. Scope is deliberately narrow — see
[Scope](#scope--v1) and [Non-goals](#non-goals--future-phases).

---

## Architecture

```
Tracking script (t.js)  ──POST /collect──▶  ingest lambda ──▶ ┐
                                                              │
Stripe ──POST /webhooks/stripe (signed)──▶ stripe-webhook ──▶ ├─▶ RDS Postgres
                                            (attribution)     │
Dashboard (React) ──GET/POST /sites…(JWT)─▶ dashboard-api ──▶ ┘
```

- **Cloud:** AWS, region **eu-north-1**
- **API:** API Gateway (HTTP API)
- **Compute:** AWS Lambda, Node.js 20
- **Database:** RDS Postgres (relational: group-by, joins, date ranges)
- **Static hosting:** S3 + CloudFront (tracking script + dashboard build; the
  marketing landing page is a separate S3 bucket + CloudFront distribution)
- **Auth:** Cognito (dashboard login only; tracking script is unauthenticated,
  keyed by a public site ID)
- **Secrets:** AWS Secrets Manager (Stripe keys + DB credentials) — never
  hardcoded, never committed
- **IaC:** Terraform (`/infra`), remote state in S3 + DynamoDB lock table

---

## Repository structure

```
/infra              Terraform for all AWS resources
/backend
  /lambdas
    /ingest          receives tracking-script events (POST /collect)
    /stripe-webhook  verifies Stripe signature + runs attribution
    /dashboard-api   serves aggregated data to the frontend
  /shared            shared DB access / utilities (packaged as a Lambda layer)
/frontend
  /dashboard         React dashboard
  /tracking-script   the JS snippet (built/bundled separately)
  /landing           public marketing landing page (static HTML, separate host)
/docs
  schema.md          database schema
  api.md             API endpoint reference
```

---

## Scope — v1

1. A JavaScript tracking snippet pasteable into any website.
2. A backend that receives pageview/session events.
3. A Stripe webhook receiver that captures payment events.
4. Attribution logic joining a payment back to the visitor's original
   (first-touch) traffic source.
5. A dashboard showing traffic by source, revenue by source, and revenue
   per visitor by channel.

### Addendum — self-service Stripe connection

Site owners connect Stripe themselves by pasting a restricted API key
(`rk_live_…`) into the dashboard. The backend then registers the webhook via
the Stripe API, stores the signing secret, and backfills historical payments
automatically — no manual webhook setup. See
[Connecting Stripe](#connecting-stripe-self-service).

## Non-goals — future phases

Not built in v1: funnels/goal builder, live visitor feed/websockets, MCP /
AI-agent query layer, payment providers other than Stripe, team/multi-user
roles, mobile SDK, social mention tracking, cookieless-mode toggle, and
CMS/no-code platform plugins. These are future-phase items.

---

## Data model

See [`docs/schema.md`](docs/schema.md). Tables: `sites`, `visitors`,
`sessions`, `events`, `payments`. Canonical DDL:
[`backend/shared/migrations/001_init.sql`](backend/shared/migrations/001_init.sql).

## API

See [`docs/api.md`](docs/api.md).

---

## Deploy the infrastructure

> Prerequisites: Terraform ≥ 1.5, AWS credentials with permission to create
> the resources, Node.js 20. The remote-state S3 bucket
> (`databuilder-terraform-state-2026`) and DynamoDB lock table
> (`terraform-locks`) already exist — do not recreate them.

1. **Build the lambda packages + frontend** (installs prod deps and stages
   the shared layer so Terraform can zip complete packages):

   ```bash
   make build
   ```

2. **Provision AWS resources:**

   ```bash
   cd infra
   terraform init
   terraform apply
   ```

   Note the outputs: `api_base_url`, `cognito_user_pool_id`,
   `cognito_client_id`, `assets_bucket`, `cloudfront_domain`,
   `stripe_webhook_url`, `stripe_secret_arn`, `db_secret_arn`,
   `landing_bucket`, `landing_url`, `landing_signup_url`.

3. **Load the database schema.** The RDS instance is private; run the
   migration from inside the VPC (bastion / one-off task / your VPN), using
   the credentials stored in the `db-credentials` secret:

   ```bash
   # run migrations in order
   psql "$DATABASE_URL" -f backend/shared/migrations/001_init.sql
   psql "$DATABASE_URL" -f backend/shared/migrations/002_stripe_integration.sql
   ```

   Migration `002` adds the Stripe self-service columns to `sites`
   (additive `ALTER TABLE`, safe on the deployed v1 database).

4. **Stripe connection.** With the self-service integration (see
   [Connecting Stripe](#connecting-stripe-self-service)), site owners connect
   Stripe themselves from the dashboard — no manual webhook setup or
   signing-secret copying. The legacy `stripe_secret_arn` placeholder secret
   remains for backward compatibility but is no longer part of the normal
   flow.

5. **Deploy the static assets** (tracking script + dashboard build) to S3:

   ```bash
   # tracking script
   aws s3 cp frontend/tracking-script/dist/t.js "s3://$(terraform output -raw assets_bucket)/t.js" \
     --content-type application/javascript

   # dashboard (build first with the Cognito/API values, see below)
   aws s3 sync frontend/dashboard/dist "s3://$(terraform output -raw assets_bucket)/"
   ```

6. **Landing page.** The marketing landing page
   (`frontend/landing/index.html`) is a single static file hosted on its
   **own** S3 bucket + CloudFront distribution, separate from the dashboard.
   Terraform uploads it for you (via the `aws_s3_object.landing_index`
   resource), rendering the three "Get early access" links to point at the
   dashboard's sign-up route (`https://<dashboard CloudFront>/login`) — so a
   plain `terraform apply` publishes it; no manual `s3 sync` needed. Its public
   URL is the `landing_url` output. To point the CTAs at a different sign-up
   entry point (e.g. a future custom domain), set `-var landing_signup_url=…`.
   No custom domain is configured yet — it serves on the default CloudFront
   domain (brief §5).

---

## Run the frontend locally

```bash
cd frontend/dashboard
cp .env.example .env.local   # fill in values from terraform output
npm install
npm run dev
```

`.env.local` values:

| var | source |
|---|---|
| `VITE_API_BASE_URL` | `terraform output api_base_url` |
| `VITE_COGNITO_USER_POOL_ID` | `terraform output cognito_user_pool_id` |
| `VITE_COGNITO_CLIENT_ID` | `terraform output cognito_client_id` |

---

## Connecting Stripe (self-service)

Site owners connect Stripe themselves from the dashboard's **Payments —
Stripe** section on the site detail page. No manual webhook creation, no
copying signing secrets by hand.

**What the customer does**

1. In the [Stripe Dashboard](https://dashboard.stripe.com) → Developers →
   API keys → **Create restricted key**, granting exactly:

   | Resource | Permission | Why |
   |---|---|---|
   | Webhooks | **Write** | create the webhook endpoint |
   | Checkout Sessions | **Read** | backfill historical payments |
   | Payment Intents | **Read** | backfill historical payments |
   | Customers | **Read** | resolve customer email for attribution |

2. Paste the restricted key (`rk_live_…`) into the dashboard and click
   **Connect**.

**What the backend does automatically** (`POST /sites/:id/integrations/stripe`)

1. Validates the key format (**only `rk_live_` accepted** — `sk_`/`pk_`/
   `rk_test_` are rejected; this is the brief's documented default).
2. Stores the restricted key in Secrets Manager
   (`databuilder-prod/site-<id>-stripe-rak`).
3. Creates the webhook endpoint on Stripe (`webhookEndpoints.create`) for
   `checkout.session.completed` + `invoice.paid`, pointed at
   `<api_base_url>/webhooks/stripe?site=<id>`.
4. Stores the returned signing secret
   (`databuilder-prod/site-<id>-stripe-webhook`) and references it from
   `sites.stripe_webhook_secret`.
5. Runs a **one-time synchronous backfill** of historical payments by listing
   Stripe **Checkout Sessions** (not the 30-day-capped Events API, so payments
   older than a month are included), attributing each to a visitor by email
   using the same shared matching logic as the live webhook. Backfilled rows
   use a synthetic `backfill_<session.id>` id and are idempotent on re-run;
   see [docs/api.md](docs/api.md#backfill) for the id-namespace tradeoff.

If the key lacks a required scope, Stripe's own permission error is surfaced
directly to the user. **Disconnect** (`DELETE …/integrations/stripe`) removes
the webhook from Stripe and deletes both stored secrets.

Restricted keys and signing secrets live only in Secrets Manager — never
committed, never logged, never returned by any API response.

### Local development with Stripe test mode

For local webhook testing you can still forward events with the Stripe CLI:

```bash
stripe listen --forward-to "http://localhost:3000/webhooks/stripe?site=<siteId>"
stripe trigger checkout.session.completed
```

---

## Manual end-to-end test (Definition of Done)

1. Sign up in the dashboard, create a site, copy the tracking snippet.
2. Build the tracking script (`cd frontend/tracking-script && npm run build`),
   drop the snippet into a page (see
   [`frontend/tracking-script/example.html`](frontend/tracking-script/example.html)),
   and visit it with UTM params:
   `?utm_source=twitter&utm_medium=social&utm_campaign=launch`.
   Confirm `sessions` / `events` rows appear in Postgres.
3. Fire `databuilder.identify("buyer@example.com")` (simulated signup), then
   trigger a Stripe test payment for `buyer@example.com`.
4. Confirm the dashboard shows the revenue attributed to `twitter` for the
   chosen date range, with total visitors, total revenue, and the
   per-source breakdown.

---

## Tracking snippet

```html
<script async src="https://<cloudfront_domain>/t.js" data-site-id="<siteId>"></script>
```

The script (built to `frontend/tracking-script/dist/t.js`, ~2.8 KB minified):
generates a first-party visitor-ID cookie (1-year expiry), mints a session ID
that rolls over after ~30 min of inactivity, captures URL/referrer/UTM, fires
on load and on SPA `pushState`/`popstate`, and sends via `navigator.sendBeacon`
with a `fetch(keepalive)` fallback. Call `databuilder.identify(email)` from
your signup flow to enable payment attribution.

---

## Security

- Stripe webhook signature verification is mandatory (invalid/unsigned →
  rejected).
- Authenticated dashboard endpoints require a valid Cognito JWT.
- All SQL uses parameterized queries (no string concatenation).
- `/collect` CORS allows any origin but validates the site ID exists before
  writing.
- No secrets in the repo — Stripe keys and DB credentials come from Secrets
  Manager / env vars injected at deploy time.

---

## Deployment workflow

All infrastructure changes go through `/infra` (Terraform), never manual
console changes. Changes are proposed via pull request to `main` for review —
do not push directly to `main`.
