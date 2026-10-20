let xmlPreviewValid = false;
let xmlPreviewDigest = '';
let xmlPreviewSequence = 0;
let systemModeRevision = null;
let systemModePlans = {};
const modeLabels = { automatic: '自動監視', normal: '通常モード', standby: 'スタンバイモード', backup: 'バックアップモード', manual: '手動モード', emergency: '緊急モード', emergency_stop: '緊急停止モード', failover: 'バックアップ固定（旧設定）' };
const nodeLabels = { home: '自宅サーバー', 'tokyo-eew': '東京 EC2：EEW・地震・津波', 'tokyo-weather': '東京 EC2：気象・火山', 'osaka-eew': '大阪 EC2：EEW・地震・津波', 'osaka-weather': '大阪 EC2：気象・火山' };
const deliveryModeLabels = { immediate: '即時配信', standby: '待機して配信', stopped: '配信停止', automatic: '自動判定' };
let selectedDmdataSource = null;
let dmdataItems = [];
let dmdataNextToken = '';
let dmdataEventId = '';

document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('refresh-btn')?.addEventListener('click', loadSummary);
    document.getElementById('mode-form')?.addEventListener('submit', changeSystemMode);
    document.getElementById('mode-select')?.addEventListener('change', updateModeHint);
    document.getElementById('xml-file')?.addEventListener('change', loadXmlFile);
    document.getElementById('xml-preview-btn')?.addEventListener('click', previewXml);
    document.getElementById('xml-form')?.addEventListener('submit', dispatchXml);
    document.getElementById('xml-content')?.addEventListener('input', () => { clearDmdataSource(); invalidateXmlPreview(); });
    for (const id of ['xml-slot', 'xml-route']) document.getElementById(id)?.addEventListener('input', invalidateXmlPreview);
    document.getElementById('dmdata-search-form')?.addEventListener('submit', (event) => { event.preventDefault(); loadDmdataHistory(false); });
    document.getElementById('dmdata-next-btn')?.addEventListener('click', () => loadDmdataHistory(true));
    document.getElementById('dmdata-back-btn')?.addEventListener('click', () => { dmdataEventId = ''; loadDmdataHistory(false); });
    document.getElementById('dmdata-query')?.addEventListener('input', renderDmdataRows);
    document.getElementById('dmdata-state')?.addEventListener('change', renderDmdataRows);
    document.getElementById('dmdata-category')?.addEventListener('change', () => { dmdataEventId = ''; dmdataItems = []; dmdataNextToken = ''; renderDmdataRows(); });
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
        await loadStatuspageOverview();
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
        ? (modeLabels[mode.controlMode] || mode.controlMode)
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
        { key: 'statuspage', title: 'ステータス管理', value: '読込中…', detail: '稼働状況・インシデント・メンテナンス', href: '/site/status-admin/' },
        { title: 'XML配信', value: `${activeSlots}配信枠`, detail: `AWS配信先 ${aws?.deliveryDirectory?.channels ?? '—'}チャンネル`, href: '/site/xml-admin/' },
        { title: '配信系統', value: '系統別監視', detail: '上流・自宅・高速・SQS・バックアップ', href: '/site/delivery-flow-admin/' },
        { title: '配信先', value: `${aws?.deliveryDirectory?.servers ?? '—'}サーバー`, detail: '登録チャンネル・配信名を検索', href: '/site/channel-admin/' },
        { title: '最近の運用履歴', value: `${auditCount}件`, detail: '管理操作・申請・遮断の履歴', href: '/site/system-admin/#audit-title' },
    ];
    container.replaceChildren(...items.map((item) => {
        const card = element('a', 'feature-card');
        card.href = item.href;
        if (item.key) card.id = `${item.key}-overview`;
        card.append(element('span', 'feature-title', item.title), element('strong', '', String(item.value)), element('small', '', item.detail), element('span', 'feature-link', '詳細を開く →'));
        return card;
    }));
}

