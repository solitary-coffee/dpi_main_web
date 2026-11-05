let session;
let revision = 0;
let rules = [];
let options;
let entitlements = {servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false};
let hasConfigurableContract = false;
let billingAvailable = false;
let checkoutButton;
let hasExistingContract=false;
const channelsByGuild = new Map();

const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; };
const INTENSITIES = [['1','1'],['2','2'],['3','3'],['4','4'],['5-','5弱'],['5+','5強'],['6-','6弱'],['6+','6強'],['7','7']];
const TYPES = [['earthquake','地震情報'],['eew','緊急地震速報'],['weather','気象情報']];
const WEATHER_ALERT_DETAILS = new Set(['heavy-rain-level','landslide-level','storm-surge-level']);
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
  } else if (key === 'type' || key === 'detail' || key === 'intensityMode' || key === 'magnitudeMode' || key === 'conditionLogic') {
   if (key === 'type') {rule.detail = 'all';rule.conditions=[];}
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
 return options.weatherDetails;
}

function conditionKinds(rule){
 const common=[['region','対象地方'],['detail','詳細種別']];
 return rule.type==='weather'?[...common,['weatherLevel','警戒レベル'],['warningLevel','警報・注意報']]:[...common,['intensity','震度の下限'],['magnitude','マグニチュードの下限']];
}
function conditionValues(rule,kind){
 if(kind==='region')return options.regions;
 if(kind==='detail')return detailOptions(rule.type);
 if(kind==='intensity')return INTENSITIES;
 if(kind==='weatherLevel')return options.weatherLevels;
 if(kind==='warningLevel')return options.warningLevels;
 return null;
}
function defaultConditionValue(rule,kind){return kind==='magnitude'?'4.0':String(conditionValues(rule,kind)?.[0]?.[0]||'');}
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
  if(values)selectOptions(value,values,String(condition.value??''));else{value.value=String(condition.value??'');value.inputMode='decimal';value.placeholder='0〜10';}
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
  region: rule.region || 'all',
  intensityMode: rule.intensityMode || (rule.intensityChange === 'increase' ? 'increase' : rule.intensity ? 'threshold' : 'all'),
  intensity: rule.intensity || '4',
  magnitudeMode: rule.magnitudeMode || (rule.magnitudeChange === 'increase' ? 'increase' : rule.magnitudeMin !== null && rule.magnitudeMin !== undefined && rule.magnitudeMin !== '' ? 'threshold' : 'all'),
  magnitudeMin: rule.magnitudeMin ?? '',
  weatherLevel: rule.weatherLevel || 'all',
  warningLevel: rule.warningLevel || 'all',
  eewWarningAreaMode: rule.eewWarningAreaMode || 'all',
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
  field(article, rule, 'detail', '詳細', detailOptions(rule.type));
  if(entitlements.complexConditions)field(article, rule, 'conditionLogic', '条件の組み合わせ', [['and','すべて満たす（AND）'],['or','いずれかを満たす（OR）']]);
  if (rule.type === 'eew' && rule.detail === 'warning') field(article, rule, 'eewWarningAreaMode', '警報地方の条件', options.eewWarningAreaModes);
  const conditionFields=document.createElement('div');conditionFields.className='rule-condition-fields';
  field(conditionFields, rule, 'region', '対象地方', options.regions);
  if (rule.type === 'weather') {
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
 const {account,billingEnabled} = await api('/api/supporter/account');
 billingAvailable=billingEnabled===true;
 $('billing-email').value = account?.billing_email || '';
 updateCheckoutAvailability();
 if(!billingAvailable)billingActionStatus.textContent='Stripeテスト決済の秘密設定が未登録です。現在は申し込みできません。';
 $('add').disabled = $('save').disabled = true;
 if (account) {
  revision = account.revision;
  rules = savedRules(account);
  await Promise.all([...new Set(rules.map(rule => rule.guildId).filter(Boolean))].map(guildId => loadChannels(guildId)));
  render();
  if(billingEnabled){
   try{
    const billingState=await api('/api/supporter/billing/status');
    renderContracts(billingState.subscriptions||[],billingState.dunning);renderInvoices(billingState.invoices||[]);
    if(billingState.rulesAdjustment?.changed){
     revision=Number(billingState.rulesAdjustment.revision)||revision;
     rules=(billingState.rulesAdjustment.rules||[]).map(normalizeRule);
     await Promise.all([...new Set(rules.map(rule=>rule.guildId).filter(Boolean))].map(guildId=>loadChannels(guildId)));
     render();
     const removed=Number(billingState.rulesAdjustment.removedRules||0),destinations=Number(billingState.rulesAdjustment.removedDestinations||0),simplified=Number(billingState.rulesAdjustment.simplifiedRules||0);
     status(`契約上限の変更を反映しました。${removed?`下側の通知ルールを${removed}件削除しました。`:''}${destinations?`上限を超える通知先を${destinations}件解除しました。`:''}${simplified?`下位プラン向けに${simplified}件の条件を調整しました。`:''}`);
    }
    const credits=Number(billingState.credits||0);
    credit.textContent=`利用可能クレジット: ${credits.toLocaleString('ja-JP')}クレジット（${credits.toLocaleString('ja-JP')}円）`;
    if(billingState.recoveredSubscription)status('支払い済みの申込みから契約を復旧し、有料プランを有効化しました。');
   }catch{contract.textContent='契約情報を自動取得できませんでした。「最新の契約・明細を読み込む」を押してください。';setRuleAccess(false);}
  }
 }
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
 status('通知設定を保存しました。先行提供期間中のため、通知配信にはまだ反映されません。');
});

