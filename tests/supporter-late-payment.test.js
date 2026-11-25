import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { rejectDisciplinedCheckout } from '../worker/supporter-billing.js';
import { supporterAdminPayments } from '../worker/supporter-admin-payments.js';
import { handleSupporterRequest } from '../worker/supporter.js';

const UID='123456789012345678';
const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_example',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x'};

function database(){
 const raw=new DatabaseSync(':memory:');
 raw.exec(`
  CREATE TABLE supporter_accounts(discord_user_id TEXT PRIMARY KEY,discord_name TEXT,billing_email TEXT,account_status TEXT);
  CREATE TABLE supporter_billing(discord_user_id TEXT PRIMARY KEY,customer_id TEXT,checkout_key TEXT,checkout_id TEXT,checkout_params TEXT,dirty INTEGER DEFAULT 0);
  CREATE TABLE supporter_credit_topups(request_id TEXT PRIMARY KEY,discord_user_id TEXT,customer_id TEXT,checkout_session_id TEXT,amount INTEGER,status TEXT,created_at INTEGER,updated_at INTEGER,refunded_amount INTEGER DEFAULT 0,purchased_at INTEGER,expires_at INTEGER);
  CREATE TABLE supporter_disciplinary_actions(request_id TEXT PRIMARY KEY,discord_user_id TEXT,action TEXT,status TEXT,completed_at INTEGER);
  CREATE TABLE supporter_payment_alerts(event_id TEXT PRIMARY KEY,kind TEXT NOT NULL,outcome TEXT NOT NULL DEFAULT '',payment_intent_id TEXT NOT NULL DEFAULT '',customer_id TEXT NOT NULL DEFAULT '',discord_user_id TEXT NOT NULL DEFAULT '',amount INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
  CREATE TABLE supporter_ops_notices(id TEXT PRIMARY KEY,channel TEXT,kind TEXT,payload_json TEXT,status TEXT DEFAULT 'pending',attempts INTEGER DEFAULT 0,created_at INTEGER,updated_at INTEGER);
  CREATE TABLE supporter_billing_notifications(invoice_id TEXT,kind TEXT,status TEXT,attempts INTEGER DEFAULT 0,last_error TEXT,sent_at INTEGER,updated_at INTEGER,PRIMARY KEY(invoice_id,kind));
  CREATE TABLE supporter_dunning(invoice_id TEXT PRIMARY KEY,customer_id TEXT,amount_due INTEGER,currency TEXT,status TEXT,initial_failed_at INTEGER,retry_at INTEGER,retry_attempted_at INTEGER,suspend_at INTEGER,suspended_at INTEGER,paid_at INTEGER,updated_at INTEGER);
  CREATE TABLE supporter_discord_roles(discord_user_id TEXT,role_id TEXT,status TEXT,attempts INTEGER DEFAULT 0,last_error TEXT,updated_at INTEGER);
 `);
 raw.prepare('INSERT INTO supporter_accounts VALUES(?,?,?,?)').run(UID,'Late Supporter','private@example.jp','suspended');
 raw.prepare('INSERT INTO supporter_billing(discord_user_id,customer_id,checkout_key,checkout_id,checkout_params) VALUES(?,?,?,?,?)').run(UID,'cus_private','key','cs_late','{}');
 raw.prepare("INSERT INTO supporter_credit_topups(request_id,discord_user_id,customer_id,checkout_session_id,amount,status,created_at,updated_at) VALUES('req',?,?,?,1200,'pending',1,1)").run(UID,'cus_private','cs_late');
 const statement=(sql,values=[])=>({bind(...input){return statement(sql,input);},async first(){return raw.prepare(sql).get(...values)??null;},async all(){return{results:raw.prepare(sql).all(...values)};},async run(){return{meta:{changes:Number(raw.prepare(sql).run(...values).changes)}};}});
 const db={prepare:sql=>statement(sql),async batch(statements){const results=[];for(const item of statements)results.push(await item.run());return results;}};
 return{raw,db};
}

function session(extra={}){return{id:'cs_late',mode:'payment',payment_status:'paid',payment_intent:'pi_private',client_reference_id:UID,amount_total:1200,metadata:{dpi_user:UID,dpi_checkout_kind:'credit_topup'},...extra};}
function stripeReply(status,body){return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});}

