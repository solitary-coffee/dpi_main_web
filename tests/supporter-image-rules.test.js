import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeSupporterRules, supporterOptions, supporterAdminDetails} from '../worker/supporter.js';
import {buildSupporterSnapshot} from '../worker/supporter-snapshot.js';
import {PLAN_CATALOG, publicPlans} from '../worker/supporter-billing.js';
import {geographicEntitlements} from '../worker/supporter-geo.js';
import {PLAN_FEATURES, FEATURE_NAMES, planFeatures, hasFeature, imageTier} from '../site/supporter/plan-features.js';
import {imageRulesEnabled} from '../worker/supporter-image-rules.js';

const guilds=[{id:'12345678901234567',name:'DPI Test'}];
const CHANNEL='98765432109876543';
const active=planId=>({status:'active',recognizedPlan:true,planId});
const custom=(extra={})=>({status:'active',recognizedPlan:true,planId:'custom',managedCustom:true,municipalityBranching:false,contentExtraction:false,...extra});
const limitsFor=(...subscriptions)=>({servers:5,channels:20,rules:30,complexConditions:false,multiDestination:false,...planFeatures(subscriptions),...geographicEntitlements(subscriptions)});
const ENABLED={imageRules:true};
const base={name:'画像',guildId:guilds[0].id,channelId:CHANNEL,channelIds:[CHANNEL]};
const radar={...base,type:'hires-radar',region:'kanto-koshin',linearRainband:true,radarCondition:'scheduled',deliveryIntervalHours:'3'};
const tsunami={...base,type:'tsunami-map',region:'all',includeTables:true,enlargedArea:false};
const weather={...base,type:'weather-map',region:'kanto-koshin',products:['VPWW55','VPWW58'],minSeverity:'warning'};
const catalogue={prefectures:[],districts:[],municipalities:[{code:'1310100',prefectureCode:'13'},{code:'1310200',prefectureCode:'13'},{code:'0110000',prefectureCode:'01'}]};

test('plan features are defined once and attached to the plan catalogue',()=>{
 assert.equal(PLAN_CATALOG.supporter.features,PLAN_FEATURES.supporter);
 assert.equal(PLAN_CATALOG.plus.features,PLAN_FEATURES.plus);
 assert.equal(PLAN_CATALOG.pro.features,PLAN_FEATURES.pro);
 assert.ok(publicPlans().every(plan=>plan.features&&!('priceEnv' in plan)));
 const enabled=id=>FEATURE_NAMES.filter(name=>PLAN_FEATURES[id][name]);
 // Basic: 緊急地震速報（警報）の図 (national) and the national tsunami map.
 assert.deepEqual(enabled('supporter'),['eewMap','tsunamiMapNational']);
 assert.deepEqual(enabled('plus'),['rainfallThreshold','prefectureScope','eewMap','eewMapRegion','weatherMap','warningTableNational','hiresRadar','tsunamiMapNational','tsunamiMap','earthquakeMap']);
 assert.equal(PLAN_FEATURES.supporter.imageDelivery,true);
 assert.equal(PLAN_FEATURES.supporter.hiresRadar,false);
 assert.deepEqual(enabled('pro'),FEATURE_NAMES);
 for(const name of ['imageDelivery','hiresRadarThreshold','tsunamiEnlarged','weatherMunicipality'])assert.equal(PLAN_FEATURES.custom[name],true,name);
 // Existing behaviour: custom geography is decided by the administrator's flags.
 assert.equal(planFeatures([custom()]).municipalityScope,false);
 assert.equal(planFeatures([custom({municipalityBranching:true})]).municipalityScope,true);
 assert.equal(planFeatures([{...active('pro'),status:'canceled'}]).imageDelivery,false);
 assert.equal(planFeatures([{...active('pro'),recognizedPlan:false}]).imageDelivery,false);
 assert.equal(planFeatures([{...active('plus'),status:'past_due'}]).rainfallThreshold,true);
 // 未払いでも、翌月1日0時の停止までは標準プランと同じく機能を保つ
 assert.equal(planFeatures([custom({status:'past_due'})]).imageDelivery,true);
 assert.equal(planFeatures([custom({status:'canceled'})]).imageDelivery,false);
 assert.equal(hasFeature(planFeatures([active('plus')]),'hiresRadarThreshold'),false);
 assert.equal(imageTier([active('supporter')]),'supporter');
 assert.equal(imageTier([]),'');
 assert.equal(imageTier([active('plus')]),'plus');
 assert.equal(imageTier([active('plus'),active('pro')]),'pro');
 assert.equal(imageTier([active('pro'),custom()]),'custom');
});

