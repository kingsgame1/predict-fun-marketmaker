const envEditor = document.getElementById('envEditor');
const logs = document.getElementById('logs');
const status = document.getElementById('status');
const marketVenue = document.getElementById('marketVenue');
const scanCount = document.getElementById('scanCount');
const topCount = document.getElementById('topCount');
const marketCardGrid = document.getElementById('marketCardGrid');
const marketSummary = document.getElementById('marketSummary');
const selectAllMarkets = document.getElementById('selectAllMarkets');
const predictAutoApprovals = document.getElementById('predictAutoApprovals');
const approvalStatus = document.getElementById('approvalStatus');
const walletStatus = document.getElementById('walletStatus');
const walletSigner = document.getElementById('walletSigner');
const walletPredict = document.getElementById('walletPredict');
const walletBalance = document.getElementById('walletBalance');
const walletAllowance = document.getElementById('walletAllowance');
const walletWarning = document.getElementById('walletWarning');
const polyPreflightStatus = document.getElementById('polyPreflightStatus');
const polyPreflightUpdatedAt = document.getElementById('polyPreflightUpdatedAt');
const polySigner = document.getElementById('polySigner');
const polyFunder = document.getElementById('polyFunder');
const polySignatureType = document.getElementById('polySignatureType');
const polyCreds = document.getElementById('polyCreds');
const polyOpenOrders = document.getElementById('polyOpenOrders');
const polyNativeBalance = document.getElementById('polyNativeBalance');
const polyUsdcBalance = document.getElementById('polyUsdcBalance');
const polyUsdcAllowance = document.getElementById('polyUsdcAllowance');
const polyExchangeApproval = document.getElementById('polyExchangeApproval');
const polyNegRiskApproval = document.getElementById('polyNegRiskApproval');
const polyPreflightWarning = document.getElementById('polyPreflightWarning');
const polySelectionSummary = document.getElementById('polySelectionSummary');
const polySelectionList = document.getElementById('polySelectionList');
const riskStatus = document.getElementById('riskStatus');
const riskUpdatedAt = document.getElementById('riskUpdatedAt');
const riskSummary = document.getElementById('riskSummary');
const riskList = document.getElementById('riskList');
const startMMBtn = document.getElementById('startMM');
const stopMMBtn = document.getElementById('stopMM');
const tplPredictBtn = document.getElementById('tplPredict');
const tplPolymarketBtn = document.getElementById('tplPolymarket');
const getJwtBtn = document.getElementById('getJwt');
const refreshPredictWalletBtn = document.getElementById('refreshPredictWallet');
const refreshPolymarketPreflightBtn = document.getElementById('refreshPolymarketPreflight');
const scanMarketsBtn = document.getElementById('scanMarkets');
const applyAutoMarketsBtn = document.getElementById('applyAutoMarkets');
const applyManualMarketsBtn = document.getElementById('applyManualMarkets');
const reloadManualMarketsBtn = document.getElementById('reloadManualMarkets');
const reloadEnvBtn = document.getElementById('reloadEnv');
const saveEnvBtn = document.getElementById('saveEnv');
const api = window.liteApp;

let lastRecommendations = [];
let lastRecommendationVenue = '';
let approvalState = '待检查';
let mmRunning = false;
const busyActions = new Set();

function shortenAddress(value) {
  const text = String(value || '').trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(text)) return text || '--';
  return `${text.slice(0, 6)}...${text.slice(-4)}`;
}

function pushLog(line) {
  if (!logs) return;
  const now = new Date().toLocaleTimeString();
  logs.textContent += `[${now}] ${line}\n`;
  logs.scrollTop = logs.scrollHeight;
}

window.addEventListener('error', (event) => {
  pushLog(`前端错误: ${event.message}`);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason instanceof Error ? event.reason.message : String(event.reason || 'unknown');
  pushLog(`未处理异常: ${reason}`);
});

function formatNum(value, digits = 2) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '--';
}

function formatPct(value, digits = 2) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(digits)}%` : '--';
}

function formatMoney(value, digits = 2) {
  return Number.isFinite(Number(value)) ? `$${Number(value).toFixed(digits)}` : '--';
}

function formatDurationMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return '--';
  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(' ');
}

function parseIds(raw) {
  return String(raw || '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function parseEnvMap(raw) {
  const map = new Map();
  String(raw || '')
    .split('\n')
    .forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx === -1) return;
      map.set(trimmed.slice(0, idx), trimmed.slice(idx + 1));
    });
  return map;
}

function getEnvMap() {
  return parseEnvMap(envEditor?.value || '');
}

function getCurrentVenue() {
  return (getEnvMap().get('MM_VENUE') || 'predict').trim().toLowerCase();
}

function getConfiguredTokenIds() {
  return parseIds(getEnvMap().get('MARKET_TOKEN_IDS') || '');
}

function upsertEnv(raw, key, value) {
  const lines = String(raw || '').split('\n');
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      replaced = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!replaced) {
    while (nextLines.length > 0 && nextLines[nextLines.length - 1] === '') nextLines.pop();
    nextLines.push(`${key}=${value}`);
  }
  return `${nextLines.join('\n').replace(/\n*$/g, '')}\n`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setApprovalStatus(state) {
  approvalState = state;
  if (!approvalStatus) return;
  approvalStatus.textContent = `授权状态：${state}`;
  approvalStatus.style.background =
    state === '已就绪' ? '#065f46' : state === '授权失败' ? '#7f1d1d' : '#334155';
}

function setWalletStatusBadge(state, kind = 'idle') {
  if (!walletStatus) return;
  walletStatus.textContent = `余额状态：${state}`;
  walletStatus.style.background =
    kind === 'ok' ? '#065f46' : kind === 'error' ? '#7f1d1d' : kind === 'warn' ? '#92400e' : '#334155';
}

function setPolymarketBadge(state, kind = 'idle') {
  if (!polyPreflightStatus) return;
  polyPreflightStatus.textContent = `预检状态：${state}`;
  polyPreflightStatus.style.background =
    kind === 'ok' ? '#065f46' : kind === 'error' ? '#7f1d1d' : kind === 'warn' ? '#92400e' : '#334155';
}


function setBusy(name, active) {
  if (active) busyActions.add(name);
  else busyActions.delete(name);
  syncButtonState();
}

async function runUiAction(name, fn) {
  setBusy(name, true);
  try {
    await fn();
  } catch (error) {
    pushLog(`${name} 执行失败: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setBusy(name, false);
  }
}

function setButtonDisabled(button, disabled, title = '') {
  if (!button) return;
  button.disabled = Boolean(disabled);
  if (title) button.title = title;
  else button.removeAttribute('title');
}

