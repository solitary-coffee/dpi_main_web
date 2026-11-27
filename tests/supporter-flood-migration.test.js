import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';

test('洪水警報・注意報の保存ルールをバックアップして削除する',async()=>{
 const db=new DatabaseSync(':memory:'),dir=new URL('../migrations/',import.meta.url);
 const names=(await readdir(dir)).filter(name=>/^\d+.*\.sql$/.test(name)).sort();
 const ids=['single','mixed','none','multiple'];
 const rule=(name,detail,conditions=[])=>({name,guildId:'12345678901234567',channelId:'98765432109876543',channelIds:['98765432109876543'],type:'weather',detail,region:'all',conditionLogic:'and',conditions});
 const settings={
  single:{rules:[rule('洪水だけ','flood-level')]},
  mixed:{rules:[rule('大雨と洪水','heavy-rain-level',[{kind:'detail',operator:'equals',value:'flood-level'},{kind:'region',operator:'equals',value:'kanto'}])]},
  none:{rules:[rule('指定河川','designated-river')]},
  multiple:{rules:[rule('洪水','flood-level'),rule('指定河川','designated-river'),rule('土砂と洪水','landslide-level',[{kind:'detail',operator:'equals',value:'flood-level'}])]},
 };
 for(const name of names){
  if(name==='0038_remove_supporter_flood_level.sql'){
   const insert=db.prepare('INSERT INTO supporter_accounts(discord_user_id,registered_at,updated_at,settings_json,revision) VALUES(?,?,?,?,?)');
   ids.forEach((id,index)=>insert.run(id,'2026-11-01','2026-11-01',JSON.stringify(settings[id]),10+index));
  }
  db.exec(await readFile(new URL(name,dir),'utf8'));
 }
 const rows=Object.fromEntries(db.prepare('SELECT discord_user_id,settings_json,revision FROM supporter_accounts WHERE discord_user_id IN (?,?,?,?)').all(...ids).map(row=>[row.discord_user_id,{...row,settings:JSON.parse(row.settings_json)}]));
 assert.deepEqual(rows.single.settings.rules,[]);assert.equal(rows.single.revision,11);
 assert.deepEqual(rows.mixed.settings.rules[0].conditions,[{kind:'region',operator:'equals',value:'kanto'}]);assert.equal(rows.mixed.revision,12);
 assert.deepEqual(rows.none.settings,settings.none);assert.equal(rows.none.revision,12);
 assert.deepEqual(rows.multiple.settings.rules.map(item=>item.detail),['designated-river','landslide-level']);
 assert.deepEqual(rows.multiple.settings.rules[1].conditions,[]);assert.equal(rows.multiple.revision,14);
 const backups=db.prepare('SELECT discord_user_id,settings_json,revision,backed_up_at FROM supporter_settings_backup_20261127 ORDER BY discord_user_id').all();
 assert.deepEqual(backups.map(row=>row.discord_user_id),['mixed','multiple','single']);
 for(const backup of backups){assert.deepEqual(JSON.parse(backup.settings_json),settings[backup.discord_user_id]);assert.ok(backup.backed_up_at);}
 db.exec(await readFile(new URL('0038_remove_supporter_flood_level.sql',dir),'utf8'));
 assert.deepEqual(db.prepare('SELECT discord_user_id,revision FROM supporter_accounts WHERE discord_user_id IN (?,?,?,?) ORDER BY discord_user_id').all(...ids).map(row=>({...row})),[
  {discord_user_id:'mixed',revision:12},{discord_user_id:'multiple',revision:14},{discord_user_id:'none',revision:12},{discord_user_id:'single',revision:11},
 ]);
});