test('the dashboard and Worker share the same plan feature module',async()=>{
 const [app,billing,geo,snapshot,supporter]=await Promise.all(['site/supporter/app.js','worker/supporter-billing.js','worker/supporter-geo.js','worker/supporter-snapshot.js','worker/supporter.js'].map(path=>readFile(new URL('../'+path,import.meta.url),'utf8')));
 assert.match(app,/from '\.\/plan-features\.js'/);
 for(const source of [billing,geo,snapshot,supporter])assert.match(source,/from '\.\.\/site\/supporter\/plan-features\.js'/);
 for(const source of [app,billing,geo,snapshot,supporter])assert.doesNotMatch(source,/\['plus','pro'\]\.includes/);
});

test('image rule options are hidden and saving is rejected while the flag is off',()=>{
 assert.equal(imageRulesEnabled({}),false);
 assert.equal(imageRulesEnabled({SUPPORTER_IMAGE_RULES_ENABLED:'true'}),false);
 assert.equal(imageRulesEnabled({SUPPORTER_IMAGE_RULES_ENABLED:'1'}),true);
 const off=supporterOptions({});
 assert.equal(off.imageRulesEnabled,false);
 assert.equal(off.imageRuleTypes,undefined);
 const on=supporterOptions({SUPPORTER_IMAGE_RULES_ENABLED:'1'});
 assert.deepEqual(on.imageRuleTypes,[['hires-radar','雨雲レーダー（高解像度版）'],['tsunami-map','津波警報・注意報・津波観測（地図・表）'],['weather-map','気象警報・注意報の地図'],['earthquake-map','地震情報（図）']]);
 for(const rule of [radar,tsunami,weather]){
  assert.throws(()=>normalizeSupporterRules([rule],guilds,limitsFor(active('pro'))),/準備中/);
  assert.throws(()=>normalizeSupporterRules([rule],guilds,limitsFor(active('pro')),null,{imageRules:false}),/準備中/);
 }
});

test('Basic cannot save any image rule',()=>{
 for(const rule of [radar,tsunami,weather])assert.throws(()=>normalizeSupporterRules([rule],guilds,limitsFor(active('supporter')),catalogue,ENABLED),/Plus以上/);
});

test('Plus saves region-level image rules but not Pro-only options',()=>{
 const limits=limitsFor(active('plus'));
 const [r,t,w]=normalizeSupporterRules([radar,tsunami,weather],guilds,limits,catalogue,ENABLED);
 assert.deepEqual({...r,name:undefined},{name:undefined,guildId:guilds[0].id,channelId:CHANNEL,channelIds:[CHANNEL],type:'hires-radar',conditionLogic:'and',conditions:[],region:'kanto-koshin',linearRainband:true,radarCondition:'scheduled',rainfallThresholdMmPerHour:null,radarContents:["current"],deliveryIntervalMinutes:180,deliveryIntervalHours:3,forecastIntervalMinutes:60});
 assert.deepEqual([t.includeTables,t.enlargedArea,t.region],[true,false,'all']);
 assert.deepEqual([w.products,w.minSeverity,w.prefecture,w.municipalities,w.municipalityDetail],[['VPWW55','VPWW58'],'warning',null,[],false]);
 assert.throws(()=>normalizeSupporterRules([{...radar,radarCondition:'rainfall-threshold',rainfallThresholdMmPerHour:'30'}],guilds,limits,catalogue,ENABLED),/Pro以上/);
 assert.throws(()=>normalizeSupporterRules([{...tsunami,enlargedArea:true}],guilds,limits,catalogue,ENABLED),/Pro以上/);
 assert.throws(()=>normalizeSupporterRules([{...weather,prefecture:'13'}],guilds,limits,catalogue,ENABLED),/Pro以上/);
 assert.throws(()=>normalizeSupporterRules([{...weather,municipalityDetail:true}],guilds,limits,catalogue,ENABLED),/Pro以上/);
 // Conditions / OR are ignored for image types rather than stored.
 const ignored=normalizeSupporterRules([{...tsunami,conditionLogic:'or',conditions:[{kind:'region',value:'tohoku'}]}],guilds,limits,catalogue,ENABLED)[0];
 assert.deepEqual([ignored.conditionLogic,ignored.conditions],['and',[]]);
});

