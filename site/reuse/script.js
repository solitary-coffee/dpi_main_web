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
let pendingSubmission = null;

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
    document.getElementById('confirmation-back').addEventListener('click', closeConfirmation);
    document.getElementById('confirmation-submit').addEventListener('click', confirmSubmission);
    document.getElementById('confirmation-dialog').addEventListener('close', () => { pendingSubmission = null; });
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
    const transferAutomation = element('div', `choice-group transfer-automation ${different.checked ? '' : 'hidden'}`);
    transferAutomation.append(element('span', 'field-label', '利用チャンネルから公開先チャンネルへの転送は自動ですか？'));
    const transferAutomationName = `mapping-transfer-automation-${index}`;
    for (const [valueText, labelText] of [['yes', '自動化している'], ['no', '手動で配信する']]) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio'; input.name = transferAutomationName; input.value = valueText;
        input.checked = initial?.transferAutomated === valueText;
        label.append(input, document.createTextNode(labelText)); transferAutomation.append(label);
    }
    const destinationAutomation = element('div', 'choice-group destination-automation hidden');
    destinationAutomation.append(element('span', 'field-label', '公開先アナウンスチャンネルの「公開」は自動化していますか？'));
    const destinationAutomationName = `mapping-destination-automation-${index}`;
    for (const [valueText, labelText] of [['yes', '自動化している'], ['no', '手動で公開する']]) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio'; input.name = destinationAutomationName; input.value = valueText;
        input.checked = initial?.destinationPublishAutomated === valueText;
        label.append(input, document.createTextNode(labelText)); destinationAutomation.append(label);
    }
    different.addEventListener('change', () => {
        publishLabel.classList.toggle('hidden', !different.checked);
        publishSelect.required = different.checked;
        if (!different.checked) publishSelect.value = '';
        updatePublishControls(card);
    });
    publishSelect.addEventListener('change', () => updatePublishControls(card));
    publishSelect.required = different.checked;

    const deliveryField = document.createElement('fieldset');
    deliveryField.className = 'mapping-deliveries';
    deliveryField.append(element('legend', '', 'このチャンネルで二次利用する配信（複数選択可）'));
    deliveryField.append(deliveryCheckboxGrid(`mapping-delivery-${index}`, initial?.deliveryTypes || []));
    const source = element('p', 'help');
    const sourceLink = document.createElement('a');
    sourceLink.href = '../info/index.html'; sourceLink.target = '_blank'; sourceLink.rel = 'noopener noreferrer'; sourceLink.textContent = '公式サイトの配信内容一覧';
    source.append(document.createTextNode('選択肢は '), sourceLink, document.createTextNode(' の申請名を使用しています。'));

    card.append(head, channelLabel, announcementGroup, automationGroup, differentLabel, publishLabel, transferAutomation, destinationAutomation, deliveryField, source);
    channelSelect.addEventListener('change', () => updateMappingChannel(card));
    container.append(card);
    updateMappingChannel(card);
    updatePublishControls(card);
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

function updatePublishControls(card) {
    const different = card.querySelector('.publish-different input').checked;
    const destination = currentChannels.find((item) => item.id === card.querySelector('.publish-channel select').value);
    const transfer = card.querySelector('.transfer-automation');
    const destinationAutomation = card.querySelector('.destination-automation');
    transfer.classList.toggle('hidden', !different);
    destinationAutomation.classList.toggle('hidden', !different || destination?.announcement !== true);
    if (different && !transfer.querySelector('input:checked')) transfer.querySelector('input[value="no"]').checked = true;
    if (different && destination?.announcement === true && !destinationAutomation.querySelector('input:checked')) {
        destinationAutomation.querySelector('input[value="no"]').checked = true;
    }
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
        const publishChannel = currentChannels.find((item) => item.id === publishChannelId);
        const transferAutomated = different ? (card.querySelector('.transfer-automation input:checked')?.value || '') : 'not_applicable';
        const destinationPublishAutomated = different && publishChannel?.announcement
            ? (card.querySelector('.destination-automation input:checked')?.value || '')
            : 'not_applicable';
        if (different && !transferAutomated) throw new Error('公開先チャンネルへの転送が自動か手動かを選択してください。');
        if (different && publishChannel?.announcement && !destinationPublishAutomated) throw new Error('公開先での公開操作が自動か手動かを選択してください。');
        return {
            channelId: channel.id,
            announcement,
            announcementAutomated: announcement
                ? (card.querySelector('.mapping-automation input:checked')?.value || '')
                : 'not_applicable',
            publishChannelDifferent: different,
            publishChannelId: different ? publishChannelId : '',
            transferAutomated,
            destinationPublishAutomated,
            deliveryTypes,
        };
    });
}

