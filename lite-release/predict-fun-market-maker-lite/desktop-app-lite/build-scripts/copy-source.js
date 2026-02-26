#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copySync } from 'fs-extra/esm';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopAppRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(desktopAppRoot, '..');

console.log(`[copy-source] 项目根目录: ${projectRoot}`);
console.log(`[copy-source] 桌面应用目录: ${desktopAppRoot}`);

// 复制 src 目录
const srcSrc = path.join(projectRoot, 'src');
const srcDst = path.join(desktopAppRoot, 'src');
if (fs.existsSync(srcDst)) {
  fs.rmSync(srcDst, { recursive: true, force: true });
}
fs.mkdirSync(srcDst, { recursive: true });
copySync(srcSrc, srcDst);
console.log(`[copy-source] ✅ src 目录已复制`);

// 复制 scripts 目录（排除 copy-source.js 自身）
const scriptsSrc = path.join(projectRoot, 'scripts');
const scriptsDst = path.join(desktopAppRoot, 'scripts');
if (fs.existsSync(scriptsDst)) {
  fs.rmSync(scriptsDst, { recursive: true, force: true });
}
fs.mkdirSync(scriptsDst, { recursive: true });

// 复制 scripts 目录下的所有文件
const files = fs.readdirSync(scriptsSrc);
for (const file of files) {
  const srcPath = path.join(scriptsSrc, file);
  const dstPath = path.join(scriptsDst, file);
  if (fs.statSync(srcPath).isDirectory()) {
    copySync(srcPath, dstPath);
  } else {
    fs.copyFileSync(srcPath, dstPath);
  }
}
console.log(`[copy-source] ✅ scripts 目录已复制`);

// 复制 package.json 和 tsconfig.json
fs.copyFileSync(
  path.join(projectRoot, 'package.json'),
  path.join(desktopAppRoot, 'src-package.json')
);
fs.copyFileSync(
  path.join(projectRoot, 'tsconfig.json'),
  path.join(desktopAppRoot, 'tsconfig.json')
);
console.log(`[copy-source] ✅ package.json 和 tsconfig.json 已复制`);

// 安装依赖
console.log(`[copy-source] 正在安装依赖...`);
try {
  execSync('npm install --no-package-lock', {
    cwd: desktopAppRoot,
    stdio: 'inherit'
  });
  console.log(`[copy-source] ✅ 依赖安装完成`);
} catch (error) {
  console.error(`[copy-source] ⚠️  依赖安装失败: ${error.message}`);
  throw error;
}
