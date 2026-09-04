import { useEffect, useState } from 'react';
import { Routes, Route, Navigate, Link, useNavigate } from 'react-router-dom';
import { getCurrentUser, getIdToken, signOut } from './auth';
import Login from './pages/Login.jsx';
import Sites from './pages/Sites.jsx';
import SiteDetail from './pages/SiteDetail.jsx';

export default function App() {
  const [authed, setAuthed] = useState(null); // null = loading

  useEffect(() => {
    getIdToken().then((token) => setAuthed(!!token));
  }, []);

  if (authed === null) return <div className="loading">Loading…</div>;

  return (
    <div className="app">
      <Header authed={authed} onSignOut={() => setAuthed(false)} />
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
            element={authed ? <Sites /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/sites/:id"
            element={authed ? <SiteDetail /> : <Navigate to="/login" replace />}
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Header({ authed, onSignOut }) {
  const nav = useNavigate();
  return (
    <header className="header">
      <Link to="/" className="brand">
        databuilder
      </Link>
      {authed && (
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
      )}
    </header>
  );
}
