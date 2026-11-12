import { assertCsrf, assertSameOrigin, requireSession } from './reuse.js';

const ACCESS_TOKEN_SECONDS = 30 * 60;
const ACCESS_CREDENTIAL_VERSION = 'v1';
const MAX_BODY_BYTES = 32 * 1024;
const JSON_HEADERS = Object.freeze({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
});

class SurveyError extends Error {
    constructor(status, publicMessage, code) {
        super(publicMessage);
        this.status = status;
        this.publicMessage = publicMessage;
        this.code = code;
    }
}

export async function handleSurveyRequest(request, rawEnv) {
    const pathname = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    if (pathname !== '/api/survey' && !pathname.startsWith('/api/survey/')) return null;
    const env = normalizeEnvironment(rawEnv);
    try {
        if (pathname === '/api/survey/status') {
            assertMethod(request, 'GET');
            return await surveyStatus(request, env);
        }
        if (pathname === '/api/survey/access') {
            assertMethod(request, 'POST');
            return await surveyAccess(request, env);
        }
        if (pathname === '/api/survey/google-submit') {
            assertMethod(request, 'POST');
            return await googleSubmission(request, env);
        }
        throw new SurveyError(404, '指定されたAPIはありません。', 'not_found');
    } catch (error) {
        return surveyErrorResponse(error);
    }
}

async function surveyStatus(request, env) {
    await ensureSurveyDatabase(env);
    const session = await requireSession(request, env);
    const participant = await findOrCreateParticipant(env, session.discord_user_id);
    const response = await env.REUSE_DB.prepare(
        'SELECT response_id, submitted_at, updated_at FROM survey_responses WHERE participant_uuid = ?',
    ).bind(participant.participant_uuid).first();
    return jsonResponse({
        success: true,
        authenticated: true,
        user: { username: session.discord_username, avatar: session.discord_avatar || null },
        csrfToken: session.csrf_token,
        participantUuid: participant.participant_uuid,
        answered: Boolean(response),
        editable: Boolean(response),
        submittedAt: response?.submitted_at || null,
        updatedAt: response?.updated_at || null,
    });
}

async function surveyAccess(request, env) {
    assertSurveyConfigured(env);
    assertSameOrigin(request);
    const session = await requireSession(request, env);
    assertCsrf(request, session);
    const participant = await findOrCreateParticipant(env, session.discord_user_id);
    const existing = await env.REUSE_DB.prepare(
        'SELECT response_id, edit_url_ciphertext FROM survey_responses WHERE participant_uuid = ?',
    ).bind(participant.participant_uuid).first();

    if (existing?.edit_url_ciphertext) {
        return jsonResponse({
            success: true,
            mode: 'edit',
            url: await decryptValue(existing.edit_url_ciphertext, env.SURVEY_DATA_SECRET),
        });
    }

    const accessToken = randomToken(32);
    const now = Date.now();
    await env.REUSE_DB.batch([
        env.REUSE_DB.prepare(
            `INSERT INTO survey_access_tokens
                (token_hash, participant_uuid, created_at, expires_at)
             VALUES (?, ?, ?, ?)`,
        ).bind(await sha256(accessToken), participant.participant_uuid, now, now + ACCESS_TOKEN_SECONDS * 1000),
        env.REUSE_DB.prepare('DELETE FROM survey_access_tokens WHERE expires_at < ?').bind(now - 24 * 60 * 60 * 1000),
    ]);

    const formUrl = validatedFormUrl(env.SURVEY_FORM_URL);
    formUrl.searchParams.set('usp', 'pp_url');
    const accessCredential = `${ACCESS_CREDENTIAL_VERSION}.${participant.participant_uuid}.${accessToken}`;
    formUrl.searchParams.set(`entry.${digits(env.SURVEY_TOKEN_ENTRY_ID, 'トークン項目ID')}`, accessCredential);
    return jsonResponse({ success: true, mode: 'new', url: formUrl.toString(), expiresIn: ACCESS_TOKEN_SECONDS });
}

