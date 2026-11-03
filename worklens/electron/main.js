import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// Electron's `electron` module is a native hook, not a real file with analyzable source, so
// Node's ESM loader can't statically detect its named exports (`import { app } from 'electron'`
// silently resolves to an empty object) — a real CommonJS require(), which Electron's module
// loader intercepts correctly, is the reliable way to get the API from an ESM main process.
const require = createRequire(import.meta.url);
const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, safeStorage, shell } = require('electron');
const port = process.env.WORKLENS_PORT || 4317;
const samePath = (a, b) => path.resolve(a || '').toLowerCase() === path.resolve(b || '').toLowerCase();

// What the server already on the port says about itself (null when nothing answers, or when it's
// a build from before /api/version existed).
function runningBuild() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/version`, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { try { const v = JSON.parse(text); resolve(v.root ? v : { root: '' }); } catch { resolve({ root: '' }); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(1500, () => { req.destroy(); resolve(null); });
  });
}

// Another copy (an older install, or a dev run from the project folder) already owns the port:
// this window would show that copy's features, not this build's. Say so instead of hiding it.
function otherCopyMessage(build) {
  const where = build.root ? `It's running from:
${build.root}` : 'It is an older build of WorkLens.';
  return `Another copy of WorkLens is already running, so this one can't start and you'd be looking at the other copy's features.

${where}

