const state = { components: [], incidents: [], maintenances: [], configured: false };

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('refresh-btn').addEventListener('click', loadSummary);
    document.getElementById('incident-form').addEventListener('submit', submitIncident);
    document.getElementById('incident-reset').addEventListener('click', resetIncidentForm);
    document.getElementById('maintenance-form').addEventListener('submit', submitMaintenance);
    document.getElementById('maintenance-reset').addEventListener('click', resetMaintenanceForm);
    resetIncidentForm();
    resetMaintenanceForm();
    loadSummary();
});

async function loadSummary() {
    setStatus('Statuspageの情報を読み込み中…', 'info');
    try {
        const data = await api('/site/status-admin/api/summary');
        state.configured = data.configured === true;
        state.components = data.components || [];
        state.incidents = data.incidents || [];
        state.maintenances = data.maintenances || [];
        document.getElementById('admin-email').textContent = data.admin || '';
        document.getElementById('fetched-at').textContent = data.fetchedAt ? `更新: ${formatDate(data.fetchedAt)}` : '';
        document.getElementById('public-status-link').href = data.pageUrl || 'https://coffeebousai.statuspage.io/';
        renderConfiguration(data);
        renderComponents();
        renderComponentChecks('incident-components');
        renderComponentChecks('maintenance-components');
        renderRecords('incident-list', state.incidents, false);
        renderRecords('maintenance-list', state.maintenances, true);
        setFormsDisabled(!state.configured);
        setStatus('', '');
    } catch (error) {
        setStatus(error.message, 'error');
    }
}

function renderConfiguration(data) {
    const notice = document.getElementById('configuration-notice');
    notice.hidden = data.configured === true;
    notice.replaceChildren();
    if (!notice.hidden) notice.append(element('h2', '', 'Statuspage API連携が未設定です'), element('p', '', data.message || 'Cloudflare WorkerへAPIキーを設定してください。'));
}

function renderComponents() {
    const statuses = countBy(state.components.filter((item) => !item.group), 'status');
    const summary = document.getElementById('component-summary');
    const items = [
        ['正常稼働', statuses.operational || 0], ['パフォーマンス低下', statuses.degraded_performance || 0],
        ['部分停止', statuses.partial_outage || 0], ['重大障害', statuses.major_outage || 0], ['メンテナンス中', statuses.under_maintenance || 0],
    ];
    summary.replaceChildren(...items.map(([label, value]) => {
        const card = element('article', 'metric-card');
        card.append(element('span', '', label), element('strong', '', String(value)));
        return card;
    }));

    const groups = new Map(state.components.filter((item) => item.group).map((item) => [item.id, item.name]));
    const list = document.getElementById('component-list');
    const components = state.components.filter((item) => !item.group).sort((a, b) => (a.position - b.position) || a.name.localeCompare(b.name, 'ja'));
    list.replaceChildren(...components.map((component) => {
        const card = element('article', 'component-card');
        const heading = element('div', 'component-heading');
        heading.append(element('div', '', ''), element('span', `component-status status-${component.status}`, statusLabel(component.status)));
        heading.firstChild.append(element('strong', '', component.name), element('small', '', groups.get(component.groupId) || 'グループなし'));
        const description = element('p', '', component.description || '説明なし');
        const controls = element('div', 'component-controls');
        const select = statusSelect(component.status);
        const button = element('button', 'small', '状態を更新');
        button.type = 'button';
        button.disabled = !state.configured;
        button.addEventListener('click', () => updateComponent(component, select.value, button));
        controls.append(select, button);
        card.append(heading, description, controls, element('small', 'muted', `最終更新: ${formatDate(component.updatedAt)}`));
        return card;
    }));
    if (!components.length) list.replaceChildren(element('p', 'empty', 'コンポーネント情報はありません。'));
}

function renderComponentChecks(containerId, selected = []) {
    const selectedIds = new Set(selected);
    const container = document.getElementById(containerId);
    container.replaceChildren(...state.components.filter((item) => !item.group).map((component) => {
        const label = element('label', 'component-check');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = component.id;
        input.checked = selectedIds.has(component.id);
        label.append(input, document.createTextNode(component.name));
        return label;
    }));
    if (!container.children.length) container.append(element('span', 'muted', '選択できるコンポーネントはありません。'));
}

