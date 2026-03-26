/**
 * 策略模块导出
 */

// 统一做市商策略（整合所有优点）⭐⭐⭐⭐⭐
// 核心特性：
// - 异步对冲逻辑：成交一点 → 立即对冲一点（不撤单）
// - 双轨并行操作：同时在买入端和卖出端赚积分
// - 恒定价值：YES + NO = 1（持有 1:1 时风险为零）
// - 积分最大化：不间断挂单，持续赚取积分
export { UnifiedMarketMakerStrategy, unifiedMarketMakerStrategy, UnifiedState } from './unified-market-maker-strategy.js';
export type {
  UnifiedMarketMakerConfig,
  UnifiedAction,
} from './unified-market-maker-strategy.js';