test('Pro and custom save every image option, with strict field validation',()=>{
 for(const limits of [limitsFor(active('pro')),limitsFor(custom())]){
  const [r,t,w]=normalizeSupporterRules([
   {...radar,radarCondition:'rainfall-threshold',rainfallThresholdMmPerHour:'50',deliveryIntervalHours:'12'},
   {...tsunami,enlargedArea:true,includeTables:false},
   {...weather,minSeverity:'advisory',prefecture:'13',municipalities:['1310200','1310100','1310100'],municipalityDetail:true},
  ],guilds,limits,catalogue,ENABLED);
  assert.deepEqual([r.radarCondition,r.rainfallThresholdMmPerHour,r.deliveryIntervalHours],['rainfall-threshold',50,12]);
  assert.deepEqual([t.enlargedArea,t.includeTables],[true,false]);
  assert.deepEqual([w.prefecture,w.municipalities,w.municipalityDetail,w.minSeverity],['13',['1310200','1310100'],true,'advisory']);
 }
 const limits=limitsFor(active('pro'));
 const bad=[
  [{...radar,radarCondition:'rainfall-threshold',rainfallThresholdMmPerHour:'25'}],
  [{...radar,radarCondition:'rain-detected'}],
  [{...radar,deliveryIntervalHours:'5'}],
  [{...radar,region:'kanto'}],
  [{...radar,linearRainband:'yes'}],
  [{...weather,products:[]}],
  [{...weather,products:['VPWW62']}],
  [{...weather,minSeverity:'special'}],
  [{...weather,prefecture:'01'}],
  [{...weather,prefecture:'48',region:'all'}],
  [{...weather,municipalities:['1310100']}],
  [{...weather,prefecture:'13',municipalities:['0110000']}],
  [{...weather,prefecture:'13',municipalities:['131010']}],
  [{...weather,prefecture:'13',municipalities:Array.from({length:51},(_,i)=>String(1310100+i))}],
 ];
 for(const rules of bad)assert.throws(()=>normalizeSupporterRules(rules,guilds,limits,catalogue,ENABLED),undefined,JSON.stringify(rules[0]));
 // Nationwide weather maps may still narrow to any prefecture.
 assert.equal(normalizeSupporterRules([{...weather,region:'all',prefecture:'01'}],guilds,limits,catalogue,ENABLED)[0].prefecture,'01');
});

test('image rules count toward the existing rule, channel and server limits',()=>{
 const limits={...limitsFor(active('plus')),rules:2,channels:1,servers:1};
 assert.throws(()=>normalizeSupporterRules([radar,tsunami,weather],guilds,limits,catalogue,ENABLED),/2件まで/);
 assert.throws(()=>normalizeSupporterRules([radar,{...tsunami,channelId:'98765432109876544',channelIds:['98765432109876544']}],guilds,limits,catalogue,ENABLED),/1チャンネル/);
 assert.throws(()=>normalizeSupporterRules([{...radar,channelIds:[CHANNEL,'98765432109876544']}],guilds,{...limits,channels:5},catalogue,ENABLED),/PROプラン/);
});

