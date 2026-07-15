let currentPage = 'mission';
let agentRunning = false;
let agentStream = null;
let expandedHistory = {};
let allLogs = [];
let allSessions = [];
let activitySummary = {};
let activityView = 'sessions';
let allKV = [];
let kvSummary = {};
let selectedKVKey = null;
let logPage = 0;
const LOG_PAGE_SIZE = 50;
const SESSION_GAP_MS = 5 * 60 * 1000;
let allTools = [];
let toolCategories = []; // Will be fetched from API
let toolStats = {};
let allProcedures = [];
let toolStatsWindow = localStorage.getItem('sidekick_toolStatsWindow') || 'local';
let evolveExecutionStreams = {};
let allBlackboxIncidents = [];
let selectedBlackboxIncident = null;
let blackboxStream = null;

// Authentication helpers
function getAuthHeader() {
  return sessionStorage.getItem('sidekick_auth');
}

function clearAuth() {
  sessionStorage.removeItem('sidekick_auth');
}

function showAuthModal(onSuccess) {
  let modal = document.getElementById('auth-modal');
  if (!modal) {
    modal = document.createElement('dialog');
    modal.id = 'auth-modal';
    modal.innerHTML = `
      <form method="dialog" style="max-width: 300px; padding: 20px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; color: #c9d1d9;">
        <h3 style="margin-top: 0; color: #58a6ff;">Authentication Required</h3>
        <label style="display: block; margin: 10px 0 5px; font-size: .85rem;">Username:</label>
        <input type="text" id="auth-username" style="width: 100%; padding: 8px; margin-bottom: 10px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9;" required>
        <label style="display: block; margin: 10px 0 5px; font-size: .85rem;">Password:</label>
        <input type="password" id="auth-password" style="width: 100%; padding: 8px; margin-bottom: 15px; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9;" required>
        <div style="display: flex; gap: 10px; justify-content: flex-end;">
          <button type="button" id="auth-cancel" style="padding: 8px 16px; background: #21262d; border: 1px solid #30363d; color: #c9d1d9; border-radius: 4px; cursor: pointer;">Cancel</button>
          <button type="submit" id="auth-submit" style="padding: 8px 16px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer;">Login</button>
        </div>
      </form>
    `;
    document.body.appendChild(modal);

    document.getElementById('auth-cancel').addEventListener('click', () => {
      modal.close();
    });

    modal.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      const user = document.getElementById('auth-username').value;
      const pass = document.getElementById('auth-password').value;
      const auth = btoa(user + ':' + pass);
      sessionStorage.setItem('sidekick_auth', auth);
      modal.close();
      if (onSuccess) onSuccess();
    });
  }

  document.getElementById('auth-username').value = '';
  document.getElementById('auth-password').value = '';
  modal.showModal();
}

// Authenticated fetch wrapper - adds auth header and handles 401
function authFetch(url, options) {
  options = options || {};
  var headers = options.headers || {};
  var auth = getAuthHeader();
  if (auth) {
    headers['Authorization'] = 'Basic ' + auth;
  }
  options.headers = headers;
  if (!options.credentials) options.credentials = 'same-origin';

  return fetch(url, options).then(function(res) {
    if (res.status === 401) {
      clearAuth();
      showAuthModal(function() { location.reload(); });
      throw new Error('Authentication required');
    }
    return res;
  });
}

// Fetch tool categories from API
async function fetchToolCategories() {
  try {
    const res = await authFetch('/api/tool-categories');
    const data = await res.json();
    toolCategories = data.categories || [];
    populateToolCategoryFilter();
  } catch (error) {
    console.error('Failed to fetch tool categories:', error);
    toolCategories = [];
    populateToolCategoryFilter();
  }
}

function getToolCategory(toolName) {
  for (const cat of toolCategories) {
    if (cat.tools && cat.tools.some(t => t.name === toolName)) {
      return cat.name;
    }
  }
  return 'Other';
}

function populateToolCategoryFilter() {
  const select = $('toolCategoryFilter');
  if (!select) return;
  const currentValue = select.value;
  const options = ['<option value="">All Categories</option>'];
  for (const category of toolCategories) {
    options.push('<option value="' + esc(category.name) + '">' + esc(category.name) + '</option>');
  }
  select.innerHTML = options.join('');
  select.value = toolCategories.some(category => category.name === currentValue) ? currentValue : '';
}

function isHighRiskTool(tool) {
  return tool.risk === 'high' || tool.risk === 'critical';
}

function getToolStateLabel(tool) {
  if (tool.enabled === false) return 'Blocked';
  if (tool.approval_required) return 'Approval required';
  return 'Enabled';
}

function getRiskBadgeClass(risk) {
  if (risk === 'critical') return 'danger';
  if (risk === 'high') return 'warn';
  return '';
}

function updateToolSummary(tools) {
  $('toolSummaryVisible').textContent = tools.length;
  $('toolSummaryBlocked').textContent = tools.filter(tool => tool.enabled === false).length;
  $('toolSummaryApproval').textContent = tools.filter(tool => tool.approval_required).length;
  $('toolSummaryHighRisk').textContent = tools.filter(isHighRiskTool).length;
}

const SERVICE_ICONS = { 'sidekick-mcp': 'fa-server', 'sidekick-dashboard': 'fa-gauge-high', 'sidekick-agent': 'fa-robot', 'ollama': 'fa-brain' };
const SERVICE_LABELS = { 'sidekick-mcp': 'MCP', 'sidekick-dashboard': 'Dashboard', 'sidekick-agent': 'Agent', 'ollama': 'Ollama' };
const SOURCE_ICONS = { 'agent': 'fa-robot', 'mcp': 'fa-plug', 'unknown': 'fa-circle-question' };
const SOURCE_COLORS = { 'agent': '#58a6ff', 'mcp': '#bc8cff', 'unknown': '#8b949e' };

// Toast notification system
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

// Centralized error handler
function apiError(url, error, status) {
  const messages = {
    401: 'Authentication required — please refresh the page',
    429: 'Rate limited — please wait before refreshing',
    502: 'Backend service unavailable',
    503: 'Service temporarily unavailable',
  };
  
  const msg = messages[status] || `Request failed: ${error.message || 'Unknown error'}`;
  showToast(msg, status >= 500 ? 'error' : 'warning');
  
  // Log to server (fire-and-forget)
  fetch('/api/internal/error-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      timestamp: new Date().toISOString(),
      url,
      status,
      error: error.message || String(error),
      page: currentPage,
      userAgent: navigator.userAgent
    })
  }).catch(() => {}); // This one CAN silently fail
}

function $(id){return document.getElementById(id)}

function getToolStatsWindow() {
  const select = $('toolStatsWindow');
  if (select && select.value) return select.value;
  return toolStatsWindow || 'local';
}

function setToolStatsWindow(value) {
  toolStatsWindow = value === 'utc' ? 'utc' : 'local';
  localStorage.setItem('sidekick_toolStatsWindow', toolStatsWindow);
  const select = $('toolStatsWindow');
  if (select && select.value !== toolStatsWindow) select.value = toolStatsWindow;
  if (currentPage === 'system') loadDashboardSummary();
  if (currentPage === 'tools') loadTools();
}

function getToolStatsRange(windowMode) {
  const now = new Date();
  if (windowMode === 'utc') {
    return {
      since: new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0, 0, 0, 0
      )).toISOString(),
      until: new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0, 0, 0, 0
      )).toISOString()
    };
  }
  return {
    since: new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      0, 0, 0, 0
    ).toISOString(),
    until: new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      0, 0, 0, 0
    ).toISOString()
  };
}

function showPage(name){
  currentPage = name;
  localStorage.setItem('sidekick_currentPage', name);
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
  $('page-' + name).classList.add('active');
  $('nav-' + name).classList.add('active');
  loadSystem();
  if (name === 'mission') loadMissionControl();
  if (name === 'system') { loadDashboardSummary(); loadLLM(); loadServices(); }
  if (name === 'activity') loadLogs();
  if (name === 'blackbox') loadBlackbox();
  if (name === 'data') loadKV();
  if (name === 'memory') loadMemories();
  if (name === 'database') loadDbStats();
  if (name === 'config') loadConfig();
  if (name === 'approvals') loadApprovals();
  if (name === 'tools') loadTools();
  if (name === 'evolve') loadEvolve();
  if (name === 'metrics') loadGrafanaDashboard();
}

function loadGrafanaDashboard() {
  const dashboard = $('grafanaDashboard').value;
  const frame = $('grafanaFrame');
  loadMetricsStatus();
  frame.src = `/grafana/d/${dashboard}?orgId=1&kiosk`;
}

function loadMetricsStatus() {
  const el = $('metricsStatus');
  if (!el) return;
  authFetch('/api/metrics/status').then(r=>r.json()).then(d=>{
    const checks = [
      ['Grafana config', d.grafana && d.grafana.configured],
      ['Grafana reachable', d.grafana && d.grafana.reachable],
      ['InfluxDB config', d.influxdb && d.influxdb.configured],
      ['InfluxDB reachable', d.influxdb && d.influxdb.reachable],
      ['Metrics timer', d.collector && d.collector.timerActive]
    ];
    let html = '<div class="metrics-status-row">' + checks.map(([label, ok]) => '<span class="metrics-status-pill ' + (ok ? 'ok' : 'warn') + '">' + esc(label) + ': ' + (ok ? 'ok' : 'needs setup') + '</span>').join('') + '</div>';
    if (d.issues && d.issues.length) {
      html += '<div class="metrics-status-issues">' + d.issues.map(issue => '<div>' + esc(issue) + '</div>').join('') + '</div>';
    }
    el.innerHTML = html;
  }).catch(e=>{
    el.innerHTML = '<div class="quick-action-error">Metrics status unavailable: ' + esc(e.message || String(e)) + '</div>';
  });
}

function fmtTime(iso){
  const d = new Date(iso);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 || 12;
  return hour12 + ':' + m + ':' + s + '.' + ms + ' ' + ampm;
}

function fmtDate(iso){
  const d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
}

