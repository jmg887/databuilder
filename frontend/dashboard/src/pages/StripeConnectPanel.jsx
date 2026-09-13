import { useState } from 'react';
import { api } from '../api';

// Onboarding Step 3 — restyled around the EXISTING PR#2 Stripe self-service
// connect flow (api.connectStripe → POST /sites/:id/integrations/stripe). This
// only restyles the form to match the reference panel; the backend logic is
// unchanged. On success, calls onConnected() so the parent re-derives state
// and auto-advances to the complete view.
const REQUIRED_SCOPES = [
  ['Webhooks', 'Write'],
  ['Checkout Sessions', 'Read'],
  ['Payment Intents', 'Read'],
  ['Customers', 'Read'],
];

export default function StripeConnectPanel({ siteId, visitorCount, onConnected }) {
  const [rak, setRak] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function connect(e) {
    e.preventDefault();
    setError('');
    const key = rak.trim();
    // Same client-side pre-check as the existing integration form.
    if (!key.startsWith('rk_live_')) {
      setError('invalid key format');
      return;
    }
    setBusy(true);
    try {
      await api.connectStripe(siteId, key);
      setRak('');
      await onConnected(); // re-derive → advances to complete
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  const label =
    visitorCount === 1 ? '1 visitor' : `${visitorCount} visitors`;

  return (
    <div className="panel">
      <div className="panel-eyebrow">STEP 3 OF 3</div>
      <h2>We're seeing visitors — now let's find out who's paying</h2>
      <div className="confirm-card">
        <div className="confirm-check">✓</div>
        <div>
          <div className="num">{label}</div>
          <div className="txt">
            detected in the last few minutes — your script is working.
          </div>
        </div>
      </div>
      <p className="lead">
        Connect your Stripe account so we can match these visitors to actual
        payments. We only need read access — paste a restricted key from your
        Stripe dashboard.
      </p>
      <ul className="perm-list">
        {REQUIRED_SCOPES.map(([res, perm]) => (
          <li key={res}>
            <span>{res}</span>
            <span>{perm}</span>
          </li>
        ))}
      </ul>
      <form className="field-row" onSubmit={connect}>
        <input
          type="password"
          placeholder="rk_live_..."
          value={rak}
          onChange={(e) => setRak(e.target.value)}
          required
        />
        <button className="btn-primary" type="submit" disabled={busy}>
          {busy ? 'Connecting…' : 'Connect Stripe'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