test('late disciplined payment settles D1 first and successful/pending refunds run once without email for cards',async()=>{
 for(const refundStatus of ['succeeded','pending','requires_action']){
  const {raw,db}=database(),calls=[];const original=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{calls.push(new URLSearchParams(init.body));assert.equal(raw.prepare("SELECT status FROM supporter_credit_topups WHERE request_id='req'").get().status,'failed');assert.equal(raw.prepare("SELECT checkout_id FROM supporter_billing WHERE discord_user_id=?").get(UID).checkout_id,null);return stripeReply(200,{livemode:false,id:'re_x',status:refundStatus});};
  try{
   assert.equal(await rejectDisciplinedCheckout(env,db,session({payment_method_types:['card']})),true);
   assert.equal(await rejectDisciplinedCheckout(env,db,session({payment_method_types:['card']})),true);
   assert.equal(calls.length,1);assert.equal(calls[0].get('instructions_email'),null);
   assert.equal(raw.prepare('SELECT outcome FROM supporter_payment_alerts').get().outcome,refundStatus);
  }finally{globalThis.fetch=original;}
 }
});

test('unknown payment method retries a 400 email requirement once with a distinct request',async()=>{
 const {raw,db}=database(),calls=[];const original=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{const params=new URLSearchParams(init.body);calls.push({params,key:init.headers['Idempotency-Key']});return calls.length===1?stripeReply(400,{error:{param:'instructions_email',message:'email is required'}}):stripeReply(200,{livemode:false,id:'re_x',status:'succeeded'});};
 try{
  await rejectDisciplinedCheckout(env,db,session({customer_details:{email:'private@example.jp'}}));
  assert.equal(calls.length,2);assert.equal(calls[0].params.get('instructions_email'),null);assert.equal(calls[1].params.get('instructions_email'),'private@example.jp');assert.notEqual(calls[0].key,calls[1].key);
  assert.equal(raw.prepare('SELECT outcome FROM supporter_payment_alerts').get().outcome,'succeeded');
 }finally{globalThis.fetch=original;}
});

test('definitive refund refusal becomes one privacy-safe manual alert visible to admins',async()=>{
 for(const status of [400,404]){
  const {raw,db}=database(),calls=[];const original=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{calls.push(new URLSearchParams(init.body));return stripeReply(status,{error:{message:'refund refused'}});};
  try{
   const paid=session({payment_method_types:['konbini'],customer_details:{email:'private@example.jp'}});
   await rejectDisciplinedCheckout(env,db,paid);await rejectDisciplinedCheckout(env,db,paid);
   assert.equal(calls.length,status===400?2:1);assert.equal(calls[0].get('instructions_email'),null);if(status===400)assert.equal(calls[1].get('instructions_email'),'private@example.jp');
   const alert=raw.prepare('SELECT * FROM supporter_payment_alerts').get();assert.equal(alert.kind,'refund_needed');assert.equal(alert.outcome,'manual');assert.equal(alert.discord_user_id,UID);
   const notice=raw.prepare('SELECT * FROM supporter_ops_notices').get();assert.equal(notice.kind,'refund_needed');const serialized=notice.id+notice.payload_json;for(const secret of [UID,'Late Supporter','private@example.jp','pi_private','cs_late','cus_private'])assert.equal(serialized.includes(secret),false);
   const admin=await supporterAdminPayments(db,env,20);assert.equal(admin.alerts[0].discordUserId,UID);assert.equal(admin.alerts[0].name,'Late Supporter');assert.equal(admin.alerts[0].amount,1200);assert.equal(admin.alerts[0].kindLabel,'返金の対応が必要');assert.equal(admin.alerts[0].outcome,'manual');
  }finally{globalThis.fetch=original;}
 }
});

test('409 is left to Stripe redelivery',async()=>{
 const {raw,db}=database(),original=globalThis.fetch;globalThis.fetch=async()=>stripeReply(409,{error:{message:'in progress'}});
 try{
  await assert.rejects(()=>rejectDisciplinedCheckout(env,db,session()));
  assert.equal(raw.prepare('SELECT outcome FROM supporter_payment_alerts').get().outcome,'retry');assert.equal(raw.prepare('SELECT COUNT(*) count FROM supporter_ops_notices').get().count,0);
 }finally{globalThis.fetch=original;}
});

