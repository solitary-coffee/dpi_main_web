import { AccessAuthError, authenticateNewsletterAdmin } from './access.js';
import { DELIVERY_CATALOG, DELIVERY_TYPES } from './delivery-catalog.js';

const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';
const DISCORD_TOKEN = 'https://discord.com/api/v10/oauth2/token';
const SESSION_SECONDS = 30 * 60;
const OAUTH_STATE_SECONDS = 10 * 60;
const MAX_JSON_BYTES = 32 * 1024;
const APPLICATION_RATE_LIMIT = 5;
const APPLICATION_RATE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const MANAGE_GUILD = 1n << 5n;
const ADMINISTRATOR = 1n << 3n;

const STATUS_LABELS = Object.freeze({
    pending: '審査中',
    approved: '許可',
    rejected: '却下',
    changes_requested: '不備・再申請待ち',
});

const JSON_HEADERS = Object.freeze({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
});

class ReuseError extends Error {
    constructor(status, publicMessage, code) {
        super(publicMessage);
        this.name = 'ReuseError';
        this.status = status;
        this.publicMessage = publicMessage;
        this.code = code;
    }
}

export async function handleReuseRequest(request, env) {
    // Git連携デプロイで新しい別名bindingの反映が遅れた場合も、同じD1を指す
    // 既存bindingを利用して申請機能を継続できるようにする。
    env = normalizeReuseEnvironment(env);
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const isPublicApi = pathname === '/api/reuse' || pathname.startsWith('/api/reuse/');
    const isAdminApi = pathname === '/site/reuse-admin/api'
        || pathname.startsWith('/site/reuse-admin/api/');
    const isAdminAsset = !isAdminApi
        && (pathname === '/site/reuse-admin' || pathname.startsWith('/site/reuse-admin/'));

    if (!isPublicApi && !isAdminApi && !isAdminAsset) return null;

    try {
        if (isAdminAsset) return handleProtectedAdminAsset(request, env);
        if (isAdminApi) return handleAdminApi(request, env, pathname);

        if (pathname === '/api/reuse/config') {
            assertMethod(request, ['GET']);
            return reuseConfig(env);
        }
        if (pathname === '/api/reuse/oauth/start') {
            assertMethod(request, ['GET']);
            return startDiscordOAuth(request, env);
        }
        if (pathname === '/api/reuse/oauth/callback') {
            assertMethod(request, ['GET']);
            return completeDiscordOAuth(request, env);
        }
        if (pathname === '/api/reuse/session') {
            assertMethod(request, ['GET']);
            return sessionDetails(request, env);
        }
        if (pathname === '/api/reuse/logout') {
            assertMethod(request, ['POST']);
            assertSameOrigin(request);
            return logout(request, env);
        }
        if (pathname === '/api/reuse/channels') {
            assertMethod(request, ['GET']);
            return guildChannels(request, env);
        }
        if (pathname === '/api/reuse/applications') {
            assertMethod(request, ['POST']);
            assertSameOrigin(request);
            return createApplication(request, env);
        }
        if (pathname === '/api/reuse/manage') {
            assertMethod(request, ['GET', 'PUT']);
            if (request.method === 'PUT') assertSameOrigin(request);
            return request.method === 'GET'
                ? managedApplication(request, env)
                : resubmitApplication(request, env);
        }
        throw new ReuseError(404, '指定されたAPIはありません。', 'not_found');
    } catch (error) {
        return reuseErrorResponse(error);
    }
}

function reuseConfig(env) {
    const missing = publicConfigurationMissing(env);
    return jsonResponse({
        success: true,
        configured: missing.length === 0,
        configuration: {
            database: Boolean(env.REUSE_DB),
            discord: Boolean(
                clean(env.DISCORD_CLIENT_ID)
                && clean(env.DISCORD_CLIENT_SECRET)
                && clean(env.DISCORD_BOT_TOKEN)
            ),
            session: Boolean(clean(env.REUSE_SESSION_SECRET)),
            email: Boolean(env.NOTICE_EMAIL && clean(env.NOTICE_FROM_EMAIL)),
        },
        loginUrl: '/api/reuse/oauth/start',
        deliveryTypes: DELIVERY_CATALOG,
    });
}

async function startDiscordOAuth(request, env) {
    assertPublicConfigured(env);
    await ensureDatabase(env);

    const state = randomToken(32);
    const stateHash = await sha256(state);
    const now = Date.now();
    await env.REUSE_DB.batch([
        env.REUSE_DB.prepare(
            'INSERT INTO reuse_oauth_states (state_hash, created_at, expires_at) VALUES (?, ?, ?)',
        ).bind(stateHash, now, now + OAUTH_STATE_SECONDS * 1_000),
        env.REUSE_DB.prepare('DELETE FROM reuse_oauth_states WHERE expires_at < ?').bind(now),
        env.REUSE_DB.prepare('DELETE FROM reuse_sessions WHERE expires_at < ?').bind(now),
    ]);

    const authorizeUrl = new URL(DISCORD_AUTHORIZE);
    authorizeUrl.searchParams.set('client_id', clean(env.DISCORD_CLIENT_ID));
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('redirect_uri', oauthRedirectUri(request, env));
    authorizeUrl.searchParams.set('scope', 'identify guilds');
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('prompt', 'consent');

    return new Response(null, {
        status: 302,
        headers: {
            Location: authorizeUrl.toString(),
            'Cache-Control': 'no-store',
            'Set-Cookie': cookie('dpi_reuse_oauth', state, OAUTH_STATE_SECONDS),
            'Referrer-Policy': 'no-referrer',
        },
    });
}

