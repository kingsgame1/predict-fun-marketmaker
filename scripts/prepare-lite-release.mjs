#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'lite-release', 'predict-fun-market-maker-lite');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(relPath) {
  const src = path.join(root, relPath);
  const dst = path.join(outDir, relPath);
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

function copyDir(relPath) {
  const src = path.join(root, relPath);
  const dst = path.join(outDir, relPath);
  fs.cpSync(src, dst, { recursive: true });
}

function writeLitePackage() {
  const source = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lite = {
    name: 'predict-fun-market-maker-lite',
    version: source.version,
    description: 'Lite market-maker edition for Predict.fun and Polymarket',
    type: 'module',
    main: 'dist/index.js',
    scripts: {
      'start:mm': 'tsx src/index.ts',
      dev: 'tsx watch src/index.ts',
      build: 'tsc',
      'check:api': 'node scripts/check-api.cjs',
      'auth:jwt': 'tsx src/auth-jwt.ts',
      'setup:approvals': 'tsx src/setup-approvals.ts',
      'smoke:predict': 'tsx scripts/smoke-trade.ts',
      'template:predict': 'node scripts/apply-mm-template.mjs predict',
      'template:polymarket': 'node scripts/apply-mm-template.mjs polymarket',
      'market:recommend': 'tsx scripts/recommend-markets.ts',
      'market:apply': 'tsx scripts/recommend-markets.ts --apply',
      'app:install': 'npm --prefix desktop-app-lite install',
      'app:dev': 'npm --prefix desktop-app-lite run dev',
    },
    keywords: ['predict', 'market-maker', 'polymarket', 'liquidity'],
    license: source.license || 'MIT',
    dependencies: source.dependencies,
    devDependencies: source.devDependencies,
  };
  fs.writeFileSync(path.join(outDir, 'package.json'), `${JSON.stringify(lite, null, 2)}\n`, 'utf8');
}

function writeLiteReadme() {
  const readme = `# Predict.fun Market Maker Lite

Lite edition with only market-maker operations:
- unified market-making strategy
- market recommendation + selection apply
- order configuration templates for Predict / Polymarket

## Referral

- Predict: https://predict.fun?ref=B0CE6
- Polymarket: https://polymarket.com

## Quick Start

\`\`\`bash
npm install
cp .env.example .env
\`\`\`

Apply venue template:

\`\`\`bash
npm run template:predict
# or
npm run template:polymarket
\`\`\`

Recommend and apply top markets:

\`\`\`bash
npm run market:recommend
npm run market:apply
\`\`\`

Run market maker:

\`\`\`bash
npm run start:mm
\`\`\`

Run lite desktop app:

\`\`\`bash
npm run app:install
npm run app:dev
\`\`\`

Important:
- Keep \`ENABLE_TRADING=false\` for first run.
- For live trading on Predict, set \`JWT_TOKEN\` and run \`npm run setup:approvals\`.
- For Polymarket, set \`POLYMARKET_PRIVATE_KEY\` and keep \`MM_REQUIRE_JWT=false\`.
`;
  fs.writeFileSync(path.join(outDir, 'README.md'), readme, 'utf8');
}

function writeLiteGitignore() {
  const text = `node_modules
dist
.env
*.log
`;
  fs.writeFileSync(path.join(outDir, '.gitignore'), text, 'utf8');
}

function pruneLiteSources() {
  const removeFiles = [
    'src/arbitrage-bot.ts',
    'src/test.ts',
    'src/debug-api.ts',
    'src/test-api-key.ts',
    'src/arbitrage/cross-arb.ts',
    'src/arbitrage/dependency-arb.ts',
    'src/arbitrage/executor.ts',
    'src/arbitrage/index.ts',
    'src/arbitrage/intra-arb.ts',
    'src/arbitrage/monitor.ts',
    'src/arbitrage/multi-outcome.ts',
  ];
  removeFiles.forEach((rel) => {
    const full = path.join(outDir, rel);
    if (fs.existsSync(full)) {
      fs.rmSync(full, { force: true });
    }
  });
}

