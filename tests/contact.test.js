import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import worker, { __test, handleContactRequest } from '../worker/index.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = originalFetch;
    delete globalThis.contactFormWasExecuted;
});

function createEnvironment(sentMessages = []) {
    return {
        ASSETS: {
            fetch: async () => new Response('asset'),
        },
        CONTACT_EMAIL: {
            send: async (message) => {
                sentMessages.push(message);
                return { messageId: 'test-message-id' };
            },
        },
        CONTACT_FROM_EMAIL: 'noreply@dpi-bot.com',
        CONTACT_TO_EMAIL: 'support@dpi-bot.com',
        RECAPTCHA_SITE_KEY: 'test-site-key',
        RECAPTCHA_SECRET_KEY: 'test-secret-key',
        RECAPTCHA_ALLOWED_HOSTS: 'dpi-bot.com',
    };
}

function createFormRequest({
    origin = 'https://dpi-bot.com',
    hostname = 'dpi-bot.com',
    name = 'テスト利用者',
    email = 'tester@example.com',
    topic = 'bug_report',
    message = 'お問い合わせ本文です。',
    recaptchaToken = 'valid-token',
    files = [],
    privacyConsent = 'agreed',
    startedAt = Date.now() - 3_000,
    website = '',
} = {}) {
    const formData = new FormData();
    formData.set('name', name);
    formData.set('email', email);
    formData.set('topic', topic);
    formData.set('message', message);
    formData.set('recaptchaToken', recaptchaToken);
    formData.set('privacyConsent', privacyConsent);
    formData.set('formStartedAt', String(startedAt));
    formData.set('website', website);
    for (const file of files) formData.append('attachments', file);

    return new Request(`https://${hostname}/api/contact`, {
        method: 'POST',
        headers: { Origin: origin },
        body: formData,
    });
}

function mockSuccessfulRecaptcha(hostname = 'dpi-bot.com') {
    globalThis.fetch = async (input, init) => {
        assert.equal(String(input), 'https://www.google.com/recaptcha/api/siteverify');
        assert.equal(init.method, 'POST');
        assert.match(String(init.body), /secret=test-secret-key/u);
        assert.match(String(init.body), /response=valid-token/u);
        return Response.json({
            success: true,
            hostname,
            challenge_ts: new Date().toISOString(),
        });
    };
}

test('設定APIはサイトキーだけを返し、シークレットを公開しない', async () => {
    const response = await worker.fetch(
        new Request('https://dpi-bot.com/api/contact/config'),
        createEnvironment(),
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body, {
        success: true,
        configured: true,
        siteKey: 'test-site-key',
    });
    assert.doesNotMatch(JSON.stringify(body), /test-secret-key/u);
    assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('CONTACT_TO_EMAILが未設定なら送信処理を開始せず拒否する', async () => {
    const env = createEnvironment();
    delete env.CONTACT_TO_EMAIL;
    let recaptchaWasCalled = false;
    globalThis.fetch = async () => {
        recaptchaWasCalled = true;
        return Response.json({ success: true });
    };

    const response = await handleContactRequest(createFormRequest(), env);
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.success, false);
    assert.equal(body.code, 'service_not_configured');
    assert.equal(recaptchaWasCalled, false);
});

test('有料・カスタムプランの種類を正しい日本語名で受け付け、未知の値は拒否する', async () => {
    for (const [topic, label] of [
        ['paid_plan', '有料プランに関するお問い合わせ'],
        ['custom_plan', 'カスタムプランに関するご相談'],
    ]) {
        const sentMessages = [];
        mockSuccessfulRecaptcha();
        const response = await handleContactRequest(createFormRequest({ topic }), createEnvironment(sentMessages));
        assert.equal(response.status, 200, topic);
        assert.equal(sentMessages.length, 1, topic);
        assert.match(sentMessages[0].subject, new RegExp(label));
        assert.match(sentMessages[0].text, new RegExp(`概要: ${label}`));
    }

    let recaptchaWasCalled = false;
    globalThis.fetch = async () => { recaptchaWasCalled = true; return Response.json({ success: true }); };
    const response = await handleContactRequest(createFormRequest({ topic: 'unknown_plan' }), createEnvironment());
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'invalid_topic');
    assert.equal(recaptchaWasCalled, false);
});

test('問い合わせ選択肢はWorkerのTOPICSに含まれ、URLの既知の値だけを初期選択する', async () => {
    const html = await readFile(new URL('../site/supp/index.html', import.meta.url), 'utf8');
    const options = [...html.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)]
        .filter(([, value]) => value)
        .map(([, value, label]) => [value, label]);
    for (const [value] of options) assert.ok(Object.hasOwn(__test.topics, value), value);
    for (const value of ['paid_plan', 'custom_plan']) assert.equal(Object.fromEntries(options)[value], __test.topics[value]);
    // 支援の案内は意図して隠している（選択肢に出さない）
    assert.ok(!options.some(([value]) => value === 'buy_report'));
    assert.deepEqual(options.slice(-3).map(([value]) => value), ['paid_plan', 'custom_plan', 'other']);

    const script = await readFile(new URL('../site/supp/script.js', import.meta.url), 'utf8');
    const selectTopicFromQuery = runInNewContext(`${script}\nselectTopicFromQuery;`, {
        window: {},
        document: { addEventListener() {} },
        URLSearchParams,
    });
    const select = { options: options.map(([value]) => ({ value })), value: '' };
    selectTopicFromQuery(select, '?type=custom_plan');
    assert.equal(select.value, 'custom_plan');
    select.value = '';
    selectTopicFromQuery(select, '?type=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E');
    assert.equal(select.value, '');
    assert.doesNotMatch(script, /innerHTML/);
});