async function googleSubmission(request, env) {
    assertSurveyConfigured(env);
    const rawBody = await readBody(request);
    await verifyGoogleSignature(request, rawBody, env.SURVEY_SUBMISSION_SECRET);
    let input;
    try { input = JSON.parse(rawBody); } catch { throw new SurveyError(400, '送信内容を読み取れません。', 'invalid_json'); }

    const { participantUuid, accessToken } = parseAccessCredential(input.accessToken, input.participantUuid);
    const responseId = bounded(input.responseId, 1, 200, '回答ID');
    const editUrl = validatedEditUrl(input.editUrl).toString();
    const tokenHash = await sha256(accessToken);
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const [participant, token, existing] = await Promise.all([
        env.REUSE_DB.prepare('SELECT participant_uuid FROM survey_participants WHERE participant_uuid = ? AND active = 1')
            .bind(participantUuid).first(),
        env.REUSE_DB.prepare('SELECT * FROM survey_access_tokens WHERE token_hash = ? AND participant_uuid = ?')
            .bind(tokenHash, participantUuid).first(),
        env.REUSE_DB.prepare('SELECT response_id FROM survey_responses WHERE participant_uuid = ?')
            .bind(participantUuid).first(),
    ]);
    if (!participant) throw new SurveyError(403, '登録されていないUUIDです。', 'unknown_uuid');

    const firstSubmission = token && !token.used_at && Number(token.expires_at) >= nowMs;
    const validEdit = token && token.used_at && existing?.response_id === responseId && token.response_id === responseId;
    if (!firstSubmission && !validEdit) {
        throw new SurveyError(403, '回答トークンが無効または期限切れです。', 'invalid_access_token');
    }

    const encryptedEditUrl = await encryptValue(editUrl, env.SURVEY_DATA_SECRET);
    const submittedAt = firstSubmission ? now : (bounded(input.submittedAt || now, 1, 100, '送信日時'));
    await env.REUSE_DB.batch([
        env.REUSE_DB.prepare(
            `INSERT INTO survey_responses
                (participant_uuid, response_id, edit_url_ciphertext, submitted_at, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(participant_uuid) DO UPDATE SET
                response_id = excluded.response_id,
                edit_url_ciphertext = excluded.edit_url_ciphertext,
                updated_at = excluded.updated_at`,
        ).bind(participantUuid, responseId, encryptedEditUrl, submittedAt, now),
        env.REUSE_DB.prepare(
            `UPDATE survey_access_tokens SET used_at = COALESCE(used_at, ?), response_id = ?
             WHERE token_hash = ? AND participant_uuid = ?`,
        ).bind(nowMs, responseId, tokenHash, participantUuid),
    ]);
    return jsonResponse({ success: true, accepted: true, mode: firstSubmission ? 'new' : 'edit' });
}

async function findOrCreateParticipant(env, discordUserId) {
    let participant = await env.REUSE_DB.prepare(
        'SELECT participant_uuid, active FROM survey_participants WHERE discord_user_id = ?',
    ).bind(discordUserId).first();
    if (participant && Number(participant.active) !== 1) {
        throw new SurveyError(403, 'このアカウントではアンケートに回答できません。', 'participant_inactive');
    }
    if (participant) return participant;
    const participantUuid = crypto.randomUUID();
    const now = new Date().toISOString();
    await env.REUSE_DB.prepare(
        `INSERT OR IGNORE INTO survey_participants
            (discord_user_id, participant_uuid, active, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?)`,
    ).bind(discordUserId, participantUuid, now, now).run();
    participant = await env.REUSE_DB.prepare(
        'SELECT participant_uuid, active FROM survey_participants WHERE discord_user_id = ?',
    ).bind(discordUserId).first();
    if (!participant) throw new SurveyError(503, '回答者UUIDを発行できませんでした。', 'uuid_issue_failed');
    return participant;
}

function assertSurveyDatabase(env) {
    if (!env.REUSE_DB) throw new SurveyError(503, 'アンケート用データベースが設定されていません。', 'database_not_configured');
}

async function ensureSurveyDatabase(env) {
    assertSurveyDatabase(env);
    try {
        await env.REUSE_DB.prepare('SELECT participant_uuid FROM survey_participants LIMIT 1').first();
    } catch {
        throw new SurveyError(503, 'アンケート用データベースの準備が完了していません。', 'database_schema_missing');
    }
}

function assertSurveyConfigured(env) {
    assertSurveyDatabase(env);
    const missing = [
        ['SURVEY_FORM_URL', env.SURVEY_FORM_URL],
        ['SURVEY_TOKEN_ENTRY_ID', env.SURVEY_TOKEN_ENTRY_ID],
        ['SURVEY_SUBMISSION_SECRET', env.SURVEY_SUBMISSION_SECRET],
        ['SURVEY_DATA_SECRET', env.SURVEY_DATA_SECRET],
    ].filter(([, value]) => !String(value || '').trim()).map(([name]) => name);
    if (missing.length) {
        console.error('Survey configuration is incomplete', { missing });
        throw new SurveyError(503, 'アンケートは現在準備中です。', 'service_not_configured');
    }
}

function normalizeEnvironment(env) {
    if (env.REUSE_DB || (!env.NEWSLETTER_DB && !env.IP_BLOCK_DB)) return env;
    const normalized = Object.create(env);
    normalized.REUSE_DB = env.NEWSLETTER_DB || env.IP_BLOCK_DB;
    return normalized;
}

function assertMethod(request, expected) {
    if (request.method !== expected) throw new SurveyError(405, '許可されていない操作です。', 'method_not_allowed');
}

