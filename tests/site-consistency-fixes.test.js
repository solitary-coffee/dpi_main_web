import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFile(resolve(root, path), 'utf8');

test('問い合わせ完了ページのローカルリンクが実在する', async () => {
  const path = resolve(root, 'site/supp/tha.html');
  const html = await readFile(path, 'utf8');
  const links = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map(match => match[1]);
  for (const link of links.filter(value => !/^(?:https?:|#)/.test(value))) {
    const target = link.startsWith('/') ? resolve(root, `.${link}`) : resolve(dirname(path), link);
    await assert.doesNotReject(access(target), `${link} が実在する`);
  }
  assert.match(html, /href="\/index\.html"/);
});

test('改定履歴が古い日付から並び、利用規約の各項目が改行される', async () => {
  const terms = await read('terms/terms.md');
  assert.match(terms, /11月 15日 改定<br>\r?\n・2026 年  11月 25日 改定/);

  const policy = await read('terms/policy.md');
  const dates = [...policy.slice(policy.indexOf('### 改定履歴')).matchAll(/2026年(\d+)月(\d+)日改定/g)]
    .map(([, month, day]) => Number(month) * 100 + Number(day));
  assert.deepEqual(dates, [...dates].sort((a, b) => a - b));
});

test('表示名は Basic で、内部識別子と既存 Stripe 商品名は維持する', async () => {
  for (const directory of ['site/supporter', 'site/supporter-admin']) {
    for (const name of await readdir(resolve(root, directory))) {
      if (!/\.(?:html|js|css|json)$/.test(name)) continue;
      assert.doesNotMatch(await read(`${directory}/${name}`), /BASIC/, `${directory}/${name}`);
    }
  }

  const workerFiles = (await readdir(resolve(root, 'worker'))).filter(name => name.endsWith('.js'));
  for (const name of workerFiles) {
    const visibleText = (await read(`worker/${name}`)).replaceAll('SUPPORTER_ROLE_BASIC', '');
    assert.doesNotMatch(visibleText, /BASIC/, `worker/${name}`);
  }

  const billing = await read('worker/supporter-billing.js');
  assert.match(billing, /supporter:Object\.freeze\(\{id:'supporter',name:'Basic'/);
  assert.match(await read('scripts/stripe-setup-lib.mjs'), /DPI-Bot BASIC プラン/);
});
