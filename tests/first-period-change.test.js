import test from 'node:test';
import assert from 'node:assert/strict';
import {initialPeriodCredit,adminBillingAction} from '../worker/supporter-billing.js';

test('最初の更新の前の変更だけ、支払い済みの分を新しいプランの日割りと同じ割合で差し引く',()=>{
 const stub={startedAt:1000,currentPeriodStart:1000},fresh={unusedPlanCredit:0,newPlanCharge:797,net:797};
 assert.equal(initialPeriodCredit(stub,fresh,300,800),299);
 assert.equal(initialPeriodCredit(stub,{unusedPlanCredit:0,newPlanCharge:360,net:360},300,800),135);
 assert.equal(initialPeriodCredit(stub,{unusedPlanCredit:709,newPlanCharge:1134,net:425},800,1280),0); // 2回目の変更は Stripe が差し引く
 assert.equal(initialPeriodCredit({startedAt:1000,currentPeriodStart:90000},fresh,300,800),0); // 最初の更新の後
 for(const [summary,breakdown,oldYen,newYen] of [[{},fresh,300,800],[stub,{unusedPlanCredit:0,newPlanCharge:0,net:0},300,800],[stub,fresh,0,800],[stub,fresh,800,300],[stub,fresh,300,300]])assert.equal(initialPeriodCredit(summary,breakdown,oldYen,newYen),0);
});

test('返金が Stripe の承認待ちになったときは、申請したことを伝える',async t=>{
 const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 const env={SUPPORTER_BILLING_MODE:'test',STRIPE_SECRET_KEY:'rk_test_x',STRIPE_WEBHOOK_SECRET:'whsec_x',STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon',STRIPE_PORTAL_CONFIG:'bpc_x'};
 globalThis.fetch=async url=>{
  const path=new URL(url).pathname.replace('/v1/','');
  if(path==='refunds')return Response.json({error:{message:'This action requires human approval before it can be completed. An approval request has been created and is awaiting review.'}},{status:400});
  if(path==='invoices')return Response.json({livemode:false,data:[{id:'in_1',amount_paid:300,created:1,status_transitions:{paid_at:1},payments:{data:[{payment:{payment_intent:'pi_1'}}]}}]});
  return Response.json({livemode:false,data:[],has_more:false});
 };
 await assert.rejects(()=>adminBillingAction(env,'cus_1','123456789012345678',{action:'refund_latest',amount:300,requestId:'123e4567-e89b-42d3-a456-426614174111',reason:'返金の試験です'}),error=>error.approvalRequired===true&&error.status===409&&/承認すると実行/.test(error.message));
});
