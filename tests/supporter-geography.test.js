import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSupporterRules} from '../worker/supporter.js';
import {PREFECTURES, geographicEntitlements, geographicRuleAllowed} from '../worker/supporter-geo.js';
import {buildSupporterSnapshot} from '../worker/supporter-snapshot.js';
import {readFile} from 'node:fs/promises';

const guilds=[{id:'12345678901234567',name:'DPI-Test'}];
const basic={servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false,prefecture:false,municipality:false,strictMunicipality:false};
const plus={...basic,prefecture:true,municipality:true,rules:15};
const pro={...plus,strictMunicipality:true,complexConditions:true,multiDestination:true,rules:30};
const areas={
 prefectures:PREFECTURES,
 districts:[{code:'0110',name:'石狩地方',prefectureCode:'01'}],
 municipalities:[
  {code:'0110000',name:'札幌市',prefectureCode:'01',districtCode:'0110',districtName:'石狩地方'},
  {code:'0121700',name:'江別市',prefectureCode:'01',districtCode:'0110',districtName:'石狩地方'},
  {code:'0123500',name:'石狩市',prefectureCode:'01',districtCode:'0110',districtName:'石狩地方'},
  {code:'0410000',name:'仙台市',prefectureCode:'04',districtCode:'',districtName:''}
 ]
};
const base={name:'札幌市の気象警報',guildId:guilds[0].id,channelId:'98765432109876543',type:'weather',detail:'heavy-rain-level',region:'hokkaido',prefecture:'01',district:'0110',municipality:'0110000'};

test('Basic cannot save prefecture/city and Plus can select correct JMA locality',()=>{
 assert.throws(()=>normalizeSupporterRules([base],guilds,basic,areas),/Plus/);
 const value=normalizeSupporterRules([base],guilds,plus,areas)[0];
 assert.equal(value.prefecture,'01');
 assert.equal(value.municipality,'0110000');
 assert.deepEqual(value.districtCityCodes,['0110000','0121700','0123500']);
 assert.equal(value.strictMunicipality,false);
});

test('Pro only can select city-only content, and locality validation fails closed',()=>{
 assert.throws(()=>normalizeSupporterRules([{...base,strictMunicipality:true}],guilds,plus,areas),/Pro/);
 assert.equal(normalizeSupporterRules([{...base,strictMunicipality:true}],guilds,pro,areas)[0].strictMunicipality,true);
 assert.throws(()=>normalizeSupporterRules([{...base,municipality:'0410000'}],guilds,pro,areas),/地域コード/);
 assert.throws(()=>normalizeSupporterRules([{...base,region:'tohoku'}],guilds,pro,areas),/地方/);
 assert.throws(()=>normalizeSupporterRules([{...base,municipality:'9999999'}],guilds,pro,areas),/地域コード/);
});

test('Unsupported per-city EEW or per-prefecture regional radar is denied rather than broadening',()=>{
 assert.throws(()=>normalizeSupporterRules([{...base,type:'eew',detail:'warning'}],guilds,pro,areas),/緊急地震速報/);
 assert.throws(()=>normalizeSupporterRules([{...base,type:'rain-radar',detail:'all'}],guilds,pro,areas),/雨雲レーダー/);
});

test('Legacy regional rules remain valid and downgraded geo rules are suspended',()=>{
 const legacy={...base,prefecture:undefined,district:undefined,municipality:undefined,strictMunicipality:undefined};
 assert.equal(normalizeSupporterRules([legacy],guilds,basic)[0].prefecture,'all');
 const subscriptions=[{status:'active',recognizedPlan:true,planId:'supporter'}];
 const rights=geographicEntitlements(subscriptions);
 assert.equal(rights.prefecture,false);
 assert.equal(geographicRuleAllowed({...base,strictMunicipality:true},rights),false);
 assert.equal(geographicRuleAllowed(legacy,rights),true);
});

test('Snapshot does not expand a Pro-only rule after downgrade',async()=>{
 const row={discord_user_id:'99999999999999999',customer_id:'cus123',revision:1,
  settings_json:JSON.stringify({rules:[{...base,channelIds:['98765432109876543'],strictMunicipality:true},
   {...base,prefecture:'all',district:'all',municipality:'all',channelIds:['98765432109876543'],strictMunicipality:false}]})};
 const db={prepare:()=>({all:async()=>({results:[row]})})};
 const loadSubscriptions=async()=>new Map([['cus123',[{status:'active',recognizedPlan:true,planId:'plus'}]]]);
 const snapshot=await buildSupporterSnapshot(db,{},loadSubscriptions,1800000001000);
 assert.equal(snapshot.rules.length,1);
 assert.equal(snapshot.rules[0].prefecture,'all');
 assert.equal(snapshot.schemaVersion,1);
 const proSubscriptions=async()=>new Map([['cus123',[{status:'active',recognizedPlan:true,planId:'pro'}]]]);
 const precise=await buildSupporterSnapshot(db,{},proSubscriptions,1800000002000);
 assert.equal(precise.rules.length,2);
 assert.equal(precise.schemaVersion,2);
});

test('Progressive selectors and analytics view use separate modules',async()=>{
 const user=await readFile(new URL('../site/supporter/app.js',import.meta.url),'utf8');
 const admin=await readFile(new URL('../site/supporter-admin/stats.js',import.meta.url),'utf8');
 assert.match(user,/geoScopeFields/);
 assert.match(user,/Pro版にアップグレード/);
 assert.match(user,/Plus版以上にアップグレード/);
 assert.match(admin,/stats-plans/);
 assert.match(admin,/stats-credits/);
});