const billing = $('billing');
billing.replaceChildren();
const title = document.createElement('h2');
title.textContent = 'お支払い・契約情報';
const note = document.createElement('p');
note.textContent = '請求日は毎月26日です。1〜25日の申込は当月分を申込時、翌月分を26日に請求します。26〜31日の申込は当月分と翌月分の2か月分を申込時にまとめて請求し、以後は毎月26日に翌月分を請求します。26日の支払いに失敗した場合はメールでお知らせし、月の最終日に1回再決済します。再決済にも失敗した場合は翌月から支払い完了まで有料機能を停止します。支払い成功時にもメールでお知らせします。現在の接続先はStripeテスト環境のため、実際の請求は発生しません。';
const application = document.createElement('div');
application.className = 'billing-application';
const applicationTitle = document.createElement('h3');
applicationTitle.textContent = 'お申し込み内容';
const emailLabel = document.createElement('label');
emailLabel.className = 'billing-email-label';
const emailCaption = document.createElement('span');
emailCaption.textContent = 'お申し込みメールアドレス';
const billingEmail = document.createElement('input');
billingEmail.id = 'billing-email';
billingEmail.type = 'email';
billingEmail.maxLength = 254;
billingEmail.autocomplete = 'email';
billingEmail.required = true;
billingEmail.placeholder = 'name@example.com';
const emailHelp = document.createElement('p');
emailHelp.className = 'help billing-email-help';
emailHelp.textContent = 'Stripeの顧客情報、請求、契約に関する連絡に使用します。申し込み時に同時に登録・更新されます。';
emailLabel.append(emailCaption,billingEmail);
application.append(applicationTitle,emailLabel,emailHelp);
const contract = document.createElement('div');
contract.className = 'contract';
contract.textContent = '契約情報は「契約情報を更新」から確認できます。';
billing.append(title,note,application);
const credit = document.createElement('p');
credit.className = 'credit-balance';
credit.textContent = '利用可能クレジット: 0クレジット（0円）';
billing.append(credit);
const invoiceTitle=document.createElement('h3');invoiceTitle.className='invoice-title';invoiceTitle.textContent='支払い明細';
const invoiceHistory=document.createElement('div');invoiceHistory.className='invoice-history';invoiceHistory.textContent='契約後に請求明細を確認できます。';
billing.append(invoiceTitle,invoiceHistory);
const plan = document.createElement('select');
plan.setAttribute('aria-label','契約プラン');
selectOptions(plan,[['supporter','BASIC 月額300円'],['plus','Plus 月額800円'],['pro','Pro 月額1,280円']],'supporter');
const channelPacks = document.createElement('select');
channelPacks.setAttribute('aria-label','追加チャンネル');
selectOptions(channelPacks,[[0,'チャンネル追加なし'],[1,'＋3チャンネル / 月額＋200円'],[2,'＋6チャンネル / 月額＋400円'],[3,'＋9チャンネル / 月額＋600円'],[4,'＋12チャンネル / 月額＋800円'],[5,'＋15チャンネル / 月額＋1,000円']],0);
const serverPacks = document.createElement('select');
serverPacks.setAttribute('aria-label','追加サーバー');
selectOptions(serverPacks,[[0,'サーバー追加なし'],[1,'＋1サーバー / 月額＋200円'],[2,'＋2サーバー / 月額＋400円'],[3,'＋3サーバー / 月額＋600円'],[4,'＋4サーバー / 月額＋800円'],[5,'＋5サーバー / 月額＋1,000円']],0);
const optionGrid=document.createElement('div');optionGrid.className='billing-options';
for(const [labelText,input] of [['プラン',plan],['チャンネル追加',channelPacks],['サーバー追加',serverPacks]]){const label=document.createElement('label');const span=document.createElement('span');span.textContent=labelText;label.append(span,input);optionGrid.append(label);}
const pricePreview=document.createElement('p');pricePreview.className='price-preview';
const checkoutSummary=document.createElement('dl');checkoutSummary.className='checkout-summary';
const updatePricePreview=()=>{const base={supporter:300,plus:800,pro:1280}[plan.value]||300;const monthly=base+200*(Number(channelPacks.value)+Number(serverPacks.value));const jstDay=Number(new Intl.DateTimeFormat('en-US',{day:'numeric',timeZone:'Asia/Tokyo'}).format(new Date()));const initial=monthly*(jstDay>=26?2:1);pricePreview.textContent=`月額 ${monthly.toLocaleString('ja-JP')}円／新規申込時 ${initial.toLocaleString('ja-JP')}円（${jstDay>=26?'当月分＋翌月分':'当月分'}）`;checkoutSummary.replaceChildren();const rows=[['申込みプラン',{supporter:'BASIC',plus:'Plus',pro:'Pro'}[plan.value]],['初回支払額',`${initial.toLocaleString('ja-JP')}円（Stripeテスト環境）`],['次回以降','毎月26日に翌月分を請求'],['提供開始','決済確認後。ただし先行提供中は通知配信へ未接続'],['解約','契約管理画面から手続きし、期間末で終了。支払済み料金の返金なし']];for(const [term,value] of rows){const dt=document.createElement('dt');dt.textContent=term;const dd=document.createElement('dd');dd.textContent=value;checkoutSummary.append(dt,dd);}};
for(const input of [plan,channelPacks,serverPacks])input.addEventListener('change',updatePricePreview);
updatePricePreview();application.append(optionGrid,pricePreview,checkoutSummary);

