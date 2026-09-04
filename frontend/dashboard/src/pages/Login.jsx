import { useState } from 'react';
import { signIn, signUp, confirmSignUp } from '../auth';

export default function Login({ onAuthed }) {
  const [mode, setMode] = useState('signin'); // signin | signup | confirm
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'signin') {
        await signIn(email, password);
        onAuthed();
      } else if (mode === 'signup') {
        await signUp(email, password);
        setMode('confirm');
      } else if (mode === 'confirm') {
        await confirmSignUp(email, code);
        await signIn(email, password);
        onAuthed();
      }
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card auth-card">
      <h1>
        {mode === 'signin'
          ? 'Sign in'
          : mode === 'signup'
          ? 'Create account'
          : 'Confirm email'}
      </h1>
      <form onSubmit={submit}>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        {mode !== 'confirm' && (
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
        )}
        {mode === 'confirm' && (
          <label>
            Confirmation code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
            />
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <button className="btn" disabled={busy} type="submit">
          {busy ? '…' : 'Continue'}
        </button>
      </form>
      {mode === 'signin' && (
        <p className="muted">
          No account?{' '}
          <button className="btn-link" onClick={() => setMode('signup')}>
            Sign up
          </button>
        </p>
      )}
      {mode === 'signup' && (
        <p className="muted">
          Have an account?{' '}
          <button className="btn-link" onClick={() => setMode('signin')}>
            Sign in
          </button>
        </p>
      )}
    </div>
  );
}
