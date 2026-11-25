import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {selection,paidCheckoutSubscriptionParams,creditSignupSubscriptionParams,subscriptionSummary,scheduledChangeSummary} from '../worker/supporter-billing.js';
import {normalizeSupporterRules} from '../worker/supporter.js';
import {buildSupporterSnapshot} from '../worker/supporter-snapshot.js';

const env={STRIPE_PRICE_SUPPORTER:'price_basic',STRIPE_PRICE_PLUS:'price_plus',STRIPE_PRICE_PRO:'price_pro',STRIPE_PRICE_ADDON:'price_addon'};
const guildId='12345678901234567',channelId='98765432109876543';
const rainRule={name:'札幌レーダー',guildId,channelId,channelIds:[channelId],type:'rain-radar',detail:'all',region:'hokkaido',radarCondition:'rainfall-threshold',rainfallThresholdMmPerHour:2,deliveryIntervalHours:1};
const limit={servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false,rainfallThreshold:false};
test('2 servers and 3 rules per 200 JPY pack are priced server-side',()=>{
 const selected=selection({plan:'supporter',channelPacks:1,serverPacks:1,rulePacks:2});
 assert.deepEqual({monthly:selected.monthly,channels:selected.channels,servers:selected.servers,rules:selected.rules,rulePacks:selected.rulePacks},{monthly:1100,channels:5,servers:3,rules:11,rulePacks:2});
 assert.equal(selection({plan:'plus',channelPacks:0,serverPacks:2,rulePacks:1}).monthly,1400);
 assert.equal(selection({plan:'pro'}).rulePacks,0);
 for(const value of [-1,1.5,6,'1'])assert.throws(()=>selection({plan:'pro',rulePacks:value}));
});
test('initial paid and credit-funded subscriptions preserve rule pack metadata and addon quantity',()=>{
 const choice=selection({plan:'plus',channelPacks:1,serverPacks:1,rulePacks:2});
 const credit=creditSignupSubscriptionParams(env,'cus_x','99999999999999999',choice,{anchor:1800000000},'v1','req_x',1799000000);
 assert.equal(credit['items[1][quantity]'],'4');
 assert.equal(credit['metadata[dpi_rule_packs]'],'2');
 const paid=paidCheckoutSubscriptionParams(env,{mode:'payment',payment_status:'paid',customer:'cus_x',metadata:{dpi_checkout_kind:'initial_subscription',dpi_plan:'plus',dpi_channel_packs:'1',dpi_server_packs:'1',dpi_rule_packs:'2',dpi_billing_anchor:'1800000000'}},{payment_method:'pm_x'},1799000000);
 assert.equal(paid['items[1][quantity]'],'4');
 assert.equal(paid['metadata[dpi_rule_packs]'],'2');
});
test('existing Stripe subscriptions with no rule metadata remain recognized and have no added cost',()=>{
 const legacy={status:'active',metadata:{dpi_channel_packs:'1',dpi_server_packs:'1'},items:{data:[
  {quantity:1,price:{id:'price_basic',unit_amount:300,currency:'jpy'}},
  {quantity:2,price:{id:'price_addon',unit_amount:200,currency:'jpy'}},
 ]}};
 const prior=subscriptionSummary(legacy,env);
 assert.equal(prior.recognizedPlan,true);
 assert.equal(prior.amount,700);
 assert.equal(prior.rulePacks,0);
 assert.equal(prior.rules,5);
 assert.equal(prior.servers,3);
 const newer=subscriptionSummary({...legacy,metadata:{dpi_channel_packs:'1',dpi_server_packs:'1',dpi_rule_packs:'2'},items:{data:[legacy.items.data[0],{...legacy.items.data[1],quantity:4}]}},env);
 assert.equal(newer.recognizedPlan,true);
 assert.equal(newer.rulePacks,2);
 assert.equal(newer.rules,11);
 assert.equal(newer.amount,1100);
 const mismatched=subscriptionSummary({...legacy,metadata:{...legacy.metadata,dpi_rule_packs:'2'}},env);
 assert.equal(mismatched.recognizedPlan,false,'Do not grant unbilled rule capacity');
});
test('scheduled change carries the new rule pack quantity',()=>{
 const next=scheduledChangeSummary({phases:[{start_date:1800000000,metadata:{dpi_channel_packs:'1',dpi_server_packs:'1',dpi_rule_packs:'1'},items:[{price:'price_plus',quantity:1},{price:'price_addon',quantity:3}]}]},env,{planId:'plus',channelPacks:1,serverPacks:1,rulePacks:0,nextRenewalAt:1800000000});
 assert.equal(next.rulePacks,1);
 assert.equal(next.monthly,1400);
 assert.equal(next.rules,18);
 assert.equal(next.servers,5);
});
test('Basic cannot request rain radar mm/h threshold; Plus may save it',()=>{
 assert.throws(()=>normalizeSupporterRules([rainRule],[{id:guildId}],limit),/Plus以上/);
 const allowed=normalizeSupporterRules([rainRule],[{id:guildId}],{...limit,rainfallThreshold:true});
 assert.equal(allowed[0].rainfallThresholdMmPerHour,2);
 assert.equal(allowed[0].radarCondition,'rainfall-threshold');
});
test('old Basic rainfall threshold is excluded from active snapshot without widening delivery',async()=>{
 const row={discord_user_id:'99999999999999999',customer_id:'cus_x',revision:1,settings_json:JSON.stringify({rules:[rainRule,{...rainRule,name:'定時更新',radarCondition:'all',rainfallThresholdMmPerHour:null}]})};
 const db={prepare:()=>({all:async()=>({results:[row]})})};
 const loadBasic=async()=>new Map([['cus_x',[{status:'active',recognizedPlan:true,planId:'supporter'}]]]);
 const base=await buildSupporterSnapshot(db,{},loadBasic,1800000001000);
 assert.deepEqual(base.rules.map(rule=>rule.name),['定時更新']);
 const loadPlus=async()=>new Map([['cus_x',[{status:'active',recognizedPlan:true,planId:'plus'}]]]);
 const plus=await buildSupporterSnapshot(db,{},loadPlus,1800000002000);
 assert.deepEqual(plus.rules.map(rule=>rule.name),['札幌レーダー','定時更新']);
});
test('signup migration and both UIs expose the new rule pack',async()=>{
 const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
 const [migration,user,admin,comparison]=await Promise.all([read('migrations/0027_supporter_rule_packs.sql'),read('site/supporter/app.js'),read('site/supporter-admin/index.html'),read('site/supporter/plans.html')]);
 assert.match(migration,/ADD COLUMN rule_packs INTEGER NOT NULL DEFAULT 0/);
 assert.match(user,/RULE_PACK_OPTIONS/);
 assert.match(user,/rulePacks:Number\(rulePacks.value\)/);
 assert.match(admin,/id="change-rule-packs"/);
 assert.match(comparison,/今後も随時追加予定/);
});
