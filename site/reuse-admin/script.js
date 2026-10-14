const statusLabels = Object.freeze({ pending: '審査中', approved: '許可', rejected: '却下', changes_requested: '不備・再申請待ち' });
const choiceLabels = Object.freeze({ public: '公開', private: '非公開・招待制', role_limited: '指定ロールのみ', yes: '自動', no: '手動', not_applicable: '該当なし', unchanged: 'そのまま転載', edited: '編集・加工', other: 'その他' });
const MAIL_TEMPLATES = Object.freeze({
    inquiry: Object.freeze({ category: 'inquiry', subject: '二次利用申請について確認事項があります', message: '申請内容について確認したい点があります。\n\n【確認事項】\n・\n\nお手数ですが、このメールへ返信してご回答ください。' }),
    correction: Object.freeze({ category: 'correction', subject: '二次利用申請の内容確認・修正のお願い', message: '申請内容に確認または修正が必要な点があります。\n\n【確認・修正事項】\n・\n\n内容をご確認のうえ、このメールへ返信してください。' }),
    reminder: Object.freeze({ category: 'other', subject: '二次利用申請についてのご連絡', message: '二次利用申請について、運営からご連絡します。\n\n【ご案内】\n・\n\nご不明な点があれば、このメールへ返信してください。' }),
});
const REVIEW_TEMPLATES = Object.freeze({
    approved: '申請内容を確認しました。\n\n審査の結果、二次利用を許可します。\n今後、利用チャンネル・公開方法・配信内容に変更がある場合は、あらためてご連絡ください。',
    changes_requested: '申請内容を確認しましたが、確認または修正が必要な点があります。\n\n【確認・修正事項】\n・\n\n申請状況ページから内容を修正し、再申請をお願いします。',
    rejected: '申請内容を確認しました。\n\n審査の結果、今回は二次利用を許可できません。\nご不明な点がある場合は、support@dpi-bot.com までお問い合わせください。',
});

let selectedStatus = 'all';
let selectedId = '';
let pendingAdminAction = null;

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('refresh-btn').addEventListener('click', loadApplications);
    document.getElementById('admin-confirmation-cancel').addEventListener('click', closeAdminConfirmation);
    document.getElementById('admin-confirmation-submit').addEventListener('click', confirmAdminAction);
    document.getElementById('admin-confirmation-dialog').addEventListener('close', () => { pendingAdminAction = null; });
    for (const button of document.querySelectorAll('[data-status]')) {
        button.addEventListener('click', () => {
            selectedStatus = button.dataset.status;
            document.querySelectorAll('[data-status]').forEach((item) => item.classList.toggle('active', item === button));
            loadApplications();
        });
    }
    loadApplications();
});

async function loadApplications() {
    setStatus('申請を読み込んでいます…', 'info');
    try {
        const result = await api(`/site/reuse-admin/api/applications?status=${encodeURIComponent(selectedStatus)}`);
        document.getElementById('admin-email').textContent = result.admin;
        renderStats(result.counts);
        renderList(result.applications);
        setStatus('', '');
        if (selectedId && result.applications.some((item) => item.id === selectedId)) await loadDetail(selectedId);
    } catch (error) { setStatus(error.message, 'error'); }
}

function renderStats(counts) {
    const container = document.getElementById('stats');
    container.replaceChildren();
    const items = [
        ['審査中', counts.pending || 0], ['再申請待ち', counts.changes_requested || 0],
        ['許可', counts.approved || 0], ['却下', counts.rejected || 0],
    ];
    for (const [label, count] of items) {
        const card = element('article', 'stat');
        card.append(element('span', '', label), element('strong', '', String(count)));
        container.append(card);
    }
}

