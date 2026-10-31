const categoryLabels = Object.freeze({ maintenance: 'メンテナンス情報', outage: '障害・重要情報', update: 'アップデート情報' });
const statusLabels = Object.freeze({ draft: '下書き', queuing: 'Queue登録中', sending: '配信中', completed: '完了', cancelled: '取消済み' });
const formatLabels = Object.freeze({ message: '通常メッセージ', embed: 'Embed' });
const targetModeLabels = Object.freeze({ delivery_slots: '配信枠', servers: 'サーバー', intersection: '配信枠＋サーバー' });
const officialRoleLabels = Object.freeze({
    '1538768646430793768': '@障害・バグ情報',
    '1538768792648163368': '@アップデート情報',
    '1538768846989820005': '@その他お知らせ情報',
});
const MAX_IMAGE_BYTES = 1_250_000;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const campaignTemplates = Object.freeze({
    maintenance: Object.freeze({
        subject: '【メンテナンス情報】DPI-Bot メンテナンスのお知らせ', color: '#f59e0b',
        body: `## メンテナンスのお知らせ

DPI-Botをご利用いただきありがとうございます。以下の日程でメンテナンスを実施します。

- 実施日時：
- 対象サービス：
- 影響範囲：
- 作業内容：

> 作業状況により、終了時刻が前後する場合があります。

完了後、改めてお知らせします。`,
    }),
    outage: Object.freeze({
        subject: '【障害情報】DPI-Botで発生している障害について', color: '#dc2626',
        body: `## 障害情報

現在、DPI-Botの一部機能で障害が発生しています。

- 発生日時：
- 対象サービス：
- 影響範囲：
- 現在の状況：
- 次回更新予定：

> 復旧作業を進めています。ご不便をおかけして申し訳ありません。`,
    }),
    update: Object.freeze({
        subject: '【アップデート情報】DPI-Bot 更新のお知らせ', color: '#5865f2',
        body: `## アップデート情報

DPI-Botを更新しました。

- 実施日：
- 対象サービス：
- 主な変更内容：
  - （変更内容を入力）
- 利用者側で必要な操作：なし

詳しい内容は、[DPI-Bot公式サイト](https://dpi-bot.com/)をご確認ください。`,
    }),
});

let summaryState = null;
let audienceTimer = 0;
let previewImageUrl = '';

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('refresh-btn').addEventListener('click', loadSummary);
    document.getElementById('campaign-form').addEventListener('submit', createCampaign);
    document.getElementById('preview-btn').addEventListener('click', renderPreview);
    document.getElementById('select-all-servers').addEventListener('click', () => setAllServers(true));
    document.getElementById('clear-all-servers').addEventListener('click', () => setAllServers(false));
    document.getElementById('campaign-form').addEventListener('change', handleFormChange);
    document.getElementById('campaign-form').addEventListener('input', handleFormInput);
    for (const button of document.querySelectorAll('[data-template]')) button.addEventListener('click', () => applyTemplate(button.dataset.template));
    window.addEventListener('beforeunload', revokePreviewImage);
    updateOfficialSupportUI(); loadSummary();
});

async function loadSummary() {
    setStatus('読み込み中…', 'info');
    try {
        summaryState = await request('/site/discord-admin/api/summary');
        document.getElementById('admin-email').textContent = summaryState.admin;
        renderStats(); renderSlots(); renderServers(); updateTargetModeUI(); renderCampaigns(); scheduleAudiencePreview();
        setStatus('', '');
    } catch (error) { setStatus(error.message, 'error'); }
}

function renderStats() {
    const servers = summaryState.approvedServers || [];
    const webhooks = Number(summaryState.discordDirectory?.webhookCount || 0);
    const sent = (summaryState.campaigns || []).reduce((sum, campaign) => sum + Number(campaign.sentCount || 0), 0);
    const container = document.getElementById('discord-stats'); container.replaceChildren();
    for (const [label, value] of [['登録サーバー', servers.length], ['AWS登録Webhook', webhooks], ['直近30配信の送信済み', sent]]) {
        const card = el('article', 'stat-card'); card.append(el('span', 'stat-label', label), el('strong', 'stat-value', String(value))); container.append(card);
    }
}

