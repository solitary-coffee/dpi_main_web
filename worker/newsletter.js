import { AccessAuthError, authenticateNewsletterAdmin } from './access.js';
import { DELIVERY_CATALOG } from './delivery-catalog.js';

const CATEGORIES = Object.freeze({
    maintenance: 'メンテナンス情報',
    outage: '障害・重要情報',
    update: 'アップデート情報',
});

const CATEGORY_ORDER = Object.freeze(Object.keys(CATEGORIES));
const RECIPIENT_GROUPS = Object.freeze({
    subscribers: 'お知らせメール購読者',
    reuse_approved: '許可済み二次利用者',
    discord_approved: '許可済み配信サーバー',
});
const RECIPIENT_GROUP_ORDER = Object.freeze(Object.keys(RECIPIENT_GROUPS));
const DELIVERY_SLOT_IDS = new Set(DELIVERY_CATALOG.map((item) => item.id));
const MAX_JSON_BYTES = 24 * 1024;
const MAX_FORM_BYTES = 8 * 1024;
const MAX_DISCORD_FORM_BYTES = 1_500_000;
const MAX_DISCORD_IMAGE_BYTES = 1_250_000;
const DISCORD_IMAGE_TYPES = Object.freeze(new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']));
const DISCORD_FORMATS = Object.freeze(new Set(['message', 'embed']));
const DISCORD_TARGET_MODES = Object.freeze(new Set(['delivery_slots', 'servers', 'intersection']));
const OFFICIAL_SUPPORT_CHANNEL_ID = '1020702978426028104';
const OFFICIAL_SUPPORT_ROLE_IDS = Object.freeze(new Set([
    '1538768646430793768',
    '1538768792648163368',
    '1538768846989820005',
]));
const DEFAULT_DISCORD_EMBED_COLOR = 0x5865F2;
const MAX_CAMPAIGN_RECIPIENTS = 1_000;
const CONFIRMATION_VALID_MS = 24 * 60 * 60 * 1_000;
const CONFIRMATION_COOLDOWN_MS = 10 * 60 * 1_000;
const SUBSCRIBE_RATE_WINDOW_MS = 60 * 60 * 1_000;
const SUBSCRIBE_RATE_LIMIT = 8;
const QUEUE_BATCH_SIZE = 50;
const MAX_DELIVERY_ATTEMPTS = 5;

const JSON_HEADERS = Object.freeze({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
});

const HTML_HEADERS = Object.freeze({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'origin',
    'X-Robots-Tag': 'noindex, nofollow',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
});

const SCHEMA_STATEMENTS = Object.freeze([
    `CREATE TABLE IF NOT EXISTS newsletter_subscribers (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        status TEXT NOT NULL DEFAULT 'pending',
        categories TEXT NOT NULL DEFAULT '',
        pending_categories TEXT,
        consent_version TEXT,
        pending_consent_version TEXT,
        consent_at TEXT,
        confirmed_at TEXT,
        unsubscribed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        confirmation_token_hash TEXT,
        confirmation_expires_at TEXT,
        last_confirmation_sent_at TEXT
    )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS newsletter_confirmation_token_idx
        ON newsletter_subscribers(confirmation_token_hash)
        WHERE confirmation_token_hash IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS newsletter_subscriber_status_idx
        ON newsletter_subscribers(status)`,
    `CREATE TABLE IF NOT EXISTS newsletter_rate_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key_hash TEXT NOT NULL,
        event_type TEXT NOT NULL,
        created_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS newsletter_rate_events_lookup_idx
        ON newsletter_rate_events(key_hash, event_type, created_at)`,
    `CREATE TABLE IF NOT EXISTS newsletter_campaigns (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL,
        body_text TEXT NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        recipient_count INTEGER NOT NULL DEFAULT 0,
        recipient_groups TEXT NOT NULL DEFAULT 'subscribers',
        delivery_slots TEXT NOT NULL DEFAULT 'DPI_Bot通知',
        target_server_ids TEXT NOT NULL DEFAULT '',
        target_mode TEXT NOT NULL DEFAULT 'delivery_slots',
        deduplicate_channels INTEGER NOT NULL DEFAULT 1,
        send_official_support INTEGER NOT NULL DEFAULT 0,
        official_mention_role_id TEXT NOT NULL DEFAULT '',
        official_message_id TEXT,
        delivery_format TEXT NOT NULL DEFAULT 'message',
        embed_color INTEGER NOT NULL DEFAULT 5793266,
        image_url TEXT,
        image_name TEXT,
        image_type TEXT,
        image_data BLOB,
        image_alt TEXT,
        external_sent_count INTEGER NOT NULL DEFAULT 0,
        external_failed_count INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS newsletter_campaign_status_idx
        ON newsletter_campaigns(status, created_at)`,
    `CREATE TABLE IF NOT EXISTS newsletter_deliveries (
        id TEXT PRIMARY KEY,
        campaign_id TEXT NOT NULL,
        subscriber_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        message_id TEXT,
        last_error_code TEXT,
        created_at TEXT NOT NULL,
        queued_at TEXT,
        sent_at TEXT,
        updated_at TEXT NOT NULL,
        recipient_email TEXT,
        recipient_kind TEXT NOT NULL DEFAULT 'subscriber',
        recipient_reference TEXT,
        UNIQUE(campaign_id, subscriber_id)
    )`,
    `CREATE INDEX IF NOT EXISTS newsletter_delivery_campaign_idx
        ON newsletter_deliveries(campaign_id, status)`,
    `CREATE INDEX IF NOT EXISTS newsletter_delivery_subscriber_idx
        ON newsletter_deliveries(subscriber_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS newsletter_delivery_recipient_email_idx
        ON newsletter_deliveries(campaign_id, lower(recipient_email))
        WHERE recipient_email IS NOT NULL`,
    `CREATE TABLE IF NOT EXISTS admin_audit_events (
        id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS admin_audit_events_created_idx
        ON admin_audit_events(created_at DESC)`,
]);

const schemaInitialization = new WeakMap();

class NewsletterError extends Error {
    constructor(status, publicMessage, code) {
        super(publicMessage);
        this.name = 'NewsletterError';
        this.status = status;
        this.publicMessage = publicMessage;
        this.code = code;
    }
}

export async function handleNewsletterRequest(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const isNewsletterApi = pathname === '/api/newsletter' || pathname.startsWith('/api/newsletter/');
    const isMailAdminApi = pathname === '/site/mail-admin/api' || pathname.startsWith('/site/mail-admin/api/');
    const isDiscordAdminApi = pathname === '/site/discord-admin/api' || pathname.startsWith('/site/discord-admin/api/');
    const isAdminApi = isMailAdminApi || isDiscordAdminApi;
    const isAdminAsset = !isAdminApi
        && (pathname === '/site/mail-admin' || pathname.startsWith('/site/mail-admin/')
            || pathname === '/site/discord-admin' || pathname.startsWith('/site/discord-admin/'));

    if (!isNewsletterApi && !isAdminApi && !isAdminAsset) return null;

    try {
        if (isAdminAsset) return await handleProtectedAdminAsset(request, env);
        if (isAdminApi) return await handleAdminApi(request, env, pathname, isDiscordAdminApi ? 'discord' : 'mail');

        if (pathname === '/api/newsletter/config') {
            assertMethod(request, ['GET']);
            return newsletterConfig(env);
        }
        if (pathname === '/api/newsletter/subscribe') {
            assertMethod(request, ['POST']);
            return await handleSubscribe(request, env);
        }
        if (pathname === '/api/newsletter/confirm') {
            assertMethod(request, ['GET', 'POST']);
            if (request.method === 'GET') return confirmationPage(url.searchParams.get('token') || '');
            return await handleConfirmation(request, env);
        }
        if (pathname === '/api/newsletter/unsubscribe') {
            assertMethod(request, ['GET', 'POST']);
            if (request.method === 'GET') return unsubscribePage(url.searchParams.get('token') || '');
            return await handleUnsubscribe(request, env);
        }
        throw new NewsletterError(404, '指定されたAPIはありません。', 'not_found');
    } catch (error) {
        return newsletterErrorResponse(error, request, isAdminAsset);
    }
}

export async function handleNewsletterQueue(batch, env) {
    for (const message of batch.messages || []) {
        try {
            await processDeliveryMessage(message, env);
        } catch (error) {
            console.error('Newsletter queue message failed unexpectedly', {
                errorName: error?.name || 'Error',
                errorCode: error?.code || 'unknown',
            });
            if (typeof message.retry === 'function') message.retry({ delaySeconds: 300 });
        }
    }
}

function newsletterConfig(env) {
    const siteKey = cleanConfigValue(env.RECAPTCHA_SITE_KEY);
    const missing = publicConfigurationMissing(env);
    return jsonResponse({
        success: true,
        configured: missing.length === 0,
        siteKey: siteKey || null,
        categories: CATEGORY_ORDER.map((id) => ({ id, label: CATEGORIES[id] })),
    });
}

async function handleSubscribe(request, env) {
    assertPublicConfigured(env);
    assertSameOrigin(request);
    const input = await readJson(request, MAX_JSON_BYTES);

    if (stringValue(input.website).trim()) return subscribeAcceptedResponse();
    assertReasonableSubmissionTime(input.formStartedAt);

    const email = validateEmail(input.email);
    const categories = validateCategories(input.categories);
    if (input.consent !== true) {
        throw new NewsletterError(400, 'メール配信とプライバシーポリシーへの同意が必要です。', 'consent_required');
    }

    await verifyRecaptcha(stringValue(input.recaptchaToken), request, env);
    await ensureSchema(env);

    const remoteIp = request.headers.get('CF-Connecting-IP') || 'missing';
    const ipKey = await keyedHash(env.NEWSLETTER_TOKEN_SECRET, `subscribe-ip:${remoteIp}`);
    const nowMs = Date.now();
    const recentAttempt = await env.NEWSLETTER_DB.prepare(
        `SELECT COUNT(*) AS count FROM newsletter_rate_events
         WHERE key_hash = ? AND event_type = 'subscribe' AND created_at >= ?`,
    ).bind(ipKey, nowMs - SUBSCRIBE_RATE_WINDOW_MS).first();

    if (Number(recentAttempt?.count || 0) >= SUBSCRIBE_RATE_LIMIT) {
        return subscribeAcceptedResponse();
    }

    await env.NEWSLETTER_DB.batch([
        env.NEWSLETTER_DB.prepare(
            `INSERT INTO newsletter_rate_events (key_hash, event_type, created_at)
             VALUES (?, 'subscribe', ?)`,
        ).bind(ipKey, nowMs),
        env.NEWSLETTER_DB.prepare(
            'DELETE FROM newsletter_rate_events WHERE created_at < ?',
        ).bind(nowMs - 2 * SUBSCRIBE_RATE_WINDOW_MS),
        env.NEWSLETTER_DB.prepare(
            `DELETE FROM newsletter_subscribers
             WHERE status = 'pending'
               AND ((confirmation_expires_at IS NOT NULL AND confirmation_expires_at < ?)
                    OR (confirmation_expires_at IS NULL AND updated_at < ?))`,
        ).bind(
            new Date(nowMs - 7 * 24 * 60 * 60 * 1_000).toISOString(),
            new Date(nowMs - 7 * 24 * 60 * 60 * 1_000).toISOString(),
        ),
    ]);

    const existing = await env.NEWSLETTER_DB.prepare(
        `SELECT id, status, categories, last_confirmation_sent_at
         FROM newsletter_subscribers WHERE email = ?`,
    ).bind(email).first();

    if (existing?.status === 'active' && existing.categories === serializeCategories(categories)) {
        return subscribeAcceptedResponse();
    }

    const lastSentAt = Date.parse(existing?.last_confirmation_sent_at || '');
    if (Number.isFinite(lastSentAt) && nowMs - lastSentAt < CONFIRMATION_COOLDOWN_MS) {
        return subscribeAcceptedResponse();
    }

    const rawToken = randomToken(32);
    const tokenHash = await sha256Hex(rawToken);
    const now = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + CONFIRMATION_VALID_MS).toISOString();
    const serializedCategories = serializeCategories(categories);
    const consentVersion = cleanConfigValue(env.NEWSLETTER_CONSENT_VERSION);
    const subscriberId = existing?.id || crypto.randomUUID();

    if (existing) {
        await env.NEWSLETTER_DB.prepare(
            `UPDATE newsletter_subscribers SET
                status = CASE WHEN status = 'active' THEN status ELSE 'pending' END,
                pending_categories = ?, pending_consent_version = ?,
                confirmation_token_hash = ?, confirmation_expires_at = ?, updated_at = ?
             WHERE id = ?`,
        ).bind(serializedCategories, consentVersion, tokenHash, expiresAt, now, subscriberId).run();
    } else {
        await env.NEWSLETTER_DB.prepare(
            `INSERT INTO newsletter_subscribers (
                id, email, status, categories, pending_categories, pending_consent_version,
                created_at, updated_at, confirmation_token_hash, confirmation_expires_at
             ) VALUES (?, ?, 'pending', '', ?, ?, ?, ?, ?, ?)`,
        ).bind(
            subscriberId,
            email,
            serializedCategories,
            consentVersion,
            now,
            now,
            tokenHash,
            expiresAt,
        ).run();
    }

    try {
        await sendConfirmationEmail(email, categories, rawToken, env);
        await env.NEWSLETTER_DB.prepare(
            `UPDATE newsletter_subscribers SET last_confirmation_sent_at = ?, updated_at = ?
             WHERE id = ? AND confirmation_token_hash = ?`,
        ).bind(now, now, subscriberId, tokenHash).run();
    } catch (error) {
        if (existing) {
            await env.NEWSLETTER_DB.prepare(
                `UPDATE newsletter_subscribers SET
                    status = ?, pending_categories = NULL, pending_consent_version = NULL,
                    confirmation_token_hash = NULL, confirmation_expires_at = NULL, updated_at = ?
                 WHERE id = ? AND confirmation_token_hash = ?`,
            ).bind(existing.status, now, subscriberId, tokenHash).run();
        } else {
            await env.NEWSLETTER_DB.prepare(
                `DELETE FROM newsletter_subscribers
                 WHERE id = ? AND status = 'pending' AND confirmation_token_hash = ?`,
            ).bind(subscriberId, tokenHash).run();
        }
        console.error('Newsletter confirmation email failed', {
            subscriberId,
            errorCode: error?.code || 'unknown',
            errorName: error?.name || 'Error',
        });
        throw new NewsletterError(
            503,
            '確認メールを送信できませんでした。時間をおいて再度お試しください。',
            'confirmation_send_failed',
        );
    }

    return subscribeAcceptedResponse();
}

