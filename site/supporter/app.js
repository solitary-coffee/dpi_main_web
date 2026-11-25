import {showLaunchNotice} from './launch-notice.js';
import { planFeatures, imageTypeAllowed } from './plan-features.js';
import { PREVIEW_BASE, attachPreview } from './preview-lightbox.js';
import { creditFirstPayment } from './credit-first.js';

let session;
let revision = 0;
let rules = [];
let options;
let areaCatalogue={municipalities:[],districts:[]};
let areaCatalogueFailed=false;
// earthquake-map centre municipalities (static JSON, loaded on first use): {prefectureCode: [[code,name],...]}
let earthquakeCities=null;
let earthquakeCitiesState='idle';
let entitlements = {servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false,...featureEntitlements([])};
let hasConfigurableContract = false;
let billingAvailable = false;
let accountSuspended = false;
let stripeBillingEnabled = false;
let checkoutButton;
let hasExistingContract=false;
let customPlanLocked=false;
let availableCredits=0;
let creditBalanceLoaded=false;
let creditBalanceFailed=false;
let billingUnavailable=false;
const channelsByGuild = new Map();
const PLAN_OPTIONS=[['supporter','Basic 月額300円'],['plus','Plus 月額800円'],['pro','Pro 月額1,280円']];
const CHANNEL_PACK_OPTIONS=[[0,'チャンネル追加なし'],[1,'＋3チャンネル / 月額＋200円'],[2,'＋6チャンネル / 月額＋400円'],[3,'＋9チャンネル / 月額＋600円'],[4,'＋12チャンネル / 月額＋800円'],[5,'＋15チャンネル / 月額＋1,000円']];
const SERVER_PACK_OPTIONS=[[0,'サーバー追加なし'],[1,'＋2サーバー / 月額＋200円'],[2,'＋4サーバー / 月額＋400円'],[3,'＋6サーバー / 月額＋600円'],[4,'＋8サーバー / 月額＋800円'],[5,'＋10サーバー / 月額＋1,000円']];
const RULE_PACK_OPTIONS=[[0,'ルール追加なし'],[1,'＋3ルール / 月額＋200円'],[2,'＋6ルール / 月額＋400円'],[3,'＋9ルール / 月額＋600円'],[4,'＋12ルール / 月額＋800円'],[5,'＋15ルール / 月額＋1,000円']];

const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; };
const INTENSITIES = [['1','1'],['2','2'],['3','3'],['4','4'],['5-','5弱'],['5+','5強'],['6-','6弱'],['6+','6強'],['7','7']];
const TYPES = [['earthquake','地震情報'],['eew','緊急地震速報'],['weather','気象情報'],['rain-radar','雨雲レーダー（簡略版）']];
// Paid image rules; offered only when /api/supporter/options reports imageRulesEnabled.
const IMAGE_TYPES = [['hires-radar','雨雲レーダー（高解像度版）'],['tsunami-map','津波警報・注意報・津波観測（地図・表）'],['weather-map','気象警報・注意報の地図'],['earthquake-map','地震情報（図）'],['eew-map','緊急地震速報（警報）の図'],['warning-table','気象警報・注意報の表'],['warning-timeseries','気象警報・注意報の時系列予想']];
// warning-table: which feature allows each table (plan-features.js).
const AREA_NOTE = '選んだ地域が発表の対象に含まれないときは配信されません。';
const RADAR_CONTENT_IDS = ['current','forecast'];
const WARNING_TABLE_FEATURES = {national:'warningTableNational',regional:'warningTableRegional',timeseries:'warningTableTimeseries'};
const TSUNAMI_OUTPUT_IDS = ['map','table','observation'];
// 保存済みのルール（outputs）では、表を選んでいれば観測も届いていた。worker/supporter-image-rules.js の savedTsunamiOutputs と同じ
function savedTsunamiOutputs(rule){
 if(Array.isArray(rule.tsunamiOutputs)&&rule.tsunamiOutputs.length)return TSUNAMI_OUTPUT_IDS.filter(id=>rule.tsunamiOutputs.includes(id));
 const outputs=Array.isArray(rule.outputs)&&rule.outputs.length?rule.outputs:(rule.includeTables===false?['map']:['map','table']);
 return TSUNAMI_OUTPUT_IDS.filter(id=>outputs.includes(id==='observation'?'table':id));
}
const isImageType = type => IMAGE_TYPES.some(([value]) => value === type);
// Default (new rule) selection stays VPWW55..VPWW60; VPWW61/VPHW50/VPBS50 are opt-in.
const WEATHER_MAP_DEFAULT_PRODUCT_IDS = ['VPWW55','VPWW56','VPWW57','VPWW58','VPWW59','VPWW60'];
const WEATHER_MAP_PRODUCT_IDS = [...WEATHER_MAP_DEFAULT_PRODUCT_IDS,'VPWW61','VPHW50','VPBS50'];
// earthquake-map: 震度速報 / 震源に関する情報 / 各地の震度. A new rule selects all three.
const EARTHQUAKE_MAP_PRODUCT_IDS = ['VXSE51','VXSE52','VXSE53','VXSE62'];
// Legacy hidden option (緊急地震速報（警報）inside earthquake-map): kept on saved rules, never offered.
const EARTHQUAKE_MAP_LEGACY_PRODUCT_IDS = [...EARTHQUAKE_MAP_PRODUCT_IDS,'VXSE43'];
const defaultProducts = type => type==='earthquake-map'?[...EARTHQUAKE_MAP_PRODUCT_IDS]:[...WEATHER_MAP_DEFAULT_PRODUCT_IDS];
// Client mirror of the server entitlements; the feature table itself is shared (plan-features.js).
function featureEntitlements(active){
 const features=planFeatures(active);
 return {...features,prefecture:features.prefectureScope,municipality:features.municipalityScope,strictMunicipality:features.strictMunicipality};
}
// Image types the plan does not allow are not listed (the note above the rules says which plan
// adds them); a saved rule keeps its type with a short warning.
function typeChoices(rule){
 if(options?.imageRulesEnabled)return [...TYPES,...(options.imageRuleTypes||IMAGE_TYPES)
  .filter(([value])=>imageTypeAllowed(entitlements,value)||value===rule?.type)
  .map(([value,text])=>[value,imageTypeAllowed(entitlements,value)?text:`${text}（現在の契約では配信されません）`])];
 const saved=IMAGE_TYPES.find(([value])=>value===rule?.type);
 return saved?[...TYPES,[saved[0],`${saved[1]}（準備中）`]]:TYPES;
}
const WEATHER_ALERT_DETAILS = new Set(['heavy-rain-level','landslide-level','flood-level','storm-surge-level']);
const WEATHER_WARNING_DETAILS = new Set(['storm-blizzard-warning','wave-warning','heavy-snow-warning','other-advisory']);

async function api(path, method = 'GET', body, retry = true) {
 const response = await fetch(path, {
  method,
  headers: {Accept:'application/json','Content-Type':'application/json','x-reuse-csrf':session?.csrfToken || ''},
  credentials:'same-origin',
  cache:'no-store',
  body: body ? JSON.stringify(body) : undefined,
 });
 const raw = await response.text();
 let data = {};
 try { data = raw ? JSON.parse(raw) : {}; }
 catch {
  const htmlResponse=/^\s*<!doctype\s+html|^\s*<html[\s>]/i.test(raw);
  if(method==='GET'&&retry&&response.status>=500)return api(path,method,body,false);
  const authResponse=response.status===401||response.status===403||response.redirected||response.url.includes('/cdn-cgi/access/');
  const message=authResponse
   ?'ログインの有効期限が切れた可能性があります。ページを再読み込みして、もう一度ログインしてください。'
   :response.status>=500
    ?'サーバーから一時的に正しくない応答が返されました。時間をおいて再読み込みしてください。'
    :htmlResponse
     ?'画面データを取得できませんでした。ページを再読み込みしてください。'
     :'サーバーの応答を読み込めませんでした。時間をおいて再試行してください。';
  const error=new Error(message);error.status=response.status;error.code=htmlResponse?'unexpected_html_response':'invalid_json_response';throw error;
 }
 if (!response.ok) throw Error(data.message || '操作に失敗しました');
 return data;
}

async function loadChannels(guildId, force = false) {
 if (!guildId) return [];
 if (!force && channelsByGuild.has(guildId)) return channelsByGuild.get(guildId);
 const data = await api(`/api/reuse/channels?guild_id=${encodeURIComponent(guildId)}`);
 channelsByGuild.set(guildId, data.channels);
 return data.channels;
}

function selectOptions(input, values, current, placeholder) {
 input.replaceChildren();
 if (placeholder) {
  const option = document.createElement('option');
  option.value = '';
  option.textContent = placeholder;
  input.append(option);
 }
 for (const [value, text] of values) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = text;
  input.append(option);
 }
 input.value = current ?? '';
}

function field(article, rule, key, label, values, attributes = {}) {
 const wrapper = document.createElement('label');
 const caption = document.createElement('span');
 caption.textContent = label;
 const input = document.createElement(values ? 'select' : 'input');
 if (values) selectOptions(input, values, rule[key]);
 else input.value = rule[key] ?? '';
 for (const [name,value] of Object.entries(attributes)) input.setAttribute(name,value);
 input.onchange = async () => {
  rule[key] = input.value;
  if (key === 'guildId') {
   rule.channelId = '';
   rule.channelIds = [];
   const index=rules.indexOf(rule);
   const different=index>0&&rules[0]?.guildId&&rule.guildId!==rules[0].guildId;
   status(different?'別のサーバーが選択されています。契約中のサーバー数上限を確認してください。':'チャンネルを取得しています…');
   try { await loadChannels(rule.guildId, true); if(!different)status(''); } catch (error) { status(error.message); }
   render();
  } else if (key === 'type' || key === 'detail' || key === 'intensityMode' || key === 'magnitudeMode' || key === 'conditionLogic' || key === 'radarCondition' || key === 'region' || key === 'prefecture' || key === 'district' || key === 'municipality') {
   if (key === 'type') {rule.detail = 'all';rule.conditions=[];rule.radarCondition=rule.type==='hires-radar'?'scheduled':'all';rule.rainfallThresholdMmPerHour=rule.type==='hires-radar'?'10':'';rule.products=defaultProducts(rule.type);if(isImageType(rule.type)){rule.conditionLogic='and';rule.region='all';rule.regions=[];rule.tables=defaultWarningTables();rule.radarContents=['current'];rule.deliveryIntervalMinutes=60;rule.forecastIntervalMinutes=60;rule.deliverOn='changed';rule.showAllAreas=false;rule.tsunamiOutputs=entitlements.tsunamiMap?[...TSUNAMI_OUTPUT_IDS]:['map'];}}
   if (key === 'region') {rule.prefecture='all';rule.district='all';rule.municipality='all';rule.strictMunicipality=false;rule.municipalities=[];}
   if (key === 'prefecture') {rule.district='all';rule.municipality='all';rule.strictMunicipality=false;rule.municipalities=[];}
   if (key === 'district') {rule.municipality='all';rule.strictMunicipality=false;}
   if (key === 'municipality' && input.value==='all')rule.strictMunicipality=false;
   render();
  }
 };
 wrapper.append(caption,input);
 article.append(wrapper);
 return input;
}

function channelField(article, rule) {
 const channels = channelsByGuild.get(rule.guildId) || [];
 const choices = channels.map(channel => [channel.id, `${channel.announcement ? '📣' : '#'} ${channel.name}`]);
 let input;
 if(entitlements.multiDestination){
  const wrapper=document.createElement('fieldset');wrapper.className='multi-channel-field';
  const caption=document.createElement('legend');caption.textContent='通知チャンネル（複数選択可）';wrapper.append(caption);
  const available=new Set(choices.map(([value])=>value));
  const selected=new Set((rule.channelIds||[rule.channelId].filter(Boolean)).filter(value=>available.has(value)));
  rule.channelIds=[...selected];rule.channelId=rule.channelIds[0]||'';
  const list=document.createElement('div');list.className='channel-check-list';
  for(const [value,text] of choices){
   const label=document.createElement('label');label.className='channel-check-option';
   const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.value=value;checkbox.checked=selected.has(value);
   checkbox.onchange=()=>{
    if(checkbox.checked)selected.add(value);else selected.delete(value);
    rule.channelIds=[...selected];rule.channelId=rule.channelIds[0]||'';
   };
   const name=document.createElement('span');name.textContent=text;label.append(checkbox,name);list.append(label);
  }
  if(!choices.length){const empty=document.createElement('p');empty.className='channel-empty';empty.textContent='利用可能なチャンネルがありません';list.append(empty);}
  wrapper.append(list);article.append(wrapper);
 } else {
  input = field(article, rule, 'channelId', '通知チャンネル', choices);
  input.onchange=()=>{rule.channelId=input.value;rule.channelIds=input.value?[input.value]:[];};
  if (!choices.length) selectOptions(input, [], '', '利用可能なチャンネルがありません');
  else if (!choices.some(([id]) => id === rule.channelId)) selectOptions(input, choices, '', 'チャンネルを選択');
 }
 const refresh = document.createElement('button');
 refresh.type = 'button';
 refresh.className = 'secondary channel-refresh';
 refresh.textContent = 'チャンネルを再取得';
 refresh.onclick = run(async () => {
  if (!rule.guildId) return status('先にサーバーを選択してください。');
  await loadChannels(rule.guildId, true);
  render();
  status('チャンネル一覧を更新しました。');
 });
 article.append(refresh);
}

function detailOptions(type) {
 if (type === 'earthquake') return options.earthquakeDetails;
 if (type === 'eew') return options.eewDetails;
 if (type === 'rain-radar') return [];
 return options.weatherDetails;
}

