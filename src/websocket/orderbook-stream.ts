/**
 * 📡 WebSocket实时订单簿流
 *
 * 通过WebSocket实时获取订单簿更新
 *
 * @author Predict.fun Team
 * @version 1.0.0
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { OrderBook } from '../types.js';

/**
 * WebSocket连接状态
 */
export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  RECONNECTING = 'reconnecting',
  ERROR = 'error'
}

/**
 * 订单簿更新消息
 */
export interface OrderBookUpdate {
  marketId: string;
  tokenId: string;
  bids: Array<{ price: number; amount: number }>;
  asks: Array<{ price: number; amount: number }>;
  timestamp: number;
  sequence: number;
}

/**
 * WebSocket配置
 */
export interface WebSocketConfig {
  url: string;
  reconnectInterval: number;
  maxReconnectAttempts: number;
  pingInterval: number;
  pingTimeout: number;
  enableCompression: boolean;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: WebSocketConfig = {
  url: 'wss://api.predict.fun/ws',
  reconnectInterval: 5000,
  maxReconnectAttempts: 10,
  pingInterval: 30000,
  pingTimeout: 10000,
  enableCompression: true
};

/**
 * WebSocket订单簿流
 */
export class OrderBookStream extends EventEmitter {
  private config: WebSocketConfig;
  private ws: WebSocket | null = null;
  private state = ConnectionState.DISCONNECTED;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private subscriptions: Set<string> = new Set();
  private orderBooks: Map<string, OrderBook> = new Map();