function renderSlots() {
    const previous = new Set(checked('delivery-slots'));
    const container = document.getElementById('delivery-slots'); container.replaceChildren();
    for (const slot of summaryState.deliveryCatalog || []) {
        const label = el('label', 'delivery-slot'); const input = document.createElement('input');
        input.type = 'checkbox'; input.name = 'delivery-slots'; input.value = slot.id;
        input.checked = previous.has(slot.id) || (previous.size === 0 && slot.id === 'DPI_Bot通知');
        input.defaultChecked = input.checked;
        const text = el('span', '', slot.label); text.append(el('small', `slot-status ${slot.status}`, slot.status)); label.append(input, text); container.append(label);
    }
}

function renderServers() {
    const previous = new Set(checked('server-ids'));
    const container = document.getElementById('approved-servers'); container.replaceChildren();
    const servers = summaryState.approvedServers || [];
    if (!servers.length) { container.append(el('p', 'empty', '許可済みサーバーはありません。')); return; }
    for (const server of servers) {
        const label = el('label', 'delivery-slot'); const input = document.createElement('input');
        input.type = 'checkbox'; input.name = 'server-ids'; input.value = server.id; input.checked = previous.has(server.id);
        const count = Number(server.webhookCount ?? server.channelCount ?? 0);
        const text = el('span', '', server.name || server.id); text.append(el('small', 'slot-status active', `${count}件`)); label.append(input, text); container.append(label);
    }
}

function renderCampaigns() {
    const container = document.getElementById('campaign-list'); container.replaceChildren();
    if (!summaryState.campaigns.length) { container.append(el('p', 'empty', 'Discord配信履歴はまだありません。')); return; }
    for (const campaign of summaryState.campaigns) {
        const card = el('article', 'campaign-card'); const badges = el('div', 'badges');
        for (const category of campaign.categories || []) badges.append(el('span', 'badge category', categoryLabels[category] || category));
        badges.append(el('span', 'badge audience', formatLabels[campaign.deliveryFormat] || '通常メッセージ'));
        if (campaign.hasImage) badges.append(el('span', 'badge audience', '画像あり'));
        badges.append(el('span', `badge status ${campaign.status}`, statusLabels[campaign.status] || campaign.status));
        card.append(badges, el('h3', '', campaign.subject), el('pre', 'campaign-body', campaign.body));
        const metrics = el('div', 'campaign-metrics');
        for (const [label, value] of [['対象', campaign.recipientCount], ['送信済み', campaign.sentCount], ['残り', campaign.remainingCount], ['失敗', campaign.failedCount]]) metrics.append(el('span', '', `${label}: ${value}`));
        card.append(metrics);
        const names = (campaign.targetServerIds || []).map(serverName).join('・') || '指定なし';
        const slots = (campaign.deliverySlots || []).map(slotName).join('・') || '指定なし';
        const duplicateText = campaign.deduplicateChannels === false ? '配信枠ごと' : '同一チャンネル1件';
        card.append(el('p', 'campaign-meta', `指定方法: ${targetModeLabels[campaign.targetMode] || '配信枠'} / 配信枠: ${slots} / サーバー: ${names} / ${duplicateText}`));
        if (campaign.sendOfficialSupport) {
            card.append(el('p', 'campaign-meta', `公式サポート: お知らせチャンネル / メンション: ${officialRoleLabels[campaign.officialMentionRoleId] || 'なし'}`));
        }
        const actions = el('div', 'campaign-actions');
        if (['draft', 'queuing'].includes(campaign.status)) {
            const button = el('button', 'primary-btn', '配信を開始'); button.type = 'button'; button.addEventListener('click', () => sendCampaign(campaign, button)); actions.append(button);
        }
        if (['draft', 'queuing', 'sending'].includes(campaign.status)) {
            const button = el('button', 'danger-btn', '未送信分を取消'); button.type = 'button'; button.addEventListener('click', () => cancelCampaign(campaign, button)); actions.append(button);
        }
        card.append(actions); container.append(card);
    }
}