function syncButtonState() {
  const envVenue = getCurrentVenue();
  const selectedVenue = String(marketVenue?.value || 'predict').toLowerCase();
  const hasRecommendations = lastRecommendations.length > 0;
  const recommendationMatchesVenue = !hasRecommendations || lastRecommendationVenue === selectedVenue;
  const checkedCount = getCheckedTokenIds().length;
  const hasApi = Boolean(api);
  const running = mmRunning;

  setButtonDisabled(startMMBtn, !hasApi || running || busyActions.has('startMM'));
  setButtonDisabled(stopMMBtn, !hasApi || !running || busyActions.has('stopMM'));
  setButtonDisabled(tplPredictBtn, !hasApi || busyActions.has('tplPredict') || running, running ? '做市运行中时不允许切换模板' : '');
  setButtonDisabled(tplPolymarketBtn, !hasApi || busyActions.has('tplPolymarket') || running, running ? '做市运行中时不允许切换模板' : '');
  setButtonDisabled(getJwtBtn, !hasApi || envVenue !== 'predict' || busyActions.has('getJwt'), envVenue !== 'predict' ? '仅 Predict 模式需要 JWT' : '');
  setButtonDisabled(refreshPredictWalletBtn, !hasApi || envVenue !== 'predict' || busyActions.has('refreshPredictWallet'), envVenue !== 'predict' ? '当前 .env 不是 Predict 模式' : '');
  setButtonDisabled(refreshPolymarketPreflightBtn, !hasApi || envVenue !== 'polymarket' || busyActions.has('refreshPolymarketPreflight'), envVenue !== 'polymarket' ? '当前 .env 不是 Polymarket 模式' : '');
  setButtonDisabled(scanMarketsBtn, !hasApi || busyActions.has('scanMarkets'));
  setButtonDisabled(
    applyAutoMarketsBtn,
    !hasApi || busyActions.has('applyAutoMarkets') || selectedVenue !== envVenue || !hasRecommendations || !recommendationMatchesVenue,
    selectedVenue !== envVenue
      ? '当前扫描场馆与 .env 里的 MM_VENUE 不一致，请先套用对应模板并保存配置'
      : !recommendationMatchesVenue
      ? '当前卡片不是这个场馆的扫描结果，请重新扫描'
      : !hasRecommendations
      ? '请先扫描市场'
      : ''
  );
  setButtonDisabled(
    applyManualMarketsBtn,
    !hasApi || busyActions.has('applyManualMarkets') || checkedCount === 0 || !recommendationMatchesVenue,
    !recommendationMatchesVenue ? '当前卡片不是这个场馆的扫描结果，请重新扫描' : checkedCount === 0 ? '请先勾选市场' : ''
  );
  setButtonDisabled(reloadManualMarketsBtn, !hasApi || busyActions.has('reloadManualMarkets'));
  setButtonDisabled(reloadEnvBtn, !hasApi || busyActions.has('reloadEnv'));
  setButtonDisabled(saveEnvBtn, !hasApi || busyActions.has('saveEnv') || running, running ? '做市运行中时不允许覆盖 .env' : '');
}

function renderRiskState(payload) {
  const pausedMarkets = Array.isArray(payload?.pausedMarkets) ? payload.pausedMarkets : [];
  if (riskStatus) {
    if (payload?.running && pausedMarkets.length > 0) {
      riskStatus.textContent = `风控状态：${pausedMarkets.length} 个市场暂停中`;
      riskStatus.style.background = '#92400e';
    } else if (payload?.running) {
      riskStatus.textContent = '风控状态：运行中';
      riskStatus.style.background = '#065f46';
    } else {
      riskStatus.textContent = '风控状态：空闲';
      riskStatus.style.background = '#334155';
    }
  }
  if (riskUpdatedAt) {
    riskUpdatedAt.textContent = `最近更新：${payload?.lastUpdatedAt ? new Date(payload.lastUpdatedAt).toLocaleTimeString() : '--'}`;
  }
  if (riskSummary) {
    if (payload?.lastError) {
      riskSummary.textContent = `最近异常：${payload.lastError}`;
    } else if (pausedMarkets.length > 0) {
      riskSummary.textContent = `最近暂停：${payload?.lastPauseEvent || '已记录风险暂停事件'}`;
    } else {
      riskSummary.textContent = '当前暂无暂停市场。';
    }
  }
  if (!riskList) return;
  riskList.innerHTML = pausedMarkets
    .map(
      (item) => `
        <div class="wallet-card">
          <div class="wallet-title">${escapeHtml(item.token || '--')}</div>
          <div class="wallet-value">${escapeHtml(item.source || 'risk')}</div>
          <div class="hint">${escapeHtml(item.reason || 'paused')}</div>
          <div class="hint">${escapeHtml(item.remaining || '--')}</div>
        </div>
      `
    )
    .join('');
}

function renderPredictWalletStatus(payload) {
  const balance = Number(payload?.balance || 0);
  const approvalReady = Boolean(payload?.approvalReady);
  setApprovalStatus(approvalReady ? '已就绪' : '待授权');
  if (walletSigner) walletSigner.textContent = shortenAddress(payload?.signerAddress);
  if (walletPredict) walletPredict.textContent = shortenAddress(payload?.predictAccountAddress || '(未配置)');
  if (walletBalance) walletBalance.textContent = Number.isFinite(balance) ? `${balance.toFixed(6)} USDT` : '--';
  if (walletAllowance) walletAllowance.textContent = approvalReady ? '已就绪' : '待授权';

  const warnings = [];
  if (!payload?.predictAccountAddress) warnings.push('未配置 PREDICT_ACCOUNT_ADDRESS。');
  if (payload?.suspiciousPredictAccount) warnings.push('PREDICT_ACCOUNT_ADDRESS 与 signer 地址相同，疑似填错。');
  if (balance <= 0) warnings.push('Predict 账号 USDT 余额为 0。');
  if (!approvalReady) warnings.push('Allowance 未全部就绪。');
  if (walletWarning) walletWarning.textContent = warnings.join(' ');
  if (warnings.length === 0) {
    setWalletStatusBadge('已就绪', 'ok');
  } else if (balance > 0 && payload?.predictAccountAddress) {
    setWalletStatusBadge('需处理', 'warn');
  } else {
    setWalletStatusBadge('异常', 'error');
  }
}

