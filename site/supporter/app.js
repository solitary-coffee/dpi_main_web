let session;
let revision = 0;
let rules = [];
let options;
let entitlements = {servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false};
const channelsByGuild = new Map();

const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; };
const INTENSITIES = [['1','1'],['2','2'],['3','3'],['4','4'],['5-','5弱'],['5+','5強'],['6-','6弱'],['6+','6強'],['7','7']];
const TYPES = [['earthquake','地震情報'],['eew','緊急地震速報'],['weather','気象情報']];
const WEATHER_ALERT_DETAILS = new Set(['heavy-rain-level','landslide-level','storm-surge-level']);
const WEATHER_WARNING_DETAILS = new Set(['storm-blizzard-warning','wave-warning','heavy-snow-warning','other-advisory']);

async function api(path, method = 'GET', body) {
 const response = await fetch(path, {
  method,
  headers: {'Content-Type':'application/json','x-reuse-csrf':session?.csrfToken || ''},
  body: body ? JSON.stringify(body) : undefined,
 });
 const data = await response.json();
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
  } else if (key === 'type' || key === 'detail' || key === 'intensityMode' || key === 'magnitudeMode') {
   if (key === 'type') rule.detail = 'all';
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
  const wrapper=document.createElement('label');const caption=document.createElement('span');caption.textContent='通知チャンネル（複数選択可）';
  input=document.createElement('select');input.multiple=true;input.size=Math.min(6,Math.max(3,choices.length));
  for(const [value,text] of choices){const option=document.createElement('option');option.value=value;option.textContent=text;option.selected=(rule.channelIds||[rule.channelId]).includes(value);input.append(option);}
  if(!choices.length){const option=document.createElement('option');option.textContent='利用可能なチャンネルがありません';option.disabled=true;input.append(option);}
  input.onchange=()=>{rule.channelIds=[...input.selectedOptions].map(option=>option.value);rule.channelId=rule.channelIds[0]||'';};
  wrapper.append(caption,input);article.append(wrapper);
 } else {
  input = field(article, rule, 'channelId', '通知チャンネル', choices);
  input.onchange=()=>{rule.channelId=input.value;rule.channelIds=input.value?[input.value]:[];};
  if (!choices.length) selectOptions(input, [], '', '利用可能なチャンネルがありません');
  else if (!choices.some(([id]) => id === rule.channelId)) selectOptions(input, choices, '', 'チャンネルを選択');
 }
 const refresh = document.createElement('button');
 refresh.type = 'button';
 refresh.className = 'secondary';
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
 };
}

function render() {
 $('rules').replaceChildren();
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
  field(article, rule, 'region', '対象地方', options.regions);
  if (rule.type === 'weather') {
   if (WEATHER_ALERT_DETAILS.has(rule.detail)) field(article, rule, 'weatherLevel', '警戒レベル', options.weatherLevels);
   if (WEATHER_WARNING_DETAILS.has(rule.detail)) field(article, rule, 'warningLevel', '警報・注意報', options.warningLevels);
  } else {
   field(article, rule, 'intensityMode', '震度の通知条件', options.thresholdModes);
   if(rule.intensityMode==='threshold')field(article, rule, 'intensity', '震度の閾値', INTENSITIES);
   field(article, rule, 'magnitudeMode', 'マグニチュードの通知条件', options.thresholdModes);
   if(rule.magnitudeMode==='threshold')field(article, rule, 'magnitudeMin', 'マグニチュードの閾値', null, {inputmode:'decimal',placeholder:'0〜10'});
  }
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'danger';
  remove.textContent = '削除';
  remove.onclick = () => { rules.splice(index, 1); render(); };
  article.append(remove);
  $('rules').append(article);
 });
}

async function load() {
 session = await api('/api/reuse/session');
 if (!session.authenticated) {
  $('user').textContent = 'Discordログインが必要です。';
  return;
 }
 $('user').textContent = session.user.username;
 $('register').disabled = false;
 options = await api('/api/supporter/options');
 const {account,billingEnabled} = await api('/api/supporter/account');
 $('billing-email').value = account?.billing_email || '';
 $('add').disabled = $('save').disabled = !account;
 $('register').textContent = account ? 'メールアドレスを更新' : '有料プラン利用情報を登録（決済前）';
 if (account) {
  revision = account.revision;
  rules = JSON.parse(account.settings_json).rules.map(normalizeRule);
  await Promise.all([...new Set(rules.map(rule => rule.guildId).filter(Boolean))].map(guildId => loadChannels(guildId)));
  render();
  if(billingEnabled){
   try{
    const billingState=await api('/api/supporter/billing/status');
    renderContracts(billingState.subscriptions||[]);
    const credits=Number(billingState.credits||0);
    credit.textContent=`利用可能クレジット: ${credits.toLocaleString('ja-JP')}クレジット（${credits.toLocaleString('ja-JP')}円）`;
   }catch{contract.textContent='契約情報を自動取得できませんでした。「契約情報を更新」を押してください。';}
  }
 }
}

