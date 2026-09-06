'use strict';

/**
 * Self-service Stripe integration for the dashboard-api lambda.
 *
 * Flow (POST /sites/:id/integrations/stripe):
 *   1. Validate the restricted key format (must start with rk_live_; test keys
 *      are rejected by default — see KEY POLICY below).
 *   2. Store the restricted key in Secrets Manager under a per-site name and
 *      reference it from sites.stripe_restricted_key_secret.
 *   3. Create a webhook endpoint on Stripe using the customer's own key.
 *   4. Store the returned signing secret (returned only once) in Secrets
 *      Manager and reference it from sites.stripe_webhook_secret.
 *   5. Persist stripe_connected_at, stripe_backfill_status='pending', and the
 *      webhook endpoint id (for later deletion on disconnect).
 *   6. Run the one-time backfill SYNCHRONOUSLY (MVP choice, documented in the
 *      brief §7 — accepts a slower connect response, no extra infra).
 *   7. Return 201 with connection status.
 *
 * Restricted keys and signing secrets live in Secrets Manager only. They are
 * never logged and never returned by any GET endpoint.
 *
 * KEY POLICY (brief §6 open decision): we reject any key that does not start
 * with `rk_live_`. This rejects secret keys (sk_), publishable keys (pk_), and
 * test restricted keys (rk_test_). Documented as the chosen default.
 */

const Stripe = require('stripe');
const {
  query,
  json,
  putSecret,
  deleteSecret,
  getSecretString,
  extractFromCheckoutSession,
  insertPayment,
} = require('/opt/nodejs/index');

const { runBackfill } = require('./backfill');

const SECRET_PREFIX =
  process.env.SITE_SECRET_PREFIX || 'databuilder-prod';
const API_BASE_URL = process.env.API_BASE_URL || '';

const WEBHOOK_EVENTS = ['checkout.session.completed', 'invoice.paid'];

function rakSecretName(siteId) {
  return `${SECRET_PREFIX}/site-${siteId}-stripe-rak`;
}
function webhookSecretName(siteId) {
  return `${SECRET_PREFIX}/site-${siteId}-stripe-webhook`;
}

/** GET /sites/:id/integrations — connection status (no secrets returned). */
async function getStatus(siteId) {
  const res = await query(
    `SELECT stripe_connected_at, stripe_backfill_status
       FROM sites WHERE id = $1`,
    [siteId]
  );
  const row = res.rows[0] || {};
  const connected = !!row.stripe_connected_at;
  return json(200, {
    stripe: {
      connected,
      connectedAt: row.stripe_connected_at || null,
      backfillStatus: row.stripe_backfill_status || null,
    },
  });
}

