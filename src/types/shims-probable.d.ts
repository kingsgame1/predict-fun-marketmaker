declare module '@prob/clob' {
  const mod: any;
  export default mod;
  export const createClobClient: any;
  export const OrderSide: any;
  export const LimitTimeInForce: any;
}

declare module 'viem' {
  const mod: any;
  export default mod;
  export const createWalletClient: any;
  export const http: any;
}

declare module 'viem/accounts' {
  const mod: any;
  export default mod;
  export const privateKeyToAccount: any;
}

declare module 'viem/chains' {
  const mod: any;
  export default mod;
  export const bsc: any;
  export const bscTestnet: any;
}
