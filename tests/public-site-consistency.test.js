import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DELIVERY_CATALOG } from '../worker/delivery-catalog.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const excluded = new Set([
    'site/admin-center/index.html',
    'site/system-admin/index.html',
    'site/ec2-admin/index.html',
    'site/xml-admin/index.html',
    'site/status-admin/index.html',
    'site/delivery-admin/index.html',
    'site/delivery-flow-admin/index.html',
    'site/audit-admin/index.html',
    'site/discord-admin/index.html',
    'site/channel-admin/index.html',
    'site/ip-admin/index.html',
    'site/mail-admin/index.html',
    'site/reuse-admin/index.html',
]);
const expectedMenu = [
    ['/index.html', 'トップページ'],
    ['/site/status/index.html', 'お知らせ'],
    ['/site/info/index.html', '配信内容'],
    ['/site/about/index.html', 'コマンド'],
    ['/site/dever/index.html', '開発者紹介'],
    ['/site/mail/index.html', 'メール配信'],
    ['/site/reuse/', '二次利用申請'],
    ['/site/invi/index.html', 'BOTを招待'],
    ['/site/buy/index.html', 'ご支援のお願い'],
    ['/terms/index.html', '利用規約等'],
    ['/site/supp/index.html', 'お問い合わせ'],
];

async function listHtmlFiles(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await listHtmlFiles(fullPath));
        else if (entry.isFile() && entry.name.endsWith('.html')) files.push(fullPath);
    }
    return files;
}

test('公開ページの左メニューは同じ項目と順序を使用する', async () => {
    let checked = 0;
    for (const file of await listHtmlFiles(root)) {
        const relativePath = path.relative(root, file).split(path.sep).join('/');
        if (excluded.has(relativePath)) continue;
        const html = await readFile(file, 'utf8');
        const sidebar = html.match(/<nav class="sidebar[^>]*>[\s\S]*?<ul>([\s\S]*?)<\/ul>/u)?.[1];
        if (!sidebar) continue;
        const links = [...sidebar.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/gu)]
            .map((match) => [match[1], match[2]]);
        assert.deepEqual(links, expectedMenu, relativePath);
        checked += 1;
    }
    assert.equal(checked, 60);
});

test('配信一覧と申請用カタログの状態が一致する', async () => {
    const html = await readFile(path.join(root, 'site/info/index.html'), 'utf8');
    const activeIds = ['大雨警戒レベル', '土砂警戒レベル', '高潮警戒レベル', '暴風、暴風雪警報・注意報', '波浪警報・注意報', '大雪警報・注意報', 'その他注意報', '気象防災速報', '線状降水帯', '顕著な大雪', '気象解説', '気象解説[潮位]'];
    const adjustingIds = ['時系列予想', '全国分通報'];
    const endedIds = ['大雨危険度通知', '土砂災害危険度', '洪水害危険度', '浸水害危険度'];
    const statuses = Object.fromEntries(DELIVERY_CATALOG.map((item) => [item.id, item.status]));

    for (const id of activeIds) assert.equal(statuses[id], 'active', id);
    for (const id of adjustingIds) assert.equal(statuses[id], 'adjusting', id);
    for (const id of endedIds) assert.equal(statuses[id], 'ended', id);
    assert.doesNotMatch(html, /class="content-card is-disabled"/u);
    assert.equal((html.match(/class="content-card is-abolished"/gu) || []).length, 7);

    const changes = await readFile(path.join(root, 'site/info/new_info/index.html'), 'utf8');
    for (const label of ['気象警報・注意報時系列予想', '全国集約通報']) {
        assert.match(changes, new RegExp(`調整中[\\s\\S]{0,250}${label}`, 'u'), label);
    }

    const endedDetail = await Promise.all(['ooam.html', 'kikend.html'].map((name) =>
        readFile(path.join(root, 'site/info/deta', name), 'utf8')));
    for (const detail of endedDetail) assert.match(detail, /この配信は終了しました/u);

    const detailFiles = await listHtmlFiles(path.join(root, 'site/info/deta'));
    for (const file of detailFiles) {
        const detail = await readFile(file, 'utf8');
        assert.doesNotMatch(detail, /この配信は廃止される予定です/u, path.basename(file));
    }
});

test('トップページのクイックリンクはホバー時も暗色背景を保つ', async () => {
    const css = await readFile(path.join(root, 'style.css'), 'utf8');
    assert.match(css, /\.link-card:hover\s*\{[^}]*background-color:\s*#3f454b;/su);
    assert.doesNotMatch(css, /\.link-card:hover\s*\{[^}]*background-color:\s*#fff;/su);
});

