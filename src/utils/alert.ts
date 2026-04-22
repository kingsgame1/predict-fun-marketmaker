/**
 * Telegram 实时告警
 * 环境变量: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 * 如果未配置，告警无影响运行（静默忽略）
 */

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const ENABLED = BOT_TOKEN && CHAT_ID;

const lastAlertTime: Map<string, number> = new Map();
const COOLDOWN_MS = 60_000; // 同类型告警最少60秒一次

function shouldThrottle(key: string): boolean {
  const now = Date.now();
  const last = lastAlertTime.get(key);
  if (last && now - last < COOLDOWN_MS) return true;
  lastAlertTime.set(key, now);
  return false;
}

export async function sendAlert(title: string, message: string, options?: { throttleKey?: string; priority?: 'normal' | 'high' }): Promise<void> {
  if (!ENABLED) return;

  const throttleKey = options?.throttleKey || title;
  if (shouldThrottle(throttleKey)) return;

  const icon = options?.priority === 'high' ? '🚨' : '⚠️';
  const text = `${icon} <b>${title}</b>\n\n${message}\n\n<i>${new Date().toLocaleString('zh-CN')}</i>`;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_notification: options?.priority !== 'high',
      }),
    });
    if (!resp.ok) {
      console.warn(`⚠️ Telegram 告警发送失败: ${resp.status}`);
    }
  } catch (e) {
    console.warn(`⚠️ Telegram 告警发送异常: ${e}`);
  }
}

/** 被吃单告警 */
export function alertFill(marketId: string, side: string, price: number, shares: number, hedgeCost?: number): void {
  sendAlert(
    '订单被吃',
    `市场: <code>${marketId.slice(0, 16)}...</code>\n方向: ${side}\n价格: ${price.toFixed(4)}\n数量: ${shares.toFixed(2)}\n${hedgeCost !== undefined ? `对冲成本: $${hedgeCost.toFixed(2)}` : ''}`,
    { throttleKey: `fill-${marketId}`, priority: 'high' }
  );
}

/** API 连续失败告警 */
export function alertApiFailure(platform: string, error: string, consecutiveCount: number): void {
  sendAlert(
    'API 连续失败',
    `平台: ${platform}\n错误: ${error.slice(0, 200)}\n连续次数: ${consecutiveCount}`,
    { throttleKey: `api-fail-${platform}`, priority: 'high' }
  );
}

/** 异常退出告警 */
export function alertCrash(error: string): void {
  sendAlert(
    '程序异常退出',
    `错误: ${error.slice(0, 500)}`,
    { throttleKey: 'crash', priority: 'high' }
  );
}

/** 每日报告 */
export function alertDailyReport(pointsEarned: number, fillLoss: number, netPnl: number, uptimeHours: number): void {
  sendAlert(
    '每日运营报告',
    `运行时长: ${uptimeHours.toFixed(1)}h\n积分收益: ${pointsEarned.toFixed(2)}\n被吃损失: $${fillLoss.toFixed(2)}\n净收益: $${netPnl.toFixed(2)}`,
    { throttleKey: 'daily-report' }
  );
}
