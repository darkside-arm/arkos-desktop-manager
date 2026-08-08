/* ─────────────────────────────────────────────────────────
   renderer.js  — R36S Manager
   Cache de gamelists en disco: ~/.config/r36s-manager/cache/
───────────────────────────────────────────────────────── */
'use strict';

// STORAGE — solo consolas y favoritos en localStorage
// Los gamelists van a disco via IPC (cache:load / cache:save)
const STORE_CONSOLES = 'r36s_consoles';
const STORE_LAST     = 'r36s_last';
const STORE_FAVS     = 'r36s_favs';

const loadConsoles = ()     => { try { return JSON.parse(localStorage.getItem(STORE_CONSOLES) || '[]'); } catch { return []; } };
const saveConsoles = list   => localStorage.setItem(STORE_CONSOLES, JSON.stringify(list));
const loadLastId   = ()     => localStorage.getItem(STORE_LAST) || null;
const saveLastId   = id     => localStorage.setItem(STORE_LAST, id);

// Cache en disco via IPC — nunca se borra automáticamente, solo con botón ↻
async function loadCache(host) {
  const r = await window.r36s.cacheLoad(host);
  if (!r.ok) return null;
  return r;   // sin TTL — la caché es permanente hasta que el usuario recargue
}
async function saveCache(host, systems, games) {
  await window.r36s.cacheSave(host, systems, games);
}
async function invalidateCache(host) {   // solo llamado por botón ↻
  await window.r36s.cacheInvalidate(host);
}

// ═══════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════
const state = {
  allGames:       [],
  systems:        [],
  favorites:      new Set(JSON.parse(localStorage.getItem(STORE_FAVS) || '[]')),
  currentView:    'all',
  layout:         'grid',
  suggestions:    [],
  currentConsole: null,
  platform:       'win32',
  page:           0,
};

// ═══════════════════════════════════════════════════════════
// SYSTEM EMOJI
// ═══════════════════════════════════════════════════════════
const SYS_EMOJI = {
  nes:'🎮',snes:'🕹️',n64:'🎮',gba:'🎮',gbc:'🎮',gb:'🎮',
  genesis:'⚡',megadrive:'⚡',sega32x:'⚡',segacd:'💿',saturn:'💿',
  dreamcast:'💿',gamegear:'🎮',mastersystem:'🎮',
  psx:'💿',ps2:'💿',
  arcade:'🕹️',fba:'🕹️',mame:'🕹️',neogeo:'🕹️',
  pce:'🎮',pcengine:'🎮',pcfx:'🎮',
  atari2600:'📺',atari7800:'📺',atarilynx:'🎮',
  default:'🎮',
};
function sysEmoji(name) {
  const k = (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const [key, val] of Object.entries(SYS_EMOJI)) { if (k.includes(key)) return val; }
  return SYS_EMOJI.default;
}

// ═══════════════════════════════════════════════════════════
// DOM
// ═══════════════════════════════════════════════════════════
const $ = id => document.getElementById(id);

// ═══════════════════════════════════════════════════════════
// INIT: platform + theme
// ═══════════════════════════════════════════════════════════
(async () => {
  const [dark, platform] = await Promise.all([window.r36s.getDarkMode(), window.r36s.getPlatform()]);
  state.platform = platform;
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-platform', platform);

  // En macOS: ocultamos los botones win-controls (los nativos están en el titlebar hiddenInset)
  if (platform === 'darwin') $('win-controls').style.display = 'none';

  renderSavedConsoles();
  await tryAutoReconnect();
})();

window.r36s.onThemeChange(dark => {
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
});

// ── Progreso de upload ROM (evento push desde main) ──────────
window.r36s.onRomUploadProgress(({ phase, romFile, transferred, total, pct, error }) => {
  const statusEl  = $('add-rom-status');
  const msgEl     = $('add-rom-status-msg');
  const pctEl     = $('add-rom-progress-pct');
  const barEl     = $('add-rom-progress-bar');
  const detailEl  = $('add-rom-progress-detail');

  if (phase === 'rom') {
    statusEl.classList.remove('hidden');
    msgEl.textContent = `Subiendo ${romFile}…`;
    const p = pct || 0;
    pctEl.textContent = `${p}%`;
    barEl.style.width = `${p}%`;
    if (total > 0) {
      detailEl.textContent = `${fmtSize(transferred)} / ${fmtSize(total)}`;
    }
  } else if (phase === 'image') {
    msgEl.textContent = 'Subiendo imagen de portada…';
    pctEl.textContent = '';
    barEl.style.width = '100%';
    detailEl.textContent = '';
  } else if (phase === 'gamelist') {
    msgEl.textContent = 'Actualizando gamelist.xml…';
    pctEl.textContent = '';
    barEl.style.width = '100%';
    detailEl.textContent = '';
  } else if (phase === 'done' || phase === 'error') {
    // Se ocultará desde el handler de upload una vez procesado
  }
});

// ── Window controls (Windows/Linux) ─────────────────────────
$('wc-min').addEventListener('click',   () => window.r36s.winMinimize());
$('wc-max').addEventListener('click',   () => window.r36s.winMaximize());
$('wc-close').addEventListener('click', () => window.r36s.winClose());

// ── Exit button (pantalla de login) ─────────────────────────
$('btn-exit').addEventListener('click', () => window.r36s.winClose());

// ═══════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════
let toastTimer;
function showToast(msg, ms = 2800) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ═══════════════════════════════════════════════════════════
// CONNECT SHEET
// ═══════════════════════════════════════════════════════════

// Contraseñas en sessionStorage (se borran al cerrar la app, nunca van a disco)
const SESSION_PASS_PFX = 'r36s_sp_';
const sessionPass = {
  get: id      => sessionStorage.getItem(SESSION_PASS_PFX + id) || '',
  set: (id, p) => sessionStorage.setItem(SESSION_PASS_PFX + id, p),
  del: id      => sessionStorage.removeItem(SESSION_PASS_PFX + id),
};

let reconnectShown = false;

function isSshConnectionError(msg) {
  const s = String(msg || '').toLowerCase();
  return (
    s.includes('not connected') ||
    s.includes('ssh no conectado') ||
    s.includes('connection lost') ||
    s.includes('connection reset') ||
    s.includes('econnreset') ||
    s.includes('timed out') ||
    s.includes('timeout') ||
    s.includes('all configured authentication methods failed')
  );
}

function showReconnectDialog(reason) {
  if (reconnectShown) return;
  reconnectShown = true;
  $('reconnect-msg').textContent = reason || 'Se perdió la conexión con la consola.';
  $('reconnect-error').classList.add('hidden');
  $('reconnect-sheet').classList.remove('hidden');
}

function hideReconnectDialog() {
  reconnectShown = false;
  $('reconnect-sheet').classList.add('hidden');
}

function setReconnectLoading(v) {
  $('reconnect-connect-btn').disabled = v;
  $('reconnect-connect-label').textContent = v ? 'Conectando…' : 'Conectar';
  v ? $('reconnect-spinner').classList.remove('hidden') : $('reconnect-spinner').classList.add('hidden');
}

function handleSshError(error, fallbackMsg) {
  const msg = error || fallbackMsg || 'Se perdió la conexión SSH.';
  if (isSshConnectionError(msg)) {
    showReconnectDialog(msg);
    return true;
  }
  return false;
}

async function tryReconnectFromDialog() {
  const c = state.currentConsole;
  if (!c) {
    const e = $('reconnect-error');
    e.textContent = 'No hay una consola activa para reconectar.';
    e.classList.remove('hidden');
    return;
  }

  const password = c.password || sessionPass.get(c.id) || '';
  setReconnectLoading(true);
  const res = await window.r36s.connect({
    host: c.host,
    port: c.port,
    username: c.username,
    password,
  });
  setReconnectLoading(false);

  if (!res.ok) {
    const e = $('reconnect-error');
    e.textContent = 'No se pudo reconectar: ' + (res.error || 'Error desconocido');
    e.classList.remove('hidden');
    return;
  }

  hideReconnectDialog();
  setFooterStatus('Reconectado', 'ok');
  showToast('✓ Conexión restablecida');
  await loadSystems(c.host);
}

$('reconnect-connect-btn').addEventListener('click', () => { tryReconnectFromDialog(); });
$('reconnect-close-btn').addEventListener('click', () => { window.r36s.winClose(); });

// id de la consola que está siendo editada actualmente (null = nueva)
let editingConsoleId = null;

function renderSavedConsoles() {
  const consoles = loadConsoles();
  const container = $('saved-consoles');
  const divider   = $('connect-divider');
  container.innerHTML = '';

  if (!consoles.length) { divider.classList.add('hidden'); return; }
  divider.classList.remove('hidden');

  consoles.forEach(c => {
    const hasSavedPass = !!sessionPass.get(c.id);
    const row = document.createElement('div');
    row.className = 'console-row' + (editingConsoleId === c.id ? ' console-row-editing' : '');
    row.dataset.id = c.id;
    row.innerHTML = `
      <div class="console-row-icon">${sysEmoji(c.name)}</div>
      <div class="console-row-info">
        <div class="console-row-name">${esc(c.name)}</div>
        <div class="console-row-host">${esc(c.username)}@${esc(c.host)}:${c.port}
          ${hasSavedPass ? '<span class="pass-dot" title="Contrasena en sesion">&#x25CF;</span>' : ''}
        </div>
      </div>
      <button class="console-row-edit" title="Editar">&#x270E;</button>
    `;

    row.addEventListener('click', e => {
      if (e.target.classList.contains('console-row-edit')) return;
      clearEdit();
      connectSaved(c);
    });

    row.querySelector('.console-row-edit').addEventListener('click', e => {
      e.stopPropagation();
      loadConsoleIntoForm(c);
    });

    container.appendChild(row);
  });
}

