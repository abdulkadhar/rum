(function () {
  // --- Identify the script tag that loaded rum.js ---
  const currentScript = document.currentScript ||
    document.querySelector('script[data-endpoint-id]');

  // Extract endpointId if provided
  const endpointId = currentScript ? currentScript.getAttribute("data-endpoint-id") : null;

  // Generate or reuse sessionId
  const sessionId = sessionStorage.getItem("rum_session_id") ||
    "sess-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  sessionStorage.setItem("rum_session_id", sessionId);

  const rumIds = { session_id: sessionId, endpoint_id: endpointId };

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
      .filter(r => r.initiatorType !== "beacon") // 🚫 ignore beacon calls
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
        connection_quality: navigator.connection.effectiveType,
        downlink: navigator.connection.downlink,
        rtt: navigator.connection.rtt
      } : "not_supported"
    };
  }

  // ---------------- Collect Core Metrics ----------------
  function collectRUMMetrics(trigger = "page_load") {
    const perf = performance.getEntriesByType("navigation")[0] || {};
    return {
      session_id: rumIds.session_id,
      endpoint_id: rumIds.endpoint_id,
      url: window.location.href,
      timestamp: new Date().toISOString(),
      trigger,
      metrics: {
        // Page Load
        ttfb: perf.responseStart - perf.requestStart || null,
        dom_content_loaded: perf.domContentLoadedEventEnd || null,
        first_paint: fpValue,
        first_contentful_paint: fcpValue,
        largest_contentful_paint: lcpValue,
        onload: perf.loadEventEnd || null,
        // User Interaction
        first_input_delay: fidValue,
        interaction_to_next_paint: inpValue,
        // Stability
        cumulative_layout_shift: clsValue,
        // Resources
        resources: collectResourceMetrics()
      }
    };
  }

  // ---------------- Send Metrics ----------------
  function sendMetrics(data) {
    const payload = {
      ...data,
      session_id: rumIds.session_id,
      endpoint_id: rumIds.endpoint_id
    };

    if (navigator.sendBeacon) {
      const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
      navigator.sendBeacon("http://localhost:8000/rum/page-metrics", blob);
    } else {
      fetch("http://localhost:8000/rum/page-metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).catch(console.error);
    }
  }

  // ---------------- JavaScript Error Metrics ----------------
  window.addEventListener("error", function (event) {
    sendMetrics({
      session_id: rumIds.session_id,
      endpoint_id: rumIds.endpoint_id,
      url: window.location.href,
      timestamp: new Date().toISOString(),
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
    sendMetrics({
      session_id: rumIds.session_id,
      endpoint_id: rumIds.endpoint_id,
      url: window.location.href,
      timestamp: new Date().toISOString(),
      trigger: "js_promise_rejection",
      error: {
        message: event.reason ? event.reason.message || event.reason : "Unhandled Promise Rejection",
        stack: event.reason && event.reason.stack ? event.reason.stack : null
      }
    });
  });

  // ---------------- Network / API Call Metrics ----------------
  (function(open) {
    XMLHttpRequest.prototype.open = function(method, url, async, user, password) {
      this._reqData = { method, url, start: performance.now() };
      this.addEventListener("loadend", function() {
        const duration = performance.now() - this._reqData.start;
        sendMetrics({
          session_id: rumIds.session_id,
          endpoint_id: rumIds.endpoint_id,
          url: window.location.href,
          timestamp: new Date().toISOString(),
          trigger: "api_call",
          api: {
            type: "xhr",
            method: this._reqData.method,
            endpoint: this._reqData.url,
            status: this.status,
            duration
          }
        });
      });
      open.apply(this, arguments);
    };
  })(XMLHttpRequest.prototype.open);

  (function(fetchFn) {
    window.fetch = function() {
      const start = performance.now();
      const input = arguments[0];
      const init = arguments[1] || {};
      const method = init.method || "GET";
      return fetchFn.apply(this, arguments).then(response => {
        const duration = performance.now() - start;
        sendMetrics({
          session_id: rumIds.session_id,
          endpoint_id: rumIds.endpoint_id,
          url: window.location.href,
          timestamp: new Date().toISOString(),
          trigger: "api_call",
          api: {
            type: "fetch",
            method,
            endpoint: typeof input === "string" ? input : input.url,
            status: response.status,
            duration
          }
        });
        return response;
      }).catch(err => {
        const duration = performance.now() - start;
        sendMetrics({
          session_id: rumIds.session_id,
          endpoint_id: rumIds.endpoint_id,
          url: window.location.href,
          timestamp: new Date().toISOString(),
          trigger: "api_call_error",
          api: {
            type: "fetch",
            method,
            endpoint: typeof input === "string" ? input : input.url,
            status: null,
            duration,
            error: err.message
          }
        });
        throw err;
      });
    };
  })(window.fetch);

  // ---------------- Business Metrics (Custom) ----------------
  function logBusinessMetric(name, value, extra = {}) {
    sendMetrics({
      session_id: rumIds.session_id,
      endpoint_id: rumIds.endpoint_id,
      url: window.location.href,
      timestamp: new Date().toISOString(),
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
      session_id: rumIds.session_id,
      endpoint_id: rumIds.endpoint_id,
      url: window.location.href,
      timestamp: new Date().toISOString(),
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

  // ---------------- Heartbeat (real-time users) ----------------
  function sendHeartbeat() {
    sendMetrics({
      session_id: rumIds.session_id,
      endpoint_id: rumIds.endpoint_id,
      url: window.location.href,
      timestamp: new Date().toISOString(),
      trigger: "heartbeat",
      environment: collectEnvironmentMetrics()
    });
  }

  setInterval(sendHeartbeat, 15000); // every 15s
  window.addEventListener("load", sendHeartbeat);

})();
