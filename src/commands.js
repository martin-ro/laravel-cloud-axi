import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { AxiError } from 'axi-sdk-js';
import { resource, present } from './cloud.js';
import { context, saveContext, setupHooks } from './context.js';

export const DESCRIPTION = 'Inspect Laravel Cloud resources, read logs, and run guarded deployment operations.';
export const GUIDANCE = [
  'laravel-cloud-axi app list',
  'laravel-cloud-axi environment list --app <id>',
  'laravel-cloud-axi logs --env <id> --since 1h',
  'laravel-cloud-axi deploy --env <id> --dry-run',
  'laravel-cloud-axi deploy --env <id> --confirm --wait',
  'laravel-cloud-axi command run --env <id> --command "php artisan about" --confirm --wait',
];

const RESOURCES = {
  app: { path: 'applications', fields: 'id,name,region,repository.full_name', filters: ['name', 'region', 'slug'] },
  environment: { path: 'environments', parent: 'app', fields: 'id,name,status,vanity_domain', filters: ['name', 'status', 'slug'] },
  deployment: { path: 'deployments', parent: 'env', fields: 'id,status,branch_name,commit_hash', filters: ['status', 'branch_name', 'commit_hash'] },
  command: { path: 'commands', parent: 'env', fields: 'id,status,command,exit_code', filters: ['status', 'command'] },
  instance: { path: 'instances', parent: 'env', fields: 'id,name,type,size', filters: ['name', 'type', 'size'] },
  database: { path: 'databases/clusters', fields: 'id,name,type,status', filters: ['type', 'region', 'status'] },
  cache: { path: 'caches', fields: 'id,name,type,status', filters: ['type', 'region', 'status'] },
  bucket: { path: 'buckets', fields: 'id,name,status,visibility', filters: ['type', 'status', 'visibility'] },
  domain: { path: 'domains', parent: 'env', fields: 'id,name,hostname_status,ssl_status', filters: ['name', 'hostname_status', 'ssl_status'] },
};
const READ = { fields: 'Comma-separated field paths; default: compact list fields, all detail fields', full: 'Complete text; default: 1000 characters per string' };
const WAIT = { timeout: 'Wait deadline in seconds, 1..3600; default: 300' };
const WRITE = { confirm: 'Required to send a mutation', 'dry-run': 'Preview the request without API calls' };
const BOOLEAN = new Set(['help', 'full', 'all', 'confirm', 'dry-run', 'wait', 'status', 'remove']);

function usage(message, suggestions = []) {
  throw new AxiError(message, 'USAGE_ERROR', suggestions);
}

function parse(args, name, flags = {}, positionals = 0, description = '') {
  const options = Object.fromEntries(Object.keys({ ...flags, help: '' }).map(key => [key, { type: BOOLEAN.has(key) ? 'boolean' : 'string' }]));
  // Filter flags named status are strings; only setup uses a boolean status flag.
  if (flags.status && name !== 'setup hooks') options.status.type = 'string';
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
  const required = { deploy: ' --env <id>', 'command run': ' --env <id> --command "<command>"', link: ' --app <id> --env <id>' }[name] ?? '';
  const example = `laravel-cloud-axi ${name}${positionals ? ' <id>' : ''}${required}`;
  const help = parsed.values.help ? {
    command: `laravel-cloud-axi ${name}${positionals ? ' <id>' : ''}`,
    description,
    flags: { ...flags, help: 'Show this reference without API calls' },
    examples: [
      `${example}${flags.confirm ? ' --dry-run' : ''}`,
      `${example}${flags.confirm ? ' --confirm' : flags.all ? ' --all' : flags.full ? ' --full' : ' --help'}`,
    ],
  } : null;
  return { flags: parsed.values, args: parsed.positionals, help };
}

function id(value, name) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,199}$/.test(value)) {
    const hint = name === '--env' || name.toLowerCase().includes('environment') ? 'environment list --app <id>'
      : RESOURCES[name]?.parent === 'env' ? `${name} list --env <id>` : 'app list';
    usage(`${name} requires an exact resource ID.`, [`Run \`laravel-cloud-axi ${hint}\` to find IDs.`]);
  }
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