// Conectar desde consola guardada: si hay contraseña en sesión → directo, si no → pedir
function connectSaved(c) {
  const pass = sessionPass.get(c.id);
  if (pass) {
    startConnect({ ...c, password: pass });
  } else {
    showPassPrompt(c);
  }
}

// ── Password prompt ──────────────────────────────────────────
let passPromptConsole = null;

function showPassPrompt(c) {
  passPromptConsole = c;
  $('pass-icon').textContent = sysEmoji(c.name);
  $('pass-name').textContent = c.name || c.host;
  $('pass-host').textContent = c.username + '@' + c.host + ':' + c.port;
  $('pass-input').value = '';
  $('pass-error').classList.add('hidden');
  $('pass-sheet').classList.remove('hidden');
  setTimeout(() => $('pass-input').focus(), 80);
}

function hidePassPrompt() {
  $('pass-sheet').classList.add('hidden');
  passPromptConsole = null;
}

$('pass-cancel').addEventListener('click', hidePassPrompt);

$('pass-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('pass-ok').click();
});

$('pass-ok').addEventListener('click', async () => {
  if (!passPromptConsole) return;
  const pass = $('pass-input').value;
  const remember = $('pass-remember').checked;

  setPassLoading(true);
  const c = { ...passPromptConsole, password: pass };
  const res = await window.r36s.connect({
    host: c.host, port: c.port, username: c.username, password: pass,
  });
  setPassLoading(false);

  if (!res.ok) {
    const el = $('pass-error');
    el.textContent = 'Contrasena incorrecta o error de conexion: ' + (res.error || '');
    el.classList.remove('hidden');
    $('pass-input').select();
    return;
  }

  if (remember) sessionPass.set(c.id, pass);

  hidePassPrompt();
  state.currentConsole = c;
  saveLastId(c.id);
  renderSavedConsoles();
  enterApp(c);
});

function setPassLoading(v) {
  $('pass-ok').disabled = v;
  $('pass-ok-label').textContent = v ? 'Conectando...' : 'Conectar';
  v ? $('pass-spinner').classList.remove('hidden') : $('pass-spinner').classList.add('hidden');
}

function loadConsoleIntoForm(c) {
  editingConsoleId = c.id;
  $('ssh-name').value = c.name     || '';
  $('ssh-host').value = c.host     || '';
  $('ssh-port').value = c.port     || 22;
  $('ssh-user').value = c.username || 'ark';
  $('ssh-pass').value = sessionPass.get(c.id) || '';
  $('btn-connect-label').textContent = 'Guardar y conectar';
  renderSavedConsoles();
  $('connect-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  $('ssh-name').focus();
}

function clearEdit() {
  editingConsoleId = null;
  $('btn-connect-label').textContent = 'Conectar';
}

// Auto-reconexion: solo si la contrasena esta en sessionStorage
async function tryAutoReconnect() {
  const lastId = loadLastId();
  if (!lastId) return;
  const c = loadConsoles().find(x => x.id === lastId);
  if (!c) return;
  const pass = sessionPass.get(lastId);
  if (!pass) return;

  $('autoreconnect-name').textContent = c.name || c.host;
  $('autoreconnect').classList.remove('hidden');
  const res = await window.r36s.connect({
    host: c.host, port: c.port, username: c.username, password: pass,
  });
  $('autoreconnect').classList.add('hidden');
  if (res.ok) { state.currentConsole = { ...c, password: pass }; enterApp(c); }
}
$('btn-cancel-auto').addEventListener('click', () => $('autoreconnect').classList.add('hidden'));

$('btn-connect').addEventListener('click', () => {
  const host = $('ssh-host').value.trim();
  if (!host) { showConnectError('Introduce la IP de la consola'); return; }
  const c = {
    id:       editingConsoleId || 'c_' + Date.now(),
    name:     $('ssh-name').value.trim() || host,
    host,
    port:     parseInt($('ssh-port').value) || 22,
    username: $('ssh-user').value.trim() || 'ark',
    password: $('ssh-pass').value,
  };
  startConnect(c);
});

async function startConnect(c) {
  $('connect-error').classList.add('hidden');
  setConnectLoading(true);
  const res = await window.r36s.connect({
    host: c.host, port: c.port, username: c.username, password: c.password || '',
  });
  setConnectLoading(false);
  if (!res.ok) { showConnectError(res.error || 'Error de conexion'); return; }

  let list = loadConsoles();
  const idx = list.findIndex(x => x.id === c.id);
  const { password: pw, ...toSave } = c;
  if (idx >= 0) list[idx] = toSave;
  else {
    const dup = list.find(x => x.host === c.host && x.port === c.port && x.username === c.username);
    if (!dup) list.push(toSave);
    else c.id = dup.id;
  }
  saveConsoles(list);
  if (pw) sessionPass.set(c.id, pw);

  clearEdit();
  renderSavedConsoles();
  state.currentConsole = c;
  saveLastId(c.id);
  enterApp(c);
}

function enterApp(c) {
  $('connect-sheet').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('brand-host').textContent = c.name ? `${c.name} · ${c.host}` : c.host;
  setFooterStatus('Cargando sistemas…', 'loading');
  loadSystems(c.host);
}

function setConnectLoading(v) {
  $('btn-connect').disabled = v;
  $('btn-connect-label').textContent = v ? 'Conectando…' : 'Conectar';
  v ? $('connect-spinner').classList.remove('hidden') : $('connect-spinner').classList.add('hidden');
}
function showConnectError(msg) {
  const el = $('connect-error');
  el.textContent = '⚠ ' + msg;
  el.classList.remove('hidden');
}

$('btn-disconnect').addEventListener('click', async () => { await window.r36s.disconnect(); location.reload(); });

// ═══════════════════════════════════════════════════════════
// LOAD SYSTEMS + CACHE
// ═══════════════════════════════════════════════════════════
async function loadSystems(host) {
  // Intentar caché en disco primero
  const cached = await loadCache(host);
  if (cached) {
    state.allGames = cached.games;
    state.systems = cached.systems || [];
    populateSidebar(cached.systems, cached.games);
    updateBadges();
    hideLoading();
    renderGames();
    const ago = Math.round((Date.now() - cached.ts) / 60000);
    setFooterStatus(`${cached.systems.length} sistemas · ${cached.games.length} juegos (caché ${ago}m)`, 'ok');
    showToast('⚡ Cargado desde caché');
    return;
  }

  const res = await window.r36s.listSystems();
  if (!res.ok) {
    setFooterStatus('Error', 'offline');
    if (!handleSshError(res.error, 'Not connected')) showToast('❌ ' + res.error);
    return;
  }
  const systems = res.systems;
  if (!systems.length) { setFooterStatus('Sin sistemas', 'offline'); return; }

  showLoading('Leyendo gamelists…');
  state.allGames = [];
  const systemsWithGames = [];
  let hiddenOrphans = 0;

  for (const sys of systems) {
    $('loading-msg').textContent = `Leyendo ${sys.name}…`;
    const r = await window.r36s.readGamelist(sys.path);
    if (!r.ok && handleSshError(r.error, 'Not connected')) {
      hideLoading();
      return;
    }
    hiddenOrphans += r?.orphans || 0;
    if (!r.ok || !r.games.length) continue;

    const games = r.games.map(g => ({
      ...g,
      system:     sys.name,
      systemPath: sys.path,
      path:  normPath(g.path,  sys.path),
      image: normPath(g.image, sys.path),
      video: normPath(g.video, sys.path),
    }));
    state.allGames.push(...games);
    systemsWithGames.push({ ...sys, count: games.length });
  }

  // Guardar en disco (~/.config/r36s-manager/cache/<host>.json)
  await saveCache(host, systemsWithGames, state.allGames);

  state.systems = systemsWithGames;
  populateSidebar(systemsWithGames, state.allGames);
  updateBadges();
  hideLoading();
  renderGames();
  setFooterStatus(`${systemsWithGames.length} sistemas · ${state.allGames.length} juegos`, 'ok');
  if (hiddenOrphans > 0) {
    showToast(`🧹 Ocultados ${hiddenOrphans} ítems sin ROM`);
  }
}

function populateSidebar(systems, games) {
  state.systems = systems || [];
  const countMap = {};
  games.forEach(g => { countMap[g.system] = (countMap[g.system] || 0) + 1; });
  const sl = $('systems-list');
  sl.innerHTML = '';
  systems.forEach(sys => {
    const count = countMap[sys.name] || 0;
    if (count === 0) return;   // ocultar sistemas vacíos
    const btn = document.createElement('button');
    btn.className = 'nav-item';
    btn.dataset.system = sys.name;
    btn.innerHTML = `
      <span class="nav-icon">${sysEmoji(sys.name)}</span>
      <span class="nav-label">${esc(sys.name)}</span>
      <span class="nav-badge">${count}</span>
      <span class="sys-dots-wrap">
        <span class="sys-dots-btn" title="Opciones">···</span>
        <span class="sys-dots-menu hidden">
          <button class="sys-dots-item" data-action="reload">↻ Recargar</button>
          <button class="sys-dots-item" data-action="add-rom">＋ Añadir ROM</button>
        </span>
      </span>
    `;
    const dotsBtn  = btn.querySelector('.sys-dots-btn');
    const dotsMenu  = btn.querySelector('.sys-dots-menu');
    dotsBtn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      document.querySelectorAll('.sys-dots-menu').forEach(m => { if (m !== dotsMenu) m.classList.add('hidden'); });
      dotsMenu.classList.toggle('hidden');
    });
    btn.querySelector('[data-action="reload"]').addEventListener('click', async e => {
      e.preventDefault(); e.stopPropagation();
      dotsMenu.classList.add('hidden');
      await reloadSystemGamelist(sys.name, dotsBtn);
    });
    btn.querySelector('[data-action="add-rom"]').addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      dotsMenu.classList.add('hidden');
      // Pre-seleccionar el sistema en el modal
      openAddRomSheet(sys);
    });
    btn.addEventListener('click', () => selectView(sys.name));
    sl.appendChild(btn);
  });
}

