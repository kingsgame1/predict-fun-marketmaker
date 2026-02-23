/**
 * Preload Script - 桥接渲染进程和主进程
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 激活相关 - 简化为只接受激活码
  checkActivation: () => ipcRenderer.invoke('check-activation'),
  activateLicense: (licenseKey) =>
    ipcRenderer.invoke('activate-license', licenseKey),
  showActivationWindow: () =>
    ipcRenderer.invoke('show-activation-window'),

  // 应用启动
  startApp: (mode) => ipcRenderer.invoke('start-app', mode),

  // 文件操作
  openProjectFolder: () => ipcRenderer.invoke('open-project-folder'),
  openConfigFile: () => ipcRenderer.invoke('open-config-file'),
  selectProjectFolder: () => ipcRenderer.invoke('select-project-folder'),

  // 系统检查
  checkSystem: () => ipcRenderer.invoke('check-system'),
  getProjectPath: () => ipcRenderer.invoke('get-project-path'),
  setProjectPath: (path) => ipcRenderer.invoke('set-project-path', path),
});