function url(path, query) {
  const search = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined));
  return `${path}${search.size ? `?${search}` : ''}`;
}

function template(name, flags, overrides = {}) {
  const values = { ...flags, ...overrides };
  delete values.help;
  return `laravel-cloud-axi ${name}${Object.entries(values).filter(([, value]) => value !== undefined && value !== false).map(([key, value]) => value === true ? ` --${key}` : ` --${key} '${String(value).replaceAll("'", "'\\''")}'`).join('')}`;
}

export function homeGuidance(env) {
  return [template('logs', { env, since: '1h' }), template('deployment list', { env }), 'laravel-cloud-axi --help'];
}

async function listResource(noun, args, runtime) {
  const spec = RESOURCES[noun];
  const options = { ...READ, page: 'API page number; default: 1', all: 'Read all pages from --page, maximum 100 pages', ...Object.fromEntries(spec.filters.map(key => [key, 'Server-side exact filter'])) };
  if (spec.parent) options[spec.parent] = 'Resource ID; default: linked project';
  const parsed = parse(args, `${noun} list`, options, 0, noun === 'database' ? 'List database clusters.' : `List ${noun} resources.`);
  if (parsed.help) return parsed.help;
  const { flags } = parsed;
  const chosen = fields(flags.fields) ?? spec.fields.split(',');
  const page = integer(flags.page, 'page', 1);
  let path = spec.path;
  if (spec.parent) {
    const parent = scoped(spec.parent, flags, runtime);
    flags[spec.parent] = parent;
    path = `${spec.parent === 'app' ? 'applications' : 'environments'}/${parent}/${spec.path}`;
  }
  const query = { page, ...Object.fromEntries(spec.filters.map(key => [`filter[${key}]`, flags[key]])) };
  const result = await runtime.client.list(url(path, query), { all: flags.all });
  const help = [`laravel-cloud-axi ${noun} view <id>`];
  if (noun === 'app') help.push('laravel-cloud-axi environment list --app <id>');
  if (noun === 'environment') help.push('laravel-cloud-axi link --app <id> --env <id>');
  if (result.has_more) help.push(template(`${noun} list`, flags, { page: result.page + 1 }));
  return present({
    count: result.items.length,
    total: result.total,
    page: result.page,
    has_more: result.has_more,
    ...(result.items.length ? {} : { message: `0 ${noun} results in this scope.` }),
    [noun]: result.items.map(item => pick(item, chosen)),
    help,
  }, flags);
}

const SUCCESS = { deployment: ['deployment.succeeded'], command: ['command.success'] };
const FAILURE = { deployment: ['build.failed', 'deployment.failed', 'failed', 'cancelled'], command: ['command.failure'] };

async function waitFor(noun, identifier, flags, runtime, initial) {
  const seconds = integer(flags.timeout, 'timeout', 300, 3600);
  const signal = AbortSignal.timeout(seconds * 1000);
  let current = initial ?? { id: identifier };
  const help = [`laravel-cloud-axi ${noun} wait <id> --timeout 300`];
  try {
    while (true) {
      current = resource((await runtime.client.request(`${RESOURCES[noun].path}/${identifier}`, { signal })).data);
      if (SUCCESS[noun].includes(current.status) && (noun !== 'command' || current.exit_code == null || Number(current.exit_code) === 0)) {
        return present({ [noun]: pick(current, fields(flags.fields)) }, flags);
      }
      if (FAILURE[noun].includes(current.status) || (noun === 'command' && current.exit_code != null && Number(current.exit_code) !== 0)) {
        const error = new AxiError(`${noun} failed.`, 'OPERATION_FAILED', noun === 'deployment' ? ['laravel-cloud-axi deployment logs <id>'] : []);
        error.result = present({ [noun]: current }, flags);
        throw error;
      }
      await (runtime.sleep ?? sleep)(2000, undefined, { signal });
    }
  } catch (error) {
    if (error.code === 'OPERATION_FAILED') throw error;
    const failure = new AxiError(signal.aborted ? 'Wait deadline reached. The remote operation continues.' : 'Could not read operation status. The remote operation may still be running.', signal.aborted ? 'WAIT_TIMEOUT' : 'WAIT_ERROR', [...(error.suggestions ?? []), ...help]);
    failure.result = present({ [noun]: current }, flags);
    throw failure;
  }
}

