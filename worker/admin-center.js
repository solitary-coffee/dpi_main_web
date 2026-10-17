import { AccessAuthError, authenticateNewsletterAdmin } from './access.js';
import { DELIVERY_CATALOG } from './delivery-catalog.js';

const JSON_HEADERS = Object.freeze({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
});

const ADMIN_ASSET_ROOTS = Object.freeze([
    '/site/admin-center',
    '/site/system-admin',
    '/site/ec2-admin',
    '/site/xml-admin',
]);

class AdminCenterError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.publicMessage = message;
        this.code = code;
    }
}

export async function handleAdminCenterRequest(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const isSummaryApi = pathname === '/site/admin-center/api/summary';
    const isActionApi = pathname === '/site/admin-center/api/action';
    const isApi = isSummaryApi || isActionApi;
    const assetRoot = !isApi ? ADMIN_ASSET_ROOTS.find((root) => pathname === root || pathname.startsWith(`${root}/`)) : null;
    const isAsset = Boolean(assetRoot);
    if (!isApi && !isAsset) return null;

    try {
        const admin = await authenticateNewsletterAdmin(request, env);
        if (isSummaryApi) {
            if (request.method !== 'GET') {
                return jsonResponse({ success: false, message: '許可されていない操作です。' }, 405, { Allow: 'GET' });
            }
            return await systemSummary(env, admin);
        }
        if (isActionApi) {
            if (request.method !== 'POST') {
                return jsonResponse({ success: false, message: '許可されていない操作です。' }, 405, { Allow: 'POST' });
            }
            return await proxyAwsAction(request, env, admin);
        }
        if (!['GET', 'HEAD'].includes(request.method)) {
            throw new AdminCenterError(405, '許可されていない操作です。', 'method_not_allowed');
        }
        // Use the original URL here. `pathname` above has trailing slashes removed
        // for route matching, so checking it would also redirect the already
        // canonical `/site/admin-center/` URL back to itself forever.
        if (assetRoot && url.pathname === assetRoot) {
            url.pathname = `${assetRoot}/`;
            return new Response(null, { status: 308, headers: { Location: url.toString(), 'Cache-Control': 'no-store' } });
        }
        const asset = await env.ASSETS.fetch(request);
        const headers = new Headers(asset.headers);
        headers.set('Cache-Control', 'no-store');
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Referrer-Policy', 'no-referrer');
        if ((headers.get('content-type') || '').includes('text/html')) {
            headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
        }
        return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
    } catch (error) {
        const status = Number(error?.status) || 500;
        const message = error instanceof AccessAuthError || error instanceof AdminCenterError
            ? error.publicMessage
            : '統合管理情報を取得できませんでした。';
        if (!(error instanceof AccessAuthError) && !(error instanceof AdminCenterError)) {
            console.error('Admin center request failed', { errorName: error?.name || 'Error' });
        }
        return jsonResponse({ success: false, message, code: error?.code || 'internal_error' }, status);
    }
}

