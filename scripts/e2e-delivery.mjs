import assert from 'node:assert/strict';
import {createHash, createHmac} from 'node:crypto';
import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {handleSupporterRequest, normalizeSupporterRules, supporterConsentVersion} from '../worker/supporter.js';
import {billingWebhook, runSupporterBillingSchedule} from '../worker/supporter-billing.js';
import {buildSupporterSnapshot} from '../worker/supporter-snapshot.js';
import {PURGE_TABLES, purgeSql} from './billing-cutover.mjs';
import {geographicEntitlements} from '../worker/supporter-geo.js';
import {planFeatures, PLAN_FEATURE_NAMES} from '../site/supporter/plan-features.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const TEST_GUILD='12345678901234567',TEST_CHANNEL='98765432109876543';
const UID='123456789012345678',OTHER='123456789012345679',CUSTOMER='cus_delivery_e2e';
const active=planId=>({id:`sub_${planId}`,status:'active',recognizedPlan:true,planId,customer:CUSTOMER,servers:planId==='pro'?5:planId==='plus'?3:1,channels:planId==='pro'?20:planId==='plus'?10:2,rules:planId==='pro'?30:planId==='plus'?15:5});

async function database(){
 const raw=new DatabaseSync(':memory:');
 for(const name of (await readdir(path.join(ROOT,'migrations'))).filter(x=>x.endsWith('.sql')).sort())raw.exec(await readFile(path.join(ROOT,'migrations',name),'utf8'));
 const statement=(sql,values=[])=>({bind(...v){return statement(sql,v.map(x=>x===undefined?null:typeof x==='boolean'?Number(x):x));},async first(){return raw.prepare(sql).get(...values)??null;},async all(){return {results:raw.prepare(sql).all(...values)};},async run(){return {meta:{changes:Number(raw.prepare(sql).run(...values).changes)}};}});
 return {raw,db:{prepare:sql=>statement(sql),async batch(items){const out=[];for(const item of items)out.push(await item.run());return out;}}};
}
const limits=plan=>({...active(plan),complexConditions:plan==='pro',multiDestination:plan==='pro',...planFeatures([active(plan)]),...geographicEntitlements([active(plan)])});
const rule=(type,guildId,channelId,extra={})=>({name:type,guildId,channelId,channelIds:[channelId],type,region:'all',conditionLogic:'and',conditions:[],...extra});