function mapSystemGames(system, rawGames) {
  return rawGames.map(g => ({
    ...g,
    system:     system.name,
    systemPath: system.path,
    path:  normPath(g.path,  system.path),
    image: normPath(g.image, system.path),
    video: normPath(g.video, system.path),
  }));
}

async function reloadSystemGamelist(systemName, refreshBtn, skipConfirm = false) {
  if (!state.currentConsole) return;
  if (!skipConfirm) {
    const confirmed = window.confirm(`¿Recargar gamelist.xml de ${systemName}?`);
    if (!confirmed) return;
  }

  const system = state.systems.find(s => s.name === systemName);
  if (!system?.path) {
    showToast(`⚠ No se encontró la ruta para ${systemName}`);
    return;
  }

  if (refreshBtn) {
    refreshBtn.classList.add('loading');
    refreshBtn.textContent = '…';
  }
  setFooterStatus(`Recargando ${systemName}…`, 'loading');

  try {
    const r = await window.r36s.readGamelist(system.path);
    if (!r.ok && handleSshError(r.error, 'Not connected')) return;
    if (!r.ok) {
      showToast(`❌ No se pudo leer gamelist.xml de ${systemName}: ${r.error || 'error desconocido'}`);
      return;
    }

    const newGames = (r.ok && Array.isArray(r.games) && r.games.length)
      ? mapSystemGames(system, r.games)
      : [];

    // Evitar que un sistema desaparezca por una recarga vacía inesperada.
    // Si no llega ningún juego, mantenemos el estado anterior.
    if (!newGames.length) {
      showToast(`⚠ ${systemName} devolvió 0 juegos; se mantiene la lista anterior`);
      return;
    }

    // Reemplazar solo los juegos del sistema recargado
    state.allGames = state.allGames.filter(g => g.system !== systemName);
    state.allGames.push(...newGames);

    // Recalcular conteos por sistema y persistir caché
    const countMap = {};
    state.allGames.forEach(g => { countMap[g.system] = (countMap[g.system] || 0) + 1; });
    state.systems = state.systems.map(s => ({ ...s, count: countMap[s.name] || 0 }));
    const systemsWithGames = state.systems.filter(s => (s.count || 0) > 0);

    await saveCache(state.currentConsole.host, systemsWithGames, state.allGames);

    populateSidebar(state.systems, state.allGames);
    updateBadges();
    renderGames();

    const totalSystems = systemsWithGames.length;
    setFooterStatus(`${totalSystems} sistemas · ${state.allGames.length} juegos`, 'ok');
    const hidden = r?.orphans || 0;
    showToast(hidden > 0
      ? `🔄 ${systemName} recargado · ${hidden} sin ROM ocultados`
      : `🔄 ${systemName} recargado`);
  } catch (e) {
    setFooterStatus('Error', 'offline');
    const msg = e.message || String(e);
    if (!handleSshError(msg, 'Not connected')) {
      showToast(`❌ Error recargando ${systemName}: ${msg}`);
    }
  } finally {
    if (refreshBtn) {
      refreshBtn.classList.remove('loading');
      refreshBtn.textContent = '↻';
    }
  }
}

function updateBadges() {
  $('badge-all').textContent = state.allGames.length;
  $('badge-fav').textContent = [...state.favorites].filter(p => state.allGames.some(g => g.path === p)).length;
}

function normPath(p, base) {
  if (!p) return '';
  if (p.startsWith('/')) return p;
  return base + '/' + p.replace(/^\.\//, '');
}

// ── Refresh cache (toolbar ↻) ─────────────────────────────
$('btn-refresh-cache').addEventListener('click', () => {
  if (!state.currentConsole) return;
  const confirmReload = window.confirm(
    'Se recargarán todos los sistemas desde la consola. ¿Deseas continuar?'
  );
  if (!confirmReload) return;

  invalidateCache(state.currentConsole.host);
  state.allGames = [];
  $('systems-list').innerHTML = '<div class="sidebar-loading"><span class="spinner-sm"></span> Cargando…</div>';
  showLoading('Recargando desde consola…');
  loadSystems(state.currentConsole.host);
  showToast('🔄 Recargando…');
});

// Cerrar menús del sidebar al clicar fuera
document.addEventListener('click', () =>
  document.querySelectorAll('.sys-dots-menu').forEach(m => m.classList.add('hidden'))
);

// ═══════════════════════════════════════════════════════════
// ADD ROM SHEET
// ═══════════════════════════════════════════════════════════
// pendingRoms: [{ file: File, meta: {name,desc,developer,publisher,year,genre,rating}, localImagePath: string|null }]
let pendingRoms = [];
let romMetaIndex = -1; // índice del archivo editándose en el meta editor

function openAddRomSheet(preselectedSys) {
  pendingRoms = [];
  renderPendingList();
  $('add-rom-upload-btn').disabled = true;
  $('add-rom-error').classList.add('hidden');
  $('add-rom-result').classList.add('hidden');
  $('add-rom-result-cards').innerHTML = '';
  $('add-rom-status').classList.add('hidden');

  // Poblar select de sistemas
  const sel = $('add-rom-system');
  sel.innerHTML = '';
  state.systems.forEach(sys => {
    const opt = document.createElement('option');
    opt.value = sys.path;
    opt.textContent = `${sysEmoji(sys.name)} ${sys.name}`;
    if (preselectedSys && sys.path === preselectedSys.path) opt.selected = true;
    sel.appendChild(opt);
  });

  $('add-rom-sheet').classList.remove('hidden');
}

$('add-rom-close').addEventListener('click', () => $('add-rom-sheet').classList.add('hidden'));
$('add-rom-cancel').addEventListener('click', () => $('add-rom-sheet').classList.add('hidden'));

// Drag & drop
const dropzone = $('rom-dropzone');
dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  addFiles([...e.dataTransfer.files]);
});
dropzone.addEventListener('click', () => $('rom-file-input').click());
$('rom-pick-btn').addEventListener('click', e => { e.stopPropagation(); $('rom-file-input').click(); });
$('rom-file-input').addEventListener('change', e => {
  addFiles([...e.target.files]);
  e.target.value = '';
});

