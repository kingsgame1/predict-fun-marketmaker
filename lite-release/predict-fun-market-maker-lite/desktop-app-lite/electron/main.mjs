import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 应用根目录（包含源代码）
const projectRoot = path.resolve(__dirname, '..');
const envPath = path.join(projectRoot, '.env');
const rendererPath = path.resolve(__dirname, '..', 'renderer', 'index.html');
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

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

// 模板应用功能（内嵌，避免 spawn 调用 ASAR 包内文件）
function applyTemplate(venue) {
  try {
    ensureEnvFile(envPath);
    const current = fs.readFileSync(envPath, 'utf8');
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

    fs.writeFileSync(envPath, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
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

function ensureEnvFile(filePath) {
  if (fs.existsSync(filePath)) return;
  const example = path.join(projectRoot, '.env.example');
  if (!fs.existsSync(example)) {
    fs.writeFileSync(filePath, '# PredictFun Market Maker Lite Configuration\n', 'utf8');
  } else {
    fs.copyFileSync(example, filePath);
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
