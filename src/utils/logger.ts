import fs from 'node:fs';
import path from 'node:path';

/**
 * 日志系统 - 同时输出到终端和文件，按天轮转
 * 使用方式: 在 index.ts 入口最开始调用 setupLogger()
 */

let logDir = 'logs';
let currentLogFile = '';
let currentDate = '';
let logStream: fs.WriteStream | null = null;

function getToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function getLogFile(): string {
  const today = getToday();
  if (today !== currentDate) {
    currentDate = today;
    currentLogFile = path.join(logDir, `${today}.log`);
    // 确保目录存在
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    // 关闭旧流
    if (logStream) {
      logStream.end();
    }
    // 创建新流（追加模式）
    logStream = fs.createWriteStream(currentLogFile, { flags: 'a' });
  }
  return currentLogFile;
}

function writeToFile(level: string, args: any[]) {
  try {
    const file = getLogFile();
    const timestamp = new Date().toISOString();
    const message = args
      .map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
    const line = `[${timestamp}] [${level}] ${message}\n`;
    if (logStream) {
      logStream.write(line);
    }
  } catch {
    // 日志写入失败不应影响主程序
  }
}

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

export function setupLogger(options?: { logDir?: string }): void {
  if (options?.logDir) {
    logDir = options.logDir;
  }

  console.log = (...args: any[]) => {
    writeToFile('INFO', args);
    originalLog.apply(console, args);
  };

  console.warn = (...args: any[]) => {
    writeToFile('WARN', args);
    originalWarn.apply(console, args);
  };

  console.error = (...args: any[]) => {
    writeToFile('ERROR', args);
    originalError.apply(console, args);
  };

  // 初始化日志文件
  getLogFile();
  console.log(`📝 日志系统已启动: ${path.resolve(logDir)}`);
}

export function getLogDir(): string {
  return logDir;
}

export function flushLogs(): void {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}
