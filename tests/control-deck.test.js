import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { handleAdminCenterRequest } from '../worker/admin-center.js';
import { COMMAND_TTL_SECONDS } from '../worker/patlite-admin.js';

// patlite_commands だけを持つ簡易 D1（UPDATE の changes で「先に取った方だけ」を判定できるようにする）
class CommandD1 {
    constructor() { this.commands = []; this.state = null; }
    prepare(sql) {
        const db = this;
        return {
            bind(...args) { this.args = args; return this; },
            async first() { return /patlite_state/u.test(sql) ? db.state : null; },
            async all() {
                if (/FROM patlite_commands/u.test(sql)) {
                    const since = this.args[0];
                    return { results: db.commands.filter((row) => row.done_at === null && row.created_at >= since) };
                }
                return { results: [] };
            },
            async run() {
                const a = this.args || [];
                if (/^INSERT INTO patlite_commands/u.test(sql)) {
                    db.commands.push({ id: a[0], command: a[1], args: a[2], created_at: a[3], created_by: a[4], done_at: null });
                    return { meta: { changes: 1 } };
                }
                if (/^UPDATE patlite_commands/u.test(sql)) {
                    const row = db.commands.find((r) => r.id === a[2] && r.done_at === null && r.created_at >= a[3]);
                    if (!row) return { meta: { changes: 0 } };
                    row.done_at = a[0];
                    row.done_by = a[1];
                    return { meta: { changes: 1 } };
                }
                return { meta: { changes: 0 } };
            },
        };
    }
}


// One key for the whole file: access.js caches the signing keys per team domain.
const keyPair = crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
);

async function withAccess(run, email = 'admin@example.com') {
    const { privateKey, publicKey } = await keyPair;
    const publicJwk = await crypto.subtle.exportKey('jwk', publicKey);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1_000);
    const signingInput = `${encode({ alg: 'RS256', kid: 'deck-test-key' })}.${encode({
        iss: 'https://test-team.cloudflareaccess.com', aud: 'test-audience', email, sub: 's', iat: now, exp: now + 300,
    })}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, Buffer.from(signingInput));
    const token = `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ keys: [{ ...publicJwk, kid: 'deck-test-key' }] });
    try {
        await run(token);
    } finally {
        globalThis.fetch = originalFetch;
    }
}


function env(db) {
    return {
        ACCESS_AUD: 'test-audience',
        ACCESS_TEAM_DOMAIN: 'https://test-team.cloudflareaccess.com',
        ADMIN_EMAILS: 'admin@example.com',
        ASSETS: { fetch: async () => new Response('deck page', { headers: { 'Content-Type': 'text/html' } }) },
        REUSE_DB: db,
    };
}

