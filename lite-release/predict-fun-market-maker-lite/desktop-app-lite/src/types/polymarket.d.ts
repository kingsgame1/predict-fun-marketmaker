declare module '@polymarket/clob-client' {
  export interface ApiKeyCredentials {
    key?: string;
    secret?: string;
    passphrase?: string;
    apiKey?: string;
    apiSecret?: string;
    apiPassphrase?: string;
  }

  export interface OrderRequest {
    tokenID: string;
    tokenId?: string;
    price: number;
    side: 'BUY' | 'SELL';
    size: number;
  }

  export interface CreateOrderOptions {
    tickSize?: string;
    negRisk?: boolean;
  }

  export interface PostOrdersArg {
    order: any;
    orderType: 'GTC' | 'GTD' | 'FOK' | 'FAK';
    postOnly?: boolean;
  }

  export class ClobClient {
    constructor(
      host: string,
      chainId: number,
      signer: any,
      creds?: any,
      signatureType?: any,
      funderAddress?: string,
      ...rest: any[]
    );
    deriveApiKey?(): Promise<ApiKeyCredentials>;
    createApiKey?(): Promise<ApiKeyCredentials>;
    createOrDeriveApiKey?(): Promise<ApiKeyCredentials>;
    getOrderBook?(tokenID: string): Promise<any>;
    getOpenOrders?(params?: any): Promise<any>;
    getTickSize?(tokenID: string): Promise<string>;
    getNegRisk?(tokenID: string): Promise<boolean>;
    getPrice?(tokenID: string, side: string): Promise<any>;
    createOrder(order: OrderRequest, options?: Partial<CreateOrderOptions>): Promise<any>;
    postOrder(order: any, orderType?: any, deferExec?: boolean, postOnly?: boolean): Promise<any>;
    postOrders?(args: PostOrdersArg[], deferExec?: boolean, defaultPostOnly?: boolean): Promise<any>;
    cancelOrders?(orderIds: string[]): Promise<any>;
    cancelOrder?(payload: any): Promise<any>;
  }
}