function renderPolymarketSelectionSummary() {
  if (!polySelectionSummary || !polySelectionList) return;
  const venue = getCurrentVenue();
  if (venue !== 'polymarket') {
    polySelectionSummary.innerHTML = `
      <div class="wallet-card">
        <div class="wallet-title">当前已选市场预检摘要</div>
        <div class="hint">当前场馆不是 Polymarket，已跳过该摘要。</div>
      </div>
    `;
    polySelectionList.innerHTML = '';
    return;
  }

  const selectedIds = getConfiguredTokenIds();
  if (selectedIds.length === 0) {
    polySelectionSummary.innerHTML = `
      <div class="wallet-card">
        <div class="wallet-title">当前已选市场预检摘要</div>
        <div class="hint">当前未配置 MARKET_TOKEN_IDS。先扫描并应用市场后，这里会显示奖励效率、风险记忆与冷却摘要。</div>
      </div>
    `;
    polySelectionList.innerHTML = '';
    return;
  }

  const selectedSet = new Set(selectedIds);
  const matched = lastRecommendations.filter((item) => selectedSet.has(String(item.tokenId)));
  if (matched.length === 0) {
    polySelectionSummary.innerHTML = `
      <div class="wallet-card">
        <div class="wallet-title">当前已选市场预检摘要</div>
        <div class="hint">当前已选 ${selectedIds.length} 个市场，但它们不在本次扫描结果里。先重新扫描当前时段市场，再复核奖励效率和风险记忆。</div>
      </div>
    `;
    polySelectionList.innerHTML = '';
    return;
  }

  const numericValues = (items, key) => items.map((item) => Number(item[key])).filter((value) => Number.isFinite(value));
  const effValues = numericValues(matched, 'rewardEffectiveNetEfficiency');
  const recentRiskValues = numericValues(matched, 'recentRiskPenalty');
  const cooldownValues = numericValues(matched, 'recentRiskCooldownMinutes');
  const patternValues = numericValues(matched, 'patternMemoryPenalty');
  const hourValues = numericValues(matched, 'hourRiskPenalty');
  const marketHourValues = numericValues(matched, 'marketHourRiskPenalty');

  const summaryCards = [
    { title: '已选市场', value: `${matched.length}/${selectedIds.length}`, hint: selectedIds.length > matched.length ? `有 ${selectedIds.length - matched.length} 个已选市场不在本次扫描结果中` : '已选市场均已命中本次扫描结果' },
    { title: '最低有效净效率', value: effValues.length ? `${formatPct(Math.min(...effValues) * 100, 2)}/日` : '--', hint: '越低说明奖励对资金占用与风险补偿越差' },
    { title: '最高近期风险', value: recentRiskValues.length ? `-${formatNum(Math.max(...recentRiskValues), 1)}` : '--', hint: '反映最近不利成交 / postOnly / 风控事件强度' },
    { title: '冷却中的市场', value: cooldownValues.filter((x) => x > 0).length ? `${cooldownValues.filter((x) => x > 0).length} 个` : '0 个', hint: cooldownValues.some((x) => x > 0) ? `最长剩余 ${formatNum(Math.max(...cooldownValues), 0)}m` : '当前无市场处于近期冷却' },
    { title: '最高长期模式', value: patternValues.length ? `-${formatNum(Math.max(...patternValues), 1)}` : '--', hint: '反映长期撤单模式记忆的持续影响' },
    { title: '最高时段风险', value: hourValues.length || marketHourValues.length ? `-${formatNum(Math.max(0, ...hourValues, ...marketHourValues), 1)}` : '--', hint: '当前小时历史风险越高，越不适合实盘挂单' },
  ];

  polySelectionSummary.innerHTML = summaryCards
    .map(
      (item) => `
        <div class="wallet-card">
          <div class="wallet-title">${escapeHtml(item.title)}</div>
          <div class="wallet-value">${escapeHtml(item.value)}</div>
          <div class="hint">${escapeHtml(item.hint)}</div>
        </div>
      `
    )
    .join('');

  polySelectionList.innerHTML = matched
    .slice(0, 8)
    .map((item) => {
      const lines = [
        `有效净效率 ${item.rewardEffectiveNetEfficiency == null ? '--' : `${formatPct(Number(item.rewardEffectiveNetEfficiency) * 100, 2)}/日`}`,
        `近期风险 ${item.recentRiskPenalty == null ? '--' : `-${formatNum(item.recentRiskPenalty, 1)}`}`,
        `冷却 ${item.recentRiskCooldownMinutes == null || Number(item.recentRiskCooldownMinutes) <= 0 ? '无' : `${formatNum(item.recentRiskCooldownMinutes, 0)}m`}`,
        `长期模式 ${item.patternMemoryPenalty == null ? '--' : `-${formatNum(item.patternMemoryPenalty, 1)}`}`,
        `时段风险 ${item.hourRiskPenalty == null ? '--' : `-${formatNum(item.hourRiskPenalty, 1)}`}`,
      ];
      return `
        <div class="wallet-card">
          <div class="wallet-title">${escapeHtml(item.question || item.tokenId)}</div>
          <div class="wallet-value">${escapeHtml(shortenAddress(item.tokenId || '--'))}</div>
          <div class="hint">${escapeHtml(lines.join(' | '))}</div>
          ${item.recentRiskReason ? `<div class="hint">近期风险: ${escapeHtml(item.recentRiskReason)}</div>` : ''}
          ${item.recentRiskCooldownReason ? `<div class="hint">冷却原因: ${escapeHtml(item.recentRiskCooldownReason)}</div>` : ''}
          ${item.patternMemoryReason ? `<div class="hint">长期模式: ${escapeHtml(item.patternMemoryReason)}</div>` : ''}
        </div>
      `;
    })
    .join('');
}

