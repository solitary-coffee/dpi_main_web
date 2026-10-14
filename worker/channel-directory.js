import { authenticateNewsletterAdmin, AccessAuthError } from './access.js';

const JSON_HEADERS = Object.freeze({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
});
const MAX_LOCAL_ROWS = 1_000;
const MAX_RESULTS = 200;

class DirectoryError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'DirectoryError';
        this.status = status;
        this.code = code;
        this.publicMessage = message;
    }
}

export async function handleChannelDirectoryRequest(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (!pathname.startsWith('/site/channel-admin/api')) return null;

    try {
        const admin = await authenticateNewsletterAdmin(request, env);
        if (pathname !== '/site/channel-admin/api/search') {
            if (pathname === '/site/channel-admin/api/discord') {
                if (request.method !== 'GET') {
                    return jsonResponse({ success: false, code: 'method_not_allowed', message: '許可されていない操作です。' }, 405, { Allow: 'GET' });
                }
                return await fetchDiscordMetadata(url, env, admin);
            }
            throw new DirectoryError(404, 'not_found', '指定された管理APIはありません。');
        }
        if (request.method !== 'GET') {
            return jsonResponse({ success: false, code: 'method_not_allowed', message: '許可されていない操作です。' }, 405, { Allow: 'GET' });
        }
        return await searchDirectory(url, env, admin);
    } catch (error) {
        if (error instanceof DirectoryError || error instanceof AccessAuthError) {
            return jsonResponse({ success: false, code: error.code, message: error.publicMessage }, error.status);
        }
        console.error('Channel directory request failed', { name: error?.name, message: error?.message });
        return jsonResponse({ success: false, code: 'internal_error', message: '検索処理中にエラーが発生しました。' }, 500);
    }
}

async function fetchDiscordMetadata(url, env, admin) {
    const guildId = discordId(url.searchParams.get('guild_id'));
    const channelId = discordId(url.searchParams.get('channel_id'));
    const token = cleanString(env.DISCORD_BOT_TOKEN);
    if (!guildId || !channelId) throw new DirectoryError(400, 'invalid_discord_id', 'サーバーIDとチャンネルIDを確認してください。');
    if (!token) throw new DirectoryError(503, 'discord_not_configured', 'Discord情報取得の設定が完了していません。');

    const headers = { Accept: 'application/json', Authorization: `Bot ${token}`, 'User-Agent': 'DPI-Bot-Channel-Directory/1.0' };
    const [guildResponse, channelResponse] = await Promise.all([
        fetch(`https://discord.com/api/v10/guilds/${guildId}?with_counts=true`, { headers }),
        fetch(`https://discord.com/api/v10/channels/${channelId}`, { headers }),
    ]);
    if (!guildResponse.ok || !channelResponse.ok) {
        const status = guildResponse.status === 429 || channelResponse.status === 429 ? 429 : 502;
        const message = status === 429 ? 'Discord APIの取得上限に達しました。しばらく待って再試行してください。' : 'Discordからサーバー・チャンネル情報を取得できませんでした。';
        throw new DirectoryError(status, 'discord_fetch_failed', message);
    }

    const [guild, channel] = await Promise.all([guildResponse.json(), channelResponse.json()]);
    if (cleanString(guild.id) !== guildId || cleanString(channel.guild_id) !== guildId || cleanString(channel.id) !== channelId) {
        throw new DirectoryError(409, 'discord_resource_mismatch', '取得したDiscord情報が検索対象と一致しません。');
    }
    const permissionOverwrites = normalizePermissionOverwrites(channel.permission_overwrites);
    console.log('Discord channel metadata read', { guildId, channelId, admin: admin.email, overwriteCount: permissionOverwrites.length });
    return jsonResponse({
        success: true,
        metadata: {
            serverId: guildId,
            serverName: cleanString(guild.name).slice(0, 100),
            channelId,
            channelName: cleanString(channel.name).slice(0, 100),
            channelType: finiteNumber(channel.type),
            announcement: Number(channel.type) === 5,
            memberCount: finiteNumber(guild.approximate_member_count ?? guild.member_count),
            onlineCount: finiteNumber(guild.approximate_presence_count),
            permissionSummary: permissionOverwrites.length ? `権限上書き ${permissionOverwrites.length}件` : '権限上書きなし',
            permissionOverwrites,
            fetchedAt: new Date().toISOString(),
        },
    });
}

function normalizePermissionOverwrites(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 100).map((overwrite) => ({
        id: discordId(overwrite?.id) || '',
        targetType: Number(overwrite?.type) === 1 ? 'member' : 'role',
        allow: permissionNames(overwrite?.allow),
        deny: permissionNames(overwrite?.deny),
    })).filter((overwrite) => overwrite.id);
}

