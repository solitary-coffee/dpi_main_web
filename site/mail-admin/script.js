const categoryLabels = Object.freeze({
    maintenance: 'メンテナンス情報',
    outage: '障害・重要情報',
    update: 'アップデート情報',
});

const statusLabels = Object.freeze({
    draft: '下書き',
    queuing: 'Queue登録中',
    sending: '配信中',
    completed: '完了',
    cancelled: '取消済み',
});

const recipientGroupLabels = Object.freeze({
    subscribers: 'お知らせ購読者',
    reuse_approved: '許可済み二次利用者',
});

const campaignTemplates = Object.freeze({
    maintenance: Object.freeze({
        subject: '【メンテナンス情報】DPI-Bot メンテナンスのお知らせ',
        body: `## メンテナンスのお知らせ

DPI-Botをご利用いただきありがとうございます。以下の日程でメンテナンスを実施します。

- 実施日時：
- 対象サービス：
- 影響範囲：
- 作業内容：

> 作業状況により、終了時刻が前後する場合があります。

メンテナンス完了後、改めてお知らせします。`,
    }),
    outage: Object.freeze({
        subject: '【障害情報】DPI-Botで発生している障害について',
        body: `## 障害情報

現在、DPI-Botの一部機能で障害が発生しています。

- 発生日時：
- 対象サービス：
- 影響範囲：
- 現在の状況：
- 次回更新予定：

> 復旧作業を進めています。ご不便をおかけして申し訳ありません。

状況が更新され次第、改めてお知らせします。`,
    }),
    update: Object.freeze({
        subject: '【アップデート情報】DPI-Bot 更新のお知らせ',
        body: `## アップデート情報

DPI-Botを更新しました。

- 実施日：
- 対象サービス：
- 主な変更内容：
  - 
- 利用者側で必要な操作：なし

詳しい内容は、[DPI-Bot公式サイト](https://dpi-bot.com/)をご確認ください。`,
    }),
});

let summaryState = null;
let previewObjectUrl = '';
let previewTimer = null;
let previewRequestId = 0;
let audienceTimer = null;
let audienceRequestId = 0;

document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('refresh-btn').addEventListener('click', loadSummary);
    document.getElementById('campaign-form').addEventListener('submit', createCampaign);
    document.getElementById('preview-btn').addEventListener('click', updateEmailPreview);
    document.getElementById('subject').addEventListener('input', scheduleEmailPreview);
    document.getElementById('body').addEventListener('input', scheduleEmailPreview);
    for (const input of document.querySelectorAll('input[name="campaign-categories"]')) {
        input.addEventListener('change', function() {
            updateRecipientPreview();
            scheduleEmailPreview();
        });
    }
    for (const input of document.querySelectorAll('input[name="campaign-recipient-groups"]')) {
        input.addEventListener('change', function() {
            scheduleRecipientPreview();
            scheduleEmailPreview();
        });
    }
    for (const button of document.querySelectorAll('[data-template]')) {
        button.addEventListener('click', () => applyTemplate(button.dataset.template));
    }
    window.addEventListener('beforeunload', revokePreviewUrl);
    loadSummary();
});

async function loadSummary() {
    setStatus('読み込み中…', 'info');
    try {
        const summary = await adminRequest('/site/mail-admin/api/summary');
        summaryState = summary;
        document.getElementById('admin-email').textContent = summary.admin;
        renderSubscriberStats(summary.subscribers, summary.reuseUsers);
        renderDeliverySlots(summary.deliveryCatalog);
        renderCampaigns(summary.campaigns);
        scheduleRecipientPreview(0);
        setStatus('', '');
    } catch (error) {
        setStatus(error.message, 'error');
    }
}

function renderSubscriberStats(subscribers, reuseUsers) {
    const container = document.getElementById('subscriber-stats');
    container.replaceChildren();
    const items = [
        ['有効な購読者', subscribers.active],
        ['確認待ち', subscribers.pending],
        ['配信停止済み', subscribers.unsubscribed],
        ['送信抑止', subscribers.bounced],
        ['メンテナンス', subscribers.categories.maintenance],
        ['障害・重要情報', subscribers.categories.outage],
        ['アップデート', subscribers.categories.update],
        ['許可済み二次利用者', reuseUsers?.approved || 0],
    ];
    for (const [label, value] of items) {
        const card = element('article', 'stat-card');
        card.append(element('span', 'stat-label', label));
        card.append(element('strong', 'stat-value', String(value)));
        container.append(card);
    }
}

