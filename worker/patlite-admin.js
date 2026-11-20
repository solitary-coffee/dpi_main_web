// 積層灯（PATLITE）管理ページの API。
// - POST /api/patlite/ingest : 自宅の積層灯ブリッジ（dpi_code の Di/dpi_patlite_bridge.py）が
//   「いま起きていること」の一覧（conditions）を送る。Authorization: Bearer <PATLITE_BRIDGE_TOKEN>。
//   D1（REUSE_DB）の patlite_state に 1 行だけ上書き保存する。
// - GET /site/patlite-admin/api/state : 管理ページ（Chrome の Web Serial で Arduino を操作する）が読む。
//   認証は admin-center.js（Cloudflare Access + ADMIN_EMAILS）で済ませてから呼ぶこと。
// - POST /site/patlite-admin/api/settings : 一時停止（何時間か全部消す）・夜間モード（重大だけ表示）・
//   イルミネーション試験の設定を保存する（管理者のみ。D1 の patlite_settings に 1 行）。
// - 履歴: 送信のたびに前回との差（出た項目・消えた項目）を patlite_history に書く。ブリッジからの送信が
//   LINK_GAP_SECONDS 以上途切れた時間帯も kind = link_lost で残す。GET /site/patlite-admin/api/history で読む。
// - 遠隔操作: POST /site/patlite-admin/api/command（ack / fullstop_on / fullstop_off / illum）で依頼を D1 の
//   patlite_commands に積み、state の応答に未実行の依頼を含める。積層灯ページが実行して
//   POST /site/patlite-admin/api/command/done で完了にする（done を先に取ったページだけが実行する）。
// 色・点滅・表示時間の決まりはページ側（site/patlite-admin/logic.js）と Arduino の EEPROM 設定で決める。

const INGEST_PATH = '/api/patlite/ingest';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CONDITIONS = 200;
const KIND_PATTERN = /^[a-z0-9_]{1,40}$/u;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const MAX_SNOOZE_SECONDS = 7 * 24 * 3600;
const LINK_GAP_SECONDS = 180;
const HISTORY_RETENTION_SECONDS = 90 * 24 * 3600;
const MAX_HISTORY_ROWS = 500;
export const COMMAND_TTL_SECONDS = 120;
const COMMANDS = new Set(['ack', 'fullstop_on', 'fullstop_off', 'illum']);
export const DEFAULT_SETTINGS = Object.freeze({
    snoozeUntil: null,
    snoozeForever: false,
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
    try {
        await recordHistory(database, conditions, receivedAt);
    } catch (error) {
        console.error('patlite history write failed', { errorName: error?.name || 'Error' });   // 履歴の失敗で状態の保存は止めない
    }
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
        commands: await pendingCommands(database),
    };
}

async function pendingCommands(database, now = Date.now() / 1000) {
    try {
        const result = await database.prepare(`SELECT id, command, args, created_at FROM patlite_commands
            WHERE done_at IS NULL AND created_at >= ?1 ORDER BY created_at ASC LIMIT 20`).bind(now - COMMAND_TTL_SECONDS).all();
        return (result.results || []).map((row) => {
            let args = {};
            try { args = JSON.parse(row.args || '{}') || {}; } catch { args = {}; }
            return { id: String(row.id), command: String(row.command), args, createdAt: finiteNumber(row.created_at) };
        });
    } catch {
        return [];   // テーブルが無い（マイグレーション前）などでも状態の表示は止めない
    }
}

function sameOriginJson(request) {
    const requestUrl = new URL(request.url);
    const origin = String(request.headers.get('origin') || '').trim();
    if ((origin && origin !== requestUrl.origin) || String(request.headers.get('sec-fetch-site') || '') === 'cross-site') {
        throw new PatliteAdminError(403, '別サイトからの管理操作は許可されていません。', 'invalid_origin');
    }
    if (!String(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
        throw new PatliteAdminError(415, 'JSON形式で送信してください。', 'invalid_content_type');
    }
}

async function readSmallJson(request) {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 4096) throw new PatliteAdminError(413, '送信データが大きすぎます。', 'payload_too_large');
    try {
        const value = JSON.parse(text);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not_object');
        return value;
    } catch {
        throw new PatliteAdminError(400, 'JSON形式を確認してください。', 'invalid_json');
    }
}

// 遠隔操作の依頼を積む（操作盤ページなどから）
export async function patliteAdminCommand(request, env, admin) {
    sameOriginJson(request);
    const payload = await readSmallJson(request);
    const command = String(payload.command || '');
    if (!COMMANDS.has(command)) throw new PatliteAdminError(400, '操作の種類を確認してください。', 'invalid_command');
    const args = {};
    if (command === 'illum') {
        const seconds = Math.round(Number(payload.seconds ?? 20));
        if (!Number.isFinite(seconds) || seconds < 5 || seconds > 120) throw new PatliteAdminError(400, '試験点灯は 5〜120 秒です。', 'invalid_seconds');
        args.seconds = seconds;
    }
    const database = env.REUSE_DB;
    if (!database) throw new PatliteAdminError(503, 'D1（REUSE_DB）が設定されていません。', 'database_not_configured');
    const id = crypto.randomUUID();
    const now = Date.now() / 1000;
    await database.prepare('INSERT INTO patlite_commands (id, command, args, created_at, created_by) VALUES (?1, ?2, ?3, ?4, ?5)')
        .bind(id, command, JSON.stringify(args), now, String(admin?.email || '').slice(0, 200)).run();
    if (Math.random() < 0.05) {
        await database.prepare('DELETE FROM patlite_commands WHERE created_at < ?1').bind(now - 7 * 86400).run();
    }
    return { success: true, id, command, args, expiresAt: now + COMMAND_TTL_SECONDS };
}

