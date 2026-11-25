const numberOrNull = value => value === null || value === undefined || value === '' ? null : Number(value);
const textOrNull = value => typeof value === 'string' && value ? value : null;
const safeError = value => textOrNull(value)?.replace(/https?:\/\/\S+|\b[^\s@]+@[^\s@]+\.[^\s@]+|\b(?:sk|rk|pk|whsec)_[A-Za-z0-9_]+/gi,'[redacted]') || null;
const name = row => textOrNull(row.discord_name);
const statusLabels = {retry_scheduled:'再請求待ち',retrying:'再請求中',suspend_scheduled:'停止予定',suspended:'停止中',paid:'支払い済み',closed:'終了'};
const alertLabels = {refunded:'返金',disputed:'支払異議の申立て',dispute_closed:'支払異議の終了',fraud_warning:'不正の警告'};
const mailLabels = {payment_succeeded:'支払い完了',payment_failed:'支払い失敗',retry_succeeded:'再請求成功',final_failed:'再請求失敗',auto_canceled:'自動解約',credit_topup_succeeded:'クレジット購入完了',credit_topup_failed:'クレジット購入失敗',credit_plan_payment_succeeded:'クレジット決済完了',credit_expired:'クレジット期限切れ',admin_notice:'管理通知'};
const topupLabels = {pending:'処理待ち',credited:'反映済み',failed:'失敗',expired:'期限切れ',refunded:'返金済み',disputed:'支払異議'};

function notice(row) {
 let payload = {};
 try { payload = JSON.parse(row.payload_json || '{}'); } catch { /* malformed legacy payload */ }
 return {id:row.id,channel:row.channel,kind:row.kind,title:textOrNull(payload.title),lines:typeof payload.description === 'string' ? payload.description.split(/\r?\n/) : [],at:numberOrNull(row.created_at),status:row.status,attempts:Number(row.attempts)||0};
}

async function rows(db, sql, ...values) {
 return (await db.prepare(sql).bind(...values).all()).results || [];
}

