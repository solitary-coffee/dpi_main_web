let session;
let revision = 0;
let rules = [];
let options;
let areaCatalogue={municipalities:[],districts:[]};
let areaCatalogueFailed=false;
let entitlements = {servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false,prefecture:false,municipality:false,strictMunicipality:false};
let hasConfigurableContract = false;
let billingAvailable = false;
let accountSuspended = false;
let stripeBillingEnabled = false;
let checkoutButton;
let hasExistingContract=false;
let customPlanLocked=false;
let availableCredits=0;
const channelsByGuild = new Map();
const PLAN_OPTIONS=[['supporter','BASIC 月額300円'],['plus','Plus 月額800円'],['pro','Pro 月額1,280円']];
const CHANNEL_PACK_OPTIONS=[[0,'チャンネル追加なし'],[1,'＋3チャンネル / 月額＋200円'],[2,'＋6チャンネル / 月額＋400円'],[3,'＋9チャンネル / 月額＋600円'],[4,'＋12チャンネル / 月額＋800円'],[5,'＋15チャンネル / 月額＋1,000円']];
const SERVER_PACK_OPTIONS=[[0,'サーバー追加なし'],[1,'＋1サーバー / 月額＋200円'],[2,'＋2サーバー / 月額＋400円'],[3,'＋3サーバー / 月額＋600円'],[4,'＋4サーバー / 月額＋800円'],[5,'＋5サーバー / 月額＋1,000円']];

