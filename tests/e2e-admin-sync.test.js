import test from 'node:test';
import assert from 'node:assert/strict';
import {runAdminSyncE2E} from '../scripts/e2e-admin-sync.mjs';

test('利用者と管理者の有料プラン状態がローカルだけで同期する',{timeout:30000},async()=>{
 const result=await runAdminSyncE2E();
 assert.equal(result.failures,0,result.checks.filter(x=>!x.ok).map(x=>`${x.name}: ${x.error}`).join('\n'));
 assert.equal(result.passed,9);
});
