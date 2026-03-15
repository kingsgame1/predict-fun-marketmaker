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
const riskStatus = document.getElementById('riskStatus');
const riskUpdatedAt = document.getElementById('riskUpdatedAt');
const riskSummary = document.getElementById('riskSummary');
const riskList = document.getElementById('riskList');
const api = window.liteApp;

let lastRecommendations = [];
let approvalState = '待检查';

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
  pushLog(`未处理异常: ${event.reason || 'unknown'}`);
});

function formatNum(value, digits = 2) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '--';
}

function formatPct(value, digits = 2) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(digits)}%` : '--';
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
    while (nextLines.length > 0 && nextLines[nextLines.length - 1] === '') {
      nextLines.pop();
    }
    nextLines.push(`${key}=${value}`);
  }
  return `${nextLines.join('\n').replace(/\n*$/g, '')}\n`;
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
  if (!payload?.predictAccountAddress) {
    warnings.push('未配置 PREDICT_ACCOUNT_ADDRESS，必须填写 Predict 网站账户里的 deposit address。');
  }
  if (payload?.suspiciousPredictAccount) {
    warnings.push('PREDICT_ACCOUNT_ADDRESS 与签名钱包地址相同，疑似填错。');
  }
  if (balance <= 0) {
    warnings.push('Predict 账号 USDT 余额为 0，当前无法安全启动做市。');
  }
  if (!approvalReady) {
    warnings.push('Allowance 未全部就绪，首次交易前需要自动授权或手动授权。');
  }
  if (walletWarning) {
    walletWarning.textContent = warnings.join(' ');
  }
  if (warnings.length === 0) {
    setWalletStatusBadge('已就绪', 'ok');
  } else if (balance > 0 && payload?.predictAccountAddress) {
    setWalletStatusBadge('需处理', 'warn');
  } else {
    setWalletStatusBadge('异常', 'error');
  }
}

async function refreshPredictWalletStatus(forceLog = false) {
  if (!api) return;
  const envMap = parseEnvMap(envEditor?.value || '');
  const venue = (envMap.get('MM_VENUE') || 'predict').toLowerCase();
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
  if (forceLog) {
    pushLog(
      `Predict 余额检查完成: account=${res.payload?.predictAccountAddress || '(未配置)'} balance=${Number(res.payload?.balance || 0).toFixed(6)} approvals=${res.payload?.approvalReady ? 'ready' : 'pending'}`
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

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarketCards(items, selected = new Set()) {
  if (!marketCardGrid) return;
  marketCardGrid.innerHTML = '';

  if (!items.length) {
    marketCardGrid.innerHTML = '<div class="market-empty">暂无推荐结果。先扫描市场，再根据卡片里的盘口质量决定是否应用。</div>';
    if (marketSummary) marketSummary.textContent = '暂无推荐结果';
    updateSelectAllState();
    return;
  }

  const appliedCount = items.filter((item) => item.activeStatus === '已应用').length;
  if (marketSummary) {
    marketSummary.textContent = `共 ${items.length} 个推荐，已应用 ${appliedCount} 个，当前勾选 ${selected.size} 个`;
  }

  items.forEach((item) => {
    const card = document.createElement('article');
    const isSelected = selected.has(item.tokenId);
    const isApplied = item.activeStatus === '已应用';
    card.className = `market-card${isSelected ? ' selected' : ''}${isApplied ? ' applied' : ''}`;

    const reasons = Array.isArray(item.reasons) ? item.reasons.slice(0, 4) : [];
    const supportRatio = item.supportRatio == null ? '--' : formatNum(item.supportRatio, 3);
    const gap = item.maxLevelGap == null ? '--' : `${formatNum(item.maxLevelGap, 4)}$`;
    const symmetry = item.symmetry == null ? '--' : formatNum(item.symmetry, 3);
    const centerScore = item.centerScore == null ? '--' : formatNum(item.centerScore, 3);
    const scoreText = item.score == null ? '--' : formatNum(item.score, 2);
    const bid2Price = item.bid2Price == null ? '--' : formatNum(item.bid2Price, 4);
    const ask2Price = item.ask2Price == null ? '--' : formatNum(item.ask2Price, 4);
    const riskPenalty = item.recentRiskPenalty == null ? null : Number(item.recentRiskPenalty);
    const riskChip =
      riskPenalty && riskPenalty > 0
        ? `<span class="status-chip" style="background:#7f1d1d;border-color:#b91c1c;">近期风险 -${escapeHtml(formatNum(riskPenalty, 1))}</span>`
        : '';

    const incentivePanels = [];
    if (item.rewardEnabled) {
      incentivePanels.push(`
        <div class="metric-panel incentive-panel">
          <div class="metric-label">流动性激励</div>
          <div class="metric-value">日速率 ${item.rewardDailyRate == null ? '--' : formatNum(item.rewardDailyRate, 0)}</div>
          <div class="metric-subvalue">最小单边 ${item.rewardMinSize == null ? '--' : formatNum(item.rewardMinSize, 0)} 股 / 最大奖励价差 ${item.rewardMaxSpreadCents == null ? '--' : formatNum(item.rewardMaxSpreadCents, 2)}¢</div>
          <div class="metric-subvalue">激励适配度 ${item.rewardFitScore == null ? '--' : formatPct(Number(item.rewardFitScore) * 100, 0)} / 排队倍数 ${item.rewardCrowdingMultiple == null ? '--' : `${formatNum(item.rewardCrowdingMultiple, 2)}x`}</div>
          <div class="metric-subvalue">最低双边资金 ${item.rewardCapitalEstimateUsd == null ? '--' : `$${formatNum(item.rewardCapitalEstimateUsd, 2)}`} / 奖励效率 ${item.rewardEfficiency == null ? '--' : `${formatPct(Number(item.rewardEfficiency) * 100, 2)}/日`}</div>
          <div class="metric-subvalue">队列耗时 ${item.rewardQueueHours == null ? '--' : `${formatNum(item.rewardQueueHours, 2)}h`} / 流速倍率 ${item.rewardFlowToQueuePerHour == null ? '--' : `${formatNum(item.rewardFlowToQueuePerHour, 2)}x/h`}</div>
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
        <span class="quote-chip">L1双边 $${item.l1NotionalUsd == null ? '--' : formatNum(item.l1NotionalUsd, 2)}</span>
        <span class="quote-chip ask">L2双边 $${item.l2NotionalUsd == null ? '--' : formatNum(item.l2NotionalUsd, 2)}</span>
      </div>
      <div class="market-reasons">${reasons.length ? reasons.map((reason) => `<span class="reason-chip">${escapeHtml(reason)}</span>`).join('') : '<span class="reason-chip">暂无推荐说明</span>'}</div>
      ${item.recentRiskReason ? `<div class="market-token">风险记忆: ${escapeHtml(item.recentRiskReason)}</div>` : ''}
      <div class="market-token">Token: ${escapeHtml(item.tokenId)}</div>
    `;
    marketCardGrid.appendChild(card);
  });

  updateSelectAllState();
}

async function refreshEnv() {
  if (!api || !envEditor) return;
  envEditor.value = await api.readEnv();
  const envMap = parseEnvMap(envEditor.value);
  if (predictAutoApprovals) {
    predictAutoApprovals.checked = (envMap.get('PREDICT_AUTO_SET_APPROVALS') || 'true').toLowerCase() !== 'false';
  }
  await refreshPredictWalletStatus();
}

async function refreshStatus() {
  if (!api || !status) return;
  const s = await api.status();
  status.textContent = s.running ? '运行中' : '未运行';
  status.style.background = s.running ? '#065f46' : '#334155';
  renderRiskState(s);
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
      pushLog('网络解析失败：请检查网络/DNS，或在 .env 中确认 POLYMARKET_GAMMA_URL / API_BASE_URL 可访问。');
    }
    return;
  }
  const payload = res.payload || {};
  lastRecommendations = Array.isArray(payload.recommendations) ? payload.recommendations : [];
  renderMarketCards(lastRecommendations);
  pushLog(`扫描完成: valid=${payload.validMarkets || 0}, recommendations=${lastRecommendations.length}`);
  if (lastRecommendations.length === 0) {
    const tip =
      venue === 'predict'
        ? '未找到可推荐市场。请先确认 API_KEY 已填写，或提高 scan/top 后重试。'
        : '未找到可推荐市场。请提高 scan/top，或切换到流动性更高时段。';
    pushLog(tip);
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
  const appliedSet = new Set(applied);
  renderMarketCards(
    lastRecommendations.map((item) => ({
      ...item,
      activeStatus: appliedSet.has(item.tokenId) ? '已应用' : item.activeStatus,
    })),
    appliedSet
  );
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
  const selectedSet = new Set(ids);
  renderMarketCards(
    lastRecommendations.map((item) => ({
      ...item,
      activeStatus: selectedSet.has(item.tokenId) ? '已应用' : item.activeStatus,
    })),
    selectedSet
  );
}

async function reloadManualMarkets() {
  if (!api) return;
  const res = await api.getManualMarkets();
  if (!res?.ok) {
    pushLog(`读取手动选择失败: ${res?.message || 'unknown'}`);
    return;
  }
  const selected = new Set(res.tokenIds || parseIds(envEditor.value.match(/^MARKET_TOKEN_IDS=(.*)$/m)?.[1] || ''));
  renderMarketCards(lastRecommendations, selected);
  pushLog(`当前 MARKET_TOKEN_IDS 共 ${selected.size} 个`);
}

document.getElementById('startMM').onclick = async () => {
  if (!api) return;
  const r = await api.startMM();
  pushLog(r.ok ? '已启动做市' : `启动失败: ${r.message || 'unknown'}`);
  refreshStatus();
};

document.getElementById('stopMM').onclick = async () => {
  if (!api) return;
  const r = await api.stopMM();
  pushLog(r.ok ? '已停止做市' : `停止失败: ${r.message || 'unknown'}`);
  refreshStatus();
};

document.getElementById('tplPredict').onclick = async () => {
  if (!api) return;
  const r = await api.applyTemplate('predict');
  pushLog(r.ok ? '已应用 Predict 模板' : `模板失败: ${r.message || 'unknown'}`);
  await refreshEnv();
};

document.getElementById('tplPolymarket').onclick = async () => {
  if (!api) return;
  const r = await api.applyTemplate('polymarket');
  pushLog(r.ok ? '已应用 Polymarket 模板' : `模板失败: ${r.message || 'unknown'}`);
  await refreshEnv();
};

document.getElementById('scanMarkets').onclick = scanMarkets;
document.getElementById('applyAutoMarkets').onclick = applyAutoMarkets;
document.getElementById('applyManualMarkets').onclick = applyManualMarkets;
document.getElementById('reloadManualMarkets').onclick = reloadManualMarkets;

document.getElementById('getJwt').onclick = async () => {
  if (!api) return;
  pushLog('正在获取 JWT Token...');
  const r = await api.getJwt();
  if (r.ok) {
    pushLog('✅ JWT Token 获取成功！');
    await refreshEnv();
  } else {
    pushLog(`❌ 获取 JWT 失败: ${r.message || '未知错误'}`);
  }
};

document.getElementById('reloadEnv').onclick = refreshEnv;
document.getElementById('refreshPredictWallet').onclick = async () => {
  await refreshPredictWalletStatus(true);
};
document.getElementById('saveEnv').onclick = async () => {
  if (!api) return;
  await api.writeEnv(envEditor.value || '');
  pushLog('配置已保存');
  await refreshPredictWalletStatus();
};

if (predictAutoApprovals) {
  predictAutoApprovals.onchange = () => {
    envEditor.value = upsertEnv(
      envEditor.value || '',
      'PREDICT_AUTO_SET_APPROVALS',
      predictAutoApprovals.checked ? 'true' : 'false'
    );
    pushLog(`已${predictAutoApprovals.checked ? '开启' : '关闭'} Predict 自动授权，记得点击“保存配置”。`);
  };
}

selectAllMarkets.onchange = () => {
  const checks = Array.from(document.querySelectorAll('.market-check'));
  checks.forEach((el) => {
    el.checked = selectAllMarkets.checked;
  });
  updateSelectAllState();
  if (marketSummary) {
    marketSummary.textContent = `共 ${lastRecommendations.length} 个推荐，已勾选 ${getCheckedTokenIds().length} 个`;
  }
};

marketCardGrid?.addEventListener('change', (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.classList.contains('market-check')) {
    const card = target.closest('.market-card');
    if (card) card.classList.toggle('selected', target.checked);
    updateSelectAllState();
    if (marketSummary) {
      marketSummary.textContent = `共 ${lastRecommendations.length} 个推荐，已勾选 ${getCheckedTokenIds().length} 个`;
    }
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
    if (status) {
      status.textContent = payload?.running ? '运行中' : '未运行';
      status.style.background = payload?.running ? '#065f46' : '#334155';
    }
    renderRiskState(payload || {});
  });
}

pushLog('UI 已加载，可开始操作。');
setApprovalStatus(approvalState);
renderMarketCards([]);
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
      if (api) {
        await api.openExternal(url);
      }
    };
  }
});
 + formatNum(item.volume24h, 0) + '</div>\n          <div class="metric-subvalue">用于判断当天活跃度，不单独决定是否推荐</div>\n        </div>\n      ');
    }
    const incentivePanels = [];
    if (item.rewardEnabled) {
      incentivePanels.push('\n        <div class="metric-panel incentive-panel">\n          <div class="metric-label">流动性激励</div>\n          <div class="metric-value">日速率 ' + (item.rewardDailyRate == null ? '--' : formatNum(item.rewardDailyRate, 0)) + '</div>\n          <div class="metric-subvalue">最小单边 ' + (item.rewardMinSize == null ? '--' : formatNum(item.rewardMinSize, 0)) + ' 股 / 最大奖励价差 ' + (item.rewardMaxSpreadCents == null ? '--' : formatNum(item.rewardMaxSpreadCents, 2)) + '¢</div>\n          <div class="metric-subvalue">激励适配度 ' + (item.rewardFitScore == null ? '--' : formatPct(Number(item.rewardFitScore) * 100, 0)) + ' / 排队倍数 ' + (item.rewardCrowdingMultiple == null ? '--' : formatNum(item.rewardCrowdingMultiple, 2) + 'x') + '</div>\n          <div class="metric-subvalue">最低双边资金 ' + (item.rewardCapitalEstimateUsd == null ? '--' : '$' + formatNum(item.rewardCapitalEstimateUsd, 2)) + ' / 奖励效率 ' + (item.rewardEfficiency == null ? '--' : formatPct(Number(item.rewardEfficiency) * 100, 2) + '/日') + '</div>\n          <div class="metric-subvalue">队列耗时 ' + (item.rewardQueueHours == null ? '--' : formatNum(item.rewardQueueHours, 2) + 'h') + ' / 流速倍率 ' + (item.rewardFlowToQueuePerHour == null ? '--' : formatNum(item.rewardFlowToQueuePerHour, 2) + 'x/h') + '</div>\n        </div>\n      ');
    }

    card.innerHTML = `
      <div class="market-card-header">
        <div>
          <div class="market-topline">
            <span class="rank-chip">#${escapeHtml(item.rank)}</span>
            <span class="score-chip">Score ${escapeHtml(scoreText)}</span>
            <span class="status-chip">${escapeHtml(item.activeStatus || '未应用')}</span>
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
      ${liquidityPanels.length ? `<div class="market-liquidity-row">${liquidityPanels.join('')}</div>` : ''}
      ${statsPanels.length ? `<div class="market-stats-row">${statsPanels.join('')}</div>` : ''}
      <div class="market-quality-row">
        <span class="metric-chip">对称度 ${escapeHtml(symmetry)}</span>
        <span class="metric-chip">中心度 ${escapeHtml(centerScore)}</span>
        <span class="quote-chip">L1双边 $${item.l1NotionalUsd == null ? '--' : formatNum(item.l1NotionalUsd, 2)}</span>
        <span class="quote-chip ask">L2双边 $${item.l2NotionalUsd == null ? '--' : formatNum(item.l2NotionalUsd, 2)}</span>
      </div>
      <div class="market-reasons">${reasons.length ? reasons.map((reason) => `<span class="reason-chip">${escapeHtml(reason)}</span>`).join('') : '<span class="reason-chip">暂无推荐说明</span>'}</div>
      <div class="market-token">Token: ${escapeHtml(item.tokenId)}</div>
    `;
    marketCardGrid.appendChild(card);
  });

  updateSelectAllState();
}

async function refreshEnv() {
  if (!api || !envEditor) return;
  envEditor.value = await api.readEnv();
  const envMap = parseEnvMap(envEditor.value);
  if (predictAutoApprovals) {
    predictAutoApprovals.checked = (envMap.get('PREDICT_AUTO_SET_APPROVALS') || 'true').toLowerCase() !== 'false';
  }
  await refreshPredictWalletStatus();
}

async function refreshStatus() {
  if (!api || !status) return;
  const s = await api.status();
  status.textContent = s.running ? '运行中' : '未运行';
  status.style.background = s.running ? '#065f46' : '#334155';
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
      pushLog('网络解析失败：请检查网络/DNS，或在 .env 中确认 POLYMARKET_GAMMA_URL / API_BASE_URL 可访问。');
    }
    return;
  }
  const payload = res.payload || {};
  lastRecommendations = Array.isArray(payload.recommendations) ? payload.recommendations : [];
  renderMarketCards(lastRecommendations);
  pushLog(`扫描完成: valid=${payload.validMarkets || 0}, recommendations=${lastRecommendations.length}`);
  if (lastRecommendations.length === 0) {
    const tip =
      venue === 'predict'
        ? '未找到可推荐市场。请先确认 API_KEY 已填写，或提高 scan/top 后重试。'
        : '未找到可推荐市场。请提高 scan/top，或切换到流动性更高时段。';
    pushLog(tip);
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
  const appliedSet = new Set(applied);
  renderMarketCards(
    lastRecommendations.map((item) => ({
      ...item,
      activeStatus: appliedSet.has(item.tokenId) ? '已应用' : item.activeStatus,
    })),
    appliedSet
  );
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
  const selectedSet = new Set(ids);
  renderMarketCards(
    lastRecommendations.map((item) => ({
      ...item,
      activeStatus: selectedSet.has(item.tokenId) ? '已应用' : item.activeStatus,
    })),
    selectedSet
  );
}

async function reloadManualMarkets() {
  if (!api) return;
  const res = await api.getManualMarkets();
  if (!res?.ok) {
    pushLog(`读取手动选择失败: ${res?.message || 'unknown'}`);
    return;
  }
  const selected = new Set(res.tokenIds || parseIds(envEditor.value.match(/^MARKET_TOKEN_IDS=(.*)$/m)?.[1] || ''));
  renderMarketCards(lastRecommendations, selected);
  pushLog(`当前 MARKET_TOKEN_IDS 共 ${selected.size} 个`);
}

document.getElementById('startMM').onclick = async () => {
  if (!api) return;
  const r = await api.startMM();
  pushLog(r.ok ? '已启动做市' : `启动失败: ${r.message || 'unknown'}`);
  refreshStatus();
};

document.getElementById('stopMM').onclick = async () => {
  if (!api) return;
  const r = await api.stopMM();
  pushLog(r.ok ? '已停止做市' : `停止失败: ${r.message || 'unknown'}`);
  refreshStatus();
};

document.getElementById('tplPredict').onclick = async () => {
  if (!api) return;
  const r = await api.applyTemplate('predict');
  pushLog(r.ok ? '已应用 Predict 模板' : `模板失败: ${r.message || 'unknown'}`);
  await refreshEnv();
};

document.getElementById('tplPolymarket').onclick = async () => {
  if (!api) return;
  const r = await api.applyTemplate('polymarket');
  pushLog(r.ok ? '已应用 Polymarket 模板' : `模板失败: ${r.message || 'unknown'}`);
  await refreshEnv();
};

document.getElementById('scanMarkets').onclick = scanMarkets;
document.getElementById('applyAutoMarkets').onclick = applyAutoMarkets;
document.getElementById('applyManualMarkets').onclick = applyManualMarkets;
document.getElementById('reloadManualMarkets').onclick = reloadManualMarkets;

document.getElementById('getJwt').onclick = async () => {
  if (!api) return;
  pushLog('正在获取 JWT Token...');
  const r = await api.getJwt();
  if (r.ok) {
    pushLog('✅ JWT Token 获取成功！');
    await refreshEnv();
  } else {
    pushLog(`❌ 获取 JWT 失败: ${r.message || '未知错误'}`);
  }
};

document.getElementById('reloadEnv').onclick = refreshEnv;
document.getElementById('refreshPredictWallet').onclick = async () => {
  await refreshPredictWalletStatus(true);
};
document.getElementById('saveEnv').onclick = async () => {
  if (!api) return;
  await api.writeEnv(envEditor.value || '');
  pushLog('配置已保存');
  await refreshPredictWalletStatus();
};

if (predictAutoApprovals) {
  predictAutoApprovals.onchange = () => {
    envEditor.value = upsertEnv(
      envEditor.value || '',
      'PREDICT_AUTO_SET_APPROVALS',
      predictAutoApprovals.checked ? 'true' : 'false'
    );
    pushLog(`已${predictAutoApprovals.checked ? '开启' : '关闭'} Predict 自动授权，记得点击“保存配置”。`);
  };
}

selectAllMarkets.onchange = () => {
  const checks = Array.from(document.querySelectorAll('.market-check'));
  checks.forEach((el) => {
    el.checked = selectAllMarkets.checked;
  });
  updateSelectAllState();
  if (marketSummary) {
    marketSummary.textContent = `共 ${lastRecommendations.length} 个推荐，已勾选 ${getCheckedTokenIds().length} 个`;
  }
};

marketCardGrid?.addEventListener('change', (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.classList.contains('market-check')) {
    const card = target.closest('.market-card');
    if (card) card.classList.toggle('selected', target.checked);
    updateSelectAllState();
    if (marketSummary) {
      marketSummary.textContent = `共 ${lastRecommendations.length} 个推荐，已勾选 ${getCheckedTokenIds().length} 个`;
    }
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
  api.onStatus(() => refreshStatus());
}

pushLog('UI 已加载，可开始操作。');
setApprovalStatus(approvalState);
renderMarketCards([]);
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
      if (api) {
        await api.openExternal(url);
      }
    };
  }
});