function renderDeliverySlots(catalog) {
    const container = document.getElementById('delivery-slots');
    const previous = new Set(selectedDeliverySlots());
    container.replaceChildren();
    for (const slot of catalog || []) {
        const label = element('label', 'delivery-slot');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.name = 'campaign-delivery-slots';
        input.value = slot.id;
        input.checked = previous.has(slot.id) || (previous.size === 0 && slot.id === 'DPI_Bot通知');
        input.addEventListener('change', function() {
            scheduleRecipientPreview();
            scheduleEmailPreview();
        });
        const text = element('span', '', slot.label);
        text.append(element('small', `slot-status ${slot.status}`, slot.status));
        label.append(input, text);
        container.append(label);
    }
}

function renderCampaigns(campaigns) {
    const container = document.getElementById('campaign-list');
    container.replaceChildren();
    if (campaigns.length === 0) {
        container.append(element('p', 'empty', '配信履歴はまだありません。'));
        return;
    }

    for (const campaign of campaigns) {
        const card = element('article', 'campaign-card');
        const heading = element('div', 'campaign-heading');
        const titleWrap = document.createElement('div');
        const badges = element('div', 'badges');
        for (const category of campaignCategories(campaign)) {
            badges.append(element('span', 'badge category', categoryLabels[category] || category));
        }
        for (const group of campaign.recipientGroups || ['subscribers']) {
            badges.append(element('span', 'badge audience', recipientGroupLabels[group] || group));
        }
        badges.append(element('span', `badge status ${campaign.status}`, statusLabels[campaign.status] || campaign.status));
        titleWrap.append(badges, element('h3', '', campaign.subject));
        heading.append(titleWrap, element('time', '', formatDate(campaign.createdAt)));
        card.append(heading);

        const body = element('pre', 'campaign-body', campaign.body);
        card.append(body);

        const metrics = element('div', 'campaign-metrics');
        const values = [
            ['対象', campaign.recipientCount],
            ['送信済み', campaign.sentCount],
            ['残り', campaign.remainingCount],
            ['失敗', campaign.failedCount],
            ['スキップ', campaign.skippedCount],
        ];
        for (const [label, value] of values) {
            const item = element('span', '', `${label}: `);
            item.append(element('strong', '', String(value)));
            metrics.append(item);
        }
        card.append(metrics);

        const meta = element('p', 'campaign-meta', `ID: ${campaign.id} / 作成: ${campaign.createdBy}`);
        const slots = (campaign.deliverySlots || []).map(deliverySlotLabel).join('・');
        if (slots) meta.append(document.createElement('br'), document.createTextNode(`対象配信枠: ${slots}`));
        card.append(meta);

        const actions = element('div', 'campaign-actions');
        if (['draft', 'queuing'].includes(campaign.status)) {
            const sendButton = element(
                'button',
                'primary-btn',
                campaign.status === 'queuing' ? 'Queue登録を再開' : '配信を開始',
            );
            sendButton.type = 'button';
            sendButton.addEventListener('click', () => sendCampaign(campaign, sendButton));
            actions.append(sendButton);
        }
        if (['draft', 'queuing', 'sending'].includes(campaign.status)) {
            const cancelButton = element('button', 'danger-btn', '取り消す');
            cancelButton.type = 'button';
            cancelButton.addEventListener('click', () => cancelCampaign(campaign, cancelButton));
            actions.append(cancelButton);
        }
        card.append(actions);
        container.append(card);
    }
}

async function createCampaign(event) {
    event.preventDefault();
    const button = document.getElementById('save-btn');
    button.disabled = true;
    setStatus('下書きを保存中…', 'info');
    try {
        const categories = selectedCampaignCategories();
        if (categories.length === 0) throw new Error('配信カテゴリを1つ以上選択してください。');
        const recipientGroups = selectedRecipientGroups();
        const deliverySlots = selectedDeliverySlots();
        const targetServerIds = selectedServerIds();
        if (recipientGroups.length === 0) throw new Error('送信先を1つ以上選択してください。');
        if (deliverySlots.length === 0) throw new Error('対象配信枠を1つ以上選択してください。');
        const result = await adminRequest('/site/mail-admin/api/campaigns', {
            method: 'POST',
            body: JSON.stringify({
                categories,
                recipientGroups,
                deliverySlots,
                targetServerIds,
                subject: document.getElementById('subject').value,
                body: document.getElementById('body').value,
            }),
        });
        document.getElementById('campaign-form').reset();
        ensureDefaultSelections();
        scheduleRecipientPreview(0);
        clearEmailPreview();
        setStatus(`下書きを保存しました。配信ID: ${result.campaign.id}`, 'success');
        await loadSummary();
    } catch (error) {
        setStatus(error.message, 'error');
    } finally {
        button.disabled = false;
    }
}

