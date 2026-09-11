import { useEffect, useState } from 'react';
import { api } from '../api';

// Restyled Overview — reuses the EXISTING /sites/:id/overview data/logic
// (revenue-by-source, first-touch), only re-rendering its output as the
// "statement" panel from the reference. No underlying query changes.

// Dot colors cycle through the reference palette (forest, gold, sage, stone).
const DOT_COLORS = ['#1C6B4F', '#C9972B', '#8A9A91', '#D8D6CC'];

function money(cents, currency) {
  const v = (cents || 0) / 100;
  return v.toLocaleString(undefined, {
    style: 'currency',
    currency: (currency || 'USD').toUpperCase(),
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

export default function OverviewPanel({ siteId }) {
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    api
      .overview(siteId, '30d')
      .then((ov) => alive && setOverview(ov))
      .catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [siteId]);

  if (error) return <p className="error">{error}</p>;
  if (!overview) return <p className="loading">Loading…</p>;

  const rows = overview.breakdown || [];
  const total = overview.totals?.total_revenue_cents || 0;

  return (
    <div className="statement-panel">
      <div className="statement-header">
        <span className="statement-title">Revenue by source</span>
        <span className="statement-period">Last 30 days</span>
      </div>

      {rows.length === 0 && (
        <div className="statement-row">
          <span className="row-source muted">No revenue data yet</span>
          <span className="row-amount zero">{money(0)}</span>
        </div>
      )}

      {rows.map((row, i) => (
        <div className="statement-row" key={row.source}>
          <span className="row-source">
            <span
              className="dot"
              style={{ background: DOT_COLORS[i % DOT_COLORS.length] }}
            ></span>
            {row.source}
          </span>
          <span
            className={'row-amount' + (row.revenue_cents === 0 ? ' zero' : '')}
          >
            {money(row.revenue_cents)}
          </span>
        </div>
      ))}

      <div className="statement-total">
        <span className="label">Total attributed revenue</span>
        <span className="amount">{money(total)}</span>
      </div>
    </div>
  );
}
