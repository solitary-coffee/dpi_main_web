let accounts = [];
let selectedAccount = null;
let creditSummary = null;
let creditCampaigns = [];
let compensationRequestId = '';
let actionRequestId = '';
let customRequestId = '';
let loadedCustomRevision = null;

const $ = id => document.getElementById(id);
const STATUS_LABELS = Object.freeze({active:'有効',trialing:'有効（次回請求待ち）',past_due:'支払い遅延',unpaid:'未払い',paused:'一時停止',incomplete:'手続き未完了'});
const ACTIVE_STATUSES = new Set(['active','trialing','past_due','unpaid','paused']);

document.addEventListener('DOMContentLoaded', () => {
 $('refresh-btn').addEventListener('click', loadAccounts);
 const details=$('custom-settings-details');
 $('custom-open').addEventListener('click',()=>{
  details.open=!details.open;
  if(details.open)details.scrollIntoView({behavior:'smooth',block:'start'});
 });
 details.addEventListener('toggle',()=>{
  $('custom-open').setAttribute('aria-expanded',String(details.open));
  $('custom-open').textContent=details.open?'カスタム設定を閉じる':'カスタムプラン設定';
 });
 for(const id of ['custom-complex','custom-city','custom-extract','custom-multi']){
  $(id).addEventListener('change',syncCustomToggles);
 }
 syncCustomToggles();
 $('custom-form').addEventListener('submit',event=>{event.preventDefault();submitCustom('save');});
 $('custom-load').addEventListener('click',loadCustom);
 $('custom-checkout').addEventListener('click',()=>submitCustom('checkout'));
 $('custom-cancel-change').addEventListener('click',()=>submitCustom('cancel-change'));

 $('custom-cancel').addEventListener('click',()=>submitCustom('cancel'));
 for(const id of ['custom-channels','custom-servers','custom-rules','custom-complex','custom-city','custom-extract','custom-multi','custom-reuse'])$(id).addEventListener('input',updateCustomEstimate);
 $('custom-city').addEventListener('change',()=>{if(!$('custom-city').checked)$('custom-extract').checked=false;syncCustomToggles();updateCustomEstimate();});
 updateCustomEstimate();
 $('account-search').addEventListener('input', renderAccounts);
 $('detail-close').addEventListener('click', () => $('detail-dialog').close());
 $('dialog-close').addEventListener('click', () => $('action-dialog').close());
 $('action-kind').addEventListener('change', updateActionFields);
 $('action-form').addEventListener('submit', submitAction);
 $('compensation-target-type').addEventListener('change', updateCompensationFields);
 $('compensation-form').addEventListener('submit', submitCompensation);
 initializeCompensationExpiry();
 updateCompensationFields();
 loadAccounts();
});

function syncCustomToggles(){
 const extraction=$('custom-extract');
 extraction.disabled=!$('custom-city').checked;
 if(extraction.disabled)extraction.checked=false;
 for(const status of document.querySelectorAll('.custom-toggle-status[data-for]')){
  const input=$(status.dataset.for);
  if(!input)continue;
  status.textContent=input.checked?'ON':'OFF';
 }
}
function openCustomForAccount(account){
 if(!account)return;
 // Always remove another account's pending form edits before switching users.
 $('custom-form').reset();
 $('custom-settings-details').open=true;
 $('custom-uid').value=account.discordUserId;
 $('custom-confirm').value=account.discordUserId;
 $('custom-reason').value='';
 loadedCustomRevision=null;
 customRequestId='';
 if(account.customPlan)loadCustom();
 else{$('custom-result').textContent='新規カスタムプランを設定できます。設定内容を確認して保存してください。';syncCustomToggles();updateCustomEstimate();}
 $('custom-settings-details').scrollIntoView({behavior:'smooth',block:'start'});
}
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
  creditCampaigns = data.creditCampaigns || [];
  $('billing-mode').textContent = data.billingEnabled ? 'Stripeテスト環境 接続中' : 'Stripeテスト環境 未接続';
  renderSummary();
  renderAccounts();
  renderCompensationCampaigns();
  setStatus(data.creditSummaryError||'',data.creditSummaryError?'error':'');
 } catch (error) { setStatus(error.message,'error'); }
}

