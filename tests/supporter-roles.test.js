import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { reconcileSupporterRoles } from '../worker/supporter-roles.js';

const UID='123456789012345678', GUILD='123456789012345679';
const ROLES={member:'1575053346904080424',supporter:'1575053348586131528',plus:'1575053350016385075',pro:'1575053351198920704',custom:'1575058113663475722'};
const env=db=>({REUSE_DB:db,SUPPORTER_BILLING_MODE:'live',DISCORD_BOT_TOKEN:'not-a-real-token',SUPPORTER_ROLE_GUILD_ID:GUILD,SUPPORTER_ROLE_MEMBER:ROLES.member,SUPPORTER_ROLE_BASIC:ROLES.supporter,SUPPORTER_ROLE_PLUS:ROLES.plus,SUPPORTER_ROLE_PRO:ROLES.pro,SUPPORTER_ROLE_CUSTOM:ROLES.custom});

async function store(t,count=1){
 let DatabaseSync;try{({DatabaseSync}=await import('node:sqlite'));}catch{t.skip('node:sqlite unavailable');return null;}
 const raw=new DatabaseSync(':memory:'),dir=new URL('../migrations/',import.meta.url);
 for(const file of (await readdir(dir)).filter(x=>x.endsWith('.sql')).sort())raw.exec(await readFile(new URL(file,dir),'utf8'));
 const statement=(sql,values=[])=>({bind(...v){return statement(sql,v);},async first(){return raw.prepare(sql).get(...values)??null;},async all(){return{results:raw.prepare(sql).all(...values)};},async run(){return{meta:{changes:Number(raw.prepare(sql).run(...values).changes)}};}});
 const db={prepare:sql=>statement(sql),async batch(items){return Promise.all(items.map(item=>item.run()));}};
 for(let i=0;i<count;i++){const uid=String(BigInt(UID)+BigInt(i)),customer=`cus_${i}`;raw.prepare('INSERT INTO supporter_accounts(discord_user_id,discord_name,billing_email,registered_at,updated_at) VALUES(?,?,?,?,?)').run(uid,'hidden','x@example.jp','x','x');raw.prepare('INSERT INTO supporter_billing(discord_user_id,customer_id) VALUES(?,?)').run(uid,customer);}
 return{raw,db};
}
function mockFetch(t,responder=()=>new Response(null,{status:204})){
 const calls=[],original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),method:init.method,headers:init.headers});return responder(calls.length,url,init);};return calls;
}
const loaderFor=plans=>async(_env,customers)=>new Map(customers.map((customer,index)=>[customer,plans[index]??plans[0]??[]]));
const active=planId=>({status:'active',recognizedPlan:true,planId});

test('各標準プラン、アップグレード、ダウングレードを最上位1ロールへ同期し二重送信しない',async t=>{
 const s=await store(t);if(!s)return;const calls=mockFetch(t),e=env(s.db);
 for(const plan of ['supporter','plus','pro']){
  await reconcileSupporterRoles(e,s.db,loaderFor([[active(plan)]]),{discordUserId:UID});
  const granted=s.raw.prepare("SELECT role_id FROM supporter_discord_roles WHERE status='granted' ORDER BY role_id").all().map(x=>x.role_id);
  assert.deepEqual(granted.sort(),[ROLES.member,ROLES[plan]].sort());
 }
 const before=calls.length;await reconcileSupporterRoles(e,s.db,loaderFor([[active('pro')]]),{discordUserId:UID});assert.equal(calls.length,before);
 assert.ok(calls.every(call=>call.headers.Authorization==='Bot not-a-real-token'&&call.headers['X-Audit-Log-Reason']));
});

