const categoryLabels = { maintenance: 'メンテナンス情報', outage: '障害・重要情報', update: 'アップデート情報' };
const statusLabels = { draft: '下書き', queuing: 'Queue登録中', sending: '配信中', completed: '完了', cancelled: '取消済み' };
let summaryState = null;
let audienceTimer = 0;

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('refresh-btn').addEventListener('click', loadSummary);
    document.getElementById('campaign-form').addEventListener('submit', createCampaign);
    document.getElementById('preview-btn').addEventListener('click', renderPreview);
    document.getElementById('subject').addEventListener('input', renderPreview);
    document.getElementById('body').addEventListener('input', renderPreview);
    document.getElementById('select-all-servers').addEventListener('click', () => setAllServers(true));
    document.getElementById('clear-all-servers').addEventListener('click', () => setAllServers(false));
    document.getElementById('campaign-form').addEventListener('change', scheduleAudiencePreview);
    loadSummary();
});

async function loadSummary() {
    setStatus('読み込み中…', 'info');
    try {
        summaryState = await request('/site/discord-admin/api/summary');
        document.getElementById('admin-email').textContent = summaryState.admin;
        renderStats(); renderSlots(); renderServers(); renderCampaigns(); scheduleAudiencePreview();
        setStatus('', '');
    } catch (error) { setStatus(error.message, 'error'); }
}

function renderStats() {
    const servers = summaryState.approvedServers || [];
    const channels = servers.reduce((sum, server) => sum + Number(server.channelCount || 0), 0);
    const sent = (summaryState.campaigns || []).reduce((sum, campaign) => sum + Number(campaign.sentCount || 0), 0);
    const items = [['許可済みサーバー', servers.length], ['登録チャンネル', channels], ['直近30配信の送信済み', sent]];
    const container = document.getElementById('discord-stats'); container.replaceChildren();
    for (const [label, value] of items) { const card = el('article', 'stat-card'); card.append(el('span', 'stat-label', label), el('strong', 'stat-value', String(value))); container.append(card); }
}

function renderSlots() {
    const container = document.getElementById('delivery-slots'); container.replaceChildren();
    for (const slot of summaryState.deliveryCatalog || []) {
        const label = el('label', 'delivery-slot'); const input = document.createElement('input'); input.type = 'checkbox'; input.name = 'delivery-slots'; input.value = slot.id; input.checked = slot.id === 'DPI_Bot通知';
        const text = el('span', '', slot.label); text.append(el('small', `slot-status ${slot.status}`, slot.status)); label.append(input, text); container.append(label);
    }
}

function renderServers() {
    const container = document.getElementById('approved-servers'); container.replaceChildren();
    const servers = summaryState.approvedServers || [];
    if (!servers.length) { container.append(el('p', 'empty', '許可済みサーバーはありません。')); return; }
    for (const server of servers) { const label = el('label', 'delivery-slot'); const input = document.createElement('input'); input.type = 'checkbox'; input.name = 'server-ids'; input.value = server.id; const text = el('span', '', server.name || server.id); text.append(el('small', 'slot-status active', `${server.channelCount}ch`)); label.append(input, text); container.append(label); }
}

function renderCampaigns() {
    const container = document.getElementById('campaign-list'); container.replaceChildren();
    if (!summaryState.campaigns.length) { container.append(el('p', 'empty', 'Discord配信履歴はまだありません。')); return; }
    for (const campaign of summaryState.campaigns) {
        const card = el('article', 'campaign-card'); const badges = el('div', 'badges');
        for (const category of campaign.categories || []) badges.append(el('span', 'badge category', categoryLabels[category] || category));
        badges.append(el('span', `badge status ${campaign.status}`, statusLabels[campaign.status] || campaign.status));
        card.append(badges, el('h3', '', campaign.subject), el('pre', 'campaign-body', campaign.body));
        const metrics = el('div', 'campaign-metrics'); for (const [label, value] of [['対象', campaign.recipientCount], ['送信済み', campaign.sentCount], ['残り', campaign.remainingCount], ['失敗', campaign.failedCount]]) metrics.append(el('span', '', `${label}: ${value}`)); card.append(metrics);
        const names = (campaign.targetServerIds || []).map(serverName).join('・'); card.append(el('p', 'campaign-meta', `対象配信枠: ${(campaign.deliverySlots || []).map(slotName).join('・')} / サーバー: ${names}`));
        const actions = el('div', 'campaign-actions');
        if (['draft', 'queuing'].includes(campaign.status)) { const button = el('button', 'primary-btn', '配信を開始'); button.type = 'button'; button.addEventListener('click', () => sendCampaign(campaign, button)); actions.append(button); }
        if (['draft', 'queuing', 'sending'].includes(campaign.status)) { const button = el('button', 'danger-btn', '未送信分を取消'); button.type = 'button'; button.addEventListener('click', () => cancelCampaign(campaign, button)); actions.append(button); }
        card.append(actions); container.append(card);
    }
}

