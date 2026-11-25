// 2026年11月25日の夜だけの案内。26日0時30分（日本時間）を過ぎたら表示しない。
export const LAUNCH_NOTICE_UNTIL=Date.UTC(2026,10,25,15,30);
export function showLaunchNotice(doc=document,now=Date.now()){
 const visible=now<LAUNCH_NOTICE_UNTIL;
 for(const item of doc.querySelectorAll('[data-launch-notice]'))item.hidden=!visible;
 return visible;
}
if(typeof document!=='undefined'&&showLaunchNotice()){
 const timer=setInterval(()=>{if(!showLaunchNotice())clearInterval(timer);},15000);
}