async function handleConfirmation(request, env) {
    assertDatabaseAndTokenConfigured(env);
    assertSameOriginFormNavigation(request);
    const form = await readForm(request, MAX_FORM_BYTES);
    const token = stringValue(form.get('token'));
    if (!isConfirmationToken(token)) {
        return actionResultPage('確認できませんでした', '確認用リンクが正しくないか、有効期限が切れています。', false, 400);
    }

    await ensureSchema(env);
    const tokenHash = await sha256Hex(token);
    const subscriber = await env.NEWSLETTER_DB.prepare(
        `SELECT id, pending_categories, pending_consent_version, confirmation_expires_at
         FROM newsletter_subscribers WHERE confirmation_token_hash = ?`,
    ).bind(tokenHash).first();

    const expiresAt = Date.parse(subscriber?.confirmation_expires_at || '');
    if (!subscriber || !subscriber.pending_categories || !Number.isFinite(expiresAt) || expiresAt < Date.now()) {
        return actionResultPage('確認できませんでした', '確認用リンクが正しくないか、有効期限が切れています。もう一度登録してください。', false, 400);
    }

    const now = new Date().toISOString();
    const result = await env.NEWSLETTER_DB.prepare(
        `UPDATE newsletter_subscribers SET
            status = 'active', categories = pending_categories,
            consent_version = pending_consent_version, consent_at = ?, confirmed_at = ?,
            unsubscribed_at = NULL, pending_categories = NULL, pending_consent_version = NULL,
            confirmation_token_hash = NULL, confirmation_expires_at = NULL, updated_at = ?
         WHERE id = ? AND confirmation_token_hash = ?`,
    ).bind(now, now, now, subscriber.id, tokenHash).run();

    if (!statementChangedRows(result)) {
        return actionResultPage('確認できませんでした', '確認用リンクはすでに使用されたか、有効期限が切れています。', false, 400);
    }

    return actionResultPage('登録が完了しました', '選択したDPI-Botのお知らせをメールでお送りします。', true);
}

function confirmationPage(token) {
    if (!isConfirmationToken(token)) {
        return actionResultPage('確認できませんでした', '確認用リンクが正しくありません。', false, 400);
    }
    return actionFormPage({
        title: 'メール配信の登録確認',
        description: '下のボタンを押すと登録が完了します。この画面を開いただけでは登録されません。',
        action: '/api/newsletter/confirm',
        token,
        buttonLabel: '登録を確定する',
    });
}

function unsubscribePage(token) {
    if (!isSignedTokenShape(token)) {
        return actionResultPage('配信停止できませんでした', '配信停止用リンクが正しくありません。', false, 400);
    }
    return actionFormPage({
        title: 'メール配信の停止',
        description: '下のボタンを押すと、DPI-Botからのお知らせメールをすべて停止します。',
        action: '/api/newsletter/unsubscribe',
        token,
        buttonLabel: 'すべての配信を停止する',
        danger: true,
    });
}

async function handleUnsubscribe(request, env) {
    assertDatabaseAndTokenConfigured(env);
    const form = await readForm(request, MAX_FORM_BYTES);
    const token = stringValue(form.get('token')) || new URL(request.url).searchParams.get('token') || '';
    const isOneClick = form.get('List-Unsubscribe') === 'One-Click';

    if (!isOneClick) assertSameOriginFormNavigation(request);
    if (!isSignedTokenShape(token)) {
        return actionResultPage('配信停止できませんでした', '配信停止用リンクが正しくありません。', false, 400);
    }

    await ensureSchema(env);
    const subscriber = await verifyUnsubscribeToken(token, env);
    if (!subscriber) {
        return actionResultPage('配信停止できませんでした', '配信停止用リンクが正しくありません。', false, 400);
    }

    const now = new Date().toISOString();
    await env.NEWSLETTER_DB.prepare(
        `UPDATE newsletter_subscribers SET
            status = 'unsubscribed', unsubscribed_at = ?, updated_at = ?,
            pending_categories = NULL, pending_consent_version = NULL,
            confirmation_token_hash = NULL, confirmation_expires_at = NULL
         WHERE id = ?`,
    ).bind(now, now, subscriber.id).run();

    return actionResultPage('配信を停止しました', 'DPI-Botからのお知らせメールを停止しました。いつでも登録し直せます。', true);
}

async function handleProtectedAdminAsset(request, env) {
    if (!['GET', 'HEAD'].includes(request.method)) {
        throw new NewsletterError(405, '許可されていない操作です。', 'method_not_allowed');
    }
    await authenticateNewsletterAdmin(request, env);

    const url = new URL(request.url);
    if (url.pathname === '/site/mail-admin' || url.pathname === '/site/discord-admin') {
        url.pathname = `${url.pathname}/`;
        return new Response(null, {
            status: 308,
            headers: {
                Location: url.toString(),
                'Cache-Control': 'no-store',
                'Referrer-Policy': 'no-referrer',
            },
        });
    }

    const assetResponse = await env.ASSETS.fetch(request);
    const headers = new Headers(assetResponse.headers);
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    if ((headers.get('content-type') || '').includes('text/html')) {
        headers.set(
            'Content-Security-Policy',
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: blob:; connect-src 'self'; frame-src blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
        );
    }
    return new Response(assetResponse.body, {
        status: assetResponse.status,
        statusText: assetResponse.statusText,
        headers,
    });
}

async function handleAdminApi(request, env, pathname, surface) {
    const admin = await authenticateNewsletterAdmin(request, env);
    assertDatabaseConfigured(env);
    await ensureSchema(env);
    const basePath = surface === 'discord' ? '/site/discord-admin/api' : '/site/mail-admin/api';

    if (pathname === `${basePath}/summary`) {
        assertMethod(request, ['GET']);
        return adminSummary(env, admin, surface);
    }

    if (pathname === `${basePath}/preview`) {
        assertMethod(request, ['POST']);
        assertSameOrigin(request);
        return previewCampaign(request, env, surface);
    }

    if (pathname === `${basePath}/audience-preview`) {
        assertMethod(request, ['POST']);
        assertSameOrigin(request);
        return previewAudience(request, env, admin, surface);
    }

    if (pathname === `${basePath}/campaigns`) {
        assertMethod(request, ['POST']);
        assertSameOrigin(request);
        return createCampaign(request, env, admin, surface);
    }

    const actionMatch = pathname.startsWith(`${basePath}/campaigns/`)
        ? pathname.slice(basePath.length).match(/^\/campaigns\/([0-9a-f-]{36})\/(send|cancel)$/u)
        : null;
    if (actionMatch) {
        assertMethod(request, ['POST']);
        assertSameOrigin(request);
        const [, campaignId, action] = actionMatch;
        return action === 'send'
            ? queueCampaign(request, env, campaignId, admin, surface)
            : cancelCampaign(request, env, campaignId, admin, surface);
    }

    throw new NewsletterError(404, '指定された管理APIはありません。', 'not_found');
}

async function adminSummary(env, admin, surface = 'mail') {
    const campaignFilter = surface === 'discord'
        ? "instr(',' || c.recipient_groups || ',', ',discord_approved,') > 0"
        : "(instr(',' || c.recipient_groups || ',', ',subscribers,') > 0 OR instr(',' || c.recipient_groups || ',', ',reuse_approved,') > 0)";
    const [databaseResults, awsDirectory] = await Promise.all([
        env.NEWSLETTER_DB.batch([
        env.NEWSLETTER_DB.prepare(
            `SELECT status, COUNT(*) AS count FROM newsletter_subscribers
             GROUP BY status ORDER BY status`,
        ),
        env.NEWSLETTER_DB.prepare(
            `SELECT
                SUM(CASE WHEN status = 'active' AND instr(',' || categories || ',', ',maintenance,') > 0 THEN 1 ELSE 0 END) AS maintenance_count,
                SUM(CASE WHEN status = 'active' AND instr(',' || categories || ',', ',outage,') > 0 THEN 1 ELSE 0 END) AS outage_count,
                SUM(CASE WHEN status = 'active' AND instr(',' || categories || ',', ',update,') > 0 THEN 1 ELSE 0 END) AS update_count,
                SUM(CASE WHEN status = 'active' AND (
                    instr(',' || categories || ',', ',maintenance,') > 0 OR
                    instr(',' || categories || ',', ',outage,') > 0
                ) THEN 1 ELSE 0 END) AS maintenance_outage_count,
                SUM(CASE WHEN status = 'active' AND (
                    instr(',' || categories || ',', ',maintenance,') > 0 OR
                    instr(',' || categories || ',', ',update,') > 0
                ) THEN 1 ELSE 0 END) AS maintenance_update_count,
                SUM(CASE WHEN status = 'active' AND (
                    instr(',' || categories || ',', ',outage,') > 0 OR
                    instr(',' || categories || ',', ',update,') > 0
                ) THEN 1 ELSE 0 END) AS outage_update_count,
                SUM(CASE WHEN status = 'active' AND (
                    instr(',' || categories || ',', ',maintenance,') > 0 OR
                    instr(',' || categories || ',', ',outage,') > 0 OR
                    instr(',' || categories || ',', ',update,') > 0
                ) THEN 1 ELSE 0 END) AS maintenance_outage_update_count
             FROM newsletter_subscribers`,
        ),
        env.NEWSLETTER_DB.prepare(
            `SELECT
                c.id, c.subject, c.body_text, c.category, c.status, c.created_by,
                c.recipient_groups, c.delivery_slots, c.target_server_ids, c.target_mode, c.deduplicate_channels,
                c.send_official_support, c.official_mention_role_id,
                c.delivery_format, c.embed_color, c.image_url, c.image_name, c.image_type, c.image_alt,
                c.external_sent_count, c.external_failed_count,
                c.created_at, c.updated_at, c.started_at, c.completed_at, c.recipient_count,
                COUNT(d.id) AS delivery_count,
                COALESCE(SUM(CASE WHEN d.status = 'sent' THEN 1 ELSE 0 END), 0) + c.external_sent_count AS sent_count,
                COALESCE(SUM(CASE WHEN d.status = 'failed' THEN 1 ELSE 0 END), 0) + c.external_failed_count AS failed_count,
                SUM(CASE WHEN d.status = 'skipped' THEN 1 ELSE 0 END) AS skipped_count,
                SUM(CASE WHEN d.status IN ('pending', 'queued', 'retry', 'sending') THEN 1 ELSE 0 END) AS remaining_count
             FROM newsletter_campaigns c
             LEFT JOIN newsletter_deliveries d ON d.campaign_id = c.id
             WHERE ${campaignFilter}
             GROUP BY c.id
             ORDER BY c.created_at DESC
             LIMIT 30`,
        ),
        env.NEWSLETTER_DB.prepare(
            `SELECT COUNT(DISTINCT lower(contact_email)) AS count
             FROM reuse_applications
             WHERE status = 'approved' AND trim(contact_email) <> ''`,
        ),
        env.NEWSLETTER_DB.prepare(
            `SELECT id, guild_id, guild_name, channel_id, channel_name, channel_mappings, delivery_types
             FROM reuse_applications
             WHERE status = 'approved'
             ORDER BY guild_name, updated_at DESC`,
        ),
        ]),
        surface === 'discord' ? loadAwsDiscordDirectory(env) : Promise.resolve({ configured: false, available: false, items: [] }),
    ]);
    const [statusRows, categoryRows, campaignRows, reuseRows, serverRows] = databaseResults;

    const categoryRow = categoryRows.results?.[0] || null;
    const audienceSelections = [
        ['maintenance'],
        ['outage'],
        ['update'],
        ['maintenance', 'outage'],
        ['maintenance', 'update'],
        ['outage', 'update'],
        ['maintenance', 'outage', 'update'],
    ];
    const statuses = Object.fromEntries(
        (statusRows.results || []).map((row) => [row.status, Number(row.count || 0)]),
    );
    return jsonResponse({
        success: true,
        surface,
        admin: admin.email,
        subscribers: {
            active: statuses.active || 0,
            pending: statuses.pending || 0,
            unsubscribed: statuses.unsubscribed || 0,
            bounced: statuses.bounced || 0,
            categories: Object.fromEntries(
                CATEGORY_ORDER.map((category) => [
                    category,
                    Number(categoryRow?.[`${category}_count`] || 0),
                ]),
            ),
            audiences: Object.fromEntries(
                audienceSelections.map((categories) => [
                    serializeCategories(categories),
                    Number(categoryRow?.[`${categories.join('_')}_count`] || 0),
                ]),
            ),
        },
        reuseUsers: {
            approved: Number(reuseRows.results?.[0]?.count || 0),
        },
        approvedServers: surface === 'discord'
            ? mergeApprovedServers(normalizeApprovedServers(serverRows.results || []), normalizeAwsDirectoryServers(awsDirectory.items))
            : normalizeApprovedServers(serverRows.results || []),
        discordDirectory: {
            configured: awsDirectory.configured,
            available: awsDirectory.available,
            webhookCount: Number(awsDirectory.webhookCount || 0),
            message: awsDirectory.message || '',
        },
        recipientGroups: RECIPIENT_GROUP_ORDER.map((id) => ({
            id,
            label: RECIPIENT_GROUPS[id],
        })),
        deliveryCatalog: deliveryCatalogWithAws(awsDirectory.items),
        campaigns: (campaignRows.results || []).map(normalizeCampaignRow),
        limits: { maxRecipientsPerCampaign: MAX_CAMPAIGN_RECIPIENTS },
    });
}

