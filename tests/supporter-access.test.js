import test from 'node:test';
import assert from 'node:assert/strict';
import { supporterPublicEnabled, supporterTestUserAllowed } from '../worker/supporter.js';

test('supporter preview stays closed unless explicitly enabled', () => {
 assert.equal(supporterPublicEnabled({}), false);
 assert.equal(supporterPublicEnabled({SUPPORTER_PUBLIC_ENABLED:'false'}), false);
 assert.equal(supporterPublicEnabled({SUPPORTER_PUBLIC_ENABLED:' TRUE '}), true);
});

test('private supporter preview accepts only exact Discord IDs', () => {
 const env = {
  SUPPORTER_PUBLIC_ENABLED: 'false',
  SUPPORTER_TEST_USER_IDS: '12345678901234567, 98765432109876543210, invalid, *',
 };
 assert.equal(supporterTestUserAllowed(env, '12345678901234567'), true);
 assert.equal(supporterTestUserAllowed(env, '98765432109876543210'), true);
 assert.equal(supporterTestUserAllowed(env, '12345678901234568'), false);
 assert.equal(supporterTestUserAllowed(env, ''), false);
});

test('public supporter mode bypasses the preview allowlist', () => {
 assert.equal(supporterTestUserAllowed({SUPPORTER_PUBLIC_ENABLED:'true'}, 'any-user'), true);
});
