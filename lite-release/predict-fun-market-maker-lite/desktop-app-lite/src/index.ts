/**
 * Predict.fun Market Maker Bot
 * Main entry point
 */

import { Wallet } from 'ethers';
import { loadConfig, printConfig } from './config.js';
import { PredictAPI } from './api/client.js';
import { PolymarketAPI } from './api/polymarket-client.js';
import { MarketSelector } from './market-selector.js';
import { MarketMaker } from './market-maker.js';
import { applyLiquidityRules } from './markets-config.js';
import { PredictWebSocketFeed } from './external/predict-ws.js';
import { PolymarketWebSocketFeed } from './external/polymarket-ws.js';
import { PolymarketOrderManager } from './order-manager-polymarket.js';
import type { Market, Orderbook } from './types.js';

function sortMarketsByLiquidityAndVolume(markets: Market[]): Market[] {
  const scoreMarket = (market: Market): number => {
    const liquidity = Math.log10(Number(market.liquidity_24h || 0) + 1) * 4;
    const volume = Math.log10(Number(market.volume_24h || 0) + 1) * 2.5;
    const rewardDaily = Number(market.polymarket_reward_daily_rate || 0);
    const rewardMaxSpread = Number(market.polymarket_reward_max_spread || 0);
    const rewardScore = market.polymarket_rewards_enabled
      ? 6 + Math.log10(rewardDaily + 1) * 5 + Math.min(3, rewardMaxSpread * 60)
      : 0;
    return liquidity + volume + rewardScore;
  };

  return [...markets].sort((a, b) => scoreMarket(b) - scoreMarket(a));
}

async function populateOrderbooksWithConcurrency(
  markets: Market[],
  concurrency: number,
  fetcher: (tokenId: string) => Promise<Orderbook>
): Promise<Map<string, Orderbook>> {
  const orderbooks = new Map<string, Orderbook>();
  const batchSize = Math.max(1, concurrency);

  for (let i = 0; i < markets.length; i += batchSize) {
    const batch = markets.slice(i, i + batchSize);
    const settled = await Promise.allSettled(
      batch.map(async (market) => {
        const orderbook = await fetcher(market.token_id);
        orderbooks.set(market.token_id, orderbook);
        market.best_bid = orderbook.best_bid;
        market.best_ask = orderbook.best_ask;
        market.spread_pct = orderbook.spread_pct;
        market.total_orders = (orderbook.bids?.length || 0) + (orderbook.asks?.length || 0);
      })
    );

    settled.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error(`Error fetching orderbook for ${batch[index]?.token_id}:`, result.reason);
      }
    });
  }

  return orderbooks;
}

export class PredictMarketMakerBot {
  private static readonly PREDICT_SAFE_MAX_SPREAD = 0.06;
  private static readonly PREDICT_SAFE_MIN_L1_NOTIONAL = 25;
  private static readonly PREDICT_SAFE_MIN_L2_NOTIONAL = 10;
  private static readonly PREDICT_SAFE_MIN_PRICE = 0.08;
  private static readonly PREDICT_SAFE_MAX_PRICE = 0.92;
  private static readonly PREDICT_SAFE_MAX_LEVEL_GAP = 0.02;
  private static readonly PREDICT_SAFE_MIN_L2_TO_L1_RATIO = 0.25;
  private api: PredictAPI;
  private marketSelector: MarketSelector;
  private marketMaker: MarketMaker;
  private config: any;
  private wallet: Wallet;
  private running = false;
  private selectedMarkets: Market[] = [];
  private marketByToken: Map<string, Market> = new Map();
  private wsFeed?: PredictWebSocketFeed;
  private wsDirtyTokens: Set<string> = new Set();
  private wsDirtyUnsub?: () => void;
  private wsFallbackAt: Map<string, number> = new Map();
  private wsBadCount: Map<string, number> = new Map();
  private wsGapUntil: Map<string, number> = new Map();
  private wsHealthScore = 100;
  private wsHealthTarget = 100;
  private wsHealthUpdatedAt = 0;
  private warnedMissingJwt = false;

  private getAccountAddressForQueries(): string {
    return this.config.predictAccountAddress || this.wallet.address;
  }

  private getPredictSafetyConfig() {
    return {
      maxSpread: this.config.predictSafeMaxSpread ?? PredictMarketMakerBot.PREDICT_SAFE_MAX_SPREAD,
      minL1Notional: this.config.predictSafeMinL1Notional ?? PredictMarketMakerBot.PREDICT_SAFE_MIN_L1_NOTIONAL,
      minL2Notional: this.config.predictSafeMinL2Notional ?? PredictMarketMakerBot.PREDICT_SAFE_MIN_L2_NOTIONAL,
      minPrice: this.config.predictSafeMinPrice ?? PredictMarketMakerBot.PREDICT_SAFE_MIN_PRICE,
      maxPrice: this.config.predictSafeMaxPrice ?? PredictMarketMakerBot.PREDICT_SAFE_MAX_PRICE,
      maxLevelGap: this.config.predictSafeMaxLevelGap ?? PredictMarketMakerBot.PREDICT_SAFE_MAX_LEVEL_GAP,
      minL2ToL1Ratio:
        this.config.predictSafeMinL2ToL1Ratio ?? PredictMarketMakerBot.PREDICT_SAFE_MIN_L2_TO_L1_RATIO,
    };
  }

