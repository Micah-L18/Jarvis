// Narrow bridge between the window and the main process.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['chat', 'ui', 'memory', 'mcp', 'speech', 'settings']);

contextBridge.exposeInMainWorld('jarvis', {
  invoke: (channel, ...args) => ipcRenderer.invoke(`jarvis:${channel}`, ...args),
  on: (event, handler) => {
    if (!EVENTS.has(event)) throw new Error(`unknown event ${event}`);
    const listener = (_e, payload) => handler(payload);
    ipcRenderer.on(`jarvis:${event}`, listener);
    return () => ipcRenderer.removeListener(`jarvis:${event}`, listener);
  },
});