function handleFormChange(event) {
    if (event.target.name === 'delivery-format') updateFormatOptions();
    if (event.target.name === 'target-mode') updateTargetModeUI();
    if (event.target.id === 'image-file' || event.target.id === 'image-url') validateImageSelection();
    if (event.target.id === 'send-official-support') updateOfficialSupportUI();
    scheduleAudiencePreview(); renderPreview();
}
function handleFormInput(event) { if (['subject', 'body', 'embed-color', 'image-url', 'image-alt'].includes(event.target.id)) renderPreview(); }
function updateFormatOptions() {
    const isEmbed = selectedFormat() === 'embed'; document.getElementById('embed-options').hidden = !isEmbed;
    document.getElementById('body').maxLength = isEmbed ? 4096 : 1850;
}

function applyTemplate(templateId) {
    const template = campaignTemplates[templateId]; if (!template) return;
    const subject = document.getElementById('subject'); const body = document.getElementById('body');
    if ((subject.value.trim() || body.value.trim()) && !window.confirm('現在の件名と本文をテンプレートで上書きしますか？')) return;
    const category = document.querySelector(`input[name="campaign-categories"][value="${templateId}"]`); if (category) category.checked = true;
    subject.value = template.subject; body.value = template.body; document.getElementById('embed-color').value = template.color;
    scheduleAudiencePreview(); renderPreview();
}

async function createCampaign(event) {
    event.preventDefault(); const button = document.getElementById('save-btn'); button.disabled = true;
    try {
        const payload = selectionPayload();
        if (!payload.categories.length) throw new Error('お知らせカテゴリを1つ以上選択してください。');
        validateTargetSelection(payload);
        validateImageSelection(true);
        const form = new FormData();
        for (const key of ['categories', 'recipientGroups', 'deliverySlots', 'targetServerIds']) form.append(key, JSON.stringify(payload[key]));
        for (const key of ['targetMode', 'deduplicateChannels', 'sendOfficialSupport', 'officialMentionRoleId', 'subject', 'body', 'deliveryFormat', 'embedColor', 'imageUrl', 'imageAlt']) form.append(key, String(payload[key]));
        const image = document.getElementById('image-file').files[0]; if (image) form.append('image', image, image.name);
        const result = await request('/site/discord-admin/api/campaigns', { method: 'POST', body: form });
        document.getElementById('campaign-form').reset(); document.getElementById('embed-color').value = '#5865f2'; updateFormatOptions(); updateTargetModeUI(); updateOfficialSupportUI(); revokePreviewImage(); renderPreview(); scheduleAudiencePreview();
        setStatus(`下書きを保存しました。配信ID: ${result.campaign.id}`, 'success'); await loadSummary();
    } catch (error) { setStatus(error.message, 'error'); } finally { button.disabled = false; }
}

async function sendCampaign(campaign, button) {
    if (!window.confirm(`「${campaign.subject}」をDiscordへ配信します。送信済み投稿は取り消せません。`)) return;
    button.disabled = true;
    try { const result = await request(`/site/discord-admin/api/campaigns/${campaign.id}/send`, { method: 'POST', body: JSON.stringify({ confirmation: campaign.id }) }); setStatus(`対象${result.targetCount}件へ配信し、成功${result.sentCount}件・失敗${result.failedCount}件でした。`, result.failedCount ? 'error' : 'success'); await loadSummary(); }
    catch (error) { setStatus(error.message, 'error'); button.disabled = false; }
}
async function cancelCampaign(campaign, button) {
    if (!window.confirm('未送信分を取り消しますか？')) return; button.disabled = true;
    try { await request(`/site/discord-admin/api/campaigns/${campaign.id}/cancel`, { method: 'POST', body: JSON.stringify({ confirmation: campaign.id }) }); setStatus('未送信分を取り消しました。', 'success'); await loadSummary(); }
    catch (error) { setStatus(error.message, 'error'); button.disabled = false; }
}

