import fs from 'node:fs';
import path from 'node:path';
import { Contract, JsonRpcProvider, Wallet, formatEther, formatUnits } from 'ethers';
import { PolymarketAPI } from '../src/api/polymarket-client.js';

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
];

const ERC1155_ABI = [
  'function isApprovedForAll(address account, address operator) view returns (bool)',
];

const POLYMARKET_CONTRACTS = {
  137: {
    nativeSymbol: 'POL',
    usdcSymbol: 'USDC.e',
    rpcUrl: 'https://polygon-rpc.com',
    usdcAddress: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
    ctfAddress: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
    exchangeAddress: '0x4bfb41d5B3570defd03C39a9A4d8de6bd8b8982e',
    negRiskExchangeAddress: '0xC5d563A36AE781c0D61d661e31bC790bbAD6dBeF',
    usdcDecimals: 6,
    minNativeBalance: 0.01,
  },
} as const;

const POLYMARKET_AUTH_DOC_URL = 'https://docs.polymarket.com/cn/api-reference/authentication';
const POLYMARKET_SETTINGS_URL = 'https://polymarket.com/settings';

type ChainId = keyof typeof POLYMARKET_CONTRACTS;
type Payload = Record<string, any>;

function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) continue;
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args.set(key, 'true');
      continue;
    }
    args.set(key, next);
    i += 1;
  }
  return args;
}

function parseEnv(text: string) {
  const map = new Map<string, string>();
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .forEach((line) => {
      if (!line || line.startsWith('#')) return;
      const idx = line.indexOf('=');
      if (idx < 0) return;
      map.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, ''));
    });
  return map;
}

function resolveEnvPath(args: Map<string, string>) {
  const explicit = args.get('--env') || process.env.ENV_PATH;
  if (explicit) return path.resolve(explicit);
  return path.resolve(process.cwd(), '.env');
}

function toBool(value: string | undefined, fallback = false) {
  if (value == null) return fallback;
  return String(value).trim().toLowerCase() === 'true';
}

function getRpcUrl(env: Map<string, string>, chainId: number) {
  const explicit = env.get('POLYMARKET_RPC_URL') || env.get('POLYGON_RPC_URL');
  if (explicit) return explicit;
  const chainConfig = POLYMARKET_CONTRACTS[chainId as ChainId];
  if (chainConfig?.rpcUrl) return chainConfig.rpcUrl;
  return env.get('RPC_URL') || '';
}

function createBasePayload(envPath: string, env: Map<string, string>): Payload {
  const chainId = Number(env.get('POLYMARKET_CHAIN_ID') || '137');
  const autoDeriveApiKey = toBool(env.get('POLYMARKET_AUTO_DERIVE_API_KEY'), true);
  const signatureType = Number(env.get('POLYMARKET_SIGNATURE_TYPE') || '0');
  const privateKey = env.get('POLYMARKET_PRIVATE_KEY') || env.get('PRIVATE_KEY') || '';
  const hasExplicitApiCreds = Boolean(env.get('POLYMARKET_API_KEY') && env.get('POLYMARKET_API_SECRET') && env.get('POLYMARKET_API_PASSPHRASE'));
  const credsMode = hasExplicitApiCreds ? 'explicit' : autoDeriveApiKey ? 'auto-derive' : 'missing';
  return {
    envPath,
    chainId,
    rpcUrl: getRpcUrl(env, chainId),
    signerAddress: '',
    funderAddress: String(env.get('POLYMARKET_FUNDER_ADDRESS') || '').trim(),
    signatureType,
    credsReady: false,
    openOrderQueryOk: false,
    openOrderCount: 0,
    preflightError: '',
    hasExplicitApiCreds,
    autoDeriveApiKey,
    credsMode,
    credsRequirement: 'Polymarket 用户 CLOB API 凭证（L2）',
    builderRelayerKeyRequired: false,
    credentialDocUrl: POLYMARKET_AUTH_DOC_URL,
    settingsUrl: POLYMARKET_SETTINGS_URL,
    credentialGuide: [] as string[],
    signerNativeSymbol: chainId === 137 ? 'POL' : 'native',
    signerNativeBalance: null,
    signerNativeBalanceWei: null,
    funderUsdcSymbol: chainId === 137 ? 'USDC.e' : 'stable',
    funderUsdcBalance: null,
    funderUsdcBalanceWei: null,
    usdcAllowance: null,
    usdcAllowanceWei: null,
    usdcAllowanceReady: false,
    usdcAllowanceSupported: false,
    exchangeApprovalReady: false,
    exchangeApprovalSupported: false,
    negRiskExchangeApprovalReady: false,
    negRiskExchangeApprovalSupported: false,
    warnings: [] as string[],
    coreIssues: [] as string[],
    coreReady: false,
    updatedAt: Date.now(),
    privateKeyPresent: Boolean(privateKey),
  };
}

