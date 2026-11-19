// GitHub Actions（.github/workflows/deploy-main-dpi.yml）の代わりに、手元の PC から本番へデプロイする。
//
//   node scripts/deploy-local.mjs            … テスト → 構文チェック → D1 マイグレーション → デプロイ
//   node scripts/deploy-local.mjs --dry-run  … テストと構文チェックだけ（本番は変えない）
//
// 条件: main ブランチで、未コミットの変更が無く、origin/main と同じ版であること（違えば止まる）。
// Worker の Secrets（Stripe・アンケートなど）は Cloudflare 側に保存済みのものがそのまま使われる。
// Windows だけで落ちる既知のテストは KNOWN_FAILURES に書いたものだけ許す（ほかが落ちたら止める）。
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dryRun = process.argv.includes('--dry-run');
const WRANGLER = ['--yes', 'wrangler@4.157.0'];
const KNOWN_FAILURES = [
    // Windows では改行・パスの違いで落ちる（Linux の GitHub Actions では通っていた）
    '配信系統はEC2とLambda・SQSバックアップを分離しSQS稼働状態を表示する',
];

function run(command, args, { capture = false } = {}) {
    const result = spawnSync(command, args, {
        cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
        stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    });
    return { status: result.status ?? 1, stdout: result.stdout || '', out: `${result.stdout || ''}${result.stderr || ''}` };
}

function step(title) {
    console.log(`\n=== ${title} ===`);
}

function fail(message) {
    console.error(`\n中止: ${message}`);
    process.exit(1);
}

step('版の確認');
const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true }).stdout.trim();
if (branch !== 'main') fail(`main ブランチではありません（今は ${branch}）。`);
if (run('git', ['status', '--porcelain'], { capture: true }).stdout.trim()) fail('未コミットの変更があります。');
run('git', ['fetch', '-q', 'origin', 'main'], { capture: true });
const local = run('git', ['rev-parse', 'HEAD'], { capture: true }).stdout.trim();
const remote = run('git', ['rev-parse', 'origin/main'], { capture: true }).stdout.trim();
if (local !== remote) fail('origin/main と版が違います。git pull してから実行してください。');
console.log(`main ${local.slice(0, 7)}`);

step('テスト（node --test）');
const tests = run('node', ['--test', '--test-reporter=spec'], { capture: true });
const failed = [...tests.out.matchAll(/^\s*✖ (.+?) \(\d/gmu)].map(match => match[1].trim())
    .filter((name, index, all) => all.indexOf(name) === index && name !== 'failing tests:');
const unexpected = failed.filter(name => !KNOWN_FAILURES.includes(name));
const summary = tests.out.match(/ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/u);
console.log(summary ? `成功 ${summary[1]} 件 / 失敗 ${summary[2]} 件（既知の失敗 ${failed.length - unexpected.length} 件）` : tests.out.slice(-2000));
if (unexpected.length) fail(`想定外のテスト失敗があります:\n- ${unexpected.join('\n- ')}`);
if (!summary) fail('テストの結果を読み取れませんでした。');

step('構文チェック（npm run check）');
if (run('npm', ['run', 'check', '--silent']).status !== 0) fail('構文チェックに失敗しました。');

if (dryRun) {
    console.log('\n--dry-run のため、ここで終わります（本番は変えていません）。');
    process.exit(0);
}

step('D1 マイグレーション（REUSE_DB, remote）');
if (run('npx', [...WRANGLER, 'd1', 'migrations', 'apply', 'REUSE_DB', '--remote']).status !== 0) fail('D1 マイグレーションに失敗しました。');

step('デプロイ（wrangler deploy）');
const deploy = run('npx', [...WRANGLER, 'deploy'], { capture: true });
const version = deploy.out.match(/Current Version ID: ([0-9a-f-]+)/u);
if (deploy.status !== 0 || !version) {
    console.error(deploy.out.slice(-3000));
    fail('デプロイに失敗しました。');
}
console.log(`\n完了: main ${local.slice(0, 7)} を本番へデプロイしました（Version ${version[1]}）。`);
