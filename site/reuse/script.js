const deliveryLabels = Object.freeze({
    eew: '緊急地震速報', earthquake: '地震情報', tsunami: '津波情報',
    weather: '気象情報', volcano: '火山情報', other: 'その他の配信',
});
const choiceLabels = Object.freeze({
    public: '公開', private: '非公開・招待制', role_limited: '指定ロールのみ',
    yes: '自動', no: '手動', not_applicable: '該当なし',
    unchanged: 'そのまま転載', edited: '編集・加工', other: 'その他',
});

let session = null;
let currentChannels = [];
let managedToken = '';
let managedApplication = null;

document.addEventListener('DOMContentLoaded', initialize);

async function initialize() {
    bindEvents();
    const params = new URLSearchParams(location.search);
    managedToken = params.get('token') || '';
    if (managedToken) {
        await loadManagedApplication();
        return;
    }
    if (params.get('oauth') === 'discord_denied') setStatus('Discordの認証がキャンセルされました。', 'error');
    await loadConfigAndSession();
}

function bindEvents() {
    document.getElementById('guild').addEventListener('change', loadChannels);
    document.getElementById('channel').addEventListener('change', updateAnnouncementChoice);
    document.getElementById('application-form').addEventListener('submit', submitApplication);
    document.getElementById('logout-btn').addEventListener('click', logout);
    document.getElementById('resubmit-form').addEventListener('submit', resubmitApplication);
    for (const input of document.querySelectorAll('input[name="reuse-method"]')) {
        input.addEventListener('change', toggleReuseOther);
    }
}

async function loadConfigAndSession() {
    try {
        const config = await api('/api/reuse/config');
        if (!config.configured) {
            const labels = {
                database: '申請データベース',
                discord: 'Discord連携',
                session: 'セッション保護',
                email: '結果メール送信',
            };
            const incomplete = Object.entries(config.configuration || {})
                .filter(([, ready]) => !ready)
                .map(([key]) => labels[key] || key);
            throw new Error(
                incomplete.length
                    ? `二次利用申請フォームの設定が不足しています（${incomplete.join('・')}）。`
                    : '二次利用申請フォームは現在設定中です。',
            );
        }
        renderDeliveryTypes(config.deliveryTypes);
        try {
            session = await api('/api/reuse/session');
            showApplicationForm();
        } catch (error) {
            if (error.code !== 'login_required' && error.code !== 'session_expired') throw error;
            document.getElementById('login-panel').classList.remove('hidden');
        }
    } catch (error) {
        setStatus(error.message, 'error');
        document.getElementById('discord-login').classList.add('hidden');
    }
}

function renderDeliveryTypes(types) {
    const container = document.getElementById('delivery-types');
    container.replaceChildren();
    for (const type of types) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.name = 'delivery-type';
        input.value = type.id;
        label.append(input, document.createTextNode(type.label));
        container.append(label);
    }
}

function showApplicationForm() {
    document.getElementById('login-panel').classList.add('hidden');
    document.getElementById('application-panel').classList.remove('hidden');
    document.getElementById('account-name').textContent = session.user.username;
    const guildSelect = document.getElementById('guild');
    for (const guild of session.guilds) guildSelect.append(option(guild.id, guild.name));
    if (session.guilds.length === 0) {
        guildSelect.disabled = true;
        setStatus('管理権限を確認できるDiscordサーバーがありません。', 'error');
    } else {
        setStatus('Discordとの接続を確認しました。申請内容を入力してください。', 'success');
    }
}

async function loadChannels() {
    const select = document.getElementById('channel');
    select.disabled = true;
    select.replaceChildren(option('', 'チャンネルを取得中…'));
    currentChannels = [];
    const guildId = document.getElementById('guild').value;
    if (!guildId) {
        select.replaceChildren(option('', '先にサーバーを選択してください'));
        return;
    }
    try {
        const result = await api(`/api/reuse/channels?guild_id=${encodeURIComponent(guildId)}`);
        currentChannels = result.channels;
        select.replaceChildren(option('', '選択してください'));
        for (const channel of currentChannels) {
            const suffix = channel.announcement ? '（アナウンス）' : '';
            select.append(option(channel.id, `#${channel.name}${suffix}`));
        }
        select.disabled = false;
        document.getElementById('channel-help').textContent = currentChannels.length
            ? `${currentChannels.length}件のチャンネルを取得しました。`
            : '選択できるテキストチャンネルがありません。';
    } catch (error) {
        select.replaceChildren(option('', '取得できませんでした'));
        document.getElementById('channel-help').textContent = error.message;
        setStatus(error.message, 'error');
    }
}

function updateAnnouncementChoice() {
    const channel = selectedChannel();
    const values = document.querySelectorAll('input[name="announcement-automated"]');
    for (const input of values) input.disabled = !channel?.announcement && input.value !== 'not_applicable';
    if (!channel?.announcement) {
        document.querySelector('input[name="announcement-automated"][value="not_applicable"]').checked = true;
    } else {
        document.querySelector('input[name="announcement-automated"][value="not_applicable"]').checked = false;
    }
}

