const { app, BrowserWindow } = require('electron');
const path = require('path');

// `NODE_ENV=x cmd` is bash-only syntax and fails on Windows, which is this
// app's primary platform, so the npm script passes --dev instead. The env var
// still works for anyone exporting it in their own shell.
const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

function createWindow() {
    const mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        minWidth: 720,
        minHeight: 480,
        title: 'BookVoice',
        backgroundColor: '#f7f5f1',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools();
    } else {
        mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    }

    return mainWindow;
}

app.whenReady().then(() => {
    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
