document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('refresh-btn').addEventListener('click', loadFlow);
    loadFlow();
});

async function loadFlow() {
    const button = document.getElementById('refresh-btn');
    button.disabled = true;
    setStatus('既存の監視情報から配信系統を確認しています…', 'info');
    try {
        const response = await fetch('/site/delivery-flow-admin/api/summary', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success !== true) throw new Error(data.message || `取得に失敗しました（HTTP ${response.status}）。`);
        document.getElementById('admin-email').textContent = data.admin || '';
        renderFlow(data.flow || {});
        setStatus('配信系統を更新しました。', 'success');
    } catch (error) {
        setStatus(error.message, 'error');
    } finally {
        button.disabled = false;
    }
}

function renderFlow(flow) {
    const summary = flow.summary || {};
    const cards = [
        ['正常', summary.normal || 0, 'normal'],
        ['うち待機中', summary.waiting || 0, 'waiting'],
        ['停止・待機', summary.stopped || 0, 'stopped'],
        ['異常', summary.abnormal || 0, 'abnormal'],
        ['未確認', summary.unknown || 0, 'unknown'],
    ];
    const summaryBox = document.getElementById('flow-summary');
    summaryBox.replaceChildren(...cards.map(([label, value, state]) => {
        const card = el('article', `metric-card flow-metric metric-${state}`);
        card.append(el('span', '', label), el('strong', '', number(value)));
        return card;
    }));
    document.getElementById('observed-at').textContent = `確認: ${formatDate(flow.observedAt)}`;
    document.getElementById('cost-policy').textContent = flow.costPolicy || '';

    const priorityBox = document.getElementById('flow-priority-rules');
    priorityBox.replaceChildren(...(flow.priorityRules || []).map((rule) => {
        const card = el('article', 'flow-priority-card');
        card.append(
            el('span', 'flow-priority-number', rule.priority || '経路'),
            el('strong', '', rule.title || '配信経路'),
            el('p', '', rule.detail || ''),
        );
        return card;
    }));

    const assignmentBox = document.getElementById('flow-primary-assignments');
    assignmentBox.replaceChildren(...(flow.primaryAssignments || []).map((assignment) => {
        const item = el('article', 'flow-assignment-card');
        item.append(
            el('strong', '', assignment.regionLabel || resourceRegionLabel(assignment.region)),
            el('code', '', assignment.region || ''),
            el('p', '', (assignment.types || []).join('、') || '担当種別なし'),
        );
        return item;
    }));

    const container = document.getElementById('flow-layers');
    container.replaceChildren();
    const components = flow.components || [];
    if (flow.flowGraph) {
        container.append(unifiedFlowPanel(flow.flowGraph, components));
        return;
    }
    if ((flow.routes || []).length) {
        for (const route of flow.routes) container.append(routePanel(route, components));
        return;
    }
    for (const [index, layer] of (flow.layers || []).entries()) {
        const section = el('section', 'flow-layer');
        section.append(el('h3', '', layer.label));
        const grid = el('div', 'flow-component-grid');
        const matches = components.filter((component) => component.layer === layer.id);
        if (!matches.length) grid.append(el('p', 'empty', '対象系統はありません。'));
        for (const component of matches) grid.append(componentCard(component));
        section.append(grid);
        if (index > 0) section.classList.add('connected-layer');
        container.append(section);
    }
}

