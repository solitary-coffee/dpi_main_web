// Plan matrix (2026-11-21): Basic gets the 緊急地震速報（警報）の図, new eew-map / warning-table
// image types, tsunami-map outputs, per-rule `features` in the snapshot and per-contract custom features.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeSupporterRules, supporterOptions, supporterAdminDetails} from '../worker/supporter.js';
import {buildSupporterSnapshot} from '../worker/supporter-snapshot.js';
import {geographicEntitlements} from '../worker/supporter-geo.js';
import {imageRuleSnapshotFields} from '../worker/supporter-image-rules.js';
import {normalizeCustomPlan, customRowFeatures, customPublic, enrichCustomSubscriptions} from '../worker/supporter-custom.js';
import {
 FEATURE_NAMES, FEATURE_DEFINITIONS, PLAN_FEATURES, PLAN_FEATURE_NAMES, planFeatures, featureList,
 imageTypeAllowed, legacyCustomFeatureNames, missingFeatureDependency, imageTier,
} from '../site/supporter/plan-features.js';

const guilds=[{id:'12345678901234567',name:'DPI Test'}];
const CHANNEL='98765432109876543';
const active=planId=>({status:'active',recognizedPlan:true,planId});
const custom=(features,extra={})=>({status:'active',recognizedPlan:true,planId:'custom',managedCustom:true,customFeatures:features,servers:5,channels:20,rules:30,...extra});
const limitsFor=(...subscriptions)=>({servers:5,channels:20,rules:30,complexConditions:false,multiDestination:false,...planFeatures(subscriptions),...geographicEntitlements(subscriptions)});
const ON={imageRules:true,imageRulesV2:true};
const base={name:'画像',guildId:guilds[0].id,channelId:CHANNEL,channelIds:[CHANNEL]};
const eew={...base,type:'eew-map'};
const table={...base,type:'warning-table',tables:['national']};
const tsunami={...base,type:'tsunami-map',region:'all'};
const save=(rules,limits,options=ON)=>normalizeSupporterRules(rules,guilds,limits,null,options);

test('the entitlement matrix per standard plan',()=>{
 const yes=(plan,name)=>PLAN_FEATURES[plan][name]===true;
 const matrix={
  eewMap:[true,true,true], eewMapRegion:[false,true,true],
  hiresRadar:[false,true,true], hiresRadarThreshold:[false,false,true],
  warningTableNational:[false,true,true], warningTableRegional:[false,false,true],
  warningTableTimeseries:[false,false,true], warningTableEvery:[false,false,true],
  weatherMap:[false,true,true], weatherMunicipality:[false,false,true],
  tsunamiMap:[false,true,true], tsunamiEnlarged:[false,false,true],
  earthquakeMap:[false,true,true], earthquakeMapFilter:[false,false,true],
  rainfallThreshold:[false,true,true], prefectureScope:[false,true,true],
  municipalityScope:[false,false,true], strictMunicipality:[false,false,true],
  complexConditions:[false,false,true], multiDestination:[false,false,true],
 };
 assert.deepEqual(Object.keys(matrix).sort(),[...FEATURE_NAMES].sort());
 for(const [name,expected] of Object.entries(matrix))assert.deepEqual(['supporter','plus','pro'].map(plan=>yes(plan,name)),expected,name);
 for(const item of FEATURE_DEFINITIONS)assert.ok(item.label&&item.section,item.name);
 // Basic: only the eew-map type.
 assert.deepEqual(['eew-map','hires-radar','tsunami-map','weather-map','earthquake-map','warning-table'].filter(type=>imageTypeAllowed(PLAN_FEATURES.supporter,type)),['eew-map']);
 assert.equal(imageTier([active('supporter')]),'supporter');
 // Dependencies of every preset are consistent.
 for(const names of Object.values(PLAN_FEATURE_NAMES))assert.equal(missingFeatureDependency(names),null);
 assert.deepEqual(missingFeatureDependency(['strictMunicipality','prefectureScope']),{name:'strictMunicipality',requires:['municipalityScope']});
 assert.equal(missingFeatureDependency(['warningTableEvery','warningTableTimeseries']),null);
 assert.equal(missingFeatureDependency(['warningTableEvery'])?.name,'warningTableEvery');
});

