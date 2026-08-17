// DeepSeek Harness — Electron main process.
// Frameless window (native caption buttons) with the DSH UI in a child WebContentsView.
// Features: hidden dsh server console, system tray (close hides to tray, tray "quit"
// stops the dsh server), silent auto-update of the dsh package from npm.
const { app, BrowserWindow, WebContentsView, Tray, Menu, nativeImage, shell, ipcMain } = require('electron');
const { spawn, execFile } = require('child_process');
const http = require('http');
const https = require('https');
const { URL } = require('url'); // explicit import: the module-level DSH_URL const shadows the global URL
const path = require('path');
const fs = require('fs');

const DSH_URL = 'http://127.0.0.1:3080';
const TITLEBAR_HEIGHT = 40;

// Bundled runtime (Node.js + dsh CLI) ships inside the app under resources\runtime
// (packaged) or <app dir>\runtime (dev); falls back to the global npm install if
// the bundle is absent.
const APPDATA = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
function resolveRuntime() {
  const candidates = [
    path.join(process.resourcesPath || '', 'runtime'),
    path.join(__dirname, 'runtime'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'node', 'node.exe'))) return c;
  }
  return null;
}
const RUNTIME = resolveRuntime();
const NODE_EXE = RUNTIME
  ? path.join(RUNTIME, 'node', 'node.exe')
  : path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe');
const NPM_CLI = RUNTIME
  ? path.join(RUNTIME, 'node', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  : path.join(path.dirname(NODE_EXE), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const DSH_DIR = RUNTIME
  ? path.join(RUNTIME, 'dsh')
  : path.join(APPDATA, 'npm');
const DSH_PKG = path.join(DSH_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'package.json');

// Keep everything under %LOCALAPPDATA%\DeepSeek Harness (whale icon, npm cache, logs).
const APP_DIR = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'DeepSeek Harness');
app.setPath('userData', path.join(APP_DIR, 'electron-data'));
const ICON = path.join(APP_DIR, 'whale.ico');
const NPM_CACHE = path.join(APP_DIR, 'npm-cache');
const UPDATE_LOG = path.join(APP_DIR, 'updater.log');
const APP_ID = 'com.deepseek.harness.desktop';
app.setAppUserModelId(APP_ID);

// ---------- single instance ----------
// Only one instance may run: a second launch quits itself and focuses the
// existing window, so no extra processes and no extra server/ports are created.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => { showWindow(); });
}

// Self-update source: this GitHub repo (version comes from the main branch package.json).
const REPO = 'TAP-APIA/deepseek-harness-desktop';
const VERSION_URL = 'https://raw.githubusercontent.com/' + REPO + '/main/package.json';
const RELEASES_API = 'https://api.github.com/repos/' + REPO + '/releases/latest';
const UPDATES_DIR = path.join(APP_DIR, 'updates');

let win = null;
let view = null;
let tray = null;
let isQuitting = false;
let serverChild = null; // the dsh server process tree this app started (cmd.exe root PID)

// ---------- logging ----------
function log(msg) {
  try { fs.appendFileSync(UPDATE_LOG, new Date().toISOString() + '  ' + msg + '\n'); } catch (e) { /* ignore */ }
  console.log(msg);
}

