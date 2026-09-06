'use strict';

/**
 * Regression tests for the two PR#2 bugs:
 *
 *  Bug 1 — backfill must source historical payments from Checkout Session
 *          objects (not the 30-day-capped Events API), so a session older than
 *          30 days is NOT silently dropped.
 *
 *  Bug 2 — insertPayment must actually detect duplicates: inserting the same
 *          stripe_event_id / synthetic backfill id twice must make the SECOND
 *          call return { inserted: false, deduped: true }.
 *
 * Both tests run the REAL shared/attribution.js and dashboard-api/backfill.js
 * against an in-memory Postgres fake that honors the unique constraint.
 */

const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const REPO = path.join(__dirname, '..');
const { createDb, withSharedMock } = require('./helpers');

// Load the real modules through the shared-mock interceptor.
function loadModules(shared) {
  const restore = withSharedMock(shared);
  // Fresh require each time so ./db resolves to the current mock.
  delete require.cache[require.resolve(path.join(REPO, 'shared/attribution.js'))];
  const attribution = require(path.join(REPO, 'shared/attribution.js'));
  Object.assign(shared, attribution); // expose insertPayment/extract* on shared
  delete require.cache[
    require.resolve(path.join(REPO, 'lambdas/dashboard-api/backfill.js'))
  ];
  const { runBackfill } = require(path.join(
    REPO,
    'lambdas/dashboard-api/backfill.js'
  ));
  return { attribution, runBackfill, restore };
}

test('Bug 2: second insert of same event id is deduped, not inserted', async () => {
  const db = createDb({
    visitors: [{ id: 'v1', site_id: 'site-1', email: 'buyer@example.com' }],
  });
  const shared = { query: db.query };
  const { attribution, restore } = loadModules(shared);
  try {
    const payment = {
      siteId: 'site-1',
      stripeEventId: 'evt_1',
      email: 'buyer@example.com',
      amountCents: 5000,
      currency: 'usd',
      status: 'paid',
      occurredAtEpoch: 1700000000,
    };

    const first = await attribution.insertPayment(payment);
    assert.deepStrictEqual(
      { inserted: first.inserted, deduped: first.deduped },
      { inserted: true, deduped: undefined },
      'first insert should report inserted: true'
    );
    assert.strictEqual(first.visitorId, 'v1', 'first insert should attribute to v1');

    const second = await attribution.insertPayment(payment);
    assert.strictEqual(second.inserted, false, 'second insert must NOT be inserted');
    assert.strictEqual(second.deduped, true, 'second insert must be deduped: true');

    assert.strictEqual(db.state.payments.length, 1, 'only one row should exist');
  } finally {
    restore();
  }
});

test('Bug 2: synthetic backfill id is idempotent across re-runs', async () => {
  const db = createDb();
  const shared = { query: db.query };
  const { attribution, restore } = loadModules(shared);
  try {
    const p = {
      siteId: 'site-1',
      stripeEventId: 'backfill_cs_123',
      email: 'x@example.com',
      amountCents: 1000,
      currency: 'usd',
      status: 'paid',
      occurredAtEpoch: 1600000000,
    };
    const a = await attribution.insertPayment(p);
    const b = await attribution.insertPayment(p);
    assert.strictEqual(a.inserted, true);
    assert.strictEqual(b.deduped, true);
    assert.strictEqual(db.state.payments.length, 1);
  } finally {
    restore();
  }
});

test('Bug 1: backfill processes a Checkout Session older than 30 days (not dropped)', async () => {
  const db = createDb({
    visitors: [{ id: 'v1', site_id: 'site-1', email: 'old@example.com' }],
  });
  const shared = { query: db.query };
  const { runBackfill, restore } = loadModules(shared);
  try {
    // ~200 days ago — far outside the Events API 30-day window.
    const oldEpoch = Math.floor(Date.now() / 1000) - 200 * 24 * 60 * 60;

    // Fake Stripe that ONLY exposes checkout.sessions.list (no events API).
    // If backfill tried stripe.events.list it would throw here.
    const stripe = {
      checkout: {
        sessions: {
          list() {
            return {
              async autoPagingEach(cb) {
                await cb({
                  id: 'cs_old',
                  created: oldEpoch,
                  payment_status: 'paid',
                  customer: 'cus_old',
                  amount_total: 4200,
                  currency: 'usd',
                  customer_details: { email: 'old@example.com' },
                });
                await cb({
                  id: 'cs_unpaid',
                  created: oldEpoch,
                  payment_status: 'unpaid', // should be skipped
                  amount_total: 999,
                  currency: 'usd',
                  customer_details: { email: 'nope@example.com' },
                });
              },
            };
          },
        },
      },
    };

    const result = await runBackfill({
      siteId: 'site-1',
      stripe,
      extractFromCheckoutSession: shared.extractFromCheckoutSession,
      insertPayment: shared.insertPayment,
    });

    // The old paid session was recorded (not silently dropped).
    assert.strictEqual(db.state.payments.length, 1, 'old paid session must be stored');
    const row = db.state.payments[0];
    assert.strictEqual(row.stripe_event_id, 'backfill_cs_old', 'uses synthetic backfill id');
    assert.strictEqual(row.amount_cents, 4200);
    assert.strictEqual(row.visitor_id, 'v1', 'attributed by email');
    assert.strictEqual(row.occurred_at_epoch, oldEpoch, 'preserves original (old) timestamp');

    assert.strictEqual(result.processed, 1, 'unpaid session must be skipped');
    assert.strictEqual(result.attributed, 1);
  } finally {
    restore();
  }
});

test('Bug 1 + 2: re-running backfill over the same sessions inserts nothing new', async () => {
  const db = createDb({
    visitors: [{ id: 'v1', site_id: 'site-1', email: 'old@example.com' }],
  });
  const shared = { query: db.query };
  const { runBackfill, restore } = loadModules(shared);
  try {
    const epoch = Math.floor(Date.now() / 1000) - 100 * 24 * 60 * 60;
    const makeStripe = () => ({
      checkout: {
        sessions: {
          list() {
            return {
              async autoPagingEach(cb) {
                await cb({
                  id: 'cs_a',
                  created: epoch,
                  payment_status: 'paid',
                  customer: 'cus_a',
                  amount_total: 2500,
                  currency: 'usd',
                  customer_details: { email: 'old@example.com' },
                });
              },
            };
          },
        },
      },
    });

    const r1 = await runBackfill({
      siteId: 'site-1',
      stripe: makeStripe(),
      extractFromCheckoutSession: shared.extractFromCheckoutSession,
      insertPayment: shared.insertPayment,
    });
    const r2 = await runBackfill({
      siteId: 'site-1',
      stripe: makeStripe(),
      extractFromCheckoutSession: shared.extractFromCheckoutSession,
      insertPayment: shared.insertPayment,
    });

    assert.strictEqual(db.state.payments.length, 1, 'no duplicate row on re-run');
    assert.strictEqual(r1.attributed, 1, 'first run attributes the new payment');
    assert.strictEqual(r2.attributed, 0, 'second run reports 0 new (deduped)');
  } finally {
    restore();
  }
});