test('500 and timeout remain retryable and do not leave the charge pending',async()=>{
 for(const failure of [()=>stripeReply(500,{error:{message:'temporary'}}),()=>{throw new DOMException('timed out','TimeoutError');}]){
  const {raw,db}=database(),original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls+=1;return failure();};
  try{
   await assert.rejects(()=>rejectDisciplinedCheckout(env,db,session()));assert.equal(raw.prepare("SELECT status FROM supporter_credit_topups WHERE request_id='req'").get().status,'failed');assert.equal(raw.prepare('SELECT outcome FROM supporter_payment_alerts').get().outcome,'retry');
   globalThis.fetch=async()=>{calls+=1;return stripeReply(200,{livemode:false,id:'re_x',status:'succeeded'});};await rejectDisciplinedCheckout(env,db,session());assert.equal(calls,2);
  }finally{globalThis.fetch=original;}
 }
});

test('repeating an admin credit request reports the existing history as success',async()=>{
 const raw=new DatabaseSync(':memory:'),dir=new URL('../migrations/',import.meta.url);
 for(const file of (await readdir(dir)).filter(name=>name.endsWith('.sql')).sort())raw.exec(await readFile(new URL(file,dir),'utf8'));
 const statement=(sql,values=[])=>({bind(...input){return statement(sql,input);},async first(){return raw.prepare(sql).get(...values)??null;},async all(){return{results:raw.prepare(sql).all(...values)};},async run(){return{meta:{changes:Number(raw.prepare(sql).run(...values).changes)}};}}),db={prepare:sql=>statement(sql)};
 raw.prepare('INSERT INTO supporter_accounts(discord_user_id,discord_name,billing_email,account_status,registered_at,updated_at) VALUES(?,?,?,?,?,?)').run(UID,'Admin Credit','credit@example.jp','active','x','x');
 raw.prepare('INSERT INTO supporter_billing(discord_user_id,customer_id) VALUES(?,?)').run(UID,'cus_credit');
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),jwk=publicKey.export({format:'jwk'}),kid='late-payment-test',team='https://late-payment.cloudflareaccess.com',admin='admin@example.jp',now=Math.floor(Date.now()/1000);
 Object.assign(jwk,{kid,alg:'RS256',use:'sig'});
 const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url'),head=encode({alg:'RS256',kid}),body=encode({iss:team,aud:'aud',email:admin,sub:'admin',iat:now,exp:now+300}),token=`${head}.${body}.${sign('RSA-SHA256',Buffer.from(`${head}.${body}`),privateKey).toString('base64url')}`;
 const requestId='123e4567-e89b-42d3-a456-426614174999',input={discordUserId:UID,confirmDiscordUserId:UID,action:'grant_credit',amount:500,reason:'support adjustment',requestId};
 const actionEnv={...env,REUSE_DB:db,ACCESS_AUD:'aud',ACCESS_TEAM_DOMAIN:team,ADMIN_EMAILS:admin};let balance=0,created=0;const transactions=new Map(),original=globalThis.fetch;
 globalThis.fetch=async(url,init={})=>{
  const target=new URL(url);if(target.hostname==='late-payment.cloudflareaccess.com')return Response.json({keys:[jwk]});
  if(target.pathname==='/v1/customers/cus_credit')return stripeReply(200,{livemode:false,id:'cus_credit',balance});
  if(target.pathname.endsWith('/balance_transactions')){const key=init.headers['Idempotency-Key'];if(!transactions.has(key)){created+=1;balance=-500;transactions.set(key,{livemode:false,id:'cbtxn_once',ending_balance:balance});}return stripeReply(200,transactions.get(key));}
  throw new Error(`unexpected fetch ${target.pathname}`);
 };
 try{
  const send=()=>handleSupporterRequest(new Request('https://dpi-bot.com/site/supporter-admin/api/action',{method:'POST',headers:{'cf-access-jwt-assertion':token,'content-type':'application/json'},body:JSON.stringify(input)}),actionEnv);
  const first=await send(),second=await send(),firstBody=await first.json(),secondBody=await second.json();
  assert.equal(first.status,200);assert.equal(firstBody.creditRecorded,true);assert.equal(firstBody.creditDuplicate,false);
  assert.equal(second.status,200);assert.equal(secondBody.creditRecorded,true);assert.equal(secondBody.creditDuplicate,true);assert.equal(created,1);
  assert.equal(raw.prepare('SELECT COUNT(*) count FROM supporter_credit_events WHERE id=?').get(requestId).count,1);
 }finally{globalThis.fetch=original;}
});