// ---------- server ----------
function isUp() {
  return new Promise((resolve) => {
    const req = http.get(DSH_URL, (res) => {
      resolve(res.statusCode === 200);
      req.destroy();
    });
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function ensureServer() {
  if (await isUp()) return;
  try {
    // Run the dsh server with a HIDDEN console (no detached:true — on Windows that
    // forces a visible console window). The server runs while the app lives in the
    // tray and is stopped explicitly on tray quit.
    let child;
    if (RUNTIME && fs.existsSync(path.join(DSH_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) {
      // bundled runtime: node.exe <dsh>/lib/bin.js web
      child = spawn(NODE_EXE, [path.join(DSH_DIR, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), 'web'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } else {
      // fallback: global dsh.cmd shim via cmd.exe
      child = spawn('cmd.exe', ['/c', path.join(APPDATA, 'npm', 'dsh.cmd'), 'web'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    }
    serverChild = child;
  } catch (err) {
    log('failed to start dsh web: ' + err.message);
  }
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await isUp()) return;
  }
}

// Stop the dsh server tree this app started (only that tree, never unrelated node processes).
function killServer() {
  if (serverChild && serverChild.pid) {
    try {
      spawn('taskkill', ['/PID', String(serverChild.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      log('dsh server stopped (app quit)');
    } catch (err) {
      log('failed to stop dsh server: ' + err.message);
    }
    serverChild = null;
  }
}

// ---------- icon ----------
// The whale icon ships inside the app bundle (dev dir or app.asar); copy it into
// APP_DIR once so the tray/window icons work even though ICON points at APP_DIR.
function ensureIcon() {
  try {
    const bundled = path.join(__dirname, 'whale.ico');
    if (!fs.existsSync(ICON) && fs.existsSync(bundled)) {
      fs.mkdirSync(APP_DIR, { recursive: true });
      fs.copyFileSync(bundled, ICON);
      log('icon copied to ' + ICON);
    }
  } catch (err) {
    log('icon copy failed: ' + err.message);
  }
}

// ---------- tray ----------
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const img = fs.existsSync(ICON) ? nativeImage.createFromPath(ICON) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('DeepSeek Harness');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 DeepSeek Harness', click: showWindow },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

// ---------- auto update (silent) ----------
function readInstalledVersion() {
  try {
    return JSON.parse(fs.readFileSync(DSH_PKG, 'utf8')).version;
  } catch (e) {
    return null;
  }
}

// Returns true when `latest` is a newer release than `installed` (semver-ish, rc-aware).
function isNewer(latest, installed) {
  const base = (v) => v.replace(/-.*$/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pre = (v) => v.indexOf('-') !== -1;
  const a = base(latest);
  const b = base(installed);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  if (pre(latest) && !pre(installed)) return false; // rc < stable
  if (!pre(latest) && pre(installed)) return true; // stable > rc
  const ra = parseInt((latest.match(/\d+$/) || ['0'])[0], 10);
  const rb = parseInt((installed.match(/\d+$/) || ['0'])[0], 10);
  return ra > rb;
}

function runNpm(args) {
  // Run npm through node.exe + npm-cli.js (spawning npm.cmd directly is EINVAL on modern Node).
  const nodeExe = NODE_EXE;
  const npmCli = NPM_CLI;
  const viaCli = nodeExe && npmCli && fs.existsSync(nodeExe) && fs.existsSync(npmCli);
  const bin = viaCli ? nodeExe : 'npm.cmd';
  const fullArgs = viaCli ? [npmCli].concat(args) : args;
  const opts = { windowsHide: true, timeout: 240000, maxBuffer: 8 * 1024 * 1024 };
  if (!viaCli) opts.shell = true; // fallback: npm.cmd via shell
  return new Promise((resolve, reject) => {
    execFile(bin, fullArgs, opts, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || stdout || err.message).slice(0, 500)));
      else resolve(String(stdout).trim());
    });
  });
}

async function checkForUpdates() {
  try {
    const latest = await runNpm(['view', '@deepseek-ai/dsh', 'version', '--cache', NPM_CACHE]);
    const installed = readInstalledVersion();
    log('check: latest=' + latest + ' installed=' + installed);
    if (latest && installed && isNewer(latest, installed)) {
      log('update found, installing ' + latest);
      if (RUNTIME) {
        // bundled dsh: update in place under the app's runtime dir
        await runNpm(['install', '@deepseek-ai/dsh@' + latest, '--prefix', DSH_DIR, '--cache', NPM_CACHE]);
      } else {
        await runNpm(['install', '-g', '@deepseek-ai/dsh@' + latest, '--cache', NPM_CACHE]);
      }
      log('installed ' + latest + ' (takes effect on next server start)');
    }
  } catch (err) {
    log('update check failed: ' + err.message);
  }
}

// ---------- self update (GitHub) ----------
// GitHub requests with a fake-ip/DNS-hijack workaround (e.g. Clash 198.18.x.x):
// try the system DNS first; on connection failure re-resolve the host via DoH
// (AliDNS 223.5.5.5, Cloudflare 1.1.1.1, Google 8.8.8.8) and retry the real IP.
const DOH_ENDPOINTS = [
  'https://223.5.5.5/resolve?name=HOST&type=A',
  'https://1.1.1.1/dns-query?name=HOST&type=A',
  'https://8.8.8.8/dns-query?name=HOST&type=A',
];

function dohResolve(hostname) {
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= DOH_ENDPOINTS.length) { resolve(null); return; }
      const url = DOH_ENDPOINTS[i++].replace('HOST', encodeURIComponent(hostname));
      https.get(url, { headers: { accept: 'application/dns-json' } }, (res) => {
        if (res.statusCode !== 200) { res.resume(); next(); return; }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const rec = (json.Answer || []).find((a) => a.type === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(a.data));
            resolve(rec ? rec.data : null);
          } catch (e) { next(); }
        });
      }).on('error', next);
    };
    next();
  });
}

// Follow redirects; each hop retries via a DoH-resolved real IP when the
// system-DNS route fails. Resolves with the final HTTP response.
function httpsGetSmart(url, headers, timeoutMs, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const hostname = new URL(url).hostname;
    let usedDoh = false;
    const run = (ip) => {
      const opts = { headers };
      if (ip) opts.lookup = (h, o, cb) => cb(null, ip, 4);
      const req = https.get(url, opts, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          resolve(httpsGetSmart(res.headers.location, headers, timeoutMs, redirectsLeft - 1));
          return;
        }
        resolve(res);
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
      req.on('error', (err) => {
        if (!usedDoh) {
          usedDoh = true;
          dohResolve(hostname).then((ip) => {
            if (ip) run(ip); else reject(err);
          });
        } else {
          reject(err);
        }
      });
    };
    run(null);
  });
}

