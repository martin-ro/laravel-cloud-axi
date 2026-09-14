import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { AxiError } from 'axi-sdk-js';
import { resource, present, AUTH_GUIDANCE } from './cloud.js';
import { context, saveContext, setupHooks } from './context.js';

export const DESCRIPTION = 'Inspect Laravel Cloud through official commands with compact output and exact read targets.';
export const GUIDANCE = [
  'laravel-cloud-axi app list',
  'laravel-cloud-axi environment list --app <id>',
  'laravel-cloud-axi environment view <id>',
  'laravel-cloud-axi deployment wait <id>',
  'laravel-cloud-axi command view <id>',
  'laravel-cloud-axi usage',
];
export const RULES = [
  ...AUTH_GUIDANCE,
  'Use exact IDs. Native fields use camelCase. --fields selects fields; --full expands text, never structured secrets.',
  'Supported lists default to 100 rows. --all shows the complete returned collection. Filters are local exact matches.',
  'Remote writes, logs, environment billing and unsafe scoped history lists are unsupported. --dry-run only reports this limit; it cannot enable a write.',
  'Read commands can use .cloud/config.json defaults. Link and hook setup are explicit, idempotent local writes.',
  'Output is TOON. Exit codes: 0 success or local no-op, 1 failure, 2 invalid input.',
  'Hooks are opt-in for Claude Code, Codex, and OpenCode. No session transcripts are collected.',
];

const RESOURCES = {
  app: { native: 'application', fields: 'id,name,region,repositoryFullName', filters: ['name', 'region', 'slug'] },
  environment: { native: 'environment', parent: 'app', fields: 'id,name,status,vanityDomain', filters: ['name', 'status', 'slug'] },
  deployment: { native: 'deployment', parent: 'env', fields: 'id,status,branchName,commitHash', filters: ['status', 'branch_name', 'commit_hash'] },
  command: { native: 'command', parent: 'env', fields: 'id,status,command,exitCode', filters: ['status', 'command'] },
  instance: { native: 'instance', parent: 'env', fields: 'id,name,type,size', filters: ['name', 'type', 'size'] },
  database: { native: 'database-cluster', fields: 'id,name,type,status', filters: ['type', 'region', 'status'] },
  cache: { native: 'cache', fields: 'id,name,type,status', filters: ['type', 'region', 'status'] },
  bucket: { native: 'bucket', fields: 'id,name,status,visibility', filters: ['type', 'status', 'visibility'] },
  domain: { native: 'domain', parent: 'env', fields: 'id,name,hostnameStatus,sslStatus', filters: ['name', 'hostname_status', 'ssl_status'] },
};
const READ = { fields: 'Comma-separated native camelCase field paths; default: compact lists, all detail fields', full: 'Complete text; default: 1000 characters per string' };
const WAIT = { timeout: 'Wait deadline in seconds, 1..3600; default: 300' };
const WRITE = { confirm: 'Legacy flag; remote writes are blocked', 'dry-run': 'Explain the blocked operation without a native call' };
const BOOLEAN = new Set(['help', 'full', 'all', 'confirm', 'dry-run', 'wait', 'status', 'remove']);

function usage(message, suggestions = []) {
  throw new AxiError(message, 'USAGE_ERROR', suggestions);
}

function parse(args, name, flags = {}, positionals = 0, description = '') {
  const options = Object.fromEntries(Object.keys({ ...flags, help: '' }).map(key => [key, { type: BOOLEAN.has(key) ? 'boolean' : 'string' }]));
  // Filter flags named status are strings; only setup uses a boolean status flag.
  if (flags.status && name !== 'setup hooks') options.status.type = 'string';
  if (args.some(arg => arg === '--page' || arg.startsWith('--page='))) usage('--page was removed. Lists now use --limit (default 100) or --all.', ['Run `laravel-cloud-axi ' + name + ' --help`.']);
  let parsed;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true, tokens: true });
  } catch (error) {
    usage(error.message, [`Valid flags: ${Object.keys(options).map(key => `--${key}`).join(', ')}`, `Run \`laravel-cloud-axi ${name} --help\`.`]);
  }
  const seen = new Set();
  for (const token of parsed.tokens.filter(token => token.kind === 'option')) {
    if (seen.has(token.name)) usage(`Duplicate flag --${token.name}.`);
    seen.add(token.name);
  }
  if (parsed.positionals.length > positionals) usage(`Unexpected argument for ${name}.`, [`Run \`laravel-cloud-axi ${name} --help\`.`]);
  for (const [key, value] of Object.entries(parsed.values)) {
    if (typeof value === 'string' && (!value.trim() || value.includes('\0'))) usage(`--${key} requires a non-empty value.`);
  }
  const required = { 'environment list': ' --app <id>', deploy: ' --env <id>', 'command run': ' --env <id> --command "<command>"', link: ' --app <id> --env <id>' }[name] ?? '';
  const example = `laravel-cloud-axi ${name}${positionals ? ' <id>' : ''}${required}`;
  const help = parsed.values.help ? {
    command: `laravel-cloud-axi ${name}${positionals ? ' <id>' : ''}`,
    description,
    flags: { ...flags, help: 'Show this reference without native calls' },
    examples: [
      `${example}${flags.confirm ? ' --dry-run' : ''}`,
      `${example}${flags.confirm ? ' --help' : flags.all ? ' --all' : flags.full ? ' --full' : ' --help'}`,
    ],
  } : null;
  return { flags: parsed.values, args: parsed.positionals, help };
}

