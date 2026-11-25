// 運営向けの Discord 通知（開発用サーバーの「支払い」「加入・変更・解約」の2チャンネル）。
// 送信先は Worker Secrets の BILLING_NOTICE_WEBHOOK・MEMBERSHIP_NOTICE_WEBHOOK（Webhook URL。未設定なら送らない）。
// 内容は先に D1（supporter_ops_notices）へ記録し、同じ id は 1 回だけ送る。Discord の失敗は決済・契約・配信に影響させず、次の機会に送り直す。
// メールアドレス・カード情報・Stripe の ID は載せない。
const CHANNELS=Object.freeze({billing:'BILLING_NOTICE_WEBHOOK',membership:'MEMBERSHIP_NOTICE_WEBHOOK'});
const COLORS=Object.freeze({info:0x3b82f6,good:0x16a34a,warn:0xf59e0b,bad:0xdc2626,quiet:0x6b7280});
const MAX_ATTEMPTS=20;
export const yen=value=>`${Math.round(Number(value)||0).toLocaleString('ja-JP')}円`;
// Discord の装飾・メンションとして働かない文字にする。
const plain=(value,limit=200)=>String(value??'').replace(/[\r\n\t]+/g,' ').replace(/[`*_~|<>@\\[\]()#]/g,character=>({'<':'＜','>':'＞','@':'＠','[':'［',']':'］','(':'（',')':'）'}[character]||'')).trim().slice(0,limit);

export function jstDate(seconds){
 const date=new Date((Number(seconds)+32400)*1000);
 const year=date.getUTCFullYear(),month=date.getUTCMonth()+1,day=date.getUTCDate();
 return {year,month,day,hour:date.getUTCHours(),lastDay:new Date(Date.UTC(year,month,0)).getUTCDate(),
  key:`${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`,monthKey:`${year}-${String(month).padStart(2,'0')}`,
  start:Math.floor(Date.UTC(year,month-1,day)/1000)-32400};
}
export async function queueNotice(env,db,{id,channel,kind,title,lines=[],tone='info',at=Math.floor(Date.now()/1000)}){
 try{
  const prefix=env.SUPPORTER_BILLING_MODE==='live'?'':'【テスト】';
  const payload=JSON.stringify({title:`${prefix}${plain(title,180)}`,description:lines.filter(line=>line!==null&&line!==undefined&&line!=='').map(line=>plain(line,300)).join('\n').slice(0,3800),color:COLORS[tone]??COLORS.info,at:Number(at)||0});
  const result=await db.prepare(`INSERT INTO supporter_ops_notices(id,channel,kind,payload_json,status,attempts,created_at,updated_at)
   VALUES(?,?,?,?,'pending',0,?,?) ON CONFLICT(id) DO NOTHING`).bind(id,channel,kind,payload,Number(at)||0,Number(at)||0).run();
  return Number(result.meta?.changes||0)>0;
 }catch(error){console.error('Supporter ops notice could not be queued',{kind,errorName:error?.name||'Error'});return false;}
}
function webhookUrl(env,channel){
 const value=String(env[CHANNELS[channel]]||'').trim();
 return /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d{17,20}\/[\w-]{20,}$/.test(value)?value:'';
}
export async function flushNotices(env,db,limit=20){
 let sent=0;
 try{
  const now=Math.floor(Date.now()/1000);
  const rows=await db.prepare(`SELECT * FROM supporter_ops_notices WHERE status='pending' OR (status='sending' AND updated_at<=?) ORDER BY created_at,rowid LIMIT ?`).bind(now-300,limit).all();
  const blocked=new Set();
  for(const row of rows.results||[]){
   if(blocked.has(row.channel))continue;
   const claim=await db.prepare(`UPDATE supporter_ops_notices SET status='sending',attempts=attempts+1,updated_at=? WHERE id=? AND attempts=? AND status IN ('pending','sending')`).bind(now,row.id,row.attempts).run();
   if(!claim.meta?.changes)continue;
   const finish=status=>db.prepare('UPDATE supporter_ops_notices SET status=?,updated_at=? WHERE id=?').bind(status,now,row.id).run();
   const url=webhookUrl(env,row.channel);
   if(!url){await finish('skipped');continue;}
   try{
    const {title,description,color,at}=JSON.parse(row.payload_json);
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(8000),
     body:JSON.stringify({allowed_mentions:{parse:[]},embeds:[{title,description,color,timestamp:new Date(at*1000).toISOString()}]})});
    if(response.ok){await finish('sent');sent+=1;continue;}
    // 宛先が消えている・内容が不正なら送り直さない。混雑（429）と障害は次の機会に送る。
    if(response.status>=400&&response.status<500&&response.status!==429){await finish('failed');console.error('Supporter ops notice was rejected',{channel:row.channel,status:response.status});continue;}
    blocked.add(row.channel);await finish(Number(row.attempts)+1>=MAX_ATTEMPTS?'failed':'pending');
   }catch(error){blocked.add(row.channel);await finish(Number(row.attempts)+1>=MAX_ATTEMPTS?'failed':'pending');console.error('Supporter ops notice was not delivered',{channel:row.channel,errorName:error?.name||'Error'});}
  }
 }catch(error){console.error('Supporter ops notices could not be flushed',{errorName:error?.name||'Error'});}
 return sent;
}

// --- 加入・変更・解約 ---
const packs=summary=>[['チャンネル',summary.channelPacks],['サーバー',summary.serverPacks],['ルール',summary.rulePacks]].filter(([,count])=>Number(count)>0).map(([label,count])=>`${label}追加×${count}`).join('、')||'なし';
const planText=summary=>`${summary.plan||'確認が必要な契約'}（月額 ${yen(summary.amount)}${packs(summary)==='なし'?'':`、${packs(summary)}`}）`;
const dayText=seconds=>{if(!seconds)return '—';const {year,month,day}=jstDate(seconds);return `${year}年${month}月${day}日`;};
export async function memberLabel(db,customer){
 const row=await db.prepare(`SELECT a.discord_user_id,a.discord_name FROM supporter_billing b JOIN supporter_accounts a ON a.discord_user_id=b.discord_user_id WHERE b.customer_id=?`).bind(customer).first();
 return row?{uid:row.discord_user_id,text:`${plain(row.discord_name,60)||'名前なし'}（ID ${row.discord_user_id}）`}:null;
}
// Stripe の契約イベントを、変更前後を比べて通知にする。更新（毎月の期間の切替）や内部の印だけの変更は通知しない。
export async function queueMembershipNotice(env,db,event,{summarize,cancelScheduled,customName='',scheduled=null}){
 try{
  const subscription=event.data?.object||{},previous=event.data?.previous_attributes||{};
  const customer=typeof subscription.customer==='string'?subscription.customer:subscription.customer?.id;
  const member=customer?await memberLabel(db,customer):null;
  if(!member)return;
  const named=summary=>summary.customId?{...summary,plan:customName||'カスタムプラン'}:summary;
  const current=named(summarize(subscription)),at=Number(event.created)||Math.floor(Date.now()/1000);
  const add=(kind,title,lines,tone)=>queueNotice(env,db,{id:`${event.id}:${kind}`,channel:'membership',kind,title,lines:[`利用者: ${member.text}`,...lines],tone,at});
  if(event.type==='customer.subscription.created'){
   const before=await db.prepare(`SELECT id FROM supporter_ops_notices WHERE channel='membership' AND kind='join' AND payload_json LIKE ? LIMIT 1`).bind(`%ID ${member.uid}%`).first();
   await add('join',before?'再加入':'新規加入',[`プラン: ${planText(current)}`,`支払い: ${subscription.metadata?.dpi_initial_payment_method==='credit_balance'?'クレジット':'カードなど'}`,`次回の請求: ${dayText(current.nextRenewalAt)}`],'good');
   return;
  }
  if(event.type==='customer.subscription.deleted'){
   const automatic=!!subscription.metadata?.dpi_auto_cancel,reserved=cancelScheduled(subscription);
   await add('leave',automatic?'解約（自動）':'解約',[`プラン: ${planText(current)}`,`理由: ${automatic?'支払いを確認できないため':reserved?'解約の予約による契約期間の終了':'管理者の操作など'}`],automatic?'bad':'quiet');
   return;
  }
  if(event.type!=='customer.subscription.updated')return;
  const old={...subscription,...Object.fromEntries(['items','cancel_at_period_end','cancel_at','schedule'].filter(name=>Object.hasOwn(previous,name)).map(name=>[name,previous[name]])),
   metadata:{...subscription.metadata,...(previous.metadata||{})}};
  const past=named(summarize(old));
  if(['planId','channelPacks','serverPacks','rulePacks','amount'].some(name=>past[name]!==current[name]))
   await add('change','プラン変更',[`変更前: ${planText(past)}`,`変更後: ${planText(current)}`,subscription.metadata?.dpi_updated_by==='admin'?'操作: 管理者':''],'info');
  if(Object.hasOwn(previous,'schedule')&&!previous.schedule&&subscription.schedule&&scheduled)
   await add('change_reserved','変更の予約',[`現在: ${planText(current)}`,`${dayText(scheduled.effectiveAt)}から: ${planText({plan:scheduled.plan,amount:scheduled.monthly,...scheduled})}`],'info');
  const wasReserved=cancelScheduled(old),isReserved=cancelScheduled(subscription);
  if(!wasReserved&&isReserved)await add('leave_reserved','解約の予約',[`プラン: ${planText(current)}`,`利用できる期限: ${dayText(Number(subscription.cancel_at)||current.nextRenewalAt)}`],'warn');
  if(wasReserved&&!isReserved)await add('leave_reserved_canceled','解約の予約の取り消し',[`プラン: ${planText(current)}`],'good');
 }catch(error){console.error('Supporter membership notice failed',{type:event?.type,errorName:error?.name||'Error'});}
}
export async function noticeCounts(db,channel,from,to){
 const rows=await db.prepare('SELECT kind,COUNT(*) AS n FROM supporter_ops_notices WHERE channel=? AND created_at>=? AND created_at<? GROUP BY kind').bind(channel,from,to).all();
 return Object.fromEntries((rows.results||[]).map(row=>[row.kind,Number(row.n)||0]));
}
export async function suspendedCustomers(db){
 return Number((await db.prepare(`SELECT COUNT(DISTINCT customer_id) AS n FROM supporter_dunning WHERE status='suspended'`).first())?.n||0);
}
