let accounts = [];
let selectedAccount = null;
let creditSummary = null;

const $ = id => document.getElementById(id);
const STATUS_LABELS = Object.freeze({active:'有効',trialing:'有効（次回請求待ち）',past_due:'支払い遅延',unpaid:'未払い',paused:'一時停止',incomplete:'手続き未完了'});
const ACTIVE_STATUSES = new Set(['active','trialing','past_due','unpaid','paused']);

document.addEventListener('DOMContentLoaded', () => {
 $('refresh-btn').addEventListener('click', loadAccounts);
 $('account-search').addEventListener('input', renderAccounts);
 $('detail-close').addEventListener('click', () => $('detail-dialog').close());
 $('dialog-close').addEventListener('click', () => $('action-dialog').close());
 $('action-kind').addEventListener('change', updateActionFields);
 $('action-form').addEventListener('submit', submitAction);
 loadAccounts();
});

function element(tag, className = '', text = '') {
 const node = document.createElement(tag);
 if (className) node.className = className;
 if (text !== '') node.textContent = text;
 return node;
}

function setStatus(message, type = '') {
 const node = $('global-status');
 node.className = `status${type ? ` ${type}` : ''}`;
 node.textContent = message;
}

async function loadAccounts() {
 setStatus('有料プランの登録・契約情報を読み込み中…','info');
 try {
  const response = await fetch('/site/supporter-admin/api/accounts',{credentials:'same-origin',headers:{Accept:'application/json'}});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `取得に失敗しました（HTTP ${response.status}）。`);
  accounts = data.accounts || [];
  creditSummary = data.creditSummary || null;
  $('billing-mode').textContent = data.billingEnabled ? 'Stripeテスト環境 接続中' : 'Stripeテスト環境 未接続';
  renderSummary();
  renderAccounts();
  setStatus(data.creditSummaryError||'',data.creditSummaryError?'error':'');
 } catch (error) { setStatus(error.message,'error'); }
}

function renderSummary() {
 const subscriptions = accounts.flatMap(account => account.subscriptions || []);
 const active = subscriptions.filter(subscription => ACTIVE_STATUSES.has(subscription.status));
 const items = [
  ['有料プラン登録者',accounts.length],
  ['有効・対応中の契約',active.length],
  ['月額合計',money(active.reduce((sum,item)=>sum+Number(item.amount||0),0),'jpy')],
  ['期間末解約予定',active.filter(item=>item.cancelAtPeriodEnd).length],
  ['総合クレジット数',creditMetric(creditSummary?.totalCredits)],
  ['クレジット利用者数',creditSummary?.creditUsers==null?'取得不可':`${Number(creditSummary.creditUsers).toLocaleString('ja-JP')}人`],
  ['購入クレジット残高',creditMetric(creditSummary?.purchasedBalance)],
  ['管理者付与等の残高',creditMetric(creditSummary?.otherCredits)],
  ['クレジット購入者数',`${Number(creditSummary?.purchasers||0).toLocaleString('ja-JP')}人`],
  ['累計チャージ額',money(creditSummary?.netPurchased||0,'jpy')],
  ['30日以内の失効予定',creditMetric(creditSummary?.expiring30Days)],
  ['累計失効クレジット',creditMetric(creditSummary?.expiredCredits)],
 ];
 $('summary-cards').replaceChildren(...items.map(([label,value]) => {
  const card=element('article','metric-card');card.append(element('span','',label),element('strong','',String(value)));return card;
 }));
 const legal=$('credit-legal-monitor');legal.replaceChildren();
 if(!creditSummary){legal.append(element('p','credit-monitor-error','有償クレジット残高の監視情報を取得できませんでした。'));return;}
 const balance=Number(creditSummary.purchasedBalance||0),threshold=Number(creditSummary.legalThreshold||10000000),rate=Math.min(1,balance/threshold);
 const heading=element('div','credit-monitor-heading');heading.append(element('strong','',`有償未使用残高 ${balance.toLocaleString('ja-JP')}円`),element('span','',`届出基準 ${threshold.toLocaleString('ja-JP')}円の ${(rate*100).toFixed(2)}%`));
 const progress=document.createElement('progress');progress.max=threshold;progress.value=Math.min(balance,threshold);progress.setAttribute('aria-label','有償未使用残高の届出基準に対する割合');
 const level=rate>=1?'danger':rate>=.95?'danger':rate>=.9?'warning':rate>=.8?'notice':'safe';
 const message=rate>=1?'基準額に到達しています。新規チャージを停止し、財務局への届出要否を直ちに確認してください。':rate>=.95?'基準額の95%を超えています。チャージ停止準備と専門家確認が必要です。':rate>=.9?'基準額の90%を超えています。届出準備を開始してください。':rate>=.8?'基準額の80%を超えています。残高推移を重点監視してください。':'現在は届出基準未満です。毎年3月31日・9月30日の残高を記録してください。';
 const details=element('p',`credit-monitor-message ${level}`,message);
 const expiry=element('p','credit-monitor-meta',`購入残高保有者 ${Number(creditSummary.purchasedUsers||0).toLocaleString('ja-JP')}人／次回失効 ${creditSummary.nextExpiry?unixDate(creditSummary.nextExpiry):'予定なし'}`);
 legal.append(heading,progress,details,expiry);
}

