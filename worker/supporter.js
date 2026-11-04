import { requireSession, assertCsrf, assertSameOrigin, readJson, fetchGuildChannels } from './reuse.js';
import { authenticateNewsletterAdmin } from './access.js';
import { adminBillingAction, billingAction, billingReady, subscriptionSummariesByCustomer } from './supporter-billing.js';

const response = (data, status = 200) => Response.json(data, {status, headers: {'Cache-Control':'no-store'}});
const notFound = () => new Response('Not Found', {
 status: 404,
 headers: {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
 },
});

function clean(value) { return typeof value === 'string' ? value.trim() : ''; }
function ruleCount(settingsJson) {
 try {
  const settings = JSON.parse(settingsJson || '{}');
  return Array.isArray(settings.rules) ? settings.rules.length : 0;
 } catch { return 0; }
}
export function supporterAdminAccount(row, subscriptions = [], billingError = '') {
 return {
  discordUserId: row.discord_user_id,
  registeredAt: row.registered_at,
  updatedAt: row.updated_at,
  revision: Number(row.revision || 0),
  ruleCount: ruleCount(row.settings_json),
  subscriptions,
  billingError,
 };
}
function assertAdminOrigin(request) {
 const url = new URL(request.url);
 const origin = clean(request.headers.get('origin'));
 const site = clean(request.headers.get('sec-fetch-site'));
 if ((origin && origin !== url.origin) || site === 'cross-site') throw Object.assign(new Error('別サイトからの管理操作は許可されていません。'),{status:403});
}
async function writeSupporterAudit(db, actor, action, uid, details) {
 try {
  await db.prepare(`INSERT INTO admin_audit_events
   (id, actor, action, entity_type, entity_id, details_json, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`)
   .bind(crypto.randomUUID(),actor,`supporter.${action}`,'supporter_account',uid,JSON.stringify(details).slice(0,8000),new Date().toISOString()).run();
  return true;
 } catch (error) {
  console.error('BASIC billing audit write failed',{action,errorName:error?.name||'Error'});
  return false;
 }
}
export const SUPPORTER_REGIONS = Object.freeze([
 ['all', '全国'],
 ['hokkaido', '北海道地方'],
 ['tohoku', '東北地方'],
 ['kanto-koshin', '関東甲信地方'],
 ['hokuriku', '北陸地方'],
 ['tokai', '東海地方'],
 ['kinki', '近畿地方'],
 ['chugoku', '中国地方'],
 ['shikoku', '四国地方'],
 ['kyushu-north', '九州北部地方（山口県を含む）'],
 ['kyushu-south-amami', '九州南部・奄美地方'],
 ['okinawa', '沖縄地方'],
]);
export const WEATHER_LEVELS = Object.freeze([
 ['all', 'すべての警戒レベル'],
 ['1', 'レベル1 早期注意情報以上'],
 ['2', 'レベル2 注意報以上'],
 ['3', 'レベル3 警報以上'],
 ['4', 'レベル4 危険警報以上'],
 ['5', 'レベル5 特別警報'],
]);
export const WARNING_LEVELS = Object.freeze([
 ['all', '注意報以上'],
 ['advisory', '注意報'],
 ['warning', '警報以上'],
 ['special', '特別警報のみ'],
]);
export const EARTHQUAKE_DETAILS = Object.freeze([
 ['all', 'すべての地震情報'],
 ['intensity-flash', '震度速報'],
 ['hypocenter', '震源に関する情報'],
 ['hypocenter-intensity', '震源・震度に関する情報'],
 ['long-period', '長周期地震動に関する観測情報'],
 ['distant-earthquake', '遠地地震に関する情報'],
 ['hypocenter-update', '顕著な地震の震源要素更新のお知らせ'],
]);
export const EEW_DETAILS = Object.freeze([
 ['all', 'すべての緊急地震速報'],
 ['forecast', '緊急地震速報（地震動予報）'],
 ['warning', '緊急地震速報（警報）'],
]);
export const EEW_WARNING_AREA_MODES = Object.freeze([
 ['all', '警報地方を問わない'],
 ['target-only', '対象警報地方のみ'],
]);
export const WEATHER_DETAILS = Object.freeze([
 ['all', 'すべての気象情報'],
 ['heavy-rain-level', '大雨に関する警戒レベル情報'],
 ['landslide-level', '土砂災害に関する警戒レベル情報'],
 ['storm-surge-level', '高潮に関する警戒レベル情報'],
 ['storm-blizzard-warning', '暴風・暴風雪に関する警報・注意報'],
 ['wave-warning', '波浪に関する警報・注意報'],
 ['heavy-snow-warning', '大雪に関する警報・注意報'],
 ['other-advisory', 'その他の気象注意報'],
 ['tornado', '竜巻注意情報'],
 ['record-short-rain', '記録的短時間大雨情報'],
 ['designated-river', '指定河川洪水予報'],
 ['heatstroke', '熱中症警戒アラート'],
 ['early-weather', '早期天候情報'],
 ['general-weather', '全般気象情報'],
 ['typhoon', '台風情報'],
 ['weather-disaster', '気象防災速報'],
 ['linear-rainband', '線状降水帯に関する情報'],
 ['significant-snow', '顕著な大雪情報'],
 ['weather-commentary', '気象解説情報'],
 ['tide-commentary', '気象解説情報（潮位）'],
]);
export const CHANGE_DIRECTIONS = Object.freeze([
 ['all', '変化を問わない'],
 ['increase', '上昇時'],
 ['decrease', '下降時'],
 ['both', '上昇・下降時'],
]);
const INTENSITIES = new Set(['1','2','3','4','5-','5+','6-','6+','7']);
const REGION_IDS = new Set(SUPPORTER_REGIONS.map(([id]) => id));
const WEATHER_LEVEL_IDS = new Set(WEATHER_LEVELS.map(([id]) => id));
const WARNING_LEVEL_IDS = new Set(WARNING_LEVELS.map(([id]) => id));
const CHANGE_DIRECTION_IDS = new Set(CHANGE_DIRECTIONS.map(([id]) => id));
const EEW_WARNING_AREA_MODE_IDS = new Set(EEW_WARNING_AREA_MODES.map(([id]) => id));
const DETAILS = {
 earthquake: new Set(EARTHQUAKE_DETAILS.map(([id]) => id)),
 eew: new Set(EEW_DETAILS.map(([id]) => id)),
 weather: new Set(WEATHER_DETAILS.map(([id]) => id)),
};
const WEATHER_ALERT_DETAILS = new Set(['heavy-rain-level','landslide-level','storm-surge-level']);
const WEATHER_WARNING_DETAILS = new Set(['storm-blizzard-warning','wave-warning','heavy-snow-warning','other-advisory']);