function conditionKinds(rule){
 const common=[['region','対象地方'],['detail','詳細種別']];
 if(rule.type==='rain-radar')return [['region','対象地方'],['radarCondition','雨雲レーダー（簡略版）の配信条件'],['rainfallThreshold','1時間降水量の下限']];
 return rule.type==='weather'?[...common,['weatherLevel','警戒レベル'],['warningLevel','警報・注意報']]:[...common,['intensity','震度の下限'],['magnitude','マグニチュードの下限']];
}
function conditionValues(rule,kind){
 if(kind==='region')return options.regions;
 if(kind==='detail')return detailOptions(rule.type);
 if(kind==='intensity')return INTENSITIES;
 if(kind==='weatherLevel')return options.weatherLevels;
 if(kind==='warningLevel')return options.warningLevels;
 if(kind==='radarCondition')return options.rainRadarConditions;
 return null;
}
function defaultConditionValue(rule,kind){return kind==='magnitude'?'4.0':kind==='rainfallThreshold'?'10':String(conditionValues(rule,kind)?.[0]?.[0]||'');}
function additionalConditionsField(article,rule){
 const wrapper=document.createElement('fieldset');wrapper.className='condition-builder';
 const legend=document.createElement('legend');legend.textContent='追加条件（Pro・最大8件）';wrapper.append(legend);
 const help=document.createElement('p');help.className='help';help.textContent=`上の「条件の組み合わせ」に従い、基本条件と追加条件を${rule.conditionLogic==='or'?'いずれか':'すべて'}判定します。`;wrapper.append(help);
 const list=document.createElement('div');list.className='condition-list';
 rule.conditions.forEach((condition,index)=>{
  const row=document.createElement('div');row.className='condition-row';
  const kind=document.createElement('select');kind.setAttribute('aria-label',`追加条件${index+1}の種類`);selectOptions(kind,conditionKinds(rule),condition.kind);
  const values=conditionValues(rule,condition.kind);
  const value=document.createElement(values?'select':'input');value.setAttribute('aria-label',`追加条件${index+1}の値`);
  if(values)selectOptions(value,values,String(condition.value??''));else{value.value=String(condition.value??'');value.inputMode='decimal';value.placeholder=condition.kind==='rainfallThreshold'?'0.1〜20 mm/h':'0〜10';}
  kind.onchange=()=>{condition.kind=kind.value;condition.value=defaultConditionValue(rule,condition.kind);render();};
  value.onchange=()=>{condition.value=value.value;};
  const remove=document.createElement('button');remove.type='button';remove.className='condition-remove';remove.textContent='条件を削除';remove.onclick=()=>{rule.conditions.splice(index,1);render();};
  row.append(kind,value,remove);list.append(row);
 });
 wrapper.append(list);
 const add=document.createElement('button');add.type='button';add.className='secondary';add.textContent='＋ 条件を追加';add.disabled=rule.conditions.length>=8;
 add.onclick=()=>{const kind=conditionKinds(rule)[0][0];rule.conditions.push({kind,operator:'equals',value:defaultConditionValue(rule,kind)});render();};
 wrapper.append(add);article.append(wrapper);
}

function normalizeRule(rule) {
 let type = TYPES.some(([value]) => value === rule.type) || isImageType(rule.type) ? rule.type : 'earthquake';
 // 時系列だけの表のルールは、独立した種類（時系列予想）として開く
 if(type==='warning-table'&&Array.isArray(rule.tables)&&rule.tables.length===1&&rule.tables[0]==='timeseries')type='warning-timeseries';
 const detail = type === 'eew' && rule.detail === 'intensity-change' ? 'forecast' : (rule.detail || 'all');
 return {
  ...rule,
  type,
  detail,
  sendFinalReport:rule.sendFinalReport!==false,
  region: rule.region || 'all',
  prefecture: rule.prefecture || 'all',
  district: rule.district || 'all',
  municipality: rule.municipality || 'all',
  strictMunicipality: rule.strictMunicipality===true,
  intensityMode: rule.intensityMode || (rule.intensityChange === 'increase' ? 'increase' : rule.intensity ? 'threshold' : 'all'),
  intensity: rule.intensity || '4',
  magnitudeMode: rule.magnitudeMode || (rule.magnitudeChange === 'increase' ? 'increase' : rule.magnitudeMin !== null && rule.magnitudeMin !== undefined && rule.magnitudeMin !== '' ? 'threshold' : 'all'),
  magnitudeMin: rule.magnitudeMin ?? '',
  weatherLevel: rule.weatherLevel || 'all',
  warningLevel: rule.warningLevel || 'all',
  eewWarningAreaMode: rule.eewWarningAreaMode || 'all',
  radarCondition: rule.radarCondition || (type==='hires-radar'?'scheduled':'all'),
  linearRainband: rule.linearRainband===true,
  includeTables: rule.includeTables!==false,
  enlargedArea: rule.enlargedArea===true,
  products: Array.isArray(rule.products)&&rule.products.length?rule.products.filter(id=>(type==='earthquake-map'?EARTHQUAKE_MAP_LEGACY_PRODUCT_IDS:WEATHER_MAP_PRODUCT_IDS).includes(id)):defaultProducts(type),
  // eew-map / warning-table: selected image regions (no "all"); warning-table: tables and timing.
  regions: Array.isArray(rule.regions)?rule.regions.map(String).filter(id=>id&&id!=='all'):[],
  tables: Array.isArray(rule.tables)&&rule.tables.length?rule.tables.filter(id=>id in WARNING_TABLE_FEATURES):defaultWarningTables(),
  deliverOn: rule.deliverOn==='every'?'every':'changed',
  showAllAreas: rule.showAllAreas===true,
  // tsunami-map: 地図・表・津波観測の表
  tsunamiOutputs: savedTsunamiOutputs(rule),
  minIntensity: typeof rule.minIntensity==='string'?rule.minIntensity:'',
  minLgInt: typeof rule.minLgInt==='string'?rule.minLgInt:'',
  regionMinIntensity: rule.regionMinIntensity&&typeof rule.regionMinIntensity==='object'&&!Array.isArray(rule.regionMinIntensity)?{...rule.regionMinIntensity}:{},
  centerMunicipality: typeof rule.centerMunicipality==='string'?rule.centerMunicipality:'',
  centerPrefecture: typeof rule.centerPrefecture==='string'?rule.centerPrefecture:(typeof rule.centerMunicipality==='string'?rule.centerMunicipality.slice(0,2):''),
  minSeverity: rule.minSeverity==='advisory'?'advisory':'warning',
  municipalities: Array.isArray(rule.municipalities)?rule.municipalities.map(String):[],
  municipalityDetail: rule.municipalityDetail===true,
  rainfallThresholdMmPerHour: rule.rainfallThresholdMmPerHour ?? '',
  deliveryIntervalHours: String(rule.deliveryIntervalHours || '1'),
  // hires-radar: 送るもの（現在の図・予想）と、それぞれの配信頻度（分）
  radarContents: Array.isArray(rule.radarContents)&&rule.radarContents.length?RADAR_CONTENT_IDS.filter(id=>rule.radarContents.includes(id)):['current'],
  deliveryIntervalMinutes: Number(rule.deliveryIntervalMinutes)||(type==='hires-radar'?(Number(rule.deliveryIntervalHours)||1)*60:60),
  forecastIntervalMinutes: Number(rule.forecastIntervalMinutes)||60,
  channelIds: Array.isArray(rule.channelIds)&&rule.channelIds.length?rule.channelIds:[rule.channelId].filter(Boolean),
  conditionLogic: rule.conditionLogic || 'and',
  conditions: Array.isArray(rule.conditions)?rule.conditions.slice(0,8).map(condition=>({kind:String(condition.kind||'region'),operator:String(condition.operator||'equals'),value:condition.value??'all'})):[],
 };
}

function savedRules(account){
 try{
  const settings=JSON.parse(account?.settings_json||'{}');
  return Array.isArray(settings.rules)?settings.rules.map(normalizeRule):[];
 }catch{return [];}
}


function geoScopeFields(container,rule){
 if(rule.region==='all')return;
 if(rule.type!=='rain-radar')helpNote(container,AREA_NOTE);
 const prefectures=(options.prefectures||[]).filter(item=>item.region===rule.region).map(item=>[item.code,item.name]);
 const prefecture=field(container,rule,'prefecture','都道府県・全域',[['all','地方全域'],...prefectures]);
 prefecture.disabled=!entitlements.prefecture||rule.type==='rain-radar';
 if(rule.type==='rain-radar'&&entitlements.prefecture){
  const note=document.createElement('p');note.className='geo-upgrade';
  note.textContent='雨雲レーダー（簡略版）の取得元は地方単位の画像です。精密な都道府県・市区町村判定には非対応のため選択できません。';
  container.append(note);return;
 }
 if(!entitlements.prefecture){
  const note=document.createElement('p');note.className='geo-upgrade';note.textContent='都道府県単位の配信はPlus版以上にアップグレードしてください。';container.append(note);
  return;
 }
 if(rule.prefecture==='all')return;
 if(rule.type==='eew'){
  const city=field(container,rule,'municipality','市区町村・全域',[['all','選択地域の全域']]);
  city.disabled=true;
  const note=document.createElement('p');note.className='geo-upgrade';note.textContent='緊急地震速報は市区町村単位の対象判定を保証できないため、都道府県までの選択となります。';container.append(note);return;
 }
 if(rule.prefecture==='01'){
  const districts=areaCatalogue.districts.filter(item=>item.prefectureCode==='01').map(item=>[item.code,item.name]);
  const district=field(container,rule,'district','北海道内の地方・全域',[['all','北海道全域'],...districts]);
  district.disabled=areaCatalogueFailed||!districts.length;
 }
 if(!entitlements.municipality){
  const note=document.createElement('p');note.className='geo-upgrade';
  note.textContent=rule.municipality&&rule.municipality!=='all'
   ?'この市区町村指定は現在のPlus以下の契約では利用できず、配信対象から除外されています。Proへの変更、または以下の操作で指定を解除して保存してください。'
   :'市区町村の指定はPro版以上、または市区町村権限を付与されたカスタムプランで利用できます。';
  container.append(note);
  if(rule.municipality&&rule.municipality!=='all'){
   const reset=document.createElement('button');reset.type='button';reset.className='secondary-btn';
   reset.textContent='市区町村指定を解除する（保存前に確認）';
   reset.addEventListener('click',()=>{
    if(!window.confirm('このルールの市区町村指定を解除すると、都道府県など、より広い範囲が対象になります。変更を保存するまでは反映されません。続行しますか？'))return;
    rule.municipality='all';rule.strictMunicipality=false;render();
    status('市区町村指定を解除しました。対象範囲を確認し、通知設定を保存してください。');
   });
   container.append(reset);
  }
  return;
 }
 const cities=areaCatalogue.municipalities.filter(item=>item.prefectureCode===rule.prefecture&&(rule.district==='all'||item.districtCode===rule.district)).map(item=>[item.code,item.name]);
 const municipality=field(container,rule,'municipality','市区町村・全域',[['all','選択地域の全域'],...cities]);
 municipality.disabled=areaCatalogueFailed||!cities.length;
 if(areaCatalogueFailed||!cities.length){
  const note=document.createElement('p');note.className='geo-upgrade';note.textContent='気象庁の市区町村データを取得できませんでした。地域一覧を再読み込みしてください。';container.append(note);
 }
 if(rule.municipality!=='all'){
  const label=document.createElement('label');label.className='geo-strict-option';
  const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=rule.strictMunicipality===true;checkbox.disabled=!entitlements.strictMunicipality;
  checkbox.onchange=()=>{rule.strictMunicipality=checkbox.checked;};
  const description=document.createElement('span');description.textContent=entitlements.strictMunicipality
   ?'指定した市区町村の情報のみ表示・配信する（従来の広域本文と切替）'
   :'指定した市区町村の情報のみ表示・配信する（Pro版にアップグレード）';
  label.append(checkbox,description);container.append(label);
 }
}

function removeButton(index){
 const remove = document.createElement('button');
 remove.type = 'button';
 remove.className = 'danger';
 remove.textContent = '削除';
 remove.onclick = () => { rules.splice(index, 1); render(); };
 return remove;
}

function upgradeNote(container,text){
 const note=document.createElement('p');note.className='geo-upgrade';note.textContent=text;container.append(note);return note;
}

function checkboxField(container,rule,key,text,disabled=false){
 const label=document.createElement('label');label.className='geo-strict-option';
 const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=rule[key]===true;checkbox.disabled=disabled;
 checkbox.onchange=()=>{rule[key]=checkbox.checked;};
 const description=document.createElement('span');description.textContent=text;
 label.append(checkbox,description);container.append(label);
 return checkbox;
}

function checkboxGroup(container,legendText,choices,selected,onChange,limit=Infinity){
 const wrapper=document.createElement('fieldset');wrapper.className='multi-channel-field';
 const legend=document.createElement('legend');legend.textContent=legendText;wrapper.append(legend);
 const list=document.createElement('div');list.className='channel-check-list';
 for(const [value,text] of choices){
  const label=document.createElement('label');label.className='channel-check-option';
  const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.value=value;checkbox.checked=selected.includes(value);
  checkbox.onchange=()=>{
   const next=checkbox.checked?[...selected,value]:selected.filter(item=>item!==value);
   if(next.length>limit){checkbox.checked=false;status(`選択できるのは${limit}件までです。`);return;}
   selected=next;onChange(next);
  };
  const name=document.createElement('span');name.textContent=text;label.append(checkbox,name);list.append(label);
 }
 wrapper.append(list);container.append(wrapper);
 return wrapper;
}

function plainSelect(container,label,values,current,onChange){
 const wrapper=document.createElement('label');
 const caption=document.createElement('span');caption.textContent=label;
 const input=document.createElement('select');selectOptions(input,values,current);
 input.onchange=()=>onChange(input.value);
 wrapper.append(caption,input);container.append(wrapper);
 return input;
}

async function loadEarthquakeCities(){
 if(earthquakeCitiesState!=='idle')return;
 earthquakeCitiesState='loading';
 try{
  const response=await fetch(options?.earthquakeMunicipalitiesPath||'/site/supporter/earthquake-municipalities.json',{credentials:'same-origin',headers:{Accept:'application/json'}});
  if(!response.ok)throw new Error('unavailable');
  const data=await response.json();
  earthquakeCities=data?.prefectures&&typeof data.prefectures==='object'?data.prefectures:{};
  earthquakeCitiesState='ready';
 }catch{earthquakeCities=null;earthquakeCitiesState='failed';}
 render();
}

