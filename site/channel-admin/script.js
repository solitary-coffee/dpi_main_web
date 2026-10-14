const sourceLabels = Object.freeze({ applications: '二次利用申請', aws: 'AWS保存データ' });
const sourceStateLabels = Object.freeze({ ready: '取得済み', error: '取得エラー', not_configured: '未設定', unavailable: '利用不可' });
const visibilityLabels = Object.freeze({ public: 'サーバー参加者が閲覧可能', role_limited: '指定ロールのみ閲覧可能' });
const applicationStatusLabels = Object.freeze({ pending: '審査中', resubmitted: '再申請', approved: '許可', rejected: '却下', changes_requested: '不備・再申請待ち' });
let selectedDeliveries = [];
let directoryItems = [];
let currentItems = [];
const discordChannelCache = new Map();
const discordServerCache = new Map();

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('search-form').addEventListener('submit', (event) => {
        event.preventDefault();
        search();
    });
    document.getElementById('add-delivery').addEventListener('click', addDeliveryFromInput);
    document.getElementById('delivery-input').addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        addDeliveryFromInput();
    });
    document.getElementById('delivery-input').addEventListener('change', addDeliveryFromInput);
    document.getElementById('bulk-discord-button').addEventListener('click', loadAllDiscordMetadata);
    renderSelectedDeliveries();
});

async function search() {
    const button = document.getElementById('search-button');
    button.disabled = true;
    setStatus('保存データを検索しています…', 'info');
    try {
        addDeliveryFromInput();
        // Discordから取得した補正後の名前・種別でも検索できるよう、候補は全件受け取り、
        // キャッシュを重ねた後に画面側で検索条件と最大件数を適用する。
        const params = new URLSearchParams({ q: '', announcement: 'all', application: 'all', limit: 'all' });
        const result = await api(`/site/channel-admin/api/search?${params}`);
        directoryItems = result.items || [];
        const enrichedItems = applyCachedDiscordMetadata(directoryItems);
        currentItems = filterDirectoryItems(enrichedItems);
        document.getElementById('admin-email').textContent = result.admin;
        renderSources(result.sources);
        renderSummary(summarizeItems(currentItems));
        renderResults(currentItems);
        updateDeliveryOptions(enrichedItems);
        updateBulkDiscordButton();
        setStatus(currentItems.length ? '' : '条件に一致する配信先はありませんでした。', currentItems.length ? '' : 'info');
    } catch (error) {
        setStatus(error.message, 'error');
    } finally {
        button.disabled = false;
    }
}

function addDeliveryFromInput() {
    const input = document.getElementById('delivery-input');
    const values = input.value.split(/[,、\n]/u).map((value) => value.trim()).filter(Boolean);
    for (const value of values) {
        if (!selectedDeliveries.some((item) => item.localeCompare(value, 'ja', { sensitivity: 'accent' }) === 0)) {
            selectedDeliveries.push(value.slice(0, 100));
        }
    }
    selectedDeliveries = selectedDeliveries.slice(0, 20);
    input.value = '';
    renderSelectedDeliveries();
}

function renderSelectedDeliveries() {
    const container = document.getElementById('selected-deliveries');
    container.replaceChildren();
    if (!selectedDeliveries.length) {
        container.append(element('span', 'delivery-placeholder', '指定なし（すべての配信名）'));
        return;
    }
    selectedDeliveries.forEach((delivery, index) => {
        const chip = element('span', 'selected-delivery');
        chip.append(document.createTextNode(delivery));
        const remove = element('button', '', '×');
        remove.type = 'button';
        remove.setAttribute('aria-label', `${delivery}を削除`);
        remove.addEventListener('click', () => {
            selectedDeliveries.splice(index, 1);
            renderSelectedDeliveries();
        });
        chip.append(remove);
        container.append(chip);
    });
}

function renderSources(sources) {
    const container = document.getElementById('source-status');
    container.replaceChildren();
    for (const [key, value] of Object.entries(sources || {})) {
        const pill = element('span', `source-pill ${value.state}`);
        const detail = value.state === 'ready' ? `${value.count || 0}件` : value.message || sourceStateLabels[value.state] || value.state;
        pill.textContent = `${sourceLabels[key] || key}: ${detail}`;
        container.append(pill);
    }
}

