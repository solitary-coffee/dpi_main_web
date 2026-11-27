import test from 'node:test';
import assert from 'node:assert/strict';
import {initialCreditUse,provisionPaidCheckoutSubscription} from '../worker/supporter-billing.js';

test('申込みで先に使う残高: カードの最低額50円を残し、全額払えるときは0（別の流れ）',()=>{
 for(const [credits,total,expected] of [[0,300,0],[-5,300,0],[100,300,100],[249,300,249],[250,300,250],[251,300,250],[299,300,250],[300,300,0],[500,300,0],[1,800,1],[NaN,300,0]])assert.equal(initialCreditUse(credits,total),expected,`${credits}/${total}`);
});

const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_x',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x'};
const session=(applied='200')=>({id:'cs_first',livemode:false,mode:'payment',status:'complete',payment_status:'paid',customer:'cus_first',payment_intent:'pi_first',amount_total:100,currency:'jpy',created:10,metadata:{dpi_checkout_kind:'initial_subscription',dpi_user:'123456789012345678',dpi_plan:'supporter',dpi_channel_packs:'0',dpi_server_packs:'0',dpi_rule_packs:'0',dpi_billing_anchor:String(Math.floor(Date.now()/1000)+10*86400),dpi_credit_applied:applied,dpi_initial_total:'300'}});
function stripe(t,{failSubscription=0}={}){
 const state={transactions:[],subscriptions:[],keys:new Map(),balance:-200,failSubscription},original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async(url,init={})=>{
  const path=new URL(url).pathname.replace('/v1/',''),method=init.method||'GET',params=new URLSearchParams(init.body||''),key=init.headers?.['Idempotency-Key'];
  if(path==='subscriptions'&&method==='GET')return Response.json({livemode:false,data:state.subscriptions});
  if(path==='payment_intents/pi_first')return Response.json({livemode:false,id:'pi_first',status:'succeeded',customer:'cus_first',amount_received:100,payment_method:'pm_x'});
  if(path==='customers/cus_first/balance_transactions'&&method==='GET')return Response.json({livemode:false,data:state.transactions,has_more:false});
  if(path==='customers/cus_first/balance_transactions'){
   if(state.keys.has(key))return Response.json(state.keys.get(key));
   state.balance+=Number(params.get('amount'));const item={livemode:false,id:'cbtxn',amount:Number(params.get('amount')),ending_balance:state.balance,metadata:{dpi_initial_credit_session:params.get('metadata[dpi_initial_credit_session]')}};
   state.transactions.push(item);state.keys.set(key,item);return Response.json(item);
  }
  if(path==='subscriptions'&&method==='POST'){if(state.failSubscription-->0)return Response.json({error:{message:'x'}},{status:500});const item={livemode:false,id:'sub_first',status:'active',customer:'cus_first',created:20,metadata:{dpi_initial_session:params.get('metadata[dpi_initial_session]')}};state.subscriptions=[item];return Response.json(item);}
  throw new Error(`unexpected ${method} ${path}`);
 };
 return state;
}
test('契約の作成が失敗しても、残高は1回だけ引き、やり直しで契約を作る',async t=>{
 const state=stripe(t,{failSubscription:1});
 await assert.rejects(()=>provisionPaidCheckoutSubscription(env,session()));assert.equal(state.balance,0);
 state.keys.clear(); // 冪等キーの期限（24時間）が切れた後でも、記録を見て二重に引かない
 assert.equal((await provisionPaidCheckoutSubscription(env,session())).id,'sub_first');assert.equal(state.balance,0);assert.equal(state.transactions.length,1);
 await provisionPaidCheckoutSubscription(env,session());assert.equal(state.transactions.length,1);
});
test('同時に届いても1回だけ引き、不正な残高充当額では契約を作らない',async t=>{
 let state=stripe(t);await Promise.all([provisionPaidCheckoutSubscription(env,session()),provisionPaidCheckoutSubscription(env,session())]);assert.equal(state.balance,0);
 for(const value of ['0','','-100','1.5','abc']){state=stripe(t);await assert.rejects(()=>provisionPaidCheckoutSubscription(env,session(value)),error=>error.status===409);assert.equal(state.balance,-200,value);assert.equal(state.transactions.length,0);}
});
