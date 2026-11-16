import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeSupporterRules,RAIN_RADAR_THRESHOLD_OPTIONS,RAIN_RADAR_CONDITIONS} from '../worker/supporter.js';
import {buildSupporterSnapshot} from '../worker/supporter-snapshot.js';

const guild='12345678901234567',channel='98765432109876543',guilds=[{id:guild,name:'test'}];
const basic={servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false,rainfallThreshold:false};
const plus={...basic,rainfallThreshold:true};
const rule={name:'雨量監視',guildId:guild,channelId:channel,channelIds:[channel],type:'rain-radar',region:'hokkaido',radarCondition:'rainfall-threshold',rainfallThresholdMmPerHour:30,deliveryIntervalHours:1};

test('Basic can schedule but cannot newly configure rain detected or rainfall threshold',()=>{
 const scheduled=normalizeSupporterRules([{...rule,radarCondition:'all'}],guilds,basic);
 assert.equal(scheduled[0].radarCondition,'all');
 assert.throws(()=>normalizeSupporterRules([{...rule,radarCondition:'rain-detected'}],guilds,basic),/Plus以上/);
 assert.throws(()=>normalizeSupporterRules([rule],guilds,basic),/Plus以上/);
 const detected=normalizeSupporterRules([{...rule,radarCondition:'rain-detected'}],guilds,plus);
 assert.equal(detected[0].radarCondition,'rain-detected');
});

test('JMA-derived categories 10/20/30/50/80 are the only new mm/h options',()=>{
 assert.deepEqual(RAIN_RADAR_THRESHOLD_OPTIONS.map(([id])=>Number(id)),[10,20,30,50,80]);
 assert.deepEqual(RAIN_RADAR_CONDITIONS.map(([id])=>id),['all','rain-detected','rainfall-threshold']);
 for(const value of [10,20,30,50,80]){
  assert.equal(normalizeSupporterRules([{...rule,rainfallThresholdMmPerHour:value}],guilds,plus)[0].rainfallThresholdMmPerHour,value);
 }
 for(const value of [0.1,5,15,40,70,100]){
  assert.throws(()=>normalizeSupporterRules([{...rule,rainfallThresholdMmPerHour:value}],guilds,plus),/10・20・30・50・80|最大階級/);
 }
});

test('legacy settings remain unchanged without allowing new legacy values',()=>{
 const legacy={...rule,rainfallThresholdMmPerHour:2.5};
 const kept=normalizeSupporterRules([{...legacy,name:'監視ルール（改名）'}],guilds,plus,null,[legacy]);
 assert.equal(kept[0].rainfallThresholdMmPerHour,2.5);
 const stillStored=normalizeSupporterRules([legacy],guilds,basic,null,[legacy]);
 assert.equal(stillStored[0].radarCondition,'rainfall-threshold');
 assert.equal(stillStored[0].rainfallThresholdMmPerHour,2.5);
 assert.throws(()=>normalizeSupporterRules([{...legacy,rainfallThresholdMmPerHour:7}],guilds,plus,null,[legacy]),/10・20・30・50・80/);
 assert.throws(()=>normalizeSupporterRules([legacy],guilds,plus),/10・20・30・50・80/);
 const differentDestination={...legacy,channelId:'12345098765432100',channelIds:['12345098765432100']};
 assert.throws(()=>normalizeSupporterRules([differentDestination],guilds,plus,null,[legacy]),/10・20・30・50・80/);
});

test('downgraded Basic skips both previously saved conditional modes, without expanding to scheduled notifications',async()=>{
 const rows=[{discord_user_id:'99999999999999999',customer_id:'cus_test',revision:1,settings_json:JSON.stringify({rules:[
   {...rule,radarCondition:'rain-detected',rainfallThresholdMmPerHour:null},
   {...rule,name:'旧降水閾値',rainfallThresholdMmPerHour:2.5},
   {...rule,name:'定時更新',radarCondition:'all',rainfallThresholdMmPerHour:null},
 ]})}];
 const db={prepare:()=>({all:async()=>({results:rows})})};
 const load=planId=>async()=>new Map([['cus_test',[{recognizedPlan:true,status:'active',planId}]]]);
 const onBasic=await buildSupporterSnapshot(db,{},load('supporter'),1800000001000);
 assert.deepEqual(onBasic.rules.map(v=>v.name),['定時更新']);
 const onPlus=await buildSupporterSnapshot(db,{},load('plus'),1800000002000);
 assert.deepEqual(onPlus.rules.map(v=>v.name),['雨量監視','旧降水閾値','定時更新']);
});

test('comparison and client use select controls plus JMA attribution, not free-text mm/h',async()=>{
 const fetch=async p=>readFile(new URL('../'+p,import.meta.url),'utf8');
 const [site,worker,plans]=await Promise.all([fetch('site/supporter/app.js'),fetch('worker/supporter.js'),fetch('site/supporter/plans.html')]);
 assert.match(worker,/rainRadarThresholds:RAIN_RADAR_THRESHOLD_OPTIONS/);
 assert.match(site,/options\.rainRadarThresholds/);
 assert.match(site,/thresholds=\[\.\.\.options\.rainRadarThresholds\]/);
 assert.match(plans,/10・20・30・50・80 mm\/h/);
 assert.match(plans,/気象庁高解像度降水ナウキャスト/);
 assert.match(plans,/降雨検知時に配信<\/th><td>—<\/td>/);
});
