/**
 * 🚀 Predict.fun 桌面启动器
 *
 * 功能：
 * 1. 激活码验证和输入
 * 2. 一键启动主程序
 * 3. 系统状态检查
 * 4. 快捷配置管理
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
    width: 900,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    title: 'Predict.fun 做市商控制台',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#667eea',
    titleBarStyle: 'hiddenInset',
  });

  // 检查是否已激活
  const isActivated = checkActivation();

  if (isActivated) {
    // 已激活，显示主界面
    mainWindow.loadFile('index.html');
  } else {
    // 未激活，显示激活界面
    mainWindow.loadFile('activation.html');
  }

  // 开发模式下打开开发者工具
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * 检查激活状态
 */
function checkActivation() {
  try {
    const projectPath = getProjectPath();
    const activationFile = path.join(projectPath, '.secure_activation.dat');

    if (!fs.existsSync(activationFile)) {
      return false;
    }

    // 这里应该调用激活验证逻辑
    // 简化版本：检查文件存在
    return true;
  } catch (error) {
    console.error('检查激活状态失败:', error);
    return false;
  }
}

/**
 * 获取项目路径
 */
function getProjectPath() {
  // 从存储中读取项目路径
  let projectPath = store.get('projectPath');

  if (!projectPath) {
    // 默认路径：启动器所在目录的上级目录
    projectPath = path.join(__dirname, '..');
    store.set('projectPath', projectPath);
  }

  return projectPath;
}

/**
 * 设置项目路径
 */
function setProjectPath(newPath) {
  store.set('projectPath', newPath);
}

/**
 * 启动主程序
 */
function startMainApp(mode = 'full') {
  try {
    const projectPath = getProjectPath();
    const mainAppPath = path.join(projectPath, 'desktop-app');

    if (!fs.existsSync(mainAppPath)) {
      throw new Error('主程序不存在，请检查安装路径');
    }

    // 检查 package.json
    const packageJson = path.join(mainAppPath, 'package.json');
    if (!fs.existsSync(packageJson)) {
      throw new Error('主程序配置文件缺失');
    }

    // 启动主程序
    const platform = process.platform;
    let command = '';

    if (platform === 'darwin') {
      // macOS
      const appPath = path.join(mainAppPath, 'dist', 'mac', 'Predict.fun Console.app');
      if (fs.existsSync(appPath)) {
        command = `open "${appPath}"`;
      } else {
        // 使用 npm start
        command = `cd "${mainAppPath}" && npm start`;
      }
    } else if (platform === 'win32') {
      // Windows
      const exePath = path.join(mainAppPath, 'dist', 'win-unpacked', 'Predict.fun Console.exe');
      if (fs.existsSync(exePath)) {
        command = `"${exePath}"`;
      } else {
        command = `cd "${mainAppPath}" && npm start`;
      }
    } else {
      // Linux
      command = `cd "${mainAppPath}" && npm start`;
    }

    console.log('启动命令:', command);

    // 使用 spawn 启动，分离进程
    const { spawn } = require('child_process');
    const parts = platform === 'win32' ? ['cmd', '/c', command] : ['sh', '-c', command];
    spawn(parts[0], parts.slice(1), {
      detached: true,
      stdio: 'ignore',
      cwd: projectPath,
    });

    return { success: true, message: '主程序启动成功' };
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
    activation: false,
  };

  try {
    // 检查 Node.js
    execSync('node --version', { stdio: 'ignore' });
    checks.node = true;
  } catch (error) {
    // Node.js 未安装
  }

  try {
    // 检查 npm
    execSync('npm --version', { stdio: 'ignore' });
    checks.npm = true;
  } catch (error) {
    // npm 未安装
  }

  try {
    // 检查项目路径
    const projectPath = getProjectPath();
    checks.projectPath = fs.existsSync(projectPath);

    // 检查 .env 文件
    const envPath = path.join(projectPath, '.env');
    checks.envFile = fs.existsSync(envPath);

    // 检查激活
    checks.activation = checkActivation();
  } catch (error) {
    // 检查失败
  }

  return checks;
}

/**
 * IPC 事件处理
 */
ipcMain.handle('check-activation', async () => {
  return { activated: checkActivation() };
});

ipcMain.handle('activate-license', async (event, licenseKey, userId, userName, email) => {
  try {
    // 这里应该调用真实的激活验证
    // 简化版本：创建激活文件

    const projectPath = getProjectPath();
    const activationFile = path.join(projectPath, '.secure_activation.dat');

    const activationData = {
      activated: true,
      licenseKey,
      userId,
      userName,
      email,
      expireDate: Date.now() + 365 * 24 * 60 * 60 * 1000,
      hardwareFingerprint: 'mock-fingerprint',
      features: ['arbitrage', 'auto_trading'],
      activatedAt: Date.now(),
    };

    fs.writeFileSync(activationFile, JSON.stringify(activationData, null, 2));

    return { success: true, message: '✅ 激活成功！' };
  } catch (error) {
    return { success: false, message: `激活失败: ${error.message}` };
  }
});

ipcMain.handle('start-app', async (event, mode) => {
  return startMainApp(mode);
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
  setProjectPath(newPath);
  return { success: true };
});

ipcMain.handle('select-project-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择项目文件夹',
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const selectedPath = result.filePaths[0];
    setProjectPath(selectedPath);
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

app.on('before-quit', () => {
  // 清理工作
});

/**
 * 自动更新检查（可选）
 */
function checkForUpdates() {
  // TODO: 实现自动更新逻辑
}

/**
 * 错误处理
 */
process.on('uncaughtException', (error) => {
  console.error('未捕获的异常:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('未处理的 Promise 拒绝:', reason);
});
