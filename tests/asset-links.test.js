import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import { ASSET_LINKS } from '../worker/asset-links.js';

test('assetlinks.json は認証・静的配信なしで JSON として返る', async () => {
    let assetsFetched = false;
    const env = { ASSETS: { fetch() { assetsFetched = true; return new Response('static'); } } };
    const response = await worker.fetch(new Request('https://dpi-bot.com/.well-known/assetlinks.json'), env);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Content-Type'), /^application\/json/);
    const body = await response.json();
    assert.equal(body[0].target.package_name, 'com.dpibot.controldeck');
    assert.match(body[0].target.sha256_cert_fingerprints[0], /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.equal(assetsFetched, false);
});

test('docs の assetlinks.json と Worker の内容が一致する', () => {
    const doc = JSON.parse(readFileSync(new URL('../docs/control-deck-apk/assetlinks.json', import.meta.url), 'utf8'));
    assert.deepEqual(doc, JSON.parse(JSON.stringify(ASSET_LINKS)));
});

test('隠しファイルは引き続き 404', async () => {
    for (const path of ['/.env', '/.git/config']) {
        const response = await worker.fetch(new Request(`https://dpi-bot.com${path}`), { ASSETS: { fetch: () => new Response('x') } });
        assert.notEqual(response.status, 200, path);
    }
});