function optionalMagnitude(value) {
 if (value === '' || value === undefined || value === null) return null;
 const number = Number(value);
 if (!Number.isFinite(number) || number < 0 || number > 10) throw Object.assign(new Error('マグニチュードは0から10の範囲で指定してください。'),{status:400});
 return Math.round(number * 10) / 10;
}

export function normalizeSupporterRules(input, guilds) {
 if (!Array.isArray(input) || input.length > 5) throw Object.assign(new Error('通知ルールは5件までです。'),{status:400});
 return input.map(rule => {
  const name = clean(rule?.name);
  const guildId = clean(rule?.guildId);
  const channelId = clean(rule?.channelId);
  const type = clean(rule?.type);
  const region = clean(rule?.region) || 'all';
  if (!name || name.length > 80 || !guilds.some(g=>g.id===guildId) || !/^\d{17,20}$/.test(channelId)
      || !['earthquake','eew','weather'].includes(type) || !REGION_IDS.has(region)) {
   throw Object.assign(new Error('入力内容とサーバー管理権限を確認してください。'),{status:400});
  }
  const requestedDetail = clean(rule?.detail) || 'all';
  const detail = type === 'eew' && requestedDetail === 'intensity-change' ? 'forecast' : requestedDetail;
  if (!DETAILS[type].has(detail)) throw Object.assign(new Error('情報の詳細種別を確認してください。'),{status:400});
  if (type === 'weather') {
   const weatherLevel = WEATHER_ALERT_DETAILS.has(detail) ? (clean(rule?.weatherLevel) || 'all') : '';
   const warningLevel = WEATHER_WARNING_DETAILS.has(detail) ? (clean(rule?.warningLevel) || 'all') : '';
   if (weatherLevel && !WEATHER_LEVEL_IDS.has(weatherLevel)) throw Object.assign(new Error('気象情報の警戒レベルを確認してください。'),{status:400});
   if (warningLevel && !WARNING_LEVEL_IDS.has(warningLevel)) throw Object.assign(new Error('警報・注意報の条件を確認してください。'),{status:400});
   return {name,guildId,channelId,type,detail,region,intensity:'',intensityChange:'',magnitudeMin:null,magnitudeMax:null,magnitudeChange:'',weatherLevel,warningLevel,eewWarningAreaMode:''};
  }
  const intensity = clean(rule?.intensity);
  const intensityChange = clean(rule?.intensityChange) || 'all';
  const magnitudeChange = clean(rule?.magnitudeChange) || 'all';
  if (!INTENSITIES.has(intensity)) throw Object.assign(new Error('通知する最低震度を確認してください。'),{status:400});
  if (!CHANGE_DIRECTION_IDS.has(intensityChange) || !CHANGE_DIRECTION_IDS.has(magnitudeChange)) throw Object.assign(new Error('震度・マグニチュードの変化条件を確認してください。'),{status:400});
  const magnitudeMin = optionalMagnitude(rule?.magnitudeMin);
  const magnitudeMax = optionalMagnitude(rule?.magnitudeMax);
  if (magnitudeMin !== null && magnitudeMax !== null && magnitudeMin > magnitudeMax) throw Object.assign(new Error('マグニチュードの下限は上限以下にしてください。'),{status:400});
  const eewWarningAreaMode = type === 'eew' && detail === 'warning' ? (clean(rule?.eewWarningAreaMode) || 'all') : '';
  if (eewWarningAreaMode && !EEW_WARNING_AREA_MODE_IDS.has(eewWarningAreaMode)) throw Object.assign(new Error('緊急地震速報（警報）の対象地方条件を確認してください。'),{status:400});
  return {name,guildId,channelId,type,detail,region,intensity,intensityChange,magnitudeMin,magnitudeMax,magnitudeChange,weatherLevel:'',warningLevel:'',eewWarningAreaMode};
 });
}