function unifiedFlowPanel(graph, components) {
    const panel = el('article', 'flow-graph');

    const sourceSection = el('section', 'flow-source-section');
    sourceSection.append(el('h3', 'flow-graph-section-title', '受付APIへの入力元'));
    const sourceGrid = el('div', 'flow-source-grid');
    for (const source of (graph.sources || [])) {
        const sourceCard = el('article', 'flow-source-card');
        sourceCard.append(el('h4', '', source.label || '入力元'));
        if (source.description) sourceCard.append(el('p', 'flow-route-description', source.description));
        const sequence = el('div', 'flow-compact-sequence');
        for (const [index, stage] of (source.sequence || []).entries()) {
            if (index > 0) sequence.append(el('span', 'flow-route-arrow', ''));
            sequence.append(routeStage(stage, components));
        }
        sourceCard.append(sequence);
        sourceGrid.append(sourceCard);
    }
    sourceSection.append(sourceGrid);
    panel.append(sourceSection, flowConnector('共通の受付へ合流'));

    const ingress = el('section', 'flow-common-stage flow-common-ingress');
    ingress.append(routeStage(graph.ingress || { id: 'api-ingress', label: '受付API・HA制御' }, components));
    panel.append(ingress, flowConnector('受付後に優先経路へ分岐'));

    const pathSection = el('section', 'flow-path-section');
    pathSection.append(el('h3', 'flow-graph-section-title', '受付API・HA制御からDiscord配信までの候補経路'));
    const pathGrid = el('div', 'flow-path-grid');
    for (const path of (graph.paths || [])) {
        const pathCard = el('article', 'flow-path-card');
        const titleRow = el('div', 'flow-route-title-row');
        if (path.priority) titleRow.append(el('span', 'flow-priority-number flow-route-priority', path.priority));
        titleRow.append(el('h4', '', path.label || '候補経路'));
        pathCard.append(titleRow);
        if (path.description) pathCard.append(el('p', 'flow-route-description', path.description));
        const sequence = el('div', 'flow-compact-sequence');
        for (const [index, stage] of (path.sequence || []).entries()) {
            if (index > 0) sequence.append(el('span', 'flow-route-arrow', ''));
            sequence.append(routeStage(stage, components));
        }
        pathCard.append(sequence);
        pathGrid.append(pathCard);
    }
    pathSection.append(pathGrid);
    panel.append(pathSection, flowConnector('最初に到達した候補だけを採用'));

    if (graph.gate) {
        const gate = el('section', 'flow-common-stage flow-common-gate');
        gate.append(routeStage(graph.gate, components));
        panel.append(gate, flowConnector('所有権を取得した1系統だけが通過'));
    }

    const exit = el('section', 'flow-common-stage flow-common-exit');
    exit.append(routeStage(graph.exit || { id: 'discord-delivery', label: 'Discord配信Lambda' }, components));
    panel.append(exit);
    return panel;
}

function flowConnector(label) {
    const connector = el('div', 'flow-graph-connector');
    connector.append(el('span', '', label));
    return connector;
}

function routePanel(route, components) {
    const panel = el('article', 'flow-route');
    const header = el('header', 'flow-route-header');
    const titleRow = el('div', 'flow-route-title-row');
    if (route.priority) titleRow.append(el('span', 'flow-priority-number flow-route-priority', route.priority));
    titleRow.append(el('h3', '', route.label || '配信経路'));
    header.append(titleRow);
    if (route.description) header.append(el('p', 'flow-route-description', route.description));
    panel.append(header);
    const sequence = el('div', 'flow-route-sequence');
    for (const [index, stage] of (route.sequence || []).entries()) {
        if (index > 0) sequence.append(el('span', 'flow-route-arrow', ''));
        sequence.append(routeStage(stage, components));
    }
    panel.append(sequence);
    if ((route.branches || []).length) {
        const branchWrap = el('div', 'flow-route-branch-wrap');
        branchWrap.append(el('p', 'flow-branch-label', '自宅サーバーから分岐'));
        const branches = el('div', 'flow-route-branches');
        for (const branch of route.branches) branches.append(routeStage(branch, components, true));
        branchWrap.append(branches);
        panel.append(branchWrap);
    }
    return panel;
}

function routeStage(stage, components, branch = false) {
    const section = el('details', branch ? 'flow-route-stage flow-route-branch' : 'flow-route-stage');
    const grid = el('div', 'flow-component-grid');
    const layers = new Set(stage.componentLayers || [stage.id]);
    const matches = components.filter((component) => layers.has(component.layer));
    const heading = el('summary', 'flow-stage-summary');
    const headingText = el('span', 'flow-stage-heading');
    headingText.append(el('strong', '', stage.label || stage.id));
    const regions = [...new Set(matches.map(componentRegionLabel).filter(Boolean))];
    if (regions.length) {
        const regionList = el('span', 'flow-stage-regions');
        for (const region of regions) regionList.append(el('span', 'flow-region-badge', region));
        headingText.append(regionList);
    }
    const statusSummary = el('span', 'flow-stage-statuses');
    for (const item of stageStatusSummary(matches)) {
        statusSummary.append(el('span', `flow-stage-status state-${item.state}`, `${item.label} ${number(item.count)}`));
    }
    statusSummary.append(el('span', 'flow-stage-count', `${number(matches.length)}系統`));
    heading.append(headingText, statusSummary);
    section.append(heading);
    if (stage.note) section.append(el('p', 'flow-stage-note', stage.note));
    if (!matches.length) grid.append(el('p', 'empty', '対象系統はありません。'));
    for (const component of matches) grid.append(componentCard(component));
    section.append(grid);
    return section;
}

