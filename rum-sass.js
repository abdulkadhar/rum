(function () {
  const currentScript = document.currentScript ||
    document.querySelector('script[data-endpoint-id]');

  // Config from <script> tag
  const endpointId = currentScript ? currentScript.getAttribute("data-endpoint-id") : null;
  const apiBaseUrl = currentScript ? currentScript.getAttribute("data-api-url") || "http://localhost:8000" : "http://localhost:8000";
  const errorsBaseUrl = currentScript ? currentScript.getAttribute("data-errors-url") || apiBaseUrl : apiBaseUrl;

  // Session ID
  const sessionId = sessionStorage.getItem("rum_session_id") ||
    "sess-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  sessionStorage.setItem("rum_session_id", sessionId);

  const rumIds = { session_id: sessionId, endpoint_id: endpointId };

  // ---------------- Helpers ----------------
  function sendMetrics(data) {
    const payload = { ...data, ...rumIds };
    const url = `${apiBaseUrl}/rum/page-metrics`;

    if (navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
      navigator.sendBeacon(url, blob);
    } else {
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).catch(console.error);
    }
  }

  function sendError(data) {
    const payload = { ...data, ...rumIds };
    const url = `${errorsBaseUrl}/rum/errors`;

    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }).catch(console.error);
  }

  // ---------------- Page Load Observers ----------------
  let fpValue = null, fcpValue = null, lcpValue = null;
  try {
    const paintObserver = new PerformanceObserver((list) => {
      list.getEntries().forEach((e) => {
        if (e.name === "first-paint") fpValue = e.startTime;
        if (e.name === "first-contentful-paint") fcpValue = e.startTime;
      });
    });
    paintObserver.observe({ type: "paint", buffered: true });
  } catch {}

  try {
    const lcpObserver = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries[entries.length - 1];
      if (last) lcpValue = last.startTime;
    });
    lcpObserver.observe({ type: "largest-contentful-paint", buffered: true });
  } catch {}

  // ---------------- User Interaction Observers ----------------
  let fidValue = null, inpValue = null;
  try {
    const fidObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.entryType === "first-input") {
          fidValue = entry.processingStart - entry.startTime;
        }
      }
    });
    fidObserver.observe({ type: "first-input", buffered: true });
  } catch {}

  try {
    const inpObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.interactionId) inpValue = entry.duration;
      }
    });
    inpObserver.observe({ type: "event", buffered: true, durationThreshold: 16 });
  } catch {}

  // ---------------- Stability Metrics (CLS) ----------------
  let clsValue = 0;
  try {
    const clsObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) clsValue += entry.value;
      }
    });
    clsObserver.observe({ type: "layout-shift", buffered: true });
  } catch {}

  // ---------------- Resource Metrics ----------------
  function collectResourceMetrics() {
    const resources = performance.getEntriesByType("resource") || [];
    return resources
      .filter(r => r.initiatorType !== "beacon")
      .map(r => ({
        name: r.name,
        type: r.initiatorType,
        duration: r.duration,
        transferSize: r.transferSize || null,
        startTime: r.startTime,
        responseEnd: r.responseEnd
      }));
  }

  // ---------------- Environment Metrics ----------------
  function collectEnvironmentMetrics() {
    return {
      user_agent: navigator.userAgent || "unknown",
      language: navigator.language || "unknown",
      platform: navigator.platform || "unknown",
      device_memory: navigator.deviceMemory ?? "not_supported",
      hardware_concurrency: navigator.hardwareConcurrency ?? "not_supported",
      screen_width: window.screen.width || 0,
      screen_height: window.screen.height || 0,
      pixel_ratio: window.devicePixelRatio || 1,
      connection: navigator.connection ? {
        effectiveType: navigator.connection.effectiveType,
        downlink: navigator.connection.downlink,
        rtt: navigator.connection.rtt
      } : "not_supported"
    };
  }

  // ---------------- Collect Core Metrics ----------------
  function collectRUMMetrics(trigger = "page_load") {
    const perf = performance.getEntriesByType("navigation")[0] || {};
    return {
      url: window.location.href,
      timestamp: new Date().toISOString(),
      trigger,
      metrics: {
        ttfb: perf.responseStart - perf.requestStart || null,
        dom_content_loaded: perf.domContentLoadedEventEnd || null,
        first_paint: fpValue,
        first_contentful_paint: fcpValue,
        largest_contentful_paint: lcpValue,
        onload: perf.loadEventEnd || null,
        first_input_delay: fidValue,
        interaction_to_next_paint: inpValue,
        cumulative_layout_shift: clsValue,
        resources: collectResourceMetrics()
      }
    };
  }

  // ---------------- Error Capture ----------------
  window.addEventListener("error", function (event) {
    sendError({
      trigger: "js_error",
      error: {
        message: event.message,
        source: event.filename,
        lineno: event.lineno,
        colno: event.colno,
        stack: event.error ? event.error.stack : null
      }
    });
  });

  window.addEventListener("unhandledrejection", function (event) {
    sendError({
      trigger: "js_promise_rejection",
      error: {
        message: event.reason ? event.reason.message || event.reason : "Unhandled Promise Rejection",
        stack: event.reason && event.reason.stack ? event.reason.stack : null
      }
    });
  });

  // ---------------- Patch Fetch ----------------
  (function(fetchFn) {
    window.fetch = function(input, init = {}) {
      init = init || {};
      init.headers = {
        ...(init.headers || {}),
        "X-RUM-Session-Id": rumIds.session_id,
        "X-RUM-Endpoint-Id": rumIds.endpoint_id
      };

      const start = performance.now();
      const method = init.method || "GET";

      return fetchFn.call(this, input, init).then(response => {
        const duration = performance.now() - start;
        if (response.status >= 400) {
          sendError({
            trigger: "api_call_error",
            api: { type: "fetch", method, endpoint: typeof input === "string" ? input : input.url, status: response.status, duration }
          });
        } else {
          sendMetrics({
            trigger: "api_call",
            api: { type: "fetch", method, endpoint: typeof input === "string" ? input : input.url, status: response.status, duration }
          });
        }
        return response;
      }).catch(err => {
        const duration = performance.now() - start;
        sendError({
          trigger: "api_call_exception",
          api: { type: "fetch", method, endpoint: typeof input === "string" ? input : input.url, status: null, duration, error: err.message }
        });
        throw err;
      });
    };
  })(window.fetch);

  // ---------------- Patch XHR ----------------
  (function(open) {
    XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
      this._reqData = { method, url, start: performance.now() };

      this.addEventListener("readystatechange", function() {
        if (this.readyState === 1) {
          try {
            this.setRequestHeader("X-RUM-Session-Id", rumIds.session_id);
            this.setRequestHeader("X-RUM-Endpoint-Id", rumIds.endpoint_id);
          } catch (e) {
            console.warn("Could not set RUM headers", e);
          }
        }
      });

      this.addEventListener("loadend", function() {
        const duration = performance.now() - this._reqData.start;
        const data = {
          api: {
            type: "xhr",
            method: this._reqData.method,
            endpoint: this._reqData.url,
            status: this.status,
            duration
          }
        };
        if (this.status >= 400) {
          sendError({ trigger: "api_call_error", ...data });
        } else {
          sendMetrics({ trigger: "api_call", ...data });
        }
      });

      open.apply(this, arguments);
    };
  })(XMLHttpRequest.prototype.open);

  // ---------------- Business Metrics ----------------
  function logBusinessMetric(name, value, extra = {}) {
    sendMetrics({
      trigger: "business_metric",
      business: { name, value, ...extra }
    });
  }

  window.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("checkoutBtn");
    if (btn) {
      btn.addEventListener("click", () => {
        const start = performance.now();
        setTimeout(() => {
          const duration = performance.now() - start;
          logBusinessMetric("checkout_latency", duration, { step: "payment" });
        }, 1200);
      });
    }
  });

  // ---------------- Environment Metrics ----------------
  window.addEventListener("load", () => {
    sendMetrics({
      trigger: "environment",
      environment: collectEnvironmentMetrics()
    });
  });

  // ---------------- Page Load + SPA Routing ----------------
  window.addEventListener("load", () => {
    setTimeout(() => sendMetrics(collectRUMMetrics("page_load")), 1000);
  });

  ["pushState", "replaceState"].forEach(fn => {
    const orig = history[fn];
    history[fn] = function () {
      orig.apply(this, arguments);
      window.dispatchEvent(new Event("spa-navigation"));
    };
  });

  window.addEventListener("popstate", () => {
    window.dispatchEvent(new Event("spa-navigation"));
  });

  window.addEventListener("spa-navigation", () => {
    setTimeout(() => sendMetrics(collectRUMMetrics("spa_navigation")), 300);
  });

  // ---------------- Heartbeat ----------------
  function sendHeartbeat() {
    sendMetrics({
      trigger: "heartbeat",
      environment: collectEnvironmentMetrics()
    });
  }

  setInterval(sendHeartbeat, 15000);
  window.addEventListener("load", sendHeartbeat);

})();
