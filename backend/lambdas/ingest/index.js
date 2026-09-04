'use strict';

/**
 * Ingest lambda — handles `POST /collect`.
 *
 * Accepts a batch of events from the tracking script. No auth (public
 * endpoint, keyed by a public site ID). CORS accepts any origin, but the
 * site ID is validated to exist before any data is written.
 *
 * Supported event types in the batch:
 *   - visitor.created : first ever page load; captures first-touch fields.
 *   - pageview        : a page view (creates/updates the session).
 *   - identify        : optional; associates an email with the visitor,
 *                       used later to attribute Stripe payments.
 *
 * All writes use parameterized queries. Visitor first-touch fields are only
 * written once (ON CONFLICT DO NOTHING) so they are never overwritten.
 */

const { query, withTransaction, json, noContent } = require('/opt/nodejs/index');

// Very small in-memory per-site rate limiter (best-effort, per warm
// container). Protects against trivial abuse; real limiting is also enforced
// by API Gateway throttling.
const RATE_LIMIT_WINDOW_MS = 10_000;
const RATE_LIMIT_MAX = 200; // events accepted per site per window per container
const rateState = new Map();

function rateLimited(siteId) {
  const now = Date.now();
  const entry = rateState.get(siteId);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateState.set(siteId, { windowStart: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}

async function siteExists(siteId) {
  const res = await query('SELECT 1 FROM sites WHERE id = $1', [siteId]);
  return res.rowCount > 0;
}

exports.handler = async (event) => {
  // CORS preflight
  const method =
    event.requestContext?.http?.method || event.httpMethod || 'POST';
  if (method === 'OPTIONS') return noContent(204);

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'invalid JSON body' });
  }

  const siteId = payload.siteId;
  const events = Array.isArray(payload.events) ? payload.events : [];

  if (!siteId || typeof siteId !== 'string') {
    return json(400, { error: 'siteId is required' });
  }
  if (events.length === 0) {
    return json(400, { error: 'events array is required and non-empty' });
  }

  if (rateLimited(siteId)) {
    return json(429, { error: 'rate limit exceeded' });
  }

  // Validate site exists before writing anything.
  if (!(await siteExists(siteId))) {
    return json(404, { error: 'unknown siteId' });
  }

  try {
    await withTransaction(async (client) => {
      for (const ev of events) {
        await processEvent(client, siteId, ev);
      }
    });
  } catch (err) {
    console.error('ingest error', err);
    return json(500, { error: 'failed to record events' });
  }

  return json(200, { ok: true, accepted: events.length });
};

async function processEvent(client, siteId, ev) {
  const type = ev.type;

  if (type === 'visitor.created') {
    // First-touch capture. Insert once; never overwrite.
    await client.query(
      `INSERT INTO visitors
         (id, site_id, first_seen_at, first_referrer,
          first_utm_source, first_utm_medium, first_utm_campaign)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        ev.visitorId,
        siteId,
        toTs(ev.timestamp),
        ev.referrer || null,
        ev.utmSource || null,
        ev.utmMedium || null,
        ev.utmCampaign || null,
      ]
    );
    return;
  }

  if (type === 'pageview') {
    // Ensure visitor exists (defensive — visitor.created may have been
    // dropped/blocked). Do not overwrite first-touch on conflict.
    await client.query(
      `INSERT INTO visitors
         (id, site_id, first_seen_at, first_referrer,
          first_utm_source, first_utm_medium, first_utm_campaign)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [
        ev.visitorId,
        siteId,
        toTs(ev.timestamp),
        ev.referrer || null,
        ev.utmSource || null,
        ev.utmMedium || null,
        ev.utmCampaign || null,
      ]
    );

    // Upsert session (first pageview of the session sets landing/referrer).
    await client.query(
      `INSERT INTO sessions
         (id, visitor_id, site_id, started_at, referrer,
          landing_page, utm_source, utm_medium, utm_campaign)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO NOTHING`,
      [
        ev.sessionId,
        ev.visitorId,
        siteId,
        toTs(ev.timestamp),
        ev.referrer || null,
        ev.pageUrl || null,
        ev.utmSource || null,
        ev.utmMedium || null,
        ev.utmCampaign || null,
      ]
    );

    // Record the pageview event.
    await client.query(
      `INSERT INTO events (session_id, site_id, type, page_url, occurred_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [ev.sessionId, siteId, 'pageview', ev.pageUrl || null, toTs(ev.timestamp)]
    );
    return;
  }

  if (type === 'identify') {
    // Attach an email to the visitor so Stripe payments can be matched.
    if (ev.email) {
      await client.query(
        `UPDATE visitors SET email = $1 WHERE id = $2 AND site_id = $3`,
        [String(ev.email).toLowerCase(), ev.visitorId, siteId]
      );
    }
    return;
  }

  // Unknown event types are ignored (forward-compatible).
}

function toTs(input) {
  if (!input) return new Date().toISOString();
  const d = new Date(input);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}
