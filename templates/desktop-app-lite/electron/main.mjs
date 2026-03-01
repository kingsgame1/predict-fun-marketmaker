import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const envPath = path.join(projectRoot, '.env');
const rendererPath = path.resolve(__dirname, '..', 'renderer', 'index.html');
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function quoteWindowsArg(value) {
  const text = String(value ?? '');
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildSpawnSpec(command, args, extraOptions = {}) {
  const isWindowsCmdScript =
    process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(command || ''));

  if (isWindowsCmdScript) {
    const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
    const commandLine = [quoteWindowsArg(command), ...args.map((arg) => quoteWindowsArg(arg))].join(' ');
    return {
      command: comspec,
      args: ['/d', '/s', '/c', commandLine],
      options: {
        shell: false,
        ...extraOptions,
      },
    };
  }

  return {
    command,
    args,
    options: {
      shell: false,
      ...extraOptions,
    },
  };
}

/**
 * 获取用户的 shell PATH 环境变量
 * macOS GUI 应用不会继承用户的 shell PATH（如 nvm/fnm 路径）
 */
function getUserShellPath() {
  if (process.platform !== 'darwin') return process.env.PATH;

  try {
    // 获取用户的登录 shell 并执行 echo $PATH
    const userShell = process.env.SHELL || '/bin/zsh';
    const shellPath = execSync(`"${userShell}" -l -c 'echo $PATH'`, {
      encoding: 'utf8',
      timeout: 5000,
    }).trim();

    if (shellPath && shellPath.includes('/')) {
      console.log('[PATH] 已加载用户 shell PATH');
      return shellPath;
    }
  } catch (err) {
    console.warn('[PATH] 获取用户 shell PATH 失败:', err.message);
  }

  // 回退：尝试常见的 Node.js 安装位置
  const fallbackPaths = [
    '/usr/local/bin',
    '/opt/homebrew/bin',
    process.env.HOME + '/.nvm/versions/node/v25.2.1/bin',
    process.env.HOME + '/.nvm/versions/node/v22.14.0/bin',
    process.env.HOME + '/.nvm/versions/node/v20.18.3/bin',
    process.env.HOME + '/.fnm/node-versions/*/installation/bin',
  ].filter(Boolean);

  const existingPaths = (process.env.PATH || '').split(':');
  const merged = new Set([...existingPaths, ...fallbackPaths]);

  // 检查哪些路径实际存在且包含 node
  const validPaths = [...merged].filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  return validPaths.join(':');
}

// 在应用启动时设置 PATH
const userPath = getUserShellPath();
if (userPath) {
  process.env.PATH = userPath;
  console.log('[PATH] 环境变量已更新');
}

let win = null;
let mmProcess = null;

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
    const spawnSpec = buildSpawnSpec(command, args, { cwd: projectRoot, env: process.env });
    const child = spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options);
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
    child.on('error', (err) => resolve({ ok: false, code: 1, stdout, stderr: err.message }));
    child.on('exit', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

async function runRecommendJson(venue, { top = 40, scan = 80, apply = false } = {}) {
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

function startMM() {
  if (mmProcess) return { ok: false, message: '做市进程已在运行' };
  const spawnSpec = buildSpawnSpec(npxCmd, ['tsx', 'src/index.ts'], {
    cwd: projectRoot,
    env: process.env,
  });
  mmProcess = spawn(spawnSpec.command, spawnSpec.args, spawnSpec.options);
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
ipcMain.handle('mm:start', () => startMM());
ipcMain.handle('mm:stop', () => stopMM());
ipcMain.handle('mm:status', () => ({ running: Boolean(mmProcess) }));
ipcMain.handle('template:apply', async (_, venue) => {
  if (venue !== 'predict' && venue !== 'probable') {
    return { ok: false, message: 'invalid venue' };
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
ipcMain.handle('link:open', async (_, url) => {
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});