async function assertRuleChannels(rules, env) {
 const byGuild = new Map();
 for (const rule of rules) {
  if (!byGuild.has(rule.guildId)) byGuild.set(rule.guildId, await fetchGuildChannels(rule.guildId, env));
  if (!byGuild.get(rule.guildId).some(channel => String(channel.id) === rule.channelId)) {
   throw Object.assign(new Error('選択したチャンネルを確認できません。再読み込みして選び直してください。'),{status:400});
  }
 }
}

export function supporterPublicEnabled(env) {
 return clean(env.SUPPORTER_PUBLIC_ENABLED).toLowerCase() === 'true';
}
export function supporterTestUserAllowed(env, discordUserId) {
 if (supporterPublicEnabled(env)) return true;
 const allowed = new Set(clean(env.SUPPORTER_TEST_USER_IDS)
  .split(',')
  .map(value => value.trim())
  .filter(value => /^\d{17,20}$/.test(value)));
 return allowed.has(String(discordUserId || ''));
}

async function supporterSite(request, env, db) {
 const method = request.method.toUpperCase();
 if (!['GET', 'HEAD'].includes(method)) return notFound();
 if (!supporterPublicEnabled(env)) {
  let allowed = false;
  try {
   const session = await requireSession(request, {...env, REUSE_DB: db});
   allowed = supporterTestUserAllowed(env, session.discord_user_id);
  } catch { /* Hide both missing sessions and configuration details. */ }
  if (!allowed) {
   try {
    await authenticateNewsletterAdmin(request, env);
    allowed = true;
   } catch { /* Return the same 404 for every unauthorized visitor. */ }
  }
  if (!allowed) return notFound();
 }
 const asset = await env.ASSETS.fetch(request);
 const headers = new Headers(asset.headers);
 headers.set('Cache-Control', 'private, no-store');
 if (!supporterPublicEnabled(env)) headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
 return new Response(asset.body, {status: asset.status, statusText: asset.statusText, headers});
}

