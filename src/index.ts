/**
 * Predict.fun Market Maker Bot
 * Main entry point
 */

import { Wallet } from 'ethers';
import { loadConfig, printConfig } from './config.js';
import { PredictAPI } from './api/client.js';
import { MarketSelector } from './market-selector.js';
import { MarketMaker } from './market-maker.js';
import { applyLiquidityRules } from './markets-config.js';
import { PredictWebSocketFeed } from './external/predict-ws.js';
import type { Market, Orderbook } from './types.js';

class PredictMarketMakerBot {
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
  private warnedMissingJwt = false;

  private getAccountAddressForQueries(): string {
    return this.config.predictAccountAddress || this.wallet.address;
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
      1000, // minLiquidity
      5000, // minVolume24h
      0.10, // maxSpread
      5 // minOrders
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

    // Fetch orderbooks for all markets
    const orderbooks = new Map<string, Orderbook>();
    for (const market of marketsWithRules.slice(0, 50)) {
      // Limit to first 50 for performance
      try {
        const orderbook = await this.api.getOrderbook(market.token_id);
        orderbooks.set(market.token_id, orderbook);

        // Add orderbook data to market
        market.best_bid = orderbook.best_bid;
        market.best_ask = orderbook.best_ask;
        market.spread_pct = orderbook.spread_pct;
        market.total_orders =
          (orderbook.bids?.length || 0) + (orderbook.asks?.length || 0);
      } catch (error) {
        console.error(`Error fetching orderbook for ${market.token_id}:`, error);
      }
    }

    // Score and select markets
    let scoredMarkets = this.marketSelector.selectMarkets(marketsWithRules, orderbooks);

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

  private async getOrderbookForMarket(market: Market): Promise<Orderbook | null> {
    if (this.wsFeed && this.config.mmWsEnabled) {
      const maxAge = this.resolveMmWsMaxAgeMs();
      const cached = this.wsFeed.getOrderbook(market.token_id, maxAge);
      if (cached) {
        return cached;
      }
      if (this.config.mmWsFallbackRest !== false) {
        const minInterval = Math.max(0, Number(this.config.mmWsFallbackMinIntervalMs || 0));
        const last = this.wsFallbackAt.get(market.token_id) || 0;
        if (minInterval > 0 && Date.now() - last < minInterval) {
          return null;
        }
        this.wsFallbackAt.set(market.token_id, Date.now());
        return await this.api.getOrderbook(market.token_id);
      }
      return null;
    }
    return await this.api.getOrderbook(market.token_id);
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
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

let activeBot: PredictMarketMakerBot | null = null;

// Main execution
async function main() {
  const bot = new PredictMarketMakerBot();
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