function renderList(applications) {
    const container = document.getElementById('application-list');
    container.replaceChildren();
    if (applications.length === 0) return container.append(element('p', 'empty-list', '該当する申請はありません。'));
    for (const app of applications) {
        const button = element('button', `application-item ${app.id === selectedId ? 'active' : ''}`);
        button.type = 'button';
        const badge = element('span', `badge ${app.status}`, app.statusLabel);
        const mappings = app.channelMappings || [];
        const channelSummary = mappings.length > 1 ? `#${mappings[0].channelName} ほか${mappings.length - 1}件` : `#${app.channelName}`;
        button.append(badge, element('h3', '', `${app.guildName} / ${channelSummary}`), element('p', '', `${app.reference}・第${app.revision}版`), element('p', '', `${app.discordUsername}・${formatDate(app.updatedAt)}`));
        button.addEventListener('click', () => loadDetail(app.id));
        container.append(button);
    }
}

async function loadDetail(id) {
    selectedId = id;
    document.querySelectorAll('.application-item').forEach((item) => item.classList.remove('active'));
    try {
        const result = await api(`/site/reuse-admin/api/applications/${id}`);
        renderDetail(result.application, result.events);
    } catch (error) { setStatus(error.message, 'error'); }
}

function renderDetail(app, events) {
    const container = document.getElementById('detail');
    container.className = 'detail';
    container.replaceChildren();
    const head = element('div', 'detail-head');
    const title = document.createElement('div');
    title.append(element('span', `badge ${app.status}`, app.statusLabel), element('h2', '', app.reference), element('p', '', `第${app.revision}版・更新 ${formatDate(app.updatedAt)}`));
    head.append(title);
    container.append(head);
    const details = [
        ['Discord', `${app.discordUsername} (${app.discordUserId})`],
        ['サーバー', `${app.guildName} (${app.guildId})`],
        ['チャンネル別利用設定', formatChannelMappings(app)],
        ['サーバー公開範囲', choiceLabels[app.serverPublic] || app.serverPublic],
        ['チャンネル公開範囲', choiceLabels[app.channelVisibility] || app.channelVisibility],
        ['利用方法', `${choiceLabels[app.reuseMethod] || app.reuseMethod}${app.reuseMethodOther ? `: ${app.reuseMethodOther}` : ''}`],
        ['結果通知先', app.contactEmail], ['利用目的', app.purpose],
        ['サーバー案内・公開先', app.destinationUrl || '未入力'], ['補足事項', app.notes || '未入力'],
        ['作成日時', formatDate(app.createdAt)], ['前回審査者', app.reviewedBy || '未審査'],
    ];
    const list = document.createElement('dl'); list.className = 'detail-grid';
    for (const [label, value] of details) list.append(element('dt', '', label), element('dd', '', value));
    container.append(list, messageBox(app), reviewBox(app), eventHistory(events));
}

function formatChannelMappings(app) {
    const mappings = app.channelMappings || [];
    if (!mappings.length) return '設定なし';
    return mappings.map((mapping, index) => {
        const lines = [
            `設定${index + 1}: #${mapping.channelName} (${mapping.channelId})`,
            `種別: ${mapping.announcement ? 'アナウンスチャンネル' : 'テキストチャンネル'}`,
            `配信: ${mapping.deliveryTypes.join('、')}`,
        ];
        if (mapping.announcement) lines.push(`公開操作: ${choiceLabels[mapping.announcementAutomated] || mapping.announcementAutomated}`);
        if (mapping.publishChannelDifferent) {
            lines.push(`公開先: #${mapping.publishChannelName} (${mapping.publishChannelId})`);
            lines.push(`公開先への転送: ${choiceLabels[mapping.transferAutomated] || mapping.transferAutomated}`);
            if (mapping.publishChannelType === 5) lines.push(`公開先での公開: ${choiceLabels[mapping.destinationPublishAutomated] || mapping.destinationPublishAutomated}`);
        }
        return lines.join('\n');
    }).join('\n\n');
}

