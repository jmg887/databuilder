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
 * Insert a payment idempotently. The unique constraint on
 * payments(stripe_event_id) guarantees the same event id (whether a real
 * webhook `evt_...` id or a synthetic `backfill_...` id) is never inserted
 * twice.
 *
 * Dedup detection comes from `ON CONFLICT ... DO NOTHING RETURNING id`: when
 * the conflict fires, no row is returned. (Previously this relied on catching
 * a 23505 unique-violation, which ON CONFLICT DO NOTHING never raises, so the
 * dedup branch could never run — that bug is fixed here.)
 *
 * Returns:
 *   { inserted: true,  visitorId }              — a new row was written
 *   { inserted: false, deduped: true, visitorId } — the id already existed
 *
 * `payment` shape:
 *   { siteId, stripeEventId, stripeCustomerId, email, amountCents, currency,
 *     status, occurredAtEpoch }
 */
async function insertPayment(payment) {
  const visitorId = await findVisitorByEmail(payment.siteId, payment.email);

  try {
    const res = await query(
      `INSERT INTO payments
         (site_id, visitor_id, stripe_event_id, stripe_customer_id,
          amount_cents, currency, status, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8))
       ON CONFLICT (stripe_event_id) DO NOTHING
       RETURNING id`,
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
    // A row comes back only when an insert actually happened; on conflict the
    // RETURNING clause yields zero rows.
    if (res.rowCount === 0) {
      return { inserted: false, deduped: true, visitorId };
    }
    return { inserted: true, visitorId };
  } catch (err) {
    // Defensive fallback only: ON CONFLICT DO NOTHING should prevent 23505,
    // but if a conflict ever surfaced as an error we still treat it as dedup.
    if (err.code === '23505') return { inserted: false, deduped: true, visitorId };
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
    return extractFromCheckoutSession(obj);
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

/**
 * Extract normalized payment fields directly from a Checkout Session object
 * (as returned by stripe.checkoutSessions.list()), without an Event wrapper.
 * Used by the backfill, which lists raw objects rather than webhook events.
 */
function extractFromCheckoutSession(session) {
  const obj = session || {};
  return {
    email: obj.customer_details?.email || obj.customer_email || null,
    stripeCustomerId:
      typeof obj.customer === 'string'
        ? obj.customer
        : obj.customer?.id || null,
    amountCents: obj.amount_total ?? null,
    currency: obj.currency || null,
  };
}

module.exports = {
  findVisitorByEmail,
  insertPayment,
  extractFromStripeEvent,
  extractFromCheckoutSession,
};
