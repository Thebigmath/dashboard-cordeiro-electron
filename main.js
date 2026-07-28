const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

let mainWindow;

const userDataPath = app.getPath('userData');
const storagePath = path.join(userDataPath, 'storage');
if (!fs.existsSync(storagePath)) fs.mkdirSync(storagePath, { recursive: true });

const appStorage = path.join(__dirname, 'storage');
for (const file of ['config.json', 'usuarios.json', 'custos.json']) {
    const dest = path.join(storagePath, file);
    const src  = path.join(appStorage, file);
    if (!fs.existsSync(src)) continue;
    if (!fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
    } else if (file === 'config.json') {
        try {
            const existing = JSON.parse(fs.readFileSync(dest, 'utf8'));
            const defaults = JSON.parse(fs.readFileSync(src,  'utf8'));
            const merged   = { ...defaults, ...existing };
            fs.writeFileSync(dest, JSON.stringify(merged, null, 4), 'utf8');
        } catch {}
    }
}

process.env.STORAGE_PATH = storagePath;

const server = require('./server');

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

autoUpdater.on('checking-for-update', () => {
    mainWindow?.webContents.send('update-status', 'Verificando atualizações...');
});
autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update-available', info.version);
    mainWindow?.webContents.send('update-status', `Update encontrado: v${info.version}`);
});
autoUpdater.on('update-not-available', () => {
    mainWindow?.webContents.send('update-status', 'App já está atualizado.');
});
autoUpdater.on('error', (err) => {
    mainWindow?.webContents.send('update-status', `Erro update: ${err.message}`);
});
let updateReady = false;
autoUpdater.on('update-downloaded', () => {
    updateReady = true;
    mainWindow?.webContents.send('update-downloaded');
});

ipcMain.on('install-update', () => {
    autoUpdater.quitAndInstall();
});

app.whenReady().then(() => {
    server.start(3002, () => {
        mainWindow = new BrowserWindow({
            width: 1400,
            height: 900,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                preload: path.join(__dirname, 'preload.js'),
            },
            title: 'Dashboard ML — Cordeiro Car',
            show: false,
        });

        const tokenPath = path.join(storagePath, 'token.json');
        const temToken  = fs.existsSync(tokenPath);
        const startUrl  = temToken ? 'http://localhost:3002' : 'http://localhost:3002/auth/gerar_token';

        mainWindow.loadURL(startUrl);
        mainWindow.once('ready-to-show', () => {
            mainWindow.show();
            setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
        });
        mainWindow.webContents.on('did-finish-load', () => {
            if (updateReady) mainWindow.webContents.send('update-downloaded');
        });
    });
});

app.on('window-all-closed', () => {
    server.stop();
    app.quit();
});