function toggleReuseOther() {
    const other = checkedValue('reuse-method') === 'other';
    document.getElementById('reuse-other-wrap').classList.toggle('hidden', !other);
    document.getElementById('reuse-other').required = other;
}

function submitApplication(event) {
    event.preventDefault();
    try {
        openConfirmation(applicationPayload(), 'create');
    } catch (error) { setStatus(error.message, 'error'); }
}

function openConfirmation(payload, mode) {
    const review = reviewSubmission(payload, mode);
    pendingSubmission = { payload, mode };
    const errors = document.getElementById('confirmation-errors');
    const warnings = document.getElementById('confirmation-warnings');
    errors.textContent = review.errors.map((text) => `・${text}`).join('\n');
    warnings.textContent = review.warnings.map((text) => `・${text}`).join('\n');
    errors.classList.toggle('hidden', review.errors.length === 0);
    warnings.classList.toggle('hidden', review.warnings.length === 0);
    const details = document.getElementById('confirmation-details'); details.replaceChildren();
    for (const [label, text] of review.details) details.append(element('dt', '', label), element('dd', '', text));
    const submit = document.getElementById('confirmation-submit');
    submit.disabled = review.errors.length > 0;
    submit.textContent = mode === 'create' ? '確認して申請を送信' : '確認して再申請を送信';
    document.getElementById('confirmation-dialog').showModal();
}

function reviewSubmission(payload, mode) {
    const errors = [];
    const warnings = [];
    const email = payload.email.trim().toLowerCase();
    const emailConfirm = payload.emailConfirm.trim().toLowerCase();
    if (email !== emailConfirm) errors.push('メールアドレスと確認用メールアドレスが一致していません。');
    const storedMappings = mode === 'resubmit' ? managedApplication.channelMappings : [];
    const mappingDetails = payload.channelMappings.map((mapping, index) => {
        const stored = storedMappings[index] || {};
        const source = mode === 'create'
            ? currentChannels.find((item) => item.id === mapping.channelId)
            : { id: stored.channelId, name: stored.channelName, announcement: stored.channelType === 5 };
        const destination = mapping.publishChannelId
            ? (mode === 'create'
                ? currentChannels.find((item) => item.id === mapping.publishChannelId)
                : { id: stored.publishChannelId, name: stored.publishChannelName, announcement: stored.publishChannelType === 5 })
            : null;
        const declaredAnnouncement = mode === 'create' ? mapping.announcement : stored.announcement;
        if (!source) errors.push(`利用設定${index + 1}の利用チャンネルを確認できません。`);
        if (source && declaredAnnouncement !== source.announcement) {
            errors.push(`利用設定${index + 1}のアナウンスチャンネル回答がDiscordのチャンネル種別と一致していません。`);
        }
        if (source?.announcement && !['yes', 'no'].includes(mapping.announcementAutomated)) {
            errors.push(`利用設定${index + 1}の利用チャンネルにおける公開自動化の有無を選択してください。`);
        }
        if (mapping.publishChannelDifferent) {
            if (!destination) errors.push(`利用設定${index + 1}の公開先チャンネルを確認できません。`);
            if (!['yes', 'no'].includes(mapping.transferAutomated)) errors.push(`利用設定${index + 1}の公開先への転送方法を選択してください。`);
            if (destination?.announcement && !['yes', 'no'].includes(mapping.destinationPublishAutomated)) {
                errors.push(`利用設定${index + 1}の公開先における公開自動化の有無を選択してください。`);
            }
            if (destination && !destination.announcement) {
                warnings.push(`利用設定${index + 1}の公開先 #${destination.name} はアナウンスチャンネルではありません。Discordの「公開」機能は利用できません。`);
            }
        } else if (source && !source.announcement) {
            warnings.push(`利用設定${index + 1}は、利用チャンネル #${source.name} がアナウンスチャンネルではなく、別の公開先も指定されていません。公開方法が申請目的に合っているか確認してください。`);
        }
        const lines = [
            `利用: #${source?.name || mapping.channelId}${source?.announcement ? '（アナウンス）' : '（通常チャンネル）'}`,
            `配信: ${mapping.deliveryTypes.map((id) => deliveryLabels[id] || id).join('、')}`,
        ];
        if (source?.announcement) lines.push(`利用チャンネルの公開: ${choiceLabels[mapping.announcementAutomated] || '未選択'}`);
        if (mapping.publishChannelDifferent) {
            lines.push(`公開先: #${destination?.name || mapping.publishChannelId}${destination?.announcement ? '（アナウンス）' : '（通常チャンネル）'}`);
            lines.push(`公開先への転送: ${choiceLabels[mapping.transferAutomated] || '未選択'}`);
            if (destination?.announcement) lines.push(`公開先での公開: ${choiceLabels[mapping.destinationPublishAutomated] || '未選択'}`);
        }
        return `設定${index + 1}\n${lines.join('\n')}`;
    }).join('\n\n');
    return {
        errors, warnings,
        details: [
            ['メールアドレス', `${payload.email}\n確認入力: ${payload.emailConfirm}\n照合結果: ${email === emailConfirm ? '一致' : '不一致'}`],
            ['チャンネル別設定', mappingDetails],
            ['サーバー公開範囲', choiceLabels[payload.serverPublic] || payload.serverPublic],
            ['チャンネル公開範囲', choiceLabels[payload.channelVisibility] || payload.channelVisibility],
            ['利用方法', choiceLabels[payload.reuseMethod] || payload.reuseMethod],
            ['利用目的', payload.purpose],
        ],
    };
}

