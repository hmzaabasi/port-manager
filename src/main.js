const { app, BrowserWindow, Menu, clipboard, ipcMain } = require('electron');
const os = require('os');
const path = require('path');
const { listListeners, requestCommands, killProcess } = require('./ports');

app.commandLine.appendSwitch('disk-cache-dir', path.join(os.tmpdir(), 'port-manager-cache'));
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

let listInFlight = null;

function createWindow() {
  const window = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 820,
    minHeight: 560,
    backgroundColor: '#10120e',
    title: 'Port Manager',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => window.show());
  window.loadFile(path.join(__dirname, 'index.html'));
}

function listPorts() {
  if (!listInFlight) {
    listInFlight = listListeners().finally(() => {
      listInFlight = null;
    });
  }
  return listInFlight;
}

function broadcastCommands(details) {
  if (!details.length) return;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('ports:commands', details);
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  ipcMain.handle('ports:list', async () => {
    try {
      const listeners = await listPorts();
      requestCommands(listeners, broadcastCommands);
      return { ok: true, listeners };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('ports:copy', (_event, port) => {
    const value = String(port ?? '');
    if (!/^\d{1,5}$/.test(value)) return { ok: false };
    clipboard.writeText(value);
    return { ok: true };
  });

  ipcMain.handle('ports:kill', async (_event, pid) => {
    try {
      const result = await killProcess(pid);
      return { ok: true, message: result.message };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