  constructor() {
    // Load configuration
    this.config = loadConfig();
    printConfig(this.config);

    // Initialize wallet
    this.wallet = new Wallet(this.config.privateKey);
    console.log(`🔐 Wallet: ${this.wallet.address}\n`);
    if (this.config.predictAccountAddress) {
      console.log(`🏦 Predict Account (query target): ${this.config.predictAccountAddress}\n`);
    }

    // Initialize API client
    this.api = new PredictAPI(this.config.apiBaseUrl, this.config.apiKey, this.config.jwtToken);

    // Initialize market selector
    this.marketSelector = new MarketSelector(
      0, // minLiquidity
      0, // minVolume24h
      this.getPredictSafetyConfig().maxSpread, // maxSpread
      0 // minOrders
    );

    // Initialize market maker
    this.marketMaker = new MarketMaker(this.api, this.config);
  }

  /**
   * Initialize the bot
   */
  async initialize(): Promise<void> {
    console.log('🚀 Initializing Predict.fun Market Maker Bot...\n');

    // Test API connection
    const connected = await this.api.testConnection();
    if (!connected) {
      throw new Error('Failed to connect to Predict.fun API');
    }

    // Select markets to trade
    await this.selectMarkets();

    await this.marketMaker.initialize();
    this.setupMarketWs();

    // Update initial state (private endpoint requires JWT)
    if (this.config.jwtToken) {
      await this.marketMaker.updateState(this.getAccountAddressForQueries());
    } else if (!this.warnedMissingJwt) {
      console.log('⚠️  JWT_TOKEN missing, skip orders/positions sync (run: npm run auth:jwt)');
      this.warnedMissingJwt = true;
    }

    console.log('✅ Initialization complete\n');
  }

  /**
   * Select markets to trade
   */
  async selectMarkets(): Promise<void> {
    console.log('🔍 Scanning markets...\n');

    const allMarkets = await this.api.getMarkets();
    console.log(`Found ${allMarkets.length} active markets\n`);

    // Apply manual liquidity activation rules from config
    const marketsWithRules = applyLiquidityRules(allMarkets);
    const rulesApplied = marketsWithRules.filter((m) => m.liquidity_activation?.active).length;
    if (rulesApplied > 0) {
      console.log(`✅ Applied liquidity rules to ${rulesApplied} market(s)\n`);
    }

    const prioritizedMarkets = new Map<string, Market>();
    if (this.config.marketTokenIds && this.config.marketTokenIds.length > 0) {
      for (const tokenId of this.config.marketTokenIds) {
        const matched = marketsWithRules.find((m) => String(m.token_id) === String(tokenId));
        if (matched) {
          prioritizedMarkets.set(matched.token_id, matched);
        }
      }
    }
    for (const market of sortMarketsByLiquidityAndVolume(marketsWithRules)) {
      prioritizedMarkets.set(market.token_id, market);
    }

    const orderbookCandidates = Array.from(prioritizedMarkets.values()).slice(
      0,
      Math.max(36, (this.config.marketTokenIds?.length || 0) * 12)
    );
    const orderbooks = await populateOrderbooksWithConcurrency(
      orderbookCandidates,
      3,
      async (tokenId) => this.api.getOrderbook(tokenId)
    );
    console.log(`📘 Predict orderbooks fetched: ${orderbooks.size}/${orderbookCandidates.length}`);

    // Score and select markets
    let scoredMarkets = this.marketSelector.selectMarkets(marketsWithRules, orderbooks);
    if (scoredMarkets.length === 0 && orderbooks.size > 0) {
      const relaxedSelector = new MarketSelector(0, 0, this.getPredictSafetyConfig().maxSpread, 0);
      const relaxed = relaxedSelector.selectMarkets(marketsWithRules, orderbooks);
      if (relaxed.length > 0) {
        console.log(`ℹ️  Strict selector returned 0, fallback to relaxed selector (${relaxed.length})`);
        scoredMarkets = relaxed;
      }
    }
    if (scoredMarkets.length === 0 && orderbooks.size > 0) {
      scoredMarkets = marketsWithRules
        .filter((market) => orderbooks.has(market.token_id))
        .map((market) => {
          const orderbook = orderbooks.get(market.token_id)!;
          const l1Bid = Number(orderbook.best_bid || 0);
          const l1Ask = Number(orderbook.best_ask || 0);
          const spreadPenalty =
            l1Bid > 0 && l1Ask > 0 && Number.isFinite(orderbook.spread_pct) ? Math.max(0, orderbook.spread_pct) : 1;
          return {
            market,
            score:
              Number(market.liquidity_24h || 0) * 0.2 +
              Number(market.volume_24h || 0) * 0.05 +
              (l1Bid + l1Ask) * 100 -
              spreadPenalty * 50,
            reasons: ['Predict fallback: official orderbook available'],
          };
        })
        .sort((a, b) => b.score - a.score);
      if (scoredMarkets.length > 0) {
        console.log(`ℹ️  Fallback ranking enabled with ${scoredMarkets.length} markets`);
      }
    }

    // Filter by user-specified markets if provided
    if (this.config.marketTokenIds && this.config.marketTokenIds.length > 0) {
      scoredMarkets = scoredMarkets.filter((s) =>
        this.config.marketTokenIds.includes(s.market.token_id)
      );
    }

    // Print analysis
    this.marketSelector.printAnalysis(scoredMarkets);

    // Select top markets
    this.selectedMarkets = this.marketSelector.getTopMarkets(scoredMarkets, 10);
    this.marketByToken.clear();
    for (const market of this.selectedMarkets) {
      this.marketByToken.set(market.token_id, market);
    }

    console.log(`\n✅ Selected ${this.selectedMarkets.length} markets for market making\n`);
  }