function snapshotDatabase(rules){
 return {prepare(sql){
  if(sql.includes('supporter_custom_plans'))return {async all(){return {results:[]};}};
  return {async all(){return {results:[{discord_user_id:'637850681666961408',customer_id:'cus_1',revision:3,settings_json:JSON.stringify({rules})}]};}};
 }};
}
const proRules=[
 {...radar,conditionLogic:'and',conditions:[],radarCondition:'rainfall-threshold',rainfallThresholdMmPerHour:30,deliveryIntervalHours:1},
 {...tsunami,conditionLogic:'and',conditions:[],enlargedArea:true},
 {...weather,conditionLogic:'and',conditions:[],prefecture:'13',municipalities:['1310100'],municipalityDetail:true},
 {...weather,name:'広域',conditionLogic:'and',conditions:[],prefecture:null,municipalities:[],municipalityDetail:true},
 {...base,type:'earthquake',region:'all',detail:'all',conditionLogic:'and',conditions:[]},
];
const build=(plan,env={SUPPORTER_IMAGE_RULES_ENABLED:'1'},rules=proRules)=>buildSupporterSnapshot(snapshotDatabase(rules),env,async()=>new Map([['cus_1',[plan]]]),1_800_000_000_000);

test('snapshot v4 carries image rules with the account tier',async()=>{
 const snapshot=await build(active('pro'));
 assert.equal(snapshot.schemaVersion,4);
 assert.deepEqual(snapshot.rules.map(rule=>rule.type),['hires-radar','tsunami-map','weather-map','weather-map','earthquake']);
 const [r,t,w,wide]=snapshot.rules;
 for(const rule of [r,t,w,wide]){
  assert.equal(rule.tier,'pro');
  assert.match(rule.id,/^rule-[0-9a-f]{16}$/);
  assert.deepEqual(rule.channelIds,[CHANNEL]);
  assert.equal('conditions' in rule,false);
 }
 assert.deepEqual([r.radarCondition,r.rainfallThresholdMmPerHour,r.linearRainband,r.deliveryIntervalHours],['rainfall-threshold',30,true,1]);
 assert.equal(t.enlargedArea,true);
 assert.deepEqual([w.prefecture,w.municipalities,w.municipalityDetail,w.products,w.minSeverity],['13',['1310100'],true,['VPWW55','VPWW58'],'warning']);
 assert.equal('prefecture' in wide,false);
 assert.equal('tier' in snapshot.rules[4],false);
 assert.equal((await build(custom())).rules[0].tier,'custom');
});

test('snapshot keeps the v1-v3 behaviour when no image rule is published',async()=>{
 const earthquakeOnly=[proRules[4]];
 assert.equal((await build(active('pro'),undefined,earthquakeOnly)).schemaVersion,1);
 // Flag off acts as a kill switch: image rules are withheld and the version stays < 4.
 const off=await build(active('pro'),{});
 assert.equal(off.schemaVersion,1);
 assert.deepEqual(off.rules.map(rule=>rule.type),['earthquake']);
 const v3=await build(active('pro'),undefined,[{...proRules[4],type:'eew',sendFinalReport:false}]);
 assert.equal(v3.schemaVersion,3);
});

test('downgrades exclude image rules instead of widening Pro-only filters',async()=>{
 const plus=await build(active('plus'));
 assert.equal(plus.schemaVersion,4);
 // Threshold radar and municipality-scoped weather maps are suspended, not widened.
 assert.deepEqual(plus.rules.map(rule=>rule.type),['tsunami-map','weather-map','earthquake']);
 const [t,w]=plus.rules;
 assert.equal(t.tier,'plus');
 assert.equal(t.enlargedArea,false);
 assert.equal(w.municipalityDetail,false);
 assert.equal('prefecture' in w,false);
 // Basic keeps only the national tsunami map (no tables, no enlarged maps).
 const basic=await build(active('supporter'));
 assert.equal(basic.schemaVersion,4);
 assert.deepEqual(basic.rules.map(rule=>rule.type),['tsunami-map','earthquake']);
 assert.deepEqual([basic.rules[0].region,basic.rules[0].tsunamiOutputs,basic.rules[0].enlargedArea],['all',['map'],false]);
});

