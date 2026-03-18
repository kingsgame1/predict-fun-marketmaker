import fs from 'node:fs';
import path from 'node:path';

interface Args {
  metricsPath: string;
  top: number;
  json: boolean;
}

interface MarketMetric {
  tokenId?: string;
  question?: string;
  autoTune?: { utility?: number };
  cancelRate?: number;
  avgCancelLifetimeMs?: number;
  avgFillLifetimeMs?: number;
  rewardQueueTargetHours?: number;
  rewardQueueTargetFactor?: number;
  rewardQueueTargetPenalty?: number;
  rewardQueueTargetReason?: string;
  polymarketState?: string;
  polymarketStateReason?: string;
  fillPenaltyBps?: number;
  cancelPenalty?: number;
  lifetimePenalty?: number;
  topDepthUsd?: number;
  spread?: number;
}

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let metricsPath = process.env.MM_METRICS_PATH || 'data/mm-metrics.json';
  let top = 10;
  let json = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if ((arg === '--metrics' || arg === '--metrics-path') && args[i + 1]) {
      metricsPath = args[++i];
    } else if (arg === '--top' && args[i + 1]) {
      top = Math.max(1, parseInt(args[++i], 10) || 10);
    } else if (arg === '--json') {
      json = true;
    }
  }
  return { metricsPath, top, json };
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function fmt(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
}

function main(): void {
  const { metricsPath, top, json } = parseArgs();
  const resolved = path.isAbsolute(metricsPath) ? metricsPath : path.resolve(process.cwd(), metricsPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`metrics 文件不存在: ${resolved}`);
  }
  const raw = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  const markets: MarketMetric[] = Array.isArray(raw?.markets) ? raw.markets : [];
  const events: Array<{ type?: string; tokenId?: string; message?: string }> = Array.isArray(raw?.events) ? raw.events : [];

  const stateCounts = new Map<string, number>();
  const cooldownCounts = new Map<string, number>();
  const queueHours: number[] = [];
  const healthyQueueHours: number[] = [];
  const utilityRows = markets
    .map((market) => {
      const utility = Number(market.autoTune?.utility || 0);
      const queueTargetHours = Number(market.rewardQueueTargetHours || 0);
      const queueTargetFactor = Number(market.rewardQueueTargetFactor || 0);
      const cancelRate = Number(market.cancelRate || 0);
      const fillPenaltyBps = Number(market.fillPenaltyBps || 0);
      const cancelPenalty = Number(market.cancelPenalty || 0);
      const lifetimePenalty = Number(market.lifetimePenalty || 0);
      const cost = fillPenaltyBps / 10 + cancelPenalty + lifetimePenalty;
      const state = String(market.polymarketState || 'UNKNOWN');
      stateCounts.set(state, (stateCounts.get(state) || 0) + 1);
      if (state === 'COOLDOWN' || state === 'EXIT') {
        cooldownCounts.set(state, (cooldownCounts.get(state) || 0) + 1);
      }
      if (queueTargetHours > 0) {
        queueHours.push(queueTargetHours);
        if (utility > 0 && cancelRate < 0.85 && queueTargetFactor >= 0.6) {
          healthyQueueHours.push(queueTargetHours);
        }
      }
      return {
        tokenId: market.tokenId || '',
        question: market.question || '',
        utility,
        cost,
        cancelRate,
        fillPenaltyBps,
        queueTargetHours,
        queueTargetFactor,
        state,
        stateReason: market.polymarketStateReason || '',
        depthUsd: Number(market.topDepthUsd || 0),
        spread: Number(market.spread || 0),
      };
    })
    .sort((a, b) => b.utility - a.utility);

  const topUtility = utilityRows.slice(0, top);
  const highRisk = [...utilityRows].sort((a, b) => b.cost - a.cost).slice(0, top);
  const recommendedTargetQueueHours = median(healthyQueueHours.length ? healthyQueueHours : queueHours);
  const sortedHealthyQueues = [...(healthyQueueHours.length ? healthyQueueHours : queueHours)].sort((a, b) => a - b);
  const p25 = percentile(sortedHealthyQueues, 0.25);
  const p75 = percentile(sortedHealthyQueues, 0.75);
  const suggestedTolerance =
    recommendedTargetQueueHours > 0
      ? Math.max(0.25, Math.min(1.2, (p75 - p25) / Math.max(recommendedTargetQueueHours, 0.01)))
      : 0.5;

  const summary = {
    metricsPath: resolved,
    markets: markets.length,
    events: events.length,
    stateCounts: Object.fromEntries(stateCounts),
    topUtility,
    highRisk,
    suggestions: {
      POLYMARKET_REWARD_TARGET_QUEUE_HOURS: Number(recommendedTargetQueueHours.toFixed(2)),
      POLYMARKET_REWARD_TARGET_QUEUE_TOLERANCE: Number(suggestedTolerance.toFixed(2)),
      note:
        recommendedTargetQueueHours > 0
          ? '基于当前正效用市场的目标排队时长分布估算。'
          : '当前样本不足，先沿用默认排队目标。',
    },
  };

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log('Polymarket 回放校准摘要');
  console.log(`Metrics: ${resolved}`);
  console.log(`市场数: ${markets.length} 事件数: ${events.length}`);
  console.log(`建议 POLYMARKET_REWARD_TARGET_QUEUE_HOURS=${fmt(summary.suggestions.POLYMARKET_REWARD_TARGET_QUEUE_HOURS)}`);
  console.log(`建议 POLYMARKET_REWARD_TARGET_QUEUE_TOLERANCE=${fmt(summary.suggestions.POLYMARKET_REWARD_TARGET_QUEUE_TOLERANCE)}`);
  console.log(`状态分布: ${JSON.stringify(summary.stateCounts)}`);
  console.log('');
  console.log('Top Utility');
  for (const row of topUtility) {
    console.log(
      `- ${row.tokenId.slice(0, 10)} utility=${fmt(row.utility)} state=${row.state} queue=${fmt(row.queueTargetHours)}h factor=${fmt(row.queueTargetFactor)} cancel=${fmt(row.cancelRate)}`
    );
  }
  console.log('');
  console.log('High Risk');
  for (const row of highRisk) {
    console.log(
      `- ${row.tokenId.slice(0, 10)} cost=${fmt(row.cost)} fillPenalty=${fmt(row.fillPenaltyBps)}bps cancel=${fmt(row.cancelRate)} state=${row.state} ${row.stateReason}`
    );
  }
}

main();