function addFiles(files) {
  for (const f of files) {
    if (pendingRoms.some(r => r.file.name === f.name)) continue; // no duplicar
    pendingRoms.push({ file: f, meta: { name: f.name.replace(/\.[^.]+$/, '') }, localImagePath: null });
  }
  renderPendingList();
  $('add-rom-upload-btn').disabled = pendingRoms.length === 0;
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function renderPendingList() {
  const list = $('rom-pending-list');
  if (!pendingRoms.length) { list.classList.add('hidden'); return; }
  list.classList.remove('hidden');
  list.innerHTML = pendingRoms.map((r, i) => `
    <div class="rom-pending-item" id="pending-item-${i}">
      <span class="rom-pending-name" title="${esc(r.file.name)}">${esc(r.meta.name || r.file.name)}</span>
      <span class="rom-pending-size">${fmtSize(r.file.size)}</span>
      <button class="rom-pending-edit" data-i="${i}" title="Editar información">✏️</button>
      <button class="rom-pending-remove" data-i="${i}" title="Quitar">✕</button>
    </div>
  `).join('');

  list.querySelectorAll('.rom-pending-edit').forEach(btn =>
    btn.addEventListener('click', () => openRomMeta(+btn.dataset.i)));
  list.querySelectorAll('.rom-pending-remove').forEach(btn =>
    btn.addEventListener('click', () => {
      pendingRoms.splice(+btn.dataset.i, 1);
      renderPendingList();
      $('add-rom-upload-btn').disabled = pendingRoms.length === 0;
    }));
}

// ── Subir ROMs ───────────────────────────────────────────────
$('add-rom-upload-btn').addEventListener('click', async () => {
  if (!pendingRoms.length) return;
  const systemPath = $('add-rom-system').value;
  if (!systemPath) { $('add-rom-error').textContent = 'Selecciona un sistema.'; $('add-rom-error').classList.remove('hidden'); return; }

  $('add-rom-upload-btn').disabled = true;
  $('add-rom-spinner').classList.remove('hidden');
  $('add-rom-error').classList.add('hidden');
  $('add-rom-result').classList.add('hidden');
  $('add-rom-result-cards').innerHTML = '';
  // Resetear barra de progreso
  $('add-rom-progress-bar').style.width = '0%';
  $('add-rom-progress-pct').textContent = '0%';
  $('add-rom-progress-detail').textContent = '';
  $('add-rom-status').classList.remove('hidden');

  const systemName = state.systems.find(s => s.path === systemPath)?.name || '';
  let ok = 0, fail = 0;
  const uploadedRoms = []; // { meta, localImagePath, ok }

  for (let i = 0; i < pendingRoms.length; i++) {
    const r = pendingRoms[i];
    // El texto de estado lo actualiza el listener onRomUploadProgress en tiempo real

    // Guardar archivo en temp local (Electron necesita path en disco para putFile)
    const localPath = await window.r36s.saveTempFile({ name: r.file.name, buffer: await r.file.arrayBuffer() });
    if (!localPath) { fail++; uploadedRoms.push({ ...r, uploadOk: false }); continue; }

    const res = await window.r36s.uploadRom({
      localPath,
      systemPath,
      meta: r.meta,
      localImage: r.localImagePath || null,
    });

    const statusEl = document.getElementById(`pending-item-${i}`)?.querySelector('.rom-pending-status');
    if (statusEl) { statusEl.textContent = res.ok ? '✓' : '✗'; statusEl.className = 'rom-pending-status ' + (res.ok ? 'ok' : 'err'); }
    if (res.ok) ok++; else fail++;
    uploadedRoms.push({ ...r, uploadOk: res.ok });
  }

  $('add-rom-spinner').classList.add('hidden');
  $('add-rom-status').classList.add('hidden');

  if (ok) {
    // Actualizar caché local y gamelist del sistema afectado
    if (systemName) {
      await reloadSystemGamelist(systemName, null, true);
    } else {
      invalidateCache(state.currentConsole.host);
    }

    // Mostrar panel de resultado con portada e info
    renderAddRomResult(uploadedRoms.filter(r => r.uploadOk), systemName, ok);
  }
  if (fail) {
    $('add-rom-error').textContent = `⚠️ ${fail} archivo${fail !== 1 ? 's' : ''} fallaron.`;
    $('add-rom-error').classList.remove('hidden');
  }

  $('add-rom-upload-btn').disabled = false;
  if (!fail) setTimeout(() => $('add-rom-sheet').classList.add('hidden'), 4000);
});

function renderAddRomResult(roms, systemName, count) {
  const titleEl = $('add-rom-result-title');
  titleEl.textContent = `${count} ROM${count !== 1 ? 's' : ''} subida${count !== 1 ? 's' : ''} correctamente`;

  const cards = $('add-rom-result-cards');
  cards.innerHTML = roms.map(r => {
    const meta = r.meta || {};
    const coverSrc = r.localImagePath ? `file://${r.localImagePath.replace(/\\/g, '/')}` : '';
    const coverHtml = coverSrc
      ? `<img src="${esc(coverSrc)}" alt="portada" onerror="this.parentElement.innerHTML='🎮'" />`
      : '🎮';

    const tags = [];
    if (systemName) tags.push(systemName);
    if (meta.year) tags.push(meta.year);
    if (meta.genre) tags.push(meta.genre);
    if (meta.developer) tags.push(meta.developer);
    if (meta.publisher) tags.push(meta.publisher);
    if (meta.rating) tags.push(`★ ${parseFloat(meta.rating * 10).toFixed(0)}/10`);

    return `
      <div class="add-rom-result-card">
        <div class="add-rom-result-cover">${coverHtml}</div>
        <div class="add-rom-result-info">
          <div class="add-rom-result-name">${esc(meta.name || r.file?.name || '')}</div>
          ${systemName ? `<div class="add-rom-result-system">${esc(systemName)}</div>` : ''}
          ${meta.desc ? `<div class="add-rom-result-desc">${esc(meta.desc)}</div>` : ''}
          ${tags.length ? `<div class="add-rom-result-tags">${tags.map(t => `<span class="add-rom-result-tag">${esc(t)}</span>`).join('')}</div>` : ''}
        </div>
      </div>
    `;
  }).join('');

  $('add-rom-result').classList.remove('hidden');
}

// ═══════════════════════════════════════════════════════════
// ROM META EDITOR
// ═══════════════════════════════════════════════════════════
let romMetaScrapeResult = null;

function openRomMeta(index) {
  romMetaIndex = index;
  const r = pendingRoms[index];
  $('rom-meta-filename').textContent = r.file.name;
  $('rom-meta-name').value       = r.meta.name       || '';
  $('rom-meta-desc').value       = r.meta.desc        || '';
  $('rom-meta-developer').value  = r.meta.developer   || '';
  $('rom-meta-publisher').value  = r.meta.publisher   || '';
  $('rom-meta-year').value       = r.meta.year        || '';
  $('rom-meta-genre').value      = r.meta.genre       || '';
  $('rom-meta-rating').value     = r.meta.rating      || '';
  romMetaScrapeResult            = null;

  // Portada
  if (r.localImagePath) {
    $('rom-meta-img').src = 'file://' + r.localImagePath;
    $('rom-meta-img').classList.remove('hidden');
    $('rom-meta-no-img').classList.add('hidden');
  } else {
    $('rom-meta-img').classList.add('hidden');
    $('rom-meta-no-img').classList.remove('hidden');
  }

  $('rom-meta-scrape-grid').classList.add('hidden');
  $('rom-meta-scrape-grid').innerHTML = '';
  $('rom-meta-scrape-status').classList.add('hidden');

  $('rom-meta-sheet').classList.remove('hidden');
}

$('rom-meta-close').addEventListener('click', () => $('rom-meta-sheet').classList.add('hidden'));
$('rom-meta-skip').addEventListener('click', () => $('rom-meta-sheet').classList.add('hidden'));

// Subir imagen local desde disco
$('rom-meta-upload-img-btn').addEventListener('click', () => $('rom-meta-img-input').click());
$('rom-meta-img-input').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file || romMetaIndex < 0) return;
  e.target.value = '';

  // Guardar en temp y usar como localImagePath
  const localPath = await window.r36s.saveTempFile({ name: file.name, buffer: await file.arrayBuffer() });
  if (!localPath) return;

  pendingRoms[romMetaIndex].localImagePath = localPath;
  $('rom-meta-img').src = 'file://' + localPath.replace(/\\/g, '/');
  $('rom-meta-img').classList.remove('hidden');
  $('rom-meta-no-img').classList.add('hidden');

  // Limpiar grid de Google si había uno visible
  $('rom-meta-scrape-grid').classList.add('hidden');
  $('rom-meta-scrape-grid').innerHTML = '';
});

$('rom-meta-ok').addEventListener('click', () => {
  if (romMetaIndex < 0) return;
  pendingRoms[romMetaIndex].meta = {
    name:      $('rom-meta-name').value.trim(),
    desc:      $('rom-meta-desc').value.trim(),
    developer: $('rom-meta-developer').value.trim(),
    publisher: $('rom-meta-publisher').value.trim(),
    year:      $('rom-meta-year').value.trim(),
    genre:     $('rom-meta-genre').value.trim(),
    rating:    $('rom-meta-rating').value.trim(),
  };
  renderPendingList();
  $('rom-meta-sheet').classList.add('hidden');
});

// Buscar portada desde el meta editor
$('rom-meta-scrape-btn').addEventListener('click', async () => {
  const name = $('rom-meta-name').value.trim() || (pendingRoms[romMetaIndex]?.file?.name || '');
  const sys = $('add-rom-system').options[$('add-rom-system').selectedIndex]?.text || '';
  $('rom-meta-scrape-status').classList.remove('hidden');
  $('rom-meta-scrape-msg').textContent = 'Buscando en Google Images…';
  $('rom-meta-scrape-grid').classList.add('hidden');
  $('rom-meta-scrape-grid').innerHTML = '';

  // Buscar portadas e info del juego en paralelo
  const [res, infoRes] = await Promise.all([
    window.r36s.scrapeFetchGoogle({ game: { name }, systemFolder: sys }),
    window.r36s.scrapeFetchGameInfo({ game: { name }, systemFolder: sys }),
  ]);
  $('rom-meta-scrape-status').classList.add('hidden');

  // Rellenar campos de metadata vacíos con la info obtenida de Google
  if (infoRes?.ok && infoRes.meta) {
    const m = infoRes.meta;
    if (m.desc && !$('rom-meta-desc').value.trim())           $('rom-meta-desc').value = m.desc;
    if (m.year && !$('rom-meta-year').value.trim())           $('rom-meta-year').value = m.year;
    if (m.genre && !$('rom-meta-genre').value.trim())         $('rom-meta-genre').value = m.genre;
    if (m.developer && !$('rom-meta-developer').value.trim()) $('rom-meta-developer').value = m.developer;
  }

  if (!res.ok || !res.options?.length) {
    $('rom-meta-scrape-status').classList.remove('hidden');
    $('rom-meta-scrape-msg').textContent = '❌ ' + (res.error || 'Sin resultados de imagen');
    return;
  }

  romMetaScrapeResult = res.options;
  $('rom-meta-scrape-grid').classList.remove('hidden');
  $('rom-meta-scrape-grid').innerHTML = res.options.map((opt, i) => `
    <div class="scrape-opt ${i === 0 ? 'selected' : ''}" data-idx="${i}" style="cursor:pointer;border-radius:8px;overflow:hidden;border:2px solid ${i === 0 ? 'var(--accent)' : 'transparent'}">
      <img src="file://${esc(opt.localImage)}" style="width:100%;height:80px;object-fit:cover" />
    </div>
  `).join('');

  $('rom-meta-scrape-grid').querySelectorAll('.scrape-opt').forEach(el => {
    el.addEventListener('click', () => {
      $('rom-meta-scrape-grid').querySelectorAll('.scrape-opt').forEach(e => { e.style.border = '2px solid transparent'; e.classList.remove('selected'); });
      el.style.border = '2px solid var(--accent)'; el.classList.add('selected');
      const idx = +el.dataset.idx;
      const localImg = romMetaScrapeResult[idx].localImage;
      pendingRoms[romMetaIndex].localImagePath = localImg;
      $('rom-meta-img').src = 'file://' + localImg;
      $('rom-meta-img').classList.remove('hidden');
      $('rom-meta-no-img').classList.add('hidden');
    });
  });

  // Seleccionar la primera por defecto
  if (res.options.length) {
    pendingRoms[romMetaIndex].localImagePath = res.options[0].localImage;
    $('rom-meta-img').src = 'file://' + res.options[0].localImage;
    $('rom-meta-img').classList.remove('hidden');
    $('rom-meta-no-img').classList.add('hidden');
  }
});

