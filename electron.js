const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const http = require('http');

// Use a non-default port to avoid clashing with a running dev server
const PORT = process.env.PORT || 3131;
process.env.PORT = PORT;

// Boot the Express server inside the same process
require('./server.js');

let mainWindow;

// Poll until the server is up, then load the UI
function waitForServer(cb, tries = 0) {
  if (tries > 30) return cb(false);
  const req = http.get(`http://localhost:${PORT}`, () => { req.destroy(); cb(true); });
  req.on('error', () => setTimeout(() => waitForServer(cb, tries + 1), 300));
  req.end();
}

app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    title: 'Yandex Music Downloader',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Hide menu bar (keep accessible via Alt)
  mainWindow.setMenuBarVisibility(false);

  // Open links that target _blank in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  waitForServer(ok => {
    if (ok) {
      mainWindow.loadURL(`http://localhost:${PORT}`);
    } else {
      mainWindow.loadURL(
        'data:text/html,<body style="background:#111;color:#fff;font-family:sans-serif;padding:2rem">' +
        '<h2>Failed to start local server</h2><p>PORT ' + PORT + ' may be in use.</p></body>'
      );
      mainWindow.show();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) app.whenReady().then(() => {});
});
