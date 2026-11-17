import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {billingWebhook,creditsByCustomer,grantCreditOnce,reconcilePendingCreditTopups,runSupporterBillingSchedule,subscriptionSummariesByCustomer} from '../worker/supporter-billing.js';
import {processCompensationCampaign,supporterCreditMetrics} from '../worker/supporter.js';
import {refreshSupporterSnapshotSafely} from '../worker/supporter-snapshot.js';
import worker from '../worker/index.js';

const UID='637850681666961408',GUILD='12345678901234567',CHANNEL='98765432109876543';
const baseEnv={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_example',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x'};
const snapshotEnv={...baseEnv,AWS_CHANNEL_DIRECTORY_URL:'https://aws.example.test/directory',AWS_CHANNEL_DIRECTORY_TOKEN:'test-token'};
const ok=data=>new Response(JSON.stringify({livemode:false,...data}),{status:200,headers:{'content-type':'application/json'}});
async function withFetch(handler,body){const original=globalThis.fetch;globalThis.fetch=handler;try{return await body();}finally{globalThis.fetch=original;}}
function subscription(id,customer,price='price_plus'){return{id,customer,status:'active',metadata:{},items:{data:[{price:{id:price,unit_amount:800,currency:'jpy'},quantity:1,current_period_start:1,current_period_end:2}]}};}
function pagedList(total,pageSize,build){
 return url=>{
  const after=url.searchParams.get('starting_after');const start=after?Number(after.split('_').pop())+1:0;
  const data=[];for(let i=start;i<Math.min(total,start+pageSize);i++)data.push(build(i));
  return {object:'list',data,has_more:start+pageSize<total};
 };
}
function account(customer='cus_target'){
 return{discord_user_id:UID,customer_id:customer,revision:1,settings_json:JSON.stringify({rules:[{name:'地震',type:'earthquake',guildId:GUILD,channelId:CHANNEL,channelIds:[CHANNEL],conditionLogic:'and',conditions:[]}]})};
}

// W-3
test('W-3: 定期処理が途中で失敗しても配信スナップショットを先に独立して再公開する',async()=>{
 const order=[],published=[];
 const db={prepare(sql){return{bind(){return this;},async all(){
  if(sql.includes('supporter_custom_plans'))return{results:[]};
  if(sql.includes('FROM supporter_accounts a')&&sql.includes('NOT EXISTS')){order.push('snapshot_query');return{results:[account()]};}
  if(sql.includes('FROM supporter_dunning')){order.push('dunning');throw new Error('D1 unavailable');}
  return{results:[]};
 },async first(){return null;},async run(){return{meta:{changes:0}};}};}};
 await withFetch(async(input,init={})=>{
  const url=new URL(input);
  if(url.hostname==='aws.example.test'){order.push('publish');published.push(JSON.parse(init.body).snapshot);return new Response(JSON.stringify({success:true,published:true}),{status:200});}
  if(url.pathname==='/v1/subscriptions')return ok({data:[subscription('sub_1','cus_target')],has_more:false});
  return ok({});
 },async()=>{
  await assert.rejects(runSupporterBillingSchedule({...snapshotEnv,REUSE_DB:db}),/D1 unavailable/);
 });
 assert.equal(order.indexOf('publish')<order.indexOf('dunning'),true,'snapshot must be published before other cron tasks');
 assert.ok(published.length>=1);
 assert.equal(published[0].rules.length,1);
 assert.ok(published[0].expiresAt>published[0].generatedAt);
});

