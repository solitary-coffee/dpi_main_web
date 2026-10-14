const choiceLabels = Object.freeze({
    public: '公開', private: '非公開・招待制', role_limited: '指定ロールのみ',
    yes: '自動', no: '手動', not_applicable: '該当なし',
    unchanged: 'そのまま転載', edited: '編集・加工', other: 'その他',
});
const deliveryStatusLabels = Object.freeze({ active: '', adjusting: '（調整中）', ending: '（終了予定）', preparing: '（配信準備中）' });

let session = null;
let currentChannels = [];
let deliveryCatalog = [];
let deliveryLabels = Object.create(null);
let managedToken = '';
let managedApplication = null;
let mappingCounter = 0;

document.addEventListener('DOMContentLoaded', initialize);

async function initialize() {
    bindEvents();
    const params = new URLSearchParams(location.search);
    managedToken = params.get('token') || '';
    try {
        const config = await api('/api/reuse/config');
        setDeliveryCatalog(config.deliveryTypes || []);
        if (managedToken) {
            await loadManagedApplication();
            return;
        }
        if (params.get('oauth') === 'discord_denied') setStatus('Discordの認証がキャンセルされました。', 'error');
        await loadConfigAndSession(config);
    } catch (error) {
        setStatus(error.message, 'error');
        document.getElementById('discord-login').classList.add('hidden');
    }
}

function bindEvents() {
    document.getElementById('guild').addEventListener('change', loadChannels);
    document.getElementById('add-channel-mapping').addEventListener('click', () => addChannelMapping());
    document.getElementById('application-form').addEventListener('submit', submitApplication);
    document.getElementById('logout-btn').addEventListener('click', logout);
    document.getElementById('resubmit-form').addEventListener('submit', resubmitApplication);
    for (const input of document.querySelectorAll('input[name="reuse-method"]')) input.addEventListener('change', toggleReuseOther);
}

function setDeliveryCatalog(types) {
    deliveryCatalog = types;
    deliveryLabels = Object.fromEntries(types.map((type) => [type.id, type.label]));
}

async function loadConfigAndSession(config) {
    if (!config.configured) {
        const labels = { database: '申請データベース', discord: 'Discord連携', session: 'セッション保護', email: '結果メール送信' };
        const incomplete = Object.entries(config.configuration || {}).filter(([, ready]) => !ready).map(([key]) => labels[key] || key);
        throw new Error(incomplete.length
            ? `二次利用申請フォームの設定が不足しています（${incomplete.join('・')}）。`
            : '二次利用申請フォームは現在設定中です。');
    }
    session = await api('/api/reuse/session');
    if (!session.authenticated) {
        document.getElementById('login-panel').classList.remove('hidden');
        return;
    }
    showApplicationForm();
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
    currentChannels = [];
    document.getElementById('channel-mappings').replaceChildren();
    const addButton = document.getElementById('add-channel-mapping');
    addButton.disabled = true;
    const guildId = document.getElementById('guild').value;
    if (!guildId) {
        document.getElementById('channel-help').textContent = '先にサーバーを選択してください。';
        return;
    }
    document.getElementById('channel-help').textContent = 'チャンネルを取得しています…';
    try {
        const result = await api(`/api/reuse/channels?guild_id=${encodeURIComponent(guildId)}`);
        currentChannels = result.channels;
        document.getElementById('channel-help').textContent = currentChannels.length
            ? `${currentChannels.length}件のチャンネルを取得しました。`
            : '選択できるテキストチャンネルがありません。';
        if (currentChannels.length) {
            addButton.disabled = false;
            addChannelMapping();
        }
    } catch (error) {
        document.getElementById('channel-help').textContent = error.message;
        setStatus(error.message, 'error');
    }
}