  private setupMarketWs(): void {
    if (!this.config.mmWsEnabled) {
      return;
    }
    const wsUrl = this.config.predictWsUrl || 'wss://ws.predict.fun/ws';
    this.wsFeed = new PredictWebSocketFeed({
      url: wsUrl,
      apiKey: this.config.predictWsApiKey || this.config.apiKey,
      topicKey: this.config.predictWsTopicKey || 'token_id',
      staleTimeoutMs: this.config.predictWsStaleMs || 0,
      resetOnReconnect: this.config.predictWsResetOnReconnect !== false,
    });
    this.wsFeed.subscribeMarkets(this.selectedMarkets);
    this.wsDirtyUnsub = this.wsFeed.onOrderbook((tokenId) => {
      if (this.marketByToken.has(tokenId)) {
        this.wsDirtyTokens.add(tokenId);
      }
    });
    this.wsFeed.start();
    console.log(`📡 Market Maker WS enabled (${wsUrl})`);
  }

  private resolveMmWsMaxAgeMs(): number {
    const explicit = Number(this.config.mmWsMaxAgeMs || 0);
    if (explicit > 0) {
      return explicit;
    }
    const fallback = Number(this.config.predictWsStaleMs || 0);
    if (fallback > 0) {
      return fallback;
    }
    return 5000;
  }

  private updateWsHealth(): void {
    if (!this.config.mmWsEnabled || !this.wsFeed) {
      this.wsHealthScore = 100;
      this.wsHealthTarget = 100;
      this.wsHealthUpdatedAt = Date.now();
      this.marketMaker.setWsHealthScore(100);
      return;
    }
    const status = this.wsFeed.getStatus();
    const maxAge = this.resolveMmWsMaxAgeMs();
    if (!status.connected || !status.lastMessageAt) {
      this.wsHealthTarget = 0;
    } else {
      const age = Math.max(0, Date.now() - status.lastMessageAt);
      if (maxAge <= 0) {
        this.wsHealthTarget = 100;
      } else {
        const ratio = Math.min(1, age / maxAge);
        this.wsHealthTarget = Math.max(0, Math.round(100 * (1 - ratio)));
      }
    }
    const now = Date.now();
    if (!this.wsHealthUpdatedAt) {
      this.wsHealthScore = this.wsHealthTarget;
    } else if (this.wsHealthTarget < this.wsHealthScore) {
      this.wsHealthScore = this.wsHealthTarget;
    } else if (this.wsHealthTarget > this.wsHealthScore) {
      const recoverMs = Math.max(0, Number(this.config.mmWsHealthRecoverMs || 0));
      if (recoverMs <= 0) {
        this.wsHealthScore = this.wsHealthTarget;
      } else {
        const elapsed = Math.max(1, now - this.wsHealthUpdatedAt);
        const step = Math.min(1, elapsed / recoverMs);
        this.wsHealthScore = this.wsHealthScore + (this.wsHealthTarget - this.wsHealthScore) * step;
      }
    }
    this.wsHealthUpdatedAt = now;
    this.marketMaker.setWsHealthScore(Math.round(this.wsHealthScore));
  }