// W-2
test('W-2: 契約一覧は500件を超えても最後までページングし、長期会員を契約なしと誤判定しない',async()=>{
 const pages=[];
 const list=pagedList(730,100,i=>subscription(`sub_${i}`,i===725?'cus_target':`cus_other_${i}`));
 const grouped=await withFetch(async input=>{const url=new URL(input);pages.push(url.searchParams.get('starting_after'));return ok(list(url));},
  ()=>subscriptionSummariesByCustomer(baseEnv,['cus_target']));
 assert.equal(pages.length,8);
 assert.equal(grouped.get('cus_target').length,1);
 assert.equal(grouped.get('cus_target')[0].planId,'plus');
});
test('W-2: クレジット残高一覧も500顧客を超えて最後まで取得する',async()=>{
 const list=pagedList(640,100,i=>({id:`cus_${i}`,balance:i===633?-1200:0}));
 const balances=await withFetch(async input=>ok(list(new URL(input))),()=>creditsByCustomer(baseEnv,['cus_633']));
 assert.equal(balances.get('cus_633'),1200);
});
test('W-2: 一覧取得が途中で失敗したらスナップショットを公開せず前回の配信状態を維持する',async()=>{
 let publishes=0;
 const list=pagedList(730,100,i=>subscription(`sub_${i}`,`cus_${i}`));
 const db={prepare(sql){return{bind(){return this;},async all(){
  if(sql.includes('supporter_custom_plans'))return{results:[]};
  return{results:[account('cus_725')]};
 }};}};
 const result=await withFetch(async input=>{
  const url=new URL(input);
  if(url.hostname==='aws.example.test'){publishes+=1;return new Response(JSON.stringify({success:true,published:true}),{status:200});}
  if(url.searchParams.get('starting_after')==='sub_299')return new Response(JSON.stringify({error:{message:'rate limited'}}),{status:429});
  return ok(list(url));
 },()=>refreshSupporterSnapshotSafely(snapshotEnv,db,subscriptionSummariesByCustomer,'test'));
 assert.equal(result.reason,'failed');
 assert.equal(publishes,0);
});
test('W-2: ページ数上限に達した不完全な一覧は空の結果として扱わずエラーにする',async()=>{
 const list=pagedList(1_000_000,100,i=>subscription(`sub_${i}`,`cus_${i}`));
 await withFetch(async input=>ok(list(new URL(input))),async()=>{
  await assert.rejects(subscriptionSummariesByCustomer(baseEnv,['cus_target']),/上限件数/);
 });
});
test('W-2: 管理画面の一覧取得(GET)はクレジット台帳を書き換えない',async()=>{
 const now=Math.floor(Date.now()/1000);
 const lots=[{id:'lot1',discord_user_id:'100',source_type:'purchase',remaining_amount:800,expires_at:now+90*86400},{id:'lot2',discord_user_id:'200',source_type:'purchase',remaining_amount:500,expires_at:now+10*86400}];
 const db={prepare(sql){return{bind(){return this;},async all(){return{results:lots.map(lot=>({...lot}))};},
  async run(){throw new Error(`unexpected write: ${sql}`);},
  async first(){if(sql.includes('SUM(amount-refunded_amount)'))return{net_purchased:1300,purchasers:2};if(sql.includes("reason='credit_expired'"))return{expired:0};return null;}};}};
 const rows=[{discord_user_id:'100',customer_id:'cus_1'},{discord_user_id:'200',customer_id:'cus_2'}];
 const result=await supporterCreditMetrics(db,rows,new Map([['cus_1',1000],['cus_2',200]]),true);
 assert.equal(result.purchasedBalance,1000);assert.equal(result.purchasedUsers,2);assert.equal(result.expiring30Days,200);
 assert.equal(lots[1].remaining_amount,500,'stored lots stay untouched');
});

