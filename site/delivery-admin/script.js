const eventLabels = { eew: '緊急地震速報', zisin: '地震情報', tunami: '津波情報', keiho: '警報・注意報', kisyo: '気象情報', kisyo2: '気象情報（補助）', kazan: '火山情報', eew_sind: '推定震度', sub: '補助情報', unknown: 'その他' };
document.addEventListener('DOMContentLoaded', () => { document.getElementById('refresh-btn').addEventListener('click', load); document.getElementById('period').addEventListener('change', load); load(); });

async function load() {
    setStatus('AWSの配信記録を集計中…', 'info');
    try {
        const period = document.getElementById('period').value;
        const response = await fetch(`/site/delivery-admin/api/summary?period=${encodeURIComponent(period)}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        const data = await response.json().catch(() => ({})); if (!response.ok || data.success !== true) throw new Error(data.message || `取得に失敗しました（HTTP ${response.status}）。`);
        document.getElementById('admin-email').textContent = data.admin || '';
        render(data.statistics); setStatus(`最終取得: ${formatDate(data.observedAt)}`, 'success');
    } catch (error) { setStatus(error.message, 'error'); }
}

function render(stats) {
    const totals = stats.totals || {};
    renderCards('totals', [['イベント数', totals.events], ['配信対象数', totals.targets], ['正常配信数', totals.normal], ['エラー数', totals.errors], ['重大エラー', totals.seriousErrors], ['最大処理時間', `${number(totals.maxWorkerSeconds)}秒`]]);
    renderCards('regions', Object.entries(stats.byRegion || {}).map(([region, count]) => [region, count]));
    document.getElementById('coverage').textContent = stats.coverage?.oldestEpoch ? `${formatEpoch(stats.coverage.oldestEpoch)} ～ ${formatEpoch(stats.coverage.latestEpoch)}` : '対象データはありません。';
    const source = stats.source?.table ? `取得元: ${stats.source.table} (${stats.source.region || 'region不明'})` : '';
    document.getElementById('retention-note').textContent = [stats.retentionNote, source].filter(Boolean).join(' / ');
    const eventBody = document.getElementById('event-types'); eventBody.replaceChildren();
    for (const item of stats.byEventType || []) eventBody.append(row([eventLabels[item.eventType] || item.eventType, item.events, item.targets, item.normal, item.errors, item.seriousErrors, `${number(item.maxLatencyMs)} ms`], [1, 2, 3, 4, 5, 6]));
    if (!(stats.byEventType || []).length) eventBody.append(emptyRow(7));
    const recent = document.getElementById('recent'); recent.replaceChildren();
    for (const item of stats.recent || []) recent.append(row([formatEpoch(item.updatedEpoch), eventLabels[item.eventType] || item.eventType, item.ownerRegion || '不明', item.targets, item.normal, item.errors, item.logsCollected ? '収集済み' : '未収集'], [3, 4, 5]));
    if (!(stats.recent || []).length) recent.append(emptyRow(7));
}

function renderCards(id, items) { const container = document.getElementById(id); container.replaceChildren(); for (const [label, value] of items) { const card = el('article', 'metric-card'); card.append(el('span', '', label), el('strong', '', typeof value === 'string' ? value : number(value))); container.append(card); } }
function row(values, numeric = []) { const tr = document.createElement('tr'); values.forEach((value, index) => { const td = el('td', numeric.includes(index) ? 'number' : '', typeof value === 'number' ? number(value) : String(value ?? '')); if ((index === 4 || index === 5) && Number(value) > 0) td.classList.add('error-value'); tr.append(td); }); return tr; }
function emptyRow(columns) { const tr = document.createElement('tr'); const td = el('td', '', '対象データはありません。'); td.colSpan = columns; tr.append(td); return tr; }
function number(value) { return new Intl.NumberFormat('ja-JP').format(Number(value || 0)); }
function formatEpoch(value) { return formatDate(new Date(Number(value) * 1000).toISOString()); }
function formatDate(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'medium' }).format(date) : '不明'; }
function setStatus(message, type) { const target = document.getElementById('global-status'); target.textContent = message; target.className = type ? `status ${type}` : 'status'; }
function el(tag, className = '', text = '') { const node = document.createElement(tag); if (className) node.className = className; node.textContent = text; return node; }
