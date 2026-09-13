import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import ChecklistRail from './ChecklistRail.jsx';
import StripeConnectPanel from './StripeConnectPanel.jsx';
import OverviewPanel from './OverviewPanel.jsx';

const POLL_MS = 5000;

// The site dashboard page. Derives the onboarding step from REAL data
// (status endpoint) and renders the matching state:
//   step 2  — install script (polls for first traffic, auto-advances)
//   step 3  — connect Stripe (auto-advances on success)
//   complete — collapsed banner (until dismissed) + restyled Overview
export default function SiteDetail({ onSitePill }) {
  const { id } = useParams();
  const [status, setStatus] = useState(null); // status endpoint payload
  const [siteName, setSiteName] = useState('');
  const [error, setError] = useState('');
  const pollRef = useRef(null);

  const refreshStatus = useCallback(async () => {
    const s = await api.status(id);
    setStatus(s);
    return s;
  }, [id]);

  // Resolve the site name once (for the nav pill + dashboard head).
  useEffect(() => {
    let alive = true;
    api
      .listSites()
      .then((res) => {
        if (!alive) return;
        const site = (res.sites || []).find((s) => s.id === id);
        setSiteName(site ? site.name : '');
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id]);

  // Push the site name into the nav shell pill; clear on unmount.
  useEffect(() => {
    if (siteName) onSitePill?.(siteName);
    return () => onSitePill?.(null);
  }, [siteName, onSitePill]);

  // Initial status load.
  useEffect(() => {
    let alive = true;
    setStatus(null);
    setError('');
    refreshStatus().catch((err) => alive && setError(err.message));
    return () => {
      alive = false;
    };
  }, [id, refreshStatus]);

  // Derive the current step from real data.
  //   hasTraffic false            -> step 2 (install script)
  //   hasTraffic, !stripeConnected -> step 3 (connect Stripe)
  //   both                        -> complete
  const step =
    status == null
      ? null
      : !status.hasTraffic
      ? 2
      : !status.stripeConnected
      ? 3
      : 'complete';

  // Live polling: only while on step 2 (waiting for first traffic). Stop as
  // soon as traffic is detected or we leave this step (advance/unmount).
  useEffect(() => {
    if (step !== 2) return undefined;
    pollRef.current = setInterval(() => {
      refreshStatus().catch(() => {});
    }, POLL_MS);
    return () => {
      clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [step, refreshStatus]);

  if (error) return <p className="error">{error}</p>;
  if (step == null) return <p className="loading">Loading…</p>;

  // ---------- COMPLETE ----------
  if (step === 'complete') {
    return (
      <CompleteView
        siteId={id}
        siteName={siteName}
        dismissedAt={status.onboardingDismissedAt}
        onDismissed={refreshStatus}
      />
    );
  }

  // ---------- ONBOARDING (steps 2 & 3) ----------
  return (
    <div className="layout">
      <div className="page-head">
        <h1>Let's get your first site set up</h1>
        <p>Three quick steps — takes about five minutes total.</p>
      </div>
      <ChecklistRail currentStep={step} />
      <div className="state-view">
        {step === 2 && <InstallScriptPanel snippet={status.snippet} />}
        {step === 3 && (
          <StripeConnectPanel
            siteId={id}
            visitorCount={status.visitorCount}
            onConnected={refreshStatus}
          />
        )}
      </div>
    </div>
  );
}

// ---------- STEP 2: install script + live traffic detection ----------
function InstallScriptPanel({ snippet }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — user can select manually */
    }
  }

  return (
    <div className="panel">
      <div className="panel-eyebrow">STEP 2 OF 3</div>
      <h2>Add this snippet to your site</h2>
      <p className="lead">
        Paste this once into your website's header — most platforms (Kajabi,
        Teachable, Podia, Circle, your own site) have a spot for exactly this.
        You won't need to touch it again.
      </p>
      <div className="code-block">{snippet}</div>
      <div className="copy-row">
        <button className="copy-btn" onClick={copy}>
          {copied ? 'Copied!' : 'Copy snippet'}
        </button>
      </div>
      <div className="status-row">
        <span className="pulse-dot"></span> Waiting for your first visitor…
      </div>
    </div>
  );
}

// ---------- COMPLETE: banner (until dismissed) + restyled Overview ----------
function CompleteView({ siteId, siteName, dismissedAt, onDismissed }) {
  const [busy, setBusy] = useState(false);

  async function dismiss() {
    setBusy(true);
    try {
      await api.dismissOnboarding(siteId);
      await onDismissed(); // re-fetch status so the banner disappears
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="layout">
      {!dismissedAt && (
        <div className="complete-banner">
          <div className="left">
            <span className="badge">✓</span> Setup complete — DataBuilder is now
            tracking {siteName || 'your site'}
          </div>
          <button onClick={dismiss} disabled={busy}>
            {busy ? '…' : 'Dismiss'}
          </button>
        </div>
      )}
      <div className="dash-full">
        <div className="dash-head">
          <h1>{siteName || 'Your site'}</h1>
          <p>Here's what's actually working.</p>
        </div>
        <OverviewPanel siteId={siteId} />
      </div>
    </div>
  );
}
