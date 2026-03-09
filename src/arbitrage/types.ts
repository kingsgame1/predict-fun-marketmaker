/**
 * Arbitrage strategy types
 */

export const ArbitrageType = {
  VALUE_MISMATCH: 'VALUE_MISMATCH',
  IN_PLATFORM: 'IN_PLATFORM',
  CROSS_PLATFORM: 'CROSS_PLATFORM',
  DEPENDENCY: 'DEPENDENCY',
  MULTI_OUTCOME: 'MULTI_OUTCOME',
} as const;

export type ArbitrageType = typeof ArbitrageType[keyof typeof ArbitrageType];

export interface ArbitrageOpportunity {
  type: ArbitrageType;
  marketId: string;
  marketQuestion: string;
  timestamp: number;
  confidence: number;
  estimatedValue?: number;
  marketPrice?: number;
  fairValue?: number;
  edge?: number;
  yesPrice?: number;
  noPrice?: number;
  yesPlusNo?: number;
  arbitrageProfit?: number;
  yesTokenId?: string;
  noTokenId?: string;
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  platformA?: string;
  platformB?: string;
  priceA?: number;
  priceB?: number;
  spread?: number;
  recommendedAction?: 'BUY_YES' | 'BUY_NO' | 'SELL_YES' | 'SELL_NO' | 'BUY_BOTH' | 'SELL_BOTH' | 'HOLD';
  positionSize?: number;
  expectedReturn?: number;
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  guaranteedProfit?: number;
  totalCost?: number;
  totalFees?: number;
  totalSlippage?: number;
  legs?: {
    platform?: string;
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;
    shares: number;
    outcome?: 'YES' | 'NO';
  }[];
}

export interface ValueMismatchAnalysis {
  marketId: string;
  question: string;
  category: string;
  endDate: string;
  tokenOutcome?: 'YES' | 'NO' | 'UNKNOWN';
  currentYesPrice: number;
  currentNoPrice: number;
  currentTokenPrice?: number;
  estimatedProbability: number;
  fairTokenPrice?: number;
  confidence: number;
  assessment: 'OVERVALUED' | 'UNDERVALUED' | 'FAIR';
  edge: number;
  action: 'BUY_YES' | 'BUY_NO' | 'SELL_YES' | 'SELL_NO' | 'PASS';
  reasoning: string;
}