function closeConfirmation() {
    pendingSubmission = null;
    document.getElementById('confirmation-dialog').close();
}

async function confirmSubmission() {
    if (!pendingSubmission) return;
    const { payload, mode } = pendingSubmission;
    const button = document.getElementById('confirmation-submit'); button.disabled = true;
    setStatus(mode === 'create' ? '申請を送信しています…' : '再申請しています…', 'info');
    try {
        if (mode === 'create') await sendInitialApplication(payload);
        else await sendResubmission(payload);
        closeConfirmation();
    } catch (error) { setStatus(error.message, 'error'); button.disabled = false; }
}

async function sendInitialApplication(payload) {
    const result = await api('/api/reuse/applications', {
        method: 'POST', headers: { 'X-Reuse-CSRF': session.csrfToken }, body: JSON.stringify(payload),
    });
    const url = new URL(location.href); url.search = ''; url.searchParams.set('token', result.manageToken); history.replaceState(null, '', url);
    document.getElementById('application-panel').classList.add('hidden');
    document.getElementById('result-panel').classList.remove('hidden');
    const box = element('div', 'success-box');
    box.append(element('strong', '', '申請を受け付けました'), element('p', '', `受付番号: ${result.reference}`), element('p', '', result.emailSent
        ? '確認メールを送信しました。審査結果も同じメールアドレスへお送りします。'
        : '確認メールを送信できませんでした。この申請状況ページを保存し、必要に応じてsupport@dpi-bot.comへご連絡ください。'));
    document.getElementById('application-status').replaceChildren(box); setStatus('', '');
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
    document.getElementById('resubmit-form').classList.add('hidden');
    document.getElementById('resubmit-fields').replaceChildren();
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
    container.append(list);
    if (app.editable) {
        renderResubmitForm(app);
    } else if (['pending', 'resubmitted'].includes(app.status)) {
        container.append(element('p', 'edit-state-note', 'この申請は審査中のため修正できません。審査結果が確定するまでお待ちください。'));
    }
}