function selectionPayload() {
    const sendOfficialSupport = document.getElementById('send-official-support').checked;
    return { categories: checked('campaign-categories'), recipientGroups: ['discord_approved'], targetMode: selectedTargetMode(), deliverySlots: checked('delivery-slots'), targetServerIds: checked('server-ids'), deduplicateChannels: document.getElementById('deduplicate-channels').checked, sendOfficialSupport, officialMentionRoleId: sendOfficialSupport ? document.getElementById('official-mention-role').value : '', subject: document.getElementById('subject').value, body: document.getElementById('body').value, deliveryFormat: selectedFormat(), embedColor: document.getElementById('embed-color').value, imageUrl: document.getElementById('image-url').value.trim(), imageAlt: document.getElementById('image-alt').value.trim() };
}
function selectedFormat() { return document.querySelector('input[name="delivery-format"]:checked')?.value || 'message'; }
function selectedTargetMode() { return document.querySelector('input[name="target-mode"]:checked')?.value || 'delivery_slots'; }
function checked(name) { return [...document.querySelectorAll(`input[name="${name}"]:not(:disabled):checked`)].map((input) => input.value); }
function setAllServers(value) { for (const input of document.querySelectorAll('input[name="server-ids"]')) input.checked = value; scheduleAudiencePreview(); }
function scheduleAudiencePreview() { window.clearTimeout(audienceTimer); audienceTimer = window.setTimeout(updateAudiencePreview, 250); }

function updateTargetModeUI() {
    const mode = selectedTargetMode();
    const slotsEnabled = mode !== 'servers'; const serversEnabled = mode !== 'delivery_slots';
    const slotsFieldset = document.getElementById('delivery-slots-fieldset'); const serversFieldset = document.getElementById('servers-fieldset');
    slotsFieldset.classList.toggle('target-disabled', !slotsEnabled); serversFieldset.classList.toggle('target-disabled', !serversEnabled);
    for (const input of slotsFieldset.querySelectorAll('input')) input.disabled = !slotsEnabled;
    for (const input of serversFieldset.querySelectorAll('input, button')) input.disabled = !serversEnabled;
}

function updateOfficialSupportUI() {
    const enabled = document.getElementById('send-official-support').checked;
    const select = document.getElementById('official-mention-role');
    select.disabled = !enabled;
    if (!enabled) select.value = '';
}

function validateTargetSelection(payload) {
    if (payload.targetMode === 'delivery_slots' && !payload.deliverySlots.length) throw new Error('配信枠を1つ以上選択してください。');
    if (payload.targetMode === 'servers' && !payload.targetServerIds.length) throw new Error('配信先サーバーを1つ以上選択してください。');
    if (payload.targetMode === 'intersection' && (!payload.deliverySlots.length || !payload.targetServerIds.length)) throw new Error('配信枠と配信先サーバーをそれぞれ1つ以上選択してください。');
}

async function updateAudiencePreview() {
    const payload = selectionPayload(); const target = document.getElementById('recipient-preview');
    target.classList.remove('validation-error');
    try { validateTargetSelection(payload); }
    catch (error) { target.textContent = `${error.message} 選択後に対象Webhook数を表示します。`; return; }
    try {
        const result = await request('/site/discord-admin/api/audience-preview', { method: 'POST', body: JSON.stringify(payload) });
        const count = Number(result.count || 0); const official = Number(result.byKind?.official_support || 0);
        target.textContent = `現在の送信件数: ${count}件${official ? '（公式サポート 1件を含む）' : ''}。配信開始時に再計算します。`;
        target.classList.toggle('validation-error', count === 0);
        if (count === 0) target.textContent += ' 送信先がないため、下書き保存・配信はできません。';
    }
    catch (error) { target.textContent = error.message; target.classList.add('validation-error'); }
}

function validateImageSelection(throwOnError = false) {
    const file = document.getElementById('image-file').files[0]; const imageUrl = document.getElementById('image-url').value.trim();
    let message = '画像URLと画像ファイルは同時に使用できません。'; let error = '';
    if (file && imageUrl) error = '画像URLと画像ファイルはどちらか一方だけ指定してください。';
    else if (file && (!IMAGE_TYPES.has(file.type) || file.size > MAX_IMAGE_BYTES)) error = '画像はPNG・JPEG・GIF・WebPのいずれかで、1.25MB以内にしてください。';
    else if (file) message = `${file.name}（${Math.ceil(file.size / 1024)}KB）を添付します。`;
    else if (imageUrl) message = '指定したHTTPS画像URLを使用します。';
    const status = document.getElementById('image-status'); status.textContent = error || message; status.classList.toggle('validation-error', Boolean(error));
    if (error && throwOnError) throw new Error(error); return !error;
}

