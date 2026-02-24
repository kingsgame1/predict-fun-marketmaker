/**
 * Preload Script - 桥接渲染进程和主进程
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 应用启动
  startApp: () => ipcRenderer.invoke('start-app'),

  // 文件操作
  openProjectFolder: () => ipcRenderer.invoke('open-project-folder'),
  openConfigFile: () => ipcRenderer.invoke('open-config-file'),
  selectProjectFolder: () => ipcRenderer.invoke('select-project-folder'),

  // 系统检查
  checkSystem: () => ipcRenderer.invoke('check-system'),
  getProjectPath: () => ipcRenderer.invoke('get-project-path'),
  setProjectPath: (path) => ipcRenderer.invoke('set-project-path', path),
});