const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; };
const INTENSITIES = [['1','1'],['2','2'],['3','3'],['4','4'],['5-','5弱'],['5+','5強'],['6-','6弱'],['6+','6強'],['7','7']];
const TYPES = [['earthquake','地震情報'],['eew','緊急地震速報'],['weather','気象情報'],['rain-radar','雨雲レーダー']];
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
   if (key === 'type') {rule.detail = 'all';rule.conditions=[];}
   if (key === 'region') {rule.prefecture='all';rule.district='all';rule.municipality='all';rule.strictMunicipality=false;}
   if (key === 'prefecture') {rule.district='all';rule.municipality='all';rule.strictMunicipality=false;}
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
 if(rule.type==='rain-radar')return [['region','対象地方'],['radarCondition','雨雲レーダーの配信条件'],['rainfallThreshold','1時間降水量の下限']];
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
  if(values)selectOptions(value,values,String(condition.value??''));else{value.value=String(condition.value??'');value.inputMode='decimal';value.placeholder=condition.kind==='rainfallThreshold'?'0.1〜500 mm/h':'0〜10';}
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
 const type = TYPES.some(([value]) => value === rule.type) ? rule.type : 'earthquake';
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
  radarCondition: rule.radarCondition || 'all',
  rainfallThresholdMmPerHour: rule.rainfallThresholdMmPerHour ?? '',
  deliveryIntervalHours: String(rule.deliveryIntervalHours || '1'),
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
 const prefectures=(options.prefectures||[]).filter(item=>item.region===rule.region).map(item=>[item.code,item.name]);
 const prefecture=field(container,rule,'prefecture','都道府県・全域',[['all','地方全域'],...prefectures]);
 prefecture.disabled=!entitlements.prefecture||rule.type==='rain-radar';
 if(rule.type==='rain-radar'&&entitlements.prefecture){
  const note=document.createElement('p');note.className='geo-upgrade';
  note.textContent='雨雲レーダーの取得元は地方単位の画像です。精密な都道府県・市区町村判定には非対応のため選択できません。';
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
  field(article, rule, 'type', '情報種別', TYPES);
  if(rule.type!=='rain-radar')field(article, rule, 'detail', '詳細', detailOptions(rule.type));
  if(entitlements.complexConditions)field(article, rule, 'conditionLogic', '条件の組み合わせ', [['and','すべて満たす（AND）'],['or','いずれかを満たす（OR）']]);
  if (rule.type === 'eew'){
   const finalLabel=document.createElement('label');finalLabel.className='eew-final-report-option';
   const finalCheck=document.createElement('input');finalCheck.type='checkbox';finalCheck.checked=rule.sendFinalReport!==false;
   finalCheck.addEventListener('change',()=>{rule.sendFinalReport=finalCheck.checked;});
   finalLabel.append(finalCheck,document.createTextNode(' 最終報を送信する（OFFの場合、予想最大震度が変わらない最終報を省略）'));
   article.append(finalLabel);
   if(rule.detail==='warning')field(article, rule, 'eewWarningAreaMode', '警報地方の条件', options.eewWarningAreaModes);
  }
  const conditionFields=document.createElement('div');conditionFields.className='rule-condition-fields';
  field(conditionFields, rule, 'region', '対象地方', options.regions);
  geoScopeFields(conditionFields,rule);
  if (rule.type === 'rain-radar') {
   field(conditionFields, rule, 'radarCondition', '配信条件', options.rainRadarConditions);
   if(rule.radarCondition==='rainfall-threshold')field(conditionFields, rule, 'rainfallThresholdMmPerHour', '1時間降水量の閾値（mm/h・最大20）', null, {inputmode:'decimal',min:'0.1',max:'20',step:'0.1'});
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
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger';
  remove.textContent = '削除';
  remove.onclick = () => { rules.splice(index, 1); render(); };
  article.append(remove);
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

async function load() {
 session = await api('/api/reuse/session');
 if (!session.authenticated) {
  $('user').textContent = 'Discordログインが必要です。';
  return;
 }
 $('user').textContent = session.user.username;
 options = await api('/api/supporter/options');
 try{const data=await api('/api/supporter/areas');areaCatalogue={municipalities:data.municipalities||[],districts:data.districts||[]};areaCatalogueFailed=false;}
 catch(error){areaCatalogue={municipalities:[],districts:[]};areaCatalogueFailed=true;status(error.message);}
 const {account,billingEnabled} = await api('/api/supporter/account');
 stripeBillingEnabled=billingEnabled===true;
 applyAccountEnforcement({suspended:account?.account_status==='suspended',status:account?.account_status||'active',reason:account?.status_reason||'',updatedAt:account?.status_updated_at||null});
 topupButton.disabled=!billingAvailable;
 const savedBillingEmail=account?.billing_email || '';
 billingEmail.value=savedBillingEmail;
 topupEmail.value=savedBillingEmail;
 updateCheckoutAvailability();
 updateTopupSignupAvailability();
 if(!billingAvailable)billingActionStatus.textContent=accountSuspended?'有料プランアカウントがBANされているため、申込み・チャージ・契約変更は利用できません。':'決済設定が完了していないため、現在は申し込みできません。';
 $('add').disabled = $('save').disabled = true;
 if (account) {
  revision = account.revision;
  rules = savedRules(account);
  await Promise.all([...new Set(rules.map(rule => rule.guildId).filter(Boolean))].map(guildId => loadChannels(guildId)));
  render();
  if(billingEnabled){
   try{
    const billingState=await api('/api/supporter/billing/status');applyAccountEnforcement(billingState.accountEnforcement);
    renderContracts(billingState.subscriptions||[],billingState.dunning,billingState.customPlan,billingState.customCheckoutUrl);renderInvoices(billingState.invoices||[]);
    if(billingState.rulesAdjustment?.changed){
     revision=Number(billingState.rulesAdjustment.revision)||revision;
     rules=(billingState.rulesAdjustment.rules||[]).map(normalizeRule);
     await Promise.all([...new Set(rules.map(rule=>rule.guildId).filter(Boolean))].map(guildId=>loadChannels(guildId)));
     render();
     const removed=Number(billingState.rulesAdjustment.removedRules||0),destinations=Number(billingState.rulesAdjustment.removedDestinations||0),simplified=Number(billingState.rulesAdjustment.simplifiedRules||0);
     status(`契約上限の変更を反映しました。${removed?`下側の通知ルールを${removed}件削除しました。`:''}${destinations?`上限を超える通知先を${destinations}件解除しました。`:''}${simplified?`下位プラン向けに${simplified}件の条件を調整しました。`:''}`);
    }
    renderCreditDetails(billingState.creditDetails||{balance:Number(billingState.credits||0)});
    const creditResult=new URLSearchParams(location.search).get('credit');
    if(creditResult==='completed')status(billingState.creditTopupRecovery?.recovered>0?'支払い済みのクレジットチャージを残高へ反映しました。':'クレジットのお支払いを受け付けました。反映されていない場合は「残高・履歴を再読み込み」を押してください。');
    if(creditResult==='completed'&&billingState.creditTopupRecovery?.failed>0)status('支払いは確認できましたが、クレジットの反映処理に失敗しました。時間をおいて「残高・履歴を再読み込み」を押してください。');
    if(creditResult==='canceled')status('クレジットチャージをキャンセルしました。料金は発生していません。');
    if(billingState.recoveredSubscription)status('支払い済みの申込みから契約を復旧し、有料プランを有効化しました。');
   }catch{contract.textContent='契約情報を自動取得できませんでした。「最新の契約・明細を読み込む」を押してください。';setRuleAccess(false);}
  }
 }
}

function applyAccountEnforcement(state={}){
 accountSuspended=state?.suspended===true||state?.status==='suspended';
 billingAvailable=stripeBillingEnabled&&!accountSuspended;
 const panel=$('account-enforcement');
 panel.classList.toggle('hidden',!accountSuspended);
 panel.textContent=accountSuspended?`有料プランアカウントは管理者によりBANされています。${state.reason?` 理由: ${state.reason}`:''} BAN解除まで、プラン申込み、クレジットチャージ、契約変更および通知設定は利用できません。`:'';
 if(accountSuspended)setRuleAccess(false);
 if(typeof updateCheckoutAvailability==='function')updateCheckoutAvailability();
 if(typeof updateTopupSignupAvailability==='function')updateTopupSignupAvailability();
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
 const data = await api('/api/supporter/settings','PUT',{revision,rules});
 revision = data.revision;
 status('通知設定を保存しました。');
});

const billing = $('billing');
billing.replaceChildren();
const title = document.createElement('h2');
title.textContent = 'お支払い・契約情報';
const modeGuide=document.createElement('div');modeGuide.className='billing-mode-guide';
const modeSwitch=document.createElement('div');modeSwitch.className='billing-mode-switch';modeSwitch.setAttribute('role','group');modeSwitch.setAttribute('aria-label','クレジット操作の切り替え');
const topupModeButton=document.createElement('button');topupModeButton.type='button';topupModeButton.textContent='クレジットチャージ式';topupModeButton.className='billing-mode-button';topupModeButton.dataset.mode='topup';
const paymentModeButton=document.createElement('button');paymentModeButton.type='button';paymentModeButton.textContent='クレジット支払い式';paymentModeButton.className='billing-mode-button';paymentModeButton.dataset.mode='payment';
modeSwitch.append(topupModeButton,paymentModeButton);modeGuide.append(modeSwitch);
const application = document.createElement('div');
application.className = 'billing-application billing-mode-panel';
application.id='credit-payment-panel';
const applicationTitle = document.createElement('h3');
applicationTitle.textContent = 'プラン・オプション';
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
credit.textContent = '利用可能クレジット: 0クレジット（0円）';
const creditPanel=document.createElement('div');creditPanel.className='credit-panel billing-mode-panel';creditPanel.id='credit-topup-panel';
const creditTitle=document.createElement('h3');creditTitle.textContent='クレジットをチャージ';
const topupReloadButton=document.createElement('button');topupReloadButton.type='button';topupReloadButton.className='secondary-btn credit-reload-button';topupReloadButton.textContent='残高・履歴を再読み込み';
const topupReloadStatus=document.createElement('p');topupReloadStatus.className='billing-action-status';topupReloadStatus.setAttribute('role','status');topupReloadStatus.setAttribute('aria-live','polite');
const topupReloadActions=document.createElement('div');topupReloadActions.className='credit-reload-actions';topupReloadActions.append(topupReloadButton,topupReloadStatus);
const creditExpiry=document.createElement('p');creditExpiry.className='credit-expiry';creditExpiry.textContent='購入クレジットの有効期限は購入日から1年間です。';
const topupControls=document.createElement('div');topupControls.className='credit-topup-controls';
const topupEmailLabel=document.createElement('label');topupEmailLabel.className='billing-email-label';
const topupEmailCaption=document.createElement('span');topupEmailCaption.textContent='連絡先メールアドレス';
const topupEmail=document.createElement('input');topupEmail.id='topup-email';topupEmail.type='email';topupEmail.maxLength=254;topupEmail.autocomplete='email';topupEmail.required=true;topupEmail.placeholder='name@example.com';
const topupEmailHelp=document.createElement('p');topupEmailHelp.className='help billing-email-help';topupEmailHelp.textContent='チャージ結果のお知らせに使用します。';
topupEmailLabel.append(topupEmailCaption,topupEmail);
const topupLabel=document.createElement('label');topupLabel.className='topup-amount-label';const topupCaption=document.createElement('span');topupCaption.textContent='チャージ金額（1円＝1クレジット）';
const topupAmount=document.createElement('input');topupAmount.type='number';topupAmount.inputMode='numeric';topupAmount.min='500';topupAmount.max='100000';topupAmount.step='1';topupAmount.value='500';topupAmount.required=true;
topupLabel.append(topupCaption,topupAmount);
const topupPresets=document.createElement('div');topupPresets.className='credit-preset-buttons';
for(const amount of [500,1000,3000,5000]){const button=document.createElement('button');button.type='button';button.className='secondary-btn';button.textContent=`${amount.toLocaleString('ja-JP')}円`;button.onclick=()=>{topupAmount.value=String(amount);};topupPresets.append(button);}
const creditConsent=document.createElement('label');creditConsent.className='credit-consent';
const creditConsentInput=document.createElement('input');creditConsentInput.type='checkbox';creditConsentInput.required=true;
const creditConsentText=document.createElement('span');creditConsentText.textContent='購入額と同数のクレジットがチャージされ、購入日から1年後に未使用分が失効することを確認しました。';
creditConsent.append(creditConsentInput,creditConsentText);
const topupButton=document.createElement('button');topupButton.type='button';topupButton.className='primary-btn';topupButton.textContent='チャージ手続きへ';
topupButton.disabled=true;
const topupStatus=document.createElement('p');topupStatus.className='billing-action-status';topupStatus.setAttribute('role','status');topupStatus.setAttribute('aria-live','polite');
topupControls.append(topupEmailLabel,topupEmailHelp,topupLabel,topupPresets,creditConsent,topupButton,topupStatus);
const topupSignup=document.createElement('div');topupSignup.className='credit-signup-panel';
const topupSignupTitle=document.createElement('h4');topupSignupTitle.textContent='クレジットでプランを申し込む';
const topupPlan=document.createElement('select');topupPlan.setAttribute('aria-label','クレジットで申し込むプラン');selectOptions(topupPlan,PLAN_OPTIONS,'supporter');
const topupChannelPacks=document.createElement('select');topupChannelPacks.setAttribute('aria-label','クレジット申込みの追加チャンネル');selectOptions(topupChannelPacks,CHANNEL_PACK_OPTIONS,0);
const topupServerPacks=document.createElement('select');topupServerPacks.setAttribute('aria-label','クレジット申込みの追加サーバー');selectOptions(topupServerPacks,SERVER_PACK_OPTIONS,0);
const topupSignupOptions=document.createElement('div');topupSignupOptions.className='billing-options';
for(const [labelText,input] of [['プラン',topupPlan],['チャンネル追加',topupChannelPacks],['サーバー追加',topupServerPacks]]){const label=document.createElement('label');const span=document.createElement('span');span.textContent=labelText;label.append(span,input);topupSignupOptions.append(label);}
const topupSignupPreview=document.createElement('p');topupSignupPreview.className='price-preview';
const topupSignupWarning=document.createElement('p');topupSignupWarning.className='credit-balance-warning';topupSignupWarning.id='credit-signup-balance-warning';topupSignupWarning.setAttribute('role','alert');
const topupSignupConsent=document.createElement('label');topupSignupConsent.className='legal-consent';
const topupSignupConsentInput=document.createElement('input');topupSignupConsentInput.type='checkbox';topupSignupConsentInput.required=true;
const topupSignupConsentText=document.createElement('span');topupSignupConsentText.append('申込み内容を確認し、');
for(const [label,href] of [['利用規約','/terms/terms.html'],['プライバシーポリシー','/terms/policy.html'],['特定商取引法に基づく表記','/terms/Specified.html']]){const link=document.createElement('a');link.textContent=label;link.href=href;link.target='_blank';link.rel='noopener noreferrer';topupSignupConsentText.append(link,label==='特定商取引法に基づく表記'?'に同意します。':'、');}
topupSignupConsent.append(topupSignupConsentInput,topupSignupConsentText);
const topupSignupButton=document.createElement('button');topupSignupButton.type='button';topupSignupButton.className='primary-btn';topupSignupButton.textContent='クレジットでこのプランを申し込む';topupSignupButton.setAttribute('aria-describedby',topupSignupWarning.id);
const topupSignupStatus=document.createElement('p');topupSignupStatus.className='billing-action-status';topupSignupStatus.setAttribute('role','status');topupSignupStatus.setAttribute('aria-live','polite');
topupSignup.append(topupSignupTitle,topupSignupOptions,topupSignupPreview,topupSignupWarning,topupSignupConsent,topupSignupButton,topupSignupStatus);
const creditHistoryTitle=document.createElement('h4');creditHistoryTitle.textContent='クレジット履歴';
const creditHistory=document.createElement('div');creditHistory.className='credit-history';creditHistory.textContent='クレジット履歴はありません。';
creditPanel.append(creditTitle,topupReloadActions,creditExpiry,topupControls,topupSignup,creditHistoryTitle,creditHistory);
const setBillingMode=mode=>{
 const selected=mode==='topup'?'topup':'payment';
 creditPanel.hidden=selected!=='topup';application.hidden=selected!=='payment';
 topupModeButton.classList.toggle('is-active',selected==='topup');paymentModeButton.classList.toggle('is-active',selected==='payment');
 topupModeButton.setAttribute('aria-pressed',String(selected==='topup'));paymentModeButton.setAttribute('aria-pressed',String(selected==='payment'));
};
topupModeButton.onclick=()=>setBillingMode('topup');paymentModeButton.onclick=()=>setBillingMode('payment');
billing.append(title,credit,modeGuide,application,creditPanel);
setBillingMode(new URLSearchParams(location.search).has('credit')?'topup':'payment');
const invoiceTitle=document.createElement('h3');invoiceTitle.className='invoice-title';invoiceTitle.textContent='支払い明細';
const invoiceHistory=document.createElement('div');invoiceHistory.className='invoice-history';invoiceHistory.textContent='契約後に請求明細を確認できます。';
const plan = document.createElement('select');
plan.setAttribute('aria-label','契約プラン');
selectOptions(plan,PLAN_OPTIONS,'supporter');
const channelPacks = document.createElement('select');
channelPacks.setAttribute('aria-label','追加チャンネル');
selectOptions(channelPacks,CHANNEL_PACK_OPTIONS,0);
const serverPacks = document.createElement('select');
serverPacks.setAttribute('aria-label','追加サーバー');
selectOptions(serverPacks,SERVER_PACK_OPTIONS,0);
const optionGrid=document.createElement('div');optionGrid.className='billing-options';
for(const [labelText,input] of [['プラン',plan],['チャンネル追加',channelPacks],['サーバー追加',serverPacks]]){const label=document.createElement('label');const span=document.createElement('span');span.textContent=labelText;label.append(span,input);optionGrid.append(label);}
const pricePreview=document.createElement('p');pricePreview.className='price-preview';
const checkoutSummary=document.createElement('dl');checkoutSummary.className='checkout-summary';
const creditPaymentChoice=document.createElement('label');creditPaymentChoice.className='credit-payment-choice';
const creditPaymentInput=document.createElement('input');creditPaymentInput.type='checkbox';
const creditPaymentText=document.createElement('span');creditPaymentChoice.append(creditPaymentInput,creditPaymentText);
const updatePricePreview=()=>{const base={supporter:300,plus:800,pro:1280}[plan.value]||300;const monthly=base+200*(Number(channelPacks.value)+Number(serverPacks.value));const jstDay=Number(new Intl.DateTimeFormat('en-US',{day:'numeric',timeZone:'Asia/Tokyo'}).format(new Date()));const initial=monthly*(jstDay>=26?2:1);const canPayWithCredits=availableCredits>=initial;if(!canPayWithCredits)creditPaymentInput.checked=false;creditPaymentInput.disabled=!canPayWithCredits;creditPaymentText.textContent=canPayWithCredits?`${initial.toLocaleString('ja-JP')}クレジットで全額支払う（支払い後残高 ${(availableCredits-initial).toLocaleString('ja-JP')}クレジット）`:`全額払いには${initial.toLocaleString('ja-JP')}クレジット必要です（現在 ${availableCredits.toLocaleString('ja-JP')}クレジット）`;pricePreview.textContent=`月額 ${monthly.toLocaleString('ja-JP')}円／新規申込時 ${initial.toLocaleString('ja-JP')}円（${jstDay>=26?'当月分＋翌月分':'当月分'}）`;checkoutSummary.replaceChildren();const rows=[['申込みプラン',{supporter:'BASIC',plus:'Plus',pro:'Pro'}[plan.value]],['初回支払額',`${initial.toLocaleString('ja-JP')}円`],['申込時の支払方法',creditPaymentInput.checked?'チャージ済みクレジット':'クレジットカード等'],['次回以降','毎月26日に翌月分を請求'],['提供開始','決済確認後'],['解約','契約管理画面から手続きし、期間末で終了。支払済み料金の返金なし']];for(const [term,value] of rows){const dt=document.createElement('dt');dt.textContent=term;const dd=document.createElement('dd');dd.textContent=value;checkoutSummary.append(dt,dd);}updateCheckoutAvailability();};
for(const input of [plan,channelPacks,serverPacks])input.addEventListener('change',updatePricePreview);
creditPaymentInput.addEventListener('change',updatePricePreview);
updatePricePreview();application.append(optionGrid,pricePreview,checkoutSummary,creditPaymentChoice);

const selectedInitialCharge=(selectedPlan,selectedChannelPacks,selectedServerPacks)=>{
 const base={supporter:300,plus:800,pro:1280}[selectedPlan]||300;
 const monthly=base+200*(Number(selectedChannelPacks)+Number(selectedServerPacks));
 const jstDay=Number(new Intl.DateTimeFormat('en-US',{day:'numeric',timeZone:'Asia/Tokyo'}).format(new Date()));
 return {monthly,initial:monthly*(jstDay>=26?2:1),lateMonth:jstDay>=26};
};
function updateTopupSignupAvailability(){
 if(!topupSignupButton)return;
 const price=selectedInitialCharge(topupPlan.value,topupChannelPacks.value,topupServerPacks.value);
 if(hasExistingContract){
  topupSignupTitle.textContent='残クレジットでプラン・オプションを変更';
  topupSignupPreview.textContent=`変更後の月額 ${price.monthly.toLocaleString('ja-JP')}円`;
  topupSignupWarning.classList.remove('is-shortage');
  topupSignupWarning.classList.add('is-sufficient');
  topupSignupWarning.textContent=`現在の残高は${availableCredits.toLocaleString('ja-JP')}クレジットです。アップグレード差額と次回26日の請求に利用できます。`;
  topupSignupConsent.hidden=true;
  topupSignupButton.disabled=!billingAvailable||customPlanLocked;
  topupSignupButton.title='';
  topupSignupButton.textContent='プラン・オプションの料金を確認';
  return;
 }
 topupSignupTitle.textContent='クレジットでプランを申し込む';
 topupSignupConsent.hidden=false;
 const shortage=Math.max(0,price.initial-availableCredits);
 topupSignupPreview.textContent=`月額 ${price.monthly.toLocaleString('ja-JP')}円／申込時 ${price.initial.toLocaleString('ja-JP')}クレジット（${price.lateMonth?'当月分＋翌月分':'当月分'}）`;
 topupSignupWarning.classList.toggle('is-shortage',shortage>0);
 topupSignupWarning.classList.toggle('is-sufficient',shortage===0);
 topupSignupWarning.textContent=shortage>0
  ?`クレジットが${shortage.toLocaleString('ja-JP')}不足しています。先に不足分以上をチャージしてください。現在の残高は${availableCredits.toLocaleString('ja-JP')}クレジットです。`
  :`申込みに必要な残高があります。支払い後は${(availableCredits-price.initial).toLocaleString('ja-JP')}クレジット残ります。`;
 topupSignupButton.disabled=!billingAvailable||customPlanLocked||hasExistingContract||shortage>0||!topupSignupConsentInput.checked;
 topupSignupButton.title=hasExistingContract?'既に契約済みです。プラン変更をご利用ください。':shortage>0?'クレジット残高が不足しています。':'';
 topupSignupButton.textContent=hasExistingContract?'契約中':shortage>0?'クレジットが不足しています':'クレジットでこのプランを申し込む';
}
for(const input of [topupPlan,topupChannelPacks,topupServerPacks])input.addEventListener('change',updateTopupSignupAvailability);
topupSignupConsentInput.addEventListener('change',updateTopupSignupAvailability);
updateTopupSignupAvailability();

const legalConsentLabel=document.createElement('label');legalConsentLabel.className='legal-consent';
const legalConsent=document.createElement('input');legalConsent.type='checkbox';legalConsent.id='legal-consent';legalConsent.required=true;
const legalConsentText=document.createElement('span');legalConsentText.append('申込み内容を確認し、');
for(const [label,href] of [['利用規約','/terms/terms.html'],['プライバシーポリシー','/terms/policy.html'],['特定商取引法に基づく表記','/terms/Specified.html']]){const link=document.createElement('a');link.textContent=label;link.href=href;link.target='_blank';link.rel='noopener noreferrer';legalConsentText.append(link,label==='特定商取引法に基づく表記'?'に同意します。':'、');}
legalConsentLabel.append(legalConsent,legalConsentText);application.append(legalConsentLabel);
legalConsent.addEventListener('change',updateCheckoutAvailability);

topupButton.onclick=async()=>{
 topupStatus.textContent='';
 if(!billingAvailable){topupStatus.textContent='現在はクレジットをチャージできません。時間をおいて再度お試しください。';return;}
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
  renderContracts(state.subscriptions||[],state.dunning,state.customPlan,state.customCheckoutUrl);renderInvoices(state.invoices||[]);renderCreditDetails(state.creditDetails||{balance:Number(state.credits||0)});
  const recovery=state.creditTopupRecovery||{};
  if(recovery.recovered>0){topupReloadStatus.textContent=`支払い済みのチャージ${recovery.recovered}件を反映しました。`;status(topupReloadStatus.textContent);}
  else if(recovery.failed>0){topupReloadStatus.textContent='支払い状況を取得できませんでした。時間をおいて再度お試しください。';status(topupReloadStatus.textContent);}
  else topupReloadStatus.textContent='クレジット残高とチャージ履歴を更新しました。';
 }catch(error){topupReloadStatus.textContent=error.message;status(error.message);}
 finally{topupReloadButton.disabled=false;topupReloadButton.textContent=original;}
};

