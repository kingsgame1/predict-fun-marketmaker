#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { copySync } from 'fs-extra/esm';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopAppRoot = path.resolve(__dirname, '..');
const projectRoot = path.resolve(desktopAppRoot, '..');

console.log(`[copy-source] 项目根目录: ${projectRoot}`);
console.log(`[copy-source] 桌面应用目录: ${desktopAppRoot}`);

function makeCrc32Table() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
}

const crc32Table = makeCrc32Table();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crc32Table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function createIconPng(outputPath) {
  const size = 512;
  const rowBytes = size * 4 + 1;
  const raw = Buffer.alloc(rowBytes * size);

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0;
    for (let x = 0; x < size; x += 1) {
      const idx = rowStart + 1 + x * 4;
      const centerX = size / 2;
      const centerY = size / 2;
      const dx = x - centerX;
      const dy = y - centerY;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const ring = distance > 150 && distance < 220;
      const stripe = Math.abs(dx + dy * 0.6) < 36;
      let r = 12;
      let g = 26;
      let b = 57;
      let a = 255;

      if (distance > 245) {
        a = 0;
      } else if (ring) {
        r = 45;
        g = 212;
        b = 191;
      } else if (distance < 150) {
        r = 235;
        g = 99;
        b = 74;
      }

      if (stripe && distance < 235) {
        r = 255;
        g = 214;
        b = 102;
      }

      raw[idx] = r;
      raw[idx + 1] = g;
      raw[idx + 2] = b;
      raw[idx + 3] = a;
    }
  }

  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const png = Buffer.concat([
    header,
    createChunk('IHDR', ihdr),
    createChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    createChunk('IEND', Buffer.alloc(0)),
  ]);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, png);
}

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

// 生成应用图标
const iconPath = path.join(desktopAppRoot, 'build', 'icon.png');
createIconPng(iconPath);
console.log(`[copy-source] ✅ 图标已生成: ${iconPath}`);

// 安装依赖
console.log(`[copy-source] 正在安装依赖...`);
try {
  execSync('npm install --no-package-lock --prefer-dedupe', {
    cwd: desktopAppRoot,
    stdio: 'inherit'
  });
  console.log(`[copy-source] ✅ 依赖安装完成`);
} catch (error) {
  console.error(`[copy-source] ⚠️  依赖安装失败: ${error.message}`);
  throw error;
}