function discovery(name) {
  if (name === 'command') return 'Use a command ID from the Cloud dashboard with `laravel-cloud-axi command view <id>`.';
  const path = { deployment: 'environment view <id> --fields deploymentIds,currentDeploymentId', instance: 'environment view <id> --fields instances', domain: 'environment view <id> --fields domainIds' }[name]
    ?? (name === '--env' || name.toLowerCase().includes('environment') ? 'environment list --app <id>' : RESOURCES[name] && !RESOURCES[name].parent ? `${name} list` : 'app list');
  return `laravel-cloud-axi ${path}`;
}

function id(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,199}$/.test(value)) usage(`${name} requires an exact resource ID.`, [discovery(name)]);
  return value;
}

function integer(value, name, fallback, max = 100000) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) usage(`--${name} must be an integer from 1 to ${max}.`);
  return Number(value);
}

function fields(value) {
  if (!value) return undefined;
  const list = value.split(',');
  if (list.some(field => !/^[a-zA-Z_][\w]*(\.[a-zA-Z_][\w]*)*$/.test(field) || field.split('.').some(key => ['__proto__', 'constructor', 'prototype'].includes(key)))) usage('Invalid --fields. Use comma-separated field paths.');
  return list;
}

function pick(value, names) {
  if (!names) return value;
  return Object.fromEntries(names.map(name => [name, name.split('.').reduce((item, key) => item && Object.hasOwn(item, key) ? item[key] : undefined, value) ?? null]));
}

function scoped(flag, flags, runtime) {
  return id(flags[flag] ?? context(runtime.cwd).data[flag === 'app' ? 'application_id' : 'environment_id'], `--${flag}`);
}

function template(name, flags, overrides = {}) {
  const values = { ...flags, ...overrides };
  delete values.help;
  return `laravel-cloud-axi ${name}${Object.entries(values).filter(([, value]) => value !== undefined && value !== false).map(([key, value]) => value === true ? ` --${key}` : ` --${key} '${String(value).replaceAll("'", "'\\''")}'`).join('')}`;
}

export function homeGuidance() {
  return ['laravel-cloud-axi environment view <id>', 'laravel-cloud-axi usage', 'laravel-cloud-axi --help'];
}

function unsupported(message, hint = 'laravel-cloud-axi --help') {
  throw new AxiError(message, 'UNSUPPORTED', [hint]);
}

async function detail(noun, identifier, runtime, options) {
  const value = resource(await runtime.cloud.json([`${RESOURCES[noun].native}:get`, identifier], options));
  if (value.id !== identifier) throw new AxiError('Native resolution returned a different ID. Result withheld.', 'TARGET_MISMATCH', [discovery(noun)]);
  return value;
}

function collection(value) {
  if (!Array.isArray(value)) throw new AxiError('Expected a native collection.', 'INVALID_RESPONSE');
  return value.map(item => resource(item));
}

