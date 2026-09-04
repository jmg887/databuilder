/*!
 * databuilder tracking script (v1)
 *
 * Single async <script> tag, no external dependencies. Captures pageviews,
 * generates/persists a first-party visitor ID cookie, mints a session ID that
 * rolls over after ~30 min of inactivity, and reports first-touch referrer +
 * UTM params on the first ever visit.
 *
 * Usage:
 *   <script async src=".../t.js" data-site-id="SITE_ID"></script>
 * Optional overrides:
 *   data-api="https://api.example.com/collect"
 *
 * Public API (window.databuilder):
 *   databuilder.pageview()          - manually record a pageview
 *   databuilder.identify(email)     - associate an email with the visitor
 */
(function () {
  'use strict';

  var doc = document;
  var script = doc.currentScript;
  if (!script) return;

  var siteId = script.getAttribute('data-site-id');
  if (!siteId) return;

  var api =
    script.getAttribute('data-api') ||
    script.src.replace(/\/[^/]*$/, '') + '/collect';

  var VISITOR_COOKIE = 'db_vid';
  var SESSION_KEY = 'db_sess';
  var SESSION_TTL = 30 * 60 * 1000; // 30 min inactivity => new session
  var VISITOR_TTL_DAYS = 365;

  // ---- small helpers -----------------------------------------------------

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function getCookie(name) {
    var m = doc.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : null;
  }

  function setCookie(name, value, days) {
    var d = new Date();
    d.setTime(d.getTime() + days * 864e5);
    doc.cookie =
      name +
      '=' +
      encodeURIComponent(value) +
      '; expires=' +
      d.toUTCString() +
      '; path=/; SameSite=Lax';
  }

  function param(name) {
    var m = location.search.match(new RegExp('[?&]' + name + '=([^&]*)'));
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : null;
  }

  function utms() {
    return {
      utmSource: param('utm_source'),
      utmMedium: param('utm_medium'),
      utmCampaign: param('utm_campaign'),
    };
  }

  // ---- identity ----------------------------------------------------------

  var isNewVisitor = false;
  var visitorId = getCookie(VISITOR_COOKIE);
  if (!visitorId) {
    visitorId = uuid();
    setCookie(VISITOR_COOKIE, visitorId, VISITOR_TTL_DAYS);
    isNewVisitor = true;
  }

  function currentSession() {
    var now = Date.now();
    var raw;
    try {
      raw = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    } catch (e) {
      raw = null;
    }
    if (!raw || now - raw.last > SESSION_TTL) {
      raw = { id: uuid(), last: now };
    } else {
      raw.last = now;
    }
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(raw));
    } catch (e) {
      /* storage may be unavailable; session still works in-memory */
    }
    return raw.id;
  }

  // ---- transport ---------------------------------------------------------

  function send(events) {
    var payload = JSON.stringify({ siteId: siteId, events: events });
    if (navigator.sendBeacon) {
      var blob = new Blob([payload], { type: 'application/json' });
      if (navigator.sendBeacon(api, blob)) return;
    }
    // Fallback: fetch with keepalive so it survives page unload.
    fetch(api, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
      mode: 'cors',
    }).catch(function () {});
  }

  // ---- event builders -----------------------------------------------------

  function pageview() {
    var u = utms();
    var events = [];

    if (isNewVisitor) {
      // First-touch capture — only sent once, on the very first load.
      events.push({
        type: 'visitor.created',
        visitorId: visitorId,
        referrer: doc.referrer || null,
        utmSource: u.utmSource,
        utmMedium: u.utmMedium,
        utmCampaign: u.utmCampaign,
        timestamp: new Date().toISOString(),
      });
      isNewVisitor = false;
    }

    events.push({
      type: 'pageview',
      visitorId: visitorId,
      sessionId: currentSession(),
      pageUrl: location.href,
      referrer: doc.referrer || null,
      utmSource: u.utmSource,
      utmMedium: u.utmMedium,
      utmCampaign: u.utmCampaign,
      timestamp: new Date().toISOString(),
    });

    send(events);
  }

  function identify(email) {
    if (!email) return;
    send([
      {
        type: 'identify',
        visitorId: visitorId,
        email: email,
        timestamp: new Date().toISOString(),
      },
    ]);
  }

  // ---- SPA route change detection -----------------------------------------

  function hookHistory() {
    var push = history.pushState;
    history.pushState = function () {
      push.apply(this, arguments);
      pageview();
    };
    window.addEventListener('popstate', pageview);
  }

  // ---- boot ----------------------------------------------------------------

  window.databuilder = { pageview: pageview, identify: identify };

  hookHistory();
  pageview();
})();
