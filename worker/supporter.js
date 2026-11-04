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
   if (!Number.isInteger(input.revision) || !Array.isArray(input.rules) || input.rules.length > 5) return response({message:'通知ルールは5件までです。'},400);
   const guilds = JSON.parse(session.guilds_json);
   const rules = input.rules.map(rule => {
    if (!guilds.some(g=>g.id===rule.guildId) || !/^\d{17,20}$/.test(rule.channelId) || !['earthquake','eew','weather'].includes(rule.type) || typeof rule.name !== 'string' || rule.name.length > 80 || typeof rule.region !== 'string' || rule.region.length > 100 || !['1','2','3','4','5-','5+','6-','6+','7'].includes(rule.intensity)) throw Object.assign(new Error('入力内容とサーバー管理権限を確認してください。'),{status:400});
    return {name:rule.name,guildId:rule.guildId,channelId:rule.channelId,type:rule.type,region:rule.region,intensity:rule.intensity};
   });
   const result = await db.prepare('UPDATE supporter_accounts SET settings_json=?, revision=revision+1, updated_at=? WHERE discord_user_id=? AND revision=?').bind(JSON.stringify({rules}),new Date().toISOString(),uid,input.revision).run();
   if (!result.meta.changes) return response({message:'未登録、または別画面で更新されています。再読み込みしてください。'},409);
   return response({success:true,revision:input.revision+1});
  }
  return response({message:'この操作は利用できません。'},404);
 } catch(error) { return response({message:error.status && error.status<500 ? (error.publicMessage || error.message) : '現在利用できません。'},error.status || 503); }
}
