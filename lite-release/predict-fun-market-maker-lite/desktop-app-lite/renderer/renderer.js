const envEditor = document.getElementById('envEditor');
const logs = document.getElementById('logs');
const status = document.getElementById('status');
const marketVenue = document.getElementById('marketVenue');
const scanCount = document.getElementById('scanCount');
const topCount = document.getElementById('topCount');
const marketTableBody = document.getElementById('marketTableBody');
const selectAllMarkets = document.getElementById('selectAllMarkets');
const api = window.liteApp;

let lastRecommendations = [];

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

function parseIds(raw) {
  return String(raw || '')
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function renderMarketTable(items, selected = new Set()) {
  marketTableBody.innerHTML = '';
  items.forEach((item) => {
    const tr = document.createElement('tr');
    const checked = selected.has(item.tokenId) ? 'checked' : '';
    tr.innerHTML = `
      <td><input type="checkbox" class="market-check" data-token="${item.tokenId}" ${checked} /></td>
      <td>${item.rank}</td>
      <td>${formatNum(item.score, 2)}</td>
      <td>${item.spreadPct == null ? '--' : formatNum(item.spreadPct, 3)}</td>
      <td>${item.bestBid == null ? '--' : formatNum(item.bestBid, 4)}</td>
      <td>${item.bestAsk == null ? '--' : formatNum(item.bestAsk, 4)}</td>
      <td>${item.bid1Shares == null ? '--' : formatNum(item.bid1Shares, 2)}</td>
      <td>${item.ask1Shares == null ? '--' : formatNum(item.ask1Shares, 2)}</td>
      <td>${item.bid2Shares == null ? '--' : formatNum(item.bid2Shares, 2)}</td>
      <td>${item.ask2Shares == null ? '--' : formatNum(item.ask2Shares, 2)}</td>
      <td>${item.l1NotionalUsd == null ? '--' : formatNum(item.l1NotionalUsd, 2)}</td>
      <td>${item.l2NotionalUsd == null ? '--' : formatNum(item.l2NotionalUsd, 2)}</td>
      <td>${item.tokenId}</td>
      <td class="question" title="${item.question || ''}">${item.question || ''}</td>
    `;
    marketTableBody.appendChild(tr);
  });
}

function getCheckedTokenIds() {
  return Array.from(document.querySelectorAll('.market-check:checked')).map((el) => el.dataset.token).filter(Boolean);
}

async function refreshEnv() {
  if (!api || !envEditor) return;
  envEditor.value = await api.readEnv();
}

async function refreshStatus() {
  if (!api || !status) return;
  const s = await api.status();
  status.textContent = s.running ? '运行中' : '未运行';
  status.style.background = s.running ? '#065f46' : '#334155';
}

async function scanMarkets() {
  if (!api) return;
  const venue = marketVenue.value === 'probable' ? 'probable' : 'predict';
  const scan = Math.max(10, Number(scanCount.value || 80));
  const top = Math.max(5, Number(topCount.value || 30));
  pushLog(`开始扫描市场 venue=${venue} scan=${scan} top=${top}`);
  const res = await api.scanMarkets(venue, top, scan);
  if (!res?.ok) {
    const msg = res?.message || 'unknown';
    pushLog(`市场扫描失败: ${msg}`);
    if (String(msg).includes('ENOTFOUND')) {
      pushLog('网络解析失败：请检查网络/DNS，或在 .env 中确认 PROBABLE_MARKET_API_URL / API_BASE_URL 可访问。');
    }
    return;
  }
  const payload = res.payload || {};
  lastRecommendations = Array.isArray(payload.recommendations) ? payload.recommendations : [];
  renderMarketTable(lastRecommendations);
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
  const venue = marketVenue.value === 'probable' ? 'probable' : 'predict';
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
  renderMarketTable(lastRecommendations, new Set(applied));
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
  pushLog(`手动应用成功: ${ids.length} 个 token 已写入 MARKET_TOKEN_IDS`);
  await refreshEnv();
}

async function reloadManualMarkets() {
  if (!api) return;
  const res = await api.getManualMarkets();
  if (!res?.ok) {
    pushLog(`读取手动选择失败: ${res?.message || 'unknown'}`);
    return;
  }
  const selected = new Set(res.tokenIds || parseIds(envEditor.value.match(/^MARKET_TOKEN_IDS=(.*)$/m)?.[1] || ''));
  renderMarketTable(lastRecommendations, selected);
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

document.getElementById('tplProbable').onclick = async () => {
  if (!api) return;
  const r = await api.applyTemplate('probable');
  pushLog(r.ok ? '已应用 Probable 模板' : `模板失败: ${r.message || 'unknown'}`);
  await refreshEnv();
};

document.getElementById('scanMarkets').onclick = scanMarkets;
document.getElementById('applyAutoMarkets').onclick = applyAutoMarkets;
document.getElementById('applyManualMarkets').onclick = applyManualMarkets;
document.getElementById('reloadManualMarkets').onclick = reloadManualMarkets;

document.getElementById('reloadEnv').onclick = refreshEnv;
document.getElementById('saveEnv').onclick = async () => {
  if (!api) return;
  await api.writeEnv(envEditor.value || '');
  pushLog('配置已保存');
};

selectAllMarkets.onchange = () => {
  const checks = Array.from(document.querySelectorAll('.market-check'));
  checks.forEach((el) => {
    el.checked = selectAllMarkets.checked;
  });
};

if (!api) {
  pushLog('错误: preload bridge 未注入，按钮不可用。请重启 app。');
  if (status) {
    status.textContent = '桥接失败';
    status.style.background = '#7f1d1d';
  }
} else {
  api.onLog((payload) => {
    pushLog(payload.message || '');
  });
  api.onStatus(() => refreshStatus());
}

pushLog('UI 已加载，可开始操作。');
refreshEnv();
refreshStatus();
