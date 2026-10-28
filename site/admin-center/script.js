let xmlPreviewValid = false;
let xmlPreviewDigest = '';
let xmlPreviewSequence = 0;
let systemModeRevision = null;
let systemModePlans = {};
let systemMaintenanceReady = false;
const modeLabels = { automatic: '自動監視', normal: '通常モード', standby: 'スタンバイモード', backup: 'バックアップモード', manual: '手動モード', maintenance: 'メンテナンスモード', emergency: '緊急モード', emergency_stop: '緊急停止モード', failover: 'バックアップ固定（旧設定）' };
const nodeLabels = { home: '自宅サーバー', 'tokyo-eew': '東京 EC2：EEW・地震・津波', 'tokyo-weather': '東京 EC2：気象・火山', 'osaka-eew': '大阪 EC2：EEW・地震・津波', 'osaka-weather': '大阪 EC2：気象・火山' };
const deliveryModeLabels = { immediate: '即時配信', standby: '待機して配信', stopped: '配信停止', automatic: '自動判定' };
const routeLabels = { fast: '高速系統', sqs: 'SQS系統', 'regional-backup': 'リージョン内バックアップ', 'cross-region-backup': '相互バックアップ' };
const testSourceLabels = { admin: '管理サイト', home: '自宅サーバー', 'tokyo-eew': '東京EC2（EEW・地震・津波）', 'tokyo-weather': '東京EC2（気象・火山）', 'osaka-eew': '大阪EC2（EEW・地震・津波）', 'osaka-weather': '大阪EC2（気象・火山）' };
let testDeliveryPollTimer = null;
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
    document.getElementById('test-delivery-refresh')?.addEventListener('click', () => loadTestDelivery(true));
    document.getElementById('test-delivery-preview-btn')?.addEventListener('click', previewTestDelivery);
    document.getElementById('test-delivery-form')?.addEventListener('submit', startTestDelivery);
    document.getElementById('test-functions-all')?.addEventListener('click', () => setTestFunctions(true));
    document.getElementById('test-functions-clear')?.addEventListener('click', () => setTestFunctions(false));
    if (document.getElementById('test-delivery-form')) loadTestDelivery(false);
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
    renderDynamoDbBackups(data.aws?.dynamoDb);
    renderCloudWatchAlarms(data.aws?.alarms);
    renderMode(data.aws?.systemMode);
    renderEc2(data.aws?.backupInstances);
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
    const auditCount = Number(local?.auditCount || 0);
    const items = [
        { title: 'システム運用', value: modeName, detail: aws?.available ? `AWS警報 ${aws.alarms?.active ?? '—'}件 / Cloudflare ${cloudflare?.worker || '—'}` : (aws?.message || 'AWS情報を取得できません'), href: '/site/system-admin/' },
        { title: '自宅サーバー', value: home?.available ? `正常 ${home.healthy ?? 0}台` : '取得不可', detail: home?.available ? `異常・期限切れ ${home.unhealthy ?? 0}台` : (home?.error || '状態を確認できません'), href: '/site/system-admin/' },
        { title: 'EC2管理', value: backup?.available ? `${runningInstances}/${backup.count ?? 0}台 稼働` : '取得不可', detail: 'バックアップEC2の詳細・操作', href: '/site/ec2-admin/' },
        { key: 'statuspage', title: 'ステータス管理', value: '読込中…', detail: '稼働状況・インシデント・メンテナンス', href: '/site/status-admin/' },
        { title: 'XML配信', value: `${activeSlots}配信枠`, detail: `AWS配信先 ${aws?.deliveryDirectory?.channels ?? '—'}チャンネル`, href: '/site/xml-admin/' },
        { title: '配信系統', value: '系統別監視', detail: '上流・自宅・高速・SQS・バックアップ', href: '/site/delivery-flow-admin/' },
        { title: '配信先', value: `${aws?.deliveryDirectory?.servers ?? '—'}サーバー`, detail: '登録チャンネル・配信名を検索', href: '/site/channel-admin/' },
        { title: '監査ログ', value: `${auditCount}件`, detail: '管理操作・申請・遮断の履歴', href: '/site/system-admin/audit/' },
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

function renderDynamoDbBackups(summary) {
    const metrics = document.getElementById('dynamodb-backup-summary');
    const body = document.getElementById('dynamodb-backup-rows');
    if (!metrics || !body) return;
    const rows = summary?.available ? (summary.tables || []) : [];
    const cards = summary?.available ? [
        ['対象テーブル', summary.count ?? rows.length],
        ['PITR有効', summary.pitrEnabled ?? 0],
        ['PITR無効', summary.pitrDisabled ?? 0],
        ['取得エラー', summary.backupErrors ?? 0],
    ] : [['取得状態', '取得不可']];
    metrics.replaceChildren(...cards.map(([label, value]) => {
        const card = element('article', 'metric-card compact');
        card.append(element('span', '', label), element('strong', '', String(value)));
        return card;
    }));
    body.replaceChildren();
    if (!rows.length) {
        appendEmptyRow(body, 7, summary?.error ? `バックアップ状況を取得できません（${summary.error}）` : '対象テーブルはありません。');
        return;
    }
    for (const table of rows) {
        const row = document.createElement('tr');
        const pitr = element('span', `component-status ${table.pitrStatus === 'ENABLED' ? 'status-ok' : table.pitrStatus === 'DISABLED' ? 'status-impaired' : 'status-initializing'}`, table.pitrStatus === 'ENABLED' ? 'PITR有効' : table.pitrStatus === 'DISABLED' ? 'PITR無効' : '取得不可');
        const restore = table.pitrStatus === 'ENABLED'
            ? `${formatDate(table.earliestRestorableAt)} ～ ${formatDate(table.latestRestorableAt)}${table.recoveryPeriodDays ? `（${table.recoveryPeriodDays}日）` : ''}`
            : '—';
        const latest = table.lastBackupAt
            ? `${formatDate(table.lastBackupAt)} / ${table.lastBackupType || '種別不明'}${table.lastBackupStatus ? ` / ${table.lastBackupStatus}` : ''}`
            : 'なし';
        const tableCell = element('td');
        tableCell.append(element('strong', '', table.name || '—'));
        if (table.backupError) tableCell.append(element('small', 'block-code', `取得エラー: ${table.backupError}`));
        row.append(
            element('td', '', regionName(table.region)),
            tableCell,
            element('td', '', table.status || '—'),
            element('td'),
            element('td', '', restore),
            element('td', '', latest),
            element('td', '', table.deletionProtectionEnabled ? '有効' : '無効'),
        );
        row.children[3].append(pitr);
        body.append(row);
    }
}

function renderCloudWatchAlarms(summary) {
    const metrics = document.getElementById('cloudwatch-alarm-summary');
    const body = document.getElementById('cloudwatch-alarm-rows');
    if (!metrics || !body) return;
    const alarms = summary?.available ? (summary.items || []) : [];
    const cards = summary?.available ? [
        ['警報中', summary.active ?? 0],
        ['正常', summary.ok ?? 0],
        ['データ不足', summary.insufficientData ?? 0],
        ['通知停止中', summary.actionsDisabled ?? 0],
        ['合計', summary.total ?? alarms.length],
    ] : [['取得状態', '取得不可']];
    metrics.replaceChildren(...cards.map(([label, value]) => {
        const card = element('article', 'metric-card compact');
        card.append(element('span', '', label), element('strong', '', String(value)));
        return card;
    }));
    body.replaceChildren();
    if (!alarms.length) {
        appendEmptyRow(body, 6, summary?.error ? `アラーム状況を取得できません（${summary.error}）` : 'CloudWatchアラームはありません。');
        return;
    }
    for (const alarm of alarms) {
        const row = document.createElement('tr');
        row.className = 'alarm-summary-row';
        row.tabIndex = 0;
        const stateClass = alarm.state === 'ALARM' ? 'status-major_outage' : alarm.state === 'OK' ? 'status-ok' : 'status-investigating';
        const name = element('td');
        name.append(element('strong', '', alarm.name || '—'));
        if (alarm.description) name.append(element('small', 'block-code', alarm.description));
        const evaluation = [
            alarm.datapointsToAlarm && alarm.evaluationPeriods ? `${alarm.datapointsToAlarm}/${alarm.evaluationPeriods}` : null,
            alarm.periodSeconds ? `${alarm.periodSeconds}秒` : null,
            alarm.threshold != null ? `しきい値 ${alarm.threshold}` : null,
            alarm.treatMissingData ? `欠損=${alarm.treatMissingData}` : null,
        ].filter(Boolean).join(' / ') || '—';
        const notifications = alarm.actionsEnabled
            ? `有効（警報 ${alarm.alarmActionCount ?? 0} / 復旧 ${alarm.okActionCount ?? 0}）`
            : '停止中';
        const state = element('td');
        state.append(element('span', `component-status ${stateClass}`, alarm.state || 'UNKNOWN'));
        const toggleCell = element('td');
        const toggle = element('button', 'small secondary-button', '詳細');
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', 'false');
        toggleCell.append(toggle);
        row.append(state, element('td', '', regionName(alarm.region)), name, element('td', alarm.actionsEnabled ? '' : 'state-stopped', notifications), element('td', '', formatDate(alarm.lastStateChangeAt || alarm.stateTransitionedAt || alarm.stateUpdatedAt)), toggleCell);

        const detailRow = document.createElement('tr');
        detailRow.className = 'alarm-detail-row';
        detailRow.hidden = true;
        const detail = element('td', 'alarm-detail');
        detail.colSpan = 6;
        const transition = alarm.previousState
            ? `${alarm.previousState} → ${alarm.currentState || alarm.state}`
            : `現在 ${alarm.currentState || alarm.state || 'UNKNOWN'}`;
        const list = element('dl', 'alarm-detail-grid');
        for (const [label, value] of [
            ['状態遷移', `${transition}（${formatDate(alarm.lastStateChangeAt || alarm.stateTransitionedAt || alarm.stateUpdatedAt)}）`],
            ['判定条件', evaluation],
            ['通知', notifications],
            ['状態理由', alarm.stateChangeReason || alarm.stateReason || '—'],
            ['設定最終変更', formatDate(alarm.configurationUpdatedAt)],
            ['説明', alarm.description || '—'],
        ]) list.append(element('dt', '', label), element('dd', '', value));
        detail.append(list);
        detailRow.append(detail);
        const toggleDetail = () => {
            detailRow.hidden = !detailRow.hidden;
            toggle.textContent = detailRow.hidden ? '詳細' : '閉じる';
            toggle.setAttribute('aria-expanded', String(!detailRow.hidden));
        };
        toggle.addEventListener('click', (event) => { event.stopPropagation(); toggleDetail(); });
        row.addEventListener('click', toggleDetail);
        row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleDetail(); } });
        body.append(row, detailRow);
    }
}