function esc(s){
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function attr(s){ return esc(String(s || '')).replace(/"/g, '&quot;') }
function jsArg(s){ return attr(JSON.stringify(String(s || ''))) }

function displayValue(value){
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function parseMaybeJson(text){
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed || !/^[{\[]/.test(trimmed)) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

function renderStructuredValue(value, opts){
  opts = opts || {};
  const text = displayValue(value);
  const parsed = typeof value === 'string' ? parseMaybeJson(value) : (typeof value === 'object' && value !== null ? value : null);
  const rendered = parsed !== null ? JSON.stringify(parsed, null, 2) : text;
  const cls = parsed !== null ? 'structured-json' : 'structured-text';
  const long = rendered.length > (opts.limit || 900);
  const visible = long && !opts.expanded ? rendered.slice(0, opts.limit || 900) + '\n... truncated, expand to view all ...' : rendered;
  return '<pre class="value-block ' + cls + (long ? ' is-long' : '') + '">' + esc(visible) + '</pre>';
}

function metric(label, value, detail){
  return '<div class="metric-card"><span>' + esc(label) + '</span><strong>' + esc(value == null ? '--' : value) + '</strong>' + (detail ? '<small>' + esc(detail) + '</small>' : '') + '</div>';
}

function formatMs(ms){
  if (!Number.isFinite(ms)) return '--';
  if (ms < 1000) return Math.round(ms) + 'ms';
  return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
}

// -- Services -- //
function loadServices(){
  authFetch('/api/services').then(r=>r.json()).then(d=>{
    const container = $('serviceDots');
    if (!d.services) { container.innerHTML = ''; return; }
    container.innerHTML = Object.entries(d.services).map(([name, status]) => {
      const icon = SERVICE_ICONS[name] || 'fa-circle';
      const label = SERVICE_LABELS[name] || name;
      const cls = status === 'active' ? 'on' : 'off';
      return '<span class="service-indicator ' + cls + '"><i class="fas ' + icon + '"></i> ' + label + '</span>';
    }).join('');
  }).catch(e => apiError('/api/services', e, 0));
}

// -- System -- //
function loadSystem(){
  return authFetch('/api/system').then(r=>r.json()).then(d=>{
    if(d.error){ $('s-uptime').textContent='error'; return }
    $('s-uptime').textContent = d.uptime || '?';
    const cpuVal = parseFloat(d.cpu);
    $('s-cpu').textContent = d.cpu;
    $('s-cpu').className = 's-val' + (cpuVal > 80 ? ' warn' : cpuVal > 50 ? '' : ' ok');
    $('s-memory').textContent = d.memory.used + '/' + d.memory.total;
    $('s-disk').textContent = d.disk.free + ' free (' + d.disk.pct + ')';
  }).catch(e => apiError('/api/system', e, 0));
}

function loadDashboardSummary(){
  const statsWindow = getToolStatsWindow();
  const statsRange = getToolStatsRange(statsWindow);
  const statsQuery = `?since=${encodeURIComponent(statsRange.since)}&until=${encodeURIComponent(statsRange.until)}`;
  // Fetch dashboard summary data
  authFetch('/api/dashboard-summary').then(r=>r.json()).then(d=>{
    if(d.error) return;
    
    // Health score
    const score = d.health.score;
    const scoreEl = $('healthScore');
    scoreEl.textContent = score;
    scoreEl.style.color = score >= 80 ? '#3fb950' : score >= 50 ? '#d29922' : '#f85149';
    $('healthCpu').textContent = Math.round(d.health.cpu);
    $('healthMem').textContent = Math.round(d.health.memory);
    $('healthDisk').textContent = Math.round(d.health.disk);
    
    // Storage
    $('storageKv').textContent = d.storage.kvCount;
    $('storageLogs').textContent = formatBytes(d.storage.logSize);
    $('storageConv').textContent = d.storage.convCount;
    
    // Active sessions
    $('sessionMcp').textContent = d.sessions.mcpClients;
    $('sessionAgent').textContent = d.sessions.agentStatus;
    $('sessionCron').textContent = d.sessions.cronJobs;
    $('sessionWatches').textContent = d.sessions.activeWatches;
    const sessionDetails = Array.isArray(d.sessions.mcpSessionDetails) ? d.sessions.mcpSessionDetails : [];
    const sessionDetailsEl = $('sessionDetails');
    if (sessionDetails.length === 0) {
      sessionDetailsEl.innerHTML = '<div class="empty" style="padding:2px 0">No MCP sessions</div>';
    } else {
      sessionDetailsEl.innerHTML = sessionDetails.slice(0, 4).map(s => {
        const label = s.initialized ? 'ready' : 'starting';
        return '<div class="session-detail"><span title="' + esc(s.id || '') + '">' + esc(shortSessionId(s.id)) + '</span><span>' + label + ', idle ' + formatDuration(s.idle) + '</span></div>';
      }).join('') + (sessionDetails.length > 4 ? '<div style="color:#484f58">+' + (sessionDetails.length - 4) + ' more</div>' : '');
    }
    
    // Recent errors
    const errorsEl = $('recentErrors');
    if(!d.recentErrors || d.recentErrors.length === 0){
      errorsEl.innerHTML = '<div class="empty" style="padding:4px 0">No recent errors</div>';
    } else {
      errorsEl.innerHTML = d.recentErrors.map(e => {
        const time = new Date(e.time).toLocaleTimeString();
        return '<div style="margin-bottom:4px"><span style="color:#8b949e">' + time + '</span> ' + esc(e.tool) + '<br><span style="color:#f85149;font-size:.72rem">' + esc(e.summary) + '</span></div>';
      }).join('');
    }
    
    // Recent deployments
    const deployEl = $('recentDeployments');
    if(!d.deployments || d.deployments.length === 0){
      deployEl.innerHTML = '<div class="empty" style="padding:4px 0">No deployment info</div>';
    } else {
      deployEl.innerHTML = d.deployments.map(dep => {
        const time = new Date(dep.deployed_at).toLocaleString();
        return '<div style="margin-bottom:4px"><span style="color:#58a6ff;font-family:var(--font)">' + esc(dep.commit) + '</span> <span style="color:#8b949e">(' + esc(dep.branch) + ')</span><br><span style="color:#8b949e;font-size:.72rem">' + time + '</span></div>';
      }).join('');
    }
  }).catch(e => apiError('/api/dashboard-summary', e, 0));
  
  // Fetch tool stats
  authFetch('/api/stats' + statsQuery).then(r=>r.json()).then(d=>{
    if(d.error || !d.stats) return;
    
    // Calculate totals
    let totalCalls = 0;
    let totalSuccess = 0;
    let totalTime = 0;
    
    d.stats.forEach(s => {
      totalCalls += s.count || 0;
      totalSuccess += s.ok || 0;
      totalTime += (s.avgMs || 0) * (s.count || 0);
    });
    
    const successRate = totalCalls > 0 ? Math.round((totalSuccess / totalCalls) * 100) : 0;
    const avgTime = totalCalls > 0 ? Math.round(totalTime / totalCalls) : 0;
    
    $('toolCalls').textContent = totalCalls;
    $('toolSuccess').textContent = successRate;
    $('toolAvg').textContent = avgTime;
    
    // Show top 5 tools
    const top5 = d.stats.slice(0, 5);
    if (top5.length > 0) {
      $('topTools').innerHTML = '<div style="color:#58a6ff;margin-bottom:4px">Top tools:</div>' + 
        top5.map(s => '<div style="display:flex;justify-content:space-between"><span style="color:#c9d1d9">' + esc(s.name.replace('sidekick_', '')) + '</span><span style="color:#8b949e">' + s.count + '</span></div>').join('');
    }
  }).catch(e => apiError('/api/stats', e, 0));
}

function loadMissionControl(){
  const statsRange = getToolStatsRange(getToolStatsWindow());
  const statsQuery = `?since=${encodeURIComponent(statsRange.since)}&until=${encodeURIComponent(statsRange.until)}`;
  const requests = [
    authFetch('/api/dashboard-summary').then(r=>r.json()),
    authFetch('/api/system').then(r=>r.json()),
    authFetch('/api/services').then(r=>r.json()),
    authFetch('/api/stats' + statsQuery).then(r=>r.json()),
    authFetch('/api/logs?limit=10').then(r=>r.json())
  ];

  Promise.all(requests).then(([summary, system, services, stats, logs]) => {
    const now = new Date();
    $('lastUpdate').textContent = 'updated ' + now.toLocaleTimeString();
    renderMissionReadiness(summary, services);
    renderMissionServices(services);
    renderMissionSystem(system, summary);
    renderMissionStats(stats);
    renderMissionActivity(logs);
    renderMissionAttention(summary, services, system, stats);
  }).catch(e => apiError('/api/mission-control', e, 0));
}

function renderMissionReadiness(summary, services){
  const serviceValues = Object.values((services && services.services) || {});
  const offlineCount = serviceValues.filter(status => status !== 'active').length;
  let score = summary && summary.health ? Number(summary.health.score) || 0 : 0;
  score = Math.max(0, score - offlineCount * 15);
  const scoreEl = $('missionScore');
  scoreEl.textContent = score;
  scoreEl.className = 'mission-score ' + (score >= 80 ? 'ok' : score >= 50 ? 'warn' : 'danger');
  $('missionScoreLabel').textContent = score >= 80 ? 'Systems nominal' : score >= 50 ? 'Needs attention' : 'Investigate now';
}

function renderMissionServices(data){
  const services = (data && data.services) || {};
  const names = Object.keys(services);
  const el = $('missionServices');
  if (!names.length) {
    el.innerHTML = '<div class="empty">No service data</div>';
    return;
  }
  el.innerHTML = names.map(name => {
    const active = services[name] === 'active';
    const icon = SERVICE_ICONS[name] || 'fa-circle';
    const label = SERVICE_LABELS[name] || name;
    return '<div class="mission-service ' + (active ? 'ok' : 'danger') + '"><span><i class="fas ' + icon + '"></i> ' + esc(label) + '</span><strong>' + esc(services[name]) + '</strong></div>';
  }).join('');
}

function renderMissionSystem(system, summary){
  if (!system || system.error) return;
  const cpu = summary && summary.health ? Math.round(summary.health.cpu) + '%' : system.cpu;
  const mem = system.memory ? system.memory.used + '/' + system.memory.total : '--';
  const disk = system.disk ? system.disk.free + ' free (' + system.disk.pct + ')' : '--';
  $('missionCpu').textContent = cpu;
  $('missionMemory').textContent = mem;
  $('missionDisk').textContent = disk;
  $('missionUptime').textContent = system.uptime || '--';
}

function renderMissionStats(data){
  const stats = (data && data.stats) || [];
  let totalCalls = 0;
  let totalSuccess = 0;
  for (const s of stats) {
    totalCalls += s.count || 0;
    totalSuccess += s.ok || 0;
  }
  $('missionToolCalls').textContent = totalCalls;
  $('missionToolSuccess').textContent = totalCalls ? Math.round(totalSuccess / totalCalls * 100) + '%' : '--';
  const top = stats.slice(0, 4);
  $('missionTopTools').innerHTML = top.length ? top.map(s =>
    '<div class="mission-list-row"><span>' + esc(s.name.replace('sidekick_', '')) + '</span><strong>' + s.count + '</strong></div>'
  ).join('') : '<div class="empty">No tool traffic yet</div>';
}

function renderMissionActivity(data){
  const entries = (data && data.entries) || [];
  $('missionRecentActivity').innerHTML = entries.length ? entries.slice(0, 6).map(e => {
    const ok = e.ok ? 'ok' : 'danger';
    const tool = e.tool || e.n || 'unknown';
    const time = e.timestamp || e.t;
    const detail = e.summary || e.result || e.error || e.args || e.s || e.a || '';
    return '<div class="mission-activity ' + ok + '"><div><strong>' + esc(tool) + '</strong><span>' + esc(time ? fmtTime(time) : '--') + '</span></div><p>' + esc(String(detail).slice(0, 100)) + '</p></div>';
  }).join('') : '<div class="empty">No recent activity</div>';
}

function renderMissionAttention(summary, services, system, stats){
  const items = [];
  const serviceEntries = Object.entries((services && services.services) || {});
  for (const [name, status] of serviceEntries) {
    if (status !== 'active') items.push({ level: 'danger', title: name + ' is ' + status, detail: 'Open System Health or service logs before running dependent work.' });
  }
  const health = summary && summary.health;
  if (health) {
    if (health.cpu > 80) items.push({ level: 'warn', title: 'CPU pressure: ' + Math.round(health.cpu) + '%', detail: 'Check active processes if this persists.' });
    if (health.memory > 80) items.push({ level: 'warn', title: 'Memory pressure: ' + Math.round(health.memory) + '%', detail: 'Agent and model workloads may slow down.' });
    if (health.disk > 80) items.push({ level: 'warn', title: 'Disk usage: ' + Math.round(health.disk) + '%', detail: 'Review backups, logs, and media before deploys.' });
  }
  const failures = ((stats && stats.stats) || []).reduce((sum, s) => sum + (s.fail || 0), 0);
  if (failures > 0) items.push({ level: 'warn', title: failures + ' failed tool call' + (failures === 1 ? '' : 's') + ' today', detail: 'Open Activity Log for recent failures and outputs.' });
  const recentErrors = (summary && summary.recentErrors) || [];
  for (const err of recentErrors.slice(0, 2)) {
    items.push({ level: 'danger', title: err.tool || 'Recent error', detail: err.summary || 'Tool call failed.' });
  }
  if (!system || system.error) items.push({ level: 'danger', title: 'System API unreachable', detail: 'The dashboard could not read system status.' });

  $('missionAttention').innerHTML = items.length ? items.slice(0, 5).map(item =>
    '<div class="mission-attention ' + item.level + '"><div><strong>' + esc(item.title) + '</strong><p>' + esc(item.detail) + '</p></div></div>'
  ).join('') : '<div class="mission-attention ok"><div><strong>No immediate action</strong><p>Services are online, resources look healthy, and no recent failures need attention.</p></div></div>';
}

function runQuickAction(action, payload){
  const resultEl = $('quickActionResult');
  resultEl.innerHTML = '<div class="empty">Running ' + esc(action.replace(/-/g, ' ')) + '...</div>';
  authFetch('/api/quick-actions/' + encodeURIComponent(action), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  }).then(r=>r.json()).then(d=>{
    if (!d.ok) {
      resultEl.innerHTML = '<div class="quick-action-error">' + esc(d.error || 'Action failed') + '</div>';
      return;
    }
    resultEl.innerHTML = renderQuickActionResult(action, d.result || {});
    if (action === 'restart-agent' || action === 'health-check') loadMissionControl();
  }).catch(e=>{
    resultEl.innerHTML = '<div class="quick-action-error">' + esc(e.message || String(e)) + '</div>';
    apiError('/api/quick-actions/' + action, e, 0);
  });
}

function renderQuickActionResult(action, result){
  if (action === 'health-check') {
    const services = Object.entries(result.services || {}).map(([name, status]) =>
      '<div class="mission-list-row"><span>' + esc(name) + '</span><strong>' + esc(status) + '</strong></div>'
    ).join('');
    return '<div class="quick-action-title">Health Check</div><div class="quick-action-grid"><div><span>Uptime</span><strong>' + esc(result.uptime || '--') + '</strong></div><div><span>Load</span><strong>' + esc(result.load || '--') + '</strong></div><div><span>Memory</span><strong>' + esc(result.memory || '--') + '</strong></div><div><span>Disk</span><strong>' + esc(result.disk || '--') + '</strong></div></div><div class="mission-list compact">' + services + '</div>';
  }
  if (action === 'recent-failures') {
    const failures = result.failures || [];
    if (!failures.length) return '<div class="quick-action-title">Recent Failures</div><div class="mission-attention ok"><div><strong>No recent failures</strong><p>The last scanned tool logs are clean.</p></div></div>';
    return '<div class="quick-action-title">Recent Failures</div>' + failures.map(f => '<div class="mission-activity danger"><div><strong>' + esc(f.tool || 'unknown') + '</strong><span>' + esc(fmtDate(f.time)) + '</span></div><p>' + esc(f.summary || 'No summary') + '</p></div>').join('');
  }
  if (action === 'deployment') {
    return '<div class="quick-action-title">Deployment</div><div class="quick-action-grid"><div><span>Branch</span><strong>' + esc(result.branch || '--') + '</strong></div><div><span>Commit</span><strong>' + esc(String(result.commit || '--').slice(0, 12)) + '</strong></div><div><span>Deployed</span><strong>' + esc(result.deployedAt || '--') + '</strong></div><div><span>Remote</span><strong>' + esc(result.remote || '--') + '</strong></div></div>';
  }
  if (action === 'service-logs') {
    return '<div class="quick-action-title">' + esc(result.service || 'Service') + ' Logs</div><pre class="quick-action-pre">' + esc(result.logs || 'No logs') + '</pre>';
  }
  if (action === 'restart-agent') {
    const ok = result.status === 'active';
    return '<div class="quick-action-title">Restart Agent</div><div class="mission-attention ' + (ok ? 'ok' : 'danger') + '"><div><strong>sidekick-agent is ' + esc(result.status || 'unknown') + '</strong><p>Restart command completed.</p></div></div>';
  }
  return '<pre class="quick-action-pre">' + esc(JSON.stringify(result, null, 2)) + '</pre>';
}

function formatBytes(bytes){
  if(bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 10) / 10 + ' ' + sizes[i];
}

function shortSessionId(id) {
  if (!id) return 'unknown';
  const s = String(id);
  return s.length > 18 ? s.slice(0, 15) + '...' : s;
}

function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '?';
  const sec = Math.floor(n / 1000);
  if (sec < 60) return sec + 's';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h';
  return Math.floor(hr / 24) + 'd';
}

function loadLLM(){
  authFetch('/api/llm').then(r=>r.json()).then(d=>{
    const el = $('llmStatus');
    if (d.status === "unreachable") {
      el.innerHTML = '<div class="llm-card"><span class="llm-dot off"></span><span class="empty">Ollama not reachable</span></div>';
      return;
    }
    if (d.status === "no_models") {
      el.innerHTML = '<div class="llm-card"><span class="llm-dot warn"></span><span class="empty">Ollama running, no models installed</span></div>';
      return;
    }
    el.innerHTML = (d.models || []).map(m =>
      '<div class="llm-card"><span class="llm-dot on"></span><span class="llm-name">' + esc(m.name) + '</span><span class="llm-size">' + m.size + '</span></div>'
    ).join('');
  }).catch(e => apiError('/api/llm', e, 0));
}

// -- Activity -- //
function loadLogs(){
  const container = $('logList');
  if (container) container.innerHTML = '<div class="empty">Loading activity...</div>';
  const qs = new URLSearchParams({ limit: '250' });
  const search = $('logSearch') ? $('logSearch').value.trim() : '';
  const source = $('logSourceFilter') ? $('logSourceFilter').value : '';
  const status = $('logStatusFilter') ? $('logStatusFilter').value : '';
  const tool = $('logToolFilter') ? $('logToolFilter').value.trim() : '';
  const project = $('logProjectFilter') ? $('logProjectFilter').value.trim() : '';
  const session = $('logSessionFilter') ? $('logSessionFilter').value.trim() : '';
  const minDuration = $('logMinDurationFilter') ? $('logMinDurationFilter').value : '';
  const errorsOnly = $('logErrorsOnly') ? $('logErrorsOnly').checked : false;
  if (search) qs.set('search', search);
  if (source) qs.set('source', source);
  if (status) qs.set('status', status);
  if (tool) qs.set('tool', tool);
  if (project) qs.set('project', project);
  if (session) qs.set('session', session);
  if (minDuration) qs.set('min_duration', minDuration);
  if (errorsOnly) qs.set('errors_only', 'true');
  authFetch('/api/logs?' + qs.toString()).then(r=>r.json()).then(d=>{
    allLogs = d.entries || [];
    allSessions = d.sessions || [];
    activitySummary = d.summary || {};
    logPage = 0;
    renderLogs();
  }).catch(e => {
    if (container) container.innerHTML = '<div class="quick-action-error">Activity unavailable: ' + esc(e.message || String(e)) + '</div>';
    apiError('/api/logs', e, 0);
  });
}

function filterLogs(){
  loadLogs();
}

function setActivityView(view){
  activityView = view === 'raw' ? 'raw' : 'sessions';
  $('activityViewSessions').classList.toggle('active', activityView === 'sessions');
  $('activityViewRaw').classList.toggle('active', activityView === 'raw');
  $('activityViewSessions').setAttribute('aria-selected', activityView === 'sessions' ? 'true' : 'false');
  $('activityViewRaw').setAttribute('aria-selected', activityView === 'raw' ? 'true' : 'false');
  renderLogs();
}

function renderActivitySummary(){
  const topTools = (activitySummary.most_used_tools || []).slice(0, 3).map(t => t.tool + ' ×' + t.count).join(', ');
  $('activitySummary').innerHTML = [
    metric('Sessions', activitySummary.sessions || 0),
    metric('Calls', activitySummary.total_calls || 0),
    metric('Success rate', (activitySummary.success_rate || 0) + '%'),
    metric('Failures', activitySummary.failures || 0),
    metric('Median duration', formatMs(activitySummary.median_duration_ms)),
    metric('Top tools', topTools || 'none')
  ].join('');
}

function statusBadge(ok){ return '<span class="log-status ' + (ok ? 'ok' : 'fail') + '">' + (ok ? 'SUCCESS' : 'FAILED') + '</span>'; }

function renderLogDetail(e){
  return '<article class="log-entry' + (e.ok ? '' : ' error') + '">' +
    '<div class="log-header"><span class="log-time">' + esc(fmtTime(e.timestamp)) + '</span><span class="log-tool">' + esc(e.tool) + '</span>' + statusBadge(e.ok) + '</div>' +
    '<div class="meta-line">' +
      '<span>Source: ' + esc(e.source || 'unknown') + '</span>' +
      (e.project ? '<span>Project: ' + esc(e.project) + '</span>' : '') +
      (e.session_id ? '<span>Session: <code>' + esc(e.session_id) + '</code></span>' : '') +
      (e.task_id ? '<span>Task: <code>' + esc(e.task_id) + '</code></span>' : '') +
      (e.execution_id ? '<span>Generated execution: <code>' + esc(e.execution_id) + '</code></span>' : '') +
      (e.generated_activity ? '<span class="badge">generated-tool activity</span>' : '') +
      (Number.isFinite(e.duration_ms) ? '<span>Duration: ' + formatMs(e.duration_ms) + '</span>' : '') +
    '</div>' +
    (e.args ? '<details class="detail-block"><summary>Arguments</summary>' + renderStructuredValue(e.args) + '</details>' : '') +
    (e.result ? '<details class="detail-block"><summary>Result or output</summary>' + renderStructuredValue(e.result) + '</details>' : '') +
    (e.error ? '<details class="detail-block" open><summary>Error details</summary>' + renderStructuredValue(e.error) + '</details>' : '') +
  '</article>';
}

function renderLogs(){
  $('logCount').textContent = allLogs.length;
  renderActivitySummary();
  const container = $('logList');
  if (!allLogs.length) {
    container.innerHTML = '<div class="empty">No matching activity. Activity contains tool calls from MCP, agent, dashboard, and automation sources; adjust filters or run a task to populate it.</div>';
    return; 
  }
  if (activityView === 'raw') {
    container.innerHTML = allLogs.map(renderLogDetail).join('');
    return;
  }
  if (!allSessions.length) {
    container.innerHTML = '<div class="empty">Session grouping returned no sessions, showing raw calls instead.</div>' + allLogs.map(renderLogDetail).join('');
    return;
  }
  const visibleSessions = allSessions.slice(0, (logPage + 1) * 25);
  let html = '';
  visibleSessions.forEach((session, si) => {
    const src = session.source || 'unknown';
    const icon = SOURCE_ICONS[src] || SOURCE_ICONS['unknown'];
    const color = SOURCE_COLORS[src] || SOURCE_COLORS['unknown'];
    const timeRange = fmtDate(session.start_time) + (session.end_time && session.end_time !== session.start_time ? ' - ' + fmtTime(session.end_time) : '');
    const tools = (session.tools || []).slice(0, 6).join(', ');
    const title = session.summary || tools || (session.call_count + ' activity calls');
    const subtitle = [timeRange, session.project ? 'project ' + session.project : '', session.grouping === 'time_source_fallback' ? 'fallback grouping' : session.grouping].filter(Boolean).join(' · ');
    html += '<section class="session-group">';
    html += '<button class="session-header" aria-expanded="false" type="button">';
    html += '<i class="fas ' + icon + '" style="color:' + color + '"></i>';
    html += '<span class="session-main"><strong>' + esc(session.grouping === 'generated_execution' ? 'generated-tool activity' : src + ' activity') + '</strong><small>Click to expand timeline</small></span>';
    html += '<span class="session-count">' + session.call_count + ' calls</span>';
    html += statusBadge(session.failure_count === 0);
    html += '</button>';
    html += '<div class="session-visible-summary"><strong>' + esc(title) + '</strong><p>' + esc(subtitle) + '</p></div>';
    html += '<div class="session-meta"><span>' + esc(src) + '</span>' + (session.project ? '<span>' + esc(session.project) + '</span>' : '') + '<span>' + esc(session.grouping === 'time_source_fallback' ? 'fallback grouping' : session.grouping) + '</span><span>' + esc(tools || 'no tools') + '</span><span>' + session.success_count + ' ok / ' + session.failure_count + ' failed</span><span>' + formatMs(session.duration_ms) + '</span></div>';
    html += '<div class="session-body" id="session-' + si + '">' + (session.entries || []).map(renderLogDetail).join('') + '</div></section>';
  });
  if (visibleSessions.length < allSessions.length) {
    html += '<button class="load-more" onclick="loadMoreLogs()">Show more sessions (' + (allSessions.length - visibleSessions.length) + ' remaining)</button>';
  }
  container.innerHTML = html;
  container.querySelectorAll('.session-header').forEach((el, idx) => {
    el.addEventListener('click', function() {
      const panel = this.parentElement.querySelector('.session-body');
      if (panel) {
        panel.classList.toggle('open');
        this.setAttribute('aria-expanded', panel.classList.contains('open') ? 'true' : 'false');
      }
    });
  });
}

function toggleResult(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.toggle('expanded');
  }
}

function loadMoreLogs(){
  logPage++;
  renderLogs();
}

// -- Data -- //
function loadKV(){
  authFetch('/api/kv').then(r=>r.json()).then(kvData => {
    allKV = kvData.entries || [];
    kvSummary = kvData.summary || {};
    
    const select = $('kvProjectFilter');
    if (select) {
      const currentVal = select.value;
      const projects = kvData.projects || [];
      select.innerHTML = '<option value="">All Projects</option>' +
        '<option value="null">Global</option>' + projects.map(p => '<option value="' + esc(p) + '">' + esc(p) + '</option>').join('');
      select.value = currentVal;
    }
    const nsSelect = $('kvNamespaceFilter');
    if (nsSelect) {
      const currentVal = nsSelect.value;
      const namespaces = kvData.namespaces || [];
      nsSelect.innerHTML = '<option value="">All Namespaces</option>' + namespaces.map(ns => '<option value="' + esc(ns) + '">' + esc(ns) + '</option>').join('');
      nsSelect.value = currentVal;
    }
    
    renderKV();
  }).catch(e => apiError('/api/kv', e, 0));
}

function filterKV(){
  renderKV();
}

function renderKV(){
  const search = ($('kvSearch').value || '').toLowerCase();
  const projectFilter = $('kvProjectFilter') ? $('kvProjectFilter').value : '';
  const namespaceFilter = $('kvNamespaceFilter') ? $('kvNamespaceFilter').value : '';
  const typeFilter = $('kvTypeFilter') ? $('kvTypeFilter').value : '';
  const ageFilter = $('kvAgeFilter') ? $('kvAgeFilter').value : 'all';
  
  let filtered = allKV.filter(e => {
    if (projectFilter) {
      if (projectFilter === 'null' && e.project !== null) return false;
      if (projectFilter !== 'null' && e.project !== projectFilter) return false;
    }
    if (namespaceFilter && e.namespace !== namespaceFilter) return false;
    if (typeFilter && e.data_type !== typeFilter) return false;
    if (ageFilter !== 'all') {
      const updated = new Date(e.updated);
      const now = new Date();
      const diffMs = now - updated;
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      
      if (ageFilter === 'today' && diffDays > 1) return false;
      if (ageFilter === 'week' && diffDays > 7) return false;
      if (ageFilter === 'month' && diffDays > 30) return false;
    }
    if (!search) return true;
    return [e.key, e.value_text, e.preview, e.namespace, e.project, e.source, e.data_type].join(' ').toLowerCase().includes(search);
  });
  
  filtered.sort((a, b) => new Date(b.updated) - new Date(a.updated));
  $('kvCount').textContent = filtered.length;
  $('kvSummary').innerHTML = [
    metric('Entries', kvSummary.total_entries || allKV.length),
    metric('Projects', kvSummary.projects || 0),
    metric('Stored size', formatBytes(kvSummary.total_size || 0)),
    metric('Changed 24h', kvSummary.recently_changed || 0),
    metric('Namespaces', kvSummary.namespaces || 0)
  ].join('');
  
  const list = $('kvList');
  if (!filtered.length) { 
    list.innerHTML = '<div class="empty">No matching data. Data contains Sidekick KV entries such as project handoffs, server facts, config summaries, cache records, and task state.</div>';
    renderKVInspector(null);
    return; 
  }
  if (!selectedKVKey || !filtered.some(e => e.key === selectedKVKey)) selectedKVKey = filtered[0].key;
  list.innerHTML = filtered.map(e => renderKVRow(e)).join('');
  list.querySelectorAll('.kv-row').forEach(row => {
    row.addEventListener('click', () => selectKV(row.dataset.key));
    row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectKV(row.dataset.key); } });
  });
  renderKVInspector(allKV.find(e => e.key === selectedKVKey));
}