function creditMetric(value){return value==null?'取得不可':`${Number(value||0).toLocaleString('ja-JP')}クレジット（${Number(value||0).toLocaleString('ja-JP')}円分）`;}

function renderAccounts() {
 const query=$('account-search').value.trim().toLowerCase();
 const filtered=accounts.filter(account=>`${account.discordName||''} ${account.discordUserId} ${account.billingEmail||''} ${(account.subscriptions||[]).map(item=>item.plan).join(' ')}`.toLowerCase().includes(query));
 const container=$('accounts');container.replaceChildren();
 if(!filtered.length){container.append(element('p','empty-list',query?'条件に一致する登録者はいません。':'有料プラン登録者はいません。'));return;}
 for(const account of filtered)container.append(accountCard(account));
}

function accountCard(account) {
 const card=element('article','account-card');
 const heading=element('div','account-heading');
 const title=element('h3','',account.discordName||'契約者名を取得できません');
 const actions=element('div','account-actions');
 const details=element('button','detail-btn','詳細');details.type='button';details.addEventListener('click',()=>openDetails(account));
 const manage=element('button','manage-btn','契約を管理');manage.type='button';manage.addEventListener('click',()=>openAction(account));
 actions.append(details,manage);heading.append(title,actions);
 const meta=element('div','account-meta');
 meta.append(element('span','',`Discord ID ${account.discordUserId}`),element('span','',`メール ${account.billingEmail||'未登録'}`),element('span','',`クレジット ${Number(account.credits||0).toLocaleString('ja-JP')}（${Number(account.credits||0).toLocaleString('ja-JP')}円分）`),element('span','',`登録 ${dateText(account.registeredAt)}`),element('span','',`更新 ${dateText(account.updatedAt)}`),element('span','',`通知ルール ${account.ruleCount}件`),element('span','',`設定revision ${account.revision}`));
 card.append(heading,meta);
 if(account.billingError)card.append(element('p','billing-error',account.billingError));
 const subscriptions=account.subscriptions||[];
 if(!subscriptions.length){card.append(element('p','empty-contract','現在表示できる契約はありません。'));return card;}
 const grid=element('div','subscription-grid');
 for(const subscription of subscriptions)grid.append(subscriptionCard(subscription));
 card.append(grid);return card;
}

