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
require('dotenv').config(); // 加载环境变量

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

  // 直接显示主界面（简化版和交易模式免费使用）
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // 打开开发者工具（临时调试）
  mainWindow.webContents.openDevTools();

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
    // 默认路径：启动器所在目录的上级目录（predict-fun-market-maker）
    projectPath = path.resolve(__dirname, '..');
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
 *
 * 两个版本启动同一个应用：
 * - 简化版（simple）：做市商挂单（免费）
 * - 完整版（full）：做市商挂单（免费） + 自动套利机器人（需激活码）
 *
 * 应用内部会根据激活状态决定是否启用套利功能
 */
function startMainApp(mode = 'full') {
  try {
    const projectPath = getProjectPath();

    // 检查项目路径是否存在
    if (!fs.existsSync(projectPath)) {
      throw new Error('项目路径不存在: ' + projectPath);
    }

    // 检查 package.json
    const packageJson = path.join(projectPath, 'package.json');
    if (!fs.existsSync(packageJson)) {
      throw new Error('主程序配置文件缺失');
    }

    // 检查主程序入口文件
    const mainEntry = path.join(projectPath, 'src', 'index.ts');
    if (!fs.existsSync(mainEntry)) {
      throw new Error('主程序入口文件缺失');
    }

    // 启动命令：使用 npm start 启动应用
    const platform = process.platform;
    let command = '';

    if (platform === 'darwin') {
      // macOS
      command = `cd "${projectPath}" && npm start`;
    } else if (platform === 'win32') {
      // Windows
      command = `cd "${projectPath}" && npm start`;
    } else {
      // Linux
      command = `cd "${projectPath}" && npm start`;
    }

    console.log('启动命令:', command);
    console.log('启动模式:', mode);

    // 使用 spawn 启动，分离进程
    const { spawn } = require('child_process');
    const parts = platform === 'win32' ? ['cmd', '/c', command] : ['sh', '-c', command];
    spawn(parts[0], parts.slice(1), {
      detached: true,
      stdio: 'ignore',
      cwd: projectPath,
    });

    const modeNames = {
      'simple': '简化版',
      'full': '完整版'
    };

    return {
      success: true,
      message: `${modeNames[mode] || mode}启动成功！\n\n✅ 做市商挂单（免费）\n${mode === 'full' ? '🔒 自动套利机器人（需激活码）\n' : ''}点击确定后，应用将自动启动。`
    };
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

ipcMain.handle('activate-license', async (event, licenseKey) => {
  try {
    // 基本验证
    if (!licenseKey || licenseKey.length !== 39) {
      return { success: false, message: '激活码格式无效' };
    }

    console.log('🔐 开始激活验证:', licenseKey);

    // 读取配置
    const projectPath = getProjectPath();
    const envPath = path.join(projectPath, '.env');

    // 加载环境变量以获取服务器配置
    const result = require('dotenv').config({ path: envPath });

    // 导入激活验证模块
    const { SecureActivationManager } = await import('./src/activation-secure.js');

    // 执行在线激活验证
    const activationResult = await SecureActivationManager.activate(
      licenseKey,
      'user_' + Date.now().toString(36)
    );

    if (activationResult.valid) {
      console.log('✅ 激活成功');

      // 激活信息已经由 SecureActivationManager 保存
      const remainingDays = activationResult.remainingDays || 365;
      const features = activationResult.features || ['arbitrage'];

      return {
        success: true,
        message: `激活成功！有效期${remainingDays}天\n已解锁功能: ${features.join(', ')}`
      };
    } else {
      console.error('❌ 激活失败:', activationResult.message);
      return {
        success: false,
        message: activationResult.message || '激活失败，请检查激活码是否正确'
      };
    }
  } catch (error) {
    console.error('❌ 激活过程出错:', error);
    return {
      success: false,
      message: `激活失败: ${error.message}`
    };
  }
});

ipcMain.handle('start-app', async (event, mode) => {
  // 直接启动应用，激活检查在应用内部进行
  // 这样可以支持：做市商免费，套利机器人需要激活
  return startMainApp(mode);
});

ipcMain.handle('show-activation-window', async () => {
  if (!mainWindow) {
    return { success: false, message: '主窗口不存在' };
  }

  // 创建激活窗口（模态窗口）
  const activationWindow = new BrowserWindow({
    width: 600,
    height: 700,
    parent: mainWindow,
    modal: true,
    title: '激活 - Predict.fun',
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  activationWindow.loadFile(path.join(__dirname, 'activation.html'));

  return { success: true };
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