// MEDIA — caché en disco + concurrencia limitada para SSH
//
// Flujo:
//  1. Si remotePath está en memCache  → URL instantánea (sin IPC)
//  2. Si el archivo ya existe en disco → main.js devuelve localPath
//     inmediatamente (cached:true), sin SSH, sin slot de concurrencia
//  3. Si hay que descargarlo via SSH  → se limita a CONCURRENCY=1
//     (una descarga a la vez) con cola + deduplicación
//  4. IntersectionObserver: solo encola cuando el elemento es visible;
//     cancela si sale del viewport antes de descargar
// ═══════════════════════════════════════════════════════════
const memCache    = new Map();    // remotePath → file:// URL (RAM)
const mediaInFlight = new Map();  // remotePath → Promise<url|null>
const mediaQueue = [];
const MEDIA_CONCURRENCY = 1;
let mediaActive = 0;

const DEFAULT_SVG = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 80'%3E%3Crect x='10' y='18' width='60' height='44' rx='5' fill='%23555'/%3E%3Crect x='22' y='28' width='36' height='20' rx='3' fill='%23333'/%3E%3Crect x='28' y='54' width='8' height='8' rx='2' fill='%23444'/%3E%3Crect x='44' y='54' width='8' height='8' rx='2' fill='%23444'/%3E%3C/svg%3E`;

// Pide el archivo a main.js:
//  - Si ya está en disco (cached:true)  → resolve inmediato, sin slot SSH
//  - Si hay que descargarlo             → entra en la cola de concurrencia
function enqueueMedia(remotePath) {
  if (memCache.has(remotePath))
    return { promise: Promise.resolve(memCache.get(remotePath)), cancel: () => {} };

  if (mediaInFlight.has(remotePath)) {
    let cancelled = false;
    return {
      promise: mediaInFlight.get(remotePath).then(url => cancelled ? null : url),
      cancel() { cancelled = true; },
    };
  }

  const taskPromise = new Promise(resolve => {
    mediaQueue.push(async () => {
      try {
        const r = await window.r36s.fetchMedia(remotePath);
        if (!r.ok) {
          handleSshError(r.error, 'Not connected');
          resolve(null);
          return;
        }
        const url = 'file://' + r.localPath.replace(/\\/g, '/');
        memCache.set(remotePath, url);
        resolve(url);
      } catch {
        handleSshError('Not connected', 'Not connected');
        resolve(null);
      }
    });
    pumpMediaQueue();
  });

  mediaInFlight.set(remotePath, taskPromise);
  taskPromise.finally(() => {
    mediaInFlight.delete(remotePath);
  });

  let cancelled = false;
  return {
    promise: taskPromise.then(url => cancelled ? null : url),
    cancel() { cancelled = true; },
  };
}

function pumpMediaQueue() {
  while (mediaActive < MEDIA_CONCURRENCY && mediaQueue.length) {
    const job = mediaQueue.shift();
    mediaActive += 1;
    Promise.resolve()
      .then(job)
      .finally(() => {
        mediaActive -= 1;
        pumpMediaQueue();
      });
  }
}

// ── Lazy load de tarjeta: solo descarga cuando es visible ────
// ── Observer global compartido ───────────────────────────────
const imgObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    imgObserver.unobserve(entry.target);
    triggerLoad(entry.target);
  }
}, { rootMargin: '300px 0px', threshold: 0 });

function triggerLoad(wrapEl) {
  const remotePath = wrapEl.dataset.remote;
  if (wrapEl.dataset.loading === '1' || wrapEl.dataset.loaded === '1') return;
  if (!remotePath) return;
  const imgEl = wrapEl.querySelector('.card-thumb');
  if (!imgEl) return;
  wrapEl.dataset.loading = '1';
  if (memCache.has(remotePath)) {
    delete wrapEl.dataset.loading;
    wrapEl.dataset.loaded = '1';
    applyImg(wrapEl, imgEl, memCache.get(remotePath), remotePath);
    return;
  }
  enqueueMedia(remotePath).promise.then(url => {
    delete wrapEl.dataset.loading;
    if (!wrapEl.isConnected) return;
    if (!url) { setImgError(wrapEl, imgEl, remotePath); return; }
    wrapEl.dataset.loaded = '1';
    applyImg(wrapEl, imgEl, url, remotePath);
  });
}

function lazyLoadImg(wrapEl, remotePath) {
  if (!wrapEl || !remotePath) {
    if (wrapEl) wrapEl.classList.add('no-image');
    return;
  }
  const imgEl = wrapEl.querySelector('.card-thumb');
  if (!imgEl) return;

  // Caché en memoria → instantáneo
  if (memCache.has(remotePath)) {
    applyImg(wrapEl, imgEl, memCache.get(remotePath), remotePath);
    return;
  }

  wrapEl.dataset.remote = remotePath;

  // Verificar si ya es visible AHORA (elementos del fold inicial)
  // getBoundingClientRect es síncrono y preciso tras el layout
  const rect = wrapEl.getBoundingClientRect();
  const inView = rect.top < window.innerHeight + 300 && rect.bottom > -300;
  if (inView) {
    // Ya visible: cargar directo sin esperar al observer
    triggerLoad(wrapEl);
  } else {
    // Fuera del viewport: observer se encarga cuando haga scroll
    imgObserver.observe(wrapEl);
  }
}

function applyImg(wrapEl, imgEl, url, remotePath) {
  wrapEl.classList.remove('error');
  imgEl.onload  = () => {
    wrapEl.classList.remove('error');
    wrapEl.classList.add('loaded');
  };
  imgEl.onerror = () => setImgError(wrapEl, imgEl, remotePath);
  imgEl.src = url;
}

function setImgError(wrapEl, imgEl, remotePath) {
  imgEl.src = DEFAULT_SVG;
  imgEl.style.opacity = '.18';
  imgEl.style.padding = '20%';
  imgEl.onload = () => {};
  wrapEl.classList.add('error');
  delete wrapEl.dataset.loading;
  delete wrapEl.dataset.loaded;
  const btn = wrapEl.querySelector('.card-retry-btn');
  if (btn) btn.onclick = e => {
    e.stopPropagation();
    console.log('[media-retry] buscando imagen:', remotePath);
    memCache.delete(remotePath);
    wrapEl.classList.remove('error', 'loaded');
    delete wrapEl.dataset.loading;
    delete wrapEl.dataset.loaded;
    imgEl.onload = null;
    imgEl.onerror = null;
    imgEl.src = '';
    imgEl.style.opacity = '';
    imgEl.style.padding = '';
    lazyLoadImg(wrapEl, remotePath);
  };
}

// ── Detalle: video e imagen (sin observer, se piden al abrir) ─
function loadVideoEl(videoEl, mediaEl, remotePath) {
  if (!remotePath || !videoEl) return;
  enqueueMedia(remotePath).promise.then(url => {
    if (!url || !videoEl.isConnected) { mediaEl?.classList.add('error'); return; }
    videoEl.src = url; videoEl.load(); videoEl.play().catch(() => {});
    mediaEl?.classList.add('loaded');
  });
}

function loadDetailImg(imgEl, mediaEl, remotePath) {
  if (!remotePath) { mediaEl?.classList.add('error'); return; }
  mediaEl?.classList.remove('error');
  enqueueMedia(remotePath).promise.then(url => {
    if (!imgEl.isConnected) return;
    if (!url) { mediaEl?.classList.add('error'); return; }
    imgEl.onload  = () => {
      mediaEl?.classList.remove('error');
      mediaEl?.classList.add('loaded');
      $('detail-retry-btn').classList.add('hidden');
    };
    imgEl.onerror = () => mediaEl?.classList.add('error');
    imgEl.src = url;
  });
}

// ═══════════════════════════════════════════════════════════
// RENDER GAMES
// ═══════════════════════════════════════════════════════════
const PAGE_SIZE = 50;

function filteredGames() {
  let list = state.allGames;
  if (state.currentView === 'favorites') {
    list = list.filter(g => state.favorites.has(g.path));
  } else if (state.currentView === 'search') {
    list = state.searchResults;
  } else if (state.currentView !== 'all' && state.currentView !== 'collections') {
    list = list.filter(g => g.system === state.currentView);
  }
  return list;
}

function renderGames() {
  if (state.currentView === 'collections') {
    $('games-container').classList.add('hidden');
    $('collections-view').classList.remove('hidden');
    renderCollectionsView();
    updateToolbar('Colecciones', '');
    renderPaginator(0, 0, 0);
    return;
  }
  $('collections-view').classList.add('hidden');
  $('games-container').classList.remove('hidden');

  const list = filteredGames();
  $('games-grid').innerHTML = '';

  if (!list.length) {
    $('empty-state').classList.remove('hidden');
    $('toolbar-count').textContent = '';
    renderPaginator(0, 0, 0);
    return;
  }
  $('empty-state').classList.add('hidden');

  const total = list.length;
  const page  = state.page;
  const pages = Math.ceil(total / PAGE_SIZE);
  const start = page * PAGE_SIZE;
  const slice = list.slice(start, start + PAGE_SIZE);

  updateToolbar(viewLabel(), `${total} juego${total !== 1 ? 's' : ''}`);

  // 1. Construir tarjetas SIN imagen aún (solo estructura HTML)
  // 2. Insertar todo en el DOM de una vez (un solo reflow)
  // 3. En el siguiente frame, cuando el browser ya tiene el layout,
  //    lazyLoadImg usa getBoundingClientRect para decidir si es visible
  const cards = slice.map((g, i) => buildCard(g, i));
  const fragment = document.createDocumentFragment();
  cards.forEach(c => fragment.appendChild(c));
  $('games-grid').appendChild(fragment);

  // Scroll arriba al cambiar página
  $('games-container').scrollTop = 0;

  // Después del paint, inicializar lazy-load de las tarjetas ya visibles
  requestAnimationFrame(() => {
    $('games-grid').querySelectorAll('.card-thumb-wrap[data-remote]').forEach(w => {
      // Re-evaluar ahora que el layout está calculado
      const rect = w.getBoundingClientRect();
      const inView = rect.top < window.innerHeight + 300 && rect.bottom > -300;
      if (inView) {
        imgObserver.unobserve(w);
        triggerLoad(w);
      }
    });
  });

  renderPaginator(page, pages, total);
}