function renderPreview() {
    const payload = selectionPayload(); const preview = document.getElementById('discord-preview');
    preview.classList.toggle('embed-preview', payload.deliveryFormat === 'embed'); preview.classList.toggle('message-preview', payload.deliveryFormat === 'message'); preview.style.setProperty('--embed-color', payload.embedColor);
    const mention = document.getElementById('preview-official-mention'); mention.textContent = officialRoleLabels[payload.officialMentionRoleId] || ''; mention.hidden = !payload.sendOfficialSupport || !payload.officialMentionRoleId;
    document.getElementById('preview-subject').textContent = payload.subject.trim() || '件名'; renderDiscordMarkdown(document.getElementById('preview-body'), payload.body.trim() || '本文を入力してください。'); renderPreviewImage(payload.imageUrl);
}

function renderPreviewImage(imageUrl) {
    const image = document.getElementById('preview-image'); const file = document.getElementById('image-file').files[0]; revokePreviewImage();
    if (file && IMAGE_TYPES.has(file.type) && file.size <= MAX_IMAGE_BYTES) { previewImageUrl = URL.createObjectURL(file); image.src = previewImageUrl; image.hidden = false; }
    else if (imageUrl && /^https:\/\//iu.test(imageUrl)) { image.src = imageUrl; image.hidden = false; }
    else { image.removeAttribute('src'); image.hidden = true; }
    image.alt = document.getElementById('image-alt').value.trim();
}
function revokePreviewImage() { if (previewImageUrl) URL.revokeObjectURL(previewImageUrl); previewImageUrl = ''; }

function renderDiscordMarkdown(container, text) {
    container.replaceChildren(); let list = null;
    for (const rawLine of text.split('\n')) {
        const line = rawLine.trimEnd();
        if (line.startsWith('- ')) { if (!list) { list = document.createElement('ul'); container.append(list); } const item = document.createElement('li'); appendInlineMarkdown(item, line.slice(2)); list.append(item); continue; }
        list = null; let node;
        if (/^#{1,3}\s/u.test(line)) { node = el('strong', 'markdown-heading'); appendInlineMarkdown(node, line.replace(/^#{1,3}\s/u, '')); }
        else if (line.startsWith('> ')) { node = el('blockquote', 'markdown-quote'); appendInlineMarkdown(node, line.slice(2)); }
        else if (!line) node = document.createElement('br');
        else { node = document.createElement('p'); appendInlineMarkdown(node, line); }
        container.append(node);
    }
}

function appendInlineMarkdown(container, text) {
    const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\(https:\/\/[^\s)]+\))/gu; let last = 0;
    for (const match of text.matchAll(pattern)) {
        container.append(document.createTextNode(text.slice(last, match.index))); const token = match[0]; let node;
        if (token.startsWith('**')) node = el('strong', '', token.slice(2, -2));
        else if (token.startsWith('*')) node = el('em', '', token.slice(1, -1));
        else if (token.startsWith('`')) node = el('code', '', token.slice(1, -1));
        else { const parts = token.match(/^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/u); node = el('a', '', parts[1]); node.href = parts[2]; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
        container.append(node); last = match.index + token.length;
    }
    container.append(document.createTextNode(text.slice(last)));
}

function slotName(id) { return summaryState.deliveryCatalog.find((slot) => slot.id === id)?.label || id; }
function serverName(id) { return summaryState.approvedServers.find((server) => server.id === id)?.name || id; }
async function request(path, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) }; if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const response = await fetch(path, { credentials: 'same-origin', ...options, headers }); const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success !== true) throw new Error(result.message || `処理に失敗しました（HTTP ${response.status}）。`); return result;
}
function setStatus(message, type) { const status = document.getElementById('global-status'); status.textContent = message; status.className = type ? `status ${type}` : 'status'; }
function el(tag, className = '', text = '') { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; }
