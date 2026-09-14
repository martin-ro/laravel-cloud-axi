import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { decode, encode } from '@toon-format/toon';
import { main } from '../src/cli.js';
import { createCloud, clean, present } from '../src/cloud.js';
import { context } from '../src/context.js';

const bin = resolve('bin/laravel-cloud-axi.js');
const nativeCommands = JSON.parse(readFileSync(new URL('./fixtures/native-commands.json', import.meta.url), 'utf8')).commands;
const missingLogin = 'Not authenticated. Run `cloud auth`, set LARAVEL_CLOUD_TOKEN in your environment, or run `cloud auth:token --add --token=<token>` to save one.';
const noLogin = { stderr: `${JSON.stringify({ error: true, message: missingLogin })}\n`.repeat(2), code: 1 };
const app = (id = 'app-1') => ({ id, name: 'Store', region: 'us-east-2', repositoryFullName: 'acme/store', organizationId: 'org-1', organization: { id: 'org-1', name: 'Acme' }, environmentIds: ['env-1'], environments: [{ id: 'env-1', name: 'Production', status: 'running', vanityDomain: 'store.test', slug: 'production' }] });
const environment = (id = 'env-1') => ({ id, name: 'Production', status: 'running', application: { id: 'app-1' }, instances: ['inst-1'], currentDeploymentId: 'depl-1', environmentVariables: [{ key: 'APP_KEY', value: 'private' }] });

async function run(argv, responses = [], options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cloud-axi-test-'));
  const cwd = options.cwd ?? join(root, 'project');
  if (!options.cwd) mkdirSync(cwd);
  const binary = join(root, 'native cloud.mjs');
  copyFileSync(new URL('./fixtures/cloud.txt', import.meta.url), binary);
  chmodSync(binary, 0o700);
  writeFileSync(join(root, 'steps.json'), JSON.stringify(responses.map(value => value && ['stdout', 'stderr', 'code', 'delay', 'bytes', 'childMarker'].some(key => Object.hasOwn(value, key)) ? value : { stdout: JSON.stringify(value) })));
  const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, ...options.env };
  const cloud = createCloud({ cwd, env, binary, ...options.cloudOptions });
  let text = '';
  const previousExit = process.exitCode;
  process.exitCode = 0;
  try {
    await main(argv, { ...options, cwd, cloud, stdout: { write: value => { text += value; } } });
    const calls = existsSync(join(root, 'calls.jsonl')) ? readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    for (const { argv } of calls) {
      if (argv[0] === '--version') continue;
      const signature = nativeCommands[argv[0]];
      assert.ok(signature, `Unverified native command ${argv[0]}`);
      assert.ok(argv.slice(1).filter(arg => !arg.startsWith('--')).length <= signature.arguments.length);
      for (const flag of argv.slice(1).filter(arg => arg.startsWith('--'))) assert.ok(signature.options.includes(flag.slice(2).split('=')[0]), `Unverified native flag ${flag}`);
    }
    return { code: process.exitCode ?? 0, data: decode(text), text, calls };
  } finally {
    process.exitCode = previousExit;
    rmSync(root, { recursive: true, force: true });
  }
}

const reads = ['app', 'environment', 'deployment', 'command', 'instance', 'database', 'cache', 'bucket', 'domain'];

test('native argv, cwd, closed stdin and environment isolation', async () => {
  const result = await run(['app', 'list'], [[app()]], { env: { AI_AGENT: 'agent', CLAUDECODE: '1', CODEX_SANDBOX: '1', OPENCODE: '1', CLOUD_BASE_URL: 'https://untrusted.test', PHP_INI_SCAN_DIR: '/untrusted', NODE_OPTIONS: '--bad', LARAVEL_CLOUD_TOKEN: 'ignored', LARAVEL_CLOUD_API_TOKEN: 'fallback-value' } });
  assert.equal(result.code, 0, result.text);
  const call = result.calls[0];
  assert.deepEqual(call.argv, ['application:list', '--json', '--no-interaction', '--no-ansi']);
  assert.match(call.cwd, /\/project$/);
  assert.equal(call.stdin, '');
  assert.equal(call.tty, false);
  assert.equal(call.env.CI, '1');
  assert.equal(call.env.BROWSER, 'false');
  for (const key of ['AI_AGENT', 'CLAUDECODE', 'CODEX_SANDBOX', 'OPENCODE', 'CLOUD_BASE_URL', 'PHP_INI_SCAN_DIR', 'NODE_OPTIONS', 'LARAVEL_CLOUD_TOKEN', 'LARAVEL_CLOUD_API_TOKEN']) assert.equal(call.env[key], undefined, key);
  assert.equal(result.calls.length, 1);
  assert.deepEqual(Object.keys(result.data.app[0]), ['id', 'name', 'region', 'repositoryFullName']);
});