test('スクリプト文字列を実行せず、プレーンテキストのメールとして送る', async () => {
    const sentMessages = [];
    const env = createEnvironment(sentMessages);
    mockSuccessfulRecaptcha();

    const scriptText = '<script>globalThis.contactFormWasExecuted = true</script>';
    const request = createFormRequest({
        name: `利用者 ${scriptText}`,
        message: `不具合報告\n${scriptText}`,
        files: [new File([`console.log('sample');\n${scriptText}`], 'evidence.log', { type: 'text/plain' })],
    });
    const response = await handleContactRequest(request, env);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.match(body.reference, /^CONTACT-\d{8}-[A-F0-9]{10}$/u);
    assert.equal(globalThis.contactFormWasExecuted, undefined);
    assert.equal(sentMessages.length, 1);

    const email = sentMessages[0];
    assert.equal(email.html, undefined);
    assert.match(email.text, /<script>globalThis\.contactFormWasExecuted = true<\/script>/u);
    assert.equal(email.replyTo, 'tester@example.com');
    assert.equal(email.attachments.length, 1);
    assert.equal(email.attachments[0].filename, 'attachment-01.txt');
    assert.equal(email.attachments[0].type, 'text/plain; charset=utf-8');
    assert.equal(email.attachments[0].disposition, 'attachment');
});

test('別オリジンからの送信をreCAPTCHA検証前に拒否する', async () => {
    let fetchWasCalled = false;
    globalThis.fetch = async () => {
        fetchWasCalled = true;
        return Response.json({ success: true });
    };
    const sentMessages = [];
    const response = await handleContactRequest(
        createFormRequest({ origin: 'https://attacker.example' }),
        createEnvironment(sentMessages),
    );
    const body = await response.json();

    assert.equal(response.status, 403);
    assert.equal(body.code, 'invalid_origin');
    assert.equal(fetchWasCalled, false);
    assert.equal(sentMessages.length, 0);
});

test('reCAPTCHAの検証ホストが一致しない場合は拒否する', async () => {
    mockSuccessfulRecaptcha('attacker.example');
    const sentMessages = [];
    const response = await handleContactRequest(
        createFormRequest(),
        createEnvironment(sentMessages),
    );
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.code, 'recaptcha_failed');
    assert.equal(sentMessages.length, 0);
});

test('SVGや実行形式など許可外の添付を拒否する', async () => {
    mockSuccessfulRecaptcha();
    const sentMessages = [];
    const svg = new File(
        ['<svg onload="globalThis.contactFormWasExecuted=true"></svg>'],
        'attack.svg',
        { type: 'image/svg+xml' },
    );
    const response = await handleContactRequest(
        createFormRequest({ files: [svg] }),
        createEnvironment(sentMessages),
    );
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.code, 'unsupported_file_type');
    assert.equal(sentMessages.length, 0);
    assert.equal(globalThis.contactFormWasExecuted, undefined);
});

test('拡張子を偽装した画像をマジックバイト検査で拒否する', async () => {
    mockSuccessfulRecaptcha();
    const sentMessages = [];
    const fakePng = new File(['MZ\u0000malicious executable'], 'photo.png', { type: 'image/png' });
    const response = await handleContactRequest(
        createFormRequest({ files: [fakePng] }),
        createEnvironment(sentMessages),
    );
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.code, 'unsafe_image');
    assert.equal(sentMessages.length, 0);
});

test('PNGを構造・CRC検証して安全なチャンクだけ残す', async () => {
    const png = Uint8Array.from(Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
    ));
    const sanitized = __test.sanitizePng(png);

    assert.deepEqual(Array.from(sanitized.slice(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.ok(sanitized.byteLength <= png.byteLength);
});

test('JPEGからAPPメタデータとコメント領域を除去する', () => {
    const jpegWithMetadata = Uint8Array.from([
        0xff, 0xd8,
        0xff, 0xe1, 0x00, 0x08, 0x4d, 0x5a, 0x42, 0x41, 0x44, 0x21,
        0xff, 0xdb, 0x00, 0x04, 0x00, 0x00,
        0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
        0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
        0x11, 0x22,
        0xff, 0xd9,
    ]);
    const sanitized = __test.sanitizeJpeg(jpegWithMetadata);

    assert.ok(sanitized.byteLength < jpegWithMetadata.byteLength);
    assert.equal(findBytePair(sanitized, 0xff, 0xe1), -1);
    assert.equal(new TextDecoder().decode(sanitized).includes('MZBAD!'), false);
});

function findBytePair(bytes, first, second) {
    for (let index = 0; index < bytes.length - 1; index += 1) {
        if (bytes[index] === first && bytes[index + 1] === second) return index;
    }
    return -1;
}
