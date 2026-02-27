import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================
// 核心路径配置
// ============================================================

// App 包内的项目根目录（包含 src, scripts, node_modules）
const appRoot = path.resolve(__dirname, '..');

// 用户配置目录（只存储 .env 文件）
const userConfigDir = path.join(os.homedir(), '.predict-fun-market-maker-lite');
const envPath = path.join(userConfigDir, '.env');

// 确保用户配置目录存在
if (!fs.existsSync(userConfigDir)) {
  fs.mkdirSync(userConfigDir, { recursive: true });
  console.log('[INIT] 创建用户配置目录:', userConfigDir);
}

const rendererPath = path.resolve(__dirname, '..', 'renderer', 'index.html');
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

console.log('[INIT] App 根目录:', appRoot);
console.log('[INIT] 用户配置目录:', userConfigDir);
console.log('[INIT] .env 路径:', envPath);

// ============================================================
// PATH 环境变量修复（macOS GUI 应用不继承 shell PATH）
// ============================================================

function setupPath() {
  if (process.platform !== 'darwin') {
    console.log('[PATH] 非 macOS 系统，保持原有 PATH');
    return;
  }

  const home = os.homedir();
  console.log('[PATH] HOME:', home);

  // 方法 1: 从登录 shell 获取 PATH
  try {
    const userShell = process.env.SHELL || '/bin/zsh';
    const shellPath = execSync(`"${userShell}" -l -c 'echo $PATH'`, {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, HOME: home }
    }).trim();

    if (shellPath && shellPath.includes('/bin')) {
      process.env.PATH = shellPath;
      console.log('[PATH] ✅ 从 shell 获取 PATH 成功');
      return;
    }
  } catch (err) {
    console.warn('[PATH] 从 shell 获取失败:', err.message);
  }

  // 方法 2: 手动检测 Node.js 安装位置
  console.log('[PATH] 尝试手动检测 Node.js 路径...');
  const existingPaths = new Set((process.env.PATH || '').split(':').filter(Boolean));

  // nvm 路径
  const nvmDir = path.join(home, '.nvm', 'versions', 'node');
  if (fs.existsSync(nvmDir)) {
    try {
      const versions = fs.readdirSync(nvmDir);
      for (const v of versions) {
        const binPath = path.join(nvmDir, v, 'bin');
        if (fs.existsSync(binPath)) {
          existingPaths.add(binPath);
          console.log('[PATH] 找到 nvm:', binPath);
        }
      }
    } catch { /* ignore */ }
  }

  // fnm 路径
  const fnmDir = path.join(home, '.fnm', 'node-versions');
  if (fs.existsSync(fnmDir)) {
    try {
      const versions = fs.readdirSync(fnmDir);
      for (const v of versions) {
        const binPath = path.join(fnmDir, v, 'installation', 'bin');
        if (fs.existsSync(binPath)) {
          existingPaths.add(binPath);
          console.log('[PATH] 找到 fnm:', binPath);
        }
      }
    } catch { /* ignore */ }
  }

  // volta 路径
  const voltaBin = path.join(home, '.volta', 'bin');
  if (fs.existsSync(voltaBin)) {
    existingPaths.add(voltaBin);
    console.log('[PATH] 找到 volta:', voltaBin);
  }

  // Homebrew 路径
  const homebrewPaths = ['/usr/local/bin', '/opt/homebrew/bin'];
  for (const p of homebrewPaths) {
    if (fs.existsSync(p)) {
      existingPaths.add(p);
    }
  }

  const newPath = [...existingPaths].join(':');
  process.env.PATH = newPath;
  console.log('[PATH] ✅ 更新后的 PATH');
}

setupPath();

// ============================================================
// 应用状态
// ============================================================

let win = null;
let mmProcess = null;

// ============================================================
// 配置文件操作
// ============================================================

function readEnv() {
  if (!fs.existsSync(envPath)) return '';
  return fs.readFileSync(envPath, 'utf8');
}