function run(fn) {
 return () => Promise.resolve().then(fn).catch(error => status(error.message));
}

$('reload').onclick = run(load);
$('register').onclick = run(async () => {
 const email=$('billing-email');
 if(!email.reportValidity())return;
 await api('/api/supporter/account','POST',{email:email.value});
 await load();
 status('登録情報を保存しました。この操作だけでは料金は発生しません。');
});
$('add').onclick = run(async () => {
 if (rules.length >= entitlements.rules) return status(`現在のプランでは下書きは${entitlements.rules}件までです。`);
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
 const data = await api('/api/supporter/settings','PUT',{revision,rules});
 revision = data.revision;
 status('下書きを保存しました。配信には反映されません。');
});
run(load)();

const billing = $('billing');
billing.replaceChildren();
const title = document.createElement('h2');
title.textContent = 'お支払い・契約情報';
const note = document.createElement('p');
note.textContent = '請求日は毎月26日です。1〜25日の申込は当月分を申込時、翌月分を26日に請求します。26〜31日の申込は当月分と翌月分の2か月分を申込時にまとめて請求し、以後は毎月26日に翌月分を請求します。現在の接続先はStripeテスト環境のため、実際の請求は発生しません。';
const contract = document.createElement('div');
contract.className = 'contract';
contract.textContent = '契約情報は「契約情報を更新」から確認できます。';
billing.append(title,note,contract);
const credit = document.createElement('p');
credit.className = 'credit-balance';
credit.textContent = '利用可能クレジット: 0クレジット（0円）';
billing.append(credit);
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
const updatePricePreview=()=>{const base={supporter:300,plus:800,pro:1280}[plan.value]||300;const monthly=base+200*(Number(channelPacks.value)+Number(serverPacks.value));const jstDay=Number(new Intl.DateTimeFormat('en-US',{day:'numeric',timeZone:'Asia/Tokyo'}).format(new Date()));const initial=monthly*(jstDay>=26?2:1);pricePreview.textContent=`月額 ${monthly.toLocaleString('ja-JP')}円／新規申込時 ${initial.toLocaleString('ja-JP')}円（${jstDay>=26?'当月分＋翌月分':'当月分'}）`;};
for(const input of [plan,channelPacks,serverPacks])input.addEventListener('change',updatePricePreview);
updatePricePreview();billing.append(optionGrid,pricePreview);

const dateText = seconds => seconds ? new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Tokyo'}).format(new Date(seconds * 1000)) : '—';
const moneyText = (amount,currency) => new Intl.NumberFormat('ja-JP',{style:'currency',currency:(currency || 'jpy').toUpperCase(),maximumFractionDigits:0}).format(amount || 0);
const STATUS_LABELS = {active:'有効',trialing:'試用中',past_due:'支払い遅延',unpaid:'未払い',paused:'一時停止',incomplete:'手続き未完了'};

function stripeDestination(value) {
 const link = document.createElement('a');
 link.href = typeof value === 'string' ? value : '';
 if (link.protocol !== 'https:' || !['checkout.stripe.com','billing.stripe.com'].includes(link.hostname)) {
  throw Error('Stripeの決済URLを確認できませんでした。時間をおいて再度お試しください。');
 }
 return link.href;
}

function renderContracts(subscriptions) {
 contract.replaceChildren();
 if (!subscriptions.length) {
  contract.textContent = '現在の契約はありません。';
  entitlements={servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false};
  if(options)render();
  return;
 }
 entitlements=subscriptions.reduce((limits,item)=>({servers:Math.max(limits.servers,Number(item.servers)||1),channels:Math.max(limits.channels,Number(item.channels)||2),rules:Math.max(limits.rules,Number(item.rules)||5),complexConditions:limits.complexConditions||item.complexConditions===true,multiDestination:limits.multiDestination||item.multiDestination===true}),{servers:1,channels:2,rules:5,complexConditions:false,multiDestination:false});
 const current=subscriptions.find(item=>['active','trialing','past_due','unpaid','paused'].includes(item.status))||subscriptions[0];
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
  contract.append(card);
 }
 if(options)render();
}

