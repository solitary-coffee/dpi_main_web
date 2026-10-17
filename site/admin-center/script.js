let xmlPreviewValid = false;

document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('refresh-btn')?.addEventListener('click', loadSummary);
    document.getElementById('mode-form')?.addEventListener('submit', changeSystemMode);
    document.getElementById('mode-select')?.addEventListener('change', updateModeHint);
    document.getElementById('xml-file')?.addEventListener('change', loadXmlFile);
    document.getElementById('xml-preview-btn')?.addEventListener('click', previewXml);
    document.getElementById('xml-form')?.addEventListener('submit', dispatchXml);
    for (const id of ['xml-content', 'xml-slot', 'xml-route']) document.getElementById(id)?.addEventListener('input', invalidateXmlPreview);
    if (document.getElementById('mode-form')) updateModeHint();
    loadSummary();
});

async function loadSummary() {
    setStatus('統合運用情報を読み込み中…', 'info');
    try {
        const response = await fetch('/site/admin-center/api/summary', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success !== true) throw new Error(data.message || `取得に失敗しました（HTTP ${response.status}）。`);
        render(data);
        setStatus('', '');
    } catch (error) {
        setStatus(error.message, 'error');
    }
}

function render(data) {
    const adminEmail = document.getElementById('admin-email');
    const fetchedAt = document.getElementById('fetched-at');
    if (adminEmail) adminEmail.textContent = data.admin;
    if (fetchedAt) fetchedAt.textContent = `更新: ${formatDate(data.fetchedAt)}`;
    renderOverview(data.local, data.aws);
    renderOperationOverview(data.local, data.cloudflare, data.aws, data.deliveryCatalog);
    renderLinks(data.links);
    renderSystems(data.cloudflare, data.aws);
    renderMode(data.aws?.systemMode);
    renderEc2(data.aws?.backupInstances);
    renderAudit(data.local);
    renderSlots(data.deliveryCatalog, data.aws?.deliveryDirectory?.byType || {}, data.local?.deliverySlotCounts || {});
    renderXmlSlots(data.deliveryCatalog, data.aws?.deliveryDirectory?.byType || {});
}

function renderOverview(local, aws) {
    const container = document.getElementById('overview-cards');
    if (!container) return;
    const pending = Number(local.reuseApplications.pending || 0) + Number(local.reuseApplications.resubmitted || 0) + Number(local.reuseApplications.stop_requested || 0);
    const sending = Number(local.campaigns.sending || 0) + Number(local.campaigns.queuing || 0);
    const items = [
        ['要対応の二次利用申請', pending, '/site/reuse-admin/'], ['許可済み二次利用', local.reuseApplications.approved || 0, '/site/reuse-admin/'],
        ['配信中のメール', sending, '/site/mail-admin/'], ['有効な購読者', local.subscribers.active || 0, '/site/mail-admin/'],
        ['有効なIP遮断', local.activeBlocks.length, '/site/ip-admin/'], ['AWSアラーム', aws.available ? (aws.alarms?.active || 0) : '—', '/site/system-admin/'],
    ];
    container.replaceChildren(...items.map(([label, value, href]) => {
        const card = element(href ? 'a' : 'article', 'metric-card');
        if (href) card.href = href;
        card.append(element('span', '', label), element('strong', '', String(value)));
        return card;
    }));
}