async function completeDiscordOAuth(request, env) {
    assertPublicConfigured(env);
    await ensureDatabase(env);
    const url = new URL(request.url);
    const code = stringValue(url.searchParams.get('code'));
    const state = stringValue(url.searchParams.get('state'));
    const cookieState = readCookie(request, 'dpi_reuse_oauth');

    if (url.searchParams.get('error')) {
        return redirectToReuse('discord_denied', clearCookie('dpi_reuse_oauth'));
    }
    if (!code || code.length > 512 || !state || !timingSafeEqual(state, cookieState)) {
        throw new ReuseError(400, 'Discord認証の状態を確認できません。最初からやり直してください。', 'invalid_oauth_state');
    }

    const stateHash = await sha256(state);
    const storedState = await env.REUSE_DB.prepare(
        'SELECT state_hash FROM reuse_oauth_states WHERE state_hash = ? AND expires_at >= ?',
    ).bind(stateHash, Date.now()).first();
    if (!storedState) {
        throw new ReuseError(400, 'Discord認証の有効時間が切れました。最初からやり直してください。', 'expired_oauth_state');
    }
    await env.REUSE_DB.prepare('DELETE FROM reuse_oauth_states WHERE state_hash = ?').bind(stateHash).run();

    const tokenBody = new URLSearchParams({
        client_id: clean(env.DISCORD_CLIENT_ID),
        client_secret: clean(env.DISCORD_CLIENT_SECRET),
        grant_type: 'authorization_code',
        code,
        redirect_uri: oauthRedirectUri(request, env),
    });
    const tokenResponse = await fetch(DISCORD_TOKEN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenBody,
    });
    if (!tokenResponse.ok) throw new ReuseError(502, 'Discord認証に失敗しました。', 'discord_token_failed');
    const token = await tokenResponse.json();
    if (!token?.access_token) throw new ReuseError(502, 'Discord認証の応答が不正です。', 'discord_token_invalid');

    const authorization = `${token.token_type || 'Bearer'} ${token.access_token}`;
    const [userResponse, guildsResponse] = await Promise.all([
        discordFetch('/users/@me', authorization),
        discordFetch('/users/@me/guilds', authorization),
    ]);
    const user = await userResponse.json();
    const guilds = (await guildsResponse.json())
        .filter(canManageGuild)
        .slice(0, 200)
        .map((guild) => ({
            id: stringValue(guild.id),
            name: stringValue(guild.name).slice(0, 100),
            icon: stringValue(guild.icon),
            owner: guild.owner === true,
            permissions: stringValue(guild.permissions),
        }));
    if (!snowflake(user?.id) || !stringValue(user?.username)) {
        throw new ReuseError(502, 'Discordアカウント情報を取得できませんでした。', 'discord_user_invalid');
    }

    const rawSession = randomToken(32);
    const csrfToken = randomToken(24);
    const now = Date.now();
    await env.REUSE_DB.prepare(
        `INSERT INTO reuse_sessions
            (token_hash, discord_user_id, discord_username, discord_avatar, guilds_json,
             csrf_token, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
        await sha256(rawSession),
        user.id,
        discordDisplayName(user),
        stringValue(user.avatar),
        JSON.stringify(guilds),
        csrfToken,
        now,
        now + SESSION_SECONDS * 1_000,
    ).run();

    return redirectToReuse('connected', [
        clearCookie('dpi_reuse_oauth'),
        cookie('dpi_reuse_session', rawSession, SESSION_SECONDS),
    ]);
}

async function sessionDetails(request, env) {
    const rawToken = readCookie(request, 'dpi_reuse_session');
    if (!rawToken || rawToken.length > 200) {
        return jsonResponse({ success: true, authenticated: false });
    }

    await ensureDatabase(env);
    const session = await env.REUSE_DB.prepare(
        'SELECT * FROM reuse_sessions WHERE token_hash = ? AND expires_at >= ?',
    ).bind(await sha256(rawToken), Date.now()).first();
    if (!session) {
        return jsonResponse(
            { success: true, authenticated: false, reason: 'session_expired' },
            200,
            { 'Set-Cookie': clearCookie('dpi_reuse_session') },
        );
    }
    return jsonResponse({
        success: true,
        authenticated: true,
        user: {
            id: session.discord_user_id,
            username: session.discord_username,
            avatar: session.discord_avatar || null,
        },
        guilds: parseJsonArray(session.guilds_json),
        csrfToken: session.csrf_token,
        expiresAt: new Date(Number(session.expires_at)).toISOString(),
    });
}

async function logout(request, env) {
    assertDatabaseConfigured(env);
    const rawToken = readCookie(request, 'dpi_reuse_session');
    if (rawToken) {
        await env.REUSE_DB.prepare('DELETE FROM reuse_sessions WHERE token_hash = ?')
            .bind(await sha256(rawToken)).run();
    }
    return jsonResponse({ success: true }, 200, { 'Set-Cookie': clearCookie('dpi_reuse_session') });
}

async function guildChannels(request, env) {
    assertPublicConfigured(env);
    const session = await requireSession(request, env);
    const guildId = new URL(request.url).searchParams.get('guild_id') || '';
    const guild = findSessionGuild(session, guildId);
    if (!guild) throw new ReuseError(403, 'このサーバーを管理する権限を確認できません。', 'guild_not_allowed');

    const channels = await fetchGuildChannels(guildId, env);
    return jsonResponse({
        success: true,
        guild: { id: guild.id, name: guild.name },
        channels: channels.map((channel) => ({
            id: stringValue(channel.id),
            name: stringValue(channel.name).slice(0, 100),
            type: Number(channel.type),
            announcement: Number(channel.type) === 5,
            position: Number(channel.position || 0),
            parentId: stringValue(channel.parent_id) || null,
        })),
    });
}

async function createApplication(request, env) {
    assertPublicConfigured(env);
    const session = await requireSession(request, env);
    assertCsrf(request, session);
    const input = await readJson(request);
    const normalized = await validateApplicationInput(input, session, env);

    const remoteIp = request.headers.get('CF-Connecting-IP') || 'missing';
    const rateKey = await keyedHash(env.REUSE_SESSION_SECRET, `application:${remoteIp}`);
    const nowMs = Date.now();
    const recent = await env.REUSE_DB.prepare(
        `SELECT COUNT(*) AS count FROM reuse_rate_events
         WHERE key_hash = ? AND event_type = 'application' AND created_at >= ?`,
    ).bind(rateKey, nowMs - APPLICATION_RATE_WINDOW_MS).first();
    if (Number(recent?.count || 0) >= APPLICATION_RATE_LIMIT) {
        throw new ReuseError(429, '申請回数の上限に達しました。時間をおいてお試しください。', 'rate_limited');
    }

    const id = crypto.randomUUID();
    const reference = createReference();
    const manageToken = randomToken(32);
    const now = new Date().toISOString();
    await env.REUSE_DB.batch([
        env.REUSE_DB.prepare(
            `INSERT INTO reuse_applications (
                id, reference, status, revision, discord_user_id, discord_username,
                guild_id, guild_name, channel_id, channel_name, channel_type, delivery_types,
                channel_mappings,
                server_public, channel_visibility, announcement_automated, reuse_method,
                reuse_method_other, contact_email, purpose, destination_url, notes,
                created_at, updated_at, manage_token_hash
             ) VALUES (?, ?, 'pending', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
            id, reference, session.discord_user_id, session.discord_username,
            normalized.guild.id, normalized.guild.name,
            normalized.channel.id, normalized.channel.name, normalized.channel.type,
            JSON.stringify(normalized.deliveryTypes), JSON.stringify(normalized.channelMappings),
            normalized.serverPublic,
            normalized.channelVisibility, normalized.announcementAutomated,
            normalized.reuseMethod, normalized.reuseMethodOther, normalized.email,
            normalized.purpose, normalized.destinationUrl, normalized.notes,
            now, now, await sha256(manageToken),
        ),
        env.REUSE_DB.prepare(
            `INSERT INTO reuse_application_events
                (id, application_id, event_type, actor, message, created_at)
             VALUES (?, ?, 'submitted', ?, NULL, ?)`,
        ).bind(crypto.randomUUID(), id, `discord:${session.discord_user_id}`, now),
        env.REUSE_DB.prepare(
            `INSERT INTO reuse_rate_events (key_hash, event_type, created_at)
             VALUES (?, 'application', ?)`,
        ).bind(rateKey, nowMs),
        env.REUSE_DB.prepare('DELETE FROM reuse_rate_events WHERE created_at < ?')
            .bind(nowMs - 2 * APPLICATION_RATE_WINDOW_MS),
    ]);

    let emailSent = true;
    try {
        await sendReceiptEmail(env, {
            reference,
            email: normalized.email,
            guildName: normalized.guild.name,
            channelName: normalized.channel.name,
            channelMappings: normalized.channelMappings,
            manageToken,
        });
    } catch {
        // 申請はD1へ保存済みのため重複申請を避け、受付自体は成功として返す。
        emailSent = false;
    }
    return jsonResponse({ success: true, reference, manageToken, emailSent }, 201);
}

