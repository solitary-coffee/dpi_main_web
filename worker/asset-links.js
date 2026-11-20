// Android アプリ「DPI 操作盤」（TWA）用の Digital Asset Links。
// /.well-known/ は .assetsignore で静的配信から外れるため、Worker から直接返します。
// 中身は docs/control-deck-apk/assetlinks.json と同じにすること（テストで一致を確認）。
export const ASSET_LINKS = Object.freeze([
    {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
            namespace: 'android_app',
            package_name: 'com.dpibot.controldeck',
            sha256_cert_fingerprints: [
                '8B:73:37:1A:E3:E0:CC:F5:F7:CC:F3:47:AC:80:4C:D7:12:F1:88:3C:FE:8F:5A:89:FC:99:BA:93:01:EA:59:A6',
            ],
        },
    },
]);

export function handleAssetLinksRequest(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/.well-known/assetlinks.json') return null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const body = request.method === 'HEAD' ? null : JSON.stringify(ASSET_LINKS);
    return new Response(body, {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
            'Access-Control-Allow-Origin': '*',
        },
    });
}
