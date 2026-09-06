import { useEffect, useState } from 'react';
import { api } from '../api';

const REQUIRED_SCOPES = [
  ['Webhooks', 'Write', 'create the webhook endpoint'],
  ['Checkout Sessions', 'Read', 'backfill historical payments'],
  ['Payment Intents', 'Read', 'backfill historical payments'],
  ['Customers', 'Read', 'resolve customer email for attribution'],
];

export default function StripeIntegration({ siteId }) {
  const [status, setStatus] = useState(null);
  const [rak, setRak] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await api.getIntegrations(siteId);
      setStatus(res.stripe);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [siteId]);

  async function connect(e) {
    e.preventDefault();
    setError('');

    // Client-side pre-check for the obvious wrong-format case, to save a
    // network round-trip. The server still validates authoritatively.
    const key = rak.trim();
    if (!key.startsWith('rk_live_')) {
      setError('invalid key format');
      return;
    }

    setBusy(true);
    try {
      await api.connectStripe(siteId, key);
      setRak('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setError('');
    setBusy(true);
    try {
      await api.disconnectStripe(siteId);
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Payments — Stripe</h2>

      {loading && <p>Loading…</p>}

      {!loading && status && status.connected && (
        <div>
          <p>
            <span className="badge badge-ok">Connected</span>
            {status.connectedAt && (
              <span className="muted">
                {' '}
                since {new Date(status.connectedAt).toLocaleString()}
              </span>
            )}
          </p>
          <p className="muted">
            Backfill status: <strong>{status.backfillStatus || 'n/a'}</strong>
          </p>
          {error && <p className="error">{error}</p>}
          <button className="btn btn-danger" disabled={busy} onClick={disconnect}>
            {busy ? '…' : 'Disconnect'}
          </button>
        </div>
      )}

      {!loading && status && !status.connected && (
        <div>
          <p className="muted">
            Connect Stripe by pasting a <strong>restricted API key</strong>{' '}
            (starts with <code>rk_live_</code>). Create one in Stripe:
            Developers → API keys → Create restricted key, granting:
          </p>
          <ul className="scopes">
            {REQUIRED_SCOPES.map(([res, perm, why]) => (
              <li key={res}>
                <strong>{res}</strong>: {perm}{' '}
                <span className="muted">— to {why}</span>
              </li>
            ))}
          </ul>
          <form onSubmit={connect} className="inline-form">
            <input
              type="password"
              placeholder="rk_live_..."
              value={rak}
              onChange={(e) => setRak(e.target.value)}
              required
            />
            <button className="btn" type="submit" disabled={busy}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
          </form>
          {error && <p className="error">{error}</p>}
          <p className="muted small">
            We register the webhook and backfill your historical payments
            automatically. Your key is stored securely and never displayed
            again.
          </p>
        </div>
      )}
    </div>
  );
}