function messageBox(app) {
    const box = element('section', 'message-box');
    box.append(element('h3', '', '申請者へ個別メールを送信'));
    const category = selectControl('連絡種別', 'admin-mail-category', {
        inquiry: '不明点の確認', correction: '不備の案内', other: 'その他の連絡',
    });
    const template = selectControl('定型文', 'admin-mail-template', {
        custom: '定型文を選択してください', inquiry: '不明点の確認', correction: '不備の案内', reminder: '一般的なご案内',
    });
    const subject = inputControl('件名', 'admin-mail-subject', `二次利用申請について（${app.reference}）`, 150);
    const bodyLabel = document.createElement('label');
    bodyLabel.append(document.createTextNode('本文'));
    const body = document.createElement('textarea');
    body.id = 'admin-mail-message'; body.maxLength = 5000;
    body.placeholder = '確認したい内容や修正してほしい点を入力してください。';
    bodyLabel.append(body);
    template.querySelector('select').addEventListener('change', () => applyMailTemplate());
    const send = element('button', 'mail-send', '送信内容を確認する'); send.type = 'button';
    send.addEventListener('click', () => sendMessage(app, send));
    box.append(category, template, subject, bodyLabel, send, element('p', 'box-help', `送信先: ${app.contactEmail}／申請状態は変更されません。送信内容は変更履歴へ保存されます。`));
    return box;
}

function applyMailTemplate() {
    const template = MAIL_TEMPLATES[document.getElementById('admin-mail-template').value];
    if (!template) return;
    document.getElementById('admin-mail-category').value = template.category;
    document.getElementById('admin-mail-subject').value = template.subject;
    document.getElementById('admin-mail-message').value = template.message;
}

function sendMessage(app, button) {
    const category = document.getElementById('admin-mail-category').value;
    const subject = document.getElementById('admin-mail-subject').value.trim();
    const message = document.getElementById('admin-mail-message').value.trim();
    if (!subject || !message) return setStatus('メールの件名と本文を入力してください。', 'error');
    openAdminConfirmation({ kind: 'message', app, button, category, subject, message });
}

async function executeMessage(action) {
    action.button.disabled = true;
    setStatus('申請者へメールを送信しています…', 'info');
    try {
        await api(`/site/reuse-admin/api/applications/${action.app.id}/message`, {
            method: 'POST', body: JSON.stringify({ category: action.category, subject: action.subject, message: action.message }),
        });
        setStatus('申請者へメールを送信しました。', 'success');
        await loadDetail(action.app.id);
    } catch (error) { setStatus(error.message, 'error'); action.button.disabled = false; }
}

function selectControl(labelText, id, choices) {
    const label = document.createElement('label'); label.append(document.createTextNode(labelText));
    const select = document.createElement('select'); select.id = id;
    for (const [value, text] of Object.entries(choices)) {
        const option = document.createElement('option'); option.value = value; option.textContent = text; select.append(option);
    }
    label.append(select); return label;
}

function inputControl(labelText, id, initialValue, maxLength) {
    const label = document.createElement('label'); label.append(document.createTextNode(labelText));
    const input = document.createElement('input'); input.id = id; input.type = 'text'; input.value = initialValue; input.maxLength = maxLength;
    label.append(input); return label;
}

function reviewBox(app) {
    const box = element('section', 'review-box');
    box.append(element('h3', '', '審査結果を通知'));
    const template = selectControl('定型文', 'review-template', {
        custom: '定型文を選択してください', approved: '許可', changes_requested: '不備・再申請を依頼', rejected: '却下',
    });
    const label = document.createElement('label');
    label.append(document.createTextNode('申請者へのメッセージ'));
    const textarea = document.createElement('textarea'); textarea.id = 'review-message'; textarea.maxLength = 2000; textarea.required = true; textarea.value = app.adminMessage || '';
    label.append(textarea); box.append(label);
    template.querySelector('select').addEventListener('change', () => applyReviewTemplate());
    const actions = element('div', 'review-actions');
    const options = [['approved', '許可する', 'approve'], ['changes_requested', '不備・再申請を依頼', 'changes'], ['rejected', '却下する', 'reject']];
    for (const [action, text, className] of options) {
        const button = element('button', className, text); button.type = 'button';
        button.addEventListener('click', () => review(app, action, button)); actions.append(button);
    }
    box.append(template, actions, element('p', '', '操作すると確認画面を表示します。確認後、申請状態の更新と結果メール送信を行います。再申請依頼では、新しい申請状況URLも送信します。'));
    return box;
}