function renderPaginator(page, pages, total) {
  const el = $('paginator');
  if (!el) return;
  if (pages <= 1) {
    el.classList.add('hidden');
    document.body.classList.remove('has-paginator');
    return;
  }
  el.classList.remove('hidden');
  document.body.classList.add('has-paginator');

  const start = page * PAGE_SIZE + 1;
  const end   = Math.min((page + 1) * PAGE_SIZE, total);

  el.innerHTML = `
    <button class="pg-btn" id="pg-first" ${page === 0 ? 'disabled' : ''} title="Primera">«</button>
    <button class="pg-btn" id="pg-prev"  ${page === 0 ? 'disabled' : ''} title="Anterior">‹</button>
    <span class="pg-info">${start}–${end} de ${total}</span>
    <button class="pg-btn" id="pg-next"  ${page >= pages - 1 ? 'disabled' : ''} title="Siguiente">›</button>
    <button class="pg-btn" id="pg-last"  ${page >= pages - 1 ? 'disabled' : ''} title="Última">»</button>
  `;

  el.querySelector('#pg-first').onclick = () => goPage(0);
  el.querySelector('#pg-prev').onclick  = () => goPage(page - 1);
  el.querySelector('#pg-next').onclick  = () => goPage(page + 1);
  el.querySelector('#pg-last').onclick  = () => goPage(pages - 1);
}

function goPage(n) {
  state.page = n;
  renderGames();
}

function buildCard(game, i) {
  const card = document.createElement('div');
  card.className = 'game-card' + (state.favorites.has(game.path) ? ' is-fav' : '');
  card.style.animationDelay = `${Math.min(i, 40) * 11}ms`;

  // Siempre usamos .card-thumb-wrap para el spinner de carga
  const mediaHtml = game.image
    ? `<div class="card-thumb-wrap">
         <img class="card-thumb" src="" alt="${esc(game.name)}" />
         <div class="card-thumb-default">
           <img src="${DEFAULT_SVG}" width="48" height="48" alt="" />
           <button class="card-retry-btn">↻</button>
         </div>
       </div>`
    : `<div class="card-thumb-wrap no-image">
         <div class="card-thumb-default">
           <span style="font-size:32px;opacity:.35">${sysEmoji(game.system)}</span>
         </div>
       </div>`;

  card.innerHTML = `${mediaHtml}
    <div class="card-fav-dot"></div>
    <div class="card-info">
      <div class="card-name">${esc(game.name || game.path)}</div>
      <div class="card-sys">${esc(game.system)}</div>
    </div>`;

  if (game.image) {
    // Solo marcar data-remote y registrar en observer.
    // El rAF en renderGames dispara triggerLoad para los visibles;
    // el observer se encarga del resto al hacer scroll.
    const wrap = card.querySelector('.card-thumb-wrap');
    wrap.dataset.remote = game.image;
    imgObserver.observe(wrap);
  }
  card.addEventListener('click', () => openDetail(game));
  return card;
}

// ═══════════════════════════════════════════════════════════
// GLOBAL SEARCH
// Enter → crea sección "Resultados" en sidebar y navega a ella
// ═══════════════════════════════════════════════════════════
const globalSearch = $('global-search');
const gsClear      = $('gs-clear');

// Estado de búsqueda actual
state.searchResults = [];   // juegos encontrados
state.searchQuery   = '';   // término activo

globalSearch.addEventListener('input', () => {
  gsClear.classList.toggle('hidden', !globalSearch.value.trim());
});

globalSearch.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const q = globalSearch.value.trim();
    if (q) commitSearch(q);
  }
  if (e.key === 'Escape') {
    globalSearch.value = '';
    gsClear.classList.add('hidden');
    globalSearch.blur();
  }
});

gsClear.addEventListener('click', () => {
  globalSearch.value = '';
  gsClear.classList.add('hidden');
  clearSearchSection();
  globalSearch.focus();
});

// Ejecuta la búsqueda y crea la sección en el sidebar
function commitSearch(q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits  = state.allGames.filter(g =>
    words.every(w => (g.name || '').toLowerCase().includes(w))
  );

  state.searchResults = hits;
  state.searchQuery   = q;

  // Actualizar sidebar
  const section = $('search-section');
  section.classList.remove('hidden');
  $('nav-search-label').textContent = `"${q}"`;
  $('badge-search').textContent = hits.length;

  // Navegar automáticamente a los resultados
  selectView('search');
  globalSearch.blur();
}

function clearSearchSection() {
  state.searchResults = [];
  state.searchQuery   = '';
  $('search-section').classList.add('hidden');
  if (state.currentView === 'search') selectView('all');
}

$('search-section-clear').addEventListener('click', () => {
  globalSearch.value = '';
  gsClear.classList.add('hidden');
  clearSearchSection();
});

// ═══════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════
function selectView(view) {
  state.currentView = view;
  state.page = 0;
  document.querySelectorAll('.nav-item').forEach(el => {
    el.classList.toggle('active',
      el.dataset.view === view || el.dataset.system === view);
  });
  renderGames();
}

$('nav-all').addEventListener('click',         () => selectView('all'));
$('nav-favorites').addEventListener('click',   () => selectView('favorites'));
$('nav-collections').addEventListener('click', () => selectView('collections'));
$('nav-search').addEventListener('click',      () => selectView('search'));
$('btn-analyze').addEventListener('click',     () => { runSagaAnalysis(); selectView('collections'); });

$('btn-restart-es').addEventListener('click', async () => {
  // Mini confirmación inline en el botón
  const btn = $('btn-restart-es');
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.textContent = '¿Reiniciar ES?';
    btn.classList.add('btn-confirm');
    setTimeout(() => {
      btn.dataset.confirm = '';
      btn.textContent = '⟳ ES';
      btn.classList.remove('btn-confirm');
    }, 3000);
    return;
  }
  // Segunda pulsación → confirmar
  btn.dataset.confirm = '';
  btn.textContent = '⟳ ES';
  btn.classList.remove('btn-confirm');
  btn.disabled = true;

  showToast('⟳ Reiniciando EmulationStation…', 4000);
  const res = await window.r36s.restartES();
  btn.disabled = false;
  if (!res.ok && handleSshError(res.error, 'Not connected')) return;

  if (res.ok) showToast('✓ EmulationStation reiniciado', 3000);
  else        showToast(`❌ ${res.error}`, 4000);
});

function viewLabel() {
  if (state.currentView === 'all')         return 'Todos los juegos';
  if (state.currentView === 'favorites')   return 'Favoritos';
  if (state.currentView === 'collections') return 'Colecciones';
  if (state.currentView === 'search')      return `Resultados: "${state.searchQuery}"`;
  return state.currentView;
}

$('view-toggle').addEventListener('click', e => {
  const btn = e.target.closest('.seg-btn');
  if (!btn) return;
  state.layout = btn.dataset.layout;
  document.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
  $('games-container').classList.toggle('layout-list', state.layout === 'list');
});

// ═══════════════════════════════════════════════════════════
// DETAIL PANEL
// ═══════════════════════════════════════════════════════════
let detailCurrentGame = null;

function openDetail(game) {
  detailCurrentGame = game;
  $('btn-restart-es').classList.add('hidden');
  const mediaEl = $('detail-media');
  const vid     = $('detail-video');
  const img     = $('detail-img');
  const playBtn = $('detail-play-btn');

  // Reset completo
  vid.pause?.(); vid.src = ''; vid.classList.add('hidden');
  img.src = ''; img.style.display = ''; img.style.opacity = '';
  mediaEl.className = 'detail-media';
  $('detail-no-media').classList.add('hidden');
  $('detail-retry-btn').classList.add('hidden');
  $('detail-video-btn').classList.add('hidden');

  // Info
  $('detail-system').textContent = game.system || '—';
  $('detail-title').textContent  = game.name || game.path || '—';

  const meta = [game.year, game.developer, game.publisher].filter(Boolean);
  $('detail-meta').innerHTML = meta.map(m => `<span class="detail-meta-item">${esc(m)}</span>`).join('');

  const r = parseFloat(game.rating || 0);
  $('detail-rating').textContent = r ? '★'.repeat(Math.round(r * 5)) + '☆'.repeat(5 - Math.round(r * 5)) : '';

  if (game.path) {
    playBtn.classList.remove('hidden');
    playBtn.disabled = false;
    playBtn.textContent = '▶ Jugar';
    playBtn.onclick = () => launchGameFromDetail(game);
  } else {
    playBtn.classList.add('hidden');
    playBtn.onclick = null;
  }

  $('detail-desc').textContent = game.desc || 'Sin descripción disponible.';

  const fields = [
    ['Género',    game.genre],
    ['Jugadores', game.players],
    ['Año',       (game.releasedate || '').substring(0, 4) || game.year],
    ['Rating',    game.rating ? (parseFloat(game.rating) * 10).toFixed(0) + '%' : null],
    ['ROM',       game.path],
  ].filter(([, v]) => v);
  $('detail-info').innerHTML = fields.map(([l, v]) =>
    `<div class="info-cell${l === 'ROM' ? ' info-cell-rom' : ''}"><div class="info-label">${l}</div><div class="info-value${l === 'ROM' ? ' info-value-path' : ''}">${esc(v)}</div></div>`
  ).join('');

  $('detail-fav-btn').classList.toggle('fav-active', state.favorites.has(game.path));
  $('detail-fav-btn').innerHTML  = state.favorites.has(game.path) ? '♥ Favorito' : '♡ Favorito';
  $('detail-fav-btn').onclick    = () => toggleFav(game);
  $('detail-collection-btn').onclick = () => openBuilderForGame(game);

  // Botón retry
  $('detail-retry-btn').onclick = () => {
    memCache.delete(game.image);
    openDetail(detailCurrentGame);
  };

  // ── Imagen: siempre se carga al abrir el panel ──
  if (game.image) {
    loadDetailImg(img, mediaEl, game.image);
  } else {
    mediaEl.classList.add('error');
  }

  // ── Video: mostrar botón si existe, NUNCA descargar automáticamente ──
  if (game.video) {
    const btn = $('detail-video-btn');
    btn.classList.remove('hidden');
    btn.onclick = () => playDetailVideo(game);
  }

  // Mostrar retry cuando la imagen falla
  const mo = new MutationObserver(() => {
    if (mediaEl.classList.contains('error')) {
      $('detail-retry-btn').classList.remove('hidden');
      mo.disconnect();
    }
  });
  mo.observe(mediaEl, { attributes: true, attributeFilter: ['class'] });

  $('detail-overlay').classList.remove('hidden');
  $('detail-panel').classList.remove('hidden');
}

