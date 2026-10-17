import assert from 'node:assert/strict';
import test from 'node:test';

import { handleStatuspageAdminRequest, __test } from '../worker/statuspage-admin.js';

async function authFixture(teamName) {
    const { privateKey, publicKey } = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
    );
    const issuer = `https://${teamName}.cloudflareaccess.com`;
    const publicJwk = await crypto.subtle.exportKey('jwk', publicKey);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1_000);
    const signingInput = `${encode({ alg: 'RS256', kid: `${teamName}-key` })}.${encode({
        iss: issuer, aud: 'status-audience', email: 'admin@example.com', sub: 'admin-user', iat: now, exp: now + 300,
    })}`;
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, Buffer.from(signingInput));
    return {
        issuer,
        jwks: { keys: [{ ...publicJwk, kid: `${teamName}-key` }] },
        token: `${signingInput}.${Buffer.from(signature).toString('base64url')}`,
    };
}

function environment(auth, extras = {}) {
    return {
        ACCESS_AUD: 'status-audience', ACCESS_TEAM_DOMAIN: auth.issuer, ADMIN_EMAILS: 'admin@example.com',
        STATUSPAGE_PAGE_ID: '28grbz2c7xtm', STATUSPAGE_PUBLIC_URL: 'https://coffeebousai.statuspage.io/',
        STATUSPAGE_API_KEY: 'status-secret-key', ...extras,
    };
}

test('Statuspage概要を管理者だけが取得できAPIキーを応答へ含めない', async () => {
    const auth = await authFixture('status-summary-test');
    const originalFetch = globalThis.fetch;
    const apiRequests = [];
    globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        if (target.startsWith(auth.issuer)) return Response.json(auth.jwks);
        apiRequests.push({ target, options });
        if (target.includes('/components')) return Response.json([{ id: 'component001', name: 'DPI-Bot', status: 'operational', position: 1 }]);
        if (target.includes('/incidents/scheduled')) return Response.json([{ id: 'maint0000001', name: '定期保守', status: 'scheduled', scheduled_for: '2026-10-18T00:00:00Z', scheduled_until: '2026-10-18T01:00:00Z' }]);
        return Response.json([{ id: 'incident0001', name: '障害', status: 'investigating', impact: 'minor', incident_updates: [{ body: '調査中' }] }]);
    };
    try {
        const response = await handleStatuspageAdminRequest(new Request('https://dpi-bot.com/site/status-admin/api/summary', {
            headers: { 'cf-access-jwt-assertion': auth.token },
        }), environment(auth));
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.configured, true);
        assert.equal(body.components[0].name, 'DPI-Bot');
        assert.equal(body.incidents[0].body, '調査中');
        assert.equal(body.maintenances[0].name, '定期保守');
        assert.doesNotMatch(JSON.stringify(body), /status-secret-key/u);
        assert.equal(apiRequests.length, 3);
        for (const request of apiRequests) assert.equal(request.options.headers.Authorization, 'OAuth status-secret-key');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('コンポーネント更新は同一オリジン・確認入力・監査記録を要求する', async () => {
    const auth = await authFixture('status-update-test');
    const originalFetch = globalThis.fetch;
    let apiBody;
    let auditValues;
    globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        if (target.startsWith(auth.issuer)) return Response.json(auth.jwks);
        apiBody = JSON.parse(options.body);
        return Response.json({ id: 'component001', name: 'DPI-Bot', status: apiBody.component.status });
    };
    const database = {
        prepare() {
            return { bind(...values) { auditValues = values; return this; }, async run() { return { success: true }; } };
        },
    };
    const request = new Request('https://dpi-bot.com/site/status-admin/api/components/component001', {
        method: 'PUT',
        headers: { 'cf-access-jwt-assertion': auth.token, origin: 'https://dpi-bot.com', 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'partial_outage', confirmation: 'COMPONENT:component001:partial_outage' }),
    });
    try {
        const response = await handleStatuspageAdminRequest(request, environment(auth, { NEWSLETTER_DB: database }));
        assert.equal(response.status, 200);
        assert.deepEqual(apiBody, { component: { status: 'partial_outage' } });
        assert.equal(auditValues[1], 'admin@example.com');
        assert.equal(auditValues[2], 'statuspage.component.update');
        assert.equal(auditValues[4], 'component001');
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('別サイトからのStatuspage更新をAPI呼び出し前に拒否する', async () => {
    const auth = await authFixture('status-origin-test');
    const originalFetch = globalThis.fetch;
    let statuspageCalled = false;
    globalThis.fetch = async (url) => {
        if (String(url).startsWith(auth.issuer)) return Response.json(auth.jwks);
        statuspageCalled = true;
        return Response.json({});
    };
    try {
        const response = await handleStatuspageAdminRequest(new Request('https://dpi-bot.com/site/status-admin/api/incidents', {
            method: 'POST',
            headers: { 'cf-access-jwt-assertion': auth.token, origin: 'https://attacker.example', 'content-type': 'application/json' },
            body: JSON.stringify({}),
        }), environment(auth));
        assert.equal(response.status, 403);
        assert.equal(statuspageCalled, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('メンテナンスの日時と自動遷移設定を検証する', () => {
    const incident = __test.validateIncident({
        name: '定期メンテナンス', body: '更新作業を実施します。', status: 'scheduled', impact: 'none',
        scheduledFor: '2026-10-18T00:00:00Z', scheduledUntil: '2026-10-18T01:00:00Z',
        componentIds: ['component001'], componentStatus: 'under_maintenance', autoStart: true, autoComplete: true,
    }, true, null);
    assert.equal(incident.scheduled_auto_in_progress, true);
    assert.equal(incident.scheduled_auto_completed, true);
    assert.deepEqual(incident.components, { component001: 'under_maintenance' });
    assert.throws(() => __test.validateIncident({ ...incident, scheduledFor: 'invalid', scheduledUntil: 'invalid' }, true, null), /開始日時/u);
});