test('停止・BAN・期間末解約で外し、支払い確認・解除で戻す。カスタムは加入者とカスタム',async t=>{
 const s=await store(t);if(!s)return;const calls=mockFetch(t),e=env(s.db),basic=loaderFor([[active('supporter')]]);
 await reconcileSupporterRoles(e,s.db,basic,{discordUserId:UID});
 const suspend=Math.floor(Date.now()/1000)-1;s.raw.prepare("INSERT INTO supporter_dunning(invoice_id,customer_id,amount_due,currency,status,initial_failed_at,retry_at,suspend_at,updated_at) VALUES('in_x','cus_0',1,'jpy','suspend_scheduled',0,0,?,0)").run(suspend);
 await reconcileSupporterRoles(e,s.db,basic,{discordUserId:UID});assert.equal(calls.filter(x=>x.method==='DELETE').length,2);
 s.raw.prepare("UPDATE supporter_dunning SET status='paid'").run();await reconcileSupporterRoles(e,s.db,basic,{discordUserId:UID});
 s.raw.prepare("UPDATE supporter_accounts SET account_status='suspended'").run();await reconcileSupporterRoles(e,s.db,basic,{discordUserId:UID});
 s.raw.prepare("UPDATE supporter_accounts SET account_status='active'").run();await reconcileSupporterRoles(e,s.db,loaderFor([[{...active('custom'),managedCustom:true}]]),{discordUserId:UID});
 assert.deepEqual(s.raw.prepare("SELECT role_id FROM supporter_discord_roles WHERE status='granted'").all().map(x=>x.role_id).sort(),[ROLES.member,ROLES.custom].sort());
 await reconcileSupporterRoles(e,s.db,loaderFor([[{status:'canceled',recognizedPlan:true,planId:'supporter'}]]),{discordUserId:UID});assert.equal(s.raw.prepare("SELECT COUNT(*) n FROM supporter_discord_roles WHERE status='granted'").get().n,0);
});

test('無効設定・取得失敗・Discord失敗を安全に扱い、未管理ロールは外さない',async t=>{
 const s=await store(t);if(!s)return;const calls=mockFetch(t,n=>n===1?Response.json({code:10007},{status:404}):n===2?Response.json({},{status:429}):new Response(null,{status:204}));
 assert.equal((await reconcileSupporterRoles({...env(s.db),SUPPORTER_BILLING_MODE:'test'},s.db,loaderFor([[active('plus')]]))).requests,0);
 assert.equal((await reconcileSupporterRoles({...env(s.db),SUPPORTER_ROLE_GUILD_ID:''},s.db,loaderFor([[active('plus')]]))).requests,0);
 await reconcileSupporterRoles(env(s.db),s.db,loaderFor([[active('plus')]]),{discordUserId:UID});assert.equal(calls.length,2,'429でその回を打ち切る');
 await reconcileSupporterRoles(env(s.db),s.db,loaderFor([[active('plus')]]),{discordUserId:UID});assert.equal(s.raw.prepare("SELECT COUNT(*) n FROM supporter_discord_roles WHERE status='granted'").get().n,2,'サーバー参加後の次回処理で付与する');
 const before=calls.length;await reconcileSupporterRoles(env(s.db),s.db,async()=>{throw new Error('Stripe unavailable');},{discordUserId:UID});assert.equal(calls.length,before);
 s.raw.prepare("INSERT INTO supporter_discord_roles VALUES(?,?,'removed',0,NULL,0)").run(UID,'1575053359999999999');
 await reconcileSupporterRoles(env(s.db),s.db,loaderFor([[]]),{discordUserId:UID});assert.ok(!calls.some(call=>call.url.endsWith('/1575053359999999999')));
});

test('1回のDiscord要求は40件まで',async t=>{
 const s=await store(t,25);if(!s)return;const calls=mockFetch(t),plans=Array.from({length:25},()=>[active('supporter')]);
 const result=await reconcileSupporterRoles(env(s.db),s.db,loaderFor(plans));assert.equal(result.requests,40);assert.equal(calls.length,40);assert.equal(result.pending,10);
});

