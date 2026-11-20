import { geographicEntitlements, geographicRuleAllowed } from './supporter-geo.js';
import { enrichCustomGroup } from './supporter-custom.js';
import { billingReady } from './supporter-billing.js';
import { planFeatures, hasFeature, imageTier } from '../site/supporter/plan-features.js';
import { IMAGE_RULE_TYPES, isImageRuleType, isImageRuleV2Type, imageRulesEnabled, imageRulesV2Enabled, imageRuleSnapshotFields } from './supporter-image-rules.js';
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);
const ALLOWED_RULE_TYPES = new Set(['earthquake', 'eew', 'weather', 'rain-radar', ...IMAGE_RULE_TYPES]);
const SNAPSHOT_TTL_SECONDS = 30 * 60 * 60;
const MAX_RULES = 10_000;
const MAX_RESPONSE_BYTES = 128 * 1024;

// テスト公開中（SUPPORTER_PREVIEW_OPEN=true かつ一般公開前）は、許可リスト（SUPPORTER_TEST_USER_IDS）の
// 利用者と、テスト公開を始めた時刻（SUPPORTER_PREVIEW_OPENED_AT）より前に登録済みのアカウントだけを
// 配信対象にする。テスト公開後に外部の人が登録・テスト決済をしても本番の配信には使わない。
// 開始時刻が未設定・不正なら、許可リストの利用者だけにする（安全側）。
function snapshotUserAllowed(env, row) {
    const flag = name => String(env[name] ?? '').trim().toLowerCase() === 'true';
    if (flag('SUPPORTER_PUBLIC_ENABLED') || !flag('SUPPORTER_PREVIEW_OPEN')) return true;
    const allowed = new Set(String(env.SUPPORTER_TEST_USER_IDS ?? '').split(',').map(value => value.trim()).filter(value => /^\d{17,20}$/.test(value)));
    if (allowed.has(String(row?.discord_user_id || ''))) return true;
    const openedAt = Date.parse(String(env.SUPPORTER_PREVIEW_OPENED_AT ?? ''));
    const registeredAt = Date.parse(String(row?.registered_at ?? ''));
    return Number.isFinite(openedAt) && Number.isFinite(registeredAt) && registeredAt < openedAt;
}

function clean(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function rulesFromSettings(settingsJson) {
    try {
        const value = JSON.parse(settingsJson || '{}');
        return Array.isArray(value?.rules) ? value.rules : [];
    } catch {
        return [];
    }
}

function normalizedRule(rule, id) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) || !ALLOWED_RULE_TYPES.has(clean(rule.type))) return null;
    const guildId = clean(rule.guildId);
    const channelIds = [...new Set((Array.isArray(rule.channelIds) && rule.channelIds.length
        ? rule.channelIds
        : [rule.channelId]).map(clean).filter(value => /^\d{17,20}$/.test(value)))];
    if (!/^\d{17,20}$/.test(guildId) || !channelIds.length) return null;
    // 保存済みの古いデータに21件以上あっても、スナップショット全体（全利用者分）が拒否されないよう20件で切る。
    const limitedChannelIds = channelIds.slice(0, 20);
    return {
        ...rule,
        id,
        guildId,
        channelId: limitedChannelIds[0],
        channelIds: limitedChannelIds,
    };
}

