import { AccessAuthError, authenticateNewsletterAdmin } from './access.js';
import { invalidateIpBlockRuleCache, ipMatchesNetwork, parseNetwork } from './ip-block.js';

const MAX_JSON_BYTES = 8 * 1024;
const MAX_REASON_LENGTH = 500;
const schemaInitialization = new WeakMap();

const SCHEMA_STATEMENTS = Object.freeze([
    `CREATE TABLE IF NOT EXISTS ip_block_rules (
        id TEXT PRIMARY KEY,
        network TEXT NOT NULL UNIQUE COLLATE NOCASE,
        reason TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ip_block_rules_enabled_idx
        ON ip_block_rules(enabled, created_at)`,
    `CREATE TABLE IF NOT EXISTS ip_block_audit (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK (action IN ('create', 'delete')),
        rule_id TEXT NOT NULL,
        network TEXT NOT NULL,
        reason TEXT NOT NULL,
        actor_email TEXT NOT NULL,
        actor_subject TEXT,
        actor_ip TEXT,
        ray_id TEXT,
        created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS ip_block_audit_created_idx
        ON ip_block_audit(created_at DESC)`,
]);

const JSON_HEADERS = Object.freeze({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
});

class IpAdminError extends Error {
    constructor(status, publicMessage, code) {
        super(publicMessage);
        this.name = 'IpAdminError';
        this.status = status;
        this.publicMessage = publicMessage;
        this.code = code;
    }
}

export async function handleIpAdminRequest(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const isApi = pathname === '/site/ip-admin/api' || pathname.startsWith('/site/ip-admin/api/');
    const isAsset = !isApi && (pathname === '/site/ip-admin' || pathname.startsWith('/site/ip-admin/'));
    if (!isApi && !isAsset) return null;

    try {
        if (isAsset) return await protectedAsset(request, env);
        return await adminApi(request, env, pathname);
    } catch (error) {
        return errorResponse(error, isAsset);
    }
}

