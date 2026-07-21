'use strict';
// Processo principal do app desktop. Sobe o backend Express em 127.0.0.1 e
// abre a interface numa janela nativa (sem navegador, sem barra de menu).
const { app, BrowserWindow, shell, nativeImage } = require('electron');
const path = require('path');

// Uma única janela do Mission Control por vez
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let win = null;

  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  async function createWindow() {
    const { start } = require('./server');
    const { port } = await start();

    const iconPath = path.join(__dirname, 'public', 'icon.png');
    win = new BrowserWindow({
      width: 1480,
      height: 940,
      minWidth: 1100,
      minHeight: 700,
      backgroundColor: '#0d1117',
      autoHideMenuBar: true,
      title: 'SalesPulse Mission Control',
      icon: nativeImage.createFromPath(iconPath),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Links externos (app das empresas, Kudu, portal Azure) abrem no navegador
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    win.on('closed', () => { win = null; });
    await win.loadURL(`http://127.0.0.1:${port}`);
  }

  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