async function createCampaign(request, env, admin, surface = 'mail') {
    const input = await readCampaignInput(request, surface);
    const subject = validateCampaignSubject(input.subject);
    const bodyText = validateCampaignBody(input.body);
    const categories = Array.isArray(input.categories)
        ? validateCategories(input.categories)
        : [validateSingleCategory(input.category)];
    const category = serializeCategories(categories);
    const recipientGroups = validateSurfaceRecipientGroups(input.recipientGroups, surface);
    const awsDirectory = surface === 'discord' ? await loadAwsDiscordDirectory(env) : { items: [] };
    const targeting = surface === 'discord'
        ? validateDiscordTargeting(input, recipientGroups, allowedDeliverySlotIds(awsDirectory.items))
        : {
            targetMode: 'delivery_slots',
            deliverySlots: validateDeliverySlots(input.deliverySlots, allowedDeliverySlotIds(awsDirectory.items)),
            targetServerIds: validateTargetServerIds(input.targetServerIds, recipientGroups),
            deduplicateChannels: true,
        };
    const { targetMode, deliverySlots, targetServerIds, deduplicateChannels } = targeting;
    const officialSupport = surface === 'discord'
        ? validateOfficialSupportOptions(input)
        : { sendOfficialSupport: false, officialMentionRoleId: '' };
    const discordOptions = validateDiscordOptions(input, recipientGroups);
    validateDiscordAnnouncement(subject, bodyText, recipientGroups, {
        ...discordOptions,
        mentionRoleId: officialSupport.officialMentionRoleId,
    });
    const now = new Date().toISOString();
    const campaignId = crypto.randomUUID();

    if (surface === 'discord') {
        const audience = await callAwsDirectoryAction(env, {
            action: 'discord-announcement-preview',
            actor: admin.email,
            requestId: crypto.randomUUID(),
            targetMode,
            deliverySlots,
            targetServerIds,
            deduplicateChannels,
        });
        if (Number(audience.targetCount || 0) === 0) {
            throw new NewsletterError(409, '選択条件に一致する有効なDiscord Webhookがありません。', 'discord_no_targets');
        }
    }

    await env.NEWSLETTER_DB.prepare(
        `INSERT INTO newsletter_campaigns (
            id, subject, body_text, category, recipient_groups, delivery_slots, target_server_ids,
            target_mode, deduplicate_channels, send_official_support, official_mention_role_id,
            delivery_format, embed_color, image_url, image_name, image_type, image_data, image_alt,
            status, created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    ).bind(
        campaignId,
        subject,
        bodyText,
        category,
        serializeCsv(recipientGroups),
        serializeCsv(deliverySlots),
        serializeCsv(targetServerIds),
        targetMode,
        deduplicateChannels ? 1 : 0,
        officialSupport.sendOfficialSupport ? 1 : 0,
        officialSupport.officialMentionRoleId,
        discordOptions.format,
        discordOptions.embedColor,
        discordOptions.imageUrl,
        discordOptions.image?.name || null,
        discordOptions.image?.type || null,
        discordOptions.image?.bytes || null,
        discordOptions.imageAlt,
        admin.email,
        now,
        now,
    ).run();

    await recordAdminAudit(env, {
        actor: admin.email,
        action: 'campaign_created',
        entityType: 'newsletter_campaign',
        entityId: campaignId,
        details: {
            categories,
            recipientGroups,
            deliverySlots,
            targetServerIds,
            targetMode,
            deduplicateChannels,
            ...officialSupport,
            deliveryFormat: discordOptions.format,
            hasImage: Boolean(discordOptions.image || discordOptions.imageUrl),
        },
    });

    return jsonResponse({
        success: true,
        campaign: {
            id: campaignId,
            subject,
            body: bodyText,
            category,
            categories,
            recipientGroups,
            deliverySlots,
            targetServerIds,
            targetMode,
            deduplicateChannels,
            ...officialSupport,
            deliveryFormat: discordOptions.format,
            embedColor: discordOptions.embedColor,
            imageUrl: discordOptions.imageUrl,
            imageName: discordOptions.image?.name || null,
            imageAlt: discordOptions.imageAlt,
            status: 'draft',
            createdAt: now,
        },
    }, 201);
}

async function previewCampaign(request, env, surface = 'mail') {
    const input = await readJson(request, MAX_JSON_BYTES);
    const subject = validateCampaignSubject(input.subject);
    const bodyText = validateCampaignBody(input.body);
    const categories = validateCategories(input.categories);
    const recipientGroups = validateSurfaceRecipientGroups(input.recipientGroups, surface);
    const awsDirectory = surface === 'discord' ? await loadAwsDiscordDirectory(env) : { items: [] };
    const targeting = surface === 'discord'
        ? validateDiscordTargeting(input, recipientGroups, allowedDeliverySlotIds(awsDirectory.items))
        : {
            deliverySlots: validateDeliverySlots(input.deliverySlots, allowedDeliverySlotIds(awsDirectory.items)),
            targetServerIds: validateTargetServerIds(input.targetServerIds, recipientGroups),
        };
    const { deliverySlots } = targeting;
    const discordOptions = validateDiscordOptions(input, recipientGroups, { allowImageMetadataOnly: true });
    const officialSupport = surface === 'discord'
        ? validateOfficialSupportOptions(input)
        : { sendOfficialSupport: false, officialMentionRoleId: '' };
    validateDiscordAnnouncement(subject, bodyText, recipientGroups, {
        ...discordOptions,
        mentionRoleId: officialSupport.officialMentionRoleId,
    });
    const previewMail = buildCampaignEmail({
        campaign_id: 'preview',
        category: serializeCategories(categories),
        subject,
        body_text: bodyText,
        recipient_kind: recipientGroups.includes('reuse_approved') ? 'reuse_approved' : 'subscriber',
        delivery_slots: serializeCsv(deliverySlots),
        email: 'preview@example.invalid',
    }, recipientGroups.includes('subscribers') ? 'preview.preview' : null, env);

    return jsonResponse({
        success: true,
        html: previewMail.html,
        text: previewMail.text,
        discord: surface === 'discord' ? buildDiscordPayload(subject, bodyText, {
            ...discordOptions,
            mentionRoleId: officialSupport.officialMentionRoleId,
        }) : null,
    });
}

async function previewAudience(request, env, admin, surface = 'mail') {
    const input = await readJson(request, MAX_FORM_BYTES);
    const categories = surface === 'discord' ? [] : validateCategories(input.categories);
    const recipientGroups = validateSurfaceRecipientGroups(input.recipientGroups, surface);
    const awsDirectory = surface === 'discord' ? await loadAwsDiscordDirectory(env) : { items: [] };
    if (surface === 'discord') {
        const officialSupport = validateOfficialSupportOptions(input);
        const { targetMode, deliverySlots, targetServerIds, deduplicateChannels } = validateDiscordTargeting(
            input,
            recipientGroups,
            allowedDeliverySlotIds(awsDirectory.items),
        );
        const preview = await callAwsDirectoryAction(env, {
            action: 'discord-announcement-preview',
            actor: admin.email,
            requestId: crypto.randomUUID(),
            targetMode,
            deliverySlots,
            targetServerIds,
            deduplicateChannels,
        });
        return jsonResponse({
            success: true,
            count: Number(preview.targetCount || 0) + (officialSupport.sendOfficialSupport ? 1 : 0),
            byKind: {
                discord_webhook: Number(preview.targetCount || 0),
                official_support: officialSupport.sendOfficialSupport ? 1 : 0,
            },
            byDelivery: preview.byDelivery || {},
            targetMode,
            deduplicateChannels,
            ...officialSupport,
        });
    }
    const deliverySlots = validateDeliverySlots(input.deliverySlots, allowedDeliverySlotIds(awsDirectory.items));
    const targetServerIds = validateTargetServerIds(input.targetServerIds, recipientGroups);
    const recipients = await loadCampaignRecipients(env, {
        recipient_groups: serializeCsv(recipientGroups),
        delivery_slots: serializeCsv(deliverySlots),
        target_server_ids: serializeCsv(targetServerIds),
    }, categories);
    const byKind = recipients.reduce((counts, recipient) => {
        counts[recipient.kind] = (counts[recipient.kind] || 0) + 1;
        return counts;
    }, {});
    return jsonResponse({ success: true, count: recipients.length, byKind });
}

async function queueCampaign(request, env, campaignId, admin, surface = 'mail') {
    if (surface !== 'discord' && (!env.NEWSLETTER_QUEUE || typeof env.NEWSLETTER_QUEUE.sendBatch !== 'function')) {
        throw new NewsletterError(503, '配信Queueが設定されていません。', 'queue_not_configured');
    }

    const input = await readJson(request, MAX_FORM_BYTES);
    if (input.confirmation !== campaignId) {
        throw new NewsletterError(400, '配信確認が一致しません。', 'campaign_confirmation_mismatch');
    }

    const campaign = await env.NEWSLETTER_DB.prepare(
        `SELECT id, subject, body_text, category, recipient_groups, delivery_slots, target_server_ids,
                target_mode, deduplicate_channels, send_official_support, official_mention_role_id, official_message_id,
                delivery_format, embed_color, image_url, image_name, image_type, image_data, image_alt,
                status, updated_at
         FROM newsletter_campaigns WHERE id = ?`,
    ).bind(campaignId).first();
    if (!campaign) throw new NewsletterError(404, '配信データが見つかりません。', 'campaign_not_found');
    assertCampaignSurface(campaign, surface);
    if (!['draft', 'queuing'].includes(campaign.status)) {
        throw new NewsletterError(409, 'この配信は開始済みか、取り消されています。', 'campaign_not_sendable');
    }

    const campaignCategories = parseSerializedCategories(campaign.category);
    if (campaignCategories.length === 0) {
        throw new NewsletterError(409, '配信カテゴリが正しくありません。', 'campaign_category_invalid');
    }
    const campaignGroups = validateRecipientGroups(parseCsv(campaign.recipient_groups));
    const campaignOfficialSupport = validateOfficialSupportOptions({
        sendOfficialSupport: Number(campaign.send_official_support || 0) !== 0,
        officialMentionRoleId: campaign.official_mention_role_id,
    });
    validateDiscordAnnouncement(campaign.subject, campaign.body_text, campaignGroups, {
        format: campaign.delivery_format,
        embedColor: campaign.embed_color,
        imageUrl: campaign.image_url,
        imageAlt: campaign.image_alt,
        mentionRoleId: campaignOfficialSupport.officialMentionRoleId,
    });
    if (surface === 'discord') {
        return dispatchAwsDiscordCampaign(env, campaign, campaignId, admin);
    }
    const recipients = await loadCampaignRecipients(env, campaign, campaignCategories);
    const eligibleCount = recipients.length;
    if (eligibleCount > MAX_CAMPAIGN_RECIPIENTS) {
        throw new NewsletterError(
            409,
            `配信対象が上限の${MAX_CAMPAIGN_RECIPIENTS}件を超えています。`,
            'recipient_limit_exceeded',
        );
    }

    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const lockCutoff = new Date(nowMs - 30_000).toISOString();
    const lockResult = await env.NEWSLETTER_DB.prepare(
        `UPDATE newsletter_campaigns SET status = 'queuing', updated_at = ?,
            started_at = COALESCE(started_at, ?), recipient_count = ?
         WHERE id = ? AND (status = 'draft' OR (status = 'queuing' AND updated_at <= ?))`,
    ).bind(now, now, eligibleCount, campaignId, lockCutoff).run();
    if (!statementChangedRows(lockResult)) {
        throw new NewsletterError(409, '現在Queueへ登録中です。30秒後に状態を更新してください。', 'campaign_queue_locked');
    }

    if (eligibleCount === 0) {
        await env.NEWSLETTER_DB.prepare(
            `UPDATE newsletter_campaigns SET status = 'completed', completed_at = ?, updated_at = ?
             WHERE id = ?`,
        ).bind(now, now, campaignId).run();
        return jsonResponse({ success: true, campaignId, queued: 0 });
    }

    for (let offset = 0; offset < recipients.length; offset += QUEUE_BATCH_SIZE) {
        const chunk = recipients.slice(offset, offset + QUEUE_BATCH_SIZE);
        await env.NEWSLETTER_DB.batch(chunk.map((recipient) => env.NEWSLETTER_DB.prepare(
            `INSERT OR IGNORE INTO newsletter_deliveries (
                id, campaign_id, subscriber_id, status, attempts, created_at, updated_at,
                recipient_email, recipient_kind, recipient_reference
             ) VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`,
        ).bind(
            crypto.randomUUID(),
            campaignId,
            recipient.subscriberId,
            now,
            now,
            recipient.email,
            recipient.kind,
            recipient.reference,
        )));
    }

    const pendingRows = await env.NEWSLETTER_DB.prepare(
        `SELECT id FROM newsletter_deliveries
         WHERE campaign_id = ? AND status = 'pending'
         ORDER BY id LIMIT ?`,
    ).bind(campaignId, MAX_CAMPAIGN_RECIPIENTS + 1).all();
    const pending = pendingRows.results || [];
    if (pending.length > MAX_CAMPAIGN_RECIPIENTS) {
        throw new NewsletterError(409, 'Queue登録件数が安全上限を超えました。', 'queue_limit_exceeded');
    }

    let queued = 0;
    for (let offset = 0; offset < pending.length; offset += QUEUE_BATCH_SIZE) {
        const chunk = pending.slice(offset, offset + QUEUE_BATCH_SIZE);
        await env.NEWSLETTER_QUEUE.sendBatch(chunk.map((delivery) => ({
            body: { version: 1, deliveryId: delivery.id, campaignId },
        })));
        await markDeliveriesQueued(env.NEWSLETTER_DB, chunk.map((delivery) => delivery.id), now);
        queued += chunk.length;
    }

    await env.NEWSLETTER_DB.prepare(
        `UPDATE newsletter_campaigns SET status = 'sending', updated_at = ? WHERE id = ?`,
    ).bind(new Date().toISOString(), campaignId).run();

    await recordAdminAudit(env, {
        actor: admin.email,
        action: 'campaign_started',
        entityType: 'newsletter_campaign',
        entityId: campaignId,
        details: { queued, eligibleCount },
    });

    return jsonResponse({ success: true, campaignId, queued });
}

async function dispatchAwsDiscordCampaign(env, campaign, campaignId, admin) {
    const directory = await loadAwsDiscordDirectory(env);
    if (!directory.available) {
        throw new NewsletterError(503, directory.message || 'AWS配信先ディレクトリを取得できません。', 'aws_directory_unavailable');
    }
    const { targetMode, deliverySlots, targetServerIds, deduplicateChannels } = validateDiscordTargeting({
        targetMode: campaign.target_mode,
        deliverySlots: parseCsv(campaign.delivery_slots),
        targetServerIds: parseCsv(campaign.target_server_ids),
        deduplicateChannels: Number(campaign.deduplicate_channels ?? 1) !== 0,
    }, ['discord_approved'], allowedDeliverySlotIds(directory.items));
    const officialSupport = validateOfficialSupportOptions({
        sendOfficialSupport: Number(campaign.send_official_support || 0) !== 0,
        officialMentionRoleId: campaign.official_mention_role_id,
    });
    const now = new Date().toISOString();
    const lock = await env.NEWSLETTER_DB.prepare(
        `UPDATE newsletter_campaigns SET status = 'sending', updated_at = ?, started_at = COALESCE(started_at, ?)
         WHERE id = ? AND status IN ('draft', 'queuing')`,
    ).bind(now, now, campaignId).run();
    if (!statementChangedRows(lock)) {
        throw new NewsletterError(409, 'この配信は開始済みです。', 'campaign_queue_locked');
    }

    const imageData = normalizeBinaryData(campaign.image_data);
    try {
        let officialMessageId = stringValue(campaign.official_message_id).trim();
        if (officialSupport.sendOfficialSupport && !officialMessageId) {
            try {
                const officialMessage = await sendDiscordAnnouncement(
                    OFFICIAL_SUPPORT_CHANNEL_ID,
                    campaign.subject,
                    campaign.body_text,
                    env,
                    {
                        format: campaign.delivery_format,
                        embedColor: Number(campaign.embed_color ?? DEFAULT_DISCORD_EMBED_COLOR),
                        imageUrl: stringValue(campaign.image_url),
                        imageName: stringValue(campaign.image_name),
                        imageType: stringValue(campaign.image_type),
                        imageData,
                        imageAlt: stringValue(campaign.image_alt),
                        mentionRoleId: officialSupport.officialMentionRoleId,
                        nonce: campaignId.replaceAll('-', '').slice(0, 25),
                    },
                );
                officialMessageId = stringValue(officialMessage?.id).trim();
                if (!/^\d{17,20}$/u.test(officialMessageId)) {
                    throw new Error('official_discord_message_id_missing');
                }
                await env.NEWSLETTER_DB.prepare(
                    `UPDATE newsletter_campaigns SET official_message_id = ?, updated_at = ? WHERE id = ?`,
                ).bind(officialMessageId, new Date().toISOString(), campaignId).run();
            } catch (error) {
                if (error?.code === 'DISCORD_NOT_CONFIGURED') {
                    throw new NewsletterError(503, '公式サポートサーバーへの送信設定がありません。', 'official_discord_not_configured');
                }
                throw new NewsletterError(502, '公式サポートサーバーへの送信に失敗しました。Botの権限とチャンネル設定を確認してください。', 'official_discord_delivery_failed');
            }
        }
        const result = await callAwsDirectoryAction(env, {
            action: 'discord-announcement',
            actor: admin.email,
            requestId: campaignId,
            confirmation: campaignId,
            targetMode,
            deliverySlots,
            targetServerIds,
            deduplicateChannels,
            subject: campaign.subject,
            body: campaign.body_text,
            deliveryFormat: campaign.delivery_format,
            embedColor: Number(campaign.embed_color ?? DEFAULT_DISCORD_EMBED_COLOR),
            imageUrl: stringValue(campaign.image_url),
            imageName: stringValue(campaign.image_name),
            imageType: stringValue(campaign.image_type),
            imageAlt: stringValue(campaign.image_alt),
            imageBase64: imageData ? bytesToBase64(imageData) : '',
        }, 125_000);
        const officialCount = officialSupport.sendOfficialSupport && officialMessageId ? 1 : 0;
        const targetCount = Number(result.targetCount || 0) + officialCount;
        const sentCount = Number(result.sentCount || 0) + officialCount;
        const failedCount = Number(result.failedCount || 0);
        if (targetCount === 0) {
            throw new NewsletterError(409, '選択条件に一致する有効なDiscord Webhookがありません。', 'discord_no_targets');
        }
        if (result.allFailed === true || (sentCount === 0 && failedCount > 0)) {
            const failureText = formatDiscordFailureSummary(result.failureSummary);
            throw new NewsletterError(
                502,
                `Discord配信が全件失敗しました${failureText ? `（${failureText}）` : ''}。設定を確認して再試行してください。`,
                'discord_delivery_failed',
            );
        }
        const completedAt = new Date().toISOString();
        await env.NEWSLETTER_DB.prepare(
            `UPDATE newsletter_campaigns SET status = 'completed', recipient_count = ?,
                external_sent_count = ?, external_failed_count = ?, completed_at = ?, updated_at = ?
             WHERE id = ?`,
        ).bind(targetCount, sentCount, failedCount, completedAt, completedAt, campaignId).run();
        await recordAdminAudit(env, {
            actor: admin.email,
            action: 'campaign_started',
            entityType: 'newsletter_campaign',
            entityId: campaignId,
            details: { targetCount, sentCount, failedCount, targetMode, deliverySlots, targetServerIds, deduplicateChannels, ...officialSupport },
        });
        return jsonResponse({ success: true, campaignId, queued: targetCount, targetCount, sentCount, failedCount, status: 'completed' });
    } catch (error) {
        await env.NEWSLETTER_DB.prepare(
            `UPDATE newsletter_campaigns SET status = 'draft', updated_at = ? WHERE id = ? AND status = 'sending'`,
        ).bind(new Date().toISOString(), campaignId).run();
        throw error;
    }
}

async function callAwsDirectoryAction(env, payload, timeoutMs = 20_000) {
    const endpoint = cleanConfigValue(env.AWS_CHANNEL_DIRECTORY_URL);
    const token = cleanConfigValue(env.AWS_CHANNEL_DIRECTORY_TOKEN);
    if (!endpoint || !token) {
        throw new NewsletterError(503, 'AWS配信先ディレクトリが設定されていません。', 'aws_directory_not_configured');
    }
    let response;
    try {
        response = await fetch(endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch {
        throw new NewsletterError(503, 'AWS配信先ディレクトリに接続できません。', 'aws_directory_unavailable');
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.success !== true) {
        throw new NewsletterError(response.status >= 500 ? 503 : 400, result.message || 'AWS側の配信処理に失敗しました。', 'aws_directory_action_failed');
    }
    return result;
}

function formatDiscordFailureSummary(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    return Object.entries(value)
        .filter(([reason, count]) => /^[A-Z0-9_]{2,80}$/u.test(reason) && Number.isFinite(Number(count)))
        .sort((left, right) => Number(right[1]) - Number(left[1]))
        .slice(0, 3)
        .map(([reason, count]) => `${discordFailureReasonLabel(reason)}: ${Number(count)}件`)
        .join('、');
}

function discordFailureReasonLabel(reason) {
    if (reason.startsWith('HTTP_404')) return '削除済み・無効なWebhook';
    if (reason.startsWith('HTTP_401')) return 'Webhook認証エラー';
    if (reason.startsWith('HTTP_403')) return 'Discordによる送信拒否';
    if (reason.startsWith('HTTP_429')) return 'Discordレート制限';
    if (/^HTTP_5\d\d/u.test(reason)) return 'Discord一時障害';
    if (reason === 'NETWORK_TIMEOUT') return 'Discord接続タイムアウト';
    if (reason === 'NETWORK_ERROR') return 'Discord接続エラー';
    if (reason === 'DELIVERY_DEADLINE') return '配信処理の時間上限';
    return reason;
}

async function loadAwsDiscordDirectory(env) {
    const endpoint = cleanConfigValue(env.AWS_CHANNEL_DIRECTORY_URL);
    const token = cleanConfigValue(env.AWS_CHANNEL_DIRECTORY_TOKEN);
    if (!endpoint || !token) return { configured: false, available: false, items: [], webhookCount: 0, message: 'AWS配信先ディレクトリが未設定です。' };
    try {
        const url = new URL(endpoint);
        url.searchParams.set('limit', 'all');
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            signal: AbortSignal.timeout(15_000),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result.success !== true || !Array.isArray(result.items)) throw new Error('invalid_response');
        const items = result.items.map(normalizeAwsDirectoryItem).filter(Boolean);
        const fallbackWebhookCount = new Set(items.filter((item) => item.hasWebhook).map((item) => item.channelId).filter(Boolean)).size;
        return {
            configured: true,
            available: true,
            items,
            webhookCount: Number.isFinite(Number(result.webhookCount)) ? Number(result.webhookCount) : fallbackWebhookCount,
            message: '',
        };
    } catch {
        return { configured: true, available: false, items: [], webhookCount: 0, message: 'AWS配信先ディレクトリを取得できません。' };
    }
}

async function cancelCampaign(request, env, campaignId, admin, surface = 'mail') {
    const input = await readJson(request, MAX_FORM_BYTES);
    if (input.confirmation !== campaignId) {
        throw new NewsletterError(400, '取消確認が一致しません。', 'campaign_confirmation_mismatch');
    }

    const campaign = await env.NEWSLETTER_DB.prepare(
        'SELECT recipient_groups FROM newsletter_campaigns WHERE id = ?',
    ).bind(campaignId).first();
    if (!campaign) throw new NewsletterError(404, '配信データが見つかりません。', 'campaign_not_found');
    assertCampaignSurface(campaign, surface);

    const now = new Date().toISOString();
    const campaignResult = await env.NEWSLETTER_DB.prepare(
        `UPDATE newsletter_campaigns SET status = 'cancelled', completed_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('draft', 'queuing', 'sending')`,
    ).bind(now, now, campaignId).run();
    if (!statementChangedRows(campaignResult)) {
        throw new NewsletterError(409, 'この配信は取り消せません。', 'campaign_not_cancellable');
    }

    await env.NEWSLETTER_DB.prepare(
        `UPDATE newsletter_deliveries SET status = 'skipped', updated_at = ?
         WHERE campaign_id = ? AND status IN ('pending', 'queued', 'retry')`,
    ).bind(now, campaignId).run();
    await recordAdminAudit(env, {
        actor: admin.email,
        action: 'campaign_cancelled',
        entityType: 'newsletter_campaign',
        entityId: campaignId,
        details: {},
    });
    return jsonResponse({ success: true, campaignId, status: 'cancelled' });
}

async function markDeliveriesQueued(database, deliveryIds, now) {
    if (deliveryIds.length === 0) return;
    const placeholders = deliveryIds.map(() => '?').join(', ');
    await database.prepare(
        `UPDATE newsletter_deliveries SET status = 'queued', queued_at = ?, updated_at = ?
         WHERE id IN (${placeholders}) AND status = 'pending'`,
    ).bind(now, now, ...deliveryIds).run();
}

async function loadCampaignRecipients(env, campaign, campaignCategories) {
    const storedGroups = parseCsv(campaign.recipient_groups);
    const storedSlots = parseCsv(campaign.delivery_slots);
    const groups = validateRecipientGroups(storedGroups.length ? storedGroups : undefined);
    const deliverySlots = validateDeliverySlots(storedSlots.length ? storedSlots : undefined);
    const targetServerIds = validateTargetServerIds(parseCsv(campaign.target_server_ids), groups);
    const recipientsByEmail = new Map();

    if (groups.includes('subscribers')) {
        const categoryMatchSql = campaignCategories
            .map(() => "instr(',' || categories || ',', ',' || ? || ',') > 0")
            .join(' OR ');
        const rows = await env.NEWSLETTER_DB.prepare(
            `SELECT id, email FROM newsletter_subscribers
             WHERE status = 'active' AND (${categoryMatchSql})
             ORDER BY updated_at DESC`,
        ).bind(...campaignCategories).all();
        for (const row of rows.results || []) {
            const email = validateEmail(row.email);
            recipientsByEmail.set(email.toLowerCase(), {
                email,
                kind: 'subscriber',
                subscriberId: row.id,
                reference: row.id,
            });
        }
    }

    if (groups.includes('reuse_approved')) {
        const rows = await env.NEWSLETTER_DB.prepare(
            `SELECT id, contact_email, delivery_types, updated_at
             FROM reuse_applications
             WHERE status = 'approved' AND trim(contact_email) <> ''
             ORDER BY updated_at DESC`,
        ).all();
        const allReuseUsers = deliverySlots.includes('DPI_Bot通知');
        for (const row of rows.results || []) {
            const appliedSlots = parseStringArray(row.delivery_types);
            if (!allReuseUsers && !appliedSlots.some((slot) => deliverySlots.includes(slot))) continue;
            let email;
            try {
                email = validateEmail(row.contact_email);
            } catch {
                continue;
            }
            const key = email.toLowerCase();
            if (recipientsByEmail.has(key)) continue;
            recipientsByEmail.set(key, {
                email,
                kind: 'reuse_approved',
                subscriberId: `reuse:${row.id}`,
                reference: row.id,
            });
        }
    }

    const recipients = [...recipientsByEmail.values()];
    if (groups.includes('discord_approved')) {
        const rows = await env.NEWSLETTER_DB.prepare(
            `SELECT id, guild_id, guild_name, channel_id, channel_name, channel_mappings, delivery_types
             FROM reuse_applications
             WHERE status = 'approved'
             ORDER BY updated_at DESC`,
        ).all();
        const channels = new Map();
        const allSlots = deliverySlots.includes('DPI_Bot通知');
        for (const row of rows.results || []) {
            for (const target of applicationChannelTargets(row)) {
                if (!targetServerIds.includes(target.serverId)) continue;
                if (!allSlots && !target.deliveryTypes.some((slot) => deliverySlots.includes(slot))) continue;
                if (!/^\d{17,20}$/u.test(target.channelId) || channels.has(target.channelId)) continue;
                channels.set(target.channelId, {
                    email: null,
                    kind: 'discord_approved',
                    subscriberId: `discord:${target.channelId}`,
                    reference: row.id,
                });
            }
        }
        recipients.push(...channels.values());
    }

    return recipients;
}

async function processDeliveryMessage(message, env) {
    const body = message?.body;
    if (
        !body
        || body.version !== 1
        || typeof body.deliveryId !== 'string'
        || typeof body.campaignId !== 'string'
    ) {
        console.error('Discarding malformed newsletter queue message');
        if (typeof message.ack === 'function') message.ack();
        return;
    }

    await ensureSchema(env);
    const delivery = await env.NEWSLETTER_DB.prepare(
        `SELECT
            d.id, d.campaign_id, d.subscriber_id, d.status, d.attempts, d.updated_at,
            d.recipient_kind, d.recipient_reference,
            c.subject, c.body_text, c.category, c.delivery_slots, c.status AS campaign_status,
            c.delivery_format, c.embed_color, c.image_url, c.image_name, c.image_type, c.image_data, c.image_alt,
            COALESCE(d.recipient_email, s.email) AS email,
            s.status AS subscriber_status, s.categories,
            CASE WHEN d.recipient_kind IN ('reuse_approved', 'discord_approved') THEN EXISTS (
                SELECT 1 FROM reuse_applications r
                WHERE r.status = 'approved'
                  AND (
                    (d.recipient_kind = 'reuse_approved' AND lower(r.contact_email) = lower(COALESCE(d.recipient_email, '')))
                    OR (d.recipient_kind = 'discord_approved' AND r.id = d.recipient_reference)
                  )
            ) ELSE 1 END AS recipient_still_eligible
         FROM newsletter_deliveries d
         JOIN newsletter_campaigns c ON c.id = d.campaign_id
         LEFT JOIN newsletter_subscribers s ON s.id = d.subscriber_id
         WHERE d.id = ? AND d.campaign_id = ?`,
    ).bind(body.deliveryId, body.campaignId).first();

    if (!delivery) {
        if (typeof message.ack === 'function') message.ack();
        return;
    }

    if (delivery.status === 'sending') {
        const sendingSince = Date.parse(delivery.updated_at || '');
        if (Number.isFinite(sendingSince) && Date.now() - sendingSince < 2 * 60 * 1_000) {
            if (typeof message.retry === 'function') message.retry({ delaySeconds: 120 });
            return;
        }
        await env.NEWSLETTER_DB.prepare(
            `UPDATE newsletter_deliveries SET status = 'retry', updated_at = ?
             WHERE id = ? AND status = 'sending'`,
        ).bind(new Date().toISOString(), delivery.id).run();
        delivery.status = 'retry';
    }

    if (!['pending', 'queued', 'retry'].includes(delivery.status)) {
        if (typeof message.ack === 'function') message.ack();
        return;
    }

    const now = new Date().toISOString();
    const isSubscriber = !['reuse_approved', 'discord_approved'].includes(delivery.recipient_kind);
    const isDiscord = delivery.recipient_kind === 'discord_approved';
    if (
        delivery.campaign_status === 'cancelled'
        || (!isSubscriber && Number(delivery.recipient_still_eligible) !== 1)
        || (
            isSubscriber
            && (
                delivery.subscriber_status !== 'active'
                || !serializedCategoriesOverlap(delivery.categories, delivery.category)
            )
        )
    ) {
        await env.NEWSLETTER_DB.prepare(
            `UPDATE newsletter_deliveries SET status = 'skipped', updated_at = ?
             WHERE id = ? AND status IN ('pending', 'queued', 'retry')`,
        ).bind(now, delivery.id).run();
        await updateCampaignCompletion(env.NEWSLETTER_DB, delivery.campaign_id);
        if (typeof message.ack === 'function') message.ack();
        return;
    }

    const nextAttempt = Number(delivery.attempts || 0) + 1;
    const claim = await env.NEWSLETTER_DB.prepare(
        `UPDATE newsletter_deliveries SET status = 'sending', attempts = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'queued', 'retry')`,
    ).bind(nextAttempt, now, delivery.id).run();
    if (!statementChangedRows(claim)) {
        if (typeof message.ack === 'function') message.ack();
        return;
    }

    try {
        if (isDiscord) {
            const channelId = stringValue(delivery.subscriber_id).replace(/^discord:/u, '');
            const result = await sendDiscordAnnouncement(channelId, delivery.subject, delivery.body_text, env, {
                format: delivery.delivery_format,
                embedColor: delivery.embed_color,
                imageUrl: delivery.image_url,
                imageName: delivery.image_name,
                imageType: delivery.image_type,
                imageData: delivery.image_data,
                imageAlt: delivery.image_alt,
            });
            const sentAt = new Date().toISOString();
            await env.NEWSLETTER_DB.prepare(
                `UPDATE newsletter_deliveries SET
                    status = 'sent', message_id = ?, last_error_code = NULL,
                    sent_at = ?, updated_at = ?
                 WHERE id = ?`,
            ).bind(stringValue(result?.id).slice(0, 200), sentAt, sentAt, delivery.id).run();
            await updateCampaignCompletion(env.NEWSLETTER_DB, delivery.campaign_id);
            if (typeof message.ack === 'function') message.ack();
            return;
        }
        assertDeliveryConfigured(env);
        const unsubscribeToken = isSubscriber
            ? await createUnsubscribeToken(
                { id: delivery.subscriber_id, email: delivery.email },
                env.NEWSLETTER_TOKEN_SECRET,
            )
            : null;
        const mail = buildCampaignEmail(delivery, unsubscribeToken, env);
        const result = await env.NOTICE_EMAIL.send(mail);
        const sentAt = new Date().toISOString();
        await env.NEWSLETTER_DB.prepare(
            `UPDATE newsletter_deliveries SET
                status = 'sent', message_id = ?, last_error_code = NULL,
                sent_at = ?, updated_at = ?
             WHERE id = ?`,
        ).bind(stringValue(result?.messageId).slice(0, 200), sentAt, sentAt, delivery.id).run();
        await updateCampaignCompletion(env.NEWSLETTER_DB, delivery.campaign_id);
        if (typeof message.ack === 'function') message.ack();
    } catch (error) {
        const errorCode = safeErrorCode(error);
        const isPermanent = error?.permanent === true || (!isDiscord && isPermanentEmailError(errorCode));
        const exhausted = nextAttempt >= MAX_DELIVERY_ATTEMPTS;
        const status = isPermanent || exhausted ? 'failed' : 'retry';
        const failedAt = new Date().toISOString();
        await env.NEWSLETTER_DB.prepare(
            `UPDATE newsletter_deliveries SET status = ?, last_error_code = ?, updated_at = ?
             WHERE id = ?`,
        ).bind(status, errorCode, failedAt, delivery.id).run();

        if (errorCode === 'E_RECIPIENT_SUPPRESSED' && isSubscriber) {
            await env.NEWSLETTER_DB.prepare(
                `UPDATE newsletter_subscribers SET status = 'bounced', updated_at = ? WHERE id = ?`,
            ).bind(failedAt, delivery.subscriber_id).run();
        }

        console.error('Newsletter delivery failed', {
            campaignId: delivery.campaign_id,
            deliveryId: delivery.id,
            attempt: nextAttempt,
            errorCode,
        });

        if (status === 'retry' && typeof message.retry === 'function') {
            message.retry({ delaySeconds: Math.min(3_600, 60 * (2 ** (nextAttempt - 1))) });
        } else {
            await updateCampaignCompletion(env.NEWSLETTER_DB, delivery.campaign_id);
            if (typeof message.ack === 'function') message.ack();
        }
    }
}

async function recordAdminAudit(env, {
    actor,
    action,
    entityType,
    entityId = null,
    details = {},
}) {
    try {
        await env.NEWSLETTER_DB.prepare(
            `INSERT INTO admin_audit_events
                (id, actor, action, entity_type, entity_id, details_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
            crypto.randomUUID(),
            String(actor || '').slice(0, 320),
            String(action || '').slice(0, 100),
            String(entityType || '').slice(0, 100),
            entityId ? String(entityId).slice(0, 200) : null,
            JSON.stringify(details).slice(0, 8_000),
            new Date().toISOString(),
        ).run();
    } catch (error) {
        console.error('Admin audit write failed', {
            action,
            entityType,
            errorName: error?.name || 'Error',
        });
    }
}

