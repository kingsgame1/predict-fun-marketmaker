import fs from 'node:fs';
import path from 'node:path';
import type { MarketMaker } from '../market-maker.js';

const SNAPSHOT_DIR = 'snapshots';
let snapshotInterval: ReturnType<typeof setInterval> | null = null;

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function startSnapshotTimer(mm: MarketMaker, intervalMs = 300_000): void {
  if (snapshotInterval) return;

  ensureDir(SNAPSHOT_DIR);

  snapshotInterval = setInterval(() => {
    try {
      saveSnapshot(mm);
    } catch (e) {
      console.warn(`⚠️ 状态快照保存失败: ${e}`);
    }
  }, intervalMs);

  // 立即保存一次
  try {
    saveSnapshot(mm);
  } catch {
    // ignore
  }
}

export function stopSnapshotTimer(): void {
  if (snapshotInterval) {
    clearInterval(snapshotInterval);
    snapshotInterval = null;
  }
}

export function saveSnapshot(mm: MarketMaker): string {
  ensureDir(SNAPSHOT_DIR);

  const timestamp = new Date().toISOString();
  const filename = path.join(SNAPSHOT_DIR, `snapshot-${timestamp.replace(/[:.]/g, '-')}.json`);

  // 仅导出可序列化的状态，避免循环引用
  const snapshot = {
    timestamp,
    uptimeSeconds: process.uptime(),
    openOrders: Array.from((mm as any).openOrders?.entries() || []).map(([k, v]: [string, any]) => [k, {
      order_hash: v.order_hash,
      status: v.status,
      side: v.side,
      price: v.price,
      original_size: v.original_size,
      remaining_size: v.remaining_size,
      token_id: v.token_id,
      market_id: v.market_id,
      created_at: v.created_at,
    }]),
    positions: Array.from((mm as any).positions?.entries() || []).map(([k, v]: [string, any]) => [k, {
      token_id: v.token_id,
      market_id: v.market_id,
      side: v.side,
      size: v.size,
      avg_price: v.avg_price,
      unrealized_pnl: v.unrealized_pnl,
      updated_at: v.updated_at,
    }]),
    markets: Array.from((mm as any).markets?.entries() || []).map(([k, v]: [string, any]) => [k, {
      token_id: v.token_id,
      market_id: v.market_id,
      question: v.question?.slice(0, 100),
      yes_bid: v.yes_bid,
      yes_ask: v.yes_ask,
      no_bid: v.no_bid,
      no_ask: v.no_ask,
      status: v.status,
      volume_24h: v.volume_24h,
    }]),
    config: {
      mmMode: (mm as any).config?.mmMode,
      mmQuoteLevel: (mm as any).config?.mmQuoteLevel,
      mmMaxOrdersPerMarket: (mm as any).config?.mmMaxOrdersPerMarket,
      mmMinSpreadCents: (mm as any).config?.mmMinSpreadCents,
    },
  };

  fs.writeFileSync(filename, JSON.stringify(snapshot, null, 2));

  // 清理超过48小时的旧快照
  cleanupOldSnapshots();

  return filename;
}

function cleanupOldSnapshots(): void {
  try {
    const files = fs.readdirSync(SNAPSHOT_DIR);
    const now = Date.now();
    const maxAge = 48 * 60 * 60 * 1000; // 48h
    for (const f of files) {
      const fp = path.join(SNAPSHOT_DIR, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > maxAge) {
        fs.unlinkSync(fp);
      }
    }
  } catch {
    // ignore cleanup errors
  }
}
