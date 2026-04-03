// CCDEX - Claude Code Desktop Context Usage Indicator
// Injected into mainView.js preload script
// Monitors IPC events to display context window usage + rate limits

;(function() {
  const electron = require('electron');
  const ipcRenderer = electron.ipcRenderer;

  const IPC_CHANNEL = '$eipc_message$_ecf9b7a0-beb7-40a8-9885-aa723c019ace_$_claude.web_$_LocalSessions_$_onEvent';

  const MODEL_LIMITS = {
    'claude-4-opus': 200000,
    'claude-3-7-sonnet': 200000,
    'claude-3-5-haiku': 200000,
    'claude-3-opus': 200000,
    'claude-3-sonnet': 200000,
    'default': 200000
  };

  const sessions = new Map();
  const rateLimits = {
    fiveHour: { status: null, resetsAt: null, usedPct: null },
    weekly: { status: null, resetsAt: null, usedPct: null }
  };

  // Fetch usage data directly from claude.ai (same-origin)
  let lastUsageFetch = 0;

  function getOrgId() {
    const m = document.cookie.match(/lastActiveOrg=([^;]+)/);
    return m ? m[1] : null;
  }

  async function fetchUsageData() {
    const now = Date.now();
    if (now - lastUsageFetch < 30000) return; // throttle
    lastUsageFetch = now;
    try {
      const orgId = getOrgId();
      if (!orgId) return;
      const resp = await fetch(`/api/organizations/${orgId}/usage`);
      if (!resp.ok) return;
      const data = await resp.json();

      console.log('[CCDEX] Usage data:', JSON.stringify(data).slice(0, 500));

      // Format: { five_hour: { utilization: 0-100, resets_at: "..." }, seven_day: { ... } }
      if (data.five_hour) {
        rateLimits.fiveHour.usedPct = Math.round(data.five_hour.utilization);
        if (data.five_hour.resets_at) {
          rateLimits.fiveHour.resetsAt = new Date(data.five_hour.resets_at).getTime() / 1000;
        }
      }
      if (data.seven_day) {
        rateLimits.weekly.usedPct = Math.round(data.seven_day.utilization);
        if (data.seven_day.resets_at) {
          rateLimits.weekly.resetsAt = new Date(data.seven_day.resets_at).getTime() / 1000;
        }
      }
      updateRateLimit();
      if (indicatorEl) indicatorEl.classList.add('ccdex-visible');
    } catch (e) {
      // Network error or CORS — silent fail
    }
  }

  function getModelLimit(model) {
    if (!model) return MODEL_LIMITS.default;
    for (const [key, limit] of Object.entries(MODEL_LIMITS)) {
      if (model.includes(key)) return limit;
    }
    return MODEL_LIMITS.default;
  }

  function formatTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }

  function formatCountdown(resetsAt) {
    if (!resetsAt) return '';
    const diff = resetsAt - Date.now() / 1000;
    if (diff <= 0) return '';
    const mins = Math.floor(diff / 60);
    if (mins < 1) return '<1m';
    if (mins < 60) return mins + 'm';
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    if (hrs < 24) return rem > 0 ? hrs + 'h' + String(rem).padStart(2, '0') + 'm' : hrs + 'h';
    return Math.floor(hrs / 24) + 'd';
  }

  // --- UI ---

  let indicatorEl = null;
  let styleInjected = false;
  let observer = null;
  let countdownTimer = null;

  function injectStyles() {
    if (styleInjected) return;
    const style = document.createElement('style');
    style.textContent = `
      #ccdex-context-indicator {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        color: rgba(0, 0, 0, 0.36);
        opacity: 0;
        transition: opacity 0.3s;
        pointer-events: none;
      }
      #ccdex-context-indicator.ccdex-visible { opacity: 1; }
      .ccdex-bar-bg {
        width: 40px; height: 3px;
        border-radius: 1.5px; overflow: hidden;
        background: rgba(0, 0, 0, 0.08);
      }
      .ccdex-bar-fill {
        display: block;
        height: 100%; width: 0%;
        border-radius: 1.5px;
        transition: width 0.3s ease, background-color 0.3s ease;
      }
      .ccdex-sep { color: rgba(0, 0, 0, 0.15); }
      .ccdex-rl {
        display: inline-flex;
        align-items: center;
        gap: 3px;
      }
      .ccdex-rl-type { opacity: 0.5; }
      .ccdex-dot {
        width: 5px; height: 5px;
        border-radius: 50%;
        display: inline-block;
      }
      .ccdex-dot-ok { background: #34d399; }
      .ccdex-dot-bad { background: #f87171; }
    `;
    document.head.appendChild(style);
    styleInjected = true;
  }

  function el(attr) {
    return indicatorEl?.querySelector(`[data-c="${attr}"]`);
  }

  function createIndicator() {
    const d = document.createElement('div');
    d.id = 'ccdex-context-indicator';
    d.innerHTML = `
      <div class="ccdex-bar-bg"><div class="ccdex-bar-fill" data-c="ctx-fill"></div></div>
      <span data-c="ctx-label"></span>
      <span class="ccdex-sep" data-c="5h-sep" style="display:none">·</span>
      <span class="ccdex-rl" data-c="5h-rl" style="display:none">
        <span class="ccdex-rl-type">5h</span>
        <span class="ccdex-bar-bg" data-c="5h-bar" style="display:none"><span class="ccdex-bar-fill" data-c="5h-fill"></span></span>
        <span class="ccdex-dot" data-c="5h-dot"></span>
        <span data-c="5h-cd"></span>
      </span>
      <span class="ccdex-sep" data-c="wk-sep" style="display:none">·</span>
      <span class="ccdex-rl" data-c="wk-rl" style="display:none">
        <span class="ccdex-rl-type">Wk</span>
        <span class="ccdex-bar-bg" data-c="wk-bar" style="display:none"><span class="ccdex-bar-fill" data-c="wk-fill"></span></span>
        <span class="ccdex-dot" data-c="wk-dot"></span>
        <span data-c="wk-cd"></span>
      </span>
    `;
    return d;
  }

  function findFooterSpacer() {
    const f = document.getElementById('turn-form');
    if (!f) return null;
    const footer = f.parentElement?.nextElementSibling;
    if (!footer) return null;
    const row = footer.firstElementChild;
    if (!row) return null;
    for (const ch of row.children) {
      if (ch.classList.contains('flex-1')) return ch;
    }
    return null;
  }

  function tryInject() {
    if (indicatorEl && document.contains(indicatorEl)) return true;
    if (!document.body || !document.head) return false;
    injectStyles();
    const spacer = findFooterSpacer();
    if (!spacer) return false;
    indicatorEl = createIndicator();
    spacer.appendChild(indicatorEl);
    for (const [sid] of sessions) updateContext(sid);
    updateRateLimit();
    if (!countdownTimer) countdownTimer = setInterval(updateRateLimit, 30000);
    console.log('[CCDEX] Context indicator injected into footer bar');
    return true;
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(() => tryInject());
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // --- Display ---

  function pctColor(pct) {
    if (pct >= 80) return '#f87171';
    if (pct >= 50) return '#fbbf24';
    return '#34d399';
  }

  function updateContext(sid) {
    if (!indicatorEl || !document.contains(indicatorEl)) {
      indicatorEl = null;
      tryInject();
      if (!indicatorEl) return;
    }
    const s = sessions.get(sid);
    if (!s) return;
    const total = s.inputTokens + s.outputTokens;
    const limit = s.limit;
    const pct = Math.min((total / limit) * 100, 100);
    const fill = el('ctx-fill');
    const label = el('ctx-label');
    if (!fill || !label) return;
    fill.style.width = pct + '%';
    fill.style.background = pctColor(pct);
    label.textContent = formatTokens(total) + ' / ' + formatTokens(limit);
    indicatorEl.classList.add('ccdex-visible');
  }

  function updateRateSection(prefix, rl) {
    if (!indicatorEl) return;
    if (!rl.resetsAt && rl.usedPct === null) return;
    const sep = el(`${prefix}-sep`);
    const box = el(`${prefix}-rl`);
    const bar = el(`${prefix}-bar`);
    const fill = el(`${prefix}-fill`);
    const dot = el(`${prefix}-dot`);
    const cd = el(`${prefix}-cd`);
    if (!sep || !box) return;
    sep.style.display = '';
    box.style.display = '';

    if (rl.usedPct !== null && bar && fill) {
      // Have percentage — show bar
      bar.style.display = '';
      if (dot) dot.style.display = 'none';
      fill.style.width = rl.usedPct > 0 ? Math.max(rl.usedPct, 5) + '%' : '0%';
      fill.style.background = pctColor(rl.usedPct);
      if (cd) {
        const countdown = formatCountdown(rl.resetsAt);
        cd.textContent = rl.usedPct + '%' + (countdown ? ' ' + countdown : '');
      }
    } else {
      // No percentage — show dot + countdown
      if (bar) bar.style.display = 'none';
      if (dot) {
        dot.style.display = '';
        dot.className = 'ccdex-dot ' + (rl.status === 'allowed' ? 'ccdex-dot-ok' : 'ccdex-dot-bad');
      }
      if (cd) cd.textContent = formatCountdown(rl.resetsAt);
    }
  }

  function updateRateLimit() {
    updateRateSection('5h', rateLimits.fiveHour);
    updateRateSection('wk', rateLimits.weekly);
    if (indicatorEl) indicatorEl.classList.add('ccdex-visible');
  }

  // --- Events ---

  function handleEvent(event) {
    if (!event) return;

    if (event.type === 'message' && event.message) {
      const msg = event.message;
      const sid = event.sessionId;

      if (msg.type === 'rate_limit_event' && msg.rate_limit_info) {
        const info = msg.rate_limit_info;
        if (info.rateLimitType === 'five_hour') {
          rateLimits.fiveHour.status = info.status;
          rateLimits.fiveHour.resetsAt = info.resetsAt;
        } else if (info.rateLimitType === 'weekly' || info.rateLimitType === 'seven_day') {
          rateLimits.weekly.status = info.status;
          rateLimits.weekly.resetsAt = info.resetsAt;
        }
        updateRateLimit();
        fetchUsageData();
        return;
      }

      if (!sessions.has(sid)) {
        sessions.set(sid, { inputTokens: 0, outputTokens: 0, model: null, limit: MODEL_LIMITS.default });
      }
      const s = sessions.get(sid);

      if (msg.type === 'assistant' && msg.message) {
        const m = msg.message;
        if (m.model) { s.model = m.model; s.limit = getModelLimit(m.model); }
        if (m.usage) {
          s.inputTokens = m.usage.input_tokens || 0;
          s.inputTokens += (m.usage.cache_creation_input_tokens || 0);
          s.inputTokens += (m.usage.cache_read_input_tokens || 0);
          s.outputTokens = m.usage.output_tokens || 0;
          updateContext(sid);
        }
      }
    }

    if (event.type === 'session_updated' && event.session) {
      const sid = event.sessionId;
      if (!sessions.has(sid)) {
        sessions.set(sid, { inputTokens: 0, outputTokens: 0, model: event.session.model || null, limit: getModelLimit(event.session.model) });
      } else {
        const s = sessions.get(sid);
        if (event.session.model) { s.model = event.session.model; s.limit = getModelLimit(event.session.model); }
      }
    }

    if (event.type === 'stopped' || event.type === 'archived' || event.type === 'deleted') {
      sessions.delete(event.sessionId);
      if (indicatorEl) indicatorEl.classList.remove('ccdex-visible');
    }
  }

  // --- Init ---

  ipcRenderer.on(IPC_CHANNEL, (_event, data) => handleEvent(data));

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => { tryInject(); startObserver(); });
  } else {
    tryInject();
    startObserver();
  }

  // Fetch usage data on startup and periodically
  setTimeout(fetchUsageData, 3000);
  setInterval(fetchUsageData, 60000);

  console.log('[CCDEX] Context indicator loaded');
})();
