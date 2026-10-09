# IPアドレス遮断機構

Cloudflare Workerが静的ページ・APIを含む全リクエストを最初に確認し、`BLOCKED_IPS` に一致した接続元へ標準の `403 Forbidden` を返します。

D1の `ip_block_rules` に登録されたルールも同時に評価します。D1ルールはCloudflare Accessで保護された `/site/ip-admin/` から追加・削除・確認でき、最大約30秒で各Workerへ反映されます。

- ブラウザ: 説明、接続元IP、Cloudflare Ray ID、判定時刻を含むDPI-Bot専用画面
- API: `code: "ip_blocked"` を含むJSON
- 対応形式: IPv4、IPv6、IPv4/IPv6 CIDR
- 判定元: Cloudflareが付与する `CF-Connecting-IP` のみ（偽装可能な `X-Forwarded-For` は使用しません）
- キャッシュ: `no-store`

## 遮断IPの登録

IPアドレスはリポジトリへ記録せず、Worker Secretとして登録します。

```bash
npx wrangler secret put BLOCKED_IPS
```

入力例です。カンマまたは改行で複数登録できます。`|` 以降は、そのIPに表示する任意の説明です。

```text
203.0.113.10|不正なアクセスが確認されたため制限しています。
198.51.100.0/24|継続的な自動アクセスが確認されたため制限しています。
2001:db8::/32
```

共通説明を変更する場合は、次のSecretも登録します。各IPに個別説明がある場合は個別説明が優先されます。

```bash
npx wrangler secret put IP_BLOCK_MESSAGE
```

## 更新・解除

`BLOCKED_IPS` は追記方式ではなく、入力した内容で全体が置き換わります。既存の一覧を含めた完全な値を入力してください。

全遮断を解除する場合:

```bash
npx wrangler secret delete BLOCKED_IPS
```

反映後は、対象IPとは別の回線から通常表示を確認し、対象IPからHTTP 403と専用画面が返ることを確認してください。

## 適用範囲

`assets.run_worker_first` を `true` にしているため、このWorkerへ割り当てたすべてのカスタムドメイン、静的ファイル、APIが対象です。別のWorkerやCloudflare外のオリジンへ直接割り当てたドメインには、この設定は自動では適用されません。