async function openDetails(account) {
 const content=$('detail-content');
 content.replaceChildren(element('p','detail-loading','契約者と通知ルールの詳細を読み込み中…'));
 $('detail-dialog').showModal();
 try{
  const response=await fetch(`/site/supporter-admin/api/accounts/${encodeURIComponent(account.discordUserId)}`,{credentials:'same-origin',headers:{Accept:'application/json'}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data.message||`詳細の取得に失敗しました（HTTP ${response.status}）。`);
  renderDetails(data.account,data.channelLookupFailedGuildIds||[]);
 }catch(error){content.replaceChildren(element('p','billing-error',error.message));}
}

function renderDetails(account, failedGuildIds) {
 const content=$('detail-content');content.replaceChildren();
 const identity=element('div','detail-identity');
 identity.append(element('h3','',account.discordName||'契約者名を取得できません'),element('p','',`Discord ID: ${account.discordUserId}`));
 content.append(identity);
 if(failedGuildIds.length)content.append(element('p','detail-warning','一部サーバーのチャンネル名をDiscordから取得できませんでした。IDは確認できます。'));
 const rules=Array.isArray(account.rules)?account.rules:[];
 if(!rules.length){content.append(element('p','empty-list','通知ルールは登録されていません。'));return;}
 const list=element('div','rule-list');
 rules.forEach((rule,index)=>list.append(ruleDetailCard(rule,index)));
 content.append(list);
}

function ruleDetailCard(rule,index) {
 const card=element('article','rule-detail-card');
 card.append(element('h3','',rule.name||`通知ルール ${index+1}`));
 const destination=element('section','destination-detail');
 destination.append(element('h4','','配信先'));
 const destinationList=element('dl','detail-grid');
 appendDetail(destinationList,'サーバー',rule.guildName||'サーバー名を取得できません');
 appendDetail(destinationList,'サーバーID',rule.guildId||'未設定');
 const channels=Array.isArray(rule.channels)?rule.channels:[];
 appendDetail(destinationList,'チャンネル',channels.length?channels.map(channel=>`${channel.name?`#${channel.name}`:'チャンネル名を取得できません'}（ID: ${channel.id}）`).join(' / '):'未設定');
 destination.append(destinationList);card.append(destination);
 const conditions=element('section','condition-detail');conditions.append(element('h4','','ルール条件'));
 const detailList=element('dl','detail-grid');
 for(const item of rule.details||[])appendDetail(detailList,item.label,item.value);
 conditions.append(detailList);card.append(conditions);
 return card;
}

function appendDetail(list,label,value){list.append(element('dt','',label),element('dd','',String(value||'—')));}

function subscriptionCard(subscription) {
 const card=element('article',`subscription-card${subscription.cancelAtPeriodEnd?' canceling':''}`);
 card.append(element('h4','',subscription.plan||'契約中プラン'));
 const list=element('dl');
 const status=`${STATUS_LABELS[subscription.status]||subscription.status}${subscription.cancelAtPeriodEnd?'（期間末で終了）':''}`;
 const entries=[['状態',status],['支払い開始',unixDate(subscription.startedAt)],['現在期間の開始',unixDate(subscription.currentPeriodStart)],[subscription.cancelAtPeriodEnd?'終了予定':'次回更新',unixDate(subscription.nextRenewalAt)],['月額',money(subscription.amount,subscription.currency)],['チャンネル上限',`${subscription.channels||'—'}チャンネル`],['サーバー上限',`${subscription.servers||'—'}サーバー`],['固定請求日','毎月26日']];
 for(const [term,value] of entries){list.append(element('dt','',term),element('dd','',value));}
 card.append(list);return card;
}

function openAction(account) {
 selectedAccount=account;
 const current=(account.subscriptions||[]).find(subscription=>ACTIVE_STATUSES.has(subscription.status))||(account.subscriptions||[])[0];
 $('action-target').textContent=`${account.discordName||'契約者名を取得できません'}（${account.discordUserId}）`;
 $('action-kind').value='change_subscription';
 $('action-reason').value='';$('confirm-discord-id').value='';$('action-amount').value='';$('payment-description').value='';
 $('change-plan').value=current?.planId||'supporter';$('change-packs').value=String(current?.channelPacks||0);$('change-server-packs').value=String(current?.serverPacks||0);
 $('action-result').replaceChildren();updateActionFields();$('action-dialog').showModal();
}

function updateActionFields() {
 const action=$('action-kind').value;
 $('change-fields').classList.toggle('hidden',action!=='change_subscription');
 const amountActions=['refund_latest','create_payment_link','grant_credit','remove_credit'];
 $('amount-fields').classList.toggle('hidden',!amountActions.includes(action));
 $('description-wrap').classList.toggle('hidden',action!=='create_payment_link');
 $('amount-label').querySelector('span').textContent=['grant_credit','remove_credit'].includes(action)?'クレジット数（1クレジット＝1円）':'金額（円）';
 $('action-amount').min=action==='create_payment_link'?'100':'1';
 $('action-amount').required=amountActions.includes(action);
 $('payment-description').required=action==='create_payment_link';
 $('action-warning').textContent=action==='reset_checkout_state'
  ?'テスト環境専用です。D1のcheckout_key・checkout_id・checkout_paramsだけを削除します。Stripe Customer、メール、クレジット、契約、請求は削除しません。'
  :'1クレジットは1円です。付与したクレジットはStripeの次回請求へ自動的に充当されます。すべての操作は監査ログに記録されます。';
}

async function submitAction(event) {
 event.preventDefault();
 if(!selectedAccount)return;
 const action=$('action-kind').value;
 const destructive=['refund_latest','cancel_immediately','remove_credit','reset_checkout_state'].includes(action);
 if(destructive&&!window.confirm(action==='refund_latest'?'返金は取り消せません。指定額を返金しますか？':action==='remove_credit'?'指定したクレジットを削除しますか？':action==='reset_checkout_state'?'決済途中データをD1から削除します。Stripe Customerと契約情報は保持されます。実行しますか？':'契約は直ちに終了します。本当に実行しますか？'))return;
 const payload={discordUserId:selectedAccount.discordUserId,confirmDiscordUserId:$('confirm-discord-id').value.trim(),action,reason:$('action-reason').value.trim(),requestId:crypto.randomUUID()};
 if(action==='change_subscription'){payload.plan=$('change-plan').value;payload.channelPacks=Number($('change-packs').value);payload.serverPacks=Number($('change-server-packs').value);}
 if(['refund_latest','create_payment_link','grant_credit','remove_credit'].includes(action))payload.amount=Number($('action-amount').value);
 if(action==='create_payment_link')payload.description=$('payment-description').value.trim();
 const button=$('action-submit');button.disabled=true;$('action-result').textContent='Stripeへ操作を送信しています…';
 try {
  const response=await fetch('/site/supporter-admin/api/action',{method:'POST',credentials:'same-origin',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(payload)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data.success!==true)throw new Error(data.message||`操作に失敗しました（HTTP ${response.status}）。`);
  const result=$('action-result');result.replaceChildren(element('strong','',data.message));
  if(data.auditRecorded===false)result.append(document.createElement('br'),element('span','billing-error','注意: Stripe操作は完了しましたが、監査ログの保存に失敗しました。'));
  if(data.creditRecorded===false)result.append(document.createElement('br'),element('span','billing-error','注意: Stripe操作は完了しましたが、クレジット履歴の保存に失敗しました。'));
  if(data.url){const link=paymentLink(data.url);result.append(document.createElement('br'),link);}
  setStatus(data.message,'success');
  await loadAccounts();
 } catch(error){$('action-result').textContent=error.message;setStatus(error.message,'error');}
 finally{button.disabled=false;}
}

function paymentLink(value) {
 const link=element('a','','作成した支払いURLを開く');link.href=typeof value==='string'?value:'';link.target='_blank';link.rel='noopener noreferrer';
 if(link.protocol!=='https:'||link.hostname!=='checkout.stripe.com')throw new Error('Stripeの支払いURLを確認できませんでした。');
 return link;
}

function dateText(value){if(!value)return '—';const date=new Date(value);return Number.isNaN(date.getTime())?'—':new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Tokyo'}).format(date);}
function unixDate(value){return value?dateText(Number(value)*1000):'—';}
function money(amount,currency='jpy'){return new Intl.NumberFormat('ja-JP',{style:'currency',currency:String(currency||'jpy').toUpperCase(),maximumFractionDigits:0}).format(Number(amount)||0);}