function writeEnv(text) {
  fs.writeFileSync(envPath, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

function parseEnv(text) {
  const map = new Map();
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .forEach((line) => {
      if (!line || line.startsWith('#')) return;
      const idx = line.indexOf('=');
      if (idx < 0) return;
      map.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
    });
  return map;
}

function upsertEnv(text, updates) {
  const lines = text.split(/\r?\n/);
  const lineByKey = new Map();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    if (!lineByKey.has(key)) lineByKey.set(key, i);
  }
  for (const [key, value] of Object.entries(updates)) {
    const next = `${key}=${value}`;
    if (lineByKey.has(key)) {
      lines[lineByKey.get(key)] = next;
    } else {
      lines.push(next);
    }
  }
  return `${lines.join('\n').replace(/\n+$/g, '')}\n`;
}

// ============================================================
// UI 通信
// ============================================================

function sendLog(message) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('log', { ts: Date.now(), message });
  }
}

function sendStatus() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('status', { running: Boolean(mmProcess) });
  }
}

// ============================================================
// 模板功能
// ============================================================

function applyTemplate(venue) {
  try {
    ensureEnvFile();
    const current = readEnv();
    const existing = parseEnv(current);

    const next = venue === 'predict'
      ? buildPredictTemplate(existing)
      : buildProbableTemplate(existing);

    // 备份
    if (fs.existsSync(envPath)) {
      const backup = `${envPath}.bak.${Date.now()}`;
      fs.copyFileSync(envPath, backup);
      sendLog(`已备份旧配置: ${backup}`);
    }

    writeEnv(next);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

function buildPredictTemplate(existing) {
  const pick = (key, placeholder = '') => {
    const value = (existing.get(key) || '').trim();
    if (!value) return placeholder;
    const lower = value.toLowerCase();
    if (lower.includes('your_') || lower.includes('placeholder') || lower.includes('请填写')) {
      return placeholder;
    }
    return value;
  };

  const apiKey = pick('API_KEY', '请填写你的_API_KEY');
  const privateKey = pick('PRIVATE_KEY', '请填写你的钱包私钥');
  const jwtToken = pick('JWT_TOKEN', '请填写你的_JWT_TOKEN（仅实盘必填）');
  const account = pick('PREDICT_ACCOUNT_ADDRESS', '');
  const marketIds = pick('MARKET_TOKEN_IDS', '');

  return `# ==============================
# Predict 做市模板（统一策略）
# 只展示你需要填写的字段；其余参数使用系统统一策略默认值
# ==============================

# ---- 需要你填写（必填） ----
# [需自行获取] Predict API Key（必填）
# 获取方式：Predict 官方渠道/工单申请
API_KEY=${apiKey}
# [需自行获取] 钱包私钥（必填）
PRIVATE_KEY=${privateKey}
# [需自行获取] Predict 私有接口 JWT（仅 ENABLE_TRADING=true 实盘时必填）
JWT_TOKEN=${jwtToken}
# [可选填写] Predict 账户地址（推荐填写）
PREDICT_ACCOUNT_ADDRESS=${account}

# ---- 官方默认 API / WS（直接使用）----
# [官方默认 API] 直接使用即可
API_BASE_URL=https://api.predict.fun
# [官方默认 WS] 直接使用即可
PREDICT_WS_URL=wss://ws.predict.fun/ws

# ---- 统一做市策略开关（自动）----
MM_VENUE=predict
MM_REQUIRE_JWT=true
PROBABLE_ENABLED=false
MM_WS_ENABLED=true
PREDICT_WS_ENABLED=true
PROBABLE_WS_ENABLED=false

# ---- YES/NO 对冲策略（启用后自动对冲）----
UNIFIED_MARKET_MAKER_ENABLED=true

ENABLE_TRADING=false
AUTO_CONFIRM=false

# ---- 市场筛选（可选）----
# 手动填写 tokenId（逗号分隔），为空则走自动推荐市场
MARKET_TOKEN_IDS=${marketIds}
`;
}

function buildProbableTemplate(existing) {
  const pick = (key, placeholder = '') => {
    const value = (existing.get(key) || '').trim();
    if (!value) return placeholder;
    const lower = value.toLowerCase();
    if (lower.includes('your_') || lower.includes('placeholder') || lower.includes('请填写')) {
      return placeholder;
    }
    return value;
  };

  const probableKey = pick('PROBABLE_PRIVATE_KEY', '请填写你的_Probable_私钥（必填）');
  const privateKey = pick('PRIVATE_KEY', '');
  const marketIds = pick('MARKET_TOKEN_IDS', '');

  return `# ==============================
# Probable 做市模板（统一策略）
# 只展示你需要填写的字段；其余参数使用系统统一策略默认值
# ==============================

# ---- 需要你填写（必填） ----
# [需自行获取] Probable 私钥（必填）
PROBABLE_PRIVATE_KEY=${probableKey}
# 兼容字段（可留空；如有值可与 PROBABLE_PRIVATE_KEY 一致）
PRIVATE_KEY=${privateKey}

# ---- 官方默认 API / WS（直接使用）----
# 文档来源：https://developer.probable.markets/
# Market API: /public/api/v1/markets/
# Orderbook API: /public/api/v1/book
MM_VENUE=probable
PROBABLE_MARKET_API_URL=https://market-api.probable.markets
PROBABLE_ORDERBOOK_API_URL=https://api.probable.markets/public/api/v1
# [官方默认 WS] 直接使用即可
PROBABLE_WS_URL=wss://ws.probable.markets/public/api/v1
PROBABLE_CHAIN_ID=56

# ---- 统一做市策略开关（自动）----
MM_REQUIRE_JWT=false
PROBABLE_ENABLED=true
MM_WS_ENABLED=true
PROBABLE_WS_ENABLED=true
PREDICT_WS_ENABLED=false

ENABLE_TRADING=false
AUTO_CONFIRM=false

# ---- 市场筛选（可选）----
# 手动填写 tokenId（逗号分隔），为空则走自动推荐市场
MARKET_TOKEN_IDS=${marketIds}
`;
}

function ensureEnvFile() {
  if (fs.existsSync(envPath)) return;
  writeEnv('# PredictFun Market Maker Lite Configuration\n');
}

// ============================================================
// 命令执行（核心修复：使用 ENV_PATH 指向用户的 .env）
// ============================================================

function runCommand(command, args, label, pipeToUi = true) {
  return new Promise((resolve) => {
    // 关键：设置 ENV_PATH 环境变量，让源代码知道去哪里找 .env
    const env = {
      ...process.env,
      ENV_PATH: envPath,  // 指向用户目录的 .env
    };

    // 使用 shell: true，让 shell 自动处理 PATH
    const fullCommand = `${command} ${args.join(' ')}`;
    console.log(`[RUN] ${fullCommand}`);
    console.log(`[RUN] cwd: ${appRoot}`);
    console.log(`[RUN] ENV_PATH: ${envPath}`);

    const child = spawn(fullCommand, [], {
      cwd: appRoot,
      shell: true,  // 使用 shell 模式，自动处理 PATH
      env: env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      if (pipeToUi) sendLog(`[${label}] ${text}`);
    });
    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      if (pipeToUi) sendLog(`[${label}] ${text}`);
    });
    child.on('error', (err) => {
      console.error(`[RUN] Error:`, err);
      resolve({ ok: false, code: 1, stdout, stderr: err.message });
    });
    child.on('exit', (code) => {
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

async function runRecommendJson(venue, { top = 40, scan = 80, apply = false } = {}) {
  // 添加 --env-path 参数，指向用户目录的 .env
  const args = [
    'tsx', 'scripts/recommend-markets.ts',
    '--venue', venue,
    '--top', String(top),
    '--scan', String(scan),
    '--env', envPath,  // 脚本使用 --env 参数
    '--json'
  ];
  if (apply) args.push('--apply');
  const result = await runCommand(npxCmd, args, 'market', false);
  if (!result.ok) {
    return { ok: false, message: result.stderr || result.stdout || 'market recommend failed' };
  }
  try {
    const payload = JSON.parse((result.stdout || '').trim());
    return { ok: true, payload };
  } catch {
    return { ok: false, message: 'market recommend json parse failed', raw: result.stdout };
  }
}

function startMM() {
  if (mmProcess) return { ok: false, message: '做市进程已在运行' };

  // 关键：设置 ENV_PATH 环境变量
  const env = {
    ...process.env,
    ENV_PATH: envPath,
  };

  console.log(`[MM] 启动做市进程`);
  console.log(`[MM] cwd: ${appRoot}`);
  console.log(`[MM] ENV_PATH: ${envPath}`);

  // 使用 shell: true 让 shell 自动处理 PATH
  mmProcess = spawn(`${npxCmd} tsx src/index.ts`, [], {
    cwd: appRoot,
    shell: true,  // 使用 shell 模式
    env: env,
  });
  mmProcess.stdout.on('data', (d) => sendLog(`[MM] ${d.toString()}`));
  mmProcess.stderr.on('data', (d) => sendLog(`[MM] ${d.toString()}`));
  mmProcess.on('exit', (code) => {
    sendLog(`[MM] exited code=${code}`);
    mmProcess = null;
    sendStatus();
  });
  sendStatus();
  return { ok: true };
}

function stopMM() {
  if (!mmProcess) return { ok: false, message: '做市进程未运行' };
  mmProcess.kill('SIGTERM');
  return { ok: true };
}

function setManualMarketSelection(tokenIds) {
  const tokens = Array.isArray(tokenIds)
    ? tokenIds.map((x) => String(x).trim()).filter((x) => x.length > 0)
    : [];
  const envText = readEnv();
  const next = upsertEnv(envText, { MARKET_TOKEN_IDS: tokens.join(',') });
  writeEnv(next);
  return { ok: true, tokenCount: tokens.length };
}

function getManualMarketSelection() {
  const env = parseEnv(readEnv());
  const raw = env.get('MARKET_TOKEN_IDS') || '';
  const tokenIds = raw
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  return { ok: true, tokenIds };
}

// ============================================================
// 窗口管理
// ============================================================

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 940,
    minHeight: 680,
    webPreferences: {
      preload: path.resolve(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${sourceId}:${line} ${message}`);
  });
  win.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error(`[renderer] load failed code=${code} desc=${desc}`);
  });
  win.loadFile(rendererPath);
}

// ============================================================
// 应用生命周期
// ============================================================

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ============================================================
// IPC 处理
// ============================================================

ipcMain.handle('env:read', () => readEnv());
ipcMain.handle('env:write', (_, text) => {
  writeEnv(text);
  return { ok: true };
});
ipcMain.handle('mm:start', () => startMM());
ipcMain.handle('mm:stop', () => stopMM());
ipcMain.handle('mm:status', () => ({ running: Boolean(mmProcess) }));
ipcMain.handle('template:apply', (_, venue) => {
  if (venue !== 'predict' && venue !== 'probable') {
    return { ok: false, message: 'invalid venue' };
  }
  sendLog(`[template] 应用 ${venue} 模板...`);
  const result = applyTemplate(venue);
  if (result.ok) {
    sendLog(`[template] ✅ 模板应用成功`);
  } else {
    sendLog(`[template] ❌ ${result.message}`);
  }
  return result;
});
ipcMain.handle('market:scan', async (_, venue, top, scan) => {
  const v = venue === 'probable' ? 'probable' : 'predict';
  return await runRecommendJson(v, { top, scan, apply: false });
});
ipcMain.handle('market:apply-auto', async (_, venue, top, scan) => {
  const v = venue === 'probable' ? 'probable' : 'predict';
  return await runRecommendJson(v, { top, scan, apply: true });
});
ipcMain.handle('market:set-manual', (_, tokenIds) => setManualMarketSelection(tokenIds));
ipcMain.handle('market:get-manual', () => getManualMarketSelection());
ipcMain.handle('link:open', async (_, url) => {
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});
