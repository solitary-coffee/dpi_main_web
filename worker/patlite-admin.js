// 積層灯（PATLITE）管理ページの API。
// - POST /api/patlite/ingest : 自宅の積層灯ブリッジ（dpi_code の Di/dpi_patlite_bridge.py）が
//   「いま起きていること」の一覧（conditions）を送る。Authorization: Bearer <PATLITE_BRIDGE_TOKEN>。
//   D1（REUSE_DB）の patlite_state に 1 行だけ上書き保存する。
// - GET /site/patlite-admin/api/state : 管理ページ（Chrome の Web Serial で Arduino を操作する）が読む。
//   認証は admin-center.js（Cloudflare Access + ADMIN_EMAILS）で済ませてから呼ぶこと。
// - POST /site/patlite-admin/api/settings : 一時停止（何時間か全部消す）・夜間モード（重大だけ表示）・
//   イルミネーション試験の設定を保存する（管理者のみ。D1 の patlite_settings に 1 行）。
// 色・点滅・表示時間の決まりはページ側（site/patlite-admin/logic.js）と Arduino の EEPROM 設定で決める。

const INGEST_PATH = '/api/patlite/ingest';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CONDITIONS = 200;
const KIND_PATTERN = /^[a-z0-9_]{1,40}$/u;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const MAX_SNOOZE_SECONDS = 7 * 24 * 3600;
export const DEFAULT_SETTINGS = Object.freeze({
    snoozeUntil: null,
    night: Object.freeze({ enabled: false, start: '22:00', end: '07:00' }),
    illumination: Object.freeze({ daily: false, seconds: 20 }),
});

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
        settings: await readSettings(database),
        serverTime: Date.now() / 1000,
        receivedAt: row ? finiteNumber(row.received_at) : null,
        generatedAt: row ? finiteNumber(row.generated_at) : null,
        conditions,
    };
}

export function normalizeSettings(raw, nowSeconds = Date.now() / 1000) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const night = source.night && typeof source.night === 'object' ? source.night : {};
    const illumination = source.illumination && typeof source.illumination === 'object' ? source.illumination : {};
    const snooze = finiteNumber(source.snoozeUntil);
    const seconds = Math.round(Number(illumination.seconds));
    return {
        snoozeUntil: snooze && snooze > nowSeconds ? Math.min(snooze, nowSeconds + MAX_SNOOZE_SECONDS) : null,
        night: {
            enabled: night.enabled === true,
            start: TIME_PATTERN.test(String(night.start)) ? String(night.start) : DEFAULT_SETTINGS.night.start,
            end: TIME_PATTERN.test(String(night.end)) ? String(night.end) : DEFAULT_SETTINGS.night.end,
        },
        illumination: {
            daily: illumination.daily === true,
            seconds: Number.isFinite(seconds) && seconds >= 5 && seconds <= 120 ? seconds : DEFAULT_SETTINGS.illumination.seconds,
        },
    };
}

async function readSettings(database) {
    const row = await database.prepare('SELECT body FROM patlite_settings WHERE id = 1').first();
    let parsed = null;
    try {
        parsed = row?.body ? JSON.parse(row.body) : null;
    } catch {
        parsed = null;
    }
    return normalizeSettings(parsed);
}

export async function patliteAdminSaveSettings(request, env, admin) {
    const requestUrl = new URL(request.url);
    const origin = String(request.headers.get('origin') || '').trim();
    if ((origin && origin !== requestUrl.origin) || String(request.headers.get('sec-fetch-site') || '') === 'cross-site') {
        throw new PatliteAdminError(403, '別サイトからの管理操作は許可されていません。', 'invalid_origin');
    }
    if (!String(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
        throw new PatliteAdminError(415, 'JSON形式で送信してください。', 'invalid_content_type');
    }
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 4096) throw new PatliteAdminError(413, '送信データが大きすぎます。', 'payload_too_large');
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        throw new PatliteAdminError(400, 'JSON形式を確認してください。', 'invalid_json');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new PatliteAdminError(400, '設定を確認してください。', 'invalid_settings');
    const database = env.REUSE_DB;
    if (!database) throw new PatliteAdminError(503, 'D1（REUSE_DB）が設定されていません。', 'database_not_configured');
    const settings = normalizeSettings(payload);
    await database.prepare(`INSERT INTO patlite_settings (id, body, updated_at, updated_by) VALUES (1, ?1, ?2, ?3)
        ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
        .bind(JSON.stringify(settings), Date.now() / 1000, String(admin?.email || '').slice(0, 200)).run();
    return { success: true, settings };
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