function initializeCompensationExpiry(){
 const input=$('compensation-expiry'),now=new Date(),expiry=new Date(now);
 expiry.setFullYear(expiry.getFullYear()+1);
 input.min=localDateTimeValue(new Date(now.getTime()+60*60*1000));
 input.value=localDateTimeValue(expiry);
}

function localDateTimeValue(date){
 const local=new Date(date.getTime()-date.getTimezoneOffset()*60000);
 return local.toISOString().slice(0,16);
}

function updateCompensationFields(){
 const type=$('compensation-target-type').value;
 $('compensation-user-wrap').classList.toggle('hidden',type!=='user');
 $('compensation-plan-wrap').classList.toggle('hidden',type!=='plan');
 $('compensation-user').required=type==='user';
 $('compensation-plan').required=type==='plan';
}

function compensationTargetLabel(campaign){
 if(campaign.targetType==='all')return '全登録者';
 if(campaign.targetType==='user')return `Discord ID ${campaign.targetValue}`;
 return `${{supporter:'BASIC',plus:'Plus',pro:'Pro'}[campaign.targetValue]||campaign.targetValue} 契約者`;
}

function campaignStatusLabel(status){return {pending:'配布待ち',processing:'配布中',completed:'完了',partial:'一部失敗',failed:'失敗'}[status]||status;}

function renderCompensationCampaigns(){
 const container=$('compensation-campaigns');container.replaceChildren();
 if(!creditCampaigns.length){container.append(element('p','empty-list','補償クレジットの配布履歴はありません。'));return;}
 for(const campaign of creditCampaigns){
  const card=element('article',`campaign-card ${campaign.status}`);
  card.append(element('h4','',`${Number(campaign.amount||0).toLocaleString('ja-JP')}クレジット／${compensationTargetLabel(campaign)}`));
  card.append(element('p','',campaign.reason||'理由未登録'));
  card.append(element('p','campaign-meta',`${campaignStatusLabel(campaign.status)}・成功 ${Number(campaign.creditedCount||0).toLocaleString('ja-JP')} / 対象 ${Number(campaign.recipientCount||0).toLocaleString('ja-JP')}人・失敗 ${Number(campaign.failedCount||0).toLocaleString('ja-JP')}人`));
  card.append(element('p','campaign-meta',`有効期限 ${unixDate(campaign.expiresAt)}／作成 ${unixDate(campaign.createdAt)}`));
  if(['pending','processing'].includes(campaign.status)){
   const resume=element('button','','配布処理を再開');resume.type='button';resume.addEventListener('click',()=>processCompensation(campaign.id,resume));card.append(resume);
  }
  container.append(card);
 }
}