function applyCredentialGuide(payload: Payload) {
  if (payload.credsReady) {
    payload.credentialGuide = [
      '当前 Polymarket 用户 CLOB API 凭证已就绪。当前脚本不需要 Builder/Relayer key。',
      '若后续更换钱包或 funder/profile，建议重新点击“检查 Polymarket 预检”，确认 open orders 查询与凭证仍可用。',
    ];
  } else if (payload.autoDeriveApiKey) {
    payload.credentialGuide = [
      '当前脚本实盘需要的是 Polymarket 用户 CLOB API 凭证（L2），不是 Builder/Relayer key。',
      '推荐先保持 POLYMARKET_AUTO_DERIVE_API_KEY=true，然后点击“检查 Polymarket 预检”；脚本会尝试用私钥自动创建或派生 API 凭证。',
      '如果自动派生失败：打开官方认证文档，按 Create API Credentials / Derive API Credentials 生成 POLYMARKET_API_KEY / POLYMARKET_API_SECRET / POLYMARKET_API_PASSPHRASE。',
      '如果报 funder/profile 相关错误，先打开 Polymarket Settings 确认或激活你的 Profile / Funder 地址，再重试。',
    ];
  } else {
    payload.credentialGuide = [
      '你已关闭自动派生；当前脚本实盘需要的是 Polymarket 用户 CLOB API 凭证（L2），不是 Builder/Relayer key。',
      '打开官方认证文档，按 Create API Credentials / Derive API Credentials 生成三项凭证。',
      '将生成的 POLYMARKET_API_KEY / POLYMARKET_API_SECRET / POLYMARKET_API_PASSPHRASE 填入 .env 后，再点击“检查 Polymarket 预检”。',
      '如果你使用 funder/profile 模式，先在 Polymarket Settings 确认对应地址有效。',
    ];
  }
}

function finalizePayload(payload: Payload) {
  if (!payload.credsReady && !payload.coreIssues.some((issue: string) => issue.includes('CLOB API 凭证未就绪'))) {
    payload.coreIssues.push('Polymarket 用户 CLOB API 凭证未就绪。当前脚本下单/撤单/查单需要用户 L2 API 凭证，不需要 Builder/Relayer key。可先保持 POLYMARKET_AUTO_DERIVE_API_KEY=true 自动派生；若仍失败，请按下方指引手动创建或派生后填写 POLYMARKET_API_KEY / SECRET / PASSPHRASE。');
  }
  applyCredentialGuide(payload);
  payload.coreReady = payload.coreIssues.length === 0;
}

