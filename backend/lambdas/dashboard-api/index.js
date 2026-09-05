'use strict';

/**
 * Dashboard API lambda — authenticated routes for the React dashboard.
 *
 * Auth is enforced by a Cognito JWT authorizer configured on the API Gateway
 * HTTP API. This handler trusts the verified claims placed on the request
 * context by that authorizer and derives the owner user id (`sub`) from them.
 *
 * Routes:
 *   GET    /sites                              list sites owned by the user
 *   POST   /sites                              create a site (returns id + snippet)
 *   GET    /sites/:id/overview?range=          traffic + revenue by source
 *   GET    /sites/:id/visitors?range=          visitor list with attribution detail
 *   GET    /sites/:id/integrations             connection status
 *   POST   /sites/:id/integrations/stripe      connect Stripe via restricted key
 *   DELETE /sites/:id/integrations/stripe      disconnect Stripe
 *
 * All queries are parameterized. Every /sites/:id route verifies the site is
 * owned by the requesting user before returning data.
 */

const { query, json, noContent } = require('/opt/nodejs/index');
const stripeIntegration = require('./stripe-integration');

const TRACKING_SCRIPT_URL =
  process.env.TRACKING_SCRIPT_URL || 'https://cdn.example.com/t.js';

exports.handler = async (event) => {
  const method =
    event.requestContext?.http?.method || event.httpMethod || 'GET';
  if (method === 'OPTIONS') return noContent(204);

  const userId = getUserId(event);
  if (!userId) {
    return json(401, { error: 'unauthorized' });
  }

  const path = event.requestContext?.http?.path || event.rawPath || '';
  const segments = path.split('/').filter(Boolean); // e.g. ['sites','<id>','overview']

  try {
    if (segments[0] === 'sites' && segments.length === 1) {
      if (method === 'GET') return await listSites(userId);
      if (method === 'POST') return await createSite(userId, event);
    }

    if (segments[0] === 'sites' && segments.length === 3) {
      const siteId = segments[1];
      const sub = segments[2];

      if (!(await ownsSite(userId, siteId))) {
        return json(404, { error: 'site not found' });
      }

      const range = parseRange(event.queryStringParameters?.range);

      if (sub === 'overview' && method === 'GET') {
        return await overview(siteId, range);
      }
      if (sub === 'visitors' && method === 'GET') {
        return await visitors(siteId, range);
      }
      if (sub === 'integrations' && method === 'GET') {
        return await stripeIntegration.getStatus(siteId);
      }
    }

    // /sites/:id/integrations/stripe
    if (
      segments[0] === 'sites' &&
      segments.length === 4 &&
      segments[2] === 'integrations' &&
      segments[3] === 'stripe'
    ) {
      const siteId = segments[1];
      if (!(await ownsSite(userId, siteId))) {
        return json(404, { error: 'site not found' });
      }
      if (method === 'POST') {
        return await stripeIntegration.connect(siteId, event);
      }
      if (method === 'DELETE') {
        return await stripeIntegration.disconnect(siteId);
      }
    }

    return json(404, { error: 'not found' });
  } catch (err) {
    console.error('dashboard-api error', err);
    return json(500, { error: 'internal error' });
  }
};

function getUserId(event) {
  // HTTP API JWT authorizer places claims here.
  const claims =
    event.requestContext?.authorizer?.jwt?.claims ||
    event.requestContext?.authorizer?.claims;
  return claims?.sub || null;
}

/** Parse ?range=7d|30d|90d into a start Date. Defaults to 30 days. */
function parseRange(range) {
  const map = { '7d': 7, '30d': 30, '90d': 90 };
  const days = map[range] || 30;
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return { days, startIso: start.toISOString() };
}

async function ownsSite(userId, siteId) {
  const res = await query(
    'SELECT 1 FROM sites WHERE id = $1 AND owner_user_id = $2',
    [siteId, userId]
  );
  return res.rowCount > 0;
}

async function listSites(userId) {
  const res = await query(
    `SELECT id, name, domain, created_at
       FROM sites
      WHERE owner_user_id = $1
      ORDER BY created_at DESC`,
    [userId]
  );
  return json(200, { sites: res.rows });
}

async function createSite(userId, event) {
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'invalid JSON body' });
  }
  if (!body.name) {
    return json(400, { error: 'name is required' });
  }

  const res = await query(
    `INSERT INTO sites (owner_user_id, name, domain)
     VALUES ($1, $2, $3)
     RETURNING id, name, domain, created_at`,
    [userId, body.name, body.domain || null]
  );
  const site = res.rows[0];
  return json(201, { site, snippet: buildSnippet(site.id) });
}