async function mutate(noun, args, runtime) {
  const isCommand = noun === 'command';
  const name = isCommand ? 'command run' : 'deploy';
  const parsed = parse(args, name, {
    ...READ, ...WRITE, ...WAIT, env: 'Required explicit environment ID; never uses project defaults',
    ...(isCommand ? { command: 'Required remote command as one quoted string' } : {}),
    wait: 'Wait for success or failure; default: return the new operation ID',
  }, 0, isCommand ? 'Run a remote command. Each confirmed call creates a new operation.' : 'Deploy the latest commit. Each confirmed call creates a new deployment.');
  if (parsed.help) return parsed.help;
  const { flags } = parsed;
  const env = id(flags.env, '--env');
  fields(flags.fields);
  integer(flags.timeout, 'timeout', 300, 3600);
  if (isCommand && (!flags.command || flags.command.length > 150000)) usage('--command is required and must contain at most 150000 characters.');
  if (flags.confirm && flags['dry-run']) usage('Use either --confirm or --dry-run, not both.');
  if (flags['dry-run'] && flags.wait) usage('--wait cannot be used with --dry-run.');
  if (flags.timeout && !flags.wait) usage('--timeout requires --wait.');
  if (!flags.confirm && !flags['dry-run']) usage('This operation requires --confirm or --dry-run.', [`laravel-cloud-axi ${name} --env <id>${isCommand ? ' --command "<command>"' : ''} --dry-run`]);
  const path = `environments/${env}/${isCommand ? 'commands' : 'deployments'}`;
  const body = isCommand ? { command: flags.command } : undefined;
  if (flags['dry-run']) return present({ dry_run: true, method: 'POST', path, ...(body ? { body } : {}), warning: 'No request sent. Confirmation can change production and incur costs.' }, flags);
  let result;
  try {
    result = resource((await runtime.client.request(path, { method: 'POST', body })).data);
  } catch (error) {
    error.suggestions = [...(error.suggestions ?? []), `laravel-cloud-axi ${isCommand ? 'command' : 'deployment'} list --env ${env}`, 'Check for an existing operation before repeating the request.'];
    throw error;
  }
  const kind = isCommand ? 'command' : 'deployment';
  if (flags.wait) return waitFor(kind, result.id, flags, runtime, result);
  return present({ [kind]: pick(result, fields(flags.fields)), help: [`laravel-cloud-axi ${kind} wait <id>`, `laravel-cloud-axi ${kind} view <id>`] }, flags);
}

async function environmentAction(action, args, runtime) {
  const parsed = parse(args, `environment ${action}`, { ...WRITE, full: READ.full }, 1, action === 'stop' ? 'Stop the environment and cancel active deployments.' : 'Start the environment and deploy its latest commit.');
  if (parsed.help) return parsed.help;
  const { flags } = parsed;
  const identifier = id(parsed.args[0], 'environment');
  if (flags.confirm && flags['dry-run']) usage('Use either --confirm or --dry-run, not both.');
  if (!flags.confirm && !flags['dry-run']) usage('This operation requires --confirm or --dry-run.');
  const path = `environments/${identifier}/${action}`;
  if (flags['dry-run']) return { dry_run: true, method: 'POST', path };
  const current = resource((await runtime.client.request(`environments/${identifier}`)).data);
  if ((action === 'stop' && current.status === 'stopped') || (action === 'start' && ['running', 'deploying'].includes(current.status))) {
    return present({ changed: false, environment: current }, flags);
  }
  const result = resource((await runtime.client.request(path, { method: 'POST' })).data);
  return present({ changed: true, [action === 'start' ? 'deployment' : 'environment']: result, help: [action === 'start' ? 'laravel-cloud-axi deployment wait <id>' : 'laravel-cloud-axi environment view <id>'] }, flags);
}

