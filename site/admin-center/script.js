const reuseLabels = Object.freeze({ pending: '審査中', resubmitted: '再申請', approved: '許可', rejected: '却下', changes_requested: '不備', stop_requested: '停止申請', stopped: '停止' });

document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('refresh-btn').addEventListener('click', loadSummary);
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
    document.getElementById('admin-email').textContent = data.admin;
    document.getElementById('fetched-at').textContent = `更新: ${formatDate(data.fetchedAt)}`;
    renderOverview(data.local, data.aws);
    renderLinks(data.links);
    renderSystems(data.cloudflare, data.aws);
    renderAudit(data.local);
    renderSlots(data.deliveryCatalog, data.aws?.deliveryDirectory?.byType || {});
}

function renderOverview(local, aws) {
    const pending = Number(local.reuseApplications.pending || 0) + Number(local.reuseApplications.resubmitted || 0) + Number(local.reuseApplications.stop_requested || 0);
    const sending = Number(local.campaigns.sending || 0) + Number(local.campaigns.queuing || 0);
    const items = [
        ['要対応の二次利用申請', pending, '/site/reuse-admin/'],
        ['許可済み二次利用', local.reuseApplications.approved || 0, '/site/reuse-admin/'],
        ['配信中のメール', sending, '/site/mail-admin/'],
        ['有効な購読者', local.subscribers.active || 0, '/site/mail-admin/'],
        ['有効なIP遮断', local.activeBlocks.length, '/site/ip-admin/'],
        ['AWSアラーム', aws.available ? (aws.alarms?.active || 0) : '—', null],
    ];
    const container = document.getElementById('overview-cards');
    container.replaceChildren(...items.map(([label, value, href]) => {
        const card = element(href ? 'a' : 'article', 'metric-card');
        if (href) card.href = href;
        card.append(element('span', '', label), element('strong', '', String(value)));
        return card;
    }));
}

function renderLinks(links) {
    const container = document.getElementById('quick-links');
    container.replaceChildren(...(links || []).map((link) => {
        const anchor = element('a', 'quick-link', `${link.label} →`);
        anchor.href = link.href;
        return anchor;
    }));
}

function renderSystems(cloudflare, aws) {
    const panels = [
        ['Cloudflare', [
            ['Worker', cloudflare.worker],
            ['D1', stateText(cloudflare.databaseConfigured)],
            ['Queue', stateText(cloudflare.queueConfigured)],
            ['Email', stateText(cloudflare.emailConfigured)],
            ['Access', stateText(cloudflare.accessConfigured)],
        ]],
        ['AWS', aws.available ? [
            ['Lambda', aws.lambda?.count ?? '—'],
            ['API Gateway', aws.apiGateway?.count ?? '—'],
            ['SQS待機', aws.sqs?.visibleMessages ?? '—'],
            ['DLQ待機', aws.sqs?.deadLetterMessages ?? '—'],
            ['DynamoDB', aws.dynamoDb?.count ?? '—'],
            ['配信先チャンネル', aws.deliveryDirectory?.channels ?? '—'],
            ['配信先サーバー', aws.deliveryDirectory?.servers ?? '—'],
            ['CloudWatch警報', aws.alarms?.active ?? '—'],
            ['CloudWatch Logs', aws.logGroups?.count ?? '—'],
            ['スタック異常', aws.stacks?.failed ?? '—'],
            ['バックアップEC2', aws.backupInstances?.count ?? '—'],
        ] : [['状態', aws.message || '利用できません']]],
        ['自宅サーバー', aws.available ? [
            ['正常', aws.homeServers?.healthy ?? '—'],
            ['異常/期限切れ', aws.homeServers?.unhealthy ?? '—'],
            ['最終ハートビート', formatDate(aws.homeServers?.lastHeartbeat)],
        ] : [['状態', '—']]],
    ];
    const container = document.getElementById('system-panels');
    container.replaceChildren(...panels.map(([title, rows]) => {
        const card = element('article', 'system-card');
        card.append(element('h3', '', title));
        const list = element('dl');
        for (const [key, value] of rows) list.append(element('dt', '', key), element('dd', '', String(value)));
        card.append(list);
        return card;
    }));
}

function renderAudit(local) {
    const rows = [
        ...(local.auditEvents || []).map((event) => ({ at: event.created_at, type: '管理操作', content: `${event.action} / ${event.entity_type}${event.entity_id ? ` / ${event.entity_id}` : ''}`, actor: event.actor })),
        ...(local.reuseEvents || []).map((event) => ({ at: event.created_at, type: '二次利用申請', content: `${event.event_type} / ${event.application_id}${event.message ? ` / ${event.message}` : ''}`, actor: event.actor })),
        ...(local.activeBlocks || []).map((rule) => ({ at: rule.created_at, type: 'IP遮断', content: `${rule.network}: ${rule.reason}`, actor: rule.created_by })),
    ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30);
    const body = document.getElementById('audit-rows');
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

function renderSlots(catalog, counts) {
    const container = document.getElementById('delivery-slots');
    container.replaceChildren(...(catalog || []).map((slot) => {
        const card = element('article', 'slot-card');
        card.append(
            element('strong', '', slot.label),
            element('span', `slot-status ${slot.status}`, slot.status),
            element('code', '', slot.id),
            element('small', 'slot-count', `現在の配信先: ${Number(counts[slot.id] || 0)}件`),
        );
        return card;
    }));
}

function stateText(value) { return value ? '設定済み' : '未設定'; }
function formatDate(value) { const date = new Date(value || ''); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ja-JP'); }
function setStatus(message, type) { const node = document.getElementById('global-status'); node.textContent = message; node.className = type ? `status ${type}` : 'status'; }
function element(tag, className = '', text = '') { const node = document.createElement(tag); if (className) node.className = className; if (text !== '') node.textContent = text; return node; }
