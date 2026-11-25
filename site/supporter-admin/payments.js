const $=id=>document.getElementById(id);

const STATUS_TEXT={pending:'待ち',sending:'送信中',sent:'送信済み',failed:'失敗',skipped:'送信なし',granted:'付与済み',pending_grant:'付与待ち',pending_remove:'取り外し待ち',removed:'取り外し済み',needs_response:'回答が必要',under_review:'審査中',won:'勝ち',lost:'負け',warning_needs_response:'照会への回答が必要',warning_under_review:'照会の審査中',warning_closed:'照会の終了',succeeded:'成功',canceled:'取り消し'};
const KIND_TEXT={renewal_start:'26日の請求の開始',renewal_result:'26日の請求の結果',retry_start:'再請求の開始',retry_result:'再請求の結果',month_start:'1日の停止・解約',stop:'停止・自動解約',join:'新規加入',rejoin:'再加入',change:'プラン変更',change_reserved:'変更の予約',change_reserved_canceled:'変更の予約の取り消し',leave_reserved:'解約の予約',leave_reserved_canceled:'解約の予約の取り消し',leave:'解約',leave_auto:'解約（自動）',refunded:'返金',disputed:'支払異議の申立て',dispute_closed:'支払異議の終了',fraud_warning:'不正の警告',topup:'クレジットチャージ',topup_failed:'クレジットチャージ失敗'};
const TYPE_TEXT={invoice:'請求書',hold:'配信の停止',dispute:'支払異議による停止'},CHANNEL_TEXT={billing:'支払い',membership:'加入・変更・解約'};
export const label=(map,key)=>map[key]||key;
export const statusText=key=>label(STATUS_TEXT,key);
export function formatJst(seconds){
 if(seconds==null||seconds==='')return '—';
 const date=new Date(Number(seconds)*1000);
 if(Number.isNaN(date.getTime()))return '—';
 return new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'medium',timeZone:'Asia/Tokyo'}).format(date);
}
export function formatMoney(amount,currency='JPY'){
 const value=Number(amount);
 if(!Number.isFinite(value))return '—';
 const code=String(currency||'JPY').toUpperCase();
 try{return new Intl.NumberFormat('ja-JP',{style:'currency',currency:code,maximumFractionDigits:code==='JPY'?0:2}).format(value);}
 catch{return `${value.toLocaleString('ja-JP')} ${code}`;}
}
export function emptyMessage(items){return Array.isArray(items)&&items.length?'':'該当はありません';}
export function requestErrorMessage(status){return `支払い情報の取得に失敗しました（HTTP ${Number(status)||0}）。`;}

const value=(input,fallback='—')=>input==null||input===''?fallback:String(input);
const failed=item=>['failed','error','failure'].includes(String(item?.status||'').toLowerCase())||Boolean(item?.lastError);
const pending=item=>['pending','waiting','requires_payment','awaiting_payment'].includes(String(item?.status||'').toLowerCase());
const unresolved=item=>!item?.paidAt&&!['paid','closed','resolved','succeeded','canceled'].includes(String(item?.status||'').toLowerCase());
const matches=(item,query)=>!query||[item?.name,item?.discordUserId].some(entry=>String(entry||'').toLocaleLowerCase('ja-JP').includes(query));

function element(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!=null)node.textContent=text;return node;}
function stateClass(status){const text=String(status||'').toLowerCase();return failed({status:text})||/^(?:lost|停止中)$/.test(text)?'failed':pending({status:text})||/needs_response|under_review|^pending_|^sending$|待ち|予定|再請求中/.test(text)?'warning':'ok';}
function card(title,fields,lines=[]){
 const article=element('article','payment-card');article.append(element('h3','',value(title)));
 const list=document.createElement('dl');
 for(const [label,content,isState] of fields){const dt=element('dt','',label),dd=element('dd');if(isState)dd.append(element('span',`payment-state ${stateClass(content)}`,value(statusText(content))));else dd.textContent=value(content);list.append(dt,dd);}
 article.append(list);
 if(Array.isArray(lines)&&lines.length){const ul=element('ul','payment-lines');for(const line of lines)ul.append(element('li','',value(line)));article.append(ul);}
 return article;
}
function renderList(id,items,makeCard){const node=$(id);node.replaceChildren();for(const item of items)node.append(makeCard(item));const message=emptyMessage(items);if(message)node.append(element('p','payment-empty',message));}
function errorNames(errors){return (Array.isArray(errors)?errors:[]).map(item=>typeof item==='string'?item:item?.name||item?.section||item?.item).filter(Boolean);}