async function loadStatuspageOverview() {
    const card = document.getElementById('statuspage-overview');
    if (!card) return;
    const value = card.querySelector('strong');
    const detail = card.querySelector('small');
    try {
        const response = await fetch('/site/status-admin/api/summary', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success !== true) throw new Error(data.message || '取得失敗');
        if (!data.configured) {
            value.textContent = 'API未設定';
            detail.textContent = data.message || 'Statuspage API連携を設定してください';
            return;
        }
        const affected = (data.components || []).filter((component) => !component.group && component.status !== 'operational').length;
        const activeIncidents = (data.incidents || []).filter((incident) => incident.status !== 'resolved').length;
        value.textContent = affected ? `影響あり ${affected}件` : '正常稼働';
        detail.textContent = `対応中インシデント ${activeIncidents}件 / 予定メンテナンス ${(data.maintenances || []).length}件`;
    } catch (error) {
        value.textContent = '取得不可';
        detail.textContent = error.message;
    }
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
    systemModeRevision = Number.isInteger(mode.revision) ? mode.revision : null;
    systemModePlans = mode.availablePlans || {};
    const modeName = modeLabels[mode.controlMode] || mode.controlMode;
    const card = element('div', `mode-badge mode-${mode.controlMode}`, `制御: ${modeName}`);
    const regions = element('div', 'region-modes');
    for (const region of mode.regions || []) {
        const item = element('article', 'region-mode');
        item.append(element('strong', '', region.regionRole.toUpperCase()), element('span', '', region.requestedMode ? `要求: ${region.requestedMode}` : region.mode), element('small', '', region.requestedMode ? `自動監視の直近判定: ${region.mode} / ${region.reason || '理由なし'}` : region.reason || '理由なし'), element('time', '', formatDate(region.updatedAt)));
        regions.append(item);
    }
    container.replaceChildren(card, regions);
    const transitionLabels = { applying: '変更処理中', awaiting_ack: '変更要求受付済み（反映状況は各配信元を参照）', failed: '変更処理に失敗（一部反映の可能性あり）', legacy_unverified: '配信側の反映は未確認' };
    container.append(element('p', mode.transitionStatus === 'failed' ? 'status error' : '', `変更番号: ${mode.revision ?? '未取得'} / ${transitionLabels[mode.transitionStatus] || '反映状況不明'}${mode.transitionError ? `（${mode.transitionError}）` : ''}`));
    container.append(element('p', '', `自動監視設定: ${mode.automaticMonitoringEnabled ? '有効' : '無効'} / 制御: ${mode.controlMode === 'automatic' ? '自動' : mode.integratedControl ? '手動固定（死活監視は継続）' : '旧方式の手動固定'}`));
    container.append(element('p', 'section-description', '変更の受付と反映完了は別です。緊急停止は新規送信を抑止します。既に送信中のHTTP通信は取り消せません。停止前・停止中の電文は解除後も再送しません。'));
    if (!mode.runtimeReadiness?.ready) container.append(element('p', 'status error', `新モードは配信側更新待ちです。未確認: ${(mode.runtimeReadiness?.missing || ['制御API']).map(x => nodeLabels[x] || x).join('、')}。設定値だけで停止済みとは判定しません。`));
    const nodes = element('div', 'system-grid');
    for (const node of mode.nodes || []) {
        const item = element('article', 'system-card');
        const requested = node.requested;
        const applied = node.applicationStatus === 'applied';
        item.append(element('small', '', `配信側更新: ${node.installed ? '確認済み' : '未確認'}`));
        item.append(element('h3', '', nodeLabels[node.nodeId] || node.nodeId), element('p', '', `設定: ${deliveryModeLabels[requested?.delivery] || '未取得'}${requested?.waitSeconds ? ` / ${requested.waitSeconds}秒` : ''}`), element('p', '', `実測: ${node.verified ? (deliveryModeLabels[node.observed] || '不明') : '未確認'} / ${applied ? '反映確認済み' : '反映未確認'}`), element('time', '', formatDate(node.observedAt)));
        nodes.append(item);
    }
    container.append(nodes);
    const select = document.getElementById('mode-select');
    for (const option of select.options) {
        if (!['automatic', 'normal', 'failover'].includes(option.value)) {
            option.disabled = !mode.runtimeReadiness?.ready;
            option.textContent = `${modeLabels[option.value]}${option.disabled ? '（配信側更新待ち）' : ''}`;
        }
    }
    select.value = modeLabels[mode.controlMode] ? mode.controlMode : 'automatic';
    const manual = document.getElementById('manual-node-controls');
    if (manual && !manual.children.length) {
        for (const [id, label] of Object.entries(nodeLabels)) {
            const field = element('label', '', label);
            const input = element('select'); input.id = `node-mode-${id}`;
            for (const key of ['immediate', 'standby', 'stopped']) { const option = element('option', '', deliveryModeLabels[key]); option.value = key; input.append(option); }
            const waitLabel = element('label', '', '待機秒数（待機配信時のみ）');
            const wait = element('input'); wait.type = 'number'; wait.min = '1'; wait.max = '300'; wait.value = '3'; wait.id = `node-wait-${id}`;
            input.addEventListener('change', renderSelectedModePlan);
            wait.addEventListener('input', renderSelectedModePlan);
            waitLabel.append(wait); field.append(input); const group = element('div'); group.append(field, waitLabel); manual.append(group);
        }
    }
    for (const node of mode.nodes || []) {
        const input = document.getElementById(`node-mode-${node.nodeId}`);
        const wait = document.getElementById(`node-wait-${node.nodeId}`);
        if (input && ['immediate', 'standby', 'stopped'].includes(node.requested?.delivery)) input.value = node.requested.delivery;
        if (wait) wait.value = String(node.requested?.waitSeconds > 0 ? node.requested.waitSeconds : 3);
    }
    updateModeHint();
}