function renderOperationOverview(local, cloudflare, aws, catalog) {
    const container = document.getElementById('operation-overview');
    if (!container) return;
    const mode = aws?.systemMode;
    const modeName = mode?.available
        ? ({ automatic: '自動監視', normal: '通常固定', failover: 'フェイルオーバー固定' }[mode.controlMode] || mode.controlMode)
        : '取得不可';
    const home = aws?.homeServers;
    const backup = aws?.backupInstances;
    const runningInstances = backup?.available
        ? (backup.instances || []).filter((instance) => instance.state === 'running').length
        : null;
    const awsSlots = aws?.deliveryDirectory?.byType || {};
    const endedSlots = new Set((catalog || []).filter((slot) => slot.status === 'ended').map((slot) => slot.id));
    const activeSlots = Object.entries(awsSlots).filter(([id, count]) => Number(count || 0) > 0 && !endedSlots.has(id)).length;
    const auditCount = Number(local?.auditEvents?.length || 0) + Number(local?.reuseEvents?.length || 0);
    const items = [
        { title: 'システム運用', value: modeName, detail: aws?.available ? `AWS警報 ${aws.alarms?.active ?? '—'}件 / Cloudflare ${cloudflare?.worker || '—'}` : (aws?.message || 'AWS情報を取得できません'), href: '/site/system-admin/' },
        { title: '自宅サーバー', value: home?.available ? `正常 ${home.healthy ?? 0}台` : '取得不可', detail: home?.available ? `異常・期限切れ ${home.unhealthy ?? 0}台` : (home?.error || '状態を確認できません'), href: '/site/system-admin/' },
        { title: 'EC2管理', value: backup?.available ? `${runningInstances}/${backup.count ?? 0}台 稼働` : '取得不可', detail: 'バックアップEC2の詳細・操作', href: '/site/ec2-admin/' },
        { title: 'XML配信', value: `${activeSlots}配信枠`, detail: `AWS配信先 ${aws?.deliveryDirectory?.channels ?? '—'}チャンネル`, href: '/site/xml-admin/' },
        { title: '配信先', value: `${aws?.deliveryDirectory?.servers ?? '—'}サーバー`, detail: '登録チャンネル・配信名を検索', href: '/site/channel-admin/' },
        { title: '最近の運用履歴', value: `${auditCount}件`, detail: '管理操作・申請・遮断の履歴', href: '/site/system-admin/#audit-title' },
    ];
    container.replaceChildren(...items.map((item) => {
        const card = element('a', 'feature-card');
        card.href = item.href;
        card.append(element('span', 'feature-title', item.title), element('strong', '', String(item.value)), element('small', '', item.detail), element('span', 'feature-link', '詳細を開く →'));
        return card;
    }));
}

function renderLinks(links) {
    const container = document.getElementById('quick-links');
    if (!container) return;
    container.replaceChildren(...(links || []).map((link) => {
        const anchor = element('a', 'quick-link', `${link.label} →`);
        anchor.href = link.href;
        return anchor;
    }));
}

function renderSystems(cloudflare, aws) {
    const container = document.getElementById('system-panels');
    if (!container) return;
    const homeRows = aws.available && aws.homeServers?.available ? [
        ['正常', aws.homeServers.healthy ?? '—'], ['異常/期限切れ', aws.homeServers.unhealthy ?? '—'],
        ...(aws.homeServers.nodes || []).flatMap((node) => [
            [`${node.name} 状態`, node.healthy ? '稼働中' : '停止/期限切れ'],
            [`${node.name} 最終通信`, `${formatDate(node.lastHeartbeat)}${node.ageSeconds == null ? '' : `（${node.ageSeconds}秒前）`}`],
        ]),
    ] : [['状態', aws.homeServers?.error ? `取得失敗: ${aws.homeServers.error}` : '—']];
    const panels = [
        ['Cloudflare', [['Worker', cloudflare.worker], ['D1', stateText(cloudflare.databaseConfigured)], ['Queue', stateText(cloudflare.queueConfigured)], ['Email', stateText(cloudflare.emailConfigured)], ['Access', stateText(cloudflare.accessConfigured)]]],
        ['AWS', aws.available ? [
            ['リージョン', aws.region || '—'], ['Lambda', aws.lambda?.count ?? '—'], ['API Gateway', aws.apiGateway?.count ?? '—'],
            ['SQS待機', aws.sqs?.visibleMessages ?? '—'], ['DLQ待機', aws.sqs?.deadLetterMessages ?? '—'], ['DynamoDB', aws.dynamoDb?.count ?? '—'],
            ['配信先チャンネル', aws.deliveryDirectory?.channels ?? '—'], ['配信先サーバー', aws.deliveryDirectory?.servers ?? '—'],
            ['CloudWatch警報', aws.alarms?.active ?? '—'], ['CloudWatch Logs', aws.logGroups?.count ?? '—'], ['スタック異常', aws.stacks?.failed ?? '—'],
            ['バックアップEC2', aws.backupInstances?.count ?? '—'],
        ] : [['状態', aws.message || '利用できません']]],
        ['自宅サーバー', homeRows],
    ];
    container.replaceChildren(...panels.map(([title, rows]) => {
        const card = element('article', 'system-card');
        card.append(element('h3', '', title));
        const list = element('dl');
        for (const [key, value] of rows) list.append(element('dt', '', key), element('dd', '', String(value)));
        card.append(list);
        return card;
    }));
}

