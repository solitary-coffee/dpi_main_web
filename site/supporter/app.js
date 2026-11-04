let session;
let revision = 0;
let rules = [];
let options;
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
   status('チャンネルを取得しています…');
   try { await loadChannels(rule.guildId, true); status(''); } catch (error) { status(error.message); }
   render();
  } else if (key === 'type' || key === 'detail') {
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
 const input = field(article, rule, 'channelId', '通知チャンネル', choices);
 if (!choices.length) selectOptions(input, [], '', '利用可能なチャンネルがありません');
 else if (!choices.some(([id]) => id === rule.channelId)) selectOptions(input, choices, '', 'チャンネルを選択');
}

function detailOptions(type) {
 if (type === 'earthquake') return options.earthquakeDetails;
 if (type === 'eew') return options.eewDetails;
 return options.weatherDetails;
}

function normalizeRule(rule) {
 const type = TYPES.some(([value]) => value === rule.type) ? rule.type : 'earthquake';
 return {
  ...rule,
  type,
  detail: rule.detail || 'all',
  region: rule.region || 'all',
  intensity: rule.intensity || '4',
  intensityChange: rule.intensityChange || 'all',
  magnitudeMin: rule.magnitudeMin ?? '',
  magnitudeMax: rule.magnitudeMax ?? '',
  magnitudeChange: rule.magnitudeChange || 'all',
  weatherLevel: rule.weatherLevel || 'all',
  warningLevel: rule.warningLevel || 'all',
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
  channelField(article, rule);
  field(article, rule, 'type', '情報種別', TYPES);
  field(article, rule, 'detail', '詳細', detailOptions(rule.type));
  field(article, rule, 'region', '対象地方', options.regions);
  if (rule.type === 'weather') {
   if (WEATHER_ALERT_DETAILS.has(rule.detail)) field(article, rule, 'weatherLevel', '警戒レベル', options.weatherLevels);
   if (WEATHER_WARNING_DETAILS.has(rule.detail)) field(article, rule, 'warningLevel', '警報・注意報', options.warningLevels);
  } else {
   field(article, rule, 'intensity', '最低震度', INTENSITIES);
   field(article, rule, 'intensityChange', '震度変化', options.changeDirections);
   field(article, rule, 'magnitudeMin', 'マグニチュード下限', null, {type:'number',min:'0',max:'10',step:'0.1',placeholder:'指定なし'});
   field(article, rule, 'magnitudeMax', 'マグニチュード上限', null, {type:'number',min:'0',max:'10',step:'0.1',placeholder:'指定なし'});
   field(article, rule, 'magnitudeChange', 'マグニチュード変化', options.changeDirections);
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
 const {account} = await api('/api/supporter/account');
 $('add').disabled = $('save').disabled = !account;
 if (account) {
  revision = account.revision;
  rules = JSON.parse(account.settings_json).rules.map(normalizeRule);
  await Promise.all([...new Set(rules.map(rule => rule.guildId).filter(Boolean))].map(guildId => loadChannels(guildId)));
  render();
  $('register').disabled = true;
 }
}

function run(fn) {
 return () => Promise.resolve().then(fn).catch(error => status(error.message));
}

$('reload').onclick = run(load);
$('register').onclick = run(async () => {
 await api('/api/supporter/account','POST',{});
 await load();
 status('先行登録しました。料金は発生していません。');
});
$('add').onclick = run(async () => {
 if (rules.length >= 5) return status('下書きは5件までです。');
 const guildId = session.guilds[0]?.id || '';
 if (guildId) await loadChannels(guildId);
 rules.push(normalizeRule({name:'新しいルール',guildId,channelId:'',type:'earthquake'}));
 render();
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
title.textContent = 'Stripe テスト決済';
const note = document.createElement('p');
note.textContent = 'テスト専用です。実際のお支払い・配信は発生しません。決済完了後は契約情報を更新してください。';
const contract = document.createElement('div');
contract.className = 'contract';
contract.textContent = '契約情報は「契約情報を更新」から確認できます。';
billing.append(title,note,contract);
const plan = document.createElement('select');
plan.setAttribute('aria-label','テスト契約プラン');
selectOptions(plan,[['supporter','Supporter 月額300円'],['plus','Plus 月額800円']],'supporter');
const packs = document.createElement('select');
packs.setAttribute('aria-label','追加パック');
selectOptions(packs,[[0,'追加なし'],[1,'追加3チャンネル / 月額＋200円'],[2,'追加6チャンネル / 月額＋400円']],0);
plan.onchange = () => {
 packs.disabled = plan.value === 'plus';
 if (packs.disabled) packs.value = '0';
};
billing.append(plan,packs);

const dateText = seconds => seconds ? new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Tokyo'}).format(new Date(seconds * 1000)) : '—';
const moneyText = (amount,currency) => new Intl.NumberFormat('ja-JP',{style:'currency',currency:(currency || 'jpy').toUpperCase(),maximumFractionDigits:0}).format(amount || 0);
const STATUS_LABELS = {active:'有効',trialing:'試用中',past_due:'支払い遅延',unpaid:'未払い',paused:'一時停止',incomplete:'手続き未完了'};

function renderContracts(subscriptions) {
 contract.replaceChildren();
 if (!subscriptions.length) {
  contract.textContent = '現在の契約はありません。';
  return;
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
}

for (const [label,action] of [['テスト決済へ','checkout'],['支払方法・解約の管理','portal'],['契約情報を更新','status']]) {
 const button = document.createElement('button');
 button.textContent = label;
 button.onclick = run(async () => {
  button.disabled = true;
  try {
   const result = await api(`/api/supporter/billing/${action}`,action === 'status' ? 'GET' : 'POST',action === 'status' ? undefined : action === 'checkout' ? {plan:plan.value,packs:Number(packs.value)} : {});
   if (result.url) {
    const url = new URL(result.url);
    if (url.protocol !== 'https:' || !['checkout.stripe.com','billing.stripe.com'].includes(url.hostname)) throw Error('不正な決済URLです。');
    location.assign(url.href);
   } else {
    renderContracts(result.subscriptions);
    status('契約情報を更新しました。');
   }
  } finally { button.disabled = false; }
 });
 billing.append(button);
}