// earthquake-map (地震情報の図). Plus: the kinds of info only. Pro: thresholds and the map centre.
// Pro-only values are never sent for a Plus rule (the home server would drop the whole rule).
function earthquakeMapFields(box,rule){
 checkboxGroup(box,'送る地震情報の種類（1つ以上）',options.earthquakeMapProducts||[],rule.products,next=>{rule.products=next;});
 if(rule.products.includes('VXSE43'))helpNote(box,'このルールには以前の設定の「緊急地震速報（警報）の図」も含まれています（引き続き配信されます）。新しく設定する場合は情報種別「緊急地震速報（警報）の図」を使ってください。');
 upgradeNote(box,'選択した種類の地震情報が発表されるたびに、震度分布や震源を描いた図を配信します。');
 const proSaved=Boolean(rule.minIntensity)||Object.values(rule.regionMinIntensity||{}).some(Boolean)||Boolean(rule.minLgInt)||Boolean(rule.centerMunicipality);
 if(!entitlements.earthquakeMapFilter){
  if(proSaved){
   upgradeNote(box,'保存済みの震度のしきい値・地図の中心の指定は現在の契約では使えません（しきい値のあるルールは、すべての地震へ自動で広げずに配信を止めています）。Proへ変更するか、Pro限定の設定を解除して保存してください。');
   const clear=document.createElement('button');clear.type='button';clear.textContent='Pro限定の設定を解除する';
   clear.onclick=()=>{rule.minIntensity='';rule.regionMinIntensity={};rule.minLgInt='';rule.centerMunicipality='';rule.centerPrefecture='';render();};
   box.append(clear);
  }else upgradeNote(box,'震度・長周期地震動階級のしきい値（全国・地方別）と地図の中心にする市区町村の指定はPro以上のプランで利用できます。');
  return;
 }
 const intensities=options.earthquakeMapIntensities||[];
 plainSelect(box,'震度のしきい値（全国の最大震度・Pro）',[['','指定しない'],...intensities],rule.minIntensity,value=>{rule.minIntensity=value;});
 const regional=document.createElement('fieldset');regional.className='multi-channel-field';
 const legend=document.createElement('legend');legend.textContent='地方別の震度しきい値（Pro・その地方の府県で観測した最大震度で判定）';regional.append(legend);
 const regionLabels=new Map((options.regions||[]).map(([id,text])=>[id,text]));
 const grid=document.createElement('div');grid.className='rule-condition-fields';
 for(const region of options.earthquakeMapRegions||[]){
  plainSelect(grid,regionLabels.get(region)||region,[['','指定しない'],...intensities],rule.regionMinIntensity?.[region]||'',value=>{
   const next={...rule.regionMinIntensity};
   if(value)next[region]=value;else delete next[region];
   rule.regionMinIntensity=next;
  });
 }
 regional.append(grid);box.append(regional);
 plainSelect(box,'長周期地震動階級のしきい値（長周期地震動に関する観測情報だけに適用・Pro）',[['','指定しない'],...(options.earthquakeMapLgClasses||[])],rule.minLgInt||'',value=>{rule.minLgInt=value;});
 upgradeNote(box,'しきい値を1つも指定しない場合は、選択した種類の地震情報をすべて配信します。複数指定した場合は、いずれか1つを満たすと配信します。震源に関する情報は、同じ地震の震度速報の震度で判定します。長周期地震動階級のしきい値は長周期地震動に関する観測情報だけに使い、震度速報・震源・各地の震度の配信には影響しません。');
 const prefectures=(options.prefectures||[]).map(item=>[item.code,item.name]);
 plainSelect(box,'地図の中心にする市区町村：都道府県（Pro）',[['','指定しない（震度分布に合わせて自動）'],...prefectures],rule.centerPrefecture||'',value=>{rule.centerPrefecture=value;rule.centerMunicipality='';render();});
 if(rule.centerPrefecture){
  if(earthquakeCitiesState==='idle'||earthquakeCitiesState==='loading'){
   upgradeNote(box,'市区町村の一覧を読み込んでいます…');
   loadEarthquakeCities();
  }else if(earthquakeCitiesState==='failed'||!Array.isArray(earthquakeCities?.[rule.centerPrefecture])){
   upgradeNote(box,'市区町村の一覧を取得できませんでした。ページを再読み込みしてください。');
  }else{
   plainSelect(box,'地図の中心にする市区町村（Pro）',[['','市区町村を選択してください'],...earthquakeCities[rule.centerPrefecture]],rule.centerMunicipality||'',value=>{rule.centerMunicipality=value;});
   upgradeNote(box,'指定した市区町村を地図の中心にし、最大震度を観測した地域と震源も入るように範囲を広げます。市区町村を選ばない場合は自動で決めます。');
  }
 }
}

// New warning-table rule: the national table when the plan has it, otherwise the first allowed table.
function defaultWarningTables(){
 const allowed=['national','regional'].filter(id=>entitlements?.[WARNING_TABLE_FEATURES[id]]===true);
 return allowed.includes('national')?['national']:(allowed.length?[allowed[0]]:['national']);
}

// Neutral help text (upgradeNote is the yellow warning style).
function helpNote(container,text){
 const note=document.createElement('p');note.className='rule-help';note.textContent=text;container.append(note);return note;
}
function regionChoices(){
 return (options.regions||[]).filter(([id])=>id!=='all');
}

// 見本（サンプル画像）。/site/supporter/previews/<name>.png が無いときは枠ごと隠す。
// 見本を押すと拡大表示（preview-lightbox.js）が開き、ルールの今の設定に合う見本から、同じ種類の他の見本も見られる。
// items: [name, caption, type, prefer, group]（prefer = 拡大表示で最初に出したい見本のファイル名の候補。無ければ <name>.png。
// group = 拡大表示で ← / → で切り替えるまとまり。全国の見本なら全国だけ、地方なら地方だけ）
function previewImages(container,items){
 if(!items.length)return;
 const wrap=document.createElement('div');wrap.className='rule-preview';
 for(const [name,caption,type,prefer,group] of items){
  const file=name.endsWith('.gif')?name:`${name}.png`;
  const figure=document.createElement('figure');figure.className='rule-preview-item';
  const label=document.createElement('span');label.className='rule-preview-label';label.textContent='見本';
  const img=document.createElement('img');img.loading='lazy';img.decoding='async';img.src=PREVIEW_BASE+file;img.alt=`見本：${caption}`;
  img.addEventListener('error',()=>{figure.remove();if(!wrap.querySelector('figure'))wrap.remove();});
  const text=document.createElement('figcaption');text.textContent=caption;
  figure.append(label,img,text);wrap.append(figure);
  if(type)attachPreview(figure,type,{prefer:[...(prefer||[]),file],group:group||'',caption});
 }
 container.append(wrap);
}
// 地震情報の図: 選んだ情報の種類ごとの見本（最初に選んだ種類の見本を表示。地図の中心の指定があればその見本）
const EARTHQUAKE_PREVIEWS={VXSE51:'earthquake-map-shindo',VXSE52:'earthquake-map-hypocenter',VXSE53:'earthquake-map-detail',VXSE62:'earthquake-map-long-period'};
function rulePreviews(rule){
 const scope=rule.region&&rule.region!=='all'?'region':'national';
 const where=scope==='region'?'地方':'全国';
 // 地方を選んだルールは、その地方の見本があれば拡大表示でそれを最初に出す
 const regional=type=>scope==='region'?[`${type}-${rule.region}.png`]:[];
 if(rule.type==='weather-map'){
  const prefer=entitlements.weatherMunicipality&&rule.municipalityDetail?['weather-map-municipality.png']:regional('weather-map');
  return [[`weather-map-${scope}`,`気象警報・注意報の地図（${where}）`,'weather-map',prefer,scope]];
 }
 if(rule.type==='hires-radar')return rule.radarContents.map(id=>id==='forecast'
  ?['hires-radar-forecast.gif','雨雲レーダー（高解像度版）の予想','hires-radar',[],'forecast']
  :[`hires-radar-${scope}`,`雨雲レーダー（高解像度版）（${where}）`,'hires-radar',regional('hires-radar'),scope]);
 // 全国・地方を選ぶ場合も同じ図（配信する条件だけが違う）。
 if(rule.type==='eew-map')return [['eew-map-national','緊急地震速報（警報）の図（地方を選ぶ場合も同じ図です）','eew-map']];
 if(rule.type==='warning-timeseries')return [['warning-timeseries-1','気象警報・注意報の時系列予想','warning-timeseries']];
 if(rule.type==='warning-table'){
  const labels={national:'気象警報・注意報の表（全国）',regional:'気象警報・注意報の表（地方）'};
  const first=(rule.regions||[])[0];
  return rule.tables.filter(id=>id in labels).map(id=>[`warning-table-${id}`,labels[id],'warning-table',id==='regional'&&first?[`warning-table-regional-${first}.png`]:[],id]);
 }
 // 津波の図: 全国の図の見本（Pro の拡大図を使う設定なら地方の拡大図の見本）。表: 表の見本
 if(rule.type==='tsunami-map')return rule.tsunamiOutputs.map(id=>{
  if(id==='observation')return ['tsunami-map-observation','津波観測の表','tsunami-map',[],'table'];
  if(id!=='map')return ['tsunami-map-table','津波警報・注意報の表','tsunami-map',[],'table'];
  return entitlements.tsunamiEnlarged&&rule.enlargedArea===true
   ?['tsunami-map-enlarged','津波警報・注意報の図（地方の拡大図）','tsunami-map',[],'enlarged']
   :['tsunami-map-map','津波警報・注意報の図','tsunami-map',[],'map'];
 });
 if(rule.type==='earthquake-map'){
  const name=EARTHQUAKE_PREVIEWS[(rule.products||[]).find(id=>EARTHQUAKE_PREVIEWS[id])]||'earthquake-map-detail';
  const prefer=entitlements.earthquakeMapFilter&&rule.centerMunicipality?['earthquake-map-centre.png']:[];
  return [[name,'地震情報の図','earthquake-map',prefer]];
 }
 return [];
}

// eew-map (緊急地震速報（警報）の図). The image is the same; only WHEN it is sent differs.
const eewRegionMode=new WeakMap();
function eewMapFields(box,rule){
 const national='全国：緊急地震速報（警報）が発表されたら配信';
 const regional='地方を選ぶ（Plus以上）：選んだ地方が対象地域になったとき（続報で追加された場合も含む）に配信';
 if(!entitlements.eewMapRegion){
  if(rule.regions.length){
   upgradeNote(box,'保存済みの「地方を選ぶ」設定は現在の契約では使えないため、このルールは配信を止めています（全国へ自動で広げることはありません）。Plus以上へ変更するか、全国に切り替えて保存してください。');
   const reset=document.createElement('button');reset.type='button';reset.className='secondary';reset.textContent='全国に切り替える';
   reset.onclick=()=>{rule.regions=[];render();};box.append(reset);
   return;
  }
  helpNote(box,`${national}します。地方を選んで配信するのはPlus以上で使えます。`);
  return;
 }
 if(!eewRegionMode.has(rule))eewRegionMode.set(rule,rule.regions.length>0);
 const choose=eewRegionMode.get(rule);
 plainSelect(box,'配信する条件',[['national',national],['regions',regional]],choose?'regions':'national',value=>{
  eewRegionMode.set(rule,value==='regions');if(value!=='regions')rule.regions=[];render();
 });
 if(choose){checkboxGroup(box,'対象の地方（1つ以上・複数可）',regionChoices(),rule.regions,next=>{rule.regions=next;});helpNote(box,AREA_NOTE);}
}

// warning-table (気象警報・注意報の表): national (Plus+), regional (Pro+). warning-timeseries (時系列予想): Pro+.
function warningTableFields(box,rule){
 if(rule.type==='warning-timeseries'){
  checkboxGroup(box,'対象の地方（1つ以上・複数可）',regionChoices(),rule.regions,next=>{rule.regions=next;});
  helpNote(box,AREA_NOTE);
  warningTiming(box,rule);
  return;
 }
 const kinds=[...(options.warningTableKinds||[['national','全国の表'],['regional','地方の表']]),...(rule.tables.includes('timeseries')?[['timeseries','時系列予想']]:[])];
 const allowed=id=>entitlements[WARNING_TABLE_FEATURES[id]]===true;
 const shown=kinds.filter(([id])=>allowed(id)||rule.tables.includes(id));
 checkboxGroup(box,'送る表（1つ以上）',shown.map(([id,text])=>[id,allowed(id)?text:`${text}（現在の契約では配信されません）`]),rule.tables,next=>{rule.tables=next;render();});
 const hidden=kinds.filter(([id])=>!shown.some(([value])=>value===id));
 if(hidden.length)helpNote(box,`${hidden.map(([,text])=>text).join('・')}はProで使えます。`);
 if(rule.tables.includes('regional')||rule.tables.includes('timeseries')){
  checkboxGroup(box,'地方の表の対象地方（1つ以上・複数可）',regionChoices(),rule.regions,next=>{rule.regions=next;});
  helpNote(box,'地方の表は、選んだ地方に警報・注意報が発表されていないときは配信されません（すべて解除されたときは1回配信します）。');
 }
 warningTiming(box,rule);
}

function warningTiming(box,rule){
 const timing=(options.warningTableDeliverOn||[['changed','内容が変わったときだけ'],['every','発表のたびに毎回']])
  .filter(([id])=>id!=='every'||entitlements.warningTableEvery||rule.deliverOn==='every');
 plainSelect(box,'配信のタイミング',timing,rule.deliverOn,value=>{rule.deliverOn=value;render();});
 if(!entitlements.warningTableEvery)helpNote(box,rule.deliverOn==='every'
  ?'「発表のたびに毎回」は現在の契約では使えないため、「内容が変わったときだけ」として配信されます。'
  :'「発表のたびに毎回」配信するのはProで使えます。');
 checkboxField(box,rule,'showAllAreas','発表のない区域も表に載せる');
}