async function systemSummary(env, admin) {
    const database = env.NEWSLETTER_DB || env.REUSE_DB || env.IP_BLOCK_DB;
    if (!database) throw new AdminCenterError(503, '管理データベースが設定されていません。', 'database_not_configured');

    const [reuse, campaigns, subscribers, blocks, audit, reuseEvents, approvedReuse, aws] = await Promise.all([
        groupedCounts(database, 'SELECT status, COUNT(*) AS count FROM reuse_applications GROUP BY status'),
        groupedCounts(database, 'SELECT status, COUNT(*) AS count FROM newsletter_campaigns GROUP BY status'),
        groupedCounts(database, 'SELECT status, COUNT(*) AS count FROM newsletter_subscribers GROUP BY status'),
        queryRows(database, `SELECT id, network, reason, created_by, created_at, updated_by, updated_at
            FROM ip_block_rules WHERE enabled = 1 ORDER BY created_at DESC LIMIT 20`),
        queryRows(database, `SELECT id, actor, action, entity_type, entity_id, created_at
            FROM admin_audit_events ORDER BY created_at DESC LIMIT 30`),
        queryRows(database, `SELECT id, application_id, event_type, actor, message, created_at
            FROM reuse_application_events ORDER BY created_at DESC LIMIT 30`),
        queryRows(database, `SELECT id, delivery_types, channel_mappings
            FROM reuse_applications WHERE status = 'approved'`),
        fetchAwsSummary(env),
    ]);

    return jsonResponse({
        success: true,
        admin: admin.email,
        fetchedAt: new Date().toISOString(),
        cloudflare: {
            worker: 'main-dpi',
            databaseConfigured: Boolean(database),
            queueConfigured: Boolean(env.NEWSLETTER_QUEUE),
            emailConfigured: Boolean(env.NOTICE_EMAIL),
            accessConfigured: Boolean(clean(env.ACCESS_AUD) && clean(env.ACCESS_TEAM_DOMAIN)),
        },
        local: {
            reuseApplications: reuse,
            campaigns,
            subscribers,
            activeBlocks: blocks,
            auditEvents: audit,
            reuseEvents,
            deliverySlotCounts: countApprovedDeliverySlots(approvedReuse),
        },
        aws,
        deliveryCatalog: DELIVERY_CATALOG,
        links: [
            { label: 'システム運用', href: '/site/system-admin/' },
            { label: 'EC2管理', href: '/site/ec2-admin/' },
            { label: 'XML配信', href: '/site/xml-admin/' },
            { label: '二次利用申請管理', href: '/site/reuse-admin/' },
            { label: 'お知らせ一括配信', href: '/site/mail-admin/' },
            { label: '配信先検索', href: '/site/channel-admin/' },
            { label: 'IP遮断管理', href: '/site/ip-admin/' },
        ],
    });
}

async function proxyAwsAction(request, env, admin) {
    const requestUrl = new URL(request.url);
    const origin = clean(request.headers.get('origin'));
    const fetchSite = clean(request.headers.get('sec-fetch-site'));
    if ((origin && origin !== requestUrl.origin) || fetchSite === 'cross-site') {
        throw new AdminCenterError(403, '別サイトからの管理操作は許可されていません。', 'invalid_origin');
    }
    const contentType = clean(request.headers.get('content-type')).toLowerCase();
    if (!contentType.startsWith('application/json')) {
        throw new AdminCenterError(415, 'JSON形式で送信してください。', 'invalid_content_type');
    }
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > 1_600_000) throw new AdminCenterError(413, '送信データが大きすぎます。', 'payload_too_large');
    const bodyText = await request.text();
    if (new TextEncoder().encode(bodyText).byteLength > 1_600_000) {
        throw new AdminCenterError(413, '送信データが大きすぎます。', 'payload_too_large');
    }
    let payload;
    try {
        payload = JSON.parse(bodyText);
    } catch {
        throw new AdminCenterError(400, 'JSON形式を確認してください。', 'invalid_json');
    }
    const allowedActions = new Set(['ec2', 'system-mode', 'xml-preview', 'xml-dispatch']);
    if (!payload || typeof payload !== 'object' || !allowedActions.has(clean(payload.action))) {
        throw new AdminCenterError(400, '管理操作を選択してください。', 'invalid_action');
    }

    const endpoint = clean(env.AWS_CHANNEL_DIRECTORY_URL);
    const token = clean(env.AWS_CHANNEL_DIRECTORY_TOKEN);
    if (!endpoint || !token) throw new AdminCenterError(503, 'AWS連携が未設定です。', 'aws_not_configured');
    let url;
    try {
        url = new URL(endpoint);
        if (url.protocol !== 'https:') throw new Error('invalid_protocol');
        url.search = '';
    } catch {
        throw new AdminCenterError(503, 'AWS連携URLが不正です。', 'aws_invalid_url');
    }
    const requestId = crypto.randomUUID();
    const forwarded = { ...payload, actor: admin.email, requestId };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35_000);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(forwarded),
            signal: controller.signal,
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.success !== true) {
            throw new AdminCenterError(response.status >= 400 && response.status < 500 ? response.status : 502,
                result.message || `AWS管理操作に失敗しました（HTTP ${response.status}）。`, 'aws_action_failed');
        }
        await writeAdminAudit(env, admin.email, payload.action, requestId, auditDetails(payload, result));
        return jsonResponse(result);
    } catch (error) {
        if (error instanceof AdminCenterError) throw error;
        throw new AdminCenterError(502, error?.name === 'AbortError' ? 'AWS管理操作がタイムアウトしました。' : 'AWS管理操作に接続できませんでした。', 'aws_action_unavailable');
    } finally {
        clearTimeout(timeout);
    }
}

