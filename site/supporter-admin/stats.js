const $=id=>document.getElementById(id);
const yen=v=>new Intl.NumberFormat('ja-JP',{style:'currency',currency:'JPY',maximumFractionDigits:0}).format(Number(v)||0);
const number=v=>Number(v||0).toLocaleString('ja-JP');
const activeStatuses=new Set(['active','trialing','past_due','unpaid','paused']);
function metric(node,label,value){
 const article=document.createElement('article');article.className='metric-card';
 const caption=document.createElement('span');caption.textContent=label;
 const strong=document.createElement('strong');strong.textContent=value;
 article.append(caption,strong);node.append(article);
}
function chart(node,values){
 node.replaceChildren();
 const max=Math.max(1,...values.map(([,count])=>Math.max(0,Number(count)||0)));
 for(const [name,value] of values){
  const row=document.createElement('div');row.className='stats-row';
  const heading=document.createElement('span');heading.textContent=name;
  const track=document.createElement('div');track.className='stats-track';
  const bar=document.createElement('div');bar.className='stats-bar';bar.style.width=`${Math.min(100,Math.max(0,Number(value)||0)/max*100)}%`;
  const amount=document.createElement('strong');amount.textContent=number(value);
  track.append(bar);row.append(heading,track,amount);node.append(row);
 }
 if(!values.length)node.textContent='集計データがありません。';
}
async function load(){
 $('stats-status').textContent='読み込み中…';
 try{
  const r=await fetch('/site/supporter-admin/api/accounts',{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}});
  if(!r.ok)throw Error('契約・クレジット統計を取得できませんでした。');
  const data=await r.json(),accounts=data.accounts||[],subscriptions=accounts.flatMap(a=>a.subscriptions||[]);
  const active=subscriptions.filter(s=>activeStatuses.has(s.status)&&s.recognizedPlan!==false);
  const credit=data.creditSummary||{};
  const cards=$('stats-metrics');cards.replaceChildren();
  metric(cards,'登録アカウント数',number(accounts.length));
  metric(cards,'有効・対応中の契約数',number(active.length));
  metric(cards,'月額合計（契約額）',yen(active.reduce((sum,s)=>sum+Number(s.amount||0),0)));
  metric(cards,'解約予定',number(active.filter(s=>s.cancelAtPeriodEnd).length));
  metric(cards,'BAN中の登録者',number(accounts.filter(a=>a.accountStatus==='suspended').length));
  chart($('stats-plans'),[['Basic',active.filter(s=>s.planId==='supporter').length],['Plus',active.filter(s=>s.planId==='plus').length],['Pro',active.filter(s=>s.planId==='pro').length]]);
  const statusLabels={active:'有効',trialing:'次回請求待ち',past_due:'支払遅延',unpaid:'未払い',paused:'一時停止',canceled:'解約済み',incomplete:'手続き未完了'};
  chart($('stats-status-chart'),[...new Set(subscriptions.map(s=>s.status))].map(status=>[statusLabels[status]||status,subscriptions.filter(s=>s.status===status).length]));
  chart($('stats-credits'),[['購入クレジット残高',credit.purchasedBalance||0],['管理者付与等の残高',credit.otherCredits||0]]);
  const details=$('stats-credit-metrics');details.replaceChildren();
  for(const [label,value] of [['総クレジット',credit.totalCredits==null?'取得不可':number(credit.totalCredits)],['保有者数',credit.creditUsers==null?'取得不可':number(credit.creditUsers)],['購入者数',number(credit.purchasers)],['累計チャージ（円）',yen(credit.netPurchased)],['30日以内の失効予定',number(credit.expiring30Days)],['累計失効',number(credit.expiredCredits)]])metric(details,label,value);
  const months=new Map();
  for(const account of accounts){
   const d=String(account.registeredAt||'').slice(0,7);if(/^[0-9]{4}-[0-9]{2}$/.test(d))months.set(d,(months.get(d)||0)+1);
  }
  chart($('stats-registrations'),[...months].sort((a,b)=>a[0].localeCompare(b[0])).slice(-12));
  $('stats-status').textContent=data.creditSummaryError||'現在の契約・クレジット情報を表示しています（履歴推移ではありません）。';
 }catch(error){$('stats-status').textContent=error.message;}
}
$('refresh-stats').addEventListener('click',load);
load();