function renderKVRow(e){
  return '<button type="button" class="kv-row' + (e.key === selectedKVKey ? ' selected' : '') + '" data-key="' + attr(e.key) + '">' +
    '<span class="kv-row-main"><strong>' + esc(e.key) + '</strong><small>' + esc(e.preview || '(empty)') + '</small></span>' +
    '<span class="kv-row-meta"><span>' + esc(e.namespace || 'global') + '</span><span>' + esc(e.project || 'global') + '</span><span>' + esc(e.data_type) + '</span><span>' + formatBytes(e.size || 0) + '</span></span>' +
  '</button>';
}

function selectKV(key){
  selectedKVKey = key;
  renderKV();
}

function renderKVInspector(entry){
  const el = $('kvInspector');
  if (!entry) { el.innerHTML = '<div class="empty">Select an entry to inspect its value, metadata, and safe actions.</div>'; return; }
  const valueText = displayValue(entry.value);
  const looksMarkdown = typeof entry.value === 'string' && /(^#\s|\n#{1,6}\s|\n[-*]\s|```)/m.test(entry.value);
  el.innerHTML = '<div class="inspector-head"><div><div class="section-title">Inspector</div><h3>' + esc(entry.key) + '</h3></div><div class="kv-actions"><button onclick="copyText(' + jsArg(entry.key) + ')">Copy key</button><button onclick="copySelectedKVValue()">Copy value</button><button onclick="openEditModal(' + jsArg(entry.key) + ')">Edit</button><button class="del" onclick="deleteKV(' + jsArg(entry.key) + ')">Delete</button></div></div>' +
    '<div class="meta-grid"><div><span>Namespace</span><strong>' + esc(entry.namespace || 'global') + '</strong></div><div><span>Project</span><strong>' + esc(entry.project || 'global') + '</strong></div><div><span>Source</span><strong>' + esc(entry.source || 'unknown') + '</strong></div><div><span>Type</span><strong>' + esc(entry.data_type) + '</strong></div><div><span>Size</span><strong>' + formatBytes(entry.size || 0) + '</strong></div><div><span>Updated</span><strong>' + esc(entry.updated ? formatTimeAgo(entry.updated) : 'unknown') + '</strong></div></div>' +
    (looksMarkdown ? '<details class="detail-block"><summary>Markdown text</summary>' + renderMarkdownPreview(entry.value) + '</details>' : '') +
    '<details class="detail-block" open><summary>Structured value</summary>' + renderStructuredValue(entry.value, { limit: 4000, expanded: valueText.length < 4000 }) + '</details>' +
    '<details class="detail-block"><summary>Raw metadata</summary>' + renderStructuredValue({ key: entry.key, project: entry.project, source: entry.source, namespace: entry.namespace, created: entry.created, updated: entry.updated, size: entry.size, data_type: entry.data_type }, { expanded: true }) + '</details>';
}

function renderMarkdownPreview(text){
  return '<div class="markdown-preview">' + esc(text).replace(/^### (.*)$/gm, '<strong>$1</strong>').replace(/^## (.*)$/gm, '<strong>$1</strong>').replace(/^# (.*)$/gm, '<strong>$1</strong>').replace(/\n/g, '<br>') + '</div>';
}

function copyText(text){ navigator.clipboard.writeText(text).then(() => showToast('Copied', 'success')).catch(() => showToast('Copy failed', 'error')); }
function copySelectedKVValue(){ const entry = allKV.find(e => e.key === selectedKVKey); if (entry) copyText(displayValue(entry.value)); }

function toggleProjectSection(projectId) {
  const entries = document.getElementById(projectId + '-entries');
  const toggle = document.getElementById(projectId + '-toggle');
  
  if (entries.style.display === 'none') {
    entries.style.display = 'block';
    toggle.classList.add('fa-chevron-down');
    toggle.classList.remove('fa-chevron-right');
  } else {
    entries.style.display = 'none';
    toggle.classList.remove('fa-chevron-down');
    toggle.classList.add('fa-chevron-right');
  }
}

function formatTimeAgo(dateStr) {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now - date;
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  
  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return diffMins + 'm ago';
  if (diffHours < 24) return diffHours + 'h ago';
  if (diffDays < 7) return diffDays + 'd ago';
  if (diffDays < 30) return Math.floor(diffDays / 7) + 'w ago';
  if (diffDays < 365) return Math.floor(diffDays / 30) + 'mo ago';
  return Math.floor(diffDays / 365) + 'y ago';
}

function showValueModal(key) {
  const entry = allKV.find(e => e.key === key);
  if (!entry) return;
  
  const modal = document.createElement('div');
  modal.className = 'kv-modal';
  modal.onclick = function(e) {
    if (e.target === modal) modal.remove();
  };
  
  let valueHtml = '';
  let parsed = null;
  try {
    parsed = JSON.parse(entry.value);
  } catch {}
  
  if (parsed !== null && typeof parsed === 'object') {
    valueHtml = '<div class="json-tree">' + renderJsonTree(parsed, 0) + '</div>';
  } else {
    valueHtml = '<div class="kv-modal-value">' + esc(String(entry.value)) + '</div>';
    valueHtml += '<button class="btn btn-sm btn-outline" style="margin-top:8px" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent);showToast(&quot;Copied!&quot;,&quot;success&quot;)"><i class="fas fa-copy"></i> Copy</button>';
  }
  
  modal.innerHTML = '<div class="kv-modal-content">' +
    '<div class="kv-modal-header">' +
      '<h3>' + esc(key) + '</h3>' +
      '<button class="kv-modal-close" style="background:none;border:none;color:#8b949e;cursor:pointer;font-size:20px;">' +
        '<i class="fas fa-times"></i>' +
      '</button>' +
    '</div>' +
    valueHtml +
  '</div>';
  
  modal.querySelector('.kv-modal-close').addEventListener('click', () => modal.remove());
  document.body.appendChild(modal);
}

function renderJsonTree(obj, depth) {
  if (obj === null) return '<span style="color:#f85149">null</span>';
  if (typeof obj === 'boolean') return '<span style="color:#ffa657">' + obj + '</span>';
  if (typeof obj === 'number') return '<span style="color:#79c0ff">' + obj + '</span>';
  if (typeof obj === 'string') return '<span style="color:#a5d6ff">"' + esc(obj) + '"</span>';
  
  const isArray = Array.isArray(obj);
  const entries = isArray ? obj : Object.entries(obj);
  const indent = '  '.repeat(depth);
  const nextIndent = '  '.repeat(depth + 1);
  
  if (entries.length === 0) return isArray ? '[]' : '{}';
  
  let html = '<span style="color:#8b949e">' + (isArray ? '[' : '{') + '</span>';
  html += '<div style="padding-left:20px">';
  
  const items = isArray ? entries.map((v, i) => [i, v]) : entries;
  for (const [k, v] of items) {
    const keyStr = isArray ? '' : '<span style="color:#7ee787">"' + esc(k) + '"</span>: ';
    const valueStr = renderJsonTree(v, depth + 1);
    html += '<div>' + keyStr + valueStr + '</div>';
  }
  
  html += '</div>';
  html += '<span style="color:#8b949e">' + (isArray ? ']' : '}') + '</span>';
  return html;
}

function openEditModal(key){
  const entry = allKV.find(e => e.key === key);
  if (!entry) return;
  $('editKey').textContent = key;
  $('editValue').value = displayValue(entry.value);
  $('editProject').value = entry.project || '';
  $('editModal').classList.add('active');
  $('editModal').dataset.key = key;
}

function closeEditModal(){
  $('editModal').classList.remove('active');
}

function saveKVEdit(){
  const key = $('editModal').dataset.key;
  const value = $('editValue').value;
  const project = $('editProject').value || null;
  authFetch('/api/kv/' + encodeURIComponent(key), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value, project })
  }).then(r => r.json()).then(d => {
    if (d.ok) { closeEditModal(); loadKV(); showToast('Entry updated successfully', 'success'); }
  }).catch(e => apiError('/api/kv/' + encodeURIComponent(key), e, 0));
}

