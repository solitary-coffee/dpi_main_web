let accounts = [];
let selectedAccount = null;

const $ = id => document.getElementById(id);
const STATUS_LABELS = Object.freeze({active:'有効',trialing:'試用中',past_due:'支払い遅延',unpaid:'未払い',paused:'一時停止',incomplete:'手続き未完了'});
const ACTIVE_STATUSES = new Set(['active','trialing','past_due','unpaid','paused']);

document.addEventListener('DOMContentLoaded', () => {
 $('refresh-btn').addEventListener('click', loadAccounts);
 $('account-search').addEventListener('input', renderAccounts);
 $('dialog-close').addEventListener('click', () => $('action-dialog').close());
 $('action-kind').addEventListener('change', updateActionFields);
 $('change-plan').addEventListener('change', updatePlanFields);
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
 setStatus('BASICの登録・契約情報を読み込み中…','info');
 try {
  const response = await fetch('/site/supporter-admin/api/accounts',{credentials:'same-origin',headers:{Accept:'application/json'}});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `取得に失敗しました（HTTP ${response.status}）。`);
  accounts = data.accounts || [];
  $('billing-mode').textContent = data.billingEnabled ? 'Stripeテスト環境 接続中' : 'Stripeテスト環境 未接続';
  renderSummary();
  renderAccounts();
  setStatus('','');
 } catch (error) { setStatus(error.message,'error'); }
}

function renderSummary() {
 const subscriptions = accounts.flatMap(account => account.subscriptions || []);
 const active = subscriptions.filter(subscription => ACTIVE_STATUSES.has(subscription.status));
 const items = [
  ['BASIC登録者',accounts.length],
  ['有効・対応中の契約',active.length],
  ['月額合計',money(active.reduce((sum,item)=>sum+Number(item.amount||0),0),'jpy')],
  ['期間末解約予定',active.filter(item=>item.cancelAtPeriodEnd).length],
  ['利用可能クレジット',`${accounts.reduce((sum,item)=>sum+Number(item.credits||0),0).toLocaleString('ja-JP')}円分`],
 ];
 $('summary-cards').replaceChildren(...items.map(([label,value]) => {
  const card=element('article','metric-card');card.append(element('span','',label),element('strong','',String(value)));return card;
 }));
}

function renderAccounts() {
 const query=$('account-search').value.trim().toLowerCase();
 const filtered=accounts.filter(account=>`${account.discordUserId} ${account.billingEmail||''} ${(account.subscriptions||[]).map(item=>item.plan).join(' ')}`.toLowerCase().includes(query));
 const container=$('accounts');container.replaceChildren();
 if(!filtered.length){container.append(element('p','empty-list',query?'条件に一致する登録者はいません。':'BASIC登録者はいません。'));return;}
 for(const account of filtered)container.append(accountCard(account));
}

function accountCard(account) {
 const card=element('article','account-card');
 const heading=element('div','account-heading');
 const title=element('h3','',account.discordUserId);
 const manage=element('button','manage-btn','契約を管理');manage.type='button';manage.addEventListener('click',()=>openAction(account));
 heading.append(title,manage);
 const meta=element('div','account-meta');
 meta.append(element('span','',`メール ${account.billingEmail||'未登録'}`),element('span','',`クレジット ${Number(account.credits||0).toLocaleString('ja-JP')}（${Number(account.credits||0).toLocaleString('ja-JP')}円分）`),element('span','',`登録 ${dateText(account.registeredAt)}`),element('span','',`更新 ${dateText(account.updatedAt)}`),element('span','',`通知ルール ${account.ruleCount}件`),element('span','',`設定revision ${account.revision}`));
 card.append(heading,meta);
 if(account.billingError)card.append(element('p','billing-error',account.billingError));
 const subscriptions=account.subscriptions||[];
 if(!subscriptions.length){card.append(element('p','empty-contract','現在表示できる契約はありません。'));return card;}
 const grid=element('div','subscription-grid');
 for(const subscription of subscriptions)grid.append(subscriptionCard(subscription));
 card.append(grid);return card;
}

function subscriptionCard(subscription) {
 const card=element('article',`subscription-card${subscription.cancelAtPeriodEnd?' canceling':''}`);
 card.append(element('h4','',subscription.plan||'契約中プラン'));
 const list=element('dl');
 const status=`${STATUS_LABELS[subscription.status]||subscription.status}${subscription.cancelAtPeriodEnd?'（期間末で終了）':''}`;
 const entries=[['状態',status],['支払い開始',unixDate(subscription.startedAt)],['現在期間の開始',unixDate(subscription.currentPeriodStart)],[subscription.cancelAtPeriodEnd?'終了予定':'次回更新',unixDate(subscription.nextRenewalAt)],['月額',money(subscription.amount,subscription.currency)]];
 for(const [term,value] of entries){list.append(element('dt','',term),element('dd','',value));}
 card.append(list);return card;
}

function openAction(account) {
 selectedAccount=account;
 $('action-target').textContent=account.discordUserId;
 $('action-kind').value='change_subscription';
 $('action-reason').value='';$('confirm-discord-id').value='';$('action-amount').value='';$('payment-description').value='';
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
 updatePlanFields();
}

function updatePlanFields() {
 const plus=$('change-plan').value==='plus';$('change-packs').disabled=plus;if(plus)$('change-packs').value='0';
}

async function submitAction(event) {
 event.preventDefault();
 if(!selectedAccount)return;
 const action=$('action-kind').value;
 const destructive=['refund_latest','cancel_immediately','remove_credit'].includes(action);
 if(destructive&&!window.confirm(action==='refund_latest'?'返金は取り消せません。指定額を返金しますか？':action==='remove_credit'?'指定したクレジットを削除しますか？':'契約は直ちに終了します。本当に実行しますか？'))return;
 const payload={discordUserId:selectedAccount.discordUserId,confirmDiscordUserId:$('confirm-discord-id').value.trim(),action,reason:$('action-reason').value.trim(),requestId:crypto.randomUUID()};
 if(action==='change_subscription'){payload.plan=$('change-plan').value;payload.packs=Number($('change-packs').value);}
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
