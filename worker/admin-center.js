import { AccessAuthError, authenticateNewsletterAdmin } from './access.js';
import { DELIVERY_CATALOG } from './delivery-catalog.js';

const JSON_HEADERS = Object.freeze({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
});

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
    const isApi = pathname === '/site/admin-center/api/summary';
    const isAsset = !isApi && (pathname === '/site/admin-center' || pathname.startsWith('/site/admin-center/'));
    if (!isApi && !isAsset) return null;

    try {
        const admin = await authenticateNewsletterAdmin(request, env);
        if (isApi) {
            if (request.method !== 'GET') {
                return jsonResponse({ success: false, message: '許可されていない操作です。' }, 405, { Allow: 'GET' });
            }
            return await systemSummary(env, admin);
        }
        if (!['GET', 'HEAD'].includes(request.method)) {
            throw new AdminCenterError(405, '許可されていない操作です。', 'method_not_allowed');
        }
        // Use the original URL here. `pathname` above has trailing slashes removed
        // for route matching, so checking it would also redirect the already
        // canonical `/site/admin-center/` URL back to itself forever.
        if (url.pathname === '/site/admin-center') {
            url.pathname = '/site/admin-center/';
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

    const [reuse, campaigns, subscribers, blocks, audit, reuseEvents, aws] = await Promise.all([
        groupedCounts(database, 'SELECT status, COUNT(*) AS count FROM reuse_applications GROUP BY status'),
        groupedCounts(database, 'SELECT status, COUNT(*) AS count FROM newsletter_campaigns GROUP BY status'),
        groupedCounts(database, 'SELECT status, COUNT(*) AS count FROM newsletter_subscribers GROUP BY status'),
        queryRows(database, `SELECT id, network, reason, created_by, created_at, updated_by, updated_at
            FROM ip_block_rules WHERE enabled = 1 ORDER BY created_at DESC LIMIT 20`),
        queryRows(database, `SELECT id, actor, action, entity_type, entity_id, created_at
            FROM admin_audit_events ORDER BY created_at DESC LIMIT 30`),
        queryRows(database, `SELECT id, application_id, event_type, actor, message, created_at
            FROM reuse_application_events ORDER BY created_at DESC LIMIT 30`),
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
        },
        aws,
        deliveryCatalog: DELIVERY_CATALOG,
        links: [
            { label: '二次利用申請管理', href: '/site/reuse-admin/' },
            { label: 'お知らせ一括配信', href: '/site/mail-admin/' },
            { label: '配信先検索', href: '/site/channel-admin/' },
            { label: 'IP遮断管理', href: '/site/ip-admin/' },
        ],
    });
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

export const __test = Object.freeze({ groupedCounts });