function toggleReuseOther() {
    const other = checkedValue('reuse-method') === 'other';
    document.getElementById('reuse-other-wrap').classList.toggle('hidden', !other);
    document.getElementById('reuse-other').required = other;
}

async function submitApplication(event) {
    event.preventDefault();
    const channel = selectedChannel();
    if (!channel) return setStatus('利用チャンネルを選択してください。', 'error');
    const button = document.getElementById('submit-btn');
    button.disabled = true;
    setStatus('申請を送信しています…', 'info');
    try {
        const result = await api('/api/reuse/applications', {
            method: 'POST',
            headers: { 'X-Reuse-CSRF': session.csrfToken },
            body: JSON.stringify(applicationPayload(channel)),
        });
        const url = new URL(location.href);
        url.search = '';
        url.searchParams.set('token', result.manageToken);
        history.replaceState(null, '', url);
        document.getElementById('application-panel').classList.add('hidden');
        document.getElementById('result-panel').classList.remove('hidden');
        const box = element('div', 'success-box');
        box.append(
            element('strong', '', '申請を受け付けました'),
            element('p', '', `受付番号: ${result.reference}`),
            element('p', '', result.emailSent
                ? '確認メールを送信しました。審査結果も同じメールアドレスへお送りします。'
                : '確認メールを送信できませんでした。この申請状況ページを保存し、必要に応じてsupport@dpi-bot.comへご連絡ください。'),
        );
        document.getElementById('application-status').replaceChildren(box);
        setStatus('', '');
    } catch (error) {
        setStatus(error.message, 'error');
        button.disabled = false;
    }
}

function applicationPayload(channel) {
    return {
        guildId: document.getElementById('guild').value,
        channelId: channel.id,
        channelType: channel.type,
        deliveryTypes: checkedValues('delivery-type'),
        serverPublic: checkedValue('server-public'),
        channelVisibility: checkedValue('channel-visibility'),
        announcementAutomated: checkedValue('announcement-automated'),
        reuseMethod: checkedValue('reuse-method'),
        reuseMethodOther: document.getElementById('reuse-other').value,
        email: document.getElementById('email').value,
        purpose: document.getElementById('purpose').value,
        destinationUrl: document.getElementById('destination-url').value,
        notes: document.getElementById('notes').value,
        authorized: document.getElementById('authorized').checked,
        consent: document.getElementById('consent').checked,
    };
}

async function loadManagedApplication() {
    document.getElementById('login-panel').classList.add('hidden');
    try {
        const result = await api(`/api/reuse/manage?token=${encodeURIComponent(managedToken)}`);
        managedApplication = result.application;
        renderManagedApplication();
    } catch (error) {
        setStatus(error.message, 'error');
    }
}

function renderManagedApplication() {
    document.getElementById('result-panel').classList.remove('hidden');
    const app = managedApplication;
    const container = document.getElementById('application-status');
    container.replaceChildren();
    const badge = element('span', `status-badge ${app.status}`, app.statusLabel);
    const title = element('h3', '', `${app.reference}（第${app.revision}版）`);
    container.append(badge, title);
    if (app.adminMessage) container.append(element('div', 'admin-message', app.adminMessage));
    const list = document.createElement('dl');
    list.className = 'detail-grid';
    const details = [
        ['Discord', app.discordUsername], ['サーバー', `${app.guildName} (${app.guildId})`],
        ['チャンネル', `#${app.channelName} (${app.channelId})`],
        ['配信', app.deliveryTypes.map((id) => deliveryLabels[id] || id).join('、')],
        ['サーバー公開範囲', choiceLabels[app.serverPublic] || app.serverPublic],
        ['チャンネル公開範囲', choiceLabels[app.channelVisibility] || app.channelVisibility],
        ['アナウンス公開', choiceLabels[app.announcementAutomated] || app.announcementAutomated],
        ['利用方法', choiceLabels[app.reuseMethod] || app.reuseMethod],
        ['連絡先', app.contactEmail], ['利用目的', app.purpose],
        ['公開先URL', app.destinationUrl || '未入力'], ['補足', app.notes || '未入力'],
        ['更新日時', formatDate(app.updatedAt)],
    ];
    for (const [label, value] of details) list.append(element('dt', '', label), element('dd', '', value));
    container.append(list);
    if (app.status === 'changes_requested') renderResubmitForm(app);
}

function renderResubmitForm(app) {
    const form = document.getElementById('resubmit-form');
    form.classList.remove('hidden');
    const fields = document.getElementById('resubmit-fields');
    fields.replaceChildren();
    fields.append(
        checkboxGroup('再申請する配信', 'resubmit-delivery', deliveryLabels, app.deliveryTypes),
        selectField('サーバー公開範囲', 'resubmit-server-public', { public: '公開サーバー', private: '非公開・招待制' }, app.serverPublic),
        selectField('チャンネル公開範囲', 'resubmit-channel-visibility', { public: '誰でも閲覧可能', role_limited: '指定ロールのみ' }, app.channelVisibility),
        selectField('アナウンス公開', 'resubmit-announcement', { yes: '自動', no: '手動', not_applicable: '該当なし' }, app.announcementAutomated),
        selectField('利用方法', 'resubmit-method', { unchanged: 'そのまま転載', edited: '編集・加工', other: 'その他' }, app.reuseMethod),
        textAreaField('その他の利用方法', 'resubmit-method-other', app.reuseMethodOther, 500),
        inputField('結果通知先メールアドレス（再入力）', 'resubmit-email', '', 'email'),
        textAreaField('利用目的', 'resubmit-purpose', app.purpose, 2000),
        inputField('サーバー案内・公開先URL', 'resubmit-url', app.destinationUrl, 'url'),
        textAreaField('補足事項', 'resubmit-notes', app.notes, 2000),
    );
}