const legalConsentLabel=document.createElement('label');legalConsentLabel.className='legal-consent';
const legalConsent=document.createElement('input');legalConsent.type='checkbox';legalConsent.id='legal-consent';legalConsent.required=true;
const legalConsentText=document.createElement('span');legalConsentText.append('申込み内容を確認し、');
for(const [label,href] of [['利用規約','/terms/terms.html'],['プライバシーポリシー','/terms/policy.html'],['特定商取引法に基づく表記','/terms/Specified.html']]){const link=document.createElement('a');link.textContent=label;link.href=href;link.target='_blank';link.rel='noopener noreferrer';legalConsentText.append(link,label==='特定商取引法に基づく表記'?'に同意します。':'、');}
legalConsentLabel.append(legalConsent,legalConsentText);application.append(legalConsentLabel);
legalConsent.addEventListener('change',updateCheckoutAvailability);

const dateText = seconds => seconds ? new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Tokyo'}).format(new Date(seconds * 1000)) : '—';
const moneyText = (amount,currency) => new Intl.NumberFormat('ja-JP',{style:'currency',currency:(currency || 'jpy').toUpperCase(),maximumFractionDigits:0}).format(amount || 0);
const STATUS_LABELS = {active:'有効',trialing:'有効（次回請求待ち）',past_due:'支払い遅延',unpaid:'未払い',paused:'一時停止',incomplete:'手続き未完了',paid:'支払い済み',open:'支払い待ち',draft:'作成中',void:'無効'};

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
  const heading=document.createElement('h4');heading.textContent=invoice.number?`請求書 ${invoice.number}`:'Stripe請求書';
  const meta=document.createElement('p');meta.textContent=`${dateText(invoice.created)}・${STATUS_LABELS[invoice.status]||invoice.status}・${moneyText(invoice.total,invoice.currency)}`;
  const actions=document.createElement('div');actions.className='invoice-actions';
  for(const [label,url] of [['請求書を見る',invoice.hostedInvoiceUrl],['PDFを開く',invoice.invoicePdf]])if(url){const anchor=document.createElement('a');anchor.className='secondary-btn';anchor.textContent=label;anchor.href=stripeDocumentDestination(url);anchor.target='_blank';anchor.rel='noopener noreferrer';actions.append(anchor);}
  card.append(heading,meta,actions);invoiceHistory.append(card);
 }
}