function renderPolymarketPreflight(payload) {
  if (polyPreflightUpdatedAt) {
    polyPreflightUpdatedAt.textContent = `最近更新：${payload?.updatedAt ? new Date(payload.updatedAt).toLocaleTimeString() : '--'}`;
  }
  if (polySigner) polySigner.textContent = shortenAddress(payload?.signerAddress || '--');
  if (polyFunder) polyFunder.textContent = shortenAddress(payload?.funderAddress || '--');
  if (polySignatureType) polySignatureType.textContent = payload?.signatureType == null ? '--' : String(payload.signatureType);
  if (polyCreds) polyCreds.textContent = payload?.credsReady ? '已就绪' : '缺失';
  if (polyOpenOrders) {
    if (payload?.openOrderQueryOk === false && payload?.preflightError) {
      polyOpenOrders.textContent = '查询失败';
    } else {
      polyOpenOrders.textContent = payload?.openOrderCount == null ? '--' : String(payload.openOrderCount);
    }
  }
  if (polyNativeBalance) {
    polyNativeBalance.textContent = Number.isFinite(Number(payload?.signerNativeBalance))
      ? `${Number(payload.signerNativeBalance).toFixed(4)} ${payload?.signerNativeSymbol || 'POL'}`
      : '--';
  }
  if (polyUsdcBalance) {
    polyUsdcBalance.textContent = Number.isFinite(Number(payload?.funderUsdcBalance))
      ? `${Number(payload.funderUsdcBalance).toFixed(2)} ${payload?.funderUsdcSymbol || 'USDC.e'}`
      : '--';
  }
  if (polyUsdcAllowance) {
    if (payload?.usdcAllowanceSupported) {
      const amount = Number.isFinite(Number(payload?.usdcAllowance)) ? Number(payload.usdcAllowance).toFixed(2) : '--';
      polyUsdcAllowance.textContent = `${amount} ${payload?.funderUsdcSymbol || 'USDC.e'} / ${payload?.usdcAllowanceReady ? '已就绪' : '待授权'}`;
    } else {
      polyUsdcAllowance.textContent = '不支持';
    }
  }
  if (polyExchangeApproval) {
    polyExchangeApproval.textContent = payload?.exchangeApprovalSupported ? (payload?.exchangeApprovalReady ? '已就绪' : '待授权') : '不支持';
  }
  if (polyNegRiskApproval) {
    polyNegRiskApproval.textContent = payload?.negRiskExchangeApprovalSupported
      ? payload?.negRiskExchangeApprovalReady
        ? '已就绪'
        : '待授权'
      : '不支持';
  }

  const warnings = [];
  if (Array.isArray(payload?.coreIssues) && payload.coreIssues.length > 0) warnings.push(...payload.coreIssues);
  if (Array.isArray(payload?.warnings) && payload.warnings.length > 0) warnings.push(...payload.warnings);
  if (payload?.preflightError && !warnings.includes(`交易预检失败: ${payload.preflightError}`)) warnings.push(`交易预检失败: ${payload.preflightError}`);
  if (polyPreflightWarning) polyPreflightWarning.textContent = warnings.join(' ');

  if (payload?.coreReady) {
    setPolymarketBadge('已就绪', 'ok');
  } else if (warnings.length > 0) {
    setPolymarketBadge('需处理', 'warn');
  } else {
    setPolymarketBadge('异常', 'error');
  }

  renderPolymarketSelectionSummary();
}

async function refreshPredictWalletStatus(forceLog = false) {
  if (!api) return;
  const venue = getCurrentVenue();
  if (venue !== 'predict') {
    setWalletStatusBadge('非 Predict 模式');
    if (walletWarning) walletWarning.textContent = '当前场馆不是 Predict，余额检查已跳过。';
    return;
  }
  setWalletStatusBadge('检查中');
  const res = await api.getPredictWalletStatus();
  if (!res?.ok) {
    setWalletStatusBadge('检查失败', 'error');
    if (walletWarning) walletWarning.textContent = res?.message || '未知错误';
    if (forceLog) pushLog(`余额检查失败: ${res?.message || 'unknown'}`);
    return;
  }
  renderPredictWalletStatus(res.payload || {});
  syncButtonState();
  if (forceLog) {
    pushLog(
      `Predict 余额检查完成: account=${res.payload?.predictAccountAddress || '(未配置)'} balance=${Number(res.payload?.balance || 0).toFixed(6)} approvals=${res.payload?.approvalReady ? 'ready' : 'pending'}`
    );
  }
}

async function refreshPolymarketPreflight(forceLog = false) {
  if (!api) return;
  const venue = getCurrentVenue();
  if (venue !== 'polymarket') {
    setPolymarketBadge('非 Polymarket 模式');
    if (polyPreflightWarning) polyPreflightWarning.textContent = '当前场馆不是 Polymarket，预检已跳过。';
    renderPolymarketSelectionSummary();
    return;
  }
  setPolymarketBadge('检查中');
  if (polyPreflightUpdatedAt) polyPreflightUpdatedAt.textContent = '最近更新：--';
  const res = await api.getPolymarketPreflightStatus();
  if (!res?.ok) {
    setPolymarketBadge('检查失败', 'error');
    if (polyPreflightWarning) polyPreflightWarning.textContent = res?.message || '未知错误';
    if (forceLog) pushLog(`Polymarket 预检失败: ${res?.message || 'unknown'}`);
    renderPolymarketSelectionSummary();
    return;
  }
  renderPolymarketPreflight(res.payload || {});
  syncButtonState();
  if (forceLog) {
    const payload = res.payload || {};
    pushLog(
      `Polymarket 预检完成: funder=${payload.funderAddress || '--'} native=${Number(payload.signerNativeBalance || 0).toFixed(4)} ${payload.signerNativeSymbol || 'POL'} usdc=${Number(payload.funderUsdcBalance || 0).toFixed(2)} ${payload.funderUsdcSymbol || 'USDC.e'} creds=${payload.credsReady ? 'ready' : 'missing'} allowance=${payload.usdcAllowanceReady ? 'ready' : 'pending'}`
    );
  }
}

function getCheckedTokenIds() {
  return Array.from(document.querySelectorAll('.market-check:checked'))
    .map((el) => el.dataset.token)
    .filter(Boolean);
}

function updateSelectAllState() {
  const checks = Array.from(document.querySelectorAll('.market-check'));
  const checked = checks.filter((el) => el.checked);
  if (!selectAllMarkets) return;
  if (checks.length === 0) {
    selectAllMarkets.checked = false;
    selectAllMarkets.indeterminate = false;
    return;
  }
  selectAllMarkets.checked = checked.length === checks.length;
  selectAllMarkets.indeterminate = checked.length > 0 && checked.length < checks.length;
}

