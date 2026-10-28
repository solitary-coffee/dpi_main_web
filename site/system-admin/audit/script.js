const PAGE_SIZE = 100;
let auditOffset = 0;
let auditTotal = 0;

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('refresh-btn')?.addEventListener('click', () => loadAudit(false));
    document.getElementById('audit-filter-form')?.addEventListener('submit', (event) => {
        event.preventDefault();
        auditOffset = 0;
        loadAudit(false);
    });
    document.getElementById('audit-reset')?.addEventListener('click', () => {
        document.getElementById('audit-filter-form')?.reset();
        auditOffset = 0;
        loadAudit(false);
    });
    document.getElementById('audit-prev')?.addEventListener('click', () => {
        auditOffset = Math.max(0, auditOffset - PAGE_SIZE);
        loadAudit(false);
    });
    document.getElementById('audit-next')?.addEventListener('click', () => {
        if (auditOffset + PAGE_SIZE < auditTotal) auditOffset += PAGE_SIZE;
        loadAudit(false);
    });
    loadAudit(false);
});

async function loadAudit() {
    setStatus('監査ログを読み込み中…', 'info');
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(auditOffset) });
    const fields = { type: 'audit-type', actor: 'audit-actor', action: 'audit-action', from: 'audit-from', to: 'audit-to', q: 'audit-query' };
    for (const [key, id] of Object.entries(fields)) {
        const value = document.getElementById(id)?.value?.trim();
        if (value) params.set(key, value);
    }
    try {
        const response = await fetch(`/site/system-admin/audit/api/logs?${params}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success !== true) throw new Error(data.message || `取得に失敗しました（HTTP ${response.status}）。`);
        auditTotal = Number(data.total || 0);
        document.getElementById('admin-email').textContent = data.admin || '';
        document.getElementById('fetched-at').textContent = `更新: ${formatDate(data.fetchedAt)}`;
        document.getElementById('audit-count').textContent = `${auditTotal}件中 ${auditTotal ? auditOffset + 1 : 0}～${Math.min(auditOffset + PAGE_SIZE, auditTotal)}件を表示`;
        renderRows(data.items || []);
        document.getElementById('audit-prev').disabled = auditOffset === 0;
        document.getElementById('audit-next').disabled = auditOffset + PAGE_SIZE >= auditTotal;
        setStatus('', '');
    } catch (error) {
        setStatus(error.message, 'error');
    }
}

function renderRows(items) {
    const body = document.getElementById('audit-rows');
    body.replaceChildren();
    if (!items.length) {
        const row = document.createElement('tr');
        const cell = element('td', 'empty', '条件に一致する監査ログはありません。');
        cell.colSpan = 6;
        row.append(cell);
        body.append(row);
        return;
    }
    for (const item of items) {
        const row = document.createElement('tr');
        const detailButton = element('button', 'small secondary-button', '詳細');
        detailButton.type = 'button';
        const detailRow = document.createElement('tr');
        detailRow.className = 'audit-detail-row';
        detailRow.hidden = true;
        const detailCell = element('td', 'alarm-detail');
        detailCell.colSpan = 6;
        const pre = element('pre', 'audit-json', JSON.stringify(item.details || {}, null, 2));
        detailCell.append(pre);
        detailRow.append(detailCell);
        detailButton.addEventListener('click', () => {
            detailRow.hidden = !detailRow.hidden;
            detailButton.textContent = detailRow.hidden ? '詳細' : '閉じる';
        });
        row.append(
            element('td', '', formatDate(item.at)),
            element('td', '', item.typeLabel || item.type || '—'),
            element('td', '', item.action || '—'),
            element('td', '', item.content || '—'),
            element('td', '', item.actor || '—'),
            element('td'),
        );
        row.lastElementChild.append(detailButton);
        body.append(row, detailRow);
    }
}

function formatDate(value) { const date = new Date(value || ''); return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('ja-JP'); }
function setStatus(message, type) { const node = document.getElementById('global-status'); node.textContent = message; node.className = type ? `status ${type}` : 'status'; }
function element(tag, className = '', text = '') { const node = document.createElement(tag); if (className) node.className = className; if (text !== '') node.textContent = text; return node; }