async function updateCampaignCompletion(database, campaignId) {
    const now = new Date().toISOString();
    await database.prepare(
        `UPDATE newsletter_campaigns SET status = 'completed', completed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'sending'
           AND NOT EXISTS (
               SELECT 1 FROM newsletter_deliveries
               WHERE campaign_id = ? AND status IN ('pending', 'queued', 'retry', 'sending')
           )`,
    ).bind(now, now, campaignId, campaignId).run();
}

async function ensureSchema(env) {
    assertDatabaseConfigured(env);
    const database = env.NEWSLETTER_DB;
    let initialization = schemaInitialization.get(database);
    if (!initialization) {
        initialization = database
            .batch(SCHEMA_STATEMENTS.map((statement) => database.prepare(statement)))
            .then(() => ensureDiscordCampaignColumns(database))
            .catch((error) => {
                schemaInitialization.delete(database);
                throw error;
            });
        schemaInitialization.set(database, initialization);
    }
    await initialization;
}

async function ensureDiscordCampaignColumns(database) {
    const statement = database.prepare('PRAGMA table_info(newsletter_campaigns)');
    if (typeof statement.all !== 'function') return;
    const result = await statement.all();
    const existing = new Set((result.results || []).map((column) => column.name));
    const additions = [
        ['delivery_format', "TEXT NOT NULL DEFAULT 'message'"],
        ['embed_color', 'INTEGER NOT NULL DEFAULT 5793266'],
        ['image_url', 'TEXT'],
        ['image_name', 'TEXT'],
        ['image_type', 'TEXT'],
        ['image_data', 'BLOB'],
        ['image_alt', 'TEXT'],
        ['external_sent_count', 'INTEGER NOT NULL DEFAULT 0'],
        ['external_failed_count', 'INTEGER NOT NULL DEFAULT 0'],
        ['target_mode', "TEXT NOT NULL DEFAULT 'delivery_slots'"],
        ['deduplicate_channels', 'INTEGER NOT NULL DEFAULT 1'],
        ['send_official_support', 'INTEGER NOT NULL DEFAULT 0'],
        ['official_mention_role_id', "TEXT NOT NULL DEFAULT ''"],
        ['official_message_id', 'TEXT'],
    ];
    for (const [name, definition] of additions) {
        if (existing.has(name)) continue;
        try {
            await database.prepare(`ALTER TABLE newsletter_campaigns ADD COLUMN ${name} ${definition}`).run();
        } catch (error) {
            const refreshed = await database.prepare('PRAGMA table_info(newsletter_campaigns)').all();
            if (!(refreshed.results || []).some((column) => column.name === name)) throw error;
        }
    }
    await database.prepare(
        `UPDATE newsletter_campaigns SET target_mode = 'intersection'
         WHERE target_mode = 'delivery_slots' AND trim(target_server_ids) <> ''`,
    ).run();
}

