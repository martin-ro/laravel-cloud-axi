import { AxiError } from 'axi-sdk-js';
import { parseEnv, stripVTControlCharacters } from 'node:util';
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { context } from './context.js';

export const API_URL = 'https://cloud.laravel.com/api/';
const MAX_BYTES = 5 * 1024 * 1024;
export const AUTH_HELP = 'Run `cloud auth` once with the official Laravel Cloud CLI. Fallback: LARAVEL_CLOUD_API_TOKEN in the environment, then the project .env.';
const ORGANIZATION_HELP = 'Run `cloud repo:config` in this project to select an organization. Use `cloud auth` to renew the official CLI login.';
const validToken = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[^\x21-\x7e]/.test(value);

function savedTokens(homeDir = process.env.HOME || process.env.USERPROFILE || userInfo().homedir) {
  let text;
  try { text = readFileSync(join(homeDir, '.config', 'cloud', 'config.json'), 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new AxiError('Cannot read the official Cloud CLI login file.', 'AUTH_CONFIG_ERROR', [AUTH_HELP]);
  }
  let config;
  try { config = JSON.parse(text); } catch {
    throw new AxiError('The official Cloud CLI login file is not valid JSON.', 'AUTH_CONFIG_ERROR', [AUTH_HELP]);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || !Array.isArray(config.api_tokens ?? []) || (config.api_tokens ?? []).some(value => !validToken(value))) {
    throw new AxiError('The official Cloud CLI login file has an invalid api_tokens list.', 'AUTH_CONFIG_ERROR', [AUTH_HELP]);
  }
  return [...new Set(config.api_tokens ?? [])];
}

function dotenvToken(directory) {
  let token;
  try { token = parseEnv(readFileSync(join(directory, '.env'), 'utf8')).LARAVEL_CLOUD_API_TOKEN; } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw new AxiError('Cannot read or parse the project .env file.', 'AUTH_CONFIG_ERROR', [AUTH_HELP]);
  }
  if (token && !validToken(token)) throw new AxiError('Invalid LARAVEL_CLOUD_API_TOKEN in the project .env file.', 'AUTH_INVALID', [AUTH_HELP]);
  return token;
}

export function clean(value, token = process.env.LARAVEL_CLOUD_API_TOKEN) {
  if (typeof value === 'string') {
    let text = stripVTControlCharacters(value);
    for (const secret of [token].flat().filter(Boolean).sort((a, b) => b.length - a.length)) {
      text = text.split(secret).join('[REDACTED]');
    }
    return text;
  }
  if (Array.isArray(value)) return value.map(item => clean(item, token));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [clean(key, token),
      /password|token|secret|credential|private_key|access_key|api[-_]?key|app_key|authorization|cookie|environment_variables|connection_url|database_url/i.test(key)
        ? '[REDACTED]' : clean(item, token),
    ]));
  }
  return value;
}