test('403・500・時間切れは記録して処理を失敗させない',async t=>{
 const s=await store(t);if(!s)return;let mode='http';
 mockFetch(t,n=>mode==='timeout'?Promise.reject(new DOMException('timed out','AbortError')):new Response(null,{status:n===1?403:500}));
 await assert.doesNotReject(reconcileSupporterRoles(env(s.db),s.db,loaderFor([[active('plus')]]),{discordUserId:UID}));
 assert.deepEqual(s.raw.prepare('SELECT last_error FROM supporter_discord_roles ORDER BY role_id').all().map(x=>x.last_error).sort(),['http_403','http_500']);
 mode='timeout';await assert.doesNotReject(reconcileSupporterRoles(env(s.db),s.db,loaderFor([[active('plus')]]),{discordUserId:UID}));
 assert.ok(s.raw.prepare("SELECT COUNT(*) n FROM supporter_discord_roles WHERE last_error='AbortError'").get().n>0);
});

test('外せなかったロールは次回も外す。断られた付与は外そうとしない',async t=>{
 const s=await store(t);if(!s)return;let fail=false;const calls=mockFetch(t,()=>new Response(null,{status:fail?500:204})),e=env(s.db),one=options=>reconcileSupporterRoles(e,s.db,loaderFor([[active('supporter')]]),options),none=()=>reconcileSupporterRoles(e,s.db,loaderFor([[]]),{discordUserId:UID});
 await one({discordUserId:UID});fail=true;await none();
 assert.equal(s.raw.prepare("SELECT COUNT(*) n FROM supporter_discord_roles WHERE status='pending_remove'").get().n,2);
 fail=false;await none();assert.equal(s.raw.prepare("SELECT COUNT(*) n FROM supporter_discord_roles WHERE status='removed'").get().n,2);
 const before=calls.length;await none();assert.equal(calls.length,before,'外した後に余分な要求を送った');
 s.raw.prepare("UPDATE supporter_discord_roles SET status='pending_grant',last_error='http_404_code_10007'").run();await none();assert.equal(calls.length,before);
 s.raw.prepare("UPDATE supporter_discord_roles SET status='pending_grant',last_error='AbortError'").run();await none();assert.equal(calls.length,before+2,'付いたか分からないロールを外さない');
});

test('定期処理だけが、1日に1回付け直す。外す処理を先に、古いものから送る',async t=>{
 const s=await store(t,25);if(!s)return;const calls=mockFetch(t),e=env(s.db),now=Date.now(),plans=Array.from({length:25},()=>[active('supporter')]);
 await reconcileSupporterRoles(e,s.db,loaderFor(plans),{nowMs:now,renew:true});await reconcileSupporterRoles(e,s.db,loaderFor(plans),{nowMs:now,renew:true});
 assert.equal(calls.length,50);await reconcileSupporterRoles(e,s.db,loaderFor(plans),{nowMs:now,renew:true});assert.equal(calls.length,50);
 await reconcileSupporterRoles(e,s.db,loaderFor(plans),{nowMs:now+21*3600000});assert.equal(calls.length,50,'通常の処理では付け直さない');
 plans[24]=[];await reconcileSupporterRoles(e,s.db,loaderFor(plans),{nowMs:now+21*3600000,renew:true});
 assert.deepEqual(calls.slice(50,52).map(call=>call.method),['DELETE','DELETE']);assert.equal(calls.length,90);assert.ok(calls.slice(52).every(call=>call.method==='PUT'));
});

test('顧客から利用者を決める。該当が無い・DBが失敗しても、ほかの人のロールに触れず例外にしない',async t=>{
 const s=await store(t,2);if(!s)return;const calls=mockFetch(t),e=env(s.db),loader=async(_env,customers)=>new Map(customers.map(customer=>[customer,[active('pro')]]));
 for(const customer of ['','cus_unknown'])assert.equal((await reconcileSupporterRoles(e,s.db,loader,{customer})).requests,0);
 assert.equal((await reconcileSupporterRoles(e,{prepare(){throw new Error('D1 unavailable');}},loader,{customer:'cus_1'})).failed,true);
 assert.equal(calls.length,0);
 await reconcileSupporterRoles(e,s.db,loader,{customer:'cus_1'});
 assert.equal(calls.length,2);assert.ok(calls.every(call=>call.url.includes(`/members/${String(BigInt(UID)+1n)}/`)));
});