async function listResource(noun, args, runtime) {
  const spec = RESOURCES[noun];
  const options = { ...READ, limit: 'Maximum displayed rows, 1..100000; default: 100', all: 'Show all returned rows; native lists already fetch all pages', ...Object.fromEntries(spec.filters.map(key => [key, 'Local exact filter'])) };
  if (spec.parent) options[spec.parent] = 'Resource ID; default: linked project';
  const unavailable = spec.parent === 'env';
  const parsed = parse(args, `${noun} list`, options, 0, unavailable ? 'Unsupported: native list output cannot prove the resolved environment or complete scope. Use a known ID with view.' : `List ${noun === 'database' ? 'database clusters' : noun} resources.`);
  if (parsed.help) {
    if (unavailable) parsed.help.examples = noun === 'command'
      ? ['laravel-cloud-axi command view <id>', 'laravel-cloud-axi command view <id> --full']
      : [discovery(noun), `laravel-cloud-axi ${noun} view <id>`];
    return parsed.help;
  }
  const { flags } = parsed;
  const chosen = fields(flags.fields) ?? spec.fields.split(',');
  const limit = integer(flags.limit, 'limit', 100);
  if (flags.all && flags.limit) usage('Use either --all or --limit.');
  if (unavailable) {
    if (flags.env) id(flags.env, '--env');
    unsupported(`${noun} list cannot prove the native environment scope, including empty results. No read was sent.`, discovery(noun));
  }
  const parent = spec.parent ? scoped(spec.parent, flags, runtime) : null;
  let items;
  if (noun === 'environment') {
    const app = await detail('app', parent, runtime);
    items = collection(app.environments);
    if (!Array.isArray(app.environmentIds) || app.environmentIds.length !== items.length || items.some(item => !app.environmentIds.includes(item.id))) {
      throw new AxiError('Included environments do not match the application relationship. Result withheld.', 'INVALID_RESPONSE');
    }
  } else items = collection(await runtime.cloud.json([`${spec.native}:list`]));
  items = items.filter(item => spec.filters.every(key => flags[key] === undefined || item[key] === flags[key]));
  const shown = flags.all ? items : items.slice(0, limit);
  const help = [`laravel-cloud-axi ${noun} view <id>`];
  if (noun === 'app') help.push('laravel-cloud-axi environment list --app <id>');
  if (noun === 'environment') help.push(template('link', { app: parent, env: '<id>' }));
  if (shown.length < items.length) help.push(template(`${noun} list`, { ...flags, ...(parent ? { [spec.parent]: parent } : {}), limit: undefined, all: true }));
  return present({
    scope: parent ? `application ${parent}` : 'selected organization',
    count: shown.length, total: items.length, has_more: shown.length < items.length,
    ...(items.length ? {} : { message: `0 ${noun} results in this scope with the requested filters.` }),
    [noun]: shown.map(item => pick(item, chosen)), help,
  }, flags);
}

const SUCCESS = { deployment: ['deployment.succeeded'], command: ['command.success'] };
const FAILURE = { deployment: ['build.failed', 'deployment.failed', 'failed', 'cancelled'], command: ['command.failure'] };

async function waitFor(noun, identifier, flags, runtime) {
  const signal = AbortSignal.timeout(integer(flags.timeout, 'timeout', 300, 3600) * 1000);
  let current = { id: identifier };
  try {
    while (true) {
      current = await detail(noun, identifier, runtime, { signal });
      if (SUCCESS[noun].includes(current.status) && (noun !== 'command' || current.exitCode == null || current.exitCode === 0)) return present({ [noun]: pick(current, fields(flags.fields)) }, flags);
      if (FAILURE[noun].includes(current.status) || (noun === 'command' && current.exitCode != null && current.exitCode !== 0)) {
        const error = new AxiError(`${noun} failed.`, 'OPERATION_FAILED');
        error.result = present({ [noun]: pick(current, fields(flags.fields)) }, flags);
        throw error;
      }
      await (runtime.sleep ?? sleep)(2000, undefined, { signal });
    }
  } catch (error) {
    if (error.code === 'OPERATION_FAILED') throw error;
    const failure = new AxiError(signal.aborted ? 'Wait deadline reached. The remote operation continues.' : 'Could not read operation status. No operation was started or retried.', signal.aborted ? 'WAIT_TIMEOUT' : 'WAIT_ERROR', [...(error.suggestions ?? []), `laravel-cloud-axi ${noun} wait <id> --timeout 300`]);
    failure.result = present({ [noun]: pick(current, fields(flags.fields)) }, flags);
    throw failure;
  }
}

