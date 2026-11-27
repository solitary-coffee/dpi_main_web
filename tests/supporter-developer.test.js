import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { developerLimits, developerSubscriptionSummary, isSupporterDeveloper, supporterDeveloperIds } from '../worker/supporter-developer.js';
import { normalizeSupporterRules, supporterAdminAccount, supporterAdminDetails, supporterLimits, supporterTestUserAllowed } from '../worker/supporter.js';
import { buildSupporterSnapshot } from '../worker/supporter-snapshot.js';
import { FEATURE_NAMES, planFeatures } from '../site/supporter/plan-features.js';

const DEVELOPER_ID='12345678901234567';
const OTHER_ID='22345678901234567';
const CHANNEL_ID='32345678901234567';

test('開発者IDは空白を除去し、17〜20桁の数字だけを重複なく解釈する',()=>{
 const env={SUPPORTER_DEVELOPER_IDS:` , ${DEVELOPER_ID},abc,1234567890123456,123456789012345678901, ${DEVELOPER_ID} `};
 assert.deepEqual(supporterDeveloperIds(env),[DEVELOPER_ID]);
 assert.equal(isSupporterDeveloper(env,DEVELOPER_ID),true);
 assert.equal(isSupporterDeveloper(env,OTHER_ID),false);
 assert.deepEqual(supporterDeveloperIds({SUPPORTER_DEVELOPER_IDS:'   '}),[]);
 assert.equal(supporterTestUserAllowed(env,DEVELOPER_ID),true);
});

test('開発者は現行の全機能を持ち、契約照会やStripe通信を行わない',async t=>{
 const originalFetch=globalThis.fetch;
 t.after(()=>{globalThis.fetch=originalFetch;});
 let fetchCalls=0,dbCalls=0;
 globalThis.fetch=async()=>{fetchCalls+=1;throw new Error('外部通信してはいけません');};
 const limits=await supporterLimits({SUPPORTER_DEVELOPER_IDS:DEVELOPER_ID},{prepare(){dbCalls+=1;throw new Error('DB契約照会してはいけません');}},DEVELOPER_ID);
 assert.equal(limits.unlimited,true);
 assert.equal(limits.rules,Infinity);
 assert.equal(limits.servers,Infinity);
 assert.equal(limits.channels,Infinity);
 assert.ok(FEATURE_NAMES.every(name=>limits[name]===true));
 const summary=developerSubscriptionSummary();
 assert.equal(summary.plan,'開発者（無料）');
 assert.ok(FEATURE_NAMES.every(name=>planFeatures([summary])[name]===true));
 assert.equal(fetchCalls,0);
 assert.equal(dbCalls,0);
});

test('開発者はルール・サーバー・チャンネルの合計上限なし、通常利用者は従来どおり',()=>{
 const guilds=Array.from({length:6},(_,index)=>({id:String(40000000000000000n+BigInt(index))}));
 const rules=guilds.map((guild,index)=>({name:`ルール${index}`,guildId:guild.id,channelId:String(50000000000000000n+BigInt(index)),type:'earthquake',detail:'all',region:'all'}));
 assert.equal(normalizeSupporterRules(rules,guilds,developerLimits()).length,6);
 assert.throws(()=>normalizeSupporterRules(rules,guilds,{servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false}),/5件まで/);
});

test('開発者のルールは契約とテスト公開許可リストなしで配信データに含まれる',async()=>{
 let subscriptionCalls=0,auditCalls=0;
 const row={discord_user_id:DEVELOPER_ID,customer_id:null,revision:2,settings_json:JSON.stringify({rules:[{name:'地震',guildId:OTHER_ID,channelId:CHANNEL_ID,channelIds:[CHANNEL_ID],type:'earthquake',detail:'all',region:'all',conditionLogic:'and',conditions:[]}]})};
 const db={prepare(sql){
  let values=[];
  return {bind(...input){values=input;return this;},async all(){
   if(sql.includes('supporter_custom_plans'))return{results:[]};
   assert.deepEqual(values,[DEVELOPER_ID]);
   return{results:[row]};
  },async run(){if(sql.includes('admin_audit_events'))auditCalls+=1;return{meta:{changes:1}};}};
 }};
 const snapshot=await buildSupporterSnapshot(db,{SUPPORTER_DEVELOPER_IDS:DEVELOPER_ID,SUPPORTER_PUBLIC_ENABLED:'false',SUPPORTER_PREVIEW_OPEN:'false'},async(_env,customerIds)=>{
  subscriptionCalls+=1;assert.deepEqual(customerIds,[]);return new Map();
 },1_800_000_000_000);
 assert.equal(snapshot.rules.length,1);
 assert.equal(snapshot.rules[0].type,'earthquake');
 assert.equal(subscriptionCalls,1);
 assert.equal(auditCalls,1);
});

test('利用者画面と管理画面は開発者（無料）を表示し、課金操作を隠す',async()=>{
 const account=supporterAdminAccount({discord_user_id:DEVELOPER_ID,settings_json:'{"rules":[]}'},[developerSubscriptionSummary()],'',0,null,null,true);
 const details=supporterAdminDetails({discord_user_id:DEVELOPER_ID,settings_json:'{"rules":[]}',developer:true});
 assert.equal(account.developer,true);
 assert.equal(details.developer,true);
 const [userUi,adminUi]=await Promise.all([readFile(new URL('../site/supporter/app.js',import.meta.url),'utf8'),readFile(new URL('../site/supporter-admin/app.js',import.meta.url),'utf8')]);
 assert.match(userUi,/開発者（無料）として全機能/);
 assert.match(userUi,/checkoutButton\.hidden=developerMode/);
 assert.match(userUi,/topupButton\.hidden=true/);
 assert.match(adminUi,/開発者・無料/);
 assert.match(adminUi,/開発者（無料）・全機能・上限なし/);
});
