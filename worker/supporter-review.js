// 有料プラン画面の審査用アクセス（決済サービスの審査担当者向け）。
// SUPPORTER_REVIEW_USER と SUPPORTER_REVIEW_PASSWORD（Worker Secrets）が両方設定されているときだけ有効。
// 画面をユーザー名・パスワード（HTTP Basic 認証）で開けるようにし、認証に成功したブラウザには
// 署名付き Cookie を発行して、その有効期間中はサポーター API の許可リスト判定も通す
// （Discord ログイン自体は従来どおり必要）。未設定なら従来どおり一律 404。

const COOKIE_NAME = '__Host-dpi_supporter_review';
const COOKIE_SECONDS = 12 * 60 * 60;
const REALM = 'DPI-Bot supporter review';
const encoder = new TextEncoder();

const clean = value => String(value ?? '').trim();

export function reviewAccessConfigured(env) {
 return clean(env.SUPPORTER_REVIEW_USER).length > 0 && clean(env.SUPPORTER_REVIEW_PASSWORD).length >= 12;
}

async function hmacHex(env, message) {
 const key = await crypto.subtle.importKey('raw', encoder.encode(`dpi-supporter-review:${clean(env.SUPPORTER_REVIEW_USER)}:${clean(env.SUPPORTER_REVIEW_PASSWORD)}`),
  {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
 const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
 return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// 長さの違いも含めて比較時間を一定にするため、両方の SHA-256 を比べる。
async function sameText(left, right) {
 const [a, b] = await Promise.all([left, right].map(text => crypto.subtle.digest('SHA-256', encoder.encode(String(text)))));
 const x = new Uint8Array(a), y = new Uint8Array(b);
 let diff = 0;
 for (let i = 0; i < x.length; i += 1) diff |= x[i] ^ y[i];
 return diff === 0;
}

function decodeBasic(request) {
 const header = request.headers.get('Authorization') || '';
 const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
 if (!match) return null;
 try {
  const bytes = Uint8Array.from(atob(match[1]), char => char.charCodeAt(0));
  const text = new TextDecoder().decode(bytes);
  const index = text.indexOf(':');
  return index < 0 ? null : {user: text.slice(0, index), password: text.slice(index + 1)};
 } catch {
  return null;
 }
}

export async function basicCredentialsValid(request, env) {
 if (!reviewAccessConfigured(env)) return false;
 const given = decodeBasic(request);
 if (!given) return false;
 const [userOk, passwordOk] = await Promise.all([
  sameText(given.user, clean(env.SUPPORTER_REVIEW_USER)),
  sameText(given.password, clean(env.SUPPORTER_REVIEW_PASSWORD)),
 ]);
 return userOk && passwordOk;
}

function readCookie(request, name) {
 for (const part of (request.headers.get('Cookie') || '').split(';')) {
  const index = part.indexOf('=');
  if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
 }
 return '';
}

export async function reviewCookie(env, now = Date.now()) {
 const expires = Math.floor(now / 1000) + COOKIE_SECONDS;
 const value = `${expires}.${await hmacHex(env, String(expires))}`;
 return `${COOKIE_NAME}=${value}; Max-Age=${COOKIE_SECONDS}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

export async function reviewCookieValid(request, env, now = Date.now()) {
 if (!reviewAccessConfigured(env)) return false;
 const raw = readCookie(request, COOKIE_NAME);
 const match = /^(\d{9,12})\.([0-9a-f]{64})$/.exec(raw);
 if (!match) return false;
 const expires = Number(match[1]);
 if (!(expires * 1000 > now) || expires * 1000 > now + (COOKIE_SECONDS + 60) * 1000) return false;
 return sameText(match[2], await hmacHex(env, match[1]));
}

export function reviewChallenge() {
 return new Response('ユーザー名とパスワードを入力してください。', {
  status: 401,
  headers: {
   'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
   'Cache-Control': 'no-store',
   'Content-Type': 'text/plain; charset=utf-8',
   'X-Content-Type-Options': 'nosniff',
   'X-Robots-Tag': 'noindex, nofollow, noarchive',
  },
 });
}
