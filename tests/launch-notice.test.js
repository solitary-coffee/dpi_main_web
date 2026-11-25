import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {LAUNCH_NOTICE_UNTIL,showLaunchNotice} from '../site/supporter/launch-notice.js';

test('今夜だけの案内は 26日0時30分で消える。元の HTML では隠しておく',async()=>{
 assert.equal(new Date(LAUNCH_NOTICE_UNTIL).toISOString(),'2026-11-25T15:30:00.000Z');
 const items=[{hidden:true},{hidden:true}],doc={querySelectorAll:()=>items};
 assert.equal(showLaunchNotice(doc,LAUNCH_NOTICE_UNTIL-1),true);assert.deepEqual(items.map(item=>item.hidden),[false,false]);
 assert.equal(showLaunchNotice(doc,LAUNCH_NOTICE_UNTIL),false);assert.deepEqual(items.map(item=>item.hidden),[true,true]);
 for(const page of ['index','plans']){const html=await readFile(new URL(`../site/supporter/${page}.html`,import.meta.url),'utf8');assert.match(html,/data-launch-notice hidden[\s\S]*23時57分[\s\S]*0時30分まで/);assert.match(html,/src="launch-notice\.js"/);assert.match(html,/β版/);}
});
