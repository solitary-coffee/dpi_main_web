import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { __test as reuseTest } from '../worker/reuse.js';
import { __test as surveyTest, handleSurveyRequest } from '../worker/survey.js';

function surveyDatabase() {
    return {
        prepare() {
            return {
                bind() { return this; },
                async first() { return null; },
            };
        },
    };
}

test('未ログインのアンケート状態確認はWorker例外にせずJSON 401を返す', async () => {
    const response = await handleSurveyRequest(
        new Request('https://dpi-bot.com/api/survey/status'),
        { REUSE_DB: surveyDatabase() },
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), {
        success: false,
        message: 'Discordでログインしてください。',
        code: 'login_required',
    });
});

test('Discord OAuthの戻り先はアンケート画面と二次利用画面だけを許可する', () => {
    assert.equal(reuseTest.safeOAuthReturnPath('/site/survey/'), '/site/survey/');
    assert.equal(reuseTest.safeOAuthReturnPath('/site/reuse/'), '/site/reuse/');
    assert.equal(reuseTest.safeOAuthReturnPath('https://example.com/'), '/site/reuse/');
});

test('GoogleフォームURLと回答編集URLをGoogle Formsへ限定する', () => {
    assert.equal(
        surveyTest.validatedFormUrl('https://docs.google.com/forms/d/e/form-id/viewform').hostname,
        'docs.google.com',
    );
    assert.equal(
        surveyTest.validatedEditUrl('https://docs.google.com/forms/d/e/form-id/viewform?edit2=secret').searchParams.get('edit2'),
        'secret',
    );
    assert.throws(() => surveyTest.validatedFormUrl('https://example.com/forms/viewform'));
    assert.throws(() => surveyTest.validatedEditUrl('https://docs.google.com/forms/d/e/form-id/viewform'));
});

test('回答トークン1項目から回答者UUIDと秘密トークンを復元する', () => {
    const participantUuid = 'c9a6fffb-b326-4599-bdd8-c29fad214afb';
    const accessToken = 'A'.repeat(43);
    assert.deepEqual(
        surveyTest.parseAccessCredential(`v1.${participantUuid}.${accessToken}`),
        { participantUuid, accessToken, legacy: false },
    );
    assert.deepEqual(
        surveyTest.parseAccessCredential(accessToken, participantUuid),
        { participantUuid, accessToken, legacy: true },
    );
    assert.throws(() => surveyTest.parseAccessCredential(`v2.${participantUuid}.${accessToken}`));
});

test('回答編集URLは暗号化して保存し復号できる', async () => {
    const secret = 'test-secret-at-least-long-enough-for-derivation';
    const editUrl = 'https://docs.google.com/forms/d/e/form-id/viewform?edit2=response-secret';
    const encrypted = await surveyTest.encryptValue(editUrl, secret);
    assert.doesNotMatch(encrypted, /response-secret/u);
    assert.equal(await surveyTest.decryptValue(encrypted, secret), editUrl);
    await assert.rejects(() => surveyTest.decryptValue(encrypted, 'wrong-secret'));
});

test('アンケート画面はフォームURLを埋め込まず認証APIから取得する', async () => {
    const [html, script, migration, appsScript] = await Promise.all([
        readFile(new URL('../site/survey/index.html', import.meta.url), 'utf8'),
        readFile(new URL('../site/survey/script.js', import.meta.url), 'utf8'),
        readFile(new URL('../migrations/0019_survey.sql', import.meta.url), 'utf8'),
        readFile(new URL('../google-apps-script/survey/Code.gs', import.meta.url), 'utf8'),
    ]);
    assert.doesNotMatch(html, /docs\.google\.com/u);
    assert.match(script, /\/api\/survey\/access/u);
    assert.match(script, /回答内容を編集する/u);
    assert.match(migration, /participant_uuid TEXT NOT NULL UNIQUE/u);
    assert.match(migration, /edit_url_ciphertext/u);
    assert.match(appsScript, /deleteResponse/u);
    assert.match(appsScript, /setAllowResponseEdits\(true\)/u);
});

test('GoogleフォームURLと連携Secretを公開設定へ保存しない', async () => {
    const wrangler = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
    assert.match(wrangler, /"SURVEY_UUID_ENTRY_ID": "266196952"/u);
    assert.match(wrangler, /"SURVEY_TOKEN_ENTRY_ID": "1806004575"/u);
    assert.doesNotMatch(wrangler, /SURVEY_FORM_URL/u);
    assert.doesNotMatch(wrangler, /SURVEY_SUBMISSION_SECRET/u);
    assert.doesNotMatch(wrangler, /SURVEY_DATA_SECRET/u);
});
