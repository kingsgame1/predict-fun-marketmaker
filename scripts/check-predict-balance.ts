import fs from 'node:fs';
import path from 'node:path';
import PredictSdk from '@predictdotfun/sdk';
import { JsonRpcProvider, Wallet, formatUnits } from 'ethers';

const { AddressesByChainId, ChainId, OrderBuilder, ProviderByChainId } = PredictSdk as any;

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

function getChainId(apiBaseUrl: string) {
  return /api-testnet|testnet|bnbtestnet/i.test(apiBaseUrl) ? ChainId.BnbTestnet : ChainId.BnbMainnet;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envPath = resolveEnvPath(args);
  const asJson = args.get('--json') === 'true';
  const envText = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const env = parseEnv(envText);

  const privateKey = env.get('PRIVATE_KEY') || '';
  const predictAccountAddress = env.get('PREDICT_ACCOUNT_ADDRESS') || '';
  const apiBaseUrl = env.get('API_BASE_URL') || 'https://api.predict.fun';
  const rpcUrl = env.get('RPC_URL') || '';

  if (!privateKey) {
    throw new Error('PRIVATE_KEY 未配置，无法检查 Predict 余额');
  }

  const chainId = getChainId(apiBaseUrl);
  const provider = rpcUrl ? new JsonRpcProvider(rpcUrl) : (ProviderByChainId[chainId] as JsonRpcProvider);
  const wallet = new Wallet(privateKey, provider);
  const signerAddress = wallet.address;

  const orderBuilder = await OrderBuilder.make(chainId, wallet, {
    ...(predictAccountAddress ? { predictAccount: predictAccountAddress } : {}),
  });

  const accountAddress = predictAccountAddress || signerAddress;
  const balanceWei = await orderBuilder.balanceOf('USDT', accountAddress);
  const addresses = AddressesByChainId[chainId];
  const allowanceTargets = [
    { key: 'CTF_EXCHANGE', address: addresses.CTF_EXCHANGE },
    { key: 'NEG_RISK_CTF_EXCHANGE', address: addresses.NEG_RISK_CTF_EXCHANGE },
    { key: 'YIELD_BEARING_CTF_EXCHANGE', address: addresses.YIELD_BEARING_CTF_EXCHANGE },
    { key: 'YIELD_BEARING_NEG_RISK_CTF_EXCHANGE', address: addresses.YIELD_BEARING_NEG_RISK_CTF_EXCHANGE },
  ];

  const allowances = await Promise.all(
    allowanceTargets.map(async (target) => {
      const allowanceWei = await orderBuilder.contracts.USDT.contract.allowance(accountAddress, target.address);
      return {
        key: target.key,
        address: target.address,
        allowanceWei: allowanceWei.toString(),
        allowance: formatUnits(allowanceWei, 18),
      };
    })
  );

  const approvalReady = allowances.every((item) => BigInt(item.allowanceWei) > 0n);
  const suspiciousPredictAccount =
    Boolean(predictAccountAddress) && predictAccountAddress.toLowerCase() === signerAddress.toLowerCase();

  const payload = {
    signerAddress,
    predictAccountAddress,
    accountAddress,
    balanceWei: balanceWei.toString(),
    balance: formatUnits(balanceWei, 18),
    approvalReady,
    suspiciousPredictAccount,
    allowances,
  };

  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  console.log(`Signer: ${signerAddress}`);
  console.log(`PredictAccount: ${predictAccountAddress || '(未配置)'}`);
  console.log(`Balance: ${payload.balance} USDT`);
  console.log(`Approvals: ${approvalReady ? 'ready' : 'pending'}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