function renderEc2(backup) {
    const container = document.getElementById('ec2-rows');
    if (!container) return;
    container.replaceChildren();
    const instances = backup?.available ? (backup.instances || []) : [];
    const summary = document.getElementById('ec2-summary');
    if (summary) {
        const healthy = instances.filter((instance) => instance.instanceStatus === 'ok' && instance.systemStatus === 'ok').length;
        const metrics = [
            ['管理対象', instances.length],
            ['稼働中', instances.filter((instance) => instance.state === 'running').length],
            ['停止中', instances.filter((instance) => instance.state === 'stopped').length],
            ['チェック正常', healthy],
        ];
        summary.replaceChildren(...metrics.map(([label, number]) => {
            const card = element('article', 'metric-card compact');
            card.append(element('span', '', label), element('strong', '', String(number)));
            return card;
        }));
    }
    if (!instances.length) {
        container.append(element('p', 'empty', backup?.error ? `取得できません（${backup.error}）` : '管理対象EC2はありません。'));
        return;
    }
    for (const instance of instances) {
        const card = element('article', 'ec2-card');
        const heading = element('div', 'ec2-heading');
        const identity = element('div');
        identity.append(element('span', 'eyebrow', `${instance.region} / ${instance.availabilityZone || 'AZ不明'}`), element('h3', '', instance.name || instance.instanceId), element('code', 'block-code', instance.instanceId));
        heading.append(identity, element('span', `component-status status-${instance.state}`, instance.state || 'unknown'));
        const details = element('dl', 'ec2-details');
        const securityGroups = (instance.securityGroups || []).map((group) => `${group.name || '名称なし'} (${group.id})`).join(', ') || '—';
        const rows = [
            ['役割', instance.backupRole || '—'], ['通常時', instance.normalState || '—'],
            ['インスタンスタイプ', instance.instanceType || '—'], ['AMI', instance.imageId || '—'],
            ['OS / Platform', instance.platformDetails || '—'], ['アーキテクチャ', instance.architecture || '—'],
            ['インスタンスチェック', healthLabel(instance.instanceStatus)], ['システムチェック', healthLabel(instance.systemStatus)],
            ['モニタリング', instance.monitoringState || '—'], ['EBS最適化', instance.ebsOptimized ? '有効' : '無効'],
            ['ルートデバイス', instance.rootDeviceType || '—'], ['仮想化方式', instance.virtualizationType || '—'],
            ['プライベートIP', instance.privateIpAddress || '—'], ['パブリックIP', instance.publicIpAddress || '—'],
            ['VPC / Subnet', `${instance.vpcId || '—'} / ${instance.subnetId || '—'}`],
            ['セキュリティグループ', securityGroups], ['ボリューム', (instance.volumeIds || []).join(', ') || '—'],
            ['起動日時', formatDate(instance.launchTime)],
        ];
        for (const [key, value] of rows) details.append(element('dt', '', key), element('dd', '', String(value)));
        const actions = element('div', 'ec2-actions');
        for (const [operation, label] of [['start', '起動'], ['stop', '停止'], ['reboot', '再起動']]) {
            const button = element('button', operation === 'stop' ? 'small danger-button' : 'small', label);
            button.type = 'button';
            button.disabled = (operation === 'start' && instance.state !== 'stopped') || (operation !== 'start' && instance.state !== 'running');
            button.addEventListener('click', () => controlEc2(instance, operation, button));
            actions.append(button);
        }
        card.append(heading, details, actions);
        container.append(card);
    }
}