// hires-radar: 送るもの（現在の図・予想）と配信頻度。Plus は選択肢から、Pro は10分単位で自由に指定できる。
function radarMinutesField(box,label,minutes,max,apply){
 const hours=Math.floor(minutes/60),rest=minutes%60;
 const group=document.createElement('div');group.className='rule-interval';
 const set=(nextHours,nextRest)=>{
  const total=Math.min(max,Math.max(10,nextHours*60+nextRest));
  apply(total);render();
 };
 plainSelect(group,`${label}（時間）`,Array.from({length:max/60+1},(_,value)=>[String(value),`${value}時間`]),String(hours),value=>set(Number(value),rest));
 plainSelect(group,`${label}（分）`,[0,10,20,30,40,50].filter(value=>(hours>0||value>0)&&(hours*60+value<=max)).map(value=>[String(value),`${value}分`]),String(rest),value=>set(hours,Number(value)));
 box.append(group);
}
function radarContentFields(box,rule){
 const limits=options.hiresRadarLimits||{max:1440,forecastMax:720};
 if(entitlements.hiresRadarForecast)checkboxGroup(box,'送るもの（1つ以上）',options.hiresRadarContents||[['current','現在の図'],['forecast','1時間先までの予想（GIF）']],rule.radarContents,next=>{rule.radarContents=next;render();});
 else if(rule.radarContents.includes('forecast')){
  upgradeNote(box,'保存済みの予想（GIF）は現在の契約では配信されません。Proへ変更するか、現在の図だけに切り替えて保存してください。');
  const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent='現在の図だけに切り替える';
  button.onclick=()=>{rule.radarContents=['current'];render();};box.append(button);
 }
 if(rule.radarContents.includes('current')){
  const choices=options.hiresRadarIntervals||[];
  if(entitlements.hiresRadarInterval)radarMinutesField(box,'配信頻度',Number(rule.deliveryIntervalMinutes)||60,limits.max,value=>{rule.deliveryIntervalMinutes=value;});
  else{
   if(!choices.some(([id])=>id===String(rule.deliveryIntervalMinutes))&&choices.length)
    rule.deliveryIntervalMinutes=Number((choices.find(([id])=>Number(id)>=Number(rule.deliveryIntervalMinutes))||choices.at(-1))[0]);
   plainSelect(box,'配信頻度',choices,String(rule.deliveryIntervalMinutes),value=>{rule.deliveryIntervalMinutes=Number(value);});
  }
 }
 if(entitlements.hiresRadarForecast&&rule.radarContents.includes('forecast')){
  radarMinutesField(box,'予想の配信頻度',Number(rule.forecastIntervalMinutes)||60,limits.forecastMax,value=>{rule.forecastIntervalMinutes=value;});
  helpNote(box,'予想は、実況から1時間先までを10分ごとに動かしたGIF画像です。現在の図とは別のメッセージで届きます。');
 }
 if(!entitlements.hiresRadarForecast)helpNote(box,'配信頻度の自由な指定（10分〜24時間）と、1時間先までの予想（GIF）はProで使えます。');
}

// Per-type settings of the paid image rules. Options the plan does not include are not shown;
// a one-line note says which plan adds them (saved values the plan no longer covers are warned).
function imageRuleFields(article,rule){
 const box=document.createElement('div');box.className='rule-condition-fields';
 article.append(box);
 if(!options.imageRulesEnabled){
  upgradeNote(box,'画像配信ルールは現在準備中のため配信されません。このルールを削除してから通知設定を保存してください。');
  return;
 }
 if(!imageTypeAllowed(entitlements,rule.type))upgradeNote(box,'この画像配信は現在の契約では利用できないため配信されません。プランを変更するか、このルールを削除してください。');
 if(rule.type==='earthquake-map'){earthquakeMapFields(box,rule);previewImages(box,rulePreviews(rule));return;}
 if(rule.type==='eew-map'){eewMapFields(box,rule);previewImages(box,rulePreviews(rule));return;}
 if(rule.type==='warning-table'||rule.type==='warning-timeseries'){warningTableFields(box,rule);previewImages(box,rulePreviews(rule));return;}
 // 津波: Basic は全国の地図だけ（地方・表・津波観測の表は Plus 以上）
 if(rule.type==='tsunami-map'&&!entitlements.tsunamiMap&&entitlements.tsunamiMapNational){
  const fits=rule.region==='all'&&rule.tsunamiOutputs.length===1&&rule.tsunamiOutputs[0]==='map'&&rule.enlargedArea!==true;
  if(!fits){
   upgradeNote(box,'保存済みの地方・表・津波観測の表の設定は現在の契約では使えません（地方のルールを全国へ自動で広げることはありません）。Plus以上へ変更するか、全国の地図に切り替えて保存してください。');
   const button=document.createElement('button');button.type='button';button.textContent='全国の地図に切り替える';
   button.onclick=()=>{rule.region='all';rule.tsunamiOutputs=['map'];rule.enlargedArea=false;render();};
   box.append(button);
  }
  helpNote(box,'全国の地図を、津波注意報以上が発表されたとき、または津波予報だけが発表されたときに配信します。地方の地図・表・津波観測の表はPlus以上で使えます。');
  previewImages(box,rulePreviews(rule));
  return;
 }
 field(box,rule,'region','対象地方（全国・地方）',options.regions);
 if(rule.region!=='all')helpNote(box,rule.type!=='hires-radar'?AREA_NOTE
  :rule.radarCondition==='rainfall-threshold'?'選んだ地方で閾値以上の雨を観測していないときは配信されません。'
  :'定時配信は、雨の有無にかかわらず選んだ地方の図を配信します。');
 if(rule.type==='hires-radar'){
  if(!['scheduled','rainfall-threshold'].includes(rule.radarCondition))rule.radarCondition='scheduled';
  checkboxField(box,rule,'linearRainband','線状降水帯の発生情報を重ねて表示する');
  const conditions=(options.hiresRadarConditions||[]).filter(([id])=>id!=='rainfall-threshold'||entitlements.hiresRadarThreshold||rule.radarCondition==='rainfall-threshold');
  field(box,rule,'radarCondition','配信条件',conditions);
  if(!entitlements.hiresRadarThreshold){
   if(rule.radarCondition==='rainfall-threshold')upgradeNote(box,'保存済みの閾値配信は現在の契約では配信されません（定時配信へ自動で広げることはありません）。Proへ変更するか、配信条件を選び直してください。');
   else helpNote(box,'1時間降水量が閾値（10〜80mm/h）以上のときだけ配信するのはProで使えます。');
  }
  if(rule.radarCondition==='rainfall-threshold'){
   const thresholds=options.hiresRadarThresholds||[];
   if(!thresholds.some(([id])=>id===String(rule.rainfallThresholdMmPerHour)))rule.rainfallThresholdMmPerHour=thresholds[0]?.[0]||'10';
   else rule.rainfallThresholdMmPerHour=String(rule.rainfallThresholdMmPerHour);
   field(box,rule,'rainfallThresholdMmPerHour','1時間降水量の閾値',thresholds).disabled=!entitlements.hiresRadarThreshold;
  }
  radarContentFields(box,rule);
  previewImages(box,rulePreviews(rule));
  return;
 }
 if(rule.type==='tsunami-map'){
  checkboxGroup(box,'送るもの（1つ以上）',options.tsunamiMapOutputs||[['map','地図'],['table','表（満潮時刻を含む）'],['observation','津波観測の表（沖合・沿岸）']],rule.tsunamiOutputs,next=>{rule.tsunamiOutputs=next;render();});
  helpNote(box,'地図・表・津波観測の表を別々のチャンネルへ送るときは、ルールを分けて作成してください（それぞれ1ルールとして数えます）。');
  if(rule.tsunamiOutputs.includes('map')){
   if(entitlements.tsunamiEnlarged)checkboxField(box,rule,'enlargedArea','発表地域の拡大図を追加する');
   else if(rule.enlargedArea===true){
    upgradeNote(box,'発表地域拡大版は現在の契約では添付されません。Proへ変更するか、チェックを外して保存してください。');
    checkboxField(box,rule,'enlargedArea','発表地域の拡大図を追加する（Pro）');
   }else helpNote(box,'発表地域の拡大図を追加するのはProで使えます。');
  }
  helpNote(box,'選択した地方に津波注意報以上が発表されたとき、または津波予報だけが発表されたときに配信します。津波観測の表は、津波注意報以上が発表されている間に配信します。');
  previewImages(box,rulePreviews(rule));
  return;
 }
 checkboxGroup(box,'対象の警報・注意報（1つ以上）',options.weatherMapProducts||[],rule.products,next=>{rule.products=next;});
 helpNote(box,'その他注意報は一覧表、竜巻注意情報と線状降水帯は図で配信します（いずれも選択した場合のみ）。');
 field(box,rule,'minSeverity','配信基準',options.weatherMapSeverities||[]);
 const proScoped=(rule.prefecture&&rule.prefecture!=='all')||rule.municipalities.length>0||rule.municipalityDetail;
 if(!entitlements.weatherMunicipality){
  if(proScoped)upgradeNote(box,'保存済みの都道府県・市区町村の指定は現在の契約では配信されません（地方全域へ自動で広げることはありません）。Proへ変更するか、ルールを作り直してください。');
  else helpNote(box,'都道府県・市区町村の指定と市区町村の詳細はProで使えます。');
  previewImages(box,rulePreviews(rule));
  return;
 }
 const prefectures=(options.prefectures||[]).filter(item=>rule.region==='all'||item.region===rule.region).map(item=>[item.code,item.name]);
 field(box,rule,'prefecture','都道府県（Pro）',[['all','指定しない（地方全域）'],...prefectures]);
 if(rule.prefecture&&rule.prefecture!=='all'){
  const cities=areaCatalogue.municipalities.filter(item=>item.prefectureCode===rule.prefecture).map(item=>[item.code,item.name]);
  if(areaCatalogueFailed||!cities.length)upgradeNote(box,'気象庁の市区町村データを取得できませんでした。地域一覧を再読み込みしてください。');
  else checkboxGroup(box,`市区町村（Pro・最大${options.maxWeatherMunicipalities||50}件・未選択なら都道府県全域）`,cities,rule.municipalities,next=>{rule.municipalities=next;},options.maxWeatherMunicipalities||50);
 }
 checkboxField(box,rule,'municipalityDetail','市区町村ごとの詳細を表示する（Pro）');
 previewImages(box,rulePreviews(rule));
}

function render() {
 $('rules').replaceChildren();
 if(!hasConfigurableContract)return;
 rules.forEach((rule, index) => {
  const article = document.createElement('article');
  article.className = 'rule';
  const heading = document.createElement('h3');
  heading.textContent = `通知ルール ${index + 1}`;
  article.append(heading);
  field(article, rule, 'name', 'ルール名', null, {maxlength:'80'});
  field(article, rule, 'guildId', 'サーバー', session.guilds.map(guild => [guild.id, guild.name]));
  if(index>0&&rules[0]?.guildId&&rule.guildId!==rules[0].guildId){
   const warning=document.createElement('p');warning.className='server-warning';warning.setAttribute('role','alert');
   const used=new Set(rules.slice(0,index+1).map(item=>item.guildId).filter(Boolean)).size;
   warning.textContent=`別サーバーを使用しています（${used}/${entitlements.servers}サーバー）。上限を超える場合はサーバー追加オプションが必要です。`;
   article.append(warning);
  }
  channelField(article, rule);
  field(article, rule, 'type', '情報種別', typeChoices(rule));
  if(isImageType(rule.type)){
   imageRuleFields(article,rule);
   article.append(removeButton(index));
   $('rules').append(article);
   return;
  }
  if(rule.type!=='rain-radar')field(article, rule, 'detail', '詳細', detailOptions(rule.type));
  if(entitlements.complexConditions)field(article, rule, 'conditionLogic', '条件の組み合わせ', [['and','すべて満たす（AND）'],['or','いずれかを満たす（OR）']]);
  if (rule.type === 'eew'){
   const finalLabel=document.createElement('label');finalLabel.className='eew-final-report-option';
   const finalCheck=document.createElement('input');finalCheck.type='checkbox';finalCheck.role='switch';finalCheck.checked=rule.sendFinalReport!==false;
   const finalStatus=document.createElement('span');finalStatus.className='eew-final-status';finalStatus.textContent=finalCheck.checked?'ON':'OFF';
   finalCheck.addEventListener('change',()=>{rule.sendFinalReport=finalCheck.checked;finalStatus.textContent=finalCheck.checked?'ON':'OFF';});
   finalLabel.append(finalCheck,document.createTextNode(' 最終報を送信する'),finalStatus);
   const finalHelp=document.createElement('small');finalHelp.textContent='OFF：予想最大震度が変わらない最終報を省略します。';
   finalLabel.append(finalHelp);
   article.append(finalLabel);
   if(rule.detail==='warning')field(article, rule, 'eewWarningAreaMode', '警報地方の条件', options.eewWarningAreaModes);
  }
  const conditionFields=document.createElement('div');conditionFields.className='rule-condition-fields';
  field(conditionFields, rule, 'region', '対象地方', options.regions);
  geoScopeFields(conditionFields,rule);
  if (rule.type === 'rain-radar') {
   field(conditionFields, rule, 'radarCondition', '配信条件', entitlements.rainfallThreshold?options.rainRadarConditions:options.rainRadarConditions.filter(([id])=>id!=='rainfall-threshold'));
   if(!entitlements.rainfallThreshold){
    const note=document.createElement('p');note.className='geo-upgrade';
    note.textContent=rule.radarCondition==='rainfall-threshold'
     ?'保存済みの降水量閾値ルールはBasicでは配信されません。Plus以上へ変更するか、配信条件を明示的に選び直してください。'
     :'1時間降水量の閾値指定はPlus以上のプランで利用できます。';
    conditionFields.append(note);
   }
   if(rule.radarCondition==='rainfall-threshold'&&entitlements.rainfallThreshold)field(conditionFields, rule, 'rainfallThresholdMmPerHour', '1時間降水量の閾値（mm/h・最大20）', null, {inputmode:'decimal',min:'0.1',max:'20',step:'0.1'});
   field(conditionFields, rule, 'deliveryIntervalHours', '配信頻度', options.rainRadarIntervals);
  } else if (rule.type === 'weather') {
   if (WEATHER_ALERT_DETAILS.has(rule.detail)) field(conditionFields, rule, 'weatherLevel', '警戒レベル', options.weatherLevels);
   if (WEATHER_WARNING_DETAILS.has(rule.detail)) field(conditionFields, rule, 'warningLevel', '警報・注意報', options.warningLevels);
  } else {
   const intensityRow=document.createElement('div');intensityRow.className='intensity-condition-row';
   field(intensityRow, rule, 'intensityMode', '震度の通知条件', options.thresholdModes);
   if(rule.intensityMode==='threshold')field(intensityRow, rule, 'intensity', '震度の閾値', INTENSITIES);
   conditionFields.append(intensityRow);
   const magnitudeRow=document.createElement('div');magnitudeRow.className='magnitude-condition-row';
   field(magnitudeRow, rule, 'magnitudeMode', 'マグニチュードの通知条件', options.thresholdModes);
   if(rule.magnitudeMode==='threshold')field(magnitudeRow, rule, 'magnitudeMin', 'マグニチュードの閾値', null, {inputmode:'decimal',placeholder:'0〜10'});
   conditionFields.append(magnitudeRow);
  }
  article.append(conditionFields);
  if(entitlements.complexConditions)additionalConditionsField(article,rule);
  article.append(removeButton(index));
  $('rules').append(article);
 });
}

