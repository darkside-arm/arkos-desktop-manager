const { app, BrowserWindow, ipcMain, nativeTheme, Menu } = require('electron');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');
const https = require('https');
const { NodeSSH } = require('node-ssh');
const xml2js = require('xml2js');

// ── Sin menú nativo ───────────────────────────────────────────────────────────
Menu.setApplicationMenu(null);

// ── Directorio de configuración: ~/.config/r36s-manager/ ─────────────────────
const CONFIG_DIR      = path.join(os.homedir(), '.config', 'r36s-manager');
const CACHE_DIR       = path.join(CONFIG_DIR, 'cache');
const MEDIA_CACHE_DIR = path.join(CONFIG_DIR, 'media-cache');
const SETTINGS_FILE   = path.join(CONFIG_DIR, 'settings.json');   // ← nuevo

for (const d of [CONFIG_DIR, CACHE_DIR, MEDIA_CACHE_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ── Rutas de caché de gamelists ───────────────────────────────────────────────
// Un archivo por host: ~/.config/r36s-manager/cache/<host>.json
function gamelistCachePath(host) {
  const safe = host.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(CACHE_DIR, safe + '.json');
}

// ── Ruta de caché de imagen/video ─────────────────────────────────────────────
function mediaCachePath(remotePath) {
  const safe = remotePath.replace(/[^a-zA-Z0-9._-]/g, '_');
  const ext  = path.extname(remotePath) || '.bin';
  return path.join(MEDIA_CACHE_DIR, safe.slice(-180) + ext);
}

function shQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

// ── Nombres de ROMs ──────────────────────────────────────────────────────────
// Los archivos temporales locales se guardan como
// `r36s_rom_<timestamp>_<nombre original>` para evitar colisiones en %TEMP%.
// Ese prefijo NUNCA debe llegar a la consola: el nombre remoto tiene que ser
// el original (ej. strhoop.zip), porque EmulationStation y los scrapers
// emparejan los juegos por nombre de archivo.
const TEMP_ROM_PREFIX_RE = /^r36s_rom_\d+_/i;

function stripTempRomPrefix(name) {
  return String(name || '').replace(TEMP_ROM_PREFIX_RE, '');
}

function sanitizeRomFileName(name) {
  // basename soporta / y \ en Windows y POSIX
  const base = path.basename(String(name || '').replace(/\\/g, '/')).trim();
  // Caracteres inválidos o peligrosos en rutas remotas
  return base.replace(/[\x00-\x1f<>:"|?*]/g, '_');
}

// ── SSH singleton ────────────────────────────────────────────────────────────
let ssh = null;
let sshConnected = false;
let sshConfig    = {};

function markSshDisconnected(reason) {
  if (sshConnected) {
    console.warn('[ssh] Conexion perdida:', reason || 'sin detalle');
  }
  sshConnected = false;
}

function attachSshGuards(client) {
  const conn = client?.connection;
  if (!conn || conn.__r36sGuarded) return;
  conn.__r36sGuarded = true;

  try { conn.setMaxListeners(20); } catch {}

  conn.on('error', err => {
    const msg = err?.message || String(err);
    if (/econnreset|read econnreset/i.test(msg)) {
      console.warn('[ssh] ECONNRESET:', msg);
    } else {
      console.error('[ssh] error:', msg);
    }
    markSshDisconnected(msg);
  });

  conn.on('close', () => markSshDisconnected('socket closed'));
  conn.on('end',   () => markSshDisconnected('socket ended'));
}

process.on('uncaughtException', err => {
  const msg = err?.message || String(err);
  if (/econnreset|read econnreset/i.test(msg)) {
    console.warn('[main] Ignorando ECONNRESET no fatal:', msg);
    markSshDisconnected(msg);
    return;
  }
  console.error('[main] uncaughtException:', err);
});

// ── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  const isMac = process.platform === 'darwin';

  const win = new BrowserWindow({
    width:  1280,
    height: 800,
    minWidth:  900,
    minHeight: 600,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 18 },
    ...(isMac ? {
      vibrancy: 'under-window',
      visualEffectState: 'active',
      transparent: true,
      backgroundColor: '#00000000',
    } : {
      backgroundColor: '#1c1c1e',
    }),
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, '../renderer/index.html'));

  nativeTheme.on('updated', () => {
    win.webContents.send('theme-changed', nativeTheme.shouldUseDarkColors);
  });

  ipcMain.on('win:minimize', () => win.minimize());
  ipcMain.on('win:maximize', () => win.isMaximized() ? win.unmaximize() : win.maximize());
  ipcMain.on('win:close',    () => win.close());
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── IPC: SSH Connect ─────────────────────────────────────────────────────────
ipcMain.handle('ssh:connect', async (_, config) => {
  try {
    if (ssh) {
      try { await ssh.dispose(); } catch {}
      ssh = null;
    }
    sshConnected = false;

    ssh = new NodeSSH();
    sshConfig = config;
    await ssh.connect({
      host:              config.host,
      port:              config.port || 22,
      username:          config.username || 'ark',
      password:          config.password || '',
      readyTimeout:      10000,
      keepaliveInterval: 10000,
    });
    attachSshGuards(ssh);
    sshConnected = true;
    return { ok: true };
  } catch (err) {
    if (ssh) {
      try { await ssh.dispose(); } catch {}
      ssh = null;
    }
    sshConnected = false;
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('ssh:disconnect', async () => {
  if (ssh) {
    try { await ssh.dispose(); } catch {}
    ssh = null;
  }
  sshConnected = false;
  return { ok: true };
});

ipcMain.handle('ssh:status', () => ({ connected: sshConnected, host: sshConfig.host }));

// ── IPC: Gamelist cache (lee/escribe en ~/.config/r36s-manager/cache/) ────────
ipcMain.handle('cache:load', (_, host) => {
  const file = gamelistCachePath(host);
  try {
    if (!fs.existsSync(file)) return { ok: false };
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ok: true, ...obj };
  } catch { return { ok: false }; }
});

ipcMain.handle('cache:save', (_, { host, systems, games }) => {
  try {
    const file = gamelistCachePath(host);
    fs.writeFileSync(file, JSON.stringify({ ts: Date.now(), systems, games }), 'utf8');
    return { ok: true, file };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('cache:invalidate', (_, host) => {
  try {
    const file = gamelistCachePath(host);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('cache:info', (_, host) => {
  const file = gamelistCachePath(host);
  try {
    if (!fs.existsSync(file)) return { ok: false };
    const stat = fs.statSync(file);
    const obj  = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ok: true, file, ts: obj.ts, size: stat.size };
  } catch { return { ok: false }; }
});

// ── IPC: List systems ─────────────────────────────────────────────────────────
ipcMain.handle('ssh:list-systems', async () => {
  if (!sshConnected) return { ok: false, error: 'Not connected' };
  try {
    const r = await ssh.execCommand('find /roms -maxdepth 1 -mindepth 1 -type d | sort');
    const systems = r.stdout.trim().split('\n').filter(Boolean).map(p => ({
      path: p, name: path.basename(p),
    }));
    return { ok: true, systems };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── IPC: Disk usage (df) ──────────────────────────────────────────────────────
ipcMain.handle('ssh:disk-usage', async () => {
  if (!sshConnected) return { ok: false, error: 'Not connected' };
  try {
    const r = await ssh.execCommand('df -B1 -P -T');
    const lines = r.stdout.trim().split('\n').slice(1);
    const seen = new Set();
    const disks = [];
    for (const line of lines) {
      const m = line.trim().split(/\s+/);
      if (m.length < 7) continue;
      const [fs, type, size, used, avail, , mount] = m;
      // Solo unidades relevantes: dispositivos de bloque reales
      if (!/^\/dev\//.test(fs)) continue;
      if (seen.has(fs)) continue;
      seen.add(fs);
      disks.push({
        fs, type, mount,
        size: parseInt(size, 10) || 0,
        used: parseInt(used, 10) || 0,
        avail: parseInt(avail, 10) || 0,
      });
    }
    return { ok: true, disks };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── IPC: Read gamelist.xml ────────────────────────────────────────────────────
ipcMain.handle('ssh:read-gamelist', async (_, systemPath) => {
  if (!sshConnected) return { ok: false, error: 'Not connected' };
  try {
    const r = await ssh.execCommand(`cat "${systemPath}/gamelist.xml"`);
    if (!r.stdout.trim()) return { ok: false, error: 'empty' };
    const parsed = await xml2js.parseStringPromise(r.stdout, {
      explicitArray: false, mergeAttrs: true,
    });
    const games = parsed?.gameList?.game;
    const list  = Array.isArray(games) ? games : games ? [games] : [];

    // Validar ROMs existentes en una sola pasada para ocultar huérfanos.
    // Incluye archivos y carpetas (algunos sistemas guardan juegos en directorios).
    const fsScan = await ssh.execCommand(
      `find "${systemPath}" -mindepth 1 \( -type f -o -type d \) 2>/dev/null`
    );

    const existingAbs = new Set(
      fsScan.stdout
        .split('\n')
        .map(s => s.trim())
        .filter(Boolean)
    );

    const existingRel = new Set();
    const existingBase = new Set();
    for (const abs of existingAbs) {
      if (abs.startsWith(systemPath + '/')) {
        existingRel.add('./' + abs.slice(systemPath.length + 1));
      }
      existingBase.add(path.posix.basename(abs));
    }

    const normalizedSystem = systemPath.endsWith('/') ? systemPath.slice(0, -1) : systemPath;
    const filtered = list.filter(g => {
      const raw = String(g?.path || '').trim();
      if (!raw) return false;

      const abs = raw.startsWith('/')
        ? raw
        : path.posix.join(normalizedSystem, raw.replace(/^\.\//, ''));
      const rel = './' + abs.slice(normalizedSystem.length + 1);
      const base = path.posix.basename(abs);

      return (
        existingAbs.has(raw) ||
        existingAbs.has(abs) ||
        existingRel.has(raw) ||
        existingRel.has(rel) ||
        existingBase.has(base)
      );
    });

    const fallbackToFullList = list.length > 0 && filtered.length === 0;

    return {
      ok: true,
      games: fallbackToFullList ? list : filtered,
      total: list.length,
      orphans: fallbackToFullList ? 0 : Math.max(0, list.length - filtered.length),
      fallbackToFullList,
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── IPC: Set favorite in gamelist.xml ────────────────────────────────────────
// Sube un script Python temporal a la consola y lo ejecuta allí.
// Python modifica solo la línea <favorite> del juego correcto — no toca el resto.
ipcMain.handle('ssh:set-favorite', async (_, { gamePath, systemPath, value }) => {
  if (!sshConnected) return { ok: false, error: 'Not connected' };

  const xmlPath  = `${systemPath}/gamelist.xml`;
  const favValue = value ? 'true' : 'false';

  // Script Python que edita en sitio — busca el bloque del juego por path
  // y actualiza/inserta <favorite>. No usa xml.etree para no alterar formato.
  const pyScript = `
import re

xml_path  = ${JSON.stringify(xmlPath)}
game_path = ${JSON.stringify(gamePath)}
fav_value = ${JSON.stringify(favValue)}

with open(xml_path, 'r', encoding='utf-8') as f:
    xml = f.read()

# Dividir en bloques <game>...</game>
blocks = re.split(r'(?=<game[\\s>])', xml)
result = []
found  = False

for block in blocks:
    if not block.strip().startswith('<game'):
        result.append(block)
        continue
    # Comprobar si este bloque contiene el path buscado
    # Comparar tail del path (nombre de archivo) para mayor compatibilidad
    game_basename = game_path.rstrip('/').split('/')[-1]
    path_match = re.search(r'<path>([^<]+)</path>', block)
    if path_match:
        p = path_match.group(1).strip()
        if p == game_path or p.endswith('/' + game_basename) or p.endswith(game_basename):
            found = True
            if '<favorite>' in block:
                block = re.sub(r'<favorite>[^<]*</favorite>',
                               '<favorite>' + fav_value + '</favorite>', block)
            else:
                block = re.sub(r'(<path>[^<]*</path>)',
                               r'\\1\\n\\t\\t<favorite>' + fav_value + '</favorite>', block)
    result.append(block)

if found:
    with open(xml_path, 'w', encoding='utf-8') as f:
        f.write(''.join(result))
    print('ok')
else:
    print('not_found:' + game_path)
`;

  const tmpLocal  = path.join(os.tmpdir(), `r36s_fav_${Date.now()}.py`);
  const tmpRemote = `/tmp/r36s_fav_${Date.now()}.py`;

  try {
    fs.writeFileSync(tmpLocal, pyScript, 'utf8');
    await ssh.putFile(tmpLocal, tmpRemote);
    fs.unlinkSync(tmpLocal);

    const r = await ssh.execCommand(`python3 "${tmpRemote}" ; rm -f "${tmpRemote}"`);
    const out = r.stdout.trim();

    if (out === 'ok')               return { ok: true };
    if (out.startsWith('not_found')) return { ok: false, error: `Juego no encontrado en gamelist: ${out}` };
    return { ok: false, error: r.stderr || out || 'Error desconocido' };
  } catch (e) {
    try { fs.unlinkSync(tmpLocal); } catch {}
    return { ok: false, error: e.message };
  }
});

// ── IPC: Delete game (ROM + media + entrada en gamelist.xml) ─────────────────
ipcMain.handle('ssh:delete-game', async (_, { gamePath, systemPath, media }) => {
  if (!sshConnected) return { ok: false, error: 'Not connected' };

  const xmlPath = `${systemPath}/gamelist.xml`;
  const pyScript = `
import re, os, json

xml_path  = ${JSON.stringify(xmlPath)}
game_path = ${JSON.stringify(gamePath)}
media     = ${JSON.stringify((media || []).filter(Boolean))}

removed = []

# 1. Borrar ROM
if os.path.isfile(game_path):
    os.remove(game_path)
    removed.append(game_path)

# 2. Borrar media asociada (imagen, video, marquee...)
for m in media:
    if os.path.isfile(m):
        os.remove(m)
        removed.append(m)

# 3. Quitar el bloque <game> del gamelist.xml
found = False
try:
    with open(xml_path, 'r', encoding='utf-8') as f:
        xml = f.read()
    blocks = re.split(r'(?=<game[\\s>])', xml)
    result = []
    game_basename = game_path.rstrip('/').split('/')[-1]
    for block in blocks:
        if block.strip().startswith('<game'):
            path_match = re.search(r'<path>([^<]+)</path>', block)
            if path_match:
                p = path_match.group(1).strip()
                if p == game_path or p.endswith('/' + game_basename) or p.endswith(game_basename):
                    found = True
                    # conservar lo que haya despues de </game> en este bloque
                    tail = block.split('</game>', 1)
                    if len(tail) == 2:
                        result.append(tail[1])
                    continue
        result.append(block)
    if found:
        with open(xml_path, 'w', encoding='utf-8') as f:
            f.write(''.join(result))
except FileNotFoundError:
    pass

print(json.dumps({'ok': True, 'removed': removed, 'gamelist': found}))
`;

  const tmpLocal  = path.join(os.tmpdir(), `r36s_del_${Date.now()}.py`);
  const tmpRemote = `/tmp/r36s_del_${Date.now()}.py`;

  try {
    fs.writeFileSync(tmpLocal, pyScript, 'utf8');
    await ssh.putFile(tmpLocal, tmpRemote);
    fs.unlinkSync(tmpLocal);

    const r = await ssh.execCommand(`python3 "${tmpRemote}" ; rm -f "${tmpRemote}"`);
    const out = r.stdout.trim();
    try {
      const parsed = JSON.parse(out);
      return { ok: true, removed: parsed.removed, gamelist: parsed.gamelist };
    } catch {
      return { ok: false, error: r.stderr || out || 'Error desconocido' };
    }
  } catch (e) {
    try { fs.unlinkSync(tmpLocal); } catch {}
    return { ok: false, error: e.message };
  }
});


ipcMain.handle('ssh:fetch-media', async (_, remotePath) => {
  if (!sshConnected) return { ok: false, error: 'Not connected' };
  const localPath = mediaCachePath(remotePath);
  if (fs.existsSync(localPath)) return { ok: true, localPath, cached: true };
  try {
    await ssh.getFile(localPath, remotePath);
    return { ok: true, localPath, cached: false };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── IPC: Write collection ─────────────────────────────────────────────────────
ipcMain.handle('ssh:write-collection', async (_, { name, romPaths }) => {
  if (!sshConnected) return { ok: false, error: 'Not connected' };
  try {
    const baseName = String(name || 'Collection').trim() || 'Collection';
    const slug = baseName
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase() || `collection_${Date.now()}`;
    const collectionId = `custom-${slug}`;

    const filename = `${collectionId}.cfg`;
    const collDir = '/home/ark/.emulationstation/collections';

    const lines = Array.isArray(romPaths)
      ? [...new Set(romPaths.map(v => String(v || '').trim()).filter(Boolean))]
      : [];
    if (!lines.length) return { ok: false, error: 'Coleccion vacia (sin ROMs)' };

    const tmp = path.join(os.tmpdir(), filename);
    fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf8');

    await ssh.execCommand(`mkdir -p ${shQuote(collDir)}`);
    await ssh.putFile(tmp, `${collDir}/${filename}`);

    fs.unlinkSync(tmp);

    // Habilitar la colección en EmulationStation para que aparezca en el menú.
    const settingsPath = '/home/ark/.emulationstation/es_settings.cfg';
    const py = [
      'import os',
      'import xml.etree.ElementTree as ET',
      '',
      `settings_path = ${JSON.stringify(settingsPath)}`,
      `slug = ${JSON.stringify(slug)}`,
      `collection_id = ${JSON.stringify(collectionId)}`,
      '',
      'if os.path.exists(settings_path):',
      '    tree = ET.parse(settings_path)',
      '    root = tree.getroot()',
      'else:',
      '    root = ET.Element("config")',
      '    tree = ET.ElementTree(root)',
      '',
      'def get_string(name):',
      '    for node in root.findall("string"):',
      '        if node.attrib.get("name") == name:',
      '            return node',
      '    return None',
      '',
      'def set_string(name, value):',
      '    node = get_string(name)',
      '    if node is None:',
      '        node = ET.SubElement(root, "string", {"name": name, "value": value})',
      '    else:',
      '        node.attrib["value"] = value',
      '',
      'def set_bool(name, value):',
      '    target = "true" if value else "false"',
      '    node = None',
      '    for n in root.findall("bool"):',
      '        if n.attrib.get("name") == name:',
      '            node = n',
      '            break',
      '    if node is None:',
      '        node = ET.SubElement(root, "bool", {"name": name, "value": target})',
      '    else:',
      '        node.attrib["value"] = target',
      '',
      'def append_slug(setting_name):',
      '    node = get_string(setting_name)',
      '    raw = node.attrib.get("value", "") if node is not None else ""',
      '    sep = ";" if ";" in raw else ","',
      '    clean = raw.replace(";", ",")',
      '    items = [x.strip() for x in clean.split(",") if x.strip()]',
      '    for candidate in (collection_id, slug):',
      '        if candidate not in items:',
      '            items.append(candidate)',
      '    set_string(setting_name, sep.join(items))',
      '',
      'append_slug("CollectionSystemsCustom")',
      'append_slug("CollectionSystemsDisplayed")',
      'set_bool("UseCustomCollectionsSystem", True)',
      '',
      'os.makedirs(os.path.dirname(settings_path), exist_ok=True)',
      'tree.write(settings_path, encoding="utf-8", xml_declaration=True)',
      'custom = get_string("CollectionSystemsCustom")',
      'displayed = get_string("CollectionSystemsDisplayed")',
      'print("ok|%s|%s|%s" % (',
      '    custom.attrib.get("value", "") if custom is not None else "",',
      '    displayed.attrib.get("value", "") if displayed is not None else "",',
      '    "true"',
      '))',
    ].join('\n');

    const pyLocal  = path.join(os.tmpdir(), `r36s_enable_collection_${Date.now()}.py`);
    const pyRemote = `/tmp/r36s_enable_collection_${Date.now()}.py`;
    fs.writeFileSync(pyLocal, py, 'utf8');
    await ssh.putFile(pyLocal, pyRemote);
    fs.unlinkSync(pyLocal);
    const pyRes = await ssh.execCommand(`python3 ${shQuote(pyRemote)} ; rm -f ${shQuote(pyRemote)}`);
    const pyOut = String(pyRes.stdout || '').trim();

    let settingsInfo = { custom: '', displayed: '', useCustom: 'true' };
    if (pyOut.startsWith('ok|')) {
      const parts = pyOut.split('|');
      settingsInfo = {
        custom: parts[1] || '',
        displayed: parts[2] || '',
        useCustom: parts[3] || 'true',
      };
    }

    return {
      ok: true,
      path: `${collDir}/${filename}`,
      slug,
      collectionId,
      settings: settingsInfo,
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── IPC: List collections ─────────────────────────────────────────────────────
ipcMain.handle('ssh:list-collections', async () => {
  if (!sshConnected) return { ok: false, error: 'Not connected' };
  try {
    const r = await ssh.execCommand('for d in /roms/collections /home/ark/.emulationstation/collections; do ls "$d"/custom-*.cfg 2>/dev/null; done | sort -u');
    return { ok: true, files: r.stdout.trim().split('\n').filter(Boolean) };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── Helpers: SFTP upload con progreso y verificación de integridad ────────────
// Usa el canal SFTP nativo de ssh2 (accesible via ssh.requestSFTP()) para
// transferir un archivo local → remoto reportando bytes transferidos en tiempo
// real. Al terminar verifica que el tamaño remoto coincida con el local.
//
// @param {string}   localPath   - ruta local absoluta
// @param {string}   remotePath  - ruta remota absoluta
// @param {Function} onProgress  - cb({ transferred, total, pct })
// @param {number}   stallMs     - ms sin recibir datos antes de abortar (default 60000)
// @returns {Promise<void>}      - resuelve si ok, rechaza con Error en fallo
function sftpUploadWithProgress(localPath, remotePath, onProgress, stallMs = 60_000) {
  return new Promise(async (resolve, reject) => {
    let sftp;
    try {
      sftp = await ssh.requestSFTP();
    } catch (e) {
      return reject(new Error(`SFTP init: ${e.message}`));
    }

    const total = fs.statSync(localPath).size;
    let transferred = 0;
    let stallTimer = null;

    function resetStall() {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        writeStream.destroy(new Error(`Transferencia detenida: sin actividad durante ${stallMs / 1000}s`));
      }, stallMs);
    }

    const readStream  = fs.createReadStream(localPath);
    const writeStream = sftp.createWriteStream(remotePath);

    resetStall();

    readStream.on('data', chunk => {
      transferred += chunk.length;
      resetStall();
      if (onProgress) {
        onProgress({
          transferred,
          total,
          pct: total > 0 ? Math.round(transferred / total * 100) : 0,
        });
      }
    });

    writeStream.on('close', async () => {
      if (stallTimer) clearTimeout(stallTimer);
      sftp.end();

      // Verificar tamaño remoto para detectar truncados silenciosos
      try {
        const stat = await ssh.execCommand(`stat -c%s ${shQuote(remotePath)} 2>/dev/null || wc -c < ${shQuote(remotePath)}`);
        const remoteSize = parseInt((stat.stdout || '').trim(), 10);
        if (isNaN(remoteSize) || remoteSize !== total) {
          return reject(new Error(
            `Verificación fallida: local=${total} bytes, remoto=${isNaN(remoteSize) ? '?' : remoteSize} bytes`
          ));
        }
      } catch (e) {
        // Si el stat falla no bloqueamos — el write ya completó
      }
      resolve();
    });

    writeStream.on('error', err => {
      if (stallTimer) clearTimeout(stallTimer);
      sftp.end();
      reject(err);
    });

    readStream.on('error', err => {
      if (stallTimer) clearTimeout(stallTimer);
      sftp.end();
      reject(err);
    });

    readStream.pipe(writeStream);
  });
}

// ── IPC: Upload ROM to console ────────────────────────────────────────────────
// Sube una ROM (y opcionalmente su imagen de portada) a la consola via SSH
// y actualiza el gamelist.xml con la metadata proporcionada.
// Emite eventos 'rom-upload-progress' al renderer con { romFile, transferred, total, pct }.
ipcMain.handle('ssh:upload-rom', async (event, { localPath, fileName, systemPath, meta, localImage }) => {
  if (!sshConnected) return { ok: false, error: 'Not connected' };

  // Nombre remoto = nombre original del archivo elegido por el usuario.
  // Si no llega `fileName`, se intenta reconstruir desde el temporal local.
  const originalName = sanitizeRomFileName(
    stripTempRomPrefix(fileName || path.basename(localPath)),
  );
  const localExt  = path.extname(localPath);
  const romFile   = originalName || sanitizeRomFileName(`rom_${Date.now()}${localExt}`);
  const romBase   = path.basename(romFile, path.extname(romFile));
  const romRemote = `${systemPath}/${romFile}`;

  // Función para enviar progreso al renderer que invocó este IPC
  const sendProgress = (data) => {
    try { event.sender.send('rom-upload-progress', data); } catch {}
  };

  try {
    // 1. Subir el archivo ROM con progreso real
    sendProgress({ phase: 'rom', romFile, transferred: 0, total: fs.statSync(localPath).size, pct: 0 });

    await sftpUploadWithProgress(
      localPath,
      romRemote,
      ({ transferred, total, pct }) => {
        sendProgress({ phase: 'rom', romFile, transferred, total, pct });
      },
    );

    sendProgress({ phase: 'rom', romFile, transferred: fs.statSync(localPath).size, total: fs.statSync(localPath).size, pct: 100 });

    // 2. Subir imagen si existe (pequeña, fastPut está bien)
    let imagePath = '';
    if (localImage && fs.existsSync(localImage)) {
      sendProgress({ phase: 'image', romFile });
      const imgExt   = path.extname(localImage) || '.jpg';
      const imgName  = romBase + imgExt;
      const imgDir   = `${systemPath}/media/images`;
      await ssh.execCommand(`mkdir -p ${shQuote(imgDir)}`);
      const imgRemote = `${imgDir}/${imgName}`;
      await ssh.putFile(localImage, imgRemote);
      imagePath = `./media/images/${imgName}`;
    }

    // 3. Actualizar gamelist.xml via Python en la consola
    sendProgress({ phase: 'gamelist', romFile });
    const xmlPath = `${systemPath}/gamelist.xml`;
    const gameName    = String(meta?.name      || romBase);
    const gameDesc    = String(meta?.desc      || '');
    const gameDev     = String(meta?.developer || '');
    const gamePub     = String(meta?.publisher || '');
    const rawYear     = String(meta?.year      || '').trim();
    // EmulationStation espera YYYYMMDDTHHMMSS; aceptamos "1994" o la fecha completa.
    const gameYear    = /^\d{4}$/.test(rawYear) ? `${rawYear}0101T000000` : rawYear;
    const gameGenre   = String(meta?.genre     || '');
    const gameRating  = String(meta?.rating    || '');
    const gameImage   = imagePath;
    const gamePath    = `./${romFile}`;

    const py = `
import os, xml.etree.ElementTree as ET

xml_path   = ${JSON.stringify(xmlPath)}
game_path  = ${JSON.stringify(gamePath)}
game_name  = ${JSON.stringify(gameName)}
game_desc  = ${JSON.stringify(gameDesc)}
game_dev   = ${JSON.stringify(gameDev)}
game_pub   = ${JSON.stringify(gamePub)}
game_year  = ${JSON.stringify(gameYear)}
game_genre = ${JSON.stringify(gameGenre)}
game_rating= ${JSON.stringify(gameRating)}
game_image = ${JSON.stringify(gameImage)}

if os.path.exists(xml_path):
    ET.register_namespace('', '')
    tree = ET.parse(xml_path)
    root = tree.getroot()
else:
    root = ET.Element('gameList')
    tree = ET.ElementTree(root)

# Buscar si ya existe
existing = None
for g in root.findall('game'):
    p = g.findtext('path', '')
    if p == game_path or p.endswith('/' + os.path.basename(game_path)):
        existing = g
        break

if existing is None:
    existing = ET.SubElement(root, 'game')

def set_field(parent, tag, value):
    if not value:
        return
    el = parent.find(tag)
    if el is None:
        el = ET.SubElement(parent, tag)
    el.text = value

set_field(existing, 'path',      game_path)
set_field(existing, 'name',      game_name)
set_field(existing, 'desc',      game_desc)
set_field(existing, 'developer', game_dev)
set_field(existing, 'publisher', game_pub)
set_field(existing, 'releasedate', game_year)
set_field(existing, 'genre',     game_genre)
set_field(existing, 'rating',    game_rating)
if game_image:
    set_field(existing, 'image', game_image)

os.makedirs(os.path.dirname(xml_path) if os.path.dirname(xml_path) else '.', exist_ok=True)
tree.write(xml_path, encoding='utf-8', xml_declaration=True)
print('ok')
`;

    const pyLocal  = path.join(os.tmpdir(), `r36s_upload_rom_${Date.now()}.py`);
    const pyRemote = `/tmp/r36s_upload_rom_${Date.now()}.py`;
    fs.writeFileSync(pyLocal, py, 'utf8');
    await ssh.putFile(pyLocal, pyRemote);
    fs.unlinkSync(pyLocal);
    const pyRes = await ssh.execCommand(`python3 ${shQuote(pyRemote)} ; rm -f ${shQuote(pyRemote)}`);
    const pyOut = String(pyRes.stdout || '').trim();

    if (pyOut !== 'ok') {
      return { ok: false, error: pyRes.stderr || pyOut || 'Error al actualizar gamelist.xml' };
    }

    sendProgress({ phase: 'done', romFile });

    // Limpiar el temporal de la ROM (puede ocupar GBs) para no llenar %TEMP%
    try { if (localPath && localPath.startsWith(os.tmpdir())) fs.unlinkSync(localPath); } catch {}

    return { ok: true, romPath: romRemote, imagePath };
  } catch (e) {
    sendProgress({ phase: 'error', romFile, error: e.message });
    return { ok: false, error: e.message };
  }
});

// ── IPC: Restart EmulationStation ────────────────────────────────────────────
ipcMain.handle('ssh:restart-es', async () => {
  if (!sshConnected) return { ok: false, error: 'Not connected' };
  try {
    await ssh.execCommand('systemctl restart emulationstation 2>/dev/null || killall emulationstation 2>/dev/null; sleep 1; emulationstation &');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ── IPC: Launch game on console ─────────────────────────────────────────────
ipcMain.handle('ssh:launch-game', async (_, { romPath, system }) => {
  if (!sshConnected) return { ok: false, error: 'Not connected' };

  const rom = String(romPath || '').trim();
  if (!rom) return { ok: false, error: 'ROM path vacio' };

  const safeSystem = String(system || '')
    .toLowerCase()
    .replace(/[^a-z0-9_+-]/g, '') || 'default';

  const script = [
    `ROM=${shQuote(rom)}`,
    `SYS=${shQuote(safeSystem)}`,
    'LOG=/tmp/r36s-launch.log',
    'if command -v emulationstation >/dev/null 2>&1; then',
    '  HELP="$(emulationstation --help 2>&1 || true)"',
    '  if printf "%s" "$HELP" | grep -q -- "--runrom"; then',
    '    nohup emulationstation --runrom "$ROM" >>"$LOG" 2>&1 &',
    '    echo ok:emulationstation-runrom',
    '    exit 0',
    '  fi',
    '  if printf "%s" "$HELP" | grep -q -- "--run"; then',
    '    nohup emulationstation --run "$ROM" >>"$LOG" 2>&1 &',
    '    echo ok:emulationstation-run',
    '    exit 0',
    '  fi',
    'fi',
    'if command -v runcommand.sh >/dev/null 2>&1; then',
    '  nohup runcommand.sh 0 "$SYS" "$ROM" >>"$LOG" 2>&1 &',
    '  echo ok:runcommand',
    '  exit 0',
    'fi',
    'echo err:no-launch-command',
    'exit 1',
  ].join('\n');

  try {
    const r = await ssh.execCommand(`bash -lc ${shQuote(script)}`);
    const out = String(r.stdout || '').trim();
    if (out.startsWith('ok:')) return { ok: true, method: out.slice(3) };
    return { ok: false, error: out || r.stderr || 'No se pudo lanzar el juego' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// SETTINGS — ~/.config/r36s-manager/settings.json
// ═════════════════════════════════════════════════════════════════════════════
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveSettings(obj) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2), 'utf8');
}

ipcMain.handle('settings:load', () => loadSettings());
ipcMain.handle('settings:save', (_, obj) => { saveSettings({ ...loadSettings(), ...obj }); return { ok: true }; });

// ═════════════════════════════════════════════════════════════════════════════
// IA — Sugerencias de colecciones via DeepSeek (SDK OpenAI)
// ═════════════════════════════════════════════════════════════════════════════
const OpenAI = require('openai');

const DEEPSEEK_MODEL = 'deepseek-v4-flash';

async function deepseekChat(apiKey, messages) {
  const client = new OpenAI({
    baseURL: 'https://api.deepseek.com',
    apiKey,
    timeout: 120000,
  });

  console.log(`[deepseek] → modelo=${DEEPSEEK_MODEL} mensajes=${messages.length} chars=${messages.reduce((n, m) => n + m.content.length, 0)}`);
  const t0 = Date.now();

  try {
    const completion = await client.chat.completions.create({
      model: DEEPSEEK_MODEL,
      messages,
      temperature: 0.4,
      max_tokens: 8000,   // v4-flash razona internamente y consume tokens antes de responder
      response_format: { type: 'json_object' },
      stream: false,
    });

    const ms = Date.now() - t0;
    const content = completion.choices?.[0]?.message?.content || '';
    console.log(`[deepseek] ← ok en ${ms}ms | finish=${completion.choices?.[0]?.finish_reason} | tokens=${JSON.stringify(completion.usage || {})}`);
    console.log(`[deepseek] ← contenido (${content.length} chars): ${content.slice(0, 500)}${content.length > 500 ? '…' : ''}`);
    return content;
  } catch (e) {
    const ms = Date.now() - t0;
    console.error(`[deepseek] ✗ error en ${ms}ms:`, e.status || '', e.message);
    if (e.error) console.error('[deepseek] ✗ detalle API:', JSON.stringify(e.error).slice(0, 500));
    throw new Error(`DeepSeek${e.status ? ' HTTP ' + e.status : ''}: ${e.message}`);
  }
}

// games: [{ name, system }] — se envían indexados y DeepSeek devuelve índices
ipcMain.handle('ai:suggest-collections', async (_, { games }) => {
  try {
    if (!Array.isArray(games) || !games.length) {
      return { ok: false, error: 'No hay juegos cargados' };
    }
    const apiKey = (loadSettings().deepseekApiKey || '').trim();
    if (!apiKey) {
      console.warn('[deepseek] Sin token configurado — se omite la IA');
      return { ok: false, noToken: true, error: 'Sin token de DeepSeek configurado' };
    }

    // Limitar para no exceder el contexto (nombres cortos, ~1 línea por juego)
    const MAX_GAMES = 1500;
    const list = games.slice(0, MAX_GAMES);
    console.log(`[deepseek] Analizando ${list.length} juegos (de ${games.length} totales)`);
    const inventory = list.map((g, i) => `${i}|${g.system}|${g.name}`).join('\n');

    const system = [
      'Eres un experto en videojuegos retro y curación de bibliotecas de ROMs para EmulationStation.',
      'Recibirás un inventario de ROMs con formato "indice|sistema|nombre", una línea por juego.',
      'Tu tarea: proponer colecciones temáticas atractivas (sagas, géneros, compañías, épocas, crossovers).',
      'Reglas:',
      '- Cada colección debe tener al menos 2 juegos del inventario.',
      '- Usa SOLO los índices del inventario; nunca inventes juegos.',
      '- Propón entre 5 y 15 colecciones, ordenadas de mejor a peor.',
      '- label corto (máx 30 caracteres), description en español (máx 80 caracteres), emoji un solo emoji representativo.',
      'Responde ÚNICAMENTE con JSON válido con esta forma exacta:',
      '{"collections":[{"label":"...","emoji":"...","description":"...","gameIndices":[0,5,12]}]}',
    ].join('\n');

    const user = `Inventario de ROMs (${list.length} juegos):\n${inventory}`;

    const content = await deepseekChat(apiKey, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);

    let parsed;
    try { parsed = JSON.parse(content); }
    catch {
      const m = content.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('DeepSeek no devolvió JSON');
      parsed = JSON.parse(m[0]);
    }

    const collections = (parsed.collections || [])
      .map(c => ({
        label: String(c.label || '').slice(0, 60),
        emoji: String(c.emoji || '✦').slice(0, 4),
        description: String(c.description || '').slice(0, 120),
        gameIndices: (Array.isArray(c.gameIndices) ? c.gameIndices : [])
          .filter(i => Number.isInteger(i) && i >= 0 && i < list.length),
      }))
      .filter(c => c.label && c.gameIndices.length >= 2);

    console.log(`[deepseek] ${collections.length} colecciones válidas: ${collections.map(c => `${c.label}(${c.gameIndices.length})`).join(', ')}`);
    return { ok: true, collections };
  } catch (e) {
    console.error('[deepseek] ai:suggest-collections falló:', e.message);
    return { ok: false, error: e.message };
  }
});

// ── IPC: Save temp file (para upload de ROMs desde renderer) ─────────────────
ipcMain.handle('app:save-temp-file', (_, { name, buffer }) => {
  try {
    const safe = path.basename(name).replace(/[^a-zA-Z0-9._\-() ]/g, '_');
    const dest = path.join(os.tmpdir(), `r36s_rom_${Date.now()}_${safe}`);
    fs.writeFileSync(dest, Buffer.from(buffer));
    return { ok: true, localPath: dest };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// SCREENSCRAPER — https://www.screenscraper.fr/api2/
// devid/devpassword: credenciales de app (usamos las de Skyscraper como fallback)
// ═════════════════════════════════════════════════════════════════════════════

// Mapa de nombre de carpeta ES → system id de ScreenScraper
const SS_SYSTEM_IDS = {
  nes:12, snes:15, n64:14, gba:12, gbc:29, gb:9, gameboyadvance:12,
  megadrive:1, genesis:1, sega32x:19, segacd:20, saturn:22,
  dreamcast:23, mastersystem:2, gamegear:21,
  psx:57, ps2:58, psp:61,
  arcade:75, fba:75, mame:75, neogeo:142,
  pcengine:31, pce:31, pcfx:72,
  atari2600:26, atari7800:43, atarilynx:28,
  n3ds:17, nds:15, gba2600:12,
  amiga:64, c64:66, dos:135,
};

function ssSystemId(folderName) {
  const k = folderName.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SS_SYSTEM_IDS[k] || 0;
}

const SCRAPER_DEBUG = false;
function debugScraper(event, payload = {}) {
  if (!SCRAPER_DEBUG) return;
  const ts = new Date().toISOString();
  try {
    console.log(`[scraper][${ts}] ${event}`, payload);
  } catch {
    console.log(`[scraper][${ts}] ${event}`);
  }
}

// Descarga una URL HTTPS y guarda en disco
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const req = https.get(url, res => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });
    req.on('error', e => { file.close(); reject(e); });
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Llama a la API jeuInfos de ScreenScraper
function ssApiCall(endpoint, params) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const url = `https://api.screenscraper.fr/api2/${endpoint}?${qs}`;
    const safeParams = {
      ...params,
      ssid: params.ssid ? '[redacted]' : undefined,
      sspassword: params.sspassword ? '[redacted]' : undefined,
      devpassword: params.devpassword ? '[redacted]' : undefined,
    };
    debugScraper('api:request', { endpoint, params: safeParams });
    https.get(url, {
      timeout: 15000,
      headers: {
        Accept: 'application/json,text/plain,*/*',
        'Accept-Encoding': 'identity',
        'User-Agent': 'r36s-manager/1.0',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        const snippet = raw.slice(0, 180).replace(/\s+/g, ' ');
        debugScraper('api:response', {
          endpoint,
          statusCode: res.statusCode,
          contentType: res.headers['content-type'] || null,
          contentEncoding: res.headers['content-encoding'] || null,
          snippet,
        });

        if (res.statusCode !== 200) {
          debugScraper('api:http-error', { endpoint, statusCode: res.statusCode, snippet });
          return reject(new Error(`HTTP ${res.statusCode}: ${snippet || 'respuesta vacia'}`));
        }

        const normalized = raw.replace(/^\uFEFF/, '');
        const start = normalized.indexOf('{');
        const end = normalized.lastIndexOf('}');
        const candidate = (start >= 0 && end > start)
          ? normalized.slice(start, end + 1)
          : normalized;

        try {
          resolve(JSON.parse(candidate));
        } catch {
          if (normalized.startsWith('<')) {
            debugScraper('api:non-json-xml-html', { endpoint, snippet });
            return reject(new Error('Respuesta XML/HTML de ScreenScraper (posible limite o credenciales incorrectas)'));
          }
          debugScraper('api:invalid-json', { endpoint, snippet });
          reject(new Error(`Invalid JSON from ScreenScraper: ${snippet || 'sin contenido'}`));
        }
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Timeout')); });
  });
}

// Extrae la URL del media preferido (idioma es, luego en, luego cualquiera)
function pickMedia(mediaList, mediaType) {
  if (!Array.isArray(mediaList)) return null;
  const filtered = mediaList.filter(m => m.type === mediaType);
  if (!filtered.length) return null;
  return (
    filtered.find(m => m.region === 'ss' || m.region === 'wor') ||
    filtered.find(m => m.region === 'eu')  ||
    filtered[0]
  );
}

function decodeEscapedUrl(raw) {
  return String(raw || '')
    .replace(/\\u003d/g, '=')
    .replace(/\\u0026/g, '&')
    .replace(/\\u002f/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .trim();
}

function unwrapSearchRedirect(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('google.')) {
      const imgurl = u.searchParams.get('imgurl');
      const direct = u.searchParams.get('url');
      const target = imgurl || direct;
      if (target && /^https?:\/\//i.test(target)) return target;
    }
  } catch {}
  return url;
}

function normalizeImageUrl(candidate) {
  const url = unwrapSearchRedirect(decodeEscapedUrl(candidate));
  if (!/^https?:\/\//i.test(url)) return null;
  if (/\.(svg)(\?|$)/i.test(url)) return null;
  if (/^https?:\/\/encrypted-tbn\d+\.gstatic\.com\//i.test(url)) return null;
  return url;
}

function extractGoogleImageUrls(html) {
  const found = new Set();
  const patterns = [
    /"ou":"(.*?)"/g,
    /"(https?:\/\/[^"\s]+(?:jpg|jpeg|png|webp)(?:\?[^"\s]*)?)"/gi,
    /"(https?:\/\/[^"\s]+)"/gi,
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const normalized = normalizeImageUrl(m[1]);
      if (!normalized) continue;
      found.add(normalized);
      if (found.size >= 50) break;
    }
    if (found.size >= 50) break;
  }

  return [...found];
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/&#x([\da-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Bing expone los resultados de imágenes como JSON dentro del atributo m="{...}"
// (con entidades HTML). De ahí salen la URL original, el título y la página.
function parseBingImageResults(html) {
  const results = [];
  const seen = new Set();
  const re = /m="({&quot;[\s\S]*?})"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = decodeHtmlEntities(m[1]);
    let obj;
    try { obj = JSON.parse(raw); } catch { continue; }
    const url = String(obj.murl || '').trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    results.push({
      url,
      title: decodeHtmlEntities(obj.t || ''),
      page: decodeHtmlEntities(obj.purl || ''),
    });
    if (results.length >= 120) break;
  }
  return results;
}

// Puntúa una imagen candidata: portadas/flyers primero, iconos y vídeos después.
function scoreImageCandidate(result) {
  const hay = `${result.url} ${result.page} ${result.title}`;
  let score = 0;
  if (/arcade-museum|arcadeartwork|thegamesdb|video-games-museum|mobygames|gamefaqs|strategywiki/i.test(hay)) score += 30;
  if (/\b(box|boxart|box-art|cover|flyer|marquee|cartridge)\b/i.test(hay)) score += 12;
  if (/\b(front|frontal|front-cover)\b/i.test(hay)) score += 10;
  if (/\.(png|jpe?g|webp)(\?|$)/i.test(result.url)) score += 3;
  if (/\b(back|trasera|back-cover|media|disc|disk|manual|poster)\b/i.test(hay)) score -= 12;
  if (/archive\.org\/details\/mame|emumovies/i.test(hay)) score -= 15;
  if (/flyers\.arcade-museum\.com/i.test(hay)) score -= 60; // bloquea hotlinking (403)
  if (/youtube|ytimg\.com|googleusercontent\.com|play\.google|uptodown|apkpure|ldplayer|\.apk\b/i.test(hay)) score -= 40;
  if (/\b(icon|favicon|logo|logos|sprite|snap|screenshot)\b/i.test(hay)) score -= 25;
  return score;
}

function normSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function tokenizeSearchText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

// Títulos genéricos de webs de descargas/portadas que no son el nombre del juego
const TITLE_NOISE_RE = /\b(mame[0-9a-z]*|m\.?a\.?m\.?e|tgdb?|artworks?|images?|imgs?|box|boxes|boxart|box-art|covers?|flyers?|posters?|promos?|downloads?|roms?|emulators?|emulador|verifying|screenshots?|snaps?|title\s*screens?|gameplay|history|looking\s+back|totals?|ratings?|reviews?|wikis?|databases?|museum)\b/i;


// Nombres alternativos deducidos de los propios resultados de Bing
// (p. ej. "strhoop" → "Street Hoop", útil para buscar en Wikipedia).
function deriveTitleCandidates(results, baseName) {
  const baseNorm = normSearchText(baseName);
  const counts = new Map();
  const add = raw => {
    let title = String(raw || '').split(/\s+[|–—]\s+|\s+-\s+|\s+:\s+/)[0] || '';
    title = title.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (title.length < 3 || title.length > 48) return;

    const norm = normSearchText(title);
    const isBase = norm && norm === baseNorm;
    if (!isBase && TITLE_NOISE_RE.test(title)) return;

    const key = title.toLowerCase();
    const current = counts.get(key);
    if (current) current.count += 1;
    else counts.set(key, { title, count: 1, isBase });
  };

  add(baseName);

  // Preferir resultados que mencionan el código de la ROM: son los que
  // contienen el título real (hsf2 → "Hyper Street Fighter II").
  const coOccurring = results.filter(r =>
    tokenizeSearchText(`${r.url} ${r.page} ${r.title}`).includes(baseNorm));
  const source = coOccurring.length >= 2 ? coOccurring : results.slice(0, 40);
  source.slice(0, 40).forEach(r => add(r.title));

  return [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .map(c => c.title)
    .slice(0, 5);
}

function isRelevantImage(result, titleCandidates) {
  const tokens = new Set(tokenizeSearchText(`${result.url} ${result.page} ${result.title}`));
  if (!tokens.size) return false;

  return titleCandidates.some(title => {
    const words = tokenizeSearchText(title).filter(w => w.length >= 3);
    if (!words.length) return false;
    return words.every(w => tokens.has(w));
  });
}

async function bingImageSearch(query, maxPages = 3) {
  const results = [];
  const seen = new Set();
  for (let page = 0; page < maxPages; page++) {
    const first = page * 35;
    const url = `https://www.bing.com/images/async?q=${encodeURIComponent(query)}&first=${first}&count=35&scenario=ImageBasicHover`;
    try {
      const html = await fetchText(url);
      for (const r of parseBingImageResults(html)) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        results.push(r);
      }
    } catch (e) {
      debugScraper('bing:page-error', { first, error: e?.message || String(e) });
    }
    if (results.length >= 90) break;
  }
  return results;
}

function extFromContentType(contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('png'))  return '.png';
  if (ct.includes('webp')) return '.webp';
  if (ct.includes('gif'))  return '.gif';
  if (ct.includes('bmp'))  return '.bmp';
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg';
  return '.jpg';
}

function extFromUrl(url) {
  try {
    const pathname = new URL(url).pathname || '';
    const ext = path.extname(pathname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) return ext;
  } catch {}
  return '.jpg';
}

// Detecta el formato real por los primeros bytes (algunos CDN no envían
// Content-Type o envían application/octet-stream).
function sniffImageExtension(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);

    if (head[0] === 0xFF && head[1] === 0xD8) return '.jpg';
    if (head.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return '.png';
    if (head.slice(0, 4).toString('ascii') === 'RIFF' && head.slice(8, 12).toString('ascii') === 'WEBP') return '.webp';
    if (head.slice(0, 3).toString('ascii') === 'GIF') return '.gif';
    if (head.slice(0, 2).toString('ascii') === 'BM') return '.bmp';
  } catch {}
  return '';
}

function downloadImageFile(url, destPath, referer = '', redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const req = https.get(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        Referer: referer || 'https://www.bing.com/',
      },
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        file.close();
        try { fs.unlinkSync(destPath); } catch {}
        if (redirectCount >= 5) return reject(new Error('Too many redirects'));
        const location = res.headers.location;
        if (!location) return reject(new Error('Redirect without Location header'));
        const nextUrl = new URL(location, url).toString();
        return downloadImageFile(nextUrl, destPath, referer, redirectCount + 1).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(destPath); } catch {}
        return reject(new Error(`HTTP ${res.statusCode}`));
      }

      const contentType = String(res.headers['content-type'] || '').toLowerCase();
      const maybeImage = !contentType
        || contentType.startsWith('image/')
        || contentType.includes('octet-stream');
      if (!maybeImage) {
        file.close();
        try { fs.unlinkSync(destPath); } catch {}
        return reject(new Error(`Invalid content-type: ${contentType}`));
      }

      let totalBytes = 0;
      res.on('data', chunk => { totalBytes += chunk.length; });
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          if (totalBytes < 1024) {
            try { fs.unlinkSync(destPath); } catch {}
            return reject(new Error('Image too small'));
          }

          const sniffed = sniffImageExtension(destPath);
          if (!contentType.startsWith('image/') && !sniffed) {
            try { fs.unlinkSync(destPath); } catch {}
            return reject(new Error('El archivo descargado no es una imagen'));
          }

          resolve({
            contentType,
            ext: sniffed || extFromContentType(contentType),
            bytes: totalBytes,
          });
        });
      });
    });

    req.on('error', e => {
      file.close();
      try { fs.unlinkSync(destPath); } catch {}
      reject(e);
    });
    req.setTimeout(8000, () => {
      req.destroy();
      file.close();
      try { fs.unlinkSync(destPath); } catch {}
      reject(new Error('Timeout'));
    });
  });
}

function fetchText(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          if (redirectCount >= 5) return reject(new Error('Too many redirects'));
          const location = res.headers.location;
          if (!location) return reject(new Error('Redirect without Location header'));
          const nextUrl = new URL(location, url).toString();
          return fetchText(nextUrl, redirectCount + 1).then(resolve).catch(reject);
        }

        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          const snippet = body.slice(0, 180).replace(/\s+/g, ' ');
          return reject(new Error(`HTTP ${res.statusCode}: ${snippet || 'respuesta vacia'}`));
        }
        resolve(body);
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Timeout')); });
  });
}

ipcMain.handle('scraper:fetch-google-images', async (_, { game, systemFolder }) => {
  const baseName = stripTempRomPrefix(
    path.basename(game?.name || game?.path || '', path.extname(game?.name || game?.path || '')),
  ) || 'game';
  const isArcade = /^(mame|fba|fbneo|arcade|neogeo|naomi|atomiswave|cps|daphne|model2|model3)/i
    .test(String(systemFolder || ''));
  const query = `${baseName} ${systemFolder || ''} ${isArcade ? 'arcade flyer' : 'box art'}`
    .replace(/\s+/g, ' ')
    .trim();
  debugScraper('images:search:start', { query, gamePath: game?.path || null });

  try {
    // 1. Bing Images: su HTML incluye las URLs originales de las imágenes.
    //    Google ya no las expone sin ejecutar JavaScript, así que es el fallback.
    const results = await bingImageSearch(query, 3);

    // En arcade a veces no hay flyer indexado; se refuerza con "box art".
    if (isArcade && results.length < 20) {
      const extra = await bingImageSearch(`${baseName} arcade box art`, 2);
      const seen = new Set(results.map(r => r.url));
      for (const r of extra) {
        if (seen.has(r.url)) continue;
        seen.add(r.url);
        results.push(r);
      }
    }

    if (results.length < 10) {
      const searchUrls = [
        `https://www.google.com/search?tbm=isch&hl=es&q=${encodeURIComponent(query)}`,
        `https://www.google.com/search?tbm=isch&hl=es&start=20&q=${encodeURIComponent(query)}`,
      ];
      const seen = new Set(results.map(r => r.url));
      for (const searchUrl of searchUrls) {
        try {
          const html = await fetchText(searchUrl);
          extractGoogleImageUrls(html).forEach(u => {
            if (seen.has(u)) return;
            seen.add(u);
            results.push({ url: u, title: '', page: '' });
          });
        } catch (e) {
          debugScraper('google:search:error', { error: e?.message || String(e) });
        }
        if (results.length >= 60) break;
      }
    }

    if (!results.length) {
      debugScraper('images:search:none', { query });
      return { ok: false, error: 'Sin resultados de imágenes para esta búsqueda' };
    }

    // 2. Priorizar imágenes que de verdad correspondan al juego y sean portadas.
    //    El resto queda como reserva por si las primeras no se pueden descargar.
    const titleCandidates = deriveTitleCandidates(results, baseName);
    const relevant = results.filter(r => isRelevantImage(r, titleCandidates));
    const relevantSet = new Set(relevant);
    const byScore = (a, b) => scoreImageCandidate(b) - scoreImageCandidate(a);
    const pool = [
      ...relevant.slice().sort(byScore),
      ...results.filter(r => !relevantSet.has(r)).sort(byScore),
    ];

    debugScraper('images:search:results', {
      query,
      total: results.length,
      relevant: relevant.length,
      titles: titleCandidates,
    });

    // 3. Descargar hasta 5 opciones a %TEMP%
    const options = [];
    let attempts = 0;
    for (const item of pool) {
      if (options.length >= 5 || attempts >= 40) break;
      attempts += 1;
      const tmpBase = path.join(os.tmpdir(), `scrape_img_${Date.now()}_${attempts}`);
      const srcUrl = item.url.replace(/^http:\/\//i, 'https://');
      const tmp = tmpBase + extFromUrl(srcUrl);
      try {
        const { ext: realExt } = await downloadImageFile(srcUrl, tmp, item.page);
        let finalPath = tmp;
        if (realExt !== path.extname(tmp).toLowerCase()) {
          const renamed = tmpBase + realExt;
          try { fs.renameSync(tmp, renamed); finalPath = renamed; }
          catch { finalPath = tmp; }
        }
        options.push({
          localImage: finalPath,
          imageExt: path.extname(finalPath).toLowerCase() || realExt,
          sourceUrl: item.url,
        });
      } catch (e) {
        debugScraper('images:download-skip', {
          reason: e?.message || String(e),
          sourceUrl: item.url.slice(0, 180),
        });
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
      }
    }

    if (!options.length) {
      debugScraper('images:download-failed', { query, candidates: pool.length, attempts });
      return { ok: false, error: 'No se pudieron descargar imágenes. Prueba otro nombre.' };
    }

    debugScraper('images:search:ok', { query, options: options.length, candidates: pool.length, attempts });
    return { ok: true, query, options, titles: titleCandidates };
  } catch (e) {
    debugScraper('images:search:error', { query, error: e?.message || String(e) });
    return { ok: false, error: `Búsqueda de imágenes: ${e.message}` };
  }
});

// ── Wikipedia: metadata de videojuegos (gratis y sin credenciales) ───────────
// Se usa como fuente principal del "Buscar portada" → rellenar campos.
// El nombre de la ROM suele ser un código corto (strhoop); deriveTitleCandidates
// propone el título real ("Street Hoop") antes de consultar Wikipedia.

function findTemplateEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === '{' && text[i + 1] === '{') { depth += 1; i += 1; continue; }
    if (text[i] === '}' && text[i + 1] === '}') { depth -= 1; i += 1; if (depth === 0) return i + 1; }
  }
  return -1;
}

function splitTopLevelParams(body) {
  const parts = [];
  let braces = 0;
  let brackets = 0;
  let current = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{' && body[i + 1] === '{') { braces += 1; current += '{{'; i += 1; continue; }
    if (c === '}' && body[i + 1] === '}') { braces -= 1; current += '}}'; i += 1; continue; }
    if (c === '[' && body[i + 1] === '[') { brackets += 1; current += '[['; i += 1; continue; }
    if (c === ']' && body[i + 1] === ']') { brackets -= 1; current += ']]'; i += 1; continue; }
    if (c === '|' && braces === 0 && brackets === 0) { parts.push(current); current = ''; continue; }
    current += c;
  }
  parts.push(current);
  return parts;
}

function flattenCollapsibleLists(value) {
  let text = String(value || '');
  for (let i = 0; i < 5; i++) {
    const match = text.match(/\{\{\s*(?:collapsible list|lista colapsable|listacolapsable)\s*\|/i);
    if (!match) break;
    const start = match.index;
    const end = findTemplateEnd(text, start);
    if (end < 0) break;

    const body = text.slice(start + 2, end - 2);
    const values = splitTopLevelParams(body)
      .slice(1) // el primer trozo es el nombre de la plantilla
      .filter(part => !/^\s*[\wáéíóúñ ]+\s*=/i.test(part))
      .join(', ')
      .trim();

    text = text.slice(0, start) + values + text.slice(end);
  }
  return text;
}

function stripWikiMarkup(value) {
  let text = flattenCollapsibleLists(value);

  text = text
    .replace(/<ref[^>]*\/>/gi, ' ')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, ' ');

  for (let i = 0; i < 5; i++) text = text.replace(/\{\{[^{}]*\}\}/g, ' ');

  text = text
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/\[https?:\/\/[^\s\]]+\s*([^\]]*)\]/g, '$1')
    .replace(/<br\s*\/?>/gi, ', ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/'''?/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\{\{|\}\}/g, ' ')
    .replace(/\|/g, ' ')
    .replace(/\s+,/g, ',')
    .replace(/\s+/g, ' ')
    .replace(/^[,;\s]+|[,;\s]+$/g, '');

  return text.trim();
}

function parseGameInfobox(wikitext) {
  const start = wikitext.search(/\{\{\s*(ficha de videojuego|infobox video game|infobox vg|videojuego)/i);
  if (start < 0) return {};
  const end = findTemplateEnd(wikitext, start);
  if (end < 0) return {};

  const params = {};
  for (const part of splitTopLevelParams(wikitext.slice(start + 2, end - 2)).slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    if (!key) continue;
    params[key] = part.slice(eq + 1).trim();
  }
  return params;
}

function pickInfoboxField(params, keys) {
  for (const key of keys) {
    if (!params[key]) continue;
    const clean = stripWikiMarkup(params[key]);
    if (clean) return clean;
  }
  return '';
}

function firstYearIn(text) {
  const m = String(text || '').match(/\b(19[5-9]\d|20[0-3]\d)\b/);
  return m ? m[1] : '';
}

function infoboxYear(params) {
  const raw = ['lanzamiento', 'released', 'fecha', 'release date', 'año', 'year']
    .map(k => params[k])
    .filter(Boolean)
    .join(' ');
  return firstYearIn(raw);
}

// Cliente HTTP para la API de Wikipedia: User-Agent identificable, caché en
// memoria y un reintento ante 429 (límite de peticiones de Wikimedia).
const WIKI_UA = 'r36s-manager/1.0 (EmulationStation ROM manager; desktop app)';
const WIKI_COOLDOWN_MS = 60_000;
const wikiCache = new Map();
let wikiLastRequestAt = 0;
let wikiCooldownUntil = 0;

function fetchJsonWithHeaders(url, headers, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 15000, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
          if (redirects >= 5 || !res.headers.location) return reject(new Error('Redirect sin destino'));
          return fetchJsonWithHeaders(new URL(res.headers.location, url).toString(), headers, redirects + 1)
            .then(resolve).catch(reject);
        }

        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          const error = new Error(`HTTP ${res.statusCode}: ${body.slice(0, 120).replace(/\s+/g, ' ')}`);
          error.statusCode = res.statusCode;
          return reject(error);
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`Respuesta inválida: ${e.message}`)); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('Timeout')); });
  });
}

async function wikiRequest(url) {
  if (wikiCache.has(url)) return wikiCache.get(url);

  if (Date.now() < wikiCooldownUntil) {
    const error = new Error('Wikipedia limitó las peticiones temporalmente');
    error.rateLimited = true;
    throw error;
  }

  const wait = 200 - (Date.now() - wikiLastRequestAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  wikiLastRequestAt = Date.now();

  try {
    const json = await fetchJsonWithHeaders(url, {
      'User-Agent': WIKI_UA,
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
    });
    wikiCache.set(url, json);
    return json;
  } catch (e) {
    if (e.statusCode === 429) {
      // Wikimedia pide bajar el ritmo: se detiene la consulta durante un minuto
      wikiCooldownUntil = Date.now() + WIKI_COOLDOWN_MS;
      e.rateLimited = true;
    }
    throw e;
  }
}

async function wikiSearchTitles(lang, query) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search`
    + `&srsearch=${encodeURIComponent(query)}&format=json&srlimit=5&srnamespace=0`;
  const json = await wikiRequest(url);
  return json?.query?.search || [];
}

// Una sola petición por artículo: extracto introductorio + wikitexto (infobox).
async function wikiGameInfo(lang, title) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts|revisions`
    + `&exintro=1&explaintext=1&rvprop=content&rvslots=main`
    + `&format=json&formatversion=2&titles=${encodeURIComponent(title)}`;
  const json = await wikiRequest(url);
  const page = json?.query?.pages?.[0];
  if (!page || page.missing) return null;

  const desc = String(page.extract || '').trim();
  const wikitext = page.revisions?.[0]?.slots?.main?.content || '';
  const params = parseGameInfobox(wikitext);

  return {
    lang,
    title: page.title || title,
    desc,
    year: infoboxYear(params) || firstYearIn(desc),
    developer: pickInfoboxField(params, ['desarrollador', 'developer', 'desarrollado por']),
    publisher: pickInfoboxField(params, ['editor', 'publisher', 'editado por', 'distribuidor']),
    genre: pickInfoboxField(params, ['género', 'genero', 'genre']),
  };
}

// Busca un candidato en Wikipedia (es → en) validando que sea un videojuego.
async function lookupWikipediaGame(candidate) {
  const candidateNorm = normSearchText(candidate);
  if (!candidateNorm) return null;

  // Primero el nombre tal cual (cubre la mayoría); el sufijo solo si hace falta.
  const attempts = [
    { lang: 'es', query: candidate },
    { lang: 'en', query: candidate },
    { lang: 'es', query: `${candidate} videojuego` },
    { lang: 'en', query: `${candidate} video game` },
  ];

  for (const { lang, query } of attempts) {
    let hits;
    try { hits = await wikiSearchTitles(lang, query); }
    catch (e) {
      if (e.rateLimited) throw e; // detiene toda la consulta
      debugScraper('wiki:search-error', { lang, query, error: e?.message });
      continue;
    }

    for (const hit of hits) {
      const snippet = `${hit?.snippet || ''} ${hit?.title || ''}`;
      if (!/videojuego|video game|arcade|recreativa/i.test(snippet)) continue;

      let info;
      try { info = await wikiGameInfo(lang, hit.title); }
      catch (e) {
        if (e.rateLimited) throw e;
        debugScraper('wiki:page-error', { lang, title: hit.title, error: e?.message });
        continue;
      }
      if (!info) continue;

      const pageText = normSearchText(`${info.title} ${info.desc}`);
      const titleNorm = normSearchText(info.title);
      const related = pageText.includes(candidateNorm)
        || (titleNorm && candidateNorm.includes(titleNorm))
        || titleNorm.includes(candidateNorm);

      if (related && (info.desc || info.developer || info.genre || info.year)) return info;
    }
  }
  return null;
}

// ── IPC: scraper:fetch-game-info — rellena metadata del juego (Wikipedia) ────
ipcMain.handle('scraper:fetch-game-info', async (_, { game, systemFolder }) => {
  const baseName = stripTempRomPrefix(
    path.basename(game?.name || game?.path || '', path.extname(game?.name || game?.path || '')),
  ) || '';
  debugScraper('game-info:start', { baseName, systemFolder });

  const toMeta = info => {
    const meta = {};
    if (info.desc)      meta.desc      = info.desc.slice(0, 1200);
    if (info.year)      meta.year      = info.year;
    if (info.genre)     meta.genre     = info.genre;
    if (info.developer) meta.developer = info.developer;
    if (info.publisher) meta.publisher = info.publisher;
    return meta;
  };

  try {
    const displayName = game?.name ? String(game.name).replace(/\.[^.]+$/, '').trim() : '';
    const isArcade = /^(mame|fba|fbneo|arcade|neogeo|naomi|atomiswave|cps|daphne|model2|model3)/i
      .test(String(systemFolder || ''));
    const directCandidates = [...new Set([baseName, displayName])].filter(Boolean);

    // Los códigos cortos de arcade (strhoop, hsf2…) no existen en Wikipedia:
    // se deduce primero el título real desde las imágenes.
    const tryDirect = !isArcade || /\s/.test(baseName);

    if (tryDirect) {
      // 1. Primer intento con el nombre tal cual (rápido y sin búsquedas extra).
      for (const candidate of directCandidates) {
        const info = await lookupWikipediaGame(candidate);
        if (!info) continue;
        debugScraper('game-info:ok', { candidate, source: `${info.lang}:${info.title}` });
        return { ok: true, meta: toMeta(info), source: { site: 'wikipedia', lang: info.lang, title: info.title } };
      }
    }

    // 2. Deducción del título real a partir de los resultados de imágenes.
    let altTitles = [];
    if (Date.now() >= wikiCooldownUntil) {
      try {
        const imageResults = await bingImageSearch(
          `${baseName} ${systemFolder || ''} arcade`.replace(/\s+/g, ' ').trim(),
          2,
        );
        altTitles = deriveTitleCandidates(imageResults, baseName);
      } catch (e) {
        debugScraper('game-info:bing-error', { error: e?.message });
      }
    }

    const altCandidates = [...new Set(altTitles)]
      .map(c => String(c || '').replace(/\.[^.]+$/, '').trim())
      .filter(c => c && c.toLowerCase() !== baseName.toLowerCase())
      .slice(0, 4);

    for (const candidate of altCandidates) {
      const info = await lookupWikipediaGame(candidate);
      if (!info) continue;
      debugScraper('game-info:ok', { candidate, source: `${info.lang}:${info.title}` });
      return { ok: true, meta: toMeta(info), source: { site: 'wikipedia', lang: info.lang, title: info.title } };
    }

    // 3. Último intento directo (por si el nombre ya era correcto).
    if (Date.now() >= wikiCooldownUntil) {
      for (const candidate of directCandidates) {
        const info = await lookupWikipediaGame(candidate);
        if (!info) continue;
        debugScraper('game-info:ok', { candidate, source: `${info.lang}:${info.title}` });
        return { ok: true, meta: toMeta(info), source: { site: 'wikipedia', lang: info.lang, title: info.title } };
      }
    }

    debugScraper('game-info:none', { baseName, altCandidates });
    return { ok: false, error: 'Sin información para este título' };
  } catch (e) {
    debugScraper('game-info:error', { baseName, error: e?.message || String(e) });
    if (e.rateLimited) {
      return { ok: false, error: 'Wikipedia limitó las peticiones; reintenta en un minuto' };
    }
    return { ok: false, error: e.message };
  }
});

// ── IPC: scraper:fetch — busca en SS y descarga a temp local (NO sube a consola) ──
ipcMain.handle('scraper:fetch', async (_, { game, systemFolder }) => {
  debugScraper('fetch:start', {
    systemFolder,
    gamePath: game?.path || null,
    gameName: game?.name || null,
  });
  const settings = loadSettings();
  const ssUser   = settings.ssUser;
  const ssPass   = settings.ssPass;
  if (!ssUser || !ssPass) {
    debugScraper('fetch:missing-credentials');
    return { ok: false, needCredentials: true };
  }

  const systemId = ssSystemId(systemFolder);
  if (!systemId) {
    debugScraper('fetch:unsupported-system', { systemFolder });
    return { ok: false, error: `Sistema "${systemFolder}" no soportado` };
  }

  const romFileName = stripTempRomPrefix(path.basename(game.path || ''));
  const romName = path.basename(romFileName, path.extname(romFileName));

  // 1. Consultar API ScreenScraper
  let ssData;
  try {
    const res = await ssApiCall('jeuInfos.php', {
      devid: 'skyscraper', devpassword: 'skyscraper',
      softname: 'r36s-manager', output: 'json',
      ssid: ssUser, sspassword: ssPass,
      systemeid: systemId,
      romnom: romFileName,
    });
    ssData = res?.response?.jeu;
    if (!ssData) {
      debugScraper('fetch:not-found', { romName, systemId });
      return { ok: false, error: 'Juego no encontrado en ScreenScraper' };
    }
  } catch (e) {
    const msg = e?.message || String(e);
    const lower = msg.toLowerCase();
    const isAuthError =
      lower.includes('http 403') ||
      lower.includes('erreur de login') ||
      lower.includes('identifiants') ||
      lower.includes('forbidden');

    debugScraper('fetch:api-error', { message: msg, isAuthError });

    if (isAuthError) {
      return {
        ok: false,
        needCredentials: true,
        error: 'Credenciales no válidas o sesión rechazada por ScreenScraper',
      };
    }

    return { ok: false, error: `API: ${msg}` };
  }

  const medias  = ssData.medias || [];
  const result  = { ok: true, meta: {}, localImage: null, localVideo: null, romName };

  // Metadatos en español
  const desc = ssData.synopsis?.find(s => s.langue === 'es')?.text
             || ssData.synopsis?.find(s => s.langue === 'en')?.text || '';
  if (desc)                       result.meta.desc       = desc;
  if (ssData.nom)                 result.meta.name       = ssData.nom;
  if (ssData.dates?.monde?.text)  result.meta.releasedate = ssData.dates.monde.text.replace(/-/g, '');
  if (ssData.developpeur?.text)   result.meta.developer  = ssData.developpeur.text;
  if (ssData.editeur?.text)       result.meta.publisher  = ssData.editeur.text;
  if (ssData.joueurs?.text)       result.meta.players    = ssData.joueurs.text;
  if (ssData.note?.text)          result.meta.rating     = (parseFloat(ssData.note.text) / 20).toFixed(2);
  if (ssData.genres?.length)      result.meta.genre      = ssData.genres[0]?.noms?.find(n => n.langue === 'es')?.text
                                                         || ssData.genres[0]?.noms?.[0]?.text || '';

  // 2. Descargar imagen a temp local
  for (const imgType of ['box-2D', 'mixrbv1', 'screenshot', 'title-screen']) {
    const media = pickMedia(medias, imgType);
    if (!media?.url) continue;
    const ext     = '.' + (media.format || 'png');
    const tmpPath = path.join(os.tmpdir(), `ss_preview_img_${Date.now()}${ext}`);
    try {
      await downloadFile(media.url, tmpPath);
      result.localImage = tmpPath;
      result.imageExt   = ext;
      break;
    } catch {}
  }

  // 3. Descargar video a temp local
  const video = pickMedia(medias, 'video');
  if (video?.url) {
    const ext     = '.' + (video.format || 'mp4');
    const tmpPath = path.join(os.tmpdir(), `ss_preview_vid_${Date.now()}${ext}`);
    try {
      await downloadFile(video.url, tmpPath);
      result.localVideo = tmpPath;
      result.videoExt   = ext;
    } catch {}
  }

  if (!result.localImage && !result.localVideo && !Object.keys(result.meta).length)
    return { ok: false, error: 'Sin assets disponibles' };

  return result;
});

// ── IPC: scraper:commit — sube los archivos temp a la consola y actualiza XML ──
ipcMain.handle('scraper:commit', async (_, { game, localImage, localVideo, imageExt, videoExt, meta }) => {
  if (!sshConnected) return { ok: false, error: 'SSH no conectado' };

  const romName   = stripTempRomPrefix(path.basename(game.path || '', path.extname(game.path || '')));
  const imagesDir = `${game.systemPath}/images`;
  const videosDir = `${game.systemPath}/videos`;
  const updates   = { ...meta };

  // EmulationStation usa <releasedate> con formato YYYYMMDDTHHMMSS
  if (updates.year && !updates.releasedate) {
    const year = String(updates.year).trim();
    updates.releasedate = /^\d{4}$/.test(year) ? `${year}0101T000000` : year;
    delete updates.year;
  }

  // Subir imagen
  if (localImage && fs.existsSync(localImage)) {
    const remotePath = `${imagesDir}/${romName}${imageExt}`;
    try {
      await ssh.execCommand(`mkdir -p "${imagesDir}"`);
      await ssh.putFile(localImage, remotePath);
      updates.image = `./images/${romName}${imageExt}`;
    } catch (e) { return { ok: false, error: `Error subiendo imagen: ${e.message}` }; }
    finally { try { fs.unlinkSync(localImage); } catch {} }
  }

  // Subir video
  if (localVideo && fs.existsSync(localVideo)) {
    const remotePath = `${videosDir}/${romName}${videoExt}`;
    try {
      await ssh.execCommand(`mkdir -p "${videosDir}"`);
      await ssh.putFile(localVideo, remotePath);
      updates.video = `./videos/${romName}${videoExt}`;
    } catch (e) { /* video falla silenciosamente */ }
    finally { try { fs.unlinkSync(localVideo); } catch {} }
  }

  if (!Object.keys(updates).length) return { ok: false, error: 'Nada que actualizar' };

  // Actualizar gamelist.xml en la consola via Python (misma lógica que set-favorite)
  const xmlPath     = `${game.systemPath}/gamelist.xml`;
  const updatesJson = JSON.stringify(updates);

  const pyScript = `
import re, json

xml_path  = """${xmlPath}"""
game_path = """${game.path}"""
updates   = json.loads("""${updatesJson.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')}""")

with open(xml_path, 'r', encoding='utf-8') as f:
    xml = f.read()

blocks = re.split(r'(?=<game[\\s>])', xml)
result = []
found  = False

for block in blocks:
    if not block.strip().startswith('<game'):
        result.append(block)
        continue
    basename = game_path.rstrip('/').split('/')[-1]
    pm = re.search(r'<path>([^<]+)</path>', block)
    if pm:
        p = pm.group(1).strip()
        if p == game_path or p.endswith('/' + basename) or p.endswith(basename):
            found = True
            for tag, val in updates.items():
                val_esc = str(val).replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
                if '<' + tag + '>' in block:
                    block = re.sub(r'<' + tag + r'>[^<]*</' + tag + r'>',
                                   '<' + tag + '>' + val_esc + '</' + tag + '>', block)
                else:
                    block = re.sub(r'(<path>[^<]*</path>)',
                                   r'\\1\\n\\t\\t<' + tag + '>' + val_esc + '</' + tag + '>',
                                   block, count=1)
    result.append(block)

if found:
    with open(xml_path, 'w', encoding='utf-8') as f:
        f.write(''.join(result))
    print('ok')
else:
    print('not_found')
`;

  const tmpPy    = path.join(os.tmpdir(), `ss_commit_${Date.now()}.py`);
  const remotePy = `/tmp/ss_commit_${Date.now()}.py`;
  fs.writeFileSync(tmpPy, pyScript, 'utf8');
  await ssh.putFile(tmpPy, remotePy);
  fs.unlinkSync(tmpPy);
  const pyRes = await ssh.execCommand(`python3 "${remotePy}"; rm -f "${remotePy}"`);

  if (pyRes.stdout.trim() !== 'ok')
    return { ok: false, error: `XML no actualizado: ${pyRes.stdout.trim()} ${pyRes.stderr.trim()}` };

  return { ok: true, updates };
});

// ── IPC: scraper:cancel — borra archivos temporales si el usuario cancela ────
ipcMain.handle('scraper:cancel', (_, { localImage, localVideo, localImages }) => {
  try { if (localImage) fs.unlinkSync(localImage); } catch {}
  try { if (localVideo) fs.unlinkSync(localVideo); } catch {}
  (Array.isArray(localImages) ? localImages : []).forEach(p => {
    try { if (p) fs.unlinkSync(p); } catch {}
  });
  return { ok: true };
});

ipcMain.handle('app:config-dir', () => CONFIG_DIR);