test('native collections have honest local totals, filters and complete continuation scope', async () => {
  const apps = Array.from({ length: 103 }, (_, index) => ({ ...app(`app-${index}`), region: index === 102 ? 'eu' : 'us' }));
  const home = await run([], [apps]);
  assert.equal(home.code, 0);
  assert.ok(home.data.bin);
  assert.ok(home.data.description);
  assert.equal(home.data.count, 100);
  assert.equal(home.data.total, 103);
  assert.equal(home.data.has_more, true);
  const filtered = await run(['app', 'list', '--region', 'us', '--limit', '1'], [apps]);
  assert.equal(filtered.data.total, 102);
  assert.equal(filtered.data.count, 1);
  assert.match(filtered.data.help.at(-1), /--region 'us'.*--all/);
  assert.ok(!filtered.data.help.at(-1).includes('--limit'));
  const all = await run(['app', 'list', '--all'], [apps]);
  assert.equal(all.data.count, 103);
  assert.equal(all.calls.length, 1);
  const empty = await run(['cache', 'list', '--status', 'stopped'], [[{ id: 'cache-1', status: 'running' }]]);
  assert.equal(empty.code, 0);
  assert.equal(empty.data.total, 0);
  assert.match(empty.data.message, /0 cache.*requested filters/);
});

test('environment list uses the exact application and included native collection', async () => {
  const result = await run(['environment', 'list', '--app', 'app-1'], [app()]);
  assert.equal(result.code, 0, result.text);
  assert.equal(result.data.environment[0].id, 'env-1');
  assert.deepEqual(result.calls[0].argv.slice(0, 2), ['application:get', 'app-1']);
  assert.match(result.data.help.at(-1), /--app 'app-1'/);
  const wrong = await run(['environment', 'list', '--app', 'app-missing'], [app()]);
  assert.equal(wrong.data.code, 'TARGET_MISMATCH');
  assert.equal(wrong.data.environment, undefined);
  const incomplete = await run(['environment', 'list', '--app', 'app-1'], [{ ...app(), environments: [] }]);
  assert.equal(incomplete.data.code, 'INVALID_RESPONSE');
  const empty = await run(['environment', 'list', '--app', 'app-1'], [{ ...app(), environments: [], environmentIds: [] }]);
  assert.equal(empty.data.total, 0);
  assert.match(empty.data.message, /0 environment/);
});

test('every detail maps to native get and rejects fallback, missing and malformed targets', async () => {
  const nativeNames = { app: 'application', database: 'database-cluster' };
  const discoveryHints = { app: 'app list', environment: 'environment list --app <id>', deployment: '--fields deploymentIds,currentDeploymentId', command: 'Cloud dashboard', instance: '--fields instances', domain: '--fields domainIds', database: 'database list', cache: 'cache list', bucket: 'bucket list' };
  for (const noun of reads) {
    const result = await run([noun, 'view', 'exact-1'], [{ id: 'exact-1', buildCommand: 'build' }]);
    assert.equal(result.code, 0, result.text);
    assert.equal(result.calls[0].argv[0], `${nativeNames[noun] ?? noun}:get`);
    const fallback = await run([noun, 'view', 'missing-1'], [{ id: 'other-1', name: 'Wrong target' }]);
    assert.equal(fallback.data.code, 'TARGET_MISMATCH');
    assert.ok(fallback.data.help.some(hint => hint.includes(discoveryHints[noun])), `${noun}: ${fallback.text}`);
    assert.ok(!fallback.text.includes('Wrong target'));
    assert.equal(fallback.calls.length, 1);
  }
  assert.equal((await run(['app', 'view', 'app-1'], [{}])).data.code, 'INVALID_RESPONSE');
  assert.equal((await run(['app', 'view'])).code, 2);
});

