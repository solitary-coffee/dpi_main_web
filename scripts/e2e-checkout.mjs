// 通し試験: Stripe Checkout（テストモード）の支払い画面をブラウザで操作する。
// puppeteer-core の場所は PUPPETEER_CORE（例: file:///E:/dpi_work/e2e-node/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js）、Chrome は CHROME_PATH。
import { tmpdir } from 'node:os';
import path from 'node:path';

let browser = null;
async function openBrowser() {
 if (browser) return browser;
 const puppeteer = (await import(process.env.PUPPETEER_CORE || 'puppeteer-core')).default;
 browser = await puppeteer.launch({executablePath: process.env.CHROME_PATH || 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', headless: true,
  args: ['--lang=ja', '--no-first-run'], userDataDir: path.join(tmpdir(), `dpi-e2e-chrome-${process.pid}`)});
 return browser;
}
export async function closeBrowser() { if (browser) await browser.close().catch(() => {}); browser = null; }

// テストカードで支払う。支払えたら、戻り先の URL を返す。拒否されたら例外。
export async function payInBrowser(url, card = '4242424242424242') {
 const target = new URL(url);
 if (target.protocol !== 'https:' || target.hostname !== 'checkout.stripe.com' || !target.pathname.includes('cs_test_')) throw new Error('テストモードの支払い画面ではありません。');
 const page = await (await openBrowser()).newPage();
 const click = selector => page.$eval(selector, element => element.click());
 try {
  await page.setViewport({width: 1200, height: 1400});
  await page.goto(url, {waitUntil: 'networkidle2', timeout: 60000});
  if (!await page.$('#cardNumber') && await page.$('[data-testid="card-accordion-item-button"]')) await click('[data-testid="card-accordion-item-button"]');
  await page.waitForSelector('#cardNumber', {visible: true, timeout: 30000});
  const email = await page.$('input#email');
  if (email && !await page.evaluate(element => element.value, email)) await page.type('#email', 'e2e@example.com', {delay: 10});
  await page.type('#cardNumber', card, {delay: 25});
  await page.type('#cardExpiry', '1234', {delay: 25});
  await page.type('#cardCvc', '123', {delay: 25});
  if (await page.$('#billingName')) await page.type('#billingName', 'E2E TEST', {delay: 10});
  // Link への登録（電話番号の入力が要る）は外す
  if (await page.$('#enableStripePass') && await page.$eval('#enableStripePass', element => element.checked)) await click('#enableStripePass');
  await click('[data-testid="hosted-payment-submit-button"]');
  const result = await Promise.race([
   page.waitForFunction(() => location.hostname !== 'checkout.stripe.com', {timeout: 60000}).then(() => 'done'),
   page.waitForFunction(() => /拒否|承認されませんでした|declined/i.test(document.body.innerText), {timeout: 60000}).then(() => 'declined'),
  ]);
  if (result === 'declined') throw Object.assign(new Error('カードが拒否されました。'), {declined: true});
  return page.url();
 } finally { await page.close().catch(() => {}); }
}

// 契約管理画面（Stripe のカスタマーポータル、テストモード）で解約する。画面の文を返す。解約できないときは例外。
export async function cancelInPortal(url) {
 if (new URL(url).hostname !== 'billing.stripe.com' || !/(?:\/|secret=)test_/.test(url)) throw new Error('テストモードの契約管理画面ではありません。');
 const page = await (await openBrowser()).newPage();
 const labels = () => page.$$eval('a,button', items => items.filter(item => item.offsetParent !== null).map(item => item.innerText.trim()).filter(Boolean));
 const press = async pattern => {
  const done = await page.$$eval('a,button', (items, source) => { const found = items.find(item => item.offsetParent !== null && new RegExp(source, 'i').test(item.innerText.trim())); found?.click(); return !!found; }, pattern);
  if (!done) throw Object.assign(new Error(`契約管理画面に「${pattern}」がありません: ${(await labels()).join('／')}`), {text: await page.evaluate(() => document.body.innerText)});
 };
 try {
  await page.setViewport({width: 1200, height: 1400});
  await page.goto(url, {waitUntil: 'networkidle2', timeout: 60000});
  await page.waitForFunction(() => document.body.innerText.length > 200, {timeout: 30000});
  await press('キャンセル|解約|^Cancel (subscription|plan)');
  await new Promise(resolve => setTimeout(resolve, 5000));
  await press('キャンセル|解約|^Cancel (subscription|plan)');
  await new Promise(resolve => setTimeout(resolve, 6000));
  return await page.evaluate(() => document.body.innerText);
 } catch (error) { if (process.env.E2E_SHOT) await page.screenshot({path: process.env.E2E_SHOT}).catch(() => {}); throw error; }
 finally { await page.close().catch(() => {}); }
}