// HTTPS GET that follows redirects (GitHub API/release URLs redirect often).
function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    httpsGetSmart(url, { 'User-Agent': 'deepseek-harness-desktop' }, 15000)
      .then((res) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; if (data.length > 2 * 1024 * 1024) res.destroy(); });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      })
      .catch(reject);
  });
}

// Stream a file from a (possibly redirecting) URL to disk.
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    httpsGetSmart(url, { 'User-Agent': 'deepseek-harness-desktop' }, 120000)
      .then((res) => {
        if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve(dest)));
        file.on('error', reject);
      })
      .catch(reject);
  });
}

// Compare the local app version with the repo's main branch; notify the title bar when newer.
let pendingUpdate = null; // latest version found, re-sent on page (re)load so the button never misses it

function sendUpdateAvailable() {
  if (win && !win.isDestroyed() && pendingUpdate) win.webContents.send('update-available', pendingUpdate);
}

async function checkForAppUpdates() {
  try {
    const remote = await httpsGetJson(VERSION_URL);
    const latest = remote && remote.version;
    const installed = app.getVersion();
    log('app update check: latest=' + latest + ' installed=' + installed);
    if (latest && installed && isNewer(latest, installed)) {
      log('app update available: ' + latest);
      pendingUpdate = { version: latest };
      sendUpdateAvailable();
    }
  } catch (err) {
    log('app update check failed: ' + err.message);
  }
}

// Download and install the update (release installer when available, repo zip otherwise).
async function performUpgrade() {
  try {
    let url = null;
    let fileName = null;
    try {
      const release = await httpsGetJson(RELEASES_API);
      const asset = release && release.assets && release.assets.find((a) => /\.exe$/i.test(a.name));
      if (asset) { url = asset.browser_download_url; fileName = asset.name; }
    } catch (err) {
      log('release lookup failed: ' + err.message);
    }
    if (!url) {
      // No release asset (e.g. no Release published yet): grab the source zip instead.
      url = 'https://codeload.github.com/' + REPO + '/zip/refs/heads/main';
      fileName = 'deepseek-harness-desktop-main.zip';
    }
    fs.mkdirSync(UPDATES_DIR, { recursive: true });
    const dest = path.join(UPDATES_DIR, fileName);
    log('downloading update: ' + url);
    await downloadFile(url, dest);
    log('update downloaded to ' + dest);
    if (/\.exe$/i.test(fileName)) {
      // Run the installer; the app quits so the installer can replace the files.
      spawn(dest, [], { detached: true, stdio: 'ignore' });
      app.quit();
    } else {
      shell.showItemInFolder(dest);
      log('no release installer found; source zip saved to ' + dest);
    }
  } catch (err) {
    log('upgrade failed: ' + err.message);
    if (win && !win.isDestroyed()) win.webContents.send('upgrade-failed');
  }
}

ipcMain.on('upgrade-requested', () => { performUpgrade(); });

// ---------- window ----------
function layoutView() {
  if (!win || !view) return;
  const [w, h] = win.getContentSize();
  view.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width: w, height: Math.max(0, h - TITLEBAR_HEIGHT) });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    // Hidden native title bar with the OS caption buttons overlaid on our white strip.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#ffffff',
      symbolColor: '#4b5563',
      height: TITLEBAR_HEIGHT,
    },
    backgroundColor: '#ffffff',
    show: false,
    title: 'DeepSeek Harness',
    icon: fs.existsSync(ICON) ? ICON : undefined,
    webPreferences: {
      // Trusted chrome only: the title bar HTML is ours.
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  // Close button hides to the tray instead of quitting (unless we are quitting).
  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.loadFile(path.join(__dirname, 'titlebar.html'));
  win.webContents.on('did-finish-load', sendUpdateAvailable); // re-send pending update on (re)load
  win.once('ready-to-show', () => win.show());

  // The DSH UI lives in a child view below the title bar.
  view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.contentView.addChildView(view);
  view.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url); // open external links in the system browser
    return { action: 'deny' };
  });
  view.webContents.loadURL(DSH_URL);

  layoutView();
  win.on('resize', layoutView);
  win.on('maximize', layoutView);
  win.on('unmaximize', layoutView);
}

// ---------- lifecycle ----------
app.on('before-quit', () => {
  isQuitting = true;
  killServer(); // tray "quit" (or system shutdown) stops the dsh server we started
});

app.whenReady().then(async () => {
  if (!gotTheLock) return; // second instance: quit was already requested
  const alreadyUp = await isUp();
  if (!alreadyUp) {
    // Fresh start (no server yet): update first so the server boots on the newest version.
    await checkForUpdates();
  }
  await ensureServer();
  ensureIcon();
  createWindow();
  createTray();
  checkForAppUpdates(); // GitHub self-update check (shows the title bar upgrade button)
  setInterval(checkForAppUpdates, 2 * 60 * 60 * 1000); // re-check every 2 hours
  if (alreadyUp) {
    // Server already running (e.g. harness session): silent background update for next start.
    checkForUpdates();
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Stay resident in the tray; the app only exits via the tray "quit".
app.on('window-all-closed', () => { /* keep running in the tray */ });
