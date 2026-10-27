const JSON_HEADERS = Object.freeze({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
});

const INGEST_PATH = '/internal/access-log/v1/events';
const FEED_PATH = '/internal/access-log/v1/feed';
const MAX_EVENT_BYTES = 32 * 1024;
const MAX_BATCH_SIZE = 100;
const MAX_FIELD = 2048;
const DEFAULT_RETENTION_DAYS = 30;

export async function withAccessLog(request, env, ctx, site, handler) {
    const startedAt = Date.now();
    let response;
    try {
        response = await handler();
        return response;
    } catch (error) {
        response = new Response(null, { status: 500 });
        throw error;
    } finally {
        const pathname = new URL(request.url).pathname;
        if (!pathname.startsWith('/internal/access-log/')) {
            const task = recordAccessEvent(request, response, env, site, startedAt);
            if (ctx?.waitUntil) ctx.waitUntil(task);
            else await task;
        }
    }
}

export async function handleAccessLogRequest(request, env) {
    const url = new URL(request.url);
    if (url.pathname === INGEST_PATH) return ingest(request, env);
    if (url.pathname === FEED_PATH) return feed(request, env, url);
    return null;
}

async function recordAccessEvent(request, response, env, site, startedAt) {
    try {
        const event = buildEvent(request, response, site, startedAt);
        const database = accessDatabase(env);
        if (database) {
            await insertEvents(database, [event], retentionDays(env));
            return;
        }
        const endpoint = clean(env.ACCESS_LOG_INGEST_URL);
        const token = clean(env.ACCESS_LOG_INGEST_TOKEN);
        if (!endpoint || !token) return;
        const target = new URL(INGEST_PATH, endpoint);
        if (target.protocol !== 'https:') return;
        await fetch(target, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
            },
            body: JSON.stringify({ events: [event] }),
        });
    } catch (error) {
        console.error('Access log delivery failed', { errorName: error?.name || 'Error' });
    }
}

function buildEvent(request, response, site, startedAt) {
    const url = new URL(request.url);
    const cf = request.cf || {};
    const responseLength = response?.headers?.get('content-length');
    return sanitizeEvent({
        id: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        site,
        host: url.hostname,
        method: request.method,
        path: url.pathname,
        queryKeys: [...new Set([...url.searchParams.keys()])].slice(0, 40),
        ip: request.headers.get('cf-connecting-ip') || '',
        status: response?.status || 500,
        durationMs: Math.max(0, Date.now() - startedAt),
        userAgent: request.headers.get('user-agent') || '',
        referer: safeReferer(request.headers.get('referer')),
        cfRay: request.headers.get('cf-ray') || '',
        country: cf.country || request.headers.get('cf-ipcountry') || '',
        colo: cf.colo || '',
        requestBytes: numericHeader(request.headers.get('content-length')),
        responseBytes: numericHeader(responseLength),
        contentType: response?.headers?.get('content-type') || '',
        source: 'cloudflare-worker',
    });
}

async function ingest(request, env) {
    if (request.method !== 'POST') return json({ success: false, code: 'method_not_allowed' }, 405, { allow: 'POST' });
    if (!await bearerMatches(request, env.ACCESS_LOG_INGEST_TOKEN)) {
        return json({ success: false, code: 'unauthorized' }, 401);
    }
    const declared = numericHeader(request.headers.get('content-length')) || 0;
    if (declared > MAX_EVENT_BYTES) return json({ success: false, code: 'payload_too_large' }, 413);
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_EVENT_BYTES) {
        return json({ success: false, code: 'payload_too_large' }, 413);
    }
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        return json({ success: false, code: 'invalid_json' }, 400);
    }
    const rawEvents = Array.isArray(payload?.events) ? payload.events : [payload?.event].filter(Boolean);
    if (!rawEvents.length || rawEvents.length > MAX_BATCH_SIZE) {
        return json({ success: false, code: 'invalid_batch' }, 400);
    }
    const database = accessDatabase(env);
    if (!database) return json({ success: false, code: 'database_not_configured' }, 503);
    const events = rawEvents.map(sanitizeEvent);
    await insertEvents(database, events, retentionDays(env));
    return json({ success: true, accepted: events.length }, 202);
}

async function feed(request, env, url) {
    if (request.method !== 'GET') return json({ success: false, code: 'method_not_allowed' }, 405, { allow: 'GET' });
    if (!await bearerMatches(request, env.ACCESS_LOG_HOME_TOKEN)) {
        return json({ success: false, code: 'unauthorized' }, 401);
    }
    const database = accessDatabase(env);
    if (!database) return json({ success: false, code: 'database_not_configured' }, 503);
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
    const cursor = decodeCursor(url.searchParams.get('cursor'));
    const statement = database.prepare(`SELECT id, occurred_at, received_at, site, host, method, path,
        query_keys, ip, status, duration_ms, user_agent, referer, cf_ray, country, colo,
        request_bytes, response_bytes, content_type, source
        FROM access_log_events
        WHERE received_at > ?1 OR (received_at = ?1 AND id > ?2)
        ORDER BY received_at ASC, id ASC LIMIT ?3`);
    const result = await statement.bind(cursor.receivedAt, cursor.id, limit).all();
    const events = (result.results || []).map(rowToEvent);
    const last = events.at(-1);
    return json({
        success: true,
        events,
        cursor: last ? encodeCursor(last.receivedAt, last.id) : encodeCursor(cursor.receivedAt, cursor.id),
        fetchedAt: new Date().toISOString(),
    });
}