function addChannelMapping(initial = null) {
    const container = document.getElementById('channel-mappings');
    if (container.children.length >= 10) return setStatus('利用設定は最大10件です。', 'error');
    const index = mappingCounter++;
    const card = element('article', 'mapping-card');
    card.dataset.mappingIndex = String(index);
    const head = element('div', 'mapping-head');
    head.append(element('h3', '', `利用設定 ${container.children.length + 1}`));
    const remove = element('button', 'mapping-remove', '削除');
    remove.type = 'button';
    remove.addEventListener('click', () => { card.remove(); renumberMappings(); });
    head.append(remove);

    const channelLabel = document.createElement('label');
    channelLabel.append(document.createTextNode('利用するチャンネル'));
    const channelSelect = document.createElement('select');
    channelSelect.className = 'mapping-channel';
    channelSelect.required = true;
    channelSelect.append(option('', '選択してください'));
    for (const channel of currentChannels) channelSelect.append(option(channel.id, `#${channel.name}${channel.announcement ? '（アナウンス）' : ''}`, channel.id === initial?.channelId));
    channelLabel.append(channelSelect);

    const announcementGroup = element('div', 'choice-group announcement-choice');
    announcementGroup.append(element('span', 'field-label', 'このチャンネルはアナウンスチャンネルですか？'));
    const announcementName = `mapping-announcement-${index}`;
    for (const [valueText, labelText] of [['yes', 'はい'], ['no', 'いいえ']]) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio'; input.name = announcementName; input.value = valueText;
        input.addEventListener('change', () => updateAnnouncementControls(card));
        label.append(input, document.createTextNode(labelText)); announcementGroup.append(label);
    }

    const automationGroup = element('div', 'choice-group mapping-automation hidden');
    automationGroup.append(element('span', 'field-label', 'アナウンスチャンネルの「公開」は自動化していますか？'));
    const automationName = `mapping-automation-${index}`;
    for (const [valueText, labelText] of [['yes', '自動化している'], ['no', '手動で公開する']]) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio'; input.name = automationName; input.value = valueText;
        input.checked = initial?.announcementAutomated === valueText;
        label.append(input, document.createTextNode(labelText)); automationGroup.append(label);
    }

    const differentLabel = document.createElement('label');
    differentLabel.className = 'consent publish-different';
    const different = document.createElement('input');
    different.type = 'checkbox'; different.checked = initial?.publishChannelDifferent === true;
    differentLabel.append(different, document.createTextNode('公開するチャンネルが利用チャンネルと異なる'));
    const publishLabel = document.createElement('label');
    publishLabel.className = `publish-channel ${different.checked ? '' : 'hidden'}`;
    publishLabel.append(document.createTextNode('公開先チャンネル'));
    const publishSelect = document.createElement('select');
    publishSelect.append(option('', '選択してください'));
    for (const channel of currentChannels) publishSelect.append(option(channel.id, `#${channel.name}${channel.announcement ? '（アナウンス）' : ''}`, channel.id === initial?.publishChannelId));
    publishLabel.append(publishSelect);
    const publishAutomation = element('div', `choice-group publish-automation ${different.checked ? '' : 'hidden'}`);
    publishAutomation.append(element('span', 'field-label', '公開先チャンネルへの配信は自動化していますか？'));
    const publishAutomationName = `mapping-publish-automation-${index}`;
    for (const [valueText, labelText] of [['yes', '自動化している'], ['no', '手動で配信する']]) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio'; input.name = publishAutomationName; input.value = valueText;
        input.checked = initial?.publishAutomated === valueText;
        label.append(input, document.createTextNode(labelText)); publishAutomation.append(label);
    }
    different.addEventListener('change', () => {
        publishLabel.classList.toggle('hidden', !different.checked);
        publishAutomation.classList.toggle('hidden', !different.checked);
        publishSelect.required = different.checked;
        if (!different.checked) publishSelect.value = '';
        else if (!publishAutomation.querySelector('input:checked')) publishAutomation.querySelector('input[value="no"]').checked = true;
    });
    publishSelect.required = different.checked;
    if (different.checked && !publishAutomation.querySelector('input:checked')) publishAutomation.querySelector('input[value="no"]').checked = true;

    const deliveryField = document.createElement('fieldset');
    deliveryField.className = 'mapping-deliveries';
    deliveryField.append(element('legend', '', 'このチャンネルで二次利用する配信（複数選択可）'));
    deliveryField.append(deliveryCheckboxGrid(`mapping-delivery-${index}`, initial?.deliveryTypes || []));
    const source = element('p', 'help');
    const sourceLink = document.createElement('a');
    sourceLink.href = '../info/index.html'; sourceLink.target = '_blank'; sourceLink.rel = 'noopener noreferrer'; sourceLink.textContent = '公式サイトの配信内容一覧';
    source.append(document.createTextNode('選択肢は '), sourceLink, document.createTextNode(' の申請名を使用しています。'));

    card.append(head, channelLabel, announcementGroup, automationGroup, differentLabel, publishLabel, publishAutomation, deliveryField, source);
    channelSelect.addEventListener('change', () => updateMappingChannel(card));
    container.append(card);
    updateMappingChannel(card);
    renumberMappings();
}

