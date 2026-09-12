import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { decode, encode } from '@toon-format/toon';
import { main } from '../src/cli.js';
import { createClient, clean, present } from '../src/cloud.js';
import { context } from '../src/context.js';

const bin = resolve('bin/laravel-cloud-axi.js');
const entity = (id, attributes = {}, relationships = {}) => ({ id, type: 'test', attributes, relationships });
const page = (data, total = data.length, next = null, current = 1) => ({ data, links: { next }, meta: { total, current_page: current } });

async function run(argv, responses = [], options = {}) {
  const calls = [];
  const cwd = options.cwd ?? mkdtempSync(join(tmpdir(), 'cloud-axi-'));
  let text = '';
  const previousExit = process.exitCode;
  process.exitCode = 0;
  const client = createClient({ token: 'test-token', fetch: async (url, request) => {
    calls.push({ url, ...request });
    const response = responses.shift();
    assert.notEqual(response, undefined, `Unexpected request: ${request.method} ${url}`);
    if (response instanceof Error) throw response;
    return response instanceof Response ? response : Response.json(response);
  } });
  try {
    await main(argv, { cwd, client, stdout: { write: value => { text += value; } }, ...options });
    return { code: process.exitCode ?? 0, data: decode(text), text, calls };
  } finally {
    process.exitCode = previousExit;
    if (!options.cwd) rmSync(cwd, { recursive: true, force: true });
  }
}

test('content-first home, compact fields, counts, filters, and next-page scope', async () => {
  const app = entity('app-1', { name: 'App, One', region: 'us-east-2', repository: { full_name: 'acme/app' }, ignored: 'large' });
  const home = await run([], [page([app], 8, 'https://cloud.laravel.com/api/applications?page=2')]);
  assert.equal(home.code, 0);
  assert.equal(home.data.total, 8);
  assert.equal(home.data.count, 1);
  assert.equal(home.data.has_more, true);
  assert.ok(home.data.bin);
  assert.ok(home.data.description);
  assert.equal(Object.keys(home.data.app[0]).length, 4);
  assert.equal(home.data.app[0].name, 'App, One');
  const list = await run(['deployment', 'list', '--env', 'env-1', '--status', 'failed'], [page([], 9, '?page=2')]);
  assert.equal(list.calls[0].url.searchParams.get('filter[status]'), 'failed');
  assert.ok(list.data.help.some(value => value.includes('--env') && value.includes('env-1') && value.includes('--status') && value.includes('--page')));
});

test('unknown input and invalid values fail before any API request', async () => {
  for (const args of [
    ['app', 'list', '--stat', 'running'], ['app', 'view', 'app-1', '--all'], ['app', 'list', 'extra'],
    ['deploy', '--env', 'env-1'], ['deploy', '--confirm'], ['deploy', '--env', '../bad', '--confirm'],
    ['command', 'run', '--env', 'env-1', '--confirm'], ['app', 'list', '--page', '0'],
    ['app', 'list', '--page', '2x'], ['app', 'list', '--fields', 'id,,name'], ['app', 'list', '--fields', '__proto__'],
    ['app', 'list', '--name', ''], ['app', 'list', '--page', '1', '--page', '2'],
    ['deploy', '--env', 'env-1', '--confirm', '--dry-run'], ['deploy', '--env', 'env-1', '--confirm', '--timeout', '5'],
    ['logs', '--env', 'env-1', '--cursor', 'next'], ['logs', '--env', 'env-1', '--type', 'unknown'],
    ['logs', '--env', 'env-1', '--from', 'not-a-time'], ['logs', '--env', 'env-1', '--since', '0h'],
    ['usage', '--period', '4'], ['nonesuch'], ['constructor'], ['__proto__'], ['toString'], ['setup', '--help', '--unknown'],
    ['logs', '--env', 'env-1', '--from', '1'], ['logs', '--env', 'env-1', '--from', '2026-01-01'],
    ['deployment', 'wait', 'deploy-1', '--timeout', '3601'],
  ]) {
    const result = await run(args);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(result.calls.length, 0, args.join(' '));
    assert.ok(result.data.error);
  }
});

