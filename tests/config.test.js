import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('CONTACT_TO_EMAILは平文のvarsではなく必須Secretとして宣言する', async () => {
    const configPath = new URL('../wrangler.jsonc', import.meta.url);
    const config = JSON.parse(await readFile(configPath, 'utf8'));

    assert.equal(Object.hasOwn(config.vars || {}, 'CONTACT_TO_EMAIL'), false);
    assert.ok(config.secrets?.required?.includes('CONTACT_TO_EMAIL'));
});
