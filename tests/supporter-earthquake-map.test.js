import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeSupporterRules, supporterOptions, supporterAdminDetails} from '../worker/supporter.js';
import {buildSupporterSnapshot} from '../worker/supporter-snapshot.js';
import {geographicEntitlements} from '../worker/supporter-geo.js';
import {isPrivateAssetPath} from '../worker/private-assets.js';
import {planFeatures, PLAN_FEATURES, PLAN_FEATURE_NAMES} from '../site/supporter/plan-features.js';
import {
 EARTHQUAKE_MAP_PRODUCTS, EARTHQUAKE_MAP_INTENSITIES, EARTHQUAKE_MAP_LG_CLASSES, EARTHQUAKE_MAP_REGION_IDS, EARTHQUAKE_MUNICIPALITIES_PATH,
 imageRuleSnapshotFields, parseEarthquakeMunicipalities, loadEarthquakeMunicipalities,
} from '../worker/supporter-image-rules.js';

const guilds=[{id:'12345678901234567',name:'DPI Test'}];
const CHANNEL='98765432109876543';
const active=planId=>({status:'active',recognizedPlan:true,planId});
const custom=()=>({status:'active',recognizedPlan:true,planId:'custom',managedCustom:true,municipalityBranching:false,contentExtraction:false});
const limitsFor=(...subscriptions)=>({servers:5,channels:20,rules:30,complexConditions:false,multiDestination:false,...planFeatures(subscriptions),...geographicEntitlements(subscriptions)});
const ENABLED={imageRules:true};
const read=path=>readFile(new URL('../'+path,import.meta.url),'utf8');
const list=JSON.parse(await read('site/supporter/earthquake-municipalities.json'));
const catalogue={prefectures:[],districts:[],municipalities:[],earthquakeMunicipalities:parseEarthquakeMunicipalities(list)};
const quake=(extra={})=>({name:'地震図',guildId:guilds[0].id,channelId:CHANNEL,channelIds:[CHANNEL],type:'earthquake-map',region:'kanto-koshin',...extra});
const PRO_FIELDS=['minIntensity','regionMinIntensity','centerMunicipality'];

test('earthquake-map ids match what the home server parser accepts',()=>{
 // dpi_code Di/supporter_image_rules.py: EARTHQUAKE_PRODUCTS / EARTHQUAKE_INTENSITIES / REGION_IDS.
 assert.deepEqual(EARTHQUAKE_MAP_PRODUCTS.map(([id])=>id),['VXSE51','VXSE52','VXSE53','VXSE62']);
 assert.deepEqual(EARTHQUAKE_MAP_LG_CLASSES.map(([id])=>id),['1','2','3','4']);
 assert.deepEqual(EARTHQUAKE_MAP_INTENSITIES.map(([id])=>id),['1','2','3','4','5-','5+','6-','6+','7']);
 assert.deepEqual([...EARTHQUAKE_MAP_REGION_IDS],['hokkaido','tohoku','kanto-koshin','hokuriku','tokai','kinki','chugoku','shikoku','kyushu-north','kyushu-south-amami','okinawa']);
 const options=supporterOptions({SUPPORTER_IMAGE_RULES_ENABLED:'1'});
 assert.deepEqual(options.imageRuleTypes.at(-1),['earthquake-map','地震情報（図）']);
 assert.equal(options.earthquakeMapProducts,EARTHQUAKE_MAP_PRODUCTS);
 assert.equal(options.earthquakeMapIntensities,EARTHQUAKE_MAP_INTENSITIES);
 assert.equal(options.earthquakeMunicipalitiesPath,EARTHQUAKE_MUNICIPALITIES_PATH);
 assert.equal(supporterOptions({}).earthquakeMapProducts,undefined);
 assert.equal(PLAN_FEATURES.plus.earthquakeMapFilter,false);
 assert.equal(PLAN_FEATURES.pro.earthquakeMapFilter,true);
 assert.equal(PLAN_FEATURES.custom.earthquakeMapFilter,true);
});