function renderMode(mode) {
    const container = document.getElementById('mode-current');
    if (!container) return;
    if (!mode?.available) {
        container.replaceChildren(element('p', 'empty', `取得できません${mode?.error ? `（${mode.error}）` : ''}`));
        return;
    }
    const modeName = { automatic: '自動監視', normal: '通常固定', failover: 'フェイルオーバー固定' }[mode.controlMode] || mode.controlMode;
    const card = element('div', `mode-badge mode-${mode.controlMode}`, `制御: ${modeName}`);
    const regions = element('div', 'region-modes');
    for (const region of mode.regions || []) {
        const item = element('article', 'region-mode');
        item.append(element('strong', '', region.regionRole.toUpperCase()), element('span', '', region.mode), element('small', '', region.reason || '理由なし'), element('time', '', formatDate(region.updatedAt)));
        regions.append(item);
    }
    container.replaceChildren(card, regions);
    document.getElementById('mode-select').value = ['automatic', 'normal', 'failover'].includes(mode.controlMode) ? mode.controlMode : 'automatic';
    updateModeHint();
}

function renderEc2(backup) {
    const body = document.getElementById('ec2-rows');
    if (!body) return;
    body.replaceChildren();
    const instances = backup?.available ? (backup.instances || []) : [];
    if (!instances.length) {
        const row = document.createElement('tr');
        const cell = element('td', 'empty', backup?.error ? `取得できません（${backup.error}）` : '管理対象EC2はありません。');
        cell.colSpan = 6;
        row.append(cell);
        body.append(row);
        return;
    }
    for (const instance of instances) {
        const row = document.createElement('tr');
        const identity = element('td');
        identity.append(element('strong', '', instance.name), element('code', 'block-code', instance.instanceId));
        const actions = element('td', 'ec2-actions');
        for (const [operation, label] of [['start', '起動'], ['stop', '停止'], ['reboot', '再起動']]) {
            const button = element('button', operation === 'stop' ? 'small danger-button' : 'small', label);
            button.type = 'button';
            button.disabled = (operation === 'start' && instance.state !== 'stopped') || (operation !== 'start' && instance.state !== 'running');
            button.addEventListener('click', () => controlEc2(instance, operation, button));
            actions.append(button);
        }
        row.append(element('td', '', instance.region), identity, element('td', '', instance.backupRole), element('td', `state state-${instance.state}`, instance.state), element('td', '', instance.normalState), actions);
        body.append(row);
    }
}

async function changeSystemMode(event) {
    event.preventDefault();
    const mode = document.getElementById('mode-select').value;
    const reason = document.getElementById('mode-reason').value.trim();
    const confirmation = document.getElementById('mode-confirmation').value.trim();
    if (!window.confirm('システムモードを変更します。対象EC2の起動状態が変化する場合があります。続行しますか？')) return;
    try {
        await runAction({ action: 'system-mode', mode, reason, confirmation }, event.submitter, true);
        document.getElementById('mode-confirmation').value = '';
    } catch { /* runAction already presents the error */ }
}

