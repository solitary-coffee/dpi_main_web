let session,revision=0,rules=[];
const $=id=>document.getElementById(id);
const status=text=>{$('status').textContent=text;};
async function api(path,method='GET',body){const r=await fetch(path,{method,headers:{'Content-Type':'application/json','x-reuse-csrf':session?.csrfToken||''},body:body?JSON.stringify(body):undefined});const d=await r.json();if(!r.ok)throw Error(d.message||'操作に失敗しました');return d;}
function render(){ $('rules').replaceChildren();rules.forEach((rule,i)=>{const article=document.createElement('article');article.className='rule';for(const [key,label,options] of [['name','ルール名'],['guildId','サーバー',session.guilds.map(g=>[g.id,g.name])],['channelId','チャンネルID'],['type','情報種別',[['earthquake','地震情報'],['eew','緊急地震速報'],['weather','気象情報']]],['region','地域（下書き）'],['intensity','震度以上',[['1','1'],['2','2'],['3','3'],['4','4'],['5-','5弱'],['5+','5強'],['6-','6弱'],['6+','6強'],['7','7']]]]){const l=document.createElement('label');l.textContent=label;const input=document.createElement(options?'select':'input');if(options)for(const [value,text] of options){const o=document.createElement('option');o.value=value;o.textContent=text;input.append(o);}input.value=rule[key];input.onchange=()=>{rule[key]=input.value;};l.append(input);article.append(l);}const remove=document.createElement('button');remove.textContent='削除';remove.onclick=()=>{rules.splice(i,1);render();};article.append(remove);$('rules').append(article);});}
async function load(){session=await api('/api/reuse/session');if(!session.authenticated){$('user').textContent='Discordログインが必要です。';return;}$('user').textContent=session.user.username;$('register').disabled=false;const {account}=await api('/api/supporter/account');$('add').disabled=$('save').disabled=!account;if(account){revision=account.revision;rules=JSON.parse(account.settings_json).rules;render();$('register').disabled=true;}}
function run(fn){return()=>Promise.resolve().then(fn).catch(e=>status(e.message));}
$('reload').onclick=run(load);
$('register').onclick=run(async()=>{await api('/api/supporter/account','POST',{});await load();status('先行登録しました。料金は発生していません。');});
$('add').onclick=()=>{if(rules.length>=5)return status('下書きは5件までです。');rules.push({name:'新しいルール',guildId:session.guilds[0]?.id||'',channelId:'',type:'earthquake',region:'',intensity:'4'});render();};
$('save').onclick=run(async()=>{const d=await api('/api/supporter/settings','PUT',{revision,rules});revision=d.revision;status('下書きを保存しました。配信には反映されません。');});
run(load)();

const billing=document.createElement('section');
const title=document.createElement('h2');title.textContent='Stripe テスト決済';billing.append(title);
const note=document.createElement('p');note.textContent='テスト専用です。実際のお支払い・配信は発生しません。決済完了後は契約状態を確認してください。';billing.append(note);
const plan=document.createElement('select');plan.setAttribute('aria-label','テスト契約プラン');
for(const [value,text] of [['supporter','Supporter 月額300円'],['plus','Plus 月額800円']]){const option=document.createElement('option');option.value=value;option.textContent=text;plan.append(option);}
const packs=document.createElement('select');packs.setAttribute('aria-label','追加パック');
for(let i=0;i<=2;i++){const option=document.createElement('option');option.value=i;option.textContent=`追加${i*3}チャンネル / 月額＋${i*200}円`;packs.append(option);}
plan.onchange=()=>{packs.disabled=plan.value==='plus';if(packs.disabled)packs.value='0';};billing.append(plan,packs);
for(const [label,action] of [['テスト決済へ','checkout'],['支払方法・解約の管理','portal'],['契約状態を確認','status']]){const button=document.createElement('button');button.textContent=label;button.onclick=run(async()=>{button.disabled=true;try{const result=await api(`/api/supporter/billing/${action}`,action==='status'?'GET':'POST',action==='status'?undefined:action==='checkout'?{plan:plan.value,packs:Number(packs.value)}:{});if(result.url){const url=new URL(result.url);if(url.protocol!=='https:'||!['checkout.stripe.com','billing.stripe.com'].includes(url.hostname))throw Error('不正な決済URLです。');location.assign(url.href);}else status(result.subscriptions.length?result.subscriptions.map(s=>`${s.status}${s.cancelAtPeriodEnd?'（期間末解約予定）':''}`).join(' / '):'契約はありません。');}finally{button.disabled=false;}});billing.append(button);}
document.querySelector('main').append(billing);