  private isOrderbookValid(orderbook: Orderbook | null | undefined): boolean {
    if (!orderbook) {
      return false;
    }
    const bestBid = orderbook.best_bid ?? 0;
    const bestAsk = orderbook.best_ask ?? 0;
    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) {
      return false;
    }
    if (bestBid <= 0 || bestAsk <= 0 || bestBid >= bestAsk) {
      return false;
    }
    const maxSpread =
      this.config.mmVenue === 'predict' ? this.getPredictSafetyConfig().maxSpread : 0.2;
    if (bestAsk - bestBid > maxSpread) {
      return false;
    }
    if (this.config.mmVenue === 'predict') {
      const safety = this.getPredictSafetyConfig();
      const mid = Number(orderbook.mid_price ?? (bestBid + bestAsk) / 2);
      if (
        !Number.isFinite(mid) ||
        mid < safety.minPrice ||
        mid > safety.maxPrice
      ) {
        return false;
      }
      const bid1 = this.getLevelNotional(orderbook.bids, 0, 'bids');
      const ask1 = this.getLevelNotional(orderbook.asks, 0, 'asks');
      const bid2 = this.getLevelNotional(orderbook.bids, 1, 'bids');
      const ask2 = this.getLevelNotional(orderbook.asks, 1, 'asks');
      if (
        Math.min(bid1, ask1) < safety.minL1Notional ||
        Math.min(bid2, ask2) < safety.minL2Notional
      ) {
        return false;
      }
      if (
        this.getSupportRatio(orderbook.bids, 'bids') < safety.minL2ToL1Ratio ||
        this.getSupportRatio(orderbook.asks, 'asks') < safety.minL2ToL1Ratio
      ) {
        return false;
      }
      const bidGap = this.getLevelGap(orderbook.bids, 'bids');
      const askGap = this.getLevelGap(orderbook.asks, 'asks');
      if (
        bidGap > safety.maxLevelGap ||
        askGap > safety.maxLevelGap
      ) {
        return false;
      }
    }
    return true;
  }

  private getLevelNotional(levels: any[] | undefined, index: number, side: 'bids' | 'asks'): number {
    if (!Array.isArray(levels) || levels.length <= index) {
      return 0;
    }
    const sorted = [...levels].sort((a, b) => {
      const ap = Number(a?.price || 0);
      const bp = Number(b?.price || 0);
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

  private getLevelGap(levels: any[] | undefined, side: 'bids' | 'asks'): number {
    if (!Array.isArray(levels) || levels.length < 2) {
      return Number.POSITIVE_INFINITY;
    }
    const sorted = [...levels].sort((a, b) => {
      const ap = Number(a?.price || 0);
      const bp = Number(b?.price || 0);
      return side === 'bids' ? bp - ap : ap - bp;
    });
    const first = Number(sorted[0]?.price || 0);
    const second = Number(sorted[1]?.price || 0);
    if (!Number.isFinite(first) || !Number.isFinite(second) || first <= 0 || second <= 0) {
      return Number.POSITIVE_INFINITY;
    }
    return side === 'bids' ? first - second : second - first;
  }

  private getSupportRatio(levels: any[] | undefined, side: 'bids' | 'asks'): number {
    if (!Array.isArray(levels) || levels.length < 2) {
      return 0;
    }
    const sorted = [...levels].sort((a, b) => {
      const ap = Number(a?.price || 0);
      const bp = Number(b?.price || 0);
      return side === 'bids' ? bp - ap : ap - bp;
    });
    const first = Number(sorted[0]?.shares || 0);
    const second = Number(sorted[1]?.shares || 0);
    if (!Number.isFinite(first) || !Number.isFinite(second) || first <= 0 || second <= 0) {
      return 0;
    }
    return second / first;
  }

  private async getOrderbookForMarket(market: Market): Promise<Orderbook | null> {
    if (this.wsFeed && this.config.mmWsEnabled) {
      const gapUntil = this.wsGapUntil.get(market.token_id) || 0;
      if (gapUntil && Date.now() < gapUntil) {
        if (this.config.mmWsFallbackRest !== false) {
          return await this.api.getOrderbook(market.token_id);
        }
        return null;
      }
      const maxAge = this.resolveMmWsMaxAgeMs();
      const cached = this.wsFeed.getOrderbook(market.token_id, maxAge);
      if (cached && this.isOrderbookValid(cached)) {
        this.wsBadCount.delete(market.token_id);
        return cached;
      }
      if (cached) {
        const bad = (this.wsBadCount.get(market.token_id) || 0) + 1;
        this.wsBadCount.set(market.token_id, bad);
        const maxBad = Math.max(0, Number(this.config.mmWsGapMax || 0));
        if (maxBad > 0 && bad >= maxBad) {
          const cooldown = Math.max(0, Number(this.config.mmWsGapCooldownMs || 0));
          if (cooldown > 0) {
            this.wsGapUntil.set(market.token_id, Date.now() + cooldown);
          }
          this.wsBadCount.delete(market.token_id);
          if (this.config.mmWsGapReconnect && this.wsFeed) {
            this.wsFeed.stop();
            this.wsFeed.start();
          }
        }
      }
      if (this.config.mmWsFallbackRest !== false) {
        const minInterval = Math.max(0, Number(this.config.mmWsFallbackMinIntervalMs || 0));
        const last = this.wsFallbackAt.get(market.token_id) || 0;
        if (minInterval > 0 && Date.now() - last < minInterval) {
          return null;
        }
        this.wsFallbackAt.set(market.token_id, Date.now());
        const restBook = await this.api.getOrderbook(market.token_id);
        return this.isOrderbookValid(restBook) ? restBook : null;
      }
      return null;
    }
    const restBook = await this.api.getOrderbook(market.token_id);
    return this.isOrderbookValid(restBook) ? restBook : null;
  }

  private drainDirtyMarkets(): Market[] {
    if (!this.config.mmWsOnlyDirty || !this.config.mmWsEnabled) {
      return this.selectedMarkets;
    }
    if (this.wsDirtyTokens.size === 0) {
      return [];
    }
    const maxBatch = Math.max(0, Number(this.config.mmWsDirtyMaxBatch || 0));
    const tokens = Array.from(this.wsDirtyTokens);
    const batch = maxBatch > 0 ? tokens.slice(0, maxBatch) : tokens;
    for (const token of batch) {
      this.wsDirtyTokens.delete(token);
    }
    return batch
      .map((tokenId) => this.marketByToken.get(tokenId))
      .filter((market): market is Market => Boolean(market));
  }

  private getLoopSleepMs(): number {
    if (!this.config.mmWsOnlyDirty) {
      return this.config.refreshInterval;
    }
    const idle = Math.max(50, Number(this.config.mmWsIdleSleepMs || 0));
    return idle > 0 ? idle : Math.min(200, this.config.refreshInterval);
  }

  /**
   * Main trading loop
   */
  async run(): Promise<void> {
    this.running = true;

    console.log('🎯 Starting market making loop...\n');

    while (this.running) {
      try {
        this.updateWsHealth();
        // 维护 WebSocket 健康状态（自动恢复）
        this.marketMaker.maintainWsHealth();
        // Update state (private endpoint requires JWT)
        if (this.config.jwtToken) {
          await this.marketMaker.updateState(this.getAccountAddressForQueries());
        }

        const marketsToProcess = this.drainDirtyMarkets();
        if (marketsToProcess.length === 0) {
          await this.sleep(this.getLoopSleepMs());
          continue;
        }

        // Process each market
        for (const market of marketsToProcess) {
          try {
            // Fetch latest orderbook (WS preferred when enabled)
            const orderbook = await this.getOrderbookForMarket(market);
            if (!orderbook) {
              continue;
            }

            // Place/cancel orders as needed
            await this.marketMaker.placeMMOrders(market, orderbook);
          } catch (error) {
            console.error(`Error processing market ${market.token_id}:`, error);
          }
        }

        // Print status
        this.marketMaker.printStatus();

        // Wait for next iteration
        await this.sleep(this.getLoopSleepMs());
      } catch (error) {
        console.error('Error in main loop:', error);
        await this.sleep(this.getLoopSleepMs());
      }
    }
  }

  /**
   * Start the bot
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Bot is already running');
    }
    await this.run();
  }

  /**
   * Stop the bot
   */
  stop(): void {
    console.log('\n🛑 Stopping bot...');
    this.running = false;
    if (this.wsDirtyUnsub) {
      this.wsDirtyUnsub();
      this.wsDirtyUnsub = undefined;
    }
    if (this.wsFeed) {
      this.wsFeed.stop();
      this.wsFeed = undefined;
    }
  }

  /**
   * Get selected markets count
   */
  getSelectedMarketsCount(): number {
    return this.selectedMarkets.length;
  }

  /**
   * Check if bot is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Polymarket 做市
export class PolymarketMarketMakerBot {
  private static readonly POLYMARKET_REWARD_MIN_FIT_SCORE = 0.6;
  private static readonly POLYMARKET_REWARD_MIN_DAILY_RATE = 0;
  private static readonly POLYMARKET_REWARD_PAUSE_MS = 3 * 60 * 1000;
  private api: PolymarketAPI;
  private marketSelector: MarketSelector;
  private marketMaker: MarketMaker;
  private config: any;
  private wallet: Wallet;
  private running = false;
  private selectedMarkets: Market[] = [];
  private marketByToken: Map<string, Market> = new Map();
  private wsFeed?: PolymarketWebSocketFeed;
  private wsDirtyTokens: Set<string> = new Set();
  private wsDirtyUnsub?: () => void;
  private wsHealthScore = 100;
  private wsHealthTarget = 100;
  private wsHealthUpdatedAt = 0;
  private warnedStatusSync = false;
  private rewardPauseUntil: Map<string, number> = new Map();

  private getAccountAddressForQueries(): string {
    return this.config.polymarketFunderAddress || this.wallet.address;
  }

  private getPolymarketSafetyConfig() {
    return {
      rewardMinFitScore:
        this.config.polymarketRewardMinFitScore ?? PolymarketMarketMakerBot.POLYMARKET_REWARD_MIN_FIT_SCORE,
      rewardMinDailyRate:
        this.config.polymarketRewardMinDailyRate ?? PolymarketMarketMakerBot.POLYMARKET_REWARD_MIN_DAILY_RATE,
      rewardRequireFit: this.config.polymarketRewardRequireFit !== false,
      rewardRequireEnabled: this.config.polymarketRewardRequireEnabled === true,
      rewardPauseMs: this.config.polymarketRewardPauseMs ?? PolymarketMarketMakerBot.POLYMARKET_REWARD_PAUSE_MS,
    };
  }

  private isRewardPaused(tokenId: string): boolean {
    return (this.rewardPauseUntil.get(tokenId) ?? 0) > Date.now();
  }

  private async pauseRewardMarket(tokenId: string, reason: string): Promise<void> {
    const pauseMs = Math.max(1000, Number(this.getPolymarketSafetyConfig().rewardPauseMs || 0));
    this.rewardPauseUntil.set(tokenId, Date.now() + pauseMs);
    await this.marketMaker.enforceMarketPause(tokenId, pauseMs, reason, 'polymarket-reward-gate', true);
    console.log(`⏸️ Polymarket 奖励门禁暂停 ${tokenId.slice(0, 8)} ${Math.round(pauseMs / 1000)}s: ${reason}`);
  }

  private getPolymarketSelectorOptions() {
    const safety = this.getPolymarketSafetyConfig();
    return {
      polymarketRewardMinFitScore: safety.rewardMinFitScore,
      polymarketRewardMinDailyRate: safety.rewardMinDailyRate,
      polymarketRewardRequireFit: safety.rewardRequireFit,
      polymarketRewardRequireEnabled: safety.rewardRequireEnabled,
    };
  }

  private evaluateRewardGate(market: Market, orderbook: Orderbook): { skip: boolean; reason?: string } {
    const safety = this.getPolymarketSafetyConfig();
    if (market.polymarket_enable_order_book === false) {
      return { skip: true, reason: 'orderbook 未启用' };
    }
    if (market.polymarket_accepting_orders === false) {
      return { skip: true, reason: '市场当前不接受下单' };
    }
    const profile = this.marketSelector.evaluatePolymarketRewardFit(market, orderbook);
    if (safety.rewardRequireEnabled && !profile.enabled) {
      return { skip: true, reason: '无流动性激励' };
    }
    if (profile.enabled && profile.dailyRate < safety.rewardMinDailyRate) {
      return { skip: true, reason: `激励日速率不足 ${profile.dailyRate.toFixed(0)}` };
    }
    if (profile.enabled && safety.rewardRequireFit && profile.fitScore < safety.rewardMinFitScore) {
      return { skip: true, reason: `激励适配度不足 ${(profile.fitScore * 100).toFixed(0)}%` };
    }
    return { skip: false };
  }

  private async runPolymarketPreflight(): Promise<void> {
    const signatureType = Number(this.config.polymarketSignatureType ?? 0);
    const explicitFunder = String(this.config.polymarketFunderAddress || '').trim();
    const signer = this.wallet.address;
    const queryAddress = this.getAccountAddressForQueries();
    const orderType = String(this.config.crossPlatformOrderType || 'GTC').toUpperCase();
    const liveMode = this.config.enableTrading === true;

    if (liveMode && !['GTC', 'GTD'].includes(orderType)) {
      throw new Error(`Polymarket 做市要求 resting order type，当前 CROSS_PLATFORM_ORDER_TYPE=${orderType}`);
    }
    if (liveMode && signatureType !== 0 && !explicitFunder) {
      throw new Error('POLYMARKET_FUNDER_ADDRESS is required when POLYMARKET_SIGNATURE_TYPE is non-zero');
    }
    if (liveMode && signatureType === 0 && explicitFunder && explicitFunder.toLowerCase() !== signer.toLowerCase()) {
      throw new Error('EOA 签名模式下，POLYMARKET_FUNDER_ADDRESS 必须与 signer 地址一致');
    }
    if (signatureType !== 0 && explicitFunder && explicitFunder.toLowerCase() === signer.toLowerCase()) {
      console.log('⚠️  Polymarket 配置中 funder/profile 与 signer 相同，请确认这是预期配置');
    }

    const preflight = await this.api.runTradingPreflight(queryAddress);
    console.log(
      `🔧 Polymarket preflight: signer=${preflight.signerAddress} funder=${preflight.funderAddress} ` +
        `sigType=${preflight.signatureType} creds=${preflight.credsReady ? 'ready' : 'missing'} openOrders=${preflight.openOrderCount}`
    );
    if (liveMode && !preflight.credsReady) {
      throw new Error('Polymarket API credentials are not ready; cannot safely run live market making');
    }
  }

  constructor() {
    this.config = loadConfig();
    printConfig(this.config);

    this.wallet = new Wallet(this.config.polymarketPrivateKey || this.config.privateKey);
    console.log('🔐 Wallet: ' + this.wallet.address + '\n');
    if (this.config.polymarketFunderAddress) {
      console.log('🏦 Polymarket Funder/Profile: ' + this.config.polymarketFunderAddress + '\n');
    }

    this.api = new PolymarketAPI({
      gammaUrl: this.config.polymarketGammaUrl || 'https://gamma-api.polymarket.com',
      clobUrl: this.config.polymarketClobUrl || 'https://clob.polymarket.com',
      privateKey: this.config.polymarketPrivateKey || this.config.privateKey,
      chainId: this.config.polymarketChainId || 137,
      maxMarkets: this.config.polymarketMaxMarkets || 60,
      feeBps: this.config.polymarketFeeBps || 0,
      apiKey: this.config.polymarketApiKey,
      apiSecret: this.config.polymarketApiSecret,
      apiPassphrase: this.config.polymarketApiPassphrase,
      autoDeriveApiKey: this.config.polymarketAutoDeriveApiKey !== false,
      funderAddress: this.config.polymarketFunderAddress || this.wallet.address,
      signatureType: this.config.polymarketSignatureType || 0,
    });

    this.marketSelector = new MarketSelector(0, 0, 0.12, 0, this.getPolymarketSelectorOptions());
    this.marketMaker = new MarketMaker(this.api, this.config, async () => {
      return new PolymarketOrderManager({
        clobUrl: this.config.polymarketClobUrl || 'https://clob.polymarket.com',
        chainId: this.config.polymarketChainId || 137,
        privateKey: this.config.polymarketPrivateKey || this.config.privateKey,
        orderType: this.config.crossPlatformOrderType || 'GTC',
        funderAddress: this.config.polymarketFunderAddress || this.wallet.address,
        signatureType: this.config.polymarketSignatureType || 0,
      });
    });
  }

  async initialize(): Promise<void> {
    console.log('🚀 Initializing Polymarket Market Maker Bot...\n');

    const connected = await this.api.testConnection();
    if (!connected) {
      throw new Error('Failed to connect to Polymarket API');
    }

    await this.runPolymarketPreflight();
    await this.selectMarkets();
    await this.marketMaker.initialize();
    this.setupMarketWs();

    if (!this.warnedStatusSync) {
      console.log('ℹ️  Polymarket 模式使用链上订单，不依赖 Predict JWT，同步基于当前 Profile/Funder 地址');
      this.warnedStatusSync = true;
    }

    console.log('✅ Initialization complete\n');
  }

  async selectMarkets(): Promise<void> {
    console.log('🔍 Scanning markets (Polymarket)...\n');

    const allMarkets = await this.api.getMarkets();
    console.log('Found ' + allMarkets.length + ' active outcome tokens\n');

    const prioritized = new Map<string, Market>();
    if (this.config.marketTokenIds && this.config.marketTokenIds.length > 0) {
      for (const tokenId of this.config.marketTokenIds) {
        const matched = allMarkets.find((market) => String(market.token_id) === String(tokenId));
        if (matched) prioritized.set(matched.token_id, matched);
      }
    }
    for (const market of sortMarketsByLiquidityAndVolume(allMarkets)) {
      prioritized.set(market.token_id, market);
    }

    const candidates = Array.from(prioritized.values()).slice(0, Math.max(48, (this.config.marketTokenIds?.length || 0) * 12));
    const orderbooks = await populateOrderbooksWithConcurrency(candidates, 4, async (tokenId) => this.api.getOrderbook(tokenId));
    console.log('📘 Polymarket orderbooks fetched: ' + orderbooks.size + '/' + candidates.length);

    let scoredMarkets = this.marketSelector.selectMarkets(allMarkets, orderbooks);
    if (scoredMarkets.length === 0 && orderbooks.size > 0) {
      const relaxedSelector = new MarketSelector(0, 0, 0.12, 0, this.getPolymarketSelectorOptions());
      const relaxed = relaxedSelector.selectMarkets(allMarkets, orderbooks);
      if (relaxed.length > 0) {
        console.log('ℹ️  Strict selector returned 0, fallback to relaxed selector (' + relaxed.length + ')');
        scoredMarkets = relaxed;
      }
    }

    if (this.config.marketTokenIds && this.config.marketTokenIds.length > 0) {
      scoredMarkets = scoredMarkets.filter((s) => this.config.marketTokenIds.includes(s.market.token_id));
    }

    this.marketSelector.printAnalysis(scoredMarkets);
    const topCount = Math.max(5, Math.min(20, scoredMarkets.length));
    this.selectedMarkets = this.marketSelector.getTopMarkets(scoredMarkets, topCount);
    this.marketByToken.clear();
    for (const market of this.selectedMarkets) {
      this.marketByToken.set(market.token_id, market);
    }

    console.log('\n✅ Selected ' + this.selectedMarkets.length + ' tokens for market making\n');
  }

  private setupMarketWs(): void {
    if (!this.config.mmWsEnabled || !this.config.polymarketWsEnabled) {
      return;
    }
    this.wsFeed = new PolymarketWebSocketFeed({
      url: this.config.polymarketWsUrl || 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
      customFeatureEnabled: this.config.polymarketWsCustomFeature === true,
      initialDump: this.config.polymarketWsInitialDump !== false,
      staleTimeoutMs: this.config.polymarketWsStaleMs || 0,
      resetOnReconnect: this.config.polymarketWsResetOnReconnect !== false,
      reconnectMinMs: 1000,
      reconnectMaxMs: 15000,
    });
    this.wsFeed.subscribeAssets(this.selectedMarkets.map((market) => market.token_id));
    this.wsDirtyUnsub = this.wsFeed.onOrderbook((tokenId) => {
      if (this.marketByToken.has(tokenId)) {
        this.wsDirtyTokens.add(tokenId);
      }
    });
    this.wsFeed.start();
    console.log('📡 Polymarket WS enabled (' + (this.config.polymarketWsUrl || 'wss://ws-subscriptions-clob.polymarket.com/ws/market') + ')');
  }

  private resolveMmWsMaxAgeMs(): number {
    const explicit = Number(this.config.mmWsMaxAgeMs || 0);
    if (explicit > 0) return explicit;
    const fallback = Number(this.config.polymarketWsStaleMs || 0);
    if (fallback > 0) return fallback;
    return 5000;
  }

  private updateWsHealth(): void {
    if (!this.config.mmWsEnabled || !this.config.polymarketWsEnabled || !this.wsFeed) {
      this.wsHealthScore = 100;
      this.wsHealthTarget = 100;
      this.wsHealthUpdatedAt = Date.now();
      this.marketMaker.setWsHealthScore(100);
      return;
    }
    const status = this.wsFeed.getStatus();
    const maxAge = this.resolveMmWsMaxAgeMs();
    if (!status.connected || !status.lastMessageAt) {
      this.wsHealthTarget = 0;
    } else {
      const age = Math.max(0, Date.now() - status.lastMessageAt);
      if (maxAge <= 0) {
        this.wsHealthTarget = 100;
      } else {
        const ratio = Math.min(1, age / maxAge);
        this.wsHealthTarget = Math.max(0, Math.round(100 * (1 - ratio)));
      }
    }
    const now = Date.now();
    if (!this.wsHealthUpdatedAt) {
      this.wsHealthScore = this.wsHealthTarget;
    } else if (this.wsHealthTarget < this.wsHealthScore) {
      this.wsHealthScore = this.wsHealthTarget;
    } else if (this.wsHealthTarget > this.wsHealthScore) {
      const recoverMs = Math.max(0, Number(this.config.mmWsHealthRecoverMs || 0));
      if (recoverMs <= 0) {
        this.wsHealthScore = this.wsHealthTarget;
      } else {
        const elapsed = Math.max(1, now - this.wsHealthUpdatedAt);
        const step = Math.min(1, elapsed / recoverMs);
        this.wsHealthScore = this.wsHealthScore + (this.wsHealthTarget - this.wsHealthScore) * step;
      }
    }
    this.wsHealthUpdatedAt = now;
    this.marketMaker.setWsHealthScore(Math.max(0, Math.min(100, Math.round(this.wsHealthScore))));
  }

  private async getOrderbookForMarket(market: Market): Promise<Orderbook | null> {
    const tokenId = market.token_id;
    const useWs = this.config.mmWsEnabled && this.config.polymarketWsEnabled && this.wsFeed;
    if (useWs && this.wsFeed) {
      const maxAge = this.resolveMmWsMaxAgeMs();
      const wsBook = this.wsFeed.getOrderbook(tokenId, maxAge);
      if (wsBook?.bestBid && wsBook?.bestAsk) {
        return {
          token_id: tokenId,
          bids: (wsBook.bids || []).map((level) => ({ price: String(level.price), shares: String(level.shares) })),
          asks: (wsBook.asks || []).map((level) => ({ price: String(level.price), shares: String(level.shares) })),
          best_bid: wsBook.bestBid,
          best_ask: wsBook.bestAsk,
          spread: wsBook.bestAsk - wsBook.bestBid,
          spread_pct: ((wsBook.bestAsk - wsBook.bestBid) / ((wsBook.bestAsk + wsBook.bestBid) / 2)) * 100,
          mid_price: (wsBook.bestAsk + wsBook.bestBid) / 2,
        };
      }
    }

    if (this.config.mmWsFallbackRest === false && useWs) {
      return null;
    }

    try {
      return await this.api.getOrderbook(tokenId);
    } catch (error) {
      console.error('Error fetching orderbook for ' + tokenId + ':', error);
      return null;
    }
  }

  private drainDirtyMarkets(): Market[] {
    if (!this.config.mmWsOnlyDirty) {
      return this.selectedMarkets;
    }
    const maxBatch = Math.max(1, Number(this.config.mmWsDirtyMaxBatch || 0)) || this.selectedMarkets.length;
    const dirty = Array.from(this.wsDirtyTokens);
    this.wsDirtyTokens.clear();
    const batch = dirty.slice(0, maxBatch);
    return batch
      .map((tokenId) => this.marketByToken.get(tokenId))
      .filter((market): market is Market => Boolean(market));
  }

  private getLoopSleepMs(): number {
    if (!this.config.mmWsOnlyDirty) {
      return this.config.refreshInterval;
    }
    const idle = Math.max(50, Number(this.config.mmWsIdleSleepMs || 0));
    return idle > 0 ? idle : Math.min(200, this.config.refreshInterval);
  }

  async run(): Promise<void> {
    this.running = true;
    console.log('🎯 Starting Polymarket market making loop...\n');

    while (this.running) {
      try {
        this.updateWsHealth();
        this.marketMaker.maintainWsHealth();

        const marketsToProcess = this.drainDirtyMarkets();
        if (marketsToProcess.length === 0) {
          await this.sleep(this.getLoopSleepMs());
          continue;
        }

        for (const market of marketsToProcess) {
          try {
            if (this.isRewardPaused(market.token_id)) {
              continue;
            }
            const orderbook = await this.getOrderbookForMarket(market);
            if (!orderbook) continue;
            const rewardGate = this.evaluateRewardGate(market, orderbook);
            if (rewardGate.skip) {
              await this.pauseRewardMarket(market.token_id, rewardGate.reason || 'reward gate');
              continue;
            }
            await this.marketMaker.placeMMOrders(market, orderbook);
          } catch (error) {
            console.error('Error processing market ' + market.token_id + ':', error);
          }
        }

        this.marketMaker.printStatus();
        await this.sleep(this.getLoopSleepMs());
      } catch (error) {
        console.error('Error in main loop:', error);
        await this.sleep(this.getLoopSleepMs());
      }
    }
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Bot is already running');
    }
    await this.run();
  }

  stop(): void {
    this.running = false;
    if (this.wsFeed) this.wsFeed.stop();
    if (this.wsDirtyUnsub) this.wsDirtyUnsub();
  }

  getSelectedMarketsCount(): number {
    return this.selectedMarkets.length;
  }

  isRunning(): boolean {
    return this.running;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
// END PolymarketMarketMakerBot




let activeBot: { stop: () => void } | null = null;

// Main execution
async function main() {
  const config = loadConfig();
  const venue = String(config.mmVenue || 'predict').toLowerCase();
  const bot = venue === 'polymarket' ? new PolymarketMarketMakerBot() : new PredictMarketMakerBot();
  activeBot = bot;

  try {
    await bot.initialize();
    await bot.run();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Handle shutdown
process.on('SIGINT', () => {
  console.log('\n\nReceived SIGINT, shutting down gracefully...');
  if (activeBot) {
    activeBot.stop();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n\nReceived SIGTERM, shutting down gracefully...');
  if (activeBot) {
    activeBot.stop();
  }
  process.exit(0);
});

// Run
main().catch(console.error);
