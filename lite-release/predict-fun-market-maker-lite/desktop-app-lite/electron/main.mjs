import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename');
const appRoot = path.resolve(__dirname, '..', '..');
const rendererPath = path.resolve(__dirname, '..', 'renderer', 'index.html');
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// 代码库将克隆到用户的用户目录
const repoDir = path.join(app.getPath('home'), 'predict-fun-marketmaker');
const repoUrl = 'https://github.com/ccjingeth/predict-fun-marketmaker.git';
const envPath = path.join(repoDir, '.env');

let projectRoot = repoDir; // 默认使用克隆的代码库

let win = null;
let mmProcess = null;
let isRepoReady = false;
let repoCheckPromise = null;

// 检查并克隆代码库
async function ensureRepository() {
  if (isRepoReady) return true;
  if (repoCheckPromise) return repoCheckPromise;

  repoCheckPromise = (async () => {
    try {
      // 检查代码库是否已存在
      if (fs.existsSync(path.join(repoDir, 'src', 'index.ts'))) {
        sendLog('✅ 代码库已存在，正在检查更新...');
        try {
          execSync('git fetch origin', { cwd: repoDir, stdio: 'pipe' });
          sendLog('✅ 代码库更新检查完成');
        } catch (e) {
          sendLog('⚠️  更新检查失败，继续使用本地版本');
        }
        isRepoReady = true;
        return true;
      }

      // 克隆代码库
      sendLog(`📥 正在下载代码库到 ${repoDir}...`);
      sendLog('⏳ 首次运行需要下载约 50MB，请稍候...');

      execSync(`git clone --depth 1 ${repoUrl} "${repoDir}"`, {
        stdio: 'pipe',
        cwd: app.getPath('home'),
      });

      sendLog('✅ 代码库下载完成');
      isRepoReady = true;
      return true;
    } catch (error) {
      const msg = error.message || String(error);
      sendLog(`❌ 代码库准备失败: ${msg}`);
      isRepoReady = false;
      return false;
    }
  })();

  return repoCheckPromise;
}

// 检查 node_modules
async function ensureDependencies() {
  const packageJsonPath = path.join(repoDir, 'package.json');
  const nodeModulesPath = path.join(repoDir, 'node_modules');

  if (!fs.existsSync(packageJsonPath)) {
    return false;
  }

  if (fs.existsSync(nodeModulesPath)) {
    return true;
  }

  sendLog('📦 正在安装依赖...');
  try {
    await runCommand('npm', ['install'], 'npm', false);
    sendLog('✅ 依赖安装完成');
    return true;
  } catch (error) {
    sendLog(`❌ 依赖安装失败: ${error.message || String(error)}`);
    return false;
  }
}

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

function runCommand(command, args, label, pipeToUi = true) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: projectRoot, shell: false, env: process.env });
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
    child.on('exit', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

async function runRecommendJson(venue, { top = 40, scan = 80, apply = false } = {}) {
  const repoOk = await ensureRepository();
  if (!repoOk) {
    return { ok: false, message: '代码库准备失败' };
  }

  const depsOk = await ensureDependencies();
  if (!depsOk) {
    return { ok: false, message: '依赖安装失败' };
  }

  const args = ['tsx', 'scripts/recommend-markets.ts', '--venue', venue, '--top', String(top), '--scan', String(scan), '--json'];
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

async function startMM() {
  if (mmProcess) return { ok: false, message: '做市进程已在运行' };

  sendLog('🔧 正在准备代码库...');
  const repoOk = await ensureRepository();
  if (!repoOk) {
    return { ok: false, message: '代码库准备失败' };
  }

  const depsOk = await ensureDependencies();
  if (!depsOk) {
    return { ok: false, message: '依赖安装失败' };
  }

  mmProcess = spawn(npxCmd, ['tsx', 'src/index.ts'], {
    cwd: projectRoot,
    shell: false,
    env: process.env,
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

app.whenReady().then(() => {
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('env:read', () => readEnv());
ipcMain.handle('env:write', (_, text) => {
  writeEnv(text);
  return { ok: true };
});
ipcMain.handle('mm:start', async () => startMM());
ipcMain.handle('mm:stop', () => stopMM());
ipcMain.handle('mm:status', () => ({ running: Boolean(mmProcess) }));
ipcMain.handle('template:apply', async (_, venue) => {
  if (venue !== 'predict' && venue !== 'probable') {
    return { ok: false, message: 'invalid venue' };
  }

  sendLog('🔧 正在准备代码库...');
  const repoOk = await ensureRepository();
  if (!repoOk) {
    return { ok: false, message: '代码库准备失败，请检查网络连接' };
  }

  const depsOk = await ensureDependencies();
  if (!depsOk) {
    return { ok: false, message: '依赖安装失败' };
  }

  return await runCommand('node', ['scripts/apply-mm-template.mjs', venue], 'template', true);
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