test('per-command help and dry runs do not need credentials or make requests', async () => {
  for (const argv of [
    ['app', 'list', '--help'], ['environment', 'view', '--help'], ['environment', 'stop', '--help'],
    ['command', 'run', '--help'], ['deployment', 'wait', '--help'], ['deployment', 'logs', '--help'],
    ['auth', '--help'], ['setup', 'hooks', '--help'], ['link', '--help'], ['usage', '--help'], ['logs', '--help'],
  ]) {
    const result = await run(argv);
    assert.equal(result.code, 0);
    assert.equal(result.calls.length, 0);
    assert.ok(result.data.command);
  }
  for (const argv of [
    ['deploy', '--env', 'env-1', '--dry-run'],
    ['command', 'run', '--env', 'env-1', '--command', 'php artisan about; echo "quoted"', '--dry-run'],
    ['environment', 'stop', 'env-1', '--dry-run'],
  ]) {
    const result = await run(argv);
    assert.equal(result.code, 0);
    assert.equal(result.data.dry_run, true);
    assert.equal(result.calls.length, 0);
  }
});

test('pagination follows same-resource links and preserves totals without losing rows', async () => {
  const result = await run(['app', 'list', '--all'], [
    page([entity('app-1')], 2, '?page=2'), page([entity('app-2')], 2, null, 2),
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.data.count, 2);
  assert.equal(result.data.total, 2);
  assert.equal(result.data.has_more, false);
  assert.equal(result.calls.length, 2);
  for (const next of ['https://evil.example/api/applications', 'https://cloud.laravel.com/api/commands', 'https://cloud.laravel.com/api/applications?page=1']) {
    const bad = await run(['app', 'list', '--all'], [page([], 1, next)]);
    assert.equal(bad.code, 1);
    assert.equal(bad.calls.length, 1);
  }
});

test('empty lists are definitive and secret fields stay redacted with --full', async () => {
  const empty = await run(['cache', 'list'], [page([])]);
  assert.equal(empty.code, 0);
  assert.equal(empty.data.count, 0);
  assert.match(empty.data.message, /0 cache/);
  const detail = entity('env-1', { environment_variables: [{ key: 'PASSWORD', value: 'private' }], connection: { password: 'private' }, build_command: 'x'.repeat(2000) });
  const normal = await run(['environment', 'view', 'env-1'], [{ data: detail }]);
  assert.match(normal.text, /truncated, 2000 chars/);
  assert.ok(normal.data.help.some(line => line.includes('--full')));
  const full = await run(['environment', 'view', 'env-1', '--full'], [{ data: detail }]);
  assert.equal(full.data.environment.build_command.length, 2000);
  assert.ok(!full.text.includes('private'));
  assert.equal(full.data.environment.environment_variables, '[REDACTED]');
  assert.equal(full.data.help, undefined);
  assert.deepEqual(decode(encode(present({ text: 'a,\nb:"quoted"', empty: [], value: null }))), { text: 'a,\nb:"quoted"', empty: [], value: null });
  assert.equal(clean('test-token', 'test-token'), '[REDACTED]');
  assert.equal(clean({ 'test-token': 'value' }, 'test-token')['[REDACTED]'], '[REDACTED]');
  assert.deepEqual(clean({ api_key: 'private', APP_KEY: 'private', apiKey: 'private', cookie: 'private' }), {
    api_key: '[REDACTED]', APP_KEY: '[REDACTED]', apiKey: '[REDACTED]', cookie: '[REDACTED]',
  });
});

test('HTTP errors are structured, redact the token, and never retry', async () => {
  for (const status of [401, 403, 404, 422, 429, 500]) {
    const response = Response.json({ message: 'test-token denied', errors: { name: ['Invalid name'] } }, { status, headers: { 'retry-after': '30' } });
    const result = await run(['auth'], [response]);
    assert.equal(result.code, 1);
    assert.equal(result.data.http_status, status);
    assert.ok(!result.text.includes('test-token'));
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].redirect, 'error');
    assert.equal(result.calls[0].headers.Authorization, 'Bearer test-token');
  }
  const boundary = await run(['auth'], [Response.json({ message: `${'x'.repeat(995)}test-token` }, { status: 403 })]);
  assert.ok(!boundary.text.includes('test-'), 'Redact before truncation so token fragments cannot leak.');
  const html = await run(['auth'], [new Response('<html>Proxy error</html>')]);
  assert.equal(html.code, 1);
  assert.equal(html.data.code, 'INVALID_RESPONSE');
  assert.ok(!html.text.includes('<html>'));
  const big = await run(['auth'], [new Response('x'.repeat(5 * 1024 * 1024 + 1))]);
  assert.equal(big.data.code, 'RESPONSE_TOO_LARGE');
  const offline = await run(['deploy', '--env', 'env-1', '--confirm'], [new Error('connection reset')]);
  assert.equal(offline.data.code, 'OUTCOME_UNKNOWN');
  assert.equal(offline.calls.length, 1);
  assert.match(offline.text, /before repeating/);
});