let pendingUpdate=null;
const previewDialog=$('billing-preview-dialog');
const previewContent=$('billing-preview-content');
const signedMoney=value=>`${Number(value)>0?'+':''}${moneyText(Number(value)||0,'jpy')}`;
function showBillingPreview(result,requested){
 pendingUpdate={requested,prorationDate:result.prorationDate};
 previewContent.replaceChildren();
 const heading=document.createElement('p');heading.className='preview-lead';heading.textContent='以下の内容で契約を更新します。料金と利用枠を確認してから確定してください。';
 const data=document.createElement('dl');data.className='preview-grid';
 const rows=[
  ['プラン',`${result.current.plan} → ${result.next.plan}`],
  ['月額',`${moneyText(result.current.monthly,'jpy')} → ${moneyText(result.next.monthly,'jpy')}`],
  ['月額差額',signedMoney(result.monthlyDifference)],
  ['今回の基本プラン日割り差額',signedMoney(result.planProration)],
  ['利用クレジット',result.creditApplied?`−${moneyText(result.creditApplied,'jpy')}`:'なし'],
  ['今回のお支払い見込み',moneyText(result.immediateDue,'jpy')],
  ['次回更新日',dateText(result.nextRenewalAt)],
  ['チャンネル上限',`${result.current.channels} → ${result.next.channels}`],
  ['サーバー上限',`${result.current.servers} → ${result.next.servers}`],
  ['通知ルール上限',`${result.current.rules} → ${result.next.rules}`],
 ];
 if(result.creditGenerated)rows.splice(6,0,['差額から発生するクレジット',moneyText(result.creditGenerated,'jpy')]);
 for(const [term,value] of rows){const dt=document.createElement('dt');dt.textContent=term;const dd=document.createElement('dd');dd.textContent=value;data.append(dt,dd);}
 const optionNote=document.createElement('p');optionNote.className='preview-notice';optionNote.textContent=result.notice;
 previewContent.append(heading,data,optionNote);
 previewDialog.showModal();
}
$('billing-preview-cancel').onclick=()=>{pendingUpdate=null;previewDialog.close();};
$('billing-preview-confirm').onclick=run(async()=>{
 if(!pendingUpdate)return;
 const button=$('billing-preview-confirm');button.disabled=true;
 try{
  const result=await api('/api/supporter/billing/update','POST',{...pendingUpdate.requested,prorationDate:pendingUpdate.prorationDate,requestId:crypto.randomUUID()});
  pendingUpdate=null;previewDialog.close();renderContracts(result.subscriptions||[]);
  const credits=Number(result.credits||0);credit.textContent=`利用可能クレジット: ${credits.toLocaleString('ja-JP')}クレジット（${credits.toLocaleString('ja-JP')}円）`;status(result.message||'契約情報を更新しました。');
 } finally {button.disabled=false;}
});

for (const [label,action] of [['申し込みへ','checkout'],['変更内容を確認','update'],['支払方法・解約の管理','portal'],['契約情報を更新','status']]) {
 const button = document.createElement('button');
 button.textContent = label;
 button.onclick = run(async () => {
  button.disabled = true;
  try {
   const selection={plan:plan.value,channelPacks:Number(channelPacks.value),serverPacks:Number(serverPacks.value)};
   if(action==='update'){
    const result=await api('/api/supporter/billing/preview-update','POST',selection);
    showBillingPreview(result,selection);return;
   }
   const body=action==='checkout'?selection:{};
   const result = await api(`/api/supporter/billing/${action}`,action === 'status' ? 'GET' : 'POST',action === 'status' ? undefined : body);
   if (result.url) {
    location.href = stripeDestination(result.url);
   } else {
    renderContracts(result.subscriptions);
    const credits=Number(result.credits||0);
    credit.textContent=`利用可能クレジット: ${credits.toLocaleString('ja-JP')}クレジット（${credits.toLocaleString('ja-JP')}円）`;
    status(result.message||'契約情報を更新しました。');
   }
  } finally { button.disabled = false; }
 });
 billing.append(button);
}