function componentCard(component) {
    const card = el('details', `flow-component component-${component.status || 'unknown'}`);
    const displayState = componentDisplayState(component);
    const head = el('summary', 'flow-component-head');
    const identity = el('span', 'flow-component-identity');
    identity.append(el('strong', '', component.name || component.id));
    const region = componentRegionLabel(component);
    if (region) identity.append(el('span', 'flow-region-badge', region));
    head.append(identity, el('span', `flow-state state-${displayState}`, component.activityLabel || statusLabel(component.status)));
    const body = el('div', 'flow-component-body');
    body.append(el('p', 'flow-detail', component.detail || '詳細なし'));
    if (component.expectedStopped) body.append(el('p', 'expected-note', '待機系統のため停止中でも異常判定しません。'));
    if (component.standby) body.append(el('p', 'expected-note', 'オンデマンド起動の待機状態です。停止・異常ではありません。'));
    const list = el('dl');
    const rows = [
        ['最終疎通', formatDate(component.lastConnectivityAt)],
        ['最終通過', formatDate(component.lastPassedAt)],
        ['直近通過時間', component.passageMs == null ? '未記録' : `${number(component.passageMs)} ms`],
    ];
    if (component.lastTitle) rows.push(['直近配信タイトル', component.lastTitle]);
    if (component.lastDeliveryId) rows.push(['直近配信ID', component.lastDeliveryId]);
    if (component.ec2Details) rows.push(...ec2DetailRows(component.ec2Details));
    for (const [label, value] of rows) list.append(el('dt', '', label), el('dd', '', value));
    body.append(list);
    if ((component.functions || []).length) {
        const functionSection = el('section', 'resource-breakdown lambda-breakdown');
        functionSection.append(el('h5', '', 'Lambda内訳'));
        const functionList = el('ul', 'resource-list');
        for (const entry of component.functions) {
            const functionName = typeof entry === 'string' ? entry : entry.name;
            const functionRegion = typeof entry === 'string'
                ? (component.targetRegion || component.region)
                : (entry.region || component.targetRegion || component.region);
            const item = el('li', 'resource-item');
            item.append(el('code', 'resource-name', functionName || '名称未取得'));
            if (functionRegion) item.append(el('span', 'flow-region-badge resource-region-badge', resourceRegionLabel(functionRegion)));
            functionList.append(item);
        }
        functionSection.append(functionList);
        body.append(functionSection);
    }
    if ((component.queues || []).length) {
        const queueSection = el('section', 'resource-breakdown queue-breakdown');
        queueSection.append(el('h5', '', 'キュー内訳'));
        const queueList = el('ul', 'queue-list');
        for (const queue of component.queues) {
            const state = queue.activityState || 'unknown';
            const item = el('li', `queue-item queue-${state}`);
            const queueRegion = queue.region || component.targetRegion || component.region;
            const queueIdentity = el('span', 'queue-identity');
            queueIdentity.append(el('strong', '', queue.role || '用途未分類SQS'));
            if (queueRegion) queueIdentity.append(el('span', 'flow-region-badge resource-region-badge', resourceRegionLabel(queueRegion)));
            item.append(
                queueIdentity,
                el('span', `queue-state state-${state}`, queueStateLabel(queue)),
                el('code', 'queue-name', queue.name || '名称未取得'),
                el('small', '', `処理待ち ${number(queue.visible)} / 処理中 ${number(queue.inFlight)} / 遅延待機 ${number(queue.delayed)}${queue.deadLetter ? ' / DLQ' : ''}`),
            );
            queueList.append(item);
        }
        queueSection.append(queueList);
        body.append(queueSection);
    }
    card.append(body);
    return card;
}