function healthLabel(value) {
    return ({ ok: '正常', impaired: '異常', initializing: '初期化中', insufficient_data: 'データ不足', not_applicable: '対象外' }[value] || value || '未取得');
}

async function changeSystemMode(event) {
    event.preventDefault();
    const mode = document.getElementById('mode-select').value;
    const reason = document.getElementById('mode-reason').value.trim();
    const confirmation = `MODE:${mode.toUpperCase()}`;
    if (systemModeRevision === null) return setStatus('最新情報を取得してから操作してください。', 'error');
    const nodeOverrides = mode === 'manual' ? Object.fromEntries(Object.keys(nodeLabels).map(id => [id, { delivery: document.getElementById(`node-mode-${id}`).value, waitSeconds: Number(document.getElementById(`node-wait-${id}`).value) }])) : undefined;
    if (!window.confirm(`${modeLabels[mode] || mode}へ変更します。\n画面に表示された自宅サーバー・各EC2の動作が適用され、対象EC2の起動状態が変化する場合があります。続行しますか？`)) return;
    try {
        await runAction({ action: 'system-mode', mode, reason, confirmation, expectedRevision: systemModeRevision, nodeOverrides }, event.submitter, true);
    } catch { /* runAction already presents the error */ }
}

async function controlEc2(instance, operation, button) {
    const confirmation = `${operation}:${instance.instanceId}`;
    if (!window.confirm(`${instance.name}（${instance.instanceId}）に「${button.textContent}」を実行します。続行しますか？`)) return;
    try {
        await runAction({ action: 'ec2', region: instance.region, instanceId: instance.instanceId, operation, confirmation }, button, true);
    } catch { /* runAction already presents the error */ }
}

