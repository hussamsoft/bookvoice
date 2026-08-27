const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    platform: process.platform,
    versions: {
        node: process.versions.node,
        chrome: process.versions.chrome,
        electron: process.versions.electron,
    },
    send: (channel, data) => ipcRenderer.send(channel, data),
    on: (channel, fn) => ipcRenderer.on(channel, fn),
});
