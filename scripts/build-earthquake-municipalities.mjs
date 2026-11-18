// Builds site/supporter/earthquake-municipalities.json (地図の中心にする市区町村の一覧, earthquake-map / Pro).
// Source: dpi_code Di/jma_earthquake_areas.json (気象庁 地震火山関連コード表 シート24: 細分区域 → 市町村等).
// The codes are the 7-digit 市町村等 codes used in JMA earthquake telegrams (VXSE53 City); the bot
// accepts exactly these as `centerMunicipality`. The Worker validates saved codes against this file.
//
//   node scripts/build-earthquake-municipalities.mjs <path to dpi_code/Di/jma_earthquake_areas.json>
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const source = process.argv[2];
if (!source) {
    console.error('usage: node scripts/build-earthquake-municipalities.mjs <jma_earthquake_areas.json>');
    process.exit(2);
}
const data = JSON.parse(await readFile(source, 'utf8'));
const areas = data?.areas || {};
const cities = data?.cities || {};
const prefectures = {};
for (const [code, entry] of Object.entries(cities)) {
    const [name, areaCode] = Array.isArray(entry) ? entry : [];
    const prefecture = areas[areaCode]?.[1];
    if (!/^\d{7}$/.test(code) || typeof name !== 'string' || !name || prefecture !== code.slice(0, 2)) {
        throw new Error(`unexpected city entry ${code}`);
    }
    (prefectures[prefecture] ||= []).push([code, name]);
}
// Keep "01".."47" order explicitly (object keys such as "10" would otherwise sort before "01").
const sorted = Object.keys(prefectures).sort().map(pref => [pref, prefectures[pref].sort((a, b) => a[0].localeCompare(b[0]))]);
const count = sorted.reduce((sum, [, list]) => sum + list.length, 0);
if (sorted.length !== 47 || count < 1800) throw new Error(`incomplete list: ${sorted.length} prefectures, ${count} cities`);
const SOURCE = '気象庁 地震火山関連コード表（市町村等）';
const target = path.resolve(import.meta.dirname, '..', 'site', 'supporter', 'earthquake-municipalities.json');
// One prefecture per line keeps diffs readable while staying small.
const lines = sorted.map(([pref, list]) => `${JSON.stringify(pref)}:${JSON.stringify(list)}`);
await writeFile(target, `{"version":1,"source":${JSON.stringify(SOURCE)},"count":${count},"prefectures":{\n${lines.join(',\n')}\n}}\n`, 'utf8');
console.log(`wrote ${target}: ${count} municipalities`);
