import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import ChecklistRail from './ChecklistRail.jsx';

// The "/" route. For a brand-new user with no sites, this IS onboarding
// Step 1 (create site) — page head + checklist rail (step 1 active) + the
// restyled create panel, matching the reference. Once the user has sites, it
// falls back to a simple all-sites list (kept minimal; multi-site management
// is out of scope for this build).
export default function Sites({ onSitePill }) {
  const nav = useNavigate();
  const [sites, setSites] = useState(null); // null = loading
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    onSitePill?.(null); // no active site on this screen
  }, [onSitePill]);

  async function load() {
    try {
      const res = await api.listSites();
      setSites(res.sites || []);
    } catch (err) {
      setError(err.message);
      setSites([]);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function create(e) {
    e.preventDefault();
    setError('');
    if (!name.trim()) return;
    setBusy(true);
    try {
      const res = await api.createSite(name.trim());
      // Step 1 done ⟺ the site exists. Go straight to the new site's
      // dashboard, which derives the next step (install script).
      nav(`/sites/${res.site.id}`);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  if (sites === null) return <p className="loading">Loading…</p>;

  // --- New user: onboarding Step 1 ---
  if (sites.length === 0) {
    return (
      <div className="layout">
        <div className="page-head">
          <h1>Let's get your first site set up</h1>
          <p>Three quick steps — takes about five minutes total.</p>
        </div>
        <ChecklistRail currentStep={1} />
        <div className="state-view">
          <div className="panel">
            <div className="panel-eyebrow">STEP 1 OF 3</div>
            <h2>What should we call this site?</h2>
            <p className="lead">
              This is just a label for you — it doesn't need to match your
              website's name exactly. You can track more than one site later if
              you need to.
            </p>
            <form className="field-row" onSubmit={create}>
              <input
                type="text"
                placeholder="e.g. My Coaching Business"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
              <button className="btn-primary" type="submit" disabled={busy}>
                {busy ? 'Creating…' : 'Create site'}
              </button>
            </form>
            {error && <p className="error">{error}</p>}
          </div>
        </div>
      </div>
    );
  }

  // --- Returning user: simple all-sites list + create-another ---
  return (
    <div>
      <div className="page-head" style={{ marginBottom: 24 }}>
        <h1>Your sites</h1>
      </div>

      <div className="card">
        <h2>Create a site</h2>
        <form onSubmit={create} className="inline-form">
          <input
            placeholder="e.g. My Coaching Business"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <button className="btn" type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </form>
        {error && <p className="error">{error}</p>}
      </div>

      <div className="card">
        <h2>All sites</h2>
        <ul className="site-list">
          {sites.map((s) => (
            <li key={s.id}>
              <Link to={`/sites/${s.id}`}>{s.name}</Link>
              <span className="muted"> — {s.domain || 'no domain'}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
