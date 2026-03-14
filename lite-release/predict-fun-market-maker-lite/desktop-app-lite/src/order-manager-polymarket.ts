import { Wallet } from 'ethers';
import { ClobClient } from '@polymarket/clob-client';
import type { MakerOrderManager } from './mm/venue.js';
import type { Market, Orderbook } from './types.js';

interface PolymarketOrderManagerConfig {
  clobUrl: string;
  chainId: number;
  privateKey: string;
  orderType?: string;
  funderAddress?: string;
  signatureType?: number;
}

const DEFAULT_TICK_SIZE = 0.01;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeTickSize(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_TICK_SIZE;
  }
  return numeric > 1 ? numeric / 100 : numeric;
}

function formatTickSize(value: number): string {
  return value.toFixed(6).replace(/0+$/g, '').replace(/\.$/g, '');
}

function alignPriceToTick(price: number, tickSize: number, side: 'BUY' | 'SELL'): number {
  const safeTick = normalizeTickSize(tickSize);
  const minPrice = safeTick;
  const maxPrice = 1 - safeTick;
  const safePrice = clamp(price, minPrice, maxPrice);
  const scaled = safePrice / safeTick;
  const steps = side === 'BUY' ? Math.floor(scaled + 1e-9) : Math.ceil(scaled - 1e-9);
  return clamp(Number((steps * safeTick).toFixed(6)), minPrice, maxPrice);
}

export class PolymarketOrderManager implements MakerOrderManager {
  private client: ClobClient;
  private maker: string;
  private signerAddress: string;
  private defaultOrderType: string;

  constructor(config: PolymarketOrderManagerConfig) {
    const normalized = config.privateKey.startsWith('0x') ? config.privateKey : '0x' + config.privateKey;
    const signer = new Wallet(normalized);
    const funderAddress = String(config.funderAddress || '').trim() || signer.address;
    const signatureType = Number.isFinite(Number(config.signatureType)) ? Number(config.signatureType) : 0;

    this.client = new ClobClient(
      config.clobUrl.replace(/\/+$/g, ''),
      config.chainId,
      signer,
      undefined,
      signatureType as any,
      funderAddress,
    );
    this.signerAddress = signer.address;
    this.maker = funderAddress;
    this.defaultOrderType = (config.orderType || 'GTC').toUpperCase();
  }

  getSignerAddress(): string {
    return this.signerAddress;
  }

  getMakerAddress(): string {
    return this.maker;
  }

  private resolveTickSize(market: Market): number {
    return normalizeTickSize(market.polymarket_tick_size);
  }

  private resolveNegRisk(market: Market): boolean {
    return Boolean(market.is_neg_risk);
  }

  private resolvePostOnly(orderType: string): boolean {
    return orderType === 'GTC' || orderType === 'GTD';
  }

  async buildLimitOrderPayload(params: {
    market: Market;
    side: 'BUY' | 'SELL';
    price: number;
    shares: number;
  }): Promise<any> {
    const tickSize = this.resolveTickSize(params.market);
    const alignedPrice = alignPriceToTick(params.price, tickSize, params.side);
    const orderType = this.defaultOrderType;
    const order = await this.client.createOrder(
      {
        tokenID: params.market.token_id,
        price: alignedPrice,
        side: params.side,
        size: params.shares,
      },
      {
        tickSize: formatTickSize(tickSize),
        negRisk: this.resolveNegRisk(params.market),
      },
    );
    return {
      order,
      orderType,
      postOnly: this.resolvePostOnly(orderType),
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
    const tickSize = this.resolveTickSize(params.market);
    const adjusted = params.side === 'BUY'
      ? reference * (1 + slippage)
      : reference * (1 - slippage);
    const price = alignPriceToTick(adjusted, tickSize, params.side);
    const order = await this.client.createOrder(
      {
        tokenID: params.market.token_id,
        price,
        side: params.side,
        size: params.shares,
      },
      {
        tickSize: formatTickSize(tickSize),
        negRisk: this.resolveNegRisk(params.market),
      },
    );
    return {
      order,
      orderType: 'FOK',
      postOnly: false,
    };
  }
}
