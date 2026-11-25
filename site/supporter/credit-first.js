export function creditFirstPayment(initialAmount,balance,balanceLoaded=true){
 const total=Math.max(0,Number(initialAmount)||0);
 const credits=Math.max(0,Number(balance)||0);
 if(!balanceLoaded)return {state:'checking',creditApplied:0,cardCharge:total,remainingCredits:credits,topupNeeded:total};
 if(credits<=0)return {state:'card',creditApplied:0,cardCharge:total,remainingCredits:0,topupNeeded:total};
 if(credits>=total)return {state:'credits',creditApplied:total,cardCharge:0,remainingCredits:credits-total,topupNeeded:0};
 let creditApplied=credits;
 if(total-creditApplied<50)creditApplied=total-50;
 if(creditApplied<=0)creditApplied=0;
 return {state:creditApplied>0?'split':'card',creditApplied,cardCharge:total-creditApplied,remainingCredits:credits-creditApplied,topupNeeded:total-credits};
}