test('admin details describe image rule settings',()=>{
 const details=supporterAdminDetails({discord_user_id:'1',settings_json:JSON.stringify({rules:proRules}),guilds_json:'[]'});
 const labels=rule=>Object.fromEntries(rule.details.map(item=>[item.label,item.value]));
 const [r,t,w]=details.rules.map(labels);
 assert.equal(r['情報種別'],'雨雲レーダー（高解像度版）');
 assert.equal(r['線状降水帯の表示'],'有効');
 assert.equal(r['1時間降水量'],'30mm/h以上');
 assert.equal(t['情報種別'],'津波警報・注意報・津波観測（地図・表）');
 assert.equal(t['発表地域拡大版'],'有効（Pro）');
 assert.equal(w['情報種別'],'気象警報・注意報の地図');
 assert.equal(w['対象の警報・注意報'],'大雨、暴風雪・暴風');
 assert.equal(w['都道府県（Pro）'],'東京都');
 assert.equal(w['市区町村（気象庁コード・Pro）'],'1310100');
 assert.equal(r['詳細種別'],undefined);
});

test('comparison table lists the image delivery rows with the plan split (custom: per contract)',async()=>{
 const [html,css]=await Promise.all(['plans.html','plans.css'].map(file=>readFile(new URL('../site/supporter/'+file,import.meta.url),'utf8')));
 assert.doesNotMatch(html,/準備中/);
 assert.match(html,/選んだ地域が発表の対象に含まれるときだけ配信します/);
 const row=(kind,label)=>{const body=html.match(new RegExp(`<th scope="rowgroup"[^>]*>${kind}(?:<a[^>]*>※</a>)?</th>[\\s\\S]*?</tbody>`))?.[0]||'';return body.match(new RegExp(`<th scope="row">${label}[^<]*(?:<a[^>]*>※</a>)?</th>((?:<td>[^<]*</td>){4})`))?.[1].match(/<td>([^<]*)<\/td>/g).map(cell=>cell.replace(/<\/?td>/g,''));};
 const C='契約による';
 for(const [kind,label,expected] of [
  ['緊急地震速報（警報）の図','全国',['○','○','○','○']],['緊急地震速報（警報）の図','地方',['—','○','○',C]],
  ['気象警報・注意報の地図','全国・地方',['—','○','○',C]],['気象警報・注意報の地図','都道府県・市区町村',['—','—','○',C]],
  ['気象警報・注意報の表','全国',['—','○','○',C]],['気象警報・注意報の表','地方',['—','—','○',C]],['気象警報・注意報の表','発表のたびに配信',['—','—','○',C]],
  ['気象警報・注意報の時系列予想','地方',['—','—','○',C]],['気象警報・注意報の時系列予想','発表のたびに配信',['—','—','○',C]],
  ['雨雲レーダー（高解像度版）','配信頻度の選択',['—','○','○',C]],['雨雲レーダー（高解像度版）','1時間先までの予想',['—','—','○',C]],['雨雲レーダー（高解像度版）','配信頻度の自由な指定',['—','—','○',C]],
  ['雨雲レーダー（簡略版）','地方',['○','○','○','○']],['雨雲レーダー（簡略版）','配信頻度・降雨検知',['○','○','○','○']],['雨雲レーダー（簡略版）','降水量のしきい値',['—','○','○',C]],
  ['雨雲レーダー（高解像度版）','全国・地方',['—','○','○',C]],['雨雲レーダー（高解像度版）','降水量のしきい値',['—','—','○',C]],
  ['津波','地図（全国）',['○','○','○','○']],['津波','地図（地方）',['—','○','○',C]],['津波','表（満潮時刻を含む）',['—','○','○',C]],
  ['津波','津波観測の表',['—','○','○',C]],['津波','発表地域の拡大図',['—','—','○',C]],
  ['組み合わせ・配信先','AND・OR',['—','—','○',C]],['組み合わせ・配信先','1つのルールから複数チャンネル',['—','—','○',C]],
  ['地震情報','情報の種類',['○','○','○','○']],['地震情報','全国・地方',['○','○','○','○']],['地震情報','震度・マグニチュード',['○','○','○','○']],['地震情報','都道府県',['—','○','○',C]],['地震情報','市区町村',['—','—','○',C]],['地震情報','市区町村の本文だけ',['—','—','○',C]],
  ['緊急地震速報（予報）','全国・地方',['○','○','○','○']],['緊急地震速報（予報）','震度・マグニチュード',['○','○','○','○']],['緊急地震速報（予報）','最終報',['○','○','○','○']],['緊急地震速報（予報）','都道府県',['—','○','○',C]],
  ['緊急地震速報（警報）','全国・地方',['○','○','○','○']],['緊急地震速報（警報）','警報の対象地方の条件',['○','○','○','○']],['緊急地震速報（警報）','震度・マグニチュード',['○','○','○','○']],['緊急地震速報（警報）','最終報',['○','○','○','○']],['緊急地震速報（警報）','都道府県',['—','○','○',C]],
  ['気象情報','警戒レベル',['○','○','○','○']],['気象情報','都道府県',['—','○','○',C]],['気象情報','市区町村',['—','—','○',C]],
 ])assert.deepEqual(row(kind,label),expected,`${kind} ${label}`);
 // 種類の見出し（rowspan）と、その行数が合っている
 for(const body of html.match(/<tbody>\s*<tr><th scope="rowgroup"[\s\S]*?<\/tbody>/g))
  assert.equal(Number(body.match(/rowspan="(\d+)"/)[1]),(body.match(/<tr>/g)||[]).length,body.slice(0,120));
 // Every row of the custom column is decided by the contract (price and add-ons excepted).
 const rows=[...html.matchAll(/<th scope="row">([^<]*)(?:<a[^>]*>※<\/a>)?<\/th>((?:<td>[^<]*<\/td>){4})/g)];
 assert.ok(rows.length>30);
 const cell=text=>text.match(/<td>([^<]*)<\/td>/g).map(value=>value.replace(/<\/?td>/g,''));
 assert.deepEqual(cell(rows.find(([,label])=>label==='月額（税込）')[2]),['300円','800円','1,280円','個別']);
 // カスタムは、Basic で使えるものは○（必ず含む）、それ以外は契約による。
 for(const [,label,values] of rows){
  if(['月額（税込）','サーバー','チャンネル','ルール'].includes(label)||label.startsWith('追加'))continue;
  assert.equal(cell(values)[3],cell(values)[0]==='○'?'○':C,label);
 }
 // 緊急地震速報は予報と警報を分け、予報に警報限定条件や市区町村を出さない
 const forecast=html.match(/<th scope="rowgroup"[^>]*>緊急地震速報（予報）(?:<a[^>]*>※<\/a>)?<\/th>[\s\S]*?<\/tbody>/)[0];
 const warning=html.match(/<th scope="rowgroup"[^>]*>緊急地震速報（警報）(?:<a[^>]*>※<\/a>)?<\/th>[\s\S]*?<\/tbody>/)[0];
 assert.doesNotMatch(forecast,/警報の対象地方の条件|市区町村/);
 assert.doesNotMatch(warning,/市区町村/);
 assert.doesNotMatch(html,/予報・警報の選択/);
 // スマホでも grouped 表のカスタム列を隠さず、simple 表の指定は変えない
 assert.doesNotMatch(css,/\.comparison-table-grouped[^\n{}]*(?:thead th:last-child|tbody td:last-child)[^{}]*\{[^}]*display\s*:\s*none/);
 assert.match(css,/@media\(max-width:768px\)[\s\S]*\.comparison-table-grouped\{min-width:0;table-layout:fixed\}/);
 assert.match(css,/\.comparison-table-simple\{min-width:640px\}/);
 assert.equal(cell(rows.find(([,label])=>label.startsWith('追加'))[2])[3],'個別');
});