test('unknown flags and invalid values fail before any dependency, even with help', async () => {
  for (const argv of [
    ['app', 'list', '--stat', 'running'], ['app', 'view', 'app-1', '--all'], ['app', 'list', 'extra'],
    ['app', 'list', '--unknown', '--help'], ['app', 'list', '--limit', '0'], ['app', 'list', '--limit', '2x'],
    ['app', 'list', '--all', '--limit', '2'], ['app', 'list', '--limit', '1', '--limit', '2'],
    ['app', 'list', '--fields', 'id,,name'], ['app', 'list', '--fields', '__proto__'], ['app', 'list', '--name', ''],
    ['deploy', '--env', '../bad', '--confirm'], ['deploy', '--confirm'], ['deploy', '--env', 'env-1'],
    ['deploy', '--env', 'env-1', '--confirm', '--dry-run'], ['command', 'run', '--env', 'env-1', '--confirm'],
    ['usage', '--period', '4'], ['setup', '--help', '--unknown'], ['setup', 'hooks', '--status', '--remove'],
    ['deployment', 'wait', 'depl-1', '--timeout', '3601'], ['home', '--unknown'], ['update', '--force'], ['nonesuch'], ['constructor'], ['__proto__'], ['toString'],
  ]) {
    const result = await run(argv);
    assert.equal(result.code, 2, `${argv.join(' ')}: ${result.text}`);
    assert.equal(result.calls.length, 0);
  }
  const unknown = await run(['app', 'list', '--stat', 'failed']);
  assert.match(unknown.text, /Valid flags:.*--name.*--help/);
  const page = await run(['app', 'list', '--page', '2']);
  assert.equal(page.code, 2);
  assert.match(page.text, /--page was removed.*--limit/);
});

test('help and honest blocked dry runs have no subprocess', async () => {
  const commands = [...reads.flatMap(noun => [[noun, 'list'], [noun, 'view']]), ['deploy'], ['command', 'run'], ['environment', 'start'], ['environment', 'stop'], ['deployment', 'wait'], ['command', 'wait'], ['deployment', 'logs'], ['logs'], ['usage'], ['link'], ['setup'], ['setup', 'hooks'], ['home'], ['update']];
  for (const argv of commands) {
    const result = await run([...argv, '--help']);
    assert.equal(result.code, 0, result.text);
    assert.equal(result.calls.length, 0);
    assert.ok(result.data.flags);
    assert.ok(result.data.examples.length >= 2);
  }
  for (const argv of [['deploy', '--env', 'env-1'], ['command', 'run', '--env', 'env-1', '--command', 'php artisan about; echo "quoted"'], ['environment', 'stop', 'env-1']]) {
    const dry = await run([...argv, '--dry-run']);
    assert.equal(dry.code, 0);
    assert.equal(dry.data.supported, false);
    assert.equal(dry.data.dry_run, true);
    assert.equal(dry.calls.length, 0);
    const confirmed = await run([...argv, '--confirm']);
    assert.equal(confirmed.code, 1);
    assert.equal(confirmed.data.code, 'UNSUPPORTED');
    assert.equal(confirmed.calls.length, 0);
  }
});

test('unprovable or absent native workflows fail explicitly without reads or writes', async () => {
  for (const argv of [...['deployment', 'command', 'instance', 'domain'].map(noun => [noun, 'list', '--env', 'env-1']), ['logs', '--env', 'env-1'], ['deployment', 'logs', 'depl-1'], ['usage', '--env', 'env-1'], ['update']]) {
    const result = await run(argv);
    assert.equal(result.code, 1, result.text);
    assert.equal(result.data.code, 'UNSUPPORTED');
    assert.equal(result.calls.length, 0);
  }
});