function renderRecords(containerId, records, isMaintenance) {
    const container = document.getElementById(containerId);
    container.replaceChildren(...records.map((record) => {
        const card = element('article', 'record-card');
        const heading = element('div', 'record-heading');
        heading.append(element('h3', '', record.name), element('span', `component-status status-${record.status}`, statusLabel(record.status)));
        const metadata = element('div', 'record-meta');
        metadata.append(element('span', '', `影響度: ${impactLabel(record.impactOverride || record.impact)}`), element('span', '', `更新: ${formatDate(record.updatedAt)}`));
        if (isMaintenance) metadata.append(element('span', '', `${formatDate(record.scheduledFor)} ～ ${formatDate(record.scheduledUntil)}`));
        const actions = element('div', 'record-actions');
        const edit = element('button', 'small', '編集');
        edit.type = 'button';
        edit.addEventListener('click', () => isMaintenance ? editMaintenance(record) : editIncident(record));
        const remove = element('button', 'small danger-button', '削除');
        remove.type = 'button';
        remove.addEventListener('click', () => deleteRecord(record, isMaintenance, remove));
        actions.append(edit, remove);
        card.append(heading, metadata, element('p', 'record-body', record.body || '本文なし'), actions);
        return card;
    }));
    if (!records.length) container.replaceChildren(element('p', 'empty', isMaintenance ? '表示できるメンテナンスはありません。' : '表示できるインシデントはありません。'));
}

async function submitIncident(event) {
    event.preventDefault();
    const id = value('incident-id');
    const payload = {
        name: value('incident-name'), status: value('incident-status'), impact: value('incident-impact'),
        body: value('incident-body'), componentStatus: value('incident-component-status'), componentIds: checkedValues('incident-components'),
        notify: document.getElementById('incident-notify').checked, confirmation: value('incident-confirmation'),
    };
    const path = id ? `/site/status-admin/api/incidents/${id}` : '/site/status-admin/api/incidents';
    try {
        await runMutation(path, id ? 'PUT' : 'POST', payload, event.submitter);
        resetIncidentForm();
        await loadSummary();
    } catch { /* runMutation displays the error */ }
}

async function submitMaintenance(event) {
    event.preventDefault();
    const id = value('maintenance-id');
    const scheduledFor = isoInput('maintenance-start', '開始日時');
    const scheduledUntil = isoInput('maintenance-end', '終了日時');
    if (!scheduledFor || !scheduledUntil) return;
    const payload = {
        name: value('maintenance-name'), status: value('maintenance-status'), body: value('maintenance-body'), impact: 'none',
        scheduledFor, scheduledUntil,
        componentStatus: value('maintenance-component-status'), componentIds: checkedValues('maintenance-components'),
        notify: checked('maintenance-notify'), remindPrior: checked('maintenance-remind'), autoStart: checked('maintenance-auto-start'),
        autoComplete: checked('maintenance-auto-complete'), autoComponentMaintenance: checked('maintenance-auto-state'),
        autoComponentOperational: checked('maintenance-auto-operational'), notifyAtStart: checked('maintenance-notify-start'),
        notifyAtEnd: checked('maintenance-notify-end'), confirmation: value('maintenance-confirmation'),
    };
    const path = id ? `/site/status-admin/api/maintenances/${id}` : '/site/status-admin/api/maintenances';
    try {
        await runMutation(path, id ? 'PUT' : 'POST', payload, event.submitter);
        resetMaintenanceForm();
        await loadSummary();
    } catch { /* runMutation displays the error */ }
}

function editIncident(record) {
    setValue('incident-id', record.id);
    setValue('incident-name', record.name);
    setValue('incident-status', record.status);
    setValue('incident-impact', record.impactOverride || 'none');
    setValue('incident-body', record.body);
    renderComponentChecks('incident-components', record.componentIds);
    setValue('incident-confirmation', '');
    document.getElementById('incident-confirm-hint').textContent = `「UPDATE:${record.id}」と入力してください。`;
    document.getElementById('incident-submit').textContent = 'インシデントを更新';
    document.getElementById('incident-form-title').scrollIntoView({ behavior: 'smooth' });
}

function editMaintenance(record) {
    setValue('maintenance-id', record.id);
    setValue('maintenance-name', record.name);
    setValue('maintenance-status', record.status);
    setValue('maintenance-body', record.body);
    setValue('maintenance-start', localDateTime(record.scheduledFor));
    setValue('maintenance-end', localDateTime(record.scheduledUntil));
    document.getElementById('maintenance-remind').checked = record.remindPrior === true;
    document.getElementById('maintenance-auto-start').checked = record.autoStart === true;
    document.getElementById('maintenance-auto-complete').checked = record.autoComplete === true;
    document.getElementById('maintenance-auto-state').checked = record.autoComponentMaintenance === true;
    document.getElementById('maintenance-auto-operational').checked = record.autoComponentOperational === true;
    document.getElementById('maintenance-notify-start').checked = record.notifyAtStart === true;
    document.getElementById('maintenance-notify-end').checked = record.notifyAtEnd === true;
    renderComponentChecks('maintenance-components', record.componentIds);
    setValue('maintenance-confirmation', '');
    document.getElementById('maintenance-confirm-hint').textContent = `「UPDATE:${record.id}」と入力してください。`;
    document.getElementById('maintenance-submit').textContent = 'メンテナンスを更新';
    document.getElementById('maintenance-form-title').scrollIntoView({ behavior: 'smooth' });
}