async function digestPrefix(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return [...digest.slice(0, 8)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function buildSupporterSnapshot(db, env, loadSubscriptions, nowMs = Date.now()) {
    const rows = await db.prepare(`SELECT a.discord_user_id,a.settings_json,a.revision,a.registered_at,b.customer_id
        FROM supporter_accounts a
        JOIN supporter_billing b ON b.discord_user_id=a.discord_user_id
        WHERE a.account_status='active' AND b.customer_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM supporter_dunning d
            WHERE d.customer_id=b.customer_id AND d.status='suspended'
          )
        ORDER BY a.discord_user_id`).all();
    const accounts = (rows.results || []).filter(row => snapshotUserAllowed(env, row));
    const customerIds = [...new Set(accounts.map(row => clean(row.customer_id)).filter(Boolean))];
    const grouped = await enrichCustomGroup(db,accounts,await loadSubscriptions(env, customerIds));
    const rules = [];
    const imagesEnabled = imageRulesEnabled(env);
    // eew-map / warning-table: only once every home server and the AWS Lambda know them.
    const imagesV2Enabled = imagesEnabled && imageRulesV2Enabled(env);
    for (const row of accounts) {
        const subscriptions = grouped.get(row.customer_id) || [];
        const entitled = subscriptions.some(item => item?.recognizedPlan !== false && ACTIVE_SUBSCRIPTION_STATUSES.has(item?.status));
        if (!entitled) continue;
        const geographicAccess = geographicEntitlements(subscriptions);
        const features = planFeatures(subscriptions);
        const rainfallThresholdAllowed = hasFeature(features, 'rainfallThreshold');
        const tier = imageTier(subscriptions);
        const custom=subscriptions.find(item=>item?.managedCustom===true&&['active','trialing'].includes(item.status));
        const allRules=rulesFromSettings(row.settings_json);
        // Fail closed on unapproved custom-plan combinations, without deleting settings.
        if(custom&&allRules.length>custom.rules)continue;
        const guilds=new Set(),channels=new Set();
        for(const rule of allRules){
          const destinations=Array.isArray(rule.channelIds)&&rule.channelIds.length?rule.channelIds:[rule.channelId];
          guilds.add(String(rule.guildId||''));
          for(const channel of destinations)channels.add(String(rule.guildId||'')+':'+String(channel||''));
          if(custom&&((!custom.complexConditions&&(rule.conditionLogic==='or'||rule.conditions?.length))||
            (!custom.multiDestination&&destinations.length>1)))break;
        }
        if(custom&&(guilds.size>custom.servers||channels.size>custom.channels||allRules.some(rule=>(!custom.complexConditions&&(rule.conditionLogic==='or'||rule.conditions?.length))||(!custom.multiDestination&&Array.isArray(rule.channelIds)&&rule.channelIds.length>1))))continue;
        for (const [index, rule] of allRules.entries()) {
            if (isImageRuleType(rule?.type)) {
                // Image rules ship only while the rollout flag is on (kill switch) and only when
                // the owner's features allow the type; paid filters are never widened on downgrade.
                if (!imagesEnabled || (isImageRuleV2Type(rule.type) && !imagesV2Enabled)) continue;
                const fields = imageRuleSnapshotFields(rule, features, tier);
                if (!fields) continue;
                const id = `rule-${await digestPrefix(`${row.discord_user_id}:${Number(row.revision) || 0}:${index + 1}`)}`;
                const base = normalizedRule(rule, id);
                if (base) rules.push({id, name: clean(rule.name).slice(0, 80), type: base.type, guildId: base.guildId, channelId: base.channelId, channelIds: base.channelIds, ...fields});
                continue;
            }
            // Never broaden a previously paid geographic filter on downgrade.
            // Suspend incompatible rules until the customer chooses a new scope.
            if (!geographicRuleAllowed(rule, geographicAccess)) continue;
            // Do not broaden a Basic contract's previously saved Plus-only threshold.
            if (rule.type==='rain-radar' && rule.radarCondition==='rainfall-threshold' && !rainfallThresholdAllowed) continue;
            const id = `rule-${await digestPrefix(`${row.discord_user_id}:${Number(row.revision) || 0}:${index + 1}`)}`;
            const value = normalizedRule(rule, id);
            if (value) rules.push(value);
        }
    }
    if (rules.length > MAX_RULES) throw new Error('Supporter snapshot rule limit exceeded');
    const generatedAtMs = Math.max(1_000, Math.floor(Number(nowMs)));
    const generatedAt = Math.floor(generatedAtMs / 1000);
    const canonicalRules = JSON.stringify(rules);
    return {
        // V2 explicitly prevents old delivery workers from interpreting new
        // municipality filters as broad region-only routes during rollout.
        // V4 carries paid image rules; older home servers reject unknown rule types.
        schemaVersion: rules.some(rule => isImageRuleType(rule.type)) ? 4 : rules.some(rule => rule.type === 'eew' && rule.sendFinalReport === false) ? 3 : rules.some(rule => ['prefecture','district','municipality'].some(key => rule[key] && rule[key] !== 'all') || rule.strictMunicipality === true) ? 2 : 1,
        version: `supporter-${generatedAtMs}-${await digestPrefix(canonicalRules)}`,
        generatedAt,
        expiresAt: generatedAt + SNAPSHOT_TTL_SECONDS,
        routing: {
            dedicatedMinDestinations: 100,
            urlsPerWorker: 25,
            maxDedicatedWorkers: 10,
        },
        rules,
    };
}

async function readBoundedJson(response) {
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_RESPONSE_BYTES) throw new Error('Supporter snapshot publisher response is too large');
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error('Supporter snapshot publisher response is too large');
    try {
        return JSON.parse(text);
    } catch {
        throw new Error('Supporter snapshot publisher returned invalid JSON');
    }
}

export async function publishSupporterSnapshot(env, snapshot) {
    const endpoint = clean(env.AWS_CHANNEL_DIRECTORY_URL);
    const token = clean(env.AWS_CHANNEL_DIRECTORY_TOKEN);
    if (!endpoint || !token) return {published: false, reason: 'not_configured'};
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') throw new Error('Supporter snapshot publisher must use HTTPS');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                action: 'supporter-snapshot',
                actor: 'system@dpi-bot.com',
                requestId: crypto.randomUUID(),
                snapshot,
            }),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timeout);
    }
    const result = await readBoundedJson(response);
    if (!response.ok || result?.success !== true) {
        // 拒否理由を残す（30時間で期限切れになり全員の配信が止まるため、原因を追えるように）。
        console.error('Supporter snapshot rejected', {status: response.status, message: String(result?.message || result?.error || '').slice(0, 200)});
        throw new Error('Supporter snapshot publisher rejected the update');
    }
    return {published: result.published === true, version: clean(result.version) || snapshot.version};
}

export async function refreshSupporterSnapshot(env, db, loadSubscriptions, nowMs = Date.now()) {
    if (!clean(env.AWS_CHANNEL_DIRECTORY_URL) || !clean(env.AWS_CHANNEL_DIRECTORY_TOKEN)) {
        return {published: false, reason: 'not_configured'};
    }
    // 決済設定が無い状態では契約一覧が空になり、「ルール0件」の正しいスナップショットとして全員の配信を止めてしまう。
    if (!billingReady(env)) return {published: false, reason: 'billing_not_ready'};
    const snapshot = await buildSupporterSnapshot(db, env, loadSubscriptions, nowMs);
    return {...await publishSupporterSnapshot(env, snapshot), snapshot};
}

export async function refreshSupporterSnapshotSafely(env, db, loadSubscriptions, reason = 'unknown') {
    try {
        return await refreshSupporterSnapshot(env, db, loadSubscriptions);
    } catch (error) {
        console.error('Supporter snapshot refresh failed', {reason, errorName: error?.name || 'Error'});
        return {published: false, reason: 'failed'};
    }
}