test('Basic saves only the national 緊急地震速報（警報）の図',()=>{
 const limits=limitsFor(active('supporter'));
 const [rule]=save([eew],limits);
 assert.deepEqual([rule.type,rule.region,rule.regions,rule.conditions],['eew-map','all',[],[]]);
 assert.throws(()=>save([{...eew,regions:['tohoku']}],limits),/Plus以上/);
 for(const other of [table,tsunami,{...base,type:'hires-radar',region:'all'}])assert.throws(()=>save([other],limits),/Plus以上/);
 // V2 types stay hidden until the home server and the Lambda know them.
 assert.throws(()=>save([eew],limits,{imageRules:true}),/準備中/);
 assert.equal(supporterOptions({SUPPORTER_IMAGE_RULES_ENABLED:'1'}).imageRuleTypes.some(([id])=>id==='eew-map'),false);
 const v2=supporterOptions({SUPPORTER_IMAGE_RULES_ENABLED:'1',SUPPORTER_IMAGE_RULES_V2_ENABLED:'1'});
 assert.deepEqual(v2.imageRuleTypes.slice(-2),[['eew-map','緊急地震速報（警報）の図'],['warning-table','警報・注意報の表']]);
 assert.deepEqual(v2.warningTableDeliverOn[0],['changed','内容が変わったときだけ']);
});

test('Plus: eew-map regions and the national warning table (default: only when changed)',()=>{
 const limits=limitsFor(active('plus'));
 const [e,t]=save([{...eew,regions:['kanto-koshin','tohoku','kanto-koshin','all']},{...table,showAllAreas:true}],limits);
 assert.deepEqual(e.regions,['tohoku','kanto-koshin']);
 assert.deepEqual([t.tables,t.regions,t.deliverOn,t.showAllAreas],[['national'],[],'changed',true]);
 assert.throws(()=>save([{...table,deliverOn:'every'}],limits),/Pro以上/);
 assert.throws(()=>save([{...table,tables:['regional'],regions:['kinki']}],limits),/Pro以上/);
 assert.throws(()=>save([{...table,tables:['timeseries'],regions:['kinki']}],limits),/Pro以上/);
 assert.throws(()=>save([{...eew,regions:['kanto']}],limits),/対象地方/);
 assert.throws(()=>save([{...table,tables:[]}],limits),/1つ以上/);
});

test('Pro: regional / timeseries tables need regions, every is allowed',()=>{
 const limits=limitsFor(active('pro'));
 const [t]=save([{...table,tables:['timeseries','national','regional'],regions:['okinawa','hokkaido'],deliverOn:'every'}],limits);
 assert.deepEqual([t.tables,t.regions,t.deliverOn,t.showAllAreas],[['national','regional','timeseries'],['hokkaido','okinawa'],'every',false]);
 assert.throws(()=>save([{...table,tables:['regional']}],limits),/地方を1つ以上/);
 assert.throws(()=>save([{...table,deliverOn:'sometimes'}],limits),/タイミング/);
});