function deleteKV(key){
  const entry = allKV.find(e => e.key === key);
  const valuePreview = entry ? displayValue(entry.value).substring(0, 50) : '';
  const project = entry?.project || 'Global';
  
  showConfirmModal({
    title: 'Delete KV Entry',
    message: `Are you sure you want to delete this entry?`,
    details: `<strong>Key:</strong> ${esc(key)}<br><strong>Project:</strong> ${esc(project)}<br><strong>Value:</strong> ${esc(valuePreview)}${valuePreview.length >= 50 ? '...' : ''}`,
    tier: 3,
    action: () => {
      authFetch('/api/kv/' + encodeURIComponent(key), { 
        method: 'DELETE'
      })
        .then(r => r.json()).then(d => { 
          if (d.ok) { 
            loadKV(); 
            showToast('Entry deleted successfully', 'success'); 
          } 
        }).catch(e => apiError('/api/kv/' + encodeURIComponent(key), e, 0));
    }
  });
}

// Confirmation Modal System
let confirmAction = null;
let confirmRequiredText = '';

function showConfirmModal(options) {
  const { title, message, details, tier, action, requiredText } = options;
  
  $('confirmTitle').textContent = title;
  $('confirmMessage').textContent = message;
  $('confirmDetails').innerHTML = details;
  
  confirmAction = action;
  $('confirmButton').disabled = true;
  
  if (tier === 1) {
    // Nuclear operation - require typing
    $('confirmTypingSection').style.display = 'block';
    confirmRequiredText = requiredText;
    $('confirmRequiredText').textContent = requiredText;
    $('confirmInput').value = '';
  } else {
    // Tier 2 or 3 - no typing required
    $('confirmTypingSection').style.display = 'none';
    $('confirmButton').disabled = false;
  }
  
  $('confirmModal').classList.add('active');
}

function checkConfirmInput() {
  const input = $('confirmInput').value;
  $('confirmButton').disabled = (input !== confirmRequiredText);
}

function closeConfirmModal() {
  $('confirmModal').classList.remove('active');
  confirmAction = null;
  confirmRequiredText = '';
}

function executeConfirmAction() {
  if (confirmAction) {
    confirmAction();
    closeConfirmModal();
  }
}

// New Entry Modal Functions
function showNewEntryModal() {
  $('newEntryKey').value = '';
  $('newEntryProject').value = '';
  $('newEntryValue').value = '';
  $('newEntryModal').classList.add('active');
}

function closeNewEntryModal() {
  $('newEntryModal').classList.remove('active');
}

function saveNewEntry() {
  const key = $('newEntryKey').value.trim();
  const project = $('newEntryProject').value.trim() || null;
  const value = $('newEntryValue').value;
  
  if (!key) {
    showToast('Key is required', 'error');
    return;
  }
  
  if (!value) {
    showToast('Value is required', 'error');
    return;
  }
  
  // Check if key already exists
  const existing = allKV.find(e => e.key === key);
  if (existing) {
    showConfirmModal({
      title: 'Key Already Exists',
      message: `The key "${key}" already exists. Do you want to overwrite it?`,
      details: `<strong>Existing project:</strong> ${existing.project || 'Global'}<br><strong>Existing value:</strong> ${esc(String(existing.value).substring(0, 100))}${String(existing.value).length > 100 ? '...' : ''}`,
      tier: 3,
      action: () => {
        createKVEntry(key, value, project);
      }
    });
  } else {
    createKVEntry(key, value, project);
  }
}

function createKVEntry(key, value, project) {
  authFetch('/api/kv/' + encodeURIComponent(key), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value, project })
  }).then(r => r.json()).then(d => {
    if (d.ok) {
      closeNewEntryModal();
      loadKV();
      showToast('Entry created successfully', 'success');
    } else {
      showToast('Failed to create entry: ' + (d.error || 'Unknown error'), 'error');
    }
  }).catch(e => {
    apiError('/api/kv/' + encodeURIComponent(key), e, 0);
    showToast('Failed to create entry', 'error');
  });
}

function exportKV() {
  if (allKV.length === 0) {
    showToast('No data to export', 'warning');
    return;
  }
  
  const exportData = {
    exported_at: new Date().toISOString(),
    version: '1.0',
    entries: allKV.map(e => ({
      key: e.key,
      value: e.value,
      project: e.project,
      source: e.source,
      created: e.created,
      updated: e.updated
    }))
  };
  
  const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sidekick-kv-export-' + new Date().toISOString().split('T')[0] + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  
  showToast('Exported ' + allKV.length + ' entries', 'success');
}

function importKV() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const data = JSON.parse(event.target.result);
        
        if (!data.entries || !Array.isArray(data.entries)) {
          showToast('Invalid export file format', 'error');
          return;
        }
        
        // Show confirmation modal
        showConfirmModal({
          title: 'Import KV Data',
          message: `Import ${data.entries.length} entries from ${file.name}?`,
          details: `<strong>Exported at:</strong> ${data.exported_at || 'Unknown'}<br><strong>Version:</strong> ${data.version || 'Unknown'}<br><strong>Entries:</strong> ${data.entries.length}<br><br><span style="color:#f85149">⚠️ This will overwrite existing entries with the same keys!</span>`,
          tier: 1,
          requiredText: 'IMPORT',
          action: () => {
            // Import entries
            let imported = 0;
            let errors = 0;
            
            const importPromises = data.entries.map(entry => {
              return authFetch('/api/kv/' + encodeURIComponent(entry.key), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  value: entry.value,
                  project: entry.project
                })
              }).then(r => r.json()).then(d => {
                if (d.ok) {
                  imported++;
                } else {
                  errors++;
                }
              }).catch(() => {
                errors++;
              });
            });
            
            Promise.all(importPromises).then(() => {
              loadKV();
              if (errors === 0) {
                showToast('Successfully imported ' + imported + ' entries', 'success');
              } else {
                showToast('Imported ' + imported + ' entries, ' + errors + ' failed', 'warning');
              }
            });
          }
        });
      } catch (e) {
        showToast('Failed to parse JSON file: ' + e.message, 'error');
      }
    };
    
    reader.onerror = () => {
      showToast('Failed to read file', 'error');
    };
    
    reader.readAsText(file);
  };
  
  input.click();
}

// -- Memory -- //
let allMemories = [];
let memoryCategory = 'durable';

async function loadMemories() {
  try {
    const [memRes, projRes, statsRes] = await Promise.all([
      authFetch('/api/memories?include_disabled=true&limit=500'),
      authFetch('/api/memories/projects'),
      authFetch('/api/memories/stats')
    ]);
    const memData = await memRes.json();
    const projData = await projRes.json();
    const statsData = await statsRes.json();

    allMemories = memData.memories || [];

    const select = $('memoryProjectFilter');
    if (select) {
      const currentVal = select.value;
      const projects = projData.projects || [];
      select.innerHTML = '<option value="">All Projects</option>' +
        projects.map(p => '<option value="' + esc(p) + '">' + esc(p) + '</option>').join('');
      select.value = currentVal;
    }
    const sourceSelect = $('memorySourceFilter');
    if (sourceSelect) {
      const currentVal = sourceSelect.value;
      const sources = [...new Set(allMemories.map(m => m.source).filter(Boolean))].sort();
      sourceSelect.innerHTML = '<option value="">All Sources</option>' + sources.map(source => '<option value="' + esc(source) + '">' + esc(source) + '</option>').join('');
      sourceSelect.value = currentVal;
    }

    if (statsData.ok && statsData.stats) {
      renderMemoryStats(statsData.stats);
    }

    renderMemories();
  } catch (e) {
    apiError('/api/memories', e, 0);
  }
}

function renderMemoryStats(stats) {
  const activeLoaded = allMemories.filter(memory => memory.enabled);
  const durableActive = activeLoaded.filter(memory => memory.category !== 'operational').length;
  const operational = activeLoaded.filter(memory => memory.category === 'operational').length;
  $('memStatsTotal').textContent = allMemories.length || stats.total || 0;
  $('memStatsActive').textContent = stats.durable_active ?? durableActive;
  $('memStatsStale').textContent = (stats.revalidation_due ?? stats.stale_count ?? 0) + ' due / ' + (stats.operational_events ?? operational) + ' ops';
  $('memStatsConfidence').textContent = (stats.avg_confidence || 0).toFixed(2);

  const byType = stats.by_type || {};
  const typeEntries = Object.entries(byType);
  if (typeEntries.length > 0) {
    $('memStatsByType').innerHTML = typeEntries.map(([type, count]) =>
      '<div><span style="color:#58a6ff">' + esc(type) + '</span>: ' + count + '</div>'
    ).join('');
  } else {
    $('memStatsByType').innerHTML = '<div class="empty">No data</div>';
  }

  const byProject = stats.by_project || {};
  const projEntries = Object.entries(byProject);
  if (projEntries.length > 0) {
    $('memStatsByProject').innerHTML = projEntries.map(([proj, count]) =>
      '<div><span style="color:#58a6ff">' + esc(proj) + '</span>: ' + count + '</div>'
    ).join('');
  } else {
    $('memStatsByProject').innerHTML = '<div class="empty">No data</div>';
  }
}

async function expireStaleMemories() {
  if (!confirm('This will disable memories not confirmed in 90 days. Continue?')) return;
  try {
    const res = await authFetch('/api/memories/expire', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stale_days: 90 })
    });
    const result = await res.json();
    if (result.ok) {
      alert('Expired ' + result.expired + ' stale memories');
      loadMemories();
    } else {
      alert('Failed: ' + result.error);
    }
  } catch (e) {
    alert('Failed: ' + e.message);
  }
}

function filterMemories() {
  renderMemories();
}

function setMemoryCategory(category) {
  memoryCategory = category || 'durable';
  ['Durable', 'Sessions', 'Unresolved', 'Operational', 'All'].forEach(name => {
    const id = 'memoryCategory' + name;
    const active = name.toLowerCase() === memoryCategory;
    if ($(id)) {
      $(id).classList.toggle('active', active);
      $(id).setAttribute('aria-selected', active ? 'true' : 'false');
    }
  });
  renderMemories();
}