async function createCampaign(event) {
    event.preventDefault(); const button = document.getElementById('save-btn'); button.disabled = true;
    try {
        const payload = selectionPayload();
        if (!payload.categories.length || !payload.deliverySlots.length || !payload.targetServerIds.length) throw new Error('カテゴリ・配信枠・サーバーをそれぞれ1つ以上選択してください。');
        const result = await request('/site/discord-admin/api/campaigns', { method: 'POST', body: JSON.stringify(payload) });
        document.getElementById('campaign-form').reset(); renderPreview(); setStatus(`下書きを保存しました。配信ID: ${result.campaign.id}`, 'success'); await loadSummary();
    } catch (error) { setStatus(error.message, 'error'); } finally { button.disabled = false; }
}

async function sendCampaign(campaign, button) {
    if (!window.confirm(`「${campaign.subject}」をDiscordへ配信します。送信済み投稿は取り消せません。`)) return;
    button.disabled = true;
    try { const result = await request(`/site/discord-admin/api/campaigns/${campaign.id}/send`, { method: 'POST', body: JSON.stringify({ confirmation: campaign.id }) }); setStatus(`${result.queued}件をQueueへ登録しました。`, 'success'); await loadSummary(); } catch (error) { setStatus(error.message, 'error'); button.disabled = false; }
}

async function cancelCampaign(campaign, button) {
    if (!window.confirm('未送信分を取り消しますか？')) return; button.disabled = true;
    try { await request(`/site/discord-admin/api/campaigns/${campaign.id}/cancel`, { method: 'POST', body: JSON.stringify({ confirmation: campaign.id }) }); setStatus('未送信分を取り消しました。', 'success'); await loadSummary(); } catch (error) { setStatus(error.message, 'error'); button.disabled = false; }
}

function selectionPayload() { return { categories: checked('campaign-categories'), recipientGroups: ['discord_approved'], deliverySlots: checked('delivery-slots'), targetServerIds: checked('server-ids'), subject: document.getElementById('subject').value, body: document.getElementById('body').value }; }
function checked(name) { return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value); }
function setAllServers(value) { for (const input of document.querySelectorAll('input[name="server-ids"]')) input.checked = value; scheduleAudiencePreview(); }
function scheduleAudiencePreview() { window.clearTimeout(audienceTimer); audienceTimer = window.setTimeout(updateAudiencePreview, 250); }
async function updateAudiencePreview() { const payload = selectionPayload(); const target = document.getElementById('recipient-preview'); if (!payload.categories.length || !payload.deliverySlots.length || !payload.targetServerIds.length) { target.textContent = 'カテゴリ・配信枠・サーバーを選ぶと対象チャンネル数を表示します。'; return; } try { const result = await request('/site/discord-admin/api/audience-preview', { method: 'POST', body: JSON.stringify(payload) }); target.textContent = `現在の対象: Discordチャンネル ${result.count}件。配信開始時に再計算します。`; } catch (error) { target.textContent = error.message; } }
function renderPreview() { document.getElementById('preview-subject').textContent = document.getElementById('subject').value.trim() || '件名'; document.getElementById('preview-body').textContent = document.getElementById('body').value.trim() || '本文を入力してください。'; }
function slotName(id) { return summaryState.deliveryCatalog.find((slot) => slot.id === id)?.label || id; }
function serverName(id) { return summaryState.approvedServers.find((server) => server.id === id)?.name || id; }
async function request(path, options = {}) { const response = await fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, ...options }); const result = await response.json().catch(() => ({})); if (!response.ok || result.success !== true) throw new Error(result.message || `処理に失敗しました（HTTP ${response.status}）。`); return result; }
function setStatus(message, type) { const status = document.getElementById('global-status'); status.textContent = message; status.className = type ? `status ${type}` : 'status'; }
function el(tag, className = '', text = '') { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; }
