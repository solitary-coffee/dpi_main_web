import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('機密値を平文のvarsへ保存せず、デプロイ時の必須Secretにする', async () => {
    const configPath = new URL('../wrangler.jsonc', import.meta.url);
    const config = JSON.parse(await readFile(configPath, 'utf8'));

    assert.equal(Object.hasOwn(config.vars || {}, 'CONTACT_TO_EMAIL'), false);
    assert.equal(Object.hasOwn(config.vars || {}, 'RECAPTCHA_SECRET_KEY'), false);
    assert.equal(Object.hasOwn(config.vars || {}, 'RECAPTCHA_SITE_KEY'), false);
    assert.deepEqual(
        [...(config.secrets?.required || [])].sort(),
        ['CONTACT_TO_EMAIL', 'RECAPTCHA_SECRET_KEY', 'RECAPTCHA_SITE_KEY'].sort(),
    );
});
