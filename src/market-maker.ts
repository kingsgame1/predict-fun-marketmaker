/**
 * Market Maker Core
 * Production-oriented quoting + risk controls
 */

import type { Config, Market, Orderbook, Order, OrderbookEntry, Position, LiquidityActivation } from './types.js';
import type { MakerApi, MakerOrderManager } from './mm/venue.js';
import { OrderManager } from './order-manager.js';
import { evaluatePolymarketEventRisk } from './market-selector.js';
// 统一做市商策略（整合了所有优点）
import {
  UnifiedMarketMakerStrategy,
  UnifiedState,
  type UnifiedMarketMakerConfig,
  type UnifiedAction
} from './strategies/unified-market-maker-strategy.js';

// 两阶段循环对冲策略
import {
  TwoPhaseHedgeStrategy,
  TwoPhaseState,
  twoPhaseHedgeStrategy
} from './strategies/two-phase-hedge-strategy.js';

// Phase 1: 导入增强模块
import {
  VolatilityEstimator,
  OrderFlowEstimator,
  InventoryClassifier,
  InventoryState,
  MeanReversionPredictor
} from './analysis/types.js';
import {
  DynamicASModel
} from './pricing/types.js';
import { ValueMismatchDetector } from './arbitrage/value-detector.js';
import { CrossPlatformAggregator } from './external/aggregator.js';
import { CrossPlatformExecutionRouter } from './external/execution.js';
import { similarityScore } from './external/match.js';
import type { PlatformLeg, PlatformMarket } from './external/types.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pointsManager } from './mm/points/points-manager.js';
// import { spreadCache } from './mm/cache/spread-cache.js';
import { pointsOptimizerEngine, type PointsMarketScore } from './mm/points/points-optimizer.js';
import { pointsSystemIntegration } from './mm/points/points-integration.js';
import { pointsOptimizerEngineV2, type OptimizedOrderParams } from './mm/points/points-optimizer-v2.js';
import { alertFill, alertApiFailure } from './utils/alert.js';
import { startSnapshotTimer, stopSnapshotTimer } from './utils/snapshot.js';
import { recordFill } from './utils/daily-report.js';

// CRITICAL FIX #2: 统一的持仓快照接口，解决类型不一致问题
interface PositionSnapshot {
  yesAmount: number;
  noAmount: number;
  net: number;
  timestamp: number;
}

// MEDIUM FIX #3: 定义做市商常量（消除魔法数字）
const MARKET_MAKER_CONSTANTS = {
  // 基础常量
  MIN_TICK: 0.0001,
  BPS_MULTIPLIER: 10000,
  EPSILON: 0.0001,  // 浮点数比较精度

  // 时间相关
  DEFAULT_MIN_INTERVAL_MS: 3000,
  ORDERBOOK_CACHE_MAX_AGE_MS: 1500,
  FILL_DETECTION_COOLDOWN_MS: 5000,

  // 价差相关
  DEFAULT_SPREAD_CENTS: 0.02,
  MAX_ALLOWED_BOOK_SPREAD: 0.2,
  MIN_SPREAD_BPS: 80,
  MAX_SPREAD_BPS: 550,

  // 比率限制
  MAX_RATIO: 999,
  DEFAULT_TOLERANCE: 0.05,

  // 订单大小
  MIN_ORDER_SIZE: 10,
  DEFAULT_ORDER_SIZE: 25,

  // 滑点
  DEFAULT_SLIPPAGE_BPS: 250,
  DEFAULT_HEDGE_SLIPPAGE_BPS: 250,

  // 风险控制
  DEFAULT_MAX_POSITION: 100,
  DEFAULT_MAX_DAILY_LOSS: 200,

} as const;

interface QuotePrices {
  bidPrice: number;
  askPrice: number;
  midPrice: number;
  spread: number;
  pressure?: number;
  inventoryBias: number;
  valueBias?: number;
  valueConfidence?: number;
  depth?: number;
  depthTrend?: number;
  imbalance?: number;
  profile?: 'CALM' | 'NORMAL' | 'VOLATILE';
  volatility?: number;
  tierPriced?: boolean; // 档位定价（第N档-0.5c），验证层要求至少0.5c距离
}

interface OrderSizeResult {
  shares: number;
  usdt: number;
}

type OrderLevel = OrderbookEntry;

// MEDIUM FIX #2: 结构化日志系统
enum LogLevel {
  ERROR = 'ERROR',
  WARN = 'WARN',
  INFO = 'INFO',
  DEBUG = 'DEBUG',
}

interface LogContext {
  tokenId?: string;
  orderId?: string;
  shares?: number;
  price?: number;
  side?: 'BUY' | 'SELL';
  market?: string;
  [key: string]: unknown;
}

export class MarketMaker {
  private static readonly MIN_TICK = 0.0001;
  private static readonly MAX_ALLOWED_BOOK_SPREAD = 0.2;
  private static readonly PREDICT_SAFE_MIN_L1_NOTIONAL = 25;
  private static readonly PREDICT_SAFE_MIN_L2_NOTIONAL = 10;
  private static readonly PREDICT_SAFE_MIN_L2_TO_L1_RATIO = 0.25;
  private static readonly PREDICT_SAFE_MIN_PRICE = 0.08;
  private static readonly PREDICT_SAFE_MAX_PRICE = 0.92;
  private static readonly PREDICT_SAFE_MAX_LEVEL_GAP = 0.02;
  private static readonly PREDICT_FILL_PAUSE_MS = 10 * 60 * 1000;
  private static readonly PREDICT_UNSAFE_BOOK_PAUSE_MS = 3 * 60 * 1000;
  private static readonly PREDICT_POSITION_LOSS_LIMIT_ABS = 25;
  private static readonly PREDICT_POSITION_LOSS_LIMIT_RATIO = 0.3;
  private static readonly PREDICT_POSITION_LOSS_PAUSE_MS = 30 * 60 * 1000;

  private readonly api: MakerApi;
  private readonly config: Config;

  private openOrders: Map<string, Order> = new Map();
  private positions: Map<string, Position> = new Map();
  private lastPrices: Map<string, number> = new Map();
  private lastPriceAt: Map<string, number> = new Map();
  private lastBestBid: Map<string, number> = new Map();
  private lastBestAsk: Map<string, number> = new Map();
  private lastBestAt: Map<string, number> = new Map();
  private lastBestBidSize: Map<string, number> = new Map();
  private lastBestAskSize: Map<string, number> = new Map();
  private prevBestBid: Map<string, number> = new Map();
  private prevBestAsk: Map<string, number> = new Map();
  private prevBestAt: Map<string, number> = new Map();
  private prevBestBidSize: Map<string, number> = new Map();
  private prevBestAskSize: Map<string, number> = new Map();
  private lastBidDeltaBps: Map<string, number> = new Map();
  private lastAskDeltaBps: Map<string, number> = new Map();
  private prevBidDeltaBps: Map<string, number> = new Map();
  private prevAskDeltaBps: Map<string, number> = new Map();
  private lastBookSpread: Map<string, number> = new Map();
  private lastBookSpreadAt: Map<string, number> = new Map();
  private lastBookSpreadDeltaBps: Map<string, number> = new Map();
  private protectiveUntil: Map<string, number> = new Map();
  private volatilityEma: Map<string, number> = new Map();
  private depthEma: Map<string, number> = new Map();
  private totalDepthEma: Map<string, number> = new Map();
  private depthTrend: Map<string, number> = new Map();
  private lastDepth: Map<string, number> = new Map();
  private lastDepthSpeedBps: Map<string, number> = new Map();
  private lastBidDepthSpeedBps: Map<string, number> = new Map();
  private lastAskDepthSpeedBps: Map<string, number> = new Map();
  private lastImbalance: Map<string, number> = new Map();
  private lastActionAt: Map<string, number> = new Map();
  private actionBurst: Map<string, { count: number; windowStart: number }> = new Map();
  private actionLockUntil: Map<string, number> = new Map();
  private cooldownUntil: Map<string, number> = new Map();
  private pauseUntil: Map<string, number> = new Map();
  // CRITICAL FIX #2: 使用统一的 PositionSnapshot 接口
  private lastNetShares: Map<string, PositionSnapshot> = new Map();
  private lastHedgeAt: Map<string, number> = new Map();
  private lastIcebergAt: Map<string, number> = new Map();
  private lastFillAt: Map<string, number> = new Map();
  // 存储 token_id -> market 映射（支持 YES/NO 的不同 token_id）
  private marketByToken: Map<string, Market> = new Map();
  private lastProfile: Map<string, 'CALM' | 'NORMAL' | 'VOLATILE'> = new Map();
  private lastProfileAt: Map<string, number> = new Map();
  private icebergPenalty: Map<string, { value: number; ts: number }> = new Map();
  private nearTouchHoldUntil: Map<string, number> = new Map();
  private nearTouchPrevDistance: Map<string, number> = new Map();
  private repriceHoldUntil: Map<string, number> = new Map();
  private cancelHoldUntil: Map<string, number> = new Map();
  private sizePenalty: Map<string, { value: number; ts: number; auto?: boolean }> = new Map();
  private recheckCooldownUntil: Map<string, number> = new Map();
  private fillPressure: Map<string, { score: number; ts: number }> = new Map();
  private cancelBoost: Map<string, { value: number; ts: number }> = new Map();
  private nearTouchPenalty: Map<string, { value: number; ts: number }> = new Map();
  private fillPenalty: Map<string, { value: number; ts: number }> = new Map();
  private layerPanicUntil: Map<string, number> = new Map();
  private layerRetreatUntil: Map<string, number> = new Map();
  private layerRestoreAt: Map<string, number> = new Map();
  private layerRestoreStartAt: Map<string, number> = new Map();
  private layerRestoreExitPending: Map<string, boolean> = new Map();
  private layerRestoreExitRampStartAt: Map<string, number> = new Map();
  private layerRestoreExitRampUntil: Map<string, number> = new Map();
  private layerRestoreExitSizeRampStartAt: Map<string, number> = new Map();
  private layerRestoreExitSizeRampUntil: Map<string, number> = new Map();
  private layerRestoreExitRepricePending: Set<string> = new Set();
  private safeModeExitUntil: Map<string, number> = new Map();
  private wsHealthScore = 100;
  private wsHealthUpdatedAt = 0;
  private wsEmergencyLast: Map<string, number> = new Map();
  private wsEmergencyGlobalUntil = 0;
  private wsEmergencyGlobalLast = 0;
  private wsEmergencyRecoveryUntil = 0;
  private wsEmergencyRecoveryActive = false;
  private wsEmergencyRecoveryStart = 0;
  private wsEmergencyRecoveryStage = -1;
  private autoTuneState: Map<
    string,
    { mult: number; windowStart: number; placed: number; canceled: number; filled: number; lastUpdate: number; lastUtility: number }
  > = new Map();
  private mmMetrics: Map<string, Record<string, unknown>> = new Map();
  private mmEventLog: Array<{ ts: number; type: string; tokenId?: string; message: string }> = [];
  private mmLastFlushAt = 0;
  private valueDetector?: ValueMismatchDetector;
  private crossAggregator?: CrossPlatformAggregator;
  private crossExecutionRouter?: CrossPlatformExecutionRouter;

  private orderManager?: MakerOrderManager;
  private orderManagerFactory?: () => Promise<MakerOrderManager>;
  private tradingHalted = false;
  private tradingHaltAt = 0;  // 记录交易暂停的时间戳
  private sessionPnL = 0;
  private warnedNoExecution = false;
  private warnedNoOrderSync = false;
  private warnedNoPositionSync = false;
  private cancelBatchNonce = 0;
  private cancelBudget: Map<string, { count: number; windowStart: number; cooldownUntil: number }> = new Map();
  private cancelBurst: Map<string, { count: number; windowStart: number; cooldownUntil: number }> = new Map();
  private riskThrottleState: Map<string, { score: number; lastUpdate: number; coolOffUntil: number }> = new Map();
  private nearTouchBurst: Map<string, { count: number; windowStart: number }> = new Map();
  private fillBurst: Map<string, { count: number; windowStart: number }> = new Map();
  // P1 FIX: 下单互斥锁，防止余额检查→下单之间的TOCTOU竞争条件
  private placeOrderLock: Promise<void> = Promise.resolve();
  // 积分优化相关字段
  private pointsScores: Map<string, PointsMarketScore> = new Map();
  private pointsLastReportAt = 0;
  private pointsReportInterval = 5 * 60 * 1000; // 5分钟报告一次
  private pointsOrderbookCache: Map<string, Orderbook> = new Map();
  private pointsOrderbookCacheTs: Map<string, number> = new Map(); // 缓存时间戳
  private static readonly ORDERBOOK_CACHE_TTL = 1_500; // v20: 从3s缩到1.5s
  private predictBuyInsufficientUntil: Map<string, number> = new Map();
  private pauseReasons: Map<string, { reason: string; source: string; until: number }> = new Map();
  private polymarketPostOnlyStats: Map<
    string,
    { attempts: number; accepted: number; rejected: number; windowStart: number }
  > = new Map();
  private polymarketAdverseFillState: Map<
    string,
    { score: number; count: number; windowStart: number; lastAt: number }
  > = new Map();
  private polymarketCancelReasonState: Map<
    string,
    {
      windowStart: number;
      nearTouch: number;
      refresh: number;
      vwap: number;
      aggressive: number;
      unsafe: number;
      other: number;
    }
  > = new Map();
  private polymarketOrderLifecycleState: Map<
    string,
    {
      windowStart: number;
      placed: number;
      canceled: number;
      filled: number;
      cancelLifetimeMsSum: number;
      cancelSamples: number;
      fillLifetimeMsSum: number;
      fillSamples: number;
      lastUpdate: number;
    }
  > = new Map();
  private polymarketExecutionState: Map<
    string,
    {
      state: 'OBSERVE' | 'PROBE' | 'EARN' | 'DEFEND' | 'EXIT' | 'COOLDOWN';
      reason: string;
      since: number;
      updatedAt: number;
    }
  > = new Map();

  // ===== Phase 1: 增强模块字段 =====
  // 为每个市场维护独立的估算器
  private perMarketVolatility: Map<string, VolatilityEstimator> = new Map();
  private perMarketOrderFlow: Map<string, OrderFlowEstimator> = new Map();
  private perMarketReversion: Map<string, MeanReversionPredictor> = new Map();
  private perMarketInventoryState: Map<string, InventoryState> = new Map();

  // 全局估算器（共享）
  private volatilityEstimator: VolatilityEstimator;
  private orderFlowEstimator: OrderFlowEstimator;
  private inventoryClassifier: InventoryClassifier;
  private reversionPredictor: MeanReversionPredictor;
  private asModel: DynamicASModel;

  // ===== 统一做市商策略（整合所有优点） =====
  private unifiedMarketMakerStrategy: UnifiedMarketMakerStrategy;
  private lastPlacedPrices: Map<string, {
    yesBid: number;
    yesAsk: number;
    noBid: number;
    noAsk: number;
    timestamp: number;
  }> = new Map();

  // HIGH FIX #2: 成交检测初始化标志和互斥锁
  private fillDetectionInitialized = false;
  private fillDetectionInitPromise: Promise<void> | null = null;

  // ===== 两阶段循环对冲策略 =====
  private twoPhaseStrategy: TwoPhaseHedgeStrategy = twoPhaseHedgeStrategy;
  private perMarketTwoPhaseState: Map<string, TwoPhaseState> = new Map();

  // ===== Layer 2-7: 自适应做市商增强 =====
  // Layer 2: 市场筛选 — 记录不安全的市场
  private marketScreenResults: Map<string, { safe: boolean; reason: string; ts: number }> = new Map();
  // Layer 3: fill risk score 缓存
  private fillRiskScores: Map<string, number> = new Map();
  // Layer 4: 位置监控 — 记录自己的挂单位置
  private myOrderPosition: Map<string, { tier: number; totalTiers: number; ts: number }> = new Map();
  // Layer 5: fill 统计 — 被吃次数和黑名单
  private fillStats: Map<string, { count: number; lastFillAt: number; blacklistedUntil: number }> = new Map();
  // Layer 6: 渐进式报价 — 记录每个市场当前在第几步
  private progressiveState: Map<string, { step: number; startedAt: number; targetBuffer: number }> = new Map();
  // v22: cancel-on-displacement — 追踪位移撤单冷却（避免频繁撤-挂循环）
  private displacementCancelUntil: Map<string, number> = new Map();
  // Layer 7: 自适应缓冲 — 每个市场的最优缓冲值
  private adaptiveBuffer: Map<string, { value: number; pointsEarned: number; fillsReceived: number; lastUpdate: number }> = new Map();
  // depthMetrics 缓存（updateDepthMetrics 的返回值）
  private depthMetrics: Map<string, { totalDepth: number; bidDepth: number; askDepth: number; imbalance: number; depthTrend: number; depthSpeedBps: number; bidDepthSpeedBps: number; askDepthSpeedBps: number }> = new Map();

  constructor(api: MakerApi, config: Config, orderManagerFactory?: () => Promise<MakerOrderManager>) {
    this.api = api;
    this.config = config;
    this.orderManagerFactory = orderManagerFactory;

    // ===== Phase 1: 初始化增强模块 =====
    this.volatilityEstimator = new VolatilityEstimator();
    this.orderFlowEstimator = new OrderFlowEstimator();
    this.inventoryClassifier = new InventoryClassifier({
      safeThreshold: config.mmInventorySafeThreshold ?? 0.3,
      warningThreshold: config.mmInventoryWarningThreshold ?? 0.5,
      dangerThreshold: config.mmInventoryDangerThreshold ?? 0.7,
      enableAsymSpread: true
    });
    this.reversionPredictor = new MeanReversionPredictor();
    this.asModel = new DynamicASModel({
      gamma: config.mmASGamma ?? 0.1,
      lambda: config.mmASLambda ?? 1.0,
      kappa: config.mmASKappa ?? 1.5,
      alpha: config.mmASAlpha ?? 0.5,
      beta: config.mmASBeta ?? 0.3,
      delta: config.mmASDelta ?? 0.2
    });

    // ===== 初始化统一做市商策略（整合所有优点） =====
    this.unifiedMarketMakerStrategy = new UnifiedMarketMakerStrategy({
      enabled: config.unifiedMarketMakerEnabled ?? false,
      tolerance: config.unifiedMarketMakerTolerance ?? 0.05,
      minHedgeSize: config.unifiedMarketMakerMinSize ?? 10,
      maxHedgeSize: config.unifiedMarketMakerMaxSize ?? 500,
      buySpreadBps: config.unifiedMarketMakerBuySpreadBps ?? 150,
      sellSpreadBps: config.unifiedMarketMakerSellSpreadBps ?? 150,
      hedgeSlippageBps: config.unifiedMarketMakerHedgeSlippageBps ?? 250,
      asyncHedging: config.unifiedMarketMakerAsyncHedging ?? true,
      dualTrackMode: config.unifiedMarketMakerDualTrackMode ?? true,
      dynamicOffsetMode: config.unifiedMarketMakerDynamicOffsetMode ?? true,
      buyOffsetBps: config.unifiedMarketMakerBuyOffsetBps ?? 100,
      sellOffsetBps: config.unifiedMarketMakerSellOffsetBps ?? 100,
    });

    if (this.config.useValueSignal) {
      this.valueDetector = new ValueMismatchDetector(0, 0);
    }
    if (this.config.hedgeMode === 'CROSS' || this.config.crossPlatformEnabled) {
      this.crossAggregator = new CrossPlatformAggregator(this.config);
    }
  }

  private getErrorMessage(error: unknown): string {
    const maybeResponse = (error as any)?.response?.data;
    return maybeResponse?.message || (error as Error)?.message || String(error);
  }

  private isPredictBuyInsufficientError(message: string): boolean {
    const normalized = String(message || '').toLowerCase();
    return normalized.includes('insufficient collateral') || normalized.includes('balance insufficient');
  }

  private getPredictBuyBlockRemainingMs(tokenId: string): number {
    const until = this.predictBuyInsufficientUntil.get(tokenId) ?? 0;
    return Math.max(0, until - Date.now());
  }

  private setPauseReason(tokenId: string, pauseMs: number, reason: string, source = 'risk'): void {
    const until = Date.now() + Math.max(0, pauseMs);
    this.pauseUntil.set(tokenId, until);
    this.pauseReasons.set(tokenId, { reason, source, until });
  }

  public async enforceMarketPause(
    tokenId: string,
    pauseMs: number,
    reason: string,
    source = 'external',
    cancelOpenOrders = true
  ): Promise<void> {
    if (cancelOpenOrders) {
      await this.cancelOrdersForMarket(tokenId);
    }
    this.setPauseReason(tokenId, pauseMs, reason, source);
    this.recordMmEvent('MARKET_PAUSE', `${source}: ${reason}`, tokenId);
  }

  private getPredictSpreadSafetyThreshold(): number {
    return this.config.mmVenue === 'predict'
      ? (this.config.predictSafeMaxSpread ?? 0.06)
      : MarketMaker.MAX_ALLOWED_BOOK_SPREAD;
  }

  private getPredictSafetyConfig() {
    return {
      minL1Notional: this.config.predictSafeMinL1Notional ?? MarketMaker.PREDICT_SAFE_MIN_L1_NOTIONAL,
      minL2Notional: this.config.predictSafeMinL2Notional ?? MarketMaker.PREDICT_SAFE_MIN_L2_NOTIONAL,
      minL2ToL1Ratio: this.config.predictSafeMinL2ToL1Ratio ?? MarketMaker.PREDICT_SAFE_MIN_L2_TO_L1_RATIO,
      minPrice: this.config.predictSafeMinPrice ?? MarketMaker.PREDICT_SAFE_MIN_PRICE,
      maxPrice: this.config.predictSafeMaxPrice ?? MarketMaker.PREDICT_SAFE_MAX_PRICE,
      maxLevelGap: this.config.predictSafeMaxLevelGap ?? MarketMaker.PREDICT_SAFE_MAX_LEVEL_GAP,
      fillPauseMs: this.config.predictFillPauseMs ?? MarketMaker.PREDICT_FILL_PAUSE_MS,
      unsafeBookPauseMs: this.config.predictUnsafeBookPauseMs ?? MarketMaker.PREDICT_UNSAFE_BOOK_PAUSE_MS,
      positionLossLimitAbs: this.config.predictPositionLossLimitAbs ?? MarketMaker.PREDICT_POSITION_LOSS_LIMIT_ABS,
      positionLossLimitRatio: this.config.predictPositionLossLimitRatio ?? MarketMaker.PREDICT_POSITION_LOSS_LIMIT_RATIO,
      positionLossPauseMs: this.config.predictPositionLossPauseMs ?? MarketMaker.PREDICT_POSITION_LOSS_PAUSE_MS,
    };
  }

  private getPolymarketExecutionSafetyConfig() {
    return {
      minHitRate: this.config.polymarketPostOnlyMinHitRate ?? 0.7,
      minAttempts: this.config.polymarketPostOnlyMinAttempts ?? 6,
      windowMs: this.config.polymarketPostOnlyWindowMs ?? 10 * 60 * 1000,
      pauseMs: this.config.polymarketPostOnlyPauseMs ?? 5 * 60 * 1000,
      rewardSizeCapMultiplier: this.config.polymarketRewardSizeCapMultiplier ?? 1.25,
      rewardMinNetEfficiency: this.config.polymarketRewardMinNetEfficiency ?? 0.0008,
      rewardNetSizeFactorMin: this.config.polymarketRewardNetSizeFactorMin ?? 0.5,
      rewardMinQueueHours: this.config.polymarketRewardMinQueueHours ?? 0.75,
      rewardTargetQueueHours: this.config.polymarketRewardTargetQueueHours ?? 1.5,
      rewardTargetQueueTolerance: this.config.polymarketRewardTargetQueueTolerance ?? 0.5,
      rewardTargetPenaltyMax: this.config.polymarketRewardTargetPenaltyMax ?? 6,
      observedQueueMinSamples: this.config.polymarketObservedQueueMinSamples ?? 3,
      observedQueueMaxWeight: this.config.polymarketObservedQueueMaxWeight ?? 0.65,
      rewardQueueRetreatStart: this.config.polymarketRewardQueueRetreatStart ?? 3,
      rewardQueueRetreatMaxBps: this.config.polymarketRewardQueueRetreatMaxBps ?? 12,
      rewardFastFlowRetreatMaxBps: this.config.polymarketRewardFastFlowRetreatMaxBps ?? 8,
      rewardTargetRetreatMaxBps: this.config.polymarketRewardTargetRetreatMaxBps ?? 6,
      rewardTargetSizeFactorMin: this.config.polymarketRewardTargetSizeFactorMin ?? 0.65,
      stateProbeSizeFactor: this.config.polymarketStateProbeSizeFactor ?? 0.55,
      stateProbeRetreatBps: this.config.polymarketStateProbeRetreatBps ?? 3,
      stateObserveSizeFactor: this.config.polymarketStateObserveSizeFactor ?? 0.3,
      stateObserveRetreatBps: this.config.polymarketStateObserveRetreatBps ?? 10,
      stateDefendSizeFactor: this.config.polymarketStateDefendSizeFactor ?? 0.5,
      stateDefendRetreatBps: this.config.polymarketStateDefendRetreatBps ?? 7,
      cancelReasonDominanceThreshold: this.config.polymarketCancelReasonDominanceThreshold ?? 0.45,
      cancelReasonRetreatMaxBps: this.config.polymarketCancelReasonRetreatMaxBps ?? 10,
      cancelReasonSizeFactorMin: this.config.polymarketCancelReasonSizeFactorMin ?? 0.55,
      cancelPatternFuseMinCount: this.config.polymarketCancelPatternFuseMinCount ?? 6,
      cancelPatternFuseDominance: this.config.polymarketCancelPatternFuseDominance ?? 0.7,
      cancelPatternFusePauseMs: this.config.polymarketCancelPatternFusePauseMs ?? 20 * 60 * 1000,
      adverseFillWindowMs: this.config.polymarketAdverseFillWindowMs ?? 20 * 60 * 1000,
      adverseFillPauseMs: this.config.polymarketAdverseFillPauseMs ?? 45 * 60 * 1000,
      adverseFillScoreThreshold: this.config.polymarketAdverseFillScoreThreshold ?? 3.5,
      adverseFillPnlPenalty: this.config.polymarketAdverseFillPnlPenalty ?? 1.25,
      adversePressureThreshold: this.config.polymarketAdversePressureThreshold ?? 0.18,
      adverseImbalanceThreshold: this.config.polymarketAdverseImbalanceThreshold ?? 0.55,
      adverseDepthSpeedBps: this.config.polymarketAdverseDepthSpeedBps ?? 12,
      positionLossLimitAbs: this.config.polymarketPositionLossLimitAbs ?? 20,
      positionLossLimitRatio: this.config.polymarketPositionLossLimitRatio ?? 0.2,
      positionLossPauseMs: this.config.polymarketPositionLossPauseMs ?? 30 * 60 * 1000,
      patternMemoryMaxPenalty: this.config.polymarketPatternMemoryMaxPenalty ?? 8,
      patternMemoryRetreatMaxBps: this.config.polymarketPatternMemoryRetreatMaxBps ?? 8,
      patternMemorySizeFactorMin: this.config.polymarketPatternMemorySizeFactorMin ?? 0.7,
      eventRiskBlockWithinMs: this.config.polymarketEventRiskBlockWithinMs ?? 30 * 60 * 1000,
      eventRiskPenaltyWithinMs: this.config.polymarketEventRiskPenaltyWithinMs ?? 4 * 60 * 60 * 1000,
      eventRiskPenaltyMax: this.config.polymarketEventRiskPenaltyMax ?? 6,
      eventRiskSizeFactorMin: this.config.polymarketEventRiskSizeFactorMin ?? 0.45,
      eventRiskRetreatMaxBps: this.config.polymarketEventRiskRetreatMaxBps ?? 10,
      catalystRiskPenaltyWithinMs: this.config.polymarketCatalystRiskPenaltyWithinMs ?? 90 * 60 * 1000,
      catalystRiskBlockWithinMs: this.config.polymarketCatalystRiskBlockWithinMs ?? 10 * 60 * 1000,
      catalystRiskPenaltyMax: this.config.polymarketCatalystRiskPenaltyMax ?? 7,
      catalystRiskSizeFactorMin: this.config.polymarketCatalystRiskSizeFactorMin ?? 0.35,
      catalystRiskRetreatMaxBps: this.config.polymarketCatalystRiskRetreatMaxBps ?? 14,
      groupMaxExposureFactor: this.config.polymarketGroupMaxExposureFactor ?? 1.4,
      groupSoftExposureStart: this.config.polymarketGroupSoftExposureStart ?? 0.7,
      groupSizeFactorMin: this.config.polymarketGroupSizeFactorMin ?? 0.55,
      groupRetreatMaxBps: this.config.polymarketGroupRetreatMaxBps ?? 12,
      themeMaxExposureFactor: this.config.polymarketThemeMaxExposureFactor ?? 2.2,
      themeSoftExposureStart: this.config.polymarketThemeSoftExposureStart ?? 0.65,
      themeSizeFactorMin: this.config.polymarketThemeSizeFactorMin ?? 0.5,
      themeRetreatMaxBps: this.config.polymarketThemeRetreatMaxBps ?? 10,
      autoTuneUtilityTarget: this.config.mmAutoTuneUtilityTarget ?? 0.7,
      autoTuneUtilityDeadband: this.config.mmAutoTuneUtilityDeadband ?? 0.15,
      autoTuneRewardWeight: this.config.mmAutoTuneRewardWeight ?? 1,
      autoTuneFillCostWeight: this.config.mmAutoTuneFillCostWeight ?? 1,
      autoTuneCancelCostWeight: this.config.mmAutoTuneCancelCostWeight ?? 0.75,
      autoTuneRiskWeight: this.config.mmAutoTuneRiskWeight ?? 0.6,
    };
  }

  private isPolymarketPostOnlyOrder(payload: any): boolean {
    return this.config.mmVenue === 'polymarket' && payload?.postOnly === true;
  }

  private isPolymarketPostOnlyReject(message: string): boolean {
    const normalized = String(message || '').toLowerCase();
    return (
      normalized.includes('post only') ||
      normalized.includes('post-only') ||
      normalized.includes('would match') ||
      normalized.includes('would trade') ||
      normalized.includes('marketable') ||
      normalized.includes('crosses') ||
      normalized.includes('would execute')
    );
  }

  private recordPolymarketPostOnlyResult(tokenId: string, accepted: boolean): void {
    const now = Date.now();
    const config = this.getPolymarketExecutionSafetyConfig();
    const existing = this.polymarketPostOnlyStats.get(tokenId);
    const shouldReset = !existing || now - existing.windowStart > config.windowMs;
    const stats = shouldReset
      ? { attempts: 0, accepted: 0, rejected: 0, windowStart: now }
      : existing;

    stats.attempts += 1;
    if (accepted) {
      stats.accepted += 1;
    } else {
      stats.rejected += 1;
    }
    this.polymarketPostOnlyStats.set(tokenId, stats);
  }

  private shouldTripPolymarketPostOnlyFuse(tokenId: string): boolean {
    const stats = this.polymarketPostOnlyStats.get(tokenId);
    if (!stats) return false;
    const config = this.getPolymarketExecutionSafetyConfig();
    if (stats.attempts < config.minAttempts) {
      return false;
    }
    const hitRate = stats.accepted / Math.max(1, stats.attempts);
    if (hitRate >= config.minHitRate) {
      return false;
    }
    const pauseMs = Math.max(1000, Number(config.pauseMs || 0));
    this.setPauseReason(tokenId, pauseMs, 'postOnly 命中率过低', 'polymarket-post-only');
    this.recordMmEvent(
      'POLYMARKET_POST_ONLY_FUSE',
      `postOnly hit rate ${(hitRate * 100).toFixed(0)}% < ${(config.minHitRate * 100).toFixed(0)}%, attempts=${stats.attempts}`,
      tokenId
    );
    console.log(
      `⏸️ Polymarket postOnly fuse ${tokenId.slice(0, 8)}: hit rate ${(hitRate * 100).toFixed(0)}% ` +
        `< ${(config.minHitRate * 100).toFixed(0)}%, pause ${Math.round(pauseMs / 1000)}s`
    );
    return true;
  }

  private isUnsafeBook(orderbook: Orderbook | null | undefined): boolean {
    if (!orderbook) {
      return true;
    }
    const bestBid = Number(orderbook.best_bid ?? 0);
    const bestAsk = Number(orderbook.best_ask ?? 0);
    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0 || bestBid >= bestAsk) {
      return true;
    }
    if (bestAsk - bestBid > this.getPredictSpreadSafetyThreshold()) {
      return true;
    }
    if (this.config.mmVenue === 'predict') {
      const safety = this.getPredictSafetyConfig();
      const mid = Number(orderbook.mid_price ?? (bestBid + bestAsk) / 2);
      if (!Number.isFinite(mid) || mid < safety.minPrice || mid > safety.maxPrice) {
        return true;
      }
      const bid1 = this.getLevelNotional(orderbook.bids, 0, 'bids');
      const ask1 = this.getLevelNotional(orderbook.asks, 0, 'asks');
      const bid2 = this.getLevelNotional(orderbook.bids, 1, 'bids');
      const ask2 = this.getLevelNotional(orderbook.asks, 1, 'asks');
      if (
        Math.min(bid1, ask1) < safety.minL1Notional ||
        Math.min(bid2, ask2) < safety.minL2Notional
      ) {
        return true;
      }
      if (
        this.getSupportRatio(orderbook.bids, 'bids') < safety.minL2ToL1Ratio ||
        this.getSupportRatio(orderbook.asks, 'asks') < safety.minL2ToL1Ratio
      ) {
        return true;
      }
      const bidGap = this.getLevelGap(orderbook.bids, 'bids');
      const askGap = this.getLevelGap(orderbook.asks, 'asks');
      if (bidGap > safety.maxLevelGap || askGap > safety.maxLevelGap) {
        return true;
      }
    }
    return false;
  }

  private getLevelNotional(levels: OrderbookEntry[] | undefined, index: number, side: 'bids' | 'asks'): number {
    if (!Array.isArray(levels) || levels.length <= index) {
      return 0;
    }
    const sorted = [...levels].sort((a, b) => {
      const ap = Number(a.price || 0);
      const bp = Number(b.price || 0);
      return side === 'bids' ? bp - ap : ap - bp;
    });
    const level = sorted[index];
    const price = Number(level?.price || 0);
    const shares = Number(level?.shares || 0);
    if (!Number.isFinite(price) || !Number.isFinite(shares) || price <= 0 || shares <= 0) {
      return 0;
    }
    return price * shares;
  }

  private getLevelGap(levels: OrderbookEntry[] | undefined, side: 'bids' | 'asks'): number {
    if (!Array.isArray(levels) || levels.length < 2) {
      return Number.POSITIVE_INFINITY;
    }
    const sorted = [...levels].sort((a, b) => {
      const ap = Number(a.price || 0);
      const bp = Number(b.price || 0);
      return side === 'bids' ? bp - ap : ap - bp;
    });
    const first = Number(sorted[0]?.price || 0);
    const second = Number(sorted[1]?.price || 0);
    if (!Number.isFinite(first) || !Number.isFinite(second) || first <= 0 || second <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    return side === 'bids' ? first - second : second - first;
  }

  private getLevelPrice(levels: OrderbookEntry[] | undefined, index: number, side: 'bids' | 'asks'): number | null {
    if (!Array.isArray(levels) || levels.length <= index) {
      return null;
    }
    const sorted = [...levels].sort((a, b) => {
      const ap = Number(a.price || 0);
      const bp = Number(b.price || 0);
      return side === 'bids' ? bp - ap : ap - bp;
    });
    const price = Number(sorted[index]?.price || 0);
    if (!Number.isFinite(price) || price <= 0) {
      return null;
    }
    return price;
  }

  /**
   * v15: 计算某价位前方（closer to BBO）的累计流动性（股数）
   * bid侧：价格 > levelPrice 的所有档位的累计股数
   * ask侧：价格 < levelPrice 的所有档位的累计股数
   */
  private sumFrontDepth(levels: OrderbookEntry[] | undefined, levelPrice: number, side: 'bids' | 'asks', tokenId?: string): number {
    if (!Array.isArray(levels) || levelPrice <= 0) return 0;
    // H1 FIX: 收集自己的挂单价格，排除自挂单深度
    const myOrderPrices = new Set<number>();
    if (tokenId) {
      for (const [, o] of this.openOrders) {
        if (o.token_id === tokenId) {
          myOrderPrices.add(Number(o.price));
        }
      }
    }
    let sum = 0;
    for (const entry of levels) {
      const p = Number(entry.price || 0);
      const s = Number(entry.shares || (entry as any).size || 0);
      // 跳过自己的挂单
      if (myOrderPrices.has(p)) continue;
      if (side === 'bids') {
        // bid侧：比levelPrice高的（更靠近盘口）累计
        if (p > levelPrice) sum += s;
      } else {
        // ask侧：比levelPrice低的（更靠近盘口）累计
        if (p < levelPrice) sum += s;
      }
    }
    return sum;
  }

  private getLevelShares(levels: OrderbookEntry[] | undefined, index: number, side: 'bids' | 'asks'): number | null {
    if (!Array.isArray(levels) || levels.length <= index) {
      return null;
    }
    const sorted = [...levels].sort((a, b) => {
      const ap = Number(a.price || 0);
      const bp = Number(b.price || 0);
      return side === 'bids' ? bp - ap : ap - bp;
    });
    const shares = Number(sorted[index]?.shares || 0);
    if (!Number.isFinite(shares) || shares <= 0) {
      return null;
    }
    return shares;
  }

  private getSupportRatio(levels: OrderbookEntry[] | undefined, side: 'bids' | 'asks'): number {
    if (!Array.isArray(levels) || levels.length < 2) {
      return 0;
    }
    const sorted = [...levels].sort((a, b) => {
      const ap = Number(a.price || 0);
      const bp = Number(b.price || 0);
      return side === 'bids' ? bp - ap : ap - bp;
    });
    const first = Number(sorted[0]?.shares || 0);
    const second = Number(sorted[1]?.shares || 0);
    if (!Number.isFinite(first) || !Number.isFinite(second) || first <= 0 || second <= 0) {
      return 0;
    }
    return second / first;
  }

  private async triggerPredictUnsafeBookPause(tokenId: string, reason: string): Promise<void> {
    if (this.config.mmVenue !== 'predict') {
      return;
    }
    await this.cancelOrdersForMarket(tokenId);
    const pauseMs = this.getPredictSafetyConfig().unsafeBookPauseMs;
    this.setPauseReason(tokenId, pauseMs, reason, 'predict-unsafe-book');
    console.warn(`🛑 [PredictSafety] ${reason}，已撤单并暂停 ${Math.round(pauseMs / 60000)} 分钟: ${tokenId}`);
  }

  private async triggerPredictFillCircuitBreaker(tokenId: string, reason: string): Promise<void> {
    if (this.config.mmVenue !== 'predict') {
      return;
    }
    await this.cancelOrdersForMarket(tokenId);
    const pauseMs = this.getPredictSafetyConfig().fillPauseMs;
    this.setPauseReason(tokenId, pauseMs, reason, 'predict-fill-fuse');
    console.warn(`🛑 [PredictSafety] ${reason}，已撤单并暂停 ${Math.round(pauseMs / 60000)} 分钟: ${tokenId}`);
  }

  private async handlePredictUnsafePair(yesTokenId?: string, noTokenId?: string, reason = '盘口不安全'): Promise<void> {
    if (yesTokenId) {
      await this.triggerPredictUnsafeBookPause(yesTokenId, reason);
    }
    if (noTokenId && noTokenId !== yesTokenId) {
      await this.triggerPredictUnsafeBookPause(noTokenId, reason);
    }
  }

  private shouldTripPredictLossFuse(position: Position | undefined): boolean {
    if (this.config.mmVenue !== 'predict' || !position) {
      return false;
    }
    const pnl = Number(position.pnl || 0);
    const value = Math.abs(Number(position.total_value || 0));
    const safety = this.getPredictSafetyConfig();
    if (!Number.isFinite(pnl) || pnl >= 0) {
      return false;
    }
    if (pnl <= -safety.positionLossLimitAbs) {
      return true;
    }
    if (value > 0 && Math.abs(pnl) / value >= safety.positionLossLimitRatio) {
      return true;
    }
    return false;
  }

  private async triggerPredictLossFuse(tokenId: string, position: Position | undefined): Promise<void> {
    if (this.config.mmVenue !== 'predict') {
      return;
    }
    await this.cancelOrdersForMarket(tokenId);
    const pauseMs = this.getPredictSafetyConfig().positionLossPauseMs;
    this.setPauseReason(tokenId, pauseMs, '单市场亏损熔断', 'predict-loss-fuse');
    console.warn(
      `🛑 [PredictSafety] 单市场亏损熔断: token=${tokenId} pnl=${Number(position?.pnl || 0).toFixed(2)} value=${Number(position?.total_value || 0).toFixed(2)}`
    );
  }

  private shouldTripPolymarketLossFuse(position: Position | undefined): boolean {
    if (this.config.mmVenue !== 'polymarket' || !position) {
      return false;
    }
    const pnl = Number(position.pnl || position.value || 0);
    const value = Math.abs(Number(position.total_value || position.value || 0));
    const safety = this.getPolymarketExecutionSafetyConfig();
    if (!Number.isFinite(pnl) || pnl >= 0) {
      return false;
    }
    if (pnl <= -safety.positionLossLimitAbs) {
      return true;
    }
    if (value > 0 && Math.abs(pnl) / value >= safety.positionLossLimitRatio) {
      return true;
    }
    return false;
  }

  private async triggerPolymarketLossFuse(tokenId: string, position: Position | undefined): Promise<void> {
    if (this.config.mmVenue !== 'polymarket') {
      return;
    }
    const pauseMs = this.getPolymarketExecutionSafetyConfig().positionLossPauseMs;
    await this.enforceMarketPause(tokenId, pauseMs, '单市场亏损熔断', 'polymarket-loss-fuse', true);
    console.warn(
      `🛑 [PolymarketSafety] 单市场亏损熔断: token=${tokenId} pnl=${Number(position?.pnl || 0).toFixed(2)} value=${Number(position?.total_value || 0).toFixed(2)}`
    );
  }

  private getPolymarketRewardRule(market: Market): { enabled: boolean; minShares: number; maxSpread: number } {
    const minShares = Math.max(0, Number(market.liquidity_activation?.min_shares || market.polymarket_reward_min_size || 0));
    const maxSpread = Math.max(
      0,
      Number(
        market.liquidity_activation?.max_spread ??
          (market.liquidity_activation?.max_spread_cents
            ? market.liquidity_activation.max_spread_cents / 100
            : market.polymarket_reward_max_spread || 0)
      )
    );
    const enabled = Boolean(market.polymarket_rewards_enabled) && minShares > 0 && maxSpread > 0;
    return { enabled, minShares, maxSpread };
  }

  private getPolymarketRewardSizeCapShares(market: Market): number {
    if (this.config.mmVenue !== 'polymarket') {
      return 0;
    }
    const reward = this.getPolymarketRewardRule(market);
    if (!reward.enabled) {
      return 0;
    }
    const mult = Math.max(1, Number(this.getPolymarketExecutionSafetyConfig().rewardSizeCapMultiplier || 1.25));
    let shares = Math.max(0, Math.floor(reward.minShares * mult));
    const recentRiskPenalty = Number(market.polymarket_recent_risk_penalty || 0);
    const blockPenalty = Math.max(1, Number(this.config.polymarketRecentRiskBlockPenalty || 12));
    const minFactor = this.clamp(Number(this.config.polymarketRecentRiskSizeFactorMin || 0.45), 0.1, 1);
    if (recentRiskPenalty > 0) {
      const penaltyRatio = this.clamp(recentRiskPenalty / blockPenalty, 0, 1);
      const shrinkFactor = 1 - (1 - minFactor) * penaltyRatio;
      shares = Math.max(1, Math.floor(shares * shrinkFactor));
    }
    const patternPenalty = Number(market.polymarket_pattern_memory_penalty || 0);
    const patternBlockPenalty = Math.max(1, Number(this.config.polymarketPatternMemoryBlockPenalty || 6));
    const patternMinFactor = this.clamp(Number(this.config.polymarketPatternMemorySizeFactorMin || 0.7), 0.1, 1);
    if (patternPenalty > 0) {
      const penaltyRatio = this.clamp(patternPenalty / patternBlockPenalty, 0, 1);
      const decayFactor = this.clamp(Number(market.polymarket_pattern_memory_decay_factor || 1), 0.15, 1);
      const shrinkFactor = 1 - (1 - patternMinFactor) * penaltyRatio * decayFactor;
      shares = Math.max(1, Math.floor(shares * shrinkFactor));
    }
    const hourRiskPenalty = Number(market.polymarket_hour_risk_penalty || 0);
    const hourBlockPenalty = Math.max(1, Number(this.config.polymarketHourRiskBlockPenalty || 6));
    const hourMinFactor = this.clamp(Number(this.config.polymarketHourRiskSizeFactorMin || 0.55), 0.1, 1);
    if (hourRiskPenalty > 0) {
      const penaltyRatio = this.clamp(hourRiskPenalty / hourBlockPenalty, 0, 1);
      const shrinkFactor = 1 - (1 - hourMinFactor) * penaltyRatio;
      shares = Math.max(1, Math.floor(shares * shrinkFactor));
    }
    const queueTargetFactor = this.clamp(Number(market.polymarket_reward_queue_target_factor || 1), 0.1, 1);
    const queueTargetMinFactor = this.clamp(Number(this.config.polymarketRewardTargetSizeFactorMin || 0.65), 0.1, 1);
    if (queueTargetFactor < 1) {
      const shrinkFactor = Math.max(queueTargetMinFactor, queueTargetFactor);
      shares = Math.max(1, Math.floor(shares * shrinkFactor));
    }
    const netEfficiency = Number(
      market.polymarket_reward_effective_net_efficiency || market.polymarket_reward_net_efficiency || 0
    );
    if (netEfficiency > 0 && Number.isFinite(netEfficiency)) {
      const minNetEfficiency = Math.max(0, Number(this.config.polymarketRewardMinNetEfficiency || 0.0008));
      const netMinFactor = this.clamp(Number(this.config.polymarketRewardNetSizeFactorMin || 0.5), 0.1, 1);
      if (netEfficiency < minNetEfficiency * 2) {
        const ratio = this.clamp(netEfficiency / Math.max(minNetEfficiency * 2, 1e-9), 0, 1);
        const shrinkFactor = netMinFactor + (1 - netMinFactor) * ratio;
        shares = Math.max(1, Math.floor(shares * shrinkFactor));
      }
    }
    return shares;
  }

  private getPolymarketRewardCrowdingMultiple(market: Market, orderbook: Orderbook): number {
    if (this.config.mmVenue !== 'polymarket') {
      return 0;
    }
    const reward = this.getPolymarketRewardRule(market);
    if (!reward.enabled || reward.minShares <= 0) {
      return 0;
    }
    const bid1Shares = this.getLevelShares(orderbook.bids, 0, 'bids') || 0;
    const ask1Shares = this.getLevelShares(orderbook.asks, 0, 'asks') || 0;
    const bid2Shares = this.getLevelShares(orderbook.bids, 1, 'bids') || 0;
    const ask2Shares = this.getLevelShares(orderbook.asks, 1, 'asks') || 0;
    const l1MinShares = bid1Shares > 0 && ask1Shares > 0 ? Math.min(bid1Shares, ask1Shares) : 0;
    const l2MinShares = bid2Shares > 0 && ask2Shares > 0 ? Math.min(bid2Shares, ask2Shares) : 0;
    // We quote around level two, so queue pressure is the size already ahead on
    // level one plus the existing queue at level two.
    return (l1MinShares + l2MinShares) / Math.max(1, reward.minShares);
  }

  private getPolymarketRewardQueueHours(market: Market, orderbook: Orderbook): {
    queueAheadShares: number;
    hourlyTurnoverShares: number;
    queueHours: number;
    crowdingMultiple: number;
    queueModel: 'volume-24h' | 'observed' | 'blended';
    queueConfidence: number;
    observedQueueHours: number | null;
  } {
    const reward = this.getPolymarketRewardRule(market);
    const crowdingMultiple = this.getPolymarketRewardCrowdingMultiple(market, orderbook);
    const queueAheadShares = reward.enabled ? reward.minShares * Math.max(0, crowdingMultiple) : 0;
    const mid = Number(orderbook.mid_price || 0);
    const volume24h = Number(market.volume_24h || 0);
    const baseHourlyTurnoverShares = mid > 0 ? volume24h / mid / 24 : 0;
    const cfg = this.getPolymarketExecutionSafetyConfig();
    const lifecycle = this.getPolymarketLifecycleSnapshot(market.token_id);
    const observedQueueHours =
      lifecycle.filled >= Math.max(1, Number(cfg.observedQueueMinSamples || 0)) && lifecycle.avgFillLifetimeMs > 0
        ? lifecycle.avgFillLifetimeMs / 3600000
        : null;
    const observedTurnoverShares =
      observedQueueHours && observedQueueHours > 0 && queueAheadShares > 0 ? queueAheadShares / observedQueueHours : 0;
    const observedBaseWeight =
      observedQueueHours && observedQueueHours > 0
        ? this.clamp(lifecycle.filled / Math.max(1, Number(cfg.observedQueueMinSamples || 1)), 0, 1)
        : 0;
    const observedWeight =
      observedTurnoverShares > 0
        ? this.clamp(
            observedBaseWeight * (1 - this.clamp(lifecycle.cancelRate * 0.35, 0, 0.35)),
            0,
            Number(cfg.observedQueueMaxWeight || 0.65)
          )
        : 0;
    const hourlyTurnoverShares =
      observedWeight > 0 && observedTurnoverShares > 0
        ? baseHourlyTurnoverShares * (1 - observedWeight) + observedTurnoverShares * observedWeight
        : baseHourlyTurnoverShares;
    const queueHours =
      queueAheadShares > 0 && hourlyTurnoverShares > 0 ? queueAheadShares / hourlyTurnoverShares : Number.POSITIVE_INFINITY;
    const queueModel = observedWeight > 0.5 ? 'observed' : observedWeight > 0 ? 'blended' : 'volume-24h';
    const queueConfidence = observedWeight > 0 ? this.clamp(0.35 + observedWeight, 0, 1) : 0.25;
    market.polymarket_reward_queue_model = reward.enabled ? queueModel : undefined;
    market.polymarket_reward_queue_confidence = reward.enabled ? queueConfidence : undefined;
    market.polymarket_reward_observed_queue_hours = reward.enabled ? observedQueueHours ?? undefined : undefined;
    return { queueAheadShares, hourlyTurnoverShares, queueHours, crowdingMultiple, queueModel, queueConfidence, observedQueueHours };
  }

  private getPolymarketQueueTargetAdjustment(market: Market, orderbook: Orderbook): {
    targetQueueHours: number;
    queueHours: number;
    queueAheadShares: number;
    crowdingMultiple: number;
    targetFactor: number;
    targetPenalty: number;
    retreatBps: number;
    sizeFactor: number;
    reason: string;
  } {
    if (this.config.mmVenue !== 'polymarket') {
      return {
        targetQueueHours: 0,
        queueHours: 0,
        queueAheadShares: 0,
        crowdingMultiple: 0,
        targetFactor: 1,
        targetPenalty: 0,
        retreatBps: 0,
        sizeFactor: 1,
        reason: '',
      };
    }
    const reward = this.getPolymarketRewardRule(market);
    const cfg = this.getPolymarketExecutionSafetyConfig();
    const targetQueueHours = Math.max(0, Number(cfg.rewardTargetQueueHours || 0));
    const tolerance = Math.max(0, Number(cfg.rewardTargetQueueTolerance || 0));
    const penaltyMax = Math.max(0, Number(cfg.rewardTargetPenaltyMax || 0));
    const retreatMaxBps = Math.max(0, Number(cfg.rewardTargetRetreatMaxBps || 0));
    const sizeFactorMin = this.clamp(Number(cfg.rewardTargetSizeFactorMin || 0.65), 0.1, 1);
    const queueStats = this.getPolymarketRewardQueueHours(market, orderbook);
    if (!reward.enabled || targetQueueHours <= 0) {
      return {
        targetQueueHours,
        queueHours: queueStats.queueHours,
        queueAheadShares: queueStats.queueAheadShares,
        crowdingMultiple: queueStats.crowdingMultiple,
        targetFactor: 1,
        targetPenalty: 0,
        retreatBps: 0,
        sizeFactor: 1,
        reason: '',
      };
    }
    const lowerQueueHours = targetQueueHours * Math.max(0.1, 1 - tolerance);
    const upperQueueHours = targetQueueHours * (1 + tolerance);
    if (!Number.isFinite(queueStats.queueHours) || queueStats.queueHours <= 0) {
      return {
        targetQueueHours,
        queueHours: queueStats.queueHours,
        queueAheadShares: queueStats.queueAheadShares,
        crowdingMultiple: queueStats.crowdingMultiple,
        targetFactor: 0.35,
        targetPenalty: penaltyMax,
        retreatBps: retreatMaxBps,
        sizeFactor: sizeFactorMin,
        reason: `排队过浅，目标约 ${targetQueueHours.toFixed(2)}h，当前无法形成稳定队列`,
      };
    }
    if (queueStats.queueHours < lowerQueueHours) {
      const ratio = this.clamp((lowerQueueHours - queueStats.queueHours) / Math.max(lowerQueueHours, 0.01), 0, 1);
      const factor = this.clamp(1 - 0.65 * ratio, 0.35, 1);
      return {
        targetQueueHours,
        queueHours: queueStats.queueHours,
        queueAheadShares: queueStats.queueAheadShares,
        crowdingMultiple: queueStats.crowdingMultiple,
        targetFactor: factor,
        targetPenalty: ratio * penaltyMax,
        retreatBps: retreatMaxBps * ratio,
        sizeFactor: 1 - (1 - sizeFactorMin) * ratio,
        reason: `排队过浅，目标约 ${targetQueueHours.toFixed(2)}h，当前 ${queueStats.queueHours.toFixed(2)}h`,
      };
    }
    if (queueStats.queueHours > upperQueueHours) {
      const ratio = this.clamp((queueStats.queueHours - upperQueueHours) / Math.max(upperQueueHours, 0.01), 0, 1.5);
      const factor = this.clamp(1 - 0.5 * Math.min(1, ratio), 0.5, 1);
      return {
        targetQueueHours,
        queueHours: queueStats.queueHours,
        queueAheadShares: queueStats.queueAheadShares,
        crowdingMultiple: queueStats.crowdingMultiple,
        targetFactor: factor,
        targetPenalty: Math.min(penaltyMax, ratio * penaltyMax * 0.7),
        retreatBps: 0,
        sizeFactor: 1 - (1 - sizeFactorMin) * Math.min(1, ratio),
        reason: `排队过深，目标约 ${targetQueueHours.toFixed(2)}h，当前 ${queueStats.queueHours.toFixed(2)}h`,
      };
    }
    return {
      targetQueueHours,
      queueHours: queueStats.queueHours,
      queueAheadShares: queueStats.queueAheadShares,
      crowdingMultiple: queueStats.crowdingMultiple,
      targetFactor: 1,
      targetPenalty: 0,
      retreatBps: 0,
      sizeFactor: 1,
      reason: `排队处于目标区间，当前 ${queueStats.queueHours.toFixed(2)}h / 目标 ${targetQueueHours.toFixed(2)}h`,
    };
  }

  private getPolymarketRewardQueueRetreatBps(market: Market, orderbook: Orderbook): number {
    if (this.config.mmVenue !== 'polymarket') {
      return 0;
    }
    const queueStats = this.getPolymarketRewardQueueHours(market, orderbook);
    const crowdingMultiple = queueStats.crowdingMultiple;
    const cfg = this.getPolymarketExecutionSafetyConfig();
    const crowdingExtra = Math.max(0, crowdingMultiple - cfg.rewardQueueRetreatStart) * 2;
    const fastFlowExtra =
      Number.isFinite(queueStats.queueHours) && queueStats.queueHours < cfg.rewardMinQueueHours
        ? ((cfg.rewardMinQueueHours - queueStats.queueHours) / Math.max(cfg.rewardMinQueueHours, 0.01)) *
          cfg.rewardFastFlowRetreatMaxBps
        : 0;
    const queueTargetExtra = this.getPolymarketQueueTargetAdjustment(market, orderbook).retreatBps;
    const patternPenalty = Number(market.polymarket_pattern_memory_penalty || 0);
    const patternBlockPenalty = Math.max(1, Number(this.config.polymarketPatternMemoryBlockPenalty || 6));
    const patternRatio = this.clamp(patternPenalty / patternBlockPenalty, 0, 1);
    const patternDecayFactor = this.clamp(Number(market.polymarket_pattern_memory_decay_factor || 1), 0.15, 1);
    const patternExtra = patternRatio * Number(cfg.patternMemoryRetreatMaxBps || 0) * patternDecayFactor;
    return this.clamp(
      crowdingExtra + fastFlowExtra + queueTargetExtra + patternExtra,
      0,
      cfg.rewardQueueRetreatMaxBps +
        cfg.rewardFastFlowRetreatMaxBps +
        Number(cfg.rewardTargetRetreatMaxBps || 0) +
        Number(cfg.patternMemoryRetreatMaxBps || 0)
    );
  }

  private getPolymarketEventRiskAdjustment(market: Market): { retreatBps: number; sizeFactor: number; reason: string; block: boolean } {
    if (this.config.mmVenue !== 'polymarket') {
      return { retreatBps: 0, sizeFactor: 1, reason: '', block: false };
    }
    const cfg = this.getPolymarketExecutionSafetyConfig();
    const eventRisk = evaluatePolymarketEventRisk(market, {
      penaltyWithinMs: cfg.eventRiskPenaltyWithinMs,
      blockWithinMs: cfg.eventRiskBlockWithinMs,
      penaltyMax: cfg.eventRiskPenaltyMax,
      sizeFactorMin: cfg.eventRiskSizeFactorMin,
      catalystPenaltyWithinMs: cfg.catalystRiskPenaltyWithinMs,
      catalystBlockWithinMs: cfg.catalystRiskBlockWithinMs,
      catalystPenaltyMax: cfg.catalystRiskPenaltyMax,
      catalystSizeFactorMin: cfg.catalystRiskSizeFactorMin,
    });
    market.polymarket_event_risk_penalty = eventRisk.penalty > 0 ? eventRisk.penalty : undefined;
    market.polymarket_event_risk_reason = eventRisk.reason || undefined;
    market.polymarket_event_risk_source = eventRisk.source;
    market.polymarket_event_time_to_close_ms = eventRisk.timeToCloseMs;
    market.polymarket_event_time_to_catalyst_ms = eventRisk.timeToCatalystMs;
    market.polymarket_event_catalyst_label = eventRisk.catalystLabel || undefined;
    market.polymarket_event_risk_size_factor = eventRisk.sizeFactor < 1 ? eventRisk.sizeFactor : undefined;
    const retreatMaxBps =
      eventRisk.source === 'catalyst'
        ? Math.max(0, Number(cfg.catalystRiskRetreatMaxBps || 0))
        : Math.max(0, Number(cfg.eventRiskRetreatMaxBps || 0));
    const penaltyMax =
      eventRisk.source === 'catalyst'
        ? Math.max(0, Number(cfg.catalystRiskPenaltyMax || 0))
        : Math.max(0, Number(cfg.eventRiskPenaltyMax || 0));
    const ratio = penaltyMax > 0 ? this.clamp(eventRisk.penalty / penaltyMax, 0, 1) : 0;
    return {
      retreatBps: retreatMaxBps * ratio,
      sizeFactor: eventRisk.sizeFactor,
      reason: eventRisk.reason,
      block: eventRisk.block,
    };
  }

  private getPolymarketGroupKey(market: Market): string {
    const raw = String(market.condition_id || market.event_id || '').trim();
    return raw ? raw : String(market.token_id || '').trim();
  }

  private getPolymarketThemeBucket(market: Market): string {
    const category = String(market.market_category || '').trim().toLowerCase();
    const source = (String(market.market_slug || '') + ' ' + String(market.question || '') + ' ' + category).toLowerCase();
    if (/\bbitcoin\b|\bbtc\b/.test(source)) return 'crypto-btc';
    if (/\bethereum\b|\beth\b/.test(source)) return 'crypto-eth';
    if (/\bsolana\b|\bsol\b/.test(source)) return 'crypto-sol';
    if (/counter-?strike|\bcs2\b|esports/.test(source)) return 'esports-cs2';
    if (/nba|basketball/.test(source)) return 'sports-nba';
    if (/election|president|trump|biden|democrat|republican/.test(source)) return 'politics-us';
    if (/cpi|inflation|payroll|gdp|fed|rates|treasury/.test(source)) return 'macro-us';
    if (category) return 'cat:' + category.replace(/\s+/g, '-');
    return '';
  }
  private getPolymarketGroupBudgetAdjustment(market: Market): { remainingBudget: number; utilization: number; sizeFactor: number; retreatBps: number; reason: string } {
    if (this.config.mmVenue !== 'polymarket') {
      return { remainingBudget: Number.POSITIVE_INFINITY, utilization: 0, sizeFactor: 1, retreatBps: 0, reason: '' };
    }
    const cfg = this.getPolymarketExecutionSafetyConfig();
    const groupKey = this.getPolymarketGroupKey(market);
    if (!groupKey) {
      return { remainingBudget: Number.POSITIVE_INFINITY, utilization: 0, sizeFactor: 1, retreatBps: 0, reason: '' };
    }
    const maxBudget = Math.max(1, this.getEffectiveMaxPosition() * Math.max(0.25, Number(cfg.groupMaxExposureFactor || 1.4)));
    let groupValue = 0;
    for (const [tokenId, position] of this.positions.entries()) {
      const mapped = this.marketByToken.get(tokenId);
      if (!mapped || this.getPolymarketGroupKey(mapped) !== groupKey) continue;
      groupValue += Math.max(0, Number(position.total_value || position.value || 0));
    }
    const remainingBudget = Math.max(0, maxBudget - groupValue);
    const utilization = this.clamp(groupValue / maxBudget, 0, 4);
    const softStart = this.clamp(Number(cfg.groupSoftExposureStart || 0.7), 0.1, 0.99);
    const ratio = utilization <= softStart ? 0 : this.clamp((utilization - softStart) / Math.max(0.01, 1 - softStart), 0, 1);
    const sizeMin = this.clamp(Number(cfg.groupSizeFactorMin || 0.55), 0.1, 1);
    const sizeFactor = 1 - (1 - sizeMin) * ratio;
    const retreatBps = Math.max(0, Number(cfg.groupRetreatMaxBps || 0)) * ratio;
    return {
      remainingBudget,
      utilization,
      sizeFactor,
      retreatBps,
      reason: '事件组利用率 ' + (utilization * 100).toFixed(0) + '%',
    };
  }

  private getPolymarketThemeBudgetAdjustment(market: Market): { bucket: string; remainingBudget: number; utilization: number; sizeFactor: number; retreatBps: number; reason: string } {
    if (this.config.mmVenue !== 'polymarket') {
      return { bucket: '', remainingBudget: Number.POSITIVE_INFINITY, utilization: 0, sizeFactor: 1, retreatBps: 0, reason: '' };
    }
    const cfg = this.getPolymarketExecutionSafetyConfig();
    const bucket = this.getPolymarketThemeBucket(market);
    if (!bucket) {
      return { bucket: '', remainingBudget: Number.POSITIVE_INFINITY, utilization: 0, sizeFactor: 1, retreatBps: 0, reason: '' };
    }
    const maxBudget = Math.max(1, this.getEffectiveMaxPosition() * Math.max(0.5, Number(cfg.themeMaxExposureFactor || 2.2)));
    let themeValue = 0;
    for (const [tokenId, position] of this.positions.entries()) {
      const mapped = this.marketByToken.get(tokenId);
      if (!mapped || this.getPolymarketThemeBucket(mapped) !== bucket) continue;
      themeValue += Math.max(0, Number(position.total_value || position.value || 0));
    }
    const remainingBudget = Math.max(0, maxBudget - themeValue);
    const utilization = this.clamp(themeValue / maxBudget, 0, 4);
    const softStart = this.clamp(Number(cfg.themeSoftExposureStart || 0.65), 0.1, 0.99);
    const ratio = utilization <= softStart ? 0 : this.clamp((utilization - softStart) / Math.max(0.01, 1 - softStart), 0, 1);
    const sizeMin = this.clamp(Number(cfg.themeSizeFactorMin || 0.5), 0.1, 1);
    const sizeFactor = 1 - (1 - sizeMin) * ratio;
    const retreatBps = Math.max(0, Number(cfg.themeRetreatMaxBps || 0)) * ratio;
    return {
      bucket,
      remainingBudget,
      utilization,
      sizeFactor,
      retreatBps,
      reason: '主题利用率 ' + (utilization * 100).toFixed(0) + '% (' + bucket + ')',
    };
  }

  private setPolymarketExecutionState(
    tokenId: string,
    nextState: 'OBSERVE' | 'PROBE' | 'EARN' | 'DEFEND' | 'EXIT' | 'COOLDOWN',
    reason: string
  ): { state: 'OBSERVE' | 'PROBE' | 'EARN' | 'DEFEND' | 'EXIT' | 'COOLDOWN'; reason: string; since: number; updatedAt: number } {
    const now = Date.now();
    const existing = this.polymarketExecutionState.get(tokenId);
    if (existing && existing.state === nextState && existing.reason === reason) {
      existing.updatedAt = now;
      return existing;
    }
    const next = { state: nextState, reason, since: existing?.state === nextState ? existing.since : now, updatedAt: now };
    this.polymarketExecutionState.set(tokenId, next);
    if (!existing || existing.state !== nextState || existing.reason !== reason) {
      this.recordMmEvent('POLYMARKET_STATE', `${nextState}: ${reason}`, tokenId);
    }
    return next;
  }

  private getPolymarketExecutionState(
    market: Market,
    orderbook: Orderbook
  ): { state: 'OBSERVE' | 'PROBE' | 'EARN' | 'DEFEND' | 'EXIT' | 'COOLDOWN'; reason: string; retreatBps: number; sizeFactor: number; block: boolean } {
    if (this.config.mmVenue !== 'polymarket') {
      return { state: 'EARN', reason: '', retreatBps: 0, sizeFactor: 1, block: false };
    }
    const tokenId = market.token_id;
    if (this.isPaused(tokenId)) {
      const reason = this.pauseReasons.get(tokenId)?.reason || '冷却中';
      this.setPolymarketExecutionState(tokenId, 'COOLDOWN', reason);
      return { state: 'COOLDOWN', reason, retreatBps: 0, sizeFactor: 0, block: true };
    }
    const eventRisk = this.getPolymarketEventRiskAdjustment(market);
    if (eventRisk.block || market.polymarket_accepting_orders === false || market.polymarket_enable_order_book === false) {
      const reason =
        eventRisk.reason ||
        (market.polymarket_accepting_orders === false ? '市场当前不接受下单' : 'orderbook 未启用');
      this.setPolymarketExecutionState(tokenId, 'EXIT', reason);
      return { state: 'EXIT', reason, retreatBps: Math.max(0, eventRisk.retreatBps), sizeFactor: 0, block: true };
    }

    const cfg = this.getPolymarketExecutionSafetyConfig();
    const reward = this.getPolymarketRewardRule(market);
    const queueTarget = this.getPolymarketQueueTargetAdjustment(market, orderbook);
    const lifecycle = this.getPolymarketLifecycleSnapshot(tokenId);
    const placedEvents = lifecycle.placed + lifecycle.canceled + lifecycle.filled;
    const effectiveNetEfficiency = Number(market.polymarket_reward_effective_net_efficiency || 0);
    const recentPenalty = Number(market.polymarket_recent_risk_penalty || 0);
    const patternPenalty = Number(market.polymarket_pattern_memory_penalty || 0);
    const hourPenalty = Math.max(
      Number(market.polymarket_hour_risk_penalty || 0),
      Number(market.polymarket_market_hour_risk_penalty || 0)
    );
    const totalRiskPenalty = recentPenalty + patternPenalty + hourPenalty + Number(market.polymarket_event_risk_penalty || 0);
    const minNetEfficiency = Math.max(1e-6, Number(cfg.rewardMinNetEfficiency || 0.0008));
    const stateProbeSizeFactor = this.clamp(Number(cfg.stateProbeSizeFactor || 0.55), 0.1, 1);
    const stateObserveSizeFactor = this.clamp(Number(cfg.stateObserveSizeFactor || 0.3), 0.1, 1);
    const stateDefendSizeFactor = this.clamp(Number(cfg.stateDefendSizeFactor || 0.5), 0.1, 1);

    if (!reward.enabled || effectiveNetEfficiency <= minNetEfficiency * 0.5) {
      const reason = !reward.enabled ? '当前无有效流动性激励' : `有效净奖励偏弱 ${(effectiveNetEfficiency * 100).toFixed(2)}%/日`;
      this.setPolymarketExecutionState(tokenId, 'OBSERVE', reason);
      return {
        state: 'OBSERVE',
        reason,
        retreatBps: Number(cfg.stateObserveRetreatBps || 0),
        sizeFactor: stateObserveSizeFactor,
        block: false,
      };
    }
    if (totalRiskPenalty >= Math.max(4, Number(cfg.rewardTargetPenaltyMax || 6)) || lifecycle.cancelRate >= 0.92) {
      const reason =
        totalRiskPenalty >= Math.max(4, Number(cfg.rewardTargetPenaltyMax || 6))
          ? `综合风险偏高 ${totalRiskPenalty.toFixed(1)}`
          : `撤单率偏高 ${(lifecycle.cancelRate * 100).toFixed(0)}%`;
      this.setPolymarketExecutionState(tokenId, 'DEFEND', reason);
      return {
        state: 'DEFEND',
        reason,
        retreatBps: Number(cfg.stateDefendRetreatBps || 0) + queueTarget.retreatBps,
        sizeFactor: Math.min(stateDefendSizeFactor, queueTarget.sizeFactor),
        block: false,
      };
    }
    if (placedEvents < Math.max(3, Number(cfg.minAttempts || 6) / 2) || queueTarget.targetFactor < 0.6) {
      const reason =
        placedEvents < Math.max(3, Number(cfg.minAttempts || 6) / 2)
          ? `试探阶段，样本不足 ${placedEvents}`
          : queueTarget.reason || '排队位置偏离目标';
      this.setPolymarketExecutionState(tokenId, 'PROBE', reason);
      return {
        state: 'PROBE',
        reason,
        retreatBps: Number(cfg.stateProbeRetreatBps || 0) + queueTarget.retreatBps,
        sizeFactor: Math.min(stateProbeSizeFactor, queueTarget.sizeFactor),
        block: false,
      };
    }
    const reason = queueTarget.reason || '奖励质量稳定';
    this.setPolymarketExecutionState(tokenId, 'EARN', reason);
    return {
      state: 'EARN',
      reason,
      retreatBps: queueTarget.retreatBps,
      sizeFactor: queueTarget.sizeFactor,
      block: false,
    };
  }

  private getPolymarketPatternMemoryAdjustment(market: Market): { retreatBps: number; sizeFactor: number; reason: string } {
    if (this.config.mmVenue !== 'polymarket') {
      return { retreatBps: 0, sizeFactor: 1, reason: '' };
    }
    const penalty = Number(market.polymarket_pattern_memory_penalty || 0);
    if (!(penalty > 0)) {
      return { retreatBps: 0, sizeFactor: 1, reason: '' };
    }
    const cfg = this.getPolymarketExecutionSafetyConfig();
    const maxPenalty = Math.max(1, Number(cfg.patternMemoryMaxPenalty || 8));
    const dominance = this.clamp(Number(market.polymarket_pattern_memory_dominance || 0.5), 0, 1);
    const decayFactor = this.clamp(Number(market.polymarket_pattern_memory_decay_factor || 1), 0.15, 1);
    const nearTouchMix = this.clamp(Number(market.polymarket_pattern_memory_near_touch || 0), 0, 1);
    const refreshMix = this.clamp(Number(market.polymarket_pattern_memory_refresh || 0), 0, 1);
    const vwapMix = this.clamp(Number(market.polymarket_pattern_memory_vwap || 0), 0, 1);
    const aggressiveMix = this.clamp(Number(market.polymarket_pattern_memory_aggressive || 0), 0, 1);
    const unsafeMix = this.clamp(Number(market.polymarket_pattern_memory_unsafe || 0), 0, 1);
    const learnedRetreat = this.clamp(Number(market.polymarket_pattern_memory_learned_retreat || 0), 0, 1);
    const learnedSize = this.clamp(Number(market.polymarket_pattern_memory_learned_size || 0), 0, 1);
    const learnedRetreatNearTouch = this.clamp(
      Number(market.polymarket_pattern_memory_learned_retreat_near_touch || 0),
      0,
      1
    );
    const learnedRetreatRefresh = this.clamp(
      Number(market.polymarket_pattern_memory_learned_retreat_refresh || 0),
      0,
      1
    );
    const learnedRetreatVwap = this.clamp(Number(market.polymarket_pattern_memory_learned_retreat_vwap || 0), 0, 1);
    const learnedRetreatAggressive = this.clamp(
      Number(market.polymarket_pattern_memory_learned_retreat_aggressive || 0),
      0,
      1
    );
    const learnedRetreatUnsafe = this.clamp(
      Number(market.polymarket_pattern_memory_learned_retreat_unsafe || 0),
      0,
      1
    );
    const learnedSizeNearTouch = this.clamp(Number(market.polymarket_pattern_memory_learned_size_near_touch || 0), 0, 1);
    const learnedSizeRefresh = this.clamp(Number(market.polymarket_pattern_memory_learned_size_refresh || 0), 0, 1);
    const learnedSizeVwap = this.clamp(Number(market.polymarket_pattern_memory_learned_size_vwap || 0), 0, 1);
    const learnedSizeAggressive = this.clamp(
      Number(market.polymarket_pattern_memory_learned_size_aggressive || 0),
      0,
      1
    );
    const learnedSizeUnsafe = this.clamp(Number(market.polymarket_pattern_memory_learned_size_unsafe || 0), 0, 1);
    const scaled = this.clamp((penalty / maxPenalty) * (0.65 + 0.35 * dominance) * decayFactor, 0, 1);
    const learnedReasonBoostCap = 0.75;
    const retreatNearTouchBoost = 1 + learnedRetreatNearTouch * learnedReasonBoostCap;
    const retreatRefreshBoost = 1 + learnedRetreatRefresh * learnedReasonBoostCap * 0.55;
    const retreatVwapBoost = 1 + learnedRetreatVwap * learnedReasonBoostCap * 0.8;
    const retreatAggressiveBoost = 1 + learnedRetreatAggressive * learnedReasonBoostCap;
    const retreatUnsafeBoost = 1 + learnedRetreatUnsafe * learnedReasonBoostCap;
    const sizeNearTouchBoost = 1 + learnedSizeNearTouch * learnedReasonBoostCap * 0.5;
    const sizeRefreshBoost = 1 + learnedSizeRefresh * learnedReasonBoostCap * 0.4;
    const sizeVwapBoost = 1 + learnedSizeVwap * learnedReasonBoostCap * 0.85;
    const sizeAggressiveBoost = 1 + learnedSizeAggressive * learnedReasonBoostCap;
    const sizeUnsafeBoost = 1 + learnedSizeUnsafe * learnedReasonBoostCap;
    const retreatWeight = this.clamp(
      0.15 +
        nearTouchMix * 1.05 * retreatNearTouchBoost +
        aggressiveMix * 0.95 * retreatAggressiveBoost +
        unsafeMix * 0.9 * retreatUnsafeBoost +
        vwapMix * 0.45 * retreatVwapBoost +
        refreshMix * 0.25 * retreatRefreshBoost,
      0.2,
      1.6
    ) * (1 + learnedRetreat * 0.35);
    const sizeWeight = this.clamp(
      0.2 +
        aggressiveMix * 1.1 * sizeAggressiveBoost +
        unsafeMix * 1.05 * sizeUnsafeBoost +
        vwapMix * 0.65 * sizeVwapBoost +
        nearTouchMix * 0.35 * sizeNearTouchBoost +
        refreshMix * 0.2 * sizeRefreshBoost,
      0.25,
      1.7
    ) * (1 + learnedSize * 0.45);
    const retreatBps = Number(cfg.patternMemoryRetreatMaxBps || 0) * this.clamp(scaled * retreatWeight, 0, 1);
    const sizeMin = this.clamp(Number(cfg.patternMemorySizeFactorMin || 0.7), 0.1, 1);
    const sizeFactor = 1 - (1 - sizeMin) * this.clamp(scaled * sizeWeight, 0, 1);
    const dominantReason = String(
      market.polymarket_pattern_memory_dominant_reason || market.polymarket_pattern_memory_reason || '长期撤单模式'
    );
    const ttlRemainingHours = market.polymarket_pattern_memory_ttl_remaining_ms
      ? Math.max(1, Math.ceil(Number(market.polymarket_pattern_memory_ttl_remaining_ms) / 3600000))
      : null;
    return {
      retreatBps,
      sizeFactor: this.clamp(sizeFactor, sizeMin, 1),
      reason: `${dominantReason}${ttlRemainingHours ? ` 剩余约${ttlRemainingHours}h` : ''}`,
    };
  }

  private getPolymarketPostOnlyHitRate(tokenId: string): number | null {
    const stats = this.polymarketPostOnlyStats.get(tokenId);
    if (!stats || stats.attempts <= 0) {
      return null;
    }
    return stats.accepted / Math.max(1, stats.attempts);
  }

  private async recordPolymarketAdverseFill(
    tokenId: string,
    market: Market | undefined,
    filledShares: number,
    position: Position | undefined
  ): Promise<void> {
    if (this.config.mmVenue !== 'polymarket' || !market || !Number.isFinite(filledShares) || filledShares <= 0) {
      return;
    }
    const cfg = this.getPolymarketExecutionSafetyConfig();
    const now = Date.now();
    const existing = this.polymarketAdverseFillState.get(tokenId);
    const shouldReset = !existing || now - existing.windowStart > cfg.adverseFillWindowMs;
    const state = shouldReset
      ? { score: 0, count: 0, windowStart: now, lastAt: now }
      : existing;

    const reward = this.getPolymarketRewardRule(market);
    const sizeRef = reward.enabled ? reward.minShares : Math.max(1, this.getEffectiveOrderSize());
    let increment = this.clamp(filledShares / Math.max(1, sizeRef), 0.5, 2.5);
    const pnl = Number(position?.pnl || position?.value || 0);
    if (Number.isFinite(pnl) && pnl < 0) {
      increment += Math.max(0, cfg.adverseFillPnlPenalty);
    }
    const postOnlyHitRate = this.getPolymarketPostOnlyHitRate(tokenId);
    if (postOnlyHitRate !== null && postOnlyHitRate < cfg.minHitRate + 0.1) {
      increment += 0.5;
    }

    state.score += increment;
    state.count += 1;
    state.lastAt = now;
    this.polymarketAdverseFillState.set(tokenId, state);

    this.recordMmEvent(
      'POLYMARKET_ADVERSE_FILL',
      `score=${state.score.toFixed(2)} count=${state.count} fill=${filledShares.toFixed(2)} pnl=${pnl.toFixed(2)}`,
      tokenId
    );

    if (state.score < cfg.adverseFillScoreThreshold) {
      return;
    }

    const reason = `连续不利成交 score=${state.score.toFixed(2)} count=${state.count}`;
    await this.enforceMarketPause(tokenId, cfg.adverseFillPauseMs, reason, 'polymarket-adverse-fill', true);
    console.warn(`🛑 [PolymarketSafety] ${reason}，已撤单并暂停 ${Math.round(cfg.adverseFillPauseMs / 60000)} 分钟`);
    state.score = 0;
    state.count = 0;
    state.windowStart = now;
    state.lastAt = now;
    this.polymarketAdverseFillState.set(tokenId, state);
  }

  private getPolymarketAdverseSuppression(
    market: Market,
    orderbook: Orderbook,
    prices: QuotePrices,
    metrics: { depthSpeedBps?: number }
  ): { suppressBuy: boolean; suppressSell: boolean; reason?: string } {
    if (this.config.mmVenue !== 'polymarket') {
      return { suppressBuy: false, suppressSell: false };
    }

    const cfg = this.getPolymarketExecutionSafetyConfig();
    const pressure = Number(prices.pressure || 0);
    const imbalance = Number((prices.imbalance ?? this.calculateOrderbookImbalance(orderbook)) || 0);
    const depthSpeedBps = Number(metrics.depthSpeedBps || 0);
    const reward = this.getPolymarketRewardRule(market);
    const topGapTight = reward.enabled && reward.maxSpread > 0 && Number(orderbook.spread || 0) <= reward.maxSpread * 0.8;

    if (
      pressure >= cfg.adversePressureThreshold &&
      imbalance >= cfg.adverseImbalanceThreshold &&
      depthSpeedBps >= cfg.adverseDepthSpeedBps
    ) {
      return {
        suppressBuy: false,
        suppressSell: true,
        reason: `上冲风险过高 pressure=${pressure.toFixed(2)} imbalance=${imbalance.toFixed(2)}${topGapTight ? ' reward-tight' : ''}`,
      };
    }

    if (
      pressure <= -cfg.adversePressureThreshold &&
      imbalance <= -cfg.adverseImbalanceThreshold &&
      depthSpeedBps >= cfg.adverseDepthSpeedBps
    ) {
      return {
        suppressBuy: true,
        suppressSell: false,
        reason: `下杀风险过高 pressure=${pressure.toFixed(2)} imbalance=${imbalance.toFixed(2)}${topGapTight ? ' reward-tight' : ''}`,
      };
    }

    return { suppressBuy: false, suppressSell: false };
  }

  async initialize(): Promise<void> {
    if (!this.config.enableTrading) {
      return;
    }

    if (this.config.mmRequireJwt !== false && !this.config.jwtToken) {
      throw new Error('ENABLE_TRADING=true requires JWT_TOKEN in .env (or set MM_REQUIRE_JWT=false)');
    }

    if (!this.orderManager) {
      if (this.orderManagerFactory) {
        this.orderManager = await this.orderManagerFactory();
      } else {
        this.orderManager = await OrderManager.create(this.config);
      }
      console.log(`✅ OrderManager initialized (maker: ${this.orderManager.getMakerAddress()})`);
    }

    if (
      this.config.mmVenue === 'predict' &&
      this.config.predictAutoSetApprovals !== false &&
      typeof (this.orderManager as any)?.ensureTradingReady === 'function'
    ) {
      console.log('🔧 Checking Predict approvals...');
      await (this.orderManager as any).ensureTradingReady();
      console.log('✅ Predict approvals ready');
    }

    if (this.config.hedgeMode === 'CROSS' && this.crossAggregator) {
      this.crossExecutionRouter = new CrossPlatformExecutionRouter(this.config, this.api as any, this.orderManager);
    }
  }

  async updateState(makerAddress: string): Promise<void> {
    try {
      if (this.api.getOrders) {
        const orders = await this.api.getOrders(makerAddress);
        // H6 FIX: 先构建新Map，成功后再赋值，避免中途异常导致openOrders被清空
        const newOpenOrders = new Map<string, Order>();
        for (const order of orders) {
          if (order.status === 'OPEN') {
            newOpenOrders.set(order.order_hash, order);
          }
        }
        this.openOrders = newOpenOrders;
      } else if (!this.warnedNoOrderSync) {
        console.log('⚠️  当前交易所不支持获取 Open Orders，改为本地订单追踪');
        this.warnedNoOrderSync = true;
      }

      if (this.api.getPositions) {
        const positionsData = await this.api.getPositions(makerAddress);
        this.positions.clear();

        for (const pos of positionsData) {
          const tokenId = String(pos.token_id ?? pos.tokenId ?? pos.market?.tokenId ?? '');
          if (!tokenId) {
            continue;
          }

          const current = this.positions.get(tokenId) || {
            token_id: tokenId,
            question: pos.question || pos.market?.question || 'Unknown',
            yes_amount: 0,
            no_amount: 0,
            total_value: 0,
            avg_entry_price: 0,
            current_price: 0,
            pnl: 0,
          };

          const outcome = String(pos.outcome ?? pos.side ?? '').toUpperCase();
          const size = Number(pos.amount ?? pos.shares ?? pos.size ?? 0);

          if (outcome === 'YES' || outcome === 'BUY_YES') {
            current.yes_amount += size;
          } else if (outcome === 'NO' || outcome === 'BUY_NO') {
            current.no_amount += size;
          } else {
            current.yes_amount += Number(pos.yes_amount ?? 0);
            current.no_amount += Number(pos.no_amount ?? 0);
          }

          current.total_value += Number(pos.total_value ?? pos.value ?? 0);
          current.avg_entry_price = Number(pos.avg_price ?? pos.avgEntryPrice ?? current.avg_entry_price);
          current.current_price = Number(pos.current_price ?? pos.currentPrice ?? current.current_price);
          current.pnl += Number(pos.pnl ?? 0);

          this.positions.set(tokenId, current);
        }
      } else if (!this.warnedNoPositionSync) {
        console.log('⚠️  当前交易所不支持获取仓位，库存模型将以 0 作为基线');
        this.warnedNoPositionSync = true;
      }

      this.sessionPnL = Array.from(this.positions.values()).reduce((sum, p) => sum + p.pnl, 0);

      // ===== Phase 1: 更新库存预测器 =====
      for (const [tokenId, position] of this.positions) {
        const netShares = position.yes_amount - position.no_amount;
        const maxPosition = this.getEffectiveMaxPosition();
        const predictor = this.getOrCreateReversionPredictor(tokenId);
        predictor.recordInventory(tokenId, netShares, maxPosition);

        // 更新库存状态分类
        const inventoryState = this.inventoryClassifier.classify(tokenId, netShares, maxPosition);
        this.perMarketInventoryState.set(tokenId, inventoryState);
      }

      // 日损失自动恢复机制（默认24小时自动恢复）
      const autoResetMs = 24 * 60 * 60 * 1000; // 24小时
      if (this.tradingHalted && this.tradingHaltAt > 0) {
        const elapsed = Date.now() - this.tradingHaltAt;
        if (elapsed > autoResetMs) {
          console.log(`♻️  Auto-resuming trading after ${(elapsed / 1000 / 60).toFixed(0)} minutes`);
          this.tradingHalted = false;
          this.tradingHaltAt = 0;
          this.sessionPnL = 0;
          this.recordMmEvent('TRADING_RESUMED', `Auto-reset after ${(elapsed / 1000 / 60).toFixed(0)} min`);
        }
      }

      const maxDailyLoss = this.getEffectiveMaxDailyLoss();
      if (this.sessionPnL <= -Math.abs(maxDailyLoss)) {
        if (!this.tradingHalted) {
          console.log(`🛑 Trading halted: session PnL ${this.sessionPnL.toFixed(2)} <= -${Math.abs(maxDailyLoss)}`);
          this.tradingHaltAt = Date.now(); // 记录暂停时间
        }
        this.tradingHalted = true;
      }

      console.log(
        `📈 State updated: ${this.openOrders.size} open orders, ${this.positions.size} positions, session PnL ${this.sessionPnL.toFixed(2)}`
      );

      if (this.config.hedgeOnFill && this.orderManager) {
        await this.detectAndHedgeFills();
      }
    } catch (error) {
      console.error('Error updating state:', error);
    }
  }

  /**
   * Get current open order count (for external status queries)
   */
  getOpenOrdersCount(): number {
    return this.openOrders.size;
  }

  /**
   * Get current position count (for external status queries)
   */
  getPositionCount(): number {
    return this.positions.size;
  }

  /**
   * Get session PnL (for external status queries)
   */
  getSessionPnL(): number {
    return this.sessionPnL;
  }

  setWsHealthScore(score: number): void {
    if (!Number.isFinite(score)) {
      return;
    }
    this.wsHealthScore = this.clamp(score, 0, 100);
    this.wsHealthUpdatedAt = Date.now();
  }

  /**
   * WebSocket 健康自动恢复
   * 在长时间没有更新后，逐渐恢复健康分数
   */
  private autoRecoverWsHealth(): void {
    const now = Date.now();
    const elapsed = now - this.wsHealthUpdatedAt;
    const recoverMs = 30000; // 默认30秒

    // 如果超过恢复时间且健康分数低于100，逐渐恢复
    if (elapsed > recoverMs && this.wsHealthScore < 100) {
      const recoveryRate = 1; // 每次恢复1分
      const oldScore = this.wsHealthScore;
      this.wsHealthScore = Math.min(100, this.wsHealthScore + recoveryRate);
      this.wsHealthUpdatedAt = now;

      if (this.wsHealthScore > oldScore) {
        this.recordMmEvent('WS_HEALTH_RECOVERING',
          `score=${this.wsHealthScore} old=${oldScore}`,
          'global');
      }
    }
  }

  /**
   * 公共方法：在每个循环中调用，维护 WebSocket 健康状态
   */
  maintainWsHealth(): void {
    this.autoRecoverWsHealth();
  }

  private getWsHealthSnapshot(): {
    score: number;
    spreadMult: number;
    sizeMult: number;
    layerMult: number;
    intervalMult: number;
    onlyFar: boolean;
    sizeScale: number;
    singleSide: 'BUY' | 'SELL' | 'NONE';
    singleMode: 'NORMAL' | 'REMOTE';
    touchBufferAddBps: number;
    sparseOdd: boolean;
    wsLayerCap: number;
    wsMaxOrdersMult: number;
    wsSoftCancelMult: number;
    wsHardCancelMult: number;
    wsCancelBufferAddBps: number;
    wsRepriceBufferAddBps: number;
    wsCancelConfirmMult: number;
    wsRepriceConfirmMult: number;
    wsForceSafe: boolean;
    wsDisableHedge: boolean;
    wsReadOnly: boolean;
    wsUltraSafe: boolean;
    wsEmergencyCancel: boolean;
    wsEmergencyActive: boolean;
    wsEmergencyRecovery: boolean;
    wsEmergencyRecoveryStage: number;
    wsEmergencyRecoverySteps: number;
    wsEmergencyRecoveryRatio: number;
    wsEmergencyRecoveryIntervalMult: number;
    wsEmergencyRecoveryProgress: number;
    wsEmergencyRecoverySingleActive: boolean;
    wsEmergencyRecoveryDepthMult: number;
    wsEmergencyRecoveryVolatilityMult: number;
      wsEmergencyRecoverySpreadAdd: number;
      wsEmergencyRecoveryIcebergRatio: number;
      wsEmergencyRecoveryCancelConfirmMult: number;
      wsEmergencyRecoveryMaxOrdersMult: number;
    wsEmergencyRecoveryRepriceConfirmMult: number;
    wsEmergencyRecoveryMaxNotionalMult: number;
    wsEmergencyRecoveryFarLayersMin: number;
    wsEmergencyRecoveryFarLayersMax: number;
    wsEmergencyRecoveryFarLayerStep: number;
    wsEmergencyRecoveryCancelIntervalMult: number;
    wsEmergencyRecoverySingleOffsetBps: number;
    wsEmergencyRecoveryTemplate: boolean;
    wsEmergencyRecoveryAuto: boolean;
    wsEmergencyRecoveryImbalanceThreshold: number;
    wsEmergencyRecoveryMinIntervalMs: number;
    wsEmergencyRecoveryOffsetVolWeight: number;
    wsEmergencyRecoveryTemplateReset: boolean;
    wsEmergencyRecoverySingleSideLossWeight: number;
    riskThrottleFactor: number;
    riskThrottleScore: number;
    riskThrottleCoolOffMs: number;
    updatedAt: number;
  } {
    const wsSingle = this.getWsHealthSingleSide();
    const recoveryInfo = this.getWsEmergencyRecoveryInfo();
    const recoveryIntervalMult = this.getWsEmergencyRecoveryIntervalMult();
    const recoveryDepthMult = this.getWsEmergencyRecoveryDepthMult();
    const recoveryVolMult = this.getWsEmergencyRecoveryVolatilityMult();
    return {
      score: this.wsHealthScore,
      spreadMult: this.getWsHealthSpreadMult(),
      sizeMult: this.getWsHealthSizeMult(),
      layerMult: this.getWsHealthLayerMult(),
      intervalMult: this.getWsHealthIntervalMult(),
      onlyFar: this.shouldForceOnlyFarWs(),
      sizeScale: this.getWsHealthSizeScale(),
      singleSide: wsSingle.side,
      singleMode: wsSingle.mode,
      touchBufferAddBps: this.getWsHealthTouchBufferAddBps(),
      sparseOdd: this.shouldSparseWs(),
      wsLayerCap: this.getWsHealthLayerCap(),
      wsMaxOrdersMult: this.getWsHealthMaxOrdersMult(),
      wsSoftCancelMult: this.getWsHealthSoftCancelMult(),
      wsHardCancelMult: this.getWsHealthHardCancelMult(),
      wsCancelBufferAddBps: this.getWsHealthCancelBufferAddBps(),
      wsRepriceBufferAddBps: this.getWsHealthRepriceBufferAddBps(),
      wsCancelConfirmMult: this.getWsHealthCancelConfirmMult(),
      wsRepriceConfirmMult: this.getWsHealthRepriceConfirmMult(),
      wsForceSafe: this.config.mmWsHealthForceSafeMode === true,
      wsDisableHedge: this.config.mmWsHealthDisableHedge === true,
      wsReadOnly: this.config.mmWsHealthReadOnly === true,
      wsUltraSafe: this.isWsUltraSafeActive(),
      wsEmergencyCancel: this.config.mmWsHealthEmergencyCancelAll === true,
      wsEmergencyActive: this.wsEmergencyGlobalUntil > Date.now(),
      wsEmergencyRecovery: this.isWsEmergencyRecoveryActive(),
      wsEmergencyRecoveryStage: recoveryInfo.stage,
      wsEmergencyRecoverySteps: recoveryInfo.steps,
      wsEmergencyRecoveryRatio: recoveryInfo.ratio,
      wsEmergencyRecoveryIntervalMult: recoveryIntervalMult,
      wsEmergencyRecoveryProgress: recoveryInfo.progress,
      wsEmergencyRecoverySingleActive: recoveryInfo.singleActive,
      wsEmergencyRecoveryDepthMult: recoveryDepthMult,
      wsEmergencyRecoveryVolatilityMult: recoveryVolMult,
      wsEmergencyRecoverySpreadAdd: Math.max(0, this.config.mmWsHealthEmergencyRecoverySpreadAdd ?? 0),
      wsEmergencyRecoveryIcebergRatio: Math.max(0, this.config.mmWsHealthEmergencyRecoveryIcebergRatio ?? 0),
      wsEmergencyRecoveryCancelConfirmMult: this.getWsHealthCancelConfirmMult(),
      wsEmergencyRecoveryMaxOrdersMult: this.getWsHealthMaxOrdersMult(),
      wsEmergencyRecoveryRepriceConfirmMult: this.getWsHealthRepriceConfirmMult(),
      wsEmergencyRecoveryMaxNotionalMult: this.config.mmWsHealthEmergencyRecoveryMaxNotionalMultMin ?? 1,
      wsEmergencyRecoveryFarLayersMin: this.getWsEmergencyRecoveryInfo().farLayers,
      wsEmergencyRecoveryFarLayersMax: this.config.mmWsHealthEmergencyRecoveryFarLayersMax ?? 0,
      wsEmergencyRecoveryFarLayerStep: this.config.mmWsHealthEmergencyRecoveryFarLayerStep ?? 1,
      wsEmergencyRecoveryCancelIntervalMult: this.getWsEmergencyRecoveryCancelIntervalMult(),
      wsEmergencyRecoverySingleOffsetBps: this.getWsHealthSingleSide().offsetBps,
      wsEmergencyRecoveryTemplate: this.config.mmWsHealthEmergencyRecoveryTemplateEnabled === true,
      wsEmergencyRecoveryAuto: this.config.mmWsHealthEmergencyRecoverySingleSideAuto === true,
      wsEmergencyRecoveryImbalanceThreshold:
        this.config.mmWsHealthEmergencyRecoverySingleSideImbalanceThreshold ?? 0,
      wsEmergencyRecoveryMinIntervalMs: this.config.mmWsHealthEmergencyRecoveryMinIntervalMs ?? 0,
      wsEmergencyRecoveryOffsetVolWeight: this.config.mmWsHealthEmergencyRecoveryOffsetVolWeight ?? 0,
      wsEmergencyRecoveryTemplateReset: this.config.mmWsHealthEmergencyRecoveryTemplateResetEnabled === true,
      wsEmergencyRecoverySingleSideLossWeight: this.config.mmWsHealthEmergencyRecoverySingleSideLossWeight ?? 0,
      riskThrottleFactor: this.getRiskThrottleFactor('__global__'),
      riskThrottleScore: this.getRiskThrottleState('__global__').score,
      riskThrottleCoolOffMs: Math.max(0, this.config.mmRiskThrottleCoolOffMs ?? 0),
      updatedAt: this.wsHealthUpdatedAt,
    };
  }

  shouldCancelOrders(tokenId: string, orderbook: Orderbook): boolean {
    const lastPrice = this.lastPrices.get(tokenId);
    if (!lastPrice || !orderbook.mid_price || lastPrice <= 0) {
      return false;
    }

    const priceChange = Math.abs(orderbook.mid_price - lastPrice) / lastPrice;
    const base = this.config.cancelThreshold;
    const mult = this.getVolatilityMultiplier(tokenId, this.config.mmCancelVolMultiplier ?? 2);
    const boost = this.getCancelBoost(tokenId);
    const noFill = this.getNoFillPenalty(tokenId);
    let threshold = (base + (noFill.cancelBps || 0) / 10000) / mult / boost;
    if (this.config.mmAutoTuneEnabled) {
      const autoWeight = Math.max(0, this.config.mmAutoTuneCancelWeight ?? 0);
      if (autoWeight > 0) {
        const autoMult = this.getAutoTuneMultiplier(tokenId);
        if (autoMult !== 1) {
          const factor = 1 + (autoMult - 1) * autoWeight;
          threshold = threshold / Math.max(0.2, factor);
        }
      }
    }
    const wsCancelMult = this.getWsHealthCancelMult();
    if (wsCancelMult > 0 && wsCancelMult !== 1) {
      threshold = threshold / wsCancelMult;
    }
    let buffer = Math.max(0, this.config.mmCancelBufferBps ?? 0);
    const wsCancelAdd = this.getWsHealthCancelBufferAddBps();
    if (wsCancelAdd > 0) {
      buffer += wsCancelAdd / 10000;
    }
    if (
      this.isSafeModeActive(tokenId, {
        volEma: this.volatilityEma.get(tokenId) ?? 0,
        depthTrend: this.depthTrend.get(tokenId) ?? 0,
        depthSpeedBps: this.lastDepthSpeedBps.get(tokenId) ?? 0,
      })
    ) {
      const mult = Math.max(1, this.config.mmSafeModeCancelThresholdMult ?? 1);
      threshold = threshold / mult;
      const add = Math.max(0, this.config.mmSafeModeCancelBufferAddBps ?? 0);
      if (add > 0) {
        buffer += add / 10000;
      }
    }
    const hard = threshold * (1 + buffer);
    if (priceChange > hard) {
      this.cancelHoldUntil.delete(tokenId);
      return true;
    }
    if (priceChange > threshold) {
      let confirmMs = Math.max(0, this.config.mmCancelConfirmMs ?? 0);
      const wsConfirmMult = this.getWsHealthCancelConfirmMult();
      if (wsConfirmMult > 0 && wsConfirmMult !== 1) {
        confirmMs = Math.round(confirmMs * wsConfirmMult);
      }
      confirmMs = this.getEffectiveCancelConfirmMs(confirmMs);
      if (confirmMs <= 0) {
        return true;
      }
      const until = this.cancelHoldUntil.get(tokenId) || 0;
      if (!until) {
        this.cancelHoldUntil.set(tokenId, Date.now() + confirmMs);
        return false;
      }
      if (Date.now() >= until) {
        this.cancelHoldUntil.delete(tokenId);
        return true;
      }
      return false;
    }
    this.cancelHoldUntil.delete(tokenId);

    const depthDropRatio = this.config.mmDepthDropRatio ?? 0;
    if (depthDropRatio > 0) {
      const currentDepth = this.getTopDepth(orderbook).shares;
      const lastDepth = this.lastDepth.get(tokenId);
      if (lastDepth && lastDepth > 0 && currentDepth / lastDepth < 1 - depthDropRatio) {
        return true;
      }
    }

    return false;
  }

  private getAdaptiveMinInterval(tokenId: string): number {
    const base = this.config.minOrderIntervalMs ?? 3000;
    let multiplier = 1;
    const profile = this.lastProfile.get(tokenId);
    if (profile === 'VOLATILE') {
      multiplier *= this.config.mmIntervalProfileVolatileMultiplier ?? 1.3;
    } else if (profile === 'CALM') {
      multiplier *= this.config.mmIntervalProfileCalmMultiplier ?? 0.8;
    }
    if (this.config.mmAdaptiveParams !== false) {
      const vol = this.volatilityEma.get(tokenId) ?? 0;
      const threshold = this.config.mmIntervalVolatilityBps ?? 0.01;
      const mult = this.config.mmIntervalVolMultiplier ?? 1.6;
      if (vol >= threshold) {
        multiplier *= mult;
      }
    }
    if (this.isLayerPanicActive(tokenId)) {
      const panicMult = Math.max(1, this.config.mmLayerPanicIntervalMult ?? 1);
      multiplier *= panicMult;
    }
    if (this.isLayerRestoreActive(tokenId)) {
      const restoreMult = Math.max(1, this.config.mmLayerRestoreIntervalMult ?? 1);
      multiplier *= restoreMult;
    }
    const panicRestoreMult =
      this.isLayerRestoreActive(tokenId) && this.config.mmPanicRestoreIntervalMult
        ? Math.max(1, this.config.mmPanicRestoreIntervalMult ?? 1)
        : 1;
    if (panicRestoreMult > 1) {
      multiplier *= panicRestoreMult;
    }
    multiplier *= this.getFillSlowdownMultiplier(tokenId);
    const throttle = this.getRiskThrottleFactor(tokenId);
    if (throttle < 1) {
      multiplier *= 1 + (1 - throttle);
    }
    let interval = Math.max(500, Math.round(base * multiplier));
    if (this.isWsEmergencyRecoveryActive()) {
      const minInterval = Math.max(0, this.config.mmWsHealthEmergencyRecoveryMinIntervalMs ?? 0);
      if (minInterval > interval) {
        interval = minInterval;
      }
    }
    return interval;
  }

  private getEffectiveCancelConfirmMs(baseMs: number): number {
    let confirmMs = baseMs;
    if (this.isWsEmergencyRecoveryActive()) {
      const mult = this.getWsEmergencyRecoveryCancelIntervalMult();
      if (mult > 1) {
        confirmMs = Math.round(confirmMs * mult);
      }
    }
    return confirmMs;
  }

  private canSendAction(tokenId: string): boolean {
    const now = Date.now();
    const lockUntil = this.actionLockUntil.get(tokenId) || 0;
    if (lockUntil > now) {
      return false;
    }
    let minInterval = this.getAdaptiveMinInterval(tokenId);
    const wsIntervalMult = this.getWsHealthIntervalMult();
    if (wsIntervalMult > 1) {
      minInterval = Math.round(minInterval * wsIntervalMult);
    }
    const safeModeActive = this.isSafeModeActive(tokenId, {
      volEma: this.volatilityEma.get(tokenId) ?? 0,
      depthTrend: this.depthTrend.get(tokenId) ?? 0,
      depthSpeedBps: this.lastDepthSpeedBps.get(tokenId) ?? 0,
    });
    if (safeModeActive) {
      const safeMin = Math.max(0, this.config.mmSafeModeMinIntervalMs ?? 0);
      if (safeMin > minInterval) {
        minInterval = safeMin;
      }
    }
    if (this.isProtectiveActive(tokenId)) {
      const protectiveMin = Math.max(0, this.getProtectiveConfig().minIntervalMs);
      if (protectiveMin > minInterval) {
        minInterval = protectiveMin;
      }
    }
    const lastAt = this.lastActionAt.get(tokenId) || 0;
    const cooldownUntil = this.cooldownUntil.get(tokenId) || 0;
    return now - lastAt >= minInterval && now >= cooldownUntil;
  }

  private async markAction(tokenId: string): Promise<void> {
    this.lastActionAt.set(tokenId, Date.now());
    if (this.config.mmActionBurstLimit) {
      this.recordActionBurst(tokenId);
    }
    if (this.isLayerRestoreActive(tokenId) && this.config.mmLayerRestoreForceCleanup) {
      await this.cancelOrdersForMarket(tokenId);
    }
  }

  private recordActionBurst(tokenId: string): void {
    const limit = Math.max(0, this.config.mmActionBurstLimit ?? 0);
    if (!limit) {
      return;
    }
    const windowMs = Math.max(1, this.config.mmActionBurstWindowMs ?? 10000);
    const cooldownMs = Math.max(0, this.config.mmActionBurstCooldownMs ?? 0);
    const now = Date.now();
    const entry = this.actionBurst.get(tokenId) || { count: 0, windowStart: now };
    if (now - entry.windowStart > windowMs) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count += 1;
    this.actionBurst.set(tokenId, entry);
    if (entry.count >= limit && cooldownMs > 0) {
      this.actionLockUntil.set(tokenId, now + cooldownMs);
      if (this.config.mmActionBurstRestoreHoldMs) {
        this.layerRestoreAt.set(tokenId, now + Math.max(0, this.config.mmActionBurstRestoreHoldMs));
        this.layerRestoreStartAt.set(tokenId, now);
      }
    }
  }

  private markCooldown(tokenId: string, durationMs: number): void {
    this.cooldownUntil.set(tokenId, Date.now() + durationMs);
  }

  private sleep(ms: number): Promise<void> {
    if (!ms || ms <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isPaused(tokenId: string): boolean {
    const until = this.pauseUntil.get(tokenId) || 0;
    return Date.now() < until;
  }

  private pauseForVolatility(tokenId: string): void {
    const pauseMs = this.config.pauseAfterVolatilityMs ?? 8000;
    this.setPauseReason(tokenId, pauseMs, '波动过高', 'volatility');
  }

  private parseShares(entry?: OrderbookEntry): number {
    if (!entry) {
      return 0;
    }

    const shares = Number(entry.shares);
    return Number.isFinite(shares) && shares > 0 ? shares : 0;
  }

  private sumDepthLevels(entries: OrderbookEntry[] | undefined, levels: number): number {
    if (!entries || entries.length === 0) {
      return 0;
    }
    const capped = levels > 0 ? entries.slice(0, levels) : entries;
    return capped.reduce((sum, entry) => sum + this.parseShares(entry), 0);
  }

  private updateDepthMetrics(tokenId: string, orderbook: Orderbook): {
    totalDepth: number;
    bidDepth: number;
    askDepth: number;
    imbalance: number;
    depthTrend: number;
    depthSpeedBps: number;
    bidDepthSpeedBps: number;
    askDepthSpeedBps: number;
  } {
    const levels = this.config.mmDepthLevels ?? 3;
    const bidDepth = this.sumDepthLevels(orderbook.bids, levels);
    const askDepth = this.sumDepthLevels(orderbook.asks, levels);
    const totalDepth = bidDepth + askDepth;

    const alpha = this.config.mmDepthEmaAlpha ?? 0.2;
    const prevEma = this.totalDepthEma.get(tokenId) ?? totalDepth;
    const ema = prevEma + alpha * (totalDepth - prevEma);
    this.totalDepthEma.set(tokenId, ema);

    const depthTrend = ema > 0 ? (totalDepth - ema) / ema : 0;
    this.depthTrend.set(tokenId, depthTrend);

    const denom = bidDepth + askDepth;
    const imbalance = denom > 0 ? (bidDepth - askDepth) / denom : 0;
    this.lastImbalance.set(tokenId, this.clamp(imbalance, -1, 1));

    const speedWindow = Math.max(0, this.config.mmDepthSpeedWindowMs ?? 0);
    let depthSpeedBps = 0;
    let bidSpeedBps = 0;
    let askSpeedBps = 0;
    if (speedWindow > 0) {
      const prevAt = this.prevBestAt.get(tokenId) || 0;
      if (prevAt > 0 && Date.now() - prevAt <= speedWindow) {
        const prevBidDepth = this.prevBestBidSize.get(tokenId) ?? 0;
        const prevAskDepth = this.prevBestAskSize.get(tokenId) ?? 0;
        const prevTotal = prevBidDepth + prevAskDepth;
        if (prevTotal > 0 && totalDepth > 0) {
          depthSpeedBps = ((prevTotal - totalDepth) / prevTotal) * 10000;
        }
        if (prevBidDepth > 0 && bidDepth > 0) {
          bidSpeedBps = ((prevBidDepth - bidDepth) / prevBidDepth) * 10000;
        }
        if (prevAskDepth > 0 && askDepth > 0) {
          askSpeedBps = ((prevAskDepth - askDepth) / prevAskDepth) * 10000;
        }
      }
    }

    const result = {
      totalDepth,
      bidDepth,
      askDepth,
      imbalance,
      depthTrend,
      depthSpeedBps,
      bidDepthSpeedBps: bidSpeedBps,
      askDepthSpeedBps: askSpeedBps,
    };
    this.depthMetrics.set(tokenId, result);
    return result;
  }

  private updateBestPrices(tokenId: string, orderbook: Orderbook): void {
    const now = Date.now();
    const prevBid = this.lastBestBid.get(tokenId);
    const prevAsk = this.lastBestAsk.get(tokenId);
    const prevAt = this.lastBestAt.get(tokenId);
    const prevBidSize = this.lastBestBidSize.get(tokenId);
    const prevAskSize = this.lastBestAskSize.get(tokenId);
    const prevBidDelta = this.lastBidDeltaBps.get(tokenId);
    const prevAskDelta = this.lastAskDeltaBps.get(tokenId);
    if (prevBid !== undefined) {
      this.prevBestBid.set(tokenId, prevBid);
    }
    if (prevAsk !== undefined) {
      this.prevBestAsk.set(tokenId, prevAsk);
    }
    if (prevAt !== undefined) {
      this.prevBestAt.set(tokenId, prevAt);
    }
    if (prevBidSize !== undefined) {
      this.prevBestBidSize.set(tokenId, prevBidSize);
    }
    if (prevAskSize !== undefined) {
      this.prevBestAskSize.set(tokenId, prevAskSize);
    }
    if (orderbook.best_bid !== undefined && orderbook.best_bid > 0) {
      if (prevBid !== undefined && prevBid > 0) {
        const delta = ((orderbook.best_bid - prevBid) / prevBid) * 10000;
        if (prevBidDelta !== undefined) {
          this.prevBidDeltaBps.set(tokenId, prevBidDelta);
        }
        this.lastBidDeltaBps.set(tokenId, delta);
      }
      this.lastBestBid.set(tokenId, orderbook.best_bid);
    }
    if (orderbook.best_ask !== undefined && orderbook.best_ask > 0) {
      if (prevAsk !== undefined && prevAsk > 0) {
        const delta = ((orderbook.best_ask - prevAsk) / prevAsk) * 10000;
        if (prevAskDelta !== undefined) {
          this.prevAskDeltaBps.set(tokenId, prevAskDelta);
        }
        this.lastAskDeltaBps.set(tokenId, delta);
      }
      this.lastBestAsk.set(tokenId, orderbook.best_ask);
    }
    const bidSize = this.parseShares(orderbook.bids?.[0]);
    const askSize = this.parseShares(orderbook.asks?.[0]);
    if (bidSize > 0) {
      this.lastBestBidSize.set(tokenId, bidSize);
    }
    if (askSize > 0) {
      this.lastBestAskSize.set(tokenId, askSize);
    }
    this.lastBestAt.set(tokenId, now);
  }

  private calculateMicroPrice(orderbook: Orderbook): number | null {
    const bestBid = orderbook.best_bid;
    const bestAsk = orderbook.best_ask;

    if (bestBid === undefined || bestAsk === undefined) {
      return null;
    }

    // HIGH FIX #3: 添加数组边界检查
    if (!orderbook.bids || orderbook.bids.length === 0 ||
        !orderbook.asks || orderbook.asks.length === 0) {
      return null;
    }

    const topBidShares = this.parseShares(orderbook.bids[0]);
    const topAskShares = this.parseShares(orderbook.asks[0]);

    if (topBidShares > 0 && topAskShares > 0) {
      return (bestAsk * topBidShares + bestBid * topAskShares) / (topBidShares + topAskShares);
    }

    return (bestBid + bestAsk) / 2;
  }

  private calculateOrderbookImbalance(orderbook: Orderbook): number {
    const levels = Math.max(1, this.config.mmImbalanceLevels ?? 3);
    const bids = orderbook.bids.slice(0, levels);
    const asks = orderbook.asks.slice(0, levels);
    let bidShares = 0;
    let askShares = 0;
    for (const entry of bids) {
      bidShares += this.parseShares(entry);
    }
    for (const entry of asks) {
      askShares += this.parseShares(entry);
    }
    const total = bidShares + askShares;
    if (total <= 0) {
      return 0;
    }
    return this.clamp((bidShares - askShares) / total, -1, 1);
  }

  private getVolatilityMultiplier(tokenId: string, multiplier: number): number {
    const vol = this.volatilityEma.get(tokenId) ?? 0;
    if (!multiplier || multiplier <= 0) {
      return 1;
    }
    return 1 + vol * multiplier;
  }

  private checkVolatility(tokenId: string, orderbook: Orderbook): boolean {
    if (!orderbook.mid_price) {
      return false;
    }

    const lastMid = this.lastPrices.get(tokenId);
    const lastAt = this.lastPriceAt.get(tokenId) || 0;
    const lookback = this.config.volatilityLookbackMs ?? 10000;

    if (!lastMid || Date.now() - lastAt > lookback) {
      return false;
    }

    const change = Math.abs(orderbook.mid_price - lastMid) / lastMid;
    let threshold = this.config.volatilityPauseBps ?? 0.01;
    if (this.isWsEmergencyRecoveryActive()) {
      threshold *= this.getWsEmergencyRecoveryVolatilityMult();
    }

    if (change >= threshold) {
      this.pauseForVolatility(tokenId);
      return true;
    }

    return false;
  }

  private checkSpreadJump(tokenId: string, orderbook: Orderbook): boolean {
    const thresholdBps = Math.max(0, this.config.mmSpreadJumpBps ?? 0);
    const protectiveThreshold = Math.max(0, this.config.mmProtectiveSpreadJumpBps ?? 0);
    if (!thresholdBps && !protectiveThreshold) {
      return false;
    }
    const bestBid = orderbook.best_bid;
    const bestAsk = orderbook.best_ask;
    if (!bestBid || !bestAsk || bestBid <= 0 || bestAsk <= 0) {
      return false;
    }
    const spread = (bestAsk - bestBid) / ((bestAsk + bestBid) / 2);
    const now = Date.now();
    const last = this.lastBookSpread.get(tokenId);
    const lastAt = this.lastBookSpreadAt.get(tokenId) || 0;
    this.lastBookSpread.set(tokenId, spread);
    this.lastBookSpreadAt.set(tokenId, now);
    const windowMs = Math.max(0, this.config.mmSpreadJumpWindowMs ?? 0);
    if (!last || (windowMs > 0 && now - lastAt > windowMs)) {
      this.lastBookSpreadDeltaBps.set(tokenId, 0);
      return false;
    }
    const deltaBps = Math.abs(spread - last) * 10000;
    this.lastBookSpreadDeltaBps.set(tokenId, deltaBps);
    return thresholdBps > 0 && deltaBps >= thresholdBps;
  }

  private checkDepthSpeedSpike(tokenId: string): boolean {
    const thresholdBps = Math.max(0, this.config.mmDepthSpeedPauseBps ?? 0);
    if (!thresholdBps) {
      return false;
    }
    const depthSpeed = this.lastDepthSpeedBps.get(tokenId) ?? 0;
    if (!Number.isFinite(depthSpeed) || depthSpeed < thresholdBps) {
      return false;
    }
    const pauseMs = Math.max(0, this.config.mmDepthSpeedPauseMs ?? 0);
    if (pauseMs > 0) {
      this.pauseUntil.set(tokenId, Date.now() + pauseMs);
    } else {
      this.pauseForVolatility(tokenId);
    }
    return true;
  }

  private isProtectiveActive(tokenId: string): boolean {
    const until = this.protectiveUntil.get(tokenId) || 0;
    if (!until) {
      return false;
    }
    if (until > Date.now()) {
      return true;
    }
    this.protectiveUntil.delete(tokenId);
    return false;
  }

  private getProtectiveConfig(): {
    holdMs: number;
    minIntervalMs: number;
    layerCountCap: number;
    onlyFar: boolean;
    forceSingle: boolean;
    sizeScale: number;
    touchBufferAddBps: number;
    singleSideAuto: boolean;
    singleSideMode: 'NORMAL' | 'REMOTE';
    singleSideOffsetBps: number;
  } {
    const templateEnabled = this.config.mmProtectiveTemplateEnabled === true;
    const holdMs = Math.max(0, this.config.mmProtectiveHoldMs ?? 0) || (templateEnabled ? 9000 : 0);
    const minIntervalMs =
      Math.max(0, this.config.mmProtectiveMinIntervalMs ?? 0) || (templateEnabled ? 4500 : 0);
    const layerCountCap =
      Math.max(0, Math.floor(this.config.mmProtectiveLayerCountCap ?? 0)) || (templateEnabled ? 1 : 0);
    const onlyFar = this.config.mmProtectiveOnlyFar === true || templateEnabled;
    const forceSingle = this.config.mmProtectiveForceSingle === true || templateEnabled;
    const sizeScale = this.config.mmProtectiveSizeScale ?? 0;
    const resolvedSizeScale = sizeScale > 0 ? sizeScale : templateEnabled ? 0.7 : 0;
    const touchBufferAdd = this.config.mmProtectiveTouchBufferAddBps ?? 0;
    const resolvedTouchBuffer = touchBufferAdd > 0 ? touchBufferAdd : templateEnabled ? 6 : 0;
    const singleSideAuto = this.config.mmProtectiveSingleSideAuto === true || templateEnabled;
    const singleSideMode = (templateEnabled
      ? 'REMOTE'
      : (this.config.mmProtectiveSingleSideMode || 'NORMAL').toUpperCase()) as 'NORMAL' | 'REMOTE';
    const singleSideOffset = this.config.mmProtectiveSingleSideOffsetBps ?? 0;
    const resolvedOffset = singleSideOffset > 0 ? singleSideOffset : templateEnabled ? 8 : 0;
    return {
      holdMs,
      minIntervalMs,
      layerCountCap,
      onlyFar,
      forceSingle,
      sizeScale: resolvedSizeScale,
      touchBufferAddBps: resolvedTouchBuffer,
      singleSideAuto,
      singleSideMode,
      singleSideOffsetBps: resolvedOffset,
    };
  }

  private activateProtectiveMode(tokenId: string): boolean {
    const holdMs = this.getProtectiveConfig().holdMs;
    if (!holdMs) {
      return false;
    }
    const now = Date.now();
    const until = now + holdMs;
    const current = this.protectiveUntil.get(tokenId) || 0;
    this.protectiveUntil.set(tokenId, Math.max(current, until));
    return current <= now;
  }

  private checkProtectiveMode(tokenId: string): boolean {
    const depthSpeedThreshold = Math.max(0, this.config.mmProtectiveDepthSpeedBps ?? 0);
    const spreadJumpThreshold = Math.max(0, this.config.mmProtectiveSpreadJumpBps ?? 0);
    if (!depthSpeedThreshold || !spreadJumpThreshold) {
      return false;
    }
    const depthSpeed = this.lastDepthSpeedBps.get(tokenId) ?? 0;
    const spreadJump = this.lastBookSpreadDeltaBps.get(tokenId) ?? 0;
    if (depthSpeed >= depthSpeedThreshold && spreadJump >= spreadJumpThreshold) {
      return this.activateProtectiveMode(tokenId);
    }
    return false;
  }

  private evaluateOrderRisk(
    order: Order,
    orderbook: Orderbook
  ): { cancel: boolean; panic: boolean; reason: string } {
    const refreshMs = this.getOrderRefreshMs(order.order_hash || order.id || '');
    if (refreshMs > 0 && Date.now() - order.timestamp > refreshMs) {
      return { cancel: true, panic: false, reason: 'refresh' };
    }

    const price = Number(order.price);
    if (!Number.isFinite(price) || price <= 0) {
      return { cancel: true, panic: true, reason: 'invalid price' };
    }

    const bestBid = orderbook.best_bid;
    const bestAsk = orderbook.best_ask;
    if (bestBid === undefined || bestAsk === undefined) {
      return { cancel: false, panic: false, reason: '' };
    }

    let nearTouchBase = this.config.nearTouchBps ?? 0.003;  // 30bps = 0.3%（原来15bps太松）
    let antiFillBase = this.config.antiFillBps ?? 0.004;    // 40bps = 0.4%（原来20bps太松）
    if (this.isLayerRestoreActive(order.token_id)) {
      const restoreMult = this.config.mmLayerRestoreNearTouchMult ?? 0;
      if (restoreMult > 0) {
        nearTouchBase *= restoreMult;
        antiFillBase *= restoreMult;
      }
      const restoreAdd = this.config.mmLayerRestoreNearTouchAddBps ?? 0;
      if (restoreAdd > 0) {
        nearTouchBase += restoreAdd / 10000;
        antiFillBase += restoreAdd / 10000;
      }
      const restoreCancelMult = this.config.mmLayerRestoreCancelMult ?? 0;
      if (restoreCancelMult > 0) {
        nearTouchBase *= restoreCancelMult;
        antiFillBase *= restoreCancelMult;
      }
    }
    const safeModeActive = this.isSafeModeActive(order.token_id, {
      volEma: this.volatilityEma.get(order.token_id) ?? 0,
      depthTrend: this.depthTrend.get(order.token_id) ?? 0,
      depthSpeedBps: this.lastDepthSpeedBps.get(order.token_id) ?? 0,
    });
    if (safeModeActive) {
      const mult = Math.max(1, this.config.mmSafeModeNearTouchMult ?? 1);
      nearTouchBase *= mult;
      const antiMult = Math.max(1, this.config.mmSafeModeAntiFillMult ?? mult);
      antiFillBase *= antiMult;
      const add = Math.max(0, this.config.mmSafeModeNearTouchAddBps ?? 0);
      if (add > 0) {
        nearTouchBase += add / 10000;
        antiFillBase += add / 10000;
      }
      const cancelMult = Math.max(1, this.config.mmSafeModeCancelMult ?? 1);
      nearTouchBase *= cancelMult;
      antiFillBase *= cancelMult;
    }
    const autoTuneMult = this.getAutoTuneMultiplier(order.token_id);
    if (autoTuneMult !== 1) {
      nearTouchBase *= autoTuneMult;
      antiFillBase *= autoTuneMult;
    }
    const depthSpeedThreshold = Math.max(0, this.config.mmNearTouchDepthSpeedBps ?? 0);
    if (depthSpeedThreshold > 0) {
      const depthSpeed = this.lastDepthSpeedBps.get(order.token_id) ?? 0;
      if (depthSpeed >= depthSpeedThreshold) {
        const nearSpeedMult = Math.max(1, this.config.mmNearTouchDepthSpeedMult ?? 1);
        const antiSpeedMult = Math.max(1, this.config.mmAntiFillDepthSpeedMult ?? nearSpeedMult);
        nearTouchBase *= nearSpeedMult;
        antiFillBase *= antiSpeedMult;
      }
    }
    const nearMult = this.getVolatilityMultiplier(order.token_id, this.config.mmNearTouchVolMultiplier ?? 1.5);
    const antiMult = this.getVolatilityMultiplier(order.token_id, this.config.mmAntiFillVolMultiplier ?? 1.5);
    const nearTouch = nearTouchBase * nearMult;
    const antiFill = antiFillBase * antiMult;
    let softCancel = this.config.mmSoftCancelBps ?? nearTouch;
    let hardCancel = this.config.mmHardCancelBps ?? antiFill;
    const wsSoftMult = this.getWsHealthSoftCancelMult();
    const wsHardMult = this.getWsHealthHardCancelMult();
    if (wsSoftMult !== 1) {
      softCancel *= wsSoftMult;
    }
    if (wsHardMult !== 1) {
      hardCancel *= wsHardMult;
    }
    const holdMs = this.config.mmHoldNearTouchMs ?? 0; // v20: holdMs=0 → hold立即过期，延迟一个循环周期后撤单
    const holdMax = this.config.mmHoldNearTouchMaxBps ?? nearTouch;
    const aggressiveMove = this.config.mmAggressiveMoveBps ?? 0.002;
    const aggressiveWindow = this.config.mmAggressiveMoveWindowMs ?? 1500;
    const hitWarnBps = Math.max(0, this.config.mmHitWarningBps ?? 0);
    const hitWarn = hitWarnBps > 0 ? hitWarnBps / 10000 : 0;
    const hitTopSizeMin = Math.max(0, this.config.mmHitTopSizeMinShares ?? 0);
    const hitTopSizeFactor = Math.max(0, this.config.mmHitTopSizeFactor ?? 0);
    const hitDepthLevels = Math.max(0, this.config.mmHitDepthLevels ?? 0);
    const hitDepthMinShares = Math.max(0, this.config.mmHitDepthMinShares ?? 0);
    const hitSpeedBps = Math.max(0, this.config.mmHitSpeedBps ?? 0);
    const hitSpeedWindow = Math.max(0, this.config.mmHitSpeedWindowMs ?? 1200);
    const hitSizeDropRatio = Math.max(0, this.config.mmHitSizeDropRatio ?? 0);
    const hitSizeDropWindow = Math.max(0, this.config.mmHitSizeDropWindowMs ?? 1200);
    const orderShares = Number(order.shares);
    const restoreNoNearTouch = this.isLayerRestoreActive(order.token_id) && this.config.mmLayerRestoreNoNearTouch;
    const restoreNearTouchBps = Math.max(0, this.config.mmLayerRestoreNearTouchBps ?? 0);
    const restoreNearTouch = restoreNearTouchBps > 0 ? restoreNearTouchBps / 10000 : nearTouch;
    const vwapThresholdBps = Math.max(0, this.config.mmOrderRiskVwapBps ?? 0);
    const vwapLevels = Math.max(0, this.config.mmOrderRiskVwapLevels ?? 0);
    const vwapFeeBps = Math.max(0, this.config.mmOrderRiskVwapFeeBps ?? 0);
    const vwapSlippageBps = Math.max(0, this.config.mmOrderRiskVwapSlippageBps ?? 0);
    const vwapBaseShares = Math.max(0, this.config.mmOrderRiskVwapShares ?? 0);
    const vwapMult = Math.max(0, this.config.mmOrderRiskVwapMult ?? 0);
    let vwapTargetShares = vwapBaseShares;
    if (Number.isFinite(orderShares) && orderShares > 0) {
      if (vwapMult > 0) {
        vwapTargetShares = Math.max(vwapTargetShares, orderShares * vwapMult);
      }
      if (!vwapTargetShares) {
        vwapTargetShares = orderShares;
      }
    }

    const prevAt = this.prevBestAt.get(order.token_id) || 0;
    const prevBid = this.prevBestBid.get(order.token_id);
    const prevAsk = this.prevBestAsk.get(order.token_id);
    const elapsed = prevAt > 0 ? Date.now() - prevAt : 0;
    if (elapsed > 0 && elapsed <= aggressiveWindow) {
      if (order.side === 'BUY' && prevAsk && bestAsk < prevAsk * (1 - aggressiveMove)) {
        return { cancel: true, panic: true, reason: 'aggressive-move' };
      }
      if (order.side === 'SELL' && prevBid && bestBid > prevBid * (1 + aggressiveMove)) {
        return { cancel: true, panic: true, reason: 'aggressive-move' };
      }
    }

    const fastCancelBps = Math.max(0, this.config.mmFastCancelBps ?? 0);
    const fastWindow = Math.max(0, this.config.mmFastCancelWindowMs ?? 0);
    if (fastCancelBps > 0) {
      const windowMs = fastWindow > 0 ? fastWindow : aggressiveWindow;
      if (elapsed > 0 && elapsed <= windowMs) {
        const fastDepthThreshold = Math.max(0, this.config.mmFastCancelDepthSpeedBps ?? 0);
        const fastSpreadThreshold = Math.max(0, this.config.mmFastCancelSpreadJumpBps ?? 0);
        let fastGuardOk = true;
        if (fastDepthThreshold > 0 || fastSpreadThreshold > 0) {
          fastGuardOk = false;
          const depthSpeed = this.lastDepthSpeedBps.get(order.token_id) ?? 0;
          const spreadJump = this.lastBookSpreadDeltaBps.get(order.token_id) ?? 0;
          if (fastDepthThreshold > 0 && depthSpeed >= fastDepthThreshold) {
            fastGuardOk = true;
          }
          if (fastSpreadThreshold > 0 && spreadJump >= fastSpreadThreshold) {
            fastGuardOk = true;
          }
        }
        if (order.side === 'BUY') {
          const delta = this.lastAskDeltaBps.get(order.token_id) ?? 0;
          if (fastGuardOk && delta < 0 && Math.abs(delta) >= fastCancelBps) {
            return { cancel: true, panic: true, reason: 'fast-move' };
          }
        } else {
          const delta = this.lastBidDeltaBps.get(order.token_id) ?? 0;
          if (fastGuardOk && delta > 0 && delta >= fastCancelBps) {
            return { cancel: true, panic: true, reason: 'fast-move' };
          }
        }
      }
    }

    const accelBps = Math.max(0, this.config.mmPriceAccelBps ?? 0);
    const accelWindow = Math.max(0, this.config.mmPriceAccelWindowMs ?? 0);
    if (accelBps > 0 && accelWindow > 0 && elapsed > 0 && elapsed <= accelWindow) {
      if (order.side === 'BUY') {
        const lastDelta = this.lastAskDeltaBps.get(order.token_id) ?? 0;
        const prevDelta = this.prevAskDeltaBps.get(order.token_id) ?? 0;
        if (lastDelta < 0 && lastDelta - prevDelta <= -accelBps) {
          return { cancel: true, panic: true, reason: 'price-accel' };
        }
      } else {
        const lastDelta = this.lastBidDeltaBps.get(order.token_id) ?? 0;
        const prevDelta = this.prevBidDeltaBps.get(order.token_id) ?? 0;
        if (lastDelta > 0 && lastDelta - prevDelta >= accelBps) {
          return { cancel: true, panic: true, reason: 'price-accel' };
        }
      }
    }

    if (order.side === 'BUY') {
      const distance = (bestAsk - price) / price;
      if (restoreNoNearTouch && distance <= restoreNearTouch) {
        this.nearTouchHoldUntil.delete(order.order_hash);
        return { cancel: true, panic: true, reason: 'restore-no-near-touch' };
      }
      if (vwapThresholdBps > 0 && vwapTargetShares > 0) {
        const vwap = this.estimateSell(
          orderbook.bids,
          vwapTargetShares,
          vwapFeeBps,
          undefined,
          undefined,
          vwapSlippageBps,
          vwapLevels
        );
        if (vwap && Number.isFinite(vwap.avgAllIn) && vwap.avgAllIn > 0 && vwap.avgAllIn <= price) {
          const vwapDistanceBps = ((price - vwap.avgAllIn) / price) * 10000;
          if (vwapDistanceBps <= vwapThresholdBps) {
            return { cancel: true, panic: true, reason: 'vwap-risk' };
          }
        }
      }
      if (hitSpeedBps > 0 && elapsed > 0 && elapsed <= hitSpeedWindow && prevAsk && bestAsk < prevAsk) {
        const moveBps = ((prevAsk - bestAsk) / prevAsk) * 10000;
        if (hitWarn > 0 && distance <= hitWarn && moveBps >= hitSpeedBps) {
          return { cancel: true, panic: true, reason: 'hit-warning-speed' };
        }
      }
      if (hitWarn > 0 && distance <= hitWarn) {
        const topSize = this.lastBestBidSize.get(order.token_id) ?? this.parseShares(orderbook.bids?.[0]);
        const relativeCap =
          hitTopSizeFactor > 0 && Number.isFinite(orderShares) && orderShares > 0
            ? orderShares * hitTopSizeFactor
            : 0;
        const sizeThreshold = Math.max(hitTopSizeMin, relativeCap);
        if (sizeThreshold > 0 && topSize > 0 && topSize <= sizeThreshold) {
          return { cancel: true, panic: true, reason: 'hit-warning-top' };
        }
        if (hitDepthLevels > 0 && hitDepthMinShares > 0) {
          const depthShares = this.sumDepthLevels(orderbook.bids, hitDepthLevels);
          if (depthShares > 0 && depthShares <= hitDepthMinShares) {
            return { cancel: true, panic: true, reason: 'hit-warning-depth' };
          }
        }
        if (hitSizeDropRatio > 0 && elapsed > 0 && elapsed <= hitSizeDropWindow) {
          const prevSize = this.prevBestBidSize.get(order.token_id) ?? 0;
          if (prevSize > 0 && topSize > 0) {
            const drop = (prevSize - topSize) / prevSize;
            if (drop >= hitSizeDropRatio) {
              return { cancel: true, panic: true, reason: 'hit-warning-size-drop' };
            }
          }
        }
      }
      if (distance <= hardCancel || distance <= antiFill) {
        this.nearTouchHoldUntil.delete(order.order_hash);
        this.nearTouchPrevDistance.delete(order.order_hash);
        return { cancel: true, panic: true, reason: 'anti-fill' };
      }
      if (distance <= holdMax) {
        this.nearTouchHoldUntil.delete(order.order_hash);
        this.nearTouchPrevDistance.delete(order.order_hash);
        return { cancel: true, panic: true, reason: 'near-touch-max' };
      }
      if (distance <= nearTouch || distance <= softCancel) {
        // v20: 检查盘口是否继续移近 — 如果是则立即撤单
        const prevDist = this.nearTouchPrevDistance.get(order.order_hash);
        this.nearTouchPrevDistance.set(order.order_hash, distance);
        if (prevDist !== undefined && prevDist > 0 && distance < prevDist * 0.85) {
          this.nearTouchHoldUntil.delete(order.order_hash);
          this.nearTouchPrevDistance.delete(order.order_hash);
          return { cancel: true, panic: true, reason: 'near-touch-approaching' };
        }
        const until = this.nearTouchHoldUntil.get(order.order_hash) || 0;
        if (!until) {
          this.nearTouchHoldUntil.set(order.order_hash, Date.now() + holdMs);
          return { cancel: false, panic: false, reason: 'near-touch-hold' };
        }
        if (Date.now() >= until) {
          this.nearTouchHoldUntil.delete(order.order_hash);
          this.nearTouchPrevDistance.delete(order.order_hash);
          return { cancel: true, panic: false, reason: 'near-touch' };
        }
        return { cancel: false, panic: false, reason: 'near-touch-hold' };
      }
      // 不在near-touch区域时清除记录
      this.nearTouchPrevDistance.delete(order.order_hash);
    } else {
      const distance = (price - bestBid) / price;
      if (restoreNoNearTouch && distance <= restoreNearTouch) {
        this.nearTouchHoldUntil.delete(order.order_hash);
        return { cancel: true, panic: true, reason: 'restore-no-near-touch' };
      }
      if (vwapThresholdBps > 0 && vwapTargetShares > 0) {
        const vwap = this.estimateBuy(
          orderbook.asks,
          vwapTargetShares,
          vwapFeeBps,
          undefined,
          undefined,
          vwapSlippageBps,
          vwapLevels
        );
        if (vwap && Number.isFinite(vwap.avgAllIn) && vwap.avgAllIn > 0 && vwap.avgAllIn >= price) {
          const vwapDistanceBps = ((vwap.avgAllIn - price) / price) * 10000;
          if (vwapDistanceBps <= vwapThresholdBps) {
            return { cancel: true, panic: true, reason: 'vwap-risk' };
          }
        }
      }
      if (hitSpeedBps > 0 && elapsed > 0 && elapsed <= hitSpeedWindow && prevBid && bestBid > prevBid) {
        const moveBps = ((bestBid - prevBid) / prevBid) * 10000;
        if (hitWarn > 0 && distance <= hitWarn && moveBps >= hitSpeedBps) {
          return { cancel: true, panic: true, reason: 'hit-warning-speed' };
        }
      }
      if (hitWarn > 0 && distance <= hitWarn) {
        const topSize = this.lastBestAskSize.get(order.token_id) ?? this.parseShares(orderbook.asks?.[0]);
        const relativeCap =
          hitTopSizeFactor > 0 && Number.isFinite(orderShares) && orderShares > 0
            ? orderShares * hitTopSizeFactor
            : 0;
        const sizeThreshold = Math.max(hitTopSizeMin, relativeCap);
        if (sizeThreshold > 0 && topSize > 0 && topSize <= sizeThreshold) {
          return { cancel: true, panic: true, reason: 'hit-warning-top' };
        }
        if (hitDepthLevels > 0 && hitDepthMinShares > 0) {
          const depthShares = this.sumDepthLevels(orderbook.asks, hitDepthLevels);
          if (depthShares > 0 && depthShares <= hitDepthMinShares) {
            return { cancel: true, panic: true, reason: 'hit-warning-depth' };
          }
        }
        if (hitSizeDropRatio > 0 && elapsed > 0 && elapsed <= hitSizeDropWindow) {
          const prevSize = this.prevBestAskSize.get(order.token_id) ?? 0;
          if (prevSize > 0 && topSize > 0) {
            const drop = (prevSize - topSize) / prevSize;
            if (drop >= hitSizeDropRatio) {
              return { cancel: true, panic: true, reason: 'hit-warning-size-drop' };
            }
          }
        }
      }
      if (distance <= hardCancel || distance <= antiFill) {
        this.nearTouchHoldUntil.delete(order.order_hash);
        this.nearTouchPrevDistance.delete(order.order_hash);
        return { cancel: true, panic: true, reason: 'anti-fill' };
      }
      if (distance <= holdMax) {
        this.nearTouchHoldUntil.delete(order.order_hash);
        this.nearTouchPrevDistance.delete(order.order_hash);
        return { cancel: true, panic: true, reason: 'near-touch-max' };
      }
      if (distance <= nearTouch || distance <= softCancel) {
        // v20: 检查盘口是否继续移近 — 如果是则立即撤单
        const prevDist = this.nearTouchPrevDistance.get(order.order_hash);
        this.nearTouchPrevDistance.set(order.order_hash, distance);
        if (prevDist !== undefined && prevDist > 0 && distance < prevDist * 0.85) {
          this.nearTouchHoldUntil.delete(order.order_hash);
          this.nearTouchPrevDistance.delete(order.order_hash);
          return { cancel: true, panic: true, reason: 'near-touch-approaching' };
        }
        const until = this.nearTouchHoldUntil.get(order.order_hash) || 0;
        if (!until) {
          this.nearTouchHoldUntil.set(order.order_hash, Date.now() + holdMs);
          return { cancel: false, panic: false, reason: 'near-touch-hold' };
        }
        if (Date.now() >= until) {
          this.nearTouchHoldUntil.delete(order.order_hash);
          this.nearTouchPrevDistance.delete(order.order_hash);
          return { cancel: true, panic: false, reason: 'near-touch' };
        }
        return { cancel: false, panic: false, reason: 'near-touch-hold' };
      }
      // 不在near-touch区域时清除记录
      this.nearTouchPrevDistance.delete(order.order_hash);
    }

    return { cancel: false, panic: false, reason: '' };
  }

  private precheckNewOrderVwapRisk(
    orderbook: Orderbook,
    side: 'BUY' | 'SELL',
    price: number,
    shares: number
  ): { skip: boolean; distanceBps?: number; vwap?: number } {
    const thresholdBps = Math.max(0, this.config.mmOrderRiskVwapBps ?? 0);
    if (!thresholdBps) {
      return { skip: false };
    }
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(shares) || shares <= 0) {
      return { skip: false };
    }
    const vwapLevels = Math.max(0, this.config.mmOrderRiskVwapLevels ?? 0);
    const vwapFeeBps = Math.max(0, this.config.mmOrderRiskVwapFeeBps ?? 0);
    const vwapSlippageBps = Math.max(0, this.config.mmOrderRiskVwapSlippageBps ?? 0);
    const baseShares = Math.max(0, this.config.mmOrderRiskVwapShares ?? 0);
    const mult = Math.max(0, this.config.mmOrderRiskVwapMult ?? 0);
    let targetShares = baseShares;
    if (mult > 0) {
      targetShares = Math.max(targetShares, shares * mult);
    }
    if (!targetShares) {
      targetShares = shares;
    }
    if (targetShares <= 0) {
      return { skip: false };
    }
    if (side === 'BUY') {
      const vwap = this.estimateSell(
        orderbook.bids,
        targetShares,
        vwapFeeBps,
        undefined,
        undefined,
        vwapSlippageBps,
        vwapLevels
      );
      if (vwap && Number.isFinite(vwap.avgAllIn) && vwap.avgAllIn > 0 && vwap.avgAllIn <= price) {
        const distanceBps = ((price - vwap.avgAllIn) / price) * 10000;
        if (distanceBps <= thresholdBps) {
          return { skip: true, distanceBps, vwap: vwap.avgAllIn };
        }
      }
    } else {
      const vwap = this.estimateBuy(
        orderbook.asks,
        targetShares,
        vwapFeeBps,
        undefined,
        undefined,
        vwapSlippageBps,
        vwapLevels
      );
      if (vwap && Number.isFinite(vwap.avgAllIn) && vwap.avgAllIn > 0 && vwap.avgAllIn >= price) {
        const distanceBps = ((vwap.avgAllIn - price) / price) * 10000;
        if (distanceBps <= thresholdBps) {
          return { skip: true, distanceBps, vwap: vwap.avgAllIn };
        }
      }
    }
    return { skip: false };
  }

  private shouldSkipLayerDueToGuard(
    metrics: {
      topDepth: number;
      topDepthUsd: number;
      depthSpeedBps: number;
      bidDepthSpeedBps: number;
      askDepthSpeedBps: number;
    },
    side: 'BUY' | 'SELL',
    price: number,
    orderbook: Orderbook
  ): { skip: boolean; reason?: string; distanceBps?: number } {
    const guardBps = Math.max(0, this.config.mmLayerGuardNearBps ?? 0);
    if (!guardBps) {
      return { skip: false };
    }
    const best = side === 'BUY' ? orderbook.best_bid : orderbook.best_ask;
    if (!best || best <= 0 || !Number.isFinite(price) || price <= 0) {
      return { skip: false };
    }
    const distanceBps =
      side === 'BUY' ? ((best - price) / best) * 10000 : ((price - best) / best) * 10000;
    if (!Number.isFinite(distanceBps) || distanceBps < 0) {
      return { skip: false };
    }
    if (distanceBps > guardBps) {
      return { skip: false };
    }
    const minShares = Math.max(0, this.config.mmLayerGuardMinDepthShares ?? 0);
    const minUsd = Math.max(0, this.config.mmLayerGuardMinDepthUsd ?? 0);
    if ((minShares > 0 && metrics.topDepth < minShares) || (minUsd > 0 && metrics.topDepthUsd < minUsd)) {
      return { skip: true, reason: 'guard-depth', distanceBps };
    }
    const speedBps = Math.max(0, this.config.mmLayerGuardDepthSpeedBps ?? 0);
    const sideSpeed = side === 'BUY' ? metrics.bidDepthSpeedBps : metrics.askDepthSpeedBps;
    if (speedBps > 0 && sideSpeed >= speedBps) {
      return { skip: true, reason: 'guard-speed', distanceBps };
    }
    return { skip: false };
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  private getPolymarketCancelReasonState(tokenId: string): {
    windowStart: number;
    nearTouch: number;
    refresh: number;
    vwap: number;
    aggressive: number;
    unsafe: number;
    other: number;
  } {
    const now = Date.now();
    const existing = this.polymarketCancelReasonState.get(tokenId);
    const windowMs = Math.max(60_000, this.config.polymarketOrderLifecycleWindowMs ?? 6 * 60 * 60 * 1000);
    if (existing && now - existing.windowStart <= windowMs) {
      return existing;
    }
    const state = {
      windowStart: now,
      nearTouch: 0,
      refresh: 0,
      vwap: 0,
      aggressive: 0,
      unsafe: 0,
      other: 0,
    };
    this.polymarketCancelReasonState.set(tokenId, state);
    return state;
  }

  private recordPolymarketCancelReason(tokenId: string, reason: string): void {
    if (this.config.mmVenue !== 'polymarket') {
      return;
    }
    const state = this.getPolymarketCancelReasonState(tokenId);
    const normalized = String(reason || '').toLowerCase();
    if (
      normalized.startsWith('near-touch') ||
      normalized === 'anti-fill' ||
      normalized.startsWith('hit-warning')
    ) {
      state.nearTouch += 1;
    } else if (normalized === 'refresh' || normalized === 'reprice' || normalized === 'quote-refresh') {
      state.refresh += 1;
    } else if (normalized === 'vwap-risk') {
      state.vwap += 1;
    } else if (
      normalized === 'aggressive-move' ||
      normalized === 'fast-move' ||
      normalized === 'price-accel'
    ) {
      state.aggressive += 1;
    } else if (
      normalized.includes('unsafe') ||
      normalized.includes('reward-gate') ||
      normalized.includes('postonly') ||
      normalized.includes('post-only')
    ) {
      state.unsafe += 1;
    } else {
      state.other += 1;
    }
  }

  private getPolymarketCancelReasonSnapshot(tokenId: string): {
    nearTouch: number;
    refresh: number;
    vwap: number;
    aggressive: number;
    unsafe: number;
    other: number;
    total: number;
  } {
    const state = this.polymarketCancelReasonState.get(tokenId);
    if (!state) {
      return { nearTouch: 0, refresh: 0, vwap: 0, aggressive: 0, unsafe: 0, other: 0, total: 0 };
    }
    const total = state.nearTouch + state.refresh + state.vwap + state.aggressive + state.unsafe + state.other;
    return { ...state, total };
  }

  private getPolymarketCancelReasonAdjustment(
    tokenId: string,
    market: Market
  ): {
    dominant: 'nearTouch' | 'refresh' | 'vwap' | 'aggressive' | 'unsafe' | 'other' | 'none';
    dominance: number;
    retreatBps: number;
    sizeFactor: number;
    reason: string;
  } {
    if (this.config.mmVenue !== 'polymarket') {
      return { dominant: 'none', dominance: 0, retreatBps: 0, sizeFactor: 1, reason: '' };
    }
    const live = this.getPolymarketCancelReasonSnapshot(tokenId);
    const recent = {
      nearTouch: Number(market.polymarket_recent_cancel_near_touch || 0),
      refresh: Number(market.polymarket_recent_cancel_refresh || 0),
      vwap: Number(market.polymarket_recent_cancel_vwap || 0),
      aggressive: Number(market.polymarket_recent_cancel_aggressive || 0),
      unsafe: Number(market.polymarket_recent_cancel_unsafe || 0),
      other: 0,
    };
    const counts = {
      nearTouch: live.nearTouch + recent.nearTouch,
      refresh: live.refresh + recent.refresh,
      vwap: live.vwap + recent.vwap,
      aggressive: live.aggressive + recent.aggressive,
      unsafe: live.unsafe + recent.unsafe,
      other: live.other + recent.other,
    };
    const total =
      counts.nearTouch + counts.refresh + counts.vwap + counts.aggressive + counts.unsafe + counts.other;
    if (total < 3) {
      return { dominant: 'none', dominance: 0, retreatBps: 0, sizeFactor: 1, reason: '' };
    }
    const entries = Object.entries(counts) as Array<
      ['nearTouch' | 'refresh' | 'vwap' | 'aggressive' | 'unsafe' | 'other', number]
    >;
    const [dominant, dominantCount] = entries.reduce((best, entry) => (entry[1] > best[1] ? entry : best), [
      'other',
      0,
    ] as ['nearTouch' | 'refresh' | 'vwap' | 'aggressive' | 'unsafe' | 'other', number]);
    const cfg = this.getPolymarketExecutionSafetyConfig();
    const rawDominance = dominantCount / Math.max(1, total);
    const threshold = this.clamp(cfg.cancelReasonDominanceThreshold, 0, 1);
    if (rawDominance <= threshold) {
      return { dominant: 'none', dominance: rawDominance, retreatBps: 0, sizeFactor: 1, reason: '' };
    }
    const normalized = this.clamp((rawDominance - threshold) / Math.max(0.05, 1 - threshold), 0, 1);
    const riskWeight =
      dominant === 'aggressive'
        ? 1.1
        : dominant === 'unsafe'
          ? 1.2
          : dominant === 'nearTouch'
            ? 0.9
            : dominant === 'vwap'
              ? 0.7
              : dominant === 'refresh'
                ? 0.45
                : 0.3;
    const scaled = this.clamp(normalized * riskWeight, 0, 1);
    const retreatBps = cfg.cancelReasonRetreatMaxBps * scaled;
    const sizeFactor = 1 - (1 - cfg.cancelReasonSizeFactorMin) * scaled;
    const labelMap = {
      nearTouch: '近触撤单占比高',
      refresh: '追价撤单占比高',
      vwap: 'VWAP 风控撤单占比高',
      aggressive: '激进走势撤单占比高',
      unsafe: '不安全盘口撤单占比高',
      other: '其他撤单占比高',
      none: '',
    } as const;
    return {
      dominant,
      dominance: rawDominance,
      retreatBps,
      sizeFactor: this.clamp(sizeFactor, cfg.cancelReasonSizeFactorMin, 1),
      reason: `${labelMap[dominant]} ${(rawDominance * 100).toFixed(0)}%`,
    };
  }

  private async maybeTripPolymarketCancelPatternFuse(tokenId: string, market: Market): Promise<boolean> {
    if (this.config.mmVenue !== 'polymarket') {
      return false;
    }
    const live = this.getPolymarketCancelReasonSnapshot(tokenId);
    const cfg = this.getPolymarketExecutionSafetyConfig();
    if (live.total < Math.max(0, cfg.cancelPatternFuseMinCount)) {
      return false;
    }
    const candidates = [
      ['aggressive', live.aggressive],
      ['unsafe', live.unsafe],
      ['nearTouch', live.nearTouch],
    ] as const;
    const [dominant, count] = candidates.reduce((best, entry) => (entry[1] > best[1] ? entry : best), ['nearTouch', 0] as const);
    const dominance = count / Math.max(1, live.total);
    if (dominance < this.clamp(cfg.cancelPatternFuseDominance, 0, 1)) {
      return false;
    }
    const source =
      dominant === 'aggressive'
        ? 'polymarket-cancel-pattern-aggressive'
        : dominant === 'unsafe'
          ? 'polymarket-cancel-pattern-unsafe'
          : 'polymarket-cancel-pattern-near-touch';
    const label =
      dominant === 'aggressive'
        ? '激进走势撤单主导'
        : dominant === 'unsafe'
          ? '不安全盘口撤单主导'
          : '近触撤单主导';
    await this.enforceMarketPause(
      tokenId,
      Math.max(1000, cfg.cancelPatternFusePauseMs),
      `${label} ${(dominance * 100).toFixed(0)}%`,
      source,
      true
    );
    this.recordMmEvent(
      'POLYMARKET_CANCEL_PATTERN_FUSE',
      `${label}, total=${live.total}, dominance=${(dominance * 100).toFixed(0)}%`,
      tokenId
    );
    this.polymarketCancelReasonState.set(tokenId, {
      windowStart: Date.now(),
      nearTouch: 0,
      refresh: 0,
      vwap: 0,
      aggressive: 0,
      unsafe: 0,
      other: 0,
    });
    return true;
  }

  private allowCancel(tokenId: string, isPanic: boolean): boolean {
    const bypass = this.config.mmCancelBudgetPanicBypass !== false;
    if (isPanic && bypass) {
      return true;
    }
    const now = Date.now();
    const max = Math.max(0, this.config.mmCancelBudgetMax ?? 0);
    const windowMs = Math.max(0, this.config.mmCancelBudgetWindowMs ?? 0);
    if (max && windowMs) {
      const entry = this.cancelBudget.get(tokenId) || { count: 0, windowStart: now, cooldownUntil: 0 };
      if (entry.cooldownUntil && now < entry.cooldownUntil) {
        return false;
      }
      if (now - entry.windowStart > windowMs) {
        entry.count = 0;
        entry.windowStart = now;
        entry.cooldownUntil = 0;
      }
      if (entry.count >= max) {
        const cooldown = Math.max(0, this.config.mmCancelBudgetCooldownMs ?? 0);
        if (cooldown > 0) {
          entry.cooldownUntil = now + cooldown;
        }
        this.cancelBudget.set(tokenId, entry);
        return false;
      }
      entry.count += 1;
      this.cancelBudget.set(tokenId, entry);
    }
    const burstBypass = this.config.mmCancelBurstPanicBypass !== false;
    if (!isPanic || !burstBypass) {
      const burstLimit = Math.max(0, this.config.mmCancelBurstLimit ?? 0);
      const burstWindowMs = Math.max(0, this.config.mmCancelBurstWindowMs ?? 0);
      if (burstLimit > 0 && burstWindowMs > 0) {
        const entry = this.cancelBurst.get(tokenId) || { count: 0, windowStart: now, cooldownUntil: 0 };
        if (entry.cooldownUntil && now < entry.cooldownUntil) {
          return false;
        }
        if (now - entry.windowStart > burstWindowMs) {
          entry.count = 0;
          entry.windowStart = now;
          entry.cooldownUntil = 0;
        }
        if (entry.count >= burstLimit) {
          const cooldown = Math.max(0, this.config.mmCancelBurstCooldownMs ?? 0);
          if (cooldown > 0) {
            entry.cooldownUntil = now + cooldown;
            this.markCooldown(tokenId, cooldown);
          }
          const retreatMs = Math.max(0, this.config.mmCancelBurstRetreatMs ?? 0);
          if (retreatMs > 0) {
            this.applyLayerRetreatFor(tokenId, retreatMs);
          } else {
            this.applyLayerRetreat(tokenId);
          }
          this.cancelBurst.set(tokenId, entry);
          this.recordMmEvent(
            'CANCEL_BURST',
            `limit=${burstLimit} window=${burstWindowMs}ms cooldown=${cooldown}ms`,
            tokenId
          );
          return false;
        }
        entry.count += 1;
        this.cancelBurst.set(tokenId, entry);
      }
    }
    return true;
  }

  private isCancelBurstActive(tokenId: string): boolean {
    const burstLimit = Math.max(0, this.config.mmCancelBurstLimit ?? 0);
    const burstWindowMs = Math.max(0, this.config.mmCancelBurstWindowMs ?? 0);
    if (!burstLimit || !burstWindowMs) {
      return false;
    }
    const now = Date.now();
    const entry = this.cancelBurst.get(tokenId);
    if (!entry) {
      return false;
    }
    if (entry.cooldownUntil && entry.cooldownUntil > now) {
      return true;
    }
    return entry.count >= burstLimit && now - entry.windowStart <= burstWindowMs;
  }

  private getRiskThrottleState(tokenId: string): { score: number; lastUpdate: number; coolOffUntil: number } {
    const now = Date.now();
    const entry = this.riskThrottleState.get(tokenId) || { score: 0, lastUpdate: now, coolOffUntil: 0 };
    const decayMs = Math.max(0, this.config.mmRiskThrottleDecayMs ?? 0);
    if (decayMs > 0 && entry.score > 0) {
      const elapsed = Math.max(0, now - entry.lastUpdate);
      const decay = Math.min(1, elapsed / decayMs);
      entry.score = Math.max(0, entry.score * (1 - decay));
    }
    entry.lastUpdate = now;
    this.riskThrottleState.set(tokenId, entry);
    return entry;
  }

  private addRiskThrottle(tokenId: string, penalty: number): void {
    if (!this.config.mmRiskThrottleEnabled) {
      return;
    }
    if (!penalty || penalty <= 0) {
      return;
    }
    const entry = this.getRiskThrottleState(tokenId);
    const maxFactor = Math.max(1, this.config.mmRiskThrottleMaxFactor ?? 2.5);
    entry.score = this.clamp(entry.score + penalty, 0, maxFactor);
    const coolOff = Math.max(0, this.config.mmRiskThrottleCoolOffMs ?? 0);
    if (coolOff > 0) {
      entry.coolOffUntil = Date.now() + coolOff;
    }
    this.riskThrottleState.set(tokenId, entry);
  }

  private recordNearTouch(tokenId: string): number {
    const windowMs = Math.max(1000, this.config.mmNearTouchBurstWindowMs ?? 30000);
    const limit = Math.max(1, this.config.mmNearTouchBurstLimit ?? 0);
    if (limit <= 0) {
      return 0;
    }
    const now = Date.now();
    const entry = this.nearTouchBurst.get(tokenId) || { count: 0, windowStart: now };
    if (now - entry.windowStart > windowMs) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count += 1;
    this.nearTouchBurst.set(tokenId, entry);
    return entry.count;
  }

  private recordFillBurst(tokenId: string): number {
    const windowMs = Math.max(1000, this.config.mmFillBurstWindowMs ?? 30000);
    const limit = Math.max(1, this.config.mmFillBurstLimit ?? 0);
    if (limit <= 0) {
      return 0;
    }
    const now = Date.now();
    const entry = this.fillBurst.get(tokenId) || { count: 0, windowStart: now };
    if (now - entry.windowStart > windowMs) {
      entry.count = 0;
      entry.windowStart = now;
    }
    entry.count += 1;
    this.fillBurst.set(tokenId, entry);
    return entry.count;
  }

  private getRiskThrottleFactor(tokenId: string): number {
    if (!this.config.mmRiskThrottleEnabled) {
      return 1;
    }
    const entry = this.getRiskThrottleState(tokenId);
    if (entry.coolOffUntil && Date.now() < entry.coolOffUntil) {
      return this.clamp(this.config.mmRiskThrottleMinFactor ?? 0.6, 0.1, 1);
    }
    const minFactor = this.clamp(this.config.mmRiskThrottleMinFactor ?? 0.6, 0.1, 1);
    const maxFactor = Math.max(1, this.config.mmRiskThrottleMaxFactor ?? 2.5);
    const score = this.clamp(entry.score, 0, maxFactor);
    const penalty = Math.min(1, score / maxFactor);
    return this.clamp(1 - penalty * (1 - minFactor), minFactor, 1);
  }

  private hashToUnit(input: string): number {
    let hash = 0;
    for (let i = 0; i < input.length; i += 1) {
      hash = (hash << 5) - hash + input.charCodeAt(i);
      hash |= 0;
    }
    const unsigned = hash >>> 0;
    return unsigned / 0xffffffff;
  }

  private getOrderRefreshMs(orderHash: string): number {
    const base = Math.max(0, this.config.mmOrderRefreshMs ?? 0);
    if (!base) {
      return 0;
    }
    const jitterPct = Math.max(0, this.config.mmOrderRefreshJitterPct ?? 0);
    if (jitterPct <= 0 || !orderHash) {
      return base;
    }
    const jitter = (this.hashToUnit(orderHash) * 2 - 1) * jitterPct;
    const scaled = base * (1 + jitter);
    return Math.max(0, Math.round(scaled));
  }

  private getAccountEquityUsd(): number {
    const equity = this.config.mmAccountEquityUsd ?? 0;
    if (equity > 0) {
      return equity;
    }
    const positionsValue = Array.from(this.positions.values()).reduce((sum, p) => sum + (p.total_value || 0), 0);
    return Math.max(0, positionsValue);
  }

  private getEffectiveMaxPosition(): number {
    const pct = this.config.mmMaxPositionPct ?? 0;
    const equity = this.getAccountEquityUsd();
    if (pct > 0 && equity > 0) {
      return Math.max(1, equity * pct);
    }
    return Math.max(1, this.config.maxPosition);
  }

  private getEffectiveOrderSize(): number {
    const pct = this.config.mmOrderSizePct ?? 0;
    const equity = this.getAccountEquityUsd();
    if (pct > 0 && equity > 0) {
      return Math.max(1, equity * pct);
    }
    return this.config.orderSize;
  }

  private getEffectiveMaxSingleOrderValue(): number {
    const pct = this.config.mmMaxSingleOrderPct ?? 0;
    const equity = this.getAccountEquityUsd();
    if (pct > 0 && equity > 0) {
      return Math.max(1, equity * pct);
    }
    let base = this.config.maxSingleOrderValue ?? Number.POSITIVE_INFINITY;
    if (this.isWsEmergencyRecoveryActive()) {
      const mult = this.config.mmWsHealthEmergencyRecoveryMaxNotionalMultMin ?? 1;
      if (mult < 1 && Number.isFinite(base)) {
        base = Math.max(1, base * mult);
      }
    }
    return base;
  }

  private getEffectiveMaxDailyLoss(): number {
    const pct = this.config.mmMaxDailyLossPct ?? 0;
    const equity = this.getAccountEquityUsd();
    if (pct > 0 && equity > 0) {
      return Math.max(1, equity * pct);
    }
    return this.config.maxDailyLoss ?? 200;
  }

  private normalizeLiquidityActivation(rule?: LiquidityActivation): LiquidityActivation | undefined {
    if (!rule) {
      return undefined;
    }
    const maxSpread =
      rule.max_spread ??
      (rule.max_spread_cents && rule.max_spread_cents > 0 ? rule.max_spread_cents / 100 : undefined);
    return {
      ...rule,
      max_spread: Number.isFinite(maxSpread as number) ? (maxSpread as number) : rule.max_spread,
    };
  }

  private getEffectiveLiquidityActivation(market: Market): LiquidityActivation | undefined {
    const existing = this.normalizeLiquidityActivation(market.liquidity_activation);
    if (existing) {
      return existing;
    }
    if (!this.config.mmPointsAssumeActive) {
      return undefined;
    }
    const minShares = Math.max(0, this.config.mmPointsMinShares ?? 0);
    const maxSpreadCents = Math.max(0, this.config.mmPointsMaxSpreadCents ?? 0);
    const maxSpreadRaw = Math.max(0, this.config.mmPointsMaxSpread ?? 0);
    const maxSpread = maxSpreadCents > 0 ? maxSpreadCents / 100 : maxSpreadRaw > 0 ? maxSpreadRaw : undefined;
    return {
      active: true,
      min_shares: minShares > 0 ? minShares : undefined,
      max_spread_cents: maxSpreadCents > 0 ? maxSpreadCents : undefined,
      max_spread: maxSpread,
      description: 'fallback-points',
    };
  }

  private getTopDepth(orderbook: Orderbook): { shares: number; usd: number } {
    const levels = Math.max(1, this.config.mmDepthLevels ?? 1);
    const bids = orderbook.bids.slice(0, levels);
    const asks = orderbook.asks.slice(0, levels);
    let shares = 0;
    let usd = 0;
    for (const entry of bids) {
      const s = this.parseShares(entry);
      const p = Number(entry.price);
      if (s > 0 && Number.isFinite(p)) {
        shares += s;
        usd += s * p;
      }
    }
    for (const entry of asks) {
      const s = this.parseShares(entry);
      const p = Number(entry.price);
      if (s > 0 && Number.isFinite(p)) {
        shares += s;
        usd += s * p;
      }
    }
    return { shares, usd };
  }

  private updateMarketMetrics(
    tokenId: string,
    orderbook: Orderbook
  ): {
    volEma: number;
    depthEma: number;
    topDepth: number;
    topDepthUsd: number;
    depthTrend: number;
    depthSpeedBps: number;
    bidDepthSpeedBps: number;
    askDepthSpeedBps: number;
  } {
    const micro = this.calculateMicroPrice(orderbook);
    if (micro && micro > 0) {
      const lastMid = this.lastPrices.get(tokenId);
      const alpha = this.config.mmVolEmaAlpha ?? 0.2;
      if (lastMid && lastMid > 0) {
        const ret = Math.abs(micro - lastMid) / lastMid;
        const prev = this.volatilityEma.get(tokenId) ?? 0;
        const next = prev === 0 ? ret : prev * (1 - alpha) + ret * alpha;
        this.volatilityEma.set(tokenId, next);
      }
    }

    const depth = this.getTopDepth(orderbook);
    const depthAlpha = this.config.mmDepthEmaAlpha ?? 0.2;
    const prevDepth = this.depthEma.get(tokenId) ?? 0;
    const nextDepth = prevDepth === 0 ? depth.shares : prevDepth * (1 - depthAlpha) + depth.shares * depthAlpha;
    this.depthEma.set(tokenId, nextDepth);
    this.lastDepth.set(tokenId, depth.shares);

    const depthTrend = nextDepth > 0 ? depth.shares / nextDepth : 1;
    const speedWindow = Math.max(0, this.config.mmDepthSpeedWindowMs ?? 0);
    let depthSpeedBps = 0;
    let bidSpeedBps = 0;
    let askSpeedBps = 0;
    if (speedWindow > 0) {
      const prevAt = this.prevBestAt.get(tokenId) || 0;
      if (prevAt > 0 && Date.now() - prevAt <= speedWindow) {
        const prevBid = this.prevBestBidSize.get(tokenId) ?? 0;
        const prevAsk = this.prevBestAskSize.get(tokenId) ?? 0;
        const curBid = this.parseShares(orderbook.bids?.[0]);
        const curAsk = this.parseShares(orderbook.asks?.[0]);
        const prevTotal = prevBid + prevAsk;
        const curTotal = curBid + curAsk;
        if (prevTotal > 0 && curTotal > 0) {
          depthSpeedBps = ((prevTotal - curTotal) / prevTotal) * 10000;
        }
        if (prevBid > 0 && curBid > 0) {
          bidSpeedBps = ((prevBid - curBid) / prevBid) * 10000;
        }
        if (prevAsk > 0 && curAsk > 0) {
          askSpeedBps = ((prevAsk - curAsk) / prevAsk) * 10000;
        }
      }
    }

    this.lastDepthSpeedBps.set(tokenId, depthSpeedBps);
    this.lastBidDepthSpeedBps.set(tokenId, bidSpeedBps);
    this.lastAskDepthSpeedBps.set(tokenId, askSpeedBps);

    return {
      volEma: this.volatilityEma.get(tokenId) ?? 0,
      depthEma: nextDepth,
      topDepth: depth.shares,
      topDepthUsd: depth.usd,
      depthTrend,
      depthSpeedBps,
      bidDepthSpeedBps: bidSpeedBps,
      askDepthSpeedBps: askSpeedBps,
    };
  }

  private resolveAdaptiveProfile(volEma: number, depthEma: number, depthTrend: number): 'CALM' | 'NORMAL' | 'VOLATILE' {
    const configured = (this.config.mmAdaptiveProfile || 'AUTO').toUpperCase();
    if (configured === 'CALM' || configured === 'NORMAL' || configured === 'VOLATILE') {
      return configured;
    }
    const overrideLow = this.config.mmVolatilityLowBps ?? 0;
    const overrideHigh = this.config.mmVolatilityHighBps ?? 0;
    const calm = overrideLow > 0 ? overrideLow : this.config.mmVolatilityCalmBps ?? 0.004;
    const volatile = overrideHigh > 0 ? overrideHigh : this.config.mmVolatilityVolatileBps ?? 0.02;
    const hysteresis = this.config.mmProfileVolHysteresisBps ?? 0.002;
    const depthRef = this.config.mmDepthRefShares ?? 200;
    const depthRatio = depthRef > 0 ? depthEma / depthRef : 1;
    const low = this.config.mmProfileLiquidityLow ?? 0.5;
    const high = this.config.mmProfileLiquidityHigh ?? 1.2;
    const trendDrop = this.config.mmDepthTrendDropRatio ?? 0.4;
    if (depthTrend < 1 - trendDrop) return 'VOLATILE';
    if (depthRatio <= low) return 'VOLATILE';
    if (volEma >= volatile + hysteresis) return 'VOLATILE';
    if (volEma <= calm - hysteresis && depthRatio >= high) return 'CALM';
    return 'NORMAL';
  }

  private stabilizeProfile(tokenId: string, desired: 'CALM' | 'NORMAL' | 'VOLATILE'): 'CALM' | 'NORMAL' | 'VOLATILE' {
    const current = this.lastProfile.get(tokenId);
    if (!current) {
      this.lastProfile.set(tokenId, desired);
      this.lastProfileAt.set(tokenId, Date.now());
      return desired;
    }
    if (current === desired) {
      return current;
    }
    const holdMs = this.config.mmProfileHoldMs ?? 15000;
    const lastAt = this.lastProfileAt.get(tokenId) || 0;
    if (Date.now() - lastAt < holdMs) {
      return current;
    }
    this.lastProfile.set(tokenId, desired);
    this.lastProfileAt.set(tokenId, Date.now());
    return desired;
  }

  private applyIceberg(shares: number, ratioOverride?: number): number {
    if (!this.config.mmIcebergEnabled) {
      return shares;
    }
    let ratio = this.config.mmIcebergRatio ?? 0.3;
    if (ratioOverride !== undefined && ratioOverride > 0) {
      ratio = ratioOverride;
    }
    const chunkMax = this.config.mmIcebergMaxChunkShares ?? 15;
    const penalty = this.getIcebergPenalty(this.config.mmIcebergFillPenalty ?? 0.6);
    const next = Math.max(1, Math.floor(shares * Math.max(0.05, ratio) * penalty));
    return Math.min(next, chunkMax);
  }

  private getIcebergPenalty(defaultPenalty: number): number {
    const entry = this.icebergPenalty.get('global');
    if (!entry) {
      return 1;
    }
    const decayMs = this.config.mmIcebergPenaltyDecayMs ?? 60000;
    const elapsed = Date.now() - entry.ts;
    if (elapsed <= 0) {
      return entry.value;
    }
    const recovered = entry.value + (1 - entry.value) * Math.min(1, elapsed / decayMs);
    return this.clamp(recovered, entry.value, 1);
  }

  private recordMmEvent(type: string, message: string, tokenId?: string): void {
    const event = { ts: Date.now(), type, tokenId, message };
    this.mmEventLog.push(event);
    if (this.mmEventLog.length > 200) {
      this.mmEventLog = this.mmEventLog.slice(-200);
    }
  }

  private updateWsEmergencyRecoveryState(): void {
    const now = Date.now();
    const active = this.wsEmergencyRecoveryUntil > now;

    // 超时保护：如果恢复状态超过5分钟，强制退出
    const recoveryMaxMs = 300000; // 默认5分钟
    if (this.wsEmergencyRecoveryActive && this.wsEmergencyGlobalLast > 0) {
      const elapsed = now - this.wsEmergencyGlobalLast;
      if (elapsed > recoveryMaxMs) {
        console.warn(`⚠️  Forcing exit from emergency recovery after ${elapsed}ms`);
        this.wsEmergencyRecoveryUntil = 0;
        this.wsEmergencyRecoveryActive = false;
        this.wsEmergencyRecoveryStage = -1;
        this.recordMmEvent('WS_EMERGENCY_RECOVERY_FORCE_EXIT', `Forced exit after ${elapsed}ms`);
        return;
      }
    }

    if (this.wsEmergencyRecoveryActive && !active) {
      this.recordMmEvent('WS_EMERGENCY_RECOVERY_END', 'Emergency recovery window ended');
      this.wsEmergencyRecoveryStage = -1;
    }
    this.wsEmergencyRecoveryActive = active;
  }

  private isWsEmergencyRecoveryActive(): boolean {
    this.updateWsEmergencyRecoveryState();
    return this.wsEmergencyRecoveryActive;
  }

  private getWsEmergencyRecoveryInfo(): {
    ratio: number;
    stage: number;
    steps: number;
    progress: number;
    singleActive: boolean;
    farLayers: number;
  } {
    const base = this.clamp(this.config.mmWsHealthEmergencyRecoveryRatio ?? 0.7, 0, 1);
    const minRatio = this.clamp(this.config.mmWsHealthEmergencyRecoveryMinRatio ?? 0.2, 0, base);
    const steps = Math.max(1, Math.floor(this.config.mmWsHealthEmergencyRecoverySteps ?? 3));
    const duration = Math.max(0, this.config.mmWsHealthEmergencyRecoveryMs ?? 0);
    if (!this.isWsEmergencyRecoveryActive() || duration <= 0) {
      return { ratio: base, stage: -1, steps, progress: 1, singleActive: false, farLayers: 0 };
    }
    const elapsed = Math.max(0, Date.now() - this.wsEmergencyRecoveryStart);
    const progress = Math.min(1, duration > 0 ? elapsed / duration : 1);
    const stage = Math.min(steps - 1, Math.floor(progress * steps));
    const stepFactor = steps <= 1 ? 0 : 1 - stage / (steps - 1);
    const ratio = Math.max(minRatio, base * stepFactor);
    const exitProgress = this.clamp(this.config.mmWsHealthEmergencyRecoverySingleSideExitProgress ?? 0.7, 0, 1);
    const singleActive = progress <= exitProgress;
    const farMin = Math.max(1, this.config.mmWsHealthEmergencyRecoveryFarLayersMin ?? 1);
    const farMax = Math.max(farMin, this.config.mmWsHealthEmergencyRecoveryFarLayersMax ?? farMin);
    const farStep = Math.max(1, this.config.mmWsHealthEmergencyRecoveryFarLayerStep ?? 1);
    let farLayers = farMin;
    if (this.config.mmWsHealthEmergencyRecoveryLayerConvergeEnabled) {
      farLayers = Math.max(farMin, farMax - stage * farStep);
    } else {
      farLayers = farMax;
    }
    if (stage !== this.wsEmergencyRecoveryStage) {
      this.wsEmergencyRecoveryStage = stage;
      this.recordMmEvent(
        'WS_EMERGENCY_RECOVERY_STAGE',
        `Recovery stage ${stage + 1}/${steps}, ratioFloor=${ratio.toFixed(2)}, far=${farLayers}`
      );
    }
    return { ratio, stage, steps, progress, singleActive, farLayers };
  }

  private applyIcebergPenalty(tokenId: string): void {
    if (!this.config.mmIcebergEnabled) {
      return;
    }
    const penalty = this.config.mmIcebergFillPenalty ?? 0.6;
    this.icebergPenalty.set('global', { value: this.clamp(penalty, 0.2, 1), ts: Date.now() });
  }

  private applySizePenalty(tokenId: string, penalty: number, auto: boolean = false): void {
    const value = this.clamp(penalty, 0.2, 1);
    const current = this.sizePenalty.get(tokenId);
    if (!current) {
      this.sizePenalty.set(tokenId, { value, ts: Date.now(), auto });
      return;
    }
    const next = Math.min(current.value, value);
    this.sizePenalty.set(tokenId, { value: next, ts: Date.now(), auto: current.auto || auto });
  }

  private getSizePenalty(tokenId: string): number {
    const entry = this.sizePenalty.get(tokenId);
    if (!entry) {
      return 1;
    }
    const decayMs = entry.auto
      ? this.config.mmAutoSizeOnFillDecayMs ?? 90000
      : this.config.mmPartialFillPenaltyDecayMs ?? 60000;
    if (!decayMs || decayMs <= 0) {
      return entry.value;
    }
    const elapsed = Date.now() - entry.ts;
    if (elapsed <= 0) {
      return entry.value;
    }
    const recovered = entry.value + (1 - entry.value) * Math.min(1, elapsed / decayMs);
    return this.clamp(recovered, entry.value, 1);
  }

  private applyNearTouchPenalty(tokenId: string, intensity: number = 1): void {
    const base = this.config.mmNearTouchPenaltyBps ?? 0;
    if (!base || base <= 0) {
      return;
    }
    const maxBps = this.config.mmNearTouchPenaltyMaxBps ?? base * 4;
    const current = this.nearTouchPenalty.get(tokenId);
    const scaled = base * this.clamp(intensity, 0.2, 2);
    const next = Math.min((current?.value ?? 0) + scaled, maxBps);
    this.nearTouchPenalty.set(tokenId, { value: next, ts: Date.now() });
  }

  private getNearTouchPenalty(tokenId: string): number {
    const entry = this.nearTouchPenalty.get(tokenId);
    if (!entry) {
      return 0;
    }
    const decayMs = this.config.mmNearTouchPenaltyDecayMs ?? 60000;
    if (!decayMs || decayMs <= 0) {
      return entry.value;
    }
    const elapsed = Date.now() - entry.ts;
    if (elapsed <= 0) {
      return entry.value;
    }
    const decay = Math.exp(-elapsed / decayMs);
    const value = entry.value * decay;
    if (value <= 0.01) {
      this.nearTouchPenalty.delete(tokenId);
      return 0;
    }
    return value;
  }

  private applyFillPenalty(tokenId: string, intensity: number = 1): void {
    const base = this.config.mmFillPenaltyBps ?? 0;
    if (!base || base <= 0) {
      return;
    }
    const maxBps = this.config.mmFillPenaltyMaxBps ?? base * 5;
    const current = this.fillPenalty.get(tokenId);
    const scaled = base * this.clamp(intensity, 0.2, 2);
    const next = Math.min((current?.value ?? 0) + scaled, maxBps);
    this.fillPenalty.set(tokenId, { value: next, ts: Date.now() });
  }

  private getFillPenalty(tokenId: string): number {
    const entry = this.fillPenalty.get(tokenId);
    if (!entry) {
      return 0;
    }
    const decayMs = this.config.mmFillPenaltyDecayMs ?? 90000;
    if (!decayMs || decayMs <= 0) {
      return entry.value;
    }
    const elapsed = Date.now() - entry.ts;
    if (elapsed <= 0) {
      return entry.value;
    }
    const decay = Math.exp(-elapsed / decayMs);
    const value = entry.value * decay;
    if (value <= 0.01) {
      this.fillPenalty.delete(tokenId);
      return 0;
    }
    return value;
  }

  private getNoFillPenalty(tokenId: string): { spreadBps: number; sizeFactor: number; touchBps: number; repriceBps: number; cancelBps: number } {
    const threshold = Math.max(0, this.config.mmNoFillPassiveMs ?? 0);
    if (threshold <= 0) {
      return { spreadBps: 0, sizeFactor: 1, touchBps: 0, repriceBps: 0, cancelBps: 0 };
    }
    const last = this.lastFillAt.get(tokenId);
    if (!last) {
      return { spreadBps: 0, sizeFactor: 1, touchBps: 0, repriceBps: 0, cancelBps: 0 };
    }
    const elapsed = Date.now() - last;
    if (elapsed <= threshold) {
      return { spreadBps: 0, sizeFactor: 1, touchBps: 0, repriceBps: 0, cancelBps: 0 };
    }
    const rampMs = Math.max(1, this.config.mmNoFillRampMs ?? 30000);
    const intensity = this.clamp((elapsed - threshold) / rampMs, 0, 1);
    const base = Math.max(0, this.config.mmNoFillPenaltyBps ?? 0);
    const maxBps = Math.max(base, this.config.mmNoFillPenaltyMaxBps ?? base * 4);
    const spreadBps = base > 0 ? base + (maxBps - base) * intensity : 0;
    const sizePenalty = this.clamp(this.config.mmNoFillSizePenalty ?? 1, 0.2, 1);
    const sizeFactor = 1 - (1 - sizePenalty) * intensity;
    const touchBase = Math.max(0, this.config.mmNoFillTouchBps ?? 0);
    const touchMax = Math.max(touchBase, this.config.mmNoFillTouchMaxBps ?? touchBase * 2);
    const touchBps = touchBase > 0 ? touchBase + (touchMax - touchBase) * intensity : 0;
    const repriceBase = Math.max(0, this.config.mmNoFillRepriceBps ?? 0);
    const repriceMax = Math.max(repriceBase, this.config.mmNoFillRepriceMaxBps ?? repriceBase * 2);
    const repriceBps = repriceBase > 0 ? repriceBase + (repriceMax - repriceBase) * intensity : 0;

    const cancelBase = Math.max(0, this.config.mmNoFillCancelBps ?? 0);
    const cancelMax = Math.max(cancelBase, this.config.mmNoFillCancelMaxBps ?? cancelBase * 2);
    const cancelBps = cancelBase > 0 ? cancelBase + (cancelMax - cancelBase) * intensity : 0;
    return { spreadBps, sizeFactor, touchBps, repriceBps, cancelBps };
  }

  // ==================== 模式参数辅助 ====================
  /**
   * 根据当前交易模式返回不同的参数配置
   * 所有模式相关的数字集中在这里，不散落各处
   */
  private getModeParams(): {
    spreadBudgetRatio: number;    // 盘口价差占 max_spread 的最大比例
    hardMinBuffer: number;        // 每侧缓冲硬性最低值（美分）
    minFrontDepth: number;        // 每侧前方最低深度（股）
    checkDepthBalance: boolean;   // 是否检查深度均衡
    maxVolatility: number;        // 最大波动率
    safetyMargin: number;         // 安全边际（buffer * (1-margin)）
    fillCooldownMs: number;       // 被吃后冷却时间
    blacklistThreshold: number;   // 连续被吃N次进黑名单
    blacklistDurationMs: number;  // 黑名单时长
    fillCountResetMs: number;     // 被吃计数重置窗口
    absoluteMinBufferCents: number; // 离盘口绝对最低距离（美分），不管百分比（档位模式下作为兜底）
    depthDropCancelRatio: number; // 前方深度骤减多少比例就撤单
    dangerousThresholdCents: number; // 离盘口多近视为危险（触发紧急撤单）
    baseBufferBoost: number;      // 新市场基础缓冲加成倍数（预防式）
    quoteLevel: number;           // 挂单档位：激进=3(第3档), 保守=4(第4档)
    tierRetreatCents: number;    // v24: 档位退让距离（美分），避免裸挂在第N档
  } {
    const isAggressive = this.config.mmTradingMode === 'aggressive';
    if (isAggressive) {
      // 激进模式 v21: 更保守的默认值减少被吃概率
      return {
        spreadBudgetRatio: 0.85,          // v28: 从0.20提高到0.85，原值导致几乎所有市场被竞态检测跳过
        hardMinBuffer: 2.5,
        minFrontDepth: this.config.mmMinFrontDepthShares ?? 2000, // 默认2000股：平衡安全性与可挂单性
        checkDepthBalance: false,
        maxVolatility: 0.008,
        safetyMargin: 0.25,
        fillCooldownMs: 14400000,           // 4小时
        blacklistThreshold: 2,
        blacklistDurationMs: 172800000,     // 48小时
        fillCountResetMs: 3600000,
        absoluteMinBufferCents: 3.0,        // v21: 从2.5提高到3.0
        depthDropCancelRatio: 0.08,
        dangerousThresholdCents: 5.0,       // v21: 从4.5提高到5.0
        baseBufferBoost: 1.20,
        quoteLevel: 3,                      // 动态第3档（v17=4太深，v18=3贴近盘口积分更好）
        tierRetreatCents: 1.5,              // v24: 退让1.5c，不裸挂第N档
      };
    }
    // 保守模式 v21: 更保守的默认值减少被吃概率
    return {
      spreadBudgetRatio: 0.80,            // v28: 从0.15提高到0.80，原值(6c*0.15=0.9c)导致所有市场被跳过
      hardMinBuffer: 3.5,
      minFrontDepth: this.config.mmMinFrontDepthShares ?? 2000, // 默认2000股：平衡安全性与可挂单性
      checkDepthBalance: true,
      maxVolatility: 0.005,
      safetyMargin: 0.25,
      fillCooldownMs: 21600000,           // 6小时
      blacklistThreshold: 2,
      blacklistDurationMs: 604800000,     // 7天
      fillCountResetMs: 3600000,
      absoluteMinBufferCents: 3.5,        // v21: 从3.0提高到3.5
      depthDropCancelRatio: 0.05,
      dangerousThresholdCents: 6.0,       // v21: 从5.0提高到6.0
      baseBufferBoost: 1.30,
      quoteLevel: 4,                      // 动态第4档（v17=5太深，v18=4积分更好）
      tierRetreatCents: 1.5,              // v24: 退让1.5c，不裸挂第N档
    };
  }

  /** 统一的保守/激进模式判断 — 消除 isConservative/isConservative2/v23IsConservative 命名不一致 */
  private get isConservative(): boolean {
    return this.config.mmTradingMode !== 'aggressive';
  }

  /** 获取指定 token_id 上自己已挂单的价格集合（用于排除自己的单） */
  private getMyOrderPrices(tokenId: string): Set<number> {
    const prices = new Set<number>();
    for (const [, o] of this.openOrders) {
      if (o.token_id === tokenId) {
        prices.add(Number(o.price));
      }
    }
    return prices;
  }

  /**
   * v27: 统一的 BBO + 距离验证（替代4处重复代码）
   * @returns 被拒绝的价格列表 [{side, label, reason}]
   */
  private validatePriceDistance(
    bid: number, ask: number,
    book: Orderbook, tokenId: string,
    isTierPriced: boolean, label: string
  ): { bid: number; ask: number; rejected: string[] } {
    const rejected: string[] = [];
    let safeBid = bid;
    let safeAsk = ask;

    if (isTierPriced) {
      // v27: tierPriced路径 — 只检查BBO，不检查硬距离
      // 档位定价本身就保证了安全（挂在第N档），不需要额外的距离检查
      if (safeBid > 0 && book.best_bid && safeBid >= book.best_bid) {
        rejected.push(`${label} BID >= BBO`);
        safeBid = 0;
      }
      if (safeAsk > 0 && book.best_ask && safeAsk <= book.best_ask) {
        rejected.push(`${label} ASK <= BBO`);
        safeAsk = 0;
      }
    } else {
      // nonTierPriced路径: 动态绝对距离
      const minDist = this.getDynamicAbsoluteMin(tokenId, book) / 100;
      if (safeBid > 0 && book.best_bid && (book.best_bid - safeBid) < minDist) {
        rejected.push(`${label} BID离盘口${((book.best_bid - safeBid)*100).toFixed(2)}c < ${(minDist*100).toFixed(1)}c`);
        safeBid = 0;
      }
      if (safeAsk > 0 && book.best_ask && (safeAsk - book.best_ask) < minDist) {
        rejected.push(`${label} ASK离盘口${((safeAsk - book.best_ask)*100).toFixed(2)}c < ${(minDist*100).toFixed(1)}c`);
        safeAsk = 0;
      }
    }

    return { bid: safeBid, ask: safeAsk, rejected };
  }

  // ==================== Layer 2: 动态市场筛选 ====================
  /**
   * 评估市场是否安全可挂单
   * 返回 { safe, reason }
   */
  private screenMarket(market: Market, orderbook: Orderbook): { safe: boolean; reason: string } {
    const tokenId = market.token_id;
    const bestBid = orderbook.best_bid;
    const bestAsk = orderbook.best_ask;
    if (!bestBid || !bestAsk) return { safe: false, reason: '无盘口数据' };

    const bookSpreadCents = (bestAsk - bestBid) * 100;
    let liquidityRules = this.getEffectiveLiquidityActivation(market);
    // 客户端已经解析了积分规则，应该从 market.liquidity_activation 拿到数据，作为兑底
    // normalizeLiquidityActivation 可能返回了对象但 max_spread_cents 为 undefined，这种情况也需要兑底
    const hasValidRules = liquidityRules && (liquidityRules.max_spread_cents || liquidityRules.max_spread);
    if (!hasValidRules && market.liquidity_activation) {
      const la = market.liquidity_activation;
      const maxSpreadCentsRaw = la.max_spread_cents || (la.max_spread ? Math.round(la.max_spread * 100) : 0);
      if (maxSpreadCentsRaw > 0) {
        liquidityRules = {
          active: true,
          min_shares: la.min_shares,
          max_spread_cents: maxSpreadCentsRaw,
          max_spread: maxSpreadCentsRaw / 100,
          description: la.description || 'client-parsed',
        };
      }
    }
    // Polymarket 兑底：使用 polymarket 积分规则字段
    if (!liquidityRules && market.venue === 'polymarket' && market.polymarket_rewards_enabled) {
      const pmMaxSpread = market.polymarket_reward_max_spread;
      const pmMinSize = market.polymarket_reward_min_size;
      if (pmMaxSpread && pmMaxSpread > 0) {
        const maxSpreadCentsRaw = pmMaxSpread > 1 ? Math.round(pmMaxSpread) : Math.round(pmMaxSpread * 100);
        if (maxSpreadCentsRaw > 0) {
          liquidityRules = {
            active: true,
            min_shares: pmMinSize && pmMinSize > 0 ? pmMinSize : undefined,
            max_spread_cents: maxSpreadCentsRaw,
            max_spread: maxSpreadCentsRaw / 100,
            description: 'polymarket-rewards',
          };
        }
      }
    }
    const maxSpreadCents = liquidityRules?.max_spread_cents ?? 0;

    // ===== 核心筛选 =====

    // 检查0: 必须有积分规则
    if (!liquidityRules || maxSpreadCents <= 0) {
      return { safe: false, reason: '无积分规则' };
    }

    // 检查0b: 结算时间 — 24小时内即将结算的市场跳过（避免结算前波动+无法撤单风险）
    if (market.end_date) {
      const hoursUntilClose = (new Date(market.end_date).getTime() - Date.now()) / 3600000;
      if (hoursUntilClose <= 24) {
        return { safe: false, reason: `即将结算(${Math.max(0, hoursUntilClose).toFixed(1)}h)` };
      }
    }

    // 检查0c: 市场状态 — 必须至少有一个 outcome 是 OPEN
    const outcomes = market.outcomes || [];
    if (outcomes.length > 0 && !outcomes.some(o => o.status === 'OPEN')) {
      return { safe: false, reason: '市场已关闭' };
    }

    // 检查1: 盘口价差不能超过积分上限（否则无法赚积分）
    if (bookSpreadCents > maxSpreadCents) {
      return { safe: false, reason: `盘口价差超过积分上限(${bookSpreadCents.toFixed(1)}c > ${maxSpreadCents}c)` };
    }

    // 检查2: L1+L2 深度必须充足 — 第1档+第2档深度越大，我们挂第3/4档越安全
    const mode = this.getModeParams();
    const minFrontDepth = mode.minFrontDepth;
    const l1l2Depth = this.sumDepthLevels(orderbook.bids, 2) + this.sumDepthLevels(orderbook.asks, 2);
    if (l1l2Depth < minFrontDepth) {
      return { safe: false, reason: `L1+L2深度不足(${Math.floor(l1l2Depth)} < ${minFrontDepth})` };
    }

    // 通过筛选（具体挂单安全由 calculatePrices 运行时控制）
    return { safe: true, reason: '' };
  }

  // ==================== Layer 3: 吃单概率预测 ====================
  /**
   * 计算当前被吃概率分数 (0-100)
   * 超过阈值 → 不挂单
   */
  private calculateFillRisk(tokenId: string, orderbook: Orderbook, market: Market): number {
    let score = 0;
    const bestBid = orderbook.best_bid ?? 0;
    const bestAsk = orderbook.best_ask ?? 0;
    if (!bestBid || !bestAsk) return 100;

    // 深度因子: 前方深度 < min_shares*3 → 风险高
    const depthW = this.config.mmFillRiskDepthWeight ?? 30;
    const topDepth = this.getTopDepth(orderbook);
    const minShares = market.liquidity_activation?.min_shares ?? 100;
    if (topDepth.shares < minShares * 3) {
      score += depthW * (1 - topDepth.shares / (minShares * 3));
    }

    // 波动率因子
    const volW = this.config.mmFillRiskVolWeight ?? 25;
    const volEma = this.volatilityEma.get(tokenId) ?? 0;
    if (volEma > 0.005) {
      score += volW * Math.min(1, volEma / 0.02);
    }

    // 价差因子: 缓冲越小风险越高
    const spreadW = this.config.mmFillRiskSpreadWeight ?? 15;
    const bookSpreadCents = (bestAsk - bestBid) * 100;
    const maxSpreadCents = market.liquidity_activation?.max_spread_cents ?? 0;
    if (maxSpreadCents > 0) {
      const bufferPerSide = (maxSpreadCents - bookSpreadCents) / 2;
      if (bufferPerSide < 1) {
        score += spreadW * (1 - bufferPerSide);
      }
    }

    // 不平衡因子
    const imbalanceW = this.config.mmFillRiskImbalanceWeight ?? 10;
    const depthMetrics = this.depthMetrics.get(tokenId);
    if (depthMetrics) {
      const imbalance = Math.abs(depthMetrics.imbalance ?? 0);
      if (imbalance > 0.3) {
        score += imbalanceW * (imbalance - 0.3) / 0.7;
      }
    }

    // 近期成交惩罚
    const fillPenalty = this.getFillPenalty(tokenId);
    if (fillPenalty > 0) {
      score += Math.min(20, fillPenalty / 3);
    }

    this.fillRiskScores.set(tokenId, score);
    return Math.min(100, Math.max(0, score));
  }

  // ==================== Layer 4: 位置监控 ====================
  /**
   * 检查自己的挂单位置和前方深度
   * 1. 如果从第2+档变成第1档（前面的人撤了），紧急撤单
   * 2. 如果前方深度骤减 > 30%，也撤单（可能有人大单吃掉前方保护）
   */
  private async monitorMyOrderPosition(market: Market, orderbook: Orderbook): Promise<void> {
    if (!this.config.mmPositionMonitorEnabled) return;
    const tokenId = market.token_id;

    // 获取我当前在该市场的所有挂单
    const myOrders = Array.from(this.openOrders.values())
      .filter(o => o.token_id === tokenId && o.status === 'OPEN');

    if (myOrders.length === 0) return;

    const bestBid = orderbook.best_bid ?? 0;
    const bestAsk = orderbook.best_ask ?? 0;

    // === 检查1: 是否有订单离盘口太近（< dangerousThresholdCents）===
    const mode = this.getModeParams();
    const dangerousThreshold = mode.dangerousThresholdCents / 100;
    for (const order of myOrders) {
      const price = Number(order.price);
      if (order.side === 'BUY' && bestBid > 0 && price >= bestBid - dangerousThreshold) {
        console.log(`🚨 LAYER4: ${tokenId.slice(0, 8)} BUY 离盘口太近(${((bestBid - price) * 100).toFixed(1)}c < ${mode.dangerousThresholdCents}c)! 撤单!`);
        await this.cancelOrdersForMarket(tokenId);
        this.markCooldown(tokenId, this.config.cooldownAfterCancelMs ?? 4000);
        this.recordMmEvent('POSITION_EMERGENCY', `BUY 离盘口太近(${((bestBid - price) * 100).toFixed(1)}c)`, tokenId);
        this.myOrderPosition.set(tokenId, { tier: 1, totalTiers: 1, ts: Date.now() });
        return;
      }
      if (order.side === 'SELL' && bestAsk > 0 && price <= bestAsk + dangerousThreshold) {
        console.log(`🚨 LAYER4: ${tokenId.slice(0, 8)} SELL 离盘口太近(${((price - bestAsk) * 100).toFixed(1)}c < ${mode.dangerousThresholdCents}c)! 撤单!`);
        await this.cancelOrdersForMarket(tokenId);
        this.markCooldown(tokenId, this.config.cooldownAfterCancelMs ?? 4000);
        this.recordMmEvent('POSITION_EMERGENCY', `SELL 离盘口太近(${((price - bestAsk) * 100).toFixed(1)}c)`, tokenId);
        this.myOrderPosition.set(tokenId, { tier: 1, totalTiers: 1, ts: Date.now() });
        return;
      }
    }

    // === 检查2: 前方深度骤减检测 ===
    // 比较当前前方深度与上次记录的深度，减少 > depthDropCancelRatio 就撤
    const levels = Math.max(1, this.config.mmDepthLevels ?? 3);
    const currentBidDepth = this.sumDepthLevels(orderbook.bids, levels);
    const currentAskDepth = this.sumDepthLevels(orderbook.asks, levels);
    const prevPos = this.myOrderPosition.get(tokenId);

    if (prevPos && prevPos.ts > 0) {
      // 用 depthMetrics 缓存的历史深度比较
      const dm = this.depthMetrics.get(tokenId);
      if (dm) {
        const prevTotalDepth = dm.bidDepth + dm.askDepth;
        const currentTotalDepth = currentBidDepth + currentAskDepth;
        if (prevTotalDepth > 0) {
          const depthDrop = 1 - currentTotalDepth / prevTotalDepth;
          if (depthDrop > mode.depthDropCancelRatio) {
            console.log(`⚠️ LAYER4: ${tokenId.slice(0, 8)} 前方深度骤减${(depthDrop * 100).toFixed(0)}%! 撤单!`);
            await this.cancelOrdersForMarket(tokenId);
            this.markCooldown(tokenId, this.config.cooldownAfterCancelMs ?? 4000);
            this.recordMmEvent('DEPTH_VANISH', `深度骤减${(depthDrop * 100).toFixed(0)}%`, tokenId);
            return;
          }
        }
      }
    }

    // 计算实际档位
    let tier = 1;
    const myBid = myOrders.filter(o => o.side === 'BUY').map(o => Number(o.price)).sort((a, b) => b - a)[0];
    if (myBid && bestBid > 0) {
      const bids = orderbook.bids || [];
      for (const level of bids) {
        const levelPrice = Number(level.price);
        if (levelPrice > myBid) tier++;
      }
    }
    this.myOrderPosition.set(tokenId, { tier, totalTiers: tier + 1, ts: Date.now() });
  }

  // ==================== v22: Cancel-on-displacement ====================
  /**
   * 当 orderbook 缓存被更新时（WS推送/刷新），检查我们已有的挂单是否因盘口移动
   * 变成了前2档。如果是，立即撤单（fire-and-forget）。
   * 
   * 关键：这个方法不 await，不阻塞主流程。撤单在后台异步执行。
   */
  private async checkCancelOnDisplacement(tokenId: string, book: Orderbook): Promise<void> {
    if (!book || !book.bids || !book.asks) return;

    // 冷却检查：避免1秒内重复撤单
    const now = Date.now();
    const coolUntil = this.displacementCancelUntil.get(tokenId) ?? 0;
    if (now < coolUntil) return;

    const myOrders = Array.from(this.openOrders.values())
      .filter(o => o.token_id === tokenId && o.status === 'OPEN');
    if (myOrders.length === 0) return;

    const mode = this.getModeParams();
    const minRank = Math.max(2, mode.quoteLevel - 1); // 至少前2档触发撤单
    const bestBid = book.best_bid ?? 0;
    const bestAsk = book.best_ask ?? 0;

    for (const order of myOrders) {
      const price = Number(order.price);

      if (order.side === 'BUY' && bestBid > 0) {
        // 数我们在BID侧排第几（前面有多少档价格更高）
        let rank = 0;
        for (const entry of book.bids) {
          const p = Number(entry?.price || 0);
          if (p > price) rank++;
          else break;
        }
        if (rank < minRank) {
          console.warn(`🚨 v22位移撤单: ${tokenId.slice(0, 8)} BUY $${price.toFixed(4)} 排名第${rank + 1} < ${minRank + 1}，紧急撤单!`);
          await this.cancelOrdersForMarket(tokenId);
          this.displacementCancelUntil.set(tokenId, now + 1000); // 只在撤单调用完成后设冷却（无论成功失败，避免频繁重试）
          return;
        }
      }

      if (order.side === 'SELL' && bestAsk > 0) {
        // 数我们在ASK侧排第几（前面有多少档价格更低）
        let rank = 0;
        for (const entry of book.asks) {
          const p = Number(entry?.price || 0);
          if (p < price) rank++;
          else break;
        }
        if (rank < minRank) {
          console.warn(`🚨 v22位移撤单: ${tokenId.slice(0, 8)} SELL $${price.toFixed(4)} 排名第${rank + 1} < ${minRank + 1}，紧急撤单!`);
          await this.cancelOrdersForMarket(tokenId);
          this.displacementCancelUntil.set(tokenId, now + 1000); // 只在撤单调用完成后设冷却
          return;
        }
      }
    }
  }

  // ==================== Layer 5: 被吃后快速响应 ====================
  /**
   * 记录被吃事件，更新统计，管理黑名单
   * 参数由 getModeParams() 控制：
   *   保守：冷却2h，连续3次黑名单48h
   *   激进：冷却15min，连续5次黑名单4h
   */
  private recordFillEvent(tokenId: string): void {
    const now = Date.now();
    const mode = this.getModeParams();
    let stats = this.fillStats.get(tokenId);
    if (!stats) {
      stats = { count: 0, lastFillAt: 0, blacklistedUntil: 0 };
    }

    // 超过重置窗口则重置计数
    if (now - stats.lastFillAt > mode.fillCountResetMs) {
      stats.count = 0;
    }

    stats.count++;
    stats.lastFillAt = now;

    console.log(`⚡ LAYER5: ${tokenId.slice(0, 8)} 被吃! 第${stats.count}次，冷却${mode.fillCooldownMs / 60000}min`);

    if (stats.count >= mode.blacklistThreshold) {
      stats.blacklistedUntil = now + mode.blacklistDurationMs;
      console.log(`🚫 LAYER5: ${tokenId.slice(0, 8)} 连续被吃${stats.count}次，加入黑名单${mode.blacklistDurationMs / 3600000}h`);
      this.recordMmEvent('FILL_BLACKLIST', `连续被吃${stats.count}次`, tokenId);
    }

    this.fillStats.set(tokenId, stats);
  }

  /**
   * 获取被吃后冷却时间
   * 保守:2h 激进:15min
   */
  private getFillCooldownRemaining(tokenId: string): number {
    const stats = this.fillStats.get(tokenId);
    if (!stats || stats.count === 0) return 0;
    const mode = this.getModeParams();
    const remaining = (stats.lastFillAt + mode.fillCooldownMs) - Date.now();
    return remaining > 0 ? remaining : 0;
  }
  // ==================== Layer 6: 渐进式报价 ====================
  /**
   * 计算渐进式报价的缓冲系数 (0-1)
   * 新进入市场时从保守开始，逐步到达目标位置
   */
  private getProgressiveBufferFactor(tokenId: string, targetBuffer: number): number {
    if (!this.config.mmProgressiveQuoteEnabled) return 1;

    let state = this.progressiveState.get(tokenId);
    const now = Date.now();

    if (!state || Math.abs(state.targetBuffer - targetBuffer) > 0.001) {
      // 新市场或目标变了 → 重置
      state = { step: 0, startedAt: now, targetBuffer };
      this.progressiveState.set(tokenId, state);
    }

    const steps = this.config.mmProgressiveSteps ?? 3;
    const intervalMs = this.config.mmProgressiveIntervalMs ?? 60000;
    const elapsed = now - state.startedAt;
    const currentStep = Math.min(steps, Math.floor(elapsed / intervalMs) + 1);

    // 更新步数
    state.step = currentStep;

    // 线性插值: step 1 → 1/(steps+1) 的缓冲, step N → 1
    const factor = currentStep / (steps + 1);
    return Math.min(1, Math.max(0.2, factor));
  }

  // ==================== Layer 7: 持续优化回路 ====================
  /**
   * 记录积分收入（在积分检查通过后调用）
   */
  private recordPointsEarned(tokenId: string, eligible: boolean): void {
    if (!this.config.mmAdaptiveBufferEnabled) return;
    let buf = this.adaptiveBuffer.get(tokenId);
    if (!buf) {
      buf = { value: 0, pointsEarned: 0, fillsReceived: 0, lastUpdate: Date.now() };
    }
    if (eligible) buf.pointsEarned++;
    this.adaptiveBuffer.set(tokenId, buf);
  }

  /**
   * 定期优化自适应缓冲（在主循环中定期调用）
   * 根据积分/被吃比调整最优缓冲
   */
  private optimizeAdaptiveBuffers(): void {
    if (!this.config.mmAdaptiveBufferEnabled) return;
    const interval = this.config.mmAdaptiveBufferStatsIntervalMs ?? 600000;
    const now = Date.now();

    for (const [tokenId, buf] of this.adaptiveBuffer.entries()) {
      if (now - buf.lastUpdate < interval) continue;

      // 优化逻辑：
      // 如果被吃=0 且有积分 → 可以收窄缓冲（更激进）
      // 如果被吃>0 → 加大缓冲（更保守）
      const fillRate = buf.pointsEarned > 0 ? buf.fillsReceived / buf.pointsEarned : 0;

      if (fillRate === 0 && buf.pointsEarned > 10) {
        // 零被吃率，可以收窄 5%
        buf.value *= 0.95;
        console.log(`📈 LAYER7: ${tokenId.slice(0, 8)} 零被吃率，缓冲收窄至 ${(buf.value * 100).toFixed(2)}c`);
      } else if (fillRate > 0.1) {
        // 被吃率>10%，加大缓冲 20%
        buf.value *= 1.2;
        console.log(`📉 LAYER7: ${tokenId.slice(0, 8)} 被吃率${(fillRate * 100).toFixed(1)}%，缓冲加大至 ${(buf.value * 100).toFixed(2)}c`);
      }

      // 重置统计
      buf.pointsEarned = 0;
      buf.fillsReceived = 0;
      buf.lastUpdate = now;
    }
  }

  /**
   * 获取自适应调整后的缓冲值
   */
  private getAdaptiveBuffer(tokenId: string, baseBuffer: number): number {
    if (!this.config.mmAdaptiveBufferEnabled) return baseBuffer;
    const buf = this.adaptiveBuffer.get(tokenId);
    if (!buf || buf.value === 0) return baseBuffer;
    // 自适应值叠加到 base 上
    return baseBuffer + buf.value;
  }

  // ==================== v11 动态绝对距离 ====================
  /**
   * 根据实时市场状况动态计算 absoluteMinBufferCents
   * 
   * 核心思路：基础值低（积分效率好），但根据市场状况动态加减
   * - 前方深度厚 → 减距离（有足够的保护层）
   * - 波动率低 → 减距离（价格不太会剧烈跳动）
   * - 近期被吃过 → 加距离（市场可能有异常）
   * - 深度骤减 → 加距离（可能有人在吃前面的单）
   * 
   * @returns 实际使用的 absoluteMinBufferCents（美分）
   */
  /**
   * v23: 重新计算价格后的硬距离验证
   * 用新盘口数据重新检查价格是否安全
   */
  /**
   * v27: 重算后验证 — 直接调用 validatePriceDistance，逻辑与其他3处完全一致
   */
  private revalidatePricesAfterRecalc(
    yesBid: number, yesAsk: number, yesBook: Orderbook, isYesTierPriced: boolean, _yesLabel: string, yesTokenId: string,
    noBid: number, noAsk: number, noBook: Orderbook, isNoTierPriced: boolean, _noLabel: string, noTokenId: string
  ): { yesBid: number; yesAsk: number; noBid: number; noAsk: number } | null {
    // YES验证
    const yesResult = this.validatePriceDistance(yesBid, yesAsk, yesBook, yesTokenId, isYesTierPriced, 'v23重算 YES');
    for (const r of yesResult.rejected) console.warn(`🛑 ${r}，拒绝!`);
    // NO验证
    const noResult = this.validatePriceDistance(noBid, noAsk, noBook, noTokenId, isNoTierPriced, 'v23重算 NO');
    for (const r of noResult.rejected) console.warn(`🛑 ${r}，拒绝!`);
    return { yesBid: yesResult.bid, yesAsk: yesResult.ask, noBid: noResult.bid, noAsk: noResult.ask };
  }

  private getDynamicAbsoluteMin(tokenId: string, orderbook: Orderbook): number {
    const mode = this.getModeParams();
    let dist = mode.absoluteMinBufferCents; // 基础值：保守3.5c / 激进3.0c (v21)

    // === 1. 前方深度因子 ===
    // v17 FIX: 只加不减。深度好不代表安全（前方可能突然撤单），但深度差一定要拉远
    const levels = Math.max(1, this.config.mmDepthLevels ?? 3);
    const bidDepth = this.sumDepthLevels(orderbook.bids, levels);
    const askDepth = this.sumDepthLevels(orderbook.asks, levels);
    const avgDepth = (bidDepth + askDepth) / 2;
    const depthRatio = mode.minFrontDepth > 0 ? avgDepth / mode.minFrontDepth : 1;

    // v17: 去掉 depthRatio >= 1.5/2.0/3.0 时缩短距离的逻辑
    // 深度再好也可能突然撤单，距离不能缩短
    if (depthRatio < 0.8) {
      dist += 1.5;  // 深度偏薄 → 加1.5c
    } else if (depthRatio < 1.0) {
      dist += 0.8;  // 深度刚达标 → 加0.8c
    }
    // depthRatio >= 1.0 → 不变，保持基础距离

    // === 2. 波动率因子 ===
    // v17 FIX: 只加不减。低波动不代表安全（可能突然飙高），但高波动一定要拉远
    const volEma = this.volatilityEma.get(tokenId) ?? 0;
    if (volEma > 0.010) {
      dist += 1.5;  // 高波动
    } else if (volEma > 0.007) {
      dist += 0.8;  // 中等波动
    }
    // 低波动不缩短距离

    // === 3. 被吃历史惩罚 ===
    // 近期被吃过 → 市场可能有异常吃单者 → 拉远
    const fillPenalty = this.getFillPenalty(tokenId);
    if (fillPenalty > 0) {
      // fillPenalty 单位是 bps, 每 50bps 加 0.5c
      dist += Math.min(2.0, fillPenalty / 50 * 0.5);
    }

    // === 4. 深度骤减惩罚 ===
    // 前方深度正在快速减少 → 可能有人在吃 → 紧急拉远
    const depthMetrics = this.depthMetrics.get(tokenId);
    if (depthMetrics && depthMetrics.depthSpeedBps < -5) {
      dist += 0.5;  // 深度在快速减少
    }

    // === 最终限制 ===
    // v16: floor提高到75%基础值（50%太小，激进模式会缩到0.75c）
    const floor = mode.absoluteMinBufferCents * 0.75;
    // 最高不超过基础值的 3x（防止过度保守导致不挂单）
    const ceiling = mode.absoluteMinBufferCents * 3.0;
    return Math.max(floor, Math.min(ceiling, dist));
  }

  /**
   * 安全版自适应缓冲 — 预防式 + 只加不缩
   * 新市场：加 baseBufferBoost（保守1.2x）倍基础缓冲
   * 被吃过的市场：根据被吃率额外加大
   * 永远不缩小
   */
  private getSafeAdaptiveBuffer(tokenId: string, baseBuffer: number): number {
    const mode = this.getModeParams();
    if (!this.config.mmAdaptiveBufferEnabled) return baseBuffer * mode.baseBufferBoost;
    const buf = this.adaptiveBuffer.get(tokenId);
    if (!buf) {
      // 新市场，没有历史数据 → 预防式加成
      return baseBuffer * mode.baseBufferBoost;
    }
    // 只在被吃率 > 0 时加大缓冲，永远不缩小
    if (buf.fillsReceived > 0 && buf.pointsEarned > 0) {
      const fillRate = buf.fillsReceived / buf.pointsEarned;
      const extraBuffer = fillRate * baseBuffer * 0.5;
      return baseBuffer * mode.baseBufferBoost + extraBuffer;
    }
    if (buf.fillsReceived > 0) {
      // 有被吃但没积分记录 → 加 50%（比原来30%更保守）
      return baseBuffer * mode.baseBufferBoost * 1.5;
    }
    // 零被吃率 — 仍然有预防式加成
    return baseBuffer * mode.baseBufferBoost;
  }

  private canRecheck(tokenId: string): boolean {
    let cooldown = Math.max(0, this.config.mmRecheckCooldownMs ?? 0);
    const safeMult = this.config.mmSafeModeRecheckMult ?? 1;
    if (safeMult > 0 && safeMult !== 1) {
      const safeActive = this.isSafeModeActive(tokenId, {
        volEma: this.volatilityEma.get(tokenId) ?? 0,
        depthTrend: this.depthTrend.get(tokenId) ?? 0,
        depthSpeedBps: this.lastDepthSpeedBps.get(tokenId) ?? 0,
      });
      if (safeActive) {
        cooldown *= safeMult;
      }
    }
    if (!cooldown) {
      return true;
    }
    const until = this.recheckCooldownUntil.get(tokenId) || 0;
    if (Date.now() < until) {
      return false;
    }
    this.recheckCooldownUntil.set(tokenId, Date.now() + cooldown);
    return true;
  }

  private getWsHealthRatio(): number {
    let ratio = Math.max(0, Math.min(1, 1 - this.wsHealthScore / 100));
    if (this.isWsEmergencyRecoveryActive()) {
      ratio = Math.max(ratio, this.getWsEmergencyRecoveryInfo().ratio);
    }
    return ratio;
  }

  private getWsHealthSpreadMult(): number {
    const maxMult = this.config.mmWsHealthSpreadMultMax ?? 1;
    if (maxMult <= 1) {
      return 1;
    }
    const ratio = this.getWsHealthRatio();
    return 1 + (maxMult - 1) * ratio;
  }

  private getWsHealthSizeMult(): number {
    const minMult = this.config.mmWsHealthSizeMultMin ?? 1;
    if (minMult >= 1) {
      return 1;
    }
    const ratio = this.getWsHealthRatio();
    return 1 - (1 - minMult) * ratio;
  }

  private getWsHealthLayerMult(): number {
    const minMult = this.config.mmWsHealthLayerMultMin ?? 1;
    if (minMult >= 1) {
      return 1;
    }
    const ratio = this.getWsHealthRatio();
    return 1 - (1 - minMult) * ratio;
  }

  private getWsHealthLayerCap(): number {
    const cap = Math.max(0, Math.floor(this.config.mmWsHealthLayerCountCap ?? 0));
    if (this.isWsEmergencyRecoveryActive()) {
      const baseCap = cap > 0 ? cap : Math.max(1, Math.floor(this.config.mmLayerCount ?? 1));
      const minCap = Math.max(1, Math.floor(this.config.mmWsHealthEmergencyRecoveryLayerCapMin ?? 1));
      const info = this.getWsEmergencyRecoveryInfo();
      const progress = Math.max(0, Math.min(1, info.progress));
      const dynamicCap = Math.round(minCap + (baseCap - minCap) * progress);
      return Math.max(1, Math.min(baseCap, dynamicCap));
    }
    if (cap <= 0) {
      return 0;
    }
    return this.getWsHealthRatio() > 0 ? cap : 0;
  }

  private getWsHealthMaxOrdersMult(): number {
    const minMult = this.config.mmWsHealthMaxOrdersMultMin ?? 1;
    let mult = 1;
    if (minMult < 1) {
      const ratio = this.getWsHealthRatio();
      mult = 1 - (1 - minMult) * ratio;
    }
    if (this.isWsEmergencyRecoveryActive()) {
      const recoveryMin = this.config.mmWsHealthEmergencyRecoveryMaxOrdersMultMin ?? 1;
      if (recoveryMin < 1) {
        mult = Math.min(mult, recoveryMin);
      }
    }
    return mult;
  }

  private getWsHealthSoftCancelMult(): number {
    const maxMult = this.config.mmWsHealthSoftCancelMultMax ?? 1;
    if (maxMult <= 1) {
      return 1;
    }
    const ratio = this.getWsHealthRatio();
    return 1 + (maxMult - 1) * ratio;
  }

  private getWsHealthHardCancelMult(): number {
    const maxMult = this.config.mmWsHealthHardCancelMultMax ?? 1;
    if (maxMult <= 1) {
      return 1;
    }
    const ratio = this.getWsHealthRatio();
    return 1 + (maxMult - 1) * ratio;
  }

  private getWsHealthRepriceBufferAddBps(): number {
    const add = Math.max(0, this.config.mmWsHealthRepriceBufferAddBps ?? 0);
    if (add <= 0) {
      return 0;
    }
    const ratio = this.getWsHealthRatio();
    return add * ratio;
  }

  private getWsHealthCancelBufferAddBps(): number {
    const add = Math.max(0, this.config.mmWsHealthCancelBufferAddBps ?? 0);
    if (add <= 0) {
      return 0;
    }
    const ratio = this.getWsHealthRatio();
    return add * ratio;
  }

  private getWsHealthCancelConfirmMult(): number {
    const minMult = this.config.mmWsHealthCancelConfirmMultMin ?? 1;
    let mult = 1;
    if (minMult < 1) {
      const ratio = this.getWsHealthRatio();
      mult = 1 - (1 - minMult) * ratio;
    }
    if (this.isWsEmergencyRecoveryActive()) {
      const recoveryMin = this.config.mmWsHealthEmergencyRecoveryCancelConfirmMultMin ?? 1;
      if (recoveryMin > 1) {
        mult = Math.max(mult, recoveryMin);
      }
    }
    return mult;
  }

  private getWsHealthRepriceConfirmMult(): number {
    const minMult = this.config.mmWsHealthRepriceConfirmMultMin ?? 1;
    let mult = 1;
    if (minMult < 1) {
      const ratio = this.getWsHealthRatio();
      mult = 1 - (1 - minMult) * ratio;
    }
    if (this.isWsEmergencyRecoveryActive()) {
      const recoveryMin = this.config.mmWsHealthEmergencyRecoveryRepriceConfirmMultMin ?? 1;
      if (recoveryMin > 1) {
        mult = Math.max(mult, recoveryMin);
      }
    }
    return mult;
  }

  private isWsUltraSafeActive(): boolean {
    if (this.isWsEmergencyRecoveryActive()) {
      return true;
    }
    if (!this.config.mmWsHealthUltraSafeEnabled) {
      return false;
    }
    return this.getWsHealthRatio() > 0;
  }

  private shouldEmergencyCancel(tokenId: string): boolean {
    if (!this.config.mmWsHealthEmergencyCancelAll) {
      return false;
    }
    if (this.isWsEmergencyRecoveryActive()) {
      return false;
    }
    if (this.getWsHealthRatio() <= 0) {
      return false;
    }
    const intervalMs = Math.max(0, this.config.mmWsHealthEmergencyIntervalMs ?? 0);
    const last = this.wsEmergencyLast.get(tokenId) || 0;
    if (intervalMs > 0 && Date.now() - last < intervalMs) {
      return false;
    }
    this.wsEmergencyLast.set(tokenId, Date.now());
    return true;
  }

  private shouldEmergencyCancelGlobal(): boolean {
    if (!this.config.mmWsHealthEmergencyCancelAll) {
      return false;
    }
    if (this.isWsEmergencyRecoveryActive()) {
      return false;
    }
    if (this.getWsHealthRatio() <= 0) {
      return false;
    }
    const intervalMs = Math.max(0, this.config.mmWsHealthEmergencyIntervalMs ?? 0);
    if (intervalMs > 0 && Date.now() - this.wsEmergencyGlobalLast < intervalMs) {
      return false;
    }
    this.wsEmergencyGlobalLast = Date.now();
    return true;
  }

  private getWsHealthCancelMult(): number {
    const maxMult = this.config.mmWsHealthCancelMultMax ?? 1;
    if (maxMult <= 1) {
      return 1;
    }
    const ratio = this.getWsHealthRatio();
    return 1 + (maxMult - 1) * ratio;
  }

  private getWsHealthRepriceMult(): number {
    const maxMult = this.config.mmWsHealthRepriceMultMax ?? 1;
    if (maxMult <= 1) {
      return 1;
    }
    const ratio = this.getWsHealthRatio();
    return 1 + (maxMult - 1) * ratio;
  }

  private getWsHealthIntervalMult(): number {
    const maxMult = this.config.mmWsHealthMinIntervalMultMax ?? 1;
    if (maxMult <= 1) {
      return this.getWsEmergencyRecoveryIntervalMult();
    }
    const ratio = this.getWsHealthRatio();
    const base = 1 + (maxMult - 1) * ratio;
    return Math.max(base, this.getWsEmergencyRecoveryIntervalMult());
  }

  private getWsEmergencyRecoveryIntervalMult(): number {
    if (!this.isWsEmergencyRecoveryActive()) {
      return 1;
    }
    const maxMult = Math.max(1, this.config.mmWsHealthEmergencyRecoveryIntervalMultMax ?? 1);
    if (maxMult <= 1) {
      return 1;
    }
    const info = this.getWsEmergencyRecoveryInfo();
    const progress = Math.max(0, Math.min(1, info.progress));
    return 1 + (maxMult - 1) * (1 - progress);
  }

  private getWsEmergencyRecoveryCancelIntervalMult(): number {
    if (!this.isWsEmergencyRecoveryActive()) {
      return 1;
    }
    const maxMult = Math.max(1, this.config.mmWsHealthEmergencyRecoveryCancelIntervalMultMax ?? 1);
    if (maxMult <= 1) {
      return 1;
    }
    const info = this.getWsEmergencyRecoveryInfo();
    const progress = Math.max(0, Math.min(1, info.progress));
    return 1 + (maxMult - 1) * (1 - progress);
  }

  private getWsEmergencyRecoveryDepthMult(): number {
    if (!this.isWsEmergencyRecoveryActive()) {
      return 1;
    }
    const maxMult = Math.max(1, this.config.mmWsHealthEmergencyRecoveryDepthMult ?? 1);
    if (maxMult <= 1) {
      return 1;
    }
    const info = this.getWsEmergencyRecoveryInfo();
    const progress = Math.max(0, Math.min(1, info.progress));
    return 1 + (maxMult - 1) * (1 - progress);
  }

  private getWsEmergencyRecoveryVolatilityMult(): number {
    if (!this.isWsEmergencyRecoveryActive()) {
      return 1;
    }
    const minMult = this.clamp(this.config.mmWsHealthEmergencyRecoveryVolatilityMultMin ?? 1, 0.1, 1);
    if (minMult >= 1) {
      return 1;
    }
    const info = this.getWsEmergencyRecoveryInfo();
    const progress = Math.max(0, Math.min(1, info.progress));
    return minMult + (1 - minMult) * progress;
  }

  private shouldForceOnlyFarWs(): boolean {
    if (this.isWsUltraSafeActive()) {
      return true;
    }
    if (!this.config.mmWsHealthForceOnlyFar) {
      return false;
    }
    const ratio = this.getWsHealthRatio();
    return ratio > 0;
  }

  private getWsHealthSizeScale(): number {
    const minScale = this.config.mmWsHealthSizeScaleMin ?? 1;
    const ratio = this.getWsHealthRatio();
    let scale = 1;
    if (minScale < 1) {
      scale = 1 - (1 - minScale) * ratio;
    }
    if (this.isWsUltraSafeActive()) {
      const ultraScale = Math.max(0, Math.min(1, this.config.mmWsHealthUltraSafeSizeScale ?? 0.3));
      const blended = 1 - (1 - ultraScale) * ratio;
      scale = Math.min(scale, blended);
    }
    if (this.isWsEmergencyRecoveryActive()) {
      const minRecoveryScale = this.clamp(this.config.mmWsHealthEmergencyRecoverySizeScaleMin ?? 0.25, 0, 1);
      const info = this.getWsEmergencyRecoveryInfo();
      const progress = Math.max(0, Math.min(1, info.progress));
      const maxScale = minRecoveryScale + (1 - minRecoveryScale) * progress;
      scale = Math.min(scale, maxScale);
    }
    return scale;
  }

  private getWsHealthSingleSide(): {
    side: 'BUY' | 'SELL' | 'NONE';
    mode: 'NORMAL' | 'REMOTE';
    offsetBps: number;
  } {
    let side = (this.config.mmWsHealthSingleSide || 'NONE').toUpperCase() as 'BUY' | 'SELL' | 'NONE';
    let mode = (this.config.mmWsHealthSingleSideMode || 'NORMAL').toUpperCase() as 'NORMAL' | 'REMOTE';
    let offsetBps = Math.max(0, this.config.mmWsHealthSingleSideOffsetBps ?? 0);
    const ratio = this.getWsHealthRatio();
    const recoveryInfo = this.getWsEmergencyRecoveryInfo();
    if (this.isWsEmergencyRecoveryActive() && recoveryInfo.singleActive) {
      const recoverySide = (this.config.mmWsHealthEmergencyRecoverySingleSide || 'NONE').toUpperCase() as
        | 'BUY'
        | 'SELL'
        | 'NONE';
      const recoveryMode = (this.config.mmWsHealthEmergencyRecoverySingleSideMode || 'REMOTE').toUpperCase() as
        | 'NORMAL'
        | 'REMOTE';
      const recoveryOffsetBase = Math.max(0, this.config.mmWsHealthEmergencyRecoverySingleSideOffsetBps ?? 0);
      const recoveryOffsetMin = Math.max(0, this.config.mmWsHealthEmergencyRecoverySingleSideOffsetMinBps ?? 0);
      const volWeight = Math.max(0, this.config.mmWsHealthEmergencyRecoveryOffsetVolWeight ?? 0);
      const volBoost = 1 + Math.max(0, this.getGlobalVolatility()) * volWeight;
      const recoveryOffset =
        recoveryOffsetBase > 0
          ? (recoveryOffsetMin + (recoveryOffsetBase - recoveryOffsetMin) * (1 - recoveryInfo.progress)) * volBoost
          : 0;
      let resolvedSide = recoverySide;
      if (this.config.mmWsHealthEmergencyRecoverySingleSideAuto) {
        const inventoryBias = this.getGlobalInventoryBias();
        const imbalance = this.getGlobalImbalance();
        let threshold = Math.max(0, this.config.mmWsHealthEmergencyRecoverySingleSideImbalanceThreshold ?? 0.15);
        if (this.sessionPnL < 0) {
          const equity = this.getAccountEquityUsd();
          if (equity > 0) {
            const lossRatio = Math.min(1, Math.abs(this.sessionPnL) / equity);
            const lossWeight = this.clamp(this.config.mmWsHealthEmergencyRecoverySingleSideLossWeight ?? 0.5, 0, 1);
            threshold = Math.max(0.02, threshold * (1 - lossRatio * lossWeight));
          }
        }
        const signal = inventoryBias - imbalance;
        if (Math.abs(signal) >= threshold) {
          resolvedSide = signal > 0 ? 'SELL' : 'BUY';
        }
      }
      if (resolvedSide !== 'NONE') {
        side = resolvedSide;
        mode = recoveryMode;
        if (recoveryOffset > 0) {
          offsetBps = recoveryOffset;
        }
      }
    }
    if (this.isWsUltraSafeActive()) {
      const ultraSide = (this.config.mmWsHealthUltraSafeSide || 'NONE').toUpperCase() as 'BUY' | 'SELL' | 'NONE';
      const ultraMode = (this.config.mmWsHealthUltraSafeMode || 'REMOTE').toUpperCase() as 'NORMAL' | 'REMOTE';
      const ultraOffset = Math.max(0, this.config.mmWsHealthUltraSafeOffsetBps ?? 0);
      if (ultraSide !== 'NONE') {
        side = ultraSide;
        mode = ultraMode;
        offsetBps = ultraOffset;
      }
    }
    if (!side || side === 'NONE' || ratio <= 0) {
      return { side: 'NONE', mode, offsetBps };
    }
    return { side, mode, offsetBps };
  }

  private getWsHealthTouchBufferAddBps(): number {
    const add = Math.max(0, this.config.mmWsHealthTouchBufferAddBps ?? 0);
    if (add <= 0) {
      return 0;
    }
    const ratio = this.getWsHealthRatio();
    return add * ratio;
  }

  private shouldSparseWs(): boolean {
    if (!this.config.mmWsHealthSparseOdd) {
      return false;
    }
    return this.getWsHealthRatio() > 0;
  }

  private maybePauseForWsHealth(tokenId: string): void {
    const threshold = this.config.mmWsHealthHardThreshold ?? 0;
    const pauseMs = this.config.mmWsHealthPauseMs ?? 0;
    if (threshold <= 0 || pauseMs <= 0) {
      return;
    }
    if (this.wsHealthScore <= threshold) {
      this.pauseUntil.set(tokenId, Date.now() + pauseMs);
    }
  }

  private updateFillPressure(tokenId: string, shares: number): void {
    if (!Number.isFinite(shares) || shares <= 0) {
      return;
    }
    const windowMs = Math.max(1, this.config.mmFillSlowdownWindowMs ?? 60000);
    const threshold = Math.max(1, this.config.mmPartialFillShares ?? 5);
    const entry = this.fillPressure.get(tokenId);
    const now = Date.now();
    let score = entry?.score ?? 0;
    if (entry) {
      const elapsed = now - entry.ts;
      const decay = Math.exp(-elapsed / windowMs);
      score *= decay;
    }
    score += shares / threshold;
    this.fillPressure.set(tokenId, { score, ts: now });
  }

  private bumpCancelBoost(tokenId: string, intensity: number): void {
    if (this.config.mmDynamicCancelOnFill !== true) {
      return;
    }
    const now = Date.now();
    const current = this.cancelBoost.get(tokenId);
    let value = current?.value ?? 1;
    const boost = Math.max(0, this.config.mmDynamicCancelBoost ?? 0.4);
    value = value + boost * intensity;
    const maxBoost = Math.max(1, this.config.mmDynamicCancelMaxBoost ?? 2);
    this.cancelBoost.set(tokenId, { value: Math.min(maxBoost, value), ts: now });
  }

  private getCancelBoost(tokenId: string): number {
    if (this.config.mmDynamicCancelOnFill !== true) {
      return 1;
    }
    const entry = this.cancelBoost.get(tokenId);
    if (!entry) {
      return 1;
    }
    const decayMs = Math.max(1, this.config.mmDynamicCancelDecayMs ?? 60000);
    const elapsed = Date.now() - entry.ts;
    const decay = Math.exp(-elapsed / decayMs);
    const value = 1 + (entry.value - 1) * decay;
    return Math.max(1, value);
  }

  private getFillSlowdownMultiplier(tokenId: string): number {
    const entry = this.fillPressure.get(tokenId);
    if (!entry) {
      return 1;
    }
    const windowMs = Math.max(1, this.config.mmFillSlowdownWindowMs ?? 60000);
    const elapsed = Date.now() - entry.ts;
    const decay = Math.exp(-elapsed / windowMs);
    const score = entry.score * decay;
    const factor = Math.max(0, this.config.mmFillSlowdownFactor ?? 0.15);
    const maxMult = Math.max(1, this.config.mmFillSlowdownMaxMultiplier ?? 2);
    const multiplier = 1 + score * factor;
    return Math.min(maxMult, Math.max(1, multiplier));
  }

  private getAutoTuneState(tokenId: string): {
    mult: number;
    windowStart: number;
    placed: number;
    canceled: number;
    filled: number;
    lastUpdate: number;
    lastUtility: number;
  } {
    const now = Date.now();
    const existing = this.autoTuneState.get(tokenId);
    if (existing) {
      return existing;
    }
    const state = { mult: 1, windowStart: now, placed: 0, canceled: 0, filled: 0, lastUpdate: now, lastUtility: 0 };
    this.autoTuneState.set(tokenId, state);
    return state;
  }

  private recordAutoTuneEvent(tokenId: string, type: 'PLACED' | 'CANCELED' | 'FILLED'): void {
    if (!this.config.mmAutoTuneEnabled) {
      return;
    }
    const now = Date.now();
    const windowMs = Math.max(1000, this.config.mmAutoTuneWindowMs ?? 60000);
    const state = this.getAutoTuneState(tokenId);
    if (now - state.windowStart > windowMs) {
      state.windowStart = now;
      state.placed = 0;
      state.canceled = 0;
      state.filled = 0;
    }
    if (type === 'PLACED') {
      state.placed += 1;
    } else if (type === 'CANCELED') {
      state.canceled += 1;
    } else {
      state.filled += 1;
    }
    this.updateAutoTuneMultiplier(tokenId, state, now);
  }

  private getAutoTuneUtilitySnapshot(tokenId: string): { utility: number; rewardScore: number; costScore: number } {
    if (this.config.mmVenue !== 'polymarket') {
      return { utility: 0, rewardScore: 0, costScore: 0 };
    }
    const market = this.marketByToken.get(tokenId);
    if (!market) {
      return { utility: 0, rewardScore: 0, costScore: 0 };
    }
    const cfg = this.getPolymarketExecutionSafetyConfig();
    const minNetEfficiency = Math.max(1e-6, Number(this.config.polymarketRewardMinNetEfficiency || 0.0008));
    const rewardScore = this.clamp(Number(market.polymarket_reward_effective_net_efficiency || 0) / minNetEfficiency, 0, 3) * Math.max(0, Number(cfg.autoTuneRewardWeight || 1));
    const fillCost = (Math.max(0, Number(market.polymarket_recent_fill_penalty_bps || 0)) / 10) * Math.max(0, Number(cfg.autoTuneFillCostWeight || 1));
    const cancelCost = (Math.max(0, Number(market.polymarket_recent_cancel_penalty || 0)) + Math.max(0, Number(market.polymarket_recent_lifetime_penalty || 0))) * Math.max(0, Number(cfg.autoTuneCancelCostWeight || 0.75));
    const riskCost = ((Math.max(0, Number(market.polymarket_recent_risk_penalty || 0)) + Math.max(0, Number(market.polymarket_pattern_memory_penalty || 0)) + Math.max(0, Number(market.polymarket_hour_risk_penalty || 0)) + Math.max(0, Number(market.polymarket_market_hour_risk_penalty || 0)) + Math.max(0, Number(market.polymarket_event_risk_penalty || 0))) / 6) * Math.max(0, Number(cfg.autoTuneRiskWeight || 0.6));
    const utility = rewardScore - fillCost - cancelCost - riskCost;
    return { utility, rewardScore, costScore: fillCost + cancelCost + riskCost };
  }

  private updateAutoTuneMultiplier(
    tokenId: string,
    state: { mult: number; placed: number; canceled: number; filled: number; lastUpdate: number; lastUtility: number },
    now: number
  ): void {
    const minEvents = Math.max(1, this.config.mmAutoTuneMinEvents ?? 20);
    const updateMs = Math.max(0, this.config.mmAutoTuneUpdateMs ?? 2000);
    const total = state.placed + state.canceled + state.filled;
    if (total < minEvents || now - state.lastUpdate < updateMs) {
      return;
    }
    const placed = Math.max(1, state.placed);
    const fillRate = state.filled / placed;
    const cancelRate = state.canceled / placed;
    const targetFill = Math.max(0, this.config.mmAutoTuneTargetFillRate ?? 0.02);
    const targetCancel = Math.max(0, this.config.mmAutoTuneTargetCancelRate ?? 0.6);
    const step = Math.max(0, this.config.mmAutoTuneStep ?? 0.05);
    const minMult = Math.max(0.1, this.config.mmAutoTuneMinMult ?? 0.6);
    const maxMult = Math.max(minMult, this.config.mmAutoTuneMaxMult ?? 2.5);
    const utilityTarget = Number(this.config.mmAutoTuneUtilityTarget ?? 0.7);
    const utilityDeadband = Math.max(0, Number(this.config.mmAutoTuneUtilityDeadband ?? 0.15));
    const utilitySnapshot = this.getAutoTuneUtilitySnapshot(tokenId);
    let mult = state.mult ?? 1;
    state.lastUtility = utilitySnapshot.utility;
    if (this.config.mmVenue === 'polymarket') {
      if (utilitySnapshot.utility < utilityTarget - utilityDeadband) {
        mult = Math.min(maxMult, mult + step);
      } else if (utilitySnapshot.utility > utilityTarget + utilityDeadband) {
        mult = Math.max(minMult, mult - step * 0.5);
      } else if (targetFill > 0 && fillRate > targetFill * 1.25) {
        mult = Math.min(maxMult, mult + step * 0.5);
      } else if (targetCancel > 0 && cancelRate > targetCancel && fillRate < targetFill) {
        mult = Math.max(minMult, mult - step * 0.25);
      }
    } else if (targetFill > 0 && fillRate > targetFill) {
      mult = Math.min(maxMult, mult + step);
    } else if (targetFill > 0 && fillRate < targetFill * 0.5 && targetCancel > 0 && cancelRate > targetCancel) {
      mult = Math.max(minMult, mult - step * 0.5);
    }
    state.mult = mult;
    state.lastUpdate = now;
  }

  private getAutoTuneMultiplier(tokenId: string): number {
    if (!this.config.mmAutoTuneEnabled) {
      return 1;
    }
    const state = this.getAutoTuneState(tokenId);
    const panicBoost = this.isLayerPanicActive(tokenId)
      ? Math.max(0, this.config.mmPanicAutoTuneBoost ?? 0)
      : 0;
    return Math.max(0.1, (state.mult || 1) + panicBoost);
  }

  private getAutoTuneSnapshot(tokenId: string): { mult: number; fillRate: number; cancelRate: number; utility: number } {
    const state = this.autoTuneState.get(tokenId);
    if (!state || !this.config.mmAutoTuneEnabled) {
      return { mult: 1, fillRate: 0, cancelRate: 0, utility: 0 };
    }
    const placed = Math.max(1, state.placed);
    return {
      mult: state.mult || 1,
      fillRate: state.filled / placed,
      cancelRate: state.canceled / placed,
      utility: Number.isFinite(state.lastUtility) ? state.lastUtility : 0,
    };
  }

  private getPolymarketLifecycleState(tokenId: string): {
    windowStart: number;
    placed: number;
    canceled: number;
    filled: number;
    cancelLifetimeMsSum: number;
    cancelSamples: number;
    fillLifetimeMsSum: number;
    fillSamples: number;
    lastUpdate: number;
  } {
    const now = Date.now();
    const existing = this.polymarketOrderLifecycleState.get(tokenId);
    if (existing) {
      const windowMs = Math.max(60_000, this.config.polymarketOrderLifecycleWindowMs ?? 6 * 60 * 60 * 1000);
      if (now - existing.windowStart <= windowMs) {
        return existing;
      }
    }
    const state = {
      windowStart: now,
      placed: 0,
      canceled: 0,
      filled: 0,
      cancelLifetimeMsSum: 0,
      cancelSamples: 0,
      fillLifetimeMsSum: 0,
      fillSamples: 0,
      lastUpdate: now,
    };
    this.polymarketOrderLifecycleState.set(tokenId, state);
    return state;
  }

  private recordPolymarketLifecycleEvent(
    tokenId: string,
    type: 'PLACED' | 'CANCELED' | 'FILLED',
    lifetimeMs?: number
  ): void {
    if (this.config.mmVenue !== 'polymarket') {
      return;
    }
    const now = Date.now();
    const state = this.getPolymarketLifecycleState(tokenId);
    const windowMs = Math.max(60_000, this.config.polymarketOrderLifecycleWindowMs ?? 6 * 60 * 60 * 1000);
    if (now - state.windowStart > windowMs) {
      state.windowStart = now;
      state.placed = 0;
      state.canceled = 0;
      state.filled = 0;
      state.cancelLifetimeMsSum = 0;
      state.cancelSamples = 0;
      state.fillLifetimeMsSum = 0;
      state.fillSamples = 0;
    }
    if (type === 'PLACED') {
      state.placed += 1;
    } else if (type === 'CANCELED') {
      state.canceled += 1;
      if (Number.isFinite(lifetimeMs) && (lifetimeMs ?? 0) > 0) {
        state.cancelLifetimeMsSum += Number(lifetimeMs);
        state.cancelSamples += 1;
      }
    } else if (type === 'FILLED') {
      state.filled += 1;
      if (Number.isFinite(lifetimeMs) && (lifetimeMs ?? 0) > 0) {
        state.fillLifetimeMsSum += Number(lifetimeMs);
        state.fillSamples += 1;
      }
    }
    state.lastUpdate = now;
  }

  private getPolymarketLifecycleSnapshot(tokenId: string): {
    placed: number;
    canceled: number;
    filled: number;
    cancelRate: number;
    avgCancelLifetimeMs: number;
    avgFillLifetimeMs: number;
    cancelPenalty: number;
    lifetimePenalty: number;
  } {
    if (this.config.mmVenue !== 'polymarket') {
      return {
        placed: 0,
        canceled: 0,
        filled: 0,
        cancelRate: 0,
        avgCancelLifetimeMs: 0,
        avgFillLifetimeMs: 0,
        cancelPenalty: 0,
        lifetimePenalty: 0,
      };
    }
    const state = this.polymarketOrderLifecycleState.get(tokenId);
    if (!state) {
      return {
        placed: 0,
        canceled: 0,
        filled: 0,
        cancelRate: 0,
        avgCancelLifetimeMs: 0,
        avgFillLifetimeMs: 0,
        cancelPenalty: 0,
        lifetimePenalty: 0,
      };
    }
    const placed = Math.max(1, state.placed);
    const cancelRate = state.canceled / placed;
    const avgCancelLifetimeMs = state.cancelSamples > 0 ? state.cancelLifetimeMsSum / state.cancelSamples : 0;
    const avgFillLifetimeMs = state.fillSamples > 0 ? state.fillLifetimeMsSum / state.fillSamples : 0;

    const cancelPenaltyStart = this.clamp(Number(this.config.polymarketCancelRatePenaltyStart ?? 0.8), 0, 1);
    const cancelPenaltyMax = Math.max(0, Number(this.config.polymarketCancelRatePenaltyMax ?? 6));
    const cancelPenaltyRatio =
      cancelRate <= cancelPenaltyStart ? 0 : this.clamp((cancelRate - cancelPenaltyStart) / Math.max(0.01, 1 - cancelPenaltyStart), 0, 1);
    const cancelPenalty = cancelPenaltyMax * cancelPenaltyRatio;

    const minAvgLifetimeMs = Math.max(1_000, Number(this.config.polymarketMinAvgOrderLifetimeMs ?? 120_000));
    const shortLifetimePenaltyMax = Math.max(0, Number(this.config.polymarketShortLifetimePenaltyMax ?? 5));
    const comparableLifetimeMs = avgCancelLifetimeMs > 0 ? avgCancelLifetimeMs : avgFillLifetimeMs;
    const lifetimePenaltyRatio =
      comparableLifetimeMs <= 0 ? 0 : this.clamp((minAvgLifetimeMs - comparableLifetimeMs) / minAvgLifetimeMs, 0, 1);
    const lifetimePenalty = shortLifetimePenaltyMax * lifetimePenaltyRatio;

    return {
      placed: state.placed,
      canceled: state.canceled,
      filled: state.filled,
      cancelRate,
      avgCancelLifetimeMs,
      avgFillLifetimeMs,
      cancelPenalty,
      lifetimePenalty,
    };
  }

  private getPolymarketPatternMemoryPath(): string | null {
    const target = this.config.mmMetricsPath;
    if (!target) {
      return null;
    }
    const resolved = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
    if (resolved.endsWith('.json')) {
      return resolved.replace(/\.json$/i, '.polymarket-pattern-memory.json');
    }
    return `${resolved}.polymarket-pattern-memory.json`;
  }

  private buildPolymarketPatternMemoryEntry(metric: Record<string, any>): {
    tokenId: string;
    question?: string;
    updatedAt: number;
    penalty: number;
    dominantReason: string;
    dominance: number;
    reasonMix: Record<string, number>;
    learnedRetreatMix: Record<string, number>;
    learnedSizeMix: Record<string, number>;
    learnedRetreat: number;
    learnedSize: number;
    cancelRate: number;
    fillPenaltyBps: number;
    riskThrottleFactor: number;
  } | null {
    const tokenId = String(metric.tokenId || '');
    if (!tokenId) {
      return null;
    }
    const counts = {
      nearTouch: Number(metric.cancelNearTouch || 0),
      refresh: Number(metric.cancelRefresh || 0),
      vwap: Number(metric.cancelVwap || 0),
      aggressive: Number(metric.cancelAggressive || 0),
      unsafe: Number(metric.cancelUnsafe || 0),
      other: Number(metric.cancelOther || 0),
    };
    const total =
      counts.nearTouch + counts.refresh + counts.vwap + counts.aggressive + counts.unsafe + counts.other;
    if (total <= 0) {
      return null;
    }
    const reasonMix = {
      nearTouch: counts.nearTouch / total,
      refresh: counts.refresh / total,
      vwap: counts.vwap / total,
      aggressive: counts.aggressive / total,
      unsafe: counts.unsafe / total,
      other: counts.other / total,
    };
    const dominant = (Object.entries(reasonMix) as Array<[string, number]>).reduce(
      (best, entry) => (entry[1] > best[1] ? entry : best),
      ['other', 0]
    );
    const cancelPenalty = Math.max(0, Number(metric.cancelPenalty || 0));
    const lifetimePenalty = Math.max(0, Number(metric.lifetimePenalty || 0));
    const fillPenaltyBps = Math.max(0, Number(metric.fillPenaltyBps || 0));
    const riskThrottleFactor = this.clamp(Number(metric.riskThrottleFactor || 1), 0.1, 1);
    const retreatSeverity = this.clamp((Math.min(2, cancelPenalty * 0.6 + lifetimePenalty * 0.4)) / 2, 0, 1);
    const sizeSeverity = this.clamp(
      (Math.min(2.5, fillPenaltyBps / 12 + Math.max(0, 1 - riskThrottleFactor) * 4)) / 2.5,
      0,
      1
    );
    const learnedRetreatMix = {
      nearTouch: reasonMix.nearTouch * retreatSeverity,
      refresh: reasonMix.refresh * retreatSeverity * 0.55,
      vwap: reasonMix.vwap * retreatSeverity * 0.8,
      aggressive: reasonMix.aggressive * retreatSeverity * 1.05,
      unsafe: reasonMix.unsafe * retreatSeverity * 1.1,
      other: reasonMix.other * retreatSeverity * 0.4,
    };
    const learnedSizeMix = {
      nearTouch: reasonMix.nearTouch * sizeSeverity * 0.45,
      refresh: reasonMix.refresh * sizeSeverity * 0.3,
      vwap: reasonMix.vwap * sizeSeverity * 0.9,
      aggressive: reasonMix.aggressive * sizeSeverity * 1.1,
      unsafe: reasonMix.unsafe * sizeSeverity * 1.15,
      other: reasonMix.other * sizeSeverity * 0.25,
    };
    const learnedRetreat = this.clamp(
      learnedRetreatMix.nearTouch +
        learnedRetreatMix.refresh +
        learnedRetreatMix.vwap +
        learnedRetreatMix.aggressive +
        learnedRetreatMix.unsafe,
      0,
      1
    );
    const learnedSize = this.clamp(
      learnedSizeMix.nearTouch +
        learnedSizeMix.refresh +
        learnedSizeMix.vwap +
        learnedSizeMix.aggressive +
        learnedSizeMix.unsafe,
      0,
      1
    );
    const penalty = Math.min(
      Math.max(0, Number(this.config.polymarketPatternMemoryMaxPenalty ?? 8)),
      Math.min(5, reasonMix.nearTouch * 2.5 + reasonMix.aggressive * 4 + reasonMix.unsafe * 4.5 + reasonMix.vwap * 1.5 + reasonMix.refresh) +
        Math.min(2, cancelPenalty * 0.6 + lifetimePenalty * 0.4) +
        Math.min(2, fillPenaltyBps / 12) +
        Math.min(1.5, (1 - riskThrottleFactor) * 4)
    );
    return {
      tokenId,
      question: metric.question,
      updatedAt: Number(metric.updatedAt || Date.now()),
      penalty,
      dominantReason: dominant[0],
      dominance: dominant[1],
      reasonMix,
      learnedRetreatMix,
      learnedSizeMix,
      learnedRetreat,
      learnedSize,
      cancelRate: Math.max(0, Number(metric.cancelRate || 0)),
      fillPenaltyBps,
      riskThrottleFactor,
    };
  }

  private async flushPolymarketPatternMemory(marketEntries: Array<Record<string, any>>): Promise<void> {
    if (this.config.mmVenue !== 'polymarket') {
      return;
    }
    const memoryPath = this.getPolymarketPatternMemoryPath();
    if (!memoryPath) {
      return;
    }
    try {
      const now = Date.now();
      const ttlMs = Math.max(60_000, Number(this.config.polymarketPatternMemoryTtlMs ?? 7 * 24 * 60 * 60 * 1000));
      const alpha = this.clamp(Number(this.config.polymarketPatternMemoryAlpha ?? 0.35), 0.01, 1);
      let existing: {
        version?: number;
        ts?: number;
        markets?: Array<{
          tokenId: string;
          question?: string;
          updatedAt: number;
          penalty: number;
          dominantReason: string;
          dominance: number;
          reasonMix?: Record<string, number>;
          learnedRetreatMix?: Record<string, number>;
          learnedSizeMix?: Record<string, number>;
          learnedRetreat?: number;
          learnedSize?: number;
          cancelRate?: number;
          fillPenaltyBps?: number;
          riskThrottleFactor?: number;
        }>;
      } = {};
      try {
        const raw = await fs.readFile(memoryPath, 'utf8');
        existing = JSON.parse(raw);
      } catch {
        existing = {};
      }
      const existingMap = new Map(
        (existing.markets || [])
          .filter((entry) => now - Number(entry.updatedAt || 0) <= ttlMs)
          .map((entry) => [String(entry.tokenId), entry] as const)
      );

      for (const metric of marketEntries) {
        const current = this.buildPolymarketPatternMemoryEntry(metric);
        if (!current) {
          continue;
        }
        const previous = existingMap.get(current.tokenId);
        if (!previous) {
          existingMap.set(current.tokenId, current);
          continue;
        }
        const mergedMix: Record<string, number> = {};
        const mergedRetreatMix: Record<string, number> = {};
        const mergedSizeMix: Record<string, number> = {};
        for (const key of ['nearTouch', 'refresh', 'vwap', 'aggressive', 'unsafe', 'other']) {
          const prevValue = Number(previous.reasonMix?.[key] || 0);
          const currValue = Number(current.reasonMix[key] || 0);
          mergedMix[key] = prevValue * (1 - alpha) + currValue * alpha;
          mergedRetreatMix[key] =
            Number(previous.learnedRetreatMix?.[key] || 0) * (1 - alpha) +
            Number(current.learnedRetreatMix[key] || 0) * alpha;
          mergedSizeMix[key] =
            Number(previous.learnedSizeMix?.[key] || 0) * (1 - alpha) +
            Number(current.learnedSizeMix[key] || 0) * alpha;
        }
        const dominant = (Object.entries(mergedMix) as Array<[string, number]>).reduce(
          (best, entry) => (entry[1] > best[1] ? entry : best),
          ['other', 0]
        );
        existingMap.set(current.tokenId, {
          tokenId: current.tokenId,
          question: current.question || previous.question,
          updatedAt: now,
          penalty: Number(previous.penalty || 0) * (1 - alpha) + current.penalty * alpha,
          dominantReason: dominant[0],
          dominance: dominant[1],
          reasonMix: mergedMix,
          learnedRetreatMix: mergedRetreatMix,
          learnedSizeMix: mergedSizeMix,
          learnedRetreat:
            Number(previous.learnedRetreat || 0) * (1 - alpha) + Number(current.learnedRetreat || 0) * alpha,
          learnedSize: Number(previous.learnedSize || 0) * (1 - alpha) + Number(current.learnedSize || 0) * alpha,
          cancelRate: Number(previous.cancelRate || 0) * (1 - alpha) + current.cancelRate * alpha,
          fillPenaltyBps: Number(previous.fillPenaltyBps || 0) * (1 - alpha) + current.fillPenaltyBps * alpha,
          riskThrottleFactor:
            Number(previous.riskThrottleFactor || 1) * (1 - alpha) + current.riskThrottleFactor * alpha,
        });
      }

      const payload = {
        version: 1,
        ts: now,
        markets: Array.from(existingMap.values()).sort((a, b) => Number(b.penalty || 0) - Number(a.penalty || 0)),
      };
      await fs.mkdir(path.dirname(memoryPath), { recursive: true });
      const tmp = `${memoryPath}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
      await fs.rename(tmp, memoryPath);
    } catch (error) {
      console.warn('Polymarket pattern memory flush failed:', error);
    }
  }

  private async flushMmMetrics(): Promise<void> {
    const target = this.config.mmMetricsPath;
    const interval = this.config.mmMetricsFlushMs ?? 0;
    if (!target || !interval) {
      return;
    }
    const now = Date.now();
    if (now - this.mmLastFlushAt < interval) {
      return;
    }
    this.mmLastFlushAt = now;
    try {
      const wsHealth = this.getWsHealthSnapshot();
      const payload = {
        version: 1,
        ts: now,
        tradingHalted: this.tradingHalted,
        sessionPnL: this.sessionPnL,
        openOrders: this.openOrders.size,
        positions: this.positions.size,
        wsHealth,
        events: this.mmEventLog.slice(-200),
        markets: Array.from(this.mmMetrics.values()),
      };
      const resolved = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      const tmp = `${resolved}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
      await fs.rename(tmp, resolved);
      await this.flushPolymarketPatternMemory(payload.markets as Array<Record<string, any>>);
    } catch (error) {
      console.warn('MM metrics flush failed:', error);
    }
  }

  private recordMmMetrics(
    market: Market,
    orderbook: Orderbook,
    prices: QuotePrices,
    profile: 'CALM' | 'NORMAL' | 'VOLATILE',
    metrics: {
      volEma: number;
      depthEma: number;
      topDepth: number;
      topDepthUsd: number;
      depthTrend: number;
      depthSpeedBps: number;
      bidDepthSpeedBps: number;
      askDepthSpeedBps: number;
    }
  ): void {
    const imbalance = this.calculateOrderbookImbalance(orderbook);
    const wsHealth = this.getWsHealthSnapshot();
    const wsSingle = this.getWsHealthSingleSide();
    const wsSparse = this.shouldSparseWs();
    const riskLocal = this.getRiskThrottleFactor(market.token_id);
    const riskGlobal = this.getRiskThrottleFactor('__global__');
    const riskThrottle = Math.min(riskLocal, riskGlobal);
    const lifecycle = this.getPolymarketLifecycleSnapshot(market.token_id);
    const cancelReasons = this.getPolymarketCancelReasonSnapshot(market.token_id);
    const stateEntry = this.polymarketExecutionState.get(market.token_id);
    const riskOnlyFarThreshold = Math.max(0, this.config.mmRiskThrottleOnlyFarThreshold ?? 0);
    const riskOnlyFarActive = riskOnlyFarThreshold > 0 && riskThrottle <= riskOnlyFarThreshold;
    const burstEntry = this.cancelBurst.get(market.token_id);
    const burstCooldownMs = burstEntry?.cooldownUntil ? Math.max(0, burstEntry.cooldownUntil - Date.now()) : 0;
    const entry = {
      tokenId: market.token_id,
      question: market.question?.slice(0, 80),
      profile,
      spread: prices.spread,
      bid: prices.bidPrice,
      ask: prices.askPrice,
      volEma: metrics.volEma,
      depthEma: metrics.depthEma,
      depthTrend: metrics.depthTrend,
      depthSpeedBps: metrics.depthSpeedBps,
      bidDepthSpeedBps: metrics.bidDepthSpeedBps,
      askDepthSpeedBps: metrics.askDepthSpeedBps,
      topDepth: metrics.topDepth,
      topDepthUsd: metrics.topDepthUsd,
      protectiveActive: this.isProtectiveActive(market.token_id),
      imbalance,
      pressure: prices.pressure,
      inventoryBias: prices.inventoryBias,
      nearTouchPenaltyBps: this.getNearTouchPenalty(market.token_id),
      fillPenaltyBps: this.getFillPenalty(market.token_id),
      placed: lifecycle.placed,
      canceled: lifecycle.canceled,
      filled: lifecycle.filled,
      cancelRate: lifecycle.cancelRate,
      avgCancelLifetimeMs: lifecycle.avgCancelLifetimeMs,
      avgFillLifetimeMs: lifecycle.avgFillLifetimeMs,
      cancelPenalty: lifecycle.cancelPenalty,
      lifetimePenalty: lifecycle.lifetimePenalty,
      cancelNearTouch: cancelReasons.nearTouch,
      cancelRefresh: cancelReasons.refresh,
      cancelVwap: cancelReasons.vwap,
      cancelAggressive: cancelReasons.aggressive,
      cancelUnsafe: cancelReasons.unsafe,
      cancelOther: cancelReasons.other,
      cancelReasonTotal: cancelReasons.total,
      polymarketState: stateEntry?.state,
      polymarketStateReason: stateEntry?.reason,
      polymarketStateSince: stateEntry?.since,
      rewardQueueTargetHours: market.polymarket_reward_queue_target_hours,
      rewardQueueTargetFactor: market.polymarket_reward_queue_target_factor,
      rewardQueueTargetPenalty: market.polymarket_reward_queue_target_penalty,
      rewardQueueTargetReason: market.polymarket_reward_queue_target_reason,
      noFillPenaltyBps: this.getNoFillPenalty(market.token_id).spreadBps,
      autoTune: this.getAutoTuneSnapshot(market.token_id),
      wsHealthScore: wsHealth.score,
      wsSpreadMult: wsHealth.spreadMult,
      wsSizeMult: wsHealth.sizeMult,
      wsLayerMult: wsHealth.layerMult,
      wsOnlyFar: this.shouldForceOnlyFarWs(),
      wsIntervalMult: this.getWsHealthIntervalMult(),
      wsSizeScale: this.getWsHealthSizeScale(),
      wsSingleSide: wsSingle.side,
      wsSingleMode: wsSingle.mode,
      wsTouchBufferAddBps: this.getWsHealthTouchBufferAddBps(),
      wsSparseOdd: this.shouldSparseWs(),
      wsLayerCap: this.getWsHealthLayerCap(),
      wsMaxOrdersMult: this.getWsHealthMaxOrdersMult(),
      wsSoftCancelMult: this.getWsHealthSoftCancelMult(),
      wsHardCancelMult: this.getWsHealthHardCancelMult(),
      wsRepriceBufferAddBps: this.getWsHealthRepriceBufferAddBps(),
      wsCancelBufferAddBps: this.getWsHealthCancelBufferAddBps(),
      wsForceSafe: this.config.mmWsHealthForceSafeMode === true,
      wsCancelConfirmMult: this.getWsHealthCancelConfirmMult(),
      wsRepriceConfirmMult: this.getWsHealthRepriceConfirmMult(),
      wsDisableHedge: this.config.mmWsHealthDisableHedge === true,
      wsReadOnly: this.config.mmWsHealthReadOnly === true,
      wsUltraSafe: this.isWsUltraSafeActive(),
      wsEmergencyCancel: this.config.mmWsHealthEmergencyCancelAll === true,
      wsEmergencyActive: this.wsEmergencyGlobalUntil > Date.now(),
      wsEmergencyRecovery: this.isWsEmergencyRecoveryActive(),
      wsEmergencyRecoveryStage: wsHealth.wsEmergencyRecoveryStage,
      wsEmergencyRecoverySteps: wsHealth.wsEmergencyRecoverySteps,
      wsEmergencyRecoveryRatio: wsHealth.wsEmergencyRecoveryRatio,
      wsEmergencyRecoveryIntervalMult: wsHealth.wsEmergencyRecoveryIntervalMult,
      wsEmergencyRecoveryProgress: wsHealth.wsEmergencyRecoveryProgress,
      wsEmergencyRecoverySingleActive: wsHealth.wsEmergencyRecoverySingleActive,
      wsEmergencyRecoveryDepthMult: wsHealth.wsEmergencyRecoveryDepthMult,
      wsEmergencyRecoveryVolatilityMult: wsHealth.wsEmergencyRecoveryVolatilityMult,
      wsEmergencyRecoverySpreadAdd: wsHealth.wsEmergencyRecoverySpreadAdd,
      wsEmergencyRecoveryIcebergRatio: wsHealth.wsEmergencyRecoveryIcebergRatio,
      wsEmergencyRecoveryCancelConfirmMult: wsHealth.wsEmergencyRecoveryCancelConfirmMult,
      wsEmergencyRecoveryMaxOrdersMult: wsHealth.wsEmergencyRecoveryMaxOrdersMult,
      wsEmergencyRecoveryRepriceConfirmMult: wsHealth.wsEmergencyRecoveryRepriceConfirmMult,
      wsEmergencyRecoveryMaxNotionalMult: wsHealth.wsEmergencyRecoveryMaxNotionalMult,
      wsEmergencyRecoveryFarLayersMin: wsHealth.wsEmergencyRecoveryFarLayersMin,
      wsEmergencyRecoveryFarLayersMax: wsHealth.wsEmergencyRecoveryFarLayersMax,
      wsEmergencyRecoveryFarLayerStep: wsHealth.wsEmergencyRecoveryFarLayerStep,
      wsEmergencyRecoveryCancelIntervalMult: wsHealth.wsEmergencyRecoveryCancelIntervalMult,
      wsEmergencyRecoverySingleOffsetBps: wsHealth.wsEmergencyRecoverySingleOffsetBps,
      wsEmergencyRecoveryTemplate: wsHealth.wsEmergencyRecoveryTemplate,
      wsEmergencyRecoveryAuto: wsHealth.wsEmergencyRecoveryAuto,
      wsEmergencyRecoveryImbalanceThreshold: wsHealth.wsEmergencyRecoveryImbalanceThreshold,
      wsEmergencyRecoveryMinIntervalMs: wsHealth.wsEmergencyRecoveryMinIntervalMs,
      wsEmergencyRecoveryOffsetVolWeight: wsHealth.wsEmergencyRecoveryOffsetVolWeight,
      wsEmergencyRecoveryTemplateReset: wsHealth.wsEmergencyRecoveryTemplateReset,
      wsEmergencyRecoverySingleSideLossWeight: wsHealth.wsEmergencyRecoverySingleSideLossWeight,
      riskThrottleFactor: riskThrottle,
      riskOnlyFarActive,
      cancelBurstActive: this.isCancelBurstActive(market.token_id),
      cancelBurstCount: burstEntry?.count ?? 0,
      cancelBurstCooldownMs: burstCooldownMs,
      wsHealthAt: wsHealth.updatedAt,
      // 积分统计
      marketId: market.token_id || '',
      minShares: market.liquidity_activation?.min_shares || 0,
      maxSpread: market.liquidity_activation?.max_spread || 0,
      pointsActive: pointsManager.isPointsActive(market),
      eligibleOrders: pointsManager.getMarketStats(market.token_id || '')?.eligibleOrders || 0,
      totalOrders: pointsManager.getMarketStats(market.token_id || '')?.totalOrders || 0,
      updatedAt: Date.now(),
    };
    this.mmMetrics.set(market.token_id, entry);
    void this.flushMmMetrics();
  }

  private canRequoteIceberg(tokenId: string, depthTrend: number): boolean {
    const base = this.config.mmIcebergRequoteMs ?? 4000;
    const volMult = this.getVolatilityMultiplier(tokenId, this.config.mmIcebergRequoteVolMultiplier ?? 1.2);
    const depthMult = depthTrend < 1 ? 1 + (1 - depthTrend) * (this.config.mmIcebergRequoteDepthMultiplier ?? 1.0) : 1;
    const interval = Math.round(base * volMult * depthMult);
    const last = this.lastIcebergAt.get(tokenId) || 0;
    if (Date.now() - last >= interval) {
      this.lastIcebergAt.set(tokenId, Date.now());
      return true;
    }
    return false;
  }

  private buildLayerTargets(basePrice: number, side: 'BUY' | 'SELL', count: number, stepBps: number): number[] {
    const safeCount = Math.max(1, Math.floor(count || 1));
    const safeStepBps = Math.max(0, stepBps || 0);
    if (count <= 1 || stepBps <= 0) {
      return [basePrice];
    }
    const step = safeStepBps / 10000;
    const targets: number[] = [];
    let last = basePrice;
    for (let i = 0; i < safeCount; i += 1) {
      let price =
        side === 'BUY'
          ? basePrice * (1 - step * i)
          : basePrice * (1 + step * i);
      price = this.clamp(price, 0.01, 0.99);
      if (i > 0) {
        if (side === 'BUY' && price >= last) {
          price = Math.max(0.01, last - MarketMaker.MIN_TICK);
        }
        if (side === 'SELL' && price <= last) {
          price = Math.min(0.99, last + MarketMaker.MIN_TICK);
        }
      }
      targets.push(price);
      last = price;
    }
    return targets;
  }

  private buildLayerSizes(
    baseShares: number,
    minShares: number,
    allowBelowMin: boolean,
    count: number,
    minFactor: number
  ): number[] {
    const safeCount = Math.max(1, Math.floor(count || 1));
    const decay = this.clamp(this.config.mmLayerSizeDecay ?? 0.6, 0.1, 1);
    const floor = this.clamp(minFactor || 1, 0.05, 1);
    const sizes: number[] = [];
    for (let i = 0; i < safeCount; i += 1) {
      const scaled = i === 0 ? baseShares : baseShares * Math.pow(decay, i);
      let size = Math.max(1, Math.floor(scaled * floor));

      // 修复：第一层优先满足 min_shares，后续层可以为 0
      if (minShares > 0 && size < minShares && !allowBelowMin) {
        if (i === 0) {
          // 第一层：尽量满足 min_shares 以获得积分
          size = minShares;
        } else {
          // 后续层：可以为 0
          size = 0;
        }
      }

      sizes.push(size);
    }
    return sizes;
  }

  private applyLayerPanic(tokenId: string): void {
    const holdMs = Math.max(0, this.config.mmLayerPanicHoldMs ?? 0);
    if (!holdMs) {
      return;
    }
    const now = Date.now();
    const until = now + holdMs;
    const current = this.layerPanicUntil.get(tokenId) || 0;
    this.layerPanicUntil.set(tokenId, Math.max(current, until));
    const restoreHold = Math.max(0, this.config.mmPanicRestoreHoldMs ?? 0);
    const restoreCount = Math.max(0, this.config.mmPanicRestoreCount ?? 0);
    if (restoreHold > 0 && restoreCount > 0) {
      this.layerRestoreAt.set(tokenId, now + restoreHold);
      this.layerRestoreStartAt.set(tokenId, now);
      if (this.config.mmPanicCleanupOnRestore) {
        this.layerRestoreExitPending.set(tokenId, true);
      }
    }
  }

  private isLayerPanicActive(tokenId: string): boolean {
    const until = this.layerPanicUntil.get(tokenId) || 0;
    return until > Date.now();
  }

  private isSafeModeActive(
    tokenId: string,
    metrics: { volEma: number; depthTrend: number; depthSpeedBps: number }
  ): boolean {
    if (!this.config.mmSafeModeEnabled && !this.config.mmWsHealthForceSafeMode) {
      return false;
    }
    if (this.config.mmWsHealthForceSafeMode && this.getWsHealthRatio() > 0) {
      return true;
    }
    const now = Date.now();
    const holdUntil = this.safeModeExitUntil.get(tokenId) || 0;
    if (holdUntil > now) {
      return true;
    }
    const volThreshold = Math.max(0, this.config.mmSafeModeVolBps ?? 0);
    const depthThreshold = this.config.mmSafeModeDepthTrend ?? 0;
    const depthSpeedThreshold = Math.max(0, this.config.mmSafeModeDepthSpeedBps ?? 0);
    const volTrigger = volThreshold > 0 && metrics.volEma >= volThreshold;
    const depthTrigger = depthThreshold > 0 && metrics.depthTrend <= depthThreshold;
    const depthSpeedTrigger = depthSpeedThreshold > 0 && metrics.depthSpeedBps >= depthSpeedThreshold;
    const active = volTrigger || depthTrigger || depthSpeedTrigger;
    if (!active && holdUntil) {
      this.safeModeExitUntil.delete(tokenId);
    }
    return active;
  }

  private applyLayerRetreatFor(tokenId: string, holdMs: number): void {
    const duration = Math.max(0, holdMs);
    if (!duration) {
      return;
    }
    const now = Date.now();
    const until = now + duration;
    const current = this.layerRetreatUntil.get(tokenId) || 0;
    this.layerRetreatUntil.set(tokenId, Math.max(current, until));
    this.layerRestoreAt.delete(tokenId);
    this.layerRestoreStartAt.delete(tokenId);
  }

  private applyLayerRetreat(tokenId: string): void {
    const holdMs = Math.max(0, this.config.mmLayerRetreatHoldMs ?? 0);
    this.applyLayerRetreatFor(tokenId, holdMs);
  }

  private isLayerRetreatActive(tokenId: string): boolean {
    const until = this.layerRetreatUntil.get(tokenId) || 0;
    return until > Date.now();
  }

  private isLayerRestoreActive(tokenId: string): boolean {
    const until = this.layerRestoreAt.get(tokenId) || 0;
    if (until > Date.now()) {
      return true;
    }
    if (until > 0) {
      this.layerRestoreAt.delete(tokenId);
      this.layerRestoreStartAt.delete(tokenId);
      const now = Date.now();
      const exitRampMs = Math.max(0, this.config.mmRestoreExitRampMs ?? 0);
      if (exitRampMs > 0) {
        this.layerRestoreExitRampStartAt.set(tokenId, now);
        this.layerRestoreExitRampUntil.set(tokenId, now + exitRampMs);
      } else {
        this.layerRestoreExitRampStartAt.delete(tokenId);
        this.layerRestoreExitRampUntil.delete(tokenId);
      }
      const exitSizeRampMs = Math.max(0, this.config.mmRestoreExitSizeRampMs ?? 0);
      if (exitSizeRampMs > 0) {
        this.layerRestoreExitSizeRampStartAt.set(tokenId, now);
        this.layerRestoreExitSizeRampUntil.set(tokenId, now + exitSizeRampMs);
      } else {
        this.layerRestoreExitSizeRampStartAt.delete(tokenId);
        this.layerRestoreExitSizeRampUntil.delete(tokenId);
      }
      if (this.config.mmRestoreExitForceReprice) {
        this.layerRestoreExitRepricePending.add(tokenId);
      }
      if (this.config.mmLayerRestoreExitCleanup) {
        this.layerRestoreExitPending.set(tokenId, true);
      }
    }
    return false;
  }

  private shouldForceSingleLayer(tokenId: string): boolean {
    if (this.config.mmLayerRetreatForceSingle === true && this.isLayerRetreatActive(tokenId)) {
      return true;
    }
    if (this.isProtectiveActive(tokenId) && this.getProtectiveConfig().forceSingle) {
      return true;
    }
    return false;
  }

  private getEffectiveLayerCount(
    tokenId: string,
    profile: 'CALM' | 'NORMAL' | 'VOLATILE',
    depthTrend: number,
    depthSpeedBps: number
  ): number {
    const base = Math.max(1, Math.floor(this.config.mmLayerCount ?? 1));
    const minCount = Math.max(1, Math.floor(this.config.mmLayerMinCount ?? 1));
    let effective = base;
    if (profile === 'VOLATILE') {
      const cap = Math.max(0, Math.floor(this.config.mmLayerVolatileCount ?? 0));
      if (cap > 0) {
        effective = Math.min(effective, cap);
      }
    }
    const depthDrop = Math.max(0, this.config.mmLayerDepthTrendDrop ?? 0);
    if (depthDrop > 0 && depthTrend < -depthDrop) {
      const cap = Math.max(0, Math.floor(this.config.mmLayerThinCount ?? 0));
      if (cap > 0) {
        effective = Math.min(effective, cap);
      }
    }
    if (this.isLayerPanicActive(tokenId)) {
      const cap = Math.max(0, Math.floor(this.config.mmLayerPanicCount ?? 0));
      if (cap > 0) {
        effective = Math.min(effective, cap);
      }
    }
    const speedThreshold = Math.max(0, this.config.mmLayerDepthSpeedBps ?? 0);
    if (speedThreshold > 0 && depthSpeedBps >= speedThreshold) {
      const cap = Math.max(0, Math.floor(this.config.mmLayerSpeedCount ?? 0));
      if (cap > 0) {
        effective = Math.min(effective, cap);
      }
    }
    const retreatThreshold = Math.max(0, this.config.mmLayerDepthSpeedRetreatBps ?? 0);
    if (retreatThreshold > 0 && depthSpeedBps >= retreatThreshold) {
      const cap = Math.max(0, Math.floor(this.config.mmLayerRetreatCount ?? 0));
      this.applyLayerRetreat(tokenId);
      if (this.config.mmLayerRetreatOnlyFar) {
        this.actionLockUntil.set(tokenId, Date.now() + Math.max(0, this.config.mmLayerRetreatHoldMs ?? 0));
      }
      if (cap > 0) {
        effective = Math.min(effective, cap);
      }
    }
    if (this.isLayerRetreatActive(tokenId)) {
      const cap = Math.max(0, Math.floor(this.config.mmLayerRetreatCount ?? 0));
      if (cap > 0) {
        effective = Math.min(effective, cap);
      }
    } else if (this.config.mmLayerRestoreHoldMs && this.config.mmLayerRestoreCount) {
      const holdMs = Math.max(0, this.config.mmLayerRestoreHoldMs ?? 0);
      const now = Date.now();
      if (holdMs > 0) {
        const restoreUntil = this.layerRestoreAt.get(tokenId) || 0;
        if (!restoreUntil || restoreUntil <= now) {
          this.layerRestoreAt.set(tokenId, now + holdMs);
          this.layerRestoreStartAt.set(tokenId, now);
        }
      }
    }
    if (this.isLayerRestoreActive(tokenId)) {
      const cap = Math.max(0, Math.floor(this.getRestoreLayerCount(tokenId)));
      if (cap > 0) {
        effective = Math.min(effective, cap);
      }
      const hardCap = Math.max(0, Math.floor(this.config.mmRestoreLayerCountCap ?? 0));
      const panicCap = Math.max(0, Math.floor(this.config.mmPanicRestoreLayerCountCap ?? 0));
      const appliedCap = this.isLayerPanicActive(tokenId) && panicCap > 0 ? panicCap : hardCap;
      if (appliedCap > 0) {
        effective = Math.min(effective, appliedCap);
      }
    }
    const safeModeActive = this.isSafeModeActive(tokenId, {
      volEma: this.volatilityEma.get(tokenId) ?? 0,
      depthTrend,
      depthSpeedBps,
    });
    if (safeModeActive) {
      const cap = Math.max(0, Math.floor(this.config.mmSafeModeLayerCountCap ?? 0));
      if (cap > 0) {
        effective = Math.min(effective, cap);
      }
    }
    if (this.isProtectiveActive(tokenId)) {
      const cap = Math.max(0, Math.floor(this.getProtectiveConfig().layerCountCap));
      if (cap > 0) {
        effective = Math.min(effective, cap);
      }
    }
    const wsCap = this.getWsHealthLayerCap();
    if (wsCap > 0) {
      effective = Math.min(effective, wsCap);
    }
    const wsLayerMult = this.getWsHealthLayerMult();
    if (wsLayerMult > 0 && wsLayerMult !== 1) {
      effective = Math.max(1, Math.floor(effective * wsLayerMult));
    }
    const riskLayerCap = Math.max(0, Math.floor(this.config.mmRiskThrottleLayerCap ?? 0));
    if (riskLayerCap > 0) {
      const local = this.getRiskThrottleFactor(tokenId);
      const global = this.getRiskThrottleFactor('__global__');
      const factor = Math.min(local, global);
      if (factor < 1) {
        const scaledCap = Math.max(1, Math.floor(riskLayerCap * factor));
        effective = Math.min(effective, scaledCap);
      }
    }
    const cancelBurstCap = Math.max(0, Math.floor(this.config.mmCancelBurstLayerCap ?? 0));
    if (cancelBurstCap > 0 && this.isCancelBurstActive(tokenId)) {
      effective = Math.min(effective, cancelBurstCap);
    }
    return Math.max(minCount, effective);
  }

  private getRestoreLayerCount(tokenId: string): number {
    const base = Math.max(0, Math.floor(this.config.mmLayerRestoreCount ?? 0));
    const panicRestoreCount = Math.max(0, Math.floor(this.config.mmPanicRestoreCount ?? 0));
    const restoreCount = panicRestoreCount > 0 ? panicRestoreCount : base;
    const stepMs = Math.max(0, this.config.mmLayerRestoreStepMs ?? 0);
    const stepCount = Math.max(0, this.config.mmLayerRestoreStepCount ?? 0);
    const rampMs = Math.max(0, this.config.mmLayerRestoreRampMs ?? 0);
    if (!restoreCount) {
      return restoreCount;
    }
    const now = Date.now();
    const start = this.layerRestoreStartAt.get(tokenId) || 0;
    if (!start) {
      return restoreCount;
    }
    const max = Math.max(restoreCount, Math.floor(this.config.mmLayerCount ?? restoreCount));
    const elapsed = Math.max(0, now - start);
    if (stepMs > 0 && stepCount > 0) {
      const steps = Math.floor(elapsed / stepMs);
      const target = Math.max(restoreCount, Math.min(max, restoreCount + steps * stepCount));
      return target;
    }
    if (!rampMs) {
      return restoreCount;
    }
    const fraction = Math.min(1, elapsed / rampMs);
    const target = Math.max(restoreCount, Math.floor(restoreCount + (max - restoreCount) * fraction));
    return Math.min(max, target);
  }

  private getRestoreExitRampCap(tokenId: string, layerCount: number): number {
    const until = this.layerRestoreExitRampUntil.get(tokenId) || 0;
    if (!until || until <= Date.now()) {
      this.layerRestoreExitRampStartAt.delete(tokenId);
      this.layerRestoreExitRampUntil.delete(tokenId);
      return layerCount;
    }
    const start = this.layerRestoreExitRampStartAt.get(tokenId) || 0;
    if (!start) {
      return layerCount;
    }
    const elapsed = Math.max(0, Date.now() - start);
    const totalMs = Math.max(1, this.config.mmRestoreExitRampMs ?? 0);
    const steps = Math.max(1, this.config.mmRestoreExitRampSteps ?? 0);
    if (!steps) {
      return layerCount;
    }
    const perStep = totalMs / steps;
    const currentStep = Math.min(steps, Math.floor(elapsed / perStep));
    const base = Math.max(1, Math.floor(this.config.mmLayerMinCount ?? 1));
    const cap = Math.min(layerCount, base + currentStep);
    return Math.max(base, cap);
  }

  private getRestoreExitSizeFactor(tokenId: string): number {
    const until = this.layerRestoreExitSizeRampUntil.get(tokenId) || 0;
    if (!until || until <= Date.now()) {
      this.layerRestoreExitSizeRampStartAt.delete(tokenId);
      this.layerRestoreExitSizeRampUntil.delete(tokenId);
      return 1;
    }
    const start = this.layerRestoreExitSizeRampStartAt.get(tokenId) || 0;
    if (!start) {
      return 1;
    }
    const totalMs = Math.max(1, this.config.mmRestoreExitSizeRampMs ?? 0);
    const minFactor = this.clamp(this.config.mmRestoreExitSizeRampMinFactor ?? 0, 0.1, 1);
    if (minFactor >= 1) {
      return 1;
    }
    const elapsed = Math.max(0, Date.now() - start);
    const progress = Math.min(1, elapsed / totalMs);
    return this.clamp(minFactor + (1 - minFactor) * progress, minFactor, 1);
  }

  private getEffectiveLayerStepBps(
    tokenId: string,
    profile: 'CALM' | 'NORMAL' | 'VOLATILE',
    depthTrend: number,
    depthSpeedBps: number
  ): number {
    let step = Math.max(0, this.config.mmLayerSpreadStepBps ?? 0);
    if (profile === 'VOLATILE') {
      step += Math.max(0, this.config.mmLayerStepBpsVolatileAdd ?? 0);
    }
    const depthDrop = Math.max(0, this.config.mmLayerDepthTrendDrop ?? 0);
    if (depthDrop > 0 && depthTrend < -depthDrop) {
      step += Math.max(0, this.config.mmLayerStepBpsThinAdd ?? 0);
    }
    if (this.isLayerPanicActive(tokenId)) {
      step += Math.max(0, this.config.mmLayerStepBpsPanicAdd ?? 0);
    }
    const speedThreshold = Math.max(0, this.config.mmLayerDepthSpeedBps ?? 0);
    if (speedThreshold > 0 && depthSpeedBps >= speedThreshold) {
      step += Math.max(0, this.config.mmLayerStepBpsSpeedAdd ?? 0);
    }
    if (this.isLayerRetreatActive(tokenId)) {
      step += Math.max(0, this.config.mmLayerStepBpsRetreatAdd ?? 0);
    }
    if (this.isLayerRestoreActive(tokenId)) {
      step += Math.max(0, this.config.mmLayerStepBpsRestoreAdd ?? 0);
    }
    if (this.isLayerRestoreActive(tokenId)) {
      step += Math.max(0, this.config.mmLayerStepBpsRestoreExtra ?? 0);
      step += Math.max(0, this.config.mmRestoreLayerStepBpsAdd ?? 0);
    }
    if (this.isLayerPanicActive(tokenId)) {
      const mult = Math.max(1, this.config.mmPanicStepBpsMult ?? 1);
      step *= mult;
    } else if (this.isLayerRestoreActive(tokenId)) {
      const mult = Math.max(1, this.config.mmRestoreStepBpsMult ?? 1);
      step *= mult;
    }
    return step;
  }

  private isLiquidityThin(metrics: { topDepth: number; topDepthUsd: number }): boolean {
    let minShares = this.config.mmMinTopDepthShares ?? 0;
    let minUsd = this.config.mmMinTopDepthUsd ?? 0;
    if (this.isWsEmergencyRecoveryActive()) {
      const mult = this.getWsEmergencyRecoveryDepthMult();
      minShares *= mult;
      minUsd *= mult;
    }
    if (minShares > 0 && metrics.topDepth < minShares) {
      return true;
    }
    if (minUsd > 0 && metrics.topDepthUsd < minUsd) {
      return true;
    }
    return false;
  }

  private calculateInventoryBias(tokenId: string): number {
    const position = this.positions.get(tokenId);
    if (!position) {
      return 0;
    }

    const netShares = position.yes_amount - position.no_amount;
    const maxPosition = this.getEffectiveMaxPosition();
    const normalized = netShares / maxPosition;

    return this.clamp(normalized, -1, 1);
  }

  private getGlobalInventoryBias(): number {
    if (this.positions.size === 0) {
      return 0;
    }
    let netShares = 0;
    for (const pos of this.positions.values()) {
      netShares += (pos.yes_amount || 0) - (pos.no_amount || 0);
    }
    const denom = this.getEffectiveMaxPosition() * Math.max(1, this.positions.size);
    return this.clamp(denom > 0 ? netShares / denom : 0, -1, 1);
  }

  private getGlobalImbalance(): number {
    if (this.lastImbalance.size === 0) {
      return 0;
    }
    let sum = 0;
    let count = 0;
    for (const value of this.lastImbalance.values()) {
      if (!Number.isFinite(value)) {
        continue;
      }
      sum += value;
      count += 1;
    }
    if (!count) {
      return 0;
    }
    return this.clamp(sum / count, -1, 1);
  }

  private getGlobalVolatility(): number {
    if (this.volatilityEma.size === 0) {
      return 0;
    }
    let sum = 0;
    let count = 0;
    for (const value of this.volatilityEma.values()) {
      if (!Number.isFinite(value)) continue;
      sum += value;
      count += 1;
    }
    return count ? sum / count : 0;
  }

  calculatePrices(market: Market, orderbook: Orderbook): QuotePrices | null {
    let tierPriced = false; // v15: 跟踪是否走了档位定价路径
    const bestBid = orderbook.best_bid;
    const bestAsk = orderbook.best_ask;
    const liquidityRules = this.getEffectiveLiquidityActivation(market);

    if (bestBid === undefined || bestAsk === undefined) {
      return null;
    }

    if (bestBid <= 0 || bestAsk <= 0 || bestBid >= bestAsk) {
      return null;
    }

    const bookSpread = (bestAsk - bestBid) / ((bestAsk + bestBid) / 2);
    if (bookSpread > MarketMaker.MAX_ALLOWED_BOOK_SPREAD) {
      return null;
    }

    this.updateBestPrices(market.token_id, orderbook);
    const depthMetrics = this.updateDepthMetrics(market.token_id, orderbook);
    const minDepth = this.config.mmDepthMinShares ?? 0;
    if (minDepth > 0 && depthMetrics.totalDepth < minDepth) {
      return null;
    }
    const safeModeEarly = this.isSafeModeActive(market.token_id, {
      volEma: this.volatilityEma.get(market.token_id) ?? 0,
      depthTrend: depthMetrics.depthTrend,
      depthSpeedBps: depthMetrics.depthSpeedBps,
    });
    if (safeModeEarly && this.config.mmSafeModeRejectThin) {
      const topDepth = this.getTopDepth(orderbook);
      if (this.isLiquidityThin({ topDepth: topDepth.shares, topDepthUsd: topDepth.usd })) {
        return null;
      }
    }
    

    const microPrice = this.calculateMicroPrice(orderbook);
    if (!microPrice || microPrice <= 0 || microPrice >= 1) {
      return null;
    }
    const mid = (bestBid + bestAsk) / 2;
    const pressureMax = Math.max(0, this.config.mmPressureMaxRatio ?? 0);
    const rawPressure = mid > 0 ? (microPrice - mid) / mid : 0;
    const pressure = pressureMax > 0 ? this.clamp(rawPressure, -pressureMax, pressureMax) : rawPressure;

    const baseSpread = this.config.spread;
    let minSpread = this.config.minSpread ?? 0.01;
    let maxSpread = this.config.maxSpread ?? 0.08;

    const lastMid = this.lastPrices.get(market.token_id);
    const volatilityComponent =
      lastMid && lastMid > 0 ? Math.abs(microPrice - lastMid) / lastMid : 0;

    const volEma = this.volatilityEma.get(market.token_id) ?? volatilityComponent;
    const depthRef = this.config.mmDepthRefShares ?? 200;
    const depthEma = this.depthEma.get(market.token_id) ?? 0;
    const topDepth = this.getTopDepth(orderbook).shares;
    const depthTrend = depthEma > 0 ? topDepth / depthEma : 1;
    const depthFactor =
      depthRef > 0 && depthEma > 0 ? this.clamp(depthEma / depthRef, 0.2, 3) : 1;
    const liquidityPenalty = depthFactor < 1 ? 1 / depthFactor - 1 : 0;

    const rawProfile = this.resolveAdaptiveProfile(volEma, depthEma, depthTrend);
    const profile = this.stabilizeProfile(market.token_id, rawProfile);
    if (this.config.mmAdaptiveParams !== false) {
      if (profile === 'CALM') {
        minSpread = this.config.mmProfileSpreadMinCalm ?? minSpread;
        maxSpread = this.config.mmProfileSpreadMaxCalm ?? maxSpread;
      } else if (profile === 'VOLATILE') {
        minSpread = this.config.mmProfileSpreadMinVolatile ?? minSpread;
        maxSpread = this.config.mmProfileSpreadMaxVolatile ?? maxSpread;
      }
    }
    if (this.isLayerRestoreActive(market.token_id)) {
      minSpread += Math.max(0, this.config.mmLayerRestoreMinSpreadAdd ?? 0);
      const cancelBufferAdd = Math.max(0, this.config.mmLayerRestoreCancelBufferAddBps ?? 0);
      if (cancelBufferAdd > 0) {
        minSpread += cancelBufferAdd / 10000;
      }
    }
    if (this.isLayerPanicActive(market.token_id)) {
      minSpread += Math.max(0, this.config.mmPanicSpreadAdd ?? 0);
    }
    if (this.isWsEmergencyRecoveryActive()) {
      const add = Math.max(0, this.config.mmWsHealthEmergencyRecoverySpreadAdd ?? 0);
      if (add > 0) {
        minSpread += add;
      }
    }

    const bookWeight = this.config.mmBookSpreadWeight ?? 0.35;
    const volWeight = this.config.mmSpreadVolWeight ?? 1.2;
    const liqWeight = this.config.mmSpreadLiquidityWeight ?? 0.5;

    let adaptiveSpread =
      this.config.mmAdaptiveParams === false
        ? baseSpread + bookSpread * 0.35 + volatilityComponent * 0.5
        : baseSpread * (1 + volEma * volWeight + liquidityPenalty * liqWeight) +
          bookSpread * bookWeight;

    const fillRiskBps = Math.max(0, this.config.mmFillRiskSpreadBps ?? 0);
    if (fillRiskBps > 0) {
      const fillRisk = this.getFillSlowdownMultiplier(market.token_id) - 1;
      if (fillRisk > 0) {
        adaptiveSpread += fillRisk * (fillRiskBps / 10000);
      }
    }

    const nearTouchPenalty = this.getNearTouchPenalty(market.token_id);
    if (nearTouchPenalty > 0) {
      adaptiveSpread += nearTouchPenalty / 10000;
    }
    const fillPenalty = this.getFillPenalty(market.token_id);
    if (fillPenalty > 0) {
      adaptiveSpread += fillPenalty / 10000;
    }
    const noFillPenalty = this.getNoFillPenalty(market.token_id);
    if (noFillPenalty.spreadBps > 0) {
      adaptiveSpread += noFillPenalty.spreadBps / 10000;
    }

    const depthTarget = this.config.mmDepthTargetShares ?? 0;
    if (depthTarget > 0) {
      const depthRatio = this.clamp(depthMetrics.totalDepth / depthTarget, 0, 1);
      const depthPenaltyWeight = this.config.mmDepthPenaltyWeight ?? 0.6;
      adaptiveSpread += (1 - depthRatio) * baseSpread * depthPenaltyWeight;
    }

    const pressureSpreadWeight = this.config.mmPressureSpreadWeight ?? 0;
    if (pressureSpreadWeight > 0) {
      adaptiveSpread += Math.abs(pressure) * pressureSpreadWeight;
    }

    if (depthMetrics.depthTrend < 0) {
      adaptiveSpread += Math.abs(depthMetrics.depthTrend) * baseSpread * 0.4;
    }

    if (profile === 'VOLATILE') {
      adaptiveSpread *= 1.1;
    } else if (profile === 'CALM') {
      adaptiveSpread *= 0.95;
    }

    // ===== Phase 1: 集成 AS 模型计算最优价差 =====
    let asEnhancedSpread = adaptiveSpread;
    if (this.config.mmEnhancedSpreadEnabled !== false) {
      // 更新增强指标
      this.updateAdvancedMetrics(market.token_id, orderbook);

      // 获取实时数据
      const volEstimator = this.getOrCreateVolatilityEstimator(market.token_id);
      const enhancedVol = volEstimator.getVolatility();

      const flowEstimator = this.getOrCreateOrderFlowEstimator(market.token_id);
      const orderFlow = flowEstimator.getFlowIntensity(1);
      const flowMetrics = flowEstimator.getMetrics(1);

      // 库存状态
      const inventoryBias = this.calculateInventoryBias(market.token_id);
      const inventoryState = this.inventoryClassifier.classify(
        market.token_id,
        Math.round(inventoryBias * this.getEffectiveMaxPosition()),
        this.getEffectiveMaxPosition()
      );

      // 更新缓存
      this.perMarketInventoryState.set(market.token_id, inventoryState);

      // 使用 AS 模型计算最优价差
      const asMarketState = {
        midPrice: microPrice,
        inventory: inventoryBias,
        volatility: enhancedVol > 0 ? enhancedVol : volEma,
        orderFlow: orderFlow,
        depth: depthMetrics.totalDepth,
        flowDirection: flowMetrics.direction
      };

      const asOptimalSpread = this.asModel.calculateOptimalSpread(asMarketState);

      // 获取库存策略
      const strategy = this.inventoryClassifier.getStrategy(
        inventoryState,
        Math.round(inventoryBias * this.getEffectiveMaxPosition()),
        this.getEffectiveMaxPosition()
      );

      // 应用策略倍数
      const strategyAdjustedSpread = asOptimalSpread * strategy.spreadMultiplier;

      // 混合现有价差和 AS 价差（可配置权重）
      const asWeight = this.config.mmASModelWeight ?? 0.5; // 默认50%权重
      asEnhancedSpread = adaptiveSpread * (1 - asWeight) + strategyAdjustedSpread * asWeight;

      // 如果库存状态不允许挂单，返回null
      if (!strategy.allowOrders) {
        console.log(`⚠️  Inventory state ${inventoryState} for ${market.token_id}, orders not allowed`);
        // 不返回null，而是扩大价差到极值
        asEnhancedSpread = Math.max(asEnhancedSpread, maxSpread);
      }
    }

    if (liquidityRules?.max_spread) {
      asEnhancedSpread = Math.min(asEnhancedSpread, liquidityRules.max_spread * 0.95);
    }

    const safeModeActive = this.isSafeModeActive(market.token_id, {
      volEma,
      depthTrend: depthMetrics.depthTrend,
      depthSpeedBps: depthMetrics.depthSpeedBps,
    });
    if (safeModeActive) {
      const spreadMult = Math.max(1, this.config.mmSafeModeSpreadMult ?? 1);
      asEnhancedSpread *= spreadMult;
      const spreadAdd = Math.max(0, this.config.mmSafeModeSpreadAdd ?? 0);
      if (spreadAdd > 0) {
        asEnhancedSpread += spreadAdd;
      }
      const cancelBufferAdd = Math.max(0, this.config.mmSafeModeCancelBufferAddBps ?? 0);
      if (cancelBufferAdd > 0) {
        asEnhancedSpread += cancelBufferAdd / 10000;
      }
    } else {
      const holdMs = Math.max(0, this.config.mmSafeModeExitHoldMs ?? 0);
      if (holdMs > 0) {
        this.safeModeExitUntil.set(market.token_id, Date.now() + holdMs);
      }
    }

    if (safeModeActive) {
      const safeMin = Math.max(0, this.config.mmSafeModeMinSpread ?? 0);
      const safeMax = Math.max(0, this.config.mmSafeModeMaxSpread ?? 0);
      if (safeMin > minSpread) {
        minSpread = safeMin;
      }
      if (safeMax > 0 && (maxSpread === 0 || safeMax < maxSpread)) {
        maxSpread = safeMax;
      }
    }

    const wsSpreadMult = this.getWsHealthSpreadMult();
    if (wsSpreadMult > 0 && wsSpreadMult !== 1) {
      asEnhancedSpread *= wsSpreadMult;
      minSpread *= wsSpreadMult;
      if (maxSpread > 0) {
        maxSpread *= wsSpreadMult;
      }
    }

    asEnhancedSpread = this.clamp(asEnhancedSpread, minSpread, maxSpread);

    const inventoryBias = this.calculateInventoryBias(market.token_id);
    let inventorySkewFactor = this.config.inventorySkewFactor ?? 0.15;
    const imbalance = this.calculateOrderbookImbalance(orderbook);
    if (this.config.mmAdaptiveParams !== false) {
      const volSkewWeight = this.config.mmInventorySkewVolWeight ?? 1.0;
      const liqSkewWeight = this.config.mmInventorySkewDepthWeight ?? 0.4;
      inventorySkewFactor =
        inventorySkewFactor * (1 + volEma * volSkewWeight + liquidityPenalty * liqSkewWeight);
    }

    let fairPrice = microPrice * (1 - inventoryBias * inventorySkewFactor * adaptiveSpread);
    if (this.config.mmAdaptiveParams !== false) {
      const imbalanceWeight = this.config.mmImbalanceWeight ?? 0.25;
      const imbalanceMax = this.config.mmImbalanceMaxSkew ?? 0.6;
      const skew = this.clamp(imbalance * imbalanceWeight, -imbalanceMax, imbalanceMax);
      fairPrice = fairPrice * (1 + skew * adaptiveSpread);
    }
    let valueBias = 0;
    let valueConfidence = 0;

    if (this.config.useValueSignal && this.valueDetector) {
      const analysis = this.valueDetector.analyzeMarket(market, orderbook);
      if (analysis) {
        const confidenceMin = this.config.valueConfidenceMin ?? 0.6;
        if (analysis.confidence >= confidenceMin) {
          const weight = this.config.valueSignalWeight ?? 0.35;
          const blend = this.clamp(weight * analysis.confidence, 0, 0.9);
          const valueFair = analysis.fairTokenPrice ?? analysis.estimatedProbability;
          const blended = fairPrice * (1 - blend) + valueFair * blend;
          valueBias = blended - fairPrice;
          valueConfidence = analysis.confidence;
          fairPrice = blended;
        }
      }
    }

    const inventorySpreadWeight = this.config.mmInventorySpreadWeight ?? 0.2;
    const imbalanceSpreadWeight = this.config.mmImbalanceSpreadWeight ?? 0.2;
    const spreadBoost =
      1 +
      Math.abs(inventoryBias) * inventorySpreadWeight +
      Math.abs(imbalance) * imbalanceSpreadWeight;
    const half = (asEnhancedSpread * spreadBoost) / 2;
    const invWeight = this.config.mmAsymSpreadInventoryWeight ?? 0.4;
    const imbWeight = this.config.mmAsymSpreadImbalanceWeight ?? 0.35;
    const minFactor = this.config.mmAsymSpreadMinFactor ?? 0.6;
    const maxFactor = this.config.mmAsymSpreadMaxFactor ?? 1.8;
    const depthImbalance = depthMetrics.imbalance;

    const bidFactor = this.clamp(1 + inventoryBias * invWeight - depthImbalance * imbWeight, minFactor, maxFactor);
    const askFactor = this.clamp(1 - inventoryBias * invWeight + depthImbalance * imbWeight, minFactor, maxFactor);
    let quoteOffset = Math.max(0, this.config.mmQuoteOffsetBps ?? 0) / 10000;
    if (liquidityRules?.max_spread) {
      const maxAllowed = liquidityRules.max_spread * 0.95;
      const remaining = Math.max(0, maxAllowed - adaptiveSpread);
      quoteOffset = Math.min(quoteOffset, remaining / 2);
    }
    const pressureOffsetWeight = this.config.mmPressureOffsetWeight ?? 0;
    if (pressureOffsetWeight > 0) {
      quoteOffset += Math.abs(pressure) * pressureOffsetWeight;
    }

    let bid = fairPrice * (1 - half * bidFactor - quoteOffset);
    let ask = fairPrice * (1 + half * askFactor + quoteOffset);
    const wsSingle = this.getWsHealthSingleSide();
    if (wsSingle.side !== 'NONE' && wsSingle.offsetBps > 0) {
      const offset = wsSingle.offsetBps / 10000;
      if (wsSingle.side === 'BUY') {
        bid = bid * (1 - offset);
      } else if (wsSingle.side === 'SELL') {
        ask = ask * (1 + offset);
      }
    }

    // ==================== 自适应积分优先模式 ====================
    // 核心策略：当盘口价差能获积分时，贴着盘口挂单；不能获积分时才拉远防吃单
    const maxSpreadCents = liquidityRules?.max_spread_cents ?? 0;
    const bookSpreadCents = (bestAsk - bestBid) * 100; // 盘口价差（美分）
    const canEarnPoints = maxSpreadCents > 0 && bookSpreadCents <= maxSpreadCents;
    // 如果有积分规则且盘口价差在允许范围内 → 贴盘口
    // 如果没有积分规则或盘口太宽 → 用 touchBuffer 拉远防吃单
    const pointsFirstMode = canEarnPoints && this.config.mmPointsFirstMode !== false; // 默认启用

    // Keep maker-friendly but never cross top of book
    let touchBufferBps = Math.max(0, this.config.mmTouchBufferBps ?? 0) + (noFillPenalty.touchBps || 0);
    const volTouchWeight = Math.max(0, this.config.mmTouchBufferVolWeight ?? 0);
    if (volTouchWeight > 0 && volEma > 0) {
      let add = volEma * 10000 * volTouchWeight;
      const maxAdd = Math.max(0, this.config.mmTouchBufferVolMaxBps ?? 0);
      if (maxAdd > 0) {
        add = Math.min(add, maxAdd);
      }
      touchBufferBps += add;
    }
    const depthSpeedWeight = Math.max(0, this.config.mmTouchBufferDepthSpeedWeight ?? 0);
    if (depthSpeedWeight > 0 && depthMetrics.depthSpeedBps > 0) {
      let add = depthMetrics.depthSpeedBps * depthSpeedWeight;
      const maxAdd = Math.max(0, this.config.mmTouchBufferDepthSpeedMaxBps ?? 0);
      if (maxAdd > 0) {
        add = Math.min(add, maxAdd);
      }
      touchBufferBps += add;
    }
    if (this.isLayerRestoreActive(market.token_id)) {
      touchBufferBps += Math.max(0, this.config.mmLayerRestoreTouchBufferBps ?? 0);
    }
    if (this.isLayerRestoreActive(market.token_id) && this.config.mmLayerRestoreNoNearTouch) {
      const extra = Math.max(0, this.config.mmLayerRestoreNearTouchBps ?? 0);
      if (extra > 0) {
        touchBufferBps += extra;
      } else {
        touchBufferBps += Math.max(touchBufferBps, 6);
      }
    }
    if (this.isLayerPanicActive(market.token_id)) {
      touchBufferBps += Math.max(0, this.config.mmPanicTouchBufferBps ?? 0);
    }
    if (safeModeActive) {
      touchBufferBps += Math.max(0, this.config.mmSafeModeTouchBufferBps ?? 0);
    }
    const wsTouchAdd = this.getWsHealthTouchBufferAddBps();
    if (wsTouchAdd > 0) {
      touchBufferBps += wsTouchAdd;
    }
    if (this.config.mmAutoTuneEnabled) {
      const autoWeight = Math.max(0, this.config.mmAutoTuneTouchBufferWeight ?? 0);
      if (autoWeight > 0) {
        const mult = this.getAutoTuneMultiplier(market.token_id);
        if (mult !== 1) {
          touchBufferBps *= 1 + (mult - 1) * autoWeight;
        }
      }
    }
    const rewardQueueRetreatBps = this.getPolymarketRewardQueueRetreatBps(market, orderbook);
    if (rewardQueueRetreatBps > 0) {
      touchBufferBps += rewardQueueRetreatBps;
    }
    const cancelReasonAdjustment = this.getPolymarketCancelReasonAdjustment(market.token_id, market);
    if (cancelReasonAdjustment.retreatBps > 0) {
      touchBufferBps += cancelReasonAdjustment.retreatBps;
    }
    const patternMemoryAdjustment = this.getPolymarketPatternMemoryAdjustment(market);
    if (patternMemoryAdjustment.retreatBps > 0) {
      touchBufferBps += patternMemoryAdjustment.retreatBps;
    }
    const eventRiskAdjustment = this.getPolymarketEventRiskAdjustment(market);
    if (eventRiskAdjustment.retreatBps > 0) {
      touchBufferBps += eventRiskAdjustment.retreatBps;
    }
    const groupBudgetAdjustment = this.getPolymarketGroupBudgetAdjustment(market);
    market.polymarket_group_utilization = groupBudgetAdjustment.utilization > 0 ? groupBudgetAdjustment.utilization : undefined;
    market.polymarket_group_remaining_budget = Number.isFinite(groupBudgetAdjustment.remainingBudget) ? groupBudgetAdjustment.remainingBudget : undefined;
    market.polymarket_group_reason = groupBudgetAdjustment.reason || undefined;
    if (groupBudgetAdjustment.retreatBps > 0) {
      touchBufferBps += groupBudgetAdjustment.retreatBps;
    }
    const themeBudgetAdjustment = this.getPolymarketThemeBudgetAdjustment(market);
    market.polymarket_theme_bucket = themeBudgetAdjustment.bucket || undefined;
    market.polymarket_theme_utilization = themeBudgetAdjustment.utilization > 0 ? themeBudgetAdjustment.utilization : undefined;
    market.polymarket_theme_remaining_budget = Number.isFinite(themeBudgetAdjustment.remainingBudget) ? themeBudgetAdjustment.remainingBudget : undefined;
    market.polymarket_theme_reason = themeBudgetAdjustment.reason || undefined;
    if (themeBudgetAdjustment.retreatBps > 0) {
      touchBufferBps += themeBudgetAdjustment.retreatBps;
    }
    const polymarketState = this.getPolymarketExecutionState(market, orderbook);
    market.polymarket_state = polymarketState.state;
    market.polymarket_state_reason = polymarketState.reason || undefined;
    const stateEntry = this.polymarketExecutionState.get(market.token_id);
    market.polymarket_state_since_ms = stateEntry?.since;
    if (polymarketState.block) {
      return null;
    }
    if (polymarketState.retreatBps > 0) {
      touchBufferBps += polymarketState.retreatBps;
    }
    const secondBid = this.getLevelPrice(orderbook.bids, 1, 'bids');
    const secondAsk = this.getLevelPrice(orderbook.asks, 1, 'asks');
    const fixedCents = Math.max(0, this.config.mmTouchBufferFixedCents ?? 0);

    // ==================== 自适应报价：积分优先 vs 安全优先 ====================
    //
    // pointsFirstMode=true（盘口价差能获积分）:
    //   贴着盘口挂单：bid=bestBid+tick, ask=bestAsk-tick
    //   成为 bestBid/bestAsk，价差=盘口价差-2*tick ≤ max_spread_cents → 获积分
    //   但安全机制（波动率飙升、被吃后等）仍会自动拉远
    //
    // pointsFirstMode=false（不能获积分）:
    //   用 touchBuffer/secondLayer/fixedCents 拉远，防吃单
    //
    const safetyOverride = safeModeActive ||
      this.isLayerPanicActive(market.token_id) ||
      this.isLayerRestoreActive(market.token_id);

    if (pointsFirstMode && !safetyOverride) {
      // ====== v18 动态档位定价模式 ======
      //
      // 核心思路：直接挂订单簿的第N档（激进=3, 保守=4）
      //   前面有N-1层别人的单挡着，被吃概率极低
      //   v18智能填补：2-3档gap过大时插中间成为新第3档
      //
      // 例: 激进模式 quoteLevel=3, 订单簿:
      //   bid侧: [0.50, 0.49, 0.48, 0.47, ...]
      //                              ↑ 第3档(index 2) = 0.48
      //   挂 bid = 0.48 - 0.015 = 0.465
      //   前面有 0.50, 0.49, 0.48 三层别人挡着
      //
      const maxSpreadDecimal = maxSpreadCents / 100;
      const mode = this.getModeParams();
      const level = mode.quoteLevel; // 3 or 4
      // getLevelPrice 的 index 是 0-based，第N档 = index N-1
      const levelBidPrice = this.getLevelPrice(orderbook.bids, level - 1, 'bids');
      const levelAskPrice = this.getLevelPrice(orderbook.asks, level - 1, 'asks');

      // 动态绝对距离兜底（当档位数据不可用时）
      const absoluteMin = this.getDynamicAbsoluteMin(market.token_id, orderbook) / 100;

      if (levelBidPrice !== null && levelAskPrice !== null) {
        // ====== v18 动态档位挂单 ======
        // 核心逻辑：直接挂在订单簿第N档价格（不加退让）
        //   激进(quoteLevel=3): 挂第三档，前面2层挡着
        //   保守(quoteLevel=4): 挂第四档，前面3层挡着
        //
        // 智能填补：如果第N-1档和第N档之间gap过大，插在中间成为新第N档
        //   例: 第2档=99.0, 第3档=98.8, gap=2c > 阈值 → 挂(99.0+98.8)/2=98.9

        let targetBid = levelBidPrice - mode.tierRetreatCents / 100; // v24: 退让1.5c避免裸挂
        let targetAsk = levelAskPrice + mode.tierRetreatCents / 100;

        // ====== 智能填补：第N-1档和第N档之间gap过大时插中间 ======
        const prevLevelBid = this.getLevelPrice(orderbook.bids, level - 2, 'bids'); // 第N-1档
        const prevLevelAsk = this.getLevelPrice(orderbook.asks, level - 2, 'asks'); // 第N-1档
        const GAP_THRESHOLD = 0.01; // 1 cent gap就值得填补（多赚积分）
        let effectiveBidRef = levelBidPrice; // 用于深度检查的基准价
        let effectiveAskRef = levelAskPrice;

        // v22: 智能填补保护距离 — 填补后的价格离BBO必须 >= absoluteMinBufferCents
        const fillProtectDist = mode.absoluteMinBufferCents / 100;

        // bid侧: prevLevelBid > levelBidPrice (价格从高到低)
        const bidGap = prevLevelBid !== null ? prevLevelBid - levelBidPrice : 0;
        if (prevLevelBid !== null && bidGap > GAP_THRESHOLD) {
          const fillBid = (prevLevelBid + levelBidPrice) / 2;
          // v22: 填补后仍要确保离BBO至少absoluteMinBufferCents
          if (fillBid < bestBid && (bestBid - fillBid) >= fillProtectDist) {
            targetBid = fillBid; // 填补在N-1和N档中间
            effectiveBidRef = fillBid;
            console.log(`🔄 智能填补BID: ${level-1}档=${(prevLevelBid*100).toFixed(1)}c ${level}档=${(levelBidPrice*100).toFixed(1)}c gap=${(bidGap*100).toFixed(1)}c → 填补${(fillBid*100).toFixed(1)}c`);
          } else if (fillBid < bestBid) {
            // 填补位离BBO太近，不填补，保持原始档位
            console.log(`⚠️ 智能填补BID: 填补位${(fillBid*100).toFixed(1)}c离BBO仅${((bestBid-fillBid)*100).toFixed(1)}c < ${mode.absoluteMinBufferCents}c，放弃填补`);
          }
        }
        // ask侧: prevLevelAsk < levelAskPrice (价格从低到高)
        const askGap = prevLevelAsk !== null ? levelAskPrice - prevLevelAsk : 0;
        if (prevLevelAsk !== null && askGap > GAP_THRESHOLD) {
          const fillAsk = (prevLevelAsk + levelAskPrice) / 2;
          // v22: 填补后仍要确保离BBO至少absoluteMinBufferCents
          if (fillAsk > bestAsk && (fillAsk - bestAsk) >= fillProtectDist) {
            targetAsk = fillAsk;
            effectiveAskRef = fillAsk;
            console.log(`🔄 智能填补ASK: ${level-1}档=${(prevLevelAsk*100).toFixed(1)}c ${level}档=${(levelAskPrice*100).toFixed(1)}c gap=${(askGap*100).toFixed(1)}c → 填补${(fillAsk*100).toFixed(1)}c`);
          } else if (fillAsk > bestAsk) {
            console.log(`⚠️ 智能填补ASK: 填补位${(fillAsk*100).toFixed(1)}c离BBO仅${((fillAsk-bestAsk)*100).toFixed(1)}c < ${mode.absoluteMinBufferCents}c，放弃填补`);
          }
        }

        // 基本合法性：不能挂在盘口外侧（那不是maker而是taker）
        if (targetBid >= bestBid) return null;
        if (targetAsk <= bestAsk) return null;

        // ====== v18 前方流动性检查 ======
        // 计算我们挂单位置前方（closer to BBO）有多少流动性
        // 智能填补时用填补位作为基准，否则用原始档位价格
        const minFrontShares = mode.minFrontDepth; // 激进4000, 保守6000
        const frontBidDepth = this.sumFrontDepth(orderbook.bids, effectiveBidRef, 'bids', market.token_id);
        const frontAskDepth = this.sumFrontDepth(orderbook.asks, effectiveAskRef, 'asks', market.token_id);
        if (frontBidDepth < minFrontShares || frontAskDepth < minFrontShares) {
          // 前方流动性不足 → 档位数据不可靠，不挂单
          console.log(`📊 前方深度不足: bid前${frontBidDepth}股 ask前${frontAskDepth}股 (需${minFrontShares}) → 跳过`);
          return null;
        }

        // 检查 spread 是否在 max_spread 范围内
        const actualSpread = targetAsk - targetBid;
        if (actualSpread > maxSpreadDecimal) {
          // 档位太远导致 spread 超限 → 尝试从盘口中间对称分配
          const midCalc = (bestBid + bestAsk) / 2;
          const maxAllowedSpread = maxSpreadDecimal * (1 - mode.safetyMargin);
          const safeHalfSpread = maxAllowedSpread / 2;
          const rebalancedBid = midCalc - safeHalfSpread;
          const rebalancedAsk = midCalc + safeHalfSpread;

          // 重平衡后只检查不出盘口
          if (rebalancedBid >= bestBid || rebalancedAsk <= bestAsk) {
            return null;
          }
          targetBid = rebalancedBid;
          targetAsk = rebalancedAsk;
        }

        bid = Math.min(bid, targetBid);
        ask = Math.max(ask, targetAsk);
        tierPriced = true; // v15: 标记走了档位定价
      } else {
        // ====== 档位不可用（订单簿太浅）→ 退回动态距离模式 ======
        const midCalc = (bestBid + bestAsk) / 2;
        const effectiveSpread = maxSpreadDecimal * (1 - mode.safetyMargin);
        const halfSpread = effectiveSpread / 2;
        let targetBid = midCalc - halfSpread;
        let targetAsk = midCalc + halfSpread;

        if (bestBid - targetBid < absoluteMin) {
          targetBid = bestBid - absoluteMin;
        }
        if (targetAsk - bestAsk < absoluteMin) {
          targetAsk = bestAsk + absoluteMin;
        }

        const maxAllowedSpread = maxSpreadDecimal * (1 - mode.safetyMargin);
        if (targetAsk - targetBid > maxAllowedSpread) {
          const bookMid = (bestBid + bestAsk) / 2;
          targetBid = bookMid - maxAllowedSpread / 2;
          targetAsk = bookMid + maxAllowedSpread / 2;
          if (bestBid - targetBid < absoluteMin || targetAsk - bestAsk < absoluteMin) {
            return null;
          }
        }
        if (bestBid - targetBid < absoluteMin || targetAsk - bestAsk < absoluteMin) {
          return null;
        }

        bid = Math.min(bid, targetBid);
        ask = Math.max(ask, targetAsk);
      }

      // v15: 去掉档位路径的absoluteMin兜底覆盖
      // 档位路径已有前方流动性检查，不需要再推远
      // absoluteMin只用于"档位不可用"的fallback路径
    } else {
      // ====== 安全优先模式：原有 touchBuffer 逻辑 ======
      const touchBufferSafeBid = touchBufferBps > 0 ? bestBid * (1 - touchBufferBps / 10000) : bestBid;
      const touchBufferSafeAsk = touchBufferBps > 0 ? bestAsk * (1 + touchBufferBps / 10000) : bestAsk;
      const fixedCentsSafeBid = fixedCents > 0 ? bestBid - fixedCents / 100 : bestBid;
      const fixedCentsSafeAsk = fixedCents > 0 ? bestAsk + fixedCents / 100 : bestAsk;

      const safeBid = Math.min(touchBufferSafeBid, fixedCentsSafeBid);
      const safeAsk = Math.max(touchBufferSafeAsk, fixedCentsSafeAsk);

      if (this.config.mmQuoteSecondLayer) {
        let usedNativeSecondLevel = false;
        if (secondBid !== null && secondBid > 0) {
          bid = Math.min(bid, secondBid);
          usedNativeSecondLevel = true;
        }
        if (secondAsk !== null && secondAsk > 0) {
          ask = Math.max(ask, secondAsk);
          usedNativeSecondLevel = true;
        }
        if (!usedNativeSecondLevel && fixedCents > 0) {
          const fixedOffset = fixedCents / 100;
          const maxBid = bestBid - fixedOffset;
          const minAsk = bestAsk + fixedOffset;
          bid = Math.min(bid, maxBid);
          ask = Math.max(ask, minAsk);
        } else if (!usedNativeSecondLevel && touchBufferBps > 0) {
          const buffer = touchBufferBps / 10000;
          const maxBid = bestBid * (1 - buffer);
          const minAsk = bestAsk * (1 + buffer);
          bid = Math.min(bid, maxBid);
          ask = Math.max(ask, minAsk);
        }

        // 即使使用了 secondLayer，仍然确保不低于 touchBuffer 的安全约束
        bid = Math.min(bid, safeBid);
        ask = Math.max(ask, safeAsk);
      } else if (touchBufferBps > 0) {
        const buffer = touchBufferBps / 10000;
        const maxBid = bestBid * (1 - buffer);
        const minAsk = bestAsk * (1 + buffer);
        bid = Math.min(bid, maxBid);
        ask = Math.max(ask, minAsk);

        if (fixedCents > 0) {
          bid = Math.min(bid, bestBid - fixedCents / 100);
          ask = Math.max(ask, bestAsk + fixedCents / 100);
        }
      } else {
        // 无 touchBuffer、无 fixedCents、无 secondLayer → 必须有最小退让
        // 绝对不能成为盘口最优价！
        const minRetreat = this.getDynamicAbsoluteMin(market.token_id, orderbook) / 100;
        bid = Math.min(bid, bestBid - minRetreat);
        ask = Math.max(ask, bestAsk + minRetreat);
      }
    }

    // ==================== 绝对距离最终兜底 ====================
    // v15: 档位定价路径（pointsFirstMode && 档位可用）已有前方流动性保护，不需要absoluteMin
    // 只有安全优先路径和档位不可用的fallback才需要这个兜底
    if (!pointsFirstMode || safetyOverride) {
      const absMin = this.getDynamicAbsoluteMin(market.token_id, orderbook) / 100;
      bid = Math.min(bid, bestBid - absMin);
      ask = Math.max(ask, bestAsk + absMin);
    }

    // v20: 冰山订单惩罚 — 检测到大单拆分行为时加大spread
    const icebergEntry = this.icebergPenalty.get('global');
    if (icebergEntry && icebergEntry.value > 0 && Date.now() - icebergEntry.ts < 60000) {
      const penaltyCents = icebergEntry.value * 0.5; // 0-0.5c额外距离
      bid = Math.min(bid, bid - penaltyCents / 100); // bid再往下移
      ask = Math.max(ask, ask + penaltyCents / 100); // ask再往上移
      console.log(`🧊 冰山惩罚生效: penalty=${icebergEntry.value.toFixed(3)}, 额外距离=${penaltyCents.toFixed(3)}c`);
    }

    // v20: clamp前检测异常值 — 超出有效范围说明计算有问题
    if (bid < 0.005 || bid > 0.995 || ask < 0.005 || ask > 0.995) {
      console.warn(`🛑 报价异常: bid=${bid?.toFixed(4)} ask=${ask?.toFixed(4)}，放弃挂单!`);
      return null;
    }
    bid = this.clamp(bid, 0.01, 0.99);
    ask = this.clamp(ask, 0.01, 0.99);

    if (bid >= ask - MarketMaker.MIN_TICK) {
      return null;
    }

    return {
      bidPrice: bid,
      askPrice: ask,
      midPrice: microPrice,
      spread: ask > bid ? ask - bid : asEnhancedSpread, // 实际 bid-ask 价差（用于积分检查）
      pressure,
      inventoryBias,
      valueBias,
      valueConfidence,
      depth: depthMetrics.totalDepth,
      depthTrend: depthMetrics.depthTrend,
      imbalance: depthImbalance,
      profile,
      volatility: volatilityComponent,
      tierPriced, // 标记是否档位定价，验证层据此应用0.5c距离检查
    };
  }

  calculateOrderSize(
    market: Market,
    orderbook: Orderbook,
    side: 'BUY' | 'SELL',
    price: number
  ): OrderSizeResult {
    if (!Number.isFinite(price) || price <= 0) {
      return { shares: 0, usdt: 0 };
    }

    const liquidityRules = this.getEffectiveLiquidityActivation(market);
    const positionValue = this.positions.get(market.token_id)?.total_value || 0;
    const effectiveMaxPosition = this.getEffectiveMaxPosition();
    const remainingRiskBudget = Math.max(0, effectiveMaxPosition - positionValue);
    const groupBudgetAdjustment = this.getPolymarketGroupBudgetAdjustment(market);
    market.polymarket_group_utilization = groupBudgetAdjustment.utilization > 0 ? groupBudgetAdjustment.utilization : undefined;
    market.polymarket_group_remaining_budget = Number.isFinite(groupBudgetAdjustment.remainingBudget) ? groupBudgetAdjustment.remainingBudget : undefined;
    market.polymarket_group_reason = groupBudgetAdjustment.reason || undefined;
    const themeBudgetAdjustment = this.getPolymarketThemeBudgetAdjustment(market);
    market.polymarket_theme_bucket = themeBudgetAdjustment.bucket || undefined;
    market.polymarket_theme_utilization = themeBudgetAdjustment.utilization > 0 ? themeBudgetAdjustment.utilization : undefined;
    market.polymarket_theme_remaining_budget = Number.isFinite(themeBudgetAdjustment.remainingBudget) ? themeBudgetAdjustment.remainingBudget : undefined;
    market.polymarket_theme_reason = themeBudgetAdjustment.reason || undefined;
    const combinedRemainingBudget = Math.max(0, Math.min(remainingRiskBudget, groupBudgetAdjustment.remainingBudget, themeBudgetAdjustment.remainingBudget));

    if (combinedRemainingBudget <= 0) {
      return { shares: 0, usdt: 0 };
    }

    const effectiveOrderSize = this.getEffectiveOrderSize();
    const effectiveMaxSingle = this.getEffectiveMaxSingleOrderValue();
    const targetOrderValue = Math.min(effectiveOrderSize, effectiveMaxSingle, combinedRemainingBudget);

    if (targetOrderValue <= 0) {
      return { shares: 0, usdt: 0 };
    }

    const safeModeActive = this.isSafeModeActive(market.token_id, {
      volEma: this.volatilityEma.get(market.token_id) ?? 0,
      depthTrend: this.depthTrend.get(market.token_id) ?? 0,
      depthSpeedBps: this.lastDepthSpeedBps.get(market.token_id) ?? 0,
    });

    let shares = Math.floor(targetOrderValue / price);
    const depthUsage = this.config.mmOrderDepthUsage ?? 0;
    const topDepth = this.lastDepth.get(market.token_id);
    if (depthUsage > 0 && topDepth && topDepth > 0) {
      let cap = Math.max(1, Math.floor(topDepth * depthUsage));
      if (safeModeActive) {
        const mult = Math.max(0, this.config.mmSafeModeDepthUsageMult ?? 1);
        if (mult > 0) {
          cap = Math.max(1, Math.floor(cap * mult));
        }
      }
      shares = Math.min(shares, cap);
    }

    const depthFactor = this.config.mmDepthShareFactor ?? 0;
    let depthCap = 0;
    if (depthFactor > 0) {
      const levels = this.config.mmDepthLevels ?? 3;
      const sideLevels = side === 'BUY' ? orderbook.bids : orderbook.asks;
      depthCap = Math.floor(this.sumDepthLevels(sideLevels, levels) * depthFactor);
      if (safeModeActive) {
        const mult = Math.max(0, this.config.mmSafeModeDepthCapMult ?? 1);
        if (mult > 0) {
          depthCap = Math.max(1, Math.floor(depthCap * mult));
        }
      }
    }

    const inventoryBias = this.calculateInventoryBias(market.token_id);
    const imbalance = this.calculateOrderbookImbalance(orderbook);
    const sizeInvWeight = this.config.mmSizeInventoryWeight ?? 0.4;
    const sizeImbWeight = this.config.mmSizeImbalanceWeight ?? 0.3;
    const sizeMin = this.config.mmSizeMinFactor ?? 0.3;
    const sizeMax = this.config.mmSizeMaxFactor ?? 1.4;
    let sizeFactor = 1;
    if (side === 'BUY') {
      sizeFactor *= 1 - inventoryBias * sizeInvWeight;
      sizeFactor *= 1 + imbalance * sizeImbWeight;
    } else {
      sizeFactor *= 1 + inventoryBias * sizeInvWeight;
      sizeFactor *= 1 - imbalance * sizeImbWeight;
    }
    if (this.config.mmAutoTuneEnabled) {
      const autoWeight = Math.max(0, this.config.mmAutoTuneSizeWeight ?? 0);
      if (autoWeight > 0) {
        const mult = this.getAutoTuneMultiplier(market.token_id);
        if (mult !== 1) {
          sizeFactor *= 1 / Math.max(0.1, 1 + (mult - 1) * autoWeight);
        }
      }
    }
    const volWeight = Math.max(0, this.config.mmSizeVolWeight ?? 0);
    if (volWeight > 0) {
      const vol = this.volatilityEma.get(market.token_id) ?? 0;
      if (vol > 0) {
        sizeFactor *= 1 / (1 + vol * volWeight);
      }
    }
    const depthSpeedWeight = Math.max(0, this.config.mmSizeDepthSpeedWeight ?? 0);
    if (depthSpeedWeight > 0) {
      const depthSpeed = this.lastDepthSpeedBps.get(market.token_id) ?? 0;
      if (depthSpeed > 0) {
        const scaled = 1 + (depthSpeed / 10000) * depthSpeedWeight;
        sizeFactor *= 1 / Math.max(0.2, scaled);
      }
    }
    sizeFactor = this.clamp(sizeFactor, sizeMin, sizeMax);
    const penalty = this.getSizePenalty(market.token_id);
    const noFill = this.getNoFillPenalty(market.token_id);
    shares = Math.floor(shares * sizeFactor * penalty * (noFill.sizeFactor || 1));

    const minShares = liquidityRules?.min_shares || 0;
    if (minShares > 0 && shares < minShares) {
      const minOrderValue = minShares * price;
      const hardCap = this.config.maxSingleOrderValue ?? Number.POSITIVE_INFINITY;
      if (minOrderValue <= hardCap && minOrderValue <= combinedRemainingBudget) {
        // 优先确保满足 min_shares 以获得积分，即使超过 depthCap
        shares = minShares;
        this.recordMmEvent('MIN_SHARES_ENFORCED',
          `min=${minShares} depthCap=${depthCap || 'none'} original=${shares * sizeFactor * penalty * (noFill.sizeFactor || 1)}`,
          market.token_id);
      } else {
        // 无法满足 min_shares 要求，记录警告
        this.recordMmEvent('MIN_SHARES_UNMET',
          `min=${minShares} shares=${shares} value=${minOrderValue} cap=${hardCap} budget=${combinedRemainingBudget}`,
          market.token_id);
      }
    }

    if (liquidityRules?.active && this.config.mmPointsMinOnly && minShares > 0) {
      const multiplier = Math.max(1, this.config.mmPointsMinMultiplier ?? 1);
      const cap = Math.max(minShares, Math.floor(minShares * multiplier));
      shares = Math.min(shares, cap);
      if (shares < minShares) {
        shares = minShares;
      }
    }

    const rewardSizeCapShares = this.getPolymarketRewardSizeCapShares(market);
    if (rewardSizeCapShares > 0) {
      shares = Math.min(shares, rewardSizeCapShares);
      if (minShares > 0 && shares < minShares) {
        shares = minShares;
      }
    }

    const cancelReasonAdjustment = this.getPolymarketCancelReasonAdjustment(market.token_id, market);
    if (cancelReasonAdjustment.sizeFactor < 1) {
      shares = Math.max(1, Math.floor(shares * cancelReasonAdjustment.sizeFactor));
    }
    const patternMemoryAdjustment = this.getPolymarketPatternMemoryAdjustment(market);
    if (patternMemoryAdjustment.sizeFactor < 1) {
      shares = Math.max(1, Math.floor(shares * patternMemoryAdjustment.sizeFactor));
    }
    const eventRiskAdjustment = this.getPolymarketEventRiskAdjustment(market);
    if (eventRiskAdjustment.sizeFactor < 1) {
      shares = Math.max(1, Math.floor(shares * eventRiskAdjustment.sizeFactor));
    }
    if (groupBudgetAdjustment.sizeFactor < 1) {
      shares = Math.max(1, Math.floor(shares * groupBudgetAdjustment.sizeFactor));
    }
    if (themeBudgetAdjustment.sizeFactor < 1) {
      shares = Math.max(1, Math.floor(shares * themeBudgetAdjustment.sizeFactor));
    }
    const polymarketState = this.getPolymarketExecutionState(market, orderbook);
    market.polymarket_state = polymarketState.state;
    market.polymarket_state_reason = polymarketState.reason || undefined;
    const stateEntry = this.polymarketExecutionState.get(market.token_id);
    market.polymarket_state_since_ms = stateEntry?.since;
    if (polymarketState.block || polymarketState.sizeFactor <= 0) {
      return { shares: 0, usdt: 0 };
    }
    if (polymarketState.sizeFactor < 1) {
      shares = Math.max(1, Math.floor(shares * polymarketState.sizeFactor));
    }

    if (depthCap > 0) {
      shares = Math.min(shares, depthCap);
    }

    const maxShares = this.config.mmMaxSharesPerOrder ?? 0;
    if (maxShares > 0) {
      shares = Math.min(shares, Math.floor(maxShares));
    }
    if (safeModeActive) {
      const maxSafe = this.config.mmSafeModeMaxSharesPerOrder ?? 0;
      if (maxSafe > 0) {
        shares = Math.min(shares, Math.floor(maxSafe));
      }
    }

    const wsSizeMult = this.getWsHealthSizeMult();
    if (wsSizeMult > 0 && wsSizeMult !== 1) {
      shares = Math.floor(shares * wsSizeMult);
    }

    if (shares <= 0) {
      return { shares: 0, usdt: 0 };
    }

    const usdt = shares * price;
    const maxSingleOrderValue = effectiveMaxSingle;

    if (usdt > maxSingleOrderValue) {
      const cappedShares = Math.max(0, Math.floor(maxSingleOrderValue / price));
      return {
        shares: cappedShares,
        usdt: cappedShares * price,
      };
    }

    return { shares, usdt };
  }

  checkLiquidityPointsEligibility(market: Market, orderbook: Orderbook): boolean {
    const rules = this.getEffectiveLiquidityActivation(market);
    // 修复：无积分规则时允许交易
    if (!rules?.active) {
      return true;
    }

    // 检查 max_spread（支持 cents 和 decimal 两种格式）
    const maxSpread = rules.max_spread ?? (rules.max_spread_cents ? rules.max_spread_cents / 100 : undefined);
    if (maxSpread && orderbook.spread && orderbook.spread > maxSpread) {
      this.recordMmEvent('POINTS_SPREAD_EXCEEDED',
        `spread=${orderbook.spread} max=${maxSpread}`,
        market.token_id);
      return false;
    }

    return true;
  }

  isNearBestPrice(
    price: number,
    side: 'BUY' | 'SELL',
    orderbook: Orderbook,
    threshold: number = 0.005
  ): boolean {
    const bestBid = orderbook.best_bid;
    const bestAsk = orderbook.best_ask;

    if (side === 'BUY' && bestBid && price >= bestBid * (1 - threshold)) {
      return true;
    }

    if (side === 'SELL' && bestAsk && price <= bestAsk * (1 + threshold)) {
      return true;
    }

    return false;
  }

  private shouldRepriceOrder(order: Order, targetPrice: number): boolean {
    const current = Number(order.price);
    if (!Number.isFinite(current) || current <= 0) {
      return true;
    }

    const diff = Math.abs(targetPrice - current) / current;
    const base = this.config.repriceThreshold ?? 0.003;
    const mult = this.getVolatilityMultiplier(order.token_id, this.config.mmRepriceVolMultiplier ?? 1.5);
    const noFill = this.getNoFillPenalty(order.token_id);
    let threshold = (base + (noFill.repriceBps || 0) / 10000) / mult;
    if (this.config.mmAutoTuneEnabled) {
      const autoWeight = Math.max(0, this.config.mmAutoTuneRepriceWeight ?? 0);
      if (autoWeight > 0) {
        const autoMult = this.getAutoTuneMultiplier(order.token_id);
        if (autoMult !== 1) {
          const factor = 1 + (autoMult - 1) * autoWeight;
          threshold = threshold / Math.max(0.2, factor);
        }
      }
    }
    const wsRepriceMult = this.getWsHealthRepriceMult();
    if (wsRepriceMult > 0 && wsRepriceMult !== 1) {
      threshold = threshold / wsRepriceMult;
    }
    let buffer = Math.max(0, this.config.mmRepriceBufferBps ?? 0);
    const wsRepriceAdd = this.getWsHealthRepriceBufferAddBps();
    if (wsRepriceAdd > 0) {
      buffer += wsRepriceAdd / 10000;
    }
    let confirmMs = Math.max(0, this.config.mmRepriceConfirmMs ?? 0);
    const wsConfirmMult = this.getWsHealthRepriceConfirmMult();
    if (wsConfirmMult > 0 && wsConfirmMult !== 1) {
      confirmMs = Math.round(confirmMs * wsConfirmMult);
    }
    if (
      this.isSafeModeActive(order.token_id, {
        volEma: this.volatilityEma.get(order.token_id) ?? 0,
        depthTrend: this.depthTrend.get(order.token_id) ?? 0,
        depthSpeedBps: this.lastDepthSpeedBps.get(order.token_id) ?? 0,
      })
    ) {
      const mult = Math.max(1, this.config.mmSafeModeRepriceMult ?? 1);
      threshold = threshold / mult;
      const add = Math.max(0, this.config.mmSafeModeRepriceBufferAddBps ?? 0);
      if (add > 0) {
        buffer += add / 10000;
      }
      const confirmMult = Math.max(1, this.config.mmSafeModeRepriceConfirmMult ?? 1);
      confirmMs = Math.round(confirmMs * confirmMult);
    }
    const hard = threshold * (1 + buffer);
    if (diff >= hard) {
      this.repriceHoldUntil.delete(order.order_hash);
      return true;
    }
    if (diff < threshold) {
      this.repriceHoldUntil.delete(order.order_hash);
      return false;
    }
    if (confirmMs <= 0) {
      return true;
    }
    const until = this.repriceHoldUntil.get(order.order_hash) || 0;
    if (!until) {
      this.repriceHoldUntil.set(order.order_hash, Date.now() + confirmMs);
      return false;
    }
    if (Date.now() >= until) {
      this.repriceHoldUntil.delete(order.order_hash);
      return true;
    }
    return false;
  }

  private getAdaptiveCooldown(tokenId: string, baseMs: number): number {
    if (this.config.mmAdaptiveParams === false) {
      return baseMs;
    }
    const mult = this.getVolatilityMultiplier(tokenId, this.config.mmCooldownVolMultiplier ?? 1.2);
    return Math.round(baseMs * mult);
  }

  private async trimExcessOrders(tokenId: string, orders: Order[]): Promise<Order[]> {
    const maxOrders = this.getEffectiveMaxOrdersPerMarket();
    if (orders.length <= maxOrders) {
      return orders;
    }

    const sorted = [...orders].sort((a, b) => b.timestamp - a.timestamp);
    const keep = sorted.slice(0, maxOrders);
    const cancel = sorted.slice(maxOrders);

    for (const order of cancel) {
      await this.cancelOrder(order);
    }

    return keep;
  }

  private getEffectiveMaxOrdersPerMarket(): number {
    const base = this.config.maxOrdersPerMarket ?? 2;
    const layerCount = Math.max(1, Math.floor(this.config.mmLayerCount ?? 1));
    if (layerCount <= 1) {
      return base;
    }
    let maxOrders = Math.max(base, layerCount * 2);
    const wsMult = this.getWsHealthMaxOrdersMult();
    if (wsMult > 0 && wsMult !== 1) {
      maxOrders = Math.max(1, Math.floor(maxOrders * wsMult));
    }
    return maxOrders;
  }

  async placeMMOrders(market: Market, orderbook: Orderbook): Promise<void> {
    if (!this.config.enableTrading) {
      console.log('⚠️  Trading is disabled. Set ENABLE_TRADING=true to enable.');
      return;
    }

    // 更新 marketByToken 映射（支持 YES/NO 的不同 token_id）
    const { yesTokenId, noTokenId } = this.getYesNoTokenIds(market);
    this.marketByToken.set(market.token_id, market);
    if (yesTokenId) {
      this.marketByToken.set(yesTokenId, { ...market, token_id: yesTokenId });
    }
    if (noTokenId) {
      this.marketByToken.set(noTokenId, { ...market, token_id: noTokenId });
    }

    const livePosition = this.positions.get(market.token_id);
    if (this.shouldTripPredictLossFuse(livePosition)) {
      await this.triggerPredictLossFuse(market.token_id, livePosition);
      return;
    }
    if (this.shouldTripPolymarketLossFuse(livePosition)) {
      await this.triggerPolymarketLossFuse(market.token_id, livePosition);
      return;
    }
    const eventRiskAdjustment = this.getPolymarketEventRiskAdjustment(market);
    if (eventRiskAdjustment.block) {
      await this.enforceMarketPause(
        market.token_id,
        Math.max(60_000, Number(this.config.polymarketEventRiskBlockWithinMs || 30 * 60 * 1000)),
        eventRiskAdjustment.reason || '临近事件窗口',
        'polymarket-event-window',
        true
      );
      return;
    }

    // ===== 统一做市商策略（整合所有优点 + 7层防护） =====
    if (this.unifiedMarketMakerStrategy.isEnabled()) {
      // ===== 统一策略也必须经过7层防护 =====
      // 之前直接 executeUnifiedStrategy 跳过了所有防护，导致离盘口太近被吃

      const tokenId = market.token_id;
      const now = Date.now();

      // WS 紧急状态检查
      if (this.wsEmergencyGlobalUntil > now) return;
      if (this.shouldEmergencyCancelGlobal()) {
        await this.cancelAllOpenOrders();
        const cooldown = Math.max(0, this.config.mmWsHealthEmergencyCooldownMs ?? 0);
        if (cooldown > 0) this.wsEmergencyGlobalUntil = now + cooldown;
        return;
      }

      // 暂停检查
      if (this.isPaused(tokenId)) return;

      // L5: 被吃冷却
      const fillCooldown = this.getFillCooldownRemaining(tokenId);
      if (fillCooldown > 0) {
        this.markCooldown(tokenId, fillCooldown);
        return;
      }

      // L6: 自适应缓冲优化
      this.optimizeAdaptiveBuffers();

      // BUG#4 FIX: 获取YES/NO token_id，用于取消订单时能清除所有子token的挂单
      const { yesTokenId: earlyYesId, noTokenId: earlyNoId } = this.getYesNoTokenIds(market);

      // L2: 市场筛选
      const screenResult = this.screenMarket(market, orderbook);
      if (!screenResult.safe) {
        console.log(`🔍 LAYER2(统一): ${tokenId.slice(0, 8)} 跳过不安全市场: ${screenResult.reason}`);
        await this.cancelOrdersForMarket(tokenId);
        if (earlyYesId) await this.cancelOrdersForMarket(earlyYesId);
        if (earlyNoId) await this.cancelOrdersForMarket(earlyNoId);
        this.markCooldown(tokenId, this.config.cooldownAfterCancelMs ?? 4000);
        return;
      }

      // L3: 吃单概率
      const fillRiskScore = this.calculateFillRisk(tokenId, orderbook, market);
      const fillRiskThreshold = this.config.mmFillRiskThreshold ?? 50;
      if (fillRiskScore > fillRiskThreshold) {
        console.log(`🎯 LAYER3(统一): ${tokenId.slice(0, 8)} fillRisk=${fillRiskScore.toFixed(0)} > ${fillRiskThreshold}, 跳过`);
        await this.cancelOrdersForMarket(tokenId);
        if (earlyYesId) await this.cancelOrdersForMarket(earlyYesId);
        if (earlyNoId) await this.cancelOrdersForMarket(earlyNoId);
        this.markCooldown(tokenId, this.config.cooldownAfterCancelMs ?? 4000);
        return;
      }

      // L4: 位置监控 — 必须监控YES/NO子token的挂单（统一策略在子token上下单）
      await this.monitorMyOrderPosition(market, orderbook);
      // 监控YES子token
      if (earlyYesId && earlyYesId !== tokenId) {
        const yesBook = this.pointsOrderbookCache.get(earlyYesId);
        if (yesBook) {
          await this.monitorMyOrderPosition({ ...market, token_id: earlyYesId }, yesBook);
        }
      }
      // 监控NO子token
      if (earlyNoId && earlyNoId !== tokenId) {
        const noBook = this.pointsOrderbookCache.get(earlyNoId);
        if (noBook) {
          await this.monitorMyOrderPosition({ ...market, token_id: earlyNoId }, noBook);
        }
      }

      // 波动率检查
      if (this.checkVolatility(tokenId, orderbook)) {
        await this.cancelOrdersForMarket(tokenId);
        if (earlyYesId) await this.cancelOrdersForMarket(earlyYesId);
        if (earlyNoId) await this.cancelOrdersForMarket(earlyNoId);
        this.markCooldown(tokenId, this.config.pauseAfterVolatilityMs ?? 8000);
        return;
      }

      // CRITICAL FIX #1: 使用聚合的持仓（YES + NO token_id）
      const position = this.getAggregatedPosition(market);
      const yesPrice = orderbook.best_bid || 0;
      const noPrice = 1 - yesPrice;

      const analysis = this.unifiedMarketMakerStrategy.analyze(market, position, yesPrice, noPrice);

      console.log(`🚀 统一做市商策略: ${analysis.state}`);
      console.log(`   挂 Buy 单: ${analysis.shouldPlaceBuyOrders ? '✅' : '❌'}`);
      console.log(`   挂 Sell 单: ${analysis.shouldPlaceSellOrders ? '✅' : '❌'}`);

      // 执行统一策略的挂单逻辑（使用 calculatePrices 的安全报价）
      await this.executeUnifiedStrategy(market, orderbook, position, analysis);

      // 监控是否成为第一档（如果成为则自动撤单重挂）
      await this.monitorTierOneStatus(market, orderbook);

      return;
    }

    // 如果未启用统一策略，继续原有的做市商逻辑
    // ...

    if (this.tradingHalted) {
      console.log('🛑 Trading halted by risk controls.');
      return;
    }

    if (!this.orderManager) {
      if (!this.warnedNoExecution) {
        console.log('⚠️  OrderManager is not initialized, skip live order placement.');
        this.warnedNoExecution = true;
      }
      return;
    }

    const tokenId = market.token_id;
    this.updateBestPrices(tokenId, orderbook);

    // 缓存订单簿用于积分优化
    this.pointsOrderbookCache.set(tokenId, orderbook);
    this.pointsOrderbookCacheTs.set(tokenId, Date.now());
    await this.checkCancelOnDisplacement(tokenId, orderbook); // v24: await — 撤单必须完成后才能继续

    if (!this.lastFillAt.has(tokenId)) {
      this.lastFillAt.set(tokenId, Date.now());
    }

    const now = Date.now();
    if (this.wsEmergencyGlobalUntil > now) {
      return;
    }
    if (this.shouldEmergencyCancelGlobal()) {
      await this.cancelAllOpenOrders();
      const cooldown = Math.max(0, this.config.mmWsHealthEmergencyCooldownMs ?? 0);
      if (cooldown > 0) {
        this.wsEmergencyGlobalUntil = now + cooldown;
      }
      const recoveryMs = Math.max(0, this.config.mmWsHealthEmergencyRecoveryMs ?? 0);
      if (recoveryMs > 0) {
        this.wsEmergencyRecoveryUntil = now + recoveryMs;
        this.wsEmergencyRecoveryActive = true;
        this.wsEmergencyRecoveryStart = now;
        this.wsEmergencyRecoveryStage = -1;
      }
      const recoveryNote = recoveryMs > 0 ? `, recovery ${recoveryMs}ms` : '';
      console.log(`🧯 WS health low: emergency cancel-all${cooldown > 0 ? `, cooldown ${cooldown}ms` : ''}${recoveryNote}`);
      this.recordMmEvent(
        'WS_EMERGENCY_CANCEL',
        `Emergency cancel-all${cooldown > 0 ? `, cooldown ${cooldown}ms` : ''}${recoveryNote}`,
        tokenId
      );
      if (recoveryMs > 0) {
        this.recordMmEvent('WS_EMERGENCY_RECOVERY_START', `Emergency recovery window ${recoveryMs}ms`, tokenId);
      }
      this.markAction(tokenId);
      return;
    }
    if (this.isPaused(tokenId)) {
      return;
    }

    if (this.layerRestoreExitPending.get(tokenId)) {
      await this.cancelOrdersForMarket(tokenId);
      this.layerRestoreExitPending.delete(tokenId);
      const cooldown = Math.max(0, this.config.mmLayerRestoreExitCooldownMs ?? 0);
      const immediateRequote = this.config.mmLayerRestoreExitImmediateRequote === true;
      if (cooldown > 0) {
        if (immediateRequote) {
          this.cooldownUntil.delete(tokenId);
        } else {
          this.markCooldown(tokenId, cooldown);
        }
      }
      if (immediateRequote) {
        this.lastActionAt.delete(tokenId);
      } else {
        this.markAction(tokenId);
        return;
      }
    }

    const metrics = this.updateMarketMetrics(tokenId, orderbook);
    if (this.isSafeModeActive(tokenId, { volEma: metrics.volEma, depthTrend: metrics.depthTrend, depthSpeedBps: metrics.depthSpeedBps })) {
      const pauseMs = Math.max(0, this.config.mmSafeModePauseMs ?? 0);
      if (pauseMs > 0) {
        this.pauseUntil.set(tokenId, Date.now() + pauseMs);
      }
    }
    this.maybePauseForWsHealth(tokenId);
    if (this.isPaused(tokenId)) {
      if (this.config.mmVenue === 'polymarket') {
        const reason = this.pauseReasons.get(tokenId)?.reason || '冷却中';
        const state = this.setPolymarketExecutionState(tokenId, 'COOLDOWN', reason);
        market.polymarket_state = state.state;
        market.polymarket_state_reason = state.reason;
        market.polymarket_state_since_ms = state.since;
      }
      if (this.config.mmWsHealthCancelOnPause) {
        await this.cancelOrdersForMarket(tokenId);
      }
      return;
    }
    if (this.shouldEmergencyCancel(tokenId)) {
      await this.cancelOrdersForMarket(tokenId);
      const cooldown = Math.max(0, this.config.mmWsHealthEmergencyCooldownMs ?? 0);
      if (cooldown > 0) {
        this.markCooldown(tokenId, cooldown);
      }
      this.markAction(tokenId);
      return;
    }
    if (this.config.mmWsHealthReadOnly && this.getWsHealthRatio() > 0) {
      return;
    }
    if (this.layerRestoreExitRepricePending.has(tokenId)) {
      let effectiveMetrics = metrics;
      if (this.config.mmRestoreExitResync) {
        const freshBook = await this.api.getOrderbook(tokenId);
        effectiveMetrics = this.updateMarketMetrics(tokenId, freshBook);
      }
      const minShares = Math.max(0, this.config.mmRestoreExitMinDepthShares ?? 0);
      const minUsd = Math.max(0, this.config.mmRestoreExitMinDepthUsd ?? 0);
      if (
        (minShares > 0 && effectiveMetrics.topDepth < minShares) ||
        (minUsd > 0 && effectiveMetrics.topDepthUsd < minUsd)
      ) {
        await this.cancelOrdersForMarket(tokenId);
        const cooldown =
          Math.max(0, this.config.mmRestoreExitDepthCooldownMs ?? 0) ||
          (this.config.cooldownAfterCancelMs ?? 4000);
        this.markCooldown(tokenId, cooldown);
        return;
      }
      if (this.config.mmRestoreExitCleanupOnReprice) {
        await this.cancelOrdersForMarket(tokenId);
      }
    }

    if (!this.canSendAction(tokenId)) {
      return;
    }
    if (this.isLiquidityThin(metrics)) {
      console.log(`⚠️ Low liquidity for ${tokenId}, skipping quotes...`);
      await this.cancelOrdersForMarket(tokenId);
      this.markCooldown(tokenId, this.config.cooldownAfterCancelMs ?? 4000);
      this.markAction(tokenId);
      return;
    }

    const qualifiesForPoints = this.checkLiquidityPointsEligibility(market, orderbook);
    if (this.config.mmOnlyPointsMarkets && !qualifiesForPoints) {
      await this.cancelOrdersForMarket(tokenId);
      this.markCooldown(tokenId, this.config.cooldownAfterCancelMs ?? 4000);
      this.markAction(tokenId);
      return;
    }

    // ===== Layer 7: 定期优化自适应缓冲 =====
    this.optimizeAdaptiveBuffers();

    // ===== Layer 2: 动态市场筛选 =====
    const screenResult = this.screenMarket(market, orderbook);
    this.marketScreenResults.set(tokenId, { ...screenResult, ts: Date.now() });
    if (!screenResult.safe) {
      console.log(`🔍 LAYER2: ${tokenId.slice(0, 8)} 跳过不安全市场: ${screenResult.reason}`);
      await this.cancelOrdersForMarket(tokenId);
      this.markCooldown(tokenId, this.config.cooldownAfterCancelMs ?? 4000);
      this.markAction(tokenId);
      return;
    }

    // ===== Layer 3: 吃单概率预测 =====
    const fillRiskScore = this.calculateFillRisk(tokenId, orderbook, market);
    const fillRiskThreshold = this.config.mmFillRiskThreshold ?? 50;
    if (fillRiskScore > fillRiskThreshold) {
      console.log(`🎯 LAYER3: ${tokenId.slice(0, 8)} fillRisk=${fillRiskScore.toFixed(0)} > ${fillRiskThreshold}, 跳过`);
      await this.cancelOrdersForMarket(tokenId);
      this.markCooldown(tokenId, this.config.cooldownAfterCancelMs ?? 4000);
      this.markAction(tokenId);
      return;
    }

    // ===== Layer 5: 被吃后冷却检查 =====
    const fillCooldown = this.getFillCooldownRemaining(tokenId);
    if (fillCooldown > 0) {
      this.markCooldown(tokenId, fillCooldown);
      return;
    }

    // ===== Layer 4: 位置监控（在报价前检查）=====
    await this.monitorMyOrderPosition(market, orderbook);

    const spreadJump = this.checkSpreadJump(tokenId, orderbook);

    if (this.checkVolatility(tokenId, orderbook)) {
      console.log(`⚠️ Volatility spike detected for ${tokenId}, pausing quoting...`);
      await this.cancelOrdersForMarket(tokenId);
      this.markCooldown(tokenId, this.config.pauseAfterVolatilityMs ?? 8000);
      return;
    }

    if (this.shouldCancelOrders(tokenId, orderbook)) {
      console.log(`🚨 Price moved significantly for ${tokenId}, canceling orders...`);
      await this.cancelOrdersForMarket(tokenId);
      this.markCooldown(tokenId, this.config.cooldownAfterCancelMs ?? 4000);
      this.markAction(tokenId);
      return;
    }

    let prices = this.calculatePrices(market, orderbook);
    if (!prices) {
      if (this.config.mmVenue === 'polymarket' && (market.polymarket_state === 'EXIT' || market.polymarket_state === 'COOLDOWN')) {
        await this.cancelOrdersForMarket(tokenId);
      }
      if (spreadJump) {
        console.log(`⚠️ Spread jump detected for ${tokenId}, pausing quoting...`);
        await this.cancelOrdersForMarket(tokenId);
        this.markCooldown(tokenId, this.config.pauseAfterVolatilityMs ?? 8000);
      }
      return;
    }

    if (this.checkDepthSpeedSpike(tokenId)) {
      console.log(`⚠️ Depth speed spike for ${tokenId}, pausing quoting...`);
      await this.cancelOrdersForMarket(tokenId);
      this.markCooldown(tokenId, this.config.cooldownAfterCancelMs ?? 4000);
      return;
    }

    if (this.checkProtectiveMode(tokenId)) {
      console.log(`🛡️ Protective mode triggered for ${tokenId}, retreating quotes...`);
      await this.cancelOrdersForMarket(tokenId);
      this.markAction(tokenId);
      this.recordMmEvent('PROTECTIVE_MODE', 'depth+spread spike', tokenId);
      return;
    }

    if (spreadJump && !this.isProtectiveActive(tokenId)) {
      console.log(`⚠️ Spread jump detected for ${tokenId}, pausing quoting...`);
      await this.cancelOrdersForMarket(tokenId);
      this.markCooldown(tokenId, this.config.pauseAfterVolatilityMs ?? 8000);
      return;
    }

    const rawProfile = this.resolveAdaptiveProfile(metrics.volEma, metrics.depthEma, metrics.depthTrend);
    const profile = this.stabilizeProfile(tokenId, rawProfile);

    this.recordMmMetrics(market, orderbook, prices, profile, metrics);

    let existingOrders = Array.from(this.openOrders.values()).filter(
      (o) => o.token_id === tokenId && o.status === 'OPEN'
    );
    existingOrders = await this.trimExcessOrders(tokenId, existingOrders);

    const existingBids = existingOrders
      .filter((o) => o.side === 'BUY')
      .sort((a, b) => Number(b.price) - Number(a.price));
    const existingAsks = existingOrders
      .filter((o) => o.side === 'SELL')
      .sort((a, b) => Number(a.price) - Number(b.price));

    const layerCount = this.getEffectiveLayerCount(
      tokenId,
      profile,
      metrics.depthTrend,
      metrics.depthSpeedBps
    );
    const riskThrottleLocal = this.getRiskThrottleFactor(tokenId);
    const riskThrottleGlobal = this.getRiskThrottleFactor('__global__');
    const riskThrottle = Math.min(riskThrottleLocal, riskThrottleGlobal);
    const riskOnlyFarThreshold = Math.max(0, this.config.mmRiskThrottleOnlyFarThreshold ?? 0);
    const riskOnlyFarActive = riskOnlyFarThreshold > 0 && riskThrottle <= riskOnlyFarThreshold;
    const cancelBurstActive = this.isCancelBurstActive(tokenId);
    const rampedLayerCount = this.getRestoreExitRampCap(tokenId, layerCount);
    let layerStepBps = this.getEffectiveLayerStepBps(
      tokenId,
      profile,
      metrics.depthTrend,
      metrics.depthSpeedBps
    );
    const safeModeActive = this.isSafeModeActive(tokenId, {
      volEma: metrics.volEma,
      depthTrend: metrics.depthTrend,
      depthSpeedBps: metrics.depthSpeedBps,
    });
    if (safeModeActive) {
      const stepMult = Math.max(1, this.config.mmSafeModeStepMult ?? 1);
      layerStepBps *= stepMult;
    }
    let bidPriceBase = prices.bidPrice;
    let askPriceBase = prices.askPrice;
    const panicSingleSide = this.isLayerPanicActive(tokenId)
      ? (this.config.mmPanicSingleSide || 'NONE').toUpperCase()
      : 'NONE';
    const protectiveActive = this.isProtectiveActive(tokenId);
    let protectiveSingleSide =
      panicSingleSide === 'NONE' && protectiveActive
        ? (this.config.mmProtectiveSingleSide || 'NONE').toUpperCase()
        : 'NONE';
    if (protectiveActive && this.getProtectiveConfig().singleSideAuto) {
      const inventoryBias = this.calculateInventoryBias(tokenId);
      const imbalance = this.calculateOrderbookImbalance(orderbook);
      const threshold = Math.max(0, this.config.mmProtectiveSingleSideImbalanceThreshold ?? 0.15);
      const signal = inventoryBias - imbalance;
      if (Math.abs(signal) >= threshold) {
        protectiveSingleSide = signal > 0 ? 'SELL' : 'BUY';
      }
    }
    const safeSingleSide =
      panicSingleSide === 'NONE' && !protectiveActive && safeModeActive
        ? (this.config.mmSafeModeSingleSide || 'NONE').toUpperCase()
        : 'NONE';
    const effectiveSingleSide =
      panicSingleSide !== 'NONE' ? panicSingleSide : protectiveSingleSide !== 'NONE' ? protectiveSingleSide : safeSingleSide;
    const panicSingleSideOffsetBps = Math.max(0, this.config.mmPanicSingleSideOffsetBps ?? 0);
    const protectiveSingleSideOffsetBps = Math.max(0, this.getProtectiveConfig().singleSideOffsetBps);
    const safeSingleSideOffsetBps = Math.max(0, this.config.mmSafeModeSingleSideOffsetBps ?? 0);
    const singleSideOffsetBps =
      panicSingleSide !== 'NONE'
        ? panicSingleSideOffsetBps
        : protectiveSingleSide !== 'NONE'
          ? protectiveSingleSideOffsetBps
          : safeSingleSideOffsetBps;
    if (protectiveSingleSide === 'NONE' && protectiveActive) {
      const add = Math.max(0, this.getProtectiveConfig().touchBufferAddBps);
      if (add > 0) {
        bidPriceBase = Math.max(0.01, bidPriceBase * (1 - add / 10000));
        askPriceBase = Math.min(0.99, askPriceBase * (1 + add / 10000));
      }
    }
    if (singleSideOffsetBps > 0 && effectiveSingleSide !== 'NONE') {
      const offset = singleSideOffsetBps / 10000;
      if (effectiveSingleSide === 'BUY') {
        bidPriceBase = Math.max(0.01, bidPriceBase * (1 - offset));
      } else if (effectiveSingleSide === 'SELL') {
        askPriceBase = Math.min(0.99, askPriceBase * (1 + offset));
      }
    }
    const bidTargets = this.buildLayerTargets(bidPriceBase, 'BUY', rampedLayerCount, layerStepBps);
    const askTargets = this.buildLayerTargets(askPriceBase, 'SELL', rampedLayerCount, layerStepBps);
    const bidLayers = bidTargets.length;
    const askLayers = askTargets.length;
    const canceledOrders = new Set<string>();
    const pendingCancels: Array<{ order: Order; priority: number; panic: boolean; reason: string }> = [];
    const enqueueCancel = (
      order: Order,
      meta?: { priority?: number; panic?: boolean; reason?: string }
    ) => {
      if (canceledOrders.has(order.order_hash)) {
        return;
      }
      canceledOrders.add(order.order_hash);
      pendingCancels.push({
        order,
        priority: meta?.priority ?? 0,
        panic: meta?.panic ?? false,
        reason: meta?.reason ?? 'unknown',
      });
    };

    for (let i = 0; i < existingBids.length; i += 1) {
      const existingBid = existingBids[i];
      const targetPrice = bidTargets[i];
      if (targetPrice === undefined) {
        enqueueCancel(existingBid, { priority: 0, reason: 'excess-layer', panic: false });
        continue;
      }
      let risk = this.evaluateOrderRisk(existingBid, orderbook);
      let shouldReprice = this.shouldRepriceOrder(existingBid, targetPrice);
      const minLifetimeMs = Math.max(0, this.config.mmMinOrderLifetimeMs ?? 0);
      if (minLifetimeMs > 0) {
        const age = Date.now() - existingBid.timestamp;
        const bypass = this.config.mmMinOrderLifetimePanicBypass !== false;
        if (age < minLifetimeMs && !(risk.panic && bypass)) {
          continue;
        }
      }
      if (this.layerRestoreExitRepricePending.has(tokenId)) {
        shouldReprice = true;
      }
      if ((risk.cancel || shouldReprice) && this.canRecheck(tokenId)) {
        const delay = risk.cancel
          ? Math.max(0, this.config.mmCancelRecheckMs ?? 0)
          : Math.max(0, this.config.mmRepriceRecheckMs ?? 0);
        if (delay > 0) {
          await this.sleep(delay);
          const freshBook = await this.api.getOrderbook(tokenId);
          if (risk.cancel) {
            const freshRisk = this.evaluateOrderRisk(existingBid, freshBook);
            risk = freshRisk;
          }
          if (shouldReprice) {
            const freshPrices = this.calculatePrices(market, freshBook);
            if (freshPrices) {
              prices = freshPrices;
              const refreshTargets = this.buildLayerTargets(prices.bidPrice, 'BUY', layerCount, layerStepBps);
              const nextTarget = refreshTargets[i] ?? targetPrice;
              shouldReprice = this.shouldRepriceOrder(existingBid, nextTarget);
            }
          }
        }
      }
        if (risk.cancel || shouldReprice) {
          if (this.config.mmVenue === 'polymarket') {
            this.recordPolymarketCancelReason(tokenId, risk.reason || (shouldReprice ? 'reprice' : 'other'));
            if (await this.maybeTripPolymarketCancelPatternFuse(tokenId, market)) {
              continue;
            }
          }
          if (!this.allowCancel(tokenId, risk.panic)) {
            this.recordMmEvent('CANCEL_BUDGET_SKIP', `${risk.reason || 'budget'}`, tokenId);
            continue;
          }
          if (risk.reason.startsWith('near-touch') || risk.reason === 'anti-fill') {
            const penalty = Math.max(0, this.config.mmRiskThrottleNearTouchPenalty ?? 0);
            if (penalty > 0) {
              this.addRiskThrottle(tokenId, penalty);
              this.addRiskThrottle('__global__', penalty * 0.5);
            }
            const count = this.recordNearTouch(tokenId);
            const limit = Math.max(1, this.config.mmNearTouchBurstLimit ?? 0);
            if (limit > 0 && count >= limit) {
              const hold = Math.max(0, this.config.mmNearTouchBurstHoldMs ?? 0);
              if (hold > 0) {
                this.applyLayerRetreatFor(tokenId, hold);
              }
              if (this.config.mmNearTouchBurstSafeMode) {
                this.safeModeExitUntil.set(tokenId, Date.now() + Math.max(0, this.config.mmNearTouchBurstSafeModeMs ?? hold));
              }
            }
          } else if (risk.reason === 'refresh' || shouldReprice) {
            const penalty = Math.max(0, this.config.mmRiskThrottleCancelPenalty ?? 0);
            if (penalty > 0) {
              this.addRiskThrottle(tokenId, penalty);
            this.addRiskThrottle('__global__', penalty * 0.4);
          }
        }
        if (
          risk.cancel &&
          (risk.reason.startsWith('near-touch') ||
            risk.reason === 'anti-fill' ||
            risk.reason.startsWith('hit-warning') ||
            risk.reason === 'aggressive-move' ||
            risk.reason === 'price-accel' ||
            risk.reason === 'vwap-risk' ||
            risk.reason.startsWith('restore-no-near-touch'))
        ) {
          const intensity = risk.panic ? 1.5 : 1;
          this.applyNearTouchPenalty(tokenId, intensity);
          if (risk.panic) {
            this.applyLayerPanic(tokenId);
            const panicPause = Math.max(0, this.config.mmPanicPauseMs ?? 0);
            if (panicPause > 0) {
              this.pauseUntil.set(tokenId, Date.now() + panicPause);
            }
          }
          const sizePenalty = this.config.mmNearTouchSizePenalty ?? 0;
          if (sizePenalty > 0 && sizePenalty < 1) {
            this.applySizePenalty(tokenId, sizePenalty, true);
          }
        }
        const cancelPriority = risk.panic
          ? 3
          : risk.cancel &&
              (risk.reason.startsWith('near-touch') ||
                risk.reason === 'anti-fill' ||
                risk.reason.startsWith('hit-warning') ||
                risk.reason === 'aggressive-move' ||
                risk.reason === 'price-accel' ||
                risk.reason === 'vwap-risk' ||
                risk.reason.startsWith('restore-no-near-touch'))
            ? 2
            : 1;
        enqueueCancel(existingBid, { priority: cancelPriority, panic: risk.panic, reason: risk.reason || '' });
        const softCooldown = this.config.mmSoftCancelCooldownMs ?? (this.config.cooldownAfterCancelMs ?? 4000);
        const hardCooldown = this.config.mmHardCancelCooldownMs ?? (this.config.cooldownAfterCancelMs ?? 4000);
        const baseCooldown = risk.panic ? hardCooldown : softCooldown;
        let cooldown = this.getAdaptiveCooldown(tokenId, baseCooldown);
        if (this.isLayerPanicActive(tokenId)) {
          const mult = Math.max(1, this.config.mmPanicCooldownMult ?? 1);
          cooldown = Math.round(cooldown * mult);
        } else if (this.isLayerRestoreActive(tokenId)) {
          const mult = Math.max(1, this.config.mmRestoreCooldownMult ?? 1);
          cooldown = Math.round(cooldown * mult);
        }
        if (this.isSafeModeActive(tokenId, { volEma: metrics.volEma, depthTrend: metrics.depthTrend, depthSpeedBps: metrics.depthSpeedBps })) {
          const mult = Math.max(1, this.config.mmSafeModeCooldownMult ?? 1);
          cooldown = Math.round(cooldown * mult);
        }
        if (risk.panic) {
          this.pauseForVolatility(tokenId);
          this.markCooldown(tokenId, cooldown + 2000);
        } else {
          this.markCooldown(tokenId, cooldown);
        }
      }
    }

    for (let i = 0; i < existingAsks.length; i += 1) {
      const existingAsk = existingAsks[i];
      const targetPrice = askTargets[i];
      if (targetPrice === undefined) {
        enqueueCancel(existingAsk, { priority: 0, reason: 'excess-layer', panic: false });
        continue;
      }
      let risk = this.evaluateOrderRisk(existingAsk, orderbook);
      let shouldReprice = this.shouldRepriceOrder(existingAsk, targetPrice);
      const minLifetimeMs = Math.max(0, this.config.mmMinOrderLifetimeMs ?? 0);
      if (minLifetimeMs > 0) {
        const age = Date.now() - existingAsk.timestamp;
        const bypass = this.config.mmMinOrderLifetimePanicBypass !== false;
        if (age < minLifetimeMs && !(risk.panic && bypass)) {
          continue;
        }
      }
      if (this.layerRestoreExitRepricePending.has(tokenId)) {
        shouldReprice = true;
      }
      if ((risk.cancel || shouldReprice) && this.canRecheck(tokenId)) {
        const delay = risk.cancel
          ? Math.max(0, this.config.mmCancelRecheckMs ?? 0)
          : Math.max(0, this.config.mmRepriceRecheckMs ?? 0);
        if (delay > 0) {
          await this.sleep(delay);
          const freshBook = await this.api.getOrderbook(tokenId);
          if (risk.cancel) {
            const freshRisk = this.evaluateOrderRisk(existingAsk, freshBook);
            risk = freshRisk;
          }
          if (shouldReprice) {
            const freshPrices = this.calculatePrices(market, freshBook);
            if (freshPrices) {
              prices = freshPrices;
              const refreshTargets = this.buildLayerTargets(prices.askPrice, 'SELL', layerCount, layerStepBps);
              const nextTarget = refreshTargets[i] ?? targetPrice;
              shouldReprice = this.shouldRepriceOrder(existingAsk, nextTarget);
            }
          }
        }
      }
        if (risk.cancel || shouldReprice) {
          if (this.config.mmVenue === 'polymarket') {
            this.recordPolymarketCancelReason(tokenId, risk.reason || (shouldReprice ? 'reprice' : 'other'));
            if (await this.maybeTripPolymarketCancelPatternFuse(tokenId, market)) {
              continue;
            }
          }
          if (!this.allowCancel(tokenId, risk.panic)) {
            this.recordMmEvent('CANCEL_BUDGET_SKIP', `${risk.reason || 'budget'}`, tokenId);
            continue;
          }
          if (risk.reason.startsWith('near-touch') || risk.reason === 'anti-fill') {
            const penalty = Math.max(0, this.config.mmRiskThrottleNearTouchPenalty ?? 0);
            if (penalty > 0) {
              this.addRiskThrottle(tokenId, penalty);
              this.addRiskThrottle('__global__', penalty * 0.5);
            }
            const count = this.recordNearTouch(tokenId);
            const limit = Math.max(1, this.config.mmNearTouchBurstLimit ?? 0);
            if (limit > 0 && count >= limit) {
              const hold = Math.max(0, this.config.mmNearTouchBurstHoldMs ?? 0);
              if (hold > 0) {
                this.applyLayerRetreatFor(tokenId, hold);
              }
              if (this.config.mmNearTouchBurstSafeMode) {
                this.safeModeExitUntil.set(tokenId, Date.now() + Math.max(0, this.config.mmNearTouchBurstSafeModeMs ?? hold));
              }
            }
          } else if (risk.reason === 'refresh' || shouldReprice) {
            const penalty = Math.max(0, this.config.mmRiskThrottleCancelPenalty ?? 0);
            if (penalty > 0) {
              this.addRiskThrottle(tokenId, penalty);
            this.addRiskThrottle('__global__', penalty * 0.4);
          }
        }
        if (
          risk.cancel &&
          (risk.reason.startsWith('near-touch') ||
            risk.reason === 'anti-fill' ||
            risk.reason.startsWith('hit-warning') ||
            risk.reason === 'aggressive-move' ||
            risk.reason === 'price-accel' ||
            risk.reason === 'vwap-risk' ||
            risk.reason.startsWith('restore-no-near-touch'))
        ) {
          const intensity = risk.panic ? 1.5 : 1;
          this.applyNearTouchPenalty(tokenId, intensity);
          if (risk.panic) {
            this.applyLayerPanic(tokenId);
            const panicPause = Math.max(0, this.config.mmPanicPauseMs ?? 0);
            if (panicPause > 0) {
              this.pauseUntil.set(tokenId, Date.now() + panicPause);
            }
          }
          const sizePenalty = this.config.mmNearTouchSizePenalty ?? 0;
          if (sizePenalty > 0 && sizePenalty < 1) {
            this.applySizePenalty(tokenId, sizePenalty, true);
          }
        }
        const cancelPriority = risk.panic
          ? 3
          : risk.cancel &&
              (risk.reason.startsWith('near-touch') ||
                risk.reason === 'anti-fill' ||
                risk.reason.startsWith('hit-warning') ||
                risk.reason === 'aggressive-move' ||
                risk.reason === 'price-accel' ||
                risk.reason === 'vwap-risk' ||
                risk.reason.startsWith('restore-no-near-touch'))
            ? 2
            : 1;
        enqueueCancel(existingAsk, { priority: cancelPriority, panic: risk.panic, reason: risk.reason || '' });
        const softCooldown = this.config.mmSoftCancelCooldownMs ?? (this.config.cooldownAfterCancelMs ?? 4000);
        const hardCooldown = this.config.mmHardCancelCooldownMs ?? (this.config.cooldownAfterCancelMs ?? 4000);
        const baseCooldown = risk.panic ? hardCooldown : softCooldown;
        let cooldown = this.getAdaptiveCooldown(tokenId, baseCooldown);
        if (this.isLayerPanicActive(tokenId)) {
          const mult = Math.max(1, this.config.mmPanicCooldownMult ?? 1);
          cooldown = Math.round(cooldown * mult);
        } else if (this.isLayerRestoreActive(tokenId)) {
          const mult = Math.max(1, this.config.mmRestoreCooldownMult ?? 1);
          cooldown = Math.round(cooldown * mult);
        }
        if (this.isSafeModeActive(tokenId, { volEma: metrics.volEma, depthTrend: metrics.depthTrend, depthSpeedBps: metrics.depthSpeedBps })) {
          const mult = Math.max(1, this.config.mmSafeModeCooldownMult ?? 1);
          cooldown = Math.round(cooldown * mult);
        }
        if (risk.panic) {
          this.pauseForVolatility(tokenId);
          this.markCooldown(tokenId, cooldown + 2000);
        } else {
          this.markCooldown(tokenId, cooldown);
        }
      }
    }

    let cancelBatch = pendingCancels;
    const cancelCap = Math.max(0, this.config.mmCancelMaxPerCycle ?? 0);
    if (cancelCap > 0 && pendingCancels.length > cancelCap) {
      const panicBypass = this.config.mmCancelMaxPerCyclePanicBypass !== false;
      const sorted = [...pendingCancels].sort((a, b) => b.priority - a.priority);
      let selected: typeof pendingCancels;
      if (panicBypass) {
        const panic = sorted.filter((item) => item.panic);
        const nonPanic = sorted.filter((item) => !item.panic);
        const remaining = Math.max(0, cancelCap - panic.length);
        selected = panic.concat(nonPanic.slice(0, remaining));
      } else {
        selected = sorted.slice(0, cancelCap);
      }
      const selectedSet = new Set(selected.map((item) => item.order.order_hash));
      const skipped = sorted.filter((item) => !selectedSet.has(item.order.order_hash));
      if (skipped.length > 0) {
        this.recordMmEvent(
          'CANCEL_QUEUE_LIMIT',
          `keep=${selectedSet.size} skip=${skipped.length} cap=${cancelCap}`,
          tokenId
        );
      }
      cancelBatch = selected;
    }

    await this.cancelOrdersBatch(
      cancelBatch.map((item) => item.order),
      'quote-refresh'
    );

    const refreshedOrders = Array.from(this.openOrders.values()).filter(
      (o) => o.token_id === tokenId && o.status === 'OPEN'
    );

    // FIX H2: 按价格匹配而非索引匹配
    const remainingBids = refreshedOrders
      .filter((o) => o.side === 'BUY' && !canceledOrders.has(o.order_hash))
      .sort((a, b) => Number(b.price) - Number(a.price));
    const remainingAsks = refreshedOrders
      .filter((o) => o.side === 'SELL' && !canceledOrders.has(o.order_hash))
      .sort((a, b) => Number(a.price) - Number(b.price));

    // 找每个target最近的已有订单（在0.1c范围内视为匹配）
    const PRICE_MATCH_TOLERANCE = 0.001; // 0.1c
    const isOrderNearTarget = (orderPrice: number, targetPrice: number): boolean => {
      return Math.abs(orderPrice - targetPrice) <= PRICE_MATCH_TOLERANCE;
    };

    // 为每个target找匹配的已有订单
    const matchedBidHashes = new Set<string>();
    const matchedAskHashes = new Set<string>();
    for (const target of bidTargets) {
      const match = remainingBids.find(o => !matchedBidHashes.has(o.order_hash) && isOrderNearTarget(Number(o.price), target));
      if (match) matchedBidHashes.add(match.order_hash);
    }
    for (const target of askTargets) {
      const match = remainingAsks.find(o => !matchedAskHashes.has(o.order_hash) && isOrderNearTarget(Number(o.price), target));
      if (match) matchedAskHashes.add(match.order_hash);
    }
    let hasBid = remainingBids.length > 0;
    let hasAsk = remainingAsks.length > 0;
    if (this.layerRestoreExitRepricePending.has(tokenId)) {
      this.layerRestoreExitRepricePending.delete(tokenId);
    }

    const bidOrderSize = this.calculateOrderSize(market, orderbook, 'BUY', prices.bidPrice);
    const askOrderSize = this.calculateOrderSize(market, orderbook, 'SELL', prices.askPrice);

    const profileScale = profile === 'CALM' ? 1.0 : profile === 'VOLATILE' ? 0.6 : 0.85;
    if (riskThrottle < 1) {
      const multiplier = Math.min(1, riskThrottle);
      layerStepBps = layerStepBps * (1 + (1 - multiplier));
      bidPriceBase = Math.max(0.01, bidPriceBase * (1 - (1 - multiplier) * 0.5));
      askPriceBase = Math.min(0.99, askPriceBase * (1 + (1 - multiplier) * 0.5));
    }
    const canIceberg = this.config.mmIcebergEnabled && this.canRequoteIceberg(tokenId, metrics.depthTrend);
    if (canIceberg) {
      await this.cancelOrdersForMarket(tokenId);
      hasBid = false;
      hasAsk = false;
    }

    console.log(`📝 Market ${market.question.substring(0, 40)}...`);
    const valueInfo =
      prices.valueConfidence && Math.abs(prices.valueBias ?? 0) > 0
        ? ` valueBias=${prices.valueBias?.toFixed(4)} conf=${(prices.valueConfidence * 100).toFixed(0)}%`
        : '';

    const imbalance = prices.imbalance ?? this.calculateOrderbookImbalance(orderbook);
    const depthInfo = prices.depth && prices.depth > 0 ? ` depth=${prices.depth.toFixed(0)}` : '';
    console.log(
      `   bid=${prices.bidPrice.toFixed(4)} ask=${prices.askPrice.toFixed(4)} spread=${(prices.spread * 100).toFixed(2)}% ` +
        `bias=${prices.inventoryBias.toFixed(2)} imb=${imbalance.toFixed(2)}${depthInfo}${valueInfo} ${qualifiesForPoints ? '✨' : ''} profile=${profile}`
    );

    // ===== Phase 1: 使用 InventoryClassifier 的单边挂单策略 =====
    let suppressBuy = false;
    let suppressSell = false;

    if (this.config.mmEnhancedSpreadEnabled !== false) {
      const inventoryBias = this.calculateInventoryBias(market.token_id);
      const inventoryState = this.perMarketInventoryState.get(market.token_id);
      if (inventoryState) {
        const strategy = this.inventoryClassifier.getStrategy(
          inventoryState,
          Math.round(inventoryBias * this.getEffectiveMaxPosition()),
          this.getEffectiveMaxPosition()
        );

        // 使用策略中的单边挂单配置
        if (strategy.singleSide === 'BUY') {
          suppressSell = true;  // 只允许买单，不挂卖单
          console.log(`   📊 Single-side mode: BUY only (inventory bias: ${(inventoryBias * 100).toFixed(1)}%)`);
        } else if (strategy.singleSide === 'SELL') {
          suppressBuy = true;   // 只允许卖单，不挂买单
          console.log(`   📊 Single-side mode: SELL only (inventory bias: ${(inventoryBias * 100).toFixed(1)}%)`);
        }

        // 如果不允许挂单，抑制双边
        if (!strategy.allowOrders) {
          suppressBuy = true;
          suppressSell = true;
          console.log(`   🛑 Orders suspended: ${inventoryState} state`);
        }
      }
    }

    // 兜底逻辑：如果没有启用 Phase 1，使用原来的硬编码阈值
    if (!suppressBuy && !suppressSell) {
      suppressBuy = prices.inventoryBias > 0.85;
      suppressSell = prices.inventoryBias < -0.85;
    }

    const polymarketAdverse = this.getPolymarketAdverseSuppression(market, orderbook, prices, metrics);
    if (polymarketAdverse.suppressBuy) {
      suppressBuy = true;
    }
    if (polymarketAdverse.suppressSell) {
      suppressSell = true;
    }
    if ((polymarketAdverse.suppressBuy || polymarketAdverse.suppressSell) && polymarketAdverse.reason) {
      console.log(`   🛡️ Polymarket adverse guard: ${polymarketAdverse.reason}`);
      this.recordMmEvent('POLYMARKET_ADVERSE_GUARD', polymarketAdverse.reason, tokenId);
    }

    let placedBuy = false;
    let placedSell = false;
    const allowBelowMin = this.config.mmLayerAllowBelowMinShares === true;
    let sizeFloor = 1;
    if (this.isLayerPanicActive(tokenId)) {
      const floor = this.config.mmLayerPanicSizeMinFactor ?? 0;
      if (floor > 0) {
        sizeFloor = Math.min(sizeFloor, floor);
      }
    }
    if (this.isLayerRetreatActive(tokenId)) {
      const floor = this.config.mmLayerRetreatSizeMinFactor ?? 0;
      if (floor > 0) {
        sizeFloor = Math.min(sizeFloor, floor);
      }
    }
    if (this.isLayerRestoreActive(tokenId)) {
      const floor = this.config.mmLayerRestoreSizeMinFactor ?? 0;
      if (floor > 0) {
        sizeFloor = Math.min(sizeFloor, floor);
      }
    }
    const speedFloor = this.config.mmLayerSpeedSizeMinFactor ?? 0;
    const retreatFloor = this.config.mmLayerRetreatSizeMinFactor ?? 0;
    if (speedFloor > 0 && metrics.depthSpeedBps >= (this.config.mmLayerDepthSpeedBps ?? 0)) {
      sizeFloor = Math.min(sizeFloor, speedFloor);
    }
    if (retreatFloor > 0 && metrics.depthSpeedBps >= (this.config.mmLayerDepthSpeedRetreatBps ?? 0)) {
      sizeFloor = Math.min(sizeFloor, retreatFloor);
    }
    const liquidityRules = this.getEffectiveLiquidityActivation(market);
    const minShares = liquidityRules?.min_shares || 0;
    let targetBidShares = Math.max(1, Math.floor(bidOrderSize.shares * profileScale));
    let targetAskShares = Math.max(1, Math.floor(askOrderSize.shares * profileScale));
    if (riskThrottle < 1) {
      targetBidShares = Math.max(1, Math.floor(targetBidShares * riskThrottle));
      targetAskShares = Math.max(1, Math.floor(targetAskShares * riskThrottle));
    }
    if (this.isLayerRestoreActive(tokenId)) {
      const scale = this.config.mmLayerRestoreSizeScale ?? 0;
      if (scale > 0 && scale < 1) {
        targetBidShares = Math.max(1, Math.floor(targetBidShares * scale));
        targetAskShares = Math.max(1, Math.floor(targetAskShares * scale));
      }
      const panicScale = this.config.mmPanicRestoreSizeScale ?? 0;
      if (panicScale > 0 && panicScale < 1) {
        targetBidShares = Math.max(1, Math.floor(targetBidShares * panicScale));
        targetAskShares = Math.max(1, Math.floor(targetAskShares * panicScale));
      }
    }
    if (safeModeActive) {
      const scale = this.config.mmSafeModeSizeScale ?? 0;
      if (scale > 0 && scale < 1) {
        targetBidShares = Math.max(1, Math.floor(targetBidShares * scale));
        targetAskShares = Math.max(1, Math.floor(targetAskShares * scale));
      }
    }
    if (this.isProtectiveActive(tokenId)) {
      const scale = this.getProtectiveConfig().sizeScale;
      if (scale > 0 && scale < 1) {
        targetBidShares = Math.max(1, Math.floor(targetBidShares * scale));
        targetAskShares = Math.max(1, Math.floor(targetAskShares * scale));
      }
    }
    const wsSizeScale = this.getWsHealthSizeScale();
    if (wsSizeScale > 0 && wsSizeScale < 1) {
      targetBidShares = Math.max(1, Math.floor(targetBidShares * wsSizeScale));
      targetAskShares = Math.max(1, Math.floor(targetAskShares * wsSizeScale));
    }
    const cooldownUntil = this.cooldownUntil.get(tokenId) || 0;
    if (cooldownUntil > Date.now()) {
      if (this.isLayerPanicActive(tokenId)) {
        const scale = this.config.mmPanicCooldownSizeScale ?? 0;
        if (scale > 0 && scale < 1) {
          targetBidShares = Math.max(1, Math.floor(targetBidShares * scale));
          targetAskShares = Math.max(1, Math.floor(targetAskShares * scale));
        }
      } else if (this.isLayerRestoreActive(tokenId)) {
        const scale = this.config.mmRestoreCooldownSizeScale ?? 0;
        if (scale > 0 && scale < 1) {
          targetBidShares = Math.max(1, Math.floor(targetBidShares * scale));
          targetAskShares = Math.max(1, Math.floor(targetAskShares * scale));
        }
      }
    }
    const exitSizeFactor = this.getRestoreExitSizeFactor(tokenId);
    if (exitSizeFactor < 1) {
      targetBidShares = Math.max(1, Math.floor(targetBidShares * exitSizeFactor));
      targetAskShares = Math.max(1, Math.floor(targetAskShares * exitSizeFactor));
    }

    if (effectiveSingleSide === 'BUY') {
      targetAskShares = 0;
    } else if (effectiveSingleSide === 'SELL') {
      targetBidShares = 0;
    }
    const wsSingle = this.getWsHealthSingleSide();
    const wsSparse = this.shouldSparseWs();
    if (wsSingle.side === 'BUY') {
      targetAskShares = 0;
    } else if (wsSingle.side === 'SELL') {
      targetBidShares = 0;
    }
    const protectiveOnlyFar = this.isProtectiveActive(tokenId) && this.getProtectiveConfig().onlyFar;
    const restoreCap =
      this.isLayerRestoreActive(tokenId) && this.config.mmLayerRestoreMaxShares
        ? Math.max(1, this.config.mmLayerRestoreMaxShares)
        : 0;
    const bidSizeBase = restoreCap > 0 ? Math.min(targetBidShares, restoreCap) : targetBidShares;
    const askSizeBase = restoreCap > 0 ? Math.min(targetAskShares, restoreCap) : targetAskShares;
    const bidSizes = this.buildLayerSizes(bidSizeBase, minShares, allowBelowMin, layerCount, sizeFloor).slice(0, bidLayers);
    const askSizes = this.buildLayerSizes(askSizeBase, minShares, allowBelowMin, layerCount, sizeFloor).slice(0, askLayers);

    const retreatOnlyFar =
      this.config.mmLayerRetreatOnlyFar === true &&
      (this.isLayerRetreatActive(tokenId) ||
        (this.config.mmLayerDepthSpeedRetreatBps &&
          metrics.depthSpeedBps >= this.config.mmLayerDepthSpeedRetreatBps));
    const restoreOnlyFar = this.config.mmLayerRestoreOnlyFar === true && this.isLayerRestoreActive(tokenId);
    const panicOnlyFar = this.config.mmLayerPanicOnlyFar === true && this.isLayerPanicActive(tokenId);
    const panicSingleSideMode = (this.config.mmPanicSingleSideMode || 'NORMAL').toUpperCase();
    const panicRemoteOnly = panicSingleSide !== 'NONE' && panicSingleSideMode === 'REMOTE';
    const protectiveSingleSideMode = this.getProtectiveConfig().singleSideMode;
    const protectiveRemoteOnly = protectiveSingleSide !== 'NONE' && protectiveSingleSideMode === 'REMOTE';
    const safeSingleSideMode = (this.config.mmSafeModeSingleSideMode || 'NORMAL').toUpperCase();
    const safeRemoteOnly = safeSingleSide !== 'NONE' && safeSingleSideMode === 'REMOTE';
    const riskOnlyFarLayers = riskOnlyFarActive ? Math.max(0, this.config.mmRiskThrottleOnlyFarLayers ?? 0) : 0;
    const riskOnlyFar = riskOnlyFarActive && riskOnlyFarLayers <= 0;
    const cancelBurstOnlyFarLayers = cancelBurstActive ? Math.max(0, this.config.mmCancelBurstOnlyFarLayers ?? 0) : 0;
    const cancelBurstForceFar = cancelBurstActive && this.config.mmCancelBurstOnlyFar === true;
    const cancelBurstOnlyFar = cancelBurstForceFar && cancelBurstOnlyFarLayers <= 0;
    let wsSingleSideMode = (wsSingle.mode || 'NORMAL').toUpperCase();
    let wsRemoteOnly = wsSingle.side !== 'NONE' && wsSingleSideMode === 'REMOTE';
    if (this.isWsEmergencyRecoveryActive() && this.config.mmWsHealthEmergencyRecoveryTemplateEnabled) {
      wsSingleSideMode = 'REMOTE';
      wsRemoteOnly = wsSingle.side !== 'NONE';
    }
    const forceSingle = this.shouldForceSingleLayer(tokenId);
    const wsOnlyFar = this.shouldForceOnlyFarWs();
    const safeModeOnlyFar = safeModeActive && this.config.mmSafeModeOnlyFar === true;
    const farOnly =
      retreatOnlyFar ||
      restoreOnlyFar ||
      panicOnlyFar ||
      panicRemoteOnly ||
      protectiveRemoteOnly ||
      safeRemoteOnly ||
      protectiveOnlyFar ||
      safeModeOnlyFar ||
      wsRemoteOnly ||
      riskOnlyFar ||
      cancelBurstOnlyFar;
    const safeOnlyFarLayers = safeModeActive ? Math.max(0, this.config.mmSafeModeOnlyFarLayers ?? 0) : 0;
    const extraOnlyFarLayers = Math.max(safeOnlyFarLayers, riskOnlyFarLayers, cancelBurstOnlyFarLayers);
    let bidStart = farOnly
      ? bidLayers - 1
      : extraOnlyFarLayers > 0
        ? Math.max(0, bidLayers - extraOnlyFarLayers)
        : 0;
    let askStart = farOnly
      ? askLayers - 1
      : extraOnlyFarLayers > 0
        ? Math.max(0, askLayers - extraOnlyFarLayers)
        : 0;
    if (wsOnlyFar || this.isWsEmergencyRecoveryActive()) {
      let farLayers = Math.max(0, this.config.mmWsHealthOnlyFarLayers ?? 0);
      if (this.isWsUltraSafeActive()) {
        const ultraLayers = Math.max(0, this.config.mmWsHealthUltraSafeFarLayers ?? 1);
        farLayers = Math.max(farLayers, ultraLayers);
      }
      if (this.isWsEmergencyRecoveryActive()) {
        const recoveryFar = Math.max(1, this.getWsEmergencyRecoveryInfo().farLayers);
        farLayers = Math.max(farLayers, recoveryFar);
      }
      if (farLayers > 0) {
        bidStart = Math.max(bidStart, Math.max(0, bidLayers - farLayers));
        askStart = Math.max(askStart, Math.max(0, askLayers - farLayers));
      } else {
        bidStart = Math.max(0, bidLayers - 1);
        askStart = Math.max(0, askLayers - 1);
      }
    }
    const restoreSparse = this.isLayerRestoreActive(tokenId) && this.config.mmLayerRestoreSparseOdd;
    const sparseOdd = restoreSparse || wsSparse;

    const recoveryIcebergRatio = this.isWsEmergencyRecoveryActive()
      ? this.config.mmWsHealthEmergencyRecoveryIcebergRatio ?? 0
      : 0;
    if (!suppressBuy && bidOrderSize.shares > 0) {
      for (let i = bidStart; i < bidLayers; i += 1) {
        if (sparseOdd && i % 2 === 1) {
          continue;
        }
        // FIX H2: 用价格匹配而非索引匹配
        if (matchedBidHashes.size > 0) {
          const target = bidTargets[i];
          const hasMatch = remainingBids.some(o => matchedBidHashes.has(o.order_hash) && isOrderNearTarget(Number(o.price), target));
          if (hasMatch) continue;
        }
        const size = bidSizes[i] ?? 0;
        if (size <= 0) {
          continue;
        }
        const shares = this.applyIceberg(size, recoveryIcebergRatio);
        const guard = this.shouldSkipLayerDueToGuard(metrics, 'BUY', bidTargets[i], orderbook);
        if (guard.skip) {
          const msg = `BUY near=${guard.distanceBps?.toFixed(1) ?? 'n/a'}bps ${guard.reason || 'guard'}`;
          this.recordMmEvent('SKIP_GUARD', msg, tokenId);
          continue;
        }
        const vwapRisk = this.precheckNewOrderVwapRisk(orderbook, 'BUY', bidTargets[i], shares);
        if (vwapRisk.skip) {
          const msg = `BUY vwap=${vwapRisk.vwap?.toFixed(4) ?? 'n/a'} dist=${vwapRisk.distanceBps?.toFixed(1) ?? 'n/a'}bps`;
          this.recordMmEvent('SKIP_VWAP', msg, tokenId);
          continue;
        }
        const buyResult = await this.placeLimitOrder(market, 'BUY', bidTargets[i], shares, prices.spread, prices);
        if (buyResult) placedBuy = true;
        if (forceSingle) {
          break;
        }
      }
      hasBid = hasBid || placedBuy;
    }

    if (!suppressSell && askOrderSize.shares > 0) {
      for (let i = askStart; i < askLayers; i += 1) {
        if (sparseOdd && i % 2 === 1) {
          continue;
        }
        // FIX H2: 用价格匹配而非索引匹配
        if (matchedAskHashes.size > 0) {
          const target = askTargets[i];
          const hasMatch = remainingAsks.some(o => matchedAskHashes.has(o.order_hash) && isOrderNearTarget(Number(o.price), target));
          if (hasMatch) continue;
        }
        const size = askSizes[i] ?? 0;
        if (size <= 0) {
          continue;
        }
        const shares = this.applyIceberg(size, recoveryIcebergRatio);
        const guard = this.shouldSkipLayerDueToGuard(metrics, 'SELL', askTargets[i], orderbook);
        if (guard.skip) {
          const msg = `SELL near=${guard.distanceBps?.toFixed(1) ?? 'n/a'}bps ${guard.reason || 'guard'}`;
          this.recordMmEvent('SKIP_GUARD', msg, tokenId);
          continue;
        }
        const vwapRisk = this.precheckNewOrderVwapRisk(orderbook, 'SELL', askTargets[i], shares);
        if (vwapRisk.skip) {
          const msg = `SELL vwap=${vwapRisk.vwap?.toFixed(4) ?? 'n/a'} dist=${vwapRisk.distanceBps?.toFixed(1) ?? 'n/a'}bps`;
          this.recordMmEvent('SKIP_VWAP', msg, tokenId);
          continue;
        }
        const sellResult = await this.placeLimitOrder(market, 'SELL', askTargets[i], shares, prices.spread, prices);
        if (sellResult) placedSell = true;
        if (forceSingle) {
          break;
        }
      }
      hasAsk = hasAsk || placedSell;
    }

    if (placedBuy || placedSell) {
      this.markAction(tokenId);
    }

    this.lastPrices.set(tokenId, prices.midPrice);
    this.lastPriceAt.set(tokenId, Date.now());
  }

  private async placeLimitOrder(
    market: Market,
    side: 'BUY' | 'SELL',
    price: number,
    shares: number,
    currentSpread?: number,
    quotePrices?: QuotePrices | null
  ): Promise<boolean> {
    if (!Number.isFinite(price) || price <= 0 || price >= 1 || !Number.isFinite(shares) || shares <= 0) {
      console.warn(`🛑 placeLimitOrder 无效参数: price=${price} shares=${shares}`);
      return false;
    }

    // P1 FIX: BUY侧下单加锁，防止余额检查→下单之间的TOCTOU竞争条件
    // SELL侧不涉及抵押品余额，无需锁定
    if (side === 'BUY') {
      const previousLock = this.placeOrderLock;
      let resolveLock: () => void;
      this.placeOrderLock = new Promise<void>(resolve => { resolveLock = resolve; });
      await previousLock;
      try {
        return await this.doPlaceLimitOrder(market, side, price, shares, currentSpread, quotePrices);
      } finally {
        resolveLock!();
      }
    }

    return this.doPlaceLimitOrder(market, side, price, shares, currentSpread, quotePrices);
  }

  private async doPlaceLimitOrder(
    market: Market,
    side: 'BUY' | 'SELL',
    price: number,
    shares: number,
    currentSpread?: number,
    quotePrices?: QuotePrices | null
  ): Promise<boolean> {

    if (!this.orderManager) {
      return false;
    }

    // H4 FIX: 网络错误重试1次（timeout/ECONNRESET等瞬态错误）
    for (let attempt = 0; attempt <= 1; attempt++) {
    let payload: any;
    try {
      if (side === 'BUY' && this.config.mmVenue === 'predict') {
        const blockRemainingMs = this.getPredictBuyBlockRemainingMs(market.token_id);
        if (blockRemainingMs > 0) {
          console.log(
            `⏸️ BUY for ${market.token_id.slice(0, 8)} skipped: insufficient collateral cooldown ${Math.ceil(blockRemainingMs / 1000)}s`
          );
          return false;
        }
      }
      if (
        side === 'BUY' &&
        this.config.mmVenue === 'predict' &&
        typeof (this.orderManager as any)?.ensureBuyCollateralReady === 'function'
      ) {
        await (this.orderManager as any).ensureBuyCollateralReady(
          market,
          price,
          shares,
          this.config.predictCollateralBufferBps ?? 100
        );
      }

      // 应用积分优化调整（使用 V2 优化器）
      let adjustedPrice = price;
      let adjustedShares = shares;
      let pointsOptimized = false;
      let optimizationInfo: string[] = [];

      // 检查是否需要积分优化
      const hasPointsRules = pointsManager.isPointsActive(market);
      const enablePointsOptimization = this.config.mmPointsOptimization !== false; // 默认启用
      const enableV2Optimizer = this.config.mmPointsV2Optimizer !== false; // 默认启用 V2

      if (hasPointsRules && enablePointsOptimization && currentSpread !== undefined) {
        const orderbook = this.pointsOrderbookCache.get(market.token_id);
        if (orderbook) {
          if (enableV2Optimizer) {
            // 使用 V2 优化器 — 只优化订单大小，不覆盖价格
            //
            // 重要：calculatePrices() 已经包含完整的报价安全机制：
            //   touchBuffer, secondLayer, quoteOffset, AS模型, 波动率调整等
            // V2 优化器如果重新计算价格会导致双重推远（价格被推两次），
            // 实际价差超过积分系统的 max_spread_cents 限制，导致不获积分。
            // 因此 V2 只用于：
            //   1. 判断市场状况（流动性/波动率/竞争度）
            //   2. 调整订单大小（shares）以满足积分最低要求
            //   3. 评分和日志
            const optimized: OptimizedOrderParams = pointsOptimizerEngineV2.optimizeOrder(
              market,
              price,
              currentSpread,
              side,
              orderbook,
              shares
            );

            // 只采用 V2 的 shares 调整和评分，价格保持 calculatePrices 的计算结果
            adjustedPrice = price;
            adjustedShares = optimized.shares;
            pointsOptimized = optimized.overallScore >= 70;
            optimizationInfo = optimized.reasons;

            // 记录详细优化信息
            if (optimized.overallScore >= 80) {
              console.log(`🚀 Elite optimization for ${market.token_id.slice(0, 8)}: score=${optimized.overallScore.toFixed(0)} points=${optimized.expectedPoints.toFixed(0)}`);
            } else if (optimized.reasons.length > 0) {
              console.log(`🎯 V2 optimization for ${market.token_id.slice(0, 8)}: ${optimized.reasons.slice(0, 2).join(', ')}`);
            }
          } else {
            // 使用 V1 优化器（兼容模式）
            const adjustment = pointsOptimizerEngine.adjustOrderForPoints(
              market,
              currentSpread,
              shares,
              orderbook
            );

            adjustedShares = adjustment.adjustedSize;
            optimizationInfo = adjustment.warnings;
            pointsOptimized = adjustment.pointsEligible;

            // FIX: V1优化器不再修改价格 — 只改shares不改price
            // 之前V1会把price往盘口推（BUY推高、SELL推低），导致安全距离被吃掉
            // 价格安全由 calculatePrices() + executeUnifiedStrategy硬距离验证 保证
            // adjustedPrice 保持 calculatePrices 的原始安全价格不变

            if (optimizationInfo.length > 0) {
              console.log(`🎯 Points optimization for ${market.token_id.slice(0, 8)}: ${optimizationInfo.join(', ')}`);
            }
          }
        }
      }

      // ===== 提交前硬性BBO验证 — 最后一道防线 =====
      // v19: 三重检查 — 无论tierPriced与否都要验证距离
      const cachedBook = this.pointsOrderbookCache.get(market.token_id);
      const cacheTs = this.pointsOrderbookCacheTs.get(market.token_id);
      const cacheStale = cacheTs ? (Date.now() - cacheTs > MarketMaker.ORDERBOOK_CACHE_TTL) : true;

      // FIX C2: 缓存不存在或过期 → 拒绝下单（宁可少挂也不裸挂）
      if (!cachedBook || cacheStale) {
        const reason = !cachedBook ? '无缓存' : `缓存过期${cacheTs ? Math.round((Date.now()-cacheTs)/1000) : '?'}s`;
        console.warn(`⚠️ orderbook${reason}，放弃下单以防风险`);
        return false;
      }

      // v22: 最终BBO快照验证 — 在buildPayload之前的最后毫秒级检查
      // 如果缓存比我们计算价格时更新了，以最新缓存为准
      const isTierPriced = quotePrices?.tierPriced === true;
      {
        const latestBook = this.pointsOrderbookCache.get(market.token_id);
        if (latestBook && latestBook !== cachedBook) {
          if (isTierPriced) {
            // tierPriced: 只检查不越BBO，不查硬距离（档位本身保证安全）
            if (side === 'BUY' && latestBook.best_bid && adjustedPrice >= latestBook.best_bid) {
              console.warn(`🛑 v22最终验证(tierPriced): BUY $${adjustedPrice.toFixed(4)} >= 最新BBO $${latestBook.best_bid.toFixed(4)}，越BBO!`);
              return false;
            }
            if (side === 'SELL' && latestBook.best_ask && adjustedPrice <= latestBook.best_ask) {
              console.warn(`🛑 v22最终验证(tierPriced): SELL $${adjustedPrice.toFixed(4)} <= 最新BBO $${latestBook.best_ask.toFixed(4)}，越BBO!`);
              return false;
            }
          } else {
            // nonTierPriced: 动态硬距离检查
            const latestMinDist = this.getDynamicAbsoluteMin(market.token_id, latestBook) / 100;
            if (side === 'BUY' && latestBook.best_bid && adjustedPrice >= latestBook.best_bid - latestMinDist) {
              console.warn(`🛑 v22最终验证: BUY $${adjustedPrice.toFixed(4)} 离最新BBO $${latestBook.best_bid.toFixed(4)} 仅${((latestBook.best_bid - adjustedPrice) * 100).toFixed(2)}c < ${(latestMinDist*100).toFixed(1)}c，拒绝!`);
              return false;
            }
            if (side === 'SELL' && latestBook.best_ask && adjustedPrice <= latestBook.best_ask + latestMinDist) {
              console.warn(`🛑 v22最终验证: SELL $${adjustedPrice.toFixed(4)} 离最新BBO $${latestBook.best_ask.toFixed(4)} 仅${((adjustedPrice - latestBook.best_ask) * 100).toFixed(2)}c < ${(latestMinDist*100).toFixed(1)}c，拒绝!`);
              return false;
            }
          }
        }
      }
      if (isTierPriced) {
        // v19: 档位挂单 — 核心保护靠前面N-1档的流动性
        // 但仍需基本检查: 1)不越BBO 2)前面有足够深度保护 3)最低安全距离
        // v20: 获取自己已挂单的价格列表（排除自己的单）
        const myOrderPrices = new Set<number>();
        for (const [, o] of this.openOrders) {
          if (o.token_id === market.token_id) {
            myOrderPrices.add(Number(o.price));
          }
        }
        if (side === 'BUY' && cachedBook.best_bid && adjustedPrice >= cachedBook.best_bid) {
          console.warn(`🛑 档位验证: BUY $${adjustedPrice.toFixed(4)} >= BBO $${cachedBook.best_bid.toFixed(4)}，放弃!`);
          return false;
        }
        if (side === 'SELL' && cachedBook.best_ask && adjustedPrice <= cachedBook.best_ask) {
          console.warn(`🛑 档位验证: SELL $${adjustedPrice.toFixed(4)} <= BBO $${cachedBook.best_ask.toFixed(4)}，放弃!`);
          return false;
        }

        // v19: 检查我们前面至少有2档足够的流动性
        // 如果前面流动性被吃掉了，我们变成第2档，就不安全了
        const mode = this.getModeParams();
        const level = mode.quoteLevel; // 3 or 4
        const bids = cachedBook.bids || [];
        const asks = cachedBook.asks || [];
        const minFrontDepth = mode.minFrontDepth;

        if (side === 'BUY') {
          // 我们挂在bid侧第level档，前面需要level-1档有足够流动性
          let frontShares = 0;
          for (let i = 0; i < level - 1 && i < bids.length; i++) {
            const lvlPrice = Number(bids[i]?.price || 0);
            if (lvlPrice > adjustedPrice && !myOrderPrices.has(lvlPrice)) {
              frontShares += Number(bids[i]?.shares || 0);
            }
          }
          if (frontShares < minFrontDepth) {
            console.warn(`🛑 档位验证: BUY 前方深度${frontShares}股 < 需${minFrontDepth}股，前方保护不足，放弃!`);
            return false;
          }
          // v20: 每档最低深度检查 — 任一前档太薄都会被快速吃穿
          const minPerLevel = Math.max(200, Math.floor(minFrontDepth / (level * 3)));
          if (frontShares >= minFrontDepth) {
            let thinLevel = false;
            for (let i = 0; i < level - 1 && i < bids.length; i++) {
              const lvlPrice = Number(bids[i]?.price || 0);
              const lvlShares = Number(bids[i]?.shares || 0);
              if (lvlPrice > adjustedPrice && !myOrderPrices.has(lvlPrice) && lvlShares < minPerLevel) {
                console.warn(`🛑 档位验证: BUY 第${i+1}档仅${lvlShares}股 < ${minPerLevel}股(每档最低)，前方保护太薄!`);
                thinLevel = true;
                break;
              }
            }
            if (thinLevel) return false;
          }
          // v21: 前档质量不均匀惩罚 — 如果最薄档 < 平均档的30%，说明前方保护不可靠
          if (frontShares >= minFrontDepth) {
            const levels = level - 1;
            const avgPerLevel = frontShares / levels;
            let minLevelShares = Infinity;
            for (let i = 0; i < levels && i < bids.length; i++) {
              const lvlPrice = Number(bids[i]?.price || 0);
              if (lvlPrice > adjustedPrice && !myOrderPrices.has(lvlPrice)) {
                const lvlShares = Number(bids[i]?.shares || 0);
                if (lvlShares < minLevelShares) minLevelShares = lvlShares;
              }
            }
            if (minLevelShares < avgPerLevel * 0.3) {
              console.warn(`🛑 v21前档不均匀: BUY 最薄档${minLevelShares}股 < 平均${avgPerLevel.toFixed(0)}股的30%，前方保护不可靠!`);
              return false;
            }
          }
        } else {
          // SELL侧
          let frontShares = 0;
          for (let i = 0; i < level - 1 && i < asks.length; i++) {
            const lvlPrice = Number(asks[i]?.price || 0);
            if (lvlPrice < adjustedPrice && !myOrderPrices.has(lvlPrice)) {
              frontShares += Number(asks[i]?.shares || 0);
            }
          }
          if (frontShares < minFrontDepth) {
            console.warn(`🛑 档位验证: SELL 前方深度${frontShares}股 < 需${minFrontDepth}股，前方保护不足，放弃!`);
            return false;
          }
          if (frontShares >= minFrontDepth) {
            const minPerLevel = Math.max(200, Math.floor(minFrontDepth / (level * 3)));
            let thinLevel = false;
            for (let i = 0; i < level - 1 && i < asks.length; i++) {
              const lvlPrice = Number(asks[i]?.price || 0);
              const lvlShares = Number(asks[i]?.shares || 0);
              if (lvlPrice < adjustedPrice && !myOrderPrices.has(lvlPrice) && lvlShares < minPerLevel) {
                console.warn(`🛑 档位验证: SELL 第${i+1}档仅${lvlShares}股 < ${minPerLevel}股(每档最低)，前方保护太薄!`);
                thinLevel = true;
                break;
              }
            }
            if (thinLevel) return false;
          }
          // v21: 前档质量不均匀惩罚 — 如果最薄档 < 平均档的30%，说明前方保护不可靠
          if (frontShares >= minFrontDepth) {
            const levels = level - 1;
            const avgPerLevel = frontShares / levels;
            let minLevelShares = Infinity;
            for (let i = 0; i < levels && i < asks.length; i++) {
              const lvlPrice = Number(asks[i]?.price || 0);
              if (lvlPrice < adjustedPrice && !myOrderPrices.has(lvlPrice)) {
                const lvlShares = Number(asks[i]?.shares || 0);
                if (lvlShares < minLevelShares) minLevelShares = lvlShares;
              }
            }
            if (minLevelShares < avgPerLevel * 0.3) {
              console.warn(`🛑 v21前档不均匀: SELL 最薄档${minLevelShares}股 < 平均${avgPerLevel.toFixed(0)}股的30%，前方保护不可靠!`);
              return false;
            }
          }
        }
      } else {
        // 非档位定价：严格absoluteMin距离检查
        const preSubmitMinDist = this.getDynamicAbsoluteMin(market.token_id, cachedBook) / 100;
        const preSubmitMinCents = this.getDynamicAbsoluteMin(market.token_id, cachedBook);
        if (side === 'BUY' && cachedBook.best_bid && adjustedPrice >= cachedBook.best_bid - preSubmitMinDist) {
          const actualDist = ((cachedBook.best_bid - adjustedPrice) * 100).toFixed(2);
          console.warn(`🛑 提交前验证: BUY $${adjustedPrice.toFixed(4)} 离BBO $${cachedBook.best_bid.toFixed(4)} 仅${actualDist}c < ${preSubmitMinCents.toFixed(1)}c，放弃!`);
          return false;
        }
        if (side === 'SELL' && cachedBook.best_ask && adjustedPrice <= cachedBook.best_ask + preSubmitMinDist) {
          const actualDist = ((adjustedPrice - cachedBook.best_ask) * 100).toFixed(2);
          console.warn(`🛑 提交前验证: SELL $${adjustedPrice.toFixed(4)} 离BBO $${cachedBook.best_ask.toFixed(4)} 仅${actualDist}c < ${preSubmitMinCents.toFixed(1)}c，放弃!`);
          return false;
        }
      }

      payload = await this.orderManager.buildLimitOrderPayload({
        market,
        side,
        price: adjustedPrice,
        shares: adjustedShares
      });
      const isPolymarketPostOnly = this.isPolymarketPostOnlyOrder(payload);
      const response = await this.api.createOrder(payload);
      const orderHash =
        response?.order?.hash ||
        response?.data?.order?.hash ||
        payload?.data?.order?.hash ||
        `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      this.openOrders.set(String(orderHash), {
        order_hash: String(orderHash),
        id: response?.id ? String(response.id) : undefined,
        token_id: market.token_id,
        maker: this.orderManager.getMakerAddress(),
        signer: this.orderManager.getSignerAddress(),
        order_type: 'LIMIT',
        side,
        price: adjustedPrice.toString(),
        shares: adjustedShares.toString(),
        is_neg_risk: market.is_neg_risk,
        is_yield_bearing: market.is_yield_bearing,
        status: 'OPEN',
        timestamp: Date.now(),
      });

      // 记录积分统计到集成系统
      if (currentSpread !== undefined) {
        const check = pointsManager.checkOrderEligibility(market, adjustedShares, currentSpread);
        const orderbook = this.pointsOrderbookCache.get(market.token_id);

        // 使用集成系统记录
        pointsSystemIntegration.recordOrder(market, adjustedShares, currentSpread, check.isEligible, orderbook);

        // Layer 7: 记录积分收入（用于自适应缓冲优化）
        this.recordPointsEarned(market.token_id, check.isEligible);

        // 记录积分优化事件
        if (pointsOptimized || hasPointsRules) {
          const optInfo = optimizationInfo.length > 0 ? optimizationInfo.join('; ') : 'standard';
          this.recordMmEvent('POINTS_ORDER',
            `side=${side} price=${adjustedPrice.toFixed(4)} shares=${adjustedShares} eligible=${check.isEligible} optimized=${pointsOptimized} info=${optInfo}`,
            market.token_id);
        }
      }

      this.recordAutoTuneEvent(market.token_id, 'PLACED');
      this.recordPolymarketLifecycleEvent(market.token_id, 'PLACED');
      const optTag = pointsOptimized ? ' [Points optimized]' : '';
      console.log(`✅ ${side} order submitted at ${adjustedPrice.toFixed(4)} (${adjustedShares} shares)${optTag}`);
      if (isPolymarketPostOnly) {
        this.recordPolymarketPostOnlyResult(market.token_id, true);
      }
      if (side === 'BUY') {
        this.predictBuyInsufficientUntil.delete(market.token_id);
      }
      return true;
    } catch (error) {
      const message = this.getErrorMessage(error);
      const isPolymarketPostOnly = this.isPolymarketPostOnlyOrder(payload);
      if (isPolymarketPostOnly && this.isPolymarketPostOnlyReject(message)) {
        this.recordPolymarketPostOnlyResult(market.token_id, false);
        const fused = this.shouldTripPolymarketPostOnlyFuse(market.token_id);
        if (fused) {
          await this.cancelOrdersForMarket(market.token_id);
        }
        console.warn(`⚠️ Polymarket postOnly reject for ${market.token_id.slice(0, 8)}: ${message}`);
        return false;
      }
      if (side === 'BUY' && this.config.mmVenue === 'predict' && this.isPredictBuyInsufficientError(message)) {
        const cooldownMs = Math.max(1000, this.config.predictBuyInsufficientCooldownMs ?? 60000);
        this.predictBuyInsufficientUntil.set(market.token_id, Date.now() + cooldownMs);
        console.error(
          `Error placing ${side} order: ${message}. BUY paused for ${Math.round(cooldownMs / 1000)}s`
        );
        return false;
      }
      // H4 FIX: 网络瞬态错误重试1次
      const isNetworkError = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|socket hang up|network|timeout/i.test(message);
      if (isNetworkError && attempt === 0) {
        console.warn(`⚠️ placeLimitOrder网络错误，500ms后重试: ${message}`);
        await this.sleep(500);
        continue; // 重试
      }
      console.error(`Error placing ${side} order: ${message}`);
      throw (error instanceof Error ? error : new Error(message));
    }
    } // end retry loop
    return false;
  }

  async cancelOrdersForMarket(tokenId: string): Promise<boolean> {
    const ordersToCancel = Array.from(this.openOrders.values()).filter(
      (o) => o.token_id === tokenId && o.status === 'OPEN'
    );

    await this.cancelOrdersBatch(ordersToCancel, 'market-cancel');
    if (this.isLayerRestoreActive(tokenId) && this.config.mmLayerRestoreForceRefresh) {
      this.markAction(tokenId);
    }
    // H2 FIX: 返回是否所有订单都成功撤销
    // 检查是否还有残留的OPEN订单（说明有撤单失败）
    const remaining = Array.from(this.openOrders.values()).filter(
      (o) => o.token_id === tokenId && o.status === 'OPEN'
    );
    return remaining.length === 0;
  }

  async cancelAllOpenOrders(): Promise<void> {
    const ordersToCancel = Array.from(this.openOrders.values()).filter((o) => o.status === 'OPEN');
    await this.cancelOrdersBatch(ordersToCancel, 'global-cancel');
  }

  private async cancelOrdersBatch(orders: Order[], reason?: string): Promise<void> {
    if (!orders || orders.length === 0) {
      return;
    }
    const enableBatch = this.config.mmBatchCancelEnabled === true;
    const maxBatch = Math.max(1, this.config.mmBatchCancelMax ?? 8);
    const delayMs = Math.max(0, this.config.mmBatchCancelDelayMs ?? 0);
    if (!enableBatch || orders.length === 1) {
      for (const order of orders) {
        await this.cancelOrder(order);
      }
      return;
    }
    if (delayMs > 0) {
      await this.sleep(delayMs);
    }
    for (let i = 0; i < orders.length; i += maxBatch) {
      const chunk = orders.slice(i, i + maxBatch);
      const ids = chunk
        .map((order) => order.id || order.order_hash)
        .filter((id): id is string => Boolean(id));
      if (ids.length === 0) {
        continue;
      }
      try {
        await this.api.removeOrders(ids);
        for (const order of chunk) {
          const lifetimeMs = Math.max(0, Date.now() - Number(order.timestamp || 0));
          this.openOrders.delete(order.order_hash);
          this.recordAutoTuneEvent(order.token_id, 'CANCELED');
          this.recordPolymarketLifecycleEvent(order.token_id, 'CANCELED', lifetimeMs);
        }
        if (reason) {
          this.recordMmEvent('BATCH_CANCEL', `${reason} x${ids.length}`);
        }
        this.cancelBatchNonce += ids.length;
      } catch (error) {
        for (const order of chunk) {
          await this.cancelOrder(order);
        }
      }
    }
  }

  async cancelOrder(order: Order): Promise<boolean> {
    const id = order.id || order.order_hash;
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await this.api.removeOrders([id]);
        const lifetimeMs = Math.max(0, Date.now() - Number(order.timestamp || 0));
        this.openOrders.delete(order.order_hash);
        this.recordAutoTuneEvent(order.token_id, 'CANCELED');
        this.recordPolymarketLifecycleEvent(order.token_id, 'CANCELED', lifetimeMs);
        console.log(`❌ Canceled ${order.order_hash.substring(0, 10)}...`);
        return true;
      } catch (error) {
        const errMsg = this.getErrorMessage(error).toLowerCase();
        const isAlreadyFilled = errMsg.includes('already filled') || errMsg.includes('order filled') || errMsg.includes('fully filled');
        const isAlreadyCanceled = errMsg.includes('already canceled') || errMsg.includes('order not found') || errMsg.includes('does not exist');

        if (isAlreadyFilled || isAlreadyCanceled) {
          // P0 FIX: 订单已成交或已撤销，从openOrders删除避免幽灵订单
          this.openOrders.delete(order.order_hash);
          console.warn(`✅ 订单已${isAlreadyFilled ? '成交' : '撤销'}，从openOrders移除: ${order.order_hash.substring(0, 10)}...`);
          return true;
        }

        if (attempt < maxRetries) {
          console.warn(`⚠️ 撤单失败(尝试${attempt+1}/${maxRetries})，重试: ${order.order_hash.substring(0, 10)}...`);
          await this.sleep(500 * (attempt + 1)); // 递增延迟
        } else {
          console.error(`❌ 撤单最终失败(${maxRetries+1}次)，订单可能仍在盘口: ${order.order_hash.substring(0, 10)}...`, error);
          this.recordMmEvent('CANCEL_FAILED', `order=${order.order_hash.substring(0, 10)} error=${this.getErrorMessage(error)}`, order.token_id);
          return false;
        }
      }
    }
    return false;
  }

  async closePosition(tokenId: string): Promise<void> {
    const position = this.positions.get(tokenId);
    if (!position || !this.orderManager) {
      return;
    }

    try {
      // FIX H5: 先撤掉该token所有挂单，避免自己的买单和市价卖单交叉
      await this.cancelOrdersForMarket(tokenId);

      const market = await this.api.getMarket(tokenId);
      const orderbook = await this.api.getOrderbook(tokenId);

      // FIX H4: 同时平 YES 和 NO 方向的持仓
      if (position.yes_amount > 0) {
        const payload = await this.orderManager.buildMarketOrderPayload({
          market,
          side: 'SELL',
          shares: position.yes_amount,
          orderbook,
          slippageBps: '250',
        });
        await this.api.createOrder(payload);
        console.log(`✅ Position close YES sent: ${position.yes_amount} shares of ${tokenId}`);
      }

      if (position.no_amount > 0) {
        // NO持仓需要卖出NO方向 — 获取对应的NO market
        const { noTokenId } = this.getYesNoTokenIds(market);
        if (noTokenId) {
          const noMarket = await this.api.getMarket(noTokenId);
          const noBook = await this.api.getOrderbook(noTokenId);
          await this.cancelOrdersForMarket(noTokenId);
          const noPayload = await this.orderManager.buildMarketOrderPayload({
            market: noMarket,
            side: 'SELL',
            shares: position.no_amount,
            orderbook: noBook,
            slippageBps: '250',
          });
          await this.api.createOrder(noPayload);
          console.log(`✅ Position close NO sent: ${position.no_amount} shares of ${noTokenId}`);
        }
      }

      console.log(`✅ Position close request completed for ${tokenId}`);
    } catch (error) {
      console.error(`Error closing position ${tokenId}:`, error);
    }
  }

  private async detectAndHedgeFills(): Promise<void> {
    // HIGH FIX #2: 等待初始化完成（防止并发竞态条件）
    if (this.fillDetectionInitPromise) {
      await this.fillDetectionInitPromise;
    }

    // HIGH FIX #2: 首次调用时初始化所有基线
    if (!this.fillDetectionInitialized) {
      this.fillDetectionInitPromise = (async () => {
        console.log('🔄 初始化成交检测基线...');
        const markets = Array.from(this.marketByToken.values());
        const processedConditionIds = new Set<string>();

        for (const market of markets) {
          if (!market.condition_id || processedConditionIds.has(market.condition_id)) {
            continue;
          }

          processedConditionIds.add(market.condition_id);

          // 获取聚合的持仓
          const { yesTokenId, noTokenId } = this.getYesNoTokenIds(market);
          if (!yesTokenId || !noTokenId) {
            continue;
          }

          const yesPosition = this.positions.get(yesTokenId) || { yes_amount: 0, no_amount: 0, total_value: 0, pnl: 0 };
          const noPosition = this.positions.get(noTokenId) || { yes_amount: 0, no_amount: 0, total_value: 0, pnl: 0 };

          const currentYes = yesPosition.yes_amount + noPosition.yes_amount;
          const currentNo = yesPosition.no_amount + noPosition.no_amount;

          this.lastNetShares.set(market.condition_id, {
            net: currentYes - currentNo,
            yesAmount: currentYes,
            noAmount: currentNo,
            timestamp: Date.now()
          });
        }

        this.fillDetectionInitialized = true;
        console.log(`✅ 成交检测基线初始化完成，处理了 ${processedConditionIds.size} 个市场`);
      })();

      try {
        await this.fillDetectionInitPromise;
      } finally {
        this.fillDetectionInitPromise = null;
      }

      return; // 初始化完成后直接返回，等待下次调用
    }

    // ===== 统一做市商策略：订单成交处理 =====
    if (this.unifiedMarketMakerStrategy.isEnabled()) {
      // 修复：遍历所有市场并聚合 YES/NO 的 position
      const processedMarkets = new Set<string>();

      for (const [tokenId, position] of this.positions.entries()) {
        // 从 token_id 找到对应的市场对象
        let market: Market | undefined;
        for (const [mTokenId, m] of this.marketByToken) {
          if (mTokenId === tokenId) {
            market = m;
            break;
          }
        }

        if (!market || !market.condition_id || processedMarkets.has(market.condition_id)) {
          continue;
        }

        processedMarkets.add(market.condition_id);

        // 获取 YES 和 NO 的 token_id
        const { yesTokenId, noTokenId } = this.getYesNoTokenIds(market);
        if (!yesTokenId || !noTokenId) {
          continue;
        }

        // 聚合 YES 和 NO 的 position
        const yesPosition = this.positions.get(yesTokenId) || { yes_amount: 0, no_amount: 0, total_value: 0, pnl: 0 };
        const noPosition = this.positions.get(noTokenId) || { yes_amount: 0, no_amount: 0, total_value: 0, pnl: 0 };

        const currentYes = yesPosition.yes_amount + noPosition.yes_amount;
        const currentNo = yesPosition.no_amount + noPosition.no_amount;

        // CRITICAL FIX #2: 添加 timestamp 字段
        if (!this.lastNetShares.has(market.condition_id)) {
          this.lastNetShares.set(market.condition_id, {
            net: currentYes - currentNo,
            yesAmount: currentYes,
            noAmount: currentNo,
            timestamp: Date.now()
          });
          continue; // 跳过第一次迭代，只建立基线
        }

        const prevData = this.lastNetShares.get(market.condition_id);
        const prevYes = prevData?.yesAmount ?? 0;
        const prevNo = prevData?.noAmount ?? 0;

        // MEDIUM FIX #1: 使用 EPSILON 进行浮点数比较
        const EPSILON = MARKET_MAKER_CONSTANTS.EPSILON;

        // 检查 YES 变化
        if (Math.abs(currentYes - prevYes) > EPSILON) {
          const deltaYes = currentYes - prevYes;
          const side = deltaYes > 0 ? 'BUY' : 'SELL';
          const filledShares = Math.abs(deltaYes);
          // 实时告警: 订单被吃
          alertFill(market.token_id || market.condition_id || '', side, (market as any).yes_price || 0.5, filledShares);
          // 记录到日报
          recordFill(filledShares, 0, 0);
          try {
            await this.handleUnifiedOrderFill(market, side, 'YES', filledShares);
          } catch (error) {
            console.error(`❌ 统一策略YES成交处理失败: ${this.getErrorMessage(error)}`, error);
            this.recordMmEvent('HEDGE_ERROR', `YES side=${side} shares=${filledShares} err=${this.getErrorMessage(error)}`, market.condition_id);
          }
        }

        // 检查 NO 变化
        if (Math.abs(currentNo - prevNo) > EPSILON) {
          const deltaNo = currentNo - prevNo;
          const side = deltaNo > 0 ? 'BUY' : 'SELL';
          const filledShares = Math.abs(deltaNo);
          // 实时告警: 订单被吃
          alertFill(market.token_id || market.condition_id || '', side, (market as any).no_price || 0.5, filledShares);
          // 记录到日报
          recordFill(filledShares, 0, 0);
          try {
            await this.handleUnifiedOrderFill(market, side, 'NO', filledShares);
          } catch (error) {
            console.error(`❌ 统一策略NO成交处理失败: ${this.getErrorMessage(error)}`, error);
            this.recordMmEvent('HEDGE_ERROR', `NO side=${side} shares=${filledShares} err=${this.getErrorMessage(error)}`, market.condition_id);
          }
        }

        // 保存当前状态（使用 condition_id 作为 key）
        this.lastNetShares.set(market.condition_id, {
          net: currentYes - currentNo,
          yesAmount: currentYes,
          noAmount: currentNo,
          timestamp: Date.now()
        });
      }
      return;
    }

    // ===== 原有的对冲逻辑（如果未启用统一策略）=====
    const triggerShares = this.config.hedgeTriggerShares ?? 50;
    if (this.lastNetShares.size === 0) {
      for (const [tokenId, position] of this.positions.entries()) {
        const net = position.yes_amount - position.no_amount;
        this.lastNetShares.set(tokenId, {
          net,
          yesAmount: position.yes_amount,
          noAmount: position.no_amount,
          timestamp: Date.now()
        });
      }
      return;
    }

    for (const [tokenId, position] of this.positions.entries()) {
      const net = position.yes_amount - position.no_amount;
      const prevSnapshot = this.lastNetShares.get(tokenId);
      const prev = prevSnapshot?.net ?? 0;
      const delta = net - prev;
      const absDelta = Math.abs(delta);
      const restoreActive = this.isLayerRestoreActive(tokenId);
      const disableHedge = restoreActive && this.config.mmLayerRestoreDisableHedge;
      const disablePartial = restoreActive && this.config.mmLayerRestoreDisablePartialHedge;
      if (absDelta > 0) {
        this.updateFillPressure(tokenId, absDelta);
        this.lastFillAt.set(tokenId, Date.now());
        this.recordAutoTuneEvent(tokenId, 'FILLED');
        // v24 FIX C5: 检测到成交 → 立即取消该token所有挂单（不猜测哪侧成交）
        // 旧代码用delta方向猜成交侧并只删除该侧 → 猜错会留下孤儿订单
        // 孤儿订单无法被bot追踪/取消，被吃时无安全响应 → 直接损失
        // 新方案：成交=不安全信号 → 取消所有 + 冷却 → 下个主循环重新走完整防护
        await this.cancelOrdersForMarket(tokenId);
        // 也取消YES/NO子token的挂单
        const fillMarket = this.marketByToken.get(tokenId);
        if (fillMarket?.outcomes) {
          for (const outcome of fillMarket.outcomes) {
            if (outcome.onChainId && outcome.onChainId !== tokenId) {
              await this.cancelOrdersForMarket(outcome.onChainId);
            }
          }
        }
        // 成交后强制冷却，避免立即重新挂单又被吃
        const fillCooldown = this.getModeParams().fillCooldownMs;
        this.markCooldown(tokenId, fillCooldown);
        console.warn(`🚨 v24成交保护: ${tokenId.slice(0,8)} 检测到成交，取消所有挂单+冷却${Math.round(fillCooldown/60000)}分钟`);
        if (this.config.mmVenue === 'polymarket') {
          this.recordPolymarketLifecycleEvent(tokenId, 'FILLED', undefined);
        }
        if (this.config.mmVenue === 'predict') {
          await this.triggerPredictFillCircuitBreaker(tokenId, '检测到成交');
        } else if (this.config.mmVenue === 'polymarket') {
          await this.recordPolymarketAdverseFill(tokenId, this.marketByToken.get(tokenId), absDelta, position);
        }
        const fillCount = this.recordFillBurst(tokenId);
        const fillLimit = Math.max(1, this.config.mmFillBurstLimit ?? 0);
        if (fillLimit > 0 && fillCount >= fillLimit) {
          const hold = Math.max(0, this.config.mmFillBurstHoldMs ?? 0);
          if (hold > 0) {
            this.applyLayerRetreatFor(tokenId, hold);
          }
          if (this.config.mmFillBurstSafeMode) {
            this.safeModeExitUntil.set(tokenId, Date.now() + Math.max(0, this.config.mmFillBurstSafeModeMs ?? hold));
          }
        }
        const penalty = Math.max(0, this.config.mmRiskThrottleFillPenalty ?? 0);
        if (penalty > 0) {
          this.addRiskThrottle(tokenId, penalty);
          this.addRiskThrottle('__global__', penalty * 0.5);
        }
      }
      const partialThreshold = this.config.mmPartialFillShares ?? 5;
      if (absDelta > 0) {
        const intensity = this.clamp(absDelta / Math.max(1, partialThreshold), 0.2, 2);
        this.applyFillPenalty(tokenId, intensity);
        // Layer 5: 记录被吃事件（用于黑名单和冷却）
        this.recordFillEvent(tokenId);
        // Layer 7: 记录被吃次数（用于自适应缓冲）
        const buf = this.adaptiveBuffer.get(tokenId);
        if (buf) { buf.fillsReceived++; this.adaptiveBuffer.set(tokenId, buf); }
      }
      if (absDelta > 0 && this.config.mmDynamicCancelOnFill) {
        const intensity = this.clamp(absDelta / Math.max(1, partialThreshold), 0.2, 2);
        this.bumpCancelBoost(tokenId, intensity);
      }
      if (absDelta >= partialThreshold) {
        const penalty = this.config.mmPartialFillPenalty ?? 0.6;
        this.applySizePenalty(tokenId, penalty);
      }
      if (absDelta > 0 && this.config.mmAutoSizeOnFill !== false) {
        const minFactor = this.config.mmAutoSizeMinFactor ?? 0.4;
        const factor = this.clamp(1 - absDelta / (partialThreshold * 5), minFactor, 1);
        this.applySizePenalty(tokenId, factor, true);
      }
        if (absDelta >= triggerShares) {
          this.applyIcebergPenalty(tokenId);
          const wsDisableHedge = this.config.mmWsHealthDisableHedge && this.getWsHealthRatio() > 0;
          if (!disableHedge && !wsDisableHedge) {
            // CRITICAL FIX #3: 添加错误处理
            try {
              await this.handleFillHedge(tokenId, delta, position.question);
              this.lastHedgeAt.set(tokenId, Date.now());
            } catch (error) {
              console.error(`❌ Hedge execution failed for ${tokenId}:`, error);
              this.recordMmEvent('HEDGE_FAILED', `shares=${absDelta}`, tokenId);
            }
          }
        } else if (absDelta >= partialThreshold && this.config.mmPartialFillHedge) {
        const maxShares = this.config.mmPartialFillHedgeMaxShares ?? 20;
        const hedgeShares = Math.min(absDelta, maxShares);
        if (hedgeShares > 0) {
          const wsDisableHedge = this.config.mmWsHealthDisableHedge && this.getWsHealthRatio() > 0;
          if (!disableHedge && !disablePartial && !wsDisableHedge) {
            // CRITICAL FIX #3: 添加错误处理
            try {
              await this.flattenOnPredict(tokenId, delta, hedgeShares, this.config.mmPartialFillHedgeSlippageBps);
              this.lastHedgeAt.set(tokenId, Date.now());
            } catch (error) {
              console.error(`❌ Partial hedge execution failed for ${tokenId}:`, error);
              this.recordMmEvent('PARTIAL_HEDGE_FAILED', `shares=${hedgeShares}`, tokenId);
            }
          }
        }
      }
      // CRITICAL FIX #2: 使用 PositionSnapshot 对象
      this.lastNetShares.set(tokenId, {
        net,
        yesAmount: position.yes_amount,
        noAmount: position.no_amount,
        timestamp: Date.now()
      });
    }
  }

  private async handleFillHedge(tokenId: string, delta: number, question: string): Promise<void> {
    if (!this.orderManager) {
      return;
    }

    const lastHedge = this.lastHedgeAt.get(tokenId) || 0;
    if (Date.now() - lastHedge < (this.config.minOrderIntervalMs ?? 3000)) {
      return;
    }

    const mode = this.config.hedgeMode ?? 'FLATTEN';
    const shares = Math.abs(delta);

    // 买入反向对冲：被吃YES→买NO，被吃NO→买YES
    if (mode === 'BUY_OPPOSITE') {
      await this.buyOppositeHedge(tokenId, delta, shares, question);
      this.lastHedgeAt.set(tokenId, Date.now());
      return;
    }

    if (mode === 'CROSS' && this.crossAggregator && this.crossExecutionRouter) {
      try {
        const hedgeLeg = await this.buildCrossHedgeLeg(tokenId, question, delta, shares);
        if (hedgeLeg) {
          await this.crossExecutionRouter.execute([hedgeLeg]);
          this.lastHedgeAt.set(tokenId, Date.now());
          console.log(`🛡️ Cross-platform hedge executed (${hedgeLeg.platform} ${hedgeLeg.outcome})`);
          return;
        }
      } catch (error) {
        console.error('Cross-platform hedge failed, fallback to flatten:', error);
      }
    }

    // FLATTEN 或 CROSS fallback：卖出平仓
    await this.flattenOnPredict(tokenId, delta, shares);
    this.lastHedgeAt.set(tokenId, Date.now());
  }

  private async buildCrossHedgeLeg(
    tokenId: string,
    question: string,
    delta: number,
    shares: number
  ): Promise<PlatformLeg | null> {
    if (!this.crossAggregator) {
      return null;
    }

    const platformMap = await this.crossAggregator.getPlatformMarkets([], new Map());
    const mappingStore = this.crossAggregator.getMappingStore();
    const outcome = delta > 0 ? 'NO' : 'YES';
    const simWeight = Number.isFinite(this.config.crossHedgeSimilarityWeight)
      ? this.config.crossHedgeSimilarityWeight!
      : 0.7;
    const depthWeight = Number.isFinite(this.config.crossHedgeDepthWeight)
      ? this.config.crossHedgeDepthWeight!
      : 0.3;
    const minDepthUsd = Math.max(0, this.config.crossHedgeMinDepthUsd ?? 0);

    const pickBest = (candidates: PlatformMarket[]): PlatformMarket | null => {
      const minSimilarity = this.config.crossPlatformMinSimilarity ?? 0.78;
      let best: PlatformMarket | null = null;
      let bestScore = 0;
      for (const candidate of candidates) {
        const similarity = similarityScore(question, candidate.question);
        if (similarity < minSimilarity) continue;
        const token = outcome === 'YES' ? candidate.yesTokenId : candidate.noTokenId;
        const price = outcome === 'YES' ? candidate.yesAsk : candidate.noAsk;
        if (!token || !price || price <= 0) continue;
        const levels = outcome === 'YES' ? candidate.yesAsks : candidate.noAsks;
        const topSize = outcome === 'YES' ? candidate.yesAskSize : candidate.noAskSize;
        let depthShares = 0;
        if (levels && levels.length > 0) {
          for (const level of levels) {
            const shares = Number(level.shares);
            if (Number.isFinite(shares) && shares > 0) {
              depthShares += shares;
            }
          }
        } else if (Number.isFinite(topSize) && topSize! > 0) {
          depthShares = topSize!;
        }
        const depthUsd = depthShares * price;
        if (minDepthUsd > 0 && depthUsd < minDepthUsd) continue;
        const depthScore = Math.log10(depthUsd + 1);
        const score = similarity * simWeight + depthScore * depthWeight;
        if (!best || score > bestScore) {
          best = candidate;
          bestScore = score;
        }
      }
      return best;
    };

    if (mappingStore && this.config.crossPlatformUseMapping !== false) {
      try {
        const marketMeta = await this.api.getMarket(tokenId);
        const predictMarket: PlatformMarket = {
          platform: 'Predict',
          marketId: marketMeta.condition_id || marketMeta.event_id || tokenId,
          question: marketMeta.question || question,
          timestamp: Date.now(),
          metadata: {
            conditionId: marketMeta.condition_id || '',
            eventId: marketMeta.event_id || '',
          },
        };
        const mapped = mappingStore.resolveMatches(predictMarket, platformMap);
        if (mapped.length > 0) {
          const match = pickBest(mapped);
          if (match) {
            const token = outcome === 'YES' ? match.yesTokenId : match.noTokenId;
            const price = outcome === 'YES' ? match.yesAsk : match.noAsk;
            if (token && price) {
              return {
                platform: match.platform,
                tokenId: token,
                side: 'BUY',
                price,
                shares,
                outcome,
              };
            }
          }
        }
      } catch (error) {
        console.error('Mapping hedge lookup failed:', error);
      }
    }
    const candidates: PlatformMarket[] = [];
    for (const [platform, list] of platformMap.entries()) {
      if (platform === 'Predict') continue;
      candidates.push(...list);
    }

    if (candidates.length === 0) {
      return null;
    }

    const best = pickBest(candidates);
    if (!best) {
      return null;
    }

    const matchTokenId = outcome === 'YES' ? best.yesTokenId : best.noTokenId;
    const price = outcome === 'YES' ? best.yesAsk : best.noAsk;

    if (!matchTokenId || !price) {
      return null;
    }

    return {
      platform: best.platform,
      tokenId: matchTokenId,
      side: 'BUY',
      price,
      shares,
      outcome,
    };
  }

  private async flattenOnPredict(
    tokenId: string,
    delta: number,
    shares: number,
    slippageOverride?: number
  ): Promise<void> {
    if (!this.orderManager) {
      return;
    }

    // 被吃单 = 我们的BUY成交 = 持有多头，只做SELL平仓
    // delta < 0 表示空头（卖单被吃），做市商不主动买回来
    if (delta <= 0) {
      console.log(`🛡️ Skip flatten: delta=${delta}（空头不做买入平仓）`);
      return;
    }

    const market = await this.api.getMarket(tokenId);
    const orderbook = await this.api.getOrderbook(tokenId);
    const payload = await this.orderManager.buildMarketOrderPayload({
      market,
      side: 'SELL',
      shares,
      orderbook,
      slippageBps: String(slippageOverride ?? this.config.hedgeMaxSlippageBps ?? 250),
    });
    await this.api.createOrder(payload);
    console.log(`🛡️ Flattened position on Predict (SELL ${shares} shares)`);
  }

  /**
   * 买入反向对冲：被吃YES → 买NO，被吃NO → 买YES
   * 利用 YES+NO=$1 的互补关系，买入对手方token对冲掉敞口
   */
  private async buyOppositeHedge(
    tokenId: string,
    delta: number,
    shares: number,
    question: string
  ): Promise<void> {
    if (!this.orderManager) return;

    // delta < 0 表示空头（卖单被吃），不主动买反向对冲
    if (delta <= 0) {
      console.log(`🛡️ Skip buy-opposite: delta=${delta}（空头不做买入反向对冲）`);
      return;
    }

    const market = this.marketByToken.get(tokenId);
    if (!market) {
      console.warn(`⚠️ 买入反向对冲: 找不到市场 ${tokenId.slice(0, 8)}，fallback到平仓`);
      await this.flattenOnPredict(tokenId, delta, shares);
      return;
    }

    const { yesTokenId, noTokenId } = this.getYesNoTokenIds(market);

    // 判断被吃的token是YES还是NO
    const isYesToken = tokenId === yesTokenId || (!noTokenId && tokenId === market.token_id);
    const isNoToken = tokenId === noTokenId;

    if (!isYesToken && !isNoToken) {
      // 无法确定方向，fallback到平仓
      console.warn(`⚠️ 买入反向对冲: 无法确定YES/NO方向，fallback到平仓`);
      await this.flattenOnPredict(tokenId, delta, shares);
      return;
    }

    // 被吃YES → 买NO对冲，被吃NO → 买YES对冲
    const oppositeTokenId = isYesToken ? noTokenId : yesTokenId;
    if (!oppositeTokenId) {
      console.warn(`⚠️ 买入反向对冲: 找不到反向token，fallback到平仓`);
      await this.flattenOnPredict(tokenId, delta, shares);
      return;
    }

    try {
      const oppositeMarket = await this.api.getMarket(oppositeTokenId);
      const oppositeBook = await this.api.getOrderbook(oppositeTokenId);
      const slippage = this.config.hedgeMaxSlippageBps ?? 250;

      // 买入反向token，无论delta方向都买
      const payload = await this.orderManager.buildMarketOrderPayload({
        market: oppositeMarket,
        side: 'BUY',
        shares,
        orderbook: oppositeBook,
        slippageBps: String(slippage),
      });
      await this.api.createOrder(payload);

      const direction = isYesToken ? '被吃YES→买NO' : '被吃NO→买YES';
      console.log(`🛡️ 买入反向对冲: ${direction} ${shares}股 (${question.slice(0, 30)}...)`);
      this.recordMmEvent('HEDGE_BUY_OPPOSITE', `${direction} shares=${shares}`, tokenId);
    } catch (error) {
      console.error(`❌ 买入反向对冲失败，fallback到平仓: ${error.message}`);
      // 买反向失败 → fallback平仓
      await this.flattenOnPredict(tokenId, delta, shares);
    }
  }

  /**
   * 更新市场积分评分
   */
  private updatePointsScores(markets: Market[]): void {
    const now = Date.now();
    const shouldUpdate = this.pointsScores.size === 0 || (now - this.pointsLastReportAt) > 60000; // 1分钟更新一次

    if (!shouldUpdate) return;

    for (const market of markets) {
      const orderbook = this.pointsOrderbookCache.get(market.token_id);
      if (!orderbook) continue;

      const spread = orderbook.spread ?? orderbook.mid_price ? 0.02 : 0.01;
      const score = pointsOptimizerEngine.evaluateMarket(market, spread, orderbook);
      this.pointsScores.set(market.token_id, score);
    }

    this.pointsLastReportAt = now;
  }

  /**
   * 获取高积分优先级市场
   */
  getTopPointsMarkets(allMarkets: Market[], topN: number = 20): Market[] {
    if (!this.config.mmPointsPrioritize) {
      return allMarkets;
    }

    this.updatePointsScores(allMarkets);

    const scored = allMarkets
      .map(market => ({
        market,
        score: this.pointsScores.get(market.token_id)
      }))
      .filter(item => item.score && item.score.priority > 0)
      .sort((a, b) => (b.score?.priority || 0) - (a.score?.priority || 0));

    const topMarkets = scored.slice(0, topN).map(item => item.market);
    const remaining = allMarkets.filter(m => !topMarkets.includes(m));

    return [...topMarkets, ...remaining];
  }

  /**
   * 报告积分效率
   */
  private reportPointsEfficiency(): void {
    const now = Date.now();
    if (now - this.pointsLastReportAt < this.pointsReportInterval) {
      return;
    }

    const stats = pointsManager.getStats();
    if (stats.totalMarkets === 0) {
      return;
    }

    console.log('\n🎯 Points Efficiency Report:');
    console.log('─'.repeat(60));
    console.log(`Total Markets: ${stats.totalMarkets}`);
    console.log(`Points Active: ${stats.pointsActiveMarkets}`);
    console.log(`Eligibility Rate: ${stats.efficiency}%`);

    const topMarkets = stats.markets
      .filter(m => m.isActive)
      .sort((a, b) => b.eligibleOrders - a.eligibleOrders)
      .slice(0, 10);

    if (topMarkets.length > 0) {
      console.log('\nTop Points Markets:');
      for (const m of topMarkets) {
        const rate = m.totalOrders > 0 ? Math.round((m.eligibleOrders / m.totalOrders) * 100) : 0;
        console.log(`  [${m.marketId.slice(0, 8)}] ${rate}% eligible (${m.eligibleOrders}/${m.totalOrders}) min_shares=${m.minShares}`);
      }
    }

    console.log('─'.repeat(60) + '\n');
    this.pointsLastReportAt = now;

    // 清理过期数据
    pointsManager.clearExpired(24 * 60 * 60 * 1000); // 24小时
  }

  printStatus(): void {
    const now = Date.now();
    const activePauses = Array.from(this.pauseUntil.entries())
      .filter(([, until]) => until > now)
      .sort((a, b) => a[1] - b[1]);

    console.log('\n📊 Market Maker Status:');
    console.log('─'.repeat(80));
    console.log(`Trading Halted: ${this.tradingHalted ? 'YES' : 'NO'}`);
    console.log(`Open Orders: ${this.openOrders.size}`);
    console.log(`Positions: ${this.positions.size}`);
    console.log(`Session PnL: ${this.sessionPnL.toFixed(2)}`);
    console.log(`Paused Markets: ${activePauses.length}`);

    // 积分效率报告
    const pointsStats = pointsManager.getStats();
    if (pointsStats.totalMarkets > 0) {
      console.log(`Points Efficiency: ${pointsStats.efficiency}% (${pointsStats.pointsActiveMarkets}/${pointsStats.totalMarkets} markets)`);
    }

    if (this.positions.size > 0) {
      console.log('\nPositions:');
      for (const [tokenId, position] of this.positions) {
        console.log(`  ${tokenId}:`);
        console.log(`    YES: ${position.yes_amount.toFixed(2)} | NO: ${position.no_amount.toFixed(2)}`);
        console.log(`    Value: $${position.total_value.toFixed(2)} | PnL: $${position.pnl.toFixed(2)}`);
      }
    }

    if (activePauses.length > 0) {
      console.log('\nPaused Market Reasons:');
      for (const [tokenId, until] of activePauses.slice(0, 5)) {
        const reason = this.pauseReasons.get(tokenId);
        const remainingSec = Math.max(1, Math.ceil((until - now) / 1000));
        console.log(
          `  ${tokenId.slice(0, 12)}... ${remainingSec}s | ${reason?.source || 'unknown'} | ${reason?.reason || 'paused'}`
        );
      }
    }

    console.log('─'.repeat(80) + '\n');

    // 定期详细积分报告
    this.reportPointsEfficiency();
  }

  // ===== Phase 1: 增强模块辅助方法 =====

  /**
   * 获取或创建波动率估算器
   */
  private getOrCreateVolatilityEstimator(tokenId: string): VolatilityEstimator {
    if (!this.perMarketVolatility.has(tokenId)) {
      this.perMarketVolatility.set(tokenId, new VolatilityEstimator());
    }
    return this.perMarketVolatility.get(tokenId)!;
  }

  /**
   * 获取或创建订单流估算器
   */
  private getOrCreateOrderFlowEstimator(tokenId: string): OrderFlowEstimator {
    if (!this.perMarketOrderFlow.has(tokenId)) {
      this.perMarketOrderFlow.set(tokenId, new OrderFlowEstimator());
    }
    return this.perMarketOrderFlow.get(tokenId)!;
  }

  /**
   * 获取或创建均值回归预测器
   */
  private getOrCreateReversionPredictor(tokenId: string): MeanReversionPredictor {
    if (!this.perMarketReversion.has(tokenId)) {
      this.perMarketReversion.set(tokenId, new MeanReversionPredictor());
    }
    return this.perMarketReversion.get(tokenId)!;
  }

  /**
   * 更新波动率和订单流数据
   */
  private updateAdvancedMetrics(tokenId: string, orderbook: Orderbook): void {
    // 更新波动率
    if (orderbook.mid_price && orderbook.mid_price > 0) {
      const volEstimator = this.getOrCreateVolatilityEstimator(tokenId);
      volEstimator.updatePrice(orderbook.mid_price, Date.now());
    }

    // 库存数据在 handleFill 中更新
  }

  /**
   * 记录订单流事件
   */
  private recordOrderFlow(tokenId: string, side: 'BUY' | 'SELL', amount: number, price: number): void {
    const flowEstimator = this.getOrCreateOrderFlowEstimator(tokenId);
    flowEstimator.recordOrder(side, amount, price, Date.now());
  }

  // ===== 两阶段循环对冲策略（V5）辅助方法 =====

  /**
   * 第一阶段：挂 Buy 单（建立对冲库存）
   */
  private async executeTwoPhaseBuySide(market: Market, orderbook: Orderbook, position: Position): Promise<void> {
    // CRITICAL FIX #3: 使用 YES/NO 各自的 token_id
    const { yesTokenId, noTokenId } = this.getYesNoTokenIds(market);
    if (!yesTokenId || !noTokenId) {
      console.warn('⚠️  Cannot get YES/NO token_ids, skipping Phase 1');
      return;
    }

    // 分别获取 YES 和 NO 的订单簿
    const yesOrderbook = yesTokenId ? await this.api.getOrderbook(yesTokenId) : orderbook;
    const noOrderbook = noTokenId ? await this.api.getOrderbook(noTokenId) : orderbook;

    if (this.isUnsafeBook(yesOrderbook) || this.isUnsafeBook(noOrderbook)) {
      console.warn('🛑 Phase 1 skipped: unsafe YES/NO spread');
      await this.handlePredictUnsafePair(yesTokenId, noTokenId);
      return;
    }

    const yesPrice = yesOrderbook.best_bid || 0;
    const noPrice = noOrderbook.best_bid || (1 - yesPrice);

    // 获取两阶段策略建议的挂单价格
    const prices = this.twoPhaseStrategy.suggestOrderPrices(yesPrice, noPrice, TwoPhaseState.EMPTY);

    if (!prices.yesBid || !prices.noBid) {
      console.log('⚠️  Could not calculate buy prices');
      return;
    }

    console.log(`💡 Phase 1 BUY prices: YES=$${prices.yesBid.toFixed(4)} NO=$${prices.noBid.toFixed(4)}`);

    // 取消所有现有订单（使用原始 market.token_id）
    await this.cancelOrdersForMarket(market.token_id);

    // 计算订单大小
    const orderSize = Math.max(100, Math.floor(this.config.orderSize || 25));

    // CRITICAL FIX #3: 使用各自的市场对象挂单
    const yesMarket = { ...market, token_id: yesTokenId };
    const noMarket = { ...market, token_id: noTokenId };

    // 挂 YES Buy 单
    if (prices.yesBid > 0) {
      await this.placeLimitOrder(yesMarket, 'BUY', prices.yesBid, orderSize, 0.02);
    }

    // 挂 NO Buy 单
    if (prices.noBid > 0) {
      await this.placeLimitOrder(noMarket, 'BUY', prices.noBid, orderSize, 0.02);
    }

    console.log(`✅ Phase 1: Placed BUY orders (establishing hedge)`);
  }

  /**
   * 第二阶段：挂 Sell 单（赚取积分并平仓）
   */
  private async executeTwoPhaseSellSide(market: Market, orderbook: Orderbook, position: Position): Promise<void> {
    // CRITICAL FIX #3: 使用 YES/NO 各自的 token_id
    const { yesTokenId, noTokenId } = this.getYesNoTokenIds(market);
    if (!yesTokenId || !noTokenId) {
      console.warn('⚠️  Cannot get YES/NO token_ids, skipping Phase 2');
      return;
    }

    // 分别获取 YES 和 NO 的订单簿
    const yesOrderbook = yesTokenId ? await this.api.getOrderbook(yesTokenId) : orderbook;
    const noOrderbook = noTokenId ? await this.api.getOrderbook(noTokenId) : orderbook;

    if (this.isUnsafeBook(yesOrderbook) || this.isUnsafeBook(noOrderbook)) {
      console.warn('🛑 Phase 2 skipped: unsafe YES/NO spread');
      await this.handlePredictUnsafePair(yesTokenId, noTokenId);
      return;
    }

    const yesPrice = yesOrderbook.best_bid || 0;
    const noPrice = noOrderbook.best_bid || (1 - yesPrice);

    // 获取两阶段策略建议的挂单价格
    const prices = this.twoPhaseStrategy.suggestOrderPrices(yesPrice, noPrice, TwoPhaseState.HEDGED);

    if (!prices.yesAsk || !prices.noAsk) {
      console.log('⚠️  Could not calculate sell prices');
      return;
    }

    console.log(`💡 Phase 2 SELL prices: YES=$${prices.yesAsk.toFixed(4)} NO=$${prices.noAsk.toFixed(4)}`);

    // 取消所有现有订单（使用原始 market.token_id）
    await this.cancelOrdersForMarket(market.token_id);

    // 计算订单大小（基于当前持仓）
    const orderSize = Math.max(100, Math.min(
      Math.floor(position.yes_amount || 100),
      Math.floor(position.no_amount || 100)
    ));

    // CRITICAL FIX #3: 使用各自的市场对象挂单
    const yesMarket = { ...market, token_id: yesTokenId };
    const noMarket = { ...market, token_id: noTokenId };

    // 挂 YES Sell 单
    if (prices.yesAsk > 0 && position.yes_amount > 0) {
      await this.placeLimitOrder(yesMarket, 'SELL', prices.yesAsk, orderSize, 0.02);
    }

    // 挂 NO Sell 单
    if (prices.noAsk > 0 && position.no_amount > 0) {
      await this.placeLimitOrder(noMarket, 'SELL', prices.noAsk, orderSize, 0.02);
    }

    console.log(`✅ Phase 2: Placed SELL orders (earning points)`);
  }

  /**
   * 处理两阶段策略的订单成交
   */
  async handleTwoPhaseOrderFill(
    market: Market,
    side: 'BUY' | 'SELL',
    token: 'YES' | 'NO',
    filledShares: number
  ): Promise<void> {
    const currentState = this.perMarketTwoPhaseState.get(market.token_id) || TwoPhaseState.EMPTY;

    // CRITICAL FIX #2a: 使用聚合的持仓（YES + NO token_id）
    const position = this.getAggregatedPosition(market);

    console.log(`📝 Two-phase order fill: ${token} ${side} ${filledShares} shares (Phase: ${currentState})`);

    const action = this.twoPhaseStrategy.handleOrderFill(
      side,
      token,
      filledShares,
      position.yes_amount,
      position.no_amount,
      currentState
    );

    if (!action.needsAction || action.type === 'NONE') {
      return;
    }

    console.log(`🎯 Two-phase action: ${action.type} ${action.shares} shares - ${action.reason}`);

    // 获取 YES/NO token_id 用于对冲操作
    const { yesTokenId, noTokenId } = this.getYesNoTokenIds(market);

    // HIGH FIX #7: 添加 targetTokenId 空值检查
    if (action.type === 'BUY_YES' && !yesTokenId) {
      console.error('❌ Cannot execute BUY_YES: yesTokenId is undefined');
      return;
    }
    if (action.type === 'BUY_NO' && !noTokenId) {
      console.error('❌ Cannot execute BUY_NO: noTokenId is undefined');
      return;
    }
    if (action.type === 'SELL_YES' && !yesTokenId) {
      console.error('❌ Cannot execute SELL_YES: yesTokenId is undefined');
      return;
    }
    if (action.type === 'SELL_NO' && !noTokenId) {
      console.error('❌ Cannot execute SELL_NO: noTokenId is undefined');
      return;
    }

    // 执行对冲或平仓操作
    switch (action.type) {
      case 'BUY_YES': {
        // Phase 1: NO Buy 单被成交 → 立即买入 YES 建立对冲
        // FIX C6: 对冲成本检查 — YES价格+NO价格不能>1.0（否则直接亏钱）
        const yesBook = await this.api.getOrderbook(yesTokenId!);
        const yesAskPrice = Number(yesBook.asks?.[0]?.price || 0);
        // 推算NO成本: 我们持有NO，假设买入价约1.0-yesAskPrice（粗估）
        if (yesAskPrice > 0 && yesAskPrice > 0.97) {
          console.warn(`⚠️ 对冲成本过高: YES ask=${yesAskPrice.toFixed(4)}，跳过对冲避免亏损`);
          this.recordMmEvent('HEDGE_COST_SKIP', `YES ask=${yesAskPrice.toFixed(4)} too expensive`, market.token_id);
          break;
        }
        // CRITICAL FIX #2b: 传递 targetTokenId (YES)
        await this.executeMarketBuy(market, 'YES', action.shares, yesTokenId!);
        this.perMarketTwoPhaseState.set(market.token_id, TwoPhaseState.HEDGED);
        console.log(`✅ Phase 1: Established 1:1 hedge (YES + NO)`);
        break;
      }

      case 'BUY_NO': {
        // Phase 1: YES Buy 单被成交 → 立即买入 NO 建立对冲
        // FIX C6: 对冲成本检查
        const noBook = await this.api.getOrderbook(noTokenId!);
        const noAskPrice = Number(noBook.asks?.[0]?.price || 0);
        if (noAskPrice > 0 && noAskPrice > 0.97) {
          console.warn(`⚠️ 对冲成本过高: NO ask=${noAskPrice.toFixed(4)}，跳过对冲避免亏损`);
          this.recordMmEvent('HEDGE_COST_SKIP', `NO ask=${noAskPrice.toFixed(4)} too expensive`, market.token_id);
          break;
        }
        // CRITICAL FIX #2b: 传递 targetTokenId (NO)
        await this.executeMarketBuy(market, 'NO', action.shares, noTokenId!);
        this.perMarketTwoPhaseState.set(market.token_id, TwoPhaseState.HEDGED);
        console.log(`✅ Phase 1: Established 1:1 hedge (YES + NO)`);
        break;
      }

      case 'SELL_YES':
        // Phase 2: NO Sell 单被成交 → 立即卖出 YES 平仓
        // CRITICAL FIX #2b: 传递 targetTokenId (YES)
        await this.executeMarketSell(market, 'YES', action.shares, yesTokenId);
        this.perMarketTwoPhaseState.set(market.token_id, TwoPhaseState.EMPTY);
        console.log(`✅ Phase 2: Flattened position, back to 0`);
        break;

      case 'SELL_NO':
        // Phase 2: YES Sell 单被成交 → 立即卖出 NO 平仓
        // CRITICAL FIX #2b: 传递 targetTokenId (NO)
        await this.executeMarketSell(market, 'NO', action.shares, noTokenId);
        this.perMarketTwoPhaseState.set(market.token_id, TwoPhaseState.EMPTY);
        console.log(`✅ Phase 2: Flattened position, back to 0`);
        break;
    }
  }

  /**
   * MEDIUM FIX #5: 提取市价订单执行的公共逻辑
   */
  private async executeMarketOrder(
    market: Market,
    side: 'BUY' | 'SELL',
    token: 'YES' | 'NO',
    shares: number,
    targetTokenId?: string
  ): Promise<void> {
    if (!this.orderManager) {
      return;
    }

    try {
      const actualTokenId = targetTokenId || market.token_id;
      const actualMarket = targetTokenId ? { ...market, token_id: actualTokenId } : market;

      const orderbook = await this.api.getOrderbook(actualTokenId);
      const payload = await this.orderManager.buildMarketOrderPayload({
        market: actualMarket,
        side,
        shares,
        orderbook,
        slippageBps: String(this.config.unifiedMarketMakerHedgeSlippageBps || MARKET_MAKER_CONSTANTS.DEFAULT_HEDGE_SLIPPAGE_BPS),
      });
      await this.api.createOrder(payload);
      const emoji = side === 'BUY' ? '🛡️' : '🔄';
      console.log(`${emoji} Market ${side}: ${shares} ${token} @ ${actualTokenId.slice(0, 16)}...`);
    } catch (error) {
      console.error(`Error executing market ${side.toLowerCase()}:`, error);
      throw error; // 重新抛出以便上层处理
    }
  }

  /**
   * 执行市价买入（使用公共逻辑）
   */
  private async executeMarketBuy(market: Market, token: 'YES' | 'NO', shares: number, targetTokenId?: string): Promise<void> {
    return this.executeMarketOrder(market, 'BUY', token, shares, targetTokenId);
  }

  /**
   * 执行市价卖出（使用公共逻辑）
   */
  private async executeMarketSell(market: Market, token: 'YES' | 'NO', shares: number, targetTokenId?: string): Promise<void> {
    return this.executeMarketOrder(market, 'SELL', token, shares, targetTokenId);
  }

  // ===== 统一做市商策略辅助方法 =====

  /**
   * 从市场对象的 outcomes 数组中获取 YES 和 NO 的 token_id
   */
  private getYesNoTokenIds(market: Market): { yesTokenId?: string; noTokenId?: string } {
    if (!market.outcomes || market.outcomes.length === 0) {
      console.warn(`⚠️  市场 ${market.token_id.slice(0, 8)}... 没有 outcomes 数据`);
      return {};
    }

    // HIGH FIX #4: 检查多结果市场
    if (market.outcomes.length > 2) {
      console.warn(`⚠️  市场 ${market.token_id.slice(0, 8)}... 有 ${market.outcomes.length} 个结果（非二元市场）`);
      console.warn(`   只会处理 indexSet 1 和 indexSet 2 的结果`);
    }

    let yesTokenId: string | undefined;
    let noTokenId: string | undefined;

    for (const outcome of market.outcomes) {
      // MEDIUM FIX #12: 验证 outcome 数据完整性
      if (!outcome.onChainId) {
        console.warn(`⚠️  Outcome ${outcome.name} 缺少 onChainId`);
        continue;
      }

      const name = outcome.name.toLowerCase();
      const isYes = name === 'yes' || name === 'up' || name === 'true' || outcome.indexSet === 1;
      const isNo = name === 'no' || name === 'down' || name === 'false' || outcome.indexSet === 2;

      if (isYes) {
        yesTokenId = outcome.onChainId;
      } else if (isNo) {
        noTokenId = outcome.onChainId;
      }
    }

    return { yesTokenId, noTokenId };
  }

  /**
   * BUG#5 FIX: 确保子tokenId（YES/NO）拥有父tokenId的安全状态数据
   * calculatePrices() 内部用 market.token_id 查找 volatilityEma、fillPenalty、
   * nearTouchPenalty 等状态Map，这些状态在主循环中用父tokenId维护。
   * 如果不复制，calculatePrices 查找子tokenId时会得到空值，导致所有安全惩罚失效。
   */
  private ensureStateForToken(parentId: string, childId: string | undefined): void {
    if (!childId || childId === parentId) return;

    // FIX: 改为总是同步父 token 的状态到子 token（不再只复制空值）
    // 之前"只在子token没有时才复制"会导致子token保留旧的过期数据
    // 例如波动率飙升后，子token的volatilityEma还是旧值，导致报价过于激进

    // 波动率
    if (this.volatilityEma.has(parentId)) {
      this.volatilityEma.set(childId, this.volatilityEma.get(parentId)!);
    }
    // 深度EMA
    if (this.depthEma.has(parentId)) {
      this.depthEma.set(childId, this.depthEma.get(parentId)!);
    }
    if (this.totalDepthEma.has(parentId)) {
      this.totalDepthEma.set(childId, this.totalDepthEma.get(parentId)!);
    }
    // 最后价格
    if (this.lastPrices.has(parentId)) {
      this.lastPrices.set(childId, this.lastPrices.get(parentId)!);
    }
    // fill惩罚
    if (this.fillPenalty.has(parentId)) {
      this.fillPenalty.set(childId, { ...this.fillPenalty.get(parentId)! });
    }
    // nearTouch惩罚
    if (this.nearTouchPenalty.has(parentId)) {
      this.nearTouchPenalty.set(childId, { ...this.nearTouchPenalty.get(parentId)! });
    }
    // fill统计
    if (this.fillStats.has(parentId)) {
      this.fillStats.set(childId, { ...this.fillStats.get(parentId)! });
    }
    // 自适应缓冲
    if (this.adaptiveBuffer.has(parentId)) {
      this.adaptiveBuffer.set(childId, { ...this.adaptiveBuffer.get(parentId)! });
    }
  }

  /**
   * 获取聚合的持仓（YES 和 NO token_id 的持仓合并）
   * 用于统一做市商策略和两阶段策略
   */
  private getAggregatedPosition(market: Market): Position {
    const { yesTokenId, noTokenId } = this.getYesNoTokenIds(market);

    if (!yesTokenId || !noTokenId) {
      // Fallback: 使用 market.token_id
      return this.positions.get(market.token_id) || {
        token_id: market.token_id,
        question: market.question || '',
        yes_amount: 0,
        no_amount: 0,
        total_value: 0,
        avg_entry_price: 0,
        current_price: 0,
        pnl: 0,
      };
    }

    // 聚合 YES 和 NO token 的持仓
    const yesPosition = this.positions.get(yesTokenId) || {
      yes_amount: 0,
      no_amount: 0,
      total_value: 0,
      pnl: 0,
    };
    const noPosition = this.positions.get(noTokenId) || {
      yes_amount: 0,
      no_amount: 0,
      total_value: 0,
      pnl: 0,
    };

    return {
      token_id: market.token_id,
      question: market.question || '',
      yes_amount: yesPosition.yes_amount + noPosition.yes_amount,
      no_amount: yesPosition.no_amount + noPosition.no_amount,
      total_value: yesPosition.total_value + noPosition.total_value,
      avg_entry_price: 0,
      current_price: 0,
      pnl: (yesPosition.pnl || 0) + (noPosition.pnl || 0),
    };
  }

  /**
   * 查找同一市场的 YES 和 NO 市场对象（已废弃，使用 getYesNoTokenIds）
   * @deprecated 使用 getYesNoTokenIds 直接从 outcomes 数组获取 token_id
   */
  private findYesNoMarkets(market: Market): { yes?: Market; no?: Market } {
    const { yesTokenId, noTokenId } = this.getYesNoTokenIds(market);

    const yesMarket = yesTokenId ? { ...market, token_id: yesTokenId } : undefined;
    const noMarket = noTokenId ? { ...market, token_id: noTokenId } : undefined;

    return { yes: yesMarket, no: noMarket };
  }

  /**
   * 推断市场的 outcome (YES 或 NO)（已废弃，使用 outcomes 数组）
   * @deprecated 使用 market.outcomes 数组直接获取
   */
  private inferOutcome(market: Market): 'YES' | 'NO' | null {
    // 首先尝试从 outcomes 数组中获取
    if (market.outcomes && market.outcomes.length > 0) {
      const yesOutcome = market.outcomes.find(o =>
        o.name.toLowerCase() === 'yes' ||
        o.name.toLowerCase() === 'up' ||
        o.name.toLowerCase() === 'true' ||
        o.indexSet === 1
      );
      if (yesOutcome && yesOutcome.onChainId === market.token_id) {
        return 'YES';
      }

      const noOutcome = market.outcomes.find(o =>
        o.name.toLowerCase() === 'no' ||
        o.name.toLowerCase() === 'down' ||
        o.name.toLowerCase() === 'false' ||
        o.indexSet === 2
      );
      if (noOutcome && noOutcome.onChainId === market.token_id) {
        return 'NO';
      }
    }

    // Fallback：使用旧的推断逻辑
    const rawOutcome = String(market.outcome || '').toUpperCase();
    if (rawOutcome.includes('YES')) {
      return 'YES';
    }
    if (rawOutcome.includes('NO')) {
      return 'NO';
    }

    const q = market.question.toLowerCase();
    if (/\b(yes|true)\b/.test(q)) {
      return 'YES';
    }
    if (/\b(no|false)\b/.test(q)) {
      return 'NO';
    }

    return null;
  }

  /**
   * 执行统一策略的挂单逻辑
   */
  private async executeUnifiedStrategy(
    market: Market,
    orderbook: Orderbook,
    position: Position,
    analysis: any
  ): Promise<void> {
    // 修复：获取 YES 和 NO 的 token_id
    const { yesTokenId, noTokenId } = this.getYesNoTokenIds(market);

    if (!yesTokenId || !noTokenId) {
      console.warn(`⚠️  无法获取 YES/NO token_id，跳过统一策略`);
      return;
    }

    console.log(`🔑 使用不同的 token_id:`);
    console.log(`   YES: ${yesTokenId.slice(0, 16)}...`);
    console.log(`   NO:  ${noTokenId.slice(0, 16)}...`);

    // MEDIUM FIX #13: 使用 getAggregatedPosition 方法（移除重复逻辑）
    const unifiedPosition = this.getAggregatedPosition(market);

    console.log(`📊 聚合持仓: YES=${unifiedPosition.yes_amount}, NO=${unifiedPosition.no_amount}`);

    // 修复 2: 分别获取 YES 和 NO 的订单簿（并行化，减少延迟）
    const [yesOrderbook, noOrderbook] = await Promise.all([
      yesTokenId ? this.api.getOrderbook(yesTokenId) : Promise.resolve(orderbook),
      noTokenId ? this.api.getOrderbook(noTokenId) : Promise.resolve(orderbook),
    ]);

    // FIX: 将 YES/NO 的 orderbook 写入缓存，使 placeLimitOrder 的 BBO 硬验证能正确工作
    // 之前只缓存了父 token_id，导致 YES/NO token 下单时 BBO 验证被跳过（cachedBook=undefined）
    if (yesTokenId && yesTokenId !== market.token_id) {
      this.pointsOrderbookCache.set(yesTokenId, yesOrderbook);
      this.pointsOrderbookCacheTs.set(yesTokenId, Date.now());
      await this.checkCancelOnDisplacement(yesTokenId, yesOrderbook); // v24: await撤单
    }
    if (noTokenId && noTokenId !== market.token_id) {
      this.pointsOrderbookCache.set(noTokenId, noOrderbook);
      this.pointsOrderbookCacheTs.set(noTokenId, Date.now());
      await this.checkCancelOnDisplacement(noTokenId, noOrderbook); // v24: await撤单
    }

    if (this.isUnsafeBook(yesOrderbook) || this.isUnsafeBook(noOrderbook)) {
      console.warn('🛑 统一策略跳过：YES/NO 盘口价差异常');
      await this.handlePredictUnsafePair(yesTokenId, noTokenId);
      return;
    }

    // BUG#2 FIX: 对 YES/NO 各自的 orderbook 补充筛选
    // placeMMOrders 的 screenMarket 只检查了父 market 的 orderbook
    // 但 YES/NO 各自的 orderbook 可能深度更薄、价差更大
    const yesMarketForCheck = { ...market, token_id: yesTokenId };
    const noMarketForCheck = { ...market, token_id: noTokenId };
    const yesScreen = this.screenMarket(yesMarketForCheck, yesOrderbook);
    const noScreen = this.screenMarket(noMarketForCheck, noOrderbook);
    if (!yesScreen.safe || !noScreen.safe) {
      console.warn(`🛑 统一策略跳过: YES/NO子市场不安全`);
      console.warn(`   YES: ${yesScreen.safe ? '✅' : '❌ ' + yesScreen.reason}`);
      console.warn(`   NO:  ${noScreen.safe ? '✅' : '❌ ' + noScreen.reason}`);
      await this.cancelOrdersForMarket(yesTokenId);
      await this.cancelOrdersForMarket(noTokenId);
      return;
    }

    // BUG#3 FIX: 竞态验证 — 从 placeMMOrders 筛选到这里之间可能已过几百ms
    // 用新获取的 orderbook 验证盘口是否还在安全范围内
    const mode = this.getModeParams();
    const absoluteMinDist = this.getDynamicAbsoluteMin(yesTokenId, yesOrderbook) / 100; // 动态距离（美元）
    const maxSpreadCentsCheck = this.getEffectiveLiquidityActivation(market)?.max_spread_cents ?? 0;

    // 检查 YES orderbook 的盘口价差是否仍在可接受范围
    if (yesOrderbook.best_bid && yesOrderbook.best_ask) {
      const yesSpread = (yesOrderbook.best_ask - yesOrderbook.best_bid) * 100;
      if (maxSpreadCentsCheck > 0 && yesSpread > maxSpreadCentsCheck * mode.spreadBudgetRatio) {
        console.warn(`🛑 竞态检测: YES盘口价差已扩大到${yesSpread.toFixed(1)}c，跳过`);
        await this.cancelOrdersForMarket(yesTokenId);
        await this.cancelOrdersForMarket(noTokenId);
        return;
      }
    }
    // 检查 NO orderbook
    if (noOrderbook.best_bid && noOrderbook.best_ask) {
      const noSpread = (noOrderbook.best_ask - noOrderbook.best_bid) * 100;
      if (maxSpreadCentsCheck > 0 && noSpread > maxSpreadCentsCheck * mode.spreadBudgetRatio) {
        console.warn(`🛑 竞态检测: NO盘口价差已扩大到${noSpread.toFixed(1)}c，跳过`);
        await this.cancelOrdersForMarket(yesTokenId);
        await this.cancelOrdersForMarket(noTokenId);
        return;
      }
    }

    const yesPrice = yesOrderbook.best_bid || 0;
    const noPrice = noOrderbook.best_bid || (1 - yesPrice);

    console.log(`📊 实际价格: YES=$${yesPrice.toFixed(4)} NO=$${noPrice.toFixed(4)}`);

    // ===== 关键修复：使用 calculatePrices() 的安全报价 =====
    // 之前的 suggestOrderPrices 只用固定1%偏移，离盘口太近容易被吃
    // 现在用 calculatePrices() 精心计算的积分优先安全距离

    const yesMarket = { ...market, token_id: yesTokenId };
    const noMarket = { ...market, token_id: noTokenId };

    // BUG#5 FIX: 将父tokenId的状态复制到YES/NO tokenId下
    // calculatePrices内部用 market.token_id 查找 volatilityEma、lastPrices、fillPenalty 等状态
    // 这些状态通常在主循环中用父tokenId维护，yesTokenId/noTokenId 下可能是空的
    // 复制后 calculatePrices 才能正确读取安全状态（波动率惩罚、被吃惩罚等）
    const parentId = market.token_id;
    this.ensureStateForToken(parentId, yesTokenId);
    this.ensureStateForToken(parentId, noTokenId);

    const yesQuotePrices = this.calculatePrices(yesMarket, yesOrderbook);
    const noQuotePrices = this.calculatePrices(noMarket, noOrderbook);

    // 计算安全距离
    let yesBid = 0, yesAsk = 0, noBid = 0, noAsk = 0;
    let yesSpread = 0.02, noSpread = 0.02;

    if (yesQuotePrices) {
      yesBid = yesQuotePrices.bidPrice;
      yesAsk = yesQuotePrices.askPrice;
      yesSpread = yesQuotePrices.spread;
      const distBid = yesOrderbook.best_bid ? (yesOrderbook.best_bid - yesBid) * 100 : 0;
      const distAsk = yesOrderbook.best_ask ? (yesAsk - yesOrderbook.best_ask) * 100 : 0;
      console.log(`🛡️ YES 安全报价: bid=$${yesBid.toFixed(4)}(离盘口${distBid.toFixed(1)}c) ask=$${yesAsk.toFixed(4)}(离盘口${distAsk.toFixed(1)}c) spread=${(yesSpread*100).toFixed(1)}c`);
    } else {
      console.log(`⚠️ YES calculatePrices 返回 null — 放弃挂单（不使用不安全的兜底）`);
      // BUG#6 FIX: 不再使用兜底价格挂单
      // 兜底只用 absoluteMinBufferCents (保守3.0c / 激进2.5c) 的距离，没有验证spread是否在max_spread范围内
      // 可能挂出不获积分且容易被吃的废单。直接放弃，等下一个循环重新计算。
      yesBid = 0;
      yesAsk = 0;
    }

    if (noQuotePrices) {
      noBid = noQuotePrices.bidPrice;
      noAsk = noQuotePrices.askPrice;
      noSpread = noQuotePrices.spread;
      const distBid = noOrderbook.best_bid ? (noOrderbook.best_bid - noBid) * 100 : 0;
      const distAsk = noOrderbook.best_ask ? (noAsk - noOrderbook.best_ask) * 100 : 0;
      console.log(`🛡️ NO 安全报价: bid=$${noBid.toFixed(4)}(离盘口${distBid.toFixed(1)}c) ask=$${noAsk.toFixed(4)}(离盘口${distAsk.toFixed(1)}c) spread=${(noSpread*100).toFixed(1)}c`);
    } else {
      console.log(`⚠️ NO calculatePrices 返回 null — 放弃挂单（不使用不安全的兜底）`);
      // BUG#6 FIX: 同上，放弃兜底
      noBid = 0;
      noAsk = 0;
    }

    // BUG#6 FIX: 最终安全验证 — 如果所有报价都为0则放弃本轮
    if (yesBid <= 0 && yesAsk <= 0 && noBid <= 0 && noAsk <= 0) {
      console.log(`⚠️ 统一策略: 所有安全报价都为空，放弃本轮挂单`);
      return;
    }

    // ===== v27: 最终硬距离验证（统一调用 validatePriceDistance） =====
    let rejectedAny = false;
    const isYesTierPriced = yesQuotePrices?.tierPriced === true;
    const isNoTierPriced = noQuotePrices?.tierPriced === true;

    const yesValidation = this.validatePriceDistance(yesBid, yesAsk, yesOrderbook, yesTokenId, isYesTierPriced, '硬距离 YES');
    for (const r of yesValidation.rejected) { console.warn(`🛑 ${r}，拒绝!`); rejectedAny = true; }
    yesBid = yesValidation.bid;
    yesAsk = yesValidation.ask;

    const noValidation = this.validatePriceDistance(noBid, noAsk, noOrderbook, noTokenId, isNoTierPriced, '硬距离 NO');
    for (const r of noValidation.rejected) { console.warn(`🛑 ${r}，拒绝!`); rejectedAny = true; }
    noBid = noValidation.bid;
    noAsk = noValidation.ask;

    if (rejectedAny && yesBid <= 0 && yesAsk <= 0 && noBid <= 0 && noAsk <= 0) {
      console.warn(`🛑 硬距离验证: 所有报价都被拒绝，放弃本轮`);
      return;
    }

    // 计算订单大小
    let buyOrderSize = analysis.buyOrderSize;
    let sellOrderSize = analysis.sellOrderSize;

    // v22: 并行取消两个 token_id 的订单（原来串行，浪费一倍延迟）
    // H2 FIX: 检查撤单是否成功，有残留订单则放弃本轮
    const [yesCancelRes, noCancelRes] = await Promise.allSettled([
      this.cancelOrdersForMarket(yesTokenId),
      this.cancelOrdersForMarket(noTokenId),
    ]);
    const yesCancelOk = yesCancelRes.status === 'fulfilled' ? yesCancelRes.value : false;
    const noCancelOk = noCancelRes.status === 'fulfilled' ? noCancelRes.value : false;
    if (!yesCancelOk || !noCancelOk) {
      const failedTokens = [];
      if (!yesCancelOk) failedTokens.push('YES');
      if (!noCancelOk) failedTokens.push('NO');
      console.warn(`🛑 撤单未完全成功(${failedTokens.join(', ')}有残留订单)，放弃本轮以防重复挂单`);
      return;
    }

    // FIX: 取消订单后并行重新获取最新 orderbook 并更新缓存
    // 从获取 orderbook 到这里已经过了 1-3 秒（计算价格 + 取消订单的 API 调用）
    // 这段时间盘口可能已经移动，必须刷新后再下单
    let freshYesBook = yesOrderbook;
    let freshNoBook = noOrderbook;
    try {
      const freshBooks = await Promise.all([
        yesTokenId ? this.api.getOrderbook(yesTokenId) : Promise.resolve(yesOrderbook),
        noTokenId ? this.api.getOrderbook(noTokenId) : Promise.resolve(noOrderbook),
      ]);
      freshYesBook = freshBooks[0];
      freshNoBook = freshBooks[1];
      if (yesTokenId && yesTokenId !== market.token_id) {
        this.pointsOrderbookCache.set(yesTokenId, freshYesBook);
        this.pointsOrderbookCacheTs.set(yesTokenId, Date.now());
        await this.checkCancelOnDisplacement(yesTokenId, freshYesBook); // v24: await撤单
      }
      if (noTokenId && noTokenId !== market.token_id) {
        this.pointsOrderbookCache.set(noTokenId, freshNoBook);
        this.pointsOrderbookCacheTs.set(noTokenId, Date.now());
        await this.checkCancelOnDisplacement(noTokenId, freshNoBook); // v24: await撤单
      }
    } catch (e) {
      console.warn(`⚠️ 刷新 orderbook 失败，使用旧数据: ${e instanceof Error ? e.message : String(e)}`);
    }

    // v23: 用刷新后的orderbook重新计算价格！
    // 之前用的是旧orderbook算的价格，取消订单+获取新orderbook期间盘口可能已经移动
    // 必须用最新orderbook重新算价，否则可能挂在离盘口太近的位置
    let v23Recalc = false;
    try {
      // 对比新旧盘口是否有显著移动
      const yesBidMoved = freshYesBook.best_bid && yesOrderbook.best_bid &&
        Math.abs(freshYesBook.best_bid - yesOrderbook.best_bid) > 0.001;
      const noBidMoved = freshNoBook.best_bid && noOrderbook.best_bid &&
        Math.abs(freshNoBook.best_bid - noOrderbook.best_bid) > 0.001;
      if (yesBidMoved || noBidMoved) {
        console.log(`📊 v23重新计算: YES盘口${yesOrderbook.best_bid?.toFixed(4)}→${freshYesBook.best_bid?.toFixed(4)} NO盘口${noOrderbook.best_bid?.toFixed(4)}→${freshNoBook.best_bid?.toFixed(4)}`);
        // v24: 用新orderbook重新计算YES价格 — 如果返回null说明市场不安全，必须放弃
        if (yesQuotePrices && freshYesBook.best_bid) {
          const newYesQuote = this.calculatePrices(yesMarket, freshYesBook);
          if (newYesQuote) {
            if (yesBid > 0) yesBid = newYesQuote.bidPrice;
            if (yesAsk > 0) yesAsk = newYesQuote.askPrice;
            yesSpread = newYesQuote.spread;
            v23Recalc = true;
          } else {
            // v24 FIX: calculatePrices返回null=市场不安全，不能用旧价格下单
            console.warn(`🛑 v24重新计算: YES calculatePrices返回null（市场不安全），放弃YES侧!`);
            yesBid = 0;
            yesAsk = 0;
          }
        }
        // v24: 用新orderbook重新计算NO价格 — 同理
        if (noQuotePrices && freshNoBook.best_bid) {
          const newNoQuote = this.calculatePrices(noMarket, freshNoBook);
          if (newNoQuote) {
            if (noBid > 0) noBid = newNoQuote.bidPrice;
            if (noAsk > 0) noAsk = newNoQuote.askPrice;
            noSpread = newNoQuote.spread;
            v23Recalc = true;
          } else {
            console.warn(`🛑 v24重新计算: NO calculatePrices返回null（市场不安全），放弃NO侧!`);
            noBid = 0;
            noAsk = 0;
          }
        }
        if (v23Recalc) {
          // 重新做硬距离验证（用新盘口数据）
          const recalcRejected = this.revalidatePricesAfterRecalc(
            yesBid, yesAsk, freshYesBook, isYesTierPriced, 'YES', yesTokenId,
            noBid, noAsk, freshNoBook, isNoTierPriced, 'NO', noTokenId
          );
          if (recalcRejected) {
            yesBid = recalcRejected.yesBid;
            yesAsk = recalcRejected.yesAsk;
            noBid = recalcRejected.noBid;
            noAsk = recalcRejected.noAsk;
          }
          if (yesBid <= 0 && yesAsk <= 0 && noBid <= 0 && noAsk <= 0) {
            console.warn(`🛑 v23重新计算后: 所有报价都被拒绝，放弃本轮`);
            return;
          }
        }
      }
    } catch (e) {
      console.warn(`⚠️ v23重新计算失败，放弃本轮以防用旧价格下单: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    // v21: 根据前档厚度动态缩小订单 — 前档越薄，单量越小
    const v21Mode = this.getModeParams();
    const minFrontShares = v21Mode.minFrontDepth;
    if (buyOrderSize > 0) {
      // v26 fix: 同时检查YES和NO的bids前档，取更保守值
      let yesFrontBidShares = 0;
      let noFrontBidShares = 0;
      if (freshYesBook.bids) {
        for (let i = 0; i < v21Mode.quoteLevel - 1 && i < freshYesBook.bids.length; i++) {
          yesFrontBidShares += Number(freshYesBook.bids[i]?.shares || 0);
        }
      }
      if (freshNoBook.bids) {
        for (let i = 0; i < v21Mode.quoteLevel - 1 && i < freshNoBook.bids.length; i++) {
          noFrontBidShares += Number(freshNoBook.bids[i]?.shares || 0);
        }
      }
      const yesRatio = minFrontShares > 0 ? yesFrontBidShares / minFrontShares : 1;
      const noRatio = minFrontShares > 0 ? noFrontBidShares / minFrontShares : 1;
      const frontRatio = Math.min(yesRatio, noRatio); // 取更保守的
      if (frontRatio < 0.5) {
        buyOrderSize = Math.max(1, Math.floor(buyOrderSize * 0.25));
        console.log(`📐 v21缩单: BUY前档比${frontRatio.toFixed(2)}(YES=${yesRatio.toFixed(2)},NO=${noRatio.toFixed(2)}) < 0.5，缩单到${buyOrderSize}`);
      } else if (frontRatio < 1.0) {
        buyOrderSize = Math.max(1, Math.floor(buyOrderSize * 0.5));
        console.log(`📐 v21缩单: BUY前档比${frontRatio.toFixed(2)}(YES=${yesRatio.toFixed(2)},NO=${noRatio.toFixed(2)}) < 1.0，缩单到${buyOrderSize}`);
      }
    }
    if (sellOrderSize > 0) {
      // v26 fix: 同时检查YES和NO的asks前档，取更保守值
      let yesFrontAskShares = 0;
      let noFrontAskShares = 0;
      if (freshYesBook.asks) {
        for (let i = 0; i < v21Mode.quoteLevel - 1 && i < freshYesBook.asks.length; i++) {
          yesFrontAskShares += Number(freshYesBook.asks[i]?.shares || 0);
        }
      }
      if (freshNoBook.asks) {
        for (let i = 0; i < v21Mode.quoteLevel - 1 && i < freshNoBook.asks.length; i++) {
          noFrontAskShares += Number(freshNoBook.asks[i]?.shares || 0);
        }
      }
      const yesRatio = minFrontShares > 0 ? yesFrontAskShares / minFrontShares : 1;
      const noRatio = minFrontShares > 0 ? noFrontAskShares / minFrontShares : 1;
      const frontRatio = Math.min(yesRatio, noRatio); // 取更保守的
      if (frontRatio < 0.5) {
        sellOrderSize = Math.max(1, Math.floor(sellOrderSize * 0.25));
        console.log(`📐 v21缩单: SELL前档比${frontRatio.toFixed(2)}(YES=${yesRatio.toFixed(2)},NO=${noRatio.toFixed(2)}) < 0.5，缩单到${sellOrderSize}`);
      } else if (frontRatio < 1.0) {
        sellOrderSize = Math.max(1, Math.floor(sellOrderSize * 0.5));
        console.log(`📐 v21缩单: SELL前档比${frontRatio.toFixed(2)}(YES=${yesRatio.toFixed(2)},NO=${noRatio.toFixed(2)}) < 1.0，缩单到${sellOrderSize}`);
      }
    }

    // v27: 用最新 orderbook 重新做硬距离验证（统一调用 validatePriceDistance）
    const preYesValidation = this.validatePriceDistance(yesBid, yesAsk, freshYesBook, yesTokenId, isYesTierPriced, '下单前 YES');
    for (const r of preYesValidation.rejected) console.warn(`🛑 ${r}，放弃!`);
    yesBid = preYesValidation.bid;
    yesAsk = preYesValidation.ask;

    const preNoValidation = this.validatePriceDistance(noBid, noAsk, freshNoBook, noTokenId, isNoTierPriced, '下单前 NO');
    for (const r of preNoValidation.rejected) console.warn(`🛑 ${r}，放弃!`);
    noBid = preNoValidation.bid;
    noAsk = preNoValidation.ask;

    // 如果刷新后所有报价都不安全，放弃本轮
    if (yesBid <= 0 && yesAsk <= 0 && noBid <= 0 && noAsk <= 0) {
      console.warn(`🛑 下单前验证: 刷新orderbook后所有报价都不安全，放弃本轮`);
      return;
    }

    // H3 FIX: 改为顺序下单，避免并行写入 openOrders 竞态
    // 之前用 Promise.all 并行4个单，导致 openOrders.set() 竞态
    const placeResults: boolean[] = [];
    const placeLabels: string[] = [];

    if (analysis.shouldPlaceBuyOrders && buyOrderSize > 0) {
      if (yesBid > 0.01) {
        placeLabels.push('YES BUY');
        try {
          placeResults.push(await this.placeLimitOrder(yesMarket, 'BUY', yesBid, buyOrderSize, yesSpread, yesQuotePrices));
        } catch (e) { console.warn(`⚠️ placeLimitOrder异常(YES BUY): ${e instanceof Error ? e.message : String(e)}`); placeResults.push(false); }
      }
      if (noBid > 0.01) {
        placeLabels.push('NO BUY');
        try {
          placeResults.push(await this.placeLimitOrder(noMarket, 'BUY', noBid, buyOrderSize, noSpread, noQuotePrices));
        } catch (e) { console.warn(`⚠️ placeLimitOrder异常(NO BUY): ${e instanceof Error ? e.message : String(e)}`); placeResults.push(false); }
      }
    }
    if (analysis.shouldPlaceSellOrders && sellOrderSize > 0) {
      if (yesAsk > 0.01 && yesAsk < 0.99 && unifiedPosition.yes_amount > 0) {
        placeLabels.push('YES SELL');
        try {
          placeResults.push(await this.placeLimitOrder(yesMarket, 'SELL', yesAsk, sellOrderSize, yesSpread, yesQuotePrices));
        } catch (e) { console.warn(`⚠️ placeLimitOrder异常(YES SELL): ${e instanceof Error ? e.message : String(e)}`); placeResults.push(false); }
      }
      if (noAsk > 0.01 && noAsk < 0.99 && unifiedPosition.no_amount > 0) {
        placeLabels.push('NO SELL');
        try {
          placeResults.push(await this.placeLimitOrder(noMarket, 'SELL', noAsk, sellOrderSize, noSpread, noQuotePrices));
        } catch (e) { console.warn(`⚠️ placeLimitOrder异常(NO SELL): ${e instanceof Error ? e.message : String(e)}`); placeResults.push(false); }
      }
    }
    let placedYesBid = placeLabels.includes('YES BUY') && placeResults[placeLabels.indexOf('YES BUY')] === true;
    let placedNoBid = placeLabels.includes('NO BUY') && placeResults[placeLabels.indexOf('NO BUY')] === true;
    let placedYesAsk = placeLabels.includes('YES SELL') && placeResults[placeLabels.indexOf('YES SELL')] === true;
    let placedNoAsk = placeLabels.includes('NO SELL') && placeResults[placeLabels.indexOf('NO SELL')] === true;

    console.log(`✅ 统一策略挂单完成（使用 calculatePrices 安全报价）`);

    // ===== v27: 下单后即时安全验证（tierPriced无硬距离，只查BBO+前档+排名） =====
    try {
      await new Promise(r => setTimeout(r, 200));
      const [verifyYesBook, verifyNoBook] = await Promise.all([
        this.api.getOrderbook(yesTokenId),
        this.api.getOrderbook(noTokenId),
      ]);
      let needCancel = false;
      const postMode = this.getModeParams(); // 只调用一次

      // --- YES 侧验证 ---
      if (isYesTierPriced) {
        // tierPriced: BBO检查（无硬距离）
        if (placedYesBid && verifyYesBook.best_bid && yesBid >= verifyYesBook.best_bid) {
          console.warn(`🛑 下单后验证: YES BID >= 最新BBO，撤单!`);
          needCancel = true;
        }
        if (placedYesAsk && verifyYesBook.best_ask && yesAsk <= verifyYesBook.best_ask) {
          console.warn(`🛑 下单后验证: YES ASK <= 最新BBO，撤单!`);
          needCancel = true;
        }
        // 前档深度检查（排除自己的挂单）
        const yesMyPrices = this.getMyOrderPrices(yesTokenId);
        if (!needCancel && placedYesBid && verifyYesBook.bids) {
          const frontLevels = postMode.quoteLevel - 1;
          if (frontLevels > 0) {
            let frontRemaining = 0;
            for (let i = 0; i < frontLevels && i < verifyYesBook.bids.length; i++) {
              const p = Number(verifyYesBook.bids[i]?.price || 0);
              if (p > yesBid && !yesMyPrices.has(p)) {
                frontRemaining += Number(verifyYesBook.bids[i]?.shares || 0);
              }
            }
            if (frontRemaining < Math.floor(postMode.minFrontDepth * 0.3)) {
              console.warn(`🛑 下单后验证: YES BID前档仅剩${frontRemaining}股 < ${Math.floor(postMode.minFrontDepth * 0.3)}股，前档被吃!`);
              needCancel = true;
            }
          }
        }
        // BID排名检查（排除自己的挂单）
        if (!needCancel && placedYesBid && verifyYesBook.bids) {
          let myRank = 0;
          for (const entry of verifyYesBook.bids) {
            const p = Number(entry?.price || 0);
            if (p > yesBid && !yesMyPrices.has(p)) {
              myRank++;
            } else {
              break;
            }
          }
          if (myRank < postMode.quoteLevel - 1) {
            console.warn(`🛑 v21排名验证: YES BID实际排名第${myRank+1} < 需要${postMode.quoteLevel}，前面保护不足!`);
            needCancel = true;
          }
        }
        if (!needCancel && placedYesAsk && verifyYesBook.asks) {
          const frontLevels = postMode.quoteLevel - 1;
          if (frontLevels > 0) {
            let frontRemaining = 0;
            for (let i = 0; i < frontLevels && i < verifyYesBook.asks.length; i++) {
              const p = Number(verifyYesBook.asks[i]?.price || 0);
              if (p < yesAsk && !yesMyPrices.has(p)) {
                frontRemaining += Number(verifyYesBook.asks[i]?.shares || 0);
              }
            }
            if (frontRemaining < Math.floor(postMode.minFrontDepth * 0.3)) {
              console.warn(`🛑 下单后验证: YES ASK前档仅剩${frontRemaining}股 < ${Math.floor(postMode.minFrontDepth * 0.3)}股，前档被吃!`);
              needCancel = true;
            }
          }
        }
        if (!needCancel && placedYesAsk && verifyYesBook.asks) {
          let myRank = 0;
          for (const entry of verifyYesBook.asks) {
            const p = Number(entry?.price || 0);
            if (p < yesAsk && !yesMyPrices.has(p)) {
              myRank++;
            } else {
              break;
            }
          }
          if (myRank < postMode.quoteLevel - 1) {
            console.warn(`🛑 v21排名验证: YES ASK实际排名第${myRank+1} < 需要${postMode.quoteLevel}，前面保护不足!`);
            needCancel = true;
          }
        }
      } else {
        // nonTierPriced: 动态距离检查
        const verifyYesMinDist = this.getDynamicAbsoluteMin(yesTokenId, verifyYesBook) / 100;
        if (placedYesBid && verifyYesBook.best_bid && (verifyYesBook.best_bid - yesBid) < verifyYesMinDist) {
          console.warn(`🛑 下单后验证: YES BID 离最新盘口${((verifyYesBook.best_bid - yesBid) * 100).toFixed(2)}c < ${(verifyYesMinDist * 100).toFixed(1)}c，立刻撤单!`);
          needCancel = true;
        }
        if (placedYesAsk && verifyYesBook.best_ask && (yesAsk - verifyYesBook.best_ask) < verifyYesMinDist) {
          console.warn(`🛑 下单后验证: YES ASK 离最新盘口${((yesAsk - verifyYesBook.best_ask) * 100).toFixed(2)}c < ${(verifyYesMinDist * 100).toFixed(1)}c，立刻撤单!`);
          needCancel = true;
        }
      }

      // --- NO 侧验证 ---
      if (isNoTierPriced) {
        if (placedNoBid && verifyNoBook.best_bid && noBid >= verifyNoBook.best_bid) {
          console.warn(`🛑 下单后验证: NO BID >= 最新BBO，撤单!`);
          needCancel = true;
        }
        if (placedNoAsk && verifyNoBook.best_ask && noAsk <= verifyNoBook.best_ask) {
          console.warn(`🛑 下单后验证: NO ASK <= 最新BBO，撤单!`);
          needCancel = true;
        }
        const noMyPrices = this.getMyOrderPrices(noTokenId);
        if (!needCancel && placedNoBid && verifyNoBook.bids) {
          const frontLevels = postMode.quoteLevel - 1;
          if (frontLevels > 0) {
            let frontRemaining = 0;
            for (let i = 0; i < frontLevels && i < verifyNoBook.bids.length; i++) {
              const p = Number(verifyNoBook.bids[i]?.price || 0);
              if (p > noBid && !noMyPrices.has(p)) {
                frontRemaining += Number(verifyNoBook.bids[i]?.shares || 0);
              }
            }
            if (frontRemaining < Math.floor(postMode.minFrontDepth * 0.3)) {
              console.warn(`🛑 下单后验证: NO BID前档仅剩${frontRemaining}股 < ${Math.floor(postMode.minFrontDepth * 0.3)}股，前档被吃!`);
              needCancel = true;
            }
          }
        }
        if (!needCancel && placedNoBid && verifyNoBook.bids) {
          let myRank = 0;
          for (const entry of verifyNoBook.bids) {
            const p = Number(entry?.price || 0);
            if (p > noBid && !noMyPrices.has(p)) {
              myRank++;
            } else {
              break;
            }
          }
          if (myRank < postMode.quoteLevel - 1) {
            console.warn(`🛑 v21排名验证: NO BID实际排名第${myRank+1} < 需要${postMode.quoteLevel}，前面保护不足!`);
            needCancel = true;
          }
        }
        if (!needCancel && placedNoAsk && verifyNoBook.asks) {
          const frontLevels = postMode.quoteLevel - 1;
          if (frontLevels > 0) {
            let frontRemaining = 0;
            for (let i = 0; i < frontLevels && i < verifyNoBook.asks.length; i++) {
              const p = Number(verifyNoBook.asks[i]?.price || 0);
              if (p < noAsk && !noMyPrices.has(p)) {
                frontRemaining += Number(verifyNoBook.asks[i]?.shares || 0);
              }
            }
            if (frontRemaining < Math.floor(postMode.minFrontDepth * 0.3)) {
              console.warn(`🛑 下单后验证: NO ASK前档仅剩${frontRemaining}股 < ${Math.floor(postMode.minFrontDepth * 0.3)}股，前档被吃!`);
              needCancel = true;
            }
          }
        }
        if (!needCancel && placedNoAsk && verifyNoBook.asks) {
          let myRank = 0;
          for (const entry of verifyNoBook.asks) {
            const p = Number(entry?.price || 0);
            if (p < noAsk && !noMyPrices.has(p)) {
              myRank++;
            } else {
              break;
            }
          }
          if (myRank < postMode.quoteLevel - 1) {
            console.warn(`🛑 v21排名验证: NO ASK实际排名第${myRank+1} < 需要${postMode.quoteLevel}，前面保护不足!`);
            needCancel = true;
          }
        }
      } else {
        const verifyNoMinDist = this.getDynamicAbsoluteMin(noTokenId, verifyNoBook) / 100;
        if (placedNoBid && verifyNoBook.best_bid && (verifyNoBook.best_bid - noBid) < verifyNoMinDist) {
          console.warn(`🛑 下单后验证: NO BID 离最新盘口${((verifyNoBook.best_bid - noBid) * 100).toFixed(2)}c < ${(verifyNoMinDist * 100).toFixed(1)}c，立刻撤单!`);
          needCancel = true;
        }
        if (placedNoAsk && verifyNoBook.best_ask && (noAsk - verifyNoBook.best_ask) < verifyNoMinDist) {
          console.warn(`🛑 下单后验证: NO ASK 离最新盘口${((noAsk - verifyNoBook.best_ask) * 100).toFixed(2)}c < ${(verifyNoMinDist * 100).toFixed(1)}c，立刻撤单!`);
          needCancel = true;
        }
      }

      if (needCancel) {
        console.warn(`🛑 下单后验证失败: 盘口已移动，撤掉所有挂单保护资金安全`);
        await this.cancelOrdersForMarket(yesTokenId);
        await this.cancelOrdersForMarket(noTokenId);
        // 标记冷却，等盘口稳定后再重新评估
        this.markCooldown(market.token_id, Math.max(5000, this.config.cooldownAfterCancelMs ?? 4000));
        // 取消的订单不算已挂
        placedYesBid = false;
        placedYesAsk = false;
        placedNoBid = false;
        placedNoAsk = false;
      }
    } catch (e) {
      console.warn(`⚠️ 下单后验证异常（不影响已挂订单）: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 修复 4: 记录挂单价格到两个 key（用于监控是否成为第一档）
    const priceData = {
      yesBid: placedYesBid ? yesBid : 0,
      yesAsk: placedYesAsk ? yesAsk : 0,
      noBid: placedNoBid ? noBid : 0,
      noAsk: placedNoAsk ? noAsk : 0,
      timestamp: Date.now(),
    };

    this.lastPlacedPrices.set(yesTokenId, priceData);
    this.lastPlacedPrices.set(noTokenId, priceData);
  }

  /**
   * 监控订单是否成为第一档（动态偏移模式）
   * 如果我们的订单成为第一档，立即撤单并重新挂单
   */
  private async monitorTierOneStatus(
    market: Market,
    orderbook: Orderbook
  ): Promise<boolean> {
    // 检查是否启用监控
    if (!this.config.unifiedMarketMakerMonitorTierOne) {
      return false;
    }

    // 检查是否使用统一策略
    if (!this.unifiedMarketMakerStrategy.isEnabled()) {
      return false;
    }

    const { yesTokenId, noTokenId } = this.getYesNoTokenIds(market);
    if (!yesTokenId) {
      return false;
    }

    const lastPrices = this.lastPlacedPrices.get(yesTokenId);
    if (!lastPrices) {
      return false;
    }

    // 检查时间戳（避免频繁检查，最多每1秒检查一次）
    const timeSinceLastPlace = Date.now() - lastPrices.timestamp;
    if (timeSinceLastPlace < 1000) {
      return false;
    }

    // ====== v12 档位偏移检测 ======
    // 正确做法：数我们的挂单价格前面（离盘口更近的方向）还有多少层别人的单
    // 如果前面只有 < quoteLevel-1 层 → 前面被吃了 → 撤单重挂
    const mode = this.getModeParams();
    const targetLevel = mode.quoteLevel; // 3 or 4

    let needsReprice = false;
    const reasons: string[] = [];

    // 检查 YES bid（我们的买价前面还有多少层 bid）
    const yesBook = this.pointsOrderbookCache.get(yesTokenId) || orderbook;
    if (yesBook && Array.isArray(yesBook.bids)) {
      if (lastPrices.yesBid > 0) {
        const sortedBids = [...yesBook.bids]
          .map(e => Number(e.price || 0))
          .filter(p => p > 0)
          .sort((a, b) => b - a); // 高→低
        // 数比我们价格高的有多少层（这些在我们前面）
        const layersAhead = sortedBids.filter(p => p > lastPrices.yesBid).length;
        if (layersAhead < targetLevel - 1) {
          needsReprice = true;
          reasons.push(`YES Bid 前面仅剩${layersAhead}层(需要${targetLevel - 1}层), 挂单价$${lastPrices.yesBid.toFixed(4)}`);
        }
      }

      // 检查 YES ask（我们的卖价前面还有多少层 ask）
      if (lastPrices.yesAsk > 0) {
        const sortedAsks = [...yesBook.asks]
          .map(e => Number(e.price || 0))
          .filter(p => p > 0)
          .sort((a, b) => a - b); // 低→高
        // 数比我们价格低的有多少层（这些在我们前面）
        const layersAhead = sortedAsks.filter(p => p < lastPrices.yesAsk).length;
        if (layersAhead < targetLevel - 1) {
          needsReprice = true;
          reasons.push(`YES Ask 前面仅剩${layersAhead}层(需要${targetLevel - 1}层), 挂单价$${lastPrices.yesAsk.toFixed(4)}`);
        }
      }
    }

    // 检查 NO 订单簿
    if (noTokenId) {
      const noBook = this.pointsOrderbookCache.get(noTokenId);
      if (noBook && Array.isArray(noBook.bids)) {
        if (lastPrices.noBid > 0) {
          const sortedBids = [...noBook.bids]
            .map(e => Number(e.price || 0))
            .filter(p => p > 0)
            .sort((a, b) => b - a);
          const layersAhead = sortedBids.filter(p => p > lastPrices.noBid).length;
          if (layersAhead < targetLevel - 1) {
            needsReprice = true;
            reasons.push(`NO Bid 前面仅剩${layersAhead}层(需要${targetLevel - 1}层), 挂单价$${lastPrices.noBid.toFixed(4)}`);
          }
        }

        if (lastPrices.noAsk > 0) {
          const sortedAsks = [...noBook.asks]
            .map(e => Number(e.price || 0))
            .filter(p => p > 0)
            .sort((a, b) => a - b);
          const layersAhead = sortedAsks.filter(p => p < lastPrices.noAsk).length;
          if (layersAhead < targetLevel - 1) {
            needsReprice = true;
            reasons.push(`NO Ask 前面仅剩${layersAhead}层(需要${targetLevel - 1}层), 挂单价$${lastPrices.noAsk.toFixed(4)}`);
          }
        }
      }
    }

    if (needsReprice) {
      console.log(`⚡ 档位偏移检测: 前方保护层减少，撤单重挂:`);
      for (const reason of reasons) {
        console.log(`   - ${reason}`);
      }

      // 只取消订单，让下一个主循环周期重新走完整的7层防护流程
      if (yesTokenId) {
        await this.cancelOrdersForMarket(yesTokenId);
      }
      if (noTokenId) {
        await this.cancelOrdersForMarket(noTokenId);
      }
      // 短暂冷却（1秒），让撤单生效后立刻重挂
      const tokenId = market.token_id;
      this.markCooldown(tokenId, 1000);

      console.log(`   已取消YES/NO所有挂单，下个循环重新挂到第${targetLevel}档`);
      return true;
    }

    return false;
  }

  /**
   * 处理统一策略的订单成交
   */
  async handleUnifiedOrderFill(
    market: Market,
    side: 'BUY' | 'SELL',
    token: 'YES' | 'NO',
    filledShares: number
  ): Promise<void> {
    // MEDIUM FIX #13: 使用 getAggregatedPosition 方法（移除重复逻辑）
    const { yesTokenId, noTokenId } = this.getYesNoTokenIds(market);

    if (!yesTokenId || !noTokenId) {
      console.warn(`⚠️  无法获取 YES/NO token_id，跳过订单成交处理`);
      return;
    }

    const unifiedPosition = this.getAggregatedPosition(market);

    const action = this.unifiedMarketMakerStrategy.handleOrderFill(
      market.token_id,
      side,
      token,
      filledShares,
      unifiedPosition.yes_amount,
      unifiedPosition.no_amount
    );

    if (!action.needsAction || action.type === 'NONE') {
      return;
    }

    console.log(`🎯 统一策略操作: ${action.type} ${action.shares} shares`);
    console.log(`   原因: ${action.reason}`);
    console.log(`   优先级: ${action.priority}`);

    // 获取目标 token_id
    const targetTokenId = token === 'YES' ? yesTokenId : noTokenId;

    // 记录对冲操作到日报
    const hedgePrice = token === 'YES' ? ((market as any).yes_price || 0.5) : ((market as any).no_price || 0.5);
    const estimatedCost = action.shares * hedgePrice;
    const { recordFill } = await import('./utils/daily-report.js');
    recordFill(0, 0, estimatedCost);

    // 执行对冲操作，使用正确的 token_id
    switch (action.type) {
      case 'BUY_YES':
        await this.executeMarketBuy(market, 'YES', action.shares, yesTokenId);
        console.log(`✅ 异步对冲完成: 买入 ${action.shares} YES @ ${yesTokenId.slice(0, 16)}...`);
        break;

      case 'BUY_NO':
        await this.executeMarketBuy(market, 'NO', action.shares, noTokenId);
        console.log(`✅ 异步对冲完成: 买入 ${action.shares} NO @ ${noTokenId.slice(0, 16)}...`);
        break;

      case 'SELL_YES':
        await this.executeMarketSell(market, 'YES', action.shares, yesTokenId);
        console.log(`✅ 平仓完成: 卖出 ${action.shares} YES @ ${yesTokenId.slice(0, 16)}...`);
        break;

      case 'SELL_NO':
        await this.executeMarketSell(market, 'NO', action.shares, noTokenId);
        console.log(`✅ 平仓完成: 卖出 ${action.shares} NO @ ${noTokenId.slice(0, 16)}...`);
        break;
    }
  }

  /**
   * 获取增强的库存状态
   */
  private getEnhancedInventoryState(tokenId: string): InventoryState {
    return this.perMarketInventoryState.get(tokenId) ?? InventoryState.SAFE;
  }

  /**
   * HIGH FIX #5: 清理过期的状态（防止内存泄漏）
   * 当市场关闭或不再活跃时调用
   */
  private cleanupStaleState(tokenId: string): void {
    // 清理所有相关的 Map 状态
    const mapsToClean: Map<unknown, unknown>[] = [
      this.lastPrices,
      this.lastPriceAt,
      this.lastBestBid,
      this.lastBestAsk,
      this.lastBestBidSize,
      this.lastBestAskSize,
      this.lastBookSpreadDeltaBps,
      this.protectiveUntil,
      this.volatilityEma,
      this.depthEma,
      this.totalDepthEma,
      this.depthTrend,
      this.lastDepth,
      this.lastDepthSpeedBps,
      this.lastBidDepthSpeedBps,
      this.lastAskDepthSpeedBps,
      this.lastImbalance,
      this.lastActionAt,
      this.actionBurst,
      this.actionLockUntil,
      this.cooldownUntil,
      this.pauseUntil,
      this.pauseReasons,
      this.lastHedgeAt,
      this.lastIcebergAt,
      this.lastFillAt,
      this.lastProfile,
      this.lastProfileAt,
      this.icebergPenalty,
      this.nearTouchHoldUntil,
      this.nearTouchPrevDistance,
      this.repriceHoldUntil,
      this.cancelHoldUntil,
      this.sizePenalty,
      this.recheckCooldownUntil,
      this.fillPressure,
      this.cancelBoost,
      this.nearTouchPenalty,
      this.fillPenalty,
      this.layerPanicUntil,
      this.layerRetreatUntil,
      this.layerRestoreAt,
      this.layerRestoreStartAt,
      this.layerRestoreExitPending,
      this.layerRestoreExitRampStartAt,
      this.layerRestoreExitRampUntil,
      this.safeModeExitUntil,
      this.mmMetrics,
      this.pointsOrderbookCache,
      this.polymarketExecutionState,
      this.perMarketVolatility,
      this.perMarketOrderFlow,
      this.perMarketReversion,
      this.perMarketInventoryState,
      this.lastPlacedPrices,
      this.perMarketTwoPhaseState,
      this.wsEmergencyLast,
      this.riskThrottleState,
      this.nearTouchBurst,
      this.fillBurst,
      this.cancelBurst,
      this.marketByToken,
    ];

    for (const map of mapsToClean) {
      map.delete(tokenId);
    }

    // 清理 lastNetShares (使用 condition_id 作为 key)
    const market = this.marketByToken.get(tokenId);
    if (market?.condition_id) {
      this.lastNetShares.delete(market.condition_id);
    }

    console.log(`🧹 已清理市场 ${tokenId.slice(0, 16)}... 的所有状态`);
  }

  /**
   * 批量清理多个市场的状态
   */
  cleanupStaleStateBatch(tokenIds: string[]): void {
    for (const tokenId of tokenIds) {
      this.cleanupStaleState(tokenId);
    }
  }

  /**
   * MEDIUM FIX #2: 结构化日志方法
   */
  private log(level: LogLevel, message: string, context?: LogContext): void {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      message,
      ...context,
    };

    // 输出到控制台
    if (level === LogLevel.ERROR) {
      console.error(JSON.stringify(logEntry));
    } else if (level === LogLevel.WARN) {
      console.warn(JSON.stringify(logEntry));
    } else {
      console.log(JSON.stringify(logEntry));
    }

    // 存储到事件日志
    this.mmEventLog.push({
      ts: Date.now(),
      type: level,
      message,
      ...context,
    });
  }

  /**
   * 便捷的日志方法
   */
  private logError(message: string, context?: LogContext): void {
    this.log(LogLevel.ERROR, message, context);
  }

  private logWarn(message: string, context?: LogContext): void {
    this.log(LogLevel.WARN, message, context);
  }

  private logInfo(message: string, context?: LogContext): void {
    this.log(LogLevel.INFO, message, context);
  }

  private logDebug(message: string, context?: LogContext): void {
    this.log(LogLevel.DEBUG, message, context);
  }

  /**
   * MEDIUM FIX #8: VWAP 估算函数 - 从订单簿计算买入 VWAP（成本）
   *
   * @param levels - 订单簿层级（asks 或 bids）
   * @param targetShares - 目标交易股数
   * @param feeBps - 手续费（基点）
   * @param _unused1 - 未使用的参数（保持兼容性）
   * @param _unused2 - 未使用的参数（保持兼容性）
   * @param slippageBps - 滑点（基点）
   * @param maxLevels - 最大使用层级数
   * @returns VWAP 计算结果
   */
  private estimateBuy(
    levels: OrderLevel[],
    targetShares: number,
    feeBps: number = 0,
    _unused1: unknown = undefined,
    _unused2: unknown = undefined,
    slippageBps: number = 0,
    maxLevels: number = Infinity
  ): { avgAllIn: number; totalShares: number } | null {
    if (!levels || levels.length === 0 || targetShares <= 0) {
      return null;
    }

    let totalShares = 0;
    let totalCost = 0;
    const feeMultiplier = 1 + feeBps / 10000;
    const slippageMultiplier = 1 + slippageBps / 10000;

    for (let i = 0; i < levels.length && i < maxLevels && totalShares < targetShares; i++) {
      const level = levels[i];
      const availableShares = Number(level.shares || 0);
      const shares = Math.min(availableShares, targetShares - totalShares);

      if (shares > 0) {
        const price = Number(level.price || 0) * slippageMultiplier;
        totalCost += shares * price * feeMultiplier;
        totalShares += shares;
      }
    }

    if (totalShares === 0) {
      return null;
    }

    const avgAllIn = totalCost / totalShares;
    return { avgAllIn, totalShares };
  }

  /**
   * MEDIUM FIX #8: VWAP 估算函数 - 从订单簿计算卖出 VWAP（收入）
   *
   * @param levels - 订单簿层级（asks 或 bids）
   * @param targetShares - 目标交易股数
   * @param feeBps - 手续费（基点）
   * @param _unused1 - 未使用的参数（保持兼容性）
   * @param _unused2 - 未使用的参数（保持兼容性）
   * @param slippageBps - 滑点（基点）
   * @param maxLevels - 最大使用层级数
   * @returns VWAP 计算结果
   */
  private estimateSell(
    levels: OrderLevel[],
    targetShares: number,
    feeBps: number = 0,
    _unused1: unknown = undefined,
    _unused2: unknown = undefined,
    slippageBps: number = 0,
    maxLevels: number = Infinity
  ): { avgAllIn: number; totalShares: number } | null {
    if (!levels || levels.length === 0 || targetShares <= 0) {
      return null;
    }

    let totalShares = 0;
    let totalRevenue = 0;
    const feeMultiplier = 1 - feeBps / 10000;
    const slippageMultiplier = 1 - slippageBps / 10000;

    for (let i = 0; i < levels.length && i < maxLevels && totalShares < targetShares; i++) {
      const level = levels[i];
      const availableShares = Number(level.shares || 0);
      const shares = Math.min(availableShares, targetShares - totalShares);

      if (shares > 0) {
        const price = Number(level.price || 0) * slippageMultiplier;
        totalRevenue += shares * price * feeMultiplier;
        totalShares += shares;
      }
    }

    if (totalShares === 0) {
      return null;
    }

    const avgAllIn = totalRevenue / totalShares;
    return { avgAllIn, totalShares };
  }

  /**
   * MEDIUM FIX #6: API 响应验证辅助方法
   */

  /**
   * 验证 Market 对象的基本完整性
   */
  private validateMarket(market: unknown): market is Market {
    if (!market || typeof market !== 'object') {
      this.logError('Invalid market: not an object', { rawMarket: market });
      return false;
    }

    const m = market as Partial<Market>;
    if (!m.token_id || typeof m.token_id !== 'string') {
      this.logError('Invalid market: missing or invalid token_id', { rawMarket: market });
      return false;
    }

    if (!m.question || typeof m.question !== 'string') {
      this.logError('Invalid market: missing or invalid question', { token_id: m.token_id });
      return false;
    }

    if (!m.outcomes || !Array.isArray(m.outcomes) || m.outcomes.length === 0) {
      this.logError('Invalid market: missing or invalid outcomes', { token_id: m.token_id });
      return false;
    }

    return true;
  }

  /**
   * 验证 Orderbook 对象的基本完整性
   */
  private validateOrderbook(orderbook: unknown, tokenId?: string): orderbook is Orderbook {
    if (!orderbook || typeof orderbook !== 'object') {
      this.logError('Invalid orderbook: not an object', { tokenId });
      return false;
    }

    const ob = orderbook as Partial<Orderbook>;
    if (!ob.bids || !Array.isArray(ob.bids)) {
      this.logError('Invalid orderbook: missing or invalid bids', { tokenId });
      return false;
    }

    if (!ob.asks || !Array.isArray(ob.asks)) {
      this.logError('Invalid orderbook: missing or invalid asks', { tokenId });
      return false;
    }

    const bestBid = ob.best_bid;
    const bestAsk = ob.best_ask;
    if ((bestBid !== undefined && typeof bestBid !== 'number') ||
        (bestAsk !== undefined && typeof bestAsk !== 'number')) {
      this.logError('Invalid orderbook: invalid best_bid or best_ask', { tokenId, bestBid, bestAsk });
      return false;
    }

    return true;
  }

  /**
   * 验证 Position 对象的基本完整性
   */
  private validatePosition(position: unknown, tokenId?: string): position is Position {
    if (!position || typeof position !== 'object') {
      this.logError('Invalid position: not an object', { tokenId });
      return false;
    }

    const p = position as Partial<Position>;
    if (typeof p.yes_amount !== 'number' || p.yes_amount < 0) {
      this.logError('Invalid position: invalid yes_amount', { tokenId, yes_amount: p.yes_amount });
      return false;
    }

    if (typeof p.no_amount !== 'number' || p.no_amount < 0) {
      this.logError('Invalid position: invalid no_amount', { tokenId, no_amount: p.no_amount });
      return false;
    }

    return true;
  }

  /**
   * 安全的 API 调用包装器（带验证）
   */
  private async safeGetMarket(tokenId: string): Promise<Market | null> {
    try {
      const market = await this.api.getMarket(tokenId);
      if (!this.validateMarket(market)) {
        return null;
      }
      return market;
    } catch (error) {
      this.logError(`Failed to get market for ${tokenId}`, { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }

  /**
   * 安全的订单簿获取（带验证）
   */
  private async safeGetOrderbook(tokenId: string): Promise<Orderbook | null> {
    try {
      const orderbook = await this.api.getOrderbook(tokenId);
      if (!this.validateOrderbook(orderbook, tokenId)) {
        return null;
      }
      return orderbook;
    } catch (error) {
      this.logError(`Failed to get orderbook for ${tokenId}`, { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }
}