async function protectedAsset(request, env) {
    if (!['GET', 'HEAD'].includes(request.method)) {
        throw new IpAdminError(405, '許可されていない操作です。', 'method_not_allowed');
    }
    await authenticateNewsletterAdmin(request, env);

    const url = new URL(request.url);
    if (url.pathname === '/site/ip-admin') {
        url.pathname = '/site/ip-admin/';
        return new Response(null, {
            status: 308,
            headers: { Location: url.toString(), 'Cache-Control': 'no-store' },
        });
    }

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('X-Frame-Options', 'DENY');
    if ((headers.get('content-type') || '').includes('text/html')) {
        headers.set(
            'Content-Security-Policy',
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
        );
    }
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

async function adminApi(request, env, pathname) {
    const admin = await authenticateNewsletterAdmin(request, env);
    assertDatabaseConfigured(env);
    await ensureSchema(env);

    if (pathname === '/site/ip-admin/api/rules') {
        if (request.method === 'GET') return listRules(request, env, admin);
        if (request.method === 'POST') {
            assertSameOrigin(request);
            return createRule(request, env, admin);
        }
        throw new IpAdminError(405, '許可されていない操作です。', 'method_not_allowed');
    }

    const ruleMatch = pathname.match(/^\/site\/ip-admin\/api\/rules\/([0-9a-f-]{36})$/u);
    if (ruleMatch) {
        assertMethod(request, ['DELETE']);
        assertSameOrigin(request);
        return deleteRule(request, env, admin, ruleMatch[1]);
    }

    throw new IpAdminError(404, '指定された管理APIはありません。', 'not_found');
}

async function listRules(request, env, admin) {
    const [rulesResult, auditResult] = await env.NEWSLETTER_DB.batch([
        env.NEWSLETTER_DB.prepare(
            `SELECT id, network, reason, enabled, created_by, created_at, updated_by, updated_at
             FROM ip_block_rules ORDER BY created_at DESC`,
        ),
        env.NEWSLETTER_DB.prepare(
            `SELECT id, action, rule_id, network, reason, actor_email, actor_ip, ray_id, created_at
             FROM ip_block_audit ORDER BY created_at DESC LIMIT 50`,
        ),
    ]);

    return jsonResponse({
        success: true,
        admin: admin.email,
        currentIp: clientIp(request),
        staticRulesConfigured: Boolean(cleanValue(env.BLOCKED_IPS)),
        rules: (rulesResult?.results || []).map(formatRule),
        audit: (auditResult?.results || []).map(formatAudit),
    });
}

async function createRule(request, env, admin) {
    const input = await readJson(request);
    const parsed = parseNetwork(cleanValue(input.network));
    if (!parsed) {
        throw new IpAdminError(
            400,
            'IPアドレスまたはCIDRが正しくありません。CIDRはネットワークアドレスで指定してください。',
            'invalid_network',
        );
    }
    const reason = validateReason(input.reason);
    const remoteIp = clientIp(request);
    const selfBlock = remoteIp && ipMatchesNetwork(remoteIp, parsed.network);
    if (selfBlock && cleanValue(input.confirmation) !== parsed.network) {
        throw new IpAdminError(
            409,
            '現在接続しているIPも遮断対象です。確認後、もう一度登録してください。',
            'self_block_confirmation_required',
        );
    }

    const existing = await env.NEWSLETTER_DB.prepare(
        'SELECT id FROM ip_block_rules WHERE network = ? COLLATE NOCASE',
    ).bind(parsed.network).first();
    if (existing) {
        throw new IpAdminError(409, '同じIPアドレスまたはCIDRはすでに登録されています。', 'duplicate_network');
    }

    const id = crypto.randomUUID();
    const auditId = crypto.randomUUID();
    const now = new Date().toISOString();
    const rayId = cleanValue(request.headers.get('cf-ray')).slice(0, 128);
    await env.NEWSLETTER_DB.batch([
        env.NEWSLETTER_DB.prepare(
            `INSERT INTO ip_block_rules (
                id, network, reason, enabled, created_by, created_at, updated_by, updated_at
             ) VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
        ).bind(id, parsed.network, reason, admin.email, now, admin.email, now),
        env.NEWSLETTER_DB.prepare(
            `INSERT INTO ip_block_audit (
                id, action, rule_id, network, reason, actor_email, actor_subject,
                actor_ip, ray_id, created_at
             ) VALUES (?, 'create', ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(auditId, id, parsed.network, reason, admin.email, admin.subject, remoteIp, rayId, now),
    ]);
    invalidateIpBlockRuleCache();
    console.warn('IP block rule created', { id, network: parsed.network, admin: admin.email, rayId });

    return jsonResponse({
        success: true,
        selfBlock,
        rule: formatRule({
            id,
            network: parsed.network,
            reason,
            enabled: 1,
            created_by: admin.email,
            created_at: now,
            updated_by: admin.email,
            updated_at: now,
        }),
    }, 201);
}

async function deleteRule(request, env, admin, ruleId) {
    const input = await readJson(request);
    if (cleanValue(input.confirmation) !== ruleId) {
        throw new IpAdminError(400, '削除確認が一致しません。', 'invalid_confirmation');
    }

    const rule = await env.NEWSLETTER_DB.prepare(
        'SELECT id, network, reason FROM ip_block_rules WHERE id = ?',
    ).bind(ruleId).first();
    if (!rule) throw new IpAdminError(404, '指定された遮断ルールはありません。', 'rule_not_found');

    const now = new Date().toISOString();
    const rayId = cleanValue(request.headers.get('cf-ray')).slice(0, 128);
    const remoteIp = clientIp(request);
    await env.NEWSLETTER_DB.batch([
        env.NEWSLETTER_DB.prepare('DELETE FROM ip_block_rules WHERE id = ?').bind(ruleId),
        env.NEWSLETTER_DB.prepare(
            `INSERT INTO ip_block_audit (
                id, action, rule_id, network, reason, actor_email, actor_subject,
                actor_ip, ray_id, created_at
             ) VALUES (?, 'delete', ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
            crypto.randomUUID(),
            ruleId,
            rule.network,
            rule.reason,
            admin.email,
            admin.subject,
            remoteIp,
            rayId,
            now,
        ),
    ]);
    invalidateIpBlockRuleCache();
    console.warn('IP block rule deleted', { id: ruleId, network: rule.network, admin: admin.email, rayId });
    return jsonResponse({ success: true, deleted: { id: ruleId, network: rule.network } });
}

async function ensureSchema(env) {
    const database = env.NEWSLETTER_DB;
    let initialization = schemaInitialization.get(database);
    if (!initialization) {
        initialization = database.batch(SCHEMA_STATEMENTS.map((sql) => database.prepare(sql)));
        schemaInitialization.set(database, initialization);
    }
    try {
        await initialization;
    } catch (error) {
        schemaInitialization.delete(database);
        throw error;
    }
}

function assertDatabaseConfigured(env) {
    if (!env.NEWSLETTER_DB?.prepare || !env.NEWSLETTER_DB?.batch) {
        throw new IpAdminError(503, 'IP遮断管理用データベースが設定されていません。', 'database_not_configured');
    }
}

function assertSameOrigin(request) {
    const origin = request.headers.get('origin');
    if (!origin || origin !== new URL(request.url).origin) {
        throw new IpAdminError(403, 'この管理画面以外からは操作できません。', 'invalid_origin');
    }
}

function assertMethod(request, allowed) {
    if (!allowed.includes(request.method)) {
        throw new IpAdminError(405, '許可されていない操作です。', 'method_not_allowed');
    }
}

async function readJson(request) {
    const contentType = (request.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
        throw new IpAdminError(415, '送信形式が正しくありません。', 'invalid_content_type');
    }
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
        throw new IpAdminError(413, '送信データが大きすぎます。', 'request_too_large');
    }
    if (!request.body) throw new IpAdminError(400, '送信内容がありません。', 'empty_body');
    const reader = request.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0;
    let text = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_JSON_BYTES) {
                await reader.cancel();
                throw new IpAdminError(413, '送信データが大きすぎます。', 'request_too_large');
            }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
    } catch (error) {
        if (error instanceof IpAdminError) throw error;
        throw new IpAdminError(400, '送信内容を読み取れませんでした。', 'invalid_encoding');
    }
    try {
        const result = JSON.parse(text);
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('not_object');
        return result;
    } catch {
        throw new IpAdminError(400, '送信内容を読み取れませんでした。', 'invalid_json');
    }
}

function validateReason(value) {
    const reason = cleanValue(value).replace(/\r\n?/gu, '\n');
    if (!reason || reason.length > MAX_REASON_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(reason)) {
        throw new IpAdminError(400, `理由は${MAX_REASON_LENGTH}文字以内で入力してください。`, 'invalid_reason');
    }
    return reason;
}

function formatRule(row) {
    return {
        id: row.id,
        network: row.network,
        reason: row.reason,
        enabled: Number(row.enabled) === 1,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedBy: row.updated_by,
        updatedAt: row.updated_at,
    };
}

function formatAudit(row) {
    return {
        id: row.id,
        action: row.action,
        ruleId: row.rule_id,
        network: row.network,
        reason: row.reason,
        actorEmail: row.actor_email,
        actorIp: row.actor_ip || '',
        rayId: row.ray_id || '',
        createdAt: row.created_at,
    };
}

function clientIp(request) {
    return cleanValue(request.headers.get('cf-connecting-ip')).slice(0, 64);
}

function cleanValue(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function errorResponse(error, isAsset) {
    if (error instanceof AccessAuthError || error instanceof IpAdminError) {
        if (!isAsset) {
            return jsonResponse({ success: false, message: error.publicMessage, code: error.code }, error.status);
        }
        return simpleErrorPage(error.status, error.publicMessage);
    }
    console.error('IP block admin failed', {
        errorName: error?.name || 'Error',
        errorCode: error?.code || 'unknown',
    });
    if (!isAsset) {
        return jsonResponse({
            success: false,
            message: 'IP遮断管理の処理に失敗しました。時間をおいて再度お試しください。',
            code: 'internal_error',
        }, 500);
    }
    return simpleErrorPage(500, 'IP遮断管理画面を表示できませんでした。');
}

function simpleErrorPage(status, message) {
    const safeMessage = String(message).replace(/[&<>"']/gu, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[character]);
    return new Response(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${status} | DPI-Bot</title></head><body><main><h1>${status}</h1><p>${safeMessage}</p></main></body></html>`, {
        status,
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
            'X-Content-Type-Options': 'nosniff',
            'X-Robots-Tag': 'noindex, nofollow',
        },
    });
}

export const __test = Object.freeze({
    createRule,
    deleteRule,
    formatAudit,
    formatRule,
    validateReason,
});