function setRuleAccess(enabled){
 hasConfigurableContract=enabled===true;
 $('add').disabled=!hasConfigurableContract;
 $('save').disabled=!hasConfigurableContract;
 $('rules-lock').classList.toggle('hidden',hasConfigurableContract);
 render();
}

// 準備中（メンテナンス中）：案内を出し、申込み・支払い・設定のボタンを押せなくする（サーバー側でも拒否する）。
function applyIntakePaused(paused) {
 $('intake-paused-notice')?.classList.toggle('hidden', paused !== true);
 document.body.classList.toggle('intake-paused', paused === true);
}
async function checkIntakePaused() {
 try {
  const response = await fetch('/api/supporter/plans', {credentials:'same-origin', cache:'no-store', headers:{Accept:'application/json'}});
  if (response.ok) applyIntakePaused((await response.json()).intakePaused === true);
 } catch { /* 案内を出せなくても、受付はサーバー側で止まっている。 */ }
}

// 契約の有無を確かめられないときも、「確認しています…」のままにしない。
function showPlanBanner(text){const banner=$('current-plan-banner');if(!banner)return;banner.classList.remove('has-active-plan');banner.textContent=text;}
async function load() {
 try{await loadAccount();}
 catch(error){if($('user').textContent==='確認中…')$('user').textContent='確認できませんでした。';failBilling();throw error;}
}
function failBilling(){
 creditBalanceFailed=!creditBalanceLoaded;
 showPlanBanner('現在の契約プランを確認できませんでした。時間をおいて、画面を再読み込みしてください。');
 updateCheckoutAvailability();
}
async function loadAccount() {
 checkIntakePaused();
 session = await api('/api/reuse/session');
 if (!session.authenticated) {
  $('user').textContent = 'Discordログインが必要です。';
  showPlanBanner('Discordでログインすると、現在の契約プランを確認できます。');
  updateCheckoutAvailability();
  return;
 }
 $('user').textContent = session.user.username;
 options = await api('/api/supporter/options');
 try{const data=await api('/api/supporter/areas');areaCatalogue={municipalities:data.municipalities||[],districts:data.districts||[]};areaCatalogueFailed=false;}
 catch(error){areaCatalogue={municipalities:[],districts:[]};areaCatalogueFailed=true;status(error.message);}
 const {account,billingEnabled,intakePaused} = await api('/api/supporter/account');
 applyIntakePaused(intakePaused);
 stripeBillingEnabled=billingEnabled===true;
 applyAccountEnforcement({suspended:account?.account_status==='suspended',status:account?.account_status||'active',reason:account?.status_reason||'',updatedAt:account?.status_updated_at||null});
 topupButton.disabled=!billingAvailable;
 const savedBillingEmail=account?.billing_email || '';
 billingEmail.value=savedBillingEmail;
 topupEmail.value=savedBillingEmail;
 updateCheckoutAvailability();
 if(!billingAvailable)billingActionStatus.textContent=accountSuspended?'有料プランアカウントがBANされているため、申込み・チャージ・契約変更は利用できません。':'決済設定が完了していないため、現在は申し込みできません。';
 $('add').disabled = $('save').disabled = true;
 billingUnavailable=!billingEnabled;
 if(!billingEnabled){showPlanBanner('現在、契約プランを確認できません。');updateCheckoutAvailability();}
 // まだ登録していない人は、契約も残高も無い（申込み・チャージのときに登録される）。
 if(!account&&billingEnabled){renderCreditDetails({balance:0});renderContracts([]);}
 if (account) {
  revision = account.revision;
  rules = savedRules(account);
  await Promise.allSettled([...new Set(rules.map(rule => rule.guildId).filter(Boolean))].map(guildId => loadChannels(guildId)));
  render();
  if(billingEnabled){
   try{
    const billingState=await api('/api/supporter/billing/status');applyAccountEnforcement(billingState.accountEnforcement);
    renderCreditDetails(billingState.creditDetails||{balance:Number(billingState.credits||0)});renderContracts(billingState.subscriptions||[],billingState.dunning,billingState.customPlan,billingState.customCheckoutUrl,billingState.customChange,billingState.customChangeCheckoutUrl,billingState.unpaid);renderInvoices(billingState.invoices||[]);
    if(billingState.rulesAdjustment?.changed){
     revision=Number(billingState.rulesAdjustment.revision)||revision;
     rules=(billingState.rulesAdjustment.rules||[]).map(normalizeRule);
     await Promise.allSettled([...new Set(rules.map(rule=>rule.guildId).filter(Boolean))].map(guildId=>loadChannels(guildId)));
     render();
     const removed=Number(billingState.rulesAdjustment.removedRules||0),destinations=Number(billingState.rulesAdjustment.removedDestinations||0),simplified=Number(billingState.rulesAdjustment.simplifiedRules||0);
     status(`契約上限の変更を反映しました。${removed?`下側の通知ルールを${removed}件削除しました。`:''}${destinations?`上限を超える通知先を${destinations}件解除しました。`:''}${simplified?`下位プラン向けに${simplified}件の条件を調整しました。`:''}`);
    }
    const creditResult=new URLSearchParams(location.search).get('credit');
    const hasPendingTopup=(billingState.creditDetails?.topups||[]).some(item=>item.status==='pending');
    if(creditResult==='completed')status(billingState.creditTopupRecovery?.recovered>0?'支払い済みの事前チャージを残高へ反映しました。':hasPendingTopup?'銀行振込・コンビニ払いは、入金の確認後に残高へ反映します（確認まで利用できません）。':'事前チャージのお支払いを受け付けました。反映されていない場合は「残高・履歴を再読み込み」を押してください。');
    if(creditResult==='completed'&&billingState.creditTopupRecovery?.failed>0)status('支払いは確認できましたが、残高への反映処理に失敗しました。時間をおいて「残高・履歴を再読み込み」を押してください。');
    if(creditResult==='canceled')status('事前チャージをキャンセルしました。料金は発生していません。');
    if(billingState.recoveredSubscription)status('支払い済みの申込みから契約を復旧し、有料プランを有効化しました。');
    if(new URLSearchParams(location.search).get('custom')==='change-completed')status('カスタム契約の差額支払いを受け付けました。Stripeの決済確認後に新しい契約へ反映されます。');
   }catch{contract.textContent='契約情報を自動取得できませんでした。「契約・明細を更新」を押してください。';setRuleAccess(false);failBilling();}
  }
 }
}

function applyAccountEnforcement(state={}){
 accountSuspended=state?.suspended===true||state?.status==='suspended';
 billingAvailable=stripeBillingEnabled&&!accountSuspended;
 const panel=$('account-enforcement');
 panel.classList.toggle('hidden',!accountSuspended);
 panel.textContent=accountSuspended?`有料プランアカウントは管理者によりBANされています。${state.reason?` 理由: ${state.reason}`:''} BAN解除まで、プラン申込み、事前チャージ、契約変更および通知設定は利用できません。`:'';
 if(accountSuspended)setRuleAccess(false);
 if(typeof updateCheckoutAvailability==='function')updateCheckoutAvailability();
 if(topupButton)topupButton.disabled=!billingAvailable;
}

function run(fn) {
 return () => Promise.resolve().then(fn).catch(error => status(error.message));
}

$('reload').onclick = run(load);
$('add').onclick = run(async () => {
 if(!hasConfigurableContract)return status('通知設定は有料プランの契約後に利用できます。');
 if (rules.length >= entitlements.rules) return status(`現在のプランでは通知ルールは${entitlements.rules}件までです。`);
 const guildId = rules[0]?.guildId || session.guilds[0]?.id || '';
 rules.push(normalizeRule({name:'新しいルール',guildId,channelId:'',type:'earthquake'}));
 render();
 status('ルールを追加しました。チャンネルを取得しています…');
 if (!guildId) return status('ルールを追加しました。管理可能なサーバーがありません。');
 try {
  await loadChannels(guildId, true);
  render();
  status('ルールを追加しました。');
 } catch {
  status('ルールは追加しましたが、チャンネルを取得できませんでした。「チャンネルを再取得」を押してください。');
 }
});
$('save').onclick = run(async () => {
 if(!hasConfigurableContract)return status('通知設定は有料プランの契約後に利用できます。');
 const saveButton=$('save');
 if(saveButton.disabled)return;
 saveButton.disabled=true;
 try{
  const data = await api('/api/supporter/settings','PUT',{revision,rules});
  revision = data.revision;
  status('通知設定を保存しました。');
 }finally{saveButton.disabled=!hasConfigurableContract;}
});

const billing = $('billing');
billing.replaceChildren();
const title = document.createElement('h2');
title.textContent = 'お支払い・契約情報';
const application = document.createElement('div');
application.className = 'billing-application';
application.id='credit-payment-panel';
const applicationTitle = document.createElement('h3');
applicationTitle.textContent = 'プランの申込み・変更';
const emailLabel = document.createElement('label');
emailLabel.className = 'billing-email-label';
const emailCaption = document.createElement('span');
emailCaption.textContent = '連絡先メールアドレス';
const billingEmail = document.createElement('input');
billingEmail.id = 'billing-email';
billingEmail.type = 'email';
billingEmail.maxLength = 254;
billingEmail.autocomplete = 'email';
billingEmail.required = true;
billingEmail.placeholder = 'name@example.com';
const emailHelp = document.createElement('p');
emailHelp.className = 'help billing-email-help';
emailHelp.textContent = '契約・請求に関するお知らせに使用します。';
emailLabel.append(emailCaption,billingEmail);
application.append(applicationTitle,emailLabel,emailHelp);
const contract = document.createElement('div');
contract.className = 'contract';
contract.textContent = '契約情報を読み込んでいます…';
const credit = document.createElement('p');
credit.className = 'credit-balance';
credit.textContent = '事前チャージの残高: 0円';
const creditPanel=document.createElement('section');creditPanel.className='credit-panel';creditPanel.id='credit-topup-panel';creditPanel.tabIndex=-1;
const creditTitle=document.createElement('h3');creditTitle.textContent='事前チャージ';
const creditLead=document.createElement('p');creditLead.className='credit-lead';creditLead.textContent='カードを使わずに申し込む場合や、PayPay・コンビニ払い・銀行振込を使う場合は、先にここでチャージしてください。チャージした残高は、申込み・変更・毎月の更新で先に使われます。';
const topupReloadButton=document.createElement('button');topupReloadButton.type='button';topupReloadButton.className='secondary-btn credit-reload-button';topupReloadButton.textContent='残高・履歴を再読み込み';
const topupReloadStatus=document.createElement('p');topupReloadStatus.className='billing-action-status';topupReloadStatus.setAttribute('role','status');topupReloadStatus.setAttribute('aria-live','polite');
const topupReloadActions=document.createElement('div');topupReloadActions.className='credit-reload-actions';topupReloadActions.append(topupReloadButton,topupReloadStatus);
const creditExpiry=document.createElement('p');creditExpiry.className='credit-expiry';creditExpiry.textContent='チャージした残高の有効期限は、反映した日（入金の確認日）から1年間です。';
const topupControls=document.createElement('div');topupControls.className='credit-topup-controls';
const topupEmailLabel=document.createElement('label');topupEmailLabel.className='billing-email-label';
const topupEmailCaption=document.createElement('span');topupEmailCaption.textContent='連絡先メールアドレス';
const topupEmail=document.createElement('input');topupEmail.id='topup-email';topupEmail.type='email';topupEmail.maxLength=254;topupEmail.autocomplete='email';topupEmail.required=true;topupEmail.placeholder='name@example.com';
const topupEmailHelp=document.createElement('p');topupEmailHelp.className='help billing-email-help';topupEmailHelp.textContent='チャージ結果のお知らせに使用します。';
topupEmailLabel.append(topupEmailCaption,topupEmail);
const topupLabel=document.createElement('label');topupLabel.className='topup-amount-label';const topupCaption=document.createElement('span');topupCaption.textContent='チャージ金額（1円単位）';
const topupAmount=document.createElement('input');topupAmount.type='number';topupAmount.inputMode='numeric';topupAmount.min='500';topupAmount.max='100000';topupAmount.step='1';topupAmount.value='500';topupAmount.required=true;
topupLabel.append(topupCaption,topupAmount);
const topupPresets=document.createElement('div');topupPresets.className='credit-preset-buttons';
for(const amount of [500,1000,3000,5000]){const button=document.createElement('button');button.type='button';button.className='secondary-btn';button.textContent=`${amount.toLocaleString('ja-JP')}円`;button.onclick=()=>{topupAmount.value=String(amount);};topupPresets.append(button);}
const topupPaymentHelp=document.createElement('p');topupPaymentHelp.className='help';topupPaymentHelp.textContent='銀行振込・コンビニ払いは、入金の確認後に残高へ反映します。支払期限は、次の支払い画面でご確認ください。振込手数料は利用者の負担です。支払い画面に表示されない方法は、現在ご利用いただけません。';
// 正式リリース前の案内（正式リリース時に外す）
const creditConsent=document.createElement('label');creditConsent.className='credit-consent pre-release-notice';
const creditConsentInput=document.createElement('input');creditConsentInput.type='checkbox';creditConsentInput.required=true;
const creditConsentText=document.createElement('span');creditConsentText.append('β版（正式リリース前）の提供であり、不具合や配信停止が起こる場合があります。原則として補填はありません。',document.createElement('br'),'入金確認後にチャージ金額が残高へ反映され、反映した日から1年後に未使用分が失効すること、および');const creditConsentTerms=document.createElement('a');creditConsentTerms.href='/terms/terms.html';creditConsentTerms.target='_blank';creditConsentTerms.rel='noopener noreferrer';creditConsentTerms.textContent='利用規約';creditConsentText.append(creditConsentTerms,'を確認しました。');
creditConsent.append(creditConsentInput,creditConsentText);
const topupButton=document.createElement('button');topupButton.type='button';topupButton.className='primary-btn';topupButton.textContent='チャージ手続きへ';
topupButton.disabled=true;
const topupStatus=document.createElement('p');topupStatus.className='billing-action-status';topupStatus.setAttribute('role','status');topupStatus.setAttribute('aria-live','polite');
topupControls.append(topupEmailLabel,topupEmailHelp,topupLabel,topupPresets,topupPaymentHelp,creditConsent,topupButton,topupStatus);
const creditHistoryTitle=document.createElement('h4');creditHistoryTitle.textContent='チャージ・利用の履歴';
const creditHistory=document.createElement('div');creditHistory.className='credit-history';creditHistory.textContent='チャージ・利用の履歴はありません。';
creditPanel.append(creditTitle,creditLead,topupReloadActions,creditExpiry,topupControls,creditHistoryTitle,creditHistory);
billing.append(title,credit,contract,application,creditPanel);
const invoiceTitle=document.createElement('h3');invoiceTitle.className='invoice-title';invoiceTitle.textContent='支払い明細';
const invoiceHistory=document.createElement('div');invoiceHistory.className='invoice-history';invoiceHistory.textContent='契約後に請求明細を確認できます。';
const plan = document.createElement('select');
plan.setAttribute('aria-label','契約プラン');
selectOptions(plan,PLAN_OPTIONS,new URLSearchParams(location.search).get('plan')||'supporter');
const channelPacks = document.createElement('select');
channelPacks.setAttribute('aria-label','追加チャンネル');
selectOptions(channelPacks,CHANNEL_PACK_OPTIONS,0);
const serverPacks = document.createElement('select');
serverPacks.setAttribute('aria-label','追加サーバー');
selectOptions(serverPacks,SERVER_PACK_OPTIONS,0);
const rulePacks=document.createElement('select');rulePacks.setAttribute('aria-label','追加ルール');selectOptions(rulePacks,RULE_PACK_OPTIONS,0);
const optionGrid=document.createElement('div');optionGrid.className='billing-options';
for(const [labelText,input] of [['プラン',plan],['チャンネル追加',channelPacks],['サーバー追加',serverPacks],['ルール追加',rulePacks]]){const label=document.createElement('label');const span=document.createElement('span');span.textContent=labelText;label.append(span,input);optionGrid.append(label);}
const pricePreview=document.createElement('p');pricePreview.className='price-preview';
const checkoutSummary=document.createElement('dl');checkoutSummary.className='checkout-summary';
const creditPaymentDetails=document.createElement('div');creditPaymentDetails.className='credit-payment-details';creditPaymentDetails.setAttribute('role','status');creditPaymentDetails.setAttribute('aria-live','polite');
const creditPaymentHelp=document.createElement('p');
creditPaymentDetails.append(creditPaymentHelp);
const focusTopup=amount=>{topupAmount.value=String(Math.max(500,Number(amount)||500));creditPanel.scrollIntoView({behavior:'smooth',block:'start'});topupAmount.focus({preventScroll:true});};
const updatePricePreview=()=>{const base={supporter:300,plus:800,pro:1280}[plan.value]||300;const monthly=base+200*(Number(channelPacks.value)+Number(serverPacks.value)+Number(rulePacks.value));const terms=initialTerms();const initial=monthly*terms.months;const payment=creditFirstPayment(initial,availableCredits,creditBalanceLoaded);pricePreview.textContent=`月額 ${monthly.toLocaleString('ja-JP')}円／新規申込時 ${initial.toLocaleString('ja-JP')}円（${terms.label}）`;checkoutSummary.replaceChildren();const rows=[['申込みプラン',{supporter:'Basic',plus:'Plus',pro:'Pro'}[plan.value]],['初回支払額',`${initial.toLocaleString('ja-JP')}円`]];if(payment.state==='checking')rows.push(['事前チャージの残高','確認中']);if(payment.state==='split'||payment.state==='credits')rows.push(['事前チャージの残高から',`${payment.creditApplied.toLocaleString('ja-JP')}円`],['カードへの請求',payment.cardCharge?`${payment.cardCharge.toLocaleString('ja-JP')}円`:'ありません'],['支払い後の残高',`${payment.remainingCredits.toLocaleString('ja-JP')}円`]);rows.push([terms.nextLabel,`${monthly.toLocaleString('ja-JP')}円`],['提供開始','決済確認後'],['解約','契約管理画面から手続きし、期間末で終了。支払済み料金の返金なし']);for(const [term,value] of rows){const dt=document.createElement('dt');dt.textContent=term;const dd=document.createElement('dd');dd.textContent=value;checkoutSummary.append(dt,dd);}creditPaymentDetails.hidden=payment.state==='card';creditPaymentHelp.textContent=payment.state==='checking'?'事前チャージの残高を確認しています。':payment.state==='credits'?'残高だけで申し込めます（カードへの請求はありません）。':payment.state==='split'?`カードを使わない場合は、あと${payment.topupNeeded.toLocaleString('ja-JP')}円チャージすると残高だけで申し込めます（チャージは500円から）。`:'';updateCheckoutAvailability();};
for(const input of [plan,channelPacks,serverPacks,rulePacks])input.addEventListener('change',updatePricePreview);
updatePricePreview();application.append(optionGrid,pricePreview,checkoutSummary,creditPaymentDetails);

