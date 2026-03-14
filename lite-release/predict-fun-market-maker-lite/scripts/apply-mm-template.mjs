#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    template: '',
    envPath: path.join(projectRoot, '.env'),
    dryRun: false,
  };
  const rest = [...argv];
  while (rest.length > 0) {
    const token = rest.shift();
    if (!token) continue;
    if (!args.template && !token.startsWith('--')) {
      args.template = token.toLowerCase();
      continue;
    }
    if (token === '--env') {
      const value = rest.shift();
      if (!value) throw new Error('--env 需要路径');
      args.envPath = path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
      continue;
    }
    if (token === '--dry-run') {
      args.dryRun = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }
    throw new Error(`未知参数: ${token}`);
  }
  return args;
}

function printHelp() {
  console.log(
    [
      '用法:',
      '  node scripts/apply-mm-template.mjs <predict|polymarket> [--env <path>] [--dry-run]',
      '',
      '说明:',
      '  1) 模板只保留“需要用户填写”的字段（中文注释）',
      '  2) 官方 API/WS 使用文档默认值，其余参数走统一做市策略默认值',
      '',
      '示例:',
      '  node scripts/apply-mm-template.mjs predict',
      '  node scripts/apply-mm-template.mjs polymarket --env .env',
    ].join('\n')
  );
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

function pick(existing, key, placeholder = '') {
  const value = (existing.get(key) || '').trim();
  if (!value) return placeholder;
  const lower = value.toLowerCase();
  if (lower.includes('your_') || lower.includes('placeholder') || lower.includes('请填写')) {
    return placeholder;
  }
  return value;
}

function buildPredictTemplate(existing) {
  const apiKey = pick(existing, 'API_KEY', '请填写你的_API_KEY');
  const privateKey = pick(existing, 'PRIVATE_KEY', '请填写你的钱包私钥');
  const jwtToken = pick(existing, 'JWT_TOKEN', '请填写你的_JWT_TOKEN（仅实盘必填）');
  const account = pick(existing, 'PREDICT_ACCOUNT_ADDRESS', '请填写 Predict 网站里的 deposit address');
  const marketIds = pick(existing, 'MARKET_TOKEN_IDS', '');

  return `# ==============================
# Predict 做市模板（统一策略）
# 只展示你需要填写的字段；其余参数使用系统统一策略默认值
# ==============================

# ---- 需要你填写（必填） ----
# [需自行获取] Predict API Key（必填）
API_KEY=${apiKey}
# [需自行获取] 钱包私钥（必填）
PRIVATE_KEY=${privateKey}
# [需自行获取] Predict 私有接口 JWT（仅 ENABLE_TRADING=true 实盘时必填）
JWT_TOKEN=${jwtToken}
# [需自行获取] Predict 账户地址（实盘必填，必须填写网站里显示的 deposit address）
PREDICT_ACCOUNT_ADDRESS=${account}

# ---- 官方默认 API / WS（直接使用）----
API_BASE_URL=https://api.predict.fun
PREDICT_WS_URL=wss://ws.predict.fun/ws

# ---- 统一做市策略开关（自动）----
MM_VENUE=predict
MM_REQUIRE_JWT=true
POLYMARKET_WS_ENABLED=false
PREDICT_WS_ENABLED=true
MM_WS_ENABLED=true

ENABLE_TRADING=false
AUTO_CONFIRM=false

# ---- 市场筛选（可选）----
MARKET_TOKEN_IDS=${marketIds}
`;
}

function buildPolymarketTemplate(existing) {
  const privateKey = pick(existing, 'POLYMARKET_PRIVATE_KEY', '请填写你的 Polymarket 私钥（必填）');
  const legacyPrivateKey = pick(existing, 'PRIVATE_KEY', '');
  const apiKey = pick(existing, 'POLYMARKET_API_KEY', '');
  const apiSecret = pick(existing, 'POLYMARKET_API_SECRET', '');
  const apiPassphrase = pick(existing, 'POLYMARKET_API_PASSPHRASE', '');
  const funderAddress = pick(existing, 'POLYMARKET_FUNDER_ADDRESS', '请填写你的 Polymarket Profile Address / Funder Address（建议填写）');
  const signatureType = pick(existing, 'POLYMARKET_SIGNATURE_TYPE', '0');
  const marketIds = pick(existing, 'MARKET_TOKEN_IDS', '');

  return `# ==============================
# Polymarket 做市模板（统一策略）
# 只展示你需要填写的字段；其余参数使用系统统一策略默认值
# ==============================

# ---- 需要你填写（必填） ----
# [需自行获取] Polymarket 私钥（必填）
POLYMARKET_PRIVATE_KEY=${privateKey}
# 兼容字段（可留空；如有值可与 POLYMARKET_PRIVATE_KEY 一致）
PRIVATE_KEY=${legacyPrivateKey}
# [可选] 已有 API 凭证；留空则默认自动派生
POLYMARKET_API_KEY=${apiKey}
POLYMARKET_API_SECRET=${apiSecret}
POLYMARKET_API_PASSPHRASE=${apiPassphrase}
# [建议填写] Polymarket Profile Address / Funder Address（用于查询持仓、挂单归属）
POLYMARKET_FUNDER_ADDRESS=${funderAddress}
# [建议填写] 签名类型：0=EOA/浏览器钱包，1=Magic/邮箱登录
POLYMARKET_SIGNATURE_TYPE=${signatureType}

# ---- 官方默认 API / WS（直接使用）----
MM_VENUE=polymarket
POLYMARKET_GAMMA_URL=https://gamma-api.polymarket.com
POLYMARKET_CLOB_URL=https://clob.polymarket.com
POLYMARKET_WS_URL=wss://ws-subscriptions-clob.polymarket.com/ws/market
POLYMARKET_CHAIN_ID=137
POLYMARKET_AUTO_DERIVE_API_KEY=true
POLYMARKET_MAX_MARKETS=120

# ---- 统一做市策略开关（自动）----
MM_REQUIRE_JWT=false
POLYMARKET_WS_ENABLED=true
PREDICT_WS_ENABLED=false
MM_WS_ENABLED=true

ENABLE_TRADING=false
AUTO_CONFIRM=false

# ---- 市场筛选（可选）----
MARKET_TOKEN_IDS=${marketIds}
`;
}

function ensureEnvFile(envPath) {
  if (fs.existsSync(envPath)) return;
  const example = path.join(projectRoot, '.env.example');
  if (!fs.existsSync(example)) {
    throw new Error(`找不到 .env 与 .env.example: ${envPath}`);
  }
  fs.copyFileSync(example, envPath);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.template || !['predict', 'polymarket'].includes(args.template)) {
    printHelp();
    process.exit(1);
  }

  ensureEnvFile(args.envPath);
  const current = fs.readFileSync(args.envPath, 'utf8');
  const existing = parseEnv(current);
  const next = args.template === 'predict' ? buildPredictTemplate(existing) : buildPolymarketTemplate(existing);

  if (!args.dryRun) {
    if (fs.existsSync(args.envPath)) {
      const backup = `${args.envPath}.bak.${Date.now()}`;
      fs.copyFileSync(args.envPath, backup);
      console.log(`已备份旧配置: ${backup}`);
    }
    fs.writeFileSync(args.envPath, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
  }

  console.log(`${args.dryRun ? '[DRY-RUN] ' : ''}已生成 ${args.template} 模板: ${args.envPath}`);
  console.log('模板特点: 只展示需填写字段（中文注释）+ 官方默认 API/WS + 统一策略默认值。');
}

main();
