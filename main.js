// DeepSeek Harness — Electron main process.
// Frameless window (native caption buttons) with the DSH UI in a child WebContentsView.
// Features: hidden dsh server console, system tray (close hides to tray, tray "quit"
// stops the dsh server), silent auto-update of the dsh package from npm.
const { app, BrowserWindow, WebContentsView, Tray, Menu, nativeImage, shell } = require('electron');
const { spawn, execFile } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const URL = 'http://127.0.0.1:3080';
const TITLEBAR_HEIGHT = 40;

// dsh CLI lives at the stable global prefix %APPDATA%\npm (path survives updates).
const APPDATA = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
const DSH_CMD = path.join(APPDATA, 'npm', 'dsh.cmd');
const DSH_PKG = path.join(APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');

// Keep everything under %LOCALAPPDATA%\DeepSeek Harness (whale icon, npm cache, logs).
const APP_DIR = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'DeepSeek Harness');
app.setPath('userData', path.join(APP_DIR, 'electron-data'));
const ICON = path.join(APP_DIR, 'whale.ico');
const NPM_CACHE = path.join(APP_DIR, 'npm-cache');
const UPDATE_LOG = path.join(APP_DIR, 'updater.log');
const APP_ID = 'com.deepseek.harness.desktop';
app.setAppUserModelId(APP_ID);

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
    const req = http.get(URL, (res) => {
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
    // Run the .cmd shim through cmd.exe with a HIDDEN console.
    // NOTE: no `detached: true` — on Windows that forces a visible console
    // window ("the child will have its own console window"), which windowsHide
    // cannot suppress. The server runs while the app lives in the tray and is
    // stopped explicitly on tray quit.
    const child = spawn('cmd.exe', ['/c', DSH_CMD, 'web'], {
      stdio: 'ignore',
      windowsHide: true, // no console window
    });
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
  const nodeDir = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs');
  const nodeExe = path.join(nodeDir, 'node.exe');
  const npmCli = path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const viaCli = fs.existsSync(nodeExe) && fs.existsSync(npmCli);
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
      await runNpm(['install', '-g', '@deepseek-ai/dsh@' + latest, '--cache', NPM_CACHE]);
      log('installed ' + latest + ' (takes effect on next server start)');
    }
  } catch (err) {
    log('update check failed: ' + err.message);
  }
}

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
  view.webContents.loadURL(URL);

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
  const alreadyUp = await isUp();
  if (!alreadyUp) {
    // Fresh start (no server yet): update first so the server boots on the newest version.
    await checkForUpdates();
  }
  await ensureServer();
  createWindow();
  createTray();
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
