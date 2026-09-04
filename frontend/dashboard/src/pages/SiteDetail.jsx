import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api';

const RANGES = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
];

function money(cents, currency) {
  const v = (cents || 0) / 100;
  return v.toLocaleString(undefined, {
    style: 'currency',
    currency: (currency || 'USD').toUpperCase(),
  });
}

export default function SiteDetail() {
  const { id } = useParams();
  const [range, setRange] = useState('30d');
  const [overview, setOverview] = useState(null);
  const [visitors, setVisitors] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    Promise.all([api.overview(id, range), api.visitors(id, range)])
      .then(([ov, vis]) => {
        if (!alive) return;
        setOverview(ov);
        setVisitors(vis.visitors || []);
      })
      .catch((err) => alive && setError(err.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [id, range]);

  return (
    <div>
      <p>
        <Link to="/">← All sites</Link>
      </p>
      <div className="range-bar">
        {RANGES.map((r) => (
          <button
            key={r.key}
            className={'range-btn' + (r.key === range ? ' active' : '')}
            onClick={() => setRange(r.key)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {error && <p className="error">{error}</p>}
      {loading && <p>Loading…</p>}

      {overview && !loading && (
        <>
          <div className="stats">
            <div className="stat">
              <div className="stat-label">Total visitors</div>
              <div className="stat-value">
                {overview.totals.total_visitors}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Total revenue</div>
              <div className="stat-value">
                {money(overview.totals.total_revenue_cents)}
              </div>
            </div>
          </div>

          <div className="card">
            <h2>Revenue & visitors by source (first-touch)</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th className="num">Visitors</th>
                  <th className="num">Revenue</th>
                  <th className="num">Rev / visitor</th>
                  <th className="num">Payments</th>
                </tr>
              </thead>
              <tbody>
                {overview.breakdown.length === 0 && (
                  <tr>
                    <td colSpan="5" className="muted">
                      No data in this range.
                    </td>
                  </tr>
                )}
                {overview.breakdown.map((row) => (
                  <tr key={row.source}>
                    <td>{row.source}</td>
                    <td className="num">{row.visitors}</td>
                    <td className="num">{money(row.revenue_cents)}</td>
                    <td className="num">
                      {money(row.revenue_per_visitor_cents)}
                    </td>
                    <td className="num">{row.payments}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h2>Visitors</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>First seen</th>
                  <th>Source</th>
                  <th>Medium</th>
                  <th>Campaign</th>
                  <th>Email</th>
                  <th className="num">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {visitors.length === 0 && (
                  <tr>
                    <td colSpan="6" className="muted">
                      No visitors in this range.
                    </td>
                  </tr>
                )}
                {visitors.map((v) => (
                  <tr key={v.id}>
                    <td>{new Date(v.first_seen_at).toLocaleString()}</td>
                    <td>{v.first_utm_source || '(direct)'}</td>
                    <td>{v.first_utm_medium || '—'}</td>
                    <td>{v.first_utm_campaign || '—'}</td>
                    <td>{v.email || '—'}</td>
                    <td className="num">{money(v.revenue_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