// 2026年11月の申込みだけ、1か月分の支払いで11月と12月を利用できる（worker/supporter-billing.js の NOVEMBER_OFFER と同じ）。
function initialTerms(now=new Date()){
 const jst=new Date(now.getTime()+9*60*60*1000),day=jst.getUTCDate(),november=jst.getUTCFullYear()===2026&&jst.getUTCMonth()===10;
 return november?{months:1,lateMonth:false,november:true,label:'1か月分で11月・12月に利用できます',nextLabel:'次回（12月26日）に必要な額'}:day>=26?{months:2,lateMonth:true,november:false,label:'当月分＋翌月分',nextLabel:'次回26日に必要な額'}:{months:1,lateMonth:false,november:false,label:'当月分',nextLabel:'次回26日に必要な額'};
}
const selectedInitialCharge=(selectedPlan,selectedChannelPacks,selectedServerPacks,selectedRulePacks)=>{
 const base={supporter:300,plus:800,pro:1280}[selectedPlan]||300;
 const monthly=base+200*(Number(selectedChannelPacks)+Number(selectedServerPacks)+Number(selectedRulePacks));
 const terms=initialTerms();
 return {monthly,initial:monthly*terms.months,lateMonth:terms.lateMonth};
};
const PENDING_PLAN_KEY='dpi-supporter-pending-plan';
let pendingPlanAfterTopup=null;
const readPendingPlan=()=>{
 try{
  const value=JSON.parse(sessionStorage.getItem(PENDING_PLAN_KEY)||'null');
  const age=value&&Number.isFinite(value.savedAt)?Date.now()-value.savedAt:-1;
  const valid=value&&age>=0&&age<=30*60*1000
   &&PLAN_OPTIONS.some(([id])=>id===value.plan)
   &&CHANNEL_PACK_OPTIONS.some(([id])=>Number(id)===value.channelPacks)
   &&SERVER_PACK_OPTIONS.some(([id])=>Number(id)===value.serverPacks)
   &&RULE_PACK_OPTIONS.some(([id])=>Number(id)===value.rulePacks)
   &&typeof value.email==='string'&&value.email.length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email);
  if(!valid){sessionStorage.removeItem(PENDING_PLAN_KEY);return null;}
  return value;
 }catch{sessionStorage.removeItem(PENDING_PLAN_KEY);return null;}
};
if(new URLSearchParams(location.search).get('credit')==='completed'){
 pendingPlanAfterTopup=readPendingPlan();
 if(pendingPlanAfterTopup){
  plan.value=pendingPlanAfterTopup.plan;channelPacks.value=String(pendingPlanAfterTopup.channelPacks);serverPacks.value=String(pendingPlanAfterTopup.serverPacks);rulePacks.value=String(pendingPlanAfterTopup.rulePacks);billingEmail.value=pendingPlanAfterTopup.email;topupEmail.value=pendingPlanAfterTopup.email;updatePricePreview();
 }
}
// 正式リリース前の案内（正式リリース時に外す）
const legalConsentLabel=document.createElement('label');legalConsentLabel.className='legal-consent pre-release-notice';
const legalConsent=document.createElement('input');legalConsent.type='checkbox';legalConsent.id='legal-consent';legalConsent.required=true;
const legalConsentText=document.createElement('span');legalConsentText.append('β版（正式リリース前）の提供であり、不具合や配信停止が起こる場合があります。原則として補填はありません。申込み内容を確認し、');
for(const [label,href] of [['利用規約','/terms/terms.html'],['プライバシーポリシー','/terms/policy.html'],['特定商取引法に基づく表記','/terms/Specified.html']]){const link=document.createElement('a');link.textContent=label;link.href=href;link.target='_blank';link.rel='noopener noreferrer';legalConsentText.append(link,label==='特定商取引法に基づく表記'?'に同意します。':'、');}
legalConsentLabel.append(legalConsent,legalConsentText);application.append(legalConsentLabel);
legalConsent.addEventListener('change',updateCheckoutAvailability);

topupButton.onclick=async()=>{
 topupStatus.textContent='';
 if(!billingAvailable){topupStatus.textContent='現在は事前チャージを利用できません。時間をおいて再度お試しください。';return;}
 if(!topupEmail.reportValidity()||!creditConsentInput.reportValidity())return;
 const amount=Number(topupAmount.value);
 if(!Number.isInteger(amount)||amount<500||amount>100000){topupStatus.textContent='チャージ金額は500〜100,000円で入力してください。';topupAmount.focus();return;}
 topupButton.disabled=true;const original=topupButton.textContent;topupButton.textContent='決済画面を準備中…';
 try{
  const result=await api('/api/supporter/billing/topup','POST',{amount,email:topupEmail.value,legalConsent:true,requestId:crypto.randomUUID()});
  location.href=stripeDestination(result.url);
 }catch(error){topupStatus.textContent=error.message;status(error.message);}
 finally{topupButton.disabled=false;topupButton.textContent=original;}
};

topupReloadButton.onclick=async()=>{
 topupReloadStatus.textContent='';topupReloadButton.disabled=true;const original=topupReloadButton.textContent;topupReloadButton.textContent='再読み込み中…';
 try{
  const state=await api('/api/supporter/billing/status');applyAccountEnforcement(state.accountEnforcement);
  renderCreditDetails(state.creditDetails||{balance:Number(state.credits||0)});renderContracts(state.subscriptions||[],state.dunning,state.customPlan,state.customCheckoutUrl,state.customChange,state.customChangeCheckoutUrl,state.unpaid);renderInvoices(state.invoices||[]);
  const recovery=state.creditTopupRecovery||{};
  if(recovery.recovered>0){topupReloadStatus.textContent=`支払い済みのチャージ${recovery.recovered}件を反映しました。`;status(topupReloadStatus.textContent);}
  else if(recovery.failed>0){topupReloadStatus.textContent='支払い状況を取得できませんでした。時間をおいて再度お試しください。';status(topupReloadStatus.textContent);}
  else topupReloadStatus.textContent='残高とチャージ・利用の履歴を更新しました。';
 }catch(error){topupReloadStatus.textContent=error.message;status(error.message);}
 finally{topupReloadButton.disabled=false;topupReloadButton.textContent=original;}
};

const dateText = seconds => seconds ? new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Tokyo'}).format(new Date(seconds * 1000)) : '—';
const moneyText = (amount,currency) => new Intl.NumberFormat('ja-JP',{style:'currency',currency:(currency || 'jpy').toUpperCase(),maximumFractionDigits:0}).format(amount || 0);
const STATUS_LABELS = {active:'有効',trialing:'有効（次回請求待ち）',past_due:'支払い遅延',unpaid:'未払い',paused:'一時停止',incomplete:'手続き未完了',paid:'支払い済み',refunded:'返金済み',open:'支払い待ち',draft:'作成中',void:'無効'};
const TOPUP_STATUS_LABELS={pending:'入金・決済の確認待ち',credited:'チャージ済み',failed:'未完了',expired:'失効済み',refunded:'返金済み',disputed:'異議申立て'};

function renderCreditDetails(details={}){
 const balance=Number(details.balance||0),purchased=Number(details.purchasedBalance||0);
 availableCredits=Math.max(0,balance);
 creditBalanceLoaded=true;creditBalanceFailed=false;
 credit.textContent=`事前チャージの残高: ${balance.toLocaleString('ja-JP')}円`;
 creditExpiry.textContent=details.nextExpiry
  ?`チャージした残高 ${purchased.toLocaleString('ja-JP')}円／最も近い有効期限: ${dateText(details.nextExpiry)}`
  :'チャージした残高の有効期限は、反映した日（入金の確認日）から1年間です。';
 updatePricePreview();
 if(pendingPlanAfterTopup){
  const required=selectedInitialCharge(plan.value,channelPacks.value,serverPacks.value,rulePacks.value).initial;
  billingActionStatus.textContent=availableCredits>=required?'残高が足りました。「残高で申し込む」を押すと申し込みが完了します。':'入金の確認後に、残高で申し込めます。';
  sessionStorage.removeItem(PENDING_PLAN_KEY);pendingPlanAfterTopup=null;
 }
 creditHistory.replaceChildren();
 const rows=Array.isArray(details.topups)?details.topups:[];
 const compensations=Array.isArray(details.compensations)?details.compensations:[];
 const confiscations=Array.isArray(details.adminConfiscations)?details.adminConfiscations:[];
 if(!rows.length&&!compensations.length&&!confiscations.length){creditHistory.textContent='チャージ・利用の履歴はありません。';return;}
 for(const item of compensations){
  const card=document.createElement('article');card.className='credit-history-card compensation-credit-card';
  const heading=document.createElement('strong');heading.textContent=`補償 ${Number(item.amount||0).toLocaleString('ja-JP')}円分・${item.status==='expired'?'失効済み':'付与済み'}`;
  const reason=document.createElement('p');reason.textContent=`理由: ${item.reason||'—'}`;
  const dates=document.createElement('p');dates.textContent=`付与: ${dateText(item.creditedAt)}／有効期限: ${dateText(item.expiresAt)}／残高: ${Number(item.remainingAmount||0).toLocaleString('ja-JP')}円`;
  card.append(heading,reason,dates);creditHistory.append(card);
 }
 for(const item of confiscations){
  const card=document.createElement('article');card.className='credit-history-card confiscated-credit-card';
  const heading=document.createElement('strong');heading.textContent=`${Number(item.amount||0).toLocaleString('ja-JP')}円分・管理者による没収`;
  const reason=document.createElement('p');reason.textContent=`理由: ${item.reason||'—'}`;
  const dates=document.createElement('p');dates.textContent=`処理: ${dateText(item.processedAt)}／処理後残高: ${Number(item.balanceAfter||0).toLocaleString('ja-JP')}円`;
  card.append(heading,reason,dates);creditHistory.append(card);
 }
 for(const item of rows){
  const card=document.createElement('article');card.className='credit-history-card';
  const heading=document.createElement('strong');heading.textContent=`${Number(item.amount||0).toLocaleString('ja-JP')}円・${TOPUP_STATUS_LABELS[item.status]||item.status}`;
  const dates=document.createElement('p');dates.textContent=item.status==='credited'
   ?`購入: ${dateText(item.purchasedAt)}／有効期限: ${dateText(item.expiresAt)}`
   :`作成: ${dateText(item.createdAt)}`;
  card.append(heading,dates);creditHistory.append(card);
 }
}

