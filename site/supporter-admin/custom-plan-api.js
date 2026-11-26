export function customPlanEstimate(payload){
 const has=name=>payload.features.includes(name);
 const base=has('complexConditions')||has('strictMunicipality')?1280:has('municipalityScope')||payload.channels>2||payload.servers>1||payload.rules>5?800:300;
 const defaults=base===1280?[20,5,30]:base===800?[10,3,15]:[2,1,5];
 return base+Math.ceil(Math.max(0,payload.channels-defaults[0])/3)*200+Math.max(0,payload.servers-defaults[1])*200+Math.ceil(Math.max(0,payload.rules-defaults[2])/5)*100+(payload.secondaryReuse?200:0);
}

export function customPlanValidationError(payload,missingFeatureDependency,featureLabel){
 if(!/^\d{17,20}$/.test(payload.discordUserId)||payload.confirmDiscordUserId!==payload.discordUserId)return 'Discord IDと確認欄を一致させてください。';
 if(payload.reason.length<5)return '理由を5文字以上入力してください。';
 const missing=missingFeatureDependency(payload.features);
 return missing?`「${featureLabel(missing.name)}」には「${missing.requires.map(featureLabel).join('」または「')}」も必要です。`:'';
}

export async function sendCustomPlan(body,fetchImpl=fetch){
 const response=await fetchImpl('/site/supporter-admin/api/custom-plan',{
  method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body),
 });
 const data=await response.json().catch(()=>({}));
 if(!response.ok||!data.success)throw new Error(data.message||`HTTP ${response.status}`);
 return data;
}

export function activeCustomPlanConfirmation(quote){
 return `カスタムプラン契約変更内容を確認してください。

現在月額：${quote.oldMonthlyYen.toLocaleString('ja-JP')}円
変更後月額：${quote.newMonthlyYen.toLocaleString('ja-JP')}円
当月の追加請求：${quote.immediateDueYen.toLocaleString('ja-JP')}円${quote.noImmediateRefund?'（減額分の返金なし）':''}
次回以降の月額：${quote.nextMonthlyYen.toLocaleString('ja-JP')}円

${quote.immediateDueYen>0?'増額は差額の支払い確認後に適用します。':'追加決済なしで更新します。'}
よろしいですか？`;
}

export function newCustomPlanConfirmation(payload){
 return `このユーザーに新しくカスタムプランを設定します。

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
}

export function stripeCheckoutUrl(value){
 let url;
 try{url=new URL(typeof value==='string'?value:'');}catch{throw new Error('Stripeの支払いURLを確認できませんでした。');}
 if(url.protocol!=='https:'||url.hostname!=='checkout.stripe.com')throw new Error('Stripeの支払いURLを確認できませんでした。');
 return url.href;
}
