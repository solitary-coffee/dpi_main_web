import { enrichCustomGroup } from './supporter-custom.js';
import { isActiveSupporterSubscription, supporterEntitlementRows } from './supporter-snapshot.js';
import { developerSubscriptionSummary, isSupporterDeveloper } from './supporter-developer.js';

const clean = value => String(value ?? '').trim();
const snowflake = value => /^\d{17,20}$/.test(clean(value));
const ROLE_KEYS = ['SUPPORTER_ROLE_MEMBER', 'SUPPORTER_ROLE_BASIC', 'SUPPORTER_ROLE_PLUS', 'SUPPORTER_ROLE_PRO', 'SUPPORTER_ROLE_CUSTOM'];
const rank = {supporter: 1, plus: 2, pro: 3};

export function supporterRoleConfig(env) {
 const roles = ROLE_KEYS.map(key => clean(env?.[key]));
 if (env?.SUPPORTER_BILLING_MODE !== 'live' || !clean(env?.DISCORD_BOT_TOKEN) || !snowflake(env?.SUPPORTER_ROLE_GUILD_ID) || roles.some(role => !snowflake(role)) || new Set(roles).size !== roles.length) return null;
 return {guild: clean(env.SUPPORTER_ROLE_GUILD_ID), token: clean(env.DISCORD_BOT_TOKEN), member: roles[0], plans: {supporter: roles[1], plus: roles[2], pro: roles[3], custom: roles[4]}, all: new Set(roles)};
}

export function desiredSupporterRoles(config, subscriptions) {
 const active = (subscriptions || []).filter(isActiveSupporterSubscription);
 if (!active.length) return new Set();
 const desired = new Set([config.member]);
 const plan = active.map(item => item?.planId).filter(id => rank[id]).sort((a, b) => rank[b] - rank[a])[0];
 if (plan) desired.add(config.plans[plan]);
 if (active.some(item => item?.managedCustom === true || item?.planId === 'custom')) desired.add(config.plans.custom);
 return desired;
}

async function discordRequest(config, uid, role, method) {
 const controller = new AbortController();
 const timeout = setTimeout(() => controller.abort(), 8000);
 try {
  const response = await fetch(`https://discord.com/api/v10/guilds/${config.guild}/members/${uid}/roles/${role}`, {method, headers: {Authorization: `Bot ${config.token}`, 'X-Audit-Log-Reason': 'DPI supporter billing reconciliation'}, signal: controller.signal});
  let code = 0;
  if (response.status === 404) try { code = Number((await response.clone().json())?.code) || 0; } catch {}
  return {ok: response.ok, status: response.status, code};
 } catch (error) { return {ok: false, status: 0, code: 0, errorName: error?.name || 'Error'}; }
 finally { clearTimeout(timeout); }
}

async function record(db, uid, role, status, error = null) {
 await db.prepare(`INSERT INTO supporter_discord_roles(discord_user_id,role_id,status,updated_at,last_error,attempts) VALUES(?,?,?,?,?,?)
  ON CONFLICT(discord_user_id,role_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,last_error=excluded.last_error,attempts=supporter_discord_roles.attempts+1`)
  .bind(uid, role, status, Math.floor(Date.now() / 1000), error, 1).run();
}

export async function reconcileSupporterRoles(env, db, loadSubscriptions, options = {}) {
 const config = supporterRoleConfig(env); if (!config) return {requests: 0, disabled: true};
 const limit = Math.min(40, Math.max(0, Number(options.limit) || 40));
 try {
  let onlyUid = snowflake(options.discordUserId) ? clean(options.discordUserId) : '';
  if (options.customer !== undefined) {
   const owner = options.customer ? await db.prepare('SELECT discord_user_id FROM supporter_billing WHERE customer_id=?').bind(options.customer).first() : null;
   if (!snowflake(owner?.discord_user_id)) return {requests: 0};
   onlyUid = owner.discord_user_id;
  }
  let accounts = await supporterEntitlementRows(db, env, options.nowMs || Date.now());
  if (onlyUid) accounts = accounts.filter(row => row.discord_user_id === onlyUid);
  const ids = [...new Set(accounts.map(row => clean(row.customer_id)).filter(Boolean))];
  const grouped = await enrichCustomGroup(db, accounts, await loadSubscriptions(env, ids));
  const trackedStatement = db.prepare(`SELECT discord_user_id,role_id,status,updated_at,last_error FROM supporter_discord_roles${onlyUid ? ' WHERE discord_user_id=?' : ''} ORDER BY updated_at,discord_user_id,role_id`);
  const tracked = await (onlyUid ? trackedStatement.bind(onlyUid) : trackedStatement).all();
  const byUid = new Map(accounts.map(row => [row.discord_user_id, desiredSupporterRoles(config,isSupporterDeveloper(env,row.discord_user_id)?[developerSubscriptionSummary()]:(grouped.get(row.customer_id) || []))]));
  const known = new Map((tracked.results || []).filter(row => config.all.has(row.role_id)).map(row => [`${row.discord_user_id}:${row.role_id}`, row]));
  const removals = [], grants = [], renewals = [];
  // 付けたロールと、外せなかったロールを外す。付けたか分からない（時間切れ・5xx）ものも外す。断られた（4xx）ものは付いていない。
  for (const row of tracked.results || []) if (config.all.has(row.role_id) && !byUid.get(row.discord_user_id)?.has(row.role_id)
   && (['granted', 'pending_remove'].includes(row.status) || (row.status === 'pending_grant' && !/^http_4/.test(row.last_error || '')))) removals.push({uid: row.discord_user_id, role: row.role_id, method: 'DELETE', at: Number(row.updated_at) || 0});
  for (const [uid, desired] of byUid) for (const role of desired) {
   const row = known.get(`${uid}:${role}`), at = Number(row?.updated_at) || 0;
   if (row?.status !== 'granted') grants.push({uid, role, method: 'PUT', at});
   // サーバーを抜けて入り直すとロールは消える。定期処理のときに、1日に1回付け直す。
   else if (options.renew === true && at < Math.floor((options.nowMs || Date.now()) / 1000) - 20 * 3600) renewals.push({uid, role, method: 'PUT', at});
  }
  // 外す → 付ける → 付け直す。同じ種類では古いものから（失敗し続ける人で枠を使い切らない）。
  const oldest = (a, b) => a.at - b.at;
  const operations = [...removals.sort(oldest), ...grants.sort(oldest), ...renewals.sort(oldest)];
  let requests = 0;
  for (const operation of operations.slice(0, limit)) {
   const result = await discordRequest(config, operation.uid, operation.role, operation.method); requests += 1;
   if (result.status === 429) { await record(db, operation.uid, operation.role, operation.method === 'PUT' ? 'pending_grant' : 'pending_remove', 'http_429'); break; }
   if (result.ok || (operation.method === 'DELETE' && result.status === 404)) await record(db, operation.uid, operation.role, operation.method === 'PUT' ? 'granted' : 'removed');
   else await record(db, operation.uid, operation.role, operation.method === 'PUT' ? 'pending_grant' : 'pending_remove', result.status ? `http_${result.status}${result.code ? `_code_${result.code}` : ''}` : result.errorName || 'request_failed');
  }
  return {requests, pending: Math.max(0, operations.length - requests)};
 } catch (error) {
  console.error('Supporter role reconciliation failed', {errorName: error?.name || 'Error'});
  return {requests: 0, failed: true};
 }
}

export const reconcileSupporterRolesSafely = reconcileSupporterRoles;