Quit that copy (its tray icon → Quit WorkLens, or end electron.exe / WorkLens.exe in Task Manager), then open WorkLens again.`;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  // A second launch (e.g. a login-item start racing a manual double-click) should just focus
  // the window already running the server, not start a second server on the same port/DB —
  // unless the running copy is a different build, which would otherwise hide this one's changes.
  app.whenReady().then(async () => {
    const build = await runningBuild();
    if (build && !samePath(build.root, app.getAppPath())) dialog.showErrorBox('Another WorkLens is running', otherCopyMessage(build));
    app.quit();
  });
} else {
  let mainWindow = null;
  let tray = null;
  let serverStarted = false;

  // Route the server's data at a per-user, update-safe location instead of the install directory
  // (NSIS replaces the install directory's contents on update). The build is unpacked (no asar,
  // see package.json) specifically so powershell.exe — a separate OS process — can read the
  // collector/folder-picker scripts as real files, and so Node's ESM loader never has to resolve
  // a dynamic import() into an archive.
  process.env.WORKLENS_DATA_DIR = path.join(app.getPath('userData'), 'data');
  process.env.WORKLENS_SCRIPT_DIR = path.join(app.getAppPath(), 'src');

  // `npm start` gets OPENROUTER_API_KEY from Node's own `--env-file-if-exists=.env` CLI flag —
  // but Electron's main process is never invoked through that flag (dev: `electron .`; packaged:
  // WorkLens.exe launched by double-click or the login-item registration), so nothing was ever
  // loading a .env file here at all. The server code was fine; the desktop app just never handed
  // it a key, no matter what the user put in a project-folder .env — which is exactly the "Ask"
  // error this fixes. Store it next to the data folder (per-user, survives updates/reinstalls,
  // same reasoning as WORKLENS_DATA_DIR above) and seed a template on first run so there's
  // something to edit immediately from the tray rather than a file that has to be created by hand
  // in a folder most people never look in.
  const envPath = path.join(app.getPath('userData'), '.env');
  if (!fs.existsSync(envPath)) {
    fs.mkdirSync(path.dirname(envPath), { recursive: true });
    fs.writeFileSync(
      envPath,
      '# WorkLens desktop configuration.\n' +
        '# Add your OpenRouter key below to enable AI review, Weekly review, Ask, and repository\n' +
        '# analysis. Get one at https://openrouter.ai/keys, then use the tray icon\'s\n' +
        '# "Restart WorkLens" so this file is read again.\n' +
        'OPENROUTER_API_KEY=\n' +
        'OPENROUTER_MODEL=z-ai/glm-5.3-flash\n'
    );
  }
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    console.error('Could not read .env:', err.message);
  }

  function trayIconPath() {
    return path.join(app.getAppPath(), 'electron', 'assets', 'tray-32.png');
  }

  function windowIconPath() {
    return path.join(app.getAppPath(), 'electron', 'assets', 'icon-256.png');
  }

  function pingServer() {
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${port}/`, (res) => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.setTimeout(500, () => { req.destroy(); resolve(false); });
    });
  }

  async function startServer() {
    if (serverStarted) return true;
    serverStarted = true;
    // The server is plain ESM with top-level side effects (it starts listening on import), and
    // it needs node:sqlite (Node >=22.5). Running it in Electron's own main-process Node — rather
    // than spawning a separate `node` binary — is what makes the packaged app self-contained:
    // Electron's bundled Node satisfies that requirement, so no external Node install is needed.
    // The server encrypts the OpenRouter key it stores for Studio's clip generation with this
    // (Windows DPAPI under the hood); under plain `npm start` it isn't there and the key is kept
    // as typed.
    globalThis.worklensSafeStorage = safeStorage;
    const serverEntry = path.join(app.getAppPath(), 'src', 'server.js');
    await import(pathToFileURL(serverEntry).href);
    // Importing the module only runs its top-level code, which calls server.listen() without
    // waiting for the "listening" event — so the HTTP port isn't necessarily bound yet by the
    // time this resolves. Poll rather than racing the first BrowserWindow load against it; a
    // freshly-installed EXE can be slow the very first time (AV scanning it, first DB creation),
    // so this budget is generous (up to 20s) rather than tuned to a warm dev-run timing.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await pingServer()) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  async function createWindow() {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); return; }
    mainWindow = new BrowserWindow({
      width: 1100,
      height: 800,
      icon: windowIconPath(),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });
    // Profile links, site links and the YouTube/TikTok sign-in pages open in the person's own
    // browser, where they're signed in (Google refuses sign-in inside embedded windows).
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url) && !url.startsWith(`http://localhost:${port}`)) { shell.openExternal(url); return { action: 'deny' }; }
      return { action: 'allow' };
    });
    const url = `http://localhost:${port}`;
    const win = mainWindow;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await win.loadURL(url);
        break;
      } catch (err) {
        if (win.isDestroyed()) return;
        console.error(`Failed to load UI (attempt ${attempt + 1}):`, err.message);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    // Closing the window just hides it — WorkLens keeps recording from the tray. Only the tray's
    // "Quit" (or app.quit()) actually stops the server.
    mainWindow.on('close', (event) => {
      if (app.isQuitting) return;
      event.preventDefault();
      mainWindow.hide();
    });
    mainWindow.on('closed', () => { mainWindow = null; });
  }

  function buildTrayMenu() {
    const loginItem = app.getLoginItemSettings();
    return Menu.buildFromTemplate([
      { label: 'Open WorkLens', click: () => createWindow() },
      { type: 'separator' },
      {
        label: 'Edit OpenRouter key (.env)',
        click: () => {
          // .env has no default Windows file association, so shell.openPath would prompt
          // "how do you want to open this file" the first time — force Notepad instead.
          execFile('notepad.exe', [envPath], (err) => {
            if (err) dialog.showErrorBox('Could not open .env', `${envPath}\n\n${err.message}`);
          });
        }
      },
      {
        label: 'Restart WorkLens',
        click: () => { app.isQuitting = true; app.relaunch(); app.exit(0); }
      },
      { type: 'separator' },
      {
        label: 'Start when I log in',
        type: 'checkbox',
        checked: loginItem.openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath });
        }
      },
      { type: 'separator' },
      { label: 'Quit WorkLens', click: () => { app.isQuitting = true; app.quit(); } }
    ]);
  }

  function createTray() {
    const icon = nativeImage.createFromPath(trayIconPath());
    tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }));
    tray.setToolTip('WorkLens');
    tray.setContextMenu(buildTrayMenu());
    tray.on('click', () => createWindow());
  }

  app.on('ready', async () => {
    // Default "start at login" to on, but only once — a marker file (not just re-checking
    // openAtLogin) distinguishes "never configured" from "user turned it off via the tray",
    // so we don't fight a deliberate opt-out on every subsequent launch. Only for a real
    // packaged install — during `electron .` dev runs this would register the dev launcher
    // (electron.exe from node_modules) to start at login, which nobody wants.
    if (app.isPackaged) {
      const marker = path.join(app.getPath('userData'), '.autostart-initialized');
      if (!fs.existsSync(marker)) {
        app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
        fs.mkdirSync(path.dirname(marker), { recursive: true });
        fs.writeFileSync(marker, new Date().toISOString());
      }
    }
    const existing = await runningBuild();
    if (existing && !samePath(existing.root, app.getAppPath())) {
      dialog.showErrorBox('Another WorkLens is running', otherCopyMessage(existing));
      app.isQuitting = true;
      app.quit();
      return;
    }
    let ok = false;
    try {
      ok = await startServer();
    } catch (err) {
      console.error('Failed to start WorkLens server:', err);
    }
    if (!ok) {
      dialog.showErrorBox(
        'WorkLens couldn\'t start',
        `WorkLens's local server didn't come up on port ${port}. This usually means something ` +
        `else on this machine is already using that port (maybe another copy of WorkLens is ` +
        `already running). Close it and reopen WorkLens, or set WORKLENS_PORT to a different port.`
      );
      app.isQuitting = true;
      app.quit();
      return;
    }
    createTray();
    await createWindow();
  });

  app.on('second-instance', () => { createWindow(); });

  app.on('window-all-closed', () => {
    // Windows tray apps stay alive with no open window; quitting is via the tray menu only.
  });

  app.on('before-quit', () => { app.isQuitting = true; });
}