function permissionNames(value) {
    let bits;
    try {
        bits = BigInt(cleanString(value) || '0');
    } catch {
        return [];
    }
    const known = [
        [10n, 'チャンネルを見る'], [11n, 'メッセージを送信'], [13n, 'メッセージを管理'],
        [14n, '埋め込みリンク'], [15n, 'ファイルを添付'], [17n, '@everyone等をメンション'],
        [29n, 'Webhookを管理'], [35n, '公開スレッドを作成'], [36n, '非公開スレッドを作成'],
        [37n, '外部スタンプを使用'], [38n, 'スレッドへ送信'], [46n, 'ボイスメッセージを送信'],
        [49n, '投票を作成'],
    ];
    return known.filter(([bit]) => (bits & (1n << bit)) !== 0n).map(([, label]) => label);
}

function discordId(value) {
    const text = cleanString(value);
    return /^\d{17,20}$/u.test(text) ? text : '';
}

async function searchDirectory(url, env, admin) {
    const filters = parseFilters(url.searchParams);
    const [localResult, awsResult] = await Promise.all([
        searchLocalApplications(env, filters),
        searchAwsDirectory(env, filters),
    ]);
    const items = mergeDirectoryItems([...localResult.items, ...awsResult.items])
        .filter((item) => matchesFilters(item, filters))
        .slice(0, filters.limit);

    return jsonResponse({
        success: true,
        admin: admin.email,
        filters,
        items,
        summary: {
            resultCount: items.length,
            serverCount: new Set(items.map((item) => item.serverId).filter(Boolean)).size,
            channelCount: new Set(items.map((item) => item.channelId).filter(Boolean)).size,
        },
        sources: {
            applications: localResult.status,
            aws: awsResult.status,
        },
    });
}

function parseFilters(params) {
    const q = cleanString(params.get('q')).slice(0, 120);
    const delivery = cleanString(params.get('delivery')).slice(0, 100);
    const announcement = ['yes', 'no'].includes(params.get('announcement')) ? params.get('announcement') : 'all';
    const requestedLimit = Number(params.get('limit') || 50);
    const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), MAX_RESULTS) : 50;
    return { q, delivery, announcement, limit };
}

async function searchLocalApplications(env, filters) {
    const database = env.REUSE_DB || env.NEWSLETTER_DB;
    if (!database) return { status: { state: 'unavailable', message: '申請データベースが未設定です。' }, items: [] };

    try {
        const result = await database.prepare(
            `SELECT id, reference, status, guild_id, guild_name, channel_id, channel_name,
                    channel_type, delivery_types, channel_mappings, server_public,
                    channel_visibility, updated_at
             FROM reuse_applications
             ORDER BY updated_at DESC
             LIMIT ?`,
        ).bind(MAX_LOCAL_ROWS).all();
        const items = (result.results || []).flatMap(applicationDirectoryItems)
            .filter((item) => matchesFilters(item, filters));
        return { status: { state: 'ready', count: items.length }, items };
    } catch (error) {
        console.error('Local channel directory search failed', { name: error?.name, message: error?.message });
        return { status: { state: 'error', message: '申請データを取得できませんでした。' }, items: [] };
    }
}

function applicationDirectoryItems(row) {
    const mappings = parseJsonArray(row.channel_mappings);
    const fallback = {
        channelId: cleanString(row.channel_id),
        channelName: cleanString(row.channel_name),
        channelType: Number(row.channel_type),
        deliveryTypes: parseJsonArray(row.delivery_types).map(cleanString).filter(Boolean),
    };
    const normalizedMappings = mappings.length ? mappings : [fallback];

    return normalizedMappings.map((mapping) => ({
        serverId: cleanString(row.guild_id),
        serverName: cleanString(row.guild_name),
        channelId: cleanString(mapping.channelId || mapping.channel_id || fallback.channelId),
        channelName: cleanString(mapping.channelName || mapping.channel_name || fallback.channelName),
        channelType: finiteNumber(mapping.channelType ?? mapping.channel_type ?? fallback.channelType),
        announcement: typeof mapping.announcement === 'boolean'
            ? mapping.announcement
            : finiteNumber(mapping.channelType ?? fallback.channelType) === 5,
        deliveryTypes: stringArray(mapping.deliveryTypes || mapping.delivery_types || fallback.deliveryTypes),
        permissions: null,
        permissionSummary: visibilityLabel(row.channel_visibility),
        visibility: cleanString(row.channel_visibility) || null,
        memberCount: null,
        serverPublic: cleanString(row.server_public) || null,
        updatedAt: cleanString(row.updated_at) || null,
        application: {
            id: cleanString(row.id),
            reference: cleanString(row.reference),
            status: cleanString(row.status),
        },
        sources: ['application'],
    })).filter((item) => item.channelId || item.channelName);
}

