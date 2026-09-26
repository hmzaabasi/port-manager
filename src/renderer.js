const searchInput = document.getElementById('search');
const loopbackInput = document.getElementById('loopback-only');
const systemInput = document.getElementById('show-system');
const liveInput = document.getElementById('live');
const refreshButton = document.getElementById('refresh');
const listEl = document.getElementById('list');
const statsEl = document.getElementById('stats');
const statusEl = document.getElementById('status');
const liveDot = document.getElementById('live-dot');
const dialog = document.getElementById('confirm');
const confirmTitle = document.getElementById('confirm-title');
const confirmBody = document.getElementById('confirm-body');
const confirmWarning = document.getElementById('confirm-warning');
const confirmCancel = document.getElementById('confirm-cancel');

const PREFS_KEY = 'port-manager-prefs';
const LIVE_MS = 5000;

const state = {
  listeners: [],
  updatedAt: null,
  loading: false,
  killing: false,
  error: '',
  notice: '',
  pending: null,
};

let timer = 0;

function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
    if (typeof saved.loopbackOnly === 'boolean') loopbackInput.checked = saved.loopbackOnly;
    if (typeof saved.showSystem === 'boolean') systemInput.checked = saved.showSystem;
    if (typeof saved.live === 'boolean') liveInput.checked = saved.live;
    if (typeof saved.query === 'string') searchInput.value = saved.query;
  } catch {
    localStorage.removeItem(PREFS_KEY);
  }
}

