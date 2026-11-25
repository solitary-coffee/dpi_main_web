// 通し試験用のテストキーを、この PC の DPAPI で保護されたファイルから読む（値は表示しない）。
// 登録はデスクトップの「stripe試験キー登録.ps1」。STRIPE_E2E_KEY があればそれを使う。本番キーは受け付けない。
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export function e2eKey() {
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
