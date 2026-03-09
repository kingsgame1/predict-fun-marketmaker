import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('liteApp', {
  readEnv: () => ipcRenderer.invoke('env:read'),
  writeEnv: (text) => ipcRenderer.invoke('env:write', text),
  startMM: () => ipcRenderer.invoke('mm:start'),
  stopMM: () => ipcRenderer.invoke('mm:stop'),
  status: () => ipcRenderer.invoke('mm:status'),
  applyTemplate: (venue) => ipcRenderer.invoke('template:apply', venue),
  scanMarkets: (venue, top, scan) => ipcRenderer.invoke('market:scan', venue, top, scan),
  applyAutoMarkets: (venue, top, scan) => ipcRenderer.invoke('market:apply-auto', venue, top, scan),
  setManualMarkets: (tokenIds) => ipcRenderer.invoke('market:set-manual', tokenIds),
  getManualMarkets: () => ipcRenderer.invoke('market:get-manual'),
  openExternal: (url) => ipcRenderer.invoke('link:open', url),
  getPredictWalletStatus: () => ipcRenderer.invoke('predict:wallet-status'),
  // 获取 JWT Token
  getJwt: () => ipcRenderer.invoke('auth:get-jwt'),
  onLog: (cb) => ipcRenderer.on('log', (_, payload) => cb(payload)),
  onStatus: (cb) => ipcRenderer.on('status', (_, payload) => cb(payload)),
});