function renderSummary(summary) {
    const container = document.getElementById('summary');
    container.replaceChildren();
    const items = [['検索結果', summary.resultCount], ['サーバー', summary.serverCount], ['チャンネル', summary.channelCount], ['申請済み', summary.applicationCount]];
    for (const [label, value] of items) {
        const card = element('article', 'summary-card');
        card.append(element('span', '', label), element('strong', '', String(value || 0)));
        container.append(card);
    }
}

function renderResults(items) {
    const container = document.getElementById('results');
    container.replaceChildren();
    if (!items.length) {
        const empty = element('div', 'empty-state');
        empty.append(element('h2', '', '該当する配信先はありません'), element('p', '', '検索語や配信名を変更して再度検索してください。'));
        return container.append(empty);
    }

    for (const group of groupItemsByServerName(items)) {
        const server = element('section', 'server-group');
        const serverHead = element('div', 'server-group-head');
        const serverTitle = document.createElement('div');
        serverTitle.append(element('h2', '', group.serverName));
        const serverIds = [...new Set(group.items.map((item) => item.serverId).filter(Boolean))];
        serverTitle.append(element('p', '', `${serverIds.length === 1 ? 'Server ID' : 'Server IDs'}: ${serverIds.length ? serverIds.join(' / ') : '未取得'}`));
        serverHead.append(serverTitle, element('span', 'channel-count', `${group.items.length}チャンネル`));
        server.append(serverHead);

        const channels = element('div', 'server-channels');
        for (const item of group.items) channels.append(renderChannelCard(item));
        server.append(channels);
        container.append(server);
    }
}

function renderChannelCard(item) {
    const card = element('article', 'result-card channel-card');
    const head = element('div', 'result-head');
    const title = document.createElement('div');
    title.append(element('h3', '', `#${item.channelName || 'チャンネル名未取得'}`));
    title.append(element('p', '', `Channel ID: ${item.channelId || '未取得'}`));
    const badges = element('div', 'badges');
    const channelBadge = item.announcement === true
        ? element('span', 'badge announcement', 'アナウンス')
        : item.announcement === false
            ? element('span', 'badge', 'テキストチャンネル')
            : element('span', 'badge', '種別未取得');
    channelBadge.dataset.field = 'channel-badge';
    badges.append(channelBadge);
    if (item.application) {
        const status = applicationStatusLabels[item.application.status] || item.application.status || '状態未取得';
        badges.append(element('span', 'badge application', `申請済み・${status}`));
    } else if (item.applicationChecked) {
        badges.append(element('span', 'badge not-applied', '未申請'));
    } else {
        badges.append(element('span', 'badge application-unknown', '申請状況未取得'));
    }
    for (const source of item.sources || []) badges.append(element('span', 'badge source', source === 'aws' ? 'AWS' : '申請'));
    if (item.serverId && item.channelId) {
        const refresh = element('button', 'discord-refresh', 'Discord情報を取得');
        refresh.type = 'button';
        refresh.addEventListener('click', () => loadDiscordMetadata(item, card, refresh));
        badges.append(refresh);
    }
    head.append(title, badges);
    card.append(head);

    const list = element('dl', 'result-grid');
    appendField(list, 'ユーザー数', item.memberCount == null ? '未取得' : `${Number(item.memberCount).toLocaleString('ja-JP')}人`, 'member-count');
    appendField(list, '閲覧範囲・権限', item.permissionSummary || visibilityLabels[item.visibility] || '未取得', 'permission-summary');
    appendField(list, 'チャンネル種別', channelTypeLabel(item), 'channel-type');
    appendField(list, '最終更新', item.updatedAt ? formatDate(item.updatedAt) : '未取得');
    if (item.application) appendField(list, '申請番号', `${item.application.reference}（${applicationStatusLabels[item.application.status] || item.application.status}）`);
    if (item.serverPublic) appendField(list, 'サーバー公開範囲', item.serverPublic === 'public' ? '公開' : '非公開・招待制');
    card.append(list);

    const deliveries = element('div', 'delivery-list');
    if ((item.deliveryTypes || []).length) {
        for (const delivery of item.deliveryTypes) deliveries.append(element('span', 'delivery-chip', delivery));
    } else {
        deliveries.append(element('span', 'delivery-chip', '配信名未取得'));
    }
    card.append(deliveries);
    return card;
}

