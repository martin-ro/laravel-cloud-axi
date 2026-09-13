import { AxiError } from 'axi-sdk-js';
import { spawn } from 'node:child_process';
import { parseEnv, stripVTControlCharacters } from 'node:util';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { context } from './context.js';

export const AUTH_HELP = 'Run `cloud auth` yourself to save or renew login, then run `laravel-cloud-axi auth`. This tool never invokes login.';
export const AUTH_GUIDANCE = [
  AUTH_HELP,
  'The official executable owns authentication and token storage. Native reads can remove expired saved tokens.',
  'Saved login comes first. Only an explicit no-login error permits LARAVEL_CLOUD_API_TOKEN from the environment, then project .env, with native v0.6.0 or later.',
  'Native v0.5.0 and v0.6.0 can attempt browser OAuth when all saved tokens expire. Closed stdin and noninteractive flags do not prevent that upstream behavior. This wrapper bounds each subprocess to 10 seconds; it cannot guarantee no native login attempt.',
];
const NO_LOGIN = new Set([
  'Not authenticated. Run `cloud auth` or `cloud auth:token --add` to add an API token.',
  'Not authenticated. Run `cloud auth`, set LARAVEL_CLOUD_TOKEN in your environment, or run `cloud auth:token --add --token=<token>` to save one.',
]);
const READ_COMMANDS = new Set(['application:list', 'application:get', 'environment:get', 'deployment:get', 'command:get', 'instance:get', 'database-cluster:list', 'database-cluster:get', 'cache:list', 'cache:get', 'bucket:list', 'bucket:get', 'domain:get', 'usage']);
const SECRET_KEY = /password|token|secret|credential|private.?key|access.?key|api.?key|app.?key|authorization|cookie|environment.?variables|connection|database.?url/i;

export function clean(value, secrets = process.env.LARAVEL_CLOUD_API_TOKEN) {
  if (typeof value === 'string') {
    let text = stripVTControlCharacters(value);
    for (const secret of [secrets].flat().filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
    return text;
  }
  if (Array.isArray(value)) return value.map(item => clean(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [clean(key, secrets), SECRET_KEY.test(key) ? '[REDACTED]' : clean(item, secrets)]));
  return value;
}

// Inherit runtime paths and network trust, not agent markers, PHP injection, or API-host overrides.
function childEnvironment(env) {
  const keys = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TMPDIR', 'TEMP', 'TMP', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy'];
  return { ...Object.fromEntries(keys.filter(key => env[key] !== undefined).map(key => [key, env[key]])), CI: '1', TERM: 'dumb', NO_COLOR: '1', BROWSER: 'false' };
}

function nativeError(stderr) {
  try {
    const values = stderr.split('\n').filter(Boolean).map(line => JSON.parse(line));
    const message = values[0]?.message;
    return typeof message === 'string' && values.every(value => value?.error === true && value.message === message) ? message : null;
  } catch { return null; }
}