test('tsunami-map outputs: map and table can be separate rules (absent = both)',()=>{
 const limits=limitsFor(active('pro'));
 const [both,mapOnly,tableOnly,legacy]=save([tsunami,{...tsunami,outputs:['map'],enlargedArea:true},{...tsunami,outputs:['table'],enlargedArea:true},{...tsunami,includeTables:false}],limits);
 assert.deepEqual([both.outputs,both.includeTables],[['map','table'],true]);
 assert.deepEqual([mapOnly.outputs,mapOnly.includeTables,mapOnly.enlargedArea],[['map'],false,true]);
 assert.deepEqual([tableOnly.outputs,tableOnly.includeTables,tableOnly.enlargedArea],[['table'],true,false]);
 assert.deepEqual(legacy.outputs,['map']);
 assert.throws(()=>save([{...tsunami,outputs:[]}],limits),/図・表/);
 assert.throws(()=>save([{...tsunami,outputs:['map','video']}],limits),/図・表/);
 // Each output rule counts toward the rule limit.
 assert.throws(()=>save([tsunami,{...tsunami,outputs:['table']}],{...limits,rules:1}),/1件まで/);
});

test('earthquake-map keeps the legacy hidden VXSE43 option',()=>{
 const [rule]=save([{...base,type:'earthquake-map',products:['VXSE43','VXSE51']}],limitsFor(active('plus')));
 assert.deepEqual(rule.products,['VXSE51','VXSE43']);
 const fields=imageRuleSnapshotFields({...rule},planFeatures([active('plus')]),'plus');
 assert.deepEqual(fields.products,['VXSE51','VXSE43']);
});

function snapshotDatabase(rules){
 return {prepare(sql){
  if(sql.includes('supporter_custom_plans'))return {async all(){return {results:[]};}};
  return {async all(){return {results:[{discord_user_id:'637850681666961408',customer_id:'cus_1',revision:3,settings_json:JSON.stringify({rules})}]};}};
 }};
}
const V2ENV={SUPPORTER_IMAGE_RULES_ENABLED:'1',SUPPORTER_IMAGE_RULES_V2_ENABLED:'1'};
const stored=[
 {...eew,conditionLogic:'and',conditions:[],region:'all',regions:[]},
 {...eew,name:'地方',conditionLogic:'and',conditions:[],region:'all',regions:['tohoku']},
 {...table,conditionLogic:'and',conditions:[],region:'all',tables:['national','regional'],regions:['kinki'],deliverOn:'every',showAllAreas:true},
 {...tsunami,conditionLogic:'and',conditions:[],outputs:['table'],includeTables:true,enlargedArea:false},
];
const build=(plan,env=V2ENV,rules=stored)=>buildSupporterSnapshot(snapshotDatabase(rules),env,async()=>new Map([['cus_1',[plan]]]),1_800_000_000_000);

test('snapshot: every image rule carries the owner features and the tier',async()=>{
 const pro=await build(active('pro'));
 assert.equal(pro.schemaVersion,4);
 assert.deepEqual(pro.rules.map(rule=>rule.type),['eew-map','eew-map','warning-table','tsunami-map']);
 for(const rule of pro.rules){
  assert.equal(rule.tier,'pro');
  assert.deepEqual(rule.features,[...PLAN_FEATURE_NAMES.pro].sort());
 }
 const [national,regional,wt,ts]=pro.rules;
 assert.deepEqual([national.region,national.regions],['all',[]]);
 assert.deepEqual(regional.regions,['tohoku']);
 assert.deepEqual([wt.tables,wt.regions,wt.deliverOn,wt.showAllAreas],[['national','regional'],['kinki'],'every',true]);
 assert.deepEqual([ts.outputs,ts.includeTables,ts.enlargedArea],[['table'],true,false]);
});

test('snapshot: Basic sends only the national eew-map; downgrades narrow, never widen',async()=>{
 const basic=await build(active('supporter'));
 assert.deepEqual(basic.rules.map(rule=>[rule.type,rule.name,rule.tier,rule.features]),[['eew-map','画像','supporter',['eewMap']]]);
 const plus=await build(active('plus'));
 assert.deepEqual(plus.rules.map(rule=>rule.type),['eew-map','eew-map','warning-table','tsunami-map']);
 const wt=plus.rules[2];
 // The regional table and "every" are Pro: the table shrinks to national, timing to "changed".
 assert.deepEqual([wt.tables,wt.regions,wt.deliverOn],[['national'],[],'changed']);
 // Kill switch for the new types.
 const off=await build(active('pro'),{SUPPORTER_IMAGE_RULES_ENABLED:'1'});
 assert.deepEqual(off.rules.map(rule=>rule.type),['tsunami-map']);
});