async function controlEc2(instance, operation, button) {
    const confirmation = `${operation}:${instance.instanceId}`;
    const input = window.prompt(`${instance.name} に「${button.textContent}」を実行します。\n確認のため次を入力してください:\n${confirmation}`);
    if (input === null) return;
    try {
        await runAction({ action: 'ec2', region: instance.region, instanceId: instance.instanceId, operation, confirmation: input }, button, true);
    } catch { /* runAction already presents the error */ }
}

function updateModeHint() {
    const select = document.getElementById('mode-select');
    const hint = document.getElementById('mode-confirm-hint');
    if (!select || !hint) return;
    hint.textContent = `「MODE:${select.value.toUpperCase()}」と入力してください。`;
}

async function loadXmlFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > 1_500_000) {
        setStatus('XMLファイルは1.5MB以下にしてください。', 'error');
        event.target.value = '';
        return;
    }
    document.getElementById('xml-content').value = await file.text();
    invalidateXmlPreview();
}

async function previewXml() {
    const button = document.getElementById('xml-preview-btn');
    try {
        const data = await runAction({ action: 'xml-preview', xml: document.getElementById('xml-content').value }, button, false);
        const preview = data.preview || {};
        const box = document.getElementById('xml-preview');
        const list = element('dl');
        for (const [label, value] of [['電文種別', preview.controlTitle], ['見出し', preview.headline], ['イベントID', preview.eventId], ['発表時刻', preview.reportDateTime], ['対象時刻', preview.targetDateTime], ['発表元', preview.publishingOffice], ['状態', preview.status], ['サイズ', `${Number(data.bytes || 0).toLocaleString('ja-JP')} bytes`]]) list.append(element('dt', '', label), element('dd', '', value || '—'));
        box.replaceChildren(element('h3', '', 'XMLプレビュー'), list);
        box.hidden = false;
        xmlPreviewValid = true;
        document.getElementById('xml-send-btn').disabled = false;
        updateXmlHint();
    } catch {
        invalidateXmlPreview();
    }
}

async function dispatchXml(event) {
    event.preventDefault();
    if (!xmlPreviewValid) return setStatus('XMLをもう一度確認してください。', 'error');
    if (!window.confirm('選択した配信枠へXMLを配信します。この操作は利用者への通知につながります。続行しますか？')) return;
    const payload = { action: 'xml-dispatch', xml: document.getElementById('xml-content').value, deliverySlot: document.getElementById('xml-slot').value, sendData: document.getElementById('xml-route').value, confirmation: document.getElementById('xml-confirmation').value.trim() };
    try {
        await runAction(payload, event.submitter, true);
        document.getElementById('xml-confirmation').value = '';
        invalidateXmlPreview();
    } catch { /* runAction already presents the error */ }
}

async function runAction(payload, button, refreshAfter) {
    const original = button?.textContent;
    if (button) { button.disabled = true; button.textContent = '処理中…'; }
    setStatus('管理操作を実行しています…', 'info');
    try {
        const response = await fetch('/site/admin-center/api/action', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success !== true) throw new Error(data.message || `操作に失敗しました（HTTP ${response.status}）。`);
        setStatus(data.message || '操作が完了しました。', 'success');
        if (refreshAfter) window.setTimeout(loadSummary, 1500);
        return data;
    } catch (error) {
        setStatus(error.message, 'error');
        throw error;
    } finally {
        if (button) { button.disabled = false; button.textContent = original; }
    }
}

function invalidateXmlPreview() {
    const preview = document.getElementById('xml-preview');
    const sendButton = document.getElementById('xml-send-btn');
    if (!preview || !sendButton) return;
    xmlPreviewValid = false;
    preview.hidden = true;
    sendButton.disabled = true;
    updateXmlHint();
}