function renderContracts(subscriptions,dunning={}) {
 contract.replaceChildren();
 hasExistingContract=subscriptions.length>0;
 updateCheckoutAvailability();
 if (!subscriptions.length) {
  contract.textContent = '現在の契約はありません。';
  entitlements={servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false};
  if(options)setRuleAccess(false);
  return;
 }
 const active=subscriptions.filter(item=>item.recognizedPlan!==false&&['active','trialing','past_due','unpaid','paused'].includes(item.status));
 entitlements=active.reduce((limits,item)=>({servers:Math.max(limits.servers,Number(item.servers)||1),channels:Math.max(limits.channels,Number(item.channels)||2),rules:Math.max(limits.rules,Number(item.rules)||5),complexConditions:limits.complexConditions||item.complexConditions===true,multiDestination:limits.multiDestination||item.multiDestination===true}),{servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false});
 const current=active[0]||subscriptions[0];
 if(dunning?.usageSuspended){const warning=document.createElement('p');warning.className='billing-suspension';warning.textContent='月末再決済を確認できなかったため、有料プランの通知設定は利用停止中です。契約管理画面からお支払いを完了してください。';contract.append(warning);}
 if(current){plan.value=current.planId||'supporter';channelPacks.value=String(current.channelPacks||0);serverPacks.value=String(current.serverPacks||0);updatePricePreview();}
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
   ['チャンネル上限',`${subscription.channels}チャンネル`],
   ['サーバー上限',`${subscription.servers}サーバー`],
   ['通知ルール上限',`${subscription.rules||5}件`],
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
 if(options)setRuleAccess(active.length>0&&!dunning?.usageSuspended);
}