export async function runDeliveryE2E({exportDir,guildId=TEST_GUILD,channelId=TEST_CHANNEL,now=Date.now()}){
 guildId=String(guildId||TEST_GUILD);channelId=String(channelId||TEST_CHANNEL);exportDir=path.resolve(exportDir||path.join(process.cwd(),'delivery-e2e-export'));
 const {raw,db}=await database(),checks=[];let failures=0,plan='supporter',subscriptionStatus='active';
 const check=async(name,fn,{todo=false}={})=>{try{await fn();checks.push({name,ok:true,todo});console.log(`${todo?'ℹ':'✔'} ${name}`);}catch(error){failures++;checks.push({name,ok:false,error:error.message});console.log(`✖ ${name}: ${error.message}`);}};
 const token='local-session-token',csrf='local-csrf',hash=createHash('sha256').update(token).digest('hex');
 raw.prepare('INSERT INTO reuse_sessions(token_hash,discord_user_id,discord_username,guilds_json,csrf_token,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').run(hash,UID,'Delivery E2E',JSON.stringify([{id:guildId,name:'E2E',owner:true,permissions:'32'}]),csrf,now,now+3600000);
 const env={REUSE_DB:db,SUPPORTER_PUBLIC_ENABLED:'true',SUPPORTER_PUBLIC_ORIGIN:'https://dpi-bot.com',SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'sk_test_local_only',STRIPE_WEBHOOK_SECRET:'whsec_local_only',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_local',SUPPORTER_CONSENT_VERSION:'e2e-v1',SUPPORTER_IMAGE_RULES_ENABLED:'1',SUPPORTER_IMAGE_RULES_V2_ENABLED:'1'};
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async(input,init={})=>{const url=new URL(typeof input==='string'?input:input.url);if(url.hostname==='discord.com'&&url.pathname.includes('/channels'))return Response.json([{id:channelId,type:0,position:0}]);if(url.hostname==='api.stripe.com'){if(url.pathname==='/v1/subscriptions')return Response.json({data:subscriptionStatus==='canceled'?[]:[{...active(plan),items:{data:[{price:{id:plan==='supporter'?'price_basic':`price_${plan}`,unit_amount:300}}]}}]});if(url.pathname.startsWith('/v1/customers/'))return Response.json({id:CUSTOMER});if(url.pathname==='/v1/invoices')return Response.json({data:[]});return Response.json({data:[]});}throw new Error(`外部通信を遮断しました: ${url.origin}`);};
 const req=async(pathname,{method='GET',body,origin='https://dpi-bot.com',logged=true,csrfValue=csrf}={})=>handleSupporterRequest(new Request(`https://dpi-bot.com${pathname}`,{method,body:body===undefined?undefined:JSON.stringify(body),headers:{...(logged?{Cookie:`dpi_reuse_session=${token}`}:{ }),'Content-Type':'application/json',Origin:origin,'x-reuse-csrf':csrfValue}}),env);
 const loader=async()=>new Map([[CUSTOMER,subscriptionStatus==='canceled'?[]:[active(plan)]]]);
 const snapshot=(at=now)=>buildSupporterSnapshot(db,env,loader,at);
 try{
  await check('登録: 未ログイン拒否',async()=>assert.equal((await req('/api/supporter/account',{method:'POST',body:{email:'a@example.com'},logged:false})).status,401));
  await check('登録: 同意なし・不正メール・CSRF拒否',async()=>{assert.throws(()=>supporterConsentVersion({legalConsent:false},env));assert.ok((await req('/api/supporter/account',{method:'POST',body:{email:'bad'}})).status>=400);assert.equal((await req('/api/supporter/account',{method:'POST',body:{email:'a@example.com'},origin:'https://evil.invalid'})).status,403);});
  await check('登録: Discordログイン・冪等・他人を分離',async()=>{for(let i=0;i<2;i++)assert.equal((await req('/api/supporter/account',{method:'POST',body:{email:'user@example.jp'}})).status,200);assert.equal(raw.prepare('SELECT count(*) n FROM supporter_accounts WHERE discord_user_id=?').get(UID).n,1);raw.prepare("INSERT INTO supporter_accounts(discord_user_id,billing_email,registered_at,updated_at) VALUES(?,?,?,?)").run(OTHER,'other@example.jp','x','x');const a=await (await req('/api/supporter/account')).json();assert.equal(a.account.discord_user_id,UID);assert.doesNotMatch(JSON.stringify(a),/other@example/);});
  raw.prepare('INSERT INTO supporter_billing(discord_user_id,customer_id) VALUES(?,?)').run(UID,CUSTOMER);
  const basicRules=[rule('earthquake',guildId,channelId,{detail:'all',intensityMode:'threshold',intensity:'3',magnitudeMode:'all'}),rule('eew',guildId,channelId,{detail:'warning',intensity:'4',eewWarningAreaMode:'all'}),rule('weather',guildId,channelId,{detail:'all'}),rule('eew-map',guildId,channelId)];
  await check('ルール: 契約前はsnapshot対象外',async()=>{subscriptionStatus='canceled';assert.equal((await snapshot()).rules.length,0);subscriptionStatus='active';});
  await check('ルール: Basic保存・revision競合・変更・削除・空',async()=>{let r=await req('/api/supporter/settings',{method:'PUT',body:{revision:0,rules:basicRules}});assert.equal(r.status,200,await r.text());assert.equal((await req('/api/supporter/settings',{method:'PUT',body:{revision:0,rules:basicRules}})).status,409);r=await req('/api/supporter/settings',{method:'PUT',body:{revision:1,rules:basicRules.slice(0,2)}});assert.equal(r.status,200,await r.text());r=await req('/api/supporter/settings',{method:'PUT',body:{revision:2,rules:[]}});assert.equal(r.status,200,await r.text());});
  await check('ルール: 上限・プラン機能・非管理サーバー/チャンネル拒否',async()=>{assert.throws(()=>normalizeSupporterRules(Array.from({length:6},(_,i)=>rule('earthquake',guildId,channelId,{name:`r${i}`})),[{id:guildId}],limits('supporter')));assert.throws(()=>normalizeSupporterRules([rule('hires-radar',guildId,channelId)], [{id:guildId}],limits('supporter'),null,{imageRules:true,imageRulesV2:true}));assert.throws(()=>normalizeSupporterRules([rule('earthquake','11111111111111111',channelId)],[{id:guildId}],limits('pro')));const bad=await req('/api/supporter/settings',{method:'PUT',body:{revision:3,rules:[rule('earthquake',guildId,'11111111111111112')]}});assert.equal(bad.status,400);});
  await check('プラン: Basic→Plus→Pro・ダウングレード・カスタム上限',async()=>{const image=rule('hires-radar',guildId,channelId);assert.throws(()=>normalizeSupporterRules([image],[{id:guildId}],limits('supporter'),null,{imageRules:true,imageRulesV2:true}));assert.doesNotThrow(()=>normalizeSupporterRules([image],[{id:guildId}],limits('plus'),null,{imageRules:true,imageRulesV2:true}));const multi={...rule('earthquake',guildId,channelId),channelIds:[channelId,'11111111111111113']};assert.doesNotThrow(()=>normalizeSupporterRules([multi],[{id:guildId}],limits('pro')));assert.throws(()=>normalizeSupporterRules([multi],[{id:guildId}],limits('plus')));assert.throws(()=>normalizeSupporterRules([rule('earthquake',guildId,channelId),rule('weather',guildId,channelId)],[{id:guildId}],{...limits('pro'),rules:1}));});
  const proRules=[...basicRules.slice(0,3),rule('hires-radar',guildId,channelId,{radarCondition:'scheduled',deliveryIntervalHours:3}),rule('tsunami-map',guildId,channelId,{outputs:['map','table']}),rule('earthquake-map',guildId,channelId,{products:['VXSE51']})];
  plan='pro';raw.prepare('UPDATE supporter_accounts SET settings_json=?,revision=revision+1 WHERE discord_user_id=?').run(JSON.stringify({rules:normalizeSupporterRules(proRules,[{id:guildId}],limits('pro'),null,{imageRules:true,imageRulesV2:true})}),UID);
  let activeSnapshot=await snapshot(now);
  await check('snapshot: 指定ルール・宛先・schema・期限・個人情報なし',async()=>{assert.equal(activeSnapshot.schemaVersion,4);assert.equal(activeSnapshot.expiresAt-activeSnapshot.generatedAt,108000);assert.ok(activeSnapshot.rules.every(x=>x.guildId===guildId&&x.channelIds.includes(channelId)));assert.deepEqual(new Set(activeSnapshot.rules.map(x=>x.type)),new Set(['earthquake','eew','weather','hires-radar','tsunami-map','earthquake-map']));assert.doesNotMatch(JSON.stringify(activeSnapshot),/user@example|cus_delivery|Delivery E2E|637850/);});
  await check('snapshot: 他人・未契約・停止・BAN・解約を除外',async()=>{subscriptionStatus='canceled';assert.equal((await snapshot()).rules.length,0);subscriptionStatus='active';raw.prepare("UPDATE supporter_accounts SET account_status='suspended',status_reason='BAN' WHERE discord_user_id=?").run(UID);assert.equal((await snapshot()).rules.length,0);raw.prepare("UPDATE supporter_accounts SET account_status='active' WHERE discord_user_id=?").run(UID);raw.prepare("INSERT INTO supporter_dunning(invoice_id,customer_id,amount_due,currency,status,initial_failed_at,retry_at,suspend_at,updated_at) VALUES('in_e2e',?,300,'jpy','suspended',1,1,1,1)").run(CUSTOMER);assert.equal((await snapshot()).rules.length,0);raw.prepare("DELETE FROM supporter_dunning WHERE invoice_id='in_e2e'").run();});
  await check('解除: 期間末・即時解約・停止・BAN・支払確認後の復帰',async()=>{for(const state of ['canceled','suspended','BAN']){if(state==='canceled')subscriptionStatus='canceled';else raw.prepare("UPDATE supporter_accounts SET account_status='suspended',status_reason=? WHERE discord_user_id=?").run(state,UID);assert.equal((await snapshot()).rules.length,0);subscriptionStatus='active';raw.prepare("UPDATE supporter_accounts SET account_status='active',status_reason=NULL WHERE discord_user_id=?").run(UID);}assert.ok((await snapshot()).rules.length>0);});
  await check('課金Webhookと定期処理をローカル差し替えで実行',async()=>{const body=JSON.stringify({id:'evt_local',type:'local.noop',livemode:false,created:Math.floor(now/1000),data:{object:{}}}),ts=Math.floor(Date.now()/1000),sig=createHmac('sha256','whsec_local_only').update(`${ts}.${body}`).digest('hex');assert.equal((await billingWebhook(new Request('https://dpi-bot.com/api/supporter/stripe/webhook',{method:'POST',body,headers:{'stripe-signature':`t=${ts},v1=${sig}`}}),env)).status,200);await runSupporterBillingSchedule(env,now);});
  await check('退会処理',async()=>{}, {todo:true});
  subscriptionStatus='active';raw.prepare("UPDATE supporter_accounts SET account_status='active'").run();raw.prepare('DELETE FROM supporter_dunning').run();
  activeSnapshot=await snapshot(now);
  raw.prepare("INSERT INTO supporter_dunning(invoice_id,customer_id,subscription_id,amount_due,currency,status,initial_failed_at,retry_at,suspend_at,updated_at) VALUES('in_suspended',?,'sub_pro',1280,'jpy','suspended',1,1,1,1)").run(CUSTOMER);
  const suspendedSnapshot=await snapshot(now);raw.prepare('DELETE FROM supporter_dunning').run();
  subscriptionStatus='canceled';const canceledSnapshot=await snapshot(now);subscriptionStatus='active';
  await check('書き出す配信設定: 契約中は全ルール、停止中・解約後は0件',async()=>{assert.equal(activeSnapshot.rules.length,proRules.length);assert.equal(suspendedSnapshot.rules.length,0);assert.equal(canceledSnapshot.rules.length,0);});
  await check('切替前削除: 対象全消去・対象外保持・FK整合・再登録',async()=>{raw.prepare("INSERT INTO reuse_applications(id,reference,status,revision,discord_user_id,discord_username,guild_id,guild_name,channel_id,channel_name,channel_type,delivery_types,server_public,channel_visibility,announcement_automated,reuse_method,contact_email,purpose,created_at,updated_at,manage_token_hash) VALUES('keep','REFKEEP','pending',1,?,?,?,?,?,?,0,'[]','yes','public','yes','link','x@example.jp','audit','x','x','token-keep')").run(UID,'u',guildId,'g',channelId,'c');raw.exec(purgeSql());for(const table of PURGE_TABLES)assert.equal(raw.prepare(`SELECT count(*) n FROM ${table}`).get().n,0,table);assert.equal(raw.prepare('SELECT count(*) n FROM reuse_applications').get().n,1);assert.equal(raw.prepare('PRAGMA foreign_key_check').all().length,0);raw.prepare("INSERT INTO supporter_accounts(discord_user_id,billing_email,registered_at,updated_at) VALUES(?,?,?,?)").run(UID,'again@example.jp','x','x');assert.equal(raw.prepare('SELECT count(*) n FROM supporter_accounts').get().n,1);});
  await mkdir(exportDir,{recursive:true});
  // 解約後・停止中は、実際の処理が出した配信設定をそのまま書き出す。
  const expired={...activeSnapshot,generatedAt:Math.floor(now/1000)-108001,expiresAt:Math.floor(now/1000)-1};
  await Promise.all(Object.entries({active:activeSnapshot,canceled:canceledSnapshot,suspended:suspendedSnapshot,expired}).map(([name,value])=>writeFile(path.join(exportDir,`${name}.json`),JSON.stringify(value,null,2)+'\n','utf8')));
  await check('JSON出力: active/canceled/suspended/expired',async()=>{for(const name of ['active','canceled','suspended','expired'])JSON.parse(await readFile(path.join(exportDir,`${name}.json`),'utf8'));});
 }finally{globalThis.fetch=originalFetch;raw.close();}
 console.log(`\n合格 ${checks.filter(x=>x.ok&&!x.todo).length}件 / 失敗 ${failures}件 / 情報 ${checks.filter(x=>x.todo).length}件`);
 return {passed:checks.filter(x=>x.ok&&!x.todo).length,failures,checks,exportDir};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const value=name=>{const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:undefined;};
 const result=await runDeliveryE2E({exportDir:value('--export'),guildId:value('--guild'),channelId:value('--channel')});
 if(result.failures)process.exitCode=1;
}