function updateXmlHint() {
    const select = document.getElementById('xml-slot');
    const hint = document.getElementById('xml-confirm-hint');
    if (!select || !hint) return;
    hint.textContent = select.value ? `「XML配信:${select.value}」と入力してください。` : '配信枠を選択してください。';
}

function renderXmlSlots(catalog, awsCounts) {
    const select = document.getElementById('xml-slot');
    if (!select) return;
    const current = select.value;
    const known = new Set((catalog || []).map((slot) => slot.id));
    const extras = Object.keys(awsCounts).filter((id) => !known.has(id)).map((id) => ({ id, label: id, status: 'unlisted' }));
    const available = [...(catalog || []), ...extras].filter((slot) => Number(awsCounts[slot.id] || 0) > 0 && slot.status !== 'ended');
    const placeholder = element('option', '', '選択してください');
    placeholder.value = '';
    select.replaceChildren(placeholder);
    for (const slot of available) {
        const option = element('option', '', `${slot.label}（${Number(awsCounts[slot.id])}件）`);
        option.value = slot.id;
        select.append(option);
    }
    if (available.some((slot) => slot.id === current)) select.value = current;
    updateXmlHint();
}

function renderAudit(local) {
    const body = document.getElementById('audit-rows');
    if (!body) return;
    const rows = [
        ...(local.auditEvents || []).map((event) => ({ at: event.created_at, type: '管理操作', content: `${event.action} / ${event.entity_type}${event.entity_id ? ` / ${event.entity_id}` : ''}`, actor: event.actor })),
        ...(local.reuseEvents || []).map((event) => ({ at: event.created_at, type: '二次利用申請', content: `${event.event_type} / ${event.application_id}${event.message ? ` / ${event.message}` : ''}`, actor: event.actor })),
        ...(local.activeBlocks || []).map((rule) => ({ at: rule.created_at, type: 'IP遮断', content: `${rule.network}: ${rule.reason}`, actor: rule.created_by })),
    ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30);
    body.replaceChildren();
    if (!rows.length) {
        const row = document.createElement('tr');
        const cell = element('td', 'empty', '表示できる履歴はありません。');
        cell.colSpan = 4;
        row.append(cell);
        body.append(row);
        return;
    }
    for (const item of rows) {
        const row = document.createElement('tr');
        row.append(element('td', '', formatDate(item.at)), element('td', '', item.type), element('td', '', item.content), element('td', '', item.actor || '—'));
        body.append(row);
    }
}

function renderSlots(catalog, awsCounts, reuseCounts) {
    const container = document.getElementById('delivery-slots');
    if (!container) return;
    const known = new Set((catalog || []).map((slot) => slot.id));
    const extras = Object.keys(awsCounts).filter((id) => !known.has(id)).map((id) => ({ id, label: id, status: 'unlisted' }));
    container.replaceChildren(...[...(catalog || []), ...extras].map((slot) => {
        const card = element('article', 'slot-card');
        card.append(element('strong', '', slot.label), element('span', `slot-status ${slot.status}`, slot.status === 'unlisted' ? 'AWS登録' : slot.status), element('code', '', slot.id), element('small', 'slot-count', `AWS登録: ${Number(awsCounts[slot.id] || 0)}件`), element('small', 'slot-count secondary', `許可済み二次利用: ${Number(reuseCounts[slot.id] || 0)}件`));
        return card;
    }));
}

function stateText(value) { return value ? '設定済み' : '未設定'; }
function formatDate(value) { const date = new Date(value || ''); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ja-JP'); }
function setStatus(message, type) { const node = document.getElementById('global-status'); if (!node) return; node.textContent = message; node.className = type ? `status ${type}` : 'status'; }
function element(tag, className = '', text = '') { const node = document.createElement(tag); if (className) node.className = className; if (text !== '') node.textContent = text; return node; }