function applyReviewTemplate() {
    const template = REVIEW_TEMPLATES[document.getElementById('review-template').value];
    if (template) document.getElementById('review-message').value = template;
}

function review(app, action, button) {
    const message = document.getElementById('review-message').value.trim();
    if (!message) return setStatus('申請者へのメッセージを入力してください。', 'error');
    openAdminConfirmation({ kind: 'review', app, button, action, message });
}

async function executeReview(action) {
    action.button.disabled = true;
    const label = statusLabels[action.action];
    setStatus('審査結果を保存し、メールを送信しています…', 'info');
    try {
        await api(`/site/reuse-admin/api/applications/${action.app.id}/review`, { method: 'POST', body: JSON.stringify({ action: action.action, message: action.message }) });
        setStatus(`審査結果「${label}」を保存し、メールを送信しました。`, 'success');
        await loadApplications();
    } catch (error) { setStatus(error.message, 'error'); action.button.disabled = false; }
}

function openAdminConfirmation(action) {
    pendingAdminAction = action;
    const isMessage = action.kind === 'message';
    document.getElementById('admin-confirmation-title').textContent = isMessage ? '個別メール送信の確認' : '審査結果通知の確認';
    document.getElementById('admin-confirmation-summary').textContent = isMessage
        ? '以下の内容を申請者へ送信します。'
        : '以下の内容で審査結果を確定し、申請者へ結果メールを送信します。';
    const details = document.getElementById('admin-confirmation-details'); details.replaceChildren();
    const items = isMessage
        ? [['送信先', action.app.contactEmail], ['連絡種別', document.getElementById('admin-mail-category').selectedOptions[0].textContent], ['件名', action.subject]]
        : [['受付番号', action.app.reference], ['審査結果', statusLabels[action.action]], ['送信先', action.app.contactEmail]];
    for (const [label, value] of items) details.append(element('dt', '', label), element('dd', '', value));
    document.getElementById('admin-confirmation-message').textContent = action.message;
    const submit = document.getElementById('admin-confirmation-submit');
    submit.disabled = false;
    submit.textContent = isMessage ? '内容を確認して送信' : '内容を確認して確定・送信';
    document.getElementById('admin-confirmation-dialog').showModal();
}

function closeAdminConfirmation() {
    pendingAdminAction = null;
    document.getElementById('admin-confirmation-dialog').close();
}

async function confirmAdminAction() {
    const action = pendingAdminAction;
    if (!action) return;
    document.getElementById('admin-confirmation-submit').disabled = true;
    document.getElementById('admin-confirmation-dialog').close();
    if (action.kind === 'message') await executeMessage(action);
    else await executeReview(action);
}

function eventHistory(events) {
    const section = element('section', 'events'); section.append(element('h3', '', '変更履歴'));
    for (const event of events) {
        const item = element('article', 'event');
        item.append(element('strong', '', statusLabels[event.event_type] || ({ submitted: '初回申請', resubmitted: '再申請', admin_message_sent: '個別メール送信' }[event.event_type] || event.event_type)), element('p', '', `${event.actor}${event.message ? `: ${event.message}` : ''}`), element('time', '', formatDate(event.created_at)));
        section.append(item);
    }
    return section;
}

async function api(url, options = {}) {
    const headers = { Accept: 'application/json' };
    if (options.body) headers['Content-Type'] = 'application/json';
    const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
    let body = {}; try { body = await response.json(); } catch { /* handled below */ }
    if (!response.ok) throw new Error(body.message || '処理に失敗しました。');
    return body;
}
function element(tag, className, text = '') { const item = document.createElement(tag); if (className) item.className = className; if (text) item.textContent = text; return item; }
function setStatus(message, type) { const item = document.getElementById('status'); item.textContent = message; item.className = `status ${message ? type : ''}`; }
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ja-JP'); }
