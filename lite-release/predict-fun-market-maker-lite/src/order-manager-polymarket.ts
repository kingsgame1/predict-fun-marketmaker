import { Wallet } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import type { MakerOrderManager } from './mm/venue.js';
import type { Market, Orderbook } from './types.js';

interface PolymarketOrderManagerConfig {
  clobUrl: string;
  chainId: number;
  privateKey: string;
  orderType?: string;
}

export class PolymarketOrderManager implements MakerOrderManager {
  private client: ClobClient;
  private maker: string;
  private defaultOrderType: string;

  constructor(config: PolymarketOrderManagerConfig) {
    const normalized = config.privateKey.startsWith('0x') ? config.privateKey : '0x' + config.privateKey;
    const signer = new Wallet(normalized);
    this.client = new ClobClient(config.clobUrl.replace(/\/+$/g, ''), config.chainId, signer);
    this.maker = signer.address;
    this.defaultOrderType = (config.orderType || 'GTC').toUpperCase();
  }

  getSignerAddress(): string {
    return this.maker;
  }

  getMakerAddress(): string {
    return this.maker;
  }

  async buildLimitOrderPayload(params: {
    market: Market;
    side: 'BUY' | 'SELL';
    price: number;
    shares: number;
  }): Promise<any> {
    const order = await this.client.createOrder({
      tokenId: params.market.token_id,
      price: params.price,
      side: params.side,
      size: params.shares,
    });
    return {
      order,
      orderType: this.defaultOrderType,
    };
  }

  async buildMarketOrderPayload(params: {
    market: Market;
    side: 'BUY' | 'SELL';
    shares: number;
    orderbook: Orderbook;
    slippageBps?: string;
  }): Promise<any> {
    const slippage = Number(params.slippageBps || 0) / 10000;
    const reference = params.side === 'BUY'
      ? Number(params.orderbook.best_ask ?? params.orderbook.mid_price ?? 0)
      : Number(params.orderbook.best_bid ?? params.orderbook.mid_price ?? 0);
    const price = params.side === 'BUY'
      ? Math.min(0.9999, Math.max(0.0001, reference * (1 + slippage)))
      : Math.max(0.0001, Math.min(0.9999, reference * (1 - slippage)));
    return this.buildLimitOrderPayload({
      market: params.market,
      side: params.side,
      price,
      shares: params.shares,
    });
  }
}
