import type { Market, Orderbook, Order, Position } from '../types.js';

export interface MakerApi {
  getMarkets(): Promise<Market[]>;
  getMarket(tokenId: string): Promise<Market>;
  getOrderbook(tokenId: string): Promise<Orderbook>;
  createOrder(payload: any): Promise<any>;
  removeOrders(orderIds: string[]): Promise<void>;
  getOrders?(makerAddress: string): Promise<Order[]>;
  getPositions?(makerAddress: string): Promise<any[]>;
  testConnection?(): Promise<boolean>;
}

export interface MakerOrderManager {
  getSignerAddress(): string;
  getMakerAddress(): string;
  buildLimitOrderPayload(params: {
    market: Market;
    side: 'BUY' | 'SELL';
    price: number;
    shares: number;
  }): Promise<any>;
  buildMarketOrderPayload(params: {
    market: Market;
    side: 'BUY' | 'SELL';
    shares: number;
    orderbook: Orderbook;
    slippageBps?: string;
  }): Promise<any>;
}
