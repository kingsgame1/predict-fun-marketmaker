/**
 * Probable order manager
 * Builds orders for Probable CLOB via @prob/clob
 */

import type { Market, Orderbook } from './types.js';
import type { MakerOrderManager } from './mm/venue.js';
import { createClobClient, OrderSide, LimitTimeInForce } from '@prob/clob';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc, bscTestnet } from 'viem/chains';
import { ensureProbableApiBase } from './external/probable-utils.js';

interface ProbableOrderManagerConfig {
  orderbookApiUrl: string;
  wsUrl: string;
  chainId: number;
  privateKey: string;
  rpcUrl?: string;
}

export class ProbableOrderManager implements MakerOrderManager {
  private client: any;
  private maker: string;

  constructor(config: ProbableOrderManagerConfig) {
    const normalized = config.privateKey.startsWith('0x') ? config.privateKey : `0x${config.privateKey}`;
    const account = privateKeyToAccount(normalized as `0x${string}`);
    const chain = config.chainId === bscTestnet.id ? bscTestnet : bsc;
    const transport = config.rpcUrl ? http(config.rpcUrl) : http();
    const wallet = createWalletClient({ account, chain, transport });
    this.client = createClobClient({
      baseUrl: ensureProbableApiBase(config.orderbookApiUrl),
      wsUrl: config.wsUrl,
      chainId: config.chainId,
      wallet,
    } as any);
    this.maker = account.address;
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
    const side = params.side === 'BUY' ? OrderSide.Buy : OrderSide.Sell;
    if (typeof (this.client as any).createLimitOrder === 'function') {
      return (this.client as any).createLimitOrder({
        tokenId: params.market.token_id,
        price: params.price,
        size: params.shares,
        side,
        timeInForce: (LimitTimeInForce as any).GTC ?? 'GTC',
      });
    }
    return (this.client as any).createOrder({
      tokenId: params.market.token_id,
      price: params.price,
      size: params.shares,
      side,
    });
  }

  async buildMarketOrderPayload(params: {
    market: Market;
    side: 'BUY' | 'SELL';
    shares: number;
    orderbook: Orderbook;
    slippageBps?: string;
  }): Promise<any> {
    const side = params.side === 'BUY' ? OrderSide.Buy : OrderSide.Sell;
    if (typeof (this.client as any).createMarketOrder === 'function') {
      return (this.client as any).createMarketOrder({
        tokenId: params.market.token_id,
        size: params.shares,
        side,
      });
    }
    const slippage = Number(params.slippageBps || 0) / 10000;
    const ref =
      params.side === 'BUY'
        ? Number(params.orderbook.best_ask ?? params.orderbook.mid_price ?? 0)
        : Number(params.orderbook.best_bid ?? params.orderbook.mid_price ?? 0);
    const price =
      params.side === 'BUY'
        ? Math.min(1, ref * (1 + slippage))
        : Math.max(0.0001, ref * (1 - slippage));
    return this.buildLimitOrderPayload({
      market: params.market,
      side: params.side,
      price,
      shares: params.shares,
    });
  }
}
