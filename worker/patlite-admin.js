// 積層灯（PATLITE）管理ページの API。
// - POST /api/patlite/ingest : 自宅の積層灯ブリッジ（dpi_code の Di/dpi_patlite_bridge.py）が
//   「いま起きていること」の一覧（conditions）を送る。Authorization: Bearer <PATLITE_BRIDGE_TOKEN>。
//   D1（REUSE_DB）の patlite_state に 1 行だけ上書き保存する。
// - GET /site/patlite-admin/api/state : 管理ページ（Chrome の Web Serial で Arduino を操作する）が読む。
//   認証は admin-center.js（Cloudflare Access + ADMIN_EMAILS）で済ませてから呼ぶこと。
// 色・点滅・表示時間の決まりはページ側（site/patlite-admin/logic.js）と Arduino の EEPROM 設定で決める。

const INGEST_PATH = '/api/patlite/ingest';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CONDITIONS = 200;
const KIND_PATTERN = /^[a-z0-9_]{1,40}$/u;

export class PatliteAdminError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.publicMessage = message;
        this.code = code;
    }
}

export async function handlePatliteIngest(request, env) {
    const pathname = new URL(request.url).pathname.replace(/\/+$/u, '');
    if (pathname !== INGEST_PATH) return null;
    if (request.method !== 'POST') return json({ success: false, code: 'method_not_allowed' }, 405, { Allow: 'POST' });
    if (!await bearerMatches(request, env.PATLITE_BRIDGE_TOKEN)) return json({ success: false, code: 'unauthorized' }, 401);
    const declared = Number(request.headers.get('content-length')) || 0;
    if (declared > MAX_BODY_BYTES) return json({ success: false, code: 'payload_too_large' }, 413);
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return json({ success: false, code: 'payload_too_large' }, 413);
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        return json({ success: false, code: 'invalid_json' }, 400);
    }
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.conditions) || payload.conditions.length > MAX_CONDITIONS) {
        return json({ success: false, code: 'invalid_conditions' }, 400);
    }
    const database = env.REUSE_DB;
    if (!database) return json({ success: false, code: 'database_not_configured' }, 503);
    const conditions = payload.conditions.map(sanitizeCondition).filter(Boolean);
    const generatedAt = finiteNumber(payload.generated_at);
    const receivedAt = Date.now() / 1000;
    await database.prepare(`INSERT INTO patlite_state (id, body, generated_at, received_at) VALUES (1, ?1, ?2, ?3)
        ON CONFLICT(id) DO UPDATE SET body = excluded.body, generated_at = excluded.generated_at, received_at = excluded.received_at`)
        .bind(JSON.stringify(conditions), generatedAt, receivedAt).run();
    return json({ success: true, accepted: conditions.length }, 202);
}

export async function patliteAdminState(env, admin) {
    const database = env.REUSE_DB;
    if (!database) throw new PatliteAdminError(503, 'D1（REUSE_DB）が設定されていません。', 'database_not_configured');
    const row = await database.prepare('SELECT body, generated_at, received_at FROM patlite_state WHERE id = 1').first();
    let conditions = [];
    if (row?.body) {
        try {
            const parsed = JSON.parse(row.body);
            if (Array.isArray(parsed)) conditions = parsed;
        } catch {
            conditions = [];
        }
    }
    return {
        success: true,
        admin: admin?.email || '',
        serverTime: Date.now() / 1000,
        receivedAt: row ? finiteNumber(row.received_at) : null,
        generatedAt: row ? finiteNumber(row.generated_at) : null,
        conditions,
    };
}

function sanitizeCondition(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const kind = String(raw.kind || '');
    if (!KIND_PATTERN.test(kind)) return null;
    const id = String(raw.id || '').slice(0, 200);
    if (!id) return null;
    return {
        id,
        kind,
        title: String(raw.title || '').slice(0, 300),
        since: finiteNumber(raw.since),
        until: finiteNumber(raw.until),
    };
}

function finiteNumber(value) {
    const number = Number(value);
    return value !== null && value !== undefined && value !== '' && Number.isFinite(number) ? number : null;
}

async function bearerMatches(request, expectedValue) {
    const expected = String(expectedValue || '').trim();
    const match = String(request.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/iu);
    const provided = match ? match[1].trim() : '';
    if (!expected || !provided) return false;
    const [left, right] = await Promise.all([digest(expected), digest(provided)]);
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function digest(value) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function json(body, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders },
    });
}

export const __test = Object.freeze({ INGEST_PATH, MAX_BODY_BYTES, MAX_CONDITIONS, sanitizeCondition });