let pendingUpdate=null;
const previewDialog=$('billing-preview-dialog');
const previewContent=$('billing-preview-content');
const signedMoney=value=>`${Number(value)>0?'+':''}${moneyText(Number(value)||0,'jpy')}`;
function showBillingPreview(result,requested){
 pendingUpdate={requested,prorationDate:result.prorationDate,expectedCreditApplied:Number(result.creditApplied||0),useCredits:false};
 previewContent.replaceChildren();
 const heading=document.createElement('p');heading.className='preview-lead';heading.textContent=result.changeTiming==='next_period'?'以下のダウングレードを次回更新日から予約します。現在の契約は今期末まで利用できます。':'以下の内容で契約を更新します。料金と利用枠を確認してから確定してください。';
 const data=document.createElement('dl');data.className='preview-grid';
 const rows=[
  ['プラン',`${result.current.plan} → ${result.next.plan}`],
  ['月額',`${moneyText(result.current.monthly,'jpy')} → ${moneyText(result.next.monthly,'jpy')}`],
  ['月額差額',signedMoney(result.monthlyDifference)],
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
 if(result.creditApplied>0){
  const creditConsent=document.createElement('label');creditConsent.className='credit-consent';
  const creditConsentInput=document.createElement('input');creditConsentInput.type='checkbox';
  const creditParts=[];
  if(result.immediateCreditApplied)creditParts.push(`今回${moneyText(result.immediateCreditApplied,'jpy')}`);
  if(result.nextInvoiceCreditApplied)creditParts.push(`次回26日${moneyText(result.nextInvoiceCreditApplied,'jpy')}`);
  const creditConsentText=document.createElement('span');creditConsentText.textContent=`クレジットを${creditParts.join('、')}使用し、今回${moneyText(result.immediateDue,'jpy')}・次回26日${moneyText(result.nextInvoiceDue,'jpy')}を支払うことを確認しました。`;
  creditConsentInput.addEventListener('change',()=>{if(pendingUpdate)pendingUpdate.useCredits=creditConsentInput.checked;confirmButton.disabled=!creditConsentInput.checked;});
  creditConsent.append(creditConsentInput,creditConsentText);previewContent.append(creditConsent);confirmButton.disabled=true;
 }else confirmButton.disabled=false;
 previewDialog.showModal();
}
$('billing-preview-cancel').onclick=()=>{pendingUpdate=null;$('billing-preview-confirm').disabled=false;previewDialog.close();};
$('billing-preview-confirm').onclick=run(async()=>{
 if(!pendingUpdate)return;
 const button=$('billing-preview-confirm');button.disabled=true;
 try{
  const result=await api('/api/supporter/billing/update','POST',{...pendingUpdate.requested,prorationDate:pendingUpdate.prorationDate,expectedCreditApplied:pendingUpdate.expectedCreditApplied,useCredits:pendingUpdate.useCredits,requestId:crypto.randomUUID()});
  pendingUpdate=null;previewDialog.close();
  const state=await api('/api/supporter/billing/status');renderContracts(state.subscriptions||[],state.dunning);renderInvoices(state.invoices||[]);
  const credits=Number(state.credits||result.credits||0);credit.textContent=`利用可能クレジット: ${credits.toLocaleString('ja-JP')}クレジット（${credits.toLocaleString('ja-JP')}円）`;status(result.message||'契約情報を更新しました。');
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
 checkoutButton.disabled=!billingAvailable||!legalConsent.checked||hasExistingContract;
 checkoutButton.title=hasExistingContract?'既に契約済みです。プラン変更をご利用ください。':'';
 checkoutButton.textContent=hasExistingContract?'契約済み（新規申込不可）':'このプランで申し込む';
}

for (const [label,action] of [['このプランで申し込む','checkout'],['プラン・オプションを変更','update'],['支払方法・解約の管理','portal'],['最新の契約・明細を読み込む','status']]) {
 const button = document.createElement('button');
 button.textContent = label;
 button.className=action==='checkout'?'primary-btn':'secondary-btn';
 button.type='button';
 if(action==='checkout'){checkoutButton=button;updateCheckoutAvailability();}
 button.onclick = async () => {
  billingActionStatus.textContent='';
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
   const body=action==='checkout'?{...selection,email:billingEmail.value,legalConsent:true}:{};
   const result = await api(`/api/supporter/billing/${action}`,action === 'status' ? 'GET' : 'POST',action === 'status' ? undefined : body);
   if (result.url) {
    location.href = stripeDestination(result.url);
   } else {
    renderContracts(result.subscriptions||[],result.dunning);renderInvoices(result.invoices||[]);
    const credits=Number(result.credits||0);
    credit.textContent=`利用可能クレジット: ${credits.toLocaleString('ja-JP')}クレジット（${credits.toLocaleString('ja-JP')}円）`;
    status(result.message||'契約情報を更新しました。');
   }
  } catch(error) {
   billingActionStatus.textContent=error.message;
   status(error.message);
  } finally {button.disabled=false;button.textContent=originalLabel;}
 };
 billingActions.append(button);
}
billing.append(contract,credit,invoiceTitle,invoiceHistory);
run(load)();
