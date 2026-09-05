'use strict';

/**
 * One-time historical backfill, run immediately after a successful connect.
 *
 * IMPORTANT — idempotency with the live webhook:
 * The live webhook de-dupes on the Stripe EVENT id (`evt_...`) via the unique
 * payments.stripe_event_id constraint. To guarantee a backfilled payment and a
 * later live webhook for the same payment never double-count, the backfill
 * reads Stripe's Events API (filtered to the same event types the webhook
 * handles) rather than listing raw objects. This yields the exact same
 * `evt_...` ids the webhook uses, so ON CONFLICT (stripe_event_id) absorbs any
 * overlap.
 *
 * Each event is normalized with the SHARED extractFromStripeEvent + inserted
 * with the SHARED insertPayment — the same attribution matching the live
 * webhook uses (brief §7: reuse, don't duplicate).
 *
 * Requires the restricted key to have Checkout Sessions: Read and Payment
 * Intents: Read (to read the event payloads) and Customers: Read (attribution).
 */

const BACKFILL_EVENT_TYPES = [
  'checkout.session.completed',
  'invoice.paid',
];

async function runBackfill({ siteId, stripe, extractFromStripeEvent, insertPayment }) {
  let processed = 0;
  let attributed = 0;

  async function handleEvent(evt) {
    const fields = extractFromStripeEvent(evt);
    if (!fields) return;
    const result = await insertPayment({
      siteId,
      stripeEventId: evt.id,
      stripeCustomerId: fields.stripeCustomerId,
      email: fields.email,
      amountCents: fields.amountCents,
      currency: fields.currency,
      status: 'paid',
      occurredAtEpoch: evt.created,
    });
    processed += 1;
    if (result.inserted && result.visitorId) attributed += 1;
  }

  for (const type of BACKFILL_EVENT_TYPES) {
    // stripe-node auto-pagination transparently fetches every page.
    await stripe.events
      .list({ type, limit: 100 })
      .autoPagingEach(handleEvent);
  }

  console.log(
    `backfill site=${siteId} processed=${processed} attributed=${attributed}`
  );
  return { processed, attributed };
}

module.exports = { runBackfill };