test('auth redacts successful responses and environment billing includes its selected cost', async () => {
  const previous = process.env.LARAVEL_CLOUD_TOKEN;
  process.env.LARAVEL_CLOUD_TOKEN = 'test-token';
  try {
    const auth = await run(['auth'], [{ data: entity('org-1', { name: 'test-token' }) }]);
    assert.equal(auth.data.organization.name, '[REDACTED]');
  } finally {
    if (previous === undefined) delete process.env.LARAVEL_CLOUD_TOKEN;
    else process.env.LARAVEL_CLOUD_TOKEN = previous;
  }
  const usage = await run(['usage', '--env', 'env-1'], [{ data: { summary: { current_spend_cents: 400 }, environment_usage: { total_cost_cents: 123, items: [] } }, meta: { currency: 'USD' } }]);
  assert.equal(usage.data.usage.environment_usage.total_cost_cents, 123);
  assert.equal(usage.calls[0].url.searchParams.get('environment'), 'env-1');
});

test('deploy and command send exact targets and return operation state in the same call', async () => {
  const deployment = await run(['deploy', '--env', 'env-1', '--confirm'], [{ data: entity('deploy-1', { status: 'pending' }) }]);
  assert.equal(deployment.code, 0);
  assert.equal(deployment.calls[0].url.pathname, '/api/environments/env-1/deployments');
  assert.equal(deployment.calls[0].method, 'POST');
  assert.equal(deployment.data.deployment.id, 'deploy-1');
  const command = 'php artisan about; echo "hello"';
  const result = await run(['command', 'run', '--env', 'env-2', '--command', command, '--confirm'], [{ data: entity('cmd-1', { status: 'pending' }) }]);
  assert.deepEqual(JSON.parse(result.calls[0].body), { command });
  assert.equal(result.data.command.id, 'cmd-1');
});

test('wait handles real Cloud statuses, failures and resumed operations', async () => {
  const success = await run(['deploy', '--env', 'env-1', '--confirm', '--wait'], [
    { data: entity('deploy-1', { status: 'pending' }) },
    { data: entity('deploy-1', { status: 'build.succeeded' }) },
    { data: entity('deploy-1', { status: 'deployment.succeeded' }) },
  ], { sleep: async () => {} });
  assert.equal(success.code, 0);
  assert.equal(success.calls.length, 3);
  assert.equal(success.calls.filter(call => call.method === 'POST').length, 1);
  const failed = await run(['deployment', 'wait', 'deploy-1'], [{ data: entity('deploy-1', { status: 'build.failed', failure_reason: 'Build failed' }) }]);
  assert.equal(failed.code, 1);
  assert.equal(failed.data.deployment.failure_reason, 'Build failed');
  const command = await run(['command', 'wait', 'cmd-1'], [{ data: entity('cmd-1', { status: 'command.failure', exit_code: 1, output: 'failed output' }) }]);
  assert.equal(command.code, 1);
  assert.equal(command.data.command.output, 'failed output');
  const completeFailure = await run(['command', 'wait', 'cmd-1', '--full'], [{ data: entity('cmd-1', { status: 'command.failure', output: 'x'.repeat(2000) }) }]);
  assert.equal(completeFailure.data.command.output.length, 2000);
  const shortenedFailure = await run(['command', 'wait', 'cmd-1'], [{ data: entity('cmd-1', { status: 'command.failure', output: 'x'.repeat(2000) }) }]);
  assert.match(shortenedFailure.data.command.output, /truncated, 2000 chars/);
  const timeout = await run(['deployment', 'wait', 'deploy-1', '--timeout', '1'], [{ data: entity('deploy-1', { status: 'pending' }) }]);
  assert.equal(timeout.code, 1);
  assert.equal(timeout.data.code, 'WAIT_TIMEOUT');
  assert.equal(timeout.data.deployment.id, 'deploy-1');
  assert.equal(timeout.calls.length, 1);
});

test('start/stop are no-ops when the requested state already exists', async () => {
  for (const [action, status] of [['start', 'running'], ['start', 'deploying'], ['stop', 'stopped']]) {
    const result = await run(['environment', action, 'env-1', '--confirm'], [{ data: entity('env-1', { status }) }]);
    assert.equal(result.code, 0);
    assert.equal(result.data.changed, false);
    assert.equal(result.calls.length, 1);
  }
  const stopped = await run(['environment', 'stop', 'env-1', '--confirm'], [
    { data: entity('env-1', { status: 'running' }) }, { data: entity('env-1', { status: 'stopped' }) },
  ]);
  assert.equal(stopped.data.changed, true);
  assert.equal(stopped.calls[1].url.pathname, '/api/environments/env-1/stop');
});