function assertDatabaseConfigured(env) {
    if (!env.NEWSLETTER_DB || typeof env.NEWSLETTER_DB.prepare !== 'function') {
        throw new NewsletterError(503, 'メール配信データベースが設定されていません。', 'database_not_configured');
    }
}

function assertDatabaseAndTokenConfigured(env) {
    assertDatabaseConfigured(env);
    assertTokenSecret(env.NEWSLETTER_TOKEN_SECRET);
}

function assertPublicConfigured(env) {
    const missing = publicConfigurationMissing(env);
    if (missing.length) {
        console.error('Newsletter public configuration is incomplete', { missing });
        throw new NewsletterError(503, 'メール配信の登録機能は現在設定中です。', 'service_not_configured');
    }
    assertTokenSecret(env.NEWSLETTER_TOKEN_SECRET);
}

function assertDeliveryConfigured(env) {
    const missing = [
        ['NOTICE_EMAIL', env.NOTICE_EMAIL],
        ['NOTICE_FROM_EMAIL', cleanConfigValue(env.NOTICE_FROM_EMAIL)],
        ['NEWSLETTER_PUBLIC_ORIGIN', normalizePublicOrigin(env.NEWSLETTER_PUBLIC_ORIGIN)],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length) {
        console.error('Newsletter delivery configuration is incomplete', { missing });
        throw new Error('newsletter_delivery_not_configured');
    }
    assertTokenSecret(env.NEWSLETTER_TOKEN_SECRET);
}

function publicConfigurationMissing(env) {
    return [
        ['NEWSLETTER_DB', env.NEWSLETTER_DB],
        ['NOTICE_EMAIL', env.NOTICE_EMAIL],
        ['NOTICE_FROM_EMAIL', cleanConfigValue(env.NOTICE_FROM_EMAIL)],
        ['NEWSLETTER_PUBLIC_ORIGIN', normalizePublicOrigin(env.NEWSLETTER_PUBLIC_ORIGIN)],
        ['NEWSLETTER_CONSENT_VERSION', cleanConfigValue(env.NEWSLETTER_CONSENT_VERSION)],
        ['NEWSLETTER_TOKEN_SECRET', tokenSecretIsValid(env.NEWSLETTER_TOKEN_SECRET)],
        ['RECAPTCHA_SITE_KEY', cleanConfigValue(env.RECAPTCHA_SITE_KEY)],
        ['RECAPTCHA_SECRET_KEY', cleanConfigValue(env.RECAPTCHA_SECRET_KEY)],
    ].filter(([, value]) => !value).map(([name]) => name);
}

function assertTokenSecret(value) {
    if (!tokenSecretIsValid(value)) {
        throw new NewsletterError(503, 'メール配信の署名設定が完了していません。', 'token_secret_not_configured');
    }
}

function tokenSecretIsValid(value) {
    return new TextEncoder().encode(cleanConfigValue(value)).byteLength >= 32;
}

function assertMethod(request, allowedMethods) {
    if (!allowedMethods.includes(request.method)) {
        const error = new NewsletterError(405, '許可されていない操作です。', 'method_not_allowed');
        error.allow = allowedMethods.join(', ');
        throw error;
    }
}

function assertSameOrigin(request) {
    const origin = request.headers.get('origin');
    const expectedOrigin = new URL(request.url).origin;
    if (!origin || origin !== expectedOrigin) {
        throw new NewsletterError(403, 'このページ以外からは操作できません。', 'invalid_origin');
    }
}

function assertSameOriginFormNavigation(request) {
    const expectedOrigin = new URL(request.url).origin;
    const origin = request.headers.get('origin');

    if (origin) {
        if (origin === expectedOrigin) return;
        throw new NewsletterError(403, 'このページ以外からは操作できません。', 'invalid_origin');
    }

    const referrer = request.headers.get('referer');
    if (referrer) {
        try {
            if (new URL(referrer).origin === expectedOrigin) return;
        } catch {
            // 不正なRefererは下の共通エラーで拒否する。
        }
    }

    const fetchSite = request.headers.get('sec-fetch-site');
    const fetchMode = request.headers.get('sec-fetch-mode');
    if (fetchSite === 'same-origin' && fetchMode === 'navigate') return;

    throw new NewsletterError(403, 'このページ以外からは操作できません。', 'invalid_origin');
}

function assertReasonableSubmissionTime(rawStartedAt) {
    const startedAt = Number(rawStartedAt);
    const elapsed = Date.now() - startedAt;
    if (!Number.isFinite(startedAt) || elapsed < 1_500 || elapsed > 2 * 60 * 60 * 1_000) {
        throw new NewsletterError(
            400,
            'フォームの有効時間が切れました。ページを再読み込みしてください。',
            'invalid_form_time',
        );
    }
}

async function readJson(request, limit) {
    const contentType = (request.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
        throw new NewsletterError(415, '送信形式が正しくありません。', 'invalid_content_type');
    }
    const text = await readTextWithLimit(request, limit);
    try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not_object');
        return parsed;
    } catch {
        throw new NewsletterError(400, '送信内容を読み取れませんでした。', 'invalid_json');
    }
}

async function readCampaignInput(request, surface) {
    const contentType = (request.headers.get('content-type') || '').toLowerCase();
    if (surface !== 'discord' || !contentType.startsWith('multipart/form-data;')) {
        return readJson(request, MAX_JSON_BYTES);
    }
    const rawBody = await readBytesWithLimit(request, MAX_DISCORD_FORM_BYTES);
    let form;
    try {
        form = await new Request(request.url, {
            method: 'POST',
            headers: { 'content-type': request.headers.get('content-type') },
            body: rawBody,
        }).formData();
    } catch {
        throw new NewsletterError(400, '送信内容を読み取れませんでした。', 'invalid_form_data');
    }
    const file = form.get('image');
    let image = null;
    if (file && typeof file.arrayBuffer === 'function' && Number(file.size || 0) > 0) {
        if (Number(file.size) > MAX_DISCORD_IMAGE_BYTES) {
            throw new NewsletterError(400, '画像は1.25MB以内にしてください。', 'discord_image_too_large');
        }
        image = {
            name: stringValue(file.name),
            type: stringValue(file.type),
            size: Number(file.size),
            bytes: await file.arrayBuffer(),
        };
    }
    return {
        categories: parseJsonFormArray(form, 'categories'),
        recipientGroups: parseJsonFormArray(form, 'recipientGroups'),
        deliverySlots: parseJsonFormArray(form, 'deliverySlots'),
        targetServerIds: parseJsonFormArray(form, 'targetServerIds'),
        targetMode: stringValue(form.get('targetMode')),
        deduplicateChannels: stringValue(form.get('deduplicateChannels')),
        sendOfficialSupport: stringValue(form.get('sendOfficialSupport')),
        officialMentionRoleId: stringValue(form.get('officialMentionRoleId')),
        subject: stringValue(form.get('subject')),
        body: stringValue(form.get('body')),
        deliveryFormat: stringValue(form.get('deliveryFormat')),
        embedColor: stringValue(form.get('embedColor')),
        imageUrl: stringValue(form.get('imageUrl')),
        imageAlt: stringValue(form.get('imageAlt')),
        image,
    };
}

function parseJsonFormArray(form, name) {
    try {
        const value = JSON.parse(stringValue(form.get(name)));
        if (!Array.isArray(value)) throw new Error('not_array');
        return value;
    } catch {
        throw new NewsletterError(400, '選択内容を読み取れませんでした。', 'invalid_form_data');
    }
}

async function readBytesWithLimit(request, limit) {
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
        throw new NewsletterError(413, '送信データが大きすぎます。', 'request_too_large');
    }
    if (!request.body) throw new NewsletterError(400, '送信内容がありません。', 'empty_body');
    const reader = request.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
            await reader.cancel();
            throw new NewsletterError(413, '送信データが大きすぎます。', 'request_too_large');
        }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

async function readForm(request, limit) {
    const contentType = (request.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('application/x-www-form-urlencoded')) {
        throw new NewsletterError(415, '送信形式が正しくありません。', 'invalid_content_type');
    }
    return new URLSearchParams(await readTextWithLimit(request, limit));
}

async function readTextWithLimit(request, limit) {
    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(declaredLength) && declaredLength > limit) {
        throw new NewsletterError(413, '送信データが大きすぎます。', 'request_too_large');
    }
    if (!request.body) throw new NewsletterError(400, '送信内容がありません。', 'empty_body');

    const reader = request.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0;
    let text = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) {
                await reader.cancel();
                throw new NewsletterError(413, '送信データが大きすぎます。', 'request_too_large');
            }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
        return text;
    } catch (error) {
        if (error instanceof NewsletterError) throw error;
        throw new NewsletterError(400, '送信内容を読み取れませんでした。', 'invalid_encoding');
    }
}