async function submitCompensation(event){
 event.preventDefault();
 const type=$('compensation-target-type').value;
 const amount=Number($('compensation-amount').value),reason=$('compensation-reason').value.trim();
 const targetValue=type==='user'?$('compensation-user').value.trim():type==='plan'?$('compensation-plan').value:'';
 const expiryMs=new Date($('compensation-expiry').value).getTime();
 if(!Number.isFinite(expiryMs)){$('compensation-result').textContent='有効期限を確認してください。';return;}
 const targetLabel=type==='all'?'全登録者':type==='user'?`Discord ID ${targetValue}`:`${{supporter:'BASIC',plus:'Plus',pro:'Pro'}[targetValue]}契約者`;
 if(!window.confirm(`${targetLabel}へ1人あたり${amount.toLocaleString('ja-JP')}クレジットを配布します。理由と有効期限は利用者に表示されます。続行しますか？`))return;
 const button=$('compensation-submit');button.disabled=true;$('compensation-result').textContent='配布対象を確定しています…';
 try{
  if(!compensationRequestId)compensationRequestId=crypto.randomUUID();
  const response=await fetch('/site/supporter-admin/api/credit-campaigns',{method:'POST',credentials:'same-origin',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({requestId:compensationRequestId,targetType:type,targetValue,amount,reason,expiresAt:Math.floor(expiryMs/1000),confirmText:$('compensation-confirm').value.trim()})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data.success!==true)throw new Error(data.message||`配布の作成に失敗しました（HTTP ${response.status}）。`);
  compensationRequestId='';
  creditCampaigns.unshift(data.campaign);renderCompensationCampaigns();
  $('compensation-result').textContent=`${data.campaign.recipientCount.toLocaleString('ja-JP')}人への配布を開始しました。`;
  await processCompensation(data.campaign.id);
  $('compensation-confirm').value='';$('compensation-reason').value='';
 }catch(error){$('compensation-result').textContent=error.message;setStatus(error.message,'error');}
 finally{button.disabled=false;}
}

async function processCompensation(campaignId,triggerButton=null){
 if(triggerButton)triggerButton.disabled=true;
 try{
  for(let batch=0;batch<100;batch++){
   const response=await fetch(`/site/supporter-admin/api/credit-campaigns/${encodeURIComponent(campaignId)}/process`,{method:'POST',credentials:'same-origin',headers:{Accept:'application/json'}});
   const data=await response.json().catch(()=>({}));
   if(!response.ok||data.success!==true)throw new Error(data.message||`配布処理に失敗しました（HTTP ${response.status}）。`);
   const index=creditCampaigns.findIndex(item=>item.id===campaignId);if(index>=0)creditCampaigns[index]=data.campaign;
   renderCompensationCampaigns();
   $('compensation-result').textContent=`配布中: ${data.campaign.creditedCount.toLocaleString('ja-JP')} / ${data.campaign.recipientCount.toLocaleString('ja-JP')}人`;
   if(!['pending','processing'].includes(data.campaign.status)){
    const message=data.campaign.status==='completed'?'補償クレジットの配布が完了しました。':`${data.campaign.creditedCount}人へ配布し、${data.campaign.failedCount}人は失敗しました。`;
    $('compensation-result').textContent=message;setStatus(message,data.campaign.status==='completed'?'success':'error');await loadAccounts();return;
   }
  }
  $('compensation-result').textContent='配布対象が多いため処理を一時停止しました。「配布処理を再開」から続行できます。';
 }catch(error){$('compensation-result').textContent=`配布処理を中断しました: ${error.message}。「配布処理を再開」から続行できます。`;setStatus(error.message,'error');await loadAccounts();}
 finally{if(triggerButton)triggerButton.disabled=false;}
}

function renderSummary() {
 const subscriptions = accounts.flatMap(account => account.subscriptions || []);
 const active = subscriptions.filter(subscription => ACTIVE_STATUSES.has(subscription.status));
 const items = [
  ['有料プラン登録者',accounts.length],
  ['有効・対応中の契約',active.length],
  ['月額合計',money(active.reduce((sum,item)=>sum+Number(item.amount||0),0),'jpy')],
  ['BAN中',`${accounts.filter(account=>account.accountStatus==='suspended').length.toLocaleString('ja-JP')}人`],
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
 const filtered=accounts.filter(account=>`${account.discordName||''} ${account.discordUserId} ${account.billingEmail||''} ${account.accountStatus==='suspended'?'BAN アカウント停止':''} ${(account.subscriptions||[]).map(item=>item.plan).join(' ')}`.toLowerCase().includes(query));
 const container=$('accounts');container.replaceChildren();
 if(!filtered.length){container.append(element('p','empty-list',query?'条件に一致する登録者はいません。':'有料プラン登録者はいません。'));return;}
 for(const account of filtered)container.append(accountCard(account));
}

function accountCard(account) {
 const card=element('article','account-card');
 if(account.accountStatus==='suspended')card.classList.add('suspended');
 const heading=element('div','account-heading');
 const title=element('h3','',account.discordName||'契約者名を取得できません');
 const actions=element('div','account-actions');
 const details=element('button','detail-btn','詳細');details.type='button';details.addEventListener('click',()=>openDetails(account));
 const manage=element('button','manage-btn','契約を管理');manage.type='button';manage.addEventListener('click',()=>openAction(account));
 const custom=element('button','detail-btn','カスタム設定');custom.type='button';custom.addEventListener('click',()=>openCustomForAccount(account));
 actions.append(details,manage,custom);heading.append(title,actions);
 const meta=element('div','account-meta');
 meta.append(element('span','',`Discord ID ${account.discordUserId}`),element('span','',`メール ${account.billingEmail||'未登録'}`),element('span','',`クレジット ${Number(account.credits||0).toLocaleString('ja-JP')}（${Number(account.credits||0).toLocaleString('ja-JP')}円分）`),element('span',account.accountStatus==='suspended'?'account-status-badge suspended':'account-status-badge',account.accountStatus==='suspended'?'BAN中':'利用可能'),element('span','',`登録 ${dateText(account.registeredAt)}`),element('span','',`更新 ${dateText(account.updatedAt)}`),element('span','',`通知ルール ${account.ruleCount}件`),element('span','',`設定revision ${account.revision}`));
 card.append(heading,meta);
 if(account.accountStatus==='suspended')card.append(element('p','account-enforcement-reason',`BAN理由: ${account.statusReason||'理由未登録'}${account.statusUpdatedAt?`／${dateText(account.statusUpdatedAt)}`:''}`));
 if(account.billingError)card.append(element('p','billing-error',account.billingError));
 if(account.customPlan)card.append(element('p','',`カスタムプラン：${account.customPlan.name}／${account.customPlan.status==='active'?'有効':account.customPlan.status==='offered'?'提供中・未決済':'停止'}／確定月額${Number(account.customPlan.monthlyYen).toLocaleString('ja-JP')}円`));
 if(account.pendingCustomChange)card.append(element('p','scheduled-change',
  `カスタム料金変更待ち：${account.pendingCustomChange.oldMonthlyYen.toLocaleString('ja-JP')}円 → ${account.pendingCustomChange.nextMonthlyYen.toLocaleString('ja-JP')}円／当月差額${account.pendingCustomChange.amountDueYen.toLocaleString('ja-JP')}円（${account.pendingCustomChange.status==='paid'?'決済済・適用待ち':'決済待ち'}）`));
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
 identity.append(element('h3','',account.discordName||'契約者名を取得できません'),element('p','',`Discord ID: ${account.discordUserId}`),element('p',account.accountStatus==='suspended'?'billing-error':'',account.accountStatus==='suspended'?`アカウントBAN中: ${account.statusReason||'理由未登録'}`:'有料機能は利用可能です。'));
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
 actionRequestId=crypto.randomUUID();
 $('action-kind').value=account.accountStatus==='suspended'?'unban_account':'change_subscription';
 $('action-reason').value='';$('confirm-discord-id').value='';$('action-amount').value='';$('payment-description').value='';
 $('change-plan').value=current?.planId||'supporter';$('change-packs').value=String(current?.channelPacks||0);$('change-server-packs').value=String(current?.serverPacks||0);$('change-rule-packs').value=String(current?.rulePacks||0);
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
  :action==='confiscate_credit'
   ?'実行時点の全クレジットを取り消します。没収は元に戻せません。理由と実行者を監査ログへ記録します。'
   :action==='disciplinary_cancel'
    ?'処分①：全契約を即時解除し、残クレジットをすべて没収します。返金は行いません。処分後は、再度支払うことで申込みできます。ユーザーへ理由をメールで通知します。'
    :action==='ban_account'
     ?'処分②：処分①を実行したうえでアカウントをBANします。BAN解除まで、すべてのプラン申込み・チャージ・契約変更・通知設定を禁止します。ユーザーへ理由をメールで通知します。'
     :action==='unban_account'
      ?'アカウントのBANを解除します。契約と没収済みクレジットは復元されません。再利用には、ユーザーによる新しいプラン申込みが必要です。'
     :'1クレジットは1円です。付与したクレジットはStripeの次回請求へ自動的に充当されます。すべての操作は監査ログに記録されます。';
}

async function submitAction(event) {
 event.preventDefault();
 if(!selectedAccount)return;
 const action=$('action-kind').value;
 const destructive=['refund_latest','cancel_immediately','remove_credit','confiscate_credit','disciplinary_cancel','ban_account','reset_checkout_state'].includes(action);
 if(destructive&&!window.confirm(action==='refund_latest'?'返金は取り消せません。指定額を返金しますか？':action==='remove_credit'?'指定したクレジットを削除しますか？':action==='confiscate_credit'?'実行時点の全クレジットを没収します。元に戻せません。実行しますか？':action==='disciplinary_cancel'?'処分①を実行します。全契約の即時解除・残クレジット全没収・返金なしで、ユーザーへ通知メールを送信します。実行しますか？':action==='ban_account'?'処分②を実行します。全契約の即時解除・残クレジット全没収後、再申込み不可のBAN状態にします。実行しますか？':action==='reset_checkout_state'?'決済途中データをD1から削除します。Stripe Customerと契約情報は保持されます。実行しますか？':'契約は直ちに終了します。本当に実行しますか？'))return;
 const payload={discordUserId:selectedAccount.discordUserId,confirmDiscordUserId:$('confirm-discord-id').value.trim(),action,reason:$('action-reason').value.trim(),requestId:actionRequestId||crypto.randomUUID()};
 if(action==='change_subscription'){payload.plan=$('change-plan').value;payload.channelPacks=Number($('change-packs').value);payload.serverPacks=Number($('change-server-packs').value);payload.rulePacks=Number($('change-rule-packs').value);}
 if(['refund_latest','create_payment_link','grant_credit','remove_credit'].includes(action))payload.amount=Number($('action-amount').value);
 if(action==='create_payment_link')payload.description=$('payment-description').value.trim();
 const button=$('action-submit');button.disabled=true;$('action-result').textContent='管理操作を処理しています…';
 try {
  const response=await fetch('/site/supporter-admin/api/action',{method:'POST',credentials:'same-origin',headers:{Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(payload)});
  const data=await response.json().catch(()=>({}));
  if(!response.ok||data.success!==true)throw new Error(data.message||`操作に失敗しました（HTTP ${response.status}）。`);
  const result=$('action-result');result.replaceChildren(element('strong','',data.message));
  if(data.auditRecorded===false)result.append(document.createElement('br'),element('span','billing-error','注意: 管理操作は完了しましたが、監査ログの保存に失敗しました。'));
  if(data.creditRecorded===false)result.append(document.createElement('br'),element('span','billing-error','注意: Stripe操作は完了しましたが、クレジット履歴の保存に失敗しました。'));
  if(data.emailStatus==='failed')result.append(document.createElement('br'),element('span','billing-error','処分は完了しましたが、通知メールの送信に失敗しました。定期処理で再送します。'));
  if(data.emailStatus==='skipped')result.append(document.createElement('br'),element('span','billing-error','処分は完了しましたが、送信可能なメールアドレスまたはメール設定がありません。'));
  if(data.url){const link=paymentLink(data.url);result.append(document.createElement('br'),link);}
  setStatus(data.message,'success');
  actionRequestId='';
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

function customPayload(){
 return {
  discordUserId:$('custom-uid').value.trim(),confirmDiscordUserId:$('custom-confirm').value.trim(),
  name:$('custom-name').value.trim(),channels:Number($('custom-channels').value),servers:Number($('custom-servers').value),
  rules:Number($('custom-rules').value),monthlyYen:Number($('custom-price').value),
  complexConditions:$('custom-complex').checked,municipalityBranching:$('custom-city').checked,
  contentExtraction:$('custom-extract').checked,multiDestination:$('custom-multi').checked,
  secondaryReuse:$('custom-reuse').checked,reason:$('custom-reason').value.trim(),
  requestId:customRequestId||crypto.randomUUID(),
 };
}
function updateCustomEstimate(){
 const p=customPayload(),base=p.complexConditions||p.contentExtraction?1280:p.municipalityBranching||p.channels>2||p.servers>1||p.rules>5?800:300;
 const defaults=base===1280?[20,5,30]:base===800?[10,3,15]:[2,1,5];
 const price=base+Math.ceil(Math.max(0,p.channels-defaults[0])/3)*200+Math.max(0,p.servers-defaults[1])*200+Math.ceil(Math.max(0,p.rules-defaults[2])/5)*100+(p.secondaryReuse?200:0);
 $('custom-estimate').textContent=Number.isFinite(price)?`${price.toLocaleString('ja-JP')}円／月（参考値）`:'—';
}
function loadCustom(){
 const id=$('custom-uid').value.trim(),account=accounts.find(item=>item.discordUserId===id);
 if(!account){$('custom-result').textContent='対象ユーザーを登録者一覧から確認してください。';return;}
 const p=account.customPlan;
 if(!p){$('custom-result').textContent='カスタムプランは未設定です。';return;}
 $('custom-name').value=p.name;
 for(const [id,value] of [['custom-channels',p.channels],['custom-servers',p.servers],['custom-rules',p.rules],['custom-price',p.monthlyYen]])$(id).value=String(value);
 for(const [id,value] of [['custom-complex',p.complexConditions],['custom-city',p.municipalityBranching],['custom-extract',p.contentExtraction],['custom-multi',p.multiDestination],['custom-reuse',p.secondaryReuse]])$(id).checked=value===true;
 loadedCustomRevision=Number(p.revision);
 syncCustomToggles();
 $('custom-result').textContent=`現在の状態：${p.status}／更新日：${p.updatedAt||'不明'}。契約中でも管理者は料金を変更できます。`;
 if(account.pendingCustomChange){
  const c=account.pendingCustomChange;
  $('custom-result').textContent+=` 未処理の変更：${c.oldMonthlyYen}円 → ${c.nextMonthlyYen}円（当月差額${c.amountDueYen}円、${c.status}）。`;
 }
 updateCustomEstimate();
}
async function submitCustom(action){
 const payload={...customPayload(),action};
 const account=accounts.find(item=>item.discordUserId===payload.discordUserId);
 payload.expectedRevision=loadedCustomRevision??account?.customPlan?.revision??0;
 if(!/^\d{17,20}$/.test(payload.discordUserId)||payload.confirmDiscordUserId!==payload.discordUserId){
  $('custom-result').textContent='Discord IDと確認欄を一致させてください。';return;
 }
 if(payload.reason.length<5){$('custom-result').textContent='理由を5文字以上入力してください。';return;}
 if(action==='save'&&!$('custom-form').reportValidity())return;
 if(action==='cancel'&&!window.confirm('このユーザーのカスタム契約を停止します。Stripeの契約も即時解約され、返金は自動実行しません。続行しますか？'))return;
 if(action==='cancel-change'&&!window.confirm('未決済の当月差額請求を無効化し、既存契約を維持しますか？'))return;
 const button=$(`custom-${action==='checkout'?'checkout':action==='cancel-change'?'cancel-change':action==='cancel'?'cancel':'save'}`);
 button.disabled=true;$('custom-result').textContent='カスタムプランを処理しています…';
 try{
  const send=async body=>{
   const response=await fetch('/site/supporter-admin/api/custom-plan',{
    method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body),
   });
   const data=await response.json().catch(()=>({}));
   if(!response.ok||!data.success)throw new Error(data.message||`HTTP ${response.status}`);
   return data;
  };
  if(action==='save'&&account?.customPlan?.status==='active'){
   const preview=await send({...payload,action:'preview'});
   const q=preview.quote;
   if(!q)throw new Error('料金プレビューを取得できませんでした。');
   const summary=`カスタムプラン契約変更内容を確認してください。

現在月額：${q.oldMonthlyYen.toLocaleString('ja-JP')}円
変更後月額：${q.newMonthlyYen.toLocaleString('ja-JP')}円
当月の追加請求：${q.immediateDueYen.toLocaleString('ja-JP')}円${q.noImmediateRefund?'（減額分の返金なし）':''}
次回以降の月額：${q.nextMonthlyYen.toLocaleString('ja-JP')}円

${q.immediateDueYen>0?'増額は差額の支払い確認後に適用します。':'追加決済なしで更新します。'}
よろしいですか？`;
   if(!window.confirm(summary)){$('custom-result').textContent='変更を取り消しました。';return;}
  }
  if(action==='save'&&account?.customPlan?.status!=='active'){
   const summary=`このユーザーに新しくカスタムプランを設定します。

Discord ID：${payload.discordUserId}
プラン名：${payload.name}
月額：${payload.monthlyYen.toLocaleString('ja-JP')}円
上限：${payload.servers}サーバー／${payload.channels}チャンネル／${payload.rules}ルール
複雑条件：${payload.complexConditions?'ON':'OFF'}
市区町村：${payload.municipalityBranching?'ON':'OFF'}
本文抽出：${payload.contentExtraction?'ON':'OFF'}
複数チャンネル：${payload.multiDestination?'ON':'OFF'}
二次利用の契約上の許容：${payload.secondaryReuse?'あり（別途申請必須）':'なし'}

保存後も利用者の決済が確認されるまで配信権限は有効になりません。続行しますか？`;
   if(!window.confirm(summary)){$('custom-result').textContent='設定の保存を取り消しました。';return;}
  }
  const data=await send(payload);
  $('custom-result').replaceChildren(element('span','',data.message));
  if(data.url){$('custom-result').append(document.createElement('br'),paymentLink(data.url));}
  customRequestId='';
  loadedCustomRevision=null;
  await loadAccounts();
 }catch(error){$('custom-result').textContent=error.message;}
 finally{button.disabled=false;}
}