async function readBody(request) {
    const type = request.headers.get('content-type') || '';
    if (!type.toLowerCase().startsWith('application/json')) throw new SurveyError(415, '送信形式が正しくありません。', 'invalid_content_type');
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) throw new SurveyError(413, '送信データが大きすぎます。', 'request_too_large');
    return body;
}

async function verifyGoogleSignature(request, body, secret) {
    const timestamp = request.headers.get('x-survey-timestamp') || '';
    const provided = request.headers.get('x-survey-signature') || '';
    const epoch = Number(timestamp);
    if (!Number.isInteger(epoch) || Math.abs(Date.now() - epoch) > 5 * 60 * 1000) {
        throw new SurveyError(401, '署名の有効時間が切れています。', 'expired_signature');
    }
    const expected = await hmacHex(secret, `${timestamp}.${body}`);
    if (!timingSafeEqual(provided, expected)) throw new SurveyError(401, '署名を確認できません。', 'invalid_signature');
}

function validatedFormUrl(value) {
    let url;
    try { url = new URL(String(value || '')); } catch { throw new SurveyError(503, 'Googleフォームの設定が不正です。', 'invalid_form_url'); }
    if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com' || !url.pathname.startsWith('/forms/')) {
        throw new SurveyError(503, 'Googleフォームの設定が不正です。', 'invalid_form_url');
    }
    return url;
}

function validatedEditUrl(value) {
    const url = validatedFormUrl(value);
    if (!url.pathname.includes('/edit') && !url.searchParams.has('edit2')) {
        throw new SurveyError(400, '回答編集URLが不正です。', 'invalid_edit_url');
    }
    return url;
}

function digits(value, label) {
    const text = String(value || '').trim();
    if (!/^\d{1,20}$/u.test(text)) throw new SurveyError(503, `${label}の設定が不正です。`, 'invalid_entry_id');
    return text;
}

function uuid(value) {
    const text = String(value || '').trim().toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(text)) {
        throw new SurveyError(400, '回答者UUIDが不正です。', 'invalid_uuid');
    }
    return text;
}

function parseAccessCredential(value, legacyParticipantUuid = '') {
    const credential = bounded(value, 40, 260, '回答トークン');
    if (String(legacyParticipantUuid || '').trim()) {
        return { participantUuid: uuid(legacyParticipantUuid), accessToken: credential, legacy: true };
    }
    const [version, participantUuidText, accessToken, ...extra] = credential.split('.');
    if (version !== ACCESS_CREDENTIAL_VERSION || !participantUuidText || !accessToken || extra.length) {
        throw new SurveyError(400, '回答トークンが不正です。', 'invalid_access_credential');
    }
    if (!/^[A-Za-z0-9_-]{40,200}$/u.test(accessToken)) {
        throw new SurveyError(400, '回答トークンが不正です。', 'invalid_access_credential');
    }
    return { participantUuid: uuid(participantUuidText), accessToken, legacy: false };
}

function bounded(value, min, max, label) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text.length < min || text.length > max) throw new SurveyError(400, `${label}が不正です。`, 'invalid_value');
    return text;
}

async function encryptValue(value, secret) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await aesKey(secret, ['encrypt']);
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
    return `${base64Url(iv)}.${base64Url(new Uint8Array(cipher))}`;
}

async function decryptValue(value, secret) {
    const [ivText, cipherText] = String(value || '').split('.');
    if (!ivText || !cipherText) throw new SurveyError(500, '回答編集情報を読み取れません。', 'edit_url_unavailable');
    try {
        const key = await aesKey(secret, ['decrypt']);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(ivText) }, key, fromBase64Url(cipherText));
        return validatedEditUrl(new TextDecoder().decode(plain)).toString();
    } catch (error) {
        if (error instanceof SurveyError) throw error;
        throw new SurveyError(500, '回答編集情報を読み取れません。', 'edit_url_unavailable');
    }
}

async function aesKey(secret, usages) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
    return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, usages);
}

async function sha256(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacHex(secret, value) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
    return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(left, right) {
    const a = new TextEncoder().encode(String(left || ''));
    const b = new TextEncoder().encode(String(right || ''));
    let different = a.length ^ b.length;
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) different |= (a[index] || 0) ^ (b[index] || 0);
    return different === 0;
}

function randomToken(bytes) {
    return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function base64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(value) {
    const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function surveyErrorResponse(error) {
    if (Number.isInteger(error?.status)) {
        return jsonResponse({ success: false, message: error.publicMessage || error.message, code: error.code || 'request_failed' }, error.status);
    }
    console.error('Survey processing failed', { errorName: error?.name || 'Error', errorCode: error?.code || 'unknown' });
    return jsonResponse({ success: false, message: '処理に失敗しました。時間をおいて再度お試しください。', code: 'internal_error' }, 500);
}

export const __test = Object.freeze({
    decryptValue,
    encryptValue,
    parseAccessCredential,
    timingSafeEqual,
    validatedEditUrl,
    validatedFormUrl,
});
