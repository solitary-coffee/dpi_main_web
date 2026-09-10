// Development-only bridge to the isolated AWS subscription portal.
const PREFIX = '/api/subscriptions-dev';
const METHODS = new Map([
  ['/auth/login', ['GET']], ['/auth/callback', ['GET']],
  ['/api/me', ['GET']], ['/api/logout', ['POST']], ['/api/guilds', ['GET']],
  ['/api/channels', ['GET']], ['/api/checkout', ['POST']],
  ['/api/subscriptions/refresh', ['POST']], ['/api/subscriptions/cancel', ['POST']],
  ['/api/settings', ['GET', 'PUT', 'DELETE']], ['/api/delivery-config', ['PUT']],
  ['/api/admin/subscriptions', ['GET']], ['/api/admin/link', ['POST']], ['/api/admin/unlink', ['POST']],
]);
const PAGE = '/site/subscriptions/';
function json(body, status=200) {
  return new Response(JSON.stringify(body), {status, headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
}
function configured(env, requestOrigin) {
  if (env.SUBSCRIPTIONS_DEV_ENABLED !== 'true' || env.SUBSCRIPTIONS_DEV_PUBLIC_ORIGIN !== requestOrigin) return null;
  try {
    const url = new URL(env.SUBSCRIPTIONS_DEV_API_ORIGIN);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash ||
        !/^[a-z0-9]+\.execute-api\.ap-northeast-[13]\.amazonaws\.com$/.test(url.hostname)) return null;
    return url.origin;
  } catch { return null; }
}
function portalRedirect(url) {
  return new Response(null,{status:302,headers:{Location:url,'Cache-Control':'no-store'}});
}
export async function handleSubscriptionsRequest(request, env) {
  const url = new URL(request.url);
  // AWS build uses the root callback / return URL. Only these explicit return paths are claimed.
  if (url.pathname === '/' && ['success','cancel'].includes(url.searchParams.get('checkout'))) {
    return portalRedirect(PAGE + '?checkout=' + url.searchParams.get('checkout'));
  }
  // The existing opt-in Bot accepts an origin URL. On the explicitly configured
  // development host only, its root opens the portal; normal site hosts are unchanged.
  if (url.pathname === '/' && configured(env, url.origin)) return portalRedirect(PAGE);
  const callback = url.pathname === '/auth/callback';
  if (!callback && url.pathname !== PREFIX && !url.pathname.startsWith(PREFIX + '/')) return null;
  const upstream = configured(env, url.origin);
  if (url.pathname === PREFIX + '/config' && request.method === 'GET') return json({configured:!!upstream, environment:'dev'});
  if (!upstream) return json({error:'開発用サブスク管理は準備中です。接続設定が完了していません。'},503);
  let targetPath;
  if(callback) targetPath='/auth/callback';
  else if(url.pathname === PREFIX+'/auth/login') targetPath='/auth/login';
  else targetPath='/api'+url.pathname.slice(PREFIX.length);
  const methods=METHODS.get(targetPath);
  if(!methods) return json({error:'ページが見つかりません'},404);
  if(!methods.includes(request.method)) return json({error:'許可されていない操作です'},405);
  if(request.method !== 'GET' && request.headers.get('origin') !== url.origin) return json({error:'リクエスト元が一致しません'},403);
  // Never forward site-wide credentials or arbitrary headers to AWS.
  const headers=new Headers();
  for(const name of ['origin','content-type','x-csrf-token']) {
    const value=request.headers.get(name);if(value)headers.set(name,value);
  }
  const cookies=(request.headers.get('cookie')||'').split(';').map(s=>s.trim()).filter(s=>/^dpi_(session|oauth)=/.test(s));
  if(cookies.length)headers.set('cookie',cookies.join('; '));
  let body;
  if(request.method !== 'GET') {
    // Limit the actual streamed body, not only Content-Length.
    const reader=request.body?.getReader(); const chunks=[];let size=0;
    if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();return json({error:'送信データが大きすぎます'},413);}chunks.push(value);}
    body=new Uint8Array(size);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
  }
  try {
    const response=await fetch(upstream+targetPath+url.search,{method:request.method,headers,body,redirect:'manual',signal:AbortSignal.timeout(28000)});
    const out=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
    if(response.headers.has('content-type'))out.set('Content-Type',response.headers.get('content-type'));
    for(const cookie of response.headers.getSetCookie()) {
      if(/^dpi_(session|oauth)=/.test(cookie))out.append('Set-Cookie',cookie);
    }
    const location=response.headers.get('location');
    if(location) {
      if(location==='/')out.set('Location',PAGE);
      else {
        const destination=new URL(location,upstream);
        if(targetPath!=='/auth/login' || destination.origin!=='https://discord.com' || destination.pathname!=='/oauth2/authorize') return json({error:'ログイン先の設定が不正です'},502);
        if(destination.searchParams.get('redirect_uri')!==url.origin+'/auth/callback')return json({error:'AWSのorigin設定を開発用サイトのURLに合わせてください'},503);
        out.set('Location',destination.href);
      }
    }
    return new Response(response.body,{status:response.status,headers:out});
  } catch { return json({error:'開発用サブスクAPIに接続できません。時間をおいて再試行してください'},502); }
}
