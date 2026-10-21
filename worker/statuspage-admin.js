import { AccessAuthError, authenticateNewsletterAdmin } from './access.js';

const API_ROOT = '/site/status-admin/api';
const STATUSPAGE_ORIGIN = 'https://api.statuspage.io';
const JSON_HEADERS = Object.freeze({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
});
const INCIDENT_STATUSES = new Set(['investigating', 'identified', 'monitoring', 'resolved']);
const MAINTENANCE_STATUSES = new Set(['scheduled', 'in_progress', 'verifying', 'completed']);
const COMPONENT_STATUSES = new Set(['operational', 'degraded_performance', 'partial_outage', 'major_outage', 'under_maintenance']);
const IMPACTS = new Set(['none', 'minor', 'major', 'critical']);
const ID_PATTERN = /^[a-z0-9]{6,40}$/u;

class StatuspageAdminError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.publicMessage = message;
        this.code = code;
    }
}

export async function handleStatuspageAdminRequest(request, env) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (pathname !== API_ROOT && !pathname.startsWith(`${API_ROOT}/`)) return null;

    try {
        const admin = await authenticateNewsletterAdmin(request, env);
        if (pathname === `${API_ROOT}/summary`) {
            requireMethod(request, 'GET');
            return jsonResponse(await loadStatuspageSummary(env, admin));
        }

        assertMutationRequest(request);
        if (pathname === `${API_ROOT}/incidents`) {
            requireMethod(request, 'POST');
            return jsonResponse(await createIncident(request, env, admin, false), 201);
        }
        if (pathname === `${API_ROOT}/maintenances`) {
            requireMethod(request, 'POST');
            return jsonResponse(await createIncident(request, env, admin, true), 201);
        }

        const incidentMatch = pathname.match(new RegExp(`^${API_ROOT}/(incidents|maintenances)/([a-z0-9]{6,40})$`, 'u'));
        if (incidentMatch) {
            const isMaintenance = incidentMatch[1] === 'maintenances';
            const incidentId = incidentMatch[2];
            if (request.method === 'PUT') return jsonResponse(await updateIncident(request, env, admin, incidentId, isMaintenance));
            if (request.method === 'DELETE') return jsonResponse(await deleteIncident(request, env, admin, incidentId, isMaintenance));
            return jsonResponse({ success: false, message: '許可されていない操作です。' }, 405, { Allow: 'PUT, DELETE' });
        }

        const componentMatch = pathname.match(new RegExp(`^${API_ROOT}/components/([a-z0-9]{6,40})$`, 'u'));
        if (componentMatch) {
            requireMethod(request, 'PUT');
            return jsonResponse(await updateComponent(request, env, admin, componentMatch[1]));
        }
        throw new StatuspageAdminError(404, '指定されたStatuspage管理APIはありません。', 'not_found');
    } catch (error) {
        const status = Number(error?.status) || 500;
        const message = error instanceof AccessAuthError || error instanceof StatuspageAdminError
            ? error.publicMessage
            : 'Statuspage管理処理を実行できませんでした。';
        if (!(error instanceof AccessAuthError) && !(error instanceof StatuspageAdminError)) {
            console.error('Statuspage admin request failed', { errorName: error?.name || 'Error' });
        }
        return jsonResponse({ success: false, message, code: error?.code || 'internal_error' }, status);
    }
}

async function loadStatuspageSummary(env, admin) {
    const config = statuspageConfig(env, false);
    if (!config.configured) {
        return {
            success: true,
            configured: false,
            admin: admin.email,
            pageUrl: config.pageUrl,
            message: 'STATUSPAGE_API_KEYをCloudflare WorkerのSecretへ設定してください。',
            components: [], incidents: [], maintenances: [],
        };
    }
    const [components, incidents, maintenances] = await Promise.all([
        statuspageFetch(config, '/components?page=1&per_page=100'),
        statuspageFetch(config, '/incidents?page=1&per_page=100'),
        statuspageFetch(config, '/incidents/scheduled?page=1&per_page=100'),
    ]);
    const scheduledIds = new Set((maintenances || []).map((item) => clean(item.id, 40)));
    return {
        success: true,
        configured: true,
        admin: admin.email,
        pageUrl: config.pageUrl,
        fetchedAt: new Date().toISOString(),
        components: (components || []).map(publicComponent),
        incidents: (incidents || []).filter((item) => !scheduledIds.has(clean(item.id, 40)) && !item.scheduled_for).map(publicIncident),
        maintenances: (maintenances || []).map(publicIncident),
    };
}

