/**
 * Predict.fun 做市商控制台 - 主进程
 * 
 * 功能：
 * 1. 一键启动/停止做市商
 * 2. 保守/激进模式切换（修改.env）
 * 3. 实时日志推送
 * 4. 系统状态检查
 * 5. 市场浏览与推荐
 * 6. JWT Token 获取（Predict.fun）
 * 7. Polymarket 平台配置
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
const https = require('https');
const http = require('http');

// 简易JSON存储（替代electron-store）
const STORE_PATH = path.join(app.getPath('userData'), 'config.json');
const store = {
  _data: {},
  _load() { try { this._data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8')); } catch { this._data = {}; } },
  _save() { try { fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true }); fs.writeFileSync(STORE_PATH, JSON.stringify(this._data, null, 2)); } catch {} },
  get(key) { this._load(); return this._data[key]; },
  set(key, val) { this._load(); this._data[key] = val; this._save(); },
  delete(key) { this._load(); delete this._data[key]; this._save(); },
};
let mainWindow = null;
let appProcess = null;

// ==================== 窗口 ====================

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 860,
    minWidth: 900,
    minHeight: 700,
    title: 'Predict.fun 做市商控制台',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#0d0f1a',
    titleBarStyle: 'hiddenInset',
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ==================== 项目路径 ====================

function getProjectPath() {
  let projectPath = store.get('projectPath');
  if (!projectPath) {
    // 打包模式：runtime-dist 被 extraResources 复制到 resources/runtime-dist/
    const resourcesPath = path.dirname(app.getAppPath());
    const runtimePath = path.join(resourcesPath, 'runtime-dist');
    if (fs.existsSync(runtimePath)) {
      projectPath = runtimePath;
    } else {
      // fallback: asarUnpack 旧路径
      const unpackedPath = path.join(resourcesPath, 'app.asar.unpacked', 'runtime-dist');
      if (fs.existsSync(unpackedPath)) {
        projectPath = unpackedPath;
      } else {
        // fallback: 开发模式
        projectPath = path.resolve(__dirname, '..');
        if (!fs.existsSync(path.join(projectPath, 'package.json'))) {
          const devRuntime = path.resolve(__dirname, 'runtime-dist');
          if (fs.existsSync(devRuntime)) {
            projectPath = devRuntime;
          }
        }
      }
    }
    store.set('projectPath', projectPath);
  }
  return projectPath;
}

// 获取 .env 路径（用户数据目录，可读写）
function getEnvPath() {
  const userDataDir = app.getPath('userData');
  const userDataEnv = path.join(userDataDir, '.env');
  
  if (fs.existsSync(userDataEnv)) {
    return userDataEnv;
  }
  
  // 打包后不再包含 .env，创建空模板
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    const template = `# Predict.fun 市场做市商配置
# 请填写以下配置后保存
API_KEY=your_api_key_here
API_BASE_URL=https://api.predict.fun
PRIVATE_KEY=your_private_key_here
PREDICT_ACCOUNT_ADDRESS=your_account_address_here
RPC_URL=https://bsc-dataseed.binance.org
JWT_TOKEN=
MM_TRADING_MODE=conservative
MM_VENUE=predict
POLYMARKET_ENABLED=false
POLYMARKET_API_KEY=
POLYMARKET_PRIVATE_KEY=
POLYMARKET_FUNDER_ADDRESS=
MARKET_TOKEN_IDS=
`;
    fs.writeFileSync(userDataEnv, template, 'utf-8');
  } catch (e) {
    console.error('创建 .env 模板失败:', e);
  }
  
  return userDataEnv;
}

function getWatchlistPath() {
  return path.join(app.getPath('userData'), 'watchlist.json');
}

function getFlagPath() {
  return path.join(app.getPath('userData'), 'emergency-cancel.flag');
}

// ==================== .env 读写 ====================

function readEnv() {
  const envPath = getEnvPath();
  if (!fs.existsSync(envPath)) return {};
  const content = fs.readFileSync(envPath, 'utf-8');
  const config = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex < 0) continue;
    const key = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1).trim();
    // 剥离引号（.env里 KEY="value" 或 KEY='value' 都支持）
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    config[key] = value;
  }
  return config;
}

function writeEnv(key, value) {
  const envPath = getEnvPath();
  let content = '';
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, 'utf-8');
  }
  
  const lines = content.split('\n');
  let found = false;
  
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex < 0) continue;
    const existingKey = trimmed.substring(0, eqIndex).trim();
    if (existingKey === key) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }
  
  if (!found) {
    lines.push(`${key}=${value}`);
  }
  
  fs.writeFileSync(envPath, lines.join('\n'), 'utf-8');
}

// ==================== 进程管理 ====================

function startMainApp() {
  if (appProcess) {
    return { success: false, message: '做市商已在运行中' };
  }

  try {
    const projectPath = getProjectPath();

    if (!fs.existsSync(projectPath)) {
      throw new Error('项目路径不存在: ' + projectPath);
    }

    const packageJson = path.join(projectPath, 'package.json');
    if (!fs.existsSync(packageJson)) {
      throw new Error('package.json 缺失');
    }

    const platform = process.platform;
    const command = platform === 'win32' ? 'npm.cmd' : 'npm';
    
    appProcess = spawn(command, ['run', 'start:cli'], {
      cwd: projectPath,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // 允许杀死整个进程组（包括tsx/node子进程）
    });

    const pushLog = (data, type) => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('app-log', { text: data.toString(), type });
        }
      } catch (_) {}
    };

    appProcess.stdout.on('data', (d) => pushLog(d, 'out'));
    appProcess.stderr.on('data', (d) => pushLog(d, 'err'));

    appProcess.on('close', (code) => {
      pushLog(Buffer.from(`进程退出 (code=${code})`), 'exit');
      appProcess = null;
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('app-log', { text: '__EXIT__', type: 'exit' });
        }
      } catch (_) {}
    });

    appProcess.on('error', (err) => {
      pushLog(Buffer.from(err.message), 'err');
      appProcess = null;
    });

    return { success: true, message: '做市商已启动' };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

function stopMainApp() {
  if (!appProcess) {
    return { success: false, message: '没有运行中的做市商' };
  }
  try {
    const pid = appProcess.pid;
    if (process.platform === 'win32') {
      execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      // detached模式下杀整个进程组（npm + tsx + node），不留orphan
      try { process.kill(-pid, 'SIGTERM'); } catch (_) {
        // fallback: 只杀主进程
        appProcess.kill('SIGTERM');
      }
    }
    appProcess = null;
    return { success: true, message: '做市商已停止' };
  } catch (error) {
    appProcess = null;
    return { success: false, message: error.message };
  }
}

// ==================== 系统检查 ====================

function checkSystemEnvironment() {
  const checks = { node: false, npm: false, projectPath: false, envFile: false };
  try {
    execSync('node --version', { stdio: 'ignore' });
    checks.node = true;
  } catch (_) {}
  try {
    execSync('npm --version', { stdio: 'ignore' });
    checks.npm = true;
  } catch (_) {}
  try {
    const projectPath = getProjectPath();
    checks.projectPath = fs.existsSync(projectPath);
    checks.envFile = fs.existsSync(getEnvPath());
  } catch (_) {}
  return checks;
}

// ==================== HTTP 请求工具 ====================

function httpGet(urlStr, headers = {}, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(url, { headers, timeout }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${parsed?.message || parsed?.error || JSON.stringify(parsed)}`));
          } else {
            resolve({ status: res.statusCode, data: parsed });
          }
        } catch {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          } else {
            resolve({ status: res.statusCode, data: data });
          }
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function httpPost(urlStr, body, headers = {}, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const mod = url.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers },
      timeout,
    };
    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${parsed?.message || parsed?.error || JSON.stringify(parsed)}`));
          } else {
            resolve({ status: res.statusCode, data: parsed });
          }
        } catch {
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
          } else {
            resolve({ status: res.statusCode, data: data });
          }
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

// ==================== 市场浏览 ====================

async function fetchPredictMarkets() {
  const env = readEnv();
  const baseUrl = (env.API_BASE_URL || 'https://api.predict.fun').replace(/\/+$/, '');
  const apiKey = env.API_KEY || env.PREDICT_API_KEY || '';
  
  if (!apiKey) {
    throw new Error('未配置 API_KEY，请在认证面板中设置 Predict.fun API Key');
  }
  
  const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey };
  
  const collected = [];
  let after = undefined;
  let lastError = null;
  
  for (let page = 0; page < 20; page++) {
    const params = new URLSearchParams({ status: 'OPEN', limit: '100' });
    if (after) params.set('after', after);
    
    try {
      const res = await httpGet(`${baseUrl}/v1/markets?${params}`, headers);
      const payload = res.data?.data ?? res.data;
      const markets = Array.isArray(payload) ? payload : (payload?.markets ?? payload?.list ?? []);
      if (markets.length === 0) break;
      collected.push(...markets);
      const cursor = payload?.cursor ?? payload?.data?.cursor;
      if (!cursor) break;
      after = cursor;
    } catch (err) {
      lastError = err;
      console.log(`[fetchPredictMarkets] /v1/markets failed: ${err.message}`);
      // fallback to /markets
      try {
        const res = await httpGet(`${baseUrl}/markets?${params}`, headers);
        const payload = res.data?.data ?? res.data;
        const markets = Array.isArray(payload) ? payload : (payload?.markets ?? []);
        if (markets.length === 0) break;
        collected.push(...markets);
        const cursor = payload?.cursor;
        if (!cursor) break;
        after = cursor;
      } catch (err2) {
        lastError = err2;
        console.log(`[fetchPredictMarkets] fallback /markets failed: ${err2.message}`);
        break;
      }
    }
  }
  
  if (collected.length === 0 && lastError) {
    throw new Error(`获取市场失败: ${lastError.message}`);
  }
  
  // Normalize markets
  let markets = collected.map(m => {
    // API returns conditionId as market ID, but token_id is in outcomes[0].onChainId
    const outcomes = Array.isArray(m.outcomes) ? m.outcomes : [];
    const firstOutcome = outcomes[0];
    // token_id for orderbook API should be outcomes[0].onChainId
    const tokenId = firstOutcome?.onChainId || m.token_id || m.tokenId || m.clob_token_id || m.conditionId || '';
    
    // New API structure: spreadThreshold (decimal, e.g. 0.06 = 6c), shareThreshold, isBoosted
    const maxSpreadCents = m.spreadThreshold ? Math.round(m.spreadThreshold * 100) : 0;
    const minShares = m.shareThreshold || 0;
    // 更健壮的积分检查：任何指示有积分的字段
    const pointsActive = !!(m.isBoosted || m.rewardsEnabled || m.liquidity_activation || 
                          m.liquidityActivation || m.spreadThreshold || m.boostEndsAt ||
                          (m.rewards && m.rewards.enabled) || maxSpreadCents > 0);
    
    // Extract best bid/ask from first outcome - API returns { price, size } objects
    let bestBid = null;
    let bestAsk = null;
    if (firstOutcome?.bestBid && typeof firstOutcome.bestBid === 'object') {
      bestBid = Number(firstOutcome.bestBid.price ?? 0) || null;
    } else {
      bestBid = m.best_bid || m.bestBid || null;
    }
    if (firstOutcome?.bestAsk && typeof firstOutcome.bestAsk === 'object') {
      bestAsk = Number(firstOutcome.bestAsk.price ?? 0) || null;
    } else {
      bestAsk = m.best_ask || m.bestAsk || null;
    }
    
    return {
      token_id: tokenId,
      conditionId: m.conditionId,
      question: m.question || m.title || m.name || '',
      description: (m.description || '').substring(0, 200),
      venue: 'predict',
      end_date: m.end_date || m.endDate || m.boostEndsAt || '',
      volume_24h: m.volume_24h || m.volume24h || (m.stats?.volume24hr) || 0,
      outcome: m.outcome || '',
      outcomes: outcomes.map(o => ({
        token_id: o.token_id || o.tokenId || o.onChainId || '',
        outcome: o.outcome || o.name || '',
        price: o.price || 0,
      })),
      points_active: pointsActive,
      max_spread_cents: maxSpreadCents,
      min_shares: minShares,
      best_bid: bestBid,
      best_ask: bestAsk,
      spread_pct: (bestBid && bestAsk) ? ((bestAsk - bestBid) / bestBid) * 100 : null,
    };
  }).filter(m => (m.token_id || m.conditionId) && m.question);

  return markets;
}

async function fetchPolymarketMarkets() {
  try {
    // Use Gamma API to get active markets with rewards
    const res = await httpGet('https://gamma-api.polymarket.com/markets?closed=false&order=volume24hr&ascending=false&limit=100');
    const rawMarkets = res.data?.data ?? res.data;
    const markets = Array.isArray(rawMarkets) ? rawMarkets : [];
    
    return markets.map(m => {
      let clobTokenIds = [], outcomes = [], outcomePrices = [];
      try { clobTokenIds = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : []; } catch {}
      try { outcomes = m.outcomes ? JSON.parse(m.outcomes) : []; } catch {}
      try { outcomePrices = m.outcomePrices ? JSON.parse(m.outcomePrices) : []; } catch {}
      
      return {
        token_id: clobTokenIds[0] || m.conditionId || '',
        question: m.question || '',
        description: (m.description || '').substring(0, 200),
        venue: 'polymarket',
        end_date: m.endDate || m.end_date_iso || '',
        volume_24h: parseFloat(m.volume24hr || 0),
        outcome: outcomes[0] || '',
        outcomes: outcomes.map((o, i) => ({
          token_id: clobTokenIds[i] || '',
          outcome: o,
          price: parseFloat(outcomePrices[i] || 0),
        })),
        points_active: !!(m.rewardsEnabled || m.active),
        max_spread_cents: 0,
        min_shares: 0,
        polymarket_slug: m.slug || '',
        polymarket_rewards: m.rewardsEnabled || false,
        polymarket_daily_rate: parseFloat(m.rewardDailyRate || 0),
      };
    }).filter(m => m.token_id && m.question);
  } catch (err) {
    return { error: err.message };
  }
}

// ==================== JWT 获取 ====================

async function fetchPredictJwt() {
  const env = readEnv();
  const baseUrl = (env.API_BASE_URL || 'https://api.predict.fun').replace(/\/+$/, '');
  const apiKey = env.API_KEY || env.PREDICT_API_KEY || '';
  const privateKey = env.PRIVATE_KEY || '';
  const accountAddress = env.PREDICT_ACCOUNT_ADDRESS || '';
  
  if (!apiKey) return { success: false, message: 'API_KEY 未配置，请在认证面板中设置' };
  if (!privateKey || privateKey === '0x0000000000000000000000000000000000000000000000000000000000000001') {
    return { success: false, message: 'PRIVATE_KEY 未配置或为占位符' };
  }
  
  const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey };
  
  async function retryHttp(fn, retries = 3, delayMs = 2000) {
    for (let i = 0; i < retries; i++) {
      try { return await fn(); }
      catch (err) {
        if (i === retries - 1) throw err;
        console.log(`[JWT] 重试 ${i+1}/${retries-1} (${err.message})...`);
        await new Promise(r => setTimeout(r, delayMs * (i + 1)));
      }
    }
  }
  
  try {
    // Step 1: Get auth message
    let message = '';
    try {
      const res = await retryHttp(() => httpGet(`${baseUrl}/v1/auth/message`, headers));
      const payload = res.data?.data ?? res.data;
      message = typeof payload === 'string' ? payload : String(payload?.message || '');
    } catch {
      const res = await retryHttp(() => httpGet(`${baseUrl}/auth/message`, headers));
      const payload = res.data?.data ?? res.data;
      message = typeof payload === 'string' ? payload : String(payload?.message || '');
    }
    
    if (!message) {
      return { success: false, message: '无法获取 auth message，请检查 API_KEY' };
    }
    
    // Step 2: Sign message using ethers (require from project)
    const projectPath = getProjectPath();
    let signature = '';
    let signerAddress = accountAddress;
    
    // Validate address: reject placeholder / zero addresses
    const isValidAddr = /^0x[0-9a-fA-F]{40}$/.test(accountAddress || '') && (accountAddress || '').toLowerCase() !== '0x' + '0'.repeat(40);
    if (!isValidAddr) {
      signerAddress = '';
    }
    
    try {
      // Try using the project's ethers dependency
      const ethersPath = path.join(projectPath, 'node_modules', 'ethers');
      if (!fs.existsSync(ethersPath)) {
        return { success: false, message: 'ethers 未安装，请先 npm install' };
      }
      
      // Use dynamic require
      const { Wallet } = require(ethersPath);
      const wallet = new Wallet(privateKey);
      if (!signerAddress) signerAddress = wallet.address;
      
      // Check if predict SDK is available for account signing
      let usedAccountSigner = false;
      if (isValidAddr) {
        try {
          const sdkPath = path.join(projectPath, 'node_modules', '@predictdotfun', 'sdk');
          if (fs.existsSync(sdkPath)) {
            const { OrderBuilder, ChainId } = require(sdkPath);
            const chainId = ChainId?.BnbMainnet ?? 56;
            const orderBuilder = await OrderBuilder.make(chainId, wallet, {
              predictAccount: accountAddress,
            });
            signature = await orderBuilder.signPredictAccountMessage(message);
            usedAccountSigner = true;
          }
        } catch (sdkErr) {
          console.log(`[JWT] PredictAccount signer failed: ${sdkErr.message}, falling back to EOA`);
        }
      }
      
      if (!usedAccountSigner) {
        signature = await wallet.signMessage(message);
        if (!signerAddress) signerAddress = wallet.address;
      }
    } catch (err) {
      return { success: false, message: '签名失败: ' + err.message };
    }
    
    // Step 3: Exchange for JWT
    let token = '';
    try {
      const res = await retryHttp(() => httpPost(`${baseUrl}/v1/auth`, { signer: signerAddress, signature, message }, headers));
      const data = res.data?.data ?? res.data;
      token = data?.token || data?.jwt || data?.accessToken || '';
    } catch {
      try {
        const res = await retryHttp(() => httpPost(`${baseUrl}/auth`, { signer: signerAddress, signature, message }, headers));
        const data = res.data?.data ?? res.data;
        token = data?.token || data?.jwt || data?.accessToken || '';
      } catch (err2) {
        return { success: false, message: 'JWT 请求失败: ' + err2.message };
      }
    }
    
    if (!token) {
      return { success: false, message: 'Auth 成功但未返回 token' };
    }
    
    // Step 4: Write to .env
    writeEnv('JWT_TOKEN', token);
    
    return { 
      success: true, 
      message: `JWT 获取成功! Signer: ${signerAddress.slice(0, 10)}...`,
      token: token.slice(0, 20) + '...',
      signer: signerAddress,
    };
  } catch (err) {
    return { success: false, message: 'JWT 获取失败: ' + err.message };
  }
}

// ==================== 市场推荐与筛选 ====================

function recommendMarkets(markets, mode) {
  const isConservative = mode !== 'aggressive';
  
  return markets.map(m => {
    let score = 0;
    let reasons = [];
    const maxSpread = m.max_spread_cents || 0;
    const minShares = m.min_shares || 100;
    const bookSpread = m.best_bid && m.best_ask ? 
      (m.best_ask - m.best_bid) * 100 : 999;
    const bufferPerSide = maxSpread > 0 && bookSpread < 999 ? (maxSpread - bookSpread) / 2 : 0;
    
    // ===== Layer 0: Points active = essential =====
    if (!m.points_active || maxSpread <= 0) {
      return { ...m, score: -50, reasons: ['无积分规则'], recommended: false };
    }
    score += 20;
    reasons.push('有积分(' + maxSpread + 'c/' + minShares + '股)');
    
    // ===== Layer 1: 简化筛选：只检查盘口价差是否超过积分上限 =====
    if (bookSpread > maxSpread) {
      return { ...m, score: 0, reasons: [...reasons, '盘口价差超过积分上限'], recommended: false };
    }
    
    // ===== Layer 2: Buffer quality scoring =====
    score += Math.min(25, Math.floor(bufferPerSide * 4));
    reasons.push('缓冲' + bufferPerSide.toFixed(1) + 'c');
    
    // Buffer utilization: lower is better (more room to quote)
    const bufferUtilization = bookSpread / maxSpread;
    if (bufferUtilization < 0.3) {
      score += 10;
      reasons.push('盘口宽松');
    } else if (bufferUtilization > 0.7) {
      score -= 5;
      reasons.push('盘口拥挤');
    }
    
    // ===== Layer 3: Points efficiency scoring =====
    const pointsEfficiency = (bufferPerSide / Math.max(minShares, 1)) * 1000;
    score += Math.min(20, Math.floor(pointsEfficiency * 2));
    
    // min_shares越低，资金门槛越低，评分越高
    if (minShares <= 50) {
      score += 15;
      reasons.push('低门槛(' + minShares + '股)');
    } else if (minShares <= 100) {
      score += 10;
      reasons.push('门槛低(' + minShares + '股)');
    } else if (minShares <= 200) {
      score += 5;
      reasons.push('门槛中等');
    } else {
      score -= 5;
      reasons.push('门槛高(' + minShares + '股)');
    }
    
    // max_spread奖励：更大的max_spread = 更大的盈利空间
    if (maxSpread >= 8) {
      score += 8;
      reasons.push('宽价差(' + maxSpread + 'c)');
    } else if (maxSpread >= 6) {
      score += 5;
      reasons.push('标准价差');
    }
    
    // ===== Layer 4: Liquidity scoring =====
    const vol = m.volume_24h || 0;
    if (vol > 50000) {
      score += 15;
      reasons.push('极高流动性');
    } else if (vol > 20000) {
      score += 12;
      reasons.push('高流动性');
    } else if (vol > 10000) {
      score += 8;
      reasons.push('中高流动性');
    } else if (vol > 2000) {
      score += 4;
      reasons.push('中等流动性');
    } else if (vol > 500) {
      score += 1;
    } else {
      score -= 10;
      reasons.push('低流动性警告');
    }
    
    // ===== Layer 5: Time risk scoring =====
    if (m.end_date) {
      const daysLeft = (new Date(m.end_date) - Date.now()) / 86400000;
      if (daysLeft > 30) {
        score += 8;
        reasons.push('长期市场');
      } else if (daysLeft > 14) {
        score += 10;
        reasons.push(`${Math.floor(daysLeft)}天后到期`);
      } else if (daysLeft > 7) {
        score += 5;
        reasons.push('2周内到期');
      } else if (daysLeft > 3) {
        score += 2;
        reasons.push('1周内到期⚠️');
      } else if (daysLeft > 1) {
        score -= 10;
        reasons.push('3天内到期❗');
      } else {
        score -= 30;
        reasons.push('24h内到期🚫');
      }
    }
    
    // ===== Layer 6: Price quality (if available) =====
    if (m.best_bid && m.best_ask) {
      const midPrice = (m.best_bid + m.best_ask) / 2;
      // 避免极端价格市场（接近0或1）
      if (midPrice > 0.1 && midPrice < 0.9) {
        score += 3;
      } else if (midPrice < 0.05 || midPrice > 0.95) {
        score -= 5;
        reasons.push('极端价格');
      }
    }
    
    return { ...m, score, reasons, recommended: score >= 45 };
  }).sort((a, b) => b.score - a.score);
}

// ==================== IPC ====================

// ==================== IPC Handlers ====================
// 所有handler统一try-catch，防止单个报错让前端卡死

function safeHandle(channel, fn) {
  ipcMain.handle(channel, async (...args) => {
    try { return await fn(...args); }
    catch (e) { return { success: false, message: e?.message || String(e) }; }
  });
}

safeHandle('start-app', async () => startMainApp());
safeHandle('stop-app', async () => stopMainApp());
safeHandle('get-app-status', async () => ({ running: !!appProcess, pid: appProcess?.pid ?? null }));

// 紧急撤单: 写入 flag 文件，子进程定期检查
safeHandle('emergency-cancel-all', async () => {
  if (!appProcess) {
    return { success: false, message: '没有运行中的做市商' };
  }
  const flagPath = getFlagPath();
  fs.writeFileSync(flagPath, String(Date.now()), 'utf-8');
  console.log('[紧急撤单] 已发送撤单信号');
  return { success: true, message: '撤单信号已发送，做市商正在执行' };
});

safeHandle('open-project-folder', async () => { shell.openPath(getProjectPath()); return { success: true }; });
safeHandle('open-config-file', async () => {
  const envPath = getEnvPath();
  shell.openPath(envPath);
  return { success: true };
});
safeHandle('check-system', async () => checkSystemEnvironment());
safeHandle('get-project-path', async () => getProjectPath());
safeHandle('set-project-path', async (_, p) => { store.set('projectPath', p); return { success: true }; });
safeHandle('select-project-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow || undefined, { properties: ['openDirectory'], title: '选择项目文件夹' });
  if (!result.canceled && result.filePaths.length > 0) {
    store.set('projectPath', result.filePaths[0]);
    return { success: true, path: result.filePaths[0] };
  }
  return { success: false };
});

safeHandle('get-config', async () => readEnv());
safeHandle('set-config', async (_, key, value) => { writeEnv(key, value); return { success: true }; });
safeHandle('set-trading-mode', async (_, mode) => {
  if (mode !== 'conservative' && mode !== 'aggressive') {
    return { success: false, message: '无效模式' };
  }
  writeEnv('MM_TRADING_MODE', mode);
  return { success: true };
});

// ===== 市场 =====
safeHandle('fetch-predict-markets', async () => {
  const markets = await fetchPredictMarkets();
  return { success: true, markets };
});

safeHandle('fetch-polymarket-markets', async () => {
  const result = await fetchPolymarketMarkets();
  if (result.error) return { success: false, message: result.error, markets: [] };
  return { success: true, markets: result };
});

safeHandle('recommend-markets', async (_, markets, mode) => {
  return recommendMarkets(markets, mode);
});

safeHandle('apply-market-selection', async (_, tokenIdsStr) => {
  // 将选中的 token_ids 写入 .env 的 MARKET_TOKEN_IDS
  if (!tokenIdsStr || typeof tokenIdsStr !== 'string') {
    return { success: false, message: '无效的市场ID列表' };
  }
  const envPath = getEnvPath();
  let envContent = '';
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf-8');
  }
  // 更新或添加 MARKET_TOKEN_IDS
  const newLine = ['MARKET_TOKEN_IDS=', tokenIdsStr].join('');
  const idx = envContent.indexOf('MARKET_TOKEN_IDS=');
  if (idx >= 0) {
    const endIdx = envContent.indexOf('\n', idx);
    const oldLine = endIdx >= 0 ? envContent.substring(idx, endIdx) : envContent.substring(idx);
    envContent = envContent.split(oldLine).join(newLine);
  } else {
    envContent = [envContent.trimEnd(), newLine, ''].join('\n');
  }
  fs.writeFileSync(envPath, envContent, 'utf-8');
  const count = tokenIdsStr.split(',').filter(s => s.trim()).length;
  console.log(`[市场选择] 已写入 ${count} 个市场到 MARKET_TOKEN_IDS`);
  return { success: true, count };
});

safeHandle('add-market-to-watch', async (_, tokenId, question) => {
  const watchPath = getWatchlistPath();
  let watchlist = [];
  try {
    if (fs.existsSync(watchPath)) {
      watchlist = JSON.parse(fs.readFileSync(watchPath, 'utf-8'));
    }
  } catch {}
  if (!watchlist.find(w => w.token_id === tokenId)) {
    watchlist.push({ token_id: tokenId, question, added_at: Date.now() });
    fs.writeFileSync(watchPath, JSON.stringify(watchlist, null, 2));
  }
  return { success: true };
});

safeHandle('remove-market-from-watch', async (_, tokenId) => {
  const watchPath = getWatchlistPath();
  try {
    if (fs.existsSync(watchPath)) {
      let watchlist = JSON.parse(fs.readFileSync(watchPath, 'utf-8'));
      watchlist = watchlist.filter(w => w.token_id !== tokenId);
      fs.writeFileSync(watchPath, JSON.stringify(watchlist, null, 2));
    }
  } catch {}
  return { success: true };
});

safeHandle('get-watchlist', async () => {
  const watchPath = getWatchlistPath();
  try {
    if (fs.existsSync(watchPath)) {
      return { success: true, watchlist: JSON.parse(fs.readFileSync(watchPath, 'utf-8')) };
    }
  } catch {}
  return { success: true, watchlist: [] };
});

// ===== JWT =====
safeHandle('fetch-jwt', async () => {
  return await fetchPredictJwt();
});

safeHandle('get-jwt-status', async () => {
  const env = readEnv();
  const hasJwt = !!(env.JWT_TOKEN && env.JWT_TOKEN.length > 20);
  const hasApiKey = !!(env.API_KEY || env.PREDICT_API_KEY);
  const hasPrivateKey = !!(env.PRIVATE_KEY && env.PRIVATE_KEY !== '0x0000000000000000000000000000000000000000000000000000000000000001');
  const hasAccount = !!(env.PREDICT_ACCOUNT_ADDRESS);
  return { hasJwt, hasApiKey, hasPrivateKey, hasAccount };
});

// ===== Polymarket =====
safeHandle('set-platform', async (_, venue) => {
  if (venue !== 'predict' && venue !== 'polymarket' && venue !== 'both') {
    return { success: false, message: '无效平台' };
  }
  writeEnv('MM_VENUE', venue === 'both' ? 'predict' : venue);
  if (venue === 'both' || venue === 'polymarket') {
    writeEnv('POLYMARKET_ENABLED', 'true');
  } else {
    writeEnv('POLYMARKET_ENABLED', 'false');
  }
  return { success: true };
});

safeHandle('get-polymarket-status', async () => {
  const env = readEnv();
  return {
    enabled: env.POLYMARKET_ENABLED === 'true' || env.MM_VENUE === 'polymarket',
    hasApiKey: !!(env.POLYMARKET_API_KEY),
    hasPrivateKey: !!(env.POLYMARKET_PRIVATE_KEY),
    hasFunder: !!(env.POLYMARKET_FUNDER_ADDRESS),
    venue: env.MM_VENUE || 'predict',
  };
});

// ==================== 生命周期 ====================

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// 做市商运行中关闭窗口时杀进程组
app.on('window-all-closed', () => {
  if (appProcess) {
    console.log('🛑 做市商还在运行，发送 SIGTERM...');
    try {
      const pid = appProcess.pid;
      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
      } else {
        try { process.kill(-pid, 'SIGTERM'); } catch (_) { appProcess.kill('SIGTERM'); }
      }
    } catch (_) {}
    appProcess = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

// 窗口关闭前确保子进程被杀
app.on('before-quit', () => {
  if (appProcess) {
    try {
      const pid = appProcess.pid;
      if (process.platform === 'win32') {
        execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
      } else {
        try { process.kill(-pid, 'SIGTERM'); } catch (_) {}
      }
    } catch (_) {}
    appProcess = null;
  }
});

process.on('uncaughtException', (error) => console.error('未捕获的异常:', error));
process.on('unhandledRejection', (reason) => console.error('未处理的 Promise 拒绝:', reason));