async function managedApplication(request, env) {
    assertDatabaseConfigured(env);
    const application = await findManagedApplication(request, env);
    return jsonResponse({ success: true, application: serializeApplication(application, false) });
}

async function resubmitApplication(request, env) {
    assertPublicConfigured(env);
    const existing = await findManagedApplication(request, env);
    if (existing.status !== 'changes_requested') {
        throw new ReuseError(409, 'この申請は再申請を受け付ける状態ではありません。', 'not_resubmittable');
    }
    const input = await readJson(request);
    const channelMappings = validateResubmittedChannelMappings(input.channelMappings, existing);
    const normalized = validateEditableApplicationInput({
        ...input,
        deliveryTypes: aggregateDeliveryTypes(channelMappings),
        channelType: channelMappings[0].channelType,
        announcement: channelMappings[0].announcement,
        announcementAutomated: channelMappings[0].announcementAutomated,
    }, existing);
    const now = new Date().toISOString();
    const revision = Number(existing.revision || 1) + 1;
    await env.REUSE_DB.batch([
        env.REUSE_DB.prepare(
            `UPDATE reuse_applications SET
                status = 'pending', revision = ?, delivery_types = ?, channel_mappings = ?, server_public = ?,
                channel_visibility = ?, announcement_automated = ?, reuse_method = ?,
                reuse_method_other = ?, contact_email = ?, purpose = ?, destination_url = ?,
                notes = ?, admin_message = NULL, reviewed_by = NULL, reviewed_at = NULL,
                resubmitted_at = ?, updated_at = ?
             WHERE id = ? AND status = 'changes_requested'`,
        ).bind(
            revision, JSON.stringify(normalized.deliveryTypes), JSON.stringify(channelMappings),
            normalized.serverPublic,
            normalized.channelVisibility, normalized.announcementAutomated,
            normalized.reuseMethod, normalized.reuseMethodOther, normalized.email,
            normalized.purpose, normalized.destinationUrl, normalized.notes,
            now, now, existing.id,
        ),
        env.REUSE_DB.prepare(
            `INSERT INTO reuse_application_events
                (id, application_id, event_type, actor, message, created_at)
             VALUES (?, ?, 'resubmitted', ?, NULL, ?)`,
        ).bind(crypto.randomUUID(), existing.id, `discord:${existing.discord_user_id}`, now),
    ]);
    let emailSent = true;
    try {
        await sendResubmittedEmail(env, { ...existing, ...normalized, revision });
    } catch {
        emailSent = false;
    }
    return jsonResponse({ success: true, reference: existing.reference, revision, emailSent });
}