function savePrefs() {
  localStorage.setItem(
    PREFS_KEY,
    JSON.stringify({
      loopbackOnly: loopbackInput.checked,
      showSystem: systemInput.checked,
      live: liveInput.checked,
      query: searchInput.value,
    })
  );
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scopeLabel(scope) {
  if (scope === 'local') return 'Loopback';
  if (scope === 'all') return 'All interfaces';
  return 'This network';
}

function projectFromCommand(command) {
  if (!command) return '';
  const text = command.replace(/"/g, '');
  const fromModules = text.match(/\\([^\\]+)\\node_modules\\/i);
  if (fromModules && !/^\.bin$/i.test(fromModules[1])) return fromModules[1];
  const script = text.match(/[A-Za-z]:\\(?:[^\\]+\\)*([^\\"\s]+\.(?:js|ts|mjs|cjs|py|jar|dll))/i);
  if (script && !/node_modules/i.test(script[0])) return script[1];
  return '';
}

function toolFromCommand(command) {
  if (!command) return '';
  if (/\\vite\\/i.test(command) || /\bvite\b/i.test(command)) return 'vite';
  if (/\bnext\b/i.test(command)) return 'next';
  if (/\bwebpack\b/i.test(command)) return 'webpack';
  if (/\bnodemon\b/i.test(command)) return 'nodemon';
  if (/\bpython(?:\.exe)?\b/i.test(command)) return 'python';
  if (/\bdotnet\b/i.test(command)) return 'dotnet';
  if (/\bjava(?:\.exe)?\b/i.test(command)) return 'java';
  return '';
}

function identity(item) {
  const project = projectFromCommand(item.command);
  const tool = toolFromCommand(item.command);
  if (project) {
    const detail = [item.name, tool].filter(Boolean).join(' · ');
    return { title: project, detail: detail || item.command };
  }
  const detail = item.command && item.command.toLowerCase() !== item.name.toLowerCase()
    ? item.command
    : item.path;
  return { title: item.name, detail };
}

function visibleListeners() {
  const query = searchInput.value.trim().toLowerCase();
  return state.listeners.filter((item) => {
    if (!systemInput.checked && item.kind !== 'app') return false;
    if (loopbackInput.checked && item.scope !== 'local') return false;
    if (!query) return true;
    const haystack = [
      item.port,
      item.name,
      item.pid,
      item.command,
      item.path,
      item.addresses.join(' '),
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });
}

function renderStats(visible) {
  const apps = new Set(visible.filter((item) => item.kind === 'app').map((item) => item.pid)).size;
  statsEl.innerHTML = `
    <div class="stat"><b>${visible.length}</b><span>Ports</span></div>
    <div class="stat"><b>${apps}</b><span>Apps</span></div>
  `;
}

function renderList() {
  const visible = visibleListeners();
  const hidden = state.listeners.length - visible.length;
  renderStats(visible);
  liveDot.hidden = false;
  liveDot.classList.toggle('on', liveInput.checked);

  const scroll = listEl.scrollTop;

  if (state.error && state.listeners.length === 0) {
    listEl.innerHTML = `
      <div class="error-box">
        <h2>Could not read ports</h2>
        <p>${escapeHtml(state.error)}</p>
      </div>
    `;
  } else if (state.loading && state.listeners.length === 0) {
    listEl.innerHTML = `
      <div class="empty">
        <h2>Looking up listeners</h2>
        <p>Checking TCP ports in use on this PC.</p>
      </div>
    `;
  } else if (visible.length === 0) {
    const title = state.listeners.length === 0 ? 'Nothing is listening' : 'No matches';
    const detail = state.listeners.length === 0
      ? 'Start a local server and it will show up here.'
      : 'Try another filter, or turn on Windows listeners.';
    listEl.innerHTML = `<div class="empty"><h2>${title}</h2><p>${detail}</p></div>`;
  } else {
    listEl.innerHTML = visible
      .map((item) => {
        const who = identity(item);
        const kindBadge = item.kind === 'app'
          ? ''
          : `<span class="badge system">${item.kind === 'critical' ? 'Protected' : 'Windows'}</span>`;
        const stopLabel = item.kind === 'critical' ? 'Protected' : 'Stop';
        return `
          <article class="row">
            <button class="port" type="button" data-copy="${item.port}" title="Copy port ${item.port}">${item.port}</button>
            <div class="app">
              <div class="app-name" title="${escapeHtml(item.path || item.command || item.name)}">${escapeHtml(who.title)}</div>
              ${who.detail ? `<div class="command" title="${escapeHtml(item.command || who.detail)}">${escapeHtml(who.detail)}</div>` : ''}
            </div>
            <div class="bind">
              <span class="badge ${item.scope}">${scopeLabel(item.scope)}</span>
              ${kindBadge}
              <span class="addr">${escapeHtml(item.addresses.join(', ') || '—')}</span>
            </div>
            <div class="pid" title="Process ID">${item.pid}</div>
            <button class="stop" type="button" data-stop="${item.pid}:${item.port}" ${item.kind === 'critical' || state.killing ? 'disabled' : ''}>${stopLabel}</button>
          </article>
        `;
      })
      .join('');
  }

  listEl.scrollTop = scroll;

  const hiddenNote = hidden > 0 ? `${hidden} hidden by filters. ` : '';
  const time = state.updatedAt
    ? `Updated ${state.updatedAt.toLocaleTimeString()}`
    : 'Not updated yet';
  statusEl.classList.toggle('error', Boolean(state.error) && state.listeners.length > 0);
  if (state.notice) {
    statusEl.textContent = state.notice;
  } else if (state.error && state.listeners.length > 0) {
    statusEl.textContent = state.error;
  } else if (state.killing) {
    statusEl.textContent = 'Stopping process…';
  } else if (state.loading && state.listeners.length > 0) {
    statusEl.textContent = `${hiddenNote}Refreshing…`;
  } else {
    statusEl.textContent = `${hiddenNote}${time}. Stopping a process also stops its child processes.`;
  }
}

async function refresh() {
  if (state.loading || state.killing || dialog.open) return;
  state.loading = true;
  renderList();
  const result = await window.portManager.list();
  state.loading = false;
  state.notice = '';
  if (result.ok) {
    state.listeners = result.listeners;
    state.updatedAt = new Date();
    state.error = '';
  } else {
    state.error = result.error || 'Could not read ports.';
  }
  renderList();
}

function portsForPid(pid) {
  return [...new Set(state.listeners.filter((item) => item.pid === pid).map((item) => item.port))].sort(
    (a, b) => a - b
  );
}

function openConfirm(item) {
  const ports = portsForPid(item.pid);
  const portText = ports.length === 1 ? `port ${ports[0]}` : `ports ${ports.join(', ')}`;
  state.pending = item;
  confirmTitle.textContent = `Stop ${identity(item).title}?`;
  confirmBody.textContent = `PID ${item.pid} is listening on ${portText}. This ends that process and its child processes.`;
  if (item.kind === 'system') {
    confirmWarning.hidden = false;
    confirmWarning.textContent = 'This looks like a Windows component. Stopping it can disrupt system services.';
  } else {
    confirmWarning.hidden = true;
    confirmWarning.textContent = '';
  }
  dialog.showModal();
  confirmCancel.focus();
}

async function stopPending() {
  const item = state.pending;
  state.pending = null;
  if (!item) return;
  state.killing = true;
  state.notice = '';
  renderList();
  const result = await window.portManager.kill(item.pid);
  state.killing = false;
  if (result.ok) {
    const stoppedName = identity(item).title;
    state.listeners = state.listeners.filter((listener) => listener.pid !== item.pid);
    await refresh();
    state.notice = `Stopped ${stoppedName} (PID ${item.pid}).`;
    renderList();
  } else {
    state.error = result.error || `Could not stop ${item.name}.`;
    state.notice = '';
    renderList();
  }
}

function schedule() {
  window.clearInterval(timer);
  timer = 0;
  if (!liveInput.checked) return;
  timer = window.setInterval(() => {
    refresh();
  }, LIVE_MS);
}

listEl.addEventListener('click', (event) => {
  const copy = event.target.closest('[data-copy]');
  if (copy) {
    window.portManager.copy(copy.dataset.copy).then((result) => {
      state.notice = result.ok ? `Copied port ${copy.dataset.copy}.` : 'Could not copy that port.';
      renderList();
    });
    return;
  }
  const stop = event.target.closest('[data-stop]');
  if (!stop || stop.disabled) return;
  const [pidText, portText] = stop.dataset.stop.split(':');
  const item = state.listeners.find((listener) => listener.pid === Number(pidText) && listener.port === Number(portText));
  if (item) openConfirm(item);
});

dialog.addEventListener('close', () => {
  if (dialog.returnValue === 'stop') stopPending();
  else state.pending = null;
});

searchInput.addEventListener('input', () => {
  savePrefs();
  renderList();
});

for (const input of [loopbackInput, systemInput]) {
  input.addEventListener('change', () => {
    savePrefs();
    renderList();
  });
}

liveInput.addEventListener('change', () => {
  savePrefs();
  schedule();
  renderList();
  if (liveInput.checked) refresh();
});

refreshButton.addEventListener('click', () => {
  refresh();
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r')) {
    event.preventDefault();
    refresh();
  }
});

window.portManager.onCommands((details) => {
  const byPid = new Map(details.map((detail) => [detail.pid, detail]));
  let changed = false;
  state.listeners = state.listeners.map((item) => {
    const extra = byPid.get(item.pid);
    if (!extra) return item;
    changed = true;
    return {
      ...item,
      path: extra.path || item.path,
      command: extra.command || item.command,
    };
  });
  if (changed && !dialog.open) renderList();
});

loadPrefs();
renderList();
schedule();
refresh();