// W-1 / W-14
function ledgerDb({grants=new Map(),pending=[],events=new Set(),billingEmail=null}={}){
 const writes=[];
 const db={grants,writes,prepare(sql){let values=[];return{sql,bind(...input){values=input;return this;},
  async all(){if(sql.includes("status='pending'")&&sql.includes('supporter_credit_topups'))return{results:pending};return{results:[]};},
  async first(){
   if(sql.includes('supporter_stripe_events'))return events.has(values[0])?{id:values[0]}:null;
   if(sql.includes('SELECT * FROM supporter_credit_grants'))return grants.get(values[0])||null;
   if(sql.includes('SELECT customer_id FROM supporter_billing'))return{customer_id:'cus_credit'};
   if(sql.includes('billing_email'))return billingEmail?{billing_email:billingEmail}:null;
   return null;
  },
  async run(){
   writes.push({sql,values});
   if(sql.includes('INSERT INTO supporter_stripe_events'))events.add(values[0]);
   if(sql.includes('INSERT INTO supporter_credit_grants')){if(grants.has(values[0]))return{meta:{changes:0}};grants.set(values[0],{grant_key:values[0],kind:values[1],discord_user_id:values[2],customer_id:values[3],amount:values[4],status:'claimed',created_at:values[5]});return{meta:{changes:1}};}
   if(sql.includes("UPDATE supporter_credit_grants SET status='granted'")){const row=grants.get(values[3]);Object.assign(row,{status:'granted',stripe_transaction_id:values[0],balance_after:values[1]});}
   return{meta:{changes:1}};
  }};},
  async batch(statements){const out=[];for(const statement of statements)out.push(await statement.run());return out;}};
 return db;
}
function topupSession(id='cs_credit_paid'){
 const now=Math.floor(Date.now()/1000);
 return{id,livemode:false,mode:'payment',status:'complete',payment_status:'paid',customer:'cus_credit',payment_intent:'pi_credit',client_reference_id:UID,amount_total:1000,currency:'jpy',created:now-60,metadata:{dpi_checkout_kind:'credit_topup',dpi_user:UID,dpi_credit_amount:'1000',dpi_topup_request_id:'6fb5b84e-03f7-44c0-bf04-4ee3ad22db20'}};
}
test('W-1: チャージ完了メールの送信失敗でWebhookを503にせず、付与の再配信を起こさない',async()=>{
 const timestamp=Math.floor(Date.now()/1000),db=ledgerDb({billingEmail:'user@example.jp'});
 const event={id:'evt_topup_mailfail',created:timestamp,livemode:false,type:'checkout.session.completed',data:{object:topupSession()}};
 const raw=JSON.stringify(event),signature=createHmac('sha256',baseEnv.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest('hex');
 const env={...baseEnv,REUSE_DB:db,NOTICE_FROM_EMAIL:'noreply@example.jp',NOTICE_EMAIL:{async send(){throw Object.assign(new Error('mail down'),{code:'E_MAIL'});}}};
 const posts=[];
 const response=await withFetch(async(input,init={})=>{const url=new URL(input);if(init.method==='POST')posts.push({path:url.pathname,params:new URLSearchParams(init.body)});return ok({id:'cbtxn_1',ending_balance:-1000});},
  ()=>worker.fetch(new Request('https://dpi-bot.com/api/supporter/stripe/webhook',{method:'POST',headers:{'stripe-signature':`t=${timestamp},v1=${signature}`},body:raw}),env,{waitUntil(){}}));
 assert.equal(response.status,200);
 const grantsPosted=posts.filter(post=>post.path.endsWith('/balance_transactions'));
 assert.equal(grantsPosted.length,1);
 assert.equal(grantsPosted[0].params.get('metadata[dpi_credit_grant]'),'topup:cs_credit_paid');
 assert.equal(db.grants.get('topup:cs_credit_paid').status,'granted');
 assert.ok(db.writes.some(item=>item.sql.includes('INSERT INTO supporter_stripe_events')),'event is acknowledged');
});
test('W-1: 24時間後に残ったpending行の再照合でも付与済みクレジットを二重付与しない',async()=>{
 const grants=new Map([['topup:cs_credit_paid',{grant_key:'topup:cs_credit_paid',customer_id:'cus_credit',amount:1000,status:'granted',stripe_transaction_id:'cbtxn_old',balance_after:1000,created_at:1}]]);
 const db=ledgerDb({grants,pending:[{request_id:'6fb5b84e-03f7-44c0-bf04-4ee3ad22db20',checkout_session_id:'cs_credit_paid'}]});
 const posts=[];
 const result=await withFetch(async(input,init={})=>{const url=new URL(input);if(init.method==='POST')posts.push(url.pathname);if(url.pathname.startsWith('/v1/checkout/sessions/'))return ok(topupSession());return ok({id:'pi_credit',created:Math.floor(Date.now()/1000)});},
  ()=>reconcilePendingCreditTopups(baseEnv,db,UID,'cus_credit'));
 assert.equal(posts.filter(path=>path.endsWith('/balance_transactions')).length,0);
 assert.equal(result.recovered,0);
});
test('W-1: Stripe付与後に記録できなかった請求は再試行時にStripe側の取引を見つけて再付与しない',async()=>{
 const claimedAt=Math.floor(Date.now()/1000)-3*86400;
 const grants=new Map([['topup:cs_credit_paid',{grant_key:'topup:cs_credit_paid',customer_id:'cus_credit',amount:1000,status:'claimed',created_at:claimedAt}]]);
 const db=ledgerDb({grants,pending:[{request_id:'6fb5b84e-03f7-44c0-bf04-4ee3ad22db20',checkout_session_id:'cs_credit_paid'}]});
 const posts=[];
 await withFetch(async(input,init={})=>{
  const url=new URL(input);if(init.method==='POST')posts.push(url.pathname);
  if(url.pathname.endsWith('/balance_transactions'))return ok({data:[{id:'cbtxn_other',created:claimedAt+50,metadata:{}},{id:'cbtxn_earlier',created:claimedAt+10,ending_balance:-1000,metadata:{dpi_credit_action:'user_topup',dpi_checkout_session:'cs_credit_paid'}}],has_more:false});
  if(url.pathname.startsWith('/v1/checkout/sessions/'))return ok(topupSession());
  return ok({id:'pi_credit',created:claimedAt});
 },()=>reconcilePendingCreditTopups(baseEnv,db,UID,'cus_credit'));
 assert.equal(posts.filter(path=>path.endsWith('/balance_transactions')).length,0);
 assert.equal(db.grants.get('topup:cs_credit_paid').status,'granted');
 assert.equal(db.grants.get('topup:cs_credit_paid').stripe_transaction_id,'cbtxn_earlier');
 assert.ok(db.writes.some(item=>item.sql.includes('INSERT INTO supporter_credit_topups')&&item.values.includes('cbtxn_earlier')));
});
test('W-1: 同じ付与キーが別の顧客・金額で再利用された場合は付与しない',async()=>{
 const grants=new Map([['topup:x',{grant_key:'topup:x',customer_id:'cus_other',amount:1000,status:'claimed',created_at:1}]]);
 await assert.rejects(grantCreditOnce(baseEnv,ledgerDb({grants}),{grantKey:'topup:x',kind:'credit_topup',uid:UID,customer:'cus_credit',amount:1000,params:{},idempotencyKey:'k',record:()=>[]}),/別の条件/);
});
test('W-14: 補償クレジット配布の再開時、記録前に付与済みの対象者へ二重付与しない',async()=>{
 const campaignId='0f8b8a51-6a4e-4f39-8f63-1f0d6f0d2a11',lotId=`compensation:${campaignId}:${UID}`;
 const claimedAt=Math.floor(Date.now()/1000)-2*86400;
 const grants=new Map([[lotId,{grant_key:lotId,customer_id:'cus_comp',amount:500,status:'claimed',created_at:claimedAt}]]);
 const writes=[];
 const db={grants,prepare(sql){let values=[];return{bind(...input){values=input;return this;},
  async first(){
   if(sql.includes('SELECT * FROM supporter_credit_campaigns'))return{id:campaignId,status:'processing',amount:500,reason:'障害補償のため',expires_at:claimedAt+365*86400};
   if(sql.includes('SELECT * FROM supporter_credit_grants'))return grants.get(values[0])||null;
   if(sql.includes('COUNT(*) AS total'))return{total:1,credited:1,failed:0,pending:0};
   return null;
  },
  async all(){if(sql.includes('FROM supporter_credit_campaign_recipients r'))return{results:[{discord_user_id:UID,request_id:'5e0c9c39-6a2b-4a43-9a3c-2a7f3f0c1b22',lot_id:lotId,attempts:1,billing_email:'u@example.jp',customer_id:'cus_comp'}]};return{results:[]};},
  async run(){writes.push({sql,values});
   if(sql.includes('INSERT INTO supporter_credit_grants'))return{meta:{changes:grants.has(values[0])?0:1}};
   if(sql.includes("UPDATE supporter_credit_grants SET status='granted'"))Object.assign(grants.get(values[3]),{status:'granted',stripe_transaction_id:values[0]});
   return{meta:{changes:1}};}};},
  async batch(statements){for(const statement of statements)await statement.run();}};
 const posts=[];
 await withFetch(async(input,init={})=>{
  const url=new URL(input);if(init.method==='POST')posts.push(url.pathname);
  if(url.pathname.endsWith('/balance_transactions'))return ok({data:[{id:'cbtxn_comp',created:claimedAt+5,ending_balance:-500,metadata:{dpi_credit_grant:lotId}}],has_more:false});
  return ok({});
 },()=>processCompensationCampaign(baseEnv,db,{email:'admin@example.jp'},campaignId));
 assert.equal(posts.length,0,'no new Stripe balance credit');
 assert.equal(grants.get(lotId).status,'granted');
 assert.ok(writes.some(item=>item.sql.includes("SET status='credited'")&&item.values[0]==='cbtxn_comp'));
});
test('W-1: 付与予約テーブルのマイグレーションは付与キーを一意にする',async()=>{
 const migration=await readFile(new URL('../migrations/0028_supporter_credit_grants.sql',import.meta.url),'utf8');
 assert.match(migration,/CREATE TABLE IF NOT EXISTS supporter_credit_grants/);
 assert.match(migration,/grant_key TEXT PRIMARY KEY/);
 assert.match(migration,/stripe_transaction_id TEXT UNIQUE/);
});

// W-17
test('W-17: 運用文書とGoogle Apps Scriptは静的配信しない',async()=>{
 const ignore=await readFile(new URL('../.assetsignore',import.meta.url),'utf8');
 assert.match(ignore,/^\/MAINTENANCE\.md$/m);
 assert.match(ignore,/^\/google-apps-script\/$/m);
 for(const path of ['/MAINTENANCE.md','/maintenance.md','/google-apps-script/survey/Code.gs','/google-apps-script/survey/README.md','/nested/Code.gs']){
  let fetched=false;
  const response=await worker.fetch(new Request(`https://dpi-bot.com${path}`),{ASSETS:{fetch(){fetched=true;return new Response('private');}}});
  assert.equal(response.status,404,path);assert.equal(fetched,false,path);
 }
});
