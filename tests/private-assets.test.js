import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';

test('private source and configuration never reach the assets binding on any hostname', async () => {
    for (const host of ['dpi-bot.com', 'example.workers.dev', 'preview.example.workers.dev']) {
        for (const path of ['/aws/channel-directory-api/lambda_function.py', '/scripts/deploy-mode-aws.py', '/.env', '/wrangler.jsonc', '/nested/.env', '/nested/secret.json', '/%61ws/file.py', '/aws%2ffile.py']) {
            let fetched = false;
            const response = await worker.fetch(new Request(`https://${host}${path}`), { ASSETS: { fetch() { fetched = true; return new Response('private'); } } });
            assert.equal(response.status, 404, path);
            assert.equal(fetched, false, path);
        }
    }
});
test('ordinary public assets remain accessible', async () => {
    const response = await worker.fetch(new Request('https://dpi-bot.com/style.css'), { ASSETS: { fetch: () => new Response('public') } });
    assert.equal(await response.text(), 'public');
});