function stripeDestination(value) {
 const link = document.createElement('a');
 link.href = typeof value === 'string' ? value : '';
 if (link.protocol !== 'https:' || !['checkout.stripe.com','billing.stripe.com'].includes(link.hostname)) {
  throw Error('Stripeの決済URLを確認できませんでした。時間をおいて再度お試しください。');
 }
 return link.href;
}

function stripeDocumentDestination(value){
 const link=document.createElement('a');link.href=typeof value==='string'?value:'';
 if(link.protocol!=='https:'||!['invoice.stripe.com','pay.stripe.com'].includes(link.hostname))throw Error('Stripeの請求書URLを確認できませんでした。');
 return link.href;
}

function renderInvoices(invoices){
 invoiceHistory.replaceChildren();
 if(!invoices.length){invoiceHistory.textContent='表示できる支払い明細はまだありません。';return;}
 for(const invoice of invoices){
  const card=document.createElement('article');card.className='invoice-card';
  const heading=document.createElement('h4');heading.textContent=invoice.number?`請求書 ${invoice.number}`:invoice.label||'請求書';
  const meta=document.createElement('p');meta.textContent=`${dateText(invoice.created)}・${STATUS_LABELS[invoice.status]||invoice.status}・${moneyText(invoice.total,invoice.currency)}${Number(invoice.refunded)>0?`（返金 ${moneyText(invoice.refunded,invoice.currency)}）`:''}`;
  const actions=document.createElement('div');actions.className='invoice-actions';
  for(const [label,url] of [['請求書を見る',invoice.hostedInvoiceUrl],['PDFを開く',invoice.invoicePdf],['領収書を見る',invoice.receiptUrl]])if(url){const anchor=document.createElement('a');anchor.className='secondary-btn';anchor.textContent=label;anchor.href=stripeDocumentDestination(url);anchor.target='_blank';anchor.rel='noopener noreferrer';actions.append(anchor);}
  card.append(heading,meta,actions);invoiceHistory.append(card);
 }
}

function highlightCurrentPlans(subscriptions=[],customPlan=null){
 const allowed=new Set(['active','trialing','past_due','unpaid','paused']);
 const current=subscriptions.filter(item=>item.recognizedPlan!==false&&allowed.has(item.status)&&['supporter','plus','pro','custom'].includes(item.planId));
 const ids=new Set(current.map(item=>item.planId));
 const names={supporter:'Basic',plus:'Plus',pro:'Pro',custom:'カスタム'};
 for(const card of document.querySelectorAll('.plans [data-plan]')){
  const isCurrent=ids.has(card.dataset.plan);
  card.classList.toggle('is-current-plan',isCurrent);
  let marker=card.querySelector('.current-plan-marker');
  if(isCurrent&&!marker){
   marker=document.createElement('span');marker.className='current-plan-marker';
   marker.textContent='現在利用中';card.insertBefore(marker,card.firstChild);
  }else if(!isCurrent&&marker)marker.remove();
 }
 const banner=$('current-plan-banner');
 if(!banner)return;
 banner.classList.toggle('has-active-plan',current.length>0);
 if(current.length){
  banner.textContent=`現在のご利用プラン：${current.map(item=>`${names[item.planId]}（月額 ${Number(item.amount||0).toLocaleString('ja-JP')}円・${STATUS_LABELS[item.status]||item.status}）`).join('／')}`;
 }else if(customPlan?.status==='offered'){
  banner.textContent='現在のご利用プラン：カスタムプランの契約手続き待ち（決済確認後に利用可能）';
 }else{
  banner.textContent='現在のご利用プラン：未契約。ご希望のプランを選択してください。';
 }
}

function renderContracts(subscriptions,dunning={},customPlan=null,customCheckoutUrl='',customChange=null,customChangeCheckoutUrl='',unpaid={}) {
 contract.replaceChildren();
 highlightCurrentPlans(subscriptions,customPlan);
 customPlanLocked=customPlan?.locked===true;
 for(const button of document.querySelectorAll('[data-billing-action]')){
  if(['checkout','update','portal'].includes(button.dataset.billingAction)){
   const cancelable=button.dataset.billingAction==='portal'&&customPlan?.status==='active';
   button.disabled=customPlanLocked&&!cancelable;
   button.title=customPlanLocked?(cancelable?'カスタムプランは解約のみ手続きできます。':'管理者提供のカスタムプラン中は変更できません。'):'';
   if(button.dataset.billingAction==='portal')button.textContent=cancelable&&customPlanLocked?'解約の手続き':'支払い方法・解約';
  }
 }
 if(customPlanLocked){
  const card=document.createElement('section');card.className='contract-card';
  const title=document.createElement('h3');title.textContent=customPlan.name||'カスタムプラン';
  const details=document.createElement('p');details.textContent=`管理者提供／${customPlan.status==='active'?'利用中':'支払い待ち'}／月額 ${Number(customPlan.monthlyYen).toLocaleString('ja-JP')}円。上限：${customPlan.channels}チャンネル、${customPlan.servers}サーバー、${customPlan.rules}ルール。${customPlan.status==='active'?'解約はこの画面から手続きできます。支払い方法・プランなど、それ以外の変更はお問い合わせください。':'プラン変更は管理者のみ可能です。'}`;
  card.append(title,details);
  if(customPlan.status==='offered'&&customCheckoutUrl){const pay=document.createElement('a');pay.href=stripeDestination(customCheckoutUrl);pay.textContent='専用の支払い手続きへ';pay.rel='noopener noreferrer';card.append(pay);}
  if(customChange){
   const changed=document.createElement('p');changed.className='scheduled-change';
   changed.textContent=customChange.status==='paid'
    ?'管理者による月額変更の差額決済を確認しました。契約への反映を処理しています。'
    :`カスタム契約の変更が提示されています。現在月額 ${Number(customChange.oldMonthlyYen).toLocaleString('ja-JP')}円 → 新月額 ${Number(customChange.nextMonthlyYen).toLocaleString('ja-JP')}円／当月差額 ${Number(customChange.amountDueYen).toLocaleString('ja-JP')}円。支払い確認後に新料金と配信条件が有効になります。`;
   card.append(changed);
   if(customChangeCheckoutUrl&&customChange.status==='pending'){
    const link=document.createElement('a');link.href=stripeDestination(customChangeCheckoutUrl);
    link.textContent=`当月差額 ${Number(customChange.amountDueYen).toLocaleString('ja-JP')}円を支払う（Stripe）`;
    link.rel='noopener noreferrer';card.append(link);
   }
  }
  const reuse=document.createElement('p');reuse.textContent=customPlan.secondaryReuse?'二次利用の契約上の対象です。実施前には別途申請・承認が必要です。':'二次利用はこの契約では許可されていません。';card.append(reuse);
  contract.append(card);
 }

 hasExistingContract=subscriptions.length>0;
 updateCheckoutAvailability();
 if(Number(unpaid.count)>0)renderUnpaid(unpaid);
 if (!subscriptions.length) {
  if(!customPlanLocked&&Number(unpaid.count)<=0)contract.textContent = '現在の契約はありません。';
  entitlements={servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false,...featureEntitlements([])};
  if(options)setRuleAccess(false);
  return;
 }
 const active=subscriptions.filter(item=>item.recognizedPlan!==false&&['active','trialing','past_due','unpaid','paused'].includes(item.status));
 entitlements={...active.reduce((limits,item)=>({servers:Math.max(limits.servers,Number(item.servers)||1),channels:Math.max(limits.channels,Number(item.channels)||2),rules:Math.max(limits.rules,Number(item.rules)||5),complexConditions:limits.complexConditions||item.complexConditions===true,multiDestination:limits.multiDestination||item.multiDestination===true}),{servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false}),...featureEntitlements(active)};
 const current=active[0]||subscriptions[0];
 if(dunning?.usageSuspended){const warning=document.createElement('p');warning.className='billing-suspension';warning.textContent=dunning.reason==='dispute'?'お支払いへの異議申立てを確認中のため、有料プランの通知設定は利用停止中です。停止中は新しい月額料金を請求しません。お問い合わせください。':'お支払いを確認できなかったため、有料プランの通知設定は利用停止中です。未払いの請求書をすべてお支払いいただくと再開します。停止中は新しい月額料金を請求しません。停止から1か月間お支払いを確認できない場合は、自動的に解約します。';contract.append(warning);}
 if(current){
  plan.value=current.planId||'supporter';channelPacks.value=String(current.channelPacks||0);serverPacks.value=String(current.serverPacks||0);rulePacks.value=String(current.rulePacks||0);
  // Comparison-page CTAs preselect the requested plan without submitting payment.
  const requestedPlan=new URLSearchParams(location.search).get('plan');
  if(PLAN_OPTIONS.some(([id])=>id===requestedPlan)&&!window.__dpiComparisonPlanApplied){
   window.__dpiComparisonPlanApplied=true;
   plan.value=requestedPlan;
  }
  updatePricePreview();
 }
 for (const subscription of subscriptions) {
  const card = document.createElement('article');
  card.className = 'contract-card';
  const heading = document.createElement('h3');
  heading.textContent = subscription.plan;
  const data = document.createElement('dl');
  const entries = [
   ['状態',`${STATUS_LABELS[subscription.status] || subscription.status}${subscription.cancelAtPeriodEnd ? '（期間末で解約予定）' : ''}`],
   ['支払い開始日',dateText(subscription.startedAt)],
   ['現在の期間開始',dateText(subscription.currentPeriodStart)],
   [subscription.cancelAtPeriodEnd ? '契約終了予定' : '次回更新日',dateText(subscription.nextRenewalAt)],
   ['月額合計',moneyText(subscription.amount,subscription.currency)],
   ['チャンネル上限',subscription.recognizedPlan===false?'確認が必要':`${subscription.channels}チャンネル`],
   ['サーバー上限',subscription.recognizedPlan===false?'確認が必要':`${subscription.servers}サーバー`],
   ['通知ルール上限',subscription.recognizedPlan===false?'確認が必要':`${subscription.rules}件`],
   ['固定請求日','毎月26日'],
  ];
  for (const [term,value] of entries) {
   const dt=document.createElement('dt'); dt.textContent=term;
   const dd=document.createElement('dd'); dd.textContent=value;
   data.append(dt,dd);
  }
  const list = document.createElement('ul');
  for (const item of subscription.items) {
   const row = document.createElement('li');
   row.textContent = `${item.label} × ${item.quantity}：${moneyText(item.subtotal,item.currency)}`;
   list.append(row);
  }
  card.append(heading,data,list);
  if(subscription.scheduledChange){
   const scheduled=document.createElement('p');scheduled.className='scheduled-change';scheduled.textContent=`予約中：${dateText(subscription.scheduledChange.effectiveAt)}から${subscription.scheduledChange.plan}（月額${moneyText(subscription.scheduledChange.monthly,'jpy')}）へ変更。返金はありません。`;card.append(scheduled);
  }
  contract.append(card);
 }
 if(options)setRuleAccess(active.length>0&&!dunning?.usageSuspended&&!accountSuspended);
}

function renderUnpaid(unpaid={}){
 const total=Math.max(0,Number(unpaid.total)||0),shortage=Math.max(0,total-availableCredits);
 const panel=document.createElement('section');panel.className='unpaid-panel';
 const heading=document.createElement('h3');heading.textContent=`未払い ${Number(unpaid.count)||0}件・合計 ${total.toLocaleString('ja-JP')}円`;
 const message=document.createElement('p');message.textContent=unpaid.payableWithCredits?'残高で未払いの全額を支払えます。実行すると取り消せません。':`残高が${shortage.toLocaleString('ja-JP')}円不足しています。未払いは一部だけ支払えません。`;
 const resultText=document.createElement('p');resultText.className='billing-action-status';resultText.setAttribute('role','status');resultText.setAttribute('aria-live','polite');
 const action=document.createElement('button');action.type='button';action.className=unpaid.payableWithCredits?'primary-btn':'secondary-btn';action.textContent=unpaid.payableWithCredits?'残高で支払う':'事前チャージをする';
 action.onclick=async()=>{if(!unpaid.payableWithCredits){focusTopup(shortage);return;}if(!confirm(`未払い ${Number(unpaid.count)||0}件、合計 ${total.toLocaleString('ja-JP')}円を残高で支払います。よろしいですか？`))return;action.disabled=true;resultText.textContent='支払い処理中…';try{const paid=await api('/api/supporter/billing/pay-unpaid','POST',{requestId:crypto.randomUUID(),expectedTotal:total});renderCreditDetails(paid.creditDetails||{balance:Number(paid.credits||0)});renderContracts(paid.subscriptions||[],paid.dunning,paid.customPlan,paid.customCheckoutUrl,paid.customChange,paid.customChangeCheckoutUrl,paid.unpaid);renderInvoices(paid.invoices||[]);status(paid.message||'未払いを残高で支払いました。');}catch(error){resultText.textContent=error.message;status(error.message);action.disabled=false;}};
 panel.append(heading,message,action,resultText);contract.append(panel);
}