test('log cursor keeps its exact window and filters; deployment logs include previews', async () => {
  const result = await run(['logs', '--env', 'env-1', '--from', '2026-01-01T00:00:00Z', '--to', '2026-01-01T01:00:00Z', '--query', 'error'], [
    { data: [{ logged_at: '2026-01-01T00:01:00Z', level: 'error', type: 'application', message: 'oops' }], meta: { cursor: 'cursor-2' } },
  ]);
  assert.equal(result.code, 0);
  assert.equal(result.data.total, null);
  assert.ok(result.data.help[0].includes('--from'));
  assert.ok(result.data.help[0].includes('--to'));
  assert.ok(result.data.help[0].includes('--query'));
  assert.ok(result.data.help[0].includes('--cursor'));
  const logs = await run(['deployment', 'logs', 'deploy-1'], [{ data: { build: { available: true, steps: [{ output: 'x'.repeat(2000) }] }, deploy: { available: false, steps: [] } }, meta: { deployment_status: 'build.failed' } }]);
  assert.equal(logs.code, 0);
  assert.match(logs.text, /truncated/);
});

test('context stays at the repo boundary, uses the cwd outside Git and preserves config keys', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-axi-context-'));
  try {
    const cwd = join(root, 'repo');
    mkdirSync(join(cwd, '.git'), { recursive: true });
    mkdirSync(join(cwd, 'sub'));
    assert.equal(context(join(cwd, 'sub')).directory, cwd);
    const plain = join(root, 'plain');
    mkdirSync(plain);
    assert.equal(context(plain).directory, plain);
    mkdirSync(join(cwd, '.cloud'));
    writeFileSync(join(cwd, '.cloud/config.json'), JSON.stringify({ unrelated: true }));
    const responses = [{ data: entity('app-1') }, { data: entity('env-1', { status: 'running', name: 'Production' }, { application: { data: { id: 'app-1' } } }) }];
    const linked = await run(['link', '--app', 'app-1', '--env', 'env-1'], [...responses], { cwd });
    assert.equal(linked.code, 0);
    assert.equal(linked.data.changed, true);
    const config = JSON.parse(readFileSync(join(cwd, '.cloud/config.json'), 'utf8'));
    assert.equal(config.unrelated, true);
    assert.equal(config.environment_id, 'env-1');
    assert.equal(statSync(join(cwd, '.cloud/config.json')).mode & 0o777, 0o600);
    const again = await run(['link', '--app', 'app-1', '--env', 'env-1'], [...responses], { cwd });
    assert.equal(again.data.changed, false);
    const home = await run([], [responses[1]], { cwd: join(cwd, 'sub') });
    assert.equal(home.data.environment.name, 'Production');
    assert.equal(home.calls[0].url.pathname, '/api/environments/env-1');
    const noDefaultMutation = await run(['deploy', '--confirm'], [], { cwd });
    assert.equal(noDefaultMutation.code, 2);
    const wrong = await run(['link', '--app', 'app-2', '--env', 'env-1'], [...responses], { cwd });
    assert.equal(wrong.code, 2);
    assert.equal(JSON.parse(readFileSync(join(cwd, '.cloud/config.json'), 'utf8')).application_id, 'app-1');
    writeFileSync(join(cwd, '.cloud/config.json'), '{broken');
    const broken = await run([], [], { cwd });
    assert.equal(broken.data.code, 'CONFIG_ERROR');
    assert.equal(broken.calls.length, 0);
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

test('executable version probes bypass the command graph; errors use stdout, not stderr', () => {
  const root = mkdtempSync(join(tmpdir(), 'cloud-axi-bin-'));
  try {
    mkdirSync(join(root, 'bin'));
    copyFileSync(bin, join(root, 'bin/laravel-cloud-axi.js'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '9.8.7' }));
    for (const flag of ['-v', '-V', '--version']) {
      const child = spawnSync(process.execPath, [join(root, 'bin/laravel-cloud-axi.js'), flag], { encoding: 'utf8' });
      assert.equal(child.status, 0);
      assert.equal(child.stdout, '9.8.7\n');
      assert.equal(child.stderr, '');
    }
    const child = spawnSync(process.execPath, [bin, 'auth'], { cwd: root, env: { ...process.env, LARAVEL_CLOUD_TOKEN: '' }, encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.equal(child.stderr, '');
    assert.equal(decode(child.stdout).code, 'AUTH_REQUIRED');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