topupSignupButton.onclick=async()=>{
 topupSignupStatus.textContent='';
 const selection={plan:topupPlan.value,channelPacks:Number(topupChannelPacks.value),serverPacks:Number(topupServerPacks.value)};
 if(hasExistingContract){
  topupSignupButton.disabled=true;const original=topupSignupButton.textContent;topupSignupButton.textContent='料金を計算中…';
  try{
   const result=await api('/api/supporter/billing/preview-update','POST',selection);
   showBillingPreview(result,selection);
  }catch(error){topupSignupStatus.textContent=error.message;status(error.message);}
  finally{topupSignupButton.textContent=original;updateTopupSignupAvailability();}
  return;
 }
 if(!topupEmail.reportValidity()||!topupSignupConsentInput.reportValidity())return;
 const price=selectedInitialCharge(topupPlan.value,topupChannelPacks.value,topupServerPacks.value);
 if(availableCredits<price.initial){updateTopupSignupAvailability();topupSignupStatus.textContent=`クレジットが ${(price.initial-availableCredits).toLocaleString('ja-JP')} 不足しています。先にチャージしてください。`;return;}
 topupSignupButton.disabled=true;const original=topupSignupButton.textContent;topupSignupButton.textContent='申込み処理中…';
 try{
  const result=await api('/api/supporter/billing/checkout','POST',{...selection,email:topupEmail.value,legalConsent:true,useCredits:true,requestId:crypto.randomUUID()});
  if(result.url)location.href=stripeDestination(result.url);
  else{renderContracts(result.subscriptions||[],result.dunning);renderInvoices(result.invoices||[]);renderCreditDetails(result.creditDetails||{balance:Number(result.credits||0)});status(result.message||'クレジットでプランを申し込みました。');topupSignupStatus.textContent=result.message||'申込みが完了しました。';}
 }catch(error){topupSignupStatus.textContent=error.message;status(error.message);}
 finally{topupSignupButton.textContent=original;updateTopupSignupAvailability();}
};

