import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSupporterRules} from '../worker/supporter.js';
import {PREFECTURES, geographicEntitlements} from '../worker/supporter-geo.js';
import {estimateCustomMonthly,normalizeCustomPlan,customLocked,customSubscriptionMatches,enrichCustomSubscriptions} from '../worker/supporter-custom.js';
import {buildSupporterSnapshot} from '../worker/supporter-snapshot.js';
import {readFile} from 'node:fs/promises';

const input={name:'協定A',channels:27,servers:7,rules:40,
 complexConditions:true,municipalityBranching:true,contentExtraction:true,
 multiDestination:true,secondaryReuse:false,monthlyYen:2980};

test('custom plan cost estimate is independent of administrator confirmed amount',()=>{
 const plan=normalizeCustomPlan(input);
 assert.equal(plan.monthlyYen,2980);
 assert.equal(plan.estimatedYen,estimateCustomMonthly(input));
 assert.ok(plan.estimatedYen>0);
 assert.throws(()=>normalizeCustomPlan({...input,contentExtraction:true,municipalityBranching:false}),/市区町村/);
 assert.throws(()=>normalizeCustomPlan({...input,channels:201}),/channels/);
 assert.throws(()=>normalizeCustomPlan({...input,monthlyYen:1}),/確定料金/);
});

test('offered plan locks users but never grants paid delivery',()=>{
 const offered={id:'custom-one',revision:3,status:'offered',confirmed_yen:2980,stripe_subscription_id:null};
 assert.equal(customLocked(offered),true);
 assert.equal(customSubscriptionMatches(offered,{status:'active'}),false);
 assert.deepEqual(enrichCustomSubscriptions([{status:'active',planId:'',recognizedPlan:false}],offered),
  [{status:'active',planId:'',recognizedPlan:false}]);
});

test('custom entitlements require exact Stripe subscription id, revision and price',()=>{
 const offer={id:'custom-one',revision:3,status:'active',stripe_subscription_id:'sub_123',
  name:'カスタム',confirmed_yen:2980,channel_limit:27,server_limit:7,rule_limit:40,
  complex_conditions:1,municipality_branching:1,content_extraction:1,multi_destination:1,secondary_reuse:0};
 const paid={subscriptionId:'sub_123',customId:'custom-one',customRevision:3,status:'active',
  amount:2980,currency:'jpy',recognizedPlan:false};
 const eligible=enrichCustomSubscriptions([paid],offer)[0];
 assert.equal(eligible.recognizedPlan,true);
 assert.equal(eligible.planId,'custom');
 assert.equal(eligible.rules,40);
 assert.equal(eligible.contentExtraction,true);
 assert.equal(geographicEntitlements([eligible]).strictMunicipality,true);
 for(const mismatch of [{amount:2981},{customRevision:2},{subscriptionId:'sub_other'},{currency:'usd'},{status:'canceled'},{status:'incomplete'}]){
  assert.equal(customSubscriptionMatches(offer,{...paid,...mismatch}),false);
 }
});

test('EEW final checkbox defaults on and an explicit opt-out survives normalization',()=>{
 const guilds=[{id:'12345678901234567',name:'test'}];
 const limit={servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false,prefecture:false,municipality:false,strictMunicipality:false};
 const rule={name:'EEW',guildId:guilds[0].id,channelId:'98765432109876543',type:'eew',detail:'forecast',region:'all'};
 assert.equal(normalizeSupporterRules([rule],guilds,limit)[0].sendFinalReport,true);
 assert.equal(normalizeSupporterRules([{...rule,sendFinalReport:false}],guilds,limit)[0].sendFinalReport,false);
});

test('EEW opt-out requires snapshot v3 to prevent older local workers ignoring it',async()=>{
 const row={discord_user_id:'99999999999999999',customer_id:'cus1',revision:1,
 settings_json:JSON.stringify({rules:[{name:'EEW',guildId:'12345678901234567',channelIds:['98765432109876543'],
 type:'eew',detail:'forecast',region:'all',sendFinalReport:false}]})};
 const db={prepare:()=>({all:async()=>({results:[row]})})};
 const loader=async()=>new Map([['cus1',[{status:'active',recognizedPlan:true,planId:'plus'}]]]);
 const snapshot=await buildSupporterSnapshot(db,{},loader,1800000000000);
 assert.equal(snapshot.schemaVersion,3);
 assert.equal(snapshot.rules[0].sendFinalReport,false);
});

test('weather options include the missing flood advisory and customer UI checkbox',async()=>{
 const {WEATHER_DETAILS}=await import('../worker/supporter.js');
 assert.equal(WEATHER_DETAILS.some(item=>item[0]==='flood-level'),true);
 const client=await readFile(new URL('../site/supporter/app.js',import.meta.url),'utf8');
 assert.match(client,/最終報を送信する/);
 assert.match(client,/customPlanLocked/);
 const migration=await readFile(new URL('../migrations/0025_supporter_custom_plans.sql',import.meta.url),'utf8');
 assert.match(migration,/stripe_subscription_id/);
 assert.match(migration,/confirmed_yen/);
});