test('Plus saves earthquake-map kinds only; region is fixed to all',()=>{
 const limits=limitsFor(active('plus'));
 const [all,picked]=normalizeSupporterRules([quake(),quake({products:['VXSE53','VXSE51'],minIntensity:'',regionMinIntensity:{tohoku:''},centerMunicipality:''})],guilds,limits,catalogue,ENABLED);
 assert.deepEqual([all.region,all.products,all.minIntensity,all.regionMinIntensity,all.minLgInt,all.centerMunicipality],['all',['VXSE51','VXSE52','VXSE53','VXSE62'],null,{},null,null]);
 assert.deepEqual([all.conditionLogic,all.conditions],['and',[]]);
 assert.deepEqual(picked.products,['VXSE51','VXSE53']);
 for(const extra of [{minIntensity:'3'},{regionMinIntensity:{tohoku:'4'}},{minLgInt:'2'},{centerMunicipality:'1310100'}])
  assert.throws(()=>normalizeSupporterRules([quake(extra)],guilds,limits,catalogue,ENABLED),/Pro以上/,JSON.stringify(extra));
 assert.throws(()=>normalizeSupporterRules([quake()],guilds,limitsFor(active('supporter')),catalogue,ENABLED),/Plus以上/);
});

test('Pro and custom save thresholds and the centre municipality with strict validation',()=>{
 for(const limits of [limitsFor(active('pro')),limitsFor(custom())]){
  const [rule]=normalizeSupporterRules([quake({products:['VXSE52'],minIntensity:'5-',regionMinIntensity:{okinawa:'3',tohoku:'6+',kinki:''},centerMunicipality:'1310100'})],guilds,limits,catalogue,ENABLED);
  assert.deepEqual([rule.products,rule.minIntensity,rule.regionMinIntensity,rule.centerMunicipality],[['VXSE52'],'5-',{tohoku:'6+',okinawa:'3'},'1310100']);
  assert.deepEqual(Object.keys(rule.regionMinIntensity),['tohoku','okinawa']);
 }
 const limits=limitsFor(active('pro'));
 const bad=[
  {products:[]},{products:['VXSE61']},{products:'VXSE51'},
  {minIntensity:'5弱'},{minIntensity:'8'},{minIntensity:'0'},
  {regionMinIntensity:{all:'3'}},{regionMinIntensity:{kanto:'3'}},{regionMinIntensity:{tohoku:'5'}},{regionMinIntensity:['3']},
  {centerMunicipality:'131010'},{centerMunicipality:'9999999'},{centerMunicipality:'1310100x'},
 ];
 for(const extra of bad)assert.throws(()=>normalizeSupporterRules([quake(extra)],guilds,limits,catalogue,ENABLED),undefined,JSON.stringify(extra));
 // Without the static list the centre cannot be validated: fail closed.
 assert.throws(()=>normalizeSupporterRules([quake({centerMunicipality:'1310100'})],guilds,limits,{prefectures:[],municipalities:[],districts:[]},ENABLED),/選び直して/);
});

function snapshotDatabase(rules){
 return {prepare(sql){
  if(sql.includes('supporter_custom_plans'))return {async all(){return {results:[]};}};
  return {async all(){return {results:[{discord_user_id:'637850681666961408',customer_id:'cus_1',revision:5,settings_json:JSON.stringify({rules})}]};}};
 }};
}
const stored=extra=>({...quake(),region:'all',conditionLogic:'and',conditions:[],products:['VXSE51','VXSE52','VXSE53'],minIntensity:null,regionMinIntensity:{},centerMunicipality:null,...extra});
const savedRules=[
 stored({name:'全部'}),
 stored({name:'しきい値',products:['VXSE53'],minIntensity:'4',regionMinIntensity:{'kanto-koshin':'3'},centerMunicipality:'1310100'}),
 stored({name:'中心のみ',centerMunicipality:'2710000'}),
];
const build=plan=>buildSupporterSnapshot(snapshotDatabase(savedRules),{SUPPORTER_IMAGE_RULES_ENABLED:'1'},async()=>new Map([['cus_1',[plan]]]),1_800_000_000_000);