test('unsupported-list help gives supported, runnable read examples', async () => {
  const identifiers = { environment: 'env-1', deployment: 'depl-1', command: 'comm-1', instance: 'inst-1', domain: 'domain-1' };
  for (const noun of ['deployment', 'command', 'instance', 'domain']) {
    const help = await run([noun, 'list', '--help']);
    for (const example of help.data.examples) {
      const argv = example.split(' ').slice(1);
      const identifier = identifiers[argv[0]];
      const args = argv.map(value => value === '<id>' ? identifier : value);
      const data = argv[0] === 'environment' ? { ...environment(), deploymentIds: ['depl-1'], domainIds: ['domain-1'] } : { id: identifier, status: 'ready' };
      const result = await run(args, [data]);
      assert.equal(result.code, 0, `${example}: ${result.text}`);
      assert.equal(result.calls.length, 1);
      assert.ok(!example.includes(`${noun} list`));
    }
  }
});

test('structured secrets and configured fallback are redacted before text previews', async () => {
  const value = { ...environment(), buildCommand: 'x'.repeat(2000), connection: { password: 'private' }, privateKey: 'private', apiKey: 'private' };
  const short = await run(['environment', 'view', 'env-1'], [value]);
  assert.match(short.text, /truncated, 2000 chars/);
  assert.ok(short.data.help.some(line => line.includes('--full')));
  const full = await run(['environment', 'view', 'env-1', '--full'], [value]);
  assert.equal(full.data.environment.buildCommand.length, 2000);
  assert.equal(full.data.help, undefined);
  assert.ok(!full.text.includes(': private'));
  assert.equal(full.data.environment.environmentVariables, '[REDACTED]');
  const picked = await run(['environment', 'view', 'env-1', '--fields', 'environmentVariables,connection.password'], [value]);
  assert.ok(!picked.text.includes('private'));
  const token = 'synthetic-credential';
  assert.equal(clean(`\u001b[31m${token}`, token), '[REDACTED]');
  const redacted = await run(['app', 'view', 'app-1'], [{ id: 'app-1', name: `${'x'.repeat(995)}${token}` }], { env: { LARAVEL_CLOUD_API_TOKEN: token } });
  assert.ok(!redacted.text.includes('synthetic'));
  assert.deepEqual(decode(encode(present({ text: 'a,\nb:"quoted"', empty: [], value: null }))), { text: 'a,\nb:"quoted"', empty: [], value: null });
});

test('native failures, stderr, malformed JSON and progress JSON lines are never exposed or retried', async () => {
  for (const response of [
    { stderr: 'synthetic-secret traceback', code: 1 }, { stdout: '<html>synthetic-secret</html>' },
    { stdout: '{}\n{"status":"done"}' }, { stdout: 'null' }, { stdout: '{"error":true,"message":"synthetic-secret"}' },
    { stderr: JSON.stringify({ error: true, message: 'API token rejected 401 synthetic-secret' }), code: 1 },
    { stdout: '[]', stderr: 'warning synthetic-secret' },
  ]) {
    const result = await run(['app', 'list'], [response]);
    assert.equal(result.code, 1);
    assert.ok(result.data.code);
    assert.ok(!result.text.includes('synthetic-secret'));
    assert.equal(result.calls.length, 1);
  }
  const missing = await run(['app', 'list'], [], { cloudOptions: { binary: '/does-not-exist/cloud' } });
  assert.equal(missing.data.code, 'DEPENDENCY_ERROR');
});

test('ambiguous native login directs organization selection without retrying or switching sources', async () => {
  for (const message of [
    'Multiple API tokens found. Set organization_id in .cloud/config.json or use `cloud auth:token` to manage tokens.',
    'Multiple API tokens found. Run `cloud repo:config --organization=<id|name|slug>` to set a default for this repository, or use `cloud auth:token` to manage tokens.',
  ]) {
    const result = await run(['app', 'list'], [{ stderr: `${JSON.stringify({ error: true, message })}\n`.repeat(2), code: 1 }], { env: { LARAVEL_CLOUD_API_TOKEN: 'unused-fallback' } });
    assert.equal(result.code, 1);
    assert.equal(result.data.code, 'AUTH_AMBIGUOUS');
    assert.match(result.text, /cloud repo:config/);
    assert.match(result.text, /organization_id/);
    assert.ok(!result.text.includes('cloud auth`'));
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].env.LARAVEL_CLOUD_TOKEN, undefined);
  }
});