function formatMapping(mapping, index) {
    const parts = [`設定${index + 1}: #${mapping.channelName}${mapping.announcement ? '（アナウンス）' : ''}`];
    parts.push(`配信: ${mapping.deliveryTypes.map((id) => deliveryLabels[id] || id).join('、')}`);
    if (mapping.announcement) parts.push(`公開操作: ${choiceLabels[mapping.announcementAutomated] || mapping.announcementAutomated}`);
    if (mapping.publishChannelDifferent) {
        parts.push(`公開先: #${mapping.publishChannelName}`);
        parts.push(`公開先への転送: ${choiceLabels[mapping.transferAutomated] || mapping.transferAutomated}`);
        if (mapping.publishChannelType === 5) parts.push(`公開先での公開: ${choiceLabels[mapping.destinationPublishAutomated] || mapping.destinationPublishAutomated}`);
    }
    return parts.join('\n');
}

function renderResubmitForm(app) {
    const form = document.getElementById('resubmit-form'); form.classList.remove('hidden');
    const fields = document.getElementById('resubmit-fields'); fields.replaceChildren();
    const approvedEdit = app.status === 'approved';
    document.getElementById('resubmit-title').textContent = approvedEdit ? '許可済みの申請内容を編集' : '内容を修正して再申請';
    document.getElementById('resubmit-description').textContent = approvedEdit
        ? '変更内容を送信すると状態は「再申請」となり、変更後の内容について再度審査を行います。'
        : '管理者からの案内を確認し、申請画面と同じ項目を修正して再申請してください。';
    document.getElementById('resubmit-btn').textContent = approvedEdit ? '変更内容を確認する' : '再申請内容を確認する';
    const mappingField = document.createElement('fieldset');
    mappingField.append(element('legend', '', '利用先'));
    mappingField.append(element('p', 'help', '申請済みのチャンネルごとに、配信内容と公開方法を修正できます。チャンネル自体を変更する場合は別の申請を行ってください。'));
    app.channelMappings.forEach((mapping, index) => {
        const card = element('section', 'mapping-card resubmit-mapping');
        const heading = element('div', 'mapping-head');
        heading.append(element('h3', '', `設定${index + 1}: #${mapping.channelName}${mapping.publishChannelDifferent ? ` → #${mapping.publishChannelName}` : ''}`));
        card.append(heading, deliveryCheckboxGrid(`resubmit-delivery-${index}`, mapping.deliveryTypes));
        if (mapping.announcement) card.append(radioGroup('利用チャンネルでの公開操作', `resubmit-announcement-${index}`, { yes: '自動', no: '手動' }, mapping.announcementAutomated));
        if (mapping.publishChannelDifferent) card.append(radioGroup('公開先チャンネルへの転送', `resubmit-transfer-automation-${index}`, { yes: '自動', no: '手動' }, mapping.transferAutomated));
        if (mapping.publishChannelType === 5) card.append(radioGroup('公開先での公開操作', `resubmit-destination-automation-${index}`, { yes: '自動', no: '手動' }, mapping.destinationPublishAutomated));
        mappingField.append(card);
    });
    const operationField = document.createElement('fieldset');
    operationField.append(
        element('legend', '', '公開範囲と運用方法'),
        radioGroup('サーバーは誰でも参加できますか？', 'resubmit-server-public', {
            public: '公開サーバー（宣伝サイトなどに招待リンクを公開している場合はこちら）',
            private: '非公開・招待制サーバー（完全内部利用やDMなどで招待する場合はこちら）',
        }, app.serverPublic),
        radioGroup('利用チャンネルは誰でも閲覧できますか？', 'resubmit-channel-visibility', {
            public: 'サーバー参加者なら誰でも閲覧可能（メンバーロール付与後に閲覧できる場合を含みます）',
            role_limited: '指定ロールのみ閲覧可能',
        }, app.channelVisibility),
        radioGroup('配信内容の利用方法', 'resubmit-method', {
            unchanged: '内容をそのまま転載する', edited: '一部を編集・加工して利用する', other: 'その他',
        }, app.reuseMethod),
        textAreaField('その他の利用方法', 'resubmit-method-other', app.reuseMethodOther, 500),
    );
    const contactField = document.createElement('fieldset');
    contactField.append(
        element('legend', '', '連絡先と利用目的'),
        inputField('結果通知先メールアドレス', 'resubmit-email', '', 'email'),
        inputField('結果通知先メールアドレス（確認）', 'resubmit-email-confirm', '', 'email'),
        element('p', 'help', '結果は notice@dpi-bot.com から送信します。受信許可設定と迷惑メールフォルダをご確認ください。'),
        textAreaField('利用目的', 'resubmit-purpose', app.purpose, 2000),
        inputField('サーバー案内・公開先URL（任意）', 'resubmit-url', app.destinationUrl, 'url'),
        textAreaField('補足事項（任意）', 'resubmit-notes', app.notes, 2000),
    );
    fields.append(
        mappingField,
        operationField,
        contactField,
    );
    document.querySelectorAll('input[name="resubmit-method"]').forEach((input) => input.addEventListener('change', toggleResubmitOther));
    toggleResubmitOther();
}

function toggleResubmitOther() {
    const field = document.getElementById('resubmit-method-other')?.closest('label');
    if (!field) return;
    const other = checkedValue('resubmit-method') === 'other';
    field.classList.toggle('hidden', !other);
    document.getElementById('resubmit-method-other').required = other;
}

function resubmitApplication(event) {
    event.preventDefault();
    try {
        const channelMappings = managedApplication.channelMappings.map((mapping, index) => ({
            channelId: mapping.channelId, publishChannelId: mapping.publishChannelId,
            announcement: mapping.announcement, publishChannelDifferent: mapping.publishChannelDifferent,
            announcementAutomated: mapping.announcement ? checkedValue(`resubmit-announcement-${index}`) : 'not_applicable',
            transferAutomated: mapping.publishChannelDifferent ? checkedValue(`resubmit-transfer-automation-${index}`) : 'not_applicable',
            destinationPublishAutomated: mapping.publishChannelType === 5 ? checkedValue(`resubmit-destination-automation-${index}`) : 'not_applicable',
            deliveryTypes: checkedValues(`resubmit-delivery-${index}`),
        }));
        openConfirmation({
            channelMappings, serverPublic: checkedValue('resubmit-server-public'), channelVisibility: checkedValue('resubmit-channel-visibility'),
            reuseMethod: checkedValue('resubmit-method'), reuseMethodOther: value('resubmit-method-other'),
            email: value('resubmit-email'), emailConfirm: value('resubmit-email-confirm'), purpose: value('resubmit-purpose'),
            destinationUrl: value('resubmit-url'), notes: value('resubmit-notes'),
            authorized: document.getElementById('resubmit-authorized').checked, consent: document.getElementById('resubmit-consent').checked,
        }, 'resubmit');
    } catch (error) { setStatus(error.message, 'error'); }
}

async function sendResubmission(payload) {
    const result = await api(`/api/reuse/manage?token=${encodeURIComponent(managedToken)}`, {
        method: 'PUT', body: JSON.stringify(payload),
    });
    setStatus(result.emailSent ? `第${result.revision}版として再申請し、確認メールを送信しました。` : `第${result.revision}版として再申請しましたが、確認メールを送信できませんでした。`, result.emailSent ? 'success' : 'error');
    await loadManagedApplication();
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
function radioGroup(labelText, name, choices, selected) { const group = element('div', 'choice-group'); group.append(element('span', 'field-label', labelText)); for (const [choice, text] of Object.entries(choices)) { const label = document.createElement('label'); const input = document.createElement('input'); input.type = 'radio'; input.name = name; input.value = choice; input.required = true; input.checked = choice === selected; label.append(input, document.createTextNode(` ${text}`)); group.append(label); } return group; }
function inputField(labelText, id, initial, type) { const label = document.createElement('label'); label.append(document.createTextNode(labelText)); const input = document.createElement('input'); input.id = id; input.type = type; input.value = initial || ''; input.required = type === 'email'; input.maxLength = type === 'email' ? 254 : 500; label.append(input); return label; }
function textAreaField(labelText, id, initial, maxLength) { const label = document.createElement('label'); label.append(document.createTextNode(labelText)); const textarea = document.createElement('textarea'); textarea.id = id; textarea.rows = 4; textarea.maxLength = maxLength; textarea.value = initial || ''; if (id === 'resubmit-purpose') { textarea.required = true; textarea.minLength = 10; } label.append(textarea); return label; }
