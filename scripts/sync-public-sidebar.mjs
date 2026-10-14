import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const excluded = new Set([
    'site/channel-admin/index.html',
    'site/ip-admin/index.html',
    'site/mail-admin/index.html',
    'site/reuse-admin/index.html',
]);

const menuItems = [
    ['/index.html', 'トップページ', 'home'],
    ['/site/status/index.html', 'お知らせ', 'status'],
    ['/site/info/index.html', '配信内容', 'info'],
    ['/site/about/index.html', 'コマンド', 'about'],
    ['/site/dever/index.html', '開発者紹介', 'dever'],
    null,
    ['/site/mail/index.html', 'メール配信', 'mail'],
    ['/site/reuse/', '二次利用申請', 'reuse'],
    null,
    ['/site/invi/index.html', 'BOTを招待', 'invi'],
    ['/site/buy/index.html', 'ご支援のお願い', 'buy'],
    ['/terms/index.html', '利用規約等', 'terms'],
    ['/site/supp/index.html', 'お問い合わせ', 'supp'],
];

async function htmlFiles(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules') continue;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...await htmlFiles(fullPath));
        else if (entry.isFile() && entry.name.endsWith('.html')) files.push(fullPath);
    }
    return files;
}

function activeSection(relativePath) {
    if (relativePath === 'index.html') return 'home';
    if (relativePath.startsWith('site/status/')) return 'status';
    if (relativePath.startsWith('site/info/')) return 'info';
    if (relativePath.startsWith('site/about/')) return 'about';
    if (relativePath.startsWith('site/dever/')) return 'dever';
    if (relativePath.startsWith('site/mail/')) return 'mail';
    if (relativePath.startsWith('site/reuse/')) return 'reuse';
    if (relativePath.startsWith('site/invi/')) return 'invi';
    if (relativePath.startsWith('site/buy/')) return 'buy';
    if (relativePath.startsWith('terms/')) return 'terms';
    if (relativePath.startsWith('site/supp/')) return 'supp';
    return '';
}

function menuHtml(relativePath, indent) {
    const active = activeSection(relativePath);
    return menuItems.map((item) => {
        if (!item) return `${indent}<li class="menu-spacer" aria-hidden="true" style="height:10px"></li>`;
        const [href, label, section] = item;
        const current = section === active ? ' class="active" aria-current="page"' : '';
        return `${indent}<li><a href="${href}"${current}>${label}</a></li>`;
    }).join('\n');
}

let updated = 0;
for (const file of await htmlFiles(root)) {
    const relativePath = path.relative(root, file).split(path.sep).join('/');
    if (excluded.has(relativePath)) continue;
    const source = await readFile(file, 'utf8');
    if (!/<nav class="sidebar(?:"|\s)/u.test(source)) continue;
    const next = source.replace(
        /(<nav class="sidebar[^>]*>[\s\S]*?<ul>)[\s\S]*?(<\/ul>)/u,
        (match, start, end) => {
            const lineStart = source.lastIndexOf('\n', source.indexOf(match)) + 1;
            const navIndent = source.slice(lineStart, source.indexOf(match)).match(/^\s*/u)?.[0] || '';
            return `${start}\n${menuHtml(relativePath, `${navIndent}        `)}\n${navIndent}    ${end}`;
        },
    );
    if (next !== source) {
        await writeFile(file, next);
        updated += 1;
    }
}

console.log(`Updated ${updated} public sidebars.`);