function validateEmail(rawEmail) {
    const email = stringValue(rawEmail).trim().toLowerCase();
    const emailPattern = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+$/i;
    const [localPart = '', domain = ''] = email.split('@');
    if (
        !email
        || email.length > 254
        || localPart.length > 64
        || localPart.startsWith('.')
        || localPart.endsWith('.')
        || localPart.includes('..')
        || domain.length > 253
        || /[\r\n\u0000]/u.test(email)
        || !emailPattern.test(email)
    ) {
        throw new NewsletterError(400, '有効なメールアドレスを入力してください。', 'invalid_email');
    }
    return email;
}

function validateCategories(input) {
    if (!Array.isArray(input)) {
        throw new NewsletterError(400, '配信する情報を選択してください。', 'invalid_categories');
    }
    const selected = new Set(input.filter((item) => typeof item === 'string'));
    if (selected.size === 0 || selected.size !== input.length) {
        throw new NewsletterError(400, '配信する情報を正しく選択してください。', 'invalid_categories');
    }
    for (const item of selected) {
        if (!Object.hasOwn(CATEGORIES, item)) {
            throw new NewsletterError(400, '配信する情報を正しく選択してください。', 'invalid_categories');
        }
    }
    return CATEGORY_ORDER.filter((category) => selected.has(category));
}

function validateSingleCategory(value) {
    const category = stringValue(value);
    if (!Object.hasOwn(CATEGORIES, category)) {
        throw new NewsletterError(400, '配信カテゴリを選択してください。', 'invalid_category');
    }
    return category;
}

function validateRecipientGroups(input) {
    const rawGroups = Array.isArray(input) ? input : [];
    const selected = new Set(rawGroups.filter((item) => typeof item === 'string' && item));
    if (selected.size === 0 && !Array.isArray(input)) selected.add('subscribers');
    if (selected.size > RECIPIENT_GROUP_ORDER.length || [...selected].some((item) => !Object.hasOwn(RECIPIENT_GROUPS, item))) {
        throw new NewsletterError(400, '配信対象を正しく選択してください。', 'invalid_recipient_groups');
    }
    if (selected.size === 0) throw new NewsletterError(400, '配信対象を1つ以上選択してください。', 'invalid_recipient_groups');
    return RECIPIENT_GROUP_ORDER.filter((group) => selected.has(group));
}

function validateSurfaceRecipientGroups(input, surface) {
    const groups = validateRecipientGroups(input);
    const allowed = surface === 'discord'
        ? groups.length === 1 && groups[0] === 'discord_approved'
        : groups.every((group) => group !== 'discord_approved');
    if (!allowed) {
        throw new NewsletterError(
            400,
            surface === 'discord'
                ? 'Discord配信の送信先は許可済みDiscordサーバーのみです。'
                : 'Discordへの送信はDiscordお知らせ管理から行ってください。',
            'recipient_surface_mismatch',
        );
    }
    return groups;
}

function assertCampaignSurface(campaign, surface) {
    validateSurfaceRecipientGroups(parseCsv(campaign.recipient_groups), surface);
}

function validateDeliverySlots(input, allowedIds = DELIVERY_SLOT_IDS) {
    const rawSlots = Array.isArray(input) ? input : [];
    const allowed = allowedIds instanceof Set ? allowedIds : new Set(allowedIds || []);
    const selected = new Set(rawSlots.filter((item) => typeof item === 'string').map(normalizeDeliveryName).filter(Boolean));
    if (selected.size === 0 && !Array.isArray(input)) selected.add('DPI_Bot通知');
    if (selected.size > 100 || [...selected].some((item) => !allowed.has(item))) {
        throw new NewsletterError(400, '配信枠を正しく選択してください。', 'invalid_delivery_slots');
    }
    if (selected.size === 0) throw new NewsletterError(400, '配信枠を1つ以上選択してください。', 'invalid_delivery_slots');
    return [...selected];
}

function validateTargetServerIds(input, recipientGroups) {
    const rawIds = Array.isArray(input) ? input : [];
    const selected = [...new Set(rawIds.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean))];
    if (selected.length > 500 || selected.some((item) => !/^\d{17,20}$/u.test(item))) {
        throw new NewsletterError(400, '配信先サーバーを正しく選択してください。', 'invalid_target_servers');
    }
    return recipientGroups.includes('discord_approved') ? selected : [];
}

function validateOptionalDeliverySlots(input, allowedIds = DELIVERY_SLOT_IDS) {
    const rawSlots = Array.isArray(input) ? input : [];
    const allowed = allowedIds instanceof Set ? allowedIds : new Set(allowedIds || []);
    const selected = [...new Set(rawSlots
        .filter((item) => typeof item === 'string')
        .map(normalizeDeliveryName)
        .filter(Boolean))];
    if (selected.length > 100 || selected.some((item) => !allowed.has(item))) {
        throw new NewsletterError(400, '配信枠を正しく選択してください。', 'invalid_delivery_slots');
    }
    return selected;
}

function validateDiscordTargeting(input, recipientGroups, allowedIds = DELIVERY_SLOT_IDS) {
    let deliverySlots = validateOptionalDeliverySlots(input.deliverySlots, allowedIds);
    let targetServerIds = validateTargetServerIds(input.targetServerIds, recipientGroups);
    const inferredMode = targetServerIds.length ? 'intersection' : 'delivery_slots';
    const targetMode = stringValue(input.targetMode).trim() || inferredMode;
    if (!DISCORD_TARGET_MODES.has(targetMode)) {
        throw new NewsletterError(400, 'Discordの送信先指定方法を確認してください。', 'invalid_discord_target_mode');
    }
    if (targetMode === 'delivery_slots' && deliverySlots.length === 0) {
        throw new NewsletterError(400, '配信枠を1つ以上選択してください。', 'invalid_delivery_slots');
    }
    if (targetMode === 'servers' && targetServerIds.length === 0) {
        throw new NewsletterError(400, '配信先サーバーを1つ以上選択してください。', 'invalid_target_servers');
    }
    if (targetMode === 'intersection' && (deliverySlots.length === 0 || targetServerIds.length === 0)) {
        throw new NewsletterError(400, '配信枠と配信先サーバーをそれぞれ1つ以上選択してください。', 'invalid_discord_targeting');
    }
    if (targetMode === 'delivery_slots') targetServerIds = [];
    if (targetMode === 'servers') deliverySlots = [];
    const deduplicateChannels = input.deduplicateChannels === undefined
        ? true
        : parseBooleanValue(input.deduplicateChannels, '同一チャンネルへの送信方法を確認してください。');
    return { targetMode, deliverySlots, targetServerIds, deduplicateChannels };
}

function parseBooleanValue(value, message) {
    if (value === true || value === 1 || value === '1' || value === 'true') return true;
    if (value === false || value === 0 || value === '0' || value === 'false') return false;
    throw new NewsletterError(400, message, 'invalid_boolean');
}

function validateOfficialSupportOptions(input) {
    const sendOfficialSupport = input.sendOfficialSupport === undefined
        ? false
        : parseBooleanValue(input.sendOfficialSupport, '公式サポートサーバーへの送信設定を確認してください。');
    const officialMentionRoleId = stringValue(input.officialMentionRoleId).trim();
    if (officialMentionRoleId && !OFFICIAL_SUPPORT_ROLE_IDS.has(officialMentionRoleId)) {
        throw new NewsletterError(400, 'メンションする公式ロールを確認してください。', 'invalid_official_mention_role');
    }
    if (!sendOfficialSupport && officialMentionRoleId) {
        throw new NewsletterError(400, '公式チャンネルへ送信する場合だけロールを指定できます。', 'official_mention_without_destination');
    }
    return {
        sendOfficialSupport,
        officialMentionRoleId: sendOfficialSupport ? officialMentionRoleId : '',
    };
}

function validateDiscordAnnouncement(subject, body, recipientGroups, options = {}) {
    if (!recipientGroups.includes('discord_approved')) return;
    const format = validateDiscordFormat(options.format);
    const mentionPrefix = OFFICIAL_SUPPORT_ROLE_IDS.has(stringValue(options.mentionRoleId))
        ? `<@&${options.mentionRoleId}>\n`
        : '';
    if (format === 'message' && `${mentionPrefix}${buildDiscordMessageContent(subject, body, options.imageUrl)}`.length > 2_000) {
        throw new NewsletterError(400, '通常メッセージは件名・本文・画像URLを合わせて2,000文字以内にしてください。', 'discord_content_too_large');
    }
    if (format === 'embed' && (subject.length > 256 || body.length > 4_096 || subject.length + body.length > 6_000)) {
        throw new NewsletterError(400, 'Embedはタイトル256文字、本文4,096文字、全体6,000文字以内にしてください。', 'discord_embed_too_large');
    }
}

function validateDiscordOptions(input, recipientGroups, { allowImageMetadataOnly = false } = {}) {
    if (!recipientGroups.includes('discord_approved')) {
        return { format: 'message', embedColor: DEFAULT_DISCORD_EMBED_COLOR, imageUrl: '', imageAlt: '', image: null };
    }
    const format = validateDiscordFormat(input.deliveryFormat);
    const embedColor = validateEmbedColor(input.embedColor);
    const imageUrl = validateDiscordImageUrl(input.imageUrl);
    const imageAlt = normalizeText(stringValue(input.imageAlt)).trim();
    if (imageAlt.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(imageAlt)) {
        throw new NewsletterError(400, '画像の説明は1,024文字以内で入力してください。', 'invalid_image_alt');
    }
    let image = null;
    if (input.image && !allowImageMetadataOnly) image = validateDiscordImage(input.image);
    if (image && imageUrl) {
        throw new NewsletterError(400, '画像URLと画像ファイルはどちらか一方だけ指定してください。', 'discord_image_conflict');
    }
    return { format, embedColor, imageUrl, imageAlt, image };
}

function validateDiscordFormat(value) {
    const format = stringValue(value).trim() || 'message';
    if (!DISCORD_FORMATS.has(format)) {
        throw new NewsletterError(400, 'Discordの送信形式を正しく選択してください。', 'invalid_discord_format');
    }
    return format;
}

function validateEmbedColor(value) {
    const rawValue = typeof value === 'number' ? value : stringValue(value).trim();
    const raw = rawValue === '' ? DEFAULT_DISCORD_EMBED_COLOR : rawValue;
    const color = typeof raw === 'number'
        ? raw
        : (/^#[0-9a-f]{6}$/iu.test(raw) ? Number.parseInt(raw.slice(1), 16) : Number.NaN);
    if (!Number.isInteger(color) || color < 0 || color > 0xFFFFFF) {
        throw new NewsletterError(400, 'Embed色を正しく選択してください。', 'invalid_embed_color');
    }
    return color;
}

function validateDiscordImageUrl(value) {
    const raw = stringValue(value).trim();
    if (!raw) return '';
    if (raw.length > 2_048) throw new NewsletterError(400, '画像URLが長すぎます。', 'invalid_image_url');
    try {
        const url = new URL(raw);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid');
        return url.toString();
    } catch {
        throw new NewsletterError(400, '画像URLはHTTPS形式で入力してください。', 'invalid_image_url');
    }
}

function validateDiscordImage(file) {
    const type = stringValue(file.type).toLowerCase();
    const size = Number(file.size || 0);
    if (!DISCORD_IMAGE_TYPES.has(type) || !Number.isFinite(size) || size <= 0 || size > MAX_DISCORD_IMAGE_BYTES) {
        throw new NewsletterError(400, '画像はPNG・JPEG・GIF・WebPのいずれかで、1.25MB以内にしてください。', 'invalid_discord_image');
    }
    const bytes = new Uint8Array(file.bytes || new ArrayBuffer(0));
    const signatures = {
        'image/png': bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value),
        'image/jpeg': bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF,
        'image/gif': bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.slice(0, 6))),
        'image/webp': bytes.length >= 12
            && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF'
            && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP',
    };
    if (!signatures[type]) {
        throw new NewsletterError(400, '画像ファイルの内容と形式が一致しません。', 'invalid_discord_image_signature');
    }
    const originalName = stringValue(file.name).normalize('NFC').replace(/[^A-Za-z0-9._-]+/gu, '_').slice(-100);
    const extension = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' }[type];
    const name = originalName && originalName.includes('.') ? originalName : `announcement${extension}`;
    return { name, type, bytes: file.bytes };
}

function applicationChannelTargets(row) {
    const fallbackTypes = parseStringArray(row.delivery_types);
    const mappings = parseObjectArray(row.channel_mappings);
    const source = mappings.length ? mappings : [{
        channelId: row.channel_id,
        channelName: row.channel_name,
        deliveryTypes: fallbackTypes,
    }];
    return source.map((mapping) => ({
        serverId: stringValue(row.guild_id).trim(),
        serverName: stringValue(row.guild_name).trim(),
        channelId: stringValue(mapping.channelId || mapping.channel_id || row.channel_id).trim(),
        channelName: stringValue(mapping.channelName || mapping.channel_name || row.channel_name).trim(),
        deliveryTypes: parseStringArray(mapping.deliveryTypes || mapping.delivery_types || fallbackTypes),
    })).filter((target) => target.serverId && target.channelId);
}

function normalizeApprovedServers(rows) {
    const servers = new Map();
    for (const row of rows) {
        for (const target of applicationChannelTargets(row)) {
            const current = servers.get(target.serverId) || {
                id: target.serverId,
                name: target.serverName || target.serverId,
                channels: new Set(),
                deliveryTypes: new Set(),
            };
            current.channels.add(target.channelId);
            target.deliveryTypes.forEach((item) => current.deliveryTypes.add(item));
            servers.set(target.serverId, current);
        }
    }
    return [...servers.values()].map((server) => ({
        id: server.id,
        name: server.name,
        channelCount: server.channels.size,
        deliveryTypes: [...server.deliveryTypes],
    }));
}

function normalizeDeliveryName(value) {
    let text = stringValue(value).normalize('NFKC').trim().slice(0, 120);
    while (/^\[[^\]]+\]/u.test(text)) text = text.replace(/^\[[^\]]+\]/u, '').trim();
    return text;
}

function normalizeAwsDirectoryItem(item) {
    if (!item || typeof item !== 'object') return null;
    const channelId = stringValue(item.channelId).trim();
    const serverId = stringValue(item.serverId).trim();
    if (channelId && !/^\d{17,20}$/u.test(channelId)) return null;
    if (serverId && !/^\d{17,20}$/u.test(serverId)) return null;
    const deliveryTypes = [...new Set((Array.isArray(item.deliveryTypes) ? item.deliveryTypes : [])
        .map(normalizeDeliveryName).filter(Boolean))];
    if (!channelId && deliveryTypes.length === 0) return null;
    return {
        serverId,
        serverName: stringValue(item.serverName).trim().slice(0, 100),
        channelId,
        channelName: stringValue(item.channelName).trim().slice(0, 100),
        deliveryTypes,
        hasWebhook: item.hasWebhook !== false,
    };
}