const post = (path, body, headers = {}) => new Request(`https://dpi-bot.com${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://dpi-bot.com', ...headers }, body: JSON.stringify(body),
});

test('遠隔操作の依頼: 管理者だけ・種類と秒数を検証・別サイトからは拒否', async () => {
    const db = new CommandD1();
    const environment = env(db);
    assert.equal((await handleAdminCenterRequest(post('/site/patlite-admin/api/command', { command: 'ack' }), environment)).status, 403);
    assert.equal(db.commands.length, 0);
    await withAccess(async (token) => {
        const auth = { 'cf-access-jwt-assertion': token };
        assert.equal((await handleAdminCenterRequest(post('/site/patlite-admin/api/command', { command: 'reboot' }, auth), environment)).status, 400);
        assert.equal((await handleAdminCenterRequest(post('/site/patlite-admin/api/command', { command: 'illum', seconds: 600 }, auth), environment)).status, 400);
        assert.equal((await handleAdminCenterRequest(post('/site/patlite-admin/api/command', { command: 'ack' }, { ...auth, origin: 'https://evil.example' }), environment)).status, 403);
        const ok = await handleAdminCenterRequest(post('/site/patlite-admin/api/command', { command: 'illum', seconds: 30 }, auth), environment);
        assert.equal(ok.status, 200);
        const body = await ok.json();
        assert.deepEqual(body.args, { seconds: 30 });
        assert.equal(db.commands[0].created_by, 'admin@example.com');
        const get = await handleAdminCenterRequest(new Request('https://dpi-bot.com/site/patlite-admin/api/command', { headers: auth }), environment);
        assert.equal(get.status, 405);
    });
});

test('遠隔操作の依頼: state に未実行のものが載り、実行の権利は 1 回だけ・期限切れは取れない', async () => {
    const db = new CommandD1();
    const environment = env(db);
    await withAccess(async (token) => {
        const auth = { 'cf-access-jwt-assertion': token };
        const stateUrl = 'https://dpi-bot.com/site/patlite-admin/api/state';
        const { id } = await (await handleAdminCenterRequest(post('/site/patlite-admin/api/command', { command: 'ack' }, auth), environment)).json();
        const state = await (await handleAdminCenterRequest(new Request(stateUrl, { headers: auth }), environment)).json();
        assert.deepEqual(state.commands.map((c) => [c.id, c.command]), [[id, 'ack']]);
        const first = await (await handleAdminCenterRequest(post('/site/patlite-admin/api/command/done', { id }, auth), environment)).json();
        const second = await (await handleAdminCenterRequest(post('/site/patlite-admin/api/command/done', { id }, auth), environment)).json();
        assert.equal(first.claimed, true);
        assert.equal(second.claimed, false);
        const after = await (await handleAdminCenterRequest(new Request(stateUrl, { headers: auth }), environment)).json();
        assert.deepEqual(after.commands, []);
        const staleId = '00000000-0000-4000-8000-000000000000';
        db.commands.push({ id: staleId, command: 'fullstop_on', args: '{}', created_at: Date.now() / 1000 - COMMAND_TTL_SECONDS - 5, done_at: null });
        const stale = await (await handleAdminCenterRequest(new Request(stateUrl, { headers: auth }), environment)).json();
        assert.deepEqual(stale.commands, []);
        const late = await (await handleAdminCenterRequest(post('/site/patlite-admin/api/command/done', { id: staleId }, auth), environment)).json();
        assert.equal(late.claimed, false);
        assert.equal((await handleAdminCenterRequest(post('/site/patlite-admin/api/command/done', { id: 'x' }, auth), environment)).status, 400);
        const page = await handleAdminCenterRequest(new Request('https://dpi-bot.com/site/control-deck/', { headers: auth }), environment);
        assert.equal(page.status, 200);
        assert.match(page.headers.get('content-security-policy'), /script-src 'self'/u);
    });
    assert.equal((await handleAdminCenterRequest(new Request('https://dpi-bot.com/site/control-deck/'), environment)).status, 403);
});

test('操作盤ページ: インラインのスクリプト・スタイルなし、PWA の manifest、長押し、積層灯ページは依頼を取ってから実行', async () => {
    const html = await readFile(new URL('../site/control-deck/index.html', import.meta.url), 'utf8');
    const script = await readFile(new URL('../site/control-deck/deck.js', import.meta.url), 'utf8');
    const manifest = JSON.parse(await readFile(new URL('../site/control-deck/manifest.webmanifest', import.meta.url), 'utf8'));
    const patlite = await readFile(new URL('../site/patlite-admin/script.js', import.meta.url), 'utf8');
    assert.match(html, /<script type="module" src="deck.js"><\/script>/u);
    assert.equal((html.match(/<script/gu) || []).length, 1);
    assert.doesNotMatch(html, /style="/u);
    assert.match(html, /rel="manifest" href="manifest.webmanifest" crossorigin="use-credentials"/u);
    assert.equal(manifest.display, 'fullscreen');
    assert.equal(manifest.start_url, '/site/control-deck/');
    assert.match(html, /data-command="fullstop_on" data-hold="1"/u);
    assert.match(script, /navigator\.wakeLock\.request\('screen'\)/u);
    assert.match(patlite, /if \(!response\.ok \|\| !data\?\.claimed\) continue;/u);
    assert.match(patlite, /if \(!serial\.connected\) return;/u);
});
