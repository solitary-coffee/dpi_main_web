import test from 'node:test';
import assert from 'node:assert/strict';
import {payInvoiceWithCredits,paymentMethodRegistered} from '../worker/supporter-billing.js';

const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_x',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x'};
const db={prepare(sql){return{bind(){return this;},async first(){if(sql.includes('FROM supporter_dunning WHERE invoice_id='))return{invoice_id:'in_x'};return null;},async all(){return{results:[]};},async run(){return{meta:{changes:1}};}};}};

test('支払い方法は顧客・旧source・契約のいずれかで判定する',()=>{
 assert.equal(paymentMethodRegistered({},{}),false);
 assert.equal(paymentMethodRegistered({invoice_settings:{default_payment_method:'pm_x'}},{}),true);
 assert.equal(paymentMethodRegistered({default_source:'card_x'},{}),true);
 assert.equal(paymentMethodRegistered({}, {default_payment_method:'pm_sub'}),true);
});

test('未払い請求をクレジットで支払い、再実行で二重に引かない',async t=>{
 let paid=false;const transactions=[],posts=[];
 const invoice=()=>({livemode:false,id:'in_x',status:paid?'paid':'open',customer:'cus_x',subscription:'sub_x',amount_remaining:paid?0:300,amount_paid:paid?300:0,currency:'jpy'});
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,init={})=>{
  const path=new URL(url).pathname,method=init.method||'GET',params=new URLSearchParams(init.body||'');
  if(path==='/v1/invoices/in_x'&&method==='GET')return Response.json(invoice());
  if(path==='/v1/customers/cus_x/balance_transactions'&&method==='GET')return Response.json({livemode:false,data:transactions,has_more:false});
  if(path==='/v1/customers/cus_x'&&method==='GET')return Response.json({livemode:false,balance:paid?-200:-500});
  if(path==='/v1/customers/cus_x/balance_transactions'&&method==='POST'){
   posts.push(Number(params.get('amount')));const tx={livemode:false,id:'cbtxn_x',amount:Number(params.get('amount')),ending_balance:-200,metadata:{dpi_credit_invoice:params.get('metadata[dpi_credit_invoice]')}};transactions.push(tx);return Response.json(tx);
  }
  if(path==='/v1/invoices/in_x/pay'&&method==='POST'){paid=true;return Response.json(invoice());}
  throw new Error(`unexpected ${method} ${path}`);
 };
 const first=await payInvoiceWithCredits(env,db,'cus_x','user_x','in_x');
 const second=await payInvoiceWithCredits(env,db,'cus_x','user_x','in_x');
 assert.equal(first.amount,300);assert.equal(second.alreadyPaid,true);assert.deepEqual(posts,[300]);
});

// 実際の DB と、状態を持つ Stripe の代わりで、途中の失敗を確かめる。
import {readdir,readFile} from 'node:fs/promises';
import {billingAction,runSupporterBillingSchedule} from '../worker/supporter-billing.js';
const USER='123456789012345678',CUS='cus_credit';
async function store(t){
 let DatabaseSync;try{({DatabaseSync}=await import('node:sqlite'));}catch{t.skip('node:sqlite is not available');return null;}
 const raw=new DatabaseSync(':memory:'),dir=new URL('../migrations/',import.meta.url);
 for(const file of (await readdir(dir)).filter(name=>name.endsWith('.sql')).sort())raw.exec(await readFile(new URL(file,dir),'utf8'));
 const statement=(sql,values=[])=>({bind(...input){return statement(sql,input);},async first(){return raw.prepare(sql).get(...values)??null;},async all(){return{results:raw.prepare(sql).all(...values)};},async run(){return{meta:{changes:Number(raw.prepare(sql).run(...values).changes)}};}});
 raw.prepare('INSERT INTO supporter_accounts(discord_user_id,billing_email,registered_at,updated_at) VALUES(?,?,?,?)').run(USER,'user@example.jp','x','x');
 raw.prepare('INSERT INTO supporter_billing(discord_user_id,customer_id) VALUES(?,?)').run(USER,CUS);
 return{raw,db:{prepare:sql=>statement(sql),async batch(items){const out=[];for(const item of items)out.push(await item.run());return out;}}};
}
function fakeStripe(t,{balance=-500,pay='ok'}={}){
 const state={balance,pay,paid:false,transactions:[],cardPays:0,keys:new Map()},original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const invoice=()=>({livemode:false,id:'in_x',object:'invoice',status:state.paid?'paid':'open',customer:CUS,subscription:'sub_x',billing_reason:'subscription_cycle',amount_due:300,total:300,amount_remaining:state.paid?0:300,amount_paid:state.paid?300:0,currency:'jpy',created:1});
 globalThis.fetch=async(url,init={})=>{
  const target=new URL(url),path=target.pathname.replace('/v1/',''),method=init.method||'GET',params=new URLSearchParams(init.body||''),key=init.headers?.['Idempotency-Key'];
  if(path==='invoices/in_x'&&method==='GET')return Response.json(invoice());
  if(path===`customers/${CUS}`)return Response.json({livemode:false,id:CUS,balance:state.balance,invoice_settings:{}});
  if(path===`customers/${CUS}/balance_transactions`){
   if(method==='GET')return Response.json({livemode:false,data:state.transactions,has_more:false});
   if(state.keys.has(key))return Response.json(state.keys.get(key));
   const amount=Number(params.get('amount'));state.balance+=amount;
   const transaction={livemode:false,id:`cbtxn_${state.transactions.length}`,amount,ending_balance:state.balance,metadata:{dpi_credit_invoice:params.get('metadata[dpi_credit_invoice]')}};
   state.transactions.push(transaction);state.keys.set(key,transaction);return Response.json(transaction);
  }
  if(path==='invoices/in_x/pay'){
   if(params.get('paid_out_of_band')!=='true'){state.cardPays+=1;state.paid=true;return Response.json(invoice());}
   if(state.pay==='refused')return Response.json({error:{code:'x',message:'refused'}},{status:400});
   if(state.pay==='timeout')throw new DOMException('timeout','TimeoutError');
   if(state.pay==='late'){state.paid=true;return Response.json({error:{message:'x'}},{status:500});}
   state.paid=true;return Response.json(invoice());
  }
  return Response.json({livemode:false,data:[],has_more:false});
 };
 return state;
}
const fullEnv=db=>({...env,REUSE_DB:db,SUPPORTER_PUBLIC_ORIGIN:'https://dpi-bot.com',SUPPORTER_PUBLIC_ENABLED:'true'});
const dunning=(raw,status='retry_scheduled',retryAt=1)=>raw.prepare(`INSERT INTO supporter_dunning(invoice_id,customer_id,subscription_id,amount_due,currency,status,initial_failed_at,retry_at,suspend_at,updated_at) VALUES('in_x',?,'sub_x',300,'jpy',?,1,?,4000000000,1)`).run(CUS,status,retryAt);

