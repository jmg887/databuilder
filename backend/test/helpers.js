'use strict';

/**
 * Test helpers: an in-memory fake of the Postgres query layer that honors the
 * unique constraint on payments(stripe_event_id) and implements
 * `ON CONFLICT (stripe_event_id) DO NOTHING RETURNING id` semantics, so the
 * REAL insertPayment/runBackfill code runs against realistic behavior.
 *
 * We also install a require() interceptor so that modules requiring
 * `./db` (attribution.js) or `/opt/nodejs/index` (the Lambda layer) resolve to
 * this fake instead of pulling in the real `pg`/AWS SDK.
 */

const Module = require('module');

function createDb({ visitors = [] } = {}) {
  const state = {
    payments: [], // { id, site_id, visitor_id, stripe_event_id, amount_cents, occurred_at }
    visitors, // { id, site_id, email }
    _seq: 0,
  };

  async function query(text, params) {
    const t = text.replace(/\s+/g, ' ').trim();

    // visitor lookup by email
    if (/FROM visitors v LEFT JOIN sessions s/.test(t)) {
      const [siteId, email] = params;
      const m = state.visitors.find(
        (v) =>
          v.site_id === siteId &&
          v.email &&
          v.email.toLowerCase() === String(email).toLowerCase()
      );
      return { rowCount: m ? 1 : 0, rows: m ? [{ id: m.id }] : [] };
    }

    // payment insert with ON CONFLICT ... DO NOTHING RETURNING id
    if (/INSERT INTO payments/.test(t)) {
      const eventId = params[2];
      const exists = state.payments.find((p) => p.stripe_event_id === eventId);
      if (exists) {
        // conflict: nothing inserted, RETURNING yields no rows
        return { rowCount: 0, rows: [] };
      }
      const row = {
        id: `pay_${++state._seq}`,
        site_id: params[0],
        visitor_id: params[1],
        stripe_event_id: eventId,
        stripe_customer_id: params[3],
        amount_cents: params[4],
        currency: params[5],
        status: params[6],
        occurred_at_epoch: params[7],
      };
      state.payments.push(row);
      return { rowCount: 1, rows: [{ id: row.id }] };
    }

    return { rowCount: 0, rows: [] };
  }

  return { query, state };
}

/**
 * Install a Module._load hook mapping `/opt/nodejs/index` and `./db` to the
 * provided shared object. Returns a restore() function.
 */
function withSharedMock(shared) {
  const realLoad = Module._load;
  Module._load = function (request, ...rest) {
    if (request === '/opt/nodejs/index') return shared;
    if (request === './db') return { query: shared.query };
    return realLoad.call(this, request, ...rest);
  };
  return () => {
    Module._load = realLoad;
  };
}

module.exports = { createDb, withSharedMock };