test('hard time and output bounds stop the native process and child process group', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-axi-kill-'));
  try {
    const marker = join(root, 'child-survived');
    const slow = await run(['app', 'list'], [{ delay: 5000, childMarker: marker }], { cloudOptions: { timeout: 200 } });
    assert.equal(slow.data.code, 'READ_TIMEOUT');
    assert.equal(slow.calls.length, 1);
    const large = await run(['app', 'list'], [{ bytes: 50000 }], { cloudOptions: { maxBytes: 1000 } });
    assert.equal(large.data.code, 'RESPONSE_TOO_LARGE');
    assert.equal(large.calls.length, 1);
    await new Promise(resolve => setTimeout(resolve, 1000));
    if (process.platform !== 'win32') assert.equal(existsSync(marker), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('saved native login remains first; only exact no-login permits a v0.6 environment fallback', async () => {
  const saved = await run(['app', 'list'], [[app()]], { env: { LARAVEL_CLOUD_API_TOKEN: 'synthetic-token' } });
  assert.equal(saved.calls.length, 1);
  assert.equal(saved.calls[0].env.LARAVEL_CLOUD_TOKEN, undefined);
  const result = await run(['app', 'list'], [noLogin, { stdout: 'Cloud v0.6.0' }, [app()]], { env: { LARAVEL_CLOUD_API_TOKEN: 'synthetic-token' } });
  assert.equal(result.code, 0, result.text);
  assert.equal(result.calls[0].env.LARAVEL_CLOUD_TOKEN, undefined);
  assert.deepEqual(result.calls[1].argv, ['--version']);
  assert.equal(result.calls[2].env.LARAVEL_CLOUD_TOKEN, 'synthetic-token');
  assert.deepEqual(result.calls[0].argv, result.calls[2].argv);
  const old = await run(['app', 'list'], [noLogin, { stdout: 'Cloud v0.5.0' }], { env: { LARAVEL_CLOUD_API_TOKEN: 'synthetic-token' } });
  assert.equal(old.data.code, 'FALLBACK_UNSUPPORTED');
  assert.equal(old.calls.length, 2);
  const rejected = await run(['app', 'list'], [{ stderr: JSON.stringify({ error: true, message: 'API token rejected 401' }), code: 1 }], { env: { LARAVEL_CLOUD_API_TOKEN: 'synthetic-token' } });
  assert.equal(rejected.data.code, 'AUTH_REQUIRED');
  assert.equal(rejected.calls.length, 1);
  const mixed = await run(['app', 'list'], [{ ...noLogin, stderr: `${noLogin.stderr}{"error":true,"message":"other failure"}\n` }]);
  assert.equal(mixed.calls.length, 1);
  const deniedFallback = await run(['app', 'list'], [noLogin, { stdout: 'Cloud v0.6.0' }, { stderr: JSON.stringify({ error: true, message: '401 rejected' }), code: 1 }], { env: { LARAVEL_CLOUD_API_TOKEN: 'synthetic-token' } });
  assert.equal(deniedFallback.calls.length, 3);
  assert.equal(deniedFallback.code, 1);
});

test('project .env fallback uses synthetic fixtures only, stays read-only and never copies tokens', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-axi-dotenv-'));
  const cwd = join(root, 'project');
  mkdirSync(join(cwd, '.git'), { recursive: true });
  mkdirSync(join(cwd, 'sub'));
  const path = join(cwd, '.env');
  const content = 'export LARAVEL_CLOUD_API_TOKEN="synthetic-dotenv" # comment\nUNUSED=$(touch must-not-exist)\n';
  writeFileSync(path, content, { mode: 0o600 });
  const modified = statSync(path).mtimeMs;
  const previous = process.env.LARAVEL_CLOUD_TOKEN;
  try {
    const fallback = await run(['app', 'list'], [noLogin, { stdout: 'Cloud v0.6.0' }, [app()]], { cwd: join(cwd, 'sub') });
    assert.equal(fallback.code, 0, fallback.text);
    assert.equal(fallback.calls[2].env.LARAVEL_CLOUD_TOKEN, 'synthetic-dotenv');
    assert.equal(fallback.calls[2].cwd, cwd);
    assert.equal(readFileSync(path, 'utf8'), content);
    assert.equal(statSync(path).mtimeMs, modified);
    assert.equal(process.env.LARAVEL_CLOUD_TOKEN, previous);
    assert.equal(existsSync(join(cwd, '.config')), false);
    assert.equal(existsSync(join(cwd, 'must-not-exist')), false);
    writeFileSync(path, 'LARAVEL_CLOUD_API_TOKEN="invalid token"');
    const invalid = await run(['app', 'list'], [noLogin, { stdout: 'Cloud v0.6.0' }], { cwd });
    assert.equal(invalid.data.code, 'AUTH_INVALID');
    assert.equal(invalid.calls.length, 1);
    rmSync(path);
    const absent = await run(['app', 'list'], [noLogin, { stdout: 'Cloud v0.6.0' }], { cwd });
    assert.equal(absent.data.code, 'AUTH_REQUIRED');
    mkdirSync(path);
    assert.equal((await run(['app', 'list'], [[app()]], { cwd })).code, 0, 'Saved login must not inspect .env.');
    assert.equal((await run(['app', 'list', '--help'], [], { cwd })).code, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('waits check exact native IDs, preserve status and stop without mutation retries', async () => {
  const done = await run(['deployment', 'wait', 'depl-1'], [{ id: 'depl-1', status: 'build.running' }, { id: 'depl-1', status: 'deployment.succeeded' }], { sleep: async () => {} });
  assert.equal(done.code, 0);
  assert.equal(done.calls.length, 2);
  assert.ok(done.calls.every(call => call.argv[0] === 'deployment:get'));
  const failed = await run(['command', 'wait', 'comm-1', '--full'], [{ id: 'comm-1', status: 'command.failure', exitCode: 1, output: 'x'.repeat(2000) }]);
  assert.equal(failed.code, 1);
  assert.equal(failed.data.code, 'OPERATION_FAILED');
  assert.equal(failed.data.command.output.length, 2000);
  const wrong = await run(['deployment', 'wait', 'depl-1'], [{ id: 'depl-wrong', status: 'deployment.succeeded' }]);
  assert.equal(wrong.data.code, 'WAIT_ERROR');
  assert.equal(wrong.data.deployment.id, 'depl-1');
  const deadline = await run(['deployment', 'wait', 'depl-1', '--timeout', '1'], [{ id: 'depl-1', status: 'pending' }]);
  assert.equal(deadline.data.code, 'WAIT_TIMEOUT');
  assert.equal(deadline.calls.length, 1);
});

test('native usage maps billing periods and real camelCase totals', async () => {
  const result = await run(['usage', '--period', '0'], [{ currency: 'USD', period: 0, currentSpendCents: 123, applicationCount: 1 }]);
  assert.equal(result.code, 0);
  assert.deepEqual(result.calls[0].argv.slice(0, 2), ['usage', '--period=current']);
  assert.equal(result.data.usage.currentSpendCents, 123);
  const selected = await run(['usage', '--period', '2', '--fields', 'currency,currentSpendCents'], [{ currency: 'USD', currentSpendCents: 42 }]);
  assert.deepEqual(selected.calls[0].argv.slice(0, 2), ['usage', '--period=2']);
  assert.equal(Object.keys(selected.data.usage).length, 2);
});

test('auth is not a wrapper command', async () => {
  for (const argv of [['auth'], ['auth', 'status'], ['auth', 'login'], ['auth', '--help']]) {
    const result = await run(argv);
    assert.equal(result.code, 2, `${argv.join(' ')}: ${result.text}`);
    assert.equal(result.calls.length, 0);
    assert.match(result.text, /cloud auth/);
    assert.match(result.text, /app list/);
  }
});

test('context, exact linked home and idempotent local link preserve unrelated settings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-axi-context-'));
  const cwd = join(root, 'project');
  try {
    mkdirSync(join(cwd, '.git'), { recursive: true });
    mkdirSync(join(cwd, 'sub'));
    mkdirSync(join(cwd, '.cloud'));
    writeFileSync(join(cwd, '.cloud/config.json'), '{"unrelated":true}');
    assert.equal(context(join(cwd, 'sub')).directory, cwd);
    assert.equal(context(root).directory, root);
    const linked = await run(['link', '--app', 'app-1', '--env', 'env-1'], [app(), environment()], { cwd });
    assert.equal(linked.code, 0, linked.text);
    assert.equal(linked.data.changed, true);
    const configPath = join(cwd, '.cloud/config.json');
    const original = readFileSync(configPath, 'utf8');
    assert.equal(JSON.parse(original).unrelated, true);
    assert.equal(JSON.parse(original).organization_id, 'org-1');
    assert.equal(statSync(configPath).mode & 0o777, 0o600);
    const modified = statSync(configPath).mtimeMs;
    const repeated = await run(['link', '--app', 'app-1', '--env', 'env-1'], [app(), environment()], { cwd });
    assert.equal(repeated.data.changed, false);
    assert.equal(statSync(configPath).mtimeMs, modified);
    const home = await run([], [environment()], { cwd: join(cwd, 'sub') });
    assert.equal(home.data.environment.id, 'env-1');
    assert.equal(home.data.instances_count, 1);
    assert.equal(home.calls[0].cwd, cwd);
    const mismatch = await run(['link', '--app', 'app-1', '--env', 'env-missing'], [app(), environment()], { cwd });
    assert.equal(mismatch.data.code, 'TARGET_MISMATCH');
    assert.equal(readFileSync(configPath, 'utf8'), original);
    const wrongParent = await run([], [{ ...environment(), application: { id: 'app-wrong' } }], { cwd });
    assert.equal(wrongParent.data.code, 'CONFIG_ERROR');
    writeFileSync(configPath, '{broken');
    const bad = await run([], [], { cwd });
    assert.equal(bad.data.code, 'CONFIG_ERROR');
    assert.equal(bad.calls.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bare version uses no command graph and stays close to node startup cost', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-axi-version-'));
  try {
    mkdirSync(join(root, 'bin'));
    copyFileSync(bin, join(root, 'bin/laravel-cloud-axi.js'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '9.8.7' }));
    const times = [];
    for (const flag of ['-v', '-V', '--version']) {
      const start = performance.now();
      const child = spawnSync(process.execPath, [join(root, 'bin/laravel-cloud-axi.js'), flag], { encoding: 'utf8' });
      times.push(performance.now() - start);
      assert.equal(child.status, 0);
      assert.equal(child.stdout, '9.8.7\n');
      assert.equal(child.stderr, '');
    }
    const floor = [];
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      spawnSync(process.execPath, ['-e', 'console.log(1)']);
      floor.push(performance.now() - start);
    }
    assert.ok(Math.min(...times) < Math.min(...floor) * 4, `version ${Math.min(...times)}ms, node floor ${Math.min(...floor)}ms`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('opt-in hooks install, repeat, and remove without changing unrelated settings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-axi-hooks-'));
  const previousArgv = process.argv[1];
  try {
    process.argv[1] = bin;
    const cwd = join(root, 'project');
    const homeDir = join(root, 'home');
    mkdirSync(join(cwd, '.cloud'), { recursive: true });
    mkdirSync(join(cwd, '.claude'));
    writeFileSync(join(cwd, '.cloud/config.json'), JSON.stringify({ application_id: 'app-1', environment_id: 'env-1' }));
    writeFileSync(join(cwd, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(git status)'] } }));
    const installed = await run(['setup', 'hooks'], [], { cwd, homeDir });
    assert.equal(installed.code, 0, installed.text);
    assert.equal(installed.data.hooks.claude.installed, true);
    assert.equal(installed.data.hooks.codex.installed, true);
    assert.equal(installed.data.hooks.opencode.installed, true);
    assert.equal(installed.data.hooks.codex.userFeatureEnabled, true);
    const path = join(cwd, '.claude/settings.json');
    const original = readFileSync(path, 'utf8');
    const modified = statSync(path).mtimeMs;
    await run(['setup', 'hooks'], [], { cwd, homeDir });
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.equal(statSync(path).mtimeMs, modified);
    const removed = await run(['setup', 'hooks', '--remove'], [], { cwd, homeDir });
    assert.equal(removed.data.hooks.claude.installed, false);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).permissions, { allow: ['Bash(git status)'] });
    assert.equal(existsSync(join(homeDir, '.codex/config.toml')), true);
  } finally {
    process.argv[1] = previousArgv;
    rmSync(root, { recursive: true, force: true });
  }
});


test('native scope ignores nested project config and parent configs outside Git', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-axi-native-scope-'));
  try {
    const repo = join(root, 'repo');
    const sub = join(repo, 'sub');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, '.cloud'));
    mkdirSync(join(sub, '.cloud'), { recursive: true });
    writeFileSync(join(repo, '.cloud/config.json'), '{"application_id":"app-root"}');
    writeFileSync(join(sub, '.cloud/config.json'), '{"application_id":"app-nested"}');
    writeFileSync(join(repo, '.env'), 'LARAVEL_CLOUD_API_TOKEN=root-synthetic');
    writeFileSync(join(sub, '.env'), 'LARAVEL_CLOUD_API_TOKEN=nested-synthetic');
    assert.equal(context(sub).data.application_id, 'app-root');
    const fallback = await run(['app', 'list'], [noLogin, { stdout: 'Cloud v0.6.0' }, [app()]], { cwd: sub });
    assert.equal(fallback.calls[2].cwd, repo);
    assert.equal(fallback.calls[2].env.LARAVEL_CLOUD_TOKEN, 'root-synthetic');
    const plain = join(root, 'plain');
    mkdirSync(plain);
    mkdirSync(join(root, '.cloud'));
    writeFileSync(join(root, '.cloud/config.json'), '{"application_id":"app-parent"}');
    writeFileSync(join(root, '.env'), 'LARAVEL_CLOUD_API_TOKEN=parent-synthetic');
    assert.equal(context(plain).directory, plain);
    assert.deepEqual(context(plain).data, {});
    const noFallback = await run(['app', 'list'], [noLogin], { cwd: plain });
    assert.equal(noFallback.data.code, 'AUTH_REQUIRED');
    assert.equal(noFallback.calls.length, 1, 'No fallback needs no version probe or upgrade.');
    const worktree = join(root, 'worktree');
    mkdirSync(join(worktree, 'sub'), { recursive: true });
    writeFileSync(join(worktree, '.git'), 'gitdir: ../repo/.git/worktrees/one\n');
    assert.equal(context(join(worktree, 'sub')).directory, worktree);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the executable uses CLOUD_BIN, structured stdout, and no real credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-axi-executable-'));
  try {
    const binary = join(root, 'cloud.mjs');
    copyFileSync(new URL('./fixtures/cloud.txt', import.meta.url), binary);
    chmodSync(binary, 0o700);
    writeFileSync(join(root, 'steps.json'), JSON.stringify([{ stdout: JSON.stringify([app()]) }]));
    const env = { PATH: process.env.PATH, HOME: root, USERPROFILE: root, CLOUD_BIN: binary };
    const child = spawnSync(process.execPath, [bin, 'app', 'list'], { cwd: root, env, encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 0, child.stdout);
    assert.equal(child.stderr, '');
    assert.equal(decode(child.stdout).app[0].id, 'app-1');
    assert.equal(existsSync(join(root, '.config')), false);
    assert.equal(existsSync(join(root, '.cloud')), false);
    const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8');
    const bad = spawnSync(process.execPath, [bin, 'app', 'list', '--bad'], { cwd: root, env, encoding: 'utf8', timeout: 5000 });
    assert.equal(bad.status, 2);
    assert.equal(bad.stderr, '');
    assert.match(decode(bad.stdout).error, /--bad/);
    assert.equal(readFileSync(join(root, 'calls.jsonl'), 'utf8'), calls);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