export function createClient({ token = process.env.LARAVEL_CLOUD_API_TOKEN, fetch: fetcher = globalThis.fetch, cwd = process.cwd(), homeDir } = {}) {
  let authentication;
  let secrets = [];
  let source = null;

  function endpoint(path) {
    const url = new URL(path, API_URL);
    if (url.origin !== new URL(API_URL).origin || !url.pathname.startsWith('/api/') || url.username || url.password || url.hash) {
      throw new AxiError('Refused an API URL outside Laravel Cloud.', 'UNSAFE_URL');
    }
    return url;
  }

  async function resolveToken(signal, ignoreProjectOrganization) {
    signal?.throwIfAborted();
    secrets = savedTokens(homeDir);
    source = 'cloud-cli';
    const current = context(cwd);
    if (!secrets.length) {
      source = token !== undefined && token !== '' ? 'environment' : 'dotenv';
      const fallback = source === 'environment' ? token : dotenvToken(current.directory);
      if (!fallback) throw new AxiError('No official Cloud CLI login or LARAVEL_CLOUD_API_TOKEN fallback found.', 'AUTH_REQUIRED', [AUTH_HELP]);
      if (!validToken(fallback)) throw new AxiError(`Invalid API token from ${source}.`, 'AUTH_INVALID', [AUTH_HELP]);
      secrets = [fallback];
    }
    const organization = current.data.organization_id;
    if (secrets.length === 1 && (organization === undefined || ignoreProjectOrganization)) return secrets[0];
    if (organization === undefined) throw new AxiError('Multiple saved Cloud tokens need a project organization.', 'AUTH_AMBIGUOUS', [ORGANIZATION_HELP]);
    if (typeof organization !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{1,199}$/.test(organization)) {
      throw new AxiError('Invalid organization_id in .cloud/config.json.', 'CONFIG_ERROR', [ORGANIZATION_HELP]);
    }
    const deadline = AbortSignal.timeout(10_000);
    const authSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    for (const credential of secrets) {
      try {
        const result = await send(endpoint('meta/organization'), credential, { signal: authSignal });
        if (resource(result.data).id === organization) return credential;
      } catch (error) {
        if (error.httpStatus !== 401) throw error;
      }
    }
    throw new AxiError('No valid configured token matches this project organization.', 'AUTH_ORGANIZATION', [ORGANIZATION_HELP]);
  }

  async function request(path, options = {}) {
    const url = endpoint(path);
    const credential = await (authentication ??= resolveToken(options.signal, options.ignoreProjectOrganization));
    return send(url, credential, options);
  }

  async function send(url, credential, { method = 'GET', body, signal } = {}) {
    let response;
    let text = '';
    try {
      response = await fetcher(url, {
        method,
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${credential}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      });
      const chunks = [];
      let bytes = 0;
      if (response.body) {
        for await (const chunk of response.body) {
          bytes += chunk.byteLength;
          if (bytes > MAX_BYTES) throw new AxiError('API response exceeds 5 MiB. Narrow the request.', 'RESPONSE_TOO_LARGE');
          chunks.push(chunk);
        }
      }
      text = Buffer.concat(chunks).toString('utf8');
    } catch (error) {
      if (error instanceof AxiError) throw error;
      throw new AxiError(
        method === 'GET' ? 'API request failed or timed out.' : 'Request outcome is unknown. The operation may have started. Do not repeat it before checking its status.',
        method === 'GET' ? 'NETWORK_ERROR' : 'OUTCOME_UNKNOWN',
        ['Run `laravel-cloud-axi auth` to check access.'],
      );
    }
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch {
      throw new AxiError(`API returned non-JSON data (HTTP ${response.status}).`, 'INVALID_RESPONSE');
    }
    if (!response.ok) {
      const codes = { 401: 'AUTH_REQUIRED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 422: 'VALIDATION_ERROR', 429: 'RATE_LIMITED' };
      const message = typeof payload?.message === 'string' ? clean(payload.message, secrets).slice(0, 1000) : `API request failed (HTTP ${response.status}).`;
      const hints = response.status === 401 ? [AUTH_HELP]
        : response.status === 403 ? ['Check the API token permissions for this resource.']
          : response.status === 429 ? [/^\d+$/.test(response.headers.get('retry-after') ?? '') ? `Wait ${response.headers.get('retry-after')} seconds before the next request.` : 'Wait for the API rate limit to reset before retrying.']
            : ['Check the resource ID and run `laravel-cloud-axi --help`.'];
      const error = new AxiError(message, codes[response.status] || 'API_ERROR', hints);
      error.httpStatus = response.status;
      error.details = clean(payload?.errors, secrets);
      throw error;
    }
    if (payload === null || typeof payload !== 'object') throw new AxiError('Invalid API response.', 'INVALID_RESPONSE');
    return clean(payload, secrets);
  }

  async function list(path, { all = false } = {}) {
    const items = [];
    const visited = new Set();
    const first = new URL(path, API_URL);
    let next = first.href;
    let result;
    do {
      const url = new URL(next, first);
      if (url.origin !== first.origin || url.pathname !== first.pathname || url.username || url.password || url.hash) {
        throw new AxiError('Refused an unsafe pagination link.', 'UNSAFE_URL');
      }
      if (visited.has(url.href) || visited.size >= 100) {
        throw new AxiError('Pagination repeated or exceeded 100 pages. Use --page to read a smaller range.', 'PAGINATION_ERROR');
      }
      visited.add(url.href);
      result = await request(url.href);
      if (!Array.isArray(result.data)) throw new AxiError('Expected an API collection.', 'INVALID_RESPONSE');
      items.push(...result.data.map(resource));
      next = result.links?.next ?? null;
      if (next !== null && typeof next !== 'string') throw new AxiError('Invalid pagination link.', 'INVALID_RESPONSE');
    } while (all && next);
    return {
      items,
      total: Number.isInteger(result.meta?.total) ? result.meta.total : (next ? null : items.length),
      page: result.meta?.current_page ?? 1,
      has_more: Boolean(next),
    };
  }
  return { request, list, get authInfo() { return { source }; } };
}

export function resource(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.id !== 'string') {
    throw new AxiError('Expected a JSON:API resource with an ID.', 'INVALID_RESPONSE');
  }
  const value = { ...data.attributes, id: data.id };
  for (const [key, relation] of Object.entries(data.relationships ?? {})) {
    const name = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
    if (Array.isArray(relation.data)) {
      value[`${name}_ids`] = relation.data.map(item => item.id);
      value[`${name}_count`] = relation.data.length;
    } else if (Object.hasOwn(relation, 'data')) {
      value[`${name}_id`] = relation.data?.id ?? null;
    }
  }
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