function renderMarketCards(items, selected = new Set()) {
  if (!marketCardGrid) return;
  marketCardGrid.innerHTML = '';

  if (!items.length) {
    marketCardGrid.innerHTML = '<div class="market-empty">暂无推荐结果。先扫描市场，再根据卡片里的奖励效率、风险记忆和冷却状态决定是否应用。</div>';
    if (marketSummary) marketSummary.textContent = '暂无推荐结果';
    updateSelectAllState();
    renderPolymarketSelectionSummary();
    return;
  }

  const appliedCount = items.filter((item) => item.activeStatus === '已应用').length;
  if (marketSummary) {
    marketSummary.textContent = `共 ${items.length} 个推荐，已应用 ${appliedCount} 个，当前勾选 ${selected.size} 个`;
  }

  items.forEach((item) => {
    const card = document.createElement('article');
    const isSelected = selected.has(String(item.tokenId));
    const isApplied = item.activeStatus === '已应用';
    card.className = `market-card${isSelected ? ' selected' : ''}${isApplied ? ' applied' : ''}`;

    const reasons = Array.isArray(item.reasons) ? item.reasons.slice(0, 4) : [];
    const gap = item.maxLevelGap == null ? '--' : `${formatNum(item.maxLevelGap, 4)}$`;
    const symmetry = item.symmetry == null ? '--' : formatNum(item.symmetry, 3);
    const centerScore = item.centerScore == null ? '--' : formatNum(item.centerScore, 3);
    const scoreText = item.score == null ? '--' : formatNum(item.score, 2);
    const bid2Price = item.bid2Price == null ? '--' : formatNum(item.bid2Price, 4);
    const ask2Price = item.ask2Price == null ? '--' : formatNum(item.ask2Price, 4);

    const riskPenalty = item.recentRiskPenalty == null ? null : Number(item.recentRiskPenalty);
    const cooldownMinutes = item.recentRiskCooldownMinutes == null ? null : Number(item.recentRiskCooldownMinutes);
    const hourRiskPenalty = item.hourRiskPenalty == null ? null : Number(item.hourRiskPenalty);
    const marketHourRiskPenalty = item.marketHourRiskPenalty == null ? null : Number(item.marketHourRiskPenalty);
    const patternMemoryPenalty = item.patternMemoryPenalty == null ? null : Number(item.patternMemoryPenalty);
    const patternMemoryTtlHours = item.patternMemoryTtlHours == null ? null : Number(item.patternMemoryTtlHours);
    const patternMemoryDecayFactor = item.patternMemoryDecayFactor == null ? null : Number(item.patternMemoryDecayFactor);
    const patternNearTouch = item.patternMemoryNearTouch == null ? null : Number(item.patternMemoryNearTouch);
    const patternRefresh = item.patternMemoryRefresh == null ? null : Number(item.patternMemoryRefresh);
    const patternVwap = item.patternMemoryVwap == null ? null : Number(item.patternMemoryVwap);
    const patternAggressive = item.patternMemoryAggressive == null ? null : Number(item.patternMemoryAggressive);
    const patternUnsafe = item.patternMemoryUnsafe == null ? null : Number(item.patternMemoryUnsafe);
    const patternLearnedRetreat = item.patternMemoryLearnedRetreat == null ? null : Number(item.patternMemoryLearnedRetreat);
    const patternLearnedSize = item.patternMemoryLearnedSize == null ? null : Number(item.patternMemoryLearnedSize);

    const riskChip = riskPenalty && riskPenalty > 0 ? `<span class="status-chip" style="background:#7f1d1d;border-color:#b91c1c;">近期风险 -${escapeHtml(formatNum(riskPenalty, 1))}</span>` : '';
    const cooldownChip = cooldownMinutes && cooldownMinutes > 0 ? `<span class="status-chip" style="background:#78350f;border-color:#d97706;">冷却 ${escapeHtml(formatNum(cooldownMinutes, 0))}m</span>` : '';
    const hourRiskChip = hourRiskPenalty && hourRiskPenalty > 0 ? `<span class="status-chip" style="background:#312e81;border-color:#6366f1;">时段风险 -${escapeHtml(formatNum(hourRiskPenalty, 1))}</span>` : '';
    const marketHourRiskChip = marketHourRiskPenalty && marketHourRiskPenalty > 0 ? `<span class="status-chip" style="background:#1e3a8a;border-color:#3b82f6;">市场时段风险 -${escapeHtml(formatNum(marketHourRiskPenalty, 1))}</span>` : '';
    const patternMemoryChip = patternMemoryPenalty && patternMemoryPenalty > 0 ? `<span class="status-chip" style="background:#3f1d7a;border-color:#8b5cf6;">长期模式 -${escapeHtml(formatNum(patternMemoryPenalty, 1))}${patternMemoryTtlHours && patternMemoryTtlHours > 0 ? ` / ${escapeHtml(formatNum(patternMemoryTtlHours, 1))}h` : ''}</span>` : '';
    const patternMixSummary = [
      patternAggressive != null ? `激进${formatPct(patternAggressive * 100, 0)}` : null,
      patternUnsafe != null ? `不安全${formatPct(patternUnsafe * 100, 0)}` : null,
      patternNearTouch != null ? `近触${formatPct(patternNearTouch * 100, 0)}` : null,
      patternVwap != null ? `VWAP${formatPct(patternVwap * 100, 0)}` : null,
      patternRefresh != null ? `追价${formatPct(patternRefresh * 100, 0)}` : null,
    ].filter(Boolean).join(' / ');

    const incentivePanels = [];
    if (item.rewardEnabled) {
      incentivePanels.push(`
        <div class="metric-panel incentive-panel">
          <div class="metric-label">流动性激励</div>
          <div class="metric-value">日速率 ${item.rewardDailyRate == null ? '--' : formatNum(item.rewardDailyRate, 0)}</div>
          <div class="metric-subvalue">最小单边 ${item.rewardMinSize == null ? '--' : formatNum(item.rewardMinSize, 0)} 股 / 最大奖励价差 ${item.rewardMaxSpreadCents == null ? '--' : formatNum(item.rewardMaxSpreadCents, 2)}¢</div>
          <div class="metric-subvalue">激励适配度 ${item.rewardFitScore == null ? '--' : formatPct(Number(item.rewardFitScore) * 100, 0)} / 排队倍数 ${item.rewardCrowdingMultiple == null ? '--' : `${formatNum(item.rewardCrowdingMultiple, 2)}x`}</div>
          <div class="metric-subvalue">最低双边资金 ${item.rewardCapitalEstimateUsd == null ? '--' : formatMoney(item.rewardCapitalEstimateUsd, 2)} / 毛效率 ${item.rewardEfficiency == null ? '--' : `${formatPct(Number(item.rewardEfficiency) * 100, 2)}/日`}</div>
          <div class="metric-subvalue">净效率 ${item.rewardNetEfficiency == null ? '--' : `${formatPct(Number(item.rewardNetEfficiency) * 100, 2)}/日`} / 有效净效率 ${item.rewardEffectiveNetEfficiency == null ? '--' : `${formatPct(Number(item.rewardEffectiveNetEfficiency) * 100, 2)}/日`}</div>
          <div class="metric-subvalue">净日奖励 ${item.rewardNetDailyRate == null ? '--' : formatMoney(item.rewardNetDailyRate, 2)} / 有效净日奖励 ${item.rewardEffectiveNetDailyRate == null ? '--' : formatMoney(item.rewardEffectiveNetDailyRate, 2)}</div>
          <div class="metric-subvalue">估算成本 ${item.rewardEstimatedCostBps == null ? '--' : `${formatNum(item.rewardEstimatedCostBps, 2)}bps`} / 风险缩放 ${item.rewardRiskThrottleFactor == null ? '--' : `${formatNum(item.rewardRiskThrottleFactor, 3)}x`} / 时段系数 ${item.rewardHourRiskFactor == null ? '--' : `${formatNum(item.rewardHourRiskFactor, 3)}x`}</div>
          <div class="metric-subvalue">撤单率 ${item.recentCancelRate == null ? '--' : `${formatPct(Number(item.recentCancelRate) * 100, 0)}`} / 平均撤单寿命 ${item.recentAvgCancelLifetimeMs == null ? '--' : `${formatNum(Number(item.recentAvgCancelLifetimeMs) / 60000, 1)}m`} / 平均成交寿命 ${item.recentAvgFillLifetimeMs == null ? '--' : `${formatNum(Number(item.recentAvgFillLifetimeMs) / 60000, 1)}m`}</div>
          <div class="metric-subvalue">队列耗时 ${item.rewardQueueHours == null ? '--' : `${formatNum(item.rewardQueueHours, 2)}h`} / 流速倍率 ${item.rewardFlowToQueuePerHour == null ? '--' : `${formatNum(item.rewardFlowToQueuePerHour, 2)}x/h`}</div>
          ${item.recentRiskReason ? `<div class="metric-subvalue">风险记忆 ${escapeHtml(item.recentRiskReason)}</div>` : ''}
          ${item.recentRiskCooldownReason ? `<div class="metric-subvalue">冷却 ${escapeHtml(item.recentRiskCooldownReason)}${cooldownMinutes && cooldownMinutes > 0 ? ` / ${escapeHtml(formatNum(cooldownMinutes, 0))}m` : ''}</div>` : ''}
          ${item.marketHourRiskReason ? `<div class="metric-subvalue">市场时段风险 ${escapeHtml(item.marketHourRiskReason)}</div>` : ''}
          ${item.patternMemoryReason ? `<div class="metric-subvalue">长期模式 ${escapeHtml(item.patternMemoryReason)}${item.patternMemoryDominantReason ? ` / 主导撤单 ${escapeHtml(item.patternMemoryDominantReason)}` : ''}${item.patternMemoryDominance == null ? '' : ` / 主导度 ${escapeHtml(formatPct(Number(item.patternMemoryDominance) * 100, 0))}`}${patternMemoryDecayFactor == null ? '' : ` / 衰减系数 ${escapeHtml(formatNum(patternMemoryDecayFactor, 3))}x`}${patternMemoryTtlHours == null ? '' : ` / 剩余 ${escapeHtml(formatNum(patternMemoryTtlHours, 1))}h`}</div>` : ''}
          ${patternMixSummary ? `<div class="metric-subvalue">长期模式构成 ${escapeHtml(patternMixSummary)}</div>` : ''}
          ${patternLearnedRetreat != null || patternLearnedSize != null ? `<div class="metric-subvalue">学习退后 ${patternLearnedRetreat == null ? '--' : `${escapeHtml(formatNum(patternLearnedRetreat, 3))}x`} / 学习缩单 ${patternLearnedSize == null ? '--' : `${escapeHtml(formatNum(patternLearnedSize, 3))}x`}</div>` : ''}
        </div>
      `);
    }

    card.innerHTML = `
      <div class="market-card-header">
        <div>
          <div class="market-topline">
            <span class="rank-chip">#${escapeHtml(item.rank)}</span>
            <span class="score-chip">Score ${escapeHtml(scoreText)}</span>
            <span class="status-chip">${escapeHtml(item.activeStatus || '未应用')}</span>
            ${riskChip}
            ${cooldownChip}
            ${hourRiskChip}
            ${marketHourRiskChip}
            ${patternMemoryChip}
          </div>
          <h3 class="market-card-title">${escapeHtml(item.question || '--')}</h3>
        </div>
        <div class="market-card-actions">
          <button class="market-link-btn" type="button" data-market-url="${escapeHtml(item.marketUrl || '')}">
            ${escapeHtml(item.marketLinkLabel || '打开市场')}
          </button>
          <label class="market-check-wrap">
            <input type="checkbox" class="market-check" data-token="${escapeHtml(item.tokenId)}" ${isSelected ? 'checked' : ''} />
            选择
          </label>
        </div>
      </div>
      <div class="market-quote-grid">
        <div class="quote-panel bid">
          <div class="metric-label">买一</div>
          <div class="metric-value">${item.bid1Price == null ? '--' : formatNum(item.bid1Price, 4)}</div>
          <div class="metric-subvalue">${item.bid1Shares == null ? '--' : formatNum(item.bid1Shares, 2)} 股</div>
        </div>
        <div class="quote-panel ask">
          <div class="metric-label">卖一</div>
          <div class="metric-value">${item.ask1Price == null ? '--' : formatNum(item.ask1Price, 4)}</div>
          <div class="metric-subvalue">${item.ask1Shares == null ? '--' : formatNum(item.ask1Shares, 2)} 股</div>
        </div>
        <div class="quote-panel bid secondary">
          <div class="metric-label">买二</div>
          <div class="metric-value">${bid2Price}</div>
          <div class="metric-subvalue">${item.bid2Shares == null ? '--' : formatNum(item.bid2Shares, 2)} 股</div>
        </div>
        <div class="quote-panel ask secondary">
          <div class="metric-label">卖二</div>
          <div class="metric-value">${ask2Price}</div>
          <div class="metric-subvalue">${item.ask2Shares == null ? '--' : formatNum(item.ask2Shares, 2)} 股</div>
        </div>
      </div>
      <div class="market-spread-strip">
        <span class="metric-chip">价差 ${item.spreadPct == null ? '--' : formatPct(item.spreadPct, 2)}</span>
        <span class="metric-chip">断层 ${gap}</span>
      </div>
      ${incentivePanels.length ? `<div class="market-stats-row">${incentivePanels.join('')}</div>` : ''}
      <div class="market-quality-row">
        <span class="metric-chip">对称度 ${escapeHtml(symmetry)}</span>
        <span class="metric-chip">中心度 ${escapeHtml(centerScore)}</span>
        <span class="quote-chip">L1双边 ${item.l1NotionalUsd == null ? '--' : formatMoney(item.l1NotionalUsd, 2)}</span>
        <span class="quote-chip ask">L2双边 ${item.l2NotionalUsd == null ? '--' : formatMoney(item.l2NotionalUsd, 2)}</span>
      </div>
      <div class="market-reasons">${reasons.length ? reasons.map((reason) => `<span class="reason-chip">${escapeHtml(reason)}</span>`).join('') : '<span class="reason-chip">暂无推荐说明</span>'}</div>
      ${item.recentRiskReason ? `<div class="market-token">风险记忆: ${escapeHtml(item.recentRiskReason)}</div>` : ''}
      ${item.recentRiskCooldownReason ? `<div class="market-token">冷却原因: ${escapeHtml(item.recentRiskCooldownReason)}</div>` : ''}
      ${item.hourRiskReason ? `<div class="market-token">时段风险: ${escapeHtml(item.hourRiskReason)}</div>` : ''}
      <div class="market-token">Token: ${escapeHtml(item.tokenId)}</div>
    `;
    marketCardGrid.appendChild(card);
  });

  updateSelectAllState();
  renderPolymarketSelectionSummary();
  syncButtonState();
}

