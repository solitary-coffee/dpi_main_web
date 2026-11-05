import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSupporterRules, SUPPORTER_REGIONS, WEATHER_LEVELS, WEATHER_DETAILS, EARTHQUAKE_DETAILS, EEW_DETAILS, EEW_WARNING_AREA_MODES, THRESHOLD_MODES } from '../worker/supporter.js';
import { reconcileRulesForLimits } from '../worker/supporter-billing.js';

const guilds = [{id:'12345678901234567',name:'DPI Test'}];
const base = {name:'北海道の大雨',guildId:guilds[0].id,channelId:'98765432109876543',type:'weather',region:'hokkaido'};

test('地方区分、警戒レベル、詳細情報種別を提供する', () => {
 assert.deepEqual(SUPPORTER_REGIONS.map(([id])=>id), [
  'all','hokkaido','tohoku','kanto-koshin','hokuriku','tokai','kinki','chugoku','shikoku','kyushu-north','kyushu-south-amami','okinawa',
 ]);
 assert.deepEqual(WEATHER_LEVELS.map(([id])=>id), ['all','1','2','3','4','5']);
 assert.ok(WEATHER_DETAILS.some(([id])=>id==='heavy-rain-level'));
 assert.ok(WEATHER_DETAILS.some(([id])=>id==='landslide-level'));
 assert.ok(EARTHQUAKE_DETAILS.some(([id])=>id==='intensity-flash'));
 assert.ok(EEW_DETAILS.some(([id])=>id==='forecast'));
 assert.ok(EEW_DETAILS.some(([id])=>id==='warning'));
 assert.ok(!EEW_DETAILS.some(([id])=>id==='intensity-change'));
 assert.deepEqual(EEW_WARNING_AREA_MODES.map(([id])=>id),['all','target-only']);
 assert.deepEqual(THRESHOLD_MODES.map(([id])=>id),['all','increase','threshold']);
});

test('緊急地震速報の警報だけ対象警報地方条件を保存する', () => {
 const warning=normalizeSupporterRules([{...base,type:'eew',detail:'warning',intensity:'4',eewWarningAreaMode:'target-only'}],guilds)[0];
 assert.equal(warning.eewWarningAreaMode,'target-only');
 const forecast=normalizeSupporterRules([{...base,type:'eew',detail:'forecast',intensity:'4',eewWarningAreaMode:'target-only'}],guilds)[0];
 assert.equal(forecast.eewWarningAreaMode,'');
});

test('旧震度変化設定は地震動予報へ移行する', () => {
 const normalized=normalizeSupporterRules([{...base,type:'eew',detail:'intensity-change',intensity:'4'}],guilds)[0];
 assert.equal(normalized.detail,'forecast');
});

test('大雨ルールは地方と警戒レベルを正規化して保存する', () => {
 const normalized=normalizeSupporterRules([{...base,detail:'heavy-rain-level',weatherLevel:'3'}],guilds)[0];
 assert.equal(normalized.detail,'heavy-rain-level');
 assert.equal(normalized.weatherLevel,'3');
 assert.equal(normalized.warningLevel,'');
 assert.equal(normalized.intensity,'');
});

test('警報・注意報系だけ警報条件を保存する', () => {
 const normalized=normalizeSupporterRules([{...base,detail:'wave-warning',warningLevel:'warning'}],guilds)[0];
 assert.equal(normalized.warningLevel,'warning');
 assert.equal(normalized.weatherLevel,'');
});

test('既存ルールは詳細未設定ならすべてとして扱う', () => {
 const normalized=normalizeSupporterRules([base],guilds)[0];
 assert.equal(normalized.detail,'all');
 assert.equal(normalized.weatherLevel,'');
});

test('地震ルールは閾値選択時だけ震度とマグニチュード下限を保持する', () => {
 const rule={...base,type:'earthquake',name:'関東の地震',detail:'intensity-flash',region:'kanto-koshin',intensityMode:'threshold',intensity:'5-',magnitudeMode:'threshold',magnitudeMin:'5.2'};
 const normalized=normalizeSupporterRules([rule],guilds)[0];
 assert.equal(normalized.intensityMode,'threshold');
 assert.equal(normalized.intensity,'5-');
 assert.equal(normalized.magnitudeMode,'threshold');
 assert.equal(normalized.magnitudeMin,5.2);
 assert.equal('magnitudeMax' in normalized,false);
 assert.equal(normalized.weatherLevel,'');
});

test('すべて・上昇時のみでは閾値を保存しない', () => {
 const normalized=normalizeSupporterRules([{...base,type:'earthquake',intensityMode:'all',intensity:'7',magnitudeMode:'increase',magnitudeMin:'9'}],guilds)[0];
 assert.equal(normalized.intensity,'');
 assert.equal(normalized.magnitudeMin,null);
});