function ec2DetailRows(details) {
    const securityGroups = (details.securityGroups || []).map((group) => group.name ? `${group.name} (${group.id || 'ID不明'})` : group.id).filter(Boolean);
    return [
        ['インスタンスID', details.instanceId || '未取得'],
        ['リージョン', details.region ? resourceRegionLabel(details.region) : (details.regionLabel || '未取得')],
        ['EC2状態', details.state || '未取得'],
        ['インスタンス/システム検査', `${healthLabel(details.instanceStatus)} / ${healthLabel(details.systemStatus)}`],
        ['AZ・タイプ', [details.availabilityZone, details.instanceType, details.architecture].filter(Boolean).join(' / ') || '未取得'],
        ['OS・AMI', [details.platformDetails, details.imageId].filter(Boolean).join(' / ') || '未取得'],
        ['ネットワーク', `Private ${details.privateIpAddress || 'なし'} / Public ${details.publicIpAddress || 'なし'}`],
        ['VPC・サブネット', [details.vpcId, details.subnetId].filter(Boolean).join(' / ') || '未取得'],
        ['セキュリティグループ', securityGroups.join('、') || '未取得'],
        ['EBS・ルート', `${(details.volumeIds || []).join('、') || '未取得'} / ${details.rootDeviceType || '種別不明'} / 最適化 ${details.ebsOptimized ? '有効' : '無効'}`],
        ['監視・仮想化', `${details.monitoringState || '未取得'} / ${details.virtualizationType || '未取得'}`],
        ['起動日時', formatDate(details.launchTime)],
        ['通常時状態・役割', `${details.normalState || '未設定'} / ${details.backupRole || '未設定'}`],
    ];
}

function healthLabel(value) { return ({ ok: '正常', impaired: '異常', insufficient_data: '確認中', initializing: '初期化中', not_applicable: '対象外', unknown: '未確認' }[value] || value || '未確認'); }

function componentDisplayState(component) {
    if (component.status === 'abnormal' || component.activityState === 'error') return 'abnormal';
    return component.activityState || component.status || 'unknown';
}

function componentRegionLabel(component) {
    if (component.regionLabel) return component.regionLabel;
    if (component.sourceRegion && component.targetRegion) return `${regionLabel(component.sourceRegion)} → ${regionLabel(component.targetRegion)}`;
    return component.region ? regionLabel(component.region) : '';
}

function regionLabel(region) {
    return ({
        'ap-northeast-1': '東京リージョン',
        'ap-northeast-3': '大阪リージョン',
        home: '自宅サーバー',
        global: '共通',
    }[region] || region || '');
}

function resourceRegionLabel(region) {
    const label = regionLabel(region);
    return label === region ? region : `${label} (${region})`;
}

function stageStatusSummary(components) {
    const counts = { abnormal: 0, stopped: 0, unknown: 0, waiting: 0, normal: 0 };
    for (const component of components) {
        const state = componentDisplayState(component);
        counts[state in counts ? state : 'unknown'] += 1;
    }
    return [
        ['abnormal', '異常'],
        ['stopped', '停止'],
        ['unknown', '未確認'],
        ['waiting', '待機中'],
        ['normal', '正常'],
    ].filter(([state]) => counts[state] > 0).map(([state, label]) => ({ state, label, count: counts[state] }));
}

function statusLabel(value) { return ({ normal: '正常', stopped: '停止', abnormal: '異常', unknown: '未確認' }[value] || '未確認'); }
function queueStateLabel(queue) { return ({ waiting: '待機中（正常）', queued: '処理待ち', processing: '処理中', delayed: '遅延待機', error: 'DLQ異常' }[queue.activityState] || '未確認'); }
function number(value) { return new Intl.NumberFormat('ja-JP').format(Number(value || 0)); }
function formatDate(value) { const date = new Date(value || ''); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'medium' }).format(date) : '未記録'; }
function setStatus(message, type) { const target = document.getElementById('global-status'); target.textContent = message; target.className = type ? `status ${type}` : 'status'; }
function el(tag, className = '', text = '') { const node = document.createElement(tag); if (className) node.className = className; if (text !== '') node.textContent = text; return node; }
