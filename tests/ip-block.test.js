import test from 'node:test';
import assert from 'node:assert/strict';
import { blockResponseForRequest, __test } from '../worker/ip-block.js';

function request(path = '/', ip = '203.0.113.10', headers = {}) {
    return new Request(`https://dpi-bot.com${path}`, {
        headers: { 'cf-connecting-ip': ip, ...headers },
    });
}

test('設定が空の場合は遮断しない', () => {
    assert.equal(blockResponseForRequest(request(), {}), null);
});

test('IPv4完全一致を403のカスタムHTMLで遮断する', async () => {
    const response = blockResponseForRequest(request('/', '203.0.113.10', { 'cf-ray': 'ray-test' }), {
        BLOCKED_IPS: '203.0.113.10|不正なアクセスが確認されたため制限しています。',
    });

    assert.equal(response.status, 403);
    assert.match(response.headers.get('content-type'), /^text\/html/);
    assert.equal(response.headers.get('cache-control'), 'private, no-store, max-age=0');
    const body = await response.text();
    assert.match(body, /HTTP 403 Forbidden/);
    assert.match(body, /不正なアクセスが確認されたため/);
    assert.match(body, /ray-test/);
});

test('APIは403のカスタムJSONを返す', async () => {
    const response = blockResponseForRequest(request('/api/contact'), {
        BLOCKED_IPS: '203.0.113.10',
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
        success: false,
        status: 403,
        code: 'ip_blocked',
        message: 'サイトの安全な運用のため、この接続元からのアクセスを制限しています。',
        rayId: '取得できませんでした',
    });
});

test('IPv4 CIDRの内側だけを遮断する', () => {
    const rules = '198.51.100.0/24';
    assert.ok(__test.findMatchingRule('198.51.100.255', rules));
    assert.equal(__test.findMatchingRule('198.51.101.1', rules), null);
});

test('IPv6完全一致とCIDRに対応する', () => {
    assert.ok(__test.findMatchingRule('2001:db8::1', '2001:0db8:0:0:0:0:0:1'));
    assert.ok(__test.findMatchingRule('2001:db8:abcd::99', '2001:db8::/32'));
    assert.equal(__test.findMatchingRule('2001:db9::1', '2001:db8::/32'), null);
});

test('無効なIP・CIDR設定は無視する', () => {
    assert.deepEqual(__test.parseRules('invalid,999.1.1.1,192.0.2.1/99'), []);
});

test('HTMLへ設定値を埋め込む際にエスケープする', async () => {
    const response = blockResponseForRequest(request(), {
        BLOCKED_IPS: '203.0.113.10|<script>alert(1)</script>',
    });
    const body = await response.text();
    assert.doesNotMatch(body, /<script>alert/);
    assert.match(body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