async function createIncident(request, env, admin, isMaintenance) {
    const config = statuspageConfig(env, true);
    const input = await readJson(request);
    const incident = validateIncident(input, isMaintenance, null);
    requireConfirmation(input.confirmation, isMaintenance ? 'CREATE MAINTENANCE' : 'CREATE INCIDENT');
    const created = await statuspageFetch(config, '/incidents', { method: 'POST', body: { incident } });
    await writeAudit(env, admin.email, isMaintenance ? 'statuspage.maintenance.create' : 'statuspage.incident.create', created?.id, {
        status: incident.status, componentCount: incident.component_ids.length, deliverNotifications: incident.deliver_notifications,
    });
    return { success: true, message: isMaintenance ? 'メンテナンスを作成しました。' : 'インシデントを作成しました。', item: publicIncident(created) };
}

async function updateIncident(request, env, admin, incidentId, isMaintenance) {
    const config = statuspageConfig(env, true);
    const input = await readJson(request);
    const incident = validateIncident(input, isMaintenance, incidentId);
    requireConfirmation(input.confirmation, `UPDATE:${incidentId}`);
    const updated = await statuspageFetch(config, `/incidents/${incidentId}`, { method: 'PUT', body: { incident } });
    await writeAudit(env, admin.email, isMaintenance ? 'statuspage.maintenance.update' : 'statuspage.incident.update', incidentId, {
        status: incident.status, componentCount: incident.component_ids.length, deliverNotifications: incident.deliver_notifications,
    });
    return { success: true, message: isMaintenance ? 'メンテナンスを更新しました。' : 'インシデントを更新しました。', item: publicIncident(updated) };
}

async function deleteIncident(request, env, admin, incidentId, isMaintenance) {
    const config = statuspageConfig(env, true);
    const input = await readJson(request);
    requireConfirmation(input.confirmation, `DELETE:${incidentId}`);
    await statuspageFetch(config, `/incidents/${incidentId}`, { method: 'DELETE' });
    await writeAudit(env, admin.email, isMaintenance ? 'statuspage.maintenance.delete' : 'statuspage.incident.delete', incidentId, {});
    return { success: true, message: isMaintenance ? 'メンテナンスを削除しました。' : 'インシデントを削除しました。' };
}

async function updateComponent(request, env, admin, componentId) {
    const config = statuspageConfig(env, true);
    const input = await readJson(request);
    const status = clean(input.status, 40);
    if (!COMPONENT_STATUSES.has(status)) throw new StatuspageAdminError(400, '稼働状況を選択してください。', 'invalid_component_status');
    requireConfirmation(input.confirmation, `COMPONENT:${componentId}:${status}`);
    const component = await statuspageFetch(config, `/components/${componentId}`, { method: 'PUT', body: { component: { status } } });
    await writeAudit(env, admin.email, 'statuspage.component.update', componentId, { status });
    return { success: true, message: 'コンポーネントの稼働状況を更新しました。', item: publicComponent(component) };
}

