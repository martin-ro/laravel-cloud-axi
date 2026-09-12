import { runAxiCli, AxiError } from 'axi-sdk-js';
import { encode as renderOutput } from '@toon-format/toon';
import { AUTH_HELP, createClient, present } from './cloud.js';
import { COMMAND_NAMES, DESCRIPTION, GUIDANCE, execute } from './commands.js';

export async function main(argv, options = {}) {
  const runtime = { cwd: process.cwd(), ...options };
  runtime.client ??= createClient({ cwd: runtime.cwd, homeDir: runtime.homeDir });
  await runAxiCli({
    argv,
    version: options.version ?? '0.1.0',
    description: DESCRIPTION,
    stdout: options.stdout,
    topLevelHelp: `${renderOutput({
      description: DESCRIPTION,
      commands: {
        app: 'list | view <id>',
        environment: 'list --app <id> | view <id> | start <id> | stop <id>',
        deployment: 'list --env <id> | view <id> | logs <id> | wait <id>',
        deploy: '--env <id> (--dry-run | --confirm) [--wait]',
        command: 'list --env <id> | view <id> | wait <id> | run --env <id> --command "..." (--dry-run | --confirm) [--wait]',
        resources: 'instance | database (clusters) | cache | bucket | domain: list | view <id>',
        logs: '--env <id> [--since 1h] [--query "..."]',
        usage: '[--period 0..3] [--env <id>]',
        auth: '[status]: check access and source; use cloud auth for login',
        link: '--app <id> --env <id>: save read defaults for this project',
        setup: 'hooks [--status|--remove]: opt-in session context for supported agents',
        home: 'Show live project state, also the default with no arguments',
      },
      rules: [AUTH_HELP, 'IDs are exact, never guessed from names.', 'Read commands may use linked defaults. Mutations require explicit IDs and --confirm.', 'No automatic mutation retries. --full never reveals structured secrets.', 'Each command supports --help. Lists support --page and --all.'],
      examples: GUIDANCE.slice(0, 3),
    })}\n`,
    home: () => execute('home', [], runtime),
    commands: Object.assign(Object.create(null), Object.fromEntries(COMMAND_NAMES.map(command => [command, args => execute(command, [...args], runtime)]))),
    formatError: error => {
      const output = present({
        error: error instanceof AxiError ? error.message : 'Local operation failed. Check file permissions and project configuration.',
        code: error.code ?? 'LOCAL_ERROR',
        ...(error.httpStatus ? { http_status: error.httpStatus } : {}),
        ...(error.details ? { details: error.details } : {}),
        help: [...(error.result?.help ?? []), ...(error.suggestions ?? ['laravel-cloud-axi --help'])],
      });
      // Operation results are already redacted and respect the caller's --full flag.
      return {
        output: `${renderOutput({ ...output, ...error.result, help: output.help })}\n`,
        exitCode: error.code === 'USAGE_ERROR' ? 2 : 1,
      };
    },
  });
}
