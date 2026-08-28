import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('CONTACT_TO_EMAILを平文のvarsへ保存しない', async () => {
    const configPath = new URL('../wrangler.jsonc', import.meta.url);
    const config = JSON.parse(await readFile(configPath, 'utf8'));

    assert.equal(Object.hasOwn(config.vars || {}, 'CONTACT_TO_EMAIL'), false);
});