async function resubmitApplication(event) {
    event.preventDefault();
    const button = document.getElementById('resubmit-btn');
    button.disabled = true;
    setStatus('再申請しています…', 'info');
    try {
        const result = await api(`/api/reuse/manage?token=${encodeURIComponent(managedToken)}`, {
            method: 'PUT',
            body: JSON.stringify({
                deliveryTypes: checkedValues('resubmit-delivery'),
                serverPublic: value('resubmit-server-public'),
                channelVisibility: value('resubmit-channel-visibility'),
                announcementAutomated: value('resubmit-announcement'),
                reuseMethod: value('resubmit-method'),
                reuseMethodOther: value('resubmit-method-other'),
                email: value('resubmit-email'), purpose: value('resubmit-purpose'),
                destinationUrl: value('resubmit-url'), notes: value('resubmit-notes'),
                authorized: document.getElementById('resubmit-authorized').checked,
                consent: document.getElementById('resubmit-consent').checked,
            }),
        });
        setStatus(
            result.emailSent
                ? `第${result.revision}版として再申請しました。確認メールを送信しました。`
                : `第${result.revision}版として再申請しましたが、確認メールを送信できませんでした。`,
            result.emailSent ? 'success' : 'error',
        );
        await loadManagedApplication();
    } catch (error) {
        setStatus(error.message, 'error');
        button.disabled = false;
    }
}

async function logout() {
    await api('/api/reuse/logout', { method: 'POST', body: '{}' });
    location.href = '/site/reuse/';
}

async function api(url, options = {}) {
    const headers = { Accept: 'application/json', ...(options.headers || {}) };
    if (options.body) headers['Content-Type'] = 'application/json';
    const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
    let body = {};
    try { body = await response.json(); } catch { /* handled below */ }
    if (!response.ok) {
        const error = new Error(body.message || '処理に失敗しました。');
        error.code = body.code;
        throw error;
    }
    return body;
}

function selectedChannel() { return currentChannels.find((channel) => channel.id === document.getElementById('channel').value); }
function checkedValues(name) { return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value); }
function checkedValue(name) { return document.querySelector(`input[name="${name}"]:checked`)?.value || ''; }
function value(id) { return document.getElementById(id).value; }
function option(valueText, label, selected = false) { const item = document.createElement('option'); item.value = valueText; item.textContent = label; item.selected = selected; return item; }
function element(tag, className, text = '') { const item = document.createElement(tag); if (className) item.className = className; if (text) item.textContent = text; return item; }
function setStatus(message, type) { const item = document.getElementById('global-status'); item.textContent = message; item.className = `status ${message ? type : ''}`; }
function formatDate(valueText) { const date = new Date(valueText); return Number.isNaN(date.getTime()) ? valueText : date.toLocaleString('ja-JP'); }

function checkboxGroup(labelText, name, choices, selected) {
    const fieldset = document.createElement('fieldset');
    fieldset.append(element('legend', '', labelText));
    const grid = element('div', 'check-grid');
    for (const [id, labelTextValue] of Object.entries(choices)) {
        const label = document.createElement('label');
        const input = document.createElement('input'); input.type = 'checkbox'; input.name = name; input.value = id; input.checked = selected.includes(id);
        label.append(input, document.createTextNode(labelTextValue)); grid.append(label);
    }
    fieldset.append(grid); return fieldset;
}
function selectField(labelText, id, choices, selected) {
    const label = document.createElement('label'); label.append(document.createTextNode(labelText));
    const select = document.createElement('select'); select.id = id; select.required = true;
    for (const [choice, text] of Object.entries(choices)) select.append(option(choice, text, choice === selected));
    label.append(select); return label;
}
function inputField(labelText, id, initial, type) {
    const label = document.createElement('label'); label.append(document.createTextNode(labelText));
    const input = document.createElement('input'); input.id = id; input.type = type; input.value = initial || ''; input.required = type === 'email'; input.maxLength = type === 'email' ? 254 : 500;
    label.append(input); return label;
}
function textAreaField(labelText, id, initial, maxLength) {
    const label = document.createElement('label'); label.append(document.createTextNode(labelText));
    const textarea = document.createElement('textarea'); textarea.id = id; textarea.rows = 4; textarea.maxLength = maxLength; textarea.value = initial || ''; if (id === 'resubmit-purpose') { textarea.required = true; textarea.minLength = 10; }
    label.append(textarea); return label;
}