function groupItemsByServerName(items) {
    const groups = new Map();
    for (const item of items) {
        const serverName = String(item.serverName || '').trim() || 'サーバー名未取得';
        const serverId = String(item.serverId || '').trim();
        const key = serverId
            ? `id:${serverId}`
            : `name:${serverName.normalize('NFKC').toLocaleLowerCase('ja')}`;
        const group = groups.get(key) || { serverName, items: [] };
        group.items.push(item);
        groups.set(key, group);
    }
    return [...groups.values()];
}

function appendField(list, label, value, key = '') {
    const wrapper = element('div', 'result-field');
    const content = element('dd', '', value);
    if (key) content.dataset.field = key;
    wrapper.append(element('dt', '', label), content);
    list.append(wrapper);
}

async function loadDiscordMetadata(item, card, button) {
    button.disabled = true;
    button.textContent = '取得中…';
    try {
        const params = new URLSearchParams({ guild_id: item.serverId, channel_id: item.channelId });
        const result = await api(`/site/channel-admin/api/discord?${params}`);
        const metadata = result.metadata;
        cacheDiscordChannelMetadata(metadata);
        Object.assign(item, metadata);
        card.querySelector('[data-field="member-count"]').textContent = metadata.memberCount == null ? '未取得' : `${Number(metadata.memberCount).toLocaleString('ja-JP')}人${metadata.onlineCount == null ? '' : `（オンライン約${Number(metadata.onlineCount).toLocaleString('ja-JP')}人）`}`;
        card.querySelector('[data-field="permission-summary"]').textContent = metadata.permissionSummary;
        card.querySelector('[data-field="channel-type"]').textContent = channelTypeLabel(metadata);
        const channelBadge = card.querySelector('[data-field="channel-badge"]');
        channelBadge.textContent = metadata.announcement ? 'アナウンス' : 'テキストチャンネル';
        channelBadge.className = metadata.announcement ? 'badge announcement' : 'badge';
        const existing = card.querySelector('.permission-details');
        if (existing) existing.remove();
        const details = element('div', 'permission-details');
        const lines = (metadata.permissionOverwrites || []).map((overwrite) => {
            const allow = overwrite.allow.length ? overwrite.allow.join('、') : 'なし';
            const deny = overwrite.deny.length ? overwrite.deny.join('、') : 'なし';
            return `${overwrite.targetType === 'member' ? 'メンバー' : 'ロール'} ${overwrite.id}\n許可: ${allow}\n拒否: ${deny}`;
        });
        details.append(element('strong', '', `Discord取得結果（${formatDate(metadata.fetchedAt)}）`), document.createTextNode(lines.length ? `\n${lines.join('\n\n')}` : '\n権限上書きはありません。'));
        card.append(details);
        button.textContent = '再取得';
    } catch (error) {
        button.textContent = '取得失敗・再試行';
        setStatus(error.message, 'error');
    } finally {
        button.disabled = false;
    }
}

function updateBulkDiscordButton() {
    const button = document.getElementById('bulk-discord-button');
    const serverCount = new Set(currentItems.map((item) => item.serverId).filter(Boolean)).size;
    button.disabled = serverCount === 0;
    document.getElementById('bulk-discord-progress').textContent = serverCount
        ? `${serverCount}サーバーが取得対象です。`
        : '取得可能なServer IDがありません。';
}

async function loadAllDiscordMetadata() {
    const button = document.getElementById('bulk-discord-button');
    const progress = document.getElementById('bulk-discord-progress');
    const serverIds = [...new Set(currentItems.map((item) => item.serverId).filter(Boolean))];
    if (!serverIds.length) return;

    button.disabled = true;
    let succeeded = 0;
    const failures = [];
    for (let index = 0; index < serverIds.length; index += 1) {
        const serverId = serverIds[index];
        progress.textContent = `${index + 1}/${serverIds.length}サーバーを取得しています…`;
        try {
            const params = new URLSearchParams({ guild_id: serverId });
            const result = await api(`/site/channel-admin/api/discord/guild?${params}`);
            cacheDiscordGuildMetadata(result.server, result.channels || []);
            succeeded += 1;
        } catch (error) {
            failures.push(`${serverId}: ${error.message}`);
        }
        if (index < serverIds.length - 1) await delay(250);
    }

    const enrichedItems = applyCachedDiscordMetadata(directoryItems);
    currentItems = filterDirectoryItems(enrichedItems);
    renderSummary(summarizeItems(currentItems));
    renderResults(currentItems);
    updateDeliveryOptions(enrichedItems);
    updateBulkDiscordButton();
    progress.textContent = failures.length
        ? `${succeeded}/${serverIds.length}サーバーを更新しました（${failures.length}件は取得できなかったためスキップ）。`
        : `${succeeded}サーバーの情報を更新しました。`;
    setStatus(
        failures.length
            ? `取得できないサーバーをスキップして処理を完了しました。最初の失敗: ${failures[0]}`
            : 'Discordからサーバー・チャンネル情報を一括取得し、検索データへ反映しました。',
        failures.length ? 'error' : 'info',
    );
}