function countApprovedDeliverySlots(rows) {
    const counts = {};
    for (const row of rows || []) {
        const mappings = parseObjectArray(row.channel_mappings);
        if (mappings.length) {
            for (const mapping of mappings) {
                for (const slot of stringArray(mapping.deliveryTypes || mapping.delivery_types)) {
                    counts[slot] = (counts[slot] || 0) + 1;
                }
            }
            continue;
        }
        for (const slot of stringArray(row.delivery_types)) counts[slot] = (counts[slot] || 0) + 1;
    }
    return counts;
}

function parseObjectArray(value) {
    if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
    if (typeof value !== 'string' || !value.trim()) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
    } catch {
        return [];
    }
}

function stringArray(value) {
    if (Array.isArray(value)) return [...new Set(value.map(clean).filter(Boolean))];
    if (typeof value !== 'string' || !value.trim()) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? [...new Set(parsed.map(clean).filter(Boolean))] : [];
    } catch {
        return value.split(/[,、\n]/u).map(clean).filter(Boolean);
    }
}

function auditDetails(payload, result) {
    return {
        mode: clean(payload.mode) || null,
        operation: clean(payload.operation) || null,
        region: clean(payload.region) || null,
        instanceId: clean(payload.instanceId) || null,
        deliverySlot: clean(payload.deliverySlot) || null,
        sendData: clean(payload.sendData) || null,
        targetCount: Number(result.targetCount || 0),
    };
}

async function writeAdminAudit(env, actor, action, requestId, details) {
    const database = env.NEWSLETTER_DB || env.REUSE_DB || env.IP_BLOCK_DB;
    if (!database) return;
    try {
        await database.prepare(`INSERT INTO admin_audit_events
            (id, actor, action, entity_type, entity_id, details_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .bind(crypto.randomUUID(), actor, `aws.${action}`, 'aws_operation', requestId,
                JSON.stringify(details).slice(0, 8_000), new Date().toISOString()).run();
    } catch (error) {
        console.error('Admin center audit write failed', { action, errorName: error?.name || 'Error' });
    }
}

async function groupedCounts(database, sql) {
    const rows = await queryRows(database, sql);
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.count || 0)]));
}

async function queryRows(database, sql) {
    try {
        const result = await database.prepare(sql).all();
        return result.results || [];
    } catch (error) {
        console.warn('Admin center local query unavailable', { errorName: error?.name || 'Error' });
        return [];
    }
}

async function fetchAwsSummary(env) {
    const endpoint = clean(env.AWS_CHANNEL_DIRECTORY_URL);
    const token = clean(env.AWS_CHANNEL_DIRECTORY_TOKEN);
    if (!endpoint || !token) return { configured: false, available: false, message: 'AWS連携が未設定です。' };
    let url;
    try {
        url = new URL(endpoint);
        if (url.protocol !== 'https:') throw new Error('invalid_protocol');
        url.searchParams.set('view', 'system');
    } catch {
        return { configured: true, available: false, message: 'AWS連携URLが不正です。' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
        const response = await fetch(url, {
            headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
            signal: controller.signal,
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || body.success !== true) {
            return { configured: true, available: false, message: `AWS連携エラー（HTTP ${response.status}）` };
        }
        return { configured: true, available: true, ...body.system, observedAt: body.observedAt || null };
    } catch (error) {
        return { configured: true, available: false, message: error?.name === 'AbortError' ? 'AWS連携がタイムアウトしました。' : 'AWS連携に失敗しました。' };
    } finally {
        clearTimeout(timeout);
    }
}

function clean(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

export const __test = Object.freeze({ groupedCounts, countApprovedDeliverySlots });