function deliveryCheckboxGrid(name, selected) {
    const grid = element('div', 'check-grid delivery-catalog');
    for (const type of deliveryCatalog) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox'; input.name = name; input.value = type.id; input.checked = selected.includes(type.id);
        label.append(input, document.createTextNode(`${type.label}${deliveryStatusLabels[type.status] || ''}`));
        grid.append(label);
    }
    return grid;
}

function updateMappingChannel(card) {
    const channel = currentChannels.find((item) => item.id === card.querySelector('.mapping-channel').value);
    const announcement = channel?.announcement === true;
    const announcementInput = card.querySelector(`input[value="${announcement ? 'yes' : 'no'}"][name^="mapping-announcement-"]`);
    if (announcementInput) announcementInput.checked = true;
    updateAnnouncementControls(card);
}

function updateAnnouncementControls(card) {
    const announcement = card.querySelector('input[name^="mapping-announcement-"]:checked')?.value === 'yes';
    const automation = card.querySelector('.mapping-automation');
    automation.classList.toggle('hidden', !announcement);
    if (announcement && !automation.querySelector('input:checked')) automation.querySelector('input[value="no"]').checked = true;
}

function renumberMappings() {
    [...document.querySelectorAll('.mapping-card')].forEach((card, index) => { card.querySelector('.mapping-head h3').textContent = `利用設定 ${index + 1}`; });
}

function collectChannelMappings() {
    const cards = [...document.querySelectorAll('.mapping-card')];
    if (!cards.length) throw new Error('利用チャンネルと配信の組み合わせを追加してください。');
    return cards.map((card) => {
        const channel = currentChannels.find((item) => item.id === card.querySelector('.mapping-channel').value);
        if (!channel) throw new Error('利用チャンネルを選択してください。');
        const deliveryTypes = [...card.querySelectorAll('.mapping-deliveries input:checked')].map((input) => input.value);
        if (!deliveryTypes.length) throw new Error(`#${channel.name}で二次利用する配信を1つ以上選択してください。`);
        const different = card.querySelector('.publish-different input').checked;
        const publishChannelId = card.querySelector('.publish-channel select').value;
        if (different && !publishChannelId) throw new Error('公開先チャンネルを選択してください。');
        const announcement = card.querySelector('input[name^="mapping-announcement-"]:checked')?.value === 'yes';
        const publishAutomated = different ? (card.querySelector('.publish-automation input:checked')?.value || '') : 'not_applicable';
        if (different && !publishAutomated) throw new Error('公開先チャンネルへの配信が自動か手動かを選択してください。');
        return {
            channelId: channel.id,
            announcement,
            announcementAutomated: announcement
                ? (card.querySelector('.mapping-automation input:checked')?.value || '')
                : 'not_applicable',
            publishChannelDifferent: different,
            publishChannelId: different ? publishChannelId : '',
            publishAutomated,
            deliveryTypes,
        };
    });
}

function toggleReuseOther() {
    const other = checkedValue('reuse-method') === 'other';
    document.getElementById('reuse-other-wrap').classList.toggle('hidden', !other);
    document.getElementById('reuse-other').required = other;
}

async function submitApplication(event) {
    event.preventDefault();
    const button = document.getElementById('submit-btn');
    button.disabled = true;
    setStatus('申請を送信しています…', 'info');
    try {
        const result = await api('/api/reuse/applications', {
            method: 'POST', headers: { 'X-Reuse-CSRF': session.csrfToken }, body: JSON.stringify(applicationPayload()),
        });
        const url = new URL(location.href); url.search = ''; url.searchParams.set('token', result.manageToken); history.replaceState(null, '', url);
        document.getElementById('application-panel').classList.add('hidden');
        document.getElementById('result-panel').classList.remove('hidden');
        const box = element('div', 'success-box');
        box.append(element('strong', '', '申請を受け付けました'), element('p', '', `受付番号: ${result.reference}`), element('p', '', result.emailSent
            ? '確認メールを送信しました。審査結果も同じメールアドレスへお送りします。'
            : '確認メールを送信できませんでした。この申請状況ページを保存し、必要に応じてsupport@dpi-bot.comへご連絡ください。'));
        document.getElementById('application-status').replaceChildren(box); setStatus('', '');
    } catch (error) { setStatus(error.message, 'error'); button.disabled = false; }
}

function applicationPayload() {
    return {
        guildId: document.getElementById('guild').value,
        channelMappings: collectChannelMappings(),
        serverPublic: checkedValue('server-public'), channelVisibility: checkedValue('channel-visibility'),
        reuseMethod: checkedValue('reuse-method'), reuseMethodOther: value('reuse-other'),
        email: value('email'), emailConfirm: value('email-confirm'), purpose: value('purpose'),
        destinationUrl: value('destination-url'), notes: value('notes'),
        authorized: document.getElementById('authorized').checked, consent: document.getElementById('consent').checked,
    };
}

