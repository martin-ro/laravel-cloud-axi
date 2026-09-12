import { AxiError } from 'axi-sdk-js';
import { stripVTControlCharacters } from 'node:util';

export const API_URL = 'https://cloud.laravel.com/api/';
const MAX_BYTES = 5 * 1024 * 1024;
const AUTH_HELP = 'Set LARAVEL_CLOUD_TOKEN to a scoped API token, then run `laravel-cloud-axi auth`.';

export function clean(value, token = process.env.LARAVEL_CLOUD_TOKEN) {
  if (typeof value === 'string') {
    const text = stripVTControlCharacters(value);
    return token ? text.split(token).join('[REDACTED]') : text;
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

export function createClient({ token = process.env.LARAVEL_CLOUD_TOKEN, fetch: fetcher = globalThis.fetch } = {}) {
  async function request(path, { method = 'GET', body, signal } = {}) {
    if (!token?.trim()) throw new AxiError('No API token configured.', 'AUTH_REQUIRED', [AUTH_HELP]);
    if (token !== token.trim() || /[\r\n]/.test(token)) throw new AxiError('API token contains whitespace. Check LARAVEL_CLOUD_TOKEN.', 'AUTH_INVALID', [AUTH_HELP]);
    const url = new URL(path, API_URL);
    if (url.origin !== new URL(API_URL).origin || !url.pathname.startsWith('/api/') || url.username || url.password || url.hash) {
      throw new AxiError('Refused an API URL outside Laravel Cloud.', 'UNSAFE_URL');
    }
    let response;
    let text = '';
    try {
      response = await fetcher(url, {
        method,
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${token}`,
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
      const message = typeof payload?.message === 'string' ? clean(payload.message, token).slice(0, 1000) : `API request failed (HTTP ${response.status}).`;
      const hints = response.status === 401 ? [AUTH_HELP]
        : response.status === 403 ? ['Check the API token permissions for this resource.']
          : response.status === 429 ? [/^\d+$/.test(response.headers.get('retry-after') ?? '') ? `Wait ${response.headers.get('retry-after')} seconds before the next request.` : 'Wait for the API rate limit to reset before retrying.']
            : ['Check the resource ID and run `laravel-cloud-axi --help`.'];
      const error = new AxiError(clean(message, token), codes[response.status] || 'API_ERROR', hints);
      error.httpStatus = response.status;
      error.details = clean(payload?.errors, token);
      throw error;
    }
    if (payload === null || typeof payload !== 'object') throw new AxiError('Invalid API response.', 'INVALID_RESPONSE');
    return payload;
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
  return { request, list };
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