test('snapshot v4 sends Pro-only earthquake keys only for Pro/custom and only when set',async()=>{
 const pro=await build(active('pro'));
 assert.equal(pro.schemaVersion,4);
 const [all,threshold,centre]=pro.rules;
 assert.deepEqual(Object.keys(all).sort(),['channelId','channelIds','features','guildId','id','name','products','region','tier','type']);
 assert.deepEqual(all.features,[...PLAN_FEATURE_NAMES.pro].sort());
 assert.deepEqual([all.type,all.region,all.tier,all.products],['earthquake-map','all','pro',['VXSE51','VXSE52','VXSE53']]);
 assert.deepEqual([threshold.products,threshold.minIntensity,threshold.regionMinIntensity,threshold.centerMunicipality],[['VXSE53'],'4',{'kanto-koshin':'3'},'1310100']);
 assert.equal(centre.centerMunicipality,'2710000');
 assert.equal('minIntensity' in centre,false);
 assert.equal((await build(custom())).rules[1].tier,'custom');
});

test('downgrade to Plus suspends threshold rules and drops the centre, never sending Pro keys',async()=>{
 const plus=await build(active('plus'));
 assert.equal(plus.schemaVersion,4);
 assert.deepEqual(plus.rules.map(rule=>rule.name),['全部','中心のみ']);
 for(const rule of plus.rules){
  assert.equal(rule.tier,'plus');
  for(const key of PRO_FIELDS)assert.equal(key in rule,false,key);
 }
 const basic=await build(active('supporter'));
 assert.deepEqual(basic.rules,[]);
 // Direct checks: malformed stored values are suspended rather than widened.
 const pro=planFeatures([active('pro')]);
 assert.equal(imageRuleSnapshotFields(stored({minIntensity:'5弱'}),pro,'pro'),null);
 assert.equal(imageRuleSnapshotFields(stored({regionMinIntensity:{all:'3'}}),pro,'pro'),null);
 assert.equal(imageRuleSnapshotFields(stored({products:[]}),pro,'pro'),null);
 // A Plus tier never carries Pro keys even if the features say otherwise.
 assert.equal(imageRuleSnapshotFields(stored({minIntensity:'3'}),pro,'plus'),null);
 assert.deepEqual(Object.keys(imageRuleSnapshotFields(stored({centerMunicipality:'1310100'}),pro,'plus')).sort(),['features','products','region','tier']);
});

test('static municipality list is small, complete and served behind the paid-site gate',async()=>{
 const raw=await read('site/supporter/earthquake-municipalities.json');
 assert.ok(Buffer.byteLength(raw)<64*1024,`size ${Buffer.byteLength(raw)}`);
 assert.equal(Object.keys(list.prefectures).length,47);
 assert.equal(list.count,1894);
 assert.equal(catalogue.earthquakeMunicipalities.size,1894);
 for(const [pref,cities] of Object.entries(list.prefectures))for(const [code,name] of cities){assert.match(code,/^\d{7}$/);assert.equal(code.slice(0,2),pref);assert.ok(name);}
 assert.equal(catalogue.earthquakeMunicipalities.get('1310100').prefectureCode,'13');
 assert.equal(EARTHQUAKE_MUNICIPALITIES_PATH.startsWith('/site/supporter/'),true);
 assert.equal(isPrivateAssetPath(EARTHQUAKE_MUNICIPALITIES_PATH),false);
 assert.throws(()=>parseEarthquakeMunicipalities({prefectures:{}}),/市区町村一覧/);
});

test('the Worker loads the list from the static asset and fails closed',async()=>{
 const failing={ASSETS:{async fetch(){return new Response('nope',{status:404});}}};
 await assert.rejects(loadEarthquakeMunicipalities(failing,'https://dpi-bot.com/api/supporter/settings'),error=>error.status===503);
 let requested='';
 const env={ASSETS:{async fetch(request){requested=request.url;return new Response(JSON.stringify(list),{headers:{'Content-Type':'application/json'}});}}};
 const codes=await loadEarthquakeMunicipalities(env,'https://dpi-bot.com/api/supporter/settings');
 assert.equal(requested,'https://dpi-bot.com/site/supporter/earthquake-municipalities.json');
 assert.equal(codes.has('0110100'),true);
});