function blockedWrite(name, args) {
  const isCommand = name === 'command run';
  const environmentAction = name.startsWith('environment ');
  const parsed = parse(args, name, { ...READ, ...WRITE, ...(environmentAction ? {} : { ...WAIT, env: 'Required exact environment ID', wait: 'Legacy flag; cannot enable remote writes', ...(isCommand ? { command: 'Remote command as one quoted string' } : {}) }) }, environmentAction ? 1 : 0, 'Unsupported: native commands cannot guarantee exact write targets. Start and stop have no native command. Use the Cloud dashboard yourself.');
  if (parsed.help) return parsed.help;
  const { flags } = parsed;
  id(environmentAction ? parsed.args[0] : flags.env, '--env');
  fields(flags.fields);
  integer(flags.timeout, 'timeout', 300, 3600);
  if (isCommand && (!flags.command || flags.command.length > 150000)) usage('--command is required and must contain at most 150000 characters.');
  if (flags.confirm && flags['dry-run']) usage('Use either --confirm or --dry-run.');
  if (flags['dry-run'] && flags.wait) usage('--wait cannot be used with --dry-run.');
  if (flags.timeout && !flags.wait) usage('--timeout requires --wait.');
  if (!flags.confirm && !flags['dry-run']) usage('Use --dry-run to inspect this unsupported operation. --confirm cannot enable it.');
  if (flags['dry-run']) return { dry_run: true, supported: false, command: name, message: 'No subprocess started. Native target fallback makes writes unsafe; start and stop have no native command.', help: ['Use the Laravel Cloud dashboard yourself for this operation.'] };
  unsupported(`${name} is not safe through native delegation. No operation was sent.`, 'Use the Laravel Cloud dashboard yourself for this operation.');
}

function logs(args) {
  const parsed = parse(args, 'logs', { ...READ, env: 'Legacy environment ID', since: 'Legacy time window', from: 'Legacy start time', to: 'Legacy end time', type: 'Removed: native logs has no type filter', query: 'Removed: native logs has no text filter', cursor: 'Removed: native logs does not expose pagination' }, 0, 'Unsupported: native logs cannot prove the resolved environment or expose pagination. Use the Cloud dashboard for logs.');
  if (parsed.help) return parsed.help;
  unsupported('Environment logs cannot prove exact scope or completeness through native delegation.', 'Use the Laravel Cloud dashboard yourself to inspect logs.');
}

export const COMMAND_NAMES = [...Object.keys(RESOURCES), 'deploy', 'logs', 'usage', 'auth', 'link', 'setup', 'home', 'update'];