function appendEmptyRow(body, columns, message) {
    const row = document.createElement('tr');
    const cell = element('td', 'empty', message);
    cell.colSpan = columns;
    row.append(cell);
    body.append(row);
}

function regionName(region) {
    return region === 'ap-northeast-1' ? '東京' : region === 'ap-northeast-3' ? '大阪' : (region || '—');
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
    systemMaintenanceReady = mode.maintenanceReadiness?.ready === true;
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
    if (mode.controlMode === 'maintenance') {
        const routes = element('div', 'system-grid');
        for (const [id, label] of Object.entries(routeLabels)) {
            const policy = mode.routePlan?.[id] || {};
            const item = element('article', 'mode-plan-card');
            item.append(element('span', 'eyebrow', 'DELIVERY ROUTE'), element('h3', '', label), element('strong', policy.enabled ? 'state-immediate' : 'state-stopped', policy.enabled ? `稼働・優先度 ${policy.priority ?? '—'}` : '停止'));
            routes.append(item);
        }
        container.append(element('h3', '', 'メンテナンス中の配信系統'), routes);
        const suppressed = (mode.notificationPolicy?.suppressed || []).join('、') || 'なし';
        container.append(element('p', 'configuration-notice maintenance-notice', `通知抑止中: ${suppressed}。重大障害・セキュリティ・試験通知は維持されます。`));
    }
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
            option.disabled = option.value === 'maintenance' ? !systemMaintenanceReady : !mode.runtimeReadiness?.ready;
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
    const routeControls = document.getElementById('maintenance-route-controls');
    if (routeControls && !routeControls.children.length) {
        for (const [id, label] of Object.entries(routeLabels)) {
            const group = element('div', 'route-control-card');
            const enabledLabel = element('label', 'checkbox-label', label);
            const enabled = element('input'); enabled.type = 'checkbox'; enabled.id = `route-enabled-${id}`;
            enabled.addEventListener('change', renderSelectedRoutePlan);
            enabledLabel.prepend(enabled);
            const priorityLabel = element('label', '', '優先順位');
            const priority = element('select'); priority.id = `route-priority-${id}`;
            for (let number = 1; number <= 4; number += 1) { const option = element('option', '', String(number)); option.value = String(number); priority.append(option); }
            priority.addEventListener('change', renderSelectedRoutePlan);
            priorityLabel.append(priority);
            group.append(enabledLabel, priorityLabel);
            routeControls.append(group);
        }
    }
    for (const node of mode.nodes || []) {
        const input = document.getElementById(`node-mode-${node.nodeId}`);
        const wait = document.getElementById(`node-wait-${node.nodeId}`);
        if (input && ['immediate', 'standby', 'stopped'].includes(node.requested?.delivery)) input.value = node.requested.delivery;
        if (wait) wait.value = String(node.requested?.waitSeconds > 0 ? node.requested.waitSeconds : 3);
    }
    for (const [id] of Object.entries(routeLabels)) {
        const enabled = document.getElementById(`route-enabled-${id}`);
        const priority = document.getElementById(`route-priority-${id}`);
        if (enabled) enabled.checked = mode.routePlan?.[id]?.enabled !== false;
        if (priority) priority.value = String(mode.routePlan?.[id]?.priority || Object.keys(routeLabels).indexOf(id) + 1);
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
    const nodeOverrides = ['manual', 'maintenance'].includes(mode) ? Object.fromEntries(Object.keys(nodeLabels).map(id => [id, { delivery: document.getElementById(`node-mode-${id}`).value, waitSeconds: Number(document.getElementById(`node-wait-${id}`).value) }])) : undefined;
    const routeOverrides = mode === 'maintenance' ? Object.fromEntries(Object.keys(routeLabels).map(id => [id, { enabled: document.getElementById(`route-enabled-${id}`).checked, priority: Number(document.getElementById(`route-priority-${id}`).value) }])) : undefined;
    if (!window.confirm(`${modeLabels[mode] || mode}へ変更します。\n画面に表示された自宅サーバー・各EC2の動作が適用され、対象EC2の起動状態が変化する場合があります。続行しますか？`)) return;
    try {
        await runAction({ action: 'system-mode', mode, reason, confirmation, expectedRevision: systemModeRevision, nodeOverrides, routeOverrides }, event.submitter, true);
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
        const route = routeForDmdataItem(item);
        if (route) document.getElementById('xml-route').value = route;
        renderSelectedDmdata();
        invalidateXmlPreview();
        await previewXml();
        document.getElementById('xml-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch { /* runAction already presents the error */ }
}

function routeForDmdataItem(item) {
    const typeCode = String(item.typeCode || '').toUpperCase();
    const category = String(item.category || '').toLowerCase();
    if (typeCode === 'VXSE43') return 'keiho';
    if (['VXSE42', 'VXSE44', 'VXSE45', 'VXSE47'].includes(typeCode) || category.startsWith('eew')) return 'eew';
    if (typeCode.startsWith('VXSE') || typeCode.startsWith('VYSE')) return 'zisin';
    if (typeCode.startsWith('VTSE')) return 'tunami';
    if (typeCode.startsWith('VFVO') || category === 'volcano') return 'kazan';
    if (category === 'weather') return 'kisyo';
    return '';
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
    const descriptions = { automatic: '既存の死活監視で通常・スタンバイ・バックアップを自動判定します。', normal: '既存の通常時配置・待機時間を使用します。', standby: '既存のBACKUP_STANDBYに準拠します。', backup: '既存のBACKUPに準拠します。', manual: '自宅と4台のEC2を個別に設定します。', maintenance: '配信元と配信系統を個別指定し、不要な運用通知を抑止します。重大障害・セキュリティ・試験通知は維持します。', emergency: '自宅の生死に関係なくEC2などの配信待機をなくします。停止中EC2の起動には時間がかかります。', emergency_stop: '全配信元とAWS送信段で配信を停止します。既にDiscordが受信した通知は取り消せません。', failover: '従来のEC2全台起動・バックアップ固定設定です。' };
    const description = document.getElementById('mode-description');
    if (description) description.textContent = descriptions[select.value] || '';
    const manual = document.getElementById('manual-node-settings');
    if (manual) manual.hidden = !['manual', 'maintenance'].includes(select.value);
    const routes = document.getElementById('maintenance-route-settings');
    if (routes) routes.hidden = select.value !== 'maintenance';
    renderSelectedRoutePlan();
    renderSelectedModePlan();
}

function renderSelectedModePlan() {
    const container = document.getElementById('selected-mode-plan');
    const select = document.getElementById('mode-select');
    if (!container || !select) return;
    const mode = select.value;
    const plan = ['manual', 'maintenance'].includes(mode)
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

function renderSelectedRoutePlan() {
    for (const id of Object.keys(routeLabels)) {
        const enabled = document.getElementById(`route-enabled-${id}`);
        const priority = document.getElementById(`route-priority-${id}`);
        if (priority) priority.disabled = !enabled?.checked;
    }
}

async function loadTestDelivery(showStatus, runId = '') {
    const container = document.getElementById('test-delivery-runs');
    if (!container) return;
    if (showStatus) setTestDeliveryStatus('試験配信情報を更新しています…', 'info');
    const params = new URLSearchParams();
    if (runId) params.set('runId', runId);
    try {
        const response = await fetch(`/site/system-admin/api/test-delivery${params.size ? `?${params}` : ''}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success !== true) throw new Error(data.message || `取得に失敗しました（HTTP ${response.status}）。`);
        renderTestDeliveryInventory(data);
        renderTestDeliveryRuns(data.runs || []);
        const active = (data.runs || []).some((run) => ['queued', 'running'].includes(run?.status));
        const activeRun = (data.runs || []).find((run) => ['queued', 'running'].includes(run?.status));
        scheduleTestDeliveryPoll(active, activeRun?.runId || runId);
        if (showStatus) setTestDeliveryStatus(`配信枠「${data.testSlot || '配信テスト'}」: 有効な送信先 ${Number(data.testSlotTargetCount || 0)}件`, data.testSlotTargetCount > 0 ? 'success' : 'error');
    } catch (error) {
        setTestDeliveryStatus(error.message, 'error');
        scheduleTestDeliveryPoll(false);
    }
}

function renderTestDeliveryInventory(data) {
    const sources = document.getElementById('test-source-controls');
    if (sources && !sources.children.length) {
        for (const [id, label] of Object.entries(testSourceLabels)) sources.append(testChoice('source', id, label, id === 'admin'));
    }
    const routes = document.getElementById('test-route-controls');
    if (routes && !routes.children.length) {
        for (const route of data.routes || []) routes.append(testChoice('route', route.id, route.label || routeLabels[route.id] || route.id, true));
    }
    const functions = document.getElementById('test-function-controls');
    if (!functions || functions.children.length) return;
    const groups = new Map();
    for (const item of data.functions || []) {
        const key = `${item.region}:${item.group}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
    }
    const groupLabels = { primary: '共通プライマリ', backup: '共通バックアップ', eew: '緊急地震速報', 'eew-warning': '緊急地震速報（警報）', earthquake: '地震情報', tsunami: '津波情報', weather: '気象情報', volcano: '火山情報', sub: '補助配信' };
    for (const [key, items] of groups) {
        const [region, group] = key.split(':');
        const details = element('details', 'test-function-group');
        const summary = element('summary', '', `${region === 'ap-northeast-1' ? '東京' : '大阪'} / ${groupLabels[group] || group}（${items.length}）`);
        const options = element('div', 'option-grid');
        for (const item of items) options.append(testFunctionChoice(item, false));
        details.append(summary, options);
        functions.append(details);
    }
    const submit = document.getElementById('test-delivery-submit');
    if (submit) submit.disabled = Number(data.testSlotTargetCount || 0) === 0;
    setTestDeliveryStatus(`配信枠「${data.testSlot || '配信テスト'}」: 有効な送信先 ${Number(data.testSlotTargetCount || 0)}件`, data.testSlotTargetCount > 0 ? 'success' : 'error');
}

function testChoice(kind, value, label, checked) {
    const wrapper = element('label', 'checkbox-label', label);
    const input = element('input'); input.type = 'checkbox'; input.name = `test-${kind}`; input.value = value; input.checked = checked;
    wrapper.prepend(input);
    return wrapper;
}

function testFunctionChoice(item, checked) {
    const wrapper = testChoice('function', `${item.region}|${item.name}`, item.name, checked);
    wrapper.querySelector('input').dataset.region = item.region;
    wrapper.querySelector('input').dataset.name = item.name;
    return wrapper;
}

function setTestFunctions(checked) {
    for (const input of document.querySelectorAll('input[name="test-function"]')) input.checked = checked;
}

function testDeliveryPayload(action) {
    const checkedValues = (name) => [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
    return {
        action,
        sources: checkedValues('test-source'),
        routes: checkedValues('test-route'),
        functions: [...document.querySelectorAll('input[name="test-function"]:checked')].map((input) => ({ region: input.dataset.region, name: input.dataset.name })),
        title: document.getElementById('test-delivery-title-input')?.value || '',
        note: document.getElementById('test-delivery-note')?.value || '',
    };
}

async function previewTestDelivery() {
    const button = document.getElementById('test-delivery-preview-btn');
    try {
        const data = await runAction(testDeliveryPayload('test-delivery-preview'), button, false);
        const box = document.getElementById('test-delivery-preview');
        box.replaceChildren(element('h3', '', `送信Embedプレビュー（予定処理 ${Number(data.plannedSteps || 0)}件）`));
        for (const message of data.preview || []) appendDiscordPreview(box, message);
        if (Number(data.plannedSteps || 0) > Number((data.preview || []).length)) box.append(element('p', 'muted', `画面では先頭${(data.preview || []).length}件を表示しています。`));
        box.hidden = false;
    } catch { /* runAction already presents the error */ }
}

function appendDiscordPreview(container, message) {
    const messageBox = element('article', 'discord-message-preview');
    messageBox.append(element('h4', '', message.username || 'DPI-Bot 配信試験'));
    for (const embed of message.embeds || []) {
        const card = element('div', 'discord-embed-preview');
        if (Number.isInteger(embed.color)) card.style.borderLeftColor = `#${embed.color.toString(16).padStart(6, '0')}`;
        card.append(element('strong', '', embed.title || ''), element('p', 'embed-description', embed.description || ''));
        const fields = element('dl', 'embed-fields');
        for (const field of embed.fields || []) fields.append(element('dt', '', field.name || ''), element('dd', '', field.value || ''));
        card.append(fields, element('small', 'muted', embed.footer?.text || ''));
        messageBox.append(card);
    }
    container.append(messageBox);
}

async function startTestDelivery(event) {
    event.preventDefault();
    const payload = testDeliveryPayload('test-delivery');
    if (!payload.sources.length || (!payload.routes.length && !payload.functions.length)) return setTestDeliveryStatus('試験開始元と、配信系統またはLambdaを1つ以上選択してください。', 'error');
    const planned = payload.functions.length + payload.sources.length * payload.routes.length;
    if (!window.confirm(`配信枠「配信テスト」へ${planned}系統分の試験配信を開始します。実際にDiscordへ送信されます。続行しますか？`)) return;
    try {
        const data = await runAction(payload, event.submitter, false);
        setTestDeliveryStatus(`試験実行 ${data.runId} を開始しました。`, 'success');
        await loadTestDelivery(false, data.runId);
    } catch { /* runAction already presents the error */ }
}

function renderTestDeliveryRuns(runs) {
    const container = document.getElementById('test-delivery-runs');
    if (!container) return;
    container.replaceChildren();
    if (!runs.length) return container.append(element('p', 'empty', '試験実行履歴はありません。'));
    const statusLabels = { queued: '開始待ち', running: '実行中', completed: '正常終了', completed_with_errors: '異常あり', failed: '異常終了' };
    for (const run of runs) {
        const card = element('article', 'record-card test-run-card');
        const heading = element('div', 'record-heading');
        const title = element('div');
        title.append(element('h3', '', run.runId || '試験実行'), element('small', 'muted', `${formatDate(run.requestedAt)} / ${run.requestedBy || '—'}`));
        const status = element('span', `component-status status-${run.status === 'completed' ? 'completed' : ['queued', 'running'].includes(run.status) ? 'scheduled' : 'major_outage'}`, statusLabels[run.status] || run.status || '不明');
        heading.append(title, status);
        const summary = element('dl', 'test-run-summary');
        for (const [label, value] of [['正常終了', run.successCount ?? 0], ['異常・時間切れ', run.failureCount ?? 0], ['処理中', run.pendingCount ?? 0], ['送信先', run.targetCount ?? 0], ['Lambda', run.functionCount ?? 0], ['開始元', (run.sources || []).map((id) => testSourceLabels[id] || id).join('、') || '—'], ['系統', (run.routes || []).map((id) => routeLabels[id] || id).join('、') || '—']]) summary.append(element('dt', '', label), element('dd', '', String(value)));
        card.append(heading, summary);
        if (run.error) card.append(element('p', 'status error', run.error));
        const details = element('details', 'test-run-details');
        details.append(element('summary', '', `系統別結果（${(run.steps || []).length}件）`));
        const tableWrap = element('div', 'table-wrap');
        const table = document.createElement('table');
        const head = document.createElement('thead'); const headRow = document.createElement('tr');
        for (const value of ['対象', 'リージョン', '結果', '件数', '所要時間', '詳細']) headRow.append(element('th', '', value));
        head.append(headRow); table.append(head);
        const body = document.createElement('tbody');
        for (const step of run.steps || []) {
            const row = document.createElement('tr');
            const target = step.kind === 'lambda' ? step.name : `${routeLabels[step.route] || step.route} / ${testSourceLabels[step.source] || step.source}`;
            const count = step.targetCount != null ? `${step.successCount || 0}/${step.targetCount}` : step.sentCount != null ? String(step.sentCount) : '—';
            const label = step.status === 'success' ? '正常終了' : step.status === 'accepted' ? '受付済み' : step.status === 'timeout' ? '確認時間切れ' : '異常終了';
            row.append(element('td', '', target || '—'), element('td', '', step.region || '—'), element('td', step.status === 'success' ? 'state-immediate' : 'state-stopped', label), element('td', '', count), element('td', '', step.elapsedMs != null ? `${step.elapsedMs} ms` : '—'), element('td', '', step.detail || step.error || '—'));
            body.append(row);
        }
        if (!body.children.length) { const row = document.createElement('tr'); const cell = element('td', 'empty', '結果待ちです。'); cell.colSpan = 6; row.append(cell); body.append(row); }
        table.append(body); tableWrap.append(table); details.append(tableWrap); card.append(details);
        container.append(card);
    }
}

function scheduleTestDeliveryPoll(active, runId = '') {
    if (testDeliveryPollTimer) window.clearTimeout(testDeliveryPollTimer);
    testDeliveryPollTimer = active ? window.setTimeout(() => loadTestDelivery(false, runId), 4000) : null;
}

function setTestDeliveryStatus(message, type) {
    const node = document.getElementById('test-delivery-status');
    if (!node) return;
    node.textContent = message;
    node.className = type ? `status ${type}` : 'status';
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
        const data = await runAction({ action: 'xml-preview', xml: document.getElementById('xml-content').value, deliverySlot: document.getElementById('xml-slot').value, sendData: document.getElementById('xml-route').value, dmdataSource: selectedDmdataSource }, button, false);
        if (sequence !== xmlPreviewSequence) return;
        const preview = data.preview || {};
        const box = document.getElementById('xml-preview');
        const list = element('dl');
        for (const [label, value] of [['電文種別', preview.controlTitle], ['電文コード', data.typeCode || preview.typeCode], ['見出し', preview.headline], ['イベントID', preview.eventId], ['発表時刻', preview.reportDateTime], ['対象時刻', preview.targetDateTime], ['発表元', preview.publishingOffice], ['状態', preview.status], ['サイズ', `${Number(data.bytes || 0).toLocaleString('ja-JP')} bytes`]]) list.append(element('dt', '', label), element('dd', '', value || '—'));
        box.replaceChildren(element('h3', '', 'XMLプレビュー'), list);
        box.append(element('p', '', data.formatNote || ''), element('p', '', `実際に送信するDiscordメッセージ: ${data.messageCount || 0}通（Embed ${data.embedCount || 0}件）`));
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