test('不正な詳細条件、範囲、地方、サーバーを拒否する', () => {
 assert.throws(()=>normalizeSupporterRules([{...base,region:'unknown'}],guilds));
 assert.throws(()=>normalizeSupporterRules([{...base,detail:'heavy-rain-level',weatherLevel:'6'}],guilds));
 assert.throws(()=>normalizeSupporterRules([{...base,detail:'not-defined'}],guilds));
 assert.throws(()=>normalizeSupporterRules([{...base,type:'earthquake',intensityMode:'threshold',intensity:'',magnitudeMode:'all'}],guilds));
 assert.throws(()=>normalizeSupporterRules([{...base,type:'earthquake',intensityMode:'all',magnitudeMode:'threshold',magnitudeMin:11}],guilds));
 assert.throws(()=>normalizeSupporterRules([{...base,type:'eew',detail:'warning',intensity:'4',eewWarningAreaMode:'unknown'}],guilds));
 assert.throws(()=>normalizeSupporterRules([{...base,guildId:'11111111111111111'}],guilds));
});

test('BASICの通知ルールは1つのDiscordサーバーだけに限定する', () => {
 const second={id:'22222222222222222',name:'Second Server'};
 const rules=[
  {...base,detail:'heavy-rain-level'},
  {...base,name:'東北の大雨',guildId:second.id,channelId:'87654321098765432',detail:'heavy-rain-level',region:'tohoku'},
 ];
 assert.throws(()=>normalizeSupporterRules(rules,[...guilds,second]),/1サーバー/);
 assert.equal(normalizeSupporterRules(rules,[...guilds,second],{servers:2,channels:2}).length,2);
});

test('PROだけOR条件と複数配信先を保存できる',()=>{
 const proRule={...base,channelIds:['98765432109876543','87654321098765432'],conditionLogic:'or',conditions:[{kind:'region',value:'tohoku'},{kind:'weatherLevel',value:'4'}]};
 assert.throws(()=>normalizeSupporterRules([proRule],guilds,{servers:1,channels:10,rules:15,complexConditions:false,multiDestination:false}),/PROプラン/);
 const normalized=normalizeSupporterRules([proRule],guilds,{servers:5,channels:20,rules:30,complexConditions:true,multiDestination:true})[0];
 assert.deepEqual(normalized.channelIds,proRule.channelIds);
 assert.equal(normalized.channelId,proRule.channelIds[0]);
 assert.equal(normalized.conditionLogic,'or');
 assert.deepEqual(normalized.conditions,[{kind:'region',operator:'equals',value:'tohoku'},{kind:'weatherLevel',operator:'equals',value:'4'}]);
 assert.throws(()=>normalizeSupporterRules([{...proRule,conditions:Array.from({length:9},()=>({kind:'region',value:'tohoku'}))}],guilds,{servers:5,channels:20,rules:30,complexConditions:true,multiDestination:true}),/8件まで/);
});

test('ダウングレード確定時は上からルールを残して下側から削除する',()=>{
 const rules=Array.from({length:8},(_,index)=>({...base,name:`ルール${index+1}`,channelId:`9876543210987654${index}`,channelIds:[`9876543210987654${index}`]}));
 const result=reconcileRulesForLimits(JSON.stringify({rules,display:'keep'}),{servers:1,channels:10,rules:5,complexConditions:false,multiDestination:false});
 assert.equal(result.changed,true);assert.equal(result.removedRules,3);assert.deepEqual(result.rules.map(rule=>rule.name),['ルール1','ルール2','ルール3','ルール4','ルール5']);
 assert.equal(JSON.parse(result.settingsJson).display,'keep');
});

test('PROから下位プランへの変更は複数配信先とOR条件を安全に整理する',()=>{
 const rule={...base,channelIds:['98765432109876543','87654321098765432'],conditionLogic:'or',conditions:[{kind:'region',operator:'equals',value:'tohoku'}]};
 const result=reconcileRulesForLimits(JSON.stringify({rules:[rule]}),{servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false});
 assert.equal(result.removedRules,0);assert.equal(result.removedDestinations,1);assert.equal(result.simplifiedRules,1);
 assert.deepEqual(result.rules[0].channelIds,['98765432109876543']);assert.equal(result.rules[0].conditionLogic,'and');assert.deepEqual(result.rules[0].conditions,[]);
});

test('サーバー・チャンネル上限超過でも上側の設定を優先する',()=>{
 const rules=[
  {...base,name:'残す1',channelIds:['98765432109876543']},
  {...base,name:'残す2',channelId:'87654321098765432',channelIds:['87654321098765432']},
  {...base,name:'チャンネル超過',channelId:'76543210987654321',channelIds:['76543210987654321']},
  {...base,name:'サーバー超過',guildId:'22222222222222222',channelId:'65432109876543210',channelIds:['65432109876543210']},
 ];
 const result=reconcileRulesForLimits(JSON.stringify({rules}),{servers:1,channels:2,rules:15,complexConditions:false,multiDestination:false});
 assert.deepEqual(result.rules.map(rule=>rule.name),['残す1','残す2']);assert.equal(result.removedRules,2);
});

test('壊れた設定JSONは自動削除せず調査可能な状態を保つ',()=>{
 const result=reconcileRulesForLimits('<invalid>',{servers:1,channels:2,rules:5});
 assert.equal(result.changed,false);assert.equal(result.invalidSettings,true);assert.equal(result.settingsJson,'<invalid>');
});