export function createCloud({ cwd = process.cwd(), env = process.env, binary = env.CLOUD_BIN || 'cloud', timeout = 10000, maxBytes = 5 * 1024 * 1024 } = {}) {
  const environment = childEnvironment(env);
  let fallback;
  let source = 'cloud-cli';

  function run(args, signal, token) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new AxiError('Read deadline reached.', 'READ_TIMEOUT'));
      const child = spawn(binary, args, { cwd: context(cwd).directory, env: { ...environment, ...(token ? { LARAVEL_CLOUD_TOKEN: token } : {}) }, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      const output = { stdout: [], stderr: [] };
      let bytes = 0;
      let failure;
      function kill() {
        try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { /* The process can exit before cleanup. */ }
      }
      function stop(error) { failure ??= error; kill(); }
      const abort = () => stop(new AxiError('Read deadline reached. No operation was retried.', 'READ_TIMEOUT'));
      const timer = setTimeout(abort, timeout);
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.on('error', () => {});
      child.stdin.end();
      for (const channel of ['stdout', 'stderr']) child[channel].on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) stop(new AxiError('Read output exceeds 5 MiB. Request a smaller resource.', 'RESPONSE_TOO_LARGE'));
        else output[channel].push(chunk);
      });
      child.on('error', error => {
        failure = new AxiError(error.code === 'ENOENT' ? 'Cloud executable not found.' : 'Could not start the Cloud executable.', 'DEPENDENCY_ERROR', ['Install the official CLI and run `laravel-cloud-axi auth`. CLOUD_BIN can select its executable path.']);
      });
      child.on('close', code => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        kill();
        if (failure) reject(failure);
        else resolve({ code, stdout: Buffer.concat(output.stdout).toString('utf8').trim(), stderr: Buffer.concat(output.stderr).toString('utf8').trim() });
      });
    });
  }

  async function json(args, { signal } = {}) {
    if (!READ_COMMANDS.has(args[0])) throw new AxiError('This native command is not supported.', 'UNSUPPORTED');
    const argv = [...args, '--json', '--no-interaction', '--no-ansi'];
    let result = await run(argv, signal, fallback);
    const message = nativeError(result.stderr);
    if (!fallback && !result.stdout && NO_LOGIN.has(message)) {
      source = env.LARAVEL_CLOUD_API_TOKEN ? 'environment' : 'dotenv';
      fallback = env.LARAVEL_CLOUD_API_TOKEN;
      if (!fallback) {
        try { fallback = parseEnv(readFileSync(join(context(cwd).directory, '.env'), 'utf8')).LARAVEL_CLOUD_API_TOKEN; } catch (error) {
          if (error.code !== 'ENOENT') throw new AxiError('Cannot read or parse project .env fallback.', 'AUTH_CONFIG_ERROR', [AUTH_HELP]);
        }
      }
      if (!fallback) throw new AxiError('No saved login or API-token fallback.', 'AUTH_REQUIRED', [AUTH_HELP]);
      if (typeof fallback !== 'string' || fallback.length > 4096 || /[^\x21-\x7e]/.test(fallback)) throw new AxiError('Invalid API-token fallback.', 'AUTH_INVALID', [AUTH_HELP]);
      const version = await run(['--version'], signal);
      if (version.code !== 0 || version.stderr || !/^Cloud v?0\.(?:[6-9]|[1-9]\d+)\.\d+$/.test(version.stdout)) {
        throw new AxiError('No saved login. API-token fallback requires native Cloud v0.6.0 or later in the 0.x series.', 'FALLBACK_UNSUPPORTED', [AUTH_HELP, 'Upgrade the official CLI yourself, then run `laravel-cloud-axi auth`.']);
      }
      result = await run(argv, signal, fallback);
    }
    if (result.code !== 0 || result.stderr) {
      const message = nativeError(result.stderr) ?? '';
      if (message.startsWith('Multiple API tokens found.')) throw new AxiError('Select a project organization before reading Cloud resources.', 'AUTH_AMBIGUOUS', [
        'In a Git project, run `cloud repo:config` yourself to select the organization.',
        'Outside Git, set organization_id in .cloud/config.json for the intended organization.',
      ]);
      const auth = /authenticated|API token|API tokens|401|403/.test(message);
      throw new AxiError(auth ? 'Access check failed. Saved login or token permissions need attention.' : 'Native read failed. No operation was retried.', auth ? 'AUTH_REQUIRED' : 'NATIVE_ERROR', [auth ? AUTH_HELP : 'Check the exact ID with `laravel-cloud-axi app list` or run `laravel-cloud-axi --help`.']);
    }
    let value;
    try { value = JSON.parse(result.stdout); } catch {
      // Reads return one document. Do not treat progress JSON lines as a successful result.
      throw new AxiError('Expected one JSON document from the native read.', 'INVALID_RESPONSE', ['Check the official CLI version, then run `laravel-cloud-axi auth`.']);
    }
    if (!value || typeof value !== 'object' || value.error) throw new AxiError('Invalid native read result.', 'INVALID_RESPONSE');
    return clean(value, [env.LARAVEL_CLOUD_API_TOKEN, fallback]);
  }
  return { json, get source() { return source; } };
}

export function resource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string') throw new AxiError('Expected a resource with an ID.', 'INVALID_RESPONSE');
  return value;
}

export function present(value, { full = false } = {}) {
  let truncated = false;
  function visit(item) {
    if (typeof item === 'string' && !full && item.length > 1000) {
      truncated = true;
      return `${item.slice(0, 1000)}... (truncated, ${item.length} chars total; use --full)`;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
    return item;
  }
  const output = visit(clean(value));
  if (truncated) output.help = [...(output.help ?? []), 'Repeat this command with --full to read complete text.'];
  return output;
}
