import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {readdir, readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {handleSupporterRequest} from '../worker/supporter.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const ORIGIN='https://dpi-bot.com',TEAM='https://admin-e2e.cloudflareaccess.com';
const A='123456789012345678',B='123456789012345679';

async function database(){
 const raw=new DatabaseSync(':memory:');
 for(const name of (await readdir(path.join(ROOT,'migrations'))).filter(x=>x.endsWith('.sql')).sort())raw.exec(await readFile(path.join(ROOT,'migrations',name),'utf8'));
 const statement=(sql,values=[])=>({bind(...v){return statement(sql,v.map(x=>x===undefined?null:typeof x==='boolean'?Number(x):x));},async first(){return raw.prepare(sql).get(...values)??null;},async all(){return{results:raw.prepare(sql).all(...values)};},async run(){return{meta:{changes:Number(raw.prepare(sql).run(...values).changes)}};}});
 return{raw,db:{prepare:sql=>statement(sql),async batch(items){const out=[];for(const item of items)out.push(await item.run());return out;}}};
}
async function adminIdentity(){
 const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const jwk={...(await crypto.subtle.exportKey('jwk',keys.publicKey)),kid:'admin-e2e'};
 const enc=value=>Buffer.from(JSON.stringify(value)).toString('base64url'),now=Math.floor(Date.now()/1000);
 const input=`${enc({alg:'RS256',kid:jwk.kid})}.${enc({iss:TEAM,aud:'admin-e2e',email:'admin@example.com',sub:'local',iat:now,exp:now+600})}`;
 const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',keys.privateKey,Buffer.from(input));
 return{jwk,token:`${input}.${Buffer.from(signature).toString('base64url')}`};
}
const subscription=(uid,plan='supporter')=>({id:`sub_${uid}`,status:'active',customer:`cus_${uid}`,cancel_at_period_end:false,metadata:{dpi_user:uid,dpi_plan:plan,dpi_channel_packs:'0',dpi_server_packs:'0',dpi_rule_packs:'0'},start_date:1,current_period_start:1,current_period_end:2_000_000_000,items:{data:[{id:`si_${uid}`,quantity:1,price:{id:plan==='supporter'?'price_basic':`price_${plan}`,unit_amount:plan==='plus'?800:plan==='pro'?1280:300,currency:'jpy'}}]}});

export async function runAdminSyncE2E(){
 const {raw,db}=await database(),identity=await adminIdentity(),checks=[];let failures=0;
 const balances=new Map([[`cus_${A}`,0],[`cus_${B}`,0]]),subscriptions=new Map([[A,subscription(A,'plus')],[B,subscription(B)]]),idem=new Map();
 const check=async(name,fn)=>{try{await fn();checks.push({name,ok:true});console.log(`✔ ${name}`);}catch(error){failures++;checks.push({name,ok:false,error:error.message});console.log(`✖ ${name}: ${error.message}`);}};
 const now=Date.now(),csrf='local-csrf';
 for(const [uid,name] of [[A,'利用者A'],[B,'利用者B']]){
  const token=`session-${uid}`;raw.prepare('INSERT INTO reuse_sessions(token_hash,discord_user_id,discord_username,guilds_json,csrf_token,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(createHash('sha256').update(token).digest('hex'),uid,name,'[]',csrf,now,now+3600000);
 }
 const env={REUSE_DB:db,SUPPORTER_PUBLIC_ENABLED:'true',SUPPORTER_PUBLIC_ORIGIN:ORIGIN,SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'sk_test_local',STRIPE_WEBHOOK_SECRET:'whsec_local',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_local',ACCESS_AUD:'admin-e2e',ACCESS_TEAM_DOMAIN:TEAM,ADMIN_EMAILS:'admin@example.com',ASSETS:{fetch:async()=>new Response('not found',{status:404})}};
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async(input,init={})=>{
  const url=new URL(typeof input==='string'?input:input.url);
  if(url.origin===TEAM&&url.pathname==='/cdn-cgi/access/certs')return Response.json({keys:[identity.jwk]});
  if(url.hostname==='discord.com'&&url.pathname.includes('/channels'))return Response.json([]);
  if(url.hostname!=='api.stripe.com')throw new Error(`外部通信を遮断しました: ${url.origin}`);
  const route=url.pathname.replace('/v1/',''),method=init.method||'GET',form=new URLSearchParams(init.body||''),key=new Headers(init.headers).get('idempotency-key');
  if(method==='GET'&&route==='customers?limit=100')return Response.json({data:[...balances].map(([id,credit])=>({id,balance:-credit,livemode:false})),has_more:false});
  if(method==='GET'&&route.startsWith('customers/')){const id=decodeURIComponent(route.split('/')[1]);return Response.json({id,balance:-(balances.get(id)||0),invoice_settings:{default_payment_method:'pm_local'},livemode:false});}
  if(method==='POST'&&/customers\/[^/]+\/balance_transactions/.test(route)){
   if(key&&idem.has(key))return Response.json(idem.get(key));const id=decodeURIComponent(route.split('/')[1]),amount=Number(form.get('amount')),next=(balances.get(id)||0)-amount;balances.set(id,next);const value={id:`cbtxn_${idem.size+1}`,ending_balance:-next,livemode:false};if(key)idem.set(key,value);return Response.json(value);
  }
  if(method==='GET'&&route.startsWith('subscriptions')){const customer=url.searchParams.get('customer');return Response.json({data:[...subscriptions.values()].filter(x=>!customer||x.customer===customer),has_more:false});}
  if(method==='POST'&&route.startsWith('subscriptions/')){const sub=[...subscriptions.values()].find(x=>x.id===route.split('/')[1]);if(form.has('cancel_at_period_end'))sub.cancel_at_period_end=form.get('cancel_at_period_end')==='true';return Response.json({...sub,livemode:false});}
  if(method==='DELETE'&&route.startsWith('subscriptions/')){const entry=[...subscriptions].find(([,x])=>x.id===route.split('/')[1]);if(entry)subscriptions.delete(entry[0]);return Response.json({id:route.split('/')[1],status:'canceled',livemode:false});}
  if(method==='GET'&&route.startsWith('invoices'))return Response.json({data:[],has_more:false});
  if(method==='GET'&&route.startsWith('checkout/sessions'))return Response.json({data:[],has_more:false});
  throw new Error(`未定義のローカルStripe応答: ${method} ${route}`);
 };
 const user=async(uid,pathname,{method='GET',body,origin=ORIGIN}={})=>handleSupporterRequest(new Request(`${ORIGIN}${pathname}`,{method,body:body===undefined?undefined:JSON.stringify(body),headers:{Cookie:`dpi_reuse_session=session-${uid}`,'Content-Type':'application/json',Origin:origin,'x-reuse-csrf':csrf}}),env);
 const admin=async(pathname,{method='GET',body,origin=ORIGIN,token=identity.token}={})=>handleSupporterRequest(new Request(`${ORIGIN}${pathname}`,{method,body:body===undefined?undefined:JSON.stringify(body),headers:{'cf-access-jwt-assertion':token,'Content-Type':'application/json',Origin:origin}}),env);
 const action=(uid,action,extra={},requestId=randomUUID())=>admin('/site/supporter-admin/api/action',{method:'POST',body:{discordUserId:uid,confirmDiscordUserId:uid,action,reason:'同期通し試験のため',requestId,...extra}});
 try{
  await check('1 未認証・権限なし・別Originを拒否',async()=>{assert.equal((await admin('/site/supporter-admin/api/accounts',{token:''})).status,403);assert.equal((await admin('/site/supporter-admin/api/action',{method:'POST',origin:'https://evil.example',body:{}})).status,403);});
  await check('2 登録・一覧・詳細・利用者statusの同期',async()=>{for(const uid of[A,B]){assert.equal((await user(uid,'/api/supporter/account',{method:'POST',body:{email:`${uid}@example.test`}})).status,200);raw.prepare('INSERT INTO supporter_billing(discord_user_id,customer_id) VALUES(?,?)').run(uid,`cus_${uid}`);}const list=await(await admin('/site/supporter-admin/api/accounts')).json();assert.deepEqual(new Set(list.accounts.map(x=>x.discordUserId)),new Set([A,B]));const detail=await(await admin(`/site/supporter-admin/api/accounts/${A}`)).json();assert.equal(detail.account.discordUserId,A);const status=await(await user(A,'/api/supporter/billing/status')).json();assert.equal(status.subscriptions[0].planId,'plus');assert.equal(list.accounts.find(x=>x.discordUserId===A).subscriptions[0].planId,status.subscriptions[0].planId);});
  await check('3 解約予約・BAN・解除が両側で一致',async()=>{assert.equal((await action(A,'cancel_at_period_end')).status,200);let status=await(await user(A,'/api/supporter/billing/status')).json();assert.equal(status.subscriptions[0].cancelAtPeriodEnd,true);const banId=randomUUID();assert.equal((await action(A,'ban_account',{},banId)).status,200);assert.equal((await(await user(A,'/api/supporter/account')).json()).account.account_status,'suspended');assert.equal((await action(A,'unban_account',{},randomUUID())).status,200);assert.equal((await(await user(A,'/api/supporter/account')).json()).account.account_status,'active');});
  await check('4 残高付与・削除・没収とrequestId冪等性',async()=>{const id=randomUUID();assert.equal((await action(A,'grant_credit',{amount:1000},id)).status,200);assert.equal((await action(A,'grant_credit',{amount:1000},id)).status,200);assert.equal(balances.get(`cus_${A}`),1000);assert.equal((await action(A,'remove_credit',{amount:250})).status,200);assert.equal(balances.get(`cus_${A}`),750);assert.equal((await action(A,'confiscate_credit')).status,200);assert.equal(balances.get(`cus_${A}`),0);assert.equal(raw.prepare('SELECT count(*) n FROM supporter_credit_events WHERE discord_user_id=?').get(A).n,3);});
  await check('5 カスタム契約の提示・停止が利用者側に反映',async()=>{subscriptions.delete(A);const base={discordUserId:A,confirmDiscordUserId:A,reason:'同期通し試験のため',requestId:randomUUID(),name:'個別プラン',channels:4,servers:2,rules:12,estimatedYen:900,monthlyYen:900,features:[]};assert.equal((await admin('/site/supporter-admin/api/custom-plan',{method:'POST',body:{...base,action:'save'}})).status,200);assert.equal((await(await user(A,'/api/supporter/account')).json()).customPlan.status,'offered');assert.equal((await admin('/site/supporter-admin/api/custom-plan',{method:'POST',body:{...base,action:'cancel',requestId:randomUUID()}})).status,200);assert.equal((await(await user(A,'/api/supporter/account')).json()).customPlan.status,'canceled');});
  await check('6 paymentsの名称・状態・集計',async()=>{raw.prepare("INSERT INTO supporter_dunning(invoice_id,customer_id,amount_due,currency,status,initial_failed_at,retry_at,suspend_at,updated_at) VALUES('in_local',?,300,'jpy','retry_scheduled',1,2,3,4)").run(`cus_${A}`);raw.prepare("INSERT INTO supporter_payment_alerts(event_id,kind,outcome,discord_user_id,amount,created_at) VALUES('evt_local','disputed','ok',?,300,?)").run(A,Math.floor(Date.now()/1000));raw.prepare("INSERT INTO supporter_billing_notifications(invoice_id,kind,status,attempts,last_error,updated_at) VALUES('in_local','payment_failed','failed',1,'local',5)").run();const p=await(await admin('/site/supporter-admin/api/payments')).json();assert.equal(p.failures[0].name,'利用者A');assert.equal(p.alerts[0].kindLabel,'支払異議の申立て');assert.equal(p.summary.failuresOpen,1);assert.equal(p.summary.mailsFailed,1);});
  await check('7 管理操作の監査ログ',async()=>assert.ok(raw.prepare("SELECT count(*) n FROM admin_audit_events WHERE action LIKE 'supporter.%'").get().n>=5));
  await check('8 利用者Aの操作はBに影響しない',async()=>{assert.equal(balances.get(`cus_${B}`),0);assert.ok(subscriptions.has(B));assert.equal(raw.prepare('SELECT account_status FROM supporter_accounts WHERE discord_user_id=?').get(B).account_status,'active');});
  await check('9 管理API応答に秘密情報を含めない',async()=>{for(const path of['/site/supporter-admin/api/accounts','/site/supporter-admin/api/payments']){const text=await(await admin(path)).text();assert.doesNotMatch(text,/sk_test_local|whsec_local|pm_local|webhook|token/i);}});
 }finally{globalThis.fetch=originalFetch;raw.close();}
 console.log(`\n合格 ${checks.filter(x=>x.ok).length}件 / 失敗 ${failures}件`);return{passed:checks.filter(x=>x.ok).length,failures,checks};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const result=await runAdminSyncE2E();if(result.failures)process.exitCode=1;}
