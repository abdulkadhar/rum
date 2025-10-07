(function () {
  // -------- Locate the <script> tag and read config --------
  const currentScript =
    document.currentScript || document.querySelector('script[data-endpoint-id]');

  const endpointId = currentScript
    ? currentScript.getAttribute('data-endpoint-id')
    : null;

  const apiBaseUrl = currentScript
    ? currentScript.getAttribute('data-api-url') || 'http://localhost:8000'
    : 'http://localhost:8000';

  const errorsBaseUrl = currentScript
    ? currentScript.getAttribute('data-errors-url') || apiBaseUrl
    : apiBaseUrl;

  // -------- Session ID (persists for this browser tab) --------
  const sessionId =
    sessionStorage.getItem('rum_session_id') ||
    'sess-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  sessionStorage.setItem('rum_session_id', sessionId);

  const rumIds = { session_id: sessionId, endpoint_id: endpointId };

  // -------- Helpers --------
  function toEpochMs(monotonicMs) {
    return performance.timeOrigin + monotonicMs;
  }

  function post(url, payload, useBeacon = false) {
    if (useBeacon && navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      return navigator.sendBeacon(url, blob);
    }
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(() => {});
  }

  function sendMetrics(data) {
    const payload = { ...data, ...rumIds };
    return post(`${apiBaseUrl}/rum/page-metrics`, payload, true);
  }

  function sendError(data) {
    const payload = { ...data, ...rumIds };
    return post(`${errorsBaseUrl}/rum/errors`, payload, false);
  }

  // -------- Performance Observers --------
  let fpValue = null, fcpValue = null, lcpValue = null;

  try {
    const paintObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.name === 'first-paint') fpValue = e.startTime;
        if (e.name === 'first-contentful-paint') fcpValue = e.startTime;
      }
    });
    paintObserver.observe({ type: 'paint', buffered: true });
  } catch {}

  try {
    const lcpObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) lcpValue = last.startTime;
    });
    lcpObserver.observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {}

  // INP / FID
  let fidValue = null, inpValue = null;

  try {
    const fidObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === 'first-input') {
          fidValue = entry.processingStart - entry.startTime;
        }
      }
    });
    fidObserver.observe({ type: 'first-input', buffered: true });
  } catch {}

  try {
    const inpObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.interactionId) inpValue = entry.duration;
      }
    });
    inpObserver.observe({ type: 'event', buffered: true, durationThreshold: 16 });
  } catch {}

  // CLS
  let clsValue = 0;
  try {
    const clsObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) clsValue += entry.value;
      }
    });
    clsObserver.observe({ type: 'layout-shift', buffered: true });
  } catch {}

  function collectResourceMetrics() {
    const resources = performance.getEntriesByType('resource') || [];
    return resources
      .filter((r) => r.initiatorType !== 'beacon')
      .map((r) => ({
        name: r.name,
        type: r.initiatorType,
        duration: r.duration,
        transferSize: r.transferSize || null,
        startTime: r.startTime,
        responseEnd: r.responseEnd
      }));
  }

  function collectEnvironmentMetrics() {
    return {
      user_agent: navigator.userAgent || 'unknown',
      language: navigator.language || 'unknown',
      platform: navigator.platform || 'unknown',
      device_memory: navigator.deviceMemory ?? 'not_supported',
      hardware_concurrency: navigator.hardwareConcurrency ?? 'not_supported',
      screen_width: window.screen?.width || 0,
      screen_height: window.screen?.height || 0,
      pixel_ratio: window.devicePixelRatio || 1,
      connection: navigator.connection
        ? {
            effectiveType: navigator.connection.effectiveType,
            downlink: navigator.connection.downlink,
            rtt: navigator.connection.rtt
          }
        : 'not_supported'
    };
  }

  function collectRUMMetrics(trigger = 'page_load') {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    return {
      url: window.location.href,
      timestamp: new Date().toISOString(),
      trigger,
      metrics: {
        ttfb: (nav.responseStart - nav.requestStart) || null,
        dom_content_loaded: nav.domContentLoadedEventEnd || null,
        first_paint: fpValue,
        first_contentful_paint: fcpValue,
        largest_contentful_paint: lcpValue,
        onload: nav.loadEventEnd || null,
        first_input_delay: fidValue,
        interaction_to_next_paint: inpValue,
        cumulative_layout_shift: clsValue,
        resources: collectResourceMetrics()
      }
    };
  }

  // -------- Session lifecycle (start/end) --------
  if (!sessionStorage.getItem('rum_session_start')) {
    sessionStorage.setItem('rum_session_start', String(Date.now()));
    sendMetrics({
      trigger: 'session_start',
      session: {
        start_ts: new Date().toISOString(),
        start_epoch_ms: Date.now()
      }
    });
  }

  ['pagehide', 'visibilitychange', 'beforeunload'].forEach((evt) => {
    window.addEventListener(
      evt,
      () => {
        if (document.visibilityState === 'hidden' || evt !== 'visibilitychange') {
          sendMetrics({
            trigger: 'session_end',
            session: {
              start_epoch_ms: Number(sessionStorage.getItem('rum_session_start')) || null,
              end_ts: new Date().toISOString(),
              end_epoch_ms: Date.now()
            }
          });
        }
      },
      { once: true }
    );
  });

  // -------- Error capture --------
  window.addEventListener('error', function (event) {
    sendError({
      trigger: 'js_error',
      error: {
        message: event.message,
        source: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error ? event.error.stack : null
      }
    });
  });

  window.addEventListener('unhandledrejection', function (event) {
    sendError({
      trigger: 'js_promise_rejection',
      error: {
        message: event.reason ? event.reason.message || String(event.reason) : 'Unhandled Promise Rejection',
        stack: event.reason && event.reason.stack ? event.reason.stack : null
      }
    });
  });

  // -------- Patch fetch (inject headers + timings + errors) --------
  (function (fetchFn) {
    window.fetch = function (input, init = {}) {
      init = init || {};
      init.headers = {
        ...(init.headers || {}),
        'X-RUM-Session-Id': rumIds.session_id,
        'X-RUM-Endpoint-Id': rumIds.endpoint_id
      };

      const startMono = performance.now();
      const startEpoch = toEpochMs(startMono);
      const method = (init.method || 'GET').toUpperCase();
      const endpoint = typeof input === 'string' ? input : input.url;

      return fetchFn.call(this, input, init)
        .then((response) => {
          const endMono = performance.now();
          const endEpoch = toEpochMs(endMono);
          const duration = endMono - startMono;

          const rec = {
            api: {
              type: 'fetch',
              method,
              endpoint,
              status: response.status,
              duration,
              start_epoch_ms: startEpoch,
              end_epoch_ms: endEpoch,
              start_ts: new Date(startEpoch).toISOString(),
              end_ts: new Date(endEpoch).toISOString()
            }
          };

          if (response.status >= 400) {
            sendError({ trigger: 'api_call_error', ...rec });
          } else {
            sendMetrics({ trigger: 'api_call', ...rec });
          }
          return response;
        })
        .catch((err) => {
          const endMono = performance.now();
          const endEpoch = toEpochMs(endMono);
          const duration = endMono - startMono;

          sendError({
            trigger: 'api_call_exception',
            api: {
              type: 'fetch',
              method,
              endpoint,
              status: null,
              duration,
              error: err?.message || String(err),
              start_epoch_ms: startEpoch,
              end_epoch_ms: endEpoch,
              start_ts: new Date(startEpoch).toISOString(),
              end_ts: new Date(endEpoch).toISOString()
            }
          });
          throw err;
        });
    };
  })(window.fetch);

  // -------- Patch XHR (inject headers + timings + errors) --------
  (function (open) {
    XMLHttpRequest.prototype.open = function (method, url, async, user, password) {
      this._reqData = { method: (method || 'GET').toUpperCase(), url };

      this.addEventListener('readystatechange', function () {
        if (this.readyState === 1) {
          try {
            this.setRequestHeader('X-RUM-Session-Id', rumIds.session_id);
            this.setRequestHeader('X-RUM-Endpoint-Id', rumIds.endpoint_id);
          } catch {}
          this._reqData.startMono = performance.now();
          this._reqData.startEpoch = toEpochMs(this._reqData.startMono);
        }
      });

      this.addEventListener('loadend', function () {
        const endMono = performance.now();
        const endEpoch = toEpochMs(endMono);
        const startEpoch = this._reqData.startEpoch || toEpochMs(this._reqData.startMono || 0);
        const duration = endMono - (this._reqData.startMono || endMono);

        const base = {
          api: {
            type: 'xhr',
            method: this._reqData.method,
            endpoint: this._reqData.url,
            status: this.status,
            duration,
            start_epoch_ms: startEpoch,
            end_epoch_ms: endEpoch,
            start_ts: new Date(startEpoch).toISOString(),
            end_ts: new Date(endEpoch).toISOString()
          }
        };

        if (this.status >= 400) {
          sendError({ trigger: 'api_call_error', ...base });
        } else {
          sendMetrics({ trigger: 'api_call', ...base });
        }
      });

      open.apply(this, arguments);
    };
  })(XMLHttpRequest.prototype.open);

  // -------- Business metric helper (optional public API) --------
  function logBusinessMetric(name, value, extra = {}) {
    sendMetrics({
      trigger: 'business_metric',
      business: { name, value, ...extra }
    });
  }
  window.__rumLogBusiness = logBusinessMetric;

  // -------- Environment + Page load + SPA routing --------
  window.addEventListener('load', () => {
    sendMetrics({ trigger: 'environment', environment: collectEnvironmentMetrics() });
    setTimeout(() => sendMetrics(collectRUMMetrics('page_load')), 1000);
  });

  ['pushState', 'replaceState'].forEach((fn) => {
    const orig = history[fn];
    history[fn] = function () {
      orig.apply(this, arguments);
      window.dispatchEvent(new Event('spa-navigation'));
    };
  });
  window.addEventListener('popstate', () => window.dispatchEvent(new Event('spa-navigation')));
  window.addEventListener('spa-navigation', () => {
    setTimeout(() => sendMetrics(collectRUMMetrics('spa_navigation')), 300);
  });

  // -------- Heartbeat (active users) --------
  function sendHeartbeat() {
    sendMetrics({ trigger: 'heartbeat', environment: collectEnvironmentMetrics() });
  }
  setInterval(sendHeartbeat, 15000);
  window.addEventListener('load', sendHeartbeat);
})();
