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

    const container = document.getElementById('flow-layers');
    container.replaceChildren();
    const components = flow.components || [];
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

function routePanel(route, components) {
    const panel = el('article', 'flow-route');
    panel.append(el('h3', '', route.label || '配信経路'));
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
    const statusSummary = el('span', 'flow-stage-statuses');
    for (const item of stageStatusSummary(matches)) {
        statusSummary.append(el('span', `flow-stage-status state-${item.state}`, `${item.label} ${number(item.count)}`));
    }
    statusSummary.append(el('span', 'flow-stage-count', `${number(matches.length)}系統`));
    heading.append(el('strong', '', stage.label || stage.id), statusSummary);
    section.append(heading);
    if (!matches.length) grid.append(el('p', 'empty', '対象系統はありません。'));
    for (const component of matches) grid.append(componentCard(component));
    section.append(grid);
    return section;
}

function componentCard(component) {
    const card = el('details', `flow-component component-${component.status || 'unknown'}`);
    const displayState = componentDisplayState(component);
    const head = el('summary', 'flow-component-head');
    head.append(el('strong', '', component.name || component.id), el('span', `flow-state state-${displayState}`, component.activityLabel || statusLabel(component.status)));
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
    if (component.lastTitle) rows.push(['直近タイトル', component.lastTitle]);
    if ((component.functions || []).length) rows.push(['Lambda', component.functions.join('、')]);
    for (const [label, value] of rows) list.append(el('dt', '', label), el('dd', '', value));
    body.append(list);
    if ((component.queues || []).length) {
        const queueSection = el('section', 'queue-breakdown');
        queueSection.append(el('h5', '', 'キュー内訳'));
        const queueList = el('ul', 'queue-list');
        for (const queue of component.queues) {
            const state = queue.activityState || 'unknown';
            const item = el('li', `queue-item queue-${state}`);
            item.append(
                el('strong', '', queue.name || '名称未取得'),
                el('span', `queue-state state-${state}`, queueStateLabel(queue)),
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

function componentDisplayState(component) {
    if (component.status === 'abnormal' || component.activityState === 'error') return 'abnormal';
    return component.activityState || component.status || 'unknown';
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
