let session;
let revision = 0;
let rules = [];

const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; };
const REGIONS = [
 ['all', '全国'],
 ['hokkaido', '北海道地方'],
 ['tohoku', '東北地方'],
 ['kanto-koshin', '関東甲信地方'],
 ['hokuriku', '北陸地方'],
 ['tokai', '東海地方'],
 ['kinki', '近畿地方'],
 ['chugoku', '中国地方'],
 ['shikoku', '四国地方'],
 ['kyushu-north', '九州北部地方（山口県を含む）'],
 ['kyushu-south-amami', '九州南部・奄美地方'],
 ['okinawa', '沖縄地方'],
];
const WEATHER_LEVELS = [
 ['all', 'すべての気象情報'],
 ['1', 'レベル1 早期注意情報以上'],
 ['2', 'レベル2 注意報以上'],
 ['3', 'レベル3 警報以上'],
 ['4', 'レベル4 危険警報以上'],
 ['5', 'レベル5 特別警報'],
];
const INTENSITIES = [['1','1'],['2','2'],['3','3'],['4','4'],['5-','5弱'],['5+','5強'],['6-','6弱'],['6+','6強'],['7','7']];

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

function field(article, rule, key, label, options) {
 const wrapper = document.createElement('label');
 wrapper.textContent = label;
 const input = document.createElement(options ? 'select' : 'input');
 if (options) {
  for (const [value, text] of options) {
   const option = document.createElement('option');
   option.value = value;
   option.textContent = text;
   input.append(option);
  }
 }
 input.value = rule[key] ?? '';
 input.onchange = () => {
  rule[key] = input.value;
  if (key === 'type') render();
 };
 wrapper.append(input);
 article.append(wrapper);
}

function normalizeRule(rule) {
 const region = REGIONS.some(([value]) => value === rule.region) ? rule.region : 'all';
 const weatherLevel = WEATHER_LEVELS.some(([value]) => value === rule.weatherLevel) ? rule.weatherLevel : 'all';
 return {...rule, region, weatherLevel, intensity: rule.intensity || '4'};
}

function render() {
 $('rules').replaceChildren();
 rules.forEach((rule, index) => {
  const article = document.createElement('article');
  article.className = 'rule';
  field(article, rule, 'name', 'ルール名');
  field(article, rule, 'guildId', 'サーバー', session.guilds.map(guild => [guild.id, guild.name]));
  field(article, rule, 'channelId', 'チャンネルID');
  field(article, rule, 'type', '情報種別', [['earthquake','地震情報'],['eew','緊急地震速報'],['weather','気象情報']]);
  field(article, rule, 'region', '対象地方', REGIONS);
  if (rule.type === 'weather') field(article, rule, 'weatherLevel', '大雨等の警戒レベル', WEATHER_LEVELS);
  else field(article, rule, 'intensity', '震度以上', INTENSITIES);
  const remove = document.createElement('button');
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
 const {account} = await api('/api/supporter/account');
 $('add').disabled = $('save').disabled = !account;
 if (account) {
  revision = account.revision;
  rules = JSON.parse(account.settings_json).rules.map(normalizeRule);
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
$('add').onclick = () => {
 if (rules.length >= 5) return status('下書きは5件までです。');
 rules.push({name:'新しいルール',guildId:session.guilds[0]?.id || '',channelId:'',type:'earthquake',region:'all',intensity:'4',weatherLevel:'all'});
 render();
};
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
billing.append(title);
const note = document.createElement('p');
note.textContent = 'テスト専用です。実際のお支払い・配信は発生しません。決済完了後は契約状態を確認してください。';
billing.append(note);
const plan = document.createElement('select');
plan.setAttribute('aria-label','テスト契約プラン');
for (const [value,text] of [['supporter','Supporter 月額300円'],['plus','Plus 月額800円']]) {
 const option = document.createElement('option');
 option.value = value;
 option.textContent = text;
 plan.append(option);
}
const packs = document.createElement('select');
packs.setAttribute('aria-label','追加パック');
for (let index = 0; index <= 2; index += 1) {
 const option = document.createElement('option');
 option.value = index;
 option.textContent = `追加${index * 3}チャンネル / 月額＋${index * 200}円`;
 packs.append(option);
}
plan.onchange = () => {
 packs.disabled = plan.value === 'plus';
 if (packs.disabled) packs.value = '0';
};
billing.append(plan,packs);
for (const [label,action] of [['テスト決済へ','checkout'],['支払方法・解約の管理','portal'],['契約状態を確認','status']]) {
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
    status(result.subscriptions.length ? result.subscriptions.map(subscription => `${subscription.status}${subscription.cancelAtPeriodEnd ? '（期間末解約予定）' : ''}`).join(' / ') : '契約はありません。');
   }
  } finally { button.disabled = false; }
 });
 billing.append(button);
}