async function refreshEnv() {
  if (!api || !envEditor) return;
  envEditor.value = await api.readEnv();
  const envMap = getEnvMap();
  if (predictAutoApprovals) {
    predictAutoApprovals.checked = (envMap.get('PREDICT_AUTO_SET_APPROVALS') || 'true').toLowerCase() !== 'false';
  }
  const configuredVenue = (envMap.get('MM_VENUE') || 'predict').toLowerCase();
  if (marketVenue) marketVenue.value = configuredVenue === 'polymarket' ? 'polymarket' : 'predict';
  renderMarketCards(lastRecommendations, new Set(getConfiguredTokenIds()));
  await refreshPredictWalletStatus();
  await refreshPolymarketPreflight();
  syncButtonState();
}

async function refreshStatus() {
  if (!api || !status) return;
  const s = await api.status();
  mmRunning = Boolean(s?.running);
  status.textContent = mmRunning ? '运行中' : '未运行';
  status.style.background = mmRunning ? '#065f46' : '#334155';
  renderRiskState(s);
  syncButtonState();
}

async function scanMarkets() {
  if (!api) return;
  const venue = marketVenue.value === 'polymarket' ? 'polymarket' : 'predict';
  const scan = Math.max(10, Number(scanCount.value || 80));
  const top = Math.max(5, Number(topCount.value || 30));
  pushLog(`开始扫描市场 venue=${venue} scan=${scan} top=${top}`);
  const res = await api.scanMarkets(venue, top, scan);
  if (!res?.ok) {
    const msg = res?.message || 'unknown';
    pushLog(`市场扫描失败: ${msg}`);
    if (String(msg).includes('ENOTFOUND')) {
      pushLog('网络解析失败：请检查网络/DNS，或确认 API / Gamma / CLOB 地址可访问。');
    }
    return;
  }
  const payload = res.payload || {};
  lastRecommendations = Array.isArray(payload.recommendations) ? payload.recommendations : [];
  lastRecommendationVenue = venue;
  renderMarketCards(lastRecommendations, new Set(getConfiguredTokenIds()));
  pushLog(`扫描完成: valid=${payload.validMarkets || 0}, recommendations=${lastRecommendations.length}`);
  if (lastRecommendations.length === 0) {
    pushLog(venue === 'predict' ? '未找到可推荐市场。请确认 API_KEY 已填写，或提高 scan/top 后重试。' : '未找到可推荐市场。请提高 scan/top，或切换到流动性更高时段。');
  }
}

