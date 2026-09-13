import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, Link, useNavigate } from 'react-router-dom';
import { getIdToken, signOut } from './auth';
import Login from './pages/Login.jsx';
import Sites from './pages/Sites.jsx';
import SiteDetail from './pages/SiteDetail.jsx';

export default function App() {
  const [authed, setAuthed] = useState(null); // null = loading
  // Name of the site currently being viewed, shown as a pill in the nav shell
  // (mockup). Null on the "all sites" / step-1 screens, where no site is active.
  const [sitePill, setSitePill] = useState(null);

  useEffect(() => {
    getIdToken().then((token) => setAuthed(!!token));
  }, []);

  if (authed === null) return <div className="loading">Loading…</div>;

  return (
    <div className="app">
      <Header
        authed={authed}
        sitePill={sitePill}
        onSignOut={() => {
          setSitePill(null);
          setAuthed(false);
        }}
      />
      <main className="container">
        <Routes>
          <Route
            path="/login"
            element={
              authed ? (
                <Navigate to="/" replace />
              ) : (
                <Login onAuthed={() => setAuthed(true)} />
              )
            }
          />
          <Route
            path="/"
            element={
              authed ? (
                <Sites onSitePill={setSitePill} />
              ) : (
                <Navigate to="/login" replace />
              )
            }
          />
          <Route
            path="/sites/:id"
            element={
              authed ? (
                <SiteDetail onSitePill={setSitePill} />
              ) : (
                <Navigate to="/login" replace />
              )
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Header({ authed, sitePill, onSignOut }) {
  const nav = useNavigate();
  return (
    <header className="header">
      <Link to="/" className="brand">
        DataBuilder
      </Link>
      {authed && (
        <div className="nav-right">
          {sitePill && <span className="site-pill">{sitePill}</span>}
          <button
            className="btn-link"
            onClick={() => {
              signOut();
              onSignOut();
              nav('/login');
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </header>
  );
}