test('custom: every feature is set per contract',async()=>{
 const only=custom(['eewMap','warningTableTimeseries','complexConditions']);
 const features=planFeatures([only]);
 assert.deepEqual(featureList(features),['complexConditions','eewMap','warningTableTimeseries']);
 assert.equal(imageTypeAllowed(features,'warning-table'),true);
 assert.equal(imageTypeAllowed(features,'hires-radar'),false);
 const limits=limitsFor(only);
 assert.throws(()=>save([table],limits),/Plus以上/);
 assert.deepEqual(save([{...table,tables:['timeseries'],regions:['shikoku']}],limits)[0].tables,['timeseries']);
 assert.throws(()=>save([{...eew,regions:['tohoku']}],limits),/Plus以上/);
 const snapshot=await build(only);
 assert.deepEqual(snapshot.rules.map(rule=>[rule.type,rule.tier]),[['eew-map','custom']]);
 assert.deepEqual(snapshot.rules[0].features,['complexConditions','eewMap','warningTableTimeseries']);
 // Legacy custom summaries (no customFeatures) keep matching Pro for images.
 assert.equal(planFeatures([{...only,customFeatures:undefined}]).hiresRadarThreshold,true);
});

test('custom contract: normalize, legacy columns and dependency checks',()=>{
 const input={name:'協定',channels:3,servers:1,rules:5,monthlyYen:500,secondaryReuse:false};
 const plan=normalizeCustomPlan({...input,features:['strictMunicipality','municipalityScope','prefectureScope','eewMap']});
 assert.deepEqual(plan.features,['eewMap','municipalityScope','prefectureScope','strictMunicipality']);
 assert.deepEqual([plan.municipalityBranching,plan.contentExtraction,plan.complexConditions,plan.multiDestination],[true,true,false,false]);
 assert.throws(()=>normalizeCustomPlan({...input,features:['strictMunicipality']}),/市区町村/);
 assert.throws(()=>normalizeCustomPlan({...input,features:['hiresRadarThreshold']}),/雨雲レーダー/);
 assert.throws(()=>normalizeCustomPlan({...input,features:['unknownFeature']}),/機能/);
 assert.deepEqual(normalizeCustomPlan({...input,features:[]}).features,[]);
 // Older callers / pending changes without features: legacy booleans.
 assert.deepEqual(normalizeCustomPlan({...input,complexConditions:true}).features,legacyCustomFeatureNames({complexConditions:true}));
 const row={id:'c1',name:'協定',status:'active',revision:2,channel_limit:3,server_limit:1,rule_limit:5,complex_conditions:0,municipality_branching:1,content_extraction:0,multi_destination:1,secondary_reuse:0,estimated_yen:800,confirmed_yen:900,stripe_subscription_id:'sub_1'};
 assert.deepEqual(customRowFeatures(row),legacyCustomFeatureNames({municipalityBranching:true,multiDestination:true}));
 const withJson={...row,features_json:JSON.stringify(['eewMap','multiDestination'])};
 assert.deepEqual(customPublic(withJson).features,['eewMap','multiDestination']);
 const paid={subscriptionId:'sub_1',customId:'c1',customRevision:2,status:'active',amount:900,currency:'jpy',recognizedPlan:false};
 const [enriched]=enrichCustomSubscriptions([paid],withJson);
 assert.deepEqual([enriched.customFeatures,enriched.multiDestination,enriched.municipalityBranching,enriched.complexConditions],[['eewMap','multiDestination'],true,false,false]);
 assert.equal(geographicEntitlements([enriched]).municipality,false);
});

