'use strict';

/**
 * Stripe webhook lambda — handles `POST /webhooks/stripe`.
 *
 * 1. Verifies the Stripe signature against the site's webhook secret.
 *    Unsigned / invalid requests are rejected (400) before any processing.
 * 2. On `checkout.session.completed` or `invoice.paid`, records a payment
 *    and attempts first-touch attribution to a visitor.
 * 3. Idempotent: `payments.stripe_event_id` is unique, so repeated webhook
 *    deliveries are de-duped.
 *
 * The site is identified by a `site` query-string parameter on the webhook
 * URL (e.g. /webhooks/stripe?site=<siteId>), so we know which webhook secret
 * to verify against. Secrets are fetched from Secrets Manager, never
 * hardcoded.
 */

const Stripe = require('stripe');
const { query, getSecretString, json } = require('/opt/nodejs/index');

// The webhook signing secret is stored in a single Secrets Manager secret
// whose name is provided via STRIPE_WEBHOOK_SECRET_ARN. sites.stripe_webhook_secret
// holds a reference (secret name) rather than the plaintext value.
async function getWebhookSecretForSite(siteId) {
  const res = await query(
    'SELECT stripe_webhook_secret FROM sites WHERE id = $1',
    [siteId]
  );
  if (res.rowCount === 0) return null;
  const ref = res.rows[0].stripe_webhook_secret;
  if (!ref) return null;
  // `ref` is a Secrets Manager secret name/ARN. Resolve to the actual value.
  try {
    return await getSecretString(ref);
  } catch (err) {
    console.error('failed to resolve webhook secret', err);
    return null;
  }
}

exports.handler = async (event) => {
  const method =
    event.requestContext?.http?.method || event.httpMethod || 'POST';
  if (method === 'OPTIONS') return json(204, {});

  const siteId =
    event.queryStringParameters?.site || event.queryStringParameters?.siteId;
  if (!siteId) {
    return json(400, { error: 'missing site query parameter' });
  }

  const signature =
    event.headers?.['stripe-signature'] || event.headers?.['Stripe-Signature'];
  if (!signature) {
    return json(400, { error: 'missing stripe-signature header' });
  }

  // API Gateway may base64-encode the body. We need the RAW bytes for
  // signature verification.
  let rawBody = event.body || '';
  if (event.isBase64Encoded) {
    rawBody = Buffer.from(rawBody, 'base64').toString('utf8');
  }

  const webhookSecret = await getWebhookSecretForSite(siteId);
  if (!webhookSecret) {
    return json(404, { error: 'unknown site or missing webhook secret' });
  }

  const stripe = new Stripe('sk_placeholder', { apiVersion: '2023-10-16' });

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      webhookSecret
    );
  } catch (err) {
    console.error('signature verification failed', err.message);
    return json(400, { error: 'signature verification failed' });
  }

  const type = stripeEvent.type;
  if (type !== 'checkout.session.completed' && type !== 'invoice.paid') {
    // Acknowledge but ignore other event types.
    return json(200, { ok: true, ignored: type });
  }

  try {
    await recordPayment(siteId, stripeEvent);
  } catch (err) {
    if (err.code === '23505') {
      // unique_violation on stripe_event_id => already processed.
      return json(200, { ok: true, deduped: true });
    }
    console.error('failed to record payment', err);
    return json(500, { error: 'failed to record payment' });
  }

  return json(200, { ok: true });
};

async function recordPayment(siteId, stripeEvent) {
  const obj = stripeEvent.data.object;

  // Extract fields depending on event type.
  let email = null;
  let customerId = null;
  let amountCents = null;
  let currency = null;

  if (stripeEvent.type === 'checkout.session.completed') {
    email =
      obj.customer_details?.email ||
      obj.customer_email ||
      null;
    customerId = obj.customer || null;
    amountCents = obj.amount_total ?? null;
    currency = obj.currency || null;
  } else if (stripeEvent.type === 'invoice.paid') {
    email = obj.customer_email || null;
    customerId = obj.customer || null;
    amountCents = obj.amount_paid ?? null;
    currency = obj.currency || null;
  }

  // Attribution: match the payment to a visitor by email captured via an
  // identify event. Use the most recently active visitor for this site with
  // that email. If nothing matches, store unattributed (visitor_id NULL) —
  // do NOT guess.
  let visitorId = null;
  if (email) {
    const match = await query(
      `SELECT v.id
         FROM visitors v
         LEFT JOIN sessions s ON s.visitor_id = v.id
        WHERE v.site_id = $1 AND lower(v.email) = lower($2)
        GROUP BY v.id
        ORDER BY MAX(s.started_at) DESC NULLS LAST, v.first_seen_at DESC
        LIMIT 1`,
      [siteId, email]
    );
    if (match.rowCount > 0) {
      visitorId = match.rows[0].id;
    }
  }

  await query(
    `INSERT INTO payments
       (site_id, visitor_id, stripe_event_id, stripe_customer_id,
        amount_cents, currency, status, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8))`,
    [
      siteId,
      visitorId,
      stripeEvent.id,
      customerId,
      amountCents,
      currency,
      'paid',
      stripeEvent.created,
    ]
  );
}