const dateText = seconds => seconds ? new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Tokyo'}).format(new Date(seconds * 1000)) : '—';
const moneyText = (amount,currency) => new Intl.NumberFormat('ja-JP',{style:'currency',currency:(currency || 'jpy').toUpperCase(),maximumFractionDigits:0}).format(amount || 0);
const STATUS_LABELS = {active:'有効',trialing:'有効（次回請求待ち）',past_due:'支払い遅延',unpaid:'未払い',paused:'一時停止',incomplete:'手続き未完了',paid:'支払い済み',open:'支払い待ち',draft:'作成中',void:'無効'};
const TOPUP_STATUS_LABELS={pending:'決済待ち',credited:'チャージ済み',failed:'未完了',expired:'失効済み',refunded:'返金済み',disputed:'異議申立て'};

function renderCreditDetails(details={}){
 const balance=Number(details.balance||0),purchased=Number(details.purchasedBalance||0);
 availableCredits=Math.max(0,balance);
 credit.textContent=`利用可能クレジット: ${balance.toLocaleString('ja-JP')}クレジット（${balance.toLocaleString('ja-JP')}円）`;
 creditExpiry.textContent=details.nextExpiry
  ?`購入クレジット残高 ${purchased.toLocaleString('ja-JP')}ポイント／有効期限付きクレジットの最も近い期限: ${dateText(details.nextExpiry)}`
  :'購入クレジットの有効期限は購入日から1年間です。';
 updatePricePreview();
 updateTopupSignupAvailability();
 creditHistory.replaceChildren();
 const rows=Array.isArray(details.topups)?details.topups:[];
 const compensations=Array.isArray(details.compensations)?details.compensations:[];
 const confiscations=Array.isArray(details.adminConfiscations)?details.adminConfiscations:[];
 if(!rows.length&&!compensations.length&&!confiscations.length){creditHistory.textContent='クレジット履歴はありません。';return;}
 for(const item of compensations){
  const card=document.createElement('article');card.className='credit-history-card compensation-credit-card';
  const heading=document.createElement('strong');heading.textContent=`補償 ${Number(item.amount||0).toLocaleString('ja-JP')}クレジット・${item.status==='expired'?'失効済み':'付与済み'}`;
  const reason=document.createElement('p');reason.textContent=`理由: ${item.reason||'—'}`;
  const dates=document.createElement('p');dates.textContent=`付与: ${dateText(item.creditedAt)}／有効期限: ${dateText(item.expiresAt)}／残高: ${Number(item.remainingAmount||0).toLocaleString('ja-JP')}クレジット`;
  card.append(heading,reason,dates);creditHistory.append(card);
 }
 for(const item of confiscations){
  const card=document.createElement('article');card.className='credit-history-card confiscated-credit-card';
  const heading=document.createElement('strong');heading.textContent=`${Number(item.amount||0).toLocaleString('ja-JP')}クレジット・管理者による没収`;
  const reason=document.createElement('p');reason.textContent=`理由: ${item.reason||'—'}`;
  const dates=document.createElement('p');dates.textContent=`処理: ${dateText(item.processedAt)}／処理後残高: ${Number(item.balanceAfter||0).toLocaleString('ja-JP')}クレジット`;
  card.append(heading,reason,dates);creditHistory.append(card);
 }
 for(const item of rows){
  const card=document.createElement('article');card.className='credit-history-card';
  const heading=document.createElement('strong');heading.textContent=`${Number(item.amount||0).toLocaleString('ja-JP')}クレジット・${TOPUP_STATUS_LABELS[item.status]||item.status}`;
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
  const heading=document.createElement('h4');heading.textContent=invoice.number?`請求書 ${invoice.number}`:'請求書';
  const meta=document.createElement('p');meta.textContent=`${dateText(invoice.created)}・${STATUS_LABELS[invoice.status]||invoice.status}・${moneyText(invoice.total,invoice.currency)}`;
  const actions=document.createElement('div');actions.className='invoice-actions';
  for(const [label,url] of [['請求書を見る',invoice.hostedInvoiceUrl],['PDFを開く',invoice.invoicePdf]])if(url){const anchor=document.createElement('a');anchor.className='secondary-btn';anchor.textContent=label;anchor.href=stripeDocumentDestination(url);anchor.target='_blank';anchor.rel='noopener noreferrer';actions.append(anchor);}
  card.append(heading,meta,actions);invoiceHistory.append(card);
 }
}