function validateIncident(input, isMaintenance, incidentId) {
    const name = clean(input.name, 200);
    const body = clean(input.body, 2_000);
    const status = clean(input.status, 40);
    const impact = clean(input.impact, 20) || 'none';
    if (name.length < 2) throw new StatuspageAdminError(400, '名称は2文字以上で入力してください。', 'invalid_name');
    if (!body) throw new StatuspageAdminError(400, '更新内容を入力してください。', 'invalid_body');
    if (!(isMaintenance ? MAINTENANCE_STATUSES : INCIDENT_STATUSES).has(status)) {
        throw new StatuspageAdminError(400, 'ステータスを選択してください。', 'invalid_status');
    }
    if (!IMPACTS.has(impact)) throw new StatuspageAdminError(400, '影響度を選択してください。', 'invalid_impact');
    const componentIds = uniqueIds(input.componentIds);
    const componentStatus = clean(input.componentStatus, 40) || (isMaintenance ? 'under_maintenance' : 'degraded_performance');
    if (!COMPONENT_STATUSES.has(componentStatus)) throw new StatuspageAdminError(400, '対象コンポーネントの状態を選択してください。', 'invalid_component_status');
    const incident = {
        name,
        status,
        body,
        impact_override: impact,
        deliver_notifications: input.notify === true,
        component_ids: componentIds,
    };
    // Statuspage applies the `components` status map immediately, even when the
    // incident itself is only scheduled. Keep the component association via
    // `component_ids`; Statuspage's auto-transition changes it at the start.
    // An explicitly in-progress maintenance (and every normal incident) may
    // still update the selected components immediately.
    if (!isMaintenance || status !== 'scheduled') {
        incident.components = Object.fromEntries(componentIds.map((id) => [id, componentStatus]));
    }
    if (isMaintenance) {
        const scheduledFor = isoDate(input.scheduledFor, '開始日時');
        const scheduledUntil = isoDate(input.scheduledUntil, '終了日時');
        if (new Date(scheduledUntil).getTime() <= new Date(scheduledFor).getTime()) {
            throw new StatuspageAdminError(400, '終了日時は開始日時より後にしてください。', 'invalid_schedule');
        }
        Object.assign(incident, {
            scheduled_for: scheduledFor,
            scheduled_until: scheduledUntil,
            scheduled_remind_prior: input.remindPrior === true,
            scheduled_auto_in_progress: input.autoStart === true,
            scheduled_auto_completed: input.autoComplete === true,
            auto_transition_to_maintenance_state: input.autoComponentMaintenance === true,
            auto_transition_to_operational_state: input.autoComponentOperational === true,
            auto_transition_deliver_notifications_at_start: input.notifyAtStart === true,
            auto_transition_deliver_notifications_at_end: input.notifyAtEnd === true,
        });
    }
    if (incidentId && !ID_PATTERN.test(incidentId)) throw new StatuspageAdminError(400, 'IDが不正です。', 'invalid_id');
    return incident;
}

async function statuspageFetch(config, path, options = {}) {
    const url = new URL(`/v1/pages/${config.pageId}${path}`, STATUSPAGE_ORIGIN);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
        const response = await fetch(url, {
            method: options.method || 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: `OAuth ${config.apiKey}`,
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: controller.signal,
        });
        const result = response.status === 204 ? null : await response.json().catch(() => ({}));
        if (!response.ok) {
            const message = response.status === 429
                ? 'Statuspage APIの利用上限に達しました。時間をおいて再実行してください。'
                : `Statuspage APIでエラーが発生しました（HTTP ${response.status}）。`;
            throw new StatuspageAdminError(response.status >= 400 && response.status < 500 ? response.status : 502, message, 'statuspage_api_error');
        }
        return result;
    } catch (error) {
        if (error instanceof StatuspageAdminError) throw error;
        throw new StatuspageAdminError(502, error?.name === 'AbortError' ? 'Statuspage APIがタイムアウトしました。' : 'Statuspage APIへ接続できませんでした。', 'statuspage_unavailable');
    } finally {
        clearTimeout(timeout);
    }
}

function statuspageConfig(env, required) {
    const pageId = clean(env.STATUSPAGE_PAGE_ID, 40);
    const apiKey = clean(env.STATUSPAGE_API_KEY, 500);
    const pageUrl = clean(env.STATUSPAGE_PUBLIC_URL, 300) || 'https://coffeebousai.statuspage.io/';
    const configured = ID_PATTERN.test(pageId) && Boolean(apiKey);
    if (required && !configured) throw new StatuspageAdminError(503, 'Statuspage API連携が未設定です。', 'statuspage_not_configured');
    return { pageId, apiKey, pageUrl, configured };
}

function publicComponent(item = {}) {
    return {
        id: clean(item.id, 40), name: clean(item.name, 200), description: clean(item.description, 1_000),
        status: clean(item.status, 40), groupId: clean(item.group_id, 40) || null, group: item.group === true,
        position: Number(item.position || 0), updatedAt: clean(item.updated_at, 80),
    };
}

