import { requireSession, assertCsrf, assertSameOrigin, readJson } from './reuse.js';
import { authenticateNewsletterAdmin } from './access.js';
import { billingAction, billingReady } from './supporter-billing.js';

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
 ['all', 'すべての気象情報'],
 ['1', 'レベル1 早期注意情報以上'],
 ['2', 'レベル2 注意報以上'],
 ['3', 'レベル3 警報以上'],
 ['4', 'レベル4 危険警報以上'],
 ['5', 'レベル5 特別警報'],
]);
const INTENSITIES = new Set(['1','2','3','4','5-','5+','6-','6+','7']);
const REGION_IDS = new Set(SUPPORTER_REGIONS.map(([id]) => id));
const WEATHER_LEVEL_IDS = new Set(WEATHER_LEVELS.map(([id]) => id));

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
  if (type === 'weather') {
   const weatherLevel = clean(rule?.weatherLevel) || 'all';
   if (!WEATHER_LEVEL_IDS.has(weatherLevel)) throw Object.assign(new Error('気象情報の警戒レベルを確認してください。'),{status:400});
   return {name,guildId,channelId,type,region,intensity:'',weatherLevel};
  }
  const intensity = clean(rule?.intensity);
  if (!INTENSITIES.has(intensity)) throw Object.assign(new Error('通知する最低震度を確認してください。'),{status:400});
  return {name,guildId,channelId,type,region,intensity,weatherLevel:''};
 });
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
 if (!path.startsWith('/api/supporter/') && !path.startsWith('/site/supporter-admin/') && !isSupporterSite) return null;
 try {
  const db = env.REUSE_DB || env.NEWSLETTER_DB;
  if (isSupporterSite) return await supporterSite(request, env, db);
  if (path.startsWith('/site/supporter-admin/')) {
   await authenticateNewsletterAdmin(request, env);
   if (request.method !== 'GET') return response({message:'Method not allowed'},405);
   if (path === '/site/supporter-admin/api/accounts') {
    const rows = await db.prepare('SELECT discord_user_id, registered_at, updated_at, revision FROM supporter_accounts ORDER BY updated_at DESC LIMIT 100').all();
    return response({accounts:rows.results});
   }
   return env.ASSETS.fetch(request);
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
   const result = await db.prepare('UPDATE supporter_accounts SET settings_json=?, revision=revision+1, updated_at=? WHERE discord_user_id=? AND revision=?').bind(JSON.stringify({rules}),new Date().toISOString(),uid,input.revision).run();
   if (!result.meta.changes) return response({message:'未登録、または別画面で更新されています。再読み込みしてください。'},409);
   return response({success:true,revision:input.revision+1});
  }
  return response({message:'この操作は利用できません。'},404);
 } catch(error) { return response({message:error.status && error.status<500 ? (error.publicMessage || error.message) : '現在利用できません。'},error.status || 503); }
}