function normalizeAwsDirectoryServers(items) {
    const servers = new Map();
    for (const item of items || []) {
        if (!item.serverId) continue;
        const current = servers.get(item.serverId) || {
            id: item.serverId,
            name: item.serverName || item.serverId,
            channels: new Set(),
            deliveryTypes: new Set(),
        };
        if (item.channelId && item.hasWebhook) current.channels.add(item.channelId);
        item.deliveryTypes.forEach((value) => current.deliveryTypes.add(value));
        servers.set(item.serverId, current);
    }
    return [...servers.values()].map((server) => ({
        id: server.id,
        name: server.name,
        channelCount: server.channels.size,
        webhookCount: server.channels.size,
        deliveryTypes: [...server.deliveryTypes],
    }));
}

function mergeApprovedServers(...groups) {
    const merged = new Map();
    for (const server of groups.flat()) {
        const current = merged.get(server.id) || { id: server.id, name: server.name || server.id, channelCount: 0, webhookCount: 0, deliveryTypes: [] };
        current.name = server.name || current.name;
        current.channelCount = Math.max(current.channelCount, Number(server.channelCount || 0));
        current.webhookCount = Math.max(current.webhookCount, Number(server.webhookCount ?? server.channelCount ?? 0));
        current.deliveryTypes = [...new Set([...current.deliveryTypes, ...(server.deliveryTypes || [])])];
        merged.set(server.id, current);
    }
    return [...merged.values()].sort((left, right) => left.name.localeCompare(right.name, 'ja'));
}

function allowedDeliverySlotIds(items = []) {
    return new Set([...DELIVERY_SLOT_IDS, ...(items || []).flatMap((item) => item.deliveryTypes || []).map(normalizeDeliveryName).filter(Boolean)]);
}

function deliveryCatalogWithAws(items = []) {
    const catalog = DELIVERY_CATALOG.map((item) => ({ ...item }));
    const existing = new Set(catalog.map((item) => item.id));
    for (const id of [...allowedDeliverySlotIds(items)].sort((left, right) => left.localeCompare(right, 'ja'))) {
        if (existing.has(id)) continue;
        catalog.push({ id, label: id, status: 'registered' });
        existing.add(id);
    }
    return catalog;
}

function validateCampaignSubject(value) {
    const subject = normalizeText(stringValue(value)).trim();
    if (!subject || subject.length > 120 || /[\r\n\u0000-\u001f\u007f]/u.test(subject)) {
        throw new NewsletterError(400, '件名は改行なしの120文字以内で入力してください。', 'invalid_subject');
    }
    return subject;
}

function validateCampaignBody(value) {
    const body = normalizeText(stringValue(value)).trim();
    if (!body || body.length > 10_000 || /[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body)) {
        throw new NewsletterError(400, '本文は10,000文字以内で入力してください。', 'invalid_body');
    }
    return body;
}

function serializeCategories(categories) {
    return CATEGORY_ORDER.filter((category) => categories.includes(category)).join(',');
}

function serializeCsv(values) {
    return values.join(',');
}

function parseCsv(value) {
    return stringValue(value).split(',').map((item) => item.trim()).filter(Boolean);
}

function parseStringArray(value) {
    if (Array.isArray(value)) return value.map((item) => stringValue(item).trim()).filter(Boolean);
    const text = stringValue(value).trim();
    if (!text) return [];
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed.map((item) => stringValue(item).trim()).filter(Boolean);
    } catch {
        // Older rows may contain comma separated values.
    }
    return parseCsv(text);
}

function parseObjectArray(value) {
    if (Array.isArray(value)) return value.filter((item) => item && typeof item === 'object');
    const text = stringValue(value).trim();
    if (!text) return [];
    try {
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === 'object') : [];
    } catch {
        return [];
    }
}

function parseSerializedCategories(value) {
    const rawCategories = stringValue(value).split(',').filter(Boolean);
    const selected = new Set(rawCategories);
    if (
        selected.size === 0
        || selected.size !== rawCategories.length
        || rawCategories.some((category) => !Object.hasOwn(CATEGORIES, category))
    ) return [];
    return CATEGORY_ORDER.filter((category) => selected.has(category));
}

function serializedCategoriesOverlap(subscriberValue, campaignValue) {
    const subscriberCategories = new Set(parseSerializedCategories(subscriberValue));
    return parseSerializedCategories(campaignValue)
        .some((category) => subscriberCategories.has(category));
}

function normalizeText(value) {
    return value.normalize('NFC').replace(/\r\n?/g, '\n');
}

function renderMarkdownEmail(value) {
    const lines = normalizeText(stringValue(value)).split('\n');
    const html = [];
    let listType = '';

    const closeList = () => {
        if (!listType) return;
        html.push(`</${listType}>`);
        listType = '';
    };

    for (const line of lines) {
        if (!line.trim()) {
            closeList();
            continue;
        }

        const heading = line.match(/^\s{0,3}(#{1,3})\s+(.+)$/u);
        if (heading) {
            closeList();
            const level = heading[1].length + 1;
            const size = level === 2 ? '21px' : level === 3 ? '18px' : '16px';
            html.push(`<h${level} style="margin:24px 0 10px;font-size:${size};line-height:1.45">${renderInlineMarkdown(heading[2])}</h${level}>`);
            continue;
        }

        if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u.test(line)) {
            closeList();
            html.push('<hr style="margin:24px 0;border:0;border-top:1px solid #d8dee6">');
            continue;
        }

        const quote = line.match(/^\s{0,3}>\s?(.*)$/u);
        if (quote) {
            closeList();
            html.push(`<blockquote style="margin:16px 0;padding:10px 14px;border-left:4px solid #3498db;background:#f2f6fa;color:#465466">${renderInlineMarkdown(quote[1])}</blockquote>`);
            continue;
        }

        const unorderedItem = line.match(/^\s*[-+*]\s+(.+)$/u);
        const orderedItem = line.match(/^\s*\d+[.)]\s+(.+)$/u);
        if (unorderedItem || orderedItem) {
            const nextListType = unorderedItem ? 'ul' : 'ol';
            if (listType !== nextListType) {
                closeList();
                listType = nextListType;
                html.push(`<${listType} style="margin:12px 0;padding-left:26px;line-height:1.8">`);
            }
            html.push(`<li>${renderInlineMarkdown((unorderedItem || orderedItem)[1])}</li>`);
            continue;
        }

        closeList();
        html.push(`<p style="margin:12px 0;line-height:1.8">${renderInlineMarkdown(line)}</p>`);
    }

    closeList();
    return html.join('');
}

