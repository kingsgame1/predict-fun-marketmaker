import fs from 'node:fs';
import path from 'node:path';

/**
 * 每日运营报告 - 记录 maker rebate / 被吃损失 / 净收益
 * 使用简单的 JSON 文件存储，每天一个文件
 */

const REPORT_DIR = 'reports';

interface DailyStats {
  date: string;
  makerVolume: number;
  makerCount: number;
  fillVolume: number;
  fillCount: number;
  fillLossUsd: number;
  hedgeCostUsd: number;
  pointsEarned: number;
  netPnl: number;
  uptimeSeconds: number;
  lastUpdated: string;
}

function ensureDir(): void {
  if (!fs.existsSync(REPORT_DIR)) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
  }
}

function getTodayFile(): string {
  ensureDir();
  const date = new Date().toISOString().slice(0, 10);
  return path.join(REPORT_DIR, `${date}.json`);
}

function loadToday(): DailyStats {
  const file = getTodayFile();
  if (fs.existsSync(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // corrupt, start fresh
    }
  }
  const date = new Date().toISOString().slice(0, 10);
  return {
    date,
    makerVolume: 0,
    makerCount: 0,
    fillVolume: 0,
    fillCount: 0,
    fillLossUsd: 0,
    hedgeCostUsd: 0,
    pointsEarned: 0,
    netPnl: 0,
    uptimeSeconds: 0,
    lastUpdated: new Date().toISOString(),
  };
}

function save(stats: DailyStats): void {
  stats.lastUpdated = new Date().toISOString();
  fs.writeFileSync(getTodayFile(), JSON.stringify(stats, null, 2));
}

/** 记录 maker 订单（挂单被填充 = maker rebate 符合条件） */
export function recordMaker(volume: number, points: number): void {
  const stats = loadToday();
  stats.makerVolume += volume;
  stats.makerCount += 1;
  stats.pointsEarned += points;
  stats.netPnl += points; // 积分作为收益估算
  save(stats);
}

/** 记录被吃单（taker fill） */
export function recordFill(volume: number, lossUsd: number, hedgeCost: number): void {
  const stats = loadToday();
  stats.fillVolume += volume;
  stats.fillCount += 1;
  stats.fillLossUsd += lossUsd;
  stats.hedgeCostUsd += hedgeCost;
  stats.netPnl -= (lossUsd + hedgeCost);
  save(stats);
}

/** 更新运行时长 */
export function updateUptime(seconds: number): void {
  const stats = loadToday();
  stats.uptimeSeconds = seconds;
  save(stats);
}

/** 获取今日统计 */
export function getTodayStats(): DailyStats {
  return loadToday();
}

/** 获取近N天报告 */
export function getRecentReports(days = 7): DailyStats[] {
  ensureDir();
  const files = fs.readdirSync(REPORT_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, days);

  return files.map(f => {
    try {
      return JSON.parse(fs.readFileSync(path.join(REPORT_DIR, f), 'utf8'));
    } catch {
      return null;
    }
  }).filter(Boolean) as DailyStats[];
}