async function logs(args, runtime) {
  const parsed = parse(args, 'logs', {
    ...READ, env: 'Environment ID; default: linked project', since: 'Time window, for example 30m, 1h, 2d; default: 1h',
    from: 'ISO 8601 start time, instead of --since', to: 'ISO 8601 end time; default: now',
    type: 'all, application, or access; default: application', query: 'Server-side text search', cursor: 'Next cursor from the previous response; keep the same time window',
  }, 0, 'Read one page of environment logs. Total count is not supplied by the API.');
  if (parsed.help) return parsed.help;
  const { flags } = parsed;
  const chosen = fields(flags.fields) ?? ['logged_at', 'level', 'type', 'message'];
  if (flags.from && flags.since) usage('Use either --from or --since.');
  if (flags.cursor && (!flags.from || !flags.to)) usage('--cursor requires the previous --from and --to values.');
  const type = flags.type ?? 'application';
  if (!['all', 'application', 'access'].includes(type)) usage('--type must be all, application, or access.');
  const since = flags.since ?? '1h';
  if (!/^\d+[mhd]$/.test(since) || Number(since.slice(0, -1)) < 1) usage('--since must be a positive number followed by m, h, or d.');
  for (const key of ['from', 'to']) {
    if (flags[key] && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(flags[key])) usage(`--${key} requires an ISO 8601 timestamp with a timezone.`);
  }
  const to = flags.to ? new Date(flags.to) : new Date();
  const from = flags.from ? new Date(flags.from) : new Date(to.getTime() - Number(since.slice(0, -1)) * { m: 60000, h: 3600000, d: 86400000 }[since.at(-1)]);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) usage('Log timestamps must be valid and --from must be before --to.');
  const env = scoped('env', flags, runtime);
  const range = { from: from.toISOString(), to: to.toISOString() };
  const response = await runtime.client.request(url(`environments/${env}/logs`, { ...range, type, query: flags.query, cursor: flags.cursor }));
  if (!Array.isArray(response.data)) throw new AxiError('Expected a log collection.', 'INVALID_RESPONSE');
  const cursor = response.meta?.cursor || null;
  return present({
    count: response.data.length, total: null, ...range, has_more: Boolean(cursor), cursor,
    ...(response.data.length ? {} : { message: '0 logs in this time window.' }),
    logs: response.data.map(item => pick(item, chosen)),
    ...(cursor ? { help: [template('logs', { ...flags, env, ...range, since: undefined, cursor })] } : {}),
  }, flags);
}

export const COMMAND_NAMES = [...Object.keys(RESOURCES), 'deploy', 'logs', 'usage', 'auth', 'link', 'setup', 'home'];