function renderContracts(subscriptions,dunning={},customPlan=null,customCheckoutUrl='') {
 contract.replaceChildren();
 customPlanLocked=customPlan?.locked===true;
 for(const button of document.querySelectorAll('[data-billing-action]')){
  if(['checkout','update','portal'].includes(button.dataset.billingAction)){
   button.disabled=customPlanLocked;
   button.title=customPlanLocked?'管理者提供のカスタムプラン中は変更できません。':'';
  }
 }
 if(customPlanLocked){
  const card=document.createElement('section');card.className='contract-card';
  const title=document.createElement('h3');title.textContent=customPlan.name||'カスタムプラン';
  const details=document.createElement('p');details.textContent=`管理者提供／${customPlan.status==='active'?'利用中':'支払い待ち'}／月額 ${Number(customPlan.monthlyYen).toLocaleString('ja-JP')}円。上限：${customPlan.channels}チャンネル、${customPlan.servers}サーバー、${customPlan.rules}ルール。プラン変更は管理者のみ可能です。`;
  card.append(title,details);
  if(customPlan.status==='offered'&&customCheckoutUrl){const pay=document.createElement('a');pay.href=stripeDestination(customCheckoutUrl);pay.textContent='専用の支払い手続きへ';pay.rel='noopener noreferrer';card.append(pay);}
  const reuse=document.createElement('p');reuse.textContent=customPlan.secondaryReuse?'二次利用の契約上の対象です。実施前には別途申請・承認が必要です。':'二次利用はこの契約では許可されていません。';card.append(reuse);
  contract.append(card);
 }

 hasExistingContract=subscriptions.length>0;
 updateCheckoutAvailability();
 updateTopupSignupAvailability();
 if (!subscriptions.length) {
  if(!customPlanLocked)contract.textContent = '現在の契約はありません。';
  entitlements={servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false,prefecture:false,municipality:false,strictMunicipality:false};
  if(options)setRuleAccess(false);
  return;
 }
 const active=subscriptions.filter(item=>item.recognizedPlan!==false&&['active','trialing','past_due','unpaid','paused'].includes(item.status));
 const geographicPlans=new Set(active.map(item=>item.planId));
 const custom=active.find(item=>item.managedCustom===true);
 entitlements={...active.reduce((limits,item)=>({servers:Math.max(limits.servers,Number(item.servers)||1),channels:Math.max(limits.channels,Number(item.channels)||2),rules:Math.max(limits.rules,Number(item.rules)||5),complexConditions:limits.complexConditions||item.complexConditions===true,multiDestination:limits.multiDestination||item.multiDestination===true}),{servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false}),prefecture:!!custom?.municipalityBranching||geographicPlans.has('plus')||geographicPlans.has('pro'),municipality:!!custom?.municipalityBranching||geographicPlans.has('plus')||geographicPlans.has('pro'),strictMunicipality:!!custom?.contentExtraction||geographicPlans.has('pro')};
 const current=active[0]||subscriptions[0];
 if(dunning?.usageSuspended){const warning=document.createElement('p');warning.className='billing-suspension';warning.textContent='月末再決済を確認できなかったため、有料プランの通知設定は利用停止中です。契約管理画面からお支払いを完了してください。';contract.append(warning);}
 if(current){
  plan.value=current.planId||'supporter';channelPacks.value=String(current.channelPacks||0);serverPacks.value=String(current.serverPacks||0);
  topupPlan.value=current.planId||'supporter';topupChannelPacks.value=String(current.channelPacks||0);topupServerPacks.value=String(current.serverPacks||0);
  updatePricePreview();updateTopupSignupAvailability();
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
 const paymentMethod=usesCredits?(hasRemainingPayment?'クレジット＋登録済みのお支払い方法':'クレジット'):'登録済みのお支払い方法';
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
  ['今回利用するクレジット',result.immediateCreditApplied?`−${moneyText(result.immediateCreditApplied,'jpy')}`:'なし'],
  ['今回のお支払い見込み',moneyText(result.immediateDue,'jpy')],
  ['次回26日の請求予定額',moneyText(result.nextInvoiceSubtotal,'jpy')],
  ['次回利用するクレジット',result.nextInvoiceCreditApplied?`−${moneyText(result.nextInvoiceCreditApplied,'jpy')}`:'なし'],
  ['次回26日のお支払い見込み',moneyText(result.nextInvoiceDue,'jpy')],
  ['適用後の残クレジット',moneyText(result.remainingCreditsAfterNext,'jpy')],
  ['次回更新日',dateText(result.nextRenewalAt)],
  ['チャンネル上限',`${result.current.channels} → ${result.next.channels}`],
  ['サーバー上限',`${result.current.servers} → ${result.next.servers}`],
  ['通知ルール上限',`${result.current.rules} → ${result.next.rules}`],
 );
 if(result.creditGenerated)rows.push(['差額から発生するクレジット',moneyText(result.creditGenerated,'jpy')]);
 for(const [term,value] of rows){const dt=document.createElement('dt');dt.textContent=term;const dd=document.createElement('dd');dd.textContent=value;data.append(dt,dd);}
 const optionNote=document.createElement('p');optionNote.className='preview-notice';optionNote.textContent=result.notice;
 previewContent.append(heading,data,optionNote);
 const confirmButton=$('billing-preview-confirm');
 confirmButton.textContent=result.changeTiming==='next_period'?'変更を予約':'変更を確定';
 if(result.creditApplied>0){
  const creditConsent=document.createElement('label');creditConsent.className='credit-consent';
  const creditConsentInput=document.createElement('input');creditConsentInput.type='checkbox';
  const creditParts=[];
  if(result.immediateCreditApplied)creditParts.push(`今回${moneyText(result.immediateCreditApplied,'jpy')}`);
  if(result.nextInvoiceCreditApplied)creditParts.push(`次回26日${moneyText(result.nextInvoiceCreditApplied,'jpy')}`);
  const creditConsentText=document.createElement('span');creditConsentText.textContent=`${creditParts.join('、')}のクレジットを使用します。残額は今回${moneyText(result.immediateDue,'jpy')}、次回26日${moneyText(result.nextInvoiceDue,'jpy')}です。`;
  creditConsentInput.addEventListener('change',()=>{if(pendingUpdate)pendingUpdate.useCredits=creditConsentInput.checked;confirmButton.disabled=!creditConsentInput.checked;});
  creditConsent.append(creditConsentInput,creditConsentText);previewContent.append(creditConsent);confirmButton.textContent=result.changeTiming==='next_period'?'クレジットを使って変更を予約':'クレジットを使って変更を確定';confirmButton.disabled=true;
 }else confirmButton.disabled=false;
 previewDialog.showModal();
}
$('billing-preview-cancel').onclick=()=>{pendingUpdate=null;const confirmButton=$('billing-preview-confirm');confirmButton.disabled=false;confirmButton.textContent='変更を確定';previewDialog.close();};
$('billing-preview-confirm').onclick=run(async()=>{
 if(!pendingUpdate)return;
 const button=$('billing-preview-confirm');button.disabled=true;
 try{
  const result=await api('/api/supporter/billing/update','POST',{...pendingUpdate.requested,prorationDate:pendingUpdate.prorationDate,expectedCreditApplied:pendingUpdate.expectedCreditApplied,useCredits:pendingUpdate.useCredits,requestId:crypto.randomUUID()});
  pendingUpdate=null;previewDialog.close();
  const state=await api('/api/supporter/billing/status');applyAccountEnforcement(state.accountEnforcement);renderContracts(state.subscriptions||[],state.dunning,state.customPlan,state.customCheckoutUrl);renderInvoices(state.invoices||[]);
  renderCreditDetails(state.creditDetails||{balance:Number(state.credits||result.credits||0)});status(result.message||'契約情報を更新しました。');
 } finally {button.disabled=false;}
});