async function insertEvents(database, events, retention) {
    const receivedAt = new Date().toISOString();
    const statements = events.map((event) => database.prepare(`INSERT OR IGNORE INTO access_log_events (
        id, occurred_at, received_at, site, host, method, path, query_keys, ip, status,
        duration_ms, user_agent, referer, cf_ray, country, colo, request_bytes,
        response_bytes, content_type, source
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)`)
        .bind(event.id, event.occurredAt, receivedAt, event.site, event.host, event.method,
            event.path, JSON.stringify(event.queryKeys), event.ip, event.status, event.durationMs,
            event.userAgent, event.referer, event.cfRay, event.country, event.colo,
            event.requestBytes, event.responseBytes, event.contentType, event.source));
    await database.batch(statements);
    if (Math.random() < 0.01) {
        const cutoff = new Date(Date.now() - retention * 86_400_000).toISOString();
        await database.prepare('DELETE FROM access_log_events WHERE occurred_at < ?1').bind(cutoff).run();
    }
}

function sanitizeEvent(raw) {
    const method = field(raw?.method, 16).toUpperCase();
    const status = integer(raw?.status, 100, 599, 500);
    return {
        id: uuid(raw?.id),
        occurredAt: isoDate(raw?.occurredAt),
        receivedAt: isoDate(raw?.receivedAt),
        site: field(raw?.site, 120) || 'unknown',
        host: field(raw?.host, 253).toLowerCase(),
        method: /^[A-Z]+$/.test(method) ? method : 'UNKNOWN',
        path: safePath(raw?.path),
        queryKeys: Array.isArray(raw?.queryKeys) ? raw.queryKeys.map((value) => field(value, 80)).filter(Boolean).slice(0, 40) : [],
        ip: field(raw?.ip, 64),
        status,
        durationMs: integer(raw?.durationMs, 0, 3_600_000, 0),
        userAgent: field(raw?.userAgent, 1024),
        referer: safeReferer(raw?.referer),
        cfRay: field(raw?.cfRay, 64),
        country: field(raw?.country, 8).toUpperCase(),
        colo: field(raw?.colo, 16).toUpperCase(),
        requestBytes: integer(raw?.requestBytes, 0, 100_000_000, null),
        responseBytes: integer(raw?.responseBytes, 0, 100_000_000, null),
        contentType: field(raw?.contentType, 256),
        source: field(raw?.source, 80) || 'cloudflare-worker',
    };
}

function rowToEvent(row) {
    let queryKeys = [];
    try { queryKeys = JSON.parse(row.query_keys || '[]'); } catch { queryKeys = []; }
    return sanitizeEvent({
        id: row.id, occurredAt: row.occurred_at, receivedAt: row.received_at,
        site: row.site, host: row.host, method: row.method, path: row.path,
        queryKeys, ip: row.ip, status: row.status, durationMs: row.duration_ms,
        userAgent: row.user_agent, referer: row.referer, cfRay: row.cf_ray,
        country: row.country, colo: row.colo, requestBytes: row.request_bytes,
        responseBytes: row.response_bytes, contentType: row.content_type, source: row.source,
    });
}

function accessDatabase(env) {
    return env.ACCESS_LOG_DB || null;
}

function retentionDays(env) {
    return integer(env.ACCESS_LOG_RETENTION_DAYS, 1, 365, DEFAULT_RETENTION_DAYS);
}

async function bearerMatches(request, expectedValue) {
    const expected = clean(expectedValue);
    const match = clean(request.headers.get('authorization')).match(/^Bearer\s+(.+)$/i);
    const provided = match ? match[1].trim() : '';
    if (!expected || !provided) return false;
    const [left, right] = await Promise.all([digest(expected), digest(provided)]);
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function digest(value) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

function encodeCursor(receivedAt, id) {
    return btoa(JSON.stringify([receivedAt || '1970-01-01T00:00:00.000Z', id || '']));
}

function decodeCursor(value) {
    if (!value) return { receivedAt: '1970-01-01T00:00:00.000Z', id: '' };
    try {
        const [receivedAt, id] = JSON.parse(atob(value));
        return { receivedAt: isoDate(receivedAt, '1970-01-01T00:00:00.000Z'), id: field(id, 64) };
    } catch {
        return { receivedAt: '1970-01-01T00:00:00.000Z', id: '' };
    }
}

function safePath(value) {
    const path = field(value, MAX_FIELD) || '/';
    return path.startsWith('/') ? path : '/';
}

function safeReferer(value) {
    if (!value) return '';
    try {
        const url = new URL(String(value));
        return field(`${url.origin}${url.pathname}`, 1024);
    } catch {
        return '';
    }
}

function isoDate(value, fallback = new Date().toISOString()) {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function uuid(value) {
    const text = field(value, 64);
    return /^[0-9a-f-]{16,64}$/i.test(text) ? text : crypto.randomUUID();
}

function field(value, limit) {
    return clean(value).replace(/[\u0000-\u001f\u007f]/gu, '').slice(0, limit);
}

function clean(value) {
    return String(value ?? '').trim();
}

function integer(value, min, max, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function numericHeader(value) {
    return integer(value, 0, 100_000_000, null);
}

function json(payload, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(payload), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

export const __test = { buildEvent, sanitizeEvent, safeReferer, encodeCursor, decodeCursor };