async function searchAwsDirectory(env, filters) {
    const endpoint = cleanString(env.AWS_CHANNEL_DIRECTORY_URL);
    const token = cleanString(env.AWS_CHANNEL_DIRECTORY_TOKEN);
    if (!endpoint || !token) {
        return { status: { state: 'not_configured', message: 'AWS検索APIは未設定です。' }, items: [] };
    }

    let target;
    try {
        target = new URL(endpoint);
    } catch {
        return { status: { state: 'error', message: 'AWS検索APIのURL設定が不正です。' }, items: [] };
    }
    if (target.protocol !== 'https:' || target.username || target.password) {
        return { status: { state: 'error', message: 'AWS検索APIはHTTPS URLで設定してください。' }, items: [] };
    }
    target.searchParams.set('q', filters.q);
    target.searchParams.set('delivery', filters.delivery);
    target.searchParams.set('announcement', filters.announcement);
    target.searchParams.set('limit', String(filters.limit));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
        const response = await fetch(target, {
            method: 'GET',
            headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`aws_directory_http_${response.status}`);
        const body = await response.json();
        const items = Array.isArray(body?.items) ? body.items.map(normalizeExternalItem).filter(Boolean) : [];
        return { status: { state: 'ready', count: items.length }, items };
    } catch (error) {
        console.error('AWS channel directory search failed', { name: error?.name, message: error?.message });
        return { status: { state: 'error', message: 'AWS保存データを取得できませんでした。' }, items: [] };
    } finally {
        clearTimeout(timeout);
    }
}

function normalizeExternalItem(value) {
    if (!value || typeof value !== 'object') return null;
    const channelId = cleanString(value.channelId);
    const channelName = cleanString(value.channelName);
    if (!channelId && !channelName) return null;
    return {
        serverId: cleanString(value.serverId),
        serverName: cleanString(value.serverName),
        channelId,
        channelName,
        channelType: finiteNumber(value.channelType),
        announcement: typeof value.announcement === 'boolean' ? value.announcement : null,
        deliveryTypes: stringArray(value.deliveryTypes),
        permissions: plainObject(value.permissions),
        permissionSummary: cleanString(value.permissionSummary) || null,
        visibility: cleanString(value.visibility) || null,
        memberCount: finiteNumber(value.memberCount),
        serverPublic: null,
        updatedAt: cleanString(value.updatedAt) || null,
        application: null,
        sources: ['aws'],
    };
}

function mergeDirectoryItems(items) {
    const merged = new Map();
    for (const item of items) {
        const key = `${item.serverId || item.serverName}|${item.channelId || item.channelName}`.toLowerCase();
        const current = merged.get(key);
        if (!current) {
            merged.set(key, item);
            continue;
        }
        merged.set(key, {
            ...current,
            serverName: current.serverName || item.serverName,
            channelName: current.channelName || item.channelName,
            channelType: current.channelType ?? item.channelType,
            announcement: current.announcement ?? item.announcement,
            deliveryTypes: [...new Set([...current.deliveryTypes, ...item.deliveryTypes])],
            permissions: current.permissions || item.permissions,
            permissionSummary: current.permissionSummary || item.permissionSummary,
            visibility: current.visibility || item.visibility,
            memberCount: current.memberCount ?? item.memberCount,
            updatedAt: newestDate(current.updatedAt, item.updatedAt),
            application: current.application || item.application,
            sources: [...new Set([...current.sources, ...item.sources])],
        });
    }
    return [...merged.values()].sort((a, b) => `${a.serverName}\0${a.channelName}`.localeCompare(`${b.serverName}\0${b.channelName}`, 'ja'));
}

function matchesFilters(item, filters) {
    if (filters.delivery && !item.deliveryTypes.some((value) => normalized(value).includes(normalized(filters.delivery)))) return false;
    if (filters.announcement === 'yes' && item.announcement !== true) return false;
    if (filters.announcement === 'no' && item.announcement !== false) return false;
    if (!filters.q) return true;
    const haystack = [item.serverName, item.serverId, item.channelName, item.channelId, ...item.deliveryTypes]
        .map(normalized).join('\n');
    return haystack.includes(normalized(filters.q));
}

function visibilityLabel(value) {
    return { public: 'サーバー参加者が閲覧可能', role_limited: '指定ロールのみ閲覧可能' }[value] || null;
}

function newestDate(left, right) {
    if (!left) return right || null;
    if (!right) return left;
    return Date.parse(left) >= Date.parse(right) ? left : right;
}

function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function stringArray(value) {
    return Array.isArray(value) ? value.map(cleanString).filter(Boolean).slice(0, 100) : [];
}

function plainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [cleanString(key), cleanString(item)]));
}

function parseJsonArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string' || !value) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function normalized(value) {
    return cleanString(value).normalize('NFKC').toLocaleLowerCase('ja');
}

function cleanString(value) {
    return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function jsonResponse(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

export const __test = Object.freeze({
    applicationDirectoryItems,
    matchesFilters,
    mergeDirectoryItems,
    normalizeExternalItem,
    normalizePermissionOverwrites,
    parseFilters,
    permissionNames,
    searchDirectory,
});