test('支払いが断られたときだけクレジットを戻し、結果が不明なら戻さず、次の実行で引き落とさずに続ける',async t=>{
 const s=await store(t);if(!s)return;dunning(s.raw);const state=fakeStripe(t,{pay:'refused'}),environment=fullEnv(s.db),pay=()=>payInvoiceWithCredits(environment,s.db,CUS,USER,'in_x');
 await assert.rejects(pay);assert.equal(state.balance,-500,'断られたのに戻していない');
 state.pay='timeout';await assert.rejects(pay);assert.equal(state.balance,-200,'結果が不明なのに戻した');
 state.pay='ok';const result=await pay();assert.equal(result.invoice.status,'paid');assert.equal(state.balance,-200,'二重に引いた');
 await pay();assert.equal(state.balance,-200);
 assert.equal(s.raw.prepare("SELECT COUNT(*) n FROM supporter_credit_events WHERE reason='invoice_payment'").get().n,1);
 assert.equal(s.raw.prepare("SELECT status FROM supporter_dunning WHERE invoice_id='in_x'").get().status,'paid');
});

test('応答は失敗でも成立していれば成功にし、同時に2回実行しても1回だけ引く。残高不足・他人の請求は拒む',async t=>{
 const s=await store(t);if(!s)return;dunning(s.raw);let state=fakeStripe(t,{pay:'late'});const environment=fullEnv(s.db),pay=(customer=CUS)=>payInvoiceWithCredits(environment,s.db,customer,USER,'in_x');
 assert.equal((await pay()).invoice.status,'paid');assert.equal(state.balance,-200);
 state=fakeStripe(t,{});const both=await Promise.all([pay(),pay()]);assert.ok(both.every(item=>item.invoice.status==='paid'));assert.equal(state.balance,-200);
 state=fakeStripe(t,{balance:-299});await assert.rejects(pay,error=>error.status===409);assert.equal(state.balance,-299);
 await assert.rejects(()=>pay('cus_other'),error=>error.status===403);
});

test('再請求は、残高が足りればクレジット、足りなければカード。引き落とし済みで結果が不明ならカードに課金しない',async t=>{
 const now=Date.UTC(2026,10,30,3,0,0);
 for(const [balance,pay,card,left,status] of [[-500,'ok',0,-200,'paid'],[-299,'ok',1,-299,'paid'],[-500,'timeout',0,-200,'retry_scheduled']]){
  const s=await store(t);if(!s)return;dunning(s.raw);const state=fakeStripe(t,{balance,pay});
  await runSupporterBillingSchedule(fullEnv(s.db),now);
  assert.equal(state.cardPays,card,`${balance} ${pay}`);assert.equal(state.balance,left);
  assert.equal(s.raw.prepare("SELECT status FROM supporter_dunning WHERE invoice_id='in_x'").get().status,status);
  if(pay==='timeout'){state.pay='ok';await runSupporterBillingSchedule(fullEnv(s.db),now+12*3600000);assert.equal(state.cardPays,0,'引き落とし後にカードへ課金した');assert.equal(state.balance,-200);assert.equal(state.paid,true);}
 }
});

test('画面から未払いをクレジットで支払う。金額の変化・残高不足・BANは拒み、引き落とし済みの続きは残高が無くても払える',async t=>{
 const s=await store(t);if(!s)return;dunning(s.raw);const state=fakeStripe(t,{pay:'timeout'}),environment=fullEnv(s.db),id='00000000-0000-4000-8000-000000000001';
 const act=(expectedTotal,requestId=id)=>billingAction(new Request('https://dpi-bot.com/api/supporter/billing/pay-unpaid'),environment,s.db,USER,{requestId,expectedTotal,legalConsentVersion:'x'});
 assert.equal((await act(299)).status,409);assert.equal((await act(300,'x')).status,400);assert.equal(state.balance,-500);
 const first=await act(300);assert.equal((await first.json()).complete,false);assert.equal(state.balance,-200);
 state.pay='ok';const second=await act(300),body=await second.json();assert.equal(second.status,200);assert.equal(body.complete,true);assert.equal(body.paidCount,1);assert.equal(state.balance,-200);
 s.raw.prepare("UPDATE supporter_accounts SET account_status='suspended'").run();assert.equal((await act(300)).status,403);
});