async function sendCampaign(campaign, button) {
    let count = '不明';
    try {
        const audience = await audiencePreview(
            campaignCategories(campaign),
            campaign.recipientGroups,
            campaign.deliverySlots,
            campaign.targetServerIds,
        );
        count = audience.count;
    } catch (error) {
        setStatus(error.message, 'error');
        return;
    }
    const confirmed = window.confirm(
        `「${campaign.subject}」を${count}件へ配信開始します。\n\n配信開始後、すでに送信されたメールは取り消せません。`,
    );
    if (!confirmed) return;

    button.disabled = true;
    setStatus('Queueへ配信を登録しています。この画面を閉じずにお待ちください…', 'info');
    try {
        const result = await adminRequest(`/site/mail-admin/api/campaigns/${campaign.id}/send`, {
            method: 'POST',
            body: JSON.stringify({ confirmation: campaign.id }),
        });
        setStatus(`${result.queued}件をQueueへ登録しました。`, 'success');
        await loadSummary();
    } catch (error) {
        setStatus(error.message, 'error');
        button.disabled = false;
    }
}

async function cancelCampaign(campaign, button) {
    if (!window.confirm(`「${campaign.subject}」の未送信分を取り消しますか？`)) return;
    button.disabled = true;
    setStatus('取り消し中…', 'info');
    try {
        await adminRequest(`/site/mail-admin/api/campaigns/${campaign.id}/cancel`, {
            method: 'POST',
            body: JSON.stringify({ confirmation: campaign.id }),
        });
        setStatus('未送信分を取り消しました。', 'success');
        await loadSummary();
    } catch (error) {
        setStatus(error.message, 'error');
        button.disabled = false;
    }
}

function scheduleRecipientPreview(delay = 250) {
    window.clearTimeout(audienceTimer);
    audienceTimer = window.setTimeout(updateRecipientPreview, delay);
}

async function updateRecipientPreview() {
    const categories = selectedCampaignCategories();
    const recipientGroups = selectedRecipientGroups();
    const deliverySlots = selectedDeliverySlots();
    const targetServerIds = selectedServerIds();
    const preview = document.getElementById('recipient-preview');
    if (categories.length === 0 || recipientGroups.length === 0 || deliverySlots.length === 0 || !summaryState) {
        preview.textContent = 'カテゴリ・送信先・配信枠をそれぞれ1つ以上選択してください。';
        return;
    }
    const requestId = ++audienceRequestId;
    preview.textContent = '現在の配信対象を計算中…';
    try {
        const result = await audiencePreview(categories, recipientGroups, deliverySlots, targetServerIds);
        if (requestId !== audienceRequestId) return;
        const parts = [];
        if (result.byKind?.subscriber) parts.push(`購読者 ${result.byKind.subscriber}件`);
        if (result.byKind?.reuse_approved) parts.push(`二次利用者 ${result.byKind.reuse_approved}件`);
        preview.textContent = `現在の配信対象: ${result.count}件${parts.length ? `（${parts.join(' / ')}）` : ''}。配信開始時に再計算します。`;
    } catch (error) {
        if (requestId === audienceRequestId) preview.textContent = error.message;
    }
}

function selectedCampaignCategories() {
    return Array.from(document.querySelectorAll('input[name="campaign-categories"]:checked'))
        .map((input) => input.value);
}

function selectedRecipientGroups() {
    return Array.from(document.querySelectorAll('input[name="campaign-recipient-groups"]:checked'))
        .map((input) => input.value);
}

function selectedDeliverySlots() {
    return Array.from(document.querySelectorAll('input[name="campaign-delivery-slots"]:checked'))
        .map((input) => input.value);
}

function selectedServerIds() {
    return [];
}