// 依頼を実行する前に「自分が実行する」と取る。先に取ったページだけが claimed=true（二重実行しない）
export async function patliteAdminCommandDone(request, env, admin) {
    sameOriginJson(request);
    const payload = await readSmallJson(request);
    const id = String(payload.id || '');
    if (!/^[0-9a-f-]{36}$/u.test(id)) throw new PatliteAdminError(400, '依頼の ID を確認してください。', 'invalid_id');
    const database = env.REUSE_DB;
    if (!database) throw new PatliteAdminError(503, 'D1（REUSE_DB）が設定されていません。', 'database_not_configured');
    const now = Date.now() / 1000;
    const result = await database.prepare(`UPDATE patlite_commands SET done_at = ?1, done_by = ?2
        WHERE id = ?3 AND done_at IS NULL AND created_at >= ?4`).bind(now, String(admin?.email || '').slice(0, 200), id, now - COMMAND_TTL_SECONDS).run();
    const claimed = Number(result?.meta?.changes || 0) === 1;
    return { success: true, id, claimed };
}

// 前回からの差だけを書く: 新しく出た項目は INSERT、消えた項目は ended_at を入れる
export async function recordHistory(database, conditions, now) {
    const previous = await database.prepare('SELECT received_at FROM patlite_state WHERE id = 1').first();
    const lastReceived = finiteNumber(previous?.received_at);
    const statements = [];
    if (lastReceived !== null && now - lastReceived > LINK_GAP_SECONDS) {
        statements.push(database.prepare('INSERT INTO patlite_history (cid, kind, title, started_at, ended_at) VALUES (?1, ?2, ?3, ?4, ?5)')
            .bind('link_lost', 'link_lost', '自宅のブリッジからの送信が途切れた', lastReceived + LINK_GAP_SECONDS, now));
    }
    const open = (await database.prepare('SELECT row_id, cid FROM patlite_history WHERE ended_at IS NULL').all()).results || [];
    const openIds = new Map(open.map((row) => [String(row.cid), row.row_id]));
    const current = new Map(conditions.map((condition) => [condition.id, condition]));
    for (const [cid, rowId] of openIds) {
        if (!current.has(cid)) statements.push(database.prepare('UPDATE patlite_history SET ended_at = ?1 WHERE row_id = ?2').bind(now, rowId));
    }
    for (const [cid, condition] of current) {
        if (openIds.has(cid)) continue;
        const started = condition.since !== null && condition.since <= now && condition.since > now - 7 * 24 * 3600 ? condition.since : now;
        statements.push(database.prepare('INSERT INTO patlite_history (cid, kind, title, started_at, ended_at) VALUES (?1, ?2, ?3, ?4, NULL)')
            .bind(cid, condition.kind, condition.title || condition.kind, started));
    }
    if (Math.random() < 0.01) {
        statements.push(database.prepare('DELETE FROM patlite_history WHERE ended_at IS NOT NULL AND ended_at < ?1').bind(now - HISTORY_RETENTION_SECONDS));
    }
    if (statements.length) await database.batch(statements);
    return statements.length;
}

export async function patliteAdminHistory(env, url) {
    const database = env.REUSE_DB;
    if (!database) throw new PatliteAdminError(503, 'D1（REUSE_DB）が設定されていません。', 'database_not_configured');
    const days = Math.min(90, Math.max(1, Math.round(Number(url.searchParams.get('days')) || 7)));
    const since = Date.now() / 1000 - days * 86400;
    const result = await database.prepare(`SELECT cid, kind, title, started_at, ended_at FROM patlite_history
        WHERE started_at >= ?1 OR ended_at IS NULL OR ended_at >= ?1 ORDER BY started_at DESC LIMIT ?2`).bind(since, MAX_HISTORY_ROWS).all();
    const rows = (result.results || []).map((row) => ({
        id: String(row.cid), kind: String(row.kind), title: String(row.title),
        startedAt: finiteNumber(row.started_at), endedAt: finiteNumber(row.ended_at),
    }));
    return { success: true, days, serverTime: Date.now() / 1000, rows, truncated: rows.length >= MAX_HISTORY_ROWS };
}

export function normalizeSettings(raw, nowSeconds = Date.now() / 1000) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const night = source.night && typeof source.night === 'object' ? source.night : {};
    const illumination = source.illumination && typeof source.illumination === 'object' ? source.illumination : {};
    const snooze = finiteNumber(source.snoozeUntil);
    const seconds = Math.round(Number(illumination.seconds));
    const forever = source.snoozeForever === true;
    return {
        // 無期限の一時停止（解除するまで全部消灯）。無期限のときは期限付きの値は持たない
        snoozeForever: forever,
        snoozeUntil: !forever && snooze && snooze > nowSeconds ? Math.min(snooze, nowSeconds + MAX_SNOOZE_SECONDS) : null,
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