export async function supporterAdminPayments(db, env, limit = 200) {
 const output = {generatedAt:Math.floor(Date.now()/1000),mode:env.SUPPORTER_BILLING_MODE,summary:{failuresOpen:0,suspended:0,mailsFailed:0,noticesPending:0,alerts30d:0,topupsPending:0},runs:[],notices:[],failures:[],alerts:[],mails:[],topups:[],roles:[]};
 const errors = [];
 const read = async (key, task) => { try { output[key] = await task(); } catch (error) { console.error('Supporter admin payments read failed',{item:key,errorName:error?.name||'Error'}); output[key] = []; errors.push(key); } };
 await read('runs',async()=>(await rows(db,`SELECT id,channel,kind,payload_json,status,attempts,created_at FROM supporter_ops_notices WHERE channel='billing' AND kind IN ('renewal_start','renewal_result','retry_start','retry_result','month_start','stop') ORDER BY created_at DESC,id DESC LIMIT ?`,limit)).map(row=>{const item=notice(row);delete item.channel;return item;}));
 await read('notices',async()=>(await rows(db,`SELECT id,channel,kind,payload_json,status,attempts,created_at FROM supporter_ops_notices WHERE channel<>'billing' OR kind NOT IN ('renewal_start','renewal_result','retry_start','retry_result','month_start','stop') ORDER BY created_at DESC,id DESC LIMIT ?`,limit)).map(notice));
 await read('failures',async()=>(await rows(db,`SELECT d.*,a.discord_name FROM supporter_dunning d LEFT JOIN supporter_billing b ON b.customer_id=d.customer_id LEFT JOIN supporter_accounts a ON a.discord_user_id=b.discord_user_id ORDER BY d.updated_at DESC,d.invoice_id DESC LIMIT ?`,limit)).map(row=>({
  discordUserId:textOrNull(row.discord_user_id),name:name(row),invoiceId:row.invoice_id,type:String(row.invoice_id).startsWith('hold:dispute:')?'dispute':String(row.invoice_id).startsWith('hold:')?'hold':'invoice',amount:Number(row.amount_due)||0,currency:row.currency,status:row.status,statusLabel:statusLabels[row.status]||row.status,failedAt:numberOrNull(row.initial_failed_at),retryAt:numberOrNull(row.retry_at),retryAttemptedAt:numberOrNull(row.retry_attempted_at),suspendAt:numberOrNull(row.suspend_at),suspendedAt:numberOrNull(row.suspended_at),paidAt:numberOrNull(row.paid_at),updatedAt:numberOrNull(row.updated_at)})));
 await read('alerts',async()=>(await rows(db,`SELECT p.event_id,p.kind,p.outcome,p.discord_user_id,p.amount,p.created_at,a.discord_name FROM supporter_payment_alerts p LEFT JOIN supporter_accounts a ON a.discord_user_id=p.discord_user_id ORDER BY p.created_at DESC,p.event_id DESC LIMIT ?`,limit)).map(row=>({eventId:row.event_id,kind:row.kind,kindLabel:alertLabels[row.kind]||row.kind,discordUserId:textOrNull(row.discord_user_id),name:name(row),amount:Number(row.amount)||0,outcome:row.outcome,at:numberOrNull(row.created_at)})));
 await read('mails',async()=>(await rows(db,`SELECT n.invoice_id,n.kind,n.status,n.attempts,n.last_error,n.updated_at,n.sent_at,COALESCE(d.discord_user_id,t.discord_user_id,l.discord_user_id) discord_user_id,COALESCE(ad.discord_name,at.discord_name,al.discord_name) discord_name FROM supporter_billing_notifications n LEFT JOIN (SELECT d.invoice_id,b.discord_user_id FROM supporter_dunning d LEFT JOIN supporter_billing b ON b.customer_id=d.customer_id) d ON d.invoice_id=n.invoice_id LEFT JOIN supporter_credit_topups t ON t.checkout_session_id=n.invoice_id OR t.request_id=n.invoice_id LEFT JOIN supporter_credit_lots l ON n.invoice_id=('expiry:'||l.id) LEFT JOIN supporter_accounts ad ON ad.discord_user_id=d.discord_user_id LEFT JOIN supporter_accounts at ON at.discord_user_id=t.discord_user_id LEFT JOIN supporter_accounts al ON al.discord_user_id=l.discord_user_id ORDER BY n.updated_at DESC,n.invoice_id DESC,n.kind DESC LIMIT ?`,limit)).map(row=>({reference:row.invoice_id,kind:row.kind,kindLabel:mailLabels[row.kind]||row.kind,status:row.status,attempts:Number(row.attempts)||0,lastError:safeError(row.last_error),updatedAt:numberOrNull(row.updated_at),sentAt:numberOrNull(row.sent_at),discordUserId:textOrNull(row.discord_user_id),name:name(row)})));
 await read('topups',async()=>(await rows(db,`SELECT t.request_id,t.discord_user_id,t.amount,t.refunded_amount,t.status,t.created_at,t.purchased_at,t.expires_at,a.discord_name FROM supporter_credit_topups t LEFT JOIN supporter_accounts a ON a.discord_user_id=t.discord_user_id ORDER BY t.created_at DESC,t.request_id DESC LIMIT ?`,limit)).map(row=>({requestId:row.request_id,discordUserId:row.discord_user_id,name:name(row),amount:Number(row.amount)||0,refundedAmount:Number(row.refunded_amount)||0,status:row.status,statusLabel:topupLabels[row.status]||row.status,createdAt:numberOrNull(row.created_at),purchasedAt:numberOrNull(row.purchased_at),expiresAt:numberOrNull(row.expires_at)})));
 const roleLabels = new Map([[env.SUPPORTER_ROLE_MEMBER,'プラン加入者'],[env.SUPPORTER_ROLE_BASIC,'Basicプラン'],[env.SUPPORTER_ROLE_PLUS,'Plusプラン'],[env.SUPPORTER_ROLE_PRO,'Proプラン'],[env.SUPPORTER_ROLE_CUSTOM,'カスタムプラン']].filter(([id])=>id));
 await read('roles',async()=>(await rows(db,`SELECT r.discord_user_id,r.role_id,r.status,r.attempts,r.last_error,r.updated_at,a.discord_name FROM supporter_discord_roles r LEFT JOIN supporter_accounts a ON a.discord_user_id=r.discord_user_id ORDER BY r.updated_at DESC,r.discord_user_id,r.role_id LIMIT ?`,limit)).map(row=>({discordUserId:row.discord_user_id,name:name(row),roleLabel:roleLabels.get(row.role_id)||null,status:row.status,attempts:Number(row.attempts)||0,lastError:textOrNull(row.last_error),updatedAt:numberOrNull(row.updated_at)})));
 const summaries = [
  ['failuresOpen','failures',`SELECT COUNT(*) count FROM supporter_dunning WHERE status NOT IN ('paid','closed')`],
  ['suspended','failures',`SELECT COUNT(DISTINCT b.discord_user_id) count FROM supporter_dunning d LEFT JOIN supporter_billing b ON b.customer_id=d.customer_id WHERE d.status='suspended'`],
  ['mailsFailed','mails',`SELECT COUNT(*) count FROM supporter_billing_notifications WHERE status='failed'`],
  ['noticesPending','notices',`SELECT COUNT(*) count FROM supporter_ops_notices WHERE status='pending'`],
  ['alerts30d','alerts',`SELECT COUNT(*) count FROM supporter_payment_alerts WHERE created_at>=?`,Math.floor(Date.now()/1000)-30*86400],
  ['topupsPending','topups',`SELECT COUNT(*) count FROM supporter_credit_topups WHERE status='pending'`],
 ];
 for (const [key,errorKey,sql,value] of summaries) try { output.summary[key]=Number((await db.prepare(sql).bind(...(value===undefined?[]:[value])).first())?.count)||0; } catch { errors.push(errorKey); }
 if (errors.length) output.errors=[...new Set(errors)];
 return output;
}
