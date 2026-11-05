import { requireSession, assertCsrf, assertSameOrigin, readJson, fetchGuildChannels } from './reuse.js';
import { authenticateNewsletterAdmin } from './access.js';
import { adminBillingAction, billingAction, billingReady, createBillingCustomer, creditsByCustomer, customerSubscriptionSummaries, publicPlans, reconcilePaidCheckoutSubscription, subscriptionSummariesByCustomer } from './supporter-billing.js';

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
export function supporterAdminAccount(row, subscriptions = [], billingError = '', credits = 0) {
 return {
  discordUserId: row.discord_user_id,
  discordName: row.discord_name || '',
  billingEmail: row.billing_email || '',
  registeredAt: row.registered_at,
  updatedAt: row.updated_at,
  revision: Number(row.revision || 0),
  ruleCount: ruleCount(row.settings_json),
  subscriptions,
  credits: Number(credits || 0),
  billingError,
 };
}
function normalizeBillingEmail(value) {
 const email = clean(value).toLowerCase();
 if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw Object.assign(new Error('有効なメールアドレスを入力してください。'),{status:400});
 return email;
}
export function supporterConsentVersion(input, env) {
 const version = clean(env.SUPPORTER_CONSENT_VERSION);
 if (!version) throw Object.assign(new Error('申込み同意の設定が完了していません。'),{status:503,publicMessage:'申込み同意の設定が完了していません。運営へお問い合わせください。'});
 if (input.legalConsent !== true) throw Object.assign(new Error('利用規約、プライバシーポリシーおよび特定商取引法に基づく表記への同意が必要です。'),{status:400});
 return version;
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
  console.error('Paid plan billing audit write failed',{action,errorName:error?.name||'Error'});
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
export const THRESHOLD_MODES = Object.freeze([
 ['all', 'すべて'],
 ['increase', '上昇時のみ'],
 ['threshold', '閾値以上'],
]);
const INTENSITIES = new Set(['1','2','3','4','5-','5+','6-','6+','7']);
const REGION_IDS = new Set(SUPPORTER_REGIONS.map(([id]) => id));
const WEATHER_LEVEL_IDS = new Set(WEATHER_LEVELS.map(([id]) => id));
const WARNING_LEVEL_IDS = new Set(WARNING_LEVELS.map(([id]) => id));
const THRESHOLD_MODE_IDS = new Set(THRESHOLD_MODES.map(([id]) => id));
const EEW_WARNING_AREA_MODE_IDS = new Set(EEW_WARNING_AREA_MODES.map(([id]) => id));
const DETAILS = {
 earthquake: new Set(EARTHQUAKE_DETAILS.map(([id]) => id)),
 eew: new Set(EEW_DETAILS.map(([id]) => id)),
 weather: new Set(WEATHER_DETAILS.map(([id]) => id)),
};
const WEATHER_ALERT_DETAILS = new Set(['heavy-rain-level','landslide-level','storm-surge-level']);
const WEATHER_WARNING_DETAILS = new Set(['storm-blizzard-warning','wave-warning','heavy-snow-warning','other-advisory']);
const SUPPORTER_TYPE_LABELS = Object.freeze({earthquake:'地震情報',eew:'緊急地震速報',weather:'気象情報'});
const INTENSITY_LABELS = Object.freeze({'1':'震度1','2':'震度2','3':'震度3','4':'震度4','5-':'震度5弱','5+':'震度5強','6-':'震度6弱','6+':'震度6強','7':'震度7'});

function optionLabel(options, value, fallback = '未設定') {
 return options.find(([id])=>id===value)?.[1] || (clean(value) || fallback);
}

function adminConditionLabel(condition, type) {
 const kind=clean(condition?.kind);const value=condition?.value;
 if(kind==='region')return `対象地方：${optionLabel(SUPPORTER_REGIONS,clean(value))}`;
 if(kind==='detail')return `詳細種別：${optionLabel(type==='earthquake'?EARTHQUAKE_DETAILS:type==='eew'?EEW_DETAILS:WEATHER_DETAILS,clean(value))}`;
 if(kind==='intensity')return `震度：${INTENSITY_LABELS[clean(value)]||clean(value)}以上`;
 if(kind==='magnitude')return `マグニチュード：M${Number(value)}以上`;
 if(kind==='weatherLevel')return `警戒レベル：${optionLabel(WEATHER_LEVELS,clean(value))}`;
 if(kind==='warningLevel')return `警報・注意報：${optionLabel(WARNING_LEVELS,clean(value))}`;
 return `不明な条件：${clean(value)||'未設定'}`;
}

function thresholdLabel(mode, value, kind) {
 if(mode==='increase')return '上昇時のみ';
 if(mode!=='threshold')return 'すべて';
 if(kind==='intensity')return `${INTENSITY_LABELS[clean(value)]||clean(value)}以上`;
 return `M${Number(value)}以上`;
}

export function supporterAdminDetails(row, channelsByGuild = {}) {
 let settings={};let guilds=[];
 try{settings=JSON.parse(row.settings_json||'{}');}catch{/* Keep an empty rule set for malformed legacy data. */}
 try{const parsed=JSON.parse(row.guilds_json||'[]');guilds=Array.isArray(parsed)?parsed:[];}catch{/* Guild names remain unavailable. */}
 const rules=Array.isArray(settings.rules)?settings.rules:[];
 return {
  discordUserId:row.discord_user_id,
  discordName:row.discord_name||'',
  rules:rules.map((rule,index)=>{
   const type=clean(rule?.type);const guildId=clean(rule?.guildId);
   const requested=Array.isArray(rule?.channelIds)?rule.channelIds.map(clean).filter(Boolean):[];
   const channelIds=[...new Set(requested.length?requested:[clean(rule?.channelId)].filter(Boolean))];
   const channels=Array.isArray(channelsByGuild[guildId])?channelsByGuild[guildId]:[];
   const details=[
    {label:'情報種別',value:SUPPORTER_TYPE_LABELS[type]||type||'未設定'},
    {label:'詳細種別',value:optionLabel(type==='earthquake'?EARTHQUAKE_DETAILS:type==='eew'?EEW_DETAILS:WEATHER_DETAILS,clean(rule?.detail)||'all')},
    {label:'対象地方',value:optionLabel(SUPPORTER_REGIONS,clean(rule?.region)||'all')},
    {label:'条件の組み合わせ',value:clean(rule?.conditionLogic)==='or'?'いずれかを満たす（OR）':'すべて満たす（AND）'},
   ];
   if(type==='weather'){
    if(clean(rule?.weatherLevel))details.push({label:'警戒レベル',value:optionLabel(WEATHER_LEVELS,clean(rule.weatherLevel))});
    if(clean(rule?.warningLevel))details.push({label:'警報・注意報',value:optionLabel(WARNING_LEVELS,clean(rule.warningLevel))});
   }else{
    details.push({label:'震度条件',value:thresholdLabel(clean(rule?.intensityMode)||'all',rule?.intensity,'intensity')});
    details.push({label:'マグニチュード条件',value:thresholdLabel(clean(rule?.magnitudeMode)||'all',rule?.magnitudeMin,'magnitude')});
    if(type==='eew'&&clean(rule?.detail)==='warning')details.push({label:'警報地方条件',value:optionLabel(EEW_WARNING_AREA_MODES,clean(rule?.eewWarningAreaMode)||'all')});
   }
   const additional=Array.isArray(rule?.conditions)?rule.conditions:[];
   additional.forEach((condition,conditionIndex)=>details.push({label:`追加条件 ${conditionIndex+1}`,value:adminConditionLabel(condition,type)}));
   return {
    name:clean(rule?.name)||`通知ルール ${index+1}`,
    guildId,
    guildName:guilds.find(guild=>String(guild?.id)===guildId)?.name||'',
    channels:channelIds.map(id=>({id,name:channels.find(channel=>String(channel?.id)===id)?.name||''})),
    details,
   };
  }),
 };
}

function optionalMagnitude(value) {
 if (value === '' || value === undefined || value === null) return null;
 const number = Number(value);
 if (!Number.isFinite(number) || number < 0 || number > 10) throw Object.assign(new Error('マグニチュードは0から10の範囲で指定してください。'),{status:400});
 return Math.round(number * 10) / 10;
}

function thresholdMode(rule, key, legacyKey, thresholdValue) {
 const requested = clean(rule?.[key]);
 if (THRESHOLD_MODE_IDS.has(requested)) return requested;
 if (clean(rule?.[legacyKey]) === 'increase') return 'increase';
 return thresholdValue !== '' && thresholdValue !== undefined && thresholdValue !== null ? 'threshold' : 'all';
}

function normalizeAdditionalConditions(input,type,complexConditions){
 const requested=Array.isArray(input)?input:[];
 if(requested.length>8)throw Object.assign(new Error('追加条件は1ルールにつき8件までです。'),{status:400});
 if(requested.length&&!complexConditions)throw Object.assign(new Error('複数条件はProプランで利用できます。'),{status:400});
 const normalized=requested.map(condition=>{
  const kind=clean(condition?.kind);const raw=condition?.value;const value=clean(raw);
  if(kind==='region'&&REGION_IDS.has(value))return{kind,operator:'equals',value};
  if(kind==='detail'&&DETAILS[type].has(value))return{kind,operator:'equals',value};
  if(kind==='intensity'&&type!=='weather'&&INTENSITIES.has(value))return{kind,operator:'at_least',value};
  if(kind==='magnitude'&&type!=='weather'){const magnitude=optionalMagnitude(raw);if(magnitude!==null)return{kind,operator:'at_least',value:magnitude};}
  if(kind==='weatherLevel'&&type==='weather'&&WEATHER_LEVEL_IDS.has(value))return{kind,operator:'equals',value};
  if(kind==='warningLevel'&&type==='weather'&&WARNING_LEVEL_IDS.has(value))return{kind,operator:'equals',value};
  throw Object.assign(new Error('追加条件の種類または値を確認してください。'),{status:400});
 });
 const unique=[];const seen=new Set();
 for(const condition of normalized){const key=`${condition.kind}:${condition.value}`;if(!seen.has(key)){seen.add(key);unique.push(condition);}}
 return unique;
}

export function normalizeSupporterRules(input, guilds, limits = {servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false}) {
 const ruleLimit=Math.max(1,Number(limits.rules)||5);
 if (!Array.isArray(input) || input.length > ruleLimit) throw Object.assign(new Error(`通知ルールは${ruleLimit}件までです。`),{status:400});
 const rules = input.map(rule => {
  const name = clean(rule?.name);
  const guildId = clean(rule?.guildId);
  const requestedChannelIds=Array.isArray(rule?.channelIds)?rule.channelIds.map(clean).filter(Boolean):[];
  const channelIds=[...new Set(requestedChannelIds.length?requestedChannelIds:[clean(rule?.channelId)])];
  const channelId=channelIds[0]||'';
  const type = clean(rule?.type);
  const region = clean(rule?.region) || 'all';
  const conditionLogic=clean(rule?.conditionLogic)||'and';
  if (!name || name.length > 80 || !guilds.some(g=>g.id===guildId) || !channelIds.length || channelIds.some(id=>!/^\d{17,20}$/.test(id))
      || !['earthquake','eew','weather'].includes(type) || !REGION_IDS.has(region)) {
   throw Object.assign(new Error('入力内容とサーバー管理権限を確認してください。'),{status:400});
  }
  if(!['and','or'].includes(conditionLogic))throw Object.assign(new Error('条件の組み合わせ方法を確認してください。'),{status:400});
  if(conditionLogic==='or'&&!limits.complexConditions)throw Object.assign(new Error('OR条件はPROプランで利用できます。'),{status:400});
  if(channelIds.length>1&&!limits.multiDestination)throw Object.assign(new Error('1つのルールから複数チャンネルへの配信はPROプランで利用できます。'),{status:400});
  const requestedDetail = clean(rule?.detail) || 'all';
  const detail = type === 'eew' && requestedDetail === 'intensity-change' ? 'forecast' : requestedDetail;
  if (!DETAILS[type].has(detail)) throw Object.assign(new Error('情報の詳細種別を確認してください。'),{status:400});
  const conditions=normalizeAdditionalConditions(rule?.conditions,type,limits.complexConditions===true);
  if (type === 'weather') {
   const weatherLevel = WEATHER_ALERT_DETAILS.has(detail) ? (clean(rule?.weatherLevel) || 'all') : '';
   const warningLevel = WEATHER_WARNING_DETAILS.has(detail) ? (clean(rule?.warningLevel) || 'all') : '';
   if (weatherLevel && !WEATHER_LEVEL_IDS.has(weatherLevel)) throw Object.assign(new Error('気象情報の警戒レベルを確認してください。'),{status:400});
   if (warningLevel && !WARNING_LEVEL_IDS.has(warningLevel)) throw Object.assign(new Error('警報・注意報の条件を確認してください。'),{status:400});
   return {name,guildId,channelId,channelIds,type,detail,region,conditionLogic,conditions,intensityMode:'',intensity:'',magnitudeMode:'',magnitudeMin:null,weatherLevel,warningLevel,eewWarningAreaMode:''};
  }
  const intensityMode = thresholdMode(rule,'intensityMode','intensityChange',rule?.intensity);
  const magnitudeMode = thresholdMode(rule,'magnitudeMode','magnitudeChange',rule?.magnitudeMin);
  const intensity = intensityMode === 'threshold' ? clean(rule?.intensity) : '';
  const magnitudeMin = magnitudeMode === 'threshold' ? optionalMagnitude(rule?.magnitudeMin) : null;
  if (intensityMode === 'threshold' && !INTENSITIES.has(intensity)) throw Object.assign(new Error('閾値以上で通知する震度を確認してください。'),{status:400});
  if (magnitudeMode === 'threshold' && magnitudeMin === null) throw Object.assign(new Error('閾値以上で通知するマグニチュードを入力してください。'),{status:400});
  const eewWarningAreaMode = type === 'eew' && detail === 'warning' ? (clean(rule?.eewWarningAreaMode) || 'all') : '';
  if (eewWarningAreaMode && !EEW_WARNING_AREA_MODE_IDS.has(eewWarningAreaMode)) throw Object.assign(new Error('緊急地震速報（警報）の対象地方条件を確認してください。'),{status:400});
  return {name,guildId,channelId,channelIds,type,detail,region,conditionLogic,conditions,intensityMode,intensity,magnitudeMode,magnitudeMin,weatherLevel:'',warningLevel:'',eewWarningAreaMode};
 });
 const serverCount = new Set(rules.map(rule => rule.guildId)).size;
 const channelCount = new Set(rules.flatMap(rule => rule.channelIds.map(channelId=>`${rule.guildId}:${channelId}`))).size;
 const serverLimit = Math.max(1,Number(limits.servers)||1);
 const channelLimit = Math.max(1,Number(limits.channels)||2);
 if (serverCount > serverLimit) throw Object.assign(new Error(`契約上限は${serverLimit}サーバーです。サーバー追加オプションを契約するか、同じサーバーを選択してください。`),{status:400});
 if (channelCount > channelLimit) throw Object.assign(new Error(`契約上限は${channelLimit}チャンネルです。チャンネル追加オプションを契約するか、通知先を減らしてください。`),{status:400});
 return rules;
}

async function supporterLimits(env, db, uid) {
 const fallback = {servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false};
 if (!billingReady(env)) throw Object.assign(new Error('決済設定を確認できないため、通知設定を保存できません。'),{status:503});
 const row = await db.prepare('SELECT customer_id FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
 if (!row?.customer_id) throw Object.assign(new Error('通知設定は有料プランの契約後に利用できます。'),{status:409});
 try {
  const suspension = await db.prepare(`SELECT invoice_id FROM supporter_dunning WHERE customer_id=? AND status='suspended' LIMIT 1`).bind(row.customer_id).first();
  if (suspension) throw Object.assign(new Error('月末再決済を確認できなかったため、有料プランの通知設定は利用停止中です。契約管理画面からお支払いを完了してください。'),{status:409});
  await reconcilePaidCheckoutSubscription(env,row.customer_id,uid);
  const active = (await customerSubscriptionSummaries(env,row.customer_id)).filter(item=>['active','trialing','past_due','unpaid','paused'].includes(item.status));
  if (!active.length) throw Object.assign(new Error('通知設定は有効な契約を確認してから利用できます。'),{status:409});
  return active.reduce((limits,item)=>({servers:Math.max(limits.servers,Number(item.servers)||1),channels:Math.max(limits.channels,Number(item.channels)||2),rules:Math.max(limits.rules,Number(item.rules)||5),complexConditions:limits.complexConditions||item.complexConditions===true,multiDestination:limits.multiDestination||item.multiDestination===true}),fallback);
 } catch(error) { if(error?.status===409)throw error;throw Object.assign(new Error('契約上限を確認できませんでした。時間をおいて再試行してください。'),{status:503}); }
}

async function assertRuleChannels(rules, env) {
 const byGuild = new Map();
 for (const rule of rules) {
  if (!byGuild.has(rule.guildId)) byGuild.set(rule.guildId, await fetchGuildChannels(rule.guildId, env));
  if (rule.channelIds.some(channelId=>!byGuild.get(rule.guildId).some(channel => String(channel.id) === channelId))) {
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
    const account = await db.prepare(`SELECT a.discord_user_id, a.billing_email, b.customer_id
     FROM supporter_accounts a LEFT JOIN supporter_billing b ON b.discord_user_id=a.discord_user_id
     WHERE a.discord_user_id=?`).bind(uid).first();
    if (!account) return response({message:'対象の有料プラン登録者が見つかりません。'},404);
    if (input.action === 'reset_checkout_state') {
     if (env.SUPPORTER_BILLING_MODE !== 'test') return response({message:'この操作はStripeテスト環境でのみ利用できます。'},403);
     const reason = clean(input.reason);
     if (reason.length < 5 || reason.length > 500) return response({message:'操作理由を5〜500文字で入力してください。'},400);
     const result = await db.prepare(`UPDATE supporter_billing
      SET checkout_key=NULL, checkout_id=NULL, checkout_params=NULL
      WHERE discord_user_id=?
       AND (checkout_key IS NOT NULL OR checkout_id IS NOT NULL OR checkout_params IS NOT NULL)`).bind(uid).run();
     const auditRecorded = await writeSupporterAudit(db,admin.email,input.action,uid,{reason,requestId:clean(input.requestId),changed:Number(result.meta?.changes||0)});
     return response({success:true,message:result.meta?.changes?'決済途中データをDBから削除しました。Stripe Customerと契約情報は保持されています。':'削除対象の決済途中データはありませんでした。',auditRecorded,creditRecorded:true});
    }
    if (!account.customer_id && ['grant_credit','create_payment_link'].includes(input.action)) {
     if (!account.billing_email) return response({message:'先にユーザーの申込メールアドレスを登録してください。'},409);
     const customer = await createBillingCustomer(env,uid,account.billing_email,`dpi-admin-customer-${uid}`);
     await db.prepare(`INSERT INTO supporter_billing(discord_user_id,customer_id) VALUES(?,?)
      ON CONFLICT(discord_user_id) DO UPDATE SET customer_id=COALESCE(supporter_billing.customer_id,excluded.customer_id)`).bind(uid,customer.id).run();
     account.customer_id = (await db.prepare('SELECT customer_id FROM supporter_billing WHERE discord_user_id=?').bind(uid).first()).customer_id;
    }
    const result = await adminBillingAction(env,account.customer_id,uid,input);
    let creditRecorded = true;
    if (result.creditEvent) {
     try {
      await db.prepare(`INSERT INTO supporter_credit_events
       (id,discord_user_id,credit_delta,balance_after,stripe_transaction_id,reason,actor,created_at)
       VALUES(?,?,?,?,?,?,?,?)`).bind(clean(input.requestId),uid,result.creditEvent.delta,result.creditEvent.balanceAfter,result.creditEvent.stripeTransactionId,clean(input.reason),admin.email,new Date().toISOString()).run();
     } catch (error) { console.error('Paid plan credit event write failed',{errorName:error?.name||'Error'}); creditRecorded = false; }
    }
    const auditRecorded = await writeSupporterAudit(db,admin.email,input.action,uid,{reason:clean(input.reason),amount:Number(input.amount)||null,plan:clean(input.plan)||null,channelPacks:Number.isInteger(Number(input.channelPacks??input.packs))?Number(input.channelPacks??input.packs):null,serverPacks:Number.isInteger(Number(input.serverPacks))?Number(input.serverPacks):null,requestId:clean(input.requestId),resultMessage:result.message});
    return response({success:true,...result,auditRecorded,creditRecorded});
   }
   if (request.method !== 'GET') return response({message:'Method not allowed'},405);
   if (path === '/site/supporter-admin/api/accounts') {
    const rows = await db.prepare(`SELECT a.discord_user_id, a.billing_email, a.registered_at, a.updated_at,
     a.revision, a.settings_json, b.customer_id,
     COALESCE(NULLIF(a.discord_name,''),
      (SELECT s.discord_username FROM reuse_sessions s WHERE s.discord_user_id=a.discord_user_id ORDER BY s.expires_at DESC LIMIT 1),
      (SELECT r.discord_username FROM reuse_applications r WHERE r.discord_user_id=a.discord_user_id ORDER BY r.updated_at DESC LIMIT 1),
      ''
     ) AS discord_name
     FROM supporter_accounts a
     LEFT JOIN supporter_billing b ON b.discord_user_id = a.discord_user_id
     ORDER BY a.updated_at DESC LIMIT 100`).all();
    const stripeEnabled = billingReady(env);
    let grouped = new Map();
    let creditBalances = new Map();
    let billingError = '';
    if (stripeEnabled) {
     const customers=(rows.results||[]).map(row=>row.customer_id);
     const [subscriptionResult,creditResult] = await Promise.allSettled([subscriptionSummariesByCustomer(env,customers),creditsByCustomer(env,customers)]);
     if (subscriptionResult.status === 'fulfilled') grouped = subscriptionResult.value;
     else billingError = 'Stripeから契約情報を取得できませんでした。';
     if (creditResult.status === 'fulfilled') creditBalances = creditResult.value;
     else billingError = `${billingError}${billingError ? ' ' : ''}クレジット残高を取得できませんでした。`;
    }
    const accounts = (rows.results||[]).map(row=>supporterAdminAccount(row,grouped.get(row.customer_id)||[],row.customer_id?billingError:'',creditBalances.get(row.customer_id)||0));
    return response({billingEnabled:stripeEnabled,accounts});
   }
   const detailMatch=path.match(/^\/site\/supporter-admin\/api\/accounts\/(\d{17,20})$/);
   if(detailMatch){
    const uid=detailMatch[1];
    const row=await db.prepare(`SELECT a.discord_user_id, a.settings_json,
     COALESCE(NULLIF(a.discord_name,''),
      (SELECT s.discord_username FROM reuse_sessions s WHERE s.discord_user_id=a.discord_user_id ORDER BY s.expires_at DESC LIMIT 1),
      (SELECT r.discord_username FROM reuse_applications r WHERE r.discord_user_id=a.discord_user_id ORDER BY r.updated_at DESC LIMIT 1),
      ''
     ) AS discord_name,
     COALESCE(
      (SELECT s.guilds_json FROM reuse_sessions s WHERE s.discord_user_id=a.discord_user_id ORDER BY s.expires_at DESC LIMIT 1),
      '[]'
     ) AS guilds_json
     FROM supporter_accounts a WHERE a.discord_user_id=?`).bind(uid).first();
    if(!row)return response({message:'対象の有料プラン登録者が見つかりません。'},404);
    let settings={};try{settings=JSON.parse(row.settings_json||'{}');}catch{/* Return an empty detail set for malformed legacy data. */}
    const guildIds=[...new Set((Array.isArray(settings.rules)?settings.rules:[]).map(rule=>clean(rule?.guildId)).filter(id=>/^\d{17,20}$/.test(id)))];
    const channelResults=await Promise.all(guildIds.map(async guildId=>{
     try{return{guildId,channels:await fetchGuildChannels(guildId,env),failed:false};}
     catch{return{guildId,channels:[],failed:true};}
    }));
    const channelsByGuild=Object.fromEntries(channelResults.map(result=>[result.guildId,result.channels]));
    return response({account:supporterAdminDetails(row,channelsByGuild),channelLookupFailedGuildIds:channelResults.filter(result=>result.failed).map(result=>result.guildId)});
   }
   const asset = await env.ASSETS.fetch(request);
   const headers = new Headers(asset.headers);
   headers.set('Cache-Control','no-store');headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','no-referrer');
   if ((headers.get('content-type')||'').includes('text/html')) headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
   return new Response(asset.body,{status:asset.status,statusText:asset.statusText,headers});
  }
  if (path === '/api/supporter/plans' && request.method === 'GET' && supporterPublicEnabled(env)) {
   return response({billingEnabled:false, deliveryEnabled:false, plans:publicPlans(), addons:{channel:{yen:200,channels:3},server:{yen:200,servers:1},prorated:false},billingDay:26});
  }
  let session;
  try { session = await requireSession(request, {...env,REUSE_DB:db}); }
  catch (error) { if (!supporterPublicEnabled(env)) return notFound(); throw error; }
  const uid = session.discord_user_id;
  if (!supporterTestUserAllowed(env, uid)) return notFound();
  if (path === '/api/supporter/plans' && request.method === 'GET') {
   return response({billingEnabled:false, deliveryEnabled:false, plans:publicPlans(), addons:{channel:{yen:200,channels:3},server:{yen:200,servers:1},prorated:false},billingDay:26});
  }
  if (path === '/api/supporter/options' && request.method === 'GET') {
   return response({regions:SUPPORTER_REGIONS,weatherLevels:WEATHER_LEVELS,warningLevels:WARNING_LEVELS,earthquakeDetails:EARTHQUAKE_DETAILS,eewDetails:EEW_DETAILS,eewWarningAreaModes:EEW_WARNING_AREA_MODES,weatherDetails:WEATHER_DETAILS,thresholdModes:THRESHOLD_MODES});
  }
  if (request.method !== 'GET') { assertSameOrigin(request); assertCsrf(request,session); }
  if (/^\/api\/supporter\/billing\/(checkout|preview-update|update|portal|status)$/.test(path)) {
   const expected=path.endsWith('/status')?'GET':'POST';
   if(request.method!==expected)return response({message:'Method not allowed'},405);
   const input=request.method==='POST'?await readJson(request):{};
   if(path.endsWith('/checkout')){
    const email=normalizeBillingEmail(input.email);
    const consentVersion=supporterConsentVersion(input,env);
    const discordName=clean(session.discord_username).slice(0,100);
    const now=new Date().toISOString();
    await db.prepare(`INSERT INTO supporter_accounts(discord_user_id,discord_name,billing_email,legal_consent_version,legal_consent_at,registered_at,updated_at) VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(discord_user_id) DO UPDATE SET discord_name=excluded.discord_name,billing_email=excluded.billing_email,legal_consent_version=excluded.legal_consent_version,legal_consent_at=excluded.legal_consent_at,updated_at=excluded.updated_at`).bind(uid,discordName,email,consentVersion,now,now,now).run();
    input.email=email;
    input.legalConsentVersion=consentVersion;
   }
   return await billingAction(request,env,db,uid,input);
  }
  if (path === '/api/supporter/account' && request.method === 'GET') {
   const discordName=clean(session.discord_username).slice(0,100);
   if(discordName)await db.prepare('UPDATE supporter_accounts SET discord_name=? WHERE discord_user_id=? AND COALESCE(discord_name,\'\')<>?').bind(discordName,uid,discordName).run();
   const account = await db.prepare('SELECT * FROM supporter_accounts WHERE discord_user_id=?').bind(uid).first();
   return response({account,deliveryEnabled:false,billingEnabled:billingReady(env)});
  }
  if (path === '/api/supporter/account' && request.method === 'POST') {
   const input = await readJson(request);
   const email = normalizeBillingEmail(input.email);
   const discordName=clean(session.discord_username).slice(0,100);
   const now = new Date().toISOString();
   await db.prepare(`INSERT INTO supporter_accounts(discord_user_id,discord_name,billing_email,registered_at,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(discord_user_id) DO UPDATE SET discord_name=excluded.discord_name,billing_email=excluded.billing_email,updated_at=excluded.updated_at`).bind(uid,discordName,email,now,now).run();
   return response({success:true});
  }
  if (path === '/api/supporter/settings' && request.method === 'PUT') {
   const input = await readJson(request);
   if (!Number.isInteger(input.revision)) return response({message:'更新情報が正しくありません。再読み込みしてください。'},400);
   const guilds = JSON.parse(session.guilds_json);
   const limits = await supporterLimits(env,db,uid);
   const rules = normalizeSupporterRules(input.rules, guilds, limits);
   await assertRuleChannels(rules, env);
   const result = await db.prepare('UPDATE supporter_accounts SET settings_json=?, revision=revision+1, updated_at=? WHERE discord_user_id=? AND revision=?').bind(JSON.stringify({rules}),new Date().toISOString(),uid,input.revision).run();
   if (!result.meta.changes) return response({message:'未登録、または別画面で更新されています。再読み込みしてください。'},409);
   return response({success:true,revision:input.revision+1});
  }
  return response({message:'この操作は利用できません。'},404);
 } catch(error) { return response({message:error.publicMessage || (error.status && error.status<500 ? error.message : '現在利用できません。')},error.status || 503); }
}
