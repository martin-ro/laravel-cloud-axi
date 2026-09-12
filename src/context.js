import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AxiError, installSessionStartHooks, sessionStartHookStatus, uninstallSessionStartHooks } from 'axi-sdk-js';

export function context(cwd = process.cwd()) {
  let directory = resolve(cwd);
  while (true) {
    const path = join(directory, '.cloud', 'config.json');
    if (existsSync(path)) {
      try {
        const data = JSON.parse(readFileSync(path, 'utf8'));
        if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error();
        return { directory, path, data };
      } catch {
        throw new AxiError(`Invalid project config: ${path}`, 'CONFIG_ERROR', ['Fix the JSON in .cloud/config.json.']);
      }
    }
    if (existsSync(join(directory, '.git'))) return { directory, path, data: {} };
    if (dirname(directory) === directory) {
      return { directory: resolve(cwd), path: join(resolve(cwd), '.cloud', 'config.json'), data: {} };
    }
    directory = dirname(directory);
  }
}

export function saveContext(current, app, env) {
  const data = { ...current.data, application_id: app, environment_id: env };
  if (current.data.application_id === app && current.data.environment_id === env) return false;
  mkdirSync(dirname(current.path), { recursive: true });
  const temporary = `${current.path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, current.path);
  } finally {
    rmSync(temporary, { force: true });
  }
  return true;
}

export function setupHooks(current, action, homeDir) {
  if (action === 'install' && (!current.data.application_id || !current.data.environment_id)) {
    throw new AxiError('Link this project before configuring its session hooks.', 'CONFIG_ERROR', [
      'Run `laravel-cloud-axi link --app <id> --env <id>`.',
    ]);
  }
  const execPath = fileURLToPath(new URL('../bin/laravel-cloud-axi.js', import.meta.url));
  // ponytail: the SDK does not quote fallback paths; reject unsafe paths until it does.
  if (action === 'install' && (!/^[A-Za-z0-9_./:-]+$/.test(execPath) || execPath.includes('/_npx/'))) {
    throw new AxiError('Hooks need a persistent install path without spaces or shell metacharacters.', 'SETUP_ERROR', ['Install this package in a safe, persistent path, then run `laravel-cloud-axi setup hooks`.']);
  }
  const failures = [];
  const options = {
    marker: 'laravel-cloud-axi',
    binaryNames: ['laravel-cloud-axi'],
    execPath,
    distEntrypoints: ['bin/laravel-cloud-axi.js'],
    scope: 'project',
    projectDir: current.directory,
    homeDir,
    onError: message => failures.push(message),
  };
  if (action === 'install') installSessionStartHooks(options);
  if (action === 'remove') uninstallSessionStartHooks(options);
  if (failures.length) throw new AxiError(failures.join('; '), 'SETUP_ERROR', ['Repair the agent configuration, then repeat the setup command.']);
  return { hooks: sessionStartHookStatus(options) };
}
