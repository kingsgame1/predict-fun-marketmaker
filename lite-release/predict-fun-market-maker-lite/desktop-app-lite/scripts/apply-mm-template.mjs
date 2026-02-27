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
      '  node scripts/apply-mm-template.mjs <predict|probable> [--env <path>] [--dry-run]',
      '',
      '说明:',
      '  1) 模板只保留“需要用户填写”的字段（中文注释）',
      '  2) 官方 API/WS 使用文档默认值，其余参数走统一做市策略默认值',
      '',
      '示例:',
      '  node scripts/apply-mm-template.mjs predict',
      '  node scripts/apply-mm-template.mjs probable --env .env',
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
  if (
    lower.includes('your_') ||
    lower.includes('placeholder') ||
    lower.includes('请填写')
  ) {
    return placeholder;
  }
  return value;
}

function buildPredictTemplate(existing) {
  const apiKey = pick(existing, 'API_KEY', '请填写你的_API_KEY');
  const privateKey = pick(existing, 'PRIVATE_KEY', '请填写你的钱包私钥');
  const jwtToken = pick(existing, 'JWT_TOKEN', '请填写你的_JWT_TOKEN（仅实盘必填）');
  const account = pick(existing, 'PREDICT_ACCOUNT_ADDRESS', '');
  const marketIds = pick(existing, 'MARKET_TOKEN_IDS', '');

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
  const probableKey = pick(existing, 'PROBABLE_PRIVATE_KEY', '请填写你的_Probable_私钥（必填）');
  const privateKey = pick(existing, 'PRIVATE_KEY', '');
  const marketIds = pick(existing, 'MARKET_TOKEN_IDS', '');

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
  if (!args.template || !['predict', 'probable'].includes(args.template)) {
    printHelp();
    process.exit(1);
  }

  ensureEnvFile(args.envPath);
  const current = fs.readFileSync(args.envPath, 'utf8');
  const existing = parseEnv(current);

  const next =
    args.template === 'predict'
      ? buildPredictTemplate(existing)
      : buildProbableTemplate(existing);

  if (!args.dryRun) {
    if (fs.existsSync(args.envPath)) {
      const backup = `${args.envPath}.bak.${Date.now()}`;
      fs.copyFileSync(args.envPath, backup);
      console.log(`已备份旧配置: ${backup}`);
    }
    fs.writeFileSync(args.envPath, next.endsWith('\n') ? next : `${next}\n`, 'utf8');
  }

  console.log(
    `${args.dryRun ? '[DRY-RUN] ' : ''}已生成 ${args.template} 模板: ${args.envPath}`
  );
  console.log('模板特点: 只展示需填写字段（中文注释）+ 官方默认 API/WS + 统一策略默认值。');
}

main();