test('admin details describe earthquake-map settings',()=>{
 const details=supporterAdminDetails({discord_user_id:'1',settings_json:JSON.stringify({rules:savedRules}),guilds_json:'[]'});
 const [all,threshold]=details.rules.map(rule=>Object.fromEntries(rule.details.map(item=>[item.label,item.value])));
 assert.equal(all['情報種別'],'地震情報（図）');
 assert.equal(all['対象地方'],undefined);
 assert.equal(all['送る情報の種類'],'震度速報、震源に関する情報、震源・震度に関する情報（各地の震度）');
 assert.equal(all['震度のしきい値（全国）'],'指定なし');
 assert.equal(threshold['震度のしきい値（全国）'],'震度4以上（Pro）');
 assert.equal(threshold['地方別の震度しきい値'],'関東甲信地方：震度3以上（Pro）');
 assert.equal(threshold['地図の中心にする市区町村'],'1310100（Pro）');
});

test('dashboard and comparison page describe the earthquake maps with the Plus/Pro split',async()=>{
 const [app,html,index]=await Promise.all(['site/supporter/app.js','site/supporter/plans.html','site/supporter/index.html'].map(read));
 assert.match(app,/\['earthquake-map','地震情報（図）'\]/);
 assert.match(app,/function earthquakeMapFields\(box,rule\)/);
 assert.match(app,/entitlements\.earthquakeMapFilter/);
 assert.match(app,/Pro限定の設定を解除する/);
 for(const key of ['earthquakeMapProducts','earthquakeMapIntensities','earthquakeMapRegions','earthquakeMunicipalitiesPath','centerMunicipality','regionMinIntensity','minIntensity'])assert.ok(app.includes(key),key);
 const row=(kind,label)=>{const body=html.match(new RegExp(`<th scope="rowgroup"[^>]*>${kind}</th>[\\s\\S]*?</tbody>`))?.[0]||'';return body.match(new RegExp(`<th scope="row">${label}[^<]*</th>((?:<td>[^<]*</td>){4})`))?.[1].match(/<td>([^<]*)<\/td>/g).map(cell=>cell.replace(/<\/?td>/g,''));};
 assert.deepEqual(row('地震情報の図','全国'),['—','○','○','契約による']);
 assert.deepEqual(row('地震情報の図','震度のしきい値'),['—','—','○','契約による']);
 assert.match(html,/id="earthquake-map-detail"/);
 assert.match(index,/地震情報の図/);
 // Still private: no donation / payment wording added, no public switch flipped.
 assert.doesNotMatch(html+index,/寄付|支援金|donat/i);
});

test('VXSE62 (長周期地震動) product and the Pro minLgInt threshold',async()=>{
 const pro=limitsFor(active('pro'));
 const [rule]=normalizeSupporterRules([quake({products:['VXSE62'],minLgInt:'3'})],guilds,pro,catalogue,ENABLED);
 assert.deepEqual([rule.products,rule.minLgInt],[['VXSE62'],'3']);
 for(const extra of [{minLgInt:'0'},{minLgInt:'5'},{minLgInt:'階級3'},{minLgInt:'2.5'}])
  assert.throws(()=>normalizeSupporterRules([quake(extra)],guilds,pro,catalogue,ENABLED),/長周期/,JSON.stringify(extra));
 const rules=[stored({name:'長周期',products:['VXSE53','VXSE62'],minLgInt:'2'})];
 const snap=plan=>buildSupporterSnapshot(snapshotDatabase(rules),{SUPPORTER_IMAGE_RULES_ENABLED:'1'},async()=>new Map([['cus_1',[plan]]]),1_800_000_000_000);
 const [sent]=(await snap(active('pro'))).rules;
 assert.deepEqual([sent.products,sent.minLgInt],[['VXSE53','VXSE62'],'2']);
 // Plus: a threshold rule is suspended, never widened.
 assert.deepEqual((await snap(active('plus'))).rules,[]);
});