/** POST /sites/:id/integrations/stripe */
async function connect(siteId, event) {
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'invalid JSON body' });
  }

  const rak = body.stripeRak;

  // 1. Validate key format BEFORE making any Stripe API call.
  if (typeof rak !== 'string' || !rak.startsWith('rk_live_')) {
    return json(400, { error: 'invalid key format' });
  }

  // 409 if already connected — caller must disconnect first.
  const existing = await query(
    `SELECT stripe_connected_at FROM sites WHERE id = $1`,
    [siteId]
  );
  if (existing.rows[0]?.stripe_connected_at) {
    return json(409, { error: 'stripe already connected for this site' });
  }

  // 2. Store the restricted key immediately, reference it from the row.
  const rakName = rakSecretName(siteId);
  await putSecret(rakName, rak);
  await query(
    `UPDATE sites SET stripe_restricted_key_secret = $1 WHERE id = $2`,
    [rakName, siteId]
  );

  const stripe = new Stripe(rak, { apiVersion: '2023-10-16' });

  // 3. Create the webhook endpoint using the customer's own key.
  let endpoint;
  try {
    endpoint = await stripe.webhookEndpoints.create({
      url: `${API_BASE_URL}/webhooks/stripe?site=${siteId}`,
      enabled_events: WEBHOOK_EVENTS,
    });
  } catch (err) {
    // Surface Stripe's own permission-denied message rather than a generic
    // failure (brief §4). Roll back the stored key so a retry is clean.
    await safeCleanupRak(siteId, rakName);
    const detail = err?.raw?.message || err?.message || 'stripe error';
    const isPerm =
      err?.statusCode === 403 ||
      err?.type === 'StripePermissionError' ||
      /permission|does not have access|scope/i.test(detail);
    if (isPerm) {
      return json(400, { error: `insufficient permissions: ${detail}` });
    }
    return json(400, { error: `stripe error: ${detail}` });
  }

  // 4. Store the signing secret (only returned once) + reference it.
  const whName = webhookSecretName(siteId);
  await putSecret(whName, endpoint.secret);

  // 5. Persist connection metadata + endpoint id + backfill status.
  await query(
    `UPDATE sites
        SET stripe_webhook_secret     = $1,
            stripe_webhook_endpoint_id = $2,
            stripe_connected_at        = now(),
            stripe_backfill_status     = 'pending'
      WHERE id = $3`,
    [whName, endpoint.id, siteId]
  );

  // 6. Run backfill synchronously (MVP). Failures are recorded, not fatal to
  //    the connection itself.
  let backfillStatus = 'complete';
  try {
    await query(
      `UPDATE sites SET stripe_backfill_status = 'running' WHERE id = $1`,
      [siteId]
    );
    await runBackfill({
      siteId,
      stripe,
      extractFromCheckoutSession,
      insertPayment,
    });
    await query(
      `UPDATE sites SET stripe_backfill_status = 'complete' WHERE id = $1`,
      [siteId]
    );
  } catch (err) {
    console.error('backfill failed', err?.message);
    backfillStatus = 'failed';
    await query(
      `UPDATE sites SET stripe_backfill_status = 'failed' WHERE id = $1`,
      [siteId]
    );
  }

  // 7.
  return json(201, { connected: true, backfillStatus });
}

/** DELETE /sites/:id/integrations/stripe */
async function disconnect(siteId) {
  const res = await query(
    `SELECT stripe_restricted_key_secret, stripe_webhook_endpoint_id,
            stripe_connected_at
       FROM sites WHERE id = $1`,
    [siteId]
  );
  const row = res.rows[0];
  if (!row || !row.stripe_connected_at) {
    return json(404, { error: 'not connected' });
  }

  // 1. Delete the webhook on Stripe's side using the stored restricted key.
  if (row.stripe_restricted_key_secret && row.stripe_webhook_endpoint_id) {
    try {
      const rak = await getSecretString(row.stripe_restricted_key_secret);
      const stripe = new Stripe(rak, { apiVersion: '2023-10-16' });
      await stripe.webhookEndpoints.del(row.stripe_webhook_endpoint_id);
    } catch (err) {
      // Best-effort: if the endpoint is already gone, continue clearing.
      console.error('failed to delete stripe webhook', err?.message);
    }
  }

  // 2. Delete both Secrets Manager entries.
  await deleteSecret(rakSecretName(siteId));
  await deleteSecret(webhookSecretName(siteId));

  // 3. Clear the columns on the sites row.
  await query(
    `UPDATE sites
        SET stripe_restricted_key_secret = NULL,
            stripe_webhook_secret         = NULL,
            stripe_webhook_endpoint_id    = NULL,
            stripe_connected_at           = NULL,
            stripe_backfill_status        = NULL
      WHERE id = $1`,
    [siteId]
  );

  return json(200, { disconnected: true });
}

/** Roll back a stored restricted key if webhook creation fails. */
async function safeCleanupRak(siteId, rakName) {
  try {
    await deleteSecret(rakName);
    await query(
      `UPDATE sites SET stripe_restricted_key_secret = NULL WHERE id = $1`,
      [siteId]
    );
  } catch (err) {
    console.error('failed to roll back restricted key', err?.message);
  }
}

module.exports = { getStatus, connect, disconnect };