function renderInlineMarkdown(value) {
    const text = stringValue(value);
    let html = '';
    let plain = '';

    const flushPlain = () => {
        if (!plain) return;
        html += escapeHtml(plain);
        plain = '';
    };

    for (let index = 0; index < text.length;) {
        if (text.startsWith('**', index)) {
            const end = text.indexOf('**', index + 2);
            if (end > index + 2) {
                flushPlain();
                html += `<strong>${escapeHtml(text.slice(index + 2, end))}</strong>`;
                index = end + 2;
                continue;
            }
        }

        if (text[index] === '*') {
            const end = text.indexOf('*', index + 1);
            if (end > index + 1) {
                flushPlain();
                html += `<em>${escapeHtml(text.slice(index + 1, end))}</em>`;
                index = end + 1;
                continue;
            }
        }

        if (text[index] === '`') {
            const end = text.indexOf('`', index + 1);
            if (end > index + 1) {
                flushPlain();
                html += `<code style="padding:2px 5px;border-radius:4px;background:#eef1f4;font-family:monospace">${escapeHtml(text.slice(index + 1, end))}</code>`;
                index = end + 1;
                continue;
            }
        }

        if (text[index] === '[') {
            const labelEnd = text.indexOf('](', index + 1);
            const urlEnd = labelEnd >= 0 ? text.indexOf(')', labelEnd + 2) : -1;
            if (labelEnd > index + 1 && urlEnd > labelEnd + 2) {
                const label = text.slice(index + 1, labelEnd);
                const url = text.slice(labelEnd + 2, urlEnd);
                if (isSafeMarkdownUrl(url)) {
                    flushPlain();
                    html += `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
                    index = urlEnd + 1;
                    continue;
                }
            }
        }

        plain += text[index];
        index += 1;
    }

    flushPlain();
    return html;
}

function isSafeMarkdownUrl(value) {
    if (typeof value !== 'string' || value.length > 2_048) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
        return false;
    }
}

async function verifyRecaptcha(token, request, env) {
    if (!token || token.length > 4_096) {
        throw new NewsletterError(400, 'reCAPTCHAの確認を完了してください。', 'recaptcha_required');
    }

    const params = new URLSearchParams({
        secret: cleanConfigValue(env.RECAPTCHA_SECRET_KEY),
        response: token,
    });
    const remoteIp = request.headers.get('CF-Connecting-IP');
    if (remoteIp) params.set('remoteip', remoteIp);

    let response;
    try {
        response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: params,
        });
    } catch {
        throw new NewsletterError(503, 'reCAPTCHAの確認に失敗しました。時間をおいて再度お試しください。', 'recaptcha_unavailable');
    }
    if (!response.ok) {
        throw new NewsletterError(503, 'reCAPTCHAの確認に失敗しました。時間をおいて再度お試しください。', 'recaptcha_unavailable');
    }

    const result = await response.json();
    const requestHostname = new URL(request.url).hostname.toLowerCase();
    const configuredHostnames = cleanConfigValue(env.RECAPTCHA_ALLOWED_HOSTS)
        .split(',')
        .map((hostname) => hostname.trim().toLowerCase())
        .filter(Boolean);
    const allowedHostnames = new Set(configuredHostnames.length ? configuredHostnames : [requestHostname]);
    const challengeTime = Date.parse(result.challenge_ts || '');
    const challengeIsFresh = Number.isFinite(challengeTime)
        && Math.abs(Date.now() - challengeTime) <= 5 * 60 * 1_000;
    if (
        result.success !== true
        || !allowedHostnames.has(stringValue(result.hostname).toLowerCase())
        || !challengeIsFresh
    ) {
        throw new NewsletterError(400, 'reCAPTCHAの確認に失敗しました。もう一度お試しください。', 'recaptcha_failed');
    }
}

async function sendConfirmationEmail(email, categories, token, env) {
    const origin = normalizePublicOrigin(env.NEWSLETTER_PUBLIC_ORIGIN);
    const confirmationUrl = new URL('/api/newsletter/confirm', origin);
    confirmationUrl.searchParams.set('token', token);
    const categoryText = categories.map((category) => `・${CATEGORIES[category]}`).join('\n');
    const text = [
        'DPI-Bot メール配信の登録確認',
        '',
        '次の情報の配信登録が申請されました。',
        categoryText,
        '',
        '以下のURLを開き、24時間以内に「登録を確定する」を押してください。',
        confirmationUrl.toString(),
        '',
        'このメールに心当たりがない場合は、何もせず削除してください。登録は完了しません。',
        '',
        emailSignatureText(),
    ].join('\n');
    const categoriesHtml = categories.map((category) => `<li>${escapeHtml(CATEGORIES[category])}</li>`).join('');
    const html = `<!doctype html><html lang="ja"><body style="font-family:sans-serif;line-height:1.7;color:#172033"><h1 style="font-size:22px">DPI-Bot メール配信の登録確認</h1><p>次の情報の配信登録が申請されました。</p><ul>${categoriesHtml}</ul><p><a href="${escapeHtml(confirmationUrl.toString())}" style="display:inline-block;padding:12px 18px;background:#1769aa;color:#fff;text-decoration:none;border-radius:6px">登録内容を確認する</a></p><p>24時間以内に確認画面で「登録を確定する」を押してください。</p><p style="color:#596273">心当たりがない場合は、このメールを削除してください。登録は完了しません。</p>${emailSignatureHtml()}</body></html>`;

    await env.NOTICE_EMAIL.send({
        to: email,
        from: { email: cleanConfigValue(env.NOTICE_FROM_EMAIL), name: 'DPI-Bot' },
        subject: '【DPI-Bot】メール配信の登録確認',
        text,
        html,
        ...(cleanConfigValue(env.NOTICE_REPLY_TO_EMAIL)
            ? { replyTo: cleanConfigValue(env.NOTICE_REPLY_TO_EMAIL) }
            : {}),
        headers: {
            'Auto-Submitted': 'auto-generated',
            'Content-Language': 'ja',
            'X-DPI-Mail-Type': 'subscription-confirmation',
        },
    });
}

function buildCampaignEmail(delivery, unsubscribeToken, env) {
    const origin = normalizePublicOrigin(env.NEWSLETTER_PUBLIC_ORIGIN);
    const isSubscriber = delivery.recipient_kind !== 'reuse_approved';
    const unsubscribeUrl = isSubscriber ? new URL('/api/newsletter/unsubscribe', origin) : null;
    if (unsubscribeUrl) unsubscribeUrl.searchParams.set('token', unsubscribeToken);
    const subscribeUrl = new URL('/site/mail/', origin);
    const reuseUrl = new URL('/site/reuse/', origin);
    const categoryLabel = parseSerializedCategories(delivery.category)
        .map((category) => CATEGORIES[category])
        .join('・') || 'お知らせ';
    const slotLabels = parseCsv(delivery.delivery_slots)
        .map((slot) => DELIVERY_CATALOG.find((item) => item.id === slot)?.label || slot);
    const audienceNote = isSubscriber
        ? 'このメールはDPI-Botのお知らせメールに登録した方へお送りしています。'
        : 'このメールはDPI-Botの二次利用を許可されている方へ、運用上のお知らせとしてお送りしています。';
    const slotText = slotLabels.length ? `対象配信枠: ${slotLabels.join('・')}` : '';
    const text = [
        `【${categoryLabel}】`,
        slotText,
        '',
        delivery.body_text,
        '',
        '----------------------------------------',
        audienceNote,
        emailSignatureText(),
        ...(unsubscribeUrl
            ? [`配信停止: ${unsubscribeUrl.toString()}`]
            : [`二次利用申請の確認・利用停止: ${reuseUrl.toString()}`]),
    ].join('\n');
    const safeBody = renderMarkdownEmail(delivery.body_text);
    const slotHtml = slotLabels.length
        ? `<p style="font-size:13px;color:#596273"><strong>対象配信枠:</strong> ${escapeHtml(slotLabels.join('・'))}</p>`
        : '';
    const actionHtml = unsubscribeUrl
        ? `<a href="${escapeHtml(unsubscribeUrl.toString())}">すべての配信を停止する</a>`
        : `<a href="${escapeHtml(reuseUrl.toString())}">二次利用申請の確認・利用停止</a>`;
    const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f2f5f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#172033"><main style="max-width:680px;margin:0 auto;background:#fff;padding:28px"><p style="color:#1769aa;font-weight:700">${escapeHtml(categoryLabel)}</p>${slotHtml}<h1 style="font-size:24px;line-height:1.45">${escapeHtml(delivery.subject)}</h1><div style="line-height:1.8;overflow-wrap:anywhere">${safeBody}</div><hr style="margin:32px 0;border:0;border-top:1px solid #d8dee6"><p style="font-size:13px;color:#596273">${escapeHtml(audienceNote)}</p>${emailSignatureHtml()}<p style="font-size:13px">${actionHtml}</p></main></body></html>`;

    return {
        to: delivery.email,
        from: { email: cleanConfigValue(env.NOTICE_FROM_EMAIL), name: 'DPI-Bot' },
        subject: delivery.subject,
        text,
        html,
        ...(cleanConfigValue(env.NOTICE_REPLY_TO_EMAIL)
            ? { replyTo: cleanConfigValue(env.NOTICE_REPLY_TO_EMAIL) }
            : {}),
        headers: {
            ...(unsubscribeUrl ? {
                'List-Unsubscribe': `<${unsubscribeUrl.toString()}>`,
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            } : {}),
            'List-Id': 'DPI-Bot Notices <notices.dpi-bot.com>',
            'List-Help': `<${isSubscriber ? subscribeUrl.toString() : reuseUrl.toString()}>`,
            ...(isSubscriber ? { 'List-Subscribe': `<${subscribeUrl.toString()}>` } : {}),
            Precedence: 'bulk',
            'Auto-Submitted': 'auto-generated',
            'Content-Language': 'ja',
            'X-Campaign-ID': delivery.campaign_id,
        },
    };
}

function emailSignatureText() {
    return [
        'DPI-Bot 運営',
        '公式サイト: https://dpi-bot.com/',
        '公式サポートサーバー: https://discord.gg/qFuZcGUb4K',
        'お問い合わせ: support@dpi-bot.com',
        '© 2026 DPI-Bot',
    ].join('\n');
}

function emailSignatureHtml() {
    return '<p style="margin-top:24px;padding-top:16px;border-top:1px solid #d8dee6;font-size:13px;color:#596273"><strong>DPI-Bot 運営</strong><br><a href="https://dpi-bot.com/">公式サイト</a><br><a href="https://discord.gg/qFuZcGUb4K">公式サポートサーバー</a><br><a href="mailto:support@dpi-bot.com">support@dpi-bot.com</a><br>© 2026 DPI-Bot</p>';
}

async function createUnsubscribeToken(subscriber, secret) {
    assertTokenSecret(secret);
    const payload = encodeBase64Url(new TextEncoder().encode(JSON.stringify({
        version: 1,
        subscriberId: subscriber.id,
        emailHash: await sha256Hex(subscriber.email),
    })));
    const signature = await hmacBytes(secret, `unsubscribe:${payload}`);
    return `${payload}.${encodeBase64Url(signature)}`;
}

async function verifyUnsubscribeToken(token, env) {
    try {
        const [payloadPart, signaturePart] = token.split('.');
        const suppliedSignature = decodeBase64Url(signaturePart);
        const expectedSignature = await hmacBytes(env.NEWSLETTER_TOKEN_SECRET, `unsubscribe:${payloadPart}`);
        if (!constantTimeEqual(suppliedSignature, expectedSignature)) return null;

        const payloadText = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(payloadPart));
        const payload = JSON.parse(payloadText);
        if (
            payload?.version !== 1
            || typeof payload.subscriberId !== 'string'
            || typeof payload.emailHash !== 'string'
        ) return null;

        const subscriber = await env.NEWSLETTER_DB.prepare(
            'SELECT id, email FROM newsletter_subscribers WHERE id = ?',
        ).bind(payload.subscriberId).first();
        if (!subscriber || await sha256Hex(subscriber.email) !== payload.emailHash) return null;
        return subscriber;
    } catch {
        return null;
    }
}

async function keyedHash(secret, value) {
    return bytesToHex(await hmacBytes(secret, value));
}

async function hmacBytes(secret, value) {
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(cleanConfigValue(secret)),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
}

async function sha256Hex(value) {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

function randomToken(byteLength) {
    const bytes = new Uint8Array(byteLength);
    crypto.getRandomValues(bytes);
    return encodeBase64Url(bytes);
}

function encodeBase64Url(bytes) {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function decodeBase64Url(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(value)) {
        throw new Error('invalid_base64url');
    }
    const padded = value.replaceAll('-', '+').replaceAll('_', '/')
        + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
}

function constantTimeEqual(left, right) {
    if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) {
        return false;
    }
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
    return difference === 0;
}

function bytesToHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isConfirmationToken(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function isSignedTokenShape(value) {
    return typeof value === 'string'
        && value.length <= 1_024
        && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value);
}

function normalizePublicOrigin(value) {
    const configured = cleanConfigValue(value);
    if (!configured) return '';
    try {
        const url = new URL(configured);
        if (
            url.protocol !== 'https:'
            || url.username
            || url.password
            || url.port
            || (url.pathname !== '/' && url.pathname !== '')
            || url.search
            || url.hash
        ) return '';
        return url.origin;
    } catch {
        return '';
    }
}

function normalizeCampaignRow(row) {
    const categories = parseSerializedCategories(row.category);
    const storedGroups = parseCsv(row.recipient_groups);
    const storedSlots = parseCsv(row.delivery_slots);
    const recipientGroups = validateRecipientGroups(storedGroups.length ? storedGroups : undefined);
    return {
        id: row.id,
        subject: row.subject,
        body: row.body_text,
        category: categories[0] || '',
        categories,
        recipientGroups,
        deliverySlots: storedSlots.map(normalizeDeliveryName).filter(Boolean),
        targetServerIds: validateTargetServerIds(parseCsv(row.target_server_ids), recipientGroups),
        targetMode: DISCORD_TARGET_MODES.has(stringValue(row.target_mode)) ? row.target_mode : 'delivery_slots',
        deduplicateChannels: Number(row.deduplicate_channels ?? 1) !== 0,
        sendOfficialSupport: Number(row.send_official_support || 0) !== 0,
        officialMentionRoleId: OFFICIAL_SUPPORT_ROLE_IDS.has(stringValue(row.official_mention_role_id))
            ? row.official_mention_role_id
            : '',
        deliveryFormat: validateDiscordFormat(row.delivery_format),
        embedColor: validateEmbedColor(Number(row.embed_color ?? DEFAULT_DISCORD_EMBED_COLOR)),
        imageUrl: stringValue(row.image_url),
        imageName: stringValue(row.image_name),
        imageType: stringValue(row.image_type),
        imageAlt: stringValue(row.image_alt),
        hasImage: Boolean(row.image_url || row.image_name),
        status: row.status,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        recipientCount: Number(row.recipient_count || 0),
        deliveryCount: Number(row.delivery_count || 0),
        sentCount: Number(row.sent_count || 0),
        failedCount: Number(row.failed_count || 0),
        skippedCount: Number(row.skipped_count || 0),
        remainingCount: Number(row.remaining_count || 0),
    };
}

function isPermanentEmailError(code) {
    return new Set([
        'E_VALIDATION_ERROR',
        'E_FIELD_MISSING',
        'E_TOO_MANY_RECIPIENTS',
        'E_SENDER_NOT_VERIFIED',
        'E_RECIPIENT_NOT_ALLOWED',
        'E_RECIPIENT_SUPPRESSED',
        'E_SENDER_DOMAIN_NOT_AVAILABLE',
        'E_CONTENT_TOO_LARGE',
        'E_HEADER_NOT_ALLOWED',
        'E_HEADER_USE_API_FIELD',
        'E_HEADER_VALUE_INVALID',
        'E_HEADER_VALUE_TOO_LONG',
        'E_HEADER_NAME_INVALID',
        'E_HEADERS_TOO_LARGE',
        'E_HEADERS_TOO_MANY',
    ]).has(code);
}

function safeErrorCode(error) {
    const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN_ERROR';
    return /^[A-Z0-9_-]{1,80}$/u.test(code) ? code : 'UNKNOWN_ERROR';
}

function buildDiscordMessageContent(subject, body, imageUrl = '') {
    return [`**${subject}**`, '', body, ...(imageUrl ? ['', imageUrl] : [])].join('\n');
}

function buildDiscordPayload(subject, body, options = {}) {
    const format = validateDiscordFormat(options.format);
    const imageUrl = validateDiscordImageUrl(options.imageUrl);
    const imageName = stringValue(options.imageName || options.image?.name);
    const attachmentUrl = imageName ? `attachment://${imageName}` : '';
    const mentionRoleId = stringValue(options.mentionRoleId).trim();
    if (mentionRoleId && !OFFICIAL_SUPPORT_ROLE_IDS.has(mentionRoleId)) {
        throw new NewsletterError(400, 'メンションする公式ロールを確認してください。', 'invalid_official_mention_role');
    }
    const mention = mentionRoleId ? `<@&${mentionRoleId}>` : '';
    const payload = mentionRoleId
        ? { allowed_mentions: { parse: [], roles: [mentionRoleId], users: [] } }
        : { allowed_mentions: { parse: [] } };
    if (format === 'embed') {
        const embed = {
            title: subject,
            description: body,
            color: validateEmbedColor(options.embedColor),
            footer: { text: 'DPI-Bot 運営' },
        };
        if (mention) payload.content = mention;
        const effectiveImageUrl = attachmentUrl || imageUrl;
        if (effectiveImageUrl) embed.image = { url: effectiveImageUrl };
        payload.embeds = [embed];
    } else {
        payload.content = [mention, buildDiscordMessageContent(subject, body, imageUrl)].filter(Boolean).join('\n');
    }
    if (imageName) {
        payload.attachments = [{
            id: 0,
            filename: imageName,
            ...(stringValue(options.imageAlt).trim() ? { description: stringValue(options.imageAlt).trim() } : {}),
        }];
    }
    const nonce = stringValue(options.nonce).trim();
    if (nonce && /^[A-Za-z0-9_-]{1,25}$/u.test(nonce)) {
        payload.nonce = nonce;
        payload.enforce_nonce = true;
    }
    return payload;
}

async function sendDiscordAnnouncement(channelId, subject, body, env, options = {}) {
    const token = cleanConfigValue(env.DISCORD_BOT_TOKEN);
    if (!token) {
        const error = new Error('discord_delivery_not_configured');
        error.code = 'DISCORD_NOT_CONFIGURED';
        error.permanent = true;
        throw error;
    }
    if (!/^\d{17,20}$/u.test(channelId)) {
        const error = new Error('invalid_discord_channel');
        error.code = 'DISCORD_CHANNEL_INVALID';
        error.permanent = true;
        throw error;
    }
    const imageName = stringValue(options.imageName);
    const imageType = stringValue(options.imageType);
    const imageData = normalizeBinaryData(options.imageData);
    const payload = buildDiscordPayload(subject, body, {
        ...options,
        imageName: imageData ? imageName : '',
    });
    let requestBody;
    const headers = {
        Authorization: `Bot ${token}`,
        'User-Agent': 'DPI-Bot-Admin-Announcement/2.0',
    };
    if (imageData && imageName) {
        const form = new FormData();
        form.append('payload_json', JSON.stringify(payload));
        form.append('files[0]', new Blob([imageData], { type: imageType || 'application/octet-stream' }), imageName);
        requestBody = form;
    } else {
        headers['Content-Type'] = 'application/json';
        requestBody = JSON.stringify(payload);
    }
    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: 'POST',
        headers,
        body: requestBody,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(`discord_http_${response.status}`);
        error.code = `DISCORD_HTTP_${response.status}`;
        error.permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
        throw error;
    }
    return result;
}

function normalizeBinaryData(value) {
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
        return Uint8Array.from(value);
    }
    return null;
}

function bytesToBase64(bytes) {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

function statementChangedRows(result) {
    return Number(result?.meta?.changes ?? result?.changes ?? 0) > 0;
}

function subscribeAcceptedResponse() {
    return jsonResponse({
        success: true,
        message: '入力したアドレスが登録可能な場合、確認メールを送信しました。24時間以内に確認してください。',
    }, 202);
}

function actionFormPage({ title, description, action, token, buttonLabel, danger = false }) {
    const buttonColor = danger ? '#b42318' : '#1769aa';
    const body = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} - DPI-Bot</title></head><body style="margin:0;background:#f2f5f8;font-family:sans-serif;color:#172033"><main style="max-width:620px;margin:8vh auto;padding:28px;background:#fff;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.08)"><h1 style="font-size:24px">${escapeHtml(title)}</h1><p style="line-height:1.8">${escapeHtml(description)}</p><form action="${escapeHtml(action)}" method="post"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit" style="border:0;border-radius:6px;padding:12px 18px;background:${buttonColor};color:#fff;font-weight:700;cursor:pointer">${escapeHtml(buttonLabel)}</button></form><p style="margin-top:24px"><a href="/">DPI-Botトップへ戻る</a></p></main></body></html>`;
    return new Response(body, { status: 200, headers: HTML_HEADERS });
}

function actionResultPage(title, description, success, status = 200) {
    const color = success ? '#08783e' : '#b42318';
    const body = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} - DPI-Bot</title></head><body style="margin:0;background:#f2f5f8;font-family:sans-serif;color:#172033"><main style="max-width:620px;margin:8vh auto;padding:28px;background:#fff;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.08)"><h1 style="font-size:24px;color:${color}">${escapeHtml(title)}</h1><p style="line-height:1.8">${escapeHtml(description)}</p><p><a href="/site/mail/">メール配信ページへ戻る</a></p></main></body></html>`;
    return new Response(body, { status, headers: HTML_HEADERS });
}

function newsletterErrorResponse(error, request, isAdminAsset) {
    const url = new URL(request.url);
    const htmlEndpoint = isAdminAsset
        || url.pathname === '/api/newsletter/confirm'
        || url.pathname === '/api/newsletter/unsubscribe';
    if (error instanceof AccessAuthError) {
        if (isAdminAsset) {
            return actionResultPage('管理画面を開けません', error.publicMessage, false, error.status);
        }
        return jsonResponse({ success: false, message: error.publicMessage, code: error.code }, error.status);
    }
    if (error instanceof NewsletterError) {
        if (htmlEndpoint) return actionResultPage('処理できませんでした', error.publicMessage, false, error.status);
        return jsonResponse(
            { success: false, message: error.publicMessage, code: error.code },
            error.status,
            error.allow ? { Allow: error.allow } : {},
        );
    }

    console.error('Newsletter request failed', {
        path: url.pathname,
        errorName: error?.name || 'Error',
        errorCode: error?.code || 'unknown',
    });
    if (htmlEndpoint) {
        return actionResultPage('処理できませんでした', '時間をおいて再度お試しください。', false, 500);
    }
    return jsonResponse(
        { success: false, message: '処理に失敗しました。時間をおいて再度お試しください。', code: 'internal_error' },
        500,
    );
}

function escapeHtml(value) {
    return stringValue(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...JSON_HEADERS, ...extraHeaders },
    });
}

function cleanConfigValue(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function stringValue(value) {
    return typeof value === 'string' ? value : '';
}

export const __test = Object.freeze({
    adminSummary,
    buildCampaignEmail,
    emailSignatureText,
    constantTimeEqual,
    createUnsubscribeToken,
    escapeHtml,
    isConfirmationToken,
    loadCampaignRecipients,
    normalizePublicOrigin,
    parseSerializedCategories,
    renderMarkdownEmail,
    buildDiscordPayload,
    sendDiscordAnnouncement,
    serializeCategories,
    serializedCategoriesOverlap,
    validateCampaignBody,
    validateCampaignSubject,
    validateCategories,
    validateDeliverySlots,
    validateDiscordTargeting,
    validateDiscordAnnouncement,
    validateDiscordOptions,
    validateOfficialSupportOptions,
    validateRecipientGroups,
    validateSurfaceRecipientGroups,
    validateTargetServerIds,
    verifyUnsubscribeToken,
});

