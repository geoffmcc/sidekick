let currentPage = 'system';
let agentRunning = false;
let agentStream = null;
let expandedHistory = {};
let allLogs = [];
let allKV = [];
let logPage = 0;
const LOG_PAGE_SIZE = 50;
const SESSION_GAP_MS = 5 * 60 * 1000;
let allTools = [];
let toolCategories = []; // Will be fetched from API

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
  } catch (error) {
    console.error('Failed to fetch tool categories:', error);
    toolCategories = [];
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

const SERVICE_ICONS = { 'sidekick-mcp': 'fa-server', 'sidekick-agent': 'fa-robot', 'ollama': 'fa-brain' };
const SERVICE_LABELS = { 'sidekick-mcp': 'MCP', 'sidekick-agent': 'Agent', 'ollama': 'Ollama' };
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

function showPage(name){
  currentPage = name;
  localStorage.setItem('sidekick_currentPage', name);
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
  $('page-' + name).classList.add('active');
  $('nav-' + name).classList.add('active');
  loadSystem();
  if (name === 'system') { loadDashboardSummary(); loadLLM(); loadServices(); }
  if (name === 'activity') loadLogs();
  if (name === 'data') loadKV();
  if (name === 'memory') loadMemories();
  if (name === 'database') loadDbStats();
  if (name === 'config') loadConfig();
  if (name === 'tools') loadTools();
  if (name === 'metrics') loadGrafanaDashboard();
}

function loadGrafanaDashboard() {
  const dashboard = $('grafanaDashboard').value;
  const frame = $('grafanaFrame');
  frame.src = `http://192.168.1.10:3000/d/${dashboard}?orgId=1&kiosk`;
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
  authFetch('/api/stats').then(r=>r.json()).then(d=>{
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
  authFetch('/api/logs?limit=500').then(r=>r.json()).then(d=>{
    allLogs = d.entries || [];
    logPage = 0;
    renderLogs();
  }).catch(e => apiError('/api/logs', e, 0));
}

function filterLogs(){
  logPage = 0;
  renderLogs();
}

function getFilteredLogs(){
  const search = ($('logSearch').value || '').toLowerCase();
  const srcFilter = $('logSourceFilter').value;
  const statusFilter = $('logStatusFilter').value;
  return allLogs.filter(e => {
    if (srcFilter && (e.src || 'unknown') !== srcFilter) return false;
    if (statusFilter === 'ok' && !e.ok) return false;
    if (statusFilter === 'fail' && e.ok) return false;
    if (search) {
      const haystack = (e.n + ' ' + e.a + ' ' + e.s).toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function groupSessions(logs){
  if (!logs.length) return [];
  const sessions = [];
  let current = { entries: [logs[0]], src: logs[0].src || 'unknown', startTime: new Date(logs[0].t).getTime() };
  for (let i = 1; i < logs.length; i++) {
    const entry = logs[i];
    const time = new Date(entry.t).getTime();
    const src = entry.src || 'unknown';
    const gap = current.entries[current.entries.length - 1] ? time - new Date(current.entries[current.entries.length - 1].t).getTime() : 0;
    if (gap <= SESSION_GAP_MS && src === current.src) {
      current.entries.push(entry);
    } else {
      sessions.push(current);
      current = { entries: [entry], src: src, startTime: time };
    }
  }
  sessions.push(current);
  return sessions;
}

function renderLogs(){
  const filtered = getFilteredLogs();
  $('logCount').textContent = filtered.length;
  const container = $('logList');
  if (!filtered.length) { 
    container.innerHTML = '<div class="empty">No matching activity</div>'; 
    return; 
  }

  const sessions = groupSessions(filtered);
  const visibleSessions = sessions.slice(0, logPage + 1);
  let html = '';

  visibleSessions.forEach((session, si) => {
    const src = session.src;
    const icon = SOURCE_ICONS[src] || SOURCE_ICONS['unknown'];
    const color = SOURCE_COLORS[src] || SOURCE_COLORS['unknown'];
    const startTime = fmtDate(session.entries[0].t);
    const endTime = fmtDate(session.entries[session.entries.length - 1].t);
    const timeRange = startTime === endTime ? startTime : startTime + ' - ' + endTime.split(' ')[1];

    html += '<div class="session-group">';
    html += '<div class="session-header">';
    html += '<i class="fas ' + icon + '" style="color:' + color + '"></i>';
    html += '<span class="session-time">' + esc(timeRange) + '</span>';
    html += '<span class="session-count">' + session.entries.length + ' calls</span>';
    html += '<span class="session-src">' + esc(src) + '</span>';
    html += '</div>';
    html += '<div class="session-body" id="session-' + si + '">';
    
    session.entries.forEach(e => {
      const errClass = e.ok ? '' : ' error';
      const statusClass = e.ok ? 'ok' : 'fail';
      const statusText = e.ok ? 'OK' : 'FAIL';
      
      html += '<div class="log-entry' + errClass + '">';
      html += '<div class="log-header">';
      html += '<span class="log-time">' + fmtTime(e.t) + '</span>';
      html += '<span class="log-tool">' + esc(e.n) + '</span>';
      html += '<span class="log-status ' + statusClass + '">' + statusText + '</span>';
      html += '</div>';
      
      // Show arguments
      if (e.a) {
        html += '<div class="log-args">' + esc(e.a) + '</div>';
      }
      
      // Show result (expandable)
      if (e.s) {
        const resultId = 'result-' + Math.random().toString(36).substr(2, 9);
        html += '<div class="log-result" id="' + resultId + '" data-result-id="' + resultId + '">';
        html += esc(e.s);
        html += '</div>';
      }
      
      html += '</div>';
    });
    
    html += '</div></div>';
  });

  if (visibleSessions.length < sessions.length) {
    html += '<button class="load-more" onclick="loadMoreLogs()">Show more sessions (' + (sessions.length - visibleSessions.length) + ' remaining)</button>';
  }

  container.innerHTML = html;

  container.querySelectorAll('.log-result[data-result-id]').forEach(el => {
    el.addEventListener('click', function() {
      this.classList.toggle('expanded');
    });
  });

  container.querySelectorAll('.session-header').forEach((el, idx) => {
    el.addEventListener('click', function() {
      const body = this.nextElementSibling;
      if (body) body.classList.toggle('open');
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
  Promise.all([
    authFetch('/api/kv').then(r=>r.json()),
    authFetch('/api/kv/projects').then(r=>r.json())
  ]).then(([kvData, projData]) => {
    allKV = kvData.entries || [];
    
    const select = $('kvProjectFilter');
    if (select) {
      const currentVal = select.value;
      const projects = projData.projects || [];
      select.innerHTML = '<option value="">All Projects</option>' +
        projects.map(p => p === null ? '<option value="null">Global</option>' : '<option value="' + esc(p) + '">' + esc(p) + '</option>').join('');
      select.value = currentVal;
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
  const ageFilter = $('kvAgeFilter') ? $('kvAgeFilter').value : 'all';
  
  let filtered = allKV.filter(e => {
    // Project filter
    if (projectFilter) {
      if (projectFilter === 'null' && e.project !== null) return false;
      if (projectFilter !== 'null' && e.project !== projectFilter) return false;
    }
    
    // Age filter
    if (ageFilter !== 'all') {
      const updated = new Date(e.updated);
      const now = new Date();
      const diffMs = now - updated;
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      
      if (ageFilter === 'today' && diffDays > 1) return false;
      if (ageFilter === 'week' && diffDays > 7) return false;
      if (ageFilter === 'month' && diffDays > 30) return false;
    }
    
    // Search filter
    if (!search) return true;
    return (e.key + ' ' + String(e.value)).toLowerCase().includes(search);
  });
  
  // Sort by updated date (newest first)
  filtered.sort((a, b) => new Date(b.updated) - new Date(a.updated));
  
  $('kvCount').textContent = filtered.length;
  
  // Render Recently Updated section (top 5 entries updated in last 24 hours)
  const now = new Date();
  const recentEntries = allKV.filter(e => {
    const updated = new Date(e.updated);
    const diffMs = now - updated;
    const diffHours = diffMs / (1000 * 60 * 60);
    return diffHours <= 24;
  }).sort((a, b) => new Date(b.updated) - new Date(a.updated)).slice(0, 5);
  
  const recentSection = $('recentlyUpdatedSection');
  const recentList = $('recentlyUpdatedList');
  
  if (recentEntries.length > 0) {
    recentSection.style.display = 'block';
    recentList.innerHTML = recentEntries.map(e => {
      const projectBadge = e.project 
        ? '<span class="kv-project">' + esc(e.project) + '</span>' 
        : '<span class="kv-project">global</span>';
      
      const sourceBadge = e.source 
        ? '<span class="kv-source ' + esc(e.source) + '">' + esc(e.source) + '</span>' 
        : '';
      
      const updatedAgo = formatTimeAgo(e.updated);
      const valuePreview = String(e.value).substring(0, 100);
      const hasMore = String(e.value).length > 100;
      
      const sizeBytes = new Blob([JSON.stringify(e.value)]).size;
      const sizeStr = formatBytes(sizeBytes);
      
      return '<div class="kv-entry" data-key="' + esc(e.key).replace(/"/g, '&quot;') + '">' +
        '<div class="kv-header">' +
          '<span class="kv-key">' + esc(e.key) + '</span>' +
          '<div class="kv-badges">' +
            projectBadge +
            sourceBadge +
            '<span class="kv-size">' + sizeStr + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="kv-timestamps">' +
          '<span><i class="fas fa-edit"></i> Updated ' + updatedAgo + '</span>' +
        '</div>' +
        '<div class="kv-value-preview" data-action="view">' +
          esc(valuePreview) + (hasMore ? '...' : '') +
        '</div>' +
      '</div>';
    }).join('');
    
    // Add click handlers for recently updated entries
    recentList.querySelectorAll('.kv-entry').forEach(entry => {
      const key = entry.dataset.key;
      entry.querySelector('[data-action="view"]').addEventListener('click', () => showValueModal(key));
    });
  } else {
    recentSection.style.display = 'none';
  }
  
  const list = $('kvList');
  if (!filtered.length) { 
    list.innerHTML = '<div class="empty">No matching data</div>'; 
    return; 
  }
  
  // Group by project
  const grouped = {};
  filtered.forEach(e => {
    const project = e.project || 'Global';
    if (!grouped[project]) grouped[project] = [];
    grouped[project].push(e);
  });
  
  // Sort projects: Global first, then alphabetically
  const sortedProjects = Object.keys(grouped).sort((a, b) => {
    if (a === 'Global') return -1;
    if (b === 'Global') return 1;
    return a.localeCompare(b);
  });
  
  let html = '';
  sortedProjects.forEach(project => {
    const entries = grouped[project];
    const projectId = 'project-' + project.toLowerCase().replace(/[^a-z0-9]/g, '-');
    
    html += '<div class="kv-project-section">';
    html += '<div class="kv-project-header" onclick="toggleProjectSection(\'' + esc(projectId) + '\')">';
    html += '<i class="fas fa-chevron-right kv-project-toggle" id="' + projectId + '-toggle"></i>';
    html += '<span class="kv-project-name">' + esc(project) + '</span>';
    html += '<span class="kv-project-count">' + entries.length + ' entries</span>';
    html += '</div>';
    html += '<div class="kv-project-entries" id="' + projectId + '-entries" style="display:none">';
    
    entries.forEach(e => {
      const projectBadge = e.project 
        ? '<span class="kv-project">' + esc(e.project) + '</span>' 
        : '<span class="kv-project">global</span>';
      
      const sourceBadge = e.source 
        ? '<span class="kv-source ' + esc(e.source) + '">' + esc(e.source) + '</span>' 
        : '';
      
      const createdAgo = formatTimeAgo(e.created);
      const updatedAgo = formatTimeAgo(e.updated);
      const isUpdated = e.created !== e.updated;
      
      const valuePreview = String(e.value).substring(0, 300);
      const hasMore = String(e.value).length > 300;
      
      // Calculate entry size
      const sizeBytes = new Blob([JSON.stringify(e.value)]).size;
      const sizeStr = formatBytes(sizeBytes);
      
      html += '<div class="kv-entry" data-key="' + esc(e.key).replace(/"/g, '&quot;') + '">' +
        '<div class="kv-header">' +
          '<span class="kv-key">' + esc(e.key) + '</span>' +
          '<div class="kv-badges">' +
            projectBadge +
            sourceBadge +
            '<span class="kv-size">' + sizeStr + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="kv-timestamps">' +
          '<span><i class="fas fa-plus-circle"></i> Created ' + createdAgo + '</span>' +
          (isUpdated ? '<span><i class="fas fa-edit"></i> Updated ' + updatedAgo + '</span>' : '') +
        '</div>' +
        '<div class="kv-value-preview" data-action="view">' +
          esc(valuePreview) + (hasMore ? '...' : '') +
        '</div>' +
        '<div class="kv-actions">' +
          '<button data-action="edit" title="Edit">' +
            '<i class="fas fa-edit"></i>' +
          '</button>' +
          '<button class="del" data-action="delete" title="Delete">' +
            '<i class="fas fa-trash"></i>' +
          '</button>' +
        '</div>' +
      '</div>';
    });
    
    html += '</div>';
    html += '</div>';
  });
  
  list.innerHTML = html;

  // Add event listeners
  list.querySelectorAll('.kv-entry').forEach(entry => {
    const key = entry.dataset.key;
    entry.querySelector('[data-action="view"]').addEventListener('click', () => showValueModal(key));
    entry.querySelector('[data-action="edit"]').addEventListener('click', () => openEditModal(key));
    entry.querySelector('[data-action="delete"]').addEventListener('click', () => deleteKV(key));
  });
}

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
  $('editValue').value = String(entry.value);
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
  const valuePreview = entry ? String(entry.value).substring(0, 50) : '';
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

async function loadMemories() {
  try {
    const [memRes, projRes] = await Promise.all([
      authFetch('/api/memories?include_disabled=true&limit=500'),
      authFetch('/api/memories/projects')
    ]);
    const memData = await memRes.json();
    const projData = await projRes.json();

    allMemories = memData.memories || [];

    const select = $('memoryProjectFilter');
    if (select) {
      const currentVal = select.value;
      const projects = projData.projects || [];
      select.innerHTML = '<option value="">All Projects</option>' +
        projects.map(p => '<option value="' + esc(p) + '">' + esc(p) + '</option>').join('');
      select.value = currentVal;
    }

    renderMemories();
  } catch (e) {
    apiError('/api/memories', e, 0);
  }
}

function filterMemories() {
  renderMemories();
}

function renderMemories() {
  const search = ($('memorySearch').value || '').toLowerCase();
  const projectFilter = $('memoryProjectFilter') ? $('memoryProjectFilter').value : '';
  const typeFilter = $('memoryTypeFilter') ? $('memoryTypeFilter').value : '';
  const includeDisabled = $('memoryIncludeDisabled') ? $('memoryIncludeDisabled').checked : false;

  let filtered = allMemories.filter(m => {
    if (!includeDisabled && !m.enabled) return false;
    if (projectFilter && m.project !== projectFilter) return false;
    if (typeFilter && m.type !== typeFilter) return false;
    if (search) {
      const text = (m.content + ' ' + m.summary + ' ' + (m.tags || []).join(' ')).toLowerCase();
      if (!text.includes(search)) return false;
    }
    return true;
  });

  filtered.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

  $('memoryCount').textContent = filtered.length;

  const list = $('memoryList');
  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty">No memories found</div>';
    return;
  }

  list.innerHTML = filtered.map(m => {
    const typeColors = {
      fact: '#58a6ff',
      decision: '#d2a8ff',
      preference: '#7ee787',
      procedure: '#ffa657',
      open_thread: '#f778ba',
      observation: '#8b949e',
      session: '#79c0ff',
      tool_call: '#a5d6ff'
    };
    const typeColor = typeColors[m.type] || '#8b949e';
    const stateBadge = m.state === 'superseded' ? '<span class="memory-state superseded">superseded</span>' : '';
    const enabledBadge = m.enabled ? '' : '<span class="memory-state disabled">disabled</span>';
    const confStars = m.confidence >= 0.8 ? '★★★' : m.confidence >= 0.6 ? '★★' : m.confidence >= 0.4 ? '★' : '';

    return '<div class="memory-entry" data-id="' + esc(m.id) + '">' +
      '<div class="memory-header">' +
        '<span class="memory-type" style="color:' + typeColor + '">' + esc(m.type) + '</span>' +
        '<div class="memory-badges">' +
          (m.project ? '<span class="memory-project">' + esc(m.project) + '</span>' : '') +
          enabledBadge +
          stateBadge +
          (confStars ? '<span class="memory-confidence">' + confStars + '</span>' : '') +
          '<span class="memory-confirmed">×' + (m.times_confirmed || 1) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="memory-content">' + esc(m.summary || m.content) + '</div>' +
      '<div class="memory-footer">' +
        '<span class="memory-time">' + formatTimeAgo(m.updated_at) + '</span>' +
        '<div class="memory-actions">' +
          (m.enabled
            ? '<button class="btn btn-sm btn-outline" onclick="disableMemory(\'' + esc(m.id) + '\')">Disable</button>'
            : '<button class="btn btn-sm btn-outline" onclick="enableMemory(\'' + esc(m.id) + '\')">Enable</button>') +
          '<button class="btn btn-sm btn-danger" onclick="deleteMemory(\'' + esc(m.id) + '\')">Delete</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
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

// -- Tools -- //
let toolStats = {};
let allProcedures = [];

function loadTools(){
  Promise.all([
    authFetch('/api/tools').then(r=>r.json()),
    authFetch('/api/stats').then(r=>r.json()),
    authFetch('/api/procedures').then(r=>r.json()),
    authFetch('/api/tool-categories').then(r=>r.json())
  ]).then(([toolsData, statsData, procData, catData]) => {
    allTools = toolsData.tools || [];
    allProcedures = procData.procedures || [];
    toolCategories = catData.categories || [];
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
  let filtered = allTools;
  if (catFilter) filtered = filtered.filter(t => getToolCategory(t.name) === catFilter);
  if (search) filtered = filtered.filter(t => (t.name + ' ' + t.description).toLowerCase().includes(search));
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
      html += '<div class="tool-card" onclick="showToolDetail(\'' + esc(t.name) + '\')">';
      html += '<div class="tool-card-name">' + esc(t.name) + '</div>';
      html += '<div class="tool-card-desc">' + esc(t.description) + '</div>';
      html += '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">';
      html += '<span style="font-size:.68rem;color:#8b949e;border:1px solid #30363d;border-radius:4px;padding:2px 6px">risk: ' + esc(t.risk || 'low') + '</span>';
      if (t.enabled === false) html += '<span style="font-size:.68rem;color:#f85149;border:1px solid #5a1f2b;border-radius:4px;padding:2px 6px">blocked</span>';
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
  html += '<div class="td-section"><div class="td-label">Policy</div><div style="color:' + (t.enabled === false ? '#f85149' : '#3fb950') + '">' + (t.enabled === false ? 'Blocked' : 'Enabled') + ' Â· risk: ' + esc(t.risk || 'low') + '</div><div style="color:#8b949e;margin-top:4px">' + esc(t.policy || '') + '</div></div>';
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

// -- Refresh -- //
function refresh(){
  // Only refresh if on system page AND tab is visible
  if (currentPage !== 'system') return;
  if (document.hidden) return;
  
  const now = new Date();
  $('lastUpdate').textContent = 'updated ' + now.toLocaleTimeString();
  loadSystem(); loadDashboardSummary(); loadLLM(); loadServices();
}

// Restore last viewed tab
const savedPage = localStorage.getItem('sidekick_currentPage');
if (savedPage && savedPage !== 'system') {
  showPage(savedPage);
}

// Fetch tool categories from API before loading other data
fetchToolCategories().then(() => {
  refresh();
  loadSystem();
  loadDashboardSummary();
  loadLLM();
  loadServices();
});
setInterval(refresh, 10000);