  constructor(config: Partial<WebSocketConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 连接到WebSocket服务器
   */
  connect(): void {
    if (this.state === ConnectionState.CONNECTING || this.state === ConnectionState.CONNECTED) {
      console.log('⚠️ WebSocket已经连接或正在连接');
      return;
    }

    console.log(`📡 连接到WebSocket: ${this.config.url}`);
    this.setState(ConnectionState.CONNECTING);

    try {
      this.ws = new WebSocket(this.config.url, {
        perMessageDeflate: this.config.enableCompression
      });

      this.setupEventHandlers();

    } catch (error) {
      console.error('❌ WebSocket连接失败:', error.message);
      this.setState(ConnectionState.ERROR);
      this.scheduleReconnect();
    }
  }

  /**
   * 断开连接
   */
  disconnect(): void {
    console.log('📡 断开WebSocket连接');

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.setState(ConnectionState.DISCONNECTED);
    this.reconnectAttempts = 0;
  }

  /**
   * 订阅订单簿
   */
  subscribe(marketId: string, tokenId: string): void {
    const key = `${marketId}:${tokenId}`;

    if (this.subscriptions.has(key)) {
      return;
    }

    this.subscriptions.add(key);

    // 如果已连接，立即发送订阅消息
    if (this.state === ConnectionState.CONNECTED && this.ws) {
      this.sendSubscribe(marketId, tokenId);
    }

    console.log(`📡 订阅订单簿: ${key}`);
  }

  /**
   * 取消订阅
   */
  unsubscribe(marketId: string, tokenId: string): void {
    const key = `${marketId}:${tokenId}`;

    if (!this.subscriptions.has(key)) {
      return;
    }

    this.subscriptions.delete(key);

    // 如果已连接，发送取消订阅消息
    if (this.state === ConnectionState.CONNECTED && this.ws) {
      this.sendUnsubscribe(marketId, tokenId);
    }

    console.log(`📡 取消订阅: ${key}`);
  }

  /**
   * 获取当前订单簿
   */
  getOrderBook(marketId: string, tokenId: string): OrderBook | null {
    const key = `${marketId}:${tokenId}`;
    return this.orderBooks.get(key) || null;
  }

  /**
   * 获取所有订单簿
   */
  getAllOrderBooks(): Map<string, OrderBook> {
    return new Map(this.orderBooks);
  }

  /**
   * 设置事件处理器
   */
  private setupEventHandlers(): void {
    if (!this.ws) return;

    this.ws.on('open', () => this.onOpen());
    this.ws.on('message', (data: WebSocket.Data) => this.onMessage(data));
    this.ws.on('error', (error: Error) => this.onError(error));
    this.ws.on('close', () => this.onClose());
    this.ws.on('ping', (data: Buffer) => this.onPing(data));
    this.ws.on('pong', (data: Buffer) => this.onPong(data));
  }

  /**
   * 连接打开
   */
  private onOpen(): void {
    console.log('✅ WebSocket已连接');
    this.setState(ConnectionState.CONNECTED);
    this.reconnectAttempts = 0;

    // 重新订阅所有市场
    for (const subscription of this.subscriptions) {
      const [marketId, tokenId] = subscription.split(':');
      this.sendSubscribe(marketId, tokenId);
    }

    // 启动心跳
    this.startHeartbeat();

    // 触发连接事件
    this.emit('connected');
  }

  /**
   * 收到消息
   */
  private onMessage(data: WebSocket.Data): void {
    try {
      if (typeof data === 'string') {
        const message = JSON.parse(data);
        this.handleMessage(message);
      } else if (Buffer.isBuffer(data)) {
        const message = JSON.parse(data.toString());
        this.handleMessage(message);
      }
    } catch (error) {
      console.error('❌ 处理WebSocket消息失败:', error.message);
    }
  }

  /**
   * 处理消息
   */
  private handleMessage(message: any): void {
    const type = message.type;

    switch (type) {
      case 'orderbook_update':
        this.handleOrderBookUpdate(message.data);
        break;

      case 'subscription_success':
        console.log(`✅ 订阅成功: ${message.marketId}:${message.tokenId}`);
        break;

      case 'subscription_error':
        console.error(`❌ 订阅失败: ${message.marketId}:${message.tokenId}`);
        break;

      case 'error':
        console.error('❌ WebSocket错误:', message.message);
        break;

      default:
        console.log(`📡 未知消息类型: ${type}`);
    }
  }

  /**
   * 处理订单簿更新
   */
  private handleOrderBookUpdate(update: OrderBookUpdate): void {
    const key = `${update.marketId}:${update.tokenId}`;

    // 更新订单簿
    const orderBook: OrderBook = {
      bids: update.bids.map(b => ({ price: b.price, amount: b.amount })),
      asks: update.asks.map(a => ({ price: a.price, amount: a.amount })),
      timestamp: update.timestamp
    };

    this.orderBooks.set(key, orderBook);

    // 触发更新事件
    this.emit('orderbook', {
      marketId: update.marketId,
      tokenId: update.tokenId,
      orderBook
    });
  }

  /**
   * 连接错误
   */
  private onError(error: Error): void {
    console.error('❌ WebSocket错误:', error.message);
    this.setState(ConnectionState.ERROR);
    this.emit('error', error);
  }

  /**
   * 连接关闭
   */
  private onClose(): void {
    console.log('📡 WebSocket连接已关闭');

    this.stopHeartbeat();
    this.ws = null;

    if (this.state === ConnectionState.CONNECTED) {
      // 意外断开，尝试重连
      this.setState(ConnectionState.DISCONNECTED);
      this.scheduleReconnect();
    }

    this.emit('disconnected');
  }

  /**
   * 收到ping
   */
  private onPing(data: Buffer): void {
    if (this.ws) {
      this.ws.pong(data);
    }
  }

  /**
   * 收到pong
   */
  private onPong(data: Buffer): void {
    // 重置pong超时
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  /**
   * 发送订阅消息
   */
  private sendSubscribe(marketId: string, tokenId: string): void {
    const message = {
      type: 'subscribe',
      marketId,
      tokenId,
      channel: 'orderbook'
    };

    this.send(message);
  }

  /**
   * 发送取消订阅消息
   */
  private sendUnsubscribe(marketId: string, tokenId: string): void {
    const message = {
      type: 'unsubscribe',
      marketId,
      tokenId,
      channel: 'orderbook'
    };

    this.send(message);
  }

  /**
   * 发送消息
   */
  private send(message: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.warn('⚠️ WebSocket未连接，无法发送消息');
    }
  }

  /**
   * 启动心跳
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();

        // 设置pong超时
        this.pongTimer = setTimeout(() => {
          console.warn('⚠️ WebSocket心跳超时，关闭连接');
          this.ws?.close();
        }, this.config.pingTimeout);
      }
    }, this.config.pingInterval);
  }

  /**
   * 停止心跳
   */
  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  /**
   * 安排重连
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error('❌ 达到最大重连次数，停止重连');
      this.emit('maxReconnectReached');
      return;
    }

    this.reconnectAttempts++;

    console.log(`📡 ${this.config.reconnectInterval / 1000}秒后尝试重连 (${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);

    this.setState(ConnectionState.RECONNECTING);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, this.config.reconnectInterval);
  }

  /**
   * 设置状态
   */
  private setState(state: ConnectionState): void {
    const oldState = this.state;
    this.state = state;

    if (oldState !== state) {
      this.emit('stateChange', { oldState, newState: state });
    }
  }

  /**
   * 获取连接状态
   */
  getState(): ConnectionState {
    return this.state;
  }

  /**
   * 是否已连接
   */
  isConnected(): boolean {
    return this.state === ConnectionState.CONNECTED;
  }

  /**
   * 获取订阅数量
   */
  getSubscriptionCount(): number {
    return this.subscriptions.size;
  }
}

/**
 * 全局WebSocket流实例
 */
let globalOrderBookStream: OrderBookStream | null = null;

/**
 * 获取全局订单簿流
 */
export function getOrderBookStream(): OrderBookStream {
  if (!globalOrderBookStream) {
    globalOrderBookStream = new OrderBookStream();
  }
  return globalOrderBookStream;
}

/**
 * 便捷函数：启动WebSocket连接
 */
export function startOrderBookStream(config?: Partial<WebSocketConfig>): OrderBookStream {
  const stream = new OrderBookStream(config);
  stream.connect();
  globalOrderBookStream = stream;
  return stream;
}

/**
 * 便捷函数：停止WebSocket连接
 */
export function stopOrderBookStream(): void {
  if (globalOrderBookStream) {
    globalOrderBookStream.disconnect();
  }
}
