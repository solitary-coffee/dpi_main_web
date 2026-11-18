import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeSupporterRules, supporterOptions, supporterAdminDetails} from '../worker/supporter.js';
import {geographicEntitlements} from '../worker/supporter-geo.js';
import {planFeatures} from '../site/supporter/plan-features.js';
import {WEATHER_MAP_PRODUCTS, WEATHER_MAP_DEFAULT_PRODUCTS, imageRuleSnapshotFields} from '../worker/supporter-image-rules.js';

const guilds=[{id:'12345678901234567',name:'DPI Test'}];
const CHANNEL='98765432109876543';
const active=planId=>({status:'active',recognizedPlan:true,planId});
const limitsFor=(...subscriptions)=>({servers:5,channels:20,rules:30,complexConditions:false,multiDestination:false,...planFeatures(subscriptions),...geographicEntitlements(subscriptions)});
const ENABLED={imageRules:true};
const catalogue={prefectures:[],districts:[],municipalities:[]};
const weather=products=>({name:'気象',guildId:guilds[0].id,channelId:CHANNEL,channelIds:[CHANNEL],type:'weather-map',region:'kanto-koshin',products,minSeverity:'warning'});
const EXTRA=['VPWW61','VPHW50','VPBS50'];

test('weather-map offers VPWW61 / VPHW50 / VPBS50 after VPWW55-60 with Japanese labels',()=>{
 assert.deepEqual(WEATHER_MAP_PRODUCTS.map(([id])=>id),['VPWW55','VPWW56','VPWW57','VPWW58','VPWW59','VPWW60',...EXTRA]);
 const labels=Object.fromEntries(WEATHER_MAP_PRODUCTS);
 assert.equal(labels.VPWW61,'その他注意報（一覧表）');
 assert.equal(labels.VPHW50,'竜巻注意情報（気象防災速報）');
 assert.equal(labels.VPBS50,'線状降水帯（発生・直前予測）');
 const options=supporterOptions({SUPPORTER_IMAGE_RULES_ENABLED:'1'});
 assert.deepEqual(options.weatherMapProducts,WEATHER_MAP_PRODUCTS);
 assert.deepEqual(options.weatherMapDefaultProducts,WEATHER_MAP_DEFAULT_PRODUCTS);
});

test('Plus and Pro accept the new weather-map products and keep catalogue order',()=>{
 for(const plan of ['plus','pro']){
  const [w]=normalizeSupporterRules([weather(['VPBS50','VPWW55','VPHW50','VPWW61'])],guilds,limitsFor(active(plan)),catalogue,ENABLED);
  assert.deepEqual(w.products,['VPWW55','VPWW61','VPHW50','VPBS50']);
  for(const id of EXTRA)assert.deepEqual(normalizeSupporterRules([weather([id])],guilds,limitsFor(active(plan)),catalogue,ENABLED)[0].products,[id]);
 }
 // Basic still cannot save any image rule.
 assert.throws(()=>normalizeSupporterRules([weather(['VPWW61'])],guilds,limitsFor(active('supporter')),catalogue,ENABLED),/Plus以上/);
});

test('unknown weather-map products are rejected, not dropped',()=>{
 const limits=limitsFor(active('pro'));
 for(const products of [['VPHW51'],['VPWW62'],['VPWW55','VPBS51'],['vpww61'],[]])
  assert.throws(()=>normalizeSupporterRules([weather(products)],guilds,limits,catalogue,ENABLED),/1つ以上選択/);
});

test('snapshot sends the new products for Plus, and never adds them to rules without them',()=>{
 const plus=planFeatures([active('plus')]);
 assert.deepEqual(imageRuleSnapshotFields(weather(['VPWW55',...EXTRA]),plus,'plus').products,['VPWW55',...EXTRA]);
 assert.deepEqual(imageRuleSnapshotFields(weather(['VPWW55','VPWW58']),plus,'plus').products,['VPWW55','VPWW58']);
 assert.deepEqual(imageRuleSnapshotFields(weather(['VPWW55','VPWWXX']),plus,'plus').products,['VPWW55']);
 assert.equal(imageRuleSnapshotFields(weather(['VPWW61']),planFeatures([active('supporter')]),'supporter'),null);
});

test('default selection stays VPWW55-60 on the server and in the dashboard',async()=>{
 assert.deepEqual([...WEATHER_MAP_DEFAULT_PRODUCTS],['VPWW55','VPWW56','VPWW57','VPWW58','VPWW59','VPWW60']);
 for(const id of EXTRA)assert.equal(WEATHER_MAP_DEFAULT_PRODUCTS.includes(id),false);
 const source=await readFile(new URL('../site/supporter/app.js',import.meta.url),'utf8');
 assert.match(source,/const WEATHER_MAP_DEFAULT_PRODUCT_IDS = \['VPWW55','VPWW56','VPWW57','VPWW58','VPWW59','VPWW60'\];/);
 assert.match(source,/const WEATHER_MAP_PRODUCT_IDS = \[\.\.\.WEATHER_MAP_DEFAULT_PRODUCT_IDS,'VPWW61','VPHW50','VPBS50'\];/);
 assert.match(source,/:\[\.\.\.WEATHER_MAP_DEFAULT_PRODUCT_IDS\]/);
 assert.match(source,/その他注意報は一覧表、竜巻注意情報と線状降水帯は図で配信します/);
});

test('admin details label the new products',()=>{
 const details=supporterAdminDetails({discord_user_id:'1',settings_json:JSON.stringify({rules:[weather(EXTRA)]}),guilds_json:'[]'});
 const w=Object.fromEntries(details.rules[0].details.map(item=>[item.label,item.value]));
 assert.equal(w['対象の警報・注意報'],'その他注意報（一覧表）、竜巻注意情報（気象防災速報）、線状降水帯（発生・直前予測）');
});