export async function execute(command, args, runtime) {
  if (command === 'deploy') return blockedWrite('deploy', args);
  if (command === 'logs') return logs(args);
  if (RESOURCES[command]) {
    const action = args[0] && !args[0].startsWith('-') ? args.shift() : 'list';
    if (command === 'command' && action === 'run') return blockedWrite('command run', args);
    if (command === 'environment' && ['start', 'stop'].includes(action)) return blockedWrite(`environment ${action}`, args);
    if (action === 'list') return listResource(command, args, runtime);
    const waiting = action === 'wait' && ['deployment', 'command'].includes(command);
    const deploymentLogs = command === 'deployment' && action === 'logs';
    if (action !== 'view' && !waiting && !deploymentLogs) usage(`Unknown action ${action} for ${command}.`, [`Run \`laravel-cloud-axi ${command} --help\`.`]);
    const parsed = parse(args, `${command} ${action}`, { ...READ, ...(waiting ? WAIT : {}) }, 1, deploymentLogs ? 'Unsupported: no native deployment logs command. Use the Cloud dashboard.' : waiting ? 'Wait for an existing operation. Never starts another operation.' : 'Read exact resource details. Native fallback to another ID is an error. Secrets remain redacted.');
    if (parsed.help) return parsed.help;
    const identifier = id(parsed.args[0], command);
    const chosen = fields(parsed.flags.fields);
    if (deploymentLogs) unsupported('There is no native deployment logs command.', 'Use the Laravel Cloud dashboard yourself to inspect build and deployment logs.');
    if (waiting) return waitFor(command, identifier, parsed.flags, runtime);
    return present({ [command]: pick(await detail(command, identifier, runtime), chosen) }, parsed.flags);
  }
  if (command === 'auth') usage('Login belongs to the official CLI. This wrapper does not implement auth.', ['Run `cloud auth` yourself.', 'laravel-cloud-axi app list']);
  if (command === 'usage') {
    const parsed = parse(args, 'usage', { ...READ, period: '0=current, 1=previous, 2 or 3; default: 0', env: 'Unsupported: native environment billing cannot prove exact scope' }, 0, 'Read organization billing totals in integer cents. Environment billing is unsupported.');
    if (parsed.help) return parsed.help;
    const { flags } = parsed;
    if (flags.period && !/^[0-3]$/.test(flags.period)) usage('--period must be 0, 1, 2, or 3.');
    const chosen = fields(flags.fields);
    if (flags.env) {
      id(flags.env, '--env');
      unsupported('Environment billing cannot prove the final native target.', 'laravel-cloud-axi usage');
    }
    const value = await runtime.cloud.json(['usage', `--period=${!flags.period || flags.period === '0' ? 'current' : flags.period}`]);
    if (Array.isArray(value) || !Number.isInteger(value.currentSpendCents)) throw new AxiError('Expected native billing totals.', 'INVALID_RESPONSE');
    return present({ usage: pick(value, chosen ?? ['currency', 'period', 'currentSpendCents', 'applicationCount', 'applicationsTotalCostCents', 'resourcesTotalCostCents', 'addonsTotalCostCents']) }, flags);
  }
  if (command === 'link') {
    const parsed = parse(args, 'link', { app: 'Required application ID', env: 'Required environment ID' }, 0, 'Validate exact IDs and save native .cloud/config.json defaults, including organization_id from the application. No token is saved. Repeat calls are local no-ops.');
    if (parsed.help) return parsed.help;
    const app = id(parsed.flags.app, '--app');
    const env = id(parsed.flags.env, '--env');
    const current = context(runtime.cwd);
    const application = await detail('app', app, runtime);
    const environment = await detail('environment', env, runtime);
    if (environment.application?.id !== app) usage('The environment does not belong to this application.');
    const organization = id(application.organization?.id ?? application.organizationId, 'Organization');
    return { changed: saveContext(current, app, env, organization), app, env, organization, config: current.path, help: ['laravel-cloud-axi', 'laravel-cloud-axi setup hooks'] };
  }
  if (command === 'setup') {
    if (args.length === 1 && args[0] === '--help') return { command: 'laravel-cloud-axi setup hooks [--status|--remove]', description: 'Opt-in project hooks for Claude Code, Codex, and OpenCode.', flags: { status: 'Inspect', remove: 'Remove managed hooks' }, examples: ['laravel-cloud-axi setup hooks', 'laravel-cloud-axi setup hooks --status', 'laravel-cloud-axi setup hooks --remove'] };
    if (args.shift() !== 'hooks') usage('Expected setup hooks.', ['laravel-cloud-axi setup hooks --help']);
    const parsed = parse(args, 'setup hooks', { status: 'Inspect without writing', remove: 'Remove only managed hooks' }, 0, 'Install project session hooks. Also enables hooks in ~/.codex/config.toml. Requires a linked project and persistent executable.');
    if (parsed.help) return parsed.help;
    if (parsed.flags.status && parsed.flags.remove) usage('Use either --status or --remove.');
    return setupHooks(context(runtime.cwd), parsed.flags.status ? 'status' : parsed.flags.remove ? 'remove' : 'install', runtime.homeDir);
  }
  if (command === 'home') {
    const parsed = parse(args, 'home', {}, 0, DESCRIPTION);
    if (parsed.help) return parsed.help;
    const current = context(runtime.cwd);
    if (!current.data.application_id) return listResource('app', [], runtime);
    const app = id(current.data.application_id, 'Linked application');
    if (!current.data.environment_id) return listResource('environment', ['--app', app], runtime);
    const env = id(current.data.environment_id, 'Linked environment');
    const value = await detail('environment', env, runtime);
    if (value.application?.id !== app) throw new AxiError('Linked environment no longer belongs to the linked application.', 'CONFIG_ERROR');
    return present({ app, environment: pick(value, ['id', 'name', 'status', 'vanityDomain', 'currentDeploymentId']), instances_count: Array.isArray(value.instances) ? value.instances.length : null, help: homeGuidance() });
  }
  if (command === 'update') {
    const parsed = parse(args, 'update', {}, 0, 'Automatic package updates are not supported. Install a reviewed checkout yourself.');
    if (parsed.help) return parsed.help;
    unsupported('Automatic package updates are not supported.', 'Install a reviewed checkout with `npm install -g .` yourself.');
  }
  usage(`Unknown command ${command}.`, ['laravel-cloud-axi --help']);
}
