'use strict';

/**
 * Shared first-touch attribution logic.
 *
 * Used by BOTH the live Stripe webhook handler and the one-time backfill job,
 * so the matching rule lives in exactly one place. The rule is unchanged from
 * v1: match a payment to a visitor by the Stripe customer email against a
 * visitor whose email was captured via an `identify` event. If nothing
 * matches, the payment is stored unattributed (visitor_id NULL) — never a
 * forced/false match.
 */

const { query } = require('./db');

/**
 * Resolve the visitor id for a site + email, or null if no match.
 * Uses the most recently active visitor with that email (matching v1 behavior).
 */
async function findVisitorByEmail(siteId, email) {
  if (!email) return null;
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
  return match.rowCount > 0 ? match.rows[0].id : null;
}

/**
 * Insert a payment idempotently. Relies on the unique constraint on
 * payments(stripe_event_id) so the same event (whether from the live webhook
 * or the backfill) is never double-counted.
 *
 * Returns { inserted: true } on a new row, { inserted: false, deduped: true }
 * when the event was already recorded.
 *
 * `payment` shape:
 *   { siteId, stripeEventId, stripeCustomerId, email, amountCents, currency,
 *     status, occurredAtEpoch }
 */
async function insertPayment(payment) {
  const visitorId = await findVisitorByEmail(payment.siteId, payment.email);

  try {
    await query(
      `INSERT INTO payments
         (site_id, visitor_id, stripe_event_id, stripe_customer_id,
          amount_cents, currency, status, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8))
       ON CONFLICT (stripe_event_id) DO NOTHING`,
      [
        payment.siteId,
        visitorId,
        payment.stripeEventId,
        payment.stripeCustomerId || null,
        payment.amountCents ?? null,
        payment.currency || null,
        payment.status || 'paid',
        payment.occurredAtEpoch,
      ]
    );
    return { inserted: true, visitorId };
  } catch (err) {
    // Belt-and-suspenders: surface unique violations as a dedupe rather than
    // an error, though ON CONFLICT should already absorb them.
    if (err.code === '23505') return { inserted: false, deduped: true };
    throw err;
  }
}

/**
 * Extract normalized payment fields from a Stripe event's data.object for the
 * two event types we care about. Returns null for unsupported types.
 */
function extractFromStripeEvent(stripeEvent) {
  const obj = stripeEvent.data?.object || {};
  if (stripeEvent.type === 'checkout.session.completed') {
    return {
      email: obj.customer_details?.email || obj.customer_email || null,
      stripeCustomerId: obj.customer || null,
      amountCents: obj.amount_total ?? null,
      currency: obj.currency || null,
    };
  }
  if (stripeEvent.type === 'invoice.paid') {
    return {
      email: obj.customer_email || null,
      stripeCustomerId: obj.customer || null,
      amountCents: obj.amount_paid ?? null,
      currency: obj.currency || null,
    };
  }
  return null;
}

module.exports = { findVisitorByEmail, insertPayment, extractFromStripeEvent };