test('dashboard offers image types only when the server enables them',async()=>{
 const [app,html]=await Promise.all(['site/supporter/app.js','site/supporter/index.html'].map(path=>readFile(new URL('../'+path,import.meta.url),'utf8')));
 assert.match(app,/if\(options\?\.imageRulesEnabled\)return \[\.\.\.TYPES/);
 assert.match(app,/function imageRuleFields\(article,rule\)/);
 for(const key of ['linearRainband','includeTables','enlargedArea','municipalityDetail','minSeverity','hiresRadarThresholds','weatherMapProducts'])assert.ok(app.includes(key),key);
 assert.match(app,/Pro以上/);
 assert.doesNotMatch(html,/image-rules-note|画像配信ルールでは追加条件/);
});

test('flag off keeps an unchanged stored image rule but refuses new or edited ones',()=>{
 const limits=limitsFor(active('pro'));
 const [stored]=normalizeSupporterRules([tsunami],guilds,limits,null,ENABLED);
 const quake={...base,type:'earthquake',region:'all',detail:'all',intensityMode:'all'};
 const saved=normalizeSupporterRules([stored,quake],guilds,limits,null,{imageRules:false,storedImageRules:[stored]});
 assert.deepEqual(saved[0],stored);
 assert.equal(saved[1].type,'earthquake');
 assert.throws(()=>normalizeSupporterRules([{...stored,region:'okinawa'}],guilds,limits,null,{imageRules:false,storedImageRules:[stored]}),/準備中/);
 assert.throws(()=>normalizeSupporterRules([radar],guilds,limits,null,{imageRules:false,storedImageRules:[stored]}),/準備中/);
});

test('tsunami-map: 地図・表・津波観測の表を別々に選べる。保存済みのルールに届くものは変わらない', async () => {
 const {normalizeImageRuleFields, imageRuleSnapshotFields, savedTsunamiOutputs} = await import('../worker/supporter-image-rules.js');
 const limits = {features: undefined, tsunamiMap: true, tsunamiEnlarged: true};
 const rule = extra => ({type: 'tsunami-map', region: 'all', ...extra});
 // 保存済み（outputs）: 表を選んでいれば観測も
 assert.deepEqual(savedTsunamiOutputs(rule({})), ['map', 'table', 'observation']);
 assert.deepEqual(savedTsunamiOutputs(rule({outputs: ['map']})), ['map']);
 assert.deepEqual(savedTsunamiOutputs(rule({outputs: ['table']})), ['table', 'observation']);
 assert.deepEqual(savedTsunamiOutputs(rule({includeTables: false})), ['map']);
 // 新しい項目は outputs より優先
 assert.deepEqual(savedTsunamiOutputs(rule({outputs: ['table'], tsunamiOutputs: ['observation']})), ['observation']);
 for (const [chosen, outputs, tables] of [
  [['map'], ['map'], false], [['table'], ['table'], true], [['observation'], ['table'], true],
  [['observation', 'map'], ['map', 'table'], true], [['map', 'table', 'observation'], ['map', 'table'], true],
 ]) {
  const fields = imageRuleSnapshotFields(rule({tsunamiOutputs: chosen}), limits, 'plus');
  assert.deepEqual(fields.tsunamiOutputs, ['map', 'table', 'observation'].filter(id => chosen.includes(id)));
  assert.deepEqual([fields.outputs, fields.includeTables], [outputs, tables]);
 }
 for (const bad of [[], ['x'], 'map', ['map', 'x']]) assert.throws(() => normalizeImageRuleFields(rule({tsunamiOutputs: bad}), 'tsunami-map', limits));
 assert.throws(() => normalizeImageRuleFields(rule({outputs: ['observation']}), 'tsunami-map', limits));
 const saved = normalizeImageRuleFields(rule({tsunamiOutputs: ['observation'], enlargedArea: true}), 'tsunami-map', limits);
 assert.deepEqual([saved.tsunamiOutputs, saved.enlargedArea], [['observation'], false]);   // 拡大図は地図を送るルールだけ
});
