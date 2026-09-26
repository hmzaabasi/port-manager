const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('portManager', {
  list: () => ipcRenderer.invoke('ports:list'),
  kill: (pid) => ipcRenderer.invoke('ports:kill', pid),
  copy: (port) => ipcRenderer.invoke('ports:copy', port),
  onCommands: (callback) => {
    const listener = (_event, details) => callback(details);
    ipcRenderer.on('ports:commands', listener);
    return () => ipcRenderer.removeListener('ports:commands', listener);
  },
});