export async function handleSupporterRequest(request, env) {
 const path = new URL(request.url).pathname;
 const isSupporterSite = path === '/site/supporter' || path.startsWith('/site/supporter/');
 const isSupporterAdmin = path === '/site/supporter-admin' || path.startsWith('/site/supporter-admin/');
 if (!path.startsWith('/api/supporter/') && !isSupporterAdmin && !isSupporterSite) return null;
 try {
  const db = env.REUSE_DB || env.NEWSLETTER_DB;
  if (isSupporterSite) return await supporterSite(request, env, db);
  if (isSupporterAdmin) {
   const admin = await authenticateNewsletterAdmin(request, env);
   if (path === '/site/supporter-admin') {
    const redirect = new URL(request.url);redirect.pathname='/site/supporter-admin/';
    return new Response(null,{status:308,headers:{Location:redirect.toString(),'Cache-Control':'no-store'}});
   }
   if (path === '/site/supporter-admin/api/action') {
    if (request.method !== 'POST') return response({message:'Method not allowed'},405);
    assertAdminOrigin(request);
    const input = await readJson(request);
    const uid = clean(input.discordUserId);
    if (!/^\d{17,20}$/.test(uid) || input.confirmDiscordUserId !== uid) return response({message:'対象Discord IDの確認入力が一致しません。'},400);
    const account = await db.prepare(`SELECT a.discord_user_id, b.customer_id
     FROM supporter_accounts a LEFT JOIN supporter_billing b ON b.discord_user_id=a.discord_user_id
     WHERE a.discord_user_id=?`).bind(uid).first();
    if (!account) return response({message:'対象のBASIC登録者が見つかりません。'},404);
    const result = await adminBillingAction(env,account.customer_id,uid,input);
    const auditRecorded = await writeSupporterAudit(db,admin.email,input.action,uid,{reason:clean(input.reason),amount:Number(input.amount)||null,plan:clean(input.plan)||null,packs:Number.isInteger(Number(input.packs))?Number(input.packs):null,requestId:clean(input.requestId),resultMessage:result.message});
    return response({success:true,...result,auditRecorded});
   }
   if (request.method !== 'GET') return response({message:'Method not allowed'},405);
   if (path === '/site/supporter-admin/api/accounts') {
    const rows = await db.prepare(`SELECT a.discord_user_id, a.registered_at, a.updated_at,
     a.revision, a.settings_json, b.customer_id
     FROM supporter_accounts a
     LEFT JOIN supporter_billing b ON b.discord_user_id = a.discord_user_id
     ORDER BY a.updated_at DESC LIMIT 100`).all();
    const stripeEnabled = billingReady(env);
    let grouped = new Map();
    let billingError = '';
    if (stripeEnabled) {
     try { grouped = await subscriptionSummariesByCustomer(env,(rows.results||[]).map(row=>row.customer_id)); }
     catch { billingError = 'Stripeから契約情報を取得できませんでした。'; }
    }
    const accounts = (rows.results||[]).map(row=>supporterAdminAccount(row,grouped.get(row.customer_id)||[],row.customer_id?billingError:''));
    return response({billingEnabled:stripeEnabled,accounts});
   }
   const asset = await env.ASSETS.fetch(request);
   const headers = new Headers(asset.headers);
   headers.set('Cache-Control','no-store');headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','no-referrer');
   if ((headers.get('content-type')||'').includes('text/html')) headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
   return new Response(asset.body,{status:asset.status,statusText:asset.statusText,headers});
  }
  if (path === '/api/supporter/plans' && request.method === 'GET' && supporterPublicEnabled(env)) {
   return response({billingEnabled:false, deliveryEnabled:false, plans:[{id:'supporter',yen:300,channels:2},{id:'plus',yen:800,channels:10}], addon:{yen:200,channels:3}});
  }
  let session;
  try { session = await requireSession(request, {...env,REUSE_DB:db}); }
  catch (error) { if (!supporterPublicEnabled(env)) return notFound(); throw error; }
  const uid = session.discord_user_id;
  if (!supporterTestUserAllowed(env, uid)) return notFound();
  if (path === '/api/supporter/plans' && request.method === 'GET') {
   return response({billingEnabled:false, deliveryEnabled:false, plans:[{id:'supporter',yen:300,channels:2},{id:'plus',yen:800,channels:10}], addon:{yen:200,channels:3}});
  }
  if (path === '/api/supporter/options' && request.method === 'GET') {
   return response({regions:SUPPORTER_REGIONS,weatherLevels:WEATHER_LEVELS,warningLevels:WARNING_LEVELS,earthquakeDetails:EARTHQUAKE_DETAILS,eewDetails:EEW_DETAILS,eewWarningAreaModes:EEW_WARNING_AREA_MODES,weatherDetails:WEATHER_DETAILS,changeDirections:CHANGE_DIRECTIONS});
  }
  if (request.method !== 'GET') { assertSameOrigin(request); assertCsrf(request,session); }
  if (/^\/api\/supporter\/billing\/(checkout|portal|status)$/.test(path)) {
   const expected=path.endsWith('/status')?'GET':'POST';
   if(request.method!==expected)return response({message:'Method not allowed'},405);
   return await billingAction(request,env,db,uid,request.method==='POST'?await readJson(request):{});
  }
  if (path === '/api/supporter/account' && request.method === 'GET') {
   const account = await db.prepare('SELECT * FROM supporter_accounts WHERE discord_user_id=?').bind(uid).first();
   return response({account,deliveryEnabled:false,billingEnabled:billingReady(env)});
  }
  if (path === '/api/supporter/account' && request.method === 'POST') {
   const now = new Date().toISOString();
   await db.prepare('INSERT INTO supporter_accounts(discord_user_id,registered_at,updated_at) VALUES(?,?,?) ON CONFLICT(discord_user_id) DO NOTHING').bind(uid,now,now).run();
   return response({success:true});
  }
  if (path === '/api/supporter/settings' && request.method === 'PUT') {
   const input = await readJson(request);
   if (!Number.isInteger(input.revision)) return response({message:'更新情報が正しくありません。再読み込みしてください。'},400);
   const guilds = JSON.parse(session.guilds_json);
   const rules = normalizeSupporterRules(input.rules, guilds);
   await assertRuleChannels(rules, env);
   const result = await db.prepare('UPDATE supporter_accounts SET settings_json=?, revision=revision+1, updated_at=? WHERE discord_user_id=? AND revision=?').bind(JSON.stringify({rules}),new Date().toISOString(),uid,input.revision).run();
   if (!result.meta.changes) return response({message:'未登録、または別画面で更新されています。再読み込みしてください。'},409);
   return response({success:true,revision:input.revision+1});
  }
  return response({message:'この操作は利用できません。'},404);
 } catch(error) { return response({message:error.status && error.status<500 ? (error.publicMessage || error.message) : '現在利用できません。'},error.status || 503); }
}
