let currentPage = 'mission';
let agentRunning = false;
let agentStream = null;
let currentAgentTaskId = null;
let agentRestoreInFlight = false;
const AGENT_LAST_TASK_KEY = 'sidekick_agent_last_task_id';
const AGENT_ROOT_KEY = 'sidekick_agent_root_task_id';
let activeAgentSession = null;
let agentSubmissionPending = false;
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
let pendingApprovalCount = 0;
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
      <form method="dialog" class="auth-modal-form">
        <h3 class="auth-modal-title">Authentication Required</h3>
        <label class="auth-modal-label">Username:</label>
        <input type="text" id="auth-username" class="auth-modal-input" required>
        <label class="auth-modal-label">Password:</label>
        <input type="password" id="auth-password" class="auth-modal-input auth-modal-password" required>
        <div class="auth-modal-actions">
          <button type="button" id="auth-cancel" class="auth-modal-cancel">Cancel</button>
          <button type="submit" id="auth-submit" class="auth-modal-submit">Login</button>
        </div>
      </form>
    `;
    document.body.appendChild(modal);

    document.getElementById('auth-cancel').addEventListener('click', () => {
      modal.close();
    });

    modal.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const user = document.getElementById('auth-username').value;
      const pass = document.getElementById('auth-password').value;
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username: user, password: pass })
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        alert(detail.error || 'Authentication failed');
        return;
      }
      modal.close();
      if (onSuccess) onSuccess();
    });
  }

  document.getElementById('auth-username').value = '';
  document.getElementById('auth-password').value = '';
  modal.showModal();
}

function showBootstrapModal() {
  let modal = document.getElementById('bootstrap-modal');
  if (!modal) {
    modal = document.createElement('dialog');
    modal.id = 'bootstrap-modal';
    modal.innerHTML = `
      <form method="dialog" class="auth-modal-form bootstrap-modal-form">
        <h3 class="auth-modal-title">Create Sidekick Owner</h3>
        <p class="bootstrap-modal-note">This one-time setup creates the first local Owner account.</p>
        <input type="text" id="bootstrap-username" placeholder="Username" class="auth-modal-input" required>
        <input type="text" id="bootstrap-display-name" placeholder="Display name" class="auth-modal-input" required>
        <input type="password" id="bootstrap-password" placeholder="Password (12+ characters)" class="auth-modal-input auth-modal-password" required>
        <button type="submit" class="auth-modal-submit bootstrap-modal-submit">Create Owner</button>
      </form>`;
    document.body.appendChild(modal);
    modal.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const response = await fetch('/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          username: document.getElementById('bootstrap-username').value,
          displayName: document.getElementById('bootstrap-display-name').value,
          password: document.getElementById('bootstrap-password').value
        })
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        alert(detail.error || 'Owner bootstrap failed');
        return;
      }
      modal.close();
      location.reload();
    });
  }
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
    if (res.status === 503) {
      res.clone().json().then(function(detail) {
        if (detail && detail.code === 'bootstrap-required') showBootstrapModal();
      }).catch(function() {});
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
  // Pending approval requests are inbox state, not a property of the filtered catalog.
  $('toolSummaryApproval').textContent = pendingApprovalCount;
  $('toolSummaryHighRisk').textContent = tools.filter(isHighRiskTool).length;
  $('toolSummaryApprovalGated').textContent = tools.filter(tool => tool.approval_required).length;
}

const SERVICE_ICONS = { 'sidekick-mcp': 'fa-server', 'sidekick-dashboard': 'fa-gauge-high', 'sidekick-agent': 'fa-robot', 'ollama': 'fa-brain' };
const SERVICE_LABELS = { 'sidekick-mcp': 'MCP', 'sidekick-dashboard': 'Dashboard', 'sidekick-agent': 'Agent', 'ollama': 'Ollama' };
const SOURCE_ICONS = { 'agent': 'fa-robot', 'mcp': 'fa-plug', 'unknown': 'fa-circle-question' };
const SOURCE_CLASSES = { agent: 'source-icon-agent', mcp: 'source-icon-mcp', unknown: 'source-icon-unknown' };

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

// Shared rendering primitives keep domain pages honest about loading, empty,
// and unavailable states while leaving record-specific markup to each view.
function viewState(kind, message) {
  const labels = { loading: 'Loading…', empty: 'Nothing recorded.', error: 'Unavailable.' };
  return '<div class="view-state view-state-' + esc(kind) + '" role="status">' + esc(message || labels[kind] || '') + '</div>';
}

function renderRecordList(target, records, render, emptyMessage) {
  if (!target) return;
  if (!Array.isArray(records)) { target.innerHTML = viewState('error'); return; }
  target.innerHTML = records.length ? records.map(render).join('') : viewState('empty', emptyMessage);
}

function renderInspector(target, title, content) {
  if (!target) return;
  target.innerHTML = '<div class="inspector-head"><div class="section-title">Inspector</div><h3>' + esc(title || 'Record') + '</h3></div><div class="inspector-body">' + content + '</div>';
}

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
  if (!document.getElementById('page-' + name)) name = 'mission';
  currentPage = name;
  localStorage.setItem('sidekick_currentPage', name);
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
  $('page-' + name).classList.add('active');
  const navItem = $('nav-' + name);
  if (navItem) navItem.classList.add('active');
  const title = { mission: 'Mission Control', projects: 'Projects', system: 'Health & System', blackbox: 'Black Box', data: 'Data', memory: 'Memory', database: 'Database', config: 'Configuration', agent: 'Agent', handoffs: 'Handoffs', research: 'Research', approvals: 'Approvals', tools: 'Tools', capabilities: 'Capabilities', 'network-scopes': 'Network Scopes', identity: 'Identity', evolve: 'Evolve', compute: 'Compute', predict: 'Predict', brain: 'Brain', metrics: 'Metrics' }[name] || name;
  const titleEl = $('pageTitle');
  if (titleEl) titleEl.textContent = title;
  ensurePageHeader(name, title);
  loadSystem();
  if (name === 'mission') loadMissionControl();
  if (name === 'projects') loadProjects();
  if (name === 'system') { loadDashboardSummary(); loadLLM(); loadServices(); }
  if (name === 'activity') loadLogs();
  if (name === 'blackbox') loadBlackbox();
  if (name === 'data') loadKV();
  if (name === 'memory') loadMemories();
  if (name === 'database') loadDbStats();
  if (name === 'config') loadConfig();
  if (name === 'approvals') { loadApprovals(); loadReconciliations(); }
  if (name === 'tools') loadTools();
  if (name === 'capabilities') loadCapabilities();
  if (name === 'network-scopes') loadNetworkScopes();
  if (name === 'identity') loadIdentityAdmin();
  if (name === 'agent') restoreAgentState();
  if (name === 'handoffs') loadHandoffs();
  if (name === 'research') { loadResearchSources(); loadRepositoryResearch(); }
  if (name === 'evolve') loadEvolve();
  if (name === 'compute') loadCompute();
  if (name === 'predict') { loadPredictStatus(); loadPredict(); }
  if (name === 'brain') loadBrainControlRoom();
  if (name === 'metrics') loadGrafanaDashboard();
}

function routeToPage(name, replace) {
  const target = document.getElementById('page-' + name) ? name : 'mission';
  if (location.hash !== '#' + target) {
    (replace ? history.replaceState : history.pushState).call(history, null, '', '#' + target);
  }
  showPage(target);
  const sidebar = $('appSidebar');
  if (sidebar) sidebar.classList.remove('mobile-open');
}

function ensurePageHeader(name, title) {
  const page = $('page-' + name);
  if (!page || page.querySelector(':scope > .page-header') || ['mission', 'blackbox', 'compute', 'brain', 'metrics', 'projects'].includes(name)) return;
  const descriptions = { system: 'Inspect current service health and system capacity without conflating configuration with runtime state.', activity: 'Review what Sidekick did, grouped by durable session and task context when available.', data: 'Inspect stored records with explicit project and provenance metadata.', memory: 'Review durable learned context separately from operational and session records.', database: 'Inspect bounded database state and governed administration surfaces.', config: 'Review runtime configuration with redacted and unavailable values distinguished.', agent: 'Start and resume durable work with its plan, authority, evidence, and outcome visible.', handoffs: 'Find the latest verified next step for work that crosses sessions or operators.', research: 'Track authorized research workspaces, sources, evidence, and findings.', approvals: 'Review requested effects, scope, risk, and evidence before making a governed decision.', tools: 'Browse the live tool catalog and its effective policy state.', capabilities: 'Inspect installed capability packs and their lifecycle health.', 'network-scopes': 'Review named outbound boundaries and their effective state.', identity: 'Inspect identity and authorization administration state.', evolve: 'Review proposed, trial, approved, and rejected generated capabilities.', predict: 'Separate observed facts, derived predictions, confidence, and evidence.' };
  const header = document.createElement('div');
  header.className = 'page-header';
  const copy = document.createElement('div');
  copy.innerHTML = '<span class="eyebrow">Sidekick workspace</span><h1></h1><p class="page-lede"></p>';
  copy.querySelector('h1').textContent = title;
  copy.querySelector('p').textContent = descriptions[name] || 'Operational information for the selected Sidekick workspace.';
  header.appendChild(copy);
  page.insertBefore(header, page.firstElementChild);
}

function loadProjects() {
  const list = $('projectsList');
  const summary = $('projectsSummary');
  if (!list) return;
  list.innerHTML = '<div class="skeleton-stack"><div class="skeleton-line wide"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>';
  authFetch('/api/projects').then(response => response.json()).then(data => {
    const rows = Array.isArray(data.projects) ? data.projects : [];
    const projects = rows.map(row => row.project || {}).filter(project => project.project_id);
    if (summary) summary.innerHTML = metric('Registered projects', projects.length, 'Canonical project registry; no inferred ownership');
    if (!projects.length) {
      list.innerHTML = '<div class="panel project-empty"><div class="empty">No explicitly scoped projects are recorded yet.</div><p class="sub">Create project metadata through a governed workflow or inspect unscoped records in Data.</p></div>';
      return;
    }
    list.innerHTML = rows.map(row => {
      const project = row.project || {};
      const workspace = row.workspace;
      const sources = Array.isArray(row.sources) ? row.sources : [];
      return '<article class="project-card"><span class="eyebrow">Project workspace</span><h2>' + esc(project.display_name || project.project_id) + '</h2><p>' + esc(project.description || 'No project description recorded.') + '</p><div class="project-meta"><span>' + esc(project.state || 'unknown') + '</span><span>' + sources.length + ' recorded source' + (sources.length === 1 ? '' : 's') + '</span><span>' + (workspace ? 'Workspace configured' : 'Workspace not configured') + '</span></div><button class="btn btn-outline btn-sm" type="button" data-project="' + attr(project.project_id) + '">Inspect project data</button></article>';
    }).join('');
    list.querySelectorAll('[data-project]').forEach(button => button.addEventListener('click', () => { routeToPage('data'); const filter = $('kvProjectFilter'); if (filter) { filter.value = button.dataset.project; if (typeof filterKV === 'function') filterKV(); } }));
  }).catch(error => { list.innerHTML = '<div class="panel project-empty"><div class="error-text">Project data unavailable.</div><p class="sub">' + esc(error.message) + '</p></div>'; });
}

function brainProjectionEmpty(message) { return '<div class="empty">' + esc(message) + '</div>'; }
function brainSpecItems(spec, field) {
  return (Array.isArray(spec && spec[field]) ? spec[field] : []).map(item => typeof item === 'object' ? item.text || item.id || '' : item).filter(Boolean);
}
function renderBrainSpec(brain) {
  const spec = brain.task_specs && brain.task_specs[0] && brain.task_specs[0].spec;
  if (!spec) return brainProjectionEmpty('No TaskSpec recorded for this task.');
  const requirements = brainSpecItems(spec, 'requirements');
  const criteria = brainSpecItems(spec, 'success_criteria');
  const lines = [['Objective', spec.normalized_objective || spec.goal], ['Profile', spec.preferred_profile], ['Requirements', requirements.join(' · ') || 'none'], ['Success criteria', criteria.join(' · ') || 'none'], ['Evidence required', spec.requires_live_evidence ? 'yes' : 'no']];
  return lines.map(item => '<div class="brain-row"><strong>' + esc(item[0]) + '</strong><span>' + esc(String(item[1] || 'not recorded')) + '</span></div>').join('');
}
function renderBrainBelief(brain) {
  const belief = brain.belief && (brain.belief.state || brain.belief);
  if (!belief) return brainProjectionEmpty('No belief snapshot recorded for this task.');
  const coverage = belief.coverage || {};
  const ratio = coverage.required && coverage.required.length ? Math.round((coverage.supported || []).length / coverage.required.length * 100) : 100;
  return [['Status', belief.status || 'unknown'], ['Progress', ratio + '% supported'], ['Hypotheses', (belief.hypotheses || []).length], ['Evidence', (belief.evidence || []).length], ['Missing evidence', (coverage.missing || []).join(', ') || 'none']].map(item => '<div class="brain-row"><strong>' + esc(item[0]) + '</strong><span>' + esc(String(item[1])) + '</span></div>').join('');
}
function renderBrainTraces(brain) {
  const traces = Array.isArray(brain.traces) ? brain.traces : [];
  const events = traces.flatMap(row => (row.trace && Array.isArray(row.trace.events) ? row.trace.events : []).map(event => ({ ...event, trace_id: row.trace_id }))).sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 32);
  if (!events.length) return brainProjectionEmpty('No cognitive activity recorded for this task.');
  return events.map(event => '<div class="brain-row"><strong>' + esc(event.type || 'event') + '</strong><small>' + esc(event.at || 'time not recorded') + ' · trace: ' + esc(event.trace_id || 'unknown') + '</small></div>').join('');
}
function brainRoutingDecisions(data) {
  const brain = data.brain_v3 || {};
  const task = data.task || {};
  const direct = brain.role_routing || task.role_routing || task.routing?.role_routing || task.routing?.roles;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return Object.entries(direct).map(([role, decision]) => ({ role, ...(decision || {}) }));
  const traces = Array.isArray(brain.traces) ? brain.traces : [];
  const decisions = [];
  traces.forEach(row => (row.trace?.events || []).forEach(event => {
    if (!['role.routing', 'role_routing', 'brain.role_routing'].includes(event.type)) return;
    const value = event.data || {};
    decisions.push({ role: value.role || 'unknown', ...value });
  }));
  return decisions;
}
function loadBrainControlRoom() {
  const input = $('brainTaskId');
  const taskId = String((input && input.value) || currentAgentTaskId || localStorage.getItem(AGENT_LAST_TASK_KEY) || '').trim();
  if (!taskId) {
    $('brainStatus').textContent = 'Loading the latest durable Agent task...';
    authFetch('/api/agent/tasks?limit=1').then(r => r.json().then(data => ({ ok: r.ok, data }))).then(({ ok, data }) => {
      const latest = ok && Array.isArray(data.tasks) ? data.tasks[0] : null;
      if (!latest) { $('brainStatus').textContent = 'No durable Agent tasks available to inspect.'; return; }
      const latestId = String(latest.task_id || latest.taskId || '').trim();
      if (!latestId) throw new Error('latest task has no usable id');
      if (input) input.value = latestId;
      loadBrainControlRoom();
    }).catch(error => { $('brainStatus').textContent = 'Brain task list unavailable: ' + (error.message || String(error)); });
    return;
  }
  if (input) input.value = taskId;
  $('brainStatus').textContent = 'Loading durable task metadata...';
  authFetch('/api/agent/tasks/' + encodeURIComponent(taskId) + '/control-room').then(r => r.json().then(data => ({ ok: r.ok, data }))).then(({ ok, data }) => {
    if (!ok || data.error) throw new Error(data.error || 'Brain control-room request failed');
    const task = data.task || {}; const brain = data.brain_v3 || {}; const graph = brain.graph || {};
    const coverage = Array.isArray(graph.coverage) ? graph.coverage : [];
    const recipes = data.verification_recipes || data.verification || [];
    const outcomes = data.verification_outcomes || [];
    const spec = brain.task_specs && brain.task_specs[0];
    const belief = brain.belief && (brain.belief.state || brain.belief);
    $('brainStatus').textContent = 'Task ' + taskId + ' · state: ' + (task.state || 'unknown') + ' · source: ' + (data.source || 'durable_task_store');
    $('brainSummary').innerHTML = [['Spec revision', spec ? spec.revision : 0], ['Belief', belief ? belief.status : 'none'], ['Requirements', coverage.length], ['Supported', coverage.filter(item => item.state === 'supported').length], ['Graph nodes', (graph.nodes || []).length], ['Graph edges', (graph.edges || []).length], ['Verification gates', recipes.length], ['Gate outcomes', outcomes.length]].map(item => '<div class="metric-card"><span>' + esc(item[0]) + '</span><strong>' + esc(String(item[1])) + '</strong></div>').join('');
    $('brainTaskSpec').innerHTML = renderBrainSpec(brain);
    $('brainBeliefState').innerHTML = renderBrainBelief(brain);
    $('brainTraceActivity').innerHTML = renderBrainTraces(brain);
    $('brainGraphCoverage').innerHTML = coverage.length ? coverage.map(item => '<div class="brain-row"><strong>' + esc(item.id) + '</strong><span class="status-badge ' + (item.state === 'supported' ? 'ok' : item.state === 'contradicted' ? 'danger' : 'warn') + '">' + esc(item.state) + '</span><small>evidence: ' + esc((item.evidence_refs || []).join(', ') || 'none') + (item.contradictions?.length ? ' · contradictions: ' + esc(item.contradictions.join(', ')) : '') + '</small></div>').join('') : brainProjectionEmpty('No graph coverage recorded.');
    $('brainVerificationGates').innerHTML = recipes.length ? recipes.slice(0, 64).map(recipe => { const related = outcomes.filter(outcome => String(outcome.recipe_id) === String(recipe.recipe_id)); const successful = related.filter(outcome => outcome.observation_state === 'successful').length; return '<div class="brain-row"><strong>' + esc(recipe.recipe_id || recipe.requirement_id || 'gate') + '</strong><small>' + esc(recipe.check_type || recipe.capability || 'governed check') + ' · ' + successful + '/' + related.length + ' successful outcomes · ' + esc(recipe.independent === false ? 'self-reported' : 'independent') + '</small></div>'; }).join('') : brainProjectionEmpty('No verification recipes recorded.');
    const routing = brainRoutingDecisions(data);
    $('brainRoleRouting').innerHTML = routing.length ? routing.slice(0, 32).map(item => '<div class="brain-row"><strong>' + esc(item.role || 'role') + '</strong><span>' + esc(item.selected || item.model || 'not recorded') + '</span><small>' + esc(item.reason || (item.degraded ? 'degraded' : 'recorded decision')) + (item.data_classification ? ' · classification: ' + esc(item.data_classification) : '') + '</small></div>').join('') : brainProjectionEmpty('No role-routing decisions recorded for this task.');
    const project = task.project_id || task.project || null;
    loadBrainLearningCandidates(project);
  }).catch(error => { $('brainStatus').textContent = 'Brain metadata unavailable: ' + (error.message || String(error)); $('brainSummary').innerHTML = ''; ['brainTaskSpec','brainBeliefState','brainTraceActivity','brainGraphCoverage','brainVerificationGates','brainRoleRouting','brainLearningCandidates'].forEach(id => { if ($(id)) $(id).innerHTML = brainProjectionEmpty('Unavailable.'); }); });
}
function loadBrainLearningCandidates(projectRef) {
  const target = $('brainLearningCandidates'); if (!target) return;
  if (!projectRef) { target.innerHTML = brainProjectionEmpty('No governed project scope attached to this task.'); return; }
  const project = String(projectRef).startsWith('project:') ? String(projectRef) : 'project:' + projectRef;
  authFetch('/api/agent/learning-candidates?project=' + encodeURIComponent(project)).then(r => r.json().then(data => ({ ok: r.ok, data }))).then(({ ok, data }) => {
    if (!ok) throw new Error(data.error || 'candidate request failed');
    const candidates = data.candidates || [];
    target.innerHTML = candidates.length ? candidates.slice(0, 20).map(candidate => '<div class="brain-row"><strong>' + esc(candidate.kind || 'candidate') + '</strong><span>' + esc(candidate.state || 'proposal') + '</span><small>' + esc(candidate.candidate_id || 'unknown') + ' · source: ' + esc(candidate.source_task_id || 'not attached') + '</small></div>').join('') : brainProjectionEmpty('No project-scoped learning candidates.');
  }).catch(error => { target.innerHTML = brainProjectionEmpty('Learning candidates unavailable: ' + (error.message || String(error))); });
}

let repositoryResearchCursor = null;
let selectedResearchRepository = null;
let selectedResearchCampaign = null;
let selectedResearchSnapshot = null;

async function researchJson(url, options) {
  const response = await authFetch(url, options);
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || 'Research source request failed');
  return data;
}

async function loadResearchSources() {
  const readiness = $('researchReadiness'); const repositories = $('researchRepositories');
  try {
    const [status, repoData] = await Promise.all([
      researchJson('/api/research/source/readiness'),
      researchJson('/api/research/source/repositories?limit=25')
    ]);
    const details = status.readiness || {};
    if (readiness) readiness.textContent = 'Workspace: ' + ((details.workspace || {}).state || 'unknown') + ' · Local probes: ' + ((details.policy || {}).local_probes_enabled ? 'enabled' : 'disabled') + ' · Environments: ' + (details.environment_count ?? 0);
    if (repositories) repositories.innerHTML = (repoData.repositories || []).map(repo =>
      '<div class="card compact-card research-source-card"><strong>' + esc(repo.name || repo.repository_id) + '</strong> <span class="sub">' + esc(repo.state) + ' · ' + esc(repo.repository_id) + '</span>' +
      '<div class="research-actions"><button class="btn btn-sm btn-outline" data-dashboard-action="research-select" data-id="' + attr(repo.repository_id) + '" data-campaign="' + attr(repo.campaign_id) + '">Show snapshots</button></div></div>'
    ).join('') || '<div class="empty">No campaign repositories found.</div>';
  } catch (error) { if (readiness) readiness.textContent = error.message; if (repositories) repositories.textContent = 'Unable to load repositories.'; }
}

async function selectResearchRepository(repositoryId, campaignId) {
  selectedResearchRepository = repositoryId; selectedResearchCampaign = campaignId || null; selectedResearchSnapshot = null;
  const output = $('researchSnapshots'); if (output) output.textContent = 'Loading snapshots...';
  try {
    const data = await researchJson('/api/research/source/snapshots?repository_id=' + encodeURIComponent(repositoryId) + '&limit=25');
    if (output) output.innerHTML = (data.snapshots || []).map(snapshot =>
      '<div class="card compact-card research-source-card"><strong>' + esc(snapshot.snapshot_id) + '</strong> <span class="sub">' + esc(snapshot.state) + ' · integrity: ' + esc(snapshot.integrity_status) + ' · authority: ' + esc(snapshot.authority) + '</span>' +
      '<div class="research-actions"><button class="btn btn-sm btn-outline" data-dashboard-action="research-snapshot" data-id="' + attr(snapshot.snapshot_id) + '">Details</button> <button class="btn btn-sm" data-dashboard-action="research-action" data-handler="researchSelect" data-id="' + attr(snapshot.snapshot_id) + '">Select</button> <button class="btn btn-sm btn-outline" data-dashboard-action="research-action" data-handler="researchVerify" data-id="' + attr(snapshot.snapshot_id) + '">Verify</button> <button class="btn btn-sm btn-outline" data-dashboard-action="research-action" data-handler="researchIndex" data-id="' + attr(snapshot.snapshot_id) + '">Index</button> <button class="btn btn-sm btn-outline" data-dashboard-action="research-action" data-handler="researchArchive" data-id="' + attr(snapshot.snapshot_id) + '">Archive</button> <button class="btn btn-sm btn-danger" data-dashboard-action="research-action" data-handler="researchRemove" data-id="' + attr(snapshot.snapshot_id) + '">Remove</button></div></div>'
    ).join('') || '<div class="empty">No snapshots found.</div>';
  } catch (error) { if (output) output.textContent = error.message; }
}

async function showResearchSnapshot(snapshotId) {
  selectedResearchSnapshot = snapshotId;
  try {
    const data = await researchJson('/api/research/source/snapshots/' + encodeURIComponent(snapshotId) + '?repository_id=' + encodeURIComponent(selectedResearchRepository));
    const snapshot = data.snapshot || {}; const verification = snapshot.verification || {};
    $('researchSnapshotDetail').innerHTML = '<div class="sub">State: ' + esc(snapshot.state) + ' · Integrity: ' + esc(snapshot.integrity_status) + ' · Stale: ' + esc(String(verification.stale)) + ' · Files: ' + esc(String(snapshot.file_count ?? 'unknown')) + ' · Ref: ' + esc(snapshot.workspace_ref || 'unavailable') + '</div>';
  } catch (error) { $('researchSnapshotDetail').textContent = error.message; }
}

async function researchAction(action, body) {
  const data = await researchJson('/api/research/source/actions/' + encodeURIComponent(action), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  $('researchActionStatus').textContent = action + ' completed.';
  return data;
}

async function researchVerify(snapshotId) { try { await researchAction('verify', { repository_id: selectedResearchRepository, snapshot_id: snapshotId }); await selectResearchRepository(selectedResearchRepository); } catch (error) { $('researchActionStatus').textContent = error.message; } }
async function researchSelect(snapshotId) { try { await researchAction('select', { repository_id: selectedResearchRepository, snapshot_id: snapshotId }); await loadResearchSources(); } catch (error) { $('researchActionStatus').textContent = error.message; } }
async function researchIndex(snapshotId) { try { await researchAction('index', { repository_id: selectedResearchRepository, snapshot_id: snapshotId, index_action: 'profile', max_chars: 12000 }); await selectResearchRepository(selectedResearchRepository, selectedResearchCampaign); } catch (error) { $('researchActionStatus').textContent = error.message; } }
async function researchArchive(snapshotId) { if (!confirm('Archive this snapshot? It will no longer be selectable.')) return; try { await researchAction('archive', { repository_id: selectedResearchRepository, snapshot_id: snapshotId, confirm: true }); await selectResearchRepository(selectedResearchRepository, selectedResearchCampaign); } catch (error) { $('researchActionStatus').textContent = error.message; } }
async function researchRemove(snapshotId) { if (!confirm('Remove this snapshot and its governed workspace copy? This cannot be undone.')) return; try { await researchAction('remove', { repository_id: selectedResearchRepository, snapshot_id: snapshotId, confirm: true }); await selectResearchRepository(selectedResearchRepository, selectedResearchCampaign); } catch (error) { $('researchActionStatus').textContent = error.message; } }
async function researchImport() {
  const sourcePath = ($('researchImportPath').value || '').trim(); if (!sourcePath || !selectedResearchRepository) { $('researchActionStatus').textContent = 'Select a repository and enter a server directory.'; return; }
  if (!confirm('Import this directory into the selected campaign repository? The source will be copied into the governed research workspace.')) return;
  try { await researchAction('import', { repository_id: selectedResearchRepository, campaign_id: selectedResearchCampaign, source_path: sourcePath, name: selectedResearchRepository }); await loadResearchSources(); } catch (error) { $('researchActionStatus').textContent = error.message; }
}
async function researchRecover() { if (!selectedResearchCampaign) { $('researchActionStatus').textContent = 'Select a campaign before recovery.'; return; } if (!confirm('Recover and remove abandoned staging directories for this campaign?')) return; try { await researchAction('recover', { campaign_id: selectedResearchCampaign, confirm: true }); } catch (error) { $('researchActionStatus').textContent = error.message; } }
async function loadRepositoryResearch(next) {
  const query = (($('researchQuery') || {}).value || '').trim();
  if (!next) repositoryResearchCursor = null;
  const params = new URLSearchParams({ query, limit: '12', max_chars: '12000' });
  if (repositoryResearchCursor) params.set('cursor', repositoryResearchCursor);
  const status = $('researchStatus'); const output = $('researchResults'); const more = $('researchMore');
  if (status) status.textContent = 'Loading a bounded snapshot-bound page...';
  try {
    const response = await authFetch('/api/repository/semantic?' + params.toString()); const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || 'semantic query failed');
    repositoryResearchCursor = data.page && data.page.cursor || null;
    if (status) status.textContent = (data.page && data.page.has_more ? 'More results are available.' : 'End of this snapshot.') + ' Evidence class: ' + ((data.provenance || {}).evidence_class || 'discovery_lead') + '. Completeness: ' + ((data.provenance || {}).completeness || 'unknown') + '.';
    if (output) output.textContent = data.projection || JSON.stringify(data, null, 2);
    if (more) more.hidden = !repositoryResearchCursor;
  } catch (error) { if (status) status.textContent = 'Unable to load repository evidence: ' + error.message; if (more) more.hidden = true; }
}

function identityError(message) {
  const el = $('identityError');
  if (el) el.innerHTML = message ? '<div class="card error-card">' + esc(message) + '</div>' : '';
}

async function loadIdentityAdmin() {
  identityError('');
  try {
    const res = await authFetch('/api/auth/principals');
    const data = await res.json();
    if (!res.ok || data.error) { identityError(data.error || 'Identity administration is not available for this account'); return; }
    const principals = data.principals || [];
    $('identityCount').textContent = principals.length;
    $('identityList').innerHTML = principals.map(principal => {
      const stateAction = principal.enabled ? 'disable' : 'enable';
      const stateLabel = principal.enabled ? 'Disable' : 'Enable';
      const roles = (principal.roles || []).map(role => '<span class="metrics-status-pill ' + (role === 'owner' ? 'warn' : 'ok') + '">' + esc(role) + '</span>').join(' ');
      return '<div class="card compact-card identity-card">'
        + '<div class="identity-header">'
        + '<div><div class="identity-name">' + esc(principal.display_name) + '</div>'
        + '<div class="sub">' + esc(principal.principal_id) + ' · ' + esc(principal.principal_type) + ' · ' + (principal.enabled ? 'enabled' : 'disabled') + '</div></div>'
        + '<div>' + roles + '</div></div>'
        + '<div class="identity-actions"><button class="btn btn-sm btn-outline" data-dashboard-action="identity" data-handler="toggleIdentityPrincipal" data-id="' + attr(principal.principal_id) + '" data-value="' + attr(stateAction) + '">' + stateLabel + '</button>'
        + '<select id="identity-role-' + attr(principal.principal_id) + '"><option value="viewer">Viewer</option><option value="operator">Operator</option><option value="auditor">Auditor</option><option value="administrator">Administrator</option><option value="owner">Owner</option></select>'
        + '<button class="btn btn-sm btn-outline" data-dashboard-action="identity" data-handler="assignIdentityRole" data-id="' + attr(principal.principal_id) + '">Assign role</button></div>'
        + '</div>';
    }).join('') || '<div class="sub">No principals found.</div>';
  } catch (error) { identityError(error.message); }
}

async function createIdentityUser() {
  const body = {
    username: $('identityNewUsername').value,
    display_name: $('identityNewDisplayName').value,
    password: $('identityNewPassword').value,
    role: $('identityNewRole').value,
  };
  const res = await authFetch('/api/auth/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok || data.error) { identityError(data.error || 'User creation failed'); return; }
  $('identityNewPassword').value = '';
  loadIdentityAdmin();
}

async function assignIdentityRole(id) {
  const role = $('identity-role-' + id).value;
  const res = await authFetch('/api/auth/principals/' + encodeURIComponent(id) + '/roles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) });
  const data = await res.json();
  if (!res.ok || data.error) identityError(data.error || 'Role assignment failed');
  else loadIdentityAdmin();
}

async function toggleIdentityPrincipal(id, state) {
  if (state === 'disable' && !confirm('Disable this principal? Existing sessions will be invalidated.')) return;
  const res = await authFetch('/api/auth/principals/' + encodeURIComponent(id) + '/' + state, { method: 'POST' });
  const data = await res.json();
  if (!res.ok || data.error) identityError(data.error || 'Principal state change failed');
  else loadIdentityAdmin();
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
  // Truncating used to end in "expand to view all" with nothing to expand.
  // Delegate to the expandable renderer so the promised control actually
  // exists; callers passing expanded:true still get the full block inline.
  if (long && !opts.expanded) return renderExpandableValue(value, opts);
  return '<pre class="value-block ' + cls + (long ? ' is-long' : '') + '">' + esc(rendered) + '</pre>';
}

function renderExpandableValue(value, opts){
  opts = opts || {};
  const text = displayValue(value);
  const parsed = typeof value === 'string' ? parseMaybeJson(value) : (typeof value === 'object' && value !== null ? value : null);
  const rendered = parsed !== null ? JSON.stringify(parsed, null, 2) : text;
  const cls = parsed !== null ? 'structured-json' : 'structured-text';
  const limit = opts.limit || 900;
  const truncated = rendered.length > limit;
  const id = 'exp-' + Math.random().toString(36).slice(2, 10);
  if (!truncated) {
    return '<pre class="value-block ' + cls + '">' + esc(rendered) + '</pre>';
  }
  const preview = rendered.slice(0, limit);
  return '<div class="expandable-block">' +
    '<pre class="value-block ' + cls + ' expandable-preview" id="' + id + '-preview">' + esc(preview) + '\n… truncated (' + rendered.length.toLocaleString() + ' chars) …</pre>' +
    '<pre class="value-block ' + cls + ' expandable-full" id="' + id + '-full">' + esc(rendered) + '</pre>' +
    '<button class="btn btn-sm btn-outline expandable-toggle" data-dashboard-action="expandable" data-id="' + attr(id) + '">Show full (' + rendered.length.toLocaleString() + ' chars)</button>' +
  '</div>';
}

function toggleExpandable(id, btn){
  const preview = document.getElementById(id + '-preview');
  const full = document.getElementById(id + '-full');
  if (!preview || !full) return;
  const showingFull = full.style.display === 'block';
  if (showingFull) {
    full.style.display = 'none';
    preview.style.display = 'block';
    btn.textContent = 'Show full (' + full.textContent.length.toLocaleString() + ' chars)';
  } else {
    preview.style.display = 'none';
    // Must be an explicit value: the stylesheet sets .expandable-full{display:none},
    // so clearing the inline style would re-hide the block instead of showing it.
    full.style.display = 'block';
    btn.textContent = 'Collapse';
  }
}

function copyBlockText(btn){
  const block = btn.closest('.expandable-block') || btn.closest('.detail-block');
  if (!block) return;
  const full = block.querySelector('.expandable-full') || block.querySelector('.value-block');
  if (!full) return;
  navigator.clipboard.writeText(full.textContent).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  }).catch(() => {
    btn.textContent = 'Copy failed';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
}

function metric(label, value, detail, title){
  // detail is ellipsised by CSS, so mirror it into a tooltip when it may be
  // longer than the card (e.g. a list of provider names).
  const tip = title || detail;
  return '<div class="metric-card"' + (tip ? ' title="' + attr(tip) + '"' : '') + '><span>' + esc(label) + '</span><strong>' + esc(value == null ? '--' : value) + '</strong>' + (detail ? '<small>' + esc(detail) + '</small>' : '') + '</div>';
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
    if (!d.services) { if (container) container.className = 'status-dot unknown'; return; }
    const values = Object.values(d.services);
    const healthy = values.length > 0 && values.every(status => status === 'active');
    const healthDot = $('sidebarHealthDot');
    const healthLabel = $('sidebarHealthLabel');
    if (healthDot) healthDot.className = 'status-dot ' + (healthy ? 'ok' : values.length ? 'danger' : 'unknown');
    if (healthLabel) healthLabel.textContent = healthy ? 'Services healthy' : values.length ? 'Attention required' : 'Health unknown';
    const instanceLabel = $('instanceLabel');
    if (instanceLabel) instanceLabel.textContent = healthy ? 'Instance healthy' : values.length ? 'Instance degraded' : 'Instance unknown';
    if (container) {
      container.className = 'status-dot ' + (healthy ? 'ok' : values.length ? 'danger' : 'unknown');
      container.title = Object.entries(d.services).map(([name, status]) => (SERVICE_LABELS[name] || name) + ': ' + status).join(' · ');
    }
    const serviceList = $('serviceStatusList');
    if (serviceList) serviceList.innerHTML = Object.entries(d.services).map(([name, status]) => {
      const label = SERVICE_LABELS[name] || name;
      const state = status === 'active' ? 'ok' : status ? 'danger' : 'unknown';
      return '<span class="service-status-item"><span class="status-dot ' + state + '" aria-hidden="true"></span><span>' + esc(label) + '</span></span>';
    }).join('');
  }).catch(e => apiError('/api/services', e, 0));
}

// -- System -- //
function loadSystem(){
  return authFetch('/api/system').then(r=>r.json()).then(d=>{
    if(d.error){ if ($('s-uptime')) $('s-uptime').textContent='error'; return }
    if ($('s-uptime')) $('s-uptime').textContent = d.uptime || '?';
    // load_1m is the 1-minute load average (not a percentage — the old code
    // faked a percent from it). Thresholds are relative to the core count:
    // load ≥ cores means saturated, ≥ half the cores means elevated.
    const load1 = Number(d.load_1m);
    const cores = Number(d.cpu_count) || 1;
    if ($('s-cpu')) { $('s-cpu').textContent = Number.isFinite(load1) ? load1 + ' / ' + cores + ' cores' : '?'; $('s-cpu').className = 's-val' + (load1 >= cores ? ' warn' : load1 >= cores * 0.5 ? '' : ' ok'); }
    if ($('s-memory')) $('s-memory').textContent = d.memory.used + '/' + d.memory.total;
    if ($('s-disk')) $('s-disk').textContent = d.disk.free + ' free (' + d.disk.pct + ')';
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
    scoreEl.className = 'mission-score ' + (score >= 80 ? 'ok' : score >= 50 ? 'warn' : 'danger');
    // Load average, honestly labeled (see the "Load 1m" tile label in the HTML).
    $('healthCpu').textContent = d.health.load_1m + ' / ' + d.health.cpu_count + ' cores';
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
      sessionDetailsEl.innerHTML = '<div class="empty summary-empty">No MCP sessions</div>';
    } else {
      sessionDetailsEl.innerHTML = sessionDetails.slice(0, 4).map(s => {
        const label = s.initialized ? 'ready' : 'starting';
        return '<div class="session-detail"><span title="' + esc(s.id || '') + '">' + esc(shortSessionId(s.id)) + '</span><span>' + label + ', idle ' + formatDuration(s.idle) + '</span></div>';
      }).join('') + (sessionDetails.length > 4 ? '<div class="summary-more">+' + (sessionDetails.length - 4) + ' more</div>' : '');
    }
    
    // Recent errors
    const errorsEl = $('recentErrors');
    if(!d.recentErrors || d.recentErrors.length === 0){
      errorsEl.innerHTML = '<div class="empty system-empty">No recent errors</div>';
    } else {
      errorsEl.innerHTML = d.recentErrors.map(e => {
        const time = new Date(e.time).toLocaleTimeString();
        return '<div class="summary-error"><span class="summary-muted">' + time + '</span> ' + esc(e.tool) + '<br><span class="summary-danger">' + esc(e.summary) + '</span></div>';
      }).join('');
    }
    
    // Recent deployments
    const deployEl = $('recentDeployments');
    if(!d.deployments || d.deployments.length === 0){
      deployEl.innerHTML = '<div class="empty system-empty">No deployment info</div>';
    } else {
      deployEl.innerHTML = d.deployments.map(dep => {
        const time = new Date(dep.deployed_at).toLocaleString();
        return '<div class="summary-error"><span class="summary-code">' + esc(dep.commit) + '</span> <span class="summary-muted">(' + esc(dep.branch) + ')</span><br><span class="summary-muted">' + time + '</span></div>';
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
      $('topTools').innerHTML = '<div class="summary-top-tools">Top tools:</div>' +
        top5.map(s => '<div class="summary-tool-row"><span class="summary-tool-name">' + esc(s.name.replace('sidekick_', '')) + '</span><span class="summary-tool-count">' + s.count + '</span></div>').join('');
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
  // 1-minute load average with the core count for context — not a fake percent.
  const cpu = summary && summary.health
    ? summary.health.load_1m + ' / ' + summary.health.cpu_count + ' cores'
    : (system.load_1m != null ? system.load_1m + ' / ' + (system.cpu_count || '?') + ' cores' : '--');
  const mem = system.memory ? system.memory.used + '/' + system.memory.total : '--';
  const disk = system.disk ? system.disk.free + ' free (' + system.disk.pct + ')' : '--';
  $('missionCpu').textContent = cpu;
  $('missionMemory').textContent = mem;
  $('missionDisk').textContent = disk;
  $('missionUptime').textContent = system.uptime || '--';
  // Keep the global status strip in sync with Mission Control's first render.
  // Previously these values were only filled by loadSystem(), which made the
  // initial Mission Control view show ellipses until another tab was opened.
  if ($('s-uptime')) $('s-uptime').textContent = system.uptime || '?';
  if ($('s-cpu')) $('s-cpu').textContent = system.load_1m != null ? system.load_1m + ' / ' + (system.cpu_count || '?') + ' cores' : '?';
  if ($('s-memory')) $('s-memory').textContent = system.memory ? system.memory.used + '/' + system.memory.total : '?';
  if ($('s-disk')) $('s-disk').textContent = system.disk ? system.disk.free + ' free (' + system.disk.pct + ')' : '?';
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
    // load_pct_of_cores > 100 means the 1m load average exceeds the core
    // count — consistent with the metric's real meaning.
    if (health.load_pct_of_cores > 100) items.push({ level: 'warn', title: 'Load pressure: ' + health.load_1m + ' (1m avg, ' + health.cpu_count + ' cores)', detail: 'Check active processes if this persists.' });
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

// Sole definition. There were three; because declarations hoist, the last one
// silently won for every caller and capped at MB, so a multi-GB artifact
// rendered as "3072.0 MB".
function formatBytes(bytes){
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(k)), sizes.length - 1);
  return Math.round(n / Math.pow(k, i) * 10) / 10 + ' ' + sizes[i];
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
  // /api/llm reflects the Compute provider/model registry (the inference
  // authority), not a single Ollama daemon. The endpoint never returned a
  // `size` field; render the provider and health fields it actually sends.
  authFetch('/api/llm').then(r=>r.json()).then(d=>{
    const el = $('llmStatus');
    if (d.status === "unreachable") {
      el.innerHTML = '<div class="llm-card"><span class="llm-dot off"></span><span class="empty">Compute provider registry unavailable' + (d.error ? ': ' + esc(d.error) : '') + '</span></div>';
      return;
    }
    if (d.status === "no_models") {
      el.innerHTML = '<div class="llm-card"><span class="llm-dot warn"></span><span class="empty">No enabled models in the Compute registry</span></div>';
      return;
    }
    el.innerHTML = (d.models || []).map(m => {
      const healthy = m.health === 'healthy' || m.health === 'ok' || m.health === 'up';
      const dot = healthy ? 'on' : (m.health === 'unknown' ? 'warn' : 'off');
      const detail = [m.provider, m.health].filter(Boolean).join(' · ');
      return '<div class="llm-card"><span class="llm-dot ' + dot + '"></span><span class="llm-name">' + esc(m.name) + '</span><span class="llm-size">' + esc(detail) + '</span></div>';
    }).join('');
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
    const timeRange = fmtDate(session.start_time) + (session.end_time && session.end_time !== session.start_time ? ' - ' + fmtTime(session.end_time) : '');
    const tools = (session.tools || []).slice(0, 6).join(', ');
    const title = session.summary || tools || (session.call_count + ' activity calls');
    const subtitle = [timeRange, session.project ? 'project ' + session.project : '', session.grouping === 'time_source_fallback' ? 'fallback grouping' : session.grouping].filter(Boolean).join(' · ');
    html += '<section class="session-group">';
    html += '<button class="session-header" aria-expanded="false" type="button">';
    html += '<i class="fas ' + icon + ' ' + (SOURCE_CLASSES[src] || SOURCE_CLASSES.unknown) + '"></i>';
    html += '<span class="session-main"><strong>' + esc(session.grouping === 'generated_execution' ? 'generated-tool activity' : src + ' activity') + '</strong><small>Click to expand timeline</small></span>';
    html += '<span class="session-count">' + session.call_count + ' calls</span>';
    html += statusBadge(session.failure_count === 0);
    html += '</button>';
    html += '<div class="session-visible-summary"><strong>' + esc(title) + '</strong><p>' + esc(subtitle) + '</p></div>';
    html += '<div class="session-meta"><span>' + esc(src) + '</span>' + (session.project ? '<span>' + esc(session.project) + '</span>' : '') + '<span>' + esc(session.grouping === 'time_source_fallback' ? 'fallback grouping' : session.grouping) + '</span><span>' + esc(tools || 'no tools') + '</span><span>' + session.success_count + ' ok / ' + session.failure_count + ' failed</span><span>' + formatMs(session.duration_ms) + '</span></div>';
    html += '<div class="session-body" id="session-' + si + '">' + (session.entries || []).map(renderLogDetail).join('') + '</div></section>';
  });
  if (visibleSessions.length < allSessions.length) {
    html += '<button class="load-more" data-dashboard-action="callback" data-handler="loadMoreLogs">Show more sessions (' + (allSessions.length - visibleSessions.length) + ' remaining)</button>';
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
  el.innerHTML = '<div class="inspector-head"><div><div class="section-title">Inspector</div><h3>' + esc(entry.key) + '</h3></div><div class="kv-actions"><button data-dashboard-action="callback" data-handler="copyText" data-id="' + attr(entry.key) + '">Copy key</button><button data-dashboard-action="callback" data-handler="copySelectedKVValue">Copy value</button><button data-dashboard-action="callback" data-handler="openEditModal" data-id="' + attr(entry.key) + '">Edit</button><button class="del" data-dashboard-action="callback" data-handler="deleteKV" data-id="' + attr(entry.key) + '">Delete</button></div></div>' +
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
    valueHtml += '<button class="btn btn-sm btn-outline modal-copy-button" data-dashboard-action="copy-modal"><i class="fas fa-copy"></i> Copy</button>';
  }
  
  modal.innerHTML = '<div class="kv-modal-content">' +
    '<div class="kv-modal-header">' +
      '<h3>' + esc(key) + '</h3>' +
      '<button class="kv-modal-close">' +
        '<i class="fas fa-times"></i>' +
      '</button>' +
    '</div>' +
    valueHtml +
  '</div>';
  
  modal.querySelector('.kv-modal-close').addEventListener('click', () => modal.remove());
  document.body.appendChild(modal);
}

function renderJsonTree(obj, depth) {
  if (obj === null) return '<span class="json-null">null</span>';
  if (typeof obj === 'boolean') return '<span class="json-boolean">' + obj + '</span>';
  if (typeof obj === 'number') return '<span class="json-number">' + obj + '</span>';
  if (typeof obj === 'string') return '<span class="json-string">"' + esc(obj) + '"</span>';
  
  const isArray = Array.isArray(obj);
  const entries = isArray ? obj : Object.entries(obj);
  const indent = '  '.repeat(depth);
  const nextIndent = '  '.repeat(depth + 1);
  
  if (entries.length === 0) return isArray ? '[]' : '{}';
  
  let html = '<span class="json-punctuation">' + (isArray ? '[' : '{') + '</span>';
  html += '<div class="json-indent">';
  
  const items = isArray ? entries.map((v, i) => [i, v]) : entries;
  for (const [k, v] of items) {
    const keyStr = isArray ? '' : '<span class="json-key">"' + esc(k) + '"</span>: ';
    const valueStr = renderJsonTree(v, depth + 1);
    html += '<div>' + keyStr + valueStr + '</div>';
  }
  
  html += '</div>';
  html += '<span class="json-punctuation">' + (isArray ? ']' : '}') + '</span>';
  return html;
}

function copyModalValue(btn) {
  const value = btn.previousElementSibling;
  if (!value) return;
  navigator.clipboard.writeText(value.textContent).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  }).catch(() => showToast('Copy failed', 'error'));
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
        .then(r => r.json().then(d => ({ status: r.status, d })).catch(() => ({ status: r.status, d: {} })))
        .then(({ status, d }) => {
          // The route now reports what actually happened: deleted:true for a
          // real deletion, 404 when the key was already gone.
          if (d.ok && d.deleted) {
            loadKV();
            showToast('Entry deleted successfully', 'success');
          } else if (status === 404 || d.deleted === false) {
            loadKV();
            showToast('Key not found — it may have already been deleted', 'warning');
          } else {
            showToast('Delete failed: ' + (d.error || ('HTTP ' + status)), 'error');
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
          details: `<strong>Exported at:</strong> ${data.exported_at || 'Unknown'}<br><strong>Version:</strong> ${data.version || 'Unknown'}<br><strong>Entries:</strong> ${data.entries.length}<br><br><span class="summary-danger">⚠️ This will overwrite existing entries with the same keys!</span>`,
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
      '<div><span class="summary-accent">' + esc(type) + '</span>: ' + count + '</div>'
    ).join('');
  } else {
    $('memStatsByType').innerHTML = '<div class="empty">No data</div>';
  }

  const byProject = stats.by_project || {};
  const projEntries = Object.entries(byProject);
  if (projEntries.length > 0) {
    $('memStatsByProject').innerHTML = projEntries.map(([proj, count]) =>
      '<div><span class="summary-accent">' + esc(proj) + '</span>: ' + count + '</div>'
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
      (m.enabled ? '<button class="btn btn-sm btn-outline" data-dashboard-action="callback" data-handler="disableMemory" data-id="' + attr(m.id) + '">Disable</button>' : '<button class="btn btn-sm btn-outline" data-dashboard-action="callback" data-handler="enableMemory" data-id="' + attr(m.id) + '">Enable</button>') +
      '<button class="btn btn-sm btn-danger" data-dashboard-action="callback" data-handler="deleteMemory" data-id="' + attr(m.id) + '">Delete</button></div></div>' +
    '<details class="detail-block"><summary>Full content and metadata</summary>' +
      '<div class="memory-full">' + esc(m.content || '') + '</div>' +
      '<div class="meta-grid"><div><span>Created</span><strong>' + esc(m.created_at ? fmtDate(m.created_at) : 'unknown') + '</strong></div><div><span>Observed</span><strong>' + esc(m.observed_at ? fmtDate(m.observed_at) : 'unknown') + '</strong></div><div><span>Valid</span><strong>' + esc((m.valid_from || 'unknown') + ' to ' + (m.valid_to || 'current')) + '</strong></div><div><span>Scope</span><strong>' + esc(scope) + '</strong></div><div><span>Authority</span><strong>' + esc(String(m.source_authority || 'unknown')) + '</strong></div><div><span>Directness</span><strong>' + esc(m.directness || 'unknown') + '</strong></div><div><span>Task</span><strong>' + esc(m.source_task_id || 'none') + '</strong></div><div><span>Importance</span><strong>' + esc(m.importance || 'normal') + '</strong></div><div><span>Expires</span><strong>' + esc(m.expires_at || 'none') + '</strong></div><div><span>Revalidate</span><strong>' + esc(m.revalidate_after || 'none') + '</strong></div><div><span>Tags</span><strong>' + esc((m.tags || []).join(', ') || 'none') + '</strong></div></div>' +
      renderStructuredValue({ id: m.id, type: m.type, category: m.category, state: m.state, automatic: m.automatic, metadata: m.metadata || {} }, { expanded: true }) +
    '</details>' +
  '</article>';
}

// Shared result check: the routes now return real status codes, and a
// mutation that reports failure must not be presented as done — previously
// the response body was ignored entirely for disable/enable/delete.
async function memoryMutation(url, options) {
  const res = await authFetch(url, options);
  let d = {};
  try { d = await res.json(); } catch {}
  if (!res.ok || !d.ok) throw new Error((d && d.error) || ('HTTP ' + res.status));
  return d;
}

async function disableMemory(id) {
  if (!confirm('Disable this memory?')) return;
  try {
    await memoryMutation('/api/memories/' + encodeURIComponent(id) + '/disable', { method: 'POST' });
    showToast('Memory disabled', 'success');
    loadMemories();
  } catch (e) {
    showToast('Failed to disable: ' + e.message, 'error');
  }
}

async function enableMemory(id) {
  try {
    await memoryMutation('/api/memories/' + encodeURIComponent(id) + '/enable', { method: 'POST' });
    showToast('Memory enabled', 'success');
    loadMemories();
  } catch (e) {
    showToast('Failed to enable: ' + e.message, 'error');
  }
}

async function deleteMemory(id) {
  if (!confirm('Delete this memory permanently?')) return;
  try {
    await memoryMutation('/api/memories/' + encodeURIComponent(id), { method: 'DELETE' });
    showToast('Memory deleted', 'success');
    loadMemories();
  } catch (e) {
    showToast('Failed to delete: ' + e.message, 'error');
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
  $('agentClear').disabled = true;
  $('agentLog').innerHTML = '<span class="agent-step">► Starting agent...</span>\n';

  authFetch('/api/agent/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal, profile: (($('agentProfile') || {}).value || 'standard') })
  }).then(r=>r.json()).then(data => {
    if (data.error) {
      appendLog('<span class="agent-err">✖ Error: ' + esc(data.error) + '</span>');
      finishAgentStream();
      return;
    }
    const taskId = data.taskId;
    streamAgentTask(taskId, { reset: false });
  }).catch(e => {
    appendLog('<span class="agent-err"> Request failed: ' + esc(e.message) + '</span>');
    apiError('/api/agent/run', e, 0);
    finishAgentStream();
  });
}

function loadDurableAgentTask(taskId){
  if (!taskId) return Promise.resolve();
  return authFetch('/api/agent/tasks/' + encodeURIComponent(taskId)).then(r => r.json().then(data => ({ ok:r.ok, data }))).then(({ok,data}) => {
    if (!ok || !data.task) return;
    const task = data.task;
    const state = $('agentDurableState');
    const objective = $('agentDurableObjective');
    const authority = $('agentDurableAuthority');
    const details = $('agentDurableDetails');
    const verification = $('agentDurableVerification');
    const work = $('agentDurableWork');
    const evidence = $('agentDurableEvidence');
    const escalation = $('agentDurableEscalation');
    const result = $('agentDurableResult');
    const continuationActions = $('agentDurableContinuationActions');
    const plan = $('agentDurablePlan');
    const failures = $('agentDurableFailures');
    if (state) state.textContent = 'State: ' + (task.state || 'unknown') + ' · Phase: ' + (task.phase || 'unknown') + ' · Profile: ' + (task.profile || 'standard') + ' · Revision: ' + (task.current_plan_revision || 0);
    if (objective) objective.textContent = 'Objective: ' + (task.objective || task.normalized_objective || 'not recorded') + ' · Normalized: ' + (task.normalized_objective || 'not recorded');
    if (authority) { const a = task.authority_envelope || {}; authority.textContent = 'Effective authority: effects=' + ((a.allowed_effects || []).join(', ') || 'read_only') + ' · prohibited=' + ((a.prohibited_effects || []).join(', ') || 'none') + ' · projects=' + ((a.permitted_projects || []).join(', ') || 'task scope') + ' · workspaces=' + ((a.permitted_workspaces || []).join(', ') || 'task scope') + ' · repositories=' + ((a.permitted_repositories || []).join(', ') || 'task scope') + ' · approval=' + (a.approval_threshold || 'high') + ' · expires=' + (a.expires_at || 'none'); }
    if (details) { const a = task.authority_envelope || {}; const u = task.usage || {}; const b = task.budget || {}; const remaining = key => Number.isFinite(Number(b[key])) ? Math.max(0, Number(b[key]) - Number(u[key] || 0)) : '?'; details.textContent = 'Next: ' + (task.next_action || 'none') + ' · Requirements: ' + ((task.requirements || []).filter(r => r.state === 'satisfied').length) + '/' + ((task.requirements || []).length) + ' satisfied · Effects: ' + ((a.allowed_effects || []).join(', ') || 'read_only') + ' · Scope: ' + (a.permitted_projects || []).join(', ') + ' · Milestone: ' + (task.current_milestone || 'none') + ' · Updated: ' + (task.updated_at || 'unknown'); const usage = $('agentDurableUsage'); if (usage) usage.textContent = 'Resources used/remaining: model ' + (u.model_calls || 0) + '/' + remaining('model_calls') + ' · tools ' + (u.tool_calls || 0) + '/' + remaining('tool_calls') + ' · plan revisions ' + (u.plan_revisions || 0) + '/' + remaining('plan_revisions') + ' · retries ' + (u.retries || 0) + '/' + remaining('retries') + ' · repairs ' + (u.repair_cycles || 0) + '/' + remaining('repair_cycles') + ' · verification ' + (u.verification_calls || 0) + '/' + remaining('verification_calls') + ' · waiting ms ' + (u.waiting_ms || 0) + '/' + remaining('waiting_ms') + ' · idle ms ' + (u.idle_ms || 0) + '/' + remaining('idle_ms'); }
    if (verification) { const outcomes = data.verification_outcomes || []; const recipes = data.verification_recipes || data.verification || []; const recipeById = Object.fromEntries(recipes.map(recipe => [String(recipe.recipe_id), recipe])); const outcomeFresh = outcome => { if (outcome.freshness_state !== 'fresh' || !outcome.observed_at) return outcome.freshness_state === 'fresh'; const recipe = recipeById[String(outcome.recipe_id)]; const age = Date.now() - Date.parse(outcome.observed_at); const windowMs = Number(recipe && recipe.freshness_ms); return Number.isFinite(age) && age >= 0 && (!Number.isFinite(windowMs) || age <= windowMs); }; const successful = outcomes.filter(o => o.observation_state === 'successful').length; const fresh = outcomes.filter(o => outcomeFresh(o) && o.independence_state === 'independent').length; verification.textContent = 'Verification: ' + ((task.verification && task.verification.status) || (task.result && task.result.status) || 'pending') + ' · Gates: ' + recipes.length + ' · Evidence outcomes: ' + outcomes.length + ' (' + successful + ' successful, ' + fresh + ' fresh independent) · Checkpoint: ' + ((task.checkpoint && task.checkpoint.safe_boundary) || 'none') + ' · Workspace: ' + (task.workspace_ref || 'none') + ' · Lineage: ' + (task.parent_task_id ? 'child of ' + task.parent_task_id + ' · root ' + (task.root_task_id || 'unknown') : 'root'); }
    if (work) { const packages = data.work_packages || []; const receipts = data.receipts || []; const active = packages.filter(p => p.state === 'running').length; const completed = packages.filter(p => p.state === 'completed').length; const current = receipts.find(r => r.outcome_state === 'dispatched'); work.textContent = 'Work: milestone=' + (task.current_milestone || 'none') + ' · package=' + (task.active_work_package || 'none') + ' · packages=' + packages.length + ' (' + active + ' active, ' + completed + ' completed) · concurrency=' + (((task.authority_envelope || {}).concurrency_limit) || 1) + ' · current operation=' + (current ? (current.capability || 'operation') + ' [' + current.receipt_id + ']' : 'none'); }
    if (evidence) { const outcomes = data.verification_outcomes || []; const artifacts = task.artifact_refs || []; evidence.textContent = 'Evidence and custody: outcomes=' + outcomes.length + ' · successful=' + outcomes.filter(o => o.observation_state === 'successful').length + ' · failed=' + outcomes.filter(o => o.observation_state === 'failed').length + ' · contradictory=' + outcomes.filter(o => o.observation_state === 'contradictory').length + ' · artifacts=' + artifacts.length + ' · fresh evidence is required for verified status.'; }
    if (escalation) { const rows = data.escalations || []; escalation.textContent = rows.length ? 'Needs attention: ' + rows.slice(0, 4).map(row => (row.requested_operation || 'operation') + ' — ' + (row.reason || 'review required')).join(' · ') : 'Approval, information, and escalation needs: none recorded.'; }
    if (result) { let structured = task.result; try { structured = structured == null ? null : JSON.stringify(structured); } catch (_) { structured = '[unavailable]'; } result.textContent = 'Structured result: ' + (structured || 'not available') + ' · stopping reason: ' + (task.stopping_reason || 'none'); }
    if (continuationActions) {
      const terminal = ['completed', 'partial', 'failed', 'blocked', 'interrupted', 'waiting'].includes(task.state);
      const actionKinds = [['investigate', 'Investigate finding'], ['implement', 'Implement recommendation'], ['verify', 'Verify claim'], ['repair', 'Repair failure'], ['compare', 'Compare alternatives'], ['deliverable', 'Produce deliverable'], ['continue', 'Continue unresolved work'], ['apply', 'Apply approved proposal'], ['monitor', 'Monitor condition'], ['recheck', 'Recheck condition']];
      continuationActions.innerHTML = terminal && !agentRunning
        ? '<span class="sub">Continuation creates a new governed task; it receives fresh authorization and no inherited approval.</span><div class="agent-continuation-actions">' + actionKinds.map(item => '<button class="btn btn-sm btn-outline" type="button" data-dashboard-action="agent" data-handler="startAgentContinuation" data-value="' + attr(item[0]) + '">' + item[1] + '</button>').join('') + '</div>'
        : '';
    }
    if ($('agentResume')) $('agentResume').disabled = !['paused', 'interrupted', 'blocked'].includes(task.state) || agentRunning;
    if (plan) { const revisions = data.hierarchical_plans || data.plans || []; const latest = revisions[0] || {}; const milestones = (latest.milestones || []).map(m => m.id + ':' + (m.state || 'pending')).join(', ') || 'none'; const gates = (latest.verification_gates || []).map(g => g.id || g.recipe_id || g.requirement_id).join(', ') || 'none'; plan.textContent = revisions.length ? 'Plan revisions: ' + revisions.map(p => '#' + p.revision + ' ' + (p.source || 'planner') + (p.active_work_package ? ' · active ' + p.active_work_package : '')).join(' · ') + ' · milestones: ' + milestones + ' · verification gates: ' + gates : 'No durable plan revisions yet'; }
    if (failures) { const rows = data.failures || []; const receipts = data.receipts || []; const repairs = data.repairs || []; const packages = data.work_packages || []; const transactions = data.workspace_transactions || []; const escalations = data.escalations || []; failures.textContent = (rows.length ? 'Failures: ' + rows.slice(0, 5).map(f => (f.capability || 'operation') + ' [' + (f.error_class || 'unknown') + ']').join(' · ') : 'No recorded failures') + (receipts.length ? ' · Receipts: ' + receipts.slice(-5).map(r => (r.capability || 'operation') + ' [' + (r.outcome_state || 'pending') + ']').join(' · ') : ' · No operation receipts') + ' · Repairs: ' + repairs.length + ' · Work packages: ' + packages.length + ' · Transactions: ' + transactions.length + (escalations.length ? ' · Escalations: ' + escalations.length : ''); }
    loadAgentLearningCandidates(task.project_id || task.project || null);
  }).catch(() => {});
}

function startAgentContinuation(kind) {
  const id = currentAgentTaskId;
  const allowed = new Set(['investigate', 'implement', 'verify', 'repair', 'compare', 'deliverable', 'continue', 'apply', 'monitor', 'recheck']);
  if (!id || !allowed.has(kind) || agentRunning) return;
  authFetch('/api/agent/tasks/' + encodeURIComponent(id) + '/act-on', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind })
  }).then(r => r.json().then(data => ({ ok: r.ok, data }))).then(({ ok, data }) => {
    if (!ok || !data.taskId) throw new Error(data.error || 'Continuation failed');
    streamAgentTask(data.taskId, { reset: false, parentTaskId: id, announce: true });
  }).catch(error => appendLog('<span class="agent-err">Continuation failed: ' + esc(error.message) + '</span>'));
}

function loadAgentLearningCandidates(projectRef) {
  const target = $('agentLearningCandidates');
  if (!target || !projectRef) { if (target) target.textContent = 'No governed project scope is attached to this task.'; return; }
  const project = String(projectRef).startsWith('project:') ? String(projectRef) : 'project:' + String(projectRef);
  authFetch('/api/agent/learning-candidates?project=' + encodeURIComponent(project)).then(r => r.json()).then(data => {
    const candidates = data.candidates || [];
    target.innerHTML = candidates.length ? candidates.slice(0, 20).map(candidate => {
      const label = esc(candidate.kind || 'candidate') + ' · ' + esc(candidate.state || 'proposal');
      const id = jsArg(candidate.candidate_id); const ref = jsArg(project);
      return '<div class="agent-learning-candidate"><span>' + label + '</span> <button class="btn btn-sm btn-outline" data-dashboard-action="callback" data-handler="reviewAgentLearningCandidate" data-id="' + attr(candidate.candidate_id) + '" data-value="trial" data-index="' + attr(project) + '">Trial</button> <button class="btn btn-sm btn-outline" data-dashboard-action="callback" data-handler="reviewAgentLearningCandidate" data-id="' + attr(candidate.candidate_id) + '" data-value="rejected" data-index="' + attr(project) + '">Reject</button> <button class="btn btn-sm btn-outline" data-dashboard-action="callback" data-handler="reviewAgentLearningCandidate" data-id="' + attr(candidate.candidate_id) + '" data-value="active" data-index="' + attr(project) + '">Promote</button></div>';
    }).join('') : 'No project-scoped learning candidates.';
  }).catch(() => { target.textContent = 'Learning candidates unavailable.'; });
}

function reviewAgentLearningCandidate(candidateId, projectRef, state) {
  if (state === 'active' && !confirm('Promote this reviewed candidate? Promotion does not grant authority or activate executable behavior.')) return;
  const body = { project_ref: projectRef, state, evaluation: { reviewed_at: new Date().toISOString() } };
  authFetch('/api/agent/learning-candidates/' + encodeURIComponent(candidateId) + '/review', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) }).then(r => r.json()).then(() => loadAgentLearningCandidates(projectRef)).catch(() => {});
}

function pauseAgentTask(){
  const id = currentAgentTaskId;
  if (!id) return;
  authFetch('/api/agent/tasks/' + encodeURIComponent(id) + '/pause', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' })
    .then(r => r.json().then(data => ({ok:r.ok,data}))).then(({ok,data}) => {
      appendLog('<span class="agent-step">' + esc(ok ? 'Pause requested; the task will stop at a safe boundary.' : (data.error || 'Pause failed')) + '</span>');
      loadDurableAgentTask(id);
    }).catch(e => appendLog('<span class="agent-err">Pause failed: ' + esc(e.message) + '</span>'));
}

function resumeAgentTask(){
  const id = currentAgentTaskId;
  if (!id || agentRunning) return;
  if ($('agentResume')) $('agentResume').disabled = true;
  authFetch('/api/agent/tasks/' + encodeURIComponent(id) + '/resume', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' })
    .then(r => r.json().then(data => ({ok:r.ok,data}))).then(({ok,data}) => {
      if (!ok || data.error) throw new Error(data.error || 'Resume failed');
      streamAgentTask(data.taskId || id, { reset:false, reconnect:true });
    }).catch(e => { appendLog('<span class="agent-err">Resume failed: ' + esc(e.message) + '</span>'); loadDurableAgentTask(id); });
}

function sendAgentGuidance(){
  const input = $('agentGuidance');
  if (!input || !currentAgentTaskId || !input.value.trim()) return;
  const text = input.value.trim();
  authFetch('/api/agent/tasks/' + encodeURIComponent(currentAgentTaskId) + '/guidance', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ guidance:text }) })
    .then(r => r.json().then(data => ({ok:r.ok,data}))).then(({ok,data}) => { if (ok) { input.value=''; appendLog('<span class="agent-step">Guidance saved for the durable task.</span>'); loadDurableAgentTask(currentAgentTaskId); } else appendLog('<span class="agent-err">' + esc(data.error || 'Guidance failed') + '</span>'); }).catch(e => appendLog('<span class="agent-err">' + esc(e.message) + '</span>'));
}

// Shared streaming used by a follow-up child (and available for reuse). The
// server-side transcript and lineage remain authoritative; this renders only
// the live SSE and understands the follow-up `lineage` event.
function streamAgentTask(taskId, opts){
  opts = opts || {};
  agentRunning = true;
  currentAgentTaskId = taskId;
  rememberAgentTask(taskId);
  $('agentGo').disabled = true;
  $('agentStop').disabled = false;
  $('agentClear').disabled = true;
  if (opts.reset) $('agentLog').innerHTML = '';
  if (opts.parentTaskId) {
    appendLog('<span class="agent-step">Follow-up to task ' + esc(opts.parentTaskId) +
      (opts.rootTaskId ? ' · thread root ' + esc(opts.rootTaskId) : '') + '</span>');
  }
  if (opts.announce !== false) {
    appendLog('<span class="agent-step">' + (opts.reconnect ? 'Reconnected to' : 'Task') + ' ' + esc(taskId) + (opts.reconnect ? '' : ' started') + '</span>');
  }
  agentStream = new EventSource('/api/agent/stream/' + taskId);
  agentStream.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (err) { return; }
    if (msg.type === 'lineage') {
      appendLog('<span class="agent-step">Thread: follow-up to ' + esc(msg.parentTaskId) +
        ', root ' + esc(msg.rootTaskId) + ' (depth ' + esc(String(msg.depth)) + ')</span>');
    } else if (msg.type === 'step') appendLog('<span class="agent-step">' + esc(msg.text) + '</span>');
    else if (msg.type === 'tool') appendLog('  <span class="agent-ok">' + esc(msg.tool) + '</span> ' + esc(msg.summary || ''));
    else if (msg.type === 'error') { appendLog('<span class="agent-err">' + esc(msg.text) + '</span>'); finishAgentStream(); }
    else if (msg.type === 'done') { appendLog('<span class="agent-done">' + esc(msg.text) + '</span>'); finishAgentStream(); }
  };
  agentStream.onerror = () => finishAgentStream();
}

// Reveal a terminal task's detail (which contains the follow-up form) and focus it.
function openFollowup(id){
  if (!expandedHistory[id]) toggleRunDetail(id);
  setTimeout(() => { const el = $('followup-input-' + id); if (el) el.focus(); }, 60);
}

// Submit a follow-up against a terminal parent task. Guards duplicate submission
// while a run is in flight and while this request is pending.
function submitFollowup(id){
  if (agentRunning) return;
  const input = $('followup-input-' + id);
  const goal = input ? input.value.trim() : '';
  if (!goal) return;
  const btn = document.querySelector('button[data-action="followup-submit"][data-id="' + id + '"]');
  agentRunning = true;
  $('agentGo').disabled = true;
  $('agentStop').disabled = false;
  $('agentClear').disabled = true;
  if (btn) btn.disabled = true;
  if (input) input.disabled = true;
  $('agentLog').innerHTML = '';
  appendLog('<span class="agent-step">Following up on task ' + esc(id) + '</span>');
  authFetch('/api/agent/run/' + id + '/follow-up', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ goal })
  }).then(r => r.json().then(data => ({ status: r.status, data })))
    .then(({ status, data }) => {
      if (status >= 400 || !data || data.error) {
        appendLog('<span class="agent-err">' + esc((data && data.error) || ('HTTP ' + status)) + '</span>');
        finishAgentStream();
        if (btn) btn.disabled = false;
        if (input) input.disabled = false;
        return;
      }
      streamAgentTask(data.taskId, { reset: false, parentTaskId: data.parentTaskId || id, rootTaskId: data.rootTaskId });
    })
    .catch(e => {
      appendLog('<span class="agent-err">Request failed: ' + esc(e.message) + '</span>');
      apiError('/api/agent/run/' + id + '/follow-up', e, 0);
      finishAgentStream();
      if (btn) btn.disabled = false;
      if (input) input.disabled = false;
    });
}

function appendLog(html){
  $('agentLog').innerHTML += html + '\n';
  $('agentLog').scrollTop = $('agentLog').scrollHeight;
}

function rememberAgentTask(taskId){
  if (!taskId) return;
  currentAgentTaskId = taskId;
  try { localStorage.setItem(AGENT_LAST_TASK_KEY, taskId); } catch (e) { /* storage may be unavailable */ }
}

function readRememberedAgentTask(){
  try { return localStorage.getItem(AGENT_LAST_TASK_KEY); } catch (e) { return null; }
}

function renderAgentTranscript(run){
  const steps = run && Array.isArray(run.steps) ? run.steps : [];
  let html = '';
  steps.forEach(s => {
    if (s.type === 'thought') html += '<span class="agent-step">◄ ' + esc(s.text) + '</span>\n';
    else if (s.type === 'tool') html += '  <span class="agent-ok">→ ' + esc(s.tool) + '</span> ' + esc(s.args ? JSON.stringify(s.args) : '') + '\n    ' + esc((s.result || '').substring(0, 200)) + '\n';
    else if (s.type === 'error') html += '<span class="agent-err">✖ ' + esc(s.text) + '</span>\n';
    else if (s.type === 'done') html += '<span class="agent-done">✔ ' + esc(s.text) + '</span>\n';
  });
  if (!html && run && run.result) html = '<span class="agent-done">✔ ' + esc(run.result) + '</span>\n';
  if (html) $('agentLog').innerHTML = html;
  $('agentLog').scrollTop = $('agentLog').scrollHeight;
}

function restoreAgentState(){
  if (agentRunning || agentRestoreInFlight) return;
  const taskId = readRememberedAgentTask();
  if (!taskId) return;
  agentRestoreInFlight = true;
  authFetch('/api/agent/run/' + encodeURIComponent(taskId)).then(r => {
    if (r.ok) return r.json();
    if (r.status === 404) return null;
    throw new Error('HTTP ' + r.status);
  }).then(run => {
    if (run) {
      rememberAgentTask(taskId);
      renderAgentTranscript(run);
      // Persisted transcripts only carry completed | failed | iteration_limit
      // | cancelled | waiting_for_approval — the old queued/running check
      // matched nothing and was dead. A parked task gets an explicit
      // affordance instead of rendering as plain finished history.
      if (run.status === 'waiting_for_approval') {
        appendLog('<span class="agent-step">⏸ Task ' + esc(taskId) + ' is parked awaiting human approval' +
          (run.brain && run.brain.awaiting_approval ? ' (approval ' + esc(String(run.brain.awaiting_approval)) + ')' : '') +
          '. Decide it in the Approvals tab — the task runner resumes it after the decision.</span>');
      }
      return;
    }
    // Active tasks do not get a durable transcript until terminal completion.
    // Reattaching to the existing governed SSE stream preserves the live run.
    streamAgentTask(taskId, { reset: false, reconnect: true });
  }).catch(e => {
    appendLog('<span class="agent-err">Could not restore task ' + esc(taskId) + ': ' + esc(e.message) + '</span>');
  }).finally(() => { agentRestoreInFlight = false; });
}

// Local stream cleanup only — used when the task itself has ended (done/error
// events, stream failure, failed start). It never cancels the backend task.
function finishAgentStream(){
  if (agentStream) { agentStream.close(); agentStream = null; }
  agentRunning = false;
  currentAgentTaskId = null;
  $('agentGo').disabled = false;
  $('agentStop').disabled = true;
  $('agentClear').disabled = false;
}

function clearAgent(){
  if (agentRunning) return;
  if (agentStream) { agentStream.close(); agentStream = null; }
  currentAgentTaskId = null;
  try { localStorage.removeItem(AGENT_LAST_TASK_KEY); } catch (e) {}
  $('agentGoal').value = '';
  $('agentLog').innerHTML = '<span class="empty">Submit a task above</span>';
}

// Stop button: actually cancel the backend task, report the backend's answer,
// then close the stream. Closing the EventSource alone only stopped WATCHING —
// the task kept running to completion server-side.
function stopAgent(){
  const taskId = currentAgentTaskId;
  if (taskId && agentRunning) {
    authFetch('/api/agent/run/' + encodeURIComponent(taskId) + '/cancel', { method: 'POST' })
      .then(r => r.json().then(d => ({ status: r.status, d })).catch(() => ({ status: r.status, d: {} })))
      .then(({ status, d }) => {
        if (status === 200 && d.ok) {
          appendLog('<span class="agent-step">Cancellation requested for task ' + esc(taskId) + '; backend will stop it between steps</span>');
        } else if (status === 404) {
          appendLog('<span class="agent-step">Task ' + esc(taskId) + ' is no longer running; nothing to cancel</span>');
        } else {
          appendLog('<span class="agent-err">Cancel failed: ' + esc((d && d.error) || ('HTTP ' + status)) + '</span>');
        }
      })
      .catch(e => appendLog('<span class="agent-err">Cancel request failed: ' + esc(e.message) + '</span>'));
  }
  finishAgentStream();
}

function toggleHistory(){
  const el = $('agentHistory');
  const toggle = $('agentHistoryToggle');
  const expanded = el.style.display === 'none';
  el.style.display = expanded ? 'block' : 'none';
  if (toggle) {
    toggle.setAttribute('aria-expanded', String(expanded));
    const chevron = $('agentHistoryChevron');
    if (chevron) chevron.textContent = expanded ? '▲' : '▼';
  }
  if (expanded) {
      authFetch('/api/agent/history').then(r=>r.json()).then(d=>{
      let html = '<div class="agent-history-note">' +
        '<i class="fas fa-info-circle"></i> Agent history shows tasks submitted via this dashboard. ' +
        'Tool calls from opencode appear in the Activity tab, grouped by session.</div>';
      if (!d.runs || !d.runs.length) { html += '<div class="empty">No past runs</div>'; el.innerHTML = html; return; }
      html += d.runs.map(r =>
        '<div class="history-item">' +
        '<span class="log-time">' + fmtTime(r.t) + '</span> ' +
        '<span class="' + (r.status === 'completed' ? 'log-ok' : 'log-fail') + '">' + r.status + '</span> ' +
        '<span class="log-summary">' + esc(r.goal.substring(0,80)) +
        (r.parentTaskId ? ' <span class="sub" title="Follow-up of ' + esc(r.parentTaskId) + '">(follow-up of ' + esc(r.parentTaskId) + ')</span>' : '') +
        '</span>' +
        '<button class="btn btn-sm btn-outline" data-action="followup" data-id="' + esc(r.id) + '" title="Follow up" aria-label="Follow up on task ' + esc(r.id) + '"><i class="fas fa-reply"></i></button>' +
        '<button class="btn btn-sm btn-outline" data-action="export" data-id="' + esc(r.id) + '" title="Export"><i class="fas fa-download"></i></button>' +
        '<button class="btn btn-sm btn-outline" data-action="toggle" data-id="' + esc(r.id) + '" title="Details"><i class="fas fa-chevron-down"></i></button>' +
        '<div id="run-detail-' + esc(r.id) + '" class="agent-run-detail"></div>' +
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
          else if (action === 'followup') openFollowup(id);
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
    let lineageHtml = '';
    if (run.parent_task_id) {
      lineageHtml = '<div class="agent-step agent-lineage">Follow-up to ' +
        '<a href="#" data-action="open" data-id="' + esc(run.parent_task_id) + '">' + esc(run.parent_task_id) + '</a>' +
        ' · Thread root: ' + esc(run.root_task_id || id) + '</div>';
    } else if (run.root_task_id && run.root_task_id !== id) {
      lineageHtml = '<div class="agent-step agent-lineage">Thread root: ' + esc(run.root_task_id) + '</div>';
    }
    const formHtml =
       '<div class="followup-form">' +
       '<label for="followup-input-' + esc(id) + '" class="agent-followup-label">Follow up on this task</label>' +
      '<textarea id="followup-input-' + esc(id) + '" class="agent-goal" rows="2" placeholder="Ask a follow-up based on this result…" aria-label="Follow-up goal for task ' + esc(id) + '"></textarea>' +
      '<div><button class="btn btn-sm" data-action="followup-submit" data-id="' + esc(id) + '">Send follow-up</button></div>' +
      '</div>';
    detail.innerHTML = '<div class="history-detail">' + lineageHtml + html + formHtml + '</div>';
    // Detail buttons/links are rendered after the initial history wiring pass,
    // so attach their listeners here (same data-action convention).
    detail.querySelectorAll('button[data-action], a[data-action]').forEach(node => {
      node.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        const action = this.dataset.action;
        const did = this.dataset.id;
        if (action === 'followup-submit') submitFollowup(did);
        else if (action === 'open') toggleRunDetail(did);
      });
    });
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

// Agent Tab v2 overrides the legacy task-detail renderer above.  The backend
// remains authoritative for each immutable task; this state only selects and
// presents a logical session.
function agentTime(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return 'Date unavailable';
  const now = new Date(), yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const day = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const clock = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const same = d.toDateString() === now.toDateString();
  const prev = d.toDateString() === yesterday.toDateString();
  return (same ? 'Today' : prev ? 'Yesterday' : day) + ' · ' + clock;
}

function rememberAgentSession(rootId, leafId) {
  try {
    if (rootId) localStorage.setItem(AGENT_ROOT_KEY, rootId);
    if (leafId) localStorage.setItem(AGENT_LAST_TASK_KEY, leafId);
  } catch (e) {}
}
function readRememberedAgentRoot() { try { return localStorage.getItem(AGENT_ROOT_KEY); } catch (e) { return null; } }

function statusLabel(status) {
  const labels = { completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', iteration_limit: 'Resource limit reached', timed_out: 'Timed out', waiting_for_approval: 'Awaiting approval', interrupted: 'Interrupted' };
  return labels[status] || (status ? String(status).replace(/_/g, ' ') : 'Working');
}
function canFollowAgent(status) { return ['completed','failed','cancelled','iteration_limit','timed_out','interrupted'].includes(status); }

function renderAgentSession(session) {
  activeAgentSession = session;
  const turns = session && Array.isArray(session.turns) ? session.turns : [];
  const meta = $('agentSessionMeta');
  if (meta) meta.textContent = session ? (session.goal || 'Agent session') + ' · Started ' + agentTime(session.createdAt) : 'Start a governed Agent task or resume a session from History.';
  const log = $('agentLog');
  if (!log) return;
  if (!turns.length) { log.innerHTML = '<span class="empty">Submit a task above</span>'; return; }
  log.innerHTML = turns.map((turn, index) => {
    const body = turn.result ? '<div class="agent-answer">' + esc(turn.result) + '</div>' : (turn.error ? '<div class="agent-err">' + esc(turn.error) + '</div>' : '<div class="agent-step">Working…</div>');
    const work = turn.workState || {};
    const details = (work.evidence_count || work.operation_count) ? '<div class="sub">' + esc(statusLabel(turn.status)) + ' · ' + esc(String(work.evidence_count || 0)) + ' evidence items' + (work.operation_count === null ? '' : ' · ' + esc(String(work.operation_count)) + ' operations') + '</div>' : '';
    return '<article class="agent-turn"><div class="sub">Turn ' + (index + 1) + ' · You</div><div class="agent-goal-display">' + esc(turn.goal || '') + '</div><div class="sub">Agent · ' + esc(agentTime(turn.t)) + '</div>' + body + details + '<div class="agent-status ' + (turn.status === 'completed' ? 'log-ok' : turn.status === 'failed' ? 'log-fail' : '') + '">' + esc(statusLabel(turn.status)) + '</div></article>';
  }).join('');
  log.scrollTop = log.scrollHeight;
  const leaf = turns[turns.length - 1];
  currentAgentTaskId = leaf && leaf.id;
  if (session.rootTaskId) rememberAgentSession(session.rootTaskId, currentAgentTaskId);
  const follow = $('agentFollowupArea');
  if (follow) follow.hidden = !leaf || !canFollowAgent(leaf.status) || agentRunning;
}

function refreshAgentSession(rootId) {
  if (!rootId) return Promise.resolve(null);
  return authFetch('/api/agent/session/' + encodeURIComponent(rootId)).then(r => {
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(d => { if (d && d.session) renderAgentSession(d.session); return d && d.session; });
}

function runAgent() {
  const goal = $('agentGoal').value.trim();
  if (!goal || agentRunning || agentSubmissionPending) return;
  agentSubmissionPending = true; agentRunning = true;
  $('agentGo').disabled = true; $('agentClear').disabled = true;
  $('agentFollowupArea').hidden = true; $('agentLog').innerHTML = '<span class="agent-step">Starting governed Agent task…</span>';
  const profile = ($('agentProfile') && $('agentProfile').value) || 'standard';
  const project = (($('agentProject') && $('agentProject').value) || '').trim();
  authFetch('/api/agent/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal, profile, ...(project ? { project } : {}) }) })
    .then(r => r.json().then(data => ({ status: r.status, data })))
    .then(({ status, data }) => { if (status >= 400 || data.error) throw new Error(data.error || ('HTTP ' + status)); activeAgentSession = { rootTaskId: data.taskId, turns: [{ id: data.taskId, goal, status: 'running', t: new Date().toISOString() }] }; rememberAgentSession(data.taskId, data.taskId); streamAgentTask(data.taskId, { reset: false }); })
    .catch(e => { appendLog('<span class="agent-err">' + esc(e.message) + '</span>'); finishAgentStream(); })
    .finally(() => { agentSubmissionPending = false; });
}

function streamAgentTask(taskId, opts) {
  opts = opts || {}; currentAgentTaskId = taskId; agentRunning = true; rememberAgentTask(taskId);
  $('agentGo').disabled = true; $('agentClear').disabled = true; $('agentStop').disabled = false; if ($('agentPause')) $('agentPause').disabled = false; $('agentFollowupArea').hidden = true;
  if (agentStream) agentStream.close();
  loadDurableAgentTask(taskId);
  agentStream = new EventSource('/api/agent/stream/' + encodeURIComponent(taskId));
  agentStream.onmessage = e => { let msg; try { msg = JSON.parse(e.data); } catch (_) { return; }
    if (msg.type === 'step') appendLog('<span class="agent-step">' + esc(msg.text) + '</span>');
    else if (msg.type === 'tool') appendLog('<span class="agent-ok">' + esc(msg.tool || 'operation') + '</span> ' + esc(msg.summary || ''));
    else if (msg.type === 'error') { appendLog('<span class="agent-err">' + esc(msg.text || 'Agent failed') + '</span>'); finishAgentStream(); }
    else if (msg.type === 'done') { appendLog('<span class="agent-done">' + esc(msg.text || 'Completed') + '</span>'); loadDurableAgentTask(taskId); finishAgentStream(); }
  };
  agentStream.onerror = () => { appendLog('<span class="agent-err">Live stream disconnected. The backend task was not assumed to have failed.</span>'); finishAgentStream(); refreshAgentSession(activeAgentSession && activeAgentSession.rootTaskId).catch(() => {}); };
}

function submitFollowup(id) {
  if (agentRunning || agentSubmissionPending || !activeAgentSession) return;
  const leaf = activeAgentSession.turns && activeAgentSession.turns[activeAgentSession.turns.length - 1];
  id = id || (leaf && leaf.id);
  const input = $('agentFollowupGoal');
  const goal = input && input.value.trim();
  if (!id || !goal || !canFollowAgent(leaf && leaf.status)) return;
  agentSubmissionPending = true; agentRunning = true; input.disabled = true; $('agentFollowupGo').disabled = true; $('agentStop').disabled = false;
  authFetch('/api/agent/run/' + id + '/follow-up', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal }) })
    .then(r => r.json().then(data => ({ status: r.status, data })))
    .then(({ status, data }) => { if (status >= 400 || data.error) throw new Error(data.error || ('HTTP ' + status)); input.value = ''; activeAgentSession.turns.push({ id: data.taskId, goal, status: 'running', t: new Date().toISOString(), parentTaskId: id }); renderAgentSession(activeAgentSession); streamAgentTask(data.taskId, { reset: false, parentTaskId: id }); })
    .catch(e => { appendLog('<span class="agent-err">Follow-up failed: ' + esc(e.message) + '</span>'); finishAgentStream(); })
    .finally(() => { agentSubmissionPending = false; input.disabled = false; $('agentFollowupGo').disabled = false; });
}

function restoreAgentState() {
  if (agentRestoreInFlight || agentRunning) return; const root = readRememberedAgentRoot(); const task = readRememberedAgentTask();
  agentRestoreInFlight = true;
  const load = root ? refreshAgentSession(root).then(session => { if (!session && task) streamAgentTask(task, { reset: false, reconnect: true }); return session; }) : (task ? authFetch('/api/agent/run/' + encodeURIComponent(task)).then(r => r.ok ? r.json() : null).then(run => run && refreshAgentSession(run.root_task_id || task)) : Promise.resolve(null));
  load.catch(e => appendLog('<span class="agent-err">Could not restore Agent session: ' + esc(e.message) + '</span>')).finally(() => { agentRestoreInFlight = false; });
}

function finishAgentStream() { if (agentStream) { agentStream.close(); agentStream = null; } if (currentAgentTaskId) loadDurableAgentTask(currentAgentTaskId); agentRunning = false; currentAgentTaskId = null; $('agentGo').disabled = false; $('agentClear').disabled = false; $('agentStop').disabled = true; if ($('agentPause')) $('agentPause').disabled = true; if (activeAgentSession) refreshAgentSession(activeAgentSession.rootTaskId).catch(() => {}); }
function clearAgent() { if (agentRunning) return; $('agentGoal').value = ''; }
function newAgentTask() { if (agentRunning) return; activeAgentSession = null; currentAgentTaskId = null; try { localStorage.removeItem(AGENT_ROOT_KEY); localStorage.removeItem(AGENT_LAST_TASK_KEY); } catch (_) {} $('agentLog').innerHTML = '<span class="empty">Describe a new task below</span>'; $('agentSessionMeta').textContent = 'New root Agent task'; $('agentFollowupArea').hidden = true; $('agentGoal').focus(); }
function stopAgent() { const id = currentAgentTaskId; if (!id || !agentRunning) return; authFetch('/api/agent/run/' + encodeURIComponent(id) + '/cancel', { method: 'POST' }).then(r => r.json()).then(d => appendLog('<span class="agent-step">' + esc(d.error || 'Cancellation requested') + '</span>')).catch(e => appendLog('<span class="agent-err">Cancel failed: ' + esc(e.message) + '</span>')); }

function refreshAgentHistory() {
  const el = $('agentHistory'); if (!el) return Promise.resolve();
  return authFetch('/api/agent/history?page_size=20').then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then(d => {
    const rows = d.sessions || d.runs || []; if (!rows.length) { el.innerHTML = '<div class="empty">No past Agent sessions</div>'; return; }
    el.innerHTML = rows.map(r => '<div class="history-item" tabindex="0" role="button" data-session-id="' + esc(r.rootTaskId || r.id) + '"><div><strong>' + esc(r.goal || 'Untitled session') + '</strong><div class="sub">' + esc(agentTime(r.lastActivityAt || r.createdAt)) + ' · ' + esc(String(r.turnCount || 1)) + ' turns · ' + esc(statusLabel(r.status)) + '</div></div></div>').join('');
    el.querySelectorAll('[data-session-id]').forEach(node => { const open = () => refreshAgentSession(node.dataset.sessionId).catch(e => apiError('/api/agent/session', e, 0)); node.addEventListener('click', open); node.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }); });
  });
}
function toggleHistory() { const el = $('agentHistory'), toggle = $('agentHistoryToggle'); const expanded = el.style.display === 'none'; el.style.display = expanded ? 'block' : 'none'; toggle.setAttribute('aria-expanded', String(expanded)); $('agentHistoryChevron').textContent = expanded ? '▲' : '▼'; if (expanded) refreshAgentHistory().catch(e => { el.innerHTML = '<div class="agent-err">History unavailable: ' + esc(e.message) + '</div>'; }); }

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
    '<tr><td>' + esc(step.step_number) + '</td><td><code>' + esc(step.tool_name) + '</code></td><td><pre class="execution-step-args">' + esc(JSON.stringify(step.args || {}, null, 2)) + '</pre></td><td>' + esc(step.started_at ? fmtTime(step.started_at) : '-') + '</td><td>' + esc(formatMs(step.duration_ms)) + '</td><td>' + esc(step.result_summary || '') + '</td><td>' + esc(step.retry_count || 0) + '</td><td>' + esc(step.error_category || '') + '</td><td>' + esc(step.success === null ? step.state : (step.success ? 'ok' : 'failed')) + '</td></tr>'
  ).join('');
  target.innerHTML = '<div class="card execution-card">' +
    '<div class="execution-head"><div><strong>Execution <code>' + esc(execution.id) + '</code></strong><div class="execution-state"><span class="badge">' + esc(execution.state) + '</span> <span class="badge">source=' + esc(execution.source || 'unknown') + '</span></div></div>' +
    '<div class="evolve-execution-actions"><button class="btn btn-sm btn-outline" data-dashboard-action="callback" data-handler="openExecutionActivity" data-id="' + attr(execution.id) + '">Open in Activity</button>' + (running ? '<button class="btn btn-sm btn-outline" data-dashboard-action="callback" data-handler="cancelEvolveExecution" data-id="' + attr(execution.id) + '">Cancel</button>' : '') + '</div></div>' +
    '<div class="execution-note">Success criteria: ' + esc(execution.success_criteria || 'All generated workflow steps must complete successfully') + ' · satisfied=' + esc(execution.success_criteria_satisfied === null ? 'pending' : execution.success_criteria_satisfied) + '</div>' +
    '<div class="execution-note">Final summary: ' + esc(execution.final_summary || '') + '</div>' +
    '<div class="execution-table"><table class="data-table"><thead><tr><th>#</th><th>Tool</th><th>Args</th><th>Start</th><th>Duration</th><th>Summary</th><th>Retries</th><th>Error</th><th>Status</th></tr></thead><tbody>' + (steps || '<tr><td colspan="9" class="empty">No steps yet</td></tr>') + '</tbody></table></div>' +
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
        allowed.validate ? '<button class="btn btn-sm" data-dashboard-action="evolve" data-handler="validateEvolve" data-id="' + attr(item.id) + '">Validate</button>' : '',
        allowed.approve ? '<button class="btn btn-sm" data-dashboard-action="evolve" data-handler="approveEvolve" data-id="' + attr(item.id) + '">Approve Trial</button>' : '',
        allowed.promote ? '<button class="btn btn-sm" data-dashboard-action="evolve" data-handler="promoteEvolve" data-id="' + attr(item.id) + '">Promote</button>' : '',
        active ? '<button class="btn btn-sm" data-dashboard-action="evolve" data-handler="runEvolveTrial" data-id="' + attr(item.id) + '" data-index="' + attr(index) + '">Run Trial</button>' : '',
        active && item.recent_executions && item.recent_executions.length ? '<button class="btn btn-sm btn-outline" data-dashboard-action="evolve" data-handler="watchEvolveExecution" data-id="' + attr(item.recent_executions[0].id) + '">Watch Executions</button>' : '',
        allowed.reject ? '<button class="btn btn-sm btn-outline" data-dashboard-action="evolve" data-handler="rejectEvolve" data-id="' + attr(item.id) + '">Reject</button>' : '',
        allowed.deprecate ? '<button class="btn btn-sm btn-outline" data-dashboard-action="evolve" data-handler="deprecateEvolve" data-id="' + attr(item.id) + '">Deprecate</button>' : '',
        '<button class="btn btn-sm btn-outline" data-dashboard-action="evolve" data-handler="feedbackEvolve" data-id="' + attr(item.id) + '" data-value="true">Useful</button>',
        '<button class="btn btn-sm btn-outline" data-dashboard-action="evolve" data-handler="feedbackEvolve" data-id="' + attr(item.id) + '" data-value="false">Not Useful</button>'
      ].filter(Boolean).join(' ');
      return '<div class="card evolve-card">' +
        '<div class="evolve-head">' +
          '<div>' +
            '<div class="evolve-title">' + esc(item.candidate_title || item.proposed_tool_name) + '</div>' +
            '<div class="evolve-name"><code>' + esc(item.proposed_tool_name) + '</code></div>' +
          '</div>' +
          '<div class="evolve-controls">' + controls + '</div>' +
        '</div>' +
        '<div class="evolve-badges">' +
          '<span class="badge">' + esc(state) + '</span>' +
          '<span class="badge">risk=' + esc(item.risk || 'medium') + '</span>' +
          '<span class="badge">evidence=' + esc(item.evidence_count || 0) + '</span>' +
          '<span class="badge">success=' + esc(Math.round((item.success_rate || 0) * 100)) + '%</span>' +
          '<span class="badge">score=' + esc(item.usefulness_score || 0) + '</span>' +
          '<span class="badge">calls saved=' + esc(item.estimated_calls_saved || 0) + '</span>' +
          '<span class="badge">validation=' + esc(validation) + '</span>' +
        '</div>' +
        '<div class="evolve-detail"><span class="s-label">Parameters:</span> ' + renderEvolveParams(item.inferred_parameters || {}) + '</div>' +
        (item.score_breakdown ? '<div class="evolve-note">Score: ' + esc(JSON.stringify(item.score_breakdown)) + '</div>' : '') +
        (item.duplicate_reasons && item.duplicate_reasons.length ? '<div class="agent-err evolve-error">Duplicate signals: ' + esc(item.duplicate_reasons.join(', ')) + '</div>' : '') +
        '<div class="evolve-note">Trial executions: use=' + esc(item.use_count || 0) + ', ok=' + esc(item.success_count || 0) + ', fail=' + esc(item.failure_count || 0) + (trial.length ? ', legacy audit=' + esc(trial.map(t => t.success ? 'ok' : 'fail').join(',')) : '') + '</div>' +
      (item.recent_executions && item.recent_executions.length ? '<div class="evolve-note">Recent executions: ' + item.recent_executions.map(ex => '<button class="btn btn-sm btn-outline" data-dashboard-action="evolve" data-handler="watchEvolveExecution" data-id="' + attr(ex.id) + '">' + esc(ex.state) + ' ' + esc(fmtTime(ex.created_at)) + '</button>').join(' ') + '</div>' : '') +
      '</div>';
    }).join('');
  }).catch(e => {
    list.innerHTML = '<div class="agent-err">Failed to load Evolve data</div>';
    apiError('/api/evolve', e, 0);
  });
}

// -- Compute -- //
function loadCompute(){
  loadComputeOverview();
  loadComputeWorkers();
  loadComputeJobs();
  stampComputeUpdated();
}

function stampComputeUpdated(){
  const el = $('computeLastUpdate');
  if (el) el.textContent = 'updated ' + new Date().toLocaleTimeString();
}

// Polled refresh for the Compute tab. The server reconciles worker connection
// state on its own timer, so a page left open used to show a green "online"
// badge for a worker the server had already marked offline.
//
// Worker rows are only re-rendered when nothing in that list is expanded:
// re-rendering collapses every <details>, which would yank open utilization and
// model panels out from under whoever is reading them.
function refreshCompute(){
  loadComputeOverview();
  loadComputeJobs();
  const workerList = $('computeWorkers');
  const hasOpenDetail = workerList && workerList.querySelector('details[open]');
  if (!hasOpenDetail) loadComputeWorkers();
  stampComputeUpdated();
}

function loadComputeOverview(){
  const el = $('computeSummary');
  if (!el) return;
  authFetch('/api/compute').then(r=>r.json()).then(d=>{
    const o = d.overview || {};
    const workers = o.workers || {};
    const jobs = o.jobs || {};
    const providers = o.providers || {};
    // Providers and executors are different things and the counts alone read as
    // interchangeable, so name them: providers are the inference endpoints the
    // server routes to, executors are the job types a worker can run.
    const providerNames = providers.names && providers.names.length ? providers.names.join(', ') : 'none configured';
    const unhealthy = providers.unhealthyNames || [];
    const providerDetail = unhealthy.length ? 'unhealthy: ' + unhealthy.join(', ') : providerNames;
    const executorNames = (o.executorNames && o.executorNames.length) ? o.executorNames.join(', ') : 'none registered';
    el.innerHTML = [
      metric('Workers online', workers.online || 0, (workers.total || 0) + ' total'),
      metric('Jobs total', jobs.total || 0, 'queued ' + (jobs.byStatus?.queued || 0) + ', running ' + (jobs.byStatus?.running || 0)),
      metric('Completed', jobs.byStatus?.completed || 0, 'failed ' + (jobs.byStatus?.failed || 0)),
      metric(
        'Inference providers',
        (providers.healthy || 0) + ' / ' + (providers.total || 0) + ' healthy',
        providerDetail,
        'Inference endpoints the server routes to (Ollama / OpenAI-compatible).\nConfigured: ' + providerNames
      ),
      metric(
        'Job executors',
        o.executors || 0,
        executorNames,
        'Executor types registered for distributed jobs.\nRegistered: ' + executorNames + '\nRouting rules: ' + (o.routing?.rulesCount || 0)
      ),
      metric('Routing rules', o.routing?.rulesCount || 0, (o.routing?.rulesCount ? 'custom placement active' : 'default placement'))
    ].join('');
  }).catch(e=>{
    el.innerHTML = '<div class="quick-action-error">Compute overview unavailable: ' + esc(e.message || String(e)) + '</div>';
  });
}

function loadComputeWorkers(){
  const el = $('computeWorkers');
  if (!el) return;
  el.innerHTML = '<div class="empty">Loading workers...</div>';
  authFetch('/api/compute/workers').then(r=>r.json()).then(d=>{
    const workers = d.workers || [];
    const telemetryByWorker = Object.fromEntries((d.telemetry || []).map(t => [t.workerId, t]));
    workers.forEach(w => { w.telemetry = telemetryByWorker[w.workerId] || null; });
    $('computeWorkerCount').textContent = workers.length;
    if (!workers.length) {
      el.innerHTML = '<div class="empty">No workers enrolled yet. Create an enrollment token to add one.</div>';
      return;
    }
    el.innerHTML = workers.map(renderComputeWorker).join('');
  }).catch(e=>{
    el.innerHTML = '<div class="agent-err">Failed to load workers</div>';
    apiError('/api/compute/workers', e, 0);
  });
}

function renderComputeWorker(w){
  const accelerators = (w.accelerators || []).map(a => a.name || a.type || a.vendor || JSON.stringify(a)).filter(Boolean);
  const modelInventory = Array.isArray(w.modelInventory) ? w.modelInventory : [];
  const models = modelInventory.length;
  // Multi-dimensional lifecycle state: connection / admin / credential / health.
  const conn = w.connectionState || (w.state === 'online' ? 'online' : 'offline');
  const admin = w.adminState || (w.state === 'maintenance' ? 'maintenance' : 'enabled');
  const cred = w.credentialState || (w.state === 'revoked' ? 'revoked' : 'active');
  const health = w.healthState || 'unknown';
  const connClass = conn === 'online' ? 'ok' : 'warn';
  const adminClass = admin === 'enabled' ? '' : 'warn';
  const healthClass = health === 'healthy' ? 'ok' : (health === 'unavailable' ? 'danger' : (health === 'degraded' ? 'warn' : ''));
  const stateBadges =
    '<span class="badge ' + connClass + '" title="connection">' + esc(conn) + '</span>' +
    '<span class="badge ' + adminClass + '" title="admin">' + esc(admin) + '</span>' +
    (cred === 'revoked' ? '<span class="badge danger" title="credential">revoked</span>' : '') +
    (health !== 'unknown' ? '<span class="badge ' + healthClass + '" title="health">' + esc(health) + '</span>' : '');
  const disconnectInfo = (conn === 'offline' && w.disconnectedAt)
    ? '<small class="compute-disconnect">offline since ' + esc(fmtDate(w.disconnectedAt)) + (w.lastDisconnectReason ? ' (' + esc(w.lastDisconnectReason) + ')' : '') + '</small>'
    : '';
  const lastHeartbeat = w.lastHeartbeat ? fmtDate(w.lastHeartbeat) : 'never';
  const telemetry = w.telemetry && w.telemetry.telemetry;
  const gpuDevices = telemetry && telemetry.gpu && telemetry.gpu.status === 'available' ? telemetry.gpu.devices || [] : [];
  const gpuSummary = gpuDevices.length
    ? gpuDevices.map(g => (g.name || 'GPU') + ' ' + (g.utilizationPercent ?? '?') + '% / ' + formatBytes(g.memoryUsedBytes) + ' VRAM').join(', ')
    : (telemetry && telemetry.gpu && telemetry.gpu.status === 'unavailable' ? 'GPU telemetry unavailable' : 'No GPU telemetry');
  const inferenceSummary = telemetry && telemetry.inference && telemetry.inference.status !== 'unavailable'
    ? ((telemetry.inference.model || 'inference') + (telemetry.inference.tokensPerSecond != null ? ' · ' + Number(telemetry.inference.tokensPerSecond).toFixed(1) + ' tok/s' : ''))
    : 'No recent inference sample';
  // Generous inline limits: the block is already scroll-capped by CSS, so most
  // payloads render whole and only genuinely large ones get an expand control.
  const utilization = w.utilization && Object.keys(w.utilization).length ? renderStructuredValue(w.utilization, { limit: 700 }) : '<div class="empty">No utilization reported</div>';
  const healthDetail = w.health && Object.keys(w.health).length ? renderStructuredValue(w.health, { limit: 900 }) : '<div class="empty">No health detail reported</div>';
  // Render model inventory with certification tier badges.
  const modelBadges = modelInventory.map(function(m) {
    const name = m.name || m.model || '?';
    const tier = m.certificationTier || '';
    const tierClass = tier === 'certified' ? 'ok' : (tier === 'detected_self_tested' ? 'info' : (tier === 'unsupported' ? 'danger' : ''));
    const tierLabel = tier ? ' <span class="badge ' + tierClass + '">' + esc(tier) + '</span>' : '';
    const device = m.device ? ' <small>' + esc(m.device) + '</small>' : '';
    return '<div>' + esc(name) + device + tierLabel + '</div>';
  }).join('');
  // OpenVINO health summary.
  const ovHealth = w.health && w.health.openvino;
  const ovState = ovHealth ? '<span class="badge ' + (ovHealth.state === 'ready' ? 'ok' : (ovHealth.state === 'disabled' ? '' : 'warn')) + '">openvino ' + esc(ovHealth.state || 'unknown') + '</span>' : '';
  return '<div class="compute-row">' +
    '<div class="compute-row-main">' +
      '<div><strong>' + esc(w.displayName || w.nodeId || w.workerId) + '</strong> ' + stateBadges + ' ' + ovState + '</div>' +
      '<small>' + esc(w.platform || 'unknown') + (w.architecture ? ' / ' + esc(w.architecture) : '') + ' / last heartbeat ' + esc(lastHeartbeat) + '</small>' +
      disconnectInfo +
      '<div class="compute-badges">' +
        '<span>jobs ' + esc(w.currentJobs || 0) + '/' + esc(w.maxConcurrentJobs || 1) + '</span>' +
        '<span>trust ' + esc(w.trustLevel || 'unknown') + '</span>' +
        '<span>models ' + esc(models) + '</span>' +
        (accelerators.length ? '<span>' + esc(accelerators.join(', ')) + '</span>' : '<span>cpu</span>') +
        '<span title="Latest worker-local GPU snapshot">' + esc(gpuSummary) + '</span>' +
        '<span title="Latest worker-local inference timing">' + esc(inferenceSummary) + '</span>' +
      '</div>' +
      (modelBadges ? '<details class="detail-block"><summary>Models (' + esc(models) + ')</summary><div class="model-tier-list">' + modelBadges + '</div></details>' : '') +
      '<details class="detail-block"><summary>Utilization and health</summary>' +
        '<div class="sub-block-label">Utilization</div>' + utilization +
        '<div class="sub-block-label">Health</div>' + healthDetail +
      '</details>' +
    '</div>' +
    '<div class="compute-row-actions">' +
      ((admin === 'maintenance' || admin === 'draining')
         ? '<button class="btn btn-sm" title="Clear maintenance and resume claiming jobs" data-dashboard-action="compute-worker" data-id="' + attr(w.workerId) + '" data-value="enable">Resume</button>'
         : '<button class="btn btn-sm btn-outline" title="Stop claiming new jobs; worker stays connected" data-dashboard-action="compute-worker" data-id="' + attr(w.workerId) + '" data-value="disable">Put in maintenance</button>') +
      (cred !== 'revoked'
         ? '<button class="btn btn-sm btn-danger" title="Terminal: revoke the credential (re-enroll to recover)" data-dashboard-action="compute-worker" data-id="' + attr(w.workerId) + '" data-value="revoke">Revoke credential</button>'
        : '<span class="badge danger">credential revoked</span>') +
    '</div>' +
  '</div>';
}

function loadComputeJobs(){
  const el = $('computeJobs');
  if (!el) return;
  const status = $('computeJobStatus') ? $('computeJobStatus').value : '';
  let url = '/api/compute/jobs?limit=50';
  if (status) url += '&status=' + encodeURIComponent(status);
  el.innerHTML = '<div class="empty">Loading jobs...</div>';
  authFetch(url).then(r=>r.json()).then(d=>{
    const jobs = d.jobs || [];
    // Show the real total, not the page size — the list is capped at 50, so the
    // header used to read "Jobs (50)" no matter how many existed.
    const totalJobs = (d.stats && typeof d.stats.total === 'number') ? d.stats.total : jobs.length;
    $('computeJobCount').textContent = (jobs.length < totalJobs) ? (jobs.length + ' of ' + totalJobs) : String(totalJobs);
    if (!jobs.length) {
      // "No match" is misleading when there are simply no jobs at all — the
      // usual case on a fresh install — so tell the two apart.
      const anyJobs = (d.stats && d.stats.total) || 0;
      el.innerHTML = anyJobs
        ? '<div class="empty">No jobs match this filter (' + esc(anyJobs) + ' total). Clear the status filter to see them.</div>'
        : '<div class="empty">No compute jobs have been submitted yet. Jobs appear here once something routes work to a provider or worker.</div>';
      return;
    }
    el.innerHTML = jobs.map(renderComputeJob).join('');
  }).catch(e=>{
    el.innerHTML = '<div class="agent-err">Failed to load jobs</div>';
    apiError('/api/compute/jobs', e, 0);
  });
}

// Mirror of the server's JOB_TERMINAL_STATES / retryable set in
// src/compute/errors.js and job-manager.js. Kept together so the Cancel and
// Retry buttons match what the API will actually accept: offering Cancel on a
// dead-lettered job produced a success toast for a no-op, and expired and
// dead_letter jobs are retryable server-side but had no Retry button.
const JOB_TERMINAL_STATES = ['completed','failed','expired','cancelled','dead_letter'];
const JOB_RETRYABLE_STATES = ['failed','expired','dead_letter','cancelled'];

function computeJobStatusClass(status){
  if (status === 'completed') return 'ok';
  // expired and dead_letter are terminal failures, not work in progress.
  if (['failed','cancelled','expired','dead_letter'].includes(status)) return 'danger';
  return 'warn';
}

function renderComputeJob(j){
  const statusClass = computeJobStatusClass(j.status);
  const created = j.createdAt ? fmtDate(j.createdAt) : '';
  const prompt = j.requestPayload?.prompt || j.requestPayload?.input || j.progressMessage || j.errorMessage || '';
  const canCancel = !JOB_TERMINAL_STATES.includes(j.status);
  const canRetry = JOB_RETRYABLE_STATES.includes(j.status);
  return '<div class="compute-row compact-row">' +
    '<button class="compute-job-button" data-dashboard-action="compute-detail" data-id="' + attr(j.jobId) + '">' +
      '<strong>' + esc(j.jobType || j.capability || 'job') + '</strong>' +
      '<small>' + esc(j.jobId) + ' / ' + esc(created) + '</small>' +
      (prompt ? '<span>' + esc(String(prompt).slice(0, 140)) + '</span>' : '') +
    '</button>' +
    '<div class="compute-job-state">' +
      '<span class="badge ' + statusClass + '">' + esc(j.status || 'unknown') + '</span>' +
      '<span>' + esc(j.progressPercent || 0) + '%</span>' +
       (canCancel ? '<button class="btn btn-sm btn-outline" data-dashboard-action="compute-job" data-id="' + attr(j.jobId) + '" data-value="cancel">Cancel</button>' : '') +
       (canRetry ? '<button class="btn btn-sm" data-dashboard-action="compute-job" data-id="' + attr(j.jobId) + '" data-value="retry">Retry</button>' : '') +
    '</div>' +
  '</div>';
}

function showComputeJob(id){
  const el = $('computeJobDetail');
  if (!el) return;
  el.innerHTML = '<div class="empty">Loading job details...</div>';
  authFetch('/api/compute/jobs/' + encodeURIComponent(id)).then(r=>r.json()).then(d=>{
    if (!d.job) { el.innerHTML = '<div class="agent-err">Job not found</div>'; return; }
    const j = d.job;
    const statusClass = computeJobStatusClass(j.status);
    const created = j.createdAt ? fmtDate(j.createdAt) : '';
    const duration = j.startedAt && j.completedAt ? formatMs(new Date(j.completedAt) - new Date(j.startedAt)) : (j.startedAt ? 'running' : '--');
    let html = '<div class="card compute-detail-card">';
    html += '<div class="compute-panel-head"><div><div class="section-title">Job Detail</div><div class="sub">' + esc(j.jobId) + '</div></div><button class="btn btn-sm btn-outline" data-dashboard-action="database" data-handler="clearComputeJobDetail">Close</button></div>';

    html += '<div class="job-meta-strip">';
    html += '<span class="badge ' + statusClass + '">' + esc(j.status || 'unknown') + '</span>';
    html += '<span class="job-meta-item"><small>Type</small>' + esc(j.jobType || j.capability || '--') + '</span>';
    html += '<span class="job-meta-item"><small>Created</small>' + esc(created) + '</span>';
    html += '<span class="job-meta-item"><small>Duration</small>' + esc(duration) + '</span>';
    html += '<span class="job-meta-item"><small>Progress</small>' + esc(j.progressPercent || 0) + '%</span>';
    // The API returns the placement decision as selected*Id; j.model / j.workerId
    // never existed, so these chips were permanently absent.
    const jobModel = j.selectedModelId || j.requestPayload?.model;
    if (jobModel) html += '<span class="job-meta-item"><small>Model</small>' + esc(jobModel) + '</span>';
    if (j.selectedProviderId) html += '<span class="job-meta-item"><small>Provider</small>' + esc(j.selectedProviderId) + '</span>';
    if (j.selectedWorkerId) html += '<span class="job-meta-item"><small>Worker</small>' + esc(j.selectedWorkerId) + '</span>';
    if (j.attempt) html += '<span class="job-meta-item"><small>Attempt</small>' + esc(j.attempt) + ' / ' + esc(j.maxAttempts || 1) + '</span>';
    html += '</div>';

    const prompt = j.requestPayload?.prompt || j.requestPayload?.input || '';
    if (prompt) {
      html += '<div class="section-title">Prompt</div>';
      html += '<div class="detail-block"><pre class="value-block structured-text">' + esc(prompt) + '</pre></div>';
    }

    // rowToJob exposes the parsed payload as `result`; the old `result_json`
    // check never matched, so every completed job read "No result recorded".
    const jobResult = j.result !== undefined && j.result !== null ? j.result : j.result_json;
    if (jobResult !== undefined && jobResult !== null && jobResult !== '') {
      html += '<div class="section-title">Result</div>';
      html += '<div class="detail-block">';
      html += renderExpandableValue(jobResult, { limit: 1200 });
      html += '<button class="btn btn-sm btn-outline copy-btn" data-dashboard-action="copy-block">Copy</button>';
      html += '</div>';
    } else if (j.errorMessage) {
      html += '<div class="section-title">Error</div>';
      html += '<div class="detail-block"><pre class="value-block structured-text error-text">' + esc(j.errorMessage) + '</pre></div>';
      if (j.errorCategory) {
        html += '<div class="job-meta-strip"><span class="job-meta-item"><small>Error Category</small>' + esc(j.errorCategory) + '</span></div>';
      }
    } else if (j.status === 'completed') {
      html += '<div class="section-title">Result</div>';
      html += '<div class="empty">No result recorded</div>';
    }

    html += '<div class="section-title">Attempts (' + (d.attempts?.length || 0) + ')</div>';
    if (d.attempts && d.attempts.length) {
      d.attempts.forEach((a, i) => {
        const aStatusClass = a.status === 'success' ? 'ok' : (a.status === 'failed' ? 'danger' : 'warn');
        html += '<details class="detail-block attempt-block"' + (i === d.attempts.length - 1 ? ' open' : '') + '>';
        html += '<summary><span class="badge ' + aStatusClass + '">' + esc(a.status || 'unknown') + '</span> Attempt ' + (i + 1) + (a.workerId ? ' — ' + esc(a.workerId) : '') + (a.startedAt ? ' — ' + esc(fmtDate(a.startedAt)) : '') + '</summary>';
        html += renderExpandableValue(a, { limit: 600 });
        html += '</details>';
      });
    } else {
      html += '<div class="empty">No attempts</div>';
    }

    html += '<div class="section-title">Artifacts (' + (d.artifacts?.length || 0) + ')</div>';
    if (d.artifacts && d.artifacts.length) {
      d.artifacts.forEach((a, i) => {
        const sizeLabel = a.sizeBytes ? formatBytes(a.sizeBytes) : (a.size_bytes ? formatBytes(a.size_bytes) : '');
        html += '<details class="detail-block artifact-block"' + (i === 0 ? ' open' : '') + '>';
        html += '<summary>' + esc(a.name || a.artifactId || 'artifact') + (sizeLabel ? ' (' + esc(sizeLabel) + ')' : '') + (a.artifactType ? ' — ' + esc(a.artifactType) : '') + '</summary>';
        html += '<div class="detail-block">';
        html += '<div class="job-meta-strip">';
        if (a.contentHash || a.content_hash) html += '<span class="job-meta-item"><small>Hash</small><code>' + esc((a.contentHash || a.content_hash || '').slice(0, 16)) + '…</code></span>';
        if (a.contentType || a.content_type) html += '<span class="job-meta-item"><small>Type</small>' + esc(a.contentType || a.content_type) + '</span>';
        html += '</div>';
        if (a.content) {
          html += renderExpandableValue(a.content, { limit: 800 });
          html += '<button class="btn btn-sm btn-outline copy-btn" data-dashboard-action="copy-block">Copy</button>';
        } else {
          // Artifact bodies are not served over the API, so show where the
          // artifact actually lives instead of a bare dead end.
          const locator = a.storagePath || a.storage_path || a.storageRef || a.storage_ref;
          html += locator
            ? '<div class="meta-line"><span>Stored at</span> <code>' + esc(locator) + '</code></div>'
            : '<div class="empty">No inline content and no storage location recorded.</div>';
        }
        html += '</div>';
        html += '</details>';
      });
    } else {
      html += '<div class="empty">No artifacts</div>';
    }

    // Previously gated on j.lastError, which the API never returns; that hid
    // the lease and timing fields for any job with no progress message —
    // typically the failed ones, where they matter most. Build it from the
    // fields that actually exist and show it whenever any are present.
    const meta = {};
    if (j.progressMessage) meta.progressMessage = j.progressMessage;
    if (j.errorCategory) meta.errorCategory = j.errorCategory;
    if (j.errorMessage) meta.errorMessage = j.errorMessage;
    if (j.queuedAt) meta.queuedAt = j.queuedAt;
    if (j.startedAt) meta.startedAt = j.startedAt;
    if (j.completedAt) meta.completedAt = j.completedAt;
    if (j.cancelledAt) meta.cancelledAt = j.cancelledAt;
    if (j.cancelReason) meta.cancelReason = j.cancelReason;
    if (j.retryAfter) meta.retryAfter = j.retryAfter;
    if (j.leaseId) meta.leaseId = j.leaseId;
    if (j.leaseExpiresAt) meta.leaseExpiresAt = j.leaseExpiresAt;
    if (j.dataClassification) meta.dataClassification = j.dataClassification;
    if (j.project) meta.project = j.project;
    if (j.fallbackHistory && j.fallbackHistory.length) meta.fallbackHistory = j.fallbackHistory;
    if (j.schedulingDiagnostics && Object.keys(j.schedulingDiagnostics).length) meta.schedulingDiagnostics = j.schedulingDiagnostics;
    if (Object.keys(meta).length) {
      html += '<details class="detail-block">';
      html += '<summary>Full metadata</summary>';
      html += renderStructuredValue(meta, { expanded: true });
      html += '</details>';
    }

    html += '</div>';
    el.innerHTML = html;
  }).catch(e=>{
    el.innerHTML = '<div class="agent-err">Failed to load job detail</div>';
  });
}

function clearComputeJobDetail(){
  const detail = $('computeJobDetail');
  if (detail) detail.innerHTML = '';
}

// Guards against a second in-flight request: each click mints a distinct
// single-use token, so a double-click silently burned one.
let computeEnrollmentPending = false;

function createComputeEnrollment(){
  const result = $('computeEnrollmentResult');
  if (!result) return;
  if (computeEnrollmentPending) return;
  const fieldValue = (id, fallback) => {
    const el = $(id);
    return (el && el.value) || fallback;
  };
  const body = {
    displayName: fieldValue('computeEnrollName', 'sidekick-worker'),
    trustLevel: fieldValue('computeEnrollTrust', 'trusted'),
    maxConcurrentJobs: Number(fieldValue('computeEnrollJobs', 2)),
    expiresInMs: Number(fieldValue('computeEnrollTtl', 3600000))
  };
  const reEnroll = String(fieldValue('computeEnrollReEnroll', '')).trim();
  if (reEnroll) body.reEnrollmentOf = reEnroll;
  computeEnrollmentPending = true;
  result.innerHTML = '<div class="empty">Creating token...</div>';
  authFetch('/api/compute/enrollment-tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r=>r.json()).then(d=>{
    if (d.ok === false) throw new Error(d.error || 'token creation failed');
    const commands = d.install?.commands || {};
    result.innerHTML = '<div class="compute-token-warning">Token value is shown once. Store it only on the worker machine.</div>' +
      '<div class="compute-token-value" id="computeEnrollTokenValue">' + esc(d.token) + '</div>' +
      // Shown once and too long to hand-select reliably.
      '<button class="btn btn-sm btn-outline" data-dashboard-action="copy-element" data-id="computeEnrollTokenValue">Copy token</button>' +
      '<div class="compute-command-list">' + Object.entries(commands).map(([name, command]) =>
        '<div><strong>' + esc(name) + '</strong><pre>' + esc(command) + '</pre></div>'
      ).join('') + '</div>' +
      '<div class="sub">Expires ' + esc(fmtDate(d.expiresAt)) + '. Worker protocol ' + esc(d.install?.protocolVersion || '1') + '.</div>';
  }).catch(e=>{
    result.innerHTML = '<div class="quick-action-error">Enrollment failed: ' + esc(e.message || String(e)) + '</div>';
  }).finally(()=>{
    computeEnrollmentPending = false;
  });
}

function copyElementText(id, btn){
  const el = $(id);
  if (!el) return;
  const label = btn.textContent;
  navigator.clipboard.writeText(el.textContent).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = label; }, 1500);
  }).catch(() => {
    btn.textContent = 'Copy failed';
    setTimeout(() => { btn.textContent = label; }, 1500);
  });
}

function computeWorkerAction(workerId, action){
  if ((action === 'revoke') && !confirm('Revoke this worker credential? This cannot be undone from the worker.')) return;
  authFetch('/api/compute/workers/' + encodeURIComponent(workerId) + '/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'dashboard_' + action }) }).then(r=>r.json()).then(d=>{
    if (d.ok === false) throw new Error(d.error || action + ' failed');
    showToast('Worker ' + action + ' complete', 'success');
    loadCompute();
  }).catch(e=>alert('Worker action failed: ' + (e.message || String(e))));
}

function computeJobAction(jobId, action){
  if ((action === 'cancel') && !confirm('Cancel this compute job?')) return;
  authFetch('/api/compute/jobs/' + encodeURIComponent(jobId) + '/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'dashboard_' + action }) }).then(r=>r.json()).then(d=>{
    if (d.ok === false) throw new Error(d.error || action + ' failed');
    // cancelJob returns the job untouched for terminal states, so report the
    // resulting status rather than claiming success for a no-op.
    const status = d.job && d.job.status;
    if (action === 'cancel' && status && status !== 'cancelled' && status !== 'cancelling') {
      showToast('Job was already ' + status + ' — nothing to cancel', 'info');
    } else {
      showToast('Job ' + action + ' complete' + (status ? ' (now ' + status + ')' : ''), 'success');
    }
    loadCompute();
    showComputeJob(jobId);
  }).catch(e=>alert('Job action failed: ' + (e.message || String(e))));
}

function recoverComputeJobs(){
  authFetch('/api/compute/recover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r=>r.json()).then(d=>{
    if (d.ok === false) throw new Error(d.error || 'recovery failed');
    showToast('Recovered ' + (d.recovered || 0) + ' expired leases', 'success');
    loadCompute();
  }).catch(e=>alert('Recovery failed: ' + (e.message || String(e))));
}

// -- Predict -- //
// Must match the backend prediction type enum in src/predict.js (VALID_TYPES).
const PREDICT_TYPE_LABELS = {
  next_action: 'Next Action', likely_failure: 'Likely Failure', missing_prerequisite: 'Missing Prerequisite',
  relevant_context: 'Relevant Context', incident_recurrence: 'Incident Risk',
  workflow_opportunity: 'Workflow Opportunity', stale_or_contradicted: 'Stale / Contradicted'
};
const PREDICT_STATUS_COLORS = {
  active: '#3fb950', expired: '#8b949e', superseded: '#a371f7', dismissed: '#f85149',
  confirmed: '#3fb950', did_not_occur: '#f0883e', unresolved: '#f85149'
};
const PREDICT_CONFIDENCE_COLORS = {
  very_high: '#3fb950', high: '#58a6ff', medium: '#a371f7', low: '#f0883e', none: '#8b949e'
};
const PREDICT_STATUS_CLASS = Object.fromEntries(Object.keys(PREDICT_STATUS_COLORS).map(key => [key, 'predict-status-' + key]));
const PREDICT_CONFIDENCE_CLASS = Object.fromEntries(Object.keys(PREDICT_CONFIDENCE_COLORS).map(key => [key, 'predict-confidence-' + key]));

// Field names below are the canonical /api/predict/status contract documented
// in docs/predict.md. Do not read undeclared fields.
function loadPredictStatus() {
  authFetch('/api/predict/status').then(r => r.json()).then(d => {
    const el = $('predictStatus');
    if (!el) return;
    const detectors = d.detectors || [];
    const enabled = detectors.filter(x => x.enabled).length;
    const lastAnalyzed = d.last_analyzed ? fmtDate(d.last_analyzed) : 'never';
    const scope = d.last_analysis_scope;
    const scopeLabel = scope
      ? esc(scope.mode + (scope.project ? ':' + scope.project : '') + (scope.session_id ? ':' + scope.session_id : ''))
      : '—';
    const s = d.last_analysis_summary;

    let html = '<div class="predict-status">' +
      '<span>Active: <strong class="predict-stat active">' + (d.active || 0) + '</strong></span>' +
      '<span>Terminal: <strong class="predict-stat">' + (d.terminal || 0) + '</strong></span>' +
      '<span>Total retained: <strong class="predict-stat">' + (d.total || 0) + '</strong></span>' +
      '<span>Detectors: <strong class="predict-stat">' + enabled + '/' + detectors.length + '</strong></span>' +
      '<span>Last analysis: <strong class="predict-stat">' + lastAnalyzed + '</strong></span>' +
      '<span>Scope: <strong class="predict-stat">' + scopeLabel + '</strong></span>' +
      '<span>Retention: <strong class="predict-stat">' + (d.retention_days != null ? d.retention_days + 'd' : 'not configured') + '</strong></span>' +
    '</div>';

    if (s) {
      const rejected = s.rejected_by_reason || {};
      const rejectedTotal = Object.values(rejected).reduce(function (a, b) { return a + b; }, 0);
      const rejectedDetail = Object.keys(rejected).length
        ? Object.keys(rejected).map(function (k) { return esc(k) + '=' + rejected[k]; }).join(', ')
        : 'none';
      html += '<div class="predict-run-summary">' +
        'Last run: considered <strong class="predict-stat">' + (s.candidates_considered || 0) + '</strong>, ' +
        'admitted <strong class="predict-stat">' + (s.candidates_admitted || 0) + '</strong>, ' +
        'rejected <strong class="predict-stat">' + rejectedTotal + '</strong> (' + rejectedDetail + ')' +
        ' · created ' + (s.created || 0) +
        ' · refreshed ' + (s.refreshed || 0) +
        ' · reactivated ' + (s.reactivated || 0) +
        ' · superseded ' + (s.superseded || 0) +
        ' · expired ' + (s.expired || 0) +
      '</div>';
    }

    if (d.last_purge) {
      const p = d.last_purge;
      html += '<div class="predict-purge-summary">Last purge: ' +
        (p.deleted_predictions || 0) + ' predictions, ' + (p.deleted_evidence || 0) + ' evidence, ' +
        (p.preserved || 0) + ' preserved by policy</div>';
    }

    el.innerHTML = html;
  });
}

function loadPredict() {
  const list = $('predictList');
  if (!list) return;
  list.innerHTML = '<div class="empty">Loading predictions...</div>';
  const status = $('predictStatusFilter') ? $('predictStatusFilter').value : 'active';
  const type = $('predictTypeFilter') ? $('predictTypeFilter').value : '';
  const confidence = $('predictConfidenceFilter') ? $('predictConfidenceFilter').value : '';
  let url = '/api/predict?limit=50';
  if (status) url += '&status=' + encodeURIComponent(status);
  if (type) url += '&type=' + encodeURIComponent(type);
  if (confidence) url += '&confidence=' + encodeURIComponent(confidence);
  authFetch(url).then(r => r.json()).then(d => {
    const items = d.predictions || [];
    $('predictCount').textContent = items.length;
    const detail = $('predictDetail');
    if (detail) detail.style.display = 'none';
    if (!items.length) {
      list.innerHTML = '<div class="empty">No predictions found. Click Analyze to generate predictions.</div>';
      return;
    }
    list.innerHTML = items.map(p => {
      const typeLabel = PREDICT_TYPE_LABELS[p.type] || p.type;
      const statusClass = PREDICT_STATUS_CLASS[p.status] || 'predict-status-unknown';
      const confidenceClass = PREDICT_CONFIDENCE_CLASS[p.confidence] || 'predict-confidence-none';
      const pct = Math.round((p.probability || 0) * 100);
      return '<div class="card predict-card" data-dashboard-action="predict" data-handler="showPredictDetail" data-id="' + attr(p.id) + '">' +
        '<div class="predict-head">' +
          '<div class="predict-subject">' + esc(p.subject || p.type) +
            '<div class="predict-explanation">' + esc(p.explanation || '').substring(0, 200) + (p.explanation && p.explanation.length > 200 ? '...' : '') + '</div>' +
          '</div>' +
          '<div class="predict-type">' +
            '<div>' + esc(typeLabel) + '</div>' +
            '<div class="predict-probability ' + confidenceClass + '">' + pct + '%</div>' +
          '</div>' +
        '</div>' +
        '<div class="predict-badges">' +
          '<span class="badge ' + statusClass + '">' + esc(p.status) + '</span>' +
          '<span class="badge ' + confidenceClass + '">confidence=' + esc(p.confidence) + '</span>' +
          '<span class="badge">observations=' + esc(p.observation_count || 0) + '</span>' +
          (p.project ? '<span class="badge">' + esc(p.project) + '</span>' : '') +
          '<div class="predict-spacer"></div>' +
          '<progress class="predict-progress-fill ' + confidenceClass + '" value="' + pct + '" max="100" aria-label="Prediction probability">' + pct + '%</progress>' +
        '</div>' +
      '</div>';
    }).join('');
  }).catch(e => {
    list.innerHTML = '<div class="agent-err">Failed to load predictions</div>';
    apiError('/api/predict', e, 0);
  });
}

function showPredictDetail(id) {
  const detail = $('predictDetail');
  if (!detail) return;
  detail.style.display = 'block';
  detail.innerHTML = '<div class="empty">Loading prediction details...</div>';
  authFetch('/api/predict/' + encodeURIComponent(id)).then(r => r.json()).then(d => {
    const p = d.prediction;
    if (!p) { detail.innerHTML = '<div class="agent-err">Prediction not found</div>'; return; }
    const evidence = d.evidence || [];
    const feedback = d.feedback || [];
    const typeLabel = PREDICT_TYPE_LABELS[p.type] || p.type;
    const pct = Math.round((p.probability || 0) * 100);
    const breakdown = p.score_breakdown || {};
    detail.innerHTML = '<div class="card predict-detail-card">' +
      '<div class="predict-detail-head">' +
        '<div>' +
          '<div class="predict-detail-type">' + esc(typeLabel) + ' &middot; ' + esc(p.id) + '</div>' +
          '<div class="predict-detail-subject">' + esc(p.subject || p.type) + '</div>' +
        '</div>' +
        '<div class="predict-detail-probability">' +
          '<div>' + pct + '%</div>' +
          '<div class="predict-detail-confidence">' + esc(p.confidence) + ' confidence</div>' +
        '</div>' +
      '</div>' +
      '<div class="predict-detail-explanation">' + esc(p.explanation || 'No explanation') + '</div>' +
      '<div class="predict-detail-badges">' +
        '<span class="badge ' + (PREDICT_STATUS_CLASS[p.status] || 'predict-status-unknown') + '">' + esc(p.status) + '</span>' +
        '<span class="badge">observations=' + esc(p.observation_count || 0) + '</span>' +
        (p.project ? '<span class="badge">' + esc(p.project) + '</span>' : '') +
        (p.session_id ? '<span class="badge">session=' + esc(p.session_id.substring(0, 12)) + '</span>' : '') +
        '<span class="badge">rule=' + esc(p.rule_version || 'none') + '</span>' +
      '</div>' +
      (Object.keys(breakdown).length ? '<div class="predict-section"><div class="predict-section-title">Score Breakdown</div><pre class="predict-pre">' + esc(JSON.stringify(breakdown, null, 2)) + '</pre></div>' : '') +
      (evidence.length ? '<div class="predict-section"><div class="predict-section-title">Evidence (' + evidence.length + ')</div>' + evidence.map(e =>
        '<div class="predict-evidence">' +
          '<div><span class="badge">' + esc(e.source_type) + '</span> ' + (e.source_id ? '<code>' + esc(e.source_id) + '</code>' : '') + (e.timestamp ? ' <span class="summary-muted">' + esc(fmtTime(e.timestamp)) + '</span>' : '') + '</div>' +
          '<div class="predict-summary">' + esc(e.summary || '') + '</div>' +
        '</div>'
      ).join('') : '</div>') +
      (feedback.length ? '<div class="predict-section"><div class="predict-section-title">Feedback (' + feedback.length + ')</div>' + feedback.map(f =>
        '<div class="predict-feedback"><span class="badge predict-feedback-' + (f.feedback === 'useful' ? 'useful' : f.feedback === 'not_useful' ? 'not-useful' : 'other') + '">' + esc(f.feedback) + '</span> ' + (f.created_at ? '<span class="summary-muted">' + esc(fmtTime(f.created_at)) + '</span>' : '') + (f.context ? ' <span class="summary-muted">' + esc(f.context) + '</span>' : '') + '</div>'
      ).join('') : '</div>') +
      '<div class="predict-actions">' +
        '<button class="btn btn-sm" data-dashboard-action="predict" data-handler="predictFeedback" data-id="' + attr(p.id) + '" data-value="useful">Useful</button>' +
        '<button class="btn btn-sm" data-dashboard-action="predict" data-handler="predictFeedback" data-id="' + attr(p.id) + '" data-value="not_useful">Not Useful</button>' +
        '<button class="btn btn-sm" data-dashboard-action="predict" data-handler="predictFeedback" data-id="' + attr(p.id) + '" data-value="acted_on">Acted On</button>' +
        '<button class="btn btn-sm" data-dashboard-action="predict" data-handler="predictOutcome" data-id="' + attr(p.id) + '" data-value="confirmed">Confirmed</button>' +
        '<button class="btn btn-sm" data-dashboard-action="predict" data-handler="predictOutcome" data-id="' + attr(p.id) + '" data-value="did_not_occur">Did Not Occur</button>' +
        '<button class="btn btn-sm btn-outline" data-dashboard-action="predict" data-handler="predictDismiss" data-id="' + attr(p.id) + '">Dismiss</button>' +
        '<button class="btn btn-sm btn-outline" data-dashboard-action="predict" data-handler="predictBack">Back to list</button>' +
      '</div>' +
    '</div>';
  }).catch(e => {
    detail.innerHTML = '<div class="agent-err">Failed to load prediction details</div>';
  });
}

function predictFeedback(id, feedback) {
  authFetch('/api/predict/' + encodeURIComponent(id) + '/feedback', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feedback })
  }).then(r => r.json()).then(d => {
    if (d.ok !== false) { showPredictDetail(id); loadPredictStatus(); } else { alert('Error: ' + (d.error || 'unknown')); }
  }).catch(e => alert('Failed'));
}

function predictOutcome(id, outcome) {
  authFetch('/api/predict/' + encodeURIComponent(id) + '/outcome', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ outcome })
  }).then(r => r.json()).then(d => {
    if (d.ok !== false) { showPredictDetail(id); loadPredictStatus(); } else { alert('Error: ' + (d.error || 'unknown')); }
  }).catch(e => alert('Failed'));
}

function predictDismiss(id) {
  if (!confirm('Dismiss this prediction?')) return;
  authFetch('/api/predict/' + encodeURIComponent(id) + '/dismiss', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }
  }).then(r => r.json()).then(d => {
    if (d.ok !== false) { predictBack(); loadPredict(); loadPredictStatus(); } else { alert('Error: ' + (d.error || 'unknown')); }
  }).catch(e => alert('Failed'));
}

function predictBack() {
  const detail = $('predictDetail');
  const list = $('predictList');
  if (detail) detail.style.display = 'none';
  if (list) list.style.display = 'block';
  loadPredict();
}

// Builds an explicit analysis scope. An empty body is never sent: a global
// all-project sweep must be chosen deliberately in the scope selector.
function predictAnalyzeBody() {
  const mode = $('predictScope') ? $('predictScope').value : 'project';
  const value = $('predictScopeValue') ? $('predictScopeValue').value.trim() : '';
  const body = { scope: mode };
  if (mode === 'project') {
    if (!value) return { error: 'Enter a project name, or choose "All projects (global)" to analyze everything.' };
    body.project = value;
  } else if (mode === 'session') {
    if (!value) return { error: 'Enter a session id to analyze a single session.' };
    body.session_id = value;
  } else if (mode === 'task') {
    if (!value) return { error: 'Enter a task id to analyze a single task.' };
    body.task_id = value;
  }
  return { body: body };
}

function runPredictAnalyze() {
  const out = $('predictAnalyzeResult');
  const built = predictAnalyzeBody();
  if (built.error) {
    if (out) out.innerHTML = '<div class="agent-err">' + esc(built.error) + '</div>';
    return;
  }
  if (built.body.scope === 'global' &&
      !confirm('Run a global analysis across every project? This is intentionally broad.')) {
    return;
  }

  const btn = document.querySelector('#page-predict .btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Analyzing...'; }
  if (out) out.innerHTML = '<div class="empty">Analyzing...</div>';

  authFetch('/api/predict/analyze', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(built.body)
  }).then(r => r.json()).then(d => {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-magnifying-glass-chart"></i> Analyze'; }
    if (out) {
      if (d.ok === false) {
        out.innerHTML = '<div class="agent-err">' + esc(d.error || 'Analysis failed') + '</div>';
      } else {
        // Report what actually changed rather than silently refreshing the list.
        const rejected = d.rejected_by_reason || {};
        const rejectedTotal = Object.values(rejected).reduce(function (a, b) { return a + b; }, 0);
        const parts = [
          'considered ' + (d.candidates_considered || 0),
          'admitted ' + (d.candidates_admitted || 0),
          'created ' + (d.created || 0),
          'refreshed ' + (d.refreshed || 0),
          'reactivated ' + (d.reactivated || 0),
          'suppressed ' + (d.suppressed || 0),
          'superseded ' + (d.superseded || 0),
          'expired ' + (d.expired || 0)
        ];
        let html = '<div class="card compact-card compact-result">' +
          '<div><strong>Analysis complete</strong> ' +
          '<span class="summary-muted">(' + esc(d.scope ? d.scope.mode : '') +
          (d.scope && d.scope.project ? ':' + esc(d.scope.project) : '') + ', ' + (d.duration_ms || 0) + 'ms)</span></div>' +
          '<div class="summary-muted compact-label">' + parts.join(' · ') + '</div>';
        if (rejectedTotal > 0) {
          html += '<div class="summary-muted compact-label">Rejected ' + rejectedTotal + ': ' +
            Object.keys(rejected).map(function (k) { return esc(k) + '=' + rejected[k]; }).join(', ') + '</div>';
        }
        html += '</div>';
        out.innerHTML = html;
      }
    }
    loadPredictStatus();
    loadPredict();
  }).catch(e => {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-magnifying-glass-chart"></i> Analyze'; }
    if (out) out.innerHTML = '<div class="agent-err">Analysis failed</div>';
  });
}

// Read-only retention preview. Cleanup itself requires a separate confirmation.
function runPredictPurgePreview() {
  const out = $('predictAnalyzeResult');
  if (out) out.innerHTML = '<div class="empty">Loading purge preview...</div>';
  authFetch('/api/predict/maintenance/purge-preview').then(r => r.json()).then(d => {
    if (!out) return;
    if (d.ok === false) { out.innerHTML = '<div class="agent-err">' + esc(d.error || 'Preview failed') + '</div>'; return; }
    const w = d.would_delete || {};
    const preserved = d.preserved || {};
    out.innerHTML = '<div class="card compact-card compact-result">' +
      '<div><strong>Purge preview</strong> ' +
      '<span class="summary-muted">(retention ' + esc(String(d.retention_days)) + 'd, cutoff ' + esc(String(d.cutoff)) + ')</span></div>' +
      '<div class="summary-muted compact-label">Would delete: ' + (w.predictions || 0) + ' predictions, ' +
      (w.prediction_evidence || 0) + ' evidence, ' + (w.prediction_audit || 0) + ' audit rows. ' +
      'Feedback rows are always retained.</div>' +
      '<div class="summary-muted compact-label">Preserved by policy: ' + (preserved.count || 0) + '</div>' +
      '<div class="summary-muted compact-label">Nothing was modified. Run purge from the Predict tool with confirm=true to execute.</div>' +
    '</div>';
  }).catch(e => {
    if (out) out.innerHTML = '<div class="agent-err">Purge preview failed</div>';
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
      const result = a.result_preview ? '<pre class="approval-result">' + esc(a.result_preview) + '</pre>' : '';
      return '<div class="approval-entry">' +
        '<div class="approval-head">' +
          '<div>' +
            '<div class="approval-tool">' + esc(a.tool) + '</div>' +
            '<div class="approval-meta">' +
              '<span class="badge ' + riskClass + '">' + esc(a.risk || 'low') + '</span> ' +
              '<span class="badge">' + esc(a.source || 'unknown') + '</span> ' +
              '<span class="badge">' + esc(a.status || 'pending') + '</span>' +
            '</div>' +
          '</div>' +
          (pending ? '<div class="approval-actions">' +
            '<button class="btn btn-sm" data-dashboard-action="callback" data-handler="approveRequest" data-id="' + attr(a.id) + '"><i class="fas fa-check"></i> Approve</button>' +
            '<button class="btn btn-sm btn-outline" data-dashboard-action="callback" data-handler="rejectRequest" data-id="' + attr(a.id) + '"><i class="fas fa-times"></i> Reject</button>' +
          '</div>' : '') +
        '</div>' +
        '<div class="approval-notes">' +
          '<div><span class="s-label">Requested:</span> ' + esc(requested) + '</div>' +
          '<div><span class="s-label">Reason:</span> ' + esc(a.reason || '') + '</div>' +
          completed +
        '</div>' +
        // Task-originated approvals persist no preview: arguments are stored
        // encrypted and rendered on demand for an authenticated reader
        // (docs/adr-approval-continuation.md §4.4). Showing '{}' here would
        // mean asking a human to authorize an action they cannot see, so these
        // get an explicit fetch control instead.
        (a.args_preview_available
          // esc() escapes &, < and > but NOT quotes, so it is wrong for an
          // attribute or JS-string context — jsArg()/attr() are the helpers for
          // those. An id containing a quote would otherwise break out of the
          // onclick handler.
          ? '<div class="approval-preview">' +
              '<button class="btn btn-sm btn-outline" data-dashboard-action="callback" data-handler="loadApprovalPreview" data-id="' + attr(a.id) + '">' +
                '<i class="fas fa-eye"></i> Show arguments</button>' +
              '<pre id="approval-args-' + attr(a.id) + '" class="approval-args"></pre>' +
            '</div>'
          : '<pre class="approval-args">' + esc(a.args_preview || '{}') + '</pre>') +
        result +
      '</div>';
    }).join('');
  }).catch(e => apiError('/api/approvals', e, 0));
}

// The four permitted reconciliation decisions (ADR §8.2). Each carries its own
// consequence text, because the wrong choice here is not recoverable by
// re-deciding: `confirm_not_executed` re-authorizes a dispatch, and asserting
// an effect did not land when it did produces exactly the double-execution the
// risk gate exists to prevent. It is audited but not verifiable.
var RECONCILIATION_DECISIONS = [
  {
    id: 'confirm_executed',
    label: 'It ran',
    icon: 'fa-check',
    style: '',
    meaning: 'The effect landed. The step is recorded as completed and the task continues from the next step. The tool is not run again.',
    confirm: null
  },
  {
    id: 'confirm_not_executed',
    label: 'It did not run',
    icon: 'fa-rotate-right',
    style: 'btn-danger',
    meaning: 'The effect did not land. The authorization is renewed with a fresh expiry and the runner dispatches the step ONCE more.',
    confirm: 'This re-runs the tool.\n\nIf the effect actually DID land, confirming this causes it to happen twice — which is the exact outcome the safety gate exists to prevent. It is audited but cannot be verified.\n\nOnly continue if you have checked the target system and know the action did not take effect.'
  },
  {
    id: 'abandon_step',
    label: 'Give up on this step',
    icon: 'fa-forward',
    style: 'btn-outline',
    meaning: 'Unknown and not worth resolving. The step is recorded as refused and the planner continues without it.',
    confirm: 'Record this step as abandoned and let the task continue without it?'
  },
  {
    id: 'fail_task',
    label: 'Fail the task',
    icon: 'fa-ban',
    style: 'btn-outline',
    meaning: 'Unsafe to continue. The task is failed and the step is recorded as refused.',
    confirm: 'Fail the whole task? It will not continue past this point.'
  }
];

// Ambiguous high-risk executions awaiting a human decision. Kept separate from
// the approval inbox on purpose — see the comment on the section in
// dashboard.html.
function loadReconciliations(){
  authFetch('/api/reconciliations').then(r=>r.json()).then(d=>{
    var items = d.reconciliations || [];
    var section = $('reconciliationSection');
    var list = $('reconciliationList');
    if (!section || !list) return;

    $('reconciliationCount').textContent = items.length;
    // Hidden entirely when there is nothing to decide: this section is alarming
    // by design and should not be permanent furniture.
    section.style.display = items.length ? 'block' : 'none';
    if (!items.length) { list.innerHTML = '<div class="empty">Nothing awaiting reconciliation</div>'; return; }

    list.innerHTML = items.map(function(r){
      var riskClass = r.risk === 'critical' ? 'danger' : r.risk === 'high' ? 'warn' : '';
      var buttons = d.can_resolve
        ? RECONCILIATION_DECISIONS.map(function(dec){
            return '<button class="btn btn-sm reconciliation-decision ' + dec.style + '" data-dashboard-action="callback" data-handler="resolveReconciliation" data-id="' + attr(r.task_id) + '" data-value="' + attr(dec.id) + '" ' +
              'title="' + attr(dec.meaning) + '">' +
              '<i class="fas ' + dec.icon + '"></i> ' + esc(dec.label) + '</button>';
          }).join('')
        : '<div class="reconciliation-error">Resolving requires an authenticated principal. ' +
          'Configure dashboard authentication — an unattributed reconciliation is refused by design.</div>';

      return '<div class="approval-entry">' +
        '<div class="approval-head">' +
          '<div>' +
            '<div class="approval-tool">' + esc(r.tool_name) + '</div>' +
            '<div class="approval-meta">' +
              '<span class="badge ' + riskClass + '">' + esc(r.risk || 'unknown') + '</span> ' +
              '<span class="badge">task ' + esc(r.task_id) + '</span> ' +
              '<span class="badge">step ' + esc(r.step_id) + '</span> ' +
              '<span class="badge">attempt ' + esc(String(r.attempt_count)) + '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="approval-notes">' +
          '<div><span class="s-label">Authorized by:</span> ' + esc(r.approver_identity || '(unattributed)') + '</div>' +
          '<div><span class="s-label">Requested:</span> ' + esc(r.requested_at ? fmtDate(r.requested_at) : '') + '</div>' +
          '<div><span class="s-label">Became ambiguous:</span> ' + esc(r.updated_at ? fmtDate(r.updated_at) : '') + '</div>' +
          '<div><span class="s-label">Argument digest:</span> <code>' + esc(r.args_digest || '') + '</code></div>' +
        '</div>' +
        (r.args_preview_available
          ? '<div class="approval-preview">' +
              '<button class="btn btn-sm btn-outline" data-dashboard-action="callback" data-handler="loadApprovalPreview" data-id="' + attr(r.approval_id) + '">' +
                '<i class="fas fa-eye"></i> Show arguments</button>' +
              '<pre id="approval-args-' + attr(r.approval_id) + '" class="approval-args"></pre>' +
            '</div>'
          : '<div class="approval-preview summary-muted">Arguments are no longer available; only the digest above identifies this action.</div>') +
        '<div class="reconciliation-actions">' + buttons + '</div>' +
      '</div>';
    }).join('');
  }).catch(e => apiError('/api/reconciliations', e, 0));
}

function resolveReconciliation(taskId, decision){
  var dec = RECONCILIATION_DECISIONS.filter(function(x){ return x.id === decision; })[0];
  if (!dec) return;
  if (dec.confirm && !confirm(dec.confirm)) return;

  authFetch('/api/reconciliations/' + encodeURIComponent(taskId) + '/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: decision })
  })
    .then(r=>r.json())
    .then(d=>{
      if (!d.ok) { alert('Could not resolve: ' + (d.error || 'unknown')); }
      loadReconciliations();
      loadApprovals();
      loadLogs();
    })
    .catch(e => apiError('/api/reconciliations/' + taskId + '/resolve', e, 0));
}

// Renders a task-originated approval's arguments on demand. The server
// decrypts, authenticates the payload against its digest, and redacts; nothing
// is persisted and nothing is cached here. A tampered payload reports as such
// rather than being displayed as genuine — a reviewer must not be shown a
// forgery of what they are authorizing.
function loadApprovalPreview(id){
  var target = document.getElementById('approval-args-' + id);
  if (!target) return;
  target.classList.add('is-visible');
  target.textContent = 'Loading…';
  authFetch('/api/approvals/' + encodeURIComponent(id) + '/preview')
    .then(r=>r.json())
    .then(d=>{
      if (!d.ok) { target.textContent = 'Arguments unavailable: ' + (d.error || 'unknown'); return; }
      target.textContent = d.preview.args_preview || '{}';
    })
    .catch(e => { target.textContent = 'Arguments unavailable'; apiError('/api/approvals/' + id + '/preview', e, 0); });
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

function renderDbSchema(schema) {
  let html = '';
  for (const [table, info] of Object.entries(schema)) {
    html += '<div class="database-table-section">';
    html += '<div class="database-table-heading">';
    html += '<i class="fas fa-table database-icon"></i>';
    html += '<span class="database-name">' + esc(table) + '</span>';
    html += '<span class="database-row-count">(' + info.rowCount + ' rows)</span>';
    html += '</div>';
    html += '<div class="database-columns">';
    for (const col of info.columns) {
      const pk = col.pk ? '<span class="database-flag database-primary">PK</span>' : '';
      const notnull = col.notnull ? '<span class="database-flag database-notnull">NOT NULL</span>' : '';
      html += '<div class="database-column">';
      html += '<i class="fas fa-columns database-column-icon"></i>';
      html += '<span class="database-column-name">' + esc(col.name) + '</span>';
      html += '<span class="database-column-type">' + esc(col.type || 'TEXT') + '</span>';
      html += pk + notnull;
      html += '</div>';
    }
    if (info.indexes.length > 0) {
      html += '<div class="database-indexes">';
      for (const idx of info.indexes) {
        html += '<div class="database-index">';
        html += '<i class="fas fa-key database-index-icon"></i>';
        html += '<span class="database-index-name">' + esc(idx.name) + '</span>';
        if (idx.unique) html += '<span class="database-unique">UNIQUE</span>';
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
      let html = '<div class="database-result-count">' + d.count + ' rows (' + d.duration + 'ms)</div>';
      html += '<table class="database-results-table">';
      html += '<thead><tr>';
      for (const col of cols) {
        html += '<th>' + esc(col) + '</th>';
      }
      html += '</tr></thead><tbody>';
      for (const row of d.rows) {
        html += '<tr>';
        for (const col of cols) {
          const val = row[col];
          const display = val === null ? '<span class="database-null">NULL</span>' : esc(String(val));
          html += '<td>' + display + '</td>';
        }
        html += '</tr>';
      }
      html += '</tbody></table>';
      $('dbQueryResult').innerHTML = html;
    } else {
      $('dbQueryResult').innerHTML = '<div class="database-error">' + esc(d.error) + '</div>';
    }
  }).catch(e => {
    $('dbQueryResult').innerHTML = '<div class="database-error">' + esc(e.message) + '</div>';
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
        html += '<div class="database-search-section">';
        html += '<div class="database-search-heading">' + esc(table) + ' (' + rows.length + ')</div>';
        for (const row of rows.slice(0, 5)) {
          html += '<div class="database-search-row">';
          html += esc(JSON.stringify(row).substring(0, 200));
          if (JSON.stringify(row).length > 200) html += '...';
          html += '</div>';
        }
        if (rows.length > 5) {
          html += '<div class="database-search-more">... and ' + (rows.length - 5) + ' more</div>';
        }
        html += '</div>';
      }
      $('dbSearchResult').innerHTML = html;
    } else {
      $('dbSearchResult').innerHTML = '<div class="agent-err">' + esc(d.error) + '</div>';
    }
  }).catch(e => {
    $('dbSearchResult').innerHTML = '<div class="agent-err">' + esc(e.message) + '</div>';
  });
}

function renderDbMigrations(d) {
  let html = '<div class="database-current-version">Current version: <span class="database-version">' + d.currentVersion + '</span></div>';
  if (d.migrations.length === 0) {
    html += '<div class="empty">No migrations found</div>';
  } else {
    for (const m of d.migrations) {
      const status = m.applied ? '<span class="database-applied"><i class="fas fa-check"></i> Applied</span>' : '<span class="database-pending"><i class="fas fa-clock"></i> Pending</span>';
      html += '<div class="database-migration">';
      html += '<span class="database-migration-file">' + esc(m.file) + '</span>';
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
    authFetch('/api/tool-categories').then(r=>r.json()),
    // Non-fatal: the summary card falls back to 0 rather than blanking the catalog.
    authFetch('/api/approvals?status=pending').then(r=>r.json()).catch(()=>({}))
  ]).then(([toolsData, statsData, procData, catData, approvalData]) => {
    allTools = toolsData.tools || [];
    allProcedures = procData.procedures || [];
    toolCategories = catData.categories || [];
    pendingApprovalCount = (approvalData.approvals || []).length;
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
      html += '<div class="tool-card" data-dashboard-action="callback" data-handler="showToolDetail" data-id="' + attr(t.name) + '">';
      html += '<div class="tool-card-name">' + esc(t.name) + '</div>';
      html += '<div class="tool-card-desc">' + esc(t.description) + '</div>';
      html += '<div class="tool-card-badges">';
      html += '<span class="badge ' + riskClass + '">risk: ' + esc(t.risk || 'low') + '</span>';
      html += '<span class="badge ' + (t.enabled === false ? 'danger' : '') + '">' + esc(stateLabel) + '</span>';
      if (t.approval_required) html += '<span class="badge warn">approval queue</span>';
      html += '</div>';
      if (hasStats) {
        const rate = Math.round(stats.ok / stats.count * 100);
        const rateClass = rate >= 90 ? 'tool-rate-good' : rate >= 70 ? 'tool-rate-warn' : 'tool-rate-danger';
        html += '<div class="tool-card-stats">';
        html += '<span class="stat-item"><i class="fas fa-play"></i> ' + stats.count + '</span>';
        html += '<span class="stat-item"><i class="fas fa-check"></i> ' + stats.ok + '</span>';
        html += '<span class="stat-item"><i class="fas fa-times"></i> ' + stats.fail + '</span>';
        html += '<span class="stat-item"><i class="fas fa-clock"></i> ' + stats.avgMs + 'ms</span>';
        html += '<span class="stat-item ' + rateClass + '"><i class="fas fa-chart-line"></i> ' + rate + '%</span>';
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
  }
  
  // Add Evolved Procedures section
  if (allProcedures.length > 0) {
    html += '<div class="tool-category-header tool-category-evolved">';
    html += '<i class="fas fa-magic"></i>';
    html += '<span class="cat-name">Evolved Procedures</span>';
    html += '<span class="cat-count">' + allProcedures.length + '</span>';
    html += '</div>';
    html += '<div class="tool-grid">';
    for (const p of allProcedures) {
      html += '<div class="tool-card" data-dashboard-action="callback" data-handler="showProcedureDetail" data-id="' + attr(p.name) + '">';
      html += '<div class="tool-card-name">' + esc(p.name) + '</div>';
      html += '<div class="tool-card-desc">' + esc(p.description) + '</div>';
      html += '<div class="procedure-meta">';
      html += '<span class="procedure-pill evolved"><i class="fas fa-magic"></i> evolved</span>';
      html += '<span class="procedure-pill steps">' + p.steps.length + ' steps</span>';
      if (p.useCount > 0) {
        html += '<span class="procedure-pill used">used ' + p.useCount + 'x</span>';
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
  let html = '<div class="tool-detail-overlay active">';
  html += '<div class="tool-detail">';
  html += '<h3><i class="fas ' + catInfo.icon + ' tool-detail-icon"></i>' + esc(t.name) + '</h3>';
  html += '<div class="td-desc">' + esc(t.description) + '</div>';
  html += '<div class="td-section"><div class="td-label">Category</div><div class="tool-detail-category">' + esc(cat) + '</div></div>';
  html += '<div class="td-section"><div class="td-label">Policy</div><div class="tool-detail-state ' + (t.enabled === false ? 'disabled' : 'ok') + '">' + esc(getToolStateLabel(t)) + ' - risk: ' + esc(t.risk || 'low') + '</div><div class="tool-detail-policy">' + esc(t.policy || '') + '</div></div>';
  html += '<div class="td-section"><div class="td-label">Approval</div><div class="tool-detail-approval ' + (t.approval_required ? 'required' : 'optional') + '">' + (t.approval_required ? 'Required before execution' : 'Not required') + '</div><div class="tool-detail-approval-note">' + esc(t.approval || '') + '</div></div>';
  if (hasStats) {
    const rate = Math.round(stats.ok / stats.count * 100);
    const rateClass = rate >= 90 ? 'success' : rate >= 70 ? 'warning' : 'danger';
    html += '<div class="td-section"><div class="td-label">Usage Stats</div>';
    html += '<div class="tool-detail-stats">';
    html += '<div><div class="tool-detail-stat-value accent">' + stats.count + '</div><div class="tool-detail-stat-label">CALLS</div></div>';
    html += '<div><div class="tool-detail-stat-value success">' + stats.ok + '</div><div class="tool-detail-stat-label">SUCCESS</div></div>';
    html += '<div><div class="tool-detail-stat-value danger">' + stats.fail + '</div><div class="tool-detail-stat-label">FAIL</div></div>';
    html += '<div><div class="tool-detail-stat-value neutral">' + stats.avgMs + 'ms</div><div class="tool-detail-stat-label">AVG</div></div>';
    html += '<div><div class="tool-detail-stat-value ' + rateClass + '">' + rate + '%</div><div class="tool-detail-stat-label">RATE</div></div>';
    html += '</div></div>';
  }
  if (t.args && Object.keys(t.args).length) {
    html += '<div class="td-section"><div class="td-label">Arguments</div><div class="td-args">';
    for (const [k, v] of Object.entries(t.args)) {
      const isOpt = String(v).includes('optional');
      html += '<div class="td-arg-row"><span class="td-arg-name">' + esc(k) + '</span><span class="td-arg-type">' + esc(String(v)) + '</span>' + (isOpt ? ' <span class="optional-arg">(optional)</span>' : '') + '</div>';
    }
    html += '</div></div>';
  }
  html += '<div class="overlay-actions"><button class="btn btn-outline" data-dashboard-action="close-overlay">Close</button></div>';
  html += '</div></div>';
  const existing = document.querySelector('.tool-detail-overlay');
  if (existing) existing.remove();
  document.body.insertAdjacentHTML('beforeend', html);
}

function showProcedureDetail(name){
  const p = allProcedures.find(x => x.name === name);
  if (!p) return;
  let html = '<div class="tool-detail-overlay active">';
  html += '<div class="tool-detail">';
  html += '<h3><i class="fas fa-magic tool-detail-icon evolved"></i>' + esc(p.name) + '</h3>';
  html += '<div class="td-desc">' + esc(p.description) + '</div>';
  html += '<div class="td-section"><div class="td-label">Type</div><div class="procedure-type"><i class="fas fa-magic"></i> Evolved Procedure</div></div>';
  html += '<div class="td-section"><div class="td-label">Created</div><div class="procedure-date">' + (p.createdAt ? new Date(p.createdAt).toLocaleString() : 'Unknown') + '</div></div>';
  if (p.lastUsed) {
    html += '<div class="td-section"><div class="td-label">Last Used</div><div class="procedure-date">' + new Date(p.lastUsed).toLocaleString() + '</div></div>';
  }
  html += '<div class="td-section"><div class="td-label">Usage Count</div><div class="procedure-usage">' + (p.useCount || 0) + ' times</div></div>';
  
  if (p.parameters && Object.keys(p.parameters).length > 0) {
    html += '<div class="td-section"><div class="td-label">Parameters</div><div class="td-args">';
    for (const [k, v] of Object.entries(p.parameters)) {
      html += '<div class="td-arg-row"><span class="td-arg-name">' + esc(k) + '</span><span class="td-arg-type">' + esc(v.type || 'string') + '</span>' + (v.required ? '' : ' <span class="optional-arg">(optional)</span>') + '</div>';
    }
    html += '</div></div>';
  }
  
  if (p.steps && p.steps.length > 0) {
    html += '<div class="td-section"><div class="td-label">Steps (' + p.steps.length + ')</div>';
    html += '<div class="procedure-steps">';
    for (let i = 0; i < p.steps.length; i++) {
      const step = p.steps[i];
      html += '<div class="procedure-step">';
      html += '<div class="procedure-step-title">Step ' + (i+1) + ': ' + esc(step.tool) + '</div>';
      html += '<div class="procedure-step-args">';
      html += esc(JSON.stringify(step.args, null, 2));
      html += '</div></div>';
    }
    html += '</div></div>';
  }
  
  if (p.triggerPhrases && p.triggerPhrases.length > 0) {
    html += '<div class="td-section"><div class="td-label">Trigger Phrases</div>';
    html += '<div class="procedure-triggers">';
    for (const phrase of p.triggerPhrases) {
      html += '<span class="procedure-trigger">' + esc(phrase) + '</span>';
    }
    html += '</div></div>';
  }
  
  html += '<div class="overlay-actions"><button class="btn btn-outline" data-dashboard-action="close-overlay">Close</button></div>';
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
    return '<button class="blackbox-incident' + cls + '" data-dashboard-action="callback" data-handler="showBlackboxIncident" data-id="' + attr(inc.id) + '">'
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
  const isAnalyzable = latest && latest.source_count > 0 && !['no_evidence', 'blocked', 'failed_preflight'].includes(latest.state);
  let html = '<div class="blackbox-overview">';
  html += '<div><div class="mission-kicker">' + esc(incident.id) + '</div><h3>' + esc(incident.title) + '</h3><p>' + esc(incident.description || 'No description recorded.') + '</p></div>';
  html += '<div class="blackbox-state"><span>' + esc(incident.lifecycle_state) + '</span><small>' + esc(incident.severity || 'unknown') + '</small></div>';
  html += '</div>';
  html += '<div class="blackbox-toolbar">';
  html += '<button class="btn btn-sm btn-outline" data-dashboard-action="callback" data-handler="analyzeBlackboxIncident" data-id="' + attr(incident.id) + '"' + (isAnalyzable ? '' : ' disabled title="No analyzable evidence available"') + '><i class="fas fa-magnifying-glass-chart"></i> Analyze</button>';
  html += '<button class="btn btn-sm btn-outline" data-dashboard-action="callback" data-handler="pinBlackboxIncident" data-id="' + attr(incident.id) + '"><i class="fas fa-thumbtack"></i> Pin</button>';
  html += '<button class="btn btn-sm btn-outline" data-dashboard-action="callback" data-handler="exportBlackboxIncident" data-id="' + attr(incident.id) + '"><i class="fas fa-download"></i> Export</button>';
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
  const isFailed = ['no_evidence', 'blocked', 'failed_preflight'].includes(capture.state);
  const isEmpty = capture.source_count === 0 || capture.succeeded_count === 0;
  let html = '<div class="td-section"><div class="td-label">Latest Capture</div>';
  if (isFailed || isEmpty) {
    html += '<div class="blackbox-failure-banner"><strong>Capture ' + esc(capture.state) + '</strong><span>' + esc(capture.error_summary || 'No sources produced usable evidence') + '</span>';
    const diag = capture.diagnostics || {};
    if (diag.requested_profile || diag.collector_selection_path) {
      html += '<div class="blackbox-diagnostics"><small>Profile: ' + esc(diag.requested_profile || 'unknown') + ' → ' + esc(diag.resolved_profile || 'unknown') + ' | Path: ' + esc(diag.collector_selection_path || 'unknown') + ' | Selected: ' + (diag.selected_count || 0) + ' collectors</small>';
      if (diag.collectors_rejected && diag.collectors_rejected.length) html += '<small>Rejected: ' + esc(diag.collectors_rejected.map(r => r.key + ' (' + r.reason + ')').join(', ')) + '</small>';
      html += '</div>';
    }
    html += '<button class="btn btn-sm btn-outline" data-dashboard-action="callback" data-handler="retryBlackboxCapture" data-id="' + attr(capture.id) + '" data-index="' + attr(capture.incident_id) + '"><i class="fas fa-rotate-right"></i> Retry Capture</button>';
    html += '</div>';
  }
  html += '<div class="blackbox-capture-head"><strong>' + esc(capture.id) + '</strong><span class="badge ' + (capture.state === 'completed' ? '' : 'warn') + '">' + esc(capture.state) + '</span><span>' + esc(capture.profile) + '</span><span>' + esc(capture.succeeded_count + '/' + capture.source_count + ' succeeded') + '</span><span>' + esc(formatBytes(capture.total_bytes || 0)) + '</span></div>';
  if (capture.retry_of) html += '<div class="blackbox-retry-link"><small>Retry of: ' + esc(capture.retry_of) + '</small></div>';
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
    box.innerHTML = sources.map(source => '<button class="blackbox-source ' + esc(source.state) + '" data-dashboard-action="callback" data-handler="openBlackboxSource" data-id="' + attr(source.id) + '">'
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
    let html = '<div class="tool-detail-overlay active"><div class="tool-detail blackbox-source-detail">';
    html += '<h3>' + esc(s.display_name) + '</h3>';
    html += '<div class="meta-grid"><div><span>Source</span><strong>' + esc(s.source_key) + '</strong></div><div><span>State</span><strong>' + esc(s.state) + '</strong></div><div><span>Duration</span><strong>' + esc(s.duration_ms || 0) + 'ms</strong></div><div><span>Hash</span><strong>' + esc((s.content_hash || '').slice(0, 16)) + '</strong></div></div>';
    html += '<div class="td-section"><div class="td-label">Collector</div><div class="quick-action-pre">' + esc(s.command + ' ' + (s.arguments_preview || []).join(' ')) + '</div></div>';
    if (s.error_message) html += '<div class="quick-action-error">' + esc(s.error_message) + '</div>';
    html += '<div class="tab-switch"><button class="active">Stdout</button><button>Stderr</button><button>Normalized</button></div>';
    html += '<div class="value-block is-long">' + esc(s.stdout || '') + '</div>';
    if (s.stderr) html += '<div class="td-section"><div class="td-label">Stderr</div><div class="value-block is-long">' + esc(s.stderr) + '</div></div>';
    html += '<div class="td-section"><div class="td-label">Normalized</div><div class="value-block">' + esc(JSON.stringify(s.normalized || {}, null, 2)) + '</div></div>';
    html += '<div class="overlay-actions"><button class="btn btn-outline" data-dashboard-action="close-overlay">Close</button></div>';
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

async function retryBlackboxCapture(captureId, incidentId){
  const progress = $('blackboxProgress');
  if (progress) progress.innerHTML = '<div class="blackbox-progress-title">Retrying capture...</div>';
  try {
    const res = await authFetch('/api/blackbox/captures/' + encodeURIComponent(captureId) + '/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Retry failed');
    const cap = data.capture;
    if (progress) progress.innerHTML = '<div class="blackbox-progress-title">Retry capture ' + esc(cap.state) + ': ' + esc(cap.succeeded_count + '/' + cap.source_count) + ' sources completed</div>';
    selectedBlackboxIncident = cap.incident_id;
    await loadBlackbox();
  } catch (error) {
    if (progress) progress.innerHTML = '<div class="quick-action-error">' + esc(error.message) + '</div>';
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
    document.body.insertAdjacentHTML('beforeend', '<div class="tool-detail-overlay active"><div class="tool-detail"><h3>Export Preview</h3><div class="value-block is-long">' + esc(text) + '</div><div class="overlay-actions"><button class="btn btn-outline" data-dashboard-action="close-overlay">Close</button></div></div></div>');
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// -- Refresh -- //
function refresh(){
  // Only refresh live overview pages AND tab is visible
  if (currentPage !== 'mission' && currentPage !== 'system' && currentPage !== 'compute') return;
  if (document.hidden) return;

  if (currentPage === 'compute') {
    refreshCompute();
    return;
  }
  if (currentPage === 'mission') {
    loadMissionControl();
  } else {
    const now = new Date();
    $('lastUpdate').textContent = 'updated ' + now.toLocaleTimeString();
    loadSystem(); loadDashboardSummary(); loadLLM(); loadServices();
  }
}

// Restore last viewed tab
document.addEventListener('keydown', function (event) {
  if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
  const target = event.target;
  if (target && target.id === 'agentGoal') { event.preventDefault(); runAgent(); }
  else if (target && target.id === 'agentFollowupGoal') { event.preventDefault(); submitFollowup(); }
});
const pageHash = location.hash.slice(1);
const savedPage = localStorage.getItem('sidekick_currentPage');
const initialPage = document.getElementById('page-' + pageHash) ? pageHash : (document.getElementById('page-' + savedPage) ? savedPage : 'mission');
document.querySelectorAll('.side-nav a[data-page]').forEach(link => link.addEventListener('click', event => {
  event.preventDefault();
  routeToPage(link.dataset.page);
}));
window.addEventListener('popstate', () => routeToPage(location.hash.slice(1) || 'mission', true));
window.addEventListener('hashchange', () => showPage(location.hash.slice(1) || 'mission'));
document.querySelectorAll('.nav-group-title').forEach(button => button.addEventListener('click', () => {
  const group = button.closest('.nav-group');
  const collapsed = group.classList.toggle('is-collapsed');
  button.setAttribute('aria-expanded', String(!collapsed));
}));
const sidebar = $('appSidebar');
const sidebarCollapsed = localStorage.getItem('sidekick_sidebar_collapsed') === 'true';
if (sidebarCollapsed) sidebar.classList.add('collapsed');
const sidebarToggle = $('sidebarToggle');
if (sidebarToggle) sidebarToggle.addEventListener('click', () => {
  const collapsed = sidebar.classList.toggle('collapsed');
  localStorage.setItem('sidekick_sidebar_collapsed', String(collapsed));
  sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  sidebarToggle.setAttribute('aria-label', collapsed ? 'Expand navigation' : 'Collapse navigation');
});
const mobileMenu = $('mobileMenu');
if (mobileMenu) mobileMenu.addEventListener('click', () => sidebar.classList.add('mobile-open'));
document.addEventListener('click', event => { if (window.innerWidth <= 900 && sidebar.classList.contains('mobile-open') && !sidebar.contains(event.target) && event.target !== mobileMenu) sidebar.classList.remove('mobile-open'); });
showPage(initialPage);
if (location.hash !== '#' + initialPage) history.replaceState(null, '', '#' + initialPage);
const projectsRefresh = $('projectsRefresh');
if (projectsRefresh) projectsRefresh.addEventListener('click', loadProjects);

function setWorkspace(projectId, label, navigate) {
  const workspaceLabel = $('workspaceLabel');
  const workspaceButton = $('workspaceButton');
  if (workspaceLabel) workspaceLabel.textContent = label;
  if (workspaceButton) {
    workspaceButton.setAttribute('aria-label', 'Current workspace: ' + projectId);
    workspaceButton.setAttribute('aria-expanded', 'false');
  }
  try { localStorage.setItem('sidekick_workspace', projectId); } catch (_) {}
  const menu = $('workspaceMenu');
  if (menu) menu.hidden = true;
  if (navigate && projectId !== 'global') routeToPage('projects');
}

function loadWorkspaceOptions() {
  const menu = $('workspaceMenu');
  const button = $('workspaceButton');
  if (!menu || !button) return;
  let current = 'global';
  try { current = localStorage.getItem('sidekick_workspace') || 'global'; } catch (_) {}
  button.addEventListener('click', async () => {
    menu.hidden = !menu.hidden;
    button.setAttribute('aria-expanded', String(!menu.hidden));
    if (menu.hidden || menu.dataset.loaded) return;
    menu.innerHTML = '<div class="view-state">Loading workspaces...</div>';
    try {
      const response = await authFetch('/api/projects?limit=200');
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'Workspace list unavailable');
      const options = [{ id: 'global', label: 'Global workspace', detail: 'Unscoped platform view' }].concat((data.projects || []).map(row => ({ id: row.project.project_id, label: row.project.display_name || row.project.project_id, detail: row.workspace ? 'Configured project workspace' : 'Project context only' })));
      menu.innerHTML = options.map(option => '<button class="workspace-option" type="button" role="option" data-workspace-id="' + attr(option.id) + '" data-workspace-label="' + attr(option.label) + '" aria-selected="' + (option.id === current) + '">' + esc(option.label) + '<small>' + esc(option.detail) + '</small></button>').join('');
      menu.dataset.loaded = 'true';
      menu.querySelectorAll('[data-workspace-id]').forEach(option => option.addEventListener('click', () => setWorkspace(option.dataset.workspaceId, option.dataset.workspaceLabel, true)));
    } catch (error) {
      menu.innerHTML = '<div class="view-state view-state-error">' + esc(error.message) + '</div>';
    }
  });
  setWorkspace(current, current === 'global' ? 'Global workspace' : current, false);
}
loadWorkspaceOptions();

const commandPages = [['mission','Mission Control','fa-compass'],['projects','Projects','fa-folder-tree'],['agent','Agent','fa-robot'],['handoffs','Handoffs','fa-route'],['research','Research','fa-flask'],['approvals','Approvals','fa-shield-halved'],['brain','Brain','fa-brain'],['memory','Memory','fa-database'],['predict','Predict','fa-wand-magic-sparkles'],['evolve','Evolve','fa-seedling'],['activity','Activity','fa-list-check'],['blackbox','Black Box','fa-life-ring'],['compute','Compute','fa-microchip'],['metrics','Metrics','fa-chart-line'],['tools','Tools','fa-toolbox'],['capabilities','Capabilities','fa-puzzle-piece'],['network-scopes','Network Scopes','fa-network-wired'],['identity','Identity','fa-id-badge'],['system','Health & System','fa-heart-pulse'],['data','Data','fa-box-archive'],['database','Database','fa-table'],['config','Configuration','fa-sliders']];
function renderCommandResults(query) { const results = $('commandResults'); if (!results) return; const q = query.trim().toLowerCase(); results.innerHTML = commandPages.filter(page => !q || page[1].toLowerCase().includes(q)).map(page => '<button class="command-result" type="button" role="option" data-command-page="' + page[0] + '"><i class="fas ' + page[2] + '" aria-hidden="true"></i><span>' + esc(page[1]) + '</span></button>').join('') || '<div class="empty">No matching workspace.</div>'; results.querySelectorAll('[data-command-page]').forEach(button => button.addEventListener('click', () => { commandDialog.close(); routeToPage(button.dataset.commandPage); })); }
const commandDialog = $('commandDialog');
if (commandDialog) { const openCommand = () => { commandDialog.showModal(); renderCommandResults(''); $('commandInput').focus(); }; $('commandTrigger').addEventListener('click', openCommand); $('commandClose').addEventListener('click', () => commandDialog.close()); $('commandInput').addEventListener('input', event => renderCommandResults(event.target.value)); }
document.addEventListener('keydown', event => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (commandDialog && !commandDialog.open) commandDialog.showModal(); renderCommandResults(''); $('commandInput').focus(); } if (event.key === 'Escape' && sidebar) sidebar.classList.remove('mobile-open'); });

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

// --- Capabilities (capability packs) ---------------------------------------
//
// Read-only rendering plus action buttons. Every mutation is a POST to the
// dashboard API, which dispatches the governed `capability` tool server-side;
// nothing here mutates pack state directly.

const CAP_HEALTH_CLASS = {
  healthy: 'ok',
  disabled: 'warn',
  degraded: 'warn',
  restart_required: 'warn',
  configuration_required: 'warn',
  incompatible: 'err',
  integrity_failure: 'err',
  component_failure: 'err',
};

function capPill(status) {
  const cls = CAP_HEALTH_CLASS[status] || 'warn';
  return '<span class="metrics-status-pill ' + cls + '">' + esc(status || 'unknown') + '</span>';
}

function capError(message) {
  const el = $('capError');
  if (!el) return;
  el.innerHTML = message
    ? '<div class="card error-card-inline">' + esc(message) + '</div>'
    : '';
}

async function loadCapabilities() {
  capError('');
  try {
    const res = await authFetch('/api/capabilities');
    const data = await res.json();
    if (!data.ok) { capError(data.error || 'Failed to load capability packs'); return; }
    renderInstalledCapabilities(data.installed || []);
    renderAvailableCapabilities(data.available_bundled || []);
    $('capCount').textContent = (data.installed || []).length;
  } catch (error) {
    capError(error.message);
  }
}

function networkScopeError(message) {
  const el = $('networkScopeError');
  if (el) el.innerHTML = message ? '<div class="card error-card-inline">' + esc(message) + '</div>' : '';
}

async function loadNetworkScopes() {
  networkScopeError('');
  try {
    const res = await authFetch('/api/network-scopes');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to load network scopes');
    const scopes = data.scopes || [];
    $('networkScopeCount').textContent = scopes.length;
    $('networkScopeList').innerHTML = scopes.length ? scopes.map(renderNetworkScope).join('') : '<div class="sub">No named network scopes have been created.</div>';
  } catch (error) { networkScopeError(error.message); }
}

function renderNetworkScope(scope) {
  const enabled = scope.state === 'active';
  const action = enabled ? 'disabled' : 'active';
  return '<div class="card scope-card">'
    + '<div class="scope-head">'
    + '<div><div class="identity-name">' + esc(scope.name) + ' <span class="sub">r' + esc(scope.revision) + '</span></div>'
    + '<div class="sub">' + esc(scope.scope_id) + ' &middot; ' + esc(scope.state) + ' &middot; digest ' + esc((scope.digest || '').slice(0, 16)) + '...</div></div>'
    + '<div class="network-scope-actions"><button class="btn btn-sm btn-outline" data-dashboard-action="callback" data-handler="setNetworkScopeState" data-id="' + attr(scope.scope_id) + '" data-value="' + attr(action) + '">' + (enabled ? 'Disable' : 'Enable') + '</button>'
    + '<button class="btn btn-sm" data-dashboard-action="callback" data-handler="updateNetworkScope" data-id="' + attr(scope.scope_id) + '">New Revision</button></div></div>'
    + '<pre class="scope-json">' + esc(JSON.stringify(scope, null, 2)) + '</pre></div>';
}

async function createNetworkScope() {
  try {
    const policy = JSON.parse($('networkScopePolicy').value || '{}');
    policy.name = $('networkScopeName').value.trim();
    const res = await authFetch('/api/network-scopes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(policy) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to create network scope');
    $('networkScopeName').value = ''; $('networkScopePolicy').value = '';
    await loadNetworkScopes();
  } catch (error) { networkScopeError(error.message); }
}

async function setNetworkScopeState(scopeId, state) {
  if (!confirm((state === 'disabled' ? 'Disable' : 'Enable') + ' this network scope?')) return;
  try {
    const res = await authFetch('/api/network-scopes/' + encodeURIComponent(scopeId) + '/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state }) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to update network scope state');
    await loadNetworkScopes();
  } catch (error) { networkScopeError(error.message); }
}

async function updateNetworkScope(scopeId) {
  const raw = prompt('Enter the complete policy JSON for the new immutable revision:');
  if (raw === null) return;
  try {
    const policy = JSON.parse(raw);
    const res = await authFetch('/api/network-scopes/' + encodeURIComponent(scopeId), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(policy) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Failed to revise network scope');
    await loadNetworkScopes();
  } catch (error) { networkScopeError(error.message); }
}

function renderInstalledCapabilities(packs) {
  const el = $('capInstalled');
  if (!packs.length) {
    el.innerHTML = '<div class="sub">No capability packs installed.</div>';
    return;
  }
  el.innerHTML = packs.map(pack => {
    const actions = [];
    actions.push('<button class="btn btn-sm" data-dashboard-action="callback" data-handler="capabilityDetail" data-id="' + attr(pack.name) + '"><i class="fas fa-circle-info"></i> Details</button>');
    actions.push('<button class="btn btn-sm" data-dashboard-action="callback" data-handler="capabilityHealth" data-id="' + attr(pack.name) + '"><i class="fas fa-stethoscope"></i> Health Check</button>');
    actions.push('<button class="btn btn-sm btn-outline" data-dashboard-action="callback" data-handler="capabilityMaturity" data-id="' + attr(pack.name) + '"><i class="fas fa-certificate"></i> Maturity</button>');
    if (pack.enabled) {
      actions.push('<button class="btn btn-sm btn-outline" data-dashboard-action="callback" data-handler="capabilityAction" data-id="' + attr(pack.name) + '" data-value="disable"><i class="fas fa-pause"></i> Disable</button>');
    } else {
      actions.push('<button class="btn btn-sm" data-dashboard-action="callback" data-handler="capabilityAction" data-id="' + attr(pack.name) + '" data-value="enable"><i class="fas fa-play"></i> Enable</button>');
    }
    actions.push('<button class="btn btn-sm btn-outline" data-dashboard-action="callback" data-handler="capabilityUpgrade" data-id="' + attr(pack.name) + '"><i class="fas fa-arrow-up"></i> Upgrade</button>');
    actions.push('<button class="btn btn-sm btn-outline" data-dashboard-action="callback" data-handler="capabilityUninstall" data-id="' + attr(pack.name) + '"><i class="fas fa-trash"></i> Uninstall</button>');

    return '<div class="card capability-card">'
      + '<div class="capability-head">'
      + '<div>'
      + '<div class="identity-name">' + esc(pack.display_name || pack.name) + ' <span class="sub">v' + esc(pack.version) + '</span></div>'
      + '<div class="sub">' + esc(pack.name) + ' &middot; ' + esc(pack.publisher || 'unknown publisher') + ' &middot; '
      + esc(pack.provenance === 'first_party' ? 'first-party' : 'third-party')
      + (pack.bundled ? ' &middot; bundled' : '') + '</div>'
      + '</div>'
      + '<div>' + capPill(pack.health) + ' <span class="metrics-status-pill ' + (pack.enabled ? 'ok' : 'warn') + '">' + esc(pack.state) + '</span>'
       + ' <span class="metrics-status-pill ' + (pack.maturity && pack.maturity.level === 'certified' ? 'ok' : 'warn') + '" title="Evidence-bound pack maturity">' + esc((pack.maturity && pack.maturity.level) || 'foundation') + '</span></div>'
      + '</div>'
      + '<div class="sub capability-meta">'
      + 'Modules: ' + (pack.modules.length ? esc(pack.modules.join(', ')) : 'none')
      + ' &middot; Tools: ' + (pack.tools.length ? esc(pack.tools.join(', ')) : 'none')
      + ' &middot; Workflows: ' + pack.workflows.length
      + ' &middot; Knowledge: ' + pack.knowledge
      + '</div>'
      + '<div class="capability-actions">' + actions.join('') + '</div>'
      + '<pre id="capDetail-' + attr(pack.name) + '" class="capability-detail"></pre>'
      + '</div>';
  }).join('');
}

function renderAvailableCapabilities(packs) {
  const el = $('capAvailable');
  if (!packs.length) {
    el.innerHTML = '<div class="sub">No uninstalled bundled packs.</div>';
    return;
  }
  el.innerHTML = packs.map(pack => {
    if (pack.error) {
      return '<div class="card capability-card capability-invalid">'
        + '<div class="identity-name">' + esc(pack.name) + '</div>'
        + '<div class="sub capability-invalid-note">Invalid bundled pack: ' + esc(pack.error) + '</div></div>';
    }
    const blocked = !pack.compatible;
    return '<div class="card capability-card">'
      + '<div class="capability-head">'
      + '<div>'
      + '<div class="identity-name">' + esc(pack.display_name || pack.name) + ' <span class="sub">v' + esc(pack.version) + '</span></div>'
      + '<div class="sub">' + esc(pack.description || '') + '</div>'
      + '<div class="sub">' + esc(pack.publisher || '') + ' &middot; first-party &middot; bundled &middot; '
      + pack.modules.length + ' module(s), ' + pack.workflows + ' workflow(s), ' + pack.knowledge + ' knowledge asset(s)</div>'
      + (blocked ? '<div class="sub capability-invalid-note">Incompatible: requires Sidekick ' + esc(pack.requires_sidekick || '') + '</div>' : '')
      + '</div>'
      + '<div class="capability-actions capability-action-buttons">'
      + '<button class="btn btn-sm btn-outline" data-dashboard-action="callback" data-handler="inspectBundledCapability" data-id="' + attr(pack.name) + '"><i class="fas fa-magnifying-glass"></i> Inspect</button>'
      + '<button class="btn btn-sm" ' + (blocked ? 'disabled' : '') + ' data-dashboard-action="callback" data-handler="installBundledCapability" data-id="' + attr(pack.name) + '"><i class="fas fa-download"></i> Install</button>'
      + '</div>'
      + '</div></div>';
  }).join('');
}

async function capabilityPost(url, body, label) {
  capError('');
  try {
    const res = await authFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json();
    if (!data.ok) {
      capError((label ? label + ': ' : '') + (data.error || 'operation failed'));
      return null;
    }
    await loadCapabilities();
    return data;
  } catch (error) {
    capError(error.message);
    return null;
  }
}

function capabilityAction(name, action) {
  return capabilityPost('/api/capabilities/' + encodeURIComponent(name) + '/' + action, {}, action);
}

async function capabilityDetail(name) {
  const el = $('capDetail-' + name);
  if (!el) return;
  if (el.classList.contains('is-visible')) { el.classList.remove('is-visible'); return; }
  const res = await authFetch('/api/capabilities/' + encodeURIComponent(name));
  const data = await res.json();
  el.textContent = JSON.stringify(data.pack || data, null, 2);
  el.classList.add('is-visible');
}

async function capabilityHealth(name) {
  const el = $('capDetail-' + name);
  const res = await authFetch('/api/capabilities/' + encodeURIComponent(name) + '/health');
  const data = await res.json();
  if (el) {
    el.textContent = JSON.stringify(data.health || data, null, 2);
    el.classList.add('is-visible');
  }
  loadCapabilities();
}

async function capabilityMaturity(name) {
  const el = $('capDetail-' + name);
  try {
    const res = await authFetch('/api/capabilities/' + encodeURIComponent(name) + '/maturity');
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'maturity unavailable');
    const maturity = data.maturity || {};
    if (el) {
      el.textContent = JSON.stringify({
        level: maturity.level,
        evidence_freshness: maturity.evidence_freshness,
        optional_provider_integration: maturity.optional_provider_integration,
        reasons: maturity.reasons || [],
        evidence: maturity.evidence || [],
      }, null, 2);
      el.classList.add('is-visible');
    }
  } catch (error) {
    capError('maturity: ' + error.message);
  }
}

function capabilityUpgrade(name) {
  const path = prompt('Server-local path of the upgrade package (leave blank to upgrade from the bundled release copy):', '');
  if (path === null) return;
  return capabilityPost('/api/capabilities/' + encodeURIComponent(name) + '/upgrade', path ? { path } : {}, 'upgrade');
}

function capabilityUninstall(name) {
  if (!confirm('Uninstall capability pack "' + name + '"?\n\nThis removes its modules, workflow definitions, knowledge entries and managed package files. Historical execution and audit records are preserved.')) return;
  return capabilityPost('/api/capabilities/' + encodeURIComponent(name) + '/uninstall', {}, 'uninstall');
}

function installBundledCapability(name) {
  if (!confirm('Install capability pack "' + name + '"?\n\nIts modules become executable code inside Sidekick once enabled.')) return;
  return capabilityPost('/api/capabilities/install', { name, enable: false }, 'install');
}

async function inspectBundledCapability(name) {
  await showCapabilityInspection({ name });
}

async function inspectLocalCapability() {
  const path = $('capLocalPath').value.trim();
  if (!path) { capError('Enter a server-local package path to inspect.'); return; }
  await showCapabilityInspection({ path });
}

async function installLocalCapability() {
  const path = $('capLocalPath').value.trim();
  if (!path) { capError('Enter a server-local package path to install.'); return; }
  if (!confirm('Install the capability pack at "' + path + '"?\n\nThird-party pack modules run as trusted executable code inside the Sidekick process once enabled.')) return;
  await capabilityPost('/api/capabilities/install', { path, enable: false }, 'install');
}

async function showCapabilityInspection(body) {
  capError('');
  const el = $('capInspect');
  try {
    const res = await authFetch('/api/capabilities/inspect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) { capError(data.error || 'inspection failed'); el.style.display = 'none'; return; }
    el.textContent = JSON.stringify(data.inspection, null, 2);
    el.style.display = 'block';
  } catch (error) {
    capError(error.message);
    el.style.display = 'none';
  }
}

async function loadHandoffs() {
  const status = $('handoffStatus');
  const list = $('handoffList');
  if (!status || !list) return;
  status.textContent = 'Loading handoffs...';
  list.innerHTML = '';
  try {
    const response = await authFetch('/api/handoffs?limit=50');
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'handoff request failed');
    const projections = await Promise.all((data.handoffs || []).map(async handoff => {
      const result = await authFetch('/api/handoffs/' + encodeURIComponent(handoff.id) + '/start-here');
      const body = await result.json();
      return body.projection || { handoff_id: handoff.id, title: handoff.title, lifecycle_state: handoff.lifecycle_state, start_here: {} };
    }));
    status.textContent = projections.length + ' handoff' + (projections.length === 1 ? '' : 's');
    if (!projections.length) { list.innerHTML = '<div class="card"><div class="empty">No handoffs found.</div></div>'; return; }
    list.innerHTML = projections.map(projection => {
      const start = projection.start_here || {};
      const evidence = projection.evidence || {};
      const quality = projection.quality || {};
      const readiness = projection.readiness || {};
      const lifecycle = String(projection.lifecycle_state || 'unknown');
      const lifecycleHealthy = ['ready', 'claimed', 'verifying', 'active', 'released', 'completed'].includes(lifecycle);
      const readinessStatus = String(readiness.status || 'unknown');
      const blockers = Array.isArray(start.blockers) ? start.blockers : [];
      const questions = Array.isArray(start.open_questions) ? start.open_questions : [];
      return '<div class="card mission-panel mission-panel-wide">' +
        '<div class="mission-panel-head"><div><div class="section-title">' + esc(start.objective || projection.title || projection.handoff_id) + '</div><div class="sub">' + esc(projection.handoff_id || '') + ' · v' + esc(String(projection.version || '')) + '</div></div>' +
        '<div class="handoff-actions"><span class="metrics-status-pill ' + (lifecycleHealthy ? 'ok' : 'warn') + '" title="Authoritative handoff lifecycle">' + esc(lifecycle) + '</span>' +
        '<span class="metrics-status-pill ' + (readinessStatus === 'ready' ? 'ok' : 'warn') + '" title="Receiver resume readiness">Readiness: ' + esc(readinessStatus) + '</span></div></div>' +
        '<div class="mission-muted">Next: ' + esc(start.next_step || 'No next step recorded') + '</div>' +
        '<div class="mission-metrics"><div><span>Quality</span><strong>' + (quality.valid ? 'Ready' : 'Needs work') + '</strong></div><div><span>Evidence</span><strong>' + esc(String(evidence.fresh || 0)) + ' fresh / ' + esc(String(evidence.stale || 0)) + ' stale</strong></div><div><span>Blockers</span><strong>' + esc(String(blockers.length)) + '</strong></div><div><span>Questions</span><strong>' + esc(String(questions.length)) + '</strong></div></div>' +
        '<details><summary>Receiver details</summary><pre class="agent-log handoff-details">' + esc(JSON.stringify({ completed_steps: projection.completed_steps || [], decisions: start.decisions || [], blockers, open_questions: questions, risks: start.risks || [], acceptance_criteria: projection.acceptance_criteria || [], artifacts: projection.artifacts || [], relationships: projection.relationships || [], reasons: readiness.reasons || quality.issues || [] }, null, 2)) + '</pre></details>' +
        '</div>';
    }).join('');
  } catch (error) {
    status.textContent = 'Unable to load handoffs: ' + error.message;
    list.innerHTML = '<div class="card"><div class="empty">Handoff receiver data unavailable.</div></div>';
  }
}