function resetIncidentForm() {
    document.getElementById('incident-form').reset();
    setValue('incident-id', '');
    setValue('incident-component-status', 'degraded_performance');
    document.getElementById('incident-confirm-hint').textContent = '「CREATE INCIDENT」と入力してください。';
    document.getElementById('incident-submit').textContent = 'インシデントを作成';
    renderComponentChecks('incident-components');
}

function resetMaintenanceForm() {
    document.getElementById('maintenance-form').reset();
    setValue('maintenance-id', '');
    setValue('maintenance-status', 'scheduled');
    setValue('maintenance-component-status', 'under_maintenance');
    document.getElementById('maintenance-confirm-hint').textContent = '「CREATE MAINTENANCE」と入力してください。';
    document.getElementById('maintenance-submit').textContent = 'メンテナンスを作成';
    renderComponentChecks('maintenance-components');
}

async function updateComponent(component, status, button) {
    if (!window.confirm(`${component.name} の状態を「${statusLabel(status)}」へ変更しますか？`)) return;
    try {
        await runMutation(`/site/status-admin/api/components/${component.id}`, 'PUT', { status, confirmation: `COMPONENT:${component.id}:${status}` }, button);
        await loadSummary();
    } catch { /* runMutation displays the error */ }
}

async function deleteRecord(record, isMaintenance, button) {
    const confirmation = `DELETE:${record.id}`;
    const input = window.prompt(`${record.name} を削除します。この操作は元に戻せません。\n確認のため次を入力してください:\n${confirmation}`);
    if (input === null) return;
    const kind = isMaintenance ? 'maintenances' : 'incidents';
    try {
        await runMutation(`/site/status-admin/api/${kind}/${record.id}`, 'DELETE', { confirmation: input }, button);
        await loadSummary();
    } catch { /* runMutation displays the error */ }
}

async function runMutation(path, method, payload, button) {
    const original = button?.textContent;
    if (button) { button.disabled = true; button.textContent = '処理中…'; }
    setStatus('Statuspageを更新しています…', 'info');
    try {
        const data = await api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        setStatus(data.message || '更新しました。', 'success');
        return data;
    } catch (error) {
        setStatus(error.message, 'error');
        throw error;
    } finally {
        if (button) { button.disabled = false; button.textContent = original; }
    }
}

async function api(path, options = {}) {
    const response = await fetch(path, { ...options, credentials: 'same-origin', headers: { Accept: 'application/json', ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success !== true) throw new Error(data.message || `処理に失敗しました（HTTP ${response.status}）。`);
    return data;
}

function setFormsDisabled(disabled) {
    for (const formId of ['incident-form', 'maintenance-form']) {
        for (const field of document.getElementById(formId).elements) field.disabled = disabled;
    }
}

function statusSelect(current) {
    const select = document.createElement('select');
    for (const status of ['operational', 'degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance']) {
        const option = element('option', '', statusLabel(status));
        option.value = status;
        option.selected = status === current;
        select.append(option);
    }
    return select;
}

function checkedValues(containerId) { return [...document.querySelectorAll(`#${containerId} input:checked`)].map((input) => input.value); }
function checked(id) { return document.getElementById(id).checked; }
function value(id) { return document.getElementById(id).value.trim(); }
function setValue(id, value) { document.getElementById(id).value = value || ''; }
function countBy(items, key) { return items.reduce((counts, item) => ({ ...counts, [item[key]]: (counts[item[key]] || 0) + 1 }), {}); }
function formatDate(value) { const date = new Date(value || ''); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ja-JP'); }
function localDateTime(value) { const date = new Date(value || ''); if (Number.isNaN(date.getTime())) return ''; const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000); return local.toISOString().slice(0, 16); }
function isoInput(id, label) { const date = new Date(value(id)); if (!Number.isNaN(date.getTime())) return date.toISOString(); setStatus(`${label}を入力してください。`, 'error'); return ''; }
function statusLabel(value) { return ({ operational: '正常稼働', degraded_performance: 'パフォーマンス低下', partial_outage: '部分停止', major_outage: '重大障害', under_maintenance: 'メンテナンス中', investigating: '調査中', identified: '原因特定', monitoring: '監視中', resolved: '解決済み', scheduled: '予定', in_progress: '実施中', verifying: '確認中', completed: '完了' }[value] || value || '不明'); }
function impactLabel(value) { return ({ none: '自動判定', minor: '軽微', major: '大規模', critical: '重大' }[value] || value || '—'); }
function setStatus(message, type) { const node = document.getElementById('global-status'); node.textContent = message; node.className = type ? `status ${type}` : 'status'; }
function element(tag, className = '', text = '') { const node = document.createElement(tag); if (className) node.className = className; if (text !== '') node.textContent = text; return node; }
