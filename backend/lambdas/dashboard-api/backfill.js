'use strict';

/**
 * One-time historical backfill, run immediately after a successful connect.
 *
 * SOURCE OF HISTORY (Bug-1 fix):
 * Previously this read Stripe's Events API (stripe.events.list). Stripe only
 * retains events for the last 30 days ("List events, going back up to 30
 * days"), so any payment older than a month was silently missed — defeating
 * the purpose of a backfill. We now list Checkout Session OBJECTS
 * (stripe.checkoutSessions.list), which are bounded only by the account's own
 * data retention, not a fixed 30-day API cap.
 *
 * SYNTHETIC EVENT IDS + IDEMPOTENCY:
 * Session objects have no Stripe `evt_...` id (only real webhook events do), so
 * for the payments.stripe_event_id uniqueness constraint we construct a stable,
 * deterministic synthetic id: `backfill_<session.id>`. The same underlying
 * session always yields the same synthetic id, so re-running the backfill is
 * idempotent (the second run hits ON CONFLICT and inserts nothing).
 *
 * KNOWN TRADEOFF (documented choice — option (b) in the fix request):
 * A real webhook for the same underlying payment carries a genuine `evt_...`
 * id, which lives in a DIFFERENT id namespace from `backfill_<id>`. We
 * deliberately do NOT try to reconcile the two (no fuzzy customer+amount+time
 * matching). Consequence: for a payment that occurred within the ~30-day
 * window where the live webhook ALSO fired, it is possible to have two rows
 * for the same real-world payment — one `evt_...` (live) and one
 * `backfill_...` (historical). This is an accepted, explicitly-flagged
 * tradeoff: it keeps backfill idempotent and simple, and only affects the
 * narrow recent overlap window (older payments, the whole point of the
 * backfill, have no live-webhook counterpart at all). Chosen over option (a)
 * because amount+time-window matching is heuristic and can wrongly merge two
 * genuinely distinct payments.
 *
 * Each session is normalized with the SHARED extractFromCheckoutSession and
 * inserted with the SHARED insertPayment — the same attribution matching the
 * live webhook uses (reuse, don't duplicate).
 *
 * Requires the restricted key to have Checkout Sessions: Read (list the
 * sessions) and Customers: Read (attribution by email).
 */

const BACKFILL_ID_PREFIX = 'backfill_';

async function runBackfill({
  siteId,
  stripe,
  extractFromCheckoutSession,
  insertPayment,
}) {
  let processed = 0;
  let attributed = 0;

  async function handleSession(session) {
    // Only count sessions that actually resulted in a payment.
    if (session.payment_status && session.payment_status !== 'paid') return;

    const fields = extractFromCheckoutSession(session);
    const result = await insertPayment({
      siteId,
      // Synthetic, deterministic id — see module header.
      stripeEventId: `${BACKFILL_ID_PREFIX}${session.id}`,
      stripeCustomerId: fields.stripeCustomerId,
      email: fields.email,
      amountCents: fields.amountCents,
      currency: fields.currency,
      status: 'paid',
      // Checkout Sessions expose `created` (epoch seconds), same unit the
      // webhook path used for event.created.
      occurredAtEpoch: session.created,
    });
    processed += 1;
    // Only count NEW inserts that resolved to a visitor (Bug-2 fix: rely on
    // the accurate inserted flag rather than the old always-true behavior).
    if (result.inserted && result.visitorId) attributed += 1;
  }

  // stripe-node auto-pagination transparently fetches every page.
  await stripe.checkout.sessions
    .list({ limit: 100 })
    .autoPagingEach(handleSession);

  console.log(
    `backfill site=${siteId} processed=${processed} attributed=${attributed}`
  );
  return { processed, attributed };
}

module.exports = { runBackfill };
