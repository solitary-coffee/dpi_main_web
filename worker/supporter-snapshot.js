import { geographicEntitlements, geographicRuleAllowed } from './supporter-geo.js';
import { enrichCustomGroup } from './supporter-custom.js';
const ACTIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);
const ALLOWED_RULE_TYPES = new Set(['earthquake', 'eew', 'weather', 'rain-radar']);
const SNAPSHOT_TTL_SECONDS = 30 * 60 * 60;
const MAX_RULES = 10_000;
const MAX_RESPONSE_BYTES = 128 * 1024;

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
    return {
        ...rule,
        id,
        guildId,
        channelId: channelIds[0],
        channelIds,
    };
}

async function digestPrefix(value) {
    const bytes = new TextEncoder().encode(value);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return [...digest.slice(0, 8)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function buildSupporterSnapshot(db, env, loadSubscriptions, nowMs = Date.now()) {
    const rows = await db.prepare(`SELECT a.discord_user_id,a.settings_json,a.revision,b.customer_id
        FROM supporter_accounts a
        JOIN supporter_billing b ON b.discord_user_id=a.discord_user_id
        WHERE a.account_status='active' AND b.customer_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM supporter_dunning d
            WHERE d.customer_id=b.customer_id AND d.status='suspended'
          )
        ORDER BY a.discord_user_id`).all();
    const accounts = rows.results || [];
    const customerIds = [...new Set(accounts.map(row => clean(row.customer_id)).filter(Boolean))];
    const grouped = await enrichCustomGroup(db,accounts,await loadSubscriptions(env, customerIds));
    const rules = [];
    for (const row of accounts) {
        const subscriptions = grouped.get(row.customer_id) || [];
        const entitled = subscriptions.some(item => item?.recognizedPlan !== false && ACTIVE_SUBSCRIPTION_STATUSES.has(item?.status));
        if (!entitled) continue;
        const geographicAccess = geographicEntitlements(subscriptions);
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
            // Never broaden a previously paid geographic filter on downgrade.
            // Suspend incompatible rules until the customer chooses a new scope.
            if (!geographicRuleAllowed(rule, geographicAccess)) continue;
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
        schemaVersion: rules.some(rule => rule.type === 'eew' && rule.sendFinalReport === false) ? 3 : rules.some(rule => ['prefecture','district','municipality'].some(key => rule[key] && rule[key] !== 'all') || rule.strictMunicipality === true) ? 2 : 1,
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
    if (!response.ok || result?.success !== true) throw new Error('Supporter snapshot publisher rejected the update');
    return {published: result.published === true, version: clean(result.version) || snapshot.version};
}

export async function refreshSupporterSnapshot(env, db, loadSubscriptions, nowMs = Date.now()) {
    if (!clean(env.AWS_CHANNEL_DIRECTORY_URL) || !clean(env.AWS_CHANNEL_DIRECTORY_TOKEN)) {
        return {published: false, reason: 'not_configured'};
    }
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
