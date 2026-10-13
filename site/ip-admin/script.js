'use strict';

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('rule-form').addEventListener('submit', submitRule);
    document.getElementById('reload-button').addEventListener('click', loadRules);
    loadRules();
});

async function loadRules() {
    setStatus('遮断ルールを読み込んでいます…', 'info');
    try {
        const result = await adminRequest('/site/ip-admin/api/rules');
        document.getElementById('admin-email').textContent = result.admin;
        document.getElementById('current-ip').textContent = result.currentIp || '取得できませんでした';
        document.getElementById('secret-state').textContent = result.staticRulesConfigured
            ? 'BLOCKED_IPS登録あり（内容はSecretのため非表示）'
            : 'BLOCKED_IPS登録なし';
        renderRules(result.rules);
        renderAudit(result.audit);
        setStatus('', '');
    } catch (error) {
        setStatus(error.message, 'error');
    }
}

async function submitRule(event) {
    event.preventDefault();
    const button = document.getElementById('add-button');
    const network = document.getElementById('network').value.trim();
    const reason = document.getElementById('reason').value.trim();
    button.disabled = true;
    setStatus('遮断ルールを登録しています…', 'info');

    try {
        await createRule({ network, reason });
        document.getElementById('rule-form').reset();
        await loadRules();
        setStatus('遮断ルールを登録しました。全拠点への反映には最大約30秒かかります。', 'success');
    } catch (error) {
        if (error.code === 'self_block_confirmation_required') {
            const confirmed = window.confirm(
                `このルールには、現在操作中のIPアドレスも含まれます。\n\n対象: ${network}\n\n通常ページへアクセスできなくなります。Access認証済みのこの管理画面からは解除できます。登録しますか？`,
            );
            if (confirmed) {
                try {
                    await createRule({ network, reason, confirmation: network });
                    document.getElementById('rule-form').reset();
                    await loadRules();
                    setStatus('現在の接続元を含む遮断ルールを登録しました。', 'success');
                } catch (retryError) {
                    setStatus(retryError.message, 'error');
                }
            } else {
                setStatus('登録を取り消しました。', 'info');
            }
        } else {
            setStatus(error.message, 'error');
        }
    } finally {
        button.disabled = false;
    }
}

function createRule(body) {
    return adminRequest('/site/ip-admin/api/rules', {
        method: 'POST',
        body: JSON.stringify(body),
    });
}

function renderRules(rules) {
    const container = document.getElementById('rules-list');
    container.replaceChildren();
    if (rules.length === 0) {
        container.append(element('p', 'empty', 'D1に登録された遮断ルールはありません。'));
        return;
    }

    for (const rule of rules) {
        const card = element('article', 'rule-card');
        const header = element('div', 'rule-heading');
        const title = document.createElement('div');
        title.append(element('span', 'badge active', rule.enabled ? '有効' : '無効'));
        title.append(element('h3', '', rule.network));
        const remove = element('button', 'danger-btn', '削除');
        remove.type = 'button';
        remove.addEventListener('click', () => deleteRule(rule, remove));
        header.append(title, remove);

        const reason = element('p', 'rule-reason', rule.reason);
        const meta = element(
            'p',
            'rule-meta',
            `登録: ${formatDate(rule.createdAt)} / ${rule.createdBy} / ID: ${rule.id}`,
        );
        card.append(header, reason, meta);
        container.append(card);
    }
}

async function deleteRule(rule, button) {
    const confirmed = window.confirm(
        `次の遮断ルールを削除しますか？\n\n${rule.network}\n${rule.reason}\n\n削除操作は監査履歴に残ります。`,
    );
    if (!confirmed) return;

    button.disabled = true;
    setStatus('遮断ルールを削除しています…', 'info');
    try {
        await adminRequest(`/site/ip-admin/api/rules/${rule.id}`, {
            method: 'DELETE',
            body: JSON.stringify({ confirmation: rule.id }),
        });
        await loadRules();
        setStatus('遮断ルールを削除しました。全拠点への反映には最大約30秒かかります。', 'success');
    } catch (error) {
        setStatus(error.message, 'error');
        button.disabled = false;
    }
}

function renderAudit(entries) {
    const body = document.getElementById('audit-list');
    body.replaceChildren();
    if (entries.length === 0) {
        const row = document.createElement('tr');
        const cell = element('td', 'empty', '操作履歴はまだありません。');
        cell.colSpan = 5;
        row.append(cell);
        body.append(row);
        return;
    }

    for (const entry of entries) {
        const row = document.createElement('tr');
        row.append(
            element('td', '', formatDate(entry.createdAt)),
            element('td', entry.action === 'create' ? 'action-create' : 'action-delete', entry.action === 'create' ? '追加' : '削除'),
            element('td', 'mono', entry.network),
            element('td', '', entry.actorEmail),
            element('td', 'mono', entry.rayId || '—'),
        );
        body.append(row);
    }
}

async function adminRequest(path, options = {}) {
    const response = await fetch(path, {
        credentials: 'same-origin',
        headers: {
            Accept: 'application/json',
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...options,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success !== true) {
        const error = new Error(result.message || `処理に失敗しました（HTTP ${response.status}）。`);
        error.code = result.code || 'unknown_error';
        error.status = response.status;
        throw error;
    }
    return result;
}

function setStatus(message, type) {
    const status = document.getElementById('global-status');
    status.textContent = message;
    status.className = type ? `status ${type}` : 'status';
}

function element(tagName, className = '', text = '') {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function formatDate(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime())
        ? new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'medium' }).format(date)
        : '—';
}
