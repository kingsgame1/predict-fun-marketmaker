/**
 * 🚀 Predict.fun 桌面启动器 - 简化版
 *
 * 功能：
 * 1. 一键启动做市商功能
 * 2. 系统状态检查
 * 3. 快捷配置管理
 * 4. 完全免费，无需激活
 *
 * @author Predict.fun Team
 * @version 1.0.0
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const Store = require('electron-store');

const store = new Store();
let mainWindow = null;

/**
 * 创建主窗口
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    minWidth: 700,
    minHeight: 500,
    title: 'Predict.fun 做市商控制台',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#667eea',
  });

  // 加载主界面
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // 开发模式下打开开发者工具
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * 获取项目路径
 */
function getProjectPath() {
  let projectPath = store.get('projectPath');
  if (!projectPath) {
    projectPath = path.resolve(__dirname, '..');
    store.set('projectPath', projectPath);
  }
  return projectPath;
}

/**
 * 启动主程序
 */
function startMainApp() {
  try {
    const projectPath = getProjectPath();

    // 检查项目路径
    if (!fs.existsSync(projectPath)) {
      throw new Error('项目路径不存在: ' + projectPath);
    }

    // 检查 package.json
    const packageJson = path.join(projectPath, 'package.json');
    if (!fs.existsSync(packageJson)) {
      throw new Error('主程序配置文件缺失');
    }

    // 检查主程序入口
    const mainEntry = path.join(projectPath, 'src', 'index.ts');
    if (!fs.existsSync(mainEntry)) {
      throw new Error('主程序入口文件缺失');
    }

    // 启动主程序
    const platform = process.platform;
    let command = '';

    if (platform === 'darwin') {
      command = `cd "${projectPath}" && npm start`;
    } else if (platform === 'win32') {
      command = `cd "${projectPath}" && npm start`;
    } else {
      command = `cd "${projectPath}" && npm start`;
    }

    console.log('启动命令:', command);

    // 使用 spawn 启动
    const { spawn } = require('child_process');
    const parts = platform === 'win32' ? ['cmd', '/c', command] : ['sh', '-c', command];
    spawn(parts[0], parts.slice(1), {
      detached: true,
      stdio: 'ignore',
      cwd: projectPath,
    });

    return { success: true, message: '做市商程序启动成功！\n\n正在启动自动做市商功能...' };
  } catch (error) {
    console.error('启动失败:', error);
    return { success: false, message: error.message };
  }
}

/**
 * 打开项目文件夹
 */
function openProjectFolder() {
  const projectPath = getProjectPath();
  shell.openPath(projectPath);
}

/**
 * 打开配置文件
 */
function openConfigFile() {
  const projectPath = getProjectPath();
  const envPath = path.join(projectPath, '.env');

  if (!fs.existsSync(envPath)) {
    const envExample = path.join(projectPath, '.env.example');
    if (fs.existsSync(envExample)) {
      fs.copyFileSync(envExample, envPath);
    } else {
      fs.writeFileSync(envPath, '# Predict.fun 配置文件\n');
    }
  }

  shell.openPath(envPath);
}

/**
 * 检查系统环境
 */
function checkSystemEnvironment() {
  const checks = {
    node: false,
    npm: false,
    projectPath: false,
    envFile: false,
  };

  try {
    execSync('node --version', { stdio: 'ignore' });
    checks.node = true;
  } catch (error) {
    // Node.js 未安装
  }

  try {
    execSync('npm --version', { stdio: 'ignore' });
    checks.npm = true;
  } catch (error) {
    // npm 未安装
  }

  try {
    const projectPath = getProjectPath();
    checks.projectPath = fs.existsSync(projectPath);
    const envPath = path.join(projectPath, '.env');
    checks.envFile = fs.existsSync(envPath);
  } catch (error) {
    // 检查失败
  }

  return checks;
}

/**
 * IPC 事件处理
 */
ipcMain.handle('start-app', async () => {
  return startMainApp();
});

ipcMain.handle('open-project-folder', async () => {
  openProjectFolder();
  return { success: true };
});

ipcMain.handle('open-config-file', async () => {
  openConfigFile();
  return { success: true };
});

ipcMain.handle('check-system', async () => {
  return checkSystemEnvironment();
});

ipcMain.handle('get-project-path', async () => {
  return getProjectPath();
});

ipcMain.handle('set-project-path', async (event, newPath) => {
  store.set('projectPath', newPath);
  return { success: true };
});

ipcMain.handle('select-project-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择项目文件夹',
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const selectedPath = result.filePaths[0];
    store.set('projectPath', selectedPath);
    return { success: true, path: selectedPath };
  }

  return { success: false };
});

/**
 * 应用生命周期
 */
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * 错误处理
 */
process.on('uncaughtException', (error) => {
  console.error('未捕获的异常:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的 Promise 拒绝:', reason);
});
