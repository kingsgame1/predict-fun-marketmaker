/**
 * Preload Script - 桥接渲染进程和主进程
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 应用启动/停止
  startApp: () => ipcRenderer.invoke('start-app'),
  stopApp: () => ipcRenderer.invoke('stop-app'),
  getAppStatus: () => ipcRenderer.invoke('get-app-status'),

  // 文件操作
  openProjectFolder: () => ipcRenderer.invoke('open-project-folder'),
  openConfigFile: () => ipcRenderer.invoke('open-config-file'),
  selectProjectFolder: () => ipcRenderer.invoke('select-project-folder'),

  // 系统检查
  checkSystem: () => ipcRenderer.invoke('check-system'),
  getProjectPath: () => ipcRenderer.invoke('get-project-path'),
  setProjectPath: (projectPath) => ipcRenderer.invoke('set-project-path', projectPath),

  // .env 配置读写
  getConfig: () => ipcRenderer.invoke('get-config'),
  readConfig: () => ipcRenderer.invoke('get-config'), // 别名：toggleApp里用
  setConfig: (key, value) => ipcRenderer.invoke('set-config', key, value),
  setTradingMode: (mode) => ipcRenderer.invoke('set-trading-mode', mode),

  // 市场浏览
  fetchPredictMarkets: () => ipcRenderer.invoke('fetch-predict-markets'),
  fetchPolymarketMarkets: () => ipcRenderer.invoke('fetch-polymarket-markets'),
  recommendMarkets: (markets, mode) => ipcRenderer.invoke('recommend-markets', markets, mode),

  // 市场关注列表
  addMarketToWatch: (tokenId, question) => ipcRenderer.invoke('add-market-to-watch', tokenId, question),
  removeMarketFromWatch: (tokenId) => ipcRenderer.invoke('remove-market-from-watch', tokenId),
  getWatchlist: () => ipcRenderer.invoke('get-watchlist'),

  // 市场选择 → 写入 .env
  applyMarketSelection: (tokenIdsStr) => ipcRenderer.invoke('apply-market-selection', tokenIdsStr),

  // JWT 认证
  fetchJwt: () => ipcRenderer.invoke('fetch-jwt'),
  getJwtStatus: () => ipcRenderer.invoke('get-jwt-status'),

  // Polymarket 平台
  setPlatform: (venue) => ipcRenderer.invoke('set-platform', venue),
  getPolymarketStatus: () => ipcRenderer.invoke('get-polymarket-status'),

  // 日志流 — onLog 返回取消函数，可精确移除单个监听器
  onLog: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('app-log', handler);
    return () => ipcRenderer.removeListener('app-log', handler);
  },
  removeLogListener: () => ipcRenderer.removeAllListeners('app-log'),
});
