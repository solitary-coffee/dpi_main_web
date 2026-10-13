import test from 'node:test';
import assert from 'node:assert/strict';
import { __test as ipAdminTest } from '../worker/ip-admin.js';

function createDatabase() {
    let rule = null;
    const audits = [];

    return {
        get rule() { return rule; },
        get audits() { return audits; },
        prepare(sql) {
            return {
                sql,
                args: [],
                bind(...args) {
                    this.args = args;
                    return this;
                },
                async first() {
                    if (sql.includes('WHERE network =')) return rule?.network === this.args[0] ? { id: rule.id } : null;
                    if (sql.includes('WHERE id =')) return rule?.id === this.args[0] ? rule : null;
                    return null;
                },
            };
        },
        async batch(statements) {
            for (const statement of statements) {
                const placeholders = (statement.sql.match(/\?/gu) || []).length;
                assert.equal(statement.args.length, placeholders, `bind count mismatch: ${statement.sql}`);
                if (statement.sql.includes('INSERT INTO ip_block_rules')) {
                    rule = {
                        id: statement.args[0],
                        network: statement.args[1],
                        reason: statement.args[2],
                    };
                } else if (statement.sql.includes('DELETE FROM ip_block_rules')) {
                    rule = null;
                } else if (statement.sql.includes('INSERT INTO ip_block_audit')) {
                    audits.push(statement.args);
                }
            }
            return statements.map(() => ({ success: true }));
        },
    };
}

function adminRequest(method, body, ip = '203.0.113.10') {
    return new Request('https://dpi-bot.com/site/ip-admin/api/rules', {
        method,
        headers: {
            Origin: 'https://dpi-bot.com',
            'Content-Type': 'application/json',
            'CF-Connecting-IP': ip,
            'CF-Ray': 'test-ray-NRT',
        },
        body: JSON.stringify(body),
    });
}

test('IP遮断ルールの追加・削除と監査記録を同じD1バッチで処理する', async () => {
    const database = createDatabase();
    const env = { NEWSLETTER_DB: database };
    const admin = { email: 'admin@example.com', subject: 'admin-subject' };

    const createdResponse = await ipAdminTest.createRule(
        adminRequest('POST', { network: '198.51.100.0/24', reason: '継続的な自動アクセス' }),
        env,
        admin,
    );
    const created = await createdResponse.json();
    assert.equal(createdResponse.status, 201);
    assert.equal(created.rule.network, '198.51.100.0/24');
    assert.equal(database.rule.reason, '継続的な自動アクセス');
    assert.equal(database.audits.length, 1);

    const deleteRequest = new Request(
        `https://dpi-bot.com/site/ip-admin/api/rules/${created.rule.id}`,
        {
            method: 'DELETE',
            headers: {
                Origin: 'https://dpi-bot.com',
                'Content-Type': 'application/json',
                'CF-Connecting-IP': '203.0.113.10',
                'CF-Ray': 'delete-ray-NRT',
            },
            body: JSON.stringify({ confirmation: created.rule.id }),
        },
    );
    const deletedResponse = await ipAdminTest.deleteRule(deleteRequest, env, admin, created.rule.id);
    const deleted = await deletedResponse.json();
    assert.equal(deletedResponse.status, 200);
    assert.equal(deleted.deleted.network, '198.51.100.0/24');
    assert.equal(database.rule, null);
    assert.equal(database.audits.length, 2);
});

test('現在の接続元を含む遮断はネットワーク文字列による再確認を必須にする', async () => {
    const database = createDatabase();
    await assert.rejects(
        ipAdminTest.createRule(
            adminRequest('POST', { network: '203.0.113.0/24', reason: '試験' }),
            { NEWSLETTER_DB: database },
            { email: 'admin@example.com', subject: 'admin-subject' },
        ),
        (error) => error?.code === 'self_block_confirmation_required' && error?.status === 409,
    );
    assert.equal(database.rule, null);
});