function renderMemories() {
  const search = ($('memorySearch').value || '').toLowerCase();
  const projectFilter = $('memoryProjectFilter') ? $('memoryProjectFilter').value : '';
  const typeFilter = $('memoryTypeFilter') ? $('memoryTypeFilter').value : '';
  const sourceFilter = $('memorySourceFilter') ? $('memorySourceFilter').value : '';
  const importanceFilter = $('memoryImportanceFilter') ? $('memoryImportanceFilter').value : '';
  const unresolvedOnly = $('memoryUnresolvedOnly') ? $('memoryUnresolvedOnly').checked : false;
  const includeDisabled = $('memoryIncludeDisabled') ? $('memoryIncludeDisabled').checked : false;

  let filtered = allMemories.filter(m => {
    if (!includeDisabled && !m.enabled) return false;
    if (memoryCategory !== 'all' && m.category !== memoryCategory) return false;
    if (projectFilter && m.project !== projectFilter) return false;
    if (typeFilter && m.type !== typeFilter) return false;
    if (sourceFilter && m.source !== sourceFilter) return false;
    if (importanceFilter && m.importance !== importanceFilter) return false;
    if (unresolvedOnly && !(m.category === 'unresolved' || m.state === 'pending' || m.type === 'open_thread')) return false;
    if (search) {
      const text = [m.content, m.summary, (m.tags || []).join(' '), m.source, m.source_tool, m.source_task_id, m.category].join(' ').toLowerCase();
      if (!text.includes(search)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

  $('memoryCount').textContent = filtered.length;

  const list = $('memoryList');
  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty">No memories found. Durable Memory is for facts, decisions, preferences, procedures, observations, and unresolved items. Tool-call telemetry remains available under Operational.</div>';
    return;
  }

  const groups = [];
  for (const memory of filtered) {
    const label = memory.type || memory.category || 'memory';
    let group = groups.find(item => item.label === label);
    if (!group) {
      group = { label, items: [] };
      groups.push(group);
    }
    group.items.push(memory);
  }
  list.innerHTML = groups.map(group =>
    '<section class="memory-type-section"><div class="memory-type-heading"><span>' + esc(group.label.replace(/_/g, ' ')) + '</span><strong>' + group.items.length + '</strong></div>' +
    group.items.map(renderMemoryCard).join('') + '</section>'
  ).join('');
}

function renderMemoryCard(m) {
  const typeLabels = { open_thread: 'unresolved', tool_call: 'tool call', agent_task: 'agent task' };
  const enabledBadge = m.enabled ? '' : '<span class="memory-state disabled">disabled</span>';
  const stateBadge = m.state && m.state !== 'active' ? '<span class="memory-state ' + esc(m.state) + '">' + esc(m.state) + '</span>' : '';
  const categoryBadge = '<span class="memory-category ' + esc(m.category) + '">' + esc(m.category) + '</span>';
  const classBadge = m.memory_class ? '<span class="memory-state">' + esc(m.memory_class) + '</span>' : '';
  const currentBadge = m.current === false ? '<span class="memory-state expired">historical</span>' : '';
  const title = m.summary || m.content || '(empty memory)';
  const content = m.content || '';
  const excerpt = content && content !== title ? '<p class="memory-excerpt">' + esc(content.length > 260 ? content.slice(0, 257) + '...' : content) + '</p>' : '';
  const scope = (m.primary_scope_type || (m.project ? 'project' : 'global')) + ':' + (m.primary_scope_id || m.project || 'global');
  const evidence = m.evidence_excerpt ? '<p class="memory-excerpt"><strong>Evidence:</strong> ' + esc(String(m.evidence_excerpt).slice(0, 260)) + '</p>' : '';
  return '<article class="memory-entry memory-' + esc(m.category) + '" data-id="' + attr(m.id) + '">' +
    '<div class="memory-header"><div><span class="memory-type">' + esc(typeLabels[m.type] || m.type) + '</span><div class="memory-content">' + esc(title) + '</div></div>' +
    '<div class="memory-badges">' + categoryBadge + classBadge + currentBadge + (m.project ? '<span class="memory-project">' + esc(m.project) + '</span>' : '') + enabledBadge + stateBadge + '<span class="memory-confidence">' + Math.round((m.confidence || 0) * 100) + '%</span><span class="memory-confirmed">×' + (m.times_confirmed || 1) + '</span></div></div>' +
    excerpt +
    evidence +
    '<div class="memory-footer"><span class="memory-time">Updated ' + esc(formatTimeAgo(m.updated_at)) + '</span><span>Source: ' + esc(m.source || 'unknown') + (m.source_tool ? ' / ' + esc(m.source_tool) : '') + '</span><div class="memory-actions">' +
      (m.enabled ? '<button class="btn btn-sm btn-outline" onclick="disableMemory(' + jsArg(m.id) + ')">Disable</button>' : '<button class="btn btn-sm btn-outline" onclick="enableMemory(' + jsArg(m.id) + ')">Enable</button>') +
      '<button class="btn btn-sm btn-danger" onclick="deleteMemory(' + jsArg(m.id) + ')">Delete</button></div></div>' +
    '<details class="detail-block"><summary>Full content and metadata</summary>' +
      '<div class="memory-full">' + esc(m.content || '') + '</div>' +
      '<div class="meta-grid"><div><span>Created</span><strong>' + esc(m.created_at ? fmtDate(m.created_at) : 'unknown') + '</strong></div><div><span>Observed</span><strong>' + esc(m.observed_at ? fmtDate(m.observed_at) : 'unknown') + '</strong></div><div><span>Valid</span><strong>' + esc((m.valid_from || 'unknown') + ' to ' + (m.valid_to || 'current')) + '</strong></div><div><span>Scope</span><strong>' + esc(scope) + '</strong></div><div><span>Authority</span><strong>' + esc(String(m.source_authority || 'unknown')) + '</strong></div><div><span>Directness</span><strong>' + esc(m.directness || 'unknown') + '</strong></div><div><span>Task</span><strong>' + esc(m.source_task_id || 'none') + '</strong></div><div><span>Importance</span><strong>' + esc(m.importance || 'normal') + '</strong></div><div><span>Expires</span><strong>' + esc(m.expires_at || 'none') + '</strong></div><div><span>Revalidate</span><strong>' + esc(m.revalidate_after || 'none') + '</strong></div><div><span>Tags</span><strong>' + esc((m.tags || []).join(', ') || 'none') + '</strong></div></div>' +
      renderStructuredValue({ id: m.id, type: m.type, category: m.category, state: m.state, automatic: m.automatic, metadata: m.metadata || {} }, { expanded: true }) +
    '</details>' +
  '</article>';
}

async function disableMemory(id) {
  if (!confirm('Disable this memory?')) return;
  try {
    await authFetch('/api/memories/' + encodeURIComponent(id) + '/disable', { method: 'POST' });
    loadMemories();
  } catch (e) {
    alert('Failed to disable: ' + e.message);
  }
}

async function enableMemory(id) {
  try {
    await authFetch('/api/memories/' + encodeURIComponent(id) + '/enable', { method: 'POST' });
    loadMemories();
  } catch (e) {
    alert('Failed to enable: ' + e.message);
  }
}

async function deleteMemory(id) {
  if (!confirm('Delete this memory permanently?')) return;
  try {
    await authFetch('/api/memories/' + encodeURIComponent(id), { method: 'DELETE' });
    loadMemories();
  } catch (e) {
    alert('Failed to delete: ' + e.message);
  }
}

async function exportMemories() {
  try {
    const res = await authFetch('/api/memories/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ include_disabled: true })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error);

    const blob = new Blob([JSON.stringify(data.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sidekick-memories-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Export failed: ' + e.message);
  }
}

function importMemories() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        const res = await authFetch('/api/memories/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: data, on_conflict: 'merge' })
        });
        const result = await res.json();
        if (!result.ok) throw new Error(result.error);
        alert('Import complete: ' + result.imported + ' imported, ' + (result.updated || 0) + ' updated, ' + result.skipped + ' skipped');
        loadMemories();
      } catch (err) {
        alert('Import failed: ' + err.message);
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

// -- Config -- //
function loadConfig(){
  authFetch('/api/config').then(r=>r.json()).then(d=>{
    const list = $('configList');
    if (!d.config || !Object.keys(d.config).length){ list.innerHTML='<div class="empty">No configuration</div>'; return }
    list.innerHTML = Object.entries(d.config).map(([key, value]) => {
      const isRedacted = value === '***redacted***';
      return '<div class="config-entry"><span class="config-key">' + esc(key) + '</span><span class="config-val' + (isRedacted ? ' redacted' : '') + '">' + esc(String(value)) + '</span></div>';
    }).join('');
  }).catch(e => apiError('/api/config', e, 0));
}

// -- Agent -- //
function runAgent(){
  const goal = $('agentGoal').value.trim();
  if (!goal || agentRunning) return;
  agentRunning = true;
  $('agentGo').disabled = true;
  $('agentStop').disabled = false;
  $('agentLog').innerHTML = '<span class="agent-step">► Starting agent...</span>\n';

  authFetch('/api/agent/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal })
  }).then(r=>r.json()).then(data => {
    if (data.error) {
      appendLog('<span class="agent-err">✖ Error: ' + esc(data.error) + '</span>');
      stopAgent();
      return;
    }
    const taskId = data.taskId;
    appendLog('<span class="agent-step">► Task ' + taskId + ' started</span>');
    agentStream = new EventSource('/api/agent/stream/' + taskId);
    agentStream.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'step') appendLog('<span class="agent-step">◄ ' + esc(msg.text) + '</span>');
      else if (msg.type === 'tool') appendLog('  <span class="agent-ok">→ ' + esc(msg.tool) + '</span> ' + esc(msg.summary));
      else if (msg.type === 'error') appendLog('<span class="agent-err">✖ ' + esc(msg.text) + '</span>');
      else if (msg.type === 'done') {
        appendLog('<span class="agent-done">✔ ' + esc(msg.text) + '</span>');
        stopAgent();
      }
    };
    agentStream.onerror = () => stopAgent();
  }).catch(e => {
    appendLog('<span class="agent-err"> Request failed: ' + esc(e.message) + '</span>');
    apiError('/api/agent/run', e, 0);
    stopAgent();
  });
}

function appendLog(html){
  $('agentLog').innerHTML += html + '\n';
  $('agentLog').scrollTop = $('agentLog').scrollHeight;
}

function stopAgent(){
  if (agentStream) { agentStream.close(); agentStream = null; }
  agentRunning = false;
  $('agentGo').disabled = false;
  $('agentStop').disabled = true;
}

function toggleHistory(){
  const el = $('agentHistory');
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
  if (el.style.display === 'block') {
      authFetch('/api/agent/history').then(r=>r.json()).then(d=>{
      let html = '<div style="color:#8b949e;font-size:.78rem;margin-bottom:12px;padding:8px;background:#161b22;border-radius:6px">' +
        '<i class="fas fa-info-circle"></i> Agent history shows tasks submitted via this dashboard. ' +
        'Tool calls from opencode appear in the Activity tab, grouped by session.</div>';
      if (!d.runs || !d.runs.length) { html += '<div class="empty">No past runs</div>'; el.innerHTML = html; return; }
      html += d.runs.map(r =>
        '<div class="history-item">' +
        '<span class="log-time">' + fmtTime(r.t) + '</span> ' +
        '<span class="' + (r.status === 'completed' ? 'log-ok' : 'log-fail') + '">' + r.status + '</span> ' +
        '<span class="log-summary" style="flex:1">' + esc(r.goal.substring(0,80)) + '</span>' +
        '<button class="btn btn-sm btn-outline" data-action="export" data-id="' + esc(r.id) + '" title="Export"><i class="fas fa-download"></i></button>' +
        '<button class="btn btn-sm btn-outline" data-action="toggle" data-id="' + esc(r.id) + '" title="Details"><i class="fas fa-chevron-down"></i></button>' +
        '<div id="run-detail-' + esc(r.id) + '" style="display:none;width:100%"></div>' +
        '</div>'
      ).join('');
      el.innerHTML = html;

      el.querySelectorAll('button[data-action]').forEach(btn => {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          const action = this.dataset.action;
          const id = this.dataset.id;
          if (action === 'export') exportRun(id);
          else if (action === 'toggle') toggleRunDetail(id);
        });
      });
    }).catch(e => apiError('/api/agent/history', e, 0));
  }
}

function toggleRunDetail(id){
  const detail = $('run-detail-' + id);
  if (expandedHistory[id]) {
    detail.style.display = 'none';
    expandedHistory[id] = false;
    return;
  }
  expandedHistory[id] = true;
  detail.style.display = 'block';
  detail.innerHTML = '<div class="empty">Loading...</div>';
  authFetch('/api/agent/run/' + id).then(r=>r.json()).then(run=>{
    if (!run || !run.steps) { detail.innerHTML = '<div class="empty">No details</div>'; return; }
    let html = '';
    run.steps.forEach(s => {
      if (s.type === 'thought') html += '<span class="agent-step">◄ ' + esc(s.text) + '</span>\n';
      else if (s.type === 'tool') html += '  <span class="agent-ok">→ ' + esc(s.tool) + '</span> ' + esc(s.args ? JSON.stringify(s.args) : '') + '\n    ' + esc((s.result || '').substring(0, 200)) + '\n';
      else if (s.type === 'error') html += '<span class="agent-err">✖ ' + esc(s.text) + '</span>\n';
      else if (s.type === 'done') html += '<span class="agent-done">✔ ' + esc(s.text) + '</span>\n';
    });
    detail.innerHTML = '<div class="history-detail">' + html + '</div>';
  }).catch(e => { 
    detail.innerHTML = '<div class="agent-err">Failed to load details</div>'; 
    apiError('/api/agent/run/' + id, e, 0);
  });
}

function exportRun(id){
  authFetch('/api/agent/run/' + id).then(r=>r.json()).then(run=>{
    const blob = new Blob([JSON.stringify(run, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'agent-run-' + id + '.json';
    a.click();
    URL.revokeObjectURL(url);
  }).catch(e => apiError('/api/agent/run/' + id, e, 0));
}

// -- Evolve -- //
function evolveAction(id, action, body){
  const url = id ? '/api/evolve/' + encodeURIComponent(id) + '/' + action : '/api/evolve/' + action;
  return authFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  }).then(r=>r.json()).then(d=>{
    if (!d.ok) alert(d.error || d.result || (action + ' failed'));
    loadEvolve();
    loadTools();
    return d;
  }).catch(e => apiError(url, e, 0));
}

function runEvolveAnalyze(){ evolveAction(null, 'analyze'); }
function validateEvolve(id){ evolveAction(id, 'validate'); }
function approveEvolve(id){ evolveAction(id, 'approve', { approver: 'dashboard' }); }
function promoteEvolve(id){ evolveAction(id, 'promote'); }
function rejectEvolve(id){ evolveAction(id, 'reject', { reason: prompt('Reject reason?', 'not useful') || 'not useful' }); }
function deprecateEvolve(id){ evolveAction(id, 'deprecate', { reason: prompt('Deprecation reason?', 'unused') || 'unused' }); }
function feedbackEvolve(id, useful){ evolveAction(id, 'feedback', { useful: useful, notes: useful ? 'dashboard useful vote' : 'dashboard not-useful vote' }); }

function promptEvolveArgs(item){
  const schema = item.schema || { type: 'object', properties: item.inferred_parameters || {}, required: [] };
  const example = {};
  Object.entries(schema.properties || {}).forEach(([name, def]) => {
    if (def.default !== undefined) example[name] = def.default;
    else if (Array.isArray(def.examples) && def.examples.length) example[name] = def.examples[0];
    else example[name] = def.type === 'number' ? 1 : def.type === 'boolean' ? true : '';
  });
  const value = prompt('Arguments JSON for ' + item.proposed_tool_name, JSON.stringify(example, null, 2));
  if (value === null) return null;
  try { return JSON.parse(value || '{}'); } catch (e) { alert('Invalid JSON: ' + e.message); return null; }
}

function runEvolveTrial(id, index){
  const item = (window._evolveItems || [])[index];
  if (!item) return alert('Candidate data not loaded');
  const args = promptEvolveArgs(item);
  if (args === null) return;
  authFetch('/api/evolve/' + encodeURIComponent(id) + '/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ args })
  }).then(r=>r.json()).then(d=>{
    if (!d.ok) return alert(d.error || 'Run failed');
    watchEvolveExecution(d.execution_id);
    loadEvolve();
  }).catch(e => apiError('/api/evolve/' + id + '/run', e, 0));
}

function watchEvolveExecution(id){
  if (!id) return;
  if (evolveExecutionStreams[id]) evolveExecutionStreams[id].close();
  const target = $('evolveExecutionWatch');
  if (target) target.innerHTML = '<div class="empty">Watching execution ' + esc(id) + '...</div>';
  const stream = new EventSource('/api/evolve/executions/' + encodeURIComponent(id) + '/stream');
  evolveExecutionStreams[id] = stream;
  stream.addEventListener('execution', ev => {
    const execution = JSON.parse(ev.data);
    renderEvolveExecution(execution);
    if (['succeeded','failed','cancelled','timed_out'].includes(execution.state)) {
      stream.close();
      delete evolveExecutionStreams[id];
      loadEvolve();
    }
  });
  stream.onerror = () => {
    stream.close();
    delete evolveExecutionStreams[id];
    loadEvolveExecution(id);
  };
}

function loadEvolveExecution(id){
  authFetch('/api/evolve/executions/' + encodeURIComponent(id)).then(r=>r.json()).then(d=>{
    if (d.ok) renderEvolveExecution(d.execution);
  }).catch(e => apiError('/api/evolve/executions/' + id, e, 0));
}

function cancelEvolveExecution(id){
  authFetch('/api/evolve/executions/' + encodeURIComponent(id) + '/cancel', { method: 'POST' }).then(r=>r.json()).then(d=>{
    if (!d.ok) alert(d.error || 'Cancel failed');
    if (d.execution) renderEvolveExecution(d.execution);
    loadEvolve();
  }).catch(e => apiError('/api/evolve/executions/' + id + '/cancel', e, 0));
}

function openExecutionActivity(id){
  currentPage = 'activity';
  location.hash = 'activity';
  showPage('activity');
  if ($('logSessionFilter')) $('logSessionFilter').value = id;
  loadLogs();
}

function renderEvolveExecution(execution){
  const target = $('evolveExecutionWatch');
  if (!target || !execution) return;
  const running = ['queued','running'].includes(execution.state);
  const steps = (execution.steps || []).map(step =>
    '<tr><td>' + esc(step.step_number) + '</td><td><code>' + esc(step.tool_name) + '</code></td><td><pre style="white-space:pre-wrap;max-width:260px">' + esc(JSON.stringify(step.args || {}, null, 2)) + '</pre></td><td>' + esc(step.started_at ? fmtTime(step.started_at) : '-') + '</td><td>' + esc(formatMs(step.duration_ms)) + '</td><td>' + esc(step.result_summary || '') + '</td><td>' + esc(step.retry_count || 0) + '</td><td>' + esc(step.error_category || '') + '</td><td>' + esc(step.success === null ? step.state : (step.success ? 'ok' : 'failed')) + '</td></tr>'
  ).join('');
  target.innerHTML = '<div class="card" style="margin:12px 0">' +
    '<div style="display:flex;justify-content:space-between;gap:12px;align-items:center"><div><strong>Execution <code>' + esc(execution.id) + '</code></strong><div style="margin-top:4px"><span class="badge">' + esc(execution.state) + '</span> <span class="badge">source=' + esc(execution.source || 'unknown') + '</span></div></div>' +
    '<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="btn btn-sm btn-outline" onclick="openExecutionActivity(\'' + esc(execution.id) + '\')">Open in Activity</button>' + (running ? '<button class="btn btn-sm btn-outline" onclick="cancelEvolveExecution(\'' + esc(execution.id) + '\')">Cancel</button>' : '') + '</div></div>' +
    '<div style="margin-top:10px;color:#8b949e;font-size:.8rem">Success criteria: ' + esc(execution.success_criteria || 'All generated workflow steps must complete successfully') + ' · satisfied=' + esc(execution.success_criteria_satisfied === null ? 'pending' : execution.success_criteria_satisfied) + '</div>' +
    '<div style="margin-top:10px;color:#8b949e;font-size:.8rem">Final summary: ' + esc(execution.final_summary || '') + '</div>' +
    '<div style="overflow:auto;margin-top:10px"><table class="data-table"><thead><tr><th>#</th><th>Tool</th><th>Args</th><th>Start</th><th>Duration</th><th>Summary</th><th>Retries</th><th>Error</th><th>Status</th></tr></thead><tbody>' + (steps || '<tr><td colspan="9" class="empty">No steps yet</td></tr>') + '</tbody></table></div>' +
  '</div>';
}

function renderEvolveParams(params){
  const names = Object.keys(params || {});
  if (!names.length) return '<span class="empty">No parameters inferred</span>';
  return names.map(name => '<span class="badge">' + esc(name) + ':' + esc((params[name] && params[name].type) || 'string') + '</span>').join(' ');
}

function loadEvolve(){
  const list = $('evolveList');
  if (!list) return;
  list.innerHTML = '<div class="empty">Loading Evolve candidates...</div>';
  authFetch('/api/evolve').then(r=>r.json()).then(d=>{
    const items = d.capabilities || [];
    window._evolveItems = items;
    $('evolveCount').textContent = items.length;
    if (!items.length) {
      list.innerHTML = '<div class="empty">No Evolve candidates yet. Run Analyze Logs after repeated successful workflows exist.</div>';
      return;
    }
    list.innerHTML = items.map((item, index) => {
      const state = item.lifecycle_state || 'candidate';
      const active = state === 'trial' || state === 'active';
      const validation = item.validation_status || 'not_validated';
      const trial = item.recent_trial_results || [];
      const allowed = item.allowed_actions || {};
      const controls = [
        allowed.validate ? '<button class="btn btn-sm" onclick="validateEvolve(\'' + esc(item.id) + '\')">Validate</button>' : '',
        allowed.approve ? '<button class="btn btn-sm" onclick="approveEvolve(\'' + esc(item.id) + '\')">Approve Trial</button>' : '',
        allowed.promote ? '<button class="btn btn-sm" onclick="promoteEvolve(\'' + esc(item.id) + '\')">Promote</button>' : '',
        active ? '<button class="btn btn-sm" onclick="runEvolveTrial(\'' + esc(item.id) + '\',' + index + ')">Run Trial</button>' : '',
        active && item.recent_executions && item.recent_executions.length ? '<button class="btn btn-sm btn-outline" onclick="watchEvolveExecution(\'' + esc(item.recent_executions[0].id) + '\')">Watch Executions</button>' : '',
        allowed.reject ? '<button class="btn btn-sm btn-outline" onclick="rejectEvolve(\'' + esc(item.id) + '\')">Reject</button>' : '',
        allowed.deprecate ? '<button class="btn btn-sm btn-outline" onclick="deprecateEvolve(\'' + esc(item.id) + '\')">Deprecate</button>' : '',
        '<button class="btn btn-sm btn-outline" onclick="feedbackEvolve(\'' + esc(item.id) + '\', true)">Useful</button>',
        '<button class="btn btn-sm btn-outline" onclick="feedbackEvolve(\'' + esc(item.id) + '\', false)">Not Useful</button>'
      ].filter(Boolean).join(' ');
      return '<div class="card" style="margin-bottom:12px">' +
        '<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">' +
          '<div>' +
            '<div style="font-weight:700;color:#c9d1d9">' + esc(item.candidate_title || item.proposed_tool_name) + '</div>' +
            '<div style="font-size:.78rem;color:#8b949e;margin-top:4px"><code>' + esc(item.proposed_tool_name) + '</code></div>' +
          '</div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end">' + controls + '</div>' +
        '</div>' +
        '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">' +
          '<span class="badge">' + esc(state) + '</span>' +
          '<span class="badge">risk=' + esc(item.risk || 'medium') + '</span>' +
          '<span class="badge">evidence=' + esc(item.evidence_count || 0) + '</span>' +
          '<span class="badge">success=' + esc(Math.round((item.success_rate || 0) * 100)) + '%</span>' +
          '<span class="badge">score=' + esc(item.usefulness_score || 0) + '</span>' +
          '<span class="badge">calls saved=' + esc(item.estimated_calls_saved || 0) + '</span>' +
          '<span class="badge">validation=' + esc(validation) + '</span>' +
        '</div>' +
        '<div style="margin-top:10px"><span class="s-label">Parameters:</span> ' + renderEvolveParams(item.inferred_parameters || {}) + '</div>' +
        (item.score_breakdown ? '<div style="margin-top:8px;color:#8b949e;font-size:.78rem">Score: ' + esc(JSON.stringify(item.score_breakdown)) + '</div>' : '') +
        (item.duplicate_reasons && item.duplicate_reasons.length ? '<div class="agent-err" style="margin-top:8px">Duplicate signals: ' + esc(item.duplicate_reasons.join(', ')) + '</div>' : '') +
        '<div style="margin-top:10px;color:#8b949e;font-size:.78rem">Trial executions: use=' + esc(item.use_count || 0) + ', ok=' + esc(item.success_count || 0) + ', fail=' + esc(item.failure_count || 0) + (trial.length ? ', legacy audit=' + esc(trial.map(t => t.success ? 'ok' : 'fail').join(',')) : '') + '</div>' +
        (item.recent_executions && item.recent_executions.length ? '<div style="margin-top:8px;color:#8b949e;font-size:.78rem">Recent executions: ' + item.recent_executions.map(ex => '<button class="btn btn-sm btn-outline" onclick="watchEvolveExecution(\'' + esc(ex.id) + '\')">' + esc(ex.state) + ' ' + esc(fmtTime(ex.created_at)) + '</button>').join(' ') + '</div>' : '') +
      '</div>';
    }).join('');
  }).catch(e => {
    list.innerHTML = '<div class="agent-err">Failed to load Evolve data</div>';
    apiError('/api/evolve', e, 0);
  });
}

// -- Approvals -- //
function loadApprovals(){
  const status = $('approvalStatusFilter') ? $('approvalStatusFilter').value : 'pending';
  const url = '/api/approvals' + (status ? '?status=' + encodeURIComponent(status) : '');
  authFetch(url).then(r=>r.json()).then(d=>{
    const approvals = d.approvals || [];
    $('approvalCount').textContent = approvals.length;
    const list = $('approvalList');
    if (!approvals.length) {
      list.innerHTML = '<div class="empty">No approvals found</div>';
      return;
    }
    list.innerHTML = approvals.map(a => {
      const riskClass = a.risk === 'critical' ? 'danger' : a.risk === 'high' ? 'warn' : '';
      const pending = a.status === 'pending';
      const requested = a.requested_at ? fmtDate(a.requested_at) : '';
      const completed = a.completed_at ? '<div><span class="s-label">Completed:</span> ' + esc(fmtDate(a.completed_at)) + '</div>' : '';
      const result = a.result_preview ? '<pre style="white-space:pre-wrap;margin-top:8px;max-height:140px;overflow:auto">' + esc(a.result_preview) + '</pre>' : '';
      return '<div class="approval-entry" style="padding:12px 0;border-bottom:1px solid #21262d">' +
        '<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">' +
          '<div>' +
            '<div style="font-weight:700;color:#c9d1d9">' + esc(a.tool) + '</div>' +
            '<div style="font-size:.78rem;color:#8b949e;margin-top:4px">' +
              '<span class="badge ' + riskClass + '">' + esc(a.risk || 'low') + '</span> ' +
              '<span class="badge">' + esc(a.source || 'unknown') + '</span> ' +
              '<span class="badge">' + esc(a.status || 'pending') + '</span>' +
            '</div>' +
          '</div>' +
          (pending ? '<div style="display:flex;gap:8px">' +
            '<button class="btn btn-sm" onclick="approveRequest(\'' + esc(a.id) + '\')"><i class="fas fa-check"></i> Approve</button>' +
            '<button class="btn btn-sm btn-outline" onclick="rejectRequest(\'' + esc(a.id) + '\')"><i class="fas fa-times"></i> Reject</button>' +
          '</div>' : '') +
        '</div>' +
        '<div style="font-size:.78rem;color:#8b949e;margin-top:8px;line-height:1.5">' +
          '<div><span class="s-label">Requested:</span> ' + esc(requested) + '</div>' +
          '<div><span class="s-label">Reason:</span> ' + esc(a.reason || '') + '</div>' +
          completed +
        '</div>' +
        '<pre style="white-space:pre-wrap;margin-top:8px;max-height:220px;overflow:auto">' + esc(a.args_preview || '{}') + '</pre>' +
        result +
      '</div>';
    }).join('');
  }).catch(e => apiError('/api/approvals', e, 0));
}

function approveRequest(id){
  authFetch('/api/approvals/' + encodeURIComponent(id) + '/approve', { method: 'POST' })
    .then(r=>r.json())
    .then(d=>{
      if (!d.ok) alert(d.error || d.result || 'Approval failed');
      loadApprovals();
      loadLogs();
    })
    .catch(e => apiError('/api/approvals/' + id + '/approve', e, 0));
}

function rejectRequest(id){
  authFetch('/api/approvals/' + encodeURIComponent(id) + '/reject', { method: 'POST' })
    .then(r=>r.json())
    .then(d=>{
      if (!d.ok) alert(d.error || d.result || 'Reject failed');
      loadApprovals();
      loadLogs();
    })
    .catch(e => apiError('/api/approvals/' + id + '/reject', e, 0));
}

function clearData(type){
  const titles = {
    logs: 'Clear Activity Logs',
    kv: 'Clear KV Data',
    conversations: 'Clear Conversations',
    all: 'Clear ALL Data'
  };
  
  const messages = {
    logs: 'This will permanently delete all activity logs.',
    kv: 'This will permanently delete all stored KV data.',
    conversations: 'This will permanently delete all agent conversation history.',
    all: 'This will permanently delete ALL data (logs, KV, conversations).'
  };
  
  const endpoints = {
    logs: '/api/logs',
    kv: '/api/kv',
    conversations: '/api/conversations',
    all: '/api/data'
  };
  
  // Get counts for details
  let details = '';
  let requiredText = '';
  let tier = 2;
  
  if (type === 'kv') {
    const count = allKV.length;
    const totalSize = allKV.reduce((sum, e) => sum + String(e.value).length, 0);
    const sizeStr = formatBytes(totalSize);
    details = `<strong>Entries:</strong> ${count}<br><strong>Total size:</strong> ${sizeStr}<br><strong>Projects:</strong> ${getUniqueProjects().length}`;
    requiredText = 'CLEAR ALL';
    tier = count >= 50 ? 1 : 2;
  } else if (type === 'all') {
    const kvCount = allKV.length;
    const logCount = allLogs.length;
    details = `<strong>KV entries:</strong> ${kvCount}<br><strong>Log entries:</strong> ${logCount}<br><strong>This action cannot be undone!</strong>`;
    requiredText = 'CLEAR ALL';
    tier = 1;
  } else {
    details = 'This action cannot be undone.';
    tier = 2;
  }
  
  showConfirmModal({
    title: titles[type],
    message: messages[type],
    details: details,
    tier: tier,
    requiredText: requiredText,
    action: () => {
      authFetch(endpoints[type], { 
        method: 'DELETE'
      })
        .then(r => r.json())
        .then(d => {
          if (d.ok) {
            if (type === 'logs' || type === 'all') loadLogs();
            if (type === 'kv' || type === 'all') loadKV();
            showToast('Data cleared successfully', 'success');
          }
        })
        .catch(e => apiError(endpoints[type], e, 0));
    }
  });
}

function getUniqueProjects() {
  const projects = new Set();
  allKV.forEach(e => {
    if (e.project) projects.add(e.project);
  });
  return Array.from(projects);
}

// -- Database -- //
function loadDbStats() {
  authFetch('/api/db/stats').then(r => r.json()).then(d => {
    if (d.ok) {
      $('dbSize').textContent = formatBytes(d.size);
      $('dbTables').textContent = d.tableCount;
      $('dbWal').textContent = d.walMode || 'unknown';
      $('dbCache').textContent = '--';
    }
  }).catch(() => {});
  
  authFetch('/api/db/schema').then(r => r.json()).then(d => {
    if (d.ok) renderDbSchema(d.schema);
  }).catch(() => {});
  
  authFetch('/api/db/migrations').then(r => r.json()).then(d => {
    if (d.ok) renderDbMigrations(d);
  }).catch(() => {});
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function renderDbSchema(schema) {
  let html = '';
  for (const [table, info] of Object.entries(schema)) {
    html += '<div style="margin-bottom:16px">';
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">';
    html += '<i class="fas fa-table" style="color:#58a6ff"></i>';
    html += '<span style="font-weight:600;color:#c9d1d9;font-family:var(--font)">' + esc(table) + '</span>';
    html += '<span style="color:#8b949e;font-size:.8rem">(' + info.rowCount + ' rows)</span>';
    html += '</div>';
    html += '<div style="padding-left:24px">';
    for (const col of info.columns) {
      const pk = col.pk ? '<span style="color:#ffa657;font-size:.75rem;margin-left:4px">PK</span>' : '';
      const notnull = col.notnull ? '<span style="color:#f85149;font-size:.75rem;margin-left:4px">NOT NULL</span>' : '';
      html += '<div style="display:flex;align-items:center;gap:8px;padding:2px 0;font-size:.85rem">';
      html += '<i class="fas fa-columns" style="color:#6e7681;font-size:.75rem"></i>';
      html += '<span style="color:#c9d1d9;font-family:var(--font)">' + esc(col.name) + '</span>';
      html += '<span style="color:#8b949e;font-size:.8rem">' + esc(col.type || 'TEXT') + '</span>';
      html += pk + notnull;
      html += '</div>';
    }
    if (info.indexes.length > 0) {
      html += '<div style="margin-top:6px;padding-top:6px;border-top:1px solid #21262d">';
      for (const idx of info.indexes) {
        html += '<div style="display:flex;align-items:center;gap:8px;padding:2px 0;font-size:.8rem">';
        html += '<i class="fas fa-key" style="color:#3fb950;font-size:.7rem"></i>';
        html += '<span style="color:#8b949e">' + esc(idx.name) + '</span>';
        if (idx.unique) html += '<span style="color:#3fb950;font-size:.7rem">UNIQUE</span>';
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div></div>';
  }
  $('dbSchema').innerHTML = html || '<div class="empty">No tables found</div>';
}

function runQuery() {
  const sql = $('dbQuery').value.trim();
  if (!sql) return;
  const readonly = $('dbReadonly').checked;
  $('dbQueryResult').innerHTML = '<div class="empty">Running...</div>';
  authFetch('/api/db/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sql, readonly })
  }).then(r => r.json()).then(d => {
    if (d.ok) {
      if (d.rows.length === 0) {
        $('dbQueryResult').innerHTML = '<div class="empty">No results (' + d.duration + 'ms)</div>';
        return;
      }
      const cols = Object.keys(d.rows[0]);
      let html = '<div style="color:#8b949e;font-size:.8rem;margin-bottom:8px">' + d.count + ' rows (' + d.duration + 'ms)</div>';
      html += '<table style="width:100%;border-collapse:collapse;font-size:.85rem">';
      html += '<thead><tr>';
      for (const col of cols) {
        html += '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid #30363d;color:#58a6ff;font-family:var(--font)">' + esc(col) + '</th>';
      }
      html += '</tr></thead><tbody>';
      for (const row of d.rows) {
        html += '<tr>';
        for (const col of cols) {
          const val = row[col];
          const display = val === null ? '<span style="color:#6e7681">NULL</span>' : esc(String(val));
          html += '<td style="padding:6px 8px;border-bottom:1px solid #21262d;color:#c9d1d9;font-family:var(--font);max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + display + '</td>';
        }
        html += '</tr>';
      }
      html += '</tbody></table>';
      $('dbQueryResult').innerHTML = html;
    } else {
      $('dbQueryResult').innerHTML = '<div style="color:#f85149;padding:8px;background:#4a2d2d;border-radius:4px">' + esc(d.error) + '</div>';
    }
  }).catch(e => {
    $('dbQueryResult').innerHTML = '<div style="color:#f85149;padding:8px;background:#4a2d2d;border-radius:4px">' + esc(e.message) + '</div>';
  });
}

function runDbSearch() {
  const q = $('dbSearchQuery').value.trim();
  if (!q) return;
  $('dbSearchResult').innerHTML = '<div class="empty">Searching...</div>';
  authFetch('/api/db/search?q=' + encodeURIComponent(q)).then(r => r.json()).then(d => {
    if (d.ok) {
      const tables = Object.keys(d.results);
      if (tables.length === 0) {
        $('dbSearchResult').innerHTML = '<div class="empty">No results found</div>';
        return;
      }
      let html = '';
      for (const table of tables) {
        const rows = d.results[table];
        html += '<div style="margin-bottom:12px">';
        html += '<div style="font-weight:600;color:#58a6ff;margin-bottom:6px">' + esc(table) + ' (' + rows.length + ')</div>';
        for (const row of rows.slice(0, 5)) {
          html += '<div style="padding:6px 8px;background:#0d1117;border-radius:4px;margin-bottom:4px;font-size:.8rem;color:#c9d1d9;font-family:var(--font)">';
          html += esc(JSON.stringify(row).substring(0, 200));
          if (JSON.stringify(row).length > 200) html += '...';
          html += '</div>';
        }
        if (rows.length > 5) {
          html += '<div style="color:#8b949e;font-size:.8rem;padding-left:8px">... and ' + (rows.length - 5) + ' more</div>';
        }
        html += '</div>';
      }
      $('dbSearchResult').innerHTML = html;
    } else {
      $('dbSearchResult').innerHTML = '<div style="color:#f85149">' + esc(d.error) + '</div>';
    }
  }).catch(e => {
    $('dbSearchResult').innerHTML = '<div style="color:#f85149">' + esc(e.message) + '</div>';
  });
}

function renderDbMigrations(d) {
  let html = '<div style="margin-bottom:8px;color:#8b949e">Current version: <span style="color:#58a6ff;font-weight:600">' + d.currentVersion + '</span></div>';
  if (d.migrations.length === 0) {
    html += '<div class="empty">No migrations found</div>';
  } else {
    for (const m of d.migrations) {
      const status = m.applied ? '<span style="color:#3fb950"><i class="fas fa-check"></i> Applied</span>' : '<span style="color:#d29922"><i class="fas fa-clock"></i> Pending</span>';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #21262d">';
      html += '<span style="color:#c9d1d9;font-family:var(--font)">' + esc(m.file) + '</span>';
      html += status;
      html += '</div>';
    }
  }
  $('dbMigrations').innerHTML = html;
}

function createBackup() {
  if (!confirm('Create database backup?')) return;
  authFetch('/api/db/backup', { method: 'POST' }).then(r => r.json()).then(d => {
    if (d.ok) {
      showToast('Backup created: ' + d.path, 'success');
    } else {
      showToast('Backup failed: ' + d.error, 'error');
    }
  }).catch(e => showToast('Backup failed: ' + e.message, 'error'));
}

function loadTools(){
  const statsWindow = getToolStatsWindow();
  const statsRange = getToolStatsRange(statsWindow);
  const statsQuery = `?since=${encodeURIComponent(statsRange.since)}&until=${encodeURIComponent(statsRange.until)}`;
  Promise.all([
    authFetch('/api/tools').then(r=>r.json()),
    authFetch('/api/stats' + statsQuery).then(r=>r.json()),
    authFetch('/api/procedures').then(r=>r.json()),
    authFetch('/api/tool-categories').then(r=>r.json())
  ]).then(([toolsData, statsData, procData, catData]) => {
    allTools = toolsData.tools || [];
    allProcedures = procData.procedures || [];
    toolCategories = catData.categories || [];
    populateToolCategoryFilter();
    toolStats = {};
    (statsData.stats || []).forEach(s => {
      toolStats[s.name] = s;
    });
    renderTools();
  }).catch(e => apiError('/api/tools', e, 0));
}

function filterTools(){
  renderTools();
}

function renderTools(){
  const search = ($('toolSearch').value || '').toLowerCase();
  const catFilter = $('toolCategoryFilter').value;
  const policyFilter = $('toolPolicyFilter').value;
  let filtered = allTools;
  if (catFilter) filtered = filtered.filter(t => getToolCategory(t.name) === catFilter);
  if (search) filtered = filtered.filter(t => (t.name + ' ' + t.description).toLowerCase().includes(search));
  if (policyFilter === 'enabled') filtered = filtered.filter(t => t.enabled !== false);
  if (policyFilter === 'blocked') filtered = filtered.filter(t => t.enabled === false);
  if (policyFilter === 'approval') filtered = filtered.filter(t => t.approval_required);
  if (policyFilter === 'high-risk') filtered = filtered.filter(isHighRiskTool);
  updateToolSummary(filtered);
  $('toolCount').textContent = filtered.length;
  const container = $('toolList');
  if (!filtered.length) { container.innerHTML = '<div class="empty">No matching tools</div>'; return; }
  const grouped = {};
  for (const t of filtered) {
    const cat = getToolCategory(t.name);
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(t);
  }
  let html = '';
  for (const [cat, tools] of Object.entries(grouped).sort((a,b) => a[0].localeCompare(b[0]))) {
    const catData = toolCategories.find(c => c.name === cat);
    const catInfo = catData || { icon: 'fa-wrench' };
    html += '<div class="tool-category-header">';
    html += '<i class="fas ' + catInfo.icon + '"></i>';
    html += '<span class="cat-name">' + esc(cat) + '</span>';
    html += '<span class="cat-count">' + tools.length + '</span>';
    html += '</div>';
    html += '<div class="tool-grid">';
    for (const t of tools) {
      const stats = toolStats[t.name];
      const hasStats = stats && stats.count > 0;
      const stateLabel = getToolStateLabel(t);
      const riskClass = getRiskBadgeClass(t.risk);
      html += '<div class="tool-card" onclick="showToolDetail(\'' + esc(t.name) + '\')">';
      html += '<div class="tool-card-name">' + esc(t.name) + '</div>';
      html += '<div class="tool-card-desc">' + esc(t.description) + '</div>';
      html += '<div class="tool-card-badges">';
      html += '<span class="badge ' + riskClass + '">risk: ' + esc(t.risk || 'low') + '</span>';
      html += '<span class="badge ' + (t.enabled === false ? 'danger' : '') + '">' + esc(stateLabel) + '</span>';
      if (t.approval_required) html += '<span class="badge warn">approval queue</span>';
      html += '</div>';
      if (hasStats) {
        const rate = Math.round(stats.ok / stats.count * 100);
        const rateColor = rate >= 90 ? '#3fb950' : rate >= 70 ? '#d29922' : '#f85149';
        html += '<div class="tool-card-stats">';
        html += '<span class="stat-item"><i class="fas fa-play"></i> ' + stats.count + '</span>';
        html += '<span class="stat-item"><i class="fas fa-check"></i> ' + stats.ok + '</span>';
        html += '<span class="stat-item"><i class="fas fa-times"></i> ' + stats.fail + '</span>';
        html += '<span class="stat-item"><i class="fas fa-clock"></i> ' + stats.avgMs + 'ms</span>';
        html += '<span class="stat-item" style="color:' + rateColor + '"><i class="fas fa-chart-line"></i> ' + rate + '%</span>';
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
  }
  
  // Add Evolved Procedures section
  if (allProcedures.length > 0) {
    html += '<div class="tool-category-header" style="margin-top:24px">';
    html += '<i class="fas fa-magic"></i>';
    html += '<span class="cat-name">Evolved Procedures</span>';
    html += '<span class="cat-count">' + allProcedures.length + '</span>';
    html += '</div>';
    html += '<div class="tool-grid">';
    for (const p of allProcedures) {
      html += '<div class="tool-card" onclick="showProcedureDetail(\'' + esc(p.name) + '\')">';
      html += '<div class="tool-card-name">' + esc(p.name) + '</div>';
      html += '<div class="tool-card-desc">' + esc(p.description) + '</div>';
      html += '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">';
      html += '<span style="font-size:.68rem;color:#bc8cff;border:1px solid #30363d;border-radius:4px;padding:2px 6px"><i class="fas fa-magic"></i> evolved</span>';
      html += '<span style="font-size:.68rem;color:#8b949e;border:1px solid #30363d;border-radius:4px;padding:2px 6px">' + p.steps.length + ' steps</span>';
      if (p.useCount > 0) {
        html += '<span style="font-size:.68rem;color:#3fb950;border:1px solid #30363d;border-radius:4px;padding:2px 6px">used ' + p.useCount + 'x</span>';
      }
      html += '</div>';
      html += '</div>';
    }
    html += '</div>';
  }
  
  container.innerHTML = html;
}

function showToolDetail(name){
  const t = allTools.find(x => x.name === name);
  if (!t) return;
  const cat = getToolCategory(name);
  const catData = toolCategories.find(c => c.name === cat);
  const catInfo = catData || { icon: 'fa-wrench' };
  const stats = toolStats[name];
  const hasStats = stats && stats.count > 0;
  let html = '<div class="tool-detail-overlay active" onclick="if(event.target===this)this.classList.remove(\'active\')">';
  html += '<div class="tool-detail">';
  html += '<h3><i class="fas ' + catInfo.icon + '" style="margin-right:8px"></i>' + esc(t.name) + '</h3>';
  html += '<div class="td-desc">' + esc(t.description) + '</div>';
  html += '<div class="td-section"><div class="td-label">Category</div><div style="color:#58a6ff">' + esc(cat) + '</div></div>';
  html += '<div class="td-section"><div class="td-label">Policy</div><div style="color:' + (t.enabled === false ? '#f85149' : '#3fb950') + '">' + esc(getToolStateLabel(t)) + ' - risk: ' + esc(t.risk || 'low') + '</div><div style="color:#8b949e;margin-top:4px">' + esc(t.policy || '') + '</div></div>';
  html += '<div class="td-section"><div class="td-label">Approval</div><div style="color:' + (t.approval_required ? '#d29922' : '#8b949e') + '">' + (t.approval_required ? 'Required before execution' : 'Not required') + '</div><div style="color:#8b949e;margin-top:4px">' + esc(t.approval || '') + '</div></div>';
  if (hasStats) {
    const rate = Math.round(stats.ok / stats.count * 100);
    const rateColor = rate >= 90 ? '#3fb950' : rate >= 70 ? '#d29922' : '#f85149';
    html += '<div class="td-section"><div class="td-label">Usage Stats</div>';
    html += '<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;text-align:center">';
    html += '<div><div style="font-size:1.2rem;font-weight:600;color:#58a6ff">' + stats.count + '</div><div style="font-size:.7rem;color:#8b949e">CALLS</div></div>';
    html += '<div><div style="font-size:1.2rem;font-weight:600;color:#3fb950">' + stats.ok + '</div><div style="font-size:.7rem;color:#8b949e">SUCCESS</div></div>';
    html += '<div><div style="font-size:1.2rem;font-weight:600;color:#f85149">' + stats.fail + '</div><div style="font-size:.7rem;color:#8b949e">FAIL</div></div>';
    html += '<div><div style="font-size:1.2rem;font-weight:600;color:#c9d1d9">' + stats.avgMs + 'ms</div><div style="font-size:.7rem;color:#8b949e">AVG</div></div>';
    html += '<div><div style="font-size:1.2rem;font-weight:600;color:' + rateColor + '">' + rate + '%</div><div style="font-size:.7rem;color:#8b949e">RATE</div></div>';
    html += '</div></div>';
  }
  if (t.args && Object.keys(t.args).length) {
    html += '<div class="td-section"><div class="td-label">Arguments</div><div class="td-args">';
    for (const [k, v] of Object.entries(t.args)) {
      const isOpt = String(v).includes('optional');
      html += '<div class="td-arg-row"><span class="td-arg-name">' + esc(k) + '</span><span class="td-arg-type">' + esc(String(v)) + '</span>' + (isOpt ? ' <span style="color:#484f58;font-size:.75rem">(optional)</span>' : '') + '</div>';
    }
    html += '</div></div>';
  }
  html += '<div style="margin-top:16px;text-align:right"><button class="btn btn-outline" onclick="this.closest(\'.tool-detail-overlay\').classList.remove(\'active\')">Close</button></div>';
  html += '</div></div>';
  const existing = document.querySelector('.tool-detail-overlay');
  if (existing) existing.remove();
  document.body.insertAdjacentHTML('beforeend', html);
}

function showProcedureDetail(name){
  const p = allProcedures.find(x => x.name === name);
  if (!p) return;
  let html = '<div class="tool-detail-overlay active" onclick="if(event.target===this)this.classList.remove(\'active\')">';
  html += '<div class="tool-detail">';
  html += '<h3><i class="fas fa-magic" style="margin-right:8px;color:#bc8cff"></i>' + esc(p.name) + '</h3>';
  html += '<div class="td-desc">' + esc(p.description) + '</div>';
  html += '<div class="td-section"><div class="td-label">Type</div><div style="color:#bc8cff"><i class="fas fa-magic"></i> Evolved Procedure</div></div>';
  html += '<div class="td-section"><div class="td-label">Created</div><div style="color:#8b949e">' + (p.createdAt ? new Date(p.createdAt).toLocaleString() : 'Unknown') + '</div></div>';
  if (p.lastUsed) {
    html += '<div class="td-section"><div class="td-label">Last Used</div><div style="color:#8b949e">' + new Date(p.lastUsed).toLocaleString() + '</div></div>';
  }
  html += '<div class="td-section"><div class="td-label">Usage Count</div><div style="color:#3fb950">' + (p.useCount || 0) + ' times</div></div>';
  
  if (p.parameters && Object.keys(p.parameters).length > 0) {
    html += '<div class="td-section"><div class="td-label">Parameters</div><div class="td-args">';
    for (const [k, v] of Object.entries(p.parameters)) {
      html += '<div class="td-arg-row"><span class="td-arg-name">' + esc(k) + '</span><span class="td-arg-type">' + esc(v.type || 'string') + '</span>' + (v.required ? '' : ' <span style="color:#484f58;font-size:.75rem">(optional)</span>') + '</div>';
    }
    html += '</div></div>';
  }
  
  if (p.steps && p.steps.length > 0) {
    html += '<div class="td-section"><div class="td-label">Steps (' + p.steps.length + ')</div>';
    html += '<div style="margin-top:8px">';
    for (let i = 0; i < p.steps.length; i++) {
      const step = p.steps[i];
      html += '<div style="padding:8px;margin-bottom:8px;background:#0d1117;border:1px solid #21262d;border-radius:6px">';
      html += '<div style="font-size:.75rem;color:#58a6ff;margin-bottom:4px">Step ' + (i+1) + ': ' + esc(step.tool) + '</div>';
      html += '<div style="font-size:.75rem;color:#8b949e;font-family:monospace;white-space:pre-wrap">';
      html += esc(JSON.stringify(step.args, null, 2));
      html += '</div></div>';
    }
    html += '</div></div>';
  }
  
  if (p.triggerPhrases && p.triggerPhrases.length > 0) {
    html += '<div class="td-section"><div class="td-label">Trigger Phrases</div>';
    html += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px">';
    for (const phrase of p.triggerPhrases) {
      html += '<span style="font-size:.75rem;color:#c9d1d9;background:#21262d;padding:4px 8px;border-radius:4px">' + esc(phrase) + '</span>';
    }
    html += '</div></div>';
  }
  
  html += '<div style="margin-top:16px;text-align:right"><button class="btn btn-outline" onclick="this.closest(\'.tool-detail-overlay\').classList.remove(\'active\')">Close</button></div>';
  html += '</div></div>';
  const existing = document.querySelector('.tool-detail-overlay');
  if (existing) existing.remove();
  document.body.insertAdjacentHTML('beforeend', html);
}

async function loadBlackbox(){
  const list = $('blackboxIncidentList');
  const detail = $('blackboxDetail');
  if (!list) return;
  const params = new URLSearchParams();
  const q = $('blackboxSearch') ? $('blackboxSearch').value.trim() : '';
  const state = $('blackboxStateFilter') ? $('blackboxStateFilter').value : '';
  if (q) params.set('search', q);
  if (state) params.set('lifecycle_state', state);
  try {
    const [incidentsRes, storageRes] = await Promise.all([
      authFetch('/api/blackbox/incidents?' + params.toString()),
      authFetch('/api/blackbox/storage')
    ]);
    const incidentsData = await incidentsRes.json();
    const storage = await storageRes.json();
    allBlackboxIncidents = incidentsData.incidents || [];
    renderBlackboxSummary(storage);
    renderBlackboxIncidentList();
    if (selectedBlackboxIncident && allBlackboxIncidents.some(i => i.id === selectedBlackboxIncident)) {
      await showBlackboxIncident(selectedBlackboxIncident);
    } else if (!allBlackboxIncidents.length && detail) {
      detail.innerHTML = '<div class="empty">No Black Box incidents yet. Run a capture to create incident evidence.</div>';
    }
  } catch (error) {
    apiError('/api/blackbox/incidents', error);
    list.innerHTML = '<div class="quick-action-error">Failed to load Black Box incidents: ' + esc(error.message) + '</div>';
  }
}

function renderBlackboxSummary(storage){
  const box = $('blackboxSummary');
  if (!box) return;
  box.innerHTML = [
    ['Incidents', storage.incidents || 0, 'stored records'],
    ['Captures', storage.captures || 0, (storage.active_captures || 0) + ' active'],
    ['Sources', storage.sources || 0, (storage.observations || 0) + ' observations'],
    ['Artifacts', formatBytes(storage.artifact_bytes || 0), (storage.artifact_count || 0) + ' files']
  ].map(item => '<div class="metric-card"><span>' + esc(item[0]) + '</span><strong>' + esc(item[1]) + '</strong><small>' + esc(item[2]) + '</small></div>').join('');
}

function renderBlackboxIncidentList(){
  const list = $('blackboxIncidentList');
  if (!list) return;
  if (!allBlackboxIncidents.length) {
    list.innerHTML = '<div class="empty">No matching incidents.</div>';
    return;
  }
  list.innerHTML = allBlackboxIncidents.map(inc => {
    const cls = inc.id === selectedBlackboxIncident ? ' selected' : '';
    const expiry = inc.pinned ? 'pinned' : (inc.expires_at ? 'expires ' + new Date(inc.expires_at).toLocaleDateString() : 'no expiry');
    return '<button class="blackbox-incident' + cls + '" onclick="showBlackboxIncident(\'' + esc(inc.id) + '\')">'
      + '<span><strong>' + esc(inc.title || inc.id) + '</strong><small>' + esc(inc.id) + ' · ' + esc(inc.host || 'unknown host') + '</small></span>'
      + '<span class="blackbox-badges"><em>' + esc(inc.lifecycle_state) + '</em><em>' + esc(inc.severity || 'unknown') + '</em><em>' + esc(expiry) + '</em></span>'
      + '</button>';
  }).join('');
}

async function showBlackboxIncident(id){
  selectedBlackboxIncident = id;
  renderBlackboxIncidentList();
  const detail = $('blackboxDetail');
  if (!detail) return;
  detail.innerHTML = '<div class="empty">Loading incident...</div>';
  try {
    const res = await authFetch('/api/blackbox/incidents/' + encodeURIComponent(id));
    const data = await res.json();
    if (!data.incident) throw new Error(data.error || 'Incident not found');
    renderBlackboxDetail(data.incident);
  } catch (error) {
    detail.innerHTML = '<div class="quick-action-error">' + esc(error.message) + '</div>';
  }
}

function renderBlackboxDetail(incident){
  const captures = incident.captures || [];
  const latest = captures[0];
  let html = '<div class="blackbox-overview">';
  html += '<div><div class="mission-kicker">' + esc(incident.id) + '</div><h3>' + esc(incident.title) + '</h3><p>' + esc(incident.description || 'No description recorded.') + '</p></div>';
  html += '<div class="blackbox-state"><span>' + esc(incident.lifecycle_state) + '</span><small>' + esc(incident.severity || 'unknown') + '</small></div>';
  html += '</div>';
  html += '<div class="blackbox-toolbar">';
  html += '<button class="btn btn-sm btn-outline" onclick="analyzeBlackboxIncident(\'' + esc(incident.id) + '\')"><i class="fas fa-magnifying-glass-chart"></i> Analyze</button>';
  html += '<button class="btn btn-sm btn-outline" onclick="pinBlackboxIncident(\'' + esc(incident.id) + '\')"><i class="fas fa-thumbtack"></i> Pin</button>';
  html += '<button class="btn btn-sm btn-outline" onclick="exportBlackboxIncident(\'' + esc(incident.id) + '\')"><i class="fas fa-download"></i> Export</button>';
  html += '</div>';
  html += '<div class="meta-grid">'
    + '<div><span>Host</span><strong>' + esc(incident.host || 'unknown') + '</strong></div>'
    + '<div><span>Detected</span><strong>' + esc(incident.detected_at ? new Date(incident.detected_at).toLocaleString() : 'unknown') + '</strong></div>'
    + '<div><span>Retention</span><strong>' + esc((incident.pinned ? 'pinned' : incident.retention_class) || 'standard') + '</strong></div>'
    + '<div><span>Expires</span><strong>' + esc(incident.expires_at ? new Date(incident.expires_at).toLocaleString() : 'never') + '</strong></div>'
    + '</div>';
  if (latest) html += renderBlackboxCapture(latest);
  html += renderBlackboxAnalysis(incident.analyses || []);
  html += renderBlackboxTimeline(incident.timeline || []);
  $('blackboxDetail').innerHTML = html;
  if (latest) loadBlackboxSources(latest.id);
}

function renderBlackboxCapture(capture){
  let html = '<div class="td-section"><div class="td-label">Latest Capture</div>';
  html += '<div class="blackbox-capture-head"><strong>' + esc(capture.id) + '</strong><span class="badge ' + (capture.state === 'completed' ? '' : 'warn') + '">' + esc(capture.state) + '</span><span>' + esc(capture.profile) + '</span><span>' + esc(capture.succeeded_count + '/' + capture.source_count + ' succeeded') + '</span><span>' + esc(formatBytes(capture.total_bytes || 0)) + '</span></div>';
  html += '<div id="blackboxSources" class="blackbox-source-grid"><div class="empty">Loading sources...</div></div>';
  html += '</div>';
  return html;
}

async function loadBlackboxSources(captureId){
  const box = $('blackboxSources');
  if (!box) return;
  try {
    const res = await authFetch('/api/blackbox/captures/' + encodeURIComponent(captureId));
    const data = await res.json();
    const sources = data.capture && data.capture.sources ? data.capture.sources : [];
    if (!sources.length) {
      box.innerHTML = '<div class="empty">No sources recorded.</div>';
      return;
    }
    box.innerHTML = sources.map(source => '<button class="blackbox-source ' + esc(source.state) + '" onclick="openBlackboxSource(\'' + esc(source.id) + '\')">'
      + '<strong>' + esc(source.display_name) + '</strong><small>' + esc(source.category || 'Source') + ' · ' + esc(source.duration_ms || 0) + 'ms · exit ' + esc(source.exit_code === null ? 'n/a' : source.exit_code) + '</small>'
      + '<span>' + sourceBadges(source) + '</span></button>').join('');
  } catch (error) {
    box.innerHTML = '<div class="quick-action-error">' + esc(error.message) + '</div>';
  }
}

function sourceBadges(source){
  const badges = ['<em>' + esc(source.state) + '</em>'];
  if (source.timed_out) badges.push('<em>timeout</em>');
  if (source.truncated) badges.push('<em>truncated</em>');
  if (source.redaction_count) badges.push('<em>redacted</em>');
  if (source.error_category) badges.push('<em>' + esc(source.error_category) + '</em>');
  return badges.join('');
}

async function openBlackboxSource(sourceId){
  try {
    const res = await authFetch('/api/blackbox/sources/' + encodeURIComponent(sourceId) + '?limit=131072');
    const data = await res.json();
    const s = data.source;
    let html = '<div class="tool-detail-overlay active" onclick="if(event.target===this)this.classList.remove(\'active\')"><div class="tool-detail blackbox-source-detail">';
    html += '<h3>' + esc(s.display_name) + '</h3>';
    html += '<div class="meta-grid"><div><span>Source</span><strong>' + esc(s.source_key) + '</strong></div><div><span>State</span><strong>' + esc(s.state) + '</strong></div><div><span>Duration</span><strong>' + esc(s.duration_ms || 0) + 'ms</strong></div><div><span>Hash</span><strong>' + esc((s.content_hash || '').slice(0, 16)) + '</strong></div></div>';
    html += '<div class="td-section"><div class="td-label">Collector</div><div class="quick-action-pre">' + esc(s.command + ' ' + (s.arguments_preview || []).join(' ')) + '</div></div>';
    if (s.error_message) html += '<div class="quick-action-error">' + esc(s.error_message) + '</div>';
    html += '<div class="tab-switch"><button class="active">Stdout</button><button>Stderr</button><button>Normalized</button></div>';
    html += '<div class="value-block is-long">' + esc(s.stdout || '') + '</div>';
    if (s.stderr) html += '<div class="td-section"><div class="td-label">Stderr</div><div class="value-block is-long">' + esc(s.stderr) + '</div></div>';
    html += '<div class="td-section"><div class="td-label">Normalized</div><div class="value-block">' + esc(JSON.stringify(s.normalized || {}, null, 2)) + '</div></div>';
    html += '<div style="margin-top:16px;text-align:right"><button class="btn btn-outline" onclick="this.closest(\'.tool-detail-overlay\').remove()">Close</button></div>';
    html += '</div></div>';
    const existing = document.querySelector('.tool-detail-overlay');
    if (existing) existing.remove();
    document.body.insertAdjacentHTML('beforeend', html);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function renderBlackboxAnalysis(analyses){
  if (!analyses.length) return '<div class="td-section"><div class="td-label">Analysis</div><div class="empty">No analysis yet. Run analysis to produce evidence-cited findings.</div></div>';
  const latest = analyses[0];
  let html = '<div class="td-section"><div class="td-label">Analysis</div><div class="blackbox-analysis">';
  html += '<strong>' + esc(latest.summary || 'Analysis') + '</strong><p>' + esc(latest.diagnosis || 'No diagnosis recorded.') + '</p>';
  html += '<div class="blackbox-finding-list">';
  for (const finding of latest.findings || []) html += '<div><span>' + esc(finding.severity || 'info') + '</span>' + esc(finding.claim || '') + '<small> cites ' + esc((finding.source_ids || []).join(', ')) + '</small></div>';
  html += '</div></div></div>';
  return html;
}

function renderBlackboxTimeline(timeline){
  if (!timeline.length) return '';
  return '<div class="td-section"><div class="td-label">Timeline</div><div class="blackbox-timeline">' + timeline.slice(-30).map(ev => '<div><span>' + esc(ev.created_at ? new Date(ev.created_at).toLocaleTimeString() : '') + '</span><strong>' + esc(ev.event_type) + '</strong><small>' + esc(ev.reason || ev.new_state || '') + '</small></div>').join('') + '</div></div>';
}

async function startBlackboxCapture(){
  const profile = $('blackboxProfile') ? $('blackboxProfile').value : 'standard';
  const progress = $('blackboxProgress');
  progress.innerHTML = '<div class="blackbox-progress-title">Starting capture...</div>';
  try {
    const res = await authFetch('/api/blackbox/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile, name: 'Dashboard capture ' + new Date().toLocaleString() })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Capture failed');
    const cap = data.capture;
    progress.innerHTML = '<div class="blackbox-progress-title">Capture ' + esc(cap.state) + ': ' + esc(cap.succeeded_count + '/' + cap.source_count) + ' sources completed</div>';
    selectedBlackboxIncident = cap.incident_id;
    await loadBlackbox();
  } catch (error) {
    progress.innerHTML = '<div class="quick-action-error">' + esc(error.message) + '</div>';
  }
}

async function analyzeBlackboxIncident(id){
  try {
    const res = await authFetch('/api/blackbox/incidents/' + encodeURIComponent(id) + '/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Analysis failed');
    showToast('Analysis recorded with evidence citations', 'info');
    await showBlackboxIncident(id);
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function pinBlackboxIncident(id){
  try {
    await authFetch('/api/blackbox/incidents/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: true, retention_class: 'pinned' }) });
    showToast('Incident pinned', 'info');
    await loadBlackbox();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

async function exportBlackboxIncident(id){
  try {
    const res = await authFetch('/api/blackbox/incidents/' + encodeURIComponent(id) + '/export?format=markdown');
    const data = await res.json();
    const text = typeof data.export === 'string' ? data.export : JSON.stringify(data.export, null, 2);
    const existing = document.querySelector('.tool-detail-overlay');
    if (existing) existing.remove();
    document.body.insertAdjacentHTML('beforeend', '<div class="tool-detail-overlay active" onclick="if(event.target===this)this.remove()"><div class="tool-detail"><h3>Export Preview</h3><div class="value-block is-long">' + esc(text) + '</div><div style="margin-top:16px;text-align:right"><button class="btn btn-outline" onclick="this.closest(\'.tool-detail-overlay\').remove()">Close</button></div></div></div>');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function formatBytes(value){
  const n = Number(value || 0);
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

// -- Refresh -- //
function refresh(){
  // Only refresh live overview pages AND tab is visible
  if (currentPage !== 'mission' && currentPage !== 'system') return;
  if (document.hidden) return;

  if (currentPage === 'mission') {
    loadMissionControl();
  } else {
    const now = new Date();
    $('lastUpdate').textContent = 'updated ' + now.toLocaleTimeString();
    loadSystem(); loadDashboardSummary(); loadLLM(); loadServices();
  }
}

// Restore last viewed tab
const savedPage = localStorage.getItem('sidekick_currentPage');
if (savedPage && savedPage !== 'mission') {
  showPage(savedPage);
}

const toolStatsWindowSelect = $('toolStatsWindow');
if (toolStatsWindowSelect) {
  toolStatsWindow = toolStatsWindowSelect.value === 'utc' ? 'utc' : 'local';
  toolStatsWindowSelect.value = toolStatsWindow;
}

// Fetch tool categories from API before loading other data
fetchToolCategories().then(() => {
  if (currentPage === 'mission') {
    loadMissionControl();
  } else {
    refresh();
    loadSystem();
    loadDashboardSummary();
    loadLLM();
    loadServices();
  }
});
setInterval(refresh, 10000);
