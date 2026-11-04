import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSupporterRequest, supporterConsentVersion, supporterPublicEnabled, supporterTestUserAllowed } from '../worker/supporter.js';

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

test('paid plan checkout requires explicit current legal consent',()=>{
 const env={SUPPORTER_CONSENT_VERSION:'2026-11-04'};
 assert.equal(supporterConsentVersion({legalConsent:true},env),'2026-11-04');
 assert.throws(()=>supporterConsentVersion({legalConsent:false},env),/同意が必要/);
 assert.throws(()=>supporterConsentVersion({legalConsent:true},{}),/設定が完了/);
});

test('BASIC admin path with and without trailing slash fails closed', async () => {
 let assetCalls=0;
 const env={ASSETS:{fetch(){assetCalls+=1;return new Response('private');}}};
 for(const path of ['/site/supporter-admin','/site/supporter-admin/']){
  const response=await handleSupporterRequest(new Request(`https://dpi-bot.com${path}`),env);
  assert.equal(response.status,503);
 }
 assert.equal(assetCalls,0);
});
