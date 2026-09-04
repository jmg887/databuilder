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
- **Static hosting:** S3 + CloudFront (tracking script + dashboard build)
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
   `stripe_webhook_url`, `stripe_secret_arn`, `db_secret_arn`.

3. **Load the database schema.** The RDS instance is private; run the
   migration from inside the VPC (bastion / one-off task / your VPN), using
   the credentials stored in the `db-credentials` secret:

   ```bash
   psql "$DATABASE_URL" -f backend/shared/migrations/001_init.sql
   ```

4. **Set the Stripe webhook signing secret** (never commit it). Put the
   value into the Secrets Manager secret referenced by `stripe_secret_arn`:

   ```bash
   aws secretsmanager put-secret-value \
     --secret-id "$(terraform output -raw stripe_secret_arn)" \
     --secret-string 'whsec_...'
   ```

   Then set each site's `stripe_webhook_secret` column to that secret's
   name/ARN so the webhook lambda can resolve it.

5. **Deploy the static assets** (tracking script + dashboard build) to S3:

   ```bash
   # tracking script
   aws s3 cp frontend/tracking-script/dist/t.js "s3://$(terraform output -raw assets_bucket)/t.js" \
     --content-type application/javascript

   # dashboard (build first with the Cognito/API values, see below)
   aws s3 sync frontend/dashboard/dist "s3://$(terraform output -raw assets_bucket)/"
   ```

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

## Configure Stripe test-mode keys for local development

1. In the [Stripe Dashboard](https://dashboard.stripe.com/test) (test mode),
   create a webhook endpoint pointing at
   `<stripe_webhook_url>?site=<yourSiteId>` and subscribe to
   `checkout.session.completed` and `invoice.paid`.
2. Copy the endpoint's **signing secret** (`whsec_...`) into Secrets Manager
   as described in deploy step 4.
3. For local webhook testing, use the Stripe CLI:

   ```bash
   stripe listen --forward-to "http://localhost:3000/webhooks/stripe?site=<siteId>"
   stripe trigger checkout.session.completed
   ```

Test-mode Stripe keys are never committed — they live only in Secrets
Manager / your local Stripe CLI session.

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
