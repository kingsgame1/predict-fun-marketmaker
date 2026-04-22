/**
 * copy-source.js — 打包前复制源码到launcher
 * 把项目根目录的 src/ 和 scripts/ 复制到 launcher/runtime-dist/
 * 然后安装依赖 + tsc编译
 */
import path from 'node:path';
import fs from 'fs-extra';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const LAUNCHER = path.resolve(import.meta.dirname, '..');
const RUNTIME = path.join(LAUNCHER, 'runtime-dist');

console.log('[copy-source] ROOT:', ROOT);
console.log('[copy-source] LAUNCHER:', LAUNCHER);

// 1. 清理旧构建
if (fs.existsSync(RUNTIME)) {
  fs.rmSync(RUNTIME, { recursive: true, force: true });
}
fs.mkdirSync(RUNTIME, { recursive: true });

// 2. 复制 src/ 和 scripts/
const srcDir = path.join(ROOT, 'src');
const scriptsDir = path.join(ROOT, 'scripts');

if (fs.existsSync(srcDir)) {
  fs.copySync(srcDir, path.join(RUNTIME, 'src'));
  console.log('[copy-source] Copied src/');
}
if (fs.existsSync(scriptsDir)) {
  fs.copySync(scriptsDir, path.join(RUNTIME, 'scripts'));
  console.log('[copy-source] Copied scripts/');
}

// 3. 复制 package.json 和 tsconfig.json（给npm install + tsc用）
const pkg = fs.readJsonSync(path.join(ROOT, 'package.json'));
// 只保留dependencies
const minimalPkg = {
  name: pkg.name,
  version: pkg.version,
  type: pkg.type || 'module',
  dependencies: pkg.dependencies || {},
};
fs.writeJsonSync(path.join(RUNTIME, 'package.json'), minimalPkg, { spaces: 2 });

if (fs.existsSync(path.join(ROOT, 'tsconfig.json'))) {
  fs.copySync(path.join(ROOT, 'tsconfig.json'), path.join(RUNTIME, 'tsconfig.json'));
}

// 4. 安装依赖
console.log('[copy-source] Installing dependencies...');
execSync('npm install --production', { cwd: RUNTIME, stdio: 'inherit' });

// 5. 编译TypeScript
console.log('[copy-source] Compiling TypeScript...');
if (fs.existsSync(path.join(RUNTIME, 'tsconfig.json'))) {
  try {
    execSync('npx tsc', { cwd: RUNTIME, stdio: 'inherit' });
  } catch {
    console.log('[copy-source] tsc had errors, continuing with tsx runtime...');
  }
}

// 6. 复制icon（如果有）
const iconCandidates = ['icon.png', 'icon.icns', 'icon.ico', 'build/icon.png'];
for (const ic of iconCandidates) {
  const p = path.join(ROOT, ic);
  if (fs.existsSync(p)) {
    fs.copySync(p, path.join(LAUNCHER, ic));
    console.log('[copy-source] Copied', ic);
  }
}

console.log('[copy-source] Done!');