async function handleProtectedAdminAsset(request, env) {
    if (!['GET', 'HEAD'].includes(request.method)) {
        throw new ReuseError(405, '許可されていない操作です。', 'method_not_allowed');
    }
    await authenticateNewsletterAdmin(request, env);
    const url = new URL(request.url);
    if (url.pathname === '/site/reuse-admin') {
        url.pathname = '/site/reuse-admin/';
        return new Response(null, { status: 308, headers: { Location: url.toString(), 'Cache-Control': 'no-store' } });
    }
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    if ((headers.get('content-type') || '').includes('text/html')) {
        headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleAdminApi(request, env, pathname) {
    const admin = await authenticateNewsletterAdmin(request, env);
    assertDatabaseConfigured(env);
    await ensureDatabase(env);

    if (pathname === '/site/reuse-admin/api/applications') {
        assertMethod(request, ['GET']);
        return adminApplicationList(request, env, admin);
    }
    const detailMatch = pathname.match(/^\/site\/reuse-admin\/api\/applications\/([0-9a-f-]{36})$/u);
    if (detailMatch) {
        assertMethod(request, ['GET']);
        return adminApplicationDetail(env, admin, detailMatch[1]);
    }
    const reviewMatch = pathname.match(/^\/site\/reuse-admin\/api\/applications\/([0-9a-f-]{36})\/review$/u);
    if (reviewMatch) {
        assertMethod(request, ['POST']);
        assertSameOrigin(request);
        return reviewApplication(request, env, admin, reviewMatch[1]);
    }
    const messageMatch = pathname.match(/^\/site\/reuse-admin\/api\/applications\/([0-9a-f-]{36})\/message$/u);
    if (messageMatch) {
        assertMethod(request, ['POST']);
        assertSameOrigin(request);
        return sendAdminApplicationMessage(request, env, admin, messageMatch[1]);
    }
    throw new ReuseError(404, '指定された管理APIはありません。', 'not_found');
}

async function adminApplicationList(request, env, admin) {
    const status = new URL(request.url).searchParams.get('status') || 'all';
    if (status !== 'all' && !Object.hasOwn(STATUS_LABELS, status)) {
        throw new ReuseError(400, '状態の指定が正しくありません。', 'invalid_status');
    }
    const statement = status === 'all'
        ? env.REUSE_DB.prepare(
            `SELECT * FROM reuse_applications ORDER BY
                CASE status WHEN 'pending' THEN 0 WHEN 'changes_requested' THEN 1 ELSE 2 END,
                updated_at DESC LIMIT 200`,
        )
        : env.REUSE_DB.prepare(
            'SELECT * FROM reuse_applications WHERE status = ? ORDER BY updated_at DESC LIMIT 200',
        ).bind(status);
    const result = await statement.all();
    const counts = await env.REUSE_DB.prepare(
        'SELECT status, COUNT(*) AS count FROM reuse_applications GROUP BY status',
    ).all();
    return jsonResponse({
        success: true,
        admin: admin.email,
        counts: Object.fromEntries((counts.results || []).map((row) => [row.status, Number(row.count || 0)])),
        applications: (result.results || []).map((item) => serializeApplication(item, true)),
    });
}

async function adminApplicationDetail(env, admin, id) {
    const application = await env.REUSE_DB.prepare('SELECT * FROM reuse_applications WHERE id = ?')
        .bind(id).first();
    if (!application) throw new ReuseError(404, '申請が見つかりません。', 'application_not_found');
    const events = await env.REUSE_DB.prepare(
        `SELECT event_type, actor, message, created_at FROM reuse_application_events
         WHERE application_id = ? ORDER BY created_at DESC`,
    ).bind(id).all();
    return jsonResponse({
        success: true,
        admin: admin.email,
        application: serializeApplication(application, true),
        events: events.results || [],
    });
}

async function reviewApplication(request, env, admin, id) {
    const input = await readJson(request);
    const action = stringValue(input.action);
    if (!['approved', 'rejected', 'changes_requested'].includes(action)) {
        throw new ReuseError(400, '審査結果の指定が正しくありません。', 'invalid_review_action');
    }
    const message = boundedText(input.message, 1, 2_000, '申請者へのメッセージ');
    const application = await env.REUSE_DB.prepare('SELECT * FROM reuse_applications WHERE id = ?')
        .bind(id).first();
    if (!application) throw new ReuseError(404, '申請が見つかりません。', 'application_not_found');

    const now = new Date().toISOString();
    const manageToken = randomToken(32);
    const update = await env.REUSE_DB.prepare(
        `UPDATE reuse_applications SET status = ?, admin_message = ?, reviewed_by = ?,
            reviewed_at = ?, updated_at = ?, manage_token_hash = ?
         WHERE id = ? AND updated_at = ?`,
    ).bind(action, message, admin.email, now, now, await sha256(manageToken), id, application.updated_at).run();
    if (!statementChangedRows(update)) {
        throw new ReuseError(409, '申請が別の操作で更新されました。再読み込みしてください。', 'application_changed');
    }
    await env.REUSE_DB.prepare(
        `INSERT INTO reuse_application_events
            (id, application_id, event_type, actor, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), id, action, admin.email, message, now).run();

    await sendResultEmail(env, { ...application, status: action, admin_message: message, manageToken });
    return jsonResponse({ success: true, status: action, statusLabel: STATUS_LABELS[action] });
}

async function sendAdminApplicationMessage(request, env, admin, id) {
    const input = validateAdminMessageInput(await readJson(request));
    const application = await env.REUSE_DB.prepare('SELECT * FROM reuse_applications WHERE id = ?')
        .bind(id).first();
    if (!application) throw new ReuseError(404, '申請が見つかりません。', 'application_not_found');

    await sendAdminMessageEmail(env, application, input);
    const now = new Date().toISOString();
    await env.REUSE_DB.prepare(
        `INSERT INTO reuse_application_events
            (id, application_id, event_type, actor, message, created_at)
         VALUES (?, ?, 'admin_message_sent', ?, ?, ?)`,
    ).bind(
        crypto.randomUUID(), id, admin.email,
        `種別: ${input.categoryLabel}\n件名: ${input.subject}\n${input.message}`,
        now,
    ).run();
    return jsonResponse({ success: true, sentAt: now });
}

function validateAdminMessageInput(input) {
    const categories = Object.freeze({ inquiry: '不明点の確認', correction: '不備の案内', other: 'その他の連絡' });
    const category = enumValue(input.category, Object.keys(categories), '連絡種別');
    const subject = boundedText(input.subject, 1, 150, 'メール件名');
    const message = boundedText(input.message, 1, 5_000, 'メール本文');
    return { category, categoryLabel: categories[category], subject, message };
}

async function validateApplicationInput(input, session, env) {
    const guildId = validateSnowflake(input.guildId, '利用サーバー');
    const guild = findSessionGuild(session, guildId);
    if (!guild) throw new ReuseError(403, '選択したサーバーの管理権限を確認できません。', 'guild_not_allowed');
    const availableChannels = await fetchGuildChannels(guildId, env);
    const channelMappings = validateChannelMappings(input.channelMappings, availableChannels);
    const channel = channelMappings[0];
    return {
        ...validateEditableApplicationInput({
            ...input,
            deliveryTypes: aggregateDeliveryTypes(channelMappings),
            channelType: channel.channelType,
            announcement: channel.announcement,
            announcementAutomated: channel.announcementAutomated,
        }),
        guild,
        channel: { id: channel.channelId, name: channel.channelName, type: channel.channelType },
        channelMappings,
    };
}

function validateChannelMappings(input, availableChannels) {
    if (!Array.isArray(input) || input.length < 1 || input.length > 10) {
        throw new ReuseError(400, '利用チャンネルと配信の組み合わせを1〜10件で設定してください。', 'invalid_channel_mappings');
    }
    const channelsById = new Map(availableChannels.map((channel) => [stringValue(channel.id), channel]));
    const usedChannels = new Set();
    return input.map((mapping, index) => {
        const channelId = validateSnowflake(mapping?.channelId, `利用チャンネル${index + 1}`);
        const channel = channelsById.get(channelId);
        if (!channel) throw new ReuseError(400, '選択した利用チャンネルを確認できません。', 'channel_not_found');
        if (usedChannels.has(channelId)) {
            throw new ReuseError(400, '同じ利用チャンネルは1つの設定にまとめてください。', 'duplicate_channel_mapping');
        }
        usedChannels.add(channelId);

        if (typeof mapping?.announcement !== 'boolean') {
            throw new ReuseError(400, 'アナウンスチャンネルかどうかを選択してください。', 'invalid_announcement_setting');
        }
        const announcement = mapping.announcement;
        const announcementAutomated = enumValue(
            mapping?.announcementAutomated,
            announcement ? ['yes', 'no'] : ['not_applicable'],
            'アナウンス公開の自動化状況',
        );
        const publishChannelDifferent = mapping?.publishChannelDifferent === true;
        const publishAutomated = enumValue(
            mapping?.publishAutomated,
            publishChannelDifferent ? ['yes', 'no'] : ['not_applicable'],
            '公開先チャンネルへの配信方法',
        );
        let publishChannel = null;
        if (publishChannelDifferent) {
            const publishChannelId = validateSnowflake(mapping?.publishChannelId, '公開先チャンネル');
            publishChannel = channelsById.get(publishChannelId);
            if (!publishChannel) throw new ReuseError(400, '公開先チャンネルを確認できません。', 'publish_channel_not_found');
            if (publishChannelId === channelId) {
                throw new ReuseError(400, '異なる公開先チャンネルを選択してください。', 'publish_channel_same');
            }
        }
        return {
            channelId,
            channelName: stringValue(channel.name).slice(0, 100),
            channelType: Number(channel.type),
            announcement,
            announcementAutomated,
            publishChannelDifferent,
            publishChannelId: publishChannel ? stringValue(publishChannel.id) : '',
            publishChannelName: publishChannel ? stringValue(publishChannel.name).slice(0, 100) : '',
            publishChannelType: publishChannel ? Number(publishChannel.type) : null,
            publishAutomated,
            deliveryTypes: validateDeliveryTypes(mapping?.deliveryTypes),
        };
    });
}

function validateResubmittedChannelMappings(input, existing) {
    const stored = applicationChannelMappings(existing);
    if (!Array.isArray(input) || input.length !== stored.length) {
        throw new ReuseError(400, 'チャンネル別の配信設定を確認してください。', 'invalid_channel_mappings');
    }
    return stored.map((mapping, index) => {
        const submitted = input[index] || {};
        if (stringValue(submitted.channelId) !== mapping.channelId
            || stringValue(submitted.publishChannelId) !== mapping.publishChannelId) {
            throw new ReuseError(400, '再申請ではチャンネルを変更できません。', 'channel_mapping_changed');
        }
        const announcementAutomated = enumValue(
            submitted.announcementAutomated,
            mapping.announcement ? ['yes', 'no'] : ['not_applicable'],
            'アナウンス公開の自動化状況',
        );
        const publishAutomated = enumValue(
            submitted.publishAutomated,
            mapping.publishChannelDifferent ? ['yes', 'no'] : ['not_applicable'],
            '公開先チャンネルへの配信方法',
        );
        return { ...mapping, announcementAutomated, publishAutomated, deliveryTypes: validateDeliveryTypes(submitted.deliveryTypes) };
    });
}

function validateDeliveryTypes(input) {
    const values = Array.isArray(input) ? [...new Set(input.map(stringValue))] : [];
    if (values.length === 0 || values.some((item) => !Object.hasOwn(DELIVERY_TYPES, item))) {
        throw new ReuseError(400, '各チャンネルで二次利用する配信を1つ以上選択してください。', 'invalid_delivery_types');
    }
    return values;
}

function aggregateDeliveryTypes(channelMappings) {
    return [...new Set(channelMappings.flatMap((mapping) => mapping.deliveryTypes))];
}

function validateEditableApplicationInput(input, existing = null) {
    const deliveryTypes = validateDeliveryTypes(input.deliveryTypes);
    const serverPublic = enumValue(input.serverPublic, ['public', 'private'], 'サーバーの公開範囲');
    const channelVisibility = enumValue(
        input.channelVisibility,
        ['public', 'role_limited'],
        'チャンネルの公開範囲',
    );
    const isAnnouncement = typeof input.announcement === 'boolean'
        ? input.announcement
        : Number(existing?.channel_type ?? input.channelType) === 5;
    const announcementAutomated = enumValue(
        input.announcementAutomated,
        ['yes', 'no', 'not_applicable'],
        '公開の自動化状況',
    );
    if (!isAnnouncement && announcementAutomated !== 'not_applicable') {
        throw new ReuseError(400, 'アナウンスチャンネル以外では「該当なし」を選択してください。', 'invalid_announcement_setting');
    }
    const reuseMethod = enumValue(input.reuseMethod, ['unchanged', 'edited', 'other'], '二次利用方法');
    const reuseMethodOther = reuseMethod === 'other'
        ? boundedText(input.reuseMethodOther, 2, 500, 'その他の二次利用方法')
        : '';
    const email = validateEmail(input.email);
    const emailConfirm = validateEmail(input.emailConfirm);
    if (email !== emailConfirm) {
        throw new ReuseError(400, '確認用メールアドレスが一致しません。', 'email_mismatch');
    }
    const purpose = boundedText(input.purpose, 10, 2_000, '利用目的');
    const destinationUrl = optionalUrl(input.destinationUrl);
    const notes = optionalText(input.notes, 2_000);
    if (input.consent !== true) {
        throw new ReuseError(400, '情報収集と審査への同意が必要です。', 'consent_required');
    }
    if (input.authorized !== true) {
        throw new ReuseError(400, '申請先を管理する権限の確認が必要です。', 'authorization_required');
    }
    return {
        deliveryTypes, serverPublic, channelVisibility, announcementAutomated,
        reuseMethod, reuseMethodOther, email, purpose, destinationUrl, notes,
    };
}

async function fetchGuildChannels(guildId, env) {
    const response = await fetch(`${DISCORD_API}/guilds/${guildId}/channels`, {
        headers: { Authorization: `Bot ${clean(env.DISCORD_BOT_TOKEN)}` },
    });
    if (response.status === 403 || response.status === 404) {
        throw new ReuseError(
            409,
            'このサーバーのチャンネルを取得できません。DPI-Botが参加し、チャンネルを表示できる状態か確認してください。',
            'discord_guild_unavailable',
        );
    }
    if (!response.ok) throw new ReuseError(502, 'Discordからチャンネルを取得できませんでした。', 'discord_channels_failed');
    const channels = await response.json();
    if (!Array.isArray(channels)) throw new ReuseError(502, 'Discordのチャンネル応答が不正です。', 'discord_channels_invalid');
    return channels
        .filter((item) => [0, 5].includes(Number(item.type)) && snowflake(item.id))
        .sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
}

async function discordFetch(pathname, authorization) {
    const response = await fetch(`${DISCORD_API}${pathname}`, {
        headers: { Authorization: authorization },
    });
    if (!response.ok) throw new ReuseError(502, 'Discordからアカウント情報を取得できませんでした。', 'discord_api_failed');
    return response;
}

async function requireSession(request, env) {
    await ensureDatabase(env);
    const rawToken = readCookie(request, 'dpi_reuse_session');
    if (!rawToken || rawToken.length > 200) {
        throw new ReuseError(401, 'Discordでログインしてください。', 'login_required');
    }
    const session = await env.REUSE_DB.prepare(
        'SELECT * FROM reuse_sessions WHERE token_hash = ? AND expires_at >= ?',
    ).bind(await sha256(rawToken), Date.now()).first();
    if (!session) throw new ReuseError(401, 'ログインの有効時間が切れました。再度ログインしてください。', 'session_expired');
    return session;
}

function findSessionGuild(session, guildId) {
    if (!snowflake(guildId)) return null;
    return parseJsonArray(session.guilds_json).find((guild) => guild?.id === guildId) || null;
}

async function findManagedApplication(request, env) {
    await ensureDatabase(env);
    const token = new URL(request.url).searchParams.get('token') || '';
    if (!/^[A-Za-z0-9_-]{40,100}$/u.test(token)) {
        throw new ReuseError(404, '申請情報が見つかりません。', 'application_not_found');
    }
    const application = await env.REUSE_DB.prepare(
        'SELECT * FROM reuse_applications WHERE manage_token_hash = ?',
    ).bind(await sha256(token)).first();
    if (!application) throw new ReuseError(404, '申請情報が見つかりません。', 'application_not_found');
    return application;
}

function serializeApplication(item, includePrivate) {
    const channelMappings = applicationChannelMappings(item);
    const output = {
        id: item.id,
        reference: item.reference,
        status: item.status,
        statusLabel: STATUS_LABELS[item.status] || item.status,
        revision: Number(item.revision || 1),
        discordUsername: item.discord_username,
        guildId: item.guild_id,
        guildName: item.guild_name,
        channelId: item.channel_id,
        channelName: item.channel_name,
        channelType: Number(item.channel_type),
        deliveryTypes: parseJsonArray(item.delivery_types),
        channelMappings,
        serverPublic: item.server_public,
        channelVisibility: item.channel_visibility,
        announcementAutomated: item.announcement_automated,
        reuseMethod: item.reuse_method,
        reuseMethodOther: item.reuse_method_other || '',
        purpose: item.purpose,
        destinationUrl: item.destination_url || '',
        notes: item.notes || '',
        adminMessage: item.admin_message || '',
        reviewedAt: item.reviewed_at || null,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        resubmittedAt: item.resubmitted_at || null,
    };
    if (includePrivate) {
        output.discordUserId = item.discord_user_id;
        output.contactEmail = item.contact_email;
        output.reviewedBy = item.reviewed_by || null;
    } else {
        output.contactEmail = maskEmail(item.contact_email);
    }
    return output;
}

function applicationChannelMappings(item) {
    const parsed = parseJsonArray(item.channel_mappings);
    if (parsed.length) return parsed.map((mapping) => ({
        channelId: stringValue(mapping.channelId),
        channelName: stringValue(mapping.channelName),
        channelType: Number(mapping.channelType),
        announcement: mapping.announcement === true,
        announcementAutomated: stringValue(mapping.announcementAutomated) || 'not_applicable',
        publishChannelDifferent: mapping.publishChannelDifferent === true,
        publishChannelId: stringValue(mapping.publishChannelId),
        publishChannelName: stringValue(mapping.publishChannelName),
        publishChannelType: mapping.publishChannelType == null ? null : Number(mapping.publishChannelType),
        publishAutomated: stringValue(mapping.publishAutomated) || 'not_applicable',
        deliveryTypes: Array.isArray(mapping.deliveryTypes) ? mapping.deliveryTypes.map(stringValue) : [],
    }));
    return [{
        channelId: stringValue(item.channel_id),
        channelName: stringValue(item.channel_name),
        channelType: Number(item.channel_type),
        announcement: Number(item.channel_type) === 5,
        announcementAutomated: stringValue(item.announcement_automated) || 'not_applicable',
        publishChannelDifferent: false,
        publishChannelId: '',
        publishChannelName: '',
        publishChannelType: null,
        publishAutomated: 'not_applicable',
        deliveryTypes: parseJsonArray(item.delivery_types),
    }];
}

async function sendReceiptEmail(env, application) {
    const manageUrl = manageUrlFor(env, application.manageToken);
    const mappingLines = (application.channelMappings || []).flatMap((mapping, index) => [
        `利用設定${index + 1}: #${mapping.channelName}`,
        `配信: ${mapping.deliveryTypes.map((id) => DELIVERY_TYPES[id] || id).join('、')}`,
        ...(mapping.publishChannelDifferent ? [
            `公開先: #${mapping.publishChannelName}`,
            `公開先への配信: ${mapping.publishAutomated === 'yes' ? '自動' : '手動'}`,
        ] : []),
    ]);
    const text = [
        'DPI-Bot 二次利用申請を受け付けました。', '',
        `受付番号: ${application.reference}`,
        `サーバー: ${application.guildName}`,
        ...mappingLines,
        '', '現在の状態: 審査中',
        '申請状況の確認・不備時の再申請:', manageUrl,
        '', 'このメールに心当たりがない場合は、support@dpi-bot.comへご連絡ください。',
    ].join('\n');
    await sendReuseEmail(env, application.email, `【DPI-Bot】二次利用申請受付 ${application.reference}`, text, 'application-receipt');
}

async function sendResultEmail(env, application) {
    const manageUrl = manageUrlFor(env, application.manageToken);
    const lines = [
        'DPI-Bot 二次利用申請の審査結果をお知らせします。', '',
        `受付番号: ${application.reference}`,
        `審査結果: ${STATUS_LABELS[application.status] || application.status}`,
        '', '管理者からのメッセージ', application.admin_message,
    ];
    if (application.status === 'changes_requested') {
        lines.push('', '次のURLから内容を修正し、再申請してください。');
    } else {
        lines.push('', '申請内容と現在の状態は次のURLから確認できます。');
    }
    lines.push(manageUrl);
    lines.push('', 'ご不明な点は support@dpi-bot.com へご連絡ください。');
    await sendReuseEmail(
        env,
        application.contact_email,
        `【DPI-Bot】二次利用申請結果 ${application.reference}（${STATUS_LABELS[application.status]}）`,
        lines.join('\n'),
        'application-result',
    );
}

async function sendAdminMessageEmail(env, application, input) {
    const subject = input.subject.startsWith('【DPI-Bot】')
        ? input.subject
        : `【DPI-Bot】${input.subject}`;
    const text = [
        'DPI-Bot 二次利用申請について、運営からご連絡します。', '',
        `受付番号: ${application.reference}`,
        `連絡種別: ${input.categoryLabel}`,
        '', input.message, '',
        'このメールへ返信するか、support@dpi-bot.com へご連絡ください。',
    ].join('\n');
    await sendReuseEmail(env, application.contact_email, subject, text, 'application-admin-message');
}

async function sendResubmittedEmail(env, application) {
    await sendReuseEmail(
        env,
        application.email || application.contact_email,
        `【DPI-Bot】二次利用申請の再申請受付 ${application.reference}`,
        [
            'DPI-Bot 二次利用申請の再申請を受け付けました。', '',
            `受付番号: ${application.reference}`,
            `申請版: 第${application.revision}版`,
            '現在の状態: 審査中', '',
            '審査が完了すると、このメールアドレスへ結果をお送りします。',
        ].join('\n'),
        'application-resubmitted',
    );
}

async function sendReuseEmail(env, to, subject, text, type) {
    try {
        await env.NOTICE_EMAIL.send({
            to,
            from: { email: clean(env.NOTICE_FROM_EMAIL), name: 'DPI-Bot' },
            subject,
            text,
            ...(clean(env.NOTICE_REPLY_TO_EMAIL)
                ? { replyTo: clean(env.NOTICE_REPLY_TO_EMAIL) }
                : {}),
            headers: {
                'Auto-Submitted': 'auto-generated',
                'Content-Language': 'ja',
                'X-DPI-Mail-Type': type,
            },
        });
    } catch (error) {
        console.error('Reuse application email failed', {
            type,
            errorName: error?.name || 'Error',
            errorCode: error?.code || 'unknown',
        });
        throw new ReuseError(502, 'メール送信に失敗しました。時間をおいて再度お試しください。', 'email_failed');
    }
}

function manageUrlFor(env, token) {
    const url = new URL('/site/reuse/', publicOrigin(env));
    url.searchParams.set('token', token);
    return url.toString();
}

function redirectToReuse(result, setCookie) {
    const url = new URL('https://dpi-bot.com/site/reuse/');
    url.searchParams.set('oauth', result);
    const headers = new Headers({ Location: url.toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    for (const value of Array.isArray(setCookie) ? setCookie : [setCookie]) {
        if (value) headers.append('Set-Cookie', value);
    }
    return new Response(null, { status: 302, headers });
}

function oauthRedirectUri(request, env) {
    const configured = clean(env.DISCORD_REDIRECT_URI);
    if (configured) {
        try {
            const url = new URL(configured);
            if (url.protocol === 'https:' && url.pathname === '/api/reuse/oauth/callback') return url.toString();
        } catch { /* fall through */ }
    }
    return new URL('/api/reuse/oauth/callback', new URL(request.url).origin).toString();
}

function publicOrigin(env) {
    const configured = clean(env.REUSE_PUBLIC_ORIGIN) || clean(env.NEWSLETTER_PUBLIC_ORIGIN);
    try {
        const url = new URL(configured || 'https://dpi-bot.com');
        if (url.protocol === 'https:') return url.origin;
    } catch { /* use production origin */ }
    return 'https://dpi-bot.com';
}

function assertPublicConfigured(env) {
    const missing = publicConfigurationMissing(env);
    if (missing.length) {
        console.error('Reuse application configuration is incomplete', { missing });
        throw new ReuseError(503, '二次利用申請フォームは現在設定中です。', 'service_not_configured');
    }
}

function publicConfigurationMissing(env) {
    return [
        ['REUSE_DB', env.REUSE_DB],
        ['DISCORD_CLIENT_ID', clean(env.DISCORD_CLIENT_ID)],
        ['DISCORD_CLIENT_SECRET', clean(env.DISCORD_CLIENT_SECRET)],
        ['DISCORD_BOT_TOKEN', clean(env.DISCORD_BOT_TOKEN)],
        ['REUSE_SESSION_SECRET', clean(env.REUSE_SESSION_SECRET)],
        ['NOTICE_EMAIL', env.NOTICE_EMAIL],
        ['NOTICE_FROM_EMAIL', clean(env.NOTICE_FROM_EMAIL)],
    ].filter(([, value]) => !value).map(([name]) => name);
}

function normalizeReuseEnvironment(env) {
    if (env.REUSE_DB || (!env.NEWSLETTER_DB && !env.IP_BLOCK_DB)) return env;
    const normalized = Object.create(env);
    normalized.REUSE_DB = env.NEWSLETTER_DB || env.IP_BLOCK_DB;
    return normalized;
}

function assertDatabaseConfigured(env) {
    if (!env.REUSE_DB) throw new ReuseError(503, '申請データベースが設定されていません。', 'database_not_configured');
}

async function ensureDatabase(env) {
    assertDatabaseConfigured(env);
    // 本番はmigrationで作成する。存在確認によりmigration漏れを明確な503へ変換する。
    try {
        await env.REUSE_DB.prepare('SELECT channel_mappings FROM reuse_applications LIMIT 1').first();
    } catch {
        throw new ReuseError(503, '申請データベースの準備が完了していません。', 'database_schema_missing');
    }
}

function assertMethod(request, methods) {
    if (!methods.includes(request.method)) throw new ReuseError(405, '許可されていない操作です。', 'method_not_allowed');
}

function assertSameOrigin(request) {
    const origin = request.headers.get('origin');
    if (!origin || origin !== new URL(request.url).origin) {
        throw new ReuseError(403, 'このページ以外からは操作できません。', 'invalid_origin');
    }
}

function assertCsrf(request, session) {
    const provided = request.headers.get('x-reuse-csrf') || '';
    if (!timingSafeEqual(provided, session.csrf_token)) {
        throw new ReuseError(403, '操作の確認情報が一致しません。再読み込みしてください。', 'invalid_csrf');
    }
}

async function readJson(request) {
    const type = request.headers.get('content-type') || '';
    if (!type.toLowerCase().startsWith('application/json')) {
        throw new ReuseError(415, '送信形式が正しくありません。', 'invalid_content_type');
    }
    const length = Number(request.headers.get('content-length') || 0);
    if (length > MAX_JSON_BYTES) throw new ReuseError(413, '送信データが大きすぎます。', 'request_too_large');
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
        throw new ReuseError(413, '送信データが大きすぎます。', 'request_too_large');
    }
    try { return JSON.parse(text); } catch { throw new ReuseError(400, '入力内容を読み取れません。', 'invalid_json'); }
}

function canManageGuild(guild) {
    if (guild?.owner === true) return true;
    try {
        const permissions = BigInt(guild?.permissions || 0);
        return (permissions & MANAGE_GUILD) === MANAGE_GUILD
            || (permissions & ADMINISTRATOR) === ADMINISTRATOR;
    } catch { return false; }
}

function discordDisplayName(user) {
    return (stringValue(user.global_name) || stringValue(user.username)).slice(0, 100);
}

function validateSnowflake(value, label) {
    const normalized = stringValue(value);
    if (!snowflake(normalized)) throw new ReuseError(400, `${label}のIDが正しくありません。`, 'invalid_snowflake');
    return normalized;
}

function snowflake(value) {
    return /^[0-9]{17,20}$/u.test(stringValue(value));
}

function validateEmail(value) {
    const email = stringValue(value).trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
        throw new ReuseError(400, 'メールアドレスを確認してください。', 'invalid_email');
    }
    return email;
}

function enumValue(value, allowed, label) {
    const normalized = stringValue(value);
    if (!allowed.includes(normalized)) throw new ReuseError(400, `${label}を選択してください。`, 'invalid_choice');
    return normalized;
}

function boundedText(value, min, max, label) {
    const text = stringValue(value).trim();
    if (text.length < min || text.length > max) {
        throw new ReuseError(400, `${label}は${min}〜${max}文字で入力してください。`, 'invalid_text_length');
    }
    return text;
}

function optionalText(value, max) {
    const text = stringValue(value).trim();
    if (text.length > max) throw new ReuseError(400, `補足事項は${max}文字以内で入力してください。`, 'invalid_text_length');
    return text;
}

function optionalUrl(value) {
    const text = stringValue(value).trim();
    if (!text) return '';
    if (text.length > 500) throw new ReuseError(400, '公開URLが長すぎます。', 'invalid_url');
    try {
        const url = new URL(text);
        if (!['https:', 'http:'].includes(url.protocol)) throw new Error('invalid_protocol');
        return url.toString();
    } catch { throw new ReuseError(400, '公開URLを確認してください。', 'invalid_url'); }
}

function createReference() {
    const date = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    return `REUSE-${date}-${randomToken(6).toUpperCase()}`;
}

function cookie(name, value, maxAge) {
    return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(name) {
    return `${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function readCookie(request, name) {
    const header = request.headers.get('cookie') || '';
    for (const part of header.split(';')) {
        const separator = part.indexOf('=');
        if (separator < 0) continue;
        if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
    }
    return '';
}

function randomToken(bytes) {
    const data = crypto.getRandomValues(new Uint8Array(bytes));
    return base64Url(data);
}

function base64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function sha256(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function keyedHash(secret, value) {
    const key = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
    return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(left, right) {
    const a = new TextEncoder().encode(stringValue(left));
    const b = new TextEncoder().encode(stringValue(right));
    let different = a.length ^ b.length;
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index += 1) different |= (a[index] || 0) ^ (b[index] || 0);
    return different === 0;
}

function parseJsonArray(value) {
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
}

function stringValue(value) {
    return typeof value === 'string' ? value : '';
}

function clean(value) {
    return stringValue(value).trim();
}

function maskEmail(email) {
    const [local, domain] = stringValue(email).split('@');
    if (!local || !domain) return '';
    return `${local.slice(0, 1)}***@${domain}`;
}

function statementChangedRows(result) {
    return Number(result?.meta?.changes ?? result?.changes ?? 0) > 0;
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...JSON_HEADERS, ...extraHeaders },
    });
}

function reuseErrorResponse(error) {
    if (error instanceof ReuseError || error instanceof AccessAuthError) {
        return jsonResponse({ success: false, message: error.publicMessage || error.message, code: error.code }, error.status);
    }
    console.error('Reuse application processing failed', {
        errorName: error?.name || 'Error',
        errorCode: error?.code || 'unknown',
    });
    return jsonResponse({ success: false, message: '処理に失敗しました。時間をおいて再度お試しください。', code: 'internal_error' }, 500);
}

export const __test = Object.freeze({
    canManageGuild,
    serializeApplication,
    timingSafeEqual,
    validateAdminMessageInput,
    validateChannelMappings,
    validateEditableApplicationInput,
});
