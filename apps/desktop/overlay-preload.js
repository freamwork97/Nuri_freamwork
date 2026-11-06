// Bridge for the computer-use status overlay (ui/overlay.html).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  stop: () => ipcRenderer.send('overlay:stop'),
  onStatus: (cb) => ipcRenderer.on('overlay:status', (_e, payload) => cb(payload)),
});
