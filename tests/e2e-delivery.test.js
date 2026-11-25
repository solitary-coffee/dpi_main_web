import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runDeliveryE2E} from '../scripts/e2e-delivery.mjs';

test('有料プランの登録から配信snapshotまでをローカルで通す',{timeout:20000},async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'dpi-delivery-e2e-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const guildId='22345678901234567',channelId='88765432109876543';
 const result=await runDeliveryE2E({exportDir:dir,guildId,channelId,now:1_800_000_000_000});
 assert.equal(result.failures,0);
 const files={};for(const name of ['active','canceled','suspended','expired'])files[name]=JSON.parse(await readFile(path.join(dir,`${name}.json`),'utf8'));
 assert.ok(files.active.rules.some(rule=>rule.guildId===guildId&&rule.channelIds.includes(channelId)));
 assert.equal(files.canceled.rules.some(rule=>rule.channelIds?.includes(channelId)),false);
 assert.equal(files.suspended.rules.some(rule=>rule.channelIds?.includes(channelId)),false);
 assert.ok(files.expired.expiresAt<1_800_000_000);
});