function writeLiteDesktopApp() {
  const templateRoot = path.join(root, 'templates', 'desktop-app-lite');
  if (fs.existsSync(templateRoot)) {
    fs.cpSync(templateRoot, path.join(outDir, 'desktop-app-lite'), { recursive: true });
    return;
  }

  const appRoot = path.join(outDir, 'desktop-app-lite');
  ensureDir(path.join(appRoot, 'electron'));
  ensureDir(path.join(appRoot, 'renderer'));

  const packageJson = {
    name: 'predict-fun-market-maker-lite-app',
    version: '0.1.0',
    private: true,
    type: 'module',
    main: 'electron/main.mjs',
    scripts: {
      dev: 'electron .',
      start: 'electron .',
    },
    devDependencies: {
      electron: '^30.0.0',
    },
  };
  fs.writeFileSync(path.join(appRoot, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');

  const mainMjs = `import { app, BrowserWindow, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const envPath = path.join(projectRoot, '.env');
const rendererPath = path.resolve(__dirname, '..', 'renderer', 'index.html');
let win = null;
let mmProcess = null;

function readEnv() {
  if (!fs.existsSync(envPath)) return '';
  return fs.readFileSync(envPath, 'utf8');
}

function writeEnv(text) {
  fs.writeFileSync(envPath, text.endsWith('\\n') ? text : text + '\\n', 'utf8');
}

function sendLog(message) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('log', { ts: Date.now(), message });
  }
}

function spawnAndPipe(command, args, label) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: projectRoot, shell: false, env: process.env });
    let output = '';
    child.stdout.on('data', (d) => {
      const text = d.toString();
      output += text;
      sendLog('[' + label + '] ' + text);
    });
    child.stderr.on('data', (d) => {
      const text = d.toString();
      output += text;
      sendLog('[' + label + '] ' + text);
    });
    child.on('exit', (code) => resolve({ ok: code === 0, output, code }));
  });
}

function startMM() {
  if (mmProcess) return { ok: false, message: '做市进程已在运行' };
  mmProcess = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'src/index.ts'], {
    cwd: projectRoot,
    shell: false,
    env: process.env,
  });
  mmProcess.stdout.on('data', (d) => sendLog('[MM] ' + d.toString()));
  mmProcess.stderr.on('data', (d) => sendLog('[MM] ' + d.toString()));
  mmProcess.on('exit', (code) => {
    sendLog('[MM] exited code=' + code);
    mmProcess = null;
    if (win && !win.isDestroyed()) {
      win.webContents.send('status', { running: false });
    }
  });
  return { ok: true };
}

function stopMM() {
  if (!mmProcess) return { ok: false, message: '做市进程未运行' };
  mmProcess.kill('SIGTERM');
  return { ok: true };
}

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 740,
    minWidth: 860,
    minHeight: 640,
    webPreferences: {
      preload: path.resolve(__dirname, 'preload.mjs'),
    },
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
  if (venue !== 'predict' && venue !== 'polymarket') {
    return { ok: false, message: 'invalid venue' };
  }
  return await spawnAndPipe('node', ['scripts/apply-mm-template.mjs', venue], 'template');
});
ipcMain.handle('market:apply', async (_, venue) => {
  const v = venue === 'polymarket' ? 'polymarket' : 'predict';
  return await spawnAndPipe(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', 'scripts/recommend-markets.ts', '--venue', v, '--apply'], 'market');
});
`;
  fs.writeFileSync(path.join(appRoot, 'electron', 'main.mjs'), mainMjs, 'utf8');

  const preloadMjs = `import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('liteApp', {
  readEnv: () => ipcRenderer.invoke('env:read'),
  writeEnv: (text) => ipcRenderer.invoke('env:write', text),
  startMM: () => ipcRenderer.invoke('mm:start'),
  stopMM: () => ipcRenderer.invoke('mm:stop'),
  status: () => ipcRenderer.invoke('mm:status'),
  applyTemplate: (venue) => ipcRenderer.invoke('template:apply', venue),
  applyMarkets: (venue) => ipcRenderer.invoke('market:apply', venue),
  onLog: (cb) => ipcRenderer.on('log', (_, payload) => cb(payload)),
  onStatus: (cb) => ipcRenderer.on('status', (_, payload) => cb(payload)),
});
`;
  fs.writeFileSync(path.join(appRoot, 'electron', 'preload.mjs'), preloadMjs, 'utf8');

  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>MM Lite Console</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <div class="app">
      <header>
        <h1>简化版做市 App</h1>
        <div id="status" class="badge">未运行</div>
      </header>
      <section class="row">
        <button id="startMM">启动做市</button>
        <button id="stopMM">停止做市</button>
      </section>
      <section class="row">
        <button id="tplPredict">套用 Predict 模板</button>
        <button id="tplPolymarket">套用 Polymarket 模板</button>
      </section>
      <section class="row">
        <button id="marketPredict">推荐并应用 Predict 市场</button>
        <button id="marketPolymarket">推荐并应用 Polymarket 市场</button>
      </section>
      <section>
        <div class="label">.env 配置</div>
        <textarea id="envEditor"></textarea>
        <div class="row">
          <button id="reloadEnv">重新读取</button>
          <button id="saveEnv">保存配置</button>
        </div>
      </section>
      <section>
        <div class="label">日志</div>
        <pre id="logs"></pre>
      </section>
    </div>
    <script type="module" src="renderer.js"></script>
  </body>
</html>
`;
  fs.writeFileSync(path.join(appRoot, 'renderer', 'index.html'), html, 'utf8');

  const css = `body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background:#0f1222; color:#eef2ff; margin:0; }
.app { max-width: 960px; margin: 0 auto; padding: 18px; }
header { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
.badge { padding:6px 10px; border-radius:12px; background:#334155; }
.row { display:flex; gap:10px; margin-bottom:10px; flex-wrap:wrap; }
button { border:none; background:#2563eb; color:white; padding:8px 12px; border-radius:8px; cursor:pointer; }
button:hover { opacity:.9; }
.label { margin:8px 0; font-weight:600; }
textarea { width:100%; height:220px; background:#111827; color:#e5e7eb; border:1px solid #374151; border-radius:8px; padding:10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { margin:0; height:180px; overflow:auto; background:#020617; border:1px solid #1e293b; border-radius:8px; padding:10px; }
`;
  fs.writeFileSync(path.join(appRoot, 'renderer', 'styles.css'), css, 'utf8');

  const rendererJs = `const envEditor = document.getElementById('envEditor');
const logs = document.getElementById('logs');
const status = document.getElementById('status');

function pushLog(line) {
  const now = new Date().toLocaleTimeString();
  logs.textContent += '[' + now + '] ' + line + '\\n';
  logs.scrollTop = logs.scrollHeight;
}

async function refreshEnv() {
  envEditor.value = await window.liteApp.readEnv();
}

async function refreshStatus() {
  const s = await window.liteApp.status();
  status.textContent = s.running ? '运行中' : '未运行';
  status.style.background = s.running ? '#065f46' : '#334155';
}

document.getElementById('startMM').onclick = async () => {
  const r = await window.liteApp.startMM();
  pushLog(r.ok ? '已启动做市' : '启动失败: ' + (r.message || 'unknown'));
  refreshStatus();
};

document.getElementById('stopMM').onclick = async () => {
  const r = await window.liteApp.stopMM();
  pushLog(r.ok ? '已停止做市' : '停止失败: ' + (r.message || 'unknown'));
  refreshStatus();
};

document.getElementById('tplPredict').onclick = async () => {
  const r = await window.liteApp.applyTemplate('predict');
  pushLog(r.ok ? '已应用 Predict 模板' : '模板失败');
};

document.getElementById('tplPolymarket').onclick = async () => {
  const r = await window.liteApp.applyTemplate('polymarket');
  pushLog(r.ok ? '已应用 Polymarket 模板' : '模板失败');
};

document.getElementById('marketPredict').onclick = async () => {
  const r = await window.liteApp.applyMarkets('predict');
  pushLog(r.ok ? '已应用 Predict 市场推荐' : '市场推荐失败');
};

document.getElementById('marketPolymarket').onclick = async () => {
  const r = await window.liteApp.applyMarkets('polymarket');
  pushLog(r.ok ? '已应用 Polymarket 市场推荐' : '市场推荐失败');
};

document.getElementById('reloadEnv').onclick = refreshEnv;
document.getElementById('saveEnv').onclick = async () => {
  await window.liteApp.writeEnv(envEditor.value || '');
  pushLog('配置已保存');
};

window.liteApp.onLog((payload) => {
  pushLog(payload.message || '');
});
window.liteApp.onStatus(() => refreshStatus());

refreshEnv();
refreshStatus();
`;
  fs.writeFileSync(path.join(appRoot, 'renderer', 'renderer.js'), rendererJs, 'utf8');
}

function main() {
  fs.rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);

  copyDir('src');
  ensureDir(path.join(outDir, 'scripts'));
  copyFile('scripts/check-api.cjs');
  copyFile('scripts/smoke-trade.ts');
  copyFile('scripts/apply-mm-template.mjs');
  copyFile('scripts/recommend-markets.ts');
  copyFile('tsconfig.json');
  copyFile('.env.example');
  copyFile('markets-config.json');
  copyFile('README.MM.md');
  copyFile('docs/BEGINNER_GUIDE.md');
  copyFile('docs/CONFIG_REFERENCE.md');

  pruneLiteSources();
  writeLitePackage();
  writeLiteReadme();
  writeLiteGitignore();
  writeLiteDesktopApp();

  console.log(`Lite release prepared: ${outDir}`);
}

main();