async function applyAutoMarkets() {
  if (!api) return;
  const venue = marketVenue.value === 'polymarket' ? 'polymarket' : 'predict';
  const scan = Math.max(10, Number(scanCount.value || 80));
  const top = Math.max(5, Number(topCount.value || 30));
  const res = await api.applyAutoMarkets(venue, top, scan);
  if (!res?.ok) {
    pushLog(`自动应用失败: ${res?.message || 'unknown'}`);
    return;
  }
  const applied = res.payload?.appliedTokenIds || [];
  pushLog(`自动应用成功: ${applied.length} 个 token 已写入 MARKET_TOKEN_IDS`);
  await refreshEnv();
  const appliedSet = new Set(applied.map(String));
  renderMarketCards(
    lastRecommendations.map((item) => ({
      ...item,
      activeStatus: appliedSet.has(String(item.tokenId)) ? '已应用' : item.activeStatus,
    })),
    appliedSet
  );
  syncButtonState();
}

async function applyManualMarkets() {
  if (!api) return;
  const ids = getCheckedTokenIds();
  if (ids.length === 0) {
    pushLog('请先勾选市场再应用');
    return;
  }
  const res = await api.setManualMarkets(ids);
  if (!res?.ok) {
    pushLog(`手动应用失败: ${res?.message || 'unknown'}`);
    return;
  }
  pushLog(`手动应用成功: ${res.tokenCount || ids.length} 个 token 已写入 MARKET_TOKEN_IDS`);
  await refreshEnv();
  const selectedSet = new Set(ids.map(String));
  renderMarketCards(
    lastRecommendations.map((item) => ({
      ...item,
      activeStatus: selectedSet.has(String(item.tokenId)) ? '已应用' : item.activeStatus,
    })),
    selectedSet
  );
  syncButtonState();
}

async function reloadManualMarkets() {
  if (!api) return;
  const res = await api.getManualMarkets();
  if (!res?.ok) {
    pushLog(`读取手动选择失败: ${res?.message || 'unknown'}`);
    return;
  }
  const selected = new Set((res.tokenIds || getConfiguredTokenIds()).map(String));
  renderMarketCards(lastRecommendations, selected);
  pushLog(`当前 MARKET_TOKEN_IDS 共 ${selected.size} 个`);
  syncButtonState();
}

if (startMMBtn) {
  startMMBtn.onclick = () =>
    runUiAction('startMM', async () => {
      if (!api) return;
      const r = await api.startMM();
      pushLog(r.ok ? '已启动做市' : `启动失败: ${r.message || 'unknown'}`);
      await refreshStatus();
    });
}

if (stopMMBtn) {
  stopMMBtn.onclick = () =>
    runUiAction('stopMM', async () => {
      if (!api) return;
      const r = await api.stopMM();
      pushLog(r.ok ? '已停止做市' : `停止失败: ${r.message || 'unknown'}`);
      await refreshStatus();
    });
}

if (tplPredictBtn) {
  tplPredictBtn.onclick = () =>
    runUiAction('tplPredict', async () => {
      if (!api) return;
      const r = await api.applyTemplate('predict');
      pushLog(r.ok ? '已应用 Predict 模板' : `模板失败: ${r.message || 'unknown'}`);
      await refreshEnv();
    });
}

