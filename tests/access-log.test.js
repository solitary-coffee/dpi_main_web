import assert from 'node:assert/strict';
import test from 'node:test';

import { __test } from '../worker/access-log.js';

test('アクセスログは秘密値を含むクエリ値とRefererクエリを保存しない', () => {
    const request = new Request('https://dpi-bot.com/api/test?token=secret&category=eew', {
        method: 'POST',
        headers: {
            'content-length': '123',
            referer: 'https://dpi-bot.com/site/page?session=secret',
            'user-agent': 'test-agent',
            'cf-connecting-ip': '192.0.2.10',
        },
        body: '{}',
    });
    const event = __test.buildEvent(request, new Response('ok', { status: 201 }), 'main', Date.now());
    assert.deepEqual(event.queryKeys, ['token', 'category']);
    assert.equal(event.referer, 'https://dpi-bot.com/site/page');
    assert.equal(event.ip, '192.0.2.10');
    assert.equal(event.method, 'POST');
    assert.equal(event.status, 201);
    assert.doesNotMatch(JSON.stringify(event), /secret/u);
});

test('カーソルは同一時刻内のIDを維持する', () => {
    const cursor = __test.encodeCursor('2026-10-27T00:00:00.000Z', 'event-id');
    assert.deepEqual(__test.decodeCursor(cursor), {
        receivedAt: '2026-10-27T00:00:00.000Z',
        id: 'event-id',
    });
});