async function loadManagedApplication() {
    document.getElementById('login-panel').classList.add('hidden');
    try { const result = await api(`/api/reuse/manage?token=${encodeURIComponent(managedToken)}`); managedApplication = result.application; renderManagedApplication(); }
    catch (error) { setStatus(error.message, 'error'); }
}

function renderManagedApplication() {
    document.getElementById('result-panel').classList.remove('hidden');
    const app = managedApplication;
    const container = document.getElementById('application-status'); container.replaceChildren();
    container.append(element('span', `status-badge ${app.status}`, app.statusLabel), element('h3', '', `${app.reference}（第${app.revision}版）`));
    if (app.adminMessage) container.append(element('div', 'admin-message', app.adminMessage));
    const list = document.createElement('dl'); list.className = 'detail-grid';
    const mappingText = app.channelMappings.map((mapping, index) => formatMapping(mapping, index)).join('\n\n');
    const details = [
        ['Discord', app.discordUsername], ['サーバー', `${app.guildName} (${app.guildId})`], ['チャンネル別利用設定', mappingText],
        ['サーバー公開範囲', choiceLabels[app.serverPublic] || app.serverPublic], ['チャンネル公開範囲', choiceLabels[app.channelVisibility] || app.channelVisibility],
        ['利用方法', choiceLabels[app.reuseMethod] || app.reuseMethod], ['連絡先', app.contactEmail], ['利用目的', app.purpose],
        ['公開先URL', app.destinationUrl || '未入力'], ['補足', app.notes || '未入力'], ['更新日時', formatDate(app.updatedAt)],
    ];
    for (const [label, text] of details) list.append(element('dt', '', label), element('dd', '', text));
    container.append(list); if (app.status === 'changes_requested') renderResubmitForm(app);
}

function formatMapping(mapping, index) {
    const parts = [`設定${index + 1}: #${mapping.channelName}${mapping.announcement ? '（アナウンス）' : ''}`];
    parts.push(`配信: ${mapping.deliveryTypes.map((id) => deliveryLabels[id] || id).join('、')}`);
    if (mapping.announcement) parts.push(`公開操作: ${choiceLabels[mapping.announcementAutomated] || mapping.announcementAutomated}`);
    if (mapping.publishChannelDifferent) {
        parts.push(`公開先: #${mapping.publishChannelName}`);
        parts.push(`公開先への配信: ${choiceLabels[mapping.publishAutomated] || mapping.publishAutomated}`);
    }
    return parts.join('\n');
}

