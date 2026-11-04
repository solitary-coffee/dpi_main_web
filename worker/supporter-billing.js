// Test-only integration. Live keys are deliberately rejected until delivery is ready.
const json = (data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
function integrationIdentifier(prefix){const bytes=crypto.getRandomValues(new Uint8Array(8));return `${prefix}${[...bytes].map(value=>String.fromCharCode(97+value%26)).join('')}`;}
export const PLAN_CATALOG=Object.freeze({
 supporter:Object.freeze({id:'supporter',name:'BASIC',yen:300,channels:2,servers:1,rules:5,complexConditions:false,multiDestination:false,priceEnv:'STRIPE_PRICE_SUPPORTER'}),
 plus:Object.freeze({id:'plus',name:'Plus',yen:800,channels:10,servers:3,rules:15,complexConditions:false,multiDestination:false,priceEnv:'STRIPE_PRICE_PLUS'}),
 pro:Object.freeze({id:'pro',name:'Pro',yen:1280,channels:20,servers:5,rules:30,complexConditions:true,multiDestination:true,priceEnv:'STRIPE_PRICE_PRO'}),
});
export function publicPlans(){return Object.values(PLAN_CATALOG).map(({priceEnv,...plan})=>plan);}
function planDefinition(plan){const value=PLAN_CATALOG[plan];if(!value)fail('プランまたは追加オプション数が不正です。');return value;}
function planPrice(env,plan){const definition=planDefinition(plan);const price=env[definition.priceEnv];if(!price)fail(`${definition.name}プランの決済設定が完了していません。`,503);return price;}
export function billingReady(env){return env.SUPPORTER_BILLING_MODE==='test' && /^(?:sk|rk)_test_/.test(env.STRIPE_SECRET_KEY||'') && !!env.STRIPE_WEBHOOK_SECRET && !!env.STRIPE_PRICE_SUPPORTER && !!env.STRIPE_PRICE_PLUS && !!env.STRIPE_PRICE_PRO && !!env.STRIPE_PRICE_ADDON && !!env.STRIPE_PORTAL_CONFIG;}
async function stripe(env,path,params,key,method=params?'POST':'GET'){
 if(!billingReady(env)) fail('決済設定が完了していません。',503);
 const headers={Authorization:`Bearer ${env.STRIPE_SECRET_KEY}`,'Stripe-Version':'2026-09-30.endive'};
 if(key)headers['Idempotency-Key']=key;
 if(params)headers['Content-Type']='application/x-www-form-urlencoded';
 const r=await fetch(`https://api.stripe.com/v1/${path}`,{method,headers,body:params?new URLSearchParams(params):undefined,signal:AbortSignal.timeout(15000)});
 const result=await r.json();if(!r.ok)fail('Stripeへの接続に失敗しました。時間をおいて再試行してください。',502);
 if(result.livemode===true)fail('本番決済は無効です。',503);
 return result;
}
export function creditsFromBalance(balance){return Math.max(0,-Number(balance||0));}
export async function createBillingCustomer(env,uid,email,key){
 const params={'metadata[dpi_user]':uid};
 if(email)params.email=email;
 return await stripe(env,'customers',params,key);
}
export async function customerCredits(env,customer){
 if(!customer||!billingReady(env))return 0;
 return creditsFromBalance((await stripe(env,`customers/${encodeURIComponent(customer)}`)).balance);
}
export async function creditsByCustomer(env,customers){
 const wanted=new Set((customers||[]).filter(Boolean));
 const resultMap=new Map([...wanted].map(customer=>[customer,0]));
 if(!wanted.size||!billingReady(env))return resultMap;
 let startingAfter='';
 for(let page=0;page<5;page++){
  const suffix=startingAfter?`&starting_after=${encodeURIComponent(startingAfter)}`:'';
  const result=await stripe(env,`customers?limit=100${suffix}`);
  for(const customer of result.data||[])if(wanted.has(customer.id))resultMap.set(customer.id,creditsFromBalance(customer.balance));
  if(!result.has_more||!result.data?.length)break;
  startingAfter=result.data.at(-1).id;
 }
 return resultMap;
}
export function selection(input){
 const channelPacks=input.channelPacks??input.packs??0;
 const serverPacks=input.serverPacks??0;
 const definition=PLAN_CATALOG[input.plan];
 if(!definition||!Number.isInteger(channelPacks)||channelPacks<0||channelPacks>5||!Number.isInteger(serverPacks)||serverPacks<0||serverPacks>5)fail('プランまたは追加オプション数が不正です。');
 return {plan:input.plan,packs:channelPacks,channelPacks,serverPacks,baseMonthly:definition.yen,monthly:definition.yen+200*(channelPacks+serverPacks),channels:definition.channels+3*channelPacks,servers:definition.servers+serverPacks,rules:definition.rules,complexConditions:definition.complexConditions,multiDestination:definition.multiDestination};
}
export function billingSchedule(now=Date.now()){
 const jst=new Date(Number(now)+9*60*60*1000);
 const day=jst.getUTCDate();
 let year=jst.getUTCFullYear(),month=jst.getUTCMonth();
 if(day>=26){month+=1;if(month>11){month=0;year+=1;}}
 const anchor=Math.floor((Date.UTC(year,month,26,0,0,0)-9*60*60*1000)/1000);
 return {billingDay:26,anchor,initialMonths:day>=26?2:1,lateMonth:day>=26};
}
async function subscriptions(env,customer){return (await stripe(env,`subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=100`)).data.filter(s=>!['canceled','incomplete_expired'].includes(s.status));}
const unix = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
export function subscriptionSummary(subscription,env={}){
 const labels=new Map([
  [env.STRIPE_PRICE_SUPPORTER,'BASIC'],
  [env.STRIPE_PRICE_PLUS,'Plus'],
  [env.STRIPE_PRICE_PRO,'Pro'],
  [env.STRIPE_PRICE_ADDON,'追加オプション'],
 ].filter(([id])=>id));
 const items=(subscription.items?.data||[]).map(item=>{
  const quantity=Number.isFinite(Number(item.quantity))&&Number(item.quantity)>0?Number(item.quantity):1;
  const unitAmount=Number.isFinite(Number(item.price?.unit_amount))?Number(item.price.unit_amount):0;
  return {price:item.price?.id||'',label:labels.get(item.price?.id)||item.price?.nickname||'契約項目',quantity,unitAmount,subtotal:unitAmount*quantity,currency:(item.price?.currency||'jpy').toLowerCase(),periodStart:unix(item.current_period_start),periodEnd:unix(item.current_period_end)};
 });
 const currentPeriodStart=items.map(item=>item.periodStart).filter(Boolean).sort((a,b)=>a-b)[0]||unix(subscription.current_period_start);
 const nextRenewalAt=items.map(item=>item.periodEnd).filter(Boolean).sort((a,b)=>b-a)[0]||unix(subscription.current_period_end);
 const currency=items.find(item=>item.currency)?.currency||'jpy';
 const basePrice=items.find(item=>item.price!==env.STRIPE_PRICE_ADDON)?.price;
 const addonQuantity=items.find(item=>item.price===env.STRIPE_PRICE_ADDON)?.quantity||0;
 const metadata=subscription.metadata||{};
 const storedChannelPacks=Number(metadata.dpi_channel_packs);
 const storedServerPacks=Number(metadata.dpi_server_packs);
 const channelPacks=Number.isInteger(storedChannelPacks)&&storedChannelPacks>=0?storedChannelPacks:addonQuantity;
 const serverPacks=Number.isInteger(storedServerPacks)&&storedServerPacks>=0?storedServerPacks:0;
 const planId=basePrice===env.STRIPE_PRICE_PRO?'pro':basePrice===env.STRIPE_PRICE_PLUS?'plus':'supporter';
 const choice=selection({plan:planId,channelPacks,serverPacks});
 return {status:subscription.status||'unknown',cancelAtPeriodEnd:subscription.cancel_at_period_end===true,startedAt:unix(subscription.start_date)||unix(subscription.created),currentPeriodStart,nextRenewalAt,amount:items.reduce((sum,item)=>sum+item.subtotal,0),currency,plan:PLAN_CATALOG[planId].name,planId,channelPacks,serverPacks,channels:choice.channels,servers:choice.servers,rules:choice.rules,complexConditions:choice.complexConditions,multiDestination:choice.multiDestination,items};
}
export async function customerSubscriptionSummaries(env,customer){
 if(!customer||!billingReady(env))return [];
 return (await subscriptions(env,customer)).map(subscription=>subscriptionSummary(subscription,env));
}
export async function subscriptionSummariesByCustomer(env,customers){
 const wanted=new Set((customers||[]).filter(Boolean));
 const grouped=new Map([...wanted].map(customer=>[customer,[]]));
 if(!wanted.size||!billingReady(env))return grouped;
 let startingAfter='';
 for(let page=0;page<5;page++){
  const suffix=startingAfter?`&starting_after=${encodeURIComponent(startingAfter)}`:'';
  const result=await stripe(env,`subscriptions?status=all&limit=100${suffix}`);
  for(const subscription of result.data||[]){
   if(['canceled','incomplete_expired'].includes(subscription.status))continue;
   const customer=typeof subscription.customer==='string'?subscription.customer:subscription.customer?.id;
   if(wanted.has(customer))grouped.get(customer).push(subscriptionSummary(subscription,env));
  }
  if(!result.has_more||!result.data?.length)break;
  startingAfter=result.data.at(-1).id;
 }
 return grouped;
}
export async function billingAction(request,env,db,uid,input={}){
 const action=new URL(request.url).pathname.split('/').pop();
 if(!billingReady(env))return json({message:'決済設定が完了していません。'},503);
 const account=await db.prepare('SELECT discord_user_id,billing_email FROM supporter_accounts WHERE discord_user_id=?').bind(uid).first();
 if(!account)return json({message:'先に登録してください。'},409);
 await db.prepare('INSERT INTO supporter_billing(discord_user_id) VALUES(?) ON CONFLICT DO NOTHING').bind(uid).run();
 let row=await db.prepare('SELECT * FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
 if(action==='status'){
  return json({mode:'test',billingDay:26,subscriptions:await customerSubscriptionSummaries(env,row.customer_id),credits:await customerCredits(env,row.customer_id),deliveryEnabled:false});
 }
 if(!row.customer_id){const customer=await createBillingCustomer(env,uid,account.billing_email,`dpi-customer-${uid}`);await db.prepare('UPDATE supporter_billing SET customer_id=? WHERE discord_user_id=? AND customer_id IS NULL').bind(customer.id,uid).run();row=await db.prepare('SELECT * FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();}
 else if(account.billing_email)await stripe(env,`customers/${encodeURIComponent(row.customer_id)}`,{email:account.billing_email},`dpi-customer-email-${uid}-${account.billing_email}`);
 const origin=env.SUPPORTER_PUBLIC_ORIGIN;
 if(!origin || !/^https:\/\/[^/]+$/.test(origin))fail('公開URLが未設定です。',503);
 if(action==='portal'){const portal=await stripe(env,'billing_portal/sessions',{customer:row.customer_id,configuration:env.STRIPE_PORTAL_CONFIG,return_url:`${origin}/site/supporter/`});return json({url:portal.url});}
 const choice=selection(input);
 const existing=await subscriptions(env,row.customer_id);
 if(action==='preview-update'){
  const current=activeSubscription(existing);
  if(!current)return json({message:'更新できる契約がありません。先にプランを申し込んでください。'},409);
  return json(await previewSubscriptionUpdate(env,row.customer_id,current,choice));
 }
 if(action==='update'){
  const requestId=String(input.requestId||'');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId))return json({message:'更新情報が正しくありません。再読み込みしてください。'},400);
  const prorationDate=Number(input.prorationDate);
  const now=Math.floor(Date.now()/1000);
  if(!Number.isInteger(prorationDate)||prorationDate>now+30||prorationDate<now-600)return json({message:'料金プレビューの有効期限が切れました。もう一度確認してください。'},409);
  const current=activeSubscription(existing);
  if(!current)return json({message:'更新できる契約がありません。先にプランを申し込んでください。'},409);
  await previewSubscriptionUpdate(env,row.customer_id,current,choice,prorationDate);
  await updateSubscription(env,current,choice,`dpi-user-update-${uid}-${requestId}`,{'metadata[dpi_updated_by]':'user'},prorationDate);
  return json({message:'プランと追加オプションを更新しました。基本プランの差額だけを日割りし、追加オプションは次回26日から反映します。',billingDay:26,subscriptions:await customerSubscriptionSummaries(env,row.customer_id),credits:await customerCredits(env,row.customer_id),deliveryEnabled:false});
 }
 if(action!=='checkout')return json({message:'Not found'},404);
 if(existing.length)return json({message:'契約が存在します。「プラン・オプションを更新」をご利用ください。'},409);
 const schedule=billingSchedule();
 // Persist exact parameters and key before network IO. Concurrent clicks share one session.
 const params={mode:'subscription',customer:row.customer_id,client_reference_id:uid,
  'subscription_data[metadata][dpi_user]':uid,'subscription_data[metadata][dpi_plan]':choice.plan,
  'subscription_data[metadata][dpi_channel_packs]':String(choice.channelPacks),'subscription_data[metadata][dpi_server_packs]':String(choice.serverPacks),
  'subscription_data[billing_mode][type]':'flexible','subscription_data[billing_cycle_anchor]':String(schedule.anchor),'subscription_data[proration_behavior]':'none',
  'line_items[0][price]':planPrice(env,choice.plan),'line_items[0][quantity]':'1',
  success_url:`${origin}/site/supporter/?checkout=returned`,cancel_url:`${origin}/site/supporter/?checkout=canceled`,expires_at:String(Math.floor(Date.now()/1000)+3600),integration_identifier:integrationIdentifier('dpi_paid_')};
 let line=1;
 const optionPacks=choice.channelPacks+choice.serverPacks;
 if(optionPacks){params[`line_items[${line}][price]`]=env.STRIPE_PRICE_ADDON;params[`line_items[${line}][quantity]`]=String(optionPacks);line+=1;}
 params[`line_items[${line}][price_data][currency]`]='jpy';
 params[`line_items[${line}][price_data][unit_amount]`]=String(choice.monthly*schedule.initialMonths);
 params[`line_items[${line}][price_data][product_data][name]`]=schedule.lateMonth?'初回利用料（当月分・翌月分の2か月分）':'初回利用料（当月分）';
 params[`line_items[${line}][quantity]`]='1';
 await db.prepare('UPDATE supporter_billing SET checkout_key=?,checkout_params=? WHERE discord_user_id=? AND checkout_key IS NULL').bind(crypto.randomUUID(),JSON.stringify(params),uid).run();
 row=await db.prepare('SELECT * FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
 const saved=JSON.parse(row.checkout_params);
 if(!row.checkout_id && Number(saved.expires_at)<Date.now()/1000)fail('決済作成の状態確認が必要です。管理者へお問い合わせください。',409);
 const checkout=row.checkout_id?await stripe(env,`checkout/sessions/${encodeURIComponent(row.checkout_id)}`):await stripe(env,'checkout/sessions',saved,`dpi-checkout-${row.checkout_key}`);
 await db.prepare('UPDATE supporter_billing SET checkout_id=? WHERE discord_user_id=? AND checkout_key=?').bind(checkout.id,uid,row.checkout_key).run();
 if(checkout.status==='expired'){await db.prepare('UPDATE supporter_billing SET checkout_key=NULL,checkout_id=NULL,checkout_params=NULL WHERE discord_user_id=? AND checkout_key=?').bind(uid,row.checkout_key).run();return json({message:'前の決済画面が期限切れです。再度お試しください。'},409);}
 if(checkout.status!=='open')return json({message:'決済結果を確認中です。契約状態を更新してください。'},409);
 if(saved['line_items[0][price]']!==params['line_items[0][price]']||saved['subscription_data[metadata][dpi_channel_packs]']!==params['subscription_data[metadata][dpi_channel_packs]']||saved['subscription_data[metadata][dpi_server_packs]']!==params['subscription_data[metadata][dpi_server_packs]'])return json({message:'別の条件で決済画面を作成済みです。期限切れ後に変更できます（最大1時間）。'},409);
 return json({url:checkout.url,mode:'test'});
}
function adminChoice(input){
 const plan=String(input.plan||'');
 const channelPacks=Number(input.channelPacks??input.packs);
 const serverPacks=Number(input.serverPacks??0);
 return selection({plan,channelPacks,serverPacks});
}
function activeSubscription(list){
 return list.find(item=>['active','trialing','past_due','unpaid','paused'].includes(item.status))||list[0];
}
async function previewSubscriptionUpdate(env,customer,current,choice,requestedProrationDate){
 const currentSummary=subscriptionSummary(current,env);
 const base=current.items?.data?.find(item=>item.price?.id!==env.STRIPE_PRICE_ADDON);
 if(!base?.id)fail('契約項目を確認できませんでした。',409);
 const prorationDate=Number.isInteger(requestedProrationDate)?requestedProrationDate:Math.floor(Date.now()/1000);
 let planProration=0;
 if(currentSummary.planId!==choice.plan){
  const invoice=await stripe(env,'invoices/create_preview',{
   customer,subscription:current.id,
   'subscription_details[items][0][id]':base.id,
   'subscription_details[items][0][price]':planPrice(env,choice.plan),
   'subscription_details[items][0][quantity]':'1',
   'subscription_details[proration_behavior]':'always_invoice',
   'subscription_details[proration_date]':String(prorationDate),
  });
  planProration=(invoice.lines?.data||[]).filter(line=>line.parent?.subscription_item_details?.proration===true||line.proration===true).reduce((sum,line)=>sum+Number(line.amount||0),0);
 }
 const credits=await customerCredits(env,customer);
 const creditApplied=Math.min(credits,Math.max(0,planProration));
 return {
  prorationDate,expiresAt:prorationDate+600,billingDay:26,
  current:{plan:currentSummary.plan,planId:currentSummary.planId,monthly:currentSummary.amount,channels:currentSummary.channels,servers:currentSummary.servers,rules:currentSummary.rules},
  next:{plan:PLAN_CATALOG[choice.plan].name,planId:choice.plan,monthly:choice.monthly,channels:choice.channels,servers:choice.servers,rules:choice.rules,complexConditions:choice.complexConditions,multiDestination:choice.multiDestination},
  monthlyDifference:choice.monthly-currentSummary.amount,
  planProration,creditApplied,immediateDue:Math.max(0,planProration-creditApplied),creditGenerated:Math.max(0,-planProration),
  optionChange:{currentChannelPacks:currentSummary.channelPacks,nextChannelPacks:choice.channelPacks,currentServerPacks:currentSummary.serverPacks,nextServerPacks:choice.serverPacks,prorated:false,effectiveAt:currentSummary.nextRenewalAt},
  nextRenewalAt:currentSummary.nextRenewalAt,
  notice:'追加オプションは日割り請求・日割り返金を行わず、次回26日の請求から月額へ反映します。',
 };
}
async function updateSubscription(env,current,choice,key,extra={},prorationDate){
 const base=current.items?.data?.find(item=>item.price?.id!==env.STRIPE_PRICE_ADDON);
 const addon=current.items?.data?.find(item=>item.price?.id===env.STRIPE_PRICE_ADDON);
 if(!base?.id)fail('契約項目を確認できませんでした。',409);
 const currentSummary=subscriptionSummary(current,env);
 const optionPacks=choice.channelPacks+choice.serverPacks;
 const currentOptionPacks=currentSummary.channelPacks+currentSummary.serverPacks;
 const baseChanged=currentSummary.planId!==choice.plan;
 const optionsChanged=currentOptionPacks!==optionPacks||currentSummary.channelPacks!==choice.channelPacks||currentSummary.serverPacks!==choice.serverPacks;
 const metadata={'metadata[dpi_plan]':choice.plan,'metadata[dpi_channel_packs]':String(choice.channelPacks),'metadata[dpi_server_packs]':String(choice.serverPacks),...extra};
 let result=current;
 if(baseChanged){
  const baseParams={'items[0][id]':base.id,'items[0][price]':planPrice(env,choice.plan),'items[0][quantity]':'1',proration_behavior:'always_invoice',payment_behavior:'pending_if_incomplete',proration_date:String(prorationDate||Math.floor(Date.now()/1000))};
  if(!optionsChanged)Object.assign(baseParams,metadata);
  result=await stripe(env,`subscriptions/${encodeURIComponent(current.id)}`,baseParams,`${key}-base`);
 }
 if(optionsChanged){
  const optionParams={proration_behavior:'none',payment_behavior:'pending_if_incomplete',...metadata};
  if(addon){optionParams['items[0][id]']=addon.id;if(optionPacks)optionParams['items[0][quantity]']=String(optionPacks);else optionParams['items[0][deleted]']='true';}
  else if(optionPacks){optionParams['items[0][price]']=env.STRIPE_PRICE_ADDON;optionParams['items[0][quantity]']=String(optionPacks);}
  result=await stripe(env,`subscriptions/${encodeURIComponent(current.id)}`,optionParams,`${key}-options`);
 } else if(!baseChanged){
  result=await stripe(env,`subscriptions/${encodeURIComponent(current.id)}`,{proration_behavior:'none',...metadata},`${key}-metadata`);
 }
 return result;
}
function actionOrigin(env){
 const origin=env.SUPPORTER_PUBLIC_ORIGIN;
 if(!origin||!/^https:\/\/[^/]+$/.test(origin))fail('公開URLが未設定です。',503);
 return origin;
}
export async function adminBillingAction(env,customer,uid,input){
 if(!billingReady(env))fail('決済設定が完了していません。',503);
 if(!customer)fail('このユーザーにはStripe顧客情報がありません。',409);
 const action=String(input?.action||'');
 const requestId=String(input?.requestId||'');
 const reason=String(input?.reason||'').trim();
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)||reason.length<5||reason.length>500)fail('操作理由を5〜500文字で入力してください。',400);
 const key=`dpi-admin-${action}-${requestId}`;
 if(action==='grant_credit'||action==='remove_credit'){
  const amount=Number(input.amount);
  if(!Number.isInteger(amount)||amount<1||amount>1_000_000)fail('クレジット数を1〜1,000,000で指定してください。',400);
  const current=await customerCredits(env,customer);
  if(action==='remove_credit'&&amount>current)fail('利用可能クレジットを超えて削除できません。',409);
  const delta=action==='grant_credit'?amount:-amount;
  const transaction=await stripe(env,`customers/${encodeURIComponent(customer)}/balance_transactions`,{
   amount:String(-delta),currency:'jpy',description:`DPI-Bot ${action==='grant_credit'?'credit grant':'credit removal'}: ${reason}`,
   'metadata[dpi_user]':uid,'metadata[dpi_credit_action]':action,'metadata[dpi_admin_reason]':reason,
  },key);
  const balanceAfter=creditsFromBalance(transaction.ending_balance);
  return {message:`${amount.toLocaleString('ja-JP')}クレジットを${action==='grant_credit'?'付与':'削除'}しました。`,credits:balanceAfter,creditEvent:{delta,balanceAfter,stripeTransactionId:transaction.id}};
 }
 const list=await subscriptions(env,customer);
 const current=activeSubscription(list);
 if(action==='cancel_at_period_end'){
  if(!current)fail('変更できる契約がありません。',409);
  await stripe(env,`subscriptions/${encodeURIComponent(current.id)}`,{cancel_at_period_end:'true','metadata[dpi_admin_reason]':reason},key);
  return {message:'期間末での契約終了を予約しました。',subscriptions:await customerSubscriptionSummaries(env,customer)};
 }
 if(action==='cancel_immediately'){
  if(!current)fail('終了できる契約がありません。',409);
  await stripe(env,`subscriptions/${encodeURIComponent(current.id)}`,null,key,'DELETE');
  return {message:'契約を即時終了しました。',subscriptions:await customerSubscriptionSummaries(env,customer)};
 }
 if(action==='change_subscription'){
  if(!current)fail('変更できる契約がありません。',409);
  const choice=adminChoice(input);
  await updateSubscription(env,current,choice,key,{'metadata[dpi_admin_reason]':reason,'metadata[dpi_updated_by]':'admin'});
  return {message:'契約内容を変更しました。基本プランだけ日割りし、追加オプションは日割りせず次回26日から反映します。',subscriptions:await customerSubscriptionSummaries(env,customer)};
 }
 if(action==='refund_latest'){
  const amount=Number(input.amount);
  if(!Number.isInteger(amount)||amount<1||amount>1_000_000)fail('返金額を1〜1,000,000円で指定してください。',400);
  const invoices=(await stripe(env,`invoices?customer=${encodeURIComponent(customer)}&status=paid&limit=10&expand[]=data.payments`)).data||[];
  const invoice=invoices.find(item=>Number(item.amount_paid)>=amount&&(item.payments?.data||[]).some(payment=>payment.payment?.payment_intent));
  if(!invoice)fail('返金可能な支払いを確認できませんでした。',409);
  const paymentIntent=invoice.payments.data.find(payment=>payment.payment?.payment_intent).payment.payment_intent;
  const params={amount:String(amount),reason:'requested_by_customer','metadata[dpi_user]':uid,'metadata[dpi_admin_reason]':reason};
  params.payment_intent=typeof paymentIntent==='string'?paymentIntent:paymentIntent.id;
  const refund=await stripe(env,'refunds',params,key);
  return {message:`${amount.toLocaleString('ja-JP')}円の返金を受け付けました。`,refund:{status:refund.status||'pending',amount:Number(refund.amount||amount),currency:refund.currency||'jpy'}};
 }
 if(action==='create_payment_link'){
  const amount=Number(input.amount);
  const description=String(input.description||'').trim();
  if(!Number.isInteger(amount)||amount<100||amount>1_000_000||description.length<2||description.length>80)fail('支払い内容と100〜1,000,000円の金額を確認してください。',400);
  const origin=actionOrigin(env);
  const checkout=await stripe(env,'checkout/sessions',{mode:'payment',customer,client_reference_id:uid,'line_items[0][price_data][currency]':'jpy','line_items[0][price_data][unit_amount]':String(amount),'line_items[0][price_data][product_data][name]':description,'line_items[0][quantity]':'1','metadata[dpi_user]':uid,'metadata[dpi_admin_reason]':reason,success_url:`${origin}/site/supporter/?payment=completed`,cancel_url:`${origin}/site/supporter/?payment=canceled`,expires_at:String(Math.floor(Date.now()/1000)+86400),integration_identifier:integrationIdentifier('dpi_admin_')},key);
  return {message:'24時間有効の支払いURLを作成しました。',url:checkout.url,expiresAt:checkout.expires_at||null};
 }
 fail('管理操作を確認してください。',400);
}
export async function verifySignature(raw,header,secret,now=Date.now()){
 const parts=(header||'').split(',').map(p=>p.trim().split('='));const ts=parts.find(p=>p[0]==='t')?.[1];
 if(!secret||!/^\d+$/.test(ts||'')||Math.abs(now/1000-Number(ts))>300)return false;
 const enc=new TextEncoder();const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
 for(const [,sig] of parts.filter(p=>p[0]==='v1'&&/^[0-9a-f]{64}$/.test(p[1]||''))){const bytes=Uint8Array.from(sig.match(/../g),h=>parseInt(h,16));if(await crypto.subtle.verify('HMAC',key,bytes,enc.encode(`${ts}.${raw}`)))return true;}
 return false;
}
export async function billingWebhook(request,env){
 if(request.method!=='POST')return json({message:'Method not allowed'},405);
 if(!billingReady(env))return json({message:'Unavailable'},503);
 const reader=request.body?.getReader();if(!reader)return json({},400);const chunks=[];let size=0;while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>262144){await reader.cancel();return json({},413);}chunks.push(value);}const bytes=new Uint8Array(size);let at=0;for(const c of chunks){bytes.set(c,at);at+=c.length;}const raw=new TextDecoder().decode(bytes);
 if(!await verifySignature(raw,request.headers.get('stripe-signature'),env.STRIPE_WEBHOOK_SECRET))return json({},400);
 let event;try{event=JSON.parse(raw);}catch{return json({},400);}
 if(event.livemode!==false||typeof event.id!=='string')return json({},400);
 const allowed=['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed','checkout.session.expired','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','invoice.paid','invoice.payment_failed','charge.refunded','charge.dispute.created','radar.early_fraud_warning.created'];
 if(!allowed.includes(event.type))return json({received:true});
 const db=env.REUSE_DB||env.NEWSLETTER_DB;
 // Events invalidate a cache only; status always comes from Stripe, never from stale event payloads.
 await db.batch([db.prepare('INSERT INTO supporter_stripe_events(id,received_at) VALUES(?,?) ON CONFLICT DO NOTHING').bind(event.id,Date.now()),db.prepare('UPDATE supporter_billing SET dirty=1 WHERE customer_id=?').bind(event.data?.object?.customer||'')]);
 return json({received:true});
}