function ensureDefaultSelections() {
    const subscribers = document.querySelector('input[name="campaign-recipient-groups"][value="subscribers"]');
    const notices = document.querySelector('input[name="campaign-delivery-slots"][value="DPI_Bot通知"]');
    if (subscribers) subscribers.checked = true;
    if (notices) notices.checked = true;
}

function deliverySlotLabel(id) {
    return summaryState?.deliveryCatalog?.find((slot) => slot.id === id)?.label || id;
}

function audiencePreview(categories, recipientGroups, deliverySlots, targetServerIds = selectedServerIds()) {
    return adminRequest('/site/mail-admin/api/audience-preview', {
        method: 'POST',
        body: JSON.stringify({ categories, recipientGroups, deliverySlots, targetServerIds }),
    });
}

function campaignCategories(campaign) {
    if (Array.isArray(campaign.categories) && campaign.categories.length > 0) return campaign.categories;
    return campaign.category ? [campaign.category] : [];
}

function audienceCount(categories) {
    if (!summaryState) return '不明';
    const key = categories.join(',');
    const exactCount = summaryState.subscribers.audiences?.[key];
    if (Number.isFinite(exactCount)) return exactCount;
    if (categories.length === 1) return summaryState.subscribers.categories[categories[0]] || 0;
    return '不明';
}

function applyTemplate(templateId) {
    const template = campaignTemplates[templateId];
    if (!template) return;

    const subject = document.getElementById('subject');
    const body = document.getElementById('body');
    if ((subject.value.trim() || body.value.trim()) && !window.confirm('現在の件名と本文をテンプレートで上書きしますか？')) {
        return;
    }

    const categoryInput = document.querySelector(`input[name="campaign-categories"][value="${templateId}"]`);
    if (categoryInput) categoryInput.checked = true;
    subject.value = template.subject;
    body.value = template.body;
    scheduleRecipientPreview(0);
    scheduleEmailPreview(0);
}

function scheduleEmailPreview(delay = 600) {
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(updateEmailPreview, delay);
}

async function updateEmailPreview() {
    window.clearTimeout(previewTimer);
    const categories = selectedCampaignCategories();
    const recipientGroups = selectedRecipientGroups();
    const deliverySlots = selectedDeliverySlots();
    const targetServerIds = selectedServerIds();
    const subject = document.getElementById('subject').value.trim();
    const body = document.getElementById('body').value.trim();
    const status = document.getElementById('preview-status');
    if (categories.length === 0 || recipientGroups.length === 0 || deliverySlots.length === 0 || !subject || !body) {
        status.textContent = 'カテゴリ・件名・本文を入力するとプレビューできます。';
        clearEmailPreview(false);
        return;
    }

    const requestId = ++previewRequestId;
    status.textContent = 'プレビューを生成中…';
    try {
        const result = await adminRequest('/site/mail-admin/api/preview', {
            method: 'POST',
            body: JSON.stringify({ categories, recipientGroups, deliverySlots, targetServerIds, subject, body }),
        });
        if (requestId !== previewRequestId) return;
        revokePreviewUrl();
        previewObjectUrl = URL.createObjectURL(new Blob([result.html], { type: 'text/html;charset=utf-8' }));
        document.getElementById('email-preview').src = previewObjectUrl;
        status.textContent = '実際に送信されるHTMLメールの表示です。リンク操作は無効化しています。';
    } catch (error) {
        if (requestId !== previewRequestId) return;
        status.textContent = error.message;
        clearEmailPreview(false);
    }
}

function clearEmailPreview(resetStatus = true) {
    previewRequestId += 1;
    revokePreviewUrl();
    document.getElementById('email-preview').removeAttribute('src');
    if (resetStatus) {
        document.getElementById('preview-status').textContent = 'カテゴリ・件名・本文を入力するとプレビューできます。';
    }
}

function revokePreviewUrl() {
    if (!previewObjectUrl) return;
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = '';
}

async function adminRequest(path, options = {}) {
    const response = await fetch(path, {
        credentials: 'same-origin',
        headers: {
            Accept: 'application/json',
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...options,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success !== true) {
        throw new Error(result.message || `処理に失敗しました（HTTP ${response.status}）。`);
    }
    return result;
}

function setStatus(message, type) {
    const status = document.getElementById('global-status');
    status.textContent = message;
    status.className = type ? `status ${type}` : 'status';
}

function element(tagName, className = '', text = '') {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function formatDate(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
        ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
        : '';
}