function cacheDiscordGuildMetadata(server, channels) {
    if (server?.serverId) discordServerCache.set(server.serverId, server);
    for (const channel of channels) cacheDiscordChannelMetadata(channel);
}

function cacheDiscordChannelMetadata(metadata) {
    if (!metadata?.serverId || !metadata?.channelId) return;
    discordChannelCache.set(`${metadata.serverId}|${metadata.channelId}`, metadata);
    if (!discordServerCache.has(metadata.serverId)) {
        discordServerCache.set(metadata.serverId, {
            serverId: metadata.serverId,
            serverName: metadata.serverName,
            memberCount: metadata.memberCount,
            onlineCount: metadata.onlineCount,
        });
    }
}

function applyCachedDiscordMetadata(items) {
    return items.map((item) => {
        const server = discordServerCache.get(item.serverId) || {};
        const channel = discordChannelCache.get(`${item.serverId}|${item.channelId}`) || {};
        return {
            ...item,
            serverName: server.serverName || item.serverName,
            memberCount: server.memberCount ?? item.memberCount,
            onlineCount: server.onlineCount ?? item.onlineCount,
            channelName: channel.channelName || item.channelName,
            channelType: channel.channelType ?? item.channelType,
            announcement: channel.announcement ?? item.announcement,
            permissionSummary: channel.permissionSummary || item.permissionSummary,
            permissionOverwrites: channel.permissionOverwrites || item.permissionOverwrites,
            discordFetchedAt: channel.fetchedAt || item.discordFetchedAt,
        };
    });
}

function filterDirectoryItems(items) {
    const query = normalized(document.getElementById('query').value);
    const announcement = document.getElementById('announcement').value;
    const application = document.getElementById('application').value;
    const limitValue = document.getElementById('limit').value;
    const limit = limitValue === 'all' ? null : Number(limitValue);
    const filtered = items.filter((item) => {
        if (selectedDeliveries.length && !selectedDeliveries.some((filter) =>
            (item.deliveryTypes || []).some((value) => normalized(value).includes(normalized(filter))))) return false;
        if (announcement === 'yes' && item.announcement !== true) return false;
        if (announcement === 'no' && item.announcement !== false) return false;
        if (application === 'yes' && !item.application) return false;
        if (application === 'no' && (!item.applicationChecked || item.application)) return false;
        if (!query) return true;
        const haystack = [item.serverName, item.serverId, item.channelName, item.channelId, ...(item.deliveryTypes || [])]
            .map(normalized).join('\n');
        return haystack.includes(query);
    });
    return limit == null || !Number.isFinite(limit) ? filtered : filtered.slice(0, limit);
}

function summarizeItems(items) {
    return {
        resultCount: items.length,
        serverCount: new Set(items.map((item) => item.serverId).filter(Boolean)).size,
        channelCount: new Set(items.map((item) => item.channelId).filter(Boolean)).size,
        applicationCount: items.filter((item) => item.application).length,
    };
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function channelTypeLabel(item) {
    if (item.announcement === true || item.channelType === 5) return 'アナウンスチャンネル';
    if (item.channelType === 0) return 'テキストチャンネル';
    return item.channelType == null ? '未取得' : `Discord種別 ${item.channelType}`;
}

function normalized(value) {
    return String(value ?? '').trim().normalize('NFKC').toLocaleLowerCase('ja');
}

function updateDeliveryOptions(items) {
    const list = document.getElementById('delivery-options');
    const values = [...new Set([...selectedDeliveries, ...items.flatMap((item) => item.deliveryTypes || [])])]
        .sort((a, b) => a.localeCompare(b, 'ja'));
    list.replaceChildren(...values.map((value) => {
        const option = document.createElement('option');
        option.value = value;
        return option;
    }));
}

async function api(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.success === false) throw new Error(body.message || '通信に失敗しました。');
    return body;
}

function setStatus(message, type) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = `status ${type}`;
}

function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('ja-JP', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== '') node.textContent = text;
    return node;
}