let pendingUpdate=null;
const previewDialog=$('billing-preview-dialog');
const previewContent=$('billing-preview-content');
const signedMoney=value=>`${Number(value)>0?'+':''}${moneyText(Number(value)||0,'jpy')}`;
function showBillingPreview(result,requested){
 pendingUpdate={requested,prorationDate:result.prorationDate,expectedCreditApplied:Number(result.creditApplied||0),useCredits:false};
 previewContent.replaceChildren();
 const heading=document.createElement('p');heading.className='preview-lead';heading.textContent=result.changeTiming==='next_period'?'変更内容と適用日をご確認ください。現在の契約は今期末まで利用できます。':'変更後の料金と利用枠をご確認ください。';
 const data=document.createElement('dl');data.className='preview-grid';
 const usesCredits=Number(result.creditApplied||0)>0;
 const hasRemainingPayment=Number(result.immediateDue||0)>0||Number(result.nextInvoiceDue||0)>0;
 const paymentMethod=result.paymentMethodRegistered===false?(usesCredits&&Number(result.creditShortage||0)===0?'事前チャージの残高（カード不要）':'未登録'):usesCredits?(hasRemainingPayment?'事前チャージの残高＋登録済みのカード':'事前チャージの残高'):'登録済みのお支払い方法';
 const rows=[
  ['プラン',`${result.current.plan} → ${result.next.plan}`],
  ['月額',`${moneyText(result.current.monthly,'jpy')} → ${moneyText(result.next.monthly,'jpy')}`],
  ['月額差額',signedMoney(result.monthlyDifference)],
  ['支払い方法',paymentMethod],
 ];
 if(result.changeTiming==='next_period'){
  rows.push(['適用タイミング',`${dateText(result.effectiveAt)}から`],['今回の返金','なし'],['今回の追加請求','なし']);
 } else if(result.planChanged){
  const breakdown=result.planProrationBreakdown||{unusedPlanCredit:0,newPlanCharge:Math.max(0,result.planProration),net:result.planProration};
  rows.push(
   ['旧プラン未使用分（返金相当）',breakdown.unusedPlanCredit?`−${moneyText(breakdown.unusedPlanCredit,'jpy')}`:moneyText(0,'jpy')],
   ['新プラン残期間分',moneyText(breakdown.newPlanCharge,'jpy')],
   ['基本プランの今回差額',signedMoney(breakdown.net)],
  );
 }
 rows.push(
  ['今回に使う残高',result.immediateCreditApplied?`−${moneyText(result.immediateCreditApplied,'jpy')}`:'なし'],
  ['今回のお支払い見込み',moneyText(result.immediateDue,'jpy')],
  ['次回26日の請求予定額',moneyText(result.nextInvoiceSubtotal,'jpy')],
  ['次回に使う残高',result.nextInvoiceCreditApplied?`−${moneyText(result.nextInvoiceCreditApplied,'jpy')}`:'なし'],
  ['次回26日のお支払い見込み',moneyText(result.nextInvoiceDue,'jpy')],
  ['適用後の残高',moneyText(result.remainingCreditsAfterNext,'jpy')],
  ['次回更新日',dateText(result.nextRenewalAt)],
  ['チャンネル上限',`${result.current.channels} → ${result.next.channels}`],
  ['サーバー上限',`${result.current.servers} → ${result.next.servers}`],
  ['通知ルール上限',`${result.current.rules} → ${result.next.rules}`],
 );
 if(result.creditGenerated)rows.push(['差額から残高に加わる額',moneyText(result.creditGenerated,'jpy')]);
 for(const [term,value] of rows){const dt=document.createElement('dt');dt.textContent=term;const dd=document.createElement('dd');dd.textContent=value;data.append(dt,dd);}
 const optionNote=document.createElement('p');optionNote.className='preview-notice';optionNote.textContent=result.notice;
 previewContent.append(heading,data,optionNote);
 const confirmButton=$('billing-preview-confirm');
 confirmButton.textContent=result.changeTiming==='next_period'?'変更を予約':'変更を確定';
 const creditShortage=Math.max(0,Number(result.creditShortage)||0);
 if(creditShortage>0){const shortageNotice=document.createElement('p');shortageNotice.className='preview-notice';shortageNotice.setAttribute('role','alert');shortageNotice.textContent=`残高が${creditShortage.toLocaleString('ja-JP')}円不足しています。`;const chargeButton=document.createElement('button');chargeButton.type='button';chargeButton.className='secondary-btn';chargeButton.textContent='事前チャージをする';chargeButton.onclick=()=>{pendingUpdate=null;previewDialog.close();focusTopup(creditShortage);};previewContent.append(shortageNotice,chargeButton);confirmButton.disabled=true;}
 if(result.paymentMethodRegistered===false&&Number(result.nextInvoiceDue||0)>0){const warning=document.createElement('p');warning.className='preview-notice';warning.textContent='カードが登録されていません。次回26日までに必要額をチャージしてください。残高が足りない場合は未払いとなり、月末の再請求でも足りなければ翌月1日0時に停止します。';previewContent.append(warning);}
 if(result.creditApplied>0&&creditShortage===0){
  const creditConsent=document.createElement('label');creditConsent.className='credit-consent';
  const creditConsentInput=document.createElement('input');creditConsentInput.type='checkbox';
  const creditParts=[];
  if(result.immediateCreditApplied)creditParts.push(`今回${moneyText(result.immediateCreditApplied,'jpy')}`);
  if(result.nextInvoiceCreditApplied)creditParts.push(`次回26日${moneyText(result.nextInvoiceCreditApplied,'jpy')}`);
  const creditConsentText=document.createElement('span');creditConsentText.textContent=`残高から${creditParts.join('、')}を使用します。残りのお支払いは今回${moneyText(result.immediateDue,'jpy')}、次回26日${moneyText(result.nextInvoiceDue,'jpy')}です。`;
  creditConsentInput.addEventListener('change',()=>{if(pendingUpdate)pendingUpdate.useCredits=creditConsentInput.checked;confirmButton.disabled=!creditConsentInput.checked;});
  creditConsent.append(creditConsentInput,creditConsentText);previewContent.append(creditConsent);confirmButton.textContent=result.changeTiming==='next_period'?'残高を使って変更を予約':'残高を使って変更を確定';confirmButton.disabled=true;
 }else if(creditShortage===0)confirmButton.disabled=false;
 previewDialog.showModal();
}
$('billing-preview-cancel').onclick=()=>{pendingUpdate=null;const confirmButton=$('billing-preview-confirm');confirmButton.disabled=false;confirmButton.textContent='変更を確定';previewDialog.close();};
$('billing-preview-confirm').onclick=run(async()=>{
 if(!pendingUpdate)return;
 const button=$('billing-preview-confirm');button.disabled=true;
 try{
  const result=await api('/api/supporter/billing/update','POST',{...pendingUpdate.requested,prorationDate:pendingUpdate.prorationDate,expectedCreditApplied:pendingUpdate.expectedCreditApplied,useCredits:pendingUpdate.useCredits,requestId:crypto.randomUUID()});
  pendingUpdate=null;previewDialog.close();
  const state=await api('/api/supporter/billing/status');applyAccountEnforcement(state.accountEnforcement);renderCreditDetails(state.creditDetails||{balance:Number(state.credits||result.credits||0)});renderContracts(state.subscriptions||[],state.dunning,state.customPlan,state.customCheckoutUrl,state.customChange,state.customChangeCheckoutUrl,state.unpaid);renderInvoices(state.invoices||[]);status(result.message||'契約情報を更新しました。');
 } finally {button.disabled=false;}
});

const billingActionStatus=document.createElement('p');
billingActionStatus.className='billing-action-status';
billingActionStatus.setAttribute('role','status');
billingActionStatus.setAttribute('aria-live','polite');
const billingActions=document.createElement('div');
billingActions.className='billing-actions';
const paymentChoiceTitle=document.createElement('h4');paymentChoiceTitle.className='payment-choice-title';paymentChoiceTitle.textContent='お支払い方法を選ぶ';
const paymentChoices=document.createElement('div');paymentChoices.className='payment-choice-actions';paymentChoices.setAttribute('role','group');paymentChoices.setAttribute('aria-label','申込みのお支払い方法');
const topupChoiceButton=document.createElement('button');topupChoiceButton.type='button';topupChoiceButton.className='secondary-btn';
let updateButton;
topupChoiceButton.onclick=()=>{
 if(!billingEmail.reportValidity()||!legalConsent.reportValidity())return;
 const price=selectedInitialCharge(plan.value,channelPacks.value,serverPacks.value,rulePacks.value);
 const pending={savedAt:Date.now(),plan:plan.value,channelPacks:Number(channelPacks.value),serverPacks:Number(serverPacks.value),rulePacks:Number(rulePacks.value),email:billingEmail.value};
 try{sessionStorage.setItem(PENDING_PLAN_KEY,JSON.stringify(pending));}catch{billingActionStatus.textContent='申込み内容を一時保存できませんでした。ブラウザの設定をご確認ください。';return;}
 topupEmail.value=billingEmail.value;focusTopup(Math.max(0,price.initial-availableCredits));
};
paymentChoices.append(topupChoiceButton);
// 2026年11月25日の夜だけの案内（26日0時30分に消える）
const launchNotice=document.createElement('p');launchNotice.className='pre-release-notice';launchNotice.dataset.launchNotice='';launchNotice.hidden=true;
launchNotice.textContent='25日23時57分ごろから26日0時までは契約を作成できません（この間のカードのお支払いは、0時以降に自動で契約されます）。25日中にお申込みの方は、26日0時30分まで、変更・解約・お支払い方法の変更ができません。';
application.append(launchNotice,paymentChoiceTitle,paymentChoices,billingActions,billingActionStatus);

function updateCheckoutAvailability(){
 if(!checkoutButton)return;
 const price=selectedInitialCharge(plan.value,channelPacks.value,serverPacks.value,rulePacks.value);const payment=creditFirstPayment(price.initial,availableCredits,creditBalanceLoaded);
 checkoutButton.hidden=hasExistingContract;topupChoiceButton.hidden=hasExistingContract||payment.state==='credits';
 if(updateButton)updateButton.hidden=!hasExistingContract;
 paymentChoiceTitle.hidden=hasExistingContract;paymentChoiceTitle.textContent=legalConsent.checked?'お支払い方法を選ぶ':'お支払い方法を選ぶ（上の同意にチェックすると押せます）';
 checkoutButton.disabled=!billingAvailable||customPlanLocked||!legalConsent.checked||hasExistingContract||!creditBalanceLoaded;
 topupChoiceButton.disabled=!billingAvailable||customPlanLocked||!legalConsent.checked||hasExistingContract||!creditBalanceLoaded;
 const checkingText=creditBalanceFailed?'残高を確認できません':session?.authenticated===false?'ログイン後に申し込めます':billingUnavailable?'現在は申し込めません':'残高を確認中';
 checkoutButton.title=accountSuspended?'有料プランアカウントがBANされています。':hasExistingContract?'既に契約済みです。プラン変更をご利用ください。':!creditBalanceLoaded?'事前チャージの残高を確認しています。':'';
 checkoutButton.textContent=payment.state==='checking'?checkingText:payment.state==='credits'?'残高で申し込む（カード請求なし）':payment.state==='split'?`残高を使って申し込む（カード ${payment.cardCharge.toLocaleString('ja-JP')}円）`:'クレジットカードで申し込む';
 topupChoiceButton.textContent=payment.state==='checking'?checkingText:payment.state==='split'?`事前チャージして申し込む（あと${payment.topupNeeded.toLocaleString('ja-JP')}円）`:'事前チャージして申し込む';
}

for (const [label,action] of [['このプランで申し込む','checkout'],['プラン・オプションを変更','update'],['支払い方法・解約','portal'],['契約・明細を更新','status']]) {
 const button = document.createElement('button');
 button.textContent = label;
 button.className=action==='checkout'?'primary-btn':'secondary-btn';
 button.type='button';button.dataset.billingAction=action;
 if(action==='checkout'){checkoutButton=button;paymentChoices.prepend(button);updateCheckoutAvailability();}
 else if(action==='update'){updateButton=button;button.textContent='変更内容と料金を確認';paymentChoices.append(button);}
 button.onclick = async () => {
  billingActionStatus.textContent='';
  if(customPlanLocked&&['checkout','update'].includes(action)){billingActionStatus.textContent='カスタムプランの変更は管理者にお問い合わせください。';return;}
  if(accountSuspended&&['checkout','update'].includes(action)){billingActionStatus.textContent='有料プランアカウントがBANされているため、この操作は利用できません。';return;}
  if(action==='checkout'&&!billingEmail.reportValidity())return;
  if(action==='checkout'&&!legalConsent.reportValidity())return;
  button.disabled = true;
  const originalLabel=button.textContent;
  button.textContent=action==='checkout'?'決済画面を準備中…':'処理中…';
  try {
   const selection={plan:plan.value,channelPacks:Number(channelPacks.value),serverPacks:Number(serverPacks.value),rulePacks:Number(rulePacks.value)};
   if(action==='update'){
    const result=await api('/api/supporter/billing/preview-update','POST',selection);
    showBillingPreview(result,selection);return;
   }
   const price=selectedInitialCharge(plan.value,channelPacks.value,serverPacks.value,rulePacks.value);const payment=creditFirstPayment(price.initial,availableCredits,creditBalanceLoaded);
   const creditRequest=payment.state==='credits'?{useCredits:true}:payment.state==='split'?{applyCredits:true,expectedCreditApplied:payment.creditApplied}:{};
   const body=action==='checkout'?{...selection,email:billingEmail.value,legalConsent:true,...creditRequest,requestId:crypto.randomUUID()}:{};
   const result = await api(`/api/supporter/billing/${action}`,action === 'status' ? 'GET' : 'POST',action === 'status' ? undefined : body);
   if (result.url) {
    location.href = stripeDestination(result.url);
   } else {
    applyAccountEnforcement(result.accountEnforcement||{});
    renderCreditDetails(result.creditDetails||{balance:Number(result.credits||0)});renderContracts(result.subscriptions||[],result.dunning,result.customPlan,result.customCheckoutUrl,result.customChange,result.customChangeCheckoutUrl,result.unpaid);renderInvoices(result.invoices||[]);
    status(result.message||'契約情報を更新しました。');
   }
  } catch(error) {
   billingActionStatus.textContent=error.message;
   status(error.message);
  } finally {button.disabled=false;button.textContent=originalLabel;}
 };
 if(!['checkout','update'].includes(action))billingActions.append(button);
}
billing.append(invoiceTitle,invoiceHistory);
updateCheckoutAvailability();
showLaunchNotice();
if(new URLSearchParams(location.search).has('credit'))requestAnimationFrame(()=>creditPanel.scrollIntoView({block:'start'}));
run(load)();