function buildSnippet(siteId) {
  return `<script async src="${TRACKING_SCRIPT_URL}" data-site-id="${siteId}"></script>`;
}

/**
 * Traffic + revenue by (first-touch) source for a date range.
 * Returns totals plus a per-source breakdown with revenue-per-visitor.
 */
async function overview(siteId, range) {
  // Visitors by first-touch source (first_utm_source, falling back to a
  // referrer host or "direct").
  const sourceExpr = `COALESCE(NULLIF(first_utm_source, ''),
                               CASE WHEN first_referrer IS NULL OR first_referrer = ''
                                    THEN 'direct' ELSE 'referral' END)`;

  const visitorsBySource = await query(
    `SELECT ${sourceExpr} AS source, COUNT(*)::int AS visitors
       FROM visitors
      WHERE site_id = $1 AND first_seen_at >= $2
      GROUP BY 1
      ORDER BY visitors DESC`,
    [siteId, range.startIso]
  );

  // Revenue by first-touch source, joining payments -> visitors.
  const revenueBySource = await query(
    `SELECT
        CASE WHEN p.visitor_id IS NULL THEN '(unattributed)'
             ELSE ${sourceExpr.replace(/first_/g, 'v.first_')} END AS source,
        COALESCE(SUM(p.amount_cents), 0)::bigint AS revenue_cents,
        COUNT(*)::int AS payments
       FROM payments p
       LEFT JOIN visitors v ON v.id = p.visitor_id
      WHERE p.site_id = $1 AND p.occurred_at >= $2 AND p.status = 'paid'
      GROUP BY 1
      ORDER BY revenue_cents DESC`,
    [siteId, range.startIso]
  );

  // Totals.
  const totalsRes = await query(
    `SELECT
        (SELECT COUNT(*)::int FROM visitors
          WHERE site_id = $1 AND first_seen_at >= $2) AS total_visitors,
        (SELECT COALESCE(SUM(amount_cents),0)::bigint FROM payments
          WHERE site_id = $1 AND occurred_at >= $2 AND status = 'paid')
          AS total_revenue_cents`,
    [siteId, range.startIso]
  );
  const totals = totalsRes.rows[0];

  // Merge visitor counts and revenue into a single breakdown table keyed by
  // source, computing revenue-per-visitor per channel.
  const merged = mergeBreakdown(visitorsBySource.rows, revenueBySource.rows);

  return json(200, {
    range: { days: range.days, start: range.startIso },
    totals: {
      total_visitors: totals.total_visitors,
      total_revenue_cents: Number(totals.total_revenue_cents),
    },
    breakdown: merged,
  });
}

function mergeBreakdown(visitorRows, revenueRows) {
  const map = new Map();
  const ensure = (source) => {
    if (!map.has(source)) {
      map.set(source, {
        source,
        visitors: 0,
        revenue_cents: 0,
        payments: 0,
      });
    }
    return map.get(source);
  };

  for (const r of visitorRows) {
    ensure(r.source).visitors = r.visitors;
  }
  for (const r of revenueRows) {
    const row = ensure(r.source);
    row.revenue_cents = Number(r.revenue_cents);
    row.payments = r.payments;
  }

  const out = Array.from(map.values()).map((row) => ({
    ...row,
    revenue_per_visitor_cents:
      row.visitors > 0 ? Math.round(row.revenue_cents / row.visitors) : 0,
  }));

  out.sort((a, b) => b.revenue_cents - a.revenue_cents || b.visitors - a.visitors);
  return out;
}

/** Visitor list with attribution detail. */
async function visitors(siteId, range) {
  const res = await query(
    `SELECT
        v.id,
        v.first_seen_at,
        v.first_referrer,
        v.first_utm_source,
        v.first_utm_medium,
        v.first_utm_campaign,
        v.email,
        COALESCE(pay.revenue_cents, 0)::bigint AS revenue_cents,
        COALESCE(pay.payments, 0)::int AS payments
       FROM visitors v
       LEFT JOIN (
         SELECT visitor_id,
                SUM(amount_cents) AS revenue_cents,
                COUNT(*) AS payments
           FROM payments
          WHERE site_id = $1 AND status = 'paid'
          GROUP BY visitor_id
       ) pay ON pay.visitor_id = v.id
      WHERE v.site_id = $1 AND v.first_seen_at >= $2
      ORDER BY v.first_seen_at DESC
      LIMIT 500`,
    [siteId, range.startIso]
  );

  const rows = res.rows.map((r) => ({
    ...r,
    revenue_cents: Number(r.revenue_cents),
  }));

  return json(200, {
    range: { days: range.days, start: range.startIso },
    visitors: rows,
  });
}