function printPayload(payload: Payload, asJson: boolean) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  console.log(`Signer: ${payload.signerAddress || '--'}`);
  console.log(`Funder: ${payload.funderAddress || '--'}`);
  console.log(`SignatureType: ${payload.signatureType}`);
  console.log(`API Creds: ${payload.credsReady ? 'ready' : 'missing'}`);
  console.log(`Open Orders: ${payload.openOrderCount}`);
  if (payload.signerNativeBalance != null) {
    console.log(`Native Balance: ${payload.signerNativeBalance} ${payload.signerNativeSymbol}`);
  }
  if (payload.funderUsdcBalance != null) {
    console.log(`USDC.e Balance: ${payload.funderUsdcBalance} ${payload.funderUsdcSymbol}`);
  }
  if (payload.usdcAllowance != null) {
    console.log(`Allowance: ${payload.usdcAllowance} ${payload.funderUsdcSymbol}`);
  }
  if (payload.coreIssues.length > 0) {
    console.log(`Core Issues: ${payload.coreIssues.join(' | ')}`);
  }
  if (payload.warnings.length > 0) {
    console.log(`Warnings: ${payload.warnings.join(' | ')}`);
  }
  if (payload.credentialGuide.length > 0) {
    console.log(`Guide: ${payload.credentialGuide.join(' | ')}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envPath = resolveEnvPath(args);
  const asJson = args.get('--json') === 'true';
  const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const env = parseEnv(envText);
  const payload = createBasePayload(envPath, env);

  const privateKey = env.get('POLYMARKET_PRIVATE_KEY') || env.get('PRIVATE_KEY') || '';
  const clobUrl = env.get('POLYMARKET_CLOB_URL') || 'https://clob.polymarket.com';
  const gammaUrl = env.get('POLYMARKET_GAMMA_URL') || 'https://gamma-api.polymarket.com';
  const chainId = payload.chainId;
  const chainConfig = POLYMARKET_CONTRACTS[chainId as ChainId];

  if (payload.signatureType !== 0 && !String(env.get('POLYMARKET_FUNDER_ADDRESS') || '').trim()) {
    payload.coreIssues.push('POLYMARKET_SIGNATURE_TYPE 非 0 时必须填写 POLYMARKET_FUNDER_ADDRESS。');
  }

  if (!privateKey) {
    payload.preflightError = 'POLYMARKET_PRIVATE_KEY 未配置';
    payload.coreIssues.push('POLYMARKET_PRIVATE_KEY 未配置，无法生成 signer 并执行 Polymarket 实盘前检查。');
    if (!payload.funderAddress) {
      payload.warnings.push('尚未配置 POLYMARKET_FUNDER_ADDRESS；若使用 profile/funder 模式，建议一并填写。');
    }
    finalizePayload(payload);
    printPayload(payload, asJson);
    return;
  }

  const normalizedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const wallet = new Wallet(normalizedKey);
  payload.signerAddress = wallet.address;
  payload.funderAddress = payload.funderAddress || wallet.address;

  if (payload.signatureType === 0 && String(env.get('POLYMARKET_FUNDER_ADDRESS') || '').trim() && payload.funderAddress.toLowerCase() !== payload.signerAddress.toLowerCase()) {
    payload.coreIssues.push('EOA 签名模式下，POLYMARKET_FUNDER_ADDRESS 必须与 signer 地址一致。');
  }

  const api = new PolymarketAPI({
    gammaUrl,
    clobUrl,
    privateKey: normalizedKey,
    chainId,
    maxMarkets: Number(env.get('POLYMARKET_MAX_MARKETS') || '120'),
    apiKey: env.get('POLYMARKET_API_KEY'),
    apiSecret: env.get('POLYMARKET_API_SECRET'),
    apiPassphrase: env.get('POLYMARKET_API_PASSPHRASE'),
    autoDeriveApiKey: payload.autoDeriveApiKey,
    funderAddress: payload.funderAddress,
    signatureType: payload.signatureType,
  });

  try {
    const preflight = await api.runTradingPreflight(payload.funderAddress);
    payload.credsReady = Boolean(preflight.credsReady);
    payload.openOrderQueryOk = Boolean(preflight.openOrderQueryOk);
    payload.openOrderCount = Number(preflight.openOrderCount || 0);
  } catch (error) {
    payload.preflightError = error instanceof Error ? error.message : String(error);
    payload.coreIssues.push(`交易预检失败: ${payload.preflightError}`);
  }

  if (!chainConfig) {
    payload.warnings.push(`当前 chainId=${chainId}，未内置该链的余额/allowance 检查地址。`);
  }

  if (payload.rpcUrl) {
    try {
      const provider = new JsonRpcProvider(payload.rpcUrl, chainId);
      const signerNativeWei = await provider.getBalance(payload.signerAddress);
      payload.signerNativeBalanceWei = signerNativeWei.toString();
      payload.signerNativeBalance = Number(formatEther(signerNativeWei));

      if (chainConfig) {
        const usdc = new Contract(chainConfig.usdcAddress, ERC20_ABI, provider);
        const ctf = new Contract(chainConfig.ctfAddress, ERC1155_ABI, provider);
        const [funderUsdcWei, usdcAllowanceWei, exchangeApprovalReady, negRiskExchangeApprovalReady] = await Promise.all([
          usdc.balanceOf(payload.funderAddress),
          usdc.allowance(payload.funderAddress, chainConfig.ctfAddress),
          ctf.isApprovedForAll(payload.funderAddress, chainConfig.exchangeAddress),
          ctf.isApprovedForAll(payload.funderAddress, chainConfig.negRiskExchangeAddress),
        ]);

        payload.funderUsdcBalanceWei = funderUsdcWei.toString();
        payload.funderUsdcBalance = Number(formatUnits(funderUsdcWei, chainConfig.usdcDecimals));
        payload.usdcAllowanceWei = usdcAllowanceWei.toString();
        payload.usdcAllowance = Number(formatUnits(usdcAllowanceWei, chainConfig.usdcDecimals));
        payload.usdcAllowanceReady = usdcAllowanceWei > 0n;
        payload.usdcAllowanceSupported = true;
        payload.exchangeApprovalReady = Boolean(exchangeApprovalReady);
        payload.exchangeApprovalSupported = true;
        payload.negRiskExchangeApprovalReady = Boolean(negRiskExchangeApprovalReady);
        payload.negRiskExchangeApprovalSupported = true;
      }
    } catch (error) {
      payload.chainReadError = error instanceof Error ? error.message : String(error);
      payload.coreIssues.push(`链上读取失败: ${payload.chainReadError}`);
    }
  } else {
    payload.warnings.push('未配置可用 RPC URL，无法读取链上余额与授权状态。');
  }

  if (chainConfig) {
    const minNativeBalance = chainConfig.minNativeBalance;
    if (!Number.isFinite(Number(payload.signerNativeBalance)) || Number(payload.signerNativeBalance) < minNativeBalance) {
      payload.coreIssues.push(`Signer 原生币余额不足，至少保留 ${minNativeBalance} ${chainConfig.nativeSymbol} 用于 gas。`);
    }
    if (!Number.isFinite(Number(payload.funderUsdcBalance)) || Number(payload.funderUsdcBalance) <= 0) {
      payload.coreIssues.push(`Funder/Profile 的 ${chainConfig.usdcSymbol} 余额为 0。`);
    }
    if (payload.usdcAllowanceSupported && !payload.usdcAllowanceReady) {
      payload.coreIssues.push(`${chainConfig.usdcSymbol} -> CTF allowance 未就绪。`);
    }
    if (payload.exchangeApprovalSupported && !payload.exchangeApprovalReady) {
      payload.coreIssues.push('CTF -> Exchange approvalForAll 未就绪。');
    }
    if (payload.negRiskExchangeApprovalSupported && !payload.negRiskExchangeApprovalReady) {
      payload.warnings.push('CTF -> NegRisk Exchange approvalForAll 未就绪，仅影响 neg risk 市场。');
    }
  }

  finalizePayload(payload);
  printPayload(payload, asJson);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