// Descarga y reproduce video solo cuando el usuario hace clic en "Ver video"
function playDetailVideo(game) {
  const mediaEl = $('detail-media');
  const vid     = $('detail-video');
  const img     = $('detail-img');
  const btn     = $('detail-video-btn');

  btn.disabled = true;
  btn.textContent = '⏳ Cargando…';

  enqueueMedia(game.video).promise.then(url => {
    btn.disabled = false;
    if (!url) { btn.textContent = '▶ Ver video'; showToast('❌ No se pudo cargar el video'); return; }

    // Ocultar imagen, mostrar video
    img.style.display = 'none';
    vid.classList.remove('hidden');
    vid.src = url;
    vid.load();
    vid.play().catch(() => {});
    mediaEl.classList.add('loaded');

    // Cambiar botón a "Ver imagen"
    btn.textContent = '🖼 Ver imagen';
    btn.onclick = () => {
      vid.pause(); vid.src = ''; vid.classList.add('hidden');
      img.style.display = '';
      btn.textContent = '▶ Ver video';
      btn.onclick = () => playDetailVideo(game);
    };
  });
}

async function launchGameFromDetail(game) {
  if (!game?.path) {
    showToast('⚠ Este juego no tiene ruta ROM');
    return;
  }

  const btn = $('detail-play-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Lanzando…';

  try {
    const res = await window.r36s.launchGame({
      romPath: game.path,
      system: game.system,
    });

    if (!res.ok && handleSshError(res.error, 'Not connected')) {
      return;
    }

    if (res.ok) {
      showToast(`▶ Lanzado en consola (${res.method || 'ok'})`, 3000);
      closeDetail();
      return;
    }

    showToast(`❌ No se pudo lanzar: ${res.error || 'error desconocido'}`, 4200);
  } catch (e) {
    showToast(`❌ Error lanzando juego: ${e.message || String(e)}`, 4200);
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Jugar';
  }
}

$('detail-close').addEventListener('click',   closeDetail);
$('detail-overlay').addEventListener('click', closeDetail);
function closeDetail() {
  $('detail-panel').classList.add('hidden');
  $('detail-overlay').classList.add('hidden');
  $('btn-restart-es').classList.remove('hidden');
  const v = $('detail-video'); v.pause?.(); v.src = '';
}

// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
// FAVORITES — sincroniza con gamelist.xml de la consola
// ═══════════════════════════════════════════════════════════

async function toggleFav(game) {
  const isFav = state.favorites.has(game.path);
  const nowFav = !isFav;

  // 1. Actualizar estado local inmediatamente (UI responsiva)
  if (nowFav) state.favorites.add(game.path);
  else        state.favorites.delete(game.path);

  localStorage.setItem(STORE_FAVS, JSON.stringify([...state.favorites]));

  // 2. Actualizar campo en el objeto game (para la caché)
  game.favorite = nowFav ? 'true' : 'false';

  // 3. Sincronizar todas las tarjetas visibles con el nuevo estado
  syncFavCards();

  // 4. Actualizar botón del panel de detalle
  updateFavBtn(nowFav);

  // 5. Actualizar badge sidebar
  updateBadges();

  // 6. Escribir en gamelist.xml de la consola vía SSH (async, no bloquea UI)
  showToast(nowFav ? '♥ Marcado como favorito' : '♥ Quitado de favoritos');

  const res = await window.r36s.setFavorite({
    gamePath:   game.path,
    systemPath: game.systemPath,
    value:      nowFav,
  });

  if (!res.ok) {
    handleSshError(res.error, 'Not connected');
    showToast(`⚠ No se pudo sincronizar: ${res.error}`, 4000);
    // Revertir estado local si falló
    if (nowFav) state.favorites.delete(game.path);
    else        state.favorites.add(game.path);
    game.favorite = isFav ? 'true' : 'false';
    localStorage.setItem(STORE_FAVS, JSON.stringify([...state.favorites]));
    syncFavCards();
    updateFavBtn(!nowFav);
    updateBadges();
    return;
  }

  // 7. Actualizar el campo favorite en la caché en disco sin borrarla
  //    — solo actualizamos el objeto en memoria y reescribimos el JSON
  game.favorite = nowFav ? 'true' : 'false';
  if (state.currentConsole) {
    const cached = await window.r36s.cacheLoad(state.currentConsole.host);
    if (cached && cached.ok) {
      const updatedGames = cached.games.map(g =>
        g.path === game.path ? { ...g, favorite: game.favorite } : g
      );
      await window.r36s.cacheSave(
        state.currentConsole.host,
        cached.systems,
        updatedGames
      );
    }
  }

  showToast(nowFav ? '♥ Favorito guardado en consola' : '♥ Quitado en consola');
}

// Actualiza todas las tarjetas del grid con el estado actual de favoritos
function syncFavCards() {
  document.querySelectorAll('.game-card').forEach(card => {
    const name = card.querySelector('.card-name')?.textContent;
    const sys  = card.querySelector('.card-sys')?.textContent;
    const game = state.allGames.find(g =>
      (g.name || g.path) === name && g.system === sys
    );
    if (!game) return;
    const fav = state.favorites.has(game.path);
    card.classList.toggle('is-fav', fav);
  });
}

function updateFavBtn(isFav) {
  const btn = $('detail-fav-btn');
  if (!btn) return;
  btn.classList.toggle('fav-active', isFav);
  btn.innerHTML = isFav
    ? '♥ Favorito'
    : '♡ Favorito';
}


// ═══════════════════════════════════════════════════════════
// COLLECTIONS
// ═══════════════════════════════════════════════════════════
async function renderCollectionsView() {
  const res = await window.r36s.listCollections();
  if (!res.ok && handleSshError(res.error, 'Not connected')) return;
  const cl  = $('col-list');
  cl.innerHTML = '';
  if (res.ok && res.files.length) {
    res.files.forEach(f => {
      const name = f.split('/').pop().replace('custom-', '').replace('.cfg', '').replace(/_/g, ' ');
      const item = document.createElement('div');
      item.className = 'col-item';
      item.innerHTML = `<span class="col-item-icon">📁</span>
        <div class="col-item-info">
          <div class="col-item-name">${esc(name)}</div>
          <div class="col-item-path">${esc(f)}</div>
        </div>`;
      cl.appendChild(item);
    });
  } else {
    cl.innerHTML = '<div class="col-no-items">No hay colecciones en /roms/collections/ todavía.</div>';
  }
  if (state.suggestions.length) renderSuggestions();
}

function runSagaAnalysis() {
  state.suggestions = analyzeSagas(state.allGames);
  if (state.currentView === 'collections') renderSuggestions();
}

function renderSuggestions() {
  const sc = $('sugg-cards');
  if (!state.suggestions.length) {
    sc.innerHTML = '<div class="sugg-empty">No se detectaron sagas con 2+ juegos.</div>';
    return;
  }
  sc.innerHTML = '';
  state.suggestions.forEach(({ saga, matches, count }) => {
    const card = document.createElement('div');
    card.className = 'sugg-card';
    card.innerHTML = `<div class="sugg-emoji">${saga.emoji}</div>
      <div class="sugg-name">${esc(saga.label)}</div>
      <div class="sugg-desc">${esc(saga.description)}</div>
      <div class="sugg-count">🎮 ${count} juego${count !== 1 ? 's' : ''}</div>`;
    card.addEventListener('click', () => openBuilderForSaga(saga, matches));
    sc.appendChild(card);
  });
}

// ═══════════════════════════════════════════════════════════
// COLLECTION BUILDER
// ═══════════════════════════════════════════════════════════
let builderPayload = null;

function openBuilderForSaga(saga, matches) {
  builderPayload = { name: saga.label, romPaths: matches.map(g => g.path) };
  $('builder-emoji').textContent = saga.emoji;
  $('builder-name').textContent  = saga.label;
  $('builder-desc').textContent  = saga.description;
  renderBuilderGames(matches);
  openBuilder();
}
function openBuilderForGame(game) {
  const name = game.name || game.path.split('/').pop();
  builderPayload = { name, romPaths: [game.path] };
  $('builder-emoji').textContent = sysEmoji(game.system);
  $('builder-name').textContent  = name;
  $('builder-desc').textContent  = `Colección del sistema ${game.system}`;
  renderBuilderGames([game]);
  openBuilder();
}
function renderBuilderGames(games) {
  const c = $('builder-games'); c.innerHTML = '';
  games.forEach(g => {
    const el = document.createElement('div'); el.className = 'builder-game-item';
    el.innerHTML = `<span class="builder-game-sys">${esc(g.system)}</span><span>${esc(g.name || g.path.split('/').pop())}</span>`;
    c.appendChild(el);
  });
}
function openBuilder() { $('builder-error').classList.add('hidden'); $('builder-success').classList.add('hidden'); $('builder-sheet').classList.remove('hidden'); }
function closeBuilder() { $('builder-sheet').classList.add('hidden'); builderPayload = null; }
$('builder-close').addEventListener('click',  closeBuilder);
$('builder-cancel').addEventListener('click', closeBuilder);

$('builder-save').addEventListener('click', async () => {
  if (!builderPayload) return;
  const btn = $('builder-save'), sp = $('builder-spinner');
  btn.disabled = true; sp.classList.remove('hidden');
  const res = await window.r36s.writeCollection(builderPayload);
  btn.disabled = false; sp.classList.add('hidden');
  if (!res.ok && handleSshError(res.error, 'Not connected')) return;
  if (!res.ok) { const e = $('builder-error'); e.textContent = '❌ ' + res.error; e.classList.remove('hidden'); return; }
  const pathsText = Array.isArray(res.paths) && res.paths.length
    ? res.paths.join(' · ')
    : res.path;
  const settingsText = res.settings
    ? ` [custom=${res.settings.custom || '-'} | displayed=${res.settings.displayed || '-'} | useCustom=${res.settings.useCustom || '-'}]`
    : '';
  $('builder-success').textContent = `✓ Creada (${res.collectionId || res.slug || 'custom'}) en ${pathsText}${settingsText}`;
  $('builder-success').classList.remove('hidden');
  showToast(`📁 "${builderPayload.name}" creada en R36S`);
  setTimeout(closeBuilder, 2200);
});

// ═══════════════════════════════════════════════════════════
// GOOGLE IMAGES — 5 opciones para elegir portada
// ═══════════════════════════════════════════════════════════

let scrapeResult = null; // { query, options:[{localImage,imageExt,sourceUrl}] }
let scrapeGame   = null; // juego actual en scraping
let scrapeSelectedIndex = 0;

// ── Botón Scrape en panel de detalle ────────────────────────
$('detail-scrape-btn').addEventListener('click', () => {
  if (!detailCurrentGame) return;
  startScrape(detailCurrentGame);
});

async function startScrape(game) {
  if (scrapeResult?.options?.length) {
    await window.r36s.scrapeCancel({
      localImages: scrapeResult.options.map(o => o.localImage).filter(Boolean),
    });
  }

  scrapeGame   = game;
  scrapeResult = null;
  scrapeSelectedIndex = 0;

  // Ocultar picker anterior, mostrar spinner
  $('scrape-picker-sheet').classList.add('hidden');
  setScrapeStatus('searching', 'Buscando en Google Images…');

  const res = await window.r36s.scrapeFetchGoogle({
    game,
    systemFolder: game.system,
  });

  if (!res.ok) {
    setScrapeStatus('error', '❌ ' + res.error);
    return;
  }

  scrapeResult = res;
  setScrapeStatus('hidden');
  showScrapePreview(res);
}

function showScrapePreview(res) {
  const metaEl = $('scrape-picker-meta');
  metaEl.innerHTML = `<span style="color:var(--text3)">Búsqueda:</span> ${esc(res.query || '')} · <span style="color:var(--text3)">Opciones:</span> ${res.options.length}`;

  const optEl = $('scrape-options');
  optEl.innerHTML = '';
  res.options.forEach((opt, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'scrape-opt-card' + (idx === scrapeSelectedIndex ? ' active' : '');
    const localUrl = 'file://' + opt.localImage.replace(/\\/g, '/');
    btn.innerHTML = `<img src="${localUrl}" alt="Opción ${idx + 1}" /><span class="scrape-opt-num">${idx + 1}</span>`;
    btn.addEventListener('click', () => {
      scrapeSelectedIndex = idx;
      optEl.querySelectorAll('.scrape-opt-card').forEach((el, i) => {
        el.classList.toggle('active', i === idx);
      });
    });
    optEl.appendChild(btn);
  });

  $('scrape-picker-sheet').classList.remove('hidden');
  $('scrape-commit-status').classList.add('hidden');
}

function closeScrapePicker() {
  $('scrape-picker-sheet').classList.add('hidden');
}

$('scrape-picker-close').addEventListener('click', () => {
  closeScrapePicker();
});

$('scrape-picker-sheet').addEventListener('click', e => {
  if (e.target === $('scrape-picker-sheet')) closeScrapePicker();
});

// ── Confirmar y subir ────────────────────────────────────────
$('scrape-confirm-btn').addEventListener('click', async () => {
  if (!scrapeResult || !scrapeGame) return;

  const selected = scrapeResult.options?.[scrapeSelectedIndex] || null;

  if (!selected) {
    $('scrape-commit-status').classList.remove('hidden');
    $('scrape-commit-status').className = 'scrape-status error';
    $('scrape-commit-msg').textContent = '❌ Elige una portada';
    return;
  }

  const payload = {
    game:       scrapeGame,
    localImage: selected.localImage,
    localVideo: null,
    imageExt:   selected?.imageExt || '.jpg',
    videoExt:   null,
    meta:       {},
  };

  // UI: spinner
  $('scrape-confirm-btn').disabled = true;
  $('scrape-confirm-spinner').classList.remove('hidden');
  $('scrape-commit-status').classList.remove('hidden');
  $('scrape-commit-status').className = 'scrape-status';
  $('scrape-commit-msg').textContent = 'Subiendo a consola…';

  const res = await window.r36s.scrapeCommit(payload);

  $('scrape-confirm-btn').disabled = false;
  $('scrape-confirm-spinner').classList.add('hidden');
  if (!res.ok && handleSshError(res.error, 'Not connected')) return;

  if (!res.ok) {
    $('scrape-commit-status').className = 'scrape-status error';
    $('scrape-commit-msg').textContent = '❌ ' + res.error;
    return;
  }

  // Limpiar temporales no usados
  const cleanup = (scrapeResult.options || [])
    .map(o => o.localImage)
    .filter(p => p && p !== payload.localImage);
  if (cleanup.length) {
    await window.r36s.scrapeCancel({ localImages: cleanup });
  }

  $('scrape-commit-status').className = 'scrape-status success';
  $('scrape-commit-msg').textContent = '✓ Guardado en la consola';

  // Actualizar rutas de media al formato absoluto esperado por fetchMedia
  const prevImage = scrapeGame.image;
  const prevVideo = scrapeGame.video;
  const normalizedUpdates = { ...res.updates };
  if (normalizedUpdates.image) normalizedUpdates.image = normPath(normalizedUpdates.image, scrapeGame.systemPath);
  if (normalizedUpdates.video) normalizedUpdates.video = normPath(normalizedUpdates.video, scrapeGame.systemPath);

  // Actualizar objeto game en memoria
  Object.assign(scrapeGame, normalizedUpdates);

  // Limpiar caché en RAM para forzar refresco de miniatura/detalle
  if (prevImage) memCache.delete(prevImage);
  if (prevVideo) memCache.delete(prevVideo);
  if (scrapeGame.image) memCache.delete(scrapeGame.image);
  if (scrapeGame.video) memCache.delete(scrapeGame.video);

  // Propagar cambios al listado global en memoria
  state.allGames = state.allGames.map(g =>
    g.path === scrapeGame.path ? { ...g, ...normalizedUpdates } : g
  );

  // Refrescar la vista actual para que cambie la portada en el item
  renderGames();

  if (state.currentConsole) {
    const cached = await window.r36s.cacheLoad(state.currentConsole.host);
    if (cached?.ok) {
      const updated = cached.games.map(g =>
        g.path === scrapeGame.path ? { ...g, ...normalizedUpdates } : g);
      await window.r36s.cacheSave(state.currentConsole.host, cached.systems, updated);
    }
  }

  showToast('✓ Scraping completado');
  setTimeout(() => {
    closeScrapePicker();
    // Reabrir el detalle con los datos actualizados
    openDetail(scrapeGame);
  }, 1500);
});

// ── Descartar ────────────────────────────────────────────────
$('scrape-discard-btn').addEventListener('click', async () => {
  if (scrapeResult) {
    await window.r36s.scrapeCancel({
      localImages: (scrapeResult.options || []).map(o => o.localImage).filter(Boolean),
    });
  }
  scrapeResult = null;
  closeScrapePicker();
});

function setScrapeStatus(type, msg) {
  const el = $('scrape-status');
  if (type === 'hidden') { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.className = 'scrape-status' + (type === 'error' ? ' error' : type === 'success' ? ' success' : '');
  $('scrape-msg').textContent = msg || '';
}

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════
function showLoading(msg) {
  $('content-loading').classList.remove('hidden');
  $('games-container').classList.add('hidden');
  $('collections-view').classList.add('hidden');
  $('empty-state').classList.add('hidden');
  $('loading-msg').textContent = msg || 'Cargando…';
}
function hideLoading() { $('content-loading').classList.add('hidden'); }
function updateToolbar(title, count) { $('toolbar-title').textContent = title; $('toolbar-count').textContent = count; }
function setFooterStatus(msg, status) {
  $('footer-status').textContent = msg;
  $('dot-status').className = 'dot-status' +
    (status === 'loading' ? ' loading' : status === 'offline' ? ' offline' : '');
}
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}