function publicIncident(item = {}) {
    const latest = Array.isArray(item.incident_updates) ? item.incident_updates[0] : null;
    return {
        id: clean(item.id, 40), name: clean(item.name, 200), status: clean(item.status, 40),
        impact: clean(item.impact, 20), impactOverride: clean(item.impact_override, 20),
        body: clean(latest?.body || item.body, 2_000), componentIds: (item.components || []).map((component) => clean(component.id, 40)).filter(Boolean),
        createdAt: clean(item.created_at, 80), updatedAt: clean(item.updated_at, 80),
        scheduledFor: clean(item.scheduled_for, 80) || null, scheduledUntil: clean(item.scheduled_until, 80) || null,
        remindPrior: item.scheduled_remind_prior === true,
        autoStart: item.scheduled_auto_in_progress === true,
        autoComplete: item.scheduled_auto_completed === true,
        autoComponentMaintenance: item.auto_transition_to_maintenance_state === true,
        autoComponentOperational: item.auto_transition_to_operational_state === true,
        notifyAtStart: item.auto_transition_deliver_notifications_at_start === true,
        notifyAtEnd: item.auto_transition_deliver_notifications_at_end === true,
        shortlink: clean(item.shortlink, 300) || null,
    };
}

function uniqueIds(value) {
    if (!Array.isArray(value)) return [];
    const ids = [...new Set(value.map((item) => clean(item, 40)).filter((item) => ID_PATTERN.test(item)))];
    if (ids.length > 100) throw new StatuspageAdminError(400, '対象コンポーネントが多すぎます。', 'too_many_components');
    return ids;
}

function isoDate(value, label) {
    const date = new Date(clean(value, 80));
    if (Number.isNaN(date.getTime())) throw new StatuspageAdminError(400, `${label}を入力してください。`, 'invalid_datetime');
    return date.toISOString();
}

function requireMethod(request, method) {
    if (request.method !== method) throw new StatuspageAdminError(405, '許可されていない操作です。', 'method_not_allowed');
}

function assertMutationRequest(request) {
    const requestUrl = new URL(request.url);
    const origin = clean(request.headers.get('origin'), 300);
    const fetchSite = clean(request.headers.get('sec-fetch-site'), 40);
    if ((origin && origin !== requestUrl.origin) || fetchSite === 'cross-site') throw new StatuspageAdminError(403, '別サイトからの管理操作は許可されていません。', 'invalid_origin');
    if (!clean(request.headers.get('content-type'), 100).toLowerCase().startsWith('application/json')) throw new StatuspageAdminError(415, 'JSON形式で送信してください。', 'invalid_content_type');
}

async function readJson(request) {
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > 64_000) throw new StatuspageAdminError(413, '送信内容が大きすぎます。', 'payload_too_large');
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 64_000) throw new StatuspageAdminError(413, '送信内容が大きすぎます。', 'payload_too_large');
    try {
        const body = JSON.parse(text);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid');
        return body;
    } catch {
        throw new StatuspageAdminError(400, 'JSON形式を確認してください。', 'invalid_json');
    }
}

function requireConfirmation(actual, expected) {
    if (clean(actual, 100) !== expected) throw new StatuspageAdminError(400, `確認入力「${expected}」が必要です。`, 'confirmation_required');
}

async function writeAudit(env, actor, action, entityId, details) {
    const database = env.NEWSLETTER_DB || env.REUSE_DB || env.IP_BLOCK_DB;
    if (!database) return;
    try {
        await database.prepare(`INSERT INTO admin_audit_events
            (id, actor, action, entity_type, entity_id, details_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .bind(crypto.randomUUID(), actor, action, 'statuspage', entityId || null,
                JSON.stringify(details).slice(0, 8_000), new Date().toISOString()).run();
    } catch (error) {
        console.error('Statuspage audit write failed', { action, errorName: error?.name || 'Error' });
    }
}

function clean(value, limit = 1_000) {
    return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extraHeaders } });
}

export const __test = Object.freeze({ validateIncident, publicComponent, publicIncident });