function renderResubmitForm(app) {
    const form = document.getElementById('resubmit-form'); form.classList.remove('hidden');
    const fields = document.getElementById('resubmit-fields'); fields.replaceChildren();
    const mappingField = document.createElement('fieldset'); mappingField.append(element('legend', '', 'チャンネル別の配信設定'));
    app.channelMappings.forEach((mapping, index) => {
        const card = element('section', 'resubmit-mapping');
        card.append(element('h4', '', `#${mapping.channelName}${mapping.publishChannelDifferent ? ` → #${mapping.publishChannelName}` : ''}`));
        card.append(deliveryCheckboxGrid(`resubmit-delivery-${index}`, mapping.deliveryTypes));
        if (mapping.announcement) card.append(selectField('公開操作', `resubmit-announcement-${index}`, { yes: '自動', no: '手動' }, mapping.announcementAutomated));
        if (mapping.publishChannelDifferent) card.append(selectField('公開先への配信', `resubmit-publish-automation-${index}`, { yes: '自動', no: '手動' }, mapping.publishAutomated));
        mappingField.append(card);
    });
    fields.append(
        mappingField,
        selectField('サーバー公開範囲', 'resubmit-server-public', { public: '公開サーバー', private: '非公開・招待制' }, app.serverPublic),
        selectField('チャンネル公開範囲', 'resubmit-channel-visibility', { public: '誰でも閲覧可能', role_limited: '指定ロールのみ' }, app.channelVisibility),
        selectField('利用方法', 'resubmit-method', { unchanged: 'そのまま転載', edited: '編集・加工', other: 'その他' }, app.reuseMethod),
        textAreaField('その他の利用方法', 'resubmit-method-other', app.reuseMethodOther, 500),
        inputField('結果通知先メールアドレス', 'resubmit-email', '', 'email'),
        inputField('結果通知先メールアドレス（確認）', 'resubmit-email-confirm', '', 'email'),
        textAreaField('利用目的', 'resubmit-purpose', app.purpose, 2000),
        inputField('サーバー案内・公開先URL', 'resubmit-url', app.destinationUrl, 'url'),
        textAreaField('補足事項', 'resubmit-notes', app.notes, 2000),
    );
}

async function resubmitApplication(event) {
    event.preventDefault(); const button = document.getElementById('resubmit-btn'); button.disabled = true; setStatus('再申請しています…', 'info');
    try {
        const channelMappings = managedApplication.channelMappings.map((mapping, index) => ({
            channelId: mapping.channelId, publishChannelId: mapping.publishChannelId,
            announcementAutomated: mapping.announcement ? value(`resubmit-announcement-${index}`) : 'not_applicable',
            publishAutomated: mapping.publishChannelDifferent ? value(`resubmit-publish-automation-${index}`) : 'not_applicable',
            deliveryTypes: checkedValues(`resubmit-delivery-${index}`),
        }));
        const result = await api(`/api/reuse/manage?token=${encodeURIComponent(managedToken)}`, { method: 'PUT', body: JSON.stringify({
            channelMappings, serverPublic: value('resubmit-server-public'), channelVisibility: value('resubmit-channel-visibility'),
            reuseMethod: value('resubmit-method'), reuseMethodOther: value('resubmit-method-other'),
            email: value('resubmit-email'), emailConfirm: value('resubmit-email-confirm'), purpose: value('resubmit-purpose'),
            destinationUrl: value('resubmit-url'), notes: value('resubmit-notes'),
            authorized: document.getElementById('resubmit-authorized').checked, consent: document.getElementById('resubmit-consent').checked,
        }) });
        setStatus(result.emailSent ? `第${result.revision}版として再申請し、確認メールを送信しました。` : `第${result.revision}版として再申請しましたが、確認メールを送信できませんでした。`, result.emailSent ? 'success' : 'error');
        await loadManagedApplication();
    } catch (error) { setStatus(error.message, 'error'); button.disabled = false; }
}

async function logout() { await api('/api/reuse/logout', { method: 'POST', body: '{}' }); location.href = '/site/reuse/'; }
async function api(url, options = {}) { const headers = { Accept: 'application/json', ...(options.headers || {}) }; if (options.body) headers['Content-Type'] = 'application/json'; const response = await fetch(url, { ...options, headers, credentials: 'same-origin' }); let body = {}; try { body = await response.json(); } catch { /* handled below */ } if (!response.ok) { const error = new Error(body.message || '処理に失敗しました。'); error.code = body.code; throw error; } return body; }
function checkedValues(name) { return [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value); }
function checkedValue(name) { return document.querySelector(`input[name="${name}"]:checked`)?.value || ''; }
function value(id) { return document.getElementById(id).value; }
function option(valueText, label, selected = false) { const item = document.createElement('option'); item.value = valueText; item.textContent = label; item.selected = selected; return item; }
function element(tag, className, text = '') { const item = document.createElement(tag); if (className) item.className = className; if (text) item.textContent = text; return item; }
function setStatus(message, type) { const item = document.getElementById('global-status'); item.textContent = message; item.className = `form-status ${message ? type : ''}`; }
function formatDate(valueText) { const date = new Date(valueText); return Number.isNaN(date.getTime()) ? valueText : date.toLocaleString('ja-JP'); }
function selectField(labelText, id, choices, selected) { const label = document.createElement('label'); label.append(document.createTextNode(labelText)); const select = document.createElement('select'); select.id = id; select.required = true; for (const [choice, text] of Object.entries(choices)) select.append(option(choice, text, choice === selected)); label.append(select); return label; }
function inputField(labelText, id, initial, type) { const label = document.createElement('label'); label.append(document.createTextNode(labelText)); const input = document.createElement('input'); input.id = id; input.type = type; input.value = initial || ''; input.required = type === 'email'; input.maxLength = type === 'email' ? 254 : 500; label.append(input); return label; }
function textAreaField(labelText, id, initial, maxLength) { const label = document.createElement('label'); label.append(document.createTextNode(labelText)); const textarea = document.createElement('textarea'); textarea.id = id; textarea.rows = 4; textarea.maxLength = maxLength; textarea.value = initial || ''; if (id === 'resubmit-purpose') { textarea.required = true; textarea.minLength = 10; } label.append(textarea); return label; }