async function loadDmdataHistory(nextPage) {
    const form = document.getElementById('dmdata-search-form');
    if (!form) return;
    const submit = form.querySelector('button[type="submit"]');
    const category = document.getElementById('dmdata-category').value;
    const limit = document.getElementById('dmdata-limit').value;
    const params = new URLSearchParams({ category, limit });
    if (dmdataEventId) params.set('eventId', dmdataEventId);
    if (nextPage && dmdataNextToken) params.set('cursorToken', dmdataNextToken);
    if (submit) submit.disabled = true;
    setDmdataStatus('DMDATAから過去受信を取得しています…', 'info');
    try {
        const response = await fetch(`/site/xml-admin/api/dmdata-history?${params}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success !== true) throw new Error(data.message || `取得に失敗しました（HTTP ${response.status}）。`);
        dmdataItems = data.items || [];
        dmdataNextToken = data.nextToken || '';
        document.getElementById('admin-email').textContent = data.admin || document.getElementById('admin-email').textContent;
        document.getElementById('dmdata-next-btn').hidden = !dmdataNextToken || Boolean(dmdataEventId);
        document.getElementById('dmdata-back-btn').hidden = !dmdataEventId;
        renderDmdataRows();
        setDmdataStatus(`${dmdataItems.length}件を取得しました。APIへの再取得は60秒間抑制されます。`, 'success');
    } catch (error) {
        setDmdataStatus(error.message, 'error');
    } finally {
        if (submit) submit.disabled = false;
    }
}

function renderDmdataRows() {
    const body = document.getElementById('dmdata-rows');
    if (!body) return;
    const query = document.getElementById('dmdata-query')?.value.trim().toLocaleLowerCase('ja-JP') || '';
    const state = document.getElementById('dmdata-state')?.value || 'all';
    const rows = dmdataItems.filter((item) => {
        if (state !== 'all' && item.deliveryState !== state) return false;
        if (!query) return true;
        return [item.title, item.controlTitle, item.headline, item.typeCode, item.classification, item.eventId, item.sourceId, item.lastDeliveryId, item.lastDeliveryTitle]
            .some((value) => String(value || '').toLocaleLowerCase('ja-JP').includes(query));
    });
    body.replaceChildren();
    if (!rows.length) {
        const tr = document.createElement('tr');
        const td = element('td', 'empty', dmdataItems.length ? '条件に一致する電文はありません。' : '過去受信はまだ取得していません。');
        td.colSpan = 6;
        tr.append(td);
        body.append(tr);
        return;
    }
    for (const item of rows) {
        const tr = document.createElement('tr');
        const title = element('td');
        title.append(element('strong', '', item.title || '名称未取得'));
        if (item.headline) title.append(element('small', 'block-code', item.headline));
        const type = element('td');
        type.append(element('span', '', item.classification || '—'), element('code', 'block-code', item.typeCode || item.format || '—'));
        if (item.warningLabel) type.append(element('small', `block-code eew-${item.isWarning ? 'warning' : 'forecast'}`, item.warningLabel));
        const event = element('td');
        event.append(element('code', '', item.eventId || '—'));
        if (item.serial) event.append(element('small', 'block-code', `第${item.serial}報`));
        const status = element('td');
        status.append(element('span', `component-status dmdata-${item.deliveryState || 'unknown'}`, item.deliveryStateLabel || item.deliveryState || '不明'));
        if (item.lastDeliveryAt) status.append(element('small', 'block-code', `${formatDate(item.lastDeliveryAt)} / ${item.lastDeliverySlot || '配信枠不明'}`));
        if (item.lastDeliveryTitle) status.append(element('small', 'block-code', `配信タイトル: ${item.lastDeliveryTitle}`));
        if (item.lastDeliveryId) status.append(element('code', 'block-code', item.lastDeliveryId));
        const actions = element('td');
        const button = element('button', 'small', item.needsReports ? '各報を表示' : (item.deliveryState === 'delivered' ? 'XMLを再読込' : 'XMLを読み込む'));
        button.type = 'button';
        button.disabled = !item.needsReports && !item.selectable;
        button.addEventListener('click', () => item.needsReports ? loadDmdataEvent(item.eventId) : loadDmdataXml(item, button));
        actions.append(button);
        tr.append(element('td', '', formatDate(item.receivedTime || item.reportTime)), title, type, event, status, actions);
        body.append(tr);
    }
}

async function loadDmdataEvent(eventId) {
    if (!eventId) return;
    dmdataEventId = eventId;
    await loadDmdataHistory(false);
}

async function loadDmdataXml(item, button) {
    try {
        const data = await runAction({ action: 'dmdata-load-xml', sourceId: item.sourceId }, button, false);
        document.getElementById('xml-content').value = data.xml || '';
        selectedDmdataSource = {
            sourceId: item.sourceId,
            classification: item.classification || '',
            typeCode: item.typeCode || '',
            receivedTime: item.receivedTime || '',
            eventId: item.eventId || '',
            title: item.title || '',
            isWarning: Boolean(item.isWarning),
            xmlSha256: data.xmlSha256 || '',
        };
        if (String(item.category || '').startsWith('eew')) document.getElementById('xml-route').value = 'eew';
        renderSelectedDmdata();
        invalidateXmlPreview();
        await previewXml();
        document.getElementById('xml-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch { /* runAction already presents the error */ }
}

function renderSelectedDmdata() {
    const box = document.getElementById('dmdata-selected');
    if (!box) return;
    if (!selectedDmdataSource) {
        box.hidden = true;
        box.replaceChildren();
        return;
    }
    box.replaceChildren(
        element('strong', '', `DMDATA選択中: ${selectedDmdataSource.title || selectedDmdataSource.typeCode || '電文'}`),
        element('code', 'block-code', selectedDmdataSource.sourceId),
        element('small', 'block-code', `${selectedDmdataSource.classification || '分類不明'} / ${formatDate(selectedDmdataSource.receivedTime)}`),
    );
    box.hidden = false;
}

function clearDmdataSource() {
    selectedDmdataSource = null;
    renderSelectedDmdata();
}

function setDmdataStatus(message, type) {
    const node = document.getElementById('dmdata-status');
    if (!node) return;
    node.textContent = message;
    node.className = type ? `status ${type}` : 'status';
}

function updateModeHint() {
    const select = document.getElementById('mode-select');
    if (!select) return;
    const descriptions = { automatic: '既存の死活監視で通常・スタンバイ・バックアップを自動判定します。', normal: '既存の通常時配置・待機時間を使用します。', standby: '既存のBACKUP_STANDBYに準拠します。', backup: '既存のBACKUPに準拠します。', manual: '自宅と4台のEC2を個別に設定します。', emergency: '自宅の生死に関係なくEC2などの配信待機をなくします。停止中EC2の起動には時間がかかります。', emergency_stop: '全配信元とAWS送信段で配信を停止します。既にDiscordが受信した通知は取り消せません。', failover: '従来のEC2全台起動・バックアップ固定設定です。' };
    const description = document.getElementById('mode-description');
    if (description) description.textContent = descriptions[select.value] || '';
    const manual = document.getElementById('manual-node-settings');
    if (manual) manual.hidden = select.value !== 'manual';
    renderSelectedModePlan();
}

function renderSelectedModePlan() {
    const container = document.getElementById('selected-mode-plan');
    const select = document.getElementById('mode-select');
    if (!container || !select) return;
    const mode = select.value;
    const plan = mode === 'manual'
        ? Object.fromEntries(Object.keys(nodeLabels).map((id) => {
            const delivery = document.getElementById(`node-mode-${id}`)?.value || 'stopped';
            const waitSeconds = delivery === 'standby' ? Number(document.getElementById(`node-wait-${id}`)?.value || 3) : 0;
            return [id, { delivery, waitSeconds }];
        }))
        : systemModePlans[mode];
    if (!plan) {
        container.replaceChildren(element('p', 'empty', 'モード動作を取得できません。最新情報に更新してください。'));
        return;
    }
    container.replaceChildren(...Object.entries(nodeLabels).map(([id, label]) => {
        const policy = plan[id] || {};
        const card = element('article', 'mode-plan-card');
        card.append(
            element('span', 'eyebrow', id === 'home' ? 'HOME SERVER' : 'EC2'),
            element('h3', '', label),
            element('strong', `mode-plan-state state-${policy.delivery || 'unknown'}`, deliveryModeLabels[policy.delivery] || '未取得'),
            element('small', '', policy.delivery === 'standby' ? `待機時間 ${policy.waitSeconds ?? '—'}秒後に配信` : policy.delivery === 'immediate' ? '待機時間なしで配信' : policy.delivery === 'stopped' ? '新規配信を停止' : '死活監視の判定に従う'),
        );
        return card;
    }));
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
    clearDmdataSource();
    invalidateXmlPreview();
}

async function previewXml() {
    const button = document.getElementById('xml-preview-btn');
    invalidateXmlPreview();
    const sequence = xmlPreviewSequence;
    try {
        const data = await runAction({ action: 'xml-preview', xml: document.getElementById('xml-content').value, deliverySlot: document.getElementById('xml-slot').value, sendData: document.getElementById('xml-route').value }, button, false);
        if (sequence !== xmlPreviewSequence) return;
        const preview = data.preview || {};
        const box = document.getElementById('xml-preview');
        const list = element('dl');
        for (const [label, value] of [['電文種別', preview.controlTitle], ['見出し', preview.headline], ['イベントID', preview.eventId], ['発表時刻', preview.reportDateTime], ['対象時刻', preview.targetDateTime], ['発表元', preview.publishingOffice], ['状態', preview.status], ['サイズ', `${Number(data.bytes || 0).toLocaleString('ja-JP')} bytes`]]) list.append(element('dt', '', label), element('dd', '', value || '—'));
        box.replaceChildren(element('h3', '', 'XMLプレビュー'), list);
        box.append(element('p', '', data.formatNote || ''), element('p', '', `実際に送信するメッセージ: ${data.messageCount || 0}通 / 配信先`));
        for (const [index, message] of (data.messages || []).entries()) {
            const messageBox = element('article', 'discord-message-preview');
            messageBox.append(element('h4', '', `${index + 1}. ${message.username || 'DPI-Bot'}`));
            for (const embed of message.embeds || []) {
                const card = element('div', 'discord-embed-preview');
                if (Number.isInteger(embed.color)) card.style.borderLeftColor = `#${embed.color.toString(16).padStart(6, '0')}`;
                card.append(element('strong', '', embed.title || ''), element('pre', 'embed-description', embed.description || ''));
                const fields = element('dl', 'embed-fields');
                for (const field of embed.fields || []) fields.append(element('dt', '', field.name), element('dd', '', field.value));
                card.append(fields, element('small', '', embed.footer?.text || ''));
                messageBox.append(card);
            }
            box.append(messageBox);
        }
        const raw = element('details');
        raw.append(element('summary', '', '送信JSONを確認'), element('pre', 'embed-description', JSON.stringify(data.messages || [], null, 2)));
        box.append(raw);
        box.hidden = false;
        xmlPreviewDigest = data.previewDigest || '';
        xmlPreviewValid = Boolean(xmlPreviewDigest && data.messages?.length);
        document.getElementById('xml-send-btn').disabled = !xmlPreviewValid;
        updateXmlHint();
    } catch {
        if (sequence === xmlPreviewSequence) invalidateXmlPreview();
    }
}

async function dispatchXml(event) {
    event.preventDefault();
    if (!xmlPreviewValid) return setStatus('XMLをもう一度確認してください。', 'error');
    if (!window.confirm('選択した配信枠へXMLを配信します。この操作は利用者への通知につながります。続行しますか？')) return;
    const deliverySlot = document.getElementById('xml-slot').value;
    const payload = { action: 'xml-dispatch', xml: document.getElementById('xml-content').value, deliverySlot, sendData: document.getElementById('xml-route').value, confirmation: `XML配信:${deliverySlot}`, dmdataSource: selectedDmdataSource, previewDigest: xmlPreviewDigest };
    try {
        await runAction(payload, event.submitter, true);
        if (selectedDmdataSource) {
            selectedDmdataSource.deliveryState = 'delivered';
            loadDmdataHistory(false);
        }
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
    xmlPreviewSequence += 1;
    xmlPreviewDigest = '';
    const preview = document.getElementById('xml-preview');
    const sendButton = document.getElementById('xml-send-btn');
    if (!preview || !sendButton) return;
    xmlPreviewValid = false;
    preview.hidden = true;
    sendButton.disabled = true;
    updateXmlHint();
}

function updateXmlHint() {
    // The backend confirmation token is generated after the popup is accepted.
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