test('migration 0032 writes exactly the legacy feature list',async t=>{
 const sql=await readFile(new URL('../migrations/0032_supporter_custom_plan_features.sql',import.meta.url),'utf8');
 assert.match(sql,/ALTER TABLE supporter_custom_plans ADD COLUMN features_json TEXT/);
 let DatabaseSync;
 try{({DatabaseSync}=await import('node:sqlite'));}catch{t.skip('node:sqlite is not available');return;}
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE supporter_custom_plans(discord_user_id TEXT PRIMARY KEY,complex_conditions INTEGER,municipality_branching INTEGER,content_extraction INTEGER,multi_destination INTEGER)`);
 const insert=db.prepare('INSERT INTO supporter_custom_plans VALUES(?,?,?,?,?)');
 const combos=[];
 for(let bits=0;bits<16;bits++){const flags=[1,2,4,8].map(bit=>bits&bit?1:0);combos.push(flags);insert.run(String(bits),...flags);}
 db.exec(sql);
 for(const [index,[complex,city,extract,multi]] of combos.entries()){
  const {features_json}=db.prepare('SELECT features_json FROM supporter_custom_plans WHERE discord_user_id=?').get(String(index));
  assert.deepEqual(JSON.parse(features_json),legacyCustomFeatureNames({complexConditions:!!complex,municipalityBranching:!!city,contentExtraction:!!extract,multiDestination:!!multi}),String(index));
 }
});

test('admin details describe eew-map, warning-table and tsunami outputs',()=>{
 const details=supporterAdminDetails({discord_user_id:'1',settings_json:JSON.stringify({rules:stored}),guilds_json:'[]'});
 const labels=rule=>Object.fromEntries(rule.details.map(item=>[item.label,item.value]));
 const [national,regional,wt,ts]=details.rules.map(labels);
 assert.equal(national['情報種別'],'緊急地震速報（警報）の図');
 assert.equal(national['配信する条件'],'全国：警報が発表されたら配信');
 assert.match(regional['配信する条件'],/東北/);
 assert.equal(wt['送る表'],'全国の表、地方の表');
 assert.equal(wt['配信のタイミング'],'発表のたびに毎回');
 assert.equal(wt['発表のない区域'],'載せる');
 assert.equal(ts['送るもの'],'表');
 assert.equal(national['対象地方'],undefined);
});

test('dashboard: previews, plan-aware type list and the new editors',async()=>{
 const [app,plans,css]=await Promise.all(['site/supporter/app.js','site/supporter/plans.html','site/supporter/style.css'].map(path=>readFile(new URL('../'+path,import.meta.url),'utf8')));
 for(const name of ['weather-map-${scope}','hires-radar-${scope}','eew-map-national','warning-table-${id}','tsunami-map-${id}'])assert.ok(app.includes(name),name);
 assert.match(app,/import \{ PREVIEW_BASE, attachPreview \} from '\.\/preview-lightbox\.js';/);
 assert.match(app,/img\.loading='lazy'/);
 assert.match(app,/addEventListener\('error'/);
 assert.match(app,/textContent='見本'/);
 assert.match(app,/imageTypeAllowed\(entitlements,value\)/);
 assert.ok(app.includes('全国：緊急地震速報（警報）が発表されたら配信'));
 assert.ok(app.includes('地方を選ぶ（Plus以上）：選んだ地方が対象地域になったとき（続報で追加された場合も含む）に配信'));
 assert.match(app,/rule\.deliverOn='changed'/);
 assert.match(css,/\.rule-preview/);
 for(const name of ['weather-map-national','weather-map-region','warning-table-national','warning-table-regional','warning-table-timeseries','eew-map-national','hires-radar-national','hires-radar-region','tsunami-map-map','tsunami-map-table'])
  assert.ok(plans.includes(`/site/supporter/previews/${name}.png`),name);
 assert.match(plans,/<script type="module" src="plans-previews\.js"><\/script>/);
});
