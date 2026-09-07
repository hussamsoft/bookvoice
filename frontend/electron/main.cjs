const { app, BrowserWindow, screen } = require('electron');
const path = require('path');

// `NODE_ENV=x cmd` is bash-only syntax and fails on Windows, which is this
// app's primary platform, so the npm script passes --dev instead. The env var
// still works for anyone exporting it in their own shell.
const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

// UI floor, not a preference: the reader toolbar wraps at <=720px CSS px,
// so anything narrower would genuinely lose controls.
const MIN_WIDTH = 780;
const MIN_HEIGHT = 560;

function createWindow() {
    // First launch: about 65% of the work area. Displays too small for
    // every element to compress to that scale get the UI floor instead.
    const { workAreaSize } = screen.getPrimaryDisplay();
    const width = Math.max(MIN_WIDTH, Math.round(workAreaSize.width * 0.65));
    const height = Math.max(MIN_HEIGHT, Math.round(workAreaSize.height * 0.65));

    const mainWindow = new BrowserWindow({
        width,
        height,
        minWidth: MIN_WIDTH,
        minHeight: MIN_HEIGHT,
        title: 'BookVoice',
        backgroundColor: '#0d0d17',
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
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
