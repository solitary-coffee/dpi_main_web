// Test-only integration. Live keys are deliberately rejected until delivery is ready.
const json = (data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
export function billingReady(env){return env.SUPPORTER_BILLING_MODE==='test' && /^(?:sk|rk)_test_/.test(env.STRIPE_SECRET_KEY||'') && !!env.STRIPE_WEBHOOK_SECRET && !!env.STRIPE_PRICE_SUPPORTER && !!env.STRIPE_PRICE_PLUS && !!env.STRIPE_PRICE_ADDON && !!env.STRIPE_PORTAL_CONFIG;}
async function stripe(env,path,params,key){
 if(!billingReady(env)) fail('テスト決済の設定が完了していません。',503);
 const headers={Authorization:`Bearer ${env.STRIPE_SECRET_KEY}`,'Stripe-Version':'2025-06-30.basil'};
 if(key)headers['Idempotency-Key']=key;
 if(params)headers['Content-Type']='application/x-www-form-urlencoded';
 const r=await fetch(`https://api.stripe.com/v1/${path}`,{method:params?'POST':'GET',headers,body:params?new URLSearchParams(params):undefined,signal:AbortSignal.timeout(15000)});
 const result=await r.json();if(!r.ok)fail('Stripeへの接続に失敗しました。時間をおいて再試行してください。',502);
 if(result.livemode===true)fail('本番決済は無効です。',503);
 return result;
}
export function selection(input){
 if(!['supporter','plus'].includes(input.plan)||!Number.isInteger(input.packs)||input.packs<0||input.packs>2||(input.plan==='plus'&&input.packs!==0))fail('プランまたは追加パック数が不正です。');
 return {plan:input.plan,packs:input.packs,monthly:input.plan==='plus'?800:300+200*input.packs,channels:input.plan==='plus'?10:2+3*input.packs};
}
async function subscriptions(env,customer){return (await stripe(env,`subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=100`)).data.filter(s=>!['canceled','incomplete_expired'].includes(s.status));}
export async function billingAction(request,env,db,uid,input={}){
 const action=new URL(request.url).pathname.split('/').pop();
 if(!billingReady(env))return json({message:'テスト決済の設定が完了していません。'},503);
 if(!await db.prepare('SELECT discord_user_id FROM supporter_accounts WHERE discord_user_id=?').bind(uid).first())return json({message:'先に登録してください。'},409);
 await db.prepare('INSERT INTO supporter_billing(discord_user_id) VALUES(?) ON CONFLICT DO NOTHING').bind(uid).run();
 let row=await db.prepare('SELECT * FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
 if(action==='status'){
  const subs=row.customer_id?await subscriptions(env,row.customer_id):[];
  return json({mode:'test',subscriptions:subs.map(s=>({status:s.status,cancelAtPeriodEnd:s.cancel_at_period_end,items:s.items.data.map(i=>({price:i.price.id,quantity:i.quantity,periodEnd:i.current_period_end}))})),deliveryEnabled:false});
 }
 if(!row.customer_id){const customer=await stripe(env,'customers',{'metadata[dpi_user]':uid},`dpi-customer-${uid}`);await db.prepare('UPDATE supporter_billing SET customer_id=? WHERE discord_user_id=? AND customer_id IS NULL').bind(customer.id,uid).run();row=await db.prepare('SELECT * FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();}
 const origin=env.SUPPORTER_PUBLIC_ORIGIN;
 if(!origin || !/^https:\/\/[^/]+$/.test(origin))fail('公開URLが未設定です。',503);
 if(action==='portal'){const portal=await stripe(env,'billing_portal/sessions',{customer:row.customer_id,configuration:env.STRIPE_PORTAL_CONFIG,return_url:`${origin}/site/supporter/`});return json({url:portal.url});}
 if(action!=='checkout')return json({message:'Not found'},404);
 const choice=selection(input);
 if((await subscriptions(env,row.customer_id)).length)return json({message:'契約が存在します。契約管理画面をご利用ください。'},409);
 // Persist exact parameters and key before network IO. Concurrent clicks share one session.
 const params={mode:'subscription',customer:row.customer_id,client_reference_id:uid,'subscription_data[metadata][dpi_user]':uid,'subscription_data[billing_mode][type]':'flexible','line_items[0][price]':choice.plan==='plus'?env.STRIPE_PRICE_PLUS:env.STRIPE_PRICE_SUPPORTER,'line_items[0][quantity]':'1',success_url:`${origin}/site/supporter/?checkout=returned`,cancel_url:`${origin}/site/supporter/?checkout=canceled`,expires_at:String(Math.floor(Date.now()/1000)+3600),'payment_method_types[0]':'card'};
 if(choice.packs){params['line_items[1][price]']=env.STRIPE_PRICE_ADDON;params['line_items[1][quantity]']=String(choice.packs);}
 await db.prepare('UPDATE supporter_billing SET checkout_key=?,checkout_params=? WHERE discord_user_id=? AND checkout_key IS NULL').bind(crypto.randomUUID(),JSON.stringify(params),uid).run();
 row=await db.prepare('SELECT * FROM supporter_billing WHERE discord_user_id=?').bind(uid).first();
 const saved=JSON.parse(row.checkout_params);
 if(!row.checkout_id && Number(saved.expires_at)<Date.now()/1000)fail('決済作成の状態確認が必要です。管理者へお問い合わせください。',409);
 const checkout=row.checkout_id?await stripe(env,`checkout/sessions/${encodeURIComponent(row.checkout_id)}`):await stripe(env,'checkout/sessions',saved,`dpi-checkout-${row.checkout_key}`);
 await db.prepare('UPDATE supporter_billing SET checkout_id=? WHERE discord_user_id=? AND checkout_key=?').bind(checkout.id,uid,row.checkout_key).run();
 if(checkout.status==='expired'){await db.prepare('UPDATE supporter_billing SET checkout_key=NULL,checkout_id=NULL,checkout_params=NULL WHERE discord_user_id=? AND checkout_key=?').bind(uid,row.checkout_key).run();return json({message:'前の決済画面が期限切れです。再度お試しください。'},409);}
 if(checkout.status!=='open')return json({message:'決済結果を確認中です。契約状態を更新してください。'},409);
 if(saved['line_items[0][price]']!==params['line_items[0][price]']||(saved['line_items[1][quantity]']||'0')!==(params['line_items[1][quantity]']||'0'))return json({message:'別の条件で決済画面を作成済みです。期限切れ後に変更できます（最大1時間）。'},409);
 return json({url:checkout.url,mode:'test'});
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
 const allowed=['checkout.session.completed','checkout.session.expired','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','invoice.paid','invoice.payment_failed'];
 if(!allowed.includes(event.type))return json({received:true});
 const db=env.REUSE_DB||env.NEWSLETTER_DB;
 // Events invalidate a cache only; status always comes from Stripe, never from stale event payloads.
 await db.batch([db.prepare('INSERT INTO supporter_stripe_events(id,received_at) VALUES(?,?) ON CONFLICT DO NOTHING').bind(event.id,Date.now()),db.prepare('UPDATE supporter_billing SET dirty=1 WHERE customer_id=?').bind(event.data?.object?.customer||'')]);
 return json({received:true});
}