if (tplPolymarketBtn) {
  tplPolymarketBtn.onclick = () =>
    runUiAction('tplPolymarket', async () => {
      if (!api) return;
      const r = await api.applyTemplate('polymarket');
      pushLog(r.ok ? '已应用 Polymarket 模板' : `模板失败: ${r.message || 'unknown'}`);
      await refreshEnv();
    });
}

if (scanMarketsBtn) {
  scanMarketsBtn.onclick = () => runUiAction('scanMarkets', scanMarkets);
}
if (applyAutoMarketsBtn) {
  applyAutoMarketsBtn.onclick = () => runUiAction('applyAutoMarkets', applyAutoMarkets);
}
if (applyManualMarketsBtn) {
  applyManualMarketsBtn.onclick = () => runUiAction('applyManualMarkets', applyManualMarkets);
}
if (reloadManualMarketsBtn) {
  reloadManualMarketsBtn.onclick = () => runUiAction('reloadManualMarkets', reloadManualMarkets);
}

if (getJwtBtn) {
  getJwtBtn.onclick = () =>
    runUiAction('getJwt', async () => {
      if (!api) return;
      if (getCurrentVenue() !== 'predict') {
        pushLog('当前 .env 不是 Predict 模式，JWT 获取按钮已跳过。');
        return;
      }
      pushLog('正在获取 JWT Token...');
      const r = await api.getJwt();
      if (r.ok) {
        pushLog('✅ JWT Token 获取成功！');
        await refreshEnv();
      } else {
        pushLog(`❌ 获取 JWT 失败: ${r.message || '未知错误'}`);
      }
    });
}

if (reloadEnvBtn) {
  reloadEnvBtn.onclick = () => runUiAction('reloadEnv', refreshEnv);
}
if (refreshPredictWalletBtn) {
  refreshPredictWalletBtn.onclick = () => runUiAction('refreshPredictWallet', async () => {
    await refreshPredictWalletStatus(true);
  });
}
if (refreshPolymarketPreflightBtn) {
  refreshPolymarketPreflightBtn.onclick = () => runUiAction('refreshPolymarketPreflight', async () => {
    await refreshPolymarketPreflight(true);
  });
}
if (saveEnvBtn) {
  saveEnvBtn.onclick = () =>
    runUiAction('saveEnv', async () => {
      if (!api) return;
      await api.writeEnv(envEditor.value || '');
      pushLog('配置已保存');
      await refreshEnv();
    });
}

if (predictAutoApprovals) {
  predictAutoApprovals.onchange = () => {
    envEditor.value = upsertEnv(envEditor.value || '', 'PREDICT_AUTO_SET_APPROVALS', predictAutoApprovals.checked ? 'true' : 'false');
    pushLog(`已${predictAutoApprovals.checked ? '开启' : '关闭'} Predict 自动授权，记得点击“保存配置”。`);
  };
}

if (selectAllMarkets) {
  selectAllMarkets.onchange = () => {
    const checks = Array.from(document.querySelectorAll('.market-check'));
    checks.forEach((el) => {
      el.checked = selectAllMarkets.checked;
    });
    updateSelectAllState();
    if (marketSummary) {
      marketSummary.textContent = `共 ${lastRecommendations.length} 个推荐，已勾选 ${getCheckedTokenIds().length} 个`;
    }
    syncButtonState();
  };
}

marketCardGrid?.addEventListener('change', (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.classList.contains('market-check')) {
    const card = target.closest('.market-card');
    if (card) card.classList.toggle('selected', target.checked);
    updateSelectAllState();
    if (marketSummary) {
      marketSummary.textContent = `共 ${lastRecommendations.length} 个推荐，已勾选 ${getCheckedTokenIds().length} 个`;
    }
    syncButtonState();
  }
});

marketCardGrid?.addEventListener('click', async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest('.market-link-btn');
  if (!button) return;
  const url = button.getAttribute('data-market-url') || '';
  if (!url) {
    pushLog('当前市场缺少可打开的链接');
    return;
  }
  if (api) {
    await api.openExternal(url);
  }
});

if (!api) {
  pushLog('错误: preload bridge 未注入，按钮不可用。请重启 app。');
  if (status) {
    status.textContent = '桥接失败';
    status.style.background = '#7f1d1d';
  }
} else {
  api.onLog((payload) => {
    const message = payload.message || '';
    const normalized = String(message);
    if (
      normalized.includes('Checking Predict approvals') ||
      normalized.includes('USDT allowance insufficient') ||
      normalized.includes('Insufficient collateral')
    ) {
      setApprovalStatus('待授权');
    }
    if (
      normalized.includes('Predict approvals ready') ||
      normalized.includes('Approvals set successfully') ||
      normalized.includes('授权成功')
    ) {
      setApprovalStatus('已就绪');
    }
    if (
      normalized.includes('授权失败') ||
      normalized.includes('allowance insufficient after auto-approval') ||
      normalized.includes('Failed to set approvals')
    ) {
      setApprovalStatus('授权失败');
    }
    pushLog(message);
  });
  api.onStatus((payload) => {
    mmRunning = Boolean(payload?.running);
    if (status) {
      status.textContent = mmRunning ? '运行中' : '未运行';
      status.style.background = mmRunning ? '#065f46' : '#334155';
    }
    renderRiskState(payload || {});
    syncButtonState();
  });
}

if (marketVenue) {
  marketVenue.onchange = () => {
    const nextVenue = String(marketVenue.value || 'predict').toLowerCase();
    if (lastRecommendations.length > 0 && lastRecommendationVenue && lastRecommendationVenue !== nextVenue) {
      lastRecommendations = [];
      renderMarketCards([], new Set(getConfiguredTokenIds()));
      pushLog(`已清空 ${lastRecommendationVenue} 的旧扫描结果，请重新扫描 ${nextVenue} 市场。`);
    }
    renderPolymarketSelectionSummary();
    syncButtonState();
  };
}

pushLog('UI 已加载，可开始操作。');
setApprovalStatus(approvalState);
renderMarketCards([]);
syncButtonState();
refreshEnv();
refreshStatus();

const LINKS = {
  linkPredict: 'https://predict.fun?ref=B0CE6',
  linkPolymarket: 'https://polymarket.com',
  linkX: 'https://x.com/ccjing_eth',
  linkTG: 'https://t.me/+VAhPSvs7jrxjYTY1',
};

Object.entries(LINKS).forEach(([id, url]) => {
  const el = document.getElementById(id);
  if (el) {
    el.onclick = async (e) => {
      e.preventDefault();
      if (api) await api.openExternal(url);
    };
  }
});
