const { contextBridge, ipcRenderer } = require('electron');

function on(channel, handler) {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('dock', {
  getFeatures: () => ipcRenderer.invoke('features:get'),
  listServices: () => ipcRenderer.invoke('services:list'),
  getUpdate: () => ipcRenderer.invoke('update:get'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  getState: () => ipcRenderer.invoke('state:get'),
  patchState: (partial) => ipcRenderer.invoke('state:patch', partial),
  getDisplays: () => ipcRenderer.invoke('displays:get'),
  clearSession: (service) => ipcRenderer.invoke('session:clear', service),
  testShortcut: (accelerator) => ipcRenderer.invoke('shortcut:test', accelerator),

  listCredentials: () => ipcRenderer.invoke('credentials:list'),
  setCredentials: (service, username, password) =>
    ipcRenderer.invoke('credentials:set', { service, username, password }),
  clearCredentials: (service) => ipcRenderer.invoke('credentials:clear', service),

  // 不具合の記録
  getReport: () => ipcRenderer.invoke('report:get'),
  openReportFolder: () => ipcRenderer.invoke('report:open-folder'),
  sendReport: () => ipcRenderer.invoke('report:send'),

  getDataDir: () => ipcRenderer.invoke('datadir:get'),
  chooseDataDir: () => ipcRenderer.invoke('datadir:choose'),
  setDataDir: (target, move) => ipcRenderer.invoke('datadir:set', { target, move }),

  setLayout: (rects) => ipcRenderer.send('layout:set', rects),
  columnAction: (id, action) => ipcRenderer.send('col:action', { id, action }),
  dockAction: (action) => ipcRenderer.send('dock:action', action),

  onState: (handler) => on('state', handler),
  onColumnStatus: (handler) => on('col:status', handler),
  onOpenSettings: (handler) => on('ui:openSettings', handler),
  onNewPost: (handler) => on('notify:new-post', handler),
  onLoginStep: (handler) => on('login:step', handler),
  onUpdateState: (handler) => on('update:state', handler),
});