let paymentData=null;
function render(){
 if(!paymentData)return;
 const query=$('payment-search').value.trim().toLocaleLowerCase('ja-JP');
 const selected=(name,predicate=()=>true)=>(Array.isArray(paymentData[name])?paymentData[name]:[]).filter(item=>matches(item,query)&&predicate(item));
 renderList('payment-runs',selected('runs'),item=>card(item.title||item.kind,[['種別',label(KIND_TEXT,item.kind)],['状態',item.status,true],['実行日時',formatJst(item.at)],['試行回数',item.attempts]],item.lines));
 renderList('payment-failures',selected('failures',item=>!$('failures-open-only').checked||unresolved(item)),item=>card(item.name||item.discordUserId,[['Discord ID',item.discordUserId],['金額',formatMoney(item.amount,item.currency)],['種類',label(TYPE_TEXT,item.type)],['状態',item.statusLabel||item.status,true],['失敗日時',formatJst(item.failedAt)],['再請求日時',formatJst(item.retryAt)],['再請求実行日時',formatJst(item.retryAttemptedAt)],['停止予定日時',formatJst(item.suspendAt)],['停止日時',formatJst(item.suspendedAt)],['支払い確認日時',formatJst(item.paidAt)],['更新日時',formatJst(item.updatedAt)],['請求書ID',item.invoiceId]]));
 renderList('payment-alerts-detail',selected('alerts'),item=>card(item.name||item.discordUserId,[['Discord ID',item.discordUserId],['種類',item.kindLabel||item.kind],['金額',formatMoney(item.amount)],['結果',item.outcome,true],['日時',formatJst(item.at)],['イベントID',item.eventId]]));
 renderList('payment-mails',selected('mails',item=>!$('mails-failed-only').checked||failed(item)),item=>card(item.name||item.reference,[['Discord ID',item.discordUserId],['種類',item.kindLabel||item.kind],['状態',item.status,true],['試行回数',item.attempts],['最終エラー',item.lastError],['更新日時',formatJst(item.updatedAt)],['送信日時',formatJst(item.sentAt)],['参照ID',item.reference]]));
 renderList('payment-topups',selected('topups',item=>!$('topups-pending-only').checked||pending(item)),item=>card(item.name||item.discordUserId,[['Discord ID',item.discordUserId],['金額',formatMoney(item.amount)],['返金額',formatMoney(item.refundedAmount)],['状態',item.statusLabel||item.status,true],['作成日時',formatJst(item.createdAt)],['入金日時',formatJst(item.purchasedAt)],['有効期限',formatJst(item.expiresAt)],['リクエストID',item.requestId]]));
 renderList('payment-roles',selected('roles',item=>!$('roles-failed-only').checked||failed(item)),item=>card(item.name||item.discordUserId,[['Discord ID',item.discordUserId],['ロール',item.roleLabel],['状態',item.status,true],['試行回数',item.attempts],['最終エラー',item.lastError],['更新日時',formatJst(item.updatedAt)]]));
 renderList('payment-notices',selected('notices'),item=>card(item.title||item.kind,[['通知先',label(CHANNEL_TEXT,item.channel)],['種別',label(KIND_TEXT,item.kind)],['状態',item.status,true],['通知日時',formatJst(item.at)],['試行回数',item.attempts]],item.lines));
}
function metric(node,label,count){const article=element('article','metric-card'),caption=element('span','',label),strong=element('strong','',Number(count||0).toLocaleString('ja-JP'));article.append(caption,strong);node.append(article);}
async function load(){
 const status=$('payments-status');status.className='status info';status.textContent='読み込み中…';
 try{
  const response=await fetch('/site/supporter-admin/api/payments?limit=200',{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});
  if(!response.ok)throw new Error(requestErrorMessage(response.status));
  paymentData=await response.json();
  $('payment-mode').textContent=`決済モード: ${paymentData.mode==='live'?'本番':'テスト'}`;
  $('payment-generated').textContent=`取得時刻: ${formatJst(paymentData.generatedAt)}`;
  const summary=paymentData.summary||{},metrics=$('payment-summary');metrics.replaceChildren();
  for(const [label,key] of [['未解決の支払い失敗','failuresOpen'],['停止中','suspended'],['メール失敗','mailsFailed'],['運営通知待ち','noticesPending'],['30日間の警告','alerts30d'],['チャージ入金待ち','topupsPending']])metric(metrics,label,summary[key]);
  render();
  const names=errorNames(paymentData.errors);status.className=names.length?'status error':'status success';status.textContent=names.length?`取得できなかった項目: ${names.join('、')}`:'支払い情報を表示しました。';
 }catch(error){paymentData=null;status.className='status error';status.textContent=error.message||requestErrorMessage(0);}
}
function initialize(){
 $('refresh-payments').addEventListener('click',load);$('payment-search').addEventListener('input',render);
 for(const id of ['failures-open-only','mails-failed-only','topups-pending-only','roles-failed-only'])$(id).addEventListener('change',render);
 load();
}
if(typeof document!=='undefined')initialize();