const billingActionStatus=document.createElement('p');
billingActionStatus.className='billing-action-status';
billingActionStatus.setAttribute('role','status');
billingActionStatus.setAttribute('aria-live','polite');
const billingActions=document.createElement('div');
billingActions.className='billing-actions';
application.append(billingActions,billingActionStatus);

function updateCheckoutAvailability(){
 if(!checkoutButton)return;
 checkoutButton.disabled=!billingAvailable||customPlanLocked||!legalConsent.checked||hasExistingContract;
 checkoutButton.title=accountSuspended?'有料プランアカウントがBANされています。':hasExistingContract?'既に契約済みです。プラン変更をご利用ください。':'';
 checkoutButton.textContent=hasExistingContract?'契約中':creditPaymentInput.checked?'クレジットで申し込む':'このプランで申し込む';
}

for (const [label,action] of [['このプランで申し込む','checkout'],['プラン・オプションを変更','update'],['支払い方法・解約','portal'],['契約・明細を更新','status']]) {
 const button = document.createElement('button');
 button.textContent = label;
 button.className=action==='checkout'?'primary-btn':'secondary-btn';
 button.type='button';button.dataset.billingAction=action;
 if(action==='checkout'){checkoutButton=button;updateCheckoutAvailability();}
 button.onclick = async () => {
  billingActionStatus.textContent='';
  if(customPlanLocked&&['checkout','update','portal'].includes(action)){billingActionStatus.textContent='カスタムプランの変更は管理者にお問い合わせください。';return;}
  if(accountSuspended&&['checkout','update'].includes(action)){billingActionStatus.textContent='有料プランアカウントがBANされているため、この操作は利用できません。';return;}
  if(action==='checkout'&&!billingEmail.reportValidity())return;
  if(action==='checkout'&&!legalConsent.reportValidity())return;
  button.disabled = true;
  const originalLabel=button.textContent;
  button.textContent=action==='checkout'?'決済画面を準備中…':'処理中…';
  try {
   const selection={plan:plan.value,channelPacks:Number(channelPacks.value),serverPacks:Number(serverPacks.value)};
   if(action==='update'){
    const result=await api('/api/supporter/billing/preview-update','POST',selection);
    showBillingPreview(result,selection);return;
   }
   const body=action==='checkout'?{...selection,email:billingEmail.value,legalConsent:true,useCredits:creditPaymentInput.checked,requestId:crypto.randomUUID()}:{};
   const result = await api(`/api/supporter/billing/${action}`,action === 'status' ? 'GET' : 'POST',action === 'status' ? undefined : body);
   if (result.url) {
    location.href = stripeDestination(result.url);
   } else {
    applyAccountEnforcement(result.accountEnforcement||{});
    renderContracts(result.subscriptions||[],result.dunning);renderInvoices(result.invoices||[]);
    renderCreditDetails(result.creditDetails||{balance:Number(result.credits||0)});
    status(result.message||'契約情報を更新しました。');
   }
  } catch(error) {
   billingActionStatus.textContent=error.message;
   status(error.message);
  } finally {button.disabled=false;button.textContent=originalLabel;}
 };
 billingActions.append(button);
}
billing.append(contract,invoiceTitle,invoiceHistory);
run(load)();