export async function execute(command, args, runtime) {
  if (command === 'deploy') return mutate('deployment', args, runtime);
  if (command === 'logs') return logs(args, runtime);
  if (RESOURCES[command]) {
    const action = args[0] && !args[0].startsWith('-') ? args.shift() : 'list';
    if (command === 'command' && action === 'run') return mutate('command', args, runtime);
    if (command === 'environment' && ['start', 'stop'].includes(action)) return environmentAction(action, args, runtime);
    if (action === 'list') return listResource(command, args, runtime);
    const waiting = action === 'wait' && ['deployment', 'command'].includes(command);
    const deploymentLogs = command === 'deployment' && action === 'logs';
    if (action !== 'view' && !waiting && !deploymentLogs) usage(`Unknown action ${action} for ${command}.`, [`Run \`laravel-cloud-axi ${command} --help\`.`]);
    const parsed = parse(args, `${command} ${action}`, { ...READ, ...(waiting ? WAIT : {}) }, 1, waiting ? 'Wait for the existing operation; never starts another one.' : 'Read resource details. Secrets remain redacted, including with --full.');
    if (parsed.help) return parsed.help;
    const identifier = id(parsed.args[0], command);
    const chosen = fields(parsed.flags.fields);
    if (waiting) return waitFor(command, identifier, parsed.flags, runtime);
    const response = await runtime.client.request(`${RESOURCES[command].path}/${identifier}${deploymentLogs ? '/logs' : ''}`);
    const data = deploymentLogs ? response.data : resource(response.data);
    return present({ [deploymentLogs ? 'logs' : command]: pick(data, chosen), ...(deploymentLogs ? { status: response.meta?.deployment_status } : {}) }, parsed.flags);
  }
  if (command === 'auth') {
    const parsed = parse(args, 'auth', {}, 0, 'Check the organization for LARAVEL_CLOUD_TOKEN. No login prompts or stored tokens.');
    return parsed.help ?? present({ organization: resource((await runtime.client.request('meta/organization')).data) });
  }
  if (command === 'usage') {
    const parsed = parse(args, 'usage', { ...READ, period: '0=current, 1=previous, 2 or 3; default: 0', env: 'Optional environment ID; default: entire organization' }, 0, 'Read billing totals in integer cents.');
    if (parsed.help) return parsed.help;
    const { flags } = parsed;
    if (flags.period && !/^[0-3]$/.test(flags.period)) usage('--period must be 0, 1, 2, or 3.');
    if (flags.env) id(flags.env, '--env');
    const chosen = fields(flags.fields);
    const response = await runtime.client.request(url('usage', { period: flags.period ?? 0, environment: flags.env }));
    return present({ usage: pick(response.data, chosen ?? ['summary', 'application_totals.total_cost_cents', 'application_totals.application_count', 'resources.total_cost_cents', 'addons.total_cost_cents', ...(flags.env ? ['environment_usage'] : [])]), meta: response.meta }, flags);
  }
  if (command === 'link') {
    const parsed = parse(args, 'link', { app: 'Required application ID', env: 'Required environment ID' }, 0, 'Validate and save project defaults to .cloud/config.json. No token is saved.');
    if (parsed.help) return parsed.help;
    const app = id(parsed.flags.app, '--app');
    const env = id(parsed.flags.env, '--env');
    const current = context(runtime.cwd);
    await runtime.client.request(`applications/${app}`);
    const environment = resource((await runtime.client.request(`environments/${env}?include=application`)).data);
    if (environment.application_id !== app) usage('The environment does not belong to this application.');
    return { changed: saveContext(current, app, env), app, env, config: current.path, help: ['laravel-cloud-axi', 'laravel-cloud-axi setup hooks'] };
  }
  if (command === 'setup') {
    if (args.length === 1 && args[0] === '--help') return { command: 'laravel-cloud-axi setup hooks [--status|--remove]', description: 'Opt-in project hooks for Claude Code, Codex, and OpenCode. Codex also enables hooks in the user config.' };
    if (args.shift() !== 'hooks') usage('Expected setup hooks.', ['laravel-cloud-axi setup hooks --help']);
    const parsed = parse(args, 'setup hooks', { status: 'Inspect without writing', remove: 'Remove only managed hooks' }, 0, 'Install project session hooks. Also enables hooks in ~/.codex/config.toml. Requires a linked project and a persistent executable.');
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
    const value = resource((await runtime.client.request(`environments/${env}?include=application,currentDeployment,instances`)).data);
    if (value.application_id !== app) throw new AxiError('Linked environment no longer belongs to the linked application.', 'CONFIG_ERROR');
    return present({
      app, environment: pick(value, ['id', 'name', 'status', 'vanity_domain', 'current_deployment_id', 'instances_count']),
      help: homeGuidance(env),
    });
  }
  usage(`Unknown command ${command}.`, ['laravel-cloud-axi --help']);
}
