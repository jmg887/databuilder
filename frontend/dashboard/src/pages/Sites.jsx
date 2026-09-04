import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

export default function Sites() {
  const [sites, setSites] = useState([]);
  const [name, setName] = useState('');
  const [domain, setDomain] = useState('');
  const [error, setError] = useState('');
  const [created, setCreated] = useState(null); // { site, snippet }
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const res = await api.listSites();
      setSites(res.sites || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function create(e) {
    e.preventDefault();
    setError('');
    try {
      const res = await api.createSite(name, domain);
      setCreated(res);
      setName('');
      setDomain('');
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div>
      <h1>Your sites</h1>

      <div className="card">
        <h2>Create a site</h2>
        <form onSubmit={create} className="inline-form">
          <input
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <input
            placeholder="Domain (optional)"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
          />
          <button className="btn" type="submit">
            Create
          </button>
        </form>
        {error && <p className="error">{error}</p>}
      </div>

      {created && (
        <div className="card">
          <h2>Tracking snippet for “{created.site.name}”</h2>
          <p className="muted">
            Paste this into the <code>&lt;head&gt;</code> of your site.
          </p>
          <pre className="snippet">{created.snippet}</pre>
        </div>
      )}

      <div className="card">
        <h2>All sites</h2>
        {loading ? (
          <p>Loading…</p>
        ) : sites.length === 0 ? (
          <p className="muted">No sites yet.</p>
        ) : (
          <ul className="site-list">
            {sites.map((s) => (
              <li key={s.id}>
                <Link to={`/sites/${s.id}`}>{s.name}</Link>
                <span className="muted"> — {s.domain || 'no domain'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
