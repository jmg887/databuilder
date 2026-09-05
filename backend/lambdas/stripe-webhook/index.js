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
const {
  query,
  getSecretString,
  json,
  extractFromStripeEvent,
  insertPayment,
} = require('/opt/nodejs/index');

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
    // Attribution + idempotent insert live in the shared module, reused by the
    // backfill job so the matching rule is defined in exactly one place.
    const fields = extractFromStripeEvent(stripeEvent);
    const result = await insertPayment({
      siteId,
      stripeEventId: stripeEvent.id,
      stripeCustomerId: fields.stripeCustomerId,
      email: fields.email,
      amountCents: fields.amountCents,
      currency: fields.currency,
      status: 'paid',
      occurredAtEpoch: stripeEvent.created,
    });
    if (result.deduped) {
      return json(200, { ok: true, deduped: true });
    }
  } catch (err) {
    console.error('failed to record payment', err);
    return json(500, { error: 'failed to record payment' });
  }

  return json(200, { ok: true });
};
