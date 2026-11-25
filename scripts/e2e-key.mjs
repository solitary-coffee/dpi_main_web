// 通し試験用のテストキーを、この PC の DPAPI で保護されたファイルから読む（値は表示しない）。
// 登録はデスクトップの「stripe試験キー登録.ps1」。STRIPE_E2E_KEY があればそれを使う。本番キーは受け付けない。
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// STRIPE_E2E_PROXY（この PC の中継。キーは中継の先の Worker Secrets が持つ）があれば、Stripe への通信をすべて中継へ向ける。
// 中継はテストキー以外では動かない。手元ではキーの値を持たない。
function installProxy(base) {
 const target = new URL(base);
 if (!['127.0.0.1', 'localhost'].includes(target.hostname)) throw new Error('中継はこの PC のものだけを使えます。');
 const token = String(process.env.STRIPE_E2E_PROXY_TOKEN || '');
 const original = globalThis.fetch;
 globalThis.fetch = (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url ?? input.href);
  if (url.hostname !== 'api.stripe.com') return original(input, init);
  const headers = new Headers(init.headers); headers.delete('authorization'); headers.set('x-e2e-token', token);
  return original(`${target.origin}${url.pathname}${url.search}`, {...init, headers, signal: AbortSignal.timeout(90000)});
 };
}
export function e2eKey() {
 if (process.env.STRIPE_E2E_PROXY) { installProxy(process.env.STRIPE_E2E_PROXY); return 'sk_test_viaproxy'; }
 let key = String(process.env.STRIPE_E2E_KEY || '').trim();
 if (!key) {
  const file = path.join(process.env.LOCALAPPDATA || '', 'dpi-bot', 'stripe-e2e-test-key.txt');
  const script = '$s=Get-Content -Raw $env:DPI_E2E_KEY_FILE | ForEach-Object { $_.Trim() } | ConvertTo-SecureString; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)); [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)';
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {encoding: 'utf8', env: {...process.env, DPI_E2E_KEY_FILE: file}});
  if (result.status !== 0) throw new Error('通し試験用のキーを読めませんでした。先に登録してください。');
  key = result.stdout.trim();
 }
 if (!/^(?:sk|rk)_test_[A-Za-z0-9]+$/.test(key)) throw new Error('通し試験にはテストキー（sk_test_ / rk_test_）だけを使えます。');
 return key;
